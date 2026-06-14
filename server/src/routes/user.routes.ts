import { Hono } from "hono";
import { formatEther, formatUnits } from "viem";
import { erc20Abi, getNetworkConfig } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getPublicClient } from "../services/clients";
import { getUserByUid, getUserByUsername, saveUser, setPushToken } from "../services/storage";

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
	});
});

// Set username
userRoutes.put("/username", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { username } = await c.req.json();

	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return c.json({ error: "Username invalido. Solo letras minusculas, numeros, guiones. 3-30 caracteres." }, 400);
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
		return c.json({ error: "Username reservado" }, 400);
	}

	const existingUser = await getUserByUsername(c.env, username);
	if (existingUser && existingUser.uid !== user.sub) {
		return c.json({ error: "Username ya esta en uso" }, 409);
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
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "No wallet" }, 404);

	const network = getNetworkConfig(c.env.CHAIN_KEY);
	const { usdc, usdcDecimals } = network.contracts;
	const publicClient = getPublicClient(c.env);
	const account = walletAddress as `0x${string}`;

	// Extra whitelisted ERC-20s beyond USDC (e.g. WBTC) for the swap UI.
	const extraTokens = network.tokens.filter(
		(t) => t.address && t.address.toLowerCase() !== usdc.toLowerCase(),
	);

	const [ethBalanceWei, usdcBalanceRaw, ...extraRaw] = await Promise.all([
		publicClient.getBalance({ address: account }),
		publicClient.readContract({
			address: usdc,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [account],
		}) as Promise<bigint>,
		...extraTokens.map(
			(t) =>
				publicClient.readContract({
					address: t.address!,
					abi: erc20Abi,
					functionName: "balanceOf",
					args: [account],
				}) as Promise<bigint>,
		),
	]);

	const tokens: Record<string, string> = {
		ETH: formatEther(ethBalanceWei),
		USDC: formatUnits(usdcBalanceRaw, usdcDecimals),
	};
	extraTokens.forEach((t, i) => {
		tokens[t.symbol] = formatUnits(extraRaw[i], t.decimals);
	});

	return c.json({
		eth: formatEther(ethBalanceWei),
		usdc: formatUnits(usdcBalanceRaw, usdcDecimals),
		ethRaw: ethBalanceWei.toString(),
		usdcRaw: usdcBalanceRaw.toString(),
		tokens,
	});
});

// Register (or clear) this device's FCM web-push token.
userRoutes.put("/push-token", requireAuth, async (c) => {
	const user = c.get("user")!;
	const { token } = await c.req.json().catch(() => ({ token: null }));
	if (token !== null && (typeof token !== "string" || token.length < 20 || token.length > 4096)) {
		return c.json({ error: "Token inválido" }, 400);
	}
	await setPushToken(c.env, user.sub, token);
	return c.json({ success: true });
});

// Get user by username (public)
userRoutes.get("/:username", async (c) => {
	const username = c.req.param("username");
	const profile = await getUserByUsername(c.env, username);
	if (!profile) return c.json({ error: "User not found" }, 404);

	return c.json({
		username: profile.username,
		walletAddress: profile.walletAddress,
	});
});

export default userRoutes;
