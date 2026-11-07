-- ScoutBox target schema — 01 identity and tenancy
-- Organisations, staff accounts, guardians, players (with their owned sub-records) and sessions.
-- Executed first; every other file references these tables. Conventions: docs/architecture/sqlite-schema.md §4.
-- Status: org_users is LIVE (migration 0001). orgs, guardians, guardian_children, players (scalar part) and
-- sessions were created by migration 0002 as a verified SHADOW of the blob snapshot (plan step S1); sessions is
-- LIVE since migration 0003 (S2), orgs since 0004 (S3; explicit and without facets_json since S14g), and guardians, players and guardian_children since
-- migration 0005 (S4a, repositories/migrations/0005_core_identity_live.mjs, REGISTERED: the cutover replaces the
-- three shadow definitions with the ones below, imports both blobs through the reviewed preflight and retires them;
-- repositories/identity.mjs owns the rows). players and guardians carry one transitional column, `facets_json TEXT
-- CHECK (json_valid)` (S3's pattern: every field not yet in a column — the S5 arrays, medical.records,
-- programme.completed, coGuardians, the outstanding e-mail code, unknown fields — with the record's shape
-- metadata), shown below and compared with the registered migrations by scripts/testSchemaDdl.mjs. The shadow
-- projection is retired. The twelve player_* child tables are LIVE since migration 0007_player_subrecords (S5,
-- REGISTERED: the arrays move out of facets_json into their tables; see the sub-record section below), so facets_json on
-- players now holds unknown fields and shape metadata only (medical.records and programme.completed are tables too).
-- Since migration.md §4.3.1 (S4a-E, 4 November 2026) every write is explicit: nothing edits a record in place and no
-- save rewrites facets_json; guardians.update writes the coGuardians list, and players.update refuses an unknown field.
-- The media-deletion queue (migration 0006) is in 08_operations_integrations.sql.

-- source: the organisations (repositories/orgs.mjs)
-- owner/writer: repositories/orgs.mjs only (explicit since S14g: create, update(id, draft => …), setPasswordHash);
--   callers are registration (server.mjs), the T&S claim review (domains/verification/claims/review.mjs), the admin
--   routes, the e-mail domain confirmation and the enterprise security switch
-- lifecycle: no deletion route; suspended flag; verification_revoked_at (S10a)
-- mapping: id→id, name→name, type→type, level→level, plan→plan, country→country,
--   location { lat, lng, city }→lat/lng/city (location null ⇔ lat NULL), federationRef { federation, registrationId }
--   →federation/federation_registration_id (null ⇔ both NULL), trustedPartner→trusted_partner, verified→verified,
--   verifiedDomain→verified_domain, safeguardingContractSigned→safeguarding_contract_signed, suspended→suspended,
--   emailDomain→email_domain, emailDomainVerified→email_domain_verified, mfaRequiredForLeads→mfa_required_for_leads,
--   verificationRevokedAt→verification_revoked_at, createdAt→created_at; the password hash is password_hash and is
--   never on a record (passwordHashOf). Former facets live elsewhere: squad[]→org_squad_members, tactical→
--   org_tactical_setups, lookingFor[]→org_looking_for, federationCheck→org_federation_checks (04),
--   verification.domains[]→org_verified_domains (05), agencySettings→org_agency_settings (06).
-- notes: LIVE since migration 0004 (S3), explicit since S14g (0004 amended in place): no facet storage, an unknown
--   field is refused. `level` is nullable: the verification review creates non-grassroots organisations with level
--   null. created_at is set at creation (the seed's at its import). safeguardingCertified is derived. A grassroots
--   club created by the claim review has a placeholder ground (docs/known-issues.md).
CREATE TABLE orgs (
  id                           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  name                         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  type                         TEXT NOT NULL CHECK (type IN ('club', 'agency')),
  level                        TEXT CHECK (level IS NULL OR level IN ('pro', 'academy', 'agency', 'grassroots')),
  plan                         TEXT NOT NULL CHECK (plan IN ('Pro', 'Academy', 'Agency', 'Grassroots')),
  country                      TEXT CHECK (country IS NULL OR length(country) BETWEEN 1 AND 40),
  city                         TEXT CHECK (city IS NULL OR length(city) BETWEEN 1 AND 80),
  lat                          REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng                          REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  federation                   TEXT CHECK (federation IS NULL OR length(federation) BETWEEN 1 AND 120),
  federation_registration_id   TEXT CHECK (federation_registration_id IS NULL OR length(federation_registration_id) BETWEEN 1 AND 60),
  trusted_partner              INTEGER NOT NULL DEFAULT 0 CHECK (trusted_partner IN (0,1)),
  verified                     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verified_domain              TEXT CHECK (verified_domain IS NULL OR length(verified_domain) BETWEEN 1 AND 253),
  safeguarding_contract_signed INTEGER NOT NULL DEFAULT 0 CHECK (safeguarding_contract_signed IN (0,1)),
  suspended                    INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  password_hash                TEXT CHECK (password_hash IS NULL OR length(password_hash) BETWEEN 1 AND 512), -- scrypt string; NULL = unprovisioned (dev-only login)
  email_domain                 TEXT CHECK (email_domain IS NULL OR length(email_domain) BETWEEN 1 AND 253),
  email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
  mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
  verification_revoked_at      INTEGER,                    -- the organisation's verification revocation (S10a)
  created_at                   INTEGER NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL)),
  CHECK (city IS NULL OR lat IS NOT NULL),
  CHECK ((federation IS NULL) = (federation_registration_id IS NULL))
) STRICT;
CREATE INDEX orgs_type_level ON orgs (type, level);        -- the sign-in pickers' and the directory's filters

