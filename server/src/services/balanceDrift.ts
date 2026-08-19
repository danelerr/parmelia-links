import type { Bindings } from "../middlewares/auth";
import type { BalanceSnapshot } from "./balanceReadModel";
import { logError, logInfo } from "./logger";
import {
	getTransferCoverageForAddress,
	type TransferCheckpointEvidence,
} from "./transferCoverage";

type AssetPolicyRow = {
	strategy: "events" | "events_plus_rpc" | "rpc_only" | "known_operations";
	projection_version: number;
	enabled: number;
	drift_tolerance_raw: string;
};

type BaselineRow = {
	balance_raw: string;
	block_number: number | string;
	block_hash: string;
};

function absolute(value: bigint): bigint {
	return value < 0n ? -value : value;
}

async function projectionDeltaSince(
	env: Bindings,
	snapshot: BalanceSnapshot,
	projectionVersion: number,
	fromExclusive: bigint,
): Promise<bigint> {
	const result = await env.GATOPAGO_DB.prepare(
		`SELECT bpd.delta_raw
		 FROM balance_projection_deltas bpd
		 JOIN chain_events ce
		   ON ce.event_id = bpd.event_id
		  AND ce.block_hash = bpd.block_hash
		  AND ce.canonical = 1
		 WHERE bpd.chain_id = ?
		   AND bpd.projector = 'asset_balance_deltas'
		   AND bpd.projection_version = ?
		   AND bpd.account_address = ?
		   AND bpd.asset = ?
		   AND bpd.canonical = 1
		   AND ce.block_number > ?
		   AND ce.block_number <= ?`,
	)
		.bind(
			snapshot.chainId,
			projectionVersion,
			snapshot.accountAddress.toLowerCase(),
			snapshot.asset,
			fromExclusive.toString(),
			snapshot.blockNumber.toString(),
		)
		.all<{ delta_raw: string }>();
	return result.results.reduce(
		(sum, row) => sum + BigInt(row.delta_raw),
		0n,
	);
}

