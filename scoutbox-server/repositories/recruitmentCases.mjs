/**
 * Recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room
 * snapshots, room decisions and room evidence states.
 *
 * Every field is a typed column with the vocabulary CHECKs of the domain rules (domains/recruitment/rooms/shared.mjs,
 * domains/recruitment/lifecycle/decision.mjs, domains/recruitment/money.mjs, domains/agents/integration/integration.mjs). A case's history has one entry shape
 * (`{ id, at, byKind, byId, byName, action, detail }`), and a decision's `snapshot` is read from the room_snapshots row
 * it names (it is that row, never a second copy). The idempotency keys are columns of their owner (a draft's create key,
 * a decision's finalize and draft keys, a handoff's invite key).
 *
 * Writes (repositories/writes.mjs). A record is created whole and must read back as written (an unknown field, or a
 * value a column would coerce, is refused). It then changes only through named acts, each an UPDATE or INSERT of the
 * rows it concerns: a case through `moveRoom`, `addTask`, `startDraft`, `inviteHandoff`, `addScenario` and the rest, a
 * comment through `edit` and `remove`, a decision through `markSuperseded`, `recordLifecycle` and `bump`, an evidence
 * state through `review`. History is only appended. A Room moves only along `ROOM_TRANSITIONS`, an approval and a
 * handoff only out of their open state, and a plain case's stage is the only stage written directly.
 *
 * References. org_id → orgs and the staff ids (owner, lead scout, decision maker, assignee, comment author) →
 * org_users, RESTRICT. Every room row's room_id → recruitment_cases RESTRICT. The pointers inside a room are composite
 * keys `(room_id, …)` into the same room's rows: a decision's snapshot, its chain (supersedes / superseded by) and a
 * comment's reply. case_request_links → recruitment_requests and case_trial_links → trials RESTRICT. Player ids: no
 * key, tolerant and counted (Q8a in docs/decisions.md). The children cascade with their owner.
 *
 * Refusals name tables, fields and ids, never a name, a note, a body or a message.
 */
import { migrationApplied, newestHistory, childRowsOf, operationOn } from './database.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { isPlainObject } from './fieldSpecs.mjs';
import { writeChecks, writeKit } from './writes.mjs';
import {
  ROOM_STATUSES,
  ROOM_PRIORITIES,
  ROOM_TRANSITIONS,
  SOURCE_CONTEXTS,
  TASK_STATES,
  LINKED_RESOURCE_TYPES,
  EVIDENCE_REVIEW_STATES,
  RECOMMENDATIONS,
  ROOM_LIMITS as LIMITS,
  CASE_STAGES,
  CASE_PRIORITIES,
  CASE_DECISION_OUTCOMES,
  CASE_APPROVAL_STATES,
} from '../domains/recruitment/public.mjs';
import {
  DECISION_OUTCOMES,
  DECISION_KINDS,
  DECISION_STATES,
  EVIDENCE_REF_KINDS,
  DECISION_LIMITS,
} from '../domains/recruitment/public.mjs';
import { CURRENCIES, BUDGET_LINE_KINDS, BUDGET_SCHEDULES } from '../domains/recruitment/public.mjs';
import { HANDOFF_STATUSES } from '../domains/agents/public.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const RECRUITMENT_CASES_MIGRATION = '0016_recruitment_cases';
export const RECRUITMENT_CASES_COLLECTIONS = Object.freeze([
  'recruitmentCases',
  'roomComments',
  'roomSnapshots',
  'roomDecisions',
  'roomEvidenceState',
]);
export const CASE_TABLES = Object.freeze([
  'recruitment_cases',
  'case_room_tags',
  'case_assignments',
  'case_tasks',
  'case_approvals',
  'case_history',
  'case_request_links',
  'case_trial_links',
  'case_decision_drafts',
  'case_decision_draft_reason_codes',
  'case_decision_draft_evidence_refs',
  'case_transaction_handoffs',
  'case_budget_scenarios',
  'case_budget_lines',
  'case_budget_fx_assumptions',
  'case_budget_actuals',
]);
export const ROOM_TABLES = Object.freeze([
  'room_comments',
  'room_comment_mentions',
  'room_snapshots',
  'room_snapshot_source_refs',
  'room_decisions',
  'room_decision_reason_codes',
  'room_decision_evidence_refs',
  'room_decision_assessment_ids',
  'room_evidence_states',
]);
export const RECRUITMENT_CASES_TABLES = Object.freeze([...CASE_TABLES, ...ROOM_TABLES]);
export const recruitmentCasesLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION);
const { rowStep, listOf, readsBackAsWritten, newRecord } = writeChecks('RECRUITMENT_CASES');

// ------------------------------------------------------------------ vocabulary
/** Who a case history entry names: a club user (`org` or `org_user`), a family member, the platform, an agent. */
export const CASE_ACTOR_KINDS = Object.freeze(['org', 'org_user', 'player', 'guardian', 'system', 'admin', 'agent']);
/** A handoff's stored status (`expired` is read from its age, never stored). */
const HANDOFF_STORED = HANDOFF_STATUSES.filter((s) => s !== 'expired');
const SOURCE_REF_KINDS = ['evidence', 'assessment', 'combine', 'trial'];
const CODE_MAX = 64;
const KEY_MAX = DECISION_LIMITS.clientKey;
const TEXT = Object.freeze({
  reasons: 500,
  trigger: 120,
  action: 64,
  assumption: 200,
  source: 80,
  task: 200,
  title: 200,
  label: 80,
  fxRate: 32,
  evidenceNote: 1000,
});
/** The free-text limits of a case's columns. */
export const CASE_TEXT_LIMITS = TEXT;

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
  trigger TEXT NOT NULL CHECK (length(trigger) BETWEEN 1 AND ${TEXT.trigger}),
  trust_score REAL,
  trust_band TEXT,
  trust_policy_version INTEGER,
  trust_component_levels_json TEXT ${jsonObject('trust_component_levels_json')},
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
  snapshot_id TEXT,
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

// ------------------------------------------------------------------ rows
// The encoders take a record as the routes build it (or a fixture writes it); an absent field is NULL, and the
// columns' CHECKs and keys judge the values.
const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isSafeInteger(v);
const n = (v) => (v === undefined ? null : v);
const b = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
/** A due date or a deadline: a `YYYY-MM-DD` day in `_day`, an instant in ms in `_at`. */
const dueRow = (p, v) => ({ [`${p}_day`]: isStr(v) ? v : null, [`${p}_at`]: isInt(v) ? v : null });
const dueOut = (row, p) => row[`${p}_day`] ?? row[`${p}_at`];
const personRow = (p, v, extra = []) => ({
  [`${p}_user_id`]: v?.userId ?? null,
  [`${p}_name`]: v?.name ?? null,
  ...Object.fromEntries(extra.map((k) => [`${p}_${k}`, v?.[k] ?? null])),
});
const personOut = (row, p, extra = []) =>
  row[`${p}_user_id`] === null && row[`${p}_name`] === null && extra.every((k) => row[`${p}_${k}`] === null)
    ? null
    : {
        userId: row[`${p}_user_id`],
        name: row[`${p}_name`],
        ...Object.fromEntries(extra.map((k) => [k, row[`${p}_${k}`]])),
      };
const jsonOut = (v) => (v === null ? null : JSON.parse(v));
const keyCols = (p, k) => ({ [`${p}_key`]: k?.key ?? null, [`${p}_fp`]: k?.fp ?? null });
const sourceRefCols = (p, r) => ({ [`${p}_id`]: r?.id ?? null, [`${p}_version`]: r?.version ?? null });

