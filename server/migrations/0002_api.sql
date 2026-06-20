-- Parmelia payments API (closed-loop core): merchants, API keys, payment
-- intents, webhook endpoints, an immutable event log, and a webhook outbox.
-- A payment_intent is backed by a payment_links row (reuses the existing,
-- working pay flow); when that link is paid, the intent settles and a
-- payment.paid event is emitted + delivered to the merchant's webhooks.

CREATE TABLE IF NOT EXISTS merchants (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL UNIQUE,
	name TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (owner_uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS api_keys (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	key_prefix TEXT NOT NULL,          -- e.g. "sk_test_a1b2c3" (for display)
	secret_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the full key; the key itself is never stored
	mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
	name TEXT,
	last_used_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_api_keys_merchant ON api_keys(merchant_id);

CREATE TABLE IF NOT EXISTS payment_intents (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	link_id TEXT,                      -- backing payment_links row (closed-loop)
	amount TEXT NOT NULL,
	currency TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'expired', 'canceled')),
	metadata TEXT,                     -- opaque JSON from the merchant
	reference TEXT,
	checkout_url TEXT,
	tx_hash TEXT,
	mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
	idempotency_key TEXT,
	expires_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,
	FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_intents_merchant ON payment_intents(merchant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intents_link ON payment_intents(link_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idem
	ON payment_intents(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	url TEXT NOT NULL,
	secret TEXT NOT NULL,              -- HMAC signing secret (shown once to the merchant)
	enabled_events TEXT,              -- JSON array of event types; NULL = all
	status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
	mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_whe_merchant ON webhook_endpoints(merchant_id);

CREATE TABLE IF NOT EXISTS events (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	type TEXT NOT NULL,
	object_id TEXT,
	payload TEXT NOT NULL,             -- JSON
	mode TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_events_merchant ON events(merchant_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	endpoint_id TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
	response_code INTEGER,
	next_retry_at TEXT,
	delivered_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
	FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_retry_at);
