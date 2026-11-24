-- 0020_scouting_assessments: assessment templates, assessments (ratings, cited evidence, history), video segments and playlists become typed tables; the v1 templates are inserted

CREATE TABLE assessment_templates (
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  position_group  TEXT NOT NULL CHECK (position_group IN ('GK','DEF','MID','ATT')),
  created_at      INTEGER NOT NULL,
  created_by_name TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  PRIMARY KEY (id, version),
  UNIQUE (position_group, version)
) STRICT;
CREATE TABLE assessment_template_attributes (
  template_id      TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  attr_id          TEXT NOT NULL CHECK (length(attr_id) <= 40),
  label            TEXT NOT NULL CHECK (length(label) <= 80),
  anchor_1         TEXT CHECK (anchor_1 IS NULL OR length(anchor_1) <= 200),
  anchor_2         TEXT CHECK (anchor_2 IS NULL OR length(anchor_2) <= 200),
  anchor_3         TEXT CHECK (anchor_3 IS NULL OR length(anchor_3) <= 200),
  anchor_4         TEXT CHECK (anchor_4 IS NULL OR length(anchor_4) <= 200),
  anchor_5         TEXT CHECK (anchor_5 IS NULL OR length(anchor_5) <= 200),
  PRIMARY KEY (template_id, template_version, position),
  UNIQUE (template_id, template_version, attr_id),
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE CASCADE
) STRICT;
CREATE TABLE video_segments (
  id                 TEXT PRIMARY KEY,
  media_id           TEXT NOT NULL,
  player_id          TEXT NOT NULL,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  start_s            REAL NOT NULL CHECK (start_s >= 0),
  end_s              REAL NOT NULL CHECK (end_s > start_s AND end_s - start_s <= 600),
  event_type         TEXT CHECK (event_type IS NULL OR length(event_type) <= 40),
  note               TEXT CHECK (note IS NULL OR length(note) <= 300),
  drawing_json       TEXT CHECK (drawing_json IS NULL OR (json_valid(drawing_json) AND json_type(drawing_json) = 'object' AND length(drawing_json) <= 4000)),
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX video_segments_org_player ON video_segments (org_id, player_id);
CREATE INDEX video_segments_org_media ON video_segments (org_id, media_id);
CREATE TABLE video_segment_labels (
  segment_id TEXT NOT NULL REFERENCES video_segments(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
  label      TEXT NOT NULL CHECK (length(label) <= 30),
  PRIMARY KEY (segment_id, position)
) STRICT;
CREATE TABLE playlists (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name               TEXT NOT NULL CHECK (length(name) <= 80),
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX playlists_org ON playlists (org_id);
CREATE TABLE playlist_segments (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  segment_id  TEXT NOT NULL REFERENCES video_segments(id) ON DELETE RESTRICT,
  PRIMARY KEY (playlist_id, position),
  UNIQUE (playlist_id, segment_id)
) STRICT;
CREATE TABLE assessments (
  id                            TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id                     TEXT NOT NULL,
  player_name                   TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  scout_user_id                 TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                    TEXT NOT NULL CHECK (length(scout_name) <= 200),
  template_id                   TEXT NOT NULL,
  template_version              INTEGER NOT NULL,
  context_fixture               TEXT CHECK (context_fixture IS NULL OR length(context_fixture) <= 120),
  context_date                  TEXT CHECK (context_date IS NULL OR length(context_date) = 10),
  context_minutes_watched       INTEGER CHECK (context_minutes_watched IS NULL OR context_minutes_watched BETWEEN 1 AND 600),
  context_viewing               TEXT CHECK (context_viewing IS NULL OR context_viewing IN ('live','video')),
  context_opponent_level        TEXT CHECK (context_opponent_level IS NULL OR length(context_opponent_level) <= 60),
  context_trial_id              TEXT,
  context_trial_session_id      TEXT CHECK (context_trial_session_id IS NULL OR context_trial_id IS NOT NULL),
  state                         TEXT NOT NULL CHECK (state IN ('draft','submitted','reviewed')),
  recommendation_verdict        TEXT CHECK (recommendation_verdict IS NULL OR recommendation_verdict IN ('sign','monitor','pass')),
  recommendation_reasons        TEXT CHECK (recommendation_reasons IS NULL OR length(recommendation_reasons) <= 500),
  second_opinion_of_id          TEXT REFERENCES assessments(id) ON DELETE RESTRICT,
  created_at                    INTEGER NOT NULL,
  submitted_at                  INTEGER,
  reviewed_at                   INTEGER,
  review_note                   TEXT CHECK (review_note IS NULL OR length(review_note) <= 300),
  published_feedback_text       TEXT CHECK (published_feedback_text IS NULL OR length(published_feedback_text) <= 800),
  published_feedback_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  published_feedback_by_name    TEXT CHECK (published_feedback_by_name IS NULL OR length(published_feedback_by_name) <= 200),
  published_feedback_at         INTEGER,
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE RESTRICT,
  CHECK ((state = 'draft') = (submitted_at IS NULL)),
  CHECK ((state = 'reviewed') = (reviewed_at IS NOT NULL)),
  CHECK (review_note IS NULL OR state = 'reviewed'),
  CHECK ((recommendation_verdict IS NULL) = (recommendation_reasons IS NULL)),
  CHECK ((published_feedback_text IS NULL) = (published_feedback_by_user_id IS NULL) AND (published_feedback_text IS NULL) = (published_feedback_by_name IS NULL) AND (published_feedback_text IS NULL) = (published_feedback_at IS NULL)),
  CHECK (published_feedback_text IS NULL OR state <> 'draft')
) STRICT;
CREATE INDEX assessments_org_player ON assessments (org_id, player_id);
CREATE INDEX assessments_org_scout ON assessments (org_id, scout_user_id);
CREATE INDEX assessments_player_feedback ON assessments (player_id, published_feedback_at);
CREATE INDEX assessments_trial ON assessments (context_trial_id);
CREATE TABLE assessment_ratings (
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  attr_id       TEXT NOT NULL CHECK (length(attr_id) <= 40),
  rating        INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  not_observed  INTEGER NOT NULL CHECK (not_observed IN (0,1)),
  confidence    TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 300),
  PRIMARY KEY (assessment_id, position),
  UNIQUE (assessment_id, attr_id),
  CHECK ((not_observed = 1) = (rating IS NULL))
) STRICT;
CREATE TABLE assessment_rating_refs (
  assessment_id    TEXT NOT NULL,
  rating_position  INTEGER NOT NULL,
  position         INTEGER NOT NULL CHECK (position BETWEEN 0 AND 5),
  segment_id       TEXT REFERENCES video_segments(id) ON DELETE RESTRICT,
  trial_session_id TEXT CHECK (trial_session_id IS NULL OR length(trial_session_id) <= 80),
  box_session_id   TEXT CHECK (box_session_id IS NULL OR length(box_session_id) <= 80),
  t_s              REAL CHECK (t_s IS NULL OR t_s >= 0),
  label            TEXT CHECK (label IS NULL OR length(label) <= 80),
  PRIMARY KEY (assessment_id, rating_position, position),
  FOREIGN KEY (assessment_id, rating_position) REFERENCES assessment_ratings(assessment_id, position) ON DELETE CASCADE
) STRICT;
CREATE INDEX assessment_rating_refs_segment ON assessment_rating_refs (segment_id);

CREATE TABLE assessment_history (
  id          TEXT PRIMARY KEY,
  assessment_id    TEXT NOT NULL REFERENCES assessments(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org','admin')),
  by_id       TEXT,
  by_name     TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action      TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  UNIQUE (assessment_id, position)
) STRICT;

INSERT INTO assessment_templates (id, version, position_group, created_at, created_by_name) VALUES ('tpl-gk', 1, 'GK', (__NOW__ + 0), 'seed') ON CONFLICT(id, version) DO UPDATE SET position_group = excluded.position_group, created_at = excluded.created_at, created_by_name = excluded.created_by_name;

DELETE FROM assessment_template_attributes WHERE template_id = 'tpl-gk' AND template_version = 1;

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-gk', 1, 0, 'shot_stopping', 'Shot stopping', 'Beaten by savable strikes', NULL, 'Makes the expected saves', NULL, 'Repeatedly saves strikes most keepers concede');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-gk', 1, 1, 'distribution', 'Distribution', 'Kicks are a turnover', NULL, 'Safe short + adequate long', NULL, 'Starts attacks under pressure');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-gk', 1, 2, 'command_of_area', 'Command of area', 'Stays rooted on crosses', NULL, 'Claims the straightforward ball', NULL, 'Owns the box, organises the line');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-gk', 1, 3, 'one_v_one', '1v1', 'Commits early, easily rounded', NULL, 'Delays and narrows angles', NULL, 'Consistently wins clean 1v1s');

INSERT INTO assessment_templates (id, version, position_group, created_at, created_by_name) VALUES ('tpl-def', 1, 'DEF', (__NOW__ + 0), 'seed') ON CONFLICT(id, version) DO UPDATE SET position_group = excluded.position_group, created_at = excluded.created_at, created_by_name = excluded.created_by_name;

DELETE FROM assessment_template_attributes WHERE template_id = 'tpl-def' AND template_version = 1;

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-def', 1, 0, 'positioning', 'Positioning', 'Caught ball-watching', NULL, 'Holds the line, tracks runners', NULL, 'Reads danger two passes early');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-def', 1, 1, 'duels', 'Duels (ground + air)', 'Loses most contests', NULL, 'Breaks even vs like-for-like', NULL, 'Dominant in both phases');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-def', 1, 2, 'first_pass', 'First pass out', 'Clears blind', NULL, 'Finds the free full-back', NULL, 'Breaks a line on the ground');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-def', 1, 3, 'recovery_pace', 'Recovery pace', 'Exposed in space', NULL, 'Copes with average movers', NULL, 'Recovers vs quick attackers');

