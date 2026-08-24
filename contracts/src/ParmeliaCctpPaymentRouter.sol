// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ITokenMessengerV2} from "src/interfaces/ITokenMessengerV2.sol";

/**
 * @title ParmeliaCctpPaymentRouter
 * @notice Non-custodial USDC checkout rail that burns on Base or Avalanche and
 *         settles directly to the merchant on GatoPago's Arbitrum home chain.
 * @dev This contract intentionally fixes the destination to Circle domain 3,
 *      leaves destination execution permissionless, and does not use hooks.
 * @custom:security-contact https://github.com/danelerr/parmelia-links/security/advisories/new
 */
contract ParmeliaCctpPaymentRouter is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct CctpPaymentAuthorization {
        bytes32 intentId;
        bytes32 attemptId;
        address payer;
        address merchant;
        uint256 settlementChainId;
        uint32 destinationDomain;
        uint256 settlementAmount;
        uint256 grossPayerAmount;
        uint256 platformFee;
        uint256 maxCctpFee;
        uint32 minFinalityThreshold;
        uint48 validAfter;
        uint48 validUntil;
        bytes32 metadataHash;
    }

    uint256 public constant MAX_ALLOWED_PLATFORM_FEE_BPS = 100;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint32 public constant ARBITRUM_DOMAIN = 3;
    uint32 public constant FAST_FINALITY = 1000;
    uint32 public constant STANDARD_FINALITY = 2000;
    bytes32 private constant ANY_DESTINATION_CALLER = bytes32(0);

    bytes32 public constant CCTP_PAYMENT_AUTHORIZATION_TYPEHASH = keccak256(
        "CctpPaymentAuthorization(bytes32 intentId,bytes32 attemptId,address payer,address merchant,uint256 settlementChainId,uint32 destinationDomain,uint256 settlementAmount,uint256 grossPayerAmount,uint256 platformFee,uint256 maxCctpFee,uint32 minFinalityThreshold,uint48 validAfter,uint48 validUntil,bytes32 metadataHash)"
    );

    IERC20 public immutable USDC;
    ITokenMessengerV2 public immutable TOKEN_MESSENGER;
    uint256 public immutable SETTLEMENT_CHAIN_ID;
    bool public immutable FAST_TRANSFER_ENABLED;
    uint16 public immutable MAX_PLATFORM_FEE_BPS;

    address public treasury;
    address public authorizationSigner;
    address public pauseGuardian;

    mapping(bytes32 attemptId => bool used) public usedAttempt;
    mapping(bytes32 intentId => bool paid) public paidIntent;

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event AuthorizationSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event PauseGuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
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
    event TokenRescued(address indexed token, address indexed recipient, uint256 amount);

    error ParmeliaCctpPaymentRouter__InvalidToken();
    error ParmeliaCctpPaymentRouter__InvalidMessenger();
    error ParmeliaCctpPaymentRouter__InvalidTreasury();
    error ParmeliaCctpPaymentRouter__InvalidAuthorizationSigner();
    error ParmeliaCctpPaymentRouter__InvalidPauseGuardian();
    error ParmeliaCctpPaymentRouter__InvalidSettlementChain();
    error ParmeliaCctpPaymentRouter__InvalidPlatformFeeCap(uint256 feeBps);
    error ParmeliaCctpPaymentRouter__InvalidIntentId();
    error ParmeliaCctpPaymentRouter__InvalidAttemptId();
    error ParmeliaCctpPaymentRouter__InvalidPayer();
    error ParmeliaCctpPaymentRouter__InvalidMerchant();
    error ParmeliaCctpPaymentRouter__InvalidAmount();
    error ParmeliaCctpPaymentRouter__InvalidAuthorizationWindow();
    error ParmeliaCctpPaymentRouter__AuthorizationNotActive(uint48 validAfter);
    error ParmeliaCctpPaymentRouter__AuthorizationExpired(uint48 validUntil);
    error ParmeliaCctpPaymentRouter__UnauthorizedPayer(address caller, address payer);
    error ParmeliaCctpPaymentRouter__InvalidDestination(uint256 chainId, uint32 domain);
    error ParmeliaCctpPaymentRouter__InvalidFinalityThreshold(uint32 threshold);
    error ParmeliaCctpPaymentRouter__FastTransferUnavailable();
    error ParmeliaCctpPaymentRouter__PlatformFeeTooHigh(uint256 fee, uint256 maximum);
    error ParmeliaCctpPaymentRouter__CctpFeeTooHigh(uint256 maxFee, uint256 burnAmount);
    error ParmeliaCctpPaymentRouter__SettlementAmountNotGuaranteed(uint256 minimum, uint256 guaranteed);
    error ParmeliaCctpPaymentRouter__AttemptAlreadyUsed(bytes32 attemptId);
    error ParmeliaCctpPaymentRouter__IntentAlreadyPaid(bytes32 intentId);
    error ParmeliaCctpPaymentRouter__InvalidAuthorization();
    error ParmeliaCctpPaymentRouter__UnauthorizedPause(address caller);
    error ParmeliaCctpPaymentRouter__InvalidRescueRecipient();

    constructor(
        address initialOwner,
        IERC20 usdc,
        ITokenMessengerV2 tokenMessenger,
        address initialTreasury,
        address initialAuthorizationSigner,
        address initialPauseGuardian,
        uint256 homeSettlementChainId,
        bool enableFastTransfer,
        uint16 platformFeeCapBps
    ) EIP712("GatoPago CCTP Payment Router", "1") Ownable(initialOwner) {
        if (address(usdc).code.length == 0) revert ParmeliaCctpPaymentRouter__InvalidToken();
        if (address(tokenMessenger).code.length == 0) revert ParmeliaCctpPaymentRouter__InvalidMessenger();
        if (initialTreasury == address(0)) revert ParmeliaCctpPaymentRouter__InvalidTreasury();
        if (initialAuthorizationSigner == address(0)) {
            revert ParmeliaCctpPaymentRouter__InvalidAuthorizationSigner();
        }
        if (initialPauseGuardian == address(0)) revert ParmeliaCctpPaymentRouter__InvalidPauseGuardian();
        if (homeSettlementChainId == 0 || homeSettlementChainId == block.chainid) {
            revert ParmeliaCctpPaymentRouter__InvalidSettlementChain();
        }
        if (platformFeeCapBps > MAX_ALLOWED_PLATFORM_FEE_BPS) {
            revert ParmeliaCctpPaymentRouter__InvalidPlatformFeeCap(platformFeeCapBps);
        }

        USDC = usdc;
        TOKEN_MESSENGER = tokenMessenger;
        SETTLEMENT_CHAIN_ID = homeSettlementChainId;
        FAST_TRANSFER_ENABLED = enableFastTransfer;
        MAX_PLATFORM_FEE_BPS = platformFeeCapBps;
        treasury = initialTreasury;
        authorizationSigner = initialAuthorizationSigner;
        pauseGuardian = initialPauseGuardian;

        emit TreasuryUpdated(address(0), initialTreasury);
        emit AuthorizationSignerUpdated(address(0), initialAuthorizationSigner);
        emit PauseGuardianUpdated(address(0), initialPauseGuardian);
    }

    /*//////////////////////////////////////////////////////////////
                         USER-FACING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pays an authorized checkout attempt using an existing USDC allowance.
    function pay(CctpPaymentAuthorization calldata authorization, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        _burnForSettlement(authorization, signature);
    }

    /// @notice Attempts an EIP-2612 permit before burning for settlement.
    function payWithPermit(
        CctpPaymentAuthorization calldata authorization,
        bytes calldata signature,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        try IERC20Permit(address(USDC)).permit(
            msg.sender, address(this), authorization.grossPayerAmount, permitDeadline, v, r, s
        ) {} catch {}
        _burnForSettlement(authorization, signature);
    }

    /*//////////////////////////////////////////////////////////////
                         ADMINISTRATION
    //////////////////////////////////////////////////////////////*/

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ParmeliaCctpPaymentRouter__InvalidTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setAuthorizationSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ParmeliaCctpPaymentRouter__InvalidAuthorizationSigner();
        emit AuthorizationSignerUpdated(authorizationSigner, newSigner);
        authorizationSigner = newSigner;
    }

    function setPauseGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ParmeliaCctpPaymentRouter__InvalidPauseGuardian();
        emit PauseGuardianUpdated(pauseGuardian, newGuardian);
        pauseGuardian = newGuardian;
    }

    function pause() external {
        if (msg.sender != owner() && msg.sender != pauseGuardian) {
            revert ParmeliaCctpPaymentRouter__UnauthorizedPause(msg.sender);
        }
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueToken(IERC20 token, address recipient, uint256 amount) external onlyOwner {
        if (address(token).code.length == 0) revert ParmeliaCctpPaymentRouter__InvalidToken();
        if (recipient == address(0)) revert ParmeliaCctpPaymentRouter__InvalidRescueRecipient();
        token.safeTransfer(recipient, amount);
        emit TokenRescued(address(token), recipient, amount);
    }

    /*//////////////////////////////////////////////////////////////
                         READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function authorizationDigest(CctpPaymentAuthorization calldata authorization)
        external
        view
        returns (bytes32 digest)
    {
        digest = _authorizationDigest(authorization);
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _burnForSettlement(CctpPaymentAuthorization calldata authorization, bytes calldata signature) private {
        uint256 burnAmount = _validateAuthorization(authorization, signature);

        usedAttempt[authorization.attemptId] = true;
        paidIntent[authorization.intentId] = true;

        if (authorization.platformFee > 0) {
            USDC.safeTransferFrom(authorization.payer, treasury, authorization.platformFee);
        }
        USDC.safeTransferFrom(authorization.payer, address(this), burnAmount);
        USDC.forceApprove(address(TOKEN_MESSENGER), burnAmount);
        TOKEN_MESSENGER.depositForBurn(
            burnAmount,
            ARBITRUM_DOMAIN,
            bytes32(uint256(uint160(authorization.merchant))),
            address(USDC),
            ANY_DESTINATION_CALLER,
            authorization.maxCctpFee,
            authorization.minFinalityThreshold
        );

        emit CctpPaymentBurned(
            authorization.intentId,
            authorization.attemptId,
            authorization.payer,
            authorization.merchant,
            authorization.settlementChainId,
            authorization.destinationDomain,
            authorization.settlementAmount,
            authorization.grossPayerAmount,
            authorization.platformFee,
            burnAmount,
            authorization.maxCctpFee,
            authorization.minFinalityThreshold,
            authorization.metadataHash
        );
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function _validateAuthorization(CctpPaymentAuthorization calldata authorization, bytes calldata signature)
        private
        view
        returns (uint256 burnAmount)
    {
        if (authorization.intentId == bytes32(0)) revert ParmeliaCctpPaymentRouter__InvalidIntentId();
        if (authorization.attemptId == bytes32(0)) revert ParmeliaCctpPaymentRouter__InvalidAttemptId();
        if (authorization.payer == address(0)) revert ParmeliaCctpPaymentRouter__InvalidPayer();
        if (authorization.merchant == address(0)) revert ParmeliaCctpPaymentRouter__InvalidMerchant();
        if (authorization.settlementAmount == 0 || authorization.grossPayerAmount == 0) {
            revert ParmeliaCctpPaymentRouter__InvalidAmount();
        }
        if (authorization.validUntil == 0 || authorization.validAfter > authorization.validUntil) {
            revert ParmeliaCctpPaymentRouter__InvalidAuthorizationWindow();
        }
        if (msg.sender != authorization.payer) {
            revert ParmeliaCctpPaymentRouter__UnauthorizedPayer(msg.sender, authorization.payer);
        }
        if (
            authorization.settlementChainId != SETTLEMENT_CHAIN_ID
                || authorization.destinationDomain != ARBITRUM_DOMAIN
        ) {
            revert ParmeliaCctpPaymentRouter__InvalidDestination(
                authorization.settlementChainId, authorization.destinationDomain
            );
        }
        if (
            authorization.minFinalityThreshold != FAST_FINALITY
                && authorization.minFinalityThreshold != STANDARD_FINALITY
        ) {
            revert ParmeliaCctpPaymentRouter__InvalidFinalityThreshold(
                authorization.minFinalityThreshold
            );
        }
        if (authorization.minFinalityThreshold == FAST_FINALITY && !FAST_TRANSFER_ENABLED) {
            revert ParmeliaCctpPaymentRouter__FastTransferUnavailable();
        }
        if (block.timestamp < authorization.validAfter) {
            revert ParmeliaCctpPaymentRouter__AuthorizationNotActive(authorization.validAfter);
        }
        if (block.timestamp > authorization.validUntil) {
            revert ParmeliaCctpPaymentRouter__AuthorizationExpired(authorization.validUntil);
        }

        uint256 maximumPlatformFee =
            Math.mulDiv(authorization.settlementAmount, MAX_PLATFORM_FEE_BPS, BPS_DENOMINATOR);
        if (authorization.platformFee > maximumPlatformFee) {
            revert ParmeliaCctpPaymentRouter__PlatformFeeTooHigh(
                authorization.platformFee, maximumPlatformFee
            );
        }
        if (authorization.platformFee >= authorization.grossPayerAmount) {
            revert ParmeliaCctpPaymentRouter__InvalidAmount();
        }
        burnAmount = authorization.grossPayerAmount - authorization.platformFee;
        if (authorization.maxCctpFee >= burnAmount) {
            revert ParmeliaCctpPaymentRouter__CctpFeeTooHigh(authorization.maxCctpFee, burnAmount);
        }
        uint256 guaranteedSettlement = burnAmount - authorization.maxCctpFee;
        if (guaranteedSettlement < authorization.settlementAmount) {
            revert ParmeliaCctpPaymentRouter__SettlementAmountNotGuaranteed(
                authorization.settlementAmount, guaranteedSettlement
            );
        }
        if (usedAttempt[authorization.attemptId]) {
            revert ParmeliaCctpPaymentRouter__AttemptAlreadyUsed(authorization.attemptId);
        }
        if (paidIntent[authorization.intentId]) {
            revert ParmeliaCctpPaymentRouter__IntentAlreadyPaid(authorization.intentId);
        }

        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecoverCalldata(_authorizationDigest(authorization), signature);
        if (error != ECDSA.RecoverError.NoError || recovered != authorizationSigner) {
            revert ParmeliaCctpPaymentRouter__InvalidAuthorization();
        }
    }

    function _authorizationDigest(CctpPaymentAuthorization calldata authorization)
        private
        view
        returns (bytes32 digest)
    {
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 structHash = keccak256(
            abi.encode(
                CCTP_PAYMENT_AUTHORIZATION_TYPEHASH,
                authorization.intentId,
                authorization.attemptId,
                authorization.payer,
                authorization.merchant,
                authorization.settlementChainId,
                authorization.destinationDomain,
                authorization.settlementAmount,
                authorization.grossPayerAmount,
                authorization.platformFee,
                authorization.maxCctpFee,
                authorization.minFinalityThreshold,
                authorization.validAfter,
                authorization.validUntil,
                authorization.metadataHash
            )
        );
        digest = _hashTypedDataV4(structHash);
    }
}
