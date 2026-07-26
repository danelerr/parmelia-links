import type { Bindings } from "../middlewares/auth";
import { runAccountOperationReconciler } from "./accountOperations";
import { syncAlchemyWebhookAddresses } from "./alchemyWebhookAddresses";
import {
	consumeBalanceRefreshQueue,
	drainBalanceRefreshRequests,
	scheduleStaleRpcOnlyBalanceMaintenance,
} from "./balanceReconciler";
import { runCrosschainRelayer } from "./crosschainRelayer";
import {
	runIndexer,
	runRecoveryWatcher,
	runRouterWatcher,
	runUserOperationWatcher,
} from "./indexer";
import { logError, logInfo, logWarn } from "./logger";
import { runPaymentReconciler } from "./settlement";
import { acquireLease, releaseLease } from "./storage";
import { drainUserEventOutbox } from "./userEventOutbox";
import { deliverPendingWebhooks, migrateWebhookSecrets } from "./webhooks";

export const BALANCE_REFRESH_QUEUE_NAME = "parmelia-balance-refresh";
export const SCHEDULED_JOBS_QUEUE_NAME = "parmelia-scheduled-jobs";

const CRON_INTERVAL_MS = 2 * 60_000;
// A Queue consumer can run for at most 15 minutes. A slightly longer durable
// lease prevents a duplicate cron delivery from overlapping a timed-out job;
// the following tick resumes it after the lease expires.
const JOB_LEASE_TTL_MS = 16 * 60_000;

const JOB_DEFINITIONS = [
	{ job: "indexer", everyTicks: 1, delaySeconds: 0 },
	{ job: "user_operation_watcher", everyTicks: 1, delaySeconds: 3 },
	{ job: "router_watcher", everyTicks: 1, delaySeconds: 6 },
	{ job: "recovery_watcher", everyTicks: 1, delaySeconds: 9 },
	// Disabled deployments return immediately. When enabled, a ten-minute
	// cadence is enough for the Alchemy Address Activity control plane.
	{ job: "alchemy_address_sync", everyTicks: 5, delaySeconds: 12 },
	{ job: "balance_refresh_maintenance", everyTicks: 1, delaySeconds: 18 },
	{ job: "balance_refresh_repair", everyTicks: 1, delaySeconds: 24 },
	{ job: "payment_reconciler", everyTicks: 1, delaySeconds: 30 },
	{ job: "account_operation_reconciler", everyTicks: 1, delaySeconds: 36 },
	{ job: "crosschain_relayer", everyTicks: 1, delaySeconds: 42 },
	{ job: "webhook_delivery", everyTicks: 1, delaySeconds: 60 },
	{ job: "user_event_delivery", everyTicks: 1, delaySeconds: 66 },
	// Key rotation is durable and incremental; running hourly avoids spending a
	// Worker invocation every two minutes when there is nothing to rotate.
	{ job: "webhook_key_rotation", everyTicks: 30, delaySeconds: 90 },
] as const;

export type ScheduledJobName = (typeof JOB_DEFINITIONS)[number]["job"];

export type ScheduledJobMessage = {
	schemaVersion: 1;
	job: ScheduledJobName;
	scheduleSlot: number;
	scheduledAt: string;
};

export type WorkerQueueMessage = unknown;

type ScheduledJobRunner = (
	env: Bindings,
) => Promise<unknown>;

type ScheduledJobExecutor = (
	env: Bindings,
	message: ScheduledJobMessage,
) => Promise<"completed" | "already_running">;

const JOB_RUNNERS: Record<ScheduledJobName, ScheduledJobRunner> = {
	indexer: runIndexer,
	user_operation_watcher: runUserOperationWatcher,
	router_watcher: runRouterWatcher,
	recovery_watcher: runRecoveryWatcher,
	alchemy_address_sync: syncAlchemyWebhookAddresses,
	balance_refresh_maintenance: scheduleStaleRpcOnlyBalanceMaintenance,
	balance_refresh_repair: drainBalanceRefreshRequests,
	// These limits leave headroom beneath the Free-plan 50 external
	// subrequests even when every row needs an upstream point lookup.
	payment_reconciler: (env) => runPaymentReconciler(env, 10),
	account_operation_reconciler: (env) =>
		runAccountOperationReconciler(env, 10),
	crosschain_relayer: (env) => runCrosschainRelayer(env, 5),
	webhook_delivery: (env) => deliverPendingWebhooks(env, 20),
	user_event_delivery: (env) => drainUserEventOutbox(env, 10),
	webhook_key_rotation: migrateWebhookSecrets,
};

