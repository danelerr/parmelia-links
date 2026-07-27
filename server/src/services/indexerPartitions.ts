import type { Address } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { scheduleEventJob } from "./eventScheduler";
import {
	assignWalletToStableShard,
	listIndexerShardIds,
	listWalletShardAssignments,
	type WalletShardAssignment,
} from "./indexerShards";
import { logError, logInfo } from "./logger";
import {
	alchemyWebhookPartition,
	alchemyWebhookSlotForShard,
	getAlchemyAddressWebhookConfigs,
} from "./alchemyWebhookConfig";

export type TransferDirection = "from" | "to";

export type TransferIndexerPartition = {
	token: Address;
	direction: TransferDirection;
	shardId: number;
};

type RegistryRow = {
	uid: string;
	wallet_address: string | null;
	attempt_count: number;
};

function boundedInteger(
	raw: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.min(maximum, Math.max(minimum, parsed));
}

export function transferAssignmentStream(chainId: number): string {
	return `erc20_transfers:${chainId}`;
}

export function recoveryAssignmentStream(chainId: number): string {
	return `recovery:${chainId}`;
}

export function userOperationAssignmentStream(chainId: number): string {
	return `userops:${chainId}`;
}

export function transferPartitionKey(
	partition: TransferIndexerPartition,
): string {
	return `transfer:${partition.token.toLowerCase()}:${partition.direction}:shard:${partition.shardId}`;
}

export function transferJournalStream(
	chainId: number,
	partition: TransferIndexerPartition,
): string {
	if (!Number.isSafeInteger(chainId) || chainId < 1) {
		throw new Error("Indexer chain id is invalid");
	}
	return `erc20_transfers:${chainId}:${partition.token.toLowerCase()}:${partition.direction}:shard:${partition.shardId}`;
}

export function transferSyncCursorKey(
	chainId: number,
	partition: TransferIndexerPartition,
): string {
	if (!Number.isSafeInteger(chainId) || chainId < 1) {
		throw new Error("Indexer chain id is invalid");
	}
	return `transfers:${chainId}:${partition.token.toLowerCase()}:${partition.direction}:shard:${partition.shardId}`;
}

export function shardPartitionKey(shardId: number): string {
	if (!Number.isSafeInteger(shardId) || shardId < 0) {
		throw new Error("Indexer shard id is invalid");
	}
	return `shard:${shardId}`;
}

export function parseTransferPartition(
	value: string,
): TransferIndexerPartition | null {
	const match =
		/^transfer:(0x[0-9a-fA-F]{40}):(from|to):shard:(\d+)$/u.exec(value);
	if (!match) return null;
	const shardId = Number(match[3]);
	if (!Number.isSafeInteger(shardId) || shardId < 0) return null;
	return {
		token: match[1].toLowerCase() as Address,
		direction: match[2] as TransferDirection,
		shardId,
	};
}

export function parseTransferJournalStream(
	value: string,
): { chainId: number; partition: TransferIndexerPartition } | null {
	const match =
		/^erc20_transfers:(\d+):(0x[0-9a-fA-F]{40}):(from|to):shard:(\d+)$/u.exec(
			value,
		);
	if (!match) return null;
	const chainId = Number(match[1]);
	const shardId = Number(match[4]);
	if (
		!Number.isSafeInteger(chainId) ||
		chainId < 1 ||
		!Number.isSafeInteger(shardId) ||
		shardId < 0
	) {
		return null;
	}
	return {
		chainId,
		partition: {
			token: match[2].toLowerCase() as Address,
			direction: match[3] as TransferDirection,
			shardId,
		},
	};
}

export function parseShardPartition(value: string): number | null {
	const match = /^shard:(\d+)$/u.exec(value);
	if (!match) return null;
	const shardId = Number(match[1]);
	return Number.isSafeInteger(shardId) && shardId >= 0 ? shardId : null;
}

function walletShardSize(env: Bindings): number {
	// 200 shards × 500 wallets preserves the 100k-address ceiling of one
	// Alchemy Address Activity webhook. Larger logical populations use another
	// webhook slot without changing the indexer algorithm.
	return boundedInteger(env.INDEXER_WALLET_SHARD_SIZE, 250, 1, 500);
}

function registryBatchSize(env: Bindings): number {
	return boundedInteger(env.INDEXER_REGISTRY_BATCH_SIZE, 25, 1, 250);
}

async function requireSchedule(
	result: Promise<boolean>,
	description: string,
): Promise<void> {
	if (!(await result)) {
		throw new Error(`Event scheduler unavailable for ${description}`);
	}
}

