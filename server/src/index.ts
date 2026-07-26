import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { AppContext, authMiddleware, type Bindings } from "./middlewares/auth";
import {
	runIndexer,
	runRecoveryWatcher,
	runRouterWatcher,
	runUserOperationWatcher,
} from "./services/indexer";
import { runCrosschainRelayer } from "./services/crosschainRelayer";
import { runPaymentReconciler } from "./services/settlement";
import { runAccountOperationReconciler } from "./services/accountOperations";
import { deliverPendingWebhooks, migrateWebhookSecrets } from "./services/webhooks";
import { acquireCronLock, hasAccountOperationNeedsReview, releaseCronLock, renewCronLock } from "./services/storage";
import { getRequestId, logError, logInfo, logWarn } from "./services/logger";
import { runCronJobs } from "./services/cron";
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
import {
	consumeBalanceRefreshQueue,
	drainBalanceRefreshRequests,
	scheduleStaleRpcOnlyBalanceMaintenance,
} from "./services/balanceReconciler";
import { syncAlchemyWebhookAddresses } from "./services/alchemyWebhookAddresses";
import { drainUserEventOutbox } from "./services/userEventOutbox";
import { getRpcHealthSummary, type RpcRoleName } from "./services/rpcControlPlane";
import { getRpcUrls } from "./services/clients";
import {
	getOperationalHealth,
	type OperationalHealthSummary,
} from "./services/operationalHealth";

const app = new Hono<AppContext>();

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

function mustFailClosed(env: Bindings): boolean {
	return !env.CHAIN_KEY || !isSupportedChainKey(env.CHAIN_KEY) || !getNetworkConfig(env.CHAIN_KEY).isTestnet;
}

let lastConfigWarning = "";
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

// Cron overlap lease: shorter than the 2-min cron interval so a wedged run
// can't block the schedule for more than one tick.
const CRON_LOCK_TTL_MS = 100_000;
const CRON_LOCK_HEARTBEAT_MS = Math.floor(CRON_LOCK_TTL_MS / 3);

async function keepCronLeaseAlive(env: Bindings, owner: string, signal: AbortSignal) {
	while (!signal.aborted) {
		try {
			await scheduler.wait(CRON_LOCK_HEARTBEAT_MS, { signal });
		} catch (error) {
			if (signal.aborted) return;
			logError("cron_lease_heartbeat_wait_failed", error, { owner });
			return;
		}
		if (signal.aborted) return;
		try {
			if (!(await renewCronLock(env, owner, CRON_LOCK_TTL_MS))) {
				logError("cron_lease_lost", new Error("Cron lease ownership changed"), { owner });
				return;
			}
		} catch (error) {
			logError("cron_lease_renewal_failed", error, { owner });
			return;
		}
	}
}

export default {
	fetch: app.fetch,
	queue: consumeBalanceRefreshQueue,
	// Cron: ingest external incoming transfers into the ledger (see services/indexer),
	// watch the router + recovery events, advance cross-chain ops, and flush the
	// webhook outbox. Guarded by a best-effort D1 lease: RPC-heavy jobs every
	// 2 minutes can outlive their tick on a slow RPC, and two overlapping runs
	// would double pushes/mints and race the log cursors. Each job is individually
	// idempotent, so the lock is mitigation, not correctness-critical.
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			(async () => {
				const configIssues = validateRuntimeConfig(env);
				if (mustFailClosed(env) && configIssues.length > 0) {
					logError("cron_configuration_invalid", new Error("Worker configuration is incomplete"), {
						issues: configIssues.map((entry) => entry.code).join(","),
					});
					return;
				}
				const leaseOwner = await acquireCronLock(env, CRON_LOCK_TTL_MS);
				if (!leaseOwner) {
					logInfo("cron_skipped_overlap", {});
					return;
				}
				const heartbeatController = new AbortController();
				const heartbeat = keepCronLeaseAlive(env, leaseOwner, heartbeatController.signal);
				try {
					// Stages preserve causal order without serializing independent
					// work: ingest first, then reconcile its projections, then emit
					// external effects. Backfills/indexing never race the critical
					// write lane merely because the cron fired.
					const stages = [
						[
							{ name: "indexer", run: () => runIndexer(env) },
							{
								name: "user_operation_watcher",
								run: () => runUserOperationWatcher(env),
							},
							{ name: "router_watcher", run: () => runRouterWatcher(env) },
							{ name: "recovery_watcher", run: () => runRecoveryWatcher(env) },
							{
								name: "alchemy_address_sync",
								run: () => syncAlchemyWebhookAddresses(env),
							},
						],
						[
							{
								name: "balance_refresh_repair",
								run: async () => {
									await scheduleStaleRpcOnlyBalanceMaintenance(env);
									await drainBalanceRefreshRequests(env);
								},
							},
							{
								name: "payment_reconciler",
								run: () => runPaymentReconciler(env),
							},
							{
								name: "account_operation_reconciler",
								run: () => runAccountOperationReconciler(env),
							},
							{
								name: "crosschain_relayer",
								run: () => runCrosschainRelayer(env),
							},
						],
						[
							{
								name: "webhook_delivery",
								run: () => deliverPendingWebhooks(env),
							},
							{
								name: "user_event_delivery",
								run: () => drainUserEventOutbox(env),
							},
						],
						[
							{
								name: "webhook_key_rotation",
								run: () => migrateWebhookSecrets(env),
							},
						],
					];
					const failures = [];
					for (const stage of stages) {
						failures.push(...(await runCronJobs(stage)));
					}
					failures.forEach((failure) => {
						logError("cron_job_failed", failure.reason, { job: failure.name });
					});
				} finally {
					heartbeatController.abort();
					await heartbeat;
					await releaseCronLock(env, leaseOwner).catch((error) =>
						logWarn("cron_lease_release_failed", { reason: error instanceof Error ? error.name : "unknown" }),
					);
				}
			})().catch((error) => logError("cron_run_failed", error, {})),
		);
	},
} satisfies ExportedHandler<Bindings>;
