import type { Bindings } from "../middlewares/auth";
import { discardResponseBody, readJsonBounded } from "./http";
import { logError, logInfo } from "./logger";
import { listUserWallets } from "./storage";

const ALCHEMY_ADDRESSES_URL =
	"https://dashboard.alchemy.com/api/webhook-addresses";
const ALCHEMY_UPDATE_ADDRESSES_URL =
	"https://dashboard.alchemy.com/api/update-webhook-addresses";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const MAX_TRACKED_ADDRESSES = 100_000;
const PATCH_CHUNK_SIZE = 500;
const FULL_AUDIT_INTERVAL_MS = 24 * 60 * 60_000;

type SubscriptionStateRow = {
	desired_hash: string;
	status: "pending" | "synced" | "failed";
	last_success_at: string | null;
};

type AddressPage = {
	data?: unknown;
	pagination?: {
		cursors?: {
			after?: unknown;
		};
	};
};

function normalizeAddressSet(values: readonly string[]): string[] {
	const normalized = new Set<string>();
	for (const value of values) {
		const address = value.toLowerCase();
		if (!/^0x[0-9a-f]{40}$/.test(address)) {
			throw new Error("Provider subscription contains a malformed address");
		}
		normalized.add(address);
	}
	return [...normalized].sort();
}

