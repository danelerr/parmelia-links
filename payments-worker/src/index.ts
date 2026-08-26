import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { isHash, keccak256, toBytes } from "viem";
import {
	ERR,
	PAYMENTS_CONTRACT_VERSION,
	isAppServiceClaim,
	isSupportedPaymentsContractVersion,
	type RegisterAppPaymentExecutionCommand,
	type RegisterAppPaymentExecutionCommandV1,
	type RegisteredAppPaymentExecution,
	type PaymentsRpcService,
	type ReserveAppPaymentAttemptCommand,
	type ReserveAppPaymentAttemptCommandV1,
	type ReservedAppPaymentAttempt,
	type RpcResult,
	type SettlementAccountCommand,
	type SettlementAccountCommandV1,
	type SettlementAccountResult,
} from "../../shared";
import type { Bindings } from "./env";
import { authMiddleware, type PaymentsContext } from "./middlewares/auth";
import linksRoutes from "./routes/links.routes";
import checkoutRoutes from "./routes/checkout.routes";
import v1Routes from "./routes/v1.routes";
import merchantRoutes from "./routes/merchant.routes";
import { amount, DomainValidationError, walletAddress } from "./domain/validation";
import {
	getActiveAttempt,
	getAttemptByIdempotency,
	getIntentByLink,
	getPaymentLink,
	insertQuoteAndAttempt,
	registerAppExecution,
	releaseExpiredPayerDefinedAmount,
	upsertSettlementAccount as persistSettlementAccount,
} from "./repositories/payments";
import { authorizeAttempt, buildQuote, QuoteError } from "./services/quoteEngine";
import { consumePaymentsWorkerQueue, enqueuePaymentJob } from "./services/jobs";
import { flushPaymentOutbox } from "./services/queue";
import { PaymentJobScheduler } from "./services/jobScheduler";
import { logError, logInfo, requestId } from "./services/logger";
import { validatePaymentFeePolicyConfig } from "./services/feePolicy";
import { collectPaymentRouterHealth, validatePaymentRouterPreflightConfig } from "./services/routerHealth";
import { paymentModeCapabilities } from "./services/capabilities";
import { paymentsBootstrapState } from "./services/bootstrap";
import { paymentsDataCutoverState, paymentsWriteAvailability } from "./services/dataCutover";
import { rotateWebhookEncryptionBatch, validateWebhookEncryptionConfig } from "./repositories/merchant";
import {
	cleanupExpiredRateLimits,
	listActivePaymentChainIds,
	paymentDatabaseAvailable,
	paymentOpsCounts,
} from "./stores/opsStore";

const app = new Hono<PaymentsContext>();
const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function equalDigest(left: ArrayBuffer, right: ArrayBuffer): boolean {
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	let mismatch = 0;
	for (let index = 0; index < leftBytes.byteLength; index += 1) {
		mismatch |= leftBytes[index] ^ rightBytes[index];
	}
	return mismatch === 0;
}

async function validOpsHealthToken(provided: string | undefined, expected: string | undefined): Promise<boolean> {
	if (!provided || !expected || expected.length < 32) return false;
	const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
	return equalDigest(providedHash, expectedHash);
}

app.use("*", secureHeaders({
	contentSecurityPolicy: { defaultSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] },
	crossOriginOpenerPolicy: false,
	crossOriginResourcePolicy: "cross-origin",
	permissionsPolicy: { camera: false, geolocation: false, microphone: false, payment: false, usb: false },
	referrerPolicy: "no-referrer",
	strictTransportSecurity: "max-age=31536000; includeSubDomains",
	xFrameOptions: "DENY",
}));
app.use("*", async (c, next) => {
	const startedAt = Date.now();
	const id = requestId(c.req.raw);
	c.set("requestId", id);
	await next();
	c.header("X-Request-Id", id);
	logInfo("payments_http_completed", { requestId: id, method: c.req.method,
		path: new URL(c.req.url).pathname, status: c.res.status, durationMs: Date.now() - startedAt });
});
app.use("*", cors({
	origin: (origin, c) => {
		const allowed = c.env.ALLOWED_ORIGINS?.split(",").map((value: string) => value.trim()).filter(Boolean) ?? [];
		return allowed.includes(origin) ? origin : null;
	},
	allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "Idempotency-Key", "X-Request-Id",
		"X-GatoPago-Checkout-Capability"],
	exposeHeaders: ["X-Request-Id"],
}));
app.use("*", bodyLimit({ maxSize: 64 * 1024,
	onError: (c) => c.json({ error: "Request body too large", error_code: ERR.PAYLOAD_TOO_LARGE, requestId: c.get("requestId") }, 413) }));
