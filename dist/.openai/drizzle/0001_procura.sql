CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  company_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions(account_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  rfp_filename TEXT NOT NULL,
  rfp_object_key TEXT NOT NULL,
  rfp_text_key TEXT NOT NULL,
  rfp_word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  analyzed_at TEXT
);
CREATE INDEX opportunities_owner_idx ON opportunities(account_id, updated_at DESC);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  vendor_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  object_key TEXT NOT NULL,
  text_key TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  review_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT
);
CREATE INDEX proposals_opportunity_idx ON proposals(account_id, opportunity_id, created_at);

CREATE TABLE login_attempts (
  email TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE demo_uses (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE
);
