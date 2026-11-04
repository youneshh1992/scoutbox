-- 02_recruitment.sql — ScoutBox target SQLite schema: the recruitment pipeline.
--
-- Scope: requests, trials (schedule / attendance / day / report), recruitment
-- cases with their Room facet, room comments / snapshots / decisions / evidence
-- state, contacts, offers, signing packages, completed signings, post-signing
-- follow-ups, and the ONE shared idempotency_keys table.
--
-- Executes after 01_identity.sql (orgs, org_users, guardians, players,
-- player_media). Tables that live in LATER files are referenced by comment only,
-- never by FOREIGN KEY:
--   03: channels, ledger           04: evidence, assessments, vacancies
--   05: ver_evidence               06: agent_transactions, representation_agreements
--   07: box_sessions
--
-- Cross-cutting decisions
-- * player_id columns in this file carry NO foreign key. server.mjs
--   deletePlayerData (3978-4023) hard-deletes the players row and leaves every
--   row below behind as a tombstone (subject_removed_at / nulled name) that must
--   KEEP the id. A FK with SET NULL would erase the id the tombstone is for.
-- * org_id -> orgs(id) ON DELETE RESTRICT: no org deletion route exists.
-- * org user ids -> org_users(id) ON DELETE RESTRICT: removed staff keep their
--   row (removedAt) so attribution survives.
-- * Actor tuples {kind, userId|id, name} become <x>_kind / <x>_id / <x>_name.
-- * Optimistic-concurrency tuples rev / revAt / revBy{userId,name}|null
--   (domains/platform/concurrency.mjs:84 bumpRev) become rev / rev_at / rev_by_user_id /
--   rev_by_name. A missing rev reads as 1 today; the migration writes 1.
-- * history[] arrays become <table>_history in the convention shape (by_kind /
--   by_id / by_name). A case's history has one entry shape, m12/shared.mjs
--   audit(): {id aud-*, at, byKind, byId, byName, action, detail}.
-- * Idempotency keys are columns of their owner, or rows of the owner's own key
--   table (trial_keys, offer_keys); idempotency_keys (below) holds only the
--   signing packages' keys.
-- * Code lists (reason codes, tags, mentions) are child rows in list order; a
--   room's reopen reason codes stay a JSON array (read whole).

-- =============================================================================
-- STATUS (3 November 2026 onwards, migration.md §4.3): every table of this file is typed and written by explicit
-- repository operations; no lossless side columns anywhere.
--   0015_recruitment (REGISTERED)                   — the sixteen request/trial definitions; Q7a tolerant, Q7c strict.
--   0016_recruitment_cases (REGISTERED)             — the twenty-five case/room definitions; Q8a tolerant.
--   0017_recruitment_contacts_offers (REGISTERED)   — the ten contact/offer definitions; Q8c-a tolerant, Q8c-b strict.
--   0018_signings_follow_ups (REGISTERED)           — the ten signing/follow-up definitions and idempotency_keys.
-- The case_id keys of requests, trials, contacts and offers are immediate (RESTRICT): a case is written before
-- anything names it. Two keys stay DEFERRABLE INITIALLY DEFERRED: recruitment_requests.trial_id (a snapshot writes a
-- request before its trial) and recruitment_contacts.request_id (a send writes its contact before its request).
-- scripts/testSchemaDdl.mjs checks this file against the migrations column for column and index for index.
-- =============================================================================
-- =============================================================================
-- idempotency_keys — LIVE since migration 0018_signings_follow_ups (S8d): the signing packages' keys
-- =============================================================================
-- One row per key act of a package: a list act -> one row per entry (shape 'list'), a value act -> one row
-- (shape 'value'); key/fp/at lifted when present, the entry verbatim in entry_json. The replay rule is the
-- routes': the same (owner, act, key) with the same fp replays, a different fp is a conflict. The other steps keep
-- their keys as columns (a draft's create key, a decision's finalize and draft keys, a handoff's invite key, a
-- request's invite key, a contact's keys) or in their own key tables (trial_keys, offer_keys).
CREATE TABLE idempotency_keys (
  owner_table                      TEXT NOT NULL CHECK (owner_table IN ('signing_packages')),
  owner_id                         TEXT NOT NULL,
  position                         INTEGER NOT NULL,
  act                              TEXT NOT NULL,
  shape                            TEXT NOT NULL CHECK (shape IN ('list', 'value')),
  key                              TEXT,
  fp                               TEXT,
  at                               INTEGER,
  entry_json                       TEXT NOT NULL CHECK (entry_json IS NULL OR json_valid(entry_json)),
  PRIMARY KEY (owner_table, owner_id, position)
) STRICT;
CREATE INDEX idempotency_keys_owner_act_key ON idempotency_keys (owner_table, owner_id, act, key);

-- =============================================================================
-- recruitment_cases and its fifteen owned child tables — LIVE since migration 0016_recruitment_cases (amended in
--   place at §4.3: typed and explicit; repositories/recruitmentCases.mjs, which generates this DDL)
-- =============================================================================
-- writers: m12/scouting.mjs (the M12 case, assignments, tasks, approvals, the sign-off decision, links),
--   domains/recruitment/rooms/rooms.mjs (the Room facet, its status through applyStatus, tasks, assignments, links, reopen),
--   domains/recruitment/lifecycle/decisionRoutes.mjs (the decision draft), m27/index.mjs (the transaction handoff), m13/planning.mjs (the
--   budget), the lifecycle writer's callers (m23, m28, m29) and the deletion unit (redactPlayer) — every one an
--   explicit cases.create / cases.update. db.recruitmentCases is a read-only view.
-- columns: every field is a typed column with its vocabulary CHECK (case stage, priority and decision outcome,
--   room status, priority and source context, task and approval states, linked resource types, decision
--   outcomes, evidence-reference kinds, currencies, budget line kinds and schedules, the stored handoff
--   statuses). A deadline or a due date is a day (<p>_day) or an instant (<p>_at), never both. The Room facet is
--   the room_* column group (null when the case has no Room). The draft, the handoff and the budget are child
--   rows. No lossless side columns: a record the columns cannot hold is refused with its id.
-- references: player_id NO key, tolerant and counted (Q8a); org_id -> orgs and the staff ids (owner, lead scout,
--   M12 decision maker, assignee) -> org_users (RESTRICT); case_request_links -> recruitment_requests and
--   case_trial_links -> trials (RESTRICT); every child cascades with its owner; vacancy_id, links_signing_id,
--   linked_resource_id, transaction_id and invited_agency_org_id are plain ids (later steps own their tables).
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

