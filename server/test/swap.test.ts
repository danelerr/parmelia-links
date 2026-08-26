import { describe, expect, it } from "vitest";
import {
	decodeAbiParameters,
	decodeFunctionData,
	encodePacked,
	parseAbiParameters,
} from "viem";
import {
	NATIVE_CURRENCY,
	UR_ADDRESS_THIS,
	UR_COMMANDS,
	V4_ACTIONS,
	buildPoolKey,
	buildUniversalRouterSwap,
	encodeV3Path,
	grossMinForNet,
	sortCurrencies,
	universalRouterAbi,
} from "../src/services/uniswap";
import {
	applyFee,
	applySlippage,
	resolveSwapAmountInput,
	resolveFeePolicy,
} from "../src/services/swap";
import type { Bindings } from "../src/middlewares/auth";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as const;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const TREASURY = "0x2222222222222222222222222222222222222222" as const;
const DEADLINE = 1_900_000_000n;

function env(overrides: Partial<Bindings> = {}): Bindings {
	return {
		RPC_URL: "",
		PRIVATE_KEY: "",
		FIREBASE_PROJECT_ID: "",
		ALLOWED_ORIGINS: "",
		CHAIN_KEY: "arbitrum-sepolia",
		GATOPAGO_DB: null as unknown as D1Database,
		...overrides,
	};
}

function decodeExecute(calldata: `0x${string}`) {
	const { functionName, args } = decodeFunctionData({ abi: universalRouterAbi, data: calldata });
	expect(functionName).toBe("execute");
	const [commands, inputs, deadline] = args as [`0x${string}`, `0x${string}`[], bigint];
	return { commands, inputs, deadline };
}

describe("fee & slippage math", () => {
	it("resolves max to the complete live balance without a gas reserve", () => {
		const liveBalance = 96_999_054n;
		expect(resolveSwapAmountInput("max", 6, liveBalance)).toEqual({
			amountIn: liveBalance,
			isMax: true,
		});
	});

	it("accepts a decimal compatibility amount plus an explicit max flag", () => {
		const liveBalance = 96_999_054n;
		expect(resolveSwapAmountInput("96.999054", 6, liveBalance, true)).toEqual({
			amountIn: liveBalance,
			isMax: true,
		});
	});

	it("keeps manually entered amounts exact", () => {
		expect(resolveSwapAmountInput("12.34", 6, 99_000_000n)).toEqual({
			amountIn: 12_340_000n,
			isMax: false,
		});
	});

	it("applyFee splits output", () => {
		const { feeAmount, netAmount } = applyFee(1_000_000n, 30n); // 0.30%
		expect(feeAmount).toBe(3000n);
		expect(netAmount).toBe(997_000n);
	});

	it("applySlippage lowers the floor", () => {
		expect(applySlippage(1_000_000n, 50)).toBe(995_000n); // 0.50%
	});

	it("grossMinForNet inverts the fee", () => {
		const net = 997_000n;
		const gross = grossMinForNet(net, 30n);
		// net-of-fee of gross must be >= net
		expect(gross - (gross * 30n) / 10_000n).toBeGreaterThanOrEqual(net);
		expect(grossMinForNet(net, 0n)).toBe(net);
	});
});

describe("resolveFeePolicy", () => {
	it("fees are OFF by default", () => {
		expect(resolveFeePolicy(env()).feeBps).toBe(0n);
	});

	it("requires explicit enable + treasury", () => {
		expect(() =>
			resolveFeePolicy(env({ GATOPAGO_FEES_ENABLED: "true", GATOPAGO_SWAP_FEE_BPS: "30" })),
		).toThrow("treasury");
		const on = resolveFeePolicy(
			env({
				GATOPAGO_FEES_ENABLED: "true",
				GATOPAGO_SWAP_FEE_BPS: "30",
				GATOPAGO_TREASURY_ADDRESS: TREASURY,
			}),
		);
		expect(on.feeBps).toBe(30n);
		expect(on.treasury).toBe(TREASURY);
	});

	it("fails closed instead of silently clamping an invalid fee", () => {
		expect(() => resolveFeePolicy(
			env({
				GATOPAGO_FEES_ENABLED: "true",
				GATOPAGO_SWAP_FEE_BPS: "5000",
				GATOPAGO_MAX_FEE_BPS: "9999",
				GATOPAGO_TREASURY_ADDRESS: TREASURY,
			}),
		)).toThrow("configuration");
	});
});

