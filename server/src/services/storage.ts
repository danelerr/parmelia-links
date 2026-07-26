import type { Bindings } from "../middlewares/auth";
import { logError } from "./logger";
import { scheduleEventJob } from "./eventScheduler";
import { scheduleWalletIndexerPartitions } from "./indexerPartitions";

export type UserRecord = {
	uid: string;
	walletAddress: string | null;
	username: string | null;
	referralCode: string | null;
	credentialId: string | null;
	fundedAt: string | null;
	invitedBy: string | null;
	displayName: string | null;
	socialUrl: string | null;
	createdAt: string | null;
	updatedAt: string | null;
};

export type PaymentLinkRecord = {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	wallet: string;
	ownerUid: string;
	status: "pending" | "paid";
	txHash: string | null;
	paidAt: string | null;
	paidBy: string | null;
	paymentClaim?: string | null;
	paymentClaimExpiresAt?: string | null;
	paymentClaimTxHash?: string | null;
	createdAt: string;
};

/**
 * Payment lifecycle (migration 0007). One-way transitions, each guarded by an
 * atomic compare-and-set so a Worker death or a duplicate request can never
 * fork the state:
 *   prepared -> submitting -> submitted -> confirmed | failed
 * The event-driven reconciler resolves rows stranded in submitting/submitted.
 */
export type PendingPaymentStatus = "prepared" | "submitting" | "submitted" | "confirmed" | "failed";
export type PendingPaymentSubmissionTransport = "self" | "bundler";

export type PendingPaymentRecord = {
	userOpHash: string;
	uid: string;
	linkId: string | null;
	wallet: string;
	senderAddress: string;
	amount: string;
	currency: string;
	userOp: Record<string, unknown>;
	/** Free-form context for submit (e.g. swap quote details). */
	meta: Record<string, unknown> | null;
	status: PendingPaymentStatus;
	submittedTxHash: string | null;
	submissionTransport: PendingPaymentSubmissionTransport;
	submittedAt: string | null;
	submissionAttemptCount: number;
	lastSubmissionErrorCode: string | null;
	createdAt: string;
	expiresAt: string;
};

export type PasskeyRecord = {
	credentialId: string;
	uid: string;
	qx: string;
	qy: string;
	createdAt: string;
	lastUsedAt: string;
};

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

export type PaymentReconcileRequest = {
	userOpHash: string;
	attemptCount: number;
};

type UserRow = {
	uid: string;
	wallet_address: string | null;
	username: string | null;
	referral_code: string | null;
	credential_id: string | null;
	funded_at: string | null;
	invited_by: string | null;
	display_name: string | null;
	social_url: string | null;
	created_at: string | null;
	updated_at: string | null;
};

const USER_COLUMNS =
	"uid, wallet_address, username, referral_code, credential_id, funded_at, invited_by, display_name, social_url, created_at, updated_at";

type PaymentLinkRow = {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	wallet_address: string;
	owner_uid: string;
	status: "pending" | "paid";
	tx_hash: string | null;
	paid_at: string | null;
	paid_by: string | null;
	payment_claim: string | null;
	payment_claim_expires_at: string | null;
	payment_claim_tx_hash: string | null;
	created_at: string;
};

const PAYMENT_LINK_COLUMNS =
	"id, owner_uid, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, payment_claim, payment_claim_expires_at, payment_claim_tx_hash, created_at";

type PendingPaymentRow = {
	user_op_hash: string;
	uid: string;
	link_id: string | null;
	wallet_address: string;
	sender_address: string;
	amount: string;
	currency: string;
	user_op_json: string;
	meta: string | null;
	status: PendingPaymentStatus;
	submitted_tx_hash: string | null;
	submission_transport: PendingPaymentSubmissionTransport;
	submitted_at: string | null;
	submission_attempt_count: number;
	last_submission_error_code: string | null;
	created_at: string;
	expires_at: string;
};

const PENDING_COLS =
	"user_op_hash, uid, link_id, wallet_address, sender_address, amount, currency, user_op_json, meta, status, submitted_tx_hash, submission_transport, submitted_at, submission_attempt_count, last_submission_error_code, created_at, expires_at";

type PasskeyRow = {
	credential_id: string;
	uid: string;
	qx: string;
	qy: string;
	created_at: string;
	last_used_at: string;
};

