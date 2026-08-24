// Queue-driven mini-indexer (Cloudflare-native; no external hosting).
//
// GatoPago relays every in-app operation, so those are written to the ledger at
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
	type Address,
	type Hex,
} from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	getFaucetAccount,
	getIndexerProviderPool,
	getRpcUrls,
	getServerAccount,
} from "./clients";
import {
	getSyncCursor,
	listUsersByWalletAddresses,
	setSyncCursor,
	writeLedgerEntries,
	type LedgerEntry,
} from "./storage";
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
} from "./chainJournal";
import {
	balanceProjectionAccountKey,
	projectBalanceDeltas,
} from "./balanceProjector";
import { requestBalanceRefresh } from "./balanceReadModel";
import { verifyAndRecoverStream } from "./reorg";
import { listWalletsForIndexerShard } from "./indexerShards";
import { getArbitrumBlockEvidence } from "./arbitrumFinality";
import { getChainReorgEpoch } from "./chainEpoch";
import {
	transferAssignmentStream,
	transferJournalStream,
	transferSyncCursorKey,
	type TransferIndexerPartition,
} from "./indexerPartitions";

const TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);

export const INVOICE_PAID_EVENT = parseAbiItem(
	"event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address token, uint256 amount, uint256 fee, bytes metadata)",
);

export const RECOVERY_PROPOSED_EVENT = parseAbiItem(
	"event RecoveryProposed(address indexed guardian, uint256 executeAfter)",
);

