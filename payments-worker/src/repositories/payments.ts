import { formatUnits, keccak256, toBytes, type Address } from "viem";
import type {
	RegisterAppPaymentExecutionCommand,
	RegisteredAppPaymentExecution,
	SettlementAccountResult,
} from "../../../shared/paymentContracts";
import type { Bindings } from "../env";
import type {
	Merchant,
	PaymentAttempt,
	PaymentAttemptStatus,
	PaymentIntent,
	PaymentLink,
	PaymentQuote,
	PaymentRoute,
} from "../domain/models";
import type { PaymentFeeBreakdown, PaymentFeeLine } from "../../../shared/fees";
import { changed, first, nowIso, run } from "../stores/db";

type MerchantRow = {
	id: string; owner_uid: string; display_name: string; settlement_wallet: Address;
	settlement_chain_id: number; account_version: number; status: Merchant["status"];
	created_at: string; updated_at: string;
};
type IntentRow = {
	id: string; merchant_id: string; link_id: string | null; amount: string; amount_atomic: string;
	amount_mode: PaymentIntent["amountMode"];
	currency: "USDC"; reference: string; metadata: string; mode: PaymentIntent["mode"]; status: PaymentIntent["status"];
	settlement_wallet: Address; settlement_chain_id: number; settlement_account_version: number;
	paid_amount_atomic: string; paid_tx_hash: string | null; paid_at: string | null;
	expires_at: string | null; created_at: string; updated_at: string;
};
type LinkRow = {
	id: string; intent_id: string; merchant_id: string; owner_uid: string; wallet_address: Address;
	amount: string; currency: "USDC"; reference: string; status: PaymentLink["status"];
	tx_hash: string | null; paid_at: string | null; paid_by: string | null;
	created_at: string; updated_at: string;
};
type QuoteRow = {
	id: string; intent_id: string; payer: Address; source_chain_id: number; route: PaymentRoute;
	settlement_amount_atomic: string; platform_fee_atomic: string; cctp_fee_atomic: string;
	gross_payer_amount_atomic: string; fee_source: PaymentQuote["feeSource"];
	fee_policy_id: string; fee_policy_version: number; fee_rule_id: string;
	platform_fee_bps: number; platform_fee_bearer: PaymentQuote["platformFeeBearer"];
	platform_fee_recipient: Address | null; route_fee_cap_bps: number;
	fee_observed_at: string; expires_at: string; quote_hash: `0x${string}`; created_at: string;
};
type AttemptRow = {
	id: string; attempt_hash: `0x${string}`; intent_id: string; quote_id: string;
	payer_uid: string | null; payer_address: Address; source_chain_id: number; route: PaymentRoute;
	status: PaymentAttemptStatus; router_address: Address; authorization_hash: `0x${string}`;
	authorization_json: string; signature: `0x${string}`;
	checkout_capability_hash: `0x${string}` | null;
	payer_proof_signature: `0x${string}` | null;
	payer_proof_message_hash: `0x${string}` | null;
	valid_after: number; valid_until: number;
	user_op_hash: string | null; source_tx_hash: string | null; destination_tx_hash: string | null;
	settlement_amount_atomic: string; platform_fee_atomic: string; cctp_fee_atomic: string;
	gross_payer_amount_atomic: string; fee_policy_id: string; fee_policy_version: number; fee_rule_id: string;
	platform_fee_bps: number; platform_fee_bearer: PaymentAttempt["platformFeeBearer"];
	platform_fee_recipient: Address | null; route_fee_cap_bps: number;
	settled_amount_atomic: string; created_at: string; updated_at: string;
};

type FeeLedgerRow = {
	fee_type: "platform" | "network"; bearer: PaymentFeeLine["bearer"];
	quoted_amount_atomic: string; actual_amount_atomic: string | null; recipient: Address | null;
	status: PaymentFeeLine["status"]; policy_id: string; policy_version: number; rule_id: string;
};

const MERCHANT_COLUMNS = "id, owner_uid, display_name, settlement_wallet, settlement_chain_id, account_version, status, created_at, updated_at";
const INTENT_COLUMNS = "id, merchant_id, link_id, amount, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, paid_amount_atomic, paid_tx_hash, paid_at, expires_at, created_at, updated_at";
const LINK_COLUMNS = "id, intent_id, merchant_id, owner_uid, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, created_at, updated_at";
const QUOTE_COLUMNS = "id, intent_id, payer, source_chain_id, route, settlement_amount_atomic, platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps, fee_source, fee_observed_at, expires_at, quote_hash, created_at";
const ATTEMPT_COLUMNS = "id, attempt_hash, intent_id, quote_id, payer_uid, payer_address, source_chain_id, route, status, router_address, authorization_hash, authorization_json, signature, checkout_capability_hash, payer_proof_signature, payer_proof_message_hash, valid_after, valid_until, user_op_hash, source_tx_hash, destination_tx_hash, settlement_amount_atomic, platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps, settled_amount_atomic, created_at, updated_at";

