import type { Address, Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import { requestBalanceRefresh } from "./balanceReadModel";
import { logError, logInfo } from "./logger";

type BlockReader = {
	getBlock(parameters: {
		blockNumber: bigint;
		includeTransactions?: false;
	}): Promise<{ hash: Hex | null }>;
};

type StreamCheckpointRow = {
	block_number: number | string;
	block_hash: string;
};

type KnownBlockRow = {
	block_number: number | string;
	block_hash: string;
};

export class ReorgOutsideWindowError extends Error {
	constructor(
		readonly chainId: number,
		readonly stream: string,
	) {
		super(`No canonical ancestor found for ${stream} on chain ${chainId}`);
		this.name = "ReorgOutsideWindowError";
	}
}

export type ReorgCheckResult =
	| { status: "empty" | "canonical"; checkpoint: bigint | null }
	| {
			status: "recovered";
			checkpoint: bigint;
			depth: bigint;
			affectedEvents: number;
			affectedAccounts: number;
		};

/**
 * Validates the stored checkpoint hash against the reconciliation RPC. On a
 * mismatch it rolls journal-derived read models back to a known common
 * ancestor and enqueues exact RPC reconciliation for every affected wallet.
 */
export async function verifyAndRecoverStream(
	env: Bindings,
	client: BlockReader,
	input: {
		chainId: number;
		stream: string;
		maxWindowBlocks?: bigint;
	},
): Promise<ReorgCheckResult> {
	const checkpoint = await env.PARMELIA_DB.prepare(
		`SELECT block_number, block_hash
		 FROM chain_stream_checkpoints
		 WHERE chain_id = ? AND stream = ?`,
	)
		.bind(input.chainId, input.stream)
		.first<StreamCheckpointRow>();
	if (!checkpoint) return { status: "empty", checkpoint: null };

	const checkpointNumber = BigInt(checkpoint.block_number);
	const observed = await client.getBlock({
		blockNumber: checkpointNumber,
		includeTransactions: false,
	});
	if (
		observed.hash &&
		observed.hash.toLowerCase() === checkpoint.block_hash.toLowerCase()
	) {
		return { status: "canonical", checkpoint: checkpointNumber };
	}

	const maxWindow = input.maxWindowBlocks ?? 4_096n;
	const floor =
		checkpointNumber > maxWindow ? checkpointNumber - maxWindow : 0n;
	const known = await env.PARMELIA_DB.prepare(
		`SELECT block_number, block_hash
		 FROM chain_blocks
		 WHERE chain_id = ? AND canonical = 1
		   AND block_number < ? AND block_number >= ?
		 ORDER BY block_number DESC
		 LIMIT 128`,
	)
		.bind(input.chainId, checkpointNumber.toString(), floor.toString())
		.all<KnownBlockRow>();

	let ancestor: { blockNumber: bigint; blockHash: Hex } | null = null;
	for (const candidate of known.results) {
		const blockNumber = BigInt(candidate.block_number);
		const providerBlock = await client.getBlock({
			blockNumber,
			includeTransactions: false,
		});
		if (
			providerBlock.hash &&
			providerBlock.hash.toLowerCase() === candidate.block_hash.toLowerCase()
		) {
			ancestor = {
				blockNumber,
				blockHash: providerBlock.hash,
			};
			break;
		}
	}

	const detectedAt = new Date().toISOString();
	const incidentId = crypto.randomUUID();
	if (!ancestor) {
		await env.PARMELIA_DB.prepare(
			`INSERT INTO chain_reorg_incidents (
				id, chain_id, stream, detected_at, previous_block_number,
				previous_block_hash, observed_block_hash, common_ancestor_number,
				common_ancestor_hash, depth, status, affected_events,
				affected_accounts, detail_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'outside_window',
			           0, 0, '{}')`,
		)
			.bind(
				incidentId,
				input.chainId,
				input.stream,
				detectedAt,
				checkpointNumber.toString(),
				checkpoint.block_hash,
				observed.hash?.toLowerCase() ?? "unavailable",
			)
			.run();
		logError(
			"chain_reorg_outside_window",
			new ReorgOutsideWindowError(input.chainId, input.stream),
			{
				chainId: input.chainId,
				stream: input.stream,
				checkpoint: checkpointNumber.toString(),
			},
		);
		throw new ReorgOutsideWindowError(input.chainId, input.stream);
	}

	const affectedRows = await env.PARMELIA_DB.prepare(
		`SELECT DISTINCT cea.uid, cea.account_address
		 FROM chain_event_accounts cea
		 JOIN chain_events ce
		   ON ce.event_id = cea.event_id AND ce.block_hash = cea.block_hash
		 WHERE ce.chain_id = ? AND ce.canonical = 1 AND ce.block_number > ?`,
	)
		.bind(input.chainId, ancestor.blockNumber.toString())
		.all<{ uid: string; account_address: string }>();
	const eventCountRow = await env.PARMELIA_DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM chain_events
		 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
	)
		.bind(input.chainId, ancestor.blockNumber.toString())
		.first<{ count: number }>();
	const depth = checkpointNumber - ancestor.blockNumber;

	await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`UPDATE balance_projection_deltas
			 SET canonical = 0, reverted_at = ?
			 WHERE chain_id = ? AND canonical = 1
			   AND (event_id, block_hash) IN (
			   	SELECT event_id, block_hash FROM chain_events
			   	WHERE chain_id = ? AND canonical = 1 AND block_number > ?
			   )`,
		).bind(
			detectedAt,
			input.chainId,
			input.chainId,
			ancestor.blockNumber.toString(),
		),
		env.PARMELIA_DB.prepare(
			`UPDATE chain_events SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`UPDATE chain_blocks SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`UPDATE ledger SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`UPDATE user_operation_receipts SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`UPDATE balance_snapshots SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`DELETE FROM balance_projection_baselines
			 WHERE chain_id = ? AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.PARMELIA_DB.prepare(
			`UPDATE chain_stream_checkpoints
			 SET block_number = ?, block_hash = ?, consistency_level = 'sequenced',
			     updated_at = ?
			 WHERE chain_id = ? AND stream = ?`,
		).bind(
			ancestor.blockNumber.toString(),
			ancestor.blockHash.toLowerCase(),
			detectedAt,
			input.chainId,
			input.stream,
		),
		env.PARMELIA_DB.prepare(
			`UPDATE projection_watermarks
			 SET block_number = ?, block_hash = ?, updated_at = ?
			 WHERE chain_id = ? AND block_number > ?`,
		).bind(
			ancestor.blockNumber.toString(),
			ancestor.blockHash.toLowerCase(),
			detectedAt,
			input.chainId,
			ancestor.blockNumber.toString(),
		),
		env.PARMELIA_DB.prepare(
			`INSERT INTO chain_reorg_incidents (
				id, chain_id, stream, detected_at, previous_block_number,
				previous_block_hash, observed_block_hash, common_ancestor_number,
				common_ancestor_hash, depth, status, affected_events,
				affected_accounts, detail_json
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recovered', ?, ?, '{}')`,
		).bind(
			incidentId,
			input.chainId,
			input.stream,
			detectedAt,
			checkpointNumber.toString(),
			checkpoint.block_hash,
			observed.hash?.toLowerCase() ?? "unavailable",
			ancestor.blockNumber.toString(),
			ancestor.blockHash.toLowerCase(),
			depth.toString(),
			eventCountRow?.count ?? 0,
			affectedRows.results.length,
		),
	]);

	for (const affected of affectedRows.results) {
		await requestBalanceRefresh(env, {
			uid: affected.uid,
			accountAddress: affected.account_address as Address,
			chainId: input.chainId,
			reason: "chain_reorg_recovery",
			priority: 0,
		});
	}
	logInfo("chain_reorg_recovered", {
		chainId: input.chainId,
		stream: input.stream,
		depth: depth.toString(),
		affectedEvents: eventCountRow?.count ?? 0,
		affectedAccounts: affectedRows.results.length,
	});
	return {
		status: "recovered",
		checkpoint: ancestor.blockNumber,
		depth,
		affectedEvents: eventCountRow?.count ?? 0,
		affectedAccounts: affectedRows.results.length,
	};
}
