-- 0034_integrations: Import batches, prospects, identity reviews, API keys, webhook endpoints and webhook deliveries become typed tables

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