app.use("*", async (c, next) => {
	if (MUTATING_HTTP_METHODS.has(c.req.method.toUpperCase())) {
		const availability = await paymentsWriteAvailability(c.env);
		if (availability.available) {
			await next();
			return;
		}
		c.header("Cache-Control", "no-store");
		c.header("Retry-After", "60");
		return c.json({ error: availability.bootstrap.active
			? "Payments is in controlled bootstrap mode"
			: "Payments data cutover is not verified",
			error_code: ERR.SERVICE_UNAVAILABLE, requestId: c.get("requestId"),
			gate: availability.bootstrap.active ? "bootstrap" : "data_cutover",
			retryable: true }, 503);
	}
	await next();
});
app.use("*", authMiddleware);

app.get("/health/live", (c) => {
	const bootstrap = paymentsBootstrapState(c.env);
	c.header("Cache-Control", "no-store");
	return c.json({ status: "ok", service: "gatopago-payments-api",
		bootstrapActive: bootstrap.active, bootstrapConfigValid: bootstrap.valid });
});
app.get("/health", async (c) => {
	const bootstrap = paymentsBootstrapState(c.env);
	const [databaseAvailable, dataCutover] = await Promise.all([
		paymentDatabaseAvailable(c.env),
		paymentsDataCutoverState(c.env),
	]);
	const database = databaseAvailable ? "ok" : "error";
	const signer = /^(?:0x)?[0-9a-fA-F]{64}$/u.test(c.env.PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY ?? "");
	const queue = !!c.env.PAYMENT_JOBS_QUEUE;
	const scheduler = !!c.env.PAYMENT_JOB_SCHEDULER;
	const feePolicyIssues = validatePaymentFeePolicyConfig(c.env);
	const preflightConfigIssues = validatePaymentRouterPreflightConfig(c.env);
	const webhookEncryptionIssues = validateWebhookEncryptionConfig(c.env);
	const router = await collectPaymentRouterHealth(c.env);
	const capabilities = paymentModeCapabilities(c.env);
	const ready = !bootstrap.active && bootstrap.valid && dataCutover.ready && database === "ok" && signer && queue && scheduler && feePolicyIssues.length === 0 &&
		preflightConfigIssues.length === 0 && webhookEncryptionIssues.length === 0 && router.status !== "error";
	const degraded = ready && router.status === "degraded";
	c.header("Cache-Control", "no-store");
	return c.json({ status: ready && !degraded ? "ready" : "degraded", service: "gatopago-payments-api",
		checks: { database, authorizationSigner: signer ? "configured" : "missing",
			queue: queue ? "configured" : "missing", scheduler: scheduler ? "configured" : "missing",
			bootstrap: bootstrap.active ? "active" : bootstrap.valid ? "inactive" : "invalid",
			dataCutover: dataCutover.status,
			feePolicy: feePolicyIssues.length === 0 ? "valid" : "invalid",
			webhookEncryption: webhookEncryptionIssues.length === 0 ? "valid" : "invalid",
			routerPreflight: router.status, routerConfig: preflightConfigIssues.length === 0 ? "valid" : "invalid" },
		capabilities }, ready ? 200 : 503);
});
app.get("/health/ops", async (c) => {
	if (!(await validOpsHealthToken(c.req.header("X-Ops-Token"), c.env.OPS_HEALTH_TOKEN))) {
		return c.json({ error: "Not found" }, 404);
	}
	const counts = await paymentOpsCounts(c.env);
	const router = await collectPaymentRouterHealth(c.env);
	const feePolicyIssues = validatePaymentFeePolicyConfig(c.env);
	const routerConfigIssues = validatePaymentRouterPreflightConfig(c.env);
	const webhookEncryptionIssues = validateWebhookEncryptionConfig(c.env);
	const capabilities = paymentModeCapabilities(c.env);
	const bootstrap = paymentsBootstrapState(c.env);
	const dataCutover = await paymentsDataCutoverState(c.env);
	const unavailable = bootstrap.active || !bootstrap.valid || router.status === "error" ||
		!dataCutover.ready || feePolicyIssues.length > 0 || routerConfigIssues.length > 0 || webhookEncryptionIssues.length > 0;
	const degraded = unavailable || router.status === "degraded";
	return c.json({ status: degraded ? "degraded" : "ok",
		service: "gatopago-payments-api", counts, router,
		configuration: { bootstrap, dataCutover, feePolicyIssues, routerConfigIssues, webhookEncryptionIssues, capabilities } }, unavailable ? 503 : 200);
});
app.get("/", (c) => c.text("GatoPago Payments API"));
app.route("/links", linksRoutes);
app.route("/checkout", checkoutRoutes);
app.route("/v1", v1Routes);
app.route("/merchant", merchantRoutes);

