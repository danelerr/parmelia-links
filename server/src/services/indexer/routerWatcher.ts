import { parseUnits, type Address } from "viem";
import { getNetworkConfig } from "../../../../shared";
import type { Bindings } from "../../middlewares/auth";
import { scanLogsAdaptive } from "../adaptiveLogs";
import { getArbitrumBlockEvidence } from "../arbitrumFinality";
import { getIndexerScanHead } from "../chainHead";
import { journalBlockEvents } from "../chainJournal";
import { getChainReorgEpoch } from "../chainEpoch";
import { getIndexerProviderPool, getRpcUrls } from "../clients";
import {
	BACKFILL_BLOCKS,
	boundedEvidenceWindowEnd,
	boundedScanWindowEnd,
	INVOICE_PAID_EVENT,
	journalConsistency,
	logRangeConfig,
	maxBlocksPerJob,
	maxEventBlocksPerJob,
	maxLogCallsPerJob,
	type ChainIndexRunResult,
	type InvoicePaidLog,
} from "../indexer";
import { logError, logInfo } from "../logger";
import { verifyAndRecoverStream } from "../reorg";
import {
	getMerchantById,
	getPaymentIntentByOnchainId,
	getSyncCursor,
	getUserByUid,
	markPaymentIntentPaidWithOutbox,
	setSyncCursor,
} from "../storage";
import { prepareEventOutbox } from "../webhooks";

/**
 * Flow B reconciliation: scan PaymentRouter `InvoicePaid` events, attribute each
 * to its payment intent by `invoiceId` (= onchain_id), validate the destination
 * and amount against the intent, mark it paid, and fire payment.paid. Queue-driven
 * and idempotent (markPaymentIntentPaid only acts on `awaiting_payment`).
 */
export async function runRouterWatcher(
	env: Bindings,
	targetBlock?: bigint,
): Promise<ChainIndexRunResult | null> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const router = network.contracts.paymentRouter as Address;
		if (
			!router ||
			router === "0x0000000000000000000000000000000000000000" ||
			getRpcUrls(env, "indexer").length === 0
		) return null;

		const providerPool = getIndexerProviderPool(env);
		const publicClient = providerPool.pointClient;
		const { latest, scanHead, finalitySource } = await getIndexerScanHead(publicClient);
		const cursorKey = `router:${network.chainId}`;
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

		let confirmed = 0;
		const blockTimestamps = new Map<bigint, bigint>();
		const routerLogs: InvoicePaidLog[] = [];
		const scanStats = await scanLogsAdaptive({
			fromBlock,
			toBlock: scanEnd,
			minBlockSpan: range.min,
			maxBlockSpan: range.max,
			maxCalls,
			fetchRange: (rangeFrom, rangeTo) =>
				providerPool.requestLogs<InvoicePaidLog>(
					rangeFrom,
					rangeTo,
					async (logClient) =>
						(await logClient.getLogs({
							address: router,
							event: INVOICE_PAID_EVENT,
							fromBlock: rangeFrom,
							toBlock: rangeTo,
						})) as InvoicePaidLog[],
				),
			onRange: (logs) => {
				routerLogs.push(...logs);
			},
		});
		const committedScanEnd = boundedEvidenceWindowEnd(
			scanEnd,
			routerLogs,
			maxEventBlocksPerJob(env),
		);

		const validRouterLogs = routerLogs.filter(
			(log) =>
				Boolean(log.transactionHash) &&
				log.logIndex !== null &&
				log.blockNumber !== null &&
				Boolean(log.blockHash) &&
				log.blockNumber! <= committedScanEnd,
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
				expectedReorgEpoch,
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

		const scanEndBlock = await publicClient.getBlock({
			blockNumber: committedScanEnd,
			includeTransactions: false,
		});
		evidenceRpcCalls++;
		if (!scanEndBlock.hash) {
			throw new Error("Router checkpoint block did not include a hash");
		}
		const checkpointEvidence = await getArbitrumBlockEvidence(
			env,
			publicClient,
			{
				blockNumber: committedScanEnd,
				blockHash: scanEndBlock.hash,
			},
		);
		evidenceRpcCalls += checkpointEvidence.rpcCalls;
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
		logInfo("router_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: committedScanEnd.toString(),
			requestedToBlock: scanEnd.toString(),
			behindBlocks: (scanHead - committedScanEnd).toString(),
			unconfirmedBlocks: (latest - scanHead).toString(),
			finalitySource,
			confirmed,
			rpcCalls: scanStats.calls + evidenceRpcCalls,
			rpcRetries: scanStats.retries,
			configuredMaxBlockRange: range.max.toString(),
		});
		return {
			cursor: committedScanEnd,
			targetBlock: desiredTarget,
			scanHead,
			caughtUp: committedScanEnd >= desiredTarget,
		};
	} catch (error) {
		logError("router_watch_failed", error, {});
		throw error;
	}
}
