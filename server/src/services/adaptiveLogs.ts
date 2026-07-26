export type AdaptiveLogScanStats = {
	calls: number;
	retries: number;
	ranges: number;
	minSpanUsed: bigint;
	maxSpanUsed: bigint;
	finalSpan: bigint;
	logs: number;
};

export type AdaptiveLogScanOptions<Log> = {
	fromBlock: bigint;
	toBlock: bigint;
	minBlockSpan: bigint;
	maxBlockSpan: bigint;
	initialBlockSpan?: bigint;
	fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly Log[]>;
	onRange: (
		logs: readonly Log[],
		range: { fromBlock: bigint; toBlock: bigint },
	) => Promise<void> | void;
	maxTransientRetries?: number;
	/** Hard guard for the Worker's per-invocation external subrequest budget. */
	maxCalls?: number;
};

export class AdaptiveLogScanBudgetExceededError extends Error {
	constructor(maxCalls: number) {
		super(`Adaptive log scan exhausted its ${maxCalls}-call budget`);
		this.name = "AdaptiveLogScanBudgetExceededError";
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause =
			"cause" in error && error.cause instanceof Error
				? ` ${error.cause.message}`
				: "";
		return `${error.name} ${error.message}${cause}`.toLowerCase();
	}
	return String(error).toLowerCase();
}

export function isRangeCapacityError(error: unknown): boolean {
	const text = errorText(error);
	return [
		"block range",
		"range limit",
		"maximum block",
		"max block",
		"too many blocks",
		"query returned more than",
		"response size",
		"result window",
		"limit exceeded",
		"-32005",
		"413",
	].some((needle) => text.includes(needle));
}

export function isTransientRpcError(error: unknown): boolean {
	const text = errorText(error);
	return [
		"429",
		"rate limit",
		"timeout",
		"timed out",
		"network",
		"fetch failed",
		"503",
		"502",
		"temporarily unavailable",
		"rpc circuit is open",
		"rpc lane admission deadline",
	].some((needle) => text.includes(needle));
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function waitWithJitter(attempt: number): Promise<void> {
	const base = Math.min(2_000, 100 * 2 ** attempt);
	const jitter = Math.floor(Math.random() * Math.max(1, base / 3));
	return new Promise((resolve) => setTimeout(resolve, base + jitter));
}

/**
 * Provider-aware ranged scanner.
 *
 * The configured maximum is a hard ceiling. For Alchemy Free it can be 10; for
 * the public Arbitrum reconciliation endpoint it is 2,000. This avoids first
 * issuing an invalid 2,000-block request to a known 10-block endpoint.
 */
export async function scanLogsAdaptive<Log>(
	options: AdaptiveLogScanOptions<Log>,
): Promise<AdaptiveLogScanStats> {
	if (options.fromBlock > options.toBlock) {
		return {
			calls: 0,
			retries: 0,
			ranges: 0,
			minSpanUsed: 0n,
			maxSpanUsed: 0n,
			finalSpan: 0n,
			logs: 0,
		};
	}
	if (options.minBlockSpan < 1n) {
		throw new Error("minBlockSpan must be at least one block");
	}
	if (options.maxBlockSpan < options.minBlockSpan) {
		throw new Error("maxBlockSpan must be >= minBlockSpan");
	}
	if (
		options.maxCalls !== undefined &&
		(!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1)
	) {
		throw new Error("maxCalls must be a positive safe integer");
	}

	let span = clamp(
		options.initialBlockSpan ?? options.maxBlockSpan,
		options.minBlockSpan,
		options.maxBlockSpan,
	);
	let cursor = options.fromBlock;
	let calls = 0;
	let retries = 0;
	let ranges = 0;
	let totalLogs = 0;
	let minSpanUsed = options.maxBlockSpan;
	let maxSpanUsed = 0n;
	const maxTransientRetries = options.maxTransientRetries ?? 3;

	while (cursor <= options.toBlock) {
		const end =
			cursor + span - 1n > options.toBlock
				? options.toBlock
				: cursor + span - 1n;
		const actualSpan = end - cursor + 1n;
		let transientAttempt = 0;

		for (;;) {
			try {
				if (
					options.maxCalls !== undefined &&
					calls >= options.maxCalls
				) {
					throw new AdaptiveLogScanBudgetExceededError(
						options.maxCalls,
					);
				}
				calls++;
				const logs = await options.fetchRange(cursor, end);
				await options.onRange(logs, { fromBlock: cursor, toBlock: end });
				ranges++;
				totalLogs += logs.length;
				if (actualSpan < minSpanUsed) minSpanUsed = actualSpan;
				if (actualSpan > maxSpanUsed) maxSpanUsed = actualSpan;

				// Sparse successful responses earn a cautious increase. Dense
				// responses retain the current span to avoid response-size cliffs.
				if (logs.length <= 100 && span < options.maxBlockSpan) {
					span = clamp(span * 2n, options.minBlockSpan, options.maxBlockSpan);
				}
				cursor = end + 1n;
				break;
			} catch (error) {
				if (isRangeCapacityError(error) && span > options.minBlockSpan) {
					span = clamp(
						(span + 1n) / 2n,
						options.minBlockSpan,
						options.maxBlockSpan,
					);
					retries++;
					// Recompute the end using the smaller span.
					break;
				}
				if (
					isTransientRpcError(error) &&
					transientAttempt < maxTransientRetries
				) {
					await waitWithJitter(transientAttempt);
					transientAttempt++;
					retries++;
					continue;
				}
				throw error;
			}
		}
	}

	return {
		calls,
		retries,
		ranges,
		minSpanUsed: ranges === 0 ? 0n : minSpanUsed,
		maxSpanUsed,
		finalSpan: span,
		logs: totalLogs,
	};
}

export function shardValues<T>(values: readonly T[], shardSize: number): T[][] {
	if (!Number.isSafeInteger(shardSize) || shardSize < 1) {
		throw new Error("shardSize must be a positive safe integer");
	}
	const shards: T[][] = [];
	for (let index = 0; index < values.length; index += shardSize) {
		shards.push(values.slice(index, index + shardSize));
	}
	return shards;
}
