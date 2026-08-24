import { importPKCS8, SignJWT } from "jose";
import type { Bindings } from "../env";
import { discardResponseBody, readJsonBounded } from "./http";

export type GoogleServiceAccount = {
	project_id: string;
	client_email: string;
	private_key: string;
	token_uri: string;
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIREBASE_TOKEN_AUDIENCE =
	"https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";
const REQUEST_TIMEOUT_MS = 7_000;
const RESPONSE_MAX_BYTES = 64 * 1024;
const accessTokenCache = new Map<string, { value: string; expiresAt: number }>();

export class FirebaseAdminConfigurationError extends Error {
	constructor(message = "Firebase Admin is not configured") {
		super(message);
		this.name = "FirebaseAdminConfigurationError";
	}
}

export class FirebaseAccountDisabledError extends Error {
	constructor() {
		super("Firebase account is disabled");
		this.name = "FirebaseAccountDisabledError";
	}
}

export class FirebaseVerifiedEmailUnavailableError extends Error {
	constructor() {
		super("Firebase account has no verified email");
		this.name = "FirebaseVerifiedEmailUnavailableError";
	}
}

export function getFirebaseServiceAccount(env: Bindings): GoogleServiceAccount {
	const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim() || env.FCM_SERVICE_ACCOUNT?.trim();
	if (!raw) throw new FirebaseAdminConfigurationError();
	try {
		const account = JSON.parse(raw) as Partial<GoogleServiceAccount>;
		if (
			!account.project_id ||
			!account.client_email ||
			!account.private_key ||
			account.token_uri !== GOOGLE_TOKEN_URL ||
			account.project_id !== env.FIREBASE_PROJECT_ID
		) {
			throw new FirebaseAdminConfigurationError("Firebase service account is invalid");
		}
		return account as GoogleServiceAccount;
	} catch (error) {
		if (error instanceof FirebaseAdminConfigurationError) throw error;
		throw new FirebaseAdminConfigurationError("Firebase service account JSON is invalid");
	}
}

async function getGoogleAccessToken(
	env: Bindings,
	scope: string,
): Promise<string> {
	const account = getFirebaseServiceAccount(env);
	const cacheKey = `${account.client_email}:${scope}`;
	const now = Math.floor(Date.now() / 1000);
	const cached = accessTokenCache.get(cacheKey);
	if (cached && cached.expiresAt > now + 60) return cached.value;

	const key = await importPKCS8(account.private_key, "RS256");
	const assertion = await new SignJWT({ scope })
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(account.client_email)
		.setSubject(account.client_email)
		.setAudience(account.token_uri)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(key);

	const response = await fetch(account.token_uri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await discardResponseBody(response);
		throw new FirebaseAdminConfigurationError(
			`Google OAuth token exchange failed (${response.status})`,
		);
	}
	const payload = await readJsonBounded<{ access_token?: string; expires_in?: number }>(
		response,
		RESPONSE_MAX_BYTES,
	);
	if (!payload.access_token || !payload.expires_in) {
		throw new FirebaseAdminConfigurationError("Google OAuth token response is invalid");
	}
	accessTokenCache.set(cacheKey, {
		value: payload.access_token,
		expiresAt: now + payload.expires_in,
	});
	return payload.access_token;
}

type FirebaseUser = {
	localId: string;
	email?: string;
	emailVerified?: boolean;
	disabled?: boolean;
};

async function lookupFirebaseUser(
	env: Bindings,
	selector: { email: [string] } | { localId: [string] },
): Promise<FirebaseUser | null> {
	const token = await getGoogleAccessToken(
		env,
		"https://www.googleapis.com/auth/identitytoolkit",
	);
	const response = await fetch(
		`https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/accounts:lookup`,
		{
			method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(selector),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
	);
	if (!response.ok) {
		await discardResponseBody(response);
		throw new Error(`Firebase user lookup failed (${response.status})`);
	}
	const payload = await readJsonBounded<{ users?: FirebaseUser[] }>(
		response,
		RESPONSE_MAX_BYTES,
	);
	return payload.users?.[0] ?? null;
}

async function lookupFirebaseUserByEmail(
	env: Bindings,
	email: string,
): Promise<FirebaseUser | null> {
	return lookupFirebaseUser(env, { email: [email] });
}

async function lookupFirebaseUserByUid(
	env: Bindings,
	uid: string,
): Promise<FirebaseUser | null> {
	if (!uid || uid.length > 128) throw new Error("Invalid Firebase uid");
	return lookupFirebaseUser(env, { localId: [uid] });
}

async function createFirebaseEmailUser(
	env: Bindings,
	email: string,
	uid: string,
): Promise<FirebaseUser> {
	const apiKey = env.FIREBASE_WEB_API_KEY?.trim();
	if (!apiKey) {
		throw new FirebaseAdminConfigurationError("FIREBASE_WEB_API_KEY is not configured");
	}
	const token = await getGoogleAccessToken(
		env,
		"https://www.googleapis.com/auth/identitytoolkit",
	);
	const response = await fetch(
		`https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/accounts?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				localId: uid,
				email,
				emailVerified: true,
				disabled: false,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		},
	);
	if (response.ok) {
		return await readJsonBounded<FirebaseUser>(response, RESPONSE_MAX_BYTES);
	}
	await discardResponseBody(response);

	// A concurrent verification may have created the same email first. Resolve
	// that race by looking it up once instead of producing a second identity.
	const racedUser = await lookupFirebaseUserByEmail(env, email);
	if (racedUser) return racedUser;
	throw new Error(`Firebase user creation failed (${response.status})`);
}

export async function findOrCreateFirebaseEmailUser(
	env: Bindings,
	input: { email: string; newUid: string },
): Promise<FirebaseUser> {
	const existing = await lookupFirebaseUserByEmail(env, input.email);
	const user = existing ?? await createFirebaseEmailUser(env, input.email, input.newUid);
	if (user.disabled) throw new FirebaseAccountDisabledError();
	if (!user.localId) throw new Error("Firebase returned a user without localId");
	return user;
}

export async function getVerifiedFirebaseEmailForUid(
	env: Bindings,
	uid: string,
): Promise<string> {
	const user = await lookupFirebaseUserByUid(env, uid);
	if (user?.disabled) throw new FirebaseAccountDisabledError();
	const email = user?.email?.trim().toLowerCase();
	if (
		!email ||
		!user?.emailVerified ||
		email.length > 254 ||
		!/^\S+@\S+\.\S+$/.test(email)
	) {
		throw new FirebaseVerifiedEmailUnavailableError();
	}
	return email;
}

export async function createFirebaseCustomToken(
	env: Bindings,
	uid: string,
	claims: Record<string, string | number | boolean> = {},
): Promise<string> {
	if (!uid || uid.length > 128) throw new Error("Invalid Firebase uid");
	const account = getFirebaseServiceAccount(env);
	const now = Math.floor(Date.now() / 1000);
	const key = await importPKCS8(account.private_key, "RS256");
	return new SignJWT({ uid, ...(Object.keys(claims).length ? { claims } : {}) })
		.setProtectedHeader({ alg: "RS256", typ: "JWT" })
		.setIssuer(account.client_email)
		.setSubject(account.client_email)
		.setAudience(FIREBASE_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(key);
}
