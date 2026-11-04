/**
 * Recruitment cases (the M12 case with its M17 Room facet, M23 decision draft, M27 transaction handoff and F9 budget),
 * room comments, room snapshots, room decisions and room evidence states as typed tables with EXPLICIT writes
 * (migration `0016_recruitment_cases`, docs/architecture/migration.md §4.3; S8a, S8c and S8d are the template).
 *
 * Tables (file 02):
 *   recruitment_cases, case_room_tags, case_assignments, case_tasks, case_approvals, case_history,
 *   case_request_links, case_trial_links, case_decision_drafts, case_decision_draft_reason_codes,
 *   case_decision_draft_evidence_refs, case_transaction_handoffs, case_budget_scenarios, case_budget_lines,
 *   case_budget_fx_assumptions, case_budget_actuals                                     → db.recruitmentCases
 *   room_comments, room_comment_mentions                                                → db.roomComments
 *   room_snapshots, room_snapshot_source_refs                                           → db.roomSnapshots
 *   room_decisions, room_decision_reason_codes, room_decision_evidence_refs,
 *   room_decision_assessment_ids                                                        → db.roomDecisions
 *   room_evidence_states                                                                → db.roomEvidenceState
 *
 * EVERY FIELD IS A TYPED COLUMN with the vocabulary CHECKs of the domain rules (domains/recruitment/rooms/shared.mjs, domains/recruitment/lifecycle/decision.mjs,
 * m13/shared.mjs, m27/integration.mjs). There is no `absent_keys_json`, `offtype_json`, `extra_json` or `raw_json`.
 * A record the columns cannot hold — an unknown field at any level included — is REFUSED with its id, at a repository
 * write (the unit rolls back) and at a snapshot write (the save rolls back). An `undefined` field is an absent one;
 * an absent field reads back as null, an absent list as empty. Two model changes: a case's history has ONE entry
 * shape (`{ id, at, byKind, byId, byName, action, detail }`), and a decision's `snapshot` is read from the
 * room_snapshots row it names (it is that row, never a second copy). The idempotency keys are columns of their owner
 * (a draft's create key, a decision's finalize and draft keys, a handoff's invite key).
 *
 * EXPLICIT WRITES, SQL READS (§4.3 step 2). There are no mirrors and no `db.*` views (each of the five names throws);
 * readers call the repository's queries, and every record they get is a fresh, deep-frozen decode, so an in-place edit
 * throws. A route changes a record by calling an operation:
 * `cases.create(record)`, `cases.update(id, (draft) => { … })`, the same for comments, decisions and evidence states,
 * `snapshots.create(record)`, and the deletion unit's `redactPlayer`. `update` hands the caller a plain copy, types
 * the result whole, writes the record's rows at once and returns it read back from the tables. An update of a record
 * from inside its own update is refused (the outer write would overwrite the inner one). An operation joins the open
 * unit of work (store.unit) or runs a transaction of its own.
 *
 * References. org_id → orgs and the staff ids (owner, lead scout, M12 decision maker, assignee, comment author) →
 * org_users, RESTRICT. Every room row's room_id → recruitment_cases RESTRICT; a decision's snapshot_id →
 * room_snapshots RESTRICT. case_request_links → recruitment_requests and case_trial_links → trials RESTRICT. Player
 * ids: no key, tolerant and counted (Q8a). The decision chain (supersedes / superseded by) and a decision's snapshot
 * must stay inside the decision's room, checked at every write. The children cascade with their owner.
 *
 * Refusals name tables, fields and ids — never a name, a note, a body or a message.
 */
import { transaction, migrationApplied, newestHistory, childRowsOf } from './database.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { describe, isPlainObject, nonEmpty, ids } from './recruitment.mjs';
import {
  ROOM_STATUSES, ROOM_PRIORITIES, SOURCE_CONTEXTS, TASK_STATES, LINKED_RESOURCE_TYPES, EVIDENCE_REVIEW_STATES,
  RECOMMENDATIONS, LIMITS, CASE_STAGES, CASE_PRIORITIES, CASE_DECISION_OUTCOMES, CASE_APPROVAL_STATES,
} from '../domains/recruitment/rooms/shared.mjs';
import { DECISION_OUTCOMES, DECISION_KINDS, DECISION_STATES, EVIDENCE_REF_KINDS, DECISION_LIMITS } from '../domains/recruitment/lifecycle/decision.mjs';
import { CURRENCIES, BUDGET_LINE_KINDS, BUDGET_SCHEDULES } from '../m13/shared.mjs';
import { HANDOFF_STATUSES } from '../m27/integration.mjs';

export const RECRUITMENT_CASES_MIGRATION = '0016_recruitment_cases';
export const RECRUITMENT_CASES_COLLECTIONS = Object.freeze(['recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState']);
export const CASE_TABLES = Object.freeze(['recruitment_cases', 'case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals']);
export const ROOM_TABLES = Object.freeze(['room_comments', 'room_comment_mentions', 'room_snapshots', 'room_snapshot_source_refs', 'room_decisions', 'room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids', 'room_evidence_states']);
export const RECRUITMENT_CASES_TABLES = Object.freeze([...CASE_TABLES, ...ROOM_TABLES]);
export const recruitmentCasesLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION);
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------------------ vocabulary
/** Who a case history entry names: a club user (`org`, M13's `org_user`), a family member, the platform, an agent. */
export const CASE_ACTOR_KINDS = Object.freeze(['org', 'org_user', 'player', 'guardian', 'system', 'admin', 'agent']);
/** A handoff's stored status (`expired` is read from its age, never stored). */
const HANDOFF_STORED = HANDOFF_STATUSES.filter((s) => s !== 'expired');
const SOURCE_REF_KINDS = ['evidence', 'assessment', 'combine', 'trial'];
const CODE_MAX = 64;
const KEY_MAX = DECISION_LIMITS.clientKey;
const TEXT = { reasons: 500, trigger: 120, action: 64, assumption: 200, source: 80, task: 200, title: 200, label: 80, fxRate: 32, evidenceNote: 1000 };

// ------------------------------------------------------------------ DDL
const inList = (col, vocab) => `CHECK (${col} IS NULL OR ${col} IN (${vocab.map((v) => `'${v}'`).join(',')}))`;
const maxLen = (col, n) => `CHECK (${col} IS NULL OR length(${col}) <= ${n})`;
const bool = (col) => `CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const dayCheck = (col) => `CHECK (${col} IS NULL OR ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
const jsonObject = (col) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'object'))`;
const jsonArray = (col) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'array'))`;
const staffRef = (col) => `${col} TEXT REFERENCES org_users(id) ON DELETE RESTRICT`;
/** A day (`YYYY-MM-DD`) or an instant (ms), never both: a due date or a deadline. */
const dayOrInstantCols = (p) => `  ${p}_day TEXT ${dayCheck(`${p}_day`)},\n  ${p}_at INTEGER`;
const oneOfDayOrInstant = (p) => `CHECK (${p}_day IS NULL OR ${p}_at IS NULL)`;
const ownedByCase = '  case_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE CASCADE';

export const RECRUITMENT_CASES_DDL = `
CREATE TABLE recruitment_cases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  player_name TEXT,
  vacancy_id TEXT,
  ${staffRef('owner_user_id')} NOT NULL,
  owner_name TEXT,
  stage TEXT NOT NULL ${inList('stage', CASE_STAGES)},
  priority TEXT NOT NULL ${inList('priority', CASE_PRIORITIES)},
${dayOrInstantCols('deadline')},
  restricted INTEGER NOT NULL ${bool('restricted')},
  decision_outcome TEXT ${inList('decision_outcome', CASE_DECISION_OUTCOMES)},
  decision_reasons TEXT ${maxLen('decision_reasons', TEXT.reasons)},
  ${staffRef('decision_by_user_id')},
  decision_by_name TEXT,
  decision_approved_by_name TEXT,
  decision_at INTEGER,
  links_signing_id TEXT,
  created_at INTEGER NOT NULL,
  subject_removed_at INTEGER,
  room_status TEXT ${inList('room_status', ROOM_STATUSES)},
  room_priority TEXT ${inList('room_priority', ROOM_PRIORITIES)},
  ${staffRef('room_lead_scout_user_id')},
  room_source_context TEXT ${inList('room_source_context', SOURCE_CONTEXTS)},
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
  room_reopened_from TEXT ${inList('room_reopened_from', ROOM_STATUSES)},
  room_reopened_reason_codes_json TEXT ${jsonArray('room_reopened_reason_codes_json')},
  room_reopened_source_context TEXT ${inList('room_reopened_source_context', SOURCE_CONTEXTS)},
  room_reopened_source_ref_id TEXT,
  room_reopened_source_ref_version INTEGER,
  ${oneOfDayOrInstant('deadline')},
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
${ownedByCase},
  position INTEGER NOT NULL,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND ${LIMITS.tagLength}),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, tag)
) STRICT;
CREATE TABLE case_assignments (
${ownedByCase},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  ${staffRef('user_id')} NOT NULL,
  user_name TEXT,
  task TEXT NOT NULL ${maxLen('task', TEXT.task)},
${dayOrInstantCols('due')},
  status TEXT NOT NULL ${inList('status', TASK_STATES)},
  created_at INTEGER NOT NULL,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  ${oneOfDayOrInstant('due')}
) STRICT;
CREATE INDEX case_assignments_user ON case_assignments (user_id);
CREATE TABLE case_tasks (
${ownedByCase},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND ${TEXT.title}),
  description TEXT ${maxLen('description', LIMITS.taskDescription)},
${dayOrInstantCols('due')},
  assignee_user_id TEXT,
  assignee_name TEXT,
  status TEXT NOT NULL ${inList('status', TASK_STATES)},
  linked_resource_type TEXT ${inList('linked_resource_type', LINKED_RESOURCE_TYPES)},
  linked_resource_id TEXT,
  created_by_user_id TEXT,
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  completed_by_name TEXT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  ${oneOfDayOrInstant('due')}
) STRICT;
CREATE INDEX case_tasks_assignee_status ON case_tasks (assignee_user_id, status);
CREATE TABLE case_approvals (
${ownedByCase},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  decision_outcome TEXT NOT NULL ${inList('decision_outcome', CASE_DECISION_OUTCOMES)},
  decision_reasons TEXT ${maxLen('decision_reasons', TEXT.reasons)},
  requested_by_user_id TEXT,
  requested_by_name TEXT,
  status TEXT NOT NULL ${inList('status', CASE_APPROVAL_STATES)},
  requested_at INTEGER NOT NULL,
  resolved_by_user_id TEXT,
  resolved_by_name TEXT,
  resolved_at INTEGER,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
) STRICT;
CREATE TABLE case_history (
${ownedByCase},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND ${TEXT.action}),
  by_kind TEXT ${inList('by_kind', CASE_ACTOR_KINDS)},
  by_id TEXT,
  by_name TEXT,
  detail_text TEXT,
  detail_json TEXT ${jsonObject('detail_json')},
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK (detail_text IS NULL OR detail_json IS NULL)
) STRICT;
CREATE INDEX case_history_case_at ON case_history (case_id, at);
CREATE TABLE case_request_links (
${ownedByCase},
  position INTEGER NOT NULL,
  request_id TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, request_id)
) STRICT;
CREATE INDEX case_request_links_request ON case_request_links (request_id);
CREATE TABLE case_trial_links (
${ownedByCase},
  position INTEGER NOT NULL,
  trial_id TEXT NOT NULL REFERENCES trials(id) ON DELETE RESTRICT,
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, trial_id)
) STRICT;
CREATE INDEX case_trial_links_trial ON case_trial_links (trial_id);
CREATE TABLE case_decision_drafts (
  case_id TEXT PRIMARY KEY REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  outcome TEXT ${inList('outcome', DECISION_OUTCOMES)},
  note TEXT ${maxLen('note', DECISION_LIMITS.note)},
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
  create_key TEXT ${maxLen('create_key', KEY_MAX)},
  create_fp TEXT,
  CHECK ((create_key IS NULL) = (create_fp IS NULL))
) STRICT;
CREATE TABLE case_decision_draft_reason_codes (
  case_id TEXT NOT NULL REFERENCES case_decision_drafts(case_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND ${CODE_MAX}),
  PRIMARY KEY (case_id, position)
) STRICT;
CREATE TABLE case_decision_draft_evidence_refs (
  case_id TEXT NOT NULL REFERENCES case_decision_drafts(case_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL ${inList('kind', EVIDENCE_REF_KINDS)},
  ref_id TEXT NOT NULL,
  meta_json TEXT ${jsonObject('meta_json')},
  PRIMARY KEY (case_id, position)
) STRICT;
CREATE TABLE case_transaction_handoffs (
  case_id TEXT PRIMARY KEY REFERENCES recruitment_cases(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  status TEXT NOT NULL ${inList('status', HANDOFF_STORED)},
  invited_at INTEGER NOT NULL,
  invited_by_user_id TEXT,
  invited_by_name TEXT,
  accepted_at INTEGER,
  withdrawn_at INTEGER,
  transaction_id TEXT,
  represented_at_invitation INTEGER NOT NULL ${bool('represented_at_invitation')},
  invited_agency_org_id TEXT,
  invited_agent_user_id TEXT,
  invite_key TEXT ${maxLen('invite_key', KEY_MAX)},
  rev INTEGER NOT NULL CHECK (rev >= 1),
  rev_at INTEGER,
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL))
) STRICT;
CREATE INDEX case_transaction_handoffs_agent_status ON case_transaction_handoffs (invited_agent_user_id, status);
CREATE INDEX case_transaction_handoffs_player ON case_transaction_handoffs (player_id);
CREATE TABLE case_budget_scenarios (
${ownedByCase},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  label TEXT NOT NULL ${maxLen('label', TEXT.label)},
  currency TEXT NOT NULL ${inList('currency', CURRENCIES)},
  term_months INTEGER NOT NULL CHECK (term_months BETWEEN 1 AND 72),
  created_by_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approval_by_name TEXT,
  approval_by_user_id TEXT,
  approval_at INTEGER,
  approval_version INTEGER,
  approval_superseded INTEGER ${bool('approval_superseded')},
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, id),
  CHECK ((approval_at IS NULL) = (approval_version IS NULL) AND (approval_at IS NULL) = (approval_superseded IS NULL))
) STRICT;
CREATE TABLE case_budget_lines (
  case_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL ${inList('kind', BUDGET_LINE_KINDS)},
  label TEXT NOT NULL ${maxLen('label', TEXT.label)},
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL ${inList('currency', CURRENCIES)},
  schedule TEXT NOT NULL ${inList('schedule', BUDGET_SCHEDULES)},
  confirmed INTEGER NOT NULL ${bool('confirmed')},
  conditional_assumption TEXT ${maxLen('conditional_assumption', TEXT.assumption)},
  PRIMARY KEY (case_id, scenario_id, position),
  UNIQUE (case_id, scenario_id, id),
  FOREIGN KEY (case_id, scenario_id) REFERENCES case_budget_scenarios(case_id, id) ON DELETE CASCADE
) STRICT;
CREATE TABLE case_budget_fx_assumptions (
  case_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  from_currency TEXT NOT NULL ${inList('from_currency', CURRENCIES)},
  to_currency TEXT NOT NULL ${inList('to_currency', CURRENCIES)},
  rate TEXT NOT NULL CHECK (length(rate) BETWEEN 1 AND ${TEXT.fxRate}),
  source TEXT ${maxLen('source', TEXT.source)},
  date TEXT NOT NULL ${dayCheck('date')},
  manual INTEGER NOT NULL ${bool('manual')},
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
  ${staffRef('author_user_id')} NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND ${LIMITS.commentBody}),
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
  trigger TEXT NOT NULL CHECK (length(trigger) BETWEEN 1 AND ${TEXT.trigger}),
  trust_score REAL,
  trust_band TEXT,
  trust_policy_version INTEGER,
  trust_component_levels_json TEXT ${jsonObject('trust_component_levels_json')},
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
  kind TEXT NOT NULL ${inList('kind', SOURCE_REF_KINDS)},
  position INTEGER NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, kind, position)
) STRICT;
CREATE TABLE room_decisions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  player_id TEXT NOT NULL,
  kind TEXT ${inList('kind', DECISION_KINDS)},
  state TEXT ${inList('state', DECISION_STATES)},
  outcome TEXT ${inList('outcome', DECISION_OUTCOMES)},
  recommendation TEXT NOT NULL ${inList('recommendation', RECOMMENDATIONS)},
  note TEXT ${maxLen('note', DECISION_LIMITS.note)},
  by_user_id TEXT,
  by_name TEXT,
  by_role TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  trigger TEXT ${maxLen('trigger', TEXT.trigger)},
  client_key TEXT ${maxLen('client_key', KEY_MAX)},
  supersedes_id TEXT,
  superseded_by_id TEXT,
  supersession_of_id TEXT,
  supersession_reason TEXT ${maxLen('supersession_reason', DECISION_LIMITS.supersessionReason)},
  rev INTEGER CHECK (rev IS NULL OR rev >= 1),
  rev_at INTEGER,
  assessments_submitted INTEGER,
  assessments_withheld INTEGER,
  assessment_verdicts_json TEXT ${jsonObject('assessment_verdicts_json')},
  snapshot_id TEXT REFERENCES room_snapshots(id) ON DELETE RESTRICT,
  finalize_key TEXT ${maxLen('finalize_key', KEY_MAX)},
  finalize_fp TEXT,
  draft_key TEXT ${maxLen('draft_key', KEY_MAX)},
  draft_fp TEXT,
  draft_id TEXT,
  lifecycle_action TEXT,
  lifecycle_from TEXT ${inList('lifecycle_from', ROOM_STATUSES)},
  lifecycle_to TEXT ${inList('lifecycle_to', ROOM_STATUSES)},
  lifecycle_applied INTEGER ${bool('lifecycle_applied')},
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
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND ${CODE_MAX}),
  PRIMARY KEY (decision_id, position)
) STRICT;
CREATE TABLE room_decision_evidence_refs (
  decision_id TEXT NOT NULL REFERENCES room_decisions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL ${inList('kind', EVIDENCE_REF_KINDS)},
  ref_id TEXT NOT NULL,
  meta_json TEXT ${jsonObject('meta_json')},
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
  state TEXT NOT NULL ${inList('state', EVIDENCE_REVIEW_STATES)},
  note TEXT ${maxLen('note', TEXT.evidenceNote)},
  by_user_id TEXT,
  by_name TEXT,
  at INTEGER NOT NULL,
  UNIQUE (room_id, evidence_id)
) STRICT;
`;

