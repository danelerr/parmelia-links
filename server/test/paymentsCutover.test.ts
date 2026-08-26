import { describe, expect, it } from "vitest";
import {
	paymentLinkPrepareAction,
	paymentSubmissionBlocked,
	paymentsCutoverAction,
	paymentsCutoverState,
} from "../src/services/paymentsCutover";

describe("Payments cutover control", () => {
	it("preserves legacy behavior when the setting is absent", () => {
		expect(paymentsCutoverState({})).toEqual({
			mode: "legacy",
			configuredValue: null,
			valid: true,
		});
	});

	it("fails closed on an unknown setting", () => {
		expect(paymentsCutoverState({ PAYMENTS_CUTOVER_MODE: "paymets" })).toEqual({
			mode: "frozen",
			configuredValue: "paymets",
			valid: false,
		});
	});

	it("blocks payment writes but keeps reads available while frozen", () => {
		expect(paymentsCutoverAction({ mode: "frozen", method: "POST", pathname: "/v1/payment_intents" }))
			.toBe("block_write");
		expect(paymentsCutoverAction({ mode: "frozen", method: "DELETE", pathname: "/merchant/keys/key_1" }))
			.toBe("block_write");
		expect(paymentsCutoverAction({ mode: "frozen", method: "GET", pathname: "/links/link_1" }))
			.toBe("app");
		expect(paymentsCutoverAction({ mode: "frozen", method: "POST", pathname: "/pay/submit" }))
			.toBe("app");
		expect(paymentsCutoverAction({ mode: "frozen", method: "POST", pathname: "/crosschain/prepare" }))
			.toBe("app");
	});

	it("delegates the extracted HTTP surfaces only after the payments switch", () => {
		expect(paymentsCutoverAction({ mode: "payments", method: "POST", pathname: "/checkout/link_1/attempts" }))
			.toBe("proxy");
		expect(paymentsCutoverAction({ mode: "payments", method: "POST", pathname: "/pay/submit" }))
			.toBe("app");
		expect(paymentsCutoverAction({ mode: "payments", method: "POST", pathname: "/crosschain/prepare" }))
			.toBe("app");
		expect(paymentsCutoverAction({ mode: "payments", method: "POST", pathname: "/swap/prepare" }))
			.toBe("app");
	});

	it("switches only stored-link preparation while personal payments stay in App", () => {
		expect(paymentLinkPrepareAction("legacy")).toBe("legacy");
		expect(paymentLinkPrepareAction("frozen")).toBe("block");
		expect(paymentLinkPrepareAction("payments")).toBe("payments");
	});

	it("blocks checkout submissions during the freeze and rejects stale legacy preparations", () => {
		expect(paymentSubmissionBlocked({ mode: "frozen", hasLegacyLink: true, hasPaymentAttempt: false })).toBe(true);
		expect(paymentSubmissionBlocked({ mode: "frozen", hasLegacyLink: false, hasPaymentAttempt: true })).toBe(true);
		expect(paymentSubmissionBlocked({ mode: "payments", hasLegacyLink: true, hasPaymentAttempt: false })).toBe(true);
		expect(paymentSubmissionBlocked({ mode: "payments", hasLegacyLink: false, hasPaymentAttempt: true })).toBe(false);
		expect(paymentSubmissionBlocked({ mode: "legacy", hasLegacyLink: true, hasPaymentAttempt: false })).toBe(false);
		expect(paymentSubmissionBlocked({ mode: "legacy", hasLegacyLink: false, hasPaymentAttempt: true })).toBe(true);
		expect(paymentSubmissionBlocked({ mode: "frozen", hasLegacyLink: false, hasPaymentAttempt: false })).toBe(false);
	});
});
