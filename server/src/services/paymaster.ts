import {
	type Hex,
	concat,
	encodeAbiParameters,
	encodePacked,
	keccak256,
	parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const PAYMASTER_VERIFICATION_GAS_LIMIT = 100000n;
export const PAYMASTER_POST_OP_GAS_LIMIT = 50000n;

type SponsorableUserOp = {
	sender: `0x${string}`;
	nonce: bigint;
	initCode: Hex;
	callData: Hex;
	accountGasLimits: Hex;
	preVerificationGas: bigint;
	gasFees: Hex;
};

export function buildPaymasterHeader(paymasterAddress: `0x${string}`): Hex {
	return encodePacked(
		["address", "uint128", "uint128"],
		[
			paymasterAddress,
			PAYMASTER_VERIFICATION_GAS_LIMIT,
			PAYMASTER_POST_OP_GAS_LIMIT,
		],
	);
}

export function getPaymasterSponsorHash(params: {
	chainId: number;
	paymasterAddress: `0x${string}`;
	userOp: SponsorableUserOp;
	paymasterHeader?: Hex;
}): Hex {
	const paymasterHeader =
		params.paymasterHeader ?? buildPaymasterHeader(params.paymasterAddress);

	return keccak256(
		encodeAbiParameters(
			parseAbiParameters(
				"uint256 chainId, address paymaster, address sender, uint256 nonce, bytes32 initCodeHash, bytes32 callDataHash, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes32 paymasterConfigHash",
			),
			[
				BigInt(params.chainId),
				params.paymasterAddress,
				params.userOp.sender,
				params.userOp.nonce,
				keccak256(params.userOp.initCode),
				keccak256(params.userOp.callData),
				params.userOp.accountGasLimits,
				params.userOp.preVerificationGas,
				params.userOp.gasFees,
				keccak256(paymasterHeader),
			],
		),
	);
}

export async function buildSignedPaymasterAndData(params: {
	chainId: number;
	paymasterAddress: `0x${string}`;
	userOp: SponsorableUserOp;
	signerPrivateKey: `0x${string}`;
}): Promise<Hex> {
	const paymasterHeader = buildPaymasterHeader(params.paymasterAddress);
	const sponsorHash = getPaymasterSponsorHash({
		chainId: params.chainId,
		paymasterAddress: params.paymasterAddress,
		userOp: params.userOp,
		paymasterHeader,
	});
	const sponsorSigner = privateKeyToAccount(params.signerPrivateKey);
	const signature = await sponsorSigner.signMessage({
		message: { raw: sponsorHash },
	});

	return concat([paymasterHeader, signature]) as Hex;
}