type AccountOperationRow = {
	id: string;
	uid: string;
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
	"id, uid, kind, status, tx_hash, raw_transaction, signer_address, nonce, metadata, attempt_count, last_error, error_code, created_at, updated_at, confirmed_at, expires_at";

function nowIso() {
	return new Date().toISOString();
}

async function d1First<Row>(env: Bindings, query: string, params: unknown[] = []): Promise<Row | null> {
	return (await env.PARMELIA_DB.prepare(query).bind(...params).first<Row>()) ?? null;
}

async function d1All<Row>(env: Bindings, query: string, params: unknown[] = []): Promise<Row[]> {
	const result = await env.PARMELIA_DB.prepare(query).bind(...params).all<Row>();
	return (result.results ?? []) as Row[];
}

async function d1Run(env: Bindings, query: string, params: unknown[] = []) {
	return await env.PARMELIA_DB.prepare(query).bind(...params).run();
}

/** True when the statement actually wrote a row (atomic claim / guarded update). */
function didWrite(result: { meta?: { changes?: number } }): boolean {
	return (result.meta?.changes ?? 0) > 0;
}

function mapUserRow(row: UserRow): UserRecord {
	return {
		uid: row.uid,
		walletAddress: row.wallet_address,
		username: row.username,
		referralCode: row.referral_code,
		credentialId: row.credential_id,
		fundedAt: row.funded_at,
		invitedBy: row.invited_by,
		displayName: row.display_name,
		socialUrl: row.social_url,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapPaymentLinkRow(row: PaymentLinkRow): PaymentLinkRecord {
	return {
		id: row.id,
		amount: row.amount,
		currency: row.currency,
		reference: row.reference,
		wallet: row.wallet_address,
		ownerUid: row.owner_uid,
		status: row.status,
		txHash: row.tx_hash,
		paidAt: row.paid_at,
		paidBy: row.paid_by,
		paymentClaim: row.payment_claim,
		paymentClaimExpiresAt: row.payment_claim_expires_at,
		paymentClaimTxHash: row.payment_claim_tx_hash,
		createdAt: row.created_at,
	};
}

function mapPendingRow(row: PendingPaymentRow): PendingPaymentRecord {
	return {
		userOpHash: row.user_op_hash,
		uid: row.uid,
		linkId: row.link_id,
		wallet: row.wallet_address,
		senderAddress: row.sender_address,
		amount: row.amount,
		currency: row.currency,
		userOp: JSON.parse(row.user_op_json) as Record<string, unknown>,
		meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
		status: row.status ?? "prepared",
		submittedTxHash: row.submitted_tx_hash ?? null,
		submissionTransport: row.submission_transport ?? "self",
		submittedAt: row.submitted_at ?? null,
		submissionAttemptCount: row.submission_attempt_count ?? 0,
		lastSubmissionErrorCode: row.last_submission_error_code ?? null,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

function mapAccountOperationRow(row: AccountOperationRow): AccountOperationRecord {
	return {
		id: row.id,
		uid: row.uid,
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

export async function saveUser(
	env: Bindings,
	user: {
		uid: string;
		walletAddress?: string | null;
		username?: string | null;
		credentialId?: string | null;
		fundedAt?: string | null;
		createdAt?: string | null;
		updatedAt?: string | null;
	},
) {
	const timestamp = user.updatedAt ?? nowIso();
	// Addresses are stored lowercase so the ledger / indexer can do exact
	// reverse lookups (address → user) without case games.
	const walletAddress = user.walletAddress?.toLowerCase() ?? null;
	if (walletAddress) {
		// Schedule before the upsert: a crash can create one harmless empty run,
		// but can never persist a new wallet without a durable indexing wakeup.
		await scheduleEventJob(env, "indexer_wallet_registry", {
			delayMs: 2_000,
			reason: "wallet_registered_backfill",
		});
	}

	// Single atomic upsert: omitted fields keep their stored value (COALESCE), so
	// concurrent partial saves can't clobber each other (no read-modify-write).
	// Consequence: this function can SET fields but never NULL them out — use a
	// dedicated statement for that (e.g. releaseFaucetClaim).
	await d1Run(
		env,
		`INSERT INTO users (
			uid,
			wallet_address,
			username,
			credential_id,
			funded_at,
			created_at,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(uid) DO UPDATE SET
			wallet_address = COALESCE(excluded.wallet_address, users.wallet_address),
			username = COALESCE(excluded.username, users.username),
			credential_id = COALESCE(excluded.credential_id, users.credential_id),
			funded_at = COALESCE(excluded.funded_at, users.funded_at),
			updated_at = excluded.updated_at`,
		[
			user.uid,
			walletAddress,
			user.username ?? null,
			user.credentialId ?? null,
			user.fundedAt ?? null,
			user.createdAt ?? timestamp,
			timestamp,
		],
	);
}

/**
 * Set the public profile fields. Explicit UPDATE (not saveUser's COALESCE
 * upsert) so empty values CAN clear a field.
 */
export async function updateProfileFields(
	env: Bindings,
	uid: string,
	fields: { displayName: string | null; socialUrl: string | null },
): Promise<void> {
	await d1Run(
		env,
		`UPDATE users SET display_name = ?, social_url = ?, updated_at = ? WHERE uid = ?`,
		[fields.displayName, fields.socialUrl, nowIso(), uid],
	);
}

/**
 * Atomically claim the one-time welcome faucet for a user. Returns true only for
 * the single caller that flipped funded_at from NULL — concurrent claims lose.
 * Claim BEFORE transferring; on transfer failure, releaseFaucetClaim() re-opens it.
 */
export async function claimFaucet(env: Bindings, uid: string): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE users SET funded_at = ?, updated_at = ? WHERE uid = ? AND funded_at IS NULL`,
		[nowIso(), nowIso(), uid],
	);
	return didWrite(result);
}

/** Re-open the faucet claim after a failed transfer (compensation for claimFaucet). */
export async function releaseFaucetClaim(env: Bindings, uid: string): Promise<void> {
	await d1Run(env, `UPDATE users SET funded_at = NULL, updated_at = ? WHERE uid = ?`, [nowIso(), uid]);
}

export async function getUserByUid(env: Bindings, uid: string): Promise<UserRecord | null> {
	const row = await d1First<UserRow>(
		env,
		`SELECT ${USER_COLUMNS} FROM users WHERE uid = ? LIMIT 1`,
		[uid],
	);
	return row ? mapUserRow(row) : null;
}

export async function getUserByUsername(env: Bindings, username: string): Promise<UserRecord | null> {
	const row = await d1First<UserRow>(
		env,
		`SELECT ${USER_COLUMNS} FROM users WHERE username = ? LIMIT 1`,
		[username],
	);
	return row ? mapUserRow(row) : null;
}

/** Reverse lookup: which Parmelia user owns this (lowercase) address? */
export async function getUserByWallet(env: Bindings, walletAddress: string): Promise<UserRecord | null> {
	const row = await d1First<UserRow>(
		env,
		`SELECT ${USER_COLUMNS} FROM users WHERE wallet_address = ? LIMIT 1`,
		[walletAddress.toLowerCase()],
	);
	return row ? mapUserRow(row) : null;
}

export async function listUsersByWalletAddresses(
	env: Bindings,
	walletAddresses: string[],
): Promise<Array<{ uid: string; walletAddress: string }>> {
	const normalized = [
		...new Set(
			walletAddresses
				.map((address) => address.toLowerCase())
				.filter((address) => /^0x[0-9a-f]{40}$/.test(address)),
		),
	];
	if (normalized.length === 0) return [];
	const users: Array<{ uid: string; walletAddress: string }> = [];
	for (let offset = 0; offset < normalized.length; offset += 100) {
		const chunk = normalized.slice(offset, offset + 100);
		const placeholders = chunk.map(() => "?").join(", ");
		const rows = await d1All<{ uid: string; wallet_address: string }>(
			env,
			`SELECT uid, wallet_address FROM users
			 WHERE wallet_address IN (${placeholders})`,
			chunk,
		);
		users.push(
			...rows.map((row) => ({
				uid: row.uid,
				walletAddress: row.wallet_address,
			})),
		);
	}
	return users;
}

export async function getUserByReferralCode(env: Bindings, code: string): Promise<UserRecord | null> {
	const row = await d1First<UserRow>(
		env,
		`SELECT ${USER_COLUMNS} FROM users WHERE referral_code = ? LIMIT 1`,
		[code.toUpperCase()],
	);
	return row ? mapUserRow(row) : null;
}

// Unambiguous alphabet (no 0/O/1/I) for invite codes.
const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Return the user's invite code, generating one on first use. */
export async function ensureReferralCode(env: Bindings, uid: string): Promise<string | null> {
	const user = await getUserByUid(env, uid);
	if (!user) return null;
	if (user.referralCode) return user.referralCode;

	for (let attempt = 0; attempt < 5; attempt++) {
		const bytes = crypto.getRandomValues(new Uint8Array(6));
		const code = Array.from(bytes, (b) => REFERRAL_ALPHABET[b % REFERRAL_ALPHABET.length]).join("");
		try {
			await d1Run(
				env,
				`UPDATE users SET referral_code = ? WHERE uid = ? AND referral_code IS NULL`,
				[code, uid],
			);
			const fresh = await getUserByUid(env, uid);
			if (fresh?.referralCode) return fresh.referralCode;
		} catch {
			// UNIQUE collision - retry with a new code.
		}
	}
	return null;
}

export async function createPaymentLink(env: Bindings, link: PaymentLinkRecord) {
	await d1Run(
		env,
		`INSERT INTO payment_links (
			id,
			owner_uid,
			wallet_address,
			amount,
			currency,
			reference,
			status,
			tx_hash,
			paid_at,
			paid_by,
			created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			link.id,
			link.ownerUid,
			link.wallet,
			link.amount,
			link.currency,
			link.reference,
			link.status,
			link.txHash,
			link.paidAt,
			link.paidBy,
			link.createdAt,
		],
	);
}

export async function getPaymentLinkById(env: Bindings, id: string): Promise<PaymentLinkRecord | null> {
	const row = await d1First<PaymentLinkRow>(
		env,
		`SELECT ${PAYMENT_LINK_COLUMNS}
		 FROM payment_links
		 WHERE id = ?
		 LIMIT 1`,
		[id],
	);
	return row ? mapPaymentLinkRow(row) : null;
}

export async function listPaymentLinksByOwner(env: Bindings, ownerUid: string, limit = 20): Promise<PaymentLinkRecord[]> {
	const rows = await d1All<PaymentLinkRow>(
		env,
		`SELECT ${PAYMENT_LINK_COLUMNS}
		 FROM payment_links
		 WHERE owner_uid = ?
		 ORDER BY datetime(created_at) DESC
		 LIMIT ?`,
		[ownerUid, limit],
	);
	return rows.map(mapPaymentLinkRow);
}

/**
 * Flip a link to paid — only from 'pending' (atomic guard). Returns false when
 * the link was already paid, so a second concurrent payment can never overwrite
 * the first payer's tx_hash/paid_by/amount.
 */
export async function markPaymentLinkPaid(
	env: Bindings,
	params: { id: string; amount: string; txHash: string; paidAt: string; paidBy: string; claimOwner?: string | null },
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_links
		 SET status = 'paid', amount = ?, tx_hash = ?, paid_at = ?, paid_by = ?,
			 payment_claim = NULL, payment_claim_expires_at = NULL, payment_claim_tx_hash = NULL
		 WHERE id = ? AND status = 'pending'
			 AND (payment_claim IS NULL OR payment_claim = ?)`,
		[params.amount, params.txHash, params.paidAt, params.paidBy, params.id, params.claimOwner ?? null],
	);
	return didWrite(result);
}

/** Reserve a pending link for one UserOperation before any funds are broadcast. */
export async function claimPaymentLinkForSubmit(
	env: Bindings,
	id: string,
	claimOwner: string,
	expiresAt: string,
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_links
		 SET payment_claim = ?, payment_claim_expires_at = ?, payment_claim_tx_hash = NULL
		 WHERE id = ? AND status = 'pending' AND (
			payment_claim IS NULL OR payment_claim = ? OR (
				payment_claim_tx_hash IS NULL AND payment_claim_expires_at <= ?
			)
		) AND NOT EXISTS (
			SELECT 1 FROM payment_intents
			WHERE payment_intents.link_id = payment_links.id
				AND (
					payment_intents.status != 'awaiting_payment' OR
					(payment_intents.expires_at IS NOT NULL AND payment_intents.expires_at <= ?)
				)
		)`,
		[claimOwner, expiresAt, id, claimOwner, nowIso(), nowIso()],
	);
	return didWrite(result);
}

/** Make a link claim non-expiring once its on-chain transaction exists. */
export async function markPaymentLinkClaimBroadcast(
	env: Bindings,
	id: string,
	claimOwner: string,
	txHash: string,
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_links
		 SET payment_claim_tx_hash = ?, payment_claim_expires_at = NULL
		 WHERE id = ? AND status = 'pending' AND payment_claim = ?`,
		[txHash, id, claimOwner],
	);
	return didWrite(result);
}

/** Release only this operation's claim; broadcast claims require known failure. */
export async function releasePaymentLinkClaim(
	env: Bindings,
	id: string,
	claimOwner: string,
	allowBroadcast = false,
): Promise<void> {
	await d1Run(
		env,
		`UPDATE payment_links
		 SET payment_claim = NULL, payment_claim_expires_at = NULL, payment_claim_tx_hash = NULL
		 WHERE id = ? AND status = 'pending' AND payment_claim = ?
			 AND (? = 1 OR payment_claim_tx_hash IS NULL)`,
		[id, claimOwner, allowBroadcast ? 1 : 0],
	);
}

export async function createPendingPayment(
	env: Bindings,
	pending: Omit<
		PendingPaymentRecord,
		| "createdAt"
		| "expiresAt"
		| "meta"
		| "status"
		| "submittedTxHash"
		| "submissionTransport"
		| "submittedAt"
		| "submissionAttemptCount"
		| "lastSubmissionErrorCode"
	> & {
		meta?: Record<string, unknown> | null;
		submissionTransport?: PendingPaymentSubmissionTransport;
		createdAt?: string;
		expiresAt?: string;
	},
) {
	const createdAt = pending.createdAt ?? nowIso();
	const expiresAt = pending.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString();

	// Opportunistic cleanup of expired rows that never got signed. In-flight and
	// terminal rows are NOT touched here: the reconciler owns their lifecycle
	// (an expired 'submitted' row may still be a real broadcast tx to settle).
	await d1Run(env, `DELETE FROM pending_payments WHERE expires_at <= ? AND status = 'prepared'`, [nowIso()]);
	await d1Run(
		env,
		`INSERT INTO pending_payments (
			user_op_hash,
			uid,
			link_id,
			wallet_address,
			sender_address,
			amount,
			currency,
			user_op_json,
			meta,
			status,
			submitted_tx_hash,
			submission_transport,
			submitted_at,
			submission_attempt_count,
			last_submission_error_code,
			created_at,
			expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, NULL, 0, NULL, ?, ?)
		ON CONFLICT(user_op_hash) DO UPDATE SET
			uid = excluded.uid,
			link_id = excluded.link_id,
			wallet_address = excluded.wallet_address,
			sender_address = excluded.sender_address,
			amount = excluded.amount,
			currency = excluded.currency,
			user_op_json = excluded.user_op_json,
			meta = excluded.meta,
			status = 'prepared',
			submitted_tx_hash = NULL,
			submission_transport = excluded.submission_transport,
			submitted_at = NULL,
			submission_attempt_count = 0,
			last_submission_error_code = NULL,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at`,
		[
			pending.userOpHash,
			pending.uid,
			pending.linkId,
			pending.wallet,
			pending.senderAddress,
			pending.amount,
			pending.currency,
			JSON.stringify(pending.userOp),
			pending.meta ? JSON.stringify(pending.meta) : null,
			pending.submissionTransport ?? "self",
			createdAt,
			expiresAt,
		],
	);
}

/** The signable row for /pay/submit: only fresh 'prepared' rows qualify. */
export async function getPendingPayment(env: Bindings, userOpHash: string): Promise<PendingPaymentRecord | null> {
	const row = await d1First<PendingPaymentRow>(
		env,
		`SELECT ${PENDING_COLS} FROM pending_payments WHERE user_op_hash = ? LIMIT 1`,
		[userOpHash],
	);
	if (!row) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		// Only garbage-collect never-signed rows; the reconciler owns the rest.
		if (row.status === "prepared") await deletePendingPayment(env, userOpHash);
		return null;
	}
	return mapPendingRow(row);
}

/** Raw fetch, any state — for GET /pay/status and the reconciler. */
export async function getPendingPaymentAnyState(
	env: Bindings,
	userOpHash: string,
): Promise<PendingPaymentRecord | null> {
	const row = await d1First<PendingPaymentRow>(
		env,
		`SELECT ${PENDING_COLS} FROM pending_payments WHERE user_op_hash = ? LIMIT 1`,
		[userOpHash],
	);
	return row ? mapPendingRow(row) : null;
}

/**
 * Atomically claim a prepared payment for submission. Exactly one of N
 * concurrent submits of the same userOpHash wins; the rest see false and
 * return 409 instead of double-broadcasting (the EntryPoint nonce would kill
 * the duplicate anyway, but this stops it before burning relayer gas).
 */
export async function claimPendingForSubmit(env: Bindings, userOpHash: string): Promise<boolean> {
	const now = nowIso();
	const pendingSender = await d1First<{ sender_address: string }>(
		env,
		`SELECT sender_address
		 FROM pending_payments
		 WHERE user_op_hash = ? AND status = 'prepared'
		 LIMIT 1`,
		[userOpHash],
	);
	// Wake both the canonical UserOperation stream and its D1 reconciler before
	// taking the submitting claim. If the claim loses, both jobs are harmless.
	await Promise.all([
		pendingSender
			? scheduleWalletIndexerPartitions(
					env,
					[pendingSender.sender_address],
					"payment_submission_claimed",
				)
			: Promise.resolve(0),
		scheduleEventJob(env, "payment_reconciler", {
			delayMs: 10_000,
			reason: "payment_submission_claimed",
		}),
	]);
	const results = await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`UPDATE pending_payments
			 SET status = 'submitting',
			     submission_attempt_count = submission_attempt_count + 1,
			     last_submission_error_code = NULL
			 WHERE user_op_hash = ? AND status = 'prepared'`,
		).bind(userOpHash),
		// D1 batch is transactional: a Worker cannot die after taking the claim
		// while leaving no durable work capable of discovering an ambiguous
		// broadcast. The existing submitted trigger can later raise priority.
		env.PARMELIA_DB.prepare(
			`INSERT INTO payment_reconcile_requests (
				user_op_hash, status, priority, attempt_count, next_attempt_at,
				lease_owner, lease_expires_at, last_error_code, created_at,
				updated_at, completed_at
			)
			SELECT user_op_hash, 'pending', 2, 0, ?, NULL, NULL, NULL, ?, ?, NULL
			FROM pending_payments
			WHERE user_op_hash = ? AND status = 'submitting'
			ON CONFLICT(user_op_hash) DO UPDATE SET
				priority = MIN(payment_reconcile_requests.priority, excluded.priority),
				next_attempt_at = excluded.next_attempt_at,
				updated_at = excluded.updated_at,
				last_error_code = NULL,
				status = CASE
					WHEN payment_reconcile_requests.status = 'processing'
					  AND payment_reconcile_requests.lease_expires_at >
					      excluded.updated_at
					THEN 'processing'
					ELSE 'pending'
				END,
				lease_owner = CASE
					WHEN payment_reconcile_requests.status = 'processing'
					  AND payment_reconcile_requests.lease_expires_at >
					      excluded.updated_at
					THEN payment_reconcile_requests.lease_owner
					ELSE NULL
				END,
				lease_expires_at = CASE
					WHEN payment_reconcile_requests.status = 'processing'
					  AND payment_reconcile_requests.lease_expires_at >
					      excluded.updated_at
					THEN payment_reconcile_requests.lease_expires_at
					ELSE NULL
				END,
				completed_at = CASE
					WHEN payment_reconcile_requests.status = 'processing'
					  AND payment_reconcile_requests.lease_expires_at >
					      excluded.updated_at
					THEN payment_reconcile_requests.completed_at
					ELSE NULL
				END`,
		).bind(now, now, now, userOpHash),
	]);
	return didWrite(results[0]);
}

/** Release a claim when submit fails BEFORE broadcasting (so the user can retry). */
export async function releasePendingClaim(
	env: Bindings,
	userOpHash: string,
	errorCode?: string | null,
): Promise<void> {
	await d1Run(
		env,
		`UPDATE pending_payments
		 SET status = 'prepared', last_submission_error_code = ?
		 WHERE user_op_hash = ? AND status = 'submitting'`,
		[errorCode ?? null, userOpHash],
	);
}

/** Advance the payment state machine (optionally recording the broadcast tx). */
export async function setPendingPaymentStatus(
	env: Bindings,
	userOpHash: string,
	status: PendingPaymentStatus,
	submittedTxHash?: string | null,
): Promise<void> {
	if (submittedTxHash !== undefined) {
		await d1Run(
			env,
			`UPDATE pending_payments SET status = ?, submitted_tx_hash = ? WHERE user_op_hash = ?`,
			[status, submittedTxHash, userOpHash],
		);
	} else {
		await d1Run(env, `UPDATE pending_payments SET status = ? WHERE user_op_hash = ?`, [status, userOpHash]);
	}
}

/** In-flight rows the reconciler must resolve (oldest first). */
export async function listPendingPaymentsByStatus(
	env: Bindings,
	statuses: PendingPaymentStatus[],
	limit = 25,
): Promise<PendingPaymentRecord[]> {
	if (statuses.length === 0) return [];
	const placeholders = statuses.map(() => "?").join(", ");
	const rows = await d1All<PendingPaymentRow>(
		env,
		`SELECT ${PENDING_COLS} FROM pending_payments WHERE status IN (${placeholders}) ORDER BY created_at ASC LIMIT ?`,
		[...statuses, limit],
	);
	return rows.map(mapPendingRow);
}

/**
 * Durable payment-reconciliation work. A request can be reclaimed only after
 * its owner lease expires, so overlapping Queue deliveries remain safe.
 */
export async function listDuePaymentReconcileRequests(
	env: Bindings,
	limit = 25,
): Promise<PaymentReconcileRequest[]> {
	const now = nowIso();
	const rows = await d1All<{
		user_op_hash: string;
		attempt_count: number;
	}>(
		env,
		`SELECT user_op_hash, attempt_count
		 FROM payment_reconcile_requests
		 WHERE (
			status IN ('pending', 'failed') AND next_attempt_at <= ?
		 ) OR (
			status = 'processing' AND lease_expires_at <= ?
		 )
		 ORDER BY priority ASC, next_attempt_at ASC, created_at ASC
		 LIMIT ?`,
		[now, now, Math.min(100, Math.max(1, Math.trunc(limit)))],
	);
	return rows.map((row) => ({
		userOpHash: row.user_op_hash,
		attemptCount: row.attempt_count,
	}));
}

export async function claimPaymentReconcileRequest(
	env: Bindings,
	userOpHash: string,
	leaseMs = 60_000,
): Promise<string | null> {
	const owner = crypto.randomUUID();
	const now = nowIso();
	const leaseExpiresAt = new Date(
		Date.now() + Math.min(5 * 60_000, Math.max(10_000, leaseMs)),
	).toISOString();
	const result = await d1Run(
		env,
		`UPDATE payment_reconcile_requests
		 SET status = 'processing', attempt_count = attempt_count + 1,
		     lease_owner = ?, lease_expires_at = ?, updated_at = ?,
		     last_error_code = NULL
		 WHERE user_op_hash = ? AND (
			(status IN ('pending', 'failed') AND next_attempt_at <= ?)
			OR (status = 'processing' AND lease_expires_at <= ?)
		 )`,
		[owner, leaseExpiresAt, now, userOpHash, now, now],
	);
	return didWrite(result) ? owner : null;
}

export async function reschedulePaymentReconcileRequest(
	env: Bindings,
	userOpHash: string,
	owner: string,
	delayMs: number,
	errorCode?: string | null,
	terminal = false,
): Promise<void> {
	const now = nowIso();
	const nextAttemptAt = new Date(
		Date.now() + Math.min(30 * 60_000, Math.max(1_000, delayMs)),
	).toISOString();
	await d1Run(
		env,
		`UPDATE payment_reconcile_requests
		 SET status = ?, next_attempt_at = ?, lease_owner = NULL,
		     lease_expires_at = NULL, last_error_code = ?, updated_at = ?
		 WHERE user_op_hash = ? AND status = 'processing' AND lease_owner = ?`,
		[
			terminal ? "dead" : errorCode ? "failed" : "pending",
			nextAttemptAt,
			errorCode ?? null,
			now,
			userOpHash,
			owner,
		],
	);
}

export async function completePaymentReconcileRequest(
	env: Bindings,
	userOpHash: string,
	owner: string,
): Promise<void> {
	const now = nowIso();
	await d1Run(
		env,
		`UPDATE payment_reconcile_requests
		 SET status = 'completed', completed_at = ?, updated_at = ?,
		     lease_owner = NULL, lease_expires_at = NULL,
		     last_error_code = NULL
		 WHERE user_op_hash = ? AND status = 'processing' AND lease_owner = ?`,
		[now, now, userOpHash, owner],
	);
}

/** Sweep terminal rows once GET /pay/status no longer needs them (~1h). */
export async function sweepTerminalPendingPayments(env: Bindings): Promise<void> {
	const cutoff = new Date(Date.now() - 50 * 60_000).toISOString(); // expires_at = created+10m → ~1h old
	await d1Run(
		env,
		`DELETE FROM pending_payments WHERE status IN ('confirmed', 'failed') AND expires_at <= ?`,
		[cutoff],
	);
}

export async function deletePendingPayment(env: Bindings, userOpHash: string) {
	await d1Run(env, `DELETE FROM pending_payments WHERE user_op_hash = ?`, [userOpHash]);
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
			id, uid, kind, status, tx_hash, raw_transaction, signer_address, nonce,
			metadata, attempt_count, last_error, error_code, created_at, updated_at,
			confirmed_at, expires_at
		) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, NULL, ?)`,
		[
			operation.id,
			operation.uid,
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
): Promise<AccountOperationRecord | null> {
	const row = await d1First<AccountOperationRow>(
		env,
		`SELECT ${ACCOUNT_OPERATION_COLUMNS} FROM account_operations
		 WHERE uid = ? AND kind = ? AND status IN ('prepared', 'submitted', 'needs_review')
		 ORDER BY created_at DESC LIMIT 1`,
		[uid, kind],
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
		 WHERE signer_address = ? AND status IN ('prepared', 'needs_review')
		 ORDER BY updated_at ASC LIMIT 1`,
		[signerAddress.toLowerCase()],
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

// ===== In-Worker rate limiting (fixed window, D1-backed) =====

/**
 * Consume one unit of `scope`'s budget for `subject`. Returns true while the
 * subject stays within `limit` hits per `windowSeconds`. Single atomic upsert
 * (no read-modify-write): concurrent requests each get a distinct count.
 * Callers protecting monetary or privileged actions pass failClosed; ordinary
 * abuse throttles keep the availability-oriented fail-open default.
 */
export async function rateLimitConsume(
	env: Bindings,
	scope: string,
	subject: string,
	limit: number,
	windowSeconds: number,
	options: { failClosed?: boolean } = {},
): Promise<boolean> {
	try {
		const windowStart = String(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds);
		const row = await d1First<{ count: number }>(
			env,
			`INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
			 ON CONFLICT(key) DO UPDATE SET
				count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
				window_start = excluded.window_start
			 RETURNING count`,
			[`${scope}:${subject}`, windowStart],
		);
		return (row?.count ?? 1) <= limit;
	} catch (error) {
		logError("rate_limit_unavailable", error, {
			scope,
			failClosed: options.failClosed === true,
		});
		return !options.failClosed;
	}
}

/** Persist a successful hand-off to either self-handleOps or a standard bundler. */
export async function setPendingPaymentSubmitted(
	env: Bindings,
	userOpHash: string,
	transport: PendingPaymentSubmissionTransport,
	submittedTxHash: string | null,
): Promise<void> {
	const now = nowIso();
	await d1Run(
		env,
		`UPDATE pending_payments
		 SET status = 'submitted',
		     submitted_tx_hash = ?,
		     submission_transport = ?,
		     submitted_at = ?,
		     last_submission_error_code = NULL
		 WHERE user_op_hash = ? AND status IN ('submitting', 'submitted')`,
		[submittedTxHash, transport, now, userOpHash],
	);
}

/** Compensate a claimed monetary budget when the corresponding transfer fails. */
export async function refundRateLimitConsume(
	env: Bindings,
	scope: string,
	subject: string,
	windowSeconds: number,
): Promise<void> {
	const windowStart = String(Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds);
	await d1Run(
		env,
		`UPDATE rate_limits SET count = MAX(count - 1, 0)
		 WHERE key = ? AND window_start = ?`,
		[`${scope}:${subject}`, windowStart],
	);
}

/** Drop rate-limit counters whose window is long gone. */
export async function sweepRateLimits(env: Bindings): Promise<void> {
	const cutoff = String(Math.floor(Date.now() / 1000) - 24 * 3600);
	await d1Run(env, `DELETE FROM rate_limits WHERE window_start < ?`, [cutoff]);
}

// ===== Ledger (unified movements) =====

export type LedgerKind = "payment" | "link" | "swap" | "fund" | "external" | "earn";

export type LedgerEntry = {
	/** Present on read models; writers leave it unset and D1 generates the id. */
	id?: string;
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	txHash: string;
	/** Only for indexer-ingested on-chain entries (dedup key). */
	logIndex?: number | null;
	token: string;
	amount: string;
	amountSource?: "executed" | "estimated";
	amountRaw?: string | null;
	decimals?: number | null;
	chainId?: number | null;
	blockNumber?: bigint | null;
	blockHash?: string | null;
	transactionIndex?: number | null;
	consistencyLevel?: string | null;
	projectionVersion?: number | null;
	counterparty?: string | null;
	counterpartyUid?: string | null;
	reference?: string | null;
	linkId?: string | null;
	createdAt: string;
};

export type LedgerUserEvent = {
	dedupeKey: string;
	uid: string;
	eventType: string;
	payload: Record<string, unknown>;
	priority?: 0 | 1 | 2 | 3 | 4;
};

type LedgerRow = {
	id: string;
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	tx_hash: string;
	log_index: number | null;
	token: string;
	amount: string;
	amount_source: "executed" | "estimated";
	amount_raw: string | null;
	decimals: number | null;
	chain_id: number | null;
	block_number: number | string | null;
	block_hash: string | null;
	transaction_index: number | null;
	consistency_level: string | null;
	projection_version: number | null;
	counterparty: string | null;
	counterparty_uid: string | null;
	reference: string | null;
	link_id: string | null;
	created_at: string;
};

/**
 * Idempotent append (the dedup unique index absorbs re-submissions/re-scans).
 * Runs as ONE atomic D1 batch so double-entry pairs (payer out / recipient in)
 * can never be half-written. Returns one boolean per entry: true if the row was
 * actually inserted, false if the dedup index absorbed it (lets callers notify
 * only on genuinely new movements).
 */
export async function writeLedgerEntries(
	env: Bindings,
	entries: LedgerEntry[],
	options: { userEvents?: LedgerUserEvent[] } = {},
): Promise<boolean[]> {
	if (entries.length === 0) return [];
	const stmt = env.PARMELIA_DB.prepare(
		`INSERT OR IGNORE INTO ledger (
			id, uid, direction, kind, tx_hash, log_index, token, amount, amount_source,
			amount_raw, decimals, chain_id, block_number, block_hash, transaction_index,
			consistency_level, projection_version, counterparty, counterparty_uid,
			reference, link_id, created_at, canonical
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT DO UPDATE SET
			amount = excluded.amount,
			amount_source = excluded.amount_source,
			amount_raw = excluded.amount_raw,
			decimals = excluded.decimals,
			chain_id = excluded.chain_id,
			block_number = excluded.block_number,
			block_hash = excluded.block_hash,
			transaction_index = excluded.transaction_index,
			consistency_level = excluded.consistency_level,
			projection_version = excluded.projection_version,
			counterparty = excluded.counterparty,
			counterparty_uid = excluded.counterparty_uid,
			reference = excluded.reference,
			link_id = excluded.link_id,
			created_at = excluded.created_at,
			canonical = 1
		WHERE ledger.canonical = 0 AND excluded.block_hash IS NOT NULL`,
	);
	const entryStatements = entries.map((entry) =>
		stmt.bind(
			crypto.randomUUID(),
			entry.uid,
			entry.direction,
			entry.kind,
			entry.txHash,
			entry.logIndex ?? null,
			entry.token,
			entry.amount,
			entry.amountSource ?? "executed",
			entry.amountRaw ?? null,
			entry.decimals ?? null,
			entry.chainId ?? null,
			entry.blockNumber?.toString() ?? null,
			entry.blockHash?.toLowerCase() ?? null,
			entry.transactionIndex ?? null,
			entry.consistencyLevel ?? null,
			entry.projectionVersion ?? null,
			entry.counterparty?.toLowerCase() ?? null,
			entry.counterpartyUid ?? null,
			entry.reference ?? null,
			entry.linkId ?? null,
			entry.createdAt,
		),
	);
	const now = nowIso();
	const userEventStatements = (options.userEvents ?? []).map((effect) =>
		env.PARMELIA_DB.prepare(
			`INSERT OR IGNORE INTO user_event_outbox (
				id, dedupe_key, uid, event_type, payload_json, priority,
				status, attempt_count, next_attempt_at, lease_owner,
				lease_expires_at, last_error_code, created_at, updated_at,
				delivered_at
			 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL,
			           ?, ?, NULL)`,
		).bind(
			effect.dedupeKey,
			effect.dedupeKey,
			effect.uid,
			effect.eventType,
			JSON.stringify(effect.payload),
			effect.priority ?? 2,
			now,
			now,
			now,
		),
	);
	const results = await env.PARMELIA_DB.batch([
		...entryStatements,
		...userEventStatements,
	]);
	return results
		.slice(0, entries.length)
		.map((result) => (result.meta?.changes ?? 0) > 0);
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;

type LedgerPageCursor = {
	v: 1;
	createdAt: string;
	id: string;
};

export class InvalidLedgerCursorError extends Error {
	constructor() {
		super("Invalid ledger pagination cursor");
		this.name = "InvalidLedgerCursorError";
	}
}

export function encodeLedgerCursor(cursor: Omit<LedgerPageCursor, "v">): string {
	return btoa(JSON.stringify({ v: 1, ...cursor } satisfies LedgerPageCursor))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

export function decodeLedgerCursor(value: string): LedgerPageCursor {
	try {
		if (
			value.length < 1 ||
			value.length > 512 ||
			!/^[A-Za-z0-9_-]+$/u.test(value)
		) {
			throw new InvalidLedgerCursorError();
		}
		const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const parsed = JSON.parse(atob(padded)) as Partial<LedgerPageCursor>;
		if (
			parsed.v !== 1 ||
			typeof parsed.createdAt !== "string" ||
			parsed.createdAt.length < 20 ||
			parsed.createdAt.length > 40 ||
			!Number.isFinite(Date.parse(parsed.createdAt)) ||
			typeof parsed.id !== "string" ||
			parsed.id.length < 1 ||
			parsed.id.length > 128
		) {
			throw new InvalidLedgerCursorError();
		}
		return {
			v: 1,
			createdAt: parsed.createdAt,
			id: parsed.id,
		};
	} catch (error) {
		if (error instanceof InvalidLedgerCursorError) throw error;
		throw new InvalidLedgerCursorError();
	}
}

function ledgerEntryFromRow(row: LedgerRow): LedgerEntry {
	return {
		id: row.id,
		uid: row.uid,
		direction: row.direction,
		kind: row.kind,
		txHash: row.tx_hash,
		logIndex: row.log_index,
		token: row.token,
		amount: row.amount,
		amountSource: row.amount_source,
		amountRaw: row.amount_raw,
		decimals: row.decimals,
		chainId: row.chain_id,
		blockNumber: row.block_number === null ? null : BigInt(row.block_number),
		blockHash: row.block_hash,
		transactionIndex: row.transaction_index,
		consistencyLevel: row.consistency_level,
		projectionVersion: row.projection_version,
		counterparty: row.counterparty,
		counterpartyUid: row.counterparty_uid,
		reference: row.reference,
		linkId: row.link_id,
		createdAt: row.created_at,
	};
}

export async function listLedgerPageByUid(
	env: Bindings,
	uid: string,
	options: { limit?: number; before?: string | null } = {},
): Promise<{ entries: LedgerEntry[]; nextCursor: string | null }> {
	const limit = Math.min(
		LEDGER_PAGE_MAX,
		Math.max(1, Math.trunc(options.limit ?? LEDGER_PAGE_DEFAULT)),
	);
	const before = options.before ? decodeLedgerCursor(options.before) : null;
	// created_at is always an ISO-8601 string for ledger writers. Keyset
	// pagination plus id is stable under concurrent inserts and uses the
	// idx_ledger_uid_canonical_created_id covering order.
	const selection = `SELECT id, uid, direction, kind, tx_hash, log_index, token,
			amount, amount_source, amount_raw, decimals, chain_id, block_number,
			block_hash, transaction_index, consistency_level, projection_version,
			counterparty, counterparty_uid, reference, link_id, created_at
		 FROM ledger
		 WHERE uid = ? AND canonical = 1`;
	const rows = before
		? await d1All<LedgerRow>(
				env,
				`${selection}
				 AND (
					created_at < ?
					OR (created_at = ? AND id < ?)
				 )
				 ORDER BY created_at DESC, id DESC
				 LIMIT ?`,
				[uid, before.createdAt, before.createdAt, before.id, limit + 1],
			)
		: await d1All<LedgerRow>(
				env,
				`${selection}
				 ORDER BY created_at DESC, id DESC
				 LIMIT ?`,
				[uid, limit + 1],
			);
	const hasNext = rows.length > limit;
	const pageRows = hasNext ? rows.slice(0, limit) : rows;
	const tail = pageRows.at(-1);
	return {
		entries: pageRows.map(ledgerEntryFromRow),
		nextCursor:
			hasNext && tail
				? encodeLedgerCursor({ createdAt: tail.created_at, id: tail.id })
				: null,
	};
}

/** Compatibility helper for callers that do not need a cursor. */
export async function listLedgerByUid(
	env: Bindings,
	uid: string,
	limit = LEDGER_PAGE_DEFAULT,
): Promise<LedgerEntry[]> {
	return (await listLedgerPageByUid(env, uid, { limit })).entries;
}

/** All wallets the shared event-driven indexer must watch. */
export async function listUserWallets(env: Bindings): Promise<{ uid: string; walletAddress: string }[]> {
	const rows = await d1All<{ uid: string; wallet_address: string }>(
		env,
		`SELECT uid, wallet_address FROM users WHERE wallet_address IS NOT NULL`,
	);
	return rows.map((r) => ({ uid: r.uid, walletAddress: r.wallet_address }));
}

// ===== Indexer cursor =====

export async function getSyncCursor(env: Bindings, key: string): Promise<bigint | null> {
	const row = await d1First<{ last_block: string }>(
		env,
		`SELECT last_block FROM sync_state WHERE key = ? LIMIT 1`,
		[key],
	);
	return row ? BigInt(row.last_block) : null;
}

export async function setSyncCursor(env: Bindings, key: string, lastBlock: bigint) {
	await d1Run(
		env,
		`INSERT INTO sync_state (key, last_block, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
		[key, lastBlock.toString(), nowIso()],
	);
}

// ===== D1 leases =====
//
// Owner-bound leases protect event jobs and short transaction-signing critical
// sections. `cron_leases` is the legacy physical table name retained so rolling
// deployments share the same lock domain; no Cron API remains.

export async function acquireLease(
	env: Bindings,
	key: string,
	ttlMs: number,
): Promise<string | null> {
	if (!key || key.length > 160) throw new Error("Invalid lease key");
	const now = nowIso();
	const expiry = new Date(Date.now() + ttlMs).toISOString();
	const owner = crypto.randomUUID();
	// Take over an expired lease...
	const updated = await d1Run(
		env,
		`UPDATE cron_leases SET owner = ?, expires_at = ?, updated_at = ?
		 WHERE key = ? AND expires_at <= ?`,
		[owner, expiry, now, key, now],
	);
	if (didWrite(updated)) return owner;
	// ...or create the lease row the very first time.
	const inserted = await d1Run(
		env,
		`INSERT OR IGNORE INTO cron_leases (key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)`,
		[key, owner, expiry, now],
	);
	return didWrite(inserted) ? owner : null;
}

export async function renewLease(
	env: Bindings,
	key: string,
	owner: string,
	ttlMs: number,
): Promise<boolean> {
	const now = nowIso();
	const expiry = new Date(Date.now() + ttlMs).toISOString();
	const renewed = await d1Run(
		env,
		`UPDATE cron_leases SET expires_at = ?, updated_at = ? WHERE key = ? AND owner = ?`,
		[expiry, now, key, owner],
	);
	return didWrite(renewed);
}

export async function releaseLease(env: Bindings, key: string, owner: string): Promise<void> {
	await d1Run(env, `DELETE FROM cron_leases WHERE key = ? AND owner = ?`, [
		key,
		owner,
	]);
}

function mapPasskeyRow(row: PasskeyRow): PasskeyRecord {
	return {
		credentialId: row.credential_id,
		uid: row.uid,
		qx: row.qx,
		qy: row.qy,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

/** Upsert a passkey's public key (qx, qy). Refreshes last_used_at on every call. */
export async function savePasskey(
	env: Bindings,
	passkey: { credentialId: string; uid: string; qx: string; qy: string },
) {
	const now = nowIso();
	await d1Run(
		env,
		`INSERT INTO passkeys (credential_id, uid, qx, qy, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(credential_id) DO UPDATE SET
			qx = excluded.qx,
			qy = excluded.qy,
			last_used_at = excluded.last_used_at`,
		[passkey.credentialId, passkey.uid, passkey.qx, passkey.qy, now, now],
	);
}

export async function getPasskey(env: Bindings, credentialId: string): Promise<PasskeyRecord | null> {
	const row = await d1First<PasskeyRow>(
		env,
		`SELECT credential_id, uid, qx, qy, created_at, last_used_at
		 FROM passkeys
		 WHERE credential_id = ?
		 LIMIT 1`,
		[credentialId],
	);
	return row ? mapPasskeyRow(row) : null;
}

// ===== Swap quotes (Módulo 2) =====

export type SwapQuoteRecord = {
	quoteId: string;
	uid: string;
	chainId: number;
	tokenIn: string;
	tokenOut: string;
	amountIn: string;
	amountOutEstimated: string;
	minimumAmountOut: string;
	feeBps: number;
	feeAmount: string;
	protocol: "v3" | "v4";
	poolFee: number;
	tickSpacing: number | null;
	slippageBps: number;
	recipient: string;
	status: "quoted" | "prepared" | "executed" | "expired";
	createdAt: string;
	expiresAt: string;
};

type SwapQuoteRow = {
	quote_id: string;
	uid: string;
	chain_id: number;
	token_in: string;
	token_out: string;
	amount_in: string;
	amount_out_estimated: string;
	minimum_amount_out: string;
	fee_bps: number;
	fee_amount: string;
	protocol: "v3" | "v4";
	pool_fee: number;
	tick_spacing: number | null;
	slippage_bps: number;
	recipient: string;
	status: "quoted" | "prepared" | "executed" | "expired";
	created_at: string;
	expires_at: string;
};

function mapSwapQuoteRow(row: SwapQuoteRow): SwapQuoteRecord {
	return {
		quoteId: row.quote_id,
		uid: row.uid,
		chainId: row.chain_id,
		tokenIn: row.token_in,
		tokenOut: row.token_out,
		amountIn: row.amount_in,
		amountOutEstimated: row.amount_out_estimated,
		minimumAmountOut: row.minimum_amount_out,
		feeBps: row.fee_bps,
		feeAmount: row.fee_amount,
		protocol: row.protocol,
		poolFee: row.pool_fee,
		tickSpacing: row.tick_spacing,
		slippageBps: row.slippage_bps,
		recipient: row.recipient,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

export async function createSwapQuote(env: Bindings, quote: SwapQuoteRecord) {
	// Opportunistic cleanup of stale quotes (cheap: indexed on expires_at).
	await d1Run(env, `DELETE FROM swap_quotes WHERE expires_at <= ?`, [nowIso()]);
	await d1Run(
		env,
		`INSERT INTO swap_quotes (
			quote_id, uid, chain_id, token_in, token_out,
			amount_in, amount_out_estimated, minimum_amount_out,
			fee_bps, fee_amount, protocol, pool_fee, tick_spacing,
			slippage_bps, recipient, status, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			quote.quoteId,
			quote.uid,
			quote.chainId,
			quote.tokenIn,
			quote.tokenOut,
			quote.amountIn,
			quote.amountOutEstimated,
			quote.minimumAmountOut,
			quote.feeBps,
			quote.feeAmount,
			quote.protocol,
			quote.poolFee,
			quote.tickSpacing,
			quote.slippageBps,
			quote.recipient,
			quote.status,
			quote.createdAt,
			quote.expiresAt,
		],
	);
}

export async function getSwapQuote(
	env: Bindings,
	quoteId: string,
	uid: string,
): Promise<SwapQuoteRecord | null> {
	const row = await d1First<SwapQuoteRow>(
		env,
		`SELECT quote_id, uid, chain_id, token_in, token_out,
			amount_in, amount_out_estimated, minimum_amount_out,
			fee_bps, fee_amount, protocol, pool_fee, tick_spacing,
			slippage_bps, recipient, status, created_at, expires_at
		 FROM swap_quotes
		 WHERE quote_id = ? AND uid = ?
		 LIMIT 1`,
		[quoteId, uid],
	);
	return row ? mapSwapQuoteRow(row) : null;
}

export async function updateSwapQuoteStatus(
	env: Bindings,
	quoteId: string,
	status: SwapQuoteRecord["status"],
) {
	await d1Run(env, `UPDATE swap_quotes SET status = ? WHERE quote_id = ?`, [status, quoteId]);
}

// ===== Contacts + invitations =====

export type ContactRecord = {
	id: string;
	ownerUid: string;
	contactUid: string;
	username: string;
	walletAddress: string;
	alias: string | null;
	createdAt: string;
};

type ContactRow = {
	id: string;
	owner_uid: string;
	contact_uid: string;
	username: string;
	wallet_address: string;
	alias: string | null;
	created_at: string;
};

function mapContactRow(row: ContactRow): ContactRecord {
	return {
		id: row.id,
		ownerUid: row.owner_uid,
		contactUid: row.contact_uid,
		username: row.username,
		walletAddress: row.wallet_address,
		alias: row.alias,
		createdAt: row.created_at,
	};
}

export async function listContacts(env: Bindings, ownerUid: string): Promise<ContactRecord[]> {
	const rows = await d1All<ContactRow>(
		env,
		`SELECT id, owner_uid, contact_uid, username, wallet_address, alias, created_at
		 FROM contacts
		 WHERE owner_uid = ?
		 ORDER BY datetime(created_at) DESC`,
		[ownerUid],
	);
	return rows.map(mapContactRow);
}

export async function addContact(env: Bindings, contact: ContactRecord) {
	await d1Run(
		env,
		`INSERT INTO contacts (id, owner_uid, contact_uid, username, wallet_address, alias, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(owner_uid, contact_uid) DO UPDATE SET
			username = excluded.username,
			wallet_address = excluded.wallet_address,
			alias = excluded.alias`,
		[
			contact.id,
			contact.ownerUid,
			contact.contactUid,
			contact.username,
			contact.walletAddress,
			contact.alias,
			contact.createdAt,
		],
	);
}

export async function deleteContact(env: Bindings, ownerUid: string, contactId: string) {
	await d1Run(env, `DELETE FROM contacts WHERE id = ? AND owner_uid = ?`, [contactId, ownerUid]);
}

/** Record who invited a user - write-once (never overwrites an existing referral). */
export async function setInvitedBy(env: Bindings, uid: string, inviterUid: string) {
	await d1Run(
		env,
		`UPDATE users SET invited_by = ? WHERE uid = ? AND invited_by IS NULL`,
		[inviterUid, uid],
	);
}

/**
 * Register an FCM device token for a user. If the token already exists under a
 * different account (same browser, new login), it moves to this user so a device
 * never keeps notifying a logged-out account.
 */
export async function addPushToken(env: Bindings, uid: string, token: string) {
	await d1Run(
		env,
		`INSERT INTO push_tokens (token, uid) VALUES (?, ?)
		 ON CONFLICT(token) DO UPDATE SET uid = excluded.uid, created_at = datetime('now')`,
		[token, uid],
	);
}

/** All device tokens registered for a user (multi-device fan-out). */
export async function listPushTokens(env: Bindings, uid: string): Promise<string[]> {
	const rows = await d1All<{ token: string }>(
		env,
		`SELECT token FROM push_tokens WHERE uid = ?`,
		[uid],
	);
	return rows.map((r) => r.token);
}

/** Remove a single device token (e.g. when FCM reports it dead). */
export async function deletePushToken(env: Bindings, token: string) {
	await d1Run(env, `DELETE FROM push_tokens WHERE token = ?`, [token]);
}

/** How many users joined with this user's invitation (and created an account). */
export async function countInvitedUsers(env: Bindings, uid: string): Promise<number> {
	const row = await d1First<{ total: number }>(
		env,
		`SELECT COUNT(*) AS total FROM users WHERE invited_by = ? AND wallet_address IS NOT NULL`,
		[uid],
	);
	return row?.total ?? 0;
}

// ===== Payments API: merchants, API keys, intents, webhooks, events =====

export type ApiMode = "test" | "live";

export type MerchantRecord = { id: string; ownerUid: string; name: string | null; createdAt: string };
export type ApiKeyRecord = {
	id: string;
	merchantId: string;
	keyPrefix: string;
	secretHash: string;
	mode: ApiMode;
	name: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
};
export type PaymentIntentStatus = "awaiting_payment" | "paid" | "expired" | "canceled";
export type PaymentIntentRecord = {
	id: string;
	merchantId: string;
	linkId: string | null;
	amount: string;
	currency: string;
	status: PaymentIntentStatus;
	metadata: Record<string, unknown> | null;
	reference: string | null;
	checkoutUrl: string | null;
	txHash: string | null;
	mode: ApiMode;
	idempotencyKey: string | null;
	/** bytes32 invoiceId used on-chain (Flow B), = keccak256(id). */
	onchainId: string | null;
	expiresAt: string | null;
	createdAt: string;
	updatedAt: string;
};
export type WebhookEndpointRecord = {
	id: string;
	merchantId: string;
	url: string;
	secret: string;
	enabledEvents: string[] | null;
	status: "enabled" | "disabled";
	mode: ApiMode;
	createdAt: string;
};
export type EventRecord = {
	id: string;
	merchantId: string;
	type: string;
	objectId: string | null;
	payload: Record<string, unknown>;
	mode: ApiMode;
	createdAt: string;
};

export type EventOutboxPlan = {
	event: EventRecord;
	deliveries: Array<{
		id: string;
		endpointId: string;
		createdAt: string;
	}>;
};
export type WebhookDeliveryDue = {
	id: string;
	eventId: string;
	endpointId: string;
	attempt: number;
	eventType: string;
	eventPayload: string;
	eventCreatedAt: string;
	url: string;
	secret: string;
};

function apiId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

// --- merchants ---

export async function getMerchantById(env: Bindings, id: string): Promise<MerchantRecord | null> {
	const row = await d1First<{ id: string; owner_uid: string; name: string | null; created_at: string }>(
		env,
		`SELECT id, owner_uid, name, created_at FROM merchants WHERE id = ?`,
		[id],
	);
	return row ? { id: row.id, ownerUid: row.owner_uid, name: row.name, createdAt: row.created_at } : null;
}

export async function getMerchantByOwner(env: Bindings, ownerUid: string): Promise<MerchantRecord | null> {
	const row = await d1First<{ id: string; owner_uid: string; name: string | null; created_at: string }>(
		env,
		`SELECT id, owner_uid, name, created_at FROM merchants WHERE owner_uid = ?`,
		[ownerUid],
	);
	return row ? { id: row.id, ownerUid: row.owner_uid, name: row.name, createdAt: row.created_at } : null;
}

/** One merchant per user; created lazily and idempotently. */
export async function getOrCreateMerchant(env: Bindings, ownerUid: string, name: string | null = null): Promise<MerchantRecord> {
	const existing = await getMerchantByOwner(env, ownerUid);
	if (existing) return existing;
	await d1Run(
		env,
		`INSERT INTO merchants (id, owner_uid, name, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(owner_uid) DO NOTHING`,
		[apiId("mer"), ownerUid, name, nowIso()],
	);
	return (await getMerchantByOwner(env, ownerUid))!;
}

// --- api keys ---

export async function createApiKey(
	env: Bindings,
	params: { merchantId: string; keyPrefix: string; secretHash: string; mode: ApiMode; name: string | null },
): Promise<ApiKeyRecord> {
	const rec: ApiKeyRecord = {
		id: apiId("ak"),
		merchantId: params.merchantId,
		keyPrefix: params.keyPrefix,
		secretHash: params.secretHash,
		mode: params.mode,
		name: params.name,
		lastUsedAt: null,
		revokedAt: null,
		createdAt: nowIso(),
	};
	await d1Run(
		env,
		`INSERT INTO api_keys (id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
		[rec.id, rec.merchantId, rec.keyPrefix, rec.secretHash, rec.mode, rec.name, rec.createdAt],
	);
	return rec;
}

type ApiKeyRow = {
	id: string; merchant_id: string; key_prefix: string; secret_hash: string;
	mode: ApiMode; name: string | null; last_used_at: string | null; revoked_at: string | null; created_at: string;
};
function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
	return {
		id: row.id, merchantId: row.merchant_id, keyPrefix: row.key_prefix, secretHash: row.secret_hash,
		mode: row.mode, name: row.name, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, createdAt: row.created_at,
	};
}

export async function getApiKeyByHash(env: Bindings, secretHash: string): Promise<ApiKeyRecord | null> {
	const row = await d1First<ApiKeyRow>(
		env,
		`SELECT id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at
		 FROM api_keys WHERE secret_hash = ? LIMIT 1`,
		[secretHash],
	);
	return row ? mapApiKey(row) : null;
}

export async function listApiKeys(env: Bindings, merchantId: string): Promise<ApiKeyRecord[]> {
	const rows = await d1All<ApiKeyRow>(
		env,
		`SELECT id, merchant_id, key_prefix, secret_hash, mode, name, last_used_at, revoked_at, created_at
		 FROM api_keys WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`,
		[merchantId],
	);
	return rows.map(mapApiKey);
}

export async function revokeApiKey(env: Bindings, merchantId: string, id: string) {
	await d1Run(
		env,
		`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL`,
		[nowIso(), id, merchantId],
	);
}

export async function touchApiKey(env: Bindings, id: string) {
	await d1Run(env, `UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [nowIso(), id]);
}

// --- payment intents ---

type PaymentIntentRow = {
	id: string; merchant_id: string; link_id: string | null; amount: string; currency: string;
	status: PaymentIntentStatus; metadata: string | null; reference: string | null; checkout_url: string | null;
	tx_hash: string | null; mode: ApiMode; idempotency_key: string | null; onchain_id: string | null; expires_at: string | null;
	created_at: string; updated_at: string;
};
function mapIntent(row: PaymentIntentRow): PaymentIntentRecord {
	return {
		id: row.id, merchantId: row.merchant_id, linkId: row.link_id, amount: row.amount, currency: row.currency,
		status: row.status, metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
		reference: row.reference, checkoutUrl: row.checkout_url, txHash: row.tx_hash, mode: row.mode,
		idempotencyKey: row.idempotency_key, onchainId: row.onchain_id, expiresAt: row.expires_at,
		createdAt: row.created_at, updatedAt: row.updated_at,
	};
}

export async function createPaymentIntent(env: Bindings, rec: PaymentIntentRecord) {
	if (rec.status === "awaiting_payment" && rec.onchainId) {
		await scheduleEventJob(env, "router_watcher", {
			delayMs: 2_000,
			reason: "payment_intent_created",
		});
	}
	await d1Run(
		env,
		`INSERT INTO payment_intents (id, merchant_id, link_id, amount, currency, status, metadata, reference,
			checkout_url, tx_hash, mode, idempotency_key, expires_at, created_at, updated_at, onchain_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			rec.id, rec.merchantId, rec.linkId, rec.amount, rec.currency, rec.status,
			rec.metadata ? JSON.stringify(rec.metadata) : null, rec.reference, rec.checkoutUrl, rec.txHash,
			rec.mode, rec.idempotencyKey, rec.expiresAt, rec.createdAt, rec.updatedAt, rec.onchainId,
		],
	);
}

export async function createPaymentIntentWithOutbox(
	env: Bindings,
	rec: PaymentIntentRecord,
	outbox: EventOutboxPlan,
): Promise<void> {
	if (rec.status === "awaiting_payment" && rec.onchainId) {
		await scheduleEventJob(env, "router_watcher", {
			delayMs: 2_000,
			reason: "payment_intent_created",
		});
	}
	await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`INSERT INTO payment_intents (id, merchant_id, link_id, amount, currency, status, metadata, reference,
				checkout_url, tx_hash, mode, idempotency_key, expires_at, created_at, updated_at, onchain_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			rec.id, rec.merchantId, rec.linkId, rec.amount, rec.currency, rec.status,
			rec.metadata ? JSON.stringify(rec.metadata) : null, rec.reference, rec.checkoutUrl, rec.txHash,
			rec.mode, rec.idempotencyKey, rec.expiresAt, rec.createdAt, rec.updatedAt, rec.onchainId,
		),
		...eventOutboxStatements(env, outbox),
	]);
	if (outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_event_created",
		});
	}
}

/**
 * Create the checkout link, intent and payment.created outbox in one D1
 * transaction. A concurrent idempotency-key loser rolls back its link too.
 */
export async function createPaymentIntentTransaction(
	env: Bindings,
	link: PaymentLinkRecord,
	rec: PaymentIntentRecord,
	outbox: EventOutboxPlan,
): Promise<void> {
	if (rec.status === "awaiting_payment" && rec.onchainId) {
		await scheduleEventJob(env, "router_watcher", {
			delayMs: 2_000,
			reason: "payment_intent_created",
		});
	}
	const statements = [
		env.PARMELIA_DB.prepare(
			`INSERT INTO payment_links (
				id, owner_uid, wallet_address, amount, currency, reference, status,
				tx_hash, paid_at, paid_by, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			link.id, link.ownerUid, link.wallet, link.amount, link.currency, link.reference,
			link.status, link.txHash, link.paidAt, link.paidBy, link.createdAt,
		),
		env.PARMELIA_DB.prepare(
			`INSERT INTO payment_intents (id, merchant_id, link_id, amount, currency, status, metadata, reference,
				checkout_url, tx_hash, mode, idempotency_key, expires_at, created_at, updated_at, onchain_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			rec.id, rec.merchantId, rec.linkId, rec.amount, rec.currency, rec.status,
			rec.metadata ? JSON.stringify(rec.metadata) : null, rec.reference, rec.checkoutUrl, rec.txHash,
			rec.mode, rec.idempotencyKey, rec.expiresAt, rec.createdAt, rec.updatedAt, rec.onchainId,
		),
		...eventOutboxStatements(env, outbox),
	];
	await env.PARMELIA_DB.batch(statements);
	if (outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_event_created",
		});
	}
}

const INTENT_COLS =
	"id, merchant_id, link_id, amount, currency, status, metadata, reference, checkout_url, tx_hash, mode, idempotency_key, onchain_id, expires_at, created_at, updated_at";

export async function getPaymentIntentById(env: Bindings, id: string, merchantId?: string): Promise<PaymentIntentRecord | null> {
	const row = merchantId
		? await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE id = ? AND merchant_id = ?`, [id, merchantId])
		: await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE id = ?`, [id]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByLinkId(env: Bindings, linkId: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE link_id = ? LIMIT 1`, [linkId]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByOnchainId(env: Bindings, onchainId: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(env, `SELECT ${INTENT_COLS} FROM payment_intents WHERE onchain_id = ? LIMIT 1`, [onchainId]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentIntentByIdempotency(env: Bindings, merchantId: string, key: string): Promise<PaymentIntentRecord | null> {
	const row = await d1First<PaymentIntentRow>(
		env,
		`SELECT ${INTENT_COLS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`,
		[merchantId, key],
	);
	return row ? mapIntent(row) : null;
}

/**
 * Newest-first page of a merchant's intents. `startingAfterId` is a cursor (the
 * last id of the previous page); the page starts strictly after that intent.
 * created_at is ISO text, so plain ORDER BY is chronological; `id DESC` breaks
 * same-timestamp ties deterministically.
 */
export async function listPaymentIntents(
	env: Bindings,
	merchantId: string,
	limit = 50,
	startingAfterId?: string | null,
	filters?: { status?: string | null; mode?: ApiMode | null },
): Promise<PaymentIntentRecord[]> {
	let cursorCreatedAt: string | null = null;
	let cursorId: string | null = null;
	if (startingAfterId) {
		const cursorRow = await d1First<{ created_at: string; id: string }>(
			env,
			`SELECT created_at, id FROM payment_intents WHERE id = ? AND merchant_id = ? LIMIT 1`,
			[startingAfterId, merchantId],
		);
		if (cursorRow) {
			cursorCreatedAt = cursorRow.created_at;
			cursorId = cursorRow.id;
		}
	}
	const conds: string[] = ["merchant_id = ?"];
	const params: unknown[] = [merchantId];
	if (filters?.status) {
		conds.push("status = ?");
		params.push(filters.status);
	}
	if (filters?.mode) {
		conds.push("mode = ?");
		params.push(filters.mode);
	}
	if (cursorCreatedAt) {
		conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
		params.push(cursorCreatedAt, cursorCreatedAt, cursorId);
	}
	const rows = await d1All<PaymentIntentRow>(
		env,
		`SELECT ${INTENT_COLS} FROM payment_intents WHERE ${conds.join(" AND ")}
		 ORDER BY created_at DESC, id DESC LIMIT ?`,
		[...params, limit],
	);
	return rows.map(mapIntent);
}

/**
 * Whether an intent can still be paid: status must be awaiting_payment AND its
 * expiry (if any) must be in the future. Every pay/authorize path must check
 * this — a canceled or expired intent keeps a 'pending' payment_links row, so
 * checking only the link would let payers settle dead intents.
 */
export function isIntentPayable(intent: Pick<PaymentIntentRecord, "status" | "expiresAt">): boolean {
	if (intent.status !== "awaiting_payment") return false;
	if (intent.expiresAt && new Date(intent.expiresAt).getTime() <= Date.now()) return false;
	return true;
}

export async function markPaymentIntentPaid(env: Bindings, id: string, txHash: string, paidAt: string): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'`,
		[txHash, paidAt, id],
	);
	return didWrite(result);
}

/** Atomically settle a sandbox/indexed intent and persist its paid outbox. */
export async function markPaymentIntentPaidWithOutbox(
	env: Bindings,
	id: string,
	txHash: string,
	paidAt: string,
	outbox: EventOutboxPlan,
): Promise<boolean> {
	const results = await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ?
			 WHERE id = ? AND status = 'awaiting_payment'`,
		).bind(txHash, paidAt, id),
		...eventOutboxStatements(env, outbox, { intentId: id, txHash }),
	]);
	const written = didWrite(results[0]);
	if (written && outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_intent_paid",
		});
	}
	return written;
}

/**
 * Settle the link, backing intent and payment.paid outbox as one transaction.
 * The link claim prevents another UserOperation from paying the same checkout.
 */
export async function settlePaymentLinkWithOutbox(
	env: Bindings,
	params: {
		id: string;
		amount: string;
		txHash: string;
		paidAt: string;
		paidBy: string;
		claimOwner: string;
		intentId?: string | null;
		outbox?: EventOutboxPlan | null;
	},
): Promise<boolean> {
	const statements = [
		env.PARMELIA_DB.prepare(
			`UPDATE payment_links
			 SET status = 'paid', amount = ?, tx_hash = ?, paid_at = ?, paid_by = ?,
				payment_claim = NULL, payment_claim_expires_at = NULL, payment_claim_tx_hash = NULL
			 WHERE id = ? AND status = 'pending'
				AND (payment_claim IS NULL OR payment_claim = ?)`,
		).bind(params.amount, params.txHash, params.paidAt, params.paidBy, params.id, params.claimOwner),
	];

	if (params.intentId) {
		statements.push(
			env.PARMELIA_DB.prepare(
				`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ?
				 WHERE id = ? AND status = 'awaiting_payment'
					AND EXISTS (
						SELECT 1 FROM payment_links
						WHERE id = ? AND status = 'paid' AND tx_hash = ?
					)`,
			).bind(params.txHash, params.paidAt, params.intentId, params.id, params.txHash),
		);
		if (params.outbox) {
			statements.push(...eventOutboxStatements(env, params.outbox, {
				intentId: params.intentId,
				txHash: params.txHash,
			}));
		}
	}

	const results = await env.PARMELIA_DB.batch(statements);
	const written = didWrite(results[0]);
	if (written && params.outbox && params.outbox.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "payment_link_settled",
		});
	}
	return written;
}

export async function updatePaymentIntentStatus(env: Bindings, id: string, merchantId: string, status: PaymentIntentStatus): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE payment_intents SET status = ?, updated_at = ?
		 WHERE id = ? AND merchant_id = ? AND status = 'awaiting_payment'
			AND NOT EXISTS (
				SELECT 1 FROM payment_links
				WHERE payment_links.id = payment_intents.link_id
					AND payment_links.payment_claim IS NOT NULL
			)`,
		[status, nowIso(), id, merchantId],
	);
	return didWrite(result);
}

// --- webhook endpoints ---

type WebhookEndpointRow = {
	id: string; merchant_id: string; url: string; secret: string; enabled_events: string | null;
	status: "enabled" | "disabled"; mode: ApiMode; created_at: string;
};
function mapEndpoint(row: WebhookEndpointRow): WebhookEndpointRecord {
	return {
		id: row.id, merchantId: row.merchant_id, url: row.url, secret: row.secret,
		enabledEvents: row.enabled_events ? (JSON.parse(row.enabled_events) as string[]) : null,
		status: row.status, mode: row.mode, createdAt: row.created_at,
	};
}

export async function createWebhookEndpoint(
	env: Bindings,
	params: { merchantId: string; url: string; secret: string; enabledEvents: string[] | null; mode: ApiMode },
): Promise<WebhookEndpointRecord> {
	const rec: WebhookEndpointRecord = {
		id: apiId("whe"), merchantId: params.merchantId, url: params.url, secret: params.secret,
		enabledEvents: params.enabledEvents, status: "enabled", mode: params.mode, createdAt: nowIso(),
	};
	await d1Run(
		env,
		`INSERT INTO webhook_endpoints (id, merchant_id, url, secret, enabled_events, status, mode, created_at)
		 VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?)`,
		[rec.id, rec.merchantId, rec.url, rec.secret, rec.enabledEvents ? JSON.stringify(rec.enabledEvents) : null, rec.mode, rec.createdAt],
	);
	await scheduleEventJob(env, "webhook_key_rotation", {
		reason: "webhook_endpoint_changed",
	});
	return rec;
}

export async function listWebhookEndpoints(env: Bindings, merchantId: string): Promise<WebhookEndpointRecord[]> {
	const rows = await d1All<WebhookEndpointRow>(
		env,
		`SELECT id, merchant_id, url, secret, enabled_events, status, mode, created_at
		 FROM webhook_endpoints WHERE merchant_id = ? ORDER BY datetime(created_at) DESC`,
		[merchantId],
	);
	return rows.map(mapEndpoint);
}

export async function listEnabledEndpoints(env: Bindings, merchantId: string, mode: ApiMode): Promise<WebhookEndpointRecord[]> {
	const rows = await d1All<WebhookEndpointRow>(
		env,
		`SELECT id, merchant_id, url, secret, enabled_events, status, mode, created_at
		 FROM webhook_endpoints WHERE merchant_id = ? AND mode = ? AND status = 'enabled'`,
		[merchantId, mode],
	);
	return rows.map(mapEndpoint);
}

export async function deleteWebhookEndpoint(env: Bindings, merchantId: string, id: string) {
	await d1Run(env, `DELETE FROM webhook_endpoints WHERE id = ? AND merchant_id = ?`, [id, merchantId]);
}

export async function listWebhookSecretsNeedingEncryption(
	env: Bindings,
	activePrefix: string,
	limit = 25,
): Promise<Array<{ id: string; secret: string }>> {
	return d1All<{ id: string; secret: string }>(
		env,
		`SELECT id, secret FROM webhook_endpoints WHERE substr(secret, 1, length(?)) <> ? LIMIT ?`,
		[activePrefix, activePrefix, limit],
	);
}

export async function replaceWebhookSecret(
	env: Bindings,
	id: string,
	oldSecret: string,
	newSecret: string,
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE webhook_endpoints SET secret = ? WHERE id = ? AND secret = ?`,
		[newSecret, id, oldSecret],
	);
	return didWrite(result);
}

// --- events + webhook deliveries (outbox) ---

function eventOutboxStatements(
	env: Bindings,
	plan: EventOutboxPlan,
	guard?: { intentId: string; txHash: string },
) {
	const event = plan.event;
	const eventStatement = guard
		? env.PARMELIA_DB.prepare(
			`INSERT OR IGNORE INTO events (id, merchant_id, type, object_id, payload, mode, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, ?
			 WHERE EXISTS (
				SELECT 1 FROM payment_intents WHERE id = ? AND status = 'paid' AND tx_hash = ?
			 )`,
		).bind(
			event.id, event.merchantId, event.type, event.objectId, JSON.stringify(event.payload),
			event.mode, event.createdAt, guard.intentId, guard.txHash,
		)
		: env.PARMELIA_DB.prepare(
			`INSERT OR IGNORE INTO events (id, merchant_id, type, object_id, payload, mode, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			event.id, event.merchantId, event.type, event.objectId, JSON.stringify(event.payload),
			event.mode, event.createdAt,
		);

	return [
		eventStatement,
		...plan.deliveries.map((delivery) =>
			env.PARMELIA_DB.prepare(
				`INSERT OR IGNORE INTO webhook_deliveries
					(id, event_id, endpoint_id, attempt, status, next_retry_at, created_at)
				 SELECT ?, ?, ?, 0, 'pending', ?, ?
				 WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)`,
			).bind(
				delivery.id, event.id, delivery.endpointId, delivery.createdAt,
				delivery.createdAt, event.id,
			),
		),
	];
}

/** Persist an immutable event and all endpoint deliveries atomically. */
export async function enqueueEventOutbox(env: Bindings, plan: EventOutboxPlan): Promise<void> {
	await env.PARMELIA_DB.batch(eventOutboxStatements(env, plan));
	if (plan.deliveries.length > 0) {
		await scheduleEventJob(env, "webhook_delivery", {
			reason: "merchant_event_enqueued",
		});
	}
}

export async function createEvent(env: Bindings, rec: EventRecord) {
	await d1Run(
		env,
		`INSERT INTO events (id, merchant_id, type, object_id, payload, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[rec.id, rec.merchantId, rec.type, rec.objectId, JSON.stringify(rec.payload), rec.mode, rec.createdAt],
	);
}

type EventRow = { id: string; merchant_id: string; type: string; object_id: string | null; payload: string; mode: ApiMode; created_at: string };
function mapEvent(row: EventRow): EventRecord {
	return {
		id: row.id, merchantId: row.merchant_id, type: row.type, objectId: row.object_id,
		payload: JSON.parse(row.payload) as Record<string, unknown>, mode: row.mode, createdAt: row.created_at,
	};
}

export async function listEvents(
	env: Bindings,
	merchantId: string,
	limit = 50,
	startingAfterId?: string | null,
): Promise<EventRecord[]> {
	// Cursor pagination on (created_at, id), same scheme as payment intents.
	let cursorCreatedAt: string | null = null;
	let cursorId: string | null = null;
	if (startingAfterId) {
		const cursorRow = await d1First<{ created_at: string; id: string }>(
			env,
			`SELECT created_at, id FROM events WHERE id = ? AND merchant_id = ? LIMIT 1`,
			[startingAfterId, merchantId],
		);
		if (cursorRow) {
			cursorCreatedAt = cursorRow.created_at;
			cursorId = cursorRow.id;
		}
	}
	const rows = cursorCreatedAt
		? await d1All<EventRow>(
				env,
				`SELECT id, merchant_id, type, object_id, payload, mode, created_at
				 FROM events
				 WHERE merchant_id = ? AND (datetime(created_at) < datetime(?) OR (created_at = ? AND id < ?))
				 ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
				[merchantId, cursorCreatedAt, cursorCreatedAt, cursorId, limit],
			)
		: await d1All<EventRow>(
				env,
				`SELECT id, merchant_id, type, object_id, payload, mode, created_at
				 FROM events WHERE merchant_id = ? ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
				[merchantId, limit],
			);
	return rows.map(mapEvent);
}

export async function getEvent(env: Bindings, merchantId: string, id: string): Promise<EventRecord | null> {
	const row = await d1First<EventRow>(
		env,
		`SELECT id, merchant_id, type, object_id, payload, mode, created_at FROM events WHERE id = ? AND merchant_id = ?`,
		[id, merchantId],
	);
	return row ? mapEvent(row) : null;
}

export async function createWebhookDelivery(
	env: Bindings,
	rec: { id: string; eventId: string; endpointId: string; attempt: number; status: string; nextRetryAt: string | null; createdAt: string },
) {
	await d1Run(
		env,
		`INSERT INTO webhook_deliveries (id, event_id, endpoint_id, attempt, status, next_retry_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[rec.id, rec.eventId, rec.endpointId, rec.attempt, rec.status, rec.nextRetryAt, rec.createdAt],
	);
}

export async function listDueWebhookDeliveries(env: Bindings, limit = 25): Promise<WebhookDeliveryDue[]> {
	const now = nowIso();
	const rows = await d1All<{
		id: string; event_id: string; endpoint_id: string; attempt: number;
		event_type: string; event_payload: string; event_created_at: string; url: string; secret: string;
	}>(
		env,
		`SELECT d.id, d.event_id, d.endpoint_id, d.attempt,
			e.type AS event_type, e.payload AS event_payload, e.created_at AS event_created_at,
			w.url AS url, w.secret AS secret
		 FROM webhook_deliveries d
		 JOIN events e ON e.id = d.event_id
		 JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 WHERE d.status = 'pending' AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
		 ORDER BY d.created_at ASC LIMIT ?`,
		[now, limit],
	);
	return rows.map((r) => ({
		id: r.id, eventId: r.event_id, endpointId: r.endpoint_id, attempt: r.attempt,
		eventType: r.event_type, eventPayload: r.event_payload, eventCreatedAt: r.event_created_at, url: r.url, secret: r.secret,
	}));
}

/**
 * Claim a due delivery for `leaseMs` by pushing next_retry_at into the future —
 * atomically, so two overlapping Queue deliveries can't
 * POST the same delivery twice. The winner delivers and then records the final
 * state; if it dies mid-flight, the lease expires and the delivery is retried.
 */
export async function claimWebhookDelivery(env: Bindings, id: string, leaseMs: number): Promise<boolean> {
	const now = nowIso();
	const lease = new Date(Date.now() + leaseMs).toISOString();
	const result = await d1Run(
		env,
		`UPDATE webhook_deliveries SET next_retry_at = ?
		 WHERE id = ? AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
		[lease, id, now],
	);
	return didWrite(result);
}

export async function updateWebhookDelivery(
	env: Bindings,
	id: string,
	fields: { status: string; attempt: number; responseCode: number | null; deliveredAt: string | null; nextRetryAt: string | null },
) {
	await d1Run(
		env,
		`UPDATE webhook_deliveries SET status = ?, attempt = ?, response_code = ?, delivered_at = ?, next_retry_at = ? WHERE id = ?`,
		[fields.status, fields.attempt, fields.responseCode, fields.deliveredAt, fields.nextRetryAt, id],
	);
}

/** Recent webhook delivery attempts for a merchant (joined with event + endpoint). */
export type WebhookDeliveryView = {
	id: string;
	eventId: string;
	endpointId: string;
	attempt: number;
	status: string;
	responseCode: number | null;
	eventType: string;
	url: string;
	nextRetryAt: string | null;
	deliveredAt: string | null;
	createdAt: string;
};

export async function listWebhookDeliveriesByMerchant(
	env: Bindings,
	merchantId: string,
	limit = 50,
): Promise<WebhookDeliveryView[]> {
	const rows = await d1All<{
		id: string; event_id: string; endpoint_id: string; attempt: number; status: string;
		response_code: number | null; next_retry_at: string | null; delivered_at: string | null;
		created_at: string; event_type: string; url: string;
	}>(
		env,
		`SELECT d.id, d.event_id, d.endpoint_id, d.attempt, d.status, d.response_code,
			d.next_retry_at, d.delivered_at, d.created_at, e.type AS event_type, w.url AS url
		 FROM webhook_deliveries d
		 JOIN events e ON e.id = d.event_id
		 JOIN webhook_endpoints w ON w.id = d.endpoint_id
		 WHERE w.merchant_id = ?
		 ORDER BY d.created_at DESC LIMIT ?`,
		[merchantId, limit],
	);
	return rows.map((r) => ({
		id: r.id, eventId: r.event_id, endpointId: r.endpoint_id, attempt: r.attempt, status: r.status,
		responseCode: r.response_code, eventType: r.event_type, url: r.url, nextRetryAt: r.next_retry_at,
		deliveredAt: r.delivered_at, createdAt: r.created_at,
	}));
}

/** Re-queue a delivery for an immediate retry. Scoped to the merchant's endpoints. */
export async function requeueWebhookDelivery(env: Bindings, merchantId: string, id: string) {
	await d1Run(
		env,
		`UPDATE webhook_deliveries SET status = 'pending', attempt = 0, next_retry_at = NULL
		 WHERE id = ? AND endpoint_id IN (SELECT id FROM webhook_endpoints WHERE merchant_id = ?)`,
		[id, merchantId],
	);
	await scheduleEventJob(env, "webhook_delivery", {
		reason: "merchant_webhook_manual_resend",
	});
}

// ===== Cross-chain operations (CCTP v2) =====

export type CrosschainDirection = "inbound" | "outbound";
export type CrosschainMode = "standard" | "fast";
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
	parmeliaFee: string;
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
	parmelia_fee: string;
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
	"op_id, uid, direction, provider, cctp_mode, source_chain_id, destination_chain_id, source_domain, destination_domain, destination_caller, source_tx_hash, destination_tx_hash, message_nonce, message_bytes, attestation, token, amount_in, parmelia_fee, max_fee, min_finality_threshold, cctp_fee_estimated, amount_out_expected, recipient, status, status_detail, attempt_count, last_error, created_at, updated_at, completed_at";

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
		parmeliaFee: row.parmelia_fee,
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
			 message_nonce, message_bytes, attestation, token, amount_in, parmelia_fee, max_fee,
			 min_finality_threshold, cctp_fee_estimated, amount_out_expected, recipient, status,
			 status_detail, attempt_count, last_error, created_at, updated_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			op.opId, op.uid, op.direction, op.provider, op.cctpMode, op.sourceChainId, op.destinationChainId,
			op.sourceDomain, op.destinationDomain, op.destinationCaller, op.sourceTxHash, op.destinationTxHash,
			op.messageNonce, op.messageBytes, op.attestation, op.token, op.amountIn, op.parmeliaFee, op.maxFee,
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
			delayMs: 30_000,
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
	await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`INSERT INTO crosschain_mint_attempts (id, op_id, tx_hash, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'broadcast', ?, ?)
			 ON CONFLICT(tx_hash) DO UPDATE SET status = 'broadcast', updated_at = excluded.updated_at`,
		).bind(`cma_${crypto.randomUUID().replace(/-/g, "")}`, opId, txHash.toLowerCase(), now, now),
		env.PARMELIA_DB.prepare(
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

