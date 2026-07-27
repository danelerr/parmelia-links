import { Hono } from "hono";
import { getNetworkConfig, ERR } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getUserByUid, getUserByUsername, saveUser, addPushToken, updateProfileFields, rateLimitConsume } from "../services/storage";
import {
	readBalanceModel,
} from "../services/homeReadModel";
import { refreshWalletBalancesLatest } from "../services/balanceReconciler";
import { requestBalanceRefresh } from "../services/balanceReadModel";
import { logError } from "../services/logger";

const userRoutes = new Hono<AppContext>();

// Get user profile
userRoutes.get("/profile", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile) {
		return c.json({
			uid: user.sub,
			walletAddress: null,
			username: null,
		});
	}
	return c.json({
		uid: profile.uid,
		walletAddress: profile.walletAddress,
		username: profile.username,
		displayName: profile.displayName,
		socialUrl: profile.socialUrl,
	});
});

// Public profile fields (shown on the pay page and the public username lookup).
// social_url is an allowlist, not a free URL: anything shown to strangers at
// pay time is phishing surface.
const SOCIAL_URL_RE =
	/^https:\/\/(www\.)?(instagram\.com|x\.com|twitter\.com|t\.me|tiktok\.com|facebook\.com)\/[A-Za-z0-9_.\-@/]{1,80}$/;

userRoutes.put("/profile", requireAuth, async (c) => {
	const user = c.get("user")!;
	const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
	const rawName = typeof body.displayName === "string" ? body.displayName.trim() : "";
	const rawSocial = typeof body.socialUrl === "string" ? body.socialUrl.trim() : "";

	if (rawName.length > 40 || /[<>\r\n]/.test(rawName)) {
		return c.json({ error: "El nombre puede tener hasta 40 caracteres.", error_code: ERR.INVALID_PROFILE }, 400);
	}
	if (rawSocial && !SOCIAL_URL_RE.test(rawSocial)) {
		return c.json({ error: "El enlace debe ser de Instagram, X, Telegram, TikTok o Facebook (https://…).", error_code: ERR.INVALID_PROFILE }, 400);
	}

	await updateProfileFields(c.env, user.sub, {
		displayName: rawName || null,
		socialUrl: rawSocial || null,
	});
	return c.json({ success: true, displayName: rawName || null, socialUrl: rawSocial || null });
});

// Set username
userRoutes.put("/username", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { username } = await c.req.json();

	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return c.json({ error: "Username invalido. Solo letras minusculas, numeros, guiones. 3-30 caracteres.", error_code: ERR.INVALID_USERNAME }, 400);
	}

	// Must cover every client route (the public pay page lives at /:username)
	// plus API roots and common traps. Old Spanish routes kept defensively.
	const reserved = [
		// client routes
		"login", "onboarding", "charge", "send", "scan", "swap",
		"statement", "contacts", "deposit", "settings", "pay", "status",
		// API roots
		"user", "account", "links", "bridge", "api",
		// legacy Spanish routes
		"cobrar", "pagar", "cambiar", "extractos", "contactos", "depositar",
		// common traps
		"admin", "create", "app", "help", "support", "about", "terms", "privacy",
		"parmelia", "www", "root",
	];
	if (reserved.includes(username)) {
		return c.json({ error: "Username reservado", error_code: ERR.USERNAME_RESERVED }, 400);
	}

	const existingUser = await getUserByUsername(c.env, username);
	if (existingUser && existingUser.uid !== user.sub) {
		return c.json({ error: "Username ya esta en uso", error_code: ERR.USERNAME_TAKEN }, 409);
	}

	await saveUser(c.env, {
		uid: user.sub,
		username,
	});

	return c.json({ success: true, username });
});

// Get User Balance
userRoutes.get("/balance", requireAuth, async (c) => {
	const user = c.get("user")!;
	let model = await readBalanceModel(
		c.env,
		user.sub,
	);
	const freshRequested = c.req.query("fresh") === "1";
	const observedAt = model.balance.observedAt
		? Date.parse(model.balance.observedAt)
		: Number.NaN;
	const alreadyFresh =
		Number.isFinite(observedAt) && Date.now() - observedAt < 5_000;

	const freshAllowed =
		!freshRequested ||
		alreadyFresh ||
		(await rateLimitConsume(
			c.env,
			"interactive-balance-refresh",
			user.sub,
			30,
			60,
		));

	if (freshRequested && freshAllowed && model.walletAddress && !alreadyFresh) {
		try {
			const network = getNetworkConfig(c.env.CHAIN_KEY);
			await refreshWalletBalancesLatest(c.env, {
				uid: user.sub,
				accountAddress: model.walletAddress,
				chainId: network.chainId,
			});
			model = await readBalanceModel(c.env, user.sub);
		} catch (error) {
			// Preserve the last known snapshot. Transactional screens can remain
			// usable during a transient RPC outage without inventing a zero.
			logError("interactive_balance_refresh_failed", error, {
				uid: user.sub,
			});
		}
	}

	const { walletAddress, balance, needsRefresh } = model;
	if (!walletAddress) return c.json({ error: "No wallet", error_code: ERR.NO_WALLET }, 404);

	if (needsRefresh) {
		const network = getNetworkConfig(c.env.CHAIN_KEY);
		await requestBalanceRefresh(c.env, {
			uid: user.sub,
			accountAddress: walletAddress,
			chainId: network.chainId,
			reason: "balance_endpoint_missing_asset_bootstrap",
			priority: 1,
		});
		balance.refreshing = true;
	}

	return c.json({
		...balance,
		// Compatibility fields during the Home rollout. Missing/stale data stays
		// null/absent; an RPC failure can never be rendered as a zero balance.
		eth: balance.tokens.ETH ?? null,
		usdc: balance.tokens.USDC ?? null,
		ethRaw: balance.assets.ETH?.raw ?? null,
		usdcRaw: balance.assets.USDC?.raw ?? null,
	});
});

// Register this device's FCM web-push token (one row per device; multi-device).
userRoutes.put("/push-token", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { token } = await c.req.json().catch(() => ({ token: null }));
	if (typeof token !== "string" || token.length < 20 || token.length > 4096) {
		return c.json({ error: "Token inválido", error_code: ERR.INVALID_TOKEN }, 400);
	}
	await addPushToken(c.env, user.sub, token);
	return c.json({ success: true });
});

// Get user by username (public)
userRoutes.get("/:username", async (c) => {
	const username = c.req.param("username");
	const profile = await getUserByUsername(c.env, username);
	if (!profile) return c.json({ error: "User not found", error_code: ERR.USER_NOT_FOUND }, 404);

	return c.json({
		username: profile.username,
		walletAddress: profile.walletAddress,
		displayName: profile.displayName,
		socialUrl: profile.socialUrl,
	});
});

export default userRoutes;
