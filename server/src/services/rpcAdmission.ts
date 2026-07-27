import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../middlewares/auth";

type LeaseRecord = Record<string, number>;

export type RpcAdmissionRequest = {
	maxConcurrency: number;
	leaseTtlMs: number;
};

export type RpcAdmissionResult =
	| { granted: true; token: string }
	| { granted: false; retryAfterMs: number };

const LEASES_KEY = "leases";
const MAX_CONCURRENCY = 1_000;
const MAX_LEASE_TTL_MS = 120_000;

function validateRequest(value: RpcAdmissionRequest): void {
	if (
		!Number.isSafeInteger(value.maxConcurrency) ||
		value.maxConcurrency < 1 ||
		value.maxConcurrency > MAX_CONCURRENCY ||
		!Number.isSafeInteger(value.leaseTtlMs) ||
		value.leaseTtlMs < 1_000 ||
		value.leaseTtlMs > MAX_LEASE_TTL_MS
	) {
		throw new Error("Invalid RPC admission request");
	}
}

function liveLeases(
	leases: LeaseRecord | undefined,
	now: number,
): LeaseRecord {
	return Object.fromEntries(
		Object.entries(leases ?? {}).filter(([, expiresAt]) => expiresAt > now),
	);
}

function earliestExpiry(leases: LeaseRecord): number | null {
	const values = Object.values(leases);
	return values.length === 0 ? null : Math.min(...values);
}

function sameLeaseRecord(
	left: LeaseRecord | undefined,
	right: LeaseRecord,
): boolean {
	const leftEntries = Object.entries(left ?? {});
	const rightEntries = Object.entries(right);
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every(([token, expiresAt]) => right[token] === expiresAt)
	);
}

type AlarmChange =
	| { kind: "none" }
	| { kind: "set"; at: number }
	| { kind: "delete" };

async function applyAlarmChange(
	storage: DurableObjectStorage,
	change: AlarmChange,
): Promise<void> {
	if (change.kind === "set") {
		await storage.setAlarm(change.at);
	} else if (change.kind === "delete") {
		await storage.deleteAlarm();
	}
}

/**
 * Globally coordinates one provider/lane. The object name is a hash-backed
 * endpoint key, never a secret URL. Expiring leases make Worker termination
 * recoverable without a manual unlock.
 */
export class RpcAdmissionController extends DurableObject<Bindings> {
	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
	}

	async acquire(
		request: RpcAdmissionRequest,
	): Promise<RpcAdmissionResult> {
		validateRequest(request);
		const now = Date.now();
		const mutation = await this.ctx.storage.transaction(
			async (transaction) => {
				const stored =
					await transaction.get<LeaseRecord>(LEASES_KEY);
				const leases = liveLeases(stored, now);
				const pruned = !sameLeaseRecord(stored, leases);
				if (Object.keys(leases).length >= request.maxConcurrency) {
					const expiry = earliestExpiry(leases) ?? now + 100;
					if (pruned) {
						await transaction.put(LEASES_KEY, leases);
					}
					return {
						result: {
							granted: false as const,
							retryAfterMs: Math.max(
								25,
								Math.min(250, expiry - now),
							),
						},
						alarm: pruned
							? ({ kind: "set", at: expiry } as const)
							: ({ kind: "none" } as const),
					};
				}
				const previousExpiry = earliestExpiry(leases);
				const token = crypto.randomUUID();
				leases[token] = now + request.leaseTtlMs;
				await transaction.put(LEASES_KEY, leases);
				const expiry = earliestExpiry(leases)!;
				return {
					result: { granted: true as const, token },
					alarm:
						pruned ||
						previousExpiry === null ||
						expiry !== previousExpiry
							? ({ kind: "set", at: expiry } as const)
							: ({ kind: "none" } as const),
				};
			},
		);
		await applyAlarmChange(this.ctx.storage, mutation.alarm);
		return mutation.result;
	}

	async release(token: string): Promise<void> {
		if (
			typeof token !== "string" ||
			!/^[0-9a-f-]{36}$/u.test(token)
		) {
			return;
		}
		const now = Date.now();
		const mutation = await this.ctx.storage.transaction(
			async (transaction) => {
				const stored =
					await transaction.get<LeaseRecord>(LEASES_KEY);
				const current = liveLeases(stored, now);
				const previousExpiry = earliestExpiry(stored ?? {});
				const removed = token in current;
				if (removed) delete current[token];
				const changed =
					removed || !sameLeaseRecord(stored, current);
				if (!changed) {
					return {
						alarm: { kind: "none" } as const,
					};
				}
				if (Object.keys(current).length === 0) {
					await transaction.delete(LEASES_KEY);
				} else {
					await transaction.put(LEASES_KEY, current);
				}
				const expiry = earliestExpiry(current);
				return {
					alarm:
						expiry === null
							? ({ kind: "delete" } as const)
							: expiry !== previousExpiry
								? ({ kind: "set", at: expiry } as const)
								: ({ kind: "none" } as const),
				};
			},
		);
		await applyAlarmChange(this.ctx.storage, mutation.alarm);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const stored =
			await this.ctx.storage.get<LeaseRecord>(LEASES_KEY);
		const leases = liveLeases(stored, now);
		if (Object.keys(leases).length === 0) {
			if (stored !== undefined) {
				await this.ctx.storage.delete(LEASES_KEY);
			}
			return;
		}
		if (!sameLeaseRecord(stored, leases)) {
			await this.ctx.storage.put(LEASES_KEY, leases);
		}
		await this.ctx.storage.setAlarm(earliestExpiry(leases)!);
	}
}

export const __test = {
	liveLeases,
	earliestExpiry,
	sameLeaseRecord,
	validateRequest,
};
