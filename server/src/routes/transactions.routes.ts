// Statement endpoint - reads ONLY the D1 ledger (fast, no RPC/explorer calls).
// The ledger is fed at write time for everything the app relays, and by the
// cron indexer for external incoming transfers.

import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	getUserByUid,
	InvalidLedgerCursorError,
	LEDGER_PAGE_DEFAULT,
	LEDGER_PAGE_MAX,
	listLedgerPageByUid,
} from "../services/storage";
import { ERR } from "../../../shared";

const txRoutes = new Hono<AppContext>();

txRoutes.get("/", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({
			sent: [],
			received: [],
			source: "none",
			nextCursor: null,
		});
	}

	const rawLimit = c.req.query("limit");
	if (
		rawLimit !== undefined &&
		(!/^[1-9][0-9]{0,2}$/u.test(rawLimit) || Number(rawLimit) > LEDGER_PAGE_MAX)
	) {
		return c.json(
			{
				error: `limit must be between 1 and ${LEDGER_PAGE_MAX}`,
				error_code: ERR.INVALID_AMOUNT,
				requestId: c.get("requestId"),
			},
			400,
		);
	}
	let page;
	try {
		page = await listLedgerPageByUid(c.env, user.sub, {
			limit: rawLimit ? Number(rawLimit) : LEDGER_PAGE_DEFAULT,
			before: c.req.query("before") ?? null,
		});
	} catch (error) {
		if (error instanceof InvalidLedgerCursorError) {
			return c.json(
				{
					error: "Invalid transaction cursor",
					error_code: ERR.INVALID_CURSOR,
					requestId: c.get("requestId"),
				},
				400,
			);
		}
		throw error;
	}
	const entries = page.entries;

	const sent = entries
		.filter((e) => e.direction === "out")
		.map((e) => ({
			id: e.id,
			txHash: e.txHash,
			amount: e.amount,
			amountSource: e.amountSource ?? "executed",
			currency: e.token,
			to: e.counterparty ?? "",
			reference: e.reference ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
		}));

	const received = entries
		.filter((e) => e.direction === "in")
		.map((e) => ({
			id: e.id,
			txHash: e.txHash,
			amount: e.amount,
			amountSource: e.amountSource ?? "executed",
			currency: e.token,
			reference: e.reference ?? "",
			paidBy: e.counterparty ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
		}));

	return c.json({
		sent,
		received,
		source: "ledger",
		nextCursor: page.nextCursor,
	});
});

export default txRoutes;