/** The Room's reopen facet: who reopened it, from where, why and from what source. */
const reopenedCols = (ro) => ({
  room_reopened_at: ro?.at ?? null,
  ...personRow('room_reopened_by', ro?.by),
  room_reopened_from: ro?.from ?? null,
  room_reopened_reason_codes_json: ro ? JSON.stringify(ro.reasonCodes ?? []) : null,
  room_reopened_source_context: ro?.sourceContext ?? null,
  ...sourceRefCols('room_reopened_source_ref', ro?.sourceRef),
});
/** The Room facet's columns (its tags are rows). */
const roomCols = (r) => ({
  room_status: r?.status ?? null,
  room_priority: r?.priority ?? null,
  room_lead_scout_user_id: r?.leadScoutUserId ?? null,
  room_source_context: r?.sourceContext ?? null,
  ...sourceRefCols('room_source_ref', r?.sourceRef),
  ...personRow('room_opened_by', r?.openedBy),
  room_updated_at: r?.updatedAt ?? null,
  room_archived_at: r?.archivedAt ?? null,
  room_closed_at: r?.closedAt ?? null,
  room_rev: r?.rev ?? null,
  room_rev_at: r?.revAt ?? null,
  ...personRow('room_rev_by', r?.revBy),
  ...reopenedCols(r?.reopened),
});
/** The case's sign-off decision (not a Room decision). */
const caseDecisionCols = (d) => ({
  decision_outcome: d?.outcome ?? null,
  decision_reasons: d?.reasons ?? null,
  decision_by_user_id: d?.byUserId ?? null,
  decision_by_name: d?.byName ?? null,
  decision_approved_by_name: d?.approvedBy ?? null,
  decision_at: d?.at ?? null,
});
const caseRow = (c) => ({
  id: n(c.id),
  org_id: n(c.orgId),
  player_id: n(c.playerId),
  player_name: n(c.playerName),
  vacancy_id: n(c.vacancyId),
  owner_user_id: n(c.ownerUserId),
  owner_name: n(c.ownerName),
  stage: n(c.stage),
  priority: n(c.priority),
  ...dueRow('deadline', c.deadline),
  restricted: b(c.restricted) ?? 0,
  ...caseDecisionCols(c.decision),
  links_signing_id: c.links?.signingId ?? null,
  created_at: n(c.createdAt),
  subject_removed_at: n(c.subjectRemovedAt),
  ...roomCols(c.room),
});
const assignmentRow = (caseId, a, position) => ({
  case_id: caseId,
  position,
  id: n(a.id),
  user_id: n(a.userId),
  user_name: n(a.name),
  task: n(a.task),
  ...dueRow('due', a.dueAt),
  status: n(a.status),
  created_at: n(a.createdAt),
});
const taskRow = (caseId, t, position) => ({
  case_id: caseId,
  position,
  id: n(t.id),
  title: n(t.title),
  description: n(t.description),
  ...dueRow('due', t.dueAt),
  assignee_user_id: n(t.assigneeUserId),
  assignee_name: n(t.assigneeName),
  status: n(t.status),
  linked_resource_type: n(t.linkedResourceType),
  linked_resource_id: n(t.linkedResourceId),
  ...personRow('created_by', t.createdBy),
  created_at: n(t.createdAt),
  completed_at: n(t.completedAt),
  completed_by_name: n(t.completedBy),
});
const resolvedCols = (r) => ({
  resolved_by_user_id: r?.userId ?? null,
  resolved_by_name: r?.name ?? null,
  resolved_at: r?.at ?? null,
});
const approvalRow = (caseId, a, position) => ({
  case_id: caseId,
  position,
  id: n(a.id),
  decision_outcome: a.decision?.outcome ?? null,
  decision_reasons: a.decision?.reasons ?? null,
  ...personRow('requested_by', a.requestedBy),
  status: n(a.status),
  requested_at: n(a.requestedAt),
  ...resolvedCols(a.resolvedBy),
});
const historyRow = (caseId, h, position) => ({
  case_id: caseId,
  position,
  id: n(h.id),
  at: n(h.at),
  action: n(h.action),
  by_kind: n(h.byKind),
  by_id: n(h.byId),
  by_name: n(h.byName),
  detail_text: isStr(h.detail) ? h.detail : null,
  detail_json: isPlainObject(h.detail) ? JSON.stringify(h.detail) : null,
});
const draftRow = (caseId, d) => ({
  case_id: caseId,
  id: n(d.id),
  outcome: n(d.outcome),
  note: n(d.note),
  ...personRow('by', d.by, ['role']),
  created_at: n(d.createdAt),
  updated_at: n(d.updatedAt),
  ...personRow('updated_by', d.updatedBy, ['role']),
  rev: n(d.rev),
  rev_at: n(d.revAt),
  ...keyCols('create', d.keys?.create),
});
const codeRow = (owner, ownerId, code, position) => ({ [owner]: ownerId, position, code });
const refRow = (owner, ownerId, r, position) => ({
  [owner]: ownerId,
  position,
  kind: n(r.kind),
  ref_id: n(r.id),
  meta_json: json(r.meta),
});
const handoffRow = (caseId, h) => ({
  case_id: caseId,
  id: n(h.id),
  org_id: n(h.orgId),
  player_id: n(h.playerId),
  status: n(h.status),
  invited_at: n(h.invitedAt),
  invited_by_user_id: h.invitedBy?.userId ?? null,
  invited_by_name: h.invitedBy?.name ?? null,
  accepted_at: n(h.acceptedAt),
  withdrawn_at: n(h.withdrawnAt),
  transaction_id: n(h.transactionId),
  represented_at_invitation: b(h.representedAtInvitation),
  invited_agency_org_id: n(h.invitedAgencyOrgId),
  invited_agent_user_id: n(h.invitedAgentUserId),
  invite_key: h.keys?.invite?.key ?? null,
  rev: n(h.rev),
  rev_at: n(h.revAt),
});
const approvalCols = (a) => ({
  approval_by_name: a?.by ?? null,
  approval_by_user_id: a?.byUserId ?? null,
  approval_at: a?.at ?? null,
  approval_version: a?.version ?? null,
  approval_superseded: b(a?.superseded),
});
const scenarioRow = (caseId, s, position) => ({
  case_id: caseId,
  position,
  id: n(s.id),
  version: n(s.version),
  label: n(s.label),
  currency: n(s.currency),
  term_months: n(s.termMonths),
  created_by_name: n(s.createdBy),
  created_at: n(s.createdAt),
  updated_at: n(s.updatedAt),
  ...approvalCols(s.approval),
});
const lineRow = (caseId, scenarioId, l, position) => ({
  case_id: caseId,
  scenario_id: scenarioId,
  position,
  id: n(l.id),
  kind: n(l.kind),
  label: n(l.label),
  amount_minor: n(l.amountMinor),
  currency: n(l.currency),
  schedule: n(l.schedule),
  confirmed: b(l.confirmed),
  conditional_assumption: l.conditional?.assumption ?? null,
});
const fxRow = (caseId, scenarioId, a, position) => ({
  case_id: caseId,
  scenario_id: scenarioId,
  position,
  from_currency: n(a.from),
  to_currency: n(a.to),
  rate: n(a.rate),
  source: n(a.source),
  date: n(a.date),
  manual: b(a.manual),
});
const actualRow = (caseId, scenarioId, a, position) => ({
  case_id: caseId,
  scenario_id: scenarioId,
  position,
  id: n(a.id),
  line_id: n(a.lineId),
  amount_minor: n(a.amountMinor),
  at: n(a.at),
  recorded_by_name: n(a.recordedBy),
});
const commentRow = (c) => ({
  id: n(c.id),
  room_id: n(c.roomId),
  org_id: n(c.orgId),
  author_user_id: n(c.authorId),
  author_name: n(c.authorName),
  body: n(c.body),
  reply_to_id: n(c.replyToId),
  created_at: n(c.createdAt),
  edited_at: n(c.editedAt),
  edit_count: n(c.editCount) ?? 0,
  deleted_at: n(c.deletedAt),
  ...personRow('deleted_by', c.deletedBy),
});
const snapshotRow = (s) => ({
  id: n(s.id),
  room_id: n(s.roomId),
  org_id: n(s.orgId),
  player_id: n(s.playerId),
  at: n(s.at),
  trigger: n(s.trigger),
  trust_score: s.trust?.score ?? null,
  trust_band: s.trust?.band ?? null,
  trust_policy_version: s.trust?.policyVersion ?? null,
  trust_component_levels_json: s.trust ? JSON.stringify(s.trust.componentLevels ?? {}) : null,
  trust_hash: s.trust?.hash ?? null,
  source_passport_version: s.sourceRefs?.passportVersion ?? null,
  source_passport_revision: s.sourceRefs?.passportRevision ?? null,
  note: n(s.note),
});
const lifecycleCols = (l) => ({
  lifecycle_action: l?.action ?? null,
  lifecycle_from: l?.from ?? null,
  lifecycle_to: l?.to ?? null,
  lifecycle_applied: b(l?.applied),
  lifecycle_reason: l?.reason ?? null,
  lifecycle_at: l?.at ?? null,
});
const decisionRow = (d) => {
  const as = d.assessmentSummary;
  return {
    id: n(d.id),
    room_id: n(d.roomId),
    org_id: n(d.orgId),
    player_id: n(d.playerId),
    kind: n(d.kind),
    state: n(d.state),
    outcome: n(d.outcome),
    recommendation: n(d.recommendation),
    note: n(d.note),
    ...personRow('by', d.by, ['role']),
    created_at: n(d.createdAt),
    finalized_at: n(d.finalizedAt),
    trigger: n(d.trigger),
    client_key: n(d.clientKey),
    supersedes_id: n(d.supersedes),
    superseded_by_id: n(d.supersededById),
    supersession_of_id: d.supersession?.of ?? null,
    supersession_reason: d.supersession?.reason ?? null,
    rev: n(d.rev),
    rev_at: n(d.revAt),
    assessments_submitted: as?.submitted ?? null,
    assessments_withheld: as ? (as.withheld ?? 0) : null,
    assessment_verdicts_json: as ? JSON.stringify(as.verdicts ?? {}) : null,
    snapshot_id: d.snapshot?.snapshotId ?? null,
    ...keyCols('finalize', d.keys?.finalize),
    ...keyCols('draft', d.keys?.draft),
    draft_id: n(d.draftId),
    ...lifecycleCols(d.lifecycle),
    policy_version: n(d.policyVersion),
  };
};
const evidenceRow = (e) => ({
  id: n(e.id),
  room_id: n(e.roomId),
  org_id: n(e.orgId),
  evidence_id: n(e.evidenceId),
  state: n(e.state),
  note: n(e.note),
  by_user_id: n(e.byId),
  by_name: n(e.byName),
  at: n(e.at),
});