function mapMerchant(row: MerchantRow): Merchant {
	return { id: row.id, ownerUid: row.owner_uid, displayName: row.display_name, settlementWallet: row.settlement_wallet,
		settlementChainId: row.settlement_chain_id, accountVersion: row.account_version, status: row.status,
		createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapIntent(row: IntentRow): PaymentIntent {
	return { id: row.id, merchantId: row.merchant_id, linkId: row.link_id, amount: row.amount,
		amountAtomic: row.amount_atomic, amountMode: row.amount_mode, currency: row.currency, reference: row.reference,
		metadata: JSON.parse(row.metadata) as Record<string, unknown>, mode: row.mode, status: row.status,
		settlementWallet: row.settlement_wallet, settlementChainId: row.settlement_chain_id,
		settlementAccountVersion: row.settlement_account_version, paidAmountAtomic: row.paid_amount_atomic,
		paidTxHash: row.paid_tx_hash, paidAt: row.paid_at, expiresAt: row.expires_at,
		createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapLink(row: LinkRow): PaymentLink {
	return { id: row.id, intentId: row.intent_id, merchantId: row.merchant_id, ownerUid: row.owner_uid,
		wallet: row.wallet_address, amount: row.amount, currency: row.currency, reference: row.reference,
		status: row.status, txHash: row.tx_hash, paidAt: row.paid_at, paidBy: row.paid_by,
		createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapQuote(row: QuoteRow): PaymentQuote {
	return { id: row.id, intentId: row.intent_id, payer: row.payer, sourceChainId: row.source_chain_id,
		route: row.route, settlementAmountAtomic: row.settlement_amount_atomic,
		platformFeeAtomic: row.platform_fee_atomic, cctpFeeAtomic: row.cctp_fee_atomic,
		grossPayerAmountAtomic: row.gross_payer_amount_atomic,
		feePolicyId: row.fee_policy_id, feePolicyVersion: row.fee_policy_version,
		feeRuleId: row.fee_rule_id, platformFeeBps: row.platform_fee_bps,
		platformFeeBearer: row.platform_fee_bearer, platformFeeRecipient: row.platform_fee_recipient,
		routeFeeCapBps: row.route_fee_cap_bps, feeSource: row.fee_source,
		feeObservedAt: row.fee_observed_at, expiresAt: row.expires_at, quoteHash: row.quote_hash,
		createdAt: row.created_at };
}
function mapAttempt(row: AttemptRow): PaymentAttempt {
	return { id: row.id, attemptHash: row.attempt_hash, intentId: row.intent_id, quoteId: row.quote_id,
		payerUid: row.payer_uid, payerAddress: row.payer_address, sourceChainId: row.source_chain_id,
		route: row.route, status: row.status, routerAddress: row.router_address,
		authorizationHash: row.authorization_hash, authorization: JSON.parse(row.authorization_json) as Record<string, unknown>,
		signature: row.signature, checkoutCapabilityHash: row.checkout_capability_hash,
		payerProofSignature: row.payer_proof_signature, payerProofMessageHash: row.payer_proof_message_hash,
		validAfter: row.valid_after, validUntil: row.valid_until,
		userOpHash: row.user_op_hash, sourceTxHash: row.source_tx_hash, destinationTxHash: row.destination_tx_hash,
		settlementAmountAtomic: row.settlement_amount_atomic, platformFeeAtomic: row.platform_fee_atomic,
		cctpFeeAtomic: row.cctp_fee_atomic, grossPayerAmountAtomic: row.gross_payer_amount_atomic,
		feePolicyId: row.fee_policy_id, feePolicyVersion: row.fee_policy_version,
		feeRuleId: row.fee_rule_id, platformFeeBps: row.platform_fee_bps,
		platformFeeBearer: row.platform_fee_bearer, platformFeeRecipient: row.platform_fee_recipient,
		routeFeeCapBps: row.route_fee_cap_bps, settledAmountAtomic: row.settled_amount_atomic,
		expiresAt: new Date(row.valid_until * 1000).toISOString(), createdAt: row.created_at, updatedAt: row.updated_at };
}

function merchantIdForUid(uid: string): string {
	return `mrc_${keccak256(toBytes(uid)).slice(2, 34)}`;
}

export async function getMerchantByOwner(env: Bindings, ownerUid: string): Promise<Merchant | null> {
	const row = await first<MerchantRow>(env, `SELECT ${MERCHANT_COLUMNS} FROM merchants WHERE owner_uid = ? LIMIT 1`, [ownerUid]);
	return row ? mapMerchant(row) : null;
}

export async function getMerchantById(env: Bindings, merchantId: string): Promise<Merchant | null> {
	const row = await first<MerchantRow>(env, `SELECT ${MERCHANT_COLUMNS} FROM merchants WHERE id = ? LIMIT 1`, [merchantId]);
	return row ? mapMerchant(row) : null;
}

export async function upsertSettlementAccount(env: Bindings, input: {
	commandId: string; ownerUid: string; accountVersion: number; walletAddress: Address; chainId: number;
}): Promise<SettlementAccountResult> {
	const replay = await first<{ applied: number }>(env, "SELECT applied FROM settlement_account_commands WHERE command_id = ?", [input.commandId]);
	const merchantId = merchantIdForUid(input.ownerUid);
	if (replay) return { merchantId, accountVersion: input.accountVersion, applied: replay.applied === 1 };
	const timestamp = nowIso();
	const existing = await getMerchantByOwner(env, input.ownerUid);
	const applied = !existing || input.accountVersion > existing.accountVersion;
	const statements: D1PreparedStatement[] = [];
	if (!existing) {
		statements.push(env.PAYMENTS_DB.prepare(
			"INSERT INTO merchants(id, owner_uid, settlement_wallet, settlement_chain_id, account_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).bind(merchantId, input.ownerUid, input.walletAddress, input.chainId, input.accountVersion, timestamp, timestamp));
	} else if (applied) {
		statements.push(env.PAYMENTS_DB.prepare(
			"UPDATE merchants SET settlement_wallet = ?, settlement_chain_id = ?, account_version = ?, updated_at = ? WHERE id = ? AND account_version < ?",
		).bind(input.walletAddress, input.chainId, input.accountVersion, timestamp, existing.id, input.accountVersion));
	}
	statements.push(env.PAYMENTS_DB.prepare(
		"INSERT INTO settlement_account_commands(command_id, owner_uid, account_version, applied, created_at) VALUES (?, ?, ?, ?, ?)",
	).bind(input.commandId, input.ownerUid, input.accountVersion, applied ? 1 : 0, timestamp));
	await env.PAYMENTS_DB.batch(statements);
	return { merchantId: existing?.id ?? merchantId, accountVersion: input.accountVersion, applied };
}

export async function createIntentAndLink(env: Bindings, input: {
	merchant: Merchant; amount: string; amountAtomic: string; reference: string;
	amountMode?: PaymentIntent["amountMode"];
	metadata: Record<string, unknown>; expiresAt: string; idempotencyKey?: string | null;
	mode?: "test" | "live"; intentId?: string; linkId?: string;
}): Promise<{ intent: PaymentIntent; link: PaymentLink; replay: boolean }> {
	if (input.idempotencyKey) {
		const existing = await first<IntentRow>(env, `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`, [input.merchant.id, input.idempotencyKey]);
		if (existing) {
			const intent = mapIntent(existing);
			const link = intent.linkId ? await getPaymentLink(env, intent.linkId) : null;
			if (!link) throw new Error("Idempotent intent is missing its checkout link");
			return { intent, link, replay: true };
		}
	}
	const intentId = input.intentId ?? `pi_${crypto.randomUUID()}`;
	const linkId = input.linkId ?? crypto.randomUUID();
	const timestamp = nowIso();
	const mode = input.mode ?? "test";
	const amountMode = input.amountMode ?? "fixed";
	const eventId = `evt_created_${intentId}`;
	const eventPayload = JSON.stringify({ id: intentId, object: "payment_intent",
		amount: input.amount, amount_atomic: input.amountAtomic, amount_mode: amountMode, currency: "USDC",
		reference: input.reference, metadata: input.metadata, status: "awaiting_payment", mode,
		tx_hash: null, paid_at: null, settlement_chain_id: input.merchant.settlementChainId,
		expires_at: input.expiresAt, created_at: timestamp, updated_at: timestamp });
	try {
		await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_intents(id, merchant_id, link_id, idempotency_key, amount, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?)`,
		).bind(intentId, input.merchant.id, linkId, input.idempotencyKey ?? null, input.amount, input.amountAtomic,
			amountMode, input.reference, JSON.stringify(input.metadata), mode, input.merchant.settlementWallet,
			input.merchant.settlementChainId, input.merchant.accountVersion, input.expiresAt, timestamp, timestamp),
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_links(id, owner_uid, merchant_id, intent_id, wallet_address, amount, currency, reference, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'USDC', ?, 'pending', ?, ?)`,
		).bind(linkId, input.merchant.ownerUid, input.merchant.id, intentId, input.merchant.settlementWallet,
			input.amount, input.reference, timestamp, timestamp),
		env.PAYMENTS_DB.prepare(
			"INSERT INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at) VALUES (?, ?, 'payment.created', ?, ?, ?, ?, ?)",
		).bind(eventId, input.merchant.id, intentId, `intent:${intentId}:created`, mode, eventPayload, timestamp),
		env.PAYMENTS_DB.prepare(
			"INSERT INTO payment_outbox(id, topic, resource_id, payload, status, next_attempt_at, created_at, updated_at) VALUES (?, 'webhook_delivery', ?, ?, 'pending', ?, ?, ?)",
		).bind(`out_${eventId}`, eventId, JSON.stringify({ eventId }), timestamp, timestamp, timestamp),
		env.PAYMENTS_DB.prepare(
			`INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status, next_retry_at, created_at, updated_at)
			 SELECT 'whd_' || ? || '_' || id, ?, id, 'pending', ?, ?, ? FROM webhook_endpoints
			 WHERE merchant_id = ? AND status = 'active' AND mode = ?
			 AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = 'payment.created'))`,
		).bind(eventId, eventId, timestamp, timestamp, timestamp, input.merchant.id, mode),
		]);
	} catch (error) {
		// D1 batch is transactional. If another request committed the same unique
		// idempotency key after our initial read, recover its complete resource
		// instead of surfacing the expected race as a 500.
		if (input.idempotencyKey) {
			const winner = await first<IntentRow>(env,
				`SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE merchant_id = ? AND idempotency_key = ? LIMIT 1`,
				[input.merchant.id, input.idempotencyKey]);
			if (winner) {
				const intent = mapIntent(winner);
				const link = intent.linkId ? await getPaymentLink(env, intent.linkId) : null;
				if (link) return { intent, link, replay: true };
			}
		}
		throw error;
	}
	const intent = await getPaymentIntent(env, intentId);
	const link = await getPaymentLink(env, linkId);
	if (!intent || !link) throw new Error("Payment intent creation was not durable");
	return { intent, link, replay: false };
}

export async function getPaymentIntent(env: Bindings, id: string): Promise<PaymentIntent | null> {
	const row = await first<IntentRow>(env, `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE id = ? LIMIT 1`, [id]);
	return row ? mapIntent(row) : null;
}

export async function getIntentByLink(env: Bindings, linkId: string): Promise<PaymentIntent | null> {
	const row = await first<IntentRow>(env, `SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE link_id = ? LIMIT 1`, [linkId]);
	return row ? mapIntent(row) : null;
}

export async function getPaymentLink(env: Bindings, id: string): Promise<PaymentLink | null> {
	const row = await first<LinkRow>(env, `SELECT ${LINK_COLUMNS} FROM payment_links WHERE id = ? LIMIT 1`, [id]);
	return row ? mapLink(row) : null;
}

export async function listPaymentLinks(env: Bindings, ownerUid: string, limit = 20): Promise<PaymentLink[]> {
	const rows = await env.PAYMENTS_DB.prepare(`SELECT ${LINK_COLUMNS} FROM payment_links WHERE owner_uid = ? ORDER BY created_at DESC LIMIT ?`).bind(ownerUid, limit).all<LinkRow>();
	return rows.results.map(mapLink);
}

export async function listPaymentIntents(env: Bindings, merchantId: string, limit = 50, input: {
	startingAfter?: string | null; status?: PaymentIntent["status"] | null; mode?: PaymentIntent["mode"] | null;
} = {}): Promise<PaymentIntent[]> {
	const conditions = ["merchant_id = ?"];
	const values: unknown[] = [merchantId];
	if (input.status) { conditions.push("status = ?"); values.push(input.status); }
	if (input.mode) { conditions.push("mode = ?"); values.push(input.mode); }
	if (input.startingAfter) {
		conditions.push(`(created_at < (SELECT created_at FROM payment_intents WHERE id = ? AND merchant_id = ?)
		 OR (created_at = (SELECT created_at FROM payment_intents WHERE id = ? AND merchant_id = ?) AND id < ?))`);
		values.push(input.startingAfter, merchantId, input.startingAfter, merchantId, input.startingAfter);
	}
	values.push(limit);
	const rows = await env.PAYMENTS_DB.prepare(`SELECT ${INTENT_COLUMNS} FROM payment_intents WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(...values).all<IntentRow>();
	return rows.results.map(mapIntent);
}

export async function cancelPaymentIntent(env: Bindings, merchantId: string, id: string): Promise<boolean> {
	const timestamp = nowIso();
	const results = await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_intents SET status = 'canceled', updated_at = ? WHERE id = ? AND merchant_id = ? AND status = 'awaiting_payment'",
		).bind(timestamp, id, merchantId),
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_links SET status = 'canceled', updated_at = ? WHERE intent_id = ?
			 AND EXISTS (SELECT 1 FROM payment_intents WHERE id = ? AND status = 'canceled')`,
		).bind(timestamp, id, id),
	]);
	return changed(results[0]);
}

export async function getQuote(env: Bindings, id: string): Promise<PaymentQuote | null> {
	const row = await first<QuoteRow>(env, `SELECT ${QUOTE_COLUMNS} FROM payment_quotes WHERE id = ? LIMIT 1`, [id]);
	return row ? mapQuote(row) : null;
}

export async function insertQuote(env: Bindings, quote: PaymentQuote): Promise<void> {
	await env.PAYMENTS_DB.prepare(
		`INSERT INTO payment_quotes(id, intent_id, payer, source_chain_id, route, settlement_amount_atomic,
		 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version,
		 fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps,
		 fee_source, fee_observed_at, expires_at, quote_hash, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(quote.id, quote.intentId, quote.payer, quote.sourceChainId, quote.route,
		quote.settlementAmountAtomic, quote.platformFeeAtomic, quote.cctpFeeAtomic,
		quote.grossPayerAmountAtomic, quote.feePolicyId, quote.feePolicyVersion, quote.feeRuleId,
		quote.platformFeeBps, quote.platformFeeBearer, quote.platformFeeRecipient, quote.routeFeeCapBps,
		quote.feeSource, quote.feeObservedAt,
		quote.expiresAt, quote.quoteHash, quote.createdAt).run();
}

export async function getAttempt(env: Bindings, id: string): Promise<PaymentAttempt | null> {
	const row = await first<AttemptRow>(env, `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE id = ? LIMIT 1`, [id]);
	return row ? mapAttempt(row) : null;
}

export async function getCheckoutAttempt(env: Bindings, id: string,
	capabilityHash: `0x${string}`): Promise<PaymentAttempt | null> {
	const row = await first<AttemptRow>(env,
		`SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts
		 WHERE id = ? AND checkout_capability_hash = ? LIMIT 1`,
		[id, capabilityHash.toLowerCase()]);
	return row ? mapAttempt(row) : null;
}

export async function getAttemptByHash(env: Bindings, attemptHash: string): Promise<PaymentAttempt | null> {
	const row = await first<AttemptRow>(env, `SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE attempt_hash = ? LIMIT 1`, [attemptHash.toLowerCase()]);
	return row ? mapAttempt(row) : null;
}

export async function listActiveRouterAddressesByChain(env: Bindings, chainId: number): Promise<Address[]> {
	const result = await env.PAYMENTS_DB.prepare(
		`SELECT DISTINCT router_address FROM payment_attempts
		 WHERE source_chain_id = ? AND status IN ('reserved','submitted','processing')`,
	).bind(chainId).all<{ router_address: Address }>();
	return result.results.map((row) => row.router_address);
}

export async function markAttemptProcessing(env: Bindings, attemptId: string, sourceTxHash: string): Promise<void> {
	await run(env, "UPDATE payment_attempts SET status = CASE WHEN status IN ('reserved','submitted') THEN 'processing' ELSE status END, source_tx_hash = COALESCE(source_tx_hash, ?), updated_at = ? WHERE id = ?",
		[sourceTxHash.toLowerCase(), nowIso(), attemptId]);
}

export async function upsertCrosschainOperation(env: Bindings, input: {
	attemptId: string; sourceChainId: number; destinationChainId: number; route: "cctp_fast" | "cctp_standard";
	sourceTxHash: string; messageHash: string; message?: string | null;
	burnAmountAtomic: string; platformFeeAtomic: string;
}): Promise<string> {
	const id = `cctp_${input.attemptId}`;
	const timestamp = nowIso();
	await run(env,
		`INSERT INTO crosschain_operations(op_id, attempt_id, source_chain_id, destination_chain_id, route,
		 status, source_tx_hash, message_hash, message, burn_amount_atomic, platform_fee_atomic,
		 next_attempt_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'burned', ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(attempt_id) DO UPDATE SET source_tx_hash = COALESCE(crosschain_operations.source_tx_hash, excluded.source_tx_hash),
		 message_hash = COALESCE(crosschain_operations.message_hash, excluded.message_hash), message = COALESCE(crosschain_operations.message, excluded.message),
		 burn_amount_atomic = COALESCE(crosschain_operations.burn_amount_atomic, excluded.burn_amount_atomic),
		 platform_fee_atomic = COALESCE(crosschain_operations.platform_fee_atomic, excluded.platform_fee_atomic),
		 status = CASE WHEN crosschain_operations.status = 'awaiting_burn' THEN 'burned' ELSE crosschain_operations.status END, updated_at = excluded.updated_at`,
		[id, input.attemptId, input.sourceChainId, input.destinationChainId, input.route, input.sourceTxHash.toLowerCase(),
			input.messageHash.toLowerCase(), input.message ?? null, input.burnAmountAtomic,
			input.platformFeeAtomic, timestamp, timestamp, timestamp]);
	return id;
}

export async function getCrosschainOperation(env: Bindings, opIdOrAttemptId: string): Promise<{
	opId: string; attemptId: string; sourceChainId: number; destinationChainId: number; route: "cctp_fast" | "cctp_standard";
	status: string; sourceTxHash: string | null; messageHash: string | null; message: string | null; attestation: string | null;
	burnAmountAtomic: string | null; platformFeeAtomic: string | null; networkFeeAtomic: string | null;
	destinationTxHash: string | null; messageNonce: string | null; mintedAmountAtomic: string | null;
	mintRawTransaction: string | null; mintSignerAddress: Address | null; mintNonce: number | null;
	mintBroadcastAt: string | null; attemptCount: number; createdAt: string; updatedAt: string;
}> {
	const row = await first<{ op_id: string; attempt_id: string; source_chain_id: number; destination_chain_id: number;
		route: "cctp_fast" | "cctp_standard"; status: string; source_tx_hash: string | null; message_hash: string | null;
		message: string | null; attestation: string | null; burn_amount_atomic: string | null;
		platform_fee_atomic: string | null; network_fee_atomic: string | null; destination_tx_hash: string | null;
		message_nonce: string | null; minted_amount_atomic: string | null; mint_raw_transaction: string | null;
		mint_signer_address: Address | null; mint_nonce: number | null; mint_broadcast_at: string | null;
		attempt_count: number; created_at: string; updated_at: string }>(env,
		`SELECT op_id, attempt_id, source_chain_id, destination_chain_id, route, status, source_tx_hash,
		 message_hash, message, attestation, burn_amount_atomic, platform_fee_atomic, network_fee_atomic,
		 destination_tx_hash, message_nonce, minted_amount_atomic, mint_raw_transaction,
		 mint_signer_address, mint_nonce, mint_broadcast_at, attempt_count, created_at, updated_at
		 FROM crosschain_operations WHERE op_id = ? OR attempt_id = ? LIMIT 1`,
		[opIdOrAttemptId, opIdOrAttemptId]);
	if (!row) throw new Error("Crosschain operation not found");
	return { opId: row.op_id, attemptId: row.attempt_id, sourceChainId: row.source_chain_id,
		destinationChainId: row.destination_chain_id, route: row.route, status: row.status,
		sourceTxHash: row.source_tx_hash, messageHash: row.message_hash, message: row.message, attestation: row.attestation,
		burnAmountAtomic: row.burn_amount_atomic, platformFeeAtomic: row.platform_fee_atomic,
		networkFeeAtomic: row.network_fee_atomic, destinationTxHash: row.destination_tx_hash,
		messageNonce: row.message_nonce, mintedAmountAtomic: row.minted_amount_atomic,
		mintRawTransaction: row.mint_raw_transaction, mintSignerAddress: row.mint_signer_address,
		mintNonce: row.mint_nonce, mintBroadcastAt: row.mint_broadcast_at,
		attemptCount: row.attempt_count, createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function updateCrosschainOperation(env: Bindings, opId: string, fields: {
	status: string; message?: string | null; attestation?: string | null; destinationTxHash?: string | null;
	networkFeeAtomic?: string | null; messageNonce?: string | null; mintedAmountAtomic?: string | null;
	lastErrorCode?: string | null;
}): Promise<void> {
	await run(env, `UPDATE crosschain_operations SET status = ?, message = COALESCE(?, message), attestation = COALESCE(?, attestation),
		destination_tx_hash = COALESCE(?, destination_tx_hash), network_fee_atomic = COALESCE(?, network_fee_atomic),
		message_nonce = COALESCE(?, message_nonce), minted_amount_atomic = COALESCE(?, minted_amount_atomic),
		last_error_code = ?,
		next_attempt_at = ?, updated_at = ? WHERE op_id = ?`,
		[fields.status, fields.message ?? null, fields.attestation ?? null, fields.destinationTxHash ?? null,
			fields.networkFeeAtomic ?? null, fields.messageNonce ?? null, fields.mintedAmountAtomic ?? null,
			fields.lastErrorCode ?? null,
			new Date(Date.now() + 30_000).toISOString(), nowIso(), opId]);
}

export async function recordCrosschainMintPrepared(env: Bindings, input: {
	opId: string; txHash: string; rawTransaction: string; signerAddress: Address; nonce: number;
}): Promise<boolean> {
	const timestamp = nowIso();
	const results = await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`UPDATE crosschain_operations SET destination_tx_hash = ?, mint_raw_transaction = ?,
			 mint_signer_address = ?, mint_nonce = ?, attempt_count = attempt_count + 1,
			 last_error_code = NULL, updated_at = ?
			 WHERE op_id = ? AND status = 'minting' AND destination_tx_hash IS NULL`,
		).bind(input.txHash.toLowerCase(), input.rawTransaction, input.signerAddress.toLowerCase(),
			input.nonce, timestamp, input.opId),
		env.PAYMENTS_DB.prepare(
			`INSERT OR IGNORE INTO crosschain_mint_attempts(id, op_id, tx_hash, status, created_at, updated_at)
			 SELECT ?, op_id, ?, 'prepared', ?, ? FROM crosschain_operations
			 WHERE op_id = ? AND destination_tx_hash = ?`,
		).bind(`cma_${crypto.randomUUID().replaceAll("-", "")}`, input.txHash.toLowerCase(),
			timestamp, timestamp, input.opId, input.txHash.toLowerCase()),
	]);
	return changed(results[0]);
}

export async function recordCrosschainMintBroadcast(env: Bindings, opId: string, txHash: string): Promise<void> {
	const timestamp = nowIso();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`UPDATE crosschain_operations SET mint_broadcast_at = COALESCE(mint_broadcast_at, ?), updated_at = ?
			 WHERE op_id = ? AND destination_tx_hash = ? AND status = 'minting'`,
		).bind(timestamp, timestamp, opId, txHash.toLowerCase()),
		env.PAYMENTS_DB.prepare(
			`UPDATE crosschain_mint_attempts SET status = 'broadcast', updated_at = ?
			 WHERE op_id = ? AND tx_hash = ?`,
		).bind(timestamp, opId, txHash.toLowerCase()),
	]);
}

export async function recordCrosschainMintResult(env: Bindings, opId: string, txHash: string,
	status: "pending" | "success" | "reverted" | "unknown"): Promise<void> {
	const timestamp = nowIso();
	await run(env,
		`INSERT INTO crosschain_mint_attempts(id, op_id, tx_hash, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(tx_hash) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
		[`cma_${crypto.randomUUID().replaceAll("-", "")}`, opId, txHash.toLowerCase(), status,
			timestamp, timestamp]);
}

export async function clearRevertedCrosschainMint(env: Bindings, opId: string, txHash: string): Promise<void> {
	const timestamp = nowIso();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`UPDATE crosschain_mint_attempts SET status = 'reverted', updated_at = ?
			 WHERE op_id = ? AND tx_hash = ?`,
		).bind(timestamp, opId, txHash.toLowerCase()),
		env.PAYMENTS_DB.prepare(
			`UPDATE crosschain_operations SET destination_tx_hash = NULL, mint_raw_transaction = NULL,
			 mint_signer_address = NULL, mint_nonce = NULL, mint_broadcast_at = NULL,
			 last_error_code = 'CCTP_MINT_REVERTED', next_attempt_at = ?, updated_at = ?
			 WHERE op_id = ? AND status = 'minting' AND destination_tx_hash = ?`,
		).bind(new Date(Date.now() + 30_000).toISOString(), timestamp, opId, txHash.toLowerCase()),
	]);
}

export async function getAttemptByIdempotency(env: Bindings, input: {
	intentId: string; payerAddress: Address; sourceChainId: number; idempotencyKey: string;
}): Promise<PaymentAttempt | null> {
	const row = await first<AttemptRow>(env,
		`SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE intent_id = ? AND payer_address = ? AND source_chain_id = ? AND idempotency_key = ? LIMIT 1`,
		[input.intentId, input.payerAddress, input.sourceChainId, input.idempotencyKey]);
	return row ? mapAttempt(row) : null;
}

const ATTEMPT_EVIDENCE_GRACE_SECONDS = 15 * 60;

export async function releaseExpiredPayerDefinedAmount(env: Bindings, intentId: string): Promise<void> {
	const timestamp = nowIso();
	const nowSeconds = Math.floor(Date.now() / 1000);
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_attempts SET status = 'expired', last_error_code = 'PAYMENT_EVIDENCE_TIMEOUT', updated_at = ?
			 WHERE intent_id = ? AND status = 'reserved' AND valid_until < ?`,
		).bind(timestamp, intentId, nowSeconds - ATTEMPT_EVIDENCE_GRACE_SECONDS),
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_attempts SET status = 'expired', last_error_code = 'PAYMENT_EVIDENCE_TIMEOUT', updated_at = ?
			 WHERE intent_id = ? AND status = 'submitted' AND valid_until < ?`,
		).bind(timestamp, intentId, nowSeconds - ATTEMPT_EVIDENCE_GRACE_SECONDS),
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_intents SET amount = '0', amount_atomic = '0', updated_at = ?
			 WHERE id = ? AND amount_mode = 'payer_defined' AND status = 'awaiting_payment'
			 AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE intent_id = ? AND status IN ('reserved','submitted','processing'))`,
		).bind(timestamp, intentId, intentId),
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_links SET amount = '0', updated_at = ? WHERE intent_id = ?
			 AND EXISTS (SELECT 1 FROM payment_intents WHERE id = ? AND amount_mode = 'payer_defined' AND amount_atomic = '0')`,
		).bind(timestamp, intentId, intentId),
	]);
}

