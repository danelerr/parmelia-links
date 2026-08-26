import type { Bindings } from "../env";
import { paymentMigrationControl, type PaymentMigrationControl } from "../stores/opsStore";
import { paymentsBootstrapState, type PaymentsBootstrapState } from "./bootstrap";

const SHA256_HEX = /^[0-9a-f]{64}$/u;

type PaymentsDataCutoverReason =
	| "configured_checksum_pending"
	| "configured_checksum_invalid"
	| "migration_control_unavailable"
	| "migration_control_missing"
	| "migration_incomplete"
	| "migration_checksum_invalid"
	| "migration_checksum_mismatch"
	| "verified";

export type PaymentsDataCutoverState = {
	ready: boolean;
	status: "verified" | "pending" | "invalid";
	configValid: boolean;
	databaseValid: boolean;
	reason: PaymentsDataCutoverReason;
};

function normalizeChecksum(value: string | undefined): string | null {
	return value?.trim().toLowerCase() || null;
}

/**
 * Classify the immutable import proof without returning any checksum. Public
 * health can therefore explain readiness without disclosing deployment data.
 */
export function classifyPaymentsDataCutover(
	configuredChecksum: string | undefined,
	control: PaymentMigrationControl | null,
): PaymentsDataCutoverState {
	const expected = normalizeChecksum(configuredChecksum);
	if (expected === "pending") {
		return { ready: false, status: "pending", configValid: true, databaseValid: false,
			reason: "configured_checksum_pending" };
	}
	if (!expected || !SHA256_HEX.test(expected)) {
		return { ready: false, status: "invalid", configValid: false, databaseValid: false,
			reason: "configured_checksum_invalid" };
	}
	if (!control) {
		return { ready: false, status: "invalid", configValid: true, databaseValid: true,
			reason: "migration_control_missing" };
	}
	const completedAt = typeof control.legacy_copy_completed_at === "string"
		? control.legacy_copy_completed_at.trim() : "";
	if (control.legacy_copy_version !== 1 || !completedAt) {
		return { ready: false, status: "pending", configValid: true, databaseValid: true,
			reason: "migration_incomplete" };
	}
	const source = typeof control.legacy_source_checksum === "string"
		? control.legacy_source_checksum.trim().toLowerCase() : "";
	const target = typeof control.legacy_target_checksum === "string"
		? control.legacy_target_checksum.trim().toLowerCase() : "";
	if (!SHA256_HEX.test(source) || !SHA256_HEX.test(target)) {
		return { ready: false, status: "invalid", configValid: true, databaseValid: true,
			reason: "migration_checksum_invalid" };
	}
	if (source !== target || source !== expected) {
		return { ready: false, status: "invalid", configValid: true, databaseValid: true,
			reason: "migration_checksum_mismatch" };
	}
	return { ready: true, status: "verified", configValid: true, databaseValid: true,
		reason: "verified" };
}

export async function paymentsDataCutoverState(
	env: Pick<Bindings, "PAYMENTS_DB" | "PAYMENTS_DATA_CUTOVER_CHECKSUM">,
): Promise<PaymentsDataCutoverState> {
	const configured = classifyPaymentsDataCutover(env.PAYMENTS_DATA_CUTOVER_CHECKSUM, null);
	if (!configured.configValid || configured.reason === "configured_checksum_pending") return configured;
	try {
		const control = await paymentMigrationControl(env);
		return classifyPaymentsDataCutover(env.PAYMENTS_DATA_CUTOVER_CHECKSUM, control);
	} catch {
		return { ready: false, status: "invalid", configValid: true, databaseValid: false,
			reason: "migration_control_unavailable" };
	}
}

export type PaymentsWriteAvailability = {
	available: boolean;
	bootstrap: PaymentsBootstrapState;
	dataCutover: PaymentsDataCutoverState | null;
	reason: "ready" | "bootstrap_active" | "bootstrap_invalid" | PaymentsDataCutoverReason;
};

/** Writes remain blocked unless both independent gates are open. */
export async function paymentsWriteAvailability(env: Bindings): Promise<PaymentsWriteAvailability> {
	const bootstrap = paymentsBootstrapState(env);
	if (!bootstrap.valid) {
		return { available: false, bootstrap, dataCutover: null, reason: "bootstrap_invalid" };
	}
	if (bootstrap.active) {
		return { available: false, bootstrap, dataCutover: null, reason: "bootstrap_active" };
	}
	const dataCutover = await paymentsDataCutoverState(env);
	return { available: dataCutover.ready, bootstrap, dataCutover,
		reason: dataCutover.ready ? "ready" : dataCutover.reason };
}
