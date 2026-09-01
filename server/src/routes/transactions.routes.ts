// Statement endpoint - reads ONLY the D1 ledger (fast, no RPC/explorer calls).
// The ledger is fed at write time for everything the app relays, and by the
// event-driven indexer for external incoming transfers.

import { Hono } from "hono";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	getUserByUid,
	InvalidLedgerCursorError,
	LEDGER_PAGE_DEFAULT,
	LEDGER_PAGE_MAX,
	listLedgerPageByUid,
} from "../services/storage";
import { ERR, NETWORKS, getNetworkConfig } from "../../../shared";

export type LedgerNetworkMetadata = {
	chainId: number;
	chainKey?: string;
	networkName: string;
};

/**
 * Preserve the chain recorded by the ledger. Legacy rows without a chain id
 * belong to the configured home chain, but an explicit unknown id must never
 * be relabelled as home: that would create a plausible yet false receipt.
 */
export function ledgerNetworkMetadata(
	chainId: number | null | undefined,
	homeChainKey: string,
): LedgerNetworkMetadata {
	if (chainId == null) {
		const home = getNetworkConfig(homeChainKey);
		return { chainId: home.chainId, chainKey: home.key, networkName: home.name };
	}
	const known = Object.values(NETWORKS).find((network) => network.chainId === chainId);
	if (known) {
		return { chainId: known.chainId, chainKey: known.key, networkName: known.name };
	}
	return { chainId, networkName: `Chain ID ${chainId}` };
}

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
			...ledgerNetworkMetadata(e.chainId, c.env.CHAIN_KEY),
			id: e.id,
			txHash: e.txHash,
			amount: e.amount,
			amountSource: e.amountSource ?? "executed",
			currency: e.token,
			to: e.counterparty ?? "",
			reference: e.reference ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
			counterpartyUsername: e.counterpartyUsername ?? null,
			counterpartyDisplayName: e.counterpartyDisplayName ?? null,
		}));

	const received = entries
		.filter((e) => e.direction === "in")
		.map((e) => ({
			...ledgerNetworkMetadata(e.chainId, c.env.CHAIN_KEY),
			id: e.id,
			txHash: e.txHash,
			amount: e.amount,
			amountSource: e.amountSource ?? "executed",
			currency: e.token,
			reference: e.reference ?? "",
			paidBy: e.counterparty ?? "",
			createdAt: e.createdAt,
			kind: e.kind,
			counterpartyUsername: e.counterpartyUsername ?? null,
			counterpartyDisplayName: e.counterpartyDisplayName ?? null,
		}));

	return c.json({
		sent,
		received,
		source: "ledger",
		nextCursor: page.nextCursor,
	});
});

export default txRoutes;
