import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { accountWebAuthnV2Abi } from "../../shared";

// Route-level tests for the guardian-recovery endpoints: the cancel path (the
// push alert says "cancélala si no fuiste tú" — this is that promise) and the
// execute signer-check (executeRecovery REPLACES all signers, so persisting a
// credential that isn't the proposed one would brick signing for the account).

const mocks = vi.hoisted(() => ({
	readContract: vi.fn(),
	getUserByUid: vi.fn(),
	getActiveAccountOperation: vi.fn(),
	getAccountOperationById: vi.fn(),
	submitAccountOperation: vi.fn(),
	reconcileAccountOperation: vi.fn(),
	rateLimitConsume: vi.fn(),
	consumeRecoveryStepUp: vi.fn(),
	validateRecoveryStepUp: vi.fn(),
	finalizeWebAuthnRegistration: vi.fn(),
}));

vi.mock("../src/middlewares/auth", () => ({
	requireAuth: (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
		c.set("user", { sub: "user-1" });
		return next();
	},
}));

vi.mock("../src/services/storage", () => ({
	getUserByUid: mocks.getUserByUid,
	createPendingPayment: vi.fn(),
	getActiveAccountOperation: mocks.getActiveAccountOperation,
	getAccountOperationById: mocks.getAccountOperationById,
	rateLimitConsume: mocks.rateLimitConsume,
}));

vi.mock("../src/services/emailOtp", () => ({
	consumeRecoveryStepUp: mocks.consumeRecoveryStepUp,
	validateRecoveryStepUp: mocks.validateRecoveryStepUp,
}));

vi.mock("../src/services/webauthnRegistration", () => ({
	InvalidWebAuthnRegistrationError: class InvalidWebAuthnRegistrationError extends Error {},
	deleteExpiredWebAuthnRegistrations: vi.fn(),
	finalizeWebAuthnRegistration: mocks.finalizeWebAuthnRegistration,
	getFinalizedWebAuthnRegistration: vi.fn(),
	issueWebAuthnRegistration: vi.fn(),
	validWebAuthnRegistrationOrigin: vi.fn(() => "https://app.parmelia.me"),
}));

vi.mock("../src/services/clients", () => ({
	getPublicClient: () => ({ readContract: mocks.readContract }),
	getRecoveryGuardianAccount: () => ({ address: "0x00000000000000000000000000000000000000aa" }),
	getServerAccount: () => ({ address: "0x00000000000000000000000000000000000000aa" }),
}));

vi.mock("../src/services/accountOperations", () => ({
	AccountOperationBusyError: class AccountOperationBusyError extends Error {},
	FaucetBudgetExhaustedError: class FaucetBudgetExhaustedError extends Error {},
	getFaucetPolicy: () => ({ enabled: true, dailyClaims: 100 }),
	reconcileAccountOperation: mocks.reconcileAccountOperation,
	startFaucetOperation: vi.fn(),
	submitAccountOperation: mocks.submitAccountOperation,
	toAccountOperationView: (operation: Record<string, unknown>) => ({
		id: operation.id,
		kind: operation.kind,
		status: operation.status,
		txHash: operation.txHash,
		attemptCount: operation.attemptCount,
		errorCode: operation.errorCode,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		confirmedAt: operation.confirmedAt,
	}),
}));

import accountRoutes from "../src/routes/account.routes";

const ENV = { CHAIN_KEY: "arbitrum-sepolia" };
const WALLET = "0x000000000000000000000000000000000000beef";
const TX = "0x" + "ab".repeat(32);
const NOW = "2026-07-14T00:00:00.000Z";

// ERC-7913 signer bytes: verifier(20) || qx(32) || qy(32). The proposal on
// chain may carry a PREVIOUS verifier generation (redeploy inside the 48h
// window) — the match must be by public key, not by full bytes.
const OLD_VERIFIER = "0xb7fa10dee75042d6973676a7d7882e4621b806d6";
const QX = ("0x" + "11".repeat(32)) as Hex;
const QY = ("0x" + "22".repeat(32)) as Hex;
const OTHER_QX = ("0x" + "33".repeat(32)) as Hex;
const PROPOSED_SIGNER = (OLD_VERIFIER + QX.slice(2) + QY.slice(2)) as Hex;

function post(path: string, body?: unknown, stepUpToken: string | null = "test-step-up-token") {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (stepUpToken) headers["X-Step-Up-Token"] = stepUpToken;
	return accountRoutes.request(
		path,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body ?? {}),
		},
		ENV,
	);
}

function get(path: string) {
	return accountRoutes.request(path, { method: "GET" }, ENV);
}

