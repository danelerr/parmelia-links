import { describe, expect, it } from "vitest";
import { __test } from "../src/services/balanceProjector";

describe("balance event projection", () => {
	it("nets ERC-20 self-transfer deltas to zero", () => {
		expect(
			__test.aggregateEventDeltas([
				{
					uid: "u1",
					accountAddress: "0x1111111111111111111111111111111111111111",
					asset: "USDC",
					role: "from",
					deltaRaw: -25n,
				},
				{
					uid: "u1",
					accountAddress: "0x1111111111111111111111111111111111111111",
					asset: "USDC",
					role: "to",
					deltaRaw: 25n,
				},
			]),
		).toEqual([]);
	});

	it("aggregates multiple deltas for one user and asset", () => {
		expect(
			__test.aggregateEventDeltas([
				{
					uid: "u1",
					accountAddress: "0x1111111111111111111111111111111111111111",
					asset: "USDC",
					role: "to",
					deltaRaw: 10n,
				},
				{
					uid: "u1",
					accountAddress: "0x1111111111111111111111111111111111111111",
					asset: "USDC",
					role: "to",
					deltaRaw: 15n,
				},
			])[0]?.deltaRaw,
		).toBe(25n);
	});
});
