// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {AccountWebAuthnV2} from "../src/AccountWebAuthnV2.sol";
import {AccountFactoryV2} from "../src/AccountFactoryV2.sol";
import {ERC7913WebAuthnVerifier} from "../src/ERC7913WebAuthnVerifier.sol";
import {ParmeliaPaymaster} from "../src/ParmeliaPaymaster.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/**
 * @notice Deterministic (CREATE2) deployment of the Parmelia V2 contracts.
 *
 * Why CREATE2: deploying with a fixed salt through the standard CREATE2 deployer
 * (0x4e59b44847b379578588920cA78FbF26c0B4956C, present on Arbitrum and most EVM
 * chains) yields the SAME contract addresses on every chain — as long as the
 * bytecode is identical (same solc version + optimizer settings in foundry.toml).
 *
 * Because the verifier and implementation addresses are part of how each user's
 * wallet address is derived (CREATE2 salt = keccak256(initData), and initData
 * embeds the verifier address), deterministic infra addresses mean every user
 * keeps the SAME wallet address across chains. That makes chain migration trivial.
 *
 * The EntryPoint is the canonical ERC-4337 v0.9 (0x4337...09), identical on every
 * chain, so it is not deployed here — only referenced.
 */
contract DeployV2 is Script {
    // Canonical ERC-4337 EntryPoint v0.9 (same address on every chain).
    IEntryPoint internal constant ENTRY_POINT =
        IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);

    // Fixed salt → deterministic, reproducible addresses across chains.
    bytes32 internal constant SALT = keccak256("parmelia.v2");

    function run() external {
        vm.startBroadcast();

        // 1. WebAuthn verifier (stateless, one per chain)
        ERC7913WebAuthnVerifier verifier = new ERC7913WebAuthnVerifier{salt: SALT}();
        console.log("ERC7913WebAuthnVerifier:", address(verifier));

        // 2. AccountWebAuthnV2 implementation (logic contract)
        AccountWebAuthnV2 accountImpl = new AccountWebAuthnV2{salt: SALT}();
        console.log("AccountWebAuthnV2 impl:  ", address(accountImpl));

        // 3. Factory (deterministic because the impl address is deterministic)
        AccountFactoryV2 factory = new AccountFactoryV2{salt: SALT}(address(accountImpl));
        console.log("AccountFactoryV2:        ", address(factory));

        // 4. Paymaster
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster{salt: SALT}(ENTRY_POINT);
        console.log("ParmeliaPaymaster:       ", address(paymaster));
        console.log("Paymaster sponsor signer:", paymaster.sponsorSigner());

        // Stake + deposit so the paymaster can sponsor gas (native = ETH on Arbitrum).
        paymaster.addStake{value: 0.001 ether}(86400);
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();

        console.log("\n=== Parmelia V2 Deployment Summary ===");
        console.log("EntryPoint (v0.9):       ", address(ENTRY_POINT));
        console.log("\nFill these into shared/networks.ts -> NETWORKS[chain].contracts:");
        console.log("  verifier: ", address(verifier));
        console.log("  factory:  ", address(factory));
        console.log("  paymaster:", address(paymaster));
    }
}

/// @notice Standalone deterministic Paymaster deployment (re-deploy paymaster only).
contract DeployPaymasterV2 is Script {
    IEntryPoint internal constant ENTRY_POINT =
        IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
    bytes32 internal constant SALT = keccak256("parmelia.v2.paymaster");

    function run() external {
        vm.startBroadcast();

        ParmeliaPaymaster paymaster = new ParmeliaPaymaster{salt: SALT}(ENTRY_POINT);
        console.log("ParmeliaPaymaster:", address(paymaster));
        console.log("Sponsor signer:   ", paymaster.sponsorSigner());

        paymaster.addStake{value: 0.001 ether}(86400);
        paymaster.deposit{value: 0.01 ether}();

        vm.stopBroadcast();
    }
}
