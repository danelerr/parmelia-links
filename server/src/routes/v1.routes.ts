// Parmelia payments API — /v1 surface (authenticated with sk_ API keys).
//
// Flow A (closed-loop): a payment_intent is backed by a payment_links row, so the
// payer settles it through the existing Parmelia checkout. When the link is paid
// (in pay.routes), the intent flips to `paid` and payment.paid is emitted.
//
// Flow B (open): GET /payment_intents/:id/onchain returns a Parmelia-signed
// authorization so any external wallet can call PaymentRouter.payInvoice; the
// indexer attributes the InvoicePaid event back to the intent.
//
// Sandbox: POST /payment_intents/:id/simulate_payment marks a TEST intent paid
// without any on-chain payment, so a dev can exercise their webhook in minutes.

import { Context, Hono } from "hono";
import { parseUnits } from "viem";
import { ERR, getNetworkConfig, getTokenBySymbol } from "../../../shared";
import { AppContext } from "../middlewares/auth";
import { requireApiKey } from "../middlewares/apiAuth";
import {
	createPaymentIntent,
	createPaymentLink,
	getEvent,
	getMerchantById,
	getPaymentIntentById,
	getPaymentIntentByIdempotency,
	getUserByUid,
	listEvents,
	listPaymentIntents,
	markPaymentIntentPaid,
	updatePaymentIntentStatus,
	type PaymentIntentRecord,
} from "../services/storage";
import { deliverPendingWebhooks, emitEvent } from "../services/webhooks";
import { buildRouterAuthorization, intentToInvoiceId, RouterError } from "../services/paymentRouter";
import { apiError } from "../services/apiError";
import { getRequestId, logError } from "../services/logger";

const v1 = new Hono<AppContext>();
const DEFAULT_INTENT_TTL_SECONDS = 3600;
const MAX_INTENT_TTL_SECONDS = 86400;

v1.use("*", requireApiKey);

/** Public shape of a payment intent returned to API callers. */
function serializeIntent(intent: PaymentIntentRecord) {
	return {
		id: intent.id,
		object: "payment_intent",
		status: intent.status,
		amount: intent.amount,
		currency: intent.currency,
		reference: intent.reference,
		metadata: intent.metadata ?? {},
		checkout_url: intent.checkoutUrl,
		tx_hash: intent.txHash,
		mode: intent.mode,
		expires_at: intent.expiresAt,
		created_at: intent.createdAt,
	};
}

/** Build + send the payment.paid event and flush webhooks (after the response). */
function emitPaid(c: Context<AppContext>, intent: PaymentIntentRecord, txHash: string) {
	const flush = (async () => {
		await emitEvent(c.env, {
			merchantId: intent.merchantId,
			mode: intent.mode,
			type: "payment.paid",
			objectId: intent.id,
			data: { ...serializeIntent(intent), status: "paid", tx_hash: txHash },
		});
		await deliverPendingWebhooks(c.env);
	})();
	try {
		c.executionCtx.waitUntil(flush);
	} catch {
		void flush;
	}
}

