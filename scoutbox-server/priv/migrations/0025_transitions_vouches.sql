-- 0025_transitions_vouches: Transition cases (pack items, grants, history) and coach references become typed tables

CREATE TABLE transition_cases (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  started_by_kind                          TEXT NOT NULL CHECK (started_by_kind IN ('player','guardian')),
  started_by_id                            TEXT NOT NULL CHECK (length(started_by_id) <= 80 AND length(started_by_id) > 0),
  started_by_name                          TEXT CHECK (started_by_name IS NULL OR length(started_by_name) <= 200),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 500),
  period_ends_at                           INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('open','withdrawn','placed','expired')),
  placement_org_id                         TEXT CHECK (placement_org_id IS NULL OR length(placement_org_id) <= 80 AND length(placement_org_id) > 0),
  placement_org_name                       TEXT CHECK (placement_org_name IS NULL OR length(placement_org_name) <= 200),
  placement_at                             INTEGER,
  placement_note                           TEXT CHECK (placement_note IS NULL OR length(placement_note) <= 300),
  follow_up_due_at                         INTEGER,
  follow_up_notified_at                    INTEGER,
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (placement_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((status = 'placed') = (placement_org_id IS NOT NULL)),
  CHECK (follow_up_due_at IS NULL OR placement_org_id IS NOT NULL),
  CHECK (placement_org_id IS NULL OR placement_at IS NOT NULL),
  CHECK (placement_org_id IS NOT NULL OR (placement_org_name IS NULL AND placement_at IS NULL AND placement_note IS NULL)),
  CHECK (follow_up_due_at IS NOT NULL OR follow_up_notified_at IS NULL)
) STRICT;
CREATE INDEX transition_cases_player ON transition_cases (player_id);
CREATE INDEX transition_cases_status_period ON transition_cases (status, period_ends_at);
CREATE INDEX transition_cases_follow_up ON transition_cases (follow_up_due_at) WHERE follow_up_due_at IS NOT NULL AND follow_up_notified_at IS NULL;
CREATE TABLE transition_case_pack_items (
  transition_case_id TEXT NOT NULL REFERENCES transition_cases(id) ON DELETE CASCADE,
  item_kind         TEXT NOT NULL CHECK (item_kind IN ('media','evidence','feedback')),
  ord                INTEGER NOT NULL CHECK (ord >= 0 AND ord < 100),
  item_id            TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  PRIMARY KEY (transition_case_id, item_kind, item_id),
  UNIQUE (transition_case_id, item_kind, ord)
) STRICT;
CREATE TABLE transition_case_recipients (
  transition_case_id                       TEXT NOT NULL CHECK (length(transition_case_id) <= 80 AND length(transition_case_id) > 0),
  ord                                      INTEGER NOT NULL,
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  granted_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  viewed_at                                INTEGER,
  FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (transition_case_id, ord),
  CHECK (ord >= 0),
  CHECK (expires_at >= granted_at)
) STRICT;
CREATE INDEX transition_case_recipients_org ON transition_case_recipients (org_id, revoked_at, expires_at);
CREATE TABLE transition_case_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  transition_case_id                       TEXT NOT NULL CHECK (length(transition_case_id) <= 80 AND length(transition_case_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian','system')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('opened','recipient_added','recipient_revoked','withdrawn','placed','expired')),
  detail_items                             INTEGER,
  detail_org_id                            TEXT CHECK (detail_org_id IS NULL OR length(detail_org_id) <= 80 AND length(detail_org_id) > 0),
  FOREIGN KEY (transition_case_id) REFERENCES transition_cases(id) ON DELETE CASCADE,
  CHECK (detail_items IS NULL OR detail_items > 0),
  CHECK ((action = 'opened') = (detail_items IS NOT NULL)),
  CHECK ((action IN ('recipient_added','recipient_revoked','placed')) = (detail_org_id IS NOT NULL))
) STRICT;
CREATE INDEX transition_case_history_case ON transition_case_history (transition_case_id);
CREATE TABLE vouches (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  coach_name                               TEXT NOT NULL CHECK (length(coach_name) <= 100 AND length(coach_name) > 0),
  coach_email                              TEXT CHECK (coach_email IS NULL OR length(coach_email) <= 254),
  role                                     TEXT NOT NULL CHECK (length(role) <= 200 AND length(role) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('pending','published','revoked')),
  code_hash                                TEXT CHECK (code_hash IS NULL OR length(code_hash) <= 64),
  text                                     TEXT CHECK (text IS NULL OR length(text) <= 400),
  seasons                                  TEXT CHECK (seasons IS NULL OR length(seasons) <= 40),
  created_at                               INTEGER NOT NULL,
  published_at                             INTEGER,
  conflict_of_interest                     TEXT CHECK (conflict_of_interest IS NULL OR length(conflict_of_interest) <= 200),
  withdrawn_at                             INTEGER,
  withdrawn_by                             TEXT CHECK (withdrawn_by IS NULL OR withdrawn_by IN ('admin')),
  withdrawn_reason                         TEXT CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 200 AND length(withdrawn_reason) > 0),
  CHECK (length(code_hash) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'),
  CHECK ((status = 'pending') = (code_hash IS NOT NULL)),
  CHECK (status <> 'published' OR (text IS NOT NULL AND published_at IS NOT NULL)),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL))
) STRICT;
CREATE INDEX vouches_player_status ON vouches (player_id, status);
CREATE UNIQUE INDEX vouches_code_hash ON vouches (code_hash) WHERE code_hash IS NOT NULL;
