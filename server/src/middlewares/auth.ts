import { Context, Next } from "hono";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { SupportedChainKey } from "../../../shared/networks";

export interface KVListResult {
	keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
	list_complete: boolean;
	cursor: string;
}

export interface KVNamespaceBinding {
	get(key: string, options?: string | { type?: string }): Promise<any>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<KVListResult>;
}

export interface D1QueryResult<Row = Record<string, unknown>> {
	results?: Row[];
	success?: boolean;
	meta?: Record<string, unknown>;
}

export interface D1PreparedStatementBinding {
	bind(...values: unknown[]): D1PreparedStatementBinding;
	first<Row = Record<string, unknown>>(columnName?: string): Promise<Row | null>;
	run<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
	all<Row = Record<string, unknown>>(): Promise<D1QueryResult<Row>>;
}

export interface D1DatabaseBinding {
	prepare(query: string): D1PreparedStatementBinding;
	exec(query: string): Promise<unknown>;
	batch<T = unknown>(statements: D1PreparedStatementBinding[]): Promise<T[]>;
}

export type Bindings = {
	RPC_URL: string;
	PRIVATE_KEY: string;
	PAYMASTER_SIGNER_PRIVATE_KEY?: string;
	FIREBASE_PROJECT_ID: string;
	PARMELIA_DB: D1DatabaseBinding;
	PARMELIA_KV?: KVNamespaceBinding;
	STORAGE_MIGRATION_TOKEN?: string;
	CHAIN_KEY?: SupportedChainKey;
};

export type Variables = {
	user: { sub: string; email?: string; name?: string; picture?: string } | null;
};

export type AppContext = { Bindings: Bindings; Variables: Variables };

// Firebase public keys for ID token verification - fetched manually for workerd compatibility.
let cachedJWKS: ReturnType<typeof createLocalJWKSet> | null = null;
let jwksCachedAt = 0;
const JWKS_URL = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";

export async function getFirebaseJWKS() {
	const now = Date.now();
	if (cachedJWKS && now - jwksCachedAt < 3600_000) return cachedJWKS;
	const res = await fetch(JWKS_URL);
	if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);
	const jwks = (await res.json()) as JSONWebKeySet;
	cachedJWKS = createLocalJWKSet(jwks);
	jwksCachedAt = now;
	return cachedJWKS;
}

export async function verifyFirebaseToken(token: string, projectId: string) {
	const jwks = await getFirebaseJWKS();
	const { payload } = await jwtVerify(token, jwks, {
		issuer: `https://securetoken.google.com/${projectId}`,
		audience: projectId,
	});
	return payload as { sub: string; email?: string; name?: string; picture?: string };
}

export const authMiddleware = async (c: Context<AppContext>, next: Next) => {
	const authHeader = c.req.header("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		const token = authHeader.slice(7);
		try {
			const user = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID);
			c.set("user", user);
		} catch (err: any) {
			console.error("Auth failed:", err?.message || String(err));
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
		return c.json({ error: "Unauthorized: missing, invalid, or expired Firebase token" }, 401);
	}
	await next();
};
