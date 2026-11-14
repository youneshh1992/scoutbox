/**
 * Recruitment requests (with their trial slots) and accepted trials (with their schedule, attendance, history, keys,
 * reminders, reports and trial-day rows).
 *
 * Records (the keys every reader sees): `RecruitmentRequest` and `Trial` below, deep-frozen as read back. A trial
 * always reads back with its trial-day container, its five client-key lists and its reminder map.
 *
 * Writes (docs/architecture.md, Writes). A request or a trial is created whole and must read back as written: a field
 * the tables have no column for, at any depth, or a value a column would coerce, is refused with its id (the unit rolls
 * back). Then each changes only through named acts: a request is answered, given its channel, suspended or linked to
 * its trial; a trial's schedule is proposed, confirmed or declined, it is cancelled or completed, attendance and
 * evidence are recorded, its report filed, its reminders marked and its trial day kept. A trial act takes
 * `act(id, input, bookkeeping)`, the bookkeeping being its history entries, rev bump and client key. Each state change
 * is guarded in SQL (a schedule proposal is one past the current revision, nothing changes on an ended trial, a report
 * is filed once). The columns carry the vocabulary CHECKs of the domain rules (domains/recruitment/lifecycle/trial.mjs);
 * there is no JavaScript copy of them. An absent field reads back as null and an absent list as empty, so the input
 * types (`RecruitmentRequestInput`, `TrialInput`) let either be left out. A caller still in JavaScript can pass
 * anything: the columns judge it.
 *
 * References. `org_id` → orgs, `user_id` → org_users and `case_id` (both tables) → recruitment_cases (RESTRICT).
 * `recruitment_requests.trial_id` → trials is DEFERRABLE INITIALLY DEFERRED (checked at COMMIT): a request and the
 * trial it names are written in one unit. `trials.request_id` → recruitment_requests is immediate, and a report names its
 * trial's player (`(trial_id, player_id)` → trials). Player ids: no key,
 * tolerant and counted (Q7a in docs/decisions.md). Guardian ids: no key, checked in code at every write (Q7c).
 *
 * Refusals name tables, fields and ids, never a name, a message, a note, an address or a phone number.
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
import { ORG_TYPES, type OrgType } from './orgs.ts';
import {
  TRIAL_WORKFLOW_STATES,
  TRIAL_SESSION_KINDS,
  TRIAL_ATTENDANCE_STATES,
  TRIAL_ATTENDANCE_SOURCES,
  TRIAL_COMPLETION_STATES,
  TRIAL_CANCEL_ACTORS,
  TRIAL_STATUSES,
  TRIAL_STAFF_CHECK_STATES,
  TRIAL_DAY_EVENT_KINDS,
  TRIAL_CONSENT_SCOPES,
  TRIAL_KEY_ACTS,
  TRIAL_LIMITS,
} from '../domains/recruitment/public.mjs';
import { TRIAL_REPORT_FIELDS } from '../domain.ts';
import { refreshProfileSignals } from './players.ts';
import { writeKit } from './writes.ts';
import { ids } from './fieldSpecs.ts';
import { pageOf, readsOf } from './identityRules.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';

export const RECRUITMENT_MIGRATION = '0015_recruitment';
export const RECRUITMENT_COLLECTIONS = Object.freeze(['requests', 'trials'] as const);
export type RecruitmentCollection = (typeof RECRUITMENT_COLLECTIONS)[number];
export const REQUEST_TABLES = Object.freeze(['recruitment_requests', 'request_trial_slots'] as const);
export const TRIAL_TABLES = Object.freeze([
  'trials',
  'trial_schedule_sessions',
  'trial_session_evidence',
  'trial_schedule_revisions',
  'trial_revision_sessions',
  'trial_attendance',
  'trial_history',
  'trial_keys',
  'trial_reminders',
  'trial_reports',
  'trial_day_staff',
  'trial_day_consents',
  'trial_day_checkins',
  'trial_day_status_events',
] as const);
export const RECRUITMENT_TABLES = Object.freeze([...REQUEST_TABLES, ...TRIAL_TABLES] as const);
type RecruitmentTable = (typeof RECRUITMENT_TABLES)[number];
export const recruitmentLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, RECRUITMENT_MIGRATION);

const JSON_CHECK = (col: string) => `CHECK (${col} IS NULL OR json_valid(${col}))`;
/** The shared idempotency_keys table (the signing packages' keys; other domains keep their keys as columns). Its owner CHECK names the owner tables. */
export function idempotencyKeysDdl(owners: readonly string[]): { table: string; indexes: string[] } {
  return {
    table: `CREATE TABLE idempotency_keys (\n  owner_table                      TEXT NOT NULL CHECK (owner_table IN (${owners.map((o) => `'${o}'`).join(', ')})),\n  owner_id                         TEXT NOT NULL,\n  position                         INTEGER NOT NULL,\n  act                              TEXT NOT NULL,\n  shape                            TEXT NOT NULL CHECK (shape IN ('list', 'value')),\n  key                              TEXT,\n  fp                               TEXT,\n  at                               INTEGER,\n  entry_json                       TEXT NOT NULL ${JSON_CHECK('entry_json')},\n  PRIMARY KEY (owner_table, owner_id, position)\n) STRICT;`,
    indexes: ['CREATE INDEX idempotency_keys_owner_act_key ON idempotency_keys (owner_table, owner_id, act, key)'],
  };
}

// ------------------------------------------------------------------ vocabulary
export const REQUEST_TYPES = Object.freeze(['contact', 'trial'] as const);
/** `suspended`: an urgent safety report froze the pending request (wiring.mjs, the report route). */
export const REQUEST_STATUSES = Object.freeze(['pending', 'accepted', 'declined', 'suspended'] as const);
export const PARTIES = Object.freeze(['player', 'guardian'] as const);
export const ACTOR_KINDS = Object.freeze(['org', 'player', 'guardian', 'system'] as const);
export const EVIDENCE_KINDS = Object.freeze(['box_cam_session'] as const);
export type RequestType = (typeof REQUEST_TYPES)[number];
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type Party = (typeof PARTIES)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type TrialWorkflowState = (typeof TRIAL_WORKFLOW_STATES)[number];
export type TrialSessionKind = (typeof TRIAL_SESSION_KINDS)[number];
export type TrialAttendanceState = (typeof TRIAL_ATTENDANCE_STATES)[number];
export type TrialAttendanceSource = (typeof TRIAL_ATTENDANCE_SOURCES)[number];
export type TrialCompletionState = (typeof TRIAL_COMPLETION_STATES)[number];
export type TrialCancelActor = (typeof TRIAL_CANCEL_ACTORS)[number];
export type TrialStatus = (typeof TRIAL_STATUSES)[number];
export type TrialStaffCheckState = (typeof TRIAL_STAFF_CHECK_STATES)[number];
export type TrialDayEventKind = (typeof TRIAL_DAY_EVENT_KINDS)[number];
export type TrialConsentScope = (typeof TRIAL_CONSENT_SCOPES)[number];
export type TrialKeyAct = (typeof TRIAL_KEY_ACTS)[number];
export type TrialReportMetric = (typeof TRIAL_REPORT_FIELDS)[number];
function snake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ------------------------------------------------------------------ records
/**
 * Who did something: an organisation member (`userId`) or a player, guardian or the system (`id`), with the name
 * shown. An actor whose name and id were erased with the player keeps only its kind.
 */
export type Actor =
  | { kind: 'org'; userId: string | null; name: string | null }
  | { kind: Exclude<ActorKind, 'org'>; id: string | null; name: string | null }
  | { kind: ActorKind };
export type Venue = { name: string; town: string | null; address: string | null };
type SessionFields = {
  id: string;
  kind: TrialSessionKind;
  startsAt: number;
  endsAt: number;
  venue: Venue | null;
  instructions: string | null;
};
/** A Box Cam session cited on a trial session; a withdrawn link keeps its removal. */
type EvidenceFields = {
  id: string;
  kind: EvidenceKind;
  sessionId: string;
  linkedAt: number;
  linkedBy: Actor | null;
  removedAt: number | null;
  removedBy: Actor | null;
};
type ScheduleRevisionFields = {
  revision: number;
  timezone: string;
  sessions: SessionFields[];
  proposedAt: number | null;
  proposedBy: Actor | null;
  confirmedAt: number | null;
  confirmedBy: Actor | null;
  supersededAt: number | null;
  reason: string | null;
  material: boolean | null;
};
type ScheduleFields = {
  timezone: string;
  revision: number;
  proposedAt: number | null;
  proposedBy: Actor | null;
  confirmedAt: number | null;
  confirmedBy: Actor | null;
  declinedAt: number | null;
  declinedBy: Actor | null;
  sessions: (SessionFields & { evidence: EvidenceFields[] })[];
  revisions: ScheduleRevisionFields[];
};
type AttendanceFields = {
  sessionId: string;
  state: TrialAttendanceState;
  source: TrialAttendanceSource;
  recordedBy: Actor | null;
  recordedAt: number;
  note: string | null;
};
type HistoryFields = {
  id: string;
  at: number;
  action: string;
  by: Actor | null;
  detail: Record<string, unknown> | null;
};
type ClientKey = { key: string; fp: string; at: number };
type TrialReportFields = {
  id: string;
  trialId: string;
  playerId: string;
  orgId: string;
  orgName: string | null;
  userId: string | null;
  scoutName: string | null;
  filedAt: number;
  notes: string | null;
  strengthNote: string | null;
  focusNote: string | null;
} & Record<TrialReportMetric, number>;
type StaffCheckFields = {
  kind: string | null;
  ref: string | null;
  status: TrialStaffCheckState;
  expiresAt: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
};
type StaffFields = {
  id: string;
  name: string;
  role: string;
  check: StaffCheckFields | null;
  addedBy: string | null;
  addedAt: number;
};
type ConsentFields = { id: string; by: Actor | null; scope: TrialConsentScope; at: number };
type CheckinFields = { playerId: string; at: number; byUserId: string | null; byName: string | null };
type StatusEventFields = {
  kind: TrialDayEventKind;
  at: number;
  by: string | null;
  reason: string | null;
  newDate: string | null;
};
type ArrivalFields = { time: string | null; address: string | null; notes: string | null };
type EmergencyFields = { name: string | null; phone: string | null; setBy: Party | null; at: number };
type TrialDayFields = {
  staff: StaffFields[];
  consents: ConsentFields[];
  arrival: ArrivalFields | null;
  emergency: EmergencyFields | null;
  checkins: CheckinFields[];
  collection: { policy: string } | null;
  statusEvents: StatusEventFields[];
};
type CompletionFields = {
  state: TrialCompletionState;
  at: number;
  by: Actor | null;
  reason: string | null;
  phase: TrialWorkflowState | null;
  cancelledBy: TrialCancelActor | null;
};
type TrialRecipientFields = {
  type: Party;
  playerId: string | null;
  guardianId: string | null;
  minor: boolean;
  at: number | null;
};
/** What the case's lifecycle did with the trial's last step. */
type LifecycleFields =
  | { applied: true; from: string | null; to: string | null; at: number | null }
  | { applied: false; reason: string | null; at: number | null };
type RevByFields = { userId: string | null; name: string | null };
type TrialFields = {
  id: string;
  requestId: string;
  caseId: string | null;
  playerId: string;
  playerName: string | null;
  orgId: string;
  orgName: string;
  scoutName: string | null;
  acceptedAt: number;
  acceptedBy: Party | null;
  guardianApproved: boolean | null;
  proposedDate: string | null;
  venue: string | null;
  notes: string | null;
  reportDueAt: number | null;
  status: TrialStatus;
  reminderSent: boolean;
  feedbackEscalatedAt: number | null;
  report: TrialReportFields | null;
  day: TrialDayFields;
  workflowState: TrialWorkflowState;
  schedule: ScheduleFields | null;
  attendance: AttendanceFields[];
  completion: CompletionFields | null;
  recipient: TrialRecipientFields | null;
  keys: Record<TrialKeyAct, ClientKey[]>;
  history: HistoryFields[];
  /** Reminder markers and when each was sent. */
  reminders: Record<string, number>;
  lifecycle: LifecycleFields | null;
  rev: number;
  revAt: number | null;
  revBy: RevByFields | null;
  subjectRemovedAt: number | null;
};
type SlotFields = {
  id: string;
  day: string;
  kind: TrialSessionKind;
  startsAt: number;
  endsAt: number;
  timezone: string;
  venue: Venue | null;
};
type TrialDetailsFields = {
  proposedDate: string | null;
  /** The other days the recipient may pick. */
  altSlots: string[];
  venue: string | null;
  notes: string | null;
  slots: SlotFields[];
  /** Shown to the recipient only once they accept. */
  private: { venueAddress: string | null; instructions: string | null } | null;
};
type RequestRecipientFields = { type: Party; playerId: string | null; guardianId: string | null; minor: boolean };
type RequestFields = {
  id: string;
  playerId: string;
  playerName: string | null;
  orgId: string;
  orgName: string;
  orgType: OrgType | null;
  orgVerified: boolean;
  orgSafeguardingCertified: boolean;
  trustedPartner: boolean | null;
  userId: string;
  scoutName: string | null;
  scoutRole: string | null;
  type: RequestType;
  message: string | null;
  subject: string | null;
  contactId: string | null;
  /** Present on a trial invitation, null on a contact request. */
  trialDetails: TrialDetailsFields | null;
  status: RequestStatus;
  createdAt: number;
  respondedAt: number | null;
  respondedBy: Party | null;
  routedTo: Party;
  guardianId: string | null;
  contactChannel: string | null;
  caseId: string | null;
  trialId: string | null;
  recipient: RequestRecipientFields | null;
  keys: { invite: { key: string; fp: string } | null };
  subjectRemovedAt: number | null;
};

