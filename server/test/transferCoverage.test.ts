import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	buildTransferCoverageByAsset,
	__test,
	type TransferCheckpointRow,
} from "../src/services/transferCoverage";

const CHAIN_ID = 421614;
const USDC = "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d";

function env(): Bindings {
	return {
		CHAIN_KEY: "arbitrum-sepolia",
	} as Bindings;
}

function row(
	direction: "from" | "to",
	blockNumber: bigint,
	options: Partial<TransferCheckpointRow> = {},
): TransferCheckpointRow {
	return {
		stream:
			`erc20_transfers:${CHAIN_ID}:${USDC}:${direction}:shard:7`,
		block_number: blockNumber.toString(),
		block_hash: `0x${(direction === "from" ? "11" : "22").repeat(32)}`,
		consistency_level: direction === "from" ? "safe" : "finalized",
		updated_at:
			direction === "from"
				? "2026-07-26T10:00:00.000Z"
				: "2026-07-26T10:05:00.000Z",
		...options,
	};
}

describe("wallet-scoped transfer coverage", () => {
	it("uses the lower directional checkpoint and the older observation", () => {
		const coverage = buildTransferCoverageByAsset(env(), [
			row("from", 100n),
			row("to", 120n),
		]);

		expect(coverage.get("USDC")).toEqual({
			blockNumber: 100n,
			blockHash: `0x${"11".repeat(32)}`,
			consistencyLevel: "safe",
			updatedAt: "2026-07-26T10:00:00.000Z",
		});
	});

	it("does not claim complete coverage when one direction is missing", () => {
		expect(
			buildTransferCoverageByAsset(env(), [row("to", 120n)]).has(
				"USDC",
			),
		).toBe(false);
	});

	it("rejects conflicting hashes at the same coverage height", () => {
		expect(
			__test.coverageForDirections(
				row("from", 100n),
				row("to", 100n),
			),
		).toBeNull();
	});
});
