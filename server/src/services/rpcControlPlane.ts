import {
	createTransport,
	http,
	type EIP1193RequestFn,
	type Transport,
} from "viem";
import type { Bindings } from "../middlewares/auth";
import { isTransientRpcError } from "./adaptiveLogs";
import { logError, logInfo, logWarn } from "./logger";
import type { RpcAdmissionController } from "./rpcAdmission";
import type { RpcRoleName } from "./rpcProviders";

export type { RpcRoleName } from "./rpcProviders";
export type RpcLane =
	| "critical-write"
	| "canonical-ingest"
	| "active-reconcile"
	| "maintenance"
	| "backfill";

const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 120_000;
const RATE_LIMIT_CIRCUIT_OPEN_MS = 30_000;
const CIRCUIT_PROBE_LEASE_MS = 15_000;
const CIRCUIT_CACHE_MS = 5_000;

type CircuitRow = {
	circuit_state: "closed" | "open" | "half_open";
	consecutive_failures: number;
	opened_until: string | null;
};

type CircuitSnapshot = {
	state: CircuitRow["circuit_state"];
	consecutiveFailures: number;
	openedUntil: number;
};

function fnv1a(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function providerAliasForUrl(
	value: string,
	role: RpcRoleName,
	slot: number,
): string {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		if (hostname.endsWith(".alchemy.com") || hostname.endsWith(".alchemyapi.io")) {
			return "alchemy";
		}
		if (hostname === "sepolia-rollup.arbitrum.io") {
			return "arbitrum-public-sepolia";
		}
		if (hostname === "arb1.arbitrum.io") {
			return "arbitrum-public-one";
		}
	} catch {
		// Runtime configuration validation reports malformed URLs. Keep any
		// accidental value out of logs in the meantime.
	}
	return `${role}-endpoint-${slot + 1}`;
}

export function laneForRole(role: RpcRoleName): RpcLane {
	if (role === "write" || role === "bundler") return "critical-write";
	if (role === "indexer") return "canonical-ingest";
	if (role === "archive") return "backfill";
	return "active-reconcile";
}

function concurrencyForLane(lane: RpcLane): number {
	if (lane === "critical-write") return 4;
	if (lane === "canonical-ingest") return 4;
	if (lane === "active-reconcile") return 8;
	if (lane === "maintenance") return 2;
	return 1;
}

class LocalSemaphore {
	private active = 0;
	private readonly waiters: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];

	constructor(private readonly maximum: number) {}

	async acquire(waitTimeoutMs: number): Promise<() => void> {
		if (this.active >= this.maximum) {
			await new Promise<void>((resolve, reject) => {
				const waiter = {
					resolve,
					reject,
					timer: setTimeout(() => {
						const index = this.waiters.indexOf(waiter);
						if (index >= 0) this.waiters.splice(index, 1);
						reject(new RpcAdmissionTimeoutError());
					}, waitTimeoutMs),
				};
				this.waiters.push(waiter);
			});
			// The releasing holder transfers its slot directly to this waiter.
			// `active` intentionally remains unchanged during the hand-off.
		} else {
			this.active++;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			if (next) {
				clearTimeout(next.timer);
				next.resolve();
			} else {
				this.active--;
			}
		};
	}
}

export class RpcAdmissionTimeoutError extends Error {
	constructor() {
		super("RPC lane admission deadline exceeded");
		this.name = "RpcAdmissionTimeoutError";
	}
}

export class RpcCircuitOpenError extends Error {
	constructor(
		readonly providerAlias: string,
		readonly lane: RpcLane,
	) {
		super(`RPC circuit is open for ${providerAlias} in ${lane}`);
		this.name = "RpcCircuitOpenError";
	}
}

function failureCode(error: unknown): string {
	const text = error instanceof Error
		? `${error.name} ${error.message}`.toLowerCase()
		: String(error).toLowerCase();
	if (text.includes("429") || text.includes("rate limit")) return "RATE_LIMITED";
	if (text.includes("timeout") || text.includes("timed out")) return "TIMEOUT";
	if (text.includes("503")) return "HTTP_503";
	if (text.includes("502")) return "HTTP_502";
	if (text.includes("fetch failed") || text.includes("network")) return "NETWORK";
	return "RPC_TRANSIENT";
}