// ------------------------------------------------------------------ typing (the one place a value is judged)
const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === 'string';
const absent = (v) => v === undefined || v === null;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
class Bad extends Error {}
const fail = (label, field, what) => { throw new Bad(`${label}.${field} ${what}`); };
function onlyKeys(v, keys, label, field) {
  if (!isPlainObject(v)) fail(label, field, `must be an object (got ${describe(v)})`);
  for (const k of Object.keys(v)) if (v[k] !== undefined && !keys.includes(k)) fail(label, `${field}.${k}`, 'is not a field this table stores');
  return v;
}
const str = (v, label, field, { max = null, required = false } = {}) => {
  if (absent(v)) { if (required) fail(label, field, 'is required'); return null; }
  if (!isStr(v)) fail(label, field, `must be text or null (got ${describe(v)})`);
  if (required && v.length === 0) fail(label, field, 'must not be empty');
  if (max !== null && v.length > max) fail(label, field, `exceeds ${max} characters`);
  return v;
};
const int = (v, label, field, { required = false, min = null } = {}) => {
  if (absent(v)) { if (required) fail(label, field, 'is required'); return null; }
  if (!isInt(v)) fail(label, field, `must be an integer or null (got ${describe(v)})`);
  if (min !== null && v < min) fail(label, field, `must be at least ${min}`);
  return v;
};
const num = (v, label, field) => { if (absent(v)) return null; if (typeof v !== 'number' || !Number.isFinite(v)) fail(label, field, `must be a finite number (got ${describe(v)})`); return v; };
const flag = (v, label, field, { required = false } = {}) => {
  if (absent(v)) { if (required) fail(label, field, 'is required'); return null; }
  if (typeof v !== 'boolean') fail(label, field, `must be true or false (got ${describe(v)})`);
  return v;
};
const oneOf = (v, allowed, label, field, { required = true } = {}) => {
  if (absent(v) && !required) return null;
  if (!allowed.includes(v)) fail(label, field, `must be one of ${allowed.join('|')} (got ${isStr(v) && v.length <= 40 ? JSON.stringify(v) : describe(v)})`);
  return v;
};
const dayOf = (v, label, field, { required = false } = {}) => {
  if (absent(v)) { if (required) fail(label, field, 'is required'); return null; }
  if (!isStr(v) || !DAY_RE.test(v)) fail(label, field, 'must be a YYYY-MM-DD day or null');
  return v;
};
/** A due date or a deadline: a `YYYY-MM-DD` day, an instant in ms, or nothing. */
const dayOrInstant = (v, label, field) => {
  if (absent(v)) return null;
  if ((isStr(v) && DAY_RE.test(v)) || isInt(v)) return v;
  return fail(label, field, 'must be a YYYY-MM-DD day, an instant in ms, or null');
};
const list = (v, label, field) => { if (absent(v)) return []; if (!Array.isArray(v)) fail(label, field, `must be a list (got ${describe(v)})`); return v; };
const obj = (v, keys, label, field) => (absent(v) ? null : onlyKeys(v, keys, label, field));
const unique = (items, keyOf, label, field) => { const seen = new Set(); for (const x of items) { const k = keyOf(x); if (seen.has(k)) fail(label, field, `repeats ${k}`); seen.add(k); } };
const strList = (v, label, field, { max = null } = {}) => list(v, label, field).map((x, i) => str(x, label, `${field}[${i}]`, { required: true, max }));
/** A plain JSON object (an evidence reference's metadata, a history entry's detail, a trust component map). */
const jsonObj = (v, label, field, { values = null } = {}) => {
  if (absent(v)) return null;
  if (!isPlainObject(v)) fail(label, field, `must be an object or null (got ${describe(v)})`);
  if (values) for (const [k, x] of Object.entries(v)) if (x !== undefined && !values(x)) fail(label, `${field}.${k}`, 'has a value of the wrong kind');
  return clone(v);
};
const person = (v, label, field, extra = []) => { const x = obj(v, ['userId', 'name', ...extra], label, field); return x ? { userId: str(x.userId, label, `${field}.userId`), name: str(x.name, label, `${field}.name`), ...Object.fromEntries(extra.map((k) => [k, str(x[k], label, `${field}.${k}`)])) } : null; };
/** A room's provenance reference: what it was opened or reopened from (a brief and its version, a Second Look item, a watchlist). */
const sourceRef = (v, label, field) => { const x = obj(v, ['id', 'version'], label, field); return x ? { id: str(x.id, label, `${field}.id`, { required: true }), version: int(x.version, label, `${field}.version`) } : null; };
const evidenceRefs = (v, label, field) => list(v, label, field).map((r, i) => { const L = `${label} ${field}[${i}]`; onlyKeys(r, ['kind', 'id', 'meta'], L, 'entry'); return { kind: oneOf(r.kind, EVIDENCE_REF_KINDS, L, 'kind'), id: str(r.id, L, 'id', { required: true }), meta: jsonObj(r.meta, L, 'meta') }; });
const keyPair = (v, label, field) => { const x = obj(v, ['key', 'fp'], label, field); return x ? { key: str(x.key, label, `${field}.key`, { required: true, max: KEY_MAX }), fp: str(x.fp, label, `${field}.fp`, { required: true }) } : null; };
const codes = (v, label, field) => strList(v, label, field, { max: CODE_MAX });
const typed = (fn) => (raw, at) => {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
    if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
    return { ok: true, record: fn(raw, `${at} ${raw.id}`) };
  } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
};

const CASE_KEYS = ['id', 'orgId', 'playerId', 'playerName', 'vacancyId', 'ownerUserId', 'ownerName', 'stage', 'priority', 'deadline', 'restricted', 'assignments', 'tasks', 'approvals', 'decision', 'links', 'createdAt', 'history', 'room', 'decisionDraft', 'transactionHandoff', 'budget', 'subjectRemovedAt'];
const ROOM_KEYS = ['status', 'priority', 'tags', 'leadScoutUserId', 'sourceContext', 'sourceRef', 'openedBy', 'updatedAt', 'archivedAt', 'closedAt', 'rev', 'revAt', 'revBy', 'reopened'];

