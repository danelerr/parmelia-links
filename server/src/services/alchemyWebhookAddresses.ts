import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	ALCHEMY_SHARDS_PER_WEBHOOK,
	getAlchemyAddressWebhookConfigs,
} from "./alchemyWebhookConfig";
import { discardResponseBody, readJsonBounded } from "./http";
import { transferAssignmentStream } from "./indexerPartitions";
import { logError, logInfo } from "./logger";

const ALCHEMY_ADDRESSES_URL =
	"https://dashboard.alchemy.com/api/webhook-addresses";
const ALCHEMY_UPDATE_ADDRESSES_URL =
	"https://dashboard.alchemy.com/api/update-webhook-addresses";
const PROVIDER = "alchemy";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 512 * 1024;
const MAX_TRACKED_ADDRESSES = 100_000;
const PATCH_CHUNK_SIZE = 500;
const REMOTE_PAGE_SIZE = 100;
const BOOTSTRAP_PAGES_PER_JOB = 5;

type AddressPage = {
	data?: unknown;
	pagination?: {
		cursors?: {
			after?: unknown;
		};
	};
};

type SubscriptionSyncState = {
	phase: "scanning" | "ready";
	next_cursor: string | null;
	scanned_count: number;
};

export type AlchemyAddressSyncResult = {
	phase: "bootstrap" | "reconcile";
	changed: number;
	remaining: boolean;
};

function normalizeAddressSet(values: readonly string[]): string[] {
	const normalized = new Set<string>();
	for (const value of values) {
		const address = value.toLowerCase();
		if (!/^0x[0-9a-f]{40}$/u.test(address)) {
			throw new Error(
				"Provider subscription contains a malformed address",
			);
		}
		normalized.add(address);
	}
	return [...normalized].sort();
}

async function readRemoteAddressPage(
	webhookId: string,
	authToken: string,
	after: string | null,
): Promise<{ addresses: string[]; nextCursor: string | null }> {
	const url = new URL(ALCHEMY_ADDRESSES_URL);
	url.searchParams.set("webhook_id", webhookId);
	url.searchParams.set("limit", String(REMOTE_PAGE_SIZE));
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
	if (
		!Array.isArray(page.data) ||
		page.data.some((value) => typeof value !== "string")
	) {
		throw new Error("Alchemy address list returned an invalid schema");
	}
	const next = page.pagination?.cursors?.after;
	return {
		addresses: normalizeAddressSet(page.data as string[]),
		nextCursor:
			typeof next === "string" && next.length > 0 && next !== after
				? next
				: null,
	};
}