export type RecruitmentRequest = DeepReadonly<RequestFields>;
export type Trial = DeepReadonly<TrialFields>;
export type TrialSession = DeepReadonly<SessionFields>;
export type TrialEvidence = DeepReadonly<EvidenceFields>;
export type TrialScheduleRevision = DeepReadonly<ScheduleRevisionFields>;
export type TrialAttendance = DeepReadonly<AttendanceFields>;
export type TrialHistoryEntry = DeepReadonly<HistoryFields>;
/** A filed report, as a trial carries it and as the player's reports list it (not frozen there). */
export type TrialReport = DeepReadonly<TrialReportFields>;
export type TrialStaff = DeepReadonly<StaffFields>;
export type TrialDay = DeepReadonly<TrialDayFields>;
export type TrialLifecycle = DeepReadonly<LifecycleFields>;

// ------------------------------------------------------------------ inputs
type Flatten<T> = { [K in keyof T]: T[K] } & {};
type Omissible<V> = null extends V ? true : V extends readonly unknown[] ? true : false;
/** What a writer passes for a record: a field that may be null, and a list, may be left out, at any depth. */
type InputFor<T> = T extends readonly (infer E)[]
  ? InputFor<E>[]
  : T extends object
    ? Flatten<
        { [K in keyof T as Omissible<T[K]> extends true ? never : K]: InputFor<T[K]> } & {
          [K in keyof T as Omissible<T[K]> extends true ? K : never]?: InputFor<T[K]>;
        }
      >
    : T;
export type ActorInput = InputFor<Actor>;
export type VenueInput = InputFor<Venue>;
export type TrialSessionInput = InputFor<SessionFields>;
export type TrialEvidenceInput = InputFor<EvidenceFields>;
export type TrialAttendanceInput = InputFor<AttendanceFields>;
export type TrialHistoryInput = InputFor<HistoryFields>;
/** A report is filed on its trial, so its `trialId` may be left out. */
export type TrialReportInput = Flatten<Omit<InputFor<TrialReportFields>, 'trialId'> & { trialId?: string }>;
export type TrialStaffInput = InputFor<StaffFields>;
export type TrialConsentInput = InputFor<ConsentFields>;
export type TrialCheckinInput = InputFor<CheckinFields>;
export type TrialStatusEventInput = InputFor<StatusEventFields>;
export type TrialArrivalInput = InputFor<ArrivalFields>;
export type TrialEmergencyInput = InputFor<EmergencyFields>;
export type TrialRecipientInput = InputFor<TrialRecipientFields>;
export type TrialLifecycleInput = InputFor<LifecycleFields>;
/** A new request, whole; its invite key may be left out. */
export type RecruitmentRequestInput = Flatten<
  Omit<InputFor<RequestFields>, 'keys'> & { keys?: { invite?: { key: string; fp: string } | null } }
>;
/** A new trial, whole; its trial day, keys, reminders and report may be left out, and `reminderSent` is false. */
export type TrialInput = Flatten<
  Omit<InputFor<TrialFields>, 'day' | 'keys' | 'reminders' | 'reminderSent' | 'report'> & {
    day?: InputFor<TrialDayFields>;
    keys?: Partial<Record<TrialKeyAct, ClientKey[]>>;
    reminders?: Record<string, number>;
    reminderSent?: boolean;
    report?: TrialReportInput | null;
  }
>;

// ------------------------------------------------------------------ DDL
const inList = (col: string, list: readonly string[]) =>
  `CHECK (${col} IS NULL OR ${col} IN (${list.map((v) => `'${v}'`).join(',')}))`;
