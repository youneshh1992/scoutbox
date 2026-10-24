-- ============================================================================
-- 04_scouting_assessment.sql — ScoutBox target relational schema (SQLite, STRICT)
--
-- Scope: M12 F1/F2/F4/F5/F6/F7/F10 collections + M13 F3 playerPrefs + the
-- org-level fields `tactical`, `squad[]`, `lookingFor[]`, `federationCheck`.
-- Sources: scoutbox-server/m12/passport.mjs, m12/scouting.mjs, m12/journeys.mjs,
-- m12/shared.mjs (migrateM12), m13/suitability.mjs, m13/shared.mjs (migrateM13),
-- server.mjs (looking-for, squad, verification/federation), m29/index.mjs (squad
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
-- source: db.evidence  created at m12/passport.mjs:43-74 (newEvidence)
-- owner/writer: m12/passport.mjs (player, guardian, org, admin routes)
-- lifecycle: no status field; `superseded_by_id` set on correction (row kept),
--            `expires_at` only for claimType 'availability' (recorded_at + 90d).
-- mapping:
--   id -> id (evd-N)                      playerId -> player_id
--   claimType -> claim_type               label -> label (<=120)
--   value -> value_json (untyped scalar/object from the request body; kept as JSON
--            because the source never types it — free-form by design)
--   units -> units (<=20)                 season -> season (<=20)
--   source.kind/id/name -> source_kind / source_id / source_name
--   observedAt -> observed_at             recordedAt -> recorded_at
--   mediaIds[] -> evidence_media          verification.status -> verification_status
--   verification.method -> verification_method (<=80 free text)
--   verification.reviewerId -> reviewer_id   verification.reviewerName -> reviewer_name
--   verification.reviewedAt -> reviewed_at   expiresAt -> expires_at
--   correctionOf -> correction_of_id      supersededBy -> superseded_by_id
--   disputes[] -> evidence_disputes       note -> note (<=300)
--   history[] -> evidence_history
--   derived, not stored: freshness (from recorded_at), expired (expires_at < now),
--     openDisputes (count), superseded (superseded_by_id IS NOT NULL)
-- notes:
--   * source_kind: the code writes 'player' | 'guardian' | 'org'. The comment at
--     passport.mjs:51 lists 'coach' but no route can produce it — unreachable,
--     excluded from the CHECK. source_id is polymorphic: players.id, guardians.id
--     or orgs.id depending on source_kind (no FK).
--   * verification_status: the code writes self_reported | coach_confirmed |
--     club_assessed. 'independent' exists in EVIDENCE_TIERS (m12/shared.mjs:83)
--     and is read by m18/secondLook.mjs:59 but no route sets it — excluded.
--   * reviewer_id is org_users.id, or the literal 'admin' after a dispute
--     downgrade (passport.mjs:300) — no FK.
--   * Minor data: evidence is written by or about under-18s; org reads are gated
--     by orgCanSee at read time (tenant wall is evaluated live, not stored).
--   * Today evidence survives account deletion (defect: deletePlayerData does not
--     touch db.evidence). Target: player-owned → ON DELETE CASCADE.
-- ----------------------------------------------------------------------------
CREATE TABLE evidence (
  id                  TEXT PRIMARY KEY,
  player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  claim_type          TEXT NOT NULL CHECK (claim_type IN ('statistic','attendance','assessment_result','reference','footage','availability')),
  label               TEXT NOT NULL,
  value_json          TEXT CHECK (json_valid(value_json) OR value_json IS NULL),
  units               TEXT,
  season              TEXT,
  source_kind         TEXT NOT NULL CHECK (source_kind IN ('player','guardian','org')),
  source_id           TEXT NOT NULL,                       -- players.id | guardians.id | orgs.id (by source_kind)
  source_name         TEXT NOT NULL,                       -- snapshot
  observed_at         INTEGER,
  recorded_at         INTEGER NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('self_reported','coach_confirmed','club_assessed')),
  verification_method TEXT,
  reviewer_id         TEXT,                                -- org_users.id or 'admin'; no FK
  reviewer_name       TEXT,                                -- snapshot
  reviewed_at         INTEGER,
  expires_at          INTEGER,
  correction_of_id    TEXT REFERENCES evidence(id) ON DELETE RESTRICT,
  superseded_by_id    TEXT REFERENCES evidence(id) ON DELETE SET NULL,
  note                TEXT
) STRICT;
CREATE INDEX evidence_player_id_claim_type ON evidence (player_id, claim_type);  -- passport by player; minAppearances by player+claim_type (scouting.mjs:730)
CREATE INDEX evidence_superseded_by_id ON evidence (superseded_by_id);           -- m18/secondLook.mjs:64 follows the chain

