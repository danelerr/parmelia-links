-- Versioned asset semantics and auditable RPC-vs-projection comparisons.
-- USDC starts in events_plus_rpc shadow mode; promotion to events-only requires
-- a measured zero-drift window. Native ETH and rebasing aUSDC stay rpc_only.

INSERT OR IGNORE INTO asset_indexing_policies (
	chain_id, asset, contract_address, strategy, projection_version, enabled,
	drift_tolerance_raw, config_json, updated_at
) VALUES
	(
		421614, 'ETH', NULL, 'rpc_only', 1, 1, '0',
		'{"reason":"native_transfers_require_traces"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	(
		421614, 'USDC', '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
		'events_plus_rpc', 1, 1, '0',
		'{"exact":true,"promotion":"zero_drift_required"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	(
		421614, 'aUSDC', '0x460b97bd498e1157530ae3086301d5225b91216',
		'rpc_only', 1, 1, '0',
		'{"reason":"rebasing_asset_requires_index_validation"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	(
		42161, 'ETH', NULL, 'rpc_only', 1, 1, '0',
		'{"reason":"native_transfers_require_traces"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	(
		42161, 'USDC', '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
		'events_plus_rpc', 1, 1, '0',
		'{"exact":true,"promotion":"zero_drift_required"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	),
	(
		42161, 'aUSDC', '0x724dc807b04555b71ed48a6896b6f41593b8c637',
		'rpc_only', 1, 1, '0',
		'{"reason":"rebasing_asset_requires_index_validation"}',
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	);

CREATE TABLE balance_projection_baselines (
	chain_id INTEGER NOT NULL,
	account_address TEXT NOT NULL,
	asset TEXT NOT NULL,
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	balance_raw TEXT NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	observed_at TEXT NOT NULL,
	PRIMARY KEY (
		chain_id, account_address, asset, projection_version
	)
) STRICT;

CREATE TABLE balance_reconciliation_audits (
	id TEXT PRIMARY KEY,
	chain_id INTEGER NOT NULL,
	account_address TEXT NOT NULL,
	uid TEXT NOT NULL,
	asset TEXT NOT NULL,
	projection_version INTEGER NOT NULL CHECK (projection_version > 0),
	projected_raw TEXT,
	onchain_raw TEXT NOT NULL,
	drift_raw TEXT,
	tolerance_raw TEXT NOT NULL,
	block_number INTEGER NOT NULL CHECK (block_number >= 0),
	block_hash TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN (
		'baseline', 'match', 'drift', 'deferred'
	)),
	correction_reason TEXT,
	checked_at TEXT NOT NULL,
	FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_balance_reconciliation_asset_time
	ON balance_reconciliation_audits(
		chain_id, asset, checked_at DESC
	);

CREATE INDEX idx_balance_reconciliation_drift
	ON balance_reconciliation_audits(
		chain_id, outcome, checked_at DESC
	);
