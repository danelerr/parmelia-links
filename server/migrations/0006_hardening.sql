-- 0006: harden the tables added after the v2 baseline to the same standard as
-- 0001/0002 (STRICT, FKs, CHECKed enums), plus relayer operability columns and
-- the FK indexes the query paths actually use.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the Worker that ships
-- with it — the code reads/writes attempt_count/last_error and relies on the
-- unique source_tx_hash guard.
--
-- SQLite can't add STRICT/CHECK/FK in place, so both tables are rebuilt with
-- the standard copy-swap. Rows whose uid no longer exists in users are dropped
-- during the copy (testnet leftovers; they would violate the new FK).

PRAGMA defer_foreign_keys = on;

-- ===== push_tokens: STRICT + FK to users =====

CREATE TABLE push_tokens_new (
	token      TEXT PRIMARY KEY,
	uid        TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

INSERT INTO push_tokens_new (token, uid, created_at)
	SELECT p.token, p.uid, p.created_at
	FROM push_tokens p
	WHERE EXISTS (SELECT 1 FROM users u WHERE u.uid = p.uid);

DROP TABLE push_tokens;
ALTER TABLE push_tokens_new RENAME TO push_tokens;
CREATE INDEX idx_push_tokens_uid ON push_tokens(uid);

-- ===== crosschain_operations: STRICT + FK + CHECKed enums + operability =====
--
-- status lifecycle (see services/crosschainRelayer.ts):
--   quoted            outbound registered at prepare, burn not signed yet
--   pending_signature inbound registered at prepare, external burn not sent yet
--   submitted         burn broadcast (tx hash recorded)
--   waiting_attestation / minting  relayer in progress
--   completed         mint confirmed (terminal, never left)
--   failed            burn reverted (terminal)
--   expired           abandoned before any burn (terminal, holds no funds)
--   recoverable       mint reverted; retryable manually (receiveMessage is permissionless)
--   needs_support     parked after too many attempts / mismatch (manual runbook)

CREATE TABLE crosschain_operations_new (
	op_id                  TEXT PRIMARY KEY,
	uid                    TEXT NOT NULL,
	direction              TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
	provider               TEXT NOT NULL DEFAULT 'cctp' CHECK (provider IN ('cctp')),
	cctp_mode              TEXT NOT NULL CHECK (cctp_mode IN ('standard', 'fast')),
	source_chain_id        INTEGER NOT NULL CHECK (source_chain_id > 0),
	destination_chain_id   INTEGER NOT NULL CHECK (destination_chain_id > 0),
	source_domain          INTEGER NOT NULL CHECK (source_domain >= 0),
	destination_domain     INTEGER NOT NULL CHECK (destination_domain >= 0),
	destination_caller     TEXT,
	source_tx_hash         TEXT,
	destination_tx_hash    TEXT,
	message_nonce          TEXT,
	message_bytes          TEXT,
	attestation            TEXT,
	token                  TEXT NOT NULL DEFAULT 'USDC',
	amount_in              TEXT NOT NULL,
	parmelia_fee           TEXT NOT NULL DEFAULT '0',
	max_fee                TEXT,
	min_finality_threshold INTEGER,
	cctp_fee_estimated     TEXT,
	amount_out_expected    TEXT,
	recipient              TEXT NOT NULL,
	status                 TEXT NOT NULL CHECK (status IN (
		'quoted', 'pending_signature', 'submitted', 'waiting_attestation',
		'minting', 'completed', 'failed', 'expired', 'recoverable', 'needs_support')),
	status_detail          TEXT,
	attempt_count          INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	last_error             TEXT,
	created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	completed_at           TEXT,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

INSERT INTO crosschain_operations_new (
	op_id, uid, direction, provider, cctp_mode, source_chain_id, destination_chain_id,
	source_domain, destination_domain, destination_caller, source_tx_hash, destination_tx_hash,
	message_nonce, message_bytes, attestation, token, amount_in, parmelia_fee, max_fee,
	min_finality_threshold, cctp_fee_estimated, amount_out_expected, recipient, status,
	status_detail, attempt_count, last_error, created_at, updated_at, completed_at)
	SELECT
		o.op_id, o.uid, o.direction, o.provider, o.cctp_mode, o.source_chain_id, o.destination_chain_id,
		o.source_domain, o.destination_domain, o.destination_caller, o.source_tx_hash, o.destination_tx_hash,
		o.message_nonce, o.message_bytes, o.attestation, o.token, o.amount_in, o.parmelia_fee, o.max_fee,
		o.min_finality_threshold, o.cctp_fee_estimated, o.amount_out_expected, o.recipient, o.status,
		o.status_detail, 0, NULL, o.created_at, o.updated_at, o.completed_at
	FROM crosschain_operations o
	WHERE EXISTS (SELECT 1 FROM users u WHERE u.uid = o.uid);

DROP TABLE crosschain_operations;
ALTER TABLE crosschain_operations_new RENAME TO crosschain_operations;

-- A user's cross-chain history (most recent first).
CREATE INDEX idx_crosschain_uid ON crosschain_operations(uid, created_at DESC);
-- Relayer scan: in-flight by status, rotated by updated_at (see listCrosschainOpsByStatus).
CREATE INDEX idx_crosschain_status_updated ON crosschain_operations(status, updated_at);
-- One operation per burn tx: the public inbound/register endpoint dedupes on this.
CREATE UNIQUE INDEX idx_crosschain_source_tx
	ON crosschain_operations(source_tx_hash) WHERE source_tx_hash IS NOT NULL;

-- ===== FK indexes the hot query paths were missing =====

-- webhook_deliveries is JOINed/filtered by both FKs on every flush and dashboard view.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event_id);
-- Due-scan: status + next_retry_at drive listDueWebhookDeliveries and the claim.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
-- getPaymentIntentByLinkId (pay flow re-checks the backing intent on every link payment).
CREATE INDEX IF NOT EXISTS idx_payment_intents_link ON payment_intents(link_id);
-- FK child index: payment_links deletes (ON DELETE SET NULL) scan this column.
CREATE INDEX IF NOT EXISTS idx_pending_payments_link ON pending_payments(link_id);
-- Contacts reverse lookups.
CREATE INDEX IF NOT EXISTS idx_contacts_contact_uid ON contacts(contact_uid);

PRAGMA defer_foreign_keys = off;
