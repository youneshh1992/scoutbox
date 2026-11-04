-- ============================================================================
-- 04_scouting_assessment.sql — ScoutBox target relational schema (SQLite, STRICT)
--
-- Scope: M12 F1/F2/F4/F5/F6/F7/F10 collections + M13 F3 playerPrefs (S9d) + the
-- org-level fields `tactical`, `squad[]`, `lookingFor[]`, `federationCheck` (club setup tables since S9c).
-- Sources: scoutbox-server/domains/scouting/passport.mjs, domains/scouting/scouting.mjs, domains/scouting/journeys.mjs,
-- m12/shared.mjs (migrateM12), domains/scouting/suitability.mjs, m13/shared.mjs (migrateM13),
-- server.mjs (looking-for, squad, verification/federation), domains/recruitment/signings/index.mjs (squad
-- on signing), m12/operations.mjs (application reminder sweep).
--
-- Depends on (created earlier in lexical order):
--   01_identity.sql   : orgs(id), org_users(id), players(id), guardians(id), player_media(id)
--   02_recruitment.sql: trials(id)   (recruitment_cases / signings / recruitment_requests
--                       are not referenced from this file; 02 references `vacancies`
--                       and `assessments` from here)
--
-- Cross-cutting notes
--   * Ids are the existing nextId() strings (`evd-N`, `ass-N`, ...). Rows that have
--     no id today get a natural composite key; each table's header says which.
--   * Account deletion (server.mjs deletePlayerData) today hard-removes the player
--     row, nulls `assessments.playerName` and leaves evidence, applications,
--     campaign submissions, squad invites, video segments and playerPrefs
--     orphaned with the id (and the name snapshot) still inside them. The target
--     distinguishes: player-OWNED rows cascade with the player; org records that
--     must outlive the subject use RESTRICT and expect the player row to be
--     tombstoned (not hard-deleted) in 01_identity, with `player_name` nulled.
--   * history[] arrays follow the conventions shape; `detail` is a free string in
--     the source and is stored JSON-encoded in `detail_json`.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- S9a: IMPLEMENTED, migration 0019_scouting_evidence REGISTERED (repositories/scoutingEvidence.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL; scripts/testSchemaDdl.mjs compares them column by column.
-- Sources: domains/scouting/passport.mjs (evidence, disputes, corrections, coach affiliations, squad invitations).
-- How the model differs from the first draft of this file:
--   * player_id (evidence, squad_invites) has NO foreign key: tolerant and counted, like recruitment. Evidence and
--     invitations stay after an account deletion, as before (retention is an open question, decisions.md §5).
--   * org_id is ON DELETE RESTRICT, not CASCADE (organisations are never deleted, O2).
--   * evidence.value is typed: value_number REAL or value_text TEXT (at most one), not value_json.
--   * evidence_media keeps the order (position) and has no key to player_media: a removed clip stays named.
--   * superseded_by_id is RESTRICT (evidence is never deleted); both self keys are immediate: a correction is
--     inserted first, then the original is pointed at it, in one unit of work.
--   * history uses the one entry shape {id, at, byKind, byId, byName, action, detail}; detail is plain text.
--     coach_affiliations_history is named coach_affiliation_history.
--   * disputes keep their order (position); a resolved dispute carries its outcome and instant (CHECK).
--   * coach_affiliations: to_date is set exactly when the affiliation is no longer confirmed (CHECK). The coach is
--     still identified by name (KNOWN DEFECT: activeAffiliation matches the staff member's display name; a
--     product decision for the Founder, migration.md §4.5).
--   * squad_invites: responded_at is set exactly when the invitation is answered (CHECK); one pending
--     invitation per organisation and player (partial unique index).
--   * Text columns carry the routes' length limits as CHECKs.
-- ----------------------------------------------------------------------------
CREATE TABLE evidence (
  id                  TEXT PRIMARY KEY,
  player_id           TEXT NOT NULL,
  claim_type          TEXT NOT NULL CHECK (claim_type IN ('statistic','attendance','assessment_result','reference','footage','availability')),
  label               TEXT NOT NULL CHECK (length(label) <= 120),
  value_number        REAL,
  value_text          TEXT CHECK (value_text IS NULL OR length(value_text) <= 120),
  units               TEXT CHECK (units IS NULL OR length(units) <= 20),
  season              TEXT CHECK (season IS NULL OR length(season) <= 20),
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('player','guardian','org')),
  source_id           TEXT NOT NULL,
  source_name         TEXT NOT NULL CHECK (length(source_name) <= 200),
  observed_at         INTEGER,
  recorded_at         INTEGER NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('self_reported','coach_confirmed','club_assessed')),
  verification_method TEXT CHECK (verification_method IS NULL OR length(verification_method) <= 80),
  reviewer_id         TEXT,
  reviewer_name       TEXT CHECK (reviewer_name IS NULL OR length(reviewer_name) <= 200),
  reviewed_at         INTEGER,
  expires_at          INTEGER,
  correction_of_id    TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  superseded_by_id    TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  note                TEXT CHECK (note IS NULL OR length(note) <= 300),
  CHECK (value_number IS NULL OR value_text IS NULL)
) STRICT;
CREATE INDEX evidence_player ON evidence (player_id, claim_type);
CREATE INDEX evidence_superseded_by ON evidence (superseded_by_id);
CREATE TABLE evidence_media (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  media_id    TEXT NOT NULL,
  PRIMARY KEY (evidence_id, position),
  UNIQUE (evidence_id, media_id)
) STRICT;
CREATE TABLE evidence_disputes (
  id                 TEXT PRIMARY KEY,
  evidence_id        TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  filed_at           INTEGER NOT NULL,
  by_kind            TEXT NOT NULL CHECK (by_kind IN ('player','org')),
  by_id              TEXT NOT NULL,
  by_name            TEXT NOT NULL CHECK (length(by_name) <= 200),
  reason             TEXT NOT NULL CHECK (length(reason) <= 300),
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('upheld','rejected')),
  resolution_note    TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 300),
  resolved_at        INTEGER,
  UNIQUE (evidence_id, position),
  CHECK ((status = 'resolved') = (resolution_outcome IS NOT NULL AND resolved_at IS NOT NULL))
) STRICT;
CREATE INDEX evidence_disputes_status_filed ON evidence_disputes (status, filed_at);

