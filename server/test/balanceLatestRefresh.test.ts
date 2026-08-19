import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { Bindings } from "../src/middlewares/auth";

const mocks = vi.hoisted(() => ({
	getBlock: vi.fn(),
	multicall: vi.fn(),
}));

vi.mock("../src/services/clients", () => ({
	getPublicClient: () => ({
		chain: {
			contracts: {
				multicall3: {
					address: "0xca11bde05977b3631167028862be2a173976ca11",
				},
			},
		},
		getBlock: mocks.getBlock,
		multicall: mocks.multicall,
	}),
}));

import { refreshWalletBalancesLatestBatch } from "../src/services/balanceReconciler";

describe("latest balance refresh batching", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getBlock
			.mockResolvedValueOnce({
				number: 1000n,
				hash: `0x${"aa".repeat(32)}`,
			})
			.mockResolvedValueOnce({
				number: 1000n,
				hash: `0x${"aa".repeat(32)}`,
			});
		mocks.multicall.mockImplementation(
			async ({ contracts }: { contracts: unknown[] }) =>
				contracts.map((_, index) => ({
					status: "success",
					result: BigInt(index + 1),
				})),
		);
	});

	it("reads sender and recipient in one RPC Multicall and one D1 batch", async () => {
		const bind = vi.fn((...values: unknown[]) => ({ values }));
		const prepare = vi.fn(() => ({ bind }));
		const batch = vi.fn(async (statements: unknown[]) =>
			statements.map(() => ({ meta: { changes: 1 } })),
		);
		const env = {
			CHAIN_KEY: "arbitrum-sepolia",
			GATOPAGO_DB: { prepare, batch },
		} as unknown as Bindings;
		const sender =
			"0x1111111111111111111111111111111111111111" as Address;
		const recipient =
			"0x2222222222222222222222222222222222222222" as Address;

		const snapshots = await refreshWalletBalancesLatestBatch(env, [
			{
				uid: "sender",
				accountAddress: sender,
				chainId: 421614,
				notBeforeBlock: "999",
			},
			{
				uid: "recipient",
				accountAddress: recipient,
				chainId: 421614,
				notBeforeBlock: "999",
			},
		]);

		expect(mocks.multicall).toHaveBeenCalledOnce();
		const contracts = mocks.multicall.mock.calls[0][0].contracts as Array<{
			args?: Address[];
		}>;
		expect(contracts.some((call) => call.args?.[0] === sender)).toBe(true);
		expect(contracts.some((call) => call.args?.[0] === recipient)).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.uid === "sender")).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.uid === "recipient")).toBe(
			true,
		);
		expect(batch).toHaveBeenCalledOnce();
		expect(batch.mock.calls[0][0]).toHaveLength(snapshots.length);
	});
});
