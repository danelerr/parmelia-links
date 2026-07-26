-- Durable user-facing effects. Financial/event commits enqueue here in the
-- same D1 batch; transport failures never decide correctness.

CREATE TABLE user_event_outbox (
	id TEXT PRIMARY KEY,
	dedupe_key TEXT NOT NULL UNIQUE,
	uid TEXT NOT NULL,
	event_type TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at TEXT NOT NULL,
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	delivered_at TEXT,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_user_event_outbox_due
	ON user_event_outbox(
		status, priority, next_attempt_at, created_at
	);
