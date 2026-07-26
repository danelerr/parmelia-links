import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	__test,
	buildScheduledJobBatch,
	consumeScheduledJobsQueue,
	enqueueScheduledJobs,
	parseScheduledJobMessage,
	SCHEDULED_JOBS_QUEUE_NAME,
	type ScheduledJobMessage,
} from "../src/services/cron";

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

describe("cron Queue orchestration", () => {
	it("fans one cron event into isolated, staggered jobs", () => {
		const scheduledTime = Date.UTC(2026, 6, 26, 12, 0, 0);
		const batch = buildScheduledJobBatch(scheduledTime);

		expect(batch).toHaveLength(13);
		expect(batch.map((message) => message.body.job)).toEqual(
			expect.arrayContaining([
				"indexer",
				"user_operation_watcher",
				"router_watcher",
				"recovery_watcher",
				"balance_refresh_repair",
				"webhook_delivery",
			]),
		);
		expect(new Set(batch.map((message) => message.delaySeconds)).size).toBe(
			batch.length,
		);
		expect(
			batch.every((message) => message.contentType === "json"),
		).toBe(true);
	});

	it("does not spend invocations on slow maintenance every two minutes", () => {
		const batch = buildScheduledJobBatch(
			Date.UTC(2026, 6, 26, 12, 2, 0),
		);
		expect(batch).toHaveLength(11);
		expect(batch.map((message) => message.body.job)).not.toContain(
			"alchemy_address_sync",
		);
		expect(batch.map((message) => message.body.job)).not.toContain(
			"webhook_key_rotation",
		);
	});

	it("uses a single Queue binding call and no RPC or D1 dependency", async () => {
		const sendBatch = vi.fn().mockResolvedValue({
			metadata: {
				metrics: { backlogCount: 0, backlogBytes: 0 },
			},
		});
		const env = {
			SCHEDULED_JOBS_QUEUE: { sendBatch },
		} as unknown as Bindings;

		await expect(
			enqueueScheduledJobs(env, Date.UTC(2026, 6, 26, 12, 2, 0)),
		).resolves.toBe(11);
		expect(sendBatch).toHaveBeenCalledTimes(1);
		expect(sendBatch.mock.calls[0][0]).toHaveLength(11);
	});

	it("rejects poison messages and retries only the failed valid job", async () => {
		const valid = buildScheduledJobBatch(
			Date.UTC(2026, 6, 26, 12, 2, 0),
		).slice(0, 2);
		const first = queueMessage("first", valid[0].body);
		const second = queueMessage("second", valid[1].body, 2);
		const poison = queueMessage("poison", {
			schemaVersion: 999,
			job: "indexer",
		});
		const execute = vi
			.fn<
				(
					env: Bindings,
					message: ScheduledJobMessage,
				) => Promise<"completed">
			>()
			.mockResolvedValueOnce("completed")
			.mockRejectedValueOnce(new Error("RPC unavailable"));

		await consumeScheduledJobsQueue(
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

	it("validates the durable message schema and caps retry backoff", () => {
		const body = buildScheduledJobBatch(
			Date.UTC(2026, 6, 26, 12, 2, 0),
		)[0].body;
		expect(parseScheduledJobMessage(body)).toEqual(body);
		expect(
			parseScheduledJobMessage({ ...body, job: "unknown" }),
		).toBeNull();
		expect(__test.retryDelaySeconds(1)).toBe(15);
		expect(__test.retryDelaySeconds(99)).toBe(240);
	});
});
