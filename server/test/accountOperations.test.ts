import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";
import type { Bindings } from "../src/middlewares/auth";
import type { AccountOperationRecord } from "../src/services/storage";

const mocks = vi.hoisted(() => ({
	acquireLease: vi.fn(),
	claimFaucet: vi.fn(),
	createAccountOperation: vi.fn(),
	enqueueUserEvent: vi.fn(),
	ensureReferralCode: vi.fn(),
	finishAccountOperation: vi.fn(),
	getAccountOperationById: vi.fn(),
	getActiveAccountOperation: vi.fn(),
	getSignerBlockingAccountOperation: vi.fn(),
	getUserByReferralCode: vi.fn(),
	getUserByUsername: vi.fn(),
	listActiveAccountOperations: vi.fn(),
	markAccountOperationSubmitted: vi.fn(),
	rateLimitConsume: vi.fn(),
	recordAccountOperationAttempt: vi.fn(),
	refundRateLimitConsume: vi.fn(),
	releaseFaucetClaim: vi.fn(),
	releaseLease: vi.fn(),
	revokePasskeysExcept: vi.fn(),
	savePasskey: vi.fn(),
	saveUser: vi.fn(),
	setInvitedBy: vi.fn(),
	sweepAccountOperations: vi.fn(),
	writeLedgerEntries: vi.fn(),
	prepareTransactionRequest: vi.fn(),
	signTransaction: vi.fn(),
	sendRawTransaction: vi.fn(),
	getTransactionReceipt: vi.fn(),
	getTransactionCount: vi.fn(),
	refreshWalletBalancesLatest: vi.fn(),
	requestBalanceRefresh: vi.fn(),
}));

vi.mock("../src/services/storage", () => ({
	acquireLease: mocks.acquireLease,
	claimFaucet: mocks.claimFaucet,
	createAccountOperation: mocks.createAccountOperation,
	enqueueUserEvent: mocks.enqueueUserEvent,
	ensureReferralCode: mocks.ensureReferralCode,
	finishAccountOperation: mocks.finishAccountOperation,
	getAccountOperationById: mocks.getAccountOperationById,
	getActiveAccountOperation: mocks.getActiveAccountOperation,
	getSignerBlockingAccountOperation: mocks.getSignerBlockingAccountOperation,
	getUserByReferralCode: mocks.getUserByReferralCode,
	getUserByUsername: mocks.getUserByUsername,
	listActiveAccountOperations: mocks.listActiveAccountOperations,
	markAccountOperationSubmitted: mocks.markAccountOperationSubmitted,
	rateLimitConsume: mocks.rateLimitConsume,
	recordAccountOperationAttempt: mocks.recordAccountOperationAttempt,
	refundRateLimitConsume: mocks.refundRateLimitConsume,
	releaseFaucetClaim: mocks.releaseFaucetClaim,
	releaseLease: mocks.releaseLease,
	revokePasskeysExcept: mocks.revokePasskeysExcept,
	savePasskey: mocks.savePasskey,
	saveUser: mocks.saveUser,
	setInvitedBy: mocks.setInvitedBy,
	sweepAccountOperations: mocks.sweepAccountOperations,
	writeLedgerEntries: mocks.writeLedgerEntries,
}));

vi.mock("../src/services/clients", () => ({
	getPublicClient: () => ({
		sendRawTransaction: mocks.sendRawTransaction,
		getTransactionReceipt: mocks.getTransactionReceipt,
		getTransactionCount: mocks.getTransactionCount,
	}),
	getFaucetAccount: () => ({ address: "0x00000000000000000000000000000000000000dd" }),
	getFaucetWalletClient: () => ({
		prepareTransactionRequest: mocks.prepareTransactionRequest,
		signTransaction: mocks.signTransaction,
	}),
	getRecoveryGuardianAccount: () => ({ address: "0x00000000000000000000000000000000000000bb" }),
	getRecoveryGuardianWalletClient: () => ({
		prepareTransactionRequest: mocks.prepareTransactionRequest,
		signTransaction: mocks.signTransaction,
	}),
	getServerAccount: () => ({ address: "0x00000000000000000000000000000000000000aa" }),
	getWalletClient: () => ({
		prepareTransactionRequest: mocks.prepareTransactionRequest,
		signTransaction: mocks.signTransaction,
	}),
}));