const maxLen = (col: string, n: number) => `CHECK (${col} IS NULL OR length(${col}) <= ${n})`;
const bool = (col: string) => `CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const dayCheck = (col: string) => `CHECK (${col} IS NULL OR ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
/** An actor: an organisation member (`user_id`) or a family member / the system (`actor_id`), with the name shown. */
const actor = (p: string) =>
  `  ${p}_kind TEXT ${inList(`${p}_kind`, ACTOR_KINDS)},\n  ${p}_user_id TEXT,\n  ${p}_actor_id TEXT,\n  ${p}_name TEXT`;
const venue = (p: string) =>
  `  ${p}_name TEXT ${maxLen(`${p}_name`, TRIAL_LIMITS.venueName)},\n  ${p}_town TEXT ${maxLen(`${p}_town`, TRIAL_LIMITS.venueTown)},\n  ${p}_address TEXT ${maxLen(`${p}_address`, TRIAL_LIMITS.venueAddress)}`;
const sessionCols = () =>
  `  id TEXT NOT NULL,\n  kind TEXT NOT NULL ${inList('kind', TRIAL_SESSION_KINDS)},\n  starts_at INTEGER NOT NULL,\n  ends_at INTEGER NOT NULL,\n${venue('venue')},\n  instructions TEXT ${maxLen('instructions', TRIAL_LIMITS.instructions)}`;
const ownedBy = (table: string, col = 'trial_id') => `  ${col} TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE`;

export const RECRUITMENT_DDL = `
CREATE TABLE recruitment_requests (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  player_name TEXT,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name TEXT NOT NULL,
  org_type TEXT ${inList('org_type', ORG_TYPES)},
  org_verified INTEGER NOT NULL ${bool('org_verified')},
  org_safeguarding_certified INTEGER NOT NULL ${bool('org_safeguarding_certified')},
  org_trusted_partner INTEGER ${bool('org_trusted_partner')},
  user_id TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT,
  scout_name TEXT,
  scout_role TEXT,
  type TEXT NOT NULL ${inList('type', REQUEST_TYPES)},
  message TEXT,
  subject TEXT,
  contact_id TEXT,
  trial_proposed_date TEXT ${dayCheck('trial_proposed_date')},
  trial_alt_days_json TEXT CHECK (trial_alt_days_json IS NULL OR (json_valid(trial_alt_days_json) AND json_type(trial_alt_days_json) = 'array')),
  trial_venue TEXT,
  trial_notes TEXT,
  trial_private_venue_address TEXT ${maxLen('trial_private_venue_address', TRIAL_LIMITS.venueAddress)},
  trial_private_instructions TEXT ${maxLen('trial_private_instructions', TRIAL_LIMITS.instructions)},
  status TEXT NOT NULL ${inList('status', REQUEST_STATUSES)},
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  responded_by TEXT ${inList('responded_by', PARTIES)},
  routed_to TEXT NOT NULL ${inList('routed_to', PARTIES)},
  guardian_id TEXT,
  contact_channel_id TEXT,
  case_id TEXT REFERENCES recruitment_cases(id) ON DELETE RESTRICT,
  trial_id TEXT REFERENCES trials(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  recipient_type TEXT ${inList('recipient_type', PARTIES)},
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER ${bool('recipient_minor')},
  invite_key TEXT ${maxLen('invite_key', TRIAL_LIMITS.clientKey)},
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
${ownedBy('recruitment_requests', 'request_id')},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  day TEXT NOT NULL ${dayCheck('day')},
  kind TEXT NOT NULL ${inList('kind', TRIAL_SESSION_KINDS)},
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  timezone TEXT NOT NULL,
${venue('venue')},
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
  accepted_by TEXT ${inList('accepted_by', PARTIES)},
  guardian_approved INTEGER ${bool('guardian_approved')},
  proposed_date TEXT ${dayCheck('proposed_date')},
  venue TEXT,
  notes TEXT,
  report_due_at INTEGER,
  status TEXT NOT NULL ${inList('status', TRIAL_STATUSES)},
  reminder_sent INTEGER NOT NULL ${bool('reminder_sent')},
  feedback_escalated_at INTEGER,
  workflow_state TEXT NOT NULL ${inList('workflow_state', TRIAL_WORKFLOW_STATES)},
  schedule_timezone TEXT,
  schedule_revision INTEGER,
  schedule_proposed_at INTEGER,
${actor('schedule_proposed_by')},
  schedule_confirmed_at INTEGER,
${actor('schedule_confirmed_by')},
  schedule_declined_at INTEGER,
${actor('schedule_declined_by')},
  completion_state TEXT ${inList('completion_state', TRIAL_COMPLETION_STATES)},
  completion_at INTEGER,
${actor('completion_by')},
  completion_reason TEXT ${maxLen('completion_reason', TRIAL_LIMITS.reason)},
  completion_phase TEXT ${inList('completion_phase', TRIAL_WORKFLOW_STATES)},
  completion_cancelled_by TEXT ${inList('completion_cancelled_by', TRIAL_CANCEL_ACTORS)},
  recipient_type TEXT ${inList('recipient_type', PARTIES)},
  recipient_player_id TEXT,
  recipient_guardian_id TEXT,
  recipient_minor INTEGER ${bool('recipient_minor')},
  recipient_at INTEGER,
  lifecycle_applied INTEGER ${bool('lifecycle_applied')},
  lifecycle_from TEXT,
  lifecycle_to TEXT,
  lifecycle_reason TEXT,
  lifecycle_at INTEGER,
  day_arrival_time TEXT ${maxLen('day_arrival_time', 40)},
  day_arrival_address TEXT ${maxLen('day_arrival_address', 200)},
  day_arrival_notes TEXT ${maxLen('day_arrival_notes', 300)},
  day_emergency_name TEXT ${maxLen('day_emergency_name', 80)},
  day_emergency_phone TEXT ${maxLen('day_emergency_phone', 30)},
  day_emergency_set_by TEXT ${inList('day_emergency_set_by', PARTIES)},
  day_emergency_at INTEGER,
  day_collection_policy TEXT ${maxLen('day_collection_policy', 300)},
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
${ownedBy('trials')},
  position INTEGER NOT NULL,
${sessionCols()},
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
  kind TEXT NOT NULL ${inList('kind', EVIDENCE_KINDS)},
  box_session_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
${actor('linked_by')},
  removed_at INTEGER,
${actor('removed_by')},
  PRIMARY KEY (trial_id, session_id, position),
  FOREIGN KEY (trial_id, session_id) REFERENCES trial_schedule_sessions(trial_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX trial_session_evidence_box_session ON trial_session_evidence (box_session_id);
CREATE UNIQUE INDEX trial_session_evidence_one_active ON trial_session_evidence (trial_id, session_id, box_session_id) WHERE removed_at IS NULL;
CREATE TABLE trial_schedule_revisions (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  proposed_at INTEGER,
${actor('proposed_by')},
  confirmed_at INTEGER,
${actor('confirmed_by')},
  superseded_at INTEGER,
  reason TEXT ${maxLen('reason', TRIAL_LIMITS.reason)},
  material INTEGER ${bool('material')},
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, revision)
) STRICT;
CREATE TABLE trial_revision_sessions (
  trial_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
${sessionCols()},
  PRIMARY KEY (trial_id, revision, position),
  FOREIGN KEY (trial_id, revision) REFERENCES trial_schedule_revisions(trial_id, revision) ON DELETE CASCADE
) STRICT;
CREATE TABLE trial_attendance (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL ${inList('state', TRIAL_ATTENDANCE_STATES)},
  source TEXT NOT NULL ${inList('source', TRIAL_ATTENDANCE_SOURCES)},
${actor('recorded_by')},
  recorded_at INTEGER NOT NULL,
  note TEXT ${maxLen('note', TRIAL_LIMITS.note)},
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE INDEX trial_attendance_trial_session_at ON trial_attendance (trial_id, session_id, recorded_at);
CREATE TABLE trial_history (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL ${maxLen('action', 64)},
${actor('by')},
  detail_json TEXT CHECK (detail_json IS NULL OR (json_valid(detail_json) AND json_type(detail_json) = 'object')),
  PRIMARY KEY (trial_id, position),
  UNIQUE (trial_id, id)
) STRICT;
CREATE INDEX trial_history_trial_at ON trial_history (trial_id, at);
CREATE TABLE trial_keys (
${ownedBy('trials')},
  act TEXT NOT NULL ${inList('act', TRIAL_KEY_ACTS)},
  position INTEGER NOT NULL,
  key TEXT NOT NULL ${maxLen('key', TRIAL_LIMITS.clientKey)},
  fp TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, act, position)
) STRICT;
CREATE INDEX trial_keys_key ON trial_keys (trial_id, act, key);
CREATE TABLE trial_reminders (
${ownedBy('trials')},
  marker TEXT NOT NULL ${maxLen('marker', 120)},
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
${TRIAL_REPORT_FIELDS.map((f) => `  ${snake(f)} REAL NOT NULL`).join(',\n')},
  notes TEXT,
  strength_note TEXT,
  focus_note TEXT,
  FOREIGN KEY (trial_id, player_id) REFERENCES trials(id, player_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX trial_reports_player ON trial_reports (player_id, filed_at);
CREATE INDEX trial_reports_org ON trial_reports (org_id, filed_at);
CREATE TABLE trial_day_staff (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL ${maxLen('name', 80)},
  role TEXT NOT NULL ${maxLen('role', 60)},
  check_kind TEXT ${maxLen('check_kind', 60)},
  check_ref TEXT ${maxLen('check_ref', 60)},
  check_status TEXT ${inList('check_status', TRIAL_STAFF_CHECK_STATES)},
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
${ownedBy('trials')},
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
${actor('by')},
  scope TEXT NOT NULL ${inList('scope', TRIAL_CONSENT_SCOPES)},
  at INTEGER NOT NULL,
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE UNIQUE INDEX trial_day_consents_one_per_actor ON trial_day_consents (trial_id, scope, by_actor_id) WHERE by_actor_id IS NOT NULL;
CREATE TABLE trial_day_checkins (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by_user_id TEXT,
  by_name TEXT,
  PRIMARY KEY (trial_id, position)
) STRICT;
CREATE TABLE trial_day_status_events (
${ownedBy('trials')},
  position INTEGER NOT NULL,
  kind TEXT NOT NULL ${inList('kind', TRIAL_DAY_EVENT_KINDS)},
  at INTEGER NOT NULL,
  by_name TEXT,
  reason TEXT ${maxLen('reason', 200)},
  new_date TEXT ${dayCheck('new_date')},
  PRIMARY KEY (trial_id, position)
) STRICT;
`;

// ------------------------------------------------------------------ rows (tolerant encoders: an absent field is null, an absent list empty)
/** A row as read back: each column an encoder writes, an absent value NULL. */
type RowOf<F extends (...args: never[]) => object> = {
  [K in keyof ReturnType<F>]-?:
    | Exclude<ReturnType<F>[K], undefined>
    | (undefined extends ReturnType<F>[K] ? null : never);
};
const b = (v: boolean | null | undefined): 0 | 1 | null => (v === null || v === undefined ? null : v ? 1 : 0);
const flagOut = (v: 0 | 1 | null): boolean | null => (v === null ? null : v === 1);
/** Bind an absent field as NULL. */
const nulls = (row: object): Record<string, SQLInputValue> => {
  const r = row as Record<string, SQLInputValue | undefined>;
  for (const k of Object.keys(r)) if (r[k] === undefined) r[k] = null;
  return r as Record<string, SQLInputValue>;
};
type ActorCols<P extends string> = Record<`${P}_kind`, ActorKind | null> &
  Record<`${P}_user_id` | `${P}_actor_id` | `${P}_name`, string | null>;
const actorRow = <P extends string>(p: P, a: ActorInput | null | undefined): ActorCols<P> =>
  ({
    [`${p}_kind`]: a?.kind ?? null,
    [`${p}_user_id`]: a?.kind === 'org' ? ((a as { userId?: string | null }).userId ?? null) : null,
    [`${p}_actor_id`]: a && a.kind !== 'org' ? ((a as { id?: string | null }).id ?? null) : null,
    [`${p}_name`]: (a as { name?: string | null } | null | undefined)?.name ?? null,
  }) as ActorCols<P>;
const actorOut = <P extends string>(row: ActorCols<P>, p: P): Actor | null => {
  const r = row as Record<string, string | null>;
  const kind = r[`${p}_kind`] as ActorKind | null;
  if (kind === null) return null;
  const userId = r[`${p}_user_id`];
  const id = r[`${p}_actor_id`];
  const name = r[`${p}_name`];
  if (userId === null && id === null && name === null) return { kind };
  return kind === 'org' ? { kind: 'org', userId, name } : { kind, id, name };
};
type HistoryRow = RowOf<typeof historyRow>;
const trialHistoryOut = (h: HistoryRow): HistoryFields => ({
  id: h.id,
  at: h.at,
  action: h.action,
  by: actorOut(h, 'by'),
  detail: h.detail_json === null ? null : JSON.parse(h.detail_json),
});
type VenueCols<P extends string> = Record<`${P}_name` | `${P}_town` | `${P}_address`, string | null>;
const venueRow = <P extends string>(p: P, v: VenueInput | null | undefined): VenueCols<P> =>
  ({
    [`${p}_name`]: v?.name ?? null,
    [`${p}_town`]: v?.town ?? null,
    [`${p}_address`]: v?.address ?? null,
  }) as VenueCols<P>;
const venueOut = <P extends string>(row: VenueCols<P>, p: P): Venue | null => {
  const r = row as Record<string, string | null>;
  const name = r[`${p}_name`];
  return name === null ? null : { name, town: r[`${p}_town`], address: r[`${p}_address`] };
};
const sessionRow = (s: TrialSessionInput) => ({
  id: s.id,
  kind: s.kind,
  starts_at: s.startsAt,
  ends_at: s.endsAt,
  ...venueRow('venue', s.venue),
  instructions: s.instructions,
});
type SessionRow = RowOf<typeof sessionRow>;
const sessionOut = (r: SessionRow): SessionFields => ({
  id: r.id,
  kind: r.kind,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  venue: venueOut(r, 'venue'),
  instructions: r.instructions,
});

const requestRow = (q: RecruitmentRequestInput) => {
  const td = q.trialDetails ?? null;
  return {
    id: q.id,
    player_id: q.playerId,
    player_name: q.playerName,
    org_id: q.orgId,
    org_name: q.orgName,
    org_type: q.orgType,
    org_verified: b(q.orgVerified),
    org_safeguarding_certified: b(q.orgSafeguardingCertified),
    org_trusted_partner: b(q.trustedPartner),
    user_id: q.userId,
    scout_name: q.scoutName,
    scout_role: q.scoutRole,
    type: q.type,
    message: q.message,
    subject: q.subject,
    contact_id: q.contactId,
    trial_proposed_date: td?.proposedDate,
    trial_alt_days_json: td ? JSON.stringify(td.altSlots ?? []) : null,
    trial_venue: td?.venue,
    trial_notes: td?.notes,
    trial_private_venue_address: td?.private?.venueAddress,
    trial_private_instructions: td?.private?.instructions,
    status: q.status,
    created_at: q.createdAt,
    responded_at: q.respondedAt,
    responded_by: q.respondedBy,
    routed_to: q.routedTo,
    guardian_id: q.guardianId,
    contact_channel_id: q.contactChannel,
    case_id: q.caseId,
    trial_id: q.trialId,
    recipient_type: q.recipient?.type,
    recipient_player_id: q.recipient?.playerId,
    recipient_guardian_id: q.recipient?.guardianId,
    recipient_minor: b(q.recipient?.minor),
    invite_key: q.keys?.invite?.key,
    invite_fp: q.keys?.invite?.fp,
    subject_removed_at: q.subjectRemovedAt,
  };
};
type RequestRow = RowOf<typeof requestRow>;
const slotRow = (rid: string, s: InputFor<SlotFields>, position: number) => ({
  request_id: rid,
  position,
  id: s.id,
  day: s.day,
  kind: s.kind,
  starts_at: s.startsAt,
  ends_at: s.endsAt,
  timezone: s.timezone,
  ...venueRow('venue', s.venue),
});
type SlotRow = RowOf<typeof slotRow>;
type ScheduleInput = NonNullable<TrialInput['schedule']>;
const scheduleCols = (sc: ScheduleInput | null | undefined) => ({
  schedule_timezone: sc?.timezone,
  schedule_revision: sc?.revision,
  schedule_proposed_at: sc?.proposedAt,
  ...actorRow('schedule_proposed_by', sc?.proposedBy),
  schedule_confirmed_at: sc?.confirmedAt,
  ...actorRow('schedule_confirmed_by', sc?.confirmedBy),
  schedule_declined_at: sc?.declinedAt,
  ...actorRow('schedule_declined_by', sc?.declinedBy),
});
const completionCols = (c: InputFor<CompletionFields> | null | undefined) => ({
  completion_state: c?.state,
  completion_at: c?.at,
  ...actorRow('completion_by', c?.by),
  completion_reason: c?.reason,
  completion_phase: c?.phase,
  completion_cancelled_by: c?.cancelledBy,
});
const recipientCols = (r: TrialRecipientInput | null | undefined) => ({
  recipient_type: r?.type,
  recipient_player_id: r?.playerId,
  recipient_guardian_id: r?.guardianId,
  recipient_minor: b(r?.minor),
  recipient_at: r?.at,
});
const lifecycleCols = (lc: TrialLifecycleInput | null | undefined) => {
  const l = lc as
    | { applied?: boolean; from?: string | null; to?: string | null; reason?: string | null; at?: number | null }
    | null
    | undefined;
  return {
    lifecycle_applied: b(l?.applied),
    lifecycle_from: l?.from,
    lifecycle_to: l?.to,
    lifecycle_reason: l?.reason,
    lifecycle_at: l?.at,
  };
};
const arrivalCols = (a: TrialArrivalInput | null | undefined) => ({
  day_arrival_time: a?.time,
  day_arrival_address: a?.address,
  day_arrival_notes: a?.notes,
});
const emergencyCols = (e: TrialEmergencyInput | null | undefined) => ({
  day_emergency_name: e?.name,
  day_emergency_phone: e?.phone,
  day_emergency_set_by: e?.setBy,
  day_emergency_at: e?.at,
});
const trialRow = (t: TrialInput) => ({
  id: t.id,
  request_id: t.requestId,
  case_id: t.caseId,
  player_id: t.playerId,
  player_name: t.playerName,
  org_id: t.orgId,
  org_name: t.orgName,
  scout_name: t.scoutName,
  accepted_at: t.acceptedAt,
  accepted_by: t.acceptedBy,
  guardian_approved: b(t.guardianApproved),
  proposed_date: t.proposedDate,
  venue: t.venue,
  notes: t.notes,
  report_due_at: t.reportDueAt,
  status: t.status,
  reminder_sent: b(t.reminderSent ?? false) as 0 | 1,
  feedback_escalated_at: t.feedbackEscalatedAt,
  workflow_state: t.workflowState,
  ...scheduleCols(t.schedule),
  ...completionCols(t.completion),
  ...recipientCols(t.recipient),
  ...lifecycleCols(t.lifecycle),
  ...arrivalCols(t.day?.arrival),
  ...emergencyCols(t.day?.emergency),
  day_collection_policy: t.day?.collection?.policy,
  rev: t.rev,
  rev_at: t.revAt,
  rev_by_user_id: t.revBy?.userId,
  rev_by_name: t.revBy?.name,
  subject_removed_at: t.subjectRemovedAt,
});
type TrialRow = RowOf<typeof trialRow>;
const scheduleSessionRow = (tid: string, s: TrialSessionInput, position: number) => ({
  trial_id: tid,
  position,
  ...sessionRow(s),
});
const evidenceRow = (tid: string, sessionId: string, e: TrialEvidenceInput, position: number) => ({
  trial_id: tid,
  session_id: sessionId,
  position,
  id: e.id,
  kind: e.kind,
  box_session_id: e.sessionId,
  linked_at: e.linkedAt,
  ...actorRow('linked_by', e.linkedBy),
  removed_at: e.removedAt,
  ...actorRow('removed_by', e.removedBy),
});
type EvidenceRow = RowOf<typeof evidenceRow>;
const revisionRow = (tid: string, r: InputFor<Omit<ScheduleRevisionFields, 'sessions'>>, position: number) => ({
  trial_id: tid,
  position,
  revision: r.revision,
  timezone: r.timezone,
  proposed_at: r.proposedAt,
  ...actorRow('proposed_by', r.proposedBy),
  confirmed_at: r.confirmedAt,
  ...actorRow('confirmed_by', r.confirmedBy),
  superseded_at: r.supersededAt,
  reason: r.reason,
  material: b(r.material),
});
type RevisionRow = RowOf<typeof revisionRow>;
const revisionSessionRow = (tid: string, revision: number, s: TrialSessionInput, position: number) => ({
  trial_id: tid,
  revision,
  position,
  ...sessionRow(s),
});
const attendanceRow = (tid: string, a: TrialAttendanceInput, position: number) => ({
  trial_id: tid,
  position,
  session_id: a.sessionId,
  state: a.state,
  source: a.source,
  ...actorRow('recorded_by', a.recordedBy),
  recorded_at: a.recordedAt,
  note: a.note,
});
type AttendanceRow = RowOf<typeof attendanceRow>;
const historyRow = (tid: string, h: TrialHistoryInput, position: number) => ({
  trial_id: tid,
  position,
  id: h.id,
  at: h.at,
  action: h.action,
  ...actorRow('by', h.by),
  detail_json: h.detail === null || h.detail === undefined ? null : JSON.stringify(h.detail),
});
const keyRow = (tid: string, act: TrialKeyAct, k: ClientKey, position: number) => ({
  trial_id: tid,
  act,
  position,
  key: k.key,
  fp: k.fp,
  at: k.at,
});
type KeyRow = RowOf<typeof keyRow>;
const reportRow = (tid: string, r: TrialReportInput) => ({
  trial_id: tid,
  id: r.id,
  player_id: r.playerId,
  org_id: r.orgId,
  org_name: r.orgName,
  user_id: r.userId,
  scout_name: r.scoutName,
  filed_at: r.filedAt,
  ...(Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [snake(f), r[f]])) as Record<string, number>),
  notes: r.notes,
  strength_note: r.strengthNote,
  focus_note: r.focusNote,
});
/** A report's row: its metrics are columns named after them in snake case. */
type ReportRow = {
  trial_id: string;
  id: string;
  player_id: string;
  org_id: string;
  org_name: string | null;
  user_id: string | null;
  scout_name: string | null;
  filed_at: number;
  notes: string | null;
  strength_note: string | null;
  focus_note: string | null;
  [metric: string]: SQLOutputValue;
};
const staffRow = (tid: string, s: TrialStaffInput, position: number) => ({
  trial_id: tid,
  position,
  id: s.id,
  name: s.name,
  role: s.role,
  check_kind: s.check?.kind,
  check_ref: s.check?.ref,
  check_status: s.check?.status,
  check_expires_at: s.check?.expiresAt,
  check_reviewed_by: s.check?.reviewedBy,
  check_reviewed_at: s.check?.reviewedAt,
  added_by_name: s.addedBy,
  added_at: s.addedAt,
});
type StaffRow = RowOf<typeof staffRow>;
const consentRow = (tid: string, c: TrialConsentInput, position: number) => ({
  trial_id: tid,
  position,
  id: c.id,
  ...actorRow('by', c.by),
  scope: c.scope,
  at: c.at,
});
type ConsentRow = RowOf<typeof consentRow>;
const checkinRow = (tid: string, c: TrialCheckinInput, position: number) => ({
  trial_id: tid,
  position,
  player_id: c.playerId,
  at: c.at,
  by_user_id: c.byUserId,
  by_name: c.byName,
});
type CheckinRow = RowOf<typeof checkinRow>;
const statusEventRow = (tid: string, e: TrialStatusEventInput, position: number) => ({
  trial_id: tid,
  position,
  kind: e.kind,
  at: e.at,
  by_name: e.by,
  reason: e.reason,
  new_date: e.newDate,
});
type StatusEventRow = RowOf<typeof statusEventRow>;
type ReminderRow = { trial_id: string; marker: string; sent_at: number };
// The encoders read every field of an empty record as absent, so their keys are the tables' columns.
const none = <T>() => ({}) as T;
const COLS: Record<RecruitmentTable, string[]> = {
  recruitment_requests: Object.keys(requestRow(none())),
  request_trial_slots: Object.keys(slotRow('r', none(), 0)),
  trials: Object.keys(trialRow(none())),
  trial_schedule_sessions: Object.keys(scheduleSessionRow('t', none(), 0)),
  trial_session_evidence: Object.keys(evidenceRow('t', 's', none(), 0)),
  trial_schedule_revisions: Object.keys(revisionRow('t', none(), 0)),
  trial_revision_sessions: Object.keys(revisionSessionRow('t', 1, none(), 0)),
  trial_attendance: Object.keys(attendanceRow('t', none(), 0)),
  trial_history: Object.keys(historyRow('t', none(), 0)),
  trial_keys: Object.keys(keyRow('t', 'schedule', none(), 0)),
  trial_reminders: ['trial_id', 'marker', 'sent_at'],
  trial_reports: Object.keys(reportRow('t', none())),
  trial_day_staff: Object.keys(staffRow('t', none(), 0)),
  trial_day_consents: Object.keys(consentRow('t', none(), 0)),
  trial_day_checkins: Object.keys(checkinRow('t', none(), 0)),
  trial_day_status_events: Object.keys(statusEventRow('t', none(), 0)),
};
/** A trial keeps the newest idempotency keys of each act. */
const KEYS_KEPT = 50;

