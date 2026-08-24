import { type Address } from "viem";
import { getNetworkConfig } from "../../../../shared";
import type { Bindings } from "../../middlewares/auth";
import { scanLogsAdaptive } from "../adaptiveLogs";
import { getArbitrumBlockEvidence } from "../arbitrumFinality";
import { getIndexerScanHead } from "../chainHead";
import {
	chainEventId,
	journalBlockEvents,
	type JournalEvent,
	type JournalUserEvent,
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
	RECOVERY_PROPOSED_EVENT,
	type ChainIndexRunResult,
	type RecoveryProposedLog,
} from "../indexer";
import { recoveryAssignmentStream } from "../indexerPartitions";
import { listWalletsForIndexerShard } from "../indexerShards";
import { logError, logInfo } from "../logger";
import { verifyAndRecoverStream } from "../reorg";
import { getSyncCursor, setSyncCursor } from "../storage";

/**
 * Security watcher: scan our accounts for `RecoveryProposed` events and push the
 * owner so they can cancel within the 48h timelock if it wasn't them. Mitigates
 * the shared-guardian risk (audit M-1): a compromised guardian can start a
 * recovery, but the owner is alerted and can veto it. Queue-driven and retryable.
 * Filters logs to our own wallet addresses, so it only sees our accounts.
 */
export async function runRecoveryWatcher(
	env: Bindings,
	shardId: number,
	targetBlock?: bigint,
): Promise<ChainIndexRunResult | null> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (getRpcUrls(env, "indexer").length === 0) return null;
		const assignmentStream = recoveryAssignmentStream(network.chainId);
		const wallets = await listWalletsForIndexerShard(env, {
			chainId: network.chainId,
			stream: assignmentStream,
			shardId,
		});
		if (wallets.length === 0) return null;
		const byWallet = new Map(wallets.map((w) => [w.walletAddress.toLowerCase(), w.uid]));

		const providerPool = getIndexerProviderPool(env);
		const publicClient = providerPool.pointClient;
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = `recovery:${network.chainId}:shard:${shardId}`;
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

		let alerted = 0;
		let rpcCalls = 0;
		let rpcRetries = 0;
		const recoveryByOccurrence = new Map<string, RecoveryProposedLog>();
		const walletAddresses = wallets.map(
			(wallet) => wallet.walletAddress as Address,
		);
		const recoveryLogs: RecoveryProposedLog[] = [];
		const stats = await scanLogsAdaptive({
			fromBlock,
			toBlock: scanEnd,
			minBlockSpan: range.min,
			maxBlockSpan: range.max,
			maxCalls,
			fetchRange: (rangeFrom, rangeTo) =>
				providerPool.requestLogs<RecoveryProposedLog>(
					rangeFrom,
					rangeTo,
					async (logClient) =>
						(await logClient.getLogs({
							address: walletAddresses,
							event: RECOVERY_PROPOSED_EVENT,
							fromBlock: rangeFrom,
							toBlock: rangeTo,
						})) as RecoveryProposedLog[],
				),
			onRange: (logs) => {
				recoveryLogs.push(...logs);
			},
		});
		rpcCalls += stats.calls;
		rpcRetries += stats.retries;
		const committedScanEnd = boundedEvidenceWindowEnd(
			scanEnd,
			recoveryLogs,
			maxEventBlocksPerJob(env),
		);

		for (const log of recoveryLogs) {
			if (
				!log.transactionHash ||
				log.logIndex === null ||
				!log.blockHash ||
				log.blockNumber === null ||
				log.blockNumber > committedScanEnd
			) continue;
			recoveryByOccurrence.set(
				`${log.transactionHash.toLowerCase()}:${log.logIndex}:${log.blockHash.toLowerCase()}`,
				log,
			);
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
							"Si no fuiste tú, entra a GatoPago y cancélala antes de 48 horas.",
						link: "/recover",
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
				expectedReorgEpoch,
			});
			alerted += journalResult.enqueuedUserEvents;
		}

		const scanEndBlock = await publicClient.getBlock({
			blockNumber: committedScanEnd,
			includeTransactions: false,
		});
		rpcCalls++;
		if (!scanEndBlock.hash) {
			throw new Error("Recovery checkpoint block did not include a hash");
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
		logInfo("recovery_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: committedScanEnd.toString(),
			requestedToBlock: scanEnd.toString(),
			behindBlocks: (scanHead - committedScanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			alerted,
			shardId,
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
		logError("recovery_watch_failed", error, {});
		throw error;
	}
}
