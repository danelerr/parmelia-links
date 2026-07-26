// Queue-driven mini-indexer (Cloudflare-native; no external hosting).
//
// Parmelia relays every in-app operation, so those are written to the ledger at
// submit time. The ONLY movements the app can't see are incoming transfers sent
// from outside (bridge deliveries, external wallets). This job scans ERC-20
// Transfer logs to our users' wallets since the last cursor and ingests them as
// kind="external", idempotently (the ledger's unique index dedupes re-scans).
//
// Explicit boundary:
//   - Native ETH external deposits emit no logs, so the balance read model is
//     reconciled by bounded point reads instead of pretending an ERC-20 stream
//     can discover them.
//   - ERC-20 topic filters are stable, versioned wallet shards with independent
//     cursors. No request carries the full global wallet set.

import {
	formatUnits,
	parseAbiItem,
	parseUnits,
	type Address,
	type Hex,
} from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	getFaucetAccount,
	getIndexerClient,
	getRpcUrls,
	getServerAccount,
} from "./clients";
import {
	getMerchantById,
	getPaymentIntentByOnchainId,
	getSyncCursor,
	getUserByUid,
	listUserWallets,
	markPaymentIntentPaidWithOutbox,
	setSyncCursor,
	writeLedgerEntries,
	type LedgerEntry,
} from "./storage";
import { deliverPendingWebhooks, prepareEventOutbox } from "./webhooks";
import { logError, logInfo } from "./logger";
import {
	getIndexerScanHead,
	type IndexerScanHead,
} from "./chainHead";
import { scanLogsAdaptive } from "./adaptiveLogs";
import {
	chainEventId,
	journalBlockEvents,
	type ChainConsistencyLevel,
	type JournalEvent,
	type JournalUserEvent,
	type JournalUserOperationReceipt,
} from "./chainJournal";
import {
	balanceProjectionAccountKey,
	projectBalanceDeltas,
} from "./balanceProjector";
import { requestBalanceRefresh } from "./balanceReadModel";
import { verifyAndRecoverStream } from "./reorg";
import { syncStableWalletShards } from "./indexerShards";
import { getArbitrumBlockEvidence } from "./arbitrumFinality";

const TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);

const INVOICE_PAID_EVENT = parseAbiItem(
	"event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address token, uint256 amount, uint256 fee, bytes metadata)",
);

const RECOVERY_PROPOSED_EVENT = parseAbiItem(
	"event RecoveryProposed(address indexed guardian, uint256 executeAfter)",
);

const USER_OPERATION_EVENT = parseAbiItem(
	"event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/** First run only scans this far back (then the cursor takes over). */
const BACKFILL_BLOCKS = 5000n;
/**
 * Hard cap of blocks scanned per Queue delivery. Without it, a cursor that
 * falls behind makes every delivery retry an ever-growing range until the Worker's
 * subrequest/CPU budget kills the run BEFORE the cursor advances — a
 * permanent stall (jul-2026: 11 days behind = ~1,900 getLogs in one cron,
 * every invocation died, deposits stopped being credited). With the cap, each delivery
 * processes a bounded window and commits the cursor, so any backlog drains at
 * up to 20k blocks.
 */
const MAX_BLOCKS_PER_RUN = 20_000n;
/**
 * Leave most of the Free-plan 50 external subrequests available for block
 * evidence, retries, and event processing. Queue isolation prevents unrelated
 * jobs from sharing this budget; this guard bounds the eth_getLogs portion.
 */
const MAX_LOG_SCAN_REQUESTS_PER_JOB = 16;

type TransferLog = {
	address: Address;
	args: {
		from?: Address;
		to?: Address;
		value?: bigint;
	};
	blockHash: Hex | null;
	blockNumber: bigint | null;
	logIndex: number | null;
	transactionHash: Hex | null;
	transactionIndex: number | null;
	topics: readonly Hex[];
	removed?: boolean;
};

type InvoicePaidLog = {
	address: Address;
	args: {
		invoiceId?: Hex;
		payer?: Address;
		merchant?: Address;
		token?: Address;
		amount?: bigint;
		fee?: bigint;
		metadata?: Hex;
	};
	blockHash: Hex | null;
	blockNumber: bigint | null;
	logIndex: number | null;
	transactionHash: Hex | null;
	transactionIndex: number | null;
	topics: readonly Hex[];
	removed?: boolean;
};

type RecoveryProposedLog = {
	address: Address;
	args: {
		guardian?: Address;
		executeAfter?: bigint;
	};
	blockHash: Hex | null;
	blockNumber: bigint | null;
	logIndex: number | null;
	transactionHash: Hex | null;
	transactionIndex: number | null;
	topics: readonly Hex[];
	removed?: boolean;
};

type UserOperationLog = {
	address: Address;
	args: {
		userOpHash?: Hex;
		sender?: Address;
		paymaster?: Address;
		nonce?: bigint;
		success?: boolean;
		actualGasCost?: bigint;
		actualGasUsed?: bigint;
	};
	blockHash: Hex | null;
	blockNumber: bigint | null;
	logIndex: number | null;
	transactionHash: Hex | null;
	transactionIndex: number | null;
	topics: readonly Hex[];
	removed?: boolean;
};

function boundedConfigInteger(
	raw: string | undefined,
	fallbackValue: number,
	min: number,
	max: number,
): number {
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) return fallbackValue;
	return Math.min(max, Math.max(min, value));
}

