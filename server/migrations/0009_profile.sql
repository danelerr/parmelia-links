-- Public profile fields, shown to OTHER users (pay page, public username
-- lookup, contacts). display_name humanizes the @username; social_url is one
-- social link (format allowlist enforced in the route - phishing surface).
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN social_url TEXT;
