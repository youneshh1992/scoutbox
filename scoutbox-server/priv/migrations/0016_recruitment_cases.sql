-- 0016_recruitment_cases: recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room snapshots, room decisions and room evidence states become typed tables (twenty-five tables; the player references tolerant and counted (Q8a))

CREATE TABLE recruitment_cases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  player_name TEXT,
  vacancy_id TEXT,
  owner_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT NOT NULL,
  owner_name TEXT,
  stage TEXT NOT NULL CHECK (stage IS NULL OR stage IN ('identified','review','observation','trial','decision','closed','invited','awaiting_response')),
  priority TEXT NOT NULL CHECK (priority IS NULL OR priority IN ('high','medium','low')),
  deadline_day TEXT CHECK (deadline_day IS NULL OR deadline_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  deadline_at INTEGER,
  restricted INTEGER NOT NULL CHECK (restricted IS NULL OR restricted IN (0,1)),
  decision_outcome TEXT CHECK (decision_outcome IS NULL OR decision_outcome IN ('sign','pass','monitor')),
  decision_reasons TEXT CHECK (decision_reasons IS NULL OR length(decision_reasons) <= 500),
  decision_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  decision_by_name TEXT,
  decision_approved_by_name TEXT,
  decision_at INTEGER,
  links_signing_id TEXT,
  created_at INTEGER NOT NULL,
  subject_removed_at INTEGER,
  room_status TEXT CHECK (room_status IS NULL OR room_status IN ('watching','under_review','contact_planned','contacted','shortlisted','priority','trial_requested','trial_scheduled','trial_completed','offer_consideration','offer_made','offer_accepted','offer_declined','signed','on_hold','withdrawn','archived','closed')),
  room_priority TEXT CHECK (room_priority IS NULL OR room_priority IN ('low','normal','high','urgent')),
  room_lead_scout_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  room_source_context TEXT CHECK (room_source_context IS NULL OR room_source_context IN ('search','watchlist','shortlist','opportunity','recommendation','campaign','passport','nobody_missed','second_look','matching','dynamic_watchlist','direct')),
  room_source_ref_id TEXT,
  room_source_ref_version INTEGER,
  room_opened_by_user_id TEXT,
  room_opened_by_name TEXT,
  room_updated_at INTEGER,
  room_archived_at INTEGER,
  room_closed_at INTEGER,
  room_rev INTEGER CHECK (room_rev IS NULL OR room_rev >= 0),
  room_rev_at INTEGER,
  room_rev_by_user_id TEXT,
  room_rev_by_name TEXT,
  room_reopened_at INTEGER,
  room_reopened_by_user_id TEXT,
  room_reopened_by_name TEXT,
  room_reopened_from TEXT CHECK (room_reopened_from IS NULL OR room_reopened_from IN ('watching','under_review','contact_planned','contacted','shortlisted','priority','trial_requested','trial_scheduled','trial_completed','offer_consideration','offer_made','offer_accepted','offer_declined','signed','on_hold','withdrawn','archived','closed')),
  room_reopened_reason_codes_json TEXT CHECK (room_reopened_reason_codes_json IS NULL OR (json_valid(room_reopened_reason_codes_json) AND json_type(room_reopened_reason_codes_json) = 'array')),
  room_reopened_source_context TEXT CHECK (room_reopened_source_context IS NULL OR room_reopened_source_context IN ('search','watchlist','shortlist','opportunity','recommendation','campaign','passport','nobody_missed','second_look','matching','dynamic_watchlist','direct')),
  room_reopened_source_ref_id TEXT,
  room_reopened_source_ref_version INTEGER,
  CHECK (deadline_day IS NULL OR deadline_at IS NULL),
  CHECK ((decision_outcome IS NULL) = (decision_at IS NULL)),
  CHECK ((room_status IS NULL) = (room_rev IS NULL) AND (room_status IS NULL) = (room_updated_at IS NULL) AND (room_status IS NULL) = (room_priority IS NULL)),
  CHECK ((room_reopened_at IS NULL) = (room_reopened_reason_codes_json IS NULL)),
  CHECK (room_status IS NOT NULL OR room_reopened_at IS NULL)
) STRICT;
CREATE INDEX recruitment_cases_org_created ON recruitment_cases (org_id, created_at, id);
CREATE INDEX recruitment_cases_org_room_updated ON recruitment_cases (org_id, room_updated_at, id) WHERE room_status IS NOT NULL;
CREATE INDEX recruitment_cases_org_player ON recruitment_cases (org_id, player_id);
CREATE INDEX recruitment_cases_org_room_status_updated ON recruitment_cases (org_id, room_status, room_updated_at);
CREATE INDEX recruitment_cases_org_stage ON recruitment_cases (org_id, stage);
CREATE INDEX recruitment_cases_player ON recruitment_cases (player_id);
CREATE TABLE case_room_tags (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 40),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, tag)
) STRICT;
CREATE TABLE case_assignments (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT NOT NULL,
  user_name TEXT,
  task TEXT NOT NULL CHECK (task IS NULL OR length(task) <= 200),
  due_day TEXT CHECK (due_day IS NULL OR due_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  due_at INTEGER,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('open','in_progress','done','cancelled')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK (due_day IS NULL OR due_at IS NULL)
) STRICT;
CREATE INDEX case_assignments_user ON case_assignments (user_id);
CREATE TABLE case_tasks (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  due_day TEXT CHECK (due_day IS NULL OR due_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  due_at INTEGER,
  assignee_user_id TEXT,
  assignee_name TEXT,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('open','in_progress','done','cancelled')),
  linked_resource_type TEXT CHECK (linked_resource_type IS NULL OR linked_resource_type IN ('evidence','assessment','combine_request','trial','box_cam_assignment','evidence_request','comment')),
  linked_resource_id TEXT,
  created_by_user_id TEXT,
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  completed_by_name TEXT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK (due_day IS NULL OR due_at IS NULL)
) STRICT;
CREATE INDEX case_tasks_assignee_status ON case_tasks (assignee_user_id, status);
CREATE TABLE case_approvals (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  decision_outcome TEXT NOT NULL CHECK (decision_outcome IS NULL OR decision_outcome IN ('sign','pass','monitor')),
  decision_reasons TEXT CHECK (decision_reasons IS NULL OR length(decision_reasons) <= 500),
  requested_by_user_id TEXT,
  requested_by_name TEXT,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('pending','approved','rejected')),
  requested_at INTEGER NOT NULL,
  resolved_by_user_id TEXT,
  resolved_by_name TEXT,
  resolved_at INTEGER,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
) STRICT;
CREATE TABLE case_history (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','org_user','player','guardian','system','admin','agent')),
  by_id TEXT,
  by_name TEXT,
  detail_text TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR (json_valid(detail_json) AND json_type(detail_json) = 'object')),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK (detail_text IS NULL OR detail_json IS NULL)
) STRICT;
CREATE INDEX case_history_case_at ON case_history (case_id, at);
CREATE TABLE case_request_links (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, request_id)
) STRICT;
CREATE INDEX case_request_links_request ON case_request_links (request_id);
CREATE TABLE case_trial_links (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, trial_id)
) STRICT;
CREATE INDEX case_trial_links_trial ON case_trial_links (trial_id);
CREATE TABLE case_decision_drafts (
  case_id TEXT PRIMARY KEY REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('progress','hold','reject')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  by_user_id TEXT,
  by_name TEXT,
  by_role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT,
  updated_by_name TEXT,
  updated_by_role TEXT,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  create_key TEXT CHECK (create_key IS NULL OR length(create_key) <= 64),
  create_fp TEXT,
  CHECK ((create_key IS NULL) = (create_fp IS NULL))
) STRICT;
CREATE TABLE case_decision_draft_reason_codes (
  case_id TEXT NOT NULL REFERENCES case_decision_drafts(case_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  PRIMARY KEY (case_id, position)
) STRICT;
CREATE TABLE case_decision_draft_evidence_refs (
  case_id TEXT NOT NULL REFERENCES case_decision_drafts(case_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('assessment','trial','box_cam_session','passport_evidence')),
  ref_id TEXT NOT NULL,
  meta_json TEXT CHECK (meta_json IS NULL OR (json_valid(meta_json) AND json_type(meta_json) = 'object')),
  PRIMARY KEY (case_id, position)
) STRICT;
CREATE TABLE case_transaction_handoffs (
  case_id TEXT PRIMARY KEY REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('invited','accepted','withdrawn')),
  invited_at INTEGER NOT NULL,
  invited_by_user_id TEXT,
  invited_by_name TEXT,
  accepted_at INTEGER,
  withdrawn_at INTEGER,
  transaction_id TEXT,
  represented_at_invitation INTEGER NOT NULL CHECK (represented_at_invitation IS NULL OR represented_at_invitation IN (0,1)),
  invited_agency_org_id TEXT,
  invited_agent_user_id TEXT,
  invite_key TEXT CHECK (invite_key IS NULL OR length(invite_key) <= 64),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
) STRICT;
CREATE INDEX case_transaction_handoffs_agent_status ON case_transaction_handoffs (invited_agent_user_id, status);
CREATE INDEX case_transaction_handoffs_player ON case_transaction_handoffs (player_id);
CREATE TABLE case_budget_scenarios (
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  label TEXT NOT NULL CHECK (label IS NULL OR length(label) <= 80),
  currency TEXT NOT NULL CHECK (currency IS NULL OR currency IN ('GBP','EUR','USD','CHF','SEK','NOK','DKK','PLN','BRL')),
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 72),
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approval_by_name TEXT,
  approval_by_user_id TEXT,
  approval_at INTEGER,
  approval_version INTEGER,
  approval_superseded INTEGER CHECK (approval_superseded IS NULL OR approval_superseded IN (0,1)),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK ((approval_at IS NULL) = (approval_version IS NULL) AND (approval_at IS NULL) = (approval_superseded IS NULL))
) STRICT;
CREATE TABLE case_budget_lines (
  case_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('wage','fee','bonus','expense')),
  label TEXT NOT NULL CHECK (label IS NULL OR length(label) <= 80),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (currency IS NULL OR currency IN ('GBP','EUR','USD','CHF','SEK','NOK','DKK','PLN','BRL')),
  schedule TEXT NOT NULL CHECK (schedule IS NULL OR schedule IN ('one_off','weekly','monthly','annual')),
  confirmed INTEGER NOT NULL CHECK (confirmed IS NULL OR confirmed IN (0,1)),
  conditional_assumption TEXT CHECK (conditional_assumption IS NULL OR length(conditional_assumption) <= 200),
  PRIMARY KEY (case_id, scenario_id, position),
  UNIQUE (case_id, scenario_id, id),
  FOREIGN KEY (case_id, scenario_id) REFERENCES case_budget_scenarios(case_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE case_budget_fx_assumptions (
  case_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  from_currency TEXT NOT NULL CHECK (from_currency IS NULL OR from_currency IN ('GBP','EUR','USD','CHF','SEK','NOK','DKK','PLN','BRL')),
  to_currency TEXT NOT NULL CHECK (to_currency IS NULL OR to_currency IN ('GBP','EUR','USD','CHF','SEK','NOK','DKK','PLN','BRL')),
  rate TEXT NOT NULL CHECK (length(rate) BETWEEN 1 AND 32),
  source TEXT CHECK (source IS NULL OR length(source) <= 80),
  date TEXT NOT NULL CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  manual INTEGER NOT NULL CHECK (manual IS NULL OR manual IN (0,1)),
  PRIMARY KEY (case_id, scenario_id, position),
  FOREIGN KEY (case_id, scenario_id) REFERENCES case_budget_scenarios(case_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE case_budget_actuals (
  case_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  at INTEGER NOT NULL,
  recorded_by_name TEXT,
  PRIMARY KEY (case_id, scenario_id, position),
  FOREIGN KEY (case_id, scenario_id) REFERENCES case_budget_scenarios(case_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE room_comments (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  author_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  reply_to_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edit_count INTEGER NOT NULL CHECK (edit_count >= 0),
  deleted_at INTEGER,
  deleted_by_user_id TEXT,
  deleted_by_name TEXT,
  UNIQUE (room_id, id),
  FOREIGN KEY (room_id, reply_to_id) REFERENCES room_comments(room_id, id) ON DELETE RESTRICT,
  CHECK (deleted_at IS NOT NULL OR (deleted_by_user_id IS NULL AND deleted_by_name IS NULL))
) STRICT;
CREATE INDEX room_comments_room_created ON room_comments (room_id, created_at);
CREATE INDEX room_comments_author ON room_comments (author_user_id);
CREATE TABLE room_comment_mentions (
  comment_id TEXT NOT NULL REFERENCES room_comments(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (comment_id, position),
  UNIQUE (comment_id, user_id)
) STRICT;
CREATE TABLE room_snapshots (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (length(trigger) BETWEEN 1 AND 120),
  trust_score REAL,
  trust_band TEXT,
  trust_policy_version INTEGER,
  trust_component_levels_json TEXT CHECK (trust_component_levels_json IS NULL OR (json_valid(trust_component_levels_json) AND json_type(trust_component_levels_json) = 'object')),
  trust_hash TEXT,
  source_passport_version INTEGER,
  source_passport_revision TEXT,
  note TEXT,
  UNIQUE (room_id, id),
  CHECK ((trust_hash IS NULL) = (trust_component_levels_json IS NULL))
) STRICT;
CREATE INDEX room_snapshots_room_at ON room_snapshots (room_id, at);
CREATE INDEX room_snapshots_player ON room_snapshots (player_id);
CREATE TABLE room_snapshot_source_refs (
  snapshot_id TEXT NOT NULL REFERENCES room_snapshots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('evidence','assessment','combine','trial')),
  position INTEGER NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, position)
) STRICT;
CREATE TABLE room_decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  kind TEXT CHECK (kind IS NULL OR kind IN ('recommendation','formal')),
  state TEXT CHECK (state IS NULL OR state IN ('draft','final')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('progress','hold','reject')),
  recommendation TEXT NOT NULL CHECK (recommendation IS NULL OR recommendation IN ('no_decision','continue_watching','shortlist','priority','trial','offer','archive')),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  by_user_id TEXT,
  by_name TEXT,
  by_role TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  trigger TEXT CHECK (trigger IS NULL OR length(trigger) <= 120),
  client_key TEXT CHECK (client_key IS NULL OR length(client_key) <= 64),
  supersedes_id TEXT,
  superseded_by_id TEXT,
  supersession_of_id TEXT,
  supersession_reason TEXT CHECK (supersession_reason IS NULL OR length(supersession_reason) <= 500),
  rev INTEGER CHECK (rev IS NULL OR rev >= 1),
  rev_at INTEGER,
  assessments_submitted INTEGER,
  assessments_withheld INTEGER,
  assessment_verdicts_json TEXT CHECK (assessment_verdicts_json IS NULL OR (json_valid(assessment_verdicts_json) AND json_type(assessment_verdicts_json) = 'object')),
  snapshot_id TEXT,
  finalize_key TEXT CHECK (finalize_key IS NULL OR length(finalize_key) <= 64),
  finalize_fp TEXT,
  draft_key TEXT CHECK (draft_key IS NULL OR length(draft_key) <= 64),
  draft_fp TEXT,
  draft_id TEXT,
  lifecycle_action TEXT,
  lifecycle_from TEXT CHECK (lifecycle_from IS NULL OR lifecycle_from IN ('watching','under_review','contact_planned','contacted','shortlisted','priority','trial_requested','trial_scheduled','trial_completed','offer_consideration','offer_made','offer_accepted','offer_declined','signed','on_hold','withdrawn','archived','closed')),
  lifecycle_to TEXT CHECK (lifecycle_to IS NULL OR lifecycle_to IN ('watching','under_review','contact_planned','contacted','shortlisted','priority','trial_requested','trial_scheduled','trial_completed','offer_consideration','offer_made','offer_accepted','offer_declined','signed','on_hold','withdrawn','archived','closed')),
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  policy_version INTEGER,
  UNIQUE (room_id, id),
  FOREIGN KEY (room_id, snapshot_id) REFERENCES room_snapshots(room_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id, supersedes_id) REFERENCES room_decisions(room_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id, superseded_by_id) REFERENCES room_decisions(room_id, id) ON DELETE RESTRICT,
  CHECK ((finalize_key IS NULL) = (finalize_fp IS NULL)),
  CHECK ((draft_key IS NULL) = (draft_fp IS NULL)),
  CHECK ((assessments_submitted IS NULL) = (assessment_verdicts_json IS NULL)),
  CHECK ((supersession_of_id IS NULL) = (supersession_reason IS NULL))
) STRICT;
CREATE INDEX room_decisions_room_created ON room_decisions (room_id, created_at);
CREATE INDEX room_decisions_room_client_key ON room_decisions (room_id, client_key);
CREATE INDEX room_decisions_player ON room_decisions (player_id);
CREATE INDEX room_decisions_org_player ON room_decisions (org_id, player_id);
CREATE TABLE room_decision_reason_codes (
  decision_id TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  PRIMARY KEY (decision_id, position)
) STRICT;
CREATE TABLE room_decision_evidence_refs (
  decision_id TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IS NULL OR kind IN ('assessment','trial','box_cam_session','passport_evidence')),
  ref_id TEXT NOT NULL,
  meta_json TEXT CHECK (meta_json IS NULL OR (json_valid(meta_json) AND json_type(meta_json) = 'object')),
  PRIMARY KEY (decision_id, position)
) STRICT;
CREATE INDEX room_decision_evidence_refs_ref ON room_decision_evidence_refs (kind, ref_id);
CREATE TABLE room_decision_assessment_ids (
  decision_id TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  assessment_id TEXT NOT NULL,
  PRIMARY KEY (decision_id, position)
) STRICT;
CREATE TABLE room_evidence_states (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  evidence_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IS NULL OR state IN ('not_reviewed','reviewing','reviewed','needs_follow_up')),
  note TEXT CHECK (note IS NULL OR length(note) <= 1000),
  by_user_id TEXT,
  by_name TEXT,
  at INTEGER NOT NULL,
  UNIQUE (room_id, evidence_id)
) STRICT;
