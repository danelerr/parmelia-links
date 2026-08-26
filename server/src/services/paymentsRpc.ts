import type {
	ReservedAppPaymentAttempt,
	RpcResult,
	SettlementAccountCommand,
	PaymentsRpcService,
} from "../../../shared/paymentContracts";
import { getNetworkConfig } from "../../../shared/networks";
import type { Bindings } from "../env";
import { scheduleEventJob } from "./eventScheduler";
import { logError, logInfo, logWarn } from "./logger";
import { paymentsCutoverState } from "./paymentsCutover";

export type PaymentsBoundarySyncState = {
	enabled: boolean;
	configuredValue: string | null;
	valid: boolean;
};

/**
 * Boundary sync is opt-in and cannot run in legacy mode. This keeps migration
 * 0033's seeded outbox inert until the Payments import has completed.
 */
export function paymentsBoundarySyncState(
	env: Pick<Bindings, "PAYMENTS_SYNC_ENABLED" | "PAYMENTS_CUTOVER_MODE">,
): PaymentsBoundarySyncState {
	const configuredValue = env.PAYMENTS_SYNC_ENABLED?.trim().toLowerCase() || null;
	if (configuredValue === null || configuredValue === "false") {
		return { enabled: false, configuredValue, valid: true };
	}
	if (configuredValue !== "true") {
		return { enabled: false, configuredValue, valid: false };
	}
	const cutover = paymentsCutoverState(env);
	if (!cutover.valid || cutover.mode === "legacy") {
		return { enabled: false, configuredValue, valid: false };
	}
	return { enabled: true, configuredValue, valid: true };
}

function service(env: Bindings): (Fetcher & PaymentsRpcService) | null {
	// Wrangler generates Service Bindings as Fetcher even when the target is a
	// WorkerEntrypoint with RPC methods. Keep that runtime limitation isolated at
	// this one boundary; method signatures still come from the shared contract.
	return (env.PAYMENTS as (Fetcher & PaymentsRpcService) | undefined) ?? null;
}

export async function reserveAppPaymentAttempt(env: Bindings, input: {
	commandId: string; requestId: string; uid: string; linkId: string; payerAddress: string;
	amount?: string;
}): Promise<RpcResult<ReservedAppPaymentAttempt>> {
	const binding = service(env);
	if (!binding) return { ok: false, contractVersion: 2, error: "UNAVAILABLE", message: "Payments service binding is unavailable" };
	return binding.reserveAppPaymentAttempt({ contractVersion: 2, commandId: input.commandId,
		claim: { service: "gatopago-app-api", requestId: input.requestId, uid: input.uid },
		linkId: input.linkId, payerAddress: input.payerAddress,
		sourceChainId: getNetworkConfig(env.CHAIN_KEY).chainId, requestedRoute: "local",
		amount: input.amount });
}

async function sendSettlementAccount(env: Bindings, input: {
	uid: string; walletAddress: string; accountVersion: number; requestId: string;
}): Promise<boolean> {
	const binding = service(env);
	if (!binding) return false;
	const command: SettlementAccountCommand = { contractVersion: 2,
		commandId: `account:${input.uid}:${input.accountVersion}`,
		claim: { service: "gatopago-app-api", requestId: input.requestId, uid: input.uid },
		accountVersion: input.accountVersion, walletAddress: input.walletAddress,
		chainId: getNetworkConfig(env.CHAIN_KEY).chainId };
	const result = await binding.upsertSettlementAccount(command);
	return result.ok;
}

async function sendExecution(env: Bindings, input: {
	uid: string; paymentAttemptId: string; userOpHash: string; requestId: string;
}): Promise<boolean> {
	const binding = service(env);
	if (!binding) return false;
	const result = await binding.registerAppPaymentExecution({ contractVersion: 2,
		commandId: `execution:${input.paymentAttemptId}:${input.userOpHash.toLowerCase()}`,
		claim: { service: "gatopago-app-api", requestId: input.requestId, uid: input.uid },
		attemptId: input.paymentAttemptId, userOpHash: input.userOpHash,
		sourceChainId: getNetworkConfig(env.CHAIN_KEY).chainId });
	return result.ok;
}

