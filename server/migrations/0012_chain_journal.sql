-- Canonical on-chain journal and replayable projection checkpoints.
--
-- This migration is expand-only. Existing ledger/sync_state readers continue
-- to work while the V2 journal runs in shadow/dual-write mode.

CREATE TABLE chain_blocks (
	chain_id INTEGER NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	parent_hash TEXT,
	block_timestamp TEXT,
	consistency_level TEXT NOT NULL CHECK (consistency_level IN (
		'sequenced', 'batch_posted', 'l1_confirmed', 'assertion_confirmed',
		'safe', 'finalized'
	)),
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0, 1)),
	source TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, block_number, block_hash)
) STRICT;

CREATE UNIQUE INDEX idx_chain_blocks_canonical_height
	ON chain_blocks(chain_id, block_number)
	WHERE canonical = 1;

CREATE INDEX idx_chain_blocks_hash
	ON chain_blocks(chain_id, block_hash);

CREATE TABLE chain_events (
	-- Stable identity independent of the block in which a transaction lands.
	event_id TEXT NOT NULL,
	chain_id INTEGER NOT NULL,
	tx_hash TEXT NOT NULL,
	log_index INTEGER NOT NULL CHECK (log_index >= 0),
	event_kind TEXT NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	transaction_index INTEGER,
	contract_address TEXT NOT NULL,
	topic0 TEXT,
	payload_json TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0, 1)),
	source TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (event_id, block_hash),
	FOREIGN KEY (chain_id, block_number, block_hash)
		REFERENCES chain_blocks(chain_id, block_number, block_hash)
) STRICT;

-- A transaction/log may be re-included in a different block after a reorg, but
-- only one occurrence may be canonical at a time. The old occurrence remains
-- available for audit and rollback.
CREATE UNIQUE INDEX idx_chain_events_canonical_identity
	ON chain_events(chain_id, tx_hash, log_index, event_kind)
	WHERE canonical = 1;

CREATE INDEX idx_chain_events_canonical_order
	ON chain_events(chain_id, canonical, block_number, transaction_index, log_index);

CREATE INDEX idx_chain_events_contract_topic
	ON chain_events(chain_id, contract_address, topic0, block_number);

CREATE TABLE chain_event_accounts (
	event_id TEXT NOT NULL,
	block_hash TEXT NOT NULL,
	uid TEXT NOT NULL,
	account_address TEXT NOT NULL,
	asset TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('from', 'to', 'account', 'payer', 'recipient')),
	delta_raw TEXT,
	PRIMARY KEY (event_id, block_hash, uid, role, asset),
	FOREIGN KEY (event_id, block_hash)
		REFERENCES chain_events(event_id, block_hash) ON DELETE CASCADE,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_chain_event_accounts_uid_order
	ON chain_event_accounts(uid, asset, event_id);

CREATE TABLE chain_stream_checkpoints (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	consistency_level TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, stream)
) STRICT;

CREATE TABLE projection_watermarks (
	chain_id INTEGER NOT NULL,
	projector TEXT NOT NULL,
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	checkpoint_json TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, projector, projection_version)
) STRICT;

CREATE TABLE projection_applied_events (
	chain_id INTEGER NOT NULL,
	projector TEXT NOT NULL,
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	event_id TEXT NOT NULL,
	block_hash TEXT NOT NULL,
	applied_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, projector, projection_version, event_id, block_hash),
	FOREIGN KEY (event_id, block_hash)
		REFERENCES chain_events(event_id, block_hash)
) STRICT;

CREATE TABLE balance_projection_deltas (
	chain_id INTEGER NOT NULL,
	projector TEXT NOT NULL,
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	event_id TEXT NOT NULL,
	block_hash TEXT NOT NULL,
	uid TEXT NOT NULL,
	account_address TEXT NOT NULL,
	asset TEXT NOT NULL,
	delta_raw TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0, 1)),
	applied_at TEXT NOT NULL,
	reverted_at TEXT,
	PRIMARY KEY (
		chain_id, projector, projection_version, event_id, block_hash, uid, asset
	),
	FOREIGN KEY (event_id, block_hash)
		REFERENCES chain_events(event_id, block_hash),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_balance_projection_deltas_account
	ON balance_projection_deltas(
		chain_id, account_address, asset, canonical, applied_at
	);

-- Delivery ids are intentionally separate from journal ids. A provider may
-- redeliver the same envelope; this table records observability without making
-- the provider envelope the source of financial idempotency.
CREATE TABLE chain_source_deliveries (
	provider TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	webhook_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('received', 'processed', 'rejected')),
	event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
	first_seen_at TEXT NOT NULL,
	processed_at TEXT,
	last_error_code TEXT,
	PRIMARY KEY (provider, delivery_id)
) STRICT;

