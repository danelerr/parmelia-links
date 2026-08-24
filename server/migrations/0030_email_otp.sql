-- Six-digit passwordless email authentication.
--
-- Codes and addresses are never stored in plaintext. Both are keyed HMACs
-- using AUTH_CODE_PEPPER; a D1 snapshot alone is therefore not enough to
-- enumerate addresses or brute-force a six-digit code offline.

CREATE TABLE auth_email_codes (
	id TEXT PRIMARY KEY,
	email_hash TEXT NOT NULL,
	code_hash TEXT NOT NULL,
	purpose TEXT NOT NULL DEFAULT 'signin'
		CHECK (purpose IN ('signin', 'step_up')),
	locale TEXT NOT NULL DEFAULT 'es'
		CHECK (locale IN ('es', 'en')),
	ip_hash TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
	expires_at TEXT NOT NULL,
	claim_id TEXT,
	claimed_at TEXT,
	firebase_uid TEXT,
	consumed_at TEXT,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_email_codes_active
	ON auth_email_codes(email_hash, purpose, created_at DESC)
	WHERE consumed_at IS NULL;

CREATE INDEX idx_auth_email_codes_expiry
	ON auth_email_codes(expires_at);
