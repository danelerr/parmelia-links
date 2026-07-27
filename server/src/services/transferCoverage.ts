import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import type { ChainConsistencyLevel } from "./chainJournal";
import {
	parseTransferJournalStream,
	transferAssignmentStream,
} from "./indexerPartitions";

export type TransferCheckpointRow = {
	stream: string;
	block_number: number | string;
	block_hash: string;
	consistency_level: ChainConsistencyLevel;
	updated_at: string;
};

export type TransferCheckpointEvidence = {
	blockNumber: bigint;
	blockHash: string;
	consistencyLevel: ChainConsistencyLevel;
	updatedAt: string;
};

const CONSISTENCY_RANK: Record<ChainConsistencyLevel, number> = {
	sequenced: 0,
	batch_posted: 1,
	l1_confirmed: 2,
	assertion_confirmed: 3,
	safe: 4,
	finalized: 5,
};

function weakerConsistency(
	left: ChainConsistencyLevel,
	right: ChainConsistencyLevel,
): ChainConsistencyLevel {
	return CONSISTENCY_RANK[left] <= CONSISTENCY_RANK[right] ? left : right;
}

function earlierIso(left: string, right: string): string {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (!Number.isFinite(leftTime)) return right;
	if (!Number.isFinite(rightTime)) return left;
	return leftTime <= rightTime ? left : right;
}

function coverageForDirections(
	from: TransferCheckpointRow,
	to: TransferCheckpointRow,
): TransferCheckpointEvidence | null {
	const fromBlock = BigInt(from.block_number);
	const toBlock = BigInt(to.block_number);
	if (
		fromBlock === toBlock &&
		from.block_hash.toLowerCase() !== to.block_hash.toLowerCase()
	) {
		return null;
	}
	const limiting = fromBlock <= toBlock ? from : to;
	return {
		blockNumber: fromBlock <= toBlock ? fromBlock : toBlock,
		blockHash: limiting.block_hash.toLowerCase(),
		consistencyLevel: weakerConsistency(
			from.consistency_level,
			to.consistency_level,
		),
		// Both directions are required to prove a token balance complete. The
		// older observation is therefore the conservative freshness boundary.
		updatedAt: earlierIso(from.updated_at, to.updated_at),
	};
}

/**
 * Resolve the exact transfer streams that cover one wallet. A token balance is
 * only proven through the lower of its `from` and `to` shard checkpoints.
 * Taking a chain-wide MAX would hide lagging partitions; taking a global MIN
 * would let an unrelated idle shard make every wallet stale.
 */
export function buildTransferCoverageByAsset(
	env: Bindings,
	rows: readonly TransferCheckpointRow[],
): Map<string, TransferCheckpointEvidence> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const symbolsByToken = new Map(
		network.tokens.flatMap((token) =>
			token.address
				? [[token.address.toLowerCase(), token.symbol] as const]
				: [],
		),
	);
	const directions = new Map<
		string,
		Partial<Record<"from" | "to", TransferCheckpointRow>>
	>();
	for (const row of rows) {
		const parsed = parseTransferJournalStream(row.stream);
		if (!parsed || parsed.chainId !== network.chainId) continue;
		const symbol = symbolsByToken.get(
			parsed.partition.token.toLowerCase(),
		);
		if (!symbol) continue;
		const pair = directions.get(symbol) ?? {};
		const prior = pair[parsed.partition.direction];
		if (!prior || BigInt(row.block_number) > BigInt(prior.block_number)) {
			pair[parsed.partition.direction] = row;
		}
		directions.set(symbol, pair);
	}

	const coverage = new Map<string, TransferCheckpointEvidence>();
	for (const [asset, pair] of directions) {
		if (!pair.from || !pair.to) continue;
		const evidence = coverageForDirections(pair.from, pair.to);
		if (evidence) coverage.set(asset, evidence);
	}
	return coverage;
}

function transferCheckpointRowsSql(): string {
	return `SELECT cp.stream, cp.block_number, cp.block_hash,
		       cp.consistency_level, cp.updated_at
		 FROM indexer_wallet_assignments a
		 JOIN chain_stream_checkpoints cp
		   ON cp.chain_id = a.chain_id
		  AND cp.stream LIKE (
		  	'erc20_transfers:' || CAST(a.chain_id AS TEXT) ||
		  	':%:shard:' || CAST(a.shard_id AS TEXT)
		  )
		 WHERE a.chain_id = ? AND a.stream = ? AND a.active = 1`;
}

export function prepareTransferCheckpointRowsForUid(
	env: Bindings,
	chainId: number,
	uid: string,
): D1PreparedStatement {
	return env.PARMELIA_DB.prepare(
		`${transferCheckpointRowsSql()} AND a.uid = ? ORDER BY cp.stream`,
	).bind(chainId, transferAssignmentStream(chainId), uid);
}

export async function getTransferCoverageForAddress(
	env: Bindings,
	chainId: number,
	accountAddress: string,
): Promise<Map<string, TransferCheckpointEvidence>> {
	const result = await env.PARMELIA_DB.prepare(
		`${transferCheckpointRowsSql()}
		   AND a.account_address = lower(?)
		 ORDER BY cp.stream`,
	)
		.bind(
			chainId,
			transferAssignmentStream(chainId),
			accountAddress,
		)
		.all<TransferCheckpointRow>();
	return buildTransferCoverageByAsset(env, result.results);
}

export const __test = {
	coverageForDirections,
	weakerConsistency,
	earlierIso,
};
