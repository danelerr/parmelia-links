// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPaymaster, IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title ParmeliaPaymaster
 * @notice Verifying paymaster that sponsors gas for Parmelia Links UserOperations.
 *         A trusted backend signer authorizes each op; the signature is bound to a
 *         [validAfter, validUntil] window so a signed-but-unsubmitted op cannot be
 *         replayed indefinitely (it expires with the backend's pending TTL).
 *         Uses Ownable2Step for safe ownership transfer.
 *
 *         paymasterAndData layout (after the 20-byte paymaster address):
 *           [20:36] paymasterVerificationGasLimit (uint128)
 *           [36:52] paymasterPostOpGasLimit       (uint128)
 *           [52:58] validAfter                    (uint48)
 *           [58:64] validUntil                    (uint48)
 *           [64:]   sponsor signature             (65 bytes, ECDSA)
 */
contract ParmeliaPaymaster is IPaymaster, Ownable2Step {
    IEntryPoint public immutable ENTRY_POINT;
    address public sponsorSigner;

    // ERC-4337 mandated header is 52 bytes (20 addr + 16 + 16).
    uint256 private constant PAYMASTER_DATA_OFFSET = 52;
    // Signed validity window: validAfter (6) + validUntil (6).
    uint256 private constant SIGNATURE_OFFSET = PAYMASTER_DATA_OFFSET + 12; // 64

    error OnlyEntryPoint();
    error InvalidPaymasterSignature();
    error MissingPaymasterSignature();

    modifier onlyEntryPoint() {
        _checkEntryPoint();
        _;
    }

    function _checkEntryPoint() private view {
        if (msg.sender != address(ENTRY_POINT)) revert OnlyEntryPoint();
    }

    constructor(IEntryPoint _entryPoint) Ownable(msg.sender) {
        ENTRY_POINT = _entryPoint;
        sponsorSigner = msg.sender;
    }

    /// @notice Update the EOA that authorizes sponsored UserOperations.
    function setSponsorSigner(address newSponsorSigner) external onlyOwner {
        require(newSponsorSigner != address(0), "invalid signer");
        sponsorSigner = newSponsorSigner;
    }

    /// @dev Digest the backend signs. Binds the op AND the validity window so neither
    ///      the op fields nor the time bounds can be tampered with after signing.
    function _sponsorDigest(PackedUserOperation calldata userOp, uint48 validAfter, uint48 validUntil)
        internal
        view
        returns (bytes32)
    {
        bytes calldata paymasterAndData = userOp.paymasterAndData;
        bytes32 paymasterConfigHash = _calldataKeccak256(paymasterAndData[:PAYMASTER_DATA_OFFSET]);

        bytes memory encoded = abi.encode(
            block.chainid,
            address(this),
            userOp.sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            userOp.preVerificationGas,
            userOp.gasFees,
            paymasterConfigHash,
            uint256(validAfter),
            uint256(validUntil)
        );
        return _memoryBytesKeccak256(encoded);
    }

    function _calldataKeccak256(bytes calldata data) private pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, data.offset, data.length)
            digest := keccak256(ptr, data.length)
        }
    }

    function _memoryBytesKeccak256(bytes memory data) private pure returns (bytes32 digest) {
        assembly ("memory-safe") {
            digest := keccak256(add(data, 0x20), mload(data))
        }
    }

    /// @notice Approves only UserOperations explicitly signed by the trusted backend
    ///         signer, within the signed [validAfter, validUntil] window enforced by
    ///         the EntryPoint via the returned validationData.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        bytes calldata paymasterAndData = userOp.paymasterAndData;
        if (paymasterAndData.length <= SIGNATURE_OFFSET) revert MissingPaymasterSignature();

        uint48 validAfter = uint48(bytes6(paymasterAndData[PAYMASTER_DATA_OFFSET:PAYMASTER_DATA_OFFSET + 6]));
        uint48 validUntil = uint48(bytes6(paymasterAndData[PAYMASTER_DATA_OFFSET + 6:SIGNATURE_OFFSET]));
        bytes calldata paymasterSignature = paymasterAndData[SIGNATURE_OFFSET:];

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(_sponsorDigest(userOp, validAfter, validUntil));
        if (ECDSA.recover(digest, paymasterSignature) != sponsorSigner) {
            revert InvalidPaymasterSignature();
        }

        // authorizer = 0 (success); EntryPoint enforces the [validAfter, validUntil] window.
        return ("", ERC4337Utils.packValidationData(true, validAfter, validUntil));
    }

    /// @notice Post-operation hook. Currently a no-op (gas is fully sponsored).
    /// @dev Fee-model integration point: to charge users later (e.g. deduct a USDC
    ///      fee), implement the charge here using the `context` returned above and the
    ///      `actualGasCost`. Keep gas in mind — postOpGasLimit must cover the logic.
    function postOp(PostOpMode, bytes calldata, uint256, uint256) external onlyEntryPoint {}

    // ========== Owner management ==========

    /// @notice Deposit native token into the EntryPoint for this paymaster.
    function deposit() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    /// @notice Stake at the EntryPoint (required for paymasters).
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        ENTRY_POINT.addStake{value: msg.value}(unstakeDelaySec);
    }

    /// @notice Withdraw deposit from the EntryPoint.
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        ENTRY_POINT.withdrawTo(to, amount);
    }

    /// @notice Check this paymaster's deposit at the EntryPoint.
    function getDeposit() external view returns (uint256) {
        return ENTRY_POINT.balanceOf(address(this));
    }

    /// @notice Accept the native token directly (forwards to EntryPoint deposit).
    receive() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }
}
