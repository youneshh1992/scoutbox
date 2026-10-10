-- =============================================================================
-- 07_development_boxcam_discovery.sql
-- ScoutBox target relational schema — development objectives (M12 F8),
-- Box Cam / At-Home Combine / production CV (M16, M16.1, M22), the
-- Development Hub (M21), discovery workflow (M18 Second Look + Nobody Missed,
-- M19 Dynamic Watchlists) and the M13 insight/planning stores (exposure,
-- evidence gaps, review-later, calibration, coverage, fixtures).
--
-- Executed after 01_identity.sql (orgs, org_users, guardians, players,
-- player_media) and 02_recruitment.sql (recruitment_cases, room_decisions,
-- evidence, assessments, trials). Conventions: docs/architecture/sql
-- ddl-conventions (STRICT tables, epoch-ms *_at, date-only *_date, enums as
-- CHECK, retained JSON as *_json with a stated reason, history[] as
-- <table>_history).
--
-- Actor identity across this file: a `(<x>_kind, <x>_id)` pair with no FK is
-- polymorphic — kind 'player' -> players(id), 'guardian' -> guardians(id),
-- 'org' / 'org_user' -> org_users(id). The source writes `kind: 'org'` with an
-- org_user id in M21 (actorOf) and `kind: 'org_user'` in M21 assignees; both
-- spellings are kept exactly as written.
-- =============================================================================


-- =============================================================================
-- M12 F8 — development objectives (the pre-M21 objective record)
-- =============================================================================

