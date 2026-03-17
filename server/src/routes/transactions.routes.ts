import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import { fetchWalletHistory } from "../services/blockscout";
import { getUserByUid, listPaidLinksByOwner, listSentTransactionsByUid } from "../services/storage";

const txRoutes = new Hono<AppContext>();

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

	try {
		const history = await fetchWalletHistory(walletAddress);

		const sent = history
			.filter((item) => item.direction === "sent")
			.map((item) => ({
				txHash: item.txHash,
				amount: item.amount,
				currency: item.currency,
				to: item.counterparty,
				createdAt: item.createdAt,
			}));

		const received = history
			.filter((item) => item.direction === "received")
			.map((item) => {
				const link = paidLinksByHash.get(item.txHash);
				return {
					txHash: item.txHash,
					amount: item.amount,
					currency: item.currency,
					reference: link?.reference || (item.currency === "ETH" ? "Transferencia ETH" : "Transferencia On-chain"),
					paidBy: item.counterparty,
					createdAt: link?.paidAt || item.createdAt,
				};
			});

		return c.json({ sent, received, source: "blockchain" });
	} catch (error) {
		console.error("Blockchain history fallback:", error);
		const sent = (await listSentTransactionsByUid(c.env, user.sub, 100)).map((tx) => ({
			txHash: tx.txHash,
			amount: tx.amount,
			currency: tx.currency,
			to: tx.to,
			createdAt: tx.createdAt,
		}));
		const received = paidLinks.map((link) => ({
			txHash: link.txHash || "",
			amount: link.amount,
			currency: link.currency,
			reference: link.reference || (link.currency === "ETH" ? "Transferencia ETH" : "Transferencia On-chain"),
			paidBy: link.paidBy || "",
			createdAt: link.paidAt || link.createdAt,
		}));
		return c.json({ sent, received, source: "d1-fallback" });
	}
});

export default txRoutes;
