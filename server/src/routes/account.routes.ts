import { Hono } from "hono";
import { type Hex, encodeFunctionData, encodePacked, formatUnits } from "viem";
import {
	accountWebAuthnV2Abi,
	accountFactoryV2Abi,
	assertContractsDeployed,
	getNetworkConfig,
	isSupportedChainKey,
	ERR,
} from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import {
	createPendingPayment,
	completeUserChainSecuritySync,
	getActivePendingAction,
	getAccountOperationById,
	getActiveAccountOperation,
	getUserChainAccount,
	getPasskey,
	getUserByUid,
	listPasskeysByUid,
	listUserChainBalanceSnapshots,
	listUserChainAccounts,
	markPasskeyVerified,
	rateLimitConsume,
	renamePasskey,
	upsertUserChainAccount,
	type AccountOperationRecord,
	type UserChainAccountRecord,
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
import {
	buildSponsoredUserOp,
	encodeExecuteBatch,
	isCompletePasskeyInventory,
	matchOnchainSigner,
	passkeySignerActivity,
	serializeBigInts,
	type AccountCall,
} from "../services/userOp";
import { verifyTurnstile } from "../services/turnstile";
import { logError } from "../services/logger";
import { selectUserOperationTransport } from "../services/userOperationTransport";
import { configuredPasskeyRpId } from "../services/passkeyConfig";
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
import {
	deleteExpiredWebAuthnAuthentications,
	InvalidWebAuthnAuthenticationError,
	issueWebAuthnAuthentication,
	type WebAuthnAuthenticationCredential,
	verifyWebAuthnAuthentication,
} from "../services/webauthnAuthentication";
import {
	appChainCapabilities,
	bindingsForChain,
	enabledWalletRailChainKeys,
	resolveAppChainKey,
} from "../services/chainScope";
import { requestBalanceRefreshBatch } from "../services/balanceReadModel";

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

function authenticationCredentialFromBody(
	body: Record<string, unknown>,
): WebAuthnAuthenticationCredential {
	const response = body.response && typeof body.response === "object" && !Array.isArray(body.response)
		? body.response as Record<string, unknown>
		: {};
	const attachment = body.authenticatorAttachment;
	const extensionResults = body.clientExtensionResults;
	return {
		authenticationId: String(body.authenticationId ?? ""),
		id: String(body.id ?? ""),
		rawId: String(body.rawId ?? ""),
		type: "public-key",
		response: {
			clientDataJSON: String(response.clientDataJSON ?? ""),
			authenticatorData: String(response.authenticatorData ?? ""),
			signature: String(response.signature ?? ""),
			...(typeof response.userHandle === "string"
				? { userHandle: response.userHandle }
				: {}),
		},
		clientExtensionResults:
			extensionResults && typeof extensionResults === "object" && !Array.isArray(extensionResults)
				? extensionResults as Record<string, unknown>
				: {},
		...(attachment === "platform" || attachment === "cross-platform"
			? { authenticatorAttachment: attachment }
			: {}),
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
function buildInitCallDataForSigners(
	verifier: Hex,
	passkeys: Array<{ qx: Hex; qy: Hex }>,
	threshold: bigint,
	guardian: `0x${string}`,
): Hex {
	const signers = passkeys.map((passkey) => buildWebAuthnSigner(verifier, passkey.qx, passkey.qy));
	return encodeFunctionData({
		abi: accountWebAuthnV2Abi,
		functionName: "initialize",
		args: [signers, threshold, guardian],
	});
}

function buildInitCallData(verifier: Hex, qx: Hex, qy: Hex, guardian: `0x${string}`): Hex {
	return buildInitCallDataForSigners(verifier, [{ qx, qy }], 1n, guardian);
}

type RecoveryTarget = {
	account: UserChainAccountRecord;
	env: AppContext["Bindings"];
};

async function activeRecoveryTargets(
	env: AppContext["Bindings"],
	uid: string,
	homeWalletAddress: `0x${string}`,
): Promise<RecoveryTarget[]> {
	const accounts = await listUserChainAccounts(env, uid);
	const homeNetwork = getNetworkConfig(env.CHAIN_KEY);
	const active = accounts.filter((account) => account.status === "active");
	if (!active.some((account) => account.isHome)) {
		active.unshift({
			uid,
			chainId: homeNetwork.chainId,
			chainKey: homeNetwork.key,
			networkName: homeNetwork.name,
			walletAddress: homeWalletAddress,
			isHome: true,
			status: "active",
			securityStatus: "current",
			securityVersionApplied: 1,
			securityVersionDesired: 1,
			deploymentTxHash: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
			activatedAt: null,
		});
	}
	return active.map((account) => {
		if (!isSupportedChainKey(account.chainKey)) {
			throw new Error(`Unsupported active recovery chain ${account.chainKey}`);
		}
		const scopedEnv = bindingsForChain(env, account.chainKey);
		if (!scopedEnv.RPC_READ_URLS?.trim() || !scopedEnv.RPC_WRITE_URLS?.trim()) {
			throw new Error(`Recovery RPC is not configured for ${account.chainKey}`);
		}
		return { account, env: scopedEnv };
	}).sort((left, right) => Number(left.account.isHome) - Number(right.account.isHome));
}

function recoveryOperationPayload(operations: AccountOperationRecord[]) {
	const primary = operations.find((operation) => operation.metadata.isHomeAccount !== false)
		?? operations[0];
	if (!primary) return { alreadyComplete: true, operations: [] };
	return {
		...operationPayload(primary),
		operations: operations.map((operation) => ({
			...operationPayload(operation),
			chainId: operation.chainId,
			chainKey: operation.chainKey,
		})),
	};
}

function recoveryMatches(
	pending: readonly [bigint, readonly Hex[], bigint],
	qx: Hex,
	qy: Hex,
): boolean {
	return pending[2] === 1n && pending[1].length === 1 &&
		Boolean(matchOnchainSigner([...pending[1]], qx, qy));
}

async function prepareV2WalletDeployment(env: AppContext["Bindings"], params: { qx: Hex; qy: Hex }) {
	const network = getNetworkConfig(env.CHAIN_KEY);
	// Fail closed on TODO_DEPLOY placeholders (e.g. arbitrum-one pre-deploy).
	assertContractsDeployed(network, ["factory", "verifier"]);
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
	if (!(await verifyTurnstile(c.env, body.turnstileToken, c.req.header("CF-Connecting-IP"), "account_create"))) {
		return c.json({ error: "No pudimos verificar que eres humano.", error_code: ERR.HUMAN_VERIFY_FAILED }, 403);
	}
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}

	try {
		const network = getNetworkConfig(c.env.CHAIN_KEY);
		assertContractsDeployed(network, ["factory", "verifier"]);
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
				passkeyRpId: registration.rpId,
				passkeyAaguid: registration.aaguid,
				passkeyProviderName: registration.providerName,
				passkeyCredentialDeviceType: registration.credentialDeviceType,
				passkeyCredentialBackedUp: registration.credentialBackedUp,
				passkeyAuthenticatorAttachment: registration.authenticatorAttachment,
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

// Phase 4A chain portfolio. The identity is global, but every balance and
// execution account remains explicit per chain.
accountRoutes.get("/chains", requireAuth, async (c) => {
	const user = c.get("user")!;
	const [accounts, capabilities, snapshots] = await Promise.all([
		listUserChainAccounts(c.env, user.sub),
		Promise.resolve(appChainCapabilities(c.env)),
		listUserChainBalanceSnapshots(c.env, user.sub),
	]);
	const maxAgeSeconds = Number(c.env.BALANCE_MAX_STALENESS_SECONDS || "300");
	const maxAgeMs = (Number.isSafeInteger(maxAgeSeconds) && maxAgeSeconds >= 15 ? maxAgeSeconds : 300) * 1_000;
	const refreshes = accounts.flatMap((account) => {
		if (account.status !== "active") return [];
		const chain = capabilities.find((candidate) => candidate.chainId === account.chainId);
		// The execution kill switch must stop new movements, not blind the
		// portfolio. Existing accounts can still receive funds onchain while a
		// rail is paused, so keep their read-only balance snapshots observable.
		if (!chain?.rpcConfigured) return [];
		const rows = snapshots.filter((snapshot) => snapshot.chainId === account.chainId);
		const hasStaleOrMissingAsset = chain.assets.some((asset) => {
			const snapshot = rows.find((row) => row.asset === asset.symbol);
			if (!snapshot) return true;
			const observedAt = Date.parse(snapshot.observedAt);
			return !Number.isFinite(observedAt) || Date.now() - observedAt > maxAgeMs;
		});
		return hasStaleOrMissingAsset
			? [{
				chainId: account.chainId,
				accountAddress: account.walletAddress,
				uid: user.sub,
				reason: "portfolio_snapshot_stale",
				priority: 3 as const,
			}]
			: [];
	});
	if (refreshes.length > 0) {
		c.executionCtx.waitUntil(
			requestBalanceRefreshBatch(c.env, refreshes).catch((error) => {
				logError("chain_portfolio_refresh_request_failed", error, {
					uid: user.sub,
					chains: refreshes.map((refresh) => refresh.chainId).join(","),
				});
			}),
		);
	}
	return c.json({
		chains: capabilities.map((chain) => {
			const account = accounts.find((candidate) => candidate.chainId === chain.chainId) ?? null;
			const rows = snapshots.filter((snapshot) => snapshot.chainId === chain.chainId);
			const assets = chain.assets.map((asset) => {
				const snapshot = rows.find((row) => row.asset === asset.symbol) ?? null;
				const age = snapshot ? Date.now() - Date.parse(snapshot.observedAt) : Number.POSITIVE_INFINITY;
				return {
					...asset,
					value: snapshot ? formatUnits(BigInt(snapshot.balanceRaw), snapshot.decimals) : null,
					raw: snapshot?.balanceRaw ?? null,
					status: !snapshot ? "unavailable" : age <= maxAgeMs ? "fresh" : "stale",
					observedAt: snapshot?.observedAt ?? null,
					blockNumber: snapshot?.blockNumber ?? null,
					blockHash: snapshot?.blockHash ?? null,
				};
			});
			return { ...chain, account, balance: { assets } };
		}),
	});
});

accountRoutes.post("/chains/:chainKey/activate", requireAuth, async (c) => {
	const user = c.get("user")!;
	const requested = c.req.param("chainKey");
	const chainKey = resolveAppChainKey(c.env, requested);
	if (!chainKey) {
		return c.json({ error: "Red no soportada.", error_code: ERR.UNSUPPORTED_CHAIN }, 404);
	}
	if (!enabledWalletRailChainKeys(c.env).includes(chainKey)) {
		return c.json({
			error: "La red todavía no está habilitada para crear cuentas.",
			error_code: ERR.SERVICE_UNAVAILABLE,
		}, 503);
	}
	const network = getNetworkConfig(chainKey);
	const scopedEnv = bindingsForChain(c.env, chainKey);
	if (!scopedEnv.RPC_READ_URLS?.trim() || !scopedEnv.RPC_WRITE_URLS?.trim()) {
		return c.json({ error: "La red no tiene RPC configurado.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
	}

	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "Necesitas crear tu cuenta primero.", error_code: ERR.NO_WALLET }, 400);
	}
	const homeNetwork = getNetworkConfig(c.env.CHAIN_KEY);
	const homeAccount = await getUserChainAccount(c.env, user.sub, homeNetwork.chainId);
	if (!homeAccount || homeAccount.status !== "active") {
		return c.json({ error: "La cuenta principal no está disponible.", error_code: ERR.NO_WALLET }, 409);
	}
	const securityVersion = homeAccount.securityVersionDesired;
	const existing = await getUserChainAccount(c.env, user.sub, network.chainId);
	if (existing?.status === "active") return c.json({ account: existing }, 200);
	const active = await getActiveAccountOperation(scopedEnv, user.sub, "account_create");
	if (active) return c.json({ existingOperation: operationPayload(active) }, 202);
	if (!(await rateLimitConsume(c.env, "chain-account-activate", `${user.sub}:${network.chainId}`, 5, 24 * 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos.", error_code: ERR.RATE_LIMITED }, 429);
	}

	try {
		assertContractsDeployed(network, ["factory", "verifier", "paymaster"]);
		const homeRecoveryPending = await getPublicClient(c.env).readContract({
			address: profile.walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "isRecoveryPending",
		}) as boolean;
		if (homeRecoveryPending) {
			return c.json({
				error: "Completa o cancela la recuperación antes de activar otra red.",
				error_code: ERR.RECOVERY_IN_PROGRESS,
			}, 409);
		}
		const [storedPasskeys, homeSigners, homeThreshold] = await Promise.all([
			listPasskeysByUid(c.env, user.sub),
			getPublicClient(c.env).readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "getSigners",
				args: [0n, 32n],
			}) as Promise<Hex[]>,
			getPublicClient(c.env).readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "threshold",
			}) as Promise<bigint>,
		]);
		const activePasskeys = storedPasskeys.filter((passkey) =>
			Boolean(matchOnchainSigner(homeSigners, passkey.qx as Hex, passkey.qy as Hex)),
		);
		if (activePasskeys.length === 0 || homeThreshold < 1n || homeThreshold > BigInt(activePasskeys.length)) {
			return c.json({
				error: "No pudimos comprobar el conjunto completo de llaves activas.",
				error_code: ERR.PASSKEY_NOT_ACTIVE,
			}, 409);
		}

		const publicClient = getPublicClient(scopedEnv);
		const deployedCode = await Promise.all([
			publicClient.getCode({ address: network.contracts.factory }),
			publicClient.getCode({ address: network.contracts.verifier }),
			publicClient.getCode({ address: network.contracts.paymaster }),
		]);
		if (deployedCode.some((code) => !code || code === "0x")) {
			return c.json({
				error: "La infraestructura de cuenta todavía no está desplegada en esta red.",
				error_code: ERR.SERVICE_UNAVAILABLE,
			}, 503);
		}

		const guardian = getRecoveryGuardianAccount(scopedEnv).address;
		const initCallData = buildInitCallDataForSigners(
			network.contracts.verifier,
			activePasskeys.map((passkey) => ({ qx: passkey.qx as Hex, qy: passkey.qy as Hex })),
			homeThreshold,
			guardian,
		);
		const predictedAddress = (await publicClient.readContract({
			address: network.contracts.factory,
			abi: accountFactoryV2Abi,
			functionName: "predictAddress",
			args: [initCallData],
		})) as `0x${string}`;
		const { operation } = await submitAccountOperation(scopedEnv, {
			uid: user.sub,
			kind: "account_create",
			to: network.contracts.factory,
			data: encodeFunctionData({
				abi: accountFactoryV2Abi,
				functionName: "createAccount",
				args: [initCallData],
			}),
			metadata: {
				walletAddress: predictedAddress,
				isHomeAccount: false,
				chainKey,
				chainId: network.chainId,
				securityVersion,
				signerCount: activePasskeys.length,
				threshold: homeThreshold.toString(),
			},
		});
		await upsertUserChainAccount(c.env, {
			uid: user.sub,
			chainId: network.chainId,
			chainKey,
			networkName: network.name,
			walletAddress: predictedAddress,
			isHome: false,
			status: "deploying",
			securityStatus: "syncing",
			securityVersionApplied: securityVersion,
			deploymentTxHash: operation.txHash,
		});
		return c.json({
			...operationPayload(operation),
			accountAddress: predictedAddress,
			chainId: network.chainId,
			chainKey,
		}, 202);
	} catch (error) {
		logError("chain_account_activation_failed", error, { uid: user.sub, chainKey });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El relayer está ocupado.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos activar esta red.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

accountRoutes.post("/chains/:chainKey/security/prepare", requireAuth, async (c) => {
	const user = c.get("user")!;
	const chainKey = resolveAppChainKey(c.env, c.req.param("chainKey"), { requireWalletRail: true });
	if (!chainKey) {
		return c.json({ error: "Red no soportada.", error_code: ERR.UNSUPPORTED_CHAIN }, 404);
	}
	if (chainKey === c.env.CHAIN_KEY) {
		return c.json({ alreadyCurrent: true, chainKey }, 200);
	}
	const network = getNetworkConfig(chainKey);
	const scopedEnv = bindingsForChain(c.env, chainKey);
	const [profile, chainAccount] = await Promise.all([
		getUserByUid(c.env, user.sub),
		getUserChainAccount(c.env, user.sub, network.chainId),
	]);
	if (!profile?.walletAddress || !chainAccount || chainAccount.status !== "active") {
		return c.json({ error: "No hay una cuenta activa en esta red.", error_code: ERR.NO_WALLET }, 400);
	}
	if (chainAccount.securityStatus === "current" &&
		chainAccount.securityVersionApplied === chainAccount.securityVersionDesired) {
		return c.json({ alreadyCurrent: true, chainKey }, 200);
	}
	if (await getActivePendingAction(c.env, {
		uid: user.sub,
		chainId: network.chainId,
		currency: "PASSKEY_SYNC",
	})) {
		return c.json({ error: "La sincronización ya está en curso.", error_code: ERR.PAYMENT_IN_PROGRESS }, 409);
	}
	if (!(await rateLimitConsume(c.env, "chain-security-sync", `${user.sub}:${network.chainId}`, 10, 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos.", error_code: ERR.RATE_LIMITED }, 429);
	}

	try {
		const storedPasskeys = await listPasskeysByUid(c.env, user.sub);
		const homeClient = getPublicClient(c.env);
		const satelliteClient = getPublicClient(scopedEnv);
		const [homeSigners, homeSignerCount, homeThreshold, satelliteSigners, satelliteThreshold] = await Promise.all([
			homeClient.readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "getSigners",
				args: [0n, 32n],
			}) as Promise<Hex[]>,
			homeClient.readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "getSignerCount",
			}) as Promise<bigint>,
			homeClient.readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "threshold",
			}) as Promise<bigint>,
			satelliteClient.readContract({
				address: chainAccount.walletAddress,
				abi: accountWebAuthnV2Abi,
				functionName: "getSigners",
				args: [0n, 32n],
			}) as Promise<Hex[]>,
			satelliteClient.readContract({
				address: chainAccount.walletAddress,
				abi: accountWebAuthnV2Abi,
				functionName: "threshold",
			}) as Promise<bigint>,
		]);
		if (!isCompletePasskeyInventory({
			signerCount: homeSignerCount,
			signers: homeSigners,
			passkeys: storedPasskeys,
		})) {
			return c.json({
				error: "No pudimos comprobar el conjunto completo de llaves de la cuenta principal.",
				error_code: ERR.PASSKEY_NOT_ACTIVE,
			}, 409);
		}
		if (homeThreshold < 1n || homeThreshold > BigInt(storedPasskeys.length)) {
			return c.json({ error: "Umbral de seguridad inválido.", error_code: ERR.PASSKEY_NOT_ACTIVE }, 409);
		}

		const desiredSigners = storedPasskeys.map((passkey) => buildWebAuthnSigner(
			network.contracts.verifier,
			passkey.qx as Hex,
			passkey.qy as Hex,
		));
		const desiredSet = new Set(desiredSigners.map((signer) => signer.toLowerCase()));
		const currentSet = new Set(satelliteSigners.map((signer) => signer.toLowerCase()));
		const additions = desiredSigners.filter((signer) => !currentSet.has(signer.toLowerCase()));
		const removals = satelliteSigners.filter((signer) => !desiredSet.has(signer.toLowerCase()));
		const signingPasskey = storedPasskeys.find((passkey) =>
			Boolean(matchOnchainSigner(satelliteSigners, passkey.qx as Hex, passkey.qy as Hex)),
		);
		if (!signingPasskey) {
			return c.json({
				error: "Ninguna llave actual puede autorizar esta sincronización. Usa la recuperación de cuenta.",
				error_code: ERR.PASSKEY_NOT_ACTIVE,
			}, 409);
		}

		const calls: AccountCall[] = [];
		if (additions.length > 0) {
			calls.push({
				target: chainAccount.walletAddress,
				value: 0n,
				data: encodeFunctionData({ abi: accountWebAuthnV2Abi, functionName: "addSigners", args: [additions] }),
			});
		}
		if (homeThreshold < satelliteThreshold) {
			calls.push({
				target: chainAccount.walletAddress,
				value: 0n,
				data: encodeFunctionData({ abi: accountWebAuthnV2Abi, functionName: "setThreshold", args: [homeThreshold] }),
			});
		}
		if (removals.length > 0) {
			calls.push({
				target: chainAccount.walletAddress,
				value: 0n,
				data: encodeFunctionData({ abi: accountWebAuthnV2Abi, functionName: "removeSigners", args: [removals] }),
			});
		}
		if (homeThreshold > satelliteThreshold) {
			calls.push({
				target: chainAccount.walletAddress,
				value: 0n,
				data: encodeFunctionData({ abi: accountWebAuthnV2Abi, functionName: "setThreshold", args: [homeThreshold] }),
			});
		}

		if (calls.length === 0) {
			const completed = await completeUserChainSecuritySync(c.env, {
				uid: user.sub,
				chainId: network.chainId,
				expectedVersion: chainAccount.securityVersionDesired,
			});
			return c.json({ alreadyCurrent: completed, chainKey }, completed ? 200 : 409);
		}

		const callData = calls.length === 1 ? calls[0].data : encodeExecuteBatch(calls);
		const submissionTransport = selectUserOperationTransport(scopedEnv, user.sub);
		const { userOp, userOpHash, rpId, signingPayload, sponsorshipProvider,
			sponsorshipPaymasterAddress } = await buildSponsoredUserOp(scopedEnv, {
			sender: chainAccount.walletAddress,
			callData,
			verificationGasLimit: 450000n,
			callGasLimit: 500000n,
			transportMode: submissionTransport,
		});
		await createPendingPayment(scopedEnv, {
			userOpHash,
			chainId: network.chainId,
			chainKey,
			linkId: null,
			uid: user.sub,
			amount: "0",
			currency: "PASSKEY_SYNC",
			wallet: chainAccount.walletAddress,
			senderAddress: chainAccount.walletAddress,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			submissionTransport,
			sponsorshipProvider,
			sponsorshipPaymasterAddress,
			meta: {
				chainId: network.chainId,
				chainKey,
				securityVersion: chainAccount.securityVersionDesired,
				signerCount: desiredSigners.length,
				threshold: homeThreshold.toString(),
			},
		});
		return c.json({
			userOpHash,
			credentialId: signingPasskey.credentialId,
			rpId,
			submissionTransport,
			signingPayload,
			chainId: network.chainId,
			chainKey,
		}, 201);
	} catch (error) {
		logError("chain_security_sync_prepare_failed", error, { uid: user.sub, chainKey });
		return c.json({ error: "No pudimos preparar la sincronización.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

// Passkey + recovery status for the wallet (V2).
accountRoutes.get("/passkey", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	const walletAddress = profile?.walletAddress ?? null;
	const storedPasskeys = await listPasskeysByUid(c.env, user.sub);

	const base = {
		rpId: configuredPasskeyRpId(c.env),
		hasStoredCredential: !!profile?.credentialId,
		hasWallet: !!walletAddress,
		chainStatus: walletAddress ? "unavailable" as const : "not_applicable" as const,
		signerCount: null as number | null,
		threshold: null as number | null,
		guardian: null as string | null,
		recoveryPending: null as boolean | null,
		recoveryExecutableAfter: null as string | null,
		recoveryCoverageComplete: false,
		recoveryChains: [] as Array<{
			chainId: number;
			chainKey: string;
			networkName: string;
			status: "pending" | "clear" | "unavailable";
			executableAfter: string | null;
		}>,
		// Registered ERC-7913 signer bytes. The client matches its remembered
		// passkeys (qx||qy suffix) against these to answer the question the
		// signerCount tile can't: "can THIS device sign?" (jul-2026 field bug:
		// Settings said "1 llave activa" while paying said "no key" — both true,
		// one on-chain, one per-device).
		signers: null as string[] | null,
		credentialInventoryComplete: false,
		passkeys: storedPasskeys.map((passkey) => ({
			credentialId: passkey.credentialId,
			name: passkey.name,
			registrationSource: passkey.registrationSource,
			transports: passkey.transports,
			rpId: passkey.rpId,
			aaguid: passkey.aaguid,
			providerName: passkey.providerName,
			credentialDeviceType: passkey.credentialDeviceType,
			credentialBackedUp: passkey.credentialBackedUp,
			authenticatorAttachment: passkey.authenticatorAttachment,
			metadataUpdatedAt: passkey.metadataUpdatedAt,
			createdAt: passkey.createdAt,
			lastUsedAt: passkey.lastUsedAt,
			currentHint: passkey.credentialId === profile?.credentialId,
			// Null means the chain could not be checked. The UI must fail closed
			// instead of treating every D1 row as an active account signer.
			activeSigner: null as boolean | null,
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

		const chainAccounts = await listUserChainAccounts(c.env, user.sub);
		const satellites = chainAccounts.filter((account) => account.status === "active" && !account.isHome);
		const satelliteRecovery = await Promise.all(satellites.map(async (account) => {
			if (!isSupportedChainKey(account.chainKey)) {
				return { account, pending: null, executeAfter: 0 };
			}
			const scopedEnv = bindingsForChain(c.env, account.chainKey);
			const activeOperations = await Promise.all([
				getActiveAccountOperation(scopedEnv, user.sub, "recovery_propose"),
				getActiveAccountOperation(scopedEnv, user.sub, "recovery_execute"),
				getActiveAccountOperation(scopedEnv, user.sub, "recovery_cancel"),
			]);
			if (!scopedEnv.RPC_READ_URLS?.trim()) {
				return { account, pending: activeOperations.some(Boolean) ? true : null, executeAfter: 0 };
			}
			try {
				const satellitePending = await getPublicClient(scopedEnv).readContract({
					address: account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "getPendingRecovery",
				}) as [bigint, Hex[], bigint];
				return {
					account,
					pending: satellitePending[0] > 0n || activeOperations.some(Boolean),
					executeAfter: Number(satellitePending[0]),
				};
			} catch {
				return { account, pending: activeOperations.some(Boolean) ? true : null, executeAfter: 0 };
			}
		}));
		const homeActiveOperations = await Promise.all([
			getActiveAccountOperation(c.env, user.sub, "recovery_propose"),
			getActiveAccountOperation(c.env, user.sub, "recovery_execute"),
			getActiveAccountOperation(c.env, user.sub, "recovery_cancel"),
		]);
		const homeExecuteAfter = Number(pendingRecovery[0]);
		const recoveryChains = [{
			chainId: getNetworkConfig(c.env.CHAIN_KEY).chainId,
			chainKey: c.env.CHAIN_KEY,
			networkName: getNetworkConfig(c.env.CHAIN_KEY).name,
			pending: recoveryPending || homeActiveOperations.some(Boolean),
			executeAfter: homeExecuteAfter,
		}, ...satelliteRecovery.map((state) => ({
			chainId: state.account.chainId,
			chainKey: state.account.chainKey,
			networkName: state.account.networkName,
			pending: state.pending,
			executeAfter: state.executeAfter,
		}))];
		const recoveryCoverageComplete = recoveryChains.every((chain) => chain.pending !== null);
		const anyRecoveryPending = recoveryChains.some((chain) => chain.pending === true);
		const latestExecuteAfter = recoveryChains.reduce(
			(latest, chain) => chain.executeAfter > latest ? chain.executeAfter : latest,
			0,
		);
		const credentialInventoryComplete = isCompletePasskeyInventory({
			signerCount,
			signers,
			passkeys: storedPasskeys,
		});
		const activePasskeys = passkeySignerActivity(signers, storedPasskeys);
		return c.json({
			...base,
			chainStatus: "available" as const,
			signerCount: Number(signerCount),
			threshold: Number(threshold),
			guardian,
			recoveryPending: anyRecoveryPending ? true : recoveryCoverageComplete ? false : null,
			recoveryExecutableAfter: latestExecuteAfter > 0 ? new Date(latestExecuteAfter * 1000).toISOString() : null,
			recoveryCoverageComplete,
			recoveryChains: recoveryChains.map((chain) => ({
				chainId: chain.chainId,
				chainKey: chain.chainKey,
				networkName: chain.networkName,
				status: chain.pending === null ? "unavailable" as const : chain.pending ? "pending" as const : "clear" as const,
				executableAfter: chain.executeAfter > 0 ? new Date(chain.executeAfter * 1000).toISOString() : null,
			})),
			signers,
			credentialInventoryComplete,
			passkeys: base.passkeys.map((passkey, index) => ({
				...passkey,
				activeSigner: activePasskeys[index],
			})),
		});
	} catch (error) {
		// Wallet recorded but on-chain reads failed (RPC issue or not yet mined).
		logError("account_passkey_status_chain_read_failed", error, { uid: user.sub });
		return c.json(base);
	}
});

// Explicit passkey availability check. We never infer this from localStorage:
// the browser/OS must produce a fresh, server-verified WebAuthn assertion for
// one of the account's current onchain signers.
accountRoutes.post("/passkey/availability/preflight", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	}
	if (!(await rateLimitConsume(c.env, "passkey-availability", user.sub, 20, 60 * 60, { failClosed: true }))) {
		return c.json({ error: "Too many checks", error_code: ERR.RATE_LIMITED }, 429);
	}
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.PASSKEY_VERIFICATION_FAILED }, 400);
	}

	try {
		const [storedPasskeys, signers] = await Promise.all([
			listPasskeysByUid(c.env, user.sub),
			getPublicClient(c.env).readContract({
				address: profile.walletAddress as `0x${string}`,
				abi: accountWebAuthnV2Abi,
				functionName: "getSigners",
				args: [0n, 32n],
			}) as Promise<Hex[]>,
		]);
		const activePasskeys = storedPasskeys.filter((passkey) =>
			Boolean(matchOnchainSigner(signers, passkey.qx as Hex, passkey.qy as Hex)),
		);
		const authentication = await issueWebAuthnAuthentication(c.env, {
			uid: user.sub,
			expectedOrigin,
			expectedRpId: configuredPasskeyRpId(c.env),
			activePasskeys,
		});
		c.executionCtx.waitUntil(
			deleteExpiredWebAuthnAuthentications(c.env).catch(() => undefined),
		);
		return c.json(authentication, 201);
	} catch (error) {
		if (error instanceof InvalidWebAuthnAuthenticationError) {
			return c.json({ error: error.message, error_code: ERR.PASSKEY_VERIFICATION_FAILED }, 409);
		}
		logError("account_passkey_availability_preflight_failed", error, { uid: user.sub });
		return c.json({ error: "Passkey verification is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
	}
});

accountRoutes.post("/passkey/availability/verify", requireAuth, async (c) => {
	const user = c.get("user")!;
	const profile = await getUserByUid(c.env, user.sub);
	if (!profile?.walletAddress) {
		return c.json({ error: "No wallet found.", error_code: ERR.NO_WALLET }, 400);
	}
	try {
		const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
		const verified = await verifyWebAuthnAuthentication(c.env, {
			uid: user.sub,
			credential: authenticationCredentialFromBody(body),
		});
		const signers = await getPublicClient(c.env).readContract({
			address: profile.walletAddress as `0x${string}`,
			abi: accountWebAuthnV2Abi,
			functionName: "getSigners",
			args: [0n, 32n],
		}) as Hex[];
		if (!matchOnchainSigner(signers, verified.passkey.qx as Hex, verified.passkey.qy as Hex)) {
			return c.json({ error: "Passkey is not an active signer", error_code: ERR.PASSKEY_NOT_ACTIVE }, 409);
		}
		await markPasskeyVerified(c.env, {
			uid: user.sub,
			credentialId: verified.passkey.credentialId,
			signCount: verified.newCounter,
		});
		return c.json({
			available: true,
			credentialId: verified.passkey.credentialId,
			name: verified.passkey.name,
		});
	} catch (error) {
		if (error instanceof InvalidWebAuthnAuthenticationError) {
			return c.json({ error: error.message, error_code: ERR.PASSKEY_VERIFICATION_FAILED }, 409);
		}
		logError("account_passkey_availability_verify_failed", error, { uid: user.sub });
		return c.json({ error: "Passkey verification is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
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
		const { userOp, userOpHash, rpId, signingPayload, sponsorshipProvider,
			sponsorshipPaymasterAddress } = await buildSponsoredUserOp(c.env, {
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
			sponsorshipProvider,
			sponsorshipPaymasterAddress,
			meta: {
				passkeyRegistrationId: registration.registrationId,
				credentialId: registration.credentialId,
				qx: registration.qx,
				qy: registration.qy,
				name: registration.name,
				registrationSource: "backup",
				transports: registration.transports,
				rpId: registration.rpId,
				aaguid: registration.aaguid,
				providerName: registration.providerName,
				credentialDeviceType: registration.credentialDeviceType,
				credentialBackedUp: registration.credentialBackedUp,
				authenticatorAttachment: registration.authenticatorAttachment,
			},
		});

		return c.json({
			userOpHash,
			credentialId: profile?.credentialId ?? null,
			rpId,
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
		const onchainSigner = matchOnchainSigner(signers, passkey.qx as Hex, passkey.qy as Hex);
		if (!onchainSigner) {
			return c.json({ error: "Passkey is not an active signer", error_code: ERR.PASSKEY_NOT_ACTIVE }, 409);
		}
		if (signerCount <= 1n || signerCount - 1n < threshold) {
			return c.json({ error: "Cannot remove the last required passkey", error_code: ERR.LAST_PASSKEY }, 409);
		}
		const callData = encodeFunctionData({
			abi: accountWebAuthnV2Abi,
			functionName: "removeSigners",
			args: [[onchainSigner]],
		});
		const submissionTransport = selectUserOperationTransport(c.env, user.sub);
		const { userOp, userOpHash, rpId, signingPayload, sponsorshipProvider,
			sponsorshipPaymasterAddress } = await buildSponsoredUserOp(c.env, {
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
			sponsorshipProvider,
			sponsorshipPaymasterAddress,
			meta: { credentialId },
		});
		return c.json({
			userOpHash,
			credentialId: profile.credentialId ?? null,
			rpId,
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
	const humanOk = await verifyTurnstile(c.env, turnstileToken, c.req.header("CF-Connecting-IP"), "test_funds");
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
	const expectedOrigin = validWebAuthnRegistrationOrigin(c.env, c.req.header("Origin"));
	if (!expectedOrigin) {
		return c.json({ error: "Invalid WebAuthn origin", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 400);
	}

	try {
		const targets = await activeRecoveryTargets(c.env, user.sub, walletAddress as `0x${string}`);
		const targetStates = await Promise.all(targets.map(async (target) => {
			const publicClient = getPublicClient(target.env);
			const [isRecoveryPending, activeOperation] = await Promise.all([
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "isRecoveryPending",
				}) as Promise<boolean>,
				getActiveAccountOperation(target.env, user.sub, "recovery_propose"),
			]);
			await guardianSignerForAccount(target.env, publicClient, target.account.walletAddress);
			return { isRecoveryPending, activeOperation };
		}));
		if (targetStates.some((state) => state.isRecoveryPending || state.activeOperation)) {
			return c.json({ error: "Ya hay una recuperación en proceso.", error_code: ERR.RECOVERY_IN_PROGRESS }, 409);
		}
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

	try {
		const stepUpToken = c.req.header("X-Step-Up-Token");
		if (!stepUpToken) {
			return c.json({ error: "Security verification is required", error_code: ERR.STEP_UP_REQUIRED }, 403);
		}
		if (!(await validateRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
		}
		const registration = await finalizeWebAuthnRegistration(c.env, {
			uid: user.sub,
			purpose: "recovery_propose",
			credential: registrationCredentialFromBody(body),
		});
		const targets = await activeRecoveryTargets(c.env, user.sub, walletAddress as `0x${string}`);
		const states = await Promise.all(targets.map(async (target) => {
			const publicClient = getPublicClient(target.env);
			const [pending, activeOperation] = await Promise.all([
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "getPendingRecovery",
				}) as Promise<[bigint, Hex[], bigint]>,
				getActiveAccountOperation(target.env, user.sub, "recovery_propose"),
			]);
			const signer = await guardianSignerForAccount(
				target.env,
				publicClient,
				target.account.walletAddress,
			);
			return { target, pending, activeOperation, signer };
		}));
		for (const state of states) {
			if (state.pending[0] > 0n &&
				!recoveryMatches(state.pending, registration.qx as Hex, registration.qy as Hex)) {
				return c.json({
					error: "Ya hay una recuperación distinta en proceso.",
					error_code: ERR.RECOVERY_IN_PROGRESS,
				}, 409);
			}
			if (state.activeOperation &&
				(state.activeOperation.metadata.qx !== qx || state.activeOperation.metadata.qy !== qy)) {
				return c.json({
					error: "Ya hay una recuperación distinta en proceso.",
					error_code: ERR.RECOVERY_IN_PROGRESS,
				}, 409);
			}
		}
		if (!(await consumeRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
		}

		const operations: AccountOperationRecord[] = [];
		for (const state of states) {
			if (state.pending[0] > 0n) continue;
			if (state.activeOperation) {
				operations.push(state.activeOperation);
				continue;
			}
			const network = getNetworkConfig(state.target.account.chainKey);
			const newSigner = buildWebAuthnSigner(
				network.contracts.verifier,
				registration.qx as Hex,
				registration.qy as Hex,
			);
			const { operation } = await submitAccountOperation(state.target.env, {
				uid: user.sub,
				kind: "recovery_propose",
				to: state.target.account.walletAddress,
				data: encodeFunctionData({
					abi: accountWebAuthnV2Abi,
					functionName: "proposeRecovery",
					args: [[newSigner], 1n],
				}),
				metadata: {
					walletAddress: state.target.account.walletAddress,
					isHomeAccount: state.target.account.isHome,
					credentialId: registration.credentialId,
					qx: registration.qx,
					qy: registration.qy,
					passkeyName: registration.name,
					passkeySource: "recovery",
					passkeyTransports: registration.transports,
					passkeyRpId: registration.rpId,
					passkeyAaguid: registration.aaguid,
					passkeyProviderName: registration.providerName,
					passkeyCredentialDeviceType: registration.credentialDeviceType,
					passkeyCredentialBackedUp: registration.credentialBackedUp,
					passkeyAuthenticatorAttachment: registration.authenticatorAttachment,
				},
				signer: state.signer,
			});
			operations.push(operation);
		}
		return c.json({
			...recoveryOperationPayload(operations),
			message: "Recuperación iniciada en todas tus redes. Estará lista en 48 horas.",
		}, operations.length > 0 ? 202 : 200);
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
	const registrationId = typeof body.registrationId === "string" ? body.registrationId : "";
	if (!credentialId || !qx || !qy) {
		return c.json({ error: "Missing credentialId, qx, or qy", error_code: ERR.MISSING_PASSKEY_DATA }, 400);
	}
	try {
		const registration = registrationId
			? await getFinalizedWebAuthnRegistration(c.env, {
				registrationId,
				uid: user.sub,
				purpose: "recovery_propose",
			})
			: null;
		if (
			registrationId &&
			(!registration ||
				registration.credentialId !== credentialId ||
				registration.qx.toLowerCase() !== qx.toLowerCase() ||
				registration.qy.toLowerCase() !== qy.toLowerCase())
		) {
			return c.json({ error: "La metadata de la llave no coincide con la recuperación.", error_code: ERR.WEBAUTHN_REGISTRATION_INVALID }, 409);
		}
		const targets = await activeRecoveryTargets(c.env, user.sub, walletAddress as `0x${string}`);
		const states = await Promise.all(targets.map(async (target) => {
			const publicClient = getPublicClient(target.env);
			const [pending, signers, threshold, activeOperation] = await Promise.all([
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "getPendingRecovery",
				}) as Promise<[bigint, Hex[], bigint]>,
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "getSigners",
					args: [0n, 32n],
				}) as Promise<Hex[]>,
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "threshold",
				}) as Promise<bigint>,
				getActiveAccountOperation(target.env, user.sub, "recovery_execute"),
			]);
			const recovered = pending[0] === 0n && threshold === 1n && signers.length === 1 &&
				Boolean(matchOnchainSigner(signers, qx as Hex, qy as Hex));
			return { target, pending, activeOperation, recovered };
		}));
		for (const state of states) {
			if (state.pending[0] > 0n && !recoveryMatches(state.pending, qx as Hex, qy as Hex)) {
				return c.json({
					error: "La llave no coincide con la recuperación propuesta. Cancela y vuelve a empezar.",
					error_code: ERR.RECOVERY_SIGNER_MISMATCH,
				}, 409);
			}
			if (state.pending[0] === 0n && !state.recovered && !state.activeOperation) {
				return c.json({ error: "La recuperación no está activa en todas las redes.", error_code: ERR.RECOVERY_NONE }, 409);
			}
			if (state.activeOperation &&
				(state.activeOperation.metadata.qx !== qx || state.activeOperation.metadata.qy !== qy)) {
				return c.json({ error: "Hay una recuperación diferente en ejecución.", error_code: ERR.RECOVERY_SIGNER_MISMATCH }, 409);
			}
		}
		const latestExecuteAfter = states.reduce(
			(latest, state) => state.pending[0] > latest ? state.pending[0] : latest,
			0n,
		);
		if (Date.now() / 1000 < Number(latestExecuteAfter)) {
			return c.json({
				error: `La recuperación estará disponible el ${new Date(Number(latestExecuteAfter) * 1000).toLocaleString()}`,
				error_code: ERR.RECOVERY_NOT_READY,
			}, 409);
		}
		const stepUpToken = c.req.header("X-Step-Up-Token");
		if (!stepUpToken) {
			return c.json({ error: "Security verification is required", error_code: ERR.STEP_UP_REQUIRED }, 403);
		}
		if (!(await consumeRecoveryStepUp(c.env, { uid: user.sub, token: stepUpToken }))) {
			return c.json({ error: "Security verification is invalid or expired", error_code: ERR.STEP_UP_INVALID }, 403);
		}

		const operations: AccountOperationRecord[] = [];
		for (const state of states) {
			if (state.recovered) continue;
			if (state.activeOperation) {
				operations.push(state.activeOperation);
				continue;
			}
			const { operation } = await submitAccountOperation(state.target.env, {
				uid: user.sub,
				kind: "recovery_execute",
				to: state.target.account.walletAddress,
				data: encodeFunctionData({
					abi: accountWebAuthnV2Abi,
					functionName: "executeRecovery",
				}),
				metadata: {
					walletAddress: state.target.account.walletAddress,
					isHomeAccount: state.target.account.isHome,
					credentialId,
					qx,
					qy,
					passkeyName: registration?.name ?? null,
					passkeyTransports: registration?.transports ?? [],
					passkeyRpId: registration?.rpId ?? null,
					passkeyAaguid: registration?.aaguid ?? null,
					passkeyProviderName: registration?.providerName ?? null,
					passkeyCredentialDeviceType: registration?.credentialDeviceType ?? null,
					passkeyCredentialBackedUp: registration?.credentialBackedUp ?? null,
					passkeyAuthenticatorAttachment: registration?.authenticatorAttachment ?? null,
				},
			});
			operations.push(operation);
		}
		return c.json({
			...recoveryOperationPayload(operations),
			message: "Recuperación enviada en todas tus redes.",
		}, operations.length > 0 ? 202 : 200);
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

	try {
		const targets = await activeRecoveryTargets(c.env, user.sub, walletAddress as `0x${string}`);
		const states = await Promise.all(targets.map(async (target) => {
			const publicClient = getPublicClient(target.env);
			const [isRecoveryPending, activeOperation] = await Promise.all([
				publicClient.readContract({
					address: target.account.walletAddress,
					abi: accountWebAuthnV2Abi,
					functionName: "isRecoveryPending",
				}) as Promise<boolean>,
				getActiveAccountOperation(target.env, user.sub, "recovery_cancel"),
			]);
			return { target, isRecoveryPending, activeOperation, publicClient };
		}));
		if (!states.some((state) => state.isRecoveryPending || state.activeOperation)) {
			return c.json({ error: "No hay recuperacion en proceso.", error_code: ERR.RECOVERY_NONE }, 409);
		}
		const operations: AccountOperationRecord[] = [];
		for (const state of states) {
			if (state.activeOperation) {
				operations.push(state.activeOperation);
				continue;
			}
			if (!state.isRecoveryPending) continue;
			const signer = await guardianSignerForAccount(
				state.target.env,
				state.publicClient,
				state.target.account.walletAddress,
			);
			const { operation } = await submitAccountOperation(state.target.env, {
				uid: user.sub,
				kind: "recovery_cancel",
				to: state.target.account.walletAddress,
				data: encodeFunctionData({
					abi: accountWebAuthnV2Abi,
					functionName: "guardianCancelRecovery",
				}),
				metadata: {
					walletAddress: state.target.account.walletAddress,
					isHomeAccount: state.target.account.isHome,
				},
				signer,
			});
			operations.push(operation);
		}
		return c.json(recoveryOperationPayload(operations), 202);
	} catch (error) {
		logError("account_recovery_cancel_failed", error, { uid: user.sub });
		if (error instanceof AccountOperationBusyError) {
			return c.json({ error: "El guardian está ocupado. Intenta nuevamente.", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "No pudimos cancelar la recuperación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR }, 500);
	}
});

export default accountRoutes;
