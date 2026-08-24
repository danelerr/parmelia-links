import type { Bindings } from "../env";
import { createFirebaseCustomToken, findOrCreateFirebaseEmailUser } from "./googleServiceAccount";
import { sendEmailSignInCode, sendEmailStepUpCode } from "./transactionalEmail";

const CODE_TTL_SECONDS = 10 * 60;
const RESEND_AFTER_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const STEP_UP_TTL_SECONDS = 10 * 60;

type EmailCodePurpose = "signin" | "step_up";

type CodeRow = {
	id: string;
	email_hash: string;
	code_hash: string;
	attempts: number;
	max_attempts: number;
	expires_at: string;
	claim_id: string | null;
	consumed_at: string | null;
};

type ClaimedCode = {
	row: CodeRow;
	claimId: string;
};

export class InvalidEmailCodeError extends Error {
	constructor() {
		super("Email code is invalid or expired");
		this.name = "InvalidEmailCodeError";
	}
}

export class EmailOtpConfigurationError extends Error {
	constructor(message = "Email code authentication is not configured") {
		super(message);
		this.name = "EmailOtpConfigurationError";
	}
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function pepper(env: Bindings): string {
	const value = env.AUTH_CODE_PEPPER?.trim();
	if (!value || value.length < 32) throw new EmailOtpConfigurationError();
	return value;
}

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return bytesToHex(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

function randomSixDigitCode(): string {
	// 2^24 is not divisible by 1,000,000. Reject the small upper tail so every
	// code has exactly the same probability instead of using biased modulo.
	const unbiasedCeiling = 16_000_000;
	const bytes = new Uint8Array(3);
	let value = unbiasedCeiling;
	while (value >= unbiasedCeiling) {
		crypto.getRandomValues(bytes);
		value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
	}
	return String(value % 1_000_000).padStart(6, "0");
}

export function normalizeEmail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	if (
		email.length < 3 ||
		email.length > 254 ||
		!/^\S+@\S+\.\S+$/.test(email) ||
		[...email].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	) return null;
	return email;
}

export async function emailOtpRateLimitKeys(
	env: Bindings,
	email: string,
	ip: string,
): Promise<{ email: string; ip: string }> {
	const secret = pepper(env);
	return {
		email: await hmacHex(secret, `email:${email}`),
		ip: await hmacHex(secret, `ip:${ip}`),
	};
}

async function codeHash(
	env: Bindings,
	input: { id: string; emailHash: string; code: string },
): Promise<string> {
	return hmacHex(pepper(env), `code:${input.id}:${input.emailHash}:${input.code}`);
}

async function stepUpTokenHash(env: Bindings, token: string): Promise<string> {
	return hmacHex(pepper(env), `step-up:${token}`);
}

function randomStepUpToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const value of bytes) binary += String.fromCharCode(value);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function issueEmailCode(
	env: Bindings,
	input: {
		email: string;
		ip: string;
		locale: "es" | "en";
		purpose: EmailCodePurpose;
		subjectUid?: string;
	},
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
	if (input.purpose === "step_up" && !input.subjectUid) {
		throw new EmailOtpConfigurationError("Step-up subject is required");
	}

	const id = crypto.randomUUID();
	const code = randomSixDigitCode();
	const keys = await emailOtpRateLimitKeys(env, input.email, input.ip);
	const hash = await codeHash(env, { id, emailHash: keys.email, code });
	const now = new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000).toISOString();

	await env.GATOPAGO_DB.prepare(
		`INSERT INTO auth_email_codes (
			id, email_hash, code_hash, purpose, locale, ip_hash, subject_uid,
			attempts, max_attempts, expires_at, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
	).bind(
		id,
		keys.email,
		hash,
		input.purpose,
		input.locale,
		keys.ip,
		input.subjectUid ?? null,
		MAX_ATTEMPTS,
		expiresAt,
		createdAt,
	).run();

	try {
		const send = input.purpose === "signin"
			? sendEmailSignInCode
			: sendEmailStepUpCode;
		await send(env, {
			to: input.email,
			code,
			locale: input.locale,
			expiresInMinutes: CODE_TTL_SECONDS / 60,
		});
	} catch (error) {
		await env.GATOPAGO_DB.prepare("DELETE FROM auth_email_codes WHERE id = ?")
			.bind(id)
			.run()
			.catch(() => undefined);
		throw error;
	}

	// Retire only older codes after the new message is accepted by the email
	// provider. If delivery fails, deleting the new row leaves the previous code
	// usable instead of locking the user out. The id tie-breaker also makes two
	// requests created within the same millisecond deterministic.
	await env.GATOPAGO_DB.prepare(
		`UPDATE auth_email_codes
		 SET consumed_at = ?
		 WHERE email_hash = ? AND purpose = ? AND subject_uid IS ?
		   AND consumed_at IS NULL
		   AND (created_at < ? OR (created_at = ? AND id < ?))`,
	).bind(
		createdAt,
		keys.email,
		input.purpose,
		input.subjectUid ?? null,
		createdAt,
		createdAt,
		id,
	).run();

	return {
		expiresInSeconds: CODE_TTL_SECONDS,
		resendAfterSeconds: RESEND_AFTER_SECONDS,
	};
}

export async function issueEmailSignInCode(
	env: Bindings,
	input: { email: string; ip: string; locale: "es" | "en" },
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
	return issueEmailCode(env, { ...input, purpose: "signin" });
}

export async function issueEmailStepUpCode(
	env: Bindings,
	input: { email: string; ip: string; locale: "es" | "en"; uid: string },
): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
	return issueEmailCode(env, {
		...input,
		purpose: "step_up",
		subjectUid: input.uid,
	});
}

async function claimEmailCode(
	env: Bindings,
	input: {
		email: string;
		code: string;
		purpose: EmailCodePurpose;
		subjectUid?: string;
	},
): Promise<ClaimedCode> {
	if (!/^\d{6}$/.test(input.code)) throw new InvalidEmailCodeError();
	const emailHash = (await emailOtpRateLimitKeys(env, input.email, "verification")).email;
	const now = new Date().toISOString();
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT id, email_hash, code_hash, attempts, max_attempts,
		        expires_at, claim_id, consumed_at
		 FROM auth_email_codes
		 WHERE email_hash = ? AND purpose = ? AND subject_uid IS ?
		   AND consumed_at IS NULL
		 ORDER BY created_at DESC
		 LIMIT 1`,
	).bind(emailHash, input.purpose, input.subjectUid ?? null).first<CodeRow>();

	if (!row || row.expires_at <= now || row.attempts >= row.max_attempts || row.claim_id) {
		// Keep the no-row path close to the valid-row path without revealing which
		// addresses have requested a code.
		await hmacHex(pepper(env), `dummy:${emailHash}:${input.code}`);
		throw new InvalidEmailCodeError();
	}
	// Reserve one of the five attempts atomically before checking the digest.
	// Without this update, parallel guesses could all observe the same attempts
	// value and bypass the intended online brute-force bound.
	const reserved = await env.GATOPAGO_DB.prepare(
		`UPDATE auth_email_codes
		 SET attempts = attempts + 1
		 WHERE id = ? AND consumed_at IS NULL AND claim_id IS NULL
		   AND attempts < max_attempts AND expires_at > ?`,
	).bind(row.id, now).run();
	if (!reserved.success || reserved.meta.changes !== 1) {
		await hmacHex(pepper(env), `dummy:${emailHash}:${input.code}`);
		throw new InvalidEmailCodeError();
	}

	const presentedHash = await codeHash(env, {
		id: row.id,
		emailHash: row.email_hash,
		code: input.code,
	});
	if (!constantTimeEqual(presentedHash, row.code_hash)) {
		throw new InvalidEmailCodeError();
	}

	const claimId = crypto.randomUUID();
	const claimed = await env.GATOPAGO_DB.prepare(
		`UPDATE auth_email_codes
		 SET claim_id = ?, claimed_at = ?
		 WHERE id = ? AND consumed_at IS NULL AND claim_id IS NULL
		   AND attempts <= max_attempts AND expires_at > ?`,
	).bind(claimId, now, row.id, now).run();
	if (!claimed.success || claimed.meta.changes !== 1) throw new InvalidEmailCodeError();
	return { row, claimId };
}

