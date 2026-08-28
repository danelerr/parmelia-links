// Cloudflare Turnstile verification (anti-abuse on account creation + faucet).
// Feature-flagged on TESTNETS only: without TURNSTILE_SECRET_KEY, verification
// is skipped so local dev keeps working. On mainnet the check FAILS CLOSED —
// this is the only anti-abuse gate in front of a faucet that moves real USDC,
// so a missing secret must block instead of silently disabling it.

import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { discardResponseBody, readJsonBounded } from "./http";
import { logError } from "./logger";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_RESPONSE_MAX_BYTES = 16 * 1024;

export type TurnstileAction = "email_login" | "account_create" | "test_funds";

type TurnstileVerification = {
	success?: boolean;
	action?: string;
	hostname?: string;
};

function allowedTurnstileHostnames(env: Bindings): Set<string> {
	const hostnames = new Set<string>();
	for (const value of (env.ALLOWED_ORIGINS ?? "").split(",")) {
		try {
			const origin = new URL(value.trim());
			if (origin.protocol === "https:" || origin.protocol === "http:") {
				hostnames.add(origin.hostname.toLowerCase());
			}
		} catch { /* Invalid origins are rejected by the main config validator. */ }
	}
	return hostnames;
}

/**
 * Returns true if the Turnstile token is valid. Without a configured secret:
 * true on testnets (dev convenience), false on mainnet (fail closed).
 * `remoteIp` is optional but improves Cloudflare's scoring.
 */
export async function verifyTurnstile(
	env: Bindings,
	token: unknown,
	remoteIp?: string | null,
	expectedAction: TurnstileAction = "email_login",
): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) {
		const { isTestnet } = getNetworkConfig(env.CHAIN_KEY);
		if (!isTestnet) {
			logError("turnstile_missing_secret_mainnet", new Error("TURNSTILE_SECRET_KEY unset on mainnet"), {});
		}
		return isTestnet;
	}
	if (typeof token !== "string" || !token) return false;

	try {
		const body = new FormData();
		body.append("secret", secret);
		body.append("response", token);
		if (remoteIp) body.append("remoteip", remoteIp);

		const res = await fetch(VERIFY_URL, {
			method: "POST",
			body,
			signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
		});
		if (!res.ok) {
			await discardResponseBody(res);
			return false;
		}
		const data = await readJsonBounded<TurnstileVerification>(res, VERIFY_RESPONSE_MAX_BYTES);
		const hostname = data.hostname?.trim().toLowerCase();
		return data.success === true && data.action === expectedAction && !!hostname &&
			allowedTurnstileHostnames(env).has(hostname);
	} catch {
		return false;
	}
}
