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
		const result = await this.ctx.storage.transaction(
			async (transaction) => {
				const leases = liveLeases(
					await transaction.get<LeaseRecord>(LEASES_KEY),
					now,
				);
				if (Object.keys(leases).length >= request.maxConcurrency) {
					const expiry = earliestExpiry(leases) ?? now + 100;
					await transaction.put(LEASES_KEY, leases);
					return {
						granted: false as const,
						retryAfterMs: Math.max(
							25,
							Math.min(250, expiry - now),
						),
					};
				}
				const token = crypto.randomUUID();
				leases[token] = now + request.leaseTtlMs;
				await transaction.put(LEASES_KEY, leases);
				return { granted: true as const, token };
			},
		);
		const leases =
			await this.ctx.storage.get<LeaseRecord>(LEASES_KEY);
		const expiry = earliestExpiry(leases ?? {});
		if (expiry !== null) await this.ctx.storage.setAlarm(expiry);
		return result;
	}

	async release(token: string): Promise<void> {
		if (
			typeof token !== "string" ||
			!/^[0-9a-f-]{36}$/u.test(token)
		) {
			return;
		}
		const now = Date.now();
		const leases = await this.ctx.storage.transaction(
			async (transaction) => {
				const current = liveLeases(
					await transaction.get<LeaseRecord>(LEASES_KEY),
					now,
				);
				delete current[token];
				if (Object.keys(current).length === 0) {
					await transaction.delete(LEASES_KEY);
				} else {
					await transaction.put(LEASES_KEY, current);
				}
				return current;
			},
		);
		const expiry = earliestExpiry(leases);
		if (expiry === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(expiry);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const leases = liveLeases(
			await this.ctx.storage.get<LeaseRecord>(LEASES_KEY),
			now,
		);
		if (Object.keys(leases).length === 0) {
			await this.ctx.storage.delete(LEASES_KEY);
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.put(LEASES_KEY, leases);
		await this.ctx.storage.setAlarm(earliestExpiry(leases)!);
	}
}

export const __test = {
	liveLeases,
	earliestExpiry,
	validateRequest,
};