async function addressSetHash(addresses: readonly string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(addresses.join("\n")),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function diffWebhookAddresses(
	desiredValues: readonly string[],
	remoteValues: readonly string[],
): { add: string[]; remove: string[] } {
	const desired = normalizeAddressSet(desiredValues);
	const remote = normalizeAddressSet(remoteValues);
	const desiredSet = new Set(desired);
	const remoteSet = new Set(remote);
	return {
		add: desired.filter((address) => !remoteSet.has(address)),
		remove: remote.filter((address) => !desiredSet.has(address)),
	};
}

async function listRemoteAddresses(
	webhookId: string,
	authToken: string,
): Promise<string[]> {
	const addresses: string[] = [];
	let after: string | undefined;
	for (;;) {
		const url = new URL(ALCHEMY_ADDRESSES_URL);
		url.searchParams.set("webhook_id", webhookId);
		url.searchParams.set("limit", "100");
		if (after) url.searchParams.set("after", after);
		const response = await fetch(url, {
			headers: { "X-Alchemy-Token": authToken },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			const status = response.status;
			await discardResponseBody(response);
			throw new Error(`Alchemy address list failed with HTTP ${status}`);
		}
		const page = await readJsonBounded<AddressPage>(
			response,
			RESPONSE_LIMIT_BYTES,
		);
		if (!Array.isArray(page.data) || page.data.some((value) => typeof value !== "string")) {
			throw new Error("Alchemy address list returned an invalid schema");
		}
		addresses.push(...(page.data as string[]));
		if (addresses.length > MAX_TRACKED_ADDRESSES) {
			throw new Error("Alchemy webhook address capacity exceeded");
		}
		const next = page.pagination?.cursors?.after;
		if (typeof next !== "string" || next.length === 0 || next === after) break;
		after = next;
	}
	return normalizeAddressSet(addresses);
}

async function patchRemoteAddresses(
	webhookId: string,
	authToken: string,
	input: { add: string[]; remove: string[] },
): Promise<void> {
	const maxLength = Math.max(input.add.length, input.remove.length);
	for (let index = 0; index < maxLength; index += PATCH_CHUNK_SIZE) {
		const response = await fetch(ALCHEMY_UPDATE_ADDRESSES_URL, {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				"X-Alchemy-Token": authToken,
			},
			body: JSON.stringify({
				webhook_id: webhookId,
				addresses_to_add: input.add.slice(index, index + PATCH_CHUNK_SIZE),
				addresses_to_remove: input.remove.slice(
					index,
					index + PATCH_CHUNK_SIZE,
				),
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const status = response.status;
		await discardResponseBody(response);
		if (!response.ok) {
			throw new Error(`Alchemy address update failed with HTTP ${status}`);
		}
	}
}

async function writeState(
	env: Bindings,
	input: {
		webhookId: string;
		desiredHash: string;
		remoteHash?: string | null;
		itemCount: number;
		status: "pending" | "synced" | "failed";
		errorCode?: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await env.PARMELIA_DB.prepare(
		`INSERT INTO provider_subscription_state (
			provider, subscription_id, desired_hash, remote_hash, item_count,
			status, last_attempt_at, last_success_at, last_error_code
		 ) VALUES ('alchemy', ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(provider, subscription_id) DO UPDATE SET
		 	desired_hash = excluded.desired_hash,
		 	remote_hash = excluded.remote_hash,
		 	item_count = excluded.item_count,
		 	status = excluded.status,
		 	last_attempt_at = excluded.last_attempt_at,
		 	last_success_at = CASE
		 		WHEN excluded.status = 'synced' THEN excluded.last_success_at
		 		ELSE provider_subscription_state.last_success_at
		 	END,
		 	last_error_code = excluded.last_error_code`,
	)
		.bind(
			input.webhookId,
			input.desiredHash,
			input.remoteHash ?? null,
			input.itemCount,
			input.status,
			now,
			input.status === "synced" ? now : null,
			input.errorCode ?? null,
		)
		.run();
}

/**
 * Reconcile Alchemy's tracked-address set with D1. This is a control-plane
 * operation only; the Node API key/RPC endpoint is never used here.
 */
export async function syncAlchemyWebhookAddresses(env: Bindings): Promise<void> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") return;
	const webhookId = env.ALCHEMY_WEBHOOK_ID?.trim();
	const authToken = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
	if (!webhookId || !authToken) {
		throw new Error("Alchemy webhook address sync is not configured");
	}
	const desired = normalizeAddressSet(
		(await listUserWallets(env)).map((wallet) => wallet.walletAddress),
	);
	if (desired.length > MAX_TRACKED_ADDRESSES) {
		throw new Error("Alchemy webhook address capacity exceeded");
	}
	const desiredHash = await addressSetHash(desired);
	const prior = await env.PARMELIA_DB.prepare(
		`SELECT desired_hash, status, last_success_at
		 FROM provider_subscription_state
		 WHERE provider = 'alchemy' AND subscription_id = ?`,
	)
		.bind(webhookId)
		.first<SubscriptionStateRow>();
	const lastSuccessMs = prior?.last_success_at
		? new Date(prior.last_success_at).getTime()
		: 0;
	if (
		prior?.status === "synced" &&
		prior.desired_hash === desiredHash &&
		Number.isFinite(lastSuccessMs) &&
		Date.now() - lastSuccessMs < FULL_AUDIT_INTERVAL_MS
	) {
		return;
	}

	await writeState(env, {
		webhookId,
		desiredHash,
		itemCount: desired.length,
		status: "pending",
	});
	try {
		const remote = await listRemoteAddresses(webhookId, authToken);
		const changes = diffWebhookAddresses(desired, remote);
		if (changes.add.length > 0 || changes.remove.length > 0) {
			await patchRemoteAddresses(webhookId, authToken, changes);
		}
		await writeState(env, {
			webhookId,
			desiredHash,
			remoteHash: desiredHash,
			itemCount: desired.length,
			status: "synced",
		});
		logInfo("alchemy_webhook_addresses_synced", {
			tracked: desired.length,
			added: changes.add.length,
			removed: changes.remove.length,
		});
	} catch (error) {
		await writeState(env, {
			webhookId,
			desiredHash,
			itemCount: desired.length,
			status: "failed",
			errorCode: "ALCHEMY_ADDRESS_SYNC_FAILED",
		});
		logError("alchemy_webhook_address_sync_failed", error, {
			tracked: desired.length,
		});
		throw error;
	}
}

export const __test = {
	normalizeAddressSet,
	addressSetHash,
};
