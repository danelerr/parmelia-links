import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";

const mocks = vi.hoisted(() => ({
	acquireLease: vi.fn(),
	getSignerBlockingAccountOperation: vi.fn(),
	releaseLease: vi.fn(),
}));

vi.mock("../src/services/storage", () => ({
	acquireLease: mocks.acquireLease,
	getSignerBlockingAccountOperation: mocks.getSignerBlockingAccountOperation,
	releaseLease: mocks.releaseLease,
}));

import {
	SIGNER_LEASE_TTL_MS,
	SignerLeaseBusyError,
	signerLeaseKey,
	withSignerLease,
} from "../src/services/signerLease";

const ENV = {} as Bindings;
const ADDRESS = "0x00000000000000000000000000000000000000AA";
const KEY = "tx:421614:0x00000000000000000000000000000000000000aa";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.acquireLease.mockResolvedValue("owner-1");
	mocks.getSignerBlockingAccountOperation.mockResolvedValue(null);
	mocks.releaseLease.mockResolvedValue(undefined);
});

describe("signer nonce lease", () => {
	it("builds one normalized key per chain and signer", () => {
		expect(signerLeaseKey(421614, ADDRESS)).toBe(KEY);
		expect(() => signerLeaseKey(0, ADDRESS)).toThrow("Invalid signer chain ID");
		expect(() => signerLeaseKey(421614, "0x1234")).toThrow("Invalid signer address");
	});

	it("holds the lease for the action and releases the same owner", async () => {
		const action = vi.fn(async () => "sent");

		await expect(withSignerLease(ENV, { chainId: 421614, signerAddress: ADDRESS }, action))
			.resolves.toBe("sent");

		expect(mocks.acquireLease).toHaveBeenCalledWith(ENV, KEY, SIGNER_LEASE_TTL_MS);
		expect(action).toHaveBeenCalledOnce();
		expect(mocks.releaseLease).toHaveBeenCalledWith(ENV, KEY, "owner-1");
	});

	it("releases ownership when the signer action throws", async () => {
		const failure = new Error("RPC failed");

		await expect(withSignerLease(ENV, { chainId: 421614, signerAddress: ADDRESS }, async () => {
			throw failure;
		})).rejects.toBe(failure);

		expect(mocks.releaseLease).toHaveBeenCalledWith(ENV, KEY, "owner-1");
	});

	it("blocks a different action while a raw nonce reservation is unresolved", async () => {
		mocks.getSignerBlockingAccountOperation.mockResolvedValue({ id: "operation-1" });
		const action = vi.fn(async () => undefined);

		await expect(withSignerLease(
			ENV,
			{ chainId: 421614, signerAddress: ADDRESS },
			action,
		)).rejects.toBeInstanceOf(SignerLeaseBusyError);

		expect(action).not.toHaveBeenCalled();
		expect(mocks.releaseLease).toHaveBeenCalledWith(ENV, KEY, "owner-1");
	});

	it("lets the owning reconciler rebroadcast its reserved raw transaction", async () => {
		mocks.getSignerBlockingAccountOperation.mockResolvedValue({ id: "operation-1" });

		await expect(withSignerLease(
			ENV,
			{ chainId: 421614, signerAddress: ADDRESS, operationId: "operation-1" },
			async () => "rebroadcast",
		)).resolves.toBe("rebroadcast");
	});

	it("rejects overlapping signer work without running the second action", async () => {
		let held = false;
		let finishFirst!: () => void;
		mocks.acquireLease.mockImplementation(async () => {
			if (held) return null;
			held = true;
			return "owner-1";
		});
		mocks.releaseLease.mockImplementation(async () => {
			held = false;
		});
		const first = withSignerLease(
			ENV,
			{ chainId: 421614, signerAddress: ADDRESS },
			() => new Promise<void>((resolve) => { finishFirst = resolve; }),
		);
		await vi.waitFor(() => expect(held).toBe(true));
		const secondAction = vi.fn(async () => undefined);

		await expect(withSignerLease(
			ENV,
			{ chainId: 421614, signerAddress: ADDRESS },
			secondAction,
		)).rejects.toBeInstanceOf(SignerLeaseBusyError);
		expect(secondAction).not.toHaveBeenCalled();

		finishFirst();
		await first;
		expect(held).toBe(false);
	});
});
