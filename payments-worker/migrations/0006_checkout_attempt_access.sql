-- Public checkout attempts are bearer-capability protected and require a
-- wallet-control proof. App-created attempts remain NULL because their caller
-- is authenticated through the private service binding.
ALTER TABLE payment_attempts ADD COLUMN checkout_capability_hash TEXT;
ALTER TABLE payment_attempts ADD COLUMN payer_proof_signature TEXT;
ALTER TABLE payment_attempts ADD COLUMN payer_proof_message_hash TEXT;

CREATE INDEX idx_attempts_submitted_expiry
	ON payment_attempts(status, valid_until)
	WHERE status = 'submitted';
