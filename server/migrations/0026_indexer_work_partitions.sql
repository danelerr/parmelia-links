-- Incremental wallet registry for horizontally partitioned chain readers.
--
-- User mutations write this outbox in the same D1 transaction as the user row.
-- A queue job assigns only changed wallets to stable shards; no indexer job
-- needs to load the complete user table into Worker memory.

CREATE TABLE indexer_wallet_registry_outbox (
	uid TEXT PRIMARY KEY,
	wallet_address TEXT,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_indexer_wallet_registry_due
	ON indexer_wallet_registry_outbox(status, next_attempt_at, updated_at);

INSERT INTO indexer_wallet_registry_outbox (
	uid, wallet_address, status, attempt_count, next_attempt_at,
	last_error_code, created_at, updated_at
)
SELECT
	uid, lower(wallet_address), 'pending', 0, CURRENT_TIMESTAMP,
	NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users
WHERE wallet_address IS NOT NULL;

CREATE TRIGGER trg_indexer_wallet_registry_user_insert
AFTER INSERT ON users
BEGIN
	INSERT INTO indexer_wallet_registry_outbox (
		uid, wallet_address, status, attempt_count, next_attempt_at,
		last_error_code, created_at, updated_at
	) VALUES (
		NEW.uid, lower(NEW.wallet_address), 'pending', 0, CURRENT_TIMESTAMP,
		NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
	)
	ON CONFLICT(uid) DO UPDATE SET
		wallet_address = excluded.wallet_address,
		status = 'pending',
		attempt_count = 0,
		next_attempt_at = excluded.next_attempt_at,
		last_error_code = NULL,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_indexer_wallet_registry_user_wallet_update
AFTER UPDATE OF wallet_address ON users
WHEN OLD.wallet_address IS NOT NEW.wallet_address
BEGIN
	INSERT INTO indexer_wallet_registry_outbox (
		uid, wallet_address, status, attempt_count, next_attempt_at,
		last_error_code, created_at, updated_at
	) VALUES (
		NEW.uid, lower(NEW.wallet_address), 'pending', 0, CURRENT_TIMESTAMP,
		NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
	)
	ON CONFLICT(uid) DO UPDATE SET
		wallet_address = excluded.wallet_address,
		status = 'pending',
		attempt_count = 0,
		next_attempt_at = excluded.next_attempt_at,
		last_error_code = NULL,
		updated_at = excluded.updated_at;
END;

-- Local mirror of managed-provider address subscriptions. Reconciliation uses
-- indexed SQL diffs and bounded 500-address mutations instead of downloading
-- up to 100k remote addresses on every wallet change.
CREATE TABLE provider_subscription_items (
	provider TEXT NOT NULL,
	subscription_id TEXT NOT NULL,
	item TEXT NOT NULL,
	synced_at TEXT NOT NULL,
	PRIMARY KEY (provider, subscription_id, item)
) STRICT;

CREATE TABLE provider_subscription_sync_state (
	provider TEXT NOT NULL,
	subscription_id TEXT NOT NULL,
	phase TEXT NOT NULL DEFAULT 'scanning'
		CHECK (phase IN ('scanning', 'ready')),
	next_cursor TEXT,
	scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider, subscription_id)
) STRICT;
