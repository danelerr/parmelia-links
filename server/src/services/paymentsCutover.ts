import type { Bindings } from "../middlewares/auth";

const PAYMENTS_CUTOVER_MODES = ["legacy", "frozen", "payments"] as const;
export type PaymentsCutoverMode = (typeof PAYMENTS_CUTOVER_MODES)[number];

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PAYMENT_BOUNDARY_PREFIXES = ["/links", "/checkout", "/v1", "/merchant"];
const PROXIED_PAYMENT_PREFIXES = ["/links", "/checkout", "/v1", "/merchant"];

function hasPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export type PaymentsCutoverState = {
	mode: PaymentsCutoverMode;
	configuredValue: string | null;
	valid: boolean;
};

/**
 * Missing configuration preserves the pre-split behavior. An unknown value
 * fails closed as `frozen` so a typo can never enable payment writes.
 */
export function paymentsCutoverState(env: Pick<Bindings, "PAYMENTS_CUTOVER_MODE">): PaymentsCutoverState {
	const configuredValue = env.PAYMENTS_CUTOVER_MODE?.trim().toLowerCase() || null;
	if (configuredValue === null) return { mode: "legacy", configuredValue, valid: true };
	if ((PAYMENTS_CUTOVER_MODES as readonly string[]).includes(configuredValue)) {
		return { mode: configuredValue as PaymentsCutoverMode, configuredValue, valid: true };
	}
	return { mode: "frozen", configuredValue, valid: false };
}

export type PaymentsCutoverAction = "app" | "proxy" | "block_write";

export type PaymentLinkPrepareAction = "legacy" | "payments" | "block";

/**
 * `/pay` is an App-owned account-abstraction endpoint. Only preparation for a
 * stored checkout link changes owner during cutover; personal transfers must
 * remain available in every mode.
 */
export function paymentLinkPrepareAction(mode: PaymentsCutoverMode): PaymentLinkPrepareAction {
	if (mode === "frozen") return "block";
	return mode === "payments" ? "payments" : "legacy";
}

/**
 * Each checkout generation may submit only while its database owns writes: a
 * legacy link in `legacy`, or a Payments attempt in `payments`. Frozen and
 * cross-generation submissions fail closed. Personal operations have neither
 * marker and continue normally.
 */
export function paymentSubmissionBlocked(input: {
	mode: PaymentsCutoverMode;
	hasLegacyLink: boolean;
	hasPaymentAttempt: boolean;
}): boolean {
	if (!input.hasLegacyLink && !input.hasPaymentAttempt) return false;
	if (input.hasPaymentAttempt) return input.mode !== "payments";
	return input.mode !== "legacy";
}

export function paymentsCutoverAction(input: {
	mode: PaymentsCutoverMode;
	method: string;
	pathname: string;
}): PaymentsCutoverAction {
	const paymentPath = PAYMENT_BOUNDARY_PREFIXES.some((prefix) => hasPrefix(input.pathname, prefix));
	if (!paymentPath) return "app";
	if (input.mode === "frozen" && MUTATING_METHODS.has(input.method.toUpperCase())) return "block_write";
	if (input.mode === "payments" && PROXIED_PAYMENT_PREFIXES.some((prefix) => hasPrefix(input.pathname, prefix))) {
		return "proxy";
	}
	return "app";
}
