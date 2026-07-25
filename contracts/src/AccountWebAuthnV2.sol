// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {MultiSignerERC7913} from "@openzeppelin/contracts/utils/cryptography/signers/MultiSignerERC7913.sol";

/**
 * @title AccountWebAuthnV2
 * @author Parmelia
 * @notice ERC-4337 smart account with multi-passkey support, guardian recovery, and UUPS upgradeability.
 *
 * @dev Architecture overview:
 *   - Uses MultiSignerERC7913 for dynamic signer management (add/remove passkeys).
 *   - Each passkey is an ERC-7913 signer: abi.encodePacked(verifierAddress, qx, qy).
 *   - The verifier is an ERC7913WebAuthnVerifier deployed once per chain.
 *   - Threshold-based: defaults to 1-of-N for single-user wallets.
 *   - Guardian recovery: a trusted address can propose new signers with a 48h timelock.
 *   - UUPS upgradeable: allows adding features (Uniswap, yield) without changing wallet addresses.
 *
 * Key improvements over V1:
 *   1. Multiple passkeys - primary + backup passkeys from different devices/ecosystems.
 *   2. Passkey rotation - add new passkey, remove old one, same wallet address.
 *   3. Domain-agnostic - on-chain validation uses qx/qy, not the WebAuthn RP ID.
 *   4. Guardian recovery - 48h timelock protects against malicious guardian actions.
 *   5. Upgradeable - UUPS proxy pattern for future feature additions.
 */
