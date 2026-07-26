-- Stable keyset pagination for the user statement. The id tie-breaker prevents
-- rows with the same timestamp from being skipped or repeated between pages.

CREATE INDEX idx_ledger_uid_canonical_created_id
	ON ledger(uid, canonical, created_at DESC, id DESC);