-- ----------------------------------------------------------------------------
-- source: db.evidence[].mediaIds[]  created at m12/passport.mjs:56
-- owner/writer: m12/passport.mjs (set at creation; copied on correction; never edited)
-- lifecycle: none (rows live with the evidence row)
-- mapping: mediaIds[i] -> (evidence_id, media_id); natural composite PRIMARY KEY
-- notes: the code only keeps ids present in player.media at creation time.
--        Media deletion today leaves the id dangling; target cascades.
-- ----------------------------------------------------------------------------
CREATE TABLE evidence_media (
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  media_id    TEXT NOT NULL REFERENCES player_media(id) ON DELETE CASCADE,
  PRIMARY KEY (evidence_id, media_id)
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.evidence[].disputes[]  created at m12/passport.mjs:207 (fileDispute)
-- owner/writer: m12/passport.mjs (player/org file; admin resolves)
-- lifecycle: status open -> resolved (never deleted)
-- mapping:
--   id -> id (dsp-N; prefix shared with m13 dispatches — ids are still globally unique)
--   at -> filed_at                        by.kind/id/name -> by_kind / by_id / by_name
--   reason -> reason (<=300)              status -> status
--   resolution.outcome -> resolution_outcome   resolution.note -> resolution_note (<=300)
--   resolution.at -> resolved_at
--   (evidenceId, playerId, label, tier on the admin list are joined, not stored)
-- notes: by_id is players.id or orgs.id (polymorphic, no FK); by_name for org
--        disputes is "<user name> · <org name>" (passport.mjs:278).
-- ----------------------------------------------------------------------------
CREATE TABLE evidence_disputes (
  id                 TEXT PRIMARY KEY,
  evidence_id        TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  filed_at           INTEGER NOT NULL,
  by_kind            TEXT NOT NULL CHECK (by_kind IN ('player','org')),
  by_id              TEXT NOT NULL,                       -- players.id | orgs.id
  by_name            TEXT NOT NULL,                       -- snapshot
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open','resolved')) DEFAULT 'open',
  resolution_outcome TEXT CHECK (resolution_outcome IN ('upheld','rejected') OR resolution_outcome IS NULL),
  resolution_note    TEXT,
  resolved_at        INTEGER
) STRICT;
CREATE INDEX evidence_disputes_evidence_id ON evidence_disputes (evidence_id);
CREATE INDEX evidence_disputes_status_filed_at ON evidence_disputes (status, filed_at);  -- admin queue (passport.mjs:282)

-- ----------------------------------------------------------------------------
-- source: db.evidence[].history[]  created at m12/shared.mjs:72 (audit)
-- owner/writer: m12/passport.mjs via audit(); append-only
-- mapping: id -> id (aud-N), at -> at, byKind -> by_kind, byId -> by_id,
--          byName -> by_name, action -> action, detail -> detail_json (JSON-encoded string)
-- notes: by_id is inconsistent in the source (player id, guardian id, org id or
--        the literal 'admin'); actions written: created, superseded,
--        created_as_correction, disputed, corroborated, dispute_resolved.
--        Audit rows: ON DELETE RESTRICT so they outlive nothing silently.
-- ----------------------------------------------------------------------------
CREATE TABLE evidence_history (
  id          TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE RESTRICT,
  at          INTEGER NOT NULL,
  by_kind     TEXT CHECK (by_kind IN ('player','guardian','org','admin') OR by_kind IS NULL),
  by_id       TEXT,
  by_name     TEXT,
  action      TEXT NOT NULL,
  detail_json TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX evidence_history_evidence_id ON evidence_history (evidence_id);


-- ----------------------------------------------------------------------------
-- source: db.coachAffiliations  created at m12/passport.mjs:328-340
-- owner/writer: m12/passport.mjs (org creates/ends/revokes; admin lists)
-- lifecycle: status confirmed -> ended | revoked (to_date set); never deleted
-- mapping:
--   id -> id (aff-N)                      orgId -> org_id        orgName -> org_name
--   coachName -> coach_name (<=80)        coachEmail -> coach_email (<=120)
--   role -> role (<=60)                   from -> from_date      to -> to_date
--   status -> status
--   confirmedBy.userId -> confirmed_by_user_id   confirmedBy.name -> confirmed_by_name
--   conflictOfInterest -> conflict_of_interest (<=200)
--   createdAt -> created_at               history[] -> coach_affiliations_history
--   derived, not stored: current (status = 'confirmed')
-- notes:
--   * Known defect: identity is name-matched — activeAffiliation() (m12/shared.mjs:90)
--     compares lower(coach_name) to the org user's display name. There is no
--     org_users FK for the coach because the source has none.
--   * coach_name / coach_email are personal data about a possibly off-platform person.
--   * from_date is whatever the client sent sliced to 10 chars (unvalidated); the
--     length check documents the intended format.
-- ----------------------------------------------------------------------------
CREATE TABLE coach_affiliations (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name              TEXT NOT NULL,                     -- snapshot
  coach_name            TEXT NOT NULL,                     -- personal data
  coach_email           TEXT,                              -- personal data
  role                  TEXT NOT NULL,
  from_date             TEXT NOT NULL CHECK (length(from_date) = 10),
  to_date               TEXT CHECK (length(to_date) = 10 OR to_date IS NULL),
  status                TEXT NOT NULL CHECK (status IN ('confirmed','ended','revoked')) DEFAULT 'confirmed',
  confirmed_by_user_id  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  confirmed_by_name     TEXT NOT NULL,                     -- snapshot
  conflict_of_interest  TEXT,
  created_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX coach_affiliations_org_id_status_coach_name ON coach_affiliations (org_id, status, coach_name);  -- org list; activeAffiliation lookup
CREATE INDEX coach_affiliations_created_at ON coach_affiliations (created_at);  -- admin list sorted newest first

-- ----------------------------------------------------------------------------
-- source: db.coachAffiliations[].history[]  created via audit() (m12/shared.mjs:72)
-- owner/writer: m12/passport.mjs; append-only
-- mapping: id -> id (aud-N), at -> at, byKind -> by_kind ('org'), byId -> by_id (orgs.id),
--          byName -> by_name (the acting user's name), action -> action
--          (confirmed | ended | revoked), detail -> detail_json (role or reason)
-- ----------------------------------------------------------------------------
CREATE TABLE coach_affiliations_history (
  id                   TEXT PRIMARY KEY,
  coach_affiliation_id TEXT NOT NULL REFERENCES coach_affiliations(id) ON DELETE RESTRICT,
  at                   INTEGER NOT NULL,
  by_kind              TEXT CHECK (by_kind IN ('org') OR by_kind IS NULL),
  by_id                TEXT,
  by_name              TEXT,
  action               TEXT NOT NULL,
  detail_json          TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX coach_affiliations_history_coach_affiliation_id ON coach_affiliations_history (coach_affiliation_id);


-- ----------------------------------------------------------------------------
-- source: db.squadInvites  created at m12/passport.mjs:388-394
-- owner/writer: m12/passport.mjs (org invites; player or guardian responds)
-- lifecycle: pending_guardian | pending_player -> approved | declined; never deleted
-- mapping:
--   id -> id (sqi-N)        orgId -> org_id         orgName -> org_name
--   playerId -> player_id   playerName -> player_name
--   byUserId -> by_user_id  byName -> by_name       note -> note (<=200)
--   status -> status        createdAt -> created_at   respondedAt -> responded_at
-- notes:
--   * Uniqueness: at most one pending invite per (org, player) — enforced by code
--     today (passport.mjs:384); the partial unique index makes it structural.
--   * Minor routing: a minor's invite goes to the guardian (pending_guardian).
--   * Player-owned (consent record addressed to the player/guardian): cascades.
-- ----------------------------------------------------------------------------
CREATE TABLE squad_invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_name     TEXT NOT NULL,                              -- snapshot
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_name  TEXT NOT NULL,                              -- snapshot
  by_user_id   TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name      TEXT NOT NULL,                              -- snapshot
  note         TEXT,
  status       TEXT NOT NULL CHECK (status IN ('pending_guardian','pending_player','approved','declined')),
  created_at   INTEGER NOT NULL,
  responded_at INTEGER
) STRICT;
CREATE UNIQUE INDEX squad_invites_pending_org_player ON squad_invites (org_id, player_id) WHERE status IN ('pending_guardian','pending_player');  -- enforced by code today
CREATE INDEX squad_invites_player_id_status ON squad_invites (player_id, status);  -- player/guardian pending lists


-- ----------------------------------------------------------------------------
-- source: db.orgs[].tactical  created at m12/scouting.mjs:661-675 (POST /org/tactical)
-- owner/writer: m12/scouting.mjs (lead only); replaced wholesale on every POST
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
-- source: db.orgs[].tactical.roles[]  created at m12/scouting.mjs:665-673
-- owner/writer: m12/scouting.mjs
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
-- source: db.orgs[].tactical.roles[].required[] and .preferred[]  (sanitiseCriteria, m12/scouting.mjs:680)
-- owner/writer: m12/scouting.mjs
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
-- source: db.orgs[].tactical.windows[]  created at m12/scouting.mjs:664 (≤4)
-- owner/writer: m12/scouting.mjs
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
-- source: db.orgs[].squad[]  created at server.mjs:2797 (manual), m12/passport.mjs:409
--         (invite_approved), m12/scouting.mjs:779 (shadow), m29/index.mjs:291 (signing)
-- owner/writer: server.mjs (grassroots squad + release), m12/passport.mjs,
--               m12/scouting.mjs, m29/index.mjs (and m29 snapshot/rollback restores the whole array)
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
-- source: db.assessmentTemplates  created at m12/scouting.mjs:28-58 (seed v1) and :76-81 (new version)
-- owner/writer: m12/scouting.mjs (any org lead publishes a new version)
-- lifecycle: append-only; versions are immutable (nothing mutates a pushed template)
-- mapping:
--   id -> id ('tpl-gk' | 'tpl-def' | 'tpl-mid' | 'tpl-att' — reused across versions)
--   positionGroup -> position_group   version -> version
--   createdAt -> created_at           createdBy -> created_by_name ('seed' or the lead's name)
--   attributes[] -> assessment_template_attributes
-- notes:
--   * Composite PRIMARY KEY (id, version) — the survey's "template id lookups
--     return v1" defect is exactly the id reuse this key documents.
--   * GLOBAL: no org_id in the source — a lead of any org publishes a version
--     for every org (tenant defect, carried as-is).
-- ----------------------------------------------------------------------------
CREATE TABLE assessment_templates (
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1),
  position_group  TEXT NOT NULL CHECK (position_group IN ('GK','DEF','MID','ATT')),
  created_at      INTEGER NOT NULL,
  created_by_name TEXT NOT NULL,                           -- snapshot ('seed' for v1)
  PRIMARY KEY (id, version)
) STRICT;
CREATE UNIQUE INDEX assessment_templates_position_group_version ON assessment_templates (position_group, version);  -- new; currentTemplateFor() = max(version) per group

-- ----------------------------------------------------------------------------
-- source: db.assessmentTemplates[].attributes[]  (m12/scouting.mjs:31 seed, :79 posted)
-- owner/writer: m12/scouting.mjs; immutable with the version
-- mapping: id -> attr_id (<=40), (array position) -> ordinal (new), label -> label (<=80),
--          anchors -> anchors_json (seed: {"1":..,"3":..,"5":..}; posted: `a.anchors ?? {}`,
--          an arbitrary object — free-form by design, kept as JSON)
-- ----------------------------------------------------------------------------
CREATE TABLE assessment_template_attributes (
  template_id      TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  attr_id          TEXT NOT NULL,
  ordinal          INTEGER NOT NULL,
  label            TEXT NOT NULL,
  anchors_json     TEXT NOT NULL CHECK (json_valid(anchors_json)) DEFAULT '{}',
  PRIMARY KEY (template_id, template_version, attr_id),
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE CASCADE
) STRICT;


-- ----------------------------------------------------------------------------
-- source: db.videoSegments  created at m12/scouting.mjs:370-380
-- owner/writer: m12/scouting.mjs (org-private workflow records; never edited or deleted)
-- lifecycle: none
-- mapping:
--   id -> id (seg-N)          mediaId -> media_id         playerId -> player_id   orgId -> org_id
--   createdBy.userId -> created_by_user_id   createdBy.name -> created_by_name
--   startS -> start_s          endS -> end_s
--   labels[] -> labels_json (≤8 free-form tags ≤30 chars; never queried individually — free-form by design)
--   eventType -> event_type (<=40)   note -> note (<=300)
--   drawing -> drawing_json (arbitrary overlay-shape object "stored as data" — free-form by design)
--   createdAt -> created_at
--   derived, not stored: mediaUrl
-- notes: annotations against the player's own media; cascade with the media and
--        the player. Org visibility is re-checked live on every read (orgCanSee).
-- ----------------------------------------------------------------------------
CREATE TABLE video_segments (
  id                 TEXT PRIMARY KEY,
  media_id           TEXT NOT NULL REFERENCES player_media(id) ON DELETE CASCADE,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    TEXT NOT NULL,                        -- snapshot
  start_s            REAL NOT NULL CHECK (start_s >= 0),
  end_s              REAL NOT NULL CHECK (end_s > start_s AND end_s - start_s <= 600),
  labels_json        TEXT NOT NULL CHECK (json_valid(labels_json)) DEFAULT '[]',
  event_type         TEXT,
  note               TEXT,
  drawing_json       TEXT CHECK (json_valid(drawing_json) OR drawing_json IS NULL),
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX video_segments_org_id_player_id ON video_segments (org_id, player_id);  -- GET /org/segments?playerId=
CREATE INDEX video_segments_org_id_media_id ON video_segments (org_id, media_id);    -- GET /org/segments?mediaId=

-- ----------------------------------------------------------------------------
-- source: db.playlists  created at m12/scouting.mjs:406
-- owner/writer: m12/scouting.mjs
-- lifecycle: none (never closed or deleted)
-- mapping: id -> id (pls-N), orgId -> org_id, name -> name (<=80),
--          createdBy.userId -> created_by_user_id, createdBy.name -> created_by_name,
--          segmentIds[] -> playlist_segments, createdAt -> created_at
-- ----------------------------------------------------------------------------
CREATE TABLE playlists (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name    TEXT NOT NULL,                        -- snapshot
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX playlists_org_id ON playlists (org_id);

-- ----------------------------------------------------------------------------
-- source: db.playlists[].segmentIds[]  appended at m12/scouting.mjs:417 (deduplicated by the code)
-- owner/writer: m12/scouting.mjs
-- mapping: segmentIds[i] -> (playlist_id, segment_id); (array position) -> ordinal (new, keeps order)
-- ----------------------------------------------------------------------------
CREATE TABLE playlist_segments (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  segment_id  TEXT NOT NULL REFERENCES video_segments(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, segment_id)
) STRICT;


-- ----------------------------------------------------------------------------
-- source: db.assessments  created at m12/scouting.mjs:170-187
-- owner/writer: m12/scouting.mjs (scout drafts/submits; lead reviews; publish-feedback);
--               server.mjs:3996 nulls playerName on account deletion
-- lifecycle: state draft -> submitted -> reviewed; never deleted; published_feedback is a
--            one-shot side door (ALREADY_PUBLISHED on a second attempt)
-- mapping:
--   id -> id (ass-N)                  orgId -> org_id            playerId -> player_id
--   playerName -> player_name (nullable: nulled by the deletion tombstone)
--   scoutUserId -> scout_user_id      scoutName -> scout_name
--   templateId/templateVersion -> template_id / template_version (composite FK)
--   attributesSnapshot -> derived, not stored: template versions are immutable and
--     append-only, so the snapshot always equals assessment_template_attributes for
--     (template_id, template_version); the join restores it exactly
--   context.fixture -> context_fixture (<=120)      context.date -> context_date
--   context.minutesWatched -> context_minutes_watched   context.viewing -> context_viewing
--   context.opponentLevel -> context_opponent_level (<=60)
--   context.trialId -> context_trial_id             context.trialSessionId -> context_trial_session_id
--   context.<any other key> -> context_extra_json (KNOWN DEFECT: PUT /assessments/:id
--     spreads `...rest` of the body's context into the record (scouting.mjs:240), so
--     arbitrary keys land here; retained until the route validates — deferred
--     normalisation, resolved when PUT is restricted to the five known keys)
--   ratings[] -> assessment_ratings (+ assessment_rating_evidence_refs)
--   state -> state                    recommendation.verdict -> recommendation_verdict
--   recommendation.reasons -> recommendation_reasons (<=500)
--   secondOpinionOf -> second_opinion_of_id
--   createdAt / submittedAt / reviewedAt -> created_at / submitted_at / reviewed_at
--   reviewNote -> review_note (<=300; only exists after review)
--   publishedFeedback.text/byUserId/byName/at -> published_feedback_text (<=800) /
--     published_feedback_by_user_id / published_feedback_by_name / published_feedback_at
--   history[] -> assessment_history
-- notes:
--   * Org-private: the blind rule (assessmentAccessList) is applied in code on
--     (org_id, player_id, scout_user_id, state) — hence that index.
--   * context_date is `context?.date ?? null`, never validated (any JSON value);
--     stored as TEXT without a format check (defect carried).
--   * context_trial_session_id names a session nested in trials.schedule.sessions[]
--     (02_recruitment.sql); referenced by id only, no FK.
--   * m15/passport.mjs:105 and m162/trust.mjs:172 filter on state 'published',
--     which is never written — the CHECK lists the three real states.
--   * player_id: the record outlives the subject (tombstone keeps the id, drops
--     the name) → ON DELETE RESTRICT; the player row is expected to be tombstoned.
-- ----------------------------------------------------------------------------
CREATE TABLE assessments (
  id                            TEXT PRIMARY KEY,
  org_id                        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id                     TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
  player_name                   TEXT,                      -- snapshot; NULL after subject removal
  scout_user_id                 TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                    TEXT NOT NULL,             -- snapshot
  template_id                   TEXT NOT NULL,
  template_version              INTEGER NOT NULL,
  context_fixture               TEXT,
  context_date                  TEXT,
  context_minutes_watched       INTEGER,
  context_viewing               TEXT CHECK (context_viewing IN ('live','video') OR context_viewing IS NULL),
  context_opponent_level        TEXT,
  context_trial_id              TEXT REFERENCES trials(id) ON DELETE RESTRICT,
  context_trial_session_id      TEXT,                      -- trials.schedule.sessions[].id; no FK
  context_extra_json            TEXT CHECK (json_valid(context_extra_json) OR context_extra_json IS NULL),
  state                         TEXT NOT NULL CHECK (state IN ('draft','submitted','reviewed')) DEFAULT 'draft',
  recommendation_verdict        TEXT CHECK (recommendation_verdict IN ('sign','monitor','pass') OR recommendation_verdict IS NULL),
  recommendation_reasons        TEXT,
  second_opinion_of_id          TEXT REFERENCES assessments(id) ON DELETE RESTRICT,
  created_at                    INTEGER NOT NULL,
  submitted_at                  INTEGER,
  reviewed_at                   INTEGER,
  review_note                   TEXT,
  published_feedback_text       TEXT,
  published_feedback_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  published_feedback_by_name    TEXT,                      -- snapshot
  published_feedback_at         INTEGER,
  FOREIGN KEY (template_id, template_version) REFERENCES assessment_templates(id, version) ON DELETE RESTRICT
) STRICT;
CREATE INDEX assessments_org_id_player_id_scout_user_id_state ON assessments (org_id, player_id, scout_user_id, state);  -- access list / blind rule / compare
CREATE INDEX assessments_org_id_created_at ON assessments (org_id, created_at);        -- lead list newest first; m13 insight windows
CREATE INDEX assessments_player_id_published_feedback_at ON assessments (player_id, published_feedback_at);  -- player/guardian feedback views; m15 export
CREATE INDEX assessments_context_trial_id ON assessments (context_trial_id);            -- ?trialId= filter; m23 trial routes/journey

-- ----------------------------------------------------------------------------
-- source: db.assessments[].ratings[]  replaced wholesale at m12/scouting.mjs:224-230 (PUT while draft)
-- owner/writer: m12/scouting.mjs
-- mapping:
--   attrId -> attr_id        rating -> rating (NULL when notObserved)   notObserved -> not_observed
--   confidence -> confidence (default 'medium')   note -> note (<=300)
--   evidenceRefs[] -> assessment_rating_evidence_refs
-- notes: natural key (assessment_id, attr_id). The source does not reject a
--        duplicate attrId in one PUT (the compare view takes the first); the
--        migration keeps the first occurrence. "Not observed" is never a zero:
--        rating is NULL and not_observed = 1.
-- ----------------------------------------------------------------------------
CREATE TABLE assessment_ratings (
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  attr_id       TEXT NOT NULL,
  rating        INTEGER CHECK (rating BETWEEN 1 AND 5 OR rating IS NULL),
  not_observed  INTEGER NOT NULL CHECK (not_observed IN (0,1)) DEFAULT 0,
  confidence    TEXT NOT NULL CHECK (confidence IN ('low','medium','high')) DEFAULT 'medium',
  note          TEXT,
  PRIMARY KEY (assessment_id, attr_id),
  CHECK ((not_observed = 1 AND rating IS NULL) OR (not_observed = 0 AND rating IS NOT NULL))
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.assessments[].ratings[].evidenceRefs[]  (≤6 per rating; m12/scouting.mjs:227-229)
-- owner/writer: m12/scouting.mjs
-- mapping:
--   (array position) -> ordinal (new)      segmentId -> segment_id
--   trialSessionId -> trial_session_id     boxSessionId -> box_session_id
--   t -> t_s (unvalidated in the source; numeric values land here)
--   label -> label (<=80)
--   (non-object ref passed through as-is, scouting.mjs:229) -> raw_json  -- known defect: a
--     string/number ref is stored untouched; retained verbatim here, never as a column
-- notes: box_session_id names a Box Cam session linked to the trial
--        (trials.schedule.sessions[].evidence[], 02_recruitment.sql) — id only.
-- ----------------------------------------------------------------------------
CREATE TABLE assessment_rating_evidence_refs (
  assessment_id    TEXT NOT NULL,
  attr_id          TEXT NOT NULL,
  ordinal          INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
  segment_id       TEXT REFERENCES video_segments(id) ON DELETE SET NULL,
  trial_session_id TEXT,
  box_session_id   TEXT,
  t_s              REAL,
  label            TEXT,
  raw_json         TEXT CHECK (json_valid(raw_json) OR raw_json IS NULL),
  PRIMARY KEY (assessment_id, attr_id, ordinal),
  FOREIGN KEY (assessment_id, attr_id) REFERENCES assessment_ratings(assessment_id, attr_id) ON DELETE CASCADE
) STRICT;

-- ----------------------------------------------------------------------------
-- source: db.assessments[].history[]  via audit() (m12/shared.mjs:72); append-only
-- owner/writer: m12/scouting.mjs
-- mapping: id -> id (aud-N), at -> at, byKind -> by_kind ('org'), byId -> by_id (org_users.id here),
--          byName -> by_name, action -> action (created | submitted | reviewed | published_feedback),
--          detail -> detail_json (always null today)
-- ----------------------------------------------------------------------------
CREATE TABLE assessment_history (
  id            TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE RESTRICT,
  at            INTEGER NOT NULL,
  by_kind       TEXT CHECK (by_kind IN ('org') OR by_kind IS NULL),
  by_id         TEXT,
  by_name       TEXT,
  action        TEXT NOT NULL,
  detail_json   TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX assessment_history_assessment_id ON assessment_history (assessment_id);


-- ----------------------------------------------------------------------------
-- source: db.vacancies  created at m12/scouting.mjs:689
-- owner/writer: m12/scouting.mjs (also read by m17/rooms.mjs:555 and recruitment_cases.vacancy_id in 02)
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
-- source: db.opportunities  created at m12/journeys.mjs:30-51; `structured` added by
--         m13/suitability.mjs:92-103 (PUT /org/opportunities/:id/structured-requirements)
-- owner/writer: m12/journeys.mjs (create/close), m13/suitability.mjs (structured block, replaced wholesale)
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
-- source: db.opportunities[].structured.trainingSlots[]  (≤10; m13/suitability.mjs:93-96)
-- owner/writer: m13/suitability.mjs; replaced wholesale with the structured block
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
-- source: db.applications  created at m12/journeys.mjs:103-107 (applyTo)
-- owner/writer: m12/journeys.mjs (apply / withdraw / outcome), m12/operations.mjs:315
--               (remindedAt sweep), m13/suitability.mjs:213-221 (suitabilitySummary)
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
-- owner/writer: m12/journeys.mjs
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
-- source: db.campaigns  created at m12/journeys.mjs:230-254
-- owner/writer: m12/journeys.mjs
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
-- source: db.campaignSubmissions  created at m12/journeys.mjs:314
-- owner/writer: m12/journeys.mjs (one row per campaign+player, created on first attempt)
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
-- source: db.campaignSubmissions[].attempts[]  created at m12/journeys.mjs:324-332
-- owner/writer: m12/journeys.mjs (submit; org review)
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
-- source: db.playerPrefs  created at m13/suitability.mjs:15-25 (blankPrefs) — created on GET (prefsFor)
-- owner/writer: m13/suitability.mjs (adult player, or guardian for a minor)
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
-- source: db.playerPrefs[].commitments[] and .availableSlots[]  (≤20 each; m13/suitability.mjs:34-40)
-- owner/writer: m13/suitability.mjs; each list replaced wholesale
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