describe("v4 pool key helpers", () => {
	it("sorts currencies with native (0x0) first", () => {
		const [c0, c1] = sortCurrencies(USDC, NATIVE_CURRENCY);
		expect(c0).toBe(NATIVE_CURRENCY);
		expect(c1).toBe(USDC);
	});

	it("builds a hookless pool key", () => {
		const key = buildPoolKey(USDC, NATIVE_CURRENCY, 500, 10);
		expect(key.currency0).toBe(NATIVE_CURRENCY);
		expect(key.currency1).toBe(USDC);
		expect(key.hooks).toBe(NATIVE_CURRENCY);
	});
});

describe("encodeV3Path", () => {
	it("matches packed token|fee|token", () => {
		expect(encodeV3Path(USDC, 500, WETH)).toBe(
			encodePacked(["address", "uint24", "address"], [USDC, 500, WETH]),
		);
	});
});

describe("buildUniversalRouterSwap - v4", () => {
	it("ETH→USDC without fee: V4_SWAP, native value, SWAP+SETTLE_ALL+TAKE_ALL", () => {
		const { calldata, value } = buildUniversalRouterSwap({
			route: { protocol: "v4", fee: 500, tickSpacing: 10 },
			tokenIn: null,
			tokenOut: USDC,
			weth: WETH,
			amountIn: 10n ** 18n,
			minAmountOutNet: 3_000_000_000n,
			account: ACCOUNT,
			feeBps: 0n,
			treasury: null,
			deadline: DEADLINE,
		});
		expect(value).toBe(10n ** 18n);

		const { commands, inputs, deadline } = decodeExecute(calldata);
		expect(commands).toBe("0x10");
		expect(deadline).toBe(DEADLINE);
		expect(inputs).toHaveLength(1);

		const [actions, params] = decodeAbiParameters(
			parseAbiParameters("bytes, bytes[]"),
			inputs[0],
		);
		expect(actions).toBe("0x060c0f"); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
		expect(params).toHaveLength(3);

		// SETTLE_ALL pays the native input
		const [settleCurrency, settleMax] = decodeAbiParameters(
			parseAbiParameters("address, uint256"),
			params[1],
		);
		expect(settleCurrency.toLowerCase()).toBe(NATIVE_CURRENCY);
		expect(settleMax).toBe(10n ** 18n);

		// TAKE_ALL enforces the user's net minimum
		const [takeCurrency, takeMin] = decodeAbiParameters(
			parseAbiParameters("address, uint256"),
			params[2],
		);
		expect(takeCurrency.toLowerCase()).toBe(USDC.toLowerCase());
		expect(takeMin).toBe(3_000_000_000n);
	});

	it("USDC→ETH with fee: TAKE_PORTION to treasury before TAKE_ALL", () => {
		const { calldata, value } = buildUniversalRouterSwap({
			route: { protocol: "v4", fee: 500, tickSpacing: 10 },
			tokenIn: USDC,
			tokenOut: null,
			weth: WETH,
			amountIn: 3_000_000_000n,
			minAmountOutNet: 9n * 10n ** 17n,
			account: ACCOUNT,
			feeBps: 30n,
			treasury: TREASURY,
			deadline: DEADLINE,
		});
		expect(value).toBe(0n); // ERC-20 input attaches no native value

		const { inputs } = decodeExecute(calldata);
		const [actions, params] = decodeAbiParameters(
			parseAbiParameters("bytes, bytes[]"),
			inputs[0],
		);
		expect(actions).toBe("0x060c100f"); // + TAKE_PORTION before TAKE_ALL
		expect(params).toHaveLength(4);

		const [feeCurrency, feeRecipient, feeBips] = decodeAbiParameters(
			parseAbiParameters("address, address, uint256"),
			params[2],
		);
		expect(feeCurrency.toLowerCase()).toBe(NATIVE_CURRENCY);
		expect(feeRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
		expect(feeBips).toBe(30n);
	});

	it("requires treasury when fee is on", () => {
		expect(() =>
			buildUniversalRouterSwap({
				route: { protocol: "v4", fee: 500, tickSpacing: 10 },
				tokenIn: USDC,
				tokenOut: null,
				weth: WETH,
				amountIn: 1n,
				minAmountOutNet: 1n,
				account: ACCOUNT,
				feeBps: 30n,
				treasury: null,
				deadline: DEADLINE,
			}),
		).toThrow();
	});
});

describe("buildUniversalRouterSwap - v3", () => {
	it("USDC→WBTC without fee goes straight to the account via Permit2", () => {
		const { calldata, value } = buildUniversalRouterSwap({
			route: { protocol: "v3", fee: 3000, tickSpacing: null },
			tokenIn: USDC,
			tokenOut: WBTC,
			weth: WETH,
			amountIn: 100_000_000n,
			minAmountOutNet: 90_000n,
			account: ACCOUNT,
			feeBps: 0n,
			treasury: null,
			deadline: DEADLINE,
		});
		expect(value).toBe(0n);

		const { commands, inputs } = decodeExecute(calldata);
		expect(commands).toBe("0x00"); // single V3_SWAP_EXACT_IN
		const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(
			parseAbiParameters("address, uint256, uint256, bytes, bool"),
			inputs[0],
		);
		expect(recipient.toLowerCase()).toBe(ACCOUNT.toLowerCase());
		expect(amountIn).toBe(100_000_000n);
		expect(minOut).toBe(90_000n);
		expect(path).toBe(encodeV3Path(USDC, 3000, WBTC));
		expect(payerIsUser).toBe(true); // pulled from the account through Permit2
	});

	it("ETH→USDC wraps first and pays from router balance", () => {
		const { calldata, value } = buildUniversalRouterSwap({
			route: { protocol: "v3", fee: 500, tickSpacing: null },
			tokenIn: null,
			tokenOut: USDC,
			weth: WETH,
			amountIn: 10n ** 18n,
			minAmountOutNet: 3_000_000_000n,
			account: ACCOUNT,
			feeBps: 0n,
			treasury: null,
			deadline: DEADLINE,
		});
		expect(value).toBe(10n ** 18n);

		const { commands, inputs } = decodeExecute(calldata);
		expect(commands).toBe("0x0b00"); // WRAP_ETH then V3_SWAP_EXACT_IN

		const [wrapRecipient, wrapAmount] = decodeAbiParameters(
			parseAbiParameters("address, uint256"),
			inputs[0],
		);
		expect(wrapRecipient.toLowerCase()).toBe(UR_ADDRESS_THIS);
		expect(wrapAmount).toBe(10n ** 18n);

		const [, , , path, payerIsUser] = decodeAbiParameters(
			parseAbiParameters("address, uint256, uint256, bytes, bool"),
			inputs[1],
		);
		expect(path).toBe(encodeV3Path(WETH, 500, USDC));
		expect(payerIsUser).toBe(false); // funds already wrapped into the router
	});

	it("USDC→ETH with fee: swap→router, PAY_PORTION, then UNWRAP to the user with net min", () => {
		const net = 9n * 10n ** 17n;
		const { calldata } = buildUniversalRouterSwap({
			route: { protocol: "v3", fee: 500, tickSpacing: null },
			tokenIn: USDC,
			tokenOut: null,
			weth: WETH,
			amountIn: 3_000_000_000n,
			minAmountOutNet: net,
			account: ACCOUNT,
			feeBps: 30n,
			treasury: TREASURY,
			deadline: DEADLINE,
		});

		const { commands, inputs } = decodeExecute(calldata);
		expect(commands).toBe("0x00060c"); // V3_SWAP, PAY_PORTION, UNWRAP_WETH

		const [swapRecipient, , swapMin] = decodeAbiParameters(
			parseAbiParameters("address, uint256, uint256, bytes, bool"),
			inputs[0],
		);
		expect(swapRecipient.toLowerCase()).toBe(UR_ADDRESS_THIS);
		expect(swapMin).toBe(grossMinForNet(net, 30n));

		const [payToken, payRecipient, payBips] = decodeAbiParameters(
			parseAbiParameters("address, address, uint256"),
			inputs[1],
		);
		expect(payToken.toLowerCase()).toBe(WETH.toLowerCase());
		expect(payRecipient.toLowerCase()).toBe(TREASURY.toLowerCase());
		expect(payBips).toBe(30n);

		const [unwrapRecipient, unwrapMin] = decodeAbiParameters(
			parseAbiParameters("address, uint256"),
			inputs[2],
		);
		expect(unwrapRecipient.toLowerCase()).toBe(ACCOUNT.toLowerCase());
		expect(unwrapMin).toBe(net);
	});

	it("never builds unknown commands", () => {
		// Sanity pin on the verified byte values.
		expect(UR_COMMANDS.V3_SWAP_EXACT_IN).toBe(0x00);
		expect(UR_COMMANDS.V4_SWAP).toBe(0x10);
		expect(V4_ACTIONS.SWAP_EXACT_IN_SINGLE).toBe(0x06);
		expect(V4_ACTIONS.SETTLE_ALL).toBe(0x0c);
		expect(V4_ACTIONS.TAKE_ALL).toBe(0x0f);
		expect(V4_ACTIONS.TAKE_PORTION).toBe(0x10);
	});
});
