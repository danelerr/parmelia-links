import type { Bindings } from "../../middlewares/auth";
import { scheduleEventJob } from "../eventScheduler";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./core";

// ===== Payments API: merchants, API keys, intents, webhooks, events =====

export type ApiMode = "test" | "live";

export type MerchantRecord = { id: string; ownerUid: string; name: string | null; createdAt: string };
export type ApiKeyRecord = {
	id: string;
	merchantId: string;
	keyPrefix: string;
	secretHash: string;
	mode: ApiMode;
	name: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
};
export type PaymentIntentStatus = "awaiting_payment" | "paid" | "expired" | "canceled";
export type PaymentIntentRecord = {
	id: string;
	merchantId: string;
	linkId: string | null;
	amount: string;
	currency: string;
	status: PaymentIntentStatus;
	metadata: Record<string, unknown> | null;
	reference: string | null;
	checkoutUrl: string | null;
	txHash: string | null;
	mode: ApiMode;
	idempotencyKey: string | null;
	/** bytes32 invoiceId used on-chain (Flow B), = keccak256(id). */
	onchainId: string | null;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
};
export type WebhookEndpointRecord = {
	id: string;
	merchantId: string;
	url: string;
	secret: string;
	enabledEvents: string[] | null;
	status: "enabled" | "disabled";
	mode: ApiMode;
	createdAt: string;
};
export type EventRecord = {
	id: string;
	merchantId: string;
	type: string;
	objectId: string | null;
	payload: Record<string, unknown>;
	mode: ApiMode;
	createdAt: string;
};

export type EventOutboxPlan = {
	event: EventRecord;
	deliveries: Array<{
		id: string;
		endpointId: string;
		createdAt: string;
	}>;
};
export type WebhookDeliveryDue = {
	id: string;
	eventId: string;
	endpointId: string;
	attempt: number;
	eventType: string;
	eventPayload: string;
	eventCreatedAt: string;
	url: string;
	secret: string;
};

function apiId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

// --- merchants ---

export async function getMerchantById(env: Bindings, id: string): Promise<MerchantRecord | null> {
	const row = await d1First<{ id: string; owner_uid: string; name: string | null; created_at: string }>(
		env,
		`SELECT id, owner_uid, name, created_at FROM merchants WHERE id = ?`,
		[id],
	);
	return row ? { id: row.id, ownerUid: row.owner_uid, name: row.name, createdAt: row.created_at } : null;
}

async function getMerchantByOwner(env: Bindings, ownerUid: string): Promise<MerchantRecord | null> {
	const row = await d1First<{ id: string; owner_uid: string; name: string | null; created_at: string }>(
		env,
		`SELECT id, owner_uid, name, created_at FROM merchants WHERE owner_uid = ?`,
		[ownerUid],
	);
	return row ? { id: row.id, ownerUid: row.owner_uid, name: row.name, createdAt: row.created_at } : null;
}

/** One merchant per user; created lazily and idempotently. */
export async function getOrCreateMerchant(env: Bindings, ownerUid: string, name: string | null = null): Promise<MerchantRecord> {
	const existing = await getMerchantByOwner(env, ownerUid);
	if (existing) return existing;
	await d1Run(
		env,
		`INSERT INTO merchants (id, owner_uid, name, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(owner_uid) DO NOTHING`,
		[apiId("mer"), ownerUid, name, nowIso()],
	);
	return (await getMerchantByOwner(env, ownerUid))!;
}

// --- api keys ---

export async function createApiKey(
	env: Bindings,
	params: { merchantId: string; keyPrefix: string; secretHash: string; mode: ApiMode; name: string | null },
): Promise<ApiKeyRecord> {
	const rec: ApiKeyRecord = {
		id: apiId("ak"),
		merchantId: params.merchantId,
		keyPrefix: params.keyPrefix,
		secretHash: params.secretHash,
		mode: params.mode,
		name: params.name,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: nowIso(),
	};
	await d1Run(
		env,
		`INSERT INTO api_keys (id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
		[rec.id, rec.merchantId, rec.keyPrefix, rec.secretHash, rec.mode, rec.name, rec.createdAt],
	);
	return rec;
}

type ApiKeyRow = {
	id: string; merchant_id: string; key_prefix: string; secret_hash: string;
	mode: ApiMode; name: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
};
function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
	return {
		id: row.id, merchantId: row.merchant_id, keyPrefix: row.key_prefix, secretHash: row.secret_hash,
		mode: row.mode, name: row.name, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, createdAt: row.created_at,
	};
}

export async function getApiKeyByHash(env: Bindings, secretHash: string): Promise<ApiKeyRecord | null> {
	const row = await d1First<ApiKeyRow>(
		env,
		`SELECT id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at
		 FROM api_keys WHERE secret_hash = ? LIMIT 1`,
		[secretHash],
	);
	return row ? mapApiKey(row) : null;
}

export async function listApiKeys(env: Bindings, merchantId: string): Promise<ApiKeyRecord[]> {
	const rows = await d1All<ApiKeyRow>(
		env,
		`SELECT id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at
		 FROM api_keys WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`,
		[merchantId],
	);
	return rows.map(mapApiKey);
}

export async function revokeApiKey(env: Bindings, merchantId: string, id: string) {
	await d1Run(
		env,
		`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL`,
		[nowIso(), id, merchantId],
	);
}

export async function touchApiKey(env: Bindings, id: string) {
	await d1Run(env, `UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [nowIso(), id]);
}


