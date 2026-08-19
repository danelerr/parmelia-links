// Pure Uniswap encoding layer: Universal Router commands, v4 actions and the
// minimal ABIs we need for on-chain quoting. No I/O here - everything is a pure
// function so it can be unit-tested without a chain.
//
// All constants verified against source:
//   - universal-router/contracts/libraries/Commands.sol
//   - v4-periphery/src/libraries/Actions.sol
// and the official deployment docs (developers.uniswap.org).

import {
	type Hex,
	concat,
	encodeAbiParameters,
	encodeFunctionData,
	encodePacked,
	parseAbiParameters,
	toHex,
} from "viem";

// ===== Universal Router command bytes (Commands.sol) =====
export const UR_COMMANDS = {
	V3_SWAP_EXACT_IN: 0x00,
	SWEEP: 0x04,
	PAY_PORTION: 0x06,
	WRAP_ETH: 0x0b,
	UNWRAP_WETH: 0x0c,
	V4_SWAP: 0x10,
} as const;

// ===== Uniswap v4 router actions (Actions.sol) =====
export const V4_ACTIONS = {
	SWAP_EXACT_IN_SINGLE: 0x06,
	SETTLE_ALL: 0x0c,
	TAKE_ALL: 0x0f,
	TAKE_PORTION: 0x10,
} as const;

/** universal-router Constants.ADDRESS_THIS - "the router itself" recipient. */
export const UR_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const;
/** v4 native currency (ETH) = address(0). */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

export const BPS_DENOMINATOR = 10_000n;

// ===== Minimal ABIs =====

export const universalRouterAbi = [
	{
		name: "execute",
		type: "function",
		stateMutability: "payable",
		inputs: [
			{ name: "commands", type: "bytes" },
			{ name: "inputs", type: "bytes[]" },
			{ name: "deadline", type: "uint256" },
		],
		outputs: [],
	},
] as const;

export const permit2Abi = [
	{
		name: "approve",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "token", type: "address" },
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint160" },
			{ name: "expiration", type: "uint48" },
		],
		outputs: [],
	},
] as const;

/** Uniswap v3 QuoterV2.quoteExactInputSingle (simulated via eth_call). */
export const v3QuoterV2Abi = [
	{
		name: "quoteExactInputSingle",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "params",
				type: "tuple",
				components: [
					{ name: "tokenIn", type: "address" },
					{ name: "tokenOut", type: "address" },
					{ name: "amountIn", type: "uint256" },
					{ name: "fee", type: "uint24" },
					{ name: "sqrtPriceLimitX96", type: "uint160" },
				],
			},
		],
		outputs: [
			{ name: "amountOut", type: "uint256" },
			{ name: "sqrtPriceX96After", type: "uint160" },
			{ name: "initializedTicksCrossed", type: "uint32" },
			{ name: "gasEstimate", type: "uint256" },
		],
	},
] as const;

/** Uniswap v4 Quoter.quoteExactInputSingle (simulated via eth_call). */
export const v4QuoterAbi = [
	{
		name: "quoteExactInputSingle",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "params",
				type: "tuple",
				components: [
					{
						name: "poolKey",
						type: "tuple",
						components: [
							{ name: "currency0", type: "address" },
							{ name: "currency1", type: "address" },
							{ name: "fee", type: "uint24" },
							{ name: "tickSpacing", type: "int24" },
							{ name: "hooks", type: "address" },
						],
					},
					{ name: "zeroForOne", type: "bool" },
					{ name: "exactAmount", type: "uint128" },
					{ name: "hookData", type: "bytes" },
				],
			},
		],
		outputs: [
			{ name: "amountOut", type: "uint256" },
			{ name: "gasEstimate", type: "uint256" },
		],
	},
] as const;

// ===== Route model =====

type SwapProtocol = "v3" | "v4";

export type SwapRoute = {
	protocol: SwapProtocol;
	/** Pool fee in hundredths of a bip (e.g. 500 = 0.05%). */
	fee: number;
	/** v4 only; null for v3. */
	tickSpacing: number | null;
};

