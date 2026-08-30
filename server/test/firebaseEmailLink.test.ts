import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import {
	__test,
	emailLinkContinueUrl,
	FirebaseEmailLinkUnavailableError,
	sendFirebaseEmailLink,
} from "../src/services/firebaseEmailLink";

const env = {
	APP_URL: "https://app.parmelia.me",
	FIREBASE_WEB_API_KEY: "firebase-web-key",
} as Bindings;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Firebase email links", () => {
	it("builds an App-owned continue URL without putting the email in it", () => {
		const signin = new URL(emailLinkContinueUrl(env, { flow: "signin" }));
		expect(signin.origin).toBe("https://app.parmelia.me");
		expect(signin.pathname).toBe("/login");
		expect(signin.searchParams.get("flow")).toBe("signin");
		expect(signin.searchParams.has("email")).toBe(false);

		const challenge = "a".repeat(43);
		const recovery = new URL(emailLinkContinueUrl(env, { flow: "recovery", challenge }));
		expect(recovery.searchParams.get("challenge")).toBe(challenge);
	});

	it("creates high-entropy URL-safe challenges and enforces recent auth", () => {
		const first = __test.randomOpaqueToken();
		const second = __test.randomOpaqueToken();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first).not.toBe(second);

		const now = Math.floor(Date.now() / 1_000);
		expect(__test.recentEnoughAuthTime(now, new Date().toISOString())).toBe(true);
		expect(__test.recentEnoughAuthTime(now - 2_000, new Date().toISOString())).toBe(false);
		expect(__test.recentEnoughAuthTime(undefined, new Date().toISOString())).toBe(false);
	});

	it("uses Firebase EMAIL_SIGNIN and never leaks an upstream error body", async () => {
		const outbound = vi.fn().mockResolvedValueOnce(Response.json({ email: "user@example.com" }));
		vi.stubGlobal("fetch", outbound);
		await sendFirebaseEmailLink(env, {
			email: "User@Example.com",
			locale: "en",
			continueUrl: "https://app.parmelia.me/login?flow=signin",
		});
		const [url, init] = outbound.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=firebase-web-key",
		);
		expect(new Headers(init.headers).get("X-Firebase-Locale")).toBe("en");
		expect(JSON.parse(String(init.body))).toEqual({
			requestType: "EMAIL_SIGNIN",
			email: "user@example.com",
			continueUrl: "https://app.parmelia.me/login?flow=signin",
			canHandleCodeInApp: true,
		});

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
			JSON.stringify({ message: "provider-internal-detail" }),
			{ status: 403, headers: { "content-type": "application/json" } },
		)));
		const error = await sendFirebaseEmailLink(env, {
			email: "user@example.com",
			locale: "es",
			continueUrl: "https://app.parmelia.me/login?flow=signin",
		}).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(FirebaseEmailLinkUnavailableError);
		expect(String(error)).toContain("HTTP 403");
		expect(String(error)).not.toContain("provider-internal-detail");
	});
});
