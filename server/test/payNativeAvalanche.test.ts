import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeAbiParameters,
	decodeFunctionData,
	parseAbiParameters,
	parseEther,
	type Hex,
} from "viem";

const mocks = vi.hoisted(() => ({
	buildSponsoredUserOp: vi.fn(),
	createPendingPayment: vi.fn(),
	getUserByUid: vi.fn(),
	getUserChainAccount: vi.fn(),
	getPendingPaymentAnyState: vi.fn(),
	getUserOperationTransport: vi.fn(),
	getBalance: vi.fn(),
}));

vi.mock("../src/middlewares/auth", () => ({
	requireAuth: (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("user", { sub: "avax-payer" });
		return next();
	},
}));

vi.mock("../src/services/storage", () => ({
	claimPendingForSubmit: vi.fn(),
	claimPaymentLinkForSubmit: vi.fn(),
	createPendingPayment: mocks.createPendingPayment,
	getPasskey: vi.fn(),
	getPaymentLinkById: vi.fn(),
	getPendingPayment: vi.fn(),
	getUserChainAccount: mocks.getUserChainAccount,
	getPendingPaymentAnyState: mocks.getPendingPaymentAnyState,
	getUserByUid: mocks.getUserByUid,
	isIntentPayable: vi.fn(),
	getPaymentIntentByLinkId: vi.fn(),
	markPaymentLinkClaimBroadcast: vi.fn(),
	releasePaymentLinkClaim: vi.fn(),
	releasePendingClaim: vi.fn(),
	savePasskey: vi.fn(),
	saveUser: vi.fn(),
	setPendingPaymentSubmitted: vi.fn(),
	updateCrosschainOp: vi.fn(),
}));

vi.mock("../src/services/paymentsRpc", () => ({
	reserveAppPaymentAttempt: vi.fn(),
	wakePaymentsSync: vi.fn(),
}));

vi.mock("../src/services/settlement", () => ({
	NON_PAYMENT_CURRENCIES: new Set([
		"PASSKEY_ADD", "PASSKEY_REMOVE", "PASSKEY_SYNC", "SWAP",
		"CROSSCHAIN", "EARN_DEPOSIT", "EARN_WITHDRAW",
	]),
}));

vi.mock("../src/services/userOp", () => ({
	buildSponsoredUserOp: mocks.buildSponsoredUserOp,
	matchOnchainSigner: vi.fn(),
	normalizeLowS: vi.fn((value: string) => value),
	serializeBigInts: vi.fn((value: unknown) => value),
}));

vi.mock("../src/services/clients", () => ({
	getClients: vi.fn(() => ({ publicClient: { getBalance: mocks.getBalance } })),
}));

vi.mock("../src/services/logger", () => ({
	extractErrorMessage: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
	logError: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
}));

vi.mock("../src/services/paymentsCutover", () => ({
	paymentLinkPrepareAction: vi.fn(() => null),
	paymentSubmissionBlocked: vi.fn(() => false),
	paymentsCutoverState: vi.fn(() => ({ mode: "payments" })),
}));

vi.mock("../src/services/signerLease", () => ({
	SignerLeaseBusyError: class SignerLeaseBusyError extends Error {},
}));

vi.mock("../src/services/userOperationTransport", () => ({
	getUserOperationTransport: mocks.getUserOperationTransport,
	selectUserOperationTransport: vi.fn(() => "self"),
	sendUserOperation: vi.fn(),
	UserOperationTransportError: class UserOperationTransportError extends Error {
		possiblySubmitted = false;
		retryable = false;
		errorCode = "TRANSPORT_ERROR";
		transport = "self";
	},
}));

import payRoutes from "../src/routes/pay.routes";

const HOME = "0x1111111111111111111111111111111111111111";
const FUJI_ACCOUNT = "0x2222222222222222222222222222222222222222";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const USER_OP_HASH = `0x${"44".repeat(32)}` as Hex;

const EXECUTE_ABI = [{
	type: "function",
	name: "execute",
	inputs: [
		{ name: "mode", type: "bytes32" },
		{ name: "executionData", type: "bytes" },
	],
	outputs: [],
}] as const;

