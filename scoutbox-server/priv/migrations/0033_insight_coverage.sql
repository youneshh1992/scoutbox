-- 0033_insight_coverage: Exposure events, review-later deferrals, evidence suggestions, calibration sessions, fixtures, coverage plans and coverage assignments become typed tables

CREATE TABLE exposure_events (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  kind                                     TEXT NOT NULL CHECK (kind IN ('impression','profile_view','evidence_view')),
  day_index                                INTEGER NOT NULL,
  at                                       INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (day_index >= 0),
  UNIQUE (org_id, player_id, kind, day_index)
) STRICT;
CREATE INDEX exposure_events_org_day ON exposure_events (org_id, day_index);
CREATE INDEX exposure_events_player_day ON exposure_events (player_id, day_index);
CREATE INDEX exposure_events_day ON exposure_events (day_index);
CREATE TABLE review_later (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  due_at                                   INTEGER NOT NULL,
  reminded_at                              INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  UNIQUE (org_id, player_id)
) STRICT;
CREATE INDEX review_later_due ON review_later (due_at) WHERE reminded_at IS NULL;
CREATE TABLE evidence_suggestions (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  player_name                              TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  rule_id                                  TEXT NOT NULL CHECK (rule_id IN ('no_recent_footage','single_match_sample','attribute_never_observed','assessment_disagreement','stale_assessment','uncorroborated_claims')),
  rule_version                             INTEGER NOT NULL,
  explanation                              TEXT NOT NULL CHECK (length(explanation) <= 1000 AND length(explanation) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('suggested','requested','supplied','dismissed','reviewed')),
  requested_at                             INTEGER,
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (rule_version >= 1),
  CHECK (status <> 'requested' OR requested_at IS NOT NULL)
) STRICT;
CREATE INDEX evidence_suggestions_org_player ON evidence_suggestions (org_id, player_id);
CREATE INDEX evidence_suggestions_org_status ON evidence_suggestions (org_id, status);
CREATE UNIQUE INDEX evidence_suggestions_one_open ON evidence_suggestions (org_id, player_id, rule_id) WHERE status IN ('suggested','requested');
CREATE TABLE evidence_suggestion_records (
  suggestion_id                            TEXT NOT NULL CHECK (length(suggestion_id) > 0 AND length(suggestion_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  record_id                                TEXT NOT NULL CHECK (length(record_id) > 0 AND length(record_id) <= 80),
  FOREIGN KEY (suggestion_id) REFERENCES evidence_suggestions(id) ON DELETE CASCADE,
  PRIMARY KEY (suggestion_id, ord)
) STRICT;
CREATE TABLE calibration_sessions (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  template_id                              TEXT NOT NULL CHECK (length(template_id) <= 80 AND length(template_id) > 0),
  template_version                         INTEGER NOT NULL,
  media_id                                 TEXT CHECK (media_id IS NULL OR length(media_id) <= 80 AND length(media_id) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_at                               INTEGER NOT NULL,
  closed_at                                INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE RESTRICT,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX calibration_sessions_org_created ON calibration_sessions (org_id, created_at);
CREATE TABLE calibration_participants (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) > 0 AND length(user_id) <= 80),
  FOREIGN KEY (session_id) REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (session_id, ord),
  UNIQUE (session_id, user_id)
) STRICT;
CREATE INDEX calibration_participants_user ON calibration_participants (user_id);
CREATE TABLE calibration_submissions (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) > 0 AND length(user_id) <= 80),
  user_name                                TEXT CHECK (user_name IS NULL OR length(user_name) <= 200),
  confidence                               TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  submitted_at                             INTEGER NOT NULL,
  FOREIGN KEY (session_id, user_id) REFERENCES calibration_participants(session_id, user_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, user_id)
) STRICT;
CREATE TABLE calibration_ratings (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  user_id                                  TEXT NOT NULL CHECK (length(user_id) > 0 AND length(user_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  attr_id                                  TEXT NOT NULL CHECK (length(attr_id) > 0 AND length(attr_id) <= 40),
  value                                    INTEGER CHECK (value IS NULL OR (value >= 1 AND value <= 5)),
  not_observed                             INTEGER NOT NULL CHECK (not_observed IN (0,1)),
  FOREIGN KEY (session_id, user_id) REFERENCES calibration_submissions(session_id, user_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, user_id, ord),
  UNIQUE (session_id, user_id, attr_id),
  CHECK ((not_observed = 1) = (value IS NULL))
) STRICT;
CREATE TABLE calibration_notes (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  at                                       INTEGER NOT NULL,
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) > 0 AND length(by_user_id) <= 80),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  text                                     TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 500),
  FOREIGN KEY (session_id) REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (session_id, ord)
) STRICT;
CREATE TABLE fixtures (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  competition                              TEXT CHECK (competition IS NULL OR length(competition) <= 80 AND length(competition) > 0),
  home                                     TEXT NOT NULL CHECK (length(home) <= 80 AND length(home) > 0),
  away                                     TEXT NOT NULL CHECK (length(away) <= 80 AND length(away) > 0),
  fixture_date                             TEXT NOT NULL CHECK (length(fixture_date) <= 10),
  lat                                      REAL,
  lng                                      REAL,
  city                                     TEXT CHECK (city IS NULL OR length(city) <= 60),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (fixture_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK ((lat IS NULL) = (city IS NULL)),
  CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90 AND lng >= -180 AND lng <= 180))
) STRICT;
CREATE INDEX fixtures_org_date ON fixtures (org_id, fixture_date);
CREATE TABLE coverage_plans (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  label                                    TEXT NOT NULL CHECK (length(label) <= 100 AND length(label) > 0),
  competition                              TEXT CHECK (competition IS NULL OR length(competition) <= 80 AND length(competition) > 0),
  region                                   TEXT CHECK (region IS NULL OR length(region) <= 80 AND length(region) > 0),
  goal_observations                        INTEGER NOT NULL,
  window_days                              INTEGER NOT NULL,
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK (goal_observations >= 1 AND goal_observations <= 200),
  CHECK (window_days >= 7 AND window_days <= 365)
) STRICT;
CREATE INDEX coverage_plans_org ON coverage_plans (org_id, created_at);
CREATE TABLE coverage_assignments (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  fixture_kind                             TEXT NOT NULL CHECK (fixture_kind IN ('own','friendly_board','open_trial')),
  fixture_id                               TEXT CHECK (fixture_id IS NULL OR length(fixture_id) <= 80 AND length(fixture_id) > 0),
  friendly_id                              TEXT CHECK (friendly_id IS NULL OR length(friendly_id) <= 80 AND length(friendly_id) > 0),
  open_trial_id                            TEXT CHECK (open_trial_id IS NULL OR length(open_trial_id) <= 80 AND length(open_trial_id) > 0),
  fixture_date                             TEXT NOT NULL CHECK (length(fixture_date) <= 10),
  fixture_label                            TEXT NOT NULL CHECK (length(fixture_label) <= 200 AND length(fixture_label) > 0),
  fixture_competition                      TEXT CHECK (fixture_competition IS NULL OR length(fixture_competition) <= 80 AND length(fixture_competition) > 0),
  scout_user_id                            TEXT NOT NULL CHECK (length(scout_user_id) <= 80 AND length(scout_user_id) > 0),
  scout_name                               TEXT CHECK (scout_name IS NULL OR length(scout_name) <= 200),
  travel_budget_minor                      INTEGER,
  travel_currency                          TEXT CHECK (travel_currency IS NULL OR travel_currency IN ('GBP','EUR','USD','CHF','SEK','NOK','DKK','PLN','BRL')),
  travel_entered_by_name                   TEXT CHECK (travel_entered_by_name IS NULL OR length(travel_entered_by_name) <= 200),
  assigned_by_name                         TEXT CHECK (assigned_by_name IS NULL OR length(assigned_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  observed_at                              INTEGER,
  assessment_id                            TEXT CHECK (assessment_id IS NULL OR length(assessment_id) <= 80 AND length(assessment_id) > 0),
  cancelled_at                             INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (fixture_id) REFERENCES fixtures(id) ON DELETE RESTRICT,
  FOREIGN KEY (scout_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (fixture_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  FOREIGN KEY (friendly_id) REFERENCES friendlies(id) ON DELETE RESTRICT,
  FOREIGN KEY (open_trial_id) REFERENCES open_trials(id) ON DELETE RESTRICT,
  CHECK ((fixture_kind = 'own') = (fixture_id IS NOT NULL)),
  CHECK ((fixture_kind = 'friendly_board') = (friendly_id IS NOT NULL)),
  CHECK ((fixture_kind = 'open_trial') = (open_trial_id IS NOT NULL)),
  CHECK ((travel_budget_minor IS NULL) = (travel_currency IS NULL)),
  CHECK (travel_budget_minor IS NULL OR travel_budget_minor >= 0),
  CHECK (travel_budget_minor IS NOT NULL OR travel_entered_by_name IS NULL),
  CHECK (assessment_id IS NULL OR observed_at IS NOT NULL)
) STRICT;
CREATE INDEX coverage_assignments_org_created ON coverage_assignments (org_id, created_at, id);
CREATE INDEX coverage_assignments_org_fixture ON coverage_assignments (org_id, fixture_kind, fixture_id, friendly_id, open_trial_id);
CREATE INDEX coverage_assignments_friendly ON coverage_assignments (friendly_id) WHERE friendly_id IS NOT NULL;
CREATE INDEX coverage_assignments_open_trial ON coverage_assignments (open_trial_id) WHERE open_trial_id IS NOT NULL;
CREATE INDEX coverage_assignments_org_scout_date ON coverage_assignments (org_id, scout_user_id, fixture_date);
CREATE INDEX coverage_assignments_org_observed ON coverage_assignments (org_id, observed_at);
CREATE INDEX coverage_assignments_fixture ON coverage_assignments (fixture_id);
CREATE TABLE coverage_assignment_targets (
  assignment_id                            TEXT NOT NULL CHECK (length(assignment_id) > 0 AND length(assignment_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  FOREIGN KEY (assignment_id) REFERENCES coverage_assignments(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, ord),
  UNIQUE (assignment_id, player_id)
) STRICT;
CREATE TABLE coverage_assignment_warnings (
  assignment_id                            TEXT NOT NULL CHECK (length(assignment_id) > 0 AND length(assignment_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  code                                     TEXT NOT NULL CHECK (code IN ('duplicate_visit','scout_clash')),
  scout_name                               TEXT CHECK (scout_name IS NULL OR length(scout_name) <= 200),
  FOREIGN KEY (assignment_id) REFERENCES coverage_assignments(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, ord),
  UNIQUE (assignment_id, code)
) STRICT;
