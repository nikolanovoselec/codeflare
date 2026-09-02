PRAGMA foreign_keys = ON;

CREATE TABLE usage_users (
  user_key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  account_status TEXT NOT NULL CHECK (account_status IN ('active', 'deleted')),
  data_since TEXT NOT NULL,
  deleted_at TEXT
);

CREATE UNIQUE INDEX usage_user_email ON usage_users (email);

CREATE TABLE usage_periods (
  user_key TEXT NOT NULL REFERENCES usage_users(user_key) ON DELETE CASCADE,
  period_kind TEXT NOT NULL CHECK (period_kind IN ('day', 'week', 'month', 'year')),
  period_start TEXT NOT NULL,
  runtime_seconds INTEGER NOT NULL CHECK (runtime_seconds >= 0),
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  source_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_key, period_kind, period_start)
);

CREATE INDEX usage_period_lookup ON usage_periods (period_kind, period_start);

CREATE TABLE report_deliveries (
  id TEXT PRIMARY KEY,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('scheduled', 'test')),
  dispatch_id TEXT NOT NULL,
  settings_revision INTEGER NOT NULL,
  report_month TEXT NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'accepted', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  claim_token TEXT,
  lease_expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE UNIQUE INDEX report_delivery_claim ON report_deliveries (delivery_kind, dispatch_id, recipient);

CREATE TABLE maintenance_claims (
  task TEXT NOT NULL,
  utc_date TEXT NOT NULL,
  claim_token TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (task, utc_date)
);