function rpcMethodFamily(method: string): string {
	if (method === "eth_getLogs") return "logs";
	if (method.startsWith("eth_getBlock")) return "block";
	if (
		method === "eth_getTransactionReceipt" ||
		method === "eth_getUserOperationReceipt"
	) return "receipt";
	if (method === "eth_call") return "contract_read";
	if (
		method === "eth_estimateGas" ||
		method === "eth_estimateUserOperationGas"
	) return "simulation";
	if (
		method === "eth_sendRawTransaction" ||
		method === "eth_sendTransaction" ||
		method === "eth_sendUserOperation"
	) return "broadcast";
	if (method === "eth_getBalance") return "balance";
	return "other";
}

function failureThreshold(errorCode: string): number {
	// A single 429 is direct provider feedback. Cool that endpoint immediately
	// so fallback traffic does not amplify into a retry storm.
	return errorCode === "RATE_LIMITED" ? 1 : CIRCUIT_FAILURE_THRESHOLD;
}

function circuitOpenMs(errorCode: string): number {
	return errorCode === "RATE_LIMITED"
		? RATE_LIMIT_CIRCUIT_OPEN_MS
		: CIRCUIT_OPEN_MS;
}

function admissionWaitMs(lane: RpcLane, requestTimeoutMs: number): number {
	const laneBudget =
		lane === "backfill"
			? 250
			: lane === "critical-write"
				? 2_000
				: 1_000;
	return Math.max(100, Math.min(laneBudget, Math.floor(requestTimeoutMs / 2)));
}

function admissionLeaseTtlMs(requestTimeoutMs: number): number {
	return Math.max(1_000, Math.min(120_000, requestTimeoutMs + 10_000));
}

type RpcAdmissionStub = DurableObjectStub<RpcAdmissionController>;

async function acquireDistributedAdmission(
	stub: RpcAdmissionStub,
	input: {
		maxConcurrency: number;
		requestTimeoutMs: number;
		waitTimeoutMs: number;
	},
): Promise<string> {
	const deadline = Date.now() + input.waitTimeoutMs;
	for (;;) {
		const result = await stub.acquire({
			maxConcurrency: input.maxConcurrency,
			leaseTtlMs: admissionLeaseTtlMs(input.requestTimeoutMs),
		});
		if (result.granted) return result.token;
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new RpcAdmissionTimeoutError();
		await new Promise<void>((resolve) => {
			setTimeout(resolve, Math.min(result.retryAfterMs, remainingMs));
		});
	}
}

async function readCircuit(
	env: Bindings,
	endpointKey: string,
): Promise<CircuitSnapshot> {
	try {
		const row = await env.PARMELIA_DB.prepare(
			`SELECT circuit_state, consecutive_failures, opened_until
			 FROM rpc_endpoint_health WHERE endpoint_key = ?`,
		)
			.bind(endpointKey)
			.first<CircuitRow>();
		if (!row) {
			return { state: "closed", consecutiveFailures: 0, openedUntil: 0 };
		}
		return {
			state: row.circuit_state,
			consecutiveFailures: row.consecutive_failures,
			openedUntil: row.opened_until
				? new Date(row.opened_until).getTime()
				: 0,
		};
	} catch (error) {
		// RPC availability must not depend on an observability table during an
		// expand-first migration. Mainnet readiness still verifies D1 separately.
		logWarn("rpc_circuit_read_unavailable", {
			errorName: error instanceof Error ? error.name : "unknown",
		});
		return { state: "closed", consecutiveFailures: 0, openedUntil: 0 };
	}
}

