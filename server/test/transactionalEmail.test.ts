import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import {
	sendEmailSignInCode,
	sendEmailStepUpCode,
	sendSecurityAlertEmail,
	TransactionalEmailUnavailableError,
} from "../src/services/transactionalEmail";

const send = vi.fn();
const env = {
	AUTH_EMAIL_FROM: "acceso@parmelia.me",
	APP_URL: "https://app.parmelia.me",
	EMAIL: { send },
} as unknown as Bindings;

beforeEach(() => {
	send.mockReset();
	send.mockResolvedValue(undefined);
});

describe("transactional email", () => {
	it("sends a six-digit sign-in code without an authentication link", async () => {
		await sendEmailSignInCode(env, {
			to: "user@example.com",
			code: "123456",
			locale: "es",
			expiresInMinutes: 10,
		});

		expect(send).toHaveBeenCalledOnce();
		const message = send.mock.calls[0][0] as Record<string, unknown>;
		expect(message).toMatchObject({
			to: "user@example.com",
			from: { email: "acceso@parmelia.me", name: "GatoPago" },
		});
		expect(message.text).toContain("123456");
		expect(message.text).not.toMatch(/https?:\/\//u);
	});

	it("uses distinct recovery copy for step-up codes", async () => {
		await sendEmailStepUpCode(env, {
			to: "user@example.com",
			code: "654321",
			locale: "en",
			expiresInMinutes: 10,
		});

		expect(send.mock.calls[0][0]).toMatchObject({
			subject: "Confirm your GatoPago account recovery",
		});
	});

	it("rejects malformed internal code or recipient data before delivery", async () => {
		await expect(sendEmailSignInCode(env, {
			to: "user@example.com",
			code: "<script>",
			locale: "es",
			expiresInMinutes: 10,
		})).rejects.toBeInstanceOf(TransactionalEmailUnavailableError);
		await expect(sendEmailSignInCode(env, {
			to: "invalid",
			code: "123456",
			locale: "es",
			expiresInMinutes: 10,
		})).rejects.toBeInstanceOf(TransactionalEmailUnavailableError);
		expect(send).not.toHaveBeenCalled();
	});

	it("keeps security-alert links on the configured app origin", async () => {
		await sendSecurityAlertEmail(env, {
			to: "user@example.com",
			eventType: "security.recovery_proposed",
			link: "https://evil.example/recover",
		});

		const message = send.mock.calls[0][0] as Record<string, string>;
		expect(message.html).not.toContain("evil.example");
		expect(message.text).not.toContain("evil.example");
	});
});
