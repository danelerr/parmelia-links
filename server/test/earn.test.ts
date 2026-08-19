import { describe, expect, it } from "vitest";
import { decodeFunctionData, maxUint256, parseUnits } from "viem";
import { getNetworkConfig, erc20Abi } from "../../shared";
import {
	AAVE_POOL_ABI,
	buildDepositCalls,
	buildWithdrawCalls,
	decodeReserveFlags,
	isWithdrawAllRequest,
	rayRateToApyPercent,
} from "../src/services/earn";

const RAY = 10n ** 27n;
const network = getNetworkConfig("arbitrum-sepolia");
const ACCOUNT = "0x000000000000000000000000000000000000bEEF" as const;

describe("rayRateToApyPercent", () => {
	it("zero rate is zero APY", () => {
		expect(rayRateToApyPercent(0n)).toBe(0);
	});

	it("5% APR compounds to ~5.127% APY", () => {
		const apy = rayRateToApyPercent(RAY / 20n); // 0.05 in ray
		expect(apy).toBeGreaterThan(5.12);
		expect(apy).toBeLessThan(5.14);
	});

	it("2.5% APR compounds to ~2.531% APY", () => {
		const apy = rayRateToApyPercent(RAY / 40n);
		expect(apy).toBeGreaterThan(2.52);
		expect(apy).toBeLessThan(2.54);
	});
});

describe("decodeReserveFlags", () => {
	it("decodes active / frozen / paused bits (56, 57, 60)", () => {
		expect(decodeReserveFlags(0n)).toEqual({ active: false, frozen: false, paused: false });
		expect(decodeReserveFlags(1n << 56n)).toEqual({ active: true, frozen: false, paused: false });
		expect(decodeReserveFlags((1n << 56n) | (1n << 57n))).toEqual({ active: true, frozen: true, paused: false });
		expect(decodeReserveFlags((1n << 56n) | (1n << 60n))).toEqual({ active: true, frozen: false, paused: true });
	});

	it("ignores unrelated bits (LTV, decimals, caps)", () => {
		// Realistic mask: LTV/liq bits low, decimals=6 at bits 48-55, active bit set.
		const mask = 8000n | (6n << 48n) | (1n << 56n) | (12345n << 116n);
		expect(decodeReserveFlags(mask)).toEqual({ active: true, frozen: false, paused: false });
	});
});

describe("earn call encoding (pins the Aave ABI)", () => {
	const amount = parseUnits("25", 6);

	it("deposit = exact approve to the Pool + supply onBehalfOf the account", () => {
		const calls = buildDepositCalls(network, ACCOUNT, amount);
		expect(calls).toHaveLength(2);

		expect(calls[0].target).toBe(network.contracts.usdc);
		const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
		expect(approve.functionName).toBe("approve");
		expect(approve.args).toEqual([network.aave!.pool, amount]);

		expect(calls[1].target).toBe(network.aave!.pool);
		const supply = decodeFunctionData({ abi: AAVE_POOL_ABI, data: calls[1].data });
		expect(supply.functionName).toBe("supply");
		expect(supply.args).toEqual([network.contracts.usdc, amount, ACCOUNT, 0]);
	});

	it("withdraw of an exact amount goes back to the account", () => {
		const calls = buildWithdrawCalls(network, ACCOUNT, amount);
		expect(calls).toHaveLength(1);
		const withdraw = decodeFunctionData({ abi: AAVE_POOL_ABI, data: calls[0].data });
		expect(withdraw.functionName).toBe("withdraw");
		expect(withdraw.args).toEqual([network.contracts.usdc, amount, ACCOUNT]);
	});

	it("withdraw-all uses uint256.max (Aave's full-balance sentinel, no accrual dust)", () => {
		const calls = buildWithdrawCalls(network, ACCOUNT, null);
		const withdraw = decodeFunctionData({ abi: AAVE_POOL_ABI, data: calls[0].data });
		expect(withdraw.args).toEqual([network.contracts.usdc, maxUint256, ACCOUNT]);
	});
});

describe("withdraw-all request compatibility", () => {
	it("accepts the current explicit flag with a decimal compatibility amount", () => {
		expect(isWithdrawAllRequest("withdraw", "10.016407", true)).toBe(true);
	});

	it("keeps accepting the legacy max sentinel", () => {
		expect(isWithdrawAllRequest("withdraw", "max", false)).toBe(true);
	});

	it("does not turn deposits into max withdrawals", () => {
		expect(isWithdrawAllRequest("deposit", "10", true)).toBe(false);
	});
});
