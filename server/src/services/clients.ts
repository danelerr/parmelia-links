import {
	createPublicClient,
	createWalletClient,
	fallback,
	http,
	type Chain,
	type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getActiveChain } from "../chain";
import type { Bindings } from "../middlewares/auth";
import { getFaucetKey, getRecoveryGuardianKey } from "./keys";
import {
	controlledHttpTransport,
	laneForRole,
} from "./rpcControlPlane";
import {
	getRpcEndpointCapabilities,
	type RpcEndpointCapability,
	type RpcRoleName,
} from "./rpcProviders";
import {
	isRangeCapacityError,
	isTransientRpcError,
} from "./adaptiveLogs";

export type RpcRole = RpcRoleName;

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const MIN_RPC_TIMEOUT_MS = 1_000;
const MAX_RPC_TIMEOUT_MS = 30_000;

function boundedInteger(
	raw: string | undefined,
	fallbackValue: number,
	min: number,
	max: number,
): number {
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return fallbackValue;
	return Math.min(max, Math.max(min, parsed));
}

function configuredRpcValue(env: Bindings, role: RpcRole): string {
	const roleValue =
		role === "read"
			? env.RPC_READ_URLS
			: role === "write"
				? env.RPC_WRITE_URLS
				: role === "indexer"
					? env.RPC_INDEXER_URLS
					: role === "archive"
						? env.RPC_ARCHIVE_URLS
						: env.BUNDLER_RPC_URLS;

	// Compatibility path: existing deployments only have RPC_URL. Roles can be
	// introduced one at a time without an outage.
	if (roleValue?.trim()) return roleValue;
	if (role === "bundler") return "";
	if (role === "archive" && env.RPC_INDEXER_URLS?.trim()) return env.RPC_INDEXER_URLS;
	if (role === "write" && env.RPC_READ_URLS?.trim()) return env.RPC_READ_URLS;
	return env.RPC_URL ?? "";
}

export function getRpcUrls(env: Bindings, role: RpcRole): string[] {
	return configuredRpcValue(env, role)
		.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
}

/**
 * Build a deterministic failover transport. Ranking is deliberately disabled:
 * endpoint order expresses operator intent and does not oscillate between a
 * managed endpoint and the public reconciliation endpoint.
 */
export function buildRpcTransport(
	rpcUrl: string,
	options: {
		timeoutMs?: number;
		env?: Bindings;
		role?: RpcRole;
		/** Preserve the endpoint's configured position when building one URL. */
		slotOffset?: number;
		endpointCapabilities?: readonly RpcEndpointCapability[];
	} = {},
): Transport {
	const urls = rpcUrl
		.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
	const timeout = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
	const transports = urls.map((url, slot) => {
		const configuredSlot = (options.slotOffset ?? 0) + slot;
		const capability = options.endpointCapabilities?.[slot];
		return (
			options.env && options.role
				? controlledHttpTransport(options.env, url, {
						role: options.role,
						slot: configuredSlot,
						lane: laneForRole(options.role),
						timeoutMs: timeout,
						providerAlias: capability?.id,
						maxConcurrency: capability?.maxConcurrency,
					})
				: http(url, {
						timeout,
						// One retry policy lives at the call/control-plane layer. Hidden
						// transport retries make CU accounting and deadlines misleading.
						retryCount: 0,
					})
		);
	});
	if (urls.length > 1) {
		return fallback(transports, { rank: false, retryCount: 0 });
	}
	return transports[0] ?? http(rpcUrl, { timeout, retryCount: 0 });
}

function getRpcTimeout(env: Bindings): number {
	return boundedInteger(
		env.RPC_TIMEOUT_MS,
		DEFAULT_RPC_TIMEOUT_MS,
		MIN_RPC_TIMEOUT_MS,
		MAX_RPC_TIMEOUT_MS,
	);
}

/** Read-only client for a declared workload role. */
function getPublicClientForRole(env: Bindings, role: RpcRole) {
	const urls = getRpcUrls(env, role);
	const endpointCapabilities = getRpcEndpointCapabilities(
		env,
		role,
		urls.length,
	);
	return createPublicClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(urls.join(","), {
			timeoutMs: getRpcTimeout(env),
			env,
			role,
			endpointCapabilities,
		}),
		batch: {
			multicall: {
				batchSize: 32 * 1024,
				wait: 8,
			},
		},
	});
}

/** Point reads used by API/background reconciliation. Never used by Home. */
export function getPublicClient(env: Bindings) {
	return getPublicClientForRole(env, "read");
}

/** Point reads for indexer evidence, with deterministic endpoint failover. */
function getIndexerClient(env: Bindings) {
	return getPublicClientForRole(env, "indexer");
}

class RpcIndexerRangeFallbackError extends Error {
	constructor(cause?: unknown) {
		super("No healthy indexer provider can serve the requested block range", {
			cause,
		});
		this.name = "RpcIndexerRangeFallbackError";
	}
}

/**
 * Provider-aware log pool. Every endpoint declares its own plan/capacity
 * limits, so a 2,000-block public endpoint and a 10-block managed endpoint can
 * coexist without duplicating requests or forcing the whole role down to ten.
 */
