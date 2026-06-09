-- Per-passkey public keys, so any device can sign even when the browser's
-- localStorage cache is empty (e.g. a synced passkey on a fresh device).
--
-- The V2 account is multi-signer (N passkeys per wallet), but `users.credential_id`
-- only tracked the last-used one. This table is the authoritative set of a user's
-- passkeys and stores the P256 public key (qx, qy) — public data, not a secret —
-- used to rebuild the on-chain signer at signing time.
CREATE TABLE IF NOT EXISTS passkeys (
	credential_id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	qx TEXT NOT NULL,
	qy TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_passkeys_uid_last_used ON passkeys(uid, last_used_at DESC);
