-- Coordinated endpoint health without storing or logging secret RPC URLs.

CREATE TABLE rpc_endpoint_health (
	endpoint_key TEXT PRIMARY KEY,
	role TEXT NOT NULL
		CHECK (role IN ('read', 'write', 'indexer', 'archive', 'bundler')),
	provider_alias TEXT NOT NULL,
	circuit_state TEXT NOT NULL DEFAULT 'closed'
		CHECK (circuit_state IN ('closed', 'open', 'half_open')),
	consecutive_failures INTEGER NOT NULL DEFAULT 0
		CHECK (consecutive_failures >= 0),
	opened_until TEXT,
	last_success_at TEXT,
	last_failure_at TEXT,
	last_error_code TEXT,
	last_latency_ms INTEGER,
	updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_rpc_endpoint_health_role_state
	ON rpc_endpoint_health(role, circuit_state, updated_at);
