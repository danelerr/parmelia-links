// Cron-driven mini-indexer (Cloudflare-native; no external hosting).
//
// Parmelia relays every in-app operation, so those are written to the ledger at
// submit time. The ONLY movements the app can't see are incoming transfers sent
// from outside (bridge deliveries, external wallets). This job scans ERC-20
// Transfer logs to our users' wallets since the last cursor and ingests them as
// kind="external", idempotently (the ledger's unique index dedupes re-scans).
//
// Known limits (accepted, documented):
//   - Native ETH external deposits emit no logs → not ingested (Across delivers
//     USDC, and in-app sends are covered; revisit with traces/indexer at scale).
//   - The `to`-topic filter carries every user wallet; fine for thousands of
//     users, shard the filter when it grows beyond that.

import { formatUnits, parseAbiItem, parseUnits, type Address } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import {
	getMerchantById,
	getPaymentIntentByOnchainId,
	getSyncCursor,
	getUserByUid,
	listUserWallets,
	markPaymentIntentPaid,
	setSyncCursor,
	writeLedgerEntries,
	type LedgerEntry,
} from "./storage";
import { notifyUser } from "./push";
import { deliverPendingWebhooks, emitEvent } from "./webhooks";
import { logError, logInfo } from "./logger";

const TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);

const INVOICE_PAID_EVENT = parseAbiItem(
	"event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed merchant, address token, uint256 amount, uint256 fee, bytes metadata)",
);

const RECOVERY_PROPOSED_EVENT = parseAbiItem(
	"event RecoveryProposed(address indexed guardian, uint256 executeAfter)",
);

/** First run only scans this far back (then the cursor takes over). */
const BACKFILL_BLOCKS = 5000n;
/** eth_getLogs chunk size (Arbitrum public RPCs handle this comfortably). */
const LOG_CHUNK = 2000n;

export async function runIndexer(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const erc20Tokens = network.tokens.filter((t) => t.address);
		if (erc20Tokens.length === 0 || !env.RPC_URL) return;

		const wallets = await listUserWallets(env);
		if (wallets.length === 0) return;
		const byWallet = new Map(wallets.map((w) => [w.walletAddress.toLowerCase(), w.uid]));
		const walletAddresses = wallets.map((w) => w.walletAddress as Address);

		const publicClient = getPublicClient(env);
		const latest = await publicClient.getBlockNumber();
		const cursorKey = `transfers:${network.chainId}`;
		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null ? cursor + 1n : latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
		if (fromBlock > latest) return;

		const entries: LedgerEntry[] = [];
		const blockTimes = new Map<string, string>();

		for (const token of erc20Tokens) {
			for (let start = fromBlock; start <= latest; start += LOG_CHUNK) {
				const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
				const logs = await publicClient.getLogs({
					address: token.address!,
					event: TRANSFER_EVENT,
					args: { to: walletAddresses },
					fromBlock: start,
					toBlock: end,
				});

				for (const log of logs) {
					const from = (log.args.from ?? "").toLowerCase();
					const to = (log.args.to ?? "").toLowerCase();
					const value = log.args.value ?? 0n;
					if (!log.transactionHash || log.blockNumber === null || value <= 0n) continue;
					// Internal senders are already covered at submit time.
					if (byWallet.has(from)) continue;
					const uid = byWallet.get(to);
					if (!uid) continue;

					const blockKey = log.blockNumber.toString();
					if (!blockTimes.has(blockKey)) {
						const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
						blockTimes.set(blockKey, new Date(Number(block.timestamp) * 1000).toISOString());
					}

					entries.push({
						uid,
						direction: "in",
						kind: "external",
						txHash: log.transactionHash,
						logIndex: log.logIndex ?? undefined,
						token: token.symbol,
						amount: formatUnits(value, token.decimals),
						counterparty: from,
						reference: "Depósito recibido",
						createdAt: blockTimes.get(blockKey)!,
					});
				}
			}
		}

		if (entries.length > 0) {
			await writeLedgerEntries(env, entries);
			// Best-effort "deposit received" push per ingested transfer.
			for (const e of entries) {
				await notifyUser(env, e.uid, {
					title: "Recibiste un depósito",
					body: `Te llegaron ${e.amount} ${e.token}`,
					link: "/",
				});
			}
		}
		await setSyncCursor(env, cursorKey, latest);

		logInfo("indexer_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: latest.toString(),
			wallets: wallets.length,
			ingested: entries.length,
		});
	} catch (error) {
		// Never throw from the cron - the cursor simply stays put and the next
		// run retries the same range (writes are idempotent).
		logError("indexer_failed", error, {});
	}
}

