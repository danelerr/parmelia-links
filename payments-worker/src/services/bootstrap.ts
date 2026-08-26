import type { Bindings } from "../env";

export type PaymentsBootstrapState = {
	active: boolean;
	configuredValue: string | null;
	valid: boolean;
};

/**
 * Missing or invalid configuration fails closed. The first deployment can be
 * inspected and loaded, but cannot accept writes, RPC commands or background
 * work until the operator explicitly sets the flag to false after import.
 */
export function paymentsBootstrapState(
	env: Pick<Bindings, "PAYMENTS_BOOTSTRAP_MODE">,
): PaymentsBootstrapState {
	const configuredValue = env.PAYMENTS_BOOTSTRAP_MODE?.trim().toLowerCase() || null;
	if (configuredValue === "false") {
		return { active: false, configuredValue, valid: true };
	}
	if (configuredValue === "true" || configuredValue === null) {
		return { active: true, configuredValue, valid: true };
	}
	return { active: true, configuredValue, valid: false };
}
