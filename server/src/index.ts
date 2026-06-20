import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppContext, authMiddleware, type Bindings } from "./middlewares/auth";
import { runIndexer, runRouterWatcher, runRecoveryWatcher } from "./services/indexer";
import { deliverPendingWebhooks } from "./services/webhooks";
import { getRequestId, logError } from "./services/logger";
import { ERR } from "../../shared";

import userRoutes from "./routes/user.routes";
import accountRoutes from "./routes/account.routes";
import linksRoutes from "./routes/links.routes";
import txRoutes from "./routes/transactions.routes";
import payRoutes from "./routes/pay.routes";
import swapRoutes from "./routes/swap.routes";
import contactsRoutes from "./routes/contacts.routes";
import bridgeRoutes from "./routes/bridge.routes";
import v1Routes from "./routes/v1.routes";
import merchantRoutes from "./routes/merchant.routes";

const app = new Hono<AppContext>();

// Global Middlewares
// CORS: if ALLOWED_ORIGINS (comma-separated) is set, only those origins are allowed;
// otherwise any origin is reflected (back-compatible default). Auth still requires a
// valid Firebase token + WebAuthn signature regardless of origin.
app.use(
	cors({
		origin: (origin, c) => {
			const configured = (c.env as Bindings).ALLOWED_ORIGINS
				?.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			if (!configured || configured.length === 0) return origin || "*";
			return configured.includes(origin) ? origin : null;
		},
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);
app.use(logger());
app.use(authMiddleware);

// Healthcheck
app.get("/", (c) => c.text("Parmelia Links API (Modular)"));

// Mount Routes
app.route("/user/transactions", txRoutes);
app.route("/user", userRoutes);
app.route("/account", accountRoutes);
app.route("/links", linksRoutes);
app.route("/pay", payRoutes);
app.route("/swap", swapRoutes);
app.route("/contacts", contactsRoutes);
app.route("/bridge", bridgeRoutes);
app.route("/v1", v1Routes);
app.route("/merchant", merchantRoutes);

app.onError((error, c) => {
	const requestId = getRequestId((name) => c.req.header(name));
	logError("unhandled_worker_error", error, {
		requestId,
		method: c.req.method,
		path: new URL(c.req.url).pathname,
	});
	return c.json({ error: "Internal server error", error_code: ERR.SERVER_ERROR, requestId }, 500);
});

export default {
	fetch: app.fetch,
	// Cron: ingest external incoming transfers into the ledger (see services/indexer)
	// and flush/retry the webhook outbox (see services/webhooks).
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(runIndexer(env));
		ctx.waitUntil(runRouterWatcher(env));
		ctx.waitUntil(runRecoveryWatcher(env));
		ctx.waitUntil(deliverPendingWebhooks(env));
	},
} satisfies ExportedHandler<Bindings>;
