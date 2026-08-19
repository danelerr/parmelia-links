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

/** On-chain addresses for one deployment of the GatoPago contracts. */
export type ContractAddresses = {
	/** Canonical ERC-4337 EntryPoint v0.9 - same address on every chain. */
	entryPoint: `0x${string}`;
	factory: `0x${string}`;
	paymaster: `0x${string}`;
	/** ERC-7913 WebAuthn verifier (V2 only). */
	verifier: `0x${string}`;
	/** Open-payment router for Flow B (any external wallet → merchant). */
	paymentRouter: `0x${string}`;
	/** Cross-chain router: fee-skim + CCTP depositForBurn (outbound). */
	crosschainRouter: `0x${string}`;
	usdc: `0x${string}`;
	usdcDecimals: number;
};

/** A whitelisted asset GatoPago supports on a given chain. */
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

/**
 * Aave v3 integration for the Earn module (savings). Addresses verified against
 * the BGD Labs aave-address-book (github.com/bgd-labs/aave-address-book) on
 * 2026-07-03. NOTE: unlike GatoPago's own CREATE2 contracts, Aave addresses are
 * NOT deterministic across networks — always take them from the address book.
 */
export type AaveConfig = {
	/** Aave v3 Pool (supply/withdraw/getReserveData). */
	pool: `0x${string}`;
	/** aToken of the USDC reserve (rebasing 1:1; balanceOf = saved balance). */
	aUsdc: `0x${string}`;
};

/**
 * Circle CCTP v2 facts for a chain (protocol-level, NOT GatoPago contracts).
 * Needed for both the source (depositForBurn via TokenMessenger) and any
 * destination (receiveMessage via MessageTransmitter). Keyed by EVM chainId in
 * CCTP_CHAINS because destinations may be chains GatoPago doesn't run on.
 * IMPORTANT: `domain` is Circle's own chain id, distinct from the EVM chainId.
 */
export type CctpChain = {
	chainId: number;
	name: string;
	/** Circle CCTP domain (distinct from chainId). */
	domain: number;
	/** CCTP v2 TokenMessenger (depositForBurn). */
	tokenMessenger: `0x${string}`;
	/** CCTP v2 MessageTransmitter (receiveMessage). */
	messageTransmitter: `0x${string}`;
	/** Native USDC on this chain. */
	usdc: `0x${string}`;
};

