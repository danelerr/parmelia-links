-- Durable control-plane state for managed push subscriptions.

CREATE TABLE provider_subscription_state (
	provider TEXT NOT NULL,
	subscription_id TEXT NOT NULL,
	desired_hash TEXT NOT NULL,
	remote_hash TEXT,
	item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
	status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'failed')),
	last_attempt_at TEXT NOT NULL,
	last_success_at TEXT,
	last_error_code TEXT,
	PRIMARY KEY (provider, subscription_id)
) STRICT;
