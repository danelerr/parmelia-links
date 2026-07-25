// Payment settlement + reconciliation.
//
// settlePayment() is THE single place a relayed UserOperation becomes ledger
// rows, a paid link, a settled intent and a push. The reconciler calls it after
// proving the operation's on-chain result. It is
// idempotent: ledger writes dedupe on the unique index, the link/intent flips
// are compare-and-set, and the push only fires for ledger rows that were
// actually inserted — so running it twice can never double-account or
// double-notify.
//
// getUserOpResult() closes a correctness hole of receipt-only checking: when an
// account's inner execution reverts (e.g. the balance dropped between prepare
// and submit), the EntryPoint still mines handleOps SUCCESSFULLY and emits
// UserOperationEvent(success=false). Trusting receipt.status alone would record
// a payment that never moved funds; the op's own event is the truth.

import { formatUnits, parseAbiItem, parseEventLogs, type Hex, type Log } from "viem";
import { getNetworkConfig, getTokenBySymbol } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import {
	getPaymentIntentByLinkId,
	getPaymentLinkById,
	getUserByWallet,
	listPendingPaymentsByStatus,
	releasePaymentLinkClaim,
	settlePaymentLinkWithOutbox,
	setPendingPaymentStatus,
	sweepRateLimits,
	sweepTerminalPendingPayments,
	updateCrosschainOp,
	updateSwapQuoteStatus,
	writeLedgerEntries,
	type LedgerEntry,
	type PendingPaymentRecord,
} from "./storage";
import { isStoredPaymentLink } from "./validation";
import { notifyUser } from "./push";
import { deliverPendingWebhooks, prepareEventOutbox } from "./webhooks";
import { logError, logInfo, logWarn } from "./logger";

// Pending ops that are account/DeFi actions rather than payments: they reuse
// the same sign+submit pipeline but must not be recorded as transfers.
export const NON_PAYMENT_CURRENCIES = new Set([
	"PASSKEY_ADD",
	"SWAP",
	"CROSSCHAIN",
	"EARN_DEPOSIT",
	"EARN_WITHDRAW",
]);

const USER_OPERATION_EVENT = parseAbiItem(
	"event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);
const ERC20_TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);

function transferredAmount(
	logs: Log[] | undefined,
	tokenAddress: string,
	account: string,
	direction: "in" | "out",
): bigint | null {
	if (!logs) return null;
	const normalizedToken = tokenAddress.toLowerCase();
	const normalizedAccount = account.toLowerCase();
	const events = parseEventLogs({ abi: [ERC20_TRANSFER_EVENT], logs, strict: false });
	let total = 0n;
	for (const event of events) {
		if (event.address.toLowerCase() !== normalizedToken) continue;
		const side = direction === "in" ? event.args.to : event.args.from;
		if (side?.toLowerCase() === normalizedAccount) total += event.args.value ?? 0n;
	}
	return total > 0n ? total : null;
}

/**
 * Extract THIS operation's outcome from a handleOps receipt. Returns null when
 * the receipt carries no UserOperationEvent for the hash (op not in this tx).
 */
export function getUserOpResult(
	logs: Log[],
	userOpHash: Hex,
): { success: boolean; actualGasCost: bigint } | null {
	const events = parseEventLogs({ abi: [USER_OPERATION_EVENT], logs, strict: false });
	const match = events.find(
		(e) => typeof e.args?.userOpHash === "string" && e.args.userOpHash.toLowerCase() === userOpHash.toLowerCase(),
	);
	if (!match || match.args?.success === undefined) return null;
	return { success: Boolean(match.args.success), actualGasCost: BigInt(match.args.actualGasCost ?? 0n) };
}

type SettleOpts = {
	/** Defer non-critical follow-ups past the response (route passes waitUntil). */
	waitUntil?: (p: Promise<unknown>) => void;
	receiptLogs?: Log[];
};

/**
 * Record everything a CONFIRMED payment implies. Money truth (the ledger) is
 * written first; each follow-up is guarded so one failure doesn't drop the
 * rest. Safe to re-run (see module header).
 */
