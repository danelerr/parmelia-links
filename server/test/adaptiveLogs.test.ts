import { describe, expect, it, vi } from "vitest";
import {
	isRangeCapacityError,
	isTransientRpcError,
	scanLogsAdaptive,
	shardValues,
} from "../src/services/adaptiveLogs";

describe("adaptive eth_getLogs ranges", () => {
	it("treats the configured maximum as a hard provider ceiling", async () => {
		const calls: Array<readonly [bigint, bigint]> = [];
		const stats = await scanLogsAdaptive({
			fromBlock: 100n,
			toBlock: 124n,
			minBlockSpan: 10n,
			maxBlockSpan: 10n,
			fetchRange: async (fromBlock, toBlock) => {
				calls.push([fromBlock, toBlock]);
				return [];
			},
			onRange: vi.fn(),
		});

		expect(calls).toEqual([
			[100n, 109n],
			[110n, 119n],
			[120n, 124n],
		]);
		expect(calls.every(([from, to]) => to - from + 1n <= 10n)).toBe(true);
		expect(stats).toMatchObject({ calls: 3, ranges: 3, retries: 0 });
	});

	it("shrinks a provider-rejected range and retries the same cursor", async () => {
		const calls: Array<readonly [bigint, bigint]> = [];
		const stats = await scanLogsAdaptive({
			fromBlock: 1n,
			toBlock: 20n,
			minBlockSpan: 5n,
			maxBlockSpan: 20n,
			fetchRange: async (fromBlock, toBlock) => {
				calls.push([fromBlock, toBlock]);
				if (toBlock - fromBlock + 1n > 5n) {
					throw new Error("block range limit exceeded");
				}
				return [fromBlock];
			},
			onRange: vi.fn(),
		});

		expect(calls.slice(0, 3)).toEqual([
			[1n, 20n],
			[1n, 10n],
			[1n, 5n],
		]);
		expect(stats.retries).toBeGreaterThanOrEqual(2);
		expect(stats.logs).toBe(4);
	});

	it("classifies capacity and transient failures separately", () => {
		expect(isRangeCapacityError(new Error("query returned more than 10000 results"))).toBe(true);
		expect(isTransientRpcError(new Error("HTTP 429 rate limit"))).toBe(true);
		expect(isTransientRpcError(new Error("execution reverted"))).toBe(false);
	});

	it("creates bounded deterministic wallet shards", () => {
		expect(shardValues([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(() => shardValues([1], 0)).toThrow("positive safe integer");
	});
});
