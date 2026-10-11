-- ScoutBox target schema — 01 identity and tenancy
-- Organisations, staff accounts, guardians, players (with their owned sub-records) and sessions.
-- Executed first; every other file references these tables. Conventions: docs/architecture/sqlite-schema.md §4.
-- Status: org_users is LIVE (migration 0001). orgs, guardians, guardian_children, players (scalar part) and
-- sessions were created by migration 0002 as a verified SHADOW of the blob snapshot (plan step S1); sessions is
-- LIVE since migration 0003 (S2), orgs since 0004 (S3), and guardians, players and guardian_children since
-- migration 0005 (S4a, repositories/migrations/0005_core_identity_live.mjs, REGISTERED: the cutover replaces the
-- three shadow definitions with the ones below, imports both blobs through the reviewed preflight and retires them;
-- repositories/identity.mjs owns the rows). players and guardians carry one transitional column, `facets_json TEXT
-- CHECK (json_valid)` (S3's pattern: every field not yet in a column — the S5 arrays, medical.records,
-- programme.completed, coGuardians, the outstanding e-mail code, unknown fields — with the record's shape
-- metadata), shown below and compared with the registered migrations by scripts/testSchemaDdl.mjs. The shadow
-- projection is retired. The player_* child tables and the remaining columns arrive with step S5, which also
-- empties facets_json. The media-deletion queue (migration 0006) is in 08_operations_integrations.sql.

-- source: db.orgs  (seed.mjs:15-88; registration server.mjs:1734; T&S org creation m14/review.mjs:382)
-- owner/writer: server.mjs (core), m14 (verification fields), m13 (mfaRequiredForLeads), m24 (agencySettings → 06)
-- lifecycle: no deletion route; suspended flag; verification.revokedAt (m14)
-- mapping: id→id, name→name, type→type, level→level, plan→plan, country→country,
--   location.city/lat/lng→city/lat/lng, federationRef.federation/registrationId→federation/federation_registration_id,
--   trustedPartner→trusted_partner, verified→verified, verifiedDomain→verified_domain,
--   safeguardingContractSigned→safeguarding_contract_signed, password→password_hash, suspended→suspended,
--   emailDomain→email_domain, emailDomainVerified→email_domain_verified, mfaRequiredForLeads→mfa_required_for_leads,
--   verification.revokedAt→verification_revoked_at, verification.orgType→verification_org_type,
--   squad[]→org_squad_members (04), tactical→org_tactical_setups (04), lookingFor[]→org_looking_for (04),
--   federationCheck→org_federation_checks (04), verification.domains[]→org_verified_domains (05),
--   agencySettings→org_agency_settings (06)
-- notes: orgs have no createdAt today (created_at nullable, recorded going forward). `level` also compares against
--   'agent' at server.mjs:2598 but no row carries it; CHECK lists the written values. safeguardingCertified is derived.
--   LIVE since migration 0004 (S3, repositories/orgs.mjs). `level` is nullable: the verification review creates
--   non-grassroots organisations with level null (m14/review.mjs). `facets_json` is the S3 TRANSITIONAL storage for every
--   record field that has not cut over yet (squad, tactical, lookingFor, federationCheck, verification, agencySettings,
--   unknown fields) plus the record's shape metadata (`__meta`: key order, explicit nulls, present composites); it is
--   owned by the repository, mutated in place by the owning modules and flushed inside every save, and shrinks as
--   S9–S11 move those facets into the tables named above. verification_revoked_at / verification_org_type are a derived
--   MIRROR of the verification facet, rewritten at every flush and read by nothing; the facet is authoritative until S10.
CREATE TABLE orgs (
  id                           TEXT PRIMARY KEY,
  name                         TEXT NOT NULL,
  type                         TEXT NOT NULL CHECK (type IN ('club','agency')),
  level                        TEXT CHECK (level IS NULL OR level IN ('pro','academy','agency','grassroots')),
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
  password_hash                TEXT,                       -- scrypt string; NULL = unprovisioned (dev-only login)
  email_domain                 TEXT,
  email_domain_verified        INTEGER NOT NULL DEFAULT 0 CHECK (email_domain_verified IN (0,1)),
  mfa_required_for_leads       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_required_for_leads IN (0,1)),
  verification_revoked_at      INTEGER,                    -- derived mirror of verification.revokedAt (see notes)
  verification_org_type        TEXT,                       -- derived mirror of verification.orgType (see notes)
  created_at                   INTEGER,
  facets_json                  TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)), -- S3 transitional storage (see notes)
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE INDEX orgs_type_level ON orgs (type, level);        -- /orgs directory filters (server.mjs:1683-1696, 4052)

