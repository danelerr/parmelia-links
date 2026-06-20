// Webhook delivery: signed, retried, outbox-backed (Cloudflare-native, no Queues).
//
// emitEvent() writes an immutable `events` row and one `webhook_deliveries` row
// per matching enabled endpoint. deliverPendingWebhooks() (called from the cron
// and kicked immediately after an event) signs and POSTs each due delivery,
// retrying with exponential backoff. Payloads are HMAC-SHA256 signed so the
// merchant can verify authenticity and reject replays.

import type { Bindings } from "../middlewares/auth";
import type { ApiKeyMode } from "./apiKeys";
import {
	createEvent,
	createWebhookDelivery,
	listDueWebhookDeliveries,
	listEnabledEndpoints,
	updateWebhookDelivery,
} from "./storage";
import { logError } from "./logger";

const MAX_ATTEMPTS = 6;
// Backoff per attempt number (minutes): ~1m, 5m, 30m, 2h, 6h, 24h.
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 1440];

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
 * Record an event and enqueue a delivery for every enabled endpoint of this
 * merchant + mode that subscribes to the event type. Best-effort; never throws.
 */
export async function emitEvent(
	env: Bindings,
	params: {
		merchantId: string;
		mode: ApiKeyMode;
		type: string;
		objectId: string | null;
		data: Record<string, unknown>;
	},
): Promise<string | null> {
	try {
		const now = new Date().toISOString();
		const eventId = `evt_${crypto.randomUUID().replace(/-/g, "")}`;
		await createEvent(env, {
			id: eventId,
			merchantId: params.merchantId,
			type: params.type,
			objectId: params.objectId,
			payload: params.data,
			mode: params.mode,
			createdAt: now,
		});

		const endpoints = await listEnabledEndpoints(env, params.merchantId, params.mode);
		for (const ep of endpoints) {
			if (ep.enabledEvents && !ep.enabledEvents.includes(params.type)) continue;
			await createWebhookDelivery(env, {
				id: `whd_${crypto.randomUUID().replace(/-/g, "")}`,
				eventId,
				endpointId: ep.id,
				attempt: 0,
				status: "pending",
				nextRetryAt: now,
				createdAt: now,
			});
		}
		return eventId;
	} catch (error) {
		logError("webhook_emit_failed", error, {});
		return null;
	}
}

/**
 * Deliver all due pending webhook deliveries (cron + immediate flush). Each is
 * signed with the endpoint secret; failures are retried with backoff until
 * MAX_ATTEMPTS, then marked failed. Never throws.
 */
export async function deliverPendingWebhooks(env: Bindings, limit = 25): Promise<void> {
	try {
		const due = await listDueWebhookDeliveries(env, limit);
		for (const d of due) {
			const attempt = d.attempt + 1;
			const timestamp = Math.floor(Date.now() / 1000).toString();
			const body = JSON.stringify({
				id: d.eventId,
				type: d.eventType,
				created: d.eventCreatedAt,
				data: JSON.parse(d.eventPayload),
			});
			const signature = await hmacSha256Hex(d.secret, `${timestamp}.${body}`);

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
					signal: AbortSignal.timeout(10000),
				});
				responseCode = res.status;
				ok = res.ok;
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
	} catch (error) {
		logError("webhook_deliver_failed", error, {});
	}
}
