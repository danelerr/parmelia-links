import type { Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import {
	chainEventId,
	type JournalEvent,
	type JournalBlock,
} from "./chainJournal";
import { logInfo, logWarn } from "./logger";

export const BALANCE_PROJECTOR_NAME = "asset_balance_deltas";
export const BALANCE_PROJECTOR_VERSION = 1;

export function balanceProjectionAccountKey(
	uid: string,
	accountAddress: string,
): string {
	return `${uid}:${accountAddress.toLowerCase()}`;
}

function aggregateEventDeltas(
	accounts: JournalEvent["accounts"] = [],
): Array<{
	uid: string;
	accountAddress: string;
	asset: string;
	deltaRaw: bigint;
}> {
	const aggregated = new Map<
		string,
		{
			uid: string;
			accountAddress: string;
			asset: string;
			deltaRaw: bigint;
		}
	>();
	for (const account of accounts) {
		if (account.deltaRaw === null || account.deltaRaw === undefined) continue;
		// The projection table has one occurrence per uid+asset. Summing first is
		// essential for ERC-20 self-transfers, whose from/to deltas net to zero.
		const key = `${account.uid}:${account.asset}`;
		const current = aggregated.get(key);
		if (current) {
			current.deltaRaw += account.deltaRaw;
		} else {
			aggregated.set(key, {
				uid: account.uid,
				accountAddress: account.accountAddress,
				asset: account.asset,
				deltaRaw: account.deltaRaw,
			});
		}
	}
	return [...aggregated.values()].filter((entry) => entry.deltaRaw !== 0n);
}

type ProjectionSnapshotState = {
	uid: string;
	balance_raw: string;
	block_number: number | string;
	block_hash: string;
	source: string;
	strategy: "events" | "events_plus_rpc" | "rpc_only" | "known_operations";
	policy_version: number;
	enabled: number;
	baseline_raw: string | null;
	baseline_block_number: number | string | null;
	baseline_block_hash: string | null;
};

function affectedEventAccounts(events: JournalEvent[]) {
	const affected = new Map<
		string,
		{ uid: string; accountAddress: string; asset: string }
	>();
	for (const event of events) {
		for (const account of aggregateEventDeltas(event.accounts)) {
			affected.set(
				`${account.accountAddress.toLowerCase()}:${account.asset}`,
				{
					uid: account.uid,
					accountAddress: account.accountAddress.toLowerCase(),
					asset: account.asset,
				},
			);
		}
	}
	return [...affected.values()];
}

async function refreshProjectedSnapshots(
	env: Bindings,
	input: {
		block: JournalBlock;
		events: JournalEvent[];
	},
): Promise<{
	updated: number;
	eventOnlySatisfiedAccounts: Set<string>;
}> {
	let updated = 0;
	const eventOnlySatisfiedAccounts = new Set<string>();
	for (const account of affectedEventAccounts(input.events)) {
		let state = await env.PARMELIA_DB.prepare(
			`SELECT bs.uid, bs.balance_raw, bs.block_number, bs.block_hash,
			        bs.source, aip.strategy, aip.projection_version AS policy_version,
			        aip.enabled, bpb.balance_raw AS baseline_raw,
			        bpb.block_number AS baseline_block_number,
			        bpb.block_hash AS baseline_block_hash
			 FROM balance_snapshots bs
			 JOIN asset_indexing_policies aip
			   ON aip.chain_id = bs.chain_id AND aip.asset = bs.asset
			 LEFT JOIN balance_projection_baselines bpb
			   ON bpb.chain_id = bs.chain_id
			  AND bpb.account_address = bs.account_address
			  AND bpb.asset = bs.asset
			  AND bpb.projection_version = aip.projection_version
			 WHERE bs.chain_id = ? AND bs.account_address = ?
			   AND bs.asset = ? AND bs.canonical = 1`,
		)
			.bind(
				input.block.chainId,
				account.accountAddress,
				account.asset,
			)
			.first<ProjectionSnapshotState>();
		if (
			!state ||
			state.enabled !== 1 ||
			!["events", "events_plus_rpc"].includes(state.strategy) ||
			state.policy_version !== BALANCE_PROJECTOR_VERSION
		) {
			continue;
		}

		if (
			state.baseline_raw === null ||
			state.baseline_block_number === null ||
			state.baseline_block_hash === null
		) {
			await env.PARMELIA_DB.prepare(
				`INSERT OR IGNORE INTO balance_projection_baselines (
					chain_id, account_address, asset, projection_version,
					balance_raw, block_number, block_hash, observed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					input.block.chainId,
					account.accountAddress,
					account.asset,
					state.policy_version,
					state.balance_raw,
					String(state.block_number),
					state.block_hash.toLowerCase(),
					input.block.observedAt,
				)
				.run();
			state = {
				...state,
				baseline_raw: state.balance_raw,
				baseline_block_number: state.block_number,
				baseline_block_hash: state.block_hash,
			};
		}
		if (
			state.baseline_raw === null ||
			state.baseline_block_number === null
		) {
			continue;
		}

		const baselineBlock = BigInt(state.baseline_block_number);
		if (baselineBlock >= input.block.blockNumber) {
			if (state.strategy === "events") {
				eventOnlySatisfiedAccounts.add(
					balanceProjectionAccountKey(
						account.uid,
						account.accountAddress,
					),
				);
			}
			continue;
		}
		const deltas = await env.PARMELIA_DB.prepare(
			`SELECT bpd.delta_raw
			 FROM balance_projection_deltas bpd
			 JOIN chain_events ce
			   ON ce.event_id = bpd.event_id
			  AND ce.block_hash = bpd.block_hash
			  AND ce.canonical = 1
			 WHERE bpd.chain_id = ?
			   AND bpd.projector = ?
			   AND bpd.projection_version = ?
			   AND bpd.account_address = ?
			   AND bpd.asset = ?
			   AND bpd.canonical = 1
			   AND ce.block_number > ?
			   AND ce.block_number <= ?`,
		)
			.bind(
				input.block.chainId,
				BALANCE_PROJECTOR_NAME,
				state.policy_version,
				account.accountAddress,
				account.asset,
				baselineBlock.toString(),
				input.block.blockNumber.toString(),
			)
			.all<{ delta_raw: string }>();
		const projectedRaw = deltas.results.reduce(
			(sum, row) => sum + BigInt(row.delta_raw),
			BigInt(state.baseline_raw),
		);
		if (projectedRaw < 0n) {
			logWarn("balance_projection_negative_rejected", {
				chainId: input.block.chainId,
				asset: account.asset,
				blockNumber: input.block.blockNumber.toString(),
			});
			continue;
		}

		const result = await env.PARMELIA_DB.prepare(
			`UPDATE balance_snapshots
			 SET balance_raw = ?, block_number = ?, block_hash = ?,
			     consistency_level = ?, projection_strategy = ?,
			     projection_version = ?, observed_at = ?,
			     source = 'event_projection', canonical = 1
			 WHERE chain_id = ? AND account_address = ? AND asset = ?
			   AND canonical = 1
			   AND (
			   	block_number < ?
			   	OR (
			   		block_number = ? AND block_hash = ?
			   		AND source = 'event_projection'
			   	)
			   )`,
		)
			.bind(
				projectedRaw.toString(),
				input.block.blockNumber.toString(),
				input.block.blockHash.toLowerCase(),
				input.block.consistencyLevel,
				state.strategy,
				state.policy_version,
				input.block.observedAt,
				input.block.chainId,
				account.accountAddress,
				account.asset,
				input.block.blockNumber.toString(),
				input.block.blockNumber.toString(),
				input.block.blockHash.toLowerCase(),
			)
			.run();
		if ((result.meta?.changes ?? 0) > 0) {
			updated++;
			if (state.strategy === "events") {
				eventOnlySatisfiedAccounts.add(
					balanceProjectionAccountKey(
						account.uid,
						account.accountAddress,
					),
				);
			}
		}
	}
	if (updated > 0) {
		logInfo("balance_event_snapshots_projected", {
			chainId: input.block.chainId,
			blockNumber: input.block.blockNumber.toString(),
			updated,
		});
	}
	return { updated, eventOnlySatisfiedAccounts };
}

/**
 * Shadow projector: records reversible raw deltas and its watermark but does
 * not yet make event-derived values spendable. RPC snapshots remain the Home
 * source until drift/replay gates promote an asset policy.
 */
export async function projectBalanceDeltas(
	env: Bindings,
	input: {
		block: JournalBlock;
		events: JournalEvent[];
	},
): Promise<{
	updatedSnapshots: number;
	eventOnlySatisfiedAccounts: Set<string>;
}> {
	const statements: D1PreparedStatement[] = [];
	const appliedAt = new Date().toISOString();

	for (const event of input.events) {
		const eventId = chainEventId(
			input.block.chainId,
			event.txHash,
			event.logIndex,
			event.eventKind,
		);
		statements.push(
			env.PARMELIA_DB.prepare(
				`INSERT OR IGNORE INTO projection_applied_events (
					chain_id, projector, projection_version, event_id, block_hash,
					applied_at
				 ) VALUES (?, ?, ?, ?, ?, ?)`,
			).bind(
				input.block.chainId,
				BALANCE_PROJECTOR_NAME,
				BALANCE_PROJECTOR_VERSION,
				eventId,
				event.blockHash.toLowerCase(),
				appliedAt,
			),
		);

		for (const account of aggregateEventDeltas(event.accounts)) {
			statements.push(
				env.PARMELIA_DB.prepare(
					`INSERT OR IGNORE INTO balance_projection_deltas (
						chain_id, projector, projection_version, event_id, block_hash,
						uid, account_address, asset, delta_raw, canonical, applied_at,
						reverted_at
					 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
				).bind(
					input.block.chainId,
					BALANCE_PROJECTOR_NAME,
					BALANCE_PROJECTOR_VERSION,
					eventId,
					event.blockHash.toLowerCase(),
					account.uid,
					account.accountAddress.toLowerCase(),
					account.asset,
					account.deltaRaw.toString(),
					event.canonical === false ? 0 : 1,
					appliedAt,
				),
			);
		}
	}

	statements.push(
		env.PARMELIA_DB.prepare(
			`INSERT INTO projection_watermarks (
				chain_id, projector, projection_version, block_number, block_hash,
				checkpoint_json, updated_at
			 ) VALUES (?, ?, ?, ?, ?, '{}', ?)
			 ON CONFLICT(chain_id, projector, projection_version) DO UPDATE SET
			 	block_number = excluded.block_number,
			 	block_hash = excluded.block_hash,
			 	updated_at = excluded.updated_at
			 WHERE excluded.block_number > projection_watermarks.block_number
			    OR (
			    	excluded.block_number = projection_watermarks.block_number
			    	AND excluded.block_hash = projection_watermarks.block_hash
			    )`,
		).bind(
			input.block.chainId,
			BALANCE_PROJECTOR_NAME,
			BALANCE_PROJECTOR_VERSION,
			input.block.blockNumber.toString(),
			input.block.blockHash.toLowerCase(),
			appliedAt,
		),
	);

	await env.PARMELIA_DB.batch(statements);
	const snapshotResult = await refreshProjectedSnapshots(env, input);
	return {
		updatedSnapshots: snapshotResult.updated,
		eventOnlySatisfiedAccounts:
			snapshotResult.eventOnlySatisfiedAccounts,
	};
}

export async function markProjectionOccurrenceNoncanonical(
	env: Bindings,
	eventId: string,
	blockHash: Hex,
): Promise<void> {
	const now = new Date().toISOString();
	await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`UPDATE balance_projection_deltas
			 SET canonical = 0, reverted_at = ?
			 WHERE event_id = ? AND block_hash = ? AND canonical = 1`,
		).bind(now, eventId, blockHash.toLowerCase()),
		env.PARMELIA_DB.prepare(
			`UPDATE chain_events
			 SET canonical = 0
			 WHERE event_id = ? AND block_hash = ?`,
		).bind(eventId, blockHash.toLowerCase()),
	]);
}

export const __test = {
	aggregateEventDeltas,
	affectedEventAccounts,
	balanceProjectionAccountKey,
};