export type NetworkConfig = {
	key: SupportedChainKey;
	chainId: number;
	name: string;
	nativeTokenSymbol: string;
	/**
	 * Real-money network or not. Security gates that are allowed to fail open in
	 * dev (Turnstile, key fallbacks) MUST fail closed when this is false.
	 */
	isTestnet: boolean;
	explorerBaseUrl: string;
	faucetUrl: string | null;
	faucetLabel: string | null;
	contracts: ContractAddresses;
	/**
	 * Whether the DEPLOYED paymentRouter bytecode includes payInvoiceWithPermit
	 * (EIP-2612). The Solidity source has it, but a router deployed before that
	 * change does not — flip this to true only after redeploying + verifying.
	 */
	paymentRouterHasPermit: boolean;
	/** Whitelisted swap/balance assets on this chain. Empty = swaps disabled. */
	tokens: TokenConfig[];
	/** Uniswap infra; null = swaps disabled on this chain. */
	uniswap: UniswapConfig | null;
	/** Aave v3 (Earn/savings); null = Earn disabled on this chain. */
	aave: AaveConfig | null;
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
		isTestnet: true,
		explorerBaseUrl: "https://base-sepolia.blockscout.com",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
		contracts: {
			entryPoint: "0x433709009B8330FDa32311DF1C2AFA402eD8D009",
			factory: "0x8c91e55b11287c9c3970b64602fe50763fac0345",
			paymaster: "0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D",
			verifier: "0x0000000000000000000000000000000000000000",
			paymentRouter: TODO_DEPLOY,
			crosschainRouter: TODO_DEPLOY, // destino CCTP (domain 6); no se origina aquí
			usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			usdcDecimals: 6,
		},
		paymentRouterHasPermit: false,
		tokens: [],
		uniswap: null,
		aave: null,
	},
	// Active deployment target (testnet). Arbitrum supports RIP-7212 (cheap P256
	// passkey verification) and shares the canonical EntryPoint v0.9.
	"arbitrum-sepolia": {
		key: "arbitrum-sepolia",
		chainId: 421614,
		name: "Arbitrum Sepolia",
		nativeTokenSymbol: "ETH",
		isTestnet: true,
		explorerBaseUrl: "https://sepolia.arbiscan.io",
		faucetUrl: "https://faucet.circle.com",
		faucetLabel: "Circle Faucet",
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			// V2 hardened redeploy (jul-2026): recovery validada + cancel del
			// guardian, paymaster con maxSponsoredGasCost + stake lifecycle,
			// router con permit. Direcciones previas (cuentas existentes siguen
			// desplegadas y operativas): factory 0x75c7..., paymaster 0x31f3...,
			// verifier 0xb7fA..., paymentRouter 0x607f...
			factory: "0xb97E923E27CB258012081446e4b436afd3974108",
			paymaster: "0x913a1B51c4f5b1a458A56D0d700c956834cc1d15",
			verifier: "0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886",
			paymentRouter: "0xaF5a6856F65eab6bd8d0e403E4cFd49aD0c0c04f",
			crosschainRouter: "0x88Ae8A42d004934cD72b534bd362A49e7E4ad3a1",
			// Circle's official testnet USDC on Arbitrum Sepolia.
			usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
			usdcDecimals: 6,
		},
		// Router 0xaF5a... (jul-2026) incluye payInvoiceWithPermit.
		paymentRouterHasPermit: true,
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
		// Aave v3 testnet market. Its USDC reserve underlying IS Circle's testnet
		// USDC (0x75fa...AA4d) — the same token GatoPago users hold, so Earn is
		// fully testable here. Verified vs aave-address-book 2026-07-03.
		aave: {
			pool: "0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff",
			aUsdc: "0x460b97BD498E1157530AEb3086301d5225b91216",
		},
	},
	// Production target (mainnet).
	"arbitrum-one": {
		key: "arbitrum-one",
		chainId: 42161,
		name: "Arbitrum One",
		nativeTokenSymbol: "ETH",
		isTestnet: false,
		explorerBaseUrl: "https://arbiscan.io",
		faucetUrl: null,
		faucetLabel: null,
		contracts: {
			entryPoint: ENTRYPOINT_V09,
			factory: TODO_DEPLOY, // TODO: deploy V2 to Arbitrum One, then fill
			paymaster: TODO_DEPLOY, // TODO
			verifier: TODO_DEPLOY, // TODO
			paymentRouter: TODO_DEPLOY, // TODO
			crosschainRouter: TODO_DEPLOY, // TODO
			usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // native Circle USDC
			usdcDecimals: 6,
		},
		// Deploy the current (permit-enabled) router source here, then set true.
		paymentRouterHasPermit: false,
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
		// Aave v3 Arbitrum market (native USDC reserve "USDCn": underlying
		// 0xaf88...5831 = GatoPago's USDC). Verified vs aave-address-book 2026-07-03.
		aave: {
			pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
			aUsdc: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
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

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Thrown when a flow needs a contract that is still TODO_DEPLOY on this chain. */
export class ContractNotDeployedError extends Error {
	readonly contractName: string;
	readonly networkName: string;
	constructor(contractName: string, networkName: string) {
		super(`Contract '${contractName}' is not deployed on ${networkName} (TODO_DEPLOY placeholder).`);
		this.name = "ContractNotDeployedError";
		this.contractName = contractName;
		this.networkName = networkName;
	}
}

export function isContractDeployed(address: `0x${string}` | undefined | null): boolean {
	return !!address && address.toLowerCase() !== ZERO_ADDRESS;
}

/**
 * Fail-closed guard for TODO_DEPLOY placeholders: every server flow that is about
 * to USE a contract address must assert it first, so a half-configured network
 * (e.g. arbitrum-one before its deploy) errors out loudly instead of sending
 * transactions to the zero address.
 */
export function assertContractsDeployed(
	network: NetworkConfig,
	names: (keyof ContractAddresses)[],
): void {
	for (const name of names) {
		const value = network.contracts[name];
		if (typeof value === "string" && !isContractDeployed(value as `0x${string}`)) {
			throw new ContractNotDeployedError(name, network.name);
		}
	}
}

// CCTP v2 contracts are deterministic (identical address on every chain). Verified
// against developers.circle.com/cctp (testnet). TokenMessengerV2 / MessageTransmitterV2.
const CCTP_V2_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
const CCTP_V2_MESSAGE_TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;

/**
 * CCTP v2 registry keyed by EVM chainId. Used by the cross-chain relayer for both
 * source and destination chains. Adding an entry here enables the chain as an
 * INBOUND source immediately (cheap: the mint happens on the active chain, no
 * new relayer gas); as an OUTBOUND destination it stays hidden until the
 * relayer holds verified gas there (gas-gating, fail-closed) AND the chain is
 * mapped in server/src/chain.ts. Mainnet entries to be added with their (same)
 * deterministic messenger addresses + each chain's native USDC.
 *
 * Domains/USDC verified vs developers.circle.com (CCTP v2 testnet tutorial +
 * Circle USDC testnet addresses) on 2026-07-03.
 */
export const CCTP_CHAINS: Record<number, CctpChain> = {
	421614: {
		chainId: 421614,
		name: "Arbitrum Sepolia",
		domain: 3,
		tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
		messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
		usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
	},
	84532: {
		chainId: 84532,
		name: "Base Sepolia",
		domain: 6,
		tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
		messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
		usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	},
	// Inbound sources (cobros hacia Arbitrum). Ethereum Sepolia: instant Fast
	// (~20s, fee) or free Standard (~15-19 min).
	11155111: {
		chainId: 11155111,
		name: "Ethereum Sepolia",
		domain: 0,
		tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
		messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
		usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
	},
	// Avalanche Fuji: instant finality → Standard is already ~8s AND free
	// (Avalanche doesn't even need Fast as a source).
	43113: {
		chainId: 43113,
		name: "Avalanche Fuji",
		domain: 1,
		tokenMessenger: CCTP_V2_TOKEN_MESSENGER,
		messageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
		usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
	},
};

/** CCTP info for an EVM chainId, or null if the chain isn't CCTP-enabled here. */
export function getCctpChainByChainId(chainId: number): CctpChain | null {
	return CCTP_CHAINS[chainId] ?? null;
}
