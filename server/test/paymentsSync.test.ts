import { describe, expect, it } from "vitest";
import { paymentsBoundarySyncState } from "../src/services/paymentsRpc";

describe("Payments boundary sync bootstrap", () => {
	it("is inert by default and while explicitly disabled", () => {
		expect(paymentsBoundarySyncState({})).toEqual({
			enabled: false,
			configuredValue: null,
			valid: true,
		});
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "frozen",
			PAYMENTS_SYNC_ENABLED: "false",
		})).toEqual({ enabled: false, configuredValue: "false", valid: true });
	});

	it("allows sync only after leaving legacy mode", () => {
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "legacy",
			PAYMENTS_SYNC_ENABLED: "true",
		})).toEqual({ enabled: false, configuredValue: "true", valid: false });
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "frozen",
			PAYMENTS_SYNC_ENABLED: "true",
		})).toEqual({ enabled: true, configuredValue: "true", valid: true });
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "payments",
			PAYMENTS_SYNC_ENABLED: "true",
		})).toEqual({ enabled: true, configuredValue: "true", valid: true });
	});

	it("fails closed on malformed sync or cutover configuration", () => {
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "payments",
			PAYMENTS_SYNC_ENABLED: "tru",
		}).valid).toBe(false);
		expect(paymentsBoundarySyncState({
			PAYMENTS_CUTOVER_MODE: "paymets",
			PAYMENTS_SYNC_ENABLED: "true",
		}).valid).toBe(false);
	});
});
