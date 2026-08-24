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
	getPasskey,
	getUserByUid,
	listPasskeysByUid,
	rateLimitConsume,
	renamePasskey,
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
import {
	consumeRecoveryStepUp,
	validateRecoveryStepUp,
} from "../services/emailOtp";
import {
	deleteExpiredWebAuthnRegistrations,
	finalizeWebAuthnRegistration,
	getFinalizedWebAuthnRegistration,
	InvalidWebAuthnRegistrationError,
	issueWebAuthnRegistration,
	type WebAuthnRegistrationCredential,
	validWebAuthnRegistrationOrigin,
} from "../services/webauthnRegistration";

const accountRoutes = new Hono<AppContext>();

function operationPayload(operation: Parameters<typeof toAccountOperationView>[0]) {
	const { id, ...view } = toAccountOperationView(operation);
	return { operationId: id, ...view };
}

function registrationCredentialFromBody(
	body: Record<string, unknown>,
): WebAuthnRegistrationCredential {
	const attachment = body.authenticatorAttachment;
	const clientExtensionResults = body.clientExtensionResults;
	return {
		registrationId: String(body.registrationId ?? ""),
		credentialId: String(body.credentialId ?? ""),
		qx: String(body.qx ?? ""),
		qy: String(body.qy ?? ""),
		clientDataJSON: String(body.clientDataJSON ?? ""),
		attestationObject: String(body.attestationObject ?? ""),
		clientExtensionResults:
			clientExtensionResults &&
			typeof clientExtensionResults === "object" &&
			!Array.isArray(clientExtensionResults)
				? clientExtensionResults as Record<string, unknown>
				: {},
		...(attachment === "platform" || attachment === "cross-platform"
			? { authenticatorAttachment: attachment }
			: {}),
		transports: Array.isArray(body.transports)
			? body.transports.filter((item): item is string => typeof item === "string")
			: [],
		name: typeof body.name === "string" ? body.name : undefined,
	};
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

accountRoutes.post("/create/preflight", requireAuth, async (c) => {
	const user = c.get("user")!;
	const existingUser = await getUserByUid(c.env, user.sub);
	if (existingUser?.walletAddress) {
		return c.json({
			alreadyExists: true,
			accountAddress: existingUser.walletAddress,
		}, 200);
	}
	const active = await getActiveAccountOperation(c.env, user.sub, "account_create");
	if (active) {
		return c.json({ existingOperation: operationPayload(active) }, 200);
	}

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const ip = c.req.header("CF-Connecting-IP") || "unknown";
	const [userAllowed, ipAllowed] = await Promise.all([
		rateLimitConsume(c.env, "acct-create-user", user.sub, 5, 24 * 60 * 60, { failClosed: true }),
		rateLimitConsume(c.env, "acct-create-ip", ip, 10, 60 * 60, { failClosed: true }),
	]);
	if (!userAllowed || !ipAllowed) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	if (!(await verifyTurnstile(c.env, body.turnstileToken, c.req.header("CF-Connecting-IP")))) {
		return c.json({ error: "No pudimos verificar que eres humano.", error_code: ERR.HUMAN_VERIFY_FAILED }, 403);
	}
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}

	try {
		const network = getNetworkConfig(c.env.CHAIN_KEY);
		assertContractsDeployed(network, ["factory", "verifier", "paymaster"]);
		getRecoveryGuardianAccount(c.env);
		const registration = await issueWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "account_create",
			expectedOrigin,
		});
		c.executionCtx.waitUntil(deleteExpiredWebAuthnRegistrations(c.env).catch(() => undefined));
		return c.json(registration, 201);
	} catch (error) {
		logError("account_create_preflight_failed", error, { uid: user.sub });
		return c.json({ error: "Account creation is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
	}
});

