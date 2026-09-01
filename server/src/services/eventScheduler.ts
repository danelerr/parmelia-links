import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../middlewares/auth";
import { logError, logInfo, logWarn } from "./logger";

export const EVENT_JOB_NAMES = [
	"indexer_wallet_registry",
	"reorg_replay",
	"indexer_safety_sweep",
	"indexer",
	"balance_safety_refresh",
	"user_operation_watcher",
	"router_watcher",
	"recovery_watcher",
	"alchemy_address_sync",
	"balance_refresh",
	"payment_reconciler",
	"account_operation_reconciler",
	"crosschain_relayer",
	"webhook_delivery",
	"user_event_delivery",
	"payments_boundary_sync",
	"webhook_key_rotation",
] as const;

export type EventJobName = (typeof EVENT_JOB_NAMES)[number];

export type EventJobMessage = {
	schemaVersion: 3;
	job: EventJobName;
	partition: string;
	generation: number;
	scheduledAt: string;
	reason: string;
	targetBlock?: string;
};

type ScheduleRequest = {
	job: EventJobName;
	partition: string;
	runAt: number;
	reason: string;
	targetBlock?: string;
};

export type ScheduledEventJob = ScheduleRequest & {
	generation: number;
	state: "scheduled" | "dispatching";
	dispatchAttempts: number;
	createdAt: string;
	updatedAt: string;
};

const JOB_NAME_SET = new Set<string>(EVENT_JOB_NAMES);
const STORAGE_PREFIX = "job:";
const DISPATCH_RETRY_MS = 60_000;
const MAX_DISPATCH_RETRY_MS = 15 * 60_000;
const MAX_REASON_LENGTH = 160;
const MAX_PARTITION_LENGTH = 180;
const MAX_FALLBACK_DELAY_SECONDS = 12 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventJobName(value: unknown): value is EventJobName {
	return typeof value === "string" && JOB_NAME_SET.has(value);
}

function normalizedReason(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const reason = value.trim();
	if (!reason || reason.length > MAX_REASON_LENGTH) return null;
	return reason;
}

function normalizedPartition(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const partition = value.trim();
	if (
		!partition ||
		partition.length > MAX_PARTITION_LENGTH ||
		!/^[a-zA-Z0-9:._-]+$/u.test(partition)
	) {
		return null;
	}
	return partition;
}

function normalizedTargetBlock(value: unknown): string | undefined | null {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^(0|[1-9]\d*)$/u.test(value)) {
		return null;
	}
	try {
		const parsed = BigInt(value);
		return parsed >= 0n ? parsed.toString() : null;
	} catch {
		return null;
	}
}

function parseScheduleRequest(value: unknown): ScheduleRequest | null {
	if (!isRecord(value) || !isEventJobName(value.job)) return null;
	if (
		typeof value.runAt !== "number" ||
		!Number.isSafeInteger(value.runAt) ||
		value.runAt < 0
	) {
		return null;
	}
	const reason = normalizedReason(value.reason);
	const partition = normalizedPartition(value.partition);
	const targetBlock = normalizedTargetBlock(value.targetBlock);
	if (!reason || !partition || targetBlock === null) return null;
	return {
		job: value.job,
		partition,
		runAt: value.runAt,
		reason,
		...(targetBlock === undefined ? {} : { targetBlock }),
	};
}

export function parseEventJobMessage(value: unknown): EventJobMessage | null {
	if (!isRecord(value) || value.schemaVersion !== 3) return null;
	if (!isEventJobName(value.job)) return null;
	if (
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 1
	) {
		return null;
	}
	if (
		typeof value.scheduledAt !== "string" ||
		!Number.isFinite(Date.parse(value.scheduledAt))
	) {
		return null;
	}
	const reason = normalizedReason(value.reason);
	const partition = normalizedPartition(value.partition);
	const targetBlock = normalizedTargetBlock(value.targetBlock);
	if (!reason || !partition || targetBlock === null) return null;
	return {
		schemaVersion: 3,
		job: value.job,
		partition,
		generation: value.generation,
		scheduledAt: value.scheduledAt,
		reason,
		...(targetBlock === undefined ? {} : { targetBlock }),
	};
}

export function mergeScheduledJob(
	existing: ScheduledEventJob | undefined,
	request: ScheduleRequest,
	now = Date.now(),
): { record: ScheduledEventJob; changed: boolean } {
	if (existing && existing.state === "scheduled") {
		const targetAdvanced =
			request.targetBlock !== undefined &&
			(existing.targetBlock === undefined ||
				BigInt(request.targetBlock) > BigInt(existing.targetBlock));
		if (existing.runAt <= request.runAt && !targetAdvanced) {
			return { record: existing, changed: false };
		}
	}
	const timestamp = new Date(now).toISOString();
	const targetBlock =
		existing?.targetBlock === undefined
			? request.targetBlock
			: request.targetBlock === undefined
				? existing.targetBlock
				: BigInt(existing.targetBlock) >= BigInt(request.targetBlock)
					? existing.targetBlock
					: request.targetBlock;
	return {
		record: {
			...request,
			runAt:
				existing?.state === "scheduled"
					? Math.min(existing.runAt, request.runAt)
					: request.runAt,
			...(targetBlock === undefined ? {} : { targetBlock }),
			generation: (existing?.generation ?? 0) + 1,
			state: "scheduled",
			dispatchAttempts: existing?.dispatchAttempts ?? 0,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
		},
		changed: true,
	};
}

