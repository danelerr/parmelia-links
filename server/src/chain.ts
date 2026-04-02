import { type Chain } from "viem";
import { baseSepolia, monadTestnet } from "viem/chains";
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
	"monad-testnet": monadTestnet,
};

/**
 * Get the active chain configuration.
 *
 * Reads from CHAIN_KEY env var. Defaults to "monad-testnet".
 * The RPC URL is always overridden by the RPC_URL env var.
 */
export function getActiveChain(chainKey?: string): Chain {
	const key =
		chainKey && isSupportedChainKey(chainKey) ? chainKey : DEFAULT_CHAIN_KEY;
	return CHAIN_MAP[key];
}
