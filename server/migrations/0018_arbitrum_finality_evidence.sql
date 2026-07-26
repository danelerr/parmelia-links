-- Arbitrum-specific L1 batch evidence from the NodeInterface virtual contract.

ALTER TABLE chain_blocks ADD COLUMN l1_batch_number INTEGER;
ALTER TABLE chain_blocks ADD COLUMN l1_confirmations INTEGER
	CHECK (l1_confirmations IS NULL OR l1_confirmations >= 0);

CREATE INDEX idx_chain_blocks_l1_evidence
	ON chain_blocks(
		chain_id, canonical, l1_confirmations, block_number DESC
	);
