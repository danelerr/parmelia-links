import { describe, expect, it } from "vitest";
import {
	diffWebhookAddresses,
	__test,
} from "../src/services/alchemyWebhookAddresses";

describe("Alchemy webhook address synchronization", () => {
	it("computes normalized, idempotent add/remove sets", () => {
		expect(
			diffWebhookAddresses(
				[
					"0x00000000000000000000000000000000000000AA",
					"0x00000000000000000000000000000000000000bb",
				],
				[
					"0x00000000000000000000000000000000000000aa",
					"0x00000000000000000000000000000000000000cc",
				],
			),
		).toEqual({
			add: ["0x00000000000000000000000000000000000000bb"],
			remove: ["0x00000000000000000000000000000000000000cc"],
		});
	});

	it("produces an order-independent desired-state hash", async () => {
		const left = __test.normalizeAddressSet([
			"0x0000000000000000000000000000000000000002",
			"0x0000000000000000000000000000000000000001",
		]);
		const right = __test.normalizeAddressSet([...left].reverse());
		await expect(__test.addressSetHash(left)).resolves.toBe(
			await __test.addressSetHash(right),
		);
	});

	it("rejects malformed provider data before changing the subscription", () => {
		expect(() => diffWebhookAddresses(["not-an-address"], [])).toThrow(
			"malformed address",
		);
	});
});