async function releaseEmailCodeClaim(
	env: Bindings,
	claim: ClaimedCode,
): Promise<void> {
	await env.GATOPAGO_DB.prepare(
		`UPDATE auth_email_codes
		 SET claim_id = NULL, claimed_at = NULL
		 WHERE id = ? AND claim_id = ? AND consumed_at IS NULL`,
	).bind(claim.row.id, claim.claimId).run().catch(() => undefined);
}

export async function verifyEmailSignInCode(
	env: Bindings,
	input: { email: string; code: string },
): Promise<{ customToken: string }> {
	const claim = await claimEmailCode(env, {
		...input,
		purpose: "signin",
	});

	try {
		const newUid = `email_${claim.row.email_hash.slice(0, 40)}`;
		const firebaseUser = await findOrCreateFirebaseEmailUser(env, {
			email: input.email,
			newUid,
		});
		const customToken = await createFirebaseCustomToken(env, firebaseUser.localId, {
			email_otp: true,
		});
		const consumed = await env.GATOPAGO_DB.prepare(
			`UPDATE auth_email_codes
			 SET consumed_at = ?, firebase_uid = ?
			 WHERE id = ? AND claim_id = ? AND consumed_at IS NULL`,
		).bind(
			new Date().toISOString(),
			firebaseUser.localId,
			claim.row.id,
			claim.claimId,
		).run();
		if (!consumed.success || consumed.meta.changes !== 1) {
			throw new InvalidEmailCodeError();
		}
		return { customToken };
	} catch (error) {
		await releaseEmailCodeClaim(env, claim);
		throw error;
	}
}