-- source: db.devObjectives  created at m12/journeys.mjs:405
-- owner/writer: m12/journeys.mjs (createObjective, progress, share, reassessment);
--   read by m16/training.mjs (developmentPlan, assignment objectiveId check),
--   m21/index.mjs (originObjectiveFor)
-- lifecycle: status is only ever written as 'active' (no close/archive route);
--   no soft delete
-- mapping:
--   id -> id (obj-*)
--   playerId -> player_id
--   sourceFeedbackId -> source_assessment_id (the published-feedback assessment)
--   orgId -> org_id (the assessment's org)
--   reviewer.userId / .name / .orgName -> reviewer_user_id / reviewer_name / reviewer_org_name
--   objectives[] -> dev_objective_items (child)
--   progress[] -> dev_objective_progress (child)
--   sharing.orgIds[] -> dev_objective_shares (child)
--   reassessments[] -> dev_objective_reassessments (child)
--   reviewAt -> review_at_raw (client-supplied, never validated or parsed: kept raw)
--   status -> status
--   createdBy.kind / .id / .name -> created_by_kind / created_by_id / created_by_name
--   createdAt -> created_at
-- notes: minors create via guardian only; a club sees the objective only while
--   its org id is in dev_objective_shares. Read patterns: by player, by
--   (org, player) for the club view and box assignment validation.
CREATE TABLE dev_objectives (
  id                    TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_assessment_id  TEXT NOT NULL REFERENCES assessments(id) ON DELETE RESTRICT,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  reviewer_user_id      TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  reviewer_name         TEXT,                    -- snapshot
  reviewer_org_name     TEXT,                    -- snapshot
  review_at_raw         TEXT,                    -- raw client value, unparsed today
  status                TEXT NOT NULL CHECK (status IN ('active')),
  created_by_kind       TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian')),
  created_by_id         TEXT NOT NULL,
  created_by_name       TEXT,                    -- snapshot
  created_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX dev_objectives_player ON dev_objectives (player_id);
CREATE INDEX dev_objectives_org_player ON dev_objectives (org_id, player_id);

-- source: db.devObjectives[].objectives[]  created at m12/journeys.mjs:408
-- owner/writer: m12/journeys.mjs (write-once at objective creation)
-- lifecycle: immutable; 1–2 per objective
-- mapping:
--   id -> id (objx-*)
--   (parent) -> objective_id
--   text -> text (<=200)
--   exerciseRefs[] -> exercise_refs_json (free-form client strings, <=4, never
--     validated or queried: free-form by design)
--   baselineEvidenceIds[] -> dev_objective_item_evidence (child)
--   (array position) -> position
CREATE TABLE dev_objective_items (
  id                 TEXT PRIMARY KEY,
  objective_id       TEXT NOT NULL REFERENCES dev_objectives(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,
  text               TEXT NOT NULL,
  exercise_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exercise_refs_json))
) STRICT;
CREATE INDEX dev_objective_items_objective ON dev_objective_items (objective_id, position);

-- source: db.devObjectives[].objectives[].baselineEvidenceIds[]  m12/journeys.mjs:411
-- owner/writer: m12/journeys.mjs (validated against db.evidence for the same player)
-- mapping: each id -> (item_id, evidence_id)
CREATE TABLE dev_objective_item_evidence (
  item_id      TEXT NOT NULL REFERENCES dev_objective_items(id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, evidence_id)
) STRICT;

-- source: db.devObjectives[].progress[]  created at m12/journeys.mjs:445
-- owner/writer: m12/journeys.mjs (player only, minors included)
-- lifecycle: append-only
-- mapping:
--   id -> id (prg-*)
--   (parent) -> objective_id
--   at -> created_at (source field is literally `at`)
--   objectiveId -> item_id (client-supplied, NOT validated today; migration
--     nulls any value that does not resolve to a dev_objective_items row)
--   note -> note (<=300)
--   evidenceId -> evidence_id (validated against the player's evidence)
CREATE TABLE dev_objective_progress (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES dev_objectives(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  item_id       TEXT REFERENCES dev_objective_items(id) ON DELETE SET NULL,
  note          TEXT,
  evidence_id   TEXT REFERENCES evidence(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX dev_objective_progress_objective ON dev_objective_progress (objective_id, created_at);

-- source: db.devObjectives[].sharing.orgIds[]  m12/journeys.mjs:456
-- owner/writer: m12/journeys.mjs setSharing (add/remove = hard delete of the row)
-- mapping: each org id -> (objective_id, org_id)
-- notes: the org must exist (checked); no "shared at" is recorded today.
CREATE TABLE dev_objective_shares (
  objective_id  TEXT NOT NULL REFERENCES dev_objectives(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (objective_id, org_id)
) STRICT;

-- source: db.devObjectives[].reassessments[]  created at m12/journeys.mjs:472
-- owner/writer: m12/journeys.mjs (requestReassessment; outcome by the owning org)
-- lifecycle: status requested -> completed; one open ('requested') per objective
-- mapping:
--   id -> id (ras-*)
--   (parent) -> objective_id
--   requestedBy.kind / .id / .name -> requested_by_kind / requested_by_id / requested_by_name
--   requestedAt -> requested_at
--   status -> status
--   outcome.note -> outcome_note (<=500)
--   outcome.evidenceIds[] -> dev_objective_reassessment_evidence (child)
--   outcome.byUserId / .byName / .at -> outcome_by_user_id / outcome_by_name / outcome_at
CREATE TABLE dev_objective_reassessments (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT NOT NULL REFERENCES dev_objectives(id) ON DELETE CASCADE,
  requested_by_kind   TEXT NOT NULL CHECK (requested_by_kind IN ('player','guardian')),
  requested_by_id     TEXT NOT NULL,
  requested_by_name   TEXT,                       -- snapshot
  requested_at        INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('requested','completed')),
  outcome_note        TEXT,
  outcome_by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  outcome_by_name     TEXT,                       -- snapshot
  outcome_at          INTEGER
) STRICT;
CREATE INDEX dev_objective_reassessments_objective ON dev_objective_reassessments (objective_id, status);

-- source: db.devObjectives[].reassessments[].outcome.evidenceIds[]  m12/journeys.mjs:505
-- mapping: each id -> (reassessment_id, evidence_id)
CREATE TABLE dev_objective_reassessment_evidence (
  reassessment_id  TEXT NOT NULL REFERENCES dev_objective_reassessments(id) ON DELETE CASCADE,
  evidence_id      TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (reassessment_id, evidence_id)
) STRICT;


-- =============================================================================
-- M12 F6 — drill guidance (recording instructions + coach review status)
-- =============================================================================

-- source: db.drillGuidance  created at m12/journeys.mjs:205 (seeded from the
--   server.mjs DRILLS registry — the legacy combine drills, NOT m16/drills.mjs)
-- owner/writer: m12/journeys.mjs (seed on boot; adminRouter review sets coachReview)
-- lifecycle: one row per legacy drill id; never deleted
-- mapping:
--   drillId -> drill_id (natural PK; key into the code registry server.mjs DRILLS)
--   recording.equipment / .distance / .surface / .camera -> recording_equipment / recording_distance / recording_surface / recording_camera
--   coachReview.status -> coach_review_status
--   coachReview.reviewer -> coach_review_reviewer (free-text name, <=60)
--   coachReview.at -> coach_reviewed_at
-- notes: "reviewed" means a named reviewer actually reviewed it; seeds start unreviewed.
CREATE TABLE drill_guidance (
  drill_id               TEXT PRIMARY KEY,
  recording_equipment    TEXT NOT NULL,
  recording_distance     TEXT NOT NULL,
  recording_surface      TEXT NOT NULL,
  recording_camera       TEXT NOT NULL,
  coach_review_status    TEXT NOT NULL DEFAULT 'unreviewed' CHECK (coach_review_status IN ('unreviewed','reviewed')),
  coach_review_reviewer  TEXT,
  coach_reviewed_at      INTEGER
) STRICT;


-- =============================================================================
-- M16 — Box Cam
-- =============================================================================

-- source: db.boxCamPrefs  created at m16/training.mjs:27 (lazy insert on read)
-- owner/writer: m16/training.mjs prefsFor/applyPrefs; read by m16/combine.mjs
--   (orgMaySeeResults consent gate) and sessions.mjs (clip retention gate)
-- lifecycle: one row per player, inserted on first read; never deleted
-- mapping:
--   playerId -> player_id (natural PK)
--   shareDevelopmentActivity -> share_development_activity
--   retainClips -> retain_clips
--   updatedAt -> updated_at (null until first explicit change)
--   updatedBy.kind / .id -> updated_by_kind / updated_by_id
-- notes: consent gate — 'recruitment' lets a visible org read Combine results
--   without a request. Minors: only the guardian may change prefs.
--   Insert-on-read today; the migration may pre-create a row per player.
CREATE TABLE box_cam_prefs (
  player_id                   TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  share_development_activity  TEXT NOT NULL DEFAULT 'private' CHECK (share_development_activity IN ('private','recruitment')),
  retain_clips                INTEGER NOT NULL DEFAULT 0 CHECK (retain_clips IN (0,1)),
  updated_at                  INTEGER,
  updated_by_kind             TEXT CHECK (updated_by_kind IN ('player','guardian')),
  updated_by_id               TEXT
) STRICT;

-- source: db.boxChallenges  created at m16/training.mjs:219 (org) and :429 (ScoutBox seed, 2 rows on boot)
-- owner/writer: m16/training.mjs
-- lifecycle: status is only ever 'active'; expiry is derived from ends_at
-- mapping:
--   id -> id (boxc-*)
--   title -> title (<=120)
--   publisher.kind -> publisher_kind
--   publisher.orgId -> publisher_org_id (null for 'scoutbox')
--   publisher.orgName -> publisher_org_name
--   publisher.byName -> publisher_by_name (org publisher only)
--   drillId -> drill_id (m16/drills.mjs registry id; no version pinned on a challenge)
--   metric -> metric
--   targetTotal -> target_total
--   startsAt / endsAt -> starts_at / ends_at
--   adultOnly -> adult_only
--   cap -> cap (null = unlimited)
--   status -> status
--   createdAt -> created_at
-- notes: participants count is derived from box_challenge_entries. Read
--   patterns: org's own challenges (publisher_org_id); player eligibility scan
--   over active challenges.
CREATE TABLE box_challenges (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  publisher_kind     TEXT NOT NULL CHECK (publisher_kind IN ('org','scoutbox')),
  publisher_org_id   TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  publisher_org_name TEXT,                      -- snapshot
  publisher_by_name  TEXT,                      -- snapshot
  drill_id           TEXT NOT NULL,
  metric             TEXT NOT NULL CHECK (metric IN ('reps','active_minutes')),
  target_total       INTEGER NOT NULL,
  starts_at          INTEGER NOT NULL,
  ends_at            INTEGER NOT NULL,
  adult_only         INTEGER NOT NULL DEFAULT 0 CHECK (adult_only IN (0,1)),
  cap                INTEGER,
  status             TEXT NOT NULL CHECK (status IN ('active')),
  created_at         INTEGER NOT NULL,
  CHECK ((publisher_kind = 'org') = (publisher_org_id IS NOT NULL))
) STRICT;
CREATE INDEX box_challenges_publisher_org ON box_challenges (publisher_org_id);
CREATE INDEX box_challenges_status_ends ON box_challenges (status, ends_at);

-- source: db.boxChallengeEntries  created at m16/training.mjs:251
-- owner/writer: m16/training.mjs (joinChallenge; applyChallengeProgress on session finalize)
-- lifecycle: status active -> completed; never deleted
-- mapping:
--   id -> id (boxe-*)
--   challengeId -> challenge_id
--   playerId -> player_id
--   status -> status
--   progress -> progress (denormalised cache: recomputed deterministically by
--     challengeProgress() on every finalize from box_sessions)
--   sessionIds[] -> derived, not stored: recomputed from box_sessions on every
--     finalize (challengeProgress), never read back from the record
--   joinedAt -> joined_at
--   joinedBy.kind / .id -> joined_by_kind / joined_by_id
--   completedAt -> completed_at
-- notes: UNIQUE (challenge_id, player_id) enforced by code today.
CREATE TABLE box_challenge_entries (
  id              TEXT PRIMARY KEY,
  challenge_id    TEXT NOT NULL REFERENCES box_challenges(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status          TEXT NOT NULL CHECK (status IN ('active','completed')),
  progress        INTEGER NOT NULL DEFAULT 0,
  joined_at       INTEGER NOT NULL,
  joined_by_kind  TEXT NOT NULL CHECK (joined_by_kind IN ('player','guardian')),
  joined_by_id    TEXT NOT NULL,
  completed_at    INTEGER
) STRICT;
CREATE UNIQUE INDEX box_challenge_entries_challenge_player ON box_challenge_entries (challenge_id, player_id);
CREATE INDEX box_challenge_entries_player_status ON box_challenge_entries (player_id, status);

-- source: db.boxAssignments  created at m16/training.mjs:80
-- owner/writer: m16/training.mjs (create/cancel/accept; applyAssignmentProgress on finalize);
--   read by m18/secondLook.mjs (development_block_completed)
-- lifecycle: state assigned -> accepted -> in_progress | partially_completed -> completed | cancelled.
--   'superseded' is checked in several reads but never written: dead value, not in the CHECK.
-- mapping:
--   id -> id (boxa-*)
--   playerId -> player_id
--   orgId -> org_id
--   orgName -> org_name
--   assignedBy.userId / .name / .role -> assigned_by_user_id / assigned_by_name / assigned_by_role
--   assignedBy.orgVerifiedAtAssignment -> assigned_by_org_verified (always true at write)
--   assignedBy.at -> assigned_at
--   drillId / drillVersion -> drill_id / drill_version (pinned m16/drills.mjs id@version)
--   target.type / target.value -> target_type / target_value
--   frequencyPerWeek -> frequency_per_week
--   dueDate -> due_date (sliced to 10 chars but NOT validated today; migration must
--     verify YYYY-MM-DD or null the value)
--   instructions -> instructions (<=300, moderated)
--   objectiveId -> objective_id
--   state -> state
--   createdAt / updatedAt -> created_at / updated_at
-- notes: agencies cannot assign; only verified orgs. Read patterns: org list
--   (org_id [, player_id]); player/guardian list (player_id); session create
--   validates (id, player_id).
CREATE TABLE box_assignments (
  id                       TEXT PRIMARY KEY,
  player_id                TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  org_id                   TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                 TEXT,                       -- snapshot
  assigned_by_user_id      TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  assigned_by_name         TEXT,                       -- snapshot
  assigned_by_role         TEXT,                       -- snapshot
  assigned_by_org_verified INTEGER NOT NULL DEFAULT 1 CHECK (assigned_by_org_verified IN (0,1)),
  assigned_at              INTEGER NOT NULL,
  drill_id                 TEXT NOT NULL,
  drill_version            INTEGER NOT NULL,
  target_type              TEXT NOT NULL CHECK (target_type IN ('duration','repetitions','sets','combined')),
  target_value             REAL NOT NULL,
  frequency_per_week       INTEGER,
  due_date                 TEXT CHECK (due_date IS NULL OR length(due_date) = 10),
  instructions             TEXT,
  objective_id             TEXT REFERENCES dev_objectives(id) ON DELETE SET NULL,
  state                    TEXT NOT NULL CHECK (state IN ('assigned','accepted','in_progress','partially_completed','completed','cancelled')),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
) STRICT;
CREATE INDEX box_assignments_org_player ON box_assignments (org_id, player_id);
CREATE INDEX box_assignments_player_state ON box_assignments (player_id, state);
CREATE INDEX box_assignments_objective ON box_assignments (objective_id);

-- source: db.boxSessions  created at m16/sessions.mjs:89 (ctx.boxMintSession, Combine) and :155 (player route)
-- owner/writer: m16/sessions.mjs (lifecycle, events, finalize, note, clip),
--   m16/training.mjs (T&S invalidate/restore -> integrity events),
--   m16/combine.mjs (combineAttemptId, captureContext via mint meta; cancel),
--   m22/routes.mjs (cvProviderSessionId, cvResultId)
-- lifecycle: status setup_required -> recording -> processing -> terminal
--   (verified | partially_verified | unable_to_verify | completed_unverified | cancelled | invalidated);
--   T&S restore returns status/verification_state to previous_verification_state.
--   SESSION_STATES also lists 'not_started' and 'ready' — never written.
-- mapping:
--   id -> id (boxs-*)
--   playerId -> player_id
--   drillId / drillVersion -> drill_id / drill_version (pinned m16/drills.mjs id@version)
--   assignmentId -> assignment_id
--   challengeEntryIds[] -> box_session_challenge_entries (child; 0 or 1 today)
--   target.type / .value / .sets / .repsPerSet -> target_type / target_value / target_sets / target_reps_per_set
--   nonce -> nonce_hash (sha256 hex; the plain 18-byte base64url bearer was stored before.
--     The plain value is returned once at creation and compared on every write.)
--   livenessChallenge -> liveness_challenge (one of 4 enum actions; kept plain: a 4-value
--     enum cannot be meaningfully hashed, and it is not a bearer secret)
--   provider / providerVersion -> provider_id / provider_version (m16/drills.mjs PROVIDERS)
--   status -> status
--   createdAt / expiresAt -> created_at / expires_at (TTL +2h)
--   startedAt / endedAt / livenessPassedAt -> started_at / ended_at / liveness_passed_at
--   lastSeq / batches -> last_seq / batches
--   obs{active[],presence[],ball[],reps[],sets[],pauses[],interruptions[],multiPerson[]} -> obs_json
--     (retained JSON, deferred normalisation: a write-once observation stream of up to
--      2,000 bounded intervals consumed exactly once by finalize(); nothing reads it by
--      column and T&S sees only the derived values. A box_session_observations child
--      table is the normalisation step if per-interval queries are ever needed.)
--   captureMode -> capture_mode ('live' only)
--   integrity.minted / integrity.drift -> integrity_minted / integrity_drift_ms
--   sessionDurationMs / verifiedActiveMs / verifiedReps / setsCompleted -> session_duration_ms / verified_active_ms / verified_reps / sets_completed
--   targetCompleted -> target_completed (nullable boolean: null = metric unsupported)
--   quality -> quality
--   interruptionsCount -> interruptions_count
--   verificationState -> verification_state
--   verificationReasons[] -> verification_reasons_json (retained JSON: bounded list of reason
--     codes SESSION_CANCELLED | PROVIDER_UNAVAILABLE | LIVENESS_NOT_ESTABLISHED |
--     NO_ACTIVITY_OBSERVED | OBSERVATION_INSUFFICIENT | TARGET_METRIC_NOT_SUPPORTED |
--     OBSERVATION_GAPS | OBSERVATION_QUALITY_DEGRADED | TARGET_NOT_YET_COMPLETED |
--     REP_COUNT_NOT_CONFIGURED, written once at finalize, displayed verbatim, never queried)
--   resultHash -> result_hash (sha256 of the canonical result, m16/shared.mjs resultHash)
--   finalizedAt -> finalized_at
--   note / noteProvenance -> note / note_provenance
--   clipMediaId -> clip_media_id (players.media[] item tagged capturedBy='box_cam')
--   previousVerificationState -> previous_verification_state (set on invalidate, cleared on restore)
--   invalidatedAt -> invalidated_at (cleared on restore; the durable record is box_session_integrity_events)
--   integrityEvents[] -> box_session_integrity_events (child)
--   combineAttemptId -> derived, not stored: inverse of combine_attempts.box_session_id (UNIQUE 1:1)
--   captureContext -> capture_context (Combine-minted sessions only)
--   cvProviderSessionId -> cv_provider_session_id (set at /cv/begin; the provider session itself is in-memory)
--   cvResultId -> derived, not stored: equals box_cam_cv_results.provider_session_id for the
--     row with session_id = this id (the source stores the same value twice)
-- notes: no raw frames or video are ever stored. Player deletion leaves orphans
--   today; target is CASCADE. Read patterns: player's terminal sessions newest
--   ended first (dashboard, list, challenge/assignment progress); by assignment;
--   T&S by id. Combine, M18 and M21 join by id only.
CREATE TABLE box_sessions (
  id                          TEXT PRIMARY KEY,
  player_id                   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  drill_id                    TEXT NOT NULL,
  drill_version               INTEGER NOT NULL,
  assignment_id               TEXT REFERENCES box_assignments(id) ON DELETE SET NULL,
  target_type                 TEXT NOT NULL CHECK (target_type IN ('duration','repetitions','sets','combined')),
  target_value                REAL NOT NULL,
  target_sets                 INTEGER,
  target_reps_per_set         INTEGER,
  nonce_hash                  TEXT NOT NULL,
  liveness_challenge          TEXT NOT NULL CHECK (liveness_challenge IN ('raise_right_hand','show_ball','left_foot_touch','step_into_zone')),
  provider_id                 TEXT NOT NULL CHECK (provider_id IN ('production_cv','web_client','local_test')),
  provider_version            INTEGER NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('setup_required','recording','processing','verified','partially_verified','unable_to_verify','completed_unverified','cancelled','invalidated')),
  created_at                  INTEGER NOT NULL,
  expires_at                  INTEGER NOT NULL,
  started_at                  INTEGER,
  ended_at                    INTEGER,
  liveness_passed_at          INTEGER,
  last_seq                    INTEGER NOT NULL DEFAULT 0,
  batches                     INTEGER NOT NULL DEFAULT 0,
  obs_json                    TEXT NOT NULL DEFAULT '{"active":[],"presence":[],"ball":[],"reps":[],"sets":[],"pauses":[],"interruptions":[],"multiPerson":[]}' CHECK (json_valid(obs_json)),
  capture_mode                TEXT NOT NULL DEFAULT 'live' CHECK (capture_mode IN ('live')),
  integrity_minted            TEXT NOT NULL DEFAULT 'server' CHECK (integrity_minted IN ('server')),
  integrity_drift_ms          INTEGER NOT NULL DEFAULT 7000,
  session_duration_ms         INTEGER,
  verified_active_ms          INTEGER,
  verified_reps               INTEGER,
  sets_completed              INTEGER,
  target_completed            INTEGER CHECK (target_completed IN (0,1)),
  quality                     TEXT CHECK (quality IN ('good','degraded','insufficient')),
  interruptions_count         INTEGER,
  verification_state          TEXT CHECK (verification_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled','invalidated')),
  verification_reasons_json   TEXT CHECK (verification_reasons_json IS NULL OR json_valid(verification_reasons_json)),
  result_hash                 TEXT,
  finalized_at                INTEGER,
  note                        TEXT,
  note_provenance             TEXT CHECK (note_provenance IN ('player_submitted_note')),
  clip_media_id               TEXT REFERENCES player_media(id) ON DELETE SET NULL,
  previous_verification_state TEXT CHECK (previous_verification_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled')),
  invalidated_at              INTEGER,
  capture_context             TEXT CHECK (capture_context IN ('at_home','club','event')),
  cv_provider_session_id      TEXT
) STRICT;
CREATE INDEX box_sessions_player_status_ended ON box_sessions (player_id, status, ended_at);
CREATE INDEX box_sessions_assignment ON box_sessions (assignment_id);
CREATE INDEX box_sessions_player_finalized ON box_sessions (player_id, finalized_at);

-- source: db.boxSessions[].challengeEntryIds[]  m16/sessions.mjs:148
-- owner/writer: m16/sessions.mjs (write-once at session creation)
-- mapping: each id -> (session_id, entry_id)
CREATE TABLE box_session_challenge_entries (
  session_id  TEXT NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL REFERENCES box_challenge_entries(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, entry_id)
) STRICT;

-- source: db.boxCamDisputes  created at m16/training.mjs:358
-- owner/writer: m16/training.mjs (player/guardian file; T&S resolve)
-- lifecycle: status open -> resolved; never deleted
-- mapping:
--   id -> id (boxd-*)
--   sessionId -> session_id
--   playerId -> player_id
--   by.kind / .id / .name -> by_kind / by_id / by_name
--   reason -> reason (<=500, moderated)
--   status -> status
--   resolution.outcome / .reason / .at -> resolution_outcome / resolution_reason / resolved_at
--   createdAt -> created_at
-- notes: known defect — the resolving T&S actor is NOT stored anywhere
--   (resolver identity missing); resolution_by_* columns are reserved and
--   nullable so a fix can land without a schema change. Rate limit (5/day)
--   is in-memory. Read patterns: T&S open queue by created_at; by session.
CREATE TABLE box_cam_disputes (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
  player_id            TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  by_kind              TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                TEXT NOT NULL,
  by_name              TEXT,                      -- snapshot
  reason               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome   TEXT CHECK (resolution_outcome IN ('stands','invalidated','provider_bug')),
  resolution_reason    TEXT,
  resolved_at          INTEGER,
  resolution_by_id     TEXT,                      -- reserved: never written today (defect)
  resolution_by_name   TEXT,                      -- reserved: never written today (defect)
  created_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX box_cam_disputes_status_created ON box_cam_disputes (status, created_at);
CREATE INDEX box_cam_disputes_session ON box_cam_disputes (session_id);

-- source: db.boxSessions[].integrityEvents[]  created at m16/training.mjs:401 (invalidated) and :420 (restored)
-- owner/writer: m16/training.mjs T&S routes; read by m18/secondLook.mjs
--   (combine_verified_invalidated / _restored changes, fingerprinted on the session)
-- lifecycle: append-only (M18.1: survives a restore, unlike invalidatedAt)
-- mapping:
--   (no id) -> id (new, minted as bsie-<n>)
--   (parent) -> session_id
--   type -> type
--   at -> at
--   disputeId -> dispute_id (invalidated only)
--   outcome -> outcome (invalidated only: the dispute outcome that caused it)
--   to -> to_state (restored only: the verification state restored to)
-- notes: the restore reason is only written to the ledger (ledgerAppend), not here.
CREATE TABLE box_session_integrity_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('invalidated','restored')),
  at          INTEGER NOT NULL,
  dispute_id  TEXT REFERENCES box_cam_disputes(id) ON DELETE SET NULL,
  outcome     TEXT CHECK (outcome IN ('invalidated','provider_bug')),
  to_state    TEXT CHECK (to_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled'))
) STRICT;
CREATE INDEX box_session_integrity_events_session_at ON box_session_integrity_events (session_id, at);

-- boxSessionEvents: db.boxSessionEvents is created at m16/index.mjs:21 as
-- "reserved: aggregates live on the session record" and is never written or
-- read anywhere. No table — a per-event row store would duplicate obs_json; if
-- per-interval queries are ever wanted, the normalisation step is a
-- box_session_observations table (session_id, kind, from_ms, to_ms, at_ms,
-- quality, confidence) replacing obs_json, not this reserved name.


-- =============================================================================
-- M16.1 — At-Home Combine
-- =============================================================================

-- source: db.combineRequests  created at m16/combine.mjs:519 (createRequests; also
--   reached from M17 rooms via ctx.createCombineRequests)
-- owner/writer: m16/combine.mjs
-- lifecycle: state requested -> completed | cancelled (requestState() is derived at read:
--   'completed' when every protocol has a Combine Verified attempt in window)
-- mapping:
--   id -> id (creq-*)
--   orgId / orgName -> org_id / org_name
--   requestedBy.userId / .name / .role / .at -> requested_by_user_id / requested_by_name / requested_by_role / requested_at
--   playerId -> player_id
--   title -> title (<=120 or null)
--   protocolIds[] -> combine_request_protocols (child)
--   deadline -> deadline_date (strict YYYY-MM-DD validated)
--   instructions -> instructions (<=300, moderated)
--   state -> state
--   createdAt / completedAt -> created_at / completed_at
-- notes: known defect — the cancelling actor is not stored. A non-cancelled
--   request from this org is implied consent to read the player's Combine
--   results (orgMaySeeResults). Read patterns: org list (org_id[, player_id]);
--   player list (player_id, state); attempt creation validates (id, player_id).
CREATE TABLE combine_requests (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name              TEXT,                       -- snapshot
  requested_by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  requested_by_name     TEXT,                       -- snapshot
  requested_by_role     TEXT,                       -- snapshot
  requested_at          INTEGER NOT NULL,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  title                 TEXT,
  deadline_date         TEXT CHECK (deadline_date IS NULL OR length(deadline_date) = 10),
  instructions          TEXT,
  state                 TEXT NOT NULL CHECK (state IN ('requested','completed','cancelled')),
  created_at            INTEGER NOT NULL,
  completed_at          INTEGER
) STRICT;
CREATE INDEX combine_requests_org_player ON combine_requests (org_id, player_id);
CREATE INDEX combine_requests_player_state ON combine_requests (player_id, state);

-- source: db.combineRequests[].protocolIds[]  m16/combine.mjs:523 (deduped, validated active protocols)
-- mapping: each protocol id -> (request_id, protocol_id); position preserves order
CREATE TABLE combine_request_protocols (
  request_id   TEXT NOT NULL REFERENCES combine_requests(id) ON DELETE CASCADE,
  protocol_id  TEXT NOT NULL,
  position     INTEGER NOT NULL,
  PRIMARY KEY (request_id, protocol_id)
) STRICT;

-- source: db.combineAttempts  created at m16/combine.mjs:343
-- owner/writer: m16/combine.mjs (create, calibrate, complete via Box Cam path,
--   cancel; applyCombineProgress on finalize); read by m18 (combine_verified_added),
--   m19 matchFacts, m21 targets/evidence, m23 trial routes
-- lifecycle: combineState ready -> terminal (combine_verified | partially_measured |
--   measurement_unavailable | protocol_invalid | invalidated | cancelled). The stored
--   state is the state it finished in; the LIVE state (liveCombineState) is derived
--   at read from the bound session's verification_state. COMBINE_STATES also lists
--   not_started, setup_required, attempt_in_progress, processing, integrity_review —
--   never written.
-- mapping:
--   id -> id (catt-*)
--   playerId -> player_id
--   protocolId / protocolVersion -> protocol_id / protocol_version (COMBINE_PROTOCOLS id@version, pinned)
--   boxSessionId -> box_session_id (UNIQUE: 1:1 with the server-minted session)
--   attemptNumber -> attempt_number (1-based count per player+protocol at creation)
--   mode -> mode
--   captureContext -> capture_context
--   requestId -> request_id
--   metricType / metricUnit / direction -> metric_type / metric_unit / direction (frozen from the protocol)
--   measurementAlgorithmVersion -> measurement_algorithm_version
--   provider / providerVersion -> provider_id / provider_version
--   calibrationResult -> calibration_required_json / calibration_passed / calibration_checks_json / calibrated_at
--     (required[] and checks[] are short lists of calibration check names such as
--      'box_marker_5m' / 'geometry_ready_check'; retained JSON because they are
--      free-form client strings compared as a set and never queried)
--   measuredValue -> measured_value (REAL: tenths for duration, integer counts otherwise)
--   measurementState -> measurement_state
--   combineState -> combine_state
--   reasons[] -> reasons_json (retained JSON: machine reason codes from measureAttempt,
--     e.g. MEASUREMENT_NOT_SUPPORTED, SESSION_INVALIDATED, MEASUREMENT_WINDOW_INCOMPLETE,
--     OBSERVATION_QUALITY_DEGRADED, PRACTICE_ATTEMPT, CALIBRATION_NOT_PASSED; displayed, never queried)
--   startedAt / completedAt / createdAt -> started_at / completed_at / created_at
--   resultHash -> result_hash (sha256, combineResultHash)
-- notes: practice attempts never become combine_verified. Read patterns: player
--   attempts newest first; per (player, protocol, mode, created_at) for attempt
--   limits; by box_session_id (invalidation, M18); personal bests over
--   (player, protocol, version).
CREATE TABLE combine_attempts (
  id                             TEXT PRIMARY KEY,
  player_id                      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  protocol_id                    TEXT NOT NULL,
  protocol_version               INTEGER NOT NULL,
  box_session_id                 TEXT NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
  attempt_number                 INTEGER NOT NULL,
  mode                           TEXT NOT NULL CHECK (mode IN ('verified','practice')),
  capture_context                TEXT NOT NULL CHECK (capture_context IN ('at_home','club','event')),
  request_id                     TEXT REFERENCES combine_requests(id) ON DELETE SET NULL,
  metric_type                    TEXT NOT NULL CHECK (metric_type IN ('count','time','distance','duration','set','percentage')),
  metric_unit                    TEXT NOT NULL,
  direction                      TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  measurement_algorithm_version  INTEGER NOT NULL,
  provider_id                    TEXT NOT NULL CHECK (provider_id IN ('production_cv','web_client','local_test')),
  provider_version               INTEGER NOT NULL,
  calibration_required_json      TEXT CHECK (calibration_required_json IS NULL OR json_valid(calibration_required_json)),
  calibration_passed             INTEGER CHECK (calibration_passed IN (0,1)),
  calibration_checks_json        TEXT CHECK (calibration_checks_json IS NULL OR json_valid(calibration_checks_json)),
  calibrated_at                  INTEGER,
  measured_value                 REAL,
  measurement_state              TEXT CHECK (measurement_state IN ('measured','practice','partially_measured','measurement_unavailable','protocol_invalid','invalidated','cancelled')),
  combine_state                  TEXT NOT NULL CHECK (combine_state IN ('ready','combine_verified','partially_measured','measurement_unavailable','protocol_invalid','invalidated','cancelled')),
  reasons_json                   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
  started_at                     INTEGER,
  completed_at                   INTEGER,
  result_hash                    TEXT,
  created_at                     INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX combine_attempts_box_session ON combine_attempts (box_session_id);
CREATE INDEX combine_attempts_player_created ON combine_attempts (player_id, created_at);
CREATE INDEX combine_attempts_player_protocol ON combine_attempts (player_id, protocol_id, protocol_version, mode, created_at);
CREATE INDEX combine_attempts_request ON combine_attempts (request_id);


-- =============================================================================
-- M22 — production CV provider results
-- =============================================================================

-- source: db.boxCamCvResults  created at m22/routes.mjs:257 (provider.finalize -> #buildResult, m22/provider.mjs:510)
-- owner/writer: m22/routes.mjs (single-shot finalize); read by m22 T&S diagnostics and m23/trialRoutes.mjs
-- lifecycle: immutable once written (Object.freeze); a cancelled/expired/failed
--   provider session mints NO row; never deleted
-- mapping:
--   (no id field) -> provider_session_id is the effective PK ('pcv_<base64url 12>'), looked up by it everywhere
--   sessionId -> session_id (the bound Box Cam session; NB m23/trialRoutes.mjs:796 reads
--     `boxCamSessionId` which does not exist — known defect)
--   providerSessionId -> provider_session_id
--   protocolId -> protocol_id (CANDIDATE_PROTOCOLS: combine-box-touch-60 | combine-box-juggle | combine-box-control-60)
--   providerId -> provider_id ('production_cv')
--   providerVersion / engineVersion / cvPolicyVersion -> provider_version / engine_version / cv_policy_version
--   outcome -> outcome
--   refusalReason / refusalDetail -> refusal_reason / refusal_detail
--   observationQuality.sufficient / .state / .aggregateConfidence / .coverage -> oq_sufficient / oq_state / oq_aggregate_confidence / oq_coverage
--   observationQuality.reasons[] / .secondaryDiagnostics[] -> oq_reasons_json / oq_secondary_diagnostics_json
--     (retained JSON: engine diagnostic code lists, displayed to T&S, never queried)
--   derived.personPresent / .ballPresent -> person_present / ball_present
--   derived.touchCount / .juggleCount / .activeDurationMs -> touch_count / juggle_count / active_duration_ms
--   experimental.exactCount -> experimental_exact_count
--   experimental.status -> experimental_status ('experimental_unvalidated')
--   experimental.note -> derived, not stored: constant copy
--   integrity.ok -> integrity_ok
--   integrity.framesAccepted / .framesRejected / .framesDroppedByServer -> frames_accepted / frames_rejected / frames_dropped_by_server
--   integrity.duplicatesRejected / .outOfOrderRejected / .clientClockAnomalies -> duplicates_rejected / out_of_order_rejected / client_clock_anomalies
--   integrity.framesAnalysed / .duplicateFrames / .effectiveFps / .maxBallGapMs -> frames_analysed / duplicate_frames / effective_fps / max_ball_gap_ms
--   integrity.nonceBound / .serverTimeline -> nonce_bound / server_timeline (always true)
--   trace[] -> trace_json (retained JSON: <=256 {atMs, confidence} event timestamps,
--     diagnostic only, bounded by construction, never queried) ; traceTruncated -> trace_truncated
--   serverStartedAt / serverEndedAt / serverDurationMs -> server_started_at / server_ended_at / server_duration_ms
--   combineVerified -> combine_verified (always false today)
--   combineVerifiedBlockedBy -> combine_verified_blocked_by ('REAL_WORLD_VALIDATION_NOT_COMPLETED')
-- notes: no frame bytes, no base64, no pixels — derived metadata only (§35/§37).
--   No player_id on the row: join through box_sessions. Read patterns: by
--   provider_session_id (finalize idempotency, T&S); by session_id.
CREATE TABLE box_cam_cv_results (
  provider_session_id          TEXT PRIMARY KEY,
  session_id                   TEXT NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
  protocol_id                  TEXT NOT NULL CHECK (protocol_id IN ('combine-box-touch-60','combine-box-juggle','combine-box-control-60')),
  provider_id                  TEXT NOT NULL CHECK (provider_id IN ('production_cv')),
  provider_version             INTEGER NOT NULL,
  engine_version               TEXT NOT NULL,
  cv_policy_version            TEXT NOT NULL,
  outcome                      TEXT NOT NULL CHECK (outcome IN ('accepted','refused')),
  refusal_reason               TEXT,
  refusal_detail               TEXT,
  oq_sufficient                INTEGER NOT NULL CHECK (oq_sufficient IN (0,1)),
  oq_state                     TEXT CHECK (oq_state IN ('sufficient','insufficient')),
  oq_aggregate_confidence      REAL,
  oq_coverage                  REAL,
  oq_reasons_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(oq_reasons_json)),
  oq_secondary_diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(oq_secondary_diagnostics_json)),
  person_present               INTEGER NOT NULL CHECK (person_present IN (0,1)),
  ball_present                 INTEGER NOT NULL CHECK (ball_present IN (0,1)),
  touch_count                  INTEGER,
  juggle_count                 INTEGER,
  active_duration_ms           INTEGER NOT NULL DEFAULT 0,
  experimental_exact_count     INTEGER,
  experimental_status          TEXT NOT NULL CHECK (experimental_status IN ('experimental_unvalidated')),
  integrity_ok                 INTEGER NOT NULL CHECK (integrity_ok IN (0,1)),
  frames_accepted              INTEGER NOT NULL DEFAULT 0,
  frames_rejected              INTEGER NOT NULL DEFAULT 0,
  frames_dropped_by_server     INTEGER NOT NULL DEFAULT 0,
  duplicates_rejected          INTEGER NOT NULL DEFAULT 0,
  out_of_order_rejected        INTEGER NOT NULL DEFAULT 0,
  client_clock_anomalies       INTEGER NOT NULL DEFAULT 0,
  frames_analysed              INTEGER,
  duplicate_frames             INTEGER,
  effective_fps                REAL,
  max_ball_gap_ms              INTEGER,
  nonce_bound                  INTEGER NOT NULL DEFAULT 1 CHECK (nonce_bound IN (0,1)),
  server_timeline              INTEGER NOT NULL DEFAULT 1 CHECK (server_timeline IN (0,1)),
  trace_json                   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(trace_json)),
  trace_truncated              INTEGER NOT NULL DEFAULT 0 CHECK (trace_truncated IN (0,1)),
  server_started_at            INTEGER,
  server_ended_at              INTEGER,
  server_duration_ms           INTEGER NOT NULL DEFAULT 0,
  combine_verified             INTEGER NOT NULL DEFAULT 0 CHECK (combine_verified IN (0,1)),
  combine_verified_blocked_by  TEXT
) STRICT;
CREATE INDEX box_cam_cv_results_session ON box_cam_cv_results (session_id);


-- =============================================================================
-- M18 — Recruitment Briefs, Nobody Missed, Second Look
-- =============================================================================

-- source: db.recruitmentBriefs  created at m18/nobodyMissed.mjs:182
-- owner/writer: m18/nobodyMissed.mjs (lead-only create/patch); read by m19 (brief-sourced
--   criteria / live-linked watchlists), m17 rooms (sourceRef)
-- lifecycle: status draft -> active -> paused | closed -> ... -> archived (BRIEF_TRANSITIONS);
--   archived is terminal and refuses edits; never deleted; max 40 per org
-- mapping:
--   id -> id (brf-*)
--   orgId -> org_id
--   title -> title (<=120)
--   criteria.positions[] -> recruitment_brief_criteria_values kind 'position'
--   criteria.positionGroups[] -> derived, not stored: POSITION_GROUP_OF over positions (m18/shared.mjs:649)
--   criteria.minAge / .maxAge -> min_age / max_age
--   criteria.radiusKm -> radius_km (grassroots clamped to <=50 at write)
--   criteria.maxLevel -> max_level (grassroots forced to 'semi_pro')
--   criteria.foot -> foot
--   criteria.availability -> availability (free text <=40)
--   criteria.evidenceRequirements[] -> recruitment_brief_criteria_values kind 'evidence_requirement'
--   criteria.minTrustBand -> min_trust_band
--   criteria.combineProtocols[] -> recruitment_brief_criteria_values kind 'combine_protocol'
--   version -> version (CRITERIA version: +1 on a material criteria change; historical
--     coverage and nobody_missed_reviews.brief_version point at it; old criteria are NOT retained)
--   status -> status
--   activeFrom / activeUntil -> active_from_date / active_until_date (strict YYYY-MM-DD, inclusive)
--   roleId -> role_id (unvalidated free reference, no FK)
--   vacancyId -> vacancy_id (unvalidated; intended target vacancies(id), no FK today)
--   createdBy.userId / .name -> created_by_user_id / created_by_name
--   createdAt / updatedAt -> created_at / updated_at
--   history[] -> recruitment_briefs_history
--   rev / revAt / revBy{userId,name} -> rev / rev_at / rev_by_user_id / rev_by_name (M18.1 concurrency token)
-- notes: change detection today is JSON.stringify(criteria) equality; with the
--   flattened columns + child rows the migration/repository compares the
--   canonical tuple. Protected-characteristic criteria are refused at write.
--   Read patterns: org list by updated_at desc; (id, org_id).
CREATE TABLE recruitment_briefs (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  title               TEXT NOT NULL,
  min_age             INTEGER,
  max_age             INTEGER,
  radius_km           REAL,
  max_level           TEXT CHECK (max_level IS NULL OR max_level IN ('amateur','semi_pro','pro')),
  foot                TEXT CHECK (foot IS NULL OR foot IN ('Left','Right','Both')),
  availability        TEXT,
  min_trust_band      TEXT CHECK (min_trust_band IS NULL OR min_trust_band IN ('limited_evidence','developing_evidence','established_evidence','strong_evidence','very_strong_evidence')),
  version             INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL CHECK (status IN ('draft','active','paused','closed','archived')),
  active_from_date    TEXT CHECK (active_from_date IS NULL OR length(active_from_date) = 10),
  active_until_date   TEXT CHECK (active_until_date IS NULL OR length(active_until_date) = 10),
  role_id             TEXT,
  vacancy_id          TEXT,
  created_by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  created_by_name     TEXT,                      -- snapshot
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  rev                 INTEGER NOT NULL DEFAULT 1,
  rev_at              INTEGER,
  rev_by_user_id      TEXT,
  rev_by_name         TEXT                       -- snapshot
) STRICT;
CREATE INDEX recruitment_briefs_org_updated ON recruitment_briefs (org_id, updated_at);
CREATE INDEX recruitment_briefs_org_status ON recruitment_briefs (org_id, status);

-- source: db.recruitmentBriefs[].criteria.{positions[], evidenceRequirements[], combineProtocols[]}  m18/shared.mjs:647
-- owner/writer: m18/nobodyMissed.mjs (replaced wholesale on a criteria change)
-- mapping: each list entry -> (brief_id, kind, value); kind names the source list
--   ('position' values from POSITIONS, 'evidence_requirement' keys from
--    EVIDENCE_REQUIREMENTS, 'combine_protocol' = COMBINE_PROTOCOLS id, unvalidated)
CREATE TABLE recruitment_brief_criteria_values (
  brief_id  TEXT NOT NULL REFERENCES recruitment_briefs(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('position','evidence_requirement','combine_protocol')),
  value     TEXT NOT NULL,
  PRIMARY KEY (brief_id, kind, value)
) STRICT;

-- source: db.recruitmentBriefs[].history[]  via audit() m12/shared.mjs:70 (entries {id aud-*, at, byKind, byId, byName, action, detail})
-- owner/writer: m18/nobodyMissed.mjs
-- lifecycle: append-only; actions recruitment_brief_created | recruitment_brief_activated | recruitment_brief_updated
-- mapping: id -> id; (parent) -> brief_id; at -> at; byKind -> by_kind ('org'); byId -> by_id (org_user id); byName -> by_name; action -> action; detail -> detail_json
CREATE TABLE recruitment_briefs_history (
  id           TEXT PRIMARY KEY,
  brief_id     TEXT NOT NULL REFERENCES recruitment_briefs(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX recruitment_briefs_history_brief_at ON recruitment_briefs_history (brief_id, at);

-- source: db.nobodyMissedReviews  created at m18/nobodyMissed.mjs:343 (setReview, upsert)
-- owner/writer: m18/nobodyMissed.mjs (review / dismiss / add-to-room)
-- lifecycle: state open -> reviewed | dismissed | added_to_room (overwritten in place;
--   the trail is the history); never deleted
-- mapping:
--   id -> id (nmr-*)
--   orgId -> org_id
--   briefId -> brief_id
--   briefVersion -> brief_version (rewritten to the brief's current version on every action)
--   playerId -> player_id
--   state -> state
--   createdAt / updatedAt -> created_at / updated_at
--   reviewedBy{userId,name} / reviewedAt -> reviewed_by_user_id / reviewed_by_name / reviewed_at
--   dismissReason -> dismiss_reason
--   dismissedBy{userId,name} / dismissedAt -> dismissed_by_user_id / dismissed_by_name / dismissed_at
--   roomId -> room_id (the M17 room created by add-to-room)
--   history[] -> nobody_missed_reviews_history
-- notes: UNIQUE (org_id, brief_id, player_id) enforced by code (find-or-create).
--   Dismissal is per brief, never written to the player's record. Coverage
--   suppression (0<n<3) is computed on read. player_id is nullable only so a
--   deleted player can SET NULL instead of orphaning (orphans today).
CREATE TABLE nobody_missed_reviews (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  brief_id              TEXT NOT NULL REFERENCES recruitment_briefs(id) ON DELETE CASCADE,
  brief_version         INTEGER NOT NULL,
  player_id             TEXT REFERENCES players(id) ON DELETE SET NULL,
  state                 TEXT NOT NULL CHECK (state IN ('open','reviewed','added_to_room','dismissed')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  reviewed_by_user_id   TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  reviewed_by_name      TEXT,                      -- snapshot
  reviewed_at           INTEGER,
  dismiss_reason        TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_known','not_current_need','evidence_insufficient','role_mismatch_after_review','timing','other')),
  dismissed_by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  dismissed_by_name     TEXT,                      -- snapshot
  dismissed_at          INTEGER,
  room_id               TEXT REFERENCES recruitment_cases(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX nobody_missed_reviews_org_brief_player ON nobody_missed_reviews (org_id, brief_id, player_id);

-- source: db.nobodyMissedReviews[].history[]  m18/nobodyMissed.mjs:350 (entries {at, state, by{userId,name}} — no ids)
-- owner/writer: m18/nobodyMissed.mjs
-- lifecycle: append-only
-- mapping: (no id) -> id (new, minted nmrh-<n>); (parent) -> review_id; at -> at;
--   by.userId -> by_id with by_kind 'org'; by.name -> by_name; state -> action
--   (the entry records the state entered); detail_json always null
CREATE TABLE nobody_missed_reviews_history (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES nobody_missed_reviews(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL CHECK (action IN ('open','reviewed','added_to_room','dismissed')),
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX nobody_missed_reviews_history_review_at ON nobody_missed_reviews_history (review_id, at);

-- source: db.secondLookItems  created at m18/secondLook.mjs:283 (reconcile — a GET that writes)
-- owner/writer: m18/secondLook.mjs (reconcile on every list/detail read; review / dismiss / reopen-room)
-- lifecycle: status open -> reviewed | dismissed | reopened_room | expired;
--   dismissed/expired -> open only via genuinely new fingerprints (SECOND_LOOK_TRANSITIONS);
--   reopened_room is terminal; never deleted
-- mapping:
--   id -> id (slk-*)
--   orgId -> org_id
--   playerId -> player_id
--   roomId -> room_id (recruitment_cases row carrying .room)
--   decisionId -> decision_id (head of the room's decision chain at surfacing)
--   policyVersion -> policy_version
--   triggerType -> trigger_type (SECOND_LOOK_KINDS)
--   changeFingerprints[] -> second_look_item_fingerprints (child; replaced wholesale on reconcile)
--   directReasonCodes[] -> direct_reason_codes_json (retained JSON: subset of the M17 archive
--     reason codes the changes resolve; replaced wholesale on every reconcile and only
--     rendered, never queried)
--   status -> status
--   createdAt / updatedAt -> created_at / updated_at
--   latestChangeAt -> latest_change_at (expiry clock: open for 120 days after it)
--   reviewedAt / reviewedBy{userId,name} -> reviewed_at / reviewed_by_user_id / reviewed_by_name
--   dismissedAt / dismissedBy{userId,name} / dismissReason -> dismissed_at / dismissed_by_user_id / dismissed_by_name / dismiss_reason
--   reopenedAt / reopenedBy{userId,name} -> reopened_at / reopened_by_user_id / reopened_by_name
--   history[] -> second_look_items_history
-- notes: natural key (org_id, room_id, decision_id) per the engine (itemFor);
--   the M18.2 integrity check uses (org_id, room_id) — a known disagreement,
--   the engine's key is the one enforced here. Org-private: never shown to a
--   player. Read patterns: (org, status) lists; (org, player) detail reconcile;
--   (id, org).
CREATE TABLE second_look_items (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id             TEXT REFERENCES players(id) ON DELETE SET NULL,
  room_id               TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  decision_id           TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE RESTRICT,
  policy_version        INTEGER NOT NULL,
  trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('direct_reason_resolved','significant_new_evidence','evidence_removed','general_update')),
  direct_reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(direct_reason_codes_json)),
  status                TEXT NOT NULL CHECK (status IN ('open','reviewed','dismissed','reopened_room','expired')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  latest_change_at      INTEGER NOT NULL,
  reviewed_at           INTEGER,
  reviewed_by_user_id   TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  reviewed_by_name      TEXT,                      -- snapshot
  dismissed_at          INTEGER,
  dismissed_by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  dismissed_by_name     TEXT,                      -- snapshot
  dismiss_reason        TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_reviewed_elsewhere','change_not_material','timing_not_right','squad_need_changed','no_action_required','other')),
  reopened_at           INTEGER,
  reopened_by_user_id   TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  reopened_by_name      TEXT                       -- snapshot
) STRICT;
CREATE UNIQUE INDEX second_look_items_org_room_decision ON second_look_items (org_id, room_id, decision_id);
CREATE INDEX second_look_items_org_status ON second_look_items (org_id, status);
CREATE INDEX second_look_items_org_player ON second_look_items (org_id, player_id);

-- source: db.secondLookItems[].changeFingerprints[]  m18/secondLook.mjs:289 (sorted 'type:sourceSystem:sourceId')
-- owner/writer: m18/secondLook.mjs reconcile (replaced wholesale on create/reopen/update)
-- mapping: each fingerprint -> (item_id, fingerprint). The cooldown test is
--   "candidate fingerprints not in this set".
CREATE TABLE second_look_item_fingerprints (
  item_id      TEXT NOT NULL REFERENCES second_look_items(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  PRIMARY KEY (item_id, fingerprint)
) STRICT;

-- source: db.secondLookItems[].history[]  m18/secondLook.mjs:294,317,489,509,543 (entries {at, action, by{userId,name}|null, reason?} — no ids)
-- owner/writer: m18/secondLook.mjs
-- lifecycle: append-only; actions surfaced | resurfaced | reviewed | dismissed | reopened_room
-- mapping: (no id) -> id (new, minted slkh-<n>); (parent) -> item_id; at -> at;
--   by.userId -> by_id with by_kind 'org' (null by => system row: by_kind 'system');
--   by.name -> by_name; action -> action; reason -> detail_json {"reason": ...}
--   (resurfaced carries the verdict reason, dismissed the dismissal reason)
CREATE TABLE second_look_items_history (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES second_look_items(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','system')),
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL CHECK (action IN ('surfaced','resurfaced','reviewed','dismissed','reopened_room')),
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX second_look_items_history_item_at ON second_look_items_history (item_id, at);


-- =============================================================================
-- M19 — Dynamic Watchlists
-- =============================================================================

-- source: db.dynamicWatchlists  created at m19/index.mjs:283
-- owner/writer: m19/index.mjs (create/patch; reconcile on every GET /watchlists/:id — a read that writes)
-- lifecycle: status active | paused | archived (archived is terminal); max 60 non-archived per org; never deleted
-- mapping:
--   id -> id (wl-*)
--   orgId -> org_id
--   name -> name (<=80)
--   mode -> mode
--   status -> status
--   sourceType -> source_type
--   sourceId -> source_id (brief: validated recruitment_briefs id; saved_search/criteria: free string <=64)
--   criteria{required[],preferred[],schemaVersion} -> watchlist_criteria (child) + schema_version
--     (even a live-linked list stores the criteria it was created from)
--   criteriaVersion -> criteria_version ('cv1:<fnv32>' over sorted criterion ids)
--   schemaVersion -> schema_version
--   notify -> notify
--   createdBy -> created_by_user_id (plain user id string in the source — NOT the {kind,id} shape used elsewhere)
--   createdByName -> created_by_name
--   createdAt / updatedAt -> created_at / updated_at
--   rev / revAt / revBy{userId,name} -> rev / rev_at / rev_by_user_id / rev_by_name
--   lastMembership[] + lastMatchSnapshot{playerId:{required[]}} -> watchlist_memberships (child;
--     the two source fields always hold the same player set — snapshot keys == membership)
--   lastCriteriaVersion -> last_criteria_version
--   lastBriefVersion -> last_brief_version
--   lastReconciledAt -> last_reconciled_at
--   history[] -> dynamic_watchlists_history
-- notes: membership is derived on read; no scheduler. Read patterns: org list
--   by (status,) updated_at desc; (id, org_id).
CREATE TABLE dynamic_watchlists (
  id                     TEXT PRIMARY KEY,
  org_id                 TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  name                   TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode IN ('live_linked','snapshot')),
  status                 TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  source_type            TEXT NOT NULL CHECK (source_type IN ('brief','saved_search','criteria')),
  source_id              TEXT,
  schema_version         INTEGER NOT NULL,
  criteria_version       TEXT NOT NULL,
  notify                 INTEGER NOT NULL DEFAULT 1 CHECK (notify IN (0,1)),
  created_by_user_id     TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  created_by_name        TEXT,                      -- snapshot
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  rev                    INTEGER NOT NULL DEFAULT 1,
  rev_at                 INTEGER,
  rev_by_user_id         TEXT,
  rev_by_name            TEXT,                      -- snapshot
  last_criteria_version  TEXT,
  last_brief_version     INTEGER,
  last_reconciled_at     INTEGER,
  CHECK (mode <> 'live_linked' OR source_type = 'brief')
) STRICT;
CREATE INDEX dynamic_watchlists_org_status_updated ON dynamic_watchlists (org_id, status, updated_at);

-- source: db.dynamicWatchlists[].criteria.{required[],preferred[]}  m19/criteria.mjs:264 (validateCriteria output)
-- owner/writer: m19/index.mjs (replaced wholesale on criteria change; never for live_linked)
-- mapping: each criterion -> one row: class -> class; id -> criterion_id (stable
--   'type:operator:k=v,...'); type -> type; operator -> operator; the type-specific
--   normalised body (values[], value, primaryOnly, evidenceKind, protocol) -> params_json
--   (retained JSON: the body shape varies per criterion type and is consumed only by
--   matchPlayerToCriteria as a unit; criterion_id already encodes it canonically)
-- notes: dedupe key is (class, criterion_id) — same test twice is one test.
CREATE TABLE watchlist_criteria (
  watchlist_id  TEXT NOT NULL REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  class         TEXT NOT NULL CHECK (class IN ('required','preferred')),
  criterion_id  TEXT NOT NULL,
  position      INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('position','age','geography','level','foot','availability','evidence','evidence_recency','trust_band','combine_result','combine_measurement')),
  operator      TEXT NOT NULL CHECK (operator IN ('in','equals','between','gte','lte','within_radius','within_days','exists')),
  params_json   TEXT NOT NULL CHECK (json_valid(params_json)),
  PRIMARY KEY (watchlist_id, class, criterion_id)
) STRICT;

-- source: db.dynamicWatchlists[].lastMembership[] + .lastMatchSnapshot{}  m19/index.mjs:409,415
-- owner/writer: m19/index.mjs reconcile (replaced wholesale on every recorded reconcile)
-- lifecycle: derived cache of the last evaluation — kept because the NEXT
--   reconcile diffs against it to explain transitions; a null lastMembership
--   (never evaluated) is "no rows and last_reconciled_at IS NULL"
-- mapping: each player id -> (watchlist_id, player_id); lastMatchSnapshot[playerId].required[]
--   -> required_met_json ([{criterionId, met}] — only the required lines' met flags,
--   consumed as a unit by explainTransition; never queried per criterion)
CREATE TABLE watchlist_memberships (
  watchlist_id       TEXT NOT NULL REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  required_met_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_met_json)),
  PRIMARY KEY (watchlist_id, player_id)
) STRICT;

-- source: db.dynamicWatchlists[].history[]  via audit() m12/shared.mjs:70
-- owner/writer: m19/index.mjs
-- lifecycle: append-only; actions watchlist_created | watchlist_updated | watchlist_archived
-- mapping: id -> id (aud-*); (parent) -> watchlist_id; at -> at; byKind -> by_kind ('org'); byId -> by_id; byName -> by_name; action -> action; detail -> detail_json
CREATE TABLE dynamic_watchlists_history (
  id            TEXT PRIMARY KEY,
  watchlist_id  TEXT NOT NULL REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  by_kind       TEXT,
  by_id         TEXT,
  by_name       TEXT,
  action        TEXT NOT NULL,
  detail_json   TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX dynamic_watchlists_history_watchlist_at ON dynamic_watchlists_history (watchlist_id, at);

-- source: db.watchlistHistory  created at m19/index.mjs:378 (reconcile)
-- owner/writer: m19/index.mjs (reconcile only); read by GET /watchlists/:id/history and lastChangeSummary
-- lifecycle: append-only; never pruned
-- naming: called watchlist_membership_events here, NOT watchlist_history — the
--   `<table>_history` suffix is reserved for audit trails (dynamic_watchlists_history
--   above) and this store is a domain event log of membership transitions.
-- mapping:
--   id -> id (wlh-*)
--   watchlistId -> watchlist_id
--   orgId -> org_id
--   playerId -> player_id
--   transition -> transition
--   reason -> reason
--   criterionId -> criterion_id (the criterion that flipped, or null)
--   text -> text (explanation copy at the time)
--   criteriaVersion -> criteria_version
--   briefVersion -> brief_version
--   policyVersion -> policy_version
--   at -> at
--   fingerprint -> fingerprint ('wl:<wl>:<player>:<cv>:<transition>:<reason>', UNIQUE — enforced by code today)
-- notes: a player who later becomes invisible keeps the row; the name is
--   resolved live and withheld. Read patterns: (watchlist_id, at desc, id)
--   cursor pages; max(at) batch for the summary; fingerprint existence.
CREATE TABLE watchlist_membership_events (
  id                TEXT PRIMARY KEY,
  watchlist_id      TEXT NOT NULL REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  org_id            TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id         TEXT REFERENCES players(id) ON DELETE SET NULL,
  transition        TEXT NOT NULL CHECK (transition IN ('entered','left')),
  reason            TEXT NOT NULL CHECK (reason IN ('criterion_now_met','criteria_changed','brief_changed','newly_visible','first_evaluation','criterion_no_longer_met','unavailable')),
  criterion_id      TEXT,
  text              TEXT NOT NULL,
  criteria_version  TEXT NOT NULL,
  brief_version     INTEGER,
  policy_version    INTEGER NOT NULL,
  at                INTEGER NOT NULL,
  fingerprint       TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX watchlist_membership_events_fingerprint ON watchlist_membership_events (fingerprint);
CREATE INDEX watchlist_membership_events_watchlist_at ON watchlist_membership_events (watchlist_id, at, id);


-- =============================================================================
-- M21 — Development Hub
-- =============================================================================

-- source: db.developmentPlans  created at m21/index.mjs:525
-- owner/writer: m21/index.mjs (same routes mounted on player/guardian/org routers)
-- lifecycle: status draft -> active -> paused | completed -> ... -> archived (PLAN_TRANSITIONS);
--   archived is terminal and read-only; completed can be reopened; never deleted;
--   max 5 non-(archived|completed) per (player, owner kind, owner org)
-- mapping:
--   id -> id (devplan-*)
--   playerId -> player_id
--   owner.kind -> owner_kind
--   owner.orgId -> owner_org_id (null for player-owned)
--   owner.orgName -> owner_org_name
--   createdBy{kind,id,name} -> created_by_kind / created_by_id / created_by_name
--     (kind 'player' | 'guardian' | 'org' — 'org' carries an org_user id)
--   title -> title (<=120)
--   status -> status
--   visibility -> visibility (VISIBILITY_BY_OWNER: player -> private|player_guardian|shared_with_org; org -> org_private|player_guardian)
--   sharedWithOrgIds[] -> development_plan_shares (child; player-owned plans only; cleared when visibility narrows)
--   startDate -> start_at (epoch ms: parseDate yields an instant; defaults to createdAt)
--   nextReviewAt -> next_review_at
--   endDate -> end_at (epoch ms instant, not a calendar day)
--   templateId -> template_id
--   originObjectiveId -> origin_objective_id (M12 bridge, validated for the same player)
--   originTrialId -> origin_trial_id (ALWAYS null today: written as null, never set; kept nullable, no FK)
--   createdAt / updatedAt -> created_at / updated_at
--   rev / revAt / revBy{userId,name} -> rev / rev_at / rev_by_user_id / rev_by_name
--   completedAt / archivedAt -> completed_at / archived_at
--   history[] -> development_plans_history (timeline is projected from it; no separate event log)
-- notes: minors read-only on own plan; guardian manages while minor; org access
--   needs orgCanSee + ownership/share. Read patterns: list scan with
--   (player_id[, status]); active-count per (player_id, owner_kind, owner_org_id, status);
--   idempotent-create match (player_id, title, created_by_id, created_at window).
CREATE TABLE development_plans (
  id                   TEXT PRIMARY KEY,
  player_id            TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  owner_kind           TEXT NOT NULL CHECK (owner_kind IN ('player','org')),
  owner_org_id         TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  owner_org_name       TEXT,                      -- snapshot
  created_by_kind      TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id        TEXT NOT NULL,
  created_by_name      TEXT,                      -- snapshot
  title                TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('draft','active','paused','completed','archived')),
  visibility           TEXT NOT NULL CHECK (visibility IN ('private','player_guardian','shared_with_org','org_private')),
  start_at             INTEGER NOT NULL,
  next_review_at       INTEGER,
  end_at               INTEGER,
  template_id          TEXT CHECK (template_id IS NULL OR template_id IN ('technical_development','positional_development','trial_follow_up')),
  origin_objective_id  TEXT REFERENCES dev_objectives(id) ON DELETE SET NULL,
  origin_trial_id      TEXT,                      -- never set today
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  rev                  INTEGER NOT NULL DEFAULT 1,
  rev_at               INTEGER,
  rev_by_user_id       TEXT,
  rev_by_name          TEXT,                      -- snapshot
  completed_at         INTEGER,
  archived_at          INTEGER,
  CHECK ((owner_kind = 'org') = (owner_org_id IS NOT NULL)),
  CHECK ((owner_kind = 'player' AND visibility IN ('private','player_guardian','shared_with_org'))
      OR (owner_kind = 'org' AND visibility IN ('org_private','player_guardian')))
) STRICT;
CREATE INDEX development_plans_player_owner ON development_plans (player_id, owner_kind, owner_org_id, status);
CREATE INDEX development_plans_owner_org ON development_plans (owner_org_id, updated_at);

-- source: db.developmentPlans[].sharedWithOrgIds[]  m21/index.mjs:688 (share) / :677 (revoke) / :603 (narrowing clears all)
-- owner/writer: m21/index.mjs (player-owned plans only; the org must be able to see the player)
-- mapping: each org id -> (plan_id, org_id); the share/unshare moment is in development_plans_history
CREATE TABLE development_plan_shares (
  plan_id  TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  org_id   TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, org_id)
) STRICT;
CREATE INDEX development_plan_shares_org ON development_plan_shares (org_id);

-- source: db.developmentPlans[].history[]  via audit() m12/shared.mjs:70 (writeHistory, m21/index.mjs:165)
-- owner/writer: m21/index.mjs
-- lifecycle: append-only; actions are TIMELINE_ACTIONS keys (plan_created, plan_activated,
--   plan_paused, plan_completed, plan_archived, plan_shared, plan_unshared,
--   plan_visibility_changed) plus 'plan_updated' fallback
-- mapping: id -> id (aud-*); (parent) -> plan_id; at -> at; byKind -> by_kind; byId -> by_id; byName -> by_name; action -> action; detail -> detail_json (server-written ids/status names only)
CREATE TABLE development_plans_history (
  id           TEXT PRIMARY KEY,
  plan_id      TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX development_plans_history_plan_at ON development_plans_history (plan_id, at);

-- source: db.developmentGoals  created at m21/index.mjs:1134 (newGoal)
-- owner/writer: m21/index.mjs (create with plan or later; patch with rev guard)
-- lifecycle: status not_started -> in_progress -> blocked | achieved | stopped (GOAL_TRANSITIONS,
--   achieved/stopped reversible); never deleted; max 20 per plan
-- mapping:
--   id -> id (devgoal-*)
--   planId -> plan_id
--   playerId -> player_id (denormalised from the plan)
--   title -> title (<=120)
--   description -> description (<=1000)
--   category -> category
--   status -> status
--   blockReason -> block_reason (set only while blocked)
--   blockNote -> block_note (<=300)
--   targetDate -> target_at (epoch ms instant from parseDate)
--   target{sourceType,protocolId,protocolVersion,metricType,metricUnit,operator,value,protocolTitle,direction,precision}
--     -> target_source_type / target_protocol_id / target_protocol_version / target_metric_type /
--        target_metric_unit / target_operator / target_value / target_protocol_title /
--        target_direction / target_precision (all null when no target; frozen at creation)
--   originObjectiveId -> origin_objective_id
--   createdBy{kind,id,name} -> created_by_kind / created_by_id / created_by_name
--   createdAt / updatedAt / completedAt -> created_at / updated_at / completed_at
--   rev / revAt / revBy{userId,name} -> rev / rev_at / rev_by_user_id / rev_by_name
--   history[] -> development_goals_history
-- notes: targetState is derived at read from combine_attempts (never stored);
--   meeting a target never auto-achieves. No health vocabulary by design.
CREATE TABLE development_goals (
  id                       TEXT PRIMARY KEY,
  plan_id                  TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  player_id                TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL,
  description              TEXT,
  category                 TEXT NOT NULL CHECK (category IN ('technical','tactical','physical','psychological','match_understanding','position_specific','other')),
  status                   TEXT NOT NULL CHECK (status IN ('not_started','in_progress','blocked','achieved','stopped')),
  block_reason             TEXT CHECK (block_reason IS NULL OR block_reason IN ('waiting_for_assessment','schedule','facility','coach_review','other')),
  block_note               TEXT,
  target_at                INTEGER,
  target_source_type       TEXT CHECK (target_source_type IS NULL OR target_source_type IN ('combine_attempt')),
  target_protocol_id       TEXT,
  target_protocol_version  INTEGER,
  target_metric_type       TEXT CHECK (target_metric_type IS NULL OR target_metric_type IN ('count','time','distance','duration','set','percentage')),
  target_metric_unit       TEXT,
  target_operator          TEXT CHECK (target_operator IS NULL OR target_operator IN ('gte','gt','lte','lt','eq')),
  target_value             REAL,
  target_protocol_title    TEXT,
  target_direction         TEXT CHECK (target_direction IS NULL OR target_direction IN ('higher','lower')),
  target_precision         TEXT CHECK (target_precision IS NULL OR target_precision IN ('integer','tenths','hundredths','centimetres')),
  origin_objective_id      TEXT REFERENCES dev_objectives(id) ON DELETE SET NULL,
  created_by_kind          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id            TEXT NOT NULL,
  created_by_name          TEXT,                  -- snapshot
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  completed_at             INTEGER,
  rev                      INTEGER NOT NULL DEFAULT 1,
  rev_at                   INTEGER,
  rev_by_user_id           TEXT,
  rev_by_name              TEXT,                  -- snapshot
  CHECK ((target_source_type IS NULL) = (target_protocol_id IS NULL))
) STRICT;
CREATE INDEX development_goals_plan_created ON development_goals (plan_id, created_at);

-- source: db.developmentGoals[].history[]  via audit()
-- lifecycle: append-only; actions goal_created, goal_updated, goal_status_changed, goal_target_set, evidence_linked, evidence_unlinked
-- mapping: as development_plans_history with goal_id
CREATE TABLE development_goals_history (
  id           TEXT PRIMARY KEY,
  goal_id      TEXT NOT NULL REFERENCES development_goals(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX development_goals_history_goal_at ON development_goals_history (goal_id, at);

-- source: db.developmentActions  created at m21/index.mjs:840
-- owner/writer: m21/index.mjs (create under a goal; patch — an assignee may tick their own)
-- lifecycle: status todo -> in_progress -> done | blocked | cancelled (ACTION_TRANSITIONS; cancelled terminal);
--   never deleted; max 20 per goal; no rev (deliberately unversioned)
-- mapping:
--   id -> id (devact-*)
--   planId -> plan_id
--   goalId -> goal_id
--   playerId -> player_id (denormalised from the plan)
--   type -> type
--   title -> title (<=120)
--   dueAt -> due_at
--   assignee{kind,id,name} -> assignee_kind / assignee_id / assignee_name
--     (player = the plan's player; guardian = a guardian of the minor; org_user = current staff of the owning org)
--   status -> status
--   createdBy{kind,id,name} -> created_by_kind / created_by_id / created_by_name
--   createdAt / updatedAt / completedAt -> created_at / updated_at / completed_at
--   history[] -> development_actions_history
-- notes: due/overdue is derived at read; there is no scheduler. Read patterns:
--   collectPlan (plan_id OR goal_id in plan's goals); per goal ordered by due_at.
CREATE TABLE development_actions (
  id               TEXT PRIMARY KEY,
  plan_id          TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  goal_id          TEXT NOT NULL REFERENCES development_goals(id) ON DELETE CASCADE,
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('training','assessment','video_review','match_objective','coach_review','combine','box_cam','evidence_request','custom')),
  title            TEXT NOT NULL,
  due_at           INTEGER,
  assignee_kind    TEXT CHECK (assignee_kind IS NULL OR assignee_kind IN ('player','guardian','org_user')),
  assignee_id      TEXT,
  assignee_name    TEXT,                          -- snapshot
  status           TEXT NOT NULL CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
  created_by_kind  TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id    TEXT NOT NULL,
  created_by_name  TEXT,                          -- snapshot
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  completed_at     INTEGER,
  CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL))
) STRICT;
CREATE INDEX development_actions_plan ON development_actions (plan_id);
CREATE INDEX development_actions_goal_due ON development_actions (goal_id, due_at, created_at);

-- source: db.developmentActions[].history[]  via audit()
-- lifecycle: append-only; actions action_created, action_status_changed, action_completed, evidence_linked, evidence_unlinked
CREATE TABLE development_actions_history (
  id           TEXT PRIMARY KEY,
  action_id    TEXT NOT NULL REFERENCES development_actions(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX development_actions_history_action_at ON development_actions_history (action_id, at);

-- source: db.developmentEvidenceLinks  created at m21/index.mjs:951 (EVIDENCE_LINK_FIELDS is the complete key set)
-- owner/writer: m21/index.mjs (link to a goal or an action; DELETE /development/evidence/:linkId is a HARD DELETE)
-- lifecycle: no status; hard-deleted on unlink (the unlink is recorded in the holder's history)
-- mapping:
--   id -> id (devlink-*)
--   planId -> plan_id
--   goalId -> goal_id   } exactly one of the two is set
--   actionId -> action_id }
--   playerId -> player_id (the plan's player; ownership of the cited record is checked at write and read)
--   sourceType -> source_type
--   sourceId -> source_id (polymorphic, no FK: passport_evidence -> evidence(id),
--     assessment -> assessments(id), box_cam_session -> box_sessions(id),
--     combine_attempt -> combine_attempts(id), trial_report -> trials(id))
--   linkedByKind / linkedById / linkedByName -> linked_by_kind / linked_by_id / linked_by_name
--   linkedAt -> linked_at
-- notes: a link stores a reference and no content — everything is resolved live.
--   UNIQUE (target, source_type, source_id) enforced by code today (max 30 per target).
CREATE TABLE development_evidence_links (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  goal_id         TEXT REFERENCES development_goals(id) ON DELETE CASCADE,
  action_id       TEXT REFERENCES development_actions(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL CHECK (source_type IN ('passport_evidence','assessment','box_cam_session','combine_attempt','trial_report')),
  source_id       TEXT NOT NULL,
  linked_by_kind  TEXT NOT NULL CHECK (linked_by_kind IN ('player','guardian','org')),
  linked_by_id    TEXT NOT NULL,
  linked_by_name  TEXT,                           -- snapshot
  linked_at       INTEGER NOT NULL,
  CHECK ((goal_id IS NULL) <> (action_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX development_evidence_links_target_source ON development_evidence_links (coalesce(goal_id, action_id), source_type, source_id);
CREATE INDEX development_evidence_links_plan ON development_evidence_links (plan_id);

-- source: db.developmentReviews  created at m21/index.mjs:1035
-- owner/writer: m21/index.mjs (submit; share summary later; supersede = new row)
-- lifecycle: APPEND-ONLY — no PATCH route exists; corrections are a new review
--   naming `supersedes`, and the old row gets `supersededBy`. Never deleted.
-- mapping:
--   id -> id (devrev-*)
--   planId -> plan_id
--   playerId -> player_id
--   reviewerKind -> reviewer_kind (follows from who the viewer is, never chosen)
--   reviewedBy{kind,id,name} -> reviewed_by_kind / reviewed_by_id / reviewed_by_name
--   orgId -> org_id (coach reviews only)
--   reviewedAt -> reviewed_at
--   sharedSummary -> shared_summary (<=2000)
--   internalNote -> internal_note (<=2000; club-private — stripped unless access.readInternal; never shared)
--   goalSnapshots[] -> development_review_goal_snapshots (child table — see its header for why)
--   nextReviewAt -> next_review_at
--   sharedWithPlayerAt -> shared_with_player_at (reflections: always = created_at)
--   shareScopes[] -> share_summary / share_goals / share_actions (SHARE_SCOPES is a fixed
--     3-value set; three booleans replace the array exactly)
--   supersedes -> supersedes_review_id
--   supersededBy -> superseded_by_review_id
--   createdAt -> created_at
--   history[] -> development_reviews_history
-- notes: internal_note is the most sensitive column in this file (club talking
--   to itself about a player who may read the same plan). Read patterns:
--   (plan_id, reviewed_at desc, id) cursor pages; idempotent-create match on
--   (plan_id, reviewed_by_id, shared_summary, internal_note, created_at window).
CREATE TABLE development_reviews (
  id                        TEXT PRIMARY KEY,
  plan_id                   TEXT NOT NULL REFERENCES development_plans(id) ON DELETE CASCADE,
  player_id                 TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reviewer_kind             TEXT NOT NULL CHECK (reviewer_kind IN ('player_reflection','guardian_reflection','coach_review')),
  reviewed_by_kind          TEXT NOT NULL CHECK (reviewed_by_kind IN ('player','guardian','org')),
  reviewed_by_id            TEXT NOT NULL,
  reviewed_by_name          TEXT,                 -- snapshot
  org_id                    TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
  reviewed_at               INTEGER NOT NULL,
  shared_summary            TEXT,
  internal_note             TEXT,                 -- club-private
  next_review_at            INTEGER,
  shared_with_player_at     INTEGER,
  share_summary             INTEGER NOT NULL DEFAULT 0 CHECK (share_summary IN (0,1)),
  share_goals               INTEGER NOT NULL DEFAULT 0 CHECK (share_goals IN (0,1)),
  share_actions             INTEGER NOT NULL DEFAULT 0 CHECK (share_actions IN (0,1)),
  supersedes_review_id      TEXT REFERENCES development_reviews(id) ON DELETE RESTRICT,
  superseded_by_review_id   TEXT REFERENCES development_reviews(id) ON DELETE RESTRICT,
  created_at                INTEGER NOT NULL,
  CHECK (shared_summary IS NOT NULL OR internal_note IS NOT NULL),
  CHECK ((reviewer_kind = 'coach_review') = (org_id IS NOT NULL))
) STRICT;
CREATE INDEX development_reviews_plan_reviewed ON development_reviews (plan_id, reviewed_at, id);
CREATE UNIQUE INDEX development_reviews_supersedes ON development_reviews (supersedes_review_id);

-- source: db.developmentReviews[].goalSnapshots[]  built at m21/reviews.mjs:35 (buildGoalSnapshots)
-- owner/writer: m21/index.mjs (write-once with the review)
-- lifecycle: immutable point-in-time copy of goal state at review time
-- why a child table and not JSON: each snapshot is a fixed, typed row keyed by
--   a real goal id — status, four action counts, a target state and a measured
--   value — and the whole value of a review is reading "what was true then" per
--   goal next to what is true now. A row per goal lets that comparison be a
--   join (review snapshot vs development_goals) rather than a JSON walk, and
--   keeps the sensitive text (summary/note) on the parent only.
-- mapping:
--   goalId -> goal_id
--   title -> title (snapshot) ; category -> category (snapshot) ; status -> status (snapshot)
--   actionCounts.total / .done / .blocked / .cancelled -> actions_total / actions_done / actions_blocked / actions_cancelled
--   completion{done, of, phrase} -> derived, not stored: of = total - cancelled; phrase = "<done> of <of> actions completed"
--   evidenceRefs[] -> evidence_refs_json (retained JSON: frozen list of {sourceType, sourceId}
--     references cited at review time — references, not evidence; resolved live when read, never queried)
--   targetStateAtReview{state, reason, measured} -> target_state / target_reason / target_measured
--   (array position) -> position
CREATE TABLE development_review_goal_snapshots (
  review_id          TEXT NOT NULL REFERENCES development_reviews(id) ON DELETE CASCADE,
  goal_id            TEXT NOT NULL REFERENCES development_goals(id) ON DELETE RESTRICT,
  position           INTEGER NOT NULL,
  title              TEXT NOT NULL,                -- snapshot
  category           TEXT NOT NULL,                -- snapshot
  status             TEXT NOT NULL CHECK (status IN ('not_started','in_progress','blocked','achieved','stopped')),
  actions_total      INTEGER NOT NULL DEFAULT 0,
  actions_done       INTEGER NOT NULL DEFAULT 0,
  actions_blocked    INTEGER NOT NULL DEFAULT 0,
  actions_cancelled  INTEGER NOT NULL DEFAULT 0,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_refs_json)),
  target_state       TEXT CHECK (target_state IS NULL OR target_state IN ('target_met','target_not_met','no_current_valid_measurement')),
  target_reason      TEXT CHECK (target_reason IS NULL OR target_reason IN ('no_attempts','no_production_valid_attempt','protocol_version_mismatch','measurement_invalidated')),
  target_measured    REAL,
  PRIMARY KEY (review_id, goal_id)
) STRICT;

-- source: db.developmentReviews[].history[]  via audit()
-- lifecycle: append-only; actions review_submitted, review_shared, review_superseded
CREATE TABLE development_reviews_history (
  id           TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES development_reviews(id) ON DELETE CASCADE,
  at           INTEGER NOT NULL,
  by_kind      TEXT,
  by_id        TEXT,
  by_name      TEXT,
  action       TEXT NOT NULL,
  detail_json  TEXT CHECK (json_valid(detail_json) OR detail_json IS NULL)
) STRICT;
CREATE INDEX development_reviews_history_review_at ON development_reviews_history (review_id, at);


-- =============================================================================
-- M13 F4 — exposure, review queue, evidence gaps
-- =============================================================================

-- source: db.exposureEvents  created at m13/insight.mjs:28 (recordExposure; passive hook on GET /org/players/:id[/passport] + POST /exposure/impressions)
-- owner/writer: m13/insight.mjs
-- lifecycle: append-only; capped at 50,000 rows globally (oldest 10,000 spliced) —
--   a retention rule the repository must reproduce (delete oldest by at)
-- mapping:
--   id -> id (exp-*)
--   orgId -> org_id
--   playerId -> player_id (profile/evidence views take the id from the URL after a 200 response)
--   kind -> kind
--   day -> day_index (integer UTC day number = floor(at / 86400000); the dedupe key)
--   at -> at
-- notes: UNIQUE (org_id, player_id, kind, day_index) enforced by code today.
--   Players see only coarse 90-day bands, never which org. Read patterns:
--   (org, day_index >= since) funnel/queue; (player, day_index >= since).
CREATE TABLE exposure_events (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('impression','profile_view','evidence_view')),
  day_index  INTEGER NOT NULL,
  at         INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX exposure_events_org_player_kind_day ON exposure_events (org_id, player_id, kind, day_index);
CREATE INDEX exposure_events_org_day ON exposure_events (org_id, day_index);
CREATE INDEX exposure_events_player_day ON exposure_events (player_id, day_index);

-- source: db.reviewLater  created at m13/insight.mjs:151 (delete-then-insert per (org, player))
-- owner/writer: m13/insight.mjs (defer; insightSweep sets remindedAt); read by m18 (review_deferred signal)
-- lifecycle: HARD DELETE on re-defer (replace); otherwise rows stay forever
-- mapping:
--   id -> id (rvl-*)
--   orgId -> org_id
--   playerId -> player_id (taken from the URL, NOT validated against players today)
--   byUserId -> by_user_id
--   dueAt -> due_at (1–60 days ahead)
--   remindedAt -> reminded_at
-- notes: UNIQUE (org_id, player_id) enforced by code via delete+insert (new as a constraint).
CREATE TABLE review_later (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  by_user_id   TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  due_at       INTEGER NOT NULL,
  reminded_at  INTEGER
) STRICT;
CREATE UNIQUE INDEX review_later_org_player ON review_later (org_id, player_id);
CREATE INDEX review_later_due ON review_later (due_at, reminded_at);

-- source: db.evidenceSuggestions  created at m13/insight.mjs:449 (computeGaps — upserted on GET /players/:id/evidence-gaps; also via ctx.computeEvidenceGaps / ctx.requestEvidenceGap from M17 rooms)
-- owner/writer: m13/insight.mjs; read by m18 (evidence_gap_closed when status becomes 'supplied')
-- lifecycle: status suggested -> requested -> supplied -> reviewed; suggested -> dismissed;
--   open rows (suggested|requested) whose rule no longer fires become 'supplied'; never deleted
-- mapping:
--   id -> id (gap-*)
--   orgId -> org_id
--   playerId -> player_id
--   playerName -> player_name
--   ruleId -> rule_id (RULES registry in m13/insight.mjs)
--   ruleVersion -> rule_version
--   records[] -> records_json (retained JSON: polymorphic ids cited by the rule —
--     player media ids, assessment ids or evidence ids depending on rule_id;
--     rewritten on every recompute, displayed as "the records behind it", never queried)
--   explanation -> explanation (club-private wording)
--   action -> action (the rule's recommended action copy)
--   status -> status
--   requestedAt -> requested_at (anti-pestering: one request per (org, player, rule) per 14 days)
--   createdAt / updatedAt -> created_at / updated_at
-- notes: the player-facing text is whitelisted per rule, never the explanation.
--   Read patterns: (org, player) list; (org, player, rule_id, requested_at) window check.
CREATE TABLE evidence_suggestions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  player_name   TEXT,                             -- snapshot
  rule_id       TEXT NOT NULL CHECK (rule_id IN ('no_recent_footage','single_match_sample','attribute_never_observed','assessment_disagreement','stale_assessment','uncorroborated_claims')),
  rule_version  INTEGER NOT NULL,
  records_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records_json)),
  explanation   TEXT NOT NULL,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('suggested','requested','supplied','dismissed','reviewed')),
  requested_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX evidence_suggestions_org_player ON evidence_suggestions (org_id, player_id, status);
CREATE INDEX evidence_suggestions_org_player_rule ON evidence_suggestions (org_id, player_id, rule_id, requested_at);


-- =============================================================================
-- M13 F5 — scout calibration sessions
-- =============================================================================

-- source: db.calibrationSessions  created at m13/insight.mjs:217
-- owner/writer: m13/insight.mjs (lead creates/closes; participants submit blind; notes)
-- lifecycle: status open -> closed; never deleted
-- mapping:
--   id -> id (cal-*)
--   orgId -> org_id
--   title -> title (<=120)
--   templateId / templateVersion -> template_id / template_version (assessmentTemplates key (id, version); no FK — the template id is reused across versions, see 02)
--   attributesSnapshot -> attributes_snapshot_json (retained JSON: the rubric's attribute list
--     [{id,label,...}] pinned at creation so later template edits change nothing; read as a whole)
--   mediaId -> media_id (reference footage; must be visible to the org at creation; access re-checked on read)
--   participants[] -> calibration_participants (child)
--   submissions[] -> calibration_submissions (+ calibration_ratings)
--   notes[] -> calibration_notes
--   status -> status
--   createdBy -> created_by_user_id
--   createdAt / closedAt -> created_at / closed_at
-- notes: blind until the viewer has submitted or the session is closed; comparison derived.
CREATE TABLE calibration_sessions (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  title                     TEXT NOT NULL,
  template_id               TEXT NOT NULL,
  template_version          INTEGER NOT NULL,
  attributes_snapshot_json  TEXT NOT NULL CHECK (json_valid(attributes_snapshot_json)),
  media_id                  TEXT REFERENCES player_media(id) ON DELETE SET NULL,
  status                    TEXT NOT NULL CHECK (status IN ('open','closed')),
  created_by_user_id        TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  created_at                INTEGER NOT NULL,
  closed_at                 INTEGER
) STRICT;
CREATE INDEX calibration_sessions_org ON calibration_sessions (org_id, created_at);

-- source: db.calibrationSessions[].participants[]  m13/insight.mjs:214 (validated current org users; >=2)
-- mapping: each user id -> (session_id, user_id)
CREATE TABLE calibration_participants (
  session_id  TEXT NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES org_users(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, user_id)
) STRICT;

-- source: db.calibrationSessions[].submissions[]  created at m13/insight.mjs:291
-- owner/writer: m13/insight.mjs (one per participant, final)
-- mapping:
--   (no id) -> id (new, minted calsub-<n>)
--   (parent) -> session_id
--   userId / userName -> user_id / user_name
--   ratings[] -> calibration_ratings (child)
--   confidence -> confidence
--   submittedAt -> submitted_at
-- notes: UNIQUE (session_id, user_id) enforced by code ("blind submissions are final").
CREATE TABLE calibration_submissions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  user_name     TEXT,                             -- snapshot
  confidence    TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  submitted_at  INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX calibration_submissions_session_user ON calibration_submissions (session_id, user_id);

-- source: db.calibrationSessions[].submissions[].ratings[]  m13/insight.mjs:287
-- mapping: {attrId, value 1–5, notObserved} -> (submission_id, attr_id, value, not_observed);
--   attr_id must be an id inside the parent session's attributes_snapshot_json
CREATE TABLE calibration_ratings (
  submission_id  TEXT NOT NULL REFERENCES calibration_submissions(id) ON DELETE CASCADE,
  attr_id        TEXT NOT NULL,
  value          INTEGER CHECK (value IS NULL OR (value BETWEEN 1 AND 5)),
  not_observed   INTEGER NOT NULL DEFAULT 0 CHECK (not_observed IN (0,1)),
  PRIMARY KEY (submission_id, attr_id),
  CHECK ((not_observed = 1) = (value IS NULL))
) STRICT;

-- source: db.calibrationSessions[].notes[]  created at m13/insight.mjs:315
-- lifecycle: append-only discussion notes (after own submission or close)
-- mapping: (no id) -> id (new, minted calnote-<n>); (parent) -> session_id; at -> created_at (source field is `at`);
--   byUserId / byName -> by_user_id / by_name; text -> text (<=500)
CREATE TABLE calibration_notes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  by_user_id  TEXT REFERENCES org_users(id) ON DELETE SET NULL,
  by_name     TEXT,                               -- snapshot
  text        TEXT NOT NULL
) STRICT;
CREATE INDEX calibration_notes_session_at ON calibration_notes (session_id, created_at);


-- =============================================================================
-- M13 F7 — fixtures, coverage plans, coverage assignments
-- =============================================================================

-- source: db.fixtures  created at m13/planning.mjs:65 (org's OWN fixture records)
-- owner/writer: m13/planning.mjs
-- lifecycle: no status, never deleted
-- mapping:
--   id -> id (fix-*)
--   orgId -> org_id
--   source -> source ('own' only; the read-time union adds synthetic 'friendly_board' /
--     'open_trial' rows with ids fr-<id> / tr-<id> that are NOT stored)
--   competition -> competition (<=80 or null)
--   home / away -> home / away (<=80)
--   date -> fixture_date (sliced to 10 chars, NOT validated today; migration verifies YYYY-MM-DD)
--   location.lat / .lng / .city -> lat / lng / city (all null when no location)
--   createdBy -> created_by_name (display name only; no user id stored)
--   createdAt -> created_at
-- notes: read pattern: org's fixtures by date (union with friendlies/open trials at read).
CREATE TABLE fixtures (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source           TEXT NOT NULL DEFAULT 'own' CHECK (source IN ('own')),
  competition      TEXT,
  home             TEXT NOT NULL,
  away             TEXT NOT NULL,
  fixture_date     TEXT NOT NULL CHECK (length(fixture_date) = 10),
  lat              REAL,
  lng              REAL,
  city             TEXT,
  created_by_name  TEXT,                          -- snapshot
  created_at       INTEGER NOT NULL,
  CHECK ((lat IS NULL) = (lng IS NULL))
) STRICT;
CREATE INDEX fixtures_org_date ON fixtures (org_id, fixture_date);

-- source: db.coveragePlans  created at m13/planning.mjs:105
-- owner/writer: m13/planning.mjs (lead only)
-- lifecycle: no status, never deleted
-- mapping:
--   id -> id (cvp-*)
--   orgId -> org_id
--   label -> label (<=100)
--   competition -> competition (<=80; progress counts only assignments with the same fixture_competition)
--   region -> region (<=80, informational)
--   goalObservations -> goal_observations (1–200)
--   windowDays -> window_days (7–365)
--   createdBy -> created_by_name (display name only)
--   createdAt -> created_at
-- notes: progress {done, goal, complete} is derived at read from coverage_assignments.
CREATE TABLE coverage_plans (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  label              TEXT NOT NULL,
  competition        TEXT,
  region             TEXT,
  goal_observations  INTEGER NOT NULL,
  window_days        INTEGER NOT NULL,
  created_by_name    TEXT,                        -- snapshot
  created_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX coverage_plans_org ON coverage_plans (org_id);

-- source: db.coverageAssignments  created at m13/planning.mjs:145
-- owner/writer: m13/planning.mjs (lead assigns/cancels; scout or lead completes)
-- lifecycle: soft-cancelled via cancelled_at; completed via observed_at; never deleted
-- mapping:
--   id -> id (cva-*)
--   orgId -> org_id
--   fixtureId -> (fixture_kind, fixture_id): polymorphic. The source stores one string —
--     'fix-*' for an own fixtures(id), 'fr-<friendly id>' for a friendlies board row,
--     'tr-<open trial id>' for an open trial. The migration splits the prefix into
--     fixture_kind and stores the underlying id; no FK (two of the targets are read-time
--     synthetic views). Duplicate-visit warning keys on it.
--   fixtureDate -> fixture_date (snapshot of the fixture's date; clash check keys on it)
--   fixtureLabel -> fixture_label ("<home> v <away>")
--   fixtureCompetition -> fixture_competition
--   scoutUserId / scoutName -> scout_user_id / scout_name
--   targetPlayerIds[] -> coverage_assignment_targets (child; only players visible to the org at creation)
--   travelBudget{amountMinor, currency, enteredBy} -> travel_budget_minor / travel_currency / travel_budget_entered_by_name
--     (all null when no valid budget was supplied)
--   travelNote -> derived, not stored: constant copy ("no routing provider is configured")
--   warnings[] -> warnings_json (retained JSON: free-form warning sentences computed at
--     creation — duplicate visit / scout clash — returned verbatim; free-form by design)
--   assignedBy -> assigned_by_name (display name only)
--   createdAt -> created_at
--   observedAt -> observed_at
--   assessmentIds[] -> coverage_assignment_assessments (child)
--   cancelledAt -> cancelled_at
-- notes: read patterns: org open list (org_id, cancelled_at IS NULL) [scout-only filter];
--   duplicate check (org, fixture); clash (org, scout, fixture_date); plan progress
--   (org, observed_at >= since[, fixture_competition]); covered set (org, fixture).
CREATE TABLE coverage_assignments (
  id                             TEXT PRIMARY KEY,
  org_id                         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  fixture_kind                   TEXT NOT NULL CHECK (fixture_kind IN ('own','friendly_board','open_trial')),
  fixture_id                     TEXT NOT NULL,
  fixture_date                   TEXT CHECK (fixture_date IS NULL OR length(fixture_date) = 10),
  fixture_label                  TEXT NOT NULL,     -- snapshot
  fixture_competition            TEXT,              -- snapshot
  scout_user_id                  TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                     TEXT,              -- snapshot
  travel_budget_minor            INTEGER,
  travel_currency                TEXT CHECK (travel_currency IS NULL OR length(travel_currency) = 3),
  travel_budget_entered_by_name  TEXT,              -- snapshot
  warnings_json                  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  assigned_by_name               TEXT,              -- snapshot
  created_at                     INTEGER NOT NULL,
  observed_at                    INTEGER,
  cancelled_at                   INTEGER,
  CHECK ((travel_budget_minor IS NULL) = (travel_currency IS NULL))
) STRICT;
CREATE INDEX coverage_assignments_org_fixture ON coverage_assignments (org_id, fixture_kind, fixture_id, cancelled_at);
CREATE INDEX coverage_assignments_org_scout_date ON coverage_assignments (org_id, scout_user_id, fixture_date);
CREATE INDEX coverage_assignments_org_observed ON coverage_assignments (org_id, observed_at);

-- source: db.coverageAssignments[].targetPlayerIds[]  m13/planning.mjs:138
-- mapping: each id -> (assignment_id, player_id)
CREATE TABLE coverage_assignment_targets (
  assignment_id  TEXT NOT NULL REFERENCES coverage_assignments(id) ON DELETE CASCADE,
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, player_id)
) STRICT;

-- source: db.coverageAssignments[].assessmentIds[]  m13/planning.mjs:173 (pushed on complete, validated as the org's own assessment)
-- mapping: each id -> (assignment_id, assessment_id)
CREATE TABLE coverage_assignment_assessments (
  assignment_id  TEXT NOT NULL REFERENCES coverage_assignments(id) ON DELETE CASCADE,
  assessment_id  TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, assessment_id)
) STRICT;


-- =============================================================================
-- not tables:
-- =============================================================================
-- Code registries (versioned, referenced by id[@version] from the tables above):
--   m16/drills.mjs DRILLS (drill_id@drill_version), PROVIDERS (provider_id/version),
--   LIVENESS_CHALLENGES; m16/combineShared.mjs COMBINE_PROTOCOLS (protocol_id@version,
--   measurement_algorithm_version); m22/policy.mjs CANDIDATE_PROTOCOLS, FRAME_LIMITS,
--   CV_ENGINE_VERSION / BOX_CAM_CV_POLICY_VERSION; m22/eligibility.mjs validation
--   record (combine eligibility, currently empty); m21/shared.mjs vocabularies,
--   GOAL_LIBRARY, PLAN_TEMPLATES, M21_LIMITS; m18/shared.mjs CHANGE_TYPES,
--   REASON_CHANGE_MAP, POLICY, EVALUATION_SIGNALS, POSITIONS, TRUST_BANDS,
--   EVIDENCE_REQUIREMENTS; m19/criteria.mjs CRITERION_TYPES, OPERATORS;
--   m13/insight.mjs RULES (evidence-gap rule engine); server.mjs DRILLS (legacy
--   drill registry seeding drill_guidance).
-- In-memory state (lost on restart by design, never persisted):
--   rate-limit buckets (m181/rateLimit.mjs), box dispute windows (m16/training.mjs
--   disputeWindows), SSE buffers, M22 ProductionCvProvider sessions / byBoxCamSession
--   maps / FrameQueue / ObservationRun / ObservationSessions runtime, metrics counters
--   (metrics.boxCam, metrics.development), criteriaVersion VERSION_MEMO (WeakMap),
--   fault rules.
-- Derived values (computed on read, never stored): Box Streak / Box Bests /
--   developmentActivity, challenge participants count, assignment lastResult and
--   sessionsCompleted, Combine live state (liveCombineState) / personal bests /
--   projection / comparison matrix / requestState, Second Look candidates and
--   trust movement, Nobody Missed candidates and evaluation coverage (incl. n<3
--   suppression), watchlist membership (reconciled on read), M21 due/overdue
--   states, target states, evidence availability, action counts, timeline
--   (projected from *_history), plan summary; exposure funnel / review queue /
--   discovery rotation; coverage plan progress; the read-time fixture union
--   (fr-*/tr-* synthetic rows); calibration comparison.
-- Reserved / dead: db.boxSessionEvents (declared, never written — see note above
--   box_session_integrity_events); boxAssignments 'superseded' state (checked, never
--   written); developmentPlans.originTrialId (always null); boxCamCvResults.combineVerified
--   (always false while real-world validation is incomplete).
