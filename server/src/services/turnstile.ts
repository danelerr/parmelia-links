// Cloudflare Turnstile verification (anti-abuse on account creation + faucet).
// Feature-flagged: if TURNSTILE_SECRET_KEY is unset, verification is skipped so
// local dev keeps working without the secret.

import type { Bindings } from "../middlewares/auth";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Returns true if the Turnstile token is valid (or if Turnstile isn't
 * configured). `remoteIp` is optional but improves Cloudflare's scoring.
 */
export async function verifyTurnstile(
	env: Bindings,
	token: unknown,
	remoteIp?: string | null,
): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) return true; // not configured → don't block (dev)
	if (typeof token !== "string" || !token) return false;

	try {
		const body = new FormData();
		body.append("secret", secret);
		body.append("response", token);
		if (remoteIp) body.append("remoteip", remoteIp);

		const res = await fetch(VERIFY_URL, { method: "POST", body });
		if (!res.ok) return false;
		const data = (await res.json()) as { success?: boolean };
		return data.success === true;
	} catch {
		return false;
	}
}
