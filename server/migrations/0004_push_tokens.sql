-- Multi-device push: one row per device token instead of a single
-- users.push_token column. A token (per browser/PWA install) maps to exactly one
-- user; if a device re-registers under a different account, the token moves
-- (ON CONFLICT update in code), so a device never keeps notifying a logged-out
-- account. notifyUser fans out to every token and prunes dead ones individually.

CREATE TABLE IF NOT EXISTS push_tokens (
	token      TEXT PRIMARY KEY,
	uid        TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_uid ON push_tokens(uid);

-- Carry over the existing single tokens.
INSERT OR IGNORE INTO push_tokens (token, uid, created_at)
	SELECT push_token, uid, COALESCE(created_at, datetime('now'))
	FROM users
	WHERE push_token IS NOT NULL AND push_token != '';

-- Retire the deprecated single-token column.
ALTER TABLE users DROP COLUMN push_token;
