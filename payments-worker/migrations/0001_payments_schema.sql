PRAGMA foreign_keys = ON;

-- Payment domain only. Cross-domain identifiers such as owner_uid and payer_uid
-- are logical references and intentionally have no foreign key to App D1.
CREATE TABLE merchants (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL DEFAULT '',
	settlement_wallet TEXT NOT NULL,
	settlement_chain_id INTEGER NOT NULL,
	account_version INTEGER NOT NULL DEFAULT 1 CHECK (account_version >= 1),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_merchants_settlement_wallet ON merchants(settlement_chain_id, settlement_wallet);

CREATE TABLE settlement_account_commands (
	command_id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL,
	account_version INTEGER NOT NULL,
	applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
	created_at TEXT NOT NULL
) STRICT;

CREATE TABLE payment_intents (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	link_id TEXT,
	idempotency_key TEXT,
	amount TEXT NOT NULL,
	amount_atomic TEXT NOT NULL,
	currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
	reference TEXT NOT NULL DEFAULT '',
	metadata TEXT NOT NULL DEFAULT '{}',
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	status TEXT NOT NULL DEFAULT 'awaiting_payment'
		CHECK (status IN ('awaiting_payment','processing','paid','overpaid','canceled','expired','failed')),
	settlement_wallet TEXT NOT NULL,
	settlement_chain_id INTEGER NOT NULL,
	settlement_account_version INTEGER NOT NULL,
	paid_amount_atomic TEXT NOT NULL DEFAULT '0',
	paid_tx_hash TEXT,
	paid_at TEXT,
	expires_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX idx_intents_merchant_idempotency
	ON payment_intents(merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_intents_merchant_created ON payment_intents(merchant_id, created_at DESC);
CREATE INDEX idx_intents_status_expiry ON payment_intents(status, expires_at);

CREATE TABLE payment_links (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL,
	merchant_id TEXT NOT NULL,
	intent_id TEXT NOT NULL UNIQUE,
	wallet_address TEXT NOT NULL,
	amount TEXT NOT NULL,
	currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
	reference TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','canceled','expired')),
	tx_hash TEXT,
	paid_at TEXT,
	paid_by TEXT,
	legacy_payment_claim TEXT,
	legacy_payment_claim_expires_at TEXT,
	legacy_payment_claim_tx_hash TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_payment_links_owner_created ON payment_links(owner_uid, created_at DESC);
CREATE INDEX idx_payment_links_owner_status ON payment_links(owner_uid, status);

CREATE TABLE payment_quotes (
	id TEXT PRIMARY KEY,
	intent_id TEXT NOT NULL,
	payer TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	settlement_amount_atomic TEXT NOT NULL,
	platform_fee_atomic TEXT NOT NULL,
	cctp_fee_atomic TEXT NOT NULL DEFAULT '0',
	gross_payer_amount_atomic TEXT NOT NULL,
	fee_source TEXT NOT NULL CHECK (fee_source IN ('local','circle_live')),
	fee_observed_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	quote_hash TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_quotes_intent_expiry ON payment_quotes(intent_id, expires_at DESC);

CREATE TABLE payment_attempts (
	id TEXT PRIMARY KEY,
	attempt_hash TEXT NOT NULL UNIQUE,
	intent_id TEXT NOT NULL,
	quote_id TEXT NOT NULL,
	payer_uid TEXT,
	payer_address TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	status TEXT NOT NULL DEFAULT 'reserved'
		CHECK (status IN ('reserved','submitted','processing','paid','overpaid','failed','expired','canceled')),
	router_address TEXT NOT NULL,
	authorization_hash TEXT NOT NULL UNIQUE,
	authorization_json TEXT NOT NULL,
	signature TEXT NOT NULL,
	valid_after INTEGER NOT NULL,
	valid_until INTEGER NOT NULL,
	user_op_hash TEXT,
	source_tx_hash TEXT,
	destination_tx_hash TEXT,
	settlement_amount_atomic TEXT NOT NULL,
	settled_amount_atomic TEXT NOT NULL DEFAULT '0',
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT,
	FOREIGN KEY (quote_id) REFERENCES payment_quotes(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX idx_attempts_one_active_per_intent
	ON payment_attempts(intent_id)
	WHERE status IN ('reserved','submitted','processing');
CREATE UNIQUE INDEX idx_attempts_user_op_hash
	ON payment_attempts(user_op_hash) WHERE user_op_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_attempts_source_tx_hash
	ON payment_attempts(source_chain_id, source_tx_hash) WHERE source_tx_hash IS NOT NULL;
CREATE INDEX idx_attempts_status_updated ON payment_attempts(status, updated_at);
CREATE UNIQUE INDEX idx_attempts_request_idempotency
	ON payment_attempts(intent_id, payer_address, source_chain_id, idempotency_key);

CREATE TABLE app_execution_commands (
	command_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL,
	user_op_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE crosschain_operations (
	op_id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL UNIQUE,
	source_chain_id INTEGER NOT NULL,
	destination_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('cctp_fast','cctp_standard')),
	status TEXT NOT NULL DEFAULT 'awaiting_burn'
		CHECK (status IN ('awaiting_burn','burned','attesting','minting','settled','failed','needs_support')),
	source_tx_hash TEXT,
	message_hash TEXT,
	message TEXT,
	attestation TEXT,
	destination_tx_hash TEXT,
	last_error_code TEXT,
	next_attempt_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX idx_crosschain_due ON crosschain_operations(status, next_attempt_at);

CREATE TABLE payment_chain_blocks (
	chain_id INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	parent_hash TEXT NOT NULL,
	block_timestamp TEXT,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0,1)),
	PRIMARY KEY (chain_id, block_number, block_hash)
) STRICT;
CREATE UNIQUE INDEX idx_payment_chain_canonical_height
	ON payment_chain_blocks(chain_id, block_number) WHERE canonical = 1;

CREATE TABLE payment_chain_events (
	chain_id INTEGER NOT NULL,
	tx_hash TEXT NOT NULL,
	log_index INTEGER NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	event_name TEXT NOT NULL,
	intent_hash TEXT,
	attempt_hash TEXT,
	payload_json TEXT NOT NULL,
	canonical INTEGER NOT NULL DEFAULT 1 CHECK (canonical IN (0,1)),
	created_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, tx_hash, log_index)
) STRICT;
CREATE INDEX idx_payment_events_attempt ON payment_chain_events(chain_id, attempt_hash, canonical);

CREATE TABLE payment_stream_checkpoints (
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	block_number INTEGER NOT NULL,
	block_hash TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (chain_id, stream)
) STRICT;

CREATE TABLE payment_reorg_incidents (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	stream TEXT NOT NULL,
	previous_block_number INTEGER NOT NULL,
	previous_block_hash TEXT NOT NULL,
	common_ancestor_number INTEGER NOT NULL,
	common_ancestor_hash TEXT NOT NULL,
	orphaned_event_count INTEGER NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed')),
	created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_payment_reorg_incidents_open ON payment_reorg_incidents(status, created_at DESC);

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('test','live')),
	prefix TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL DEFAULT '',
	last_used_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_api_keys_merchant ON api_keys(merchant_id, created_at DESC);

CREATE TABLE webhook_endpoints (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	url TEXT NOT NULL,
	secret_ciphertext TEXT NOT NULL,
	secret_key_id TEXT NOT NULL,
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	enabled_events TEXT,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_webhook_endpoints_merchant ON webhook_endpoints(merchant_id, created_at DESC);

CREATE TABLE events (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	dedupe_key TEXT,
	mode TEXT NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE CASCADE
) STRICT;
-- Historical events may legitimately contain repeated object/type pairs. Only
-- events created by the new engine carry a dedupe key.
CREATE UNIQUE INDEX idx_events_dedupe ON events(merchant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_events_merchant_created ON events(merchant_id, created_at DESC);

CREATE TABLE webhook_deliveries (
	id TEXT PRIMARY KEY,
	event_id TEXT NOT NULL,
	endpoint_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed','dead')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_retry_at TEXT NOT NULL,
	lease_owner TEXT,
	lease_expires_at TEXT,
	last_status_code INTEGER,
	last_error TEXT,
	delivered_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
	FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX idx_webhook_delivery_once ON webhook_deliveries(event_id, endpoint_id);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);

CREATE TABLE payment_outbox (
	id TEXT PRIMARY KEY,
	topic TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enqueued','completed','failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX idx_payment_outbox_logical_once ON payment_outbox(topic, resource_id);
CREATE INDEX idx_payment_outbox_due ON payment_outbox(status, next_attempt_at);

CREATE TABLE payment_job_runs (
	dedupe_key TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	job TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
	lease_expires_at TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT
) STRICT;

CREATE TABLE rate_limits (
	scope TEXT NOT NULL,
	key_hash TEXT NOT NULL,
	window_start INTEGER NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (scope, key_hash, window_start)
) STRICT;

CREATE TABLE payment_migration_control (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	legacy_copy_version INTEGER NOT NULL DEFAULT 0,
	legacy_copy_completed_at TEXT,
	legacy_source_checksum TEXT,
	legacy_target_checksum TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
INSERT INTO payment_migration_control(id, created_at, updated_at)
	VALUES (1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
