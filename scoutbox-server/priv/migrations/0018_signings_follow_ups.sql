-- 0018_signings_follow_ups: signing packages (revisions, documents, parties, history), completed signings (parties), post-signing follow-ups and outcome reports (confirmations) become typed tables; idempotency_keys created for signing_packages

-- foreign_keys: off

CREATE TABLE signing_packages (
  id                               TEXT PRIMARY KEY,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id                          TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  offer_id                         TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT NOT NULL,
  transaction_id                   TEXT,
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED')),
  current_revision_id              TEXT NOT NULL,
  expires_at                       INTEGER,
  internal_note                    TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  completion_signing_id            TEXT REFERENCES signings(id) DEFERRABLE INITIALLY DEFERRED,
  completion_completed_at          INTEGER,
  completion_by_kind               TEXT CHECK (completion_by_kind IS NULL OR completion_by_kind IN ('org','player','guardian','admin','system')),
  completion_by_user_id            TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completion_by_name               TEXT,
  completion_by_role               TEXT,
  completion_contract_start_date   TEXT CHECK (completion_contract_start_date IS NULL OR length(completion_contract_start_date) = 10),
  completion_contract_end_date     TEXT CHECK (completion_contract_end_date IS NULL OR length(completion_contract_end_date) = 10),
  completion_document_sha256       TEXT CHECK (completion_document_sha256 IS NULL OR length(completion_document_sha256) = 64),
  completion_lifecycle_from        TEXT,
  completion_lifecycle_to          TEXT,
  completion_lifecycle_at          INTEGER,
  cancelled_at                     INTEGER,
  cancelled_by_kind                TEXT CHECK (cancelled_by_kind IS NULL OR cancelled_by_kind IN ('org','player','guardian','admin','system')),
  cancelled_by_user_id             TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  cancelled_by_name                TEXT,
  cancelled_by_role                TEXT,
  cancel_reason                    TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  voided_at                        INTEGER,
  voided_by_kind                   TEXT CHECK (voided_by_kind IS NULL OR voided_by_kind IN ('org','player','guardian','admin','system')),
  voided_by_id                     TEXT,
  voided_by_name                   TEXT,
  voided_by_role                   TEXT,
  void_reason                      TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  created_at                       INTEGER NOT NULL,
  created_by_kind                  TEXT CHECK (created_by_kind IS NULL OR created_by_kind IN ('org','player','guardian','admin','system')),
  created_by_user_id               TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name                  TEXT,
  created_by_role                  TEXT,
  updated_at                       INTEGER NOT NULL,
  rev                              INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  rev_at                           INTEGER,
  rev_by_user_id                   TEXT,
  rev_by_name                      TEXT,
  policy_version                   INTEGER NOT NULL DEFAULT 1,
  subject_removed_at               INTEGER,
  CHECK ((status = 'COMPLETED') = (completion_signing_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by_kind IS NULL))
) STRICT;
CREATE INDEX signing_packages_case_org_created ON signing_packages (case_id, org_id, created_at);
CREATE INDEX signing_packages_offer_org ON signing_packages (offer_id, org_id);
CREATE INDEX signing_packages_player_updated ON signing_packages (player_id, updated_at);
CREATE INDEX signing_packages_offer_revision ON signing_packages (offer_revision_id);
CREATE INDEX signing_packages_org_player ON signing_packages (org_id, player_id);
CREATE UNIQUE INDEX signing_packages_one_completed_per_offer ON signing_packages (offer_id) WHERE status = 'COMPLETED';
CREATE TABLE signing_revisions (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  revision_number                  INTEGER NOT NULL CHECK (revision_number >= 1),
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED','SUPERSEDED')),
  created_at                       INTEGER NOT NULL,
  created_by_kind                  TEXT CHECK (created_by_kind IS NULL OR created_by_kind IN ('org','player','guardian','admin','system')),
  created_by_user_id               TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name                  TEXT,
  created_by_role                  TEXT,
  ready_at                         INTEGER,
  ready_by_kind                    TEXT CHECK (ready_by_kind IS NULL OR ready_by_kind IN ('org','player','guardian','admin','system')),
  ready_by_user_id                 TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  ready_by_name                    TEXT,
  ready_by_role                    TEXT,
  completed_at                     INTEGER,
  completed_by_kind                TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('org','player','guardian','admin','system')),
  completed_by_user_id             TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completed_by_name                TEXT,
  completed_by_role                TEXT,
  superseded_at                    INTEGER,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  policy_jurisdiction              TEXT,
  policy_offer_policy_version      INTEGER,
  supersedes_revision_id           TEXT,
  superseded_by_revision_id        TEXT,
  UNIQUE (package_id, revision_number),
  UNIQUE (package_id, position)
) STRICT;
CREATE TABLE signing_documents (
  id                               TEXT PRIMARY KEY,
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  kind                             TEXT NOT NULL CHECK (kind IN ('signing','executed')),
  evidence_id                      TEXT NOT NULL,
  sha256                           TEXT NOT NULL CHECK (length(sha256) = 64),
  filename                         TEXT,
  mime                             TEXT,
  bytes                            INTEGER,
  label                            TEXT CHECK (label IS NULL OR length(label) <= 120),
  uploaded_at                      INTEGER NOT NULL,
  uploaded_by_kind                 TEXT CHECK (uploaded_by_kind IS NULL OR uploaded_by_kind IN ('org','player','guardian','admin','system')),
  uploaded_by_user_id              TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  uploaded_by_name                 TEXT,
  uploaded_by_role                 TEXT,
  UNIQUE (revision_id, kind)
) STRICT;
CREATE TABLE signing_revision_parties (
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  for_entity_id                    TEXT,
  for_player_id                    TEXT,
  status                           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  completed_at                     INTEGER,
  completed_by_kind                TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('org','player','guardian','admin','system')),
  completed_by_id                  TEXT,
  completed_by_name                TEXT,
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  evidence_ref_kind                TEXT CHECK (evidence_ref_kind IS NULL OR evidence_ref_kind IN ('platform_acknowledgment')),
  evidence_ref_id                  TEXT,
  evidence_revision_id             TEXT,
  evidence_document_sha256         TEXT CHECK (evidence_document_sha256 IS NULL OR length(evidence_document_sha256) = 64),
  evidence_at                      INTEGER,
  evidence_actor_kind              TEXT,
  evidence_actor_id                TEXT,
  evidence_session                 TEXT,
  PRIMARY KEY (revision_id, party_type),
  UNIQUE (revision_id, position),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX signing_revision_parties_entity ON signing_revision_parties (party_type, for_entity_id);
