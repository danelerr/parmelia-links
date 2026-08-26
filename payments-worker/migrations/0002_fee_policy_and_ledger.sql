-- Immutable economic snapshots keep old quotes and attempts explainable even
-- after the active fee policy changes. Existing rows remain explicitly free.
ALTER TABLE payment_quotes ADD COLUMN fee_policy_id TEXT NOT NULL DEFAULT 'free-default';
ALTER TABLE payment_quotes ADD COLUMN fee_policy_version INTEGER NOT NULL DEFAULT 1
	CHECK (fee_policy_version >= 1);
ALTER TABLE payment_quotes ADD COLUMN fee_rule_id TEXT NOT NULL DEFAULT 'free-default';
ALTER TABLE payment_quotes ADD COLUMN platform_fee_bps INTEGER NOT NULL DEFAULT 0
	CHECK (platform_fee_bps BETWEEN 0 AND 100);
ALTER TABLE payment_quotes ADD COLUMN platform_fee_bearer TEXT NOT NULL DEFAULT 'none'
	CHECK (platform_fee_bearer IN ('none','payer'));
ALTER TABLE payment_quotes ADD COLUMN platform_fee_recipient TEXT
	CHECK (platform_fee_recipient IS NULL OR (
		length(platform_fee_recipient) = 42 AND substr(platform_fee_recipient, 1, 2) = '0x'
		AND substr(platform_fee_recipient, 3) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE payment_quotes ADD COLUMN route_fee_cap_bps INTEGER NOT NULL DEFAULT 0
	CHECK (route_fee_cap_bps BETWEEN 0 AND 100);

ALTER TABLE payment_attempts ADD COLUMN platform_fee_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(platform_fee_atomic) BETWEEN 1 AND 78 AND platform_fee_atomic NOT GLOB '*[^0-9]*');
ALTER TABLE payment_attempts ADD COLUMN cctp_fee_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(cctp_fee_atomic) BETWEEN 1 AND 78 AND cctp_fee_atomic NOT GLOB '*[^0-9]*');
ALTER TABLE payment_attempts ADD COLUMN gross_payer_amount_atomic TEXT NOT NULL DEFAULT '0'
	CHECK (length(gross_payer_amount_atomic) BETWEEN 1 AND 78 AND gross_payer_amount_atomic NOT GLOB '*[^0-9]*');
ALTER TABLE payment_attempts ADD COLUMN fee_policy_id TEXT NOT NULL DEFAULT 'free-default';
ALTER TABLE payment_attempts ADD COLUMN fee_policy_version INTEGER NOT NULL DEFAULT 1
	CHECK (fee_policy_version >= 1);
ALTER TABLE payment_attempts ADD COLUMN fee_rule_id TEXT NOT NULL DEFAULT 'free-default';
ALTER TABLE payment_attempts ADD COLUMN platform_fee_bps INTEGER NOT NULL DEFAULT 0
	CHECK (platform_fee_bps BETWEEN 0 AND 100);
ALTER TABLE payment_attempts ADD COLUMN platform_fee_bearer TEXT NOT NULL DEFAULT 'none'
	CHECK (platform_fee_bearer IN ('none','payer'));
ALTER TABLE payment_attempts ADD COLUMN platform_fee_recipient TEXT
	CHECK (platform_fee_recipient IS NULL OR (
		length(platform_fee_recipient) = 42 AND substr(platform_fee_recipient, 1, 2) = '0x'
		AND substr(platform_fee_recipient, 3) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE payment_attempts ADD COLUMN route_fee_cap_bps INTEGER NOT NULL DEFAULT 0
	CHECK (route_fee_cap_bps BETWEEN 0 AND 100);

ALTER TABLE crosschain_operations ADD COLUMN burn_amount_atomic TEXT;
ALTER TABLE crosschain_operations ADD COLUMN platform_fee_atomic TEXT;
ALTER TABLE crosschain_operations ADD COLUMN network_fee_atomic TEXT;

CREATE TABLE payment_fee_ledger (
	id TEXT PRIMARY KEY,
	attempt_id TEXT NOT NULL,
	intent_id TEXT NOT NULL,
	fee_type TEXT NOT NULL CHECK (fee_type IN ('platform','network')),
	currency TEXT NOT NULL DEFAULT 'USDC' CHECK (currency = 'USDC'),
	bearer TEXT NOT NULL CHECK (bearer IN ('none','payer')),
	quoted_amount_atomic TEXT NOT NULL CHECK (
		length(quoted_amount_atomic) BETWEEN 1 AND 78 AND quoted_amount_atomic NOT GLOB '*[^0-9]*'),
	actual_amount_atomic TEXT CHECK (actual_amount_atomic IS NULL OR (
		length(actual_amount_atomic) BETWEEN 1 AND 78 AND actual_amount_atomic NOT GLOB '*[^0-9]*')),
	recipient TEXT CHECK (recipient IS NULL OR (
		length(recipient) = 42 AND substr(recipient, 1, 2) = '0x'
		AND substr(recipient, 3) NOT GLOB '*[^0-9a-fA-F]*')),
	status TEXT NOT NULL CHECK (status IN ('quoted','waived','charged')),
	policy_id TEXT NOT NULL,
	policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
	rule_id TEXT NOT NULL,
	source_chain_id INTEGER NOT NULL,
	route TEXT NOT NULL CHECK (route IN ('local','cctp_fast','cctp_standard')),
	charged_tx_hash TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (attempt_id) REFERENCES payment_attempts(id) ON DELETE RESTRICT,
	FOREIGN KEY (intent_id) REFERENCES payment_intents(id) ON DELETE RESTRICT
) STRICT;
CREATE UNIQUE INDEX idx_payment_fee_ledger_attempt_type ON payment_fee_ledger(attempt_id, fee_type);
CREATE INDEX idx_payment_fee_ledger_intent ON payment_fee_ledger(intent_id, created_at DESC);
CREATE INDEX idx_payment_fee_ledger_policy ON payment_fee_ledger(policy_id, policy_version, rule_id);
