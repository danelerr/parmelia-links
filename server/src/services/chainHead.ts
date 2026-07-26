export const SAFE_HEAD_FALLBACK_BLOCKS = 64n;
export const MAX_SAFE_HEAD_LAG_BLOCKS = 512n;

export type ScanHeadClient = {
	getBlockNumber(): Promise<bigint>;
	getBlock(parameters: { blockTag: "safe" }): Promise<{ number: bigint | null }>;
};

export type IndexerScanHead = {
	latest: bigint;
	scanHead: bigint;
	finalitySource: "safe" | "confirmations";
};

/**
 * Avoid the mutable sequencer tip. Arbitrum providers that expose `safe` are
 * preferred; the public endpoint fallback keeps a bounded sequencer buffer.
 *
 * "confirmations" is intentionally not called finality: 64 fast L2 blocks are
 * a reorg buffer, not Ethereum settlement.
 */
export async function getIndexerScanHead(
	publicClient: ScanHeadClient,
): Promise<IndexerScanHead> {
	const latestPromise = publicClient.getBlockNumber();
	try {
		const safe = await publicClient.getBlock({ blockTag: "safe" });
		const latest = await latestPromise;
		if (
			safe.number !== null &&
			safe.number <= latest &&
			latest - safe.number <= MAX_SAFE_HEAD_LAG_BLOCKS
		) {
			return { latest, scanHead: safe.number, finalitySource: "safe" };
		}
		return {
			latest,
			scanHead:
				latest > SAFE_HEAD_FALLBACK_BLOCKS
					? latest - SAFE_HEAD_FALLBACK_BLOCKS
					: 0n,
			finalitySource: "confirmations",
		};
	} catch {
		const latest = await latestPromise;
		return {
			latest,
			scanHead:
				latest > SAFE_HEAD_FALLBACK_BLOCKS
					? latest - SAFE_HEAD_FALLBACK_BLOCKS
					: 0n,
			finalitySource: "confirmations",
		};
	}
}

