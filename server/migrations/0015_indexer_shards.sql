-- Stable, append-only wallet assignment for bounded eth_getLogs filters.
--
-- Existing assignments never move merely because a new wallet sorts before
-- them. A reassignment creates a new version and requires a controlled
-- backfill before the shared stream cursor advances.

CREATE TABLE indexer_shards (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	shard_id INTEGER NOT NULL CHECK (shard_id >= 0),
	generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
	max_wallets INTEGER NOT NULL CHECK (max_wallets > 0),
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'draining', 'retired')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, stream, shard_id)
) STRICT;

CREATE TABLE indexer_wallet_assignments (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	account_address TEXT NOT NULL,
	uid TEXT NOT NULL,
	shard_id INTEGER NOT NULL,
	assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
	active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
	assigned_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (
		chain_id, stream, account_address, assignment_version
	),
	FOREIGN KEY (chain_id, stream, shard_id)
		REFERENCES indexer_shards(chain_id, stream, shard_id),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX idx_indexer_wallet_assignment_active
	ON indexer_wallet_assignments(chain_id, stream, account_address)
	WHERE active = 1;

CREATE INDEX idx_indexer_wallet_assignment_shard
	ON indexer_wallet_assignments(
		chain_id, stream, shard_id, active, account_address
	);
