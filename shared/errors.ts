// ============================================================================
// API error contract — stable, language-independent error codes.
// ============================================================================
//
// Every error response from the API carries:
//   { error: "<human message, for logs/back-compat>",
//     error_code: "<STABLE_CODE>",        // this file
//     requestId: "<correlation id>" }
//   with an HTTP status that follows REST semantics (see ERROR_HTTP_STATUS).
//
// The client never parses the human `error` text: it maps `error_code` to a
// localized string (t("err." + code)). Adding a code is additive — a response
// without `error_code` still works (the client falls back to the server text).
//
// HTTP status conventions used here (RFC 9110):
//   400 Bad Request          — malformed / invalid / missing input.
//   401 Unauthorized         — missing/invalid credentials on the /v1 API (sk_ key).
//   403 Forbidden            — caller is known but not allowed (or failed a gate).
//   404 Not Found            — the addressed resource doesn't exist.
//   409 Conflict             — request conflicts with the resource's current state.
//   500 Internal Server Error— unexpected failure on our side / on-chain revert.
//
// The app's Firebase-JWT middleware returns a bare 401 (the app shows a generic
// "session expired"); the machine-to-machine /v1 API returns 401 WITH a code so
// integrators can tell apart missing vs invalid/revoked keys. 402/422 are
// intentionally not used yet: business-rule violations (e.g.
// INSUFFICIENT_BALANCE) use 400 for broad proxy/tooling compatibility (422
// would be the stricter REST choice). 429 (RATE_LIMITED) backs the in-Worker
// fixed-window limiter on abuse-prone public endpoints; zone-level rules at the
// Cloudflare edge remain the heavy-duty layer when a domain is configured.
//
// When you add a code: (1) add it to ERR, (2) add its status to
// ERROR_HTTP_STATUS, (3) add the `err.<CODE>` key in client/src/locales/{es,en}.json,
// (4) document it in docs/reference/error-codes.md. The server test `errors.test.ts` asserts (2).

