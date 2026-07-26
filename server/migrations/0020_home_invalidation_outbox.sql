-- Every durable Home state change emits a deduped invalidation row. Triggers
-- keep future writers honest; delivery reads the latest state version and
-- collapses obsolete rows per user.

CREATE TRIGGER trg_home_outbox_user_update
AFTER UPDATE ON users
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:user:' || NEW.uid || ':' || NEW.updated_at,
		'home:user:' || NEW.uid || ':' || NEW.updated_at,
		NEW.uid, 'home.invalidate', '{}', 2, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_ledger_insert
AFTER INSERT ON ledger
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:ledger:' || NEW.id,
		'home:ledger:' || NEW.id,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_state_ledger_update
AFTER UPDATE ON ledger
WHEN
	OLD.canonical <> NEW.canonical OR
	OLD.block_hash IS NOT NEW.block_hash OR
	OLD.block_number IS NOT NEW.block_number OR
	OLD.amount <> NEW.amount
BEGIN
	INSERT INTO home_state_versions(uid, version, updated_at)
	VALUES (NEW.uid, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	ON CONFLICT(uid) DO UPDATE SET
		version = home_state_versions.version + 1,
		updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_home_outbox_ledger_update
AFTER UPDATE ON ledger
WHEN
	OLD.canonical <> NEW.canonical OR
	OLD.block_hash IS NOT NEW.block_hash OR
	OLD.block_number IS NOT NEW.block_number OR
	OLD.amount <> NEW.amount
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:ledger:' || NEW.id || ':' || NEW.canonical || ':' ||
			COALESCE(NEW.block_hash, 'none'),
		'home:ledger:' || NEW.id || ':' || NEW.canonical || ':' ||
			COALESCE(NEW.block_hash, 'none'),
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_pending_insert
AFTER INSERT ON pending_payments
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:payment:' || NEW.user_op_hash || ':' || NEW.status,
		'home:payment:' || NEW.user_op_hash || ':' || NEW.status,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_pending_update
AFTER UPDATE ON pending_payments
WHEN
	OLD.status <> NEW.status OR
	OLD.submitted_tx_hash IS NOT NEW.submitted_tx_hash
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:payment:' || NEW.user_op_hash || ':' || NEW.status || ':' ||
			COALESCE(NEW.submitted_tx_hash, 'none'),
		'home:payment:' || NEW.user_op_hash || ':' || NEW.status || ':' ||
			COALESCE(NEW.submitted_tx_hash, 'none'),
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_account_operation_insert
AFTER INSERT ON account_operations
WHEN EXISTS (SELECT 1 FROM users WHERE uid = NEW.uid)
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:account-op:' || NEW.id || ':' || NEW.status,
		'home:account-op:' || NEW.id || ':' || NEW.status,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_account_operation_update
AFTER UPDATE ON account_operations
WHEN
	EXISTS (SELECT 1 FROM users WHERE uid = NEW.uid) AND
	(OLD.status <> NEW.status OR OLD.updated_at <> NEW.updated_at)
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:account-op:' || NEW.id || ':' || NEW.status || ':' || NEW.updated_at,
		'home:account-op:' || NEW.id || ':' || NEW.status || ':' || NEW.updated_at,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_balance_insert
AFTER INSERT ON balance_snapshots
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:balance:' || NEW.chain_id || ':' || NEW.account_address || ':' ||
			NEW.asset || ':' || NEW.block_hash || ':' || NEW.balance_raw,
		'home:balance:' || NEW.chain_id || ':' || NEW.account_address || ':' ||
			NEW.asset || ':' || NEW.block_hash || ':' || NEW.balance_raw,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;

CREATE TRIGGER trg_home_outbox_balance_update
AFTER UPDATE ON balance_snapshots
WHEN
	OLD.balance_raw <> NEW.balance_raw OR
	OLD.block_number <> NEW.block_number OR
	OLD.block_hash <> NEW.block_hash OR
	OLD.consistency_level <> NEW.consistency_level OR
	OLD.projection_version <> NEW.projection_version OR
	OLD.canonical <> NEW.canonical
BEGIN
	INSERT OR IGNORE INTO user_event_outbox (
		id, dedupe_key, uid, event_type, payload_json, priority, status,
		attempt_count, next_attempt_at, created_at, updated_at
	) VALUES (
		'home:balance:' || NEW.chain_id || ':' || NEW.account_address || ':' ||
			NEW.asset || ':' || NEW.block_hash || ':' || NEW.balance_raw || ':' ||
			NEW.canonical,
		'home:balance:' || NEW.chain_id || ':' || NEW.account_address || ':' ||
			NEW.asset || ':' || NEW.block_hash || ':' || NEW.balance_raw || ':' ||
			NEW.canonical,
		NEW.uid, 'home.invalidate', '{}', 1, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);
END;
