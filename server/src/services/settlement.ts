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

import { formatUnits, parseAbiItem, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { getNetworkConfig, getTokenBySymbol } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getRpcUrls } from "./clients";
import {
	claimPaymentReconcileRequest,
	completePaymentReconcileRequest,
	getPaymentIntentByLinkId,
	getPaymentLinkById,
	getPendingPaymentAnyState,
	getUserByWallet,
	listDuePaymentReconcileRequests,
	markPasskeyRevoked,
	releasePaymentLinkClaim,
	reschedulePaymentReconcileRequest,
	savePasskey,
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
import { prepareEventOutbox } from "./webhooks";
import { logError, logInfo, logWarn } from "./logger";
import { getUserOperationTransport } from "./userOperationTransport";
import { requestBalanceRefreshBatch } from "./balanceReadModel";
import { refreshWalletBalancesLatestBatch } from "./balanceReconciler";

// Pending ops that are account/DeFi actions rather than payments: they reuse
// the same sign+submit pipeline but must not be recorded as transfers.
export const NON_PAYMENT_CURRENCIES = new Set([
	"PASSKEY_ADD",
	"PASSKEY_REMOVE",
	"SWAP",
	"CROSSCHAIN",
	"EARN_DEPOSIT",
	"EARN_WITHDRAW",
]);

// Signer-management operations spend gas but do not move any user asset. A
// balance read after each passkey change adds RPC latency and load without
// changing a value the UI can display.
const BALANCE_NEUTRAL_CURRENCIES = new Set([
	"PASSKEY_ADD",
	"PASSKEY_REMOVE",
]);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

type ConfirmedBalanceRefreshContext = Pick<
	PendingPaymentRecord,
	"uid" | "senderAddress" | "wallet" | "currency"
>;

function confirmedBalanceRefreshTargets(
	pending: ConfirmedBalanceRefreshContext,
	recipientUid: string | null,
): Array<{ uid: string; accountAddress: Address }> {
	const targets = new Map<string, { uid: string; accountAddress: Address }>();
	const add = (uid: string | null, value: string | null | undefined) => {
		if (!uid || !value || !EVM_ADDRESS_RE.test(value)) return;
		const accountAddress = value.toLowerCase() as Address;
		targets.set(accountAddress, { uid, accountAddress });
	};

	if (!BALANCE_NEUTRAL_CURRENCIES.has(pending.currency)) {
		add(pending.uid, pending.senderAddress);
	}
	if (
		recipientUid &&
		recipientUid !== pending.uid &&
		!NON_PAYMENT_CURRENCIES.has(pending.currency)
	) {
		add(recipientUid, pending.wallet);
	}
	return [...targets.values()];
}

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
	receiptLogs?: Log[];
	chainEvidence?: {
		chainId: number;
		blockNumber: bigint;
		blockHash: string;
		transactionIndex: number | null;
		consistencyLevel: string;
		blockTimestamp: string | null;
	};
};

