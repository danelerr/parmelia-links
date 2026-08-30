import type { Bindings } from "../env";
import {
	emailOtpRateLimitKeys,
	normalizeEmail,
	randomStepUpToken,
	STEP_UP_TTL_SECONDS,
	stepUpTokenHash,
} from "./emailOtp";
import { discardResponseBody, readJsonBounded } from "./http";

const FIREBASE_SEND_OOB_URL =
	"https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode";
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_MAX_BYTES = 16 * 1024;
const RECOVERY_LINK_TTL_SECONDS = 10 * 60;
const RESEND_AFTER_SECONDS = 60;

export type RecoveryEmailLinkAction = "start" | "execute";

type RecoveryChallengeRow = {
	id: string;
	uid: string;
	action: RecoveryEmailLinkAction;
	token_hash: string;
	expires_at: string;
	created_at: string;
};

export class FirebaseEmailLinkConfigurationError extends Error {
	constructor(message = "Firebase email-link authentication is not configured") {
		super(message);
		this.name = "FirebaseEmailLinkConfigurationError";
	}
}

export class FirebaseEmailLinkUnavailableError extends Error {
	constructor(message = "Firebase could not send the email link") {
		super(message);
		this.name = "FirebaseEmailLinkUnavailableError";
	}
}

export class InvalidEmailLinkChallengeError extends Error {
	constructor() {
		super("Email-link challenge is invalid or expired");
		this.name = "InvalidEmailLinkChallengeError";
	}
}

function firebaseWebApiKey(env: Bindings): string {
	const value = env.FIREBASE_WEB_API_KEY?.trim();
	if (!value || value.length > 256 || /\s/u.test(value)) {
		throw new FirebaseEmailLinkConfigurationError("FIREBASE_WEB_API_KEY is invalid");
	}
	return value;
}

function configuredAppOrigin(env: Bindings): string {
	const value = env.APP_URL?.trim();
	if (!value) throw new FirebaseEmailLinkConfigurationError("APP_URL is required");
	try {
		const url = new URL(value);
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
		if ((!local && url.protocol !== "https:") || (local && !["http:", "https:"].includes(url.protocol))) {
			throw new Error("unsupported protocol");
		}
		return url.origin;
	} catch {
		throw new FirebaseEmailLinkConfigurationError("APP_URL must be a valid application origin");
	}
}

export function emailLinkContinueUrl(
	env: Bindings,
	input: { flow: "signin" } | { flow: "recovery"; challenge: string },
): string {
	const url = new URL("/login", configuredAppOrigin(env));
	url.searchParams.set("flow", input.flow);
	if (input.flow === "recovery") url.searchParams.set("challenge", input.challenge);
	return url.toString();
}