export function getIndexerProviderPool(env: Bindings) {
	const urls = getRpcUrls(env, "indexer");
	const capabilities = getRpcEndpointCapabilities(
		env,
		"indexer",
		urls.length,
	);
	const providers = urls
		.map((url, slot) => {
			const capability = capabilities[slot];
			const client = createPublicClient({
				chain: getActiveChain(env.CHAIN_KEY),
				transport: buildRpcTransport(url, {
					timeoutMs: getRpcTimeout(env),
					env,
					role: "indexer",
					slotOffset: slot,
					endpointCapabilities: [capability],
				}),
			});
			return { capability, client };
		})
		.sort(
			(left, right) =>
				left.capability.priority - right.capability.priority ||
				left.capability.id.localeCompare(right.capability.id),
		);
	const configuredRanges = providers
		.map((provider) => provider.capability.maxLogRange)
		.filter((value): value is number => value !== null);

	return {
		pointClient: getIndexerClient(env),
		maxLogRange:
			configuredRanges.length > 0
				? BigInt(Math.max(...configuredRanges))
				: 1n,
		minLogRange:
			configuredRanges.length > 0
				? BigInt(Math.min(...configuredRanges))
				: 1n,
		async requestLogs<Log>(
			fromBlock: bigint,
			toBlock: bigint,
			request: (
				client: (typeof providers)[number]["client"],
			) => Promise<readonly Log[]>,
		): Promise<readonly Log[]> {
			const span = toBlock - fromBlock + 1n;
			const eligible = providers.filter(
				(provider) =>
					provider.capability.maxLogRange !== null &&
					BigInt(provider.capability.maxLogRange) >= span,
			);
			if (eligible.length === 0) {
				throw new RpcIndexerRangeFallbackError();
			}
			let lastError: unknown;
			for (const provider of eligible) {
				try {
					return await request(provider.client);
				} catch (error) {
					lastError = error;
					if (
						!isTransientRpcError(error) &&
						!isRangeCapacityError(error)
					) {
						throw error;
					}
				}
			}
			const smallerProviderExists = providers.some(
				(provider) =>
					provider.capability.maxLogRange !== null &&
					BigInt(provider.capability.maxLogRange) < span,
			);
			if (smallerProviderExists || isRangeCapacityError(lastError)) {
				throw new RpcIndexerRangeFallbackError(lastError);
			}
			throw lastError;
		},
	};
}

/** The server EOA used to deploy accounts and relay handleOps/CCTP. */
export function getServerAccount(env: Bindings) {
	return privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
}

/** Write client signing with the server EOA. */
export function getWalletClient(env: Bindings) {
	const urls = getRpcUrls(env, "write");
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(urls.join(","), {
			timeoutMs: getRpcTimeout(env),
			env,
			role: "write",
		}),
		account: getServerAccount(env),
	});
}

export function getFaucetAccount(env: Bindings) {
	return privateKeyToAccount(getFaucetKey(env));
}

export function getFaucetWalletClient(env: Bindings) {
	const urls = getRpcUrls(env, "write");
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(urls.join(","), {
			timeoutMs: getRpcTimeout(env),
			env,
			role: "write",
		}),
		account: getFaucetAccount(env),
	});
}

export function getRecoveryGuardianAccount(env: Bindings) {
	return privateKeyToAccount(getRecoveryGuardianKey(env));
}

export function getRecoveryGuardianWalletClient(env: Bindings) {
	const urls = getRpcUrls(env, "write");
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(urls.join(","), {
			timeoutMs: getRpcTimeout(env),
			env,
			role: "write",
		}),
		account: getRecoveryGuardianAccount(env),
	});
}

/**
 * Public + wallet clients for an ARBITRARY chain (used by the cross-chain relayer
 * to call receiveMessage on the destination chain). Signs with the server EOA, so
 * that EOA must hold gas on the destination chain.
 */
export function getChainClients(env: Bindings, chain: Chain, rpcUrl: string) {
	return {
		publicClient: createPublicClient({
			chain,
			transport: buildRpcTransport(rpcUrl, {
				timeoutMs: getRpcTimeout(env),
				env,
				role: "read",
			}),
		}),
		walletClient: createWalletClient({
			chain,
			transport: buildRpcTransport(rpcUrl, {
				timeoutMs: getRpcTimeout(env),
				env,
				role: "write",
			}),
			account: getServerAccount(env),
		}),
	};
}

/** Convenience bundle for handlers that need both clients and the server account. */
export function getClients(env: Bindings) {
	return {
		publicClient: getPublicClient(env),
		walletClient: getWalletClient(env),
		serverAccount: getServerAccount(env),
	};
}

// Tuned for fast L2s (Arbitrum blocks ~250ms): poll often so confirmation is quick,
// but cap the wait so a stuck RPC can't hang the Worker request forever.
const RECEIPT_POLL_INTERVAL_MS = 300;
const RECEIPT_TIMEOUT_MS = 60_000;

/** Wait for a tx receipt with L2-tuned polling + a hard timeout. */
export function waitForTx(
	publicClient: ReturnType<typeof getPublicClient>,
	hash: `0x${string}`,
) {
	return publicClient.waitForTransactionReceipt({
		hash,
		pollingInterval: RECEIPT_POLL_INTERVAL_MS,
		timeout: RECEIPT_TIMEOUT_MS,
	});
}
