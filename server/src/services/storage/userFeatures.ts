import type { Bindings } from "../../middlewares/auth";
import { d1All, d1First, d1Run, nowIso } from "./core";

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

