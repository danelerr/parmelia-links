-- Coordinated, secret-free cache of ERC-4337 bundler capabilities. The URL is
-- represented only by an opaque hash; no API key is persisted.

CREATE TABLE bundler_capabilities (
	endpoint_key TEXT NOT NULL,
	chain_id INTEGER NOT NULL,
	entry_point TEXT NOT NULL,
	supported INTEGER NOT NULL CHECK (supported IN (0, 1)),
	checked_at TEXT NOT NULL,
	PRIMARY KEY (endpoint_key, chain_id, entry_point)
) STRICT;

CREATE INDEX idx_bundler_capabilities_checked
	ON bundler_capabilities(checked_at);
