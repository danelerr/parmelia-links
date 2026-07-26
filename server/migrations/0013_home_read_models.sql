-- D1 read models for a zero-RPC Home request path.
--
-- All balances remain block-evidenced caches/projections. The blockchain is
-- still the source of truth; an absent row is "unavailable", never zero.

CREATE TABLE balance_snapshots (
	uid TEXT NOT NULL,
	account_address TEXT NOT NULL,
	chain_id INTEGER NOT NULL,
	asset TEXT NOT NULL,
	balance_raw TEXT NOT NULL,
	decimals INTEGER NOT NULL CHECK (decimals >= 0 AND decimals <= 255),
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	consistency_level TEXT NOT NULL,
	projection_strategy TEXT NOT NULL CHECK (projection_strategy IN (
		'events', 'events_plus_rpc', 'rpc_only', 'known_operations'
	)),
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	observed_at TEXT NOT NULL,
	reconciled_at TEXT,
	source TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0, 1)),
	PRIMARY KEY (chain_id, account_address, asset),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_balance_snapshots_age
	ON balance_snapshots(chain_id, observed_at);

CREATE INDEX idx_balance_snapshots_uid
	ON balance_snapshots(uid, chain_id, asset);

CREATE TABLE balance_refresh_requests (
	chain_id INTEGER NOT NULL,
	account_address TEXT NOT NULL,
	uid TEXT NOT NULL,
	schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
	reason TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 4),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
		'pending', 'processing', 'completed', 'failed'
	)),
	required_block INTEGER,
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	requested_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_error_code TEXT,
	PRIMARY KEY (chain_id, account_address),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_balance_refresh_due
	ON balance_refresh_requests(status, priority, requested_at);

CREATE TABLE asset_indexing_policies (
	chain_id INTEGER NOT NULL,
	asset TEXT NOT NULL,
	contract_address TEXT,
	strategy TEXT NOT NULL CHECK (strategy IN (
		'events', 'events_plus_rpc', 'rpc_only', 'known_operations'
	)),
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	drift_tolerance_raw TEXT NOT NULL DEFAULT '0',
	config_json TEXT NOT NULL DEFAULT '{}',
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, asset)
) STRICT;

CREATE TABLE home_state_versions (
	uid TEXT PRIMARY KEY,
	version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
	updated_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

-- Version changes are automatic so future writers cannot forget to invalidate
-- the aggregate Home model. ETags are derived from uid + chain + this version.
CREATE TRIGGER trg_home_state_user_insert
AFTER INSERT ON users
BEGIN
	INSERT OR IGNORE INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP);
END;

CREATE TRIGGER trg_home_state_user_update
AFTER UPDATE ON users
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_ledger_insert
AFTER INSERT ON ledger
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_pending_insert
AFTER INSERT ON pending_payments
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_pending_update
AFTER UPDATE ON pending_payments
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_account_operation_insert
AFTER INSERT ON account_operations
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	SELECT NEW.uid, 1, CURRENT_TIMESTAMP
	WHERE EXISTS (SELECT 1 FROM users WHERE uid = NEW.uid)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_account_operation_update
AFTER UPDATE ON account_operations
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	SELECT NEW.uid, 1, CURRENT_TIMESTAMP
	WHERE EXISTS (SELECT 1 FROM users WHERE uid = NEW.uid)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_balance_insert
AFTER INSERT ON balance_snapshots
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_state_balance_update
AFTER UPDATE ON balance_snapshots
WHEN
	OLD.balance_raw <> NEW.balance_raw OR
	OLD.block_number <> NEW.block_number OR
	OLD.block_hash <> NEW.block_hash OR
	OLD.consistency_level <> NEW.consistency_level OR
	OLD.projection_version <> NEW.projection_version OR
	OLD.canonical <> NEW.canonical
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

-- Existing users predate the insert trigger.
INSERT OR IGNORE INTO home_state_versions(uid, version, updated_at)
SELECT uid, 1, CURRENT_TIMESTAMP FROM users;