function logRangeConfig(env: Bindings): { min: bigint; max: bigint } {
	const min = BigInt(
		boundedConfigInteger(env.RPC_INDEXER_MIN_BLOCK_RANGE, 10, 1, 2_000),
	);
	const max = BigInt(
		boundedConfigInteger(
			env.RPC_INDEXER_MAX_BLOCK_RANGE,
			2_000,
			1,
			2_000,
		),
	);
	return { min: min > max ? max : min, max };
}

function walletShardSize(env: Bindings): number {
	return boundedConfigInteger(env.INDEXER_WALLET_SHARD_SIZE, 250, 1, 500);
}

function journalConsistency(
	finalitySource: IndexerScanHead["finalitySource"],
): ChainConsistencyLevel {
	return finalitySource === "safe" ? "safe" : "sequenced";
}

function transferLogKey(log: TransferLog): string | null {
	if (!log.transactionHash || log.logIndex === null || !log.blockHash) return null;
	return `${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.blockHash.toLowerCase()}`;
}
export { getIndexerScanHead };
export type { IndexerScanHead };

/**
 * End of this Queue delivery's scan window. More wallet filters reduce the
 * window instead of increasing subrequests, so adding users cannot make a
 * single Worker invocation cross its log-call budget.
 */
export function boundedScanWindowEnd(
	fromBlock: bigint,
	latest: bigint,
	maxBlockSpan: bigint,
	filterCount: number,
): bigint {
	if (!Number.isSafeInteger(filterCount) || filterCount < 1) {
		throw new Error("Indexer filter count must be a positive safe integer");
	}
	if (filterCount > MAX_LOG_SCAN_REQUESTS_PER_JOB) {
		throw new Error(
			`Indexer requires ${filterCount} filters; split the stream across Queue jobs`,
		);
	}
	const rangesPerFilter = Math.max(
		1,
		Math.floor(MAX_LOG_SCAN_REQUESTS_PER_JOB / filterCount),
	);
	const budgetedBlocks = maxBlockSpan * BigInt(rangesPerFilter);
	const windowBlocks =
		budgetedBlocks < MAX_BLOCKS_PER_RUN
			? budgetedBlocks
			: MAX_BLOCKS_PER_RUN;
	const capped = fromBlock + windowBlocks - 1n;
	return capped > latest ? latest : capped;
}