const COLS = {
  recruitment_cases: Object.keys(caseRow({})),
  case_room_tags: ['case_id', 'position', 'tag'],
  case_assignments: Object.keys(assignmentRow('x', {}, 0)),
  case_tasks: Object.keys(taskRow('x', {}, 0)),
  case_approvals: Object.keys(approvalRow('x', {}, 0)),
  case_history: Object.keys(historyRow('x', {}, 0)),
  case_request_links: ['case_id', 'position', 'request_id'],
  case_trial_links: ['case_id', 'position', 'trial_id'],
  case_decision_drafts: Object.keys(draftRow('x', {})),
  case_decision_draft_reason_codes: Object.keys(codeRow('case_id', 'x', 'c', 0)),
  case_decision_draft_evidence_refs: Object.keys(refRow('case_id', 'x', {}, 0)),
  case_transaction_handoffs: Object.keys(handoffRow('x', {})),
  case_budget_scenarios: Object.keys(scenarioRow('x', {}, 0)),
  case_budget_lines: Object.keys(lineRow('x', 's', {}, 0)),
  case_budget_fx_assumptions: Object.keys(fxRow('x', 's', {}, 0)),
  case_budget_actuals: Object.keys(actualRow('x', 's', {}, 0)),
  room_comments: Object.keys(commentRow({})),
  room_comment_mentions: ['comment_id', 'position', 'user_id'],
  room_snapshots: Object.keys(snapshotRow({})),
  room_snapshot_source_refs: ['snapshot_id', 'kind', 'position', 'ref_id'],
  room_decisions: Object.keys(decisionRow({})),
  room_decision_reason_codes: Object.keys(codeRow('decision_id', 'x', 'c', 0)),
  room_decision_evidence_refs: Object.keys(refRow('decision_id', 'x', {}, 0)),
  room_decision_assessment_ids: ['decision_id', 'position', 'assessment_id'],
  room_evidence_states: Object.keys(evidenceRow({})),
};
const PARENT = {
  recruitmentCases: 'recruitment_cases',
  roomComments: 'room_comments',
  roomSnapshots: 'room_snapshots',
  roomDecisions: 'room_decisions',
  roomEvidenceState: 'room_evidence_states',
};
const SOURCE_REF_LISTS = [
  ['evidence', 'evidenceIds'],
  ['assessment', 'assessmentIds'],
  ['combine', 'combineResults'],
  ['trial', 'trialIds'],
];

// ------------------------------------------------------------------ statements and the record readers
const stmtCache = new WeakMap();
function statements(sqlite) {
  let s = stmtCache.get(sqlite);
  if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table) => {
    const cols = COLS[table];
    return sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  };
  const byCase = (t, order = 'position') =>
    sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ?${order ? ` ORDER BY ${order}` : ''}`);
  s = {
    ins: Object.fromEntries(Object.keys(COLS).map((t) => [t, insert(t)])),
    byId: Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} WHERE id = ?`)])),
    all: Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`)])),
    of: Object.fromEntries(
      [
        'case_room_tags',
        'case_assignments',
        'case_tasks',
        'case_approvals',
        'case_history',
        'case_request_links',
        'case_trial_links',
        'case_decision_draft_reason_codes',
        'case_decision_draft_evidence_refs',
        'case_budget_scenarios',
      ].map((t) => [t, byCase(t)]),
    ),
    draftOf: byCase('case_decision_drafts', null),
    handoffOf: byCase('case_transaction_handoffs', null),
    scenarioChild: Object.fromEntries(
      ['case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals'].map((t) => [
        t,
        sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ? AND scenario_id = ? ORDER BY position`),
      ]),
    ),
    mentionsOf: sqlite.prepare('SELECT user_id FROM room_comment_mentions WHERE comment_id = ? ORDER BY position'),
    sourceRefsOf: sqlite.prepare(
      'SELECT kind, ref_id FROM room_snapshot_source_refs WHERE snapshot_id = ? ORDER BY kind, position',
    ),
    decisionChild: Object.fromEntries(
      ['room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids'].map((t) => [
        t,
        sqlite.prepare(`SELECT * FROM ${t} WHERE decision_id = ? ORDER BY position`),
      ]),
    ),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s);
  return s;
}

/**
 * The statements `decodeCase` reads children through, answered for many cases at once: one query per
 * child table for the whole list (in chunks of ids), grouped by case, instead of about sixteen queries a case. The
 * rows and their order are the per-case statements' own, so a batch decode is the same record.
 */
function batchStatements(sqlite, st, ids) {
  const rows = (t, subKey = []) => childRowsOf(sqlite, t, 'case_id', ids, { order: 'position', subKey });
  const first = (t) => {
    const m = childRowsOf(sqlite, t, 'case_id', ids);
    return { get: (id) => m.all(id)[0] };
  };
  return {
    ...st,
    of: Object.fromEntries(Object.keys(st.of).map((t) => [t, rows(t)])),
    draftOf: first('case_decision_drafts'),
    handoffOf: first('case_transaction_handoffs'),
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
    decisionChild: Object.fromEntries(
      Object.keys(st.decisionChild).map((t) => [t, childRowsOf(sqlite, t, 'decision_id', ids, { order: 'position' })]),
    ),
    byId: { ...st.byId, room_snapshots: { get: (id) => snapshots.all(id)[0] } },
    sourceRefsOf: childRowsOf(sqlite, 'room_snapshot_source_refs', 'snapshot_id', snapshotIds, {
      order: 'kind, position',
    }),
  };
}

/** A case's ordered children, inserted at `position` from 0. */
const caseChildren = (st, id, step, list) => ({
  tags: (tags) =>
    list('room.tags', tags).forEach((tag, i) =>
      step(`room tag ${i}`, () => st.ins.case_room_tags.run({ case_id: id, position: i, tag })),
    ),
  draft: (d) => {
    step('decision draft', () => st.ins.case_decision_drafts.run(draftRow(id, d)));
    list('decisionDraft.reasonCodes', d.reasonCodes).forEach((code, i) =>
      step(`decision draft reason ${i}`, () =>
        st.ins.case_decision_draft_reason_codes.run(codeRow('case_id', id, code, i)),
      ),
    );
    list('decisionDraft.evidenceRefs', d.evidenceRefs, { objects: true }).forEach((r, i) =>
      step(`decision draft evidence ${i}`, () =>
        st.ins.case_decision_draft_evidence_refs.run(refRow('case_id', id, r, i)),
      ),
    );
  },
  scenario: (s, position) => {
    step(`budget scenario ${s.id}`, () => st.ins.case_budget_scenarios.run(scenarioRow(id, s, position)));
    list(`budget scenario ${s.id} lines`, s.lines, { objects: true }).forEach((l, j) =>
      step(`budget scenario ${s.id} line ${l.id}`, () => st.ins.case_budget_lines.run(lineRow(id, s.id, l, j))),
    );
    list(`budget scenario ${s.id} fxAssumptions`, s.fxAssumptions, { objects: true }).forEach((a, j) =>
      step(`budget scenario ${s.id} fx ${j}`, () => st.ins.case_budget_fx_assumptions.run(fxRow(id, s.id, a, j))),
    );
    list(`budget scenario ${s.id} actuals`, s.actuals, { objects: true }).forEach((a, j) =>
      step(`budget scenario ${s.id} actual ${a.id}`, () => st.ins.case_budget_actuals.run(actualRow(id, s.id, a, j))),
    );
  },
});
/** A whole case, inserted with its children. */
function insertCase(st, c) {
  const id = c.id;
  const step = (part, fn) => rowStep('recruitment_cases', id, part, fn);
  const list = (field, v, opts) => listOf('recruitment_cases', id, field, v, opts);
  const children = caseChildren(st, id, step, list);
  step('row', () => st.ins.recruitment_cases.run(caseRow(c)));
  children.tags(c.room?.tags);
  list('assignments', c.assignments, { objects: true }).forEach((a, i) =>
    step(`assignment ${a.id}`, () => st.ins.case_assignments.run(assignmentRow(id, a, i))),
  );
  list('tasks', c.tasks, { objects: true }).forEach((t, i) =>
    step(`task ${t.id}`, () => st.ins.case_tasks.run(taskRow(id, t, i))),
  );
  list('approvals', c.approvals, { objects: true }).forEach((a, i) =>
    step(`approval ${a.id}`, () => st.ins.case_approvals.run(approvalRow(id, a, i))),
  );
  list('history', c.history, { objects: true }).forEach((h, i) =>
    step(`history ${h.id}`, () => st.ins.case_history.run(historyRow(id, h, i))),
  );
  list('links.requestIds', c.links?.requestIds).forEach((r, i) =>
    step(`request link ${r}`, () => st.ins.case_request_links.run({ case_id: id, position: i, request_id: r })),
  );
  list('links.trialIds', c.links?.trialIds).forEach((t, i) =>
    step(`trial link ${t}`, () => st.ins.case_trial_links.run({ case_id: id, position: i, trial_id: t })),
  );
  if (c.decisionDraft) children.draft(c.decisionDraft);
  if (c.transactionHandoff)
    step('transaction handoff', () => st.ins.case_transaction_handoffs.run(handoffRow(id, c.transactionHandoff)));
  list('budget.scenarios', c.budget?.scenarios, { objects: true }).forEach((s, i) => children.scenario(s, i));
}
/** A whole room comment, snapshot, decision or evidence state, inserted with its children. */
function insertRoomRow(st, name, r) {
  const table = PARENT[name];
  const step = (part, fn) => rowStep(table, r.id, part, fn);
  const list = (field, v, opts) => listOf(table, r.id, field, v, opts);
  if (name === 'roomComments') {
    step('row', () => st.ins.room_comments.run(commentRow(r)));
    list('mentions', r.mentions).forEach((u, i) =>
      step(`mention ${i}`, () => st.ins.room_comment_mentions.run({ comment_id: r.id, position: i, user_id: u })),
    );
  } else if (name === 'roomSnapshots') {
    step('row', () => st.ins.room_snapshots.run(snapshotRow(r)));
    for (const [kind, key] of SOURCE_REF_LISTS)
      list(`sourceRefs.${key}`, r.sourceRefs?.[key]).forEach((ref, i) =>
        step(`source ref ${kind} ${i}`, () =>
          st.ins.room_snapshot_source_refs.run({ snapshot_id: r.id, kind, position: i, ref_id: ref }),
        ),
      );
  } else if (name === 'roomDecisions') {
    step('row', () => st.ins.room_decisions.run(decisionRow(r)));
    list('reasonCodes', r.reasonCodes).forEach((code, i) =>
      step(`reason ${i}`, () => st.ins.room_decision_reason_codes.run(codeRow('decision_id', r.id, code, i))),
    );
    list('evidenceRefs', r.evidenceRefs, { objects: true }).forEach((e, i) =>
      step(`evidence ref ${i}`, () => st.ins.room_decision_evidence_refs.run(refRow('decision_id', r.id, e, i))),
    );
    list('assessmentSummary.assessmentIds', r.assessmentSummary?.assessmentIds).forEach((a, i) =>
      step(`assessment ${i}`, () =>
        st.ins.room_decision_assessment_ids.run({ decision_id: r.id, position: i, assessment_id: a }),
      ),
    );
  } else {
    step('row', () => st.ins.room_evidence_states.run(evidenceRow(r)));
  }
}

