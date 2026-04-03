import { Hono } from "hono";
import {
	type Hex,
	concat,
	encodeFunctionData,
	encodePacked,
	createPublicClient,
	createWalletClient,
	http,
	pad,
	parseUnits,
	toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getActiveChain } from "../chain";
import {
	accountWebAuthnV2Abi,
	ENTRYPOINT_ADDRESS,
	FACTORY_ADDRESS,
	PAYMASTER_ADDRESS,
	VERIFIER_ADDRESS,
	accountFactoryV2Abi,
	entryPointAbi,
	erc20Abi,
	USDC_ADDRESS,
	USDC_DECIMALS,
} from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPendingPayment,
	getUserByUid,
	reassignPendingLinksWallet,
	saveUser,
} from "../services/storage";
import { buildSignedPaymasterAndData } from "../services/paymaster";

const accountRoutes = new Hono<AppContext>();

function serializeBigInts(obj: unknown): unknown {
	if (typeof obj === "bigint") return "0x" + obj.toString(16);
	if (Array.isArray(obj)) return obj.map(serializeBigInts);
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(
			Object.entries(obj).map(([key, value]) => [key, serializeBigInts(value)]),
		);
	}
	return obj;
}

/**
 * Build the ERC-7913 signer bytes from the WebAuthn verifier address and P256 public key.
 * Format: abi.encodePacked(verifierAddress, qx, qy) — 84 bytes total.
 */
function buildWebAuthnSigner(verifier: Hex, qx: Hex, qy: Hex): Hex {
	return encodePacked(
		["address", "bytes32", "bytes32"],
		[verifier as `0x${string}`, qx as `0x${string}`, qy as `0x${string}`],
	);
}

/**
 * Build the initialization calldata for AccountWebAuthnV2.initialize().
 * This is used both for predictAddress and createAccount.
 */
function buildInitCallData(
	verifier: Hex,
	qx: Hex,
	qy: Hex,
	guardian: `0x${string}`,
): Hex {
	const signer = buildWebAuthnSigner(verifier, qx, qy);
	return encodeFunctionData({
		abi: accountWebAuthnV2Abi,
		functionName: "initialize",
		args: [[signer], 1n, guardian],
	});
}

function getClients(env: AppContext["Bindings"]) {
	const chain = getActiveChain(env.CHAIN_KEY);
	const publicClient = createPublicClient({
		chain,
		transport: http(env.RPC_URL),
	});
	const serverAccount = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
	const walletClient = createWalletClient({
		chain,
		transport: http(env.RPC_URL),
		account: serverAccount,
	});

	return { publicClient, walletClient, serverAccount };
}

async function isV2Wallet(
	publicClient: ReturnType<typeof createPublicClient>,
	walletAddress: `0x${string}`,
) {
	try {
		await publicClient.readContract({
			address: walletAddress,
			abi: accountWebAuthnV2Abi,
			functionName: "getSignerCount",
		});
		return true;
	} catch {
		return false;
	}
}

async function deployV2Wallet(
	env: AppContext["Bindings"],
	params: { qx: Hex; qy: Hex },
) {
	const { publicClient, walletClient, serverAccount } = getClients(env);

	// The server EOA is set as guardian so it can propose recovery for the user.
	// Important: the guardian CANNOT move funds or sign transactions.
	// The guardian can ONLY propose a recovery that takes 48h to execute,
	// and the user can cancel it within that window.
	const guardianAddress = serverAccount.address;

	const initCallData = buildInitCallData(
		VERIFIER_ADDRESS as Hex,
		params.qx,
		params.qy,
		guardianAddress,
	);

	const predictedAddress = (await publicClient.readContract({
		address: FACTORY_ADDRESS as `0x${string}`,
		abi: accountFactoryV2Abi,
		functionName: "predictAddress",
		args: [initCallData],
	})) as `0x${string}`;

	const transactionHash = await walletClient.writeContract({
		address: FACTORY_ADDRESS as `0x${string}`,
		abi: accountFactoryV2Abi,
		functionName: "createAccount",
		args: [initCallData],
	});

	await publicClient.waitForTransactionReceipt({ hash: transactionHash });

	return {
		publicClient,
		walletClient,
		predictedAddress,
		transactionHash,
	};
}

// Create account via WebAuthn (V2 — MultiSigner + UUPS)
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
		const { publicClient, walletClient, predictedAddress, transactionHash } =
			await deployV2Wallet(c.env, {
				qx: qx as Hex,
				qy: qy as Hex,
			});

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

		return c.json({
			success: true,
			accountAddress: predictedAddress,
			transactionHash,
		});
	} catch (error) {
		return c.json({ error: `Failed to create account: ${error}` }, 500);
	}
});

