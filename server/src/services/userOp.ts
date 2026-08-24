import {
	type Address,
	type Hex,
	concat,
	encodeAbiParameters,
	encodeFunctionData,
	hashTypedData,
	pad,
	parseAbiParameters,
	toHex,
} from "viem";
import {
	assertContractsDeployed,
	entryPointAbi,
	getNetworkConfig,
	PACKED_USER_OPERATION_EIP712_TYPES,
	type UserOperationSigningPayload,
} from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import { getPaymasterSignerKey } from "./keys";
import {
	buildSignedPaymasterAndData,
	PAYMASTER_POST_OP_GAS_LIMIT,
	PAYMASTER_VERIFICATION_GAS_LIMIT,
} from "./paymaster";
import {
	getUserOperationTransport,
	type UserOperationTransportMode,
} from "./userOperationTransport";

export type AccountCall = {
	target: `0x${string}`;
	value: bigint;
	data: Hex;
};

/**
 * Encode an ERC-7821 `execute(mode, executionData)` batch for the smart
 * account. All calls run atomically inside one UserOperation - this is how a
 * smart account replaces "approve then act" multi-tx flows with a single
 * biometric confirmation.
 */
export function encodeExecuteBatch(calls: AccountCall[]): Hex {
	const mode = pad("0x01", { size: 32, dir: "right" }) as Hex;
	const executionData = encodeAbiParameters(
		parseAbiParameters("(address target, uint256 value, bytes callData)[]"),
		[calls.map((c) => ({ target: c.target, value: c.value, callData: c.data }))],
	);
	return encodeFunctionData({
		abi: [
			{
				name: "execute",
				type: "function",
				inputs: [
					{ name: "mode", type: "bytes32" },
					{ name: "executionData", type: "bytes" },
				],
				outputs: [],
			},
		],
		functionName: "execute",
		args: [mode, executionData],
	});
}

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

/**
 * Find the account's REGISTERED signer bytes for a P256 public key. ERC-7913
 * signers are `verifier(20) || qx(32) || qy(32)`: the verifier ADDRESS the key
 * was registered with is embedded on-chain, so rebuilding the bytes from the
 * network's CURRENT verifier breaks every account created before a verifier
 * redeploy (jul-2026 incident). Matching by the qx||qy suffix recovers the
 * exact bytes regardless of which verifier generation registered them.
 */