const historyOut = (h) => ({
  id: h.id,
  at: h.at,
  byKind: h.by_kind,
  byId: h.by_id,
  byName: h.by_name,
  action: h.action,
  detail: h.detail_json !== null ? JSON.parse(h.detail_json) : h.detail_text,
});
function decodeCase(st, row) {
  const id = row.id;
  const O = st.of;
  const dr = st.draftOf.get(id);
  const ho = st.handoffOf.get(id);
  const scenarios = O.case_budget_scenarios.all(id).map((s) => ({
    id: s.id,
    version: s.version,
    label: s.label,
    currency: s.currency,
    termMonths: s.term_months,
    lines: st.scenarioChild.case_budget_lines.all(id, s.id).map((l) => ({
      id: l.id,
      kind: l.kind,
      label: l.label,
      amountMinor: l.amount_minor,
      currency: l.currency,
      schedule: l.schedule,
      confirmed: l.confirmed === 1,
      conditional: l.conditional_assumption === null ? null : { assumption: l.conditional_assumption },
    })),
    fxAssumptions: st.scenarioChild.case_budget_fx_assumptions.all(id, s.id).map((a) => ({
      from: a.from_currency,
      to: a.to_currency,
      rate: a.rate,
      source: a.source,
      date: a.date,
      manual: a.manual === 1,
    })),
    approval:
      s.approval_at === null
        ? null
        : {
            by: s.approval_by_name,
            byUserId: s.approval_by_user_id,
            at: s.approval_at,
            version: s.approval_version,
            superseded: s.approval_superseded === 1,
          },
    actuals: st.scenarioChild.case_budget_actuals.all(id, s.id).map((a) => ({
      id: a.id,
      lineId: a.line_id,
      amountMinor: a.amount_minor,
      at: a.at,
      recordedBy: a.recorded_by_name,
    })),
    createdBy: s.created_by_name,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  }));
  const room =
    row.room_status === null
      ? null
      : {
          status: row.room_status,
          priority: row.room_priority,
          tags: O.case_room_tags.all(id).map((t) => t.tag),
          leadScoutUserId: row.room_lead_scout_user_id,
          sourceContext: row.room_source_context,
          sourceRef:
            row.room_source_ref_id === null
              ? null
              : { id: row.room_source_ref_id, version: row.room_source_ref_version },
          openedBy: personOut(row, 'room_opened_by'),
          updatedAt: row.room_updated_at,
          archivedAt: row.room_archived_at,
          closedAt: row.room_closed_at,
          rev: row.room_rev,
          revAt: row.room_rev_at,
          revBy: personOut(row, 'room_rev_by'),
          reopened:
            row.room_reopened_at === null
              ? null
              : {
                  by: personOut(row, 'room_reopened_by'),
                  at: row.room_reopened_at,
                  from: row.room_reopened_from,
                  reasonCodes: JSON.parse(row.room_reopened_reason_codes_json),
                  sourceContext: row.room_reopened_source_context,
                  sourceRef:
                    row.room_reopened_source_ref_id === null
                      ? null
                      : { id: row.room_reopened_source_ref_id, version: row.room_reopened_source_ref_version },
                },
        };
  return {
    id,
    orgId: row.org_id,
    playerId: row.player_id,
    playerName: row.player_name,
    vacancyId: row.vacancy_id,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    stage: row.stage,
    priority: row.priority,
    deadline: dueOut(row, 'deadline'),
    restricted: row.restricted === 1,
    assignments: O.case_assignments.all(id).map((a) => ({
      id: a.id,
      userId: a.user_id,
      name: a.user_name,
      task: a.task,
      dueAt: dueOut(a, 'due'),
      status: a.status,
      createdAt: a.created_at,
    })),
    tasks: O.case_tasks.all(id).map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      dueAt: dueOut(t, 'due'),
      assigneeUserId: t.assignee_user_id,
      assigneeName: t.assignee_name,
      status: t.status,
      linkedResourceType: t.linked_resource_type,
      linkedResourceId: t.linked_resource_id,
      createdBy: personOut(t, 'created_by'),
      createdAt: t.created_at,
      completedAt: t.completed_at,
      completedBy: t.completed_by_name,
    })),
    approvals: O.case_approvals.all(id).map((a) => ({
      id: a.id,
      decision: { outcome: a.decision_outcome, reasons: a.decision_reasons },
      requestedBy: personOut(a, 'requested_by'),
      status: a.status,
      requestedAt: a.requested_at,
      resolvedBy:
        a.resolved_at === null ? null : { userId: a.resolved_by_user_id, name: a.resolved_by_name, at: a.resolved_at },
    })),
    decision:
      row.decision_at === null
        ? null
        : {
            outcome: row.decision_outcome,
            reasons: row.decision_reasons,
            byUserId: row.decision_by_user_id,
            byName: row.decision_by_name,
            approvedBy: row.decision_approved_by_name,
            at: row.decision_at,
          },
    links: {
      requestIds: O.case_request_links.all(id).map((r) => r.request_id),
      trialIds: O.case_trial_links.all(id).map((r) => r.trial_id),
      signingId: row.links_signing_id,
    },
    createdAt: row.created_at,
    history: O.case_history.all(id).map(historyOut),
    room,
    decisionDraft: !dr
      ? null
      : {
          id: dr.id,
          outcome: dr.outcome,
          reasonCodes: O.case_decision_draft_reason_codes.all(id).map((r) => r.code),
          note: dr.note,
          evidenceRefs: O.case_decision_draft_evidence_refs
            .all(id)
            .map((r) => ({ kind: r.kind, id: r.ref_id, meta: jsonOut(r.meta_json) })),
          by: personOut(dr, 'by', ['role']),
          createdAt: dr.created_at,
          updatedAt: dr.updated_at,
          updatedBy: personOut(dr, 'updated_by', ['role']),
          rev: dr.rev,
          revAt: dr.rev_at,
          keys: { create: dr.create_key === null ? null : { key: dr.create_key, fp: dr.create_fp } },
        },
    transactionHandoff: !ho
      ? null
      : {
          id: ho.id,
          caseId: id,
          orgId: ho.org_id,
          playerId: ho.player_id,
          status: ho.status,
          invitedAt: ho.invited_at,
          invitedBy:
            ho.invited_by_user_id === null && ho.invited_by_name === null
              ? null
              : { kind: 'org', userId: ho.invited_by_user_id, name: ho.invited_by_name },
          acceptedAt: ho.accepted_at,
          withdrawnAt: ho.withdrawn_at,
          transactionId: ho.transaction_id,
          representedAtInvitation: ho.represented_at_invitation === 1,
          invitedAgencyOrgId: ho.invited_agency_org_id,
          invitedAgentUserId: ho.invited_agent_user_id,
          keys: { invite: ho.invite_key === null ? null : { key: ho.invite_key } },
          rev: ho.rev,
          revAt: ho.rev_at,
        },
    budget: scenarios.length ? { scenarios } : null,
    subjectRemovedAt: row.subject_removed_at,
  };
}
const decodeComment = (st, r) => ({
  id: r.id,
  roomId: r.room_id,
  orgId: r.org_id,
  authorId: r.author_user_id,
  authorName: r.author_name,
  body: r.body,
  replyToId: r.reply_to_id,
  mentions: st.mentionsOf.all(r.id).map((m) => m.user_id),
  createdAt: r.created_at,
  editedAt: r.edited_at,
  editCount: r.edit_count,
  deletedAt: r.deleted_at,
  deletedBy: personOut(r, 'deleted_by'),
});
function decodeSnapshot(st, r) {
  const refs = { evidence: [], assessment: [], combine: [], trial: [] };
  for (const x of st.sourceRefsOf.all(r.id)) refs[x.kind].push(x.ref_id);
  return {
    id: r.id,
    roomId: r.room_id,
    orgId: r.org_id,
    playerId: r.player_id,
    at: r.at,
    trigger: r.trigger,
    trust:
      r.trust_hash === null
        ? null
        : {
            score: r.trust_score,
            band: r.trust_band,
            policyVersion: r.trust_policy_version,
            componentLevels: JSON.parse(r.trust_component_levels_json),
            hash: r.trust_hash,
          },
    sourceRefs: {
      passportVersion: r.source_passport_version,
      passportRevision: r.source_passport_revision,
      evidenceIds: refs.evidence,
      assessmentIds: refs.assessment,
      combineResults: refs.combine,
      trialIds: refs.trial,
    },
    note: r.note,
  };
}
function decodeDecision(st, r) {
  const C = st.decisionChild;
  const snapRow = r.snapshot_id === null ? null : st.byId.room_snapshots.get(r.snapshot_id);
  const snap = snapRow ? decodeSnapshot(st, snapRow) : null;
  return {
    id: r.id,
    roomId: r.room_id,
    orgId: r.org_id,
    playerId: r.player_id,
    kind: r.kind,
    state: r.state,
    outcome: r.outcome,
    recommendation: r.recommendation,
    reasonCodes: C.room_decision_reason_codes.all(r.id).map((x) => x.code),
    note: r.note,
    by: personOut(r, 'by', ['role']),
    createdAt: r.created_at,
    finalizedAt: r.finalized_at,
    trigger: r.trigger,
    clientKey: r.client_key,
    supersedes: r.supersedes_id,
    supersededById: r.superseded_by_id,
    supersession: r.supersession_of_id === null ? null : { of: r.supersession_of_id, reason: r.supersession_reason },
    rev: r.rev,
    revAt: r.rev_at,
    evidenceRefs: C.room_decision_evidence_refs
      .all(r.id)
      .map((x) => ({ kind: x.kind, id: x.ref_id, meta: jsonOut(x.meta_json) })),
    assessmentSummary:
      r.assessments_submitted === null
        ? null
        : {
            submitted: r.assessments_submitted,
            withheld: r.assessments_withheld,
            verdicts: JSON.parse(r.assessment_verdicts_json),
            assessmentIds: C.room_decision_assessment_ids.all(r.id).map((x) => x.assessment_id),
          },
    snapshot: snap ? { at: snap.at, trust: snap.trust, sourceRefs: snap.sourceRefs, snapshotId: snap.id } : null,
    keys: {
      finalize: r.finalize_key === null ? null : { key: r.finalize_key, fp: r.finalize_fp },
      draft: r.draft_key === null ? null : { key: r.draft_key, fp: r.draft_fp },
    },
    draftId: r.draft_id,
    lifecycle:
      r.lifecycle_applied === null
        ? null
        : {
            action: r.lifecycle_action,
            from: r.lifecycle_from,
            to: r.lifecycle_to,
            applied: r.lifecycle_applied === 1,
            reason: r.lifecycle_reason,
            at: r.lifecycle_at,
          },
    policyVersion: r.policy_version,
  };
}
const decodeEvidence = (_st, r) => ({
  id: r.id,
  roomId: r.room_id,
  orgId: r.org_id,
  evidenceId: r.evidence_id,
  state: r.state,
  note: r.note,
  byId: r.by_user_id,
  byName: r.by_name,
  at: r.at,
});
const DECODERS = {
  recruitmentCases: decodeCase,
  roomComments: decodeComment,
  roomSnapshots: decodeSnapshot,
  roomDecisions: decodeDecision,
  roomEvidenceState: decodeEvidence,
};
const readAll = (sqlite, name) => {
  const st = statements(sqlite);
  const rows = st.all[PARENT[name]].all();
  const via =
    name === 'recruitmentCases' && rows.length > 1
      ? batchStatements(
          sqlite,
          st,
          rows.map((r) => r.id),
        )
      : st;
  return rows.map((r) => DECODERS[name](via, r));
};
export const readCases = (sqlite) => readAll(sqlite, 'recruitmentCases');
export const readRoomComments = (sqlite) => readAll(sqlite, 'roomComments');
export const readRoomSnapshots = (sqlite) => readAll(sqlite, 'roomSnapshots');
export const readRoomDecisions = (sqlite) => readAll(sqlite, 'roomDecisions');
export const readRoomEvidenceStates = (sqlite) => readAll(sqlite, 'roomEvidenceState');

