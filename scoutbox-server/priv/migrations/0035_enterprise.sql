-- 0035_enterprise: Staff invites, SSO configurations and sign-in states, support tickets and support access grants become typed tables

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
CREATE TABLE sso_configs (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  issuer                                   TEXT NOT NULL CHECK (issuer IN ('local-test-idp')),
  client_id                                TEXT NOT NULL CHECK (length(client_id) <= 200 AND length(client_id) > 0),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  UNIQUE (org_id)
) STRICT;
CREATE TABLE sso_states (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  state_hash                               TEXT NOT NULL CHECK (length(state_hash) <= 64),
  nonce_hash                               TEXT NOT NULL CHECK (length(nonce_hash) <= 64),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  used_at                                  INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE UNIQUE INDEX sso_states_state_hash ON sso_states (state_hash);
CREATE TABLE support_tickets (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  subject                                  TEXT NOT NULL CHECK (length(subject) <= 160 AND length(subject) > 0),
  body                                     TEXT NOT NULL CHECK (length(body) <= 2000),
  status                                   TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX support_tickets_org ON support_tickets (org_id);
CREATE TABLE support_ticket_refs (
  ticket_id                                TEXT NOT NULL CHECK (length(ticket_id) > 0 AND length(ticket_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  kind                                     TEXT NOT NULL CHECK (kind IN ('case','import')),
  ref_id                                   TEXT NOT NULL CHECK (length(ref_id) > 0 AND length(ref_id) <= 80),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, ord)
) STRICT;
CREATE TABLE support_ticket_replies (
  ticket_id                                TEXT NOT NULL CHECK (length(ticket_id) > 0 AND length(ticket_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  at                                       INTEGER NOT NULL,
  by_name                                  TEXT NOT NULL CHECK (length(by_name) > 0 AND length(by_name) <= 200),
  text                                     TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 2000),
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, ord)
) STRICT;
CREATE TABLE support_access_grants (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  ticket_id                                TEXT NOT NULL CHECK (length(ticket_id) <= 80 AND length(ticket_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  hours                                    INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('requested','active')),
  requested_at                             INTEGER NOT NULL,
  approved_by_name                         TEXT CHECK (approved_by_name IS NULL OR length(approved_by_name) <= 200),
  approved_at                              INTEGER,
  expires_at                               INTEGER,
  FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (hours >= 1 AND hours <= 72),
  CHECK ((status = 'active') = (approved_at IS NOT NULL)),
  CHECK ((status = 'active') = (expires_at IS NOT NULL)),
  CHECK (status = 'active' OR approved_by_name IS NULL)
) STRICT;
CREATE INDEX support_access_grants_ticket ON support_access_grants (ticket_id, status);
CREATE INDEX support_access_grants_org ON support_access_grants (org_id);
CREATE TABLE support_access_log (
  grant_id                                 TEXT NOT NULL CHECK (length(grant_id) > 0 AND length(grant_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  at                                       INTEGER NOT NULL,
  what                                     TEXT NOT NULL CHECK (what IN ('org-records')),
  FOREIGN KEY (grant_id) REFERENCES support_access_grants(id) ON DELETE RESTRICT,
  PRIMARY KEY (grant_id, ord)
) STRICT;