export function matchOnchainSigner(signers: readonly Hex[], qx: Hex, qy: Hex): Hex | null {
	const suffix = (qx.slice(2) + qy.slice(2)).toLowerCase();
	if (suffix.length !== 128) return null;
	for (const signer of signers) {
		if (typeof signer === "string" && signer.toLowerCase().endsWith(suffix)) return signer;
	}
	return null;
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

export { PACKED_USER_OPERATION_EIP712_TYPES };
export type { UserOperationSigningPayload };

/** Build the exact EIP-712 document authenticated by EntryPoint v0.9. */
export function buildUserOperationSigningPayload(
	userOp: PackedUserOp,
	chainId: number,
	entryPoint: Address,
): UserOperationSigningPayload {
	const domain = {
		name: "ERC4337" as const,
		version: "1" as const,
		chainId,
		verifyingContract: entryPoint,
	};
	const message = {
		sender: userOp.sender,
		nonce: userOp.nonce.toString(),
		initCode: userOp.initCode,
		callData: userOp.callData,
		accountGasLimits: userOp.accountGasLimits,
		preVerificationGas: userOp.preVerificationGas.toString(),
		gasFees: userOp.gasFees,
		paymasterAndData: userOp.paymasterAndData,
	};
	const digest = hashTypedData({
		domain,
		types: PACKED_USER_OPERATION_EIP712_TYPES,
		primaryType: "PackedUserOperation",
		message: {
			...message,
			nonce: BigInt(message.nonce),
			preVerificationGas: BigInt(message.preVerificationGas),
		},
	});

	return {
		standard: "EIP-712",
		domain,
		types: PACKED_USER_OPERATION_EIP712_TYPES,
		primaryType: "PackedUserOperation",
		message,
		digest,
	};
}

type BuildSponsoredUserOpParams = {
	sender: `0x${string}`;
	callData: Hex;
	verificationGasLimit?: bigint;
	callGasLimit?: bigint;
	preVerificationGas?: bigint;
	transportMode?: UserOperationTransportMode;
};

const DEFAULT_VERIFICATION_GAS_LIMIT = 500000n;
const DEFAULT_CALL_GAS_LIMIT = 300000n;
const DEFAULT_PRE_VERIFICATION_GAS = 100000n;

function bufferedEstimate(
	value: bigint,
	basisPoints: bigint,
	maximum: bigint,
): bigint {
	if (value <= 0n || value > maximum) {
		throw new Error("Bundler returned an unsafe gas estimate");
	}
	const buffered = (value * basisPoints + 9_999n) / 10_000n;
	if (buffered > maximum) {
		throw new Error("Bundler returned an unsafe gas estimate");
	}
	return buffered;
}

function packGasLimits(
	verificationGasLimit: bigint,
	callGasLimit: bigint,
): Hex {
	return concat([
		pad(toHex(verificationGasLimit), { size: 16 }),
		pad(toHex(callGasLimit), { size: 16 }),
	]) as Hex;
}

/**
 * Build a paymaster-sponsored, unsigned ERC-4337 UserOperation for the active
 * chain: resolves nonce + gas fees, attaches a signed paymasterAndData and
 * computes the userOpHash the client must sign with its passkey.
 */
export async function buildSponsoredUserOp(
	env: Bindings,
	params: BuildSponsoredUserOpParams,
): Promise<{
	userOp: PackedUserOp;
	userOpHash: Hex;
	chainId: number;
	signingPayload: UserOperationSigningPayload;
}> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	// Fail closed on half-configured networks (TODO_DEPLOY placeholders).
	assertContractsDeployed(network, ["entryPoint", "paymaster"]);
	const { contracts } = network;
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

	const accountGasLimits = packGasLimits(
		verificationGasLimit,
		callGasLimit,
	);
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
	// Dedicated sponsorship key; falls back to PRIVATE_KEY on testnets only.
	const signerPrivateKey = getPaymasterSignerKey(env);
	userOp.paymasterAndData = await buildSignedPaymasterAndData({
		chainId,
		paymasterAddress: contracts.paymaster,
		userOp,
		signerPrivateKey,
	});

	if (params.transportMode === "bundler") {
		const estimate = await getUserOperationTransport(
			env,
			"bundler",
		).estimate(userOp, contracts.entryPoint);
		const estimatedVerification = bufferedEstimate(
			estimate.verificationGasLimit,
			12_000n,
			10_000_000n,
		);
		const estimatedCall = bufferedEstimate(
			estimate.callGasLimit,
			12_000n,
			10_000_000n,
		);
		userOp.accountGasLimits = packGasLimits(
			estimatedVerification,
			estimatedCall,
		);
		userOp.preVerificationGas = bufferedEstimate(
			estimate.preVerificationGas,
			11_000n,
			2_000_000n,
		);
		const paymasterVerificationGasLimit = bufferedEstimate(
			estimate.paymasterVerificationGasLimit ??
				PAYMASTER_VERIFICATION_GAS_LIMIT,
			12_000n,
			2_000_000n,
		);
		const paymasterPostOpGasLimit = bufferedEstimate(
			estimate.paymasterPostOpGasLimit ?? PAYMASTER_POST_OP_GAS_LIMIT,
			12_000n,
			1_000_000n,
		);
		// Gas fields are part of GatoPago's paymaster authorization. Re-sign only
		// after the bundler estimate is final.
		userOp.paymasterAndData = await buildSignedPaymasterAndData({
			chainId,
			paymasterAddress: contracts.paymaster,
			userOp,
			signerPrivateKey,
			paymasterVerificationGasLimit,
			paymasterPostOpGasLimit,
		});
	}

	const userOpHash = (await publicClient.readContract({
		address: contracts.entryPoint,
		abi: entryPointAbi,
		functionName: "getUserOpHash",
		args: [userOp],
	})) as Hex;
	const signingPayload = buildUserOperationSigningPayload(
		userOp,
		chainId,
		contracts.entryPoint,
	);
	if (signingPayload.digest.toLowerCase() !== userOpHash.toLowerCase()) {
		throw new Error(
			"EntryPoint returned a UserOperation hash that does not match its EIP-712 payload",
		);
	}

	return { userOp, userOpHash, chainId, signingPayload };
}
