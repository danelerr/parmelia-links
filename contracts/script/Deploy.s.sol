// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {AccountWebAuthnV2} from "../src/AccountWebAuthnV2.sol";
import {AccountFactoryV2} from "../src/AccountFactoryV2.sol";
import {ERC7913WebAuthnVerifier} from "../src/ERC7913WebAuthnVerifier.sol";
import {ParmeliaPaymaster} from "../src/ParmeliaPaymaster.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/// @notice Full deployment of Parmelia V2 contracts for Monad (or any EVM chain).
contract DeployV2 is Script {
    function run() external {
        vm.startBroadcast();

        // 1. Deploy the WebAuthn verifier (stateless, one per chain)
        ERC7913WebAuthnVerifier verifier = new ERC7913WebAuthnVerifier();
        console.log("ERC7913WebAuthnVerifier deployed at:", address(verifier));

        // 2. Deploy the AccountWebAuthnV2 implementation (logic contract)
        AccountWebAuthnV2 accountImpl = new AccountWebAuthnV2();
        console.log("AccountWebAuthnV2 implementation deployed at:", address(accountImpl));

        // 3. Deploy the Factory pointing to the implementation
        AccountFactoryV2 factory = new AccountFactoryV2(address(accountImpl));
        console.log("AccountFactoryV2 deployed at:", address(factory));

        // 4. Deploy the Paymaster
        //    Replace this address with the correct EntryPoint on the target chain.
        IEntryPoint entryPoint = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster(entryPoint);
        console.log("ParmeliaPaymaster deployed at:", address(paymaster));
        console.log("Initial paymaster sponsor signer:", paymaster.sponsorSigner());

        // Stake paymaster at EntryPoint — 0.001 native token, 1 day unstake delay
        paymaster.addStake{value: 0.001 ether}(86400);

        // Deposit native token into EntryPoint for gas coverage — 0.01 native token
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();

        // Log summary
        console.log("\n=== Parmelia V2 Deployment Summary ===");
        console.log("Verifier:       ", address(verifier));
        console.log("Implementation: ", address(accountImpl));
        console.log("Factory:        ", address(factory));
        console.log("Paymaster:      ", address(paymaster));
        console.log("EntryPoint:     ", address(entryPoint));
        console.log("\nUpdate shared/index.ts with these addresses.");
    }
}

/// @notice Standalone Paymaster deployment (for re-deploying paymaster only).
contract DeployPaymasterV2 is Script {
    function run() external {
        vm.startBroadcast();

        IEntryPoint entryPoint = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster(entryPoint);
        console.log("ParmeliaPaymaster deployed at:", address(paymaster));
        console.log("Initial paymaster sponsor signer:", paymaster.sponsorSigner());

        paymaster.addStake{value: 0.001 ether}(86400);
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();
    }
}