function storedOperation(overrides: Record<string, unknown> = {}) {
	return {
		id: "operation-1",
		uid: "user-1",
		kind: "recovery_cancel",
		status: "submitted",
		txHash: TX,
		metadata: { walletAddress: WALLET },
		attemptCount: 1,
		errorCode: null,
		createdAt: NOW,
		updatedAt: NOW,
		confirmedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getUserByUid.mockResolvedValue({ uid: "user-1", walletAddress: WALLET });
	mocks.getActiveAccountOperation.mockResolvedValue(null);
	mocks.submitAccountOperation.mockImplementation(async (_env, input) => ({
		created: true,
		operation: storedOperation({ kind: input.kind, metadata: input.metadata }),
	}));
	mocks.rateLimitConsume.mockResolvedValue(true);
	mocks.consumeRecoveryStepUp.mockResolvedValue(true);
	mocks.validateRecoveryStepUp.mockResolvedValue(true);
	mocks.finalizeWebAuthnRegistration.mockResolvedValue({
		registrationId: "registration-1",
		credentialId: "credential-1",
		qx: QX,
		qy: QY,
		name: "Recovery key",
		transports: ["internal"],
	});
});

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("POST /recovery/cancel", () => {
	it("queues guardianCancelRecovery as a durable operation", async () => {
		mocks.readContract
			.mockResolvedValueOnce(true) // isRecoveryPending
			.mockResolvedValueOnce("0x00000000000000000000000000000000000000aa"); // guardian

		const res = await post("/recovery/cancel");
		const body = await jsonBody(res);

		expect(res.status).toBe(202);
		expect(body.operationId).toBe("operation-1");
		expect(body.txHash).toBe(TX);
		const input = mocks.submitAccountOperation.mock.calls[0][1];
		expect(input).toMatchObject({ uid: "user-1", kind: "recovery_cancel", to: WALLET, signer: "guardian" });
		expect(decodeFunctionData({ abi: accountWebAuthnV2Abi, data: input.data }).functionName)
			.toBe("guardianCancelRecovery");
	});

	it("409 RECOVERY_NONE when nothing is pending (nothing is written)", async () => {
		mocks.readContract.mockResolvedValueOnce(false);

		const res = await post("/recovery/cancel");
		const body = await jsonBody(res);

		expect(res.status).toBe(409);
		expect(body.error_code).toBe("RECOVERY_NONE");
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});

	it("400 NO_WALLET without an account", async () => {
		mocks.getUserByUid.mockResolvedValue({ uid: "user-1", walletAddress: null });

		const res = await post("/recovery/cancel");
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error_code).toBe("NO_WALLET");
	});
});

describe("POST /recovery/execute", () => {
	// getPendingRecovery -> [executeAfter, signers, threshold]
	const ready = (signers: Hex[]) => [1n, signers, 1n];

	it("400 MISSING_PASSKEY_DATA without qx/qy (old credentialId-only shape)", async () => {
		const res = await post("/recovery/execute", { credentialId: "cred-1" });
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).error_code).toBe("MISSING_PASSKEY_DATA");
	});

	it("queues execution and defers credential persistence until confirmation", async () => {
		mocks.readContract.mockResolvedValueOnce(ready([PROPOSED_SIGNER]));

		const res = await post("/recovery/execute", { credentialId: "cred-1", qx: QX, qy: QY });
		const body = await jsonBody(res);

		expect(res.status).toBe(202);
		expect(body.operationId).toBe("operation-1");
		const input = mocks.submitAccountOperation.mock.calls[0][1];
		expect(input).toMatchObject({
			uid: "user-1",
			kind: "recovery_execute",
			to: WALLET,
			metadata: { walletAddress: WALLET, credentialId: "cred-1", qx: QX, qy: QY },
		});
		expect(decodeFunctionData({ abi: accountWebAuthnV2Abi, data: input.data }).functionName)
			.toBe("executeRecovery");
	});

	it("403 STEP_UP_REQUIRED before a ready recovery can execute", async () => {
		mocks.readContract.mockResolvedValueOnce(ready([PROPOSED_SIGNER]));

		const res = await post(
			"/recovery/execute",
			{ credentialId: "cred-1", qx: QX, qy: QY },
			null,
		);

		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error_code).toBe("STEP_UP_REQUIRED");
		expect(mocks.consumeRecoveryStepUp).not.toHaveBeenCalled();
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});

	it("403 STEP_UP_INVALID for a consumed or expired proof", async () => {
		mocks.readContract.mockResolvedValueOnce(ready([PROPOSED_SIGNER]));
		mocks.consumeRecoveryStepUp.mockResolvedValueOnce(false);

		const res = await post("/recovery/execute", {
			credentialId: "cred-1",
			qx: QX,
			qy: QY,
		});

		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error_code).toBe("STEP_UP_INVALID");
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});

	it("409 RECOVERY_SIGNER_MISMATCH when the key is not the proposed one; nothing executes", async () => {
		mocks.readContract.mockResolvedValueOnce(ready([PROPOSED_SIGNER]));

		const res = await post("/recovery/execute", { credentialId: "cred-1", qx: OTHER_QX, qy: QY });
		const body = await jsonBody(res);

		expect(res.status).toBe(409);
		expect(body.error_code).toBe("RECOVERY_SIGNER_MISMATCH");
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});

	it("409 RECOVERY_NOT_READY inside the 48h timelock", async () => {
		const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
		mocks.readContract.mockResolvedValueOnce([future, [PROPOSED_SIGNER], 1n]);

		const res = await post("/recovery/execute", { credentialId: "cred-1", qx: QX, qy: QY });
		expect(res.status).toBe(409);
		expect((await jsonBody(res)).error_code).toBe("RECOVERY_NOT_READY");
	});

	it("409 RECOVERY_NONE when no recovery was proposed", async () => {
		mocks.readContract.mockResolvedValueOnce([0n, [], 1n]);

		const res = await post("/recovery/execute", { credentialId: "cred-1", qx: QX, qy: QY });
		expect(res.status).toBe(409);
		expect((await jsonBody(res)).error_code).toBe("RECOVERY_NONE");
	});
});

