-- Payment/link claims and durable webhook outbox constraints.

ALTER TABLE payment_links ADD COLUMN payment_claim TEXT;
ALTER TABLE payment_links ADD COLUMN payment_claim_expires_at TEXT;
ALTER TABLE payment_links ADD COLUMN payment_claim_tx_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_links_claim
	ON payment_links(payment_claim, payment_claim_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_event_endpoint
	ON webhook_deliveries(event_id, endpoint_id);

CREATE TABLE IF NOT EXISTS crosschain_mint_attempts (
	id TEXT PRIMARY KEY,
	op_id TEXT NOT NULL,
	tx_hash TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('broadcast', 'pending', 'success', 'reverted', 'unknown')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (op_id) REFERENCES crosschain_operations(op_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_crosschain_mint_attempts_op
	ON crosschain_mint_attempts(op_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cron_leases (
	key TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

-- Distinguish values parsed from executed logs from explicit quote fallbacks.
PRAGMA defer_foreign_keys = on;

CREATE TABLE ledger_integrity_new (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	kind TEXT NOT NULL CHECK (kind IN ('payment', 'link', 'swap', 'fund', 'external', 'earn')),
	tx_hash TEXT NOT NULL,
	log_index INTEGER,
	token TEXT NOT NULL,
	amount TEXT NOT NULL,
	amount_source TEXT NOT NULL DEFAULT 'executed' CHECK (amount_source IN ('executed', 'estimated')),
	counterparty TEXT,
	counterparty_uid TEXT,
	reference TEXT,
	link_id TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

INSERT INTO ledger_integrity_new (
	id, uid, direction, kind, tx_hash, log_index, token, amount, amount_source,
	counterparty, counterparty_uid, reference, link_id, created_at
)
	SELECT id, uid, direction, kind, tx_hash, log_index, token, amount, 'executed',
		counterparty, counterparty_uid, reference, link_id, created_at
	FROM ledger;

DROP TABLE ledger;
ALTER TABLE ledger_integrity_new RENAME TO ledger;

CREATE UNIQUE INDEX idx_ledger_dedup
	ON ledger(uid, tx_hash, direction, token, IFNULL(log_index, -1));
CREATE INDEX idx_ledger_uid_created ON ledger(uid, created_at DESC);

PRAGMA defer_foreign_keys = off;