-- source: the staff accounts (repositories/users.mjs)
-- owner/writer: repositories/users.mjs only (explicit since S14f: create, update(id, draft => …), the MFA operations)
-- lifecycle: removed_at soft delete (removed_by_id: who removed the account); rows are never deleted by a route, so
--   history stays attributable; a re-invite restores a removed account (Founder, S14f)
-- rules: staff sign in by name, so a name is unique in its organisation, case-insensitive, removed accounts included
--   (name_key is the repository's lower-cased name: SQLite's lower() folds ASCII only); an e-mail is unique among the
--   organisation's current staff; an SSO subject is unique in the organisation. (id, org_id) is unique so an org
--   session names its staff member and organisation as one key. The TOTP secret cannot be hashed (codes are checked
--   against it); it never appears on a record. Recovery codes are stored as sha256 hashes, one row each, and spent by
--   deleting the row (a code works once).
-- notes: created in this final form by migration 0001 (amended in place by S14f; 0004 no longer rebuilds it).
--   scripts/testSchemaDdl.mjs compares this definition with the migrations.
CREATE TABLE org_users (
  id             TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  name_key       TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 60),
  email          TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  sso_subject    TEXT CHECK (sso_subject IS NULL OR length(sso_subject) BETWEEN 1 AND 255),
  created_at     INTEGER NOT NULL,
  removed_at     INTEGER,
  removed_by_id  TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  provenance     TEXT CHECK (provenance IS NULL OR provenance IN ('org_password_bootstrap')),
  mfa_secret     TEXT CHECK (mfa_secret IS NULL OR length(mfa_secret) BETWEEN 16 AND 128),
  mfa_enabled_at INTEGER,
  quiet_start    TEXT CHECK (quiet_start IS NULL OR quiet_start GLOB '[01][0-9]:[0-5][0-9]' OR quiet_start GLOB '2[0-3]:[0-5][0-9]'),
  quiet_end      TEXT CHECK (quiet_end IS NULL OR quiet_end GLOB '[01][0-9]:[0-5][0-9]' OR quiet_end GLOB '2[0-3]:[0-5][0-9]'),
  email_enabled  INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0, 1)),
  UNIQUE (id, org_id),
  CHECK (removed_by_id IS NULL OR removed_at IS NOT NULL),
  CHECK (mfa_enabled_at IS NULL OR mfa_secret IS NOT NULL)
) STRICT;
CREATE INDEX org_users_org ON org_users (org_id);
CREATE UNIQUE INDEX org_users_org_name ON org_users (org_id, name_key);
CREATE UNIQUE INDEX org_users_org_email ON org_users (org_id, lower(email)) WHERE email IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX org_users_sso ON org_users (org_id, sso_subject) WHERE sso_subject IS NOT NULL;
CREATE INDEX org_users_removed_by ON org_users (removed_by_id) WHERE removed_by_id IS NOT NULL;
CREATE TABLE org_user_recovery_codes (
  org_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL CHECK (length(code_hash) = 64),
  PRIMARY KEY (org_user_id, code_hash)
) STRICT;

