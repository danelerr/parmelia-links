import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import { sweepTerminalPendingPayments } from "../src/services/storage";

describe("pending payment cleanup", () => {
	it("removes expired unsubmitted preparations without shortening terminal retention", async () => {
		let statement = "";
		let bindings: unknown[] = [];
		const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
		const env = {
			GATOPAGO_DB: {
				prepare: vi.fn((sql: string) => {
					statement = sql;
					return {
						bind: (...values: unknown[]) => {
							bindings = values;
							return { run };
						},
					};
				}),
			},
		} as unknown as Bindings;

		await sweepTerminalPendingPayments(env);

		expect(statement).toContain("status = 'prepared' AND expires_at <= ?");
		expect(statement).toContain(
			"status IN ('confirmed', 'failed') AND expires_at <= ?",
		);
		expect(bindings).toHaveLength(2);
		expect(Date.parse(String(bindings[0]))).toBeGreaterThan(
			Date.parse(String(bindings[1])),
		);
		expect(run).toHaveBeenCalledOnce();
	});
});
