-- 0008: Earn (Aave v3 savings) — extend the ledger's kind enum with 'earn'.
--
-- Deposits/withdrawals to savings are the user's own money moving between their
-- available balance and their aToken position; they appear in the statement as
-- kind='earn' rows (deposit = out, withdraw = in).
--
-- SQLite can't alter a CHECK in place, so the ledger is rebuilt with the
-- standard copy-swap (same pattern as 0006). All rows are preserved verbatim.
--
-- DEPLOY ORDER: apply BEFORE deploying the Worker that ships with it.

PRAGMA defer_foreign_keys = on;

CREATE TABLE ledger_new (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	kind TEXT NOT NULL CHECK (kind IN ('payment', 'link', 'swap', 'fund', 'external', 'earn')),
	tx_hash TEXT NOT NULL,
	log_index INTEGER,                    -- set only for cron-ingested entries
	token TEXT NOT NULL,                  -- whitelisted symbol
	amount TEXT NOT NULL,                 -- human decimal string
	counterparty TEXT,                    -- address (lowercase) of the other side
	counterparty_uid TEXT,                -- set when the other side is internal
	reference TEXT,
	link_id TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

INSERT INTO ledger_new (
	id, uid, direction, kind, tx_hash, log_index, token, amount,
	counterparty, counterparty_uid, reference, link_id, created_at)
	SELECT id, uid, direction, kind, tx_hash, log_index, token, amount,
		counterparty, counterparty_uid, reference, link_id, created_at
	FROM ledger;

DROP TABLE ledger;
ALTER TABLE ledger_new RENAME TO ledger;

-- Idempotent writes: app entries use log_index NULL (-1 in the index); cron
-- entries carry the real log index, so re-scans can INSERT OR IGNORE safely.
CREATE UNIQUE INDEX idx_ledger_dedup
	ON ledger(uid, tx_hash, direction, token, IFNULL(log_index, -1));
CREATE INDEX idx_ledger_uid_created ON ledger(uid, created_at DESC);

PRAGMA defer_foreign_keys = off;