async function recordFailure(
	env: Bindings,
	input: {
		endpointKey: string;
		role: RpcRoleName;
		providerAlias: string;
		errorCode: string;
		latencyMs: number;
	},
): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();
	const threshold = failureThreshold(input.errorCode);
	const openedUntil = new Date(
		now.getTime() + circuitOpenMs(input.errorCode),
	).toISOString();
	const opensImmediately = threshold <= 1;
	try {
		await env.PARMELIA_DB.prepare(
			`INSERT INTO rpc_endpoint_health (
				endpoint_key, role, provider_alias, circuit_state,
				consecutive_failures, opened_until, last_success_at,
				last_failure_at, last_error_code, last_latency_ms, updated_at
			 ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)
			 ON CONFLICT(endpoint_key) DO UPDATE SET
			 	role = excluded.role,
			 	provider_alias = excluded.provider_alias,
			 	consecutive_failures = rpc_endpoint_health.consecutive_failures + 1,
			 	circuit_state = CASE
			 		WHEN rpc_endpoint_health.circuit_state = 'half_open'
			 		  OR rpc_endpoint_health.consecutive_failures + 1 >= ?
			 		THEN 'open' ELSE rpc_endpoint_health.circuit_state
			 	END,
			 	opened_until = CASE
			 		WHEN rpc_endpoint_health.circuit_state = 'half_open'
			 		  OR rpc_endpoint_health.consecutive_failures + 1 >= ?
			 		THEN ? ELSE rpc_endpoint_health.opened_until
			 	END,
			 	last_failure_at = excluded.last_failure_at,
			 	last_error_code = excluded.last_error_code,
			 	last_latency_ms = excluded.last_latency_ms,
			 	updated_at = excluded.updated_at`,
		)
			.bind(
				input.endpointKey,
				input.role,
				input.providerAlias,
				opensImmediately ? "open" : "closed",
				opensImmediately ? openedUntil : null,
				nowIso,
				input.errorCode,
				input.latencyMs,
				nowIso,
				threshold,
				threshold,
				openedUntil,
			)
			.run();
	} catch (error) {
		logWarn("rpc_circuit_failure_write_unavailable", {
			errorName: error instanceof Error ? error.name : "unknown",
		});
	}
}

type HalfOpenClaim = "claimed" | "busy" | "unavailable";

async function claimHalfOpenProbe(
	env: Bindings,
	endpointKey: string,
): Promise<HalfOpenClaim> {
	const now = new Date();
	const nowIso = now.toISOString();
	const probeUntil = new Date(
		now.getTime() + CIRCUIT_PROBE_LEASE_MS,
	).toISOString();
	try {
		const result = await env.PARMELIA_DB.prepare(
			`UPDATE rpc_endpoint_health
			 SET circuit_state = 'half_open', opened_until = ?, updated_at = ?
			 WHERE endpoint_key = ?
			   AND circuit_state IN ('open', 'half_open')
			   AND (opened_until IS NULL OR opened_until <= ?)`,
		)
			.bind(probeUntil, nowIso, endpointKey, nowIso)
			.run();
		return (result.meta?.changes ?? 0) > 0 ? "claimed" : "busy";
	} catch (error) {
		logWarn("rpc_half_open_claim_unavailable", {
			errorName: error instanceof Error ? error.name : "unknown",
		});
		return "unavailable";
	}
}

async function recordRecovery(
	env: Bindings,
	input: {
		endpointKey: string;
		role: RpcRoleName;
		providerAlias: string;
		latencyMs: number;
	},
): Promise<void> {
	const now = new Date().toISOString();
	try {
		await env.PARMELIA_DB.prepare(
			`INSERT INTO rpc_endpoint_health (
				endpoint_key, role, provider_alias, circuit_state,
				consecutive_failures, opened_until, last_success_at,
				last_failure_at, last_error_code, last_latency_ms, updated_at
			 ) VALUES (?, ?, ?, 'closed', 0, NULL, ?, NULL, NULL, ?, ?)
			 ON CONFLICT(endpoint_key) DO UPDATE SET
			 	role = excluded.role,
			 	provider_alias = excluded.provider_alias,
			 	circuit_state = 'closed',
			 	consecutive_failures = 0,
			 	opened_until = NULL,
			 	last_success_at = excluded.last_success_at,
			 	last_error_code = NULL,
			 	last_latency_ms = excluded.last_latency_ms,
			 	updated_at = excluded.updated_at`,
		)
			.bind(
				input.endpointKey,
				input.role,
				input.providerAlias,
				now,
				input.latencyMs,
				now,
			)
			.run();
	} catch (error) {
		logWarn("rpc_circuit_recovery_write_unavailable", {
			errorName: error instanceof Error ? error.name : "unknown",
		});
	}
}