contract AccountWebAuthnV2 is
    Initializable,
    Account,
    EIP712,
    ERC7739,
    ERC7821,
    MultiSignerERC7913,
    UUPSUpgradeable,
    ERC721Holder,
    ERC1155Holder
{
    // ========== Recovery State ==========

    /// @notice Address that can propose recovery (set by the account owner).
    address public guardian;

    /// @notice Timestamp after which the pending recovery can be executed.
    uint256 public recoveryExecutableAfter;

    /// @notice Pending new signers for recovery.
    bytes[] private _pendingSigners;

    /// @notice Pending new threshold for recovery.
    uint64 private _pendingThreshold;

    /// @notice Recovery timelock duration (48 hours).
    uint256 public constant RECOVERY_DELAY = 48 hours;

    // ========== Events ==========

    event GuardianSet(address indexed oldGuardian, address indexed newGuardian);
    event RecoveryProposed(address indexed guardian, uint256 executeAfter);
    event RecoveryCancelled(address indexed cancelledBy);
    event RecoveryExecuted(address indexed executor);

    // ========== Errors ==========

    error OnlyGuardian();
    error NoGuardianSet();
    error RecoveryNotProposed();
    error RecoveryNotReady();
    error RecoveryAlreadyProposed();
    error InvalidRecoveryProposal();

    // ========== Constructor (implementation contract) ==========

    /// @dev The constructor is for the implementation contract only.
    ///      Proxies use `initialize()` instead and have separate storage.
    ///      We must pass a valid signer + threshold to MultiSignerERC7913's constructor
    ///      because the library requires threshold > 0 and signer count >= threshold.
    ///      The implementation's state is irrelevant - proxies get fresh storage via initialize().
    constructor() EIP712("AccountWebAuthnV2", "2") MultiSignerERC7913(_dummySigners(), 1) {
        _disableInitializers();
    }

    /// @dev Returns a single dummy signer (20 bytes) for the constructor.
    ///      This is needed because MultiSignerERC7913 requires at least one signer
    ///      when threshold > 0. The value is stored in the implementation's storage
    ///      but never used by proxies.
    function _dummySigners() private pure returns (bytes[] memory signers) {
        signers = new bytes[](1);
        signers[0] = abi.encodePacked(address(1));
    }

    // ========== Initialization ==========

    /**
     * @notice Initialize the account with signers, threshold, and optional guardian.
     * @param signers_ Initial signers (each is abi.encodePacked(verifier, qx, qy)).
     * @param threshold_ Minimum signatures required (typically 1 for single-user).
     * @param guardian_ Address that can propose recovery (address(0) to disable).
     */
    function initialize(bytes[] memory signers_, uint64 threshold_, address guardian_) public initializer {
        _addSigners(signers_);
        _setThreshold(threshold_);
        if (guardian_ != address(0)) {
            guardian = guardian_;
            emit GuardianSet(address(0), guardian_);
        }
    }

    // ========== Signer Management (only via UserOp or self-call) ==========

    /**
     * @notice Add new signers (passkeys) to this account.
     * @dev Only callable by EntryPoint (via UserOp) or by the account itself.
     */
    function addSigners(bytes[] memory signers_) public onlyEntryPointOrSelf {
        _addSigners(signers_);
    }

    /**
     * @notice Remove signers (passkeys) from this account.
     * @dev Only callable by EntryPoint (via UserOp) or by the account itself.
     */
    function removeSigners(bytes[] memory signers_) public onlyEntryPointOrSelf {
        _removeSigners(signers_);
    }

    /**
     * @notice Update the signature threshold.
     * @dev Only callable by EntryPoint (via UserOp) or by the account itself.
     */
    function setThreshold(uint64 threshold_) public onlyEntryPointOrSelf {
        _setThreshold(threshold_);
    }

    // ========== Guardian Management ==========

    /**
     * @notice Set or change the recovery guardian.
     * @dev Only callable by EntryPoint (via UserOp) or by the account itself.
     *      Any pending recovery is cancelled: it was proposed under the OLD
     *      guardian's authority and must not survive rotating or removing it.
     * @param newGuardian The new guardian address (address(0) to remove guardian).
     */
    function setGuardian(address newGuardian) public onlyEntryPointOrSelf {
        address old = guardian;
        guardian = newGuardian;
        if (recoveryExecutableAfter != 0) {
            _clearRecovery();
            emit RecoveryCancelled(msg.sender);
        }
        emit GuardianSet(old, newGuardian);
    }

    // ========== Recovery Flow ==========

    /// @dev Recovery proposals are bounded so executeRecovery stays executable.
    uint256 private constant MAX_RECOVERY_SIGNERS = 32;

    /**
     * @notice Propose a recovery operation. Only the guardian can call this.
     * @dev Starts a 48-hour timelock. The current signer(s) can cancel within this window.
     *      The proposal is validated up-front: without this, a malformed proposal
     *      (empty signers, threshold 0 or > count, duplicates) would only surface
     *      as a revert inside executeRecovery — 48 hours later, for a user who by
     *      definition lost their passkey and cannot cancel, permanently bricking
     *      recovery for that account.
     * @param newSigners The new signers to set after the timelock.
     * @param newThreshold The new threshold to set after the timelock.
     */
    function proposeRecovery(bytes[] memory newSigners, uint64 newThreshold) external {
        if (guardian == address(0)) revert NoGuardianSet();
        if (msg.sender != guardian) revert OnlyGuardian();
        if (recoveryExecutableAfter != 0) revert RecoveryAlreadyProposed();

        uint256 count = newSigners.length;
        if (count == 0 || count > MAX_RECOVERY_SIGNERS) revert InvalidRecoveryProposal();
        if (newThreshold == 0 || newThreshold > count) revert InvalidRecoveryProposal();
        for (uint256 i = 0; i < count; i++) {
            // ERC-7913 signer bytes are at least a 20-byte verifier/EOA address.
            if (newSigners[i].length < 20) revert InvalidRecoveryProposal();
            for (uint256 j = i + 1; j < count; j++) {
                if (keccak256(newSigners[i]) == keccak256(newSigners[j])) revert InvalidRecoveryProposal();
            }
        }

        recoveryExecutableAfter = block.timestamp + RECOVERY_DELAY;
        _pendingSigners = newSigners;
        _pendingThreshold = newThreshold;

        emit RecoveryProposed(msg.sender, recoveryExecutableAfter);
    }

    /**
     * @notice Cancel a pending recovery. Only the account owner (via UserOp/self) can cancel.
     * @dev This allows the legitimate owner to prevent a malicious recovery attempt.
     */
    function cancelRecovery() public onlyEntryPointOrSelf {
        if (recoveryExecutableAfter == 0) revert RecoveryNotProposed();
        _clearRecovery();
        emit RecoveryCancelled(msg.sender);
    }

    /**
     * @notice Cancel a pending recovery as the guardian (e.g. a wrong proposal).
     * @dev Grants no extra power: the guardian can only clear its OWN pending
     *      proposal and re-propose, which restarts the full 48h timelock. Without
     *      this, a semantically-bad proposal (e.g. a signer that already exists,
     *      which executeRecovery's _addSigners rejects) could only be cancelled
     *      by the owner — the exact passkey the recovery exists to replace.
     */
    function guardianCancelRecovery() external {
        if (msg.sender != guardian) revert OnlyGuardian();
        if (recoveryExecutableAfter == 0) revert RecoveryNotProposed();
        _clearRecovery();
        emit RecoveryCancelled(msg.sender);
    }

    /// @dev Reset all pending-recovery state.
    function _clearRecovery() private {
        recoveryExecutableAfter = 0;
        delete _pendingSigners;
        _pendingThreshold = 0;
    }

    /**
     * @notice Execute a pending recovery after the timelock has passed.
     * @dev Anyone can call this after the timelock expires (the guardian, the new signer, etc).
     *      The function replaces ALL current signers with the pending ones.
     */
    function executeRecovery() external {
        if (recoveryExecutableAfter == 0) revert RecoveryNotProposed();
        if (block.timestamp < recoveryExecutableAfter) revert RecoveryNotReady();

        // Snapshot current signers before modification
        uint256 count = getSignerCount();
        bytes[] memory oldSigners;
        if (count > 0) {
            oldSigners = getSigners(0, type(uint64).max);
        } else {
            oldSigners = new bytes[](0);
        }

        // IMPORTANT: Add new signers FIRST, then set threshold, then remove old ones.
        // This avoids MultiSignerERC7913's _validateReachableThreshold check failing
        // when signer count temporarily drops below threshold during the transition.
        _addSigners(_pendingSigners);
        _setThreshold(_pendingThreshold);

        if (oldSigners.length > 0) {
            _removeSigners(oldSigners);
        }

        _clearRecovery();

        emit RecoveryExecuted(msg.sender);
    }

    // ========== View helpers ==========

    /**
     * @notice Check if a recovery is currently pending.
     */
    function isRecoveryPending() public view returns (bool) {
        return recoveryExecutableAfter != 0;
    }

    /**
     * @notice Get the pending recovery details.
     * @return executeAfter Timestamp after which recovery can execute (0 if none).
     * @return newSigners The proposed new signers.
     * @return newThreshold The proposed new threshold.
     */
    function getPendingRecovery()
        public
        view
        returns (uint256 executeAfter, bytes[] memory newSigners, uint64 newThreshold)
    {
        return (recoveryExecutableAfter, _pendingSigners, _pendingThreshold);
    }

    // ========== UUPS Upgrade Authorization ==========

    /**
     * @dev Only the account itself (via UserOp) can authorize upgrades.
     *      This ensures that only a valid signer can upgrade the implementation.
     */
    function _authorizeUpgrade(address) internal override onlyEntryPointOrSelf {}

    // ========== ERC7821 Executor Authorization ==========

    /**
     * @dev Allow the EntryPoint to execute batched calls via ERC-7821.
     */
    function _erc7821AuthorizedExecutor(address caller, bytes32 mode, bytes calldata executionData)
        internal
        view
        override
        returns (bool)
    {
        return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
    }
}
