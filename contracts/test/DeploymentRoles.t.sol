// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {DeploymentRoles} from "../script/DeploymentRoles.sol";

contract DeploymentRolesHarness {
    function validatePaymaster(uint256 chainId, address deployer, address owner, address signer) external pure {
        DeploymentRoles.validatePaymaster(chainId, deployer, owner, signer);
    }

    function validatePaymentRouter(uint256 chainId, address deployer, address owner, address treasury, address signer)
        external
        pure
    {
        DeploymentRoles.validatePaymentRouter(chainId, deployer, owner, treasury, signer);
    }

    function validateCrosschainRouter(uint256 chainId, address deployer, address owner, address treasury)
        external
        pure
    {
        DeploymentRoles.validateCrosschainRouter(chainId, deployer, owner, treasury);
    }
}

contract DeploymentRolesTest is Test {
    uint256 internal constant ARBITRUM_ONE = 42161;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    address internal constant FOUNDRY_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    address internal constant DEPLOYER = address(0xD1);
    address internal constant OWNER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EE);
    address internal constant SIGNER = address(0x516E2);

    bytes32 internal constant ROLE_DEPLOYER = "deployer";
    bytes32 internal constant ROLE_OWNER = "owner";
    bytes32 internal constant ROLE_TREASURY = "treasury";
    bytes32 internal constant ROLE_PAYMASTER_SIGNER = "paymasterSigner";
    bytes32 internal constant ROLE_INVOICE_SIGNER = "invoiceSigner";

    DeploymentRolesHarness internal harness;

    function setUp() public {
        harness = new DeploymentRolesHarness();
    }

    function test_rejectsZeroAndFoundryDefaultBroadcastersOnEveryNetwork() public {
        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.UnsafeBroadcaster.selector, address(0)));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, address(0), address(0x1), address(0x2));

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.UnsafeBroadcaster.selector, FOUNDRY_SENDER));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, FOUNDRY_SENDER, address(0x1), address(0x2));
    }

    function test_rejectsMissingRolesOnEveryNetwork() public {
        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_OWNER));
        harness.validatePaymaster(ARBITRUM_SEPOLIA, DEPLOYER, address(0), SIGNER);

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_TREASURY));
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, address(0), SIGNER);

        vm.expectRevert(abi.encodeWithSelector(DeploymentRoles.MissingDeploymentRole.selector, ROLE_INVOICE_SIGNER));
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, OWNER, TREASURY, address(0));
    }

    function test_testnetAllowsIntentionalRoleReuse() public view {
        harness.validatePaymaster(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_SEPOLIA, DEPLOYER, DEPLOYER, DEPLOYER);
    }

    function test_mainnetPaymasterAcceptsSeparatedRoles() public view {
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, SIGNER);
    }

    function test_mainnetPaymasterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, DEPLOYER, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_PAYMASTER_SIGNER, DEPLOYER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_PAYMASTER_SIGNER, OWNER);
        harness.validatePaymaster(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER);
    }

    function test_mainnetPaymentRouterAcceptsSeparatedRoles() public view {
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, SIGNER);
    }

    function test_mainnetPaymentRouterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, DEPLOYER, TREASURY, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_TREASURY, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER, SIGNER);

        _expectCollision(ROLE_DEPLOYER, ROLE_INVOICE_SIGNER, DEPLOYER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_TREASURY, OWNER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER, SIGNER);

        _expectCollision(ROLE_OWNER, ROLE_INVOICE_SIGNER, OWNER);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, OWNER);

        _expectCollision(ROLE_TREASURY, ROLE_INVOICE_SIGNER, TREASURY);
        harness.validatePaymentRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY, TREASURY);
    }

    function test_mainnetCrosschainRouterAcceptsSeparatedRoles() public view {
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, TREASURY);
    }

    function test_mainnetCrosschainRouterRejectsEveryRoleCollision() public {
        _expectCollision(ROLE_DEPLOYER, ROLE_OWNER, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, DEPLOYER, TREASURY);

        _expectCollision(ROLE_DEPLOYER, ROLE_TREASURY, DEPLOYER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, DEPLOYER);

        _expectCollision(ROLE_OWNER, ROLE_TREASURY, OWNER);
        harness.validateCrosschainRouter(ARBITRUM_ONE, DEPLOYER, OWNER, OWNER);
    }

    function _expectCollision(bytes32 firstRole, bytes32 secondRole, address account) internal {
        vm.expectRevert(
            abi.encodeWithSelector(DeploymentRoles.MainnetRoleCollision.selector, firstRole, secondRole, account)
        );
    }
}
