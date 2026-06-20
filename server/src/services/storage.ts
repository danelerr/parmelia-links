import type { Bindings } from "../middlewares/auth";

export type UserRecord = {
	uid: string;
	walletAddress: string | null;
	username: string | null;
	referralCode: string | null;
	credentialId: string | null;
	fundedAt: string | null;
	invitedBy: string | null;
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
	createdAt: string;
};

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

type UserRow = {
	uid: string;
	wallet_address: string | null;
	username: string | null;
	referral_code: string | null;
	credential_id: string | null;
	funded_at: string | null;
	invited_by: string | null;
	created_at: string | null;
	updated_at: string | null;
};

const USER_COLUMNS =
	"uid, wallet_address, username, referral_code, credential_id, funded_at, invited_by, created_at, updated_at";

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
	created_at: string;
};

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
	created_at: string;
	expires_at: string;
};

type PasskeyRow = {
	credential_id: string;
	uid: string;
	qx: string;
	qy: string;
	created_at: string;
	last_used_at: string;
};

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
	await env.PARMELIA_DB.prepare(query).bind(...params).run();
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
	const existing = await getUserByUid(env, user.uid);
	const timestamp = user.updatedAt ?? nowIso();
	const createdAt = existing?.createdAt ?? user.createdAt ?? timestamp;
	// Addresses are stored lowercase so the ledger / indexer can do exact
	// reverse lookups (address → user) without case games.
	const walletAddress =
		user.walletAddress !== undefined
			? (user.walletAddress?.toLowerCase() ?? null)
			: (existing?.walletAddress ?? null);

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
			wallet_address = excluded.wallet_address,
			username = excluded.username,
			credential_id = excluded.credential_id,
			funded_at = excluded.funded_at,
			updated_at = excluded.updated_at`,
		[
			user.uid,
			walletAddress,
			user.username !== undefined ? user.username : existing?.username ?? null,
			user.credentialId !== undefined ? user.credentialId : existing?.credentialId ?? null,
			user.fundedAt !== undefined ? user.fundedAt : existing?.fundedAt ?? null,
			createdAt,
			timestamp,
		],
	);
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
		`SELECT id, owner_uid, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, created_at
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
		`SELECT id, owner_uid, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, created_at
		 FROM payment_links
		 WHERE owner_uid = ?
		 ORDER BY datetime(created_at) DESC
		 LIMIT ?`,
		[ownerUid, limit],
	);
	return rows.map(mapPaymentLinkRow);
}

export async function listPaidLinksByOwner(env: Bindings, ownerUid: string, limit = 100): Promise<PaymentLinkRecord[]> {
	const rows = await d1All<PaymentLinkRow>(
		env,
		`SELECT id, owner_uid, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, created_at
		 FROM payment_links
		 WHERE owner_uid = ? AND status = 'paid'
		 ORDER BY datetime(COALESCE(paid_at, created_at)) DESC
		 LIMIT ?`,
		[ownerUid, limit],
	);
	return rows.map(mapPaymentLinkRow);
}

export async function markPaymentLinkPaid(
	env: Bindings,
	params: { id: string; amount: string; txHash: string; paidAt: string; paidBy: string },
) {
	await d1Run(
		env,
		`UPDATE payment_links
		 SET status = 'paid', amount = ?, tx_hash = ?, paid_at = ?, paid_by = ?
		 WHERE id = ?`,
		[params.amount, params.txHash, params.paidAt, params.paidBy, params.id],
	);
}

export async function createPendingPayment(
	env: Bindings,
	pending: Omit<PendingPaymentRecord, "createdAt" | "expiresAt" | "meta"> & {
		meta?: Record<string, unknown> | null;
		createdAt?: string;
		expiresAt?: string;
	},
) {
	const createdAt = pending.createdAt ?? nowIso();
	const expiresAt = pending.expiresAt ?? new Date(Date.now() + 10 * 60_000).toISOString();

	await d1Run(env, `DELETE FROM pending_payments WHERE expires_at <= ?`, [nowIso()]);
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
			created_at,
			expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_op_hash) DO UPDATE SET
			uid = excluded.uid,
			link_id = excluded.link_id,
			wallet_address = excluded.wallet_address,
			sender_address = excluded.sender_address,
			amount = excluded.amount,
			currency = excluded.currency,
			user_op_json = excluded.user_op_json,
			meta = excluded.meta,
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
			createdAt,
			expiresAt,
		],
	);
}

