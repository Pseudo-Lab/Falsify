-- Falsify shared records v1: invite-only team membership.
-- Every authenticated request now requires an active team_members row. Existing authors are NOT
-- grandfathered: their records and authorship stay, but their sessions and logins are denied until an
-- operator admits them explicitly (cloud/api/scripts/invites.mjs admit). There is no public admin endpoint.
CREATE TABLE team_members (
  author_id TEXT PRIMARY KEY REFERENCES authors (id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Only the SHA-256 hex of an invitation code is stored. A code is single use: claimed_by is set in the
-- same D1 batch that creates the author and the membership.
CREATE TABLE invitations (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_by TEXT REFERENCES authors (id),
  claimed_at TEXT,
  revoked_at TEXT
);

CREATE INDEX invitations_expires ON invitations (expires_at);
