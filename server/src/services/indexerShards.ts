import type { Bindings } from "../middlewares/auth";

export type IndexerWallet = {
	uid: string;
	walletAddress: string;
};

export type StableWalletShard = {
	shardId: number;
	wallets: IndexerWallet[];
};

export type StableWalletShardResult = {
	shards: StableWalletShard[];
	assignmentsChanged: boolean;
};

type AssignmentRow = {
	account_address: string;
	uid: string;
	shard_id: number;
	assignment_version: number;
	active: number;
};

type ShardRow = {
	shard_id: number;
	max_wallets: number;
	status: "active" | "draining" | "retired";
};

function normalizeWallets(wallets: readonly IndexerWallet[]): IndexerWallet[] {
	const byAddress = new Map<string, IndexerWallet>();
	for (const wallet of wallets) {
		const address = wallet.walletAddress.toLowerCase();
		const prior = byAddress.get(address);
		if (prior && prior.uid !== wallet.uid) {
			throw new Error(`Wallet ${address} belongs to more than one user`);
		}
		byAddress.set(address, { uid: wallet.uid, walletAddress: address });
	}
	return [...byAddress.values()].sort((left, right) =>
		left.walletAddress.localeCompare(right.walletAddress),
	);
}

async function executeAssignmentWrites(
	env: Bindings,
	statements: D1PreparedStatement[],
): Promise<void> {
	// Keep first-time onboarding of a large wallet population below practical
	// D1 batch/subrequest limits. Ordering is preserved (shard row precedes its
	// assignments), and every statement is idempotently repairable on rerun.
	const batchSize = 100;
	for (let index = 0; index < statements.length; index += batchSize) {
		await env.PARMELIA_DB.batch(statements.slice(index, index + batchSize));
	}
}

/**
 * Synchronize the current user set into durable, append-only filter shards.
 *
 * Existing active wallets never move. New wallets fill the lowest active shard
 * with capacity; a removed/re-owned wallet closes its old assignment and gets a
 * new version. `assignmentsChanged` tells the caller to perform a bounded
 * backfill before advancing its shared cursor.
 */
