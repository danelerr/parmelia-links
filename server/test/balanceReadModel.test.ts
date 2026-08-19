import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	__test,
	requestBalanceRefresh,
	requestBalanceRefreshBatch,
} from "../src/services/balanceReadModel";

describe("balance refresh event coalescing", () => {
	it("turns 1,000 equivalent Home refreshes into one scheduler wake", async () => {
		const run = vi
			.fn()
			.mockResolvedValueOnce({ meta: { changes: 1 } })
			.mockResolvedValue({ meta: { changes: 0 } });
		const bind = vi.fn(() => ({ run }));
		const prepare = vi.fn(() => ({ bind }));
		const schedule = vi.fn().mockResolvedValue({
			accepted: true,
			changed: true,
		});
		const env = {
			CHAIN_KEY: "arbitrum-sepolia",
			GATOPAGO_DB: { prepare },
			EVENT_JOB_SCHEDULER: {
				getByName: vi.fn(() => ({ schedule })),
			},
		} as unknown as Bindings;
		const request = {
			uid: "same-user",
			accountAddress:
				"0x0101010101010101010101010101010101010101" as const,
			chainId: 421614,
			reason: "home_stale",
			priority: 3 as const,
		};

		await Promise.all(
			Array.from({ length: 1_000 }, () =>
				requestBalanceRefresh(env, request),
			),
		);

		expect(run).toHaveBeenCalledTimes(1_000);
		expect(schedule).toHaveBeenCalledOnce();
		expect(schedule.mock.calls[0][0]).toMatchObject({
			job: "balance_refresh",
			partition: "global",
			reason: "balance_refresh_requested",
		});
	});

	it("persists a provider burst in bounded D1 batches and wakes once", async () => {
		const bind = vi.fn(() => ({}));
		const prepare = vi.fn(() => ({ bind }));
		const batch = vi.fn(async (statements: unknown[]) =>
			statements.map(() => ({ meta: { changes: 1 } })),
		);
		const schedule = vi.fn().mockResolvedValue({
			accepted: true,
			changed: true,
		});
		const env = {
			CHAIN_KEY: "arbitrum-sepolia",
			GATOPAGO_DB: { prepare, batch },
			EVENT_JOB_SCHEDULER: {
				getByName: vi.fn(() => ({ schedule })),
			},
		} as unknown as Bindings;
		const requests = Array.from({ length: 250 }, (_, index) => ({
			uid: `user-${index}`,
			accountAddress:
				`0x${index.toString(16).padStart(40, "0")}` as const,
			chainId: 421614,
			reason: "alchemy_address_activity",
			priority: 1 as const,
			notBeforeBlock: "100",
		}));

		await requestBalanceRefreshBatch(env, requests);

		expect(batch.mock.calls.map(([statements]) => statements.length)).toEqual([
			100,
			100,
			50,
		]);
		expect(schedule).toHaveBeenCalledOnce();
	});

	it("does not let a later safety block delay an urgent confirmed refresh", () => {
		const address =
			"0x0101010101010101010101010101010101010101" as const;
		const safety = {
			schemaVersion: 1 as const,
			idempotencyKey: `421614:${address}`,
			uid: "same-user",
			accountAddress: address,
			chainId: 421614,
			reason: "autonomous_indexer_safety",
			priority: 1 as const,
			notBeforeBlock: "2000",
		};
		const confirmed = {
			...safety,
			reason: "confirmed_user_operation",
			priority: 0 as const,
			notBeforeBlock: "1000",
		};

		expect(
			__test.coalesceBalanceRefreshMessages(safety, confirmed),
		).toEqual(confirmed);
		expect(
			__test.coalesceBalanceRefreshMessages(confirmed, {
				...safety,
				notBeforeBlock: "3000",
			}),
		).toEqual(confirmed);
	});
});
