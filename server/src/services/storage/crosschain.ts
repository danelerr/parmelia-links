import type { Bindings } from "../../middlewares/auth";
import { scheduleEventJob } from "../eventScheduler";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./core";

type CrosschainDirection = "inbound" | "outbound";
type CrosschainMode = "standard" | "fast";
export type CrosschainStatus =
	| "quoted"
	| "pending_signature"
	| "submitted"
	| "waiting_attestation"
	| "minting"
	| "completed"
	| "failed"
	| "expired"
	| "recoverable"
	| "needs_support";

export type CrosschainOpRecord = {
	opId: string;
	uid: string;
	direction: CrosschainDirection;
	provider: string;
	cctpMode: CrosschainMode;
	sourceChainId: number;
	destinationChainId: number;
	sourceDomain: number;
	destinationDomain: number;
	destinationCaller: string | null;
	sourceTxHash: string | null;
	destinationTxHash: string | null;
	messageNonce: string | null;
	messageBytes: string | null;
	attestation: string | null;
	token: string;
	amountIn: string;
	gatoPagoFee: string;
	maxFee: string | null;
	minFinalityThreshold: number | null;
	cctpFeeEstimated: string | null;
	amountOutExpected: string | null;
	recipient: string;
	status: CrosschainStatus;
	statusDetail: string | null;
	/** Mint attempts so far (relayer); poison ops park as needs_support at the cap. */
	attemptCount: number;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
};

