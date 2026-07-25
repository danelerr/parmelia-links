import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractErrorMessage,
	getRequestId,
	logError,
	sanitizeLogText,
} from "../src/services/logger";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("structured logger", () => {
	it("redacts credentials, sensitive parameters and explicit secrets", () => {
		const message = sanitizeLogText(
			"Authorization: Bearer abc123 https://tenant.rpc.example/v2/path-secret-1234567890?api_key=secret token=visible",
		);

		expect(message).not.toContain("abc123");
		expect(message).not.toContain("tenant.rpc.example");
		expect(message).not.toContain("path-secret-1234567890");
		expect(message).not.toContain("api_key=secret");
		expect(message).not.toContain("visible");
		expect(message).toContain("[REDACTED_URL]");
	});

	it("bounds exception text before logging", () => {
		const message = extractErrorMessage(new Error("x".repeat(3_000)));
		expect(message.length).toBeLessThanOrEqual(2_014);
		expect(message.endsWith("...[truncated]")).toBe(true);
	});

	it("redacts sensitive structured fields", () => {
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		logError("test_event", new Error("failed"), {
			token: "should-not-appear",
			requestId: "safe-id",
		});

		const payload = JSON.parse(String(consoleSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(payload).toMatchObject({
			level: "error",
			event: "test_event",
			token: "[REDACTED]",
			requestId: "safe-id",
		});
	});

	it("accepts bounded request ids and replaces unsafe input", () => {
		expect(getRequestId((name) => (name === "x-request-id" ? "request-123" : undefined))).toBe(
			"request-123",
		);
		const generated = getRequestId((name) =>
			name === "x-request-id" ? "bad\nrequest" : undefined,
		);
		expect(generated).toMatch(/^[0-9a-f-]{36}$/);
	});
});