CREATE TABLE evidence_history (
  id          TEXT PRIMARY KEY,
  evidence_id    TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org','admin')),
  by_id       TEXT,
  by_name     TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action      TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  UNIQUE (evidence_id, position)
) STRICT;
CREATE TABLE coach_affiliations (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name             TEXT NOT NULL CHECK (length(org_name) <= 200),
  coach_name           TEXT NOT NULL CHECK (length(coach_name) <= 80),
  coach_email          TEXT CHECK (coach_email IS NULL OR length(coach_email) <= 120),
  role                 TEXT NOT NULL CHECK (length(role) <= 60),
  from_date            TEXT NOT NULL CHECK (length(from_date) = 10),
  to_date              TEXT CHECK (to_date IS NULL OR length(to_date) = 10),
  status               TEXT NOT NULL CHECK (status IN ('confirmed','ended','revoked')),
  confirmed_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  confirmed_by_name    TEXT NOT NULL CHECK (length(confirmed_by_name) <= 200),
  conflict_of_interest TEXT CHECK (conflict_of_interest IS NULL OR length(conflict_of_interest) <= 200),
  created_at           INTEGER NOT NULL,
  CHECK ((status = 'confirmed') = (to_date IS NULL))
) STRICT;
CREATE INDEX coach_affiliations_org_status ON coach_affiliations (org_id, status);
CREATE INDEX coach_affiliations_created ON coach_affiliations (created_at);

