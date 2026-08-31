import { formatUnits, type Address, type Hex } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	requestBalanceRefresh,
	type BalanceProjectionStrategy,
} from "./balanceReadModel";
import type { ChainConsistencyLevel } from "./chainJournal";
import {
	buildTransferCoverageByAsset,
	prepareTransferCheckpointRowsForUid,
	type TransferCheckpointEvidence,
	type TransferCheckpointRow,
} from "./transferCoverage";

type ReadModelStatus = "fresh" | "stale" | "unavailable";

type ProfileRow = {
	uid: string;
	wallet_address: string | null;
	username: string | null;
	display_name: string | null;
	social_url: string | null;
	credential_id: string | null;
};

type SnapshotRow = {
	asset: string;
	balance_raw: string;
	decimals: number;
	block_number: number | string;
	block_hash: string;
	consistency_level: ChainConsistencyLevel;
	projection_strategy: BalanceProjectionStrategy;
	projection_version: number;
	observed_at: string;
	reconciled_at: string | null;
	source: string;
};

type LedgerHomeRow = {
	id: string;
	direction: "in" | "out";
	kind: string;
	tx_hash: string;
	token: string;
	amount: string;
	amount_source: "executed" | "estimated";
	counterparty: string | null;
	counterparty_username: string | null;
	counterparty_display_name: string | null;
	reference: string | null;
	created_at: string;
};

type PendingHomeRow = {
	user_op_hash: string;
	status: string;
	currency: string;
	amount: string;
	created_at: string;
};

type AccountOperationHomeRow = {
	id: string;
	kind: string;
	status: string;
	tx_hash: string;
	created_at: string;
	updated_at: string;
};

type RefreshStateRow = {
	status: string;
	updated_at: string;
};

type VersionRow = {
	version: number;
	updated_at: string;
};

type HomeBalanceAsset = {
	value: string | null;
	raw: string | null;
	decimals: number;
	status: ReadModelStatus;
	blockNumber: string | null;
	blockHash: Hex | null;
	consistencyLevel: ChainConsistencyLevel | null;
	strategy: BalanceProjectionStrategy;
	projectionVersion: number | null;
	observedAt: string | null;
};

export type HomeBalanceView = {
	tokens: Record<string, string>;
	savings: string | null;
	assets: Record<string, HomeBalanceAsset>;
	status: ReadModelStatus;
	observedAt: string | null;
	blockNumber: string | null;
	blockHash: Hex | null;
	consistencyLevel: ChainConsistencyLevel | null;
	consistentThroughBlock: string | null;
	refreshing: boolean;
};

export type HomeReadModel = {
	schemaVersion: 1;
	identity: {
		uid: string;
		username: string | null;
		displayName: string | null;
		socialUrl: string | null;
	};
	account: {
		walletAddress: Address | null;
		chainId: number;
		chainKey: string;
		networkName: string;
	};
	balance: HomeBalanceView;
	security: {
		status: ReadModelStatus;
		hasRegisteredPasskey: boolean;
	};
	activity: {
		status: ReadModelStatus;
		sent: Array<Record<string, unknown>>;
		received: Array<Record<string, unknown>>;
		source: "ledger";
	};
	operations: {
		status: ReadModelStatus;
		payments: Array<Record<string, unknown>>;
		account: Array<Record<string, unknown>>;
	};
	alerts: Array<{
		code: string;
		severity: "info" | "warning";
	}>;
	stateVersion: string;
	observedAt: string;
	consistentThroughBlock: string | null;
};

function maxStalenessMs(env: Bindings): number {
	const parsed = Number(env.BALANCE_MAX_STALENESS_SECONDS);
	const seconds =
		Number.isSafeInteger(parsed) && parsed >= 15 && parsed <= 86_400
			? parsed
			: 60;
	return seconds * 1_000;
}

function expectedAssets(env: Bindings): Array<{
	asset: string;
	decimals: number;
	strategy: BalanceProjectionStrategy;
	isSavings: boolean;
}> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const assets = network.tokens.map((token) => ({
		asset: token.symbol,
		decimals: token.decimals,
		strategy: "rpc_only" as const,
		isSavings: false,
	}));
	if (network.aave) {
		assets.push({
			asset: "aUSDC",
			decimals: network.contracts.usdcDecimals,
			strategy: "rpc_only",
			isSavings: true,
		});
	}
	return assets;
}

function needsBalanceBootstrap(
	hasWallet: boolean,
	snapshotCount: number,
	expectedCount: number,
): boolean {
	// A stale snapshot is returned honestly but never turns a Home view into an
	// RPC refresh. Activity events and bounded maintenance own revalidation.
	return hasWallet && snapshotCount < expectedCount;
}

