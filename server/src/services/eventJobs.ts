import type { Bindings } from "../middlewares/auth";
import { getNetworkConfig } from "../../../shared";
import { runAccountOperationReconciler } from "./accountOperations";
import { syncAlchemyWebhookAddresses } from "./alchemyWebhookAddresses";
import { drainBalanceRefreshRequests } from "./balanceReconciler";
import { runCrosschainRelayer } from "./crosschainRelayer";
import {
	type EventJobMessage,
	type EventJobName,
	parseEventJobMessage,
	scheduleEventJob,
} from "./eventScheduler";
import {
	type ChainIndexRunResult,
	runIndexer,
	runRecoveryWatcher,
	runRouterWatcher,
	runUserOperationWatcher,
} from "./indexer";
import {
	drainIndexerWalletRegistry,
	parseShardPartition,
	parseTransferPartition,
	scheduleWalletIndexerPartitions,
	userOperationAssignmentStream,
} from "./indexerPartitions";
import {
	runBalanceSafetyRefresh,
	runIndexerSafetySweep,
} from "./indexerSafety";
import { logError, logInfo, logWarn } from "./logger";
import { runPaymentReconciler } from "./settlement";
import {
	acquireLease,
	listWebhookSecretsNeedingEncryption,
	releaseLease,
} from "./storage";
import { drainUserEventOutbox } from "./userEventOutbox";
import {
	deliverPendingWebhooks,
	migrateWebhookSecrets,
} from "./webhooks";
import { activeWebhookSecretPrefix } from "./webhookSecrets";
import {
	alchemyWebhookPartition,
	getAlchemyAddressWebhookConfigs,
	parseAlchemyWebhookPartition,
} from "./alchemyWebhookConfig";
import { drainChainReorgReplayRequests } from "./reorg";

export const SCHEDULED_JOBS_QUEUE_NAME = "parmelia-scheduled-jobs";

// Queue consumers can run for at most 15 minutes. A slightly longer D1 lease
// makes duplicate at-least-once deliveries inert without a permanent poller.
const JOB_LEASE_TTL_MS = 16 * 60_000;
const FAST_RETRY_MS = 15_000;
const ROUTER_FALLBACK_POLL_MS = 2 * 60_000;

export type WorkerQueueMessage = unknown;

type EventJobRunner = (
	env: Bindings,
	message: EventJobMessage,
) => Promise<unknown>;
type EventJobExecutor = (
	env: Bindings,
	message: EventJobMessage,
) => Promise<"completed" | "already_running">;

const JOB_RUNNERS: Record<EventJobName, EventJobRunner> = {
	indexer_wallet_registry: drainIndexerWalletRegistry,
	reorg_replay: drainChainReorgReplayRequests,
	indexer_safety_sweep: runIndexerSafetySweep,
	indexer: (env, message) => {
		const partition = parseTransferPartition(message.partition);
		if (!partition) throw new Error("Invalid transfer indexer partition");
		return runIndexer(
			env,
			partition,
			message.targetBlock === undefined
				? undefined
				: BigInt(message.targetBlock),
		);
	},
	balance_safety_refresh: (env, message) => {
		const shardId = parseShardPartition(message.partition);
		if (shardId === null) {
			throw new Error("Invalid balance safety partition");
		}
		return runBalanceSafetyRefresh(
			env,
			shardId,
			message.targetBlock === undefined
				? undefined
				: BigInt(message.targetBlock),
		);
	},
	user_operation_watcher: (env, message) => {
		const shardId = parseShardPartition(message.partition);
		if (shardId === null) {
			throw new Error("Invalid UserOperation indexer partition");
		}
		return runUserOperationWatcher(
			env,
			shardId,
			message.targetBlock === undefined
				? undefined
				: BigInt(message.targetBlock),
		);
	},
	router_watcher: (env, message) =>
		runRouterWatcher(
			env,
			message.targetBlock === undefined
				? undefined
				: BigInt(message.targetBlock),
		),
	recovery_watcher: (env, message) => {
		const shardId = parseShardPartition(message.partition);
		if (shardId === null) {
			throw new Error("Invalid recovery indexer partition");
		}
		return runRecoveryWatcher(
			env,
			shardId,
			message.targetBlock === undefined
				? undefined
				: BigInt(message.targetBlock),
		);
	},
	alchemy_address_sync: (env, message) => {
		const slot = parseAlchemyWebhookPartition(message.partition);
		if (slot === null) {
			throw new Error("Invalid Alchemy address webhook partition");
		}
		return syncAlchemyWebhookAddresses(env, slot);
	},
	balance_refresh: (env) => drainBalanceRefreshRequests(env),
	payment_reconciler: (env) => runPaymentReconciler(env, 10),
	account_operation_reconciler: (env) =>
		runAccountOperationReconciler(env, 10),
	crosschain_relayer: (env) => runCrosschainRelayer(env, 5),
	webhook_delivery: (env) => deliverPendingWebhooks(env, 20),
	user_event_delivery: (env) => drainUserEventOutbox(env, 10),
	webhook_key_rotation: (env) => migrateWebhookSecrets(env),
};

