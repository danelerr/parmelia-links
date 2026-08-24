import {
	hashTypedData,
	isAddress,
	isHex,
	type Hex,
} from "viem";
import {
	PACKED_USER_OPERATION_EIP712_TYPES,
	type UserOperationSigningPayload,
} from "@gatopago/shared/user-operations";
import { hexToBytes } from "./hex";

export type { UserOperationSigningPayload } from "@gatopago/shared/user-operations";

export type PreparedUserOperation = {
	userOpHash: Hex;
	credentialId: string | null;
	signingPayload: UserOperationSigningPayload;
};

function invalidPayload(): never {
	throw new Error("La solicitud de firma EIP-712 no coincide con la operación preparada.");
}

/**
 * Recompute the EntryPoint v0.9 EIP-712 digest in the browser before invoking
 * WebAuthn. A compromised or misconfigured API cannot swap the typed document
 * and the challenge independently: any mismatch stops before the passkey UI.
 */
function verifyUserOperationSigningPayload(
	payload: UserOperationSigningPayload,
	expectedUserOpHash: string,
	expectedChainId: number,
): Hex {
	if (
		payload?.standard !== "EIP-712" ||
		payload.primaryType !== "PackedUserOperation" ||
		payload.domain?.name !== "ERC4337" ||
		payload.domain.version !== "1" ||
		payload.domain.chainId !== expectedChainId ||
		!isAddress(payload.domain.verifyingContract) ||
		!isAddress(payload.message?.sender) ||
		!isHex(payload.message.initCode) ||
		!isHex(payload.message.callData) ||
		!isHex(payload.message.accountGasLimits) ||
		!isHex(payload.message.gasFees) ||
		!isHex(payload.message.paymasterAndData) ||
		!isHex(payload.digest) ||
		!isHex(expectedUserOpHash)
	) {
		return invalidPayload();
	}

	let nonce: bigint;
	let preVerificationGas: bigint;
	try {
		nonce = BigInt(payload.message.nonce);
		preVerificationGas = BigInt(payload.message.preVerificationGas);
		if (nonce < 0n || preVerificationGas < 0n) return invalidPayload();
	} catch {
		return invalidPayload();
	}

	const digest = hashTypedData({
		domain: payload.domain,
		types: PACKED_USER_OPERATION_EIP712_TYPES,
		primaryType: "PackedUserOperation",
		message: {
			...payload.message,
			nonce,
			preVerificationGas,
		},
	});
	if (
		digest.toLowerCase() !== payload.digest.toLowerCase() ||
		digest.toLowerCase() !== expectedUserOpHash.toLowerCase()
	) {
		return invalidPayload();
	}
	return digest;
}

export function userOperationChallenge(
	prepared: PreparedUserOperation,
	expectedChainId: number,
): Uint8Array {
	return hexToBytes(
		verifyUserOperationSigningPayload(
			prepared.signingPayload,
			prepared.userOpHash,
			expectedChainId,
		),
	);
}
