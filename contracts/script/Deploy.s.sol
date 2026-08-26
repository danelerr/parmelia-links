// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AccountFactoryV2} from "src/AccountFactoryV2.sol";
import {AccountWebAuthnV2} from "src/AccountWebAuthnV2.sol";
import {ERC7913WebAuthnVerifier} from "src/ERC7913WebAuthnVerifier.sol";
import {ParmeliaCctpPaymentRouter} from "src/ParmeliaCctpPaymentRouter.sol";
import {ParmeliaCrosschainRouter} from "src/ParmeliaCrosschainRouter.sol";
import {ParmeliaPaymentRouterV2} from "src/ParmeliaPaymentRouterV2.sol";
import {ParmeliaPaymaster} from "src/ParmeliaPaymaster.sol";
import {ITokenMessengerV2} from "src/interfaces/ITokenMessengerV2.sol";
import {DeploymentRoles} from "script/DeploymentRoles.sol";
import {NetworkDeploymentConfig} from "script/NetworkDeploymentConfig.sol";

/**
 * @notice Shared helpers for deterministic GatoPago deployments.
 * @dev Signing is deliberately delegated to Foundry CLI accounts/keystores.
 *      No deployment script reads or accepts a plaintext private key.
 */
abstract contract GatoPagoDeploymentScript is Script {
    struct RouterRoles {
        address owner;
        address treasury;
        address authorizationSigner;
        address pauseGuardian;
    }

    error Deploy__PredictedAddressMismatch(address predicted, address actual);
    error Deploy__PaymasterOnlyOnHomeChain(uint256 chainId);
    error Deploy__ValueDoesNotFitUint16(uint256 value);
    error Deploy__ValueDoesNotFitUint32(uint256 value);

    function _routerRoles(address deployer) internal view returns (RouterRoles memory roles) {
        roles.owner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        roles.treasury = vm.envOr("GATOPAGO_TREASURY", vm.envOr("PARMELIA_TREASURY", deployer));
        roles.authorizationSigner =
            vm.envOr("GATOPAGO_PAYMENT_ROUTER_SIGNER", vm.envOr("PARMELIA_PAYMENT_ROUTER_SIGNER", deployer));
        roles.pauseGuardian = vm.envOr("GATOPAGO_PAUSE_GUARDIAN", roles.owner);
    }

    function _assertPredicted(bytes32 salt, bytes memory creationCode, address actual) internal pure {
        address predicted = vm.computeCreate2Address(salt, keccak256(creationCode));
        if (predicted != actual) revert Deploy__PredictedAddressMismatch(predicted, actual);
    }
}

/**
 * @notice Deterministic deployment of account infrastructure. The paymaster is
 *         deployed and funded only on the configured Arbitrum home chain.
 */
contract DeployV2 is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("parmelia.v2.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightAccounts(config);

        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address sponsorSigner = vm.envOr("GATOPAGO_PAYMASTER_SIGNER", vm.envOr("PARMELIA_PAYMASTER_SIGNER", deployer));
        bool deployPaymaster = vm.envOr("GATOPAGO_DEPLOY_PAYMASTER", config.isHomeChain);

        DeploymentRoles.validateBroadcaster(deployer);
        if (deployPaymaster) {
            if (!config.isHomeChain) revert Deploy__PaymasterOnlyOnHomeChain(block.chainid);
            DeploymentRoles.validatePaymaster(block.chainid, deployer, finalOwner, sponsorSigner);
        }

        vm.startBroadcast();

        ERC7913WebAuthnVerifier verifier = new ERC7913WebAuthnVerifier{salt: SALT}();
        _assertPredicted(SALT, type(ERC7913WebAuthnVerifier).creationCode, address(verifier));

        AccountWebAuthnV2 accountImpl = new AccountWebAuthnV2{salt: SALT}();
        _assertPredicted(SALT, type(AccountWebAuthnV2).creationCode, address(accountImpl));

        bytes memory factoryCreationCode =
            abi.encodePacked(type(AccountFactoryV2).creationCode, abi.encode(address(accountImpl)));
        AccountFactoryV2 factory = new AccountFactoryV2{salt: SALT}(address(accountImpl));
        _assertPredicted(SALT, factoryCreationCode, address(factory));

        ParmeliaPaymaster paymaster;
        if (deployPaymaster) {
            IEntryPoint entryPoint = IEntryPoint(config.entryPoint);
            bytes memory paymasterCreationCode =
                abi.encodePacked(type(ParmeliaPaymaster).creationCode, abi.encode(entryPoint, deployer));
            paymaster = new ParmeliaPaymaster{salt: SALT}(entryPoint, deployer);
            _assertPredicted(SALT, paymasterCreationCode, address(paymaster));

            if (sponsorSigner != deployer) paymaster.setSponsorSigner(sponsorSigner);

            uint256 stake = vm.envOr("GATOPAGO_PAYMASTER_STAKE", config.paymasterStake);
            uint256 unstakeDelay = vm.envOr("GATOPAGO_PAYMASTER_UNSTAKE_DELAY", uint256(config.paymasterUnstakeDelay));
            uint256 deposit = vm.envOr("GATOPAGO_PAYMASTER_DEPOSIT", config.paymasterDeposit);
            uint256 maxSponsoredGasCost =
                vm.envOr("GATOPAGO_PAYMASTER_MAX_SPONSORED_GAS_COST", config.maxSponsoredGasCost);
            if (unstakeDelay > type(uint32).max) revert Deploy__ValueDoesNotFitUint32(unstakeDelay);

            if (stake > 0) paymaster.addStake{value: stake}(SafeCast.toUint32(unstakeDelay));
            if (deposit > 0) paymaster.deposit{value: deposit}();
            paymaster.setMaxSponsoredGasCost(maxSponsoredGasCost);
            if (finalOwner != deployer) paymaster.transferOwnership(finalOwner);
        }

        vm.stopBroadcast();

        console.log("=== GatoPago account deployment ===");
        console.log("chainId:                    ", block.chainid);
        console.log("EntryPoint v0.9:            ", config.entryPoint);
        console.log("ERC7913WebAuthnVerifier:    ", address(verifier));
        console.log("AccountWebAuthnV2 impl:     ", address(accountImpl));
        console.log("AccountFactoryV2:           ", address(factory));
        console.log("ParmeliaPaymaster:          ", address(paymaster));
        if (address(paymaster) != address(0)) {
            console.log("Paymaster sponsor signer:   ", paymaster.sponsorSigner());
            console.log("Paymaster current owner:    ", paymaster.owner());
            console.log("Paymaster pending owner:    ", paymaster.pendingOwner());
        }
    }
}