app.onError((error, c) => {
	if (error instanceof DomainValidationError) return c.json({ error: error.message, error_code: error.code, requestId: c.get("requestId") }, 400);
	if (error instanceof QuoteError) {
		const status = error.code === "SIGNER_UNAVAILABLE" || error.code === "FEE_UNAVAILABLE" ||
			error.code === "ROUTER_FEE_CAP_EXCEEDED" || error.code === "ROUTER_PREFLIGHT_REQUIRED" ||
			error.code === "ROUTER_PREFLIGHT_FAILED" ? 503 : error.code.startsWith("INTENT_") ? 409 : 400;
		return c.json({ error: error.message, error_code: error.code, requestId: c.get("requestId") }, status as 400);
	}
	logError("payments_unhandled_error", error, { requestId: c.get("requestId"), path: new URL(c.req.url).pathname });
	return c.json({ error: "Internal server error", error_code: ERR.SERVER_ERROR, requestId: c.get("requestId") }, 500);
});

function rpcError<T>(error: "INVALID_CONTRACT" | "INVALID_CLAIM" | "INVALID_COMMAND" | "NOT_FOUND" | "CONFLICT" | "UNAVAILABLE", message: string): RpcResult<T> {
	return { ok: false, contractVersion: 2, error, message };
}

function normalizeSettlementCommand(command: SettlementAccountCommand | SettlementAccountCommandV1, env: Bindings): SettlementAccountCommand | null {
	if (!isSupportedPaymentsContractVersion(command?.contractVersion) || !isAppServiceClaim(command.claim)) return null;
	if (command.contractVersion === 2) return command;
	return { ...command, contractVersion: 2, commandId: `legacy:${keccak256(toBytes(JSON.stringify(command)))}`,
		chainId: Number(env.SETTLEMENT_CHAIN_ID) };
}

function normalizeReserveCommand(command: ReserveAppPaymentAttemptCommand | ReserveAppPaymentAttemptCommandV1, env: Bindings): ReserveAppPaymentAttemptCommand | null {
	if (!isSupportedPaymentsContractVersion(command?.contractVersion) || !isAppServiceClaim(command.claim)) return null;
	if (command.contractVersion === 2) return command;
	return { ...command, contractVersion: 2, commandId: `legacy:${keccak256(toBytes(JSON.stringify(command)))}`,
		sourceChainId: Number(env.SETTLEMENT_CHAIN_ID), requestedRoute: "local" };
}

function normalizeRegisterCommand(command: RegisterAppPaymentExecutionCommand | RegisterAppPaymentExecutionCommandV1, env: Bindings): RegisterAppPaymentExecutionCommand | null {
	if (!isSupportedPaymentsContractVersion(command?.contractVersion) || !isAppServiceClaim(command.claim)) return null;
	if (command.contractVersion === 2) return command;
	return { ...command, contractVersion: 2, commandId: `legacy:${keccak256(toBytes(JSON.stringify(command)))}`,
		sourceChainId: Number(env.SETTLEMENT_CHAIN_ID) };
}

