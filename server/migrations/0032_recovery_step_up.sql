-- One-time reauthentication for sensitive recovery actions.
--
-- The browser receives a high-entropy token only after proving a six-digit
-- email code. D1 stores only an HMAC of that token, and each token can
-- authorize exactly one recovery action.

ALTER TABLE auth_email_codes ADD COLUMN subject_uid TEXT;

ALTER TABLE webauthn_registration_challenges
	ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0
	CHECK (verification_attempts BETWEEN 0 AND 5);

CREATE INDEX idx_auth_email_codes_subject
	ON auth_email_codes(subject_uid, purpose, created_at DESC)
	WHERE consumed_at IS NULL AND subject_uid IS NOT NULL;

CREATE TABLE auth_step_up_sessions (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('recovery')),
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	consumed_at TEXT,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_step_up_sessions_active
	ON auth_step_up_sessions(uid, scope, expires_at)
	WHERE consumed_at IS NULL;

CREATE INDEX idx_auth_step_up_sessions_expiry
	ON auth_step_up_sessions(expires_at);