// Create account via WebAuthn (V2 - MultiSigner + UUPS)
accountRoutes.post("/create", requireAuth, async (c) => {
	const user = c.get("user")!;
	const requestId = c.get("requestId");
	const existingUser = await getUserByUid(c.env, user.sub);
	if (existingUser?.walletAddress) {
		return c.json({ error: "Account already exists", error_code: ERR.ACCOUNT_EXISTS, accountAddress: existingUser.walletAddress }, 409);
	}

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const active = await getActiveAccountOperation(c.env, user.sub, "account_create");
	if (active) {
		return c.json({ ...operationPayload(active), accountAddress: active.metadata.walletAddress ?? null }, 202);
	}

	try {
		const registration = await finalizeWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "account_create",
			credential: registrationCredentialFromBody(body),
		});
		const { predictedAddress, factory, data } = await prepareV2WalletDeployment(c.env, {
			qx: registration.qx as Hex,
			qy: registration.qy as Hex,
		});
		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "account_create",
			to: factory,
			data,
			metadata: {
				walletAddress: predictedAddress,
				credentialId: registration.credentialId,
				qx: registration.qx,
				qy: registration.qy,
				passkeyName: registration.name,
				passkeySource: "onboarding",
				passkeyTransports: registration.transports,
				ref: typeof body.ref === "string" ? body.ref.trim() : "",
			},
		});
		return c.json({ ...operationPayload(operation), accountAddress: predictedAddress }, 202);
	} catch (error) {
		logError("account_create_failed", error, { requestId, uid: user.sub });
		if (error instanceof InvalidWebAuthnRegistrationError) {
			return c.json({ error: error.message, error_code: ERR.WEBAUTHN_REGISTRATION_INVALID, requestId }, 400);
		}
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
	const storedPasskeys = await listPasskeysByUid(c.env, user.sub);

	const base = {
		hasStoredCredential: !!profile?.credentialId,
		hasWallet: !!walletAddress,
		chainStatus: walletAddress ? "unavailable" as const : "not_applicable" as const,
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
		passkeys: storedPasskeys.map((passkey) => ({
			credentialId: passkey.credentialId,
			name: passkey.name,
			registrationSource: passkey.registrationSource,
			transports: passkey.transports,
			createdAt: passkey.createdAt,
			lastUsedAt: passkey.lastUsedAt,
			currentHint: passkey.credentialId === profile?.credentialId,
		})),
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
			chainStatus: "available" as const,
			signerCount: Number(signerCount),
			threshold: Number(threshold),
			guardian,
			recoveryPending,
			recoveryExecutableAfter: executeAfter > 0 ? new Date(executeAfter * 1000).toISOString() : null,
			signers,
		});
	} catch (error) {
		// Wallet recorded but on-chain reads failed (RPC issue or not yet mined).
		logError("account_passkey_status_chain_read_failed", error, { uid: user.sub });
		return c.json(base);
	}
});

// Add a new passkey to the existing wallet (V2 - MultiSigner).
accountRoutes.post("/passkey/registration/preflight", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found. Create one first.", error_code: ERR.NO_WALLET }, 400);
	}
	if (!(await rateLimitConsume(c.env, "passkey-register", user.sub, 10, 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}
	const registration = await issueWebAuthnRegistration(c.env, {
		uid: user.sub,
		purpose: "passkey_add",
		expectedOrigin,
	});
	c.executionCtx.waitUntil(deleteExpiredWebAuthnRegistrations(c.env).catch(() => undefined));
	return c.json(registration, 201);
});

