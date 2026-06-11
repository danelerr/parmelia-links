-- Contacts ("amigos") + referral tracking.
--
-- contacts: each row is "owner saved this Parmelia user". We snapshot the
-- username/wallet at save time and key by contact_uid so renames don't break
-- the relationship.
CREATE TABLE IF NOT EXISTS contacts (
	id TEXT PRIMARY KEY,
	owner_uid TEXT NOT NULL,
	contact_uid TEXT NOT NULL,
	username TEXT NOT NULL,
	wallet_address TEXT NOT NULL,
	alias TEXT,
	created_at TEXT NOT NULL,
	UNIQUE(owner_uid, contact_uid),
	FOREIGN KEY (owner_uid) REFERENCES users(uid) ON DELETE CASCADE,
	FOREIGN KEY (contact_uid) REFERENCES users(uid) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_uid, created_at DESC);

-- Referral: who invited this user (set once during onboarding via ?ref=username).
ALTER TABLE users ADD COLUMN invited_by TEXT;
CREATE INDEX IF NOT EXISTS idx_users_invited_by ON users(invited_by);