export async function getPendingPayment(env: Bindings, userOpHash: string): Promise<PendingPaymentRecord | null> {
	const row = await d1First<PendingPaymentRow>(
		env,
		`SELECT user_op_hash, uid, link_id, wallet_address, sender_address, amount, currency, user_op_json, meta, created_at, expires_at
		 FROM pending_payments
		 WHERE user_op_hash = ?
		 LIMIT 1`,
		[userOpHash],
	);
	if (!row) return null;
	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await deletePendingPayment(env, userOpHash);
		return null;
	}
	return mapPendingRow(row);
}

export async function deletePendingPayment(env: Bindings, userOpHash: string) {
	await d1Run(env, `DELETE FROM pending_payments WHERE user_op_hash = ?`, [userOpHash]);
}

// ===== Ledger (unified movements) =====

export type LedgerKind = "payment" | "link" | "swap" | "fund" | "external";

export type LedgerEntry = {
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	txHash: string;
	/** Only for cron-ingested on-chain entries (dedup key). */
	logIndex?: number | null;
	token: string;
	amount: string;
	counterparty?: string | null;
	counterpartyUid?: string | null;
	reference?: string | null;
	linkId?: string | null;
	createdAt: string;
};

type LedgerRow = {
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	tx_hash: string;
	log_index: number | null;
	token: string;
	amount: string;
	counterparty: string | null;
	counterparty_uid: string | null;
	reference: string | null;
	link_id: string | null;
	created_at: string;
};

/** Idempotent append (the dedup unique index absorbs re-submissions/re-scans). */
export async function writeLedgerEntries(env: Bindings, entries: LedgerEntry[]) {
	for (const entry of entries) {
		await d1Run(
			env,
			`INSERT OR IGNORE INTO ledger (
				id, uid, direction, kind, tx_hash, log_index, token, amount,
				counterparty, counterparty_uid, reference, link_id, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				crypto.randomUUID(),
				entry.uid,
				entry.direction,
				entry.kind,
				entry.txHash,
				entry.logIndex ?? null,
				entry.token,
				entry.amount,
				entry.counterparty?.toLowerCase() ?? null,
				entry.counterpartyUid ?? null,
				entry.reference ?? null,
				entry.linkId ?? null,
				entry.createdAt,
			],
		);
	}
}

export async function listLedgerByUid(env: Bindings, uid: string, limit = 200): Promise<LedgerEntry[]> {
	const rows = await d1All<LedgerRow>(
		env,
		`SELECT uid, direction, kind, tx_hash, log_index, token, amount,
			counterparty, counterparty_uid, reference, link_id, created_at
		 FROM ledger
		 WHERE uid = ?
		 ORDER BY datetime(created_at) DESC
		 LIMIT ?`,
		[uid, limit],
	);
	return rows.map((row) => ({
		uid: row.uid,
		direction: row.direction,
		kind: row.kind,
		txHash: row.tx_hash,
		logIndex: row.log_index,
		token: row.token,
		amount: row.amount,
		counterparty: row.counterparty,
		counterpartyUid: row.counterparty_uid,
		reference: row.reference,
		linkId: row.link_id,
		createdAt: row.created_at,
	}));
}

/** All wallets the cron indexer must watch. */
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

export async function listPaymentIntents(env: Bindings, merchantId: string, limit = 50): Promise<PaymentIntentRecord[]> {
	const rows = await d1All<PaymentIntentRow>(
		env,
		`SELECT ${INTENT_COLS} FROM payment_intents WHERE merchant_id = ? ORDER BY datetime(created_at) DESC LIMIT ?`,
		[merchantId, limit],
	);
	return rows.map(mapIntent);
}

export async function markPaymentIntentPaid(env: Bindings, id: string, txHash: string, paidAt: string) {
	await d1Run(
		env,
		`UPDATE payment_intents SET status = 'paid', tx_hash = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'`,
		[txHash, paidAt, id],
	);
}

export async function updatePaymentIntentStatus(env: Bindings, id: string, merchantId: string, status: PaymentIntentStatus) {
	await d1Run(
		env,
		`UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`,
		[status, nowIso(), id, merchantId],
	);
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

// --- events + webhook deliveries (outbox) ---

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

export async function listEvents(env: Bindings, merchantId: string, limit = 50): Promise<EventRecord[]> {
	const rows = await d1All<EventRow>(
		env,
		`SELECT id, merchant_id, type, object_id, payload, mode, created_at
		 FROM events WHERE merchant_id = ? ORDER BY datetime(created_at) DESC LIMIT ?`,
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
		 ORDER BY datetime(d.created_at) ASC LIMIT ?`,
		[now, limit],
	);
	return rows.map((r) => ({
		id: r.id, eventId: r.event_id, endpointId: r.endpoint_id, attempt: r.attempt,
		eventType: r.event_type, eventPayload: r.event_payload, eventCreatedAt: r.event_created_at, url: r.url, secret: r.secret,
	}));
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

