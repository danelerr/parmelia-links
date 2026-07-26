import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { AppContext, authMiddleware, type Bindings } from "./middlewares/auth";
import { hasAccountOperationNeedsReview } from "./services/storage";
import { getRequestId, logError, logInfo, logWarn } from "./services/logger";
import {
	consumeWorkerQueue,
	recoverEventJobs,
	type WorkerQueueMessage,
	wakeUserEventDeliveryIfPending,
} from "./services/eventJobs";
import {
	EventJobScheduler,
} from "./services/eventScheduler";
import { RpcAdmissionController } from "./services/rpcAdmission";
import { validateRuntimeConfig } from "./services/runtimeConfig";
import { ERR, getNetworkConfig, isSupportedChainKey } from "../../shared";

import userRoutes from "./routes/user.routes";
import accountRoutes from "./routes/account.routes";
import linksRoutes from "./routes/links.routes";
import txRoutes from "./routes/transactions.routes";
import payRoutes from "./routes/pay.routes";
import swapRoutes from "./routes/swap.routes";
import earnRoutes from "./routes/earn.routes";
import contactsRoutes from "./routes/contacts.routes";
import bridgeRoutes from "./routes/bridge.routes";
import crosschainRoutes from "./routes/crosschain.routes";
import v1Routes from "./routes/v1.routes";
import merchantRoutes from "./routes/merchant.routes";
import homeRoutes from "./routes/home.routes";
import ingestRoutes from "./routes/ingest.routes";
import { getRpcHealthSummary, type RpcRoleName } from "./services/rpcControlPlane";
import { getRpcUrls } from "./services/clients";
import {
	getOperationalHealth,
	type OperationalHealthSummary,
} from "./services/operationalHealth";

const app = new Hono<AppContext>();
const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("*", async (c, next) => {
	const startedAt = Date.now();
	const requestId = getRequestId((name) => c.req.header(name));
	c.set("requestId", requestId);
	await next();
	c.header("X-Request-Id", requestId);
	logInfo("http_request_completed", {
		requestId,
		method: c.req.method,
		path: new URL(c.req.url).pathname,
		status: c.res.status,
		durationMs: Date.now() - startedAt,
	});
});

// Several D1 tables create user_event_outbox rows through integrity triggers.
// A mutation-level wakeup is the transport half of that transactional outbox;
// the Durable Object collapses concurrent mutations into one delivery job.
app.use("*", async (c, next) => {
	try {
		await next();
	} finally {
		if (
			MUTATING_HTTP_METHODS.has(c.req.method.toUpperCase()) &&
			c.res.status >= 200 &&
			c.res.status < 400
		) {
			c.executionCtx.waitUntil(
				wakeUserEventDeliveryIfPending(
					c.env,
					"http_mutation_outbox_check",
				)
					.catch((error) =>
						logError("user_event_wakeup_failed", error, {
							requestId: c.get("requestId"),
						}),
					),
			);
		}
	}
});

function mustFailClosed(env: Bindings): boolean {
	return !env.CHAIN_KEY || !isSupportedChainKey(env.CHAIN_KEY) || !getNetworkConfig(env.CHAIN_KEY).isTestnet;
}

let lastConfigWarning = "";
let eventRecoveryLastAttemptAt = 0;
app.use("*", async (c, next) => {
	if (new URL(c.req.url).pathname === "/health") return next();
	const issues = validateRuntimeConfig(c.env);
	if (mustFailClosed(c.env) && issues.length > 0) {
		const signature = issues.map((entry) => entry.code).sort().join(",");
		if (signature !== lastConfigWarning) {
			lastConfigWarning = signature;
			logError("runtime_configuration_invalid", new Error("Worker configuration is incomplete"), {
				issues: signature,
			});
		}
		return c.json(
			{ error: "Service configuration is incomplete", error_code: ERR.SERVICE_UNAVAILABLE },
			503,
		);
	}
	return next();
});

// Global Middlewares
// CORS: a configured comma-separated allowlist is enforced exactly. Testnets
// retain an open dev fallback; mainnet returns no CORS headers without a list.
let warnedOpenCors = false;
app.use(
	cors({
		origin: (origin, c) => {
			const configured = (c.env as Bindings).ALLOWED_ORIGINS
				?.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			if (!configured || configured.length === 0) {
				// Reflecting any origin is a dev convenience; on a real-money network
				// it deserves a loud (once-per-isolate) operator warning.
				if (!warnedOpenCors && !getNetworkConfig((c.env as Bindings).CHAIN_KEY).isTestnet) {
					warnedOpenCors = true;
					logWarn("cors_open_on_mainnet", { hint: "set ALLOWED_ORIGINS" });
				}
				return getNetworkConfig((c.env as Bindings).CHAIN_KEY).isTestnet ? origin || "*" : null;
			}
			return configured.includes(origin) ? origin : null;
		},
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
		exposeHeaders: ["X-Request-Id", "ETag", "X-State-Version"],
	}),
);
app.use(
	"*",
	bodyLimit({
		maxSize: 64 * 1024,
		onError: (c) => c.json({ error: "Request body too large", error_code: ERR.PAYLOAD_TOO_LARGE }, 413),
	}),
);