export async function settlePayment(
	env: Bindings,
	pending: PendingPaymentRecord,
	txHash: string,
	opts: SettleOpts = {},
): Promise<void> {
	const deferred: Promise<void>[] = [];
	const defer = (p: Promise<unknown>) => {
		const handled = p.then(() => undefined).catch((error) => {
			logError("payment_settle_followup_failed", error, { userOpHash: pending.userOpHash });
		});
		if (opts.waitUntil) {
			try {
				opts.waitUntil(handled);
				return;
			} catch {
				/* No execution context: await the work before returning. */
			}
		}
		deferred.push(handled);
	};

	const createdAt = new Date().toISOString();
	const uid = pending.uid;
	const isAccountAction = NON_PAYMENT_CURRENCIES.has(pending.currency);
	const linkId = pending.linkId;
	const storedLink = !isAccountAction && isStoredPaymentLink(linkId) ? await getPaymentLinkById(env, linkId) : null;
	const linkReference = storedLink?.reference || null;

	// 1. Ledger (atomic batch; the dedup index absorbs re-runs).
	if (pending.currency === "SWAP") {
		const meta = pending.meta ?? {};
		const swapEntries: LedgerEntry[] = [];
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (typeof meta.tokenIn === "string" && typeof meta.amountIn === "string") {
			const inputToken = getTokenBySymbol(network, meta.tokenIn);
			const executedInput = inputToken?.address
				? transferredAmount(opts.receiptLogs, inputToken.address, pending.senderAddress, "out")
				: null;
			swapEntries.push({
				uid,
				direction: "out" as const,
				kind: "swap" as const,
				txHash,
				token: meta.tokenIn,
				amount: executedInput && inputToken ? formatUnits(executedInput, inputToken.decimals) : meta.amountIn,
				amountSource: executedInput || inputToken?.isNative ? "executed" : "estimated",
				counterparty: pending.senderAddress,
				reference: typeof meta.tokenOut === "string" ? `Cambio a ${meta.tokenOut}` : null,
				createdAt,
			});
		}
		if (typeof meta.tokenOut === "string" && typeof meta.amountOutEstimated === "string") {
			const outputToken = getTokenBySymbol(network, meta.tokenOut);
			const executedOutput = outputToken?.address
				? transferredAmount(opts.receiptLogs, outputToken.address, pending.senderAddress, "in")
				: null;
			swapEntries.push({
				uid,
				direction: "in" as const,
				kind: "swap" as const,
				txHash,
				token: meta.tokenOut,
				amount: executedOutput && outputToken
					? formatUnits(executedOutput, outputToken.decimals)
					: meta.amountOutEstimated,
				amountSource: executedOutput ? "executed" : "estimated",
				counterparty: pending.senderAddress,
				reference: typeof meta.tokenIn === "string" ? `Cambio desde ${meta.tokenIn}` : null,
				createdAt,
			});
		}
		if (swapEntries.length > 0) await writeLedgerEntries(env, swapEntries);
		if (typeof meta.quoteId === "string") {
			await updateSwapQuoteStatus(env, meta.quoteId, "executed");
		}
	} else if (pending.currency === "CROSSCHAIN") {
		const meta = pending.meta ?? {};
		const opId = typeof meta.opId === "string" ? meta.opId : null;
		if (opId) {
			// Repair the post-broadcast hand-off if the request died before it
			// advanced the CCTP row. Never demote an op already owned by the relayer.
			await updateCrosschainOp(
				env,
				opId,
				{ status: "submitted", sourceTxHash: txHash },
				{ ifStatusIn: ["quoted", "submitted"] },
			);
		}
		const amountInRaw = String(meta.amountIn ?? "0");
		await writeLedgerEntries(env, [
			{
				uid,
				direction: "out",
				kind: "payment",
				txHash,
				token: "USDC",
				amount: formatUnits(BigInt(amountInRaw), 6),
				counterparty: String(meta.recipient ?? ""),
				reference: "Envío a otra red",
				createdAt,
			},
		]);
	} else if (pending.currency === "EARN_DEPOSIT" || pending.currency === "EARN_WITHDRAW") {
		// Savings movement (Aave): the user's own money changing pockets. The
		// aToken on-chain is the position's source of truth; this row is only
		// statement history. deposit = leaves the available balance (out);
		// withdraw = returns to it (in).
		const isDeposit = pending.currency === "EARN_DEPOSIT";
		const meta = pending.meta ?? {};
		const network = getNetworkConfig(env.CHAIN_KEY);
		const executedAmount = transferredAmount(
			opts.receiptLogs,
			network.contracts.usdc,
			pending.senderAddress,
			isDeposit ? "out" : "in",
		);
		await writeLedgerEntries(env, [
			{
				uid,
				direction: isDeposit ? "out" : "in",
				kind: "earn",
				txHash,
				token: "USDC",
				amount: executedAmount
					? formatUnits(executedAmount, network.contracts.usdcDecimals)
					: pending.amount || "0",
				amountSource: executedAmount ? "executed" : "estimated",
				counterparty: typeof meta.pool === "string" ? meta.pool.toLowerCase() : null,
				reference: isDeposit ? "Depósito a ahorro" : "Retiro de ahorro",
				createdAt,
			},
		]);
	} else if (!isAccountAction) {
		const recipient = await getUserByWallet(env, pending.wallet || "");
		const entries: LedgerEntry[] = [
			{
				uid,
				direction: "out",
				kind: "payment",
				txHash,
				token: pending.currency || "USDC",
				amount: pending.amount || "0",
				counterparty: pending.wallet || null,
				counterpartyUid: recipient?.uid ?? null,
				reference: linkReference,
				linkId: isStoredPaymentLink(linkId) ? linkId : null,
				createdAt,
			},
		];
		const notifyRecipient = recipient && recipient.uid !== uid;
		if (notifyRecipient) {
			entries.push({
				uid: recipient.uid,
				direction: "in",
				kind: isStoredPaymentLink(linkId) ? "link" : "payment",
				txHash,
				token: pending.currency || "USDC",
				amount: pending.amount || "0",
				counterparty: pending.senderAddress || null,
				counterpartyUid: uid,
				reference: linkReference,
				linkId: isStoredPaymentLink(linkId) ? linkId : null,
				createdAt,
			});
		}
		const inserted = await writeLedgerEntries(env, entries);

		// "Te pagaron" push — ONLY when this run actually inserted the recipient's
		// row, so a reconciler re-run after a mid-request crash can't re-notify.
		if (notifyRecipient && inserted[1]) {
			defer(
				notifyUser(env, recipient.uid, {
					title: "Te pagaron",
					body: `Recibiste ${pending.amount} ${pending.currency}`,
					link: "/",
				}),
			);
		}
	}

	// 2. Link + backing intent settlement (compare-and-set: only flips from
	// 'pending' / 'awaiting_payment', so re-runs and payment races are inert).
	if (storedLink && isStoredPaymentLink(linkId)) {
		const intent = await getPaymentIntentByLinkId(env, linkId);
		const paidOutbox = intent
			? await prepareEventOutbox(env, {
				merchantId: intent.merchantId,
				mode: intent.mode,
				type: "payment.paid",
				objectId: intent.id,
				data: {
					id: intent.id,
					object: "payment_intent",
					status: "paid",
					amount: intent.amount,
					currency: intent.currency,
					reference: intent.reference,
					metadata: intent.metadata ?? {},
					tx_hash: txHash,
					mode: intent.mode,
				},
			})
			: null;
		const flipped = await settlePaymentLinkWithOutbox(env, {
			id: linkId,
			amount: pending.amount || storedLink.amount,
			txHash,
			paidAt: createdAt,
			paidBy: pending.senderAddress || "",
			claimOwner: pending.userOpHash,
			intentId: intent?.id,
			outbox: paidOutbox,
		});
		if (!flipped) {
			logWarn("payment_settle_link_already_paid", { uid, linkId, txHash });
		}
		if (intent) {
			defer(deliverPendingWebhooks(env));
		}
	}

	await Promise.all(deferred);
}

