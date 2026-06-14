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

import { formatUnits, parseAbiItem, type Address } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import {
	getSyncCursor,
	listUserWallets,
	setSyncCursor,
	writeLedgerEntries,
	type LedgerEntry,
} from "./storage";
import { notifyUser } from "./push";
import { logError, logInfo } from "./logger";

const TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
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
