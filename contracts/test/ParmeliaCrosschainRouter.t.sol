// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ParmeliaCrosschainRouter, ITokenMessengerV2} from "../src/ParmeliaCrosschainRouter.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev Records the last depositForBurn args and pulls the tokens to simulate a burn.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    uint256 public callCount;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        callCount++;
    }
}

contract ParmeliaCrosschainRouterTest is Test {
    ParmeliaCrosschainRouter router;
    MockUSDC usdc;
    MockTokenMessengerV2 messenger;

    address owner = address(0xA11CE);
    address treasury = address(0x7EE);
    address user = address(0xCAFE); // a Parmelia smart account
    bytes32 recipient = bytes32(uint256(uint160(0xBEEF)));

    uint256 constant ONE = 1e6; // 1 USDC (6 decimals)
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant FAST = 1000;

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        router = new ParmeliaCrosschainRouter(
            owner, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), treasury
        );
        usdc.mint(user, 1000 * ONE);
        vm.prank(user);
        usdc.approve(address(router), type(uint256).max);
    }

    function _bridge(bytes32 opId, uint256 amount, uint256 fee, uint256 maxFee) internal {
        vm.prank(user);
        router.bridgeUSDC(opId, amount, fee, BASE_DOMAIN, recipient, maxFee, FAST);
    }

    function test_bridge_splitsFeeAndBurnsNet() public {
        uint256 amount = 100 * ONE;
        uint256 fee = ONE / 2; // 0.5 USDC, within the 1% cap (max 1 USDC)
        _bridge(bytes32("op1"), amount, fee, 13_000);

        assertEq(usdc.balanceOf(treasury), fee, "fee to treasury");
        assertEq(messenger.lastAmount(), amount - fee, "net burned");
        assertEq(messenger.callCount(), 1);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing after");
        assertEq(usdc.balanceOf(address(messenger)), amount - fee, "messenger received net");
    }

    function test_bridge_passesCorrectCctpParams() public {
        _bridge(bytes32("op2"), 50 * ONE, 0, 7_000);
        assertEq(messenger.lastDestinationDomain(), BASE_DOMAIN);
        assertEq(messenger.lastMintRecipient(), recipient);
        assertEq(messenger.lastBurnToken(), address(usdc));
        assertEq(messenger.lastDestinationCaller(), bytes32(0), "v1 keeps receiveMessage permissionless");
        assertEq(messenger.lastMaxFee(), 7_000);
        assertEq(messenger.lastMinFinalityThreshold(), FAST);
    }

    function test_bridge_zeroFeeOk() public {
        uint256 amount = 10 * ONE;
        _bridge(bytes32("op3"), amount, 0, 130);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(messenger.lastAmount(), amount);
    }

    function test_revert_feeTooHigh() public {
        uint256 amount = 100 * ONE;
        uint256 fee = 2 * ONE; // 2% > 1% cap (max 1 USDC)
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaCrosschainRouter.FeeTooHigh.selector, fee, ONE));
        router.bridgeUSDC(bytes32("op4"), amount, fee, BASE_DOMAIN, recipient, 13_000, FAST);
    }

    function test_revert_zeroAmount() public {
        vm.prank(user);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidAmount.selector);
        router.bridgeUSDC(bytes32("op5"), 0, 0, BASE_DOMAIN, recipient, 0, FAST);
    }

    function test_revert_zeroRecipient() public {
        vm.prank(user);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidRecipient.selector);
        router.bridgeUSDC(bytes32("op6"), 10 * ONE, 0, BASE_DOMAIN, bytes32(0), 130, FAST);
    }

    function test_pause_blocksBridge() public {
        vm.prank(owner);
        router.pause();
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.bridgeUSDC(bytes32("op7"), 10 * ONE, 0, BASE_DOMAIN, recipient, 130, FAST);
    }

    function test_setTreasury_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        router.setTreasury(address(0x1234));

        vm.prank(owner);
        router.setTreasury(address(0x1234));
        assertEq(router.treasury(), address(0x1234));
    }

    function test_emergencyWithdraw() public {
        usdc.mint(address(router), 5 * ONE); // tokens sent by mistake
        vm.prank(owner);
        router.emergencyWithdraw(address(usdc), treasury, 5 * ONE);
        assertEq(usdc.balanceOf(treasury), 5 * ONE);
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidToken.selector);
        new ParmeliaCrosschainRouter(owner, IERC20(address(0)), ITokenMessengerV2(address(messenger)), treasury);
    }

    function test_constructor_rejectsZeroMessenger() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidMessenger.selector);
        new ParmeliaCrosschainRouter(owner, IERC20(address(usdc)), ITokenMessengerV2(address(0)), treasury);
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidTreasury.selector);
        new ParmeliaCrosschainRouter(owner, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), address(0));
    }
}
