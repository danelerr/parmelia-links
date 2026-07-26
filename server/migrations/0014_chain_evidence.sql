-- Add canonical integer/evidence fields without changing existing readers.
-- Historical values remain nullable until a verified, resumable backfill runs.

ALTER TABLE ledger ADD COLUMN amount_raw TEXT;
ALTER TABLE ledger ADD COLUMN decimals INTEGER;
ALTER TABLE ledger ADD COLUMN chain_id INTEGER;
ALTER TABLE ledger ADD COLUMN block_number INTEGER;
ALTER TABLE ledger ADD COLUMN block_hash TEXT;
ALTER TABLE ledger ADD COLUMN transaction_index INTEGER;
ALTER TABLE ledger ADD COLUMN consistency_level TEXT;
ALTER TABLE ledger ADD COLUMN projection_version INTEGER;
ALTER TABLE ledger ADD COLUMN canonical INTEGER NOT NULL DEFAULT 1
	CHECK (canonical IN (0, 1));

CREATE INDEX idx_ledger_uid_chain_order
	ON ledger(uid, canonical, chain_id, block_number DESC, transaction_index DESC, log_index DESC, id DESC);

CREATE TABLE chain_reorg_incidents (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	detected_at TEXT NOT NULL,
	previous_block_number INTEGER NOT NULL,
	previous_block_hash TEXT NOT NULL,
	observed_block_hash TEXT NOT NULL,
	common_ancestor_number INTEGER,
	common_ancestor_hash TEXT,
	depth INTEGER,
	status TEXT NOT NULL CHECK (status IN ('recovered', 'outside_window', 'open')),
	affected_events INTEGER NOT NULL DEFAULT 0,
	affected_accounts INTEGER NOT NULL DEFAULT 0,
	detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_chain_reorg_incidents_chain_time
	ON chain_reorg_incidents(chain_id, detected_at DESC);