export async function runIndexer(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const erc20Tokens = network.tokens.filter((t) => t.address);
		if (erc20Tokens.length === 0 || getRpcUrls(env, "indexer").length === 0) return;

		const wallets = await listUserWallets(env);
		if (wallets.length === 0) return;
		const byWallet = new Map(wallets.map((w) => [w.walletAddress.toLowerCase(), w.uid]));
		const internalSenders = internalTransferSenderAddresses(env);

		const publicClient = getIndexerClient(env);
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = `transfers:${network.chainId}`;
		const journalStream = `erc20_transfers:${network.chainId}`;
		const shardState = await syncStableWalletShards(env, {
			chainId: network.chainId,
			stream: journalStream,
			wallets,
			maxWallets: walletShardSize(env),
		});
		const walletShards = shardState.shards.map((shard) => shard.wallets);
		const reorgCheck = await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: journalStream,
		});
		if (reorgCheck.status === "recovered") {
			await setSyncCursor(env, cursorKey, reorgCheck.checkpoint);
		}
		const cursor = await getSyncCursor(env, cursorKey);
		const normalFromBlock =
			cursor !== null ? cursor + 1n : scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const assignmentBackfill =
			scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const fromBlock =
			shardState.assignmentsChanged && assignmentBackfill < normalFromBlock
				? assignmentBackfill
				: normalFromBlock;
		if (fromBlock > scanHead) return;
		const range = logRangeConfig(env);
		const scanEnd = boundedScanWindowEnd(
			fromBlock,
			scanHead,
			range.max,
			erc20Tokens.length * walletShards.length * 2,
		);

		const logByIdentity = new Map<string, TransferLog>();
		let rpcCalls = 0;
		let rpcRetries = 0;
		for (const token of erc20Tokens) {
			for (const shard of walletShards) {
				const addresses = shard.map((wallet) => wallet.walletAddress as Address);
				for (const direction of ["from", "to"] as const) {
					const remainingCalls =
						MAX_LOG_SCAN_REQUESTS_PER_JOB - rpcCalls;
					if (remainingCalls < 1) {
						throw new Error("Indexer log-call budget was exhausted");
					}
					const stats = await scanLogsAdaptive<TransferLog>({
						fromBlock,
						toBlock: scanEnd,
						minBlockSpan: range.min,
						maxBlockSpan: range.max,
						maxCalls: remainingCalls,
						fetchRange: async (rangeFrom, rangeTo) =>
							(await publicClient.getLogs({
								address: token.address!,
								event: TRANSFER_EVENT,
								args:
									direction === "from"
										? { from: addresses }
										: { to: addresses },
								fromBlock: rangeFrom,
								toBlock: rangeTo,
							})) as TransferLog[],
						onRange: (logs) => {
							for (const log of logs) {
								const key = transferLogKey(log);
								if (key) logByIdentity.set(key, log);
							}
						},
					});
					rpcCalls += stats.calls;
					rpcRetries += stats.retries;
				}
			}
		}

		const logsByBlock = new Map<string, TransferLog[]>();
		for (const log of logByIdentity.values()) {
			if (
				log.removed ||
				log.blockNumber === null ||
				!log.blockHash ||
				!log.transactionHash ||
				log.logIndex === null
			) {
				continue;
			}
			const key = `${log.blockNumber}:${log.blockHash.toLowerCase()}`;
			const grouped = logsByBlock.get(key) ?? [];
			grouped.push(log);
			logsByBlock.set(key, grouped);
		}

		const orderedBlocks = [...logsByBlock.entries()].sort(([, a], [, b]) =>
			a[0].blockNumber! < b[0].blockNumber! ? -1 : 1,
		);
		let ingested = 0;
		for (const [, blockLogs] of orderedBlocks) {
			const blockNumber = blockLogs[0].blockNumber!;
			const expectedHash = blockLogs[0].blockHash!;
			const block = await publicClient.getBlock({
				blockHash: expectedHash,
				includeTransactions: false,
			});
			if (
				!block.hash ||
				block.hash.toLowerCase() !== expectedHash.toLowerCase() ||
				block.number !== blockNumber
			) {
				throw new Error("RPC log block evidence did not match its block header");
			}
			const observedAt = new Date().toISOString();
			const finalityEvidence = await getArbitrumBlockEvidence(
				env,
				publicClient,
				{ blockNumber, blockHash: expectedHash },
			);
			rpcCalls += finalityEvidence.rpcCalls;
			const consistencyLevel =
				finalityEvidence.source === "node_interface"
					? finalityEvidence.consistencyLevel
					: journalConsistency(finalitySource);
			const journalEvents: JournalEvent[] = [];
			const entries: LedgerEntry[] = [];
			const affected = new Map<string, { uid: string; address: Address }>();

			for (const log of blockLogs) {
				const from = (log.args.from ?? "").toLowerCase();
				const to = (log.args.to ?? "").toLowerCase();
				const value = log.args.value ?? 0n;
				const token = erc20Tokens.find(
					(candidate) =>
						candidate.address?.toLowerCase() === log.address.toLowerCase(),
				);
				if (
					!token ||
					!log.transactionHash ||
					log.logIndex === null ||
					value < 0n
				) {
					continue;
				}
				const accounts: NonNullable<JournalEvent["accounts"]> = [];
				const fromUid = byWallet.get(from);
				const toUid = byWallet.get(to);
				if (fromUid) {
					accounts.push({
						uid: fromUid,
						accountAddress: from as Address,
						asset: token.symbol,
						role: "from",
						deltaRaw: -value,
					});
					affected.set(fromUid, {
						uid: fromUid,
						address: from as Address,
					});
				}
				if (toUid) {
					accounts.push({
						uid: toUid,
						accountAddress: to as Address,
						asset: token.symbol,
						role: "to",
						deltaRaw: value,
					});
					affected.set(toUid, { uid: toUid, address: to as Address });
				}
				if (accounts.length === 0) continue;

				journalEvents.push({
					txHash: log.transactionHash,
					logIndex: log.logIndex,
					eventKind: "erc20.Transfer",
					blockNumber,
					blockHash: expectedHash,
					transactionIndex: log.transactionIndex,
					contractAddress: log.address,
					topic0: log.topics[0] ?? null,
					payload: {
						from,
						to,
						value: value.toString(),
						asset: token.symbol,
						decimals: token.decimals,
					},
					source: "rpc_log_poller",
					observedAt,
					accounts,
				});

				// In-app/internal movements already have ledger rows written by the
				// settlement path. Only genuinely external incoming transfers are
				// materialized here.
				if (toUid && !fromUid && !internalSenders.has(from)) {
					entries.push({
						uid: toUid,
						direction: "in",
						kind: "external",
						txHash: log.transactionHash,
						logIndex: log.logIndex,
						token: token.symbol,
						amount: formatUnits(value, token.decimals),
						amountRaw: value.toString(),
						decimals: token.decimals,
						chainId: network.chainId,
						blockNumber,
						blockHash: expectedHash,
						transactionIndex: log.transactionIndex,
						consistencyLevel,
						projectionVersion: 1,
						counterparty: from,
						reference: "Depósito recibido",
						createdAt: new Date(
							Number(block.timestamp) * 1_000,
						).toISOString(),
					});
				}
			}

			if (journalEvents.length === 0) continue;
			const journalBlock = {
				chainId: network.chainId,
				blockNumber,
				blockHash: expectedHash,
				parentHash: block.parentHash,
				timestamp: block.timestamp,
				consistencyLevel,
				source: "rpc_log_poller",
				observedAt,
				l1BatchNumber: finalityEvidence.l1BatchNumber,
				l1Confirmations: finalityEvidence.l1Confirmations,
			} as const;
			await journalBlockEvents(env, {
				stream: journalStream,
				block: journalBlock,
				events: journalEvents,
			});
			const projection = await projectBalanceDeltas(env, {
				block: journalBlock,
				events: journalEvents,
			});

			if (entries.length > 0) {
				await writeLedgerEntries(env, entries, {
					userEvents: entries.map((entry) => ({
						dedupeKey: `${chainEventId(
							network.chainId,
							entry.txHash,
							entry.logIndex ?? 0,
							"erc20.Transfer",
						)}:${entry.uid}:deposit-received`,
						uid: entry.uid,
						eventType: "activity.deposit_received",
						priority: 1,
						payload: {
						title: "Recibiste un depósito",
						body: "Abre Parmelia para ver el movimiento confirmado.",
						link: "/",
						},
					})),
				});
			}
			for (const account of affected.values()) {
				if (
					projection.eventOnlySatisfiedAccounts.has(
						balanceProjectionAccountKey(
							account.uid,
							account.address,
						),
					)
				) {
					continue;
				}
				await requestBalanceRefresh(env, {
					uid: account.uid,
					accountAddress: account.address,
					chainId: network.chainId,
					reason: "canonical_transfer_event",
					priority: 1,
					notBeforeBlock: blockNumber.toString(),
				});
			}
			ingested += journalEvents.length;
		}

		// Persist the exact end-of-window hash even when no relevant event exists.
		// It turns the next Queue delivery into a real hash continuity check instead of
		// trusting a numeric cursor.
		const scanEndBlock = await publicClient.getBlock({
			blockNumber: scanEnd,
			includeTransactions: false,
		});
		if (!scanEndBlock.hash) {
			throw new Error("RPC returned scan checkpoint block without hash");
		}
		const scanEndEvidence = await getArbitrumBlockEvidence(env, publicClient, {
			blockNumber: scanEnd,
			blockHash: scanEndBlock.hash,
		});
		rpcCalls += scanEndEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: journalStream,
			block: {
				chainId: network.chainId,
				blockNumber: scanEnd,
				blockHash: scanEndBlock.hash,
				parentHash: scanEndBlock.parentHash,
				timestamp: scanEndBlock.timestamp,
				consistencyLevel:
					scanEndEvidence.source === "node_interface"
						? scanEndEvidence.consistencyLevel
						: journalConsistency(finalitySource),
				source: "rpc_log_poller",
				observedAt: new Date().toISOString(),
				l1BatchNumber: scanEndEvidence.l1BatchNumber,
				l1Confirmations: scanEndEvidence.l1Confirmations,
			},
			events: [],
		});
		await setSyncCursor(env, cursorKey, scanEnd);

		logInfo("indexer_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: scanEnd.toString(),
			behindBlocks: (scanHead - scanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			wallets: wallets.length,
			shards: walletShards.length,
			shardAssignmentsChanged: shardState.assignmentsChanged,
			rpcCalls,
			rpcRetries,
			configuredMaxBlockRange: range.max.toString(),
			ingested,
		});
	} catch (error) {
		// Queue retries the same range because the cursor advances only after a
		// fully journaled window. Writes remain idempotent across redelivery.
		logError("indexer_failed", error, {});
		throw error;
	}
}