type CrosschainOpRow = {
	op_id: string;
	uid: string;
	direction: CrosschainDirection;
	provider: string;
	cctp_mode: CrosschainMode;
	source_chain_id: number;
	destination_chain_id: number;
	source_domain: number;
	destination_domain: number;
	destination_caller: string | null;
	source_tx_hash: string | null;
	destination_tx_hash: string | null;
	message_nonce: string | null;
	message_bytes: string | null;
	attestation: string | null;
	token: string;
	amount_in: string;
	gatopago_fee: string;
	max_fee: string | null;
	min_finality_threshold: number | null;
	cctp_fee_estimated: string | null;
	amount_out_expected: string | null;
	recipient: string;
	status: CrosschainStatus;
	status_detail: string | null;
	attempt_count: number | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

// attempt_count/last_error land with migration 0006 — apply it before deploying.
const CROSSCHAIN_COLS =
	"op_id, uid, direction, provider, cctp_mode, source_chain_id, destination_chain_id, source_domain, destination_domain, destination_caller, source_tx_hash, destination_tx_hash, message_nonce, message_bytes, attestation, token, amount_in, gatopago_fee, max_fee, min_finality_threshold, cctp_fee_estimated, amount_out_expected, recipient, status, status_detail, attempt_count, last_error, created_at, updated_at, completed_at";

function mapCrosschainOp(row: CrosschainOpRow): CrosschainOpRecord {
	return {
		opId: row.op_id,
		uid: row.uid,
		direction: row.direction,
		provider: row.provider,
		cctpMode: row.cctp_mode,
		sourceChainId: row.source_chain_id,
		destinationChainId: row.destination_chain_id,
		sourceDomain: row.source_domain,
		destinationDomain: row.destination_domain,
		destinationCaller: row.destination_caller,
		sourceTxHash: row.source_tx_hash,
		destinationTxHash: row.destination_tx_hash,
		messageNonce: row.message_nonce,
		messageBytes: row.message_bytes,
		attestation: row.attestation,
		token: row.token,
		amountIn: row.amount_in,
		gatoPagoFee: row.gatopago_fee,
		maxFee: row.max_fee,
		minFinalityThreshold: row.min_finality_threshold,
		cctpFeeEstimated: row.cctp_fee_estimated,
		amountOutExpected: row.amount_out_expected,
		recipient: row.recipient,
		status: row.status,
		statusDetail: row.status_detail,
		attemptCount: row.attempt_count ?? 0,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
	};
}

export async function createCrosschainOp(
	env: Bindings,
	op: Omit<CrosschainOpRecord, "attemptCount" | "lastError"> &
		Partial<Pick<CrosschainOpRecord, "attemptCount" | "lastError">>,
) {
	if (
		["submitted", "waiting_attestation", "minting", "recoverable"].includes(
			op.status,
		)
	) {
		await scheduleEventJob(env, "crosschain_relayer", {
			delayMs: 5_000,
			reason: "crosschain_operation_created",
		});
	}
	await d1Run(
		env,
		`INSERT INTO crosschain_operations
			(op_id, uid, direction, provider, cctp_mode, source_chain_id, destination_chain_id,
			 source_domain, destination_domain, destination_caller, source_tx_hash, destination_tx_hash,
			 message_nonce, message_bytes, attestation, token, amount_in, gatopago_fee, max_fee,
			 min_finality_threshold, cctp_fee_estimated, amount_out_expected, recipient, status,
			 status_detail, attempt_count, last_error, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			op.opId, op.uid, op.direction, op.provider, op.cctpMode, op.sourceChainId, op.destinationChainId,
			op.sourceDomain, op.destinationDomain, op.destinationCaller, op.sourceTxHash, op.destinationTxHash,
			op.messageNonce, op.messageBytes, op.attestation, op.token, op.amountIn, op.gatoPagoFee, op.maxFee,
			op.minFinalityThreshold, op.cctpFeeEstimated, op.amountOutExpected, op.recipient, op.status,
			op.statusDetail, op.attemptCount ?? 0, op.lastError ?? null, op.createdAt, op.updatedAt, op.completedAt,
		],
	);
}

/** Lookup by burn tx hash — dedupe guard for inbound/register (one op per burn). */
export async function getCrosschainOpBySourceTx(
	env: Bindings,
	sourceTxHash: string,
): Promise<CrosschainOpRecord | null> {
	const row = await d1First<CrosschainOpRow>(
		env,
		`SELECT ${CROSSCHAIN_COLS} FROM crosschain_operations WHERE source_tx_hash = ? LIMIT 1`,
		[sourceTxHash],
	);
	return row ? mapCrosschainOp(row) : null;
}

export async function getCrosschainOpById(env: Bindings, opId: string): Promise<CrosschainOpRecord | null> {
	const row = await d1First<CrosschainOpRow>(
		env,
		`SELECT ${CROSSCHAIN_COLS} FROM crosschain_operations WHERE op_id = ?`,
		[opId],
	);
	return row ? mapCrosschainOp(row) : null;
}


/**
 * In-flight ops the relayer must advance (burned but not yet minted). Ordered by
 * updated_at ASC: every touch (even a failed attempt) sends the op to the back
 * of the queue, so a page of stuck ops can never starve newer ones the way
 * created_at ASC + LIMIT did.
 */
export async function listCrosschainOpsByStatus(
	env: Bindings,
	statuses: CrosschainStatus[],
	limit = 50,
): Promise<CrosschainOpRecord[]> {
	if (statuses.length === 0) return [];
	const placeholders = statuses.map(() => "?").join(", ");
	const rows = await d1All<CrosschainOpRow>(
		env,
		`SELECT ${CROSSCHAIN_COLS} FROM crosschain_operations WHERE status IN (${placeholders}) ORDER BY updated_at ASC LIMIT ?`,
		[...statuses, limit],
	);
	return rows.map(mapCrosschainOp);
}

// Columns the state machine may advance (camelCase -> column). Whitelisted to keep
// the dynamic UPDATE injection-safe.
const CROSSCHAIN_UPDATABLE: Record<string, string> = {
	status: "status",
	statusDetail: "status_detail",
	sourceTxHash: "source_tx_hash",
	destinationTxHash: "destination_tx_hash",
	messageNonce: "message_nonce",
	messageBytes: "message_bytes",
	attestation: "attestation",
	attemptCount: "attempt_count",
	lastError: "last_error",
	completedAt: "completed_at",
};

type CrosschainPatch = Partial<
	Pick<
		CrosschainOpRecord,
		| "status"
		| "statusDetail"
		| "sourceTxHash"
		| "destinationTxHash"
		| "messageNonce"
		| "messageBytes"
		| "attestation"
		| "attemptCount"
		| "lastError"
		| "completedAt"
	>
>;

/**
 * Partial update of an op's mutable fields; always bumps updated_at. Returns
 * whether a row was written. Two guards make the state machine safe under
 * overlapping relayer deliveries:
 *   - 'completed' is terminal: no patch can ever leave it (a late/duplicate
 *     relayer pass can't demote a finished op back to 'recoverable').
 *   - opts.ifStatusIn restricts the transition to specific current states
 *     (compare-and-set), e.g. register only advances 'pending_signature'.
 */
export async function updateCrosschainOp(
	env: Bindings,
	opId: string,
	patch: CrosschainPatch,
	opts?: { ifStatusIn?: CrosschainStatus[] },
): Promise<boolean> {
	const sets: string[] = [];
	const vals: unknown[] = [];
	for (const [key, col] of Object.entries(CROSSCHAIN_UPDATABLE)) {
		if (key in patch) {
			sets.push(`${col} = ?`);
			vals.push((patch as Record<string, unknown>)[key] ?? null);
		}
	}
	if (sets.length === 0) return false;
	if (
		patch.status !== undefined &&
		["submitted", "waiting_attestation", "minting", "recoverable"].includes(
			patch.status,
		)
	) {
		await scheduleEventJob(env, "crosschain_relayer", {
			// Circle recommends 5-second attestation polling. A fixed 30-second
			// delay here was paid once after burn and again after attestation,
			// adding about a minute to every nominally Fast transfer.
			delayMs: 5_000,
			reason: "crosschain_operation_advanced",
		});
	}
	sets.push("updated_at = ?");
	vals.push(nowIso());
	vals.push(opId);

	const conditions: string[] = ["op_id = ?"];
	if (patch.status !== undefined && patch.status !== "completed") {
		conditions.push("status != 'completed'");
	}
	if (opts?.ifStatusIn && opts.ifStatusIn.length > 0) {
		conditions.push(`status IN (${opts.ifStatusIn.map(() => "?").join(", ")})`);
		vals.push(...opts.ifStatusIn);
	}
	const result = await d1Run(
		env,
		`UPDATE crosschain_operations SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`,
		vals,
	);
	return didWrite(result);
}

/** Preserve every destination transaction hash; later retries never overwrite history. */
export async function recordCrosschainMintAttempt(
	env: Bindings,
	opId: string,
	txHash: string,
	status: "broadcast" | "pending" | "success" | "reverted" | "unknown",
): Promise<void> {
	const now = nowIso();
	await d1Run(
		env,
		`INSERT INTO crosschain_mint_attempts (id, op_id, tx_hash, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(tx_hash) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
		[`cma_${crypto.randomUUID().replace(/-/g, "")}`, opId, txHash.toLowerCase(), status, now, now],
	);
}

/** Atomically retain a newly broadcast hash and point the operation at it. */
export async function recordCrosschainMintBroadcast(
	env: Bindings,
	opId: string,
	txHash: string,
): Promise<void> {
	const now = nowIso();
	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`INSERT INTO crosschain_mint_attempts (id, op_id, tx_hash, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'broadcast', ?, ?)
			 ON CONFLICT(tx_hash) DO UPDATE SET status = 'broadcast', updated_at = excluded.updated_at`,
		).bind(`cma_${crypto.randomUUID().replace(/-/g, "")}`, opId, txHash.toLowerCase(), now, now),
		env.GATOPAGO_DB.prepare(
			`UPDATE crosschain_operations
			 SET destination_tx_hash = ?, updated_at = ?
			 WHERE op_id = ? AND status != 'completed'`,
		).bind(txHash, now, opId),
	]);
}

/**
 * Operability sweep performed by an active relayer job:
 *   - ops never signed/registered ('quoted' / 'pending_signature') expire after
 *     24h — they hold no funds, they're just abandoned checkouts;
 *   - in-flight ops stuck > 7 days park as 'needs_support' (manual runbook) so
 *     the relayer queue can't fill up with poison rows. The burn stays
 *     completable forever (receiveMessage is permissionless).
 */
export async function expireStaleCrosschainOps(env: Bindings): Promise<void> {
	const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
	const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
	const now = nowIso();
	await d1Run(
		env,
		`UPDATE crosschain_operations
		 SET status = 'expired', status_detail = 'never signed/registered within 24h', updated_at = ?
		 WHERE status IN ('quoted', 'pending_signature') AND created_at <= ?`,
		[now, dayAgo],
	);
	await d1Run(
		env,
		`UPDATE crosschain_operations
		 SET status = 'needs_support', status_detail = 'in-flight for over 7 days; manual completion required', updated_at = ?
		 WHERE status IN ('submitted', 'waiting_attestation', 'minting', 'recoverable') AND created_at <= ?`,
		[now, weekAgo],
	);
}

