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
-- M12 F8 — development objectives · M12 F6 — drill-guidance reviews
-- S12a: IMPLEMENTED, migration 0030_development REGISTERED (repositories/development.mjs, 5 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =============================================================================
--
-- An objective (obj-*) grows from feedback a club published (source_assessment_id: no key, the assessment is another
-- domain's record, checked by the route). One or two items (objx-*), each with up to four exercise references and the
-- player's baseline evidence ids as ordered rows; progress entries (prg-*) name an item of the same objective or none;
-- shares are the organisations the player chose; one open reassessment (ras-*) at a time, its outcome evidence as rows.
-- review_at is an instant (the route refuses a value that is not a date). No completed_at: no route ever set one.
-- Player and evidence ids carry no key (tolerant: an account deletion removes the evidence, the objective keeps the
-- id). The organisation and the staff named are RESTRICT keys.
--
-- Drill guidance: the recording instructions are the same for every combine drill and live in code
-- (domains/development/objectives.mjs DRILL_RECORDING). A row exists only once a named person reviewed the drill; a
-- drill with no row reads as unreviewed.

CREATE TABLE dev_objectives (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  source_assessment_id                     TEXT NOT NULL CHECK (length(source_assessment_id) <= 80 AND length(source_assessment_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  reviewer_user_id                         TEXT NOT NULL CHECK (length(reviewer_user_id) <= 80 AND length(reviewer_user_id) > 0),
  reviewer_name                            TEXT CHECK (reviewer_name IS NULL OR length(reviewer_name) <= 200),
  reviewer_org_name                        TEXT CHECK (reviewer_org_name IS NULL OR length(reviewer_org_name) <= 200),
  review_at                                INTEGER,
  status                                   TEXT NOT NULL CHECK (status IN ('active')),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewer_user_id) REFERENCES org_users(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX dev_objectives_player ON dev_objectives (player_id);

CREATE TABLE dev_objective_items (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  objective_id                             TEXT NOT NULL CHECK (length(objective_id) <= 80 AND length(objective_id) > 0),
  text                                     TEXT NOT NULL CHECK (length(text) <= 200 AND length(text) > 0),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 2),
  FOREIGN KEY (objective_id) REFERENCES dev_objectives(id) ON DELETE CASCADE,
  UNIQUE (objective_id, ord)
) STRICT;

CREATE TABLE dev_objective_item_exercises (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 4),
  ref                                      TEXT NOT NULL CHECK (length(ref) > 0 AND length(ref) <= 200),
  FOREIGN KEY (item_id) REFERENCES dev_objective_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord)
) STRICT;

CREATE TABLE dev_objective_item_evidence (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 50),
  evidence_id                              TEXT NOT NULL CHECK (length(evidence_id) > 0 AND length(evidence_id) <= 80),
  FOREIGN KEY (item_id) REFERENCES dev_objective_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord),
  UNIQUE (item_id, evidence_id)
) STRICT;

