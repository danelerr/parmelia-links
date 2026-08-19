-- Issuer-neutral product discovery for GatoPago Card. This table records only
-- user-declared interest; it is not an application, KYC record or card account.
CREATE TABLE IF NOT EXISTS card_interest (
  uid TEXT PRIMARY KEY NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  country TEXT NOT NULL,
  use_case TEXT NOT NULL,
  monthly_spend TEXT NOT NULL,
  card_preference TEXT NOT NULL,
  wallet_pay_importance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
