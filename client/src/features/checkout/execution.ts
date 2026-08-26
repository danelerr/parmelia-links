import {
	decodeFunctionResult,
	encodeFunctionData,
	parseAbi,
	parseSignature,
	type Hex as ViemHex,
} from "viem";
import type {
	Address,
	CheckoutAttempt,
	CheckoutNetwork,
	CctpPaymentAuthorization,
	Eip1193Provider,
	Hex,
	PaymentAuthorization,
} from "./types";
import { ensureProviderChain } from "./walletProvider";

const erc20Abi = parseAbi([
	"function balanceOf(address owner) view returns (uint256)",
	"function allowance(address owner, address spender) view returns (uint256)",
	"function approve(address spender, uint256 amount) returns (bool)",
	"function nonces(address owner) view returns (uint256)",
	"function name() view returns (string)",
	"function version() view returns (string)",
]);

const localRouterAbi = parseAbi([
	"function pay((bytes32 intentId, bytes32 attemptId, address payer, address merchant, uint256 settlementAmount, uint256 platformFee, uint48 validAfter, uint48 validUntil, bytes32 metadataHash) authorization, bytes signature)",
	"function payWithPermit((bytes32 intentId, bytes32 attemptId, address payer, address merchant, uint256 settlementAmount, uint256 platformFee, uint48 validAfter, uint48 validUntil, bytes32 metadataHash) authorization, bytes signature, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)",
]);

const cctpRouterAbi = parseAbi([
	"function pay((bytes32 intentId, bytes32 attemptId, address payer, address merchant, uint256 settlementChainId, uint32 destinationDomain, uint256 settlementAmount, uint256 grossPayerAmount, uint256 platformFee, uint256 maxCctpFee, uint32 minFinalityThreshold, uint48 validAfter, uint48 validUntil, bytes32 metadataHash) authorization, bytes signature)",
	"function payWithPermit((bytes32 intentId, bytes32 attemptId, address payer, address merchant, uint256 settlementChainId, uint32 destinationDomain, uint256 settlementAmount, uint256 grossPayerAmount, uint256 platformFee, uint256 maxCctpFee, uint32 minFinalityThreshold, uint48 validAfter, uint48 validUntil, bytes32 metadataHash) authorization, bytes signature, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)",
]);

export type CheckoutExecutionStage = "checking" | "permit" | "approving" | "submitting" | "confirming";

export class CheckoutExecutionError extends Error {
	readonly code: string;
	readonly cause?: unknown;

	constructor(code: string, message: string, cause?: unknown) {
		super(message);
		this.name = "CheckoutExecutionError";
		this.code = code;
		this.cause = cause;
	}
}

function isUserRejected(error: unknown): boolean {
	const code = (error as { code?: number }).code;
	const message = error instanceof Error ? error.message.toLowerCase() : "";
	return code === 4001 || code === 5000 || message.includes("user rejected") || message.includes("user denied");
}