export default class PaymentsWorker extends WorkerEntrypoint<Bindings> implements PaymentsRpcService {
	override fetch(request: Request): Promise<Response> {
		return Promise.resolve(app.fetch(request, this.env, this.ctx));
	}

	contractVersion(): number {
		return PAYMENTS_CONTRACT_VERSION;
	}

	async upsertSettlementAccount(command: SettlementAccountCommand | SettlementAccountCommandV1): Promise<RpcResult<SettlementAccountResult>> {
		if (!(await paymentsWriteAvailability(this.env)).available) {
			return rpcError("UNAVAILABLE", "Payments writes have not been activated");
		}
		const normalized = normalizeSettlementCommand(command, this.env);
		if (!normalized) return rpcError("INVALID_CONTRACT", "Unsupported or malformed settlement account command");
		try {
			if (!Number.isSafeInteger(normalized.accountVersion) || normalized.accountVersion < 1 || !Number.isSafeInteger(normalized.chainId)) return rpcError("INVALID_COMMAND", "Invalid account version or chain");
			const value = await persistSettlementAccount(this.env, { commandId: normalized.commandId,
				ownerUid: normalized.claim.uid, accountVersion: normalized.accountVersion,
				walletAddress: walletAddress(normalized.walletAddress), chainId: normalized.chainId });
			return { ok: true, contractVersion: 2, value };
		} catch (error) {
			logError("payments_rpc_settlement_account_failed", error, { requestId: normalized.claim.requestId });
			return rpcError("INVALID_COMMAND", error instanceof Error ? error.message : "Invalid command");
		}
	}

	async reserveAppPaymentAttempt(command: ReserveAppPaymentAttemptCommand | ReserveAppPaymentAttemptCommandV1): Promise<RpcResult<ReservedAppPaymentAttempt>> {
		if (!(await paymentsWriteAvailability(this.env)).available) {
			return rpcError("UNAVAILABLE", "Payments writes have not been activated");
		}
		const normalized = normalizeReserveCommand(command, this.env);
		if (!normalized) return rpcError("INVALID_CONTRACT", "Unsupported or malformed attempt command");
		try {
			const link = await getPaymentLink(this.env, normalized.linkId);
			const initialIntent = link ? await getIntentByLink(this.env, link.id) : null;
			if (!link || !initialIntent) return rpcError("NOT_FOUND", "Payment link not found");
			const payer = walletAddress(normalized.payerAddress);
			const replay = await getAttemptByIdempotency(this.env, { intentId: initialIntent.id, payerAddress: payer,
				sourceChainId: normalized.sourceChainId, idempotencyKey: normalized.commandId });
			if (!replay) await releaseExpiredPayerDefinedAmount(this.env, initialIntent.id);
			const intent = await getIntentByLink(this.env, link.id);
			if (!intent) return rpcError("NOT_FOUND", "Payment intent not found");
			const active = replay ?? await getActiveAttempt(this.env, intent.id);
			if (active && !replay) return rpcError("CONFLICT", "Another payment attempt is active");
			const attempt = active ?? await (async () => {
				const effectiveIntent = intent.amountMode === "payer_defined"
					? (() => {
						const selected = amount(normalized.amount);
						return { ...intent, amount: selected.decimal, amountAtomic: selected.atomic };
					})()
					: intent;
				const quote = await buildQuote(this.env, { intent: effectiveIntent, payer,
					sourceChainId: normalized.sourceChainId, requestedRoute: "auto" });
				if (quote.route !== "local") throw new QuoteError("ROUTE_UNAVAILABLE", "GatoPago balance execution must use the local router");
				const authorized = await authorizeAttempt(this.env, { intent: effectiveIntent, quote, payerUid: normalized.claim.uid });
				return insertQuoteAndAttempt(this.env, { quote, attempt: authorized, idempotencyKey: normalized.commandId });
			})();
			return { ok: true, contractVersion: 2, value: {
				attemptId: attempt.id, intentId: intent.id, linkId: link.id, merchant: intent.settlementWallet,
				amount: intent.amount, currency: "USDC", sourceChainId: attempt.sourceChainId,
				router: attempt.routerAddress, authorization: attempt.authorization as ReservedAppPaymentAttempt["authorization"],
				signature: attempt.signature, authorizationHash: attempt.authorizationHash,
				expiresAt: attempt.expiresAt,
			} };
		} catch (error) {
			logError("payments_rpc_attempt_reserve_failed", error, { requestId: normalized.claim.requestId });
			return error instanceof QuoteError ? rpcError(error.code === "SIGNER_UNAVAILABLE" ? "UNAVAILABLE" : "CONFLICT", error.message) : rpcError("INVALID_COMMAND", error instanceof Error ? error.message : "Invalid command");
		}
	}