function buildBalanceView(
	env: Bindings,
	rows: SnapshotRow[],
	refresh: RefreshStateRow | null,
	now: Date,
	eventCoverage: ReadonlyMap<string, TransferCheckpointEvidence> = new Map(),
): HomeBalanceView {
	const snapshots = new Map(rows.map((row) => [row.asset, row]));
	const assets: Record<string, HomeBalanceAsset> = {};
	const tokens: Record<string, string> = {};
	let savings: string | null = null;
	let overall: ReadModelStatus = "fresh";
	let oldestObservedAt: string | null = null;
	let consistentThroughBlock: bigint | null = null;
	let consistentBlockHash: Hex | null = null;
	let consistentLevel: ChainConsistencyLevel | null = null;

	for (const expected of expectedAssets(env)) {
		const row = snapshots.get(expected.asset);
		if (!row) {
			assets[expected.asset] = {
				value: null,
				raw: null,
				decimals: expected.decimals,
				status: "unavailable",
				blockNumber: null,
				blockHash: null,
				consistencyLevel: null,
				strategy: expected.strategy,
				projectionVersion: null,
				observedAt: null,
			};
			overall = "unavailable";
			continue;
		}

		const eventBacked =
			row.projection_strategy === "events" ||
			row.projection_strategy === "events_plus_rpc";
		const eventCheckpoint = eventCoverage.get(expected.asset) ?? null;
		const checkpointCoversSnapshot =
			eventBacked &&
			eventCheckpoint !== null &&
			eventCheckpoint.blockNumber >= BigInt(row.block_number);
		const evidenceObservedAt = checkpointCoversSnapshot
			? eventCheckpoint.updatedAt
			: row.observed_at;
		const evidenceBlockNumber = checkpointCoversSnapshot
			? eventCheckpoint.blockNumber
			: BigInt(row.block_number);
		const evidenceBlockHash = checkpointCoversSnapshot
			? eventCheckpoint.blockHash
			: row.block_hash;
		const evidenceConsistency = checkpointCoversSnapshot
			? eventCheckpoint.consistencyLevel
			: row.consistency_level;
		const age =
			now.getTime() - new Date(evidenceObservedAt).getTime();
		const status: ReadModelStatus =
			Number.isFinite(age) && age <= maxStalenessMs(env) ? "fresh" : "stale";
		if (status === "stale" && overall === "fresh") overall = "stale";
		const value = formatUnits(BigInt(row.balance_raw), row.decimals);
		if (expected.isSavings) savings = value;
		else tokens[expected.asset] = value;
		assets[expected.asset] = {
			value,
			raw: row.balance_raw,
			decimals: row.decimals,
			status,
			blockNumber: evidenceBlockNumber.toString(),
			blockHash: evidenceBlockHash as Hex,
			consistencyLevel: evidenceConsistency,
			strategy: row.projection_strategy,
			projectionVersion: row.projection_version,
			observedAt: evidenceObservedAt,
		};

		if (
			oldestObservedAt === null ||
			new Date(evidenceObservedAt).getTime() <
				new Date(oldestObservedAt).getTime()
		) {
			oldestObservedAt = evidenceObservedAt;
		}
		if (
			consistentThroughBlock === null ||
			evidenceBlockNumber < consistentThroughBlock
		) {
			consistentThroughBlock = evidenceBlockNumber;
			consistentBlockHash = evidenceBlockHash as Hex;
			consistentLevel = evidenceConsistency;
		}
	}

	return {
		tokens,
		savings,
		assets,
		status: overall,
		observedAt: oldestObservedAt,
		blockNumber:
			consistentThroughBlock === null
				? null
				: consistentThroughBlock.toString(),
		blockHash: consistentBlockHash,
		consistencyLevel: consistentLevel,
		consistentThroughBlock:
			consistentThroughBlock === null
				? null
				: consistentThroughBlock.toString(),
		refreshing:
			refresh?.status === "pending" || refresh?.status === "processing",
	};
}

function mapActivity(rows: LedgerHomeRow[]) {
	const sent: Array<Record<string, unknown>> = [];
	const received: Array<Record<string, unknown>> = [];
	for (const row of rows) {
		const common = {
			id: row.id,
			txHash: row.tx_hash,
			amount: row.amount,
			amountSource: row.amount_source,
			currency: row.token,
			reference: row.reference ?? "",
			createdAt: row.created_at,
			kind: row.kind,
			counterpartyUsername: row.counterparty_username,
			counterpartyDisplayName: row.counterparty_display_name,
		};
		if (row.direction === "out") {
			sent.push({ ...common, to: row.counterparty ?? "" });
		} else {
			received.push({ ...common, paidBy: row.counterparty ?? "" });
		}
	}
	return { sent, received };
}

