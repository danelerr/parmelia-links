import { Context, Next } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { ERR } from "../../../shared/errors";
import type { Bindings } from "../env";
import { discardResponseBody, readJsonBounded } from "../services/http";
import { logWarn } from "../services/logger";

export type { Bindings } from "../env";

type FirebaseIdentity = {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
	auth_time?: number;
	firebase?: { sign_in_provider?: string };
};

type Variables = {
	user: FirebaseIdentity | null;
	requestId: string;
	/** Set by the API-key middleware on /v1 routes. */
	merchantId?: string;
	apiMode?: "test" | "live";
};

export type AppContext = { Bindings: Bindings; Variables: Variables };

// Firebase public keys for ID token verification - fetched manually for workerd compatibility.
let cachedJWKS: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksCachedAt = 0;
const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";
const JWKS_TIMEOUT_MS = 5_000;
const JWKS_MAX_BYTES = 64 * 1024;

async function getFirebaseJWKS() {
	const now = Date.now();
	if (cachedJWKS && now - jwksCachedAt < 3600_000) return cachedJWKS;
	const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
	if (!res.ok) {
		await discardResponseBody(res);
		throw new Error(`Failed to fetch JWKS: ${res.status}`);
	}
	const jwks = await readJsonBounded<JSONWebKeySet>(res, JWKS_MAX_BYTES);
	cachedJWKS = createLocalJWKSet(jwks);
	jwksCachedAt = now;
	return cachedJWKS;
}

async function verifyFirebaseToken(token: string, projectId: string) {
	const jwks = await getFirebaseJWKS();
	const { payload } = await jwtVerify(token, jwks, {
		issuer: `https://securetoken.google.com/${projectId}`,
		audience: projectId,
	});
	return payload as FirebaseIdentity;
}

export const authMiddleware = async (c: Context<AppContext>, next: Next) => {
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		try {
			const user = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID);
			c.set("user", user);
		} catch (error) {
			logWarn("auth_token_rejected", {
				requestId: c.get("requestId"),
				path: new URL(c.req.url).pathname,
				reason: error instanceof Error ? error.name : "unknown",
			});
			c.set("user", null);
		}
	} else {
		c.set("user", null);
	}
	await next();
};

export const requireAuth = async (c: Context<AppContext>, next: Next) => {
	const user = c.get("user");
	if (!user) {
		// Stable code so the client maps a localized "session expired" message
		// instead of parsing this English text (same contract as every route).
		return c.json(
			{
				error: "Unauthorized: missing, invalid, or expired Firebase token",
				error_code: ERR.UNAUTHENTICATED,
				requestId: c.get("requestId"),
			},
			401,
		);
	}
	await next();
};
