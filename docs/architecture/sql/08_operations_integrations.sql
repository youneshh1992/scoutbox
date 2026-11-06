-- =====================================================================
-- 08_operations_integrations.sql — ScoutBox target relational schema
-- Scope: integrations (API keys, webhooks, imports, prospects, identity
-- reviews), enterprise (org invites, SSO, support), group workspaces,
-- grassroots operations (open trials, matchdays, friendlies), saved
-- searches, resumable uploads, billing invoices, product catalogues
-- (plans, archetypes), demo reputation seed, delivery idempotency and
-- operational settings.
--
-- Conventions: see ddl-conventions (STRICT tables, snake_case, epoch-ms
-- INTEGER *_at, TEXT YYYY-MM-DD *_date, booleans INTEGER 0/1, JSON only
-- where justified, *_hash for secrets, snapshots marked).
--
-- Parent tables created earlier in lexical order and referenced here:
--   orgs(id), org_users(id), players(id), guardians(id)      (01_identity.sql)
--   recruitment_cases(id), assessment_templates(id, version),
--   signings(id), notifications(id)                          (other files)
--
-- Ids: every source row that already has an id keeps it as TEXT PRIMARY KEY
-- (prefixes noted per table). Nested rows without ids get a natural
-- composite PRIMARY KEY (parent id + ordinal/natural key) — stated per table.
-- =====================================================================


