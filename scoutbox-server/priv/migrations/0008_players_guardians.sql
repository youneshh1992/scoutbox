-- Players, guardians and the guardian-child links. The TypeScript table's match-facts triggers arrive with
-- discovery's match facts.
CREATE TABLE guardians (
  id                      TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  email                   TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  password_hash           TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND 512),
  email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  email_code_hash         TEXT CHECK (email_code_hash IS NULL OR length(email_code_hash) = 64),
  id_verified             INTEGER NOT NULL DEFAULT 0 CHECK (id_verified IN (0,1)),
  idv_reference           TEXT CHECK (idv_reference IS NULL OR length(idv_reference) BETWEEN 1 AND 120),
  disclaimer_accepted     INTEGER NOT NULL DEFAULT 0 CHECK (disclaimer_accepted IN (0,1)),
  disclaimer_accepted_at  INTEGER,
  co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE RESTRICT,
  prefs_quiet_start       TEXT CHECK (prefs_quiet_start IS NULL OR (length(prefs_quiet_start) = 5 AND prefs_quiet_start GLOB '[0-2][0-9]:[0-5][0-9]')),
  prefs_quiet_end         TEXT CHECK (prefs_quiet_end IS NULL OR (length(prefs_quiet_end) = 5 AND prefs_quiet_end GLOB '[0-2][0-9]:[0-5][0-9]')),
  prefs_school_hours_mute INTEGER CHECK (prefs_school_hours_mute IS NULL OR prefs_school_hours_mute IN (0,1)),
  prefs_timezone          TEXT CHECK (prefs_timezone IS NULL OR length(prefs_timezone) BETWEEN 1 AND 64),
  created_at              INTEGER,
  CHECK (co_guardian_of IS NULL OR co_guardian_of <> id)
) STRICT;
CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);
CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));
CREATE TABLE players (
  id                        TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  name                      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  birth_date                TEXT NOT NULL CHECK (length(birth_date) = 10),
  country                   TEXT NOT NULL CHECK (length(country) BETWEEN 1 AND 40),
  city                      TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  position                  TEXT CHECK (position IS NULL OR position IN ('GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF')),
  foot                      TEXT CHECK (foot IS NULL OR foot IN ('left', 'right')),
  height_cm                 INTEGER CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 250),
  weight_kg                 INTEGER CHECK (weight_kg IS NULL OR weight_kg BETWEEN 15 AND 200),
  squad_number              INTEGER CHECK (squad_number IS NULL OR squad_number BETWEEN 0 AND 999),
  contract_until_date       TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
  market_value_range        TEXT CHECK (market_value_range IS NULL OR length(market_value_range) BETWEEN 1 AND 60),
  agent_name                TEXT CHECK (agent_name IS NULL OR length(agent_name) BETWEEN 1 AND 120),
  academy_plus              INTEGER NOT NULL DEFAULT 0 CHECK (academy_plus IN (0,1)),
  first_team_seeker         INTEGER NOT NULL DEFAULT 0 CHECK (first_team_seeker IN (0,1)),
  availability              TEXT NOT NULL DEFAULT 'not_seeking' CHECK (availability IN ('available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking')),
  contract_status           TEXT NOT NULL DEFAULT 'unknown' CHECK (contract_status IN ('under_contract', 'expiring_summer', 'scholarship_ending', 'release_approaching', 'free_agent', 'unknown')),
  level                     TEXT NOT NULL DEFAULT 'amateur' CHECK (level IN ('amateur', 'semi_pro', 'pro')),
  football_category         TEXT CHECK (football_category IS NULL OR length(football_category) BETWEEN 1 AND 40),
  identity_verified         INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0,1)),
  guardian_id               TEXT REFERENCES guardians(id) ON DELETE RESTRICT,
  lat                       REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                       REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  stats_appearances         INTEGER CHECK (stats_appearances IS NULL OR stats_appearances >= 0),
  stats_goals               INTEGER CHECK (stats_goals IS NULL OR stats_goals >= 0),
  stats_assists             INTEGER CHECK (stats_assists IS NULL OR stats_assists >= 0),
  stats_pace_kmh            REAL CHECK (stats_pace_kmh IS NULL OR stats_pace_kmh >= 0),
  stats_pass_completion_pct REAL CHECK (stats_pass_completion_pct IS NULL OR stats_pass_completion_pct BETWEEN 0 AND 100),
  stats_duel_success_pct    REAL CHECK (stats_duel_success_pct IS NULL OR stats_duel_success_pct BETWEEN 0 AND 100),
  stats_clean_sheets        INTEGER CHECK (stats_clean_sheets IS NULL OR stats_clean_sheets >= 0),
  medical_shared            INTEGER NOT NULL DEFAULT 0 CHECK (medical_shared IN (0,1)),
  medical_condition_status  TEXT NOT NULL DEFAULT 'unknown' CHECK (length(medical_condition_status) BETWEEN 1 AND 40),
  prefs_quiet_start         TEXT CHECK (prefs_quiet_start IS NULL OR (length(prefs_quiet_start) = 5 AND prefs_quiet_start GLOB '[0-2][0-9]:[0-5][0-9]')),
  prefs_quiet_end           TEXT CHECK (prefs_quiet_end IS NULL OR (length(prefs_quiet_end) = 5 AND prefs_quiet_end GLOB '[0-2][0-9]:[0-5][0-9]')),
  prefs_school_hours_mute   INTEGER CHECK (prefs_school_hours_mute IS NULL OR prefs_school_hours_mute IN (0,1)),
  prefs_timezone            TEXT CHECK (prefs_timezone IS NULL OR length(prefs_timezone) BETWEEN 1 AND 64),
  programme_track           TEXT CHECK (programme_track IS NULL OR length(programme_track) BETWEEN 1 AND 60),
  programme_started_at      INTEGER,
  password_hash             TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND 512),
  profile_signal            INTEGER NOT NULL CHECK (profile_signal BETWEEN 0 AND 99),
  created_at                INTEGER,
  deleted_at                INTEGER,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (deleted_at IS NULL OR guardian_id IS NULL)
) STRICT;
CREATE INDEX players_birth_date ON players (birth_date);
CREATE INDEX players_created_at ON players (created_at);
CREATE INDEX players_directory ON players (academy_plus DESC, profile_signal DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX players_guardian ON players (guardian_id);
CREATE INDEX players_level ON players (level);
CREATE INDEX players_located ON players (lat, lng) WHERE lat IS NOT NULL;
CREATE INDEX players_search ON players (country, position, availability);
CREATE TABLE guardian_children (
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE RESTRICT,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  role        TEXT NOT NULL CHECK (role IN ('primary', 'co')),
  PRIMARY KEY (guardian_id, player_id)
) STRICT;
CREATE UNIQUE INDEX guardian_children_one_primary ON guardian_children (player_id) WHERE role = 'primary';
CREATE INDEX guardian_children_player ON guardian_children (player_id);
