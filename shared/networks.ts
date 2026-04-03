export type SupportedChainKey = "base-sepolia" | "monad-testnet";

export type NetworkConfig = {
	key: SupportedChainKey;
	chainId: number;
	name: string;
	nativeTokenSymbol: string;
	explorerBaseUrl: string;
	historyProvider: "blockscout" | "rpc" | "monadscan";
	historyApiBaseUrl: string | null;
	faucetUrl: string | null;
	faucetLabel: string | null;
};

export const DEFAULT_CHAIN_KEY: SupportedChainKey = "monad-testnet";

export const NETWORKS: Record<SupportedChainKey, NetworkConfig> = {
	"base-sepolia": {
		key: "base-sepolia",
		chainId: 84532,
		name: "Base Sepolia",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://base-sepolia.blockscout.com",
		historyProvider: "blockscout",
		historyApiBaseUrl: "https://base-sepolia.blockscout.com/api/v2",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
	},
	"monad-testnet": {
		key: "monad-testnet",
		chainId: 10143,
		name: "Monad Testnet",
		nativeTokenSymbol: "MON",
		explorerBaseUrl: "https://testnet.monadscan.com",
		historyProvider: "monadscan",
		historyApiBaseUrl: "https://api-testnet.monadscan.com/api",
		faucetUrl: "https://faucet.monad.xyz",
		faucetLabel: "Monad Faucet",
	},
};

const SUPPORTED_CHAIN_KEYS = Object.keys(NETWORKS) as SupportedChainKey[];

export function isSupportedChainKey(value: string): value is SupportedChainKey {
	return SUPPORTED_CHAIN_KEYS.includes(value as SupportedChainKey);
}

export function getNetworkConfig(chainKey?: string): NetworkConfig {
	if (chainKey && isSupportedChainKey(chainKey)) {
		return NETWORKS[chainKey];
	}
	return NETWORKS[DEFAULT_CHAIN_KEY];
}
