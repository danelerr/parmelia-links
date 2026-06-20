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

type ServiceAccount = {
	project_id: string;
	client_email: string;
	private_key: string;
	token_uri: string;
};

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let cachedToken: { value: string; expiresAt: number } | null = null;

function parseServiceAccount(env: Bindings): ServiceAccount | null {
	if (!env.FCM_SERVICE_ACCOUNT) return null;
	try {
		const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
		if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
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
	});
	if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
	const data = (await res.json()) as { access_token: string; expires_in: number };
	cachedToken = { value: data.access_token, expiresAt: now + data.expires_in };
	return data.access_token;
}

/** Result of a single send: delivered, token is dead (prune it), or a transient
 *  error (keep the token - a retry may succeed). */
type SendResult = "ok" | "dead" | "error";

/**
 * Send a push to a single device token. Returns "dead" ONLY when FCM says the
 * token is gone (404 / UNREGISTERED), so transient failures never prune a valid
 * token. Never throws.
 */
async function sendToToken(
	env: Bindings,
	token: string,
	payload: { title: string; body: string; link?: string },
): Promise<SendResult> {
	const sa = parseServiceAccount(env);
	if (!sa) return "error";
	try {
		const accessToken = await getAccessToken(sa);
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
						notification: { title: payload.title, body: payload.body },
						data: { title: payload.title, body: payload.body, link: payload.link ?? "/" },
						webpush: {
							notification: { icon: "/parmelia.svg", badge: "/parmelia.svg" },
							fcm_options: { link: payload.link ?? "/" },
						},
					},
				}),
			},
		);
		if (res.ok) return "ok";
		// 404 / UNREGISTERED → the token is dead; the caller prunes it.
		if (res.status === 404) return "dead";
		logError("push_send_failed", new Error(`FCM ${res.status}`), {});
		return "error";
	} catch (error) {
		logError("push_send_error", error, {});
		return "error";
	}
}

/**
 * Notify a Parmelia user by uid across ALL their registered devices. Best-effort:
 * sends to every token in parallel and prunes any token FCM reports as dead. Safe
 * to await-or-ignore inside a payment flow - it swallows all errors.
 */
export async function notifyUser(
	env: Bindings,
	uid: string,
	payload: { title: string; body: string; link?: string },
): Promise<void> {
	try {
		if (!env.FCM_SERVICE_ACCOUNT) return;
		const tokens = await listPushTokens(env, uid);
		if (tokens.length === 0) return;
		await Promise.all(
			tokens.map(async (token) => {
				const result = await sendToToken(env, token, payload);
				if (result === "dead") await deletePushToken(env, token).catch(() => {});
			}),
		);
	} catch (error) {
		logError("notify_user_error", error, {});
	}
}