-- =============================================================================
-- recruitment_requests, request_trial_slots, trials and its thirteen owned child tables — LIVE since
--   migration 0015_recruitment (amended in place on 3 November 2026, migration.md §4.3: typed and explicit;
--   repositories/recruitment.mjs, which generates this DDL)
-- =============================================================================
-- writers: server.mjs issueRecruitmentRequest (requests.create; the Trial invitation's case link, recipient
--   and client key in the same create), the respond routes, the report route, the urgent-report freeze and
--   the deletion unit's tombstones (requests/trials.update), issueAcceptedTrial (trials.create),
--   domains/recruitment/lifecycle/trialRoutes.mjs, m12/journeys.mjs (the trial day) and m12/operations.mjs (reminder markers) — every
--   one an explicit repository operation inside the route's unit of work. db.requests and db.trials are
--   read-only views.
-- columns: every field is a typed column with its vocabulary CHECK (request type and status, the parties,
--   the trial status, workflow, completion, attendance, session, consent, staff-check and day-event
--   vocabularies of domains/recruitment/lifecycle/trial.mjs). No lossless side columns: a record the columns cannot hold is refused
--   with its id. Actors {kind:'org', userId, name} | {kind, id, name} are <x>_kind / <x>_user_id /
--   <x>_actor_id / <x>_name. A request's trialDetails is present exactly when its type is trial; its
--   invitation key is invite_key / invite_fp. A trial's client keys are rows of trial_keys; its reminder
--   markers rows of trial_reminders; a schedule revision's copy of its sessions rows of
--   trial_revision_sessions. Dropped as never read: trials.keys.accept and trials.blockedBy.
-- references: player_id tolerant, no key (Q7a); guardian_id and recipient_guardian_id checked in code at
--   every write, no key (Q7c); case_id (both tables) -> recruitment_cases RESTRICT (immediate: the case is
--   written first); recruitment_requests.trial_id -> trials DEFERRABLE INITIALLY DEFERRED (a snapshot
--   writes a request before its trial); trials.request_id -> recruitment_requests RESTRICT;
--   org_id -> orgs, user_id -> org_users (RESTRICT); every child table cascades with its owner.
-- notes: the drafted one-pending index stays withdrawn (D2); trials_one_open_per_case is kept.
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
  focus_note TEXT
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

-- =============================================================================
-- room_comments, room_snapshots, room_decisions, room_evidence_states and their children — LIVE since migration
--   0016_recruitment_cases (typed and explicit; repositories/recruitmentCases.mjs)
-- =============================================================================
-- writers: domains/recruitment/rooms/rooms.mjs (comments.create / update, snapshots.create, decisions.create / update for an advisory
--   recommendation and its supersession, evidenceStates.create / update) and domains/recruitment/lifecycle/decisionRoutes.mjs (the formal
--   decision, in one unit with the case move). db.roomComments, db.roomSnapshots, db.roomDecisions and
--   db.roomEvidenceState are read-only views.
-- columns: a decision's snapshot is the room_snapshots row it names (snapshot_id): only the id is stored and the
--   snapshot is read back with the decision. Its finalize and draft keys are columns. An advisory recommendation
--   has no kind, state or outcome (null). One evidence state per (room, evidence).
-- references: room_id -> recruitment_cases (RESTRICT); org_id -> orgs and room_comments.author_user_id -> org_users
--   (RESTRICT); snapshot_id -> room_snapshots (RESTRICT); player_id NO key, tolerant and counted (Q8a). The
--   decision chain (supersedes_id, superseded_by_id) and a decision's snapshot stay inside the decision's room,
--   checked at every write (DECISION_CHAIN_BROKEN).
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
  snapshot_id TEXT REFERENCES room_snapshots(id) ON DELETE RESTRICT,
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