function attachChainEvidence(
	entries: LedgerEntry[],
	evidence: SettleOpts["chainEvidence"],
): LedgerEntry[] {
	if (!evidence) return entries;
	return entries.map((entry) => ({
		...entry,
		chainId: evidence.chainId,
		blockNumber: evidence.blockNumber,
		blockHash: evidence.blockHash,
		transactionIndex: evidence.transactionIndex,
		consistencyLevel: evidence.consistencyLevel,
		projectionVersion: 1,
	}));
}

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
	const createdAt =
		opts.chainEvidence?.blockTimestamp ?? new Date().toISOString();
	const uid = pending.uid;
	const isAccountAction = NON_PAYMENT_CURRENCIES.has(pending.currency);
	const linkId = pending.linkId;
	const storedLink = !isAccountAction && isStoredPaymentLink(linkId) ? await getPaymentLinkById(env, linkId) : null;
	const linkReference = storedLink?.reference || null;
	let recipientUidForBalanceRefresh: string | null = null;

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
		if (swapEntries.length > 0) {
			await writeLedgerEntries(
				env,
				attachChainEvidence(swapEntries, opts.chainEvidence),
			);
		}
		if (typeof meta.quoteId === "string") {
			await updateSwapQuoteStatus(env, meta.quoteId, "executed");
		}
	} else if (pending.currency === "PASSKEY_ADD") {
		const meta = pending.meta ?? {};
		if (
			typeof meta.credentialId !== "string" ||
			typeof meta.qx !== "string" ||
			typeof meta.qy !== "string"
		) {
			throw new Error("Confirmed passkey operation is missing registration metadata");
		}
		await savePasskey(env, {
			uid,
			credentialId: meta.credentialId,
			qx: meta.qx,
			qy: meta.qy,
			name: typeof meta.name === "string" ? meta.name : null,
			registrationSource: "backup",
			transports: Array.isArray(meta.transports)
				? meta.transports.filter((item): item is string => typeof item === "string")
				: [],
			rpId: typeof meta.rpId === "string" ? meta.rpId : null,
			aaguid: typeof meta.aaguid === "string" ? meta.aaguid : null,
			providerName: typeof meta.providerName === "string" ? meta.providerName : null,
			credentialDeviceType:
				meta.credentialDeviceType === "singleDevice" || meta.credentialDeviceType === "multiDevice"
					? meta.credentialDeviceType
					: null,
			credentialBackedUp: typeof meta.credentialBackedUp === "boolean"
				? meta.credentialBackedUp
				: null,
			authenticatorAttachment:
				meta.authenticatorAttachment === "platform" || meta.authenticatorAttachment === "cross-platform"
					? meta.authenticatorAttachment
					: null,
		});
	} else if (pending.currency === "PASSKEY_REMOVE") {
		const credentialId = pending.meta?.credentialId;
		if (typeof credentialId !== "string") {
			throw new Error("Confirmed passkey removal is missing credential metadata");
		}
		await markPasskeyRevoked(env, { uid, credentialId, revokedAt: createdAt });
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
		await writeLedgerEntries(
			env,
			attachChainEvidence([
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
			], opts.chainEvidence),
		);
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
		await writeLedgerEntries(
			env,
			attachChainEvidence([
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
			], opts.chainEvidence),
		);
	} else if (!isAccountAction) {
		const recipient = await getUserByWallet(env, pending.wallet || "");
		recipientUidForBalanceRefresh = recipient?.uid ?? null;
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
		await writeLedgerEntries(
			env,
			attachChainEvidence(entries, opts.chainEvidence),
			notifyRecipient
				? {
						userEvents: [
							{
								dedupeKey: `payment-received:${txHash.toLowerCase()}:${recipient.uid}`,
								uid: recipient.uid,
								eventType: "activity.payment_received",
								// Push screens can appear on a locked device. Keep
								// monetary details inside the authenticated app.
								payload: {
									title: "Te pagaron",
									body: "Recibiste un pago en GatoPago.",
									link: "/",
								},
								priority: 1,
							},
						],
					}
				: {},
		);
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
	}

	// Settlement is the earliest durable proof that balances changed. Read the
	// sender and in-app recipient together at the latest sequenced block so the
	// UI does not wait for the safe-head indexer or a Queue retry. If that fast
	// path fails, persist one coalesced repair request without rolling settlement
	// back.
	const network = getNetworkConfig(env.CHAIN_KEY);
	const refreshTargets = confirmedBalanceRefreshTargets(
		pending,
		recipientUidForBalanceRefresh,
	);
	const notBeforeBlock = opts.chainEvidence?.blockNumber.toString();
	if (refreshTargets.length > 0) {
		try {
			await refreshWalletBalancesLatestBatch(
				env,
				refreshTargets.map((target) => ({
					...target,
					chainId: network.chainId,
					...(notBeforeBlock ? { notBeforeBlock } : {}),
				})),
			);
		} catch (fastRefreshError) {
			logError(
				"settlement_balance_fast_refresh_failed",
				fastRefreshError,
				{
					uid,
					userOpHash: pending.userOpHash,
					wallets: refreshTargets.length,
				},
			);
			await requestBalanceRefreshBatch(
				env,
				refreshTargets.map((target) => ({
					...target,
					chainId: network.chainId,
					reason: "confirmed_user_operation",
					priority: 0 as const,
					...(notBeforeBlock ? { notBeforeBlock } : {}),
				})),
			).catch((repairError) => {
				// The canonical transfer indexer remains the last repair path.
				logError("settlement_balance_refresh_failed", repairError, {
					uid,
					userOpHash: pending.userOpHash,
					wallets: refreshTargets.length,
				});
			});
		}
	}
}

export const __test = {
	confirmedBalanceRefreshTargets,
};

// ===== Event-driven reconciler =====
//
// Resolves payments stranded mid-flight by a Worker death: rows claimed for
// submit ('submitting') or broadcast ('submitted') whose live request never
// finished. The op is located ON-CHAIN by its userOpHash (UserOperationEvent),
// which is authoritative regardless of which handleOps tx carried it; found +
// success → settle exactly like the live path; found + !success → failed;
// not found after the paymaster validity window → it can never land → failed.

/** After expires_at + this margin an unlanded op is dead (paymaster window). */
const EXPIRY_MARGIN_MS = 5 * 60_000;
const RECONCILE_BATCH_SIZE = 25;
const RECONCILE_LEASE_MS = 60_000;
const RECONCILE_MAX_ERROR_ATTEMPTS = 12;

