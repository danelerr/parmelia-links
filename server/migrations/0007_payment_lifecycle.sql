-- 0007: payment lifecycle + in-Worker rate limiting.
--
-- pending_payments gains an explicit state machine so a payment survives a
-- Worker death at ANY point of /pay/submit and can be reconciled by cron:
--   prepared    built + awaiting the user's passkey signature
--   submitting  claimed by a submit request (atomic CAS; blocks double submit)
--   submitted   handleOps broadcast (submitted_tx_hash recorded pre-receipt)
--   confirmed   UserOperationEvent(success=true) seen + accounting settled
--   failed      op reverted / never landed within the paymaster window
-- Terminal rows are kept briefly so GET /pay/status can answer, then swept.
--
-- DEPLOY ORDER: apply BEFORE deploying the Worker that ships with it.

ALTER TABLE pending_payments ADD COLUMN status TEXT NOT NULL DEFAULT 'prepared'
	CHECK (status IN ('prepared', 'submitting', 'submitted', 'confirmed', 'failed'));
ALTER TABLE pending_payments ADD COLUMN submitted_tx_hash TEXT;

-- Reconciler scan: in-flight rows by state + age.
CREATE INDEX idx_pending_payments_status ON pending_payments(status, expires_at);

-- Fixed-window counters for the in-Worker rate limiter (defense in depth on
-- public/abuse-prone endpoints; Turnstile stays the primary human gate).
CREATE TABLE rate_limits (
	key          TEXT PRIMARY KEY,   -- "<scope>:<subject>"
	count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
	window_start TEXT NOT NULL       -- epoch-seconds of the current window, as text
) STRICT;
