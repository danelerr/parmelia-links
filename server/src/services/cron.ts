export type NamedCronJob = {
	name: string;
	run: () => Promise<unknown>;
};

export type CronJobFailure = {
	name: string;
	reason: unknown;
};

/** Wait for every job, including those still running after an earlier failure. */
export async function runCronJobs(jobs: NamedCronJob[]): Promise<CronJobFailure[]> {
	const results = await Promise.allSettled(
		jobs.map((job) => Promise.resolve().then(job.run)),
	);
	return results.flatMap((result, index) =>
		result.status === "rejected"
			? [{ name: jobs[index].name, reason: result.reason }]
			: [],
	);
}