-- source: db.guardians  (seed.mjs:92-113; signup server.mjs:1249; co-guardian 1588)
-- owner/writer: server.mjs (core)
-- lifecycle: no deletion route; emailVerified/idVerified/disclaimerAccepted gates
-- mapping: id→id, name→name, email→email, password→password_hash, emailVerified→email_verified,
--   emailCodeHash→email_code_hash, idVerified→id_verified, idvReference→idv_reference,
--   disclaimerAccepted→disclaimer_accepted (+ disclaimer_accepted_at, new, NULL for imported rows),
--   childIds[]→guardian_children, coGuardianOf→co_guardian_of, coGuardians[]→derived from guardian rows with
--   co_guardian_of (not stored: duplicate), notificationPrefs.{quietStart,quietEnd,schoolHoursMute,timezone}→prefs_* columns
-- notes: email uniqueness is enforced only on the signup path today (co-guardian path 1576-1590 does not check), so the
--   index is UNIQUE on lower(email) in the target and the import reports duplicates (S4 reconciles them first).
--   co-guardian rows carry no password and an undefined emailVerified (reads as not false): both become explicit here.
CREATE TABLE guardians (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  email                   TEXT NOT NULL,                  -- personal data
  password_hash           TEXT,
  email_verified          INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  email_code_hash         TEXT,                           -- sha256 of the 6-char code (hashCode, oneTimeCodes.mjs)
  id_verified             INTEGER NOT NULL DEFAULT 0 CHECK (id_verified IN (0,1)),
  idv_reference           TEXT,
  disclaimer_accepted     INTEGER NOT NULL DEFAULT 0 CHECK (disclaimer_accepted IN (0,1)),
  disclaimer_accepted_at  INTEGER,
  co_guardian_of          TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  prefs_quiet_start       TEXT,                           -- 'HH:MM'
  prefs_quiet_end         TEXT,
  prefs_school_hours_mute INTEGER CHECK (prefs_school_hours_mute IN (0,1)),
  prefs_timezone          TEXT,
  created_at              INTEGER,
  deleted_at              INTEGER,                        -- new: tombstone (no guardian deletion route exists today)
  facets_json             TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)) -- S4a transitional storage (coGuardians, unknown fields, shape metadata)
) STRICT;
CREATE UNIQUE INDEX guardians_email ON guardians (lower(email));   -- new: enforced by code only on signup today
CREATE INDEX guardians_co_guardian_of ON guardians (co_guardian_of);