// ------------------------------------------------------------------ statements and the record readers
const TRIAL_CHILD_TABLES = Object.freeze([
  'trial_schedule_sessions',
  'trial_schedule_revisions',
  'trial_attendance',
  'trial_history',
  'trial_reminders',
  'trial_reports',
  'trial_day_staff',
  'trial_day_consents',
  'trial_day_checkins',
  'trial_day_status_events',
] as const);
type TrialChildTable = (typeof TRIAL_CHILD_TABLES)[number];
/** A trial's child rows in list order; reminders in insertion order, and a trial has at most one report. */
const TRIAL_CHILD_ORDER = (t: string) => (t === 'trial_reminders' || t === 'trial_reports' ? 'rowid' : 'position');
/** Reads a record's child rows: a prepared statement, or the same rows for many records at once (`childRowsOf`). */
type ChildReader = { all(parentId: string, ...subKey: (string | number)[]): Row[] };
/** What `decodeRequest` and `decodeTrial` read children through. */
type Readers = {
  slotsOf: ChildReader;
  of: Record<TrialChildTable, ChildReader>;
  evidenceOf: ChildReader;
  revisionSessionsOf: ChildReader;
  keysOf: ChildReader;
};
type Inserter = { run(row: object): void };
type Statements = Readers & {
  ins: Record<RecruitmentTable, Inserter>;
  requestById: StatementSync;
  requestAll: StatementSync;
  trialById: StatementSync;
  trialAll: StatementSync;
  reportsForPlayers: StatementSync;
  guardian: StatementSync;
  caseExists: StatementSync;
  preparedBy: DatabaseSync['prepare'];
};
const stmtCache = new WeakMap<DatabaseSync, Statements>();
function statements(sqlite: DatabaseSync): Statements {
  let s = stmtCache.get(sqlite);
  if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table: RecruitmentTable): Inserter => {
    const cols = COLS[table];
    const stmt = sqlite.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
    );
    return { run: (row) => stmt.run(nulls(row)) };
  };
  const childOf = (t: string) =>
    sqlite.prepare(`SELECT * FROM ${t} WHERE trial_id = ? ORDER BY ${TRIAL_CHILD_ORDER(t)}`);
  s = {
    ins: Object.fromEntries(RECRUITMENT_TABLES.map((t) => [t, insert(t)])) as Record<RecruitmentTable, Inserter>,
    requestById: sqlite.prepare('SELECT * FROM recruitment_requests WHERE id = ?'),
    requestAll: sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY rowid'),
    trialById: sqlite.prepare('SELECT * FROM trials WHERE id = ?'),
    trialAll: sqlite.prepare('SELECT * FROM trials ORDER BY rowid'),
    // Ties in filing time keep the trials' order.
    reportsForPlayers: sqlite.prepare(
      'SELECT r.* FROM trial_reports r JOIN trials t ON t.id = r.trial_id WHERE r.player_id IN (SELECT value FROM json_each(?)) ORDER BY r.player_id, r.filed_at, t.rowid',
    ),
    slotsOf: sqlite.prepare('SELECT * FROM request_trial_slots WHERE request_id = ? ORDER BY position'),
    of: Object.fromEntries(TRIAL_CHILD_TABLES.map((t) => [t, childOf(t)])) as Record<TrialChildTable, StatementSync>,
    evidenceOf: sqlite.prepare(
      'SELECT * FROM trial_session_evidence WHERE trial_id = ? AND session_id = ? ORDER BY position',
    ),
    revisionSessionsOf: sqlite.prepare(
      'SELECT * FROM trial_revision_sessions WHERE trial_id = ? AND revision = ? ORDER BY position',
    ),
    keysOf: sqlite.prepare('SELECT * FROM trial_keys WHERE trial_id = ? ORDER BY act, position'),
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'),
    caseExists: sqlite.prepare('SELECT 1 FROM recruitment_cases WHERE id = ?'),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s);
  return s;
}

/**
 * The statements `decodeTrial` reads children through, answered for many trials at once: each child
 * table read once for the whole list instead of about fourteen queries a trial. Same rows, same order.
 */
function batchTrialStatements(sqlite: DatabaseSync, st: Statements, trialIds: string[]): Readers {
  const rows = (t: string, order: string, subKey: string[] = []) =>
    childRowsOf(sqlite, t, 'trial_id', trialIds, { order, subKey });
  return {
    ...st,
    of: Object.fromEntries(TRIAL_CHILD_TABLES.map((t) => [t, rows(t, TRIAL_CHILD_ORDER(t))])) as Record<
      TrialChildTable,
      ChildReader
    >,
    evidenceOf: rows('trial_session_evidence', 'position', ['session_id']),
    revisionSessionsOf: rows('trial_revision_sessions', 'position', ['revision']),
    keysOf: rows('trial_keys', 'act, position'),
  };
}

type Step = (part: string, fn: () => unknown) => unknown;
/** A record's child list: absent is empty, anything but a list is refused; with `objects`, so is an item that is not an object. */
type ListOf = <T>(field: string, v: readonly T[] | null | undefined, opts?: { objects?: boolean }) => T[];
/** Insert a whole request: its row and its slots. `step(part, fn)` names a refused row; `listOf` refuses a list that is not one. */
function insertRequest(st: Statements, q: RecruitmentRequestInput, step: Step, listOf: ListOf) {
  step('request', () => st.ins.recruitment_requests.run(requestRow(q)));
  listOf('trialDetails.slots', q.trialDetails?.slots, { objects: true }).forEach((s, i) =>
    step(`slot ${s.id}`, () => st.ins.request_trial_slots.run(slotRow(q.id, s, i))),
  );
}
/** Insert a whole trial: its row and every child row, in list order. */
function insertTrial(st: Statements, t: TrialInput, step: Step, listOf: ListOf) {
  const I = st.ins;
  const each = <T>(field: string, list: readonly T[] | null | undefined, fn: (x: T, i: number) => void) =>
    listOf(field, list, { objects: true }).forEach((x, i) => step(`${field}[${i}]`, () => fn(x, i)));
  step('trial', () => I.trials.run(trialRow(t)));
  each('schedule.sessions', t.schedule?.sessions, (s, i) => {
    I.trial_schedule_sessions.run(scheduleSessionRow(t.id, s, i));
    each(`schedule.sessions[${i}].evidence`, s.evidence, (e, j) =>
      I.trial_session_evidence.run(evidenceRow(t.id, s.id, e, j)),
    );
  });
  each('schedule.revisions', t.schedule?.revisions, (r, i) => {
    I.trial_schedule_revisions.run(revisionRow(t.id, r, i));
    each(`schedule.revisions[${i}].sessions`, r.sessions, (s, j) =>
      I.trial_revision_sessions.run(revisionSessionRow(t.id, r.revision, s, j)),
    );
  });
  each('attendance', t.attendance, (a, i) => I.trial_attendance.run(attendanceRow(t.id, a, i)));
  each('history', t.history, (h, i) => I.trial_history.run(historyRow(t.id, h, i)));
  for (const act of TRIAL_KEY_ACTS)
    each(`keys.${act}`, t.keys?.[act], (k, i) => I.trial_keys.run(keyRow(t.id, act, k, i)));
  for (const [marker, at] of Object.entries(t.reminders ?? {}))
    step(`reminders.${marker}`, () => I.trial_reminders.run({ trial_id: t.id, marker, sent_at: at }));
  if (t.report) {
    const report = t.report;
    step('report', () => I.trial_reports.run(reportRow(t.id, report)));
  }
  each('day.staff', t.day?.staff, (s, i) => I.trial_day_staff.run(staffRow(t.id, s, i)));
  each('day.consents', t.day?.consents, (c, i) => I.trial_day_consents.run(consentRow(t.id, c, i)));
  each('day.checkins', t.day?.checkins, (c, i) => I.trial_day_checkins.run(checkinRow(t.id, c, i)));
  each('day.statusEvents', t.day?.statusEvents, (e, i) => I.trial_day_status_events.run(statusEventRow(t.id, e, i)));
}

