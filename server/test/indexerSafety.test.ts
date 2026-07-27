import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { Bindings } from "../src/middlewares/auth";
import {
	planIndexerSafetyJobs,
	__test,
} from "../src/services/indexerSafety";
import { transferJournalStream } from "../src/services/indexerPartitions";

const CHAIN_ID = 421614;
const USDC =
	"0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d" as Address;

describe("autonomous indexer safety sweep", () => {
	it("schedules only lagging event streams plus one bounded balance shard", () => {
		const checkpoints = new Map<string, bigint>([
			[
				transferJournalStream(CHAIN_ID, {
					token: USDC,
					direction: "from",
					shardId: 2,
				}),
				100n,
			],
			[`userops:${CHAIN_ID}:shard:4`, 101n],
		]);

		expect(
			planIndexerSafetyJobs({
				chainId: CHAIN_ID,
				tokens: [USDC],
				transferShardIds: [2],
				recoveryShardIds: [3],
				userOperationShardIds: [4],
				checkpoints,
				scanHead: 100n,
			}),
		).toEqual([
			{
				job: "indexer",
				partition: `transfer:${USDC}:to:shard:2`,
				stream:
					`erc20_transfers:${CHAIN_ID}:${USDC}:to:shard:2`,
			},
			{
				job: "balance_safety_refresh",
				partition: "shard:2",
				stream: null,
			},
			{
				job: "recovery_watcher",
				partition: "shard:3",
				stream: `recovery:${CHAIN_ID}:shard:3`,
			},
		]);
	});

	it("bounds the configurable interval and defaults to one hour", () => {
		expect(
			__test.safetySweepIntervalMs({
				INDEXER_SAFETY_SWEEP_SECONDS: "300",
			} as Bindings),
		).toBe(300_000);
		expect(__test.safetySweepIntervalMs({} as Bindings)).toBe(3_600_000);
		expect(
			__test.safetySweepIntervalMs({
				INDEXER_SAFETY_SWEEP_SECONDS: "10",
			} as Bindings),
		).toBe(3_600_000);
	});
});
