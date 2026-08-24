import { describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import type { Bindings } from "../src/env";
import {
	__test,
	EmailOtpConfigurationError,
	emailOtpRateLimitKeys,
	normalizeEmail,
} from "../src/services/emailOtp";
import {
	createFirebaseCustomToken,
	FirebaseAdminConfigurationError,
	getFirebaseServiceAccount,
} from "../src/services/googleServiceAccount";

function bindings(input: Partial<Bindings>): Bindings {
	return input as Bindings;
}

describe("email sign-in codes", () => {
	it("normalizes valid addresses and rejects malformed input", () => {
		expect(normalizeEmail("  Daniel@Example.COM ")).toBe("daniel@example.com");
		expect(normalizeEmail("not-an-email")).toBeNull();
		expect(normalizeEmail("a@b")).toBeNull();
		expect(normalizeEmail(`a@${"x".repeat(250)}.com`)).toBeNull();
		expect(normalizeEmail(undefined)).toBeNull();
	});

	it("always generates zero-padded six-digit codes", () => {
		for (let index = 0; index < 2_000; index += 1) {
			expect(__test.randomSixDigitCode()).toMatch(/^\d{6}$/);
		}
	});

	it("derives stable, purpose-separated hashes without exposing the inputs", async () => {
		const env = bindings({ AUTH_CODE_PEPPER: "p".repeat(32) });
		const first = await emailOtpRateLimitKeys(env, "daniel@example.com", "203.0.113.4");
		const second = await emailOtpRateLimitKeys(env, "daniel@example.com", "203.0.113.4");

		expect(first).toEqual(second);
		expect(first.email).toMatch(/^[0-9a-f]{64}$/);
		expect(first.ip).toMatch(/^[0-9a-f]{64}$/);
		expect(first.email).not.toBe(first.ip);
		expect(JSON.stringify(first)).not.toContain("daniel@example.com");
		expect(JSON.stringify(first)).not.toContain("203.0.113.4");
	});

	it("requires a high-entropy server-side pepper", async () => {
		await expect(
			emailOtpRateLimitKeys(bindings({ AUTH_CODE_PEPPER: "too-short" }), "a@b.co", "127.0.0.1"),
		).rejects.toBeInstanceOf(EmailOtpConfigurationError);
	});

	it("uses a constant-time comparison for equal-length digests", () => {
		expect(__test.constantTimeEqual("abc123", "abc123")).toBe(true);
		expect(__test.constantTimeEqual("abc123", "abc124")).toBe(false);
		expect(__test.constantTimeEqual("abc123", "short")).toBe(false);
	});

	it("creates high-entropy URL-safe step-up tokens and purpose-separated hashes", async () => {
		const tokens = new Set<string>();
		for (let index = 0; index < 200; index += 1) {
			const token = __test.randomStepUpToken();
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			tokens.add(token);
		}
		expect(tokens.size).toBe(200);
		const env = bindings({ AUTH_CODE_PEPPER: "p".repeat(32) });
		const first = await __test.stepUpTokenHash(env, [...tokens][0]);
		const second = await __test.stepUpTokenHash(env, [...tokens][1]);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(second).not.toBe(first);
		expect(first).not.toContain([...tokens][0]);
	});
});

describe("Firebase custom authentication", () => {
	it("validates the service-account project and token endpoint", () => {
		const env = bindings({
			FIREBASE_PROJECT_ID: "gatopago",
			FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
				project_id: "another-project",
				client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
				private_key: "unused",
				token_uri: "https://oauth2.googleapis.com/token",
			}),
		});

		expect(() => getFirebaseServiceAccount(env)).toThrow(FirebaseAdminConfigurationError);
	});

	it("mints a one-hour RS256 token with the Firebase custom-token contract", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
		const env = bindings({
			FIREBASE_PROJECT_ID: "gatopago-test",
			FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
				project_id: "gatopago-test",
				client_email: "firebase-adminsdk@gatopago-test.iam.gserviceaccount.com",
				private_key: await exportPKCS8(privateKey),
				token_uri: "https://oauth2.googleapis.com/token",
			}),
		});

		const token = await createFirebaseCustomToken(env, "email_user_123", { email_otp: true });
		const verified = await jwtVerify(token, publicKey, {
			algorithms: ["RS256"],
			audience: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
			issuer: "firebase-adminsdk@gatopago-test.iam.gserviceaccount.com",
			subject: "firebase-adminsdk@gatopago-test.iam.gserviceaccount.com",
		});

		expect(verified.protectedHeader).toMatchObject({ alg: "RS256", typ: "JWT" });
		expect(verified.payload.uid).toBe("email_user_123");
		expect(verified.payload.claims).toEqual({ email_otp: true });
		expect(Number(verified.payload.exp) - Number(verified.payload.iat)).toBe(3_600);
	});

	it("rejects Firebase uids outside the documented length contract", async () => {
		await expect(
			createFirebaseCustomToken(bindings({}), "x".repeat(129)),
		).rejects.toThrow("Invalid Firebase uid");
	});
});
