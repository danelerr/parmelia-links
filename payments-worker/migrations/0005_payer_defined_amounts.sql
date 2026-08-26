-- Open payment links keep no economic amount until the first authorized
-- attempt wins. The amount is then frozen in the same D1 transaction that
-- persists the attempt, preventing two payers from authorizing different
-- values for one intent.
ALTER TABLE payment_intents
	ADD COLUMN amount_mode TEXT NOT NULL DEFAULT 'fixed'
	CHECK (amount_mode IN ('fixed', 'payer_defined'));

-- Legacy open links were represented as zero. Fixed intents are always
-- positive because the public/merchant APIs validate them before insertion.
UPDATE payment_intents
SET amount_mode = 'payer_defined'
WHERE amount_atomic = '0';

CREATE INDEX idx_intents_open_amount
	ON payment_intents(status, amount_mode, updated_at)
	WHERE amount_mode = 'payer_defined';

CREATE TRIGGER payment_attempt_amount_matches_intent
BEFORE INSERT ON payment_attempts
WHEN NOT EXISTS (
	SELECT 1
	FROM payment_intents
	WHERE id = NEW.intent_id
	  AND amount_atomic = NEW.settlement_amount_atomic
)
BEGIN
	SELECT RAISE(ABORT, 'payment attempt amount does not match intent');
END;
