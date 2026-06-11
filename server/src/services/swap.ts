// Swap quoting + fee policy. Quotes come from on-chain quoters (no API keys):
// we probe the standard v3 fee tiers and v4 hookless pool configs for the pair
// and pick the route with the best raw output (tie-break: v4 — native ETH is a
// first-class currency there, which avoids WRAP/UNWRAP gas on ETH pairs).

import { formatUnits } from "viem";
import type { NetworkConfig, TokenConfig } from "../../../shared/networks";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import {
	BPS_DENOMINATOR,
	NATIVE_CURRENCY,
	V3_FEE_TIERS,
	V4_POOL_CONFIGS,
	buildPoolKey,
	type SwapRoute,
	v3QuoterV2Abi,
	v4QuoterAbi,
} from "./uniswap";

/** Hard cap on Parmelia's service fee — env can never push it above 1%. */
export const MAX_FEE_BPS_HARD_CAP = 100n;
/** Default slippage when the client doesn't send one: 0.50%. */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Slippage bounds accepted from the client. */
export const MAX_SLIPPAGE_BPS = 500;
/** Quotes are only executable for this long. */
export const QUOTE_TTL_SECONDS = 60;

export type FeePolicy = {
	feeBps: bigint;
	treasury: `0x${string}` | null;
};

/**
 * Resolve the service-fee policy from env. Fees are OFF unless explicitly
 * enabled, capped by both PARMELIA_MAX_FEE_BPS and the hard cap, and require a
 * treasury address to be active.
 */
export function resolveFeePolicy(env: Bindings): FeePolicy {
	if (env.PARMELIA_FEES_ENABLED !== "true") return { feeBps: 0n, treasury: null };

	const configured = BigInt(env.PARMELIA_SWAP_FEE_BPS || "0");
	const envCap = BigInt(env.PARMELIA_MAX_FEE_BPS || String(MAX_FEE_BPS_HARD_CAP));
	const cap = envCap < MAX_FEE_BPS_HARD_CAP ? envCap : MAX_FEE_BPS_HARD_CAP;
	const feeBps = configured < cap ? configured : cap;

	const treasury = env.PARMELIA_TREASURY_ADDRESS;
	if (feeBps <= 0n || !treasury || !/^0x[a-fA-F0-9]{40}$/.test(treasury)) {
		return { feeBps: 0n, treasury: null };
	}
	return { feeBps, treasury: treasury as `0x${string}` };
}

export function applyFee(amountOut: bigint, feeBps: bigint) {
	const feeAmount = (amountOut * feeBps) / BPS_DENOMINATOR;
	return { feeAmount, netAmount: amountOut - feeAmount };
}

export function applySlippage(amount: bigint, slippageBps: number): bigint {
	return (amount * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

export type RouteQuote = {
	route: SwapRoute;
	amountOut: bigint;
	gasEstimate: bigint;
};

/**
 * Probe v3 fee tiers and v4 pool configs for the best single-hop quote.
 * Probes run in parallel; pools that don't exist simply fail their simulation
 * and are skipped. Returns null when no route exists.
 */
export async function quoteBestRoute(
	env: Bindings,
	network: NetworkConfig,
	tokenIn: TokenConfig,
	tokenOut: TokenConfig,
	amountIn: bigint,
): Promise<RouteQuote | null> {
	const uni = network.uniswap;
	if (!uni) return null;

	const publicClient = getPublicClient(env);
	const zero = "0x0000000000000000000000000000000000000000";

	// v3 quoting always runs through the wrapped representation of native ETH.
	const v3In = tokenIn.address ?? tokenIn.wrappedAddress!;
	const v3Out = tokenOut.address ?? tokenOut.wrappedAddress!;
	// v4 treats native ETH as currency address(0).
	const v4In = tokenIn.address ?? NATIVE_CURRENCY;
	const v4Out = tokenOut.address ?? NATIVE_CURRENCY;

	const probes: Promise<RouteQuote | null>[] = [];

	if (uni.v3QuoterV2 !== zero) {
		for (const fee of V3_FEE_TIERS) {
			probes.push(
				publicClient
					.simulateContract({
						address: uni.v3QuoterV2,
						abi: v3QuoterV2Abi,
						functionName: "quoteExactInputSingle",
						args: [
							{
								tokenIn: v3In,
								tokenOut: v3Out,
								amountIn,
								fee,
								sqrtPriceLimitX96: 0n,
							},
						],
					})
					.then(({ result }) => ({
						route: { protocol: "v3" as const, fee, tickSpacing: null },
						amountOut: result[0],
						gasEstimate: result[3],
					}))
					.catch(() => null),
			);
		}
	}

	if (uni.v4Quoter !== zero) {
		for (const { fee, tickSpacing } of V4_POOL_CONFIGS) {
			const poolKey = buildPoolKey(v4In, v4Out, fee, tickSpacing);
			probes.push(
				publicClient
					.simulateContract({
						address: uni.v4Quoter,
						abi: v4QuoterAbi,
						functionName: "quoteExactInputSingle",
						args: [
							{
								poolKey,
								zeroForOne: poolKey.currency0 === v4In,
								exactAmount: amountIn,
								hookData: "0x",
							},
						],
					})
					.then(({ result }) => ({
						route: { protocol: "v4" as const, fee, tickSpacing },
						amountOut: result[0],
						gasEstimate: result[1],
					}))
					.catch(() => null),
			);
		}
	}

	const results = (await Promise.all(probes)).filter(
		(q): q is RouteQuote => q !== null && q.amountOut > 0n,
	);
	if (results.length === 0) return null;

	// Best raw output wins; on (near) ties prefer v4 — cheaper execution for
	// native-ETH legs (no wrap) and singleton-manager gas savings.
	results.sort((a, b) => {
		if (a.amountOut === b.amountOut) {
			return a.route.protocol === "v4" ? -1 : 1;
		}
		return a.amountOut > b.amountOut ? -1 : 1;
	});
	return results[0];
}

export function describeRoute(route: SwapRoute): string {
	const feePct = (route.fee / 10_000).toFixed(route.fee % 100 === 0 ? 2 : 3);
	return `Uniswap ${route.protocol} · pool ${feePct}%`;
}

export function formatTokenAmount(amount: bigint, token: TokenConfig): string {
	return formatUnits(amount, token.decimals);
}