export function controlledHttpTransport(
	env: Bindings,
	url: string,
	options: {
		role: RpcRoleName;
		slot: number;
		lane?: RpcLane;
		timeoutMs: number;
		providerAlias?: string;
		maxConcurrency?: number;
	},
): Transport {
	const lane = options.lane ?? laneForRole(options.role);
	const providerAlias =
		options.providerAlias ??
		providerAliasForUrl(url, options.role, options.slot);
	const endpointKey = `${options.role}:${options.slot}:${fnv1a(url)}`;
	const maxConcurrency =
		options.maxConcurrency ?? concurrencyForLane(lane);
	const limiter = new LocalSemaphore(maxConcurrency);
	const distributedAdmission = env.RPC_ADMISSION?.getByName(
		`${endpointKey}:${lane}`,
	);
	const baseFactory = http(url, {
		timeout: options.timeoutMs,
		retryCount: 0,
		maxResponseBodySize: 16 * 1024 * 1024,
		key: `http-${options.role}-${options.slot}`,
		name: providerAlias,
	});
	let cachedCircuit: CircuitSnapshot | null = null;
	let cachedCircuitUntil = 0;

	return (transportOptions) => {
		const base = baseFactory(transportOptions);
		const request = (async (
			rpcRequest: Parameters<EIP1193RequestFn>[0],
			requestOptions?: Parameters<EIP1193RequestFn>[1],
		) => {
			const now = Date.now();
			if (!cachedCircuit || now >= cachedCircuitUntil) {
				cachedCircuit = await readCircuit(env, endpointKey);
				cachedCircuitUntil = now + CIRCUIT_CACHE_MS;
			}
			if (
				(cachedCircuit.state === "open" ||
					cachedCircuit.state === "half_open") &&
				cachedCircuit.openedUntil > now
			) {
				logWarn("rpc_request_rejected_circuit_open", {
					provider: providerAlias,
					providerSlot: options.slot + 1,
					role: options.role,
					lane,
					method: rpcRequest.method,
					methodFamily: rpcMethodFamily(rpcRequest.method),
				});
				throw new RpcCircuitOpenError(providerAlias, lane);
			}
			if (
				cachedCircuit.state === "open" ||
				cachedCircuit.state === "half_open"
			) {
				const claim = await claimHalfOpenProbe(env, endpointKey);
				if (claim === "busy") {
					cachedCircuit = await readCircuit(env, endpointKey);
					cachedCircuitUntil = Date.now() + CIRCUIT_CACHE_MS;
					if (
						(cachedCircuit.state === "open" ||
							cachedCircuit.state === "half_open") &&
						cachedCircuit.openedUntil > Date.now()
					) {
						throw new RpcCircuitOpenError(providerAlias, lane);
					}
				} else if (claim === "claimed") {
					cachedCircuit = {
						state: "half_open",
						consecutiveFailures: cachedCircuit.consecutiveFailures,
						openedUntil: Date.now() + CIRCUIT_PROBE_LEASE_MS,
					};
					cachedCircuitUntil = Date.now() + CIRCUIT_CACHE_MS;
				}
			}

			const waitTimeoutMs = admissionWaitMs(lane, options.timeoutMs);
			let releaseLocal: () => void;
			try {
				releaseLocal = await limiter.acquire(waitTimeoutMs);
			} catch (error) {
				logWarn("rpc_request_rejected_admission", {
					provider: providerAlias,
					providerSlot: options.slot + 1,
					role: options.role,
					lane,
					method: rpcRequest.method,
					methodFamily: rpcMethodFamily(rpcRequest.method),
				});
				throw error;
			}
			let admissionToken: string | null = null;
			try {
				if (distributedAdmission) {
					admissionToken = await acquireDistributedAdmission(
						distributedAdmission,
						{
							maxConcurrency,
							requestTimeoutMs: options.timeoutMs,
							waitTimeoutMs,
						},
					);
				}
			} catch (error) {
				releaseLocal();
				logWarn("rpc_request_rejected_distributed_admission", {
					provider: providerAlias,
					providerSlot: options.slot + 1,
					role: options.role,
					lane,
					method: rpcRequest.method,
					methodFamily: rpcMethodFamily(rpcRequest.method),
					errorName:
						error instanceof Error ? error.name : "unknown",
				});
				throw error;
			}
			const startedAt = Date.now();
			try {
				const result = await base.request(rpcRequest, requestOptions);
				const durationMs = Date.now() - startedAt;
				logInfo("rpc_request_completed", {
					provider: providerAlias,
					providerSlot: options.slot + 1,
					role: options.role,
					lane,
					method: rpcRequest.method,
					methodFamily: rpcMethodFamily(rpcRequest.method),
					durationMs,
					outcome: "success",
					resultItems: Array.isArray(result) ? result.length : null,
				});
				if (
					cachedCircuit.state !== "closed" ||
					cachedCircuit.consecutiveFailures > 0
				) {
					await recordRecovery(env, {
						endpointKey,
						role: options.role,
						providerAlias,
						latencyMs: durationMs,
					});
				}
				cachedCircuit = {
					state: "closed",
					consecutiveFailures: 0,
					openedUntil: 0,
				};
				return result;
			} catch (error) {
				const durationMs = Date.now() - startedAt;
				const transient = isTransientRpcError(error);
				const wasHalfOpen = cachedCircuit.state === "half_open";
				logError("rpc_request_failed", error, {
					provider: providerAlias,
					providerSlot: options.slot + 1,
					role: options.role,
					lane,
					method: rpcRequest.method,
					methodFamily: rpcMethodFamily(rpcRequest.method),
					durationMs,
					transient,
				});
				if (transient) {
					const code = failureCode(error);
					await recordFailure(env, {
						endpointKey,
						role: options.role,
						providerAlias,
						errorCode: code,
						latencyMs: durationMs,
					});
					const threshold = failureThreshold(code);
					const failures = cachedCircuit.consecutiveFailures + 1;
					const shouldOpen = wasHalfOpen || failures >= threshold;
					cachedCircuit = {
						state: shouldOpen ? "open" : "closed",
						consecutiveFailures: failures,
						openedUntil:
							shouldOpen
								? Date.now() + circuitOpenMs(code)
								: 0,
					};
					cachedCircuitUntil = Date.now() + CIRCUIT_CACHE_MS;
				} else if (wasHalfOpen) {
					// A deterministic JSON-RPC rejection still proves that the
					// provider is reachable. Close the transport circuit and let
					// the caller handle the method-level error.
					await recordRecovery(env, {
						endpointKey,
						role: options.role,
						providerAlias,
						latencyMs: durationMs,
					});
					cachedCircuit = {
						state: "closed",
						consecutiveFailures: 0,
						openedUntil: 0,
					};
					cachedCircuitUntil = Date.now() + CIRCUIT_CACHE_MS;
				}
				throw error;
			} finally {
				if (distributedAdmission && admissionToken) {
					try {
						await distributedAdmission.release(admissionToken);
					} catch (error) {
						// The admission lease has a bounded TTL, so an internal
						// release failure cannot permanently consume capacity.
						logWarn("rpc_admission_release_failed", {
							provider: providerAlias,
							providerSlot: options.slot + 1,
							role: options.role,
							lane,
							errorName:
								error instanceof Error
									? error.name
									: "unknown",
						});
					}
				}
				releaseLocal();
			}
		}) as EIP1193RequestFn;
		return createTransport(
			{
				key: `controlled-http-${options.role}-${options.slot}`,
				name: providerAlias,
				type: "controlled-http",
				request,
				retryCount: 0,
				timeout: options.timeoutMs,
			},
			{
				providerAlias,
				role: options.role,
				lane,
			},
		);
	};
}

