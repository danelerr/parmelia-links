-- Stable WebAuthn scope and best-effort credential management metadata.
-- Provider/AAGUID fields are informational only; signer authorization remains
-- bound to the verified P-256 public key and on-chain account state.

ALTER TABLE webauthn_registration_challenges ADD COLUMN expected_rp_id TEXT;
ALTER TABLE webauthn_registration_challenges ADD COLUMN aaguid TEXT;
ALTER TABLE webauthn_registration_challenges ADD COLUMN provider_name TEXT;
ALTER TABLE webauthn_registration_challenges ADD COLUMN credential_device_type TEXT
	CHECK (credential_device_type IS NULL OR credential_device_type IN ('singleDevice', 'multiDevice'));
ALTER TABLE webauthn_registration_challenges ADD COLUMN credential_backed_up INTEGER
	CHECK (credential_backed_up IS NULL OR credential_backed_up IN (0, 1));
ALTER TABLE webauthn_registration_challenges ADD COLUMN authenticator_attachment TEXT
	CHECK (authenticator_attachment IS NULL OR authenticator_attachment IN ('platform', 'cross-platform'));

UPDATE webauthn_registration_challenges
	SET expected_rp_id = lower(
		replace(
			replace(
				replace(expected_origin, 'https://', ''),
				'http://',
				''
			),
			':5173',
			''
		)
	)
	WHERE expected_rp_id IS NULL;

ALTER TABLE passkeys ADD COLUMN rp_id TEXT;
ALTER TABLE passkeys ADD COLUMN aaguid TEXT;
ALTER TABLE passkeys ADD COLUMN provider_name TEXT;
ALTER TABLE passkeys ADD COLUMN credential_device_type TEXT
	CHECK (credential_device_type IS NULL OR credential_device_type IN ('singleDevice', 'multiDevice'));
ALTER TABLE passkeys ADD COLUMN credential_backed_up INTEGER
	CHECK (credential_backed_up IS NULL OR credential_backed_up IN (0, 1));
ALTER TABLE passkeys ADD COLUMN authenticator_attachment TEXT
	CHECK (authenticator_attachment IS NULL OR authenticator_attachment IN ('platform', 'cross-platform'));
ALTER TABLE passkeys ADD COLUMN metadata_updated_at TEXT;

UPDATE passkeys
	SET rp_id = (
		SELECT challenge.expected_rp_id
		FROM webauthn_registration_challenges AS challenge
		WHERE challenge.credential_id = passkeys.credential_id
		  AND challenge.finalized_at IS NOT NULL
		ORDER BY challenge.finalized_at DESC
		LIMIT 1
	)
	WHERE rp_id IS NULL;

UPDATE passkeys
	SET metadata_updated_at = last_used_at
	WHERE rp_id IS NOT NULL AND metadata_updated_at IS NULL;

CREATE INDEX idx_passkeys_uid_rp_active
	ON passkeys(uid, rp_id, last_used_at DESC)
	WHERE revoked_at IS NULL;