-- =============================================================================
-- recruitment_contacts, recruitment_offers and their children (S8c)
-- =============================================================================
-- LIVE since migration 0017_recruitment_contacts_offers (amended in place on 3 November 2026, migration.md §4.3):
-- repositories/recruitmentContactsOffers.mjs. Typed columns only, with the vocabulary and length CHECKs of
-- domains/recruitment/lifecycle/contact.mjs and domains/recruitment/offers/offer.mjs; no absent_keys_json, offtype_json, extra_json or raw_json. Written by explicit
-- repository operations (contacts.create / update / redactPlayer, offers.create / update / redactPlayer).
-- The idempotency keys are columns of their owner (create/send/record on a contact, create on an offer) and the rows
-- of offer_keys (an offer's issue, withdraw and revise lists); neither uses idempotency_keys.
-- case_id -> recruitment_cases is RESTRICT (immediate: the case is written first); a contact's request_id is
-- DEFERRABLE INITIALLY DEFERRED (NO ACTION, checked at COMMIT: a send writes its contact before the request). Player ids: no key, tolerant and
-- counted (Q8c-a). Guardian ids: no key; a snapshot write naming a missing guardian is refused (Q8c-b). Every offer
-- pointer (current revision, response, supersedes, superseded by, discarded by; a response's, a receipt's and a key's
-- revision) names a row of the same offer, checked by the repository's typer. contact_history and offer_history are
-- RESTRICT (removed explicitly before their owner); the other children cascade.
-- source: db.recruitmentContacts (domains/recruitment/lifecycle/contactRoutes.mjs), db.recruitmentOffers (domains/recruitment/offers/index.mjs).
CREATE TABLE recruitment_contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('draft','delivered','failed','responded','recorded','cancelled')),
  channel TEXT NOT NULL CHECK (channel IS NULL OR channel IN ('in_app','phone','in_person','email_external','agent','other')),
  contact_mode TEXT NOT NULL CHECK (contact_mode IS NULL OR contact_mode IN ('player_only','both')),
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  routing_at INTEGER,
  routing_mode TEXT CHECK (routing_mode IS NULL OR routing_mode IN ('player_only','both')),
  routing_player INTEGER CHECK (routing_player IS NULL OR routing_player IN (0,1)),
  routing_guardian INTEGER CHECK (routing_guardian IS NULL OR routing_guardian IN (0,1)),
  routing_agent_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  routing_agent_agreement_id TEXT,
  routing_honest TEXT,
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 120),
  body TEXT CHECK (body IS NULL OR length(body) <= 2000),
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  sent_by_name TEXT,
  sent_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  failure_code TEXT,
  request_id TEXT REFERENCES recruitment_requests(id) DEFERRABLE INITIALLY DEFERRED,
  email_copy_state TEXT CHECK (email_copy_state IS NULL OR email_copy_state IN ('queued','not_available','local_outbox','accepted_by_provider','failed')),
  email_copy_to TEXT CHECK (email_copy_to IS NULL OR email_copy_to IN ('guardian')),
  email_copy_outbox_id TEXT,
  email_copy_at INTEGER,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  occurred_at INTEGER,
  recorded_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  recorded_by_name TEXT,
  recorded_at INTEGER,
  responded_at INTEGER,
  response_kind TEXT CHECK (response_kind IS NULL OR response_kind IN ('accepted','declined')),
  response_message TEXT CHECK (response_message IS NULL OR length(response_message) <= 500),
  response_by TEXT CHECK (response_by IS NULL OR response_by IN ('player','guardian')),
  response_at INTEGER,
  cancelled_at INTEGER,
  cancelled_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  cancelled_by_name TEXT,
  create_key TEXT,
  create_fp TEXT,
  send_key TEXT,
  send_fp TEXT,
  record_key TEXT,
  record_fp TEXT,
  rev INTEGER NOT NULL CHECK (rev >= 0),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  policy_version INTEGER NOT NULL,
  CHECK ((recipient_type IS NULL) = (recipient_minor IS NULL)),
  CHECK ((routing_at IS NULL) = (routing_mode IS NULL)),
  CHECK ((email_copy_state IS NULL) = (email_copy_to IS NULL)),
  CHECK ((response_kind IS NULL) = (response_by IS NULL)),
  CHECK (send_key IS NULL OR send_fp IS NOT NULL)
) STRICT;
CREATE INDEX recruitment_contacts_case_org ON recruitment_contacts (case_id, org_id);
CREATE INDEX recruitment_contacts_org_player ON recruitment_contacts (org_id, player_id);
CREATE INDEX recruitment_contacts_request ON recruitment_contacts (request_id);
CREATE INDEX recruitment_contacts_routing_agent ON recruitment_contacts (routing_agent_user_id);
CREATE INDEX recruitment_contacts_player ON recruitment_contacts (player_id);
CREATE TABLE contact_attempts (
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IS NULL OR ok IN (0,1)),
  code TEXT,
  PRIMARY KEY (contact_id, position)
) STRICT;
CREATE TABLE contact_history (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES recruitment_contacts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian')),
  by_user_id TEXT,
  by_name TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_type(detail_json) = 'object'),
  UNIQUE (contact_id, position)
) STRICT;
CREATE INDEX contact_history_contact_at ON contact_history (contact_id, at);
CREATE TABLE recruitment_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IS NULL OR type IN ('direct_recruitment')),
  decision_id TEXT,
  transaction_id TEXT,
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('DRAFT','ISSUED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED','SUPERSEDED')),
  current_revision_id TEXT NOT NULL,
  agent_share_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  agent_share_agreement_id TEXT,
  agent_share_at INTEGER,
  agent_share_by_kind TEXT CHECK (agent_share_by_kind IS NULL OR agent_share_by_kind IN ('player')),
  agent_share_by_id TEXT,
  create_key TEXT,
  create_fp TEXT,
  lifecycle_applied INTEGER CHECK (lifecycle_applied IS NULL OR lifecycle_applied IN (0,1)),
  lifecycle_action TEXT,
  lifecycle_reason TEXT,
  lifecycle_message TEXT,
  lifecycle_allowed_json TEXT CHECK (lifecycle_allowed_json IS NULL OR json_type(lifecycle_allowed_json) = 'array'),
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,
  created_by_role TEXT,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  policy_version INTEGER NOT NULL,
  subject_removed_at INTEGER,
  CHECK ((agent_share_user_id IS NULL) = (agent_share_at IS NULL)),
  CHECK ((create_key IS NULL) = (create_fp IS NULL))
) STRICT;
CREATE INDEX recruitment_offers_case_org ON recruitment_offers (case_id, org_id);
CREATE INDEX recruitment_offers_org_player ON recruitment_offers (org_id, player_id);
CREATE INDEX recruitment_offers_agent_share ON recruitment_offers (agent_share_user_id);
CREATE INDEX recruitment_offers_decision ON recruitment_offers (decision_id);
CREATE INDEX recruitment_offers_player ON recruitment_offers (player_id);
CREATE TABLE offer_revisions (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  status TEXT NOT NULL CHECK (status IS NULL OR status IN ('DRAFT','ISSUED','ACCEPTED','DECLINED','WITHDRAWN','EXPIRED','SUPERSEDED')),
  term_offer_type TEXT NOT NULL CHECK (term_offer_type IS NULL OR term_offer_type IN ('direct_recruitment')),
  term_role TEXT CHECK (term_role IS NULL OR length(term_role) <= 80),
  term_squad TEXT CHECK (term_squad IS NULL OR length(term_squad) <= 80),
  term_start_date TEXT CHECK (term_start_date IS NULL OR length(term_start_date) = 10),
  term_end_date TEXT CHECK (term_end_date IS NULL OR length(term_end_date) = 10),
  term_conditions TEXT CHECK (term_conditions IS NULL OR length(term_conditions) <= 1000),
  recipient_message TEXT CHECK (recipient_message IS NULL OR length(recipient_message) <= 2000),
  internal_note TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name TEXT,
  created_by_role TEXT,
  updated_at INTEGER NOT NULL,
  updated_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  updated_by_name TEXT,
  updated_by_role TEXT,
  issued_at INTEGER,
  issued_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  issued_by_name TEXT,
  issued_by_role TEXT,
  withdrawn_at INTEGER,
  withdrawn_by_user_id TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  withdrawn_by_name TEXT,
  withdrawn_by_role TEXT,
  withdraw_reason TEXT CHECK (withdraw_reason IS NULL OR length(withdraw_reason) <= 400),
  responded_at INTEGER,
  response_id TEXT,
  supersedes_revision_id TEXT,
  superseded_by_revision_id TEXT,
  superseded_at INTEGER,
  recipient_type TEXT CHECK (recipient_type IS NULL OR recipient_type IN ('player','guardian')),
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER CHECK (recipient_minor IS NULL OR recipient_minor IN (0,1)),
  recipient_at INTEGER,
  readiness_transaction_id TEXT,
  readiness_evaluated_at INTEGER,
  readiness_status TEXT,
  readiness_blockers_json TEXT CHECK (readiness_blockers_json IS NULL OR json_type(readiness_blockers_json) = 'array'),
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  rev_by_user_id TEXT,
  rev_by_name TEXT,
  discarded_by_response_id TEXT,
  CHECK ((recipient_type IS NULL) = (recipient_at IS NULL)),
  UNIQUE (offer_id, revision_number),
  UNIQUE (offer_id, position)
) STRICT;
CREATE INDEX offer_revisions_offer_status ON offer_revisions (offer_id, status);
CREATE TABLE offer_revision_documents (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES offer_revisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  evidence_id TEXT NOT NULL,
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  mime TEXT,
  bytes INTEGER,
  UNIQUE (revision_id, position)
) STRICT;
CREATE TABLE offer_responses (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type IS NULL OR response_type IN ('accepted','declined')),
  actor_type TEXT NOT NULL CHECK (actor_type IS NULL OR actor_type IN ('player','guardian')),
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  for_player_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 400),
  client_key TEXT,
  UNIQUE (offer_id, revision_id),
  UNIQUE (offer_id, position)
) STRICT;
CREATE UNIQUE INDEX offer_responses_offer_client_key ON offer_responses (offer_id, client_key) WHERE client_key IS NOT NULL;
CREATE TABLE offer_read_receipts (
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IS NULL OR viewer_kind IN ('player','guardian')),
  viewer_id TEXT NOT NULL,
  first_viewed_at INTEGER NOT NULL,
  PRIMARY KEY (offer_id, position),
  UNIQUE (offer_id, revision_id, viewer_kind, viewer_id)
) STRICT;
CREATE TABLE offer_history (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  by_kind TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  by_id TEXT,
  by_name TEXT,
  detail_json TEXT CHECK (detail_json IS NULL OR json_type(detail_json) = 'object'),
  UNIQUE (offer_id, position)
) STRICT;
CREATE INDEX offer_history_offer_at ON offer_history (offer_id, at);
CREATE TABLE offer_keys (
  offer_id TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE CASCADE,
  act TEXT NOT NULL CHECK (act IS NULL OR act IN ('issue','withdraw','revise')),
  position INTEGER NOT NULL,
  key TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  PRIMARY KEY (offer_id, act, position)
) STRICT;
CREATE INDEX offer_keys_key ON offer_keys (offer_id, act, key);