function typeRoom(v, L) {
  const r = obj(v, ROOM_KEYS, L, 'room');
  if (!r) return null;
  const tags = strList(r.tags, L, 'room.tags', { max: LIMITS.tagLength });
  unique(tags, (t) => t, L, 'room.tags');
  const ro = obj(r.reopened, ['by', 'at', 'from', 'reasonCodes', 'sourceContext', 'sourceRef'], L, 'room.reopened');
  return {
    status: oneOf(r.status, ROOM_STATUSES, L, 'room.status'), priority: oneOf(r.priority, ROOM_PRIORITIES, L, 'room.priority'), tags,
    leadScoutUserId: str(r.leadScoutUserId, L, 'room.leadScoutUserId'), sourceContext: oneOf(r.sourceContext, SOURCE_CONTEXTS, L, 'room.sourceContext', { required: false }),
    sourceRef: sourceRef(r.sourceRef, L, 'room.sourceRef'), openedBy: person(r.openedBy, L, 'room.openedBy'),
    updatedAt: int(r.updatedAt, L, 'room.updatedAt', { required: true }), archivedAt: int(r.archivedAt, L, 'room.archivedAt'), closedAt: int(r.closedAt, L, 'room.closedAt'),
    rev: int(r.rev, L, 'room.rev', { required: true, min: 0 }), revAt: int(r.revAt, L, 'room.revAt'), revBy: person(r.revBy, L, 'room.revBy'),
    reopened: ro ? { by: person(ro.by, L, 'room.reopened.by'), at: int(ro.at, L, 'room.reopened.at', { required: true }), from: oneOf(ro.from, ROOM_STATUSES, L, 'room.reopened.from', { required: false }), reasonCodes: codes(ro.reasonCodes, L, 'room.reopened.reasonCodes'), sourceContext: oneOf(ro.sourceContext, SOURCE_CONTEXTS, L, 'room.reopened.sourceContext', { required: false }), sourceRef: sourceRef(ro.sourceRef, L, 'room.reopened.sourceRef') } : null,
  };
}
function typeHistory(v, L) {
  const history = list(v, L, 'history').map((h, i) => {
    const HL = `${L} history[${i}]`;
    onlyKeys(h, ['id', 'at', 'byKind', 'byId', 'byName', 'action', 'detail'], HL, 'entry');
    if (!absent(h.detail) && !isStr(h.detail) && !isPlainObject(h.detail)) fail(HL, 'detail', 'must be text, an object or null');
    return { id: str(h.id, HL, 'id', { required: true }), at: int(h.at, HL, 'at', { required: true }), byKind: oneOf(h.byKind, CASE_ACTOR_KINDS, HL, 'byKind', { required: false }), byId: str(h.byId, HL, 'byId'), byName: str(h.byName, HL, 'byName'), action: str(h.action, HL, 'action', { required: true, max: TEXT.action }), detail: absent(h.detail) ? null : clone(h.detail) };
  });
  unique(history, (h) => h.id, L, 'history');
  return history;
}
function typeDraft(v, L) {
  const d = obj(v, ['id', 'outcome', 'reasonCodes', 'note', 'evidenceRefs', 'by', 'createdAt', 'updatedAt', 'updatedBy', 'rev', 'revAt', 'keys'], L, 'decisionDraft');
  if (!d) return null;
  const k = obj(d.keys, ['create'], L, 'decisionDraft.keys');
  return {
    id: str(d.id, L, 'decisionDraft.id', { required: true }), outcome: oneOf(d.outcome, DECISION_OUTCOMES, L, 'decisionDraft.outcome', { required: false }),
    reasonCodes: codes(d.reasonCodes, L, 'decisionDraft.reasonCodes'), note: str(d.note, L, 'decisionDraft.note', { max: DECISION_LIMITS.note }),
    evidenceRefs: evidenceRefs(d.evidenceRefs, L, 'decisionDraft.evidenceRefs'), by: person(d.by, L, 'decisionDraft.by', ['role']),
    createdAt: int(d.createdAt, L, 'decisionDraft.createdAt', { required: true }), updatedAt: int(d.updatedAt, L, 'decisionDraft.updatedAt', { required: true }), updatedBy: person(d.updatedBy, L, 'decisionDraft.updatedBy', ['role']),
    rev: int(d.rev, L, 'decisionDraft.rev', { required: true, min: 1 }), revAt: int(d.revAt, L, 'decisionDraft.revAt'),
    keys: { create: k ? keyPair(k.create, L, 'decisionDraft.keys.create') : null },
  };
}
function typeHandoff(v, L, caseId) {
  const h = obj(v, ['id', 'caseId', 'orgId', 'playerId', 'status', 'invitedAt', 'invitedBy', 'acceptedAt', 'withdrawnAt', 'transactionId', 'representedAtInvitation', 'invitedAgencyOrgId', 'invitedAgentUserId', 'keys', 'rev', 'revAt'], L, 'transactionHandoff');
  if (!h) return null;
  if (h.caseId !== caseId) fail(L, 'transactionHandoff.caseId', 'must name the case it is on');
  const by = obj(h.invitedBy, ['kind', 'userId', 'name'], L, 'transactionHandoff.invitedBy');
  if (by) oneOf(by.kind, ['org'], L, 'transactionHandoff.invitedBy.kind');
  const k = obj(h.keys, ['invite'], L, 'transactionHandoff.keys');
  const inv = k ? obj(k.invite, ['key'], L, 'transactionHandoff.keys.invite') : null;
  return {
    id: str(h.id, L, 'transactionHandoff.id', { required: true }), caseId, orgId: str(h.orgId, L, 'transactionHandoff.orgId', { required: true }), playerId: str(h.playerId, L, 'transactionHandoff.playerId', { required: true }),
    status: oneOf(h.status, HANDOFF_STORED, L, 'transactionHandoff.status'), invitedAt: int(h.invitedAt, L, 'transactionHandoff.invitedAt', { required: true }),
    invitedBy: by ? { kind: 'org', userId: str(by.userId, L, 'transactionHandoff.invitedBy.userId'), name: str(by.name, L, 'transactionHandoff.invitedBy.name') } : null,
    acceptedAt: int(h.acceptedAt, L, 'transactionHandoff.acceptedAt'), withdrawnAt: int(h.withdrawnAt, L, 'transactionHandoff.withdrawnAt'), transactionId: str(h.transactionId, L, 'transactionHandoff.transactionId'),
    representedAtInvitation: flag(h.representedAtInvitation, L, 'transactionHandoff.representedAtInvitation', { required: true }),
    invitedAgencyOrgId: str(h.invitedAgencyOrgId, L, 'transactionHandoff.invitedAgencyOrgId'), invitedAgentUserId: str(h.invitedAgentUserId, L, 'transactionHandoff.invitedAgentUserId'),
    keys: { invite: inv ? { key: str(inv.key, L, 'transactionHandoff.keys.invite.key', { required: true, max: KEY_MAX }) } : null },
    rev: int(h.rev, L, 'transactionHandoff.rev', { required: true, min: 1 }), revAt: int(h.revAt, L, 'transactionHandoff.revAt'),
  };
}
function typeBudget(v, L) {
  const bud = obj(v, ['scenarios'], L, 'budget');
  if (!bud) return null;
  const scenarios = list(bud.scenarios, L, 'budget.scenarios').map((s, i) => {
    const SL = `${L} budget.scenarios[${i}]`;
    onlyKeys(s, ['id', 'version', 'label', 'currency', 'termMonths', 'lines', 'fxAssumptions', 'approval', 'actuals', 'createdBy', 'createdAt', 'updatedAt'], SL, 'scenario');
    const lines = list(s.lines, SL, 'lines').map((l, j) => {
      const LL = `${SL} lines[${j}]`; onlyKeys(l, ['id', 'kind', 'label', 'amountMinor', 'currency', 'schedule', 'confirmed', 'conditional'], LL, 'line');
      const c = obj(l.conditional, ['assumption'], LL, 'conditional');
      return { id: str(l.id, LL, 'id', { required: true }), kind: oneOf(l.kind, BUDGET_LINE_KINDS, LL, 'kind'), label: str(l.label, LL, 'label', { required: true, max: TEXT.label }), amountMinor: int(l.amountMinor, LL, 'amountMinor', { required: true, min: 0 }), currency: oneOf(l.currency, CURRENCIES, LL, 'currency'), schedule: oneOf(l.schedule, BUDGET_SCHEDULES, LL, 'schedule'), confirmed: flag(l.confirmed, LL, 'confirmed', { required: true }), conditional: c ? { assumption: str(c.assumption, LL, 'conditional.assumption', { required: true, max: TEXT.assumption }) } : null };
    });
    unique(lines, (l) => l.id, SL, 'lines');
    const fxAssumptions = list(s.fxAssumptions, SL, 'fxAssumptions').map((a, j) => {
      const AL = `${SL} fxAssumptions[${j}]`; onlyKeys(a, ['from', 'to', 'rate', 'source', 'date', 'manual'], AL, 'assumption');
      return { from: oneOf(a.from, CURRENCIES, AL, 'from'), to: oneOf(a.to, CURRENCIES, AL, 'to'), rate: str(a.rate, AL, 'rate', { required: true, max: TEXT.fxRate }), source: str(a.source, AL, 'source', { max: TEXT.source }), date: dayOf(a.date, AL, 'date', { required: true }), manual: flag(a.manual, AL, 'manual', { required: true }) };
    });
    const ap = obj(s.approval, ['by', 'byUserId', 'at', 'version', 'superseded'], SL, 'approval');
    const actuals = list(s.actuals, SL, 'actuals').map((a, j) => {
      const AL = `${SL} actuals[${j}]`; onlyKeys(a, ['id', 'lineId', 'amountMinor', 'at', 'recordedBy'], AL, 'actual');
      return { id: str(a.id, AL, 'id', { required: true }), lineId: str(a.lineId, AL, 'lineId', { required: true }), amountMinor: int(a.amountMinor, AL, 'amountMinor', { required: true }), at: int(a.at, AL, 'at', { required: true }), recordedBy: str(a.recordedBy, AL, 'recordedBy') };
    });
    return {
      id: str(s.id, SL, 'id', { required: true }), version: int(s.version, SL, 'version', { required: true, min: 1 }), label: str(s.label, SL, 'label', { required: true, max: TEXT.label }),
      currency: oneOf(s.currency, CURRENCIES, SL, 'currency'), termMonths: int(s.termMonths, SL, 'termMonths', { required: true, min: 1 }), lines, fxAssumptions,
      approval: ap ? { by: str(ap.by, SL, 'approval.by'), byUserId: str(ap.byUserId, SL, 'approval.byUserId'), at: int(ap.at, SL, 'approval.at', { required: true }), version: int(ap.version, SL, 'approval.version', { required: true }), superseded: flag(ap.superseded, SL, 'approval.superseded', { required: true }) } : null,
      actuals, createdBy: str(s.createdBy, SL, 'createdBy'), createdAt: int(s.createdAt, SL, 'createdAt', { required: true }), updatedAt: int(s.updatedAt, SL, 'updatedAt', { required: true }),
    };
  });
  unique(scenarios, (s) => s.id, L, 'budget.scenarios');
  // An empty budget is no budget: a case gains one with its first scenario and never loses a scenario.
  return scenarios.length ? { scenarios } : null;
}

/** A case as M12, M13, M17, M23 and M27 write it, typed. */
export const typeCase = typed((raw, L) => {
  onlyKeys(raw, CASE_KEYS, L, 'record');
  const assignments = list(raw.assignments, L, 'assignments').map((a, i) => {
    const AL = `${L} assignments[${i}]`; onlyKeys(a, ['id', 'userId', 'name', 'task', 'dueAt', 'status', 'createdAt'], AL, 'entry');
    return { id: str(a.id, AL, 'id', { required: true }), userId: str(a.userId, AL, 'userId', { required: true }), name: str(a.name, AL, 'name'), task: str(a.task, AL, 'task', { required: true, max: TEXT.task }), dueAt: dayOrInstant(a.dueAt, AL, 'dueAt'), status: oneOf(a.status, TASK_STATES, AL, 'status'), createdAt: int(a.createdAt, AL, 'createdAt', { required: true }) };
  });
  unique(assignments, (a) => a.id, L, 'assignments');
  const tasks = list(raw.tasks, L, 'tasks').map((t, i) => {
    const TL = `${L} tasks[${i}]`; onlyKeys(t, ['id', 'title', 'description', 'dueAt', 'assigneeUserId', 'assigneeName', 'status', 'linkedResourceType', 'linkedResourceId', 'createdBy', 'createdAt', 'completedAt', 'completedBy'], TL, 'entry');
    return { id: str(t.id, TL, 'id', { required: true }), title: str(t.title, TL, 'title', { required: true, max: TEXT.title }), description: str(t.description, TL, 'description', { max: LIMITS.taskDescription }), dueAt: dayOrInstant(t.dueAt, TL, 'dueAt'), assigneeUserId: str(t.assigneeUserId, TL, 'assigneeUserId'), assigneeName: str(t.assigneeName, TL, 'assigneeName'), status: oneOf(t.status, TASK_STATES, TL, 'status'), linkedResourceType: oneOf(t.linkedResourceType, LINKED_RESOURCE_TYPES, TL, 'linkedResourceType', { required: false }), linkedResourceId: str(t.linkedResourceId, TL, 'linkedResourceId'), createdBy: person(t.createdBy, TL, 'createdBy'), createdAt: int(t.createdAt, TL, 'createdAt', { required: true }), completedAt: int(t.completedAt, TL, 'completedAt'), completedBy: str(t.completedBy, TL, 'completedBy') };
  });
  unique(tasks, (t) => t.id, L, 'tasks');
  const approvals = list(raw.approvals, L, 'approvals').map((a, i) => {
    const AL = `${L} approvals[${i}]`; onlyKeys(a, ['id', 'decision', 'requestedBy', 'status', 'requestedAt', 'resolvedBy'], AL, 'entry');
    const d = obj(a.decision, ['outcome', 'reasons'], AL, 'decision'); if (!d) fail(AL, 'decision', 'is required');
    const rb = obj(a.resolvedBy, ['userId', 'name', 'at'], AL, 'resolvedBy');
    const status = oneOf(a.status, CASE_APPROVAL_STATES, AL, 'status');
    if ((status === 'pending') !== !rb) fail(AL, 'resolvedBy', 'is set exactly when the approval is resolved');
    return { id: str(a.id, AL, 'id', { required: true }), decision: { outcome: oneOf(d.outcome, CASE_DECISION_OUTCOMES, AL, 'decision.outcome'), reasons: str(d.reasons, AL, 'decision.reasons', { max: TEXT.reasons }) }, requestedBy: person(a.requestedBy, AL, 'requestedBy'), status, requestedAt: int(a.requestedAt, AL, 'requestedAt', { required: true }), resolvedBy: rb ? { userId: str(rb.userId, AL, 'resolvedBy.userId'), name: str(rb.name, AL, 'resolvedBy.name'), at: int(rb.at, AL, 'resolvedBy.at', { required: true }) } : null };
  });
  unique(approvals, (a) => a.id, L, 'approvals');
  const dec = obj(raw.decision, ['outcome', 'reasons', 'byUserId', 'byName', 'approvedBy', 'at'], L, 'decision');
  const lk = obj(raw.links, ['requestIds', 'trialIds', 'signingId'], L, 'links') ?? {};
  const links = { requestIds: strList(lk.requestIds, L, 'links.requestIds'), trialIds: strList(lk.trialIds, L, 'links.trialIds'), signingId: str(lk.signingId, L, 'links.signingId') };
  unique(links.requestIds, (x) => x, L, 'links.requestIds'); unique(links.trialIds, (x) => x, L, 'links.trialIds');
  return {
    id: raw.id, orgId: str(raw.orgId, L, 'orgId', { required: true }), playerId: str(raw.playerId, L, 'playerId', { required: true }), playerName: str(raw.playerName, L, 'playerName'),
    vacancyId: str(raw.vacancyId, L, 'vacancyId'), ownerUserId: str(raw.ownerUserId, L, 'ownerUserId', { required: true }), ownerName: str(raw.ownerName, L, 'ownerName'),
    stage: oneOf(raw.stage, CASE_STAGES, L, 'stage'), priority: oneOf(raw.priority, CASE_PRIORITIES, L, 'priority'), deadline: dayOrInstant(raw.deadline, L, 'deadline'),
    restricted: flag(raw.restricted, L, 'restricted') ?? false, assignments, tasks, approvals,
    decision: dec ? { outcome: oneOf(dec.outcome, CASE_DECISION_OUTCOMES, L, 'decision.outcome'), reasons: str(dec.reasons, L, 'decision.reasons', { max: TEXT.reasons }), byUserId: str(dec.byUserId, L, 'decision.byUserId'), byName: str(dec.byName, L, 'decision.byName'), approvedBy: str(dec.approvedBy, L, 'decision.approvedBy'), at: int(dec.at, L, 'decision.at', { required: true }) } : null,
    links, createdAt: int(raw.createdAt, L, 'createdAt', { required: true }), history: typeHistory(raw.history, L), room: typeRoom(raw.room, L),
    decisionDraft: typeDraft(raw.decisionDraft, L), transactionHandoff: typeHandoff(raw.transactionHandoff, L, raw.id), budget: typeBudget(raw.budget, L), subjectRemovedAt: int(raw.subjectRemovedAt, L, 'subjectRemovedAt'),
  };
});

