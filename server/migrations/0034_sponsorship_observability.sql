-- Immutable attribution for each prepared UserOperation. This makes provider
-- canaries, incident analysis and paymaster rotations observable without
-- decoding paymasterAndData after the fact. Existing rows remain "legacy".

ALTER TABLE pending_payments ADD COLUMN sponsorship_provider TEXT NOT NULL DEFAULT 'legacy'
	CHECK (sponsorship_provider IN ('parmelia', 'erc7677', 'self-funded', 'legacy'));

ALTER TABLE pending_payments ADD COLUMN sponsorship_paymaster_address TEXT
	CHECK (sponsorship_paymaster_address IS NULL OR (
		length(sponsorship_paymaster_address) = 42
		AND substr(sponsorship_paymaster_address, 1, 2) = '0x'
		AND substr(sponsorship_paymaster_address, 3) NOT GLOB '*[^0-9a-fA-F]*'
	));

CREATE INDEX idx_pending_payments_sponsorship_status
	ON pending_payments(sponsorship_provider, sponsorship_paymaster_address, status, created_at);