// ===== Reconciler (cron) =====
//
// Resolves payments stranded mid-flight by a Worker death: rows claimed for
// submit ('submitting') or broadcast ('submitted') whose live request never
// finished. The op is located ON-CHAIN by its userOpHash (UserOperationEvent),
// which is authoritative regardless of which handleOps tx carried it; found +
// success → settle exactly like the live path; found + !success → failed;
// not found after the paymaster validity window → it can never land → failed.

/** Leave fresh rows to their own live request before touching them. */
const RECONCILE_MIN_AGE_MS = 90_000;
/** After expires_at + this margin an unlanded op is dead (paymaster window). */
const EXPIRY_MARGIN_MS = 5 * 60_000;
/** How far back to scan for the op's event (Arbitrum ~250ms blocks ≫ TTL). */
const LOOKBACK_BLOCKS = 300_000n;

export async function runPaymentReconciler(env: Bindings): Promise<void> {
	try {
		if (!env.RPC_URL) return;
		const rows = await listPendingPaymentsByStatus(env, ["submitting", "submitted"], 25);
		for (const row of rows) {
			try {
				await reconcileOne(env, row);
			} catch (error) {
				logError("payment_reconcile_failed", error, { userOpHash: row.userOpHash });
			}
		}
		await sweepTerminalPendingPayments(env);
		await sweepRateLimits(env);
	} catch (error) {
		logError("payment_reconciler_failed", error, {});
	}
}

