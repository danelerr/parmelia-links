import { describe, expect, it } from "vitest";
import { runCronJobs } from "../src/services/cron";

describe("cron job orchestration", () => {
	it("waits for remaining jobs after one rejects", async () => {
		let finishSlowJob!: () => void;
		const slowJob = new Promise<void>((resolve) => {
			finishSlowJob = resolve;
		});
		let completed = false;
		const running = runCronJobs([
			{ name: "failed", run: async () => Promise.reject(new Error("failed")) },
			{ name: "slow", run: async () => slowJob },
		]).then((failures) => {
			completed = true;
			return failures;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(completed).toBe(false);

		finishSlowJob();
		const failures = await running;
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ name: "failed", reason: expect.any(Error) });
	});

	it("captures synchronous throws without skipping later jobs", async () => {
		let laterRan = false;
		const failures = await runCronJobs([
			{ name: "sync", run: () => { throw new Error("sync"); } },
			{ name: "later", run: async () => { laterRan = true; } },
		]);

		expect(laterRan).toBe(true);
		expect(failures.map((failure) => failure.name)).toEqual(["sync"]);
	});
});
