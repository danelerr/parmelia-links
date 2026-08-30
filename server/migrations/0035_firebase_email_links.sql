-- Firebase-native email links replace six-digit email codes for the consumer
-- App. Recovery links carry a separate opaque challenge so possession of a
-- generic Firebase session cannot authorize a smart-account recovery.

CREATE TABLE auth_email_link_challenges (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('start', 'execute')),
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	consumed_at TEXT,
	consumption_id TEXT UNIQUE,
	created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_email_link_challenges_active
	ON auth_email_link_challenges(uid, action, expires_at)
	WHERE consumed_at IS NULL;

CREATE INDEX idx_auth_email_link_challenges_expiry
	ON auth_email_link_challenges(expires_at);

-- No code issued before this cutover remains a valid consumer-App login or
-- recovery proof. The immutable legacy table stays for auditability and for
-- the separately scoped Business migration that follows later.
UPDATE auth_email_codes
	SET consumed_at = COALESCE(consumed_at, CURRENT_TIMESTAMP)
	WHERE consumed_at IS NULL;