/** The counts of the admin report: rows naming a player that is not in the players table, and rows naming a retained record (Q8a: counted, never refused). */
const PLAYER_COUNT_TABLES = {
  recruitmentCases: 'recruitment_cases',
  roomSnapshots: 'room_snapshots',
  roomDecisions: 'room_decisions',
  caseTransactionHandoffs: 'case_transaction_handoffs',
};
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(
    Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [
      k,
      sqlite
        .prepare(`SELECT count(*) AS n FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id)`)
        .get().n,
    ]),
  );
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentCasesLive(sqlite)) return null;
  return Object.fromEntries(
    Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [
      k,
      sqlite
        .prepare(
          `SELECT count(*) AS n FROM ${t} x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id AND p.deleted_at IS NOT NULL)`,
        )
        .get().n,
    ]),
  );
}

// ------------------------------------------------------------------ the whole-domain read
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const RECRUITMENT_CASES_RECORDS = {
  names: RECRUITMENT_CASES_COLLECTIONS,
  read(sqlite) {
    if (!recruitmentCasesLive(sqlite)) return null;
    return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, readAll(sqlite, n)]));
  },
};

// ------------------------------------------------------------------ the repository
/** Only the fields given: `undefined` leaves a column as it is. */
const given = (cols) => Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined));
/** The Room statuses a move into `to` may start from. */
const leadingTo = (to) => Object.keys(ROOM_TRANSITIONS).filter((x) => ROOM_TRANSITIONS[x].includes(to));
/**
 * `createRecruitmentCasesRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work (a
 * failure poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and
 * returns the record read back from the tables. Every query decodes fresh, deep-frozen records in insertion (rowid)
 * order and runs on the one connection, so a read inside a unit of work sees the unit's own writes.
 */
