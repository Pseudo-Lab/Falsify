-- Falsify shared records v1.
-- Authors sign in with a self-chosen username and password. Only salted scrypt password hashes
-- and SHA-256 hashes of 256-bit session tokens are stored; an account is not a verified identity.
-- Record payloads are client-reported claims. public_payload is the redacted projection
-- computed once at insert (payloads are immutable), so anonymous reads never load private fields.
CREATE TABLE authors (
  id TEXT PRIMARY KEY,
  -- Lowercase ASCII; the unique index makes concurrent registrations of one name race-safe.
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES authors (id),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT
);

CREATE INDEX sessions_author ON sessions (author_id);

CREATE TABLE records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES authors (id),
  kind TEXT NOT NULL CHECK (kind IN ('harness', 'run', 'review')),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared')),
  payload TEXT NOT NULL,
  public_payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  ref_id TEXT,
  supersedes_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE UNIQUE INDEX records_owner_payload ON records (owner_id, kind, payload_hash);
CREATE INDEX records_owner_seq ON records (owner_id, seq);
CREATE INDEX records_owner_kind_seq ON records (owner_id, kind, seq);
CREATE INDEX records_visibility_seq ON records (visibility, seq);
CREATE INDEX records_visibility_kind_seq ON records (visibility, kind, seq);
CREATE INDEX records_ref ON records (ref_id);

CREATE TABLE rate_counters (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX rate_counters_window ON rate_counters (window_start);