function validHash(value: unknown): value is Hex {
	return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

async function ethCall(provider: Eip1193Provider, to: Address, data: Hex): Promise<Hex> {
	const result = await provider.request({ method: "eth_call", params: [{ to, data }, "latest"] });
	if (typeof result !== "string" || !result.startsWith("0x")) throw new CheckoutExecutionError("INVALID_RPC_RESPONSE", "Invalid wallet RPC response");
	return result as Hex;
}

async function readUint(
	provider: Eip1193Provider,
	contract: Address,
	functionName: "balanceOf" | "allowance" | "nonces",
	args: readonly Address[],
): Promise<bigint> {
	const data = encodeFunctionData({ abi: erc20Abi, functionName, args } as never);
	const encoded = await ethCall(provider, contract, data);
	return decodeFunctionResult({ abi: erc20Abi, functionName, data: encoded } as never) as bigint;
}

async function readString(
	provider: Eip1193Provider,
	contract: Address,
	functionName: "name" | "version",
	fallback: string,
): Promise<string> {
	try {
		const data = encodeFunctionData({ abi: erc20Abi, functionName });
		const encoded = await ethCall(provider, contract, data);
		const value = decodeFunctionResult({ abi: erc20Abi, functionName, data: encoded });
		return typeof value === "string" && value ? value : fallback;
	} catch {
		return fallback;
	}
}

async function estimate(provider: Eip1193Provider, from: Address, to: Address, data: Hex): Promise<void> {
	await provider.request({ method: "eth_estimateGas", params: [{ from, to, data }] });
}

async function send(provider: Eip1193Provider, from: Address, to: Address, data: Hex): Promise<Hex> {
	const value = await provider.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
	if (!validHash(value)) throw new CheckoutExecutionError("INVALID_TRANSACTION_HASH", "The wallet returned an invalid transaction hash");
	return value;
}

async function waitForTransactionReceipt(
	provider: Eip1193Provider,
	hash: Hex,
	attempts = 60,
): Promise<{ status: string } | null> {
	for (let index = 0; index < attempts; index += 1) {
		const receipt = (await provider.request({
			method: "eth_getTransactionReceipt",
			params: [hash],
		})) as { status?: string } | null;
		if (receipt?.status) return { status: receipt.status };
		await new Promise((resolve) => window.setTimeout(resolve, 1_500));
	}
	return null;
}

function localAuthorization(value: PaymentAuthorization) {
	return {
		intentId: value.intentId,
		attemptId: value.attemptId,
		payer: value.payer,
		merchant: value.merchant,
		settlementAmount: BigInt(value.settlementAmount),
		platformFee: BigInt(value.platformFee),
		validAfter: value.validAfter,
		validUntil: value.validUntil,
		metadataHash: value.metadataHash,
	};
}

function cctpAuthorization(value: CctpPaymentAuthorization) {
	return {
		intentId: value.intentId,
		attemptId: value.attemptId,
		payer: value.payer,
		merchant: value.merchant,
		settlementChainId: BigInt(value.settlementChainId),
		destinationDomain: value.destinationDomain,
		settlementAmount: BigInt(value.settlementAmount),
		grossPayerAmount: BigInt(value.grossPayerAmount),
		platformFee: BigInt(value.platformFee),
		maxCctpFee: BigInt(value.maxCctpFee),
		minFinalityThreshold: value.minFinalityThreshold,
		validAfter: value.validAfter,
		validUntil: value.validUntil,
		metadataHash: value.metadataHash,
	};
}

function paymentData(attempt: CheckoutAttempt): Hex {
	if (attempt.route === "local") {
		return encodeFunctionData({
			abi: localRouterAbi,
			functionName: "pay",
			args: [localAuthorization(attempt.authorization as PaymentAuthorization), attempt.signature],
		});
	}
	return encodeFunctionData({
		abi: cctpRouterAbi,
		functionName: "pay",
		args: [cctpAuthorization(attempt.authorization as CctpPaymentAuthorization), attempt.signature],
	});
}

async function permitPaymentData(input: {
	provider: Eip1193Provider;
	payer: Address;
	network: CheckoutNetwork;
	attempt: CheckoutAttempt;
	grossAmount: bigint;
}): Promise<Hex> {
	const nonce = await readUint(input.provider, input.network.usdc, "nonces", [input.payer]);
	const [name, version] = await Promise.all([
		readString(input.provider, input.network.usdc, "name", "USD Coin"),
		readString(input.provider, input.network.usdc, "version", "2"),
	]);
	const deadline = input.attempt.valid_until;
	const typedData = {
		types: {
			EIP712Domain: [
				{ name: "name", type: "string" },
				{ name: "version", type: "string" },
				{ name: "chainId", type: "uint256" },
				{ name: "verifyingContract", type: "address" },
			],
			Permit: [
				{ name: "owner", type: "address" },
				{ name: "spender", type: "address" },
				{ name: "value", type: "uint256" },
				{ name: "nonce", type: "uint256" },
				{ name: "deadline", type: "uint256" },
			],
		},
		domain: { name, version, chainId: input.network.chain_id, verifyingContract: input.network.usdc },
		primaryType: "Permit",
		message: {
			owner: input.payer,
			spender: input.attempt.router,
			value: input.grossAmount.toString(),
			nonce: nonce.toString(),
			deadline: String(deadline),
		},
	};
	const rawSignature = await input.provider.request({
		method: "eth_signTypedData_v4",
		params: [input.payer, JSON.stringify(typedData)],
	});
	if (typeof rawSignature !== "string" || !rawSignature.startsWith("0x")) {
		throw new CheckoutExecutionError("INVALID_PERMIT_SIGNATURE", "The wallet returned an invalid permit signature");
	}
	const parsed = parseSignature(rawSignature as ViemHex);
	const v = parsed.v === undefined ? 27 + (parsed.yParity ?? 0) : Number(parsed.v);
	if (input.attempt.route === "local") {
		return encodeFunctionData({
			abi: localRouterAbi,
			functionName: "payWithPermit",
			args: [
				localAuthorization(input.attempt.authorization as PaymentAuthorization),
				input.attempt.signature,
				BigInt(deadline),
				v,
				parsed.r,
				parsed.s,
			],
		});
	}
	return encodeFunctionData({
		abi: cctpRouterAbi,
		functionName: "payWithPermit",
		args: [
			cctpAuthorization(input.attempt.authorization as CctpPaymentAuthorization),
			input.attempt.signature,
			BigInt(deadline),
			v,
			parsed.r,
			parsed.s,
		],
	});
}

export async function executeCheckoutAttempt(input: {
	provider: Eip1193Provider;
	payer: Address;
	network: CheckoutNetwork;
	attempt: CheckoutAttempt;
	onStage: (stage: CheckoutExecutionStage) => void;
	onWalletTransaction?: (hash: Hex, kind: "approval" | "payment") => void;
	onSourceTransaction: (hash: Hex) => Promise<void>;
}): Promise<{ sourceTxHash: Hex; receiptConfirmed: boolean }> {
	if (input.attempt.payer.toLowerCase() !== input.payer.toLowerCase()) {
		throw new CheckoutExecutionError("WRONG_WALLET", "Connect the wallet that created this payment attempt");
	}
	if (input.attempt.source_chain_id !== input.network.chain_id) {
		throw new CheckoutExecutionError("WRONG_NETWORK", "The payment attempt belongs to another network");
	}

	await ensureProviderChain(input.provider, input.network.chain_id);
	input.onStage("checking");
	const grossAmount = BigInt(input.attempt.fee_snapshot.gross_payer_amount_atomic);
	const [balance, allowance] = await Promise.all([
		readUint(input.provider, input.network.usdc, "balanceOf", [input.payer]),
		readUint(input.provider, input.network.usdc, "allowance", [input.payer, input.attempt.router]),
	]);
	if (balance < grossAmount) {
		throw new CheckoutExecutionError("INSUFFICIENT_USDC", "This wallet does not have enough USDC on the selected network");
	}

	let data: Hex | null = null;
	if (allowance < grossAmount && input.network.permit_mode === "eip2612") {
		input.onStage("permit");
		try {
			const permitData = await permitPaymentData({ ...input, grossAmount });
			await estimate(input.provider, input.payer, input.attempt.router, permitData);
			data = permitData;
		} catch (error) {
			if (isUserRejected(error)) {
				throw new CheckoutExecutionError("USER_REJECTED", "The wallet request was canceled", error);
			}
			// Some wallet/token combinations do not expose EIP-2612 consistently.
			// The explicit ERC-20 approval below is the safe compatibility path.
			data = null;
		}
	}

	if (allowance < grossAmount && !data) {
		input.onStage("approving");
		const approveData = encodeFunctionData({
			abi: erc20Abi,
			functionName: "approve",
			args: [input.attempt.router, grossAmount],
		});
		await estimate(input.provider, input.payer, input.network.usdc, approveData);
		let approvalHash: Hex;
		try {
			approvalHash = await send(input.provider, input.payer, input.network.usdc, approveData);
		} catch (error) {
			if (isUserRejected(error)) throw new CheckoutExecutionError("USER_REJECTED", "The wallet request was canceled", error);
			throw error;
		}
		input.onWalletTransaction?.(approvalHash, "approval");
		const approvalReceipt = await waitForTransactionReceipt(input.provider, approvalHash);
		if (!approvalReceipt) throw new CheckoutExecutionError("APPROVAL_PENDING", "The USDC approval is still pending");
		if (approvalReceipt.status === "0x0") throw new CheckoutExecutionError("APPROVAL_REVERTED", "The USDC approval failed");
	}

	data ??= paymentData(input.attempt);
	input.onStage("submitting");
	await estimate(input.provider, input.payer, input.attempt.router, data);
	let sourceTxHash: Hex;
	try {
		sourceTxHash = await send(input.provider, input.payer, input.attempt.router, data);
	} catch (error) {
		if (isUserRejected(error)) throw new CheckoutExecutionError("USER_REJECTED", "The wallet request was canceled", error);
		throw error;
	}
	input.onWalletTransaction?.(sourceTxHash, "payment");
	input.onStage("confirming");
	const receipt = await waitForTransactionReceipt(input.provider, sourceTxHash);
	if (receipt?.status === "0x0") {
		throw new CheckoutExecutionError("PAYMENT_REVERTED", "The payment transaction failed");
	}
	if (receipt) await input.onSourceTransaction(sourceTxHash);
	return { sourceTxHash, receiptConfirmed: receipt !== null };
}
