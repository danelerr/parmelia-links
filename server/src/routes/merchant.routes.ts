// Merchant management (Firebase-authenticated owner / dashboard): create and
// revoke API keys, register webhook endpoints. The actual integration surface
// (creating intents, reading events) lives under /v1 with sk_ keys.

import { Hono } from "hono";
import { parseUnits } from "viem";
import { ERR, getNetworkConfig } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { apiError } from "../services/apiError";
import { generateApiKey, randomToken, type ApiKeyMode } from "../services/apiKeys";
import {
	createApiKey,
	createPaymentIntentWithOutbox,
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	getOrCreateMerchant,
	getPaymentIntentById,
	getUserByUid,
	listApiKeys,
	listEvents,
	listPaymentIntents,
	listWebhookDeliveriesByMerchant,
	listWebhookEndpoints,
	markPaymentIntentPaidWithOutbox,
	requeueWebhookDelivery,
	revokeApiKey,
	type PaymentIntentRecord,
} from "../services/storage";
import { prepareEventOutbox } from "../services/webhooks";
import { buildRouterAuthorization, intentToInvoiceId, isRouterConfigured } from "../services/paymentRouter";
import { encryptWebhookSecret } from "../services/webhookSecrets";

const merchantRoutes = new Hono<AppContext>();

merchantRoutes.use("*", requireAuth);

function parseMode(value: unknown): ApiKeyMode {
	return value === "live" ? "live" : "test";
}

function isPrivateWebhookHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	const octets = host.split(".").map(Number);
	if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		const [a, b] = octets;
		return a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168);
	}
	return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8");
}

export function validateWebhookUrl(
	raw: string,
	mode: ApiKeyMode,
	isTestnet: boolean,
): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.username || url.password || url.hash) return null;
	const localHttp =
		url.protocol === "http:" &&
		mode === "test" &&
		isTestnet &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
	if (url.protocol !== "https:" && !localHttp) return null;
	if (!localHttp && isPrivateWebhookHost(url.hostname)) return null;
	if (mode === "live" && url.port && url.port !== "443") return null;
	return url.toString();
}

merchantRoutes.get("/", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	return c.json({ id: merchant.id, name: merchant.name, created_at: merchant.createdAt });
});

// ----- API keys -----

merchantRoutes.post("/keys", async (c) => {
	const user = c.get("user")!;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const mode = parseMode(body.mode);
	const name = typeof body.name === "string" ? body.name.slice(0, 60) : null;

	const { plaintext, prefix, hash } = await generateApiKey(mode);
	const key = await createApiKey(c.env, { merchantId: merchant.id, keyPrefix: prefix, secretHash: hash, mode, name });

	// The plaintext secret is returned ONCE and never stored or shown again.
	return c.json(
		{ id: key.id, key: plaintext, prefix: key.keyPrefix, mode: key.mode, name: key.name, created_at: key.createdAt },
		201,
	);
});

merchantRoutes.get("/keys", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const keys = await listApiKeys(c.env, merchant.id);
	return c.json({
		data: keys.map((k) => ({
			id: k.id,
			prefix: k.keyPrefix,
			mode: k.mode,
			name: k.name,
			last_used_at: k.lastUsedAt,
			revoked: !!k.revokedAt,
			created_at: k.createdAt,
		})),
	});
});

merchantRoutes.delete("/keys/:id", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	await revokeApiKey(c.env, merchant.id, c.req.param("id"));
	return c.json({ success: true });
});

// ----- Webhook endpoints -----

merchantRoutes.post("/webhooks", async (c) => {
	const user = c.get("user")!;
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);

	const mode = parseMode(body.mode);
	const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
	const url = validateWebhookUrl(rawUrl, mode, getNetworkConfig(c.env.CHAIN_KEY).isTestnet);
	if (!url) {
		return apiError(c, ERR.INVALID_WEBHOOK_URL, "Webhook url must be https:// (http://localhost allowed for testing).");
	}

	const enabledEvents =
		Array.isArray(body.events) && body.events.every((e) => typeof e === "string")
			? (body.events as string[])
			: null;

	const secret = `whsec_${randomToken(24)}`;
	const storedSecret = await encryptWebhookSecret(c.env, secret);
	const ep = await createWebhookEndpoint(c.env, { merchantId: merchant.id, url, secret: storedSecret, enabledEvents, mode });

	// Signing secret returned ONCE.
	return c.json(
		{ id: ep.id, url: ep.url, secret, mode: ep.mode, events: ep.enabledEvents, created_at: ep.createdAt },
		201,
	);
});

merchantRoutes.get("/webhooks", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const endpoints = await listWebhookEndpoints(c.env, merchant.id);
	return c.json({
		data: endpoints.map((e) => ({
			id: e.id,
			url: e.url,
			mode: e.mode,
			events: e.enabledEvents,
			status: e.status,
			created_at: e.createdAt,
		})),
	});
});

merchantRoutes.delete("/webhooks/:id", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	await deleteWebhookEndpoint(c.env, merchant.id, c.req.param("id"));
	return c.json({ success: true });
});

// ----- Read views for the dashboard (Firebase auth = the owner) -----
// The same data the dev reads via /v1 with sk_ keys, but scoped by the owner's
// Firebase session so the dashboard never needs to hold a secret key.