export const ERR = {
	// ---- 400 Bad Request: invalid / missing / malformed input ----
	MISSING_PASSKEY_DATA: "MISSING_PASSKEY_DATA",
	INVALID_CALLDATA: "INVALID_CALLDATA",
	INVALID_WALLET: "INVALID_WALLET",
	INVALID_AMOUNT: "INVALID_AMOUNT",
	UNSUPPORTED_CURRENCY: "UNSUPPORTED_CURRENCY",
	INVALID_USERNAME: "INVALID_USERNAME",
	INVALID_CURSOR: "INVALID_CURSOR",
	INVALID_EMAIL: "INVALID_EMAIL",
	AUTH_CODE_INVALID: "AUTH_CODE_INVALID",
	WEBAUTHN_REGISTRATION_INVALID: "WEBAUTHN_REGISTRATION_INVALID",
	// display_name/social_url outside the accepted format (length, allowlist).
	INVALID_PROFILE: "INVALID_PROFILE",
	USERNAME_RESERVED: "USERNAME_RESERVED",
	INVALID_TOKEN: "INVALID_TOKEN",
	UNSUPPORTED_TOKEN: "UNSUPPORTED_TOKEN",
	SAME_TOKEN: "SAME_TOKEN",
	SLIPPAGE_OUT_OF_RANGE: "SLIPPAGE_OUT_OF_RANGE",
	QUOTE_MISSING: "QUOTE_MISSING",
	MISSING_CONTACT: "MISSING_CONTACT",
	CANNOT_ADD_SELF: "CANNOT_ADD_SELF",
	// ---- Payments API (/v1) ----
	METADATA_TOO_LARGE: "METADATA_TOO_LARGE",
	INVALID_EXPIRY: "INVALID_EXPIRY",
	ROUTER_DISABLED: "ROUTER_DISABLED",
	SANDBOX_ONLY: "SANDBOX_ONLY",
	INVALID_WEBHOOK_URL: "INVALID_WEBHOOK_URL",
	QUOTE_STALE: "QUOTE_STALE",
	CHAIN_DISABLED: "CHAIN_DISABLED",
	AUTHORIZATION_INVALID: "AUTHORIZATION_INVALID",
	// Business-rule violation (well-formed request, can't be fulfilled): 400.
	INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
	// Feature gated off for the active network config: 400.
	SWAPS_DISABLED: "SWAPS_DISABLED",
	BRIDGE_DISABLED: "BRIDGE_DISABLED",
	EARN_DISABLED: "EARN_DISABLED",
	UNSUPPORTED_CHAIN: "UNSUPPORTED_CHAIN",
	INVALID_RECIPIENT: "INVALID_RECIPIENT",
	// Precondition for an action: caller has no wallet yet. 400 on action
	// endpoints; the GET /user/balance resource lookup returns 404 instead.
	NO_WALLET: "NO_WALLET",
	// Missing WebAuthn signature payload on /pay/submit.
	MISSING_SIGNATURE_DATA: "MISSING_SIGNATURE_DATA",
	// Malformed tx hash (cross-chain inbound register).
	INVALID_TX_HASH: "INVALID_TX_HASH",
	// A checkout-reported transaction has not reached a source-chain receipt yet.
	// It is retryable and never changes the attempt state by itself.
	PAYMENT_EVIDENCE_PENDING: "PAYMENT_EVIDENCE_PENDING",
	// The source-chain receipt exists but does not prove the signed attempt.
	PAYMENT_EVIDENCE_INVALID: "PAYMENT_EVIDENCE_INVALID",
	// A cross-chain route exists but can't be offered right now (relayer gas
	// unverified/insufficient, route disabled). Retryable by the caller.
	CROSSCHAIN_UNAVAILABLE: "CROSSCHAIN_UNAVAILABLE",
	// Invalid bridge quote request (unsupported chain, amount out of range).
	BRIDGE_INVALID_REQUEST: "BRIDGE_INVALID_REQUEST",
	PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

	// ---- 401 Unauthorized ----
	// UNAUTHENTICATED is shared by the /v1 API-key auth AND the app's Firebase-JWT
	// middleware (missing/expired session), so both surfaces carry a stable code.
	UNAUTHENTICATED: "UNAUTHENTICATED",
	INVALID_API_KEY: "INVALID_API_KEY",

	// ---- 403 Forbidden: known caller, not allowed / failed a gate ----
	HUMAN_VERIFY_FAILED: "HUMAN_VERIFY_FAILED",
	QUOTE_WRONG_ACCOUNT: "QUOTE_WRONG_ACCOUNT",
	// The addressed resource (e.g. a pending payment) belongs to another account.
	WRONG_ACCOUNT: "WRONG_ACCOUNT",
	FAUCET_DISABLED: "FAUCET_DISABLED",
	AUTH_ACCOUNT_DISABLED: "AUTH_ACCOUNT_DISABLED",
	STEP_UP_REQUIRED: "STEP_UP_REQUIRED",
	STEP_UP_INVALID: "STEP_UP_INVALID",
	STEP_UP_UNAVAILABLE: "STEP_UP_UNAVAILABLE",

	// ---- 404 Not Found: addressed resource doesn't exist ----
	LINK_NOT_FOUND: "LINK_NOT_FOUND",
	USER_NOT_FOUND: "USER_NOT_FOUND",
	QUOTE_NOT_FOUND: "QUOTE_NOT_FOUND",
	INTENT_NOT_FOUND: "INTENT_NOT_FOUND",
	EVENT_NOT_FOUND: "EVENT_NOT_FOUND",
	OPERATION_NOT_FOUND: "OPERATION_NOT_FOUND",
	ATTEMPT_NOT_FOUND: "ATTEMPT_NOT_FOUND",
	PASSKEY_NOT_FOUND: "PASSKEY_NOT_FOUND",
	// The prepared UserOp to submit doesn't exist (expired or never prepared).
	PENDING_NOT_FOUND: "PENDING_NOT_FOUND",
	// No swap route for the pair. 404 when quoting; the same code is returned as
	// 409 from /swap/prepare when a previously-quoted route has since vanished.
	NO_ROUTE: "NO_ROUTE",

	// ---- 429 Too Many Requests ----
	RATE_LIMITED: "RATE_LIMITED",

	// ---- 409 Conflict: clashes with the resource's current state ----
	ACCOUNT_EXISTS: "ACCOUNT_EXISTS",
	USERNAME_TAKEN: "USERNAME_TAKEN",
	LINK_ALREADY_PAID: "LINK_ALREADY_PAID",
	FAUCET_ALREADY_CLAIMED: "FAUCET_ALREADY_CLAIMED",
	RECOVERY_IN_PROGRESS: "RECOVERY_IN_PROGRESS",
	RECOVERY_NONE: "RECOVERY_NONE",
	RECOVERY_NOT_READY: "RECOVERY_NOT_READY",
	// The credential sent to /recovery/execute is not the one proposed on-chain.
	RECOVERY_SIGNER_MISMATCH: "RECOVERY_SIGNER_MISMATCH",
	QUOTE_USED: "QUOTE_USED",
	QUOTE_EXPIRED: "QUOTE_EXPIRED",
	QUOTE_WRONG_NETWORK: "QUOTE_WRONG_NETWORK",
	PRICE_MOVED: "PRICE_MOVED",
	INTENT_NOT_PAYABLE: "INTENT_NOT_PAYABLE",
	// A burn tx hash was already registered for another cross-chain operation.
	TX_ALREADY_REGISTERED: "TX_ALREADY_REGISTERED",
	// The same prepared payment was already submitted (duplicate request).
	PAYMENT_IN_PROGRESS: "PAYMENT_IN_PROGRESS",
	ATTEMPT_ACTIVE: "ATTEMPT_ACTIVE",
	MERCHANT_NOT_CONFIGURED: "MERCHANT_NOT_CONFIGURED",
	LAST_PASSKEY: "LAST_PASSKEY",
	PASSKEY_ALREADY_REGISTERED: "PASSKEY_ALREADY_REGISTERED",

	// ---- 503 Service Unavailable: deployment configuration is incomplete ----
	SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
	FEE_UNAVAILABLE: "FEE_UNAVAILABLE",
	BUNDLER_UNAVAILABLE: "BUNDLER_UNAVAILABLE",
	BUNDLER_ENTRYPOINT_UNSUPPORTED: "BUNDLER_ENTRYPOINT_UNSUPPORTED",

	// ---- 500 Internal Server Error: our side / on-chain failure ----
	SERVER_ERROR: "SERVER_ERROR",
	PAYMENT_FAILED: "PAYMENT_FAILED",
	TX_REVERTED: "TX_REVERTED",
	INSUFFICIENT_GAS: "INSUFFICIENT_GAS",
	// The paymaster refused to sponsor (signer/deposit misconfiguration).
	PAYMASTER_REJECTED: "PAYMASTER_REJECTED",
	PAYMASTER_DEPOSIT_LOW: "PAYMASTER_DEPOSIT_LOW",
	// The active network config still has TODO_DEPLOY placeholders.
	CONTRACT_NOT_DEPLOYED: "CONTRACT_NOT_DEPLOYED",
	QUOTE_FAILED: "QUOTE_FAILED",
	SWAP_PREPARE_FAILED: "SWAP_PREPARE_FAILED",
	BRIDGE_QUOTE_FAILED: "BRIDGE_QUOTE_FAILED",
	CROSSCHAIN_PREPARE_FAILED: "CROSSCHAIN_PREPARE_FAILED",
	PASSKEY_MISMATCH: "PASSKEY_MISMATCH",
} as const;

