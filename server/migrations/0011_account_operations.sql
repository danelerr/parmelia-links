-- Durable lifecycle for server-signed account, faucet and recovery transactions.
-- The signed raw transaction is persisted before broadcast, so a Worker death
-- cannot lose the only handle needed to rebroadcast and reconcile it.

CREATE TABLE account_operations (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN (
		'account_create', 'faucet', 'recovery_propose', 'recovery_execute', 'recovery_cancel'
	)),
	status TEXT NOT NULL CHECK (status IN (
		'prepared', 'submitted', 'confirmed', 'failed', 'needs_review'
	)),
	tx_hash TEXT NOT NULL UNIQUE,
	raw_transaction TEXT NOT NULL,
	signer_address TEXT NOT NULL,
	nonce INTEGER NOT NULL CHECK (nonce >= 0),
	metadata TEXT NOT NULL DEFAULT '{}',
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	last_error TEXT,
	error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	confirmed_at TEXT,
	expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_account_operations_uid_created
	ON account_operations(uid, created_at DESC);

CREATE INDEX idx_account_operations_status_updated
	ON account_operations(status, updated_at);

CREATE INDEX idx_account_operations_signer_status
	ON account_operations(signer_address, status, updated_at);

CREATE UNIQUE INDEX idx_account_operations_active_uid_kind
	ON account_operations(uid, kind)
	WHERE status IN ('prepared', 'submitted', 'needs_review');
