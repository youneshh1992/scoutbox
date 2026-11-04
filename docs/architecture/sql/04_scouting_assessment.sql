-- ============================================================================
-- 04_scouting_assessment.sql — ScoutBox target relational schema (SQLite, STRICT)
--
-- Scope: M12 F1/F2/F4/F5/F6/F7/F10 collections + M13 F3 playerPrefs + the
-- org-level fields `tactical`, `squad[]`, `lookingFor[]`, `federationCheck`.
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
-- source: db.orgs[].tactical  created at domains/scouting/scouting.mjs:661-675 (POST /org/tactical)
-- owner/writer: domains/scouting/scouting.mjs (lead only); replaced wholesale on every POST
-- lifecycle: one row per org, null until first POST (migrateM12 sets o.tactical ??= null)
-- mapping:
--   formation -> formation (<=20)          planningHorizon -> planning_horizon (<=40)
--   windows[] -> org_tactical_windows      roles[] -> org_tactical_roles (+ criteria)
--   updatedAt -> updated_at                updatedBy -> updated_by_name (a name, not an id)
-- notes: the source replaces the whole object; the migration/ORM must diff
--        roles by id (not delete+insert) or vacancies.role_id would be nulled
--        every time a lead re-saves the formation with the same role ids.
-- ----------------------------------------------------------------------------
CREATE TABLE org_tactical_setups (
  org_id           TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  formation        TEXT NOT NULL,
  planning_horizon TEXT,
  updated_at       INTEGER NOT NULL,
  updated_by_name  TEXT NOT NULL                           -- snapshot
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.orgs[].tactical.roles[]  created at domains/scouting/scouting.mjs:665-673
-- owner/writer: domains/scouting/scouting.mjs
-- mapping:
--   id -> id (role-N minted, OR a client-supplied id: `r.id ?? nextId('role')`)
--   (array position) -> ordinal (new; keeps the ≤15 ordering)
--   name -> name (<=60)   positionGroup -> position_group   description -> description (<=300)
--   category -> category  required[] / preferred[] -> org_tactical_role_criteria
-- notes: ids are globally unique here (id TEXT PRIMARY KEY, as every other
--        preserved id). In practice they are server-minted `role-N`; the `r.id ??`
--        branch exists so a re-POST keeps earlier ids. KNOWN DEFECT: the route
--        never checks that a client-supplied id belongs to this org — the
--        migration re-mints any id that collides with another org's row, and the
--        UNIQUE (org_id, id) index documents the per-org lookup the code performs.
-- ----------------------------------------------------------------------------
CREATE TABLE org_tactical_roles (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  position_group TEXT NOT NULL CHECK (position_group IN ('GK','DEF','MID','ATT')) DEFAULT 'MID',
  description    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL CHECK (category IN ('mens','womens','boys','girls','mixed')) DEFAULT 'mixed'
) STRICT;
CREATE UNIQUE INDEX org_tactical_roles_org_id_id ON org_tactical_roles (org_id, id);  -- new; roles.find(r.id === roleId) within an org

-- ----------------------------------------------------------------------------
-- source: db.orgs[].tactical.roles[].required[] and .preferred[]  (sanitiseCriteria, domains/scouting/scouting.mjs:680)
-- owner/writer: domains/scouting/scouting.mjs
-- mapping: (list name) -> kind ('required' | 'preferred'), (array position) -> ordinal,
--          key -> key (CRITERIA_KEYS only), value -> value_json (number for
--          minAge/maxAge/minAppearances, string otherwise — heterogeneous, kept as JSON)
-- ----------------------------------------------------------------------------
CREATE TABLE org_tactical_role_criteria (
  role_id    TEXT NOT NULL REFERENCES org_tactical_roles(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  ordinal    INTEGER NOT NULL,
  key        TEXT NOT NULL CHECK (key IN ('positionGroup','minAge','maxAge','foot','availability','maxLevel','minAppearances','category')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  PRIMARY KEY (role_id, kind, ordinal)
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.orgs[].tactical.windows[]  created at domains/scouting/scouting.mjs:664 (≤4)
-- owner/writer: domains/scouting/scouting.mjs
-- mapping: (array position) -> ordinal, name -> name (<=40), opens -> opens, closes -> closes
-- notes: opens/closes are stored exactly as sent (`w.opens ?? null`) — never
--        validated, usually a date string; TEXT without a format check (defect).
-- ----------------------------------------------------------------------------
CREATE TABLE org_tactical_windows (
  org_id  TEXT NOT NULL REFERENCES org_tactical_setups(org_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name    TEXT NOT NULL DEFAULT '',
  opens   TEXT,
  closes  TEXT,
  PRIMARY KEY (org_id, ordinal)
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.orgs[].squad[]  created at server.mjs:2797 (manual), domains/scouting/passport.mjs:409
--         (invite_approved), domains/scouting/scouting.mjs:779 (shadow), domains/recruitment/signings/index.mjs:291 (signing)
-- owner/writer: server.mjs (grassroots squad + release), domains/scouting/passport.mjs,
--               domains/scouting/scouting.mjs, domains/recruitment/signings/index.mjs (and m29 snapshot/rollback restores the whole array)
-- lifecycle: hard-deleted on release (server.mjs:2811 filters the array) — no soft-delete field exists
-- mapping (union of the four row shapes):
--   id -> id (sq-N)                        playerId -> player_id (null for off-platform manual entries)
--   name -> name                           position -> position (manual/signing only; '' on signing)
--   source -> source                       roleId -> role_id (shadow only)
--   approvedBy -> approved_by_label (invite_approved only: 'the player' | 'guardian <name>')
--   addedBy -> added_by_name (shadow only) addedAt -> added_at
-- notes:
--   * name is a snapshot of player.name, or personal data about an off-platform
--     person when player_id is null.
--   * Uniqueness as the code enforces it: one non-shadow row per (org, player)
--     and one shadow row per (org, player) — a player can be both current and
--     shadowed. Both partial unique indexes mirror that.
--   * Player deletion today leaves player_id dangling; target SET NULL keeps the
--     row (the club's roster history) without the reference.
-- ----------------------------------------------------------------------------
CREATE TABLE org_squad_members (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id         TEXT REFERENCES players(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,                         -- snapshot / personal data
  position          TEXT,
  source            TEXT NOT NULL CHECK (source IN ('manual','invite_approved','shadow','signing')),
  role_id           TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,  -- shadow only; `req.body?.roleId ?? null` is never validated against the org's roles (defect: migration nulls unknown ids)
  approved_by_label TEXT,
  added_by_name     TEXT,                                  -- snapshot
  added_at          INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX org_squad_members_current_org_player ON org_squad_members (org_id, player_id) WHERE player_id IS NOT NULL AND source <> 'shadow';  -- enforced by code today
CREATE UNIQUE INDEX org_squad_members_shadow_org_player ON org_squad_members (org_id, player_id) WHERE player_id IS NOT NULL AND source = 'shadow';    -- enforced by code today
CREATE INDEX org_squad_members_player_id ON org_squad_members (player_id);  -- "on squad anywhere" checks (m15, m18, m162)

-- ----------------------------------------------------------------------------
-- source: db.orgs[].lookingFor[]  created at server.mjs:2705 (POST /org/looking-for, grassroots only)
-- owner/writer: server.mjs; replaced wholesale (≤5 entries)
-- mapping: (array position) -> ordinal (new), positions[i] -> position
-- notes: values are unvalidated strings (expected position codes such as 'ST');
--        read by the players' opportunity radar (server.mjs:3644-3648).
-- ----------------------------------------------------------------------------
CREATE TABLE org_looking_for (
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ordinal  INTEGER NOT NULL,
  position TEXT NOT NULL,
  PRIMARY KEY (org_id, ordinal)
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.orgs[].federationCheck  created at server.mjs:2913 (POST /org/verification/federation)
-- owner/writer: server.mjs (grassroots only); replaced wholesale on resubmission
-- lifecycle: status is only ever written as 'pending' — no route in the code base
--            moves it on (Trust & Safety verification lands on the org's M14 claims instead).
-- mapping: federation -> federation, registrationId -> registration_id,
--          contactEmail -> contact_email, status -> status, ts -> submitted_at
--          (source field is literally `ts`)
-- notes: contact_email is personal data. One row per org (natural key org_id).
-- ----------------------------------------------------------------------------
CREATE TABLE org_federation_checks (
  org_id          TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  federation      TEXT NOT NULL,
  registration_id TEXT NOT NULL,
  contact_email   TEXT,                                    -- personal data
  status          TEXT NOT NULL CHECK (status IN ('pending')) DEFAULT 'pending',
  submitted_at    INTEGER NOT NULL
) STRICT;


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
--     draft. 'published' is not a state (m15/m162 used to filter on it; it was never written).
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
-- source: db.vacancies  created at domains/scouting/scouting.mjs:689
-- owner/writer: domains/scouting/scouting.mjs (also read by domains/recruitment/rooms/rooms.mjs:555 and recruitment_cases.vacancy_id in 02)
-- lifecycle: status open -> closed (closed_at); never deleted
-- mapping: id -> id (vac-N), orgId -> org_id, roleId -> role_id, roleName -> role_name,
--          window -> window (unvalidated, stored as sent), notes -> notes (<=300),
--          status -> status, createdBy -> created_by_name (a name, not an id),
--          createdAt -> created_at, closedAt -> closed_at
-- notes: the source tolerates a vanished role (409 ROLE_DELETED on candidates)
--        → ON DELETE SET NULL; role_name keeps the label. "role belongs to the
--        same org" is checked by the route (scouting.mjs:687), not by the schema.
-- ----------------------------------------------------------------------------
CREATE TABLE vacancies (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role_id         TEXT REFERENCES org_tactical_roles(id) ON DELETE SET NULL,
  role_name       TEXT NOT NULL,                           -- snapshot
  window          TEXT,
  notes           TEXT,
  status          TEXT NOT NULL CHECK (status IN ('open','closed')) DEFAULT 'open',
  created_by_name TEXT NOT NULL,                           -- snapshot
  created_at      INTEGER NOT NULL,
  closed_at       INTEGER
) STRICT;
CREATE INDEX vacancies_org_id_status ON vacancies (org_id, status);  -- org list; squad planner (open only)


-- ----------------------------------------------------------------------------
-- source: db.opportunities  created at domains/scouting/journeys.mjs:30-51; `structured` added by
--         domains/scouting/suitability.mjs:92-103 (PUT /org/opportunities/:id/structured-requirements)
-- owner/writer: domains/scouting/journeys.mjs (create/close), domains/scouting/suitability.mjs (structured block, replaced wholesale)
-- lifecycle: status published -> closed (closed_at); "open" is derived (published AND deadline >= today)
-- mapping:
--   id -> id (opp-N)          orgId -> org_id         orgName -> org_name
--   orgLevel -> org_level (snapshot of org.level at creation, default 'pro'; the value
--     set of org.level belongs to 01_identity — no CHECK here)
--   type -> type              title -> title (<=120)  team -> team (<=60)
--   category -> category      ageGroup -> age_group (<=20)   role -> role (<=60)
--   description -> description (<=500)   schedule -> schedule (<=200, free text)
--   deadline -> deadline_date   capacity -> capacity
--   eligibility.minAge/maxAge -> elig_min_age / elig_max_age
--   eligibility.positionGroup -> elig_position_group (passthrough `?? 'any'`, unvalidated; no CHECK)
--   eligibility.category -> elig_category
--   eligibility.maxLevel -> elig_max_level ('semi_pro' forced for grassroots, else passthrough; no CHECK)
--   eligibility.radiusKm -> elig_radius_km (50 forced for grassroots)
--   requirements[] -> requirements_json (≤6 free-text lines ≤120, display only — free-form by design)
--   status -> status          createdBy -> created_by_name   createdAt -> created_at   closedAt -> closed_at
--   structured (null until PUT) -> structured_declared (1 once PUT ran; verdictsFor
--     distinguishes "no structured block" from "block with no fee")
--   structured.trainingSlots[] -> opportunity_training_slots
--   structured.relocationRequired -> relocation_required
--   structured.feeMinor -> fee_minor      structured.currency -> currency
--   structured.expensesCovered -> expenses_covered
--   structured.environment[] -> environment_json (≤8 tags ≤40; matched by equality at read — free-form tags)
--   structured.accommodations[] -> accommodations_json (≤8 free-text ≤80; matched by substring at read — free-form)
--   derived, not stored: open, applications/outstanding counts, distance, applied
-- ----------------------------------------------------------------------------
CREATE TABLE opportunities (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name            TEXT NOT NULL,                       -- snapshot
  org_level           TEXT NOT NULL,                       -- snapshot
  type                TEXT NOT NULL CHECK (type IN ('trial','open_day','programme','role')),
  title               TEXT NOT NULL,
  team                TEXT,
  category            TEXT NOT NULL CHECK (category IN ('mens','womens','boys','girls','mixed')) DEFAULT 'mixed',
  age_group           TEXT,
  role                TEXT,
  description         TEXT,
  schedule            TEXT,
  deadline_date       TEXT NOT NULL CHECK (length(deadline_date) = 10),
  capacity            INTEGER,
  elig_min_age        INTEGER,
  elig_max_age        INTEGER,
  elig_position_group TEXT NOT NULL DEFAULT 'any',
  elig_category       TEXT NOT NULL CHECK (elig_category IN ('mens','womens','boys','girls','mixed')) DEFAULT 'mixed',
  elig_max_level      TEXT,
  elig_radius_km      REAL,
  requirements_json   TEXT NOT NULL CHECK (json_valid(requirements_json)) DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('published','closed')) DEFAULT 'published',
  created_by_name     TEXT NOT NULL,                       -- snapshot
  created_at          INTEGER NOT NULL,
  closed_at           INTEGER,
  structured_declared INTEGER NOT NULL CHECK (structured_declared IN (0,1)) DEFAULT 0,
  relocation_required INTEGER NOT NULL CHECK (relocation_required IN (0,1)) DEFAULT 0,
  fee_minor           INTEGER,
  currency            TEXT CHECK (length(currency) = 3 OR currency IS NULL),
  expenses_covered    INTEGER NOT NULL CHECK (expenses_covered IN (0,1)) DEFAULT 0,
  environment_json    TEXT NOT NULL CHECK (json_valid(environment_json)) DEFAULT '[]',
  accommodations_json TEXT NOT NULL CHECK (json_valid(accommodations_json)) DEFAULT '[]'
) STRICT;
CREATE INDEX opportunities_org_id ON opportunities (org_id);                        -- org list
CREATE INDEX opportunities_status_deadline_date ON opportunities (status, deadline_date);  -- board: published AND deadline >= today

-- ----------------------------------------------------------------------------
-- source: db.opportunities[].structured.trainingSlots[]  (≤10; domains/scouting/suitability.mjs:93-96)
-- owner/writer: domains/scouting/suitability.mjs; replaced wholesale with the structured block
-- mapping: (array position) -> ordinal (new), day -> day (3-letter lowercase),
--          start -> start_time ('HH:MM'), end -> end_time ('HH:MM'), tz -> tz (<=40)
-- notes: values are sliced, not validated (day may be '' or junk) — no CHECK beyond length.
-- ----------------------------------------------------------------------------
CREATE TABLE opportunity_training_slots (
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL,
  day            TEXT NOT NULL CHECK (length(day) <= 3),
  start_time     TEXT NOT NULL CHECK (length(start_time) <= 5),
  end_time       TEXT NOT NULL CHECK (length(end_time) <= 5),
  tz             TEXT NOT NULL DEFAULT 'Europe/London',
  PRIMARY KEY (opportunity_id, ordinal)
) STRICT;


-- ----------------------------------------------------------------------------
-- source: db.applications  created at domains/scouting/journeys.mjs:103-107 (applyTo)
-- owner/writer: domains/scouting/journeys.mjs (apply / withdraw / outcome), m12/operations.mjs:315
--               (remindedAt sweep), domains/scouting/suitability.mjs:213-221 (suitabilitySummary)
-- lifecycle: status submitted -> withdrawn | accepted | declined; never deleted
-- mapping:
--   id -> id (apl-N)              opportunityId -> opportunity_id   orgId -> org_id
--   playerId -> player_id         playerName -> player_name
--   submittedBy.kind/id/name -> submitted_by_kind / submitted_by_id / submitted_by_name
--   note -> note (<=300)          status -> status
--   outcome.decision -> outcome_decision   outcome.note -> outcome_note (<=300)
--   outcome.byUserId -> outcome_by_user_id   outcome.byName -> outcome_by_name   outcome.at -> outcome_at
--   createdAt -> created_at       remindedAt -> reminded_at (7-day nag marker, operations.mjs:315)
--   suitabilitySummary.approvedAt -> suitability_approved_at
--   suitabilitySummary.approvedBy -> suitability_approved_by ('player' | 'guardian')
--   suitabilitySummary.verdicts[] -> suitability_verdicts_json ([{dimension, verdict}] over the
--     six fixed DIMENSIONS; written and cleared wholesale, read only as a whole by the org —
--     kept as JSON rather than a six-row child table; normalise if ever filtered on)
--   history[] -> applications_history
-- notes:
--   * Uniqueness: one non-withdrawn application per (opportunity, player) —
--     enforced by code today (journeys.mjs:95); partial unique index makes it structural.
--   * submitted_by_id is players.id or guardians.id by submitted_by_kind (no FK).
--   * Minors never self-submit; the guardian is the submitter.
--   * player_id RESTRICT: the club's record outlives the subject; the source
--     today leaves player_name in place after deletion (defect — should be nulled).
-- ----------------------------------------------------------------------------
CREATE TABLE applications (
  id                        TEXT PRIMARY KEY,
  opportunity_id            TEXT NOT NULL REFERENCES opportunities(id) ON DELETE RESTRICT,
  org_id                    TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id                 TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name               TEXT,                          -- snapshot
  submitted_by_kind         TEXT NOT NULL CHECK (submitted_by_kind IN ('player','guardian')),
  submitted_by_id           TEXT NOT NULL,                 -- players.id | guardians.id
  submitted_by_name         TEXT NOT NULL,                 -- snapshot
  note                      TEXT,
  status                    TEXT NOT NULL CHECK (status IN ('submitted','withdrawn','accepted','declined')) DEFAULT 'submitted',
  outcome_decision          TEXT CHECK (outcome_decision IN ('accepted','declined') OR outcome_decision IS NULL),
  outcome_note              TEXT,
  outcome_by_user_id        TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  outcome_by_name           TEXT,                          -- snapshot
  outcome_at                INTEGER,
  created_at                INTEGER NOT NULL,
  reminded_at               INTEGER,
  suitability_approved_at   INTEGER,
  suitability_approved_by   TEXT CHECK (suitability_approved_by IN ('player','guardian') OR suitability_approved_by IS NULL),
  suitability_verdicts_json TEXT CHECK (json_valid(suitability_verdicts_json) OR suitability_verdicts_json IS NULL)
) STRICT;
CREATE UNIQUE INDEX applications_live_opportunity_player ON applications (opportunity_id, player_id) WHERE status <> 'withdrawn';  -- enforced by code today
CREATE INDEX applications_opportunity_id_status ON applications (opportunity_id, status);  -- counts, capacity, close gate, org list
CREATE INDEX applications_player_id ON applications (player_id);                           -- player/guardian lists; m15 export
CREATE INDEX applications_status_created_at ON applications (status, created_at);          -- reminder sweep (submitted older than 7 days)

-- ----------------------------------------------------------------------------
-- source: db.applications[].history[]  via audit() (m12/shared.mjs:72); append-only
-- owner/writer: domains/scouting/journeys.mjs
-- mapping: id -> id (aud-N), at -> at, byKind -> by_kind, byId -> by_id, byName -> by_name,
--          action -> action (submitted | withdrawn | accepted | declined), detail -> detail_json
-- notes: known defect — a guardian withdrawal is audited with byKind 'player'
--        (journeys.mjs:147); by_id is then the guardian's id. Carried as-is.
-- ----------------------------------------------------------------------------
CREATE TABLE applications_history (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  at             INTEGER NOT NULL,
  by_kind        TEXT CHECK (by_kind IN ('player','guardian','org') OR by_kind IS NULL),
  by_id          TEXT,
  by_name        TEXT,
  action         TEXT NOT NULL,
  detail_json    TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX applications_history_application_id ON applications_history (application_id);


-- ----------------------------------------------------------------------------
-- source: db.campaigns  created at domains/scouting/journeys.mjs:230-254
-- owner/writer: domains/scouting/journeys.mjs
-- lifecycle: status is only ever 'published' — there is no close route; "open" is
--            derived (published AND deadline >= today). Never deleted.
-- mapping:
--   id -> id (cmp-N)      orgId -> org_id      orgName -> org_name     title -> title (<=120)
--   drills[] -> drills_json (≤6 of {name, instructions, recording{equipment,distance,surface,camera}};
--     a fixed definition captured at creation, never edited, never filtered on, and read
--     only whole (review queue, drills[0].name default) — kept as JSON)
--   deadline -> deadline_date       attemptsAllowed -> attempts_allowed (1..5)
--   eligibility.minAge/maxAge -> elig_min_age / elig_max_age
--   eligibility.positionGroup -> elig_position_group (passthrough, unvalidated)
--   eligibility.maxLevel -> elig_max_level ('semi_pro' forced for grassroots)
--   eligibility.radiusKm -> elig_radius_km (50 forced for grassroots)
--   (no eligibility.category on campaigns — unlike opportunities)
--   rubric[] -> rubric_json (≤8 of {criterion, guidance}; same justification as drills)
--   status -> status      createdBy -> created_by_name    createdAt -> created_at
--   derived, not stored: submissions / awaitingReview counts, mySubmission
-- ----------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name            TEXT NOT NULL,                       -- snapshot
  title               TEXT NOT NULL,
  drills_json         TEXT NOT NULL CHECK (json_valid(drills_json)),
  deadline_date       TEXT NOT NULL CHECK (length(deadline_date) = 10),
  attempts_allowed    INTEGER NOT NULL CHECK (attempts_allowed BETWEEN 1 AND 5) DEFAULT 2,
  elig_min_age        INTEGER,
  elig_max_age        INTEGER,
  elig_position_group TEXT NOT NULL DEFAULT 'any',
  elig_max_level      TEXT,
  elig_radius_km      REAL,
  rubric_json         TEXT NOT NULL CHECK (json_valid(rubric_json)) DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('published')) DEFAULT 'published',
  created_by_name     TEXT NOT NULL,                       -- snapshot
  created_at          INTEGER NOT NULL
) STRICT;
CREATE INDEX campaigns_org_id ON campaigns (org_id);                              -- org list
CREATE INDEX campaigns_status_deadline_date ON campaigns (status, deadline_date);  -- player/guardian open campaigns

-- ----------------------------------------------------------------------------
-- source: db.campaignSubmissions  created at domains/scouting/journeys.mjs:314
-- owner/writer: domains/scouting/journeys.mjs (one row per campaign+player, created on first attempt)
-- lifecycle: none on the row; attempts carry the states
-- mapping: id -> id (csb-N), campaignId -> campaign_id, orgId -> org_id, playerId -> player_id,
--          playerName -> player_name, submittedBy.kind/id/name -> submitted_by_kind /
--          submitted_by_id / submitted_by_name (the FIRST submitter; later attempts may come
--          from the other actor and are not recorded on the row — carried as-is),
--          attempts[] -> campaign_submission_attempts, createdAt -> created_at
-- notes: unique (campaign_id, player_id) enforced by code today (find-or-create).
--        player_id RESTRICT: the club's review record outlives the subject.
-- ----------------------------------------------------------------------------
CREATE TABLE campaign_submissions (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name       TEXT,                                  -- snapshot
  submitted_by_kind TEXT NOT NULL CHECK (submitted_by_kind IN ('player','guardian')),
  submitted_by_id   TEXT NOT NULL,                         -- players.id | guardians.id
  submitted_by_name TEXT NOT NULL,                         -- snapshot
  created_at        INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX campaign_submissions_campaign_id_player_id ON campaign_submissions (campaign_id, player_id);  -- enforced by code today
CREATE INDEX campaign_submissions_player_id ON campaign_submissions (player_id);

-- ----------------------------------------------------------------------------
-- source: db.campaignSubmissions[].attempts[]  created at domains/scouting/journeys.mjs:324-332
-- owner/writer: domains/scouting/journeys.mjs (submit; org review)
-- lifecycle: status failed_checks (terminal) | submitted -> accepted | returned
-- mapping:
--   id -> id (att-N; prefix shared with players[].attendance[] — still globally unique)
--   mediaId -> media_id (as sent; may be null or name a media the file check already
--     flagged as missing — so NO FK, by design the failed attempt keeps the bad id)
--   drillName -> drill_name (<=80; defaults to drills[0].name)   note -> note (<=300)
--   fileChecks.passed -> file_checks_passed      fileChecks.issues[] -> file_check_issues_json
--     (machine-generated message strings, display only — free-form)
--   fileChecks.checkedAt -> file_checked_at      fileChecks.kind -> file_check_kind
--   status -> status
--   review.byUserId/byName/at -> review_by_user_id / review_by_name / reviewed_at
--   review.kind -> review_kind   review.reasons -> review_reasons (<=400)
--   review.rubricNotes -> review_rubric_notes (<=400)
--   submittedAt -> submitted_at
--   derived, not stored: mediaUrl
-- notes: the "machine checks files, a human checks football" split is the two
--        column groups; an attempt is never 'verified'.
-- ----------------------------------------------------------------------------
CREATE TABLE campaign_submission_attempts (
  id                     TEXT PRIMARY KEY,
  submission_id          TEXT NOT NULL REFERENCES campaign_submissions(id) ON DELETE CASCADE,
  media_id               TEXT,                             -- player_media.id as sent; no FK (see header)
  drill_name             TEXT,
  note                   TEXT,
  file_checks_passed     INTEGER NOT NULL CHECK (file_checks_passed IN (0,1)) DEFAULT 0,
  file_check_issues_json TEXT NOT NULL CHECK (json_valid(file_check_issues_json)) DEFAULT '[]',
  file_checked_at        INTEGER NOT NULL,
  file_check_kind        TEXT NOT NULL CHECK (file_check_kind IN ('automated_file_check')) DEFAULT 'automated_file_check',
  status                 TEXT NOT NULL CHECK (status IN ('submitted','failed_checks','accepted','returned')),
  review_by_user_id      TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  review_by_name         TEXT,                             -- snapshot
  reviewed_at            INTEGER,
  review_kind            TEXT CHECK (review_kind IN ('human_review') OR review_kind IS NULL),
  review_reasons         TEXT,
  review_rubric_notes    TEXT,
  submitted_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX campaign_submission_attempts_submission_id_status ON campaign_submission_attempts (submission_id, status);  -- attempt counting, review queue, awaitingReview


-- ----------------------------------------------------------------------------
-- source: db.playerPrefs  created at domains/scouting/suitability.mjs:15-25 (blankPrefs) — created on GET (prefsFor)
-- owner/writer: domains/scouting/suitability.mjs (adult player, or guardian for a minor)
-- lifecycle: one row per player; updated in place; never deleted
-- mapping:
--   id -> id (prf-N)                 playerId -> player_id (UNIQUE)
--   commitments[] -> player_pref_slots (kind 'commitment')
--   availableSlots[] -> player_pref_slots (kind 'available')
--   travelLimitKm -> travel_limit_km (0..500)    transport -> transport
--   relocation -> relocation (ADULTS ONLY: the guardian path forces null)
--   ambitions -> ambitions (<=300)
--   environment[] -> environment_json (≤8 tags ≤40, matched by equality at read — free-form tags)
--   accessibility[] -> accessibility_json (≤8 free-text ≤80 needs, substring-matched at read — free-form)
--   compensation.maxFeeMinor -> max_fee_minor    compensation.currency -> currency
--   compensation.expensesNeeded -> expenses_needed
--   updatedAt -> updated_at (null until the first PUT)
-- notes:
--   * PRIVATE to the player/guardian: clubs never read this table; only the
--     approved verdict summary on applications leaves it.
--   * accessibility_json is sensitive (health-adjacent needs) — treat as special
--     category data for retention/export purposes.
--   * Writes on GET: a row is minted (and persisted) by a plain GET.
-- ----------------------------------------------------------------------------
CREATE TABLE player_prefs (
  id                 TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  travel_limit_km    REAL CHECK (travel_limit_km BETWEEN 0 AND 500 OR travel_limit_km IS NULL),
  transport          TEXT CHECK (transport IN ('own','public','lift_needed') OR transport IS NULL),
  relocation         TEXT CHECK (relocation IN ('yes','no','discuss') OR relocation IS NULL),
  ambitions          TEXT,
  environment_json   TEXT NOT NULL CHECK (json_valid(environment_json)) DEFAULT '[]',
  accessibility_json TEXT NOT NULL CHECK (json_valid(accessibility_json)) DEFAULT '[]',  -- sensitive
  max_fee_minor      INTEGER,
  currency           TEXT NOT NULL CHECK (length(currency) = 3) DEFAULT 'GBP',
  expenses_needed    INTEGER NOT NULL CHECK (expenses_needed IN (0,1)) DEFAULT 0,
  updated_at         INTEGER
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.playerPrefs[].commitments[] and .availableSlots[]  (≤20 each; domains/scouting/suitability.mjs:34-40)
-- owner/writer: domains/scouting/suitability.mjs; each list replaced wholesale
-- mapping: (list name) -> kind, (array position) -> ordinal (new), day -> day (3-letter lowercase),
--          start -> start_time ('HH:MM'), end -> end_time ('HH:MM'), tz -> tz (<=40),
--          label -> label (<=60; e.g. "school", "work" — personal data)
-- ----------------------------------------------------------------------------
CREATE TABLE player_pref_slots (
  pref_id    TEXT NOT NULL REFERENCES player_prefs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('commitment','available')),
  ordinal    INTEGER NOT NULL,
  day        TEXT NOT NULL CHECK (length(day) <= 3),
  start_time TEXT NOT NULL CHECK (length(start_time) <= 5),
  end_time   TEXT NOT NULL CHECK (length(end_time) <= 5),
  tz         TEXT NOT NULL DEFAULT 'Europe/London',
  label      TEXT,                                         -- personal data
  PRIMARY KEY (pref_id, kind, ordinal)
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