export const typeComment = typed((raw, L) => {
  onlyKeys(raw, ['id', 'roomId', 'orgId', 'authorId', 'authorName', 'body', 'replyToId', 'mentions', 'createdAt', 'editedAt', 'editCount', 'deletedAt', 'deletedBy'], L, 'record');
  const mentions = strList(raw.mentions, L, 'mentions'); unique(mentions, (m) => m, L, 'mentions');
  const deletedAt = int(raw.deletedAt, L, 'deletedAt'); const deletedBy = person(raw.deletedBy, L, 'deletedBy');
  if (deletedBy && deletedAt === null) fail(L, 'deletedBy', 'is only stored on a deleted comment');
  return { id: raw.id, roomId: str(raw.roomId, L, 'roomId', { required: true }), orgId: str(raw.orgId, L, 'orgId', { required: true }), authorId: str(raw.authorId, L, 'authorId', { required: true }), authorName: str(raw.authorName, L, 'authorName'), body: str(raw.body, L, 'body', { required: true, max: LIMITS.commentBody }), replyToId: str(raw.replyToId, L, 'replyToId'), mentions, createdAt: int(raw.createdAt, L, 'createdAt', { required: true }), editedAt: int(raw.editedAt, L, 'editedAt'), editCount: int(raw.editCount, L, 'editCount', { min: 0 }) ?? 0, deletedAt, deletedBy };
});

function typeTrust(v, L, field) {
  const t = obj(v, ['score', 'band', 'policyVersion', 'componentLevels', 'hash'], L, field);
  return t ? { score: num(t.score, L, `${field}.score`), band: str(t.band, L, `${field}.band`), policyVersion: int(t.policyVersion, L, `${field}.policyVersion`), componentLevels: jsonObj(t.componentLevels, L, `${field}.componentLevels`, { values: isStr }) ?? {}, hash: str(t.hash, L, `${field}.hash`, { required: true }) } : null;
}
function typeSourceRefs(v, L, field) {
  const s = obj(v, ['passportVersion', 'passportRevision', 'evidenceIds', 'assessmentIds', 'combineResults', 'trialIds'], L, field) ?? {};
  return { passportVersion: int(s.passportVersion, L, `${field}.passportVersion`), passportRevision: str(s.passportRevision, L, `${field}.passportRevision`), evidenceIds: strList(s.evidenceIds, L, `${field}.evidenceIds`), assessmentIds: strList(s.assessmentIds, L, `${field}.assessmentIds`), combineResults: strList(s.combineResults, L, `${field}.combineResults`), trialIds: strList(s.trialIds, L, `${field}.trialIds`) };
}
export const typeSnapshot = typed((raw, L) => {
  onlyKeys(raw, ['id', 'roomId', 'orgId', 'playerId', 'at', 'trigger', 'trust', 'sourceRefs', 'note'], L, 'record');
  return { id: raw.id, roomId: str(raw.roomId, L, 'roomId', { required: true }), orgId: str(raw.orgId, L, 'orgId', { required: true }), playerId: str(raw.playerId, L, 'playerId', { required: true }), at: int(raw.at, L, 'at', { required: true }), trigger: str(raw.trigger, L, 'trigger', { required: true, max: TEXT.trigger }), trust: typeTrust(raw.trust, L, 'trust'), sourceRefs: typeSourceRefs(raw.sourceRefs, L, 'sourceRefs'), note: str(raw.note, L, 'note') };
});

const DECISION_KEYS = ['id', 'roomId', 'orgId', 'playerId', 'kind', 'state', 'outcome', 'recommendation', 'reasonCodes', 'note', 'by', 'createdAt', 'finalizedAt', 'trigger', 'clientKey', 'supersedes', 'supersededById', 'supersession', 'rev', 'revAt', 'evidenceRefs', 'assessmentSummary', 'snapshot', 'keys', 'draftId', 'lifecycle', 'policyVersion'];
export const typeDecision = typed((raw, L) => {
  onlyKeys(raw, DECISION_KEYS, L, 'record');
  const sp = obj(raw.supersession, ['of', 'reason'], L, 'supersession');
  const as = obj(raw.assessmentSummary, ['submitted', 'withheld', 'verdicts', 'assessmentIds'], L, 'assessmentSummary');
  const sn = obj(raw.snapshot, ['at', 'trust', 'sourceRefs', 'snapshotId'], L, 'snapshot');
  const k = obj(raw.keys, ['finalize', 'draft'], L, 'keys') ?? {};
  const lc = obj(raw.lifecycle, ['action', 'from', 'to', 'applied', 'reason', 'at'], L, 'lifecycle');
  return {
    id: raw.id, roomId: str(raw.roomId, L, 'roomId', { required: true }), orgId: str(raw.orgId, L, 'orgId', { required: true }), playerId: str(raw.playerId, L, 'playerId', { required: true }),
    kind: oneOf(raw.kind, DECISION_KINDS, L, 'kind', { required: false }), state: oneOf(raw.state, DECISION_STATES, L, 'state', { required: false }), outcome: oneOf(raw.outcome, DECISION_OUTCOMES, L, 'outcome', { required: false }),
    recommendation: oneOf(raw.recommendation, RECOMMENDATIONS, L, 'recommendation'), reasonCodes: codes(raw.reasonCodes, L, 'reasonCodes'), note: str(raw.note, L, 'note', { max: DECISION_LIMITS.note }),
    by: person(raw.by, L, 'by', ['role']), createdAt: int(raw.createdAt, L, 'createdAt', { required: true }), finalizedAt: int(raw.finalizedAt, L, 'finalizedAt'),
    trigger: str(raw.trigger, L, 'trigger', { max: TEXT.trigger }), clientKey: str(raw.clientKey, L, 'clientKey', { max: KEY_MAX }),
    supersedes: str(raw.supersedes, L, 'supersedes'), supersededById: str(raw.supersededById, L, 'supersededById'),
    supersession: sp ? { of: str(sp.of, L, 'supersession.of', { required: true }), reason: str(sp.reason, L, 'supersession.reason', { required: true, max: DECISION_LIMITS.supersessionReason }) } : null,
    rev: int(raw.rev, L, 'rev', { min: 1 }), revAt: int(raw.revAt, L, 'revAt'), evidenceRefs: evidenceRefs(raw.evidenceRefs, L, 'evidenceRefs'),
    assessmentSummary: as ? { submitted: int(as.submitted, L, 'assessmentSummary.submitted', { required: true, min: 0 }), withheld: int(as.withheld, L, 'assessmentSummary.withheld', { min: 0 }) ?? 0, verdicts: jsonObj(as.verdicts, L, 'assessmentSummary.verdicts', { values: isInt }) ?? {}, assessmentIds: strList(as.assessmentIds, L, 'assessmentSummary.assessmentIds') } : null,
    // The decision's snapshot IS the room_snapshots row it names: only the id is stored, and the row is read back with it.
    snapshot: sn ? { snapshotId: str(sn.snapshotId, L, 'snapshot.snapshotId', { required: true }) } : null,
    keys: { finalize: keyPair(k.finalize, L, 'keys.finalize'), draft: keyPair(k.draft, L, 'keys.draft') },
    draftId: str(raw.draftId, L, 'draftId'),
    lifecycle: lc ? { action: str(lc.action, L, 'lifecycle.action'), from: oneOf(lc.from, ROOM_STATUSES, L, 'lifecycle.from', { required: false }), to: oneOf(lc.to, ROOM_STATUSES, L, 'lifecycle.to', { required: false }), applied: flag(lc.applied, L, 'lifecycle.applied', { required: true }), reason: str(lc.reason, L, 'lifecycle.reason'), at: int(lc.at, L, 'lifecycle.at') } : null,
    policyVersion: int(raw.policyVersion, L, 'policyVersion'),
  };
});

export const typeEvidenceState = typed((raw, L) => {
  onlyKeys(raw, ['id', 'roomId', 'orgId', 'evidenceId', 'state', 'note', 'byId', 'byName', 'at'], L, 'record');
  return { id: raw.id, roomId: str(raw.roomId, L, 'roomId', { required: true }), orgId: str(raw.orgId, L, 'orgId', { required: true }), evidenceId: str(raw.evidenceId, L, 'evidenceId', { required: true }), state: oneOf(raw.state, EVIDENCE_REVIEW_STATES, L, 'state'), note: str(raw.note, L, 'note', { max: TEXT.evidenceNote }), byId: str(raw.byId, L, 'byId'), byName: str(raw.byName, L, 'byName'), at: int(raw.at, L, 'at', { required: true }) };
});
const TYPERS = { recruitmentCases: typeCase, roomComments: typeComment, roomSnapshots: typeSnapshot, roomDecisions: typeDecision, roomEvidenceState: typeEvidenceState };

// ------------------------------------------------------------------ rows
const b = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const dueRow = (p, v) => ({ [`${p}_day`]: isStr(v) ? v : null, [`${p}_at`]: isInt(v) ? v : null });
const dueOut = (row, p) => row[`${p}_day`] ?? row[`${p}_at`];
const personRow = (p, v, extra = []) => ({ [`${p}_user_id`]: v?.userId ?? null, [`${p}_name`]: v?.name ?? null, ...Object.fromEntries(extra.map((k) => [`${p}_${k}`, v?.[k] ?? null])) });
const personOut = (row, p, extra = []) => (row[`${p}_user_id`] === null && row[`${p}_name`] === null && extra.every((k) => row[`${p}_${k}`] === null) ? null : { userId: row[`${p}_user_id`], name: row[`${p}_name`], ...Object.fromEntries(extra.map((k) => [k, row[`${p}_${k}`]])) });
const jsonOut = (v) => (v === null ? null : JSON.parse(v));

const caseRow = (c) => {
  const r = c.room; const ro = r?.reopened ?? null;
  return {
    id: c.id, org_id: c.orgId, player_id: c.playerId, player_name: c.playerName, vacancy_id: c.vacancyId, owner_user_id: c.ownerUserId, owner_name: c.ownerName,
    stage: c.stage, priority: c.priority, ...dueRow('deadline', c.deadline), restricted: b(c.restricted),
    decision_outcome: c.decision?.outcome ?? null, decision_reasons: c.decision?.reasons ?? null, decision_by_user_id: c.decision?.byUserId ?? null, decision_by_name: c.decision?.byName ?? null, decision_approved_by_name: c.decision?.approvedBy ?? null, decision_at: c.decision?.at ?? null,
    links_signing_id: c.links.signingId, created_at: c.createdAt, subject_removed_at: c.subjectRemovedAt,
    room_status: r?.status ?? null, room_priority: r?.priority ?? null, room_lead_scout_user_id: r?.leadScoutUserId ?? null, room_source_context: r?.sourceContext ?? null,
    room_source_ref_id: r?.sourceRef?.id ?? null, room_source_ref_version: r?.sourceRef?.version ?? null, ...personRow('room_opened_by', r?.openedBy),
    room_updated_at: r?.updatedAt ?? null, room_archived_at: r?.archivedAt ?? null, room_closed_at: r?.closedAt ?? null,
    room_rev: r?.rev ?? null, room_rev_at: r?.revAt ?? null, ...personRow('room_rev_by', r?.revBy),
    room_reopened_at: ro?.at ?? null, ...personRow('room_reopened_by', ro?.by), room_reopened_from: ro?.from ?? null, room_reopened_reason_codes_json: ro ? JSON.stringify(ro.reasonCodes) : null,
    room_reopened_source_context: ro?.sourceContext ?? null, room_reopened_source_ref_id: ro?.sourceRef?.id ?? null, room_reopened_source_ref_version: ro?.sourceRef?.version ?? null,
  };
};
const draftRow = (caseId, d) => ({ case_id: caseId, id: d.id, outcome: d.outcome, note: d.note, ...personRow('by', d.by, ['role']), created_at: d.createdAt, updated_at: d.updatedAt, ...personRow('updated_by', d.updatedBy, ['role']), rev: d.rev, rev_at: d.revAt, create_key: d.keys.create?.key ?? null, create_fp: d.keys.create?.fp ?? null });
const handoffRow = (caseId, h) => ({ case_id: caseId, id: h.id, org_id: h.orgId, player_id: h.playerId, status: h.status, invited_at: h.invitedAt, invited_by_user_id: h.invitedBy?.userId ?? null, invited_by_name: h.invitedBy?.name ?? null, accepted_at: h.acceptedAt, withdrawn_at: h.withdrawnAt, transaction_id: h.transactionId, represented_at_invitation: b(h.representedAtInvitation), invited_agency_org_id: h.invitedAgencyOrgId, invited_agent_user_id: h.invitedAgentUserId, invite_key: h.keys.invite?.key ?? null, rev: h.rev, rev_at: h.revAt });
const commentRow = (c) => ({ id: c.id, room_id: c.roomId, org_id: c.orgId, author_user_id: c.authorId, author_name: c.authorName, body: c.body, reply_to_id: c.replyToId, created_at: c.createdAt, edited_at: c.editedAt, edit_count: c.editCount, deleted_at: c.deletedAt, ...personRow('deleted_by', c.deletedBy) });
const snapshotRow = (s) => ({ id: s.id, room_id: s.roomId, org_id: s.orgId, player_id: s.playerId, at: s.at, trigger: s.trigger, trust_score: s.trust?.score ?? null, trust_band: s.trust?.band ?? null, trust_policy_version: s.trust?.policyVersion ?? null, trust_component_levels_json: s.trust ? JSON.stringify(s.trust.componentLevels) : null, trust_hash: s.trust?.hash ?? null, source_passport_version: s.sourceRefs.passportVersion ?? null, source_passport_revision: s.sourceRefs.passportRevision ?? null, note: s.note });
const decisionRow = (d) => ({
  id: d.id, room_id: d.roomId, org_id: d.orgId, player_id: d.playerId, kind: d.kind, state: d.state, outcome: d.outcome, recommendation: d.recommendation, note: d.note, ...personRow('by', d.by, ['role']),
  created_at: d.createdAt, finalized_at: d.finalizedAt, trigger: d.trigger, client_key: d.clientKey, supersedes_id: d.supersedes, superseded_by_id: d.supersededById,
  supersession_of_id: d.supersession?.of ?? null, supersession_reason: d.supersession?.reason ?? null, rev: d.rev, rev_at: d.revAt,
  assessments_submitted: d.assessmentSummary?.submitted ?? null, assessments_withheld: d.assessmentSummary?.withheld ?? null, assessment_verdicts_json: d.assessmentSummary ? JSON.stringify(d.assessmentSummary.verdicts) : null,
  snapshot_id: d.snapshot?.snapshotId ?? null, finalize_key: d.keys.finalize?.key ?? null, finalize_fp: d.keys.finalize?.fp ?? null, draft_key: d.keys.draft?.key ?? null, draft_fp: d.keys.draft?.fp ?? null, draft_id: d.draftId,
  lifecycle_action: d.lifecycle?.action ?? null, lifecycle_from: d.lifecycle?.from ?? null, lifecycle_to: d.lifecycle?.to ?? null, lifecycle_applied: b(d.lifecycle?.applied), lifecycle_reason: d.lifecycle?.reason ?? null, lifecycle_at: d.lifecycle?.at ?? null, policy_version: d.policyVersion,
});
const evidenceRow = (e) => ({ id: e.id, room_id: e.roomId, org_id: e.orgId, evidence_id: e.evidenceId, state: e.state, note: e.note, by_user_id: e.byId, by_name: e.byName, at: e.at });

