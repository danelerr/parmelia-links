import type { Bindings } from "../middlewares/auth";
import { logError } from "./logger";
import { scheduleEventJob } from "./eventScheduler";
import { scheduleWalletIndexerPartitions } from "./indexerPartitions";
import { wakePaymentsSync } from "./paymentsRpc";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./storage/core";

export * from "./storage/crosschain";
export * from "./storage/ledger";
export * from "./storage/leases";
export * from "./storage/accountOperations";
export * from "./storage/merchantApi";
export * from "./storage/passkeys";
export * from "./storage/syncState";
export * from "./storage/userFeatures";

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
	settlementAccountVersion: number;
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
export type PendingPaymentSponsorshipProvider = "parmelia" | "erc7677" | "self-funded" | "legacy";

export type PendingPaymentRecord = {
	userOpHash: string;
	uid: string;
	linkId: string | null;
	paymentAttemptId: string | null;
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
	sponsorshipProvider: PendingPaymentSponsorshipProvider;
	sponsorshipPaymasterAddress: string | null;
	submittedAt: string | null;
	submissionAttemptCount: number;
	lastSubmissionErrorCode: string | null;
	createdAt: string;
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
	settlement_account_version: number;
};

const USER_COLUMNS =
	"uid, wallet_address, username, referral_code, credential_id, funded_at, invited_by, display_name, social_url, created_at, updated_at, settlement_account_version";

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
	payment_attempt_id: string | null;
	wallet_address: string;
	sender_address: string;
	amount: string;
	currency: string;
	user_op_json: string;
	meta: string | null;
	status: PendingPaymentStatus;
	submitted_tx_hash: string | null;
	submission_transport: PendingPaymentSubmissionTransport;
	sponsorship_provider: PendingPaymentSponsorshipProvider;
	sponsorship_paymaster_address: string | null;
	submitted_at: string | null;
	submission_attempt_count: number;
	last_submission_error_code: string | null;
	created_at: string;
	expires_at: string;
};

const PENDING_COLS =
	"user_op_hash, uid, link_id, payment_attempt_id, wallet_address, sender_address, amount, currency, user_op_json, meta, status, submitted_tx_hash, submission_transport, sponsorship_provider, sponsorship_paymaster_address, submitted_at, submission_attempt_count, last_submission_error_code, created_at, expires_at";


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
		settlementAccountVersion: row.settlement_account_version ?? 0,
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
		paymentAttemptId: row.payment_attempt_id,
		wallet: row.wallet_address,
		senderAddress: row.sender_address,
		amount: row.amount,
		currency: row.currency,
		userOp: JSON.parse(row.user_op_json) as Record<string, unknown>,
		meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
		status: row.status ?? "prepared",
		submittedTxHash: row.submitted_tx_hash ?? null,
		submissionTransport: row.submission_transport ?? "self",
		sponsorshipProvider: row.sponsorship_provider ?? "legacy",
		sponsorshipPaymasterAddress: row.sponsorship_paymaster_address ?? null,
		submittedAt: row.submitted_at ?? null,
		submissionAttemptCount: row.submission_attempt_count ?? 0,
		lastSubmissionErrorCode: row.last_submission_error_code ?? null,
		createdAt: row.created_at,
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
			, settlement_account_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN 0 ELSE 1 END)
		ON CONFLICT(uid) DO UPDATE SET
			settlement_account_version = CASE
				WHEN excluded.wallet_address IS NOT NULL AND (
					users.wallet_address IS NULL OR lower(users.wallet_address) != lower(excluded.wallet_address)
				) THEN users.settlement_account_version + 1
				ELSE users.settlement_account_version
			END,
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
			walletAddress,
		],
	);
	if (walletAddress) await wakePaymentsSync(env, "settlement_account_changed");
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

/** Reverse lookup: which GatoPago user owns this (lowercase) address? */
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
		| "paymentAttemptId"
		| "meta"
		| "status"
		| "submittedTxHash"
		| "submissionTransport"
		| "sponsorshipProvider"
		| "sponsorshipPaymasterAddress"
		| "submittedAt"
		| "submissionAttemptCount"
		| "lastSubmissionErrorCode"
	> & {
		meta?: Record<string, unknown> | null;
		paymentAttemptId?: string | null;
		submissionTransport?: PendingPaymentSubmissionTransport;
		sponsorshipProvider?: Exclude<PendingPaymentSponsorshipProvider, "legacy">;
		sponsorshipPaymasterAddress?: string | null;
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
			payment_attempt_id,
			wallet_address,
			sender_address,
			amount,
			currency,
			user_op_json,
			meta,
			status,
			submitted_tx_hash,
			submission_transport,
			sponsorship_provider,
			sponsorship_paymaster_address,
			submitted_at,
			submission_attempt_count,
			last_submission_error_code,
			created_at,
			expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, ?, NULL, 0, NULL, ?, ?)
		ON CONFLICT(user_op_hash) DO UPDATE SET
			uid = excluded.uid,
			link_id = excluded.link_id,
			payment_attempt_id = excluded.payment_attempt_id,
			wallet_address = excluded.wallet_address,
			sender_address = excluded.sender_address,
			amount = excluded.amount,
			currency = excluded.currency,
			user_op_json = excluded.user_op_json,
			meta = excluded.meta,
			status = 'prepared',
			submitted_tx_hash = NULL,
			submission_transport = excluded.submission_transport,
			sponsorship_provider = excluded.sponsorship_provider,
			sponsorship_paymaster_address = excluded.sponsorship_paymaster_address,
			submitted_at = NULL,
			submission_attempt_count = 0,
			last_submission_error_code = NULL,
			created_at = excluded.created_at,
			expires_at = excluded.expires_at`,
		[
			pending.userOpHash,
			pending.uid,
			pending.linkId,
			pending.paymentAttemptId ?? null,
			pending.wallet,
			pending.senderAddress,
			pending.amount,
			pending.currency,
			JSON.stringify(pending.userOp),
			pending.meta ? JSON.stringify(pending.meta) : null,
			pending.submissionTransport ?? "self",
			pending.sponsorshipProvider ?? "legacy",
			pending.sponsorshipPaymasterAddress?.toLowerCase() ?? null,
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
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`UPDATE pending_payments
			 SET status = 'submitting',
			     submission_attempt_count = submission_attempt_count + 1,
			     last_submission_error_code = NULL
			 WHERE user_op_hash = ? AND status = 'prepared'`,
		).bind(userOpHash),
		// D1 batch is transactional: a Worker cannot die after taking the claim
		// while leaving no durable work capable of discovering an ambiguous
		// broadcast. The existing submitted trigger can later raise priority.
		env.GATOPAGO_DB.prepare(
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
	const now = new Date().toISOString();
	const cutoff = new Date(Date.now() - 50 * 60_000).toISOString(); // expires_at = created+10m → ~1h old
	await d1Run(
		env,
		`DELETE FROM pending_payments
		 WHERE (status = 'prepared' AND expires_at <= ?)
		    OR (status IN ('confirmed', 'failed') AND expires_at <= ?)`,
		[now, cutoff],
	);
}

async function deletePendingPayment(env: Bindings, userOpHash: string) {
	await d1Run(env, `DELETE FROM pending_payments WHERE user_op_hash = ?`, [userOpHash]);
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

