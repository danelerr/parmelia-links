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

/** On-chain addresses for one deployment of the Parmelia contracts. */
export type ContractAddresses = {
	/** Canonical ERC-4337 EntryPoint v0.9 - same address on every chain. */
	entryPoint: `0x${string}`;
	factory: `0x${string}`;
	paymaster: `0x${string}`;
	/** ERC-7913 WebAuthn verifier (V2 only). */
	verifier: `0x${string}`;
	/** Open-payment router for Flow B (any external wallet → merchant). */
	paymentRouter: `0x${string}`;
	usdc: `0x${string}`;
	usdcDecimals: number;
};

/** A whitelisted asset Parmelia supports on a given chain. */
export type TokenConfig = {
	symbol: string;
	name: string;
	/** ERC-20 address, or null for the native asset (ETH). */
	address: `0x${string}` | null;
	decimals: number;
	isNative?: boolean;
	/** Wrapped ERC-20 used when a route requires one (e.g. WETH for native ETH). */
	wrappedAddress?: `0x${string}`;
	coingeckoId?: string;
};

/**
 * Uniswap infrastructure on a chain. All addresses verified against the
 * official deployment docs (developers.uniswap.org) - v4 deployments page for
 * UR/PoolManager/V4Quoter/Permit2, v3 deployments page for QuoterV2.
 */
export type UniswapConfig = {
	/** Universal Router (v4-compatible) - single execution surface for v3+v4 swaps. */
	universalRouter: `0x${string}`;
	/** Canonical Permit2 (same address on every chain). */
	permit2: `0x${string}`;
	/** Uniswap v3 QuoterV2 (on-chain quoting, no API key). */
	v3QuoterV2: `0x${string}`;
	/** Uniswap v4 Quoter (on-chain quoting, no API key). */
	v4Quoter: `0x${string}`;
	/** Uniswap v4 PoolManager (singleton). */
	v4PoolManager: `0x${string}`;
};

export type NetworkConfig = {
	key: SupportedChainKey;
	chainId: number;
	name: string;
	nativeTokenSymbol: string;
	explorerBaseUrl: string;
	faucetUrl: string | null;
	faucetLabel: string | null;
	contracts: ContractAddresses;
	/** Whitelisted swap/balance assets on this chain. Empty = swaps disabled. */
	tokens: TokenConfig[];
	/** Uniswap infra; null = swaps disabled on this chain. */
	uniswap: UniswapConfig | null;
};

// Canonical ERC-4337 EntryPoint v0.9 (deterministic - identical on every chain,
// including Arbitrum). This matches OpenZeppelin's Account.entryPoint() default.
const ENTRYPOINT_V09 = "0x433709009B8330FDa32311DF1C2AFA402eD8D009" as const;

// Canonical Permit2 - deterministic deployment, identical on every chain.
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

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
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
		contracts: {
			entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
			factory: "0x8c91e55b11287c9c3970b64602fe50763fac0345",
			paymaster: "0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D",
			verifier: "0x0000000000000000000000000000000000000000",
			paymentRouter: TODO_DEPLOY,
			usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			usdcDecimals: 6,
		},
		tokens: [],
		uniswap: null,
	},
	// Active deployment target (testnet). Arbitrum supports RIP-7212 (cheap P256
	// passkey verification) and shares the canonical EntryPoint v0.9.
	"arbitrum-sepolia": {
		key: "arbitrum-sepolia",
		chainId: 421614,
		name: "Arbitrum Sepolia",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://sepolia.arbiscan.io",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			factory: "0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB",
			paymaster: "0x31f357a64cF5899da21337f0D9e28ef8D6385753",
			verifier: "0xb7fA10dEe75042D6973676A7d7882e4621B806d6",
			paymentRouter: TODO_DEPLOY, // TODO: deploy ParmeliaPaymentRouter (Flow B)
			// Circle's official testnet USDC on Arbitrum Sepolia.
			usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
			usdcDecimals: 6,
		},
		tokens: [
			{
				symbol: "ETH",
				name: "Ethereum",
				address: null,
				decimals: 18,
				isNative: true,
				// Uniswap v3 docs - WETH on Arbitrum Sepolia.
				wrappedAddress: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
				coingeckoId: "ethereum",
			},
			{
				symbol: "USDC",
				name: "USD Coin",
				address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
				decimals: 6,
				coingeckoId: "usd-coin",
			},
			// NOTE: no canonical WBTC exists on Arbitrum Sepolia. BTC pairs are
			// mainnet-only until we deploy/choose a test token. Intentionally omitted.
		],
		uniswap: {
			universalRouter: "0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47",
			permit2: PERMIT2,
			v3QuoterV2: "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B",
			v4Quoter: "0x7dE51022d70A725b508085468052E25e22b5c4c9",
			v4PoolManager: "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317",
		},
	},
	// Production target (mainnet).
	"arbitrum-one": {
		key: "arbitrum-one",
		chainId: 42161,
		name: "Arbitrum One",
		nativeTokenSymbol: "ETH",
		explorerBaseUrl: "https://arbiscan.io",
		faucetUrl: null,
		faucetLabel: null,
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			factory: TODO_DEPLOY, // TODO: deploy V2 to Arbitrum One, then fill
			paymaster: TODO_DEPLOY, // TODO
			verifier: TODO_DEPLOY, // TODO
			paymentRouter: TODO_DEPLOY, // TODO
			usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native Circle USDC
			usdcDecimals: 6,
		},
		tokens: [
			{
				symbol: "ETH",
				name: "Ethereum",
				address: null,
				decimals: 18,
				isNative: true,
				wrappedAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
				coingeckoId: "ethereum",
			},
			{
				symbol: "USDC",
				name: "USD Coin",
				address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
				decimals: 6,
				coingeckoId: "usd-coin",
			},
			{
				// Chosen BTC wrapper: WBTC - deepest BTC liquidity on Arbitrum
				// (v3 WBTC/WETH + WBTC/USDC pools). Config-driven: swap to cbBTC
				// later by editing this entry only.
				symbol: "WBTC",
				name: "Wrapped Bitcoin",
				address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
				decimals: 8,
				coingeckoId: "wrapped-bitcoin",
			},
		],
		uniswap: {
			universalRouter: "0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3",
			permit2: PERMIT2,
			v3QuoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
			v4Quoter: "0x3972C00f7ed4885e145823eb7C655375D275A1C5",
			v4PoolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
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

/** Resolve a whitelisted token by symbol (case-insensitive). Null if not allowed. */
export function getTokenBySymbol(
	network: NetworkConfig,
	symbol: string,
): TokenConfig | null {
	const normalized = symbol.trim().toUpperCase();
	return network.tokens.find((t) => t.symbol === normalized) ?? null;
}
