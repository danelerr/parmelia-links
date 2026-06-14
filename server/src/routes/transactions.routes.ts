// Statement endpoint - reads ONLY the D1 ledger (fast, no RPC/explorer calls).
// The ledger is fed at write time for everything the app relays, and by the
// cron indexer for external incoming transfers.

import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getUserByUid, listLedgerByUid } from "../services/storage";

const txRoutes = new Hono<AppContext>();

txRoutes.get("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ sent: [], received: [], source: "none" });
	}

	const entries = await listLedgerByUid(c.env, user.sub, 200);

	const sent = entries
		.filter((e) => e.direction === "out")
		.map((e) => ({
			txHash: e.txHash,
			amount: e.amount,
			currency: e.token,
			to: e.counterparty ?? "",
			reference: e.reference ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
		}));

	const received = entries
		.filter((e) => e.direction === "in")
		.map((e) => ({
			txHash: e.txHash,
			amount: e.amount,
			currency: e.token,
			reference: e.reference ?? "",
			paidBy: e.counterparty ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
		}));

	return c.json({ sent, received, source: "ledger" });
});

export default txRoutes;