-- =============================================================================
-- signing_packages  (M23 P7 signing workflow over an ACCEPTED Offer revision)
-- =============================================================================
-- =============================================================================
-- S8d — IMPLEMENTED by migration 0018_signings_follow_ups (repositories/signingsFollowUps.mjs; design note
-- docs/architecture/s8d-design-note.md). The ten definitions below are the ones the migration creates, verbatim
-- (scripts/testSchemaDdl.mjs compares them column for column). DRAFT VERSUS IMPLEMENTED, under the fidelity rule of
-- 30 October (CLAUDE.md "Facts about the data"): typed columns only, no raw_json / extra_json; vocabulary and length
-- CHECKs are real; the route rejects what a column cannot hold. Actor tuples keep their kind (created_by_kind,
-- cancelled_by_kind, voided_by_kind ... with the user id or the id, the name and the role). Child lists carry a
-- `position`. The package <-> signing cycle: signing_packages.completion_signing_id -> signings(id) is DEFERRABLE
-- INITIALLY DEFERRED (NO ACTION; a RESTRICT would fire at once) so one unit of work records the signing and completes
-- the package, and a snapshot removes the pair in one save; signings.signing_package_id -> signing_packages(id) is
-- immediate. player_id columns: no key, tolerant and counted (Q7a/Q8a/Q8c-a).
-- offer_revision_id stays a plain indexed column checked in code (offer_revisions.id is the primary key since
-- S8c's §4.3 rewrite; a real key is a later change), as does rev_by_user_id. signings: rows without a
-- method import as LEGACY_RECORDED; firstQualifyingInteraction keeps {id, ts, type}; the dead cancelledAt /
-- revokedAt / voidedAt fields are dropped and reported by the migration. idempotency_keys' owner CHECK gains
-- 'signing_packages'.
-- =============================================================================
-- source: db.signingPackages  created at domains/recruitment/signings/index.mjs:404 (store guaranteed by migration m280_001, schema 2308)
-- owner/writer: domains/recruitment/signings/index.mjs (start, PATCH draft, document, ready, party completion, executed document, complete,
--         cancel, void, supersede, T&S void, onPlayerDeleted)
--         lifecycle: stored status DRAFT|READY|IN_PROGRESS|COMPLETED|CANCELLED|VOIDED; EXPIRED is derived from
--         expires_at on live rows (never stored); SUPERSEDED is a REVISION status only; never deleted
-- mapping:
--   id -> id (spk-<n>)   orgId -> org_id   caseId -> case_id   playerId -> player_id   offerId -> offer_id
--   offerRevisionId -> offer_revision_id (the ACCEPTED revision)   transactionId -> transaction_id (agent_transactions(id), file 06, no FK)
--   status -> status   currentRevisionId -> current_revision_id   revisions[] -> signing_revisions
--   expiresAt -> expires_at   internalNote -> internal_note (<= 2000, club-private)
--   keys {start, ready[], party[], cancel[], void[], supersede[], complete[]} -> idempotency_keys
--   history[] -> signing_history
--   completion {signingId, completedAt, completedBy{kind,id,name,role}, contract{startDate,endDate}, documentSha256,
--            lifecycle{from,to,at}}|null -> completion_signing_id, completion_completed_at, completion_by_user_id,
--            completion_by_name, completion_by_role, completion_contract_start_date, completion_contract_end_date,
--            completion_document_sha256, completion_lifecycle_from, completion_lifecycle_to, completion_lifecycle_at
--   cancelledAt / cancelledBy / cancelReason -> cancelled_at, cancelled_by_user_id, cancelled_by_name, cancel_reason (<= 500)
--   voidedAt / voidedBy {kind org|admin, id, name} / voidReason -> voided_at, voided_by_kind, voided_by_id, voided_by_name, void_reason
--   createdAt -> created_at   createdBy -> created_by_user_id, created_by_name, created_by_role   updatedAt -> updated_at
--   rev/revAt/revBy -> rev, rev_at, rev_by_user_id, rev_by_name   policyVersion -> policy_version   subjectRemovedAt -> subject_removed_at
-- notes: one COMPLETED package per offer is a partial unique index (NEW). One LIVE package per offer stays a
--   rule of the code (canStart): EXPIRED is derived from expires_at and never stored, so an expired READY package
--   and the next package of the offer share it — no index can state that (S8d). Reads: by (case_id, org_id), by (offer_id, org_id), by player_id
--   for the recipient (only revisions with ready_at).
CREATE TABLE signing_packages (
  id                               TEXT PRIMARY KEY,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  case_id                          TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  offer_id                         TEXT NOT NULL REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT NOT NULL,
  transaction_id                   TEXT,
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED')),
  current_revision_id              TEXT NOT NULL,
  expires_at                       INTEGER,
  internal_note                    TEXT CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  completion_signing_id            TEXT REFERENCES signings(id) DEFERRABLE INITIALLY DEFERRED,
  completion_completed_at          INTEGER,
  completion_by_kind               TEXT CHECK (completion_by_kind IS NULL OR completion_by_kind IN ('org','player','guardian','admin','system')),
  completion_by_user_id            TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completion_by_name               TEXT,
  completion_by_role               TEXT,
  completion_contract_start_date   TEXT CHECK (completion_contract_start_date IS NULL OR length(completion_contract_start_date) = 10),
  completion_contract_end_date     TEXT CHECK (completion_contract_end_date IS NULL OR length(completion_contract_end_date) = 10),
  completion_document_sha256       TEXT CHECK (completion_document_sha256 IS NULL OR length(completion_document_sha256) = 64),
  completion_lifecycle_from        TEXT,
  completion_lifecycle_to          TEXT,
  completion_lifecycle_at          INTEGER,
  cancelled_at                     INTEGER,
  cancelled_by_kind                TEXT CHECK (cancelled_by_kind IS NULL OR cancelled_by_kind IN ('org','player','guardian','admin','system')),
  cancelled_by_user_id             TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  cancelled_by_name                TEXT,
  cancelled_by_role                TEXT,
  cancel_reason                    TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 500),
  voided_at                        INTEGER,
  voided_by_kind                   TEXT CHECK (voided_by_kind IS NULL OR voided_by_kind IN ('org','player','guardian','admin','system')),
  voided_by_id                     TEXT,
  voided_by_name                   TEXT,
  voided_by_role                   TEXT,
  void_reason                      TEXT CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  created_at                       INTEGER NOT NULL,
  created_by_kind                  TEXT CHECK (created_by_kind IS NULL OR created_by_kind IN ('org','player','guardian','admin','system')),
  created_by_user_id               TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name                  TEXT,
  created_by_role                  TEXT,
  updated_at                       INTEGER NOT NULL,
  rev                              INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  rev_at                           INTEGER,
  rev_by_user_id                   TEXT,
  rev_by_name                      TEXT,
  policy_version                   INTEGER NOT NULL DEFAULT 1,
  subject_removed_at               INTEGER,
  CHECK ((status = 'COMPLETED') = (completion_signing_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by_kind IS NULL))
) STRICT;
CREATE INDEX signing_packages_case_org_created ON signing_packages (case_id, org_id, created_at);
CREATE INDEX signing_packages_offer_org ON signing_packages (offer_id, org_id);
CREATE INDEX signing_packages_player_updated ON signing_packages (player_id, updated_at);
CREATE INDEX signing_packages_offer_revision ON signing_packages (offer_revision_id);
CREATE INDEX signing_packages_org_player ON signing_packages (org_id, player_id);
CREATE UNIQUE INDEX signing_packages_one_completed_per_offer ON signing_packages (offer_id) WHERE status = 'COMPLETED';

