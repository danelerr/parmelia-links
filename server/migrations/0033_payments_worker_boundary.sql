-- App-side logical references and durable commands for the one-way
-- gatopago-app-api -> gatopago-payments-api boundary. No Payments tables live
-- here and no cross-database foreign keys are possible.
ALTER TABLE users ADD COLUMN settlement_account_version INTEGER NOT NULL DEFAULT 0;
UPDATE users SET settlement_account_version = 1 WHERE wallet_address IS NOT NULL;

ALTER TABLE pending_payments ADD COLUMN payment_attempt_id TEXT;
CREATE INDEX idx_pending_payments_payment_attempt ON pending_payments(payment_attempt_id)
	WHERE payment_attempt_id IS NOT NULL;

CREATE TABLE payment_account_sync_outbox (
	uid TEXT PRIMARY KEY,
	wallet_address TEXT NOT NULL,
	account_version INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE payment_execution_sync_outbox (
	payment_attempt_id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	user_op_hash TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_payment_execution_sync_userop ON payment_execution_sync_outbox(user_op_hash);

CREATE TRIGGER trg_payment_account_sync_insert
AFTER INSERT ON users
WHEN NEW.wallet_address IS NOT NULL
BEGIN
	INSERT INTO payment_account_sync_outbox(uid, wallet_address, account_version, status, next_attempt_at, created_at, updated_at)
	VALUES (NEW.uid, lower(NEW.wallet_address), MAX(1, NEW.settlement_account_version), 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET wallet_address = excluded.wallet_address,
		account_version = MAX(payment_account_sync_outbox.account_version, excluded.account_version),
		status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_payment_account_sync_update
AFTER UPDATE OF wallet_address, settlement_account_version ON users
WHEN NEW.wallet_address IS NOT NULL AND (
	OLD.wallet_address IS NULL OR lower(OLD.wallet_address) != lower(NEW.wallet_address)
	OR NEW.settlement_account_version > OLD.settlement_account_version
)
BEGIN
	INSERT INTO payment_account_sync_outbox(uid, wallet_address, account_version, status, next_attempt_at, created_at, updated_at)
	VALUES (NEW.uid, lower(NEW.wallet_address), MAX(1, NEW.settlement_account_version), 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	ON CONFLICT(uid) DO UPDATE SET wallet_address = excluded.wallet_address,
		account_version = MAX(payment_account_sync_outbox.account_version, excluded.account_version),
		status = 'pending', next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER trg_payment_execution_sync_submitted
AFTER UPDATE OF status ON pending_payments
WHEN NEW.status = 'submitted' AND OLD.status != 'submitted' AND NEW.payment_attempt_id IS NOT NULL
BEGIN
	INSERT OR IGNORE INTO payment_execution_sync_outbox(
		payment_attempt_id, uid, user_op_hash, status, next_attempt_at, created_at, updated_at
	) VALUES (
		NEW.payment_attempt_id, NEW.uid, NEW.user_op_hash, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
	);
END;

-- Existing accounts are copied lazily through the same idempotent outbox.
INSERT OR IGNORE INTO payment_account_sync_outbox(
	uid, wallet_address, account_version, status, next_attempt_at, created_at, updated_at
)
SELECT uid, lower(wallet_address), MAX(1, settlement_account_version), 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM users WHERE wallet_address IS NOT NULL;
