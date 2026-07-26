import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	EventJobScheduler,
	type ScheduledEventJob,
	__test,
} from "../src/services/eventScheduler";

class FakeDurableStorage {
	readonly values = new Map<string, unknown>();
	alarmAt: number | null = null;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}

	async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
		return new Map(
			[...this.values.entries()].filter(
				([key]) => !options?.prefix || key.startsWith(options.prefix),
			),
		) as Map<string, T>;
	}

	async transaction<T>(
		callback: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T> {
		return callback(this as unknown as DurableObjectTransaction);
	}

	async getAlarm(): Promise<number | null> {
		return this.alarmAt;
	}

	async setAlarm(value: number | Date): Promise<void> {
		this.alarmAt = value instanceof Date ? value.getTime() : value;
	}

	async deleteAlarm(): Promise<void> {
		this.alarmAt = null;
	}
}

describe("EventJobScheduler Durable Object", () => {
	it("backs off Queue dispatch failures instead of retrying every minute forever", () => {
		expect(__test.dispatchRetryMs(1)).toBe(60_000);
		expect(__test.dispatchRetryMs(2)).toBe(120_000);
		expect(__test.dispatchRetryMs(99)).toBe(15 * 60_000);
	});

	it("collapses 1,000 equivalent wakeups into one stored job and one alarm", async () => {
		const storage = new FakeDurableStorage();
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = new EventJobScheduler(
			{ storage } as unknown as DurableObjectState,
			{
				CHAIN_KEY: "arbitrum-sepolia",
				SCHEDULED_JOBS_QUEUE: { sendBatch },
			} as unknown as Bindings,
		);
		const runAt = Date.now() + 60_000;
		for (let index = 0; index < 1_000; index++) {
			const response = await scheduler.schedule({
				job: "indexer",
				partition: "global",
				runAt: runAt + index,
				reason: "home_stale",
			});
			expect(response.accepted).toBe(true);
		}

		const jobs = await storage.list<ScheduledEventJob>({ prefix: "job:" });
		expect(jobs.size).toBe(1);
		expect(jobs.get("job:indexer:global")?.runAt).toBe(runAt);
		expect(storage.alarmAt).toBe(runAt);
		expect(sendBatch).not.toHaveBeenCalled();
	});

	it("dispatches due work once and removes the alarm when idle", async () => {
		const storage = new FakeDurableStorage();
		const sendBatch = vi.fn().mockResolvedValue(undefined);
		const scheduler = new EventJobScheduler(
			{ storage } as unknown as DurableObjectState,
			{
				CHAIN_KEY: "arbitrum-sepolia",
				SCHEDULED_JOBS_QUEUE: { sendBatch },
			} as unknown as Bindings,
		);
		await scheduler.schedule({
			job: "payment_reconciler",
			partition: "global",
			runAt: Date.now(),
			reason: "payment_submitted",
		});
		await scheduler.alarm();

		expect(sendBatch).toHaveBeenCalledOnce();
		expect(sendBatch.mock.calls[0][0]).toHaveLength(1);
		expect(sendBatch.mock.calls[0][0][0].body).toMatchObject({
			schemaVersion: 3,
			job: "payment_reconciler",
			partition: "global",
			reason: "payment_submitted",
		});
		expect((await storage.list({ prefix: "job:" })).size).toBe(0);
		expect(storage.alarmAt).toBeNull();
	});
});
