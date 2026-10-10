/**
 * Core identity tables — organisations, guardians, players (scalar part),
 * guardian/child links and sessions — created as a VERIFIED SHADOW of the
 * blob snapshot (migration plan step S1, docs/architecture/sqlite-migration-plan.md).
 *
 * The blob snapshot stays the source of truth for these collections. The
 * tables are filled by a projection (repositories/shadow.mjs) that is OFF by
 * default: with SCOUTBOX_SHADOW_VALIDATION=1 the server re-projects them
 * inside every save transaction, and scripts/validateShadow.mjs runs the same
 * projection against a copy of a database file. Either way the target
 * constraints — CHECKs, foreign keys, the unique guardian e-mail, hashed
 * session tokens — are exercised against real data and the reconciliation
 * report (/capabilities → dataLayer.shadow, detail on /admin/data-layer)
 * shows which rows the target schema would refuse and why. Nothing reads
 * these tables yet; steps S2–S4 cut the domains over one at a time.
 *
 * The DDL is the identity section of docs/architecture/sql/01_identity.sql
 * (the player_* sub-record tables of that file arrive with step S5).
 */
export const id = '0002_core_identity_shadow';
export const note = 'orgs, guardians, players, guardian_children and sessions tables (shadow of the snapshot; projection opt-in)';

export function up(sqlite) {
  sqlite.exec(`
    CREATE TABLE orgs (
      id                           TEXT PRIMARY KEY,
      name                         TEXT NOT NULL,
      type                         TEXT NOT NULL CHECK (type IN ('club','agency')),
      level                        TEXT NOT NULL CHECK (level IN ('pro','academy','agency','grassroots')),
      plan                         TEXT NOT NULL CHECK (plan IN ('Pro','Academy','Agency','Grassroots')),
      country                      TEXT,
      city                         TEXT,
      lat                          REAL,
      lng                          REAL,
      federation                   TEXT,
      federation_registration_id   TEXT,
      trusted_partner              INTEGER NOT NULL DEFAULT 0 CHECK (trusted_partner IN (0,1)),
      verified                     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
      verified_domain              TEXT,
      safeguarding_contract_signed INTEGER NOT NULL DEFAULT 0 CHECK (safeguarding_contract_signed IN (0,1)),
      suspended                    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
      password_hash                TEXT,
      email_domain                 TEXT,
      email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
      mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
      verification_revoked_at      INTEGER,
      verification_org_type        TEXT,
      created_at                   INTEGER,
      CHECK ((lat IS NULL) = (lng IS NULL))
    ) STRICT;
    CREATE INDEX orgs_type_level ON orgs (type, level);

    CREATE TABLE guardians (
      id                      TEXT PRIMARY KEY,
      name                    TEXT NOT NULL,
      email                   TEXT NOT NULL,
      password_hash           TEXT,
      email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
      email_code_hash         TEXT,
      id_verified             INTEGER NOT NULL DEFAULT 0 CHECK (id_verified IN (0,1)),
      idv_reference           TEXT,
      disclaimer_accepted     INTEGER NOT NULL DEFAULT 0 CHECK (disclaimer_accepted IN (0,1)),
      disclaimer_accepted_at  INTEGER,
      co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE SET NULL,
      prefs_quiet_start       TEXT,
      prefs_quiet_end         TEXT,
      prefs_school_hours_mute INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
      prefs_timezone          TEXT,
      created_at              INTEGER,
      deleted_at              INTEGER
    ) STRICT;
    CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));
    CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);

    CREATE TABLE players (
      id                       TEXT PRIMARY KEY,
      name                     TEXT NOT NULL,
      birth_date               TEXT NOT NULL CHECK (length(birth_date) = 10),
      country                  TEXT NOT NULL,
      city                     TEXT,
      position                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
      foot                     TEXT CHECK (foot IS NULL OR foot IN ('left','right')),
      height_cm                INTEGER,
      weight_kg                INTEGER,
      squad_number             INTEGER,
      contract_until_date      TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
      market_value_range       TEXT,
      agent_name               TEXT,
      academy_plus             INTEGER NOT NULL DEFAULT 0 CHECK (academy_plus IN (0,1)),
      first_team_seeker        INTEGER NOT NULL DEFAULT 0 CHECK (first_team_seeker IN (0,1)),
      availability             TEXT NOT NULL DEFAULT 'not_seeking' CHECK (availability IN ('available_now','end_of_season','loan_open','overseas_open','not_seeking')),
      contract_status          TEXT NOT NULL DEFAULT 'unknown' CHECK (contract_status IN ('under_contract','expiring_summer','scholarship_ending','release_approaching','free_agent','unknown')),
      level                    TEXT NOT NULL DEFAULT 'amateur' CHECK (level IN ('amateur','semi_pro','pro')),
      football_category        TEXT,
      identity_verified        INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0,1)),
      guardian_id              TEXT REFERENCES guardians(id) ON DELETE SET NULL,
      lat                      REAL,
      lng                      REAL,
      stats_appearances        INTEGER,
      stats_goals              INTEGER,
      stats_assists            INTEGER,
      stats_pace_kmh           REAL,
      stats_pass_completion_pct REAL,
      stats_duel_success_pct   REAL,
      stats_clean_sheets       INTEGER,
      medical_shared           INTEGER NOT NULL DEFAULT 0 CHECK (medical_shared IN (0,1)),
      medical_condition_status TEXT NOT NULL DEFAULT 'unknown',
      prefs_quiet_start        TEXT,
      prefs_quiet_end          TEXT,
      prefs_school_hours_mute  INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
      prefs_timezone           TEXT,
      programme_track          TEXT,
      programme_started_at     INTEGER,
      password_hash            TEXT,
      created_at               INTEGER,
      deleted_at               INTEGER,
      CHECK ((lat IS NULL) = (lng IS NULL))
    ) STRICT;
    CREATE INDEX players_guardian ON players (guardian_id);
    CREATE INDEX players_created_at ON players (created_at);
    CREATE INDEX players_search ON players (country, position, availability);
    CREATE INDEX players_level ON players (level);

    CREATE TABLE guardian_children (
      guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
      player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','co')),
      PRIMARY KEY (guardian_id, player_id)
    ) STRICT;
    CREATE INDEX guardian_children_player ON guardian_children (player_id);

    CREATE TABLE sessions (
      token_hash  TEXT PRIMARY KEY,
      sid         TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL CHECK (kind IN ('player','guardian','org','ts_reviewer')),
      ref_id      TEXT NOT NULL,
      org_user_id TEXT REFERENCES org_users(id) ON DELETE CASCADE,
      via         TEXT CHECK (via IS NULL OR via IN ('sso')),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      CHECK ((kind = 'org') = (org_user_id IS NOT NULL))
    ) STRICT;
    CREATE INDEX sessions_ref ON sessions (kind, ref_id);
    CREATE INDEX sessions_org_user ON sessions (org_user_id);
    CREATE INDEX sessions_expires ON sessions (expires_at);
  `);
}
