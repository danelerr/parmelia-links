import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listUserChainAccounts: vi.fn(),
	listUserChainBalanceSnapshots: vi.fn(),
	requestBalanceRefreshBatch: vi.fn(),
}));

vi.mock("../src/middlewares/auth", () => ({
	requireAuth: (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("user", { sub: "portfolio-user" });
		return next();
	},
}));

vi.mock("../src/services/storage", () => ({
	listUserChainAccounts: mocks.listUserChainAccounts,
	listUserChainBalanceSnapshots: mocks.listUserChainBalanceSnapshots,
}));

vi.mock("../src/services/balanceReadModel", () => ({
	requestBalanceRefreshBatch: mocks.requestBalanceRefreshBatch,
}));

import accountRoutes from "../src/routes/account.routes";

const NOW = "2026-08-31T02:00:00.000Z";
const HOME = "0x1111111111111111111111111111111111111111";
const FUJI = "0x2222222222222222222222222222222222222222";
const ENV = {
	CHAIN_KEY: "arbitrum-sepolia",
	APP_ENABLED_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
	RPC_READ_URLS: "https://arb.example",
	RPC_WRITE_URLS: "https://arb.example",
	APP_CHAIN_RPC_URLS: JSON.stringify({ "43113": "https://fuji.example" }),
	BALANCE_MAX_STALENESS_SECONDS: "300",
};

function account(chainId: number, chainKey: string, walletAddress: string, isHome: boolean) {
	return {
		uid: "portfolio-user",
		chainId,
		chainKey,
		networkName: isHome ? "Arbitrum Sepolia" : "Avalanche Fuji",
		walletAddress,
		isHome,
		status: "active",
		securityStatus: "current",
		securityVersionApplied: 1,
		securityVersionDesired: 1,
		deploymentTxHash: null,
		createdAt: NOW,
		updatedAt: NOW,
		activatedAt: NOW,
	};
}

describe("GET /chains", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listUserChainAccounts.mockResolvedValue([
			account(421614, "arbitrum-sepolia", HOME, true),
			account(43113, "avalanche-fuji", FUJI, false),
		]);
		mocks.listUserChainBalanceSnapshots.mockResolvedValue([]);
		mocks.requestBalanceRefreshBatch.mockResolvedValue([]);
	});

	it("returns explicit assets and refreshes active accounts even when execution is paused", async () => {
		const pending: Promise<unknown>[] = [];
		const executionCtx = {
			props: {},
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
			passThroughOnException() {},
		};
		const response = await accountRoutes.request(
			"/chains",
			{ method: "GET" },
			ENV,
			executionCtx,
		);
		await Promise.all(pending);
		const body = await response.json() as {
			chains: Array<{
				key: string;
				walletRailEnabled: boolean;
				balance: { assets: Array<{ symbol: string; status: string; value: string | null }> };
			}>;
		};

		expect(response.status).toBe(200);
		expect(body.chains.find((chain) => chain.key === "avalanche-fuji")).toMatchObject({
			walletRailEnabled: false,
			balance: {
				assets: [
					{ symbol: "AVAX", status: "unavailable", value: null },
					{ symbol: "USDC", status: "unavailable", value: null },
				],
			},
		});
		expect(mocks.requestBalanceRefreshBatch).toHaveBeenCalledOnce();
		expect(mocks.requestBalanceRefreshBatch.mock.calls[0][1]).toEqual([
			{
				chainId: 421614,
				accountAddress: HOME,
				uid: "portfolio-user",
				reason: "portfolio_snapshot_stale",
				priority: 3,
			},
			{
				chainId: 43113,
				accountAddress: FUJI,
				uid: "portfolio-user",
				reason: "portfolio_snapshot_stale",
				priority: 3,
			},
		]);
	});
});