export const USER_OPERATION_EVENT = parseAbiItem(
	"event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/** First run only scans this far back (then the cursor takes over). */
export const BACKFILL_BLOCKS = 5000n;
/**
 * Hard cap of blocks scanned per Queue delivery. Without it, a cursor that
 * falls behind makes every delivery retry an ever-growing range until the Worker's
 * subrequest/CPU budget kills the run BEFORE the cursor advances — a
 * permanent stall (jul-2026: 11 days behind = ~1,900 getLogs in one delivery,
 * every invocation died, deposits stopped being credited). With the cap, each delivery
 * processes a bounded window and commits the cursor, so any backlog drains at
 * up to 20k blocks.
 */
const DEFAULT_MAX_BLOCKS_PER_RUN = 20_000n;
/**
 * Leave the rest of the Worker's external-request budget available for block
 * evidence, retries, and event processing. Queue isolation prevents unrelated
 * jobs from sharing this budget; this guard bounds the eth_getLogs portion.
 */
const DEFAULT_MAX_LOG_SCAN_REQUESTS_PER_JOB = 16;
/**
 * A relevant block needs its header plus up to two Arbitrum finality reads.
 * Cap event-bearing blocks separately from the log-range budget so a busy
 * window cannot turn one Queue delivery into an unbounded evidence fanout.
 */
const DEFAULT_MAX_EVENT_BLOCKS_PER_JOB = 8;

export type ChainIndexRunResult = {
	cursor: bigint;
	targetBlock: bigint;
	scanHead: bigint;
	caughtUp: boolean;
};

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

export type InvoicePaidLog = {
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

export type RecoveryProposedLog = {
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

export type UserOperationLog = {
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

export function logRangeConfig(
	env: Bindings,
	providerMaximum: bigint,
): { min: bigint; max: bigint } {
	const min = BigInt(
		boundedConfigInteger(
			env.RPC_INDEXER_MIN_BLOCK_RANGE,
			10,
			1,
			10_000_000,
		),
	);
	const max = providerMaximum > 0n ? providerMaximum : 1n;
	return { min: min > max ? max : min, max };
}

export function maxLogCallsPerJob(env: Bindings): number {
	return boundedConfigInteger(
		env.INDEXER_MAX_RPC_CALLS_PER_JOB,
		DEFAULT_MAX_LOG_SCAN_REQUESTS_PER_JOB,
		1,
		1_000,
	);
}

export function maxBlocksPerJob(env: Bindings): bigint {
	return BigInt(
		boundedConfigInteger(
			env.INDEXER_MAX_BLOCKS_PER_JOB,
			Number(DEFAULT_MAX_BLOCKS_PER_RUN),
			1,
			10_000_000,
		),
	);
}

export function maxEventBlocksPerJob(env: Bindings): number {
	return boundedConfigInteger(
		env.INDEXER_MAX_EVENT_BLOCKS_PER_JOB,
		DEFAULT_MAX_EVENT_BLOCKS_PER_JOB,
		1,
		100,
	);
}

export function journalConsistency(
	finalitySource: IndexerScanHead["finalitySource"],
): ChainConsistencyLevel {
	return finalitySource === "safe" ? "safe" : "sequenced";
}

function transferLogKey(log: TransferLog): string | null {
	if (!log.transactionHash || log.logIndex === null || !log.blockHash) return null;
	return `${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.blockHash.toLowerCase()}`;
}
export { getIndexerScanHead };

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
	maxCalls = DEFAULT_MAX_LOG_SCAN_REQUESTS_PER_JOB,
	maxBlocks = DEFAULT_MAX_BLOCKS_PER_RUN,
): bigint {
	if (!Number.isSafeInteger(filterCount) || filterCount < 1) {
		throw new Error("Indexer filter count must be a positive safe integer");
	}
	if (filterCount > maxCalls) {
		throw new Error(
			`Indexer requires ${filterCount} filters; split the stream across Queue jobs`,
		);
	}
	const rangesPerFilter = Math.max(
		1,
		Math.floor(maxCalls / filterCount),
	);
	const budgetedBlocks = maxBlockSpan * BigInt(rangesPerFilter);
	const windowBlocks =
		budgetedBlocks < maxBlocks
			? budgetedBlocks
			: maxBlocks;
	const capped = fromBlock + windowBlocks - 1n;
	return capped > latest ? latest : capped;
}

export function boundedEvidenceWindowEnd(
	requestedEnd: bigint,
	logs: readonly { blockNumber: bigint | null }[],
	maximumEventBlocks = DEFAULT_MAX_EVENT_BLOCKS_PER_JOB,
): bigint {
	if (
		!Number.isSafeInteger(maximumEventBlocks) ||
		maximumEventBlocks < 1
	) {
		throw new Error(
			"Indexer event-block budget must be a positive safe integer",
		);
	}
	const blocks = [...new Set(
		logs
			.map((log) => log.blockNumber)
			.filter((value): value is bigint => value !== null),
	)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return blocks.length > maximumEventBlocks
		? blocks[maximumEventBlocks - 1]
		: requestedEnd;
}

export async function runIndexer(
	env: Bindings,
	partition: TransferIndexerPartition,
	targetBlock?: bigint,
): Promise<ChainIndexRunResult | null> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const token = network.tokens.find(
			(candidate) =>
				candidate.address?.toLowerCase() === partition.token.toLowerCase(),
		);
		if (!token?.address) {
			throw new Error("Transfer indexer partition references an unsupported token");
		}
		if (getRpcUrls(env, "indexer").length === 0) return null;
		const assignmentStream = transferAssignmentStream(network.chainId);
		const wallets = await listWalletsForIndexerShard(env, {
			chainId: network.chainId,
			stream: assignmentStream,
			shardId: partition.shardId,
		});
		if (wallets.length === 0) return null;
		const internalSenders = internalTransferSenderAddresses(env);

		const providerPool = getIndexerProviderPool(env);
		const publicClient = providerPool.pointClient;
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = transferSyncCursorKey(
			network.chainId,
			partition,
		);
		const journalStream = transferJournalStream(
			network.chainId,
			partition,
		);
		await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: journalStream,
		});
		const expectedReorgEpoch = await getChainReorgEpoch(
			env,
			network.chainId,
		);
		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null ? cursor + 1n : scanHead > BACKFILL_BLOCKS ? scanHead - BACKFILL_BLOCKS : 0n;
		const desiredTarget =
			targetBlock !== undefined && targetBlock > scanHead
				? targetBlock
				: scanHead;
		if (fromBlock > scanHead) {
			return {
				cursor: cursor ?? scanHead,
				targetBlock: desiredTarget,
				scanHead,
				caughtUp: (cursor ?? scanHead) >= desiredTarget,
			};
		}
		const range = logRangeConfig(env, providerPool.maxLogRange);
		const maxCalls = maxLogCallsPerJob(env);
		const scanEnd = boundedScanWindowEnd(
			fromBlock,
			scanHead,
			range.max,
			1,
			maxCalls,
			maxBlocksPerJob(env),
		);

		const logByIdentity = new Map<string, TransferLog>();
		let rpcCalls = 0;
		let rpcRetries = 0;
		const addresses = wallets.map(
			(wallet) => wallet.walletAddress as Address,
		);
		const stats = await scanLogsAdaptive<TransferLog>({
			fromBlock,
			toBlock: scanEnd,
			minBlockSpan: range.min,
			maxBlockSpan: range.max,
			maxCalls,
			fetchRange: (rangeFrom, rangeTo) =>
				providerPool.requestLogs<TransferLog>(
					rangeFrom,
					rangeTo,
					async (logClient) =>
						(await logClient.getLogs({
							address: token.address!,
							event: TRANSFER_EVENT,
							args:
								partition.direction === "from"
									? { from: addresses }
									: { to: addresses },
							fromBlock: rangeFrom,
							toBlock: rangeTo,
						})) as TransferLog[],
				),
			onRange: (logs) => {
				for (const log of logs) {
					const key = transferLogKey(log);
					if (key) logByIdentity.set(key, log);
				}
			},
		});
		rpcCalls += stats.calls;
		rpcRetries += stats.retries;
		const fetchedLogs = [...logByIdentity.values()];
		const committedScanEnd = boundedEvidenceWindowEnd(
			scanEnd,
			fetchedLogs,
			maxEventBlocksPerJob(env),
		);
		const committedLogs = fetchedLogs.filter(
			(log) =>
				log.blockNumber !== null &&
				log.blockNumber <= committedScanEnd,
		);

		const relatedUsers = await listUsersByWalletAddresses(
			env,
			committedLogs.flatMap((log) => [
				log.args.from ?? "",
				log.args.to ?? "",
			]),
		);
		const byWallet = new Map(
			relatedUsers.map((user) => [
				user.walletAddress.toLowerCase(),
				user.uid,
			]),
		);

		const logsByBlock = new Map<string, TransferLog[]>();
		for (const log of committedLogs) {
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
				if (
					log.address.toLowerCase() !== token.address.toLowerCase() ||
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
				expectedReorgEpoch,
			});
			const projection = await projectBalanceDeltas(env, {
				block: journalBlock,
				events: journalEvents,
				expectedReorgEpoch,
			});

			if (entries.length > 0) {
				await writeLedgerEntries(env, entries, {
					expectedReorgEpoch,
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
						body: "Abre GatoPago para ver el movimiento confirmado.",
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
			blockNumber: committedScanEnd,
			includeTransactions: false,
		});
		if (!scanEndBlock.hash) {
			throw new Error("RPC returned scan checkpoint block without hash");
		}
		const scanEndEvidence = await getArbitrumBlockEvidence(env, publicClient, {
			blockNumber: committedScanEnd,
			blockHash: scanEndBlock.hash,
		});
		rpcCalls += scanEndEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: journalStream,
			block: {
				chainId: network.chainId,
				blockNumber: committedScanEnd,
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
			expectedReorgEpoch,
		});
		await setSyncCursor(env, cursorKey, committedScanEnd, {
			chainId: network.chainId,
			expectedReorgEpoch,
		});

		logInfo("indexer_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: committedScanEnd.toString(),
			requestedToBlock: scanEnd.toString(),
			behindBlocks: (scanHead - committedScanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			wallets: wallets.length,
			shardId: partition.shardId,
			token: token.symbol,
			direction: partition.direction,
			rpcCalls,
			rpcRetries,
			configuredMaxBlockRange: range.max.toString(),
			ingested,
		});
		return {
			cursor: committedScanEnd,
			targetBlock: desiredTarget,
			scanHead,
			caughtUp: committedScanEnd >= desiredTarget,
		};
	} catch (error) {
		// Queue retries the same range because the cursor advances only after a
		// fully journaled window. Writes remain idempotent across redelivery.
		logError("indexer_failed", error, {});
		throw error;
	}
}

/** Addresses whose transfers are finalized by GatoPago and must not be re-indexed. */
export function internalTransferSenderAddresses(env: Bindings): Set<string> {
	const addresses = new Set([getServerAccount(env).address.toLowerCase()]);
	if (env.FAUCET_PRIVATE_KEY?.trim()) {
		addresses.add(getFaucetAccount(env).address.toLowerCase());
	}
	return addresses;
}
