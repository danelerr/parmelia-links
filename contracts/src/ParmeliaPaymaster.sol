// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPaymaster, IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title ParmeliaPaymaster
 * @notice Paymaster that sponsors gas for Parmelia Links UserOperations.
 *         Uses Ownable2Step for safe ownership transfer.
 *         Only the owner can withdraw funds; the EntryPoint is the only caller
 *         for validatePaymasterUserOp and postOp.
 */
contract ParmeliaPaymaster is IPaymaster, Ownable2Step {
    IEntryPoint public immutable ENTRY_POINT;
    address public sponsorSigner;

    uint256 private constant PAYMASTER_DATA_OFFSET = 52;

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

    function _sponsorDigest(PackedUserOperation calldata userOp) internal view returns (bytes32) {
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
            paymasterConfigHash
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

    /// @notice Approves only UserOperations explicitly signed by the trusted backend signer.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        bytes calldata paymasterSignature = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        if (paymasterSignature.length == 0) revert MissingPaymasterSignature();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(_sponsorDigest(userOp));
        address recoveredSigner = ECDSA.recover(digest, paymasterSignature);
        if (recoveredSigner != sponsorSigner) {
            revert InvalidPaymasterSignature();
        }

        return ("", 0); // 0 = SIG_VALIDATION_SUCCESS
    }

    /// @notice No-op post operation hook.
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