/** Addresses whose transfers are finalized by Parmelia and must not be re-indexed. */
export function internalTransferSenderAddresses(env: Bindings): Set<string> {
	const addresses = new Set([getServerAccount(env).address.toLowerCase()]);
	if (env.FAUCET_PRIVATE_KEY?.trim()) {
		addresses.add(getFaucetAccount(env).address.toLowerCase());
	}
	return addresses;
}

/**
 * Flow B reconciliation: scan PaymentRouter `InvoicePaid` events, attribute each
 * to its payment intent by `invoiceId` (= onchain_id), validate the destination
 * and amount against the intent, mark it paid, and fire payment.paid. Queue-driven
 * and idempotent (markPaymentIntentPaid only acts on `awaiting_payment`).
 */
export async function runRouterWatcher(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const router = network.contracts.paymentRouter as Address;
		if (
			!router ||
			router === "0x0000000000000000000000000000000000000000" ||
			getRpcUrls(env, "indexer").length === 0
		) return;

		const publicClient = getIndexerClient(env);
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = `router:${network.chainId}`;
		const reorgCheck = await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: cursorKey,
		});
		if (reorgCheck.status === "recovered") {
			await setSyncCursor(env, cursorKey, reorgCheck.checkpoint);
		}
		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null ? cursor + 1n : scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		if (fromBlock > scanHead) return;
		const range = logRangeConfig(env);
		const scanEnd = boundedScanWindowEnd(
			fromBlock,
			scanHead,
			range.max,
			1,
		);

		let confirmed = 0;
		const blockTimestamps = new Map<bigint, bigint>();
		const routerLogs: InvoicePaidLog[] = [];
		const scanStats = await scanLogsAdaptive({
			fromBlock,
			toBlock: scanEnd,
			minBlockSpan: range.min,
			maxBlockSpan: range.max,
			maxCalls: MAX_LOG_SCAN_REQUESTS_PER_JOB,
			fetchRange: async (rangeFrom, rangeTo) =>
				(await publicClient.getLogs({
					address: router,
					event: INVOICE_PAID_EVENT,
					fromBlock: rangeFrom,
					toBlock: rangeTo,
				})) as InvoicePaidLog[],
			onRange: (logs) => {
				routerLogs.push(...logs);
			},
		});

		const validRouterLogs = routerLogs.filter(
			(log) =>
				Boolean(log.transactionHash) &&
				log.logIndex !== null &&
				log.blockNumber !== null &&
				Boolean(log.blockHash),
		);
		const routerByBlock = new Map<string, InvoicePaidLog[]>();
		for (const log of validRouterLogs) {
			const key = `${log.blockNumber}:${log.blockHash!.toLowerCase()}`;
			const values = routerByBlock.get(key) ?? [];
			values.push(log);
			routerByBlock.set(key, values);
		}
		let evidenceRpcCalls = 0;
		for (const logs of [...routerByBlock.values()].sort((left, right) =>
			left[0].blockNumber! < right[0].blockNumber! ? -1 : 1,
		)) {
			const first = logs[0];
			const blockNumber = first.blockNumber!;
			const blockHash = first.blockHash!;
			const block = await publicClient.getBlock({
				blockHash,
				includeTransactions: false,
			});
			evidenceRpcCalls++;
			if (
				!block.hash ||
				block.hash.toLowerCase() !== blockHash.toLowerCase() ||
				block.number !== blockNumber
			) {
				throw new Error("InvoicePaid log block evidence did not match its header");
			}
			blockTimestamps.set(blockNumber, block.timestamp);
			const finalityEvidence = await getArbitrumBlockEvidence(
				env,
				publicClient,
				{ blockNumber, blockHash },
			);
			evidenceRpcCalls += finalityEvidence.rpcCalls;
			const observedAt = new Date().toISOString();
			await journalBlockEvents(env, {
				stream: cursorKey,
				block: {
					chainId: network.chainId,
					blockNumber,
					blockHash,
					parentHash: block.parentHash,
					timestamp: block.timestamp,
					consistencyLevel:
						finalityEvidence.source === "node_interface"
							? finalityEvidence.consistencyLevel
							: journalConsistency(finalitySource),
					source: "rpc_log_poller",
					observedAt,
					l1BatchNumber: finalityEvidence.l1BatchNumber,
					l1Confirmations: finalityEvidence.l1Confirmations,
				},
				events: logs.map((log) => ({
					txHash: log.transactionHash!,
					logIndex: log.logIndex!,
					eventKind: "payment.InvoicePaid",
					blockNumber,
					blockHash,
					transactionIndex: log.transactionIndex,
					contractAddress: log.address,
					topic0: log.topics[0] ?? null,
					payload: {
						invoiceId: log.args.invoiceId ?? null,
						payer: log.args.payer ?? null,
						merchant: log.args.merchant ?? null,
						token: log.args.token ?? null,
						amount: log.args.amount?.toString() ?? null,
						fee: log.args.fee?.toString() ?? null,
						metadata: log.args.metadata ?? null,
					},
					source: "rpc_log_poller",
					observedAt,
				})),
			});
		}

		for (const log of validRouterLogs) {
				const invoiceId = (log.args.invoiceId ?? "") as string;
				const merchant = ((log.args.merchant ?? "") as string).toLowerCase();
				const token = ((log.args.token ?? "") as string).toLowerCase();
				const amount = log.args.amount ?? 0n;
				if (!invoiceId || !log.transactionHash || log.blockNumber === null) continue;
				const logBlockNumber = log.blockNumber;

				const intent = await getPaymentIntentByOnchainId(env, invoiceId);
				if (!intent || intent.status !== "awaiting_payment") continue;

				// Validate the on-chain payment matches what the intent expects: same
				// token, same amount, and the funds went to THIS merchant's wallet.
				// A mismatch (e.g. a payer who forged a different destination) is not
				// credited — the legit merchant only gets paid on an exact match.
				const merchantRec = await getMerchantById(env, intent.merchantId);
				const owner = merchantRec ? await getUserByUid(env, merchantRec.ownerUid) : null;
				const expectedMerchant = owner?.walletAddress?.toLowerCase();
				const expectedAmount = parseUnits(intent.amount, network.contracts.usdcDecimals);
				if (
					!expectedMerchant ||
					merchant !== expectedMerchant ||
					token !== network.contracts.usdc.toLowerCase() ||
					amount !== expectedAmount
				) {
					logError("router_invoice_mismatch", new Error("on-chain payment did not match intent"), {
						intentId: intent.id,
					});
					continue;
				}
				if (intent.expiresAt) {
					let paidAt = blockTimestamps.get(logBlockNumber);
					if (paidAt === undefined) {
						paidAt = (await publicClient.getBlock({ blockNumber: logBlockNumber })).timestamp;
						blockTimestamps.set(logBlockNumber, paidAt);
					}
					if (paidAt * 1000n > BigInt(new Date(intent.expiresAt).getTime())) {
						logError("router_invoice_after_expiry", new Error("invoice was paid after intent expiry"), {
							intentId: intent.id,
						});
						continue;
					}
				}

				const paidOutbox = await prepareEventOutbox(env, {
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
						tx_hash: log.transactionHash,
						mode: intent.mode,
					},
				});
				if (
					await markPaymentIntentPaidWithOutbox(
						env,
						intent.id,
						log.transactionHash,
						new Date(
							Number(blockTimestamps.get(logBlockNumber)!) * 1_000,
						).toISOString(),
						paidOutbox,
					)
				) confirmed++;
		}

		if (confirmed > 0) await deliverPendingWebhooks(env);
		const scanEndBlock = await publicClient.getBlock({
			blockNumber: scanEnd,
			includeTransactions: false,
		});
		evidenceRpcCalls++;
		if (!scanEndBlock.hash) {
			throw new Error("Router checkpoint block did not include a hash");
		}
		const checkpointEvidence = await getArbitrumBlockEvidence(
			env,
			publicClient,
			{ blockNumber: scanEnd, blockHash: scanEndBlock.hash },
		);
		evidenceRpcCalls += checkpointEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: cursorKey,
			block: {
				chainId: network.chainId,
				blockNumber: scanEnd,
				blockHash: scanEndBlock.hash,
				parentHash: scanEndBlock.parentHash,
				timestamp: scanEndBlock.timestamp,
				consistencyLevel:
					checkpointEvidence.source === "node_interface"
						? checkpointEvidence.consistencyLevel
						: journalConsistency(finalitySource),
				source: "rpc_log_poller",
				observedAt: new Date().toISOString(),
				l1BatchNumber: checkpointEvidence.l1BatchNumber,
				l1Confirmations: checkpointEvidence.l1Confirmations,
			},
			events: [],
		});
		await setSyncCursor(env, cursorKey, scanEnd);
		logInfo("router_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: scanEnd.toString(),
			behindBlocks: (scanHead - scanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			confirmed,
			rpcCalls: scanStats.calls + evidenceRpcCalls,
			rpcRetries: scanStats.retries,
			configuredMaxBlockRange: range.max.toString(),
		});
	} catch (error) {
		logError("router_watch_failed", error, {});
		throw error;
	}
}

