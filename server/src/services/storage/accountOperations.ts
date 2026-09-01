import type { Bindings } from "../../middlewares/auth";
import { getNetworkConfig } from "../../../../shared";
import { scheduleEventJob } from "../eventScheduler";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./core";

export type AccountOperationKind =
	| "account_create"
	| "faucet"
	| "recovery_propose"
	| "recovery_execute"
	| "recovery_cancel";

export type AccountOperationStatus =
	| "prepared"
	| "submitted"
	| "confirmed"
	| "failed"
	| "needs_review";

export type AccountOperationRecord = {
	id: string;
	uid: string;
	chainId: number;
	chainKey: string;
	kind: AccountOperationKind;
	status: AccountOperationStatus;
	txHash: `0x${string}`;
	rawTransaction: `0x${string}`;
	signerAddress: `0x${string}`;
	nonce: number;
	metadata: Record<string, unknown>;
	attemptCount: number;
	lastError: string | null;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
	confirmedAt: string | null;
	expiresAt: string;
};
type AccountOperationRow = {
	id: string;
	uid: string;
	chain_id: number;
	chain_key: string;
	kind: AccountOperationKind;
	status: AccountOperationStatus;
	tx_hash: `0x${string}`;
	raw_transaction: `0x${string}`;
	signer_address: `0x${string}`;
	nonce: number;
	metadata: string;
	attempt_count: number;
	last_error: string | null;
	error_code: string | null;
	created_at: string;
	updated_at: string;
	confirmed_at: string | null;
	expires_at: string;
};

const ACCOUNT_OPERATION_COLUMNS =
	"id, uid, chain_id, chain_key, kind, status, tx_hash, raw_transaction, signer_address, nonce, metadata, attempt_count, last_error, error_code, created_at, updated_at, confirmed_at, expires_at";
function mapAccountOperationRow(row: AccountOperationRow): AccountOperationRecord {
	return {
		id: row.id,
		uid: row.uid,
		chainId: row.chain_id,
		chainKey: row.chain_key,
		kind: row.kind,
		status: row.status,
		txHash: row.tx_hash,
		rawTransaction: row.raw_transaction,
		signerAddress: row.signer_address,
		nonce: row.nonce,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>,
		attemptCount: row.attempt_count,
		lastError: row.last_error,
		errorCode: row.error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		confirmedAt: row.confirmed_at,
		expiresAt: row.expires_at,
	};
}
// ===== Durable account operations =====

export async function createAccountOperation(
	env: Bindings,
	operation: Omit<
		AccountOperationRecord,
		"status" | "attemptCount" | "lastError" | "errorCode" | "updatedAt" | "confirmedAt"
	>,
): Promise<boolean> {
	await scheduleEventJob(env, "account_operation_reconciler", {
		delayMs: 5_000,
		reason: "account_operation_created",
	});
	const result = await d1Run(
		env,
		`INSERT OR IGNORE INTO account_operations (
			id, uid, chain_id, chain_key, kind, status, tx_hash, raw_transaction, signer_address, nonce,
			metadata, attempt_count, last_error, error_code, created_at, updated_at,
			confirmed_at, expires_at
		) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, NULL, ?)`,
		[
			operation.id,
			operation.uid,
			operation.chainId,
			operation.chainKey,
			operation.kind,
			operation.txHash,
			operation.rawTransaction,
			operation.signerAddress.toLowerCase(),
			operation.nonce,
			JSON.stringify(operation.metadata),
			operation.createdAt,
			operation.createdAt,
			operation.expiresAt,
		],
	);
	return didWrite(result);
}

export async function getAccountOperationById(
	env: Bindings,
	id: string,
): Promise<AccountOperationRecord | null> {
	const row = await d1First<AccountOperationRow>(
		env,
		`SELECT ${ACCOUNT_OPERATION_COLUMNS} FROM account_operations WHERE id = ? LIMIT 1`,
		[id],
	);
	return row ? mapAccountOperationRow(row) : null;
}

export async function getActiveAccountOperation(
	env: Bindings,
	uid: string,
	kind: AccountOperationKind,
	chainId = getNetworkConfig(env.CHAIN_KEY).chainId,
): Promise<AccountOperationRecord | null> {
	const row = await d1First<AccountOperationRow>(
		env,
		`SELECT ${ACCOUNT_OPERATION_COLUMNS} FROM account_operations
		 WHERE uid = ? AND kind = ? AND chain_id = ?
		   AND status IN ('prepared', 'submitted', 'needs_review')
		 ORDER BY created_at DESC LIMIT 1`,
		[uid, kind, chainId],
	);
	return row ? mapAccountOperationRow(row) : null;
}

export async function listActiveAccountOperations(
	env: Bindings,
	limit = 25,
): Promise<AccountOperationRecord[]> {
	const rows = await d1All<AccountOperationRow>(
		env,
		`SELECT ${ACCOUNT_OPERATION_COLUMNS} FROM account_operations
		 WHERE status IN ('prepared', 'submitted')
		 ORDER BY updated_at ASC LIMIT ?`,
		[limit],
	);
	return rows.map(mapAccountOperationRow);
}

export async function getSignerBlockingAccountOperation(
	env: Bindings,
	signerAddress: string,
): Promise<AccountOperationRecord | null> {
	const row = await d1First<AccountOperationRow>(
		env,
		`SELECT ${ACCOUNT_OPERATION_COLUMNS} FROM account_operations
		 WHERE signer_address = ? AND chain_id = ? AND status IN ('prepared', 'needs_review')
		 ORDER BY updated_at ASC LIMIT 1`,
		[signerAddress.toLowerCase(), getNetworkConfig(env.CHAIN_KEY).chainId],
	);
	return row ? mapAccountOperationRow(row) : null;
}

export async function hasAccountOperationNeedsReview(env: Bindings): Promise<boolean> {
	const row = await d1First<{ present: number }>(
		env,
		`SELECT 1 AS present FROM account_operations WHERE status = 'needs_review' LIMIT 1`,
	);
	return row?.present === 1;
}

export async function markAccountOperationSubmitted(env: Bindings, id: string): Promise<void> {
	await d1Run(
		env,
		`UPDATE account_operations SET status = 'submitted', updated_at = ?
		 WHERE id = ? AND status = 'prepared'`,
		[nowIso(), id],
	);
}

export async function recordAccountOperationAttempt(
	env: Bindings,
	id: string,
	lastError: string | null,
): Promise<void> {
	await d1Run(
		env,
		`UPDATE account_operations
		 SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
		 WHERE id = ? AND status IN ('prepared', 'submitted')`,
		[lastError, nowIso(), id],
	);
}

export async function finishAccountOperation(
	env: Bindings,
	id: string,
	status: Extract<AccountOperationStatus, "confirmed" | "failed" | "needs_review">,
	fields: { errorCode?: string | null; lastError?: string | null } = {},
): Promise<boolean> {
	const now = nowIso();
	const result = await d1Run(
		env,
		`UPDATE account_operations
		 SET status = ?, error_code = ?, last_error = ?, updated_at = ?, confirmed_at = ?
		 WHERE id = ? AND status IN ('prepared', 'submitted')`,
		[
			status,
			fields.errorCode ?? null,
			fields.lastError ?? null,
			now,
			status === "confirmed" ? now : null,
			id,
		],
	);
	return didWrite(result);
}

export async function sweepAccountOperations(env: Bindings): Promise<void> {
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
	await d1Run(
		env,
		`DELETE FROM account_operations
		 WHERE status IN ('confirmed', 'failed') AND updated_at <= ?`,
		[cutoff],
	);
}