function dispatchRetryMs(attempts: number): number {
	const exponent = Math.max(0, Math.min(4, attempts - 1));
	return Math.min(
		MAX_DISPATCH_RETRY_MS,
		DISPATCH_RETRY_MS * 2 ** exponent,
	);
}

function storageKey(job: EventJobName, partition: string): string {
	return `${STORAGE_PREFIX}${job}:${partition}`;
}

function toQueueMessage(record: ScheduledEventJob): MessageSendRequest<EventJobMessage> {
	return {
		body: {
			schemaVersion: 3,
			job: record.job,
			partition: record.partition,
			generation: record.generation,
			scheduledAt: new Date(record.runAt).toISOString(),
			reason: record.reason,
			...(record.targetBlock === undefined
				? {}
				: { targetBlock: record.targetBlock }),
		},
		contentType: "json",
	};
}

/**
 * One Durable Object per chain/job/partition owns one timer. Equivalent wakeups
 * coalesce, while unrelated shards scale across independent objects.
 */
export class EventJobScheduler extends DurableObject<Bindings> {
	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
	}

	private async armEarliestJob(): Promise<number | null> {
		const jobs = await this.ctx.storage.list<ScheduledEventJob>({
			prefix: STORAGE_PREFIX,
		});
		let earliest: number | null = null;
		for (const job of jobs.values()) {
			if (earliest === null || job.runAt < earliest) earliest = job.runAt;
		}
		if (earliest === null) {
			await this.ctx.storage.deleteAlarm();
			return null;
		}
		await this.ctx.storage.setAlarm(Math.max(Date.now(), earliest));
		return earliest;
	}

	private async scheduleParsed(request: ScheduleRequest): Promise<{
		accepted: true;
		changed: boolean;
		job: EventJobName;
		partition: string;
		runAt: number;
		generation: number;
		targetBlock?: string;
	}> {
		const key = storageKey(request.job, request.partition);
		const result = await this.ctx.storage.transaction(async (transaction) => {
			const existing = await transaction.get<ScheduledEventJob>(key);
			const merged = mergeScheduledJob(existing, request);
			if (merged.changed) await transaction.put(key, merged.record);
			return merged;
		});
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (
			result.changed &&
			(currentAlarm === null || result.record.runAt < currentAlarm)
		) {
			await this.ctx.storage.setAlarm(
				Math.max(Date.now(), result.record.runAt),
			);
		}
		return {
			accepted: true,
			changed: result.changed,
			job: result.record.job,
			partition: result.record.partition,
			runAt: result.record.runAt,
			generation: result.record.generation,
			...(result.record.targetBlock === undefined
				? {}
				: { targetBlock: result.record.targetBlock }),
		};
	}

	async schedule(value: unknown) {
		const parsed = parseScheduleRequest(value);
		if (!parsed) throw new Error("Invalid event job schedule request");
		return this.scheduleParsed(parsed);
	}

	async status(): Promise<{
		alarm: number | null;
		jobs: ScheduledEventJob[];
	}> {
		const jobs = await this.ctx.storage.list<ScheduledEventJob>({
			prefix: STORAGE_PREFIX,
		});
		return {
			alarm: await this.ctx.storage.getAlarm(),
			jobs: [...jobs.values()].sort(
				(left, right) => left.runAt - right.runAt,
			),
		};
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const jobs = await this.ctx.storage.list<ScheduledEventJob>({
			prefix: STORAGE_PREFIX,
		});
		const dueCandidates = [...jobs.entries()]
			.filter(([, job]) => job.runAt <= now)
			.sort(([, left], [, right]) => left.runAt - right.runAt);
		if (dueCandidates.length === 0) {
			await this.armEarliestJob();
			return;
		}

		// Mark before the external Queue call. A concurrent schedule request sees
		// `dispatching` and creates a new generation instead of being absorbed by
		// work that may already have read the old D1 state.
		const due: Array<[string, ScheduledEventJob]> = [];
		for (const [key, candidate] of dueCandidates) {
			const claimed = await this.ctx.storage.transaction(
				async (transaction) => {
					const current =
						await transaction.get<ScheduledEventJob>(key);
					if (current?.generation !== candidate.generation) {
						return null;
					}
					const dispatching = {
						...current,
						state: "dispatching" as const,
						updatedAt: new Date(now).toISOString(),
					};
					await transaction.put(key, dispatching);
					return dispatching;
				},
			);
			if (claimed) due.push([key, claimed]);
		}
		if (due.length === 0) {
			await this.armEarliestJob();
			return;
		}

		if (!this.env.SCHEDULED_JOBS_QUEUE) {
			for (const [key, job] of due) {
				await this.ctx.storage.transaction(async (transaction) => {
					const current =
						await transaction.get<ScheduledEventJob>(key);
					if (current?.generation !== job.generation) return;
					const dispatchAttempts =
						(current.dispatchAttempts ?? 0) + 1;
					await transaction.put(key, {
						...current,
						state: "scheduled",
						dispatchAttempts,
						runAt: now + dispatchRetryMs(dispatchAttempts),
						updatedAt: new Date(now).toISOString(),
					});
				});
			}
			await this.armEarliestJob();
			logError(
				"event_scheduler_queue_missing",
				new Error("SCHEDULED_JOBS_QUEUE binding is missing"),
				{ jobs: due.length },
			);
			return;
		}

		try {
			await this.env.SCHEDULED_JOBS_QUEUE.sendBatch(
				due.map(([, job]) => toQueueMessage(job)),
			);
		} catch (error) {
			for (const [key, job] of due) {
				await this.ctx.storage.transaction(async (transaction) => {
					const current =
						await transaction.get<ScheduledEventJob>(key);
					if (current?.generation !== job.generation) return;
					const dispatchAttempts =
						(current.dispatchAttempts ?? 0) + 1;
					await transaction.put(key, {
						...current,
						state: "scheduled",
						dispatchAttempts,
						runAt: now + dispatchRetryMs(dispatchAttempts),
						updatedAt: new Date(now).toISOString(),
					});
				});
			}
			await this.armEarliestJob();
			logError("event_scheduler_dispatch_failed", error, {
				jobs: due.length,
				retryPolicy: "exponential_bounded",
			});
			return;
		}

		for (const [key, dispatched] of due) {
			await this.ctx.storage.transaction(async (transaction) => {
				const current =
					await transaction.get<ScheduledEventJob>(key);
				if (current?.generation === dispatched.generation) {
					await transaction.delete(key);
				}
			});
		}
		await this.armEarliestJob();
		logInfo("event_jobs_dispatched", { jobs: due.length });
	}
}

