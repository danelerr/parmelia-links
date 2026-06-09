import { type Hex, concat, pad, toHex } from "viem";
import { entryPointAbi, getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import { buildSignedPaymasterAndData } from "./paymaster";

/** secp256r1 (P-256) curve order. */
export const P256_N =
	0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;

/**
 * Normalize an ECDSA `s` value to its low-s form (s <= n/2), required by
 * OpenZeppelin's P256 verifier. Returns a 32-byte hex string.
 */
export function normalizeLowS(s: string): Hex {
	let value = BigInt(s);
	if (value > P256_N / 2n) value = P256_N - value;
	return ("0x" + value.toString(16).padStart(64, "0")) as Hex;
}

/** Replace bigints with hex strings so a UserOp can be persisted as JSON. */
export function serializeBigInts(obj: unknown): unknown {
	if (typeof obj === "bigint") return "0x" + obj.toString(16);
	if (Array.isArray(obj)) return obj.map(serializeBigInts);
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(
			Object.entries(obj).map(([key, value]) => [key, serializeBigInts(value)]),
		);
	}
	return obj;
}

export type PackedUserOp = {
	sender: `0x${string}`;
	nonce: bigint;
	initCode: Hex;
	callData: Hex;
	accountGasLimits: Hex;
	preVerificationGas: bigint;
	gasFees: Hex;
	paymasterAndData: Hex;
	signature: Hex;
};

type BuildSponsoredUserOpParams = {
	sender: `0x${string}`;
	callData: Hex;
	verificationGasLimit?: bigint;
	callGasLimit?: bigint;
	preVerificationGas?: bigint;
};

export const DEFAULT_VERIFICATION_GAS_LIMIT = 500000n;
export const DEFAULT_CALL_GAS_LIMIT = 300000n;
export const DEFAULT_PRE_VERIFICATION_GAS = 100000n;

/**
 * Build a paymaster-sponsored, unsigned ERC-4337 UserOperation for the active
 * chain: resolves nonce + gas fees, attaches a signed paymasterAndData and
 * computes the userOpHash the client must sign with its passkey.
 */
export async function buildSponsoredUserOp(
	env: Bindings,
	params: BuildSponsoredUserOpParams,
): Promise<{ userOp: PackedUserOp; userOpHash: Hex; chainId: number }> {
	const { contracts } = getNetworkConfig(env.CHAIN_KEY);
	const publicClient = getPublicClient(env);

	const verificationGasLimit =
		params.verificationGasLimit ?? DEFAULT_VERIFICATION_GAS_LIMIT;
	const callGasLimit = params.callGasLimit ?? DEFAULT_CALL_GAS_LIMIT;
	const preVerificationGas =
		params.preVerificationGas ?? DEFAULT_PRE_VERIFICATION_GAS;

	const nonce = (await publicClient.readContract({
		address: contracts.entryPoint,
		abi: entryPointAbi,
		functionName: "getNonce",
		args: [params.sender, 0n],
	})) as bigint;

	const gasPrice = await publicClient.getGasPrice();
	const maxFeePerGas = gasPrice * 2n;
	const maxPriorityFeePerGas =
		gasPrice / 10n > 1000000n ? gasPrice / 10n : 1000000n;

	const accountGasLimits = concat([
		pad(toHex(verificationGasLimit), { size: 16 }),
		pad(toHex(callGasLimit), { size: 16 }),
	]) as Hex;
	const gasFees = concat([
		pad(toHex(maxPriorityFeePerGas), { size: 16 }),
		pad(toHex(maxFeePerGas), { size: 16 }),
	]) as Hex;

	const userOp: PackedUserOp = {
		sender: params.sender,
		nonce,
		initCode: "0x",
		callData: params.callData,
		accountGasLimits,
		preVerificationGas,
		gasFees,
		paymasterAndData: "0x",
		signature: "0x",
	};

	const chainId = await publicClient.getChainId();
	const signerPrivateKey = (env.PAYMASTER_SIGNER_PRIVATE_KEY ||
		env.PRIVATE_KEY) as `0x${string}`;
	userOp.paymasterAndData = await buildSignedPaymasterAndData({
		chainId,
		paymasterAddress: contracts.paymaster,
		userOp,
		signerPrivateKey,
	});

	const userOpHash = (await publicClient.readContract({
		address: contracts.entryPoint,
		abi: entryPointAbi,
		functionName: "getUserOpHash",
		args: [userOp],
	})) as Hex;

	return { userOp, userOpHash, chainId };
}
