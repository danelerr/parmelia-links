// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPaymaster, IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/**
 * @title ParmeliaPaymaster
 * @notice Paymaster que sponsorea gas para las UserOperations de Parmelia Links.
 *         Solo el owner puede retirar fondos y el EntryPoint es el único que puede
 *         llamar a validatePaymasterUserOp y postOp.
 */
contract ParmeliaPaymaster is IPaymaster {
    IEntryPoint public immutable entryPoint;
    address public owner;

    error OnlyOwner();
    error OnlyEntryPoint();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    constructor(IEntryPoint _entryPoint) {
        entryPoint = _entryPoint;
        owner = msg.sender;
    }

    /// @notice Approves all UserOperations — the paymaster pays gas for everyone.
    function validatePaymasterUserOp(
        PackedUserOperation calldata,
        bytes32,
        uint256
    ) external onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        return ("", 0); // 0 = SIG_VALIDATION_SUCCESS
    }

    /// @notice No-op post operation hook.
    function postOp(PostOpMode, bytes calldata, uint256, uint256) external onlyEntryPoint {}

    // ========== Owner management ==========

    /// @notice Deposit ETH into the EntryPoint for this paymaster.
    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    /// @notice Stake at the EntryPoint (required for paymasters).
    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    /// @notice Withdraw deposit from the EntryPoint.
    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    /// @notice Check this paymaster's deposit at the EntryPoint.
    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    /// @notice Accept ETH directly (forwards to EntryPoint deposit).
    receive() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }
}