vi.mock("../src/services/balanceReconciler", () => ({
	refreshWalletBalancesLatest: mocks.refreshWalletBalancesLatest,
}));

vi.mock("../src/services/balanceReadModel", () => ({
	requestBalanceRefresh: mocks.requestBalanceRefresh,
}));

import {
	reconcileAccountOperation,
	startFaucetOperation,
	submitAccountOperation,
} from "../src/services/accountOperations";
import { SIGNER_LEASE_TTL_MS } from "../src/services/signerLease";

const ENV = {
	CHAIN_KEY: "arbitrum-sepolia",
} as Bindings;
const RAW_TRANSACTION = (`0x${"11".repeat(96)}`) as Hex;
const TX_HASH = keccak256(RAW_TRANSACTION);
const NOW = "2026-07-14T00:00:00.000Z";

function operation(
	kind: AccountOperationRecord["kind"],
	metadata: Record<string, unknown>,
	status: AccountOperationRecord["status"] = "submitted",
): AccountOperationRecord {
	return {
		id: "operation-1",
		uid: "user-1",
		kind,
		status,
		txHash: TX_HASH,
		rawTransaction: RAW_TRANSACTION,
		signerAddress: "0x00000000000000000000000000000000000000aa",
		nonce: 7,
		metadata,
		attemptCount: 1,
		lastError: null,
		errorCode: null,
		createdAt: NOW,
		updatedAt: NOW,
		confirmedAt: null,
		expiresAt: "2026-07-15T00:00:00.000Z",
	};
}

let persisted: AccountOperationRecord | null;

beforeEach(() => {
	vi.clearAllMocks();
	persisted = null;
	mocks.acquireLease.mockResolvedValue("lease-owner");
	mocks.enqueueUserEvent.mockResolvedValue(true);
	mocks.releaseLease.mockResolvedValue(undefined);
	mocks.getActiveAccountOperation.mockResolvedValue(null);
	mocks.getSignerBlockingAccountOperation.mockResolvedValue(null);
	mocks.prepareTransactionRequest.mockResolvedValue({
		to: "0x00000000000000000000000000000000000000cc",
		data: "0x1234",
		nonce: 7,
	});
	mocks.signTransaction.mockResolvedValue(RAW_TRANSACTION);
	mocks.createAccountOperation.mockImplementation(async (_env, input) => {
		persisted = {
			...input,
			status: "prepared",
			attemptCount: 0,
			lastError: null,
			errorCode: null,
			updatedAt: input.createdAt,
			confirmedAt: null,
		};
		return true;
	});
	mocks.getAccountOperationById.mockImplementation(async () => persisted);
	mocks.recordAccountOperationAttempt.mockResolvedValue(undefined);
	mocks.markAccountOperationSubmitted.mockImplementation(async () => {
		if (persisted) persisted = { ...persisted, status: "submitted" };
	});
	mocks.sendRawTransaction.mockResolvedValue(TX_HASH);
	mocks.refreshWalletBalancesLatest.mockResolvedValue([]);
	mocks.requestBalanceRefresh.mockResolvedValue({});
	mocks.finishAccountOperation.mockImplementation(async (_env, _id, status, fields = {}) => {
		if (!persisted || !["prepared", "submitted"].includes(persisted.status)) return false;
		persisted = {
			...persisted,
			status,
			errorCode: fields.errorCode ?? null,
			lastError: fields.lastError ?? null,
		};
		return true;
	});
});