type CanonicalUserOperationRow = {
	chain_id: number;
	tx_hash: string;
	block_number: number | string;
	block_hash: string;
	transaction_index: number | null;
	success: number;
	consistency_level: string;
	block_timestamp: string | null;
};

async function getCanonicalUserOperation(
	env: Bindings,
	userOpHash: string,
): Promise<CanonicalUserOperationRow | null> {
	return env.GATOPAGO_DB.prepare(
		`SELECT uor.chain_id, uor.tx_hash, uor.block_number, uor.block_hash,
		        uor.transaction_index, uor.success, uor.consistency_level,
		        cb.block_timestamp
		 FROM user_operation_receipts uor
		 JOIN chain_blocks cb
		   ON cb.chain_id = uor.chain_id
		  AND cb.block_number = uor.block_number
		  AND cb.block_hash = uor.block_hash
		  AND cb.canonical = 1
		 WHERE uor.user_op_hash = ? AND uor.canonical = 1
		 LIMIT 1`,
	)
		.bind(userOpHash.toLowerCase())
		.first<CanonicalUserOperationRow>();
}

async function userOperationStreamCoveredPast(
	env: Bindings,
	chainId: number,
	timestampMs: number,
): Promise<boolean> {
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT cb.block_timestamp
		 FROM chain_stream_checkpoints cp
		 JOIN chain_blocks cb
		   ON cb.chain_id = cp.chain_id
		  AND cb.block_number = cp.block_number
		  AND cb.block_hash = cp.block_hash
		  AND cb.canonical = 1
		 WHERE cp.chain_id = ? AND cp.stream = ?`,
	)
		.bind(chainId, `userops:${chainId}`)
		.first<{ block_timestamp: string | null }>();
	if (!row?.block_timestamp) return false;
	const checkpointTime = new Date(row.block_timestamp).getTime();
	return Number.isFinite(checkpointTime) && checkpointTime >= timestampMs;
}

async function enqueueMissingReconcileRequests(env: Bindings): Promise<void> {
	const now = new Date().toISOString();
	await env.GATOPAGO_DB.prepare(
		`INSERT OR IGNORE INTO payment_reconcile_requests (
			user_op_hash, status, priority, attempt_count, next_attempt_at,
			lease_owner, lease_expires_at, last_error_code, created_at,
			updated_at, completed_at
		 )
		 SELECT user_op_hash, 'pending', 1, 0, ?, NULL, NULL, NULL, ?, ?, NULL
		 FROM pending_payments
		 WHERE status IN ('submitting', 'submitted')`,
	)
		.bind(now, now, now)
		.run();
}

export async function runPaymentReconciler(
	env: Bindings,
	limit = RECONCILE_BATCH_SIZE,
): Promise<void> {
	try {
		if (getRpcUrls(env, "indexer").length === 0) return;
		await enqueueMissingReconcileRequests(env);
		const requests = await listDuePaymentReconcileRequests(
			env,
			limit,
		);
		for (const request of requests) {
			const owner = await claimPaymentReconcileRequest(
				env,
				request.userOpHash,
				RECONCILE_LEASE_MS,
			);
			if (!owner) continue;
			const attemptCount = request.attemptCount + 1;
			try {
				const row = await getPendingPaymentAnyState(
					env,
					request.userOpHash,
				);
				if (
					!row ||
					row.status === "confirmed" ||
					row.status === "failed"
				) {
					await completePaymentReconcileRequest(
						env,
						request.userOpHash,
						owner,
					);
					continue;
				}
				const terminal = await reconcileOne(env, row);
				if (terminal) {
					await completePaymentReconcileRequest(
						env,
						request.userOpHash,
						owner,
					);
				} else {
					const delayMs = Math.min(
						5 * 60_000,
						15_000 * 2 ** Math.min(attemptCount - 1, 4),
					);
					await reschedulePaymentReconcileRequest(
						env,
						request.userOpHash,
						owner,
						delayMs,
					);
				}
			} catch (error) {
				const terminal =
					attemptCount >= RECONCILE_MAX_ERROR_ATTEMPTS;
				const delayMs = Math.min(
					10 * 60_000,
					30_000 * 2 ** Math.min(attemptCount - 1, 4),
				);
				await reschedulePaymentReconcileRequest(
					env,
					request.userOpHash,
					owner,
					delayMs,
					terminal
						? "TERMINAL_RECONCILE_ERROR"
						: "RECONCILE_ERROR",
					terminal,
				);
				logError("payment_reconcile_failed", error, {
					userOpHash: request.userOpHash,
					attemptCount,
					terminal,
				});
			}
		}
		await sweepTerminalPendingPayments(env);
		await sweepRateLimits(env);
	} catch (error) {
		logError("payment_reconciler_failed", error, {});
	}
}

async function reconcileOne(env: Bindings, row: PendingPaymentRecord): Promise<boolean> {
	let txHash = (row.submittedTxHash ?? null) as Hex | null;
	let success: boolean | null = null;
	let receiptLogs: Log[] | undefined;

	// Canonical journal projection: the shared watcher scans one bounded window
	// for every GatoPago account. Reconciliation is therefore O(pending rows) in
	// D1, not one enormous eth_getLogs query per payment.
	const canonical = await getCanonicalUserOperation(env, row.userOpHash);
	if (canonical) {
		txHash = canonical.tx_hash as Hex;
		success = canonical.success === 1;
	}

	// A bundler receipt is an efficient point lookup for discovering the bundle
	// tx hash. It is not financial truth by itself: settlement still waits for
	// the independently reconciled canonical journal occurrence.
	if (!txHash && row.submissionTransport === "bundler") {
		const discovery = await getUserOperationTransport(
			env,
			"bundler",
		).receipt({
			userOpHash: row.userOpHash as Hex,
		});
		if (discovery) {
			txHash = discovery.transactionHash;
			await setPendingPaymentStatus(
				env,
				row.userOpHash,
				"submitted",
				txHash,
			);
			if (
				row.currency === "CROSSCHAIN" &&
				typeof row.meta?.opId === "string"
			) {
				await updateCrosschainOp(
					env,
					row.meta.opId,
					{ status: "submitted", sourceTxHash: txHash },
					{ ifStatusIn: ["quoted", "submitted"] },
				);
			}
		}
	}

	// Once the watcher has canonical evidence, fetch this one transaction by
	// hash to recover executed token amounts. This is a point read, never an
	// eth_getLogs range, and it is verified against the journaled block hash.
	if (canonical && txHash) {
		const transactionReceipt = await getUserOperationTransport(
			env,
			"self",
		).receipt({
			userOpHash: row.userOpHash as Hex,
			transactionHash: txHash,
		});
		if (
			transactionReceipt &&
			transactionReceipt.blockHash.toLowerCase() ===
				canonical.block_hash.toLowerCase() &&
			transactionReceipt.blockNumber === BigInt(canonical.block_number)
		) {
			receiptLogs = transactionReceipt.logs;
		}
	}

	if (success === true && txHash && canonical) {
		await settlePayment(env, row, txHash, {
			receiptLogs,
			chainEvidence: {
				chainId: canonical.chain_id,
				blockNumber: BigInt(canonical.block_number),
				blockHash: canonical.block_hash,
				transactionIndex: canonical.transaction_index,
				consistencyLevel: canonical.consistency_level,
				blockTimestamp: canonical.block_timestamp,
			},
		});
		await setPendingPaymentStatus(env, row.userOpHash, "confirmed", txHash);
		logInfo("payment_reconciled", { userOpHash: row.userOpHash, txHash, uid: row.uid });
		return true;
	}
	if (success === false) {
		await setPendingPaymentStatus(env, row.userOpHash, "failed", txHash);
		if (isStoredPaymentLink(row.linkId)) {
			await releasePaymentLinkClaim(env, row.linkId, row.userOpHash, true);
		}
		await failLinkedCrosschainOp(env, row, "userOp failed (reconciler)");
		logWarn("payment_reconciled_failed_op", { userOpHash: row.userOpHash, txHash, uid: row.uid });
		return true;
	}
	// Never seen on-chain. Once the signed paymaster window is safely over, the
	// op can never validate again — close the row so the queue stays clean.
	const expiryWithMargin =
		new Date(row.expiresAt).getTime() + EXPIRY_MARGIN_MS;
	const chainId = getNetworkConfig(env.CHAIN_KEY).chainId;
	if (
		Date.now() > expiryWithMargin &&
		(await userOperationStreamCoveredPast(env, chainId, expiryWithMargin))
	) {
		await setPendingPaymentStatus(env, row.userOpHash, "failed");
		if (isStoredPaymentLink(row.linkId)) {
			await releasePaymentLinkClaim(env, row.linkId, row.userOpHash, true);
		}
		await failLinkedCrosschainOp(env, row, "burn never landed (reconciler)");
		logWarn("payment_expired_unlanded", { userOpHash: row.userOpHash, uid: row.uid });
		return true;
	} else if (Date.now() > expiryWithMargin) {
		logWarn("payment_expiry_waiting_for_canonical_stream", {
			userOpHash: row.userOpHash,
			uid: row.uid,
		});
	}
	return false;
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
