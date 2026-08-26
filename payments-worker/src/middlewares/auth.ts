import type { Context, Next } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { ERR } from "../../../shared/errors";
import type { Bindings } from "../env";
import { discardResponseBody, readJsonBounded } from "../services/http";
import { logWarn } from "../services/logger";

type UserClaim = { sub: string; email?: string; name?: string; picture?: string };
type Variables = {
	user: UserClaim | null;
	requestId: string;
	merchantId?: string;
	apiMode?: "test" | "live";
};
export type PaymentsContext = { Bindings: Bindings; Variables: Variables };

let cachedJwks: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksCachedAt = 0;
const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";

async function firebaseJwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
	if (cachedJwks && Date.now() - jwksCachedAt < 3_600_000) return cachedJwks;
	const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) {
		await discardResponseBody(response);
		throw new Error(`Firebase JWKS returned ${response.status}`);
	}
	cachedJwks = createLocalJWKSet(await readJsonBounded<JSONWebKeySet>(response));
	jwksCachedAt = Date.now();
	return cachedJwks;
}

async function verifyFirebaseToken(token: string, projectId: string): Promise<UserClaim> {
	const { payload } = await jwtVerify(token, await firebaseJwks(), {
		issuer: `https://securetoken.google.com/${projectId}`,
		audience: projectId,
	});
	return payload as UserClaim;
}

export async function authMiddleware(c: Context<PaymentsContext>, next: Next): Promise<void> {
	const authorization = c.req.header("Authorization");
	if (!authorization?.startsWith("Bearer ")) {
		c.set("user", null);
		await next();
		return;
	}
	const token = authorization.slice(7);
	if (token.startsWith("sk_test_") || token.startsWith("sk_live_")) {
		c.set("user", null);
		await next();
		return;
	}
	try {
		c.set("user", await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID));
	} catch (error) {
		logWarn("payments_auth_token_rejected", {
			requestId: c.get("requestId"),
			reason: error instanceof Error ? error.name : "unknown",
		});
		c.set("user", null);
	}
	await next();
}

export async function requireAuth(c: Context<PaymentsContext>, next: Next): Promise<Response | void> {
	if (!c.get("user")) {
		return c.json({
			error: "Unauthorized: missing, invalid, or expired Firebase token",
			error_code: ERR.UNAUTHENTICATED,
			requestId: c.get("requestId"),
		}, 401);
	}
	await next();
}