export type ErrorCode = (typeof ERR)[keyof typeof ERR];

/**
 * Canonical HTTP status for each error code — the single source of truth for the
 * REST contract. Routes should return the mapped status. Two codes are
 * context-dependent and documented above (NO_WALLET, NO_ROUTE); the value here
 * is their primary status.
 */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
	// 400
	MISSING_PASSKEY_DATA: 400,
	INVALID_CALLDATA: 400,
	INVALID_WALLET: 400,
	INVALID_AMOUNT: 400,
	UNSUPPORTED_CURRENCY: 400,
	INVALID_USERNAME: 400,
	INVALID_CURSOR: 400,
	INVALID_EMAIL: 400,
	AUTH_CODE_INVALID: 400,
	WEBAUTHN_REGISTRATION_INVALID: 400,
	INVALID_PROFILE: 400,
	USERNAME_RESERVED: 400,
	INVALID_TOKEN: 400,
	UNSUPPORTED_TOKEN: 400,
	SAME_TOKEN: 400,
	SLIPPAGE_OUT_OF_RANGE: 400,
	QUOTE_MISSING: 400,
	MISSING_CONTACT: 400,
	CANNOT_ADD_SELF: 400,
	METADATA_TOO_LARGE: 400,
	INVALID_EXPIRY: 400,
	ROUTER_DISABLED: 400,
	SANDBOX_ONLY: 400,
	INVALID_WEBHOOK_URL: 400,
	QUOTE_STALE: 400,
	CHAIN_DISABLED: 400,
	AUTHORIZATION_INVALID: 400,
	INSUFFICIENT_BALANCE: 400,
	SWAPS_DISABLED: 400,
	BRIDGE_DISABLED: 400,
	EARN_DISABLED: 400,
	UNSUPPORTED_CHAIN: 400,
	INVALID_RECIPIENT: 400,
	NO_WALLET: 400,
	MISSING_SIGNATURE_DATA: 400,
	INVALID_TX_HASH: 400,
	PAYMENT_EVIDENCE_INVALID: 400,
	PAYMENT_EVIDENCE_PENDING: 409,
	CROSSCHAIN_UNAVAILABLE: 400,
	BRIDGE_INVALID_REQUEST: 400,
	PAYLOAD_TOO_LARGE: 413,
	// 401
	UNAUTHENTICATED: 401,
	INVALID_API_KEY: 401,
	// 403
	HUMAN_VERIFY_FAILED: 403,
	QUOTE_WRONG_ACCOUNT: 403,
	WRONG_ACCOUNT: 403,
	FAUCET_DISABLED: 403,
	AUTH_ACCOUNT_DISABLED: 403,
	STEP_UP_REQUIRED: 403,
	STEP_UP_INVALID: 403,
	STEP_UP_UNAVAILABLE: 403,
	// 404
	LINK_NOT_FOUND: 404,
	USER_NOT_FOUND: 404,
	QUOTE_NOT_FOUND: 404,
	INTENT_NOT_FOUND: 404,
	EVENT_NOT_FOUND: 404,
	OPERATION_NOT_FOUND: 404,
	ATTEMPT_NOT_FOUND: 404,
	PASSKEY_NOT_FOUND: 404,
	PENDING_NOT_FOUND: 404,
	NO_ROUTE: 404,
	// 409
	ACCOUNT_EXISTS: 409,
	USERNAME_TAKEN: 409,
	LINK_ALREADY_PAID: 409,
	FAUCET_ALREADY_CLAIMED: 409,
	RECOVERY_IN_PROGRESS: 409,
	RECOVERY_NONE: 409,
	RECOVERY_NOT_READY: 409,
	RECOVERY_SIGNER_MISMATCH: 409,
	QUOTE_USED: 409,
	QUOTE_EXPIRED: 409,
	QUOTE_WRONG_NETWORK: 409,
	PRICE_MOVED: 409,
	INTENT_NOT_PAYABLE: 409,
	TX_ALREADY_REGISTERED: 409,
	PAYMENT_IN_PROGRESS: 409,
	ATTEMPT_ACTIVE: 409,
	MERCHANT_NOT_CONFIGURED: 409,
	LAST_PASSKEY: 409,
	PASSKEY_ALREADY_REGISTERED: 409,
	// 429
	RATE_LIMITED: 429,
	// 500
	SERVER_ERROR: 500,
	PAYMENT_FAILED: 500,
	TX_REVERTED: 500,
	INSUFFICIENT_GAS: 500,
	PAYMASTER_REJECTED: 500,
	PAYMASTER_DEPOSIT_LOW: 500,
	CONTRACT_NOT_DEPLOYED: 500,
	QUOTE_FAILED: 500,
	SWAP_PREPARE_FAILED: 500,
	BRIDGE_QUOTE_FAILED: 500,
	CROSSCHAIN_PREPARE_FAILED: 500,
	PASSKEY_MISMATCH: 500,
	// 503
	SERVICE_UNAVAILABLE: 503,
	FEE_UNAVAILABLE: 503,
	BUNDLER_UNAVAILABLE: 503,
	BUNDLER_ENTRYPOINT_UNSUPPORTED: 503,
};
