-- Chain-wide reorg coordination.
--
-- Every journal write opens an ephemeral guard inside the same D1 batch. The
-- trigger aborts the whole transaction when a concurrent reorg has advanced
-- the chain epoch, preventing an older Queue delivery from republishing stale
-- canonical evidence after rollback.

CREATE TABLE chain_reorg_state (
	chain_id INTEGER PRIMARY KEY,
	epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
	common_ancestor_number INTEGER CHECK (
		common_ancestor_number IS NULL OR common_ancestor_number >= 0
	),
	common_ancestor_hash TEXT,
	updated_at TEXT NOT NULL
) STRICT;

ALTER TABLE chain_stream_checkpoints
	ADD COLUMN reorg_epoch INTEGER NOT NULL DEFAULT 0 CHECK (reorg_epoch >= 0);

CREATE TABLE chain_reorg_epoch_guards (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	expected_epoch INTEGER NOT NULL CHECK (expected_epoch >= 0),
	created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER trg_chain_reorg_epoch_guard
BEFORE INSERT ON chain_reorg_epoch_guards
WHEN COALESCE(
	(SELECT epoch FROM chain_reorg_state WHERE chain_id = NEW.chain_id),
	0
) <> NEW.expected_epoch
BEGIN
	SELECT RAISE(ABORT, 'CHAIN_REORG_EPOCH_STALE');
END;

CREATE TABLE chain_reorg_replay_requests (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	common_ancestor_number INTEGER NOT NULL CHECK (common_ancestor_number >= 0),
	reorg_epoch INTEGER NOT NULL CHECK (reorg_epoch > 0),
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, stream)
) STRICT;

CREATE INDEX idx_chain_reorg_replay_due
	ON chain_reorg_replay_requests(status, next_attempt_at, updated_at);

-- Cursor durable for a bounded, resumable safety cycle. A large installation
-- never fans every shard out from one Worker invocation.
CREATE TABLE indexer_safety_sweep_state (
	chain_id INTEGER PRIMARY KEY,
	target_block INTEGER NOT NULL CHECK (target_block >= 0),
	cursor_stream TEXT NOT NULL,
	cursor_shard_id INTEGER NOT NULL CHECK (cursor_shard_id >= -1),
	cycle_started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
