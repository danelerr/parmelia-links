// Webhook delivery: signed, retried, outbox-backed (Cloudflare-native, no Queues).
//
// emitEvent() writes an immutable `events` row and one `webhook_deliveries` row
// per matching enabled endpoint. An event job runs deliverPendingWebhooks(),
// which signs and POSTs each due delivery,
// retrying with exponential backoff. Payloads are HMAC-SHA256 signed so the
// merchant can verify authenticity and reject replays.

import type { Bindings } from "../middlewares/auth";
import type { ApiKeyMode } from "./apiKeys";
import {
	claimWebhookDelivery,
	enqueueEventOutbox,
	listDueWebhookDeliveries,
	listEnabledEndpoints,
	listWebhookSecretsNeedingEncryption,
	replaceWebhookSecret,
	updateWebhookDelivery,
	type EventOutboxPlan,
} from "./storage";
import { logError } from "./logger";
import { discardResponseBody } from "./http";
import {
	activeWebhookSecretPrefix,
	decryptWebhookSecret,
	rotateWebhookSecret,
} from "./webhookSecrets";

const MAX_ATTEMPTS = 6;
// Backoff per attempt number (minutes): ~1m, 5m, 30m, 2h, 6h, 24h.
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 1440];
// Per-delivery POST timeout. 6s keeps a full batch well under Worker limits
// (25 sequential 10s posts could theoretically pile up 250s of I/O).
const DELIVERY_TIMEOUT_MS = 6000;
// How many endpoints we POST concurrently per flush.
const DELIVERY_CONCURRENCY = 5;
// Claim lease: if the Worker dies mid-POST, the delivery retries after this.
const CLAIM_LEASE_MS = 120_000;

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(message: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
	return toHex(digest);
}

/** HMAC-SHA256 hex of `message` under `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return toHex(sig);
}

/**
 * Build a deterministic event and its endpoint deliveries. Retrying the same
 * domain event produces the same primary keys and cannot duplicate webhooks.
 */
export async function prepareEventOutbox(
	env: Bindings,
	params: {
		merchantId: string;
		mode: ApiKeyMode;
		type: string;
		objectId: string | null;
		data: Record<string, unknown>;
	},
): Promise<EventOutboxPlan> {
	const now = new Date().toISOString();
	const eventKey = [params.merchantId, params.mode, params.type, params.objectId ?? ""].join(":");
	const eventId = `evt_${(await sha256Hex(eventKey)).slice(0, 40)}`;
	const endpoints = await listEnabledEndpoints(env, params.merchantId, params.mode);
	const deliveries = await Promise.all(
		endpoints
			.filter((ep) => !ep.enabledEvents || ep.enabledEvents.includes(params.type))
			.map(async (ep) => ({
				id: `whd_${(await sha256Hex(`${eventId}:${ep.id}`)).slice(0, 40)}`,
				endpointId: ep.id,
				createdAt: now,
			})),
	);
	return {
		event: {
			id: eventId,
			merchantId: params.merchantId,
			type: params.type,
			objectId: params.objectId,
			payload: params.data,
			mode: params.mode,
			createdAt: now,
		},
		deliveries,
	};
}

/** Atomically persist an event and every subscribed endpoint delivery. */
export async function emitEvent(
	env: Bindings,
	params: Parameters<typeof prepareEventOutbox>[1],
): Promise<string> {
	const plan = await prepareEventOutbox(env, params);
	await enqueueEventOutbox(env, plan);
	return plan.event.id;
}

/** Sign + POST one claimed delivery and persist its final state. */
async function deliverOne(
	env: Bindings,
	d: Awaited<ReturnType<typeof listDueWebhookDeliveries>>[number],
): Promise<void> {
	const attempt = d.attempt + 1;
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const body = JSON.stringify({
		id: d.eventId,
		type: d.eventType,
		created: d.eventCreatedAt,
		data: JSON.parse(d.eventPayload),
	});
	const signature = await hmacSha256Hex(await decryptWebhookSecret(env, d.secret), `${timestamp}.${body}`);

	let ok = false;
	let responseCode: number | null = null;
	try {
		const res = await fetch(d.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Parmelia-Signature": signature,
				"Parmelia-Timestamp": timestamp,
				"Parmelia-Event-Id": d.eventId,
			},
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
		});
		responseCode = res.status;
		ok = res.ok;
		await discardResponseBody(res);
	} catch {
		ok = false;
	}

	if (ok) {
		await updateWebhookDelivery(env, d.id, {
			status: "delivered",
			attempt,
			responseCode,
			deliveredAt: new Date().toISOString(),
			nextRetryAt: null,
		});
	} else if (attempt >= MAX_ATTEMPTS) {
		await updateWebhookDelivery(env, d.id, {
			status: "failed",
			attempt,
			responseCode,
			deliveredAt: null,
			nextRetryAt: null,
		});
	} else {
		const delayMin = BACKOFF_MINUTES[attempt - 1] ?? 1440;
		await updateWebhookDelivery(env, d.id, {
			status: "pending",
			attempt,
			responseCode,
			deliveredAt: null,
			nextRetryAt: new Date(Date.now() + delayMin * 60_000).toISOString(),
		});
	}
}

/**
 * Deliver all due pending webhook deliveries. Each row
 * is CLAIMED first (atomic lease on next_retry_at), so overlapping flushes —
 * overlapping at-least-once deliveries never double-POST the same
 * delivery. Claimed rows are delivered in small concurrent batches so one slow
 * endpoint can't serialize the whole flush. Never throws.
 */
export async function deliverPendingWebhooks(env: Bindings, limit = 25): Promise<void> {
	try {
		const due = await listDueWebhookDeliveries(env, limit);
		for (let i = 0; i < due.length; i += DELIVERY_CONCURRENCY) {
			const batch = due.slice(i, i + DELIVERY_CONCURRENCY);
			const claims = await Promise.all(batch.map((d) => claimWebhookDelivery(env, d.id, CLAIM_LEASE_MS)));
			const mine = batch.filter((_, idx) => claims[idx]);
			await Promise.all(
				mine.map((d) =>
					deliverOne(env, d).catch((error) => logError("webhook_deliver_one_failed", error, { deliveryId: d.id })),
				),
			);
		}
	} catch (error) {
		logError("webhook_deliver_failed", error, {});
	}
}

/** Gradually encrypt or re-key endpoint secrets without clobbering concurrent edits. */
export async function migrateWebhookSecrets(env: Bindings, limit = 25): Promise<void> {
	try {
		const activePrefix = activeWebhookSecretPrefix(env);
		if (!activePrefix) return;
		const rows = await listWebhookSecretsNeedingEncryption(env, activePrefix, limit);
		for (const row of rows) {
			try {
				const encrypted = await rotateWebhookSecret(env, row.secret);
				if (encrypted !== row.secret) await replaceWebhookSecret(env, row.id, row.secret, encrypted);
			} catch (error) {
				logError("webhook_secret_rotation_failed", error, { endpointId: row.id });
			}
		}
	} catch (error) {
		logError("webhook_secret_migration_failed", error, {});
	}
}
