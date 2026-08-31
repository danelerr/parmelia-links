import { encodeFunctionData, keccak256, parseUnits, type Address, type Hex } from "viem";
import { erc20Abi, getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	claimFaucet,
	createAccountOperation,
	enqueueUserEvent,
	ensureReferralCode,
	finishAccountOperation,
	getAccountOperationById,
	getActiveAccountOperation,
	getUserByReferralCode,
	getUserByUsername,
	listActiveAccountOperations,
	markAccountOperationSubmitted,
	rateLimitConsume,
	recordAccountOperationAttempt,
	refundRateLimitConsume,
	releaseFaucetClaim,
	savePasskey,
	revokePasskeysExcept,
	saveUser,
	setInvitedBy,
	sweepAccountOperations,
	writeLedgerEntries,
	type AccountOperationKind,
	type AccountOperationRecord,
} from "./storage";
import {
	getFaucetAccount,
	getFaucetWalletClient,
	getPublicClient,
	getRecoveryGuardianAccount,
	getRecoveryGuardianWalletClient,
	getServerAccount,
	getWalletClient,
} from "./clients";
import { extractErrorMessage, logError, logInfo, logWarn } from "./logger";
import { SignerLeaseBusyError, withSignerLease } from "./signerLease";
import { scheduleEventJob } from "./eventScheduler";
import { refreshWalletBalancesLatest } from "./balanceReconciler";
import { requestBalanceRefresh } from "./balanceReadModel";

const OPERATION_TTL_MS = 24 * 60 * 60_000;
const FAUCET_AMOUNT_USDC = 5;
const FAUCET_WINDOW_SECONDS = 24 * 60 * 60;

type OperationSigner = "server" | "faucet" | "guardian";

export type AccountOperationView = Pick<
	AccountOperationRecord,
	"id" | "kind" | "status" | "txHash" | "attemptCount" | "errorCode" | "createdAt" | "updatedAt" | "confirmedAt"
>;

export class AccountOperationBusyError extends Error {
	constructor() {
		super("The transaction signer is busy. Retry shortly.");
		this.name = "AccountOperationBusyError";
	}
}

export class FaucetBudgetExhaustedError extends Error {
	constructor() {
		super("The daily faucet budget is exhausted.");
		this.name = "FaucetBudgetExhaustedError";
	}
}

export function toAccountOperationView(operation: AccountOperationRecord): AccountOperationView {
	return {
		id: operation.id,
		kind: operation.kind,
		status: operation.status,
		txHash: operation.txHash,
		attemptCount: operation.attemptCount,
		errorCode: operation.errorCode,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		confirmedAt: operation.confirmedAt,
	};
}

export function getFaucetPolicy(env: Bindings): { enabled: boolean; dailyClaims: number } {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const configuredBudget = Number(env.FAUCET_DAILY_BUDGET_USDC);
	const budget = Number.isFinite(configuredBudget) && configuredBudget > 0
		? configuredBudget
		: network.isTestnet ? 500 : 0;
	const enabled = network.isTestnet
		? env.FAUCET_ENABLED !== "false"
		: env.FAUCET_ENABLED === "true" && budget >= FAUCET_AMOUNT_USDC;
	return { enabled, dailyClaims: Math.floor(budget / FAUCET_AMOUNT_USDC) };
}

async function claimDailyFaucetBudget(env: Bindings): Promise<boolean> {
	const policy = getFaucetPolicy(env);
	if (!policy.enabled || policy.dailyClaims < 1) return false;
	return rateLimitConsume(
		env,
		"faucet-daily-budget",
		String(getNetworkConfig(env.CHAIN_KEY).chainId),
		policy.dailyClaims,
		FAUCET_WINDOW_SECONDS,
		{ failClosed: true },
	);
}

async function refundDailyFaucetBudget(env: Bindings): Promise<void> {
	await refundRateLimitConsume(
		env,
		"faucet-daily-budget",
		String(getNetworkConfig(env.CHAIN_KEY).chainId),
		FAUCET_WINDOW_SECONDS,
	);
}

