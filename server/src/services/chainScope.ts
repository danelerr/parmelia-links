import {
	DEFAULT_CHAIN_KEY,
	NETWORKS,
	getNetworkConfig,
	isSupportedChainKey,
	type SupportedChainKey,
} from "../../../shared";
import type { Bindings } from "../middlewares/auth";

type RpcRoleConfig = {
	read?: string;
	write?: string;
	indexer?: string;
	archive?: string;
	bundler?: string;
};

type RpcMapValue = string | RpcRoleConfig;

function parseRpcMapValue(raw: string | undefined): Record<string, RpcMapValue> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, RpcMapValue>;
	} catch {
		return {};
	}
}

function parseRpcMap(env: Bindings): Record<string, RpcMapValue> {
	return {
		...parseRpcMapValue(env.CCTP_RPC_URLS?.trim()),
		...parseRpcMapValue(env.APP_CHAIN_RPC_URLS?.trim()),
	};
}

export function enabledAppChainKeys(env: Bindings): SupportedChainKey[] {
	const configured = (env.APP_ENABLED_CHAIN_KEYS || env.CHAIN_KEY || DEFAULT_CHAIN_KEY)
		.split(",")
		.map((value) => value.trim())
		.filter(isSupportedChainKey);
	const unique = [...new Set(configured)];
	return unique.length > 0 ? unique : [DEFAULT_CHAIN_KEY];
}

/**
 * Runtime rollout gate. Code support and remote readiness are deliberately
 * separate: deploying verified contracts/RPCs can enable Fuji without another
 * frontend build, while the production default remains home-chain only.
 */
export function enabledWalletRailChainKeys(env: Bindings): SupportedChainKey[] {
	const configured = (env.APP_WALLET_RAIL_CHAIN_KEYS || env.CHAIN_KEY || DEFAULT_CHAIN_KEY)
		.split(",")
		.map((value) => value.trim())
		.filter(isSupportedChainKey);
	return [...new Set(configured)].filter(
		(key) =>
			enabledAppChainKeys(env).includes(key) &&
			NETWORKS[key].walletRailEnabled,
	);
}

export function resolveAppChainKey(
	env: Bindings,
	requested: unknown,
	options: { requireWalletRail?: boolean } = {},
): SupportedChainKey | null {
	const key = typeof requested === "string" && requested.trim()
		? requested.trim()
		: env.CHAIN_KEY || DEFAULT_CHAIN_KEY;
	if (!isSupportedChainKey(key) || !enabledAppChainKeys(env).includes(key)) return null;
	if (
		options.requireWalletRail &&
		!enabledWalletRailChainKeys(env).includes(key)
	) return null;
	return key;
}

/**
 * Request-scoped bindings for one chain. The returned object is immutable for
 * the request and never lives at module scope, avoiding cross-request I/O/state
 * leakage in reused Workers isolates.
 */
export function bindingsForChain(env: Bindings, chainKey: SupportedChainKey): Bindings {
	const network = getNetworkConfig(chainKey);
	if (chainKey === env.CHAIN_KEY) return env;
	const value = parseRpcMap(env)[String(network.chainId)];
	const roles: RpcRoleConfig = typeof value === "string" ? { read: value, write: value, indexer: value, archive: value } : value ?? {};
	const read = roles.read?.trim() || "";
	const write = roles.write?.trim() || read;
	const indexer = roles.indexer?.trim() || read;
	const archive = roles.archive?.trim() || indexer;
	return {
		...env,
		CHAIN_KEY: chainKey,
		RPC_URL: read,
		RPC_READ_URLS: read,
		RPC_WRITE_URLS: write,
		RPC_INDEXER_URLS: indexer,
		RPC_ARCHIVE_URLS: archive,
		BUNDLER_RPC_URLS: roles.bundler?.trim() || "",
		SPONSORSHIP_PAYMASTER_ADDRESS: network.contracts.paymaster,
	};
}

export function appChainCapabilities(env: Bindings) {
	return enabledAppChainKeys(env).map((key) => {
		const network = NETWORKS[key];
		const scoped = bindingsForChain(env, key);
		return {
			key,
			chainId: network.chainId,
			name: network.name,
			nativeTokenSymbol: network.nativeTokenSymbol,
			isTestnet: network.isTestnet,
			walletRailEnabled: enabledWalletRailChainKeys(env).includes(key),
			swapEnabled: Boolean(network.uniswap),
			explorerBaseUrl: network.explorerBaseUrl,
			faucetUrl: network.faucetUrl,
			assets: network.tokens.map((token) => ({
				symbol: token.symbol,
				name: token.name,
				decimals: token.decimals,
				isNative: Boolean(token.isNative),
			})),
			rpcConfigured: Boolean(scoped.RPC_READ_URLS?.trim()),
		};
	});
}
