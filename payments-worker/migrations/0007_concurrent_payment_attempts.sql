-- A public reservation is only a signed authorization; it is not payment
-- evidence and must never monopolize an intent. Multiple payers may prepare
-- attempts, while each router contract still decides atomically which
-- authorization can execute on that chain.
DROP INDEX idx_attempts_one_active_per_intent;

CREATE INDEX idx_attempts_intent_active_created
	ON payment_attempts(intent_id, created_at DESC)
	WHERE status IN ('reserved','submitted','processing');

-- Open amounts are selected by the first confirmed settlement, not by quote
-- or reservation creation. Fixed intents still require an exact amount and no
-- new attempt may be inserted after an intent stops accepting payments.
DROP TRIGGER payment_attempt_amount_matches_intent;

CREATE TRIGGER payment_attempt_matches_payable_intent
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
	SELECT 1
	FROM payment_intents
	WHERE id = NEW.intent_id
	  AND status = 'awaiting_payment'
	  AND (
		(amount_mode = 'fixed' AND amount_atomic = NEW.settlement_amount_atomic)
		OR (amount_mode = 'payer_defined' AND paid_amount_atomic = '0')
	  )
)
BEGIN
	SELECT RAISE(ABORT, 'payment attempt does not match a payable intent');
END;

-- This append-only row is both an audit record and the transaction-local
-- commit marker used by settlement compare-and-set batches. attempt_id is
-- unique, so retries cannot account for one on-chain payment twice.
CREATE TABLE payment_settlement_commits (
	commit_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE,
	intent_id TEXT NOT NULL,
	previous_paid_amount_atomic TEXT NOT NULL CHECK (
		length(previous_paid_amount_atomic) BETWEEN 1 AND 78
		AND previous_paid_amount_atomic NOT GLOB '*[^0-9]*'),
	settled_amount_atomic TEXT NOT NULL CHECK (
		length(settled_amount_atomic) BETWEEN 1 AND 78
		AND settled_amount_atomic NOT GLOB '*[^0-9]*'),
	resulting_paid_amount_atomic TEXT NOT NULL CHECK (
		length(resulting_paid_amount_atomic) BETWEEN 1 AND 78
		AND resulting_paid_amount_atomic NOT GLOB '*[^0-9]*'),
	expected_amount_atomic TEXT NOT NULL CHECK (
		length(expected_amount_atomic) BETWEEN 1 AND 78
		AND expected_amount_atomic NOT GLOB '*[^0-9]*'),
	resulting_status TEXT NOT NULL CHECK (resulting_status IN ('paid','overpaid')),
	created_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_payment_settlement_commits_intent
	ON payment_settlement_commits(intent_id, created_at);
