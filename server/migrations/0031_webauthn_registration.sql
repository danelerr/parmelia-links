-- Server-bound WebAuthn registration and passkey management metadata.

CREATE TABLE webauthn_registration_challenges (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	purpose TEXT NOT NULL
		CHECK (purpose IN ('account_create', 'passkey_add', 'recovery_propose')),
	challenge TEXT NOT NULL,
	expected_origin TEXT NOT NULL,
	credential_id TEXT,
	qx TEXT,
	qy TEXT,
	name TEXT,
	transports_json TEXT,
	claim_id TEXT,
	claimed_at TEXT,
	finalized_at TEXT,
	consumed_at TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_webauthn_registration_active
	ON webauthn_registration_challenges(uid, purpose, created_at DESC)
	WHERE consumed_at IS NULL;

CREATE INDEX idx_webauthn_registration_expiry
	ON webauthn_registration_challenges(expires_at);

ALTER TABLE passkeys ADD COLUMN name TEXT;
ALTER TABLE passkeys ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'unknown'
	CHECK (registration_source IN ('onboarding', 'backup', 'recovery', 'observed', 'unknown'));
ALTER TABLE passkeys ADD COLUMN transports_json TEXT;
ALTER TABLE passkeys ADD COLUMN revoked_at TEXT;

CREATE INDEX idx_passkeys_uid_active
	ON passkeys(uid, last_used_at DESC)
	WHERE revoked_at IS NULL;
