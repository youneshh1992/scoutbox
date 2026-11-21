/**
 * Recruitment cases (with the Room facet, decision draft, transaction handoff and budget), room comments, room
 * snapshots, room decisions and room evidence states.
 *
 * Records (the keys every reader sees): `RecruitmentCase`, `RoomComment`, `RoomSnapshot`, `RoomDecision` and
 * `RoomEvidenceState` below, deep-frozen as read back.
 *
 * Every field is a typed column with the vocabulary CHECKs of the domain rules (domains/recruitment/rooms/shared.mjs,
 * domains/recruitment/lifecycle/decision.mjs, domains/recruitment/money.mjs, domains/agents/integration/integration.mjs). A case's history has one entry shape
 * (`{ id, at, byKind, byId, byName, action, detail }`), and a decision's `snapshot` is read from the room_snapshots row
 * it names (it is that row, never a second copy). The idempotency keys are columns of their owner (a draft's create key,
 * a decision's finalize and draft keys, a handoff's invite key).
 *
 * Writes (repositories/writes.ts). A record is created whole and must read back as written (an unknown field, or a
 * value a column would coerce, is refused). It then changes only through named acts, each an UPDATE or INSERT of the
 * rows it concerns: a case through `moveRoom`, `addTask`, `startDraft`, `inviteHandoff`, `addScenario` and the rest, a
 * comment through `edit` and `remove`, a decision through `markSuperseded`, `recordLifecycle` and `bump`, an evidence
 * state through `review`. History is only appended. A Room moves only along `ROOM_TRANSITIONS`, an approval and a
 * handoff only out of their open state, and a plain case's stage is the only stage written directly. An absent field
 * reads back as null and an absent list as empty, so the input types let either be left out. A caller still in
 * JavaScript can pass anything: the columns judge it.
 *
 * References. org_id → orgs and the staff ids (owner, lead scout, decision maker, assignee, comment author) →
 * org_users, RESTRICT. Every room row's room_id → recruitment_cases RESTRICT. The pointers inside a room are composite
 * keys `(room_id, …)` into the same room's rows: a decision's snapshot, its chain (supersedes / superseded by) and a
 * comment's reply. case_request_links → recruitment_requests and case_trial_links → trials RESTRICT. Player ids: no
 * key, tolerant and counted (Q8a in docs/decisions.md). The children cascade with their owner.
 *
 * Refusals name tables, fields and ids, never a name, a note, a body or a message.
 */
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  migrationApplied,
  newestHistory,
  childRowsOf,
  operationOn,
  type Row,
  type UnitParticipant,
} from './database.ts';
import { pageOf, readsOf } from './identityRules.ts';
import { isPlainObject } from './fieldSpecs.ts';
import { writeChecks, writeKit, type Flatten, type InputFor, type RowOf } from './writes.ts';
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
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';

export const RECRUITMENT_CASES_MIGRATION = '0016_recruitment_cases';
export const RECRUITMENT_CASES_COLLECTIONS = Object.freeze([
  'recruitmentCases',
  'roomComments',
  'roomSnapshots',
  'roomDecisions',
  'roomEvidenceState',
] as const);
export type RecruitmentCasesCollection = (typeof RECRUITMENT_CASES_COLLECTIONS)[number];
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
] as const);
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
] as const);
export const RECRUITMENT_CASES_TABLES = Object.freeze([...CASE_TABLES, ...ROOM_TABLES] as const);
type CasesTable = (typeof RECRUITMENT_CASES_TABLES)[number];
export const recruitmentCasesLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, RECRUITMENT_CASES_MIGRATION);
const checks = writeChecks('RECRUITMENT_CASES');
const { rowStep, listOf, readsBackAsWritten } = checks;
// An assertion function is only callable through a name declared with its type.
const newRecord: typeof checks.newRecord = checks.newRecord;

// ------------------------------------------------------------------ vocabulary
/** Who a case history entry names: a club user (`org` or `org_user`), a family member, the platform, an agent. */
export const CASE_ACTOR_KINDS = Object.freeze([
  'org',
  'org_user',
  'player',
  'guardian',
  'system',
  'admin',
  'agent',
] as const);
export type CaseActorKind = (typeof CASE_ACTOR_KINDS)[number];
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export type RoomPriority = (typeof ROOM_PRIORITIES)[number];
export type SourceContext = (typeof SOURCE_CONTEXTS)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type LinkedResourceType = (typeof LINKED_RESOURCE_TYPES)[number];
export type EvidenceReviewState = (typeof EVIDENCE_REVIEW_STATES)[number];
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export type CaseStage = (typeof CASE_STAGES)[number];
export type CasePriority = (typeof CASE_PRIORITIES)[number];
export type CaseDecisionOutcome = (typeof CASE_DECISION_OUTCOMES)[number];
export type CaseApprovalState = (typeof CASE_APPROVAL_STATES)[number];
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type DecisionState = (typeof DECISION_STATES)[number];
export type EvidenceRefKind = (typeof EVIDENCE_REF_KINDS)[number];
export type Currency = (typeof CURRENCIES)[number];
export type BudgetLineKind = (typeof BUDGET_LINE_KINDS)[number];
export type BudgetSchedule = (typeof BUDGET_SCHEDULES)[number];
/** A handoff's stored status (`expired` is read from its age, never stored). */
export type HandoffStoredStatus = Exclude<(typeof HANDOFF_STATUSES)[number], 'expired'>;
const HANDOFF_STORED = HANDOFF_STATUSES.filter((s): s is HandoffStoredStatus => s !== 'expired');
const SOURCE_REF_KINDS = ['evidence', 'assessment', 'combine', 'trial'] as const;
type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];
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

