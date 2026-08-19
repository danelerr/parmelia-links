// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {AccountWebAuthnV2} from "../src/AccountWebAuthnV2.sol";
import {AccountFactoryV2} from "../src/AccountFactoryV2.sol";
import {ERC7913WebAuthnVerifier} from "../src/ERC7913WebAuthnVerifier.sol";
import {ParmeliaPaymaster} from "../src/ParmeliaPaymaster.sol";
import {ParmeliaPaymentRouter} from "../src/ParmeliaPaymentRouter.sol";
import {ParmeliaCrosschainRouter, ITokenMessengerV2} from "../src/ParmeliaCrosschainRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {DeploymentRoles} from "./DeploymentRoles.sol";

/**
 * @notice Deterministic (CREATE2) deployment of the GatoPago V2 contracts.
 *
 * Why CREATE2: deploying with a fixed salt through the standard CREATE2 deployer
 * (0x4e59b44847b379578588920cA78FbF26c0B4956C, present on Arbitrum and most EVM
 * chains) yields the SAME contract addresses on every chain - as long as the
 * bytecode is identical (same solc version + optimizer settings in foundry.toml).
 *
 * Because the verifier and implementation addresses are part of how each user's
 * wallet address is derived (CREATE2 salt = keccak256(initData), and initData
 * embeds the verifier address), deterministic infra addresses mean every user
 * keeps the SAME wallet address across chains. That makes chain migration trivial.
 *
 * The EntryPoint is the canonical ERC-4337 v0.9 (0x4337...09), identical on every
 * chain, so it is not deployed here - only referenced.
 */
contract DeployV2 is Script {
    // Canonical ERC-4337 EntryPoint v0.9 (same address on every chain).
    IEntryPoint internal constant ENTRY_POINT = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);

    // Fixed salt → deterministic, reproducible addresses across chains.
    bytes32 internal constant SALT = keccak256("parmelia.v2");

    function run() external {
        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address sponsorSigner =
            vm.envOr("GATOPAGO_PAYMASTER_SIGNER", vm.envOr("PARMELIA_PAYMASTER_SIGNER", deployer));
        DeploymentRoles.validatePaymaster(block.chainid, deployer, finalOwner, sponsorSigner);

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

        // 4. Configure the paymaster while the broadcaster is its temporary owner.
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster{salt: SALT}(ENTRY_POINT, deployer);
        if (sponsorSigner != deployer) paymaster.setSponsorSigner(sponsorSigner);
        console.log("ParmeliaPaymaster:       ", address(paymaster));
        console.log("Paymaster sponsor signer:", paymaster.sponsorSigner());

        // Stake + deposit so the paymaster can sponsor gas (native = ETH on Arbitrum).
        paymaster.addStake{value: 0.001 ether}(86400);
        paymaster.deposit{value: 0.01 ether}();
        // Per-op sponsored gas cap (defense in depth for a leaked sponsor key).
        // Generous for Arbitrum ops; tune per network conditions.
        paymaster.setMaxSponsoredGasCost(0.005 ether);
        if (finalOwner != deployer) paymaster.transferOwnership(finalOwner);

        vm.stopBroadcast();

        console.log("\n=== GatoPago V2 Deployment Summary ===");
        console.log("EntryPoint (v0.9):       ", address(ENTRY_POINT));
        console.log("\nFill these into shared/networks.ts -> NETWORKS[chain].contracts:");
        console.log("  verifier: ", address(verifier));
        console.log("  factory:  ", address(factory));
        console.log("  paymaster:", address(paymaster));
        console.log("Paymaster current owner: ", paymaster.owner());
        console.log("Paymaster pending owner: ", paymaster.pendingOwner());
        if (finalOwner != deployer) console.log("ACTION REQUIRED: final owner must call acceptOwnership().");
    }
}

