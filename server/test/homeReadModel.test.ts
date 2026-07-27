import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import { __test } from "../src/services/homeReadModel";
import type { TransferCheckpointEvidence } from "../src/services/transferCoverage";

describe("Home read model refresh policy", () => {
	it("does not mistake an existing stale snapshot for missing bootstrap data", () => {
		expect(__test.needsBalanceBootstrap(true, 3, 3)).toBe(false);
		expect(__test.needsBalanceBootstrap(true, 4, 3)).toBe(false);
	});

	it("bootstraps only missing wallet assets", () => {
		expect(__test.needsBalanceBootstrap(true, 0, 3)).toBe(true);
		expect(__test.needsBalanceBootstrap(true, 2, 3)).toBe(true);
		expect(__test.needsBalanceBootstrap(false, 0, 3)).toBe(false);
	});

	it("uses exact token stream coverage without inventing a global checkpoint", () => {
		const now = new Date("2026-07-26T12:00:00.000Z");
		const recent = "2026-07-26T11:59:30.000Z";
		const old = "2026-07-25T12:00:00.000Z";
		const hash = `0x${"11".repeat(32)}`;
		const rows = [
			{
				asset: "ETH",
				balance_raw: "1000000000000000000",
				decimals: 18,
				block_number: "99",
				block_hash: hash,
				consistency_level: "safe" as const,
				projection_strategy: "rpc_only" as const,
				projection_version: 1,
				observed_at: recent,
				reconciled_at: recent,
				source: "rpc",
			},
			{
				asset: "USDC",
				balance_raw: "1000000",
				decimals: 6,
				block_number: "100",
				block_hash: hash,
				consistency_level: "safe" as const,
				projection_strategy: "events_plus_rpc" as const,
				projection_version: 1,
				observed_at: old,
				reconciled_at: old,
				source: "event_projection",
			},
			{
				asset: "aUSDC",
				balance_raw: "0",
				decimals: 6,
				block_number: "99",
				block_hash: hash,
				consistency_level: "safe" as const,
				projection_strategy: "rpc_only" as const,
				projection_version: 1,
				observed_at: recent,
				reconciled_at: recent,
				source: "rpc",
			},
		];
		const coverage = new Map<string, TransferCheckpointEvidence>([
			[
				"USDC",
				{
					blockNumber: 105n,
					blockHash: `0x${"22".repeat(32)}`,
					consistencyLevel: "safe",
					updatedAt: recent,
				},
			],
		]);
		const balance = __test.buildBalanceView(
			{
				CHAIN_KEY: "arbitrum-sepolia",
				BALANCE_MAX_STALENESS_SECONDS: "60",
			} as Bindings,
			rows,
			null,
			now,
			coverage,
		);

		expect(balance.status).toBe("fresh");
		expect(balance.assets.USDC).toMatchObject({
			status: "fresh",
			blockNumber: "105",
			blockHash: `0x${"22".repeat(32)}`,
			observedAt: recent,
		});
	});
});
