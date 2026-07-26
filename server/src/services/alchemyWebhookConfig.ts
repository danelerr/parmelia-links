import type { Bindings } from "../middlewares/auth";

export type AlchemyAddressWebhookConfig = {
	slot: number;
	id: string;
	network: string;
	signingKey: string;
};

type ConfigInput = {
	id?: unknown;
	network?: unknown;
	signingKey?: unknown;
};

// INDEXER_WALLET_SHARD_SIZE is bounded to 500, so 200 stable shards can never
// exceed Alchemy's technical limit of 100,000 tracked addresses per webhook.
export const ALCHEMY_SHARDS_PER_WEBHOOK = 200;

export function alchemyWebhookSlotForShard(shardId: number): number {
	if (!Number.isSafeInteger(shardId) || shardId < 0) {
		throw new Error("Alchemy webhook shard id is invalid");
	}
	return Math.floor(shardId / ALCHEMY_SHARDS_PER_WEBHOOK);
}

export function alchemyWebhookPartition(slot: number): string {
	if (!Number.isSafeInteger(slot) || slot < 0) {
		throw new Error("Alchemy webhook slot is invalid");
	}
	return `slot:${slot}`;
}

export function parseAlchemyWebhookPartition(value: string): number | null {
	const match = /^slot:(\d+)$/u.exec(value);
	if (!match) return null;
	const slot = Number(match[1]);
	return Number.isSafeInteger(slot) && slot >= 0 ? slot : null;
}

function parseConfiguredWebhooks(
	raw: string | undefined,
): ConfigInput[] | null {
	if (!raw?.trim()) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed as ConfigInput[];
	} catch {
		return null;
	}
}

export function getAlchemyAddressWebhookConfigs(
	env: Bindings,
): AlchemyAddressWebhookConfig[] {
	const configured = parseConfiguredWebhooks(
		env.ALCHEMY_ADDRESS_WEBHOOKS_JSON,
	);
	if (configured === null) return [];
	if (configured.length > 0) {
		return configured
			.map((entry, slot) => ({
				slot,
				id: typeof entry.id === "string" ? entry.id.trim() : "",
				network:
					typeof entry.network === "string"
						? entry.network.trim()
						: "",
				signingKey:
					typeof entry.signingKey === "string"
						? entry.signingKey
						: "",
			}))
			.filter(
				(entry) =>
					Boolean(entry.id) &&
					Boolean(entry.network) &&
					Boolean(entry.signingKey),
			);
	}
	if (
		env.ALCHEMY_WEBHOOK_ID?.trim() &&
		env.ALCHEMY_WEBHOOK_NETWORK?.trim() &&
		env.ALCHEMY_WEBHOOK_SIGNING_KEY
	) {
		return [{
			slot: 0,
			id: env.ALCHEMY_WEBHOOK_ID.trim(),
			network: env.ALCHEMY_WEBHOOK_NETWORK.trim(),
			signingKey: env.ALCHEMY_WEBHOOK_SIGNING_KEY,
		}];
	}
	return [];
}

export function validateAlchemyAddressWebhookConfigs(
	env: Bindings,
): Array<{ code: string; message: string }> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") return [];
	const raw = env.ALCHEMY_ADDRESS_WEBHOOKS_JSON;
	const configured = parseConfiguredWebhooks(raw);
	if (configured === null) {
		return [{
			code: "ALCHEMY_ADDRESS_WEBHOOKS_INVALID",
			message: "ALCHEMY_ADDRESS_WEBHOOKS_JSON must be a JSON array",
		}];
	}
	if (configured.length === 0) return [];
	const issues: Array<{ code: string; message: string }> = [];
	const ids = new Set<string>();
	for (const entry of configured) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			!entry.id.trim() ||
			ids.has(entry.id)
		) {
			issues.push({
				code: "ALCHEMY_ADDRESS_WEBHOOK_ID_INVALID",
				message: "Alchemy address webhook ids must be non-empty and unique",
			});
		} else {
			ids.add(entry.id);
		}
		if (
			typeof entry.network !== "string" ||
			!entry.network.trim()
		) {
			issues.push({
				code: "ALCHEMY_ADDRESS_WEBHOOK_NETWORK_INVALID",
				message: "Every Alchemy address webhook requires a network",
			});
		}
		if (
			typeof entry.signingKey !== "string" ||
			!entry.signingKey
		) {
			issues.push({
				code: "ALCHEMY_ADDRESS_WEBHOOK_SIGNING_KEY_INVALID",
				message: "Every Alchemy address webhook requires a signing key",
			});
		}
	}
	return issues;
}

export const __test = {
	parseConfiguredWebhooks,
};