INSERT INTO assessment_templates (id, version, position_group, created_at, created_by_name) VALUES ('tpl-mid', 1, 'MID', (__NOW__ + 0), 'seed') ON CONFLICT(id, version) DO UPDATE SET position_group = excluded.position_group, created_at = excluded.created_at, created_by_name = excluded.created_by_name;

DELETE FROM assessment_template_attributes WHERE template_id = 'tpl-mid' AND template_version = 1;

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-mid', 1, 0, 'receiving', 'Receiving under pressure', 'Hides from the ball', NULL, 'Keeps it simple, keeps it safe', NULL, 'Wants it in traffic, turns out of it');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-mid', 1, 1, 'progression', 'Ball progression', 'Sideways and backwards only', NULL, 'Moves play forward when on', NULL, 'Consistently breaks lines by pass or carry');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-mid', 1, 2, 'defensive_work', 'Defensive contribution', 'Jogs back', NULL, 'Screens and tracks adequately', NULL, 'Wins it back high, reads screens');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-mid', 1, 3, 'tempo', 'Tempo control', 'Rushes everything', NULL, 'Plays at the game’s pace', NULL, 'Dictates the game’s pace');

INSERT INTO assessment_templates (id, version, position_group, created_at, created_by_name) VALUES ('tpl-att', 1, 'ATT', (__NOW__ + 0), 'seed') ON CONFLICT(id, version) DO UPDATE SET position_group = excluded.position_group, created_at = excluded.created_at, created_by_name = excluded.created_by_name;

DELETE FROM assessment_template_attributes WHERE template_id = 'tpl-att' AND template_version = 1;

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-att', 1, 0, 'finishing', 'Finishing', 'Snatches at chances', NULL, 'Buries the clear ones', NULL, 'Finishes half-chances both feet');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-att', 1, 1, 'movement', 'Movement off the ball', 'Static, marks himself', NULL, 'Finds space in rotation', NULL, 'Constantly unbalances the back line');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-att', 1, 2, 'first_touch', 'First touch', 'Touch escapes under pressure', NULL, 'Controls with time', NULL, 'Kills any ball instantly under pressure');

INSERT INTO assessment_template_attributes (template_id, template_version, position, attr_id, label, anchor_1, anchor_2, anchor_3, anchor_4, anchor_5) VALUES ('tpl-att', 1, 3, 'pressing', 'Pressing', 'No defensive effort', NULL, 'Presses on triggers', NULL, 'First defender, sets the press');