/// @notice Standalone deterministic Paymaster deployment (re-deploy paymaster only).
contract DeployPaymasterV2 is Script {
    IEntryPoint internal constant ENTRY_POINT = IEntryPoint(0x433709009B8330FDa32311DF1C2AFA402eD8D009);
    bytes32 internal constant SALT = keccak256("parmelia.v2.paymaster");

    function run() external {
        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address sponsorSigner =
            vm.envOr("GATOPAGO_PAYMASTER_SIGNER", vm.envOr("PARMELIA_PAYMASTER_SIGNER", deployer));
        DeploymentRoles.validatePaymaster(block.chainid, deployer, finalOwner, sponsorSigner);

        vm.startBroadcast();

        ParmeliaPaymaster paymaster = new ParmeliaPaymaster{salt: SALT}(ENTRY_POINT, deployer);
        if (sponsorSigner != deployer) paymaster.setSponsorSigner(sponsorSigner);
        console.log("ParmeliaPaymaster:", address(paymaster));
        console.log("Sponsor signer:   ", paymaster.sponsorSigner());

        paymaster.addStake{value: 0.001 ether}(86400);
        paymaster.deposit{value: 0.01 ether}();
        paymaster.setMaxSponsoredGasCost(0.005 ether);
        if (finalOwner != deployer) paymaster.transferOwnership(finalOwner);

        vm.stopBroadcast();

        console.log("Current owner: ", paymaster.owner());
        console.log("Pending owner: ", paymaster.pendingOwner());
        if (finalOwner != deployer) console.log("ACTION REQUIRED: final owner must call acceptOwnership().");
    }
}

/// @notice Deterministic PaymentRouter deployment (Flow B: open payments to any wallet).
/// @dev Reads GATOPAGO_CONTRACT_OWNER, GATOPAGO_TREASURY and
///      GATOPAGO_PAYMENT_ROUTER_SIGNER. Legacy PARMELIA_* aliases remain accepted.
///      Testnet defaults to the deployer; Arbitrum
///      One requires all roles and the broadcaster to be distinct.
contract DeployPaymentRouter is Script {
    bytes32 internal constant SALT = keccak256("parmelia.v2.paymentRouter");

    function run() external {
        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address treasury = vm.envOr("GATOPAGO_TREASURY", vm.envOr("PARMELIA_TREASURY", deployer));
        address invoiceSigner = vm.envOr(
            "GATOPAGO_PAYMENT_ROUTER_SIGNER", vm.envOr("PARMELIA_PAYMENT_ROUTER_SIGNER", deployer)
        );
        DeploymentRoles.validatePaymentRouter(block.chainid, deployer, finalOwner, treasury, invoiceSigner);

        vm.startBroadcast();

        ParmeliaPaymentRouter router = new ParmeliaPaymentRouter{salt: SALT}(finalOwner, treasury, invoiceSigner);
        console.log("ParmeliaPaymentRouter:", address(router));
        console.log("  owner:   ", finalOwner);
        console.log("  treasury:", treasury);
        console.log("  signer:  ", invoiceSigner);
        console.log("Next: owner calls setTokenSupported(USDC, true, minAmount).");

        vm.stopBroadcast();
    }
}

/// @notice Deterministic CrosschainRouter deployment (Flow B outbound: USDC via CCTP v2).
/// @dev Reads USDC_ADDRESS, CCTP_TOKEN_MESSENGER, GATOPAGO_CONTRACT_OWNER and
///      GATOPAGO_TREASURY. Legacy PARMELIA_* aliases remain accepted. Testnet
///      defaults roles to the deployer; Arbitrum One
///      requires broadcaster, owner and treasury to be distinct.
contract DeployCrosschainRouter is Script {
    bytes32 internal constant SALT = keccak256("parmelia.v2.crosschainRouter");

    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address messenger = vm.envAddress("CCTP_TOKEN_MESSENGER");
        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address treasury = vm.envOr("GATOPAGO_TREASURY", vm.envOr("PARMELIA_TREASURY", deployer));
        DeploymentRoles.validateCrosschainRouter(block.chainid, deployer, finalOwner, treasury);

        vm.startBroadcast();

        ParmeliaCrosschainRouter router =
            new ParmeliaCrosschainRouter{salt: SALT}(finalOwner, IERC20(usdc), ITokenMessengerV2(messenger), treasury);
        console.log("ParmeliaCrosschainRouter:", address(router));
        console.log("  owner:", finalOwner);
        console.log("  treasury:", treasury);
        console.log("  USDC:", usdc);
        console.log("  TokenMessengerV2:", messenger);

        vm.stopBroadcast();
    }
}
