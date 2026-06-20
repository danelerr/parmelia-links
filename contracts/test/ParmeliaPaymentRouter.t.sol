// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ParmeliaPaymentRouter} from "../src/ParmeliaPaymentRouter.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
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
}
