-- Internal swap quotes (Módulo 2). A quote is produced by /swap/quote, has a
-- short TTL, and /swap/prepare turns exactly one quote into a UserOperation.
-- Kept separate from pending_payments / payment_links on purpose: a swap is not
-- a payment and mixing them would pollute both models.
CREATE TABLE IF NOT EXISTS swap_quotes (
	quote_id TEXT PRIMARY KEY,
	uid TEXT NOT NULL,
	chain_id INTEGER NOT NULL,
	token_in TEXT NOT NULL,
	token_out TEXT NOT NULL,
	amount_in TEXT NOT NULL,             -- raw units (string)
	amount_out_estimated TEXT NOT NULL,  -- raw units, post-fee estimate
	minimum_amount_out TEXT NOT NULL,    -- raw units, post-fee floor (slippage applied)
	fee_bps INTEGER NOT NULL,
	fee_amount TEXT NOT NULL,            -- raw units of token_out
	protocol TEXT NOT NULL CHECK (protocol IN ('v3', 'v4')),
	pool_fee INTEGER NOT NULL,
	tick_spacing INTEGER,                -- v4 only
	slippage_bps INTEGER NOT NULL,
	recipient TEXT NOT NULL,             -- always the user's smart account
	status TEXT NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted', 'prepared', 'expired')),
	created_at TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_swap_quotes_uid_created ON swap_quotes(uid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_swap_quotes_expires ON swap_quotes(expires_at);
