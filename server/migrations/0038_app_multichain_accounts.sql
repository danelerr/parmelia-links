-- Phase 4A: one GatoPago identity, explicit smart accounts per chain.
--
-- We do not aggregate fragmented on-chain balances into a fictitious balance.
-- Every account, operation and pending UserOperation keeps its execution chain.

CREATE TABLE account_security_versions (
	uid TEXT PRIMARY KEY,
	desired_version INTEGER NOT NULL DEFAULT 1 CHECK (desired_version > 0),
	updated_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

INSERT INTO account_security_versions(uid, desired_version, updated_at)
SELECT uid, 1, CURRENT_TIMESTAMP FROM users;

CREATE TABLE user_chain_accounts (
	uid TEXT NOT NULL,
	chain_id INTEGER NOT NULL CHECK (chain_id > 0),
	chain_key TEXT NOT NULL,
	network_name TEXT NOT NULL,
	wallet_address TEXT NOT NULL,
	is_home INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0, 1)),
	status TEXT NOT NULL CHECK (status IN (
		'deploying', 'active', 'failed', 'disabled'
	)),
	security_status TEXT NOT NULL CHECK (security_status IN (
		'current', 'needs_sync', 'syncing', 'failed'
	)),
	security_version_applied INTEGER NOT NULL DEFAULT 1 CHECK (security_version_applied > 0),
	deployment_tx_hash TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	activated_at TEXT,
	PRIMARY KEY (uid, chain_id),
	UNIQUE (chain_id, wallet_address),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_user_chain_accounts_chain_status
	ON user_chain_accounts(chain_id, status, wallet_address);

INSERT INTO user_chain_accounts (
	uid, chain_id, chain_key, network_name, wallet_address, is_home, status,
	security_status, security_version_applied, deployment_tx_hash,
	created_at, updated_at, activated_at
)
SELECT uid, 421614, 'arbitrum-sepolia', 'Arbitrum Sepolia', lower(wallet_address),
	1, 'active', 'current', 1, NULL,
	COALESCE(created_at, CURRENT_TIMESTAMP), COALESCE(updated_at, CURRENT_TIMESTAMP),
	COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM users
WHERE wallet_address IS NOT NULL;

ALTER TABLE account_operations ADD COLUMN chain_id INTEGER;
ALTER TABLE account_operations ADD COLUMN chain_key TEXT;

UPDATE account_operations
SET chain_id = 421614, chain_key = 'arbitrum-sepolia'
WHERE chain_id IS NULL;

DROP INDEX idx_account_operations_active_uid_kind;
CREATE UNIQUE INDEX idx_account_operations_active_uid_kind_chain
	ON account_operations(uid, kind, chain_id)
	WHERE status IN ('prepared', 'submitted', 'needs_review');

CREATE INDEX idx_account_operations_chain_status_updated
	ON account_operations(chain_id, status, updated_at);

ALTER TABLE pending_payments ADD COLUMN chain_id INTEGER;
ALTER TABLE pending_payments ADD COLUMN chain_key TEXT;

UPDATE pending_payments
SET chain_id = 421614, chain_key = 'arbitrum-sepolia'
WHERE chain_id IS NULL;

CREATE INDEX idx_pending_payments_chain_status
	ON pending_payments(chain_id, status, created_at);

CREATE UNIQUE INDEX idx_pending_security_sync_active
	ON pending_payments(uid, chain_id, currency)
	WHERE currency = 'PASSKEY_SYNC'
	  AND status IN ('prepared', 'submitting', 'submitted');

UPDATE ledger SET chain_id = 421614 WHERE chain_id IS NULL;

