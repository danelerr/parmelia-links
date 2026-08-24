// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ParmeliaPaymentRouter} from "../src/ParmeliaPaymentRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
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

contract MockUSDCPermit is ERC20, ERC20Permit {
    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract ParmeliaPaymentRouterTest is Test {
    ParmeliaPaymentRouter router;
    MockUSDC usdc;

    address owner = address(0xA11CE);
    address treasury = address(0x7EE);
    address merchant = address(0xBEEF);
    address payer = address(0xCAFE);
    address attacker = address(0xBAD);

    uint256 signerPk = 0xA11CE5161; // arbitrary test key
    address signer;

    uint256 constant ONE = 1e6; // 1 USDC (6 decimals)

    function setUp() public {
        signer = vm.addr(signerPk);
        router = new ParmeliaPaymentRouter(owner, treasury, signer);
        usdc = new MockUSDC();
        usdc.mint(payer, 1000 * ONE);

        vm.prank(owner);
        router.setTokenSupported(address(usdc), true, ONE); // min 1 USDC

        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
    }

    function _sign(uint256 pk, bytes32 invoiceId, uint256 amount, uint256 feeBps, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = router.invoiceDigest(invoiceId, address(usdc), amount, merchant, feeBps, deadline);
        bytes32 ethDigest = MessageHashUtils.toEthSignedMessageHash(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethDigest);
        return abi.encodePacked(r, s, v);
    }

    function _pay(bytes memory sig, bytes32 id, uint256 amount, uint256 feeBps, uint256 deadline) internal {
        vm.prank(payer);
        router.payInvoice(id, usdc, amount, merchant, feeBps, deadline, sig, bytes(""));
    }

    function test_payInvoice_splitsFeeToMerchantAndTreasury() public {
        bytes32 id = keccak256("pi_1");
        uint256 amount = 100 * ONE;
        uint256 feeBps = 50; // 0.5%
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, feeBps, deadline);

        _pay(sig, id, amount, feeBps, deadline);

        uint256 fee = (amount * feeBps) / 10_000; // 0.5 USDC
        assertEq(usdc.balanceOf(merchant), amount - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(payer), 1000 * ONE - amount);
        assertTrue(router.invoicePaid(id));
    }

    function test_payInvoice_zeroFee_allToMerchant() public {
        bytes32 id = keccak256("pi_nofee");
        uint256 amount = 25 * ONE;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, 0, deadline);

        _pay(sig, id, amount, 0, deadline);

        assertEq(usdc.balanceOf(merchant), amount);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_payInvoice_revertsOnWrongSigner() public {
        bytes32 id = keccak256("pi_2");
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(0xBADBAD, id, 10 * ONE, 0, deadline); // attacker key
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, 10 * ONE, merchant, 0, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsOnReplay() public {
        bytes32 id = keccak256("pi_3");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, 0, deadline);
        _pay(sig, id, amount, 0, deadline);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaPaymentRouter.InvoiceAlreadyPaid.selector, id));
        router.payInvoice(id, usdc, amount, merchant, 0, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsOnUnsupportedToken() public {
        MockUSDC other = new MockUSDC();
        other.mint(payer, 100 * ONE);
        vm.prank(payer);
        other.approve(address(router), type(uint256).max);

        bytes32 id = keccak256("pi_4");
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = router.invoiceDigest(id, address(other), 10 * ONE, merchant, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(digest));
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaPaymentRouter.UnsupportedToken.selector, address(other)));
        router.payInvoice(id, other, 10 * ONE, merchant, 0, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsBelowMinimum() public {
        bytes32 id = keccak256("pi_5");
        uint256 amount = ONE / 2; // 0.5 USDC < 1 USDC min
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, 0, deadline);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(ParmeliaPaymentRouter.AmountBelowMinimum.selector, address(usdc), amount, ONE)
        );
        router.payInvoice(id, usdc, amount, merchant, 0, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsFeeTooHigh() public {
        bytes32 id = keccak256("pi_6");
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, 10 * ONE, 200, deadline); // 2% > 1% cap
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaPaymentRouter.FeeTooHigh.selector, 200));
        router.payInvoice(id, usdc, 10 * ONE, merchant, 200, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsExpired() public {
        bytes32 id = keccak256("pi_7");
        uint256 deadline = block.timestamp + 100;
        bytes memory sig = _sign(signerPk, id, 10 * ONE, 0, deadline);
        vm.warp(deadline + 1);
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.AuthorizationExpired.selector);
        router.payInvoice(id, usdc, 10 * ONE, merchant, 0, deadline, sig, bytes(""));
    }

    function test_payInvoice_revertsWhenPaused() public {
        vm.prank(owner);
        router.pause();
        bytes32 id = keccak256("pi_8");
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, 10 * ONE, 0, deadline);
        vm.prank(payer);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.payInvoice(id, usdc, 10 * ONE, merchant, 0, deadline, sig, bytes(""));
    }

    function test_setters_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        router.setTreasury(attacker);
    }

    function test_constants() public view {
        assertEq(router.MAX_FEE_BPS(), 100);
    }

    // ─── Property tests: conservation + tamper resistance ───────────────────────

    /// For ANY valid amount/fee, funds are conserved (merchant + treasury == amount),
    /// the fee never exceeds the 1% cap, and the router retains nothing.
    function testFuzz_payInvoice_conservesFundsAndHoldsNothing(uint256 amount, uint256 feeBps) public {
        amount = bound(amount, ONE, 1e30);
        feeBps = bound(feeBps, 0, router.MAX_FEE_BPS());
        usdc.mint(payer, amount); // on top of setUp's balance

        bytes32 id = keccak256(abi.encode("pi_fuzz", amount, feeBps));
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, feeBps, deadline);

        uint256 payerBefore = usdc.balanceOf(payer);
        _pay(sig, id, amount, feeBps, deadline);

        uint256 fee = (amount * feeBps) / 10_000;
        assertEq(usdc.balanceOf(merchant) + usdc.balanceOf(treasury), amount, "conservation");
        assertEq(usdc.balanceOf(treasury), fee, "exact fee");
        assertLe(fee * 10_000, amount * router.MAX_FEE_BPS(), "fee under hard cap");
        assertEq(usdc.balanceOf(address(router)), 0, "router must hold nothing");
        assertEq(payerBefore - usdc.balanceOf(payer), amount, "payer debited exactly amount");
    }

    /// Tampering with ANY economic term of a validly-signed invoice must fail:
    /// the digest binds every parameter.
    function test_payInvoice_rejectsTamperedTerms() public {
        bytes32 id = keccak256("pi_tamper");
        uint256 amount = 50 * ONE;
        uint256 feeBps = 10;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, feeBps, deadline);

        // Tampered amount.
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount + 1, merchant, feeBps, deadline, sig, bytes(""));

        // Tampered merchant (redirect the funds).
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount, attacker, feeBps, deadline, sig, bytes(""));

        // Tampered fee.
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount, merchant, feeBps + 1, deadline, sig, bytes(""));

        // Tampered deadline (extend the authorization's life).
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount, merchant, feeBps, deadline + 1, sig, bytes(""));

        // Tampered invoice id.
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(keccak256("other"), usdc, amount, merchant, feeBps, deadline, sig, bytes(""));

        // The untampered call still works: the signature itself was fine.
        _pay(sig, id, amount, feeBps, deadline);
        assertTrue(router.invoicePaid(id));
    }

    /// An authorization signed for one chain must not replay on another
    /// (block.chainid is inside the digest).
    function test_payInvoice_rejectsCrossChainReplay() public {
        bytes32 id = keccak256("pi_xchain");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, 0, deadline);

        vm.chainId(31338); // a different chain
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount, merchant, 0, deadline, sig, bytes(""));
    }

    function test_emergencyWithdraw_recoversStrandedTokens() public {
        usdc.mint(address(router), 7 * ONE); // simulate tokens sent by mistake
        vm.prank(owner);
        router.emergencyWithdraw(address(usdc), owner, 7 * ONE);
        assertEq(usdc.balanceOf(owner), 7 * ONE);
        assertEq(usdc.balanceOf(address(router)), 0);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        router.emergencyWithdraw(address(usdc), attacker, 1);
    }

    // ─── payInvoiceWithPermit (EIP-2612: pay in one tx, no prior approve) ───────

    function _signPermit(
        MockUSDCPermit token,
        uint256 ownerPk,
        address ownerAddr,
        address spender,
        uint256 value,
        uint256 permitDeadline
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 typeHash = keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );
        bytes32 structHash =
            keccak256(abi.encode(typeHash, ownerAddr, spender, value, token.nonces(ownerAddr), permitDeadline));
        bytes32 d = MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), structHash);
        return vm.sign(ownerPk, d);
    }

    function _signInvoice(address token, bytes32 id, uint256 amount, uint256 feeBps, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = router.invoiceDigest(id, token, amount, merchant, feeBps, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function test_payInvoiceWithPermit_noPriorApprove() public {
        MockUSDCPermit ptoken = new MockUSDCPermit();
        vm.prank(owner);
        router.setTokenSupported(address(ptoken), true, ONE);

        uint256 payerPk = 0xBEEF1234;
        address permitPayer = vm.addr(payerPk);
        ptoken.mint(permitPayer, 100 * ONE);
        // NOTE: no approve() - the permit grants the allowance in the same tx.

        bytes32 id = keccak256("pi_permit");
        uint256 amount = 40 * ONE;
        uint256 feeBps = 50;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _signInvoice(address(ptoken), id, amount, feeBps, deadline);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ptoken, payerPk, permitPayer, address(router), amount, deadline);

        vm.prank(permitPayer);
        router.payInvoiceWithPermit(id, ptoken, amount, merchant, feeBps, deadline, sig, bytes(""), deadline, v, r, s);

        uint256 fee = (amount * feeBps) / 10_000;
        assertEq(ptoken.balanceOf(merchant), amount - fee);
        assertEq(ptoken.balanceOf(treasury), fee);
        assertTrue(router.invoicePaid(id));
    }

    function test_payInvoiceWithPermit_toleratesFailedPermit() public {
        // A bogus permit must be swallowed (try/catch); a pre-existing allowance
        // still lets the payment go through (front-run-safe).
        MockUSDCPermit ptoken = new MockUSDCPermit();
        vm.prank(owner);
        router.setTokenSupported(address(ptoken), true, ONE);
        address p = address(0xCAFE2);
        ptoken.mint(p, 100 * ONE);
        vm.prank(p);
        ptoken.approve(address(router), type(uint256).max);

        bytes32 id = keccak256("pi_permit2");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _signInvoice(address(ptoken), id, amount, 0, deadline);

        vm.prank(p);
        router.payInvoiceWithPermit(
            id, ptoken, amount, merchant, 0, deadline, sig, bytes(""), deadline, 27, bytes32(0), bytes32(0)
        );

        assertEq(ptoken.balanceOf(merchant), amount);
        assertTrue(router.invoicePaid(id));
    }

    // ─── Admin validation & lifecycle (negative + happy paths) ──────────────────

    function test_constructor_revertsZeroTreasury() public {
        vm.expectRevert(ParmeliaPaymentRouter.InvalidTreasury.selector);
        new ParmeliaPaymentRouter(owner, address(0), signer);
    }

    function test_constructor_revertsZeroSigner() public {
        vm.expectRevert(ParmeliaPaymentRouter.InvalidSigner.selector);
        new ParmeliaPaymentRouter(owner, treasury, address(0));
    }

    function test_setTreasury_updatesTargetAndRoutesFee() public {
        address newTreasury = address(0x7EE2);
        vm.prank(owner);
        router.setTreasury(newTreasury);
        assertEq(router.treasury(), newTreasury);

        bytes32 id = keccak256("pi_newtreasury");
        uint256 amount = 100 * ONE;
        uint256 feeBps = 50;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, feeBps, deadline);
        _pay(sig, id, amount, feeBps, deadline);
        assertEq(usdc.balanceOf(newTreasury), (amount * feeBps) / 10_000);
    }

    function test_setTreasury_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidTreasury.selector);
        router.setTreasury(address(0));
    }

    function test_setInvoiceSigner_rotatesAuthority() public {
        uint256 newPk = 0xC0FFEE;
        address newSigner = vm.addr(newPk);
        vm.prank(owner);
        router.setInvoiceSigner(newSigner);
        assertEq(router.invoiceSigner(), newSigner);

        bytes32 id = keccak256("pi_rotated");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;

        // The old signer no longer authorizes.
        bytes memory oldSig = _sign(signerPk, id, amount, 0, deadline);
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAuthorization.selector);
        router.payInvoice(id, usdc, amount, merchant, 0, deadline, oldSig, bytes(""));

        // The new signer does.
        _pay(_sign(newPk, id, amount, 0, deadline), id, amount, 0, deadline);
        assertTrue(router.invoicePaid(id));
    }

    function test_setInvoiceSigner_revertsZero() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidSigner.selector);
        router.setInvoiceSigner(address(0));
    }

    function test_setTokenSupported_revertsZeroToken() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidToken.selector);
        router.setTokenSupported(address(0), true, 0);
    }

    function test_setTokenSupported_canDisableToken() public {
        vm.prank(owner);
        router.setTokenSupported(address(usdc), false, 0);

        bytes32 id = keccak256("pi_disabled");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(signerPk, id, amount, 0, deadline);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(ParmeliaPaymentRouter.UnsupportedToken.selector, address(usdc)));
        router.payInvoice(id, usdc, amount, merchant, 0, deadline, sig, bytes(""));
    }

    function test_emergencyWithdraw_revertsZeroToken() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidToken.selector);
        router.emergencyWithdraw(address(0), owner, 1);
    }

    function test_emergencyWithdraw_revertsZeroTo() public {
        vm.prank(owner);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidTreasury.selector);
        router.emergencyWithdraw(address(usdc), address(0), 1);
    }

    function test_pauseUnpause_roundtrip() public {
        vm.prank(owner);
        router.pause();
        vm.prank(owner);
        router.unpause();

        // After unpause a normal payment succeeds again (covers the whenNotPaused pass).
        bytes32 id = keccak256("pi_unpaused");
        uint256 amount = 10 * ONE;
        uint256 deadline = block.timestamp + 600;
        _pay(_sign(signerPk, id, amount, 0, deadline), id, amount, 0, deadline);
        assertTrue(router.invoicePaid(id));
    }

    // ─── _settle input guards (each reverts before the signature check) ─────────

    function test_payInvoice_revertsZeroInvoiceId() public {
        uint256 deadline = block.timestamp + 600;
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidInvoiceId.selector);
        router.payInvoice(bytes32(0), usdc, 10 * ONE, merchant, 0, deadline, new bytes(65), bytes(""));
    }

    function test_payInvoice_revertsZeroMerchant() public {
        uint256 deadline = block.timestamp + 600;
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidMerchant.selector);
        router.payInvoice(keccak256("pi_zm"), usdc, 10 * ONE, address(0), 0, deadline, new bytes(65), bytes(""));
    }

    function test_payInvoice_revertsZeroToken() public {
        uint256 deadline = block.timestamp + 600;
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidToken.selector);
        router.payInvoice(
            keccak256("pi_zt"), IERC20(address(0)), 10 * ONE, merchant, 0, deadline, new bytes(65), bytes("")
        );
    }

    function test_payInvoice_revertsZeroAmount() public {
        uint256 deadline = block.timestamp + 600;
        vm.prank(payer);
        vm.expectRevert(ParmeliaPaymentRouter.InvalidAmount.selector);
        router.payInvoice(keccak256("pi_za"), usdc, 0, merchant, 0, deadline, new bytes(65), bytes(""));
    }

    function test_payInvoice_noMinimum_acceptsTinyAmount() public {
        // A supported token with min 0 accepts a 1-unit payment: covers the
        // `minimum > 0` false branch in _settle.
        MockUSDC nomin = new MockUSDC();
        nomin.mint(payer, 100 * ONE);
        vm.prank(owner);
        router.setTokenSupported(address(nomin), true, 0);
        vm.prank(payer);
        nomin.approve(address(router), type(uint256).max);

        bytes32 id = keccak256("pi_nomin");
        uint256 amount = 1; // 1 atomic unit, below the default 1 USDC min
        uint256 deadline = block.timestamp + 600;
        bytes32 digest = router.invoiceDigest(id, address(nomin), amount, merchant, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, MessageHashUtils.toEthSignedMessageHash(digest));

        vm.prank(payer);
        router.payInvoice(id, nomin, amount, merchant, 0, deadline, abi.encodePacked(r, s, v), bytes(""));
        assertEq(nomin.balanceOf(merchant), amount);
    }
}
