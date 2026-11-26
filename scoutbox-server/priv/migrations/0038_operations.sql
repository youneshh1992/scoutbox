-- 0038_operations: Upload sessions, saved searches, invoices, the demo reputation seed and the delivery centre's bookkeeping become typed tables

CREATE TABLE upload_sessions (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  size_bytes                               INTEGER NOT NULL,
  mime                                     TEXT NOT NULL CHECK (mime IN ('video/webm','video/mp4','video/quicktime','image/jpeg','image/png','image/webp')),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  declared_sha256                          TEXT CHECK (declared_sha256 IS NULL OR length(declared_sha256) <= 64),
  chunk_size                               INTEGER NOT NULL,
  total_chunks                             INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('open','finalised','aborted','abandoned')),
  created_at                               INTEGER NOT NULL,
  finalised_media_id                       TEXT CHECK (finalised_media_id IS NULL OR length(finalised_media_id) <= 80 AND length(finalised_media_id) > 0),
  CHECK (size_bytes > 0 AND size_bytes <= 41943040),
  CHECK (chunk_size > 0),
  CHECK (total_chunks >= 1 AND total_chunks <= 1024),
  CHECK (declared_sha256 IS NULL OR length(declared_sha256) = 64),
  CHECK ((status = 'finalised') = (finalised_media_id IS NOT NULL))
) STRICT;
CREATE INDEX upload_sessions_player ON upload_sessions (player_id);
CREATE INDEX upload_sessions_open ON upload_sessions (created_at) WHERE status = 'open';
CREATE TABLE upload_session_chunks (
  upload_session_id TEXT NOT NULL CHECK (length(upload_session_id) > 0 AND length(upload_session_id) <= 80),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (upload_session_id, chunk_index)
) STRICT;

CREATE TABLE saved_searches (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) <= 80 AND length(user_id) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 120 AND length(name) > 0),
  q                                        TEXT CHECK (q IS NULL OR length(q) <= 120 AND length(q) > 0),
  position                                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  foot                                     TEXT CHECK (foot IS NULL OR foot IN ('left','right')),
  availability                             TEXT CHECK (availability IS NULL OR availability IN ('available_now','end_of_season','loan_open','overseas_open','not_seeking')),
  country                                  TEXT CHECK (country IS NULL OR length(country) <= 60 AND length(country) > 0),
  academy_plus                             INTEGER CHECK (academy_plus IS NULL OR academy_plus IN (0,1)),
  age_group                                TEXT CHECK (age_group IS NULL OR age_group IN ('u16','u18','18-21','senior')),
  new_days                                 INTEGER,
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (new_days IS NULL OR (new_days >= 1 AND new_days <= 3650)),
  CHECK (academy_plus IS NULL OR academy_plus = 1)
) STRICT;
CREATE INDEX saved_searches_org ON saved_searches (org_id);

CREATE TABLE invoices (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  created_at                               INTEGER NOT NULL,
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT NOT NULL CHECK (length(org_name) <= 200),
  signing_id                               TEXT NOT NULL CHECK (length(signing_id) <= 80 AND length(signing_id) > 0),
  player_name                              TEXT NOT NULL CHECK (length(player_name) <= 200),
  description                              TEXT NOT NULL CHECK (length(description) <= 300),
  amount_minor                             INTEGER NOT NULL,
  currency                                 TEXT NOT NULL CHECK (length(currency) <= 3),
  status                                   TEXT NOT NULL CHECK (status IN ('issued')),
  provider                                 TEXT NOT NULL CHECK (provider IN ('dev-ledger','stripe')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (signing_id) REFERENCES signings(id) ON DELETE RESTRICT,
  CHECK (amount_minor >= 0),
  CHECK (currency GLOB '[A-Z][A-Z][A-Z]')
) STRICT;
CREATE UNIQUE INDEX invoices_signing ON invoices (signing_id);
CREATE INDEX invoices_org ON invoices (org_id);

CREATE TABLE reputation_seed (
  scout_name                               TEXT NOT NULL CHECK (length(scout_name) <= 200 AND length(scout_name) > 0),
  org_name                                 TEXT NOT NULL CHECK (length(org_name) <= 200 AND length(org_name) > 0),
  discoveries                              INTEGER NOT NULL,
  success_rate_pct                         INTEGER NOT NULL,
  avg_resale_multiple                      REAL NOT NULL,
  PRIMARY KEY (scout_name, org_name),
  CHECK (discoveries >= 0),
  CHECK (success_rate_pct BETWEEN 0 AND 100),
  CHECK (avg_resale_multiple >= 0)
) STRICT;

CREATE TABLE delivery_callbacks_seen (
  callback_id TEXT PRIMARY KEY CHECK (length(callback_id) > 0 AND length(callback_id) <= 200),
  seen_at INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_centre (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  since INTEGER NOT NULL
) STRICT;
CREATE TABLE delivery_fail_injections (
  channel TEXT PRIMARY KEY CHECK (channel IN ('email','push','contact','trial','decision')),
  remaining INTEGER NOT NULL CHECK (remaining >= 0)
) STRICT;

INSERT INTO delivery_centre (id, since) VALUES (1, (__NOW__ + 0));

INSERT INTO delivery_fail_injections (channel, remaining) VALUES ('email', 0);

INSERT INTO delivery_fail_injections (channel, remaining) VALUES ('push', 0);

INSERT INTO delivery_fail_injections (channel, remaining) VALUES ('contact', 0);

INSERT INTO delivery_fail_injections (channel, remaining) VALUES ('trial', 0);

INSERT INTO delivery_fail_injections (channel, remaining) VALUES ('decision', 0);