function feeLedgerStatements(env: Bindings, attempt: PaymentAttempt): D1PreparedStatement[] {
	const timestamp = attempt.createdAt;
	const platformQuoted = BigInt(attempt.platformFeeAtomic);
	const networkQuoted = BigInt(attempt.cctpFeeAtomic);
	return [
		env.PAYMENTS_DB.prepare(
			`INSERT OR IGNORE INTO payment_fee_ledger(id, attempt_id, intent_id, fee_type, bearer,
			 quoted_amount_atomic, actual_amount_atomic, recipient, status, policy_id, policy_version,
			 rule_id, source_chain_id, route, created_at, updated_at)
			 VALUES (?, ?, ?, 'platform', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(`fee_${attempt.id}_platform`, attempt.id, attempt.intentId, attempt.platformFeeBearer,
			attempt.platformFeeAtomic, platformQuoted === 0n ? "0" : null, attempt.platformFeeRecipient,
			platformQuoted === 0n ? "waived" : "quoted", attempt.feePolicyId, attempt.feePolicyVersion,
			attempt.feeRuleId, attempt.sourceChainId, attempt.route, timestamp, timestamp),
		env.PAYMENTS_DB.prepare(
			`INSERT OR IGNORE INTO payment_fee_ledger(id, attempt_id, intent_id, fee_type, bearer,
			 quoted_amount_atomic, actual_amount_atomic, recipient, status, policy_id, policy_version,
			 rule_id, source_chain_id, route, created_at, updated_at)
			 VALUES (?, ?, ?, 'network', ?, ?, ?, NULL, ?, 'circle-cctp-v2', 1, ?, ?, ?, ?, ?)`,
		).bind(`fee_${attempt.id}_network`, attempt.id, attempt.intentId,
			networkQuoted === 0n ? "none" : "payer", attempt.cctpFeeAtomic,
			networkQuoted === 0n ? "0" : null, networkQuoted === 0n ? "waived" : "quoted",
			attempt.route, attempt.sourceChainId, attempt.route, timestamp, timestamp),
	];
}

function feeLine(row: FeeLedgerRow): PaymentFeeLine {
	return { type: row.fee_type, bearer: row.bearer, quotedAmountAtomic: row.quoted_amount_atomic,
		actualAmountAtomic: row.actual_amount_atomic, recipient: row.recipient, status: row.status,
		policyId: row.policy_id, policyVersion: row.policy_version, ruleId: row.rule_id };
}

function feeBreakdown(rows: FeeLedgerRow[]): PaymentFeeBreakdown | null {
	const platformRow = rows.find((row) => row.fee_type === "platform");
	const networkRow = rows.find((row) => row.fee_type === "network");
	if (!platformRow || !networkRow) return null;
	const platform = feeLine(platformRow);
	const network = feeLine(networkRow);
	const actualKnown = platform.actualAmountAtomic !== null && network.actualAmountAtomic !== null;
	return { currency: "USDC", platform, network,
		totalQuotedAtomic: (BigInt(platform.quotedAmountAtomic) + BigInt(network.quotedAmountAtomic)).toString(),
		totalActualAtomic: actualKnown
			? (BigInt(platform.actualAmountAtomic!) + BigInt(network.actualAmountAtomic!)).toString()
			: null };
}

function actualFeeBreakdown(attempt: PaymentAttempt, platformActual: string, networkActual: string): PaymentFeeBreakdown {
	const platformValue = BigInt(platformActual);
	const networkValue = BigInt(networkActual);
	return {
		currency: "USDC",
		platform: { type: "platform", bearer: attempt.platformFeeBearer,
			quotedAmountAtomic: attempt.platformFeeAtomic, actualAmountAtomic: platformActual,
			recipient: attempt.platformFeeRecipient, status: platformValue === 0n ? "waived" : "charged",
			policyId: attempt.feePolicyId, policyVersion: attempt.feePolicyVersion, ruleId: attempt.feeRuleId },
		network: { type: "network", bearer: networkValue === 0n ? "none" : "payer",
			quotedAmountAtomic: attempt.cctpFeeAtomic, actualAmountAtomic: networkActual,
			recipient: null, status: networkValue === 0n ? "waived" : "charged",
			policyId: "circle-cctp-v2", policyVersion: 1, ruleId: attempt.route },
		totalQuotedAtomic: (BigInt(attempt.platformFeeAtomic) + BigInt(attempt.cctpFeeAtomic)).toString(),
		totalActualAtomic: (platformValue + networkValue).toString(),
	};
}

function freeFeeBreakdown(): PaymentFeeBreakdown {
	const freeLine = (type: "platform" | "network", policyId: string): PaymentFeeLine => ({
		type, bearer: "none", quotedAmountAtomic: "0", actualAmountAtomic: "0", recipient: null,
		status: "waived", policyId, policyVersion: 1, ruleId: "free-default",
	});
	return { currency: "USDC", platform: freeLine("platform", "free-default"),
		network: freeLine("network", "sandbox"), totalQuotedAtomic: "0", totalActualAtomic: "0" };
}

async function getAttemptFeeBreakdown(env: Bindings, attemptId: string): Promise<PaymentFeeBreakdown | null> {
	const rows = await env.PAYMENTS_DB.prepare(
		`SELECT fee_type, bearer, quoted_amount_atomic, actual_amount_atomic, recipient, status,
		 policy_id, policy_version, rule_id FROM payment_fee_ledger WHERE attempt_id = ? ORDER BY fee_type`,
	).bind(attemptId).all<FeeLedgerRow>();
	return feeBreakdown(rows.results);
}

export async function getPaymentIntentFeeBreakdown(env: Bindings, intentId: string): Promise<PaymentFeeBreakdown | null> {
	const attempt = await first<{ id: string }>(env,
		"SELECT id FROM payment_attempts WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1", [intentId]);
	return attempt ? getAttemptFeeBreakdown(env, attempt.id) : null;
}

export async function recordAttemptFeeEvidence(env: Bindings, input: {
	attemptId: string;
	platformFeeAtomic: string;
	networkFeeAtomic?: string;
	chargedTxHash: string;
}): Promise<void> {
	const attempt = await getAttempt(env, input.attemptId);
	if (!attempt) throw new Error("Payment attempt is missing for fee evidence");
	const platformActual = BigInt(input.platformFeeAtomic);
	if (platformActual !== BigInt(attempt.platformFeeAtomic)) {
		throw new Error("Actual platform fee does not match the signed attempt");
	}
	const networkActual = input.networkFeeAtomic === undefined ? null : BigInt(input.networkFeeAtomic);
	if (networkActual !== null && (networkActual < 0n || networkActual > BigInt(attempt.cctpFeeAtomic))) {
		throw new Error("Actual network fee exceeds the signed quote");
	}
	const timestamp = nowIso();
	const statements = [
		env.PAYMENTS_DB.prepare(
			`UPDATE payment_fee_ledger SET actual_amount_atomic = ?, status = ?, charged_tx_hash = ?, updated_at = ?
			 WHERE attempt_id = ? AND fee_type = 'platform'`,
		).bind(platformActual.toString(), platformActual === 0n ? "waived" : "charged",
			input.chargedTxHash.toLowerCase(), timestamp, attempt.id),
	];
	if (networkActual !== null) statements.push(env.PAYMENTS_DB.prepare(
			`UPDATE payment_fee_ledger SET actual_amount_atomic = ?, status = ?, charged_tx_hash = ?, updated_at = ?
			 WHERE attempt_id = ? AND fee_type = 'network'`,
		).bind(networkActual.toString(), networkActual === 0n ? "waived" : "charged",
			input.chargedTxHash.toLowerCase(), timestamp, attempt.id));
	await env.PAYMENTS_DB.batch(statements);
}

export async function insertQuoteAndAttempt(env: Bindings, input: {
	quote: PaymentQuote; attempt: PaymentAttempt; idempotencyKey: string;
}): Promise<PaymentAttempt> {
	try {
		await env.PAYMENTS_DB.batch([
			env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_quotes(id, intent_id, payer, source_chain_id, route, settlement_amount_atomic,
			 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id, fee_policy_version,
			 fee_rule_id, platform_fee_bps, platform_fee_bearer, platform_fee_recipient, route_fee_cap_bps,
			 fee_source, fee_observed_at, expires_at, quote_hash, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(input.quote.id, input.quote.intentId, input.quote.payer, input.quote.sourceChainId,
			input.quote.route, input.quote.settlementAmountAtomic, input.quote.platformFeeAtomic,
			input.quote.cctpFeeAtomic, input.quote.grossPayerAmountAtomic, input.quote.feePolicyId,
			input.quote.feePolicyVersion, input.quote.feeRuleId, input.quote.platformFeeBps,
			input.quote.platformFeeBearer, input.quote.platformFeeRecipient, input.quote.routeFeeCapBps,
			input.quote.feeSource,
			input.quote.feeObservedAt, input.quote.expiresAt, input.quote.quoteHash, input.quote.createdAt),
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_attempts(id, attempt_hash, intent_id, quote_id, payer_uid, payer_address,
			 idempotency_key, source_chain_id, route, status, router_address, authorization_hash,
			 authorization_json, signature, checkout_capability_hash, payer_proof_signature,
			 payer_proof_message_hash, valid_after, valid_until, settlement_amount_atomic,
			 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id,
			 fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer,
			 platform_fee_recipient, route_fee_cap_bps, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(input.attempt.id, input.attempt.attemptHash, input.attempt.intentId, input.attempt.quoteId,
			input.attempt.payerUid, input.attempt.payerAddress, input.idempotencyKey, input.attempt.sourceChainId,
			input.attempt.route, input.attempt.routerAddress, input.attempt.authorizationHash,
			JSON.stringify(input.attempt.authorization), input.attempt.signature, null, null, null, input.attempt.validAfter,
			input.attempt.validUntil, input.attempt.settlementAmountAtomic, input.attempt.platformFeeAtomic,
			input.attempt.cctpFeeAtomic, input.attempt.grossPayerAmountAtomic, input.attempt.feePolicyId,
			input.attempt.feePolicyVersion, input.attempt.feeRuleId, input.attempt.platformFeeBps,
			input.attempt.platformFeeBearer, input.attempt.platformFeeRecipient, input.attempt.routeFeeCapBps,
			input.attempt.createdAt, input.attempt.updatedAt),
		...feeLedgerStatements(env, input.attempt),
		]);
	} catch (error) {
		const replay = await getAttemptByIdempotency(env, { intentId: input.attempt.intentId,
			payerAddress: input.attempt.payerAddress, sourceChainId: input.attempt.sourceChainId,
			idempotencyKey: input.idempotencyKey });
		if (replay) return replay;
		throw error;
	}
	const stored = await getAttempt(env, input.attempt.id);
	if (!stored) throw new Error("Payment attempt creation was not durable");
	return stored;
}

export async function insertAttempt(env: Bindings, input: {
	attempt: PaymentAttempt; idempotencyKey: string;
	checkoutAccess?: {
		capabilityHash: `0x${string}`;
		payerProofSignature: `0x${string}`;
		payerProofMessageHash: `0x${string}`;
	};
}): Promise<PaymentAttempt> {
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			`INSERT INTO payment_attempts(id, attempt_hash, intent_id, quote_id, payer_uid, payer_address,
			 idempotency_key, source_chain_id, route, status, router_address, authorization_hash,
			 authorization_json, signature, checkout_capability_hash, payer_proof_signature,
			 payer_proof_message_hash, valid_after, valid_until, settlement_amount_atomic,
			 platform_fee_atomic, cctp_fee_atomic, gross_payer_amount_atomic, fee_policy_id,
			 fee_policy_version, fee_rule_id, platform_fee_bps, platform_fee_bearer,
			 platform_fee_recipient, route_fee_cap_bps, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(input.attempt.id, input.attempt.attemptHash, input.attempt.intentId, input.attempt.quoteId,
			input.attempt.payerUid, input.attempt.payerAddress, input.idempotencyKey, input.attempt.sourceChainId,
			input.attempt.route, input.attempt.routerAddress, input.attempt.authorizationHash,
			JSON.stringify(input.attempt.authorization), input.attempt.signature,
			input.checkoutAccess?.capabilityHash.toLowerCase() ?? null,
			input.checkoutAccess?.payerProofSignature ?? null,
			input.checkoutAccess?.payerProofMessageHash ?? null,
			input.attempt.validAfter,
			input.attempt.validUntil, input.attempt.settlementAmountAtomic, input.attempt.platformFeeAtomic,
			input.attempt.cctpFeeAtomic, input.attempt.grossPayerAmountAtomic, input.attempt.feePolicyId,
			input.attempt.feePolicyVersion, input.attempt.feeRuleId, input.attempt.platformFeeBps,
			input.attempt.platformFeeBearer, input.attempt.platformFeeRecipient, input.attempt.routeFeeCapBps,
			input.attempt.createdAt, input.attempt.updatedAt),
		...feeLedgerStatements(env, input.attempt),
	]);
	const stored = await getAttempt(env, input.attempt.id);
	if (!stored) throw new Error("Payment attempt creation was not durable");
	return stored;
}

export async function registerAppExecution(env: Bindings, command: RegisterAppPaymentExecutionCommand): Promise<RegisteredAppPaymentExecution | null> {
	const replay = await first<{ attempt_id: string; user_op_hash: string }>(env,
		"SELECT attempt_id, user_op_hash FROM app_execution_commands WHERE command_id = ? LIMIT 1", [command.commandId]);
	if (replay) {
		const attempt = await getAttempt(env, replay.attempt_id);
		return attempt ? { attemptId: attempt.id, status: attempt.status === "reserved" ? "submitted" : attempt.status as "submitted" | "processing" | "paid", userOpHash: replay.user_op_hash, idempotentReplay: true } : null;
	}
	const attempt = await getAttempt(env, command.attemptId);
	if (!attempt || attempt.sourceChainId !== command.sourceChainId) return null;
	if (attempt.userOpHash && attempt.userOpHash.toLowerCase() !== command.userOpHash.toLowerCase()) return null;
	const timestamp = nowIso();
	await env.PAYMENTS_DB.batch([
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_attempts SET status = CASE WHEN status = 'reserved' THEN 'submitted' ELSE status END, user_op_hash = COALESCE(user_op_hash, ?), updated_at = ? WHERE id = ? AND status IN ('reserved','submitted','processing','paid')",
		).bind(command.userOpHash.toLowerCase(), timestamp, attempt.id),
		env.PAYMENTS_DB.prepare(
			"INSERT INTO app_execution_commands(command_id, attempt_id, user_op_hash, created_at) VALUES (?, ?, ?, ?)",
		).bind(command.commandId, attempt.id, command.userOpHash.toLowerCase(), timestamp),
	]);
	const stored = await getAttempt(env, attempt.id);
	if (!stored) return null;
	return { attemptId: stored.id, status: stored.status === "reserved" ? "submitted" : stored.status as "submitted" | "processing" | "paid", userOpHash: command.userOpHash.toLowerCase(), idempotentReplay: false };
}

