-- 0031_box_cam: Box Cam preferences, challenges, assignments, sessions and disputes, Combine requests and attempts, and production CV results become typed tables

CREATE TABLE box_cam_prefs (
  player_id                                TEXT NOT NULL CHECK (length(player_id) <= 80 AND length(player_id) > 0),
  share_development_activity               TEXT NOT NULL CHECK (share_development_activity IN ('private','recruitment')),
  retain_clips                             INTEGER NOT NULL CHECK (retain_clips IN (0,1)),
  updated_at                               INTEGER,
  updated_by_kind                          TEXT CHECK (updated_by_kind IS NULL OR updated_by_kind IN ('player','guardian')),
  updated_by_id                            TEXT CHECK (updated_by_id IS NULL OR length(updated_by_id) <= 80 AND length(updated_by_id) > 0),
  PRIMARY KEY (player_id),
  CHECK ((updated_at IS NULL) = (updated_by_kind IS NULL) AND (updated_at IS NULL) = (updated_by_id IS NULL))
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
  UNIQUE (id, player_id),
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
  UNIQUE (id, player_id),
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
  FOREIGN KEY (assignment_id, player_id) REFERENCES box_assignments(id, player_id) ON DELETE RESTRICT,
  FOREIGN KEY (challenge_entry_id, player_id) REFERENCES box_challenge_entries(id, player_id) ON DELETE RESTRICT,
  UNIQUE (id, player_id),
  CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*'),
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
  FOREIGN KEY (session_id, player_id) REFERENCES box_sessions(id, player_id) ON DELETE CASCADE,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK ((resolved_at IS NULL) = (resolution_outcome IS NULL) AND (resolved_at IS NULL) = (resolution_reason IS NULL))
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
  UNIQUE (id, player_id),
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
  FOREIGN KEY (box_session_id, player_id) REFERENCES box_sessions(id, player_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id, player_id) REFERENCES combine_requests(id, player_id) ON DELETE RESTRICT,
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

INSERT INTO box_challenges (id, title, publisher_kind, publisher_org_id, publisher_org_name, publisher_by_name, drill_id, metric, target_total, starts_at, ends_at, adult_only, cap, status, created_at) VALUES ('boxc-scoutbox-1000-touch', 'The 1,000 Touch Box Challenge', 'scoutbox', NULL, NULL, NULL, 'box-touches', 'reps', 1000, (__NOW__ + 0), (__NOW__ + 2592000000), 0, NULL, 'active', (__NOW__ + 0));

INSERT INTO box_challenges (id, title, publisher_kind, publisher_org_id, publisher_org_name, publisher_by_name, drill_id, metric, target_total, starts_at, ends_at, adult_only, cap, status, created_at) VALUES ('boxc-scoutbox-first-touch', '7-Day First Touch Box Challenge', 'scoutbox', NULL, NULL, NULL, 'box-control', 'active_minutes', 60, (__NOW__ + 0), (__NOW__ + 604800000), 0, NULL, 'active', (__NOW__ + 0));