/// @notice Standalone deterministic paymaster deployment for Arbitrum only.
contract DeployPaymasterV2 is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("parmelia.v2.paymaster.solc-0.8.34");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireHomeChain(config);
        NetworkDeploymentConfig.preflightAccounts(config);

        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address sponsorSigner = vm.envOr("GATOPAGO_PAYMASTER_SIGNER", vm.envOr("PARMELIA_PAYMASTER_SIGNER", deployer));
        DeploymentRoles.validatePaymaster(block.chainid, deployer, finalOwner, sponsorSigner);

        IEntryPoint entryPoint = IEntryPoint(config.entryPoint);
        bytes memory creationCode =
            abi.encodePacked(type(ParmeliaPaymaster).creationCode, abi.encode(entryPoint, deployer));

        vm.startBroadcast();
        ParmeliaPaymaster paymaster = new ParmeliaPaymaster{salt: SALT}(entryPoint, deployer);
        _assertPredicted(SALT, creationCode, address(paymaster));
        if (sponsorSigner != deployer) paymaster.setSponsorSigner(sponsorSigner);

        uint256 stake = vm.envOr("GATOPAGO_PAYMASTER_STAKE", config.paymasterStake);
        uint256 unstakeDelay = vm.envOr("GATOPAGO_PAYMASTER_UNSTAKE_DELAY", uint256(config.paymasterUnstakeDelay));
        uint256 deposit = vm.envOr("GATOPAGO_PAYMASTER_DEPOSIT", config.paymasterDeposit);
        uint256 maxSponsoredGasCost = vm.envOr("GATOPAGO_PAYMASTER_MAX_SPONSORED_GAS_COST", config.maxSponsoredGasCost);
        if (unstakeDelay > type(uint32).max) revert Deploy__ValueDoesNotFitUint32(unstakeDelay);

        if (stake > 0) paymaster.addStake{value: stake}(SafeCast.toUint32(unstakeDelay));
        if (deposit > 0) paymaster.deposit{value: deposit}();
        paymaster.setMaxSponsoredGasCost(maxSponsoredGasCost);
        if (finalOwner != deployer) paymaster.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("ParmeliaPaymaster:       ", address(paymaster));
        console.log("Sponsor signer:          ", paymaster.sponsorSigner());
        console.log("Current owner:           ", paymaster.owner());
        console.log("Pending owner:           ", paymaster.pendingOwner());
    }
}

