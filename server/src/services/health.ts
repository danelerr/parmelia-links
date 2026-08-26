import type { Bindings } from "../middlewares/auth";
import { hasAccountOperationNeedsReview } from "./storage";
import { recoverEventJobs } from "./eventJobs";
import { logError } from "./logger";
import { getOperationalHealth, type OperationalHealthSummary } from "./operationalHealth";
import { getRpcUrls } from "./clients";
import { getRpcHealthSummary, type RpcRoleName } from "./rpcControlPlane";
import {
	validateEmailSecurityConfig,
	validateRuntimeConfig,
} from "./runtimeConfig";
import { collectSponsorshipHealth, type SponsorshipHealth } from "./sponsorshipHealth";
import { paymentsCutoverState, type PaymentsCutoverState } from "./paymentsCutover";
import { paymentsBoundarySyncState, type PaymentsBoundarySyncState } from "./paymentsRpc";

type HealthStatus = "ok" | "degraded" | "not_ready";

export type HealthSnapshot = {
	status: HealthStatus;
	network: string | null;
	issues: string[];
	warnings: string[];
	rpc: Awaited<ReturnType<typeof getRpcHealthSummary>>;
	operations: OperationalHealthSummary | null;
	sponsorship: SponsorshipHealth | null;
	paymentsCutover: PaymentsCutoverState;
	paymentsSync: PaymentsBoundarySyncState;
};

export type PublicReadiness = {
	status: HealthStatus;
	network: string | null;
	issueCount: number;
	warningCount: number;
	paymentsCutoverMode: PaymentsCutoverState["mode"];
	paymentsSyncEnabled: boolean;
};

// Cross-request state is limited to throttling an idempotent recovery wakeup;
// it never stores request or user data.
let eventRecoveryLastAttemptAt = 0;

function shouldWakeRecovery(summary: OperationalHealthSummary): boolean {
	return [
		summary.queues.paymentReconcileActive,
		summary.queues.paymentAccountSyncActive,
		summary.queues.paymentExecutionSyncActive,
		summary.queues.userEventActive,
		summary.queues.balanceRefreshActive,
		summary.queues.accountOperationActive,
		summary.queues.indexerRegistryActive,
		summary.queues.providerSubscriptionActive,
		summary.queues.reorgReplayActive,
		summary.queues.indexerActiveShards,
	].some((value) => value > 0);
}

export const __test = { shouldWakeRecovery };