-- source: db.signingPackages[].revisions[]  created at domains/recruitment/signings/index.mjs:397 (revision 1) and :701 (supersede)
-- owner/writer: domains/recruitment/signings/index.mjs   lifecycle: DRAFT -> READY -> IN_PROGRESS -> COMPLETED | CANCELLED | VOIDED | SUPERSEDED; never deleted
-- mapping: id -> id (spr-<n>)   revisionNumber -> revision_number   status -> status
--   createdAt -> created_at   createdBy -> created_by_user_id, created_by_name, created_by_role
--   readyAt -> ready_at   readyBy -> ready_by_user_id, ready_by_name, ready_by_role
--   completedAt -> completed_at   completedBy -> completed_by_user_id, completed_by_name, completed_by_role   supersededAt -> superseded_at
--   document -> signing_documents (kind 'signing')   executedDocument -> signing_documents (kind 'executed')
--   contract {startDate, endDate} -> contract_start_date, contract_end_date
--   requiredParties[] -> signing_revision_parties
--   policySnapshot {policyVersion, jurisdiction, offerPolicyVersion} -> policy_version, policy_jurisdiction, policy_offer_policy_version
--   supersedesRevisionId -> supersedes_revision_id   supersededByRevisionId -> superseded_by_revision_id
-- notes: UNIQUE (package_id, revision_number); a presented revision (READY+) must have a document (integrity, not CHECK).
CREATE TABLE signing_revisions (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  revision_number                  INTEGER NOT NULL CHECK (revision_number >= 1),
  status                           TEXT NOT NULL CHECK (status IN ('DRAFT','READY','IN_PROGRESS','COMPLETED','CANCELLED','VOIDED','SUPERSEDED')),
  created_at                       INTEGER NOT NULL,
  created_by_kind                  TEXT CHECK (created_by_kind IS NULL OR created_by_kind IN ('org','player','guardian','admin','system')),
  created_by_user_id               TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  created_by_name                  TEXT,
  created_by_role                  TEXT,
  ready_at                         INTEGER,
  ready_by_kind                    TEXT CHECK (ready_by_kind IS NULL OR ready_by_kind IN ('org','player','guardian','admin','system')),
  ready_by_user_id                 TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  ready_by_name                    TEXT,
  ready_by_role                    TEXT,
  completed_at                     INTEGER,
  completed_by_kind                TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('org','player','guardian','admin','system')),
  completed_by_user_id             TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  completed_by_name                TEXT,
  completed_by_role                TEXT,
  superseded_at                    INTEGER,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  policy_jurisdiction              TEXT,
  policy_offer_policy_version      INTEGER,
  supersedes_revision_id           TEXT,
  superseded_by_revision_id        TEXT,
  UNIQUE (package_id, revision_number),
  UNIQUE (package_id, position)
) STRICT;