export async function getRpcHealthSummary(
	env: Bindings,
): Promise<Array<{
	role: RpcRoleName;
	providerAlias: string;
	circuitState: CircuitRow["circuit_state"];
	consecutiveFailures: number;
	openedUntil: string | null;
	lastErrorCode: string | null;
	lastLatencyMs: number | null;
}>> {
	try {
		const result = await env.PARMELIA_DB.prepare(
			`SELECT role, provider_alias, circuit_state, consecutive_failures,
			        opened_until, last_error_code, last_latency_ms
			 FROM rpc_endpoint_health ORDER BY role, provider_alias`,
		).all<{
			role: RpcRoleName;
			provider_alias: string;
			circuit_state: CircuitRow["circuit_state"];
			consecutive_failures: number;
			opened_until: string | null;
			last_error_code: string | null;
			last_latency_ms: number | null;
		}>();
		return result.results.map((row) => ({
			role: row.role,
			providerAlias: row.provider_alias,
			circuitState: row.circuit_state,
			consecutiveFailures: row.consecutive_failures,
			openedUntil: row.opened_until,
			lastErrorCode: row.last_error_code,
			lastLatencyMs: row.last_latency_ms,
		}));
	} catch {
		return [];
	}
}

export const __test = {
	failureCode,
	failureThreshold,
	circuitOpenMs,
	admissionWaitMs,
	admissionLeaseTtlMs,
	acquireDistributedAdmission,
	fnv1a,
	concurrencyForLane,
	rpcMethodFamily,
	LocalSemaphore,
	recordFailure,
	claimHalfOpenProbe,
};
