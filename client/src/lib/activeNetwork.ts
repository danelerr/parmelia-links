import { DEFAULT_CHAIN_KEY, getNetworkConfig, isSupportedChainKey } from "./networks";

function trimTrailingSlash(value: string) {
	return value.replace(/\/+$/, "");
}

const configuredChainKey = import.meta.env.VITE_CHAIN_KEY;
const activeChainKey =
	configuredChainKey && isSupportedChainKey(configuredChainKey)
		? configuredChainKey
		: DEFAULT_CHAIN_KEY;
const networkDefaults = getNetworkConfig(activeChainKey);

const defaultExplorerBaseUrl = networkDefaults.explorerBaseUrl;
const configuredExplorerBaseUrl =
	import.meta.env.VITE_CHAIN_EXPLORER_URL || defaultExplorerBaseUrl;
const configuredFaucetUrl =
	import.meta.env.VITE_FAUCET_URL || networkDefaults.faucetUrl || "";
const configuredFaucetLabel =
	import.meta.env.VITE_FAUCET_LABEL || networkDefaults.faucetLabel || "Faucet";

export const activeNetwork = {
	key: activeChainKey,
	chainId: networkDefaults.chainId,
	name: import.meta.env.VITE_CHAIN_NAME || networkDefaults.name,
	isTestnet: networkDefaults.isTestnet,
	nativeTokenSymbol:
		import.meta.env.VITE_NATIVE_TOKEN_SYMBOL || networkDefaults.nativeTokenSymbol,
	explorerBaseUrl: trimTrailingSlash(configuredExplorerBaseUrl),
	faucetUrl: configuredFaucetUrl,
	faucetLabel: configuredFaucetLabel,
	currencies: networkDefaults.currencies,
};

export function getExplorerTxUrl(txHash: string, chainKey?: string) {
	const explorer = chainKey
		? getNetworkConfig(chainKey).explorerBaseUrl
		: activeNetwork.explorerBaseUrl;
	return `${trimTrailingSlash(explorer)}/tx/${txHash}`;
}

/** Returns no link for an explicit unknown chain instead of inventing home. */
export function getKnownExplorerTxUrl(txHash: string, chainKey?: string) {
	if (!chainKey || !isSupportedChainKey(chainKey)) return null;
	return getExplorerTxUrl(txHash, chainKey);
}
