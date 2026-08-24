// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ParmeliaCrosschainRouter} from "../src/ParmeliaCrosschainRouter.sol";
import {ITokenMessengerV2} from "../src/interfaces/ITokenMessengerV2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
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
        require(IERC20(burnToken).transferFrom(msg.sender, address(this), amount), "transfer failed");
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
    address user = address(0xCAFE); // a GatoPago smart account
    bytes32 recipient = bytes32(uint256(uint160(0xBEEF)));

    uint256 constant ONE = 1e6; // 1 USDC (6 decimals)
    uint32 constant BASE_DOMAIN = 6;
    uint32 constant FAST = 1000;
    uint32 constant STANDARD = 2000;

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        router = new ParmeliaCrosschainRouter(
            owner,
            IERC20(address(usdc)),
            ITokenMessengerV2(address(messenger)),
            treasury,
            _initialDomains()
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
        _bridge(keccak256("op1"), amount, fee, 13_000);

        assertEq(usdc.balanceOf(treasury), fee, "fee to treasury");
        assertEq(messenger.lastAmount(), amount - fee, "net burned");
        assertEq(messenger.callCount(), 1);
        assertEq(usdc.balanceOf(address(router)), 0, "router holds nothing after");
        assertEq(usdc.balanceOf(address(messenger)), amount - fee, "messenger received net");
    }

    function test_bridge_passesCorrectCctpParams() public {
        _bridge(keccak256("op2"), 50 * ONE, 0, 7_000);
        assertEq(messenger.lastDestinationDomain(), BASE_DOMAIN);
        assertEq(messenger.lastMintRecipient(), recipient);
        assertEq(messenger.lastBurnToken(), address(usdc));
        assertEq(messenger.lastDestinationCaller(), bytes32(0), "v1 keeps receiveMessage permissionless");
        assertEq(messenger.lastMaxFee(), 7_000);
        assertEq(messenger.lastMinFinalityThreshold(), FAST);
    }

    function test_bridge_zeroFeeOk() public {
        uint256 amount = 10 * ONE;
        _bridge(keccak256("op3"), amount, 0, 130);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(messenger.lastAmount(), amount);
    }

    function test_bridge_revertsOnReplay() public {
        bytes32 opId = keccak256("op-replay");
        _bridge(opId, 10 * ONE, 0, 130);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaCrosschainRouter.OpIdAlreadyUsed.selector, opId));
        router.bridgeUSDC(opId, 10 * ONE, 0, BASE_DOMAIN, recipient, 130, FAST);
    }

    function test_bridge_acceptsStandardFinality() public {
        vm.prank(user);
        router.bridgeUSDC(keccak256("standard"), 10 * ONE, 0, BASE_DOMAIN, recipient, 0, STANDARD);
        assertEq(messenger.lastMinFinalityThreshold(), STANDARD);
    }

    function test_bridge_revertsUnsupportedDomain() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaCrosschainRouter.UnsupportedDestinationDomain.selector, 99));
        router.bridgeUSDC(keccak256("unsupported"), 10 * ONE, 0, 99, recipient, 130, FAST);
    }

    function test_bridge_revertsInvalidFinality() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaCrosschainRouter.InvalidFinalityThreshold.selector, 1500));
        router.bridgeUSDC(keccak256("finality"), 10 * ONE, 0, BASE_DOMAIN, recipient, 130, 1500);
    }

    function test_bridge_revertsWhenMaxCctpFeeConsumesBurn() public {
        uint256 amount = 10 * ONE;
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ParmeliaCrosschainRouter.MaxCctpFeeTooHigh.selector, amount, amount)
        );
        router.bridgeUSDC(keccak256("max-fee"), amount, 0, BASE_DOMAIN, recipient, amount, FAST);
    }

    function test_revert_feeTooHigh() public {
        uint256 amount = 100 * ONE;
        uint256 fee = 2 * ONE; // 2% > 1% cap (max 1 USDC)
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaCrosschainRouter.FeeTooHigh.selector, fee, ONE));
        router.bridgeUSDC(keccak256("op4"), amount, fee, BASE_DOMAIN, recipient, 13_000, FAST);
    }

    function test_revert_zeroAmount() public {
        vm.prank(user);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidAmount.selector);
        router.bridgeUSDC(keccak256("op5"), 0, 0, BASE_DOMAIN, recipient, 0, FAST);
    }

    function test_revert_zeroRecipient() public {
        vm.prank(user);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidRecipient.selector);
        router.bridgeUSDC(keccak256("op6"), 10 * ONE, 0, BASE_DOMAIN, bytes32(0), 130, FAST);
    }

    function test_pause_blocksBridge() public {
        vm.prank(owner);
        router.pause();
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.bridgeUSDC(keccak256("op7"), 10 * ONE, 0, BASE_DOMAIN, recipient, 130, FAST);
    }

    function test_unpause_restoresBridge() public {
        vm.startPrank(owner);
        router.pause();
        router.unpause();
        vm.stopPrank();

        _bridge(keccak256("op-unpaused"), 10 * ONE, 0, 130);
        assertEq(messenger.callCount(), 1);
    }

    function test_setTreasury_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        router.setTreasury(address(0x1234));

        vm.prank(owner);
        router.setTreasury(address(0x1234));
        assertEq(router.treasury(), address(0x1234));
    }

    function test_setTreasury_rejectsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidTreasury.selector);
        router.setTreasury(address(0));
    }

    function test_setDestinationDomain_onlyOwnerAndCanDisable() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.setDestinationDomain(BASE_DOMAIN, false);

        vm.prank(owner);
        router.setDestinationDomain(BASE_DOMAIN, false);
        assertFalse(router.supportedDestinationDomain(BASE_DOMAIN));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ParmeliaCrosschainRouter.UnsupportedDestinationDomain.selector, BASE_DOMAIN)
        );
        router.bridgeUSDC(keccak256("disabled"), 10 * ONE, 0, BASE_DOMAIN, recipient, 130, FAST);
    }

    function test_emergencyWithdraw() public {
        usdc.mint(address(router), 5 * ONE); // tokens sent by mistake
        vm.prank(owner);
        router.emergencyWithdraw(address(usdc), treasury, 5 * ONE);
        assertEq(usdc.balanceOf(treasury), 5 * ONE);
    }

    function test_emergencyWithdraw_rejectsZeroToken() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidToken.selector);
        router.emergencyWithdraw(address(0), treasury, 1);
    }

    function test_emergencyWithdraw_rejectsZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidTreasury.selector);
        router.emergencyWithdraw(address(usdc), address(0), 1);
    }

    function test_emergencyWithdraw_onlyOwner() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        router.emergencyWithdraw(address(usdc), treasury, 1);
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidToken.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(0)), ITokenMessengerV2(address(messenger)), treasury, _initialDomains()
        );
    }

    function test_constructor_rejectsTokenWithoutCode() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidToken.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(0xDEAD)), ITokenMessengerV2(address(messenger)), treasury, _initialDomains()
        );
    }

    function test_constructor_rejectsZeroMessenger() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidMessenger.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(usdc)), ITokenMessengerV2(address(0)), treasury, _initialDomains()
        );
    }

    function test_constructor_rejectsMessengerWithoutCode() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidMessenger.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(usdc)), ITokenMessengerV2(address(0xDEAD)), treasury, _initialDomains()
        );
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidTreasury.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), address(0), _initialDomains()
        );
    }

    function test_constructor_rejectsEmptyDestinationDomains() public {
        uint32[] memory domains = new uint32[](0);
        vm.expectRevert(ParmeliaCrosschainRouter.EmptyDestinationDomainList.selector);
        new ParmeliaCrosschainRouter(
            owner, IERC20(address(usdc)), ITokenMessengerV2(address(messenger)), treasury, domains
        );
    }

    function test_revert_zeroOpId() public {
        vm.prank(user);
        vm.expectRevert(ParmeliaCrosschainRouter.InvalidOpId.selector);
        router.bridgeUSDC(bytes32(0), 10 * ONE, 0, BASE_DOMAIN, recipient, 130, FAST);
    }

    /// For ANY valid amount/fee: fee to treasury + net to the messenger equals the
    /// gross pulled from the user, the fee never exceeds the 1% cap, and the
    /// router retains nothing between transactions.
    function testFuzz_bridge_conservesFundsAndHoldsNothing(uint256 amount, uint256 fee) public {
        amount = bound(amount, 2, 1e30);
        fee = bound(fee, 0, (amount * router.MAX_FEE_BPS()) / 10_000);
        vm.assume(amount - fee > 0);
        usdc.mint(user, amount); // on top of setUp's balance

        uint256 userBefore = usdc.balanceOf(user);
        _bridge(keccak256(abi.encode("op_fuzz", amount, fee)), amount, fee, 0);

        assertEq(usdc.balanceOf(treasury), fee, "exact fee to treasury");
        assertEq(messenger.lastAmount(), amount - fee, "net burned");
        assertEq(usdc.balanceOf(address(messenger)) + usdc.balanceOf(treasury), amount, "conservation");
        assertEq(usdc.balanceOf(address(router)), 0, "router must hold nothing");
        assertEq(userBefore - usdc.balanceOf(user), amount, "user debited exactly gross");
    }

    function _initialDomains() internal pure returns (uint32[] memory domains) {
        domains = new uint32[](1);
        domains[0] = BASE_DOMAIN;
    }
}