// Passkey info
accountRoutes.get("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? null;

	const response = {
		hasStoredCredential: !!profile?.credentialId,
		hasWallet: !!walletAddress,
		recoveryMode: profile?.credentialId ? "stored" : "discoverable",
		accountVersion: "unknown" as "unknown" | "legacy" | "v2",
		supportsPasskeyManagement: false,
		signerCount: null as number | null,
		threshold: null as number | null,
		guardian: null as string | null,
		recoveryPending: null as boolean | null,
		recoveryExecutableAfter: null as string | null,
	};

	if (!walletAddress) {
		return c.json(response);
	}

	try {
		const publicClient = createPublicClient({
			chain: getActiveChain(c.env.CHAIN_KEY),
			transport: http(c.env.RPC_URL),
		});

		const [signerCount, threshold, guardian, recoveryPending, pendingRecovery] =
			await Promise.all([
				publicClient.readContract({
					address: walletAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "getSignerCount",
				}) as Promise<bigint>,
				publicClient.readContract({
					address: walletAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "threshold",
				}) as Promise<bigint>,
				publicClient.readContract({
					address: walletAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "guardian",
				}) as Promise<`0x${string}`>,
				publicClient.readContract({
					address: walletAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "isRecoveryPending",
				}) as Promise<boolean>,
				publicClient.readContract({
					address: walletAddress as `0x${string}`,
					abi: accountWebAuthnV2Abi,
					functionName: "getPendingRecovery",
				}) as Promise<[bigint, Hex[], bigint]>,
			]);

		const executeAfter = Number(pendingRecovery[0]);

		return c.json({
			...response,
			accountVersion: "v2" as const,
			supportsPasskeyManagement: true,
			signerCount: Number(signerCount),
			threshold: Number(threshold),
			guardian,
			recoveryPending,
			recoveryExecutableAfter:
				executeAfter > 0 ? new Date(executeAfter * 1000).toISOString() : null,
		});
	} catch {
		return c.json({
			...response,
			accountVersion: "legacy" as const,
		});
	}
});

accountRoutes.post("/migrate", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const currentWalletAddress = profile?.walletAddress ?? undefined;

	if (!currentWalletAddress) {
		return c.json({ error: "No wallet found. Create one first." }, 400);
	}

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy from passkey" }, 400);
	}

	try {
		const { publicClient } = getClients(c.env);
		const alreadyV2 = await isV2Wallet(
			publicClient,
			currentWalletAddress as `0x${string}`,
		);
		if (alreadyV2) {
			return c.json(
				{
					error: "Esta wallet ya es V2. Usa agregar passkey en vez de migrar.",
				},
				409,
			);
		}

		const { predictedAddress, transactionHash } = await deployV2Wallet(c.env, {
			qx: qx as Hex,
			qy: qy as Hex,
		});

		const updatedPendingLinks = await reassignPendingLinksWallet(c.env, {
			ownerUid: user.sub,
			fromWallet: currentWalletAddress,
			toWallet: predictedAddress,
		});

		// Reset the faucet flag so the new wallet can be funded explicitly if needed.
		await saveUser(c.env, {
			uid: user.sub,
			walletAddress: predictedAddress,
			credentialId,
			fundedAt: null,
		});

		return c.json({
			success: true,
			accountAddress: predictedAddress,
			previousWalletAddress: currentWalletAddress,
			transactionHash,
			updatedPendingLinks,
			manualMigrationRequired:
				currentWalletAddress.toLowerCase() !== predictedAddress.toLowerCase(),
		});
	} catch (error) {
		return c.json({ error: `Failed to migrate account: ${error}` }, 500);
	}
});

