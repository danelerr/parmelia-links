import { Hono, type Context } from "hono";
import { getNetworkConfig } from "../../../shared";
import { type AppContext, requireAuth } from "../middlewares/auth";
import {
	ensureHomeBalanceRefresh,
	getHomeVersion,
	homeEtag,
	isHomeBalanceFresh,
	readHomeModel,
} from "../services/homeReadModel";

const homeRoutes = new Hono<AppContext>();

function setPrivateHeaders(
	c: Context<AppContext>,
	etag: string,
	stateVersion: string,
) {
	c.header("Cache-Control", "private, no-cache, max-age=0");
	c.header("Vary", "Authorization");
	c.header("ETag", etag);
	c.header("X-State-Version", stateVersion);
}

homeRoutes.get("/", requireAuth, async (c) => {
	const uid = c.get("user")!.sub;
	const network = getNetworkConfig(c.env.CHAIN_KEY);
	const currentVersion = await getHomeVersion(c.env, uid);
	const etag = await homeEtag(uid, network.chainId, currentVersion.version);
	const stateVersion = `home:${currentVersion.version}`;
	setPrivateHeaders(c, etag, stateVersion);
	if (
		c.req.header("If-None-Match") === etag &&
		(await isHomeBalanceFresh(c.env, uid))
	) {
		return c.body(null, 304);
	}

	const { model, needsRefresh } = await readHomeModel(c.env, uid);
	const refreshAlreadyActive = model.balance.refreshing;
	if (needsRefresh) {
		// D1 deduplicates by (chain, account), then one shared event job drains
		// many wallets through Multicall.
		await ensureHomeBalanceRefresh(
			c.env,
			model,
			"home_missing_asset_bootstrap",
		);
		model.balance.refreshing = true;
	} else if (
		!refreshAlreadyActive &&
		model.balance.status === "stale"
	) {
		// A real read of stale state is a bounded repair signal. This closes the
		// gap left by a missed provider webhook while preserving zero background
		// work when nobody uses the app.
		await ensureHomeBalanceRefresh(
			c.env,
			model,
			"home_visible_stale_repair",
		);
		model.balance.refreshing = true;
	}
	// Home is a read-model endpoint. It may enqueue one D1-coalesced balance
	// repair, but it must never fan a page read out into transfer, recovery and
	// UserOperation indexer partitions. Provider webhooks and the bounded safety
	// sweep own those indexer jobs.
	return c.json(model);
});

export default homeRoutes;
