import type { Bindings } from "../../middlewares/auth";
import {
	createChainEpochGuard,
	prepareChainEpochGuardDelete,
	prepareChainEpochGuardInsert,
} from "../chainEpoch";
import { d1First, nowIso } from "./core";

// ===== Indexer cursor =====

export async function getSyncCursor(env: Bindings, key: string): Promise<bigint | null> {
	const row = await d1First<{ last_block: string }>(
		env,
		`SELECT last_block FROM sync_state WHERE key = ? LIMIT 1`,
		[key],
	);
	return row ? BigInt(row.last_block) : null;
}

export async function setSyncCursor(
	env: Bindings,
	key: string,
	lastBlock: bigint,
	options: {
		chainId?: number;
		expectedReorgEpoch?: number;
	} = {},
): Promise<void> {
	if (
		options.expectedReorgEpoch !== undefined &&
		options.chainId === undefined
	) {
		throw new Error("Epoch-guarded cursors require a chain id");
	}
	const epochGuard =
		options.expectedReorgEpoch === undefined ||
		options.chainId === undefined
			? null
			: createChainEpochGuard(
					options.chainId,
					options.expectedReorgEpoch,
				);
	const cursorStatement = env.GATOPAGO_DB.prepare(
		`INSERT INTO sync_state (key, last_block, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET
		   last_block = excluded.last_block,
		   updated_at = excluded.updated_at`,
	).bind(key, lastBlock.toString(), nowIso());
	if (!epochGuard) {
		await cursorStatement.run();
		return;
	}
	await env.GATOPAGO_DB.batch([
		prepareChainEpochGuardInsert(env, epochGuard),
		cursorStatement,
		prepareChainEpochGuardDelete(env, epochGuard),
	]);
}