// --- payment intents ---

type PaymentIntentRow = {
	id: string; merchant_id: string; link_id: string | null; amount: string; currency: string;
	status: PaymentIntentStatus; metadata: string | null; reference: string | null; checkout_url: string | null;
	tx_hash: string | null; mode: ApiMode; idempotency_key: string | null; onchain_id: string | null; expires_at: string | null;
	created_at: string; updated_at: string;
};
function mapIntent(row: PaymentIntentRow): PaymentIntentRecord {
	return {
		id: row.id, merchantId: row.merchant_id, linkId: row.link_id, amount: row.amount, currency: row.currency,
		status: row.status, metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
		reference: row.reference, checkoutUrl: row.checkout_url, txHash: row.tx_hash, mode: row.mode,
		idempotencyKey: row.idempotency_key, onchainId: row.onchain_id, expiresAt: row.expires_at,
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export async function createPaymentIntentWithOutbox(
	env: Bindings,
	rec: PaymentIntentRecord,
	outbox: EventOutboxPlan,
): Promise<void> {
	if (rec.status === "awaiting_payment" && rec.onchainId) {
		await scheduleEventJob(env, "router_watcher", {
			delayMs: 2_000,
			reason: "payment_intent_created",
		});
	}
	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`INSERT INTO payment_intents (id, merchant_id, link_id, amount, currency, status, metadata, reference,
				checkout_url, tx_hash, mode, idempotency_key, expires_at, created_at, updated_at, onchain_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			rec.id, rec.merchantId, rec.linkId, rec.amount, rec.currency, rec.status,
			rec.metadata ? JSON.stringify(rec.metadata) : null, rec.reference, rec.checkoutUrl, rec.txHash,
			rec.mode, rec.idempotencyKey, rec.expiresAt, rec.createdAt, rec.updatedAt, rec.onchainId,
		),
		...eventOutboxStatements(env, outbox),
	]);
	if (outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_event_created",
		});
	}
}

/**
 * Create the checkout link, intent and payment.created outbox in one D1
 * transaction. A concurrent idempotency-key loser rolls back its link too.
 */
type PaymentIntentLinkSnapshot = {
	id: string;
	ownerUid: string;
	wallet: string;
	amount: string;
	currency: string;
	reference: string;
	status: "pending" | "paid";
	txHash: string | null;
	paidAt: string | null;
	paidBy: string | null;
	createdAt: string;
};

export async function createPaymentIntentTransaction(
	env: Bindings,
	link: PaymentIntentLinkSnapshot,
	rec: PaymentIntentRecord,
	outbox: EventOutboxPlan,
): Promise<void> {
	if (rec.status === "awaiting_payment" && rec.onchainId) {
		await scheduleEventJob(env, "router_watcher", {
			delayMs: 2_000,
			reason: "payment_intent_created",
		});
	}
	const statements = [
		env.GATOPAGO_DB.prepare(
			`INSERT INTO payment_links (
				id, owner_uid, wallet_address, amount, currency, reference, status,
				tx_hash, paid_at, paid_by, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			link.id, link.ownerUid, link.wallet, link.amount, link.currency, link.reference,
			link.status, link.txHash, link.paidAt, link.paidBy, link.createdAt,
		),
		env.GATOPAGO_DB.prepare(
			`INSERT INTO payment_intents (id, merchant_id, link_id, amount, currency, status, metadata, reference,
				checkout_url, tx_hash, mode, idempotency_key, expires_at, created_at, updated_at, onchain_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			rec.id, rec.merchantId, rec.linkId, rec.amount, rec.currency, rec.status,
			rec.metadata ? JSON.stringify(rec.metadata) : null, rec.reference, rec.checkoutUrl, rec.txHash,
			rec.mode, rec.idempotencyKey, rec.expiresAt, rec.createdAt, rec.updatedAt, rec.onchainId,
		),
		...eventOutboxStatements(env, outbox),
	];
	await env.GATOPAGO_DB.batch(statements);
	if (outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_event_created",
		});
	}
}

const INTENT_COLS =
	"id, merchant_id, link_id, amount, currency, status, metadata, reference, checkout_url, tx_hash, mode, idempotency_key, onchain_id, expires_at, created_at, updated_at";

export async function getPaymentIntentById(env: Bindings, id: string, merchantId?: string): Promise<PaymentIntentRecord | null> {
	const row = merchantId
		? await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE id = ? AND merchant_id = ?`, [id, merchantId])
		: await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE id = ?`, [id]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByLinkId(env: Bindings, linkId: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE link_id = ? LIMIT 1`, [linkId]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByOnchainId(env: Bindings, onchainId: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE onchain_id = ? LIMIT 1`, [onchainId]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByIdempotency(env: Bindings, merchantId: string, key: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(
		env,
		`SELECT ${INTENT_COLS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`,
		[merchantId, key],
	);
	return row ? mapIntent(row) : null;
}

/**
 * Newest-first page of a merchant's intents. `startingAfterId` is a cursor (the
 * last id of the previous page); the page starts strictly after that intent.
 * created_at is ISO text, so plain ORDER BY is chronological; `id DESC` breaks
 * same-timestamp ties deterministically.
 */
export async function listPaymentIntents(
	env: Bindings,
	merchantId: string,
	limit = 50,
	startingAfterId?: string | null,
	filters?: { status?: string | null; mode?: ApiMode | null },
): Promise<PaymentIntentRecord[]> {
	let cursorCreatedAt: string | null = null;
	let cursorId: string | null = null;
	if (startingAfterId) {
		const cursorRow = await d1First<{ created_at: string; id: string }>(
			env,
			`SELECT created_at, id FROM payment_intents WHERE id = ? AND merchant_id = ? LIMIT 1`,
			[startingAfterId, merchantId],
		);
		if (cursorRow) {
			cursorCreatedAt = cursorRow.created_at;
			cursorId = cursorRow.id;
		}
	}
	const conds: string[] = ["merchant_id = ?"];
	const params: unknown[] = [merchantId];
	if (filters?.status) {
		conds.push("status = ?");
		params.push(filters.status);
	}
	if (filters?.mode) {
		conds.push("mode = ?");
		params.push(filters.mode);
	}
	if (cursorCreatedAt) {
		conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
		params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
	}
	const rows = await d1All<PaymentIntentRow>(
		env,
		`SELECT ${INTENT_COLS} FROM payment_intents WHERE ${conds.join(" AND ")}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[...params, limit],
	);
	return rows.map(mapIntent);
}

/**
 * Whether an intent can still be paid: status must be awaiting_payment AND its
 * expiry (if any) must be in the future. Every pay/authorize path must check
 * this — a canceled or expired intent keeps a 'pending' payment_links row, so
 * checking only the link would let payers settle dead intents.
 */
export function isIntentPayable(intent: Pick<PaymentIntentRecord, "status" | "expiresAt">): boolean {
	if (intent.status !== "awaiting_payment") return false;
	if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) return false;
	return true;
}

/** Atomically settle a sandbox/indexed intent and persist its paid outbox. */
export async function markPaymentIntentPaidWithOutbox(
	env: Bindings,
	id: string,
	txHash: string,
	paidAt: string,
	outbox: EventOutboxPlan,
): Promise<boolean> {
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ?
			 WHERE id = ? AND status = 'awaiting_payment'`,
		).bind(txHash, paidAt, id),
		...eventOutboxStatements(env, outbox, { intentId: id, txHash }),
	]);
	const written = didWrite(results[0]);
	if (written && outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_paid",
		});
	}
	return written;
}

/**
 * Settle the link, backing intent and payment.paid outbox as one transaction.
 * The link claim prevents another UserOperation from paying the same checkout.
 */
export async function settlePaymentLinkWithOutbox(
	env: Bindings,
	params: {
		id: string;
		amount: string;
		txHash: string;
		paidAt: string;
		paidBy: string;
		claimOwner: string;
		intentId?: string | null;
		outbox?: EventOutboxPlan | null;
	},
): Promise<boolean> {
	const statements = [
		env.GATOPAGO_DB.prepare(
			`UPDATE payment_links
			 SET status = 'paid', amount = ?, tx_hash = ?, paid_at = ?, paid_by = ?,
				payment_claim = NULL, payment_claim_expires_at = NULL, payment_claim_tx_hash = NULL
			 WHERE id = ? AND status = 'pending'
				AND (payment_claim IS NULL OR payment_claim = ?)`,
		).bind(params.amount, params.txHash, params.paidAt, params.paidBy, params.id, params.claimOwner),
	];

	if (params.intentId) {
		statements.push(
			env.GATOPAGO_DB.prepare(
				`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ?
				 WHERE id = ? AND status = 'awaiting_payment'
					AND EXISTS (
						SELECT 1 FROM payment_links
						WHERE id = ? AND status = 'paid' AND tx_hash = ?
					)`,
			).bind(params.txHash, params.paidAt, params.intentId, params.id, params.txHash),
		);
		if (params.outbox) {
			statements.push(...eventOutboxStatements(env, params.outbox, {
				intentId: params.intentId,
				txHash: params.txHash,
			}));
		}
	}

	const results = await env.GATOPAGO_DB.batch(statements);
	const written = didWrite(results[0]);
	if (written && params.outbox && params.outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_link_settled",
		});
	}
	return written;
}

export async function updatePaymentIntentStatus(env: Bindings, id: string, merchantId: string, status: PaymentIntentStatus): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_intents SET status = ?, updated_at = ?
		 WHERE id = ? AND merchant_id = ? AND status = 'awaiting_payment'
			AND NOT EXISTS (
				SELECT 1 FROM payment_links
				WHERE payment_links.id = payment_intents.link_id
					AND payment_links.payment_claim IS NOT NULL
			)`,
		[status, nowIso(), id, merchantId],
	);
	return didWrite(result);
}

// --- webhook endpoints ---

type WebhookEndpointRow = {
	id: string; merchant_id: string; url: string; secret: string; enabled_events: string | null;
	status: "enabled" | "disabled"; mode: ApiMode; created_at: string;
};
function mapEndpoint(row: WebhookEndpointRow): WebhookEndpointRecord {
	return {
		id: row.id, merchantId: row.merchant_id, url: row.url, secret: row.secret,
		enabledEvents: row.enabled_events ? (JSON.parse(row.enabled_events) as string[]) : null,
		status: row.status, mode: row.mode, createdAt: row.created_at,
	};
}

export async function createWebhookEndpoint(
	env: Bindings,
	params: { merchantId: string; url: string; secret: string; enabledEvents: string[] | null; mode: ApiMode },
): Promise<WebhookEndpointRecord> {
	const rec: WebhookEndpointRecord = {
		id: apiId("whe"), merchantId: params.merchantId, url: params.url, secret: params.secret,
		enabledEvents: params.enabledEvents, status: "enabled", mode: params.mode, createdAt: nowIso(),
	};
	await d1Run(
		env,
		`INSERT INTO webhook_endpoints (id, merchant_id, url, secret, enabled_events, status, mode, created_at)
		 VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?)`,
		[rec.id, rec.merchantId, rec.url, rec.secret, rec.enabledEvents ? JSON.stringify(rec.enabledEvents) : null, rec.mode, rec.createdAt],
	);
	await scheduleEventJob(env, "webhook_key_rotation", {
		reason: "webhook_endpoint_changed",
	});
	return rec;
}

export async function listWebhookEndpoints(env: Bindings, merchantId: string): Promise<WebhookEndpointRecord[]> {
	const rows = await d1All<WebhookEndpointRow>(
		env,
		`SELECT id, merchant_id, url, secret, enabled_events, status, mode, created_at
		 FROM webhook_endpoints WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`,
		[merchantId],
	);
	return rows.map(mapEndpoint);
}

export async function listEnabledEndpoints(env: Bindings, merchantId: string, mode: ApiMode): Promise<WebhookEndpointRecord[]> {
	const rows = await d1All<WebhookEndpointRow>(
		env,
		`SELECT id, merchant_id, url, secret, enabled_events, status, mode, created_at
		 FROM webhook_endpoints WHERE merchant_id = ? AND mode = ? AND status = 'enabled'`,
		[merchantId, mode],
	);
	return rows.map(mapEndpoint);
}

export async function deleteWebhookEndpoint(env: Bindings, merchantId: string, id: string) {
	await d1Run(env, `DELETE FROM webhook_endpoints WHERE id = ? AND merchant_id = ?`, [id, merchantId]);
}

export async function listWebhookSecretsNeedingEncryption(
	env: Bindings,
	activePrefix: string,
	limit = 25,
): Promise<Array<{ id: string; secret: string }>> {
	return d1All<{ id: string; secret: string }>(
		env,
		`SELECT id, secret FROM webhook_endpoints WHERE substr(secret, 1, length(?)) <> ? LIMIT ?`,
		[activePrefix, activePrefix, limit],
	);
}

export async function replaceWebhookSecret(
	env: Bindings,
	id: string,
	oldSecret: string,
	newSecret: string,
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE webhook_endpoints SET secret = ? WHERE id = ? AND secret = ?`,
		[newSecret, id, oldSecret],
	);
	return didWrite(result);
}

// --- events + webhook deliveries (outbox) ---

function eventOutboxStatements(
	env: Bindings,
	plan: EventOutboxPlan,
	guard?: { intentId: string; txHash: string },
) {
	const event = plan.event;
	const eventStatement = guard
		? env.GATOPAGO_DB.prepare(
			`INSERT OR IGNORE INTO events (id, merchant_id, type, object_id, payload, mode, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (
				SELECT 1 FROM payment_intents WHERE id = ? AND status = 'paid' AND tx_hash = ?
			 )`,
		).bind(
			event.id, event.merchantId, event.type, event.objectId, JSON.stringify(event.payload),
			event.mode, event.createdAt, guard.intentId, guard.txHash,
		)
		: env.GATOPAGO_DB.prepare(
			`INSERT OR IGNORE INTO events (id, merchant_id, type, object_id, payload, mode, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			event.id, event.merchantId, event.type, event.objectId, JSON.stringify(event.payload),
			event.mode, event.createdAt,
		);

	return [
		eventStatement,
		...plan.deliveries.map((delivery) =>
			env.GATOPAGO_DB.prepare(
				`INSERT OR IGNORE INTO webhook_deliveries
					(id, event_id, endpoint_id, attempt, status, next_retry_at, created_at)
				 SELECT ?, ?, ?, 0, 'pending', ?, ?
				 WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
			).bind(
				delivery.id, event.id, delivery.endpointId, delivery.createdAt,
				delivery.createdAt, event.id,
			),
		),
	];
}

type EventRow = { id: string; merchant_id: string; type: string; object_id: string | null; payload: string; mode: ApiMode; created_at: string };
function mapEvent(row: EventRow): EventRecord {
	return {
		id: row.id, merchantId: row.merchant_id, type: row.type, objectId: row.object_id,
		payload: JSON.parse(row.payload) as Record<string, unknown>, mode: row.mode, createdAt: row.created_at,
	};
}

export async function listEvents(
	env: Bindings,
	merchantId: string,
	limit = 50,
	startingAfterId?: string | null,
): Promise<EventRecord[]> {
	// Cursor pagination on (created_at, id), same scheme as payment intents.
	let cursorCreatedAt: string | null = null;
	let cursorId: string | null = null;
	if (startingAfterId) {
		const cursorRow = await d1First<{ created_at: string; id: string }>(
			env,
			`SELECT created_at, id FROM events WHERE id = ? AND merchant_id = ? LIMIT 1`,
			[startingAfterId, merchantId],
		);
		if (cursorRow) {
			cursorCreatedAt = cursorRow.created_at;
			cursorId = cursorRow.id;
		}
	}
	const rows = cursorCreatedAt
		? await d1All<EventRow>(
				env,
				`SELECT id, merchant_id, type, object_id, payload, mode, created_at
				 FROM events
				 WHERE merchant_id = ? AND (datetime(created_at) < datetime(?) OR (created_at = ? AND id < ?))
				 ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
				[merchantId, cursorCreatedAt, cursorCreatedAt, cursorId, limit],
			)
		: await d1All<EventRow>(
				env,
				`SELECT id, merchant_id, type, object_id, payload, mode, created_at
				 FROM events WHERE merchant_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
				[merchantId, limit],
			);
	return rows.map(mapEvent);
}

export async function getEvent(env: Bindings, merchantId: string, id: string): Promise<EventRecord | null> {
	const row = await d1First<EventRow>(
		env,
		`SELECT id, merchant_id, type, object_id, payload, mode, created_at FROM events WHERE id = ? AND merchant_id = ?`,
		[id, merchantId],
	);
	return row ? mapEvent(row) : null;
}

export async function listDueWebhookDeliveries(env: Bindings, limit = 25): Promise<WebhookDeliveryDue[]> {
	const now = nowIso();
	const rows = await d1All<{
		id: string; event_id: string; endpoint_id: string; attempt: number;
		event_type: string; event_payload: string; event_created_at: string; url: string; secret: string;
	}>(
		env,
		`SELECT d.id, d.event_id, d.endpoint_id, d.attempt,
			e.type AS event_type, e.payload AS event_payload, e.created_at AS event_created_at,
			w.url AS url, w.secret AS secret
		 FROM webhook_deliveries d
		 JOIN events e ON e.id = d.event_id
		 JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 WHERE d.status = 'pending' AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
		 ORDER BY d.created_at ASC LIMIT ?`,
		[now, limit],
	);
	return rows.map((r) => ({
		id: r.id, eventId: r.event_id, endpointId: r.endpoint_id, attempt: r.attempt,
		eventType: r.event_type, eventPayload: r.event_payload, eventCreatedAt: r.event_created_at, url: r.url, secret: r.secret,
	}));
}

/**
 * Claim a due delivery for `leaseMs` by pushing next_retry_at into the future —
 * atomically, so two overlapping Queue deliveries can't
 * POST the same delivery twice. The winner delivers and then records the final
 * state; if it dies mid-flight, the lease expires and the delivery is retried.
 */
export async function claimWebhookDelivery(env: Bindings, id: string, leaseMs: number): Promise<boolean> {
	const now = nowIso();
	const lease = new Date(Date.now() + leaseMs).toISOString();
	const result = await d1Run(
		env,
		`UPDATE webhook_deliveries SET next_retry_at = ?
		 WHERE id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
		[lease, id, now],
	);
	return didWrite(result);
}

export async function updateWebhookDelivery(
	env: Bindings,
	id: string,
	fields: { status: string; attempt: number; responseCode: number | null; deliveredAt: string | null; nextRetryAt: string | null },
) {
	await d1Run(
		env,
		`UPDATE webhook_deliveries SET status = ?, attempt = ?, response_code = ?, delivered_at = ?, next_retry_at = ? WHERE id = ?`,
		[fields.status, fields.attempt, fields.responseCode, fields.deliveredAt, fields.nextRetryAt, id],
	);
}

/** Recent webhook delivery attempts for a merchant (joined with event + endpoint). */
export type WebhookDeliveryView = {
	id: string;
	eventId: string;
	endpointId: string;
	attempt: number;
	status: string;
	responseCode: number | null;
	eventType: string;
	url: string;
	nextRetryAt: string | null;
	deliveredAt: string | null;
	createdAt: string;
};

export async function listWebhookDeliveriesByMerchant(
	env: Bindings,
	merchantId: string,
	limit = 50,
): Promise<WebhookDeliveryView[]> {
	const rows = await d1All<{
		id: string; event_id: string; endpoint_id: string; attempt: number; status: string;
		response_code: number | null; next_retry_at: string | null; delivered_at: string | null;
		created_at: string; event_type: string; url: string;
	}>(
		env,
		`SELECT d.id, d.event_id, d.endpoint_id, d.attempt, d.status, d.response_code,
			d.next_retry_at, d.delivered_at, d.created_at, e.type AS event_type, w.url AS url
		 FROM webhook_deliveries d
		 JOIN events e ON e.id = d.event_id
		 JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 WHERE w.merchant_id = ?
		 ORDER BY d.created_at DESC LIMIT ?`,
		[merchantId, limit],
	);
	return rows.map((r) => ({
		id: r.id, eventId: r.event_id, endpointId: r.endpoint_id, attempt: r.attempt, status: r.status,
		responseCode: r.response_code, eventType: r.event_type, url: r.url, nextRetryAt: r.next_retry_at,
		deliveredAt: r.delivered_at, createdAt: r.created_at,
	}));
}

/** Re-queue a delivery for an immediate retry. Scoped to the merchant's endpoints. */
export async function requeueWebhookDelivery(env: Bindings, merchantId: string, id: string) {
	await d1Run(
		env,
		`UPDATE webhook_deliveries SET status = 'pending', attempt = 0, next_retry_at = NULL
		 WHERE id = ? AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE merchant_id = ?)`,
		[id, merchantId],
	);
	await scheduleEventJob(env, "webhook_delivery", {
		reason: "merchant_webhook_manual_resend",
	});
}