CREATE TABLE coach_affiliation_history (
  id          TEXT PRIMARY KEY,
  affiliation_id    TEXT NOT NULL REFERENCES coach_affiliations(id) ON DELETE RESTRICT,
  position    INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IS NULL OR by_kind IN ('player','guardian','org','admin')),
  by_id       TEXT,
  by_name     TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action      TEXT NOT NULL,
  detail      TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  UNIQUE (affiliation_id, position)
) STRICT;
CREATE TABLE squad_invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name     TEXT NOT NULL CHECK (length(org_name) <= 200),
  player_id    TEXT NOT NULL,
  player_name  TEXT CHECK (player_name IS NULL OR length(player_name) <= 200),
  by_user_id   TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name      TEXT NOT NULL CHECK (length(by_name) <= 200),
  note         TEXT CHECK (note IS NULL OR length(note) <= 200),
  status       TEXT NOT NULL CHECK (status IN ('pending_guardian','pending_player','approved','declined')),
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  CHECK ((status IN ('approved','declined')) = (responded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX squad_invites_one_pending ON squad_invites (org_id, player_id) WHERE status IN ('pending_guardian','pending_player');
CREATE INDEX squad_invites_player_status ON squad_invites (player_id, status);


-- ----------------------------------------------------------------------------
-- S9c: IMPLEMENTED, migration 0021_club_setup REGISTERED (repositories/clubSetup.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL; scripts/testSchemaDdl.mjs compares them column by column.
-- A club's own setup: the tactical setup (roles, criteria, windows), the squad, the shadow list, what a grassroots club
-- is looking for, the federation-route verification request, and role vacancies. The first four were facets of the
-- organisation record (orgs.facets_json: tactical, squad, lookingFor, federationCheck); the migration removes them from
-- the facets (their contents are not carried over) and repositories/orgs.mjs refuses them on a record. Vacancies were
-- the blob collection db.vacancies.
-- Sources: domains/scouting/scouting.mjs (tactical, vacancies, candidates, shadow list, planner), server.mjs (the
-- grassroots squad and release, match days, looking-for, the radar, the federation request), domains/scouting/passport.mjs
-- (an approved squad invitation), domains/recruitment/signings/index.mjs (a grassroots signing); readers in m15, m162, m18.
-- How the model differs from the first draft of this file:
--   * The shadow list is its own table (org_shadow_players), not a squad row with source 'shadow' (decided with the
--     Founder, 4 Nov): a club considering a player is not that player's club. The grassroots squad, match-day
--     attendance, release, the passport's club relationships, the Trust score and Second Look read org_squad_members
--     only; Nobody Missed still counts either as "considered". A shadowed player can then sign or be invited onto the
--     squad (the old code skipped the squad row when a shadow row existed).
--   * org_id is ON DELETE RESTRICT, not CASCADE (organisations are never deleted, O2). player_id has NO foreign key:
--     tolerant, like recruitment and S9a (a squad row outlives the account, as before).
--   * Role criteria: value_number / value_text, not value_json; each key has its vocabulary (positionGroup GK|DEF|MID|ATT,
--     foot left|right as players store it, availability and maxLevel the player vocabularies, category the role
--     categories) or whole-number range (ages 5-60, appearances 0-1000); one criterion per key and kind.
--   * Roles keep their order (ordinal) and are diffed BY ID on a re-save (kept rows updated in place); a client role id
--     must be one of the club's current roles (the old route accepted any id, another club's included). Roles,
--     criteria and windows cascade with their setup; vacancies.role_id and org_shadow_players.role_id are SET NULL (a
--     dropped role: the candidates route answers 409 ROLE_DELETED, as before), the role checked to be the club's own.
--   * Windows: opens / closes are YYYY-MM-DD days or null, opens <= closes. More than 15 roles or 4 windows is refused,
--     not cut off; an unknown position group or category is refused, not turned into MID / mixed.
--   * Squad rows: source manual | invite_approved | signing; approved_by_label exactly on an approved invitation; a
--     player id on every row but a manual one (off-platform people); one row per club and on-platform player.
--   * Looking-for: position codes only (the radar matches them against the player's position), at most five, unique.
--   * Federation check: one per club, replaced on resubmission; contact_email an e-mail address or null; the source
--     field `ts` is submitted_at.
--   * Vacancies: window_name (`window` is an SQL keyword), the closed state CHECK; the club list pages by cursor.
-- ----------------------------------------------------------------------------
CREATE TABLE org_tactical_setups (
  org_id           TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  formation        TEXT NOT NULL CHECK (length(formation) BETWEEN 1 AND 20),
  planning_horizon TEXT CHECK (planning_horizon IS NULL OR length(planning_horizon) <= 40),
  updated_at       INTEGER NOT NULL,
  updated_by_name  TEXT NOT NULL CHECK (length(updated_by_name) <= 200)
) STRICT;
CREATE TABLE org_tactical_roles (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal >= 0),
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  position_group TEXT NOT NULL CHECK (position_group IN ('GK','DEF','MID','ATT')),
  description    TEXT NOT NULL CHECK (length(description) <= 300),
  category       TEXT NOT NULL CHECK (category IN ('mens','womens','boys','girls','mixed')),
  UNIQUE (org_id, id)
) STRICT;
CREATE TABLE org_tactical_role_criteria (
  role_id      TEXT NOT NULL REFERENCES org_tactical_roles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
  key          TEXT NOT NULL CHECK (key IN ('positionGroup','minAge','maxAge','foot','availability','maxLevel','minAppearances','category')),
  value_number INTEGER,
  value_text   TEXT CHECK (value_text IS NULL OR length(value_text) <= 40),
  PRIMARY KEY (role_id, kind, ordinal),
  UNIQUE (role_id, kind, key),
  CHECK ((value_number IS NULL) <> (value_text IS NULL)),
  CHECK ((key IN ('minAge','maxAge','minAppearances')) = (value_number IS NOT NULL))
) STRICT;
CREATE TABLE org_tactical_windows (
  org_id  TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  name    TEXT NOT NULL CHECK (length(name) <= 40),
  opens   TEXT CHECK (opens IS NULL OR length(opens) = 10),
  closes  TEXT CHECK (closes IS NULL OR length(closes) = 10),
  PRIMARY KEY (org_id, ordinal),
  CHECK (opens IS NULL OR closes IS NULL OR opens <= closes)
) STRICT;
CREATE TABLE org_squad_members (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id         TEXT,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  position          TEXT CHECK (position IS NULL OR length(position) <= 40),
  source            TEXT NOT NULL CHECK (source IN ('manual','invite_approved','signing')),
  approved_by_label TEXT CHECK (approved_by_label IS NULL OR length(approved_by_label) <= 200),
  added_at          INTEGER NOT NULL,
  CHECK ((source = 'invite_approved') = (approved_by_label IS NOT NULL)),
  CHECK (source = 'manual' OR player_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX org_squad_members_org_player ON org_squad_members (org_id, player_id) WHERE player_id IS NOT NULL;
CREATE INDEX org_squad_members_org ON org_squad_members (org_id);
CREATE INDEX org_squad_members_player ON org_squad_members (player_id);
CREATE TABLE org_shadow_players (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id     TEXT NOT NULL,
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  role_id       TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,
  added_by_name TEXT NOT NULL CHECK (length(added_by_name) <= 200),
  added_at      INTEGER NOT NULL,
  UNIQUE (org_id, player_id)
) STRICT;
CREATE INDEX org_shadow_players_player ON org_shadow_players (player_id);
CREATE TABLE org_looking_for (
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  ordinal  INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  position TEXT NOT NULL CHECK (position IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  PRIMARY KEY (org_id, ordinal),
  UNIQUE (org_id, position)
) STRICT;
CREATE TABLE org_federation_checks (
  org_id          TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE RESTRICT,
  federation      TEXT NOT NULL CHECK (length(federation) BETWEEN 1 AND 120),
  registration_id TEXT NOT NULL CHECK (length(registration_id) BETWEEN 1 AND 60),
  contact_email   TEXT CHECK (contact_email IS NULL OR length(contact_email) <= 120),
  status          TEXT NOT NULL CHECK (status IN ('pending')),
  submitted_at    INTEGER NOT NULL
) STRICT;
CREATE TABLE vacancies (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  role_id         TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,
  role_name       TEXT NOT NULL CHECK (length(role_name) BETWEEN 1 AND 60),
  window_name     TEXT CHECK (window_name IS NULL OR length(window_name) <= 40),
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 300),
  status          TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_by_name TEXT NOT NULL CHECK (length(created_by_name) <= 200),
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX vacancies_org_status ON vacancies (org_id, status);
CREATE INDEX vacancies_role ON vacancies (role_id);
CREATE INDEX org_shadow_players_role ON org_shadow_players (role_id);


-- ----------------------------------------------------------------------------
-- S9b: IMPLEMENTED, migration 0020_scouting_assessments REGISTERED (repositories/scoutingAssessments.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL; scripts/testSchemaDdl.mjs compares them column by column.
-- The migration also inserts the four v1 position templates (GK, DEF, MID, ATT), which used to be pushed into
-- memory when the scouting module registered: every database, production included, has them from its first boot.
-- Sources: domains/scouting/scouting.mjs (templates, assessments, segments, playlists); the readers in rooms,
-- lifecycle, m13, m15, m162, m18, m20 and m21 read through scoutingReads.
-- How the model differs from the first draft of this file:
--   * player_id, media_id, context_trial_id and the trial/Box Cam session ids have NO foreign key: tolerant, like
--     recruitment and S9a. An assessment outlives its player's account (the name is nulled); a trial is never deleted.
--   * org_id is ON DELETE RESTRICT, not CASCADE (organisations are never deleted, O2), on every table.
--   * attributesSnapshot is not stored: a template version never changes, so (template_id, template_version) names
--     its attributes, joined on read. Template attributes keep their order (position); the anchors are five typed
--     columns anchor_1..anchor_5, not anchors_json (the route accepts only the levels 1-5).
--   * No context_extra_json: PUT /org/assessments/:id refuses an unknown context field (400 FIELD_INVALID), and
--     context_date is a YYYY-MM-DD day (400 DATE_INVALID otherwise); minutes watched are a whole number 1-600.
--   * Ratings keep their order (position, unique attr_id) and are whole numbers 1-5 (a half rating is refused);
--     the evidence references are typed columns only, no raw_json (a reference that is not an object, or carries
--     an unknown field, is refused). A cited segment is a RESTRICT key, checked to be the club's and the player's.
--   * The state CHECKs: submitted_at exactly when not a draft, reviewed_at exactly when reviewed, the review note
--     only after review, a recommendation's verdict and reasons together, published feedback whole and never on a
--     draft. 'published' is not a state (domains/verification/passport/m162 used to filter on it; it was never written).
--   * history uses the one entry shape {id, at, byKind, byId, byName, action, detail}, with its position.
--   * video segment labels are a child table (video_segment_labels), not labels_json. drawing_json stays JSON: an
--     overlay object the client draws and the server never reads (at most 4000 characters; no app sends one).
--   * Playlist segments keep their order (position) and are unique per playlist; a segment is RESTRICT there.
--   * Templates remain GLOBAL (KNOWN DEFECT, carried as-is): a lead of any club publishes a version for every club.
--     Deferred until the migration is finished (decisions.md, 4 Nov; known-issues.md).
-- ----------------------------------------------------------------------------
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


-- ----------------------------------------------------------------------------
-- S9d: IMPLEMENTED, migration 0022_opportunities_campaigns REGISTERED (repositories/opportunitiesCampaigns.mjs, 4 Nov 2026).
-- The definitions below are the migration's DDL; scripts/testSchemaDdl.mjs compares them column by column.
-- The opportunity board and its applications, assessment campaigns and their submissions, and players' private
-- suitability preferences. They were the blob collections db.opportunities, db.applications, db.campaigns,
-- db.campaignSubmissions and db.playerPrefs; each name now throws.
-- Sources: domains/scouting/journeys.mjs (F5 opportunities and applications, F6 campaigns), domains/scouting/suitability.mjs
-- (preferences, structured requirements, approved summaries), m12/operations.mjs (the application reminder sweep);
-- readers in m15 (the player's export), m24 / m27 (the agent's view of a client's board), m26 (a transaction's link).
-- How the model differs from the first draft of this file:
--   * No JSON columns. Requirements, environment tags and accommodations are rows of opportunity_texts (kind); drills and
--     the rubric are campaign_drills / campaign_rubric; a file check's issues are codes in campaign_attempt_issues
--     (media_missing | not_video | not_uploaded, decoded to the player-facing messages); the approved suitability summary
--     is application_suitability rows (one per dimension); preference tags are player_pref_texts.
--   * org_id is ON DELETE RESTRICT, not CASCADE (organisations are never deleted, O2). player_id has NO foreign key:
--     tolerant, like recruitment and S9a-c (an application outlives the account, as before). The staff ids
--     (outcome_by_user_id, review_by_user_id) are RESTRICT keys to org_users.
--   * Vocabulary CHECKs: eligibility position group any|GK|DEF|MID|ATT, max level the player levels, org_level the
--     organisation levels, ages 4-99 with min <= max, radius 0-1000 km, capacity >= 1; slot days mon..sun and HH:MM
--     times with start < end. The routes refuse junk (400 FIELD_INVALID) instead of passing it through or coercing it.
--   * An opportunity without structured requirements has structured_declared 0 and no currency; the outcome and the
--     review are present exactly on resolved applications and reviewed attempts (CHECKs).
--   * One live application per opportunity and player (partial unique index), one submission per campaign and player.
--   * A guardian's withdrawal is recorded as the guardian's (the old code audited it as the player's). History uses the
--     one entry shape; application_history is the shared history table.
--   * player_prefs is keyed by player_id (no prf id) and a row exists only once the player or guardian saves: reading
--     preferences no longer writes a row. Still private: no organisation-facing read exists.
-- ----------------------------------------------------------------------------
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


-- ============================================================================
-- not tables:
--   * Code registries: CLAIM_TYPES, EVIDENCE_TIERS, CONFIDENCE, CRITERIA_KEYS, the
--     position-group map (GK/DEF/MID/ATT -> positions), OPP_TYPES, DIMENSIONS
--     (suitability), PRO_STAGES / GRASSROOTS_STAGES, DRILLS (ctx registry).
--   * Derived at read time, never stored: evidence freshness / expired /
--     openDisputes / superseded; the composed passport `legacy[]` and `summary`;
--     affiliation `current`; assessment `attributesSnapshot` (= template version
--     attributes), the assessment-compare averages and observedCount; segment and
--     attempt `mediaUrl`; vacancy candidate verdicts (met / not_met / unknown);
--     squadView coverage / gaps / suggestedLookingFor / onPlatform / trustScore;
--     opportunity `open`, application counts, board `distance` / `applied`;
--     campaign `submissions` / `awaitingReview` / `mySubmission`; suitability
--     verdicts (recomputed from player_prefs + opportunities on every read — only
--     the approved summary on applications is persisted).
--   * In-memory / other files: db.drillGuidance (M12 F6 registry keyed by drillId,
--     05+), db.devObjectives / followUps / outcomeReports / uploadSessions /
--     recruitmentCases (02 / later files), db.vouches and players[].attendance[]
--     (01_identity), trials.day / schedule (02_recruitment), m29 squad snapshot
--     used for signing rollback (transient).
-- ============================================================================
