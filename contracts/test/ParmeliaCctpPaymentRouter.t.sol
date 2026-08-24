// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ParmeliaCctpPaymentRouter} from "src/ParmeliaCctpPaymentRouter.sol";
import {ITokenMessengerV2} from "src/interfaces/ITokenMessengerV2.sol";

contract MockCctpCheckoutUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Mock CCTP Checkout USDC", "USDC") ERC20Permit("Mock CCTP Checkout USDC") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockCheckoutTokenMessengerV2 is ITokenMessengerV2 {
    uint256 public totalBurned;
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
        totalBurned += amount;
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        ++callCount;
    }
}

contract ParmeliaCctpPaymentRouterTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    uint256 internal constant AUTHORIZATION_SIGNER_KEY = 0xA11CE5161;
    uint256 internal constant PAYER_KEY = 0xBEEF1234;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal merchant = makeAddr("merchant");
    address internal pauseGuardian = makeAddr("pauseGuardian");
    address internal attacker = makeAddr("attacker");
    address internal authorizationSigner;
    address internal payer;

    MockCctpCheckoutUSDC internal usdc;
    MockCheckoutTokenMessengerV2 internal messenger;
    ParmeliaCctpPaymentRouter internal router;

    event CctpPaymentBurned(
        bytes32 indexed intentId,
        bytes32 indexed attemptId,
        address indexed payer,
        address merchant,
        uint256 settlementChainId,
        uint32 destinationDomain,
        uint256 settlementAmount,
        uint256 grossPayerAmount,
        uint256 platformFee,
        uint256 amountBurned,
        uint256 maxCctpFee,
        uint32 minFinalityThreshold,
        bytes32 metadataHash
    );

    function setUp() public {
        authorizationSigner = vm.addr(AUTHORIZATION_SIGNER_KEY);
        payer = vm.addr(PAYER_KEY);
        usdc = new MockCctpCheckoutUSDC();
        messenger = new MockCheckoutTokenMessengerV2();
        router = _deployRouter(true, 100);
        usdc.mint(payer, 1_000 * ONE_USDC);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
    }

    function test_pay_burnsToArbitrumAndGuaranteesMerchantMinimum() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("exact");
        bytes memory signature = _sign(router, authorization, AUTHORIZATION_SIGNER_KEY);
        uint256 burnAmount = authorization.grossPayerAmount - authorization.platformFee;

        vm.expectEmit(true, true, true, true, address(router));
        emit CctpPaymentBurned(
            authorization.intentId,
            authorization.attemptId,
            payer,
            merchant,
            ARBITRUM_SEPOLIA,
            router.ARBITRUM_DOMAIN(),
            authorization.settlementAmount,
            authorization.grossPayerAmount,
            authorization.platformFee,
            burnAmount,
            authorization.maxCctpFee,
            authorization.minFinalityThreshold,
            authorization.metadataHash
        );
        _pay(router, authorization, signature);

        assertEq(usdc.balanceOf(treasury), authorization.platformFee);
        assertEq(messenger.lastAmount(), burnAmount);
        assertEq(burnAmount - authorization.maxCctpFee, authorization.settlementAmount);
        assertEq(messenger.lastDestinationDomain(), router.ARBITRUM_DOMAIN());
        assertEq(messenger.lastMintRecipient(), bytes32(uint256(uint160(merchant))));
        assertEq(messenger.lastBurnToken(), address(usdc));
        assertEq(messenger.lastDestinationCaller(), bytes32(0));
        assertEq(usdc.balanceOf(address(router)), 0);
        assertTrue(router.usedAttempt(authorization.attemptId));
        assertTrue(router.paidIntent(authorization.intentId));
    }

    function test_pay_revertsOnAttemptReplayAndPaidIntent() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory first = _authorization("replay");
        bytes memory signature = _sign(router, first, AUTHORIZATION_SIGNER_KEY);
        _pay(router, first, signature);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__AttemptAlreadyUsed.selector,
                first.attemptId
            )
        );
        router.pay(first, signature);

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory second = _authorization("replay");
        second.attemptId = keccak256("second-attempt");
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__IntentAlreadyPaid.selector,
                first.intentId
            )
        );
        router.pay(second, _sign(router, second, AUTHORIZATION_SIGNER_KEY));
    }

    function test_pay_rejectsDifferentCallerWithoutConsumingAttempt() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("payer");

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__UnauthorizedPayer.selector,
                attacker,
                payer
            )
        );
        router.pay(authorization, _sign(router, authorization, AUTHORIZATION_SIGNER_KEY));

        assertFalse(router.usedAttempt(authorization.attemptId));
    }

    function test_pay_rejectsWrongDestinationChainAndDomain() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("destination");
        authorization.settlementChainId = 42161;
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidDestination.selector,
                42161,
                router.ARBITRUM_DOMAIN()
            )
        );
        router.pay(authorization, new bytes(65));

        authorization = _authorization("destination-domain");
        authorization.destinationDomain = 6;
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidDestination.selector,
                ARBITRUM_SEPOLIA,
                6
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_acceptsFastAndStandardWhenEnabled() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory fast = _authorization("fast");
        fast.minFinalityThreshold = router.FAST_FINALITY();
        _pay(router, fast, _sign(router, fast, AUTHORIZATION_SIGNER_KEY));
        assertEq(messenger.lastMinFinalityThreshold(), router.FAST_FINALITY());

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory standard = _authorization("standard");
        standard.minFinalityThreshold = router.STANDARD_FINALITY();
        _pay(router, standard, _sign(router, standard, AUTHORIZATION_SIGNER_KEY));
        assertEq(messenger.lastMinFinalityThreshold(), router.STANDARD_FINALITY());
    }

    function test_pay_avalancheConfigurationRejectsFastButAcceptsStandard() public {
        ParmeliaCctpPaymentRouter avalancheRouter = _deployRouter(false, 0);
        vm.prank(payer);
        usdc.approve(address(avalancheRouter), type(uint256).max);

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("avax-fast");
        authorization.platformFee = 0;
        authorization.grossPayerAmount -= ONE_USDC / 2;
        authorization.minFinalityThreshold = avalancheRouter.FAST_FINALITY();

        vm.prank(payer);
        vm.expectRevert(ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__FastTransferUnavailable.selector);
        avalancheRouter.pay(authorization, _sign(avalancheRouter, authorization, AUTHORIZATION_SIGNER_KEY));

        authorization = _authorization("avax-standard");
        authorization.platformFee = 0;
        authorization.grossPayerAmount -= ONE_USDC / 2;
        authorization.minFinalityThreshold = avalancheRouter.STANDARD_FINALITY();
        _pay(avalancheRouter, authorization, _sign(avalancheRouter, authorization, AUTHORIZATION_SIGNER_KEY));
        assertEq(messenger.lastMinFinalityThreshold(), avalancheRouter.STANDARD_FINALITY());
    }

    function test_pay_revertsInvalidFinalityThreshold() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("finality");
        authorization.minFinalityThreshold = 1500;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidFinalityThreshold.selector,
                1500
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_revertsWhenPlatformFeeExceedsDeploymentCap() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("platform-fee");
        uint256 maximum = authorization.settlementAmount / 100;
        authorization.platformFee = maximum + 1;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__PlatformFeeTooHigh.selector,
                authorization.platformFee,
                maximum
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_pilotZeroFeeCapRejectsAnyPlatformFee() public {
        ParmeliaCctpPaymentRouter zeroFeeRouter = _deployRouter(true, 0);
        vm.prank(payer);
        usdc.approve(address(zeroFeeRouter), type(uint256).max);
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("zero-fee-cap");

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__PlatformFeeTooHigh.selector,
                authorization.platformFee,
                0
            )
        );
        zeroFeeRouter.pay(authorization, new bytes(65));
    }

    function test_pay_revertsWhenCctpFeeCanConsumeBurn() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("cctp-fee");
        uint256 burnAmount = authorization.grossPayerAmount - authorization.platformFee;
        authorization.maxCctpFee = burnAmount;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__CctpFeeTooHigh.selector,
                burnAmount,
                burnAmount
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_revertsWhenMerchantMinimumIsNotGuaranteed() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("minimum");
        authorization.grossPayerAmount -= 1;
        uint256 guaranteed = authorization.settlementAmount - 1;

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__SettlementAmountNotGuaranteed.selector,
                authorization.settlementAmount,
                guaranteed
            )
        );
        router.pay(authorization, new bytes(65));
    }

    function test_pay_rejectsTamperedAuthorizationAndCrossChainReplay() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory original = _authorization("signature");
        bytes memory signature = _sign(router, original, AUTHORIZATION_SIGNER_KEY);

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory changed = _authorization("signature");
        changed.merchant = attacker;
        _expectInvalidAuthorization(router, changed, signature);

        changed = _authorization("signature");
        changed.maxCctpFee += 1;
        changed.grossPayerAmount += 1;
        _expectInvalidAuthorization(router, changed, signature);

        changed = _authorization("signature");
        changed.metadataHash = keccak256("changed");
        _expectInvalidAuthorization(router, changed, signature);

        uint256 originalChainId = block.chainid;
        vm.chainId(originalChainId + 1);
        _expectInvalidAuthorization(router, _authorization("signature"), signature);
        vm.chainId(originalChainId);

        _pay(router, _authorization("signature"), signature);
    }

    function test_pay_rejectsMalformedAndWrongSignerSignatures() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("bad-signature");
        _expectInvalidAuthorization(router, authorization, hex"1234");
        _expectInvalidAuthorization(router, authorization, _sign(router, authorization, 0xBADBEEF));
    }

    function test_pay_revertsOutsideAuthorizationWindow() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("window");
        authorization.validAfter = uint48(block.timestamp + 10);
        authorization.validUntil = uint48(block.timestamp + 20);
        bytes memory signature = _sign(router, authorization, AUTHORIZATION_SIGNER_KEY);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__AuthorizationNotActive.selector,
                authorization.validAfter
            )
        );
        router.pay(authorization, signature);

        vm.warp(uint256(authorization.validUntil) + 1);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__AuthorizationExpired.selector,
                authorization.validUntil
            )
        );
        router.pay(authorization, signature);
    }

    function test_payWithPermit_burnsWithoutPriorAllowance() public {
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("permit");
        bytes memory signature = _sign(router, authorization, AUTHORIZATION_SIGNER_KEY);
        uint256 permitDeadline = block.timestamp + 10 minutes;
        vm.prank(payer);
        usdc.approve(address(router), 0);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(router, authorization.grossPayerAmount, permitDeadline);

        vm.prank(payer);
        router.payWithPermit(authorization, signature, permitDeadline, v, r, s);

        assertEq(messenger.lastAmount(), authorization.grossPayerAmount - authorization.platformFee);
        assertEq(usdc.allowance(payer, address(router)), 0);
    }

    function test_pauseGuardianCanStopButNotResumePayments() public {
        vm.prank(pauseGuardian);
        router.pause();

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("paused");
        bytes memory signature = _sign(router, authorization, AUTHORIZATION_SIGNER_KEY);
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.pay(authorization, signature);

        vm.prank(pauseGuardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauseGuardian)
        );
        router.unpause();

        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());
    }

    function test_ownerRotatesRolesAndRescuesAccidentalTokens() public {
        address nextTreasury = makeAddr("nextTreasury");
        address nextSigner = makeAddr("nextSigner");
        address nextGuardian = makeAddr("nextGuardian");

        vm.startPrank(owner);
        router.setTreasury(nextTreasury);
        router.setAuthorizationSigner(nextSigner);
        router.setPauseGuardian(nextGuardian);
        vm.stopPrank();

        assertEq(router.treasury(), nextTreasury);
        assertEq(router.authorizationSigner(), nextSigner);
        assertEq(router.pauseGuardian(), nextGuardian);

        usdc.mint(address(router), ONE_USDC);
        vm.prank(owner);
        router.rescueToken(IERC20(address(usdc)), owner, ONE_USDC);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_constructorRejectsInvalidConfiguration() public {
        vm.expectRevert(ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidToken.selector);
        new ParmeliaCctpPaymentRouter(
            owner,
            IERC20(address(0)),
            ITokenMessengerV2(address(messenger)),
            treasury,
            authorizationSigner,
            pauseGuardian,
            ARBITRUM_SEPOLIA,
            true,
            0
        );

        vm.expectRevert(ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidMessenger.selector);
        new ParmeliaCctpPaymentRouter(
            owner,
            IERC20(address(usdc)),
            ITokenMessengerV2(address(0)),
            treasury,
            authorizationSigner,
            pauseGuardian,
            ARBITRUM_SEPOLIA,
            true,
            0
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidPlatformFeeCap.selector,
                101
            )
        );
        new ParmeliaCctpPaymentRouter(
            owner,
            IERC20(address(usdc)),
            ITokenMessengerV2(address(messenger)),
            treasury,
            authorizationSigner,
            pauseGuardian,
            ARBITRUM_SEPOLIA,
            true,
            101
        );

        vm.chainId(ARBITRUM_SEPOLIA);
        vm.expectRevert(ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidSettlementChain.selector);
        new ParmeliaCctpPaymentRouter(
            owner,
            IERC20(address(usdc)),
            ITokenMessengerV2(address(messenger)),
            treasury,
            authorizationSigner,
            pauseGuardian,
            ARBITRUM_SEPOLIA,
            true,
            0
        );
    }

    function testFuzz_payConservesGrossAndGuaranteesSettlement(
        uint256 settlementAmount,
        uint256 platformFeeBps,
        uint256 maxCctpFee
    ) public {
        settlementAmount = bound(settlementAmount, 1, 1e30);
        platformFeeBps = bound(platformFeeBps, 0, 100);
        maxCctpFee = bound(maxCctpFee, 0, 1e24);
        uint256 platformFee = (settlementAmount * platformFeeBps) / 10_000;
        uint256 burnAmount = settlementAmount + maxCctpFee;
        uint256 gross = burnAmount + platformFee;
        usdc.mint(payer, gross);

        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization = _authorization("fuzz");
        authorization.intentId = keccak256(abi.encode("intent", settlementAmount, platformFeeBps, maxCctpFee));
        authorization.attemptId = keccak256(abi.encode("attempt", settlementAmount, platformFeeBps, maxCctpFee));
        authorization.settlementAmount = settlementAmount;
        authorization.grossPayerAmount = gross;
        authorization.platformFee = platformFee;
        authorization.maxCctpFee = maxCctpFee;

        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 messengerBefore = usdc.balanceOf(address(messenger));
        _pay(router, authorization, _sign(router, authorization, AUTHORIZATION_SIGNER_KEY));

        assertEq(payerBefore - usdc.balanceOf(payer), gross);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, platformFee);
        assertEq(usdc.balanceOf(address(messenger)) - messengerBefore, burnAmount);
        assertGe(burnAmount - maxCctpFee, settlementAmount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function _deployRouter(bool fastEnabled, uint16 feeCap)
        internal
        returns (ParmeliaCctpPaymentRouter deployed)
    {
        deployed = new ParmeliaCctpPaymentRouter(
            owner,
            IERC20(address(usdc)),
            ITokenMessengerV2(address(messenger)),
            treasury,
            authorizationSigner,
            pauseGuardian,
            ARBITRUM_SEPOLIA,
            fastEnabled,
            feeCap
        );
    }

    function _authorization(string memory seed)
        internal
        view
        returns (ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization)
    {
        uint256 settlementAmount = 100 * ONE_USDC;
        uint256 platformFee = ONE_USDC / 2;
        uint256 maxCctpFee = 13_000;
        authorization = ParmeliaCctpPaymentRouter.CctpPaymentAuthorization({
            intentId: keccak256(abi.encode("intent", seed)),
            attemptId: keccak256(abi.encode("attempt", seed)),
            payer: payer,
            merchant: merchant,
            settlementChainId: ARBITRUM_SEPOLIA,
            destinationDomain: router.ARBITRUM_DOMAIN(),
            settlementAmount: settlementAmount,
            grossPayerAmount: settlementAmount + platformFee + maxCctpFee,
            platformFee: platformFee,
            maxCctpFee: maxCctpFee,
            minFinalityThreshold: router.FAST_FINALITY(),
            validAfter: uint48(block.timestamp),
            validUntil: uint48(block.timestamp + 10 minutes),
            metadataHash: keccak256(abi.encode("metadata", seed))
        });
    }

    function _sign(
        ParmeliaCctpPaymentRouter target,
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization,
        uint256 signerKey
    ) internal view returns (bytes memory signature) {
        bytes32 digest = target.authorizationDigest(authorization);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _signPermit(ParmeliaCctpPaymentRouter target, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 typeHash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, payer, address(target), value, usdc.nonces(payer), deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(usdc.DOMAIN_SEPARATOR(), structHash);
        return vm.sign(PAYER_KEY, digest);
    }

    function _pay(
        ParmeliaCctpPaymentRouter target,
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization,
        bytes memory signature
    ) internal {
        vm.prank(payer);
        target.pay(authorization, signature);
    }

    function _expectInvalidAuthorization(
        ParmeliaCctpPaymentRouter target,
        ParmeliaCctpPaymentRouter.CctpPaymentAuthorization memory authorization,
        bytes memory signature
    ) internal {
        vm.prank(payer);
        vm.expectRevert(ParmeliaCctpPaymentRouter.ParmeliaCctpPaymentRouter__InvalidAuthorization.selector);
        target.pay(authorization, signature);
    }
}
