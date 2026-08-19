import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	first: vi.fn(),
	run: vi.fn(),
	logInfo: vi.fn(),
}));

vi.mock("../src/middlewares/auth", () => ({
	requireAuth: (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
		c.set("user", { sub: "card-user" });
		return next();
	},
}));

vi.mock("../src/services/logger", () => ({
	logInfo: mocks.logInfo,
}));

import cardRoutes from "../src/routes/card.routes";

const boundValues: unknown[][] = [];
const ENV = {
	GATOPAGO_DB: {
		prepare: () => {
			const statement = {
				bind: (...values: unknown[]) => {
					boundValues.push(values);
					return statement;
				},
				first: mocks.first,
				run: mocks.run,
			};
			return statement;
		},
	},
};

function request(method: "GET" | "PUT", body?: unknown) {
	return cardRoutes.request(
		"/interest",
		{
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		},
		ENV,
	);
}

describe("card interest routes", () => {
	beforeEach(() => {
		boundValues.length = 0;
		mocks.first.mockReset().mockResolvedValue(null);
		mocks.run.mockReset().mockResolvedValue({ success: true });
		mocks.logInfo.mockReset();
	});

	it("returns an empty interest state for a new user", async () => {
		const response = await request("GET");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ interest: null });
		expect(boundValues).toEqual([["card-user"]]);
	});

	it("maps a stored D1 row to the public response shape", async () => {
		mocks.first.mockResolvedValue({
			country: "Bolivia",
			use_case: "online",
			monthly_spend: "100-500",
			card_preference: "virtual",
			wallet_pay_importance: "important",
			updated_at: "2026-08-18T00:00:00.000Z",
		});

		const response = await request("GET");

		expect(await response.json()).toEqual({
			interest: {
				country: "Bolivia",
				useCase: "online",
				monthlySpend: "100-500",
				cardPreference: "virtual",
				walletPayImportance: "important",
				updatedAt: "2026-08-18T00:00:00.000Z",
			},
		});
	});

	it("rejects incomplete or non-allowlisted answers before writing", async () => {
		const response = await request("PUT", {
			country: "B",
			useCase: "anything",
			monthlySpend: "100-500",
			cardPreference: "virtual",
			walletPayImportance: "important",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error_code: "INVALID_PROFILE" });
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("trims, persists and returns a valid interest submission", async () => {
		const response = await request("PUT", {
			country: "  Bolivia  ",
			useCase: "online",
			monthlySpend: "100-500",
			cardPreference: "both",
			walletPayImportance: "essential",
		});
		const body = await response.json() as { interest: Record<string, string> };

		expect(response.status).toBe(200);
		expect(body.interest).toMatchObject({
			country: "Bolivia",
			useCase: "online",
			monthlySpend: "100-500",
			cardPreference: "both",
			walletPayImportance: "essential",
		});
		expect(boundValues).toHaveLength(1);
		expect(boundValues[0]?.slice(0, 6)).toEqual([
			"card-user",
			"Bolivia",
			"online",
			"100-500",
			"both",
			"essential",
		]);
		expect(mocks.run).toHaveBeenCalledOnce();
		expect(mocks.logInfo).toHaveBeenCalledWith("card_interest_saved", expect.objectContaining({ uid: "card-user" }));
	});
});
