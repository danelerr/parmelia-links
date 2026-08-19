import { Hono } from "hono";
import { type Hex, encodeFunctionData, encodePacked } from "viem";
import {
	accountWebAuthnV2Abi,
	accountFactoryV2Abi,
	assertContractsDeployed,
	getNetworkConfig,
	ERR,
} from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPendingPayment,
	getAccountOperationById,
	getActiveAccountOperation,
	getUserByUid,
	rateLimitConsume,
} from "../services/storage";
import {
	getPublicClient,
	getRecoveryGuardianAccount,
	getServerAccount,
} from "../services/clients";
import {
	AccountOperationBusyError,
	FaucetBudgetExhaustedError,
	getFaucetPolicy,
	reconcileAccountOperation,
	startFaucetOperation,
	submitAccountOperation,
	toAccountOperationView,
} from "../services/accountOperations";
import { buildSponsoredUserOp, matchOnchainSigner, serializeBigInts } from "../services/userOp";
import { verifyTurnstile } from "../services/turnstile";
import { logError } from "../services/logger";
import { selectUserOperationTransport } from "../services/userOperationTransport";

const accountRoutes = new Hono<AppContext>();

function operationPayload(operation: Parameters<typeof toAccountOperationView>[0]) {
	const { id, ...view } = toAccountOperationView(operation);
	return { operationId: id, ...view };
}

async function guardianSignerForAccount(
	env: AppContext["Bindings"],
	publicClient: ReturnType<typeof getPublicClient>,
	walletAddress: `0x${string}`,
): Promise<"guardian" | "server"> {
	const guardian = (await publicClient.readContract({
		address: walletAddress,
		abi: accountWebAuthnV2Abi,
		functionName: "guardian",
	})) as `0x${string}`;
	const dedicated = getRecoveryGuardianAccount(env);
	if (guardian.toLowerCase() === dedicated.address.toLowerCase()) {
		return "guardian";
	}
	const network = getNetworkConfig(env.CHAIN_KEY);
	const legacy = getServerAccount(env);
	if (network.isTestnet && guardian.toLowerCase() === legacy.address.toLowerCase()) {
		return "server";
	}
	throw new Error("Configured recovery guardian does not control this account");
}

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

async function prepareV2WalletDeployment(env: AppContext["Bindings"], params: { qx: Hex; qy: Hex }) {
	const network = getNetworkConfig(env.CHAIN_KEY);
	// Fail closed on TODO_DEPLOY placeholders (e.g. arbitrum-one pre-deploy).
	assertContractsDeployed(network, ["factory", "verifier", "paymaster"]);
	const { contracts } = network;
	const publicClient = getPublicClient(env);

	// The server EOA is set as guardian so it can propose recovery for the user.
	// Important: the guardian CANNOT move funds or sign transactions. It can ONLY
	// propose a recovery that takes 48h to execute, which the user can cancel.
	const guardianAddress = getRecoveryGuardianAccount(env).address;

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

	return {
		predictedAddress,
		factory: contracts.factory,
		data: encodeFunctionData({
			abi: accountFactoryV2Abi,
			functionName: "createAccount",
			args: [initCallData],
		}),
	};
}