/**
 * Security watcher: scan our accounts for `RecoveryProposed` events and push the
 * owner so they can cancel within the 48h timelock if it wasn't them. Mitigates
 * the shared-guardian risk (audit M-1): a compromised guardian can start a
 * recovery, but the owner is alerted and can veto it. Queue-driven and retryable.
 * Filters logs to our own wallet addresses, so it only sees our accounts.
 */
export async function runRecoveryWatcher(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (getRpcUrls(env, "indexer").length === 0) return;

		const wallets = await listUserWallets(env);
		if (wallets.length === 0) return;
		const byWallet = new Map(wallets.map((w) => [w.walletAddress.toLowerCase(), w.uid]));

		const publicClient = getIndexerClient(env);
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = `recovery:${network.chainId}`;
		const reorgCheck = await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: cursorKey,
		});
		if (reorgCheck.status === "recovered") {
			await setSyncCursor(env, cursorKey, reorgCheck.checkpoint);
		}
		const shardState = await syncStableWalletShards(env, {
			chainId: network.chainId,
			stream: cursorKey,
			wallets,
			maxWallets: walletShardSize(env),
		});
		const walletShards = shardState.shards.map((shard) => shard.wallets);
		const cursor = await getSyncCursor(env, cursorKey);
		const normalFromBlock =
			cursor !== null ? cursor + 1n : scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const assignmentBackfill =
			scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const fromBlock =
			shardState.assignmentsChanged && assignmentBackfill < normalFromBlock
				? assignmentBackfill
				: normalFromBlock;
		if (fromBlock > scanHead) return;
		const range = logRangeConfig(env);
		const scanEnd = boundedScanWindowEnd(
			fromBlock,
			scanHead,
			range.max,
			walletShards.length,
		);

		let alerted = 0;
		let rpcCalls = 0;
		let rpcRetries = 0;
		const recoveryByOccurrence = new Map<string, RecoveryProposedLog>();
		for (const shard of walletShards) {
			const remainingCalls =
				MAX_LOG_SCAN_REQUESTS_PER_JOB - rpcCalls;
			if (remainingCalls < 1) {
				throw new Error("Recovery watcher log-call budget was exhausted");
			}
			const walletAddresses = shard.map(
				(wallet) => wallet.walletAddress as Address,
			);
			const recoveryLogs: RecoveryProposedLog[] = [];
			const stats = await scanLogsAdaptive({
				fromBlock,
				toBlock: scanEnd,
				minBlockSpan: range.min,
				maxBlockSpan: range.max,
				maxCalls: remainingCalls,
				fetchRange: async (rangeFrom, rangeTo) =>
					(await publicClient.getLogs({
						address: walletAddresses,
						event: RECOVERY_PROPOSED_EVENT,
						fromBlock: rangeFrom,
						toBlock: rangeTo,
					})) as RecoveryProposedLog[],
				onRange: (logs) => {
					recoveryLogs.push(...logs);
				},
			});
			rpcCalls += stats.calls;
			rpcRetries += stats.retries;

			for (const log of recoveryLogs) {
				if (
					!log.transactionHash ||
					log.logIndex === null ||
					!log.blockHash ||
					log.blockNumber === null
				) continue;
				recoveryByOccurrence.set(
					`${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.blockHash.toLowerCase()}`,
					log,
				);
			}
		}

		const byBlock = new Map<string, RecoveryProposedLog[]>();
		for (const log of recoveryByOccurrence.values()) {
			const key = `${log.blockNumber}:${log.blockHash!.toLowerCase()}`;
			const values = byBlock.get(key) ?? [];
			values.push(log);
			byBlock.set(key, values);
		}
		for (const logs of [...byBlock.values()].sort((left, right) =>
			left[0].blockNumber! < right[0].blockNumber! ? -1 : 1,
		)) {
			const first = logs[0];
			const blockNumber = first.blockNumber!;
			const blockHash = first.blockHash!;
			const block = await publicClient.getBlock({
				blockHash,
				includeTransactions: false,
			});
			rpcCalls++;
			if (
				!block.hash ||
				block.hash.toLowerCase() !== blockHash.toLowerCase() ||
				block.number !== blockNumber
			) {
				throw new Error("Recovery log block evidence did not match its header");
			}
			const finalityEvidence = await getArbitrumBlockEvidence(
				env,
				publicClient,
				{ blockNumber, blockHash },
			);
			rpcCalls += finalityEvidence.rpcCalls;
			const consistencyLevel =
				finalityEvidence.source === "node_interface"
					? finalityEvidence.consistencyLevel
					: journalConsistency(finalitySource);
			const observedAt = new Date().toISOString();
			const events: JournalEvent[] = [];
			const userEvents: JournalUserEvent[] = [];
			for (const log of logs) {
				const account = log.address.toLowerCase();
				const uid = byWallet.get(account);
				if (!uid || !log.transactionHash || log.logIndex === null) continue;
				const eventKind = "account.RecoveryProposed";
				const eventId = chainEventId(
					network.chainId,
					log.transactionHash,
					log.logIndex,
					eventKind,
				);
				events.push({
					txHash: log.transactionHash,
					logIndex: log.logIndex,
					eventKind,
					blockNumber,
					blockHash,
					transactionIndex: log.transactionIndex,
					contractAddress: log.address,
					topic0: log.topics[0] ?? null,
					payload: {
						guardian: log.args.guardian ?? null,
						executeAfter: log.args.executeAfter?.toString() ?? null,
					},
					source: "rpc_log_poller",
					observedAt,
					accounts: [{
						uid,
						accountAddress: log.address,
						asset: "ACCOUNT",
						role: "account",
						deltaRaw: null,
					}],
				});
				userEvents.push({
					dedupeKey: `${eventId}:security.recovery_proposed`,
					uid,
					eventType: "security.recovery_proposed",
					priority: 0,
					payload: {
						title: "Solicitud de recuperación iniciada",
						body:
							"Si no fuiste tú, entra a Parmelia y cancélala antes de 48 horas.",
						link: "/settings",
					},
				});
			}
			if (events.length === 0) continue;
			const journalResult = await journalBlockEvents(env, {
				stream: cursorKey,
				block: {
					chainId: network.chainId,
					blockNumber,
					blockHash,
					parentHash: block.parentHash,
					timestamp: block.timestamp,
					consistencyLevel,
					source: "rpc_log_poller",
					observedAt,
					l1BatchNumber: finalityEvidence.l1BatchNumber,
					l1Confirmations: finalityEvidence.l1Confirmations,
				},
				events,
				userEvents,
			});
			alerted += journalResult.enqueuedUserEvents;
		}

		const scanEndBlock = await publicClient.getBlock({
			blockNumber: scanEnd,
			includeTransactions: false,
		});
		rpcCalls++;
		if (!scanEndBlock.hash) {
			throw new Error("Recovery checkpoint block did not include a hash");
		}
		const checkpointEvidence = await getArbitrumBlockEvidence(
			env,
			publicClient,
			{ blockNumber: scanEnd, blockHash: scanEndBlock.hash },
		);
		rpcCalls += checkpointEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: cursorKey,
			block: {
				chainId: network.chainId,
				blockNumber: scanEnd,
				blockHash: scanEndBlock.hash,
				parentHash: scanEndBlock.parentHash,
				timestamp: scanEndBlock.timestamp,
				consistencyLevel:
					checkpointEvidence.source === "node_interface"
						? checkpointEvidence.consistencyLevel
						: journalConsistency(finalitySource),
				source: "rpc_log_poller",
				observedAt: new Date().toISOString(),
				l1BatchNumber: checkpointEvidence.l1BatchNumber,
				l1Confirmations: checkpointEvidence.l1Confirmations,
			},
			events: [],
		});

		await setSyncCursor(env, cursorKey, scanEnd);
		logInfo("recovery_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: scanEnd.toString(),
			behindBlocks: (scanHead - scanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			alerted,
			shards: walletShards.length,
			shardAssignmentsChanged: shardState.assignmentsChanged,
			rpcCalls,
			rpcRetries,
			configuredMaxBlockRange: range.max.toString(),
		});
	} catch (error) {
		logError("recovery_watch_failed", error, {});
		throw error;
	}
}

