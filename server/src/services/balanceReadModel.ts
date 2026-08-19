import { type Address, type Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import type { ChainConsistencyLevel } from "./chainJournal";
import { logWarn } from "./logger";
import { scheduleEventJob } from "./eventScheduler";

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
	const result = await env.GATOPAGO_DB.prepare(
		`SELECT ${SNAPSHOT_COLUMNS}
		 FROM balance_snapshots
		 WHERE uid = ? AND chain_id = ? AND canonical = 1
		 ORDER BY asset`,
	)
		.bind(uid, chainId)
		.all<BalanceSnapshotRow>();
	return result.results.map(mapSnapshot);
}

export async function upsertBalanceSnapshots(
	env: Bindings,
	snapshots: BalanceSnapshot[],
): Promise<{ written: number; rejected: number }> {
	if (snapshots.length === 0) return { written: 0, rejected: 0 };
	const prepared = env.GATOPAGO_DB.prepare(
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
	const results = await env.GATOPAGO_DB.batch(
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

function balanceRefreshKey(chainId: number, accountAddress: string): string {
	return `${chainId}:${accountAddress.toLowerCase()}`;
}

type BalanceRefreshInput = Omit<
	BalanceRefreshMessage,
	"schemaVersion" | "idempotencyKey"
>;

const BALANCE_REFRESH_UPSERT = `INSERT INTO balance_refresh_requests (
		chain_id, account_address, uid, schema_version, reason, priority,
		status, required_block, attempt_count, requested_at, updated_at,
		lease_owner, lease_expires_at, last_error_code
	 ) VALUES (?, ?, ?, 1, ?, ?, 'pending', ?, 0, ?, ?, NULL, NULL, NULL)
	 ON CONFLICT(chain_id, account_address) DO UPDATE SET
	   uid = excluded.uid,
	   reason = CASE
	     WHEN balance_refresh_requests.status IN ('completed', 'failed')
	       OR excluded.priority <= balance_refresh_requests.priority
	     THEN excluded.reason
	     ELSE balance_refresh_requests.reason
	   END,
	   priority = MIN(balance_refresh_requests.priority, excluded.priority),
	   status = 'pending',
	   required_block = CASE
	     WHEN balance_refresh_requests.status IN ('completed', 'failed')
	     THEN excluded.required_block
	     WHEN excluded.priority < balance_refresh_requests.priority
	     THEN excluded.required_block
	     WHEN excluded.priority > balance_refresh_requests.priority
	     THEN balance_refresh_requests.required_block
	     WHEN excluded.required_block IS NULL
	     THEN balance_refresh_requests.required_block
	     WHEN balance_refresh_requests.required_block IS NULL
	     THEN excluded.required_block
	     ELSE MAX(balance_refresh_requests.required_block, excluded.required_block)
	   END,
	   attempt_count = CASE
	     WHEN balance_refresh_requests.status IN ('completed', 'failed')
	       OR excluded.priority < balance_refresh_requests.priority
	     THEN 0
	     ELSE balance_refresh_requests.attempt_count
	   END,
	   requested_at = CASE
	     WHEN balance_refresh_requests.status IN ('completed', 'failed')
	       OR excluded.priority <= balance_refresh_requests.priority
	     THEN excluded.requested_at
	     ELSE balance_refresh_requests.requested_at
	   END,
	   updated_at = excluded.updated_at,
	   lease_owner = NULL,
	   lease_expires_at = NULL,
	   last_error_code = NULL
	 WHERE balance_refresh_requests.status IN ('completed', 'failed')
	    OR (
	      balance_refresh_requests.status = 'processing'
	      AND balance_refresh_requests.lease_expires_at <= excluded.updated_at
	    )
	    OR excluded.priority < balance_refresh_requests.priority
	    OR (
	      excluded.priority = balance_refresh_requests.priority
	      AND excluded.required_block IS NOT NULL
	      AND (
	        balance_refresh_requests.required_block IS NULL
	        OR excluded.required_block > balance_refresh_requests.required_block
	      )
	    )`;

function buildBalanceRefreshMessage(
	input: BalanceRefreshInput,
): BalanceRefreshMessage {
	return {
		...input,
		accountAddress: input.accountAddress.toLowerCase() as Address,
		schemaVersion: 1,
		idempotencyKey: balanceRefreshKey(input.chainId, input.accountAddress),
	};
}

function coalesceBalanceRefreshMessages(
	prior: BalanceRefreshMessage,
	next: BalanceRefreshMessage,
): BalanceRefreshMessage {
	if (next.priority < prior.priority) return next;
	if (next.priority > prior.priority) return prior;

	const priorBlock =
		prior.notBeforeBlock === undefined
			? null
			: BigInt(prior.notBeforeBlock);
	const nextBlock =
		next.notBeforeBlock === undefined
			? null
			: BigInt(next.notBeforeBlock);
	if (nextBlock === null || (priorBlock !== null && priorBlock >= nextBlock)) {
		return prior;
	}
	return next;
}

function prepareBalanceRefreshUpsert(
	env: Bindings,
	message: BalanceRefreshMessage,
	now: string,
) {
	return env.GATOPAGO_DB.prepare(BALANCE_REFRESH_UPSERT).bind(
		message.chainId,
		message.accountAddress,
		message.uid,
		message.reason,
		message.priority,
		message.notBeforeBlock ?? null,
		now,
		now,
	);
}

async function dispatchBalanceRefreshJob(env: Bindings): Promise<void> {
	// One scheduler wake drains many D1 rows through one Multicall batch. This
	// avoids paying one Queue write/read/delete cycle per wallet.
	await scheduleEventJob(env, "balance_refresh", {
		reason: "balance_refresh_requested",
	});
}

export async function requestBalanceRefresh(
	env: Bindings,
	input: BalanceRefreshInput,
): Promise<BalanceRefreshMessage> {
	const now = new Date().toISOString();
	const message = buildBalanceRefreshMessage(input);
	const persisted = await prepareBalanceRefreshUpsert(
		env,
		message,
		now,
	).run();

	// A no-op conflict means an equivalent request is already queued/processing.
	// This is where 1,000 identical Home tabs collapse into zero extra messages.
	const shouldDispatch = (persisted.meta?.changes ?? 0) > 0;
	if (!shouldDispatch) return message;

	await dispatchBalanceRefreshJob(env);
	return message;
}

/**
 * Persist many independent wallet refresh signals with bounded D1 batches, then
 * wake the shared reconciler once. Provider payload size therefore does not
 * translate into one Queue operation per activity.
 */
export async function requestBalanceRefreshBatch(
	env: Bindings,
	inputs: readonly BalanceRefreshInput[],
): Promise<BalanceRefreshMessage[]> {
	const byKey = new Map<string, BalanceRefreshMessage>();
	for (const input of inputs) {
		const message = buildBalanceRefreshMessage(input);
		const prior = byKey.get(message.idempotencyKey);
		if (!prior) {
			byKey.set(message.idempotencyKey, message);
			continue;
		}
		byKey.set(
			message.idempotencyKey,
			coalesceBalanceRefreshMessages(prior, message),
		);
	}

	const messages = [...byKey.values()];
	if (messages.length === 0) return messages;
	const now = new Date().toISOString();
	let shouldDispatch = false;
	for (let offset = 0; offset < messages.length; offset += 100) {
		const chunk = messages.slice(offset, offset + 100);
		const results = await env.GATOPAGO_DB.batch(
			chunk.map((message) =>
				prepareBalanceRefreshUpsert(env, message, now),
			),
		);
		shouldDispatch ||= results.some(
			(result) => (result.meta?.changes ?? 0) > 0,
		);
	}
	if (shouldDispatch) await dispatchBalanceRefreshJob(env);
	return messages;
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
	const result = await env.GATOPAGO_DB.prepare(
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

export type ClaimedBalanceRefresh = {
	request: BalanceRefreshMessage;
	owner: string;
};

export async function claimBalanceRefreshBatch(
	env: Bindings,
	requests: BalanceRefreshMessage[],
	leaseMs = 60_000,
): Promise<ClaimedBalanceRefresh[]> {
	if (requests.length === 0) return [];
	const now = new Date();
	const nowIso = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
	const claims = requests.map((request) => ({
		request,
		owner: crypto.randomUUID(),
	}));
	const prepared = env.GATOPAGO_DB.prepare(
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
	);
	const results = await env.GATOPAGO_DB.batch(
		claims.map(({ request, owner }) =>
			prepared.bind(
				owner,
				leaseExpiresAt,
				nowIso,
				request.chainId,
				request.accountAddress.toLowerCase(),
				nowIso,
			),
		),
	);
	return claims.filter(
		(_, index) => (results[index]?.meta?.changes ?? 0) > 0,
	);
}

export type BalanceRefreshOutcome = ClaimedBalanceRefresh & {
	status: "completed" | "failed";
	errorCode?: string;
};

export async function finishBalanceRefreshBatch(
	env: Bindings,
	outcomes: BalanceRefreshOutcome[],
): Promise<void> {
	if (outcomes.length === 0) return;
	const now = new Date().toISOString();
	const completed = env.GATOPAGO_DB.prepare(
		`UPDATE balance_refresh_requests
		 SET status = 'completed', updated_at = ?, lease_owner = NULL,
		     lease_expires_at = NULL, last_error_code = NULL
		 WHERE chain_id = ? AND account_address = ?
		   AND status = 'processing' AND lease_owner = ?`,
	);
	const failed = env.GATOPAGO_DB.prepare(
		`UPDATE balance_refresh_requests
		 SET status = 'failed', updated_at = ?, lease_owner = NULL,
		     lease_expires_at = NULL, last_error_code = ?
		 WHERE chain_id = ? AND account_address = ?
		   AND status = 'processing' AND lease_owner = ?`,
	);
	await env.GATOPAGO_DB.batch(
		outcomes.map(({ request, owner, status, errorCode }) =>
			status === "completed"
				? completed.bind(
						now,
						request.chainId,
						request.accountAddress.toLowerCase(),
						owner,
					)
				: failed.bind(
						now,
						errorCode ?? "RPC_RECONCILE_FAILED",
						request.chainId,
						request.accountAddress.toLowerCase(),
						owner,
					),
		),
	);
}

export const __test = {
	coalesceBalanceRefreshMessages,
};