type NextRunRow = {
	next_run_at: string | null;
};

function timestampMs(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function noEarlierThan(candidate: number | null, delayMs: number): number | null {
	if (candidate === null) return null;
	return Math.max(Date.now() + delayMs, candidate);
}

async function nextPaymentReconcileRun(env: Bindings): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(
			CASE
				WHEN status = 'processing' THEN lease_expires_at
				ELSE next_attempt_at
			END
		 ) AS next_run_at
		 FROM payment_reconcile_requests
		 WHERE status IN ('pending', 'processing', 'failed')`,
	).first<NextRunRow>();
	return noEarlierThan(timestampMs(row?.next_run_at), FAST_RETRY_MS);
}

async function hasPendingPayments(env: Bindings): Promise<boolean> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT 1 AS present
		 FROM pending_payments
		 WHERE status IN ('submitting', 'submitted')
		 LIMIT 1`,
	).first<{ present: number }>();
	return row?.present === 1;
}

async function hasPendingUserOperationsForPartition(
	env: Bindings,
	partition: string,
): Promise<boolean> {
	const shardId = parseShardPartition(partition);
	if (shardId === null) return false;
	const network = getNetworkConfig(env.CHAIN_KEY);
	const row = await env.PARMELIA_DB.prepare(
		`SELECT 1 AS present
		 FROM pending_payments p
		 JOIN indexer_wallet_assignments a
		   ON a.account_address = lower(p.sender_address)
		  AND a.uid = p.uid
		  AND a.active = 1
		 WHERE p.status IN ('submitting', 'submitted')
		   AND a.chain_id = ? AND a.stream = ? AND a.shard_id = ?
		 LIMIT 1`,
	)
		.bind(
			network.chainId,
			userOperationAssignmentStream(network.chainId),
			shardId,
		)
		.first<{ present: number }>();
	return row?.present === 1;
}

async function nextBalanceRepairRun(env: Bindings): Promise<number | null> {
	const rows = await env.PARMELIA_DB.prepare(
		`SELECT status, attempt_count, updated_at, lease_expires_at
		 FROM balance_refresh_requests
		 WHERE status IN ('pending', 'processing', 'failed')
		 ORDER BY CASE status
		 	WHEN 'pending' THEN 0
		 	WHEN 'processing' THEN 1
		 	ELSE 2
		 END, updated_at ASC
		 LIMIT 100`,
	).all<{
		status: "pending" | "processing" | "failed";
		attempt_count: number;
		updated_at: string;
		lease_expires_at: string | null;
	}>();
	let earliest: number | null = null;
	for (const row of rows.results) {
		const base =
			row.status === "processing"
				? timestampMs(row.lease_expires_at)
				: timestampMs(row.updated_at);
		if (base === null) continue;
		const retryDelay =
			row.status === "failed"
				? Math.min(
						15 * 60_000,
						FAST_RETRY_MS * 2 ** Math.min(6, Math.max(0, row.attempt_count - 1)),
					)
				: FAST_RETRY_MS;
		const candidate =
			row.status === "processing" ? base : base + retryDelay;
		if (earliest === null || candidate < earliest) earliest = candidate;
	}
	return earliest === null ? null : Math.max(Date.now() + 1_000, earliest);
}

