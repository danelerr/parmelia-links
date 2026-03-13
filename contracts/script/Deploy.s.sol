// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Script.sol";
import "../src/AccountWebAuthn.sol";
import "../src/AccountFactory.sol";
import "../src/ParmeliaPaymaster.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        // Deploy AccountWebAuthn implementation
        AccountWebAuthn accountImpl = new AccountWebAuthn();
        console.log("AccountWebAuthn implementation deployed at:", address(accountImpl));

        // Deploy AccountFactory with the implementation address
        AccountFactory accountFactory = new AccountFactory(address(accountImpl));
        console.log("AccountFactory deployed at:", address(accountFactory));

        // Deploy ParmeliaPaymaster pointing to EntryPoint v0.9
        IEntryPoint entryPoint = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster(entryPoint);
        console.log("ParmeliaPaymaster deployed at:", address(paymaster));

        // Stake paymaster at EntryPoint (required) — 0.001 ETH, 1 day unstake delay
        paymaster.addStake{value: 0.001 ether}(86400);

        // Deposit ETH into EntryPoint for the paymaster to cover gas — 0.01 ETH
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();
    }
}

contract DeployPaymaster is Script {
    function run() external {
        vm.startBroadcast();

        IEntryPoint entryPoint = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster(entryPoint);
        console.log("ParmeliaPaymaster deployed at:", address(paymaster));

        // Stake paymaster at EntryPoint (required) — 0.001 ETH, 1 day unstake delay
        paymaster.addStake{value: 0.001 ether}(86400);

        // Deposit ETH into EntryPoint for the paymaster to cover gas — 0.01 ETH
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();
    }
}