import { Hono } from "hono";
import { type Hex, encodeFunctionData, encodePacked, parseUnits } from "viem";
import {
	accountWebAuthnV2Abi,
	accountFactoryV2Abi,
	erc20Abi,
	getNetworkConfig,
} from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPendingPayment,
	ensureReferralCode,
	getUserByReferralCode,
	getUserByUid,
	getUserByUsername,
	savePasskey,
	saveUser,
	setInvitedBy,
	writeLedgerEntries,
} from "../services/storage";
import { getClients, getPublicClient, waitForTx } from "../services/clients";
import { buildSponsoredUserOp, serializeBigInts } from "../services/userOp";
import { verifyTurnstile } from "../services/turnstile";

const accountRoutes = new Hono<AppContext>();

/**
 * Build the ERC-7913 signer bytes from the WebAuthn verifier address and P256 public key.
 * Format: abi.encodePacked(verifierAddress, qx, qy) - 84 bytes total.
 */
function buildWebAuthnSigner(verifier: Hex, qx: Hex, qy: Hex): Hex {
	return encodePacked(["address", "bytes32", "bytes32"], [verifier, qx, qy]);
}

/** Build the initialization calldata for AccountWebAuthnV2.initialize(). */
function buildInitCallData(verifier: Hex, qx: Hex, qy: Hex, guardian: `0x${string}`): Hex {
	const signer = buildWebAuthnSigner(verifier, qx, qy);
	return encodeFunctionData({
		abi: accountWebAuthnV2Abi,
		functionName: "initialize",
		args: [[signer], 1n, guardian],
	});
}

async function deployV2Wallet(env: AppContext["Bindings"], params: { qx: Hex; qy: Hex }) {
	const { contracts } = getNetworkConfig(env.CHAIN_KEY);
	const { publicClient, walletClient, serverAccount } = getClients(env);

	// The server EOA is set as guardian so it can propose recovery for the user.
	// Important: the guardian CANNOT move funds or sign transactions. It can ONLY
	// propose a recovery that takes 48h to execute, which the user can cancel.
	const guardianAddress = serverAccount.address;

	const initCallData = buildInitCallData(
		contracts.verifier,
		params.qx,
		params.qy,
		guardianAddress,
	);

	const predictedAddress = (await publicClient.readContract({
		address: contracts.factory,
		abi: accountFactoryV2Abi,
		functionName: "predictAddress",
		args: [initCallData],
	})) as `0x${string}`;

	const transactionHash = await walletClient.writeContract({
		address: contracts.factory,
		abi: accountFactoryV2Abi,
		functionName: "createAccount",
		args: [initCallData],
	});

	await waitForTx(publicClient, transactionHash);

	return { publicClient, walletClient, predictedAddress, transactionHash };
}

// Create account via WebAuthn (V2 - MultiSigner + UUPS)
accountRoutes.post("/create", requireAuth, async (c) => {
	const user = c.get("user")!;
	const existingUser = await getUserByUid(c.env, user.sub);
	if (existingUser?.walletAddress) {
		return c.json({ error: "Account already exists", accountAddress: existingUser.walletAddress }, 409);
	}

	const { credentialId, qx, qy, ref, turnstileToken } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy from passkey" }, 400);
	}

	const humanOk = await verifyTurnstile(c.env, turnstileToken, c.req.header("CF-Connecting-IP"));
	if (!humanOk) {
		return c.json({ error: "No pudimos verificar que eres humano. Recarga e intenta de nuevo." }, 403);
	}

	try {
		const { publicClient, walletClient, predictedAddress, transactionHash } =
			await deployV2Wallet(c.env, { qx: qx as Hex, qy: qy as Hex });

		await saveUser(c.env, {
			uid: user.sub,
			walletAddress: predictedAddress,
			credentialId,
		});
		await savePasskey(c.env, { credentialId, uid: user.sub, qx, qy });
		// Every account gets a shareable invite code from day one.
		await ensureReferralCode(c.env, user.sub).catch(() => null);

		// Referral attribution (best-effort): ?ref=<código o username> captured at landing.
		if (typeof ref === "string" && ref.trim()) {
			try {
				const value = ref.trim();
				const inviter =
					(await getUserByReferralCode(c.env, value)) ??
					(await getUserByUsername(c.env, value.toLowerCase()));
				if (inviter && inviter.uid !== user.sub) {
					await setInvitedBy(c.env, user.sub, inviter.uid);
				}
			} catch (e) {
				console.error("Referral attribution failed:", e);
			}
		}

		// Auto-fund 5 USDC (best-effort)
		try {
			if (!existingUser?.fundedAt) {
				const { usdc, usdcDecimals } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
				const fundAmount = parseUnits("5", usdcDecimals);
				const fundTx = await walletClient.sendTransaction({
					to: usdc,
					data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [predictedAddress, fundAmount] }),
				});
				await waitForTx(publicClient, fundTx);
				await saveUser(c.env, { uid: user.sub, fundedAt: new Date().toISOString() });
				await writeLedgerEntries(c.env, [
					{
						uid: user.sub,
						direction: "in",
						kind: "fund",
						txHash: fundTx,
						token: "USDC",
						amount: "5",
						reference: "Dólares de bienvenida",
						createdAt: new Date().toISOString(),
					},
				]);
			}
		} catch (e) {
			console.error("Auto-fund failed:", e);
		}

		return c.json({ success: true, accountAddress: predictedAddress, transactionHash });
	} catch (error) {
		return c.json({ error: `Failed to create account: ${error}` }, 500);
	}
});

// Passkey + recovery status for the wallet (V2).
accountRoutes.get("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? null;

	const base = {
		hasStoredCredential: !!profile?.credentialId,
		hasWallet: !!walletAddress,
		signerCount: null as number | null,
		threshold: null as number | null,
		guardian: null as string | null,
		recoveryPending: null as boolean | null,
		recoveryExecutableAfter: null as string | null,
	};

	if (!walletAddress) {
		return c.json(base);
	}

	try {
		const publicClient = getPublicClient(c.env);
		const [signerCount, threshold, guardian, recoveryPending, pendingRecovery] =
			await Promise.all([
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getSignerCount" }) as Promise<bigint>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "threshold" }) as Promise<bigint>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "guardian" }) as Promise<`0x${string}`>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "isRecoveryPending" }) as Promise<boolean>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getPendingRecovery" }) as Promise<[bigint, Hex[], bigint]>,
			]);

		const executeAfter = Number(pendingRecovery[0]);
		return c.json({
			...base,
			signerCount: Number(signerCount),
			threshold: Number(threshold),
			guardian,
			recoveryPending,
			recoveryExecutableAfter: executeAfter > 0 ? new Date(executeAfter * 1000).toISOString() : null,
		});
	} catch {
		// Wallet recorded but on-chain reads failed (RPC issue or not yet mined).
		return c.json(base);
	}
});

// Add a new passkey to the existing wallet (V2 - MultiSigner).
// Returns the addSigners calldata; the client signs it as a UserOp via /pay/submit.
accountRoutes.put("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found. Create one first." }, 400);
	}

	const { qx, qy } = await c.req.json();
	if (!qx || !qy) {
		return c.json({ error: "Missing qx or qy" }, 400);
	}

	try {
		const { verifier } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
		const newSigner = buildWebAuthnSigner(verifier, qx as Hex, qy as Hex);
		const addSignerCalldata = encodeFunctionData({
			abi: accountWebAuthnV2Abi,
			functionName: "addSigners",
			args: [[newSigner]],
		});

		return c.json({
			success: true,
			walletAddress: profile.walletAddress,
			addSignerCalldata,
			message: "Use this calldata as the UserOp callData, signed by your current passkey, to add the new passkey to your wallet.",
		});
	} catch (error) {
		return c.json({ error: `Error adding passkey: ${error}` }, 500);
	}
});

accountRoutes.post("/passkey/prepare", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ error: "No wallet found. Create one first." }, 400);
	}

	const { callData } = await c.req.json();
	if (typeof callData !== "string" || !/^0x[0-9a-fA-F]*$/.test(callData)) {
		return c.json({ error: "Invalid callData" }, 400);
	}

	try {
		const { userOp, userOpHash } = await buildSponsoredUserOp(c.env, {
			sender: walletAddress as `0x${string}`,
			callData: callData as Hex,
			verificationGasLimit: 400000n,
			callGasLimit: 250000n,
		});

		await createPendingPayment(c.env, {
			userOpHash,
			linkId: null,
			uid: user.sub,
			amount: "0",
			currency: "PASSKEY_ADD",
			wallet: walletAddress,
			senderAddress: walletAddress,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
		});

		return c.json({ userOpHash, credentialId: profile?.credentialId ?? null });
	} catch (error) {
		return c.json({ error: `Error preparing passkey update: ${error}` }, 500);
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

	const { turnstileToken } = await c.req.json().catch(() => ({ turnstileToken: undefined }));
	const humanOk = await verifyTurnstile(c.env, turnstileToken, c.req.header("CF-Connecting-IP"));
	if (!humanOk) {
		return c.json({ error: "No pudimos verificar que eres humano. Recarga e intenta de nuevo." }, 403);
	}

	try {
		const { usdc, usdcDecimals } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
		const { publicClient, walletClient } = getClients(c.env);

		const fundAmount = parseUnits("5", usdcDecimals);
		const txHash = await walletClient.sendTransaction({
			to: usdc,
			data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [walletAddress as `0x${string}`, fundAmount] }),
		});
		await waitForTx(publicClient, txHash);

		const fundedAt = new Date().toISOString();
		await saveUser(c.env, { uid: user.sub, fundedAt });
		await writeLedgerEntries(c.env, [
			{
				uid: user.sub,
				direction: "in",
				kind: "fund",
				txHash,
				token: "USDC",
				amount: "5",
				reference: "Dólares de prueba",
				createdAt: fundedAt,
			},
		]);
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

// Propose a guardian recovery (48h timelock)
accountRoutes.post("/recovery/propose", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ error: "No wallet found." }, 400);
	}

	const { qx, qy } = await c.req.json();
	if (!qx || !qy) {
		return c.json({ error: "Missing qx or qy" }, 400);
	}

	try {
		const { verifier } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
		const { publicClient, walletClient } = getClients(c.env);

		const isRecoveryPending = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		})) as boolean;
		if (isRecoveryPending) {
			return c.json({ error: "Ya hay una recuperacion en proceso." }, 400);
		}

		const newSigner = buildWebAuthnSigner(verifier, qx as Hex, qy as Hex);
		const txHash = await walletClient.writeContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "proposeRecovery",
			args: [[newSigner], 1n],
		});
		await waitForTx(publicClient, txHash);

		return c.json({ success: true, txHash, message: "Recuperación iniciada. Estará lista en 48 horas." });
	} catch (error) {
		return c.json({ error: `Recovery error: ${error}` }, 500);
	}
});

// Execute a guardian recovery
accountRoutes.post("/recovery/execute", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "No wallet found." }, 400);

	const { credentialId } = await c.req.json();
	if (!credentialId) return c.json({ error: "Missing new credentialId" }, 400);

	try {
		const { publicClient, walletClient } = getClients(c.env);

		const pendingRecovery = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "getPendingRecovery",
		})) as [bigint, Hex[], bigint];

		const executeAfter = Number(pendingRecovery[0]);
		if (executeAfter === 0) return c.json({ error: "No hay recuperacion en proceso." }, 400);
		if (Date.now() / 1000 < executeAfter) {
			return c.json({ error: `La recuperacion estara disponible el ${new Date(executeAfter * 1000).toLocaleString()}` }, 400);
		}

		const txHash = await walletClient.writeContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "executeRecovery",
		});
		await waitForTx(publicClient, txHash);

		await saveUser(c.env, { uid: user.sub, credentialId });

		return c.json({ success: true, txHash, message: "Cuenta recuperada exitosamente." });
	} catch (error) {
		return c.json({ error: `Execution error: ${error}` }, 500);
	}
});

export default accountRoutes;
