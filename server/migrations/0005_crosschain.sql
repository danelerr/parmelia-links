-- Cross-chain operations (CCTP v2). Separate from pending_payments: multi-step,
-- multi-chain, hours-long lifecycle with attestation polling. See docs/design/cross-chain.md.
--
-- A row is created at quote/submit time (status 'quoted'/'submitted'); the relayer
-- advances it through waiting_attestation -> minting -> completed. `message_nonce`
-- and `attestation` let the relayer (or a manual_complete) finish the mint, since
-- a burned transfer can always be completed (receiveMessage is permissionless).

CREATE TABLE IF NOT EXISTS crosschain_operations (
	op_id                  TEXT PRIMARY KEY,
	uid                    TEXT NOT NULL,
	direction              TEXT NOT NULL,                 -- inbound | outbound
	provider               TEXT NOT NULL DEFAULT 'cctp',
	cctp_mode              TEXT NOT NULL,                 -- standard | fast
	source_chain_id        INTEGER NOT NULL,             -- EVM chainId
	destination_chain_id   INTEGER NOT NULL,             -- EVM chainId
	source_domain          INTEGER NOT NULL,             -- CCTP domain (!= chainId)
	destination_domain     INTEGER NOT NULL,             -- CCTP domain (!= chainId)
	destination_caller     TEXT,                          -- bytes32(0) en v1 (permissionless)
	source_tx_hash         TEXT,
	destination_tx_hash    TEXT,
	message_nonce          TEXT,                          -- nonce/hash del mensaje CCTP
	message_bytes          TEXT,                          -- mensaje crudo (o re-fetch de Iris)
	attestation            TEXT,                          -- atestación de Iris (para receiveMessage)
	token                  TEXT NOT NULL DEFAULT 'USDC',
	amount_in              TEXT NOT NULL,                 -- atomic units
	parmelia_fee           TEXT NOT NULL DEFAULT '0',     -- atomic units
	max_fee                TEXT,                          -- CCTP fast maxFee (atomic)
	min_finality_threshold INTEGER,                       -- 1000 fast / 2000 standard
	cctp_fee_estimated     TEXT,
	amount_out_expected    TEXT,
	recipient              TEXT NOT NULL,                 -- destination address (hex)
	status                 TEXT NOT NULL,
	status_detail          TEXT,
	created_at             TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
	completed_at           TEXT
);

-- A user's cross-chain history (most recent first).
CREATE INDEX IF NOT EXISTS idx_crosschain_uid ON crosschain_operations(uid, created_at DESC);
-- Relayer picks up in-flight ops by status.
CREATE INDEX IF NOT EXISTS idx_crosschain_status ON crosschain_operations(status);