// ------------------------------------------------------------------ records
/** A club member as a case names them. */
export type Person = { userId: string | null; name: string | null };
export type PersonWithRole = Person & { role: string | null };
/** A due date or a deadline: a `YYYY-MM-DD` day or an instant in ms. */
export type Due = string | number | null;
type KeyFp = { key: string; fp: string };
type SourceRefFields = { id: string; version: number | null };
type ReopenedFields = {
  by: Person | null;
  at: number;
  from: RoomStatus | null;
  reasonCodes: string[];
  sourceContext: SourceContext | null;
  sourceRef: SourceRefFields | null;
};
type RoomFields = {
  status: RoomStatus;
  priority: RoomPriority;
  tags: string[];
  leadScoutUserId: string | null;
  sourceContext: SourceContext | null;
  sourceRef: SourceRefFields | null;
  openedBy: Person | null;
  updatedAt: number;
  archivedAt: number | null;
  closedAt: number | null;
  rev: number;
  revAt: number | null;
  revBy: Person | null;
  reopened: ReopenedFields | null;
};
type AssignmentFields = {
  id: string;
  userId: string;
  name: string | null;
  task: string;
  dueAt: Due;
  status: TaskState;
  createdAt: number;
};
type TaskFields = {
  id: string;
  title: string;
  description: string | null;
  dueAt: Due;
  assigneeUserId: string | null;
  assigneeName: string | null;
  status: TaskState;
  linkedResourceType: LinkedResourceType | null;
  linkedResourceId: string | null;
  createdBy: Person | null;
  createdAt: number;
  completedAt: number | null;
  completedBy: string | null;
};
type ApprovalFields = {
  id: string;
  decision: { outcome: CaseDecisionOutcome; reasons: string | null };
  requestedBy: Person | null;
  status: CaseApprovalState;
  requestedAt: number;
  resolvedBy: { userId: string | null; name: string | null; at: number } | null;
};
/** The case's sign-off decision (not a Room decision). */
type CaseDecisionFields = {
  outcome: CaseDecisionOutcome;
  reasons: string | null;
  byUserId: string | null;
  byName: string | null;
  approvedBy: string | null;
  at: number;
};
type LinksFields = { requestIds: string[]; trialIds: string[]; signingId: string | null };
type CaseHistoryFields = {
  id: string;
  at: number;
  byKind: CaseActorKind | null;
  byId: string | null;
  byName: string | null;
  action: string;
  /** Free text, or an object of details. */
  detail: Record<string, unknown> | string | null;
};
type EvidenceRefFields = { kind: EvidenceRefKind; id: string; meta: Record<string, unknown> | null };
type DecisionDraftFields = {
  id: string;
  outcome: DecisionOutcome | null;
  reasonCodes: string[];
  note: string | null;
  evidenceRefs: EvidenceRefFields[];
  by: PersonWithRole | null;
  createdAt: number;
  updatedAt: number;
  updatedBy: PersonWithRole | null;
  rev: number;
  revAt: number | null;
  keys: { create: KeyFp | null };
};
type HandoffFields = {
  id: string;
  caseId: string;
  orgId: string;
  playerId: string;
  status: HandoffStoredStatus;
  invitedAt: number;
  invitedBy: { kind: 'org'; userId: string | null; name: string | null } | null;
  acceptedAt: number | null;
  withdrawnAt: number | null;
  transactionId: string | null;
  representedAtInvitation: boolean;
  invitedAgencyOrgId: string | null;
  invitedAgentUserId: string | null;
  keys: { invite: { key: string } | null };
  rev: number;
  revAt: number | null;
};
type BudgetLineFields = {
  id: string;
  kind: BudgetLineKind;
  label: string;
  amountMinor: number;
  currency: Currency;
  schedule: BudgetSchedule;
  confirmed: boolean;
  conditional: { assumption: string } | null;
};
type FxAssumptionFields = {
  from: Currency;
  to: Currency;
  rate: string;
  source: string | null;
  date: string;
  manual: boolean;
};
type BudgetActualFields = {
  id: string;
  lineId: string;
  amountMinor: number;
  at: number;
  recordedBy: string | null;
};
type ScenarioApprovalFields = {
  by: string | null;
  byUserId: string | null;
  at: number;
  version: number;
  superseded: boolean;
};
type ScenarioFields = {
  id: string;
  version: number;
  label: string;
  currency: Currency;
  termMonths: number;
  lines: BudgetLineFields[];
  fxAssumptions: FxAssumptionFields[];
  approval: ScenarioApprovalFields | null;
  actuals: BudgetActualFields[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
};
type CaseFields = {
  id: string;
  orgId: string;
  playerId: string;
  playerName: string | null;
  vacancyId: string | null;
  ownerUserId: string;
  ownerName: string | null;
  stage: CaseStage;
  priority: CasePriority;
  deadline: Due;
  restricted: boolean;
  assignments: AssignmentFields[];
  tasks: TaskFields[];
  approvals: ApprovalFields[];
  decision: CaseDecisionFields | null;
  links: LinksFields;
  createdAt: number;
  history: CaseHistoryFields[];
  /** The Room facet; null on a plain case. */
  room: RoomFields | null;
  decisionDraft: DecisionDraftFields | null;
  transactionHandoff: HandoffFields | null;
  /** Null when the case has no scenario. */
  budget: { scenarios: ScenarioFields[] } | null;
  subjectRemovedAt: number | null;
};
type CommentFields = {
  id: string;
  roomId: string;
  orgId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  replyToId: string | null;
  mentions: string[];
  createdAt: number;
  editedAt: number | null;
  editCount: number;
  deletedAt: number | null;
  deletedBy: Person | null;
};
type TrustFields = {
  score: number | null;
  band: string | null;
  policyVersion: number | null;
  componentLevels: Record<string, unknown>;
  hash: string;
};
type SnapshotSourceRefsFields = {
  passportVersion: number | null;
  passportRevision: string | null;
  evidenceIds: string[];
  assessmentIds: string[];
  combineResults: string[];
  trialIds: string[];
};
type SnapshotFields = {
  id: string;
  roomId: string;
  orgId: string;
  playerId: string;
  at: number;
  trigger: string;
  trust: TrustFields | null;
  sourceRefs: SnapshotSourceRefsFields;
  note: string | null;
};
type AssessmentSummaryFields = {
  submitted: number;
  withheld: number;
  verdicts: Record<string, unknown>;
  assessmentIds: string[];
};
/** The case move a formal decision asked for, and what came of it. */
type DecisionLifecycleFields = {
  action: string | null;
  from: RoomStatus | null;
  to: RoomStatus | null;
  applied: boolean;
  reason: string | null;
  at: number | null;
};
type DecisionFields = {
  id: string;
  roomId: string;
  orgId: string;
  playerId: string;
  kind: DecisionKind | null;
  state: DecisionState | null;
  outcome: DecisionOutcome | null;
  recommendation: Recommendation;
  reasonCodes: string[];
  note: string | null;
  by: PersonWithRole | null;
  createdAt: number;
  finalizedAt: number | null;
  trigger: string | null;
  clientKey: string | null;
  supersedes: string | null;
  supersededById: string | null;
  supersession: { of: string; reason: string } | null;
  rev: number | null;
  revAt: number | null;
  evidenceRefs: EvidenceRefFields[];
  assessmentSummary: AssessmentSummaryFields | null;
  /** The room_snapshots row the decision names, as it reads. */
  snapshot: {
    at: number;
    trust: TrustFields | null;
    sourceRefs: SnapshotSourceRefsFields;
    snapshotId: string;
  } | null;
  keys: { finalize: KeyFp | null; draft: KeyFp | null };
  draftId: string | null;
  lifecycle: DecisionLifecycleFields | null;
  policyVersion: number | null;
};
type EvidenceStateFields = {
  id: string;
  roomId: string;
  orgId: string;
  evidenceId: string;
  state: EvidenceReviewState;
  note: string | null;
  byId: string | null;
  byName: string | null;
  at: number;
};

export type RecruitmentCase = DeepReadonly<CaseFields>;
export type CaseRoom = DeepReadonly<RoomFields>;
export type CaseAssignment = DeepReadonly<AssignmentFields>;
export type CaseTask = DeepReadonly<TaskFields>;
export type CaseApproval = DeepReadonly<ApprovalFields>;
export type CaseDecision = DeepReadonly<CaseDecisionFields>;
export type CaseHistoryEntry = DeepReadonly<CaseHistoryFields>;
export type EvidenceRef = DeepReadonly<EvidenceRefFields>;
export type DecisionDraft = DeepReadonly<DecisionDraftFields>;
export type TransactionHandoff = DeepReadonly<HandoffFields>;
export type BudgetScenario = DeepReadonly<ScenarioFields>;
export type RoomComment = DeepReadonly<CommentFields>;
export type RoomSnapshot = DeepReadonly<SnapshotFields>;
export type RoomDecision = DeepReadonly<DecisionFields>;
export type DecisionLifecycle = DeepReadonly<DecisionLifecycleFields>;
export type RoomEvidenceState = DeepReadonly<EvidenceStateFields>;
type FieldsOf = {
  recruitmentCases: CaseFields;
  roomComments: CommentFields;
  roomSnapshots: SnapshotFields;
  roomDecisions: DecisionFields;
  roomEvidenceState: EvidenceStateFields;
};
type RecordOf = { [N in RecruitmentCasesCollection]: DeepReadonly<FieldsOf[N]> };
export type RecruitmentCasesRecords = { [N in RecruitmentCasesCollection]: RecordOf[N][] };

// ------------------------------------------------------------------ inputs
export type PersonInput = InputFor<Person>;
export type PersonWithRoleInput = InputFor<PersonWithRole>;
export type RoomInput = InputFor<RoomFields>;
export type ReopenedInput = InputFor<ReopenedFields>;
export type CaseAssignmentInput = InputFor<AssignmentFields>;
export type CaseTaskInput = InputFor<TaskFields>;
export type CaseApprovalInput = InputFor<ApprovalFields>;
export type CaseDecisionInput = InputFor<CaseDecisionFields>;
export type CaseHistoryInput = InputFor<CaseHistoryFields>;
export type EvidenceRefInput = InputFor<EvidenceRefFields>;
/** A new draft; its create key may be left out. */
export type DecisionDraftInput = Flatten<
  Omit<InputFor<DecisionDraftFields>, 'keys'> & { keys?: { create?: KeyFp | null } }
>;
/** A new handoff; its case is the case it is written on, and its invite key may be left out. */
export type TransactionHandoffInput = Flatten<
  Omit<InputFor<HandoffFields>, 'caseId' | 'keys'> & { caseId?: string; keys?: { invite?: { key: string } | null } }
>;
export type BudgetLineInput = InputFor<BudgetLineFields>;
export type FxAssumptionInput = InputFor<FxAssumptionFields>;
export type BudgetActualInput = InputFor<BudgetActualFields>;
export type BudgetScenarioInput = InputFor<ScenarioFields>;
/** A new case, whole; `restricted` is false and `links` empty when left out. */
export type RecruitmentCaseInput = Flatten<
  Omit<InputFor<CaseFields>, 'restricted' | 'links' | 'decisionDraft' | 'transactionHandoff'> & {
    restricted?: boolean;
    links?: InputFor<LinksFields>;
    decisionDraft?: DecisionDraftInput | null;
    transactionHandoff?: TransactionHandoffInput | null;
  }
>;
/** A new comment; `editCount` is 0 when left out. */
export type RoomCommentInput = Flatten<Omit<InputFor<CommentFields>, 'editCount'> & { editCount?: number }>;
/** A new snapshot; its source references and component levels may be left out. */
export type RoomSnapshotInput = Flatten<
  Omit<InputFor<SnapshotFields>, 'sourceRefs' | 'trust'> & {
    sourceRefs?: InputFor<SnapshotSourceRefsFields>;
    trust?: Flatten<
      Omit<InputFor<TrustFields>, 'componentLevels'> & { componentLevels?: Record<string, unknown> }
    > | null;
  }
>;
export type DecisionLifecycleInput = InputFor<DecisionLifecycleFields>;
/** A new decision; its keys may be left out, and an assessment summary's `withheld` is 0 when left out. */
export type RoomDecisionInput = Flatten<
  Omit<InputFor<DecisionFields>, 'keys' | 'assessmentSummary'> & {
    keys?: { finalize?: KeyFp | null; draft?: KeyFp | null };
    assessmentSummary?: Flatten<Omit<InputFor<AssessmentSummaryFields>, 'withheld'> & { withheld?: number }> | null;
  }
>;
export type RoomEvidenceStateInput = InputFor<EvidenceStateFields>;
type InputOf = {
  recruitmentCases: RecruitmentCaseInput;
  roomComments: RoomCommentInput;
  roomSnapshots: RoomSnapshotInput;
  roomDecisions: RoomDecisionInput;
  roomEvidenceState: RoomEvidenceStateInput;
};

// ------------------------------------------------------------------ DDL
const inList = (col: string, vocab: readonly string[]) =>
  `CHECK (${col} IS NULL OR ${col} IN (${vocab.map((v) => `'${v}'`).join(',')}))`;
const maxLen = (col: string, n: number) => `CHECK (${col} IS NULL OR length(${col}) <= ${n})`;
const bool = (col: string) => `CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const dayCheck = (col: string) => `CHECK (${col} IS NULL OR ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
const jsonObject = (col: string) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'object'))`;
const jsonArray = (col: string) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'array'))`;
const staffRef = (col: string) => `${col} TEXT REFERENCES org_users(id) ON DELETE RESTRICT`;
/** A day (`YYYY-MM-DD`) or an instant (ms), never both: a due date or a deadline. */
const dayOrInstantCols = (p: string) => `  ${p}_day TEXT ${dayCheck(`${p}_day`)},\n  ${p}_at INTEGER`;
const oneOfDayOrInstant = (p: string) => `CHECK (${p}_day IS NULL OR ${p}_at IS NULL)`;
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
type Present<T> = Exclude<T, undefined> | (undefined extends T ? null : never);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const n = <T>(v: T): Present<T> => (v === undefined ? null : v) as Present<T>;
const b = (v: boolean | null | undefined): 0 | 1 | null => (v === null || v === undefined ? null : v ? 1 : 0);
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
type DueCols<P extends string> = Record<`${P}_day`, string | null> & Record<`${P}_at`, number | null>;
/** A due date or a deadline: a `YYYY-MM-DD` day in `_day`, an instant in ms in `_at`. */
const dueRow = <P extends string>(p: P, v: unknown): DueCols<P> =>
  ({ [`${p}_day`]: isStr(v) ? v : null, [`${p}_at`]: isInt(v) ? v : null }) as DueCols<P>;
const dueOut = <P extends string>(row: DueCols<P>, p: P): Due => {
  const r = row as Record<string, string | number | null>;
  return r[`${p}_day`] ?? r[`${p}_at`];
};
type PersonCols<P extends string, X extends string = never> = Record<
  `${P}_user_id` | `${P}_name` | `${P}_${X}`,
  string | null
>;
type PersonLike = { userId?: string | null; name?: string | null; [extra: string]: unknown };
const personRow = <P extends string, X extends string = never>(
  p: P,
  v: PersonLike | null | undefined,
  extra: readonly X[] = [],
): PersonCols<P, X> =>
  ({
    [`${p}_user_id`]: v?.userId ?? null,
    [`${p}_name`]: v?.name ?? null,
    ...Object.fromEntries(extra.map((k) => [`${p}_${k}`, v?.[k] ?? null])),
  }) as PersonCols<P, X>;
const personOut = <P extends string, X extends string = never>(
  row: PersonCols<P, NoInfer<X>>,
  p: P,
  extra: readonly X[] = [],
): (Person & Record<NoInfer<X>, string | null>) | null => {
  const r = row as Record<string, string | null>;
  return r[`${p}_user_id`] === null && r[`${p}_name`] === null && extra.every((k) => r[`${p}_${k}`] === null)
    ? null
    : ({
        userId: r[`${p}_user_id`],
        name: r[`${p}_name`],
        ...Object.fromEntries(extra.map((k) => [k, r[`${p}_${k}`]])),
      } as Person & Record<X, string | null>);
};
const ROLE = ['role'] as const;
const jsonOut = <T>(v: string | null): T | null => (v === null ? null : JSON.parse(v));
type KeyCols<P extends string> = Record<`${P}_key` | `${P}_fp`, string | null>;
const keyCols = <P extends string>(p: P, k: { key?: string; fp?: string } | null | undefined): KeyCols<P> =>
  ({ [`${p}_key`]: k?.key ?? null, [`${p}_fp`]: k?.fp ?? null }) as KeyCols<P>;