-- =====================================================================
-- M13 F1 — imports, prospects, identity reviews, API keys, webhooks
-- S13a: IMPLEMENTED, migration 0034_integrations REGISTERED (repositories/integrations.mjs, 6 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =====================================================================
--
-- An import batch (imp-*) is one CSV upload's dry run (domains/integrations/imports.mjs). Its header row is ordered
-- import_batch_columns rows; `field` is the prospect field the column mapping named for that column (NULL when no
-- mapping named it), and import_batches.mapped says whether a mapping was given at all (the response's `mapping` is
-- null otherwise). Every data row is an import_batch_rows row: the record's fields are columns (NULL when the CSV did
-- not map the field, '' when the mapped cell was empty; a cell longer than its column holds is a row error, kept cut to
-- the limit), its validation messages are ordered import_batch_row_errors rows, match_player_id names the platform
-- player it matched (no key: a tombstone survives an account deletion). The summary counts are columns (they must add
-- up). The history (validated, committed, reversed) is typed: a commit's detail is created_count, a reversal's
-- removed_count and kept_count, a validation's the batch summary itself (not stored twice). No JSON column: the
-- header, the mapping and the messages were JSON blobs in the target design.
--
-- A prospect (prs-*) is an organisation-private record, never a platform account. At most one live (not reversed)
-- prospect per (org_id, provider, external_id): the import's validation and the identity review's "keep separate"
-- both check it, and the partial unique index holds it. The never-written linked_player_id and modified_at of the
-- target design are gone (the export still answers linkedPlayerId: null). import_batch_created_prospects lists the
-- prospects a commit created, in order: the ones a reversal undoes (a review kept separate is not among them).
--
-- An identity review (idr-*) names its batch row with a key (batch_id, row_no); its record is that row's, never a copy.
--
-- An API key (key-*) is stored only as the sha-256 of the plain key (shown once); scopes are ordered rows. last_used_at
-- is written by an explicit UPDATE on each authorised call.
--
-- A webhook endpoint (whk-*): the signing secrets are plain because the server signs with them (OPERATIONS.md), and no
-- list serves them; events are ordered rows. A delivery (dlv-*) carries a typed payload: subject_id is the record the
-- event names (the batch, review, transition or dispatch), created_count only for import.committed, resolution only
-- for identity.resolved; event_id is the receivers' replay key, unique. Attempts are numbered rows, each an HTTP status
-- or an error.
--
-- Keys: organisations and staff RESTRICT; inside the domain RESTRICT (a prospect's batch, a review's row, a delivery's
-- endpoint) or a child's CASCADE. Player ids carry no key.
CREATE TABLE import_batches (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  kind                                     TEXT NOT NULL CHECK (kind IN ('prospects')),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  mapped                                   INTEGER NOT NULL CHECK (mapped IN (0,1)),
  status                                   TEXT NOT NULL CHECK (status IN ('validated','committed','reversed')),
  summary_total                            INTEGER NOT NULL,
  summary_creatable                        INTEGER NOT NULL,
  summary_errors                           INTEGER NOT NULL,
  summary_duplicates_in_file               INTEGER NOT NULL,
  summary_already_imported                 INTEGER NOT NULL,
  summary_linked_existing                  INTEGER NOT NULL,
  summary_ambiguous                        INTEGER NOT NULL,
  committed_at                             INTEGER,
  reversed_at                              INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (summary_total >= 0 AND summary_total <= 2000),
  CHECK (summary_creatable >= 0 AND summary_errors >= 0 AND summary_duplicates_in_file >= 0 AND summary_already_imported >= 0 AND summary_linked_existing >= 0 AND summary_ambiguous >= 0),
  CHECK (summary_total = summary_creatable + summary_errors + summary_duplicates_in_file + summary_already_imported + summary_linked_existing + summary_ambiguous),
  CHECK ((status = 'validated') = (committed_at IS NULL)),
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL))
) STRICT;
CREATE INDEX import_batches_org_status ON import_batches (org_id, status);
CREATE TABLE import_batch_columns (
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) > 0 AND length(batch_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  header                                   TEXT NOT NULL CHECK (length(header) <= 200),
  field                                    TEXT CHECK (field IS NULL OR field IN ('name','dob','position','foot','heightCm','provider','externalId','notes')),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, ord)
) STRICT;
CREATE TABLE import_batch_rows (
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) > 0 AND length(batch_id) <= 80),
  row_no                                   INTEGER NOT NULL CHECK (row_no >= 2),
  record_name                              TEXT CHECK (record_name IS NULL OR length(record_name) <= 200),
  record_dob                               TEXT CHECK (record_dob IS NULL OR length(record_dob) <= 40),
  record_position                          TEXT CHECK (record_position IS NULL OR length(record_position) <= 20),
  record_foot                              TEXT CHECK (record_foot IS NULL OR length(record_foot) <= 20),
  record_height_cm                         TEXT CHECK (record_height_cm IS NULL OR length(record_height_cm) <= 20),
  record_provider                          TEXT CHECK (record_provider IS NULL OR length(record_provider) <= 80),
  record_external_id                       TEXT CHECK (record_external_id IS NULL OR length(record_external_id) <= 80),
  record_notes                             TEXT CHECK (record_notes IS NULL OR length(record_notes) <= 2000),
  disposition                              TEXT NOT NULL CHECK (disposition IN ('create','error','duplicate_in_file','already_imported','linked_player_exists','ambiguous_identity')),
  match_player_id                          TEXT CHECK (match_player_id IS NULL OR (length(match_player_id) > 0 AND length(match_player_id) <= 80)),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, row_no),
  CHECK ((match_player_id IS NOT NULL) = (disposition IN ('linked_player_exists','ambiguous_identity')))
) STRICT;
CREATE TABLE import_batch_row_errors (
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) > 0 AND length(batch_id) <= 80),
  row_no                                   INTEGER NOT NULL,
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  message                                  TEXT NOT NULL CHECK (length(message) > 0 AND length(message) <= 300),
  FOREIGN KEY (batch_id, row_no) REFERENCES import_batch_rows(batch_id, row_no) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, row_no, ord)
) STRICT;
CREATE TABLE import_batch_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) <= 80 AND length(batch_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org_user')),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('validated','committed','reversed')),
  created_count                            INTEGER,
  removed_count                            INTEGER,
  kept_count                               INTEGER,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK ((action = 'committed') = (created_count IS NOT NULL)),
  CHECK ((action = 'reversed') = (removed_count IS NOT NULL)),
  CHECK ((action = 'reversed') = (kept_count IS NOT NULL)),
  CHECK (created_count IS NULL OR created_count >= 0),
  CHECK (removed_count IS NULL OR (removed_count >= 0 AND kept_count >= 0))
) STRICT;
CREATE INDEX import_batch_history_batch ON import_batch_history (batch_id, at);
CREATE TABLE prospects (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) <= 80 AND length(batch_id) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 200 AND length(name) > 0),
  dob                                      TEXT CHECK (dob IS NULL OR length(dob) <= 10),
  position                                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  foot                                     TEXT CHECK (foot IS NULL OR length(foot) <= 20 AND length(foot) > 0),
  height_cm                                INTEGER,
  provider                                 TEXT NOT NULL CHECK (length(provider) <= 80 AND length(provider) > 0),
  external_id                              TEXT NOT NULL CHECK (length(external_id) <= 80 AND length(external_id) > 0),
  notes                                    TEXT CHECK (notes IS NULL OR length(notes) <= 2000 AND length(notes) > 0),
  minor                                    INTEGER CHECK (minor IS NULL OR minor IN (0,1)),
  created_at                               INTEGER NOT NULL,
  reversed_at                              INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE RESTRICT,
  CHECK (dob IS NULL OR dob GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 230))
) STRICT;
CREATE UNIQUE INDEX prospects_live_identity ON prospects (org_id, provider, external_id) WHERE reversed_at IS NULL;
CREATE INDEX prospects_org ON prospects (org_id, reversed_at);
CREATE INDEX prospects_batch ON prospects (batch_id);
CREATE TABLE import_batch_created_prospects (
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) > 0 AND length(batch_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  prospect_id                              TEXT NOT NULL CHECK (length(prospect_id) > 0 AND length(prospect_id) <= 80),
  FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE RESTRICT,
  PRIMARY KEY (batch_id, ord),
  UNIQUE (prospect_id)
) STRICT;
CREATE TABLE identity_reviews (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  batch_id                                 TEXT NOT NULL CHECK (length(batch_id) <= 80 AND length(batch_id) > 0),
  row_no                                   INTEGER NOT NULL,
  candidate_player_id                      TEXT NOT NULL CHECK (length(candidate_player_id) <= 80 AND length(candidate_player_id) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolved_by_name                         TEXT CHECK (resolved_by_name IS NULL OR length(resolved_by_name) <= 200),
  resolved_at                              INTEGER,
  resolution                               TEXT CHECK (resolution IS NULL OR resolution IN ('linked','kept_separate')),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id, row_no) REFERENCES import_batch_rows(batch_id, row_no) ON DELETE RESTRICT,
  CHECK ((status = 'resolved') = (resolution IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  UNIQUE (batch_id, row_no)
) STRICT;
CREATE INDEX identity_reviews_org_status ON identity_reviews (org_id, status);
CREATE TABLE api_keys (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  key_hash                                 TEXT NOT NULL CHECK (length(key_hash) <= 64),
  label                                    TEXT NOT NULL CHECK (length(label) <= 60),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  last_used_at                             INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (key_hash GLOB '[0-9a-f]*' AND length(key_hash) = 64),
  UNIQUE (key_hash)
) STRICT;
CREATE INDEX api_keys_org ON api_keys (org_id);
CREATE TABLE api_key_scopes (
  api_key_id                               TEXT NOT NULL CHECK (length(api_key_id) > 0 AND length(api_key_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  scope                                    TEXT NOT NULL CHECK (scope IN ('export:prospects','export:shortlist')),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (api_key_id, ord),
  UNIQUE (api_key_id, scope)
) STRICT;
CREATE TABLE webhook_endpoints (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  url                                      TEXT NOT NULL CHECK (length(url) <= 2000 AND length(url) > 0),
  secret                                   TEXT NOT NULL CHECK (length(secret) <= 200 AND length(secret) > 0),
  secret_prev                              TEXT CHECK (secret_prev IS NULL OR length(secret_prev) <= 200 AND length(secret_prev) > 0),
  secret_prev_valid_until                  INTEGER,
  active                                   INTEGER NOT NULL CHECK (active IN (0,1)),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((secret_prev IS NULL) = (secret_prev_valid_until IS NULL))
) STRICT;
CREATE INDEX webhook_endpoints_org ON webhook_endpoints (org_id, active);
CREATE TABLE webhook_endpoint_events (
  endpoint_id                              TEXT NOT NULL CHECK (length(endpoint_id) > 0 AND length(endpoint_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  event                                    TEXT NOT NULL CHECK (event IN ('import.committed','identity.resolved','transition.granted','transition.revoked','delivery.failed')),
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  PRIMARY KEY (endpoint_id, ord),
  UNIQUE (endpoint_id, event)
) STRICT;
CREATE TABLE webhook_deliveries (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  endpoint_id                              TEXT NOT NULL CHECK (length(endpoint_id) <= 80 AND length(endpoint_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  event_id                                 TEXT NOT NULL CHECK (length(event_id) <= 80 AND length(event_id) > 0),
  type                                     TEXT NOT NULL CHECK (type IN ('import.committed','identity.resolved','transition.granted','transition.revoked','delivery.failed')),
  subject_id                               TEXT NOT NULL CHECK (length(subject_id) <= 80 AND length(subject_id) > 0),
  created_count                            INTEGER,
  resolution                               TEXT CHECK (resolution IS NULL OR resolution IN ('linked','kept_separate')),
  status                                   TEXT NOT NULL CHECK (status IN ('queued','retrying','delivered','failed','abandoned')),
  next_at                                  INTEGER NOT NULL,
  created_at                               INTEGER NOT NULL,
  delivered_at                             INTEGER,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  UNIQUE (event_id),
  CHECK ((type = 'import.committed') = (created_count IS NOT NULL)),
  CHECK (created_count IS NULL OR created_count >= 0),
  CHECK ((type = 'identity.resolved') = (resolution IS NOT NULL)),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
) STRICT;
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_at);
CREATE TABLE webhook_delivery_attempts (
  delivery_id                              TEXT NOT NULL CHECK (length(delivery_id) > 0 AND length(delivery_id) <= 80),
  attempt_no                               INTEGER NOT NULL CHECK (attempt_no >= 1),
  attempted_at                             INTEGER NOT NULL,
  http_status                              INTEGER CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
  error                                    TEXT CHECK (error IS NULL OR length(error) <= 200),
  FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, attempt_no),
  CHECK ((http_status IS NULL) <> (error IS NULL))
) STRICT;


-- =====================================================================
-- M13 F12 — staff invites, SSO, support tickets and support access
-- S13b: IMPLEMENTED, migration 0035_enterprise REGISTERED (repositories/enterprise.mjs, 6 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =====================================================================
--
-- A staff invite (inv-*, domains/enterprise/enterprise.mjs): the emailed code is stored only as its sha-256
-- (token_hash, unique); the public accept hashes the presented code and looks it up. pending → accepted (user_id names
-- the staff account it bound, a RESTRICT key) | revoked | expired (written when an expired code is presented). email
-- and name are the invitee's personal data, held before any account exists. No list serves the hash.
--
-- An SSO configuration (sso-*): one per organisation (UNIQUE org_id); only the local test identity provider can be
-- named. No identity-provider secret is stored (TEST_IDP_SECRET is the environment's).
--
-- An SSO sign-in state (sst-*): the state and the nonce handed to the browser are stored only as hashes; the callback
-- hashes the state to find the row and compares the token's nonce by its hash. Single use: used_at is set by a
-- conditional UPDATE, so two callbacks on one state cannot both pass. Nothing prunes used or expired states yet.
--
-- A support ticket (tkt-*): the records it references are ordered support_ticket_refs rows, kind 'case' or 'import'
-- (the only kinds the support read resolves; anything else is refused at the route), by id, nothing copied. Trust &
-- Safety's replies are ordered support_ticket_replies rows (text required).
--
-- A support access grant (sag-*): requested by Trust & Safety for 1–72 hours, approved by a lead of the organisation
-- (approved_at and expires_at set exactly then); expiry is derived from expires_at, never a stored state. Every read
-- under it is an ordered support_access_log row (audit: RESTRICT, never cascaded away).
--
-- Keys: organisations and staff RESTRICT; a grant's ticket RESTRICT; child rows cascade with their ticket.
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

-- =====================================================================
-- M13 F8 — group workspaces and group grants
-- S13c: IMPLEMENTED, migration 0036_groups REGISTERED (repositories/groups.mjs, 6 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =====================================================================
--
-- A group (grp-*, domains/groups/groups.mjs): created by Trust & Safety with one admin organisation (never an agency).
-- Its members are group_members rows, one per organisation, with an admin flag: an admin is always a member (the
-- earlier design's separate group_admins table could not say so). The admin invites (group_pending_invites, one per
-- invited organisation, never a member's; deleted when accepted — there is no decline); a lead of the invited
-- organisation accepts. Leaving deletes the member row. Groups are never deleted, so their rows cascade only in
-- principle.
--
-- group_shared_templates names an assessment template by its id alone: template ids are shared by every version and
-- every club until after S14 (known-issues.md), so there is no key. Nothing reads the list beyond echoing the group.
-- group_programmes (pgm-*): a name (1–100) and an optional region (≤80).
--
-- A group grant (gnt-*): one organisation shares one resource with named fellow members (group_grant_recipients,
-- ordered, each once, never the owner) until expires_at (1–180 days after creation) or revocation. resource_id is
-- polymorphic with no key: '*' for a shortlist (the owner's whole shortlist, read from the ledger), a
-- recruitment_cases id for 'case', an assessments id for 'assessment'. Ownership, liveness, shared membership and each
-- player's visibility to the reader are re-checked on every shared read. revoked_at and revoke_reason are set
-- together: 'revoked_by_owner', or 'group_departure' when an organisation leaves and the owner then shares no group
-- with any of the grant's recipients (the earlier code tested only the first recipient).
--
-- Keys: organisations RESTRICT; a grant's group RESTRICT; child rows cascade with their group or grant.
CREATE TABLE groups (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  name                                     TEXT NOT NULL CHECK (length(name) <= 100 AND length(name) > 0),
  created_at                               INTEGER NOT NULL
) STRICT;
CREATE TABLE group_members (
  group_id                                 TEXT NOT NULL CHECK (length(group_id) > 0 AND length(group_id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) > 0 AND length(org_id) <= 80),
  admin                                    INTEGER NOT NULL CHECK (admin IN (0,1)),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (group_id, org_id)
) STRICT;
CREATE INDEX group_members_org ON group_members (org_id, group_id);
CREATE TABLE group_pending_invites (
  group_id                                 TEXT NOT NULL CHECK (length(group_id) > 0 AND length(group_id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) > 0 AND length(org_id) <= 80),
  invited_by_org_id                        TEXT NOT NULL CHECK (length(invited_by_org_id) > 0 AND length(invited_by_org_id) <= 80),
  invited_at                               INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (invited_by_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (group_id, org_id)
) STRICT;
CREATE INDEX group_pending_invites_org ON group_pending_invites (org_id);
CREATE TABLE group_shared_templates (
  group_id                                 TEXT NOT NULL CHECK (length(group_id) > 0 AND length(group_id) <= 80),
  template_id                              TEXT NOT NULL CHECK (length(template_id) > 0 AND length(template_id) <= 80),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, template_id)
) STRICT;
CREATE TABLE group_programmes (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  group_id                                 TEXT NOT NULL CHECK (length(group_id) <= 80 AND length(group_id) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 100 AND length(name) > 0),
  region                                   TEXT CHECK (region IS NULL OR length(region) <= 80 AND length(region) > 0),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX group_programmes_group ON group_programmes (group_id);
CREATE TABLE group_grants (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  group_id                                 TEXT NOT NULL CHECK (length(group_id) <= 80 AND length(group_id) > 0),
  from_org_id                              TEXT NOT NULL CHECK (length(from_org_id) <= 80 AND length(from_org_id) > 0),
  from_org_name                            TEXT NOT NULL CHECK (length(from_org_name) <= 200),
  resource_kind                            TEXT NOT NULL CHECK (resource_kind IN ('shortlist','case','assessment')),
  resource_id                              TEXT NOT NULL CHECK (length(resource_id) <= 80 AND length(resource_id) > 0),
  expires_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  revoke_reason                            TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('group_departure','revoked_by_owner')),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE RESTRICT,
  FOREIGN KEY (from_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (resource_kind <> 'shortlist' OR resource_id = '*'),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
) STRICT;
CREATE INDEX group_grants_from_org ON group_grants (from_org_id);
CREATE INDEX group_grants_group ON group_grants (group_id);
CREATE TABLE group_grant_recipients (
  grant_id                                 TEXT NOT NULL CHECK (length(grant_id) > 0 AND length(grant_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) > 0 AND length(org_id) <= 80),
  FOREIGN KEY (grant_id) REFERENCES group_grants(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (grant_id, ord),
  UNIQUE (grant_id, org_id)
) STRICT;
CREATE INDEX group_grant_recipients_org ON group_grant_recipients (org_id);


-- ---------------------------------------------------------------------
-- upload_sessions
-- source: db.uploadSessions  created at m12/shared.mjs:27; rows minted at m12/operations.mjs:167-172
-- owner/writer: m12/operations.mjs   lifecycle: open -> finalised | aborted | abandoned (sweep after 24h, operations.mjs:382-387); never deleted
-- mapping: id -> id (upl-N); playerId -> player_id; size -> size_bytes; mime -> mime; title -> title (<=120);
--          sha256 -> declared_sha256 (client-declared checksum, not a secret, nullable); chunkSize -> chunk_size;
--          totalChunks -> total_chunks; received[] -> upload_session_chunks child table; status -> status;
--          createdAt -> created_at; finalisedMediaId -> finalised_media_id
-- notes: chunk BYTES live on disk under DATA_DIR/upload-tmp/<id>/ — not schema. finalised_media_id names the
--        player media item created at finalise (player media table in 01_identity); no FK: media rows are
--        deleted with the player while upload sessions are NOT touched by deletePlayerData (orphan defect) —
--        hence ON DELETE CASCADE here so the migration fixes it. Read patterns: by id+player
--        (operations.mjs:179); sweep status='open' AND created_at < now-24h (operations.mjs:383).
-- ---------------------------------------------------------------------
CREATE TABLE upload_sessions (
  id                 TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  size_bytes         INTEGER NOT NULL CHECK (size_bytes > 0),
  mime               TEXT NOT NULL,
  title              TEXT NOT NULL,
  declared_sha256    TEXT,
  chunk_size         INTEGER NOT NULL,
  total_chunks       INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open', 'finalised', 'aborted', 'abandoned')),
  created_at         INTEGER NOT NULL,
  finalised_media_id TEXT                              -- player media id (01_identity); no FK, see notes
) STRICT;
CREATE INDEX upload_sessions_player_id ON upload_sessions(player_id);
CREATE INDEX upload_sessions_status_created_at ON upload_sessions(status, created_at);

-- source: db.uploadSessions[].received[]  (chunk indices, operations.mjs:197)
-- mapping: each index -> (upload_session_id, chunk_index)
-- notes: idempotent re-upload of the same index is a no-op (PK).
CREATE TABLE upload_session_chunks (
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  chunk_index       INTEGER NOT NULL CHECK (chunk_index >= 0),
  PRIMARY KEY (upload_session_id, chunk_index)
) STRICT;


-- ---------------------------------------------------------------------
-- saved_searches
-- source: db.savedSearches  created at server.mjs:215; rows minted at server.mjs:2424
-- owner/writer: server.mjs   lifecycle: HARD delete by owner org (server.mjs:2429-2434); untouched by player deletion (4017)
-- mapping: id -> id (ss-N); orgId -> org_id; userId -> user_id; scoutName -> scout_name; name -> name (<=120);
--          filters{} -> filters_json; createdAt -> created_at
-- notes: filters_json stays JSON — free-form by design: an arbitrary object the client sends, matched key by key
--        by matchesSearch (server.mjs:~2380-2402: q, position, foot, ageGroup, availability, ...); unknown keys
--        are ignored, none are queried server-side. Read patterns: by org (server.mjs:2417); by id+org on delete;
--        FULL SCAN of every saved search on every player signup (checkSavedSearches, server.mjs:2405) — the
--        notify target is user_id, which is why it is kept even though the user may have been removed.
--        POST /searches does not call persist() (server.mjs:2420-2427) — rows could be lost before the next save.
-- ---------------------------------------------------------------------
CREATE TABLE saved_searches (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  scout_name   TEXT NOT NULL,                          -- snapshot
  name         TEXT NOT NULL,
  filters_json TEXT NOT NULL CHECK (json_valid(filters_json)),  -- free-form search filters by design
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX saved_searches_org_id ON saved_searches(org_id);


-- =====================================================================
-- M10 grassroots operations — open days, match days, the friendlies board
-- S13d: IMPLEMENTED, migration 0037_grassroots REGISTERED (repositories/grassroots.mjs, 6 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =====================================================================
--
-- An open day (open-*) is a grassroots club's open trial session on a calendar day. Its positions are ordered rows
-- (free text, at most 20, no repeats). Deleting an open day stamps deleted_at: it leaves every list and count, and the
-- row stays so a coverage assignment that names it (07, open_trial_id) keeps its key. The host club's name is read
-- live from orgs, not copied. A registration (otr-*) is one per (open day, player): by the player (an adult) or by a
-- guardian for a child (guardian_id set exactly then). It is answered once (outcome invite_trial | declined, with an
-- optional note, at outcome_at); the no-ghosting rule counts the unanswered registrations of past open days. The
-- player's name is a copy taken at registration and goes when the player is deleted; the player id stays (no key).
--
-- A match day (md-*) is the squad-wide log of one game: fixture, venue ('' when none), the day, an optional result
-- (at most 20 characters) and the rostered players it credited, as ordered rows (no key: a credit outlives the
-- account). Each credited player's attendance row lives with the player (01_identity).
--
-- A friendly (fr-*) is a club's post on the local board; its status was only ever 'open' and is not stored (the API
-- still answers status 'open'). Responses are one per other club (primary key (friendly_id, org_id)); the message is
-- shown only to the poster. The board is read by match date, with a latitude/longitude box on the host club's
-- location as the prefilter for the 50 km radius.
--
-- Keys: organisations and staff RESTRICT; child rows cascade with their owner (owners are never hard-deleted).
-- Player and guardian ids carry no key.

CREATE TABLE open_trials (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 160 AND length(title) > 0),
  trial_date                               TEXT NOT NULL CHECK (length(trial_date) <= 10),
  venue                                    TEXT NOT NULL CHECK (length(venue) <= 160 AND length(venue) > 0),
  age_group                                TEXT NOT NULL CHECK (length(age_group) <= 40 AND length(age_group) > 0),
  notes                                    TEXT NOT NULL CHECK (length(notes) <= 2000),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_at                               INTEGER NOT NULL,
  deleted_at                               INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (trial_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
) STRICT;
CREATE INDEX open_trials_org ON open_trials (org_id, trial_date) WHERE deleted_at IS NULL;
CREATE INDEX open_trials_date ON open_trials (trial_date) WHERE deleted_at IS NULL;
CREATE TABLE open_trial_positions (
  open_trial_id                            TEXT NOT NULL CHECK (length(open_trial_id) > 0 AND length(open_trial_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  position                                 TEXT NOT NULL CHECK (length(position) > 0 AND length(position) <= 40),
  FOREIGN KEY (open_trial_id) REFERENCES open_trials(id) ON DELETE CASCADE,
  PRIMARY KEY (open_trial_id, ord),
  UNIQUE (open_trial_id, position)
) STRICT;
CREATE TABLE open_trial_registrations (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  open_trial_id                            TEXT NOT NULL CHECK (length(open_trial_id) <= 80 AND length(open_trial_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  by_guardian                              INTEGER NOT NULL CHECK (by_guardian IN (0,1)),
  guardian_id                              TEXT CHECK (guardian_id IS NULL OR length(guardian_id) <= 80 AND length(guardian_id) > 0),
  registered_at                            INTEGER NOT NULL,
  outcome                                  TEXT CHECK (outcome IS NULL OR outcome IN ('invite_trial','declined')),
  outcome_note                             TEXT CHECK (outcome_note IS NULL OR length(outcome_note) <= 200),
  outcome_at                               INTEGER,
  FOREIGN KEY (open_trial_id) REFERENCES open_trials(id) ON DELETE CASCADE,
  UNIQUE (open_trial_id, player_id),
  CHECK ((guardian_id IS NOT NULL) = (by_guardian = 1)),
  CHECK ((outcome IS NULL) = (outcome_at IS NULL)),
  CHECK (outcome IS NOT NULL OR outcome_note IS NULL)
) STRICT;
CREATE INDEX open_trial_registrations_player ON open_trial_registrations (player_id);
CREATE INDEX open_trial_registrations_unresolved ON open_trial_registrations (open_trial_id) WHERE outcome IS NULL;
CREATE TABLE matchdays (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  fixture                                  TEXT NOT NULL CHECK (length(fixture) <= 160 AND length(fixture) > 0),
  venue                                    TEXT NOT NULL CHECK (length(venue) <= 160),
  match_date                               TEXT NOT NULL CHECK (length(match_date) <= 10),
  result                                   TEXT CHECK (result IS NULL OR length(result) <= 20 AND length(result) > 0),
  logged_by_user_id                        TEXT NOT NULL CHECK (length(logged_by_user_id) <= 80 AND length(logged_by_user_id) > 0),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (logged_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (match_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
) STRICT;
CREATE INDEX matchdays_org ON matchdays (org_id);
CREATE TABLE matchday_players (
  matchday_id                              TEXT NOT NULL CHECK (length(matchday_id) > 0 AND length(matchday_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  FOREIGN KEY (matchday_id) REFERENCES matchdays(id) ON DELETE CASCADE,
  PRIMARY KEY (matchday_id, ord),
  UNIQUE (matchday_id, player_id)
) STRICT;
CREATE TABLE friendlies (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  posted_by_user_id                        TEXT NOT NULL CHECK (length(posted_by_user_id) <= 80 AND length(posted_by_user_id) > 0),
  age_group                                TEXT NOT NULL CHECK (length(age_group) <= 40 AND length(age_group) > 0),
  match_date                               TEXT NOT NULL CHECK (length(match_date) <= 10),
  venue                                    TEXT NOT NULL CHECK (length(venue) <= 160),
  notes                                    TEXT NOT NULL CHECK (length(notes) <= 2000),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (posted_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (match_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')
) STRICT;
CREATE INDEX friendlies_date ON friendlies (match_date, id);
CREATE INDEX friendlies_org ON friendlies (org_id);
CREATE TABLE friendly_responses (
  friendly_id                              TEXT NOT NULL CHECK (length(friendly_id) <= 80 AND length(friendly_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  message                                  TEXT NOT NULL CHECK (length(message) <= 200),
  responded_by_user_id                     TEXT NOT NULL CHECK (length(responded_by_user_id) <= 80 AND length(responded_by_user_id) > 0),
  responded_at                             INTEGER NOT NULL,
  FOREIGN KEY (friendly_id) REFERENCES friendlies(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (responded_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (friendly_id, org_id)
) STRICT;
CREATE INDEX friendly_responses_org ON friendly_responses (org_id);


-- ---------------------------------------------------------------------
-- invoices
-- source: db.invoices  created at server.mjs:222 (and seed.mjs:488); rows minted at adapters.mjs:164-176 (createBilling.invoiceForSigning)
-- owner/writer: adapters.mjs billing seam, called from domains/recruitment/signings/index.mjs:275   lifecycle: status only ever 'issued'; never
--               deleted except the in-request rollback at domains/recruitment/signings/index.mjs:619 (array truncated to its pre-request length)
-- mapping: id -> id (inv-N — prefix shared with org_invites); ts -> created_at (source field is literally `ts`);
--          orgId -> org_id; orgName -> org_name; signingId -> signing_id; playerName -> player_name; description -> description;
--          amount (MAJOR units, e.g. 1500) -> amount_minor (= amount * 100); currency -> currency (always 'EUR' today);
--          status -> status; provider -> provider
-- notes: one invoice per signing enforced by code before issuing (domains/recruitment/signings/index.mjs:275 `.some(i.signingId === signing.id)`)
--        -> unique index. player_name is retained after player deletion (deletePlayerData leaves invoices alone) —
--        billing record; retention justified but flagged. Read patterns: by org newest first (server.mjs:2627);
--        admin all (4153); existence by signing_id.
-- ---------------------------------------------------------------------
CREATE TABLE invoices (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name     TEXT NOT NULL,                          -- snapshot
  signing_id   TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_name  TEXT NOT NULL,                          -- snapshot; personal data retained after deletion (billing)
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  status       TEXT NOT NULL CHECK (status IN ('issued')),
  provider     TEXT NOT NULL CHECK (provider IN ('stripe', 'dev-ledger'))
) STRICT;
CREATE UNIQUE INDEX invoices_signing_id ON invoices(signing_id);
CREATE INDEX invoices_org_id_created_at ON invoices(org_id, created_at);


-- ---------------------------------------------------------------------
-- plans  (catalogue, keyed by name)
-- source: db.plans  object keyed by plan name; seeded from catalogue.mjs PLANS (seed.mjs:444) and restored by
--         domains/platform/migrations.mjs:257 (`db.plans ??= planCatalogue()`); never written by a route
-- owner/writer: catalogue.mjs (constants) via seed/migration   lifecycle: static product configuration
-- mapping: object key -> name (PRIMARY KEY); name -> name (identical to the key); pricePerMonthGBP (major GBP) ->
--          price_per_month_minor (= value * 100) + currency 'GBP'; seats -> seats; attributionWindowMonths -> attribution_window_months;
--          antiCircumvention -> anti_circumvention
-- notes: read by name = orgs.plan (server.mjs:1112 /meta full dump; 3064, 3078 and domains/recruitment/signings/index.mjs:260 by key with
--        `?? 18` fallback). orgs.plan (01_identity) should REFERENCE plans(name) — declared there, not here.
--        An EMPTY table reproduces the M23-D2 billing bug (catalogue.mjs:24-29): the migration must insert the
--        four rows. `customised` seen in e2e/platform/storeGuarantees.mjs:84 is a test fixture, not a product field.
-- ---------------------------------------------------------------------
CREATE TABLE plans (
  name                      TEXT PRIMARY KEY CHECK (name IN ('Grassroots', 'Academy', 'Pro', 'Agency')),
  price_per_month_minor     INTEGER NOT NULL CHECK (price_per_month_minor >= 0),
  currency                  TEXT NOT NULL DEFAULT 'GBP' CHECK (length(currency) = 3),
  seats                     INTEGER NOT NULL CHECK (seats >= 1),
  attribution_window_months INTEGER NOT NULL CHECK (attribution_window_months >= 1),
  anti_circumvention        TEXT NOT NULL
) STRICT;


-- ---------------------------------------------------------------------
-- archetypes  (catalogue)
-- source: db.archetypes  seeded from catalogue.mjs ARCHETYPES (seed.mjs:435) and restored by domains/platform/migrations.mjs:258; never written by a route
-- owner/writer: catalogue.mjs via seed/migration   lifecycle: static; exactly 5 rows
-- mapping: id -> id (arch-*); label -> label; position -> position; foot -> foot; dob -> dob (synthetic yardstick date);
--          heightCm -> height_cm; weightKg -> weight_kg; stats.appearances -> stat_appearances; stats.goals -> stat_goals;
--          stats.assists -> stat_assists
-- notes: not people — never counted or ranked as a person (catalogue.mjs:76-78). Read: full scan for the
--        similarity lead (server.mjs:1965). Shape mirrors the player fields similarityScore reads.
-- ---------------------------------------------------------------------
CREATE TABLE archetypes (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  position         TEXT NOT NULL,
  foot             TEXT NOT NULL CHECK (foot IN ('left', 'right')),
  dob              TEXT NOT NULL CHECK (length(dob) = 10),
  height_cm        INTEGER NOT NULL,
  weight_kg        INTEGER NOT NULL,
  stat_appearances INTEGER NOT NULL,
  stat_goals       INTEGER NOT NULL,
  stat_assists     INTEGER NOT NULL
) STRICT;


-- ---------------------------------------------------------------------
-- reputation_seed  -- DEMO ONLY
-- source: db.reputationSeed  seeded at seed.mjs:438-442; domains/platform/migrations.mjs:254 restores it as [] (empty is the
--         correct production value, storeContract.mjs:155); never written by a route
-- owner/writer: seed.mjs   lifecycle: static demo rows; EMPTY in production
-- mapping: scoutName -> scout_name; orgName -> org_name; discoveries -> discoveries; successRatePct -> success_rate_pct;
--          avgResaleMultiple -> avg_resale_multiple; seeded -> derived, not stored: always true for these rows —
--          the /reputation response (server.mjs:3102) returns them under `seeded` and computes live rows from the ledger with seeded:false
-- notes: no id in source; natural PK (scout_name, org_name) matches the live-row key `${scoutName}|${orgName}`.
--        Table exists only so demo snapshots migrate; a production migration inserts nothing.
-- ---------------------------------------------------------------------
CREATE TABLE reputation_seed (
  scout_name          TEXT NOT NULL,                   -- demo data; personal-looking names of fictional scouts
  org_name            TEXT NOT NULL,
  discoveries         INTEGER NOT NULL,
  success_rate_pct    INTEGER NOT NULL,
  avg_resale_multiple REAL NOT NULL,
  PRIMARY KEY (scout_name, org_name)
) STRICT;


-- ---------------------------------------------------------------------
-- delivery_callbacks_seen
-- source: db.deliveryCallbacksSeen  string[] created at m13/shared.mjs:28; appended at m13/delivery.mjs:185;
--         FIFO-capped at 5000 (oldest 1000 spliced, delivery.mjs:186)
-- owner/writer: m13/delivery.mjs /callbacks/delivery   lifecycle: idempotency ledger of processed provider callback ids
-- mapping: each string -> callback_id (PRIMARY KEY); seen_at -> NEW column (the array had only insertion order;
--          the migration assigns migration_time + array_index so the FIFO prune can keep working on seen_at)
-- notes: read pattern is membership test by id (delivery.mjs:184) — the PK. The cap becomes
--        `DELETE ... ORDER BY seen_at LIMIT 1000` when COUNT > 5000.
-- ---------------------------------------------------------------------
CREATE TABLE delivery_callbacks_seen (
  callback_id TEXT PRIMARY KEY,
  seen_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX delivery_callbacks_seen_seen_at ON delivery_callbacks_seen(seen_at);


-- ---------------------------------------------------------------------
-- ops_settings  (key/value singletons)
-- source: db.deliveryFailInject (object {email, push, contact?, trial?, decision?} of pending injected failures,
--         m13/delivery.mjs:20, incremented at 250, decremented at 29 and domains/recruitment/lifecycle/{trialRoutes:391,628,830;
--         contactRoutes:461; decisionRoutes:360}) and db.deliveryCentreSince (number, m13/delivery.mjs:21, read at 82)
-- owner/writer: m13/delivery.mjs (+ m23 route files decrement)   lifecycle: persistent singletons; never deleted
-- mapping: deliveryCentreSince -> row key 'delivery_centre_since', value_json = epoch-ms integer;
--          deliveryFailInject.<channel> -> row key 'delivery_fail_inject.<channel>' for channel in
--          email | push | contact | trial | decision, value_json = non-negative integer
-- notes: DECISION — a table, not "not a table": both values are persisted on purpose and read after restart.
--        delivery_centre_since is the high-water mark that stops a retroactive email blast to every historical
--        notification when the delivery centre is first enabled (delivery.mjs:21,82-84) — losing it on restart
--        would re-send history. The fail-inject counters are decremented across separate requests and persisted
--        with persistNow() each time (delivery.mjs:251; trialRoutes.mjs:392) so a restart mid-test keeps the
--        remaining count. Neither is a collection, so one key/value table holds both; JSON value keeps the
--        column typeless for future singletons. updated_at is NEW (audit of admin injections).
-- ---------------------------------------------------------------------
CREATE TABLE ops_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------------
-- media_deletions — LIVE since migration 0006 (S4a, repositories/migrations/0006_media_deletions.mjs;
--   repositories/mediaDeletions.mjs). The crash-safe queue of media FILES to remove after a player deletion
--   commits: deletePlayerData (server.mjs) queues one row per media id INSIDE the deletion's unit of work, the
--   server processes the queue after COMMIT, at boot and every sweep; a row goes only once the file was deleted
--   or was already absent (a failed attempt keeps the row with attempts/last_error). While a row exists the media
--   id is never served. No foreign key: the player row is gone by the time the queue is read. The S4a rollback
--   tool refuses a copy whose queue is not empty and drops the table (with this record) when it is.
-- ---------------------------------------------------------------------
CREATE TABLE media_deletions (
  media_id        TEXT PRIMARY KEY,
  player_id       TEXT,
  queued_at       INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error      TEXT
) STRICT;
CREATE INDEX media_deletions_queued ON media_deletions (queued_at);


-- =====================================================================
-- not tables:
--   db.secrets.mediaSign — RETIRED (3 Nov 2026), no table. The signing key is process.env.MEDIA_SECRET only
--     (required in production); development uses a random per-process key. Signed media URLs (15-minute TTL)
--     stop verifying after a restart without MEDIA_SECRET, which clients tolerate (links are re-minted on every
--     SSE tick).
--   CONNECTORS registry (domains/integrations/imports.mjs:432-436) — code registry, status derived from env keys.
--   API_SCOPES, WEBHOOK_EVENTS, RETRY_MS ladders, MAX_ATTEMPTS, EXPORT_CONTRACT_VERSION (imports.mjs) — code constants
--     (the enum values appear as CHECKs above).
--   metrics counters, exposureHook, mfaAttempts map, IDP_SECRET, signToken/verifyToken (domains/enterprise/enterprise.mjs) — in-memory / env.
--   PROVIDER 'local-fake', CALLBACK_SECRET (m13/delivery.mjs:25-26) — code constant / env DELIVERY_CALLBACK_SECRET.
--   Upload chunk files under DATA_DIR/upload-tmp/<id>/ (m12/operations.mjs:153-158) — filesystem, swept with the session.
--   Backups directory + manifest.json (domains/enterprise/enterprise.mjs:428-484) — filesystem artefacts, listed from disk.
--   Derived at read time, never stored: grant liveness (revoked_at/expires_at), support-grant expiry, upload
--     `complete` flag, import rowCount, group `members`/`youAdmin` views, friendlies `mine`/`distanceKm`,
--     open-trial `registered`, pathway record, invoice existence check, reputation live rows (from ledger),
--     onboarding task completion (enterprise.mjs:127-144).
-- =====================================================================
