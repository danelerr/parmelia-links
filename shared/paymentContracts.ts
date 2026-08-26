/**
 * Versioned contracts crossing the App/Payments Worker boundary.
 *
 * Keep this module data-only: no bindings, handlers, storage, clocks or secrets.
 * Version 2 is current; parsers deliberately accept N-1 during the Phase 2
 * migration so receiver-first deploys remain safe.
 */
export const PAYMENTS_CONTRACT_VERSION = 2 as const;
export const PAYMENTS_PREVIOUS_CONTRACT_VERSION = 1 as const;
export const PAYMENT_JOB_MESSAGE_VERSION = 2 as const;
export const PAYMENT_JOB_PREVIOUS_MESSAGE_VERSION = 1 as const;

export type AppServiceClaim = {
	service: "gatopago-app-api";
	requestId: string;
	uid: string;
};

export type SettlementAccountCommandV1 = {
	contractVersion: 1;
	claim: AppServiceClaim;
	accountVersion: number;
	walletAddress: string;
};

export type SettlementAccountCommand = {
	contractVersion: 2;
	commandId: string;
	claim: AppServiceClaim;
	accountVersion: number;
	walletAddress: string;
	chainId: number;
};

export type ReserveAppPaymentAttemptCommandV1 = {
	contractVersion: 1;
	claim: AppServiceClaim;
	linkId: string;
	payerAddress: string;
};

export type ReserveAppPaymentAttemptCommand = {
	contractVersion: 2;
	commandId: string;
	claim: AppServiceClaim;
	linkId: string;
	payerAddress: string;
	sourceChainId: number;
	requestedRoute: "local";
	/** Required only when the checkout link lets the payer choose the amount. */
	amount?: string;
};

export type RegisterAppPaymentExecutionCommandV1 = {
	contractVersion: 1;
	claim: AppServiceClaim;
	attemptId: string;
	userOpHash: string;
};

export type RegisterAppPaymentExecutionCommand = {
	contractVersion: 2;
	commandId: string;
	claim: AppServiceClaim;
	attemptId: string;
	userOpHash: string;
	sourceChainId: number;
};

export type RpcErrorCode =
	| "INVALID_CONTRACT"
	| "INVALID_CLAIM"
	| "INVALID_COMMAND"
	| "NOT_FOUND"
	| "CONFLICT"
	| "UNAVAILABLE";

export type RpcResult<T> =
	| { ok: true; contractVersion: 2; value: T }
	| { ok: false; contractVersion: 2; error: RpcErrorCode; message: string };

export type SettlementAccountResult = {
	merchantId: string;
	accountVersion: number;
	applied: boolean;
};

export type SerializedPaymentAuthorization = {
	intentId: `0x${string}`;
	attemptId: `0x${string}`;
	payer: `0x${string}`;
	merchant: `0x${string}`;
	settlementAmount: string;
	platformFee: string;
	validAfter: number;
	validUntil: number;
	metadataHash: `0x${string}`;
};

export type ReservedAppPaymentAttempt = {
	attemptId: string;
	intentId: string;
	linkId: string;
	merchant: `0x${string}`;
	amount: string;
	currency: "USDC";
	sourceChainId: number;
	router: `0x${string}`;
	authorization: SerializedPaymentAuthorization;
	signature: `0x${string}`;
	authorizationHash: `0x${string}`;
	expiresAt: string;
};

export type RegisteredAppPaymentExecution = {
	attemptId: string;
	status: "submitted" | "processing" | "paid";
	userOpHash: string;
	idempotentReplay: boolean;
};

/**
 * Typed, versioned RPC surface exposed by the Payments Worker to the App
 * Worker. It deliberately contains methods and serializable values only, so
 * both Workers compile against one contract without importing either
 * implementation or any Cloudflare binding type.
 */
export interface PaymentsRpcService {
	contractVersion(): number | Promise<number>;
	upsertSettlementAccount(
		command: SettlementAccountCommand | SettlementAccountCommandV1,
	): Promise<RpcResult<SettlementAccountResult>>;
	reserveAppPaymentAttempt(
		command: ReserveAppPaymentAttemptCommand | ReserveAppPaymentAttemptCommandV1,
	): Promise<RpcResult<ReservedAppPaymentAttempt>>;
	registerAppPaymentExecution(
		command: RegisterAppPaymentExecutionCommand | RegisterAppPaymentExecutionCommandV1,
	): Promise<RpcResult<RegisteredAppPaymentExecution>>;
}

export type PaymentJobName =
	| "attempt_reconcile"
	| "cctp_attestation"
	| "cctp_mint"
	| "router_watch"
	| "webhook_delivery";

export type PaymentJobMessageV1 = {
	messageVersion: 1;
	job: PaymentJobName;
	jobId: string;
	resourceId: string;
	createdAt: string;
};

export type PaymentJobMessage = {
	messageVersion: 2;
	job: PaymentJobName;
	jobId: string;
	dedupeKey: string;
	resourceId: string;
	partition: string;
	attempt: number;
	createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function safeDate(value: unknown): string | null {
	const text = safeText(value, 64);
	return text && Number.isFinite(Date.parse(text)) ? text : null;
}

const PAYMENT_JOB_NAMES = new Set<PaymentJobName>([
	"attempt_reconcile",
	"cctp_attestation",
	"cctp_mint",
	"router_watch",
	"webhook_delivery",
]);

export function parsePaymentJobMessage(value: unknown): PaymentJobMessage | null {
	if (!isRecord(value)) return null;
	const job = value.job;
	if (typeof job !== "string" || !PAYMENT_JOB_NAMES.has(job as PaymentJobName)) return null;
	const jobId = safeText(value.jobId, 160);
	const resourceId = safeText(value.resourceId, 160);
	const createdAt = safeDate(value.createdAt);
	if (!jobId || !resourceId || !createdAt) return null;

	if (value.messageVersion === 1) {
		return {
			messageVersion: 2,
			job: job as PaymentJobName,
			jobId,
			dedupeKey: jobId,
			resourceId,
			partition: "legacy",
			attempt: 0,
			createdAt,
		};
	}
	if (value.messageVersion !== 2) return null;
	const dedupeKey = safeText(value.dedupeKey, 200);
	const partition = safeText(value.partition, 160);
	if (
		!dedupeKey ||
		!partition ||
		typeof value.attempt !== "number" ||
		!Number.isSafeInteger(value.attempt) ||
		value.attempt < 0
	) return null;
	return {
		messageVersion: 2,
		job: job as PaymentJobName,
		jobId,
		dedupeKey,
		resourceId,
		partition,
		attempt: value.attempt,
		createdAt,
	};
}

export function isAppServiceClaim(value: unknown): value is AppServiceClaim {
	if (!isRecord(value)) return false;
	return value.service === "gatopago-app-api" &&
		!!safeText(value.requestId, 160) &&
		!!safeText(value.uid, 256);
}

export function isSupportedPaymentsContractVersion(value: unknown): value is 1 | 2 {
	return value === PAYMENTS_CONTRACT_VERSION || value === PAYMENTS_PREVIOUS_CONTRACT_VERSION;
}
