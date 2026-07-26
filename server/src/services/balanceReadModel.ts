import { formatUnits, type Address, type Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import type { ChainConsistencyLevel } from "./chainJournal";
import { logWarn } from "./logger";

export type BalanceProjectionStrategy =
	| "events"
	| "events_plus_rpc"
	| "rpc_only"
	| "known_operations";

export type BalanceSnapshot = {
	uid: string;
	accountAddress: Address;
	chainId: number;
	asset: string;
	balanceRaw: bigint;
	decimals: number;
	blockNumber: bigint;
	blockHash: Hex;
	consistencyLevel: ChainConsistencyLevel;
	projectionStrategy: BalanceProjectionStrategy;
	projectionVersion: number;
	observedAt: string;
	reconciledAt: string | null;
	source: string;
	canonical?: boolean;
};

type BalanceSnapshotRow = {
	uid: string;
	account_address: string;
	chain_id: number;
	asset: string;
	balance_raw: string;
	decimals: number;
	block_number: number | string;
	block_hash: string;
	consistency_level: ChainConsistencyLevel;
	projection_strategy: BalanceProjectionStrategy;
	projection_version: number;
	observed_at: string;
	reconciled_at: string | null;
	source: string;
	canonical: number;
};

export type BalanceRefreshMessage = {
	schemaVersion: 1;
	idempotencyKey: string;
	uid: string;
	accountAddress: Address;
	chainId: number;
	reason: string;
	priority: 0 | 1 | 2 | 3 | 4;
	notBeforeBlock?: string;
};

export type BalanceRefreshRequest = BalanceRefreshMessage & {
	attemptCount: number;
	requestedAt: string;
};

function mapSnapshot(row: BalanceSnapshotRow): BalanceSnapshot {
	return {
		uid: row.uid,
		accountAddress: row.account_address as Address,
		chainId: row.chain_id,
		asset: row.asset,
		balanceRaw: BigInt(row.balance_raw),
		decimals: row.decimals,
		blockNumber: BigInt(row.block_number),
		blockHash: row.block_hash as Hex,
		consistencyLevel: row.consistency_level,
		projectionStrategy: row.projection_strategy,
		projectionVersion: row.projection_version,
		observedAt: row.observed_at,
		reconciledAt: row.reconciled_at,
		source: row.source,
		canonical: row.canonical === 1,
	};
}

const SNAPSHOT_COLUMNS = `uid, account_address, chain_id, asset, balance_raw,
	decimals, block_number, block_hash, consistency_level, projection_strategy,
	projection_version, observed_at, reconciled_at, source, canonical`;

export async function listBalanceSnapshots(
	env: Bindings,
	uid: string,
	chainId: number,
): Promise<BalanceSnapshot[]> {
	const result = await env.PARMELIA_DB.prepare(
		`SELECT ${SNAPSHOT_COLUMNS}
		 FROM balance_snapshots
		 WHERE uid = ? AND chain_id = ? AND canonical = 1
		 ORDER BY asset`,
	)
		.bind(uid, chainId)
		.all<BalanceSnapshotRow>();
	return result.results.map(mapSnapshot);
}

export function formatSnapshotBalances(
	snapshots: BalanceSnapshot[],
): Record<string, string> {
	return Object.fromEntries(
		snapshots.map((snapshot) => [
			snapshot.asset,
			formatUnits(snapshot.balanceRaw, snapshot.decimals),
		]),
	);
}

export async function upsertBalanceSnapshots(
	env: Bindings,
	snapshots: BalanceSnapshot[],
): Promise<{ written: number; rejected: number }> {
	if (snapshots.length === 0) return { written: 0, rejected: 0 };
	const prepared = env.PARMELIA_DB.prepare(
		`INSERT INTO balance_snapshots (
			uid, account_address, chain_id, asset, balance_raw, decimals,
			block_number, block_hash, consistency_level, projection_strategy,
			projection_version, observed_at, reconciled_at, source, canonical
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(chain_id, account_address, asset) DO UPDATE SET
		 	uid = excluded.uid,
		 	balance_raw = excluded.balance_raw,
		 	decimals = excluded.decimals,
		 	block_number = excluded.block_number,
		 	block_hash = excluded.block_hash,
		 	consistency_level = excluded.consistency_level,
		 	projection_strategy = excluded.projection_strategy,
		 	projection_version = excluded.projection_version,
		 	observed_at = excluded.observed_at,
		 	reconciled_at = excluded.reconciled_at,
		 	source = excluded.source,
		 	canonical = 1
		 WHERE balance_snapshots.canonical = 0
		    OR excluded.block_number > balance_snapshots.block_number
		    OR (
		    	excluded.block_number = balance_snapshots.block_number
		    	AND excluded.block_hash = balance_snapshots.block_hash
		    )`,
	);
	const results = await env.PARMELIA_DB.batch(
		snapshots.map((snapshot) =>
			prepared.bind(
				snapshot.uid,
				snapshot.accountAddress.toLowerCase(),
				snapshot.chainId,
				snapshot.asset,
				snapshot.balanceRaw.toString(),
				snapshot.decimals,
				snapshot.blockNumber.toString(),
				snapshot.blockHash.toLowerCase(),
				snapshot.consistencyLevel,
				snapshot.projectionStrategy,
				snapshot.projectionVersion,
				snapshot.observedAt,
				snapshot.reconciledAt,
				snapshot.source,
			),
		),
	);
	const written = results.filter((result) => (result.meta?.changes ?? 0) > 0).length;
	const rejected = snapshots.length - written;
	if (rejected > 0) {
		logWarn("balance_snapshot_write_rejected", {
			rejected,
			reason: "out_of_order_or_block_hash_conflict",
		});
	}
	return { written, rejected };
}

export function balanceRefreshKey(chainId: number, accountAddress: string): string {
	return `${chainId}:${accountAddress.toLowerCase()}`;
}

export async function requestBalanceRefresh(
	env: Bindings,
	input: Omit<BalanceRefreshMessage, "schemaVersion" | "idempotencyKey">,
): Promise<BalanceRefreshMessage> {
	const now = new Date().toISOString();
	const message: BalanceRefreshMessage = {
		...input,
		accountAddress: input.accountAddress.toLowerCase() as Address,
		schemaVersion: 1,
		idempotencyKey: balanceRefreshKey(input.chainId, input.accountAddress),
	};

	await env.PARMELIA_DB.prepare(
		`INSERT INTO balance_refresh_requests (
			chain_id, account_address, uid, schema_version, reason, priority,
			status, required_block, attempt_count, requested_at, updated_at,
			lease_owner, lease_expires_at, last_error_code
		 ) VALUES (?, ?, ?, 1, ?, ?, 'pending', ?, 0, ?, ?, NULL, NULL, NULL)
		 ON CONFLICT(chain_id, account_address) DO UPDATE SET
		 	uid = excluded.uid,
		 	reason = excluded.reason,
		 	priority = MIN(balance_refresh_requests.priority, excluded.priority),
		 	status = CASE
		 		WHEN balance_refresh_requests.status = 'processing'
		 		  AND balance_refresh_requests.lease_expires_at > excluded.updated_at
		 		THEN 'processing'
		 		ELSE 'pending'
		 	END,
		 	required_block = CASE
		 		WHEN excluded.required_block IS NULL THEN balance_refresh_requests.required_block
		 		WHEN balance_refresh_requests.required_block IS NULL THEN excluded.required_block
		 		ELSE MAX(balance_refresh_requests.required_block, excluded.required_block)
		 	END,
		 	updated_at = excluded.updated_at,
		 	last_error_code = NULL`,
	)
		.bind(
			message.chainId,
			message.accountAddress,
			message.uid,
			message.reason,
			message.priority,
			message.notBeforeBlock ?? null,
			now,
			now,
		)
		.run();

	// Queue is the accelerator; the D1 row above is the durable fallback. A
	// missing Queue binding or transient send failure is repaired by cron.
	if (env.BALANCE_REFRESH_QUEUE) {
		try {
			await env.BALANCE_REFRESH_QUEUE.send(message, { contentType: "json" });
		} catch (error) {
			logWarn("balance_refresh_queue_send_failed", {
				errorName: error instanceof Error ? error.name : "unknown",
			});
		}
	}
	return message;
}

type RefreshRequestRow = {
	chain_id: number;
	account_address: string;
	uid: string;
	reason: string;
	priority: 0 | 1 | 2 | 3 | 4;
	required_block: number | string | null;
	attempt_count: number;
	requested_at: string;
};

function mapRefreshRequest(row: RefreshRequestRow): BalanceRefreshRequest {
	return {
		schemaVersion: 1,
		idempotencyKey: balanceRefreshKey(row.chain_id, row.account_address),
		uid: row.uid,
		accountAddress: row.account_address as Address,
		chainId: row.chain_id,
		reason: row.reason,
		priority: row.priority,
		notBeforeBlock:
			row.required_block === null ? undefined : String(row.required_block),
		attemptCount: row.attempt_count,
		requestedAt: row.requested_at,
	};
}

export async function listDueBalanceRefreshes(
	env: Bindings,
	limit = 25,
): Promise<BalanceRefreshRequest[]> {
	const now = new Date().toISOString();
	const result = await env.PARMELIA_DB.prepare(
		`SELECT chain_id, account_address, uid, reason, priority, required_block,
		        attempt_count, requested_at
		 FROM balance_refresh_requests
		 WHERE status IN ('pending', 'failed')
		    OR (status = 'processing' AND lease_expires_at <= ?)
		 ORDER BY priority ASC, requested_at ASC
		 LIMIT ?`,
	)
		.bind(now, limit)
		.all<RefreshRequestRow>();
	return result.results.map(mapRefreshRequest);
}

export async function claimBalanceRefresh(
	env: Bindings,
	request: Pick<BalanceRefreshMessage, "chainId" | "accountAddress">,
	leaseMs = 60_000,
): Promise<string | null> {
	const owner = crypto.randomUUID();
	const now = new Date();
	const nowIso = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
	const result = await env.PARMELIA_DB.prepare(
		`UPDATE balance_refresh_requests
		 SET status = 'processing',
		     lease_owner = ?,
		     lease_expires_at = ?,
		     attempt_count = attempt_count + 1,
		     updated_at = ?
		 WHERE chain_id = ? AND account_address = ?
		   AND (
		   	status IN ('pending', 'failed')
		   	OR (status = 'processing' AND lease_expires_at <= ?)
		   )`,
	)
		.bind(
			owner,
			leaseExpiresAt,
			nowIso,
			request.chainId,
			request.accountAddress.toLowerCase(),
			nowIso,
		)
		.run();
	return (result.meta?.changes ?? 0) > 0 ? owner : null;
}

export async function completeBalanceRefresh(
	env: Bindings,
	request: Pick<BalanceRefreshMessage, "chainId" | "accountAddress">,
	owner: string,
): Promise<boolean> {
	const result = await env.PARMELIA_DB.prepare(
		`UPDATE balance_refresh_requests
		 SET status = 'completed', updated_at = ?, lease_owner = NULL,
		     lease_expires_at = NULL, last_error_code = NULL
		 WHERE chain_id = ? AND account_address = ?
		   AND status = 'processing' AND lease_owner = ?`,
	)
		.bind(
			new Date().toISOString(),
			request.chainId,
			request.accountAddress.toLowerCase(),
			owner,
		)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function failBalanceRefresh(
	env: Bindings,
	request: Pick<BalanceRefreshMessage, "chainId" | "accountAddress">,
	owner: string,
	errorCode: string,
): Promise<void> {
	await env.PARMELIA_DB.prepare(
		`UPDATE balance_refresh_requests
		 SET status = 'failed', updated_at = ?, lease_owner = NULL,
		     lease_expires_at = NULL, last_error_code = ?
		 WHERE chain_id = ? AND account_address = ?
		   AND status = 'processing' AND lease_owner = ?`,
	)
		.bind(
			new Date().toISOString(),
			errorCode,
			request.chainId,
			request.accountAddress.toLowerCase(),
			owner,
		)
		.run();
}

export function parseBalanceRefreshMessage(
	value: unknown,
): BalanceRefreshMessage | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<BalanceRefreshMessage>;
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.idempotencyKey !== "string" ||
		typeof candidate.uid !== "string" ||
		typeof candidate.accountAddress !== "string" ||
		!/^0x[0-9a-fA-F]{40}$/.test(candidate.accountAddress) ||
		!Number.isSafeInteger(candidate.chainId) ||
		typeof candidate.reason !== "string" ||
		!Number.isSafeInteger(candidate.priority) ||
		(candidate.priority ?? -1) < 0 ||
		(candidate.priority ?? 5) > 4
	) {
		return null;
	}
	const expectedKey = balanceRefreshKey(
		candidate.chainId!,
		candidate.accountAddress,
	);
	if (candidate.idempotencyKey !== expectedKey) return null;
	if (
		candidate.notBeforeBlock !== undefined &&
		!/^\d+$/.test(candidate.notBeforeBlock)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		idempotencyKey: expectedKey,
		uid: candidate.uid,
		accountAddress: candidate.accountAddress.toLowerCase() as Address,
		chainId: candidate.chainId!,
		reason: candidate.reason,
		priority: candidate.priority as 0 | 1 | 2 | 3 | 4,
		notBeforeBlock: candidate.notBeforeBlock,
	};
}
