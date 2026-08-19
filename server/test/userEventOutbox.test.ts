import { describe, expect, it } from "vitest";
import { __test } from "../src/services/userEventOutbox";

describe("durable user event outbox", () => {
	it("accepts only bounded notification payloads", () => {
		expect(
			__test.parseSecurityNotification(
				JSON.stringify({
					title: "Recovery requested",
					body: "Open GatoPago if this was not you.",
					link: "/settings",
				}),
			),
		).toEqual({
			title: "Recovery requested",
			body: "Open GatoPago if this was not you.",
			link: "/settings",
		});
		expect(__test.parseSecurityNotification("{}")).toBeNull();
		expect(
			__test.parseSecurityNotification(
				JSON.stringify({ title: "x", body: "y".repeat(501) }),
			),
		).toBeNull();
	});

	it("caps exponential retry delay at one hour", () => {
		expect(__test.retryDelayMs(0)).toBe(5_000);
		expect(__test.retryDelayMs(20)).toBe(60 * 60_000);
	});
});