async function nextAccountOperationRun(env: Bindings): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT 1 AS present
		 FROM account_operations
		 WHERE status IN ('prepared', 'submitted')
		 LIMIT 1`,
	).first<{ present: number }>();
	return row?.present === 1 ? Date.now() + FAST_RETRY_MS : null;
}

function crosschainPollDelayMs(
	ageMs: number,
	status: string,
): number {
	if (status === "recoverable") {
		return ageMs < 60 * 60_000 ? 60_000 : 5 * 60_000;
	}
	if (status === "minting" && ageMs < 2 * 60_000) return 3_000;
	if (ageMs < 2 * 60_000) return 5_000;
	if (ageMs < 15 * 60_000) return 15_000;
	if (ageMs < 2 * 60 * 60_000) return 60_000;
	return 5 * 60_000;
}

async function nextCrosschainRun(env: Bindings): Promise<number | null> {
	const rows = await env.PARMELIA_DB.prepare(
		`SELECT status, created_at, updated_at
		 FROM crosschain_operations
		 WHERE status IN ('submitted', 'waiting_attestation', 'minting', 'recoverable')
		 ORDER BY updated_at ASC
		 LIMIT 1000`,
	).all<{
		status: string;
		created_at: string;
		updated_at: string;
	}>();
	if (rows.results.length === 0) return null;

	const now = Date.now();
	let earliest: number | null = null;
	for (const row of rows.results) {
		const createdAt = timestampMs(row.created_at);
		const updatedAt = timestampMs(row.updated_at);
		if (createdAt === null || updatedAt === null) continue;
		const candidate =
			updatedAt +
			crosschainPollDelayMs(Math.max(0, now - createdAt), row.status);
		if (earliest === null || candidate < earliest) earliest = candidate;
	}
	return earliest === null ? null : Math.max(now + 1_000, earliest);
}

async function nextWebhookDeliveryRun(env: Bindings): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(
			CASE
				WHEN status = 'processing' THEN next_retry_at
				ELSE COALESCE(next_retry_at, created_at)
			END
		 ) AS next_run_at
		 FROM webhook_deliveries
		 WHERE status IN ('pending', 'processing')`,
	).first<NextRunRow>();
	return noEarlierThan(timestampMs(row?.next_run_at), 1_000);
}

async function nextUserEventRun(env: Bindings): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(
			CASE
				WHEN status = 'processing' THEN lease_expires_at
				ELSE next_attempt_at
			END
		 ) AS next_run_at
		 FROM user_event_outbox
		 WHERE status IN ('pending', 'processing', 'failed')`,
	).first<NextRunRow>();
	return noEarlierThan(timestampMs(row?.next_run_at), 1_000);
}

export async function wakeUserEventDeliveryIfPending(
	env: Bindings,
	reason: string,
): Promise<boolean> {
	const runAt = await nextUserEventRun(env);
	if (runAt === null) return false;
	return scheduleEventJob(env, "user_event_delivery", { runAt, reason });
}

async function nextRouterFallbackRun(env: Bindings): Promise<number | null> {
	// A Custom Alchemy webhook wakes this watcher on the actual InvoicePaid
	// event. Polling remains a bounded compatibility fallback only while at
	// least one (max-24h) intent can still be paid.
	if (env.ALCHEMY_CUSTOM_WEBHOOK_ENABLED === "true") return null;
	const now = new Date().toISOString();
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(expires_at) AS next_run_at
		 FROM payment_intents
		 WHERE status = 'awaiting_payment'
		   AND expires_at IS NOT NULL
		   AND expires_at > ?`,
	)
		.bind(now)
		.first<NextRunRow>();
	const expiresAt = timestampMs(row?.next_run_at);
	if (expiresAt === null || expiresAt <= Date.now()) return null;
	return Math.min(Date.now() + ROUTER_FALLBACK_POLL_MS, expiresAt);
}

async function nextAlchemyAddressSyncRun(
	env: Bindings,
	partition: string,
): Promise<number | null> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") return null;
	const slot = parseAlchemyWebhookPartition(partition);
	const webhook =
		slot === null
			? null
			: getAlchemyAddressWebhookConfigs(env).find(
					(candidate) => candidate.slot === slot,
				);
	if (!webhook) return null;
	const row = await env.PARMELIA_DB.prepare(
		`SELECT 1 AS present
		 FROM provider_subscription_state
		 WHERE provider = 'alchemy' AND subscription_id = ? AND status = 'failed'
		 LIMIT 1`,
	)
		.bind(webhook.id)
		.first<{ present: number }>();
	return row?.present === 1 ? Date.now() + 5 * 60_000 : null;
}

