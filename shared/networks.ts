// Single source of truth for every chain the app can run on.
//
// PORTABILITY: to support a new chain you only need to
//   1. deploy the V2 contracts there (ideally with the deterministic CREATE2 script
//      in contracts/script/Deploy.s.sol so addresses match across chains),
//   2. add an entry below with its addresses + explorer/history config,
//   3. add the chain to CHAIN_MAP in server/src/chain.ts (viem chain),
//   4. set CHAIN_KEY to the new key.
// Nothing else in the codebase hardcodes a chain or an address.

export type SupportedChainKey = "base-sepolia" | "arbitrum-sepolia" | "arbitrum-one";

// How /user/transactions reconstructs on-chain history:
//   - "rpc":        scan ERC-20 Transfer logs via eth_getLogs (no API key)
//   - "etherscan":  Etherscan-family API (Arbiscan, Snowtrace, Etherscan v2...) module=account
//   - "blockscout": Blockscout v2 REST API
export type HistoryProvider = "blockscout" | "rpc" | "etherscan";

/** On-chain addresses for one deployment of the Parmelia contracts. */
export type ContractAddresses = {
	/** Canonical ERC-4337 EntryPoint v0.9 — same address on every chain. */
	entryPoint: `0x${string}`;
	factory: `0x${string}`;
	paymaster: `0x${string}`;
	/** ERC-7913 WebAuthn verifier (V2 only). */
	verifier: `0x${string}`;
	usdc: `0x${string}`;
	usdcDecimals: number;
};

export type NetworkConfig = {
	key: SupportedChainKey;
	chainId: number;
	name: string;
	nativeTokenSymbol: string;
	explorerBaseUrl: string;
	historyProvider: HistoryProvider;
	historyApiBaseUrl: string | null;
	faucetUrl: string | null;
	faucetLabel: string | null;
	contracts: ContractAddresses;
};

// Canonical ERC-4337 EntryPoint v0.9 (deterministic — identical on every chain,
// including Arbitrum). This matches OpenZeppelin's Account.entryPoint() default.
const ENTRYPOINT_V09 = "0x433709009B8330FDa32311DF1C2AFA402eD8D009" as const;

// Sentinel for contracts not yet deployed on a given chain. Fill these in after
// running the deterministic deploy script (see contracts/script/Deploy.s.sol).
const TODO_DEPLOY = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_CHAIN_KEY: SupportedChainKey = "arbitrum-sepolia";

export const NETWORKS: Record<SupportedChainKey, NetworkConfig> = {
	// Legacy origin chain. Ran the V1 (single-signer) contracts; kept only as a
	// reference of the structure. Not compatible with the current V2 flow.
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
		contracts: {
			entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
			factory: "0x8c91e55b11287c9c3970b64602fe50763fac0345",
			paymaster: "0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D",
			verifier: "0x0000000000000000000000000000000000000000",
			usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			usdcDecimals: 6,
		},
	},
	// Active deployment target (testnet). Arbitrum supports RIP-7212 (cheap P256
	// passkey verification) and shares the canonical EntryPoint v0.9.
	"arbitrum-sepolia": {
		key: "arbitrum-sepolia",
		chainId: 421614,
		name: "Arbitrum Sepolia",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://sepolia.arbiscan.io",
		historyProvider: "rpc",
		historyApiBaseUrl: null,
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			factory: TODO_DEPLOY, // TODO: deploy V2 to Arbitrum Sepolia, then fill
			paymaster: TODO_DEPLOY, // TODO
			verifier: TODO_DEPLOY, // TODO
			// TODO: confirm Arbitrum Sepolia USDC on https://developers.circle.com/stablecoins/usdc-contract-addresses
			usdc: TODO_DEPLOY,
			usdcDecimals: 6,
		},
	},
	// Production target (mainnet).
	"arbitrum-one": {
		key: "arbitrum-one",
		chainId: 42161,
		name: "Arbitrum One",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://arbiscan.io",
		historyProvider: "etherscan",
		historyApiBaseUrl: "https://api.arbiscan.io/api",
		faucetUrl: null,
		faucetLabel: null,
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			factory: TODO_DEPLOY, // TODO: deploy V2 to Arbitrum One, then fill
			paymaster: TODO_DEPLOY, // TODO
			verifier: TODO_DEPLOY, // TODO
			usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native Circle USDC
			usdcDecimals: 6,
		},
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