describe("POST /recovery/propose", () => {
	const registrationBody = {
		registrationId: "registration-1",
		credentialId: "credential-1",
		qx: QX,
		qy: QY,
		clientDataJSON: "client-data",
		attestationObject: "attestation",
	};

	function recoveryAvailable() {
		mocks.readContract
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce("0x00000000000000000000000000000000000000aa");
	}

	it("requires step-up on the mutation even after WebAuthn was finalized", async () => {
		recoveryAvailable();
		const res = await post("/recovery/propose", registrationBody, null);

		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error_code).toBe("STEP_UP_REQUIRED");
		expect(mocks.finalizeWebAuthnRegistration).not.toHaveBeenCalled();
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});

	it("consumes the proof before creating the durable recovery proposal", async () => {
		recoveryAvailable();
		const res = await post("/recovery/propose", registrationBody);

		expect(res.status).toBe(202);
		expect(mocks.finalizeWebAuthnRegistration).toHaveBeenCalledOnce();
		expect(mocks.consumeRecoveryStepUp).toHaveBeenCalledWith(
			ENV,
			{ uid: "user-1", token: "test-step-up-token" },
		);
		expect(mocks.submitAccountOperation).toHaveBeenCalledOnce();
	});

	it("rejects a replay when its proof was consumed or expired", async () => {
		recoveryAvailable();
		mocks.consumeRecoveryStepUp.mockResolvedValueOnce(false);
		const res = await post("/recovery/propose", registrationBody);

		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error_code).toBe("STEP_UP_INVALID");
		expect(mocks.finalizeWebAuthnRegistration).toHaveBeenCalledOnce();
		expect(mocks.submitAccountOperation).not.toHaveBeenCalled();
	});
});

describe("GET /operations/:id", () => {
	it("returns 404 for an unknown operation", async () => {
		mocks.getAccountOperationById.mockResolvedValue(null);

		const res = await get("/operations/missing");

		expect(res.status).toBe(404);
		expect((await jsonBody(res)).error_code).toBe("OPERATION_NOT_FOUND");
	});

	it("does not expose an operation owned by another user", async () => {
		mocks.getAccountOperationById.mockResolvedValue(storedOperation({ uid: "user-2" }));

		const res = await get("/operations/operation-1");

		expect(res.status).toBe(403);
		expect((await jsonBody(res)).error_code).toBe("WRONG_ACCOUNT");
		expect(mocks.reconcileAccountOperation).not.toHaveBeenCalled();
	});

	it("reconciles an owned pending operation before returning it", async () => {
		const pending = storedOperation();
		const confirmed = storedOperation({ status: "confirmed", confirmedAt: NOW });
		mocks.getAccountOperationById.mockResolvedValue(pending);
		mocks.reconcileAccountOperation.mockResolvedValue(confirmed);

		const res = await get("/operations/operation-1");
		const body = await jsonBody(res);

		expect(res.status).toBe(200);
		expect(body).toMatchObject({ operationId: "operation-1", status: "confirmed", txHash: TX });
		expect(mocks.reconcileAccountOperation).toHaveBeenCalledWith(ENV, pending);
	});
});
