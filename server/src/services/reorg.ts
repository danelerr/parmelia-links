import type { Address, Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import { requestBalanceRefreshBatch } from "./balanceReadModel";
import { scheduleEventJob } from "./eventScheduler";
import {
	parseTransferJournalStream,
	shardPartitionKey,
	transferPartitionKey,
} from "./indexerPartitions";
import { logError, logInfo, logWarn } from "./logger";

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

type AffectedStreamRow = {
	stream: string;
};

type ReorgReplayRow = {
	chain_id: number;
	stream: string;
	common_ancestor_number: number | string;
	reorg_epoch: number;
	attempt_count: number;
};

class ReorgOutsideWindowError extends Error {
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
			affectedStreams: number;
			reorgEpoch: number;
		};

function watcherShardId(
	stream: string,
	prefix: "recovery" | "userops",
	chainId: number,
): number | null {
	const match = new RegExp(
		`^${prefix}:${chainId}:shard:(\\d+)$`,
		"u",
	).exec(stream);
	if (!match) return null;
	const shardId = Number(match[1]);
	return Number.isSafeInteger(shardId) && shardId >= 0 ? shardId : null;
}

async function scheduleReplayStream(
	env: Bindings,
	row: Pick<ReorgReplayRow, "chain_id" | "stream">,
): Promise<void> {
	const transfer = parseTransferJournalStream(row.stream);
	let accepted: boolean;
	if (transfer && transfer.chainId === row.chain_id) {
		accepted = await scheduleEventJob(env, "indexer", {
			partition: transferPartitionKey(transfer.partition),
			reason: "chain_reorg_replay",
		});
	} else if (row.stream === `router:${row.chain_id}`) {
		accepted = await scheduleEventJob(env, "router_watcher", {
			reason: "chain_reorg_replay",
		});
	} else {
		const recoveryShard = watcherShardId(
			row.stream,
			"recovery",
			row.chain_id,
		);
		const userOperationShard = watcherShardId(
			row.stream,
			"userops",
			row.chain_id,
		);
		if (recoveryShard !== null) {
			accepted = await scheduleEventJob(env, "recovery_watcher", {
				partition: shardPartitionKey(recoveryShard),
				reason: "chain_reorg_replay",
			});
		} else if (userOperationShard !== null) {
			accepted = await scheduleEventJob(
				env,
				"user_operation_watcher",
				{
					partition: shardPartitionKey(userOperationShard),
					reason: "chain_reorg_replay",
				},
			);
		} else {
			// Legacy/unknown checkpoints must not poison the replay outbox
			// forever. The safety sweep reconstructs every currently supported
			// active partition from its own checkpoint.
			logWarn("chain_reorg_legacy_stream_replay", {
				chainId: row.chain_id,
				stream: row.stream,
			});
			accepted = await scheduleEventJob(
				env,
				"indexer_safety_sweep",
				{ reason: "chain_reorg_legacy_stream" },
			);
		}
	}
	if (!accepted) {
		throw new Error(`Unable to schedule reorg replay for ${row.stream}`);
	}
}

export async function drainChainReorgReplayRequests(
	env: Bindings,
): Promise<{ processed: number; nextRunAt: number | null }> {
	const now = new Date().toISOString();
	const rows = await env.GATOPAGO_DB.prepare(
		`SELECT chain_id, stream, common_ancestor_number, reorg_epoch,
		        attempt_count
		 FROM chain_reorg_replay_requests
		 WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
		 ORDER BY next_attempt_at, updated_at
		 LIMIT 25`,
	)
		.bind(now)
		.all<ReorgReplayRow>();
	let processed = 0;
	for (const row of rows.results) {
		try {
			await scheduleReplayStream(env, row);
			await env.GATOPAGO_DB.prepare(
				`DELETE FROM chain_reorg_replay_requests
				 WHERE chain_id = ? AND stream = ? AND reorg_epoch = ?`,
			)
				.bind(row.chain_id, row.stream, row.reorg_epoch)
				.run();
			processed++;
		} catch (error) {
			const attempt = row.attempt_count + 1;
			const delayMs = Math.min(
				15 * 60_000,
				15_000 * 2 ** Math.min(6, attempt - 1),
			);
			await env.GATOPAGO_DB.prepare(
				`UPDATE chain_reorg_replay_requests
				 SET status = 'failed', attempt_count = ?, next_attempt_at = ?,
				     last_error_code = 'REORG_REPLAY_SCHEDULE_FAILED',
				     updated_at = ?
				 WHERE chain_id = ? AND stream = ? AND reorg_epoch = ?`,
			)
				.bind(
					attempt,
					new Date(Date.now() + delayMs).toISOString(),
					new Date().toISOString(),
					row.chain_id,
					row.stream,
					row.reorg_epoch,
				)
				.run();
			logError("chain_reorg_replay_schedule_failed", error, {
				chainId: row.chain_id,
				stream: row.stream,
				attempt,
			});
		}
	}
	const next = await env.GATOPAGO_DB.prepare(
		`SELECT MIN(next_attempt_at) AS next_run_at
		 FROM chain_reorg_replay_requests
		 WHERE status IN ('pending', 'failed')`,
	).first<{ next_run_at: string | null }>();
	const parsed = next?.next_run_at
		? Date.parse(next.next_run_at)
		: Number.NaN;
	return {
		processed,
		nextRunAt: Number.isFinite(parsed)
			? Math.max(Date.now() + 1_000, parsed)
			: null,
	};
}

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
	const checkpoint = await env.GATOPAGO_DB.prepare(
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
	const known = await env.GATOPAGO_DB.prepare(
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
		await env.GATOPAGO_DB.prepare(
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

	const affectedRows = await env.GATOPAGO_DB.prepare(
		`SELECT DISTINCT uid, account_address
		 FROM (
		   SELECT cea.uid AS uid, cea.account_address AS account_address
		   FROM chain_event_accounts cea
		   JOIN chain_events ce
		     ON ce.event_id = cea.event_id
		    AND ce.block_hash = cea.block_hash
		   WHERE ce.chain_id = ? AND ce.canonical = 1
		     AND ce.block_number > ?
		   UNION
		   SELECT bs.uid AS uid, bs.account_address AS account_address
		   FROM balance_snapshots bs
		   WHERE bs.chain_id = ? AND bs.canonical = 1
		     AND bs.block_number > ?
		 )`,
	)
		.bind(
			input.chainId,
			ancestor.blockNumber.toString(),
			input.chainId,
			ancestor.blockNumber.toString(),
		)
		.all<{ uid: string; account_address: string }>();
	const eventCountRow = await env.GATOPAGO_DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM chain_events
		 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
	)
		.bind(input.chainId, ancestor.blockNumber.toString())
		.first<{ count: number }>();
	const affectedStreams = await env.GATOPAGO_DB.prepare(
		`SELECT stream
		 FROM chain_stream_checkpoints
		 WHERE chain_id = ? AND block_number > ?
		 ORDER BY stream`,
	)
		.bind(input.chainId, ancestor.blockNumber.toString())
		.all<AffectedStreamRow>();
	const depth = checkpointNumber - ancestor.blockNumber;

	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`INSERT INTO chain_reorg_state (
				chain_id, epoch, common_ancestor_number,
				common_ancestor_hash, updated_at
			 ) VALUES (?, 1, ?, ?, ?)
			 ON CONFLICT(chain_id) DO UPDATE SET
			   epoch = chain_reorg_state.epoch + 1,
			   common_ancestor_number = excluded.common_ancestor_number,
			   common_ancestor_hash = excluded.common_ancestor_hash,
			   updated_at = excluded.updated_at`,
		).bind(
			input.chainId,
			ancestor.blockNumber.toString(),
			ancestor.blockHash.toLowerCase(),
			detectedAt,
		),
		env.GATOPAGO_DB.prepare(
			`INSERT INTO chain_reorg_replay_requests (
				chain_id, stream, common_ancestor_number, reorg_epoch, status,
				attempt_count, next_attempt_at, last_error_code, created_at,
				updated_at
			 )
			 SELECT cp.chain_id, cp.stream, ?, rs.epoch, 'pending', 0, ?,
			        NULL, ?, ?
			 FROM chain_stream_checkpoints cp
			 JOIN chain_reorg_state rs ON rs.chain_id = cp.chain_id
			 WHERE cp.chain_id = ? AND cp.block_number > ?
			 ON CONFLICT(chain_id, stream) DO UPDATE SET
			   common_ancestor_number = excluded.common_ancestor_number,
			   reorg_epoch = excluded.reorg_epoch,
			   status = 'pending',
			   attempt_count = 0,
			   next_attempt_at = excluded.next_attempt_at,
			   last_error_code = NULL,
			   updated_at = excluded.updated_at`,
		).bind(
			ancestor.blockNumber.toString(),
			detectedAt,
			detectedAt,
			detectedAt,
			input.chainId,
			ancestor.blockNumber.toString(),
		),
		env.GATOPAGO_DB.prepare(
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
		env.GATOPAGO_DB.prepare(
			`UPDATE chain_events SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`UPDATE chain_blocks SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`UPDATE ledger SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`UPDATE user_operation_receipts SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`UPDATE balance_snapshots SET canonical = 0
			 WHERE chain_id = ? AND canonical = 1 AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`DELETE FROM balance_projection_baselines
			 WHERE chain_id = ? AND block_number > ?`,
		).bind(input.chainId, ancestor.blockNumber.toString()),
		env.GATOPAGO_DB.prepare(
			`UPDATE chain_stream_checkpoints
			 SET block_number = ?, block_hash = ?, consistency_level = 'sequenced',
			     updated_at = ?,
			     reorg_epoch = (
			       SELECT epoch FROM chain_reorg_state WHERE chain_id = ?
			     )
			 WHERE chain_id = ? AND block_number > ?`,
		).bind(
			ancestor.blockNumber.toString(),
			ancestor.blockHash.toLowerCase(),
			detectedAt,
			input.chainId,
			input.chainId,
			ancestor.blockNumber.toString(),
		),
		env.GATOPAGO_DB.prepare(
			`UPDATE sync_state
			 SET last_block = ?, updated_at = ?
			 WHERE last_block > ?
			   AND (
			     key = ?
			     OR key LIKE ?
			     OR key LIKE ?
			     OR key LIKE ?
			   )`,
		).bind(
			ancestor.blockNumber.toString(),
			detectedAt,
			ancestor.blockNumber.toString(),
			`router:${input.chainId}`,
			`transfers:${input.chainId}:%`,
			`recovery:${input.chainId}:%`,
			`userops:${input.chainId}:%`,
		),
		env.GATOPAGO_DB.prepare(
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
		env.GATOPAGO_DB.prepare(
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

	const reorgState = await env.GATOPAGO_DB.prepare(
		`SELECT epoch FROM chain_reorg_state WHERE chain_id = ?`,
	)
		.bind(input.chainId)
		.first<{ epoch: number }>();
	const reorgEpoch = reorgState?.epoch ?? 0;
	if (affectedStreams.results.length > 0) {
		const replayAccepted = await scheduleEventJob(env, "reorg_replay", {
			reason: "chain_reorg_detected",
		});
		if (!replayAccepted) {
			logError(
				"chain_reorg_replay_wakeup_failed",
				new Error("Reorg replay scheduler unavailable"),
				{
					chainId: input.chainId,
					reorgEpoch,
					affectedStreams: affectedStreams.results.length,
				},
			);
		}
	}
	await requestBalanceRefreshBatch(
		env,
		affectedRows.results.map((affected) => ({
			uid: affected.uid,
			accountAddress: affected.account_address as Address,
			chainId: input.chainId,
			reason: "chain_reorg_recovery",
			priority: 0,
		})),
	);
	logInfo("chain_reorg_recovered", {
		chainId: input.chainId,
		stream: input.stream,
		depth: depth.toString(),
		affectedEvents: eventCountRow?.count ?? 0,
		affectedAccounts: affectedRows.results.length,
		affectedStreams: affectedStreams.results.length,
		reorgEpoch,
	});
	return {
		status: "recovered",
		checkpoint: ancestor.blockNumber,
		depth,
		affectedEvents: eventCountRow?.count ?? 0,
		affectedAccounts: affectedRows.results.length,
		affectedStreams: affectedStreams.results.length,
		reorgEpoch,
	};
}