function decodeRequest(st: Readers, row: RequestRow): RequestFields {
  const trialDetails: TrialDetailsFields | null =
    row.type !== 'trial'
      ? null
      : {
          proposedDate: row.trial_proposed_date,
          // A trial invitation always has its days (a CHECK).
          altSlots: JSON.parse(row.trial_alt_days_json as string),
          venue: row.trial_venue,
          notes: row.trial_notes,
          slots: (st.slotsOf.all(row.id) as SlotRow[]).map((s) => ({
            id: s.id,
            day: s.day,
            kind: s.kind,
            startsAt: s.starts_at,
            endsAt: s.ends_at,
            timezone: s.timezone,
            venue: venueOut(s, 'venue'),
          })),
          private:
            row.trial_private_venue_address === null && row.trial_private_instructions === null
              ? null
              : { venueAddress: row.trial_private_venue_address, instructions: row.trial_private_instructions },
        };
  return {
    id: row.id,
    playerId: row.player_id,
    playerName: row.player_name,
    orgId: row.org_id,
    orgName: row.org_name,
    orgType: row.org_type,
    orgVerified: row.org_verified === 1,
    orgSafeguardingCertified: row.org_safeguarding_certified === 1,
    trustedPartner: flagOut(row.org_trusted_partner),
    userId: row.user_id,
    scoutName: row.scout_name,
    scoutRole: row.scout_role,
    type: row.type,
    message: row.message,
    subject: row.subject,
    contactId: row.contact_id,
    trialDetails,
    status: row.status,
    createdAt: row.created_at,
    respondedAt: row.responded_at,
    respondedBy: row.responded_by,
    routedTo: row.routed_to,
    guardianId: row.guardian_id,
    contactChannel: row.contact_channel_id,
    caseId: row.case_id,
    trialId: row.trial_id,
    recipient:
      row.recipient_type === null
        ? null
        : {
            type: row.recipient_type,
            playerId: row.recipient_player_id,
            guardianId: row.recipient_guardian_id,
            minor: row.recipient_minor === 1,
          },
    // The key and its fingerprint are set together (a CHECK).
    keys: { invite: row.invite_fp === null ? null : { key: row.invite_key as string, fp: row.invite_fp } },
    subjectRemovedAt: row.subject_removed_at,
  };
}
const reportOut = (rep: ReportRow): TrialReportFields => ({
  id: rep.id,
  trialId: rep.trial_id,
  playerId: rep.player_id,
  orgId: rep.org_id,
  orgName: rep.org_name,
  userId: rep.user_id,
  scoutName: rep.scout_name,
  filedAt: rep.filed_at,
  ...(Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, rep[snake(f)]])) as Record<TrialReportMetric, number>),
  notes: rep.notes,
  strengthNote: rep.strength_note,
  focusNote: rep.focus_note,
});
function decodeTrial(st: Readers, row: TrialRow): TrialFields {
  const O = st.of;
  const schedule: ScheduleFields | null =
    row.schedule_revision === null
      ? null
      : {
          // The timezone and the revision are set together (a CHECK).
          timezone: row.schedule_timezone as string,
          revision: row.schedule_revision,
          proposedAt: row.schedule_proposed_at,
          proposedBy: actorOut(row, 'schedule_proposed_by'),
          confirmedAt: row.schedule_confirmed_at,
          confirmedBy: actorOut(row, 'schedule_confirmed_by'),
          declinedAt: row.schedule_declined_at,
          declinedBy: actorOut(row, 'schedule_declined_by'),
          sessions: (O.trial_schedule_sessions.all(row.id) as SessionRow[]).map((s) => ({
            ...sessionOut(s),
            evidence: (st.evidenceOf.all(row.id, s.id) as EvidenceRow[]).map((e) => ({
              id: e.id,
              kind: e.kind,
              sessionId: e.box_session_id,
              linkedAt: e.linked_at,
              linkedBy: actorOut(e, 'linked_by'),
              removedAt: e.removed_at,
              removedBy: actorOut(e, 'removed_by'),
            })),
          })),
          revisions: (O.trial_schedule_revisions.all(row.id) as RevisionRow[]).map((r) => ({
            revision: r.revision,
            timezone: r.timezone,
            sessions: (st.revisionSessionsOf.all(row.id, r.revision) as SessionRow[]).map(sessionOut),
            proposedAt: r.proposed_at,
            proposedBy: actorOut(r, 'proposed_by'),
            confirmedAt: r.confirmed_at,
            confirmedBy: actorOut(r, 'confirmed_by'),
            supersededAt: r.superseded_at,
            reason: r.reason,
            material: flagOut(r.material),
          })),
        };
  const keyRows = st.keysOf.all(row.id) as KeyRow[];
  const rep = (O.trial_reports.all(row.id)[0] as ReportRow | undefined) ?? null;
  const reminders: Record<string, number> = {};
  // Defined rather than assigned, so a marker named like an Object.prototype key is a plain entry.
  for (const r of O.trial_reminders.all(row.id) as ReminderRow[])
    Object.defineProperty(reminders, r.marker, {
      value: r.sent_at,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return {
    id: row.id,
    requestId: row.request_id,
    caseId: row.case_id,
    playerId: row.player_id,
    playerName: row.player_name,
    orgId: row.org_id,
    orgName: row.org_name,
    scoutName: row.scout_name,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    guardianApproved: flagOut(row.guardian_approved),
    proposedDate: row.proposed_date,
    venue: row.venue,
    notes: row.notes,
    reportDueAt: row.report_due_at,
    status: row.status,
    reminderSent: row.reminder_sent === 1,
    feedbackEscalatedAt: row.feedback_escalated_at,
    report: rep ? reportOut(rep) : null,
    day: {
      staff: (O.trial_day_staff.all(row.id) as StaffRow[]).map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        check:
          s.check_status === null
            ? null
            : {
                kind: s.check_kind,
                ref: s.check_ref,
                status: s.check_status,
                expiresAt: s.check_expires_at,
                reviewedBy: s.check_reviewed_by,
                reviewedAt: s.check_reviewed_at,
              },
        addedBy: s.added_by_name,
        addedAt: s.added_at,
      })),
      consents: (O.trial_day_consents.all(row.id) as ConsentRow[]).map((c) => ({
        id: c.id,
        by: actorOut(c, 'by'),
        scope: c.scope,
        at: c.at,
      })),
      arrival:
        row.day_arrival_time === null && row.day_arrival_address === null && row.day_arrival_notes === null
          ? null
          : { time: row.day_arrival_time, address: row.day_arrival_address, notes: row.day_arrival_notes },
      emergency:
        row.day_emergency_at === null
          ? null
          : {
              name: row.day_emergency_name,
              phone: row.day_emergency_phone,
              setBy: row.day_emergency_set_by,
              at: row.day_emergency_at,
            },
      checkins: (O.trial_day_checkins.all(row.id) as CheckinRow[]).map((c) => ({
        playerId: c.player_id,
        at: c.at,
        byUserId: c.by_user_id,
        byName: c.by_name,
      })),
      collection: row.day_collection_policy === null ? null : { policy: row.day_collection_policy },
      statusEvents: (O.trial_day_status_events.all(row.id) as StatusEventRow[]).map((e) => ({
        kind: e.kind,
        at: e.at,
        by: e.by_name,
        reason: e.reason,
        newDate: e.new_date,
      })),
    },
    workflowState: row.workflow_state,
    schedule,
    attendance: (O.trial_attendance.all(row.id) as AttendanceRow[]).map((a) => ({
      sessionId: a.session_id,
      state: a.state,
      source: a.source,
      recordedBy: actorOut(a, 'recorded_by'),
      recordedAt: a.recorded_at,
      note: a.note,
    })),
    completion:
      row.completion_state === null
        ? null
        : {
            state: row.completion_state,
            // Set with the state (a CHECK).
            at: row.completion_at as number,
            by: actorOut(row, 'completion_by'),
            reason: row.completion_reason,
            phase: row.completion_phase,
            cancelledBy: row.completion_cancelled_by,
          },
    recipient:
      row.recipient_type === null
        ? null
        : {
            type: row.recipient_type,
            playerId: row.recipient_player_id,
            guardianId: row.recipient_guardian_id,
            minor: row.recipient_minor === 1,
            at: row.recipient_at,
          },
    keys: Object.fromEntries(
      TRIAL_KEY_ACTS.map((act) => [
        act,
        keyRows.filter((k) => k.act === act).map((k) => ({ key: k.key, fp: k.fp, at: k.at })),
      ]),
    ) as Record<TrialKeyAct, ClientKey[]>,
    history: (O.trial_history.all(row.id) as HistoryRow[]).map(trialHistoryOut),
    reminders,
    lifecycle:
      row.lifecycle_applied === null
        ? null
        : row.lifecycle_applied === 1
          ? { applied: true, from: row.lifecycle_from, to: row.lifecycle_to, at: row.lifecycle_at }
          : { applied: false, reason: row.lifecycle_reason, at: row.lifecycle_at },
    rev: row.rev,
    revAt: row.rev_at,
    revBy:
      row.rev_by_user_id === null && row.rev_by_name === null
        ? null
        : { userId: row.rev_by_user_id, name: row.rev_by_name },
    subjectRemovedAt: row.subject_removed_at,
  };
}
export const readRequests = (sqlite: DatabaseSync): RecruitmentRequest[] => {
  const st = statements(sqlite);
  return (st.requestAll.all() as RequestRow[]).map((r) => decodeRequest(st, r));
};
export const readTrials = (sqlite: DatabaseSync): Trial[] => {
  const st = statements(sqlite);
  const rows = st.trialAll.all() as TrialRow[];
  const via =
    rows.length > 1
      ? batchTrialStatements(
          sqlite,
          st,
          rows.map((r) => r.id),
        )
      : st;
  return rows.map((r) => decodeTrial(via, r));
};