async function writeBaselineAndAudit(
	env: Bindings,
	snapshot: BalanceSnapshot,
	input: {
		projectionVersion: number;
		projectedRaw: bigint | null;
		driftRaw: bigint | null;
		toleranceRaw: bigint;
		outcome: "baseline" | "match" | "drift" | "deferred";
		correctionReason?: string | null;
		advanceBaseline: boolean;
	},
): Promise<void> {
	const checkedAt = new Date().toISOString();
	const auditId = [
		snapshot.chainId,
		snapshot.accountAddress.toLowerCase(),
		snapshot.asset,
		input.projectionVersion,
		snapshot.blockHash.toLowerCase(),
	].join(":");
	const statements = [
		env.GATOPAGO_DB.prepare(
			`INSERT OR IGNORE INTO balance_reconciliation_audits (
				id, chain_id, account_address, uid, asset, projection_version,
				projected_raw, onchain_raw, drift_raw, tolerance_raw,
				block_number, block_hash, outcome, correction_reason, checked_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			auditId,
			snapshot.chainId,
			snapshot.accountAddress.toLowerCase(),
			snapshot.uid,
			snapshot.asset,
			input.projectionVersion,
			input.projectedRaw?.toString() ?? null,
			snapshot.balanceRaw.toString(),
			input.driftRaw?.toString() ?? null,
			input.toleranceRaw.toString(),
			snapshot.blockNumber.toString(),
			snapshot.blockHash.toLowerCase(),
			input.outcome,
			input.correctionReason ?? null,
			checkedAt,
		),
	];
	if (input.advanceBaseline) {
		statements.push(
			env.GATOPAGO_DB.prepare(
				`INSERT INTO balance_projection_baselines (
					chain_id, account_address, asset, projection_version,
					balance_raw, block_number, block_hash, observed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(
				 	chain_id, account_address, asset, projection_version
				 ) DO UPDATE SET
				 	balance_raw = excluded.balance_raw,
				 	block_number = excluded.block_number,
				 	block_hash = excluded.block_hash,
				 	observed_at = excluded.observed_at
				 WHERE excluded.block_number > balance_projection_baselines.block_number
				    OR (
				    	excluded.block_number = balance_projection_baselines.block_number
				    	AND excluded.block_hash =
				    	    balance_projection_baselines.block_hash
				    )`,
			).bind(
				snapshot.chainId,
				snapshot.accountAddress.toLowerCase(),
				snapshot.asset,
				input.projectionVersion,
				snapshot.balanceRaw.toString(),
				snapshot.blockNumber.toString(),
				snapshot.blockHash.toLowerCase(),
				checkedAt,
			),
		);
	}
	if (input.outcome === "drift") {
		statements.push(
			env.GATOPAGO_DB.prepare(
				`UPDATE asset_indexing_policies
				 SET strategy = 'rpc_only',
				     config_json = ?,
				     updated_at = ?
				 WHERE chain_id = ? AND asset = ?
				   AND projection_version = ?`,
			).bind(
				JSON.stringify({
					degradedAt: checkedAt,
					reason: "exact_projection_drift",
					auditId,
				}),
				checkedAt,
				snapshot.chainId,
				snapshot.asset,
				input.projectionVersion,
			),
		);
	}
	await env.GATOPAGO_DB.batch(statements);
}

/**
 * Compare event-derived raw balances with a coherent RPC batch. RPC remains the
 * financial value written to Home; this function audits/promotes the cheaper
 * projection and degrades it automatically on exact drift.
 */
export async function auditBalanceProjectionDrift(
	env: Bindings,
	snapshots: BalanceSnapshot[],
): Promise<{ checked: number; drifted: number; deferred: number }> {
	let checked = 0;
	let drifted = 0;
	let deferred = 0;
	const coverageByAccount = new Map<
		string,
		Map<string, TransferCheckpointEvidence>
	>();
	for (const snapshot of snapshots) {
		const policy = await env.GATOPAGO_DB.prepare(
			`SELECT strategy, projection_version, enabled, drift_tolerance_raw
			 FROM asset_indexing_policies
			 WHERE chain_id = ? AND asset = ?`,
		)
			.bind(snapshot.chainId, snapshot.asset)
			.first<AssetPolicyRow>();
		if (
			!policy ||
			policy.enabled !== 1 ||
			!["events", "events_plus_rpc"].includes(policy.strategy)
		) continue;

		const tolerance = BigInt(policy.drift_tolerance_raw);
		const baseline = await env.GATOPAGO_DB.prepare(
			`SELECT balance_raw, block_number, block_hash
			 FROM balance_projection_baselines
			 WHERE chain_id = ? AND account_address = ? AND asset = ?
			   AND projection_version = ?`,
		)
			.bind(
				snapshot.chainId,
				snapshot.accountAddress.toLowerCase(),
				snapshot.asset,
				policy.projection_version,
			)
			.first<BaselineRow>();
		if (!baseline) {
			await writeBaselineAndAudit(env, snapshot, {
				projectionVersion: policy.projection_version,
				projectedRaw: null,
				driftRaw: null,
				toleranceRaw: tolerance,
				outcome: "baseline",
				advanceBaseline: true,
			});
			continue;
		}

		const coverageKey =
			`${snapshot.chainId}:${snapshot.accountAddress.toLowerCase()}`;
		let accountCoverage = coverageByAccount.get(coverageKey);
		if (!accountCoverage) {
			accountCoverage = await getTransferCoverageForAddress(
				env,
				snapshot.chainId,
				snapshot.accountAddress,
			);
			coverageByAccount.set(coverageKey, accountCoverage);
		}
		const checkpoint = accountCoverage.get(snapshot.asset) ?? null;
		const baselineBlock = BigInt(baseline.block_number);
		if (
			baselineBlock > snapshot.blockNumber ||
			!checkpoint ||
			checkpoint.blockNumber < snapshot.blockNumber
		) {
			await writeBaselineAndAudit(env, snapshot, {
				projectionVersion: policy.projection_version,
				projectedRaw: null,
				driftRaw: null,
				toleranceRaw: tolerance,
				outcome: "deferred",
				correctionReason: "journal_not_caught_up",
				advanceBaseline: false,
			});
			deferred++;
			continue;
		}

		const delta = await projectionDeltaSince(
			env,
			snapshot,
			policy.projection_version,
			baselineBlock,
		);
		const projected = BigInt(baseline.balance_raw) + delta;
		const drift = snapshot.balanceRaw - projected;
		const outcome = absolute(drift) <= tolerance ? "match" : "drift";
		await writeBaselineAndAudit(env, snapshot, {
			projectionVersion: policy.projection_version,
			projectedRaw: projected,
			driftRaw: drift,
			toleranceRaw: tolerance,
			outcome,
			correctionReason:
				outcome === "drift" ? "policy_degraded_to_rpc_only" : null,
			advanceBaseline: true,
		});
		checked++;
		if (outcome === "drift") {
			drifted++;
			logError(
				"balance_projection_drift",
				new Error("Exact asset projection diverged from RPC"),
				{
					chainId: snapshot.chainId,
					asset: snapshot.asset,
					blockNumber: snapshot.blockNumber.toString(),
					projectionVersion: policy.projection_version,
				},
			);
		}
	}
	if (checked > 0 || deferred > 0) {
		logInfo("balance_projection_reconcile", {
			checked,
			drifted,
			deferred,
		});
	}
	return { checked, drifted, deferred };
}

export const __test = {
	absolute,
};