export async function registerSourceTransaction(env: Bindings, input: {
	attemptId: string; capabilityHash: `0x${string}`; txHash: string;
}): Promise<PaymentAttempt | null> {
	const timestamp = nowIso();
	const txHash = input.txHash.toLowerCase();
	const capabilityHash = input.capabilityHash.toLowerCase() as `0x${string}`;
	const result = await env.PAYMENTS_DB.prepare(
		`UPDATE payment_attempts SET source_tx_hash = COALESCE(source_tx_hash, ?),
		 status = CASE WHEN status = 'reserved' THEN 'submitted' ELSE status END, updated_at = ?
		 WHERE id = ? AND checkout_capability_hash = ?
		 AND status IN ('reserved','submitted','processing','paid','overpaid')
		 AND (source_tx_hash IS NULL OR source_tx_hash = ?)`,
	).bind(txHash, timestamp, input.attemptId, capabilityHash, txHash).run();
	if (!changed(result)) return null;
	return getCheckoutAttempt(env, input.attemptId, capabilityHash);
}

export async function cancelAttempt(env: Bindings, input: {
	attemptId: string; capabilityHash: `0x${string}`;
}): Promise<boolean> {
	const result = await env.PAYMENTS_DB.prepare(
		`UPDATE payment_attempts SET status = 'canceled', updated_at = ?
		 WHERE id = ? AND checkout_capability_hash = ? AND status = 'reserved'
		 AND source_tx_hash IS NULL AND user_op_hash IS NULL`,
	).bind(nowIso(), input.attemptId, input.capabilityHash.toLowerCase()).run();
	return changed(result);
}

