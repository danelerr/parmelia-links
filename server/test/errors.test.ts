import { describe, expect, it } from "vitest";
import { ERR, ERROR_HTTP_STATUS, type ErrorCode } from "../../shared/errors";

// The error contract is only sound if every code maps to a valid HTTP status.
// These tests guard the source of truth so a new code can't be added without one.
describe("error contract", () => {
	const codes = Object.values(ERR) as ErrorCode[];

	it("ERR values match their keys (no typos)", () => {
		for (const [key, value] of Object.entries(ERR)) {
			expect(value).toBe(key);
		}
	});

	it("every code has a canonical HTTP status", () => {
		for (const code of codes) {
			expect(ERROR_HTTP_STATUS[code], `missing status for ${code}`).toBeTypeOf("number");
		}
	});

	it("ERROR_HTTP_STATUS has no extra/stale entries", () => {
		const codeSet = new Set<string>(codes);
		for (const code of Object.keys(ERROR_HTTP_STATUS)) {
			expect(codeSet.has(code), `stale status entry: ${code}`).toBe(true);
		}
	});

	it("statuses are valid 4xx/5xx error codes", () => {
		for (const code of codes) {
			const status = ERROR_HTTP_STATUS[code];
			expect(status, `${code} status out of range`).toBeGreaterThanOrEqual(400);
			expect(status, `${code} status out of range`).toBeLessThan(600);
		}
	});
});
