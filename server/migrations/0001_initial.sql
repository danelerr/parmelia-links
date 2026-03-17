PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
	uid TEXT PRIMARY KEY,
	username TEXT UNIQUE,
	wallet_address TEXT,
	credential_id TEXT,
	funded_at TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS payment_links (
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

CREATE TABLE IF NOT EXISTS pending_payments (
	user_op_hash TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	link_id TEXT,
	wallet_address TEXT NOT NULL,
	sender_address TEXT NOT NULL,
	amount TEXT NOT NULL,
	currency TEXT NOT NULL,
	user_op_json TEXT NOT NULL,
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
	FOREIGN KEY (link_id) REFERENCES payment_links(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sent_transactions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	uid TEXT NOT NULL,
	tx_hash TEXT NOT NULL,
	amount TEXT NOT NULL,
	currency TEXT NOT NULL,
	to_wallet TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(uid, tx_hash),
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_payment_links_owner_created ON payment_links(owner_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_owner_status ON payment_links(owner_uid, status);
CREATE INDEX IF NOT EXISTS idx_pending_payments_uid ON pending_payments(uid);
CREATE INDEX IF NOT EXISTS idx_pending_payments_expires_at ON pending_payments(expires_at);
CREATE INDEX IF NOT EXISTS idx_sent_transactions_uid_created ON sent_transactions(uid, created_at DESC);