CREATE TABLE dev_objective_progress (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  objective_id                             TEXT NOT NULL CHECK (length(objective_id) <= 80 AND length(objective_id) > 0),
  at                                       INTEGER NOT NULL,
  item_id                                  TEXT CHECK (item_id IS NULL OR length(item_id) <= 80 AND length(item_id) > 0),
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 300),
  evidence_id                              TEXT CHECK (evidence_id IS NULL OR length(evidence_id) <= 80 AND length(evidence_id) > 0),
  FOREIGN KEY (objective_id) REFERENCES dev_objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES dev_objective_items(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX dev_objective_progress_objective ON dev_objective_progress (objective_id);

CREATE TABLE dev_objective_shares (
  objective_id                             TEXT NOT NULL CHECK (length(objective_id) > 0 AND length(objective_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) > 0 AND length(org_id) <= 80),
  FOREIGN KEY (objective_id) REFERENCES dev_objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (objective_id, org_id),
  UNIQUE (objective_id, ord)
) STRICT;
CREATE INDEX dev_objective_shares_org ON dev_objective_shares (org_id);

CREATE TABLE dev_objective_reassessments (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  objective_id                             TEXT NOT NULL CHECK (length(objective_id) <= 80 AND length(objective_id) > 0),
  requested_by_kind                        TEXT NOT NULL CHECK (requested_by_kind IN ('player','guardian')),
  requested_by_id                          TEXT NOT NULL CHECK (length(requested_by_id) <= 80 AND length(requested_by_id) > 0),
  requested_by_name                        TEXT CHECK (requested_by_name IS NULL OR length(requested_by_name) <= 200),
  requested_at                             INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('requested','completed')),
  outcome_note                             TEXT CHECK (outcome_note IS NULL OR length(outcome_note) <= 500 AND length(outcome_note) > 0),
  outcome_by_user_id                       TEXT CHECK (outcome_by_user_id IS NULL OR length(outcome_by_user_id) <= 80 AND length(outcome_by_user_id) > 0),
  outcome_by_name                          TEXT CHECK (outcome_by_name IS NULL OR length(outcome_by_name) <= 200),
  outcome_at                               INTEGER,
  FOREIGN KEY (objective_id) REFERENCES dev_objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (outcome_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK ((status = 'completed') = (outcome_at IS NOT NULL)),
  CHECK ((outcome_at IS NULL) = (outcome_note IS NULL) AND (outcome_at IS NULL) = (outcome_by_user_id IS NULL))
) STRICT;
CREATE INDEX dev_objective_reassessments_objective ON dev_objective_reassessments (objective_id);
CREATE UNIQUE INDEX dev_objective_reassessments_open ON dev_objective_reassessments (objective_id) WHERE status = 'requested';

CREATE TABLE dev_objective_reassessment_evidence (
  reassessment_id                          TEXT NOT NULL CHECK (length(reassessment_id) > 0 AND length(reassessment_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 50),
  evidence_id                              TEXT NOT NULL CHECK (length(evidence_id) > 0 AND length(evidence_id) <= 80),
  FOREIGN KEY (reassessment_id) REFERENCES dev_objective_reassessments(id) ON DELETE CASCADE,
  PRIMARY KEY (reassessment_id, ord),
  UNIQUE (reassessment_id, evidence_id)
) STRICT;

CREATE TABLE drill_guidance (
  drill_id                                 TEXT NOT NULL CHECK (length(drill_id) <= 80 AND length(drill_id) > 0),
  reviewer                                 TEXT NOT NULL CHECK (length(reviewer) <= 60 AND length(reviewer) > 0),
  reviewed_at                              INTEGER NOT NULL,
  PRIMARY KEY (drill_id)
) STRICT;


-- =============================================================================
-- M16 Box Cam · M16.1 At-Home Combine · M22 production CV results
-- S12b: IMPLEMENTED, migration 0031_box_cam REGISTERED (repositories/boxCam.mjs, 5 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =============================================================================

-- Preferences (box_cam_prefs): one row per player who saved them; a player with no row reads the defaults (reading
-- never creates a row). Challenges (box_challenges): an organisation's, or ScoutBox's own two, which the migration
-- inserts; status is only 'active', expiry is ends_at. Entries (box_challenge_entries): one per challenge and player;
-- progress is recomputed from the sessions on every finalize, the session ids it counted are not stored.
-- Assignments (box_assignments): the target as columns, a due date a real day, a frequency of 1 to 14 a week;
-- 'superseded' was read but never written and is not a state.
-- Sessions (box_sessions): server-minted. The nonce is stored only as its SHA-256 (nonce_hash); the plain value is in
-- the creation response alone and every write compares its hash. A session cites at most one challenge entry
-- (challenge_entry_id). The accepted observation stream is ordered rows (box_session_observations, one per event;
-- a resume closes the open pause), read once by finalize; the verification reasons and the append-only integrity
-- history (M18.1: survives a restore) are rows too. integrity {minted, drift}, captureMode and the note's provenance
-- were constants and are worked out by the view; the bound Combine attempt is found through
-- combine_attempts.box_session_id and the CV result through box_cam_cv_results.session_id. boxSessionEvents was
-- reserved since M16 and never written: no table.
-- Disputes (box_cam_disputes): the resolution as columns; resolved once.
-- Combine requests (combine_requests): the protocols as ordered rows; deadline a real day. Combine attempts
-- (combine_attempts): the reasons and the calibration checks as ordered rows; the checks a calibration required come
-- from the pinned protocol version, never stored. The stored combine_state is the state the attempt finished in; the
-- live state is derived from the bound session's verification_state.
-- CV results (box_cam_cv_results): the provider's canonical result as columns, recorded once; quality reasons (code,
-- value, threshold) and secondary diagnostics as coded rows, the bounded trace (<= 256) as rows; the experimental note
-- is constant copy. No frame bytes, base64 or pixels anywhere.
-- Player, guardian and media ids carry no key (tolerant). Organisations, the assigning or requesting staff and an
-- assignment's objective are RESTRICT keys; so are the keys between these tables. Child rows cascade with their owner.
CREATE TABLE box_cam_prefs (
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  share_development_activity               TEXT NOT NULL CHECK (share_development_activity IN ('private','recruitment')),
  retain_clips                             INTEGER NOT NULL CHECK (retain_clips IN (0,1)),
  updated_at                               INTEGER,
  updated_by_kind                          TEXT CHECK (updated_by_kind IS NULL OR updated_by_kind IN ('player','guardian')),
  updated_by_id                            TEXT CHECK (updated_by_id IS NULL OR length(updated_by_id) <= 80 AND length(updated_by_id) > 0),
  PRIMARY KEY (player_id),
  CHECK ((updated_at IS NULL) = (updated_by_kind IS NULL))
) STRICT;
CREATE TABLE box_challenges (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  publisher_kind                           TEXT NOT NULL CHECK (publisher_kind IN ('org','scoutbox')),
  publisher_org_id                         TEXT CHECK (publisher_org_id IS NULL OR length(publisher_org_id) <= 80 AND length(publisher_org_id) > 0),
  publisher_org_name                       TEXT CHECK (publisher_org_name IS NULL OR length(publisher_org_name) <= 200),
  publisher_by_name                        TEXT CHECK (publisher_by_name IS NULL OR length(publisher_by_name) <= 200),
  drill_id                                 TEXT NOT NULL CHECK (length(drill_id) <= 80 AND length(drill_id) > 0),
  metric                                   TEXT NOT NULL CHECK (metric IN ('reps','active_minutes')),
  target_total                             INTEGER NOT NULL,
  starts_at                                INTEGER NOT NULL,
  ends_at                                  INTEGER NOT NULL,
  adult_only                               INTEGER NOT NULL CHECK (adult_only IN (0,1)),
  cap                                      INTEGER,
  status                                   TEXT NOT NULL CHECK (status IN ('active')),
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (publisher_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  CHECK ((publisher_kind = 'org') = (publisher_org_id IS NOT NULL)),
  CHECK (publisher_kind = 'org' OR (publisher_org_name IS NULL AND publisher_by_name IS NULL)),
  CHECK (target_total >= 1),
  CHECK (ends_at > starts_at),
  CHECK (cap IS NULL OR cap >= 1)
) STRICT;
CREATE INDEX box_challenges_publisher_org ON box_challenges (publisher_org_id) WHERE publisher_org_id IS NOT NULL;
CREATE INDEX box_challenges_status_ends ON box_challenges (status, ends_at);
CREATE TABLE box_challenge_entries (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  challenge_id                             TEXT NOT NULL CHECK (length(challenge_id) <= 80 AND length(challenge_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('active','completed')),
  progress                                 INTEGER NOT NULL,
  joined_at                                INTEGER NOT NULL,
  joined_by_kind                           TEXT NOT NULL CHECK (joined_by_kind IN ('player','guardian')),
  joined_by_id                             TEXT NOT NULL CHECK (length(joined_by_id) <= 80 AND length(joined_by_id) > 0),
  completed_at                             INTEGER,
  FOREIGN KEY (challenge_id) REFERENCES box_challenges(id) ON DELETE RESTRICT,
  CHECK (progress >= 0),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX box_challenge_entries_challenge_player ON box_challenge_entries (challenge_id, player_id);
CREATE INDEX box_challenge_entries_player ON box_challenge_entries (player_id, status);
CREATE TABLE box_assignments (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  assigned_by_user_id                      TEXT NOT NULL CHECK (length(assigned_by_user_id) <= 80 AND length(assigned_by_user_id) > 0),
  assigned_by_name                         TEXT CHECK (assigned_by_name IS NULL OR length(assigned_by_name) <= 200),
  assigned_by_role                         TEXT CHECK (assigned_by_role IS NULL OR length(assigned_by_role) <= 80),
  assigned_by_org_verified                 INTEGER NOT NULL CHECK (assigned_by_org_verified IN (0,1)),
  assigned_at                              INTEGER NOT NULL,
  drill_id                                 TEXT NOT NULL CHECK (length(drill_id) <= 80 AND length(drill_id) > 0),
  drill_version                            INTEGER NOT NULL,
  target_type                              TEXT NOT NULL CHECK (target_type IN ('repetitions','duration','sets')),
  target_value                             REAL NOT NULL,
  frequency_per_week                       INTEGER,
  due_date                                 TEXT CHECK (due_date IS NULL OR length(due_date) <= 10),
  instructions                             TEXT CHECK (instructions IS NULL OR length(instructions) <= 300),
  objective_id                             TEXT CHECK (objective_id IS NULL OR length(objective_id) <= 80 AND length(objective_id) > 0),
  state                                    TEXT NOT NULL CHECK (state IN ('assigned','accepted','in_progress','partially_completed','completed','cancelled')),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (objective_id) REFERENCES dev_objectives(id) ON DELETE RESTRICT,
  CHECK (target_value > 0),
  CHECK (frequency_per_week IS NULL OR frequency_per_week BETWEEN 1 AND 14),
  CHECK (due_date IS NULL OR (length(due_date) = 10 AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'))
) STRICT;
CREATE INDEX box_assignments_org ON box_assignments (org_id, player_id);
CREATE INDEX box_assignments_player ON box_assignments (player_id);
CREATE TABLE box_sessions (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  drill_id                                 TEXT NOT NULL CHECK (length(drill_id) <= 80 AND length(drill_id) > 0),
  drill_version                            INTEGER NOT NULL,
  assignment_id                            TEXT CHECK (assignment_id IS NULL OR length(assignment_id) <= 80 AND length(assignment_id) > 0),
  challenge_entry_id                       TEXT CHECK (challenge_entry_id IS NULL OR length(challenge_entry_id) <= 80 AND length(challenge_entry_id) > 0),
  target_type                              TEXT NOT NULL CHECK (target_type IN ('repetitions','duration','sets')),
  target_value                             REAL NOT NULL,
  nonce_hash                               TEXT NOT NULL CHECK (length(nonce_hash) <= 64 AND length(nonce_hash) > 0),
  liveness_challenge                       TEXT NOT NULL CHECK (liveness_challenge IN ('raise_right_hand','show_ball','left_foot_touch','step_into_zone')),
  provider_id                              TEXT NOT NULL CHECK (provider_id IN ('production_cv','web_client','local_test')),
  provider_version                         INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('setup_required','recording','processing','verified','partially_verified','unable_to_verify','completed_unverified','cancelled','invalidated')),
  created_at                               INTEGER NOT NULL,
  expires_at                               INTEGER NOT NULL,
  started_at                               INTEGER,
  ended_at                                 INTEGER,
  liveness_passed_at                       INTEGER,
  last_seq                                 INTEGER NOT NULL,
  batches                                  INTEGER NOT NULL,
  capture_context                          TEXT CHECK (capture_context IS NULL OR capture_context IN ('at_home','club','event')),
  session_duration_ms                      REAL,
  verified_active_ms                       REAL,
  verified_reps                            INTEGER,
  sets_completed                           INTEGER,
  target_completed                         INTEGER CHECK (target_completed IS NULL OR target_completed IN (0,1)),
  quality                                  TEXT CHECK (quality IS NULL OR quality IN ('good','degraded','insufficient')),
  interruptions_count                      INTEGER,
  verification_state                       TEXT CHECK (verification_state IS NULL OR verification_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled','invalidated')),
  result_hash                              TEXT CHECK (result_hash IS NULL OR length(result_hash) <= 64),
  finalized_at                             INTEGER,
  note                                     TEXT CHECK (note IS NULL OR length(note) <= 300),
  clip_media_id                            TEXT CHECK (clip_media_id IS NULL OR length(clip_media_id) <= 80 AND length(clip_media_id) > 0),
  previous_verification_state              TEXT CHECK (previous_verification_state IS NULL OR previous_verification_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled')),
  invalidated_at                           INTEGER,
  cv_provider_session_id                   TEXT CHECK (cv_provider_session_id IS NULL OR length(cv_provider_session_id) <= 80 AND length(cv_provider_session_id) > 0),
  FOREIGN KEY (assignment_id) REFERENCES box_assignments(id) ON DELETE RESTRICT,
  FOREIGN KEY (challenge_entry_id) REFERENCES box_challenge_entries(id) ON DELETE RESTRICT,
  CHECK (length(nonce_hash) = 64),
  CHECK (last_seq >= 0 AND batches >= 0),
  CHECK (status NOT IN ('verified','partially_verified','unable_to_verify','completed_unverified','invalidated') OR status = verification_state),
  CHECK ((verification_state = 'invalidated') = (previous_verification_state IS NOT NULL))
) STRICT;
CREATE INDEX box_sessions_player ON box_sessions (player_id, ended_at);
CREATE INDEX box_sessions_assignment ON box_sessions (assignment_id) WHERE assignment_id IS NOT NULL;
CREATE TABLE box_session_observations (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 4000),
  kind                                     TEXT NOT NULL CHECK (kind IN ('active','presence','ball','rep','set','pause','interruption','multi_person')),
  from_ms                                  REAL,
  to_ms                                    REAL,
  at_ms                                    REAL,
  quality                                  TEXT CHECK (quality IS NULL OR quality IN ('good','degraded','insufficient')),
  confidence                               REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  FOREIGN KEY (session_id) REFERENCES box_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, ord),
  CHECK (kind NOT IN ('active','presence','ball','interruption','multi_person') OR (from_ms IS NOT NULL AND to_ms IS NOT NULL AND at_ms IS NULL)),
  CHECK (kind NOT IN ('rep','set') OR (at_ms IS NOT NULL AND from_ms IS NULL AND to_ms IS NULL)),
  CHECK (kind <> 'pause' OR (from_ms IS NOT NULL AND at_ms IS NULL)),
  CHECK (kind IN ('active','presence') OR quality IS NULL),
  CHECK (kind = 'rep' OR confidence IS NULL)
) STRICT;
CREATE TABLE box_session_reasons (
  session_id                               TEXT NOT NULL CHECK (length(session_id) > 0 AND length(session_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 40),
  code                                     TEXT NOT NULL CHECK (length(code) > 0 AND length(code) <= 80 AND code NOT GLOB '*[^A-Za-z0-9_]*'),
  FOREIGN KEY (session_id) REFERENCES box_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, ord)
) STRICT;
CREATE TABLE box_session_integrity_events (
  session_id                               TEXT NOT NULL CHECK (length(session_id) <= 80 AND length(session_id) > 0),
  ord                                      INTEGER NOT NULL,
  type                                     TEXT NOT NULL CHECK (type IN ('invalidated','restored')),
  at                                       INTEGER NOT NULL,
  dispute_id                               TEXT CHECK (dispute_id IS NULL OR length(dispute_id) <= 80 AND length(dispute_id) > 0),
  outcome                                  TEXT CHECK (outcome IS NULL OR outcome IN ('invalidated','provider_bug')),
  to_state                                 TEXT CHECK (to_state IS NULL OR to_state IN ('verified','partially_verified','unable_to_verify','completed_unverified','cancelled')),
  FOREIGN KEY (session_id) REFERENCES box_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, ord),
  CHECK (ord >= 0),
  CHECK ((type = 'invalidated') = (outcome IS NOT NULL)),
  CHECK ((type = 'restored') = (to_state IS NOT NULL)),
  CHECK (type = 'invalidated' OR dispute_id IS NULL)
) STRICT;
CREATE TABLE box_cam_disputes (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  session_id                               TEXT NOT NULL CHECK (length(session_id) <= 80 AND length(session_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  reason                                   TEXT NOT NULL CHECK (length(reason) <= 500 AND length(reason) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution_outcome                       TEXT CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('stands','invalidated','provider_bug')),
  resolution_reason                        TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) <= 400 AND length(resolution_reason) > 0),
  resolved_at                              INTEGER,
  created_at                               INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES box_sessions(id) ON DELETE CASCADE,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
) STRICT;
CREATE INDEX box_cam_disputes_queue ON box_cam_disputes (status, created_at, id);
CREATE INDEX box_cam_disputes_created ON box_cam_disputes (created_at, id);
CREATE TABLE combine_requests (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  org_name                                 TEXT CHECK (org_name IS NULL OR length(org_name) <= 200),
  requested_by_user_id                     TEXT NOT NULL CHECK (length(requested_by_user_id) <= 80 AND length(requested_by_user_id) > 0),
  requested_by_name                        TEXT CHECK (requested_by_name IS NULL OR length(requested_by_name) <= 200),
  requested_by_role                        TEXT CHECK (requested_by_role IS NULL OR length(requested_by_role) <= 80),
  requested_at                             INTEGER NOT NULL,
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  title                                    TEXT CHECK (title IS NULL OR length(title) <= 120 AND length(title) > 0),
  deadline_date                            TEXT CHECK (deadline_date IS NULL OR length(deadline_date) <= 10),
  instructions                             TEXT CHECK (instructions IS NULL OR length(instructions) <= 300),
  state                                    TEXT NOT NULL CHECK (state IN ('requested','completed','cancelled')),
  created_at                               INTEGER NOT NULL,
  completed_at                             INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (requested_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (deadline_date IS NULL OR (length(deadline_date) = 10 AND deadline_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL) OR state = 'cancelled')
) STRICT;
CREATE INDEX combine_requests_org ON combine_requests (org_id, player_id);
CREATE INDEX combine_requests_player ON combine_requests (player_id, state);
CREATE TABLE combine_request_protocols (
  request_id                               TEXT NOT NULL CHECK (length(request_id) > 0 AND length(request_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 20),
  protocol_id                              TEXT NOT NULL CHECK (length(protocol_id) > 0 AND length(protocol_id) <= 80),
  FOREIGN KEY (request_id) REFERENCES combine_requests(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, ord),
  UNIQUE (request_id, protocol_id)
) STRICT;
CREATE TABLE combine_attempts (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  protocol_id                              TEXT NOT NULL CHECK (length(protocol_id) <= 80 AND length(protocol_id) > 0),
  protocol_version                         INTEGER NOT NULL,
  box_session_id                           TEXT NOT NULL CHECK (length(box_session_id) <= 80 AND length(box_session_id) > 0),
  attempt_number                           INTEGER NOT NULL,
  mode                                     TEXT NOT NULL CHECK (mode IN ('verified','practice')),
  capture_context                          TEXT NOT NULL CHECK (capture_context IN ('at_home','club','event')),
  request_id                               TEXT CHECK (request_id IS NULL OR length(request_id) <= 80 AND length(request_id) > 0),
  metric_type                              TEXT NOT NULL CHECK (metric_type IN ('count','time','distance','duration','set','percentage')),
  metric_unit                              TEXT NOT NULL CHECK (length(metric_unit) <= 40 AND length(metric_unit) > 0),
  direction                                TEXT NOT NULL CHECK (direction IN ('higher','lower')),
  measurement_algorithm_version            INTEGER NOT NULL,
  provider_id                              TEXT NOT NULL CHECK (provider_id IN ('production_cv','web_client','local_test')),
  provider_version                         INTEGER NOT NULL,
  measured_value                           REAL,
  measurement_state                        TEXT CHECK (measurement_state IS NULL OR measurement_state IN ('measured','practice','partially_measured','measurement_unavailable','protocol_invalid','invalidated','cancelled')),
  combine_state                            TEXT NOT NULL CHECK (combine_state IN ('ready','combine_verified','partially_measured','measurement_unavailable','protocol_invalid','invalidated','cancelled')),
  started_at                               INTEGER,
  completed_at                             INTEGER,
  result_hash                              TEXT CHECK (result_hash IS NULL OR length(result_hash) <= 64),
  created_at                               INTEGER NOT NULL,
  calibration_passed                       INTEGER CHECK (calibration_passed IS NULL OR calibration_passed IN (0,1)),
  calibrated_at                            INTEGER,
  FOREIGN KEY (box_session_id) REFERENCES box_sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id) REFERENCES combine_requests(id) ON DELETE RESTRICT,
  CHECK ((calibration_passed IS NULL) = (calibrated_at IS NULL)),
  CHECK (attempt_number >= 1)
) STRICT;
CREATE UNIQUE INDEX combine_attempts_box_session ON combine_attempts (box_session_id);
CREATE INDEX combine_attempts_player ON combine_attempts (player_id, protocol_id, created_at);
CREATE TABLE combine_attempt_reasons (
  attempt_id                               TEXT NOT NULL CHECK (length(attempt_id) > 0 AND length(attempt_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 40),
  code                                     TEXT NOT NULL CHECK (length(code) > 0 AND length(code) <= 80 AND code NOT GLOB '*[^A-Za-z0-9_]*'),
  FOREIGN KEY (attempt_id) REFERENCES combine_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY (attempt_id, ord)
) STRICT;
CREATE TABLE combine_attempt_calibration_checks (
  attempt_id                               TEXT NOT NULL CHECK (length(attempt_id) > 0 AND length(attempt_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 10),
  check_name                               TEXT NOT NULL CHECK (length(check_name) > 0 AND length(check_name) <= 60),
  FOREIGN KEY (attempt_id) REFERENCES combine_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY (attempt_id, ord)
) STRICT;
CREATE TABLE box_cam_cv_results (
  provider_session_id                      TEXT NOT NULL CHECK (length(provider_session_id) <= 80 AND length(provider_session_id) > 0),
  session_id                               TEXT NOT NULL CHECK (length(session_id) <= 80 AND length(session_id) > 0),
  protocol_id                              TEXT NOT NULL CHECK (protocol_id IN ('combine-box-touch-60','combine-box-juggle','combine-box-control-60')),
  provider_id                              TEXT NOT NULL CHECK (provider_id IN ('production_cv')),
  provider_version                         INTEGER NOT NULL,
  engine_version                           INTEGER NOT NULL,
  cv_policy_version                        INTEGER NOT NULL,
  outcome                                  TEXT NOT NULL CHECK (outcome IN ('accepted','refused')),
  refusal_reason                           TEXT CHECK (refusal_reason IS NULL OR length(refusal_reason) <= 80),
  refusal_detail                           TEXT CHECK (refusal_detail IS NULL OR length(refusal_detail) <= 300),
  oq_sufficient                            INTEGER NOT NULL CHECK (oq_sufficient IN (0,1)),
  oq_state                                 TEXT CHECK (oq_state IS NULL OR oq_state IN ('sufficient','insufficient')),
  oq_aggregate_confidence                  REAL,
  oq_coverage                              REAL,
  person_present                           INTEGER NOT NULL CHECK (person_present IN (0,1)),
  ball_present                             INTEGER NOT NULL CHECK (ball_present IN (0,1)),
  touch_count                              INTEGER,
  juggle_count                             INTEGER,
  active_duration_ms                       REAL NOT NULL,
  experimental_exact_count                 INTEGER,
  experimental_status                      TEXT NOT NULL CHECK (experimental_status IN ('experimental_unvalidated')),
  integrity_ok                             INTEGER NOT NULL CHECK (integrity_ok IN (0,1)),
  frames_accepted                          INTEGER NOT NULL,
  frames_rejected                          INTEGER NOT NULL,
  frames_dropped_by_server                 INTEGER NOT NULL,
  duplicates_rejected                      INTEGER NOT NULL,
  out_of_order_rejected                    INTEGER NOT NULL,
  client_clock_anomalies                   INTEGER NOT NULL,
  frames_analysed                          INTEGER,
  duplicate_frames                         INTEGER,
  effective_fps                            REAL,
  max_ball_gap_ms                          REAL,
  nonce_bound                              INTEGER NOT NULL CHECK (nonce_bound IN (0,1)),
  server_timeline                          INTEGER NOT NULL CHECK (server_timeline IN (0,1)),
  trace_truncated                          INTEGER NOT NULL CHECK (trace_truncated IN (0,1)),
  server_started_at                        INTEGER,
  server_ended_at                          INTEGER,
  server_duration_ms                       INTEGER NOT NULL,
  combine_verified                         INTEGER NOT NULL CHECK (combine_verified IN (0,1)),
  combine_verified_blocked_by              TEXT CHECK (combine_verified_blocked_by IS NULL OR length(combine_verified_blocked_by) <= 80),
  FOREIGN KEY (session_id) REFERENCES box_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (provider_session_id),
  CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL)),
  CHECK (combine_verified = 0)
) STRICT;
CREATE INDEX box_cam_cv_results_session ON box_cam_cv_results (session_id);
CREATE TABLE box_cam_cv_result_codes (
  provider_session_id                      TEXT NOT NULL CHECK (length(provider_session_id) > 0 AND length(provider_session_id) <= 80),
  list                                     TEXT NOT NULL CHECK (list IN ('quality','secondary')),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 40),
  code                                     TEXT NOT NULL CHECK (length(code) > 0 AND length(code) <= 80 AND code NOT GLOB '*[^A-Za-z0-9_]*'),
  value                                    REAL,
  threshold                                REAL,
  FOREIGN KEY (provider_session_id) REFERENCES box_cam_cv_results(provider_session_id) ON DELETE CASCADE,
  PRIMARY KEY (provider_session_id, list, ord),
  CHECK (list = 'quality' OR (value IS NULL AND threshold IS NULL))
) STRICT;
CREATE TABLE box_cam_cv_result_trace (
  provider_session_id                      TEXT NOT NULL CHECK (length(provider_session_id) > 0 AND length(provider_session_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0 AND ord < 256),
  at_ms                                    REAL,
  confidence                               REAL,
  FOREIGN KEY (provider_session_id) REFERENCES box_cam_cv_results(provider_session_id) ON DELETE CASCADE,
  PRIMARY KEY (provider_session_id, ord)
) STRICT;


-- =============================================================================
-- M18 Recruitment Briefs, Nobody Missed, Second Look · M19 Dynamic Watchlists
-- S12c: IMPLEMENTED, migration 0032_discovery REGISTERED (repositories/discovery.mjs, 5 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =============================================================================

-- Briefs (recruitment_briefs): the criteria's scalars as columns, positions, evidence requirements and Combine protocols
-- as ordered value rows by kind (recruitment_brief_values); the position groups are worked out from the positions and
-- never stored. version is the CRITERIA version (Nobody Missed points at it), rev the concurrency token. The audit trail
-- is recruitment_brief_history, its detail typed columns (version, from, to, criteria_changed).
-- Nobody Missed reviews (nobody_missed_reviews): one per (organisation, brief, player), unique; the trail of states is
-- ordered rows. A review's brief and the Room add-to-room opened are RESTRICT keys.
-- Second Look items (second_look_items): one per (organisation, room, decision cycle), unique — the engine's key; the
-- room and decision are RESTRICT keys. Change fingerprints, the archive reasons the changes resolve and the trail are
-- ordered rows (no direct_reason_codes_json); a trail row's reason is the resurfacing verdict or the dismissal reason.
-- Watchlists (dynamic_watchlists): a brief-sourced list names its brief by key (brief_id); any other carries a free
-- reference (source_ref) — sql/07's single untyped source_id is split. Criteria are typed columns by kind
-- (watchlist_criteria: value_text, value_num, range_min/range_max, primary_only, evidence_kind, protocol) with their
-- values as rows (watchlist_criterion_values) — no params_json. The last derived membership is rows
-- (watchlist_members, with the required criteria each member met in watchlist_member_checks — no required_met_json),
-- replaced only by a reconciliation. watchlist_history is the lifecycle trail (the changed fields as four flags);
-- watchlist_membership_events the transitions, one per fingerprint.
-- Player ids carry no key (tolerant). Organisations and the staff named are RESTRICT; child rows cascade.

CREATE TABLE recruitment_briefs (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  version                                  INTEGER NOT NULL,
  status                                   TEXT NOT NULL CHECK (status IN ('draft','active','paused','closed','archived')),
  active_from_date                         TEXT CHECK (active_from_date IS NULL OR length(active_from_date) <= 10),
  active_until_date                        TEXT CHECK (active_until_date IS NULL OR length(active_until_date) <= 10),
  role_id                                  TEXT CHECK (role_id IS NULL OR length(role_id) <= 64 AND length(role_id) > 0),
  vacancy_id                               TEXT CHECK (vacancy_id IS NULL OR length(vacancy_id) <= 64 AND length(vacancy_id) > 0),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  min_age                                  INTEGER,
  max_age                                  INTEGER,
  radius_km                                REAL,
  max_level                                TEXT CHECK (max_level IS NULL OR max_level IN ('amateur','semi_pro','pro')),
  foot                                     TEXT CHECK (foot IS NULL OR foot IN ('Left','Right','Both')),
  availability                             TEXT CHECK (availability IS NULL OR length(availability) <= 40),
  min_trust_band                           TEXT CHECK (min_trust_band IS NULL OR min_trust_band IN ('limited_evidence','developing_evidence','established_evidence','strong_evidence','very_strong_evidence')),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (active_from_date IS NULL OR active_from_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (active_until_date IS NULL OR active_until_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  CHECK (version >= 1),
  CHECK (rev >= 1),
  CHECK (min_age IS NULL OR (min_age >= 5 AND min_age <= 60)),
  CHECK (max_age IS NULL OR (max_age >= 5 AND max_age <= 60)),
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age),
  CHECK (radius_km IS NULL OR (radius_km > 0 AND radius_km <= 20000)),
  CHECK (active_from_date IS NULL OR active_until_date IS NULL OR active_from_date <= active_until_date)
) STRICT;
CREATE INDEX recruitment_briefs_org_updated ON recruitment_briefs (org_id, updated_at);
CREATE TABLE recruitment_brief_values (
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) > 0 AND length(brief_id) <= 80),
  kind                                     TEXT NOT NULL CHECK (kind IN ('position','evidence_requirement','combine_protocol')),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  value                                    TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  CHECK (kind <> 'position' OR value IN ('GK','CB','RB','LB','RWB','LWB','CDM','CM','CAM','RW','LW','ST','CF')),
  CHECK (kind <> 'evidence_requirement' OR value IN ('recent_full_match','coach_reference','confirmed_current_club','combine_verified')),
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE CASCADE,
  PRIMARY KEY (brief_id, kind, ord),
  UNIQUE (brief_id, kind, value)
) STRICT;
CREATE TABLE recruitment_brief_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) <= 80 AND length(brief_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('recruitment_brief_created','recruitment_brief_activated','recruitment_brief_updated')),
  detail_version                           INTEGER,
  detail_from                              TEXT CHECK (detail_from IS NULL OR detail_from IN ('draft','active','paused','closed','archived')),
  detail_to                                TEXT CHECK (detail_to IS NULL OR detail_to IN ('draft','active','paused','closed','archived')),
  detail_criteria_changed                  INTEGER CHECK (detail_criteria_changed IS NULL OR detail_criteria_changed IN (0,1)),
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX recruitment_brief_history_brief ON recruitment_brief_history (brief_id);
CREATE TABLE nobody_missed_reviews (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  brief_id                                 TEXT NOT NULL CHECK (length(brief_id) <= 80 AND length(brief_id) > 0),
  brief_version                            INTEGER NOT NULL,
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  state                                    TEXT NOT NULL CHECK (state IN ('open','reviewed','added_to_room','dismissed')),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  reviewed_by_user_id                      TEXT CHECK (reviewed_by_user_id IS NULL OR length(reviewed_by_user_id) <= 80 AND length(reviewed_by_user_id) > 0),
  reviewed_by_name                         TEXT CHECK (reviewed_by_name IS NULL OR length(reviewed_by_name) <= 200),
  reviewed_at                              INTEGER,
  dismiss_reason                           TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_known','not_current_need','evidence_insufficient','role_mismatch_after_review','timing','other')),
  dismissed_by_user_id                     TEXT CHECK (dismissed_by_user_id IS NULL OR length(dismissed_by_user_id) <= 80 AND length(dismissed_by_user_id) > 0),
  dismissed_by_name                        TEXT CHECK (dismissed_by_name IS NULL OR length(dismissed_by_name) <= 200),
  dismissed_at                             INTEGER,
  room_id                                  TEXT CHECK (room_id IS NULL OR length(room_id) <= 80 AND length(room_id) > 0),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (dismissed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id) REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  CHECK (state <> 'dismissed' OR dismissed_at IS NOT NULL),
  CHECK (state <> 'added_to_room' OR room_id IS NOT NULL),
  UNIQUE (org_id, brief_id, player_id)
) STRICT;
CREATE INDEX nobody_missed_reviews_brief ON nobody_missed_reviews (brief_id);
CREATE TABLE nobody_missed_review_history (
  review_id                                TEXT NOT NULL CHECK (length(review_id) <= 80 AND length(review_id) > 0),
  ord                                      INTEGER NOT NULL,
  at                                       INTEGER NOT NULL,
  state                                    TEXT NOT NULL CHECK (state IN ('open','reviewed','added_to_room','dismissed')),
  by_user_id                               TEXT NOT NULL CHECK (length(by_user_id) <= 80 AND length(by_user_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  FOREIGN KEY (review_id) REFERENCES nobody_missed_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, ord),
  CHECK (ord >= 0)
) STRICT;
CREATE TABLE second_look_items (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  room_id                                  TEXT NOT NULL CHECK (length(room_id) <= 80 AND length(room_id) > 0),
  decision_id                              TEXT NOT NULL CHECK (length(decision_id) <= 80 AND length(decision_id) > 0),
  policy_version                           INTEGER NOT NULL,
  trigger_type                             TEXT NOT NULL CHECK (trigger_type IN ('direct_reason_resolved','significant_new_evidence','evidence_removed','general_update')),
  status                                   TEXT NOT NULL CHECK (status IN ('open','reviewed','dismissed','reopened_room','expired')),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  latest_change_at                         INTEGER NOT NULL,
  reviewed_at                              INTEGER,
  reviewed_by_user_id                      TEXT CHECK (reviewed_by_user_id IS NULL OR length(reviewed_by_user_id) <= 80 AND length(reviewed_by_user_id) > 0),
  reviewed_by_name                         TEXT CHECK (reviewed_by_name IS NULL OR length(reviewed_by_name) <= 200),
  dismissed_at                             INTEGER,
  dismissed_by_user_id                     TEXT CHECK (dismissed_by_user_id IS NULL OR length(dismissed_by_user_id) <= 80 AND length(dismissed_by_user_id) > 0),
  dismissed_by_name                        TEXT CHECK (dismissed_by_name IS NULL OR length(dismissed_by_name) <= 200),
  dismiss_reason                           TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('already_reviewed_elsewhere','change_not_material','timing_not_right','squad_need_changed','no_action_required','other')),
  reopened_at                              INTEGER,
  reopened_by_user_id                      TEXT CHECK (reopened_by_user_id IS NULL OR length(reopened_by_user_id) <= 80 AND length(reopened_by_user_id) > 0),
  reopened_by_name                         TEXT CHECK (reopened_by_name IS NULL OR length(reopened_by_name) <= 200),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id) REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  FOREIGN KEY (decision_id) REFERENCES room_decisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (reviewed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (dismissed_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  FOREIGN KEY (reopened_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK (status <> 'reviewed' OR reviewed_at IS NOT NULL),
  CHECK (status <> 'dismissed' OR dismissed_at IS NOT NULL),
  CHECK (status <> 'reopened_room' OR reopened_at IS NOT NULL),
  UNIQUE (org_id, room_id, decision_id)
) STRICT;
CREATE INDEX second_look_items_org_player ON second_look_items (org_id, player_id);
CREATE TABLE second_look_item_fingerprints (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  fingerprint                              TEXT NOT NULL CHECK (length(fingerprint) > 0 AND length(fingerprint) <= 400),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord),
  UNIQUE (item_id, fingerprint)
) STRICT;
CREATE TABLE second_look_item_reasons (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  code                                     TEXT NOT NULL CHECK (code IN ('insufficient_recent_evidence','insufficient_full_match','reference_missing','combine_missing','trial_needed','continue_monitoring','physical_profile','technical_fit','tactical_fit','development_upside','not_current_priority','position_need','trial_outcome','squad_space','budget','timing','registration','travel_logistics','eligibility','player_unavailable')),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, ord),
  UNIQUE (item_id, code)
) STRICT;
CREATE TABLE second_look_item_history (
  item_id                                  TEXT NOT NULL CHECK (length(item_id) > 0 AND length(item_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  at                                       INTEGER NOT NULL,
  action                                   TEXT NOT NULL CHECK (action IN ('surfaced','resurfaced','reviewed','dismissed','reopened_room')),
  by_user_id                               TEXT CHECK (by_user_id IS NULL OR (length(by_user_id) > 0 AND length(by_user_id) <= 80)),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  reason                                   TEXT CHECK (reason IS NULL OR reason IN ('materially_new_evidence','already_reviewed_elsewhere','change_not_material','timing_not_right','squad_need_changed','no_action_required','other')),
  FOREIGN KEY (item_id) REFERENCES second_look_items(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  PRIMARY KEY (item_id, ord),
  CHECK ((action IN ('surfaced','resurfaced')) = (by_user_id IS NULL)),
  CHECK (by_user_id IS NOT NULL OR by_name IS NULL),
  CHECK (action IN ('resurfaced','dismissed') OR reason IS NULL),
  CHECK (action <> 'resurfaced' OR reason IS NOT NULL)
) STRICT;
CREATE TABLE dynamic_watchlists (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  name                                     TEXT NOT NULL CHECK (length(name) <= 80 AND length(name) > 0),
  mode                                     TEXT NOT NULL CHECK (mode IN ('live_linked','snapshot')),
  status                                   TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  source_type                              TEXT NOT NULL CHECK (source_type IN ('brief','saved_search','criteria')),
  brief_id                                 TEXT CHECK (brief_id IS NULL OR length(brief_id) <= 80 AND length(brief_id) > 0),
  source_ref                               TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 64 AND length(source_ref) > 0),
  schema_version                           INTEGER NOT NULL,
  criteria_version                         TEXT NOT NULL CHECK (length(criteria_version) <= 40 AND length(criteria_version) > 0),
  notify                                   INTEGER NOT NULL CHECK (notify IN (0,1)),
  created_by_user_id                       TEXT NOT NULL CHECK (length(created_by_user_id) <= 80 AND length(created_by_user_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  last_criteria_version                    TEXT CHECK (last_criteria_version IS NULL OR length(last_criteria_version) <= 40 AND length(last_criteria_version) > 0),
  last_brief_version                       INTEGER,
  last_reconciled_at                       INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (brief_id) REFERENCES recruitment_briefs(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES org_users(id) ON DELETE RESTRICT,
  CHECK ((source_type = 'brief') = (brief_id IS NOT NULL)),
  CHECK (source_type <> 'brief' OR source_ref IS NULL),
  CHECK (mode <> 'live_linked' OR source_type = 'brief'),
  CHECK (rev >= 1),
  CHECK ((last_reconciled_at IS NULL) = (last_criteria_version IS NULL))
) STRICT;
CREATE INDEX dynamic_watchlists_org_updated ON dynamic_watchlists (org_id, updated_at);
CREATE TABLE watchlist_criteria (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  class                                    TEXT NOT NULL CHECK (class IN ('required','preferred')),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  criterion_id                             TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= 600),
  type                                     TEXT NOT NULL CHECK (type IN ('position','age','geography','level','foot','availability','evidence','evidence_recency','trust_band','combine_result','combine_measurement')),
  operator                                 TEXT NOT NULL CHECK (operator IN ('in','between','gte','lte','within_radius','equals','exists','within_days')),
  value_text                               TEXT CHECK (value_text IS NULL OR (length(value_text) > 0 AND length(value_text) <= 80)),
  value_num                                REAL,
  range_min                                INTEGER,
  range_max                                INTEGER,
  primary_only                             INTEGER CHECK (primary_only IS NULL OR primary_only IN (0,1)),
  evidence_kind                            TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('any','footage')),
  protocol                                 TEXT CHECK (protocol IS NULL OR (length(protocol) > 0 AND length(protocol) <= 80)),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, class, ord),
  UNIQUE (watchlist_id, class, criterion_id),
  CHECK ((range_min IS NULL) = (range_max IS NULL))
) STRICT;
CREATE TABLE watchlist_criterion_values (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  class                                    TEXT NOT NULL CHECK (class IN ('required','preferred')),
  criterion_ord                            INTEGER NOT NULL CHECK (criterion_ord >= 0),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  value                                    TEXT NOT NULL CHECK (length(value) > 0 AND length(value) <= 80),
  FOREIGN KEY (watchlist_id, class, criterion_ord) REFERENCES watchlist_criteria(watchlist_id, class, ord) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, class, criterion_ord, ord)
) STRICT;
CREATE TABLE watchlist_members (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, player_id)
) STRICT;
CREATE TABLE watchlist_member_checks (
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) > 0 AND length(watchlist_id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) > 0 AND length(player_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  criterion_id                             TEXT NOT NULL CHECK (length(criterion_id) > 0 AND length(criterion_id) <= 600),
  met                                      INTEGER NOT NULL CHECK (met IN (0,1)),
  FOREIGN KEY (watchlist_id, player_id) REFERENCES watchlist_members(watchlist_id, player_id) ON DELETE CASCADE,
  PRIMARY KEY (watchlist_id, player_id, ord)
) STRICT;
CREATE TABLE watchlist_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) <= 80 AND length(watchlist_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('org')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('watchlist_created','watchlist_updated','watchlist_archived')),
  detail_mode                              TEXT CHECK (detail_mode IS NULL OR detail_mode IN ('live_linked','snapshot')),
  detail_source_type                       TEXT CHECK (detail_source_type IS NULL OR detail_source_type IN ('brief','saved_search','criteria')),
  detail_status                            TEXT CHECK (detail_status IS NULL OR detail_status IN ('active','paused','archived')),
  detail_changed_name                      INTEGER CHECK (detail_changed_name IS NULL OR detail_changed_name IN (0,1)),
  detail_changed_mode                      INTEGER CHECK (detail_changed_mode IS NULL OR detail_changed_mode IN (0,1)),
  detail_changed_status                    INTEGER CHECK (detail_changed_status IS NULL OR detail_changed_status IN (0,1)),
  detail_changed_criteria                  INTEGER CHECK (detail_changed_criteria IS NULL OR detail_changed_criteria IN (0,1)),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE CASCADE,
  CHECK ((detail_changed_name IS NULL AND detail_changed_mode IS NULL AND detail_changed_status IS NULL AND detail_changed_criteria IS NULL) OR (detail_changed_name IS NOT NULL AND detail_changed_mode IS NOT NULL AND detail_changed_status IS NOT NULL AND detail_changed_criteria IS NOT NULL))
) STRICT;
CREATE INDEX watchlist_history_watchlist ON watchlist_history (watchlist_id);
CREATE TABLE watchlist_membership_events (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  watchlist_id                             TEXT NOT NULL CHECK (length(watchlist_id) <= 80 AND length(watchlist_id) > 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) <= 80 AND length(org_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  transition                               TEXT NOT NULL CHECK (transition IN ('entered','left')),
  reason                                   TEXT NOT NULL CHECK (reason IN ('criterion_now_met','criteria_changed','brief_changed','newly_visible','first_evaluation','criterion_no_longer_met','unavailable')),
  criterion_id                             TEXT CHECK (criterion_id IS NULL OR length(criterion_id) <= 600 AND length(criterion_id) > 0),
  text                                     TEXT NOT NULL CHECK (length(text) <= 2000 AND length(text) > 0),
  criteria_version                         TEXT NOT NULL CHECK (length(criteria_version) <= 40 AND length(criteria_version) > 0),
  brief_version                            INTEGER,
  policy_version                           INTEGER NOT NULL,
  at                                       INTEGER NOT NULL,
  fingerprint                              TEXT NOT NULL CHECK (length(fingerprint) <= 400 AND length(fingerprint) > 0),
  FOREIGN KEY (watchlist_id) REFERENCES dynamic_watchlists(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  UNIQUE (fingerprint)
) STRICT;
CREATE INDEX watchlist_membership_events_watchlist_at ON watchlist_membership_events (watchlist_id, at, id);
CREATE INDEX watchlist_membership_events_org_at ON watchlist_membership_events (org_id, at);


-- =============================================================================
-- M21 — Development Hub
-- S12a: IMPLEMENTED, migration 0030_development REGISTERED (repositories/development.mjs, 5 Nov 2026).
-- =============================================================================
--
-- Plans (devplan-*), goals (devgoal-*), actions (devact-*), evidence links (devlink-*, a reference and no content:
-- exactly EVIDENCE_LINK_FIELDS) and reviews (devrev-*, append-only). Differences from the first draft of this file:
--   - one development_history table for the four record kinds; every entry names its plan (and at most one goal,
--     action or review), so a plan's timeline is one indexed query; the detail is typed columns, present keys only;
--   - a goal's Combine target is columns (frozen at creation); a review's goal snapshots are rows, their cited evidence
--     references child rows (no JSON); completion is worked out from the counts;
--   - a review's superseded_by is not stored (it is the review whose supersedes names it, unique); share scopes are
--     three flags; a plan's origin_trial_id is gone (nothing ever set it);
--   - player, guardian, cited-record and actor ids carry no key (tolerant); organisations are RESTRICT; keys inside the
--     domain are RESTRICT; child rows cascade with their owner.

CREATE TABLE development_plans (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  owner_kind                               TEXT NOT NULL CHECK (owner_kind IN ('player','org')),
  owner_org_id                             TEXT CHECK (owner_org_id IS NULL OR length(owner_org_id) <= 80 AND length(owner_org_id) > 0),
  owner_org_name                           TEXT CHECK (owner_org_name IS NULL OR length(owner_org_name) <= 200),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  status                                   TEXT NOT NULL CHECK (status IN ('draft','active','paused','completed','archived')),
  visibility                               TEXT NOT NULL CHECK (visibility IN ('private','player_guardian','shared_with_org','org_private')),
  start_at                                 INTEGER NOT NULL,
  next_review_at                           INTEGER,
  end_at                                   INTEGER,
  template_id                              TEXT CHECK (template_id IS NULL OR template_id IN ('technical_development','positional_development','trial_follow_up')),
  origin_objective_id                      TEXT CHECK (origin_objective_id IS NULL OR length(origin_objective_id) <= 80 AND length(origin_objective_id) > 0),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  completed_at                             INTEGER,
  archived_at                              INTEGER,
  FOREIGN KEY (owner_org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_objective_id) REFERENCES dev_objectives(id) ON DELETE RESTRICT,
  CHECK ((owner_kind = 'org') = (owner_org_id IS NOT NULL)),
  CHECK (owner_kind <> 'player' OR visibility IN ('private','player_guardian','shared_with_org')),
  CHECK (owner_kind <> 'org' OR visibility IN ('org_private','player_guardian')),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CHECK (status <> 'archived' OR archived_at IS NOT NULL)
) STRICT;
CREATE INDEX development_plans_player ON development_plans (player_id, owner_kind, owner_org_id, status);
CREATE INDEX development_plans_owner_org ON development_plans (owner_org_id, updated_at);

CREATE TABLE development_plan_shares (
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) > 0 AND length(plan_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  org_id                                   TEXT NOT NULL CHECK (length(org_id) > 0 AND length(org_id) <= 80),
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  PRIMARY KEY (plan_id, org_id),
  UNIQUE (plan_id, ord)
) STRICT;
CREATE INDEX development_plan_shares_org ON development_plan_shares (org_id);

CREATE TABLE development_goals (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) <= 80 AND length(plan_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  description                              TEXT CHECK (description IS NULL OR length(description) <= 1000),
  category                                 TEXT NOT NULL CHECK (category IN ('technical','tactical','physical','psychological','match_understanding','position_specific','other')),
  status                                   TEXT NOT NULL CHECK (status IN ('not_started','in_progress','blocked','achieved','stopped')),
  block_reason                             TEXT CHECK (block_reason IS NULL OR block_reason IN ('waiting_for_assessment','schedule','facility','coach_review','other')),
  block_note                               TEXT CHECK (block_note IS NULL OR length(block_note) <= 300),
  target_at                                INTEGER,
  target_source_type                       TEXT CHECK (target_source_type IS NULL OR target_source_type IN ('combine_attempt')),
  target_protocol_id                       TEXT CHECK (target_protocol_id IS NULL OR length(target_protocol_id) <= 80 AND length(target_protocol_id) > 0),
  target_protocol_version                  INTEGER,
  target_metric_type                       TEXT CHECK (target_metric_type IS NULL OR target_metric_type IN ('count','time','distance','duration','set','percentage')),
  target_metric_unit                       TEXT CHECK (target_metric_unit IS NULL OR length(target_metric_unit) <= 40 AND length(target_metric_unit) > 0),
  target_operator                          TEXT CHECK (target_operator IS NULL OR target_operator IN ('gte','gt','lte','lt','eq')),
  target_value                             REAL,
  target_protocol_title                    TEXT CHECK (target_protocol_title IS NULL OR length(target_protocol_title) <= 120 AND length(target_protocol_title) > 0),
  target_direction                         TEXT CHECK (target_direction IS NULL OR target_direction IN ('higher','lower')),
  target_precision                         TEXT CHECK (target_precision IS NULL OR target_precision IN ('integer','tenths','hundredths','centimetres')),
  origin_objective_id                      TEXT CHECK (origin_objective_id IS NULL OR length(origin_objective_id) <= 80 AND length(origin_objective_id) > 0),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  completed_at                             INTEGER,
  rev                                      INTEGER NOT NULL,
  rev_at                                   INTEGER,
  rev_by_user_id                           TEXT CHECK (rev_by_user_id IS NULL OR length(rev_by_user_id) <= 80 AND length(rev_by_user_id) > 0),
  rev_by_name                              TEXT CHECK (rev_by_name IS NULL OR length(rev_by_name) <= 200),
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (origin_objective_id) REFERENCES dev_objectives(id) ON DELETE RESTRICT,
  CHECK ((status = 'blocked') = (block_reason IS NOT NULL)),
  CHECK (status = 'blocked' OR block_note IS NULL),
  CHECK ((status = 'achieved') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX development_goals_plan ON development_goals (plan_id);

CREATE TABLE development_actions (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) <= 80 AND length(plan_id) > 0),
  goal_id                                  TEXT NOT NULL CHECK (length(goal_id) <= 80 AND length(goal_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  type                                     TEXT NOT NULL CHECK (type IN ('training','assessment','video_review','match_objective','coach_review','combine','box_cam','evidence_request','custom')),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  due_at                                   INTEGER,
  assignee_kind                            TEXT CHECK (assignee_kind IS NULL OR assignee_kind IN ('player','guardian','org_user')),
  assignee_id                              TEXT CHECK (assignee_id IS NULL OR length(assignee_id) <= 80 AND length(assignee_id) > 0),
  assignee_name                            TEXT CHECK (assignee_name IS NULL OR length(assignee_name) <= 200),
  status                                   TEXT NOT NULL CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
  created_by_kind                          TEXT NOT NULL CHECK (created_by_kind IN ('player','guardian','org')),
  created_by_id                            TEXT NOT NULL CHECK (length(created_by_id) <= 80 AND length(created_by_id) > 0),
  created_by_name                          TEXT CHECK (created_by_name IS NULL OR length(created_by_name) <= 200),
  created_at                               INTEGER NOT NULL,
  updated_at                               INTEGER NOT NULL,
  completed_at                             INTEGER,
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (goal_id) REFERENCES development_goals(id) ON DELETE RESTRICT,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX development_actions_plan ON development_actions (plan_id);
CREATE INDEX development_actions_goal ON development_actions (goal_id);

CREATE TABLE development_evidence_links (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) <= 80 AND length(plan_id) > 0),
  goal_id                                  TEXT CHECK (goal_id IS NULL OR length(goal_id) <= 80 AND length(goal_id) > 0),
  action_id                                TEXT CHECK (action_id IS NULL OR length(action_id) <= 80 AND length(action_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  source_type                              TEXT NOT NULL CHECK (source_type IN ('passport_evidence','assessment','box_cam_session','combine_attempt','trial_report')),
  source_id                                TEXT NOT NULL CHECK (length(source_id) <= 80 AND length(source_id) > 0),
  linked_by_kind                           TEXT NOT NULL CHECK (linked_by_kind IN ('player','guardian','org')),
  linked_by_id                             TEXT NOT NULL CHECK (length(linked_by_id) <= 80 AND length(linked_by_id) > 0),
  linked_by_name                           TEXT CHECK (linked_by_name IS NULL OR length(linked_by_name) <= 200),
  linked_at                                INTEGER NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (goal_id) REFERENCES development_goals(id) ON DELETE RESTRICT,
  FOREIGN KEY (action_id) REFERENCES development_actions(id) ON DELETE RESTRICT,
  CHECK ((goal_id IS NULL) <> (action_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX development_evidence_links_target_source ON development_evidence_links (coalesce(goal_id, action_id), source_type, source_id);
CREATE INDEX development_evidence_links_plan ON development_evidence_links (plan_id);

CREATE TABLE development_reviews (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) <= 80 AND length(plan_id) > 0),
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  reviewer_kind                            TEXT NOT NULL CHECK (reviewer_kind IN ('player_reflection','guardian_reflection','coach_review')),
  reviewed_by_kind                         TEXT NOT NULL CHECK (reviewed_by_kind IN ('player','guardian','org')),
  reviewed_by_id                           TEXT NOT NULL CHECK (length(reviewed_by_id) <= 80 AND length(reviewed_by_id) > 0),
  reviewed_by_name                         TEXT CHECK (reviewed_by_name IS NULL OR length(reviewed_by_name) <= 200),
  org_id                                   TEXT CHECK (org_id IS NULL OR length(org_id) <= 80 AND length(org_id) > 0),
  reviewed_at                              INTEGER NOT NULL,
  shared_summary                           TEXT CHECK (shared_summary IS NULL OR length(shared_summary) <= 2000),
  internal_note                            TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  next_review_at                           INTEGER,
  shared_with_player_at                    INTEGER,
  supersedes_review_id                     TEXT CHECK (supersedes_review_id IS NULL OR length(supersedes_review_id) <= 80 AND length(supersedes_review_id) > 0),
  created_at                               INTEGER NOT NULL,
  share_summary                            INTEGER NOT NULL CHECK (share_summary IN (0,1)),
  share_goals                              INTEGER NOT NULL CHECK (share_goals IN (0,1)),
  share_actions                            INTEGER NOT NULL CHECK (share_actions IN (0,1)),
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_review_id) REFERENCES development_reviews(id) ON DELETE RESTRICT,
  CHECK (shared_summary IS NOT NULL OR internal_note IS NOT NULL),
  CHECK ((reviewer_kind = 'coach_review') = (org_id IS NOT NULL)),
  CHECK (reviewer_kind = 'coach_review' OR internal_note IS NULL),
  CHECK ((share_summary + share_goals + share_actions = 0) OR shared_with_player_at IS NOT NULL)
) STRICT;
CREATE INDEX development_reviews_plan ON development_reviews (plan_id);
CREATE INDEX development_reviews_org ON development_reviews (org_id) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX development_reviews_supersedes ON development_reviews (supersedes_review_id) WHERE supersedes_review_id IS NOT NULL;

CREATE TABLE development_review_snapshots (
  review_id                                TEXT NOT NULL CHECK (length(review_id) <= 80 AND length(review_id) > 0),
  ord                                      INTEGER NOT NULL,
  goal_id                                  TEXT NOT NULL CHECK (length(goal_id) <= 80 AND length(goal_id) > 0),
  title                                    TEXT NOT NULL CHECK (length(title) <= 120 AND length(title) > 0),
  category                                 TEXT NOT NULL CHECK (category IN ('technical','tactical','physical','psychological','match_understanding','position_specific','other')),
  status                                   TEXT NOT NULL CHECK (status IN ('not_started','in_progress','blocked','achieved','stopped')),
  actions_total                            INTEGER NOT NULL,
  actions_done                             INTEGER NOT NULL,
  actions_blocked                          INTEGER NOT NULL,
  actions_cancelled                        INTEGER NOT NULL,
  target_state                             TEXT CHECK (target_state IS NULL OR target_state IN ('target_met','target_not_met','no_current_valid_measurement')),
  target_reason                            TEXT CHECK (target_reason IS NULL OR target_reason IN ('no_attempts','no_production_valid_attempt','protocol_version_mismatch','measurement_invalidated')),
  target_measured                          REAL,
  FOREIGN KEY (review_id) REFERENCES development_reviews(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES development_goals(id) ON DELETE RESTRICT,
  PRIMARY KEY (review_id, goal_id),
  UNIQUE (review_id, ord),
  CHECK (ord >= 0),
  CHECK (actions_total >= 0 AND actions_done >= 0 AND actions_blocked >= 0 AND actions_cancelled >= 0 AND actions_done + actions_blocked + actions_cancelled <= actions_total)
) STRICT;

CREATE TABLE development_review_snapshot_refs (
  review_id                                TEXT NOT NULL CHECK (length(review_id) > 0 AND length(review_id) <= 80),
  goal_id                                  TEXT NOT NULL CHECK (length(goal_id) > 0 AND length(goal_id) <= 80),
  ord                                      INTEGER NOT NULL CHECK (ord >= 0),
  source_type                              TEXT NOT NULL CHECK (source_type IN ('passport_evidence','assessment','box_cam_session','combine_attempt','trial_report')),
  source_id                                TEXT NOT NULL CHECK (length(source_id) > 0 AND length(source_id) <= 80),
  FOREIGN KEY (review_id, goal_id) REFERENCES development_review_snapshots(review_id, goal_id) ON DELETE CASCADE,
  PRIMARY KEY (review_id, goal_id, ord)
) STRICT;

CREATE TABLE development_history (
  id                                       TEXT PRIMARY KEY CHECK (length(id) > 0 AND length(id) <= 80),
  plan_id                                  TEXT NOT NULL CHECK (length(plan_id) <= 80 AND length(plan_id) > 0),
  goal_id                                  TEXT CHECK (goal_id IS NULL OR length(goal_id) <= 80 AND length(goal_id) > 0),
  action_id                                TEXT CHECK (action_id IS NULL OR length(action_id) <= 80 AND length(action_id) > 0),
  review_id                                TEXT CHECK (review_id IS NULL OR length(review_id) <= 80 AND length(review_id) > 0),
  at                                       INTEGER NOT NULL,
  by_kind                                  TEXT NOT NULL CHECK (by_kind IN ('player','guardian','org')),
  by_id                                    TEXT NOT NULL CHECK (length(by_id) <= 80 AND length(by_id) > 0),
  by_name                                  TEXT CHECK (by_name IS NULL OR length(by_name) <= 200),
  action                                   TEXT NOT NULL CHECK (action IN ('plan_created','plan_activated','plan_paused','plan_completed','plan_archived','plan_shared','plan_unshared','plan_visibility_changed','plan_updated','goal_created','goal_updated','goal_status_changed','goal_target_set','action_created','action_status_changed','action_completed','evidence_linked','evidence_unlinked','review_submitted','review_shared','review_superseded')),
  detail_from                              TEXT CHECK (detail_from IS NULL OR length(detail_from) <= 40 AND length(detail_from) > 0),
  detail_to                                TEXT CHECK (detail_to IS NULL OR length(detail_to) <= 40 AND length(detail_to) > 0),
  detail_visibility                        TEXT CHECK (detail_visibility IS NULL OR detail_visibility IN ('private','player_guardian','shared_with_org','org_private')),
  detail_owner                             TEXT CHECK (detail_owner IS NULL OR detail_owner IN ('player','org')),
  detail_kind                              TEXT CHECK (detail_kind IS NULL OR length(detail_kind) <= 40 AND length(detail_kind) > 0),
  detail_protocol_id                       TEXT CHECK (detail_protocol_id IS NULL OR length(detail_protocol_id) <= 80 AND length(detail_protocol_id) > 0),
  detail_note                              INTEGER CHECK (detail_note IS NULL OR detail_note IN (0,1)),
  FOREIGN KEY (plan_id) REFERENCES development_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id) REFERENCES development_goals(id) ON DELETE CASCADE,
  FOREIGN KEY (action_id) REFERENCES development_actions(id) ON DELETE CASCADE,
  FOREIGN KEY (review_id) REFERENCES development_reviews(id) ON DELETE CASCADE,
  CHECK ((goal_id IS NOT NULL) + (action_id IS NOT NULL) + (review_id IS NOT NULL) <= 1)
) STRICT;
CREATE INDEX development_history_plan ON development_history (plan_id);
CREATE INDEX development_history_goal ON development_history (goal_id) WHERE goal_id IS NOT NULL;
CREATE INDEX development_history_action ON development_history (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX development_history_review ON development_history (review_id) WHERE review_id IS NOT NULL;


-- =============================================================================
-- M13 F4 exposure, review queue · F6 evidence gaps · F5 calibration · F7 fixtures and coverage
-- S12d: IMPLEMENTED, migration 0033_insight_coverage REGISTERED (repositories/insightCoverage.mjs, 5 Nov 2026).
-- The DDL below is the migration's, generated from the repository's field specs (scripts/testSchemaDdl.mjs compares
-- them column for column).
-- =============================================================================

-- Exposure events (exposure_events): one per (organisation, player, kind, UTC day), unique; recording one is an insert
-- that does nothing when the day has it. The old global 50k cap is gone: every reader looks at the last 90 days, and the
-- insight sweep deletes the events before that window.
-- Review-later (review_later): one deferral per (organisation, player), replaced on re-defer; the reminder sweep reads
-- the due ones through the partial index and marks each reminded with its notification.
-- Evidence suggestions (evidence_suggestions): the cited record ids are ordered rows (evidence_suggestion_records) —
-- media, assessment or evidence ids by rule, no key (tolerant). At most one open (suggested|requested) suggestion per
-- (organisation, player, rule). The rule's action copy comes from the rule registry, not stored.
-- Calibration (calibration_sessions): the rubric is the pinned template version, a key to assessment_templates (id,
-- version), never a copy. Participants, blind submissions (one per participant: a key to the participant row),
-- ratings (1–5 or not observed) and notes are rows. The reference media id has no key (tolerant).
-- Fixtures (fixtures): an organisation's own matches on a real day; a location is lat, lng and city together.
-- Coverage plans (coverage_plans): a goal of 1–200 observations over 7–365 days; progress is counted on read.
-- Coverage assignments (coverage_assignments): the fixture is the organisation's own (fixture_id, a RESTRICT key) or a
-- friendly or an open day (event_id, no key: blob records until S13). Targets and the warnings raised at creation
-- (a code and the scout named; the sentence is rendered on read) are rows; the travel note is constant copy; the
-- assessment the observation produced is one column.
-- Player, media and assessment ids carry no key (tolerant). Organisations and the staff named are RESTRICT keys.

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
  event_id                                 TEXT CHECK (event_id IS NULL OR length(event_id) <= 80 AND length(event_id) > 0),
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
  CHECK ((fixture_kind = 'own') = (fixture_id IS NOT NULL)),
  CHECK ((fixture_kind = 'own') = (event_id IS NULL)),
  CHECK ((travel_budget_minor IS NULL) = (travel_currency IS NULL)),
  CHECK (travel_budget_minor IS NULL OR travel_budget_minor >= 0),
  CHECK (travel_budget_minor IS NOT NULL OR travel_entered_by_name IS NULL),
  CHECK (assessment_id IS NULL OR observed_at IS NOT NULL)
) STRICT;
CREATE INDEX coverage_assignments_org_created ON coverage_assignments (org_id, created_at, id);
CREATE INDEX coverage_assignments_org_fixture ON coverage_assignments (org_id, fixture_kind, fixture_id, event_id);
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


-- =============================================================================
-- not tables:
-- =============================================================================
-- Code registries (versioned, referenced by id[@version] from the tables above):
--   m16/drills.mjs DRILLS (drill_id@drill_version), PROVIDERS (provider_id/version),
--   LIVENESS_CHALLENGES; m16/combineShared.mjs COMBINE_PROTOCOLS (protocol_id@version,
--   measurement_algorithm_version); m22/policy.mjs CANDIDATE_PROTOCOLS, FRAME_LIMITS,
--   CV_ENGINE_VERSION / BOX_CAM_CV_POLICY_VERSION; m22/eligibility.mjs validation
--   record (combine eligibility, currently empty); m21/shared.mjs vocabularies,
--   GOAL_LIBRARY, PLAN_TEMPLATES, M21_LIMITS; domains/discovery/shared.mjs CHANGE_TYPES,
--   REASON_CHANGE_MAP, POLICY, EVALUATION_SIGNALS, POSITIONS, TRUST_BANDS,
--   EVIDENCE_REQUIREMENTS; domains/discovery/matching/criteria.mjs CRITERION_TYPES, OPERATORS;
--   domains/insight/insight.mjs RULES (evidence-gap rule engine); server.mjs DRILLS (legacy
--   drill registry seeding drill_guidance).
-- In-memory state (lost on restart by design, never persisted):
--   rate-limit buckets (domains/platform/rateLimit.mjs), box dispute windows (m16/training.mjs
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