// Finalize the server challenge. The resulting registration id is durable, so
// a transient RPC failure can retry /prepare without creating another passkey.
accountRoutes.put("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found. Create one first.", error_code: ERR.NO_WALLET }, 400);
	}

	try {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
		const registration = await finalizeWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "passkey_add",
			credential: registrationCredentialFromBody(body),
		});
		return c.json({
			success: true,
			walletAddress: profile.walletAddress,
			registrationId: registration.registrationId,
		});
	} catch (error) {
		logError("account_add_passkey_failed", error, { uid: user.sub });
		if (error instanceof InvalidWebAuthnRegistrationError) {
			return c.json({ error: error.message, error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
		}
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

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const registrationId = typeof body.registrationId === "string" ? body.registrationId : "";
	const registration = await getFinalizedWebAuthnRegistration(c.env, {
		registrationId,
		uid: user.sub,
		purpose: "passkey_add",
	});
	if (!registration) {
		return c.json({ error: "Invalid passkey registration", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}

	try {
		const { verifier } = getNetworkConfig(c.env.CHAIN_KEY).contracts;
		const existingSigners = (await getPublicClient(c.env).readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "getSigners",
			args: [0n, 32n],
		})) as Hex[];
		if (matchOnchainSigner(existingSigners, registration.qx as Hex, registration.qy as Hex)) {
			return c.json({ error: "Passkey is already registered", error_code: ERR.PASSKEY_ALREADY_REGISTERED }, 409);
		}
		const newSigner = buildWebAuthnSigner(
			verifier,
			registration.qx as Hex,
			registration.qy as Hex,
		);
		const callData = encodeFunctionData({
			abi: accountWebAuthnV2Abi,
			functionName: "addSigners",
			args: [[newSigner]],
		});
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
			meta: {
				passkeyRegistrationId: registration.registrationId,
				credentialId: registration.credentialId,
				qx: registration.qx,
				qy: registration.qy,
				name: registration.name,
				registrationSource: "backup",
				transports: registration.transports,
			},
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

accountRoutes.patch("/passkeys/:credentialId", requireAuth, async (c) => {
	const user = c.get("user")!;
	const credentialId = c.req.param("credentialId") || "";
	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name || name.length > 64) {
		return c.json({ error: "Invalid passkey name", error_code: ERR.INVALID_PROFILE }, 400);
	}
	if (!(await rateLimitConsume(c.env, "passkey-rename", user.sub, 30, 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Too many changes", error_code: ERR.RATE_LIMITED }, 429);
	}
	if (!(await renamePasskey(c.env, { uid: user.sub, credentialId, name }))) {
		return c.json({ error: "Passkey not found", error_code: ERR.PASSKEY_NOT_FOUND }, 404);
	}
	return c.json({ success: true, credentialId, name });
});

accountRoutes.post("/passkeys/:credentialId/remove/prepare", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress;
	if (!walletAddress) return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	const credentialId = c.req.param("credentialId") || "";
	const passkey = await getPasskey(c.env, credentialId);
	if (!passkey || passkey.uid !== user.sub) {
		return c.json({ error: "Passkey not found", error_code: ERR.PASSKEY_NOT_FOUND }, 404);
	}
	if (!(await rateLimitConsume(c.env, "passkey-remove", user.sub, 10, 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Too many changes", error_code: ERR.RATE_LIMITED }, 429);
	}

	try {
		const publicClient = getPublicClient(c.env);
		const [signerCount, threshold, signers] = await Promise.all([
			publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getSignerCount" }) as Promise<bigint>,
			publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "threshold" }) as Promise<bigint>,
			publicClient.readContract({ address: walletAddress as `0x${string}`, abi: accountWebAuthnV2Abi, functionName: "getSigners", args: [0n, 32n] }) as Promise<Hex[]>,
		]);
		if (signerCount <= 1n || signerCount - 1n < threshold) {
			return c.json({ error: "Cannot remove the last required passkey", error_code: ERR.LAST_PASSKEY }, 409);
		}
		const onchainSigner = matchOnchainSigner(signers, passkey.qx as Hex, passkey.qy as Hex);
		if (!onchainSigner) {
			return c.json({ error: "Passkey is not an active signer", error_code: ERR.PASSKEY_NOT_FOUND }, 404);
		}
		const callData = encodeFunctionData({
			abi: accountWebAuthnV2Abi,
			functionName: "removeSigners",
			args: [[onchainSigner]],
		});
		const submissionTransport = selectUserOperationTransport(c.env, user.sub);
		const { userOp, userOpHash, signingPayload } = await buildSponsoredUserOp(c.env, {
			sender: walletAddress as `0x${string}`,
			callData,
			verificationGasLimit: 400000n,
			callGasLimit: 250000n,
			transportMode: submissionTransport,
		});
		await createPendingPayment(c.env, {
			userOpHash,
			linkId: null,
			uid: user.sub,
			amount: "0",
			currency: "PASSKEY_REMOVE",
			wallet: walletAddress,
			senderAddress: walletAddress,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			submissionTransport,
			meta: { credentialId },
		});
		return c.json({
			userOpHash,
			credentialId: profile.credentialId ?? null,
			submissionTransport,
			signingPayload,
		});
	} catch (error) {
		logError("account_passkey_remove_prepare_failed", error, { uid: user.sub });
		return c.json({ error: "No pudimos preparar la operación.", error_code: ERR.SERVER_ERROR }, 500);
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
accountRoutes.post("/recovery/preflight", requireAuth, async (c) => {
	const user = c.get("user")!;
	if (!(await rateLimitConsume(c.env, "recovery-propose", user.sub, 3, 86400, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED }, 429);
	}
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress;
	if (!walletAddress) return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	if (await getActiveAccountOperation(c.env, user.sub, "recovery_propose")) {
		return c.json({ error: "Ya hay una recuperación en proceso.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
	}
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}

	try {
		const publicClient = getPublicClient(c.env);
		const isRecoveryPending = (await publicClient.readContract({
			address: walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		})) as boolean;
		if (isRecoveryPending) {
			return c.json({ error: "Ya hay una recuperación en proceso.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
		}
		await guardianSignerForAccount(c.env, publicClient, walletAddress as `0x${string}`);
		const stepUpToken = c.req.header("X-Step-Up-Token");
		if (!stepUpToken) {
			return c.json({ error: "Security verification is required", error_code: ERR.STEP_UP_REQUIRED }, 403);
		}
		if (!(await validateRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
		}
		const registration = await issueWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "recovery_propose",
			expectedOrigin,
		});
		c.executionCtx.waitUntil(deleteExpiredWebAuthnRegistrations(c.env).catch(() => undefined));
		return c.json(registration, 201);
	} catch (error) {
		logError("account_recovery_preflight_failed", error, { uid: user.sub });
		return c.json({ error: "Recovery is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
	}
});

accountRoutes.post("/recovery/propose", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? undefined;
	if (!walletAddress) {
		return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	}

	const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	const qx = typeof body.qx === "string" ? body.qx : "";
	const qy = typeof body.qy === "string" ? body.qy : "";
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
		const stepUpToken = c.req.header("X-Step-Up-Token");
		if (!stepUpToken) {
			return c.json({ error: "Security verification is required", error_code: ERR.STEP_UP_REQUIRED }, 403);
		}
		const registration = await finalizeWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "recovery_propose",
			credential: registrationCredentialFromBody(body),
		});
		if (!(await consumeRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
		}

		const newSigner = buildWebAuthnSigner(
			verifier,
			registration.qx as Hex,
			registration.qy as Hex,
		);
		const { operation } = await submitAccountOperation(c.env, {
			uid: user.sub,
			kind: "recovery_propose",
			to: walletAddress as `0x${string}`,
			data: encodeFunctionData({
				abi: accountWebAuthnV2Abi,
				functionName: "proposeRecovery",
				args: [[newSigner], 1n],
			}),
			metadata: {
				walletAddress,
				credentialId: registration.credentialId,
				qx: registration.qx,
				qy: registration.qy,
				passkeyName: registration.name,
				passkeySource: "recovery",
				passkeyTransports: registration.transports,
			},
			signer,
		});
		return c.json({ ...operationPayload(operation), message: "Recuperación iniciada. Estará lista en 48 horas." }, 202);
	} catch (error) {
		logError("account_recovery_propose_failed", error, { uid: user.sub });
		if (error instanceof InvalidWebAuthnRegistrationError) {
			return c.json({ error: error.message, error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
		}
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

	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({} as Record<string, unknown>));
	const credentialId = typeof body.credentialId === "string" ? body.credentialId : "";
	const qx = typeof body.qx === "string" ? body.qx : "";
	const qy = typeof body.qy === "string" ? body.qy : "";
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
		const stepUpToken = c.req.header("X-Step-Up-Token");
		if (!stepUpToken) {
			return c.json({ error: "Security verification is required", error_code: ERR.STEP_UP_REQUIRED }, 403);
		}
		if (!(await consumeRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
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