-- source: db.players  (seed.mjs:496-522; signup server.mjs:1179; guardian child 1419)
-- owner/writer: server.mjs (core); m29 writes level/contractStatus/availability/timeline; m12/m13/m16 add fields
-- lifecycle: hard-deleted by deletePlayerData (server.mjs:3978-4023) → in the target the row becomes a TOMBSTONE
--   (deleted_at set, personal columns redacted, owned sub-records deleted) so that audit rows which reference
--   players(id) with ON DELETE RESTRICT (ledger, blocks, reports, org_notes: 03) keep a valid id; see schema doc §8
-- mapping (scalar): id, name, dob→birth_date, country, city, position, foot, heightCm→height_cm, weightKg→weight_kg,
--   squadNumber→squad_number, contractUntil→contract_until_date, marketValueRange→market_value_range, agentName→agent_name,
--   academyPlus→academy_plus, availability, contractStatus→contract_status, identityVerified→identity_verified,
--   guardianId→guardian_id, createdAt→created_at, password→password_hash, level, location.lat/lng→lat/lng,
--   firstTeamSeeker→first_team_seeker, footballCategory→football_category,
--   stats.{appearances,goals,assists,paceKmh,passCompletionPct,duelSuccessPct,cleanSheets}→stats_* (stats=null → all NULL),
--   medical.shared→medical_shared, medical.conditionStatus→medical_condition_status, medical.records[]→player_medical_records (S5),
--   notificationPrefs.*→prefs_*, programme.track/startedAt→programme_track/programme_started_at,
--   programme.completed[]→player_programme_completions
-- mapping (owned sub-records): seasonHistory[]→player_season_history, badges[]→player_badges, attendance[]→player_attendance,
--   timeline[]→player_timeline, media[]→player_media (+player_media_tags), drills[]→player_drills,
--   drillResults[]→player_drill_results, activityLog[]→player_activity_log, externalIds[]→player_external_ids,
--   trialReports[]→NOT stored: a duplicate of trials.report, served as a DERIVED value from the trials since S5 (trial_reports at S8)
-- notes: dob is never shown to orgs; medical rows are private unless medical_shared; location fails closed for grassroots
--   visibility when NULL; password NULL = seeded/dev or guardian-created child (login only via pairing code).
CREATE TABLE players (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  birth_date               TEXT NOT NULL CHECK (length(birth_date) = 10),   -- YYYY-MM-DD; minor data
  country                  TEXT NOT NULL,
  city                     TEXT,
  position                 TEXT CHECK (position IS NULL OR position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  foot                     TEXT CHECK (foot IS NULL OR foot IN ('left','right')),
  height_cm                INTEGER,
  weight_kg                INTEGER,
  squad_number             INTEGER,
  contract_until_date      TEXT CHECK (contract_until_date IS NULL OR length(contract_until_date) = 10),
  market_value_range       TEXT,
  agent_name               TEXT,                          -- snapshot (free text)
  academy_plus             INTEGER NOT NULL DEFAULT 0 CHECK (academy_plus IN (0,1)),
  first_team_seeker        INTEGER NOT NULL DEFAULT 0 CHECK (first_team_seeker IN (0,1)),
  availability             TEXT NOT NULL DEFAULT 'not_seeking' CHECK (availability IN ('available_now','end_of_season','loan_open','overseas_open','not_seeking')),
  contract_status          TEXT NOT NULL DEFAULT 'unknown' CHECK (contract_status IN ('under_contract','expiring_summer','scholarship_ending','release_approaching','free_agent','unknown')),
  level                    TEXT NOT NULL DEFAULT 'amateur' CHECK (level IN ('amateur','semi_pro','pro')),
  football_category        TEXT,
  identity_verified        INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0,1)),
  guardian_id              TEXT REFERENCES guardians(id) ON DELETE SET NULL,   -- primary guardian; NULL for adults
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
  deleted_at               INTEGER,                       -- set by account deletion since migration 0014 (S4b-R): the row stays as the retained record — id, deleted_at, birth_date, country; placeholders and NULL elsewhere (plan §D.6.1)
  facets_json              TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)), -- transitional storage: unknown fields and shape metadata (S5 moved the arrays into the player_* tables)
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE INDEX players_guardian ON players (guardian_id);                      -- guardian child routes (server.mjs:474, 4259)
CREATE INDEX players_created_at ON players (created_at);                     -- "new this week" (1910-1913)
CREATE INDEX players_search ON players (country, position, availability);   -- /org/players filters (1890-1913)
CREATE INDEX players_level ON players (level);                               -- grassroots ceiling (domain.mjs:115-119)

-- source: db.guardians[].childIds[]  (mirrors players.guardianId; both maintained by hand: server.mjs:1420, 3137, 4018)
-- owner/writer: server.mjs (core)
-- lifecycle: row removed when the child is deleted or ages up (3132-3146); co-guardians keep the id today (gap)
-- mapping: childIds[i]→(guardian_id, player_id); role 'primary' when players.guardian_id = guardian_id, else 'co'
CREATE TABLE guardian_children (
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','co')),
  PRIMARY KEY (guardian_id, player_id)
) STRICT;
CREATE INDEX guardian_children_player ON guardian_children (player_id);