// Create account via WebAuthn (V2 - MultiSigner + UUPS)
accountRoutes.post("/create", requireAuth, async (c) => {
	const user = c.get("user")!;
	const requestId = c.get("requestId");
	const existingUser = await getUserByUid(c.env, user.sub);
	if (existingUser?.walletAddress) {
		return c.json({ error: "Account already exists", error_code: ERR.ACCOUNT_EXISTS, accountAddress: existingUser.walletAddress }, 409);
	}

	const { credentialId, qx, qy, ref, turnstileToken } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy from passkey", error_code: ERR.MISSING_PASSKEY_DATA }, 400);
	}
	const active = await getActiveAccountOperation(c.env, user.sub, "account_create");
	if (active) {
		return c.json({ ...operationPayload(active), accountAddress: active.metadata.walletAddress ?? null }, 202);
	}

	// Defense in depth behind Turnstile: creating an account deploys a contract
	// and funds a faucet with an operational EOA's gas/USDC — cap the per-IP rate.
	const ip = c.req.header("CF-Connecting-IP") || "unknown";
	if (!(await rateLimitConsume(c.env, "acct-create", ip, 5, 3600, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}

	const humanOk = await verifyTurnstile(c.env, turnstileToken, c.req.header("CF-Connecting-IP"));
	if (!humanOk) {
		return c.json({ error: "No pudimos verificar que eres humano. Recarga e intenta de nuevo.", error_code: ERR.HUMAN_VERIFY_FAILED }, 403);
	}

	try {
		const { predictedAddress, factory, data } = await prepareV2WalletDeployment(c.env, {
			qx: qx as Hex,
			qy: qy as Hex,
		});
		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "account_create",
			to: factory,
			data,
			metadata: {
				walletAddress: predictedAddress,
				credentialId,
				qx,
				qy,
				ref: typeof ref === "string" ? ref.trim() : "",
			},
		});
		return c.json({ ...operationPayload(operation), accountAddress: predictedAddress }, 202);
	} catch (error) {
		logError("account_create_failed", error, { requestId, uid: user.sub });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El relayer está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE, requestId }, 503);
		}
		return c.json({ error: "No pudimos crear la cuenta. Intenta de nuevo.", error_code: ERR.SERVER_ERROR, requestId }, 500);
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
		// Registered ERC-7913 signer bytes. The client matches its remembered
		// passkeys (qx||qy suffix) against these to answer the question the
		// signerCount tile can't: "can THIS device sign?" (jul-2026 field bug:
		// Settings said "1 llave activa" while paying said "no key" — both true,
		// one on-chain, one per-device).
		signers: null as string[] | null,
	};

	if (!walletAddress) {
		return c.json(base);
	}

	try {
		const publicClient = getPublicClient(c.env);
		const [signerCount, threshold, guardian, recoveryPending, pendingRecovery, signers] =
			await Promise.all([
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getSignerCount" }) as Promise<bigint>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "threshold" }) as Promise<bigint>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "guardian" }) as Promise<`0x${string}`>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "isRecoveryPending" }) as Promise<boolean>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getPendingRecovery" }) as Promise<[bigint, Hex[], bigint]>,
				publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getSigners", args: [0n, 32n] }) as Promise<Hex[]>,
			]);

		const executeAfter = Number(pendingRecovery[0]);
		return c.json({
			...base,
			signerCount: Number(signerCount),
			threshold: Number(threshold),
			guardian,
			recoveryPending,
			recoveryExecutableAfter: executeAfter > 0 ? new Date(executeAfter * 1000).toISOString() : null,
			signers,
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
		return c.json({ error: "No wallet found. Create one first.", error_code: ERR.NO_WALLET }, 400);
	}

	const { qx, qy } = await c.req.json();
	if (!qx || !qy) {
		return c.json({ error: "Missing qx or qy", error_code: ERR.MISSING_PASSKEY_DATA }, 400);
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
		logError("account_add_passkey_failed", error, { uid: user.sub });
		return c.json({ error: "No pudimos preparar la nueva passkey. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

accountRoutes.post("/passkey/prepare", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ error: "No wallet found. Create one first.", error_code: ERR.NO_WALLET }, 400);
	}

	const { callData } = await c.req.json();
	if (typeof callData !== "string" || !/^0x[0-9a-fA-F]*$/.test(callData)) {
		return c.json({ error: "Invalid callData", error_code: ERR.INVALID_CALLDATA }, 400);
	}

	try {
		const submissionTransport = selectUserOperationTransport(c.env, user.sub);
		const { userOp, userOpHash, signingPayload } = await buildSponsoredUserOp(c.env, {
			sender: walletAddress as `0x${string}`,
			callData: callData as Hex,
			verificationGasLimit: 400000n,
			callGasLimit: 250000n,
			transportMode: submissionTransport,
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
			submissionTransport,
		});

		return c.json({
			userOpHash,
			credentialId: profile?.credentialId ?? null,
			submissionTransport,
			signingPayload,
		});
	} catch (error) {
		logError("account_passkey_prepare_failed", error, { uid: user.sub });
		return c.json({ error: "No pudimos preparar la operación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

accountRoutes.post("/fund", requireAuth, async (c) => {
	const user = c.get("user")!;
	if (!getFaucetPolicy(c.env).enabled) {
		return c.json({ error: "El faucet no está disponible en esta red.", error_code: ERR.FAUCET_DISABLED }, 403);
	}
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "Necesitas crear una wallet primero", error_code: ERR.NO_WALLET }, 400);
	const active = await getActiveAccountOperation(c.env, user.sub, "faucet");
	if (active) return c.json({ ...operationPayload(active), amount: "5", currency: "USDC" }, 202);

	if (profile?.fundedAt) {
		return c.json({ error: "Ya canjeaste tus 5 USDC de prueba", error_code: ERR.FAUCET_ALREADY_CLAIMED, alreadyFunded: true }, 409);
	}

	// The faucet moves real USDC from its dedicated account: cap attempts per user.
	if (!(await rateLimitConsume(c.env, "acct-fund", user.sub, 5, 3600, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}

	const { turnstileToken } = await c.req.json().catch(() => ({ turnstileToken: undefined }));
	const humanOk = await verifyTurnstile(c.env, turnstileToken, c.req.header("CF-Connecting-IP"));
	if (!humanOk) {
		return c.json({ error: "No pudimos verificar que eres humano. Recarga e intenta de nuevo.", error_code: ERR.HUMAN_VERIFY_FAILED }, 403);
	}

	try {
		const started = await startFaucetOperation(c.env, {
			uid: user.sub,
			walletAddress: walletAddress as `0x${string}`,
			reference: "Dólares de prueba",
		});
		if (!started) {
			return c.json({ error: "Ya canjeaste tus 5 USDC de prueba", error_code: ERR.FAUCET_ALREADY_CLAIMED, alreadyFunded: true }, 409);
		}
		return c.json({ ...operationPayload(started.operation), amount: "5", currency: "USDC" }, 202);
	} catch (error) {
		logError("account_fund_failed", error, { uid: user.sub });
		if (error instanceof FaucetBudgetExhaustedError) {
			return c.json({ error: "El presupuesto diario del faucet se agotó.", error_code: ERR.RATE_LIMITED }, 429);
		}
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El relayer está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos enviar los fondos de prueba. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

accountRoutes.get("/fund", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	return c.json({ funded: !!profile?.fundedAt, fundedAt: profile?.fundedAt || null });
});

accountRoutes.get("/operations/:id", requireAuth, async (c) => {
	const user = c.get("user")!;
	const operationId = c.req.param("id");
	if (!operationId) {
		return c.json({ error: "No encontramos esa operación.", error_code: ERR.OPERATION_NOT_FOUND }, 404);
	}
	let operation = await getAccountOperationById(c.env, operationId);
	if (!operation) {
		return c.json({ error: "No encontramos esa operación.", error_code: ERR.OPERATION_NOT_FOUND }, 404);
	}
	if (operation.uid !== user.sub) {
		return c.json({ error: "Esta operación pertenece a otra cuenta.", error_code: ERR.WRONG_ACCOUNT }, 403);
	}
	if (operation.status === "prepared" || operation.status === "submitted") {
		operation = await reconcileAccountOperation(c.env, operation);
	}
	if (!operation) {
		return c.json({ error: "No encontramos esa operación.", error_code: ERR.OPERATION_NOT_FOUND }, 404);
	}
	return c.json(operationPayload(operation));
});

// Propose a guardian recovery (48h timelock)
accountRoutes.post("/recovery/propose", requireAuth, async (c) => {
	const user = c.get("user")!;
	if (!(await rateLimitConsume(c.env, "recovery-propose", user.sub, 3, 86400, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	}

	const { qx, qy } = await c.req.json();
	if (!qx || !qy) {
		return c.json({ error: "Missing qx or qy", error_code: ERR.MISSING_PASSKEY_DATA }, 400);
	}
	const active = await getActiveAccountOperation(c.env, user.sub, "recovery_propose");
	if (active) {
		if (active.metadata.qx === qx && active.metadata.qy === qy) {
			return c.json({ ...operationPayload(active), message: "Recuperación en proceso." }, 202);
		}
		return c.json({ error: "Ya hay una recuperación en proceso.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
	}

	try {
		const { verifier } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
		const publicClient = getPublicClient(c.env);

		const isRecoveryPending = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		})) as boolean;
		if (isRecoveryPending) {
			return c.json({ error: "Ya hay una recuperacion en proceso.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
		}
		const signer = await guardianSignerForAccount(c.env, publicClient, walletAddress as `0x${string}`);

		const newSigner = buildWebAuthnSigner(verifier, qx as Hex, qy as Hex);
		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "recovery_propose",
			to: walletAddress as `0x${string}`,
			data: encodeFunctionData({
				abi: accountWebAuthnV2Abi,
				functionName: "proposeRecovery",
				args: [[newSigner], 1n],
			}),
			metadata: { walletAddress, qx, qy },
			signer,
		});
		return c.json({ ...operationPayload(operation), message: "Recuperación iniciada. Estará lista en 48 horas." }, 202);
	} catch (error) {
		logError("account_recovery_propose_failed", error, { uid: user.sub });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El guardian está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos iniciar la recuperación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

// Execute a guardian recovery
accountRoutes.post("/recovery/execute", requireAuth, async (c) => {
	const user = c.get("user")!;
	if (!(await rateLimitConsume(c.env, "recovery-execute", user.sub, 10, 3600, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);

	const { credentialId, qx, qy } = await c.req.json();
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy", error_code: ERR.MISSING_PASSKEY_DATA }, 400);
	}
	const active = await getActiveAccountOperation(c.env, user.sub, "recovery_execute");
	if (active) {
		if (active.metadata.qx === qx && active.metadata.qy === qy) {
			return c.json({ ...operationPayload(active), message: "Recuperación en ejecución." }, 202);
		}
		return c.json({ error: "Ya hay una recuperación en ejecución.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
	}

	try {
		const publicClient = getPublicClient(c.env);

		const pendingRecovery = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "getPendingRecovery",
		})) as [bigint, Hex[], bigint];

		const executeAfter = Number(pendingRecovery[0]);
		if (executeAfter === 0) return c.json({ error: "No hay recuperacion en proceso.", error_code: ERR.RECOVERY_NONE }, 409);
		if (Date.now() / 1000 < executeAfter) {
			return c.json({ error: `La recuperacion estara disponible el ${new Date(executeAfter * 1000).toLocaleString()}`, error_code: ERR.RECOVERY_NOT_READY }, 409);
		}

		// executeRecovery REPLACES all signers with the proposed set. If the
		// credential the client sends isn't the proposed one (stale localStorage,
		// a different device), storing it would leave the account with a passkey
		// that can't sign. Match by qx||qy suffix — NOT by rebuilding the full
		// signer bytes with the current verifier, which would false-negative if
		// the verifier was redeployed inside the 48h window (jul-2026 class).
		if (!matchOnchainSigner(pendingRecovery[1], qx as Hex, qy as Hex)) {
			return c.json({ error: "La llave no coincide con la recuperación propuesta. Cancela y vuelve a empezar.", error_code: ERR.RECOVERY_SIGNER_MISMATCH }, 409);
		}

		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "recovery_execute",
			to: walletAddress as `0x${string}`,
			data: encodeFunctionData({
				abi: accountWebAuthnV2Abi,
				functionName: "executeRecovery",
			}),
			metadata: { walletAddress, credentialId, qx, qy },
		});
		return c.json({ ...operationPayload(operation), message: "Recuperación enviada." }, 202);
	} catch (error) {
		logError("account_recovery_execute_failed", error, { uid: user.sub });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El relayer está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos ejecutar la recuperación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

// Cancel a pending guardian recovery. Auth-only on purpose: this must work for
// a user whose passkey is lost or compromised (it's the "cancélala si no fuiste
// tú" path from the alert push). Safe without a signature because the guardian
// can only clear its OWN pending proposal — no funds or signers change.
accountRoutes.post("/recovery/cancel", requireAuth, async (c) => {
	const user = c.get("user")!;
	if (!(await rateLimitConsume(c.env, "recovery-cancel", user.sub, 10, 3600, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	const active = await getActiveAccountOperation(c.env, user.sub, "recovery_cancel");
	if (active) return c.json(operationPayload(active), 202);

	try {
		const publicClient = getPublicClient(c.env);

		const isRecoveryPending = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		})) as boolean;
		if (!isRecoveryPending) {
			return c.json({ error: "No hay recuperacion en proceso.", error_code: ERR.RECOVERY_NONE }, 409);
		}
		const signer = await guardianSignerForAccount(c.env, publicClient, walletAddress as `0x${string}`);

		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "recovery_cancel",
			to: walletAddress as `0x${string}`,
			data: encodeFunctionData({
				abi: accountWebAuthnV2Abi,
				functionName: "guardianCancelRecovery",
			}),
			metadata: { walletAddress },
			signer,
		});
		return c.json(operationPayload(operation), 202);
	} catch (error) {
		logError("account_recovery_cancel_failed", error, { uid: user.sub });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El guardian está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos cancelar la recuperación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

export default accountRoutes;