const SAMPLE_CASE = { id: 'x', links: { signingId: null } };
const SAMPLE_DECISION = { id: 'x', keys: { finalize: null, draft: null } };
const COLS = {
  recruitment_cases: Object.keys(caseRow(SAMPLE_CASE)),
  case_room_tags: ['case_id', 'position', 'tag'],
  case_assignments: ['case_id', 'position', 'id', 'user_id', 'user_name', 'task', 'due_day', 'due_at', 'status', 'created_at'],
  case_tasks: ['case_id', 'position', 'id', 'title', 'description', 'due_day', 'due_at', 'assignee_user_id', 'assignee_name', 'status', 'linked_resource_type', 'linked_resource_id', 'created_by_user_id', 'created_by_name', 'created_at', 'completed_at', 'completed_by_name'],
  case_approvals: ['case_id', 'position', 'id', 'decision_outcome', 'decision_reasons', 'requested_by_user_id', 'requested_by_name', 'status', 'requested_at', 'resolved_by_user_id', 'resolved_by_name', 'resolved_at'],
  case_history: ['case_id', 'position', 'id', 'at', 'action', 'by_kind', 'by_id', 'by_name', 'detail_text', 'detail_json'],
  case_request_links: ['case_id', 'position', 'request_id'],
  case_trial_links: ['case_id', 'position', 'trial_id'],
  case_decision_drafts: Object.keys(draftRow('x', { keys: { create: null } })),
  case_decision_draft_reason_codes: ['case_id', 'position', 'code'],
  case_decision_draft_evidence_refs: ['case_id', 'position', 'kind', 'ref_id', 'meta_json'],
  case_transaction_handoffs: Object.keys(handoffRow('x', { keys: { invite: null } })),
  case_budget_scenarios: ['case_id', 'position', 'id', 'version', 'label', 'currency', 'term_months', 'created_by_name', 'created_at', 'updated_at', 'approval_by_name', 'approval_by_user_id', 'approval_at', 'approval_version', 'approval_superseded'],
  case_budget_lines: ['case_id', 'scenario_id', 'position', 'id', 'kind', 'label', 'amount_minor', 'currency', 'schedule', 'confirmed', 'conditional_assumption'],
  case_budget_fx_assumptions: ['case_id', 'scenario_id', 'position', 'from_currency', 'to_currency', 'rate', 'source', 'date', 'manual'],
  case_budget_actuals: ['case_id', 'scenario_id', 'position', 'id', 'line_id', 'amount_minor', 'at', 'recorded_by_name'],
  room_comments: Object.keys(commentRow({})),
  room_comment_mentions: ['comment_id', 'position', 'user_id'],
  room_snapshots: Object.keys(snapshotRow({ sourceRefs: {} })),
  room_snapshot_source_refs: ['snapshot_id', 'kind', 'position', 'ref_id'],
  room_decisions: Object.keys(decisionRow(SAMPLE_DECISION)),
  room_decision_reason_codes: ['decision_id', 'position', 'code'],
  room_decision_evidence_refs: ['decision_id', 'position', 'kind', 'ref_id', 'meta_json'],
  room_decision_assessment_ids: ['decision_id', 'position', 'assessment_id'],
  room_evidence_states: Object.keys(evidenceRow({})),
};
/** The case's child tables, in delete order (a grandchild before its parent; the links included). */
const CASE_CHILDREN = ['case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_decision_drafts', 'case_transaction_handoffs', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals', 'case_budget_scenarios'];
const LINK_TABLES = ['case_request_links', 'case_trial_links'];
const PARENT = { recruitmentCases: 'recruitment_cases', roomComments: 'room_comments', roomSnapshots: 'room_snapshots', roomDecisions: 'room_decisions', roomEvidenceState: 'room_evidence_states' };
const ROOM_CHILDREN = { room_comments: [['room_comment_mentions', 'comment_id']], room_snapshots: [['room_snapshot_source_refs', 'snapshot_id']], room_decisions: [['room_decision_reason_codes', 'decision_id'], ['room_decision_evidence_refs', 'decision_id'], ['room_decision_assessment_ids', 'decision_id']], room_evidence_states: [] };

// ------------------------------------------------------------------ statements and the record readers
const stmtCache = new WeakMap();
function statements(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table, { upsert = false } = {}) => {
    const cols = COLS[table];
    const tail = upsert ? ` ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}` : '';
    return sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${tail}`);
  };
  const byCase = (t, order = 'position') => sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ?${order ? ` ORDER BY ${order}` : ''}`);
  s = {
    ins: Object.fromEntries(Object.keys(COLS).map((t) => [t, insert(t, { upsert: Object.values(PARENT).includes(t) })])),
    caseChildDel: Object.fromEntries(CASE_CHILDREN.map((t) => [t, sqlite.prepare(`DELETE FROM ${t} WHERE case_id = ?`)])),
    roomChildDel: Object.fromEntries(Object.values(ROOM_CHILDREN).flat().map(([t, col]) => [t, sqlite.prepare(`DELETE FROM ${t} WHERE ${col} = ?`)])),
    del: Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(`DELETE FROM ${t} WHERE id = ?`)])),
    byId: Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} WHERE id = ?`)])),
    all: Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`)])),
    of: Object.fromEntries(['case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_budget_scenarios'].map((t) => [t, byCase(t)])),
    draftOf: byCase('case_decision_drafts', null), handoffOf: byCase('case_transaction_handoffs', null),
    scenarioChild: Object.fromEntries(['case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals'].map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ? AND scenario_id = ? ORDER BY position`)])),
    mentionsOf: sqlite.prepare('SELECT user_id FROM room_comment_mentions WHERE comment_id = ? ORDER BY position'),
    sourceRefsOf: sqlite.prepare('SELECT kind, ref_id FROM room_snapshot_source_refs WHERE snapshot_id = ? ORDER BY kind, position'),
    decisionChild: Object.fromEntries(['room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids'].map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} WHERE decision_id = ? ORDER BY position`)])),
    org: sqlite.prepare('SELECT 1 FROM orgs WHERE id = ?'), user: sqlite.prepare('SELECT 1 FROM org_users WHERE id = ?'),
    request: sqlite.prepare('SELECT 1 FROM recruitment_requests WHERE id = ?'), trial: sqlite.prepare('SELECT 1 FROM trials WHERE id = ?'),
    ids: (table) => sqlite.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all().map((r) => r.id),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

/**
 * The statements `decodeCase` reads children through, answered for many cases at once (§4.3 step 4): one query per
 * child table for the whole list (in chunks of ids), grouped by case, instead of about sixteen queries a case. The
 * rows and their order are the per-case statements' own, so a batch decode is the same record.
 */
function batchStatements(sqlite, st, ids) {
  const rows = (t, subKey = []) => childRowsOf(sqlite, t, 'case_id', ids, { order: 'position', subKey });
  const first = (t) => { const m = childRowsOf(sqlite, t, 'case_id', ids); return { get: (id) => m.all(id)[0] }; };
  return {
    ...st,
    of: Object.fromEntries(Object.keys(st.of).map((t) => [t, rows(t)])),
    draftOf: first('case_decision_drafts'), handoffOf: first('case_transaction_handoffs'),
    scenarioChild: Object.fromEntries(Object.keys(st.scenarioChild).map((t) => [t, rows(t, ['scenario_id'])])),
  };
}

/** The same for a list of decisions: their child rows, the snapshots they name and those snapshots' source references. */
function batchDecisionStatements(sqlite, st, rows) {
  const ids = rows.map((r) => r.id);
  const snapshotIds = rows.map((r) => r.snapshot_id).filter((x) => x !== null);
  const snapshots = childRowsOf(sqlite, 'room_snapshots', 'id', snapshotIds);
  return {
    ...st,
    decisionChild: Object.fromEntries(Object.keys(st.decisionChild).map((t) => [t, childRowsOf(sqlite, t, 'decision_id', ids, { order: 'position' })])),
    byId: { ...st.byId, room_snapshots: { get: (id) => snapshots.all(id)[0] } },
    sourceRefsOf: childRowsOf(sqlite, 'room_snapshot_source_refs', 'snapshot_id', snapshotIds, { order: 'kind, position' }),
  };
}

/** Write a typed case whole: the row upserted (its rowid, and so its place in the mirror, kept), every child replaced. `links: false` leaves the link rows to `writeCaseLinks` (the snapshot path writes them after the requests and trials). */
function writeCase(st, c, { links = true } = {}) {
  st.ins.recruitment_cases.run(caseRow(c));
  for (const t of CASE_CHILDREN) if (links || !LINK_TABLES.includes(t)) st.caseChildDel[t].run(c.id);
  const I = st.ins; const id = c.id;
  (c.room?.tags ?? []).forEach((tag, i) => I.case_room_tags.run({ case_id: id, position: i, tag }));
  c.assignments.forEach((a, i) => I.case_assignments.run({ case_id: id, position: i, id: a.id, user_id: a.userId, user_name: a.name, task: a.task, ...dueRow('due', a.dueAt), status: a.status, created_at: a.createdAt }));
  c.tasks.forEach((t, i) => I.case_tasks.run({ case_id: id, position: i, id: t.id, title: t.title, description: t.description, ...dueRow('due', t.dueAt), assignee_user_id: t.assigneeUserId, assignee_name: t.assigneeName, status: t.status, linked_resource_type: t.linkedResourceType, linked_resource_id: t.linkedResourceId, ...personRow('created_by', t.createdBy), created_at: t.createdAt, completed_at: t.completedAt, completed_by_name: t.completedBy }));
  c.approvals.forEach((a, i) => I.case_approvals.run({ case_id: id, position: i, id: a.id, decision_outcome: a.decision.outcome, decision_reasons: a.decision.reasons, ...personRow('requested_by', a.requestedBy), status: a.status, requested_at: a.requestedAt, resolved_by_user_id: a.resolvedBy?.userId ?? null, resolved_by_name: a.resolvedBy?.name ?? null, resolved_at: a.resolvedBy?.at ?? null }));
  c.history.forEach((h, i) => I.case_history.run({ case_id: id, position: i, id: h.id, at: h.at, action: h.action, by_kind: h.byKind, by_id: h.byId, by_name: h.byName, detail_text: isStr(h.detail) ? h.detail : null, detail_json: isPlainObject(h.detail) ? JSON.stringify(h.detail) : null }));
  if (links) writeCaseLinks(st, c);
  if (c.decisionDraft) {
    const d = c.decisionDraft; I.case_decision_drafts.run(draftRow(id, d));
    d.reasonCodes.forEach((code, i) => I.case_decision_draft_reason_codes.run({ case_id: id, position: i, code }));
    d.evidenceRefs.forEach((r, i) => I.case_decision_draft_evidence_refs.run({ case_id: id, position: i, kind: r.kind, ref_id: r.id, meta_json: r.meta === null ? null : JSON.stringify(r.meta) }));
  }
  if (c.transactionHandoff) I.case_transaction_handoffs.run(handoffRow(id, c.transactionHandoff));
  (c.budget?.scenarios ?? []).forEach((s, i) => {
    I.case_budget_scenarios.run({ case_id: id, position: i, id: s.id, version: s.version, label: s.label, currency: s.currency, term_months: s.termMonths, created_by_name: s.createdBy, created_at: s.createdAt, updated_at: s.updatedAt, approval_by_name: s.approval?.by ?? null, approval_by_user_id: s.approval?.byUserId ?? null, approval_at: s.approval?.at ?? null, approval_version: s.approval?.version ?? null, approval_superseded: b(s.approval?.superseded) });
    s.lines.forEach((l, j) => I.case_budget_lines.run({ case_id: id, scenario_id: s.id, position: j, id: l.id, kind: l.kind, label: l.label, amount_minor: l.amountMinor, currency: l.currency, schedule: l.schedule, confirmed: b(l.confirmed), conditional_assumption: l.conditional?.assumption ?? null }));
    s.fxAssumptions.forEach((a, j) => I.case_budget_fx_assumptions.run({ case_id: id, scenario_id: s.id, position: j, from_currency: a.from, to_currency: a.to, rate: a.rate, source: a.source, date: a.date, manual: b(a.manual) }));
    s.actuals.forEach((a, j) => I.case_budget_actuals.run({ case_id: id, scenario_id: s.id, position: j, id: a.id, line_id: a.lineId, amount_minor: a.amountMinor, at: a.at, recorded_by_name: a.recordedBy }));
  });
}
function writeCaseLinks(st, c) {
  for (const t of LINK_TABLES) st.caseChildDel[t].run(c.id);
  c.links.requestIds.forEach((r, i) => st.ins.case_request_links.run({ case_id: c.id, position: i, request_id: r }));
  c.links.trialIds.forEach((t, i) => st.ins.case_trial_links.run({ case_id: c.id, position: i, trial_id: t }));
}
function writeRoomRow(st, name, r) {
  const table = PARENT[name];
  for (const [t] of ROOM_CHILDREN[table]) st.roomChildDel[t].run(r.id);
  if (name === 'roomComments') { st.ins.room_comments.run(commentRow(r)); r.mentions.forEach((u, i) => st.ins.room_comment_mentions.run({ comment_id: r.id, position: i, user_id: u })); return; }
  if (name === 'roomSnapshots') {
    st.ins.room_snapshots.run(snapshotRow(r));
    for (const [kind, key] of [['evidence', 'evidenceIds'], ['assessment', 'assessmentIds'], ['combine', 'combineResults'], ['trial', 'trialIds']]) r.sourceRefs[key].forEach((ref, i) => st.ins.room_snapshot_source_refs.run({ snapshot_id: r.id, kind, position: i, ref_id: ref }));
    return;
  }
  if (name === 'roomDecisions') {
    st.ins.room_decisions.run(decisionRow(r));
    r.reasonCodes.forEach((code, i) => st.ins.room_decision_reason_codes.run({ decision_id: r.id, position: i, code }));
    r.evidenceRefs.forEach((e, i) => st.ins.room_decision_evidence_refs.run({ decision_id: r.id, position: i, kind: e.kind, ref_id: e.id, meta_json: e.meta === null ? null : JSON.stringify(e.meta) }));
    (r.assessmentSummary?.assessmentIds ?? []).forEach((a, i) => st.ins.room_decision_assessment_ids.run({ decision_id: r.id, position: i, assessment_id: a }));
    return;
  }
  st.ins.room_evidence_states.run(evidenceRow(r));
}
function deleteRoomRow(st, name, id) { const table = PARENT[name]; for (const [t] of ROOM_CHILDREN[table]) st.roomChildDel[t].run(id); st.del[table].run(id); }
function deleteCase(st, id) { for (const t of CASE_CHILDREN) st.caseChildDel[t].run(id); st.del.recruitment_cases.run(id); }