-- source: db.sessions  (createSession server.mjs:650-659)
-- owner/writer: server.mjs (createSession, logout, revokeOrgUserAccess, prune), m13 (own-session revoke), m25 (reviewer revoke)
-- lifecycle: hard delete on logout/revoke/expiry prune; TTL SESSION_TTL_DAYS (30) from createdAt
-- mapping: token→token_hash (PLAIN today, server.mjs:656), sid→sid, kind→kind, refId→ref_id, userId→org_user_id,
--   via→via, createdAt→created_at; expires_at is new (created_at + TTL at insert) so expiry is an indexed column
-- notes: ref_id is polymorphic on kind (players, orgs, guardians, ts_reviewers) and carries no FK; org sessions name the
--   staff member through org_user_id. The lookup on every request becomes a PK hit instead of a scan (server.mjs:664).
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,                           -- sha256 hex of the bearer token
  sid         TEXT NOT NULL UNIQUE,                       -- non-secret id bound into media URLs (server.mjs:356)
  kind        TEXT NOT NULL CHECK (kind IN ('player','guardian','org','ts_reviewer')),
  ref_id      TEXT NOT NULL,                              -- polymorphic on kind: players.id | guardians.id | orgs.id | ts_reviewers.id
  org_user_id TEXT,                                       -- an org session's staff member (with ref_id, one key)
  via         TEXT CHECK (via IS NULL OR via IN ('sso')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  CHECK ((kind = 'org') = (org_user_id IS NOT NULL)),
  CHECK (expires_at > created_at),
  FOREIGN KEY (org_user_id, ref_id) REFERENCES org_users(id, org_id) ON DELETE CASCADE  -- S14f: staff of the session's org
) STRICT;
CREATE INDEX sessions_ref ON sessions (kind, ref_id);                        -- revoke by subject (server.mjs:3983; m25:150)
CREATE INDEX sessions_org_user ON sessions (org_user_id);                    -- revokeOrgUserAccess (4298), own sessions (m13:203)
CREATE INDEX sessions_expires ON sessions (expires_at);                      -- prune (645-649)

