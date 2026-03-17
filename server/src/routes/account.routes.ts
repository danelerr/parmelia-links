import { Hono } from "hono";
import {
	type Hex,
	encodeFunctionData,
	createPublicClient,
	createWalletClient,
	http,
	parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
	accountWebAuthnAbi,
	FACTORY_ADDRESS,
	accountFactoryAbi,
	erc20Abi,
	USDC_ADDRESS,
	USDC_DECIMALS,
} from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getUserByUid, saveUser } from "../services/storage";

const accountRoutes = new Hono<AppContext>();

// Create account via WebAuthn
accountRoutes.post("/create", requireAuth, async (c) => {
	const user = c.get("user")!;
	const existingUser = await getUserByUid(c.env, user.sub);
	if (existingUser?.walletAddress) {
		return c.json({ error: "Account already exists", accountAddress: existingUser.walletAddress }, 409);
	}

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy from passkey" }, 400);
	}

	try {
		const publicClient = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const walletClient = createWalletClient({ chain: baseSepolia, transport: http(c.env.RPC_URL), account: serverAccount });

		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx as Hex, qy as Hex],
		});

		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;

		const hash = await walletClient.writeContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "cloneAndInitialize",
			args: [initCallData],
		});

		await publicClient.waitForTransactionReceipt({ hash });

		await saveUser(c.env, {
			uid: user.sub,
			walletAddress: predictedAddress,
			credentialId,
		});

		// Auto-fund 5 USDC (best-effort)
		try {
			if (!existingUser?.fundedAt) {
				const fundAmount = parseUnits("5", USDC_DECIMALS);
				const fundTx = await walletClient.sendTransaction({
					to: USDC_ADDRESS as `0x${string}`,
					data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [predictedAddress, fundAmount] }),
				});
				await publicClient.waitForTransactionReceipt({ hash: fundTx });
				await saveUser(c.env, {
					uid: user.sub,
					fundedAt: new Date().toISOString(),
				});
			}
		} catch (e) {
			console.error("Auto-fund failed:", e);
		}

		return c.json({ success: true, accountAddress: predictedAddress, transactionHash: hash });
	} catch (error) {
		return c.json({ error: `Failed to create account: ${error}` }, 500);
	}
});

// Passkey info
accountRoutes.get("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	return c.json({
		hasStoredCredential: !!profile?.credentialId,
		hasWallet: !!profile?.walletAddress,
		recoveryMode: profile?.credentialId ? "stored" : "discoverable",
	});
});

// Legacy migration
accountRoutes.put("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const oldWalletAddress = profile?.walletAddress ?? undefined;

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy" }, 400);
	}

	try {
		const publicClient = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const walletClient = createWalletClient({ chain: baseSepolia, transport: http(c.env.RPC_URL), account: serverAccount });

		const initCallData = encodeFunctionData({
			abi: accountWebAuthnAbi,
			functionName: "initializeWebAuthn",
			args: [qx as Hex, qy as Hex],
		});

		const predictedAddress = (await publicClient.readContract({
			address: FACTORY_ADDRESS,
			abi: accountFactoryAbi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;

		const code = await publicClient.getCode({ address: predictedAddress });
		if (!code || code === "0x") {
			const hash = await walletClient.writeContract({
				address: FACTORY_ADDRESS,
				abi: accountFactoryAbi,
				functionName: "cloneAndInitialize",
				args: [initCallData],
			});
			await publicClient.waitForTransactionReceipt({ hash });
		}

		await saveUser(c.env, {
			uid: user.sub,
			walletAddress: predictedAddress,
			credentialId,
		});

		try {
			if (!profile?.fundedAt) {
				const fundTx = await walletClient.sendTransaction({
					to: USDC_ADDRESS as `0x${string}`,
					data: encodeFunctionData({
						abi: erc20Abi,
						functionName: "transfer",
						args: [predictedAddress, parseUnits("5", USDC_DECIMALS)],
					}),
				});
				await publicClient.waitForTransactionReceipt({ hash: fundTx });
				await saveUser(c.env, {
					uid: user.sub,
					fundedAt: new Date().toISOString(),
				});
			}
		} catch (e) {
			console.error("Auto-fund failed:", e);
		}

		return c.json({
			success: true,
			walletChanged: oldWalletAddress !== predictedAddress,
			newWalletAddress: predictedAddress,
		});
	} catch (error) {
		return c.json({ error: `Error al actualizar passkey: ${error}` }, 500);
	}
});

accountRoutes.post("/fund", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "Necesitas crear una wallet primero" }, 400);

	if (profile?.fundedAt) {
		return c.json({ error: "Ya canjeaste tus 5 USDC de prueba", alreadyFunded: true }, 409);
	}

	try {
		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const publicClient = createPublicClient({ chain: baseSepolia, transport: http(c.env.RPC_URL) });
		const walletClient = createWalletClient({ chain: baseSepolia, transport: http(c.env.RPC_URL), account: serverAccount });

		const fundAmount = parseUnits("5", USDC_DECIMALS);
		const txHash = await walletClient.sendTransaction({
			to: USDC_ADDRESS as `0x${string}`,
			data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [walletAddress as `0x${string}`, fundAmount] }),
		});
		await publicClient.waitForTransactionReceipt({ hash: txHash });

		const fundedAt = new Date().toISOString();
		await saveUser(c.env, { uid: user.sub, fundedAt });
		return c.json({ success: true, txHash, amount: "5", currency: "USDC" });
	} catch (error) {
		return c.json({ error: `Error al fondear cuenta: ${error}` }, 500);
	}
});

accountRoutes.get("/fund", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	return c.json({ funded: !!profile?.fundedAt, fundedAt: profile?.fundedAt || null });
});

export default accountRoutes;