describe("POST /pay/prepare native Avalanche transfer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getUserByUid.mockResolvedValue({
			uid: "avax-payer",
			walletAddress: HOME,
			credentialId: "credential-1",
		});
		mocks.getUserChainAccount.mockResolvedValue({
			uid: "avax-payer",
			chainId: 43113,
			chainKey: "avalanche-fuji",
			walletAddress: FUJI_ACCOUNT,
			status: "active",
			securityStatus: "current",
			securityVersionApplied: 2,
			securityVersionDesired: 2,
		});
		mocks.getBalance.mockResolvedValue(parseEther("5"));
		mocks.buildSponsoredUserOp.mockImplementation(async (_env, params: { sender: string; callData: Hex }) => ({
			userOp: {
				sender: params.sender,
				nonce: 0n,
				initCode: "0x",
				callData: params.callData,
				accountGasLimits: `0x${"00".repeat(32)}`,
				preVerificationGas: 0n,
				gasFees: `0x${"00".repeat(32)}`,
				paymasterAndData: "0x",
				signature: "0x",
			},
			userOpHash: USER_OP_HASH,
			chainId: 43113,
			rpId: "app.parmelia.me",
			signingPayload: { digest: USER_OP_HASH },
			sponsorshipProvider: "parmelia",
			sponsorshipPaymasterAddress: "0x5e10256DA2DFA684846D2E695aC32e77C7885535",
		}));
		mocks.createPendingPayment.mockResolvedValue(undefined);
	});

	it("keeps AVAX native value and execution on the Fuji account", async () => {
		const response = await payRoutes.request("/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				linkId: "manual",
				wallet: RECIPIENT,
				amount: "1.25",
				currency: "AVAX",
				chainKey: "avalanche-fuji",
			}),
		}, {
			CHAIN_KEY: "arbitrum-sepolia",
			APP_ENABLED_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
			APP_WALLET_RAIL_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
			APP_CHAIN_RPC_URLS: JSON.stringify({ "43113": "https://fuji.example" }),
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			userOpHash: USER_OP_HASH,
			credentialId: "credential-1",
		});

		const [scopedEnv, sponsoredInput] = mocks.buildSponsoredUserOp.mock.calls[0] as [
			{ CHAIN_KEY: string },
			{ sender: string; callData: Hex },
		];
		expect(scopedEnv.CHAIN_KEY).toBe("avalanche-fuji");
		expect(sponsoredInput.sender).toBe(FUJI_ACCOUNT);
		const outer = decodeFunctionData({ abi: EXECUTE_ABI, data: sponsoredInput.callData });
		expect(outer.functionName).toBe("execute");
		const [, executionData] = outer.args as readonly [Hex, Hex];
		const [executions] = decodeAbiParameters(
			parseAbiParameters("(address target, uint256 value, bytes callData)[]"),
			executionData,
		);
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({
			target: RECIPIENT,
			value: parseEther("1.25"),
			callData: "0x",
		});
		expect(mocks.createPendingPayment).toHaveBeenCalledWith(
			expect.objectContaining({ CHAIN_KEY: "avalanche-fuji" }),
			expect.objectContaining({
				chainId: 43113,
				chainKey: "avalanche-fuji",
				currency: "AVAX",
				senderAddress: FUJI_ACCOUNT,
				wallet: RECIPIENT,
			}),
		);
	});

	it("polls a Fuji receipt with Fuji-scoped bindings", async () => {
		const txHash = `0x${"55".repeat(32)}` as Hex;
		mocks.getPendingPaymentAnyState.mockResolvedValue({
			uid: "avax-payer",
			userOpHash: USER_OP_HASH,
			status: "submitted",
			chainKey: "avalanche-fuji",
			submissionTransport: "self",
			submittedTxHash: txHash,
			currency: "AVAX",
			amount: "1.25",
		});
		const receipt = vi.fn().mockResolvedValue({
			success: true,
			transactionHash: txHash,
		});
		mocks.getUserOperationTransport.mockReturnValue({ receipt });

		const response = await payRoutes.request(`/status/${USER_OP_HASH}`, {
			method: "GET",
		}, {
			CHAIN_KEY: "arbitrum-sepolia",
			APP_ENABLED_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
			APP_WALLET_RAIL_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
			APP_CHAIN_RPC_URLS: JSON.stringify({ "43113": "https://fuji.example" }),
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "included",
			txHash,
			currency: "AVAX",
		});
		expect(mocks.getUserOperationTransport).toHaveBeenCalledWith(
			expect.objectContaining({
				CHAIN_KEY: "avalanche-fuji",
				RPC_URL: "https://fuji.example",
			}),
			"self",
		);
		expect(receipt).toHaveBeenCalledWith({
			userOpHash: USER_OP_HASH,
			transactionHash: txHash,
		});
	});
});
