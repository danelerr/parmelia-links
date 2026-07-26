-- Every in-flight UserOperation gets durable reconciliation work, including a
-- Worker that dies after claiming the operation but before persisting a
-- broadcast result. The prepared -> submitting transition and its work item
-- are written atomically by claimPendingForSubmit(). The trigger introduced in
-- 0021 continues to cover submitting -> submitted. Keeping trigger replacement
-- out of this migration also avoids remote D1 parser differences for complex
-- CREATE TRIGGER statements.

INSERT OR IGNORE INTO payment_reconcile_requests (
	user_op_hash, status, priority, attempt_count, next_attempt_at,
	lease_owner, lease_expires_at, last_error_code, created_at, updated_at,
	completed_at
)
SELECT
	user_op_hash, 'pending',
	CASE WHEN status = 'submitted' THEN 1 ELSE 2 END,
	0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL, NULL,
	created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM pending_payments
WHERE status IN ('submitting', 'submitted');
