import { type Address } from "viem";
import { getNetworkConfig } from "../../../../shared";
import type { Bindings } from "../../middlewares/auth";
import { scanLogsAdaptive } from "../adaptiveLogs";
import { getArbitrumBlockEvidence } from "../arbitrumFinality";
import { getIndexerScanHead } from "../chainHead";
import {
	journalBlockEvents,
	type JournalEvent,
	type JournalUserOperationReceipt,
} from "../chainJournal";
import { getChainReorgEpoch } from "../chainEpoch";
import { getIndexerProviderPool, getRpcUrls } from "../clients";
import {
	BACKFILL_BLOCKS,
	boundedEvidenceWindowEnd,
	boundedScanWindowEnd,
	journalConsistency,
	logRangeConfig,
	maxBlocksPerJob,
	maxEventBlocksPerJob,
	maxLogCallsPerJob,
	type ChainIndexRunResult,
	USER_OPERATION_EVENT,
	type UserOperationLog,
} from "../indexer";
import { userOperationAssignmentStream } from "../indexerPartitions";
import { listWalletsForIndexerShard } from "../indexerShards";
import { logError, logInfo } from "../logger";
import { verifyAndRecoverStream } from "../reorg";
import { getSyncCursor, setSyncCursor } from "../storage";

/**
 * Canonical ERC-4337 receipt stream for GatoPago accounts. This replaces the
 * old per-payment 300k-block `eth_getLogs` lookup with one bounded, adaptive
 * scan per wallet shard. Reconciliation then becomes a D1 lookup (or a point
 * bundler receipt call) regardless of how many users are waiting.
 */
export async function runUserOperationWatcher(
	env: Bindings,
	shardId: number,
	targetBlock?: bigint,
): Promise<ChainIndexRunResult | null> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (getRpcUrls(env, "indexer").length === 0) return null;
		const wallets = await listWalletsForIndexerShard(env, {
			chainId: network.chainId,
			stream: userOperationAssignmentStream(network.chainId),
			shardId,
		});
		if (wallets.length === 0) return null;

		const byWallet = new Map(
			wallets.map((wallet) => [
				wallet.walletAddress.toLowerCase(),
				wallet.uid,
			]),
		);
		const providerPool = getIndexerProviderPool(env);
		const publicClient = providerPool.pointClient;
		const { latest, scanHead, finalitySource } =
			await getIndexerScanHead(publicClient);
		const cursorKey = `userops:${network.chainId}:shard:${shardId}`;
		await verifyAndRecoverStream(env, publicClient, {
			chainId: network.chainId,
			stream: cursorKey,
		});
		const expectedReorgEpoch = await getChainReorgEpoch(
			env,
			network.chainId,
		);

		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null
				? cursor + 1n
				: scanHead > BACKFILL_BLOCKS
					? scanHead - BACKFILL_BLOCKS
					: 0n;
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

		const occurrenceMap = new Map<string, UserOperationLog>();
		let rpcCalls = 0;
		let rpcRetries = 0;
		const senders = wallets.map(
			(wallet) => wallet.walletAddress as Address,
		);
		const stats = await scanLogsAdaptive<UserOperationLog>({
			fromBlock,
			toBlock: scanEnd,
			minBlockSpan: range.min,
			maxBlockSpan: range.max,
			maxCalls,
			fetchRange: (rangeFrom, rangeTo) =>
				providerPool.requestLogs<UserOperationLog>(
					rangeFrom,
					rangeTo,
					async (logClient) =>
						(await logClient.getLogs({
							address: network.contracts.entryPoint,
							event: USER_OPERATION_EVENT,
							args: { sender: senders },
							fromBlock: rangeFrom,
							toBlock: rangeTo,
						})) as UserOperationLog[],
				),
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
		const committedScanEnd = boundedEvidenceWindowEnd(
			scanEnd,
			[...occurrenceMap.values()],
			maxEventBlocksPerJob(env),
		);

		const byBlock = new Map<string, UserOperationLog[]>();
		for (const log of occurrenceMap.values()) {
			if (
				log.blockNumber === null ||
				!log.blockHash ||
				log.blockNumber > committedScanEnd
			) continue;
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
				expectedReorgEpoch,
			});
			projected += result.projectedUserOperations;
		}

		const scanEndBlock = await publicClient.getBlock({
			blockNumber: committedScanEnd,
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
			{
				blockNumber: committedScanEnd,
				blockHash: scanEndBlock.hash,
			},
		);
		rpcCalls += checkpointEvidence.rpcCalls;
		await journalBlockEvents(env, {
			stream: cursorKey,
			block: {
				chainId: network.chainId,
				blockNumber: committedScanEnd,
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
			expectedReorgEpoch,
		});
		await setSyncCursor(env, cursorKey, committedScanEnd, {
			chainId: network.chainId,
			expectedReorgEpoch,
		});
		logInfo("user_operation_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: committedScanEnd.toString(),
			requestedToBlock: scanEnd.toString(),
			behindBlocks: (scanHead - committedScanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			shardId,
			projected,
			rpcCalls,
			rpcRetries,
			configuredMaxBlockRange: range.max.toString(),
		});
		return {
			cursor: committedScanEnd,
			targetBlock: desiredTarget,
			scanHead,
			caughtUp: committedScanEnd >= desiredTarget,
		};
	} catch (error) {
		logError("user_operation_watch_failed", error, {});
		throw error;
	}
}
