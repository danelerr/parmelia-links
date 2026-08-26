import { describe, expect, it } from "vitest";
import { paymentsBootstrapState } from "../src/services/bootstrap";

describe("Payments bootstrap gate", () => {
	it("fails closed when the setting is missing or malformed", () => {
		expect(paymentsBootstrapState({})).toEqual({
			active: true,
			configuredValue: null,
			valid: true,
		});
		expect(paymentsBootstrapState({ PAYMENTS_BOOTSTRAP_MODE: "flase" })).toEqual({
			active: true,
			configuredValue: "flase",
			valid: false,
		});
	});

	it("requires an explicit false value to activate Payments writes", () => {
		expect(paymentsBootstrapState({ PAYMENTS_BOOTSTRAP_MODE: "true" }).active).toBe(true);
		expect(paymentsBootstrapState({ PAYMENTS_BOOTSTRAP_MODE: "false" })).toEqual({
			active: false,
			configuredValue: "false",
			valid: true,
		});
	});
});