// ------------------------------------------------------------------ references (Q7a counted, Q7c strict)
const PLAYER_REFS_SQL: Record<RecruitmentCollection, string> = {
  requests:
    'SELECT player_id AS pid FROM recruitment_requests UNION ALL SELECT recipient_player_id FROM recruitment_requests WHERE recipient_player_id IS NOT NULL',
  trials:
    'SELECT player_id AS pid FROM trials UNION ALL SELECT recipient_player_id FROM trials WHERE recipient_player_id IS NOT NULL UNION ALL SELECT player_id FROM trial_reports UNION ALL SELECT player_id FROM trial_day_checkins',
};
type PerCollection = Record<RecruitmentCollection, number>;
const countRefs = (sqlite: DatabaseSync, test: string): PerCollection =>
  Object.fromEntries(
    RECRUITMENT_COLLECTIONS.map((c) => [
      c,
      (sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE ${test}`).get() as { n: number }).n,
    ]),
  ) as PerCollection;
export function unresolvedPlayerReferences(sqlite: DatabaseSync): PerCollection | null {
  if (!recruitmentLive(sqlite)) return null;
  return countRefs(sqlite, 'NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)');
}
export function retainedPlayerReferences(sqlite: DatabaseSync): PerCollection | null {
  if (!recruitmentLive(sqlite)) return null;
  return countRefs(sqlite, 'EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)');
}
// ------------------------------------------------------------------ the whole-domain read
const TABLE_OF = { requests: 'recruitment_requests', trials: 'trials' } as const;
export type RecruitmentRecords = { requests: RecruitmentRequest[]; trials: Trial[] };
export const RECRUITMENT_RECORDS = {
  names: RECRUITMENT_COLLECTIONS,
  read(sqlite: DatabaseSync): RecruitmentRecords | null {
    if (!recruitmentLive(sqlite)) return null;
    return { requests: readRequests(sqlite), trials: readTrials(sqlite) };
  },
};

// ------------------------------------------------------------------ act inputs
export type RecordResponseInput = { status: 'accepted' | 'declined'; respondedAt: number; respondedBy: Party };
export type ProposeScheduleInput = {
  /** One past the current revision. */
  revision: number;
  timezone: string;
  sessions: TrialSessionInput[];
  proposedAt: number;
  proposedBy: ActorInput | null;
  /** Keep the recipient's confirmation: the change is not material. */
  keepsConfirmation?: boolean;
  reason?: string | null;
  material?: boolean | null;
  workflowState: TrialWorkflowState;
};
export type ScheduleAnswerInput = { at: number; by: ActorInput | null };
export type ConfirmScheduleInput = ScheduleAnswerInput & {
  /** Who answered. */
  recipient: TrialRecipientInput | null;
  workflowState: TrialWorkflowState;
};
export type CancelTrialInput = ScheduleAnswerInput & {
  reason?: string | null;
  phase: TrialWorkflowState;
  cancelledBy: TrialCancelActor;
};
export type ReviewStaffCheckInput = {
  staffId: string;
  status: TrialStaffCheckState;
  reviewedBy: string | null;
  reviewedAt: number;
  /** Kept as it was when left out or null. */
  expiresAt?: string | null;
};
/**
 * The bookkeeping an act leaves on its trial: the rev bump (`bump`, by `revBy` at `at`), its history entries (only
 * ever appended) and the client key it was sent with (the newest are kept; one without a `key` is not kept).
 */
export type TrialBookkeeping = {
  at?: number | null;
  revBy?: { id?: string | null; name?: string | null } | null;
  bump?: boolean;
  history?: TrialHistoryInput[];
  key?: { act: TrialKeyAct; key: string | null; fp: string } | null;
};

// ------------------------------------------------------------------ the repository
/** A history entry's detail on an erased trial: free text longer than a code is the person's, and goes. */
const redactedDetail = (json: string) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(JSON.parse(json) as Record<string, unknown>).filter(
        ([, v]) => typeof v !== 'string' || v.length <= 40,
      ),
    ),
  );
type Page = { limit: number; after?: readonly [number] | null };
type PageOf<T> = { items: T[]; nextCursor: string | null };
/** One entry of the admin staff-check queue. */
export type StaffCheckItem = {
  trialId: string;
  orgId: string;
  orgName: string;
  staffId: string;
  name: string;
  role: string;
  check: StaffCheckFields;
};
type RequestActDef = ((id: string) => void) | ((id: string, input: never) => void);
type RequestAct<F> = F extends (id: string) => void
  ? (id: string) => RecruitmentRequest
  : F extends (id: string, input: infer I) => void
    ? (id: string, input: I) => RecruitmentRequest
    : never;
/** An act's own check of what it wrote, run on the stored trial. */
type StoredCheck = (stored: Trial) => void;
type TrialActDef = ((id: string) => StoredCheck | void) | ((id: string, input: never) => StoredCheck | void);
type TrialAct<F> = F extends (id: string) => unknown
  ? (id: string, input?: Record<string, never>, bookkeeping?: TrialBookkeeping) => Trial
  : F extends (id: string, input: infer I) => unknown
    ? (id: string, input: I, bookkeeping?: TrialBookkeeping) => Trial
    : never;

/**
 * `createRecruitmentRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work (a failure
 * poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and returns the
 * record read back from the tables. A case a request or a trial names must already be written (its key is immediate).
 * Every query decodes fresh, deep-frozen records in insertion (rowid) order and runs on the one connection, so a read
 * inside a unit of work sees the unit's own writes.
 */
export function createRecruitmentRepository(
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
  if (!sqlite) throw new TypeError('the recruitment repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = operationOn(sqlite, unit);
  const decodeRequestRow = (row: RequestRow): RecruitmentRequest => deepFreeze(decodeRequest(st, row));
  const decodeTrialRow = (row: TrialRow): Trial => deepFreeze(decodeTrial(st, row));
  const decodeRequests = (rows: Row[]): RecruitmentRequest[] => (rows as RequestRow[]).map(decodeRequestRow);
  /** Decode many trial rows; a list reads its children in one batch (batchTrialStatements). */
  const decodeTrials = (rows: Row[]): Trial[] => {
    const trialRows = rows as TrialRow[];
    if (trialRows.length < 2) return trialRows.map(decodeTrialRow);
    const bst = batchTrialStatements(
      sqlite,
      st,
      trialRows.map((r) => r.id),
    );
    return trialRows.map((r) => deepFreeze(decodeTrial(bst, r)));
  };
  const decodeAll = { requests: decodeRequests, trials: decodeTrials };
  const reportsOf = (playerIds: readonly unknown[] | null | undefined): Map<string, TrialReport[]> => {
    const out = new Map<string, TrialReport[]>();
    const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))];
    if (!want.length) return out;
    for (const rep of st.reportsForPlayers.all(JSON.stringify(want)) as ReportRow[]) {
      let list = out.get(rep.player_id);
      if (!list) out.set(rep.player_id, (list = []));
      list.push(reportOut(rep));
    }
    return out;
  };
  const requestById = (id: unknown): RecruitmentRequest | null => {
    if (typeof id !== 'string') return null;
    const row = st.requestById.get(id) as RequestRow | undefined;
    return row ? decodeRequestRow(row) : null;
  };
  const trialById = (id: unknown): Trial | null => {
    if (typeof id !== 'string') return null;
    const row = st.trialById.get(id) as TrialRow | undefined;
    return row ? decodeTrialRow(row) : null;
  };
  const listOfRequests = <A extends SQLInputValue[]>(sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A) => decodeRequests(stmt.all(...args));
  };
  const listOfTrials = <A extends SQLInputValue[]>(sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A) => decodeTrials(stmt.all(...args));
  };
  const inList =
    <N extends RecruitmentCollection>(name: N, table: string, col: string) =>
    (values: readonly unknown[] | null | undefined): ReturnType<(typeof decodeAll)[N]> => {
      const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))];
      if (!want.length) return [] as ReturnType<(typeof decodeAll)[N]>;
      return decodeAll[name](
        sqlite
          .prepare(`SELECT * FROM ${table} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`)
          .all(...want),
      ) as ReturnType<(typeof decodeAll)[N]>;
    };
  const count = <A extends SQLInputValue[]>(sql: string) => {
    const stmt = sqlite.prepare(sql);
    return (...args: A) => (stmt.get(...args) as { n: number }).n;
  };
  /**
   * Newest first by cursor (domains/platform/paging.mjs): `where` takes `args`, the key is the rowid (insertion order;
   * an act never moves a row). `after` comes from readPage(query, ['number']).
   */
  const pageStmts = new Map<string, StatementSync>();
  const newestFirst =
    <N extends RecruitmentCollection>(name: N, table: string, where: (args: SQLInputValue[]) => string) =>
    (args: SQLInputValue[], { limit, after = null }: Page): PageOf<ReturnType<(typeof decodeAll)[N]>[number]> => {
      const sql = `SELECT rowid AS page_key, * FROM ${table} WHERE ${where(args)}${after ? ' AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`;
      let stmt = pageStmts.get(sql);
      if (!stmt) pageStmts.set(sql, (stmt = sqlite.prepare(sql)));
      const rows = stmt.all(...args, ...(after ? [after[0]] : []), limit + 1);
      const page = pageOf(rows, limit, (r) => [r.page_key]);
      return {
        items: decodeAll[name](page.items) as ReturnType<(typeof decodeAll)[N]>[number][],
        nextCursor: page.nextCursor,
      };
    };
  const placeholders = (args: readonly unknown[]) => args.map(() => '?').join(',');

  // ---- writes: a record is created whole, then changes only through named acts on its own rows.
  const kit = writeKit(sqlite, 'RECRUITMENT');
  const { invalid, rowStep, listOf, readsBackAsWritten, q, guarded, nextPosition } = kit;
  // An assertion function is only callable through a name declared with its type.
  const newRecord: typeof kit.newRecord = kit.newRecord;
  // Besides the write kit's three refusals, the record and the references it names may be missing.
  const refusal = (what: string, message: string) => {
    const code = `RECRUITMENT_${what}`;
    return Object.assign(new Error(`${code}: ${message}`), { code });
  };
  const mustRequest = (id: string): RecruitmentRequest => {
    const r = requestById(id);
    if (!r) throw refusal('NOT_FOUND', `requests ${id} is not a record of the repository`);
    return r;
  };
  const mustTrial = (id: string): Trial => {
    const r = trialById(id);
    if (!r) throw refusal('NOT_FOUND', `trials ${id} is not a record of the repository`);
    return r;
  };
  /** Guardian ids have no key (Q7c): every one a write names is checked here. */
  const guardiansExist = (table: string, id: string, gids: readonly (string | null | undefined)[]) => {
    const missing = gids.filter((g): g is string => g !== null && g !== undefined && !st.guardian.get(g));
    if (missing.length)
      throw refusal('GUARDIAN_MISSING', `${table} ${id} names a guardian that does not exist (${ids(missing)})`);
  };
  /** The case a request or a trial names is written first (an immediate key): a miss is named with the ids. */
  const caseMustExist = (table: string, r: { id: string; caseId?: string | null }) => {
    if (r.caseId !== null && r.caseId !== undefined && !st.caseExists.get(r.caseId))
      throw refusal(
        'CASE_MISSING',
        `${table} holds 1 row naming a recruitment_cases row that is not there (${r.id} → recruitment_cases ${r.caseId}); the write was rolled back`,
      );
  };

  /** A new record, whole: an existing id is refused, and the stored record must read back as written. */
  const create = <I extends { id: string; caseId?: string | null }, R>(
    name: RecruitmentCollection,
    r: I,
    guardians: (r: I) => (string | null | undefined)[],
    insert: (step: Step, lists: ListOf) => void,
    reread: (id: string) => R,
  ): R =>
    operation(() => {
      const table = TABLE_OF[name];
      newRecord(table, (id) => !!(name === 'requests' ? st.requestById : st.trialById).get(id), r);
      caseMustExist(table, r);
      guardiansExist(table, r.id, guardians(r));
      const step: Step = (part, fn) => rowStep(table, r.id, part, fn);
      const lists: ListOf = (field, v, opts) => listOf(table, r.id, field, v, opts) as never;
      insert(step, lists);
      const stored = reread(r.id);
      readsBackAsWritten(table, r.id, r, stored);
      return stored;
    });

  // ---- request acts, each `act(id, input)`; it returns the stored request.
  const REQ = 'recruitment_requests';
  const requestActs = <D extends Record<string, RequestActDef>>(defs: D) =>
    Object.fromEntries(
      Object.entries(defs).map(([act, fn]) => [
        act,
        (id: string, input: unknown = {}) =>
          operation(() => {
            if (!st.requestById.get(id)) throw refusal('NOT_FOUND', `requests ${id} is not a record of the repository`);
            rowStep(REQ, id, act, () => (fn as (id: string, input: unknown) => void)(id, input));
            return mustRequest(id);
          }),
      ]),
    ) as { [K in keyof D]: RequestAct<D[K]> };
  const requestWrites = {
    create: (r: RecruitmentRequestInput): RecruitmentRequest =>
      create(
        'requests',
        r,
        (q) => [q.guardianId, q.recipient?.guardianId],
        (step, lists) => insertRequest(st, r, step, lists),
        mustRequest,
      ),
    ...requestActs({
      /** The recipient's answer to a pending request. */
      recordResponse: (id: string, { status, respondedAt, respondedBy }: RecordResponseInput) =>
        guarded(
          REQ,
          { id },
          "status = 'pending'",
          { status, responded_at: respondedAt, responded_by: respondedBy },
          `${REQ} ${id} is not pending`,
        ),
      /** The conversation an accepted request opened. */
      attachChannel: (id: string, { channelId }: { channelId: string }) =>
        guarded(
          REQ,
          { id },
          "status = 'accepted' AND contact_channel_id IS NULL",
          { contact_channel_id: channelId },
          `${REQ} ${id} is not an accepted request without a channel`,
        ),
      /** An urgent safety report froze the pending request. */
      suspend: (id: string) =>
        guarded(REQ, { id }, "status = 'pending'", { status: 'suspended' }, `${REQ} ${id} is not pending`),
      /** The trial an accepted invitation became. */
      linkTrial: (id: string, { trialId }: { trialId: string }) =>
        guarded(
          REQ,
          { id },
          "type = 'trial' AND trial_id IS NULL",
          { trial_id: trialId },
          `${REQ} ${id} is not a trial invitation without a trial`,
        ),
    }),
  };

  // ---- trial acts, each `act(id, input, bookkeeping)`; it returns the stored trial.
  const TRIAL = 'trials';
  const OPEN = 'completion_state IS NULL';
  const ended = (id: string) => `trials ${id} has ended`;
  /** Append one ordered child row: `encode(position)` at the owner's next position (within `scope`). */
  const appendTo = (
    table: RecruitmentTable,
    id: string,
    encode: (position: number) => object,
    scope: Record<string, SQLInputValue> = {},
  ) => st.ins[table].run(encode(nextPosition(table, 'trial_id', id, scope)));
  /** An act that inserts a sub-record checks it reads back as written, as a create does. */
  const storedAs =
    (id: string, written: unknown, path: string, pick: (t: Trial) => unknown): StoredCheck =>
    (stored) =>
      readsBackAsWritten(TRIAL, id, written, pick(stored), path);
  const setCols = (id: string, cols: Record<string, unknown>) =>
    q(
      `UPDATE trials SET ${Object.keys(cols)
        .map((c) => `${c} = @${c}`)
        .join(', ')} WHERE id = @id`,
    ).run(nulls({ ...cols, id }));
  /** The bookkeeping an act leaves on its trial (TrialBookkeeping). */
  const applyAct = (
    id: string,
    { at = null, revBy = null, bump = false, history = [], key = null }: TrialBookkeeping = {},
  ) => {
    if (bump)
      q('UPDATE trials SET rev = rev + 1, rev_at = @at, rev_by_user_id = @uid, rev_by_name = @name WHERE id = @id').run(
        { id, at, uid: revBy?.id ?? null, name: revBy?.name ?? null },
      );
    for (const h of listOf(TRIAL, id, 'history', history, { objects: true }) as TrialHistoryInput[])
      rowStep(TRIAL, id, `history ${h.id}`, () => appendTo('trial_history', id, (p) => historyRow(id, h, p)));
    if (key?.key) {
      const k = { key: key.key, fp: key.fp, at: at as number };
      rowStep(TRIAL, id, `key ${key.act}`, () =>
        appendTo('trial_keys', id, (p) => keyRow(id, key.act, k, p), { act: key.act }),
      );
      q(
        'DELETE FROM trial_keys WHERE trial_id = @id AND act = @act AND position <= (SELECT MAX(position) FROM trial_keys WHERE trial_id = @id AND act = @act) - @kept',
      ).run({ id, act: key.act, kept: KEYS_KEPT });
    }
  };
  const runTrialAct = (name: string, id: string, fn: () => StoredCheck | void, bookkeeping?: TrialBookkeeping) =>
    operation(() => {
      if (!st.trialById.get(id)) throw refusal('NOT_FOUND', `trials ${id} is not a record of the repository`);
      const check = rowStep(TRIAL, id, name, fn);
      applyAct(id, bookkeeping);
      const stored = mustTrial(id);
      if (typeof check === 'function') check(stored);
      return stored;
    });
  const trialActs = <D extends Record<string, TrialActDef>>(defs: D) =>
    Object.fromEntries(
      Object.entries(defs).map(([name, fn]) => [
        name,
        (id: string, input: unknown = {}, bookkeeping: TrialBookkeeping = {}) =>
          runTrialAct(
            name,
            id,
            () => (fn as (id: string, input: unknown) => StoredCheck | void)(id, input),
            bookkeeping,
          ),
      ]),
    ) as { [K in keyof D]: TrialAct<D[K]> };
  /** Replace the current sessions with `sessions`: a kept session (same id) keeps its evidence links, a dropped one loses them. */
  const replaceSessions = (id: string, sessions: TrialSessionInput[]) => {
    const keep = new Set(sessions.map((s) => s.id));
    const had = new Set(
      (q('SELECT id FROM trial_schedule_sessions WHERE trial_id = ?').all(id) as { id: string }[]).map((r) => r.id),
    );
    for (const sid of had)
      if (!keep.has(sid)) q('DELETE FROM trial_schedule_sessions WHERE trial_id = ? AND id = ?').run(id, sid);
    q('UPDATE trial_schedule_sessions SET position = -1 - position WHERE trial_id = ?').run(id); // free the positions
    const cols = COLS.trial_schedule_sessions.filter((c) => c !== 'trial_id' && c !== 'id');
    sessions.forEach((s, i) =>
      had.has(s.id)
        ? q(
            `UPDATE trial_schedule_sessions SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE trial_id = @trial_id AND id = @id`,
          ).run(nulls(scheduleSessionRow(id, s, i)))
        : st.ins.trial_schedule_sessions.run(scheduleSessionRow(id, s, i)),
    );
  };

  const trialWrites = {
    create: (t: TrialInput): Trial =>
      create(
        'trials',
        t,
        (r) => [r.recipient?.guardianId],
        (step, lists) => {
          insertTrial(st, t, step, lists);
          refreshProfileSignals(sqlite, [t.playerId]);
        },
        mustTrial,
      ),
    /** Only the bookkeeping: history, a rev bump, a client key. */
    recordAct: (id: string, bookkeeping: TrialBookkeeping = {}): Trial =>
      runTrialAct('recordAct', id, () => {}, bookkeeping),
    ...trialActs({
      /**
       * A schedule proposal, revision `revision` (one past the current): the open revisions are superseded, the new one
       * recorded with its sessions, and the current sessions replaced. `keepsConfirmation` keeps the recipient's
       * confirmation (a change that is not material); otherwise it is cleared and asked for again.
       */
      proposeSchedule: (
        id: string,
        {
          revision,
          timezone,
          sessions,
          proposedAt,
          proposedBy,
          keepsConfirmation = false,
          reason = null,
          material = null,
          workflowState,
        }: ProposeScheduleInput,
      ): StoredCheck => {
        if (!Number.isSafeInteger(revision) || revision < 1)
          throw invalid(`trials ${id} schedule revision: must be a positive integer`);
        const list = listOf(TRIAL, id, 'schedule.sessions', sessions, { objects: true }) as TrialSessionInput[];
        const confirmed = (
          q('SELECT schedule_confirmed_at AS at FROM trials WHERE id = ?').get(id) as { at: number | null }
        ).at;
        guarded(
          TRIAL,
          { id },
          `${OPEN} AND COALESCE(schedule_revision, 0) = ${revision - 1}`,
          {
            schedule_timezone: timezone,
            schedule_revision: revision,
            schedule_proposed_at: proposedAt,
            ...actorRow('schedule_proposed_by', proposedBy),
            ...(keepsConfirmation ? {} : { schedule_confirmed_at: null, ...actorRow('schedule_confirmed_by', null) }),
            schedule_declined_at: null,
            ...actorRow('schedule_declined_by', null),
            workflow_state: workflowState,
          },
          `trials ${id} is not open at schedule revision ${revision - 1}`,
        );
        q('UPDATE trial_schedule_revisions SET superseded_at = ? WHERE trial_id = ? AND superseded_at IS NULL').run(
          proposedAt,
          id,
        );
        const rev = {
          revision,
          timezone,
          sessions: list,
          proposedAt,
          proposedBy,
          confirmedAt: keepsConfirmation ? confirmed : null,
          confirmedBy: null,
          supersededAt: null,
          reason,
          material,
        };
        appendTo('trial_schedule_revisions', id, (p) => revisionRow(id, rev, p));
        list.forEach((s, i) => st.ins.trial_revision_sessions.run(revisionSessionRow(id, revision, s, i)));
        replaceSessions(id, list);
        return (stored) => {
          // The proposal just wrote the schedule.
          storedAs(id, rev, `schedule.revisions ${revision}`, (t) =>
            t.schedule!.revisions.find((r) => r.revision === revision),
          )(stored);
          storedAs(id, list, 'schedule.sessions', (t) => t.schedule!.sessions)(stored);
        };
      },
      /** The recipient confirmed the proposed schedule; `recipient` is who answered. */
      confirmSchedule: (id: string, { at, by, recipient, workflowState }: ConfirmScheduleInput) => {
        guardiansExist(TRIAL, id, [recipient?.guardianId]);
        guarded(
          TRIAL,
          { id },
          `${OPEN} AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL`,
          {
            schedule_confirmed_at: at,
            ...actorRow('schedule_confirmed_by', by),
            schedule_declined_at: null,
            ...recipientCols(recipient),
            workflow_state: workflowState,
          },
          `trials ${id} has no proposed schedule awaiting confirmation`,
        );
        q(
          `UPDATE trial_schedule_revisions SET confirmed_at = @at, ${Object.keys(actorRow('confirmed_by', null))
            .map((c) => `${c} = @${c}`)
            .join(', ')} WHERE trial_id = @id AND revision = (SELECT schedule_revision FROM trials WHERE id = @id)`,
        ).run(nulls({ id, at, ...actorRow('confirmed_by', by) }));
      },
      /** The recipient declined the proposed schedule. */
      declineSchedule: (id: string, { at, by }: ScheduleAnswerInput) =>
        guarded(
          TRIAL,
          { id },
          `${OPEN} AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL AND schedule_declined_at IS NULL`,
          { schedule_declined_at: at, ...actorRow('schedule_declined_by', by) },
          `trials ${id} has no proposed schedule awaiting an answer`,
        ),
      /** The trial is cancelled, by the club or the recipient (`cancelledBy`), from `phase`. */
      cancel: (id: string, { at, by, reason = null, phase, cancelledBy }: CancelTrialInput) =>
        guarded(
          TRIAL,
          { id },
          OPEN,
          {
            ...completionCols({ state: 'cancelled', at, by, reason, phase, cancelledBy }),
            workflow_state: 'cancelled',
          },
          ended(id),
        ),
      /** The club recorded the scheduled trial as completed. */
      complete: (id: string, { at, by }: ScheduleAnswerInput) =>
        guarded(
          TRIAL,
          { id },
          `${OPEN} AND workflow_state = 'scheduled'`,
          { ...completionCols({ state: 'completed', at, by, phase: 'scheduled' }), workflow_state: 'completed' },
          `trials ${id} is not scheduled`,
        ),
      /** What happened at a session; appended, never corrected. */
      recordAttendance: (id: string, { attendance: a }: { attendance: TrialAttendanceInput }) => {
        appendTo('trial_attendance', id, (p) => attendanceRow(id, a, p));
        return storedAs(id, a, 'attendance', (t) => t.attendance.at(-1));
      },
      /** A Box Cam session cited on a trial session (a reference, nothing copied). */
      linkEvidence: (id: string, { sessionId, evidence: e }: { sessionId: string; evidence: TrialEvidenceInput }) => {
        appendTo('trial_session_evidence', id, (p) => evidenceRow(id, sessionId, e, p), { session_id: sessionId });
        return storedAs(id, e, `evidence ${e.id}`, (t) =>
          t.schedule?.sessions.find((s) => s.id === sessionId)?.evidence.find((x) => x.id === e.id),
        );
      },
      /** An evidence link withdrawn: tombstoned with its removal, never erased. */
      unlinkEvidence: (id: string, { evidenceId, at, by }: ScheduleAnswerInput & { evidenceId: string }) =>
        guarded(
          'trial_session_evidence',
          { trial_id: id, id: evidenceId },
          'removed_at IS NULL',
          { removed_at: at, ...actorRow('removed_by', by) },
          `trials ${id} evidence ${evidenceId} is not an active link`,
        ),
      /** What the case's lifecycle did with the trial's last step (`{ applied, from, to, at }` or `{ applied: false, reason, at }`). */
      recordLifecycle: (id: string, { lifecycle }: { lifecycle: TrialLifecycleInput }) => {
        setCols(id, lifecycleCols(lifecycle));
        return storedAs(id, lifecycle, 'lifecycle', (t) => t.lifecycle);
      },
      /** The mandatory report, filed once; it counts in the player's profile figure. */
      fileReport: (id: string, { report }: { report: TrialReportInput }) => {
        guarded(
          TRIAL,
          { id },
          "status = 'awaiting_report'",
          { status: 'reported' },
          `trials ${id} already has its report`,
        );
        st.ins.trial_reports.run(reportRow(id, report));
        refreshProfileSignals(sqlite, [(st.trialById.get(id) as TrialRow).player_id]);
        return storedAs(id, report, 'report', (t) => t.report);
      },
      /** The overdue-report escalation, once. */
      escalateFeedback: (id: string, { at }: { at: number }) =>
        guarded(
          TRIAL,
          { id },
          'feedback_escalated_at IS NULL',
          { feedback_escalated_at: at },
          `trials ${id} was already escalated`,
        ),
      /** The one-shot report-due reminder. */
      markReportReminderSent: (id: string) =>
        guarded(
          TRIAL,
          { id },
          'reminder_sent = 0',
          { reminder_sent: 1 },
          `trials ${id} was already reminded of its report`,
        ),
      /** Reminder markers `{ marker: sentAt }`, each set once. */
      markReminders: (id: string, { markers }: { markers: Record<string, number> }) => {
        for (const [marker, at] of Object.entries(markers))
          st.ins.trial_reminders.run({ trial_id: id, marker, sent_at: at });
      },
      // The trial day.
      addStaff: (id: string, { staff: s }: { staff: TrialStaffInput }) => {
        appendTo('trial_day_staff', id, (p) => staffRow(id, s, p));
        return storedAs(id, s, `day.staff ${s.id}`, (t) => t.day.staff.find((x) => x.id === s.id));
      },
      /** Arrival details replace the last; a collection policy only when one is given. */
      setArrival: (
        id: string,
        { arrival, collection }: { arrival: TrialArrivalInput | null; collection?: { policy: string } | null },
      ) => {
        setCols(id, { ...arrivalCols(arrival), ...(collection ? { day_collection_policy: collection.policy } : {}) });
      },
      /** A cancellation or postponement of the day; a postponement moves the date and the report deadline. */
      recordDayStatus: (
        id: string,
        {
          event,
          proposedDate,
          reportDueAt,
        }: { event: TrialStatusEventInput; proposedDate?: string | null; reportDueAt?: number | null },
      ) => {
        appendTo('trial_day_status_events', id, (p) => statusEventRow(id, event, p));
        if (proposedDate !== undefined) setCols(id, { proposed_date: proposedDate, report_due_at: reportDueAt });
        return storedAs(id, event, 'day.statusEvents', (t) => t.day.statusEvents.at(-1));
      },
      /** The player checked in; `attendance` is the session the check-in attends, when there is one. */
      checkIn: (
        id: string,
        { checkin, attendance = null }: { checkin: TrialCheckinInput; attendance?: TrialAttendanceInput | null },
      ): StoredCheck => {
        appendTo('trial_day_checkins', id, (p) => checkinRow(id, checkin, p));
        if (attendance) appendTo('trial_attendance', id, (p) => attendanceRow(id, attendance, p));
        return (stored) => {
          storedAs(id, checkin, 'day.checkins', (t) => t.day.checkins.at(-1))(stored);
          if (attendance) storedAs(id, attendance, 'attendance', (t) => t.attendance.at(-1))(stored);
        };
      },
      /** Event consent, once per person and scope. */
      giveConsent: (id: string, { consent: c }: { consent: TrialConsentInput }) => {
        appendTo('trial_day_consents', id, (p) => consentRow(id, c, p));
        return storedAs(id, c, `day.consents ${c.id}`, (t) => t.day.consents.find((x) => x.id === c.id));
      },
      /** The family's emergency contact for the day, replacing the last. */
      setEmergencyContact: (id: string, { emergency }: { emergency: TrialEmergencyInput | null }) => {
        setCols(id, emergencyCols(emergency));
      },
      /** Trust & Safety's review of a staff member's filed check; `expiresAt` only when given. */
      reviewStaffCheck: (id: string, { staffId, status, reviewedBy, reviewedAt, expiresAt }: ReviewStaffCheckInput) =>
        guarded(
          'trial_day_staff',
          { trial_id: id, id: staffId },
          'check_status IS NOT NULL',
          {
            check_status: status,
            check_reviewed_by: reviewedBy,
            check_reviewed_at: reviewedAt,
            ...(expiresAt !== undefined && expiresAt !== null ? { check_expires_at: expiresAt } : {}),
          },
          `trials ${id} staff ${staffId} has no check`,
        ),
    }),
  };

  const pageOfRequestsBy = new Map<string, ReturnType<typeof newestFirst<'requests'>>>();
  const pageOfRequests = (args: SQLInputValue[], where: string, page: Page): PageOf<RecruitmentRequest> => {
    let pager = pageOfRequestsBy.get(where);
    if (!pager) pageOfRequestsBy.set(where, (pager = newestFirst('requests', 'recruitment_requests', () => where)));
    return pager(args, page);
  };
  const pageOfTrials = newestFirst('trials', 'trials', () => 'org_id = ?');
  const trialHistoryFrom = (orgId: string, actions: readonly string[]) => ({
    from: 'trial_history h JOIN trials t ON t.id = h.trial_id',
    where: `t.org_id = ? AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`,
    params: [orgId, ...actions],
  });
  const requests = {
    ...requestWrites,
    byId: requestById,
    forOrg: listOfRequests<[orgId: string]>('SELECT * FROM recruitment_requests WHERE org_id = ? ORDER BY rowid'),
    forPlayer: listOfRequests<[playerId: string]>(
      'SELECT * FROM recruitment_requests WHERE player_id = ? ORDER BY rowid',
    ),
    forPlayers: inList('requests', 'recruitment_requests', 'player_id'),
    forOrgPlayer: listOfRequests<[orgId: string, playerId: string]>(
      'SELECT * FROM recruitment_requests WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    forCase: listOfRequests<[caseId: string]>('SELECT * FROM recruitment_requests WHERE case_id = ? ORDER BY rowid'),
    /** The requests of several cases (a player's journeys), in insertion order. */
    forCases: inList('requests', 'recruitment_requests', 'case_id'),
    countForOrg: count<[orgId: string]>('SELECT COUNT(*) AS n FROM recruitment_requests WHERE org_id = ?'),
    countForOrgStatus: count<[orgId: string, status: RequestStatus]>(
      'SELECT COUNT(*) AS n FROM recruitment_requests WHERE org_id = ? AND status = ?',
    ),
    /** The club's Requests list, newest first, by cursor: `{ items, nextCursor }`. */
    pageForOrg: (orgId: string, page: Page) => pageOfRequests([orgId], 'org_id = ?', page),
    /** A player's Inbox, newest first, by cursor. */
    pageForPlayer: (playerId: string, page: Page) => pageOfRequests([playerId], 'player_id = ?', page),
    /** A guardian's Inbox: the requests routed to the guardian about any of `playerIds`, newest first, by cursor. */
    pageForGuardianOf(playerIds: readonly unknown[] | null | undefined, page: Page): PageOf<RecruitmentRequest> {
      const want = [...new Set((playerIds ?? []).filter((v) => typeof v === 'string'))];
      if (!want.length) return { items: [], nextCursor: null };
      return pageOfRequests(want, `player_id IN (${placeholders(want)}) AND routed_to = 'guardian'`, page);
    },
  };
  const staffPage = {
    first: (pendingOnly: boolean) =>
      sqlite.prepare(
        `SELECT t.rowid AS page_trial, s.position AS page_position, s.*, t.org_id, t.org_name FROM trial_day_staff s JOIN trials t ON t.id = s.trial_id WHERE s.check_status IS NOT NULL ${pendingOnly ? "AND s.check_status = 'pending'" : ''} ORDER BY t.rowid, s.position LIMIT ?`,
      ),
    after: (pendingOnly: boolean) =>
      sqlite.prepare(
        `SELECT t.rowid AS page_trial, s.position AS page_position, s.*, t.org_id, t.org_name FROM trial_day_staff s JOIN trials t ON t.id = s.trial_id WHERE s.check_status IS NOT NULL ${pendingOnly ? "AND s.check_status = 'pending'" : ''} AND (t.rowid > ? OR (t.rowid = ? AND s.position > ?)) ORDER BY t.rowid, s.position LIMIT ?`,
      ),
  };
  const staffStmts = {
    true: { first: staffPage.first(true), after: staffPage.after(true) },
    false: { first: staffPage.first(false), after: staffPage.after(false) },
  };
  type StaffCheckRow = StaffRow & { page_trial: number; page_position: number; org_id: string; org_name: string };
  const trials = {
    ...trialWrites,
    byId: trialById,
    forOrg: listOfTrials<[orgId: string]>('SELECT * FROM trials WHERE org_id = ? ORDER BY rowid'),
    forOrgStatus: listOfTrials<[orgId: string, status: TrialStatus]>(
      'SELECT * FROM trials WHERE org_id = ? AND status = ? ORDER BY rowid',
    ),
    forPlayer: listOfTrials<[playerId: string]>('SELECT * FROM trials WHERE player_id = ? ORDER BY rowid'),
    forPlayers: inList('trials', 'trials', 'player_id'),
    forOrgPlayer: listOfTrials<[orgId: string, playerId: string]>(
      'SELECT * FROM trials WHERE org_id = ? AND player_id = ? ORDER BY rowid',
    ),
    forCase: listOfTrials<[caseId: string]>('SELECT * FROM trials WHERE case_id = ? ORDER BY rowid'),
    /** The trials of several cases (a player's journeys), in insertion order. */
    forCases: inList('trials', 'trials', 'case_id'),
    countForOrg: count<[orgId: string]>('SELECT COUNT(*) AS n FROM trials WHERE org_id = ?'),
    countForOrgStatus: count<[orgId: string, status: TrialStatus]>(
      'SELECT COUNT(*) AS n FROM trials WHERE org_id = ? AND status = ?',
    ),
    /**
     * The history of the organisation's trials with one of `actions`, newest first, for a merged feed (the audit feed):
     * `{ trialId, caseId, playerId, entry }`. See `newestHistory` (database.ts) for `atMost` and `n`.
     */
    historyFeed(
      orgId: string,
      actions: readonly string[],
      atMost: number | null,
      n: number,
    ): { trialId: string; caseId: string | null; playerId: string; entry: TrialHistoryEntry }[] {
      return newestHistory(
        sqlite,
        {
          select: 'h.*, t.case_id AS owner_case_id, t.player_id AS owner_player_id',
          ...trialHistoryFrom(orgId, actions),
        },
        atMost,
        n,
      ).map((row) => {
        const h = row as HistoryRow & { owner_case_id: string | null; owner_player_id: string };
        return {
          trialId: h.trial_id,
          caseId: h.owner_case_id,
          playerId: h.owner_player_id,
          entry: trialHistoryOut(h),
        };
      });
    },
    historyCount(orgId: string, actions: readonly string[]): number {
      const f = trialHistoryFrom(orgId, actions);
      return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params) as { n: number })
        .n;
    },
    /** The players of the organisation's trials at `status` (a Set; nothing decoded). */
    playerIdsForOrgStatus: (orgId: string, status: TrialStatus): Set<string> =>
      new Set(
        (
          sqlite
            .prepare('SELECT DISTINCT player_id FROM trials WHERE org_id = ? AND status = ?')
            .all(orgId, status) as { player_id: string }[]
        ).map((r) => r.player_id),
      ),
    /** The club's Trials list, newest first, by cursor: `{ items, nextCursor }`. */
    pageForOrg: (orgId: string, page: Page) => pageOfTrials([orgId], page),
    /** The report sweep: a deadline passed, no report, never escalated, the subject not removed. */
    reportOverdue: listOfTrials<[now: number]>(
      'SELECT * FROM trials t WHERE t.report_due_at < ? AND t.feedback_escalated_at IS NULL AND t.subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reports r WHERE r.trial_id = t.id) ORDER BY t.rowid',
    ),
    /**
     * The reminder sweep: the confirmed, open trials with a reminder due at `now`, and no others. Either a
     * session starts within 48 hours and its `t48:<session>:<revision>` marker is unset (found through the sessions'
     * start index: the CROSS JOIN keeps SQLite from starting at the trials instead), or the last session ended over a
     * day ago and `completionPending` is unset (a pass over the open trials' index with a marker probe each, in SQL;
     * nothing is decoded until it is due). The sweep re-checks each trial before writing.
     */
    remindersDue: (() => {
      const stmt = sqlite.prepare(`SELECT * FROM trials WHERE rowid IN (
          SELECT t.rowid FROM trial_schedule_sessions s CROSS JOIN trials t ON t.id = s.trial_id
           WHERE s.starts_at > :now AND s.starts_at <= :now + 172800000
             AND t.schedule_confirmed_at IS NOT NULL AND t.completion_state IS NULL AND t.subject_removed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM trial_reminders m WHERE m.trial_id = t.id AND m.marker = 't48:' || s.id || ':' || t.schedule_revision)
          UNION
          SELECT t.rowid FROM trials t
           WHERE t.schedule_confirmed_at IS NOT NULL AND t.completion_state IS NULL AND t.subject_removed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM trial_reminders m WHERE m.trial_id = t.id AND m.marker = 'completionPending')
             AND EXISTS (SELECT 1 FROM trial_schedule_sessions s WHERE s.trial_id = t.id AND s.ends_at > 0)
             AND NOT EXISTS (SELECT 1 FROM trial_schedule_sessions s WHERE s.trial_id = t.id AND s.ends_at >= :now - 86400000)
        ) ORDER BY rowid`);
      return (now: number): Trial[] => decodeTrials(stmt.all({ now }));
    })(),
    /** The assessment reminder: completed at or before `before`, the subject not removed, not yet reminded. */
    completedUnreminded: listOfTrials<[before: number]>(
      "SELECT * FROM trials t WHERE t.completion_state = 'completed' AND t.completion_at <= ? AND t.subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reminders m WHERE m.trial_id = t.id AND m.marker = 'assessmentPending') ORDER BY t.rowid",
    ),
    /** The admin staff-check queue by cursor (trial, then staff position): `{ items, nextCursor }` rows, not trials. */
    staffChecksPage({
      pendingOnly,
      limit,
      after = null,
    }: {
      pendingOnly: boolean;
      limit: number;
      after?: readonly [number, number] | null;
    }): PageOf<StaffCheckItem> {
      const s = staffStmts[pendingOnly ? 'true' : 'false'];
      const rows = (
        after ? s.after.all(after[0], after[0], after[1], limit + 1) : s.first.all(limit + 1)
      ) as StaffCheckRow[];
      const page = pageOf(rows, limit, (r) => [r.page_trial, r.page_position]);
      return {
        items: page.items.map((r) => ({
          trialId: r.trial_id,
          orgId: r.org_id,
          orgName: r.org_name,
          staffId: r.id,
          name: r.name,
          role: r.role,
          check: {
            kind: r.check_kind,
            ref: r.check_ref,
            // The queue holds only staff with a check.
            status: r.check_status as TrialStaffCheckState,
            expiresAt: r.check_expires_at,
            reviewedBy: r.check_reviewed_by,
            reviewedAt: r.check_reviewed_at,
          },
        })),
        nextCursor: page.nextCursor,
      };
    },
  };
  const counters = {
    requests: sqlite.prepare('SELECT COUNT(*) AS n FROM recruitment_requests'),
    trials: sqlite.prepare('SELECT COUNT(*) AS n FROM trials'),
    trialReports: sqlite.prepare('SELECT COUNT(*) AS n FROM trial_reports'),
  };
  const n = (stmt: StatementSync) => (stmt.get() as { n: number }).n;
  const counts = () => ({
    requests: n(counters.requests),
    trials: n(counters.trials),
    trialReports: n(counters.trialReports),
  });
  const OF_PLAYER = 'SELECT id FROM trials WHERE player_id = @p';
  const nullActor = (p: string, keepKind = true) =>
    [...(keepKind ? [] : [`${p}_kind`]), `${p}_user_id`, `${p}_actor_id`, `${p}_name`]
      .map((c) => `${c} = NULL`)
      .join(', ');
  const changes = (r: { changes: number | bigint }) => r.changes as number;

  return {
    requests,
    trials,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({
      requests: readsOf(requests, Object.keys(requestWrites) as (keyof typeof requestWrites)[]),
      trials: readsOf(trials, Object.keys(trialWrites) as (keyof typeof trialWrites)[]),
    }),
    /**
     * The deletion unit: what the player's requests and trials keep when the player removes their account. The rule
     * is the ledger's: ids, states, times and the club's own filed numbers stay, so a case that cites a trial still
     * resolves; what describes the person goes: their name, the club's notes about them, the message and subject sent
     * to them, the family's emergency contact and the arrival details written for them, session instructions and
     * address lines, attendance notes, the feedback in a report, the Box Cam evidence links (the player's sessions are
     * no longer the club's to cite), the recipient and guardian ids, actors' names (their kind stays) and history
     * detail text. `subjectRemovedAt` tells every reader why.
     */
    redactPlayer(playerId: string, at: number): { requests: number; trials: number } {
      return operation(() => {
        const p = { p: playerId };
        const pa = { p: playerId, at };
        const requestsDone = changes(
          q(`UPDATE recruitment_requests SET player_name = NULL, message = NULL, subject = NULL, trial_notes = CASE WHEN type = 'trial' THEN '' END,
          trial_private_venue_address = NULL, trial_private_instructions = NULL, guardian_id = NULL, contact_channel_id = NULL,
          recipient_type = NULL, recipient_player_id = NULL, recipient_guardian_id = NULL, recipient_minor = NULL, invite_key = NULL, invite_fp = NULL,
          subject_removed_at = @at WHERE player_id = @p`).run(pa),
        );
        q(
          'UPDATE request_trial_slots SET venue_address = NULL WHERE request_id IN (SELECT id FROM recruitment_requests WHERE player_id = @p)',
        ).run(p);
        const inTrials = `trial_id IN (${OF_PLAYER})`;
        q(`DELETE FROM trial_session_evidence WHERE ${inTrials}`).run(p);
        for (const t of ['trial_schedule_sessions', 'trial_revision_sessions'])
          q(`UPDATE ${t} SET venue_address = NULL, instructions = NULL WHERE ${inTrials}`).run(p);
        q(
          `UPDATE trial_schedule_revisions SET ${nullActor('proposed_by')}, ${nullActor('confirmed_by', false)}, reason = NULL WHERE ${inTrials}`,
        ).run(p);
        q(`UPDATE trial_attendance SET note = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_reports SET notes = NULL, strength_note = NULL, focus_note = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_day_consents SET ${nullActor('by')} WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_history SET ${nullActor('by')} WHERE ${inTrials}`).run(p);
        for (const h of q(
          `SELECT trial_id, position, detail_json FROM trial_history WHERE detail_json IS NOT NULL AND ${inTrials}`,
        ).all(p) as { trial_id: string; position: number; detail_json: string }[])
          q('UPDATE trial_history SET detail_json = ? WHERE trial_id = ? AND position = ?').run(
            redactedDetail(h.detail_json),
            h.trial_id,
            h.position,
          );
        const trialsDone = changes(
          q(`UPDATE trials SET player_name = NULL, notes = '', ${nullActor('schedule_proposed_by')}, ${nullActor('schedule_confirmed_by')},
          schedule_declined_at = NULL, ${nullActor('schedule_declined_by', false)}, ${nullActor('completion_by')}, completion_reason = NULL, completion_cancelled_by = NULL,
          recipient_player_id = NULL, recipient_guardian_id = NULL, ${Object.keys(lifecycleCols(null))
            .map((c) => `${c} = NULL`)
            .join(', ')},
          ${Object.keys({ ...arrivalCols(null), ...emergencyCols(null) })
            .map((c) => `${c} = NULL`)
            .join(', ')}, day_collection_policy = NULL,
          rev_by_user_id = NULL, rev_by_name = NULL, subject_removed_at = @at WHERE player_id = @p`).run(pa),
        );
        if (trialsDone) refreshProfileSignals(sqlite, [playerId]);
        return { requests: requestsDone, trials: trialsDone };
      });
    },
    /** The derived `players[].trialReports`: the reports filed on the player's trials, in filing order. */
    trialReportsFor(playerId: string): TrialReport[] {
      return reportsOf([playerId]).get(playerId) ?? [];
    },
    /**
     * The trial reports of many players at once (one query): Map player id → reports in filing order. Read from the
     * report rows alone, never by decoding the trials: every player read pays this. The composite key to trials
     * makes a report's player its trial's player.
     */
    trialReportsForPlayers: (playerIds: readonly unknown[] | null | undefined) => reportsOf(playerIds),
    /** Check migration 0015 is recorded; there is nothing to load. */
    attach() {
      if (!recruitmentLive(sqlite))
        throw new Error(
          `the recruitment repository needs ${RECRUITMENT_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll(): RecruitmentRecords | null {
      return RECRUITMENT_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
export type RecruitmentRepository = ReturnType<typeof createRecruitmentRepository>;
export type RecruitmentReads = RecruitmentRepository['reads'];
