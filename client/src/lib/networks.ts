// Client-side mirror of the network metadata the UI displays.
//
// This is intentionally a small standalone copy of shared/networks.ts: Vercel
// builds the client from this folder and cannot reach ../shared. The client only
// ever needs presentation fields (name, symbol, explorer, faucet) — all on-chain
// work and addresses live on the server — so keep just those in sync here.
export type SupportedChainKey = "base-sepolia" | "arbitrum-sepolia" | "arbitrum-one";

export type NetworkConfig = {
	key: SupportedChainKey;
	name: string;
	nativeTokenSymbol: string;
	explorerBaseUrl: string;
	faucetUrl: string | null;
	faucetLabel: string | null;
};

export const DEFAULT_CHAIN_KEY: SupportedChainKey = "arbitrum-sepolia";

export const NETWORKS: Record<SupportedChainKey, NetworkConfig> = {
	"base-sepolia": {
		key: "base-sepolia",
		name: "Base Sepolia",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://base-sepolia.blockscout.com",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
	},
	"arbitrum-sepolia": {
		key: "arbitrum-sepolia",
		name: "Arbitrum Sepolia",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://sepolia.arbiscan.io",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
	},
	"arbitrum-one": {
		key: "arbitrum-one",
		name: "Arbitrum One",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://arbiscan.io",
		faucetUrl: null,
		faucetLabel: null,
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
