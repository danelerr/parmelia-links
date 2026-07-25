// Earn (Modo Ahorro): Aave v3 USDC supply, direct from the user's smart account.
//
// Design: DEFI_DESIGN.md v2.0. No Parmelia contracts, no custody — the batch is
// [approve(Pool, exact), Pool.supply(USDC, amount, account, 0)] (deposit) or
// [Pool.withdraw(USDC, amount | max, account)] (withdraw), signed with the
// passkey and relayed through the standard /pay/submit lifecycle. The aToken
// (rebasing, 1:1) held BY THE ACCOUNT is the saved balance and the only source
// of truth — nothing about the position is replicated in D1.
//
// Addresses come from shared/networks.ts (verified vs the BGD aave-address-book,
// 2026-07-03). The APY shown is the live on-chain rate; it is VARIABLE and the
// UI copy must never promise it.

import { encodeFunctionData, formatUnits, maxUint256, type Hex } from "viem";
import { getNetworkConfig, erc20Abi, type NetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import { type AccountCall } from "./userOp";

/** Minimal Aave v3 Pool ABI (supply / withdraw / getReserveData). */
export const AAVE_POOL_ABI = [
	{
		type: "function",
		name: "supply",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "asset", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "onBehalfOf", type: "address" },
			{ name: "referralCode", type: "uint16" },
		],
		outputs: [],
	},
	{
		type: "function",
		name: "withdraw",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "asset", type: "address" },
			{ name: "amount", type: "uint256" },
			{ name: "to", type: "address" },
		],
		outputs: [{ name: "", type: "uint256" }],
	},
	{
		type: "function",
		name: "getReserveData",
		stateMutability: "view",
		inputs: [{ name: "asset", type: "address" }],
		outputs: [
			{
				name: "",
				type: "tuple",
				components: [
					{ name: "configuration", type: "uint256" },
					{ name: "liquidityIndex", type: "uint128" },
					{ name: "currentLiquidityRate", type: "uint128" },
					{ name: "variableBorrowIndex", type: "uint128" },
					{ name: "currentVariableBorrowRate", type: "uint128" },
					{ name: "currentStableBorrowRate", type: "uint128" },
					{ name: "lastUpdateTimestamp", type: "uint40" },
					{ name: "id", type: "uint16" },
					{ name: "aTokenAddress", type: "address" },
					{ name: "stableDebtTokenAddress", type: "address" },
					{ name: "variableDebtTokenAddress", type: "address" },
					{ name: "interestRateStrategyAddress", type: "address" },
					{ name: "accruedToTreasury", type: "uint128" },
					{ name: "unbacked", type: "uint128" },
					{ name: "isolationModeTotalDebt", type: "uint128" },
				],
			},
		],
	},
] as const;

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

/**
 * Aave's currentLiquidityRate is an annualized APR in RAY (1e27). Convert to
 * the effective APY (per-second compounding, which is how aTokens accrue).
 * Display-precision math (Number) is fine here — this is UI, not accounting.
 */
export function rayRateToApyPercent(rateRay: bigint): number {
	if (rateRay <= 0n) return 0;
	const apr = Number(rateRay) / Number(RAY);
	const apy = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
	return apy * 100;
}

/**
 * Reserve state bits of the configuration bitmask (Aave v3
 * ReserveConfiguration): bit 56 = active, 57 = frozen, 60 = paused.
 * frozen forbids NEW supplies but still allows withdrawals; paused blocks both.
 */
export function decodeReserveFlags(configuration: bigint): {
	active: boolean;
	frozen: boolean;
	paused: boolean;
} {
	return {
		active: (configuration >> 56n) & 1n ? true : false,
		frozen: (configuration >> 57n) & 1n ? true : false,
		paused: (configuration >> 60n) & 1n ? true : false,
	};
}

export function isEarnConfigured(env: Bindings): boolean {
	return getNetworkConfig(env.CHAIN_KEY).aave !== null && env.EARN_PAUSED !== "true";
}

export type EarnStatus = {
	enabled: boolean;
	canDeposit: boolean;
	canWithdraw: boolean;
	/** Effective APY in percent (e.g. 2.53). Variable; display-only. */
	apyPercent: number;
};

// The reserve rate/flags move slowly; cache per isolate to keep /earn/config at
// ~zero marginal RPC cost.
let statusCache: { at: number; value: EarnStatus } | null = null;
const STATUS_TTL_MS = 60_000;

/** Live Earn status: config + on-chain reserve state (cached ~60s). */
export async function getEarnStatus(env: Bindings): Promise<EarnStatus> {
	const disabled: EarnStatus = { enabled: false, canDeposit: false, canWithdraw: false, apyPercent: 0 };
	if (!isEarnConfigured(env)) return disabled;
	if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;

	const network = getNetworkConfig(env.CHAIN_KEY);
	const publicClient = getPublicClient(env);
	const reserve = await publicClient.readContract({
		address: network.aave!.pool,
		abi: AAVE_POOL_ABI,
		functionName: "getReserveData",
		args: [network.contracts.usdc],
	});
	const flags = decodeReserveFlags(reserve.configuration);
	const value: EarnStatus = {
		enabled: flags.active && !flags.paused,
		canDeposit: flags.active && !flags.frozen && !flags.paused,
		canWithdraw: flags.active && !flags.paused,
		apyPercent: rayRateToApyPercent(reserve.currentLiquidityRate),
	};
	statusCache = { at: Date.now(), value };
	return value;
}

/** The user's saved balance (aToken, rebasing 1:1 with USDC). Human string. */
export async function getSavingsBalance(env: Bindings, account: `0x${string}`): Promise<string> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	if (!network.aave) return "0";
	const publicClient = getPublicClient(env);
	const raw = (await publicClient.readContract({
		address: network.aave.aUsdc,
		abi: erc20Abi,
		functionName: "balanceOf",
		args: [account],
	})) as bigint;
	return formatUnits(raw, network.contracts.usdcDecimals);
}

/** Batch for a deposit: exact approve + supply, atomic in one UserOp. */
export function buildDepositCalls(network: NetworkConfig, account: `0x${string}`, amountRaw: bigint): AccountCall[] {
	const pool = network.aave!.pool;
	const usdc = network.contracts.usdc;
	return [
		{
			target: usdc,
			value: 0n,
			data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pool, amountRaw] }),
		},
		{
			target: pool,
			value: 0n,
			data: encodeFunctionData({
				abi: AAVE_POOL_ABI,
				functionName: "supply",
				args: [usdc, amountRaw, account, 0],
			}) as Hex,
		},
	];
}

/**
 * Batch for a withdrawal. `amountRaw = null` means "everything": Aave treats
 * uint256.max as full balance, which avoids leaving accrual dust between the
 * prepare and the on-chain execution.
 */
export function buildWithdrawCalls(
	network: NetworkConfig,
	account: `0x${string}`,
	amountRaw: bigint | null,
): AccountCall[] {
	const pool = network.aave!.pool;
	return [
		{
			target: pool,
			value: 0n,
			data: encodeFunctionData({
				abi: AAVE_POOL_ABI,
				functionName: "withdraw",
				args: [network.contracts.usdc, amountRaw ?? maxUint256, account],
			}) as Hex,
		},
	];
}