/** Standard fee tiers probed on v3 single-hop pools. */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
/** Standard (fee, tickSpacing) configs probed on v4 hookless pools. */
export const V4_POOL_CONFIGS = [
	{ fee: 100, tickSpacing: 1 },
	{ fee: 500, tickSpacing: 10 },
	{ fee: 3000, tickSpacing: 60 },
	{ fee: 10000, tickSpacing: 200 },
] as const;

/** Sort two v4 currencies (native 0x0 always sorts first). */
export function sortCurrencies(
	a: `0x${string}`,
	b: `0x${string}`,
): [`0x${string}`, `0x${string}`] {
	return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/** v4 PoolKey for a hookless pool between two currencies. */
export function buildPoolKey(
	currencyA: `0x${string}`,
	currencyB: `0x${string}`,
	fee: number,
	tickSpacing: number,
) {
	const [currency0, currency1] = sortCurrencies(currencyA, currencyB);
	return {
		currency0,
		currency1,
		fee,
		tickSpacing,
		hooks: NATIVE_CURRENCY,
	} as const;
}

/** Packed v3 single-hop path: tokenIn | fee | tokenOut. */
export function encodeV3Path(
	tokenIn: `0x${string}`,
	fee: number,
	tokenOut: `0x${string}`,
): Hex {
	return encodePacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

/** Gross minimum required at the pool so that net-of-fee output still meets `netMin`. */
export function grossMinForNet(netMin: bigint, feeBps: bigint): bigint {
	if (feeBps <= 0n) return netMin;
	return (netMin * BPS_DENOMINATOR) / (BPS_DENOMINATOR - feeBps);
}

export type BuildSwapParams = {
	route: SwapRoute;
	/** Whitelisted addresses; null = native ETH. */
	tokenIn: `0x${string}` | null;
	tokenOut: `0x${string}` | null;
	/** WETH for the active chain (needed by v3 when a side is native). */
	weth: `0x${string}`;
	amountIn: bigint;
	/** Net minimum the user must receive (post GatoPago fee). */
	minAmountOutNet: bigint;
	/** Final recipient - MUST be the user's smart account. */
	account: `0x${string}`;
	/** GatoPago service fee (0 = disabled). */
	feeBps: bigint;
	treasury: `0x${string}` | null;
	deadline: bigint;
};

export type BuiltSwap = {
	/** Calldata for UniversalRouter.execute(commands, inputs, deadline). */
	calldata: Hex;
	/** Native value the account must attach to the router call. */
	value: bigint;
};

/**
 * Build the Universal Router execution for a single-hop exact-in swap.
 *
 * v4: native ETH is a first-class currency (no wrap), input settled via
 *     Permit2 from the account (SETTLE_ALL), output to the account (TAKE_ALL),
 *     optional fee via TAKE_PORTION to the treasury.
 * v3: native sides go through WETH (WRAP_ETH / UNWRAP_WETH); when a fee or an
 *     unwrap is needed the swap output stops at the router and is distributed
 *     with PAY_PORTION + SWEEP/UNWRAP, each enforcing the net minimum.
 */
export function buildUniversalRouterSwap(p: BuildSwapParams): BuiltSwap {
	if (p.feeBps > 0n && !p.treasury) {
		throw new Error("treasury required when feeBps > 0");
	}
	const grossMin = grossMinForNet(p.minAmountOutNet, p.feeBps);

	if (p.route.protocol === "v4") {
		return buildV4Swap(p, grossMin);
	}
	return buildV3Swap(p, grossMin);
}

function buildV4Swap(p: BuildSwapParams, grossMin: bigint): BuiltSwap {
	if (p.route.tickSpacing === null) throw new Error("v4 route requires tickSpacing");

	const currencyIn = p.tokenIn ?? NATIVE_CURRENCY;
	const currencyOut = p.tokenOut ?? NATIVE_CURRENCY;
	const poolKey = buildPoolKey(currencyIn, currencyOut, p.route.fee, p.route.tickSpacing);
	const zeroForOne = poolKey.currency0 === currencyIn;

	const actionBytes: number[] = [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL];
	const params: Hex[] = [
		encodeAbiParameters(
			[
				{
					name: "params",
					type: "tuple",
					components: [
						{
							name: "poolKey",
							type: "tuple",
							components: [
								{ name: "currency0", type: "address" },
								{ name: "currency1", type: "address" },
								{ name: "fee", type: "uint24" },
								{ name: "tickSpacing", type: "int24" },
								{ name: "hooks", type: "address" },
							],
						},
						{ name: "zeroForOne", type: "bool" },
						{ name: "amountIn", type: "uint128" },
						{ name: "amountOutMinimum", type: "uint128" },
						{ name: "hookData", type: "bytes" },
					],
				},
			],
			[
				{
					poolKey,
					zeroForOne,
					amountIn: p.amountIn,
					amountOutMinimum: grossMin,
					hookData: "0x",
				},
			],
		),
		// SETTLE_ALL(currencyIn, maxAmount)
		encodeAbiParameters(parseAbiParameters("address, uint256"), [currencyIn, p.amountIn]),
	];

	if (p.feeBps > 0n) {
		actionBytes.push(V4_ACTIONS.TAKE_PORTION);
		params.push(
			encodeAbiParameters(parseAbiParameters("address, address, uint256"), [
				currencyOut,
				p.treasury!,
				p.feeBps,
			]),
		);
	}

	actionBytes.push(V4_ACTIONS.TAKE_ALL);
	params.push(
		encodeAbiParameters(parseAbiParameters("address, uint256"), [
			currencyOut,
			p.minAmountOutNet,
		]),
	);

	const actions = concat(actionBytes.map((b) => toHex(b, { size: 1 }))) as Hex;
	const v4Input = encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, params]);

	const calldata = encodeFunctionData({
		abi: universalRouterAbi,
		functionName: "execute",
		args: [toHex(UR_COMMANDS.V4_SWAP, { size: 1 }), [v4Input], p.deadline],
	});

	return { calldata, value: p.tokenIn === null ? p.amountIn : 0n };
}