async function scheduleAssignmentPartitions(
	env: Bindings,
	assignments: readonly WalletShardAssignment[],
	reason: string,
	targetBlock?: bigint,
): Promise<void> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const byStream = new Map(
		assignments.map((assignment) => [assignment.stream, assignment]),
	);
	const transferAssignment = byStream.get(
		transferAssignmentStream(network.chainId),
	);
	const schedules: Promise<void>[] = [];
	if (transferAssignment) {
		for (const token of network.tokens.filter((candidate) => candidate.address)) {
			for (const direction of ["from", "to"] as const) {
				const partition = transferPartitionKey({
					token: token.address!,
					direction,
					shardId: transferAssignment.shardId,
				});
				schedules.push(
					requireSchedule(
						scheduleEventJob(env, "indexer", {
							partition,
							reason,
							...(targetBlock === undefined ? {} : { targetBlock }),
						}),
						partition,
					),
				);
			}
		}
		if (env.ALCHEMY_WEBHOOK_ENABLED === "true") {
			const slot = alchemyWebhookSlotForShard(
				transferAssignment.shardId,
			);
			if (
				!getAlchemyAddressWebhookConfigs(env).some(
					(config) => config.slot === slot,
				)
			) {
				throw new Error(
					`No Alchemy Address Activity webhook is configured for slot ${slot}`,
				);
			}
			schedules.push(
				requireSchedule(
					scheduleEventJob(env, "alchemy_address_sync", {
						partition: alchemyWebhookPartition(slot),
						reason,
					}),
					`alchemy_address_sync:${slot}`,
				),
			);
		}
	}
	const recoveryAssignment = byStream.get(
		recoveryAssignmentStream(network.chainId),
	);
	if (recoveryAssignment) {
		const partition = shardPartitionKey(recoveryAssignment.shardId);
		schedules.push(
			requireSchedule(
				scheduleEventJob(env, "recovery_watcher", {
					partition,
					reason,
					...(targetBlock === undefined ? {} : { targetBlock }),
				}),
				`recovery:${partition}`,
			),
		);
	}
	const userOperationAssignment = byStream.get(
		userOperationAssignmentStream(network.chainId),
	);
	if (userOperationAssignment) {
		const partition = shardPartitionKey(userOperationAssignment.shardId);
		schedules.push(
			requireSchedule(
				scheduleEventJob(env, "user_operation_watcher", {
					partition,
					reason,
					...(targetBlock === undefined ? {} : { targetBlock }),
				}),
				`userops:${partition}`,
			),
		);
	}
	await Promise.all(schedules);
}

export async function scheduleWalletIndexerPartitions(
	env: Bindings,
	walletAddresses: readonly string[],
	reason: string,
	targetBlock?: bigint,
): Promise<number> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const streams = [
		transferAssignmentStream(network.chainId),
		recoveryAssignmentStream(network.chainId),
		userOperationAssignmentStream(network.chainId),
	];
	const assignments = await listWalletShardAssignments(env, {
		chainId: network.chainId,
		streams,
		walletAddresses,
	});
	const expectedAddresses = new Set(
		walletAddresses.map((address) => address.toLowerCase()),
	);
	const assignedStreamsByAddress = new Map<string, Set<string>>();
	for (const assignment of assignments) {
		const address = assignment.walletAddress.toLowerCase();
		const assigned =
			assignedStreamsByAddress.get(address) ?? new Set<string>();
		assigned.add(assignment.stream);
		assignedStreamsByAddress.set(address, assigned);
	}
	const assignmentMissing = [...expectedAddresses].some(
		(address) =>
			(assignedStreamsByAddress.get(address)?.size ?? 0) < streams.length,
	);
	if (assignmentMissing) {
		await scheduleEventJob(env, "indexer_wallet_registry", {
			reason: "wallet_assignment_missing",
		});
	}
	if (assignments.length === 0) {
		return 0;
	}
	const grouped = new Map<string, WalletShardAssignment[]>();
	for (const assignment of assignments) {
		const group = grouped.get(assignment.walletAddress) ?? [];
		group.push(assignment);
		grouped.set(assignment.walletAddress, group);
	}
	await Promise.all(
		[...grouped.values()].map((values) =>
			scheduleAssignmentPartitions(env, values, reason, targetBlock),
		),
	);
	return grouped.size;
}