-- source: db.users → LIVE TABLE since migration 0001 (repositories/users.mjs); shown here for completeness
-- owner/writer: repositories/users.mjs only
-- lifecycle: removed_at soft delete; rows are never deleted (history stays attributable)
-- mapping: id→id, orgId→org_id, name→name, role→role, email→email, ssoSubject→sso_subject, createdAt→created_at,
--   removedAt→removed_at, removedBy→removed_by, provenance→provenance, mfa→mfa_json (secretB32 is PLAIN today: open
--   question §9), deliveryPrefs→delivery_prefs_json, unknown fields→extra_json
-- notes: created non-STRICT and without a foreign key by migration 0001 (S0); REBUILT by migration 0004 (S3) in the
--   form below — STRICT, org_id REFERENCES orgs(id) (NO ACTION: an organisation with staff cannot be deleted; the
--   deletion policy itself is open question O2 and is not implemented), json_valid CHECKs on the three JSON columns.
--   The rebuild runs with foreign keys off (create new, copy, drop old, rename), so `sessions.org_user_id` keeps
--   referencing this table by name and no staff session is cascaded away; the migration runner verifies
--   PRAGMA foreign_key_check before committing. scripts/testSchemaDdl.mjs compares this definition with the migrations.
CREATE TABLE org_users (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id),  -- S3: real foreign key
  name                TEXT NOT NULL,
  role                TEXT,
  email               TEXT,                               -- personal data
  sso_subject         TEXT,
  created_at          INTEGER,
  removed_at          INTEGER,
  removed_by          TEXT,                               -- snapshot (name)
  provenance          TEXT,
  mfa_json            TEXT CHECK (mfa_json IS NULL OR json_valid(mfa_json)),                       -- {secretB32, enabledAt, recoveryHashes[]}
  delivery_prefs_json TEXT CHECK (delivery_prefs_json IS NULL OR json_valid(delivery_prefs_json)),
  extra_json          TEXT CHECK (extra_json IS NULL OR json_valid(extra_json))
) STRICT;
CREATE INDEX org_users_org ON org_users (org_id);
CREATE INDEX org_users_org_name ON org_users (org_id, lower(name));
CREATE INDEX org_users_org_email ON org_users (org_id, email);
CREATE INDEX org_users_sso ON org_users (sso_subject);

-- source: db.guardians  (seed.mjs:92-113; signup server.mjs:1249; co-guardian 1588)
-- owner/writer: server.mjs (core)
-- lifecycle: no deletion route; emailVerified/idVerified/disclaimerAccepted gates
-- mapping: id→id, name→name, email→email, password→password_hash, emailVerified→email_verified,
--   emailCode→email_code_hash (PLAIN today), idVerified→id_verified, idvReference→idv_reference,
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
  email_code_hash         TEXT,                           -- sha256 of the 6-char code; plain today (server.mjs:1244)
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
  facets_json             TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)) -- S4a transitional storage (coGuardians, emailCode, unknown fields, shape metadata)
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
--   medical.shared→medical_shared, medical.conditionStatus→medical_condition_status, medical.records[]→player_medical_records,
--   notificationPrefs.*→prefs_*, programme.track/startedAt→programme_track/programme_started_at,
--   programme.completed[]→player_programme_completions
-- mapping (owned sub-records): seasonHistory[]→player_season_history, badges[]→player_badges, attendance[]→player_attendance,
--   timeline[]→player_timeline, media[]→player_media (+player_media_tags), drills[]→player_drills,
--   drillResults[]→player_drill_results, activityLog[]→player_activity_log, externalIds[]→player_external_ids,
--   trialReports[]→NOT migrated: byte-for-byte copy of trials.report (server.mjs:2570); readers join trial_reports (02)
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
  deleted_at               INTEGER,                       -- new: tombstone set by account deletion (see §8 of the schema doc)
  facets_json              TEXT CHECK (facets_json IS NULL OR json_valid(facets_json)), -- S4a transitional storage (the S5 arrays, medical.records, programme.completed, unknown fields, shape metadata)
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
  org_user_id TEXT REFERENCES org_users(id) ON DELETE CASCADE,
  via         TEXT CHECK (via IS NULL OR via IN ('sso')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  CHECK ((kind = 'org') = (org_user_id IS NOT NULL))
) STRICT;
CREATE INDEX sessions_ref ON sessions (kind, ref_id);                        -- revoke by subject (server.mjs:3983; m25:150)
CREATE INDEX sessions_org_user ON sessions (org_user_id);                    -- revokeOrgUserAccess (4298), own sessions (m13:203)
CREATE INDEX sessions_expires ON sessions (expires_at);                      -- prune (645-649)

