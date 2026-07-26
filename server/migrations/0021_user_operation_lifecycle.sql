-- Canonical ERC-4337 receipt projection plus durable reconciliation requests.
-- A UserOperation can move between bundle transactions after a reorg, so the
-- journal retains every occurrence while this table points at the canonical one.

CREATE TABLE user_operation_receipts (
	chain_id INTEGER NOT NULL,
	user_op_hash TEXT NOT NULL,
	event_id TEXT NOT NULL,
	tx_hash TEXT NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	log_index INTEGER NOT NULL CHECK (log_index >= 0),
	transaction_index INTEGER,
	sender TEXT NOT NULL,
	nonce TEXT NOT NULL,
	success INTEGER NOT NULL CHECK (success IN (0, 1)),
	actual_gas_cost TEXT NOT NULL,
	actual_gas_used TEXT NOT NULL,
	consistency_level TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0, 1)),
	source TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, user_op_hash, block_hash),
	FOREIGN KEY (event_id, block_hash)
		REFERENCES chain_events(event_id, block_hash)
) STRICT;

CREATE UNIQUE INDEX idx_user_operation_receipts_occurrence
	ON user_operation_receipts(chain_id, tx_hash, log_index, block_hash);

CREATE UNIQUE INDEX idx_user_operation_receipts_canonical_hash
	ON user_operation_receipts(chain_id, user_op_hash)
	WHERE canonical = 1;

CREATE INDEX idx_user_operation_receipts_block
	ON user_operation_receipts(chain_id, canonical, block_number);

ALTER TABLE pending_payments ADD COLUMN submission_transport TEXT NOT NULL DEFAULT 'self'
	CHECK (submission_transport IN ('self', 'bundler'));
ALTER TABLE pending_payments ADD COLUMN submitted_at TEXT;
ALTER TABLE pending_payments ADD COLUMN submission_attempt_count INTEGER NOT NULL DEFAULT 0
	CHECK (submission_attempt_count >= 0);
ALTER TABLE pending_payments ADD COLUMN last_submission_error_code TEXT;

CREATE TABLE payment_reconcile_requests (
	user_op_hash TEXT PRIMARY KEY,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'processing', 'failed', 'completed', 'dead')),
	priority INTEGER NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 4),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT,
	FOREIGN KEY (user_op_hash) REFERENCES pending_payments(user_op_hash)
		ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_payment_reconcile_requests_due
	ON payment_reconcile_requests(status, priority, next_attempt_at);

CREATE TRIGGER trg_payment_reconcile_submitted
AFTER UPDATE OF status ON pending_payments
WHEN NEW.status = 'submitted' AND OLD.status <> 'submitted'
BEGIN
	INSERT INTO payment_reconcile_requests (
		user_op_hash, status, priority, attempt_count, next_attempt_at,
		lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
		completed_at
	) VALUES (
		NEW.user_op_hash, 'pending', 1, 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL, NULL,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
	)
	ON CONFLICT(user_op_hash) DO UPDATE SET
		status = CASE
			WHEN payment_reconcile_requests.status = 'completed'
			THEN 'completed' ELSE 'pending'
		END,
		priority = MIN(payment_reconcile_requests.priority, excluded.priority),
		next_attempt_at = excluded.next_attempt_at,
		updated_at = excluded.updated_at,
		last_error_code = NULL;
END;

CREATE TRIGGER trg_payment_reconcile_terminal
AFTER UPDATE OF status ON pending_payments
WHEN NEW.status IN ('confirmed', 'failed') AND OLD.status <> NEW.status
BEGIN
	UPDATE payment_reconcile_requests
	SET status = 'completed',
		completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		lease_owner = NULL,
		lease_expires_at = NULL,
		last_error_code = NULL
	WHERE user_op_hash = NEW.user_op_hash;
END;

-- A canonical watcher projection is the fastest reconciliation signal. Queue
-- it in the same D1 transaction as the receipt; no Worker crash can leave the
-- evidence persisted but the payment waiting for the next full sweep.
CREATE TRIGGER trg_user_operation_receipt_reconcile_insert
AFTER INSERT ON user_operation_receipts
WHEN NEW.canonical = 1
BEGIN
	INSERT INTO payment_reconcile_requests (
		user_op_hash, status, priority, attempt_count, next_attempt_at,
		lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
		completed_at
	)
	SELECT
		NEW.user_op_hash, 'pending', 0, 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL, NULL,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
	FROM pending_payments
	WHERE user_op_hash = NEW.user_op_hash
	  AND status IN ('submitting', 'submitted')
	ON CONFLICT(user_op_hash) DO UPDATE SET
		status = 'pending',
		priority = 0,
		next_attempt_at = excluded.next_attempt_at,
		lease_owner = NULL,
		lease_expires_at = NULL,
		last_error_code = NULL,
		updated_at = excluded.updated_at,
		completed_at = NULL;
END;

CREATE TRIGGER trg_user_operation_receipt_reconcile_update
AFTER UPDATE OF canonical ON user_operation_receipts
WHEN NEW.canonical = 1 AND OLD.canonical = 0
BEGIN
	INSERT INTO payment_reconcile_requests (
		user_op_hash, status, priority, attempt_count, next_attempt_at,
		lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
		completed_at
	)
	SELECT
		NEW.user_op_hash, 'pending', 0, 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL, NULL,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
	FROM pending_payments
	WHERE user_op_hash = NEW.user_op_hash
	  AND status IN ('submitting', 'submitted')
	ON CONFLICT(user_op_hash) DO UPDATE SET
		status = 'pending',
		priority = 0,
		next_attempt_at = excluded.next_attempt_at,
		lease_owner = NULL,
		lease_expires_at = NULL,
		last_error_code = NULL,
		updated_at = excluded.updated_at,
		completed_at = NULL;
END;