export async function scheduleTransferIndexerPartitions(
	env: Bindings,
	signals: readonly {
		walletAddress: string;
		token: Address;
		direction: TransferDirection;
		targetBlock: bigint;
	}[],
	reason: string,
): Promise<number> {
	if (signals.length === 0) return 0;
	const network = getNetworkConfig(env.CHAIN_KEY);
	const stream = transferAssignmentStream(network.chainId);
	const assignments = await listWalletShardAssignments(env, {
		chainId: network.chainId,
		streams: [stream],
		walletAddresses: signals.map((signal) => signal.walletAddress),
	});
	const expectedAddresses = new Set(
		signals.map((signal) => signal.walletAddress.toLowerCase()),
	);
	const assignedAddresses = new Set(
		assignments.map((assignment) =>
			assignment.walletAddress.toLowerCase(),
		),
	);
	if (
		[...expectedAddresses].some(
			(address) => !assignedAddresses.has(address),
		)
	) {
		await scheduleEventJob(env, "indexer_wallet_registry", {
			reason: "webhook_wallet_assignment_missing",
		});
	}
	const byAddress = new Map(
		assignments.map((assignment) => [
			assignment.walletAddress.toLowerCase(),
			assignment,
		]),
	);
	const schedules = new Map<
		string,
		{ partition: string; targetBlock: bigint }
	>();
	for (const signal of signals) {
		const assignment = byAddress.get(signal.walletAddress.toLowerCase());
		if (!assignment) continue;
		const partition = transferPartitionKey({
			token: signal.token,
			direction: signal.direction,
			shardId: assignment.shardId,
		});
		const prior = schedules.get(partition);
		if (!prior || signal.targetBlock > prior.targetBlock) {
			schedules.set(partition, {
				partition,
				targetBlock: signal.targetBlock,
			});
		}
	}
	if (schedules.size === 0) return 0;
	await Promise.all(
		[...schedules.values()].map(({ partition, targetBlock }) =>
			requireSchedule(
				scheduleEventJob(env, "indexer", {
					partition,
					targetBlock,
					delayMs: 5_000,
					reason,
				}),
				partition,
			),
		),
	);
	return schedules.size;
}

export async function scheduleWalletWatcherPartitions(
	env: Bindings,
	walletAddresses: readonly string[],
	job: "recovery_watcher" | "user_operation_watcher",
	reason: string,
	targetBlock?: bigint,
): Promise<number> {
	if (walletAddresses.length === 0) return 0;
	const network = getNetworkConfig(env.CHAIN_KEY);
	const stream =
		job === "recovery_watcher"
			? recoveryAssignmentStream(network.chainId)
			: userOperationAssignmentStream(network.chainId);
	const expectedAddresses = new Set(
		walletAddresses.map((address) => address.toLowerCase()),
	);
	const assignments = await listWalletShardAssignments(env, {
		chainId: network.chainId,
		streams: [stream],
		walletAddresses,
	});
	const assignedAddresses = new Set(
		assignments.map((assignment) =>
			assignment.walletAddress.toLowerCase(),
		),
	);
	if (
		[...expectedAddresses].some(
			(address) => !assignedAddresses.has(address),
		)
	) {
		await scheduleEventJob(env, "indexer_wallet_registry", {
			reason: "webhook_wallet_assignment_missing",
		});
	}
	const partitions = new Set(
		assignments.map((assignment) =>
			shardPartitionKey(assignment.shardId),
		),
	);
	await Promise.all(
		[...partitions].map((partition) =>
			requireSchedule(
				scheduleEventJob(env, job, {
					partition,
					reason,
					...(targetBlock === undefined ? {} : { targetBlock }),
				}),
				`${job}:${partition}`,
			),
		),
	);
	return partitions.size;
}

export async function scheduleAllShardPartitions(
	env: Bindings,
	job: "recovery_watcher" | "user_operation_watcher",
	reason: string,
	targetBlock?: bigint,
): Promise<number> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const stream =
		job === "recovery_watcher"
			? recoveryAssignmentStream(network.chainId)
			: userOperationAssignmentStream(network.chainId);
	const shardIds = await listIndexerShardIds(env, {
		chainId: network.chainId,
		stream,
	});
	await Promise.all(
		shardIds.map((shardId) =>
			requireSchedule(
				scheduleEventJob(env, job, {
					partition: shardPartitionKey(shardId),
					reason,
					...(targetBlock === undefined ? {} : { targetBlock }),
				}),
				`${job}:${shardId}`,
			),
		),
	);
	return shardIds.length;
}