/**
 * Canonical ERC-4337 receipt stream for Parmelia accounts. This replaces the
 * old per-payment 300k-block `eth_getLogs` lookup with one bounded, adaptive
 * scan per wallet shard. Reconciliation then becomes a D1 lookup (or a point
 * bundler receipt call) regardless of how many users are waiting.
 */
export async function runUserOperationWatcher(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (getRpcUrls(env, "indexer").length === 0) return;
		const wallets = await listUserWallets(env);
		if (wallets.length === 0) return;

		const byWallet = new Map(
			wallets.map((wallet) => [
				wallet.walletAddress.toLowerCase(),
				wallet.uid,
			]),
		);
		const publicClient = getIndexerClient(env);
		const { latest, scanHead, finalitySource } =
			await getIndexerScanHead(publicClient);
		const cursorKey = `userops:${network.chainId}`;
		const reorgCheck = await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: cursorKey,
		});
		if (reorgCheck.status === "recovered") {
			await setSyncCursor(env, cursorKey, reorgCheck.checkpoint);
		}

		const shardState = await syncStableWalletShards(env, {
			chainId: network.chainId,
			stream: cursorKey,
			wallets,
			maxWallets: walletShardSize(env),
		});
		const cursor = await getSyncCursor(env, cursorKey);
		const normalFromBlock =
			cursor !== null
				? cursor + 1n
				: scanHead > BACKFILL_BLOCKS
					? scanHead - BACKFILL_BLOCKS
					: 0n;
		const assignmentBackfill =
			scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const fromBlock =
			shardState.assignmentsChanged &&
			assignmentBackfill < normalFromBlock
				? assignmentBackfill
				: normalFromBlock;
		if (fromBlock > scanHead) return;
		const range = logRangeConfig(env);
		const scanEnd = boundedScanWindowEnd(
			fromBlock,
			scanHead,
			range.max,
			shardState.shards.length,
		);

		const occurrenceMap = new Map<string, UserOperationLog>();
		let rpcCalls = 0;
		let rpcRetries = 0;
		for (const shard of shardState.shards) {
			const remainingCalls =
				MAX_LOG_SCAN_REQUESTS_PER_JOB - rpcCalls;
			if (remainingCalls < 1) {
				throw new Error(
					"UserOperation watcher log-call budget was exhausted",
				);
			}
			const senders = shard.wallets.map(
				(wallet) => wallet.walletAddress as Address,
			);
			const stats = await scanLogsAdaptive<UserOperationLog>({
				fromBlock,
				toBlock: scanEnd,
				minBlockSpan: range.min,
				maxBlockSpan: range.max,
				maxCalls: remainingCalls,
				fetchRange: async (rangeFrom, rangeTo) =>
					(await publicClient.getLogs({
						address: network.contracts.entryPoint,
						event: USER_OPERATION_EVENT,
						args: { sender: senders },
						fromBlock: rangeFrom,
						toBlock: rangeTo,
					})) as UserOperationLog[],
				onRange: (logs) => {
					for (const log of logs) {
						if (
							!log.transactionHash ||
							log.logIndex === null ||
							!log.blockHash
						) continue;
						occurrenceMap.set(
							`${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.blockHash.toLowerCase()}`,
							log,
						);
					}
				},
			});
			rpcCalls += stats.calls;
			rpcRetries += stats.retries;
		}

		const byBlock = new Map<string, UserOperationLog[]>();
		for (const log of occurrenceMap.values()) {
			if (log.blockNumber === null || !log.blockHash) continue;
			const key = `${log.blockNumber}:${log.blockHash.toLowerCase()}`;
			const values = byBlock.get(key) ?? [];
			values.push(log);
			byBlock.set(key, values);
		}

		let projected = 0;
		for (const logs of [...byBlock.values()].sort((left, right) =>
			left[0].blockNumber! < right[0].blockNumber! ? -1 : 1,
		)) {
			const first = logs[0];
			const blockNumber = first.blockNumber!;
			const blockHash = first.blockHash!;
			const block = await publicClient.getBlock({
				blockHash,
				includeTransactions: false,
			});
			rpcCalls++;
			if (
				!block.hash ||
				block.hash.toLowerCase() !== blockHash.toLowerCase() ||
				block.number !== blockNumber
			) {
				throw new Error(
					"UserOperation log block evidence did not match its header",
				);
			}
			const finalityEvidence = await getArbitrumBlockEvidence(
				env,
				publicClient,
				{ blockNumber, blockHash },
			);
			rpcCalls += finalityEvidence.rpcCalls;
			const consistencyLevel =
				finalityEvidence.source === "node_interface"
					? finalityEvidence.consistencyLevel
					: journalConsistency(finalitySource);
			const observedAt = new Date().toISOString();
			const events: JournalEvent[] = [];
			const receipts: JournalUserOperationReceipt[] = [];
			for (const log of logs) {
				const {
					userOpHash,
					sender,
					paymaster,
					nonce,
					success,
					actualGasCost,
					actualGasUsed,
				} = log.args;
				if (
					!userOpHash ||
					!sender ||
					nonce === undefined ||
					success === undefined ||
					actualGasCost === undefined ||
					actualGasUsed === undefined ||
					!log.transactionHash ||
					log.logIndex === null
				) continue;
				const uid = byWallet.get(sender.toLowerCase());
				if (!uid) continue;
				const eventKind = "entrypoint.UserOperationEvent" as const;
				events.push({
					txHash: log.transactionHash,
					logIndex: log.logIndex,
					eventKind,
					blockNumber,
					blockHash,
					transactionIndex: log.transactionIndex,
					contractAddress: log.address,
					topic0: log.topics[0] ?? null,
					payload: {
						userOpHash,
						sender,
						paymaster: paymaster ?? null,
						nonce: nonce.toString(),
						success,
						actualGasCost: actualGasCost.toString(),
						actualGasUsed: actualGasUsed.toString(),
					},
					source: "rpc_log_poller",
					observedAt,
					accounts: [
						{
							uid,
							accountAddress: sender,
							asset: "ACCOUNT",
							role: "account",
						},
					],
				});
				receipts.push({
					userOpHash,
					txHash: log.transactionHash,
					logIndex: log.logIndex,
					eventKind,
					blockNumber,
					blockHash,
					transactionIndex: log.transactionIndex,
					sender,
					nonce,
					success,
					actualGasCost,
					actualGasUsed,
					source: "rpc_log_poller",
					observedAt,
				});
			}
			if (events.length === 0) continue;
			const result = await journalBlockEvents(env, {
				stream: cursorKey,
				block: {
					chainId: network.chainId,
					blockNumber,
					blockHash,
					parentHash: block.parentHash,
					timestamp: block.timestamp,
					consistencyLevel,
					source: "rpc_log_poller",
					observedAt,
					l1BatchNumber: finalityEvidence.l1BatchNumber,
					l1Confirmations: finalityEvidence.l1Confirmations,
				},
				events,
				userOperationReceipts: receipts,
			});
			projected += result.projectedUserOperations;
		}

		const scanEndBlock = await publicClient.getBlock({
			blockNumber: scanEnd,
			includeTransactions: false,
		});
		rpcCalls++;
		if (!scanEndBlock.hash) {
			throw new Error(
				"UserOperation checkpoint block did not include a hash",
			);
		}
		const checkpointEvidence = await getArbitrumBlockEvidence(
			env,
			publicClient,
			{ blockNumber: scanEnd, blockHash: scanEndBlock.hash },
		);
		rpcCalls += checkpointEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: cursorKey,
			block: {
				chainId: network.chainId,
				blockNumber: scanEnd,
				blockHash: scanEndBlock.hash,
				parentHash: scanEndBlock.parentHash,
				timestamp: scanEndBlock.timestamp,
				consistencyLevel:
					checkpointEvidence.source === "node_interface"
						? checkpointEvidence.consistencyLevel
						: journalConsistency(finalitySource),
				source: "rpc_log_poller",
				observedAt: new Date().toISOString(),
				l1BatchNumber: checkpointEvidence.l1BatchNumber,
				l1Confirmations: checkpointEvidence.l1Confirmations,
			},
			events: [],
		});
		await setSyncCursor(env, cursorKey, scanEnd);
		logInfo("user_operation_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: scanEnd.toString(),
			behindBlocks: (scanHead - scanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			shards: shardState.shards.length,
			shardAssignmentsChanged: shardState.assignmentsChanged,
			projected,
			rpcCalls,
			rpcRetries,
			configuredMaxBlockRange: range.max.toString(),
		});
	} catch (error) {
		logError("user_operation_watch_failed", error, {});
		throw error;
	}
}