-- ---------------------------------------------------------------- player sub-records (step S5)
-- LIVE since migration 0007 (S5, repositories/migrations/0007_player_subrecords.mjs, REGISTERED; the rows are owned by
-- repositories/identity.mjs through repositories/playerSubrecords.mjs; docs/architecture/s5-player-subrecords.md is the
-- implementation note). Conventions the twelve tables share:
--   - player_id REFERENCES players(id) ON DELETE CASCADE (today's hard delete takes the rows with the player; the media
--     FILES are queued in media_deletions inside the same unit of work, before the row goes);
--   - position INTEGER: the array index on the record, so every array reads back in its order and a duplicate the code
--     allows (a client-set badge twice, two activities in one millisecond, a session completed twice) survives; a row
--     without a client-visible id is keyed by (player_id, position) — NO identifier is minted (the earlier prose that
--     minted ids for badges, activity entries and timeline rows is withdrawn);
--   - typed columns, valid input only (3 Nov 2026): no side column. A write stores an item's known fields and drops
--     unknown ones; a value a column cannot hold refuses the write with the field and the index. An item reads back
--     with its fields in the spec's order (a NULL column is null for the fields writers set explicitly — a clip's url,
--     verifiedClip, captions; an attendance's gps; a medical record's layoffWeeks, cleared — and omitted otherwise);
--     every array is on every player record ([] when it has no rows); players.facets_json keeps nothing of them;
--   - natural keys the code enforces are UNIQUE (season per player, drill per player, provider+external id per player,
--     tag per clip, every item id); a legacy array that violates one is refused by the migration, never deduplicated.
--     The migration's blob import drops an unknown item field, converts a wrong-typed value whose meaning is obvious
--     and drops one whose meaning is not, noting each with the player id, array, index and field in
--     meta.playerSubrecordsCutover; an item it cannot use (no id, a required field missing) blocks the step.
-- Reconciled with the data the routes accept (each a change to the earlier proposal): player_media.uploaded_at is TEXT
-- (the ISO string every writer stores), kind nullable, verified_clip_attendance_id has no foreign key (a snapshot rewrite
-- of the attendance rows would have nulled it; the route checks the reference when the clip is created);
-- player_medical_records.layoff_weeks is REAL (the route accepts any finite number in 0–520); player_attendance.match_date
-- has no length CHECK (a trial check-in writes proposedDate as it is); player_season_history counts are REAL (the stats
-- route files any non-negative number into a season). players[].trialReports is NOT a table: it is a duplicate of
-- trials[].report and is served as a DERIVED value from the trials collection (filing order) until S8; migration 0007
-- reconciles every copy with its source before dropping it and blocks on any discrepancy.
-- mapping (record key → column): see repositories/playerSubrecords.mjs SUBRECORD_SPECS —
--   seasonHistory[] → player_season_history (season, appearances, goals, assists, paceKmh→pace_kmh, passCompletionPct→
--     pass_completion_pct, duelSuccessPct→duel_success_pct, cleanSheets→clean_sheets)
--   badges[] → player_badges (badge); drills[] → player_drills (drill_id)
--   attendance[] → player_attendance (id, fixture, venue, date→match_date, gps.lat/lng→lat/lng, deviceConfirmed→
--     device_confirmed, verified, corroboratedBy→corroborated_by, trialId→trial_id)
--   timeline[] → player_timeline (year, event)
--   media[] → player_media (id, title, kind, uploadedAt→uploaded_at, url, views, verifiedClip→verified_clip_attendance_id,
--     captions, sizeBytes→size_bytes, capturedBy→captured_by, boxSessionId→box_session_id); media[].tags{tag:count} →
--     player_media_tags (media_id, tag, count, position = key order)
--   medical.records[] → player_medical_records (id, type, title, date→record_date, layoffWeeks→layoff_weeks, cleared)
--   drillResults[] → player_drill_results (id, drillId→drill_id, drillName→drill_name, metric, unit, value, verified,
--     ts→recorded_at)
--   activityLog[] → player_activity_log (occurred_at)
--   externalIds[] → player_external_ids (provider, externalId→external_id, source, by→linked_by_name, at→linked_at,
--     claim→claim_json)
--   programme.completed[] → player_programme_completions (sessionId→session_id, ts→completed_at)
-- notes: media bytes live in DATA_DIR/media (adapters.mjs), never in the database; medical rows are private unless
--   players.medical_shared (views/playerViews.mjs leaves them out of the org view); attendance GPS is never served to an
--   organisation; the activity log, external ids and drill results are player-private.

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
  uploaded_at                 TEXT,
  url                         TEXT,
  views                       INTEGER NOT NULL DEFAULT 0,
  verified_clip_attendance_id TEXT,
  captions                    TEXT,
  size_bytes                  INTEGER,
  captured_by                 TEXT CHECK (captured_by IS NULL OR captured_by IN ('box_cam')),
  box_session_id              TEXT
) STRICT;
CREATE UNIQUE INDEX player_media_player ON player_media (player_id, position);

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
  claim_json TEXT CHECK (claim_json IS NULL OR json_valid(claim_json)),
  PRIMARY KEY (player_id, provider, external_id)
) STRICT;
CREATE UNIQUE INDEX player_external_ids_position ON player_external_ids (player_id, position);

CREATE TABLE player_programme_completions (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  session_id   TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, position)
) STRICT;

-- not tables: players[].trialReports (duplicate of trials.report → trial_reports in 02); derived profileSignal/trustScore,
--   age, tier, streak, weeklyGoal, nextActions, safeguardingCertified, guardianManaged, distanceKm, similarPlayers;
--   guardians[].coGuardians (duplicate of co_guardian_of); db.mediaBlobs (always {} after boot, server.mjs:246-249);
--   in-memory sseClients/sseTickets/eventLog, rate limiters, saveTimer.