/// @notice Deploys Universal Checkout's same-chain USDC router on Arbitrum.
contract DeployPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.checkout.local.v2");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.preflightLocalCheckout(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        bytes memory creationCode = abi.encodePacked(
            type(ParmeliaPaymentRouterV2).creationCode,
            abi.encode(roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian)
        );

        vm.startBroadcast();
        ParmeliaPaymentRouterV2 router = new ParmeliaPaymentRouterV2{salt: SALT}(
            roles.owner, IERC20(config.usdc), roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("ParmeliaPaymentRouterV2:", address(router));
        console.log("chainId:                 ", block.chainid);
        console.log("USDC:                    ", config.usdc);
        console.log("owner:                   ", roles.owner);
        console.log("treasury:                ", roles.treasury);
        console.log("authorization signer:    ", roles.authorizationSigner);
        console.log("pause guardian:          ", roles.pauseGuardian);
    }
}

/// @notice Deploys Universal Checkout's Base/Avalanche to Arbitrum CCTP rail.
contract DeployCctpPaymentRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("gatopago.checkout.cctp.v1");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireInboundSourceChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        RouterRoles memory roles = _routerRoles(deployer);
        DeploymentRoles.validatePaymentRouterV2(
            block.chainid, deployer, roles.owner, roles.treasury, roles.authorizationSigner, roles.pauseGuardian
        );

        // Capability is not policy: the backend remains free by default. A bounded
        // non-zero ceiling avoids a contract redeploy if an explicit future policy
        // enables fees for a narrow transaction class.
        uint256 configuredFeeCap =
            vm.envOr("GATOPAGO_CCTP_PLATFORM_FEE_CAP_BPS", uint256(config.cctpPaymentPlatformFeeCapBps));
        if (configuredFeeCap > type(uint16).max) revert Deploy__ValueDoesNotFitUint16(configuredFeeCap);
        uint16 feeCap = SafeCast.toUint16(configuredFeeCap);

        bytes memory creationCode = abi.encodePacked(
            type(ParmeliaCctpPaymentRouter).creationCode,
            abi.encode(
                roles.owner,
                IERC20(config.usdc),
                ITokenMessengerV2(config.tokenMessenger),
                roles.treasury,
                roles.authorizationSigner,
                roles.pauseGuardian,
                config.settlementChainId,
                config.cctpFastSupported,
                feeCap
            )
        );

        vm.startBroadcast();
        ParmeliaCctpPaymentRouter router = new ParmeliaCctpPaymentRouter{salt: SALT}(
            roles.owner,
            IERC20(config.usdc),
            ITokenMessengerV2(config.tokenMessenger),
            roles.treasury,
            roles.authorizationSigner,
            roles.pauseGuardian,
            config.settlementChainId,
            config.cctpFastSupported,
            feeCap
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("ParmeliaCctpPaymentRouter:", address(router));
        console.log("source chainId:            ", block.chainid);
        console.log("settlement chainId:        ", config.settlementChainId);
        console.log("destination domain:        ", uint256(router.ARBITRUM_DOMAIN()));
        console.log("fast transfer enabled:     ", config.cctpFastSupported);
        console.log("platform fee cap bps:      ", uint256(feeCap));
        console.log("USDC:                      ", config.usdc);
        console.log("TokenMessengerV2:          ", config.tokenMessenger);
    }
}

/// @notice Deploys the hardened outbound CCTP router on the Arbitrum home chain.
contract DeployCrosschainRouter is GatoPagoDeploymentScript {
    bytes32 internal constant SALT = keccak256("parmelia.v2.crosschainRouter.hardened");

    function run() external {
        NetworkDeploymentConfig.Config memory config = NetworkDeploymentConfig.get(block.chainid);
        NetworkDeploymentConfig.requireHomeChain(config);
        NetworkDeploymentConfig.preflightCctp(config);

        address deployer = msg.sender;
        address finalOwner = vm.envOr("GATOPAGO_CONTRACT_OWNER", vm.envOr("PARMELIA_CONTRACT_OWNER", deployer));
        address treasury = vm.envOr("GATOPAGO_TREASURY", vm.envOr("PARMELIA_TREASURY", deployer));
        DeploymentRoles.validateCrosschainRouter(block.chainid, deployer, finalOwner, treasury);
        uint32[] memory domains = NetworkDeploymentConfig.outboundDomains(config);

        bytes memory creationCode = abi.encodePacked(
            type(ParmeliaCrosschainRouter).creationCode,
            abi.encode(finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains)
        );

        vm.startBroadcast();
        ParmeliaCrosschainRouter router = new ParmeliaCrosschainRouter{salt: SALT}(
            finalOwner, IERC20(config.usdc), ITokenMessengerV2(config.tokenMessenger), treasury, domains
        );
        _assertPredicted(SALT, creationCode, address(router));
        vm.stopBroadcast();

        console.log("ParmeliaCrosschainRouter:", address(router));
        console.log("chainId:                  ", block.chainid);
        console.log("treasury:                 ", treasury);
        console.log("USDC:                     ", config.usdc);
        console.log("TokenMessengerV2:         ", config.tokenMessenger);
    }
}
