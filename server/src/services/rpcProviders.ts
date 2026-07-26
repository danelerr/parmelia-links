import type { Bindings } from "../middlewares/auth";

export const RPC_ROLE_NAMES = [
	"read",
	"write",
	"indexer",
	"archive",
	"bundler",
] as const;

export type RpcRoleName = (typeof RPC_ROLE_NAMES)[number];

export type RpcEndpointCapability = {
	id: string;
	priority: number;
	maxConcurrency: number;
	maxLogRange: number | null;
};

type CapabilityDocument = Partial<
	Record<RpcRoleName, RpcEndpointCapabilityInput[]>
>;

type RpcEndpointCapabilityInput = {
	id?: unknown;
	priority?: unknown;
	maxConcurrency?: unknown;
	maxLogRange?: unknown;
};

export type RpcCapabilityIssue = {
	code: string;
	message: string;
};

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_CONFIGURED_LOG_RANGE = 10_000_000;
const MAX_CONFIGURED_CONCURRENCY = 1_000;
const MAX_CONFIGURED_PRIORITY = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(
	value: unknown,
	minimum: number,
	maximum: number,
): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= minimum &&
		value <= maximum
	);
}

function defaultConcurrency(role: RpcRoleName): number {
	if (role === "archive") return 1;
	if (role === "read") return 8;
	return 4;
}

function legacyIndexerRange(env: Bindings): number {
	const parsed = Number(env.RPC_INDEXER_MAX_BLOCK_RANGE ?? "2000");
	return safeInteger(parsed, 1, MAX_CONFIGURED_LOG_RANGE) ? parsed : 2_000;
}

function parseDocument(raw: string | undefined): CapabilityDocument | null {
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return null;
		return parsed as CapabilityDocument;
	} catch {
		return null;
	}
}

function normalizeCapability(
	env: Bindings,
	role: RpcRoleName,
	slot: number,
	input: RpcEndpointCapabilityInput | undefined,
): RpcEndpointCapability {
	return {
		id:
			typeof input?.id === "string" && PROVIDER_ID_PATTERN.test(input.id)
				? input.id
				: `${role}-endpoint-${slot + 1}`,
		priority: safeInteger(input?.priority, 0, MAX_CONFIGURED_PRIORITY)
			? input.priority
			: slot,
		maxConcurrency: safeInteger(
			input?.maxConcurrency,
			1,
			MAX_CONFIGURED_CONCURRENCY,
		)
			? input.maxConcurrency
			: defaultConcurrency(role),
		maxLogRange:
			role === "indexer"
				? safeInteger(input?.maxLogRange, 1, MAX_CONFIGURED_LOG_RANGE)
					? input.maxLogRange
					: legacyIndexerRange(env)
				: null,
	};
}

/**
 * Capabilities are matched to secret URLs by role-local slot. URLs remain in
 * Wrangler secrets; this non-secret document describes operational limits.
 */
export function getRpcEndpointCapabilities(
	env: Bindings,
	role: RpcRoleName,
	endpointCount: number,
): RpcEndpointCapability[] {
	const document = parseDocument(env.RPC_PROVIDER_CAPABILITIES);
	const configured = document?.[role];
	return Array.from({ length: endpointCount }, (_, slot) =>
		normalizeCapability(env, role, slot, configured?.[slot]),
	);
}

export function validateRpcProviderCapabilities(
	env: Bindings,
	endpointCounts: Partial<Record<RpcRoleName, number>>,
): RpcCapabilityIssue[] {
	const raw = env.RPC_PROVIDER_CAPABILITIES;
	if (!raw?.trim()) return [];
	const document = parseDocument(raw);
	if (!document) {
		return [{
			code: "RPC_PROVIDER_CAPABILITIES_INVALID",
			message: "RPC_PROVIDER_CAPABILITIES must be a JSON object",
		}];
	}
	const unknownRoles = Object.keys(document).filter(
		(role) => !RPC_ROLE_NAMES.includes(role as RpcRoleName),
	);
	if (unknownRoles.length > 0) {
		return [{
			code: "RPC_PROVIDER_CAPABILITIES_ROLE_INVALID",
			message: "RPC_PROVIDER_CAPABILITIES contains an unsupported role",
		}];
	}

	const issues: RpcCapabilityIssue[] = [];
	for (const role of RPC_ROLE_NAMES) {
		const entries = document[role];
		if (entries === undefined) continue;
		if (!Array.isArray(entries)) {
			issues.push({
				code: "RPC_PROVIDER_CAPABILITIES_ROLE_INVALID",
				message: `RPC provider capabilities for ${role} must be an array`,
			});
			continue;
		}
		if (entries.length !== (endpointCounts[role] ?? 0)) {
			issues.push({
				code: "RPC_PROVIDER_CAPABILITIES_COUNT_MISMATCH",
				message: `RPC provider capabilities for ${role} must match its endpoint count`,
			});
			continue;
		}
		const ids = new Set<string>();
		for (const entry of entries) {
			if (!isRecord(entry)) {
				issues.push({
					code: "RPC_PROVIDER_CAPABILITY_INVALID",
					message: `Each ${role} provider capability must be an object`,
				});
				continue;
			}
			if (
				typeof entry.id !== "string" ||
				!PROVIDER_ID_PATTERN.test(entry.id) ||
				ids.has(entry.id)
			) {
				issues.push({
					code: "RPC_PROVIDER_ID_INVALID",
					message: `Each ${role} provider id must be unique and URL-safe`,
				});
			} else {
				ids.add(entry.id);
			}
			if (
				entry.priority !== undefined &&
				!safeInteger(entry.priority, 0, MAX_CONFIGURED_PRIORITY)
			) {
				issues.push({
					code: "RPC_PROVIDER_PRIORITY_INVALID",
					message: `Provider ${role} priority is outside the supported range`,
				});
			}
			if (
				entry.maxConcurrency !== undefined &&
				!safeInteger(
					entry.maxConcurrency,
					1,
					MAX_CONFIGURED_CONCURRENCY,
				)
			) {
				issues.push({
					code: "RPC_PROVIDER_CONCURRENCY_INVALID",
					message: `Provider ${role} maxConcurrency is outside the supported range`,
				});
			}
			if (
				role === "indexer" &&
				!safeInteger(entry.maxLogRange, 1, MAX_CONFIGURED_LOG_RANGE)
			) {
				issues.push({
					code: "RPC_PROVIDER_LOG_RANGE_INVALID",
					message: "Each indexer provider requires maxLogRange between 1 and 10000000",
				});
			}
			if (role !== "indexer" && entry.maxLogRange !== undefined) {
				issues.push({
					code: "RPC_PROVIDER_LOG_RANGE_ROLE_INVALID",
					message: "maxLogRange is only valid for indexer providers",
				});
			}
		}
	}
	return issues;
}

export const __test = {
	MAX_CONFIGURED_LOG_RANGE,
	parseDocument,
	normalizeCapability,
};
