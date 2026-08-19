import type { Address } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	getIndexerProviderPool,
	getRpcUrls,
} from "./clients";
import { getIndexerScanHead } from "./chainHead";
import { requestBalanceRefreshBatch } from "./balanceReadModel";
import { scheduleEventJob, type EventJobName } from "./eventScheduler";
import {
	recoveryAssignmentStream,
	shardPartitionKey,
	transferAssignmentStream,
	transferJournalStream,
	transferPartitionKey,
	type TransferIndexerPartition,
	userOperationAssignmentStream,
} from "./indexerPartitions";
import { listWalletsForIndexerShard } from "./indexerShards";
import { logInfo } from "./logger";

type CheckpointRow = {
	stream: string;
	block_number: number | string;
};

type SafetySweepStateRow = {
	target_block: number | string;
	cursor_stream: string;
	cursor_shard_id: number;
};

type ActiveShardRow = {
	stream: string;
	shard_id: number;
};

export type IndexerSafetyJob = {
	job: EventJobName;
	partition: string;
	stream: string | null;
};

const SHARDS_PER_SWEEP_JOB = 4;

function safetySweepIntervalMs(env: Bindings): number {
	const parsed = Number(env.INDEXER_SAFETY_SWEEP_SECONDS);
	const seconds =
		Number.isSafeInteger(parsed) && parsed >= 60 && parsed <= 86_400
			? parsed
			: 3_600;
	return seconds * 1_000;
}

export function planIndexerSafetyJobs(input: {
	chainId: number;
	tokens: readonly Address[];
	transferShardIds: readonly number[];
	recoveryShardIds: readonly number[];
	userOperationShardIds: readonly number[];
	checkpoints: ReadonlyMap<string, bigint>;
	scanHead: bigint;
}): IndexerSafetyJob[] {
	const jobs: IndexerSafetyJob[] = [];
	for (const shardId of input.transferShardIds) {
		for (const token of input.tokens) {
			for (const direction of ["from", "to"] as const) {
				const partition: TransferIndexerPartition = {
					token,
					direction,
					shardId,
				};
				const stream = transferJournalStream(input.chainId, partition);
				if (
					(input.checkpoints.get(stream) ?? -1n) <
					input.scanHead
				) {
					jobs.push({
						job: "indexer",
						partition: transferPartitionKey(partition),
						stream,
					});
				}
			}
		}
		// Native ETH and balanceOf-style assets have no complete Transfer-log
		// discovery path. Refresh one bounded wallet shard per safety cycle.
		jobs.push({
			job: "balance_safety_refresh",
			partition: shardPartitionKey(shardId),
			stream: null,
		});
	}
	for (const shardId of input.recoveryShardIds) {
		const stream = `recovery:${input.chainId}:shard:${shardId}`;
		if ((input.checkpoints.get(stream) ?? -1n) < input.scanHead) {
			jobs.push({
				job: "recovery_watcher",
				partition: shardPartitionKey(shardId),
				stream,
			});
		}
	}
	for (const shardId of input.userOperationShardIds) {
		const stream = `userops:${input.chainId}:shard:${shardId}`;
		if ((input.checkpoints.get(stream) ?? -1n) < input.scanHead) {
			jobs.push({
				job: "user_operation_watcher",
				partition: shardPartitionKey(shardId),
				stream,
			});
		}
	}
	return jobs;
}

export async function runBalanceSafetyRefresh(
	env: Bindings,
	shardId: number,
	targetBlock?: bigint,
): Promise<{ requested: number }> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const wallets = await listWalletsForIndexerShard(env, {
		chainId: network.chainId,
		stream: transferAssignmentStream(network.chainId),
		shardId,
	});
	await requestBalanceRefreshBatch(
		env,
		wallets.map((wallet) => ({
			uid: wallet.uid,
			accountAddress: wallet.walletAddress as Address,
			chainId: network.chainId,
			reason: "autonomous_indexer_safety",
			priority: 3 as const,
			...(targetBlock === undefined
				? {}
				: { notBeforeBlock: targetBlock.toString() }),
		})),
	);
	return { requested: wallets.length };
}