const historyOut = (h) => ({ id: h.id, at: h.at, byKind: h.by_kind, byId: h.by_id, byName: h.by_name, action: h.action, detail: h.detail_json !== null ? JSON.parse(h.detail_json) : h.detail_text });
function decodeCase(st, row) {
  const id = row.id; const O = st.of;
  const dr = st.draftOf.get(id); const ho = st.handoffOf.get(id);
  const scenarios = O.case_budget_scenarios.all(id).map((s) => ({
    id: s.id, version: s.version, label: s.label, currency: s.currency, termMonths: s.term_months,
    lines: st.scenarioChild.case_budget_lines.all(id, s.id).map((l) => ({ id: l.id, kind: l.kind, label: l.label, amountMinor: l.amount_minor, currency: l.currency, schedule: l.schedule, confirmed: l.confirmed === 1, conditional: l.conditional_assumption === null ? null : { assumption: l.conditional_assumption } })),
    fxAssumptions: st.scenarioChild.case_budget_fx_assumptions.all(id, s.id).map((a) => ({ from: a.from_currency, to: a.to_currency, rate: a.rate, source: a.source, date: a.date, manual: a.manual === 1 })),
    approval: s.approval_at === null ? null : { by: s.approval_by_name, byUserId: s.approval_by_user_id, at: s.approval_at, version: s.approval_version, superseded: s.approval_superseded === 1 },
    actuals: st.scenarioChild.case_budget_actuals.all(id, s.id).map((a) => ({ id: a.id, lineId: a.line_id, amountMinor: a.amount_minor, at: a.at, recordedBy: a.recorded_by_name })),
    createdBy: s.created_by_name, createdAt: s.created_at, updatedAt: s.updated_at,
  }));
  const room = row.room_status === null ? null : {
    status: row.room_status, priority: row.room_priority, tags: O.case_room_tags.all(id).map((t) => t.tag), leadScoutUserId: row.room_lead_scout_user_id, sourceContext: row.room_source_context,
    sourceRef: row.room_source_ref_id === null ? null : { id: row.room_source_ref_id, version: row.room_source_ref_version }, openedBy: personOut(row, 'room_opened_by'),
    updatedAt: row.room_updated_at, archivedAt: row.room_archived_at, closedAt: row.room_closed_at, rev: row.room_rev, revAt: row.room_rev_at, revBy: personOut(row, 'room_rev_by'),
    reopened: row.room_reopened_at === null ? null : { by: personOut(row, 'room_reopened_by'), at: row.room_reopened_at, from: row.room_reopened_from, reasonCodes: JSON.parse(row.room_reopened_reason_codes_json), sourceContext: row.room_reopened_source_context, sourceRef: row.room_reopened_source_ref_id === null ? null : { id: row.room_reopened_source_ref_id, version: row.room_reopened_source_ref_version } },
  };
  return {
    id, orgId: row.org_id, playerId: row.player_id, playerName: row.player_name, vacancyId: row.vacancy_id, ownerUserId: row.owner_user_id, ownerName: row.owner_name,
    stage: row.stage, priority: row.priority, deadline: dueOut(row, 'deadline'), restricted: row.restricted === 1,
    assignments: O.case_assignments.all(id).map((a) => ({ id: a.id, userId: a.user_id, name: a.user_name, task: a.task, dueAt: dueOut(a, 'due'), status: a.status, createdAt: a.created_at })),
    tasks: O.case_tasks.all(id).map((t) => ({ id: t.id, title: t.title, description: t.description, dueAt: dueOut(t, 'due'), assigneeUserId: t.assignee_user_id, assigneeName: t.assignee_name, status: t.status, linkedResourceType: t.linked_resource_type, linkedResourceId: t.linked_resource_id, createdBy: personOut(t, 'created_by'), createdAt: t.created_at, completedAt: t.completed_at, completedBy: t.completed_by_name })),
    approvals: O.case_approvals.all(id).map((a) => ({ id: a.id, decision: { outcome: a.decision_outcome, reasons: a.decision_reasons }, requestedBy: personOut(a, 'requested_by'), status: a.status, requestedAt: a.requested_at, resolvedBy: a.resolved_at === null ? null : { userId: a.resolved_by_user_id, name: a.resolved_by_name, at: a.resolved_at } })),
    decision: row.decision_at === null ? null : { outcome: row.decision_outcome, reasons: row.decision_reasons, byUserId: row.decision_by_user_id, byName: row.decision_by_name, approvedBy: row.decision_approved_by_name, at: row.decision_at },
    links: { requestIds: O.case_request_links.all(id).map((r) => r.request_id), trialIds: O.case_trial_links.all(id).map((r) => r.trial_id), signingId: row.links_signing_id },
    createdAt: row.created_at,
    history: O.case_history.all(id).map(historyOut),
    room,
    decisionDraft: !dr ? null : { id: dr.id, outcome: dr.outcome, reasonCodes: O.case_decision_draft_reason_codes.all(id).map((r) => r.code), note: dr.note, evidenceRefs: O.case_decision_draft_evidence_refs.all(id).map((r) => ({ kind: r.kind, id: r.ref_id, meta: jsonOut(r.meta_json) })), by: personOut(dr, 'by', ['role']), createdAt: dr.created_at, updatedAt: dr.updated_at, updatedBy: personOut(dr, 'updated_by', ['role']), rev: dr.rev, revAt: dr.rev_at, keys: { create: dr.create_key === null ? null : { key: dr.create_key, fp: dr.create_fp } } },
    transactionHandoff: !ho ? null : { id: ho.id, caseId: id, orgId: ho.org_id, playerId: ho.player_id, status: ho.status, invitedAt: ho.invited_at, invitedBy: ho.invited_by_user_id === null && ho.invited_by_name === null ? null : { kind: 'org', userId: ho.invited_by_user_id, name: ho.invited_by_name }, acceptedAt: ho.accepted_at, withdrawnAt: ho.withdrawn_at, transactionId: ho.transaction_id, representedAtInvitation: ho.represented_at_invitation === 1, invitedAgencyOrgId: ho.invited_agency_org_id, invitedAgentUserId: ho.invited_agent_user_id, keys: { invite: ho.invite_key === null ? null : { key: ho.invite_key } }, rev: ho.rev, revAt: ho.rev_at },
    budget: scenarios.length ? { scenarios } : null,
    subjectRemovedAt: row.subject_removed_at,
  };
}
const decodeComment = (st, r) => ({ id: r.id, roomId: r.room_id, orgId: r.org_id, authorId: r.author_user_id, authorName: r.author_name, body: r.body, replyToId: r.reply_to_id, mentions: st.mentionsOf.all(r.id).map((m) => m.user_id), createdAt: r.created_at, editedAt: r.edited_at, editCount: r.edit_count, deletedAt: r.deleted_at, deletedBy: personOut(r, 'deleted_by') });
function decodeSnapshot(st, r) {
  const refs = { evidence: [], assessment: [], combine: [], trial: [] };
  for (const x of st.sourceRefsOf.all(r.id)) refs[x.kind].push(x.ref_id);
  return { id: r.id, roomId: r.room_id, orgId: r.org_id, playerId: r.player_id, at: r.at, trigger: r.trigger, trust: r.trust_hash === null ? null : { score: r.trust_score, band: r.trust_band, policyVersion: r.trust_policy_version, componentLevels: JSON.parse(r.trust_component_levels_json), hash: r.trust_hash }, sourceRefs: { passportVersion: r.source_passport_version, passportRevision: r.source_passport_revision, evidenceIds: refs.evidence, assessmentIds: refs.assessment, combineResults: refs.combine, trialIds: refs.trial }, note: r.note };
}
function decodeDecision(st, r) {
  const C = st.decisionChild;
  const snapRow = r.snapshot_id === null ? null : st.byId.room_snapshots.get(r.snapshot_id);
  const snap = snapRow ? decodeSnapshot(st, snapRow) : null;
  return {
    id: r.id, roomId: r.room_id, orgId: r.org_id, playerId: r.player_id, kind: r.kind, state: r.state, outcome: r.outcome, recommendation: r.recommendation,
    reasonCodes: C.room_decision_reason_codes.all(r.id).map((x) => x.code), note: r.note, by: personOut(r, 'by', ['role']), createdAt: r.created_at, finalizedAt: r.finalized_at, trigger: r.trigger, clientKey: r.client_key,
    supersedes: r.supersedes_id, supersededById: r.superseded_by_id, supersession: r.supersession_of_id === null ? null : { of: r.supersession_of_id, reason: r.supersession_reason },
    rev: r.rev, revAt: r.rev_at, evidenceRefs: C.room_decision_evidence_refs.all(r.id).map((x) => ({ kind: x.kind, id: x.ref_id, meta: jsonOut(x.meta_json) })),
    assessmentSummary: r.assessments_submitted === null ? null : { submitted: r.assessments_submitted, withheld: r.assessments_withheld, verdicts: JSON.parse(r.assessment_verdicts_json), assessmentIds: C.room_decision_assessment_ids.all(r.id).map((x) => x.assessment_id) },
    snapshot: snap ? { at: snap.at, trust: snap.trust, sourceRefs: snap.sourceRefs, snapshotId: snap.id } : null,
    keys: { finalize: r.finalize_key === null ? null : { key: r.finalize_key, fp: r.finalize_fp }, draft: r.draft_key === null ? null : { key: r.draft_key, fp: r.draft_fp } },
    draftId: r.draft_id,
    lifecycle: r.lifecycle_applied === null ? null : { action: r.lifecycle_action, from: r.lifecycle_from, to: r.lifecycle_to, applied: r.lifecycle_applied === 1, reason: r.lifecycle_reason, at: r.lifecycle_at },
    policyVersion: r.policy_version,
  };
}
const decodeEvidence = (_st, r) => ({ id: r.id, roomId: r.room_id, orgId: r.org_id, evidenceId: r.evidence_id, state: r.state, note: r.note, byId: r.by_user_id, byName: r.by_name, at: r.at });
const DECODERS = { recruitmentCases: decodeCase, roomComments: decodeComment, roomSnapshots: decodeSnapshot, roomDecisions: decodeDecision, roomEvidenceState: decodeEvidence };
const readAll = (sqlite, name) => {
  const st = statements(sqlite); const rows = st.all[PARENT[name]].all();
  const via = name === 'recruitmentCases' && rows.length > 1 ? batchStatements(sqlite, st, rows.map((r) => r.id)) : st;
  return rows.map((r) => DECODERS[name](via, r));
};
export const readCases = (sqlite) => readAll(sqlite, 'recruitmentCases');
export const readRoomComments = (sqlite) => readAll(sqlite, 'roomComments');
export const readRoomSnapshots = (sqlite) => readAll(sqlite, 'roomSnapshots');
export const readRoomDecisions = (sqlite) => readAll(sqlite, 'roomDecisions');
export const readRoomEvidenceStates = (sqlite) => readAll(sqlite, 'roomEvidenceState');

