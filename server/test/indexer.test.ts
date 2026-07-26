import { describe, expect, it, vi } from "vitest";
import {
	boundedScanWindowEnd,
	getIndexerScanHead,
} from "../src/services/indexer";

type ScanHeadClient = Parameters<typeof getIndexerScanHead>[0];

function client(latest: bigint, safe: bigint | Error | null): ScanHeadClient {
	return {
		getBlockNumber: vi.fn().mockResolvedValue(latest),
		getBlock:
			safe instanceof Error
				? vi.fn().mockRejectedValue(safe)
				: vi.fn().mockResolvedValue({ number: safe }),
	};
}

describe("indexer canonical scan head", () => {
	it("uses the RPC safe head instead of indexing the mutable tip", async () => {
		await expect(getIndexerScanHead(client(10_000n, 9_850n))).resolves.toEqual({
			latest: 10_000n,
			scanHead: 9_850n,
			finalitySource: "safe",
		});
	});

	it("keeps 64 confirmations when the RPC does not support safe", async () => {
		await expect(getIndexerScanHead(client(10_000n, new Error("unsupported block tag")))).resolves.toEqual({
			latest: 10_000n,
			scanHead: 9_936n,
			finalitySource: "confirmations",
		});
	});

	it("fails over when an RPC returns a missing or impossible safe block", async () => {
		await expect(getIndexerScanHead(client(50n, null))).resolves.toEqual({
			latest: 50n,
			scanHead: 0n,
			finalitySource: "confirmations",
		});
		await expect(getIndexerScanHead(client(100n, 101n))).resolves.toEqual({
			latest: 100n,
			scanHead: 36n,
			finalitySource: "confirmations",
		});
	});

	it("does not let a stale safe head delay user-visible indexing", async () => {
		await expect(getIndexerScanHead(client(10_000n, 9_000n))).resolves.toEqual({
			latest: 10_000n,
			scanHead: 9_936n,
			finalitySource: "confirmations",
		});
	});
});

describe("indexer Worker subrequest budget", () => {
	it("shrinks the block window as wallet filter count grows", () => {
		expect(boundedScanWindowEnd(0n, 100_000n, 2_000n, 1)).toBe(
			19_999n,
		);
		expect(boundedScanWindowEnd(0n, 100_000n, 2_000n, 2)).toBe(
			15_999n,
		);
		expect(boundedScanWindowEnd(0n, 100_000n, 2_000n, 8)).toBe(
			3_999n,
		);
	});

	it("fails before one invocation would require more filters than its budget", () => {
		expect(() =>
			boundedScanWindowEnd(0n, 100_000n, 2_000n, 17),
		).toThrow("split the stream across Queue jobs");
	});
});
