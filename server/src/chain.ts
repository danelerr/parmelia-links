import { type Chain } from "viem";
import { arbitrum, arbitrumSepolia, avalancheFuji, baseSepolia } from "viem/chains";
import {
	DEFAULT_CHAIN_KEY,
	type SupportedChainKey,
	isSupportedChainKey,
} from "../../shared/networks";

/**
 * Map of supported chains indexed by their string key.
 * Add new chains here as they become supported.
 */
const CHAIN_MAP: Record<SupportedChainKey, Chain> = {
	"base-sepolia": baseSepolia,
	"arbitrum-sepolia": arbitrumSepolia,
	"avalanche-fuji": avalancheFuji,
	"arbitrum-one": arbitrum,
};

/**
 * Get the active chain configuration.
 *
 * Reads from CHAIN_KEY env var; unset/unknown falls back to DEFAULT_CHAIN_KEY
 * (arbitrum-sepolia). The RPC URL is always overridden by the RPC_URL env var.
 */
export function getActiveChain(chainKey?: string): Chain {
	const key =
		chainKey && isSupportedChainKey(chainKey) ? chainKey : DEFAULT_CHAIN_KEY;
	return CHAIN_MAP[key];
}

/** viem Chain by EVM chainId (used by the cross-chain relayer for destinations). */
const CHAIN_BY_ID: Record<number, Chain> = {
	84532: baseSepolia,
	421614: arbitrumSepolia,
	43113: avalancheFuji,
	42161: arbitrum,
};

export function getChainById(chainId: number): Chain | null {
	return CHAIN_BY_ID[chainId] ?? null;
}
