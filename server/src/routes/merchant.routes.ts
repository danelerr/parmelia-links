// Merchant management (Firebase-authenticated owner / dashboard): create and
// revoke API keys, register webhook endpoints. The actual integration surface
// (creating intents, reading events) lives under /v1 with sk_ keys.

import { Hono } from "hono";
import { ERR } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { apiError } from "../services/apiError";
import { generateApiKey, randomToken, type ApiKeyMode } from "../services/apiKeys";
import {
	createApiKey,
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	getOrCreateMerchant,
	listApiKeys,
	listEvents,
	listPaymentIntents,
	listWebhookEndpoints,
	revokeApiKey,
} from "../services/storage";

const merchantRoutes = new Hono<AppContext>();

merchantRoutes.use("*", requireAuth);

function parseMode(value: unknown): ApiKeyMode {
	return value === "live" ? "live" : "test";
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

	const url = typeof body.url === "string" ? body.url.trim() : "";
	const isHttps = /^https:\/\//.test(url);
	const isLocal = /^http:\/\/localhost(:\d+)?\//.test(url);
	if (!isHttps && !isLocal) {
		return apiError(c, ERR.INVALID_WEBHOOK_URL, "Webhook url must be https:// (http://localhost allowed for testing).");
	}

	const mode = parseMode(body.mode);
	const enabledEvents =
		Array.isArray(body.events) && body.events.every((e) => typeof e === "string")
			? (body.events as string[])
			: null;

	const secret = `whsec_${randomToken(24)}`;
	const ep = await createWebhookEndpoint(c.env, { merchantId: merchant.id, url, secret, enabledEvents, mode });

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
	const intents = await listPaymentIntents(c.env, merchant.id, 100);
	return c.json({
		data: intents.map((i) => ({
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
	});
});

merchantRoutes.get("/events", async (c) => {
	const user = c.get("user")!;
	const merchant = await getOrCreateMerchant(c.env, user.sub, user.name ?? null);
	const events = await listEvents(c.env, merchant.id, 100);
	return c.json({ data: events });
});

export default merchantRoutes;