export async function drainIndexerWalletRegistry(
	env: Bindings,
): Promise<{ processed: number; nextRunAt: number | null }> {
	const now = new Date().toISOString();
	const rows = await env.PARMELIA_DB.prepare(
		`SELECT uid, wallet_address, attempt_count
		 FROM indexer_wallet_registry_outbox
		 WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
		 ORDER BY next_attempt_at, updated_at
		 LIMIT ?`,
	)
		.bind(now, registryBatchSize(env))
		.all<RegistryRow>();
	if (rows.results.length === 0) {
		const next = await env.PARMELIA_DB.prepare(
			`SELECT MIN(next_attempt_at) AS next_run_at
			 FROM indexer_wallet_registry_outbox
			 WHERE status IN ('pending', 'failed')`,
		).first<{ next_run_at: string | null }>();
		const parsed = next?.next_run_at
			? Date.parse(next.next_run_at)
			: Number.NaN;
		return {
			processed: 0,
			nextRunAt: Number.isFinite(parsed) ? parsed : null,
		};
	}

	const network = getNetworkConfig(env.CHAIN_KEY);
	const streams = [
		transferAssignmentStream(network.chainId),
		recoveryAssignmentStream(network.chainId),
		userOperationAssignmentStream(network.chainId),
	];
	let processed = 0;
	for (const row of rows.results) {
		try {
			const priorTransferAssignment =
				await env.PARMELIA_DB.prepare(
					`SELECT shard_id
					 FROM indexer_wallet_assignments
					 WHERE chain_id = ? AND stream = ? AND uid = ? AND active = 1
					 LIMIT 1`,
				)
					.bind(
						network.chainId,
						transferAssignmentStream(network.chainId),
						row.uid,
					)
					.first<{ shard_id: number }>();
			if (
				env.ALCHEMY_WEBHOOK_ENABLED === "true" &&
				priorTransferAssignment
			) {
				// Durably schedule the old slot before deactivating its D1
				// assignment. This preserves removal work across a Worker crash
				// or an address becoming null.
				const priorSlot = alchemyWebhookSlotForShard(
					priorTransferAssignment.shard_id,
				);
				if (
					!getAlchemyAddressWebhookConfigs(env).some(
						(config) => config.slot === priorSlot,
					)
				) {
					throw new Error(
						`No Alchemy Address Activity webhook is configured for slot ${priorSlot}`,
					);
				}
				await requireSchedule(
					scheduleEventJob(env, "alchemy_address_sync", {
						partition: alchemyWebhookPartition(priorSlot),
						delayMs: 5_000,
						reason: "wallet_registry_deactivated",
					}),
					`alchemy_address_sync:${priorSlot}`,
				);
			}
			const assignments = (
				await Promise.all(
					streams.map((stream) =>
						assignWalletToStableShard(env, {
							chainId: network.chainId,
							stream,
							uid: row.uid,
							walletAddress: row.wallet_address,
							maxWallets: walletShardSize(env),
						}),
					),
				)
			).filter(
				(
					assignment,
				): assignment is WalletShardAssignment => assignment !== null,
			);
			if (assignments.length > 0) {
				await scheduleAssignmentPartitions(
					env,
					assignments,
					"wallet_registry_assigned",
				);
			}
			await env.PARMELIA_DB.prepare(
				`DELETE FROM indexer_wallet_registry_outbox
				 WHERE uid = ? AND wallet_address IS ?`,
			)
				.bind(row.uid, row.wallet_address)
				.run();
			processed++;
		} catch (error) {
			const attempt = row.attempt_count + 1;
			const delayMs = Math.min(
				15 * 60_000,
				15_000 * 2 ** Math.min(6, attempt - 1),
			);
			await env.PARMELIA_DB.prepare(
				`UPDATE indexer_wallet_registry_outbox
				 SET status = 'failed', attempt_count = ?, next_attempt_at = ?,
				     last_error_code = 'INDEXER_WALLET_ASSIGNMENT_FAILED',
				     updated_at = ?
				 WHERE uid = ? AND wallet_address IS ?`,
			)
				.bind(
					attempt,
					new Date(Date.now() + delayMs).toISOString(),
					new Date().toISOString(),
					row.uid,
					row.wallet_address,
				)
				.run();
			logError("indexer_wallet_registry_row_failed", error, {
				uid: row.uid,
				attempt,
			});
		}
	}
	if (processed > 0) {
		await requireSchedule(
			scheduleEventJob(env, "indexer_safety_sweep", {
				reason: "wallet_registry_changed",
			}),
			"indexer_safety_sweep",
		);
	}
	const next = await env.PARMELIA_DB.prepare(
		`SELECT MIN(next_attempt_at) AS next_run_at
		 FROM indexer_wallet_registry_outbox
		 WHERE status IN ('pending', 'failed')`,
	).first<{ next_run_at: string | null }>();
	const parsedNextRun = next?.next_run_at
		? Date.parse(next.next_run_at)
		: Number.NaN;
	const nextRunAt = Number.isFinite(parsedNextRun)
		? Math.max(Date.now() + 1_000, parsedNextRun)
		: null;
	logInfo("indexer_wallet_registry_drained", {
		processed,
		attempted: rows.results.length,
		remaining: nextRunAt !== null,
	});
	return { processed, nextRunAt };
}

export const __test = {
	parseTransferPartition,
	parseTransferJournalStream,
	parseShardPartition,
	transferPartitionKey,
	transferJournalStream,
	transferSyncCursorKey,
	shardPartitionKey,
};