export async function settleAttempt(env: Bindings, input: {
	attemptId: string; sourceTxHash: string; destinationTxHash?: string | null; settledAmountAtomic: string;
	payerAddress: Address; platformFeeAtomic?: string; networkFeeAtomic?: string;
}): Promise<{ applied: boolean; intent: PaymentIntent | null; eventId: string | null }> {
	const initialAttempt = await getAttempt(env, input.attemptId);
	if (!initialAttempt) return { applied: false, intent: null, eventId: null };
	const eventId = `evt_${initialAttempt.id}`;
	const initialIntent = await getPaymentIntent(env, initialAttempt.intentId);
	if (!initialIntent) return { applied: false, intent: null, eventId: null };
	if (initialAttempt.status === "paid" || initialAttempt.status === "overpaid") {
		return { applied: false, intent: initialIntent, eventId };
	}
	const settledAmount = BigInt(input.settledAmountAtomic);
	if (settledAmount <= 0n) throw new Error("Settled amount must be positive");
	const platformFeeAtomic = input.platformFeeAtomic ?? initialAttempt.platformFeeAtomic;
	if (initialAttempt.route !== "local" && input.networkFeeAtomic === undefined) {
		throw new Error("Actual CCTP network fee is required before settlement");
	}
	const networkFeeAtomic = input.networkFeeAtomic ?? "0";
	await recordAttemptFeeEvidence(env, { attemptId: initialAttempt.id, platformFeeAtomic, networkFeeAtomic,
		chargedTxHash: input.sourceTxHash });
	const fees = actualFeeBreakdown(initialAttempt, platformFeeAtomic, networkFeeAtomic);

	for (let retry = 0; retry < 5; retry += 1) {
		const attempt = await getAttempt(env, input.attemptId);
		if (!attempt) return { applied: false, intent: null, eventId: null };
		const intent = await getPaymentIntent(env, attempt.intentId);
		if (!intent) return { applied: false, intent: null, eventId: null };
		if (attempt.status === "paid" || attempt.status === "overpaid") {
			return { applied: false, intent, eventId };
		}
		if (!(["reserved", "submitted", "processing"] as PaymentAttemptStatus[]).includes(attempt.status)) {
			return { applied: false, intent, eventId };
		}

		const previousPaid = BigInt(intent.paidAmountAtomic);
		const firstOpenSettlement = intent.amountMode === "payer_defined" && previousPaid === 0n;
		const expected = firstOpenSettlement ? BigInt(attempt.settlementAmountAtomic) : BigInt(intent.amountAtomic);
		const paid = previousPaid + settledAmount;
		const overpaid = paid > expected ? paid - expected : 0n;
		const status = paid > expected ? "overpaid" : "paid";
		const eventType = status === "overpaid" ? "payment.overpaid" : "payment.paid";
		const canonicalAmount = firstOpenSettlement ? formatUnits(expected, 6) : intent.amount;
		const timestamp = nowIso();
		const settlementTxHash = (input.destinationTxHash ?? input.sourceTxHash).toLowerCase();
		const commitId = `stc_${crypto.randomUUID()}`;
		const payload = JSON.stringify({ id: intent.id, object: "payment_intent", status,
			amount: canonicalAmount, currency: intent.currency, reference: intent.reference,
			metadata: intent.metadata, expected_amount_atomic: expected.toString(),
			settled_amount_atomic: settledAmount.toString(), paid_amount_atomic: paid.toString(),
			overpaid_amount_atomic: overpaid.toString(), source_tx_hash: input.sourceTxHash.toLowerCase(),
			destination_tx_hash: input.destinationTxHash?.toLowerCase() ?? null,
			fee_breakdown: publicFeeBreakdown(fees) });
		const endpoints = await env.PAYMENTS_DB.prepare(
			"SELECT id FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active' AND mode = ? AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = ?))",
		).bind(intent.merchantId, intent.mode, eventType).all<{ id: string }>();
		const commitExists = "EXISTS (SELECT 1 FROM payment_settlement_commits WHERE commit_id = ?)";
		const statements: D1PreparedStatement[] = [
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO payment_settlement_commits(commit_id, attempt_id, intent_id,
				 previous_paid_amount_atomic, settled_amount_atomic, resulting_paid_amount_atomic,
				 expected_amount_atomic, resulting_status, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (
					 SELECT 1 FROM payment_intents AS payment_intent
					 JOIN payment_attempts AS payment_attempt ON payment_attempt.intent_id = payment_intent.id
					 WHERE payment_intent.id = ? AND payment_intent.paid_amount_atomic = ?
					 AND payment_intent.status IN ('awaiting_payment','processing','paid','overpaid','canceled')
					 AND payment_attempt.id = ? AND payment_attempt.status IN ('reserved','submitted','processing')
				 )`,
			).bind(commitId, attempt.id, intent.id, previousPaid.toString(), settledAmount.toString(),
				paid.toString(), expected.toString(), status, timestamp, intent.id,
				previousPaid.toString(), attempt.id),
			env.PAYMENTS_DB.prepare(
				`UPDATE payment_attempts SET status = ?, source_tx_hash = COALESCE(source_tx_hash, ?),
				 destination_tx_hash = COALESCE(destination_tx_hash, ?), settled_amount_atomic = ?, updated_at = ?
				 WHERE id = ? AND ${commitExists}`,
			).bind(status, input.sourceTxHash.toLowerCase(), input.destinationTxHash?.toLowerCase() ?? null,
				settledAmount.toString(), timestamp, attempt.id, commitId),
			env.PAYMENTS_DB.prepare(
				`UPDATE payment_intents SET amount = ?, amount_atomic = ?, status = ?, paid_amount_atomic = ?,
				 paid_tx_hash = COALESCE(paid_tx_hash, ?), paid_at = COALESCE(paid_at, ?), updated_at = ?
				 WHERE id = ? AND ${commitExists}`,
			).bind(canonicalAmount, expected.toString(), status, paid.toString(), settlementTxHash,
				timestamp, timestamp, intent.id, commitId),
			env.PAYMENTS_DB.prepare(
				`UPDATE payment_links SET amount = CASE WHEN amount = '0' THEN ? ELSE amount END,
				 status = 'paid', tx_hash = COALESCE(tx_hash, ?), paid_at = COALESCE(paid_at, ?),
				 paid_by = COALESCE(paid_by, ?), updated_at = ? WHERE intent_id = ? AND ${commitExists}`,
			).bind(canonicalAmount, settlementTxHash, timestamp, input.payerAddress, timestamp, intent.id, commitId),
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at)
				 SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${commitExists}`,
			).bind(eventId, intent.merchantId, eventType, intent.id, `settlement:${attempt.id}`,
				intent.mode, payload, timestamp, commitId),
			env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO payment_outbox(id, topic, resource_id, payload, status,
				 next_attempt_at, created_at, updated_at)
				 SELECT ?, 'webhook_delivery', ?, ?, 'pending', ?, ?, ? WHERE ${commitExists}`,
			).bind(`out_${eventId}`, eventId, JSON.stringify({ eventId }), timestamp, timestamp, timestamp, commitId),
		];
		for (const endpoint of endpoints.results) {
			statements.push(env.PAYMENTS_DB.prepare(
				`INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status,
				 next_retry_at, created_at, updated_at)
				 SELECT ?, ?, ?, 'pending', ?, ?, ? WHERE ${commitExists}`,
			).bind(`whd_${eventId}_${endpoint.id}`, eventId, endpoint.id, timestamp, timestamp, timestamp, commitId));
		}
		const results = await env.PAYMENTS_DB.batch(statements);
		if (changed(results[0])) {
			return { applied: true, intent: await getPaymentIntent(env, intent.id), eventId };
		}
	}

	const latestAttempt = await getAttempt(env, input.attemptId);
	const latestIntent = latestAttempt ? await getPaymentIntent(env, latestAttempt.intentId) : null;
	if (latestAttempt?.status === "paid" || latestAttempt?.status === "overpaid") {
		return { applied: false, intent: latestIntent, eventId };
	}
	throw new Error("Payment settlement compare-and-set retries were exhausted");
}

export async function simulatePaymentIntent(env: Bindings, merchantId: string, id: string): Promise<PaymentIntent | null> {
	const intent = await getPaymentIntent(env, id);
	if (!intent || intent.merchantId !== merchantId || intent.mode !== "test" || intent.status !== "awaiting_payment") return null;
	const timestamp = nowIso();
	const eventId = `evt_sandbox_${intent.id}`;
	const txHash = `sandbox_${intent.id}`;
	const payload = JSON.stringify({ ...publicIntent(intent), status: "paid", tx_hash: txHash,
		paid_amount_atomic: intent.amountAtomic, paid_at: timestamp, simulated: true,
		fee_breakdown: publicFeeBreakdown(freeFeeBreakdown()) });
	const endpoints = await env.PAYMENTS_DB.prepare(
		"SELECT id FROM webhook_endpoints WHERE merchant_id = ? AND status = 'active' AND mode = 'test' AND (enabled_events IS NULL OR EXISTS (SELECT 1 FROM json_each(enabled_events) WHERE value = 'payment.paid'))",
	).bind(merchantId).all<{ id: string }>();
	const statements: D1PreparedStatement[] = [
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_intents SET status = 'paid', paid_amount_atomic = amount_atomic, paid_tx_hash = ?, paid_at = ?, updated_at = ? WHERE id = ? AND merchant_id = ? AND mode = 'test' AND status = 'awaiting_payment'",
		).bind(txHash, timestamp, timestamp, intent.id, merchantId),
		env.PAYMENTS_DB.prepare(
			"UPDATE payment_links SET status = 'paid', tx_hash = ?, paid_at = ?, paid_by = 'sandbox', updated_at = ? WHERE intent_id = ? AND status = 'pending'",
		).bind(txHash, timestamp, timestamp, intent.id),
		env.PAYMENTS_DB.prepare(
			"INSERT OR IGNORE INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at) VALUES (?, ?, 'payment.paid', ?, ?, 'test', ?, ?)",
		).bind(eventId, merchantId, intent.id, `sandbox:${intent.id}:paid`, payload, timestamp),
		env.PAYMENTS_DB.prepare(
			"INSERT OR IGNORE INTO payment_outbox(id, topic, resource_id, payload, status, next_attempt_at, created_at, updated_at) VALUES (?, 'webhook_delivery', ?, ?, 'pending', ?, ?, ?)",
		).bind(`out_${eventId}`, eventId, JSON.stringify({ eventId }), timestamp, timestamp, timestamp),
	];
	for (const endpoint of endpoints.results) statements.push(env.PAYMENTS_DB.prepare(
		"INSERT OR IGNORE INTO webhook_deliveries(id, event_id, endpoint_id, status, next_retry_at, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
	).bind(`whd_${eventId}_${endpoint.id}`, eventId, endpoint.id, timestamp, timestamp, timestamp));
	const results = await env.PAYMENTS_DB.batch(statements);
	return changed(results[0]) ? getPaymentIntent(env, intent.id) : null;
}

export function publicIntent(intent: PaymentIntent): Record<string, unknown> {
	const unconfirmedOpenAmount = intent.amountMode === "payer_defined" && intent.paidAmountAtomic === "0";
	const publicAmount = unconfirmedOpenAmount ? "0" : intent.amount;
	const publicAmountAtomic = unconfirmedOpenAmount ? "0" : intent.amountAtomic;
	const expected = BigInt(publicAmountAtomic);
	const paid = BigInt(intent.paidAmountAtomic);
	return { id: intent.id, object: "payment_intent", amount: publicAmount, amount_atomic: publicAmountAtomic,
		amount_mode: intent.amountMode,
		currency: intent.currency, reference: intent.reference, metadata: intent.metadata, status: intent.status,
		mode: intent.mode, tx_hash: intent.paidTxHash, paid_at: intent.paidAt,
		paid_amount_atomic: intent.paidAmountAtomic,
		overpaid_amount_atomic: paid > expected ? (paid - expected).toString() : "0",
		settlement_chain_id: intent.settlementChainId, expires_at: intent.expiresAt,
		created_at: intent.createdAt, updated_at: intent.updatedAt };
}

export function publicFeeBreakdown(fees: PaymentFeeBreakdown | null): Record<string, unknown> | null {
	if (!fees) return null;
	const line = (value: PaymentFeeLine) => ({ type: value.type, bearer: value.bearer,
		quoted_amount_atomic: value.quotedAmountAtomic, actual_amount_atomic: value.actualAmountAtomic,
		recipient: value.recipient, status: value.status, policy_id: value.policyId,
		policy_version: value.policyVersion, rule_id: value.ruleId });
	return { currency: fees.currency, platform: line(fees.platform), network: line(fees.network),
		total_quoted_atomic: fees.totalQuotedAtomic, total_actual_atomic: fees.totalActualAtomic };
}

export function publicLink(link: PaymentLink): Record<string, unknown> {
	return { id: link.id, intentId: link.intentId, amount: link.amount, currency: link.currency,
		reference: link.reference, wallet: link.wallet, status: link.status, txHash: link.txHash,
		paidAt: link.paidAt, paidBy: link.paidBy, createdAt: link.createdAt };
}