// ------------------------------------------------------------------ references, judged in code so a refusal names ids
/** The cross-record rules no key can state: a decision's snapshot and its chain stay inside its room. */
function decisionRefsProblems(d, { decisionRoom, snapshotRoom }) {
  const out = [];
  if (d.snapshot && snapshotRoom(d.snapshot.snapshotId) !== d.roomId) out.push(`room_decisions ${d.id} names snapshot ${d.snapshot.snapshotId}, which is not a snapshot of room ${d.roomId}`);
  for (const [k, v] of [['supersedes', d.supersedes], ['supersededById', d.supersededById]]) {
    if (v === null) continue;
    const room = decisionRoom(v);
    if (room === undefined) out.push(`room_decisions ${d.id} (room ${d.roomId}) names ${v} (${k}): no such decision`);
    else if (room !== d.roomId) out.push(`room_decisions ${d.id} (room ${d.roomId}) names ${v} (${k}) of room ${room}`);
  }
  return out;
}
/** The organisation, staff, request and trial each record names (RESTRICT keys), named with ids before the engine would refuse anonymously. */
function referenceProblems(st, name, r) {
  const out = [];
  const table = PARENT[name];
  if (!st.org.get(r.orgId)) out.push(`${table} ${r.id} → orgs ${r.orgId}`);
  const users = name === 'recruitmentCases' ? [r.ownerUserId, r.room?.leadScoutUserId, r.decision?.byUserId, ...r.assignments.map((a) => a.userId)] : name === 'roomComments' ? [r.authorId] : [];
  for (const u of users) if (u && !st.user.get(u)) out.push(`${table} ${r.id} → org_users ${u}`);
  if (name === 'recruitmentCases') {
    if (r.transactionHandoff && !st.org.get(r.transactionHandoff.orgId)) out.push(`case_transaction_handoffs ${r.id} → orgs ${r.transactionHandoff.orgId}`);
    for (const q of r.links.requestIds) if (!st.request.get(q)) out.push(`case_request_links ${r.id} → recruitment_requests ${q}`);
    for (const t of r.links.trialIds) if (!st.trial.get(t)) out.push(`case_trial_links ${r.id} → trials ${t}`);
  }
  return out;
}
/** Every table outside the case's own whose foreign key names recruitment_cases (requests, trials, contacts, offers, signings, the room rows). */
function caseDependants(sqlite) {
  const out = [];
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (CASE_TABLES.includes(name)) continue;
    for (const fk of sqlite.prepare(`PRAGMA foreign_key_list(${name})`).all()) if (fk.table === 'recruitment_cases') out.push([name, fk.from]);
  }
  return out;
}

/** The counts of the admin report: rows naming a player that is not in the players table, and rows naming a retained record (Q8a: counted, never refused). */
const PLAYER_COUNT_TABLES = { recruitmentCases: 'recruitment_cases', roomSnapshots: 'room_snapshots', roomDecisions: 'room_decisions', caseTransactionHandoffs: 'case_transaction_handoffs' };
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [k, sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [k, sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id AND p.deleted_at IS NOT NULL)`).get().n]));
}

/** The final state of the case graph, ids only: the decision chain and snapshots inside their room, every key. */
export function assertCasesConsistent(sqlite, { label = 'the snapshot' } = {}) {
  if (!recruitmentCasesLive(sqlite)) return;
  const rooms = new Map(sqlite.prepare('SELECT id, room_id FROM room_decisions').all().map((r) => [r.id, r.room_id]));
  const snaps = new Map(sqlite.prepare('SELECT id, room_id FROM room_snapshots').all().map((r) => [r.id, r.room_id]));
  const problems = [];
  for (const r of sqlite.prepare('SELECT id, room_id, supersedes_id, superseded_by_id, snapshot_id FROM room_decisions').all()) {
    problems.push(...decisionRefsProblems({ id: r.id, roomId: r.room_id, supersedes: r.supersedes_id, supersededById: r.superseded_by_id, snapshot: r.snapshot_id === null ? null : { snapshotId: r.snapshot_id } }, { decisionRoom: (x) => rooms.get(x), snapshotRoom: (x) => snaps.get(x) }));
  }
  if (problems.length) throw refusal('DECISION_CHAIN_BROKEN', `${label}: ${problems.length} decision reference(s) leave their room (${ids(problems)}); the write was rolled back`);
  const broken = RECRUITMENT_CASES_TABLES.flatMap((t) => sqlite.prepare(`PRAGMA foreign_key_check(${t})`).all());
  if (broken.length) throw refusal('RECRUITMENT_CASES_KEY_VIOLATION', `${label}: foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent}); the write was rolled back`);
}

// ------------------------------------------------------------------ the snapshot path (tools, fixtures, the persistence suites)
/**
 * `begin` types the supplied collections (an omitted one is retained whole; an array is the whole final collection),
 * names every reference it can with ids against the FINAL state, and writes the cases (without their link rows) and
 * the room rows; `links` writes the supplied cases' link rows after the requests and trials; `pruneRooms` and
 * `pruneCases` remove what a supplied collection no longer lists, room rows before their case and a case only when
 * nothing retained names it; `assert` checks the final state.
 */
export const RECRUITMENT_CASES_SNAPSHOT = {
  names: RECRUITMENT_CASES_COLLECTIONS,
  read(sqlite) { if (!recruitmentCasesLive(sqlite)) return null; return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, readAll(sqlite, n)])); },
  begin(sqlite, db, { requests, trials, label = 'the snapshot' } = {}) {
    if (!recruitmentCasesLive(sqlite)) return null;
    const supplied = {};
    for (const name of RECRUITMENT_CASES_COLLECTIONS) {
      const value = Object.hasOwn(db, name) ? db[name] : undefined;
      if (value === undefined) continue;
      if (!Array.isArray(value)) throw refusal('RECRUITMENT_CASES_INPUT_INVALID', `the ${name} collection of ${label} must be an array of records (got ${describe(value)}); nothing was written`);
      const seen = new Set(); const problems = [];
      supplied[name] = value.map((raw, i) => {
        const t = TYPERS[name](raw, `${name} entry #${i}`);
        if (!t.ok) { problems.push(t.reason); return null; }
        if (seen.has(t.record.id)) problems.push(`${name} entry #${i} duplicates the id of an earlier entry (${t.record.id})`);
        seen.add(t.record.id); return t.record;
      });
      // Every entry the typed tables cannot hold is named, not just the first.
      if (problems.length) throw refusal('RECRUITMENT_CASES_INPUT_INVALID', `${label}: ${problems.length} ${name} entr${problems.length === 1 ? 'y' : 'ies'} refused (${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}); nothing was written`);
    }
    const anyS8a = requests !== undefined || trials !== undefined;
    if (!Object.keys(supplied).length && !anyS8a) return null;
    const st = statements(sqlite);
    const finalOf = (name) => supplied[name] ?? readAll(sqlite, name);
    const caseIds = new Set(finalOf('recruitmentCases').map((c) => c.id));
    const problems = [];
    for (const name of ['roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState']) for (const r of supplied[name] ?? []) if (!caseIds.has(r.roomId)) problems.push(`${PARENT[name]} ${r.id} → case ${r.roomId}`);
    if (problems.length) throw refusal('ROOM_CASE_MISSING', `${label}: ${problems.length} room row(s) name a case that is not in the final recruitmentCases collection (${ids(problems)}); the write was rolled back and nothing was changed`);
    // A case link names a final request or trial (the supplied S8a collections, the rows otherwise).
    const reqIds = new Set(requests !== undefined ? requests.filter(isPlainObject).map((r) => r.id) : st.ids('recruitment_requests'));
    const trialIds = new Set(trials !== undefined ? trials.filter(isPlainObject).map((t) => t.id) : st.ids('trials'));
    for (const c of finalOf('recruitmentCases')) { for (const r of c.links.requestIds) if (!reqIds.has(r)) problems.push(`case ${c.id} links request ${r}`); for (const t of c.links.trialIds) if (!trialIds.has(t)) problems.push(`case ${c.id} links trial ${t}`); }
    if (problems.length) throw refusal('CASE_LINK_DANGLING', `${label}: ${problems.length} case link(s) name a request or trial that is not in the final collections (${ids(problems)}); the write was rolled back and nothing was changed`);
    // The decision chain and snapshots against the FINAL room rows.
    const finalDecisions = finalOf('roomDecisions');
    const snapshotRoom = new Map(finalOf('roomSnapshots').map((s) => [s.id, s.roomId]));
    const decisionRoom = new Map(finalDecisions.map((d) => [d.id, d.roomId]));
    for (const d of finalDecisions) problems.push(...decisionRefsProblems(d, { decisionRoom: (x) => decisionRoom.get(x), snapshotRoom: (x) => snapshotRoom.get(x) }));
    if (problems.length) throw refusal('DECISION_CHAIN_BROKEN', `${label}: ${problems.length} decision reference(s) leave their room (${ids(problems)}); the write was rolled back and nothing was changed`);
    for (const c of supplied.recruitmentCases ?? []) writeCase(st, c, { links: false });
    for (const name of ['roomSnapshots', 'roomComments', 'roomDecisions', 'roomEvidenceState']) for (const r of supplied[name] ?? []) writeRoomRow(st, name, r);
    const gone = Object.fromEntries(Object.keys(supplied).map((name) => { const keep = new Set(supplied[name].map((r) => r.id)); return [name, st.ids(PARENT[name]).filter((id) => !keep.has(id))]; }));
    return { supplied, gone, written: Object.keys(supplied) };
  },
  links(sqlite, plan) { if (!plan) return; const st = statements(sqlite); for (const c of plan.supplied.recruitmentCases ?? []) writeCaseLinks(st, c); },
  pruneRooms(sqlite, plan) {
    if (!plan) return;
    const st = statements(sqlite);
    for (const name of ['roomEvidenceState', 'roomComments', 'roomDecisions', 'roomSnapshots']) for (const id of plan.gone[name] ?? []) {
      try { deleteRoomRow(st, name, id); } catch (e) { throw refusal('ROOM_ROW_STILL_REFERENCED', `${PARENT[name]} ${id} is no longer listed but a retained row still names it (${e.message}); the write was rolled back`); }
    }
  },
  pruneCases(sqlite, plan, { label = 'the snapshot' } = {}) {
    if (!plan || !plan.gone.recruitmentCases?.length) return;
    const st = statements(sqlite);
    const departing = plan.gone.recruitmentCases;
    const held = [];
    for (const [table, col] of caseDependants(sqlite)) {
      for (const r of sqlite.prepare(`SELECT ${col} AS c FROM ${table} WHERE ${col} IN (${departing.map(() => '?').join(', ')})`).all(...departing)) held.push(`${table} → case ${r.c}`);
    }
    if (held.length) throw refusal('CASE_STILL_REFERENCED', `${label}: ${held.length} retained row(s) name a case this write removes (${ids(held)}); the write was rolled back and nothing was changed — remove the rows with their case in the same snapshot, or keep the case`);
    for (const id of departing) deleteCase(st, id);
  },
  assert(sqlite, { label } = {}) { assertCasesConsistent(sqlite, { label }); },
};

// ------------------------------------------------------------------ the repository (explicit writes; SQL reads)
const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
/**
 * `createRecruitmentCasesRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work (a
 * failure poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and
 * returns the record read back from the tables.
 *
 * READS ARE SQL (§4.3 step 2): no mirror and no db.recruitmentCases / db.roomComments / db.roomSnapshots /
 * db.roomDecisions / db.roomEvidenceState (each throws). Every query decodes fresh, deep-frozen records in insertion
 * (rowid) order and runs on the one connection, so a read inside a unit of work sees the unit's own writes.
 */