-- source: db.signingPackages[].revisions[].document and .executedDocument  created at domains/recruitment/signings/index.mjs:181 (storeDocument)
-- owner/writer: domains/recruitment/signings/index.mjs (attach on DRAFT — re-attaching REPLACES the object; executed document on READY/IN_PROGRESS)
--         lifecycle: one 'signing' and one 'executed' per revision; the vault row (ver_evidence) is never removed
-- mapping: id -> id (sgd-<n> | sgx-<n>)   kind (which field) -> kind   evidenceId -> evidence_id (ver_evidence(id), file 05, no FK)
--   sha256 -> sha256 (the digest every party confirms)   filename -> filename   mime -> mime   bytes -> bytes   label -> label (<= 120)
--   uploadedAt -> uploaded_at   uploadedBy {kind,id,name,role} -> uploaded_by_user_id, uploaded_by_name, uploaded_by_role
-- notes: documentBytesProblem re-hashes the vault bytes against sha256 before present/confirm/complete/serve.
CREATE TABLE signing_documents (
  id                               TEXT PRIMARY KEY,
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  kind                             TEXT NOT NULL CHECK (kind IN ('signing','executed')),
  evidence_id                      TEXT NOT NULL,
  sha256                           TEXT NOT NULL CHECK (length(sha256) = 64),
  filename                         TEXT,
  mime                             TEXT,
  bytes                            INTEGER,
  label                            TEXT CHECK (label IS NULL OR length(label) <= 120),
  uploaded_at                      INTEGER NOT NULL,
  uploaded_by_kind                 TEXT CHECK (uploaded_by_kind IS NULL OR uploaded_by_kind IN ('org','player','guardian','admin','system')),
  uploaded_by_user_id              TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  uploaded_by_name                 TEXT,
  uploaded_by_role                 TEXT,
  UNIQUE (revision_id, kind)
) STRICT;

