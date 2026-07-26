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
	if (needsRefresh) {
		// This is a durable D1 enqueue plus optional Queue acceleration. It never
		// waits for or invokes RPC from the request path.
		await ensureHomeBalanceRefresh(c.env, model, "home_missing_asset_bootstrap");
		model.balance.refreshing = true;
	}
	return c.json(model);
});

export default homeRoutes;