-- ---------------------------------------------------------------- player sub-records (step S5)

-- source: db.players[].seasonHistory[]  (server.mjs:3493-3498; boot backfill 213)
-- mapping: season→season, appearances/goals/assists/…→columns; unique by season per player (enforced by code)
CREATE TABLE player_season_history (
  player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season              TEXT NOT NULL,                      -- '2024/25'
  appearances         INTEGER,
  goals               INTEGER,
  assists             INTEGER,
  pace_kmh            REAL,
  pass_completion_pct REAL,
  duel_success_pct    REAL,
  clean_sheets        INTEGER,
  PRIMARY KEY (player_id, season)
) STRICT;

-- source: db.players[].badges[] (server.mjs:3347, journey badges 954-958)  mapping: badges[i]→badge
CREATE TABLE player_badges (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  badge     TEXT NOT NULL,
  PRIMARY KEY (player_id, badge)
) STRICT;

-- source: db.players[].drills[] (server.mjs:3535)  mapping: drills[i]→drill_id (code registry DRILLS, not a table)
CREATE TABLE player_drills (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  drill_id  TEXT NOT NULL,
  PRIMARY KEY (player_id, drill_id)
) STRICT;

-- source: db.players[].attendance[]  (server.mjs:3462, 2852-2856; m12/journeys.mjs:698 trial check-in; seed att-<hash>)
-- mapping: id→id, fixture, venue, date→match_date, gps.lat/lng→lat/lng, deviceConfirmed→device_confirmed,
--   verified→verified, corroboratedBy→corroborated_by (org name snapshot), trialId→trial_id (02, comment only)
-- notes: gps is exposed to orgs today (privacy review item §9)
CREATE TABLE player_attendance (
  id               TEXT PRIMARY KEY,
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  fixture          TEXT NOT NULL,
  venue            TEXT,
  match_date       TEXT NOT NULL CHECK (length(match_date) = 10),
  lat              REAL,
  lng              REAL,
  device_confirmed INTEGER CHECK (device_confirmed IN (0,1)),
  verified         INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  corroborated_by  TEXT,                                  -- snapshot (org name)
  trial_id         TEXT,                                  -- trials.id (02), set by trial check-in
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE INDEX player_attendance_player ON player_attendance (player_id, match_date);

-- source: db.players[].timeline[] (server.mjs:3474, 3141; m29/index.mjs:283-296)  mapping: year→year, event→event
-- notes: rows have no id today; the migration mints 'ptl-<n>'
CREATE TABLE player_timeline (
  id        TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  year      TEXT NOT NULL,
  event     TEXT NOT NULL,
  position  INTEGER NOT NULL                              -- array order
) STRICT;
CREATE INDEX player_timeline_player ON player_timeline (player_id, position);

-- source: db.players[].media[]  (server.mjs:3359; m12/operations.mjs:221-224; m16/sessions.mjs:458-459; backfills 205-211)
-- mapping: id→id, title, kind, uploadedAt (ISO string today)→uploaded_at (ms at import), url, views,
--   tags{tag:count}→player_media_tags, verifiedClip→verified_clip_attendance_id, captions→captions (≤200 KB inline VTT),
--   sizeBytes→size_bytes, capturedBy→captured_by, boxSessionId→box_session_id (07, comment only)
-- notes: media bytes live in DATA_DIR/media (adapters.mjs:190-222), never in the database; the cross-player media
--   lookup (server.mjs:4256) becomes a PK hit.
CREATE TABLE player_media (
  id                         TEXT PRIMARY KEY,
  player_id                  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  title                      TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  uploaded_at                INTEGER,
  url                        TEXT,
  views                      INTEGER NOT NULL DEFAULT 0,
  verified_clip_attendance_id TEXT REFERENCES player_attendance(id) ON DELETE SET NULL,
  captions                   TEXT,
  size_bytes                 INTEGER,
  captured_by                TEXT CHECK (captured_by IS NULL OR captured_by IN ('box_cam')),
  box_session_id             TEXT                          -- box_sessions.id (07)
) STRICT;
CREATE INDEX player_media_player ON player_media (player_id, uploaded_at);

-- source: db.players[].media[].tags  (server.mjs:982-985 vocabulary)  mapping: tags[tag]→(media_id, tag, count)
CREATE TABLE player_media_tags (
  media_id TEXT NOT NULL REFERENCES player_media(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  count    INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (media_id, tag)
) STRICT;

-- source: db.players[].medical.records[]  (server.mjs:3392-3405; seed md-1..md-5)
-- mapping: id→id, type, title, date→record_date, layoffWeeks→layoff_weeks, cleared→cleared (tri-state)
-- notes: medical privacy: never read by an org view unless players.medical_shared = 1; never affects the trust score
CREATE TABLE player_medical_records (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  record_date  TEXT CHECK (record_date IS NULL OR length(record_date) = 10),
  layoff_weeks INTEGER,
  cleared      INTEGER CHECK (cleared IS NULL OR cleared IN (0,1))
) STRICT;
CREATE INDEX player_medical_records_player ON player_medical_records (player_id);

-- source: db.players[].drillResults[]  (server.mjs:3537-3546)
-- mapping: id→id, drillId→drill_id, drillName→drill_name (snapshot), metric, unit, value, verified, ts→recorded_at
CREATE TABLE player_drill_results (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  drill_id    TEXT NOT NULL,
  drill_name  TEXT,                                       -- snapshot
  metric      TEXT NOT NULL,
  unit        TEXT,
  value       REAL NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX player_drill_results_player ON player_drill_results (player_id, recorded_at);

-- source: db.players[].activityLog[] (server.mjs:943-947 recordActivity)  mapping: activityLog[i]→occurred_at
-- notes: player-private (never exposed to orgs); drives streaks only
CREATE TABLE player_activity_log (
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, occurred_at)
) STRICT;

-- source: db.players[].externalIds[]  (m13/shared.mjs:47; m13/imports.mjs:223)
-- mapping: provider, externalId→external_id, source, by→linked_by_name (snapshot), at→linked_at, claim→claim_json
CREATE TABLE player_external_ids (
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  source         TEXT NOT NULL,                           -- 'import:<batchId>'
  linked_by_name TEXT,                                    -- snapshot
  linked_at      INTEGER NOT NULL,
  claim_json     TEXT CHECK (claim_json IS NULL OR json_valid(claim_json)),   -- the import record that was linked (free-form)
  PRIMARY KEY (player_id, provider, external_id)
) STRICT;

-- source: db.players[].programme.completed[]  (server.mjs:3577, 3589)  mapping: sessionId→session_id, ts→completed_at
CREATE TABLE player_programme_completions (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, session_id)
) STRICT;

-- not tables: players[].trialReports (duplicate of trials.report → trial_reports in 02); derived profileSignal/trustScore,
--   age, tier, streak, weeklyGoal, nextActions, safeguardingCertified, guardianManaged, distanceKm, similarPlayers;
--   guardians[].coGuardians (duplicate of co_guardian_of); db.mediaBlobs (always {} after boot, server.mjs:246-249);
--   in-memory sseClients/sseTickets/eventLog, rate limiters, saveTimer.