async function patchRemoteAddresses(
	webhookId: string,
	authToken: string,
	input: { add: string[]; remove: string[] },
): Promise<void> {
	if (input.add.length === 0 && input.remove.length === 0) return;
	if (
		input.add.length > PATCH_CHUNK_SIZE ||
		input.remove.length > PATCH_CHUNK_SIZE
	) {
		throw new Error("Alchemy address patch exceeds its bounded chunk");
	}
	const response = await fetch(ALCHEMY_UPDATE_ADDRESSES_URL, {
		method: "PATCH",
		headers: {
			"Content-Type": "application/json",
			"X-Alchemy-Token": authToken,
		},
		body: JSON.stringify({
			webhook_id: webhookId,
			addresses_to_add: input.add,
			addresses_to_remove: input.remove,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const status = response.status;
	await discardResponseBody(response);
	if (!response.ok) {
		throw new Error(`Alchemy address update failed with HTTP ${status}`);
	}
}

async function writeProviderState(
	env: Bindings,
	input: {
		webhookId: string;
		itemCount: number;
		status: "pending" | "synced" | "failed";
		errorCode?: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	const mirrorVersion = `incremental-v1:${input.itemCount}`;
	await env.PARMELIA_DB.prepare(
		`INSERT INTO provider_subscription_state (
			provider, subscription_id, desired_hash, remote_hash, item_count,
			status, last_attempt_at, last_success_at, last_error_code
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
			PROVIDER,
			input.webhookId,
			mirrorVersion,
			input.status === "synced" ? mirrorVersion : null,
			input.itemCount,
			input.status,
			now,
			input.status === "synced" ? now : null,
			input.errorCode ?? null,
		)
		.run();
}

async function getOrCreateSyncState(
	env: Bindings,
	webhookId: string,
): Promise<SubscriptionSyncState> {
	const now = new Date().toISOString();
	await env.PARMELIA_DB.prepare(
		`INSERT OR IGNORE INTO provider_subscription_sync_state (
			provider, subscription_id, phase, next_cursor, scanned_count,
			created_at, updated_at
		 ) VALUES (?, ?, 'scanning', NULL, 0, ?, ?)`,
	)
		.bind(PROVIDER, webhookId, now, now)
		.run();
	const state = await env.PARMELIA_DB.prepare(
		`SELECT phase, next_cursor, scanned_count
		 FROM provider_subscription_sync_state
		 WHERE provider = ? AND subscription_id = ?`,
	)
		.bind(PROVIDER, webhookId)
		.first<SubscriptionSyncState>();
	if (!state) throw new Error("Provider subscription sync state is missing");
	return state;
}

async function bootstrapRemoteMirror(
	env: Bindings,
	input: {
		webhookId: string;
		authToken: string;
		state: SubscriptionSyncState;
	},
): Promise<{ state: SubscriptionSyncState; remaining: boolean }> {
	let state = input.state;
	for (
		let pageIndex = 0;
		pageIndex < BOOTSTRAP_PAGES_PER_JOB && state.phase === "scanning";
		pageIndex++
	) {
		const page = await readRemoteAddressPage(
			input.webhookId,
			input.authToken,
			state.next_cursor,
		);
		const scannedCount = state.scanned_count + page.addresses.length;
		if (scannedCount > MAX_TRACKED_ADDRESSES) {
			throw new Error("Alchemy webhook address capacity exceeded");
		}
		const now = new Date().toISOString();
		const phase = page.nextCursor === null ? "ready" : "scanning";
		const statements = page.addresses.map((address) =>
			env.PARMELIA_DB.prepare(
				`INSERT INTO provider_subscription_items (
					provider, subscription_id, item, synced_at
				 ) VALUES (?, ?, ?, ?)
				 ON CONFLICT(provider, subscription_id, item) DO UPDATE SET
				    synced_at = excluded.synced_at`,
			).bind(PROVIDER, input.webhookId, address, now),
		);
		statements.push(
			env.PARMELIA_DB.prepare(
				`UPDATE provider_subscription_sync_state
				 SET phase = ?, next_cursor = ?, scanned_count = ?, updated_at = ?
				 WHERE provider = ? AND subscription_id = ?`,
			).bind(
				phase,
				page.nextCursor,
				scannedCount,
				now,
				PROVIDER,
				input.webhookId,
			),
		);
		await env.PARMELIA_DB.batch(statements);
		state = {
			phase,
			next_cursor: page.nextCursor,
			scanned_count: scannedCount,
		};
	}
	return { state, remaining: state.phase === "scanning" };
}

async function listAddressMutations(
	env: Bindings,
	input: {
		webhookId: string;
		chainId: number;
		stream: string;
		firstShard: number;
		shardExclusive: number;
	},
): Promise<{ add: string[]; remove: string[] }> {
	const [additions, removals] = await Promise.all([
		env.PARMELIA_DB.prepare(
			`SELECT DISTINCT a.account_address AS address
			 FROM indexer_wallet_assignments a
			 LEFT JOIN provider_subscription_items i
			   ON i.provider = ? AND i.subscription_id = ?
			  AND i.item = a.account_address
			 WHERE a.chain_id = ? AND a.stream = ? AND a.active = 1
			   AND a.shard_id >= ? AND a.shard_id < ?
			   AND i.item IS NULL
			 ORDER BY a.account_address
			 LIMIT ?`,
		)
			.bind(
				PROVIDER,
				input.webhookId,
				input.chainId,
				input.stream,
				input.firstShard,
				input.shardExclusive,
				PATCH_CHUNK_SIZE,
			)
			.all<{ address: string }>(),
		env.PARMELIA_DB.prepare(
			`SELECT i.item AS address
			 FROM provider_subscription_items i
			 WHERE i.provider = ? AND i.subscription_id = ?
			   AND NOT EXISTS (
			    SELECT 1
			    FROM indexer_wallet_assignments a
			    WHERE a.chain_id = ? AND a.stream = ? AND a.active = 1
			      AND a.shard_id >= ? AND a.shard_id < ?
			      AND a.account_address = i.item
			   )
			 ORDER BY i.item
			 LIMIT ?`,
		)
			.bind(
				PROVIDER,
				input.webhookId,
				input.chainId,
				input.stream,
				input.firstShard,
				input.shardExclusive,
				PATCH_CHUNK_SIZE,
			)
			.all<{ address: string }>(),
	]);
	return {
		add: normalizeAddressSet(
			additions.results.map((row) => row.address),
		),
		remove: normalizeAddressSet(
			removals.results.map((row) => row.address),
		),
	};
}

async function updateLocalMirror(
	env: Bindings,
	webhookId: string,
	changes: { add: string[]; remove: string[] },
): Promise<void> {
	const now = new Date().toISOString();
	const statements = [
		...changes.add.map((address) =>
			env.PARMELIA_DB.prepare(
				`INSERT INTO provider_subscription_items (
					provider, subscription_id, item, synced_at
				 ) VALUES (?, ?, ?, ?)
				 ON CONFLICT(provider, subscription_id, item) DO UPDATE SET
				    synced_at = excluded.synced_at`,
			).bind(PROVIDER, webhookId, address, now),
		),
		...changes.remove.map((address) =>
			env.PARMELIA_DB.prepare(
				`DELETE FROM provider_subscription_items
				 WHERE provider = ? AND subscription_id = ? AND item = ?`,
			).bind(PROVIDER, webhookId, address),
		),
	];
	if (statements.length > 0) await env.PARMELIA_DB.batch(statements);
}

async function countMirrorItems(
	env: Bindings,
	webhookId: string,
): Promise<number> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM provider_subscription_items
		 WHERE provider = ? AND subscription_id = ?`,
	)
		.bind(PROVIDER, webhookId)
		.first<{ count: number }>();
	return row?.count ?? 0;
}

/**
 * Reconcile one bounded subscription partition. Initial remote discovery is
 * paginated across Queue continuations; steady-state changes use an indexed D1
 * diff and one idempotent provider PATCH, independent of total wallet count.
 */
export async function syncAlchemyWebhookAddresses(
	env: Bindings,
	slot: number,
): Promise<AlchemyAddressSyncResult> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") {
		return { phase: "reconcile", changed: 0, remaining: false };
	}
	const webhook = getAlchemyAddressWebhookConfigs(env).find(
		(candidate) => candidate.slot === slot,
	);
	const authToken = env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim();
	if (!webhook || !authToken) {
		throw new Error("Alchemy webhook address sync is not configured");
	}
	const network = getNetworkConfig(env.CHAIN_KEY);
	const firstShard = slot * ALCHEMY_SHARDS_PER_WEBHOOK;
	const shardExclusive = firstShard + ALCHEMY_SHARDS_PER_WEBHOOK;

	try {
		const initialState = await getOrCreateSyncState(env, webhook.id);
		if (initialState.phase === "scanning") {
			const bootstrap = await bootstrapRemoteMirror(env, {
				webhookId: webhook.id,
				authToken,
				state: initialState,
			});
			if (bootstrap.remaining) {
				await writeProviderState(env, {
					webhookId: webhook.id,
					itemCount: bootstrap.state.scanned_count,
					status: "pending",
				});
				logInfo("alchemy_webhook_addresses_bootstrap_progress", {
					slot,
					webhookId: webhook.id,
					scanned: bootstrap.state.scanned_count,
				});
				return {
					phase: "bootstrap",
					changed: 0,
					remaining: true,
				};
			}
		}

		const changes = await listAddressMutations(env, {
			webhookId: webhook.id,
			chainId: network.chainId,
			stream: transferAssignmentStream(network.chainId),
			firstShard,
			shardExclusive,
		});
		await patchRemoteAddresses(webhook.id, authToken, changes);
		await updateLocalMirror(env, webhook.id, changes);
		const itemCount = await countMirrorItems(env, webhook.id);
		const remaining =
			changes.add.length === PATCH_CHUNK_SIZE ||
			changes.remove.length === PATCH_CHUNK_SIZE;
		await writeProviderState(env, {
			webhookId: webhook.id,
			itemCount,
			status: remaining ? "pending" : "synced",
		});
		logInfo("alchemy_webhook_addresses_synced", {
			slot,
			webhookId: webhook.id,
			tracked: itemCount,
			added: changes.add.length,
			removed: changes.remove.length,
			remaining,
		});
		return {
			phase: "reconcile",
			changed: changes.add.length + changes.remove.length,
			remaining,
		};
	} catch (error) {
		await writeProviderState(env, {
			webhookId: webhook.id,
			itemCount: await countMirrorItems(env, webhook.id).catch(() => 0),
			status: "failed",
			errorCode: "ALCHEMY_ADDRESS_SYNC_FAILED",
		});
		logError("alchemy_webhook_address_sync_failed", error, {
			slot,
			webhookId: webhook.id,
		});
		throw error;
	}
}

export const __test = {
	normalizeAddressSet,
};