const JOB_NAMES = new Set<string>(
	JOB_DEFINITIONS.map((definition) => definition.job),
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScheduledJobMessage(
	value: unknown,
): ScheduledJobMessage | null {
	if (!isRecord(value)) return null;
	if (value.schemaVersion !== 1) return null;
	if (typeof value.job !== "string" || !JOB_NAMES.has(value.job)) return null;
	if (
		typeof value.scheduleSlot !== "number" ||
		!Number.isSafeInteger(value.scheduleSlot) ||
		value.scheduleSlot < 0
	) {
		return null;
	}
	if (
		typeof value.scheduledAt !== "string" ||
		!Number.isFinite(Date.parse(value.scheduledAt))
	) {
		return null;
	}
	return value as ScheduledJobMessage;
}

export function buildScheduledJobBatch(
	scheduledTime: number,
): MessageSendRequest<ScheduledJobMessage>[] {
	if (!Number.isFinite(scheduledTime) || scheduledTime < 0) {
		throw new Error("Invalid cron scheduled time");
	}
	const scheduleSlot = Math.floor(scheduledTime / CRON_INTERVAL_MS);
	const scheduledAt = new Date(scheduledTime).toISOString();
	return JOB_DEFINITIONS.filter(
		(definition) => scheduleSlot % definition.everyTicks === 0,
	).map((definition) => ({
		body: {
			schemaVersion: 1,
			job: definition.job,
			scheduleSlot,
			scheduledAt,
		},
		contentType: "json",
		delaySeconds: definition.delaySeconds,
	}));
}

/**
 * Cron is deliberately only a producer. It performs one Queue binding call and
 * never opens an RPC connection; every external job receives a fresh Worker
 * invocation and therefore an independent subrequest budget.
 */
export async function enqueueScheduledJobs(
	env: Bindings,
	scheduledTime: number,
): Promise<number> {
	if (!env.SCHEDULED_JOBS_QUEUE) {
		throw new Error("SCHEDULED_JOBS_QUEUE binding is missing");
	}
	const messages = buildScheduledJobBatch(scheduledTime);
	await env.SCHEDULED_JOBS_QUEUE.sendBatch(messages);
	logInfo("cron_jobs_enqueued", {
		scheduleSlot: messages[0]?.body.scheduleSlot ?? null,
		jobs: messages.length,
	});
	return messages.length;
}

export async function executeScheduledJob(
	env: Bindings,
	message: ScheduledJobMessage,
): Promise<"completed" | "already_running"> {
	const leaseKey = `scheduled-job:${env.CHAIN_KEY}:${message.job}`;
	const owner = await acquireLease(env, leaseKey, JOB_LEASE_TTL_MS);
	if (!owner) {
		logInfo("scheduled_job_skipped_overlap", {
			job: message.job,
			scheduleSlot: message.scheduleSlot,
		});
		return "already_running";
	}

	const startedAt = Date.now();
	try {
		await JOB_RUNNERS[message.job](env);
		logInfo("scheduled_job_completed", {
			job: message.job,
			scheduleSlot: message.scheduleSlot,
			durationMs: Date.now() - startedAt,
		});
		return "completed";
	} finally {
		await releaseLease(env, leaseKey, owner).catch((error) => {
			logWarn("scheduled_job_lease_release_failed", {
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

/**
 * Process and settle every message independently. A poison message cannot
 * force successful siblings to be delivered again.
 */
export async function consumeScheduledJobsQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
	execute: ScheduledJobExecutor = executeScheduledJob,
): Promise<void> {
	for (const message of batch.messages) {
		const parsed = parseScheduledJobMessage(message.body);
		if (!parsed) {
			logWarn("scheduled_job_message_rejected", {
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
			logError("scheduled_job_failed", error, {
				job: parsed.job,
				messageId: message.id,
				attempts: message.attempts,
				retryDelaySeconds: delaySeconds,
			});
			message.retry({ delaySeconds });
		}
	}
}

/** Route both Queue bindings without interpreting one queue's body as another. */
export async function consumeWorkerQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	if (batch.queue === BALANCE_REFRESH_QUEUE_NAME) {
		await consumeBalanceRefreshQueue(batch, env);
		return;
	}
	if (batch.queue === SCHEDULED_JOBS_QUEUE_NAME) {
		await consumeScheduledJobsQueue(batch, env);
		return;
	}
	logWarn("worker_queue_rejected", {
		queue: batch.queue,
		reason: "unknown_queue",
	});
	batch.ackAll();
}

export const __test = {
	retryDelaySeconds,
};