app.get("/health", async (c) => {
	const issueCodes = validateRuntimeConfig(c.env).map((entry) => entry.code);
	const warnings: string[] = [];
	let rpcHealth: Awaited<ReturnType<typeof getRpcHealthSummary>> = [];
	let operationalHealth: OperationalHealthSummary | null = null;
	try {
		if (await hasAccountOperationNeedsReview(c.env)) issueCodes.push("signer_nonce_blocked");
		rpcHealth = await getRpcHealthSummary(c.env);
		const now = Date.now();
		const roles: RpcRoleName[] = [
			"read",
			"write",
			"indexer",
			"archive",
			"bundler",
		];
		for (const role of roles) {
			const configuredCount = getRpcUrls(c.env, role).length;
			const observed = rpcHealth.filter((entry) => entry.role === role);
			const allConfiguredEndpointsOpen =
				configuredCount > 0 &&
				observed.length >= configuredCount &&
				observed.every(
					(entry) =>
						entry.circuitState === "open" &&
						Boolean(
							entry.openedUntil &&
								new Date(entry.openedUntil).getTime() > now,
						),
				);
			if (!allConfiguredEndpointsOpen) continue;
			if (
				role === "read" ||
				role === "write" ||
				(role === "bundler" && c.env.RELAYER_MODE === "bundler")
			) {
				issueCodes.push(`rpc_${role}_unavailable`);
			} else {
				warnings.push(`rpc_${role}_degraded`);
			}
		}
		const operational = await getOperationalHealth(c.env);
		operationalHealth = operational.summary;
		warnings.push(...operational.warnings);
		if (
			Date.now() - eventRecoveryLastAttemptAt >= 60_000 &&
			[
				operational.summary.queues.paymentReconcileActive,
				operational.summary.queues.userEventActive,
				operational.summary.queues.balanceRefreshActive,
				operational.summary.queues.accountOperationActive,
				operational.summary.queues.crosschainActive,
				operational.summary.queues.webhookDeliveryActive,
				operational.summary.queues.routerIntentActive,
				operational.summary.queues.indexerRegistryActive,
				operational.summary.queues.providerSubscriptionActive,
			].some((value) => value > 0)
		) {
			eventRecoveryLastAttemptAt = Date.now();
			c.executionCtx.waitUntil(
				recoverEventJobs(c.env).catch((error) => {
					eventRecoveryLastAttemptAt = 0;
					logError("event_job_recovery_failed", error, {
						requestId: c.get("requestId"),
					});
				}),
			);
		}
	} catch (error) {
		issueCodes.push("d1_unavailable");
		logError("health_operational_check_failed", error, { requestId: c.get("requestId") });
	}
	const payload = {
		status:
			issueCodes.length > 0
				? "not_ready"
				: warnings.length > 0
					? "degraded"
					: "ok",
		network: c.env.CHAIN_KEY ?? null,
		issues: issueCodes,
		warnings,
		rpc: rpcHealth,
		operations: operationalHealth,
	};
	return issueCodes.length === 0 ? c.json(payload, 200) : c.json(payload, 503);
});

app.use(authMiddleware);

// Healthcheck
app.get("/", (c) => c.text("Parmelia Links API (Modular)"));

// Mount Routes
app.route("/user/transactions", txRoutes);
app.route("/user", userRoutes);
app.route("/home", homeRoutes);
app.route("/ingest", ingestRoutes);
app.route("/account", accountRoutes);
app.route("/links", linksRoutes);
app.route("/pay", payRoutes);
app.route("/swap", swapRoutes);
app.route("/earn", earnRoutes);
app.route("/contacts", contactsRoutes);
app.route("/bridge", bridgeRoutes);
app.route("/crosschain", crosschainRoutes);
app.route("/v1", v1Routes);
app.route("/merchant", merchantRoutes);

app.onError((error, c) => {
	const requestId = c.get("requestId");
	logError("unhandled_worker_error", error, {
		requestId,
		method: c.req.method,
		path: new URL(c.req.url).pathname,
	});
	return c.json({ error: "Internal server error", error_code: ERR.SERVER_ERROR, requestId }, 500);
});

export default {
	fetch: app.fetch,
	queue: consumeWorkerQueue,
} satisfies ExportedHandler<Bindings, WorkerQueueMessage>;

export { EventJobScheduler, RpcAdmissionController };
