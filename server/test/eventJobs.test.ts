import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	__test,
	consumeEventJobsQueue,
	SCHEDULED_JOBS_QUEUE_NAME,
} from "../src/services/eventJobs";
import {
	EVENT_JOB_NAMES,
	mergeScheduledJob,
	parseEventJobMessage,
	scheduleEventJob,
	type EventJobMessage,
} from "../src/services/eventScheduler";

function queueMessage(
	id: string,
	body: unknown,
	attempts = 1,
) {
	return {
		id,
		timestamp: new Date(),
		body,
		attempts,
		ack: vi.fn(() => undefined),
		retry: vi.fn(() => undefined),
	};
}

function messageBatch(messages: Message<unknown>[]): MessageBatch<unknown> {
	return {
		queue: SCHEDULED_JOBS_QUEUE_NAME,
		messages,
		metadata: {
			metrics: {
				backlogCount: messages.length,
				backlogBytes: 0,
			},
		},
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	};
}

function eventMessage(
	job: EventJobMessage["job"] = "indexer",
): EventJobMessage {
	return {
		schemaVersion: 3,
		job,
		partition: "global",
		generation: 1,
		scheduledAt: new Date().toISOString(),
		reason: "test_event",
	};
}

describe("event-driven job orchestration", () => {
	it("ships no static cron trigger or scheduled Worker handler", () => {
		const wrangler = readFileSync(
			new URL("../wrangler.jsonc", import.meta.url),
			"utf8",
		);
		const entrypoint = readFileSync(
			new URL("../src/index.ts", import.meta.url),
			"utf8",
		);
		expect(wrangler).not.toMatch(/["']crons["']\s*:/u);
		expect(wrangler).toContain('"EVENT_JOB_SCHEDULER"');
		expect(wrangler).toContain('"EventJobScheduler"');
		expect(entrypoint).not.toMatch(/\bscheduled\s*\(/u);
	});

	it("contains no unconditional balance-maintenance fanout job", () => {
		expect(EVENT_JOB_NAMES).not.toContain("balance_refresh_maintenance");
		expect(EVENT_JOB_NAMES).toEqual(
			expect.arrayContaining([
				"indexer",
				"user_operation_watcher",
				"router_watcher",
				"recovery_watcher",
				"balance_refresh",
				"webhook_delivery",
			]),
		);
	});

	it("coalesces equivalent/later schedules and only moves a job earlier", () => {
		const now = Date.UTC(2026, 6, 26, 12, 0, 0);
		const first = mergeScheduledJob(
			undefined,
			{ job: "indexer", partition: "global", runAt: now + 60_000, reason: "first" },
			now,
		);
		expect(first.changed).toBe(true);

		const later = mergeScheduledJob(
			first.record,
			{ job: "indexer", partition: "global", runAt: now + 120_000, reason: "later" },
			now + 1,
		);
		expect(later.changed).toBe(false);
		expect(later.record).toEqual(first.record);

		const earlier = mergeScheduledJob(
			first.record,
			{ job: "indexer", partition: "global", runAt: now + 10_000, reason: "urgent" },
			now + 2,
		);
		expect(earlier.changed).toBe(true);
		expect(earlier.record.runAt).toBe(now + 10_000);
		expect(earlier.record.generation).toBe(2);

		const duringDispatch = mergeScheduledJob(
			{ ...first.record, state: "dispatching" },
			{ job: "indexer", partition: "global", runAt: now + 120_000, reason: "new_state" },
			now + 3,
		);
		expect(duringDispatch.changed).toBe(true);
		expect(duringDispatch.record.generation).toBe(2);
	});

	it("schedules through the named Durable Object for its partition", async () => {
		const schedule = vi.fn().mockResolvedValue({
			accepted: true,
			changed: true,
		});
		const getByName = vi.fn(() => ({ schedule }));
		const env = {
			CHAIN_KEY: "arbitrum-sepolia",
			EVENT_JOB_SCHEDULER: { getByName },
		} as unknown as Bindings;

		await expect(
			scheduleEventJob(env, "indexer", {
				delayMs: 1_000,
				reason: "wallet_registered",
			}),
		).resolves.toBe(true);
		expect(getByName).toHaveBeenCalledWith(
			"arbitrum-sepolia:indexer:global",
		);
		expect(schedule).toHaveBeenCalledOnce();
		expect(schedule.mock.calls[0][0]).toMatchObject({
			job: "indexer",
			partition: "global",
			reason: "wallet_registered",
		});
	});

	it("treats a coalesced wakeup as durably accepted", async () => {
		const schedule = vi.fn().mockResolvedValue({
			accepted: true,
			changed: false,
		});
		const env = {
			CHAIN_KEY: "arbitrum-sepolia",
			EVENT_JOB_SCHEDULER: {
				getByName: vi.fn(() => ({ schedule })),
			},
		} as unknown as Bindings;

		await expect(
			scheduleEventJob(env, "indexer", {
				partition: "shard:1",
				reason: "equivalent_signal",
			}),
		).resolves.toBe(true);
	});

	it("rejects poison messages and retries only the failed valid job", async () => {
		const first = queueMessage("first", eventMessage("indexer"));
		const second = queueMessage(
			"second",
			eventMessage("router_watcher"),
			2,
		);
		const poison = queueMessage("poison", {
			schemaVersion: 2,
			job: "indexer",
		});
		const execute = vi
			.fn<
				(
					env: Bindings,
					message: EventJobMessage,
				) => Promise<"completed">
			>()
			.mockResolvedValueOnce("completed")
			.mockRejectedValueOnce(new Error("RPC unavailable"));

		await consumeEventJobsQueue(
			messageBatch([first, second, poison]),
			{} as Bindings,
			execute,
		);

		expect(first.ack).toHaveBeenCalledOnce();
		expect(first.retry).not.toHaveBeenCalled();
		expect(second.ack).not.toHaveBeenCalled();
		expect(second.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
		expect(poison.ack).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("validates the event message schema and caps retry backoff", () => {
		const body = eventMessage();
		expect(parseEventJobMessage(body)).toEqual(body);
		expect(parseEventJobMessage({ ...body, job: "unknown" })).toBeNull();
		expect(parseEventJobMessage({ ...body, generation: 0 })).toBeNull();
		expect(__test.retryDelaySeconds(1)).toBe(15);
		expect(__test.retryDelaySeconds(99)).toBe(240);
	});
});