function operationClients(env: Bindings, signer: OperationSigner) {
	if (signer === "faucet") {
		return {
			account: getFaucetAccount(env),
			walletClient: getFaucetWalletClient(env),
		};
	}
	if (signer === "guardian") {
		return {
			account: getRecoveryGuardianAccount(env),
			walletClient: getRecoveryGuardianWalletClient(env),
		};
	}
	return { account: getServerAccount(env), walletClient: getWalletClient(env) };
}

function boundedError(error: unknown): string {
	return extractErrorMessage(error).slice(0, 1_000) || "Unknown RPC error";
}

async function broadcastPersistedOperation(
	env: Bindings,
	operation: AccountOperationRecord,
): Promise<AccountOperationRecord> {
	const publicClient = getPublicClient(env);
	try {
		const sentHash = await publicClient.sendRawTransaction({
			serializedTransaction: operation.rawTransaction,
		});
		if (sentHash.toLowerCase() !== operation.txHash.toLowerCase()) {
			throw new Error("RPC returned a different transaction hash");
		}
		await recordAccountOperationAttempt(env, operation.id, null);
		await markAccountOperationSubmitted(env, operation.id);
		logInfo("account_operation_submitted", {
			operationId: operation.id,
			kind: operation.kind,
			uid: operation.uid,
			txHash: operation.txHash,
		});
	} catch (error) {
		await recordAccountOperationAttempt(env, operation.id, boundedError(error));
		logWarn("account_operation_broadcast_deferred", {
			operationId: operation.id,
			kind: operation.kind,
			uid: operation.uid,
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	return (await getAccountOperationById(env, operation.id)) ?? operation;
}

export async function submitAccountOperation(
	env: Bindings,
	input: {
		uid: string;
		kind: AccountOperationKind;
		to: `0x${string}`;
		data: Hex;
		metadata: Record<string, unknown>;
		signer?: OperationSigner;
	},
): Promise<{ operation: AccountOperationRecord; created: boolean }> {
	const existing = await getActiveAccountOperation(env, input.uid, input.kind);
	if (existing) return { operation: existing, created: false };

	const signer = input.signer ?? "server";
	const { account, walletClient } = operationClients(env, signer);
	try {
		return await withSignerLease(
			env,
			{ chainId: getNetworkConfig(env.CHAIN_KEY).chainId, signerAddress: account.address },
			async () => {
				const raced = await getActiveAccountOperation(env, input.uid, input.kind);
				if (raced) return { operation: raced, created: false };

				const request = await walletClient.prepareTransactionRequest({
					account,
					to: input.to,
					data: input.data,
				});
				if (request.nonce === undefined) throw new Error("Prepared transaction is missing nonce");
				const rawTransaction = await walletClient.signTransaction(request);
				const txHash = keccak256(rawTransaction);
				const now = new Date();
				const id = crypto.randomUUID();
				const inserted = await createAccountOperation(env, {
					id,
					uid: input.uid,
					kind: input.kind,
					txHash,
					rawTransaction,
					signerAddress: account.address,
					nonce: request.nonce,
					metadata: input.metadata,
					createdAt: now.toISOString(),
					expiresAt: new Date(now.getTime() + OPERATION_TTL_MS).toISOString(),
				});

				if (!inserted) {
					const winner = await getActiveAccountOperation(env, input.uid, input.kind);
					if (winner) return { operation: winner, created: false };
					throw new Error("Could not persist account operation");
				}

				const operation = await getAccountOperationById(env, id);
				if (!operation) throw new Error("Persisted account operation is missing");
				return { operation: await broadcastPersistedOperation(env, operation), created: true };
			},
		);
	} catch (error) {
		if (error instanceof SignerLeaseBusyError) throw new AccountOperationBusyError();
		throw error;
	}
}

export async function startFaucetOperation(
	env: Bindings,
	input: { uid: string; walletAddress: `0x${string}`; reference: string },
): Promise<{ operation: AccountOperationRecord; created: boolean } | null> {
	const active = await getActiveAccountOperation(env, input.uid, "faucet");
	if (active) return { operation: active, created: false };
	if (!getFaucetPolicy(env).enabled) return null;
	if (!(await claimFaucet(env, input.uid))) return null;
	if (!(await claimDailyFaucetBudget(env))) {
		await releaseFaucetClaim(env, input.uid).catch(() => null);
		throw new FaucetBudgetExhaustedError();
	}

	try {
		const { usdc, usdcDecimals } = getNetworkConfig(env.CHAIN_KEY).contracts;
		const amount = parseUnits(String(FAUCET_AMOUNT_USDC), usdcDecimals);
		return await submitAccountOperation(env, {
			uid: input.uid,
			kind: "faucet",
			signer: "faucet",
			to: usdc,
			data: encodeFunctionData({
				abi: erc20Abi,
				functionName: "transfer",
				args: [input.walletAddress, amount],
			}),
			metadata: {
				walletAddress: input.walletAddress,
				amount: String(FAUCET_AMOUNT_USDC),
				reference: input.reference,
			},
		});
	} catch (error) {
		try {
			const durable = await getActiveAccountOperation(env, input.uid, "faucet");
			if (durable) return { operation: durable, created: false };
		} catch (lookupError) {
			logError("faucet_operation_state_ambiguous", lookupError, { uid: input.uid });
			throw error;
		}
		await releaseFaucetClaim(env, input.uid).catch(() => null);
		await refundDailyFaucetBudget(env).catch(() => null);
		throw error;
	}
}

function requiredString(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key];
	if (typeof value !== "string" || !value) throw new Error(`Operation metadata is missing ${key}`);
	return value;
}

function optionalString(metadata: Record<string, unknown>, key: string): string | null {
	const value = metadata[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalStringArray(metadata: Record<string, unknown>, key: string): string[] {
	const value = metadata[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function optionalBoolean(metadata: Record<string, unknown>, key: string): boolean | null {
	const value = metadata[key];
	return typeof value === "boolean" ? value : null;
}

async function enqueueAccountSecurityEvent(
	env: Bindings,
	effect: Parameters<typeof enqueueUserEvent>[1],
): Promise<void> {
	await enqueueUserEvent(env, effect);
	await scheduleEventJob(env, "user_event_delivery", {
		delayMs: 1_000,
		reason: "account_security_event",
	}).catch((error) => {
		logError("account_security_event_wakeup_failed", error, {
			eventType: effect.eventType,
			uid: effect.uid,
		});
	});
}

async function finalizeAccountOperation(
	env: Bindings,
	operation: AccountOperationRecord,
	receiptBlockNumber?: bigint,
): Promise<void> {
	const metadata = operation.metadata;
	if (operation.kind === "account_create") {
		const walletAddress = requiredString(metadata, "walletAddress");
		const credentialId = requiredString(metadata, "credentialId");
		const qx = requiredString(metadata, "qx");
		const qy = requiredString(metadata, "qy");
		await saveUser(env, { uid: operation.uid, walletAddress, credentialId });
		await savePasskey(env, {
			uid: operation.uid,
			credentialId,
			qx,
			qy,
			name: optionalString(metadata, "passkeyName"),
			registrationSource: "onboarding",
			transports: optionalStringArray(metadata, "passkeyTransports"),
			rpId: optionalString(metadata, "passkeyRpId"),
			aaguid: optionalString(metadata, "passkeyAaguid"),
			providerName: optionalString(metadata, "passkeyProviderName"),
			credentialDeviceType: optionalString(metadata, "passkeyCredentialDeviceType") as
				| "singleDevice"
				| "multiDevice"
				| null,
			credentialBackedUp: optionalBoolean(metadata, "passkeyCredentialBackedUp"),
			authenticatorAttachment: optionalString(metadata, "passkeyAuthenticatorAttachment") as
				| "platform"
				| "cross-platform"
				| null,
		});
		await ensureReferralCode(env, operation.uid).catch(() => null);

		const ref = typeof metadata.ref === "string" ? metadata.ref.trim() : "";
		if (ref) {
			const inviter =
				(await getUserByReferralCode(env, ref)) ??
				(await getUserByUsername(env, ref.toLowerCase()));
			if (inviter && inviter.uid !== operation.uid) {
				await setInvitedBy(env, operation.uid, inviter.uid);
			}
		}

		await startFaucetOperation(env, {
			uid: operation.uid,
			walletAddress: walletAddress as `0x${string}`,
			reference: "Dólares de bienvenida",
		}).catch((error) =>
			logError("account_operation_autofund_failed", error, {
				operationId: operation.id,
				uid: operation.uid,
			}),
		);
		return;
	}

	if (operation.kind === "faucet") {
		const walletAddress = requiredString(
			metadata,
			"walletAddress",
		).toLowerCase() as Address;
		await writeLedgerEntries(env, [
			{
				uid: operation.uid,
				direction: "in",
				kind: "fund",
				txHash: operation.txHash,
				token: "USDC",
				amount: requiredString(metadata, "amount"),
				counterparty: operation.signerAddress,
				reference: requiredString(metadata, "reference"),
				createdAt: new Date().toISOString(),
			},
		]);
		const network = getNetworkConfig(env.CHAIN_KEY);
		try {
			await refreshWalletBalancesLatest(env, {
				uid: operation.uid,
				accountAddress: walletAddress,
				chainId: network.chainId,
				...(receiptBlockNumber === undefined
					? {}
					: { notBeforeBlock: receiptBlockNumber.toString() }),
			});
		} catch (fastRefreshError) {
			logError(
				"account_operation_balance_fast_refresh_failed",
				fastRefreshError,
				{
					operationId: operation.id,
					uid: operation.uid,
				},
			);
			await requestBalanceRefresh(env, {
				uid: operation.uid,
				accountAddress: walletAddress,
				chainId: network.chainId,
				reason: "confirmed_faucet_operation",
				priority: 0,
				...(receiptBlockNumber === undefined
					? {}
					: { notBeforeBlock: receiptBlockNumber.toString() }),
			}).catch((repairError) => {
				logError(
					"account_operation_balance_refresh_failed",
					repairError,
					{
						operationId: operation.id,
						uid: operation.uid,
					},
				);
			});
		}
		return;
	}

	if (operation.kind === "recovery_execute") {
		const credentialId = requiredString(metadata, "credentialId");
		const qx = requiredString(metadata, "qx");
		const qy = requiredString(metadata, "qy");
		// executeRecovery replaces the entire onchain signer set. Revoke the old
		// management rows first so future registration excludes and Security never
		// present superseded credentials as usable keys.
		await revokePasskeysExcept(env, {
			uid: operation.uid,
			keepCredentialId: credentialId,
		});
		await saveUser(env, { uid: operation.uid, credentialId });
		await savePasskey(env, {
			uid: operation.uid,
			credentialId,
			qx,
			qy,
			registrationSource: "recovery",
			name: optionalString(metadata, "passkeyName"),
			transports: optionalStringArray(metadata, "passkeyTransports"),
			rpId: optionalString(metadata, "passkeyRpId"),
			aaguid: optionalString(metadata, "passkeyAaguid"),
			providerName: optionalString(metadata, "passkeyProviderName"),
			credentialDeviceType: optionalString(metadata, "passkeyCredentialDeviceType") as
				| "singleDevice"
				| "multiDevice"
				| null,
			credentialBackedUp: optionalBoolean(metadata, "passkeyCredentialBackedUp"),
			authenticatorAttachment: optionalString(metadata, "passkeyAuthenticatorAttachment") as
				| "platform"
				| "cross-platform"
				| null,
		});
		await enqueueAccountSecurityEvent(env, {
			dedupeKey: `account-operation:${operation.id}:security.recovery_executed`,
			uid: operation.uid,
			eventType: "security.recovery_executed",
			priority: 0,
			payload: {
				title: "Recuperación completada",
				body: "Tu llave nueva reemplazó las llaves anteriores. Si no fuiste tú, contacta soporte de inmediato.",
				link: "/security",
			},
		});
		return;
	}

	if (operation.kind === "recovery_cancel") {
		await enqueueAccountSecurityEvent(env, {
			dedupeKey: `account-operation:${operation.id}:security.recovery_cancelled`,
			uid: operation.uid,
			eventType: "security.recovery_cancelled",
			priority: 0,
			payload: {
				title: "Recuperación cancelada",
				body: "La solicitud pendiente fue cancelada y tus llaves actuales no cambiaron.",
				link: "/security",
			},
		});
	}
}

async function compensateFailedOperation(env: Bindings, operation: AccountOperationRecord): Promise<void> {
	if (operation.kind !== "faucet") return;
	await releaseFaucetClaim(env, operation.uid).catch(() => null);
	await refundDailyFaucetBudget(env).catch(() => null);
}

export async function reconcileAccountOperation(
	env: Bindings,
	operationOrId: AccountOperationRecord | string,
): Promise<AccountOperationRecord | null> {
	let operation = typeof operationOrId === "string"
		? await getAccountOperationById(env, operationOrId)
		: operationOrId;
	if (!operation || !["prepared", "submitted"].includes(operation.status)) return operation;

	if (operation.status === "prepared") {
		try {
			operation = await withSignerLease(
				env,
				{
					chainId: getNetworkConfig(env.CHAIN_KEY).chainId,
					signerAddress: operation.signerAddress,
					operationId: operation.id,
				},
				() => broadcastPersistedOperation(env, operation!),
			);
		} catch (error) {
			if (error instanceof SignerLeaseBusyError) return operation;
			throw error;
		}
	}

	const publicClient = getPublicClient(env);
	let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
	try {
		receipt = await publicClient.getTransactionReceipt({ hash: operation.txHash });
	} catch (error) {
		const message = boundedError(error);
		await recordAccountOperationAttempt(env, operation.id, message);
		if (Date.now() > new Date(operation.expiresAt).getTime()) {
			const latestNonce = await publicClient.getTransactionCount({
				address: operation.signerAddress,
				blockTag: "latest",
			}).catch(() => operation.nonce);
			await finishAccountOperation(env, operation.id, "needs_review", {
				errorCode: latestNonce > operation.nonce ? "NONCE_CONSUMED" : "TX_STUCK",
				lastError: message,
			});
		}
		return await getAccountOperationById(env, operation.id);
	}

	if (receipt.status === "reverted") {
		const won = await finishAccountOperation(env, operation.id, "failed", {
			errorCode: "TX_REVERTED",
			lastError: "Transaction reverted on-chain",
		});
		if (won) await compensateFailedOperation(env, operation);
	} else {
		try {
			await finalizeAccountOperation(
				env,
				operation,
				receipt.blockNumber,
			);
			await finishAccountOperation(env, operation.id, "confirmed");
			logInfo("account_operation_confirmed", {
				operationId: operation.id,
				kind: operation.kind,
				uid: operation.uid,
				txHash: operation.txHash,
			});
		} catch (error) {
			const message = boundedError(error);
			await recordAccountOperationAttempt(env, operation.id, message);
			logError("account_operation_finalize_failed", error, {
				operationId: operation.id,
				kind: operation.kind,
				uid: operation.uid,
				txHash: operation.txHash,
			});
		}
	}

	return await getAccountOperationById(env, operation.id);
}

export async function runAccountOperationReconciler(
	env: Bindings,
	limit = 25,
): Promise<void> {
	try {
		const operations = await listActiveAccountOperations(env, limit);
		for (const operation of operations) {
			try {
				await reconcileAccountOperation(env, operation);
			} catch (error) {
				logError("account_operation_reconcile_failed", error, {
					operationId: operation.id,
					kind: operation.kind,
					uid: operation.uid,
				});
			}
		}
		await sweepAccountOperations(env);
	} catch (error) {
		logError("account_operation_reconciler_failed", error, {});
	}
}
