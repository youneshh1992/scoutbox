-- 0015_recruitment: recruitment requests and accepted trials become typed tables (recruitment_requests, request_trial_slots, trials and its thirteen owned child tables; vocabulary CHECKs, no lossless side columns; the case and trial keys deferred to COMMIT while cases are staged; the player references tolerant and counted (Q7a), the guardian references checked in code (Q7c))

CREATE TABLE recruitment_requests (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,
  org_type TEXT CHECK (org_type IS NULL OR org_type IN ('club','agency')),
  org_verified INTEGER NOT NULL CHECK (org_verified IS NULL OR org_verified IN (0,1)),
  org_safeguarding_certified INTEGER NOT NULL CHECK (org_safeguarding_certified IS NULL OR org_safeguarding_certified IN (0,1)),
  org_trusted_partner INTEGER CHECK (org_trusted_partner IS NULL OR org_trusted_partner IN (0,1)),
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT,
  scout_role TEXT,
  type TEXT NOT NULL CHECK (type IS NULL OR type IN ('contact','trial')),
  message TEXT,
  subject TEXT,
  contact_id TEXT,
  trial_proposed_date TEXT CHECK (trial_proposed_date IS NULL OR trial_proposed_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  trial_alt_days_json TEXT CHECK (trial_alt_days_json IS NULL OR (json_valid(trial_alt_days_json) AND json_type(trial_alt_days_json) = 'array')),
  trial_venue TEXT,
  trial_notes TEXT,
  trial_private_venue_address TEXT CHECK (trial_private_venue_address IS NULL OR length(trial_private_venue_address) <= 200),
  trial_private_instructions TEXT CHECK (trial_private_instructions IS NULL OR length(trial_private_instructions) <= 500),
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('pending','accepted','declined','suspended')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT CHECK (responded_by IS NULL OR responded_by IN ('player','guardian')),
  routed_to TEXT NOT NULL CHECK (routed_to IS NULL OR routed_to IN ('player','guardian')),
  guardian_id TEXT,
  contact_channel_id TEXT,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  trial_id TEXT REFERENCES trials(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  invite_key TEXT CHECK (invite_key IS NULL OR length(invite_key) <= 64),
  invite_fp TEXT,
  subject_removed_at INTEGER,
  CHECK ((type = 'trial') = (trial_alt_days_json IS NOT NULL)),
  CHECK ((recipient_type IS NULL) = (recipient_minor IS NULL)),
  CHECK ((invite_key IS NULL) = (invite_fp IS NULL))
) STRICT;
CREATE INDEX recruitment_requests_org_player_type_status ON recruitment_requests (org_id, player_id, type, status);
CREATE INDEX recruitment_requests_org ON recruitment_requests (org_id);
CREATE INDEX recruitment_requests_player ON recruitment_requests (player_id, created_at);
CREATE INDEX recruitment_requests_routed_guardian ON recruitment_requests (routed_to, guardian_id);
CREATE INDEX recruitment_requests_case_type_created ON recruitment_requests (case_id, type, created_at);
CREATE INDEX recruitment_requests_contact ON recruitment_requests (contact_id);
CREATE INDEX recruitment_requests_trial ON recruitment_requests (trial_id);
CREATE TABLE request_trial_slots (
  request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day IS NULL OR day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('onboarding','training','drill','small_sided','match','other')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  venue_name TEXT CHECK (venue_name IS NULL OR length(venue_name) <= 120),
  venue_town TEXT CHECK (venue_town IS NULL OR length(venue_town) <= 80),
  venue_address TEXT CHECK (venue_address IS NULL OR length(venue_address) <= 200),
  PRIMARY KEY (request_id, position),
  UNIQUE (request_id, day),
  CHECK (ends_at > starts_at)
) STRICT;
CREATE TABLE trials (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  player_name TEXT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,
  scout_name TEXT,
  accepted_at INTEGER NOT NULL,
  accepted_by TEXT CHECK (accepted_by IS NULL OR accepted_by IN ('player','guardian')),
  guardian_approved INTEGER CHECK (guardian_approved IS NULL OR guardian_approved IN (0,1)),
  proposed_date TEXT CHECK (proposed_date IS NULL OR proposed_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  venue TEXT,
  notes TEXT,
  report_due_at INTEGER,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('awaiting_report','reported')),
  reminder_sent INTEGER NOT NULL CHECK (reminder_sent IS NULL OR reminder_sent IN (0,1)),
  feedback_escalated_at INTEGER,
  workflow_state TEXT NOT NULL CHECK (workflow_state IS NULL OR workflow_state IN ('legacy_accepted','accepted','scheduled','completed','cancelled')),
  schedule_timezone TEXT,
  schedule_revision INTEGER,
  schedule_proposed_at INTEGER,
  schedule_proposed_by_kind TEXT CHECK (schedule_proposed_by_kind IS NULL OR schedule_proposed_by_kind IN ('org','player','guardian','system')),
  schedule_proposed_by_user_id TEXT,
  schedule_proposed_by_actor_id TEXT,
  schedule_proposed_by_name TEXT,
  schedule_confirmed_at INTEGER,
  schedule_confirmed_by_kind TEXT CHECK (schedule_confirmed_by_kind IS NULL OR schedule_confirmed_by_kind IN ('org','player','guardian','system')),
  schedule_confirmed_by_user_id TEXT,
  schedule_confirmed_by_actor_id TEXT,
  schedule_confirmed_by_name TEXT,
  schedule_declined_at INTEGER,
  schedule_declined_by_kind TEXT CHECK (schedule_declined_by_kind IS NULL OR schedule_declined_by_kind IN ('org','player','guardian','system')),
  schedule_declined_by_user_id TEXT,
  schedule_declined_by_actor_id TEXT,
  schedule_declined_by_name TEXT,
  completion_state TEXT CHECK (completion_state IS NULL OR completion_state IN ('completed','cancelled')),
  completion_at INTEGER,
  completion_by_kind TEXT CHECK (completion_by_kind IS NULL OR completion_by_kind IN ('org','player','guardian','system')),
  completion_by_user_id TEXT,
  completion_by_actor_id TEXT,
  completion_by_name TEXT,
  completion_reason TEXT CHECK (completion_reason IS NULL OR length(completion_reason) <= 300),
  completion_phase TEXT CHECK (completion_phase IS NULL OR completion_phase IN ('legacy_accepted','accepted','scheduled','completed','cancelled')),
  completion_cancelled_by TEXT CHECK (completion_cancelled_by IS NULL OR completion_cancelled_by IN ('club','player','guardian','system')),
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  recipient_at INTEGER,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  day_arrival_time TEXT CHECK (day_arrival_time IS NULL OR length(day_arrival_time) <= 40),
  day_arrival_address TEXT CHECK (day_arrival_address IS NULL OR length(day_arrival_address) <= 200),
  day_arrival_notes TEXT CHECK (day_arrival_notes IS NULL OR length(day_arrival_notes) <= 300),
  day_emergency_name TEXT CHECK (day_emergency_name IS NULL OR length(day_emergency_name) <= 80),
  day_emergency_phone TEXT CHECK (day_emergency_phone IS NULL OR length(day_emergency_phone) <= 30),
  day_emergency_set_by TEXT CHECK (day_emergency_set_by IS NULL OR day_emergency_set_by IN ('player','guardian')),
  day_emergency_at INTEGER,
  day_collection_policy TEXT CHECK (day_collection_policy IS NULL OR length(day_collection_policy) <= 300),
  rev INTEGER NOT NULL CHECK (rev >= 0),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  subject_removed_at INTEGER,
  UNIQUE (id, player_id),
  CHECK ((schedule_timezone IS NULL) = (schedule_revision IS NULL)),
  CHECK ((completion_state IS NULL) = (completion_at IS NULL)),
  CHECK ((recipient_type IS NULL) = (recipient_minor IS NULL)),
  CHECK (day_emergency_at IS NOT NULL OR (day_emergency_name IS NULL AND day_emergency_phone IS NULL))
) STRICT;
CREATE INDEX trials_org_status ON trials (org_id, status);
CREATE INDEX trials_org ON trials (org_id);
CREATE INDEX trials_org_player_case ON trials (org_id, player_id, case_id);
CREATE INDEX trials_player ON trials (player_id);
CREATE INDEX trials_case ON trials (case_id);
CREATE INDEX trials_status_report_due ON trials (status, report_due_at);
CREATE INDEX trials_workflow_confirmed ON trials (workflow_state, schedule_confirmed_at);
CREATE UNIQUE INDEX trials_one_open_per_case ON trials (case_id) WHERE case_id IS NOT NULL AND workflow_state NOT IN ('completed', 'cancelled');
CREATE INDEX trials_report_overdue ON trials (report_due_at) WHERE feedback_escalated_at IS NULL AND subject_removed_at IS NULL;
CREATE INDEX trials_confirmed_open ON trials (schedule_confirmed_at) WHERE completion_state IS NULL AND subject_removed_at IS NULL;
CREATE INDEX trials_completion ON trials (completion_state, completion_at);
CREATE TABLE trial_schedule_sessions (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('onboarding','training','drill','small_sided','match','other')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  venue_name TEXT CHECK (venue_name IS NULL OR length(venue_name) <= 120),
  venue_town TEXT CHECK (venue_town IS NULL OR length(venue_town) <= 80),
  venue_address TEXT CHECK (venue_address IS NULL OR length(venue_address) <= 200),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 500),
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, id),
  CHECK (ends_at > starts_at)
) STRICT;
CREATE INDEX trial_schedule_sessions_trial_starts ON trial_schedule_sessions (trial_id, starts_at);
CREATE INDEX trial_schedule_sessions_starts ON trial_schedule_sessions (starts_at);
CREATE TABLE trial_session_evidence (
  trial_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('box_cam_session')),
  box_session_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  linked_by_kind TEXT CHECK (linked_by_kind IS NULL OR linked_by_kind IN ('org','player','guardian','system')),
  linked_by_user_id TEXT,
  linked_by_actor_id TEXT,
  linked_by_name TEXT,
  removed_at INTEGER,
  removed_by_kind TEXT CHECK (removed_by_kind IS NULL OR removed_by_kind IN ('org','player','guardian','system')),
  removed_by_user_id TEXT,
  removed_by_actor_id TEXT,
  removed_by_name TEXT,
  PRIMARY KEY (trial_id, session_id, position),
  FOREIGN KEY (trial_id, session_id) REFERENCES trial_schedule_sessions(trial_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX trial_session_evidence_box_session ON trial_session_evidence (box_session_id);
CREATE UNIQUE INDEX trial_session_evidence_one_active ON trial_session_evidence (trial_id, session_id, box_session_id) WHERE removed_at IS NULL;
CREATE TABLE trial_schedule_revisions (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  proposed_at INTEGER,
  proposed_by_kind TEXT CHECK (proposed_by_kind IS NULL OR proposed_by_kind IN ('org','player','guardian','system')),
  proposed_by_user_id TEXT,
  proposed_by_actor_id TEXT,
  proposed_by_name TEXT,
  confirmed_at INTEGER,
  confirmed_by_kind TEXT CHECK (confirmed_by_kind IS NULL OR confirmed_by_kind IN ('org','player','guardian','system')),
  confirmed_by_user_id TEXT,
  confirmed_by_actor_id TEXT,
  confirmed_by_name TEXT,
  superseded_at INTEGER,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 300),
  material INTEGER CHECK (material IS NULL OR material IN (0,1)),
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, revision)
) STRICT;
CREATE TABLE trial_revision_sessions (
  trial_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('onboarding','training','drill','small_sided','match','other')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  venue_name TEXT CHECK (venue_name IS NULL OR length(venue_name) <= 120),
  venue_town TEXT CHECK (venue_town IS NULL OR length(venue_town) <= 80),
  venue_address TEXT CHECK (venue_address IS NULL OR length(venue_address) <= 200),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 500),
  PRIMARY KEY (trial_id, revision, position),
  FOREIGN KEY (trial_id, revision) REFERENCES trial_schedule_revisions(trial_id, revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE trial_attendance (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IS NULL OR state IN ('attended','partial','no_show','club_cancelled','player_withdrew')),
  source TEXT NOT NULL CHECK (source IS NULL OR source IN ('checkin','manual')),
  recorded_by_kind TEXT CHECK (recorded_by_kind IS NULL OR recorded_by_kind IN ('org','player','guardian','system')),
  recorded_by_user_id TEXT,
  recorded_by_actor_id TEXT,
  recorded_by_name TEXT,
  recorded_at INTEGER NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE INDEX trial_attendance_trial_session_at ON trial_attendance (trial_id, session_id, recorded_at);
CREATE TABLE trial_history (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IS NULL OR length(action) <= 64),
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','system')),
  by_user_id TEXT,
  by_actor_id TEXT,
  by_name TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR (json_valid(detail_json) AND json_type(detail_json) = 'object')),
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, id)
) STRICT;
CREATE INDEX trial_history_trial_at ON trial_history (trial_id, at);
CREATE TABLE trial_keys (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  act TEXT NOT NULL CHECK (act IS NULL OR act IN ('schedule','cancel','attendance','complete','link')),
  position INTEGER NOT NULL,
  key TEXT NOT NULL CHECK (key IS NULL OR length(key) <= 64),
  fp TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, act, position)
) STRICT;
CREATE INDEX trial_keys_key ON trial_keys (trial_id, act, key);
CREATE TABLE trial_reminders (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  marker TEXT NOT NULL CHECK (marker IS NULL OR length(marker) <= 120),
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, marker)
) STRICT;
CREATE TABLE trial_reports (
  trial_id TEXT PRIMARY KEY REFERENCES trials(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT,
  user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT,
  filed_at INTEGER NOT NULL,
  acceleration REAL NOT NULL,
  sprint_speed_kmh REAL NOT NULL,
  distance_km REAL NOT NULL,
  pass_completion_pct REAL NOT NULL,
  duel_success_pct REAL NOT NULL,
  coach_rating REAL NOT NULL,
  notes TEXT,
  strength_note TEXT,
  focus_note TEXT,
  FOREIGN KEY (trial_id, player_id) REFERENCES trials(id, player_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX trial_reports_player ON trial_reports (player_id, filed_at);
CREATE INDEX trial_reports_org ON trial_reports (org_id, filed_at);
CREATE TABLE trial_day_staff (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IS NULL OR length(name) <= 80),
  role TEXT NOT NULL CHECK (role IS NULL OR length(role) <= 60),
  check_kind TEXT CHECK (check_kind IS NULL OR length(check_kind) <= 60),
  check_ref TEXT CHECK (check_ref IS NULL OR length(check_ref) <= 60),
  check_status TEXT CHECK (check_status IS NULL OR check_status IN ('pending','reviewed','expired','rejected')),
  check_expires_at TEXT,
  check_reviewed_by TEXT,
  check_reviewed_at INTEGER,
  added_by_name TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, id),
  CHECK (check_status IS NOT NULL OR (check_kind IS NULL AND check_ref IS NULL AND check_expires_at IS NULL AND check_reviewed_by IS NULL AND check_reviewed_at IS NULL))
) STRICT;
CREATE INDEX trial_day_staff_check ON trial_day_staff (check_status) WHERE check_status IS NOT NULL;
CREATE TABLE trial_day_consents (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','system')),
  by_user_id TEXT,
  by_actor_id TEXT,
  by_name TEXT,
  scope TEXT NOT NULL CHECK (scope IS NULL OR scope IN ('player_event_consent','guardian_event_consent')),
  at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE UNIQUE INDEX trial_day_consents_one_per_actor ON trial_day_consents (trial_id, scope, by_actor_id) WHERE by_actor_id IS NOT NULL;
CREATE TABLE trial_day_checkins (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by_user_id TEXT,
  by_name TEXT,
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE TABLE trial_day_status_events (
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('cancelled','postponed')),
  at INTEGER NOT NULL,
  by_name TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  new_date TEXT CHECK (new_date IS NULL OR new_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  PRIMARY KEY (trial_id, position)
) STRICT;
