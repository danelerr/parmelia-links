import type { Bindings } from "../middlewares/auth";
import {
	FirebaseAccountDisabledError,
	FirebaseVerifiedEmailUnavailableError,
	getVerifiedFirebaseEmailForUid,
} from "./googleServiceAccount";
import { logError, logInfo, logWarn } from "./logger";
import { invalidateUserHome, notifyUser } from "./push";
import {
	sendSecurityAlertEmail,
	type SecurityEmailEvent,
} from "./transactionalEmail";

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 12;
const NOTIFICATION_EVENT_TYPES = new Set([
	"security.recovery_proposed",
	"security.recovery_executed",
	"security.recovery_cancelled",
	"activity.deposit_received",
	"activity.payment_received",
]);
const SECURITY_EVENT_TYPES = new Set<SecurityEmailEvent>([
	"security.recovery_proposed",
	"security.recovery_executed",
	"security.recovery_cancelled",
]);

type OutboxRow = {
	id: string;
	uid: string;
	event_type: string;
	payload_json: string;
	attempt_count: number;
};

type SecurityNotificationPayload = {
	title: string;
	body: string;
	link?: string;
};

function retryDelayMs(attempt: number): number {
	return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(10, attempt));
}

function parseSecurityNotification(value: string): SecurityNotificationPayload | null {
	try {
		const parsed = JSON.parse(value) as Partial<SecurityNotificationPayload>;
		if (
			!parsed ||
			typeof parsed.title !== "string" ||
			typeof parsed.body !== "string" ||
			(parsed.link !== undefined && typeof parsed.link !== "string") ||
			parsed.title.length > 160 ||
			parsed.body.length > 500
		) {
			return null;
		}
		return {
			title: parsed.title,
			body: parsed.body,
			link: parsed.link,
		};
	} catch {
		return null;
	}
}

function isSecurityEventType(value: string): value is SecurityEmailEvent {
	return SECURITY_EVENT_TYPES.has(value as SecurityEmailEvent);
}

async function listDue(env: Bindings, limit: number): Promise<OutboxRow[]> {
	const result = await env.GATOPAGO_DB.prepare(
		`SELECT id, uid, event_type, payload_json, attempt_count
		 FROM user_event_outbox
		 WHERE (
		 	status IN ('pending', 'failed') AND next_attempt_at <= ?
		 ) OR (
		 	status = 'processing' AND lease_expires_at <= ?
		 )
		 ORDER BY priority ASC, created_at ASC
		 LIMIT ?`,
	)
		.bind(new Date().toISOString(), new Date().toISOString(), limit)
		.all<OutboxRow>();
	return result.results;
}

async function claim(env: Bindings, row: OutboxRow): Promise<string | null> {
	const owner = crypto.randomUUID();
	const now = new Date();
	const result = await env.GATOPAGO_DB.prepare(
		`UPDATE user_event_outbox
		 SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
		     attempt_count = attempt_count + 1, updated_at = ?
		 WHERE id = ? AND (
		 	(status IN ('pending', 'failed') AND next_attempt_at <= ?)
		 	OR (status = 'processing' AND lease_expires_at <= ?)
		 )`,
	)
		.bind(
			owner,
			new Date(now.getTime() + LEASE_MS).toISOString(),
			now.toISOString(),
			row.id,
			now.toISOString(),
			now.toISOString(),
		)
		.run();
	return (result.meta?.changes ?? 0) > 0 ? owner : null;
}

async function complete(
	env: Bindings,
	id: string,
	owner: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.GATOPAGO_DB.prepare(
		`UPDATE user_event_outbox
		 SET status = 'delivered', delivered_at = ?, updated_at = ?,
		     lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL
		 WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
	)
		.bind(now, now, id, owner)
		.run();
}

async function completeHomeInvalidations(
	env: Bindings,
	row: OutboxRow,
	owner: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`UPDATE user_event_outbox
			 SET status = 'delivered', delivered_at = ?, updated_at = ?,
			     lease_owner = NULL, lease_expires_at = NULL,
			     last_error_code = NULL
			 WHERE uid = ? AND event_type = 'home.invalidate'
			   AND status IN ('pending', 'failed')`,
		).bind(now, now, row.uid),
		env.GATOPAGO_DB.prepare(
			`UPDATE user_event_outbox
			 SET status = 'delivered', delivered_at = ?, updated_at = ?,
			     lease_owner = NULL, lease_expires_at = NULL,
			     last_error_code = NULL
			 WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
		).bind(now, now, row.id, owner),
	]);
}