export async function syncStableWalletShards(
	env: Bindings,
	input: {
		chainId: number;
		stream: string;
		wallets: readonly IndexerWallet[];
		maxWallets: number;
	},
): Promise<StableWalletShardResult> {
	if (!Number.isSafeInteger(input.maxWallets) || input.maxWallets < 1) {
		throw new Error("Indexer shard capacity must be a positive safe integer");
	}
	const current = normalizeWallets(input.wallets);
	const [assignmentResult, shardResult] = await Promise.all([
		env.PARMELIA_DB.prepare(
			`SELECT account_address, uid, shard_id, assignment_version, active
			 FROM indexer_wallet_assignments
			 WHERE chain_id = ? AND stream = ?
			 ORDER BY account_address, assignment_version`,
		)
			.bind(input.chainId, input.stream)
			.all<AssignmentRow>(),
		env.PARMELIA_DB.prepare(
			`SELECT shard_id, max_wallets, status
			 FROM indexer_shards
			 WHERE chain_id = ? AND stream = ?
			 ORDER BY shard_id`,
		)
			.bind(input.chainId, input.stream)
			.all<ShardRow>(),
	]);

	const currentByAddress = new Map(
		current.map((wallet) => [wallet.walletAddress, wallet]),
	);
	const historyByAddress = new Map<string, AssignmentRow[]>();
	for (const row of assignmentResult.results) {
		const history = historyByAddress.get(row.account_address) ?? [];
		history.push(row);
		historyByAddress.set(row.account_address, history);
	}
	const activeByAddress = new Map(
		assignmentResult.results
			.filter((row) => row.active === 1)
			.map((row) => [row.account_address, row]),
	);
	const knownShards = new Map(
		shardResult.results.map((row) => [row.shard_id, row]),
	);
	const occupancy = new Map<number, number>();
	const targetAssignments = new Map<
		string,
		{ wallet: IndexerWallet; shardId: number }
	>();
	const statements: D1PreparedStatement[] = [];
	const now = new Date().toISOString();

	for (const row of activeByAddress.values()) {
		const wallet = currentByAddress.get(row.account_address);
		if (wallet && wallet.uid === row.uid) {
			targetAssignments.set(row.account_address, {
				wallet,
				shardId: row.shard_id,
			});
			occupancy.set(row.shard_id, (occupancy.get(row.shard_id) ?? 0) + 1);
			continue;
		}
		statements.push(
			env.PARMELIA_DB.prepare(
				`UPDATE indexer_wallet_assignments
				 SET active = 0, updated_at = ?
				 WHERE chain_id = ? AND stream = ? AND account_address = ?
				   AND assignment_version = ? AND active = 1`,
			).bind(
				now,
				input.chainId,
				input.stream,
				row.account_address,
				row.assignment_version,
			),
		);
	}

	for (const [shardId, count] of occupancy) {
		const shard = knownShards.get(shardId);
		if (!shard || shard.status !== "active") {
			throw new Error(`Active wallet assignment references unavailable shard ${shardId}`);
		}
		if (count > input.maxWallets) {
			throw new Error(
				`Shard ${shardId} has ${count} wallets; reducing capacity requires controlled resharding`,
			);
		}
	}

	let nextShardId =
		Math.max(-1, ...knownShards.keys()) + 1;
	const ensureShard = (shardId: number) => {
		if (knownShards.has(shardId)) return;
		knownShards.set(shardId, {
			shard_id: shardId,
			max_wallets: input.maxWallets,
			status: "active",
		});
		statements.push(
			env.PARMELIA_DB.prepare(
				`INSERT OR IGNORE INTO indexer_shards (
					chain_id, stream, shard_id, generation, max_wallets, status,
					created_at, updated_at
				 ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?)`,
			).bind(
				input.chainId,
				input.stream,
				shardId,
				input.maxWallets,
				now,
				now,
			),
		);
	};

	for (const wallet of current) {
		if (targetAssignments.has(wallet.walletAddress)) continue;
		const history = historyByAddress.get(wallet.walletAddress) ?? [];
		const preferred = history.at(-1)?.shard_id;
		let shardId =
			preferred !== undefined &&
			knownShards.get(preferred)?.status === "active" &&
			(occupancy.get(preferred) ?? 0) < input.maxWallets
				? preferred
				: [...knownShards.values()]
						.filter(
							(shard) =>
								shard.status === "active" &&
								(occupancy.get(shard.shard_id) ?? 0) < input.maxWallets,
						)
						.sort((left, right) => left.shard_id - right.shard_id)[0]
						?.shard_id;
		if (shardId === undefined) {
			shardId = nextShardId++;
			ensureShard(shardId);
		}
		ensureShard(shardId);
		const nextVersion =
			(history.at(-1)?.assignment_version ?? 0) + 1;
		statements.push(
			env.PARMELIA_DB.prepare(
				`INSERT INTO indexer_wallet_assignments (
					chain_id, stream, account_address, uid, shard_id,
					assignment_version, active, assigned_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
			).bind(
				input.chainId,
				input.stream,
				wallet.walletAddress,
				wallet.uid,
				shardId,
				nextVersion,
				now,
				now,
			),
		);
		occupancy.set(shardId, (occupancy.get(shardId) ?? 0) + 1);
		targetAssignments.set(wallet.walletAddress, { wallet, shardId });
	}

	if (statements.length > 0) await executeAssignmentWrites(env, statements);
	const grouped = new Map<number, IndexerWallet[]>();
	for (const assignment of targetAssignments.values()) {
		const wallets = grouped.get(assignment.shardId) ?? [];
		wallets.push(assignment.wallet);
		grouped.set(assignment.shardId, wallets);
	}
	return {
		shards: [...grouped.entries()]
			.sort(([left], [right]) => left - right)
			.map(([shardId, wallets]) => ({
				shardId,
				wallets: wallets.sort((left, right) =>
					left.walletAddress.localeCompare(right.walletAddress),
				),
			})),
		assignmentsChanged: statements.length > 0,
	};
}
