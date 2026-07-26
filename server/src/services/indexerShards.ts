import type { Bindings } from "../middlewares/auth";

export type IndexerWallet = {
	uid: string;
	walletAddress: string;
};

export type WalletShardAssignment = {
	stream: string;
	shardId: number;
	uid: string;
	walletAddress: string;
};

function normalizeWalletAddress(value: string): string {
	const normalized = value.toLowerCase();
	if (!/^0x[0-9a-f]{40}$/u.test(normalized)) {
		throw new Error("Indexer wallet address is malformed");
	}
	return normalized;
}

/**
 * Assign one changed wallet without scanning the global user population.
 * The registry job has one lease per chain, so capacity selection and inserts
 * are serialized without turning every chain reader into a singleton.
 */
export async function assignWalletToStableShard(
	env: Bindings,
	input: {
		chainId: number;
		stream: string;
		uid: string;
		walletAddress: string | null;
		maxWallets: number;
	},
): Promise<WalletShardAssignment | null> {
	if (!Number.isSafeInteger(input.maxWallets) || input.maxWallets < 1) {
		throw new Error("Indexer shard capacity must be a positive safe integer");
	}
	const walletAddress =
		input.walletAddress === null
			? null
			: normalizeWalletAddress(input.walletAddress);
	const now = new Date().toISOString();
	await env.PARMELIA_DB.prepare(
		`UPDATE indexer_wallet_assignments
		 SET active = 0, updated_at = ?
		 WHERE chain_id = ? AND stream = ? AND uid = ? AND active = 1
		   AND (? IS NULL OR account_address <> ?)`,
	)
		.bind(
			now,
			input.chainId,
			input.stream,
			input.uid,
			walletAddress,
			walletAddress,
		)
		.run();
	if (walletAddress === null) return null;

	const current = await env.PARMELIA_DB.prepare(
		`SELECT shard_id
		 FROM indexer_wallet_assignments
		 WHERE chain_id = ? AND stream = ? AND account_address = ?
		   AND uid = ? AND active = 1
		 LIMIT 1`,
	)
		.bind(input.chainId, input.stream, walletAddress, input.uid)
		.first<{ shard_id: number }>();
	if (current) {
		return {
			stream: input.stream,
			shardId: current.shard_id,
			uid: input.uid,
			walletAddress,
		};
	}

	// Wallet ownership changes create a new append-only assignment version.
	await env.PARMELIA_DB.prepare(
		`UPDATE indexer_wallet_assignments
		 SET active = 0, updated_at = ?
		 WHERE chain_id = ? AND stream = ? AND account_address = ?
		   AND active = 1`,
	)
		.bind(now, input.chainId, input.stream, walletAddress)
		.run();

	let shard = await env.PARMELIA_DB.prepare(
		`SELECT s.shard_id
		 FROM indexer_shards s
		 LEFT JOIN indexer_wallet_assignments a
		   ON a.chain_id = s.chain_id
		  AND a.stream = s.stream
		  AND a.shard_id = s.shard_id
		  AND a.active = 1
		 WHERE s.chain_id = ? AND s.stream = ? AND s.status = 'active'
		 GROUP BY s.shard_id, s.max_wallets
		 HAVING COUNT(a.account_address) < s.max_wallets
		 ORDER BY s.shard_id
		 LIMIT 1`,
	)
		.bind(input.chainId, input.stream)
		.first<{ shard_id: number }>();
	if (!shard) {
		const next = await env.PARMELIA_DB.prepare(
			`SELECT COALESCE(MAX(shard_id), -1) + 1 AS shard_id
			 FROM indexer_shards
			 WHERE chain_id = ? AND stream = ?`,
		)
			.bind(input.chainId, input.stream)
			.first<{ shard_id: number }>();
		const shardId = next?.shard_id ?? 0;
		await env.PARMELIA_DB.prepare(
			`INSERT INTO indexer_shards (
				chain_id, stream, shard_id, generation, max_wallets, status,
				created_at, updated_at
			 ) VALUES (?, ?, ?, 1, ?, 'active', ?, ?)`,
		)
			.bind(
				input.chainId,
				input.stream,
				shardId,
				input.maxWallets,
				now,
				now,
			)
			.run();
		shard = { shard_id: shardId };
	}
	const latestVersion = await env.PARMELIA_DB.prepare(
		`SELECT COALESCE(MAX(assignment_version), 0) AS version
		 FROM indexer_wallet_assignments
		 WHERE chain_id = ? AND stream = ? AND account_address = ?`,
	)
		.bind(input.chainId, input.stream, walletAddress)
		.first<{ version: number }>();
	await env.PARMELIA_DB.prepare(
		`INSERT INTO indexer_wallet_assignments (
			chain_id, stream, account_address, uid, shard_id,
			assignment_version, active, assigned_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
	)
		.bind(
			input.chainId,
			input.stream,
			walletAddress,
			input.uid,
			shard.shard_id,
			(latestVersion?.version ?? 0) + 1,
			now,
			now,
		)
		.run();
	return {
		stream: input.stream,
		shardId: shard.shard_id,
		uid: input.uid,
		walletAddress,
	};
}

export async function listWalletsForIndexerShard(
	env: Bindings,
	input: { chainId: number; stream: string; shardId: number },
): Promise<IndexerWallet[]> {
	const result = await env.PARMELIA_DB.prepare(
		`SELECT uid, account_address
		 FROM indexer_wallet_assignments
		 WHERE chain_id = ? AND stream = ? AND shard_id = ? AND active = 1
		 ORDER BY account_address`,
	)
		.bind(input.chainId, input.stream, input.shardId)
		.all<{ uid: string; account_address: string }>();
	return result.results.map((row) => ({
		uid: row.uid,
		walletAddress: row.account_address,
	}));
}

export async function listIndexerShardIds(
	env: Bindings,
	input: { chainId: number; stream: string },
): Promise<number[]> {
	const result = await env.PARMELIA_DB.prepare(
		`SELECT shard_id
		 FROM indexer_shards
		 WHERE chain_id = ? AND stream = ? AND status = 'active'
		 ORDER BY shard_id`,
	)
		.bind(input.chainId, input.stream)
		.all<{ shard_id: number }>();
	return result.results.map((row) => row.shard_id);
}

export async function listWalletShardAssignments(
	env: Bindings,
	input: {
		chainId: number;
		streams: readonly string[];
		walletAddresses: readonly string[];
	},
): Promise<WalletShardAssignment[]> {
	const addresses = [...new Set(
		input.walletAddresses.map(normalizeWalletAddress),
	)];
	if (input.streams.length === 0 || addresses.length === 0) return [];
	const streamPlaceholders = input.streams.map(() => "?").join(", ");
	const addressPlaceholders = addresses.map(() => "?").join(", ");
	const result = await env.PARMELIA_DB.prepare(
		`SELECT stream, shard_id, uid, account_address
		 FROM indexer_wallet_assignments
		 WHERE chain_id = ? AND active = 1
		   AND stream IN (${streamPlaceholders})
		   AND account_address IN (${addressPlaceholders})`,
	)
		.bind(input.chainId, ...input.streams, ...addresses)
		.all<{
			stream: string;
			shard_id: number;
			uid: string;
			account_address: string;
		}>();
	return result.results.map((row) => ({
		stream: row.stream,
		shardId: row.shard_id,
		uid: row.uid,
		walletAddress: row.account_address,
	}));
}
