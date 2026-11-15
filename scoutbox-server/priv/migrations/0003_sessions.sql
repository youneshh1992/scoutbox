-- Bearer sessions. A row holds the token's sha-256, never the token.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  sid         TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('player','guardian','org','ts_reviewer')),
  ref_id      TEXT NOT NULL,
  org_user_id TEXT,
  via         TEXT CHECK (via IS NULL OR via IN ('sso')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  CHECK ((kind = 'org') = (org_user_id IS NOT NULL)),
  CHECK (expires_at > created_at),
  FOREIGN KEY (org_user_id, ref_id) REFERENCES org_users(id, org_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX sessions_ref ON sessions (kind, ref_id);
CREATE INDEX sessions_org_user ON sessions (org_user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);
