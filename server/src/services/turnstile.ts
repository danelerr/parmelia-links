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

/**
 * Returns true if the Turnstile token is valid. Without a configured secret:
 * true on testnets (dev convenience), false on mainnet (fail closed).
 * `remoteIp` is optional but improves Cloudflare's scoring.
 */
export async function verifyTurnstile(
	env: Bindings,
	token: unknown,
	remoteIp?: string | null,
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
		const data = await readJsonBounded<{ success?: boolean }>(res, VERIFY_RESPONSE_MAX_BYTES);
		return data.success === true;
	} catch {
		return false;
	}
}