export async function sendFirebaseEmailLink(
	env: Bindings,
	input: { email: string; locale: "es" | "en"; continueUrl: string },
): Promise<void> {
	const email = normalizeEmail(input.email);
	if (!email) throw new FirebaseEmailLinkConfigurationError("Email address is invalid");
	let response: Response;
	try {
		response = await fetch(
			`${FIREBASE_SEND_OOB_URL}?key=${encodeURIComponent(firebaseWebApiKey(env))}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Firebase-Locale": input.locale,
				},
				body: JSON.stringify({
					requestType: "EMAIL_SIGNIN",
					email,
					continueUrl: input.continueUrl,
					canHandleCodeInApp: true,
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
	} catch (error) {
		throw new FirebaseEmailLinkUnavailableError(
			error instanceof DOMException && error.name === "TimeoutError"
				? "Firebase email-link request timed out"
				: undefined,
		);
	}
	if (!response.ok) {
		await discardResponseBody(response);
		throw new FirebaseEmailLinkUnavailableError(
			`Firebase email-link request failed with HTTP ${response.status}`,
		);
	}
	const payload = await readJsonBounded<{ email?: string }>(response, RESPONSE_MAX_BYTES)
		.catch(() => {
			throw new FirebaseEmailLinkUnavailableError("Firebase email-link response was invalid");
		});
	if (normalizeEmail(payload.email) !== email) {
		throw new FirebaseEmailLinkUnavailableError("Firebase did not confirm the email-link recipient");
	}
}

function randomOpaqueToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const value of bytes) binary += String.fromCharCode(value);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function challengeTokenHash(env: Bindings, token: string): Promise<string> {
	return (await emailOtpRateLimitKeys(env, `recovery-link:${token}`, "challenge")).email;
}

export async function issueRecoveryEmailLink(
	env: Bindings,
	input: {
		uid: string;
		email: string;
		action: RecoveryEmailLinkAction;
		locale: "es" | "en";
	},
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
	const id = crypto.randomUUID();
	const challenge = randomOpaqueToken();
	const tokenHash = await challengeTokenHash(env, challenge);
	const now = new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + RECOVERY_LINK_TTL_SECONDS * 1_000).toISOString();

	await env.GATOPAGO_DB.prepare(
		`INSERT INTO auth_email_link_challenges (
			id, uid, action, token_hash, expires_at, consumed_at,
			consumption_id, created_at
		 ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
	).bind(id, input.uid, input.action, tokenHash, expiresAt, createdAt).run();

	try {
		await sendFirebaseEmailLink(env, {
			email: input.email,
			locale: input.locale,
			continueUrl: emailLinkContinueUrl(env, { flow: "recovery", challenge }),
		});
	} catch (error) {
		await env.GATOPAGO_DB.prepare(
			"DELETE FROM auth_email_link_challenges WHERE id = ? AND consumed_at IS NULL",
		).bind(id).run().catch(() => undefined);
		throw error;
	}

	// Keep a previously delivered link valid when a replacement send fails. Once
	// Firebase accepts the new message, older unconsumed links are retired.
	await env.GATOPAGO_DB.prepare(
		`UPDATE auth_email_link_challenges
		 SET consumed_at = ?
		 WHERE uid = ? AND action = ? AND consumed_at IS NULL
		   AND (created_at < ? OR (created_at = ? AND id < ?))`,
	).bind(createdAt, input.uid, input.action, createdAt, createdAt, id).run();

	return {
		expiresInSeconds: RECOVERY_LINK_TTL_SECONDS,
		resendAfterSeconds: RESEND_AFTER_SECONDS,
	};
}

function recentEnoughAuthTime(authTime: number | undefined, createdAt: string): boolean {
	if (!Number.isSafeInteger(authTime) || !authTime) return false;
	const nowSeconds = Math.floor(Date.now() / 1_000);
	const createdSeconds = Math.floor(Date.parse(createdAt) / 1_000);
	if (!Number.isFinite(createdSeconds)) return false;
	return (
		authTime >= createdSeconds - 5 &&
		authTime <= nowSeconds + 60 &&
		nowSeconds - authTime <= RECOVERY_LINK_TTL_SECONDS + 60
	);
}

export async function exchangeRecoveryEmailLink(
	env: Bindings,
	input: { uid: string; challenge: string; authTime: number | undefined },
): Promise<{
	stepUpToken: string;
	action: RecoveryEmailLinkAction;
	expiresInSeconds: number;
}> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) {
		throw new InvalidEmailLinkChallengeError();
	}
	const tokenHash = await challengeTokenHash(env, input.challenge);
	const now = new Date();
	const nowIso = now.toISOString();
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT id, uid, action, token_hash, expires_at, created_at
		 FROM auth_email_link_challenges
		 WHERE token_hash = ? AND uid = ? AND consumed_at IS NULL
		   AND expires_at > ?
		 LIMIT 1`,
	).bind(tokenHash, input.uid, nowIso).first<RecoveryChallengeRow>();
	if (!row || !recentEnoughAuthTime(input.authTime, row.created_at)) {
		throw new InvalidEmailLinkChallengeError();
	}

	const stepUpToken = randomStepUpToken();
	const stepUpHash = await stepUpTokenHash(env, stepUpToken);
	const stepUpId = crypto.randomUUID();
	const consumptionId = crypto.randomUUID();
	const expiresAt = new Date(now.getTime() + STEP_UP_TTL_SECONDS * 1_000).toISOString();
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`UPDATE auth_email_link_challenges
			 SET consumed_at = ?, consumption_id = ?
			 WHERE id = ? AND uid = ? AND token_hash = ?
			   AND consumed_at IS NULL AND expires_at > ?`,
		).bind(nowIso, consumptionId, row.id, input.uid, tokenHash, nowIso),
		env.GATOPAGO_DB.prepare(
			`INSERT INTO auth_step_up_sessions (
				id, uid, scope, token_hash, expires_at, consumed_at, created_at
			 )
			 SELECT ?, ?, 'recovery', ?, ?, NULL, ?
			 WHERE EXISTS (
				SELECT 1 FROM auth_email_link_challenges
				WHERE id = ? AND consumption_id = ? AND consumed_at = ?
			 )`,
		).bind(
			stepUpId,
			input.uid,
			stepUpHash,
			expiresAt,
			nowIso,
			row.id,
			consumptionId,
			nowIso,
		),
	]);
	if (
		!results[0]?.success ||
		!results[1]?.success ||
		results[0].meta.changes !== 1 ||
		results[1].meta.changes !== 1
	) {
		throw new InvalidEmailLinkChallengeError();
	}

	return {
		stepUpToken,
		action: row.action,
		expiresInSeconds: STEP_UP_TTL_SECONDS,
	};
}

export const __test = {
	RECOVERY_LINK_TTL_SECONDS,
	RESEND_AFTER_SECONDS,
	randomOpaqueToken,
	recentEnoughAuthTime,
};