export async function runIndexerSafetySweep(
	env: Bindings,
): Promise<{
	activeShards: number;
	scheduled: number;
	nextRunAt: number | null;
}> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const active = await env.GATOPAGO_DB.prepare(
		`SELECT 1 AS present
		 FROM indexer_shards s
		 WHERE s.chain_id = ? AND s.status = 'active'
		   AND EXISTS (
		     SELECT 1
		     FROM indexer_wallet_assignments a
		     WHERE a.chain_id = s.chain_id
		       AND a.stream = s.stream
		       AND a.shard_id = s.shard_id
		       AND a.active = 1
		   )
		 LIMIT 1`,
	)
		.bind(network.chainId)
		.first<{ present: number }>();
	if (active?.present !== 1) {
		await env.GATOPAGO_DB.prepare(
			`DELETE FROM indexer_safety_sweep_state WHERE chain_id = ?`,
		)
			.bind(network.chainId)
			.run();
		return { activeShards: 0, scheduled: 0, nextRunAt: null };
	}
	if (getRpcUrls(env, "indexer").length === 0) {
		throw new Error("Indexer safety sweep requires an indexer RPC pool");
	}

	let state = await env.GATOPAGO_DB.prepare(
		`SELECT target_block, cursor_stream, cursor_shard_id
		 FROM indexer_safety_sweep_state WHERE chain_id = ?`,
	)
		.bind(network.chainId)
		.first<SafetySweepStateRow>();
	if (!state) {
		const providerPool = getIndexerProviderPool(env);
		const { scanHead } = await getIndexerScanHead(
			providerPool.pointClient,
		);
		const now = new Date().toISOString();
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO indexer_safety_sweep_state (
				chain_id, target_block, cursor_stream, cursor_shard_id,
				cycle_started_at, updated_at
			 ) VALUES (?, ?, '', -1, ?, ?)
			 ON CONFLICT(chain_id) DO NOTHING`,
		)
			.bind(network.chainId, scanHead.toString(), now, now)
			.run();
		state = await env.GATOPAGO_DB.prepare(
			`SELECT target_block, cursor_stream, cursor_shard_id
			 FROM indexer_safety_sweep_state WHERE chain_id = ?`,
		)
			.bind(network.chainId)
			.first<SafetySweepStateRow>();
	}
	if (!state) {
		throw new Error("Unable to establish indexer safety sweep state");
	}
	const scanHead = BigInt(state.target_block);
	const shardRows = await env.GATOPAGO_DB.prepare(
		`SELECT s.stream, s.shard_id
		 FROM indexer_shards s
		 WHERE s.chain_id = ? AND s.status = 'active'
		   AND EXISTS (
		     SELECT 1
		     FROM indexer_wallet_assignments a
		     WHERE a.chain_id = s.chain_id
		       AND a.stream = s.stream
		       AND a.shard_id = s.shard_id
		       AND a.active = 1
		   )
		   AND (
		     s.stream > ?
		     OR (s.stream = ? AND s.shard_id > ?)
		   )
		 ORDER BY s.stream, s.shard_id
		 LIMIT ?`,
	)
		.bind(
			network.chainId,
			state.cursor_stream,
			state.cursor_stream,
			state.cursor_shard_id,
			SHARDS_PER_SWEEP_JOB + 1,
		)
		.all<ActiveShardRow>();
	const page = shardRows.results.slice(0, SHARDS_PER_SWEEP_JOB);
	if (page.length === 0) {
		await env.GATOPAGO_DB.prepare(
			`DELETE FROM indexer_safety_sweep_state WHERE chain_id = ?`,
		)
			.bind(network.chainId)
			.run();
		return {
			activeShards: 0,
			scheduled: 0,
			nextRunAt: Date.now() + safetySweepIntervalMs(env),
		};
	}
	const transferStream = transferAssignmentStream(network.chainId);
	const recoveryStream = recoveryAssignmentStream(network.chainId);
	const userOperationStream =
		userOperationAssignmentStream(network.chainId);
	const transferShardIds = page
		.filter((row) => row.stream === transferStream)
		.map((row) => row.shard_id);
	const recoveryShardIds = page
		.filter((row) => row.stream === recoveryStream)
		.map((row) => row.shard_id);
	const userOperationShardIds = page
		.filter((row) => row.stream === userOperationStream)
		.map((row) => row.shard_id);
	const checkpointRows = await env.GATOPAGO_DB.prepare(
		`SELECT stream, block_number
		 FROM chain_stream_checkpoints
		 WHERE chain_id = ?`,
	)
		.bind(network.chainId)
		.all<CheckpointRow>();
	const checkpoints = new Map(
		checkpointRows.results.map((row) => [
			row.stream,
			BigInt(row.block_number),
		]),
	);
	const jobs = planIndexerSafetyJobs({
		chainId: network.chainId,
		tokens: network.tokens.flatMap((token) =>
			token.address ? [token.address] : [],
		),
		transferShardIds,
		recoveryShardIds,
		userOperationShardIds,
		checkpoints,
		scanHead,
	});
	let scheduled = 0;
	for (const job of jobs) {
		const accepted = await scheduleEventJob(env, job.job, {
			partition: job.partition,
			targetBlock: scanHead,
			reason: "autonomous_indexer_safety",
		});
		if (!accepted) {
			throw new Error(
				`Event scheduler unavailable for ${job.job}:${job.partition}`,
			);
		}
		scheduled++;
	}
	const last = page[page.length - 1];
	const hasMore = shardRows.results.length > SHARDS_PER_SWEEP_JOB;
	if (hasMore) {
		await env.GATOPAGO_DB.prepare(
			`UPDATE indexer_safety_sweep_state
			 SET cursor_stream = ?, cursor_shard_id = ?, updated_at = ?
			 WHERE chain_id = ? AND target_block = ?`,
		)
			.bind(
				last.stream,
				last.shard_id,
				new Date().toISOString(),
				network.chainId,
				scanHead.toString(),
			)
			.run();
	} else {
		await env.GATOPAGO_DB.prepare(
			`DELETE FROM indexer_safety_sweep_state
			 WHERE chain_id = ? AND target_block = ?`,
		)
			.bind(network.chainId, scanHead.toString())
			.run();
	}
	logInfo("indexer_safety_sweep", {
		chainId: network.chainId,
		scanHead: scanHead.toString(),
		activeShards: page.length,
		scheduled,
		hasMore,
	});
	return {
		activeShards: page.length,
		scheduled,
		nextRunAt:
			Date.now() +
			(hasMore ? 1_000 : safetySweepIntervalMs(env)),
	};
}

export const __test = {
	safetySweepIntervalMs,
};