/**
 * Flow B reconciliation: scan PaymentRouter `InvoicePaid` events, attribute each
 * to its payment intent by `invoiceId` (= onchain_id), validate the destination
 * and amount against the intent, mark it paid, and fire payment.paid. Cron-driven,
 * idempotent (markPaymentIntentPaid only acts on `awaiting_payment`), never throws.
 */
export async function runRouterWatcher(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		const router = network.contracts.paymentRouter as Address;
		if (!router || router === "0x0000000000000000000000000000000000000000" || !env.RPC_URL) return;

		const publicClient = getPublicClient(env);
		const latest = await publicClient.getBlockNumber();
		const cursorKey = `router:${network.chainId}`;
		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null ? cursor + 1n : latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
		if (fromBlock > latest) return;

		let confirmed = 0;
		for (let start = fromBlock; start <= latest; start += LOG_CHUNK) {
			const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
			const logs = await publicClient.getLogs({
				address: router,
				event: INVOICE_PAID_EVENT,
				fromBlock: start,
				toBlock: end,
			});

			for (const log of logs) {
				const invoiceId = (log.args.invoiceId ?? "") as string;
				const merchant = ((log.args.merchant ?? "") as string).toLowerCase();
				const token = ((log.args.token ?? "") as string).toLowerCase();
				const amount = log.args.amount ?? 0n;
				if (!invoiceId || !log.transactionHash) continue;

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

				await markPaymentIntentPaid(env, intent.id, log.transactionHash, new Date().toISOString());
				confirmed++;
				await emitEvent(env, {
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
			}
		}

		if (confirmed > 0) await deliverPendingWebhooks(env);
		await setSyncCursor(env, cursorKey, latest);
		logInfo("router_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: latest.toString(),
			confirmed,
		});
	} catch (error) {
		logError("router_watch_failed", error, {});
	}
}

/**
 * Security watcher: scan our accounts for `RecoveryProposed` events and push the
 * owner so they can cancel within the 48h timelock if it wasn't them. Mitigates
 * the shared-guardian risk (audit M-1): a compromised guardian can start a
 * recovery, but the owner is alerted and can veto it. Cron-driven, never throws.
 * Filters logs to our own wallet addresses, so it only sees our accounts.
 */
export async function runRecoveryWatcher(env: Bindings): Promise<void> {
	try {
		const network = getNetworkConfig(env.CHAIN_KEY);
		if (!env.RPC_URL) return;

		const wallets = await listUserWallets(env);
		if (wallets.length === 0) return;
		const byWallet = new Map(wallets.map((w) => [w.walletAddress.toLowerCase(), w.uid]));
		const walletAddresses = wallets.map((w) => w.walletAddress as Address);

		const publicClient = getPublicClient(env);
		const latest = await publicClient.getBlockNumber();
		const cursorKey = `recovery:${network.chainId}`;
		const cursor = await getSyncCursor(env, cursorKey);
		const fromBlock =
			cursor !== null ? cursor + 1n : latest > BACKFILL_BLOCKS ? latest - BACKFILL_BLOCKS : 0n;
		if (fromBlock > latest) return;

		let alerted = 0;
		for (let start = fromBlock; start <= latest; start += LOG_CHUNK) {
			const end = start + LOG_CHUNK - 1n > latest ? latest : start + LOG_CHUNK - 1n;
			const logs = await publicClient.getLogs({
				address: walletAddresses,
				event: RECOVERY_PROPOSED_EVENT,
				fromBlock: start,
				toBlock: end,
			});

			for (const log of logs) {
				const account = (log.address ?? "").toLowerCase();
				const uid = byWallet.get(account);
				if (!uid) continue;
				await notifyUser(env, uid, {
					title: "Solicitud de recuperación iniciada",
					body: "Si no fuiste tú, entra a Parmelia y cancélala antes de 48 horas.",
					link: "/settings",
				});
				alerted++;
			}
		}

		await setSyncCursor(env, cursorKey, latest);
		logInfo("recovery_watch_run", {
			chainId: network.chainId,
			fromBlock: fromBlock.toString(),
			toBlock: latest.toString(),
			alerted,
		});
	} catch (error) {
		logError("recovery_watch_failed", error, {});
	}
}