// Add a new passkey to the existing wallet (V2 — MultiSigner)
// This replaces the dangerous V1 "PUT /passkey" that deployed a new wallet.
// Now it returns the calldata that the user must sign via UserOp to add the new signer.
accountRoutes.put("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);

	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found. Create one first." }, 400);
	}

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy" }, 400);
	}

	try {
		const { publicClient } = getClients(c.env);
		const supportsPasskeyManagement = await isV2Wallet(
			publicClient,
			profile.walletAddress as `0x${string}`,
		);
		if (!supportsPasskeyManagement) {
			return c.json(
				{
					error:
						"Wallet legacy detectada. Migra primero a V2 para agregar passkeys en la misma direccion.",
				},
				409,
			);
		}

		// Build the new signer bytes
		const newSigner = buildWebAuthnSigner(
			VERIFIER_ADDRESS as Hex,
			qx as Hex,
			qy as Hex,
		);

		// Build the calldata for addSigners — this must be sent as a UserOp
		// signed by the user's current passkey.
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
		const publicClient = createPublicClient({
			chain: getActiveChain(c.env.CHAIN_KEY),
			transport: http(c.env.RPC_URL),
		});

		const nonce = (await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getNonce",
			args: [walletAddress as `0x${string}`, 0n],
		})) as bigint;

		const gasPrice = await publicClient.getGasPrice();
		const maxFeePerGas = gasPrice * 2n;
		const maxPriorityFeePerGas =
			gasPrice / 10n > 1000000n ? gasPrice / 10n : 1000000n;

		const accountGasLimits = concat([
			pad(toHex(400000n), { size: 16 }),
			pad(toHex(250000n), { size: 16 }),
		]) as Hex;
		const gasFees = concat([
			pad(toHex(maxPriorityFeePerGas), { size: 16 }),
			pad(toHex(maxFeePerGas), { size: 16 }),
		]) as Hex;
		const userOp = {
			sender: walletAddress as `0x${string}`,
			nonce,
			initCode: "0x" as Hex,
			callData: callData as Hex,
			accountGasLimits,
			preVerificationGas: 100000n,
			gasFees,
			paymasterAndData: "0x" as Hex,
			signature: "0x" as Hex,
		};

		const chainId = await publicClient.getChainId();
		const paymasterSignerPrivateKey = (c.env.PAYMASTER_SIGNER_PRIVATE_KEY ||
			c.env.PRIVATE_KEY) as `0x${string}`;
		userOp.paymasterAndData = await buildSignedPaymasterAndData({
			chainId,
			paymasterAddress: PAYMASTER_ADDRESS as `0x${string}`,
			userOp,
			signerPrivateKey: paymasterSignerPrivateKey,
		});

		const userOpHash = (await publicClient.readContract({
			address: ENTRYPOINT_ADDRESS as `0x${string}`,
			abi: entryPointAbi,
			functionName: "getUserOpHash",
			args: [userOp],
		})) as Hex;

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

		return c.json({
			userOpHash,
			credentialId: profile?.credentialId ?? null,
		});
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

	try {
		const serverAccount = privateKeyToAccount(c.env.PRIVATE_KEY as `0x${string}`);
		const publicClient = createPublicClient({ chain: getActiveChain(c.env.CHAIN_KEY), transport: http(c.env.RPC_URL) });
		const walletClient = createWalletClient({ chain: getActiveChain(c.env.CHAIN_KEY), transport: http(c.env.RPC_URL), account: serverAccount });

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

accountRoutes.post("/reset-wallet", requireAuth, async (c) => {
	const user = c.get("user")!;
	
	await c.env.PARMELIA_DB.prepare(
		`UPDATE users SET wallet_address = NULL, credential_id = NULL, funded_at = NULL WHERE uid = ?`
	).bind(user.sub).run();

	return c.json({ success: true, message: "Cuenta reseteada. Puedes crear una nueva wallet." });
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
		const { publicClient, walletClient, serverAccount } = getClients(c.env);
		
		const isV2 = await isV2Wallet(publicClient, walletAddress as `0x${string}`);
		if (!isV2) return c.json({ error: "Recovery only available for V2 wallets." }, 400);

		const isRecoveryPending = await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		}) as boolean;

		if (isRecoveryPending) {
			return c.json({ error: "Ya hay una recuperacion en proceso." }, 400);
		}

		const newSigner = buildWebAuthnSigner(VERIFIER_ADDRESS as Hex, qx as Hex, qy as Hex);

		const txHash = await walletClient.writeContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "proposeRecovery",
			args: [[newSigner], 1n],
		});

		await publicClient.waitForTransactionReceipt({ hash: txHash });

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
		
		const pendingRecovery = await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "getPendingRecovery",
		}) as [bigint, Hex[], bigint];

		const executeAfter = Number(pendingRecovery[0]);
		if (executeAfter === 0) return c.json({ error: "No hay recuperacion en proceso." }, 400);
		if (Date.now() / 1000 < executeAfter) {
			return c.json({ error: `La recuperacion estara disponible el ${new Date(executeAfter * 1000).toLocaleString()}` }, 400);
		}

		// Execute recovery using standard transaction (walletClient is the guardian/relayer)
		const txHash = await walletClient.writeContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "executeRecovery",
		});

		await publicClient.waitForTransactionReceipt({ hash: txHash });

		// Update DB to the new credentialId
		await saveUser(c.env, {
			uid: user.sub,
			credentialId,
		});

		return c.json({ success: true, txHash, message: "Cuenta recuperada exitosamente." });
	} catch (error) {
		return c.json({ error: `Execution error: ${error}` }, 500);
	}
});

export default accountRoutes;