type SourceRefCols<P extends string> = Record<`${P}_id`, string | null> & Record<`${P}_version`, number | null>;
const sourceRefCols = <P extends string>(
  p: P,
  r: { id?: string; version?: number | null } | null | undefined,
): SourceRefCols<P> => ({ [`${p}_id`]: r?.id ?? null, [`${p}_version`]: r?.version ?? null }) as SourceRefCols<P>;
/** The `{ id, name }` an act names its actor by, as a person. */
type ActorRef = { id?: string | null; name?: string | null };
const asPerson = (by: ActorRef | null | undefined) => by && { userId: by.id ?? null, name: by.name ?? null };

/** The Room's reopen facet: who reopened it, from where, why and from what source. */
const reopenedCols = (ro: ReopenedInput | null | undefined) => ({
  room_reopened_at: ro?.at ?? null,
  ...personRow('room_reopened_by', ro?.by),
  room_reopened_from: ro?.from ?? null,
  room_reopened_reason_codes_json: ro ? JSON.stringify(ro.reasonCodes ?? []) : null,
  room_reopened_source_context: ro?.sourceContext ?? null,
  ...sourceRefCols('room_reopened_source_ref', ro?.sourceRef),
});
/** The Room facet's columns (its tags are rows). */
const roomCols = (r: RoomInput | null | undefined) => ({
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
const caseDecisionCols = (d: CaseDecisionInput | null | undefined) => ({
  decision_outcome: d?.outcome ?? null,
  decision_reasons: d?.reasons ?? null,
  decision_by_user_id: d?.byUserId ?? null,
  decision_by_name: d?.byName ?? null,
  decision_approved_by_name: d?.approvedBy ?? null,
  decision_at: d?.at ?? null,
});
const caseRow = (c: RecruitmentCaseInput) => ({
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
type CaseRow = RowOf<typeof caseRow>;
const assignmentRow = (caseId: string, a: CaseAssignmentInput, position: number) => ({
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
type AssignmentRow = RowOf<typeof assignmentRow>;
const taskRow = (caseId: string, t: CaseTaskInput, position: number) => ({
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
type TaskRow = RowOf<typeof taskRow>;
const resolvedCols = (r: { userId?: string | null; name?: string | null; at?: number } | null | undefined) => ({
  resolved_by_user_id: r?.userId ?? null,
  resolved_by_name: r?.name ?? null,
  resolved_at: r?.at ?? null,
});
const approvalRow = (caseId: string, a: CaseApprovalInput, position: number) => ({
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
type ApprovalRow = RowOf<typeof approvalRow>;
const historyRow = (caseId: string, h: CaseHistoryInput, position: number) => ({
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
type HistoryRow = RowOf<typeof historyRow>;
const draftRow = (caseId: string, d: DecisionDraftInput) => ({
  case_id: caseId,
  id: n(d.id),
  outcome: n(d.outcome),
  note: n(d.note),
  ...personRow('by', d.by, ROLE),
  created_at: n(d.createdAt),
  updated_at: n(d.updatedAt),
  ...personRow('updated_by', d.updatedBy, ROLE),
  rev: n(d.rev),
  rev_at: n(d.revAt),
  ...keyCols('create', d.keys?.create),
});
type DraftRow = RowOf<typeof draftRow>;
const codeRow = (owner: string, ownerId: string, code: string, position: number) => ({
  [owner]: ownerId,
  position,
  code,
});
type CodeRow = { position: number; code: string };
const refRow = (owner: string, ownerId: string, r: EvidenceRefInput, position: number) => ({
  [owner]: ownerId,
  position,
  kind: n(r.kind),
  ref_id: n(r.id),
  meta_json: json(r.meta),
});
type RefRow = { position: number; kind: EvidenceRefKind; ref_id: string; meta_json: string | null };
const handoffRow = (caseId: string, h: TransactionHandoffInput) => ({
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
type HandoffRow = RowOf<typeof handoffRow>;
const approvalCols = (a: InputFor<ScenarioApprovalFields> | null | undefined) => ({
  approval_by_name: a?.by ?? null,
  approval_by_user_id: a?.byUserId ?? null,
  approval_at: a?.at ?? null,
  approval_version: a?.version ?? null,
  approval_superseded: b(a?.superseded),
});
const scenarioRow = (caseId: string, s: BudgetScenarioInput, position: number) => ({
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
type ScenarioRow = RowOf<typeof scenarioRow>;
const lineRow = (caseId: string, scenarioId: string, l: BudgetLineInput, position: number) => ({
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
type LineRow = RowOf<typeof lineRow>;
const fxRow = (caseId: string, scenarioId: string, a: FxAssumptionInput, position: number) => ({
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
type FxRow = RowOf<typeof fxRow>;
const actualRow = (caseId: string, scenarioId: string, a: BudgetActualInput, position: number) => ({
  case_id: caseId,
  scenario_id: scenarioId,
  position,
  id: n(a.id),
  line_id: n(a.lineId),
  amount_minor: n(a.amountMinor),
  at: n(a.at),
  recorded_by_name: n(a.recordedBy),
});
type ActualRow = RowOf<typeof actualRow>;
const commentRow = (c: RoomCommentInput) => ({
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
type CommentRow = RowOf<typeof commentRow>;
const snapshotRow = (s: RoomSnapshotInput) => ({
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
type SnapshotRow = RowOf<typeof snapshotRow>;
const lifecycleCols = (l: DecisionLifecycleInput | null | undefined) => ({
  lifecycle_action: l?.action ?? null,
  lifecycle_from: l?.from ?? null,
  lifecycle_to: l?.to ?? null,
  lifecycle_applied: b(l?.applied),
  lifecycle_reason: l?.reason ?? null,
  lifecycle_at: l?.at ?? null,
});
const decisionRow = (d: RoomDecisionInput) => {
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
    ...personRow('by', d.by, ROLE),
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
type DecisionRow = RowOf<typeof decisionRow>;
const evidenceRow = (e: RoomEvidenceStateInput) => ({
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
type EvidenceRow = RowOf<typeof evidenceRow>;

// The encoders read every field of an empty record as absent, so their keys are the tables' columns.
const none = <T>() => ({}) as T;
const COLS: Record<CasesTable, string[]> = {
  recruitment_cases: Object.keys(caseRow(none())),
  case_room_tags: ['case_id', 'position', 'tag'],
  case_assignments: Object.keys(assignmentRow('x', none(), 0)),
  case_tasks: Object.keys(taskRow('x', none(), 0)),
  case_approvals: Object.keys(approvalRow('x', none(), 0)),
  case_history: Object.keys(historyRow('x', none(), 0)),
  case_request_links: ['case_id', 'position', 'request_id'],
  case_trial_links: ['case_id', 'position', 'trial_id'],
  case_decision_drafts: Object.keys(draftRow('x', none())),
  case_decision_draft_reason_codes: Object.keys(codeRow('case_id', 'x', 'c', 0)),
  case_decision_draft_evidence_refs: Object.keys(refRow('case_id', 'x', none(), 0)),
  case_transaction_handoffs: Object.keys(handoffRow('x', none())),
  case_budget_scenarios: Object.keys(scenarioRow('x', none(), 0)),
  case_budget_lines: Object.keys(lineRow('x', 's', none(), 0)),
  case_budget_fx_assumptions: Object.keys(fxRow('x', 's', none(), 0)),
  case_budget_actuals: Object.keys(actualRow('x', 's', none(), 0)),
  room_comments: Object.keys(commentRow(none())),
  room_comment_mentions: ['comment_id', 'position', 'user_id'],
  room_snapshots: Object.keys(snapshotRow(none())),
  room_snapshot_source_refs: ['snapshot_id', 'kind', 'position', 'ref_id'],
  room_decisions: Object.keys(decisionRow(none())),
  room_decision_reason_codes: Object.keys(codeRow('decision_id', 'x', 'c', 0)),
  room_decision_evidence_refs: Object.keys(refRow('decision_id', 'x', none(), 0)),
  room_decision_assessment_ids: ['decision_id', 'position', 'assessment_id'],
  room_evidence_states: Object.keys(evidenceRow(none())),
};
const PARENT = {
  recruitmentCases: 'recruitment_cases',
  roomComments: 'room_comments',
  roomSnapshots: 'room_snapshots',
  roomDecisions: 'room_decisions',
  roomEvidenceState: 'room_evidence_states',
} as const;
type ParentTable = (typeof PARENT)[RecruitmentCasesCollection];
const SOURCE_REF_LISTS = [
  ['evidence', 'evidenceIds'],
  ['assessment', 'assessmentIds'],
  ['combine', 'combineResults'],
  ['trial', 'trialIds'],
] as const;

// ------------------------------------------------------------------ statements and the record readers
const CASE_CHILD_TABLES = [
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
] as const;
type CaseChildTable = (typeof CASE_CHILD_TABLES)[number];
const SCENARIO_CHILD_TABLES = ['case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals'] as const;
type ScenarioChildTable = (typeof SCENARIO_CHILD_TABLES)[number];
const DECISION_CHILD_TABLES = [
  'room_decision_reason_codes',
  'room_decision_evidence_refs',
  'room_decision_assessment_ids',
] as const;
type DecisionChildTable = (typeof DECISION_CHILD_TABLES)[number];
/** Reads a record's child rows: a prepared statement, or the same rows for many records at once (`childRowsOf`). */
type ChildReader = { all(parentId: string, ...subKey: SQLOutputValue[]): Row[] };
type OneReader = { get(id: string): Row | undefined };
/** What the decoders read children through. */
type Readers = {
  byId: Record<ParentTable, OneReader>;
  of: Record<CaseChildTable, ChildReader>;
  draftOf: OneReader;
  handoffOf: OneReader;
  scenarioChild: Record<ScenarioChildTable, ChildReader>;
  mentionsOf: ChildReader;
  sourceRefsOf: ChildReader;
  decisionChild: Record<DecisionChildTable, ChildReader>;
};
type Statements = Readers & {
  ins: Record<CasesTable, StatementSync>;
  byId: Record<ParentTable, StatementSync>;
  all: Record<ParentTable, StatementSync>;
  draftOf: StatementSync;
  handoffOf: StatementSync;
  preparedBy: DatabaseSync['prepare'];
};
const stmtCache = new WeakMap<DatabaseSync, Statements>();
function statements(sqlite: DatabaseSync): Statements {
  let s = stmtCache.get(sqlite);
  if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table: CasesTable) => {
    const cols = COLS[table];
    return sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  };
  const byCase = (t: string, order: string | null = 'position') =>
    sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ?${order ? ` ORDER BY ${order}` : ''}`);
  const perParent = (sql: (t: string) => string) =>
    Object.fromEntries(Object.values(PARENT).map((t) => [t, sqlite.prepare(sql(t))])) as Record<
      ParentTable,
      StatementSync
    >;
  s = {
    ins: Object.fromEntries(RECRUITMENT_CASES_TABLES.map((t) => [t, insert(t)])) as Record<CasesTable, StatementSync>,
    byId: perParent((t) => `SELECT * FROM ${t} WHERE id = ?`),
    all: perParent((t) => `SELECT * FROM ${t} ORDER BY rowid`),
    of: Object.fromEntries(CASE_CHILD_TABLES.map((t) => [t, byCase(t)])) as Record<CaseChildTable, StatementSync>,
    draftOf: byCase('case_decision_drafts', null),
    handoffOf: byCase('case_transaction_handoffs', null),
    scenarioChild: Object.fromEntries(
      SCENARIO_CHILD_TABLES.map((t) => [
        t,
        sqlite.prepare(`SELECT * FROM ${t} WHERE case_id = ? AND scenario_id = ? ORDER BY position`),
      ]),
    ) as Record<ScenarioChildTable, StatementSync>,
    mentionsOf: sqlite.prepare('SELECT user_id FROM room_comment_mentions WHERE comment_id = ? ORDER BY position'),
    sourceRefsOf: sqlite.prepare(
      'SELECT kind, ref_id FROM room_snapshot_source_refs WHERE snapshot_id = ? ORDER BY kind, position',
    ),
    decisionChild: Object.fromEntries(
      DECISION_CHILD_TABLES.map((t) => [
        t,
        sqlite.prepare(`SELECT * FROM ${t} WHERE decision_id = ? ORDER BY position`),
      ]),
    ) as Record<DecisionChildTable, StatementSync>,
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
function batchStatements(sqlite: DatabaseSync, st: Readers, caseIds: string[]): Readers {
  const rows = (t: string, subKey: string[] = []) =>
    childRowsOf(sqlite, t, 'case_id', caseIds, { order: 'position', subKey });
  const first = (t: string): OneReader => {
    const m = childRowsOf(sqlite, t, 'case_id', caseIds);
    return { get: (id) => m.all(id)[0] };
  };
  return {
    ...st,
    of: Object.fromEntries(CASE_CHILD_TABLES.map((t) => [t, rows(t)])) as Record<CaseChildTable, ChildReader>,
    draftOf: first('case_decision_drafts'),
    handoffOf: first('case_transaction_handoffs'),
    scenarioChild: Object.fromEntries(SCENARIO_CHILD_TABLES.map((t) => [t, rows(t, ['scenario_id'])])) as Record<
      ScenarioChildTable,
      ChildReader
    >,
  };
}

/** The same for a list of decisions: their child rows, the snapshots they name and those snapshots' source references. */
function batchDecisionStatements(sqlite: DatabaseSync, st: Readers, rows: DecisionRow[]): Readers {
  const decisionIds = rows.map((r) => r.id);
  const snapshotIds = rows.map((r) => r.snapshot_id).filter((x): x is string => x !== null);
  const snapshots = childRowsOf(sqlite, 'room_snapshots', 'id', snapshotIds);
  return {
    ...st,
    decisionChild: Object.fromEntries(
      DECISION_CHILD_TABLES.map((t) => [t, childRowsOf(sqlite, t, 'decision_id', decisionIds, { order: 'position' })]),
    ) as Record<DecisionChildTable, ChildReader>,
    byId: { ...st.byId, room_snapshots: { get: (id) => snapshots.all(id)[0] } },
    sourceRefsOf: childRowsOf(sqlite, 'room_snapshot_source_refs', 'snapshot_id', snapshotIds, {
      order: 'kind, position',
    }),
  };
}

type Step = (part: string, fn: () => unknown) => unknown;
/** A record's child list: absent is empty, anything but a list is refused; with `objects`, so is an item that is not an object. */
type ListOf = <T>(field: string, v: readonly T[] | null | undefined, opts?: { objects?: boolean }) => T[];
/** A case's ordered children, inserted at `position` from 0. */
const caseChildren = (st: Statements, id: string, step: Step, list: ListOf) => ({
  tags: (tags: readonly string[] | null | undefined) =>
    list('room.tags', tags).forEach((tag, i) =>
      step(`room tag ${i}`, () => st.ins.case_room_tags.run({ case_id: id, position: i, tag })),
    ),
  draft: (d: DecisionDraftInput) => {
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
  scenario: (s: BudgetScenarioInput, position: number) => {
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
/** The step and list checks of one record's writes. */
const writesOf = (table: string, id: string): [Step, ListOf] => [
  (part, fn) => rowStep(table, id, part, fn),
  (field, v, opts) => listOf(table, id, field, v, opts) as never,
];
/** A whole case, inserted with its children. */
function insertCase(st: Statements, c: RecruitmentCaseInput) {
  const id = c.id;
  const [step, list] = writesOf('recruitment_cases', id);
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
  const handoff = c.transactionHandoff;
  if (handoff) step('transaction handoff', () => st.ins.case_transaction_handoffs.run(handoffRow(id, handoff)));
  list('budget.scenarios', c.budget?.scenarios, { objects: true }).forEach((s, i) => children.scenario(s, i));
}
/** A whole room comment, snapshot, decision or evidence state, inserted with its children. */
const INSERT_ROOM_ROW: {
  [N in Exclude<RecruitmentCasesCollection, 'recruitmentCases'>]: (st: Statements, r: InputOf[N]) => void;
} = {
  roomComments(st, r) {
    const [step, list] = writesOf('room_comments', r.id);
    step('row', () => st.ins.room_comments.run(commentRow(r)));
    list('mentions', r.mentions).forEach((u, i) =>
      step(`mention ${i}`, () => st.ins.room_comment_mentions.run({ comment_id: r.id, position: i, user_id: u })),
    );
  },
  roomSnapshots(st, r) {
    const [step, list] = writesOf('room_snapshots', r.id);
    step('row', () => st.ins.room_snapshots.run(snapshotRow(r)));
    for (const [kind, key] of SOURCE_REF_LISTS)
      list(`sourceRefs.${key}`, r.sourceRefs?.[key]).forEach((ref, i) =>
        step(`source ref ${kind} ${i}`, () =>
          st.ins.room_snapshot_source_refs.run({ snapshot_id: r.id, kind, position: i, ref_id: ref }),
        ),
      );
  },
  roomDecisions(st, r) {
    const [step, list] = writesOf('room_decisions', r.id);
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
  },
  roomEvidenceState(st, r) {
    const [step] = writesOf('room_evidence_states', r.id);
    step('row', () => st.ins.room_evidence_states.run(evidenceRow(r)));
  },
};
const INSERT: { [N in RecruitmentCasesCollection]: (st: Statements, r: InputOf[N]) => void } = {
  recruitmentCases: insertCase,
  ...INSERT_ROOM_ROW,
};

const historyOut = (h: HistoryRow): CaseHistoryFields => ({
  id: h.id,
  at: h.at,
  byKind: h.by_kind,
  byId: h.by_id,
  byName: h.by_name,
  action: h.action,
  detail: h.detail_json !== null ? JSON.parse(h.detail_json) : h.detail_text,
});
function decodeCase(st: Readers, row: CaseRow): CaseFields {
  const id = row.id;
  const O = st.of;
  const dr = st.draftOf.get(id) as DraftRow | undefined;
  const ho = st.handoffOf.get(id) as HandoffRow | undefined;
  const scenarios = (O.case_budget_scenarios.all(id) as ScenarioRow[]).map(
    (s): ScenarioFields => ({
      id: s.id,
      version: s.version,
      label: s.label,
      currency: s.currency,
      termMonths: s.term_months,
      lines: (st.scenarioChild.case_budget_lines.all(id, s.id) as LineRow[]).map((l) => ({
        id: l.id,
        kind: l.kind,
        label: l.label,
        amountMinor: l.amount_minor,
        currency: l.currency,
        schedule: l.schedule,
        confirmed: l.confirmed === 1,
        conditional: l.conditional_assumption === null ? null : { assumption: l.conditional_assumption },
      })),
      fxAssumptions: (st.scenarioChild.case_budget_fx_assumptions.all(id, s.id) as FxRow[]).map((a) => ({
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
              // Set with the approval (a CHECK).
              version: s.approval_version as number,
              superseded: s.approval_superseded === 1,
            },
      actuals: (st.scenarioChild.case_budget_actuals.all(id, s.id) as ActualRow[]).map((a) => ({
        id: a.id,
        lineId: a.line_id,
        amountMinor: a.amount_minor,
        at: a.at,
        recordedBy: a.recorded_by_name,
      })),
      createdBy: s.created_by_name,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }),
  );
  // A Room's priority, rev and last activity are set with its status (a CHECK), and its reopen reasons with the reopen.
  const room: RoomFields | null =
    row.room_status === null
      ? null
      : {
          status: row.room_status,
          priority: row.room_priority as RoomPriority,
          tags: (O.case_room_tags.all(id) as { tag: string }[]).map((t) => t.tag),
          leadScoutUserId: row.room_lead_scout_user_id,
          sourceContext: row.room_source_context,
          sourceRef:
            row.room_source_ref_id === null
              ? null
              : { id: row.room_source_ref_id, version: row.room_source_ref_version },
          openedBy: personOut(row, 'room_opened_by'),
          updatedAt: row.room_updated_at as number,
          archivedAt: row.room_archived_at,
          closedAt: row.room_closed_at,
          rev: row.room_rev as number,
          revAt: row.room_rev_at,
          revBy: personOut(row, 'room_rev_by'),
          reopened:
            row.room_reopened_at === null
              ? null
              : {
                  by: personOut(row, 'room_reopened_by'),
                  at: row.room_reopened_at,
                  from: row.room_reopened_from,
                  reasonCodes: JSON.parse(row.room_reopened_reason_codes_json as string),
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
    assignments: (O.case_assignments.all(id) as AssignmentRow[]).map((a) => ({
      id: a.id,
      userId: a.user_id,
      name: a.user_name,
      task: a.task,
      dueAt: dueOut(a, 'due'),
      status: a.status,
      createdAt: a.created_at,
    })),
    tasks: (O.case_tasks.all(id) as TaskRow[]).map((t) => ({
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
    approvals: (O.case_approvals.all(id) as ApprovalRow[]).map((a) => ({
      id: a.id,
      // The column is NOT NULL.
      decision: { outcome: a.decision_outcome as CaseDecisionOutcome, reasons: a.decision_reasons },
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
            // Set with the decision's instant (a CHECK).
            outcome: row.decision_outcome as CaseDecisionOutcome,
            reasons: row.decision_reasons,
            byUserId: row.decision_by_user_id,
            byName: row.decision_by_name,
            approvedBy: row.decision_approved_by_name,
            at: row.decision_at,
          },
    links: {
      requestIds: (O.case_request_links.all(id) as { request_id: string }[]).map((r) => r.request_id),
      trialIds: (O.case_trial_links.all(id) as { trial_id: string }[]).map((r) => r.trial_id),
      signingId: row.links_signing_id,
    },
    createdAt: row.created_at,
    history: (O.case_history.all(id) as HistoryRow[]).map(historyOut),
    room,
    decisionDraft: !dr
      ? null
      : {
          id: dr.id,
          outcome: dr.outcome,
          reasonCodes: (O.case_decision_draft_reason_codes.all(id) as CodeRow[]).map((r) => r.code),
          note: dr.note,
          evidenceRefs: (O.case_decision_draft_evidence_refs.all(id) as RefRow[]).map((r) => ({
            kind: r.kind,
            id: r.ref_id,
            meta: jsonOut(r.meta_json),
          })),
          by: personOut(dr, 'by', ROLE),
          createdAt: dr.created_at,
          updatedAt: dr.updated_at,
          updatedBy: personOut(dr, 'updated_by', ROLE),
          rev: dr.rev,
          revAt: dr.rev_at,
          // The key and its fingerprint are set together (a CHECK).
          keys: { create: dr.create_key === null ? null : { key: dr.create_key, fp: dr.create_fp as string } },
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
const decodeComment = (st: Readers, r: CommentRow): CommentFields => ({
  id: r.id,
  roomId: r.room_id,
  orgId: r.org_id,
  authorId: r.author_user_id,
  authorName: r.author_name,
  body: r.body,
  replyToId: r.reply_to_id,
  mentions: (st.mentionsOf.all(r.id) as { user_id: string }[]).map((m) => m.user_id),
  createdAt: r.created_at,
  editedAt: r.edited_at,
  editCount: r.edit_count,
  deletedAt: r.deleted_at,
  deletedBy: personOut(r, 'deleted_by'),
});
function decodeSnapshot(st: Readers, r: SnapshotRow): SnapshotFields {
  const refs: Record<SourceRefKind, string[]> = { evidence: [], assessment: [], combine: [], trial: [] };
  for (const x of st.sourceRefsOf.all(r.id) as { kind: SourceRefKind; ref_id: string }[]) refs[x.kind].push(x.ref_id);
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
            // Set with the hash (a CHECK).
            componentLevels: JSON.parse(r.trust_component_levels_json as string),
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
function decodeDecision(st: Readers, r: DecisionRow): DecisionFields {
  const C = st.decisionChild;
  const snapRow =
    r.snapshot_id === null ? null : (st.byId.room_snapshots.get(r.snapshot_id) as SnapshotRow | undefined);
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
    reasonCodes: (C.room_decision_reason_codes.all(r.id) as CodeRow[]).map((x) => x.code),
    note: r.note,
    by: personOut(r, 'by', ROLE),
    createdAt: r.created_at,
    finalizedAt: r.finalized_at,
    trigger: r.trigger,
    clientKey: r.client_key,
    supersedes: r.supersedes_id,
    supersededById: r.superseded_by_id,
    // The reason is set with what it supersedes (a CHECK).
    supersession:
      r.supersession_of_id === null ? null : { of: r.supersession_of_id, reason: r.supersession_reason as string },
    rev: r.rev,
    revAt: r.rev_at,
    evidenceRefs: (C.room_decision_evidence_refs.all(r.id) as RefRow[]).map((x) => ({
      kind: x.kind,
      id: x.ref_id,
      meta: jsonOut(x.meta_json),
    })),
    assessmentSummary:
      r.assessments_submitted === null
        ? null
        : {
            submitted: r.assessments_submitted,
            // Written with the summary, and the verdicts set with it (a CHECK).
            withheld: r.assessments_withheld as number,
            verdicts: JSON.parse(r.assessment_verdicts_json as string),
            assessmentIds: (C.room_decision_assessment_ids.all(r.id) as { assessment_id: string }[]).map(
              (x) => x.assessment_id,
            ),
          },
    snapshot: snap ? { at: snap.at, trust: snap.trust, sourceRefs: snap.sourceRefs, snapshotId: snap.id } : null,
    // Each key and its fingerprint are set together (a CHECK).
    keys: {
      finalize: r.finalize_key === null ? null : { key: r.finalize_key, fp: r.finalize_fp as string },
      draft: r.draft_key === null ? null : { key: r.draft_key, fp: r.draft_fp as string },
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
const decodeEvidence = (_st: Readers, r: EvidenceRow): EvidenceStateFields => ({
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
const DECODERS: { [N in RecruitmentCasesCollection]: (st: Readers, row: Row) => FieldsOf[N] } = {
  recruitmentCases: (st, r) => decodeCase(st, r as CaseRow),
  roomComments: (st, r) => decodeComment(st, r as CommentRow),
  roomSnapshots: (st, r) => decodeSnapshot(st, r as SnapshotRow),
  roomDecisions: (st, r) => decodeDecision(st, r as DecisionRow),
  roomEvidenceState: (st, r) => decodeEvidence(st, r as EvidenceRow),
};
const readAll = <N extends RecruitmentCasesCollection>(sqlite: DatabaseSync, name: N): RecordOf[N][] => {
  const st = statements(sqlite);
  const rows = st.all[PARENT[name]].all();
  const via =
    name === 'recruitmentCases' && rows.length > 1
      ? batchStatements(
          sqlite,
          st,
          rows.map((r) => r.id as string),
        )
      : st;
  return rows.map((r) => DECODERS[name](via, r)) as RecordOf[N][];
};
export const readCases = (sqlite: DatabaseSync): RecruitmentCase[] => readAll(sqlite, 'recruitmentCases');
export const readRoomComments = (sqlite: DatabaseSync): RoomComment[] => readAll(sqlite, 'roomComments');
export const readRoomSnapshots = (sqlite: DatabaseSync): RoomSnapshot[] => readAll(sqlite, 'roomSnapshots');
export const readRoomDecisions = (sqlite: DatabaseSync): RoomDecision[] => readAll(sqlite, 'roomDecisions');
export const readRoomEvidenceStates = (sqlite: DatabaseSync): RoomEvidenceState[] =>
  readAll(sqlite, 'roomEvidenceState');

/** The counts of the admin report: rows naming a player that is not in the players table, and rows naming a retained record (Q8a: counted, never refused). */
const PLAYER_COUNT_TABLES = {
  recruitmentCases: 'recruitment_cases',
  roomSnapshots: 'room_snapshots',
  roomDecisions: 'room_decisions',
  caseTransactionHandoffs: 'case_transaction_handoffs',
} as const;
type PlayerCounts = Record<keyof typeof PLAYER_COUNT_TABLES, number>;
const countPlayerRows = (sqlite: DatabaseSync, test: string): PlayerCounts =>
  Object.fromEntries(
    Object.entries(PLAYER_COUNT_TABLES).map(([k, t]) => [
      k,
      (sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE ${test}`).get() as { n: number }).n,
    ]),
  ) as PlayerCounts;
export function unresolvedPlayerReferences(sqlite: DatabaseSync): PlayerCounts | null {
  if (!recruitmentCasesLive(sqlite)) return null;
  return countPlayerRows(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id)');
}
export function retainedPlayerReferences(sqlite: DatabaseSync): PlayerCounts | null {
  if (!recruitmentCasesLive(sqlite)) return null;
  return countPlayerRows(
    sqlite,
    'EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id AND p.deleted_at IS NOT NULL)',
  );
}

// ------------------------------------------------------------------ the whole-domain read
const readEvery = (sqlite: DatabaseSync): RecruitmentCasesRecords =>
  Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((c) => [c, readAll(sqlite, c)])) as RecruitmentCasesRecords;
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const RECRUITMENT_CASES_RECORDS = {
  names: RECRUITMENT_CASES_COLLECTIONS,
  read(sqlite: DatabaseSync): RecruitmentCasesRecords | null {
    if (!recruitmentCasesLive(sqlite)) return null;
    return readEvery(sqlite);
  },
};

// ------------------------------------------------------------------ act inputs
/** Who an act's bookkeeping names: `{ id, name }`. */
export type CaseActor = ActorRef;
/**
 * The bookkeeping an act leaves on its case: the Room's last-activity instant (`touch`), its rev bump (`bump`, by
 * `revBy`), and its history entries, which are only ever appended.
 */
export type CaseBookkeeping = {
  at?: number | null;
  revBy?: CaseActor | null;
  touch?: boolean;
  bump?: boolean;
  history?: CaseHistoryInput[];
};
export type MoveRoomInput = {
  to: RoomStatus;
  stage?: CaseStage;
  archivedAt?: number | null;
  closedAt?: number | null;
  at: number;
  by?: CaseActor | null;
  /** Records a reopen. */
  reopened?: ReopenedInput | null;
  sourceContext?: SourceContext | null;
  /** The lifecycle's resume, only from `on_hold`. */
  resume?: boolean;
};
export type EditRoomInput = {
  priority?: RoomPriority;
  tags?: string[];
  leadScoutUserId?: string | null;
  owner?: { id: string; name?: string | null };
  restricted?: boolean;
  deadline?: Due;
};
export type UpdateTaskInput = {
  taskId: string;
  status?: TaskState;
  completedAt?: number | null;
  completedBy?: string | null;
  /** `null` unassigns the task. */
  assignee?: CaseActor | null;
};
export type EditDraftInput = {
  outcome?: DecisionOutcome | null;
  reasonCodes?: string[];
  note?: string | null;
  evidenceRefs?: EvidenceRefInput[];
  at: number;
  by: PersonWithRoleInput | null;
};
export type EditScenarioInput = {
  scenarioId: string;
  label?: string;
  termMonths?: number;
  /** Replaces the lines. */
  lines?: BudgetLineInput[];
  /** Replaces the assumptions. */
  fxAssumptions?: FxAssumptionInput[];
  at: number;
};
export type ApproveScenarioInput = { scenarioId: string; by: string | null; byUserId: string | null; at: number };
export type EvidenceReviewInput = {
  state: EvidenceReviewState;
  note?: string | null;
  byId?: string | null;
  byName?: string | null;
  at: number;
};
/** The light row the Rooms list filters on before decoding. */
export type RoomLight = { id: string; playerId: string; playerName: string | null; status: RoomStatus };
/** Who reads a list: only the cases and Rooms they may open. */
export type CaseViewer = { userId: string; isLead: boolean };
export type RoomFilter = {
  statuses?: readonly RoomStatus[] | null;
  status?: RoomStatus | null;
  mineOf?: string | null;
  assignedTo?: string | null;
  tag?: string | null;
  assignee?: string | null;
};
/** A page by cursor: the key of the row before it. */
type Page = { limit: number; after?: readonly [number, string] | null };
type PageOf<T> = { items: T[]; nextCursor: string | null };

// ------------------------------------------------------------------ the repository
/** Only the fields given: `undefined` leaves a column as it is. */
const given = (cols: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined));
/** The Room statuses a move into `to` may start from. */
const leadingTo = (to: RoomStatus): string[] =>
  Object.keys(ROOM_TRANSITIONS).filter((x) => (ROOM_TRANSITIONS[x] as readonly string[]).includes(to));
/** An act's own check of what it wrote, run on the stored case. */
type StoredCheck = (stored: RecruitmentCase) => void;
type CaseActDef = ((id: string) => StoredCheck | void) | ((id: string, input: never) => StoredCheck | void);
type CaseAct<F> = F extends (id: string) => unknown
  ? (id: string, input?: Record<string, never>, bookkeeping?: CaseBookkeeping) => RecruitmentCase
  : F extends (id: string, input: infer I) => unknown
    ? (id: string, input: I, bookkeeping?: CaseBookkeeping) => RecruitmentCase
    : never;
type RowActDef = (id: string, input: never) => void;
type RowAct<F, R> = F extends (id: string, input: infer I) => void ? (id: string, input: I) => R : never;

/**
 * `createRecruitmentCasesRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work (a
 * failure poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and
 * returns the record read back from the tables. Every query decodes fresh, deep-frozen records in insertion (rowid)
 * order and runs on the one connection, so a read inside a unit of work sees the unit's own writes.
 */
export function createRecruitmentCasesRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite) throw new TypeError('the recruitment-cases repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const decode = <N extends RecruitmentCasesCollection>(name: N, row: Row): RecordOf[N] =>
    deepFreeze(DECODERS[name](st, row)) as RecordOf[N];
  const find = <N extends RecruitmentCasesCollection>(name: N, id: unknown): RecordOf[N] | null => {
    if (typeof id !== 'string') return null;
    const row = st.byId[PARENT[name]].get(id);
    return row ? decode(name, row) : null;
  };
  const exists = (name: RecruitmentCasesCollection, id: unknown) =>
    typeof id === 'string' && !!st.byId[PARENT[name]].get(id);
  /** Decode many rows; a list of cases or decisions reads its children in one batch (batchStatements, batchDecisionStatements). */
  const decodeAll = <N extends RecruitmentCasesCollection>(name: N, rows: Row[]): RecordOf[N][] => {
    if (rows.length < 2 || (name !== 'recruitmentCases' && name !== 'roomDecisions'))
      return rows.map((r) => decode(name, r));
    const bst =
      name === 'roomDecisions'
        ? batchDecisionStatements(sqlite, st, rows as DecisionRow[])
        : batchStatements(
            sqlite,
            st,
            rows.map((r) => r.id as string),
          );
    return rows.map((r) => deepFreeze(DECODERS[name](bst, r)) as RecordOf[N]);
  };
  /** The records whose `col` is any of `values`, in insertion order, decoded in one batch. */
  const inList =
    <N extends RecruitmentCasesCollection>(name: N, col: string) =>
    (values: readonly unknown[] | null | undefined): RecordOf[N][] => {
      const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))];
      if (!want.length) return [];
      return decodeAll(
        name,
        sqlite
          .prepare(`SELECT * FROM ${PARENT[name]} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`)
          .all(...want),
      );
    };
  const list = <N extends RecruitmentCasesCollection, A extends SQLInputValue[]>(name: N, sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A): RecordOf[N][] => decodeAll(name, stmt.all(...args));
  };
  const count = <A extends SQLInputValue[]>(sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A): number => (stmt.get(...args) as { n: number }).n;
  };

  // ---- writes: a record is created whole, then changes only through named acts on its own rows.
  const kit = writeKit(sqlite, 'RECRUITMENT_CASES');
  const { q, sqlIn, guarded, nextPosition } = kit;
  // Besides the write kit's three refusals, the record may be missing.
  const refusal = (what: 'NOT_FOUND' | 'STATE_CONFLICT', message: string) => {
    const code = `RECRUITMENT_CASES_${what}`;
    return Object.assign(new Error(`${code}: ${message}`), { code });
  };
  const must = <N extends RecruitmentCasesCollection>(name: N, id: string): RecordOf[N] => {
    const r = find(name, id);
    if (!r) throw refusal('NOT_FOUND', `${PARENT[name]} ${id} is not a record of the repository`);
    return r;
  };
  /** `create(record)`: a new record, whole. An existing id is refused, and the stored record must read back as written. */
  const create =
    <N extends RecruitmentCasesCollection>(name: N) =>
    (r: InputOf[N]): RecordOf[N] =>
      operation(() => {
        const table = PARENT[name];
        newRecord(table, (id) => exists(name, id), r);
        INSERT[name](st, r);
        const stored = must(name, r.id);
        readsBackAsWritten(table, r.id, r, stored);
        return stored;
      });

  const CASE = 'recruitment_cases';
  const ROOM = 'room_status IS NOT NULL';
  const noRoom = (id: string) => `recruitment_cases ${id} has no Room`;
  const childrenOf = (id: string) => caseChildren(st, id, ...writesOf(CASE, id));
  /** Append one ordered child row: `encode(position)` at the owner's next position. */
  const appendTo = (
    table: CasesTable,
    id: string,
    encode: (position: number) => Record<string, SQLInputValue>,
    scope: Record<string, SQLInputValue> = {},
  ) => st.ins[table].run(encode(nextPosition(table, 'case_id', id, scope)));
  /** An act that inserts a sub-record checks it reads back as written, as a create does. */
  const storedAs =
    (id: string, written: unknown, path: string, pick: (c: RecruitmentCase) => unknown): StoredCheck =>
    (stored) =>
      readsBackAsWritten(CASE, id, written, pick(stored), path);
  /** The bookkeeping an act leaves on its case (CaseBookkeeping). */
  const applyAct = (
    id: string,
    { at = null, revBy = null, touch = false, bump = false, history = [] }: CaseBookkeeping = {},
  ) => {
    if (touch) guarded(CASE, { id }, ROOM, { room_updated_at: at }, noRoom(id));
    if (bump)
      guarded(CASE, { id }, ROOM, { room_rev_at: at, ...personRow('room_rev_by', asPerson(revBy)) }, noRoom(id), {
        set: 'room_rev = room_rev + 1',
      });
    for (const h of listOf(CASE, id, 'history', history, { objects: true }) as CaseHistoryInput[])
      rowStep(CASE, id, `history ${h.id}`, () => appendTo('case_history', id, (p) => historyRow(id, h, p)));
  };
  const runCaseAct = (name: string, id: string, fn: () => StoredCheck | void, bookkeeping?: CaseBookkeeping) =>
    operation(() => {
      if (!exists('recruitmentCases', id))
        throw refusal('NOT_FOUND', `recruitment_cases ${id} is not a record of the repository`);
      const check = rowStep(CASE, id, name, fn);
      applyAct(id, bookkeeping);
      const stored = must('recruitmentCases', id);
      if (typeof check === 'function') check(stored);
      return stored;
    });
  /**
   * Named acts on a case, each `act(id, input, bookkeeping)`: the act's own writes, then its bookkeeping, in one
   * operation; it returns the stored case. `recordAct(id, bookkeeping)` is the bookkeeping alone (an activity entry, or
   * the second half of an act whose case move came in between).
   */
  const caseActs = <D extends Record<string, CaseActDef>>(defs: D) =>
    Object.fromEntries(
      Object.entries(defs).map(([name, fn]) => [
        name,
        (id: string, input: unknown = {}, bookkeeping: CaseBookkeeping = {}) =>
          runCaseAct(
            name,
            id,
            () => (fn as (id: string, input: unknown) => StoredCheck | void)(id, input),
            bookkeeping,
          ),
      ]),
    ) as { [K in keyof D]: CaseAct<D[K]> };
  /** Named acts on one room row, each `act(id, input)`; it returns the stored row. */
  const rowActs = <N extends RecruitmentCasesCollection, D extends Record<string, RowActDef>>(name: N, defs: D) =>
    Object.fromEntries(
      Object.entries(defs).map(([act, fn]) => [
        act,
        (id: string, input: unknown = {}) =>
          operation(() => {
            if (!exists(name, id))
              throw refusal('NOT_FOUND', `${PARENT[name]} ${id} is not a record of the repository`);
            rowStep(PARENT[name], id, act, () => (fn as (id: string, input: unknown) => void)(id, input));
            return must(name, id);
          }),
      ]),
    ) as { [K in keyof D]: RowAct<D[K], RecordOf[N]> };
  /** Replace a case's list rows with `items`, encoded at their positions. */
  const replaceRows = <T>(
    id: string,
    clear: () => void,
    field: string,
    items: readonly T[],
    part: (item: T, i: number) => string,
    insert: (item: T, i: number) => void,
    objects = false,
  ) => {
    clear();
    (listOf(CASE, id, field, items, { objects }) as T[]).forEach((x, i) =>
      rowStep(CASE, id, part(x, i), () => insert(x, i)),
    );
  };

  const caseWrites = {
    create: create('recruitmentCases'),
    recordAct: (id: string, bookkeeping: CaseBookkeeping = {}): RecruitmentCase =>
      runCaseAct('recordAct', id, () => {}, bookkeeping),
    ...caseActs({
      /** Give a plain case its Room facet: a Room adopts the club's open case rather than open a second one. */
      openRoom: (id: string, { room, stage }: { room: RoomInput; stage: CaseStage }) => {
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
      moveRoom: (
        id: string,
        { to, stage, archivedAt, closedAt, at, by = null, reopened, sourceContext, resume = false }: MoveRoomInput,
      ) =>
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
            ...personRow('room_rev_by', asPerson(by)),
            ...(reopened === undefined ? {} : reopenedCols(reopened)),
            room_source_context: sourceContext,
          }),
          `recruitment_cases ${id} cannot move to ${to} from where it is`,
          { set: 'room_rev = room_rev + 1' },
        ),
      /** The Room's settings: priority, tags, lead scout, owner, restriction and deadline (an absent one stays). */
      editRoom: (id: string, { priority, tags, leadScoutUserId, owner, restricted, deadline }: EditRoomInput) => {
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
      addAssignment: (id: string, { assignment: a }: { assignment: CaseAssignmentInput }) => {
        appendTo('case_assignments', id, (p) => assignmentRow(id, a, p));
        return storedAs(id, a, `assignment ${a.id}`, (c) => c.assignments.find((x) => x.id === a.id));
      },
      addTask: (id: string, { task: t }: { task: CaseTaskInput }) => {
        appendTo('case_tasks', id, (p) => taskRow(id, t, p));
        return storedAs(id, t, `task ${t.id}`, (c) => c.tasks.find((x) => x.id === t.id));
      },
      /** A task's status (with its completion) or assignee; `assignee: null` unassigns it. */
      updateTask: (id: string, { taskId, status, completedAt, completedBy, assignee }: UpdateTaskInput) =>
        guarded(
          'case_tasks',
          { case_id: id, id: taskId },
          '',
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
      link: (
        id: string,
        { requestId, trialId, signingId }: { requestId?: string; trialId?: string; signingId?: string | null },
      ) => {
        const once = (table: CasesTable, col: string, value: string) =>
          q(
            `INSERT INTO ${table} (case_id, position, ${col}) SELECT @case_id, @position, @value WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE case_id = @case_id AND ${col} = @value)`,
          ).run({ case_id: id, position: nextPosition(table, 'case_id', id), value });
        if (requestId !== undefined) once('case_request_links', 'request_id', requestId);
        if (trialId !== undefined) once('case_trial_links', 'trial_id', trialId);
        if (signingId !== undefined)
          q('UPDATE recruitment_cases SET links_signing_id = ? WHERE id = ?').run(signingId, id);
      },
      requestApproval: (id: string, { approval: a }: { approval: CaseApprovalInput }) => {
        appendTo('case_approvals', id, (p) => approvalRow(id, a, p));
        return storedAs(id, a, `approval ${a.id}`, (c) => c.approvals.find((x) => x.id === a.id));
      },
      /** Approve or reject a pending approval; `by` is `{ userId, name, at }`. */
      resolveApproval: (
        id: string,
        {
          approvalId,
          status,
          by,
        }: {
          approvalId: string;
          status: CaseApprovalState;
          by: { userId?: string | null; name?: string | null; at: number };
        },
      ) =>
        guarded(
          'case_approvals',
          { case_id: id, id: approvalId },
          "status = 'pending'",
          { status, ...resolvedCols(by) },
          `case_approvals ${approvalId} of recruitment_cases ${id} is not pending`,
        ),
      /** The case's sign-off decision. */
      recordDecision: (id: string, { decision }: { decision: CaseDecisionInput | null }) => {
        q(
          `UPDATE recruitment_cases SET ${Object.keys(caseDecisionCols(null))
            .map((c) => `${c} = @${c}`)
            .join(', ')} WHERE id = @id`,
        ).run({ ...caseDecisionCols(decision), id });
        return storedAs(id, decision, 'decision', (c) => c.decision);
      },
      /** A plain case's stage. A Room's stage follows its status (`moveRoom`) and is never written alone. */
      setStage: (id: string, { stage }: { stage: CaseStage }) =>
        guarded(
          CASE,
          { id },
          'room_status IS NULL',
          { stage },
          `recruitment_cases ${id} has a Room; its stage follows the Room's status`,
        ),
      startDraft: (id: string, { draft }: { draft: DecisionDraftInput }) => {
        if (st.draftOf.get(id)) throw refusal('STATE_CONFLICT', `recruitment_cases ${id} already has a decision draft`);
        childrenOf(id).draft(draft);
        return storedAs(id, draft, 'decisionDraft', (c) => c.decisionDraft);
      },
      /** Change the draft's content (an absent field stays) and move its rev. */
      editDraft: (id: string, { outcome, reasonCodes, note, evidenceRefs, at, by }: EditDraftInput) => {
        guarded(
          'case_decision_drafts',
          { case_id: id },
          '',
          { ...given({ outcome, note }), updated_at: at, ...personRow('updated_by', by, ROLE), rev_at: at },
          `recruitment_cases ${id} has no decision draft`,
          { set: 'rev = rev + 1' },
        );
        if (reasonCodes !== undefined)
          replaceRows(
            id,
            () => q('DELETE FROM case_decision_draft_reason_codes WHERE case_id = ?').run(id),
            'decisionDraft.reasonCodes',
            reasonCodes,
            (_, i) => `decision draft reason ${i}`,
            (code, i) => st.ins.case_decision_draft_reason_codes.run(codeRow('case_id', id, code, i)),
          );
        if (evidenceRefs !== undefined)
          replaceRows(
            id,
            () => q('DELETE FROM case_decision_draft_evidence_refs WHERE case_id = ?').run(id),
            'decisionDraft.evidenceRefs',
            evidenceRefs,
            (_, i) => `decision draft evidence ${i}`,
            (r, i) => st.ins.case_decision_draft_evidence_refs.run(refRow('case_id', id, r, i)),
            true,
          );
      },
      /** The draft goes: discarded, or become a formal decision. */
      discardDraft: (id: string) => {
        if (q('DELETE FROM case_decision_drafts WHERE case_id = ?').run(id).changes !== 1)
          throw refusal('STATE_CONFLICT', `recruitment_cases ${id} has no decision draft`);
      },
      /** Invite a transaction workspace. It replaces a withdrawn or lapsed invitation, never an accepted one. */
      inviteHandoff: (id: string, { handoff: h }: { handoff: TransactionHandoffInput }) => {
        const current = st.handoffOf.get(id) as HandoffRow | undefined;
        if (current?.status === 'accepted')
          throw refusal('STATE_CONFLICT', `recruitment_cases ${id} has an accepted transaction handoff`);
        if (current) q('DELETE FROM case_transaction_handoffs WHERE case_id = ?').run(id);
        st.ins.case_transaction_handoffs.run(handoffRow(id, h));
        return storedAs(id, h, 'transactionHandoff', (c) => c.transactionHandoff);
      },
      withdrawHandoff: (id: string, { at }: { at: number }) =>
        guarded(
          'case_transaction_handoffs',
          { case_id: id },
          "status = 'invited'",
          { status: 'withdrawn', withdrawn_at: at, rev_at: at },
          `recruitment_cases ${id} has no open transaction handoff`,
          { set: 'rev = rev + 1' },
        ),
      /** The invitation taken up by the transaction it opened. */
      acceptHandoff: (id: string, { at, transactionId }: { at: number; transactionId: string }) =>
        guarded(
          'case_transaction_handoffs',
          { case_id: id },
          "status = 'invited'",
          { status: 'accepted', accepted_at: at, transaction_id: transactionId, rev_at: at },
          `recruitment_cases ${id} has no open transaction handoff`,
          { set: 'rev = rev + 1' },
        ),
      addScenario: (id: string, { scenario: s }: { scenario: BudgetScenarioInput }) => {
        childrenOf(id).scenario(s, nextPosition('case_budget_scenarios', 'case_id', id));
        return storedAs(id, s, `budget scenario ${s.id}`, (c) => c.budget?.scenarios.find((x) => x.id === s.id));
      },
      /** A new version of a scenario (an absent field stays; `lines` and `fxAssumptions` replace the lists). An approval of an earlier version is kept, marked superseded. */
      editScenario: (id: string, { scenarioId, label, termMonths, lines, fxAssumptions, at }: EditScenarioInput) => {
        guarded(
          'case_budget_scenarios',
          { case_id: id, id: scenarioId },
          '',
          { ...given({ label, term_months: termMonths }), updated_at: at },
          `case_budget_scenarios ${scenarioId} is not a scenario of recruitment_cases ${id}`,
          { set: 'version = version + 1, approval_superseded = CASE WHEN approval_at IS NULL THEN NULL ELSE 1 END' },
        );
        if (lines !== undefined)
          replaceRows(
            id,
            () => q('DELETE FROM case_budget_lines WHERE case_id = ? AND scenario_id = ?').run(id, scenarioId),
            `budget scenario ${scenarioId} lines`,
            lines,
            (l) => `budget scenario ${scenarioId} line ${l.id}`,
            (l, j) => st.ins.case_budget_lines.run(lineRow(id, scenarioId, l, j)),
            true,
          );
        if (fxAssumptions !== undefined)
          replaceRows(
            id,
            () => q('DELETE FROM case_budget_fx_assumptions WHERE case_id = ? AND scenario_id = ?').run(id, scenarioId),
            `budget scenario ${scenarioId} fxAssumptions`,
            fxAssumptions,
            (_, j) => `budget scenario ${scenarioId} fx ${j}`,
            (a, j) => st.ins.case_budget_fx_assumptions.run(fxRow(id, scenarioId, a, j)),
            true,
          );
      },
      /** A lead's approval of the scenario's current version. */
      approveScenario: (id: string, { scenarioId, by, byUserId, at }: ApproveScenarioInput) =>
        guarded(
          'case_budget_scenarios',
          { case_id: id, id: scenarioId },
          '',
          { approval_by_name: by, approval_by_user_id: byUserId, approval_at: at, approval_superseded: 0 },
          `case_budget_scenarios ${scenarioId} is not a scenario of recruitment_cases ${id}`,
          { set: 'approval_version = version' },
        ),
      recordActual: (id: string, { scenarioId, actual: a }: { scenarioId: string; actual: BudgetActualInput }) => {
        appendTo('case_budget_actuals', id, (p) => actualRow(id, scenarioId, a, p), { scenario_id: scenarioId });
      },
    }),
  };

  /**
   * Who may open a case or a Room, as SQL over `recruitment_cases c`: the rule of `caseAccess` (domains/scouting/scouting.mjs) and,
   * for a Room, of `roomRole` (domains/recruitment/rooms/shared.mjs) being non-null. A recruitment lead opens everything.
   */
  const access = ({ userId, isLead }: CaseViewer, { room }: { room: boolean }): { sql: string; params: string[] } => {
    if (isLead) return { sql: '1', params: [] };
    return {
      sql: `(c.restricted = 0 OR c.owner_user_id = ?${room ? ' OR c.room_lead_scout_user_id = ?' : ''} OR EXISTS (SELECT 1 FROM case_assignments a WHERE a.case_id = c.id AND a.user_id = ?))`,
      params: room ? [userId, userId, userId] : [userId, userId],
    };
  };
  /** The Rooms list's filters as SQL (each optional): statuses, one status, owned or led by, assigned to, a tag, an assignee. */
  const roomWhere = (
    viewer: CaseViewer,
    { statuses = null, status = null, mineOf = null, assignedTo = null, tag = null, assignee = null }: RoomFilter = {},
  ) => {
    const a = access(viewer, { room: true });
    const where = [a.sql];
    const params: string[] = [...a.params];
    const add = (sql: string, ...p: string[]) => {
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
  };
  type LightRow = Pick<CaseRow, 'id' | 'player_id' | 'player_name'> & { room_status: RoomStatus };
  const light = (r: LightRow): RoomLight => ({
    id: r.id,
    playerId: r.player_id,
    playerName: r.player_name,
    status: r.room_status,
  });
  const roomHistoryFrom = (orgId: string, actions: readonly string[]) => ({
    from: 'case_history h JOIN recruitment_cases c ON c.id = h.case_id',
    where: `c.org_id = ? AND c.room_status IS NOT NULL AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`,
    params: [orgId, ...actions],
  });
  /**
   * Keyset paging over `recruitment_cases c`: `limit + 1` rows after the cursor, decoded in one batch. With `accept`,
   * rows are read in chunks and kept only when accepted (with their tags), until the page is full or the rows end.
   */
  const keyset = ({
    where,
    params,
    page: { limit, after = null },
    order,
    after: afterSql,
    rowKey,
    key,
    accept = null,
  }: {
    where: string[];
    params: SQLInputValue[];
    page: Page;
    order: string;
    after: string;
    rowKey: (r: CaseRow) => readonly [number, string];
    key: (c: RecruitmentCase) => unknown[];
    accept?: ((light: RoomLight & { tags: string[] }) => boolean) | null;
  }): PageOf<RecruitmentCase> => {
    const chunk = accept ? Math.max(limit + 1, 200) : limit + 1;
    const kept: CaseRow[] = [];
    let cursor = after;
    for (;;) {
      const sql = `SELECT c.* FROM recruitment_cases c WHERE ${[...where, ...(cursor ? [afterSql] : [])].join(' AND ')} ORDER BY ${order} LIMIT ?`;
      const rows = sqlite
        .prepare(sql)
        .all(...params, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), chunk) as CaseRow[];
      const tags = new Map<string, string[]>();
      if (accept && rows.length) {
        for (const t of sqlite
          .prepare(
            `SELECT case_id, tag FROM case_room_tags WHERE case_id IN (${rows.map(() => '?').join(',')}) ORDER BY case_id, position`,
          )
          .all(...rows.map((r) => r.id)) as { case_id: string; tag: string }[]) {
          let of = tags.get(t.case_id);
          if (!of) tags.set(t.case_id, (of = []));
          of.push(t.tag);
        }
      }
      for (const r of rows) {
        // The list reads only Rooms, so every row here has a status.
        if (!accept || accept({ ...light(r as LightRow), tags: tags.get(r.id) ?? [] })) kept.push(r);
        if (kept.length > limit) break;
      }
      if (kept.length > limit || rows.length < chunk) break;
      cursor = rowKey(rows[rows.length - 1]);
    }
    return pageOf(decodeAll('recruitmentCases', kept), limit, key);
  };

  const cases = {
    ...caseWrites,
    byId: (id: unknown) => find('recruitmentCases', id),
    forOrg: list<'recruitmentCases', [orgId: string]>(
      'recruitmentCases',
      'SELECT * FROM recruitment_cases WHERE org_id = ? ORDER BY rowid',
    ),
    forPlayer: list<'recruitmentCases', [playerId: string]>(
      'recruitmentCases',
      'SELECT * FROM recruitment_cases WHERE player_id = ? ORDER BY rowid',
    ),
    forOrgPlayer: list<'recruitmentCases', [orgId: string, playerId: string]>(
      'recruitmentCases',
      'SELECT * FROM recruitment_cases WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    /** The cases whose transaction handoff invites this agent (any organisation). */
    forHandoffAgent: list<'recruitmentCases', [agentUserId: string]>(
      'recruitmentCases',
      'SELECT c.* FROM recruitment_cases c JOIN case_transaction_handoffs h ON h.case_id = c.id WHERE h.invited_agent_user_id = ? ORDER BY c.rowid',
    ),
    countForOrg: count<[orgId: string]>('SELECT COUNT(*) AS n FROM recruitment_cases WHERE org_id = ?'),
    /** Every case that has a Room (the boot integrity report reads them once). */
    withRoom: list<'recruitmentCases', []>(
      'recruitmentCases',
      'SELECT * FROM recruitment_cases WHERE room_status IS NOT NULL ORDER BY rowid',
    ),
    roomCount: count<[]>('SELECT COUNT(*) AS n FROM recruitment_cases WHERE room_status IS NOT NULL'),
    /** Room statuses of the organisation's Rooms, counted: `{ status: n }`; with a viewer, only the Rooms they may open. */
    roomStatusCounts(orgId: string, viewer: CaseViewer | null = null): Partial<Record<RoomStatus, number>> {
      const a = viewer ? access(viewer, { room: true }) : { sql: '1', params: [] };
      return Object.fromEntries(
        (
          sqlite
            .prepare(
              `SELECT c.room_status AS status, COUNT(*) AS n FROM recruitment_cases c WHERE c.org_id = ? AND c.room_status IS NOT NULL AND ${a.sql} GROUP BY c.room_status`,
            )
            .all(orgId, ...a.params) as { status: RoomStatus; n: number }[]
        ).map((r) => [r.status, r.n]),
      );
    },
    /**
     * The club's cases list: the cases `viewer` may open, optionally at one stage, newest first by
     * cursor ([createdAt, id]), filtered and paged in SQL; only the page is decoded.
     */
    pageForViewer(
      orgId: string,
      viewer: CaseViewer,
      { stage = null }: { stage?: CaseStage | null } = {},
      page: Page,
    ): PageOf<RecruitmentCase> {
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
    roomPageForViewer(
      orgId: string,
      viewer: CaseViewer,
      filter: RoomFilter,
      page: Page,
      accept: ((light: RoomLight & { tags: string[] }) => boolean) | null = null,
    ): PageOf<RecruitmentCase> {
      const f = roomWhere(viewer, filter);
      return keyset({
        where: ['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where],
        params: [orgId, ...f.params],
        page,
        order: 'c.room_updated_at DESC, c.id ASC',
        after: '(c.room_updated_at < ? OR (c.room_updated_at = ? AND c.id > ?))',
        // A Room has its last activity (a CHECK).
        rowKey: (r) => [r.room_updated_at as number, r.id],
        key: (c) => [c.room?.updatedAt, c.id],
        accept,
      });
    },
    /** The Rooms `viewer` may open, filtered like the list, in insertion order, as light rows `{ id, playerId, playerName, status }` (nothing decoded). */
    roomRowsForViewer(orgId: string, viewer: CaseViewer, filter: RoomFilter = {}): RoomLight[] {
      const f = roomWhere(viewer, filter);
      return (
        sqlite
          .prepare(
            `SELECT c.id, c.player_id, c.player_name, c.room_status FROM recruitment_cases c WHERE ${['c.org_id = ?', 'c.room_status IS NOT NULL', ...f.where].join(' AND ')} ORDER BY c.rowid`,
          )
          .all(orgId, ...f.params) as LightRow[]
      ).map(light);
    },
    /**
     * The history of the organisation's Rooms with one of `actions`, newest first, for a merged feed (the audit feed):
     * `{ caseId, playerId, entry }` with the entry as a case's history holds it. See `newestHistory` for `atMost`/`n`.
     */
    roomHistoryFeed(
      orgId: string,
      actions: readonly string[],
      atMost: number | null,
      n: number,
    ): { caseId: string; playerId: string; entry: CaseHistoryEntry }[] {
      return newestHistory(
        sqlite,
        { select: 'h.*, c.player_id AS owner_player_id', ...roomHistoryFrom(orgId, actions) },
        atMost,
        n,
      ).map((row) => {
        const h = row as HistoryRow & { owner_player_id: string };
        return { caseId: h.case_id, playerId: h.owner_player_id, entry: historyOut(h) };
      });
    },
    /** How many entries `roomHistoryFeed` holds in all. */
    roomHistoryCount(orgId: string, actions: readonly string[]): number {
      const f = roomHistoryFrom(orgId, actions);
      return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params) as { n: number })
        .n;
    },
    /** Open and in-progress tasks of the organisation's cases due (an instant) before `at`, counted by case: `Map(caseId → n)`. */
    overdueTaskCounts(orgId: string, at: number): Map<string, number> {
      return new Map(
        (
          sqlite
            .prepare(
              "SELECT t.case_id, COUNT(*) AS n FROM case_tasks t JOIN recruitment_cases c ON c.id = t.case_id WHERE c.org_id = ? AND t.status IN ('open', 'in_progress') AND t.due_at IS NOT NULL AND t.due_at <> 0 AND t.due_at < ? GROUP BY t.case_id",
            )
            .all(orgId, at) as { case_id: string; n: number }[]
        ).map((r) => [r.case_id, r.n]),
      );
    },
  };
  const rowReads = <N extends RecruitmentCasesCollection>(name: N) => ({
    byId: (id: unknown) => find(name, id),
    forRoom: list<N, [roomId: string]>(name, `SELECT * FROM ${PARENT[name]} WHERE room_id = ? ORDER BY rowid`),
  });
  const commentWrites = {
    create: create('roomComments'),
    ...rowActs('roomComments', {
      /** A new body for a comment that is not deleted. */
      edit: (id: string, { body, at }: { body: string; at: number }) =>
        guarded(
          'room_comments',
          { id },
          'deleted_at IS NULL',
          { body, edited_at: at },
          `room_comments ${id} is deleted`,
          { set: 'edit_count = edit_count + 1' },
        ),
      /** A tombstone: the thread keeps its shape and the trail its attribution; `by` is `{ userId, name }`. */
      remove: (id: string, { at, by }: { at: number; by: PersonInput | null }) =>
        guarded(
          'room_comments',
          { id },
          '',
          { deleted_at: at, ...personRow('deleted_by', by) },
          `room_comments ${id} is not there`,
        ),
    }),
  };
  const comments = { ...commentWrites, ...rowReads('roomComments') };
  const snapshotWrites = { create: create('roomSnapshots') };
  const snapshots = { ...snapshotWrites, ...rowReads('roomSnapshots') };
  const decisionWrites = {
    create: create('roomDecisions'),
    ...rowActs('roomDecisions', {
      /** The decision that replaced this one; a decision is superseded once. */
      markSuperseded: (id: string, { by }: { by: string }) =>
        guarded(
          'room_decisions',
          { id },
          'superseded_by_id IS NULL',
          { superseded_by_id: by },
          `room_decisions ${id} is already superseded`,
        ),
      /** The case move a formal decision asked for, once the move has been tried. */
      recordLifecycle: (id: string, { lifecycle }: { lifecycle: DecisionLifecycleInput | null }) =>
        guarded('room_decisions', { id }, '', lifecycleCols(lifecycle), `room_decisions ${id} is not there`),
      bump: (id: string, { at }: { at: number }) =>
        guarded('room_decisions', { id }, '', { rev_at: at }, `room_decisions ${id} is not there`, {
          set: 'rev = COALESCE(rev, 1) + 1',
        }),
    }),
  };
  const decisions = {
    ...decisionWrites,
    ...rowReads('roomDecisions'),
    /** The decisions of several Rooms (a player's journeys), in insertion order. */
    forRooms: inList('roomDecisions', 'room_id'),
    forOrgPlayer: list<'roomDecisions', [orgId: string, playerId: string]>(
      'roomDecisions',
      'SELECT * FROM room_decisions WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    forOrg: list<'roomDecisions', [orgId: string]>(
      'roomDecisions',
      'SELECT * FROM room_decisions WHERE org_id = ? ORDER BY rowid',
    ),
    /** The ids of the organisation's Rooms that hold any decision (a Set; nothing decoded). */
    roomIdsForOrg: (orgId: string): Set<string> =>
      new Set(
        (
          sqlite
            .prepare(
              'SELECT DISTINCT d.room_id FROM room_decisions d JOIN recruitment_cases c ON c.id = d.room_id WHERE c.org_id = ?',
            )
            .all(orgId) as { room_id: string }[]
        ).map((r) => r.room_id),
      ),
  };
  const evidenceWrites = {
    create: create('roomEvidenceState'),
    ...rowActs('roomEvidenceState', {
      /** A new review of the evidence by the Room. */
      review: (id: string, { state, note, byId, byName, at }: EvidenceReviewInput) =>
        guarded(
          'room_evidence_states',
          { id },
          '',
          { state, note, by_user_id: byId, by_name: byName, at },
          `room_evidence_states ${id} is not there`,
        ),
    }),
  };
  const evidenceStates = { ...evidenceWrites, ...rowReads('roomEvidenceState') };
  const writeKeys = <W extends object>(w: W) => Object.keys(w) as (keyof W)[];
  const counters = Object.fromEntries(
    RECRUITMENT_CASES_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${PARENT[c]}`)]),
  ) as Record<RecruitmentCasesCollection, StatementSync>;
  const counts = () =>
    Object.fromEntries(RECRUITMENT_CASES_COLLECTIONS.map((c) => [c, (counters[c].get() as { n: number }).n])) as Record<
      RecruitmentCasesCollection,
      number
    >;

  return {
    cases,
    comments,
    snapshots,
    decisions,
    evidenceStates,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({
      cases: readsOf(cases, writeKeys(caseWrites)),
      comments: readsOf(comments, writeKeys(commentWrites)),
      snapshots: readsOf(snapshots, writeKeys(snapshotWrites)),
      decisions: readsOf(decisions, writeKeys(decisionWrites)),
      evidenceStates: readsOf(evidenceStates, writeKeys(evidenceWrites)),
    }),
    /** The deletion unit: a deleted player's cases keep their ids, states and history and lose the name. */
    redactPlayer(playerId: string, at: number): number {
      return operation(
        () =>
          sqlite
            .prepare('UPDATE recruitment_cases SET player_name = NULL, subject_removed_at = ? WHERE player_id = ?')
            .run(at, playerId).changes as number,
      );
    },
    /** Check migration 0016 is recorded; there is nothing to load. */
    attach() {
      if (!recruitmentCasesLive(sqlite))
        throw new Error(
          `the recruitment-cases repository needs ${RECRUITMENT_CASES_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: counts() };
    },
    counts,
    exportAll(): RecruitmentCasesRecords {
      return readEvery(sqlite);
    },
    log,
    now,
  };
}
export type RecruitmentCasesRepository = ReturnType<typeof createRecruitmentCasesRepository>;
export type RecruitmentCasesReads = RecruitmentCasesRepository['reads'];
