import { Hono } from "hono";
import { createPublicClient, http, formatEther, formatUnits, erc20Abi } from "viem";
import { USDC_ADDRESS, USDC_DECIMALS } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getActiveChain } from "../chain";
import { getUserByUid, getUserByUsername, saveUser } from "../services/storage";

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

	const reserved = [
		"pay", "login", "create", "settings", "admin", "api", "user",
		"cobrar", "pagar", "scan", "links", "account", "status",
		"app", "help", "support", "about", "terms", "privacy",
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

	const publicClient = createPublicClient({
		chain: getActiveChain(c.env.CHAIN_KEY),
		transport: http(c.env.RPC_URL),
	});

	const [ethBalanceWei, usdcBalanceRaw] = await Promise.all([
		publicClient.getBalance({ address: walletAddress as `0x${string}` }),
		publicClient.readContract({
			address: USDC_ADDRESS as `0x${string}`,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [walletAddress as `0x${string}`],
		}) as Promise<bigint>,
	]);

	return c.json({
		eth: formatEther(ethBalanceWei),
		usdc: formatUnits(usdcBalanceRaw, USDC_DECIMALS),
		ethRaw: ethBalanceWei.toString(),
		usdcRaw: usdcBalanceRaw.toString(),
	});
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
