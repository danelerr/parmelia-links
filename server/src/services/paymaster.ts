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

// Default sponsorship window: matches the pending-payment TTL (~10 min) so a
// signed-but-unsubmitted UserOp expires and cannot be replayed against the paymaster.
const DEFAULT_SPONSOR_TTL_SECONDS = 600;

type SponsorableUserOp = {
	sender: `0x${string}`;
	nonce: bigint;
	initCode: Hex;
	callData: Hex;
	accountGasLimits: Hex;
	preVerificationGas: bigint;
	gasFees: Hex;
};

function buildPaymasterHeader(
	paymasterAddress: `0x${string}`,
	gasLimits: {
		verificationGasLimit?: bigint;
		postOpGasLimit?: bigint;
	} = {},
): Hex {
	return encodePacked(
		["address", "uint128", "uint128"],
		[
			paymasterAddress,
			gasLimits.verificationGasLimit ??
				PAYMASTER_VERIFICATION_GAS_LIMIT,
			gasLimits.postOpGasLimit ?? PAYMASTER_POST_OP_GAS_LIMIT,
		],
	);
}

function getPaymasterSponsorHash(params: {
	chainId: number;
	paymasterAddress: `0x${string}`;
	userOp: SponsorableUserOp;
	validAfter: bigint;
	validUntil: bigint;
	paymasterHeader?: Hex;
}): Hex {
	const paymasterHeader =
		params.paymasterHeader ?? buildPaymasterHeader(params.paymasterAddress);

	return keccak256(
		encodeAbiParameters(
			parseAbiParameters(
				"uint256 chainId, address paymaster, address sender, uint256 nonce, bytes32 initCodeHash, bytes32 callDataHash, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes32 paymasterConfigHash, uint256 validAfter, uint256 validUntil",
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
				params.validAfter,
				params.validUntil,
			],
		),
	);
}

export async function buildSignedPaymasterAndData(params: {
	chainId: number;
	paymasterAddress: `0x${string}`;
	userOp: SponsorableUserOp;
	signerPrivateKey: `0x${string}`;
	validAfter?: bigint;
	validUntil?: bigint;
	paymasterVerificationGasLimit?: bigint;
	paymasterPostOpGasLimit?: bigint;
}): Promise<Hex> {
	const validAfter = params.validAfter ?? 0n;
	const validUntil =
		params.validUntil ??
		BigInt(Math.floor(Date.now() / 1000) + DEFAULT_SPONSOR_TTL_SECONDS);

	const paymasterHeader = buildPaymasterHeader(params.paymasterAddress, {
		verificationGasLimit: params.paymasterVerificationGasLimit,
		postOpGasLimit: params.paymasterPostOpGasLimit,
	});
	const sponsorHash = getPaymasterSponsorHash({
		chainId: params.chainId,
		paymasterAddress: params.paymasterAddress,
		userOp: params.userOp,
		validAfter,
		validUntil,
		paymasterHeader,
	});
	const sponsorSigner = privateKeyToAccount(params.signerPrivateKey);
	const signature = await sponsorSigner.signMessage({
		message: { raw: sponsorHash },
	});

	// header(52) + validAfter(6) + validUntil(6) + signature(65).
	// uint48 values fit safely in a JS number (max ~2.8e14 << MAX_SAFE_INTEGER).
	const timeBounds = encodePacked(
		["uint48", "uint48"],
		[Number(validAfter), Number(validUntil)],
	);
	return concat([paymasterHeader, timeBounds, signature]) as Hex;
}