describe("durable account operations", () => {
	it("persists the signed transaction before broadcasting it", async () => {
		await submitAccountOperation(ENV, {
			uid: "user-1",
			kind: "recovery_cancel",
			to: "0x00000000000000000000000000000000000000cc",
			data: "0x1234",
			metadata: { walletAddress: "0x00000000000000000000000000000000000000cc" },
		});

		expect(mocks.createAccountOperation).toHaveBeenCalledOnce();
		expect(mocks.acquireLease).toHaveBeenCalledWith(
			ENV,
			"tx:421614:0x00000000000000000000000000000000000000aa",
			SIGNER_LEASE_TTL_MS,
		);
		expect(mocks.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: RAW_TRANSACTION });
		expect(mocks.createAccountOperation.mock.invocationCallOrder[0])
			.toBeLessThan(mocks.sendRawTransaction.mock.invocationCallOrder[0]);
		expect(persisted?.status).toBe("submitted");
	});

	it("persists a recovered credential only after a successful receipt", async () => {
		persisted = operation("recovery_execute", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
			credentialId: "credential-1",
			qx: "0x11",
			qy: "0x22",
		});
		mocks.getTransactionReceipt.mockResolvedValue({ status: "success" });
		mocks.saveUser.mockResolvedValue(undefined);
		mocks.savePasskey.mockResolvedValue(undefined);
		mocks.revokePasskeysExcept.mockResolvedValue(2);

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(mocks.revokePasskeysExcept).toHaveBeenCalledWith(ENV, {
			uid: "user-1",
			keepCredentialId: "credential-1",
		});
		expect(mocks.saveUser).toHaveBeenCalledWith(ENV, { uid: "user-1", credentialId: "credential-1" });
		expect(mocks.savePasskey).toHaveBeenCalledWith(ENV, {
			uid: "user-1",
			credentialId: "credential-1",
			qx: "0x11",
			qy: "0x22",
			registrationSource: "recovery",
			name: null,
			transports: [],
			rpId: null,
			aaguid: null,
			providerName: null,
			credentialDeviceType: null,
			credentialBackedUp: null,
			authenticatorAttachment: null,
		});
		expect(result?.status).toBe("confirmed");
	});

	it("rebroadcasts a prepared raw transaction under its signer lease", async () => {
		persisted = operation("recovery_cancel", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
		}, "prepared");
		mocks.getSignerBlockingAccountOperation.mockImplementation(async () => persisted);
		mocks.getTransactionReceipt.mockResolvedValue({ status: "success" });

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(mocks.acquireLease).toHaveBeenCalledWith(
			ENV,
			"tx:421614:0x00000000000000000000000000000000000000aa",
			SIGNER_LEASE_TTL_MS,
		);
		expect(mocks.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: RAW_TRANSACTION });
		expect(result?.status).toBe("confirmed");
	});

	it("leaves a prepared raw transaction untouched when another action owns the lease", async () => {
		persisted = operation("recovery_cancel", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
		}, "prepared");
		mocks.acquireLease.mockResolvedValue(null);

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(result?.status).toBe("prepared");
		expect(mocks.sendRawTransaction).not.toHaveBeenCalled();
		expect(mocks.getTransactionReceipt).not.toHaveBeenCalled();
	});

	it("keeps a confirmed transaction retryable when D1 finalization fails", async () => {
		persisted = {
			...operation("recovery_execute", {
				credentialId: "credential-1",
				qx: "0x11",
				qy: "0x22",
			}),
			expiresAt: "2020-01-01T00:00:00.000Z",
		};
		mocks.getTransactionReceipt.mockResolvedValue({ status: "success" });
		mocks.saveUser.mockRejectedValue(new Error("D1 unavailable"));

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(result?.status).toBe("submitted");
		expect(mocks.recordAccountOperationAttempt).toHaveBeenCalledOnce();
		expect(mocks.finishAccountOperation).not.toHaveBeenCalled();
		expect(mocks.getTransactionCount).not.toHaveBeenCalled();
	});

	it("compensates a reverted faucet claim only for the winning transition", async () => {
		persisted = operation("faucet", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
			amount: "5",
			reference: "Test funds",
		});
		mocks.getTransactionReceipt.mockResolvedValue({ status: "reverted" });
		mocks.releaseFaucetClaim.mockResolvedValue(undefined);
		mocks.refundRateLimitConsume.mockResolvedValue(undefined);

		const stale = persisted;
		await reconcileAccountOperation(ENV, stale);
		await reconcileAccountOperation(ENV, stale);

		expect(mocks.releaseFaucetClaim).toHaveBeenCalledOnce();
		expect(mocks.refundRateLimitConsume).toHaveBeenCalledOnce();
	});

	it("publishes a freshly confirmed faucet balance at the receipt block", async () => {
		persisted = operation("faucet", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
			amount: "5",
			reference: "Test funds",
		});
		mocks.getTransactionReceipt.mockResolvedValue({
			status: "success",
			blockNumber: 12345n,
		});

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(result?.status).toBe("confirmed");
		expect(mocks.refreshWalletBalancesLatest).toHaveBeenCalledWith(ENV, {
			uid: "user-1",
			accountAddress: "0x00000000000000000000000000000000000000cc",
			chainId: 421614,
			notBeforeBlock: "12345",
		});
		expect(mocks.requestBalanceRefresh).not.toHaveBeenCalled();
	});

	it("queues a coalesced faucet balance repair when the fast read fails", async () => {
		persisted = operation("faucet", {
			walletAddress: "0x00000000000000000000000000000000000000cc",
			amount: "5",
			reference: "Test funds",
		});
		mocks.getTransactionReceipt.mockResolvedValue({
			status: "success",
			blockNumber: 12345n,
		});
		mocks.refreshWalletBalancesLatest.mockRejectedValueOnce(
			new Error("RPC unavailable"),
		);

		const result = await reconcileAccountOperation(ENV, persisted);

		expect(result?.status).toBe("confirmed");
		expect(mocks.requestBalanceRefresh).toHaveBeenCalledWith(ENV, {
			uid: "user-1",
			accountAddress: "0x00000000000000000000000000000000000000cc",
			chainId: 421614,
			reason: "confirmed_faucet_operation",
			priority: 0,
			notBeforeBlock: "12345",
		});
	});

	it("does not refund a faucet claim after an ambiguous post-persistence failure", async () => {
		mocks.claimFaucet.mockResolvedValue(true);
		mocks.rateLimitConsume.mockResolvedValue(true);
		mocks.getActiveAccountOperation.mockImplementation(async () => persisted);
		mocks.getAccountOperationById.mockRejectedValue(new Error("D1 read failed after insert"));

		const result = await startFaucetOperation(ENV, {
			uid: "user-1",
			walletAddress: "0x00000000000000000000000000000000000000cc",
			reference: "Test funds",
		});

		expect(result?.operation.status).toBe("prepared");
		expect(mocks.releaseFaucetClaim).not.toHaveBeenCalled();
		expect(mocks.refundRateLimitConsume).not.toHaveBeenCalled();
	});

	it("signs and leases faucet transfers with the dedicated faucet account", async () => {
		mocks.claimFaucet.mockResolvedValue(true);
		mocks.rateLimitConsume.mockResolvedValue(true);

		const result = await startFaucetOperation(ENV, {
			uid: "user-1",
			walletAddress: "0x00000000000000000000000000000000000000cc",
			reference: "Test funds",
		});

		expect(result?.operation.signerAddress).toBe("0x00000000000000000000000000000000000000dd");
		expect(mocks.acquireLease).toHaveBeenCalledWith(
			ENV,
			"tx:421614:0x00000000000000000000000000000000000000dd",
			SIGNER_LEASE_TTL_MS,
		);
	});
});