-- source: db.signingPackages[].revisions[].requiredParties[]  created at domains/recruitment/signings/signing.mjs:113 (requiredPartiesFor), completed at domains/recruitment/signings/index.mjs:537
-- owner/writer: domains/recruitment/signings/index.mjs completeParty   lifecycle: PENDING -> COMPLETED; a superseded revision keeps its parties as evidence
-- mapping: partyType -> party_type   forEntityId -> for_entity_id (players(id) | guardians(id) | orgs(id) by party_type; polymorphic, no FK)
--   forPlayerId -> for_player_id   status -> status   completedAt -> completed_at
--   completedBy {kind,id,name} -> completed_by_kind, completed_by_id, completed_by_name (name NULL after subject removal for player rows)
--   method -> method   evidenceRef {kind, id sgev-*, revisionId, documentSha256, at, actorKind, actorId, session} ->
--            evidence_ref_kind, evidence_ref_id, evidence_document_sha256, evidence_at, evidence_actor_kind, evidence_actor_id,
--            evidence_session (evidenceRef.revisionId == revision_id: derived, integrity-checked, not stored)
-- notes: exactly one recipient party (PLAYER xor GUARDIAN) and one CLUB_SIGNATORY per revision — PRIMARY KEY (revision_id, party_type)
--   covers duplicates; the xor is an integrity rule. Only PLATFORM_ACKNOWLEDGMENT is written by this build.
CREATE TABLE signing_revision_parties (
  revision_id                      TEXT NOT NULL REFERENCES signing_revisions(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  for_entity_id                    TEXT,
  for_player_id                    TEXT,
  status                           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
  completed_at                     INTEGER,
  completed_by_kind                TEXT CHECK (completed_by_kind IS NULL OR completed_by_kind IN ('org','player','guardian','admin','system')),
  completed_by_id                  TEXT,
  completed_by_name                TEXT,
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  evidence_ref_kind                TEXT CHECK (evidence_ref_kind IS NULL OR evidence_ref_kind IN ('platform_acknowledgment')),
  evidence_ref_id                  TEXT,
  evidence_revision_id             TEXT,
  evidence_document_sha256         TEXT CHECK (evidence_document_sha256 IS NULL OR length(evidence_document_sha256) = 64),
  evidence_at                      INTEGER,
  evidence_actor_kind              TEXT,
  evidence_actor_id                TEXT,
  evidence_session                 TEXT,
  PRIMARY KEY (revision_id, party_type),
  UNIQUE (revision_id, position),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
) STRICT;
CREATE INDEX signing_revision_parties_entity ON signing_revision_parties (party_type, for_entity_id);

-- source: db.signingPackages[].history[]  created at domains/recruitment/signings/index.mjs:76 hist()
-- owner/writer: domains/recruitment/signings/index.mjs   lifecycle: append-only; recipient view filters /draft|note|internal/ and hides org names;
--         subject removal nulls by.name on player entries
-- mapping: id -> id (aud-<n>)   at -> at   by {kind,id,name} -> by_kind, by_id, by_name   action -> action   detail -> detail_json
CREATE TABLE signing_history (
  id                               TEXT PRIMARY KEY,
  package_id                       TEXT NOT NULL REFERENCES signing_packages(id) ON DELETE RESTRICT,
  position                         INTEGER NOT NULL,
  at                               INTEGER NOT NULL,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  by_id                            TEXT,
  by_name                          TEXT,
  action                           TEXT NOT NULL,
  detail_json                      TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  UNIQUE (package_id, position)
) STRICT;
CREATE INDEX signing_history_package_at ON signing_history (package_id, at);

-- =============================================================================
-- signings  (the completed signing record: canonical completion or legacy recording)
-- =============================================================================
-- source: db.signings  created ONLY at domains/recruitment/signings/index.mjs:273 (recordCompletedSigning; shapes from domains/recruitment/signings/signing.mjs:471
--         completedSigningRecord and the legacy literal at domains/recruitment/signings/index.mjs:268); rows older than M29 carry the legacy
--         shape without method/contract/package fields
-- owner/writer: domains/recruitment/signings/index.mjs recordCompletedSigning (also appends the ledger row, issues the invoice through the
--         billing adapter, sets players.level/contractStatus/availability/timeline and orgs.squad)
--         lifecycle: immutable; never deleted; kept whole on subject removal INCLUDING player_name (known gap)
-- mapping: id -> id (sign-<n>)   playerId -> player_id   playerName -> player_name (snapshot, retained after deletion)
--   orgId -> org_id   orgName -> org_name (snapshot)   userId -> user_id   scoutName -> scout_name (snapshot)
--   ts -> ts (ledger instant for legacy rows; = signedAt)   signedAt -> signed_at
--   firstQualifyingInteraction (a COPY of the first ledger row {id, ts, type, ...}) -> first_qualifying_ledger_id (ledger(id), file 03,
--            no FK), first_qualifying_at, first_qualifying_type; its orgName/userId/scoutName copies are derived via the ledger row
--   attributionWindowMonths -> attribution_window_months   insideAttributionWindow -> inside_attribution_window
--   method -> method (rows without one migrate as LEGACY_RECORDED)   note (legacy, <= 400) -> note
--   signingPackageId -> signing_package_id   signingRevisionId -> signing_revision_id   signingRevisionNumber -> signing_revision_number
--   caseId -> case_id   offerId -> offer_id   offerRevisionId -> offer_revision_id   transactionId -> transaction_id (file 06, no FK)
--   documentSha256 -> document_sha256   documentEvidenceId -> document_evidence_id   executedDocumentEvidenceId -> executed_document_evidence_id (ver_evidence(id), file 05, no FK)
--   contract {startDate, endDate} -> contract_start_date, contract_end_date   parties[] -> signing_parties   policyVersion -> policy_version
--   cancelledAt / revokedAt / voidedAt -> dead fields, not migrated (read at server.mjs:2612, never written anywhere)
-- notes: three uniqueness rules the code keeps: one row per package, one per offer (P7.1 §20), one STANDING legacy
--   row per (org, player) (server.mjs:2612) — all three as partial unique indexes (enforced by code today).
--   invoices.signing_id (another file) is unique per signing. Reads: by org (list), by player (follow-ups),
--   by signing_package_id / offer_id (consistency), by (org_id, player_id) legacy lookups.
CREATE TABLE signings (
  id                               TEXT PRIMARY KEY,
  player_id                        TEXT NOT NULL,
  player_name                      TEXT,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                         TEXT,
  user_id                          TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name                       TEXT,
  ts                               INTEGER NOT NULL,
  signed_at                        INTEGER,
  first_qualifying_ledger_id       TEXT,
  first_qualifying_at              INTEGER,
  first_qualifying_type            TEXT,
  attribution_window_months        INTEGER,
  inside_attribution_window        INTEGER NOT NULL DEFAULT 0 CHECK (inside_attribution_window IN (0,1)),
  method                           TEXT NOT NULL DEFAULT 'LEGACY_RECORDED' CHECK (method IN ('CANONICAL_COMPLETION','LEGACY_RECORDED')),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 400),
  signing_package_id               TEXT REFERENCES signing_packages(id) ON DELETE RESTRICT,
  signing_revision_id              TEXT REFERENCES signing_revisions(id) ON DELETE RESTRICT,
  signing_revision_number          INTEGER,
  case_id                          TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  offer_id                         TEXT REFERENCES recruitment_offers(id) ON DELETE RESTRICT,
  offer_revision_id                TEXT,
  transaction_id                   TEXT,
  document_sha256                  TEXT CHECK (document_sha256 IS NULL OR length(document_sha256) = 64),
  document_evidence_id             TEXT,
  executed_document_evidence_id    TEXT,
  contract_start_date              TEXT CHECK (contract_start_date IS NULL OR length(contract_start_date) = 10),
  contract_end_date                TEXT CHECK (contract_end_date IS NULL OR length(contract_end_date) = 10),
  policy_version                   INTEGER,
  CHECK ((method = 'CANONICAL_COMPLETION') = (signing_package_id IS NOT NULL))
) STRICT;
CREATE INDEX signings_org_ts ON signings (org_id, ts);
CREATE INDEX signings_player ON signings (player_id);
CREATE INDEX signings_org_player ON signings (org_id, player_id);
CREATE UNIQUE INDEX signings_one_per_package ON signings (signing_package_id) WHERE signing_package_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_per_offer ON signings (offer_id) WHERE offer_id IS NOT NULL;
CREATE UNIQUE INDEX signings_one_legacy_per_org_player ON signings (org_id, player_id) WHERE signing_package_id IS NULL;

-- source: db.signings[].parties[]  created at domains/recruitment/signings/signing.mjs:482 (completedSigningRecord)
-- owner/writer: domains/recruitment/signings/index.mjs recordCompletedSigning   lifecycle: immutable; canonical rows only
-- mapping: partyType -> party_type   method -> method   completedAt -> completed_at   byKind -> by_kind
-- notes: a provenance SUMMARY of signing_revision_parties at completion; never a name.
CREATE TABLE signing_parties (
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  party_type                       TEXT NOT NULL CHECK (party_type IN ('PLAYER','GUARDIAN','CLUB_SIGNATORY')),
  method                           TEXT CHECK (method IS NULL OR method IN ('PLATFORM_ACKNOWLEDGMENT','UPLOAD_EXECUTED_DOCUMENT')),
  completed_at                     INTEGER,
  by_kind                          TEXT CHECK (by_kind IS NULL OR by_kind IN ('org','player','guardian','admin','system')),
  PRIMARY KEY (signing_id, party_type),
  UNIQUE (signing_id, position)
) STRICT;

-- =============================================================================
-- Post-signing outcomes (M12 F11)
-- =============================================================================
-- source: db.followUps  created at m12/operations.mjs:33 (scheduleFollowUps, run by the sweep for EVERY signing)
-- owner/writer: m12/operations.mjs (sweep: scheduled -> due, notifiedAt; report route: -> complete; admin dueAt edit)
--         lifecycle: scheduled -> due -> complete; never deleted; kept after player deletion ('departed player')
-- mapping: id -> id (fup-<n>)   signingId -> signing_id   playerId -> player_id   orgId -> org_id   milestone -> milestone
--   dueAt -> due_at (signedAt + 91/182/365 d; admin may move it)   status -> status   notifiedAt -> notified_at   createdAt -> created_at
-- notes: UNIQUE (signing_id, milestone) enforced by code (idempotent scheduling). Reads: by org (sorted due_at),
--   by player (own list), by guardian child ids, sweep scan on (status, due_at).
CREATE TABLE follow_ups (
  id                               TEXT PRIMARY KEY,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  milestone                        TEXT NOT NULL CHECK (milestone IN ('3m','6m','12m')),
  due_at                           INTEGER NOT NULL,
  status                           TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','due','complete')),
  notified_at                      INTEGER,
  created_at                       INTEGER NOT NULL,
  UNIQUE (signing_id, milestone)
) STRICT;
CREATE INDEX follow_ups_org_due ON follow_ups (org_id, due_at);
CREATE INDEX follow_ups_player ON follow_ups (player_id);
CREATE INDEX follow_ups_status_due ON follow_ups (status, due_at);