export async function scheduleEventJob(
	env: Bindings,
	job: EventJobName,
	options: {
		runAt?: number;
		delayMs?: number;
		reason: string;
		partition?: string;
		targetBlock?: bigint | string;
	},
): Promise<boolean> {
	const runAt = Math.max(
		Date.now(),
		Math.trunc(options.runAt ?? Date.now() + (options.delayMs ?? 0)),
	);
	const reason = normalizedReason(options.reason);
	const rawPartition = normalizedPartition(options.partition ?? "global");
	const partition = rawPartition && env.CHAIN_KEY
		? normalizedPartition(`chain:${env.CHAIN_KEY}:${rawPartition}`)
		: rawPartition;
	const targetBlock = normalizedTargetBlock(
		options.targetBlock === undefined
			? undefined
			: options.targetBlock.toString(),
	);
	if (!reason || !partition || targetBlock === null) {
		throw new Error("Event job schedule options are invalid");
	}
	const request: ScheduleRequest = {
		job,
		partition,
		runAt,
		reason,
		...(targetBlock === undefined ? {} : { targetBlock }),
	};

	if (env.EVENT_JOB_SCHEDULER) {
		// `partition` already carries the chain namespace. Keeping the Durable
		// Object name derived from that single canonical value avoids two subtly
		// different identities for the same chain/job pair.
		const schedulerName = `${job}:${partition}`;
		const result = await env.EVENT_JOB_SCHEDULER.getByName(
			schedulerName,
		).schedule(
			request,
		);
		// Coalescing an equivalent/later wakeup is still a successful durable
		// admission. Producers must not retry merely because no state changed.
		return result.accepted === true;
	}

	// Local/test and rolling-deploy compatibility: the Queue can still deliver
	// the event directly. Production uses the Durable Object to coalesce sends.
	if (env.SCHEDULED_JOBS_QUEUE) {
		const delaySeconds = Math.min(
			MAX_FALLBACK_DELAY_SECONDS,
			Math.max(0, Math.ceil((runAt - Date.now()) / 1_000)),
		);
		await env.SCHEDULED_JOBS_QUEUE.send(
			toQueueMessage({
				...request,
				generation: 1,
				state: "scheduled",
				dispatchAttempts: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			}).body,
			{ contentType: "json", delaySeconds },
		);
		return true;
	}

	logWarn("event_scheduler_unavailable", { job, reason });
	return false;
}

export const __test = {
	MAX_REASON_LENGTH,
	parseScheduleRequest,
	dispatchRetryMs,
};
