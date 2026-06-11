import type { Bindings } from "../middlewares/auth";

export type UserRecord = {
	uid: string;
	walletAddress: string | null;
	username: string | null;
	credentialId: string | null;
	fundedAt: string | null;
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
	createdAt: string;
	expiresAt: string;
};

export type SentTransactionRecord = {
	uid: string;
	txHash: string;
	amount: string;
	currency: string;
	to: string;
	createdAt: string;
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
	credential_id: string | null;
	funded_at: string | null;
	created_at: string | null;
	updated_at: string | null;
};

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
	created_at: string;
	expires_at: string;
};

type SentTransactionRow = {
	uid: string;
	tx_hash: string;
	amount: string;
	currency: string;
	to_wallet: string;
	created_at: string;
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
		credentialId: row.credential_id,
		fundedAt: row.funded_at,
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
		createdAt: row.created_at,
		expiresAt: row.expires_at,
	};
}

function mapSentRow(row: SentTransactionRow): SentTransactionRecord {
	return {
		uid: row.uid,
		txHash: row.tx_hash,
		amount: row.amount,
		currency: row.currency,
		to: row.to_wallet,
		createdAt: row.created_at,
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
			user.walletAddress !== undefined ? user.walletAddress : existing?.walletAddress ?? null,
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
		`SELECT uid, wallet_address, username, credential_id, funded_at, created_at, updated_at
		 FROM users
		 WHERE uid = ?
		 LIMIT 1`,
		[uid],
	);
	return row ? mapUserRow(row) : null;
}

export async function getUserByUsername(env: Bindings, username: string): Promise<UserRecord | null> {
	const row = await d1First<UserRow>(
		env,
		`SELECT uid, wallet_address, username, credential_id, funded_at, created_at, updated_at
		 FROM users
		 WHERE username = ?
		 LIMIT 1`,
		[username],
	);
	return row ? mapUserRow(row) : null;
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
	pending: Omit<PendingPaymentRecord, "createdAt" | "expiresAt"> & {
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
			created_at,
			expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_op_hash) DO UPDATE SET
			uid = excluded.uid,
			link_id = excluded.link_id,
			wallet_address = excluded.wallet_address,
			sender_address = excluded.sender_address,
			amount = excluded.amount,
			currency = excluded.currency,
			user_op_json = excluded.user_op_json,
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
			createdAt,
			expiresAt,
		],
	);
}

export async function getPendingPayment(env: Bindings, userOpHash: string): Promise<PendingPaymentRecord | null> {
	const row = await d1First<PendingPaymentRow>(
		env,
		`SELECT user_op_hash, uid, link_id, wallet_address, sender_address, amount, currency, user_op_json, created_at, expires_at
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

export async function recordSentTransaction(env: Bindings, tx: SentTransactionRecord) {
	await d1Run(
		env,
		`INSERT INTO sent_transactions (uid, tx_hash, amount, currency, to_wallet, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(uid, tx_hash) DO UPDATE SET
			amount = excluded.amount,
			currency = excluded.currency,
			to_wallet = excluded.to_wallet,
			created_at = excluded.created_at`,
		[tx.uid, tx.txHash, tx.amount, tx.currency, tx.to, tx.createdAt],
	);
}

export async function listSentTransactionsByUid(env: Bindings, uid: string, limit = 100): Promise<SentTransactionRecord[]> {
	const rows = await d1All<SentTransactionRow>(
		env,
		`SELECT uid, tx_hash, amount, currency, to_wallet, created_at
		 FROM sent_transactions
		 WHERE uid = ?
		 ORDER BY datetime(created_at) DESC
		 LIMIT ?`,
		[uid, limit],
	);
	return rows.map(mapSentRow);
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

export async function listPasskeysByUid(env: Bindings, uid: string): Promise<PasskeyRecord[]> {
	const rows = await d1All<PasskeyRow>(
		env,
		`SELECT credential_id, uid, qx, qy, created_at, last_used_at
		 FROM passkeys
		 WHERE uid = ?
		 ORDER BY datetime(last_used_at) DESC`,
		[uid],
	);
	return rows.map(mapPasskeyRow);
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
	status: "quoted" | "prepared" | "expired";
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
	status: "quoted" | "prepared" | "expired";
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

/** Record who invited a user — write-once (never overwrites an existing referral). */
export async function setInvitedBy(env: Bindings, uid: string, inviterUid: string) {
	await d1Run(
		env,
		`UPDATE users SET invited_by = ? WHERE uid = ? AND invited_by IS NULL`,
		[inviterUid, uid],
	);
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