export function createRecruitmentCasesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the recruitment-cases repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const decode = (name, row) => deepFreeze(DECODERS[name](st, row));
  const find = (name, id) => {
    if (typeof id !== 'string') return null;
    const row = st.byId[PARENT[name]].get(id);
    return row ? decode(name, row) : null;
  };
  const exists = (name, id) => typeof id === 'string' && !!st.byId[PARENT[name]].get(id);
  /** Decode many rows; a list of cases or decisions reads its children in one batch (batchStatements, batchDecisionStatements). */
  const decodeAll = (name, rows) => {
    if (rows.length < 2 || (name !== 'recruitmentCases' && name !== 'roomDecisions'))
      return rows.map((r) => decode(name, r));
    if (name === 'roomDecisions') {
      const bst = batchDecisionStatements(sqlite, st, rows);
      return rows.map((r) => deepFreeze(decodeDecision(bst, r)));
    }
    const bst = batchStatements(
      sqlite,
      st,
      rows.map((r) => r.id),
    );
    return rows.map((r) => deepFreeze(decodeCase(bst, r)));
  };
  /** The records whose `col` is any of `values`, in insertion order, decoded in one batch. */
  const inList = (name, col) => (values) => {
    const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))];
    if (!want.length) return [];
    return decodeAll(
      name,
      sqlite
        .prepare(`SELECT * FROM ${PARENT[name]} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`)
        .all(...want),
    );
  };
  const list = (name, sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => decodeAll(name, stmt.all(...args));
  };
  const count = (sql) => {
    const stmt = sqlite.prepare(sql);
    return (...args) => stmt.get(...args).n;
  };

  // ---- writes: a record is created whole, then changes only through named acts on its own rows.
  const { refusal, q, sqlIn, guarded, nextPosition } = writeKit(sqlite, 'RECRUITMENT_CASES');
  const must = (name, id) => {
    const r = find(name, id);
    if (!r) throw refusal('NOT_FOUND', `${PARENT[name]} ${id} is not a record of the repository`);
    return r;
  };
  const WRITES = new Set();
  const writes = (o) => {
    for (const k of Object.keys(o)) WRITES.add(k);
    return o;
  };
  /** `create(record)`: a new record, whole. An existing id is refused, and the stored record must read back as written. */
  const create = (name) => (r) =>
    operation(() => {
      const table = PARENT[name];
      newRecord(table, (id) => exists(name, id), r);
      if (name === 'recruitmentCases') insertCase(st, r);
      else insertRoomRow(st, name, r);
      const stored = must(name, r.id);
      readsBackAsWritten(table, r.id, r, stored);
      return stored;
    });

  const CASE = 'recruitment_cases';
  const ROOM = 'room_status IS NOT NULL';
  const noRoom = (id) => `recruitment_cases ${id} has no Room`;
  const childrenOf = (id) =>
    caseChildren(
      st,
      id,
      (part, fn) => rowStep(CASE, id, part, fn),
      (field, v, opts) => listOf(CASE, id, field, v, opts),
    );
  /** Append one ordered child row: `encode(position)` at the owner's next position. */
  const appendTo = (table, id, encode, scope = {}) =>
    st.ins[table].run(encode(nextPosition(table, 'case_id', id, scope)));
  /** An act that inserts a sub-record checks it reads back as written, as a create does. */
  const storedAs = (id, written, path, pick) => (stored) => readsBackAsWritten(CASE, id, written, pick(stored), path);
  /**
   * The bookkeeping an act leaves on its case: the Room's last-activity instant (`touch`), its rev bump (`bump`, by
   * `revBy`, `{ id, name }`), and its history entries, which are only ever appended.
   */
  const applyAct = (id, { at = null, revBy = null, touch = false, bump = false, history = [] } = {}) => {
    if (touch) guarded(CASE, { id }, ROOM, { room_updated_at: at }, noRoom(id));
    if (bump)
      guarded(
        CASE,
        { id },
        ROOM,
        {
          room_rev_at: at,
          ...personRow('room_rev_by', revBy && { userId: revBy.id ?? null, name: revBy.name ?? null }),
        },
        noRoom(id),
        { set: 'room_rev = room_rev + 1' },
      );
    for (const h of listOf(CASE, id, 'history', history, { objects: true }))
      rowStep(CASE, id, `history ${h.id}`, () => appendTo('case_history', id, (p) => historyRow(id, h, p)));
  };
  /**
   * Named acts on a case, each `act(id, input, bookkeeping)`: the act's own writes, then its bookkeeping, in one
   * operation; it returns the stored case. `recordAct(id, bookkeeping)` is the bookkeeping alone (an activity entry, or
   * the second half of an act whose case move came in between).
   */
  const caseActs = (defs) => {
    const run = (name, id, fn, bookkeeping) =>
      operation(() => {
        if (!exists('recruitmentCases', id))
          throw refusal('NOT_FOUND', `recruitment_cases ${id} is not a record of the repository`);
        const check = rowStep(CASE, id, name, fn);
        applyAct(id, bookkeeping);
        const stored = must('recruitmentCases', id);
        if (typeof check === 'function') check(stored);
        return stored;
      });
    return writes({
      ...Object.fromEntries(
        Object.entries(defs).map(([name, fn]) => [
          name,
          (id, input = {}, bookkeeping = {}) => run(name, id, () => fn(id, input), bookkeeping),
        ]),
      ),
      recordAct: (id, bookkeeping = {}) => run('recordAct', id, () => {}, bookkeeping),
    });
  };
  /** Named acts on one room row, each `act(id, input)`; it returns the stored row. */
  const rowActs = (name, defs) =>
    writes(
      Object.fromEntries(
        Object.entries(defs).map(([act, fn]) => [
          act,
          (id, input = {}) =>
            operation(() => {
              if (!exists(name, id))
                throw refusal('NOT_FOUND', `${PARENT[name]} ${id} is not a record of the repository`);
              rowStep(PARENT[name], id, act, () => fn(id, input));
              return must(name, id);
            }),
        ]),
      ),
    );

  const caseWrites = {
    create: create('recruitmentCases'),
    ...caseActs({
      /** Give a plain case its Room facet: a Room adopts the club's open case rather than open a second one. */
      openRoom: (id, { room, stage }) => {
        guarded(
          CASE,
          { id },
          'room_status IS NULL',
          { ...roomCols(room), stage },
          `recruitment_cases ${id} already has a Room`,
        );
        childrenOf(id).tags(room.tags);
        return storedAs(id, room, 'room', (c) => c.room);
      },
      /**
       * Move the Room to `to`, only from a status `ROOM_TRANSITIONS` leads from, or with `resume` only from `on_hold` (the
       * lifecycle's resume is its own edge): the status, the stage derived from it, the filing instants, the last
       * activity and the rev, together. `reopened` and `sourceContext` record a reopen.
       */
      moveRoom: (id, { to, stage, archivedAt, closedAt, at, by = null, reopened, sourceContext, resume = false }) =>
        guarded(
          CASE,
          { id },
          resume ? "room_status = 'on_hold'" : sqlIn('room_status', leadingTo(to)),
          given({
            room_status: to,
            stage,
            room_archived_at: archivedAt,
            room_closed_at: closedAt,
            room_updated_at: at,
            room_rev_at: at,
            ...personRow('room_rev_by', by && { userId: by.id ?? null, name: by.name ?? null }),
            ...(reopened === undefined ? {} : reopenedCols(reopened)),
            room_source_context: sourceContext,
          }),
          `recruitment_cases ${id} cannot move to ${to} from where it is`,
          { set: 'room_rev = room_rev + 1' },
        ),
      /** The Room's settings: priority, tags, lead scout, owner, restriction and deadline (an absent one stays). */
      editRoom: (id, { priority, tags, leadScoutUserId, owner, restricted, deadline }) => {
        guarded(
          CASE,
          { id },
          ROOM,
          given({
            room_priority: priority,
            room_lead_scout_user_id: leadScoutUserId,
            owner_user_id: owner?.id,
            owner_name: owner && (owner.name ?? null),
            restricted: restricted === undefined ? undefined : b(restricted),
            ...(deadline === undefined ? {} : dueRow('deadline', deadline)),
          }),
          noRoom(id),
        );
        if (tags !== undefined) {
          q('DELETE FROM case_room_tags WHERE case_id = ?').run(id);
          childrenOf(id).tags(tags);
        }
      },
      addAssignment: (id, { assignment: a }) => {
        appendTo('case_assignments', id, (p) => assignmentRow(id, a, p));
        return storedAs(id, a, `assignment ${a.id}`, (c) => c.assignments.find((x) => x.id === a.id));
      },
      addTask: (id, { task: t }) => {
        appendTo('case_tasks', id, (p) => taskRow(id, t, p));
        return storedAs(id, t, `task ${t.id}`, (c) => c.tasks.find((x) => x.id === t.id));
      },
      /** A task's status (with its completion) or assignee; `assignee: null` unassigns it. */
      updateTask: (id, { taskId, status, completedAt, completedBy, assignee }) =>
        guarded(
          'case_tasks',
          { case_id: id, id: taskId },
          null,
          given({
            status,
            completed_at: completedAt,
            completed_by_name: completedBy,
            assignee_user_id: assignee === undefined ? undefined : (assignee?.id ?? null),
            assignee_name: assignee === undefined ? undefined : (assignee?.name ?? null),
          }),
          `case_tasks ${taskId} is not a task of recruitment_cases ${id}`,
        ),
      /** Link a request, a trial (each once) or the signing. */
      link: (id, { requestId, trialId, signingId }) => {
        const once = (table, col, value) =>
          q(
            `INSERT INTO ${table} (case_id, position, ${col}) SELECT @case_id, @position, @value WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE case_id = @case_id AND ${col} = @value)`,
          ).run({ case_id: id, position: nextPosition(table, 'case_id', id), value });
        if (requestId !== undefined) once('case_request_links', 'request_id', requestId);
        if (trialId !== undefined) once('case_trial_links', 'trial_id', trialId);
        if (signingId !== undefined)
          q('UPDATE recruitment_cases SET links_signing_id = ? WHERE id = ?').run(signingId, id);
      },
      requestApproval: (id, { approval: a }) => {
        appendTo('case_approvals', id, (p) => approvalRow(id, a, p));
        return storedAs(id, a, `approval ${a.id}`, (c) => c.approvals.find((x) => x.id === a.id));
      },
      /** Approve or reject a pending approval; `by` is `{ userId, name, at }`. */
      resolveApproval: (id, { approvalId, status, by }) =>
        guarded(
          'case_approvals',
          { case_id: id, id: approvalId },
          "status = 'pending'",
          { status, ...resolvedCols(by) },
          `case_approvals ${approvalId} of recruitment_cases ${id} is not pending`,
        ),
      /** The case's sign-off decision. */
      recordDecision: (id, { decision }) => {
        q(
          `UPDATE recruitment_cases SET ${Object.keys(caseDecisionCols(null))
            .map((c) => `${c} = @${c}`)
            .join(', ')} WHERE id = @id`,
        ).run({ ...caseDecisionCols(decision), id });
        return storedAs(id, decision, 'decision', (c) => c.decision);
      },
      /** A plain case's stage. A Room's stage follows its status (`moveRoom`) and is never written alone. */
      setStage: (id, { stage }) =>
        guarded(
          CASE,
          { id },
          'room_status IS NULL',
          { stage },
          `recruitment_cases ${id} has a Room; its stage follows the Room's status`,
        ),
      startDraft: (id, { draft }) => {
        if (st.draftOf.get(id)) throw refusal('STATE_CONFLICT', `recruitment_cases ${id} already has a decision draft`);
        childrenOf(id).draft(draft);
        return storedAs(id, draft, 'decisionDraft', (c) => c.decisionDraft);
      },
      /** Change the draft's content (an absent field stays) and move its rev. */
      editDraft: (id, { outcome, reasonCodes, note, evidenceRefs, at, by }) => {
        guarded(
          'case_decision_drafts',
          { case_id: id },
          null,
          { ...given({ outcome, note }), updated_at: at, ...personRow('updated_by', by, ['role']), rev_at: at },
          `recruitment_cases ${id} has no decision draft`,
          { set: 'rev = rev + 1' },
        );
        const step = (part, fn) => rowStep(CASE, id, part, fn);
        const L = (field, v, opts) => listOf(CASE, id, field, v, opts);
        if (reasonCodes !== undefined) {
          q('DELETE FROM case_decision_draft_reason_codes WHERE case_id = ?').run(id);
          L('decisionDraft.reasonCodes', reasonCodes).forEach((code, i) =>
            step(`decision draft reason ${i}`, () =>
              st.ins.case_decision_draft_reason_codes.run(codeRow('case_id', id, code, i)),
            ),
          );
        }
        if (evidenceRefs !== undefined) {
          q('DELETE FROM case_decision_draft_evidence_refs WHERE case_id = ?').run(id);
          L('decisionDraft.evidenceRefs', evidenceRefs, { objects: true }).forEach((r, i) =>
            step(`decision draft evidence ${i}`, () =>
              st.ins.case_decision_draft_evidence_refs.run(refRow('case_id', id, r, i)),
            ),
          );
        }
      },
      /** The draft goes: discarded, or become a formal decision. */
      discardDraft: (id) => {
        if (q('DELETE FROM case_decision_drafts WHERE case_id = ?').run(id).changes !== 1)
          throw refusal('STATE_CONFLICT', `recruitment_cases ${id} has no decision draft`);
      },
      /** Invite a transaction workspace. It replaces a withdrawn or lapsed invitation, never an accepted one. */
      inviteHandoff: (id, { handoff: h }) => {
        const current = st.handoffOf.get(id);
        if (current?.status === 'accepted')
          throw refusal('STATE_CONFLICT', `recruitment_cases ${id} has an accepted transaction handoff`);
        if (current) q('DELETE FROM case_transaction_handoffs WHERE case_id = ?').run(id);
        st.ins.case_transaction_handoffs.run(handoffRow(id, h));
        return storedAs(id, h, 'transactionHandoff', (c) => c.transactionHandoff);
      },
      withdrawHandoff: (id, { at }) =>
        guarded(
          'case_transaction_handoffs',
          { case_id: id },
          "status = 'invited'",
          { status: 'withdrawn', withdrawn_at: at, rev_at: at },
          `recruitment_cases ${id} has no open transaction handoff`,
          { set: 'rev = rev + 1' },
        ),
      /** The invitation taken up by the transaction it opened. */
      acceptHandoff: (id, { at, transactionId }) =>
        guarded(
          'case_transaction_handoffs',
          { case_id: id },
          "status = 'invited'",
          { status: 'accepted', accepted_at: at, transaction_id: transactionId, rev_at: at },
          `recruitment_cases ${id} has no open transaction handoff`,
          { set: 'rev = rev + 1' },
        ),
      addScenario: (id, { scenario: s }) => {
        childrenOf(id).scenario(s, nextPosition('case_budget_scenarios', 'case_id', id));
        return storedAs(id, s, `budget scenario ${s.id}`, (c) => c.budget?.scenarios.find((x) => x.id === s.id));
      },
      /** A new version of a scenario (an absent field stays; `lines` and `fxAssumptions` replace the lists). An approval of an earlier version is kept, marked superseded. */
      editScenario: (id, { scenarioId, label, termMonths, lines, fxAssumptions, at }) => {
        guarded(
          'case_budget_scenarios',
          { case_id: id, id: scenarioId },
          null,
          { ...given({ label, term_months: termMonths }), updated_at: at },
          `case_budget_scenarios ${scenarioId} is not a scenario of recruitment_cases ${id}`,
          { set: 'version = version + 1, approval_superseded = CASE WHEN approval_at IS NULL THEN NULL ELSE 1 END' },
        );
        const step = (part, fn) => rowStep(CASE, id, part, fn);
        const L = (field, v) => listOf(CASE, id, field, v, { objects: true });
        if (lines !== undefined) {
          q('DELETE FROM case_budget_lines WHERE case_id = ? AND scenario_id = ?').run(id, scenarioId);
          L(`budget scenario ${scenarioId} lines`, lines).forEach((l, j) =>
            step(`budget scenario ${scenarioId} line ${l.id}`, () =>
              st.ins.case_budget_lines.run(lineRow(id, scenarioId, l, j)),
            ),
          );
        }
        if (fxAssumptions !== undefined) {
          q('DELETE FROM case_budget_fx_assumptions WHERE case_id = ? AND scenario_id = ?').run(id, scenarioId);
          L(`budget scenario ${scenarioId} fxAssumptions`, fxAssumptions).forEach((a, j) =>
            step(`budget scenario ${scenarioId} fx ${j}`, () =>
              st.ins.case_budget_fx_assumptions.run(fxRow(id, scenarioId, a, j)),
            ),
          );
        }
      },
      /** A lead's approval of the scenario's current version. */
      approveScenario: (id, { scenarioId, by, byUserId, at }) =>
        guarded(
          'case_budget_scenarios',
          { case_id: id, id: scenarioId },
          null,
          { approval_by_name: by, approval_by_user_id: byUserId, approval_at: at, approval_superseded: 0 },
          `case_budget_scenarios ${scenarioId} is not a scenario of recruitment_cases ${id}`,
          { set: 'approval_version = version' },
        ),
      recordActual: (id, { scenarioId, actual: a }) =>
        appendTo('case_budget_actuals', id, (p) => actualRow(id, scenarioId, a, p), { scenario_id: scenarioId }),
    }),
  };

  const cases = {
    ...caseWrites,
    byId: (id) => find('recruitmentCases', id),
    forOrg: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE org_id = ? ORDER BY rowid'),
    forPlayer: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE player_id = ? ORDER BY rowid'),
    forOrgPlayer: list(
      'recruitmentCases',
      'SELECT * FROM recruitment_cases WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    /** The cases whose transaction handoff invites this agent (any organisation). */
    forHandoffAgent: list(
      'recruitmentCases',
      'SELECT c.* FROM recruitment_cases c JOIN case_transaction_handoffs h ON h.case_id = c.id WHERE h.invited_agent_user_id = ? ORDER BY c.rowid',
    ),
    countForOrg: count('SELECT COUNT(*) AS n FROM recruitment_cases WHERE org_id = ?'),
    /** Every case that has a Room (the boot integrity report reads them once). */
    withRoom: list('recruitmentCases', 'SELECT * FROM recruitment_cases WHERE room_status IS NOT NULL ORDER BY rowid'),
    roomCount: count('SELECT COUNT(*) AS n FROM recruitment_cases WHERE room_status IS NOT NULL'),
    /** Room statuses of the organisation's Rooms, counted: `{ status: n }`; with a viewer, only the Rooms they may open. */
    roomStatusCounts(orgId, viewer = null) {
      const a = viewer ? access(viewer, { room: true }) : { sql: '1', params: [] };
      return Object.fromEntries(
        sqlite
          .prepare(
            `SELECT c.room_status AS status, COUNT(*) AS n FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND ${a.sql} GROUP BY c.room_status`,
          )
          .all(orgId, ...a.params)
          .map((r) => [r.status, r.n]),
      );
    },
    /**
     * The club's cases list: the cases `viewer` may open, optionally at one stage, newest first by
     * cursor ([createdAt, id]), filtered and paged in SQL; only the page is decoded.
     */
    pageForViewer(orgId, viewer, { stage = null } = {}, page) {
      const a = access(viewer, { room: false });
      const where = [`c.org_id = ?`, a.sql, ...(stage === null ? [] : ['c.stage = ?'])];
      return keyset({
        where,
        params: [orgId, ...a.params, ...(stage === null ? [] : [stage])],
        page,
        order: 'c.created_at DESC, c.id DESC',
        after: '(c.created_at < ? OR (c.created_at = ? AND c.id < ?))',
        rowKey: (r) => [r.created_at, r.id],
        key: (c) => [c.createdAt, c.id],
      });
    },
    /**
     * The club's Rooms list: the Rooms `viewer` may open, filtered (`roomFilter`) and paged in SQL by
     * most recent activity ([room.updatedAt, id]); only the page is decoded. `accept(light)` is a filter SQL cannot
     * express (the search, which needs the player's visibility): it sees `{ id, playerId, playerName, status, tags }`
     * and the rows are read in chunks until the page is full.
     */
    roomPageForViewer(orgId, viewer, filter, page, accept = null) {
      const f = roomWhere(viewer, filter);
      return keyset({
        where: ['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where],
        params: [orgId, ...f.params],
        page,
        order: 'c.room_updated_at DESC, c.id ASC',
        after: '(c.room_updated_at < ? OR (c.room_updated_at = ? AND c.id > ?))',
        rowKey: (r) => [r.room_updated_at, r.id],
        key: (c) => [c.room.updatedAt, c.id],
        accept,
      });
    },
    /** The Rooms `viewer` may open, filtered like the list, in insertion order, as light rows `{ id, playerId, playerName, status }` (nothing decoded). */
    roomRowsForViewer(orgId, viewer, filter = {}) {
      const f = roomWhere(viewer, filter);
      return sqlite
        .prepare(
          `SELECT c.id, c.player_id, c.player_name, c.room_status FROM recruitment_cases c WHERE ${['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where].join(' AND ')} ORDER BY c.rowid`,
        )
        .all(orgId, ...f.params)
        .map(light);
    },
    /**
     * The history of the organisation's Rooms with one of `actions`, newest first, for a merged feed (the audit feed):
     * `{ caseId, playerId, entry }` with the entry as a case's history holds it. See `newestHistory` for `atMost`/`n`.
     */
    roomHistoryFeed(orgId, actions, atMost, n) {
      return newestHistory(
        sqlite,
        { select: 'h.*, c.player_id AS owner_player_id', ...roomHistoryFrom(orgId, actions) },
        atMost,
        n,
      ).map((h) => ({ caseId: h.case_id, playerId: h.owner_player_id, entry: historyOut(h) }));
    },
    /** How many entries `roomHistoryFeed` holds in all. */
    roomHistoryCount(orgId, actions) {
      const f = roomHistoryFrom(orgId, actions);
      return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params).n;
    },
    /** Open and in-progress tasks of the organisation's cases due (an instant) before `at`, counted by case: `Map(caseId → n)`. */
    overdueTaskCounts(orgId, at) {
      return new Map(
        sqlite
          .prepare(
            "SELECT t.case_id, COUNT(*) AS n FROM case_tasks t JOIN recruitment_cases c ON c.id = t.case_id WHERE c.org_id = ? AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at <> 0 AND t.due_at < ? GROUP BY t.case_id",
          )
          .all(orgId, at)
          .map((r) => [r.case_id, r.n]),
      );
    },
  };
  /**
   * Who may open a case or a Room, as SQL over `recruitment_cases c`: the rule of `caseAccess` (domains/scouting/scouting.mjs) and,
   * for a Room, of `roomRole` (domains/recruitment/rooms/shared.mjs) being non-null. A recruitment lead opens everything.
   */
  function access({ userId, isLead }, { room }) {
    if (isLead) return { sql: '1', params: [] };
    return {
      sql: `(c.restricted = 0 OR c.owner_user_id = ?${room ? ' OR c.room_lead_scout_user_id = ?' : ''} OR EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ?))`,
      params: room ? [userId, userId, userId] : [userId, userId],
    };
  }
  /** The Rooms list's filters as SQL (each optional): statuses, one status, owned or led by, assigned to, a tag, an assignee. */
  function roomWhere(
    viewer,
    { statuses = null, status = null, mineOf = null, assignedTo = null, tag = null, assignee = null } = {},
  ) {
    const a = access(viewer, { room: true });
    const where = [a.sql];
    const params = [...a.params];
    const add = (sql, ...p) => {
      where.push(sql);
      params.push(...p);
    };
    if (statuses) add(statuses.length ? `c.room_status IN (${statuses.map(() => '?').join(', ')})` : '0', ...statuses);
    if (status !== null) add('c.room_status = ?', status);
    if (mineOf !== null) add('(c.owner_user_id = ? OR c.room_lead_scout_user_id = ?)', mineOf, mineOf);
    if (assignedTo !== null)
      add(
        "(EXISTS (SELECT 1 FROM case_assignments a2 WHERE a2.case_id = c.id AND a2.user_id = ?) OR EXISTS (SELECT 1 FROM case_tasks t WHERE t.case_id = c.id AND t.assignee_user_id = ? AND t.status IN ('open', 'in_progress')))",
        assignedTo,
        assignedTo,
      );
    if (tag !== null) add('EXISTS (SELECT 1 FROM case_room_tags g WHERE g.case_id = c.id AND g.tag = ?)', tag);
    if (assignee !== null)
      add(
        '(EXISTS (SELECT 1 FROM case_tasks t2 WHERE t2.case_id = c.id AND t2.assignee_user_id = ?) OR c.room_lead_scout_user_id = ? OR c.owner_user_id = ?)',
        assignee,
        assignee,
        assignee,
      );
    return { where, params };
  }
  const light = (r) => ({ id: r.id, playerId: r.player_id, playerName: r.player_name, status: r.room_status });
  const roomHistoryFrom = (orgId, actions) => ({
    from: 'case_history h JOIN recruitment_cases c ON c.id = h.case_id',
    where: `c.org_id = ? AND c.room_status IS NOT NULL AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`,
    params: [orgId, ...actions],
  });
  /**
   * Keyset paging over `recruitment_cases c`: `limit + 1` rows after the cursor, decoded in one batch. With `accept`,
   * rows are read in chunks and kept only when accepted (with their tags), until the page is full or the rows end.
   */
  function keyset({
    where,
    params,
    page: { limit, after = null },
    order,
    after: afterSql,
    rowKey,
    key,
    accept = null,
  }) {
    const chunk = accept ? Math.max(limit + 1, 200) : limit + 1;
    const kept = [];
    let cursor = after;
    for (;;) {
      const sql = `SELECT c.* FROM recruitment_cases c WHERE ${[...where, ...(cursor ? [afterSql] : [])].join(' AND ')} ORDER BY ${order} LIMIT ?`;
      const rows = sqlite.prepare(sql).all(...params, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), chunk);
      let tags = null;
      if (accept && rows.length) {
        tags = new Map();
        for (const t of sqlite
          .prepare(
            `SELECT case_id, tag FROM case_room_tags WHERE case_id IN (${rows.map(() => '?').join(',')}) ORDER BY case_id, position`,
          )
          .all(...rows.map((r) => r.id))) {
          if (!tags.has(t.case_id)) tags.set(t.case_id, []);
          tags.get(t.case_id).push(t.tag);
        }
      }
      for (const r of rows) {
        if (!accept || accept({ ...light(r), tags: tags.get(r.id) ?? [] })) kept.push(r);
        if (kept.length > limit) break;
      }
      if (kept.length > limit || rows.length < chunk) break;
      cursor = rowKey(rows[rows.length - 1]);
    }
    return pageOf(decodeAll('recruitmentCases', kept), limit, key);
  }
  const forRoom = (name) => list(name, `SELECT * FROM ${PARENT[name]} WHERE room_id = ? ORDER BY rowid`);
  const rowReads = (name) => ({ byId: (id) => find(name, id), forRoom: forRoom(name) });
  const comments = {
    create: create('roomComments'),
    ...rowActs('roomComments', {
      /** A new body for a comment that is not deleted. */
      edit: (id, { body, at }) =>
        guarded(
          'room_comments',
          { id },
          'deleted_at IS NULL',
          { body, edited_at: at },
          `room_comments ${id} is deleted`,
          { set: 'edit_count = edit_count + 1' },
        ),
      /** A tombstone: the thread keeps its shape and the trail its attribution; `by` is `{ userId, name }`. */
      remove: (id, { at, by }) =>
        guarded(
          'room_comments',
          { id },
          null,
          { deleted_at: at, ...personRow('deleted_by', by) },
          `room_comments ${id} is not there`,
        ),
    }),
    ...rowReads('roomComments'),
  };
  const snapshots = { create: create('roomSnapshots'), ...rowReads('roomSnapshots') };
  const decisions = {
    create: create('roomDecisions'),
    ...rowActs('roomDecisions', {
      /** The decision that replaced this one; a decision is superseded once. */
      markSuperseded: (id, { by }) =>
        guarded(
          'room_decisions',
          { id },
          'superseded_by_id IS NULL',
          { superseded_by_id: by },
          `room_decisions ${id} is already superseded`,
        ),
      /** The case move a formal decision asked for, once the move has been tried. */
      recordLifecycle: (id, { lifecycle }) =>
        guarded('room_decisions', { id }, null, lifecycleCols(lifecycle), `room_decisions ${id} is not there`),
      bump: (id, { at }) =>
        guarded('room_decisions', { id }, null, { rev_at: at }, `room_decisions ${id} is not there`, {
          set: 'rev = COALESCE(rev, 1) + 1',
        }),
    }),
    ...rowReads('roomDecisions'),
    /** The decisions of several Rooms (a player's journeys), in insertion order. */
    forRooms: inList('roomDecisions', 'room_id'),
    forOrgPlayer: list(
      'roomDecisions',
      'SELECT * FROM room_decisions WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    forOrg: list('roomDecisions', 'SELECT * FROM room_decisions WHERE org_id = ? ORDER BY rowid'),
    /** The ids of the organisation's Rooms that hold any decision (a Set; nothing decoded). */
    roomIdsForOrg: (orgId) =>
      new Set(
        sqlite
          .prepare(
            'SELECT DISTINCT d.room_id FROM room_decisions d JOIN recruitment_cases c ON c.id = d.room_id WHERE c.org_id = ?',
          )
          .all(orgId)
          .map((r) => r.room_id),
      ),
  };
  const evidenceStates = {
    create: create('roomEvidenceState'),
    ...rowActs('roomEvidenceState', {
      /** A new review of the evidence by the Room. */
      review: (id, { state, note, byId, byName, at }) =>
        guarded(
          'room_evidence_states',
          { id },
          null,
          { state, note, by_user_id: byId, by_name: byName, at },
          `room_evidence_states ${id} is not there`,
        ),
    }),
    ...rowReads('roomEvidenceState'),
  };
  WRITES.add('create');
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = Object.fromEntries(
    RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${PARENT[n]}`)]),
  );

  return {
    cases,
    comments,
    snapshots,
    decisions,
    evidenceStates,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({
      cases: readOnly(cases),
      comments: readOnly(comments),
      snapshots: readOnly(snapshots),
      decisions: readOnly(decisions),
      evidenceStates: readOnly(evidenceStates),
    }),
    /** The deletion unit: a deleted player's cases keep their ids, states and history and lose the name. */
    redactPlayer(playerId, at) {
      return operation(
        () =>
          sqlite
            .prepare('UPDATE recruitment_cases SET player_name = NULL, subject_removed_at = ? WHERE player_id = ?')
            .run(at, playerId).changes,
      );
    },
    /** Check migration 0016 is recorded; there is nothing to load. */
    attach() {
      if (!recruitmentCasesLive(sqlite))
        throw new Error(
          `the recruitment-cases repository needs ${RECRUITMENT_CASES_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((n) => [n, readAll(sqlite, n)]));
    },
    log,
    now,
  };
}