	async registerAppPaymentExecution(command: RegisterAppPaymentExecutionCommand | RegisterAppPaymentExecutionCommandV1): Promise<RpcResult<RegisteredAppPaymentExecution>> {
		if (!(await paymentsWriteAvailability(this.env)).available) {
			return rpcError<RegisteredAppPaymentExecution>("UNAVAILABLE", "Payments writes have not been activated");
		}
		const normalized = normalizeRegisterCommand(command, this.env);
		if (!normalized) return rpcError<RegisteredAppPaymentExecution>("INVALID_CONTRACT", "Unsupported or malformed execution command");
		if (!isHash(normalized.userOpHash)) return rpcError<RegisteredAppPaymentExecution>("INVALID_COMMAND", "Invalid UserOperation hash");
		const value = await registerAppExecution(this.env, normalized);
		if (!value) return rpcError<RegisteredAppPaymentExecution>("CONFLICT", "Attempt and execution do not match");
		await enqueuePaymentJob(this.env, { job: "attempt_reconcile", resourceId: value.attemptId,
			dedupeKey: `app-execution:${value.attemptId}:${value.userOpHash}`, partition: String(normalized.sourceChainId) });
		await enqueuePaymentJob(this.env, { job: "router_watch", resourceId: value.attemptId,
			dedupeKey: `app-router-watch:${value.attemptId}:${value.userOpHash}`, partition: String(normalized.sourceChainId) });
		return { ok: true, contractVersion: 2, value };
	}

	override async queue(batch: MessageBatch<unknown>): Promise<void> {
		const availability = await paymentsWriteAvailability(this.env);
		if (!availability.available) {
			logError("payments_queue_blocked_by_write_gate", new Error("Payments writes are unavailable"), {
				queue: batch.queue, reason: availability.reason,
			});
			batch.retryAll({ delaySeconds: 900 });
			return;
		}
		await consumePaymentsWorkerQueue(batch, this.env);
	}

	override async scheduled(): Promise<void> {
		if (!(await paymentsWriteAvailability(this.env)).available) return;
		await flushPaymentOutbox(this.env);
		const webhookEncryptionIssues = validateWebhookEncryptionConfig(this.env);
		if (webhookEncryptionIssues.length === 0) {
			try {
				const rotation = await rotateWebhookEncryptionBatch(this.env, 25);
				if (rotation.rotated > 0) logInfo("webhook_encryption_keys_rotated", rotation);
			} catch (error) {
				logError("webhook_encryption_rotation_failed", error, {});
			}
		} else {
			logError("webhook_encryption_rotation_blocked", new Error(webhookEncryptionIssues.join("; ")), {});
		}
		await cleanupExpiredRateLimits(this.env, Math.floor(Date.now() / 1_000) - 86_400);
		const activeChainIds = await listActivePaymentChainIds(this.env);
		const minute = Math.floor(Date.now() / 60_000);
		for (const chainId of activeChainIds) {
			await enqueuePaymentJob(this.env, { job: "router_watch", resourceId: String(chainId),
				dedupeKey: `scheduled-router-watch:${chainId}:${minute}`, partition: String(chainId) });
		}
	}
}

export { PaymentJobScheduler };
export const __test = { normalizeSettlementCommand, normalizeReserveCommand, normalizeRegisterCommand,
	paymentsBootstrapState };