export async function wakePaymentsSync(env: Bindings, reason: string): Promise<void> {
	if (!paymentsBoundarySyncState(env).enabled) return;
	await scheduleEventJob(env, "payments_boundary_sync", { delayMs: 0, reason });
}

export async function drainPaymentsBoundaryOutbox(env: Bindings, limit = 20): Promise<void> {
	if (!paymentsBoundarySyncState(env).enabled) return;
	if (!service(env)) return;
	const accounts = await env.GATOPAGO_DB.prepare(
		"SELECT uid, wallet_address, account_version, attempt_count FROM payment_account_sync_outbox WHERE status IN ('pending','failed') AND next_attempt_at <= ? ORDER BY updated_at LIMIT ?",
	).bind(new Date().toISOString(), limit).all<{ uid: string; wallet_address: string; account_version: number; attempt_count: number }>();
	for (const row of accounts.results) {
		try {
			if (!(await sendSettlementAccount(env, { uid: row.uid, walletAddress: row.wallet_address,
				accountVersion: row.account_version, requestId: crypto.randomUUID() }))) throw new Error("Payments rejected settlement account command");
			await env.GATOPAGO_DB.prepare("DELETE FROM payment_account_sync_outbox WHERE uid = ? AND account_version <= ?").bind(row.uid, row.account_version).run();
		} catch (error) {
			const attempt = row.attempt_count + 1;
			await env.GATOPAGO_DB.prepare("UPDATE payment_account_sync_outbox SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE uid = ?")
				.bind(attempt, new Date(Date.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(attempt, 7))).toISOString(),
					error instanceof Error ? error.message.slice(0, 300) : "sync failed", new Date().toISOString(), row.uid).run();
			logError("payments_account_sync_failed", error, { uid: row.uid, attempt });
		}
	}

	const executions = await env.GATOPAGO_DB.prepare(
		"SELECT payment_attempt_id, uid, user_op_hash, attempt_count FROM payment_execution_sync_outbox WHERE status IN ('pending','failed') AND next_attempt_at <= ? ORDER BY updated_at LIMIT ?",
	).bind(new Date().toISOString(), limit).all<{ payment_attempt_id: string; uid: string; user_op_hash: string; attempt_count: number }>();
	for (const row of executions.results) {
		try {
			if (!(await sendExecution(env, { uid: row.uid, paymentAttemptId: row.payment_attempt_id,
				userOpHash: row.user_op_hash, requestId: crypto.randomUUID() }))) throw new Error("Payments rejected execution command");
			await env.GATOPAGO_DB.prepare("DELETE FROM payment_execution_sync_outbox WHERE payment_attempt_id = ?").bind(row.payment_attempt_id).run();
		} catch (error) {
			const attempt = row.attempt_count + 1;
			await env.GATOPAGO_DB.prepare("UPDATE payment_execution_sync_outbox SET status = 'failed', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE payment_attempt_id = ?")
				.bind(attempt, new Date(Date.now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(attempt, 7))).toISOString(),
					error instanceof Error ? error.message.slice(0, 300) : "sync failed", new Date().toISOString(), row.payment_attempt_id).run();
			logError("payments_execution_sync_failed", error, { paymentAttemptId: row.payment_attempt_id, attempt });
		}
	}
	if (accounts.results.length + executions.results.length > 0) logInfo("payments_boundary_outbox_drained", { accounts: accounts.results.length, executions: executions.results.length });
}

export async function proxyPaymentsRequest(env: Bindings, request: Request): Promise<Response> {
	const binding = service(env);
	if (!binding) return Response.json({ error: "Payments service unavailable", error_code: "SERVICE_UNAVAILABLE" }, { status: 503 });
	try { return await binding.fetch(request); }
	catch (error) {
		logWarn("payments_proxy_unavailable", { path: new URL(request.url).pathname,
			reason: error instanceof Error ? error.message : "unknown" });
		return Response.json({ error: "Payments service unavailable", error_code: "SERVICE_UNAVAILABLE" }, { status: 503 });
	}
}
