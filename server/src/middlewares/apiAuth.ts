// API-key auth for the /v1 surface (machine-to-machine). Bearer sk_live_/sk_test_;
// the key is hashed and looked up, then the merchant + mode are put on context.

import { Context, Next } from "hono";
import { ERR } from "../../../shared";
import { AppContext } from "./auth";
import { apiError } from "../services/apiError";
import { sha256Hex } from "../services/apiKeys";
import { getApiKeyByHash, touchApiKey } from "../services/storage";

export const requireApiKey = async (c: Context<AppContext>, next: Next) => {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return apiError(c, ERR.UNAUTHENTICATED, "Missing API key. Use Authorization: Bearer sk_...");
	}
	const token = header.slice(7).trim();
	if (!token.startsWith("sk_")) {
		return apiError(c, ERR.INVALID_API_KEY, "Invalid API key format.");
	}

	const key = await getApiKeyByHash(c.env, await sha256Hex(token));
	if (!key || key.revokedAt) {
		return apiError(c, ERR.INVALID_API_KEY, "Invalid or revoked API key.");
	}

	c.set("merchantId", key.merchantId);
	c.set("apiMode", key.mode);
	// Best-effort usage timestamp; never block the request.
	try {
		c.executionCtx.waitUntil(touchApiKey(c.env, key.id));
	} catch {
		void touchApiKey(c.env, key.id);
	}
	await next();
};
