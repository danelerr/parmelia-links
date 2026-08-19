// FCM web push (Firebase Cloud Messaging HTTP v1).
//
// Feature-flagged: if FCM_SERVICE_ACCOUNT is unset, every call is a no-op so
// payments never depend on push being configured. Sends are best-effort and
// must NEVER throw into a payment path.
//
// Auth: mint a short-lived OAuth2 access token from the service account
// (JWT-bearer grant, RS256 via jose) and call messages:send. The token is
// cached in module scope for the worker isolate's lifetime.

import { importPKCS8, SignJWT } from "jose";
import type { Bindings } from "../middlewares/auth";
import { listPushTokens, deletePushToken } from "./storage";
import { logError } from "./logger";
import { discardResponseBody, readJsonBounded } from "./http";

type ServiceAccount = {
	project_id: string;
	client_email: string;
	private_key: string;
	token_uri: string;
};

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_TIMEOUT_MS = 5_000;
const TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;

let cachedToken: { value: string; expiresAt: number } | null = null;

function parseServiceAccount(env: Bindings): ServiceAccount | null {
	if (!env.FCM_SERVICE_ACCOUNT) return null;
	try {
		const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
		if (!sa.client_email || !sa.private_key || !sa.project_id || sa.token_uri !== GOOGLE_TOKEN_URL) return null;
		return sa;
	} catch {
		return null;
	}
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

	const key = await importPKCS8(sa.private_key, "RS256");
	const assertion = await new SignJWT({ scope: FCM_SCOPE })
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(sa.client_email)
		.setSubject(sa.client_email)
		.setAudience(sa.token_uri)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(key);

	const res = await fetch(sa.token_uri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
		signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
	});
	if (!res.ok) {
		await discardResponseBody(res);
		throw new Error(`token exchange failed: ${res.status}`);
	}
	const data = await readJsonBounded<{ access_token: string; expires_in: number }>(
		res,
		TOKEN_RESPONSE_MAX_BYTES,
	);
	cachedToken = { value: data.access_token, expiresAt: now + data.expires_in };
	return data.access_token;
}

/** Result of a single send: delivered, token is dead (prune it), or a transient
 *  error (keep the token - a retry may succeed). */
type SendResult = "ok" | "dead" | "error";

export type PushDeliveryResult = {
	configured: boolean;
	devices: number;
	delivered: number;
	dead: number;
	failed: number;
};

/**
 * Send a push to a single device token. Returns "dead" ONLY when FCM says the
 * token is gone (404 / UNREGISTERED), so transient failures never prune a valid
 * token. Never throws.
 */
async function sendToToken(
	env: Bindings,
	token: string,
	payload:
		| { kind: "notification"; title: string; body: string; link?: string }
		| { kind: "home_invalidation"; stateVersion: string },
): Promise<SendResult> {
	const sa = parseServiceAccount(env);
	if (!sa) return "error";
	try {
		const accessToken = await getAccessToken(sa);
		const notification =
			payload.kind === "notification"
				? { title: payload.title, body: payload.body }
				: undefined;
		const data =
			payload.kind === "notification"
				? {
						type: "notification",
						title: payload.title,
						body: payload.body,
						link: payload.link ?? "/",
					}
				: {
						type: "home.invalidate",
						stateVersion: payload.stateVersion,
						link: "/",
					};
		const webpush =
			payload.kind === "notification"
				? {
						notification: {
							icon: "/gatopago.svg",
							badge: "/badge-96.png",
						},
						fcm_options: { link: payload.link ?? "/" },
					}
				: {
						headers: { Urgency: "normal" },
					};
		const res = await fetch(
			`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: {
						token,
						...(notification ? { notification } : {}),
						data,
						webpush,
					},
				}),
				signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
			},
		);
		const ok = res.ok;
		const status = res.status;
		await discardResponseBody(res);
		if (ok) return "ok";
		// 404 / UNREGISTERED → the token is dead; the caller prunes it.
		if (status === 404) return "dead";
		logError("push_send_failed", new Error(`FCM ${status}`), {});
		return "error";
	} catch (error) {
		logError("push_send_error", error, {});
		return "error";
	}
}

/**
 * Notify a GatoPago user by uid across ALL their registered devices. Best-effort:
 * sends to every token in parallel and prunes any token FCM reports as dead. Safe
 * to await-or-ignore inside a payment flow - it swallows all errors.
 */
export async function notifyUser(
	env: Bindings,
	uid: string,
	payload: { title: string; body: string; link?: string },
): Promise<PushDeliveryResult> {
	try {
		if (!env.FCM_SERVICE_ACCOUNT) {
			return {
				configured: false,
				devices: 0,
				delivered: 0,
				dead: 0,
				failed: 0,
			};
		}
		const tokens = await listPushTokens(env, uid);
		if (tokens.length === 0) {
			return {
				configured: true,
				devices: 0,
				delivered: 0,
				dead: 0,
				failed: 0,
			};
		}
		const results = await Promise.all(
			tokens.map(async (token) => {
				const result = await sendToToken(env, token, {
					kind: "notification",
					...payload,
				});
				if (result === "dead") await deletePushToken(env, token).catch(() => {});
				return result;
			}),
		);
		return {
			configured: true,
			devices: tokens.length,
			delivered: results.filter((result) => result === "ok").length,
			dead: results.filter((result) => result === "dead").length,
			failed: results.filter((result) => result === "error").length,
		};
	} catch (error) {
		logError("notify_user_error", error, {});
		return {
			configured: Boolean(env.FCM_SERVICE_ACCOUNT),
			devices: 0,
			delivered: 0,
			dead: 0,
			failed: 1,
		};
	}
}

export async function invalidateUserHome(
	env: Bindings,
	uid: string,
	stateVersion: string,
): Promise<PushDeliveryResult> {
	try {
		if (!env.FCM_SERVICE_ACCOUNT) {
			return {
				configured: false,
				devices: 0,
				delivered: 0,
				dead: 0,
				failed: 0,
			};
		}
		const tokens = await listPushTokens(env, uid);
		if (tokens.length === 0) {
			return {
				configured: true,
				devices: 0,
				delivered: 0,
				dead: 0,
				failed: 0,
			};
		}
		const results = await Promise.all(
			tokens.map(async (token) => {
				const result = await sendToToken(env, token, {
					kind: "home_invalidation",
					stateVersion,
				});
				if (result === "dead") {
					await deletePushToken(env, token).catch(() => {});
				}
				return result;
			}),
		);
		return {
			configured: true,
			devices: tokens.length,
			delivered: results.filter((result) => result === "ok").length,
			dead: results.filter((result) => result === "dead").length,
			failed: results.filter((result) => result === "error").length,
		};
	} catch (error) {
		logError("invalidate_user_home_error", error, {});
		return {
			configured: Boolean(env.FCM_SERVICE_ACCOUNT),
			devices: 0,
			delivered: 0,
			dead: 0,
			failed: 1,
		};
	}
}