CREATE TABLE signing_history (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE RESTRICT,
  position                         INTEGER NOT NULL,
  at                               INTEGER NOT NULL,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  by_id                            TEXT,
  by_name                          TEXT,
  action                           TEXT NOT NULL,
  detail_json                      TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  UNIQUE (package_id, position)
) STRICT;
CREATE INDEX signing_history_package_at ON signing_history (package_id, at);
CREATE TABLE signings (
  id                               TEXT PRIMARY KEY,
  player_id                        TEXT NOT NULL,
  player_name                      TEXT,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                         TEXT,
  user_id                          TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                       TEXT,
  ts                               INTEGER NOT NULL,
  signed_at                        INTEGER,
  first_qualifying_ledger_id       TEXT,
  first_qualifying_at              INTEGER,
  first_qualifying_type            TEXT,
  attribution_window_months        INTEGER,
  inside_attribution_window        INTEGER NOT NULL DEFAULT 0 CHECK (inside_attribution_window IN (0,1)),
  method                           TEXT NOT NULL DEFAULT 'LEGACY_RECORDED' CHECK (method IN ('CANONICAL_COMPLETION','LEGACY_RECORDED')),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 400),
  signing_package_id               TEXT REFERENCES signing_packages(id) ON DELETE RESTRICT,
  signing_revision_id              TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  signing_revision_number          INTEGER,
  case_id                          TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  offer_id                         TEXT REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT,
  transaction_id                   TEXT,
  document_sha256                  TEXT CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
  document_evidence_id             TEXT,
  executed_document_evidence_id    TEXT,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  CHECK ((method = 'CANONICAL_COMPLETION') = (signing_package_id IS NOT NULL))
) STRICT;
CREATE INDEX signings_org_ts ON signings (org_id, ts);
CREATE INDEX signings_player ON signings (player_id);
CREATE INDEX signings_org_player ON signings (org_id, player_id);
CREATE UNIQUE INDEX signings_one_per_package ON signings (signing_package_id) WHERE signing_package_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_per_offer ON signings (offer_id) WHERE offer_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_legacy_per_org_player ON signings (org_id, player_id) WHERE signing_package_id IS NULL;
CREATE TABLE signing_parties (
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  completed_at                     INTEGER,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  PRIMARY KEY (signing_id, party_type),
  UNIQUE (signing_id, position)
) STRICT;
CREATE TABLE follow_ups (
  id                               TEXT PRIMARY KEY,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  milestone                        TEXT NOT NULL CHECK (milestone IN ('3m','6m','12m')),
  due_at                           INTEGER NOT NULL,
  status                           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','due','complete')),
  notified_at                      INTEGER,
  created_at                       INTEGER NOT NULL,
  UNIQUE (signing_id, milestone)
) STRICT;
CREATE INDEX follow_ups_org_due ON follow_ups (org_id, due_at);
CREATE INDEX follow_ups_player ON follow_ups (player_id);
CREATE INDEX follow_ups_status_due ON follow_ups (status, due_at);
CREATE TABLE outcome_reports (
  id                               TEXT PRIMARY KEY,
  follow_up_id                     TEXT NOT NULL UNIQUE REFERENCES follow_ups(id) ON DELETE RESTRICT,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id                       TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name                          TEXT,
  registration_status              TEXT NOT NULL CHECK (registration_status IN ('registered','released','left','unknown')),
  matches_played                   INTEGER CHECK (matches_played IS NULL OR matches_played >= 0),
  progression                      TEXT CHECK (progression IS NULL OR length(progression) <= 200),
  end_reason                       TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  status                           TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','confirmed','disputed')),
  at                               INTEGER NOT NULL
) STRICT;
CREATE INDEX outcome_reports_org ON outcome_reports (org_id);
CREATE INDEX outcome_reports_player ON outcome_reports (player_id);
CREATE TABLE outcome_report_confirmations (
  report_id                        TEXT NOT NULL REFERENCES outcome_reports(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                            TEXT NOT NULL,
  by_name                          TEXT,
  agree                            INTEGER NOT NULL CHECK (agree IN (0,1)),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  experience_rating                INTEGER CHECK (experience_rating IS NULL OR experience_rating BETWEEN 1 AND 5),
  at                               INTEGER NOT NULL,
  PRIMARY KEY (report_id, by_id),
  UNIQUE (report_id, position)
) STRICT;

CREATE TABLE idempotency_keys (
  owner_table                      TEXT NOT NULL CHECK (owner_table IN ('signing_packages')),
  owner_id                         TEXT NOT NULL,
  position                         INTEGER NOT NULL,
  act                              TEXT NOT NULL,
  shape                            TEXT NOT NULL CHECK (shape IN ('list', 'value')),
  key                              TEXT,
  fp                               TEXT,
  at                               INTEGER,
  entry_json                       TEXT NOT NULL CHECK (entry_json IS NULL OR json_valid(entry_json)),
  PRIMARY KEY (owner_table, owner_id, position)
) STRICT;

CREATE INDEX idempotency_keys_owner_act_key ON idempotency_keys (owner_table, owner_id, act, key);