function resultRows<T>(result: D1Result<unknown> | undefined): T[] {
	return (result?.results ?? []) as T[];
}

export async function getHomeVersion(
	env: Bindings,
	uid: string,
): Promise<VersionRow> {
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT version, updated_at FROM home_state_versions WHERE uid = ?`,
	)
		.bind(uid)
		.first<VersionRow>();
	return row ?? { version: 1, updated_at: new Date(0).toISOString() };
}

export async function isHomeBalanceFresh(
	env: Bindings,
	uid: string,
): Promise<boolean> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`SELECT asset, balance_raw, decimals, block_number, block_hash,
			        consistency_level, projection_strategy, projection_version,
			        observed_at, reconciled_at, source
			 FROM balance_snapshots
			 WHERE uid = ? AND chain_id = ? AND canonical = 1
			 ORDER BY asset`,
		).bind(uid, network.chainId),
		prepareTransferCheckpointRowsForUid(
			env,
			network.chainId,
			uid,
		),
	]);
	const rows = resultRows<SnapshotRow>(results[0]);
	if (rows.length < expectedAssets(env).length) return false;
	const coverage = buildTransferCoverageByAsset(
		env,
		resultRows<TransferCheckpointRow>(results[1]),
	);
	return buildBalanceView(
		env,
		rows,
		null,
		new Date(),
		coverage,
	).status === "fresh";
}

export async function homeEtag(
	uid: string,
	chainId: number,
	version: number,
): Promise<string> {
	const bytes = new TextEncoder().encode(`${uid}:${chainId}:${version}`);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const opaque = Array.from(digest.slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `"home-${opaque}"`;
}

/**
 * One aggregate D1 batch. There are deliberately no RPC clients in this module.
 */
export async function readHomeModel(
	env: Bindings,
	uid: string,
): Promise<{ model: HomeReadModel; needsRefresh: boolean }> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`SELECT uid, wallet_address, username, display_name, social_url,
			        credential_id
			 FROM users WHERE uid = ? LIMIT 1`,
		).bind(uid),
		env.GATOPAGO_DB.prepare(
			`SELECT asset, balance_raw, decimals, block_number, block_hash,
			        consistency_level, projection_strategy, projection_version,
			        observed_at, reconciled_at, source
			 FROM balance_snapshots
			 WHERE uid = ? AND chain_id = ? AND canonical = 1
			 ORDER BY asset`,
		).bind(uid, network.chainId),
		env.GATOPAGO_DB.prepare(
			`SELECT l.id, l.direction, l.kind, l.tx_hash, l.token, l.amount,
			        l.amount_source, l.counterparty, l.reference, l.created_at,
			        counterparty_user.username AS counterparty_username,
			        counterparty_user.display_name AS counterparty_display_name
			 FROM ledger AS l
			 LEFT JOIN users AS counterparty_user
			   ON counterparty_user.uid = l.counterparty_uid
			 WHERE l.uid = ? AND l.canonical = 1
			 ORDER BY l.created_at DESC LIMIT 10`,
		).bind(uid),
		env.GATOPAGO_DB.prepare(
			`SELECT user_op_hash, status, currency, amount, created_at
			 FROM pending_payments
			 WHERE uid = ? AND status IN ('prepared', 'submitting', 'submitted')
			   AND (status <> 'prepared' OR expires_at > ?)
			 ORDER BY created_at DESC LIMIT 10`,
		).bind(uid, new Date().toISOString()),
		env.GATOPAGO_DB.prepare(
			`SELECT id, kind, status, tx_hash, created_at, updated_at
			 FROM account_operations
			 WHERE uid = ? AND status IN ('prepared', 'submitted', 'needs_review')
			 ORDER BY updated_at DESC LIMIT 10`,
		).bind(uid),
		env.GATOPAGO_DB.prepare(
			`SELECT status, updated_at FROM balance_refresh_requests
			 WHERE uid = ? AND chain_id = ? ORDER BY updated_at DESC LIMIT 1`,
		).bind(uid, network.chainId),
		env.GATOPAGO_DB.prepare(
			`SELECT version, updated_at FROM home_state_versions WHERE uid = ?`,
		).bind(uid),
		prepareTransferCheckpointRowsForUid(
			env,
			network.chainId,
			uid,
		),
	]);

	const profile =
		resultRows<ProfileRow>(results[0])[0] ??
		({
			uid,
			wallet_address: null,
			username: null,
			display_name: null,
			social_url: null,
			credential_id: null,
		} satisfies ProfileRow);
	const snapshotRows = resultRows<SnapshotRow>(results[1]);
	const ledgerRows = resultRows<LedgerHomeRow>(results[2]);
	const pendingRows = resultRows<PendingHomeRow>(results[3]);
	const accountOperationRows = resultRows<AccountOperationHomeRow>(results[4]);
	const refresh = resultRows<RefreshStateRow>(results[5])[0] ?? null;
	const version = resultRows<VersionRow>(results[6])[0] ?? {
		version: 1,
		updated_at: new Date(0).toISOString(),
	};
	const eventCoverage = buildTransferCoverageByAsset(
		env,
		resultRows<TransferCheckpointRow>(results[7]),
	);
	const now = new Date();
	const balance = buildBalanceView(
		env,
		snapshotRows,
		refresh,
		now,
		eventCoverage,
	);
	const activity = mapActivity(ledgerRows);
	const alerts: HomeReadModel["alerts"] = [];
	if (profile.wallet_address && balance.status === "unavailable") {
		alerts.push({ code: "BALANCE_BOOTSTRAP_PENDING", severity: "info" });
	} else if (balance.status === "stale") {
		alerts.push({ code: "BALANCE_STALE", severity: "warning" });
	}

	return {
		model: {
			schemaVersion: 1,
			identity: {
				uid,
				username: profile.username,
				displayName: profile.display_name,
				socialUrl: profile.social_url,
			},
			account: {
				walletAddress: profile.wallet_address as Address | null,
				chainId: network.chainId,
				chainKey: network.key,
				networkName: network.name,
			},
			balance,
			security: {
				status: "fresh",
				hasRegisteredPasskey: Boolean(profile.credential_id),
			},
			activity: {
				status: "fresh",
				...activity,
				source: "ledger",
			},
			operations: {
				status: "fresh",
				payments: pendingRows.map((row) => ({
					userOpHash: row.user_op_hash,
					status: row.status,
					currency: row.currency,
					amount: row.amount,
					createdAt: row.created_at,
				})),
				account: accountOperationRows.map((row) => ({
					id: row.id,
					kind: row.kind,
					status: row.status,
					txHash: row.tx_hash,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				})),
			},
			alerts,
			stateVersion: `home:${version.version}`,
			observedAt: now.toISOString(),
			consistentThroughBlock: balance.consistentThroughBlock,
		},
		needsRefresh:
			needsBalanceBootstrap(
				Boolean(profile.wallet_address),
				snapshotRows.length,
				expectedAssets(env).length,
			),
	};
}

export async function readBalanceModel(
	env: Bindings,
	uid: string,
): Promise<{
	walletAddress: Address | null;
	balance: HomeBalanceView;
	needsRefresh: boolean;
}> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const results = await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`SELECT wallet_address FROM users WHERE uid = ? LIMIT 1`,
		).bind(uid),
		env.GATOPAGO_DB.prepare(
			`SELECT asset, balance_raw, decimals, block_number, block_hash,
			        consistency_level, projection_strategy, projection_version,
			        observed_at, reconciled_at, source
			 FROM balance_snapshots
			 WHERE uid = ? AND chain_id = ? AND canonical = 1
			 ORDER BY asset`,
		).bind(uid, network.chainId),
		env.GATOPAGO_DB.prepare(
			`SELECT status, updated_at FROM balance_refresh_requests
			 WHERE uid = ? AND chain_id = ? ORDER BY updated_at DESC LIMIT 1`,
		).bind(uid, network.chainId),
		prepareTransferCheckpointRowsForUid(
			env,
			network.chainId,
			uid,
		),
	]);
	const walletAddress =
		(resultRows<{ wallet_address: string | null }>(results[0])[0]
			?.wallet_address as Address | null | undefined) ?? null;
	const rows = resultRows<SnapshotRow>(results[1]);
	const refresh = resultRows<RefreshStateRow>(results[2])[0] ?? null;
	const eventCoverage = buildTransferCoverageByAsset(
		env,
		resultRows<TransferCheckpointRow>(results[3]),
	);
	const balance = buildBalanceView(
		env,
		rows,
		refresh,
		new Date(),
		eventCoverage,
	);
	return {
		walletAddress,
		balance,
		needsRefresh:
			needsBalanceBootstrap(
				Boolean(walletAddress),
				rows.length,
				expectedAssets(env).length,
			),
	};
}

export async function ensureHomeBalanceRefresh(
	env: Bindings,
	model: HomeReadModel,
	reason: string,
): Promise<void> {
	if (!model.account.walletAddress) return;
	await requestBalanceRefresh(env, {
		uid: model.identity.uid,
		accountAddress: model.account.walletAddress,
		chainId: model.account.chainId,
		reason,
		priority: model.balance.status === "unavailable" ? 1 : 2,
	});
}

export const __test = {
	buildBalanceView,
	needsBalanceBootstrap,
};
