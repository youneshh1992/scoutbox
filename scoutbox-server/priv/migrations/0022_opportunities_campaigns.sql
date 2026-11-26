-- 0022_opportunities_campaigns: opportunities, applications, campaigns (drills, rubric, submissions, attempts) and player suitability preferences become typed tables

CREATE TABLE opportunities (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name            TEXT NOT NULL CHECK (length(org_name) <= 200),
  org_level           TEXT NOT NULL CHECK (org_level IN ('pro','academy','agency','grassroots')),
  type                TEXT NOT NULL CHECK (type IN ('trial','open_day','programme','role')),
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  team                TEXT CHECK (team IS NULL OR length(team) <= 60),
  category            TEXT NOT NULL CHECK (category IN ('mens','womens','boys','girls','mixed')),
  age_group           TEXT CHECK (age_group IS NULL OR length(age_group) <= 20),
  role                TEXT CHECK (role IS NULL OR length(role) <= 60),
  description         TEXT CHECK (description IS NULL OR length(description) <= 500),
  schedule            TEXT CHECK (schedule IS NULL OR length(schedule) <= 200),
  deadline            TEXT NOT NULL CHECK (length(deadline) = 10),
  capacity            INTEGER CHECK (capacity IS NULL OR capacity >= 1),
  elig_min_age        INTEGER CHECK (elig_min_age IS NULL OR elig_min_age BETWEEN 4 AND 99),
  elig_max_age        INTEGER CHECK (elig_max_age IS NULL OR elig_max_age BETWEEN 4 AND 99),
  elig_position_group TEXT NOT NULL CHECK (elig_position_group IN ('any','GK','DEF','MID','ATT')),
  elig_category       TEXT NOT NULL CHECK (elig_category IN ('mens','womens','boys','girls','mixed')),
  elig_max_level      TEXT CHECK (elig_max_level IS NULL OR elig_max_level IN ('amateur','semi_pro','pro')),
  elig_radius_km      REAL CHECK (elig_radius_km IS NULL OR elig_radius_km BETWEEN 0 AND 1000),
  status              TEXT NOT NULL CHECK (status IN ('published','closed')),
  created_by_name     TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  created_at          INTEGER NOT NULL,
  closed_at           INTEGER,
  structured_declared INTEGER NOT NULL CHECK (structured_declared IN (0,1)),
  relocation_required INTEGER NOT NULL CHECK (relocation_required IN (0,1)),
  fee_minor           INTEGER CHECK (fee_minor IS NULL OR fee_minor >= 0),
  currency            TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')),
  expenses_covered    INTEGER NOT NULL CHECK (expenses_covered IN (0,1)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (elig_min_age IS NULL OR elig_max_age IS NULL OR elig_min_age <= elig_max_age),
  CHECK ((structured_declared = 1) = (currency IS NOT NULL)),
  CHECK (structured_declared = 1 OR (relocation_required = 0 AND expenses_covered = 0 AND fee_minor IS NULL))
) STRICT;
CREATE INDEX opportunities_org ON opportunities (org_id);
CREATE INDEX opportunities_status_deadline ON opportunities (status, deadline);
CREATE TABLE opportunity_training_slots (
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  day        TEXT NOT NULL CHECK (day IN ('mon','tue','wed','thu','fri','sat','sun')),
  start_time TEXT NOT NULL CHECK (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59'),
  end_time   TEXT NOT NULL CHECK (length(end_time) = 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time <= '23:59'),
  tz         TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 40),
  PRIMARY KEY (opportunity_id, ordinal),
  CHECK (start_time < end_time)
) STRICT;
CREATE TABLE opportunity_texts (
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('requirement','environment','accommodation')),
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  text           TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 120),
  PRIMARY KEY (opportunity_id, kind, ordinal)
) STRICT;
CREATE TABLE applications (
  id                      TEXT PRIMARY KEY,
  opportunity_id          TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL,
  player_name             TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  submitted_by_kind       TEXT NOT NULL CHECK (submitted_by_kind IN ('player','guardian')),
  submitted_by_id         TEXT NOT NULL CHECK (length(submitted_by_id) BETWEEN 1 AND 80),
  submitted_by_name       TEXT CHECK (submitted_by_name IS NULL OR length(submitted_by_name) <= 200),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 300),
  status                  TEXT NOT NULL CHECK (status IN ('submitted','withdrawn','accepted','declined')),
  outcome_note            TEXT CHECK (outcome_note IS NULL OR length(outcome_note) <= 300),
  outcome_by_user_id      TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  outcome_by_name         TEXT CHECK (outcome_by_name IS NULL OR length(outcome_by_name) <= 200),
  outcome_at              INTEGER,
  created_at              INTEGER NOT NULL,
  reminded_at             INTEGER,
  suitability_approved_at INTEGER,
  suitability_approved_by TEXT CHECK (suitability_approved_by IS NULL OR suitability_approved_by IN ('player','guardian')),
  CHECK ((status IN ('accepted','declined')) = (outcome_at IS NOT NULL)),
  CHECK ((outcome_at IS NULL) = (outcome_by_user_id IS NULL)),
  CHECK (outcome_at IS NOT NULL OR (outcome_note IS NULL AND outcome_by_name IS NULL)),
  CHECK ((suitability_approved_at IS NULL) = (suitability_approved_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX applications_one_live ON applications (opportunity_id, player_id) WHERE status <> 'withdrawn';
CREATE INDEX applications_opportunity_status ON applications (opportunity_id, status);
CREATE INDEX applications_player ON applications (player_id);
CREATE INDEX applications_reminder_due ON applications (created_at) WHERE status = 'submitted' AND reminded_at IS NULL;
CREATE TABLE application_suitability (
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  dimension      TEXT NOT NULL CHECK (dimension IN ('schedule','travel','relocation','compensation','environment','accessibility')),
  verdict        TEXT NOT NULL CHECK (verdict IN ('compatible','conflict','unknown')),
  PRIMARY KEY (application_id, ordinal),
  UNIQUE (application_id, dimension)
) STRICT;

CREATE TABLE application_history (
  id          TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org','admin')),
  by_id       TEXT,
  by_name     TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action      TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  UNIQUE (application_id, position)
) STRICT;
CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name            TEXT NOT NULL CHECK (length(org_name) <= 200),
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  deadline            TEXT NOT NULL CHECK (length(deadline) = 10),
  attempts_allowed    INTEGER NOT NULL CHECK (attempts_allowed BETWEEN 1 AND 5),
  elig_min_age        INTEGER CHECK (elig_min_age IS NULL OR elig_min_age BETWEEN 4 AND 99),
  elig_max_age        INTEGER CHECK (elig_max_age IS NULL OR elig_max_age BETWEEN 4 AND 99),
  elig_position_group TEXT NOT NULL CHECK (elig_position_group IN ('any','GK','DEF','MID','ATT')),
  elig_max_level      TEXT CHECK (elig_max_level IS NULL OR elig_max_level IN ('amateur','semi_pro','pro')),
  elig_radius_km      REAL CHECK (elig_radius_km IS NULL OR elig_radius_km BETWEEN 0 AND 1000),
  status              TEXT NOT NULL CHECK (status IN ('published')),
  created_by_name     TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  created_at          INTEGER NOT NULL,
  CHECK (elig_min_age IS NULL OR elig_max_age IS NULL OR elig_min_age <= elig_max_age)
) STRICT;
CREATE INDEX campaigns_org ON campaigns (org_id);
CREATE INDEX campaigns_status_deadline ON campaigns (status, deadline);
CREATE TABLE campaign_drills (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ordinal      INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  instructions TEXT NOT NULL CHECK (length(instructions) <= 400),
  equipment    TEXT NOT NULL CHECK (length(equipment) <= 120),
  distance     TEXT NOT NULL CHECK (length(distance) <= 120),
  surface      TEXT NOT NULL CHECK (length(surface) <= 120),
  camera       TEXT NOT NULL CHECK (length(camera) <= 120),
  PRIMARY KEY (campaign_id, ordinal),
  UNIQUE (campaign_id, name)
) STRICT;
CREATE TABLE campaign_rubric (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  criterion   TEXT NOT NULL CHECK (length(criterion) BETWEEN 1 AND 100),
  guidance    TEXT NOT NULL CHECK (length(guidance) <= 200),
  PRIMARY KEY (campaign_id, ordinal)
) STRICT;
CREATE TABLE campaign_submissions (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id         TEXT NOT NULL,
  player_name       TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  submitted_by_kind TEXT NOT NULL CHECK (submitted_by_kind IN ('player','guardian')),
  submitted_by_id   TEXT NOT NULL CHECK (length(submitted_by_id) BETWEEN 1 AND 80),
  submitted_by_name TEXT CHECK (submitted_by_name IS NULL OR length(submitted_by_name) <= 200),
  created_at        INTEGER NOT NULL,
  UNIQUE (campaign_id, player_id)
) STRICT;
CREATE INDEX campaign_submissions_player ON campaign_submissions (player_id);
CREATE TABLE campaign_attempts (
  id                 TEXT PRIMARY KEY,
  submission_id      TEXT NOT NULL REFERENCES campaign_submissions(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
  media_id           TEXT CHECK (media_id IS NULL OR length(media_id) <= 80),
  drill_name         TEXT NOT NULL CHECK (length(drill_name) BETWEEN 1 AND 80),
  note               TEXT CHECK (note IS NULL OR length(note) <= 300),
  file_checks_passed INTEGER NOT NULL CHECK (file_checks_passed IN (0,1)),
  file_checked_at    INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('submitted','failed_checks','accepted','returned')),
  review_by_user_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  review_by_name     TEXT CHECK (review_by_name IS NULL OR length(review_by_name) <= 200),
  reviewed_at        INTEGER,
  review_reasons     TEXT CHECK (review_reasons IS NULL OR length(review_reasons) <= 400),
  review_rubric_notes TEXT CHECK (review_rubric_notes IS NULL OR length(review_rubric_notes) <= 400),
  submitted_at       INTEGER NOT NULL,
  UNIQUE (submission_id, ordinal),
  CHECK ((status = 'failed_checks') = (file_checks_passed = 0)),
  CHECK ((status IN ('accepted','returned')) = (reviewed_at IS NOT NULL)),
  CHECK ((reviewed_at IS NULL) = (review_by_user_id IS NULL)),
  CHECK (reviewed_at IS NOT NULL OR (review_by_name IS NULL AND review_reasons IS NULL AND review_rubric_notes IS NULL)),
  CHECK (status <> 'returned' OR review_reasons IS NOT NULL)
) STRICT;
CREATE INDEX campaign_attempts_status ON campaign_attempts (submission_id, status);
CREATE TABLE campaign_attempt_issues (
  attempt_id TEXT NOT NULL REFERENCES campaign_attempts(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  issue      TEXT NOT NULL CHECK (issue IN ('media_missing','not_video','not_uploaded')),
  PRIMARY KEY (attempt_id, ordinal),
  UNIQUE (attempt_id, issue)
) STRICT;
CREATE TABLE player_prefs (
  player_id       TEXT PRIMARY KEY,
  travel_limit_km REAL CHECK (travel_limit_km IS NULL OR travel_limit_km BETWEEN 0 AND 500),
  transport       TEXT CHECK (transport IS NULL OR transport IN ('own','public','lift_needed')),
  relocation      TEXT CHECK (relocation IS NULL OR relocation IN ('yes','no','discuss')),
  ambitions       TEXT CHECK (ambitions IS NULL OR length(ambitions) <= 300),
  max_fee_minor   INTEGER CHECK (max_fee_minor IS NULL OR max_fee_minor >= 0),
  currency        TEXT NOT NULL CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  expenses_needed INTEGER NOT NULL CHECK (expenses_needed IN (0,1)),
  updated_at      INTEGER NOT NULL
) STRICT;
CREATE TABLE player_pref_slots (
  player_id  TEXT NOT NULL REFERENCES player_prefs(player_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('commitment','available')),
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  day        TEXT NOT NULL CHECK (day IN ('mon','tue','wed','thu','fri','sat','sun')),
  start_time TEXT NOT NULL CHECK (length(start_time) = 5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59'),
  end_time   TEXT NOT NULL CHECK (length(end_time) = 5 AND end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time <= '23:59'),
  tz         TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 40),
  label      TEXT CHECK (label IS NULL OR length(label) <= 60),
  PRIMARY KEY (player_id, kind, ordinal),
  CHECK (start_time < end_time)
) STRICT;
CREATE TABLE player_pref_texts (
  player_id TEXT NOT NULL REFERENCES player_prefs(player_id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('environment','accessibility')),
  ordinal   INTEGER NOT NULL CHECK (ordinal >= 0),
  text      TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 80),
  PRIMARY KEY (player_id, kind, ordinal)
) STRICT;