function buildV3Swap(p: BuildSwapParams, grossMin: bigint): BuiltSwap {
	const nativeIn = p.tokenIn === null;
	const nativeOut = p.tokenOut === null;
	const pathIn = nativeIn ? p.weth : p.tokenIn!;
	const pathOut = nativeOut ? p.weth : p.tokenOut!;
	const path = encodeV3Path(pathIn, p.route.fee, pathOut);

	// Output must stop at the router whenever we still owe a fee split or an unwrap.
	const routerHoldsOutput = p.feeBps > 0n || nativeOut;

	const commands: number[] = [];
	const inputs: Hex[] = [];

	if (nativeIn) {
		commands.push(UR_COMMANDS.WRAP_ETH);
		inputs.push(
			encodeAbiParameters(parseAbiParameters("address, uint256"), [
				UR_ADDRESS_THIS,
				p.amountIn,
			]),
		);
	}

	commands.push(UR_COMMANDS.V3_SWAP_EXACT_IN);
	inputs.push(
		encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [
			routerHoldsOutput ? UR_ADDRESS_THIS : p.account,
			p.amountIn,
			routerHoldsOutput ? grossMin : p.minAmountOutNet,
			path,
			// Native input was wrapped into the router; ERC-20 input is pulled
			// from the account through Permit2 (payerIsUser = true).
			!nativeIn,
		]),
	);

	if (p.feeBps > 0n) {
		commands.push(UR_COMMANDS.PAY_PORTION);
		inputs.push(
			encodeAbiParameters(parseAbiParameters("address, address, uint256"), [
				pathOut,
				p.treasury!,
				p.feeBps,
			]),
		);
	}

	if (nativeOut) {
		commands.push(UR_COMMANDS.UNWRAP_WETH);
		inputs.push(
			encodeAbiParameters(parseAbiParameters("address, uint256"), [
				p.account,
				p.minAmountOutNet,
			]),
		);
	} else if (routerHoldsOutput) {
		commands.push(UR_COMMANDS.SWEEP);
		inputs.push(
			encodeAbiParameters(parseAbiParameters("address, address, uint256"), [
				pathOut,
				p.account,
				p.minAmountOutNet,
			]),
		);
	}

	const calldata = encodeFunctionData({
		abi: universalRouterAbi,
		functionName: "execute",
		args: [concat(commands.map((b) => toHex(b, { size: 1 }))) as Hex, inputs, p.deadline],
	});

	return { calldata, value: nativeIn ? p.amountIn : 0n };
}