CREATE TRIGGER trg_security_version_passkey_insert
AFTER INSERT ON passkeys
BEGIN
	INSERT INTO account_security_versions(uid, desired_version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		desired_version = account_security_versions.desired_version + 1,
		updated_at = excluded.updated_at;
	UPDATE user_chain_accounts
	SET security_version_applied = CASE
			WHEN is_home = 1 THEN (SELECT desired_version FROM account_security_versions WHERE uid = NEW.uid)
			ELSE security_version_applied
		END,
		security_status = CASE WHEN is_home = 1 THEN 'current' ELSE 'needs_sync' END,
		updated_at = CURRENT_TIMESTAMP
	WHERE uid = NEW.uid AND status = 'active';
END;

CREATE TRIGGER trg_security_version_passkey_update
AFTER UPDATE OF qx, qy, revoked_at ON passkeys
WHEN OLD.qx <> NEW.qx OR OLD.qy <> NEW.qy OR IFNULL(OLD.revoked_at, '') <> IFNULL(NEW.revoked_at, '')
BEGIN
	INSERT INTO account_security_versions(uid, desired_version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		desired_version = account_security_versions.desired_version + 1,
		updated_at = excluded.updated_at;
	UPDATE user_chain_accounts
	SET security_version_applied = CASE
			WHEN is_home = 1 THEN (SELECT desired_version FROM account_security_versions WHERE uid = NEW.uid)
			ELSE security_version_applied
		END,
		security_status = CASE WHEN is_home = 1 THEN 'current' ELSE 'needs_sync' END,
		updated_at = CURRENT_TIMESTAMP
	WHERE uid = NEW.uid AND status = 'active';
END;

CREATE TRIGGER trg_home_state_chain_account_insert
AFTER INSERT ON user_chain_accounts
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_chain_account_update
AFTER UPDATE ON user_chain_accounts
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

-- Satellite accounts have their own indexer registry. The legacy registry is
-- deliberately kept for the Arbitrum home account so rolling deployments can
-- drain both formats safely.
CREATE TABLE chain_indexer_wallet_registry_outbox (
	uid TEXT NOT NULL,
	chain_id INTEGER NOT NULL CHECK (chain_id > 0),
	chain_key TEXT NOT NULL,
	wallet_address TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (uid, chain_id),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_chain_indexer_wallet_registry_due
	ON chain_indexer_wallet_registry_outbox(chain_id, status, next_attempt_at, updated_at);

INSERT INTO chain_indexer_wallet_registry_outbox (
	uid, chain_id, chain_key, wallet_address, status, attempt_count,
	next_attempt_at, last_error_code, created_at, updated_at
)
SELECT uid, chain_id, chain_key, lower(wallet_address), 'pending', 0,
	CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM user_chain_accounts
WHERE is_home = 0 AND status = 'active';

CREATE TRIGGER trg_chain_indexer_registry_account_insert
AFTER INSERT ON user_chain_accounts
WHEN NEW.is_home = 0 AND NEW.status = 'active'
BEGIN
	INSERT INTO chain_indexer_wallet_registry_outbox (
		uid, chain_id, chain_key, wallet_address, status, attempt_count,
		next_attempt_at, last_error_code, created_at, updated_at
	) VALUES (
		NEW.uid, NEW.chain_id, NEW.chain_key, lower(NEW.wallet_address),
		'pending', 0, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
	)
	ON CONFLICT(uid, chain_id) DO UPDATE SET
		chain_key = excluded.chain_key,
		wallet_address = excluded.wallet_address,
		status = 'pending',
		attempt_count = 0,
		next_attempt_at = excluded.next_attempt_at,
		last_error_code = NULL,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_chain_indexer_registry_account_update
AFTER UPDATE OF wallet_address, status, chain_key ON user_chain_accounts
WHEN NEW.is_home = 0 AND (
	OLD.wallet_address <> NEW.wallet_address OR
	OLD.status <> NEW.status OR
	OLD.chain_key <> NEW.chain_key
)
BEGIN
	INSERT INTO chain_indexer_wallet_registry_outbox (
		uid, chain_id, chain_key, wallet_address, status, attempt_count,
		next_attempt_at, last_error_code, created_at, updated_at
	) VALUES (
		NEW.uid, NEW.chain_id, NEW.chain_key,
		CASE WHEN NEW.status = 'active' THEN lower(NEW.wallet_address) ELSE NULL END,
		'pending', 0, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
	)
	ON CONFLICT(uid, chain_id) DO UPDATE SET
		chain_key = excluded.chain_key,
		wallet_address = excluded.wallet_address,
		status = 'pending',
		attempt_count = 0,
		next_attempt_at = excluded.next_attempt_at,
		last_error_code = NULL,
		updated_at = excluded.updated_at;
END;
