-- 0007_player_subrecords: player sub-records (media, attendance, timeline, badges, drills, drill results, activity, external ids, season history, medical records, programme completions) become their own tables; trialReports is served from the trials

CREATE TABLE player_season_history (
  player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL,
  season              TEXT NOT NULL,
  appearances         REAL,
  goals               REAL,
  assists             REAL,
  pace_kmh            REAL,
  pass_completion_pct REAL,
  duel_success_pct    REAL,
  clean_sheets        REAL,
  PRIMARY KEY (player_id, season)
) STRICT;
CREATE UNIQUE INDEX player_season_history_position ON player_season_history (player_id, position);

CREATE TABLE player_badges (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  badge     TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_drills (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  drill_id  TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;
CREATE UNIQUE INDEX player_drills_drill ON player_drills (player_id, drill_id);

CREATE TABLE player_attendance (
  id               TEXT PRIMARY KEY,
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  fixture          TEXT NOT NULL,
  venue            TEXT,
  match_date       TEXT NOT NULL,
  lat              REAL,
  lng              REAL,
  device_confirmed INTEGER CHECK (device_confirmed IS NULL OR device_confirmed IN (0,1)),
  verified         INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  corroborated_by  TEXT,
  trial_id         TEXT,
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE UNIQUE INDEX player_attendance_player ON player_attendance (player_id, position);
CREATE INDEX player_attendance_fixture ON player_attendance (match_date DESC, fixture);

CREATE TABLE player_timeline (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  year      TEXT NOT NULL,
  event     TEXT NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_media (
  id                          TEXT PRIMARY KEY,
  player_id                   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position                    INTEGER NOT NULL,
  title                       TEXT NOT NULL,
  kind                        TEXT,
  uploaded_at                 TEXT CHECK (uploaded_at IS NULL OR (length(uploaded_at) = 24 AND uploaded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')),
  url                         TEXT,
  views                       INTEGER NOT NULL DEFAULT 0,
  verified_clip_attendance_id TEXT,
  captions                    TEXT,
  size_bytes                  INTEGER,
  captured_by                 TEXT CHECK (captured_by IS NULL OR captured_by IN ('box_cam')),
  box_session_id              TEXT
) STRICT;
CREATE UNIQUE INDEX player_media_player ON player_media (player_id, position);
CREATE INDEX player_media_uploaded ON player_media (uploaded_at) WHERE uploaded_at IS NOT NULL;
CREATE INDEX player_media_deck ON player_media ((verified_clip_attendance_id IS NOT NULL) DESC, views DESC, player_id, position) WHERE url IS NOT NULL;

CREATE TABLE player_media_tags (
  media_id TEXT NOT NULL REFERENCES player_media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tag      TEXT NOT NULL,
  count    INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (media_id, tag)
) STRICT;
CREATE UNIQUE INDEX player_media_tags_position ON player_media_tags (media_id, position);

CREATE TABLE player_medical_records (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  record_date  TEXT CHECK (record_date IS NULL OR length(record_date) = 10),
  layoff_weeks REAL,
  cleared      INTEGER CHECK (cleared IS NULL OR cleared IN (0,1))
) STRICT;
CREATE UNIQUE INDEX player_medical_records_player ON player_medical_records (player_id, position);

CREATE TABLE player_drill_results (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  drill_id    TEXT NOT NULL,
  drill_name  TEXT,
  metric      TEXT NOT NULL,
  unit        TEXT,
  value       REAL NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX player_drill_results_player ON player_drill_results (player_id, position);

CREATE TABLE player_activity_log (
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

CREATE TABLE player_external_ids (
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  provider       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  source         TEXT NOT NULL,
  linked_by_name TEXT,
  linked_at      INTEGER NOT NULL,
  review_id      TEXT,
  PRIMARY KEY (player_id, provider, external_id)
) STRICT;
CREATE UNIQUE INDEX player_external_ids_position ON player_external_ids (player_id, position);
CREATE INDEX player_external_ids_lookup ON player_external_ids (provider, external_id);

CREATE TABLE player_programme_completions (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;
