import type { Address, Hex } from "viem";

/**
 * Canonical EntryPoint v0.9 EIP-712 schema. Field order is cryptographic API:
 * changing it changes every UserOperation digest on both client and server.
 */
export const PACKED_USER_OPERATION_EIP712_TYPES = {
	PackedUserOperation: [
		{ name: "sender", type: "address" },
		{ name: "nonce", type: "uint256" },
		{ name: "initCode", type: "bytes" },
		{ name: "callData", type: "bytes" },
		{ name: "accountGasLimits", type: "bytes32" },
		{ name: "preVerificationGas", type: "uint256" },
		{ name: "gasFees", type: "bytes32" },
		{ name: "paymasterAndData", type: "bytes" },
	],
} as const;

export type UserOperationSigningPayload = {
	standard: "EIP-712";
	domain: {
		name: "ERC4337";
		version: "1";
		chainId: number;
		verifyingContract: Address;
	};
	types: typeof PACKED_USER_OPERATION_EIP712_TYPES;
	primaryType: "PackedUserOperation";
	message: {
		sender: Address;
		nonce: string;
		initCode: Hex;
		callData: Hex;
		accountGasLimits: Hex;
		preVerificationGas: string;
		gasFees: Hex;
		paymasterAndData: Hex;
	};
	digest: Hex;
};