async function nextWebhookKeyRotationRun(env: Bindings): Promise<number | null> {
	const activePrefix = activeWebhookSecretPrefix(env);
	if (!activePrefix) return null;
	const remaining = await listWebhookSecretsNeedingEncryption(
		env,
		activePrefix,
		1,
	);
	return remaining.length > 0 ? Date.now() + 1_000 : null;
}

async function nextIndexerWalletRegistryRun(
	env: Bindings,
): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(next_attempt_at) AS next_run_at
		 FROM indexer_wallet_registry_outbox
		 WHERE status IN ('pending', 'failed')`,
	).first<NextRunRow>();
	const parsed = timestampMs(row?.next_run_at);
	return parsed === null ? null : Math.max(Date.now(), parsed);
}

async function nextReorgReplayRun(env: Bindings): Promise<number | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT MIN(next_attempt_at) AS next_run_at
		 FROM chain_reorg_replay_requests
		 WHERE status IN ('pending', 'failed')`,
	).first<NextRunRow>();
	const parsed = timestampMs(row?.next_run_at);
	return parsed === null ? null : Math.max(Date.now(), parsed);
}

async function nextIndexerSafetySweepRun(
	env: Bindings,
): Promise<number | null> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const active = await env.PARMELIA_DB.prepare(
		`SELECT 1 AS present
		 FROM indexer_shards s
		 WHERE s.chain_id = ?
		   AND s.status = 'active'
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
	return active?.present === 1 ? Date.now() : null;
}

async function scheduleJobContinuations(
	env: Bindings,
	message: EventJobMessage,
	runnerResult: unknown,
	includeTriggeredUserEvents = true,
): Promise<number> {
	const { job } = message;
	const schedules: Array<{
		job: EventJobName;
		runAt: number | null;
		reason: string;
		targetBlock?: bigint;
	}> = [];
	const chainResult =
		runnerResult &&
		typeof runnerResult === "object" &&
		"caughtUp" in runnerResult &&
		"targetBlock" in runnerResult
			? (runnerResult as ChainIndexRunResult)
			: null;
	switch (job) {
		case "indexer_wallet_registry": {
			const registryResult =
				runnerResult &&
				typeof runnerResult === "object" &&
				"nextRunAt" in runnerResult
					? (runnerResult as { nextRunAt: number | null })
					: null;
			schedules.push({
				job,
				runAt:
					registryResult?.nextRunAt ??
					(await nextIndexerWalletRegistryRun(env)),
				reason: "indexer_wallet_registry_remaining",
			});
			break;
		}
		case "reorg_replay": {
			const replayResult =
				runnerResult &&
				typeof runnerResult === "object" &&
				"nextRunAt" in runnerResult
					? (runnerResult as { nextRunAt: number | null })
					: null;
			schedules.push({
				job,
				runAt:
					replayResult?.nextRunAt ??
					(await nextReorgReplayRun(env)),
				reason: "chain_reorg_replay_remaining",
			});
			break;
		}
		case "indexer_safety_sweep": {
			const safetyResult =
				runnerResult &&
				typeof runnerResult === "object" &&
				"nextRunAt" in runnerResult
					? (runnerResult as { nextRunAt: number | null })
					: null;
			schedules.push({
				job,
				runAt:
					safetyResult?.nextRunAt ??
					(await nextIndexerSafetySweepRun(env)),
				reason: "autonomous_indexer_safety",
			});
			break;
		}
		case "balance_safety_refresh":
			break;
		case "payment_reconciler": {
			const runAt = await nextPaymentReconcileRun(env);
			schedules.push({
				job,
				runAt,
				reason: "payment_reconcile_pending",
			});
			break;
		}
		case "user_operation_watcher":
			{
				const pendingInPartition =
					await hasPendingUserOperationsForPartition(
						env,
						message.partition,
					);
			schedules.push({
				job,
				runAt:
					(chainResult && !chainResult.caughtUp) ||
					pendingInPartition
						? Date.now() + FAST_RETRY_MS
						: null,
				reason: "userop_partition_catchup",
				...(chainResult
					? { targetBlock: chainResult.targetBlock }
					: {}),
			});
			}
			break;
		case "router_watcher":
			if (chainResult && !chainResult.caughtUp) {
				schedules.push({
					job,
					runAt: Date.now() + FAST_RETRY_MS,
					reason: "router_partition_catchup",
					targetBlock: chainResult.targetBlock,
				});
			}
			schedules.push({
				job,
				runAt: await nextRouterFallbackRun(env),
				reason: "router_intent_pending_fallback",
			});
			if (message.reason === "alchemy_custom_chain_event") {
				schedules.push({
					job,
					runAt: Date.now() + ROUTER_FALLBACK_POLL_MS,
					reason: "alchemy_custom_finality_followup",
				});
			}
			break;
		case "alchemy_address_sync":
			{
				const syncResult =
					runnerResult &&
					typeof runnerResult === "object" &&
					"remaining" in runnerResult
						? (runnerResult as { remaining: boolean })
						: null;
			schedules.push({
				job,
				runAt: syncResult?.remaining
					? Date.now() + 1_000
					: await nextAlchemyAddressSyncRun(
							env,
							message.partition,
						),
				reason: "alchemy_address_sync_retry",
			});
			}
			break;
		case "balance_refresh":
			schedules.push({
				job,
				runAt: await nextBalanceRepairRun(env),
				reason: "balance_refresh_still_pending",
			});
			break;
		case "account_operation_reconciler":
			schedules.push({
				job,
				runAt: await nextAccountOperationRun(env),
				reason: "account_operation_pending",
			});
			break;
		case "crosschain_relayer":
			schedules.push({
				job,
				runAt: await nextCrosschainRun(env),
				reason: "crosschain_operation_pending",
			});
			break;
		case "webhook_delivery":
			schedules.push({
				job,
				runAt: await nextWebhookDeliveryRun(env),
				reason: "merchant_webhook_retry_due",
			});
			break;
		case "user_event_delivery":
			schedules.push({
				job,
				runAt: await nextUserEventRun(env),
				reason: "user_event_retry_due",
			});
			break;
		case "webhook_key_rotation":
			schedules.push({
				job,
				runAt: await nextWebhookKeyRotationRun(env),
				reason: "webhook_keys_remaining",
			});
			break;
		case "indexer":
			schedules.push({
				job,
				runAt:
					chainResult && !chainResult.caughtUp
						? Date.now() + FAST_RETRY_MS
						: null,
				reason: "transfer_partition_catchup",
				...(chainResult
					? { targetBlock: chainResult.targetBlock }
					: {}),
			});
			break;
		case "recovery_watcher":
			if (chainResult && !chainResult.caughtUp) {
				schedules.push({
					job,
					runAt: Date.now() + FAST_RETRY_MS,
					reason: "recovery_partition_catchup",
					targetBlock: chainResult.targetBlock,
				});
			}
			if (message.reason === "alchemy_custom_chain_event") {
				schedules.push({
					job,
					runAt: Date.now() + ROUTER_FALLBACK_POLL_MS,
					reason: "alchemy_custom_finality_followup",
				});
			}
			break;
	}
	// D1 triggers create Home invalidation rows for balances, ledger entries,
	// payments and account operations. Every background job checks that shared
	// outbox after its domain work so a new writer cannot silently omit a wakeup.
	if (includeTriggeredUserEvents && job !== "user_event_delivery") {
		schedules.push({
			job: "user_event_delivery",
			runAt: await nextUserEventRun(env),
			reason: "triggered_user_event_pending",
		});
	}

	let scheduled = 0;
	for (const schedule of schedules) {
		if (schedule.runAt === null) continue;
		if (
			await scheduleEventJob(env, schedule.job, {
				runAt: schedule.runAt,
				reason: schedule.reason,
				...(schedule.targetBlock === undefined
					? {}
					: { targetBlock: schedule.targetBlock }),
				partition:
					schedule.job === message.job
						? message.partition
						: "global",
			})
		) {
			scheduled++;
		}
	}
	return scheduled;
}

/**
 * One-shot repair for work that predates this architecture or survived a
 * provider outage. It only schedules jobs whose D1 state is currently active.
 * Normal operation never needs a scan: each state transition is its producer.
 */
export async function recoverEventJobs(env: Bindings): Promise<number> {
	const recoveryMessages: EventJobMessage[] = [
		"indexer_wallet_registry",
		"reorg_replay",
		"indexer_safety_sweep",
		"payment_reconciler",
		"router_watcher",
		"balance_refresh",
		"account_operation_reconciler",
		"crosschain_relayer",
		"webhook_delivery",
		"user_event_delivery",
		"webhook_key_rotation",
	].map((job) => ({
		schemaVersion: 3,
		job: job as EventJobName,
		partition: "global",
		generation: 1,
		scheduledAt: new Date().toISOString(),
		reason: "event_architecture_recovery",
	}));
	let scheduled = 0;
	for (const message of recoveryMessages) {
		scheduled += await scheduleJobContinuations(
			env,
			message,
			null,
			false,
		);
	}
	if (await hasPendingPayments(env)) {
		const pending = await env.PARMELIA_DB.prepare(
			`SELECT DISTINCT sender_address
			 FROM pending_payments
			 WHERE status IN ('submitting', 'submitted')`,
		).all<{ sender_address: string }>();
		scheduled += await scheduleWalletIndexerPartitions(
			env,
			pending.results.map((row) => row.sender_address),
			"event_architecture_recovery",
		);
	}
	if (env.ALCHEMY_WEBHOOK_ENABLED === "true") {
		for (const webhook of getAlchemyAddressWebhookConfigs(env)) {
			if (
				await scheduleEventJob(env, "alchemy_address_sync", {
					partition: alchemyWebhookPartition(webhook.slot),
					reason: "event_architecture_recovery",
				})
			) {
				scheduled++;
			}
		}
	}
	logInfo("event_jobs_recovered", { checked: recoveryMessages.length, scheduled });
	return scheduled;
}

export async function executeEventJob(
	env: Bindings,
	message: EventJobMessage,
): Promise<"completed" | "already_running"> {
	const leaseKey =
		`event-job:${env.CHAIN_KEY}:${message.job}:${message.partition}`;
	const owner = await acquireLease(env, leaseKey, JOB_LEASE_TTL_MS);
	if (!owner) {
		logInfo("event_job_skipped_overlap", {
			job: message.job,
			partition: message.partition,
			generation: message.generation,
		});
		return "already_running";
	}

	const startedAt = Date.now();
	try {
		const runnerResult = await JOB_RUNNERS[message.job](env, message);
		await scheduleJobContinuations(env, message, runnerResult);
		logInfo("event_job_completed", {
			job: message.job,
			partition: message.partition,
			generation: message.generation,
			reason: message.reason,
			durationMs: Date.now() - startedAt,
		});
		return "completed";
	} finally {
		await releaseLease(env, leaseKey, owner).catch((error) => {
			logWarn("event_job_lease_release_failed", {
				job: message.job,
				errorName: error instanceof Error ? error.name : "unknown",
			});
		});
	}
}

function retryDelaySeconds(attempts: number): number {
	const exponent = Math.max(0, Math.min(4, attempts - 1));
	return Math.min(5 * 60, 15 * 2 ** exponent);
}

export async function consumeEventJobsQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
	execute: EventJobExecutor = executeEventJob,
): Promise<void> {
	for (const message of batch.messages) {
		const parsed = parseEventJobMessage(message.body);
		if (!parsed) {
			logWarn("event_job_message_rejected", {
				messageId: message.id,
				reason: "invalid_schema",
			});
			message.ack();
			continue;
		}
		try {
			await execute(env, parsed);
			message.ack();
		} catch (error) {
			const delaySeconds = retryDelaySeconds(message.attempts);
			logError("event_job_failed", error, {
				job: parsed.job,
				partition: parsed.partition,
				messageId: message.id,
				attempts: message.attempts,
				retryDelaySeconds: delaySeconds,
			});
			message.retry({ delaySeconds });
		}
	}
}

/** Reject messages from any Queue other than the event-job transport. */
export async function consumeWorkerQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	if (batch.queue === SCHEDULED_JOBS_QUEUE_NAME) {
		await consumeEventJobsQueue(batch, env);
		return;
	}
	logWarn("worker_queue_rejected", {
		queue: batch.queue,
		reason: "unknown_queue",
	});
	batch.ackAll();
}

export const __test = {
	crosschainPollDelayMs,
	retryDelaySeconds,
};