v1.post("/payment_intents", async (c) => {
	const requestId = getRequestId((name) => c.req.header(name));
	try {
		const merchantId = c.get("merchantId")!;
		const mode = c.get("apiMode")!;
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

		const network = getNetworkConfig(c.env.CHAIN_KEY);
		const allowed = network.tokens.length ? network.tokens.map((t) => t.symbol) : ["USDC", "ETH"];
		const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "USDC";
		if (!allowed.includes(currency)) {
			return apiError(c, ERR.UNSUPPORTED_CURRENCY, `Unsupported currency. Use one of: ${allowed.join(", ")}`);
		}

		const token = getTokenBySymbol(network, currency);
		const decimals = token?.decimals ?? network.contracts.usdcDecimals;
		const amountStr = typeof body.amount === "string" ? body.amount.trim() : String(body.amount ?? "");
		try {
			if (parseUnits(amountStr, decimals) <= 0n) throw new Error("non-positive");
		} catch {
			return apiError(c, ERR.INVALID_AMOUNT, "Invalid amount.");
		}

		// Idempotency: same key returns the existing intent.
		const idemKey = c.req.header("Idempotency-Key") || null;
		if (idemKey) {
			const existing = await getPaymentIntentByIdempotency(c.env, merchantId, idemKey);
			if (existing) return c.json(serializeIntent(existing), 200);
		}

		const merchant = await getMerchantById(c.env, merchantId);
		const profile = merchant ? await getUserByUid(c.env, merchant.ownerUid) : null;
		if (!merchant || !profile?.walletAddress) {
			return apiError(c, ERR.NO_WALLET, "Merchant has no receiving wallet yet.");
		}

		const metadata =
			body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : null;
		if (metadata && JSON.stringify(metadata).length > 8192) {
			return apiError(c, ERR.METADATA_TOO_LARGE, "metadata too large (max 8KB).");
		}
		const reference = typeof body.reference === "string" ? body.reference.slice(0, 200) : null;

		let ttl = DEFAULT_INTENT_TTL_SECONDS;
		if (body.expires_in !== undefined) {
			const n = Number(body.expires_in);
			if (!Number.isInteger(n) || n < 60 || n > MAX_INTENT_TTL_SECONDS) {
				return apiError(c, ERR.INVALID_EXPIRY, "expires_in must be 60..86400 seconds.");
			}
			ttl = n;
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
		const appUrl = (c.env.APP_URL || "https://app.parmelia.me").replace(/\/+$/, "");

		// Backing payment_link — reuses the existing checkout/pay flow unchanged.
		const linkId = crypto.randomUUID();
		await createPaymentLink(c.env, {
			id: linkId,
			amount: amountStr,
			currency,
			reference: reference || "",
			wallet: profile.walletAddress,
			ownerUid: merchant.ownerUid,
			status: "pending",
			txHash: null,
			paidAt: null,
			paidBy: null,
			createdAt: now.toISOString(),
		});

		const intentId = `pi_${crypto.randomUUID().replace(/-/g, "")}`;
		const intent: PaymentIntentRecord = {
			id: intentId,
			merchantId,
			linkId,
			amount: amountStr,
			currency,
			status: "awaiting_payment",
			metadata,
			reference,
			checkoutUrl: `${appUrl}/pay?id=${linkId}`,
			txHash: null,
			mode,
			idempotencyKey: idemKey,
			onchainId: intentToInvoiceId(intentId),
			expiresAt,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		};
		await createPaymentIntent(c.env, intent);

		// Best-effort payment.created event (webhook delivery flushed after response).
		try {
			c.executionCtx.waitUntil(
				emitEvent(c.env, {
					merchantId,
					mode,
					type: "payment.created",
					objectId: intent.id,
					data: serializeIntent(intent),
				}),
			);
		} catch {
			/* non-blocking */
		}

		return c.json(serializeIntent(intent), 201);
	} catch (error) {
		logError("api_create_intent_failed", error, { requestId });
		return apiError(c, ERR.SERVER_ERROR, "Could not create payment intent.");
	}
});

v1.get("/payment_intents", async (c) => {
	const merchantId = c.get("merchantId")!;
	const intents = await listPaymentIntents(c.env, merchantId, 50);
	return c.json({ object: "list", data: intents.map(serializeIntent) });
});

v1.get("/payment_intents/:id", async (c) => {
	const merchantId = c.get("merchantId")!;
	const intent = await getPaymentIntentById(c.env, c.req.param("id"), merchantId);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");
	return c.json(serializeIntent(intent));
});

v1.post("/payment_intents/:id/cancel", async (c) => {
	const merchantId = c.get("merchantId")!;
	const id = c.req.param("id");
	const intent = await getPaymentIntentById(c.env, id, merchantId);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");
	if (intent.status !== "awaiting_payment") {
		return apiError(c, ERR.INTENT_NOT_PAYABLE, `Cannot cancel an intent in status '${intent.status}'.`);
	}
	await updatePaymentIntentStatus(c.env, id, merchantId, "canceled");
	const updated = await getPaymentIntentById(c.env, id, merchantId);
	return c.json(serializeIntent(updated!));
});

// Flow B — signed authorization for an external wallet to call PaymentRouter.
v1.get("/payment_intents/:id/onchain", async (c) => {
	const requestId = getRequestId((name) => c.req.header(name));
	const merchantId = c.get("merchantId")!;
	const intent = await getPaymentIntentById(c.env, c.req.param("id"), merchantId);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");
	if (intent.status !== "awaiting_payment") {
		return apiError(c, ERR.INTENT_NOT_PAYABLE, `Intent is '${intent.status}', not payable.`);
	}
	const merchant = await getMerchantById(c.env, merchantId);
	const profile = merchant ? await getUserByUid(c.env, merchant.ownerUid) : null;
	if (!profile?.walletAddress) {
		return apiError(c, ERR.NO_WALLET, "Merchant has no receiving wallet.");
	}
	try {
		const auth = await buildRouterAuthorization(c.env, intent, profile.walletAddress as `0x${string}`);
		return c.json(auth);
	} catch (error) {
		if (error instanceof RouterError) {
			return apiError(c, ERR.ROUTER_DISABLED, error.message);
		}
		logError("api_router_auth_failed", error, { requestId });
		return apiError(c, ERR.SERVER_ERROR, "Could not build on-chain authorization.");
	}
});

// Sandbox — mark a TEST intent paid without an on-chain payment.
v1.post("/payment_intents/:id/simulate_payment", async (c) => {
	const merchantId = c.get("merchantId")!;
	const mode = c.get("apiMode")!;
	const id = c.req.param("id");
	if (mode !== "test") {
		return apiError(c, ERR.SANDBOX_ONLY, "simulate_payment is only available with test keys.");
	}
	const intent = await getPaymentIntentById(c.env, id, merchantId);
	if (!intent) return apiError(c, ERR.INTENT_NOT_FOUND, "Payment intent not found.");
	if (intent.status !== "awaiting_payment") {
		return apiError(c, ERR.INTENT_NOT_PAYABLE, `Intent is '${intent.status}', not payable.`);
	}

	const txHash = `simulated_${id}`;
	await markPaymentIntentPaid(c.env, id, txHash, new Date().toISOString());
	const updated = (await getPaymentIntentById(c.env, id, merchantId))!;
	emitPaid(c, updated, txHash);
	return c.json(serializeIntent(updated));
});

v1.get("/events", async (c) => {
	const merchantId = c.get("merchantId")!;
	const events = await listEvents(c.env, merchantId, 50);
	return c.json({ object: "list", data: events });
});

v1.get("/events/:id", async (c) => {
	const merchantId = c.get("merchantId")!;
	const event = await getEvent(c.env, merchantId, c.req.param("id"));
	if (!event) return apiError(c, ERR.EVENT_NOT_FOUND, "Event not found.");
	return c.json(event);
});

export default v1;
