// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ParmeliaPaymentRouter
 * @notice Open-payment rail for GatoPago (Flow B): lets ANY external wallet pay a
 *         GatoPago payment intent. Funds go straight to the merchant's account;
 *         GatoPago never custodies them. A small platform fee is split to the
 *         treasury in the same transaction.
 *
 *         Derived from the AvaSettle PaymentRouter, with one key change: AvaSettle
 *         sends funds to a single platform treasury (custodial); here the funds go
 *         to the per-invoice `merchant` address (non-custodial). The merchant,
 *         amount, fee and deadline are authorized by a GatoPago backend signature,
 *         so a payer cannot redirect the destination, change the amount/fee, or
 *         replay the invoice. `invoicePaid` guards against double payment.
 */
contract ParmeliaPaymentRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on the platform fee, enforced regardless of the signed value.
    uint256 public constant MAX_FEE_BPS = 100; // 1%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Receives the platform fee.
    address public treasury;
    /// @notice GatoPago backend EOA that authorizes invoices.
    address public invoiceSigner;

    mapping(address token => bool supported) public supportedTokens;
    mapping(address token => uint256 minimum) public minAmount;
    mapping(bytes32 invoiceId => bool paid) public invoicePaid;

    // ─── Errors ──────────────────────────────────────────────────────────────
    error InvalidTreasury();
    error InvalidSigner();
    error InvalidToken();
    error UnsupportedToken(address token);
    error InvalidInvoiceId();
    error InvalidMerchant();
    error InvalidAmount();
    error AmountBelowMinimum(address token, uint256 amount, uint256 minimum);
    error FeeTooHigh(uint256 feeBps);
    error InvoiceAlreadyPaid(bytes32 invoiceId);
    error AuthorizationExpired();
    error InvalidAuthorization();

    // ─── Events ──────────────────────────────────────────────────────────────
    event TreasuryUpdated(address indexed previous, address indexed current);
    event InvoiceSignerUpdated(address indexed previous, address indexed current);
    event TokenSupportUpdated(address indexed token, bool supported, uint256 minAmount);
    event InvoicePaid(
        bytes32 indexed invoiceId,
        address indexed payer,
        address indexed merchant,
        address token,
        uint256 amount,
        uint256 fee,
        bytes metadata
    );
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner, address initialTreasury, address initialSigner) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert InvalidTreasury();
        if (initialSigner == address(0)) revert InvalidSigner();
        treasury = initialTreasury;
        invoiceSigner = initialSigner;
        emit TreasuryUpdated(address(0), initialTreasury);
        emit InvoiceSignerUpdated(address(0), initialSigner);
    }

    // ─── Owner administration ─────────────────────────────────────────────────

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setInvoiceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidSigner();
        emit InvoiceSignerUpdated(invoiceSigner, newSigner);
        invoiceSigner = newSigner;
    }

    /// @notice Whitelist policy (AUDIT L-2): list ONLY standard ERC-20s. A
    ///         fee-on-transfer or rebasing token would make the merchant receive
    ///         less than the `amount` recorded in the InvoicePaid event that
    ///         drives accounting. The contract does not measure balance deltas
    ///         on purpose (gas); the whitelist is the enforcement point.
    /// @param minimum Minimum accepted atomic amount (0 = no minimum).
    function setTokenSupported(address token, bool supported, uint256 minimum) external onlyOwner {
        if (token == address(0)) revert InvalidToken();
        supportedTokens[token] = supported;
        minAmount[token] = minimum;
        emit TokenSupportUpdated(token, supported, minimum);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Recover tokens sent here by mistake (the router never holds funds in normal flow).
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) revert InvalidToken();
        if (to == address(0)) revert InvalidTreasury();
        IERC20(token).safeTransfer(to, amount);
        emit EmergencyWithdraw(token, to, amount);
    }

    // ─── Authorization digest ──────────────────────────────────────────────────

    /// @dev The message the GatoPago backend signs. Binds chain + router + all
    ///      economic terms so none can be tampered with and it can't be replayed
    ///      across chains or routers.
    function invoiceDigest(
        bytes32 invoiceId,
        address token,
        uint256 amount,
        address merchant,
        uint256 feeBps,
        uint256 deadline
    ) public view returns (bytes32) {
        // Keep the signed payload explicit and auditable; this path is not a
        // transaction hot loop, so the assembly-only gas saving is not worth it.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(
            abi.encode(block.chainid, address(this), invoiceId, token, amount, merchant, feeBps, deadline)
        );
    }

    // ─── Core ───────────────────────────────────────────────────────────────────

    /**
     * @notice Pay a GatoPago invoice. The payer must have approved this router for
     *         `amount` of `token`. Funds split: `amount - fee` to `merchant`,
     *         `fee` to the treasury. All terms are authorized by `signature`.
     */
    function payInvoice(
        bytes32 invoiceId,
        IERC20 token,
        uint256 amount,
        address merchant,
        uint256 feeBps,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata metadata
    ) external nonReentrant whenNotPaused {
        _settle(invoiceId, token, amount, merchant, feeBps, deadline, signature, metadata);
    }

    /**
     * @notice Same as {payInvoice} but consumes an EIP-2612 permit first, so the
     *         payer needs no separate `approve` (one transaction instead of two).
     * @dev The permit is wrapped in try/catch: if a front-runner already submitted
     *      the same signature (consuming the nonce) the allowance is still in place,
     *      so the payment proceeds; any genuine allowance shortfall reverts in the
     *      transferFrom inside {_settle}. `token` must support EIP-2612 (USDC does).
     * @param permitDeadline EIP-2612 signature deadline (unix seconds).
     * @param v,r,s          Components of the payer's permit signature.
     */
    function payInvoiceWithPermit(
        bytes32 invoiceId,
        IERC20 token,
        uint256 amount,
        address merchant,
        uint256 feeBps,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata metadata,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, permitDeadline, v, r, s) {} catch {}
        _settle(invoiceId, token, amount, merchant, feeBps, deadline, signature, metadata);
    }

    /// @dev Shared settlement body. Callers MUST carry `nonReentrant` + `whenNotPaused`.
    function _settle(
        bytes32 invoiceId,
        IERC20 token,
        uint256 amount,
        address merchant,
        uint256 feeBps,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata metadata
    ) private {
        if (block.timestamp > deadline) revert AuthorizationExpired();
        if (invoiceId == bytes32(0)) revert InvalidInvoiceId();
        if (merchant == address(0)) revert InvalidMerchant();
        if (address(token) == address(0)) revert InvalidToken();
        if (!supportedTokens[address(token)]) revert UnsupportedToken(address(token));
        if (amount == 0) revert InvalidAmount();

        uint256 minimum = minAmount[address(token)];
        if (minimum > 0 && amount < minimum) revert AmountBelowMinimum(address(token), amount, minimum);
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh(feeBps);
        if (invoicePaid[invoiceId]) revert InvoiceAlreadyPaid(invoiceId);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
            invoiceDigest(invoiceId, address(token), amount, merchant, feeBps, deadline)
        );
        if (ECDSA.recover(digest, signature) != invoiceSigner) revert InvalidAuthorization();

        invoicePaid[invoiceId] = true;

        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        token.safeTransferFrom(msg.sender, merchant, amount - fee);
        if (fee > 0) {
            token.safeTransferFrom(msg.sender, treasury, fee);
        }

        emit InvoicePaid(invoiceId, msg.sender, merchant, address(token), amount, fee, metadata);
    }
}