export async function collectHealthSnapshot(
	env: Bindings,
	waitUntil: (promise: Promise<unknown>) => void,
	requestId: string,
): Promise<HealthSnapshot> {
	const issueCodes = validateRuntimeConfig(env).map((entry) => entry.code);
	const warnings: string[] = [];
	if (validateEmailSecurityConfig(env).length > 0) {
		warnings.push("email_security_unconfigured");
	}
	let rpcHealth: HealthSnapshot["rpc"] = [];
	let operationalHealth: OperationalHealthSummary | null = null;
	let sponsorshipHealth: SponsorshipHealth | null = null;
	const paymentsCutover = paymentsCutoverState(env);
	const paymentsSync = paymentsBoundarySyncState(env);
	if (!paymentsCutover.valid) issueCodes.push("payments_cutover_mode_invalid");
	if (!paymentsSync.valid) issueCodes.push("payments_sync_configuration_invalid");
	if (paymentsCutover.mode === "payments" && !paymentsSync.enabled) {
		issueCodes.push("payments_sync_disabled_after_cutover");
	}
	if (paymentsCutover.mode === "frozen" && !paymentsSync.enabled) {
		warnings.push("payments_sync_bootstrap_disabled");
	}
	if (paymentsCutover.mode === "frozen" && paymentsCutover.valid) {
		warnings.push("payments_cutover_frozen");
	}
	if (paymentsCutover.mode === "payments" && !env.PAYMENTS) {
		issueCodes.push("payments_binding_missing");
	}

	try {
		if (await hasAccountOperationNeedsReview(env)) issueCodes.push("signer_nonce_blocked");
		rpcHealth = await getRpcHealthSummary(env);
		const now = Date.now();
		const roles: RpcRoleName[] = ["read", "write", "indexer", "archive", "bundler"];
		for (const role of roles) {
			const configuredCount = getRpcUrls(env, role).length;
			const observed = rpcHealth.filter((entry) => entry.role === role);
			const allConfiguredEndpointsOpen =
				configuredCount > 0 &&
				observed.length >= configuredCount &&
				observed.every(
					(entry) =>
						entry.circuitState === "open" &&
						Boolean(entry.openedUntil && new Date(entry.openedUntil).getTime() > now),
				);
			if (!allConfiguredEndpointsOpen) continue;
			if (
				role === "read" ||
				role === "write" ||
				(role === "bundler" && env.RELAYER_MODE === "bundler")
			) {
				issueCodes.push(`rpc_${role}_unavailable`);
			} else {
				warnings.push(`rpc_${role}_degraded`);
			}
		}

		const operational = await getOperationalHealth(env);
		operationalHealth = operational.summary;
		warnings.push(...operational.warnings);
		if (
			Date.now() - eventRecoveryLastAttemptAt >= 60_000 &&
			shouldWakeRecovery(operational.summary)
		) {
			eventRecoveryLastAttemptAt = Date.now();
			waitUntil(
				recoverEventJobs(env).catch((error) => {
					eventRecoveryLastAttemptAt = 0;
					logError("event_job_recovery_failed", error, { requestId });
				}),
			);
		}
	} catch (error) {
		issueCodes.push("d1_unavailable");
		logError("health_operational_check_failed", error, { requestId });
	}
	try {
		sponsorshipHealth = await collectSponsorshipHealth(env);
		issueCodes.push(...sponsorshipHealth.issues);
	} catch (error) {
		issueCodes.push("sponsorship_health_unavailable");
		logError("sponsorship_health_check_failed", error, { requestId });
	}

	const issues = [...new Set(issueCodes)];
	const uniqueWarnings = [...new Set(warnings)];
	return {
		status: issues.length > 0 ? "not_ready" : uniqueWarnings.length > 0 ? "degraded" : "ok",
		network: env.CHAIN_KEY ?? null,
		issues,
		warnings: uniqueWarnings,
		rpc: rpcHealth,
		operations: operationalHealth,
		sponsorship: sponsorshipHealth,
		paymentsCutover,
		paymentsSync,
	};
}

export function publicReadiness(snapshot: HealthSnapshot): PublicReadiness {
	return {
		status: snapshot.status,
		network: snapshot.network,
		issueCount: snapshot.issues.length,
		warningCount: snapshot.warnings.length,
		paymentsCutoverMode: snapshot.paymentsCutover.mode,
		paymentsSyncEnabled: snapshot.paymentsSync.enabled,
	};
}

export function healthStatusCode(snapshot: HealthSnapshot): 200 | 503 {
	return snapshot.status === "not_ready" ? 503 : 200;
}

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function equalDigest(left: ArrayBuffer, right: ArrayBuffer): boolean {
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	if (leftBytes.byteLength !== rightBytes.byteLength) return false;
	let mismatch = 0;
	for (let index = 0; index < leftBytes.byteLength; index += 1) {
		mismatch |= leftBytes[index] ^ rightBytes[index];
	}
	return mismatch === 0;
}

/** Authenticate the detailed operations endpoint without leaking token length. */
export async function validOpsHealthToken(
	provided: string | undefined,
	expected: string | undefined,
): Promise<boolean> {
	if (!provided || !expected || expected.length < 32) return false;
	const [providedHash, expectedHash] = await Promise.all([sha256(provided), sha256(expected)]);
	return equalDigest(providedHash, expectedHash);
}
