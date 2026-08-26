-- Phase 3: durable CCTP mint preparation, signer serialization and evidence.
-- A relayer transaction is signed and persisted before broadcast so a Worker
-- restart can rebroadcast the exact bytes without allocating another nonce.
ALTER TABLE crosschain_operations ADD COLUMN message_nonce TEXT;
ALTER TABLE crosschain_operations ADD COLUMN minted_amount_atomic TEXT;
ALTER TABLE crosschain_operations ADD COLUMN mint_raw_transaction TEXT;
ALTER TABLE crosschain_operations ADD COLUMN mint_signer_address TEXT;
ALTER TABLE crosschain_operations ADD COLUMN mint_nonce INTEGER
	CHECK (mint_nonce IS NULL OR mint_nonce >= 0);
ALTER TABLE crosschain_operations ADD COLUMN mint_broadcast_at TEXT;

CREATE TABLE payment_signer_leases (
	lease_key TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE crosschain_mint_attempts (
	id TEXT PRIMARY KEY,
	op_id TEXT NOT NULL,
	tx_hash TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL CHECK (status IN ('prepared','broadcast','pending','success','reverted','unknown')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (op_id) REFERENCES crosschain_operations(op_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_crosschain_mint_attempts_op
	ON crosschain_mint_attempts(op_id, created_at DESC);

CREATE INDEX idx_crosschain_message_nonce
	ON crosschain_operations(destination_chain_id, message_nonce)
	WHERE message_nonce IS NOT NULL;