async function reconcileOne(env: Bindings, row: PendingPaymentRecord): Promise<void> {
	if (Date.now() - new Date(row.createdAt).getTime() < RECONCILE_MIN_AGE_MS) return;

	const publicClient = getPublicClient(env);
	let txHash = (row.submittedTxHash ?? null) as Hex | null;
	let success: boolean | null = null;
	let receiptLogs: Log[] | undefined;

	// Fast path: we know the broadcast tx — read its receipt.
	if (txHash) {
		try {
			const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
			receiptLogs = receipt.logs as Log[];
			const result = getUserOpResult(receipt.logs as Log[], row.userOpHash as Hex);
			// Mined without our op's event = the bundle landed but the op did not.
			success = result ? result.success : false;
		} catch {
			/* not mined / receipt unavailable → fall through to the event scan */
		}
	}

	// Authoritative path: find the op's event no matter which tx included it.
	if (success === null) {
		const { contracts } = getNetworkConfig(env.CHAIN_KEY);
		const latest = await publicClient.getBlockNumber();
		const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
		const logs = await publicClient.getLogs({
			address: contracts.entryPoint,
			event: USER_OPERATION_EVENT,
			args: { userOpHash: row.userOpHash as Hex },
			fromBlock,
			toBlock: latest,
		});
		const found = logs[0];
		if (found?.transactionHash) {
			txHash = found.transactionHash;
			success = Boolean(found.args.success);
			try {
				receiptLogs = (await publicClient.getTransactionReceipt({ hash: txHash })).logs as Log[];
			} catch {
				/* Settlement can still proceed and labels unverifiable values estimated. */
			}
		}
	}

	if (success === true && txHash) {
		await settlePayment(env, row, txHash, { receiptLogs });
		await setPendingPaymentStatus(env, row.userOpHash, "confirmed", txHash);
		logInfo("payment_reconciled", { userOpHash: row.userOpHash, txHash, uid: row.uid });
		return;
	}
	if (success === false) {
		await setPendingPaymentStatus(env, row.userOpHash, "failed", txHash);
		if (isStoredPaymentLink(row.linkId)) {
			await releasePaymentLinkClaim(env, row.linkId, row.userOpHash, true);
		}
		await failLinkedCrosschainOp(env, row, "userOp failed (reconciler)");
		logWarn("payment_reconciled_failed_op", { userOpHash: row.userOpHash, txHash, uid: row.uid });
		return;
	}
	// Never seen on-chain. Once the signed paymaster window is safely over, the
	// op can never validate again — close the row so the queue stays clean.
	if (Date.now() > new Date(row.expiresAt).getTime() + EXPIRY_MARGIN_MS) {
		await setPendingPaymentStatus(env, row.userOpHash, "failed");
		if (isStoredPaymentLink(row.linkId)) {
			await releasePaymentLinkClaim(env, row.linkId, row.userOpHash, true);
		}
		await failLinkedCrosschainOp(env, row, "burn never landed (reconciler)");
		logWarn("payment_expired_unlanded", { userOpHash: row.userOpHash, uid: row.uid });
	}
}

/**
 * A failed/unlanded CROSSCHAIN payment must also pull its CCTP op out of the
 * relayer's queue — otherwise the relayer polls Iris for a burn that never
 * happened until the 7-day TTL parks it as needs_support.
 */
async function failLinkedCrosschainOp(env: Bindings, row: PendingPaymentRecord, detail: string): Promise<void> {
	if (row.currency !== "CROSSCHAIN") return;
	const opId = typeof row.meta?.opId === "string" ? row.meta.opId : null;
	if (!opId) return;
	await updateCrosschainOp(env, opId, { status: "failed", statusDetail: detail }).catch(() => false);
}
