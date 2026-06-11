import { Hono } from "hono";
import { getNetworkConfig } from "../../../shared/networks";
import { AppContext, requireAuth } from "../middlewares/auth";
import { describeHistoryError, fetchWalletHistory } from "../services/history";
import { getUserByUid, listPaidLinksByOwner, listSentTransactionsByUid } from "../services/storage";

const txRoutes = new Hono<AppContext>();

type SentTransactionResponse = {
	txHash: string;
	amount: string;
	currency: string;
	to: string;
	createdAt: string;
	/** "transfer" = direct send; payments are transfers too. */
	kind: "transfer";
};

type ReceivedTransactionResponse = {
	txHash: string;
	amount: string;
	currency: string;
	reference: string;
	paidBy: string;
	createdAt: string;
	/** "link" = collected through a payment link; "transfer" = direct receive. */
	kind: "link" | "transfer";
};

function sortByCreatedAtDesc<T extends { createdAt: string }>(items: T[]) {
	return [...items].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

txRoutes.get("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ sent: [], received: [], source: "none" });
	}

	const paidLinks = await listPaidLinksByOwner(c.env, user.sub, 100);
	const paidLinksByHash = new Map(
		paidLinks
			.filter((link) => link.txHash)
			.map((link) => [link.txHash as string, link]),
	);
	const nativeTokenSymbol = getNetworkConfig(c.env.CHAIN_KEY).nativeTokenSymbol;
	const appSent = (await listSentTransactionsByUid(c.env, user.sub, 100)).map(
		(tx): SentTransactionResponse => ({
			txHash: tx.txHash,
			amount: tx.amount,
			currency: tx.currency,
			to: tx.to,
			createdAt: tx.createdAt,
			kind: "transfer",
		}),
	);
	const appReceived = paidLinks.map(
		(link): ReceivedTransactionResponse => ({
			txHash: link.txHash || "",
			amount: link.amount,
			currency: link.currency,
			reference:
				link.reference ||
				(link.currency === "ETH"
					? `Transferencia ${nativeTokenSymbol}`
					: "Transferencia On-chain"),
			paidBy: link.paidBy || "",
			createdAt: link.paidAt || link.createdAt,
			kind: "link",
		}),
	);

	try {
		const history = await fetchWalletHistory(walletAddress, {
			chainKey: c.env.CHAIN_KEY,
			rpcUrl: c.env.RPC_URL,
		});

		const sent = history
			.filter((item) => item.direction === "sent")
			.map(
				(item): SentTransactionResponse => ({
				txHash: item.txHash,
				amount: item.amount,
				currency: item.currency,
				to: item.counterparty,
				createdAt: item.createdAt,
				kind: "transfer",
				}),
			);

		const received = history
			.filter((item) => item.direction === "received")
			.map((item): ReceivedTransactionResponse => {
				const link = paidLinksByHash.get(item.txHash);
				return {
					txHash: item.txHash,
					amount: item.amount,
					currency: item.currency,
					reference:
						link?.reference ||
						(item.currency === nativeTokenSymbol
							? `Transferencia ${nativeTokenSymbol}`
							: "Transferencia On-chain"),
					paidBy: item.counterparty,
					createdAt: link?.paidAt || item.createdAt,
					kind: link ? "link" : "transfer",
				};
			});

		const sentMap = new Map<string, SentTransactionResponse>();
		for (const item of appSent) {
			sentMap.set(`${item.txHash}:${item.currency}:${item.to}`, item);
		}
		for (const item of sent) {
			sentMap.set(`${item.txHash}:${item.currency}:${item.to}`, item);
		}

		const receivedMap = new Map<string, ReceivedTransactionResponse>();
		for (const item of appReceived) {
			receivedMap.set(`${item.txHash}:${item.currency}`, item);
		}
		for (const item of received) {
			receivedMap.set(`${item.txHash}:${item.currency}`, item);
		}

		return c.json({
			sent: sortByCreatedAtDesc(Array.from(sentMap.values())),
			received: sortByCreatedAtDesc(Array.from(receivedMap.values())),
			source: "hybrid",
		});
	} catch (error) {
		const historyWarning = describeHistoryError(error);
		console.warn("Blockchain history fallback:", historyWarning);
		return c.json({
			sent: sortByCreatedAtDesc(appSent),
			received: sortByCreatedAtDesc(appReceived),
			source: "d1-fallback",
			historyWarning,
		});
	}
});

export default txRoutes;
