-- Hot-path indexes for the independently scaled Payments data plane. These
-- follow the actual checkout, reconciliation, health and retention queries;
-- they do not change economic state or cutover identifiers.
CREATE UNIQUE INDEX idx_intents_link_id
	ON payment_intents(link_id) WHERE link_id IS NOT NULL;
CREATE INDEX idx_intents_merchant_cursor
	ON payment_intents(merchant_id, created_at DESC, id DESC);
CREATE INDEX idx_intents_merchant_mode_status_cursor
	ON payment_intents(merchant_id, mode, status, created_at DESC, id DESC);

CREATE INDEX idx_attempts_source_active_created
	ON payment_attempts(source_chain_id, created_at)
	WHERE status IN ('reserved','submitted','processing');
CREATE INDEX idx_attempts_intent_created
	ON payment_attempts(intent_id, created_at DESC);

CREATE INDEX idx_payment_events_chain_canonical_height
	ON payment_chain_events(chain_id, block_number)
	WHERE canonical = 1;
CREATE INDEX idx_rate_limits_window_start ON rate_limits(window_start);
CREATE INDEX idx_payment_fee_ledger_status_created
	ON payment_fee_ledger(status, created_at);
CREATE INDEX idx_webhook_endpoints_active_mode
	ON webhook_endpoints(merchant_id, mode) WHERE status = 'active';
CREATE INDEX idx_events_merchant_cursor
	ON events(merchant_id, created_at DESC, id DESC);