-- source: db.outcomeReports  created at m12/operations.mjs:69
-- owner/writer: m12/operations.mjs (org files once; player/guardian confirm or dispute)
--         lifecycle: reported -> confirmed | disputed (set by the latest confirmation); never deleted
-- mapping: id -> id (out-<n>)   followUpId -> follow_up_id (UNIQUE)   signingId -> signing_id   playerId -> player_id   orgId -> org_id
--   by {kind:'org', id, name} -> by_user_id, by_name   registrationStatus -> registration_status
--   matchesPlayed -> matches_played (NULL = not evidenced)   progression -> progression (<= 200)   endReason -> end_reason (<= 200)
--   note -> note (<= 300)   status -> status   confirmations[] -> outcome_report_confirmations   at -> at
-- notes: outcomeState (unknown_pending/not_due/disputed/confirmed/reported) is derived in followUpView, not stored.
--   Admin aggregates suppress orgs with < 3 signings.
CREATE TABLE outcome_reports (
  id                               TEXT PRIMARY KEY,
  follow_up_id                     TEXT NOT NULL UNIQUE REFERENCES follow_ups(id) ON DELETE RESTRICT,
  signing_id                       TEXT NOT NULL REFERENCES signings(id) ON DELETE RESTRICT,
  player_id                        TEXT NOT NULL,
  org_id                           TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  by_user_id                       TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  by_name                          TEXT,
  registration_status              TEXT NOT NULL CHECK (registration_status IN ('registered','released','left','unknown')),
  matches_played                   INTEGER CHECK (matches_played IS NULL OR matches_played >= 0),
  progression                      TEXT CHECK (progression IS NULL OR length(progression) <= 200),
  end_reason                       TEXT CHECK (end_reason IS NULL OR length(end_reason) <= 200),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  status                           TEXT NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','confirmed','disputed')),
  at                               INTEGER NOT NULL
) STRICT;
CREATE INDEX outcome_reports_org ON outcome_reports (org_id);
CREATE INDEX outcome_reports_player ON outcome_reports (player_id);

-- source: db.outcomeReports[].confirmations[]  created at m12/operations.mjs:97
-- owner/writer: m12/operations.mjs respondOutcome   lifecycle: append-only; one per actor id per report
-- mapping: by {kind, id, name} -> by_kind, by_id (players(id) | guardians(id) by by_kind; no FK), by_name (snapshot)
--   agree -> agree   note -> note (<= 300)   experienceRating -> experience_rating (1-5 | NULL)   at -> at
-- notes: PRIMARY KEY (report_id, by_id) is what ALREADY_RESPONDED enforces.
CREATE TABLE outcome_report_confirmations (
  report_id                        TEXT NOT NULL REFERENCES outcome_reports(id) ON DELETE CASCADE,
  position                         INTEGER NOT NULL,
  by_kind                          TEXT NOT NULL CHECK (by_kind IN ('player','guardian')),
  by_id                            TEXT NOT NULL,
  by_name                          TEXT,
  agree                            INTEGER NOT NULL CHECK (agree IN (0,1)),
  note                             TEXT CHECK (note IS NULL OR length(note) <= 300),
  experience_rating                INTEGER CHECK (experience_rating IS NULL OR experience_rating BETWEEN 1 AND 5),
  at                               INTEGER NOT NULL,
  PRIMARY KEY (report_id, by_id),
  UNIQUE (report_id, position)
) STRICT;

-- not tables:
--   * In-memory / test-only state read by these modules: db.deliveryFailInject (contact/trial/decision failure
--     injection), the SCOUTBOX_TEST_CLOCK header clock, the development fault layer (faults.shouldFail),
--     rate-limit buckets (domains/platform/rateLimit.mjs), SSE broadcasts and event registries, integrity logs.
--   * Code registries referenced by id: PROVIDERS (m16/drills.mjs, Box Cam providers incl. testOnly), the M16.2
--     trust-score component registry (room_snapshots.trust_component_levels_json keys), COMBINE_PROTOCOLS
--     (room_snapshot_source_refs 'combine_result' strings), ROOM_STATUSES / ROOM_TRANSITIONS /
--     STATUS_EVIDENCE_REQUIRED / REASON_CODES / RECOMMENDATIONS / SOURCE_CONTEXTS / TASK_STATES (domains/recruitment/rooms/shared.mjs),
--     LIFECYCLE_ACTIONS (domains/recruitment/lifecycle/lifecycle.mjs), CONTACT_* / TRIAL_* / DECISION_* / OFFER_* / SIGNING_* vocabularies and
--     limits, OUTCOME_MAP, MINOR_*_PATHWAY_ENABLED policy tables, HANDOFF_TTL_MS, MILESTONES (3m/6m/12m).
--   * Derived values never stored: case.stage when a Room exists (stageForRoomStatus), room health / readiness /
--     funnel / needs-attention, trial `not_recorded` attendance, deriveWorkflowState (stored copy is
--     integrity-checked only), trial report deadline (trialReportDueAt), offer / signing EXPIRED, handoff
--     'expired', contact cooldown, offer liveRevision / liveStatus, signing summaryForOffer, the recruitment
--     journey projection (domains/recruitment/lifecycle/journey.mjs) and the evidence provider's answers (domains/recruitment/lifecycle/evidence.mjs), follow-up
--     outcomeState, budget scenario totals (computeScenarioTotals), every `honest` / `note` disclaimer sentence.
--   * Stores in OTHER files that these tables point at: channels, ledger, outbox (03); evidence, assessments,
--     vacancies, combine_requests, evidence_suggestions (04); ver_evidence (05); agent_transactions,
--     representation_agreements (06); box_sessions, box_cam_cv_results (07); players.trialReports is the SAME object
--     as trial_reports and must not become a second table in 01.