async function fail(
	env: Bindings,
	row: OutboxRow,
	owner: string,
	errorCode: string,
): Promise<void> {
	const now = new Date();
	const terminal = row.attempt_count + 1 >= MAX_ATTEMPTS;
	await env.GATOPAGO_DB.prepare(
		`UPDATE user_event_outbox
		 SET status = ?, next_attempt_at = ?, updated_at = ?,
		     lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?
		 WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
	)
		.bind(
			terminal ? "dead" : "failed",
			new Date(
				now.getTime() +
					(terminal ? 0 : retryDelayMs(row.attempt_count)),
			).toISOString(),
			now.toISOString(),
			terminal ? `TERMINAL_${errorCode}` : errorCode,
			row.id,
			owner,
		)
		.run();
	if (terminal) {
		logError("user_event_outbox_terminal", new Error(errorCode), {
			eventType: row.event_type,
			attempts: row.attempt_count + 1,
		});
	}
}

/** Deliver durable security/user effects. Safe to run concurrently or retry. */
export async function drainUserEventOutbox(
	env: Bindings,
	limit = 25,
): Promise<void> {
	const due = await listDue(env, limit);
	let delivered = 0;
	let failed = 0;
	for (const row of due) {
		const owner = await claim(env, row);
		if (!owner) continue;
		try {
			if (row.event_type === "home.invalidate") {
				const version = await env.GATOPAGO_DB.prepare(
					`SELECT version FROM home_state_versions WHERE uid = ?`,
				)
					.bind(row.uid)
					.first<{ version: number }>();
				const result = await invalidateUserHome(
					env,
					row.uid,
					`home:${version?.version ?? 1}`,
				);
				// Home has a periodic safety refresh, so lack of an optional push
				// transport is not a retryable failure. Completing these rows keeps
				// installations without FCM from accumulating an unbounded backlog.
				if (!result.configured) {
					await completeHomeInvalidations(env, row, owner);
					delivered++;
					continue;
				}
				if (result.failed > 0) {
					await fail(
						env,
						row,
						owner,
						"PUSH_TRANSIENT",
					);
					failed++;
					continue;
				}
				// One latest-version invalidation subsumes every older pending row
				// for the same user.
				await completeHomeInvalidations(env, row, owner);
				delivered++;
				continue;
			}
			if (!NOTIFICATION_EVENT_TYPES.has(row.event_type)) {
				await fail(env, row, owner, "UNSUPPORTED_EVENT_TYPE");
				failed++;
				continue;
			}
			const payload = parseSecurityNotification(row.payload_json);
			if (!payload) {
				await fail(env, row, owner, "INVALID_PAYLOAD");
				failed++;
				continue;
			}
			let deliveredByEmail = false;
			if (isSecurityEventType(row.event_type)) {
				try {
					const email = await getVerifiedFirebaseEmailForUid(env, row.uid);
					await sendSecurityAlertEmail(env, {
						to: email,
						eventType: row.event_type,
						link: payload.link,
						idempotencyKey: `security_${row.id.replaceAll("-", "_")}`,
					});
					deliveredByEmail = true;
				} catch (error) {
					if (
						!(error instanceof FirebaseVerifiedEmailUnavailableError) &&
						!(error instanceof FirebaseAccountDisabledError)
					) {
						// Email alerts are defense in depth, not the transport gate for
						// Firebase authentication. Continue to FCM so a temporary or
						// unconfigured mail channel cannot strand the durable outbox.
						logWarn("security_email_delivery_failed", {
							eventType: row.event_type,
							errorName: error instanceof Error ? error.name : "unknown",
						});
					}
				}
			}

			let result: Awaited<ReturnType<typeof notifyUser>> | null = null;
			try {
				result = await notifyUser(env, row.uid, payload);
			} catch (error) {
				if (!deliveredByEmail) throw error;
				logWarn("security_push_delivery_failed_after_email", {
					eventType: row.event_type,
					errorName: error instanceof Error ? error.name : "unknown",
				});
			}
			if (
				!deliveredByEmail &&
				(!result?.configured || result.failed > 0)
			) {
				await fail(
					env,
					row,
					owner,
					result?.configured ? "PUSH_TRANSIENT" : "PUSH_NOT_CONFIGURED",
				);
				failed++;
				continue;
			}
			await complete(env, row.id, owner);
			delivered++;
		} catch (error) {
			await fail(env, row, owner, "DELIVERY_EXCEPTION");
			logWarn("user_event_outbox_delivery_failed", {
				eventType: row.event_type,
				errorName: error instanceof Error ? error.name : "unknown",
			});
			failed++;
		}
	}
	if (due.length > 0) {
		logInfo("user_event_outbox_drain", {
			due: due.length,
			delivered,
			failed,
		});
	}
}

export const __test = {
	parseSecurityNotification,
	retryDelayMs,
};
