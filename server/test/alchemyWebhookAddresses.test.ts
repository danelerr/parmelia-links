import { describe, expect, it } from "vitest";
import { __test } from "../src/services/alchemyWebhookAddresses";

describe("Alchemy webhook address synchronization", () => {
	it("normalizes, sorts and deduplicates provider pages", () => {
		expect(
			__test.normalizeAddressSet([
				"0x00000000000000000000000000000000000000BB",
				"0x00000000000000000000000000000000000000aa",
				"0x00000000000000000000000000000000000000bb",
			]),
		).toEqual(
			[
				"0x00000000000000000000000000000000000000aa",
				"0x00000000000000000000000000000000000000bb",
			],
		);
	});

	it("rejects malformed provider data before changing the subscription", () => {
		expect(() => __test.normalizeAddressSet(["not-an-address"])).toThrow(
			"malformed address",
		);
	});
});
