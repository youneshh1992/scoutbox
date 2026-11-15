-- Staff invitations. The emailed code is stored only as its sha-256.
CREATE TABLE org_invites (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  email                                    TEXT NOT NULL CHECK (length(email) <= 254 AND length(email) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 80 AND length(name) > 0),
  role                                     TEXT NOT NULL CHECK (length(role) <= 60 AND length(role) > 0),
  token_hash                               TEXT NOT NULL CHECK (length(token_hash) <= 64),
  status                                   TEXT NOT NULL CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by_name                          TEXT CHECK (invited_by_name IS NULL OR length(invited_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  accepted_at                              INTEGER,
  revoked_at                               INTEGER,
  user_id                                  TEXT CHECK (user_id IS NULL OR length(user_id) <= 80 AND length(user_id) > 0),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (user_id IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX org_invites_token_hash ON org_invites (token_hash);
CREATE INDEX org_invites_org ON org_invites (org_id);
