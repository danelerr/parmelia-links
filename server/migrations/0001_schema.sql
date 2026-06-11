-- Parmelia schema — single source of truth (consolidated; the incremental
-- migration history was squashed while testnet data was disposable).
--
-- Design notes:
--   * users: wallet_address is UNIQUE + stored lowercase → reverse lookup
--     (address → user) powers the ledger and internal-transfer detection.
--     referral_code: short shareable invite code (besides ?ref=username).
--   * ledger: ONE unified movements table. Parmelia relays every UserOp, so
--     each payment/swap/faucet is written here at submit time — both sides for
--     internal transfers. External incoming transfers are ingested by the cron
--     indexer. /user/transactions reads ONLY this table.
--   * sync_state: block cursor for the cron indexer.
--   * pending_payments.meta: JSON context (e.g. swap quote details) so submit
--     can write precise ledger entries.
--
-- The DROP prelude makes this safe to apply over any pre-existing testnet DB
-- (wrangler tracks applied migrations by filename; this one is new everywhere).

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS sent_transactions;
DROP TABLE IF EXISTS pending_payments;
DROP TABLE IF EXISTS swap_quotes;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS payment_links;
DROP TABLE IF EXISTS ledger;
DROP TABLE IF EXISTS sync_state;
DROP TABLE IF EXISTS users;

PRAGMA foreign_keys = ON;

CREATE TABLE users (
	uid TEXT PRIMARY KEY,
	username TEXT UNIQUE,
	wallet_address TEXT UNIQUE,           -- always lowercase
	referral_code TEXT UNIQUE,            -- short invite code (e.g. "K3VD7Q")
	credential_id TEXT,                   -- last-used passkey hint (UX only)
	funded_at TEXT,
	invited_by TEXT,                      -- uid of the inviter (write-once)
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_wallet ON users(wallet_address);
CREATE INDEX idx_users_invited_by ON users(invited_by);
CREATE INDEX idx_users_referral_code ON users(referral_code);

CREATE TABLE passkeys (
	credential_id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	qx TEXT NOT NULL,
	qy TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_passkeys_uid_last_used ON passkeys(uid, last_used_at DESC);

CREATE TABLE payment_links (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL,
	wallet_address TEXT NOT NULL,
	amount TEXT NOT NULL,
	currency TEXT NOT NULL,
	reference TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
	tx_hash TEXT,
	paid_at TEXT,
	paid_by TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (owner_uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_payment_links_owner_created ON payment_links(owner_uid, created_at DESC);
CREATE INDEX idx_payment_links_owner_status ON payment_links(owner_uid, status);

CREATE TABLE pending_payments (
	user_op_hash TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	link_id TEXT,
	wallet_address TEXT NOT NULL,
	sender_address TEXT NOT NULL,
	amount TEXT NOT NULL,
	currency TEXT NOT NULL,
	user_op_json TEXT NOT NULL,
	meta TEXT,                            -- JSON context (swap quote, etc.)
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
	FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_pending_payments_uid ON pending_payments(uid);
CREATE INDEX idx_pending_payments_expires_at ON pending_payments(expires_at);

CREATE TABLE swap_quotes (
	quote_id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	chain_id INTEGER NOT NULL,
	token_in TEXT NOT NULL,
	token_out TEXT NOT NULL,
	amount_in TEXT NOT NULL,
	amount_out_estimated TEXT NOT NULL,
	minimum_amount_out TEXT NOT NULL,
	fee_bps INTEGER NOT NULL,
	fee_amount TEXT NOT NULL,
	protocol TEXT NOT NULL CHECK (protocol IN ('v3', 'v4')),
	pool_fee INTEGER NOT NULL,
	tick_spacing INTEGER,
	slippage_bps INTEGER NOT NULL,
	recipient TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'quoted'
		CHECK (status IN ('quoted', 'prepared', 'executed', 'expired')),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_swap_quotes_uid_created ON swap_quotes(uid, created_at DESC);
CREATE INDEX idx_swap_quotes_expires ON swap_quotes(expires_at);

CREATE TABLE contacts (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL,
	contact_uid TEXT NOT NULL,
	username TEXT NOT NULL,
	wallet_address TEXT NOT NULL,
	alias TEXT,
	created_at TEXT NOT NULL,
	UNIQUE(owner_uid, contact_uid),
	FOREIGN KEY (owner_uid) REFERENCES users(uid) ON DELETE CASCADE,
	FOREIGN KEY (contact_uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_contacts_owner ON contacts(owner_uid, created_at DESC);

-- Unified movements. One row per (user, movement); internal transfers produce
-- two rows (out for the payer, in for the recipient) at submit time.
CREATE TABLE ledger (
	id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	kind TEXT NOT NULL CHECK (kind IN ('payment', 'link', 'swap', 'fund', 'external')),
	tx_hash TEXT NOT NULL,
	log_index INTEGER,                    -- set only for cron-ingested entries
	token TEXT NOT NULL,                  -- whitelisted symbol
	amount TEXT NOT NULL,                 -- human decimal string
	counterparty TEXT,                    -- address (lowercase) of the other side
	counterparty_uid TEXT,                -- set when the other side is internal
	reference TEXT,
	link_id TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

-- Idempotent writes: app entries use log_index NULL (-1 in the index); cron
-- entries carry the real log index, so re-scans can INSERT OR IGNORE safely.
CREATE UNIQUE INDEX idx_ledger_dedup
	ON ledger(uid, tx_hash, direction, token, IFNULL(log_index, -1));
CREATE INDEX idx_ledger_uid_created ON ledger(uid, created_at DESC);

-- Cron indexer cursor (per chain / scan key).
CREATE TABLE sync_state (
	key TEXT PRIMARY KEY,
	last_block TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;