export async function verifyEmailStepUpCode(
	env: Bindings,
	input: { email: string; code: string; uid: string },
): Promise<{ stepUpToken: string; expiresInSeconds: number }> {
	const claim = await claimEmailCode(env, {
		email: input.email,
		code: input.code,
		purpose: "step_up",
		subjectUid: input.uid,
	});
	const stepUpToken = randomStepUpToken();
	const tokenHash = await stepUpTokenHash(env, stepUpToken);
	const now = new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + STEP_UP_TTL_SECONDS * 1_000).toISOString();
	const sessionId = crypto.randomUUID();

	try {
		const results = await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				`INSERT INTO auth_step_up_sessions (
					id, uid, scope, token_hash, expires_at, consumed_at, created_at
				 ) VALUES (?, ?, 'recovery', ?, ?, NULL, ?)`,
			).bind(sessionId, input.uid, tokenHash, expiresAt, createdAt),
			env.GATOPAGO_DB.prepare(
				`UPDATE auth_email_codes
				 SET consumed_at = ?
				 WHERE id = ? AND claim_id = ? AND consumed_at IS NULL`,
			).bind(createdAt, claim.row.id, claim.claimId),
		]);
		if (
			!results[0]?.success ||
			!results[1]?.success ||
			results[1].meta.changes !== 1
		) {
			await env.GATOPAGO_DB.prepare(
				"DELETE FROM auth_step_up_sessions WHERE id = ?",
			).bind(sessionId).run().catch(() => undefined);
			throw new InvalidEmailCodeError();
		}
		return { stepUpToken, expiresInSeconds: STEP_UP_TTL_SECONDS };
	} catch (error) {
		await releaseEmailCodeClaim(env, claim);
		throw error;
	}
}

export async function consumeRecoveryStepUp(
	env: Bindings,
	input: { uid: string; token: string | undefined },
): Promise<boolean> {
	const token = input.token?.trim() ?? "";
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
	const hash = await stepUpTokenHash(env, token);
	const now = new Date().toISOString();
	const result = await env.GATOPAGO_DB.prepare(
		`UPDATE auth_step_up_sessions
		 SET consumed_at = ?
		 WHERE uid = ? AND scope = 'recovery' AND token_hash = ?
		   AND consumed_at IS NULL AND expires_at > ?`,
	).bind(now, input.uid, hash, now).run();
	return result.success && result.meta.changes === 1;
}

/**
 * Non-consuming preflight check used before opening the OS WebAuthn sheet. The
 * same proof is consumed only by the recovery mutation itself, so a finalized
 * registration can never become a step-up bypass.
 */
export async function validateRecoveryStepUp(
	env: Bindings,
	input: { uid: string; token: string | undefined },
): Promise<boolean> {
	const token = input.token?.trim() ?? "";
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
	const hash = await stepUpTokenHash(env, token);
	const now = new Date().toISOString();
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT 1 AS valid
		 FROM auth_step_up_sessions
		 WHERE uid = ? AND scope = 'recovery' AND token_hash = ?
		   AND consumed_at IS NULL AND expires_at > ?
		 LIMIT 1`,
	).bind(input.uid, hash, now).first<{ valid: number }>();
	return row?.valid === 1;
}

export async function deleteExpiredEmailCodes(env: Bindings): Promise<void> {
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			"DELETE FROM auth_email_codes WHERE expires_at < ?",
		).bind(cutoff),
		env.GATOPAGO_DB.prepare(
			"DELETE FROM auth_step_up_sessions WHERE expires_at < ?",
		).bind(cutoff),
	]);
}

export const __test = {
	randomSixDigitCode,
	constantTimeEqual,
	hmacHex,
	stepUpTokenHash,
	randomStepUpToken,
	CODE_TTL_SECONDS,
	STEP_UP_TTL_SECONDS,
	MAX_ATTEMPTS,
};
