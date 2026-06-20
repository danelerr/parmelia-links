-- Flow B (open payments via PaymentRouter): map the on-chain invoiceId (bytes32)
-- back to the payment_intent so the indexer can attribute an InvoicePaid event.
ALTER TABLE payment_intents ADD COLUMN onchain_id TEXT;
CREATE INDEX IF NOT EXISTS idx_intents_onchain ON payment_intents(onchain_id);