export function createRecruitmentCasesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the recruitment-cases repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const decode = (name, row) => deepFreeze(DECODERS[name](st, row));
  const find = (name, id) => { if (typeof id !== 'string') return null; const row = st.byId[PARENT[name]].get(id); return row ? decode(name, row) : null; };
  const exists = (name, id) => typeof id === 'string' && !!st.byId[PARENT[name]].get(id);
  /** Decode many rows; a list of cases or decisions reads its children in one batch (batchStatements, batchDecisionStatements). */
  const decodeAll = (name, rows) => {
    if (rows.length < 2 || (name !== 'recruitmentCases' && name !== 'roomDecisions')) return rows.map((r) => decode(name, r));
    if (name === 'roomDecisions') { const bst = batchDecisionStatements(sqlite, st, rows); return rows.map((r) => deepFreeze(decodeDecision(bst, r))); }
    const bst = batchStatements(sqlite, st, rows.map((r) => r.id));
    return rows.map((r) => deepFreeze(decodeCase(bst, r)));
  };
  /** The records whose `col` is any of `values`, in insertion order, decoded in one batch. */
  const inList = (name, col) => (values) => { const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))]; if (!want.length) return []; return decodeAll(name, sqlite.prepare(`SELECT * FROM ${PARENT[name]} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`).all(...want)); };
  const list = (name, sql) => { const stmt = sqlite.prepare(sql); return (...args) => decodeAll(name, stmt.all(...args)); };
  const count = (sql) => { const stmt = sqlite.prepare(sql); return (...args) => stmt.get(...args).n; };
  const typedOr = (name, raw) => { const t = TYPERS[name](raw, name); if (!t.ok) throw refusal('RECRUITMENT_CASES_INPUT_INVALID', t.reason); return t.record; };
  const IMMUTABLE = { recruitmentCases: ['id', 'orgId', 'playerId', 'createdAt'], roomComments: ['id', 'roomId', 'orgId', 'authorId', 'createdAt'], roomSnapshots: ['id', 'roomId'], roomDecisions: ['id', 'roomId', 'orgId', 'playerId', 'createdAt'], roomEvidenceState: ['id', 'roomId', 'orgId', 'evidenceId'] };
  const check = (name, r) => {
    const problems = referenceProblems(st, name, r);
    let code = 'RECRUITMENT_CASES_REFERENCE_MISSING';
    if (name !== 'recruitmentCases' && !exists('recruitmentCases', r.roomId)) { problems.push(`${PARENT[name]} ${r.id} → case ${r.roomId}`); code = 'ROOM_CASE_MISSING'; }
    if (name === 'roomDecisions') {
      const chain = decisionRefsProblems(r, { decisionRoom: (x) => (x === r.id ? r.roomId : find('roomDecisions', x)?.roomId), snapshotRoom: (x) => find('roomSnapshots', x)?.roomId });
      if (chain.length) { problems.push(...chain); code = 'DECISION_CHAIN_BROKEN'; }
    }
    if (name === 'roomEvidenceState' && sqlite.prepare('SELECT 1 FROM room_evidence_states WHERE room_id = ? AND evidence_id = ? AND id <> ?').get(r.roomId, r.evidenceId, r.id)) problems.push(`room_evidence_states ${r.id}: room ${r.roomId} already reviews evidence ${r.evidenceId}`);
    if (problems.length) throw refusal(code, `${PARENT[name]} ${r.id}: ${ids(problems)}`);
  };
  const write = (name, r) => { check(name, r); if (name === 'recruitmentCases') writeCase(st, r); else writeRoomRow(st, name, r); };
  const editing = new Set();

  /** `create(record)`: a new record, typed whole; an existing id is refused. */
  const create = (name) => (raw) => operation(() => {
    const r = typedOr(name, raw);
    if (exists(name, r.id)) throw refusal('RECRUITMENT_CASES_DUPLICATE', `${PARENT[name]} ${r.id} already exists`);
    write(name, r); return find(name, r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a replacement);
   * the result is typed whole and written at once. The identifiers and the creation instant cannot change.
   */
  const update = (name) => (id, change) => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const key = `${name}:${id}`;
    if (editing.has(key)) throw new Error(`${PARENT[name]} ${id} is already being updated: an update inside its own update would be overwritten by the outer one; make the second change after the first returns`);
    const before = find(name, id);
    if (!before) throw refusal('RECRUITMENT_CASES_NOT_FOUND', `${PARENT[name]} ${id} is not a record of the repository`);
    editing.add(key);
    let returned; const draft = clone(before);
    try { returned = change(draft); } finally { editing.delete(key); }
    const next = typedOr(name, returned === undefined ? draft : returned);
    for (const k of IMMUTABLE[name]) if (next[k] !== before[k]) throw refusal('RECRUITMENT_CASES_INPUT_INVALID', `${PARENT[name]} ${id}: ${k} cannot change`);
    write(name, next); return find(name, id);
  });
  const ops = (name, { updatable = true } = {}) => ({ create: create(name), ...(updatable ? { update: update(name) } : {}), byId: (id) => find(name, id) });
  const forRoom = (name) => list(name, `SELECT * FROM ${PARENT[name]} WHERE room_id = ? ORDER BY rowid`);

  const cases = {
    ...ops('recruitmentCases'),
    forOrg: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE org_id = ? ORDER BY rowid'),
    forPlayer: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE player_id = ? ORDER BY rowid'),
    forOrgPlayer: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    /** The cases whose transaction handoff invites this agent (any organisation). */
    forHandoffAgent: list('recruitmentCases', 'SELECT c.* FROM recruitment_cases c JOIN case_transaction_handoffs h ON h.case_id = c.id WHERE h.invited_agent_user_id = ? ORDER BY c.rowid'),
    countForOrg: count('SELECT COUNT(*) AS n FROM recruitment_cases WHERE org_id = ?'),
    /** Every case that has a Room (the boot integrity report reads them once). */
    withRoom: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE room_status IS NOT NULL ORDER BY rowid'),
    roomCount: count('SELECT COUNT(*) AS n FROM recruitment_cases WHERE room_status IS NOT NULL'),
    /** Room statuses of the organisation's Rooms, counted: `{ status: n }`; with a viewer, only the Rooms they may open. */
    roomStatusCounts(orgId, viewer = null) {
      const a = viewer ? access(viewer, { room: true }) : { sql: '1', params: [] };
      return Object.fromEntries(sqlite.prepare(`SELECT c.room_status AS status, COUNT(*) AS n FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND ${a.sql} GROUP BY c.room_status`).all(orgId, ...a.params).map((r) => [r.status, r.n]));
    },
    /**
     * The club's cases list (§4.3 step 4): the cases `viewer` may open, optionally at one stage, newest first by
     * cursor ([createdAt, id]), filtered and paged in SQL; only the page is decoded.
     */
    pageForViewer(orgId, viewer, { stage = null } = {}, page) {
      const a = access(viewer, { room: false });
      const where = [`c.org_id = ?`, a.sql, ...(stage === null ? [] : ['c.stage = ?'])];
      return keyset({ where, params: [orgId, ...a.params, ...(stage === null ? [] : [stage])], page, order: 'c.created_at DESC, c.id DESC', after: '(c.created_at < ? OR (c.created_at = ? AND c.id < ?))', rowKey: (r) => [r.created_at, r.id], key: (c) => [c.createdAt, c.id] });
    },
    /**
     * The club's Rooms list (§4.3 step 4): the Rooms `viewer` may open, filtered (`roomFilter`) and paged in SQL by
     * most recent activity ([room.updatedAt, id]); only the page is decoded. `accept(light)` is a filter SQL cannot
     * express (the search, which needs the player's visibility): it sees `{ id, playerId, playerName, status, tags }`
     * and the rows are read in chunks until the page is full.
     */
    roomPageForViewer(orgId, viewer, filter, page, accept = null) {
      const f = roomWhere(viewer, filter);
      return keyset({ where: ['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where], params: [orgId, ...f.params], page, order: 'c.room_updated_at DESC, c.id ASC', after: '(c.room_updated_at < ? OR (c.room_updated_at = ? AND c.id > ?))', rowKey: (r) => [r.room_updated_at, r.id], key: (c) => [c.room.updatedAt, c.id], accept });
    },
    /** The Rooms `viewer` may open, filtered like the list, in insertion order, as light rows `{ id, playerId, playerName, status }` (nothing decoded). */
    roomRowsForViewer(orgId, viewer, filter = {}) {
      const f = roomWhere(viewer, filter);
      return sqlite.prepare(`SELECT c.id, c.player_id, c.player_name, c.room_status FROM recruitment_cases c WHERE ${['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where].join(' AND ')} ORDER BY c.rowid`).all(orgId, ...f.params).map(light);
    },
    /**
     * The history of the organisation's Rooms with one of `actions`, newest first, for a merged feed (the audit feed):
     * `{ caseId, playerId, entry }` with the entry as a case's history holds it. See `newestHistory` for `atMost`/`n`.
     */
    roomHistoryFeed(orgId, actions, atMost, n) {
      return newestHistory(sqlite, { select: 'h.*, c.player_id AS owner_player_id', ...roomHistoryFrom(orgId, actions) }, atMost, n)
        .map((h) => ({ caseId: h.case_id, playerId: h.owner_player_id, entry: historyOut(h) }));
    },
    /** How many entries `roomHistoryFeed` holds in all. */
    roomHistoryCount(orgId, actions) { const f = roomHistoryFrom(orgId, actions); return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params).n; },
    /** Open and in-progress tasks of the organisation's cases due (an instant) before `at`, counted by case: `Map(caseId → n)`. */
    overdueTaskCounts(orgId, at) {
      return new Map(sqlite.prepare("SELECT t.case_id, COUNT(*) AS n FROM case_tasks t JOIN recruitment_cases c ON c.id = t.case_id WHERE c.org_id = ? AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at <> 0 AND t.due_at < ? GROUP BY t.case_id").all(orgId, at).map((r) => [r.case_id, r.n]));
    },
  };
  /**
   * Who may open a case or a Room, as SQL over `recruitment_cases c`: the rule of `caseAccess` (domains/scouting/scouting.mjs) and,
   * for a Room, of `roomRole` (domains/recruitment/rooms/shared.mjs) being non-null. A recruitment lead opens everything.
   */
  function access({ userId, isLead }, { room }) {
    if (isLead) return { sql: '1', params: [] };
    return { sql: `(c.restricted = 0 OR c.owner_user_id = ?${room ? ' OR c.room_lead_scout_user_id = ?' : ''} OR EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ?))`, params: room ? [userId, userId, userId] : [userId, userId] };
  }
  /** The Rooms list's filters as SQL (each optional): statuses, one status, owned or led by, assigned to, a tag, an assignee. */
  function roomWhere(viewer, { statuses = null, status = null, mineOf = null, assignedTo = null, tag = null, assignee = null } = {}) {
    const a = access(viewer, { room: true }); const where = [a.sql]; const params = [...a.params];
    const add = (sql, ...p) => { where.push(sql); params.push(...p); };
    if (statuses) add(statuses.length ? `c.room_status IN (${statuses.map(() => '?').join(', ')})` : '0', ...statuses);
    if (status !== null) add('c.room_status = ?', status);
    if (mineOf !== null) add('(c.owner_user_id = ? OR c.room_lead_scout_user_id = ?)', mineOf, mineOf);
    if (assignedTo !== null) add("(EXISTS (SELECT 1 FROM case_assignments a2 WHERE a2.case_id = c.id AND a2.user_id = ?) OR EXISTS (SELECT 1 FROM case_tasks t WHERE t.case_id = c.id AND t.assignee_user_id = ? AND t.status IN ('open', 'in_progress')))", assignedTo, assignedTo);
    if (tag !== null) add('EXISTS (SELECT 1 FROM case_room_tags g WHERE g.case_id = c.id AND g.tag = ?)', tag);
    if (assignee !== null) add('(EXISTS (SELECT 1 FROM case_tasks t2 WHERE t2.case_id = c.id AND t2.assignee_user_id = ?) OR c.room_lead_scout_user_id = ? OR c.owner_user_id = ?)', assignee, assignee, assignee);
    return { where, params };
  }
  const light = (r) => ({ id: r.id, playerId: r.player_id, playerName: r.player_name, status: r.room_status });
  const roomHistoryFrom = (orgId, actions) => ({ from: 'case_history h JOIN recruitment_cases c ON c.id = h.case_id', where: `c.org_id = ? AND c.room_status IS NOT NULL AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`, params: [orgId, ...actions] });
  /**
   * Keyset paging over `recruitment_cases c`: `limit + 1` rows after the cursor, decoded in one batch. With `accept`,
   * rows are read in chunks and kept only when accepted (with their tags), until the page is full or the rows end.
   */
  function keyset({ where, params, page: { limit, after = null }, order, after: afterSql, rowKey, key, accept = null }) {
    const chunk = accept ? Math.max(limit + 1, 200) : limit + 1;
    const kept = []; let cursor = after;
    for (;;) {
      const sql = `SELECT c.* FROM recruitment_cases c WHERE ${[...where, ...(cursor ? [afterSql] : [])].join(' AND ')} ORDER BY ${order} LIMIT ?`;
      const rows = sqlite.prepare(sql).all(...params, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), chunk);
      let tags = null;
      if (accept && rows.length) { tags = new Map(); for (const t of sqlite.prepare(`SELECT case_id, tag FROM case_room_tags WHERE case_id IN (${rows.map(() => '?').join(',')}) ORDER BY case_id, position`).all(...rows.map((r) => r.id))) { if (!tags.has(t.case_id)) tags.set(t.case_id, []); tags.get(t.case_id).push(t.tag); } }
      for (const r of rows) { if (!accept || accept({ ...light(r), tags: tags.get(r.id) ?? [] })) kept.push(r); if (kept.length > limit) break; }
      if (kept.length > limit || rows.length < chunk) break;
      cursor = rowKey(rows[rows.length - 1]);
    }
    return pageOf(decodeAll('recruitmentCases', kept), limit, key);
  }
  const comments = { ...ops('roomComments'), forRoom: forRoom('roomComments') };
  const snapshots = { ...ops('roomSnapshots', { updatable: false }), forRoom: forRoom('roomSnapshots') };
  const decisions = {
    ...ops('roomDecisions'), forRoom: forRoom('roomDecisions'),
    /** The decisions of several Rooms (a player's journeys), in insertion order. */
    forRooms: inList('roomDecisions', 'room_id'),
    forOrgPlayer: list('roomDecisions', 'SELECT * FROM room_decisions WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    forOrg: list('roomDecisions', 'SELECT * FROM room_decisions WHERE org_id = ? ORDER BY rowid'),
    /** The ids of the organisation's Rooms that hold any decision (a Set; nothing decoded). */
    roomIdsForOrg: (orgId) => new Set(sqlite.prepare('SELECT DISTINCT d.room_id FROM room_decisions d JOIN recruitment_cases c ON c.id = d.room_id WHERE c.org_id = ?').all(orgId).map((r) => r.room_id)),
  };
  const evidenceStates = { ...ops('roomEvidenceState'), forRoom: forRoom('roomEvidenceState') };
  const WRITES = new Set(['create', 'update']);
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${PARENT[n]}`)]));

  return {
    cases, comments, snapshots, decisions, evidenceStates,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({ cases: readOnly(cases), comments: readOnly(comments), snapshots: readOnly(snapshots), decisions: readOnly(decisions), evidenceStates: readOnly(evidenceStates) }),
    /** The deletion unit (M23 P4A-D14): a deleted player's cases keep their ids, states and history and lose the name. */
    redactPlayer(playerId, at) {
      return operation(() => {
        let n = 0;
        for (const c of sqlite.prepare('SELECT id FROM recruitment_cases WHERE player_id = ? ORDER BY rowid').all(playerId)) { update('recruitmentCases')(c.id, (d) => { d.playerName = null; d.subjectRemovedAt = at; }); n += 1; }
        return n;
      });
    },
    /** Check the tables are authoritative (0016 recorded); there is nothing to load. */
    attach() {
      if (!recruitmentCasesLive(sqlite)) throw new Error(`the recruitment-cases repository needs ${RECRUITMENT_CASES_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, readAll(sqlite, n)])); },
    log,
    now,
  };
}
