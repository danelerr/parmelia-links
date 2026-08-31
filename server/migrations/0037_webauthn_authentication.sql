-- One-time WebAuthn assertions used to answer the precise UX question
-- "can this passkey manager use one of my active account keys?".
--
-- Firebase proves account identity; this ceremony separately proves possession
-- of a registered passkey. Challenges are origin/RP-bound, short lived and
-- consumed before verification so an assertion cannot be replayed.

CREATE TABLE webauthn_authentication_challenges (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	challenge TEXT NOT NULL,
	expected_origin TEXT NOT NULL,
	expected_rp_id TEXT NOT NULL,
	consumed_at TEXT,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_webauthn_authentication_active
	ON webauthn_authentication_challenges(uid, created_at DESC)
	WHERE consumed_at IS NULL;

CREATE INDEX idx_webauthn_authentication_expiry
	ON webauthn_authentication_challenges(expires_at);

-- Signature counters are commonly zero for synchronized passkeys, but when an
-- authenticator supplies one we persist it to retain WebAuthn replay/cloning
-- protection across availability checks.
ALTER TABLE passkeys ADD COLUMN sign_count INTEGER NOT NULL DEFAULT 0
	CHECK (sign_count >= 0);