merchantRoutes.get("/payment_intents", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	// Cursor pagination: ?limit=25&starting_after=<intent_id>. Fetch one extra row
	// to compute has_more without a COUNT.
	const rawLimit = Number(c.req.query("limit") ?? 100);
	const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 100;
	const startingAfter = c.req.query("starting_after") || null;
	// Optional filters for the dashboard list (?status=paid&mode=live).
	const VALID_STATUS = new Set(["awaiting_payment", "paid", "expired", "canceled"]);
	const statusQ = c.req.query("status") ?? "";
	const modeQ = c.req.query("mode") ?? "";
	const filters = {
		status: VALID_STATUS.has(statusQ) ? statusQ : null,
		mode: modeQ === "live" || modeQ === "test" ? (modeQ as ApiKeyMode) : null,
	};
	const intents = await listPaymentIntents(c.env, merchant.id, limit + 1, startingAfter, filters);
	const page = intents.slice(0, limit);
	return c.json({
		data: page.map((i) => ({
			id: i.id,
			status: i.status,
			amount: i.amount,
			currency: i.currency,
			reference: i.reference,
			metadata: i.metadata ?? {},
			tx_hash: i.txHash,
			mode: i.mode,
			created_at: i.createdAt,
		})),
		has_more: intents.length > limit,
	});
});

merchantRoutes.get("/payment_intents/:id", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const intent = await getPaymentIntentById(c.env, c.req.param("id"), merchant.id);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");

	// If the on-chain router is live and the intent is still payable, include the
	// Flow B authorization (what an external wallet would use to call payInvoice).
	let onchain: Awaited<ReturnType<typeof buildRouterAuthorization>> | null = null;
	if (isRouterConfigured(c.env) && intent.status === "awaiting_payment" && intent.currency === "USDC") {
		const owner = await getUserByUid(c.env, merchant.ownerUid);
		if (owner?.walletAddress) {
			try {
				onchain = await buildRouterAuthorization(c.env, intent, owner.walletAddress as `0x${string}`);
			} catch {
				onchain = null;
			}
		}
	}
	return c.json({ ...serializeIntent(intent), checkout_url: intent.checkoutUrl, onchain });
});

merchantRoutes.get("/events", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	// Cursor pagination: ?limit=50&starting_after=<event_id>, +1 row for has_more.
	const rawLimit = Number(c.req.query("limit") ?? 100);
	const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 100;
	const startingAfter = c.req.query("starting_after") || null;
	const events = await listEvents(c.env, merchant.id, limit + 1, startingAfter);
	return c.json({ data: events.slice(0, limit), has_more: events.length > limit });
});

// ----- Webhook delivery log (for the dashboard) -----

merchantRoutes.get("/webhook_deliveries", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const deliveries = await listWebhookDeliveriesByMerchant(c.env, merchant.id, 50);
	return c.json({ data: deliveries });
});

merchantRoutes.post("/webhook_deliveries/:id/resend", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	await requeueWebhookDelivery(c.env, merchant.id, c.req.param("id"));
	return c.json({ success: true });
});

// ----- Sandbox (Firebase-authed, test-mode only): create a test charge and
// simulate its payment, so the dev sees the webhook fire without sk_ keys. -----

function serializeIntent(i: PaymentIntentRecord) {
	return {
		id: i.id,
		object: "payment_intent",
		status: i.status,
		amount: i.amount,
		currency: i.currency,
		reference: i.reference,
		metadata: i.metadata ?? {},
		tx_hash: i.txHash,
		mode: i.mode,
		created_at: i.createdAt,
	};
}

merchantRoutes.post("/sandbox/charge", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const amount = typeof body.amount === "string" ? body.amount.trim() : String(body.amount ?? "");
	try {
		if (parseUnits(amount, 6) <= 0n) throw new Error("non-positive");
	} catch {
		return apiError(c, ERR.INVALID_AMOUNT, "Invalid amount.");
	}
	const reference = typeof body.reference === "string" ? body.reference.slice(0, 200) : null;

	const now = new Date();
	const id = `pi_${crypto.randomUUID().replace(/-/g, "")}`;
	const intent: PaymentIntentRecord = {
		id,
		merchantId: merchant.id,
		linkId: null,
		amount,
		currency: "USDC",
		status: "awaiting_payment",
		metadata: null,
		reference,
		checkoutUrl: null,
		txHash: null,
		mode: "test",
		idempotencyKey: null,
		onchainId: intentToInvoiceId(id),
		expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
	};
	const createdOutbox = await prepareEventOutbox(c.env, {
		merchantId: merchant.id,
		mode: "test",
		type: "payment.created",
		objectId: id,
		data: serializeIntent(intent),
	});
	await createPaymentIntentWithOutbox(c.env, intent, createdOutbox);
	return c.json(serializeIntent(intent), 201);
});

merchantRoutes.post("/sandbox/simulate/:id", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const id = c.req.param("id");
	const intent = await getPaymentIntentById(c.env, id, merchant.id);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");
	if (intent.mode !== "test") return apiError(c, ERR.SANDBOX_ONLY, "Only test intents can be simulated.");
	if (intent.status !== "awaiting_payment") {
		return apiError(c, ERR.INTENT_NOT_PAYABLE, `Intent is '${intent.status}', not payable.`);
	}
	const txHash = `sandbox_${id}`;
	const paidOutbox = await prepareEventOutbox(c.env, {
		merchantId: merchant.id,
		mode: "test",
		type: "payment.paid",
		objectId: id,
		data: { ...serializeIntent(intent), status: "paid", tx_hash: txHash },
	});
	if (!(await markPaymentIntentPaidWithOutbox(c.env, id, txHash, new Date().toISOString(), paidOutbox))) {
		return apiError(c, ERR.INTENT_NOT_PAYABLE, "Payment is already being processed.");
	}
	const updated = (await getPaymentIntentById(c.env, id, merchant.id))!;
	return c.json(serializeIntent(updated));
});

export default merchantRoutes;
