-- 0024_passport: Passport preferences, career entries, achievements, share links and correction requests become typed tables

CREATE TABLE passport_prefs (
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  bio                                      TEXT CHECK (bio IS NULL OR length(bio) <= 400),
  position_primary                         TEXT CHECK (position_primary IS NULL OR position_primary IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  availability                             TEXT CHECK (availability IS NULL OR availability IN ('open_to_trials','open_to_contact','not_looking')),
  available_from                           TEXT CHECK (available_from IS NULL OR (available_from GLOB '[0-9][0-9][0-9][0-9]' OR available_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR available_from GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  updated_at                               INTEGER NOT NULL,
  PRIMARY KEY (player_id)
) STRICT;
CREATE TABLE passport_pref_positions (
  player_id  TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  code    TEXT NOT NULL CHECK (code IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF') AND ord < 3),
  PRIMARY KEY (player_id, ord),
  UNIQUE (player_id, code)
) STRICT;
CREATE TABLE passport_position_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  from_date                                TEXT NOT NULL CHECK ((from_date GLOB '[0-9][0-9][0-9][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  position_primary                         TEXT NOT NULL CHECK (position_primary IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  recorded_at                              INTEGER NOT NULL,
  FOREIGN KEY (player_id) REFERENCES passport_prefs(player_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX passport_position_history_player ON passport_position_history (player_id);
CREATE TABLE passport_position_history_positions (
  history_id  TEXT NOT NULL REFERENCES passport_position_history(id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  code    TEXT NOT NULL CHECK (code IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF') AND ord < 3),
  PRIMARY KEY (history_id, ord),
  UNIQUE (history_id, code)
) STRICT;
CREATE TABLE passport_public_selections (
  player_id  TEXT NOT NULL REFERENCES passport_prefs(player_id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  selection    TEXT NOT NULL CHECK (length(selection) > 0 AND length(selection) <= 120 AND ord < 100),
  PRIMARY KEY (player_id, ord),
  UNIQUE (player_id, selection)
) STRICT;
CREATE TABLE passport_career_entries (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  org_name                                 TEXT NOT NULL CHECK (length(org_name) <= 100 AND length(org_name) > 0),
  role                                     TEXT CHECK (role IS NULL OR length(role) <= 60),
  from_date                                TEXT NOT NULL CHECK ((from_date GLOB '[0-9][0-9][0-9][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  to_date                                  TEXT CHECK (to_date IS NULL OR (to_date GLOB '[0-9][0-9][0-9][0-9]' OR to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR to_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 200),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  created_at                               INTEGER NOT NULL,
  withdrawn_at                             INTEGER
) STRICT;
CREATE INDEX passport_career_entries_player ON passport_career_entries (player_id);
CREATE TABLE passport_achievements (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 100),
  when_date                                TEXT CHECK (when_date IS NULL OR (when_date GLOB '[0-9][0-9][0-9][0-9]' OR when_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]' OR when_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  submitted_by                             TEXT NOT NULL CHECK (submitted_by IN ('player','guardian')),
  confirmation_provenance                  TEXT CHECK (confirmation_provenance IS NULL OR confirmation_provenance IN ('verified_club_confirmed')),
  confirmation_org_id                      TEXT CHECK (confirmation_org_id IS NULL OR length(confirmation_org_id) <= 80 AND length(confirmation_org_id) > 0),
  confirmation_org_name                    TEXT CHECK (confirmation_org_name IS NULL OR length(confirmation_org_name) <= 200),
  confirmation_by_name                     TEXT CHECK (confirmation_by_name IS NULL OR length(confirmation_by_name) <= 200),
  confirmation_at                          INTEGER,
  created_at                               INTEGER NOT NULL,
  withdrawn_at                             INTEGER,
  FOREIGN KEY (confirmation_org_id) REFERENCES orgs(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX passport_achievements_player ON passport_achievements (player_id);
CREATE TABLE passport_shares (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  mode                                     TEXT NOT NULL CHECK (mode IN ('public','recruitment')),
  token_hash                               TEXT NOT NULL CHECK (length(token_hash) <= 64 AND length(token_hash) > 0),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  revoked_at                               INTEGER,
  revoked_by_kind                          TEXT CHECK (revoked_by_kind IS NULL OR revoked_by_kind IN ('player','guardian','trust_safety')),
  revoked_by_id                            TEXT CHECK (revoked_by_id IS NULL OR length(revoked_by_id) <= 80 AND length(revoked_by_id) > 0),
  views                                    INTEGER NOT NULL DEFAULT 0,
  CHECK (length(token_hash) = 64),
  CHECK (views >= 0),
  CHECK ((revoked_at IS NULL) = (revoked_by_kind IS NULL))
) STRICT;
CREATE UNIQUE INDEX passport_shares_token_hash ON passport_shares (token_hash);
CREATE INDEX passport_shares_player ON passport_shares (player_id);
CREATE TABLE passport_corrections (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  target_kind                              TEXT NOT NULL CHECK (target_kind IN ('timeline_event','career_entry','club_history','reference','trial','assessment','achievement','signing')),
  target_id                                TEXT CHECK (target_id IS NULL OR length(target_id) <= 80),
  reason                                   TEXT NOT NULL CHECK (length(reason) <= 500 AND length(reason) > 0),
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  status                                   TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome                       TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('corrected','rejected','referred')),
  resolution_reason                        TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) <= 400 AND length(resolution_reason) > 0),
  resolved_at                              INTEGER,
  created_at                               INTEGER NOT NULL,
  CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL))
) STRICT;
CREATE INDEX passport_corrections_status ON passport_corrections (status);
CREATE INDEX passport_corrections_player ON passport_corrections (player_id);
