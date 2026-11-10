/**
 * Recruitment requests (with their trial slots) and accepted trials (with their schedule, attendance, history, keys,
 * reminders, reports and trial-day rows).
 *
 * Writes (docs/architecture.md, Writes). A request or a trial is created whole and must read back as written: a field
 * the tables have no column for, at any depth, or a value a column would coerce, is refused with its id (the unit rolls
 * back). Then each changes only through named acts: a request is answered, given its channel, suspended or linked to
 * its trial; a trial's schedule is proposed, confirmed or declined, it is cancelled or completed, attendance and
 * evidence are recorded, its report filed, its reminders marked and its trial day kept. A trial act takes
 * `act(id, input, bookkeeping)`, the bookkeeping being its history entries, rev bump and client key. Each state change
 * is guarded in SQL (a schedule proposal is one past the current revision, nothing changes on an ended trial, a report
 * is filed once). The columns carry the vocabulary CHECKs of the domain rules (domains/recruitment/lifecycle/trial.mjs);
 * there is no JavaScript copy of them. An absent field reads back as null, an absent list as empty, and a trial always
 * reads back with its trial-day container, its five client-key lists and its reminder map.
 *
 * References. `org_id` → orgs, `user_id` → org_users and `case_id` (both tables) → recruitment_cases (RESTRICT).
 * `recruitment_requests.trial_id` → trials is DEFERRABLE INITIALLY DEFERRED (checked at COMMIT): a request and the
 * trial it names are written in one unit. `trials.request_id` → recruitment_requests is immediate, and a report names its
 * trial's player (`(trial_id, player_id)` → trials). Player ids: no key,
 * tolerant and counted (Q7a in docs/decisions.md). Guardian ids: no key, checked in code at every write (Q7c).
 *
 * Refusals name tables, fields and ids, never a name, a message, a note, an address or a phone number.
 */
import { pageOf } from '../domains/platform/paging.mjs';
import { transaction, migrationApplied, newestHistory, childRowsOf } from './database.mjs';
import { ORG_TYPES } from './orgs.mjs';
import { TRIAL_WORKFLOW_STATES, TRIAL_SESSION_KINDS, TRIAL_ATTENDANCE_STATES, TRIAL_ATTENDANCE_SOURCES, TRIAL_COMPLETION_STATES, TRIAL_CANCEL_ACTORS, TRIAL_STATUSES, TRIAL_STAFF_CHECK_STATES, TRIAL_DAY_EVENT_KINDS, TRIAL_CONSENT_SCOPES, TRIAL_KEY_ACTS, TRIAL_LIMITS } from '../domains/recruitment/lifecycle/trial.mjs';
import { TRIAL_REPORT_FIELDS } from '../domain.mjs';
import { refreshProfileSignals } from './identity.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const RECRUITMENT_MIGRATION = '0015_recruitment';
export const RECRUITMENT_COLLECTIONS = Object.freeze(['requests', 'trials']);
export const REQUEST_TABLES = Object.freeze(['recruitment_requests', 'request_trial_slots']);
export const TRIAL_TABLES = Object.freeze(['trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_revision_sessions', 'trial_attendance', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events']);
export const RECRUITMENT_TABLES = Object.freeze([...REQUEST_TABLES, ...TRIAL_TABLES]);
export const recruitmentLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_MIGRATION);

// ------------------------------------------------------------------ small shared helpers (the other recruitment repositories import these)
export const describe = (v) => (v === null ? 'null' : v === undefined ? 'nothing' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
export const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
export const ids = (list) => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');

export const JSON_CHECK = (col) => `CHECK (${col} IS NULL OR json_valid(${col}))`;
/** The shared idempotency_keys table (the signing packages' keys; other domains keep their keys as columns). Its owner CHECK names the owner tables. */
export function idempotencyKeysDdl(owners) {
  return { table: `CREATE TABLE idempotency_keys (\n  owner_table                      TEXT NOT NULL CHECK (owner_table IN (${owners.map((o) => `'${o}'`).join(', ')})),\n  owner_id                         TEXT NOT NULL,\n  position                         INTEGER NOT NULL,\n  act                              TEXT NOT NULL,\n  shape                            TEXT NOT NULL CHECK (shape IN ('list', 'value')),\n  key                              TEXT,\n  fp                               TEXT,\n  at                               INTEGER,\n  entry_json                       TEXT NOT NULL ${JSON_CHECK('entry_json')},\n  PRIMARY KEY (owner_table, owner_id, position)\n) STRICT;`, indexes: ['CREATE INDEX idempotency_keys_owner_act_key ON idempotency_keys (owner_table, owner_id, act, key)'] };
}

// ------------------------------------------------------------------ vocabulary
const REQUEST_TYPES = ['contact', 'trial'];
/** `suspended`: an urgent safety report froze the pending request (server.mjs, the report route). */
const REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'suspended'];
const PARTIES = ['player', 'guardian'];
const ACTOR_KINDS = ['org', 'player', 'guardian', 'system'];
const EVIDENCE_KINDS = ['box_cam_session'];
function snake(s) { return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`); }

// ------------------------------------------------------------------ DDL
const inList = (col, list) => `CHECK (${col} IS NULL OR ${col} IN (${list.map((v) => `'${v}'`).join(',')}))`;
const maxLen = (col, n) => `CHECK (${col} IS NULL OR length(${col}) <= ${n})`;
const bool = (col) => `CHECK (${col} IS NULL OR ${col} IN (0,1))`;
const dayCheck = (col) => `CHECK (${col} IS NULL OR ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`;
/** An actor: an organisation member (`user_id`) or a family member / the system (`actor_id`), with the name shown. */
const actor = (p) => `  ${p}_kind TEXT ${inList(`${p}_kind`, ACTOR_KINDS)},\n  ${p}_user_id TEXT,\n  ${p}_actor_id TEXT,\n  ${p}_name TEXT`;
const venue = (p) => `  ${p}_name TEXT ${maxLen(`${p}_name`, TRIAL_LIMITS.venueName)},\n  ${p}_town TEXT ${maxLen(`${p}_town`, TRIAL_LIMITS.venueTown)},\n  ${p}_address TEXT ${maxLen(`${p}_address`, TRIAL_LIMITS.venueAddress)}`;
const sessionCols = () => `  id TEXT NOT NULL,\n  kind TEXT NOT NULL ${inList('kind', TRIAL_SESSION_KINDS)},\n  starts_at INTEGER NOT NULL,\n  ends_at INTEGER NOT NULL,\n${venue('venue')},\n  instructions TEXT ${maxLen('instructions', TRIAL_LIMITS.instructions)}`;
const ownedBy = (table, col = 'trial_id') => `  ${col} TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE`;

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
const b = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const flagOut = (v) => (v === null ? null : v === 1);
/** Bind an absent field as NULL. */
const nulls = (row) => { for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null; return row; };
const actorRow = (p, a) => ({ [`${p}_kind`]: a?.kind ?? null, [`${p}_user_id`]: a?.kind === 'org' ? a.userId ?? null : null, [`${p}_actor_id`]: a && a.kind !== 'org' ? a.id ?? null : null, [`${p}_name`]: a?.name ?? null });
const actorOut = (row, p) => (row[`${p}_kind`] === null ? null : row[`${p}_user_id`] === null && row[`${p}_actor_id`] === null && row[`${p}_name`] === null ? { kind: row[`${p}_kind`] } : row[`${p}_kind`] === 'org' ? { kind: 'org', userId: row[`${p}_user_id`], name: row[`${p}_name`] } : { kind: row[`${p}_kind`], id: row[`${p}_actor_id`], name: row[`${p}_name`] });
const trialHistoryOut = (h) => ({ id: h.id, at: h.at, action: h.action, by: actorOut(h, 'by'), detail: h.detail_json === null ? null : JSON.parse(h.detail_json) });
const venueRow = (p, v) => ({ [`${p}_name`]: v?.name ?? null, [`${p}_town`]: v?.town ?? null, [`${p}_address`]: v?.address ?? null });
const venueOut = (row, p) => (row[`${p}_name`] === null ? null : { name: row[`${p}_name`], town: row[`${p}_town`], address: row[`${p}_address`] });
const sessionRow = (s) => ({ id: s.id, kind: s.kind, starts_at: s.startsAt, ends_at: s.endsAt, ...venueRow('venue', s.venue), instructions: s.instructions });
const sessionOut = (r) => ({ id: r.id, kind: r.kind, startsAt: r.starts_at, endsAt: r.ends_at, venue: venueOut(r, 'venue'), instructions: r.instructions });

const requestRow = (q) => {
  const td = q.trialDetails ?? null;
  return {
    id: q.id, player_id: q.playerId, player_name: q.playerName, org_id: q.orgId, org_name: q.orgName, org_type: q.orgType, org_verified: b(q.orgVerified), org_safeguarding_certified: b(q.orgSafeguardingCertified), org_trusted_partner: b(q.trustedPartner),
    user_id: q.userId, scout_name: q.scoutName, scout_role: q.scoutRole, type: q.type, message: q.message, subject: q.subject, contact_id: q.contactId,
    trial_proposed_date: td?.proposedDate, trial_alt_days_json: td ? JSON.stringify(td.altSlots ?? []) : null, trial_venue: td?.venue, trial_notes: td?.notes,
    trial_private_venue_address: td?.private?.venueAddress, trial_private_instructions: td?.private?.instructions,
    status: q.status, created_at: q.createdAt, responded_at: q.respondedAt, responded_by: q.respondedBy, routed_to: q.routedTo, guardian_id: q.guardianId, contact_channel_id: q.contactChannel,
    case_id: q.caseId, trial_id: q.trialId, recipient_type: q.recipient?.type, recipient_player_id: q.recipient?.playerId, recipient_guardian_id: q.recipient?.guardianId, recipient_minor: b(q.recipient?.minor),
    invite_key: q.keys?.invite?.key, invite_fp: q.keys?.invite?.fp, subject_removed_at: q.subjectRemovedAt,
  };
};
const slotRow = (rid, s, position) => ({ request_id: rid, position, id: s.id, day: s.day, kind: s.kind, starts_at: s.startsAt, ends_at: s.endsAt, timezone: s.timezone, ...venueRow('venue', s.venue) });
const scheduleCols = (sc) => ({
  schedule_timezone: sc?.timezone, schedule_revision: sc?.revision, schedule_proposed_at: sc?.proposedAt, ...actorRow('schedule_proposed_by', sc?.proposedBy),
  schedule_confirmed_at: sc?.confirmedAt, ...actorRow('schedule_confirmed_by', sc?.confirmedBy), schedule_declined_at: sc?.declinedAt, ...actorRow('schedule_declined_by', sc?.declinedBy),
});
const completionCols = (c) => ({ completion_state: c?.state, completion_at: c?.at, ...actorRow('completion_by', c?.by), completion_reason: c?.reason, completion_phase: c?.phase, completion_cancelled_by: c?.cancelledBy });
const recipientCols = (r) => ({ recipient_type: r?.type, recipient_player_id: r?.playerId, recipient_guardian_id: r?.guardianId, recipient_minor: b(r?.minor), recipient_at: r?.at });
const lifecycleCols = (lc) => ({ lifecycle_applied: b(lc?.applied), lifecycle_from: lc?.from, lifecycle_to: lc?.to, lifecycle_reason: lc?.reason, lifecycle_at: lc?.at });
const arrivalCols = (a) => ({ day_arrival_time: a?.time, day_arrival_address: a?.address, day_arrival_notes: a?.notes });
const emergencyCols = (e) => ({ day_emergency_name: e?.name, day_emergency_phone: e?.phone, day_emergency_set_by: e?.setBy, day_emergency_at: e?.at });
const trialRow = (t) => ({
  id: t.id, request_id: t.requestId, case_id: t.caseId, player_id: t.playerId, player_name: t.playerName, org_id: t.orgId, org_name: t.orgName, scout_name: t.scoutName,
  accepted_at: t.acceptedAt, accepted_by: t.acceptedBy, guardian_approved: b(t.guardianApproved), proposed_date: t.proposedDate, venue: t.venue, notes: t.notes,
  report_due_at: t.reportDueAt, status: t.status, reminder_sent: b(t.reminderSent ?? false), feedback_escalated_at: t.feedbackEscalatedAt, workflow_state: t.workflowState,
  ...scheduleCols(t.schedule), ...completionCols(t.completion), ...recipientCols(t.recipient), ...lifecycleCols(t.lifecycle),
  ...arrivalCols(t.day?.arrival), ...emergencyCols(t.day?.emergency), day_collection_policy: t.day?.collection?.policy,
  rev: t.rev, rev_at: t.revAt, rev_by_user_id: t.revBy?.userId, rev_by_name: t.revBy?.name, subject_removed_at: t.subjectRemovedAt,
});
const scheduleSessionRow = (tid, s, position) => ({ trial_id: tid, position, ...sessionRow(s) });
const evidenceRow = (tid, sessionId, e, position) => ({ trial_id: tid, session_id: sessionId, position, id: e.id, kind: e.kind, box_session_id: e.sessionId, linked_at: e.linkedAt, ...actorRow('linked_by', e.linkedBy), removed_at: e.removedAt, ...actorRow('removed_by', e.removedBy) });
const revisionRow = (tid, r, position) => ({ trial_id: tid, position, revision: r.revision, timezone: r.timezone, proposed_at: r.proposedAt, ...actorRow('proposed_by', r.proposedBy), confirmed_at: r.confirmedAt, ...actorRow('confirmed_by', r.confirmedBy), superseded_at: r.supersededAt, reason: r.reason, material: b(r.material) });
const revisionSessionRow = (tid, revision, s, position) => ({ trial_id: tid, revision, position, ...sessionRow(s) });
const attendanceRow = (tid, a, position) => ({ trial_id: tid, position, session_id: a.sessionId, state: a.state, source: a.source, ...actorRow('recorded_by', a.recordedBy), recorded_at: a.recordedAt, note: a.note });
const historyRow = (tid, h, position) => ({ trial_id: tid, position, id: h.id, at: h.at, action: h.action, ...actorRow('by', h.by), detail_json: h.detail === null || h.detail === undefined ? null : JSON.stringify(h.detail) });
const keyRow = (tid, act, k, position) => ({ trial_id: tid, act, position, key: k.key, fp: k.fp, at: k.at });
const reportRow = (tid, r) => ({ trial_id: tid, id: r.id, player_id: r.playerId, org_id: r.orgId, org_name: r.orgName, user_id: r.userId, scout_name: r.scoutName, filed_at: r.filedAt, ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [snake(f), r[f]])), notes: r.notes, strength_note: r.strengthNote, focus_note: r.focusNote });
const staffRow = (tid, s, position) => ({ trial_id: tid, position, id: s.id, name: s.name, role: s.role, check_kind: s.check?.kind, check_ref: s.check?.ref, check_status: s.check?.status, check_expires_at: s.check?.expiresAt, check_reviewed_by: s.check?.reviewedBy, check_reviewed_at: s.check?.reviewedAt, added_by_name: s.addedBy, added_at: s.addedAt });
const consentRow = (tid, c, position) => ({ trial_id: tid, position, id: c.id, ...actorRow('by', c.by), scope: c.scope, at: c.at });
const checkinRow = (tid, c, position) => ({ trial_id: tid, position, player_id: c.playerId, at: c.at, by_user_id: c.byUserId, by_name: c.byName });
const statusEventRow = (tid, e, position) => ({ trial_id: tid, position, kind: e.kind, at: e.at, by_name: e.by, reason: e.reason, new_date: e.newDate });
const COLS = {
  recruitment_requests: Object.keys(requestRow({})),
  request_trial_slots: Object.keys(slotRow('r', {}, 0)),
  trials: Object.keys(trialRow({})),
  trial_schedule_sessions: Object.keys(scheduleSessionRow('t', {}, 0)),
  trial_session_evidence: Object.keys(evidenceRow('t', 's', {}, 0)),
  trial_schedule_revisions: Object.keys(revisionRow('t', {}, 0)),
  trial_revision_sessions: Object.keys(revisionSessionRow('t', 1, {}, 0)),
  trial_attendance: Object.keys(attendanceRow('t', {}, 0)),
  trial_history: Object.keys(historyRow('t', {}, 0)),
  trial_keys: Object.keys(keyRow('t', 'a', {}, 0)),
  trial_reminders: ['trial_id', 'marker', 'sent_at'],
  trial_reports: Object.keys(reportRow('t', {})),
  trial_day_staff: Object.keys(staffRow('t', {}, 0)),
  trial_day_consents: Object.keys(consentRow('t', {}, 0)),
  trial_day_checkins: Object.keys(checkinRow('t', {}, 0)),
  trial_day_status_events: Object.keys(statusEventRow('t', {}, 0)),
};
/** The trial-day container every trial reads back with (domains/scouting/journeys.mjs). */
export const emptyTrialDay = () => ({ staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] });
/** A trial keeps the newest idempotency keys of each act. */
const KEYS_KEPT = 50;

// ------------------------------------------------------------------ statements and the record readers
/** A trial's child rows in list order; reminders in insertion order, and a trial has at most one report. */
const TRIAL_CHILD_ORDER = (t) => (t === 'trial_reminders' || t === 'trial_reports' ? 'rowid' : 'position');
const stmtCache = new WeakMap();
function statements(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table) => { const cols = COLS[table]; const stmt = sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`); return { run: (row) => stmt.run(nulls(row)) }; };
  const childOf = (t) => sqlite.prepare(`SELECT * FROM ${t} WHERE trial_id = ? ORDER BY ${TRIAL_CHILD_ORDER(t)}`);
  s = {
    ins: Object.fromEntries(Object.keys(COLS).map((t) => [t, insert(t)])),
    requestById: sqlite.prepare('SELECT * FROM recruitment_requests WHERE id = ?'), requestAll: sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY rowid'),
    trialById: sqlite.prepare('SELECT * FROM trials WHERE id = ?'), trialAll: sqlite.prepare('SELECT * FROM trials ORDER BY rowid'),
    // Ties in filing time keep the trials' order.
    reportsForPlayers: sqlite.prepare('SELECT r.* FROM trial_reports r JOIN trials t ON t.id = r.trial_id WHERE r.player_id IN (SELECT value FROM json_each(?)) ORDER BY r.player_id, r.filed_at, t.rowid'),
    slotsOf: sqlite.prepare('SELECT * FROM request_trial_slots WHERE request_id = ? ORDER BY position'),
    of: Object.fromEntries(['trial_schedule_sessions', 'trial_schedule_revisions', 'trial_attendance', 'trial_history', 'trial_reminders', 'trial_reports', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events'].map((t) => [t, childOf(t)])),
    evidenceOf: sqlite.prepare('SELECT * FROM trial_session_evidence WHERE trial_id = ? AND session_id = ? ORDER BY position'),
    revisionSessionsOf: sqlite.prepare('SELECT * FROM trial_revision_sessions WHERE trial_id = ? AND revision = ? ORDER BY position'),
    keysOf: sqlite.prepare('SELECT * FROM trial_keys WHERE trial_id = ? ORDER BY act, position'),
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'),
    caseExists: sqlite.prepare('SELECT 1 FROM recruitment_cases WHERE id = ?'),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

/**
 * The statements `decodeTrial` reads children through, answered for many trials at once: each child
 * table read once for the whole list instead of about fourteen queries a trial. Same rows, same order.
 */
function batchTrialStatements(sqlite, st, ids) {
  const rows = (t, order, subKey = []) => childRowsOf(sqlite, t, 'trial_id', ids, { order, subKey });
  return {
    ...st,
    of: Object.fromEntries(Object.keys(st.of).map((t) => [t, rows(t, TRIAL_CHILD_ORDER(t))])),
    evidenceOf: rows('trial_session_evidence', 'position', ['session_id']),
    revisionSessionsOf: rows('trial_revision_sessions', 'position', ['revision']),
    keysOf: rows('trial_keys', 'act, position'),
  };
}

/** Insert a whole request: its row and its slots. `step(part, fn)` names a refused row; `listOf` refuses a list that is not one. */
function insertRequest(st, q, step, listOf) {
  step('request', () => st.ins.recruitment_requests.run(requestRow(q)));
  listOf('trialDetails.slots', q.trialDetails?.slots, { objects: true }).forEach((s, i) => step(`slot ${s.id}`, () => st.ins.request_trial_slots.run(slotRow(q.id, s, i))));
}
/** Insert a whole trial: its row and every child row, in list order. */
function insertTrial(st, t, step, listOf) {
  const I = st.ins;
  const each = (field, list, fn) => listOf(field, list, { objects: true }).forEach((x, i) => step(`${field}[${i}]`, () => fn(x, i)));
  step('trial', () => I.trials.run(trialRow(t)));
  each('schedule.sessions', t.schedule?.sessions, (s, i) => {
    I.trial_schedule_sessions.run(scheduleSessionRow(t.id, s, i));
    each(`schedule.sessions[${i}].evidence`, s.evidence, (e, j) => I.trial_session_evidence.run(evidenceRow(t.id, s.id, e, j)));
  });
  each('schedule.revisions', t.schedule?.revisions, (r, i) => {
    I.trial_schedule_revisions.run(revisionRow(t.id, r, i));
    each(`schedule.revisions[${i}].sessions`, r.sessions, (s, j) => I.trial_revision_sessions.run(revisionSessionRow(t.id, r.revision, s, j)));
  });
  each('attendance', t.attendance, (a, i) => I.trial_attendance.run(attendanceRow(t.id, a, i)));
  each('history', t.history, (h, i) => I.trial_history.run(historyRow(t.id, h, i)));
  for (const act of TRIAL_KEY_ACTS) each(`keys.${act}`, t.keys?.[act], (k, i) => I.trial_keys.run(keyRow(t.id, act, k, i)));
  for (const [marker, at] of Object.entries(t.reminders ?? {})) step(`reminders.${marker}`, () => I.trial_reminders.run({ trial_id: t.id, marker, sent_at: at }));
  if (t.report) step('report', () => I.trial_reports.run(reportRow(t.id, t.report)));
  each('day.staff', t.day?.staff, (s, i) => I.trial_day_staff.run(staffRow(t.id, s, i)));
  each('day.consents', t.day?.consents, (c, i) => I.trial_day_consents.run(consentRow(t.id, c, i)));
  each('day.checkins', t.day?.checkins, (c, i) => I.trial_day_checkins.run(checkinRow(t.id, c, i)));
  each('day.statusEvents', t.day?.statusEvents, (e, i) => I.trial_day_status_events.run(statusEventRow(t.id, e, i)));
}

function decodeRequest(st, row) {
  const trialDetails = row.type !== 'trial' ? null : {
    proposedDate: row.trial_proposed_date, altSlots: JSON.parse(row.trial_alt_days_json), venue: row.trial_venue, notes: row.trial_notes,
    slots: st.slotsOf.all(row.id).map((s) => ({ id: s.id, day: s.day, kind: s.kind, startsAt: s.starts_at, endsAt: s.ends_at, timezone: s.timezone, venue: venueOut(s, 'venue') })),
    private: row.trial_private_venue_address === null && row.trial_private_instructions === null ? null : { venueAddress: row.trial_private_venue_address, instructions: row.trial_private_instructions },
  };
  return {
    id: row.id, playerId: row.player_id, playerName: row.player_name, orgId: row.org_id, orgName: row.org_name, orgType: row.org_type, orgVerified: row.org_verified === 1, orgSafeguardingCertified: row.org_safeguarding_certified === 1, trustedPartner: flagOut(row.org_trusted_partner),
    userId: row.user_id, scoutName: row.scout_name, scoutRole: row.scout_role, type: row.type, message: row.message, subject: row.subject, contactId: row.contact_id,
    trialDetails, status: row.status, createdAt: row.created_at, respondedAt: row.responded_at, respondedBy: row.responded_by, routedTo: row.routed_to, guardianId: row.guardian_id, contactChannel: row.contact_channel_id,
    caseId: row.case_id, trialId: row.trial_id,
    recipient: row.recipient_type === null ? null : { type: row.recipient_type, playerId: row.recipient_player_id, guardianId: row.recipient_guardian_id, minor: row.recipient_minor === 1 },
    keys: { invite: row.invite_fp === null ? null : { key: row.invite_key, fp: row.invite_fp } }, subjectRemovedAt: row.subject_removed_at,
  };
}
const reportOut = (rep) => ({ id: rep.id, trialId: rep.trial_id, playerId: rep.player_id, orgId: rep.org_id, orgName: rep.org_name, userId: rep.user_id, scoutName: rep.scout_name, filedAt: rep.filed_at, ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, rep[snake(f)]])), notes: rep.notes, strengthNote: rep.strength_note, focusNote: rep.focus_note });
function decodeTrial(st, row) {
  const O = st.of;
  const schedule = row.schedule_revision === null ? null : {
    timezone: row.schedule_timezone, revision: row.schedule_revision, proposedAt: row.schedule_proposed_at, proposedBy: actorOut(row, 'schedule_proposed_by'),
    confirmedAt: row.schedule_confirmed_at, confirmedBy: actorOut(row, 'schedule_confirmed_by'), declinedAt: row.schedule_declined_at, declinedBy: actorOut(row, 'schedule_declined_by'),
    sessions: O.trial_schedule_sessions.all(row.id).map((s) => ({ ...sessionOut(s), evidence: st.evidenceOf.all(row.id, s.id).map((e) => ({ id: e.id, kind: e.kind, sessionId: e.box_session_id, linkedAt: e.linked_at, linkedBy: actorOut(e, 'linked_by'), removedAt: e.removed_at, removedBy: actorOut(e, 'removed_by') })) })),
    revisions: O.trial_schedule_revisions.all(row.id).map((r) => ({ revision: r.revision, timezone: r.timezone, sessions: st.revisionSessionsOf.all(row.id, r.revision).map(sessionOut), proposedAt: r.proposed_at, proposedBy: actorOut(r, 'proposed_by'), confirmedAt: r.confirmed_at, confirmedBy: actorOut(r, 'confirmed_by'), supersededAt: r.superseded_at, reason: r.reason, material: flagOut(r.material) })),
  };
  const keyRows = st.keysOf.all(row.id);
  const rep = O.trial_reports.all(row.id)[0] ?? null;
  const reminders = {}; for (const r of O.trial_reminders.all(row.id)) Object.defineProperty(reminders, r.marker, { value: r.sent_at, enumerable: true, writable: true, configurable: true });
  return {
    id: row.id, requestId: row.request_id, caseId: row.case_id, playerId: row.player_id, playerName: row.player_name, orgId: row.org_id, orgName: row.org_name, scoutName: row.scout_name,
    acceptedAt: row.accepted_at, acceptedBy: row.accepted_by, guardianApproved: flagOut(row.guardian_approved), proposedDate: row.proposed_date, venue: row.venue, notes: row.notes,
    reportDueAt: row.report_due_at, status: row.status, reminderSent: row.reminder_sent === 1, feedbackEscalatedAt: row.feedback_escalated_at,
    report: rep ? reportOut(rep) : null,
    day: {
      staff: O.trial_day_staff.all(row.id).map((s) => ({ id: s.id, name: s.name, role: s.role, check: s.check_status === null ? null : { kind: s.check_kind, ref: s.check_ref, status: s.check_status, expiresAt: s.check_expires_at, reviewedBy: s.check_reviewed_by, reviewedAt: s.check_reviewed_at }, addedBy: s.added_by_name, addedAt: s.added_at })),
      consents: O.trial_day_consents.all(row.id).map((c) => ({ id: c.id, by: actorOut(c, 'by'), scope: c.scope, at: c.at })),
      arrival: row.day_arrival_time === null && row.day_arrival_address === null && row.day_arrival_notes === null ? null : { time: row.day_arrival_time, address: row.day_arrival_address, notes: row.day_arrival_notes },
      emergency: row.day_emergency_at === null ? null : { name: row.day_emergency_name, phone: row.day_emergency_phone, setBy: row.day_emergency_set_by, at: row.day_emergency_at },
      checkins: O.trial_day_checkins.all(row.id).map((c) => ({ playerId: c.player_id, at: c.at, byUserId: c.by_user_id, byName: c.by_name })),
      collection: row.day_collection_policy === null ? null : { policy: row.day_collection_policy },
      statusEvents: O.trial_day_status_events.all(row.id).map((e) => ({ kind: e.kind, at: e.at, by: e.by_name, reason: e.reason, newDate: e.new_date })),
    },
    workflowState: row.workflow_state, schedule,
    attendance: O.trial_attendance.all(row.id).map((a) => ({ sessionId: a.session_id, state: a.state, source: a.source, recordedBy: actorOut(a, 'recorded_by'), recordedAt: a.recorded_at, note: a.note })),
    completion: row.completion_state === null ? null : { state: row.completion_state, at: row.completion_at, by: actorOut(row, 'completion_by'), reason: row.completion_reason, phase: row.completion_phase, cancelledBy: row.completion_cancelled_by },
    recipient: row.recipient_type === null ? null : { type: row.recipient_type, playerId: row.recipient_player_id, guardianId: row.recipient_guardian_id, minor: row.recipient_minor === 1, at: row.recipient_at },
    keys: Object.fromEntries(TRIAL_KEY_ACTS.map((act) => [act, keyRows.filter((k) => k.act === act).map((k) => ({ key: k.key, fp: k.fp, at: k.at }))])),
    history: O.trial_history.all(row.id).map(trialHistoryOut),
    reminders,
    lifecycle: row.lifecycle_applied === null ? null : row.lifecycle_applied === 1 ? { applied: true, from: row.lifecycle_from, to: row.lifecycle_to, at: row.lifecycle_at } : { applied: false, reason: row.lifecycle_reason, at: row.lifecycle_at },
    rev: row.rev, revAt: row.rev_at, revBy: row.rev_by_user_id === null && row.rev_by_name === null ? null : { userId: row.rev_by_user_id, name: row.rev_by_name },
    subjectRemovedAt: row.subject_removed_at,
  };
}
export const readRequests = (sqlite) => { const st = statements(sqlite); return st.requestAll.all().map((r) => decodeRequest(st, r)); };
export const readTrials = (sqlite) => { const st = statements(sqlite); const rows = st.trialAll.all(); const via = rows.length > 1 ? batchTrialStatements(sqlite, st, rows.map((r) => r.id)) : st; return rows.map((r) => decodeTrial(via, r)); };

// ------------------------------------------------------------------ references (Q7a counted, Q7c strict)
const PLAYER_REFS_SQL = {
  requests: 'SELECT player_id AS pid FROM recruitment_requests UNION ALL SELECT recipient_player_id FROM recruitment_requests WHERE recipient_player_id IS NOT NULL',
  trials: 'SELECT player_id AS pid FROM trials UNION ALL SELECT recipient_player_id FROM trials WHERE recipient_player_id IS NOT NULL UNION ALL SELECT player_id FROM trial_reports UNION ALL SELECT player_id FROM trial_day_checkins',
};
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentLive(sqlite)) return null;
  return Object.fromEntries(RECRUITMENT_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n]));
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentLive(sqlite)) return null;
  return Object.fromEntries(RECRUITMENT_COLLECTIONS.map((c) => [c, sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL[c]}) x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid AND p.deleted_at IS NOT NULL)`).get().n]));
}
// ------------------------------------------------------------------ the whole-domain read
const TABLE_OF = { requests: 'recruitment_requests', trials: 'trials' };
export const RECRUITMENT_RECORDS = {
  names: RECRUITMENT_COLLECTIONS,
  read(sqlite) { if (!recruitmentLive(sqlite)) return null; return { requests: readRequests(sqlite), trials: readTrials(sqlite) }; },
};

// ------------------------------------------------------------------ the repository
/** A history entry's detail on an erased trial: free text longer than a code is the person's, and goes. */
const redactedDetail = (json) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).filter(([, v]) => typeof v !== 'string' || v.length <= 40)));
/**
 * `createRecruitmentRepository({ sqlite, unit, now, log })`. Every operation joins the open unit of work (a failure
 * poisons it), the caller's open raw transaction, or runs a transaction of its own; it writes its rows and returns the
 * record read back from the tables. A case a request or a trial names must already be written (its key is immediate).
 * Every query decodes fresh, deep-frozen records in insertion (rowid) order and runs on the one connection, so a read
 * inside a unit of work sees the unit's own writes.
 */
export function createRecruitmentRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the recruitment repository needs a SQLite connection (node:sqlite)');
  const st = statements(sqlite);
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const decode = { requests: (row) => deepFreeze(decodeRequest(st, row)), trials: (row) => deepFreeze(decodeTrial(st, row)) };
  /** Decode many rows; a list of trials reads its children in one batch (batchTrialStatements). */
  const decodeAll = (name, rows) => {
    if (name !== 'trials' || rows.length < 2) return rows.map(decode[name]);
    const bst = batchTrialStatements(sqlite, st, rows.map((r) => r.id));
    return rows.map((r) => deepFreeze(decodeTrial(bst, r)));
  };
  const reportsOf = (playerIds) => {
    const out = new Map();
    const want = [...new Set((playerIds ?? []).filter((p) => typeof p === 'string'))];
    if (!want.length) return out;
    for (const rep of st.reportsForPlayers.all(JSON.stringify(want))) { if (!out.has(rep.player_id)) out.set(rep.player_id, []); out.get(rep.player_id).push(reportOut(rep)); }
    return out;
  };
  const rowById = { requests: st.requestById, trials: st.trialById };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = rowById[name].get(id); return row ? decode[name](row) : null; };
  const list = (name, sql) => { const stmt = sqlite.prepare(sql); return (...args) => decodeAll(name, stmt.all(...args)); };
  const inList = (name, table, col) => (values) => { const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))]; if (!want.length) return []; return decodeAll(name, sqlite.prepare(`SELECT * FROM ${table} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`).all(...want)); };
  const count = (sql) => { const stmt = sqlite.prepare(sql); return (...args) => stmt.get(...args).n; };
  /**
   * Newest first by cursor (domains/platform/paging.mjs): `where` takes `args`, the key is the rowid (insertion order;
   * an act never moves a row). `after` comes from readPage(query, ['number']).
   */
  const pageStmts = new Map();
  const newestFirst = (name, table, where) => (args, { limit, after = null }) => {
    const sql = `SELECT rowid AS page_key, * FROM ${table} WHERE ${where(args)}${after ? ' AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`;
    if (!pageStmts.has(sql)) pageStmts.set(sql, sqlite.prepare(sql));
    const rows = pageStmts.get(sql).all(...args, ...(after ? [after[0]] : []), limit + 1);
    const page = pageOf(rows, limit, (r) => [r.page_key]);
    return { items: decodeAll(name, page.items), nextCursor: page.nextCursor };
  };
  const placeholders = (args) => args.map(() => '?').join(',');

  // ---- writes: a record is created whole, then changes only through named acts on its own rows.
  const { refusal, invalid, rowStep, listOf, readsBackAsWritten, newRecord, q, guarded, nextPosition } = writeKit(sqlite, 'RECRUITMENT');
  const WRITES = new Set();
  const writes = (o) => { for (const k of Object.keys(o)) WRITES.add(k); return o; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('NOT_FOUND', `${name} ${id} is not a record of the repository`); return r; };
  /** Guardian ids have no key (Q7c): every one a write names is checked here. */
  const guardiansExist = (table, id, gids) => { const missing = gids.filter((g) => g !== null && g !== undefined && !st.guardian.get(g)); if (missing.length) throw refusal('GUARDIAN_MISSING', `${table} ${id} names a guardian that does not exist (${ids(missing)})`); };
  /** The case a request or a trial names is written first (an immediate key): a miss is named with the ids. */
  const caseMustExist = (table, r) => { if (r.caseId !== null && r.caseId !== undefined && !st.caseExists.get(r.caseId)) throw refusal('CASE_MISSING', `${table} holds 1 row naming a recruitment_cases row that is not there (${r.id} → recruitment_cases ${r.caseId}); the write was rolled back`); };

  /** `create(record)`: a new record, whole. An existing id is refused, and the stored record must read back as written. */
  const create = (name) => (r) => operation(() => {
    const table = TABLE_OF[name];
    newRecord(table, (id) => !!rowById[name].get(id), r);
    caseMustExist(table, r);
    guardiansExist(table, r.id, name === 'requests' ? [r.guardianId, r.recipient?.guardianId] : [r.recipient?.guardianId]);
    const step = (part, fn) => rowStep(table, r.id, part, fn);
    const lists = (field, v, opts) => listOf(table, r.id, field, v, opts);
    if (name === 'requests') insertRequest(st, r, step, lists);
    else { insertTrial(st, r, step, lists); refreshProfileSignals(sqlite, [r.playerId]); }
    const stored = must(name, r.id); readsBackAsWritten(table, r.id, r, stored); return stored;
  });

  // ---- request acts, each `act(id, input)`; it returns the stored request.
  const REQ = 'recruitment_requests';
  const requestActs = (defs) => writes(Object.fromEntries(Object.entries(defs).map(([act, fn]) => [act, (id, input = {}) => operation(() => {
    if (!st.requestById.get(id)) throw refusal('NOT_FOUND', `requests ${id} is not a record of the repository`);
    rowStep(REQ, id, act, () => fn(id, input)); return must('requests', id);
  })])));
  const requestWrites = {
    ...writes({ create: create('requests') }),
    ...requestActs({
      /** The recipient's answer to a pending request. */
      recordResponse: (id, { status, respondedAt, respondedBy }) => guarded(REQ, { id }, "status = 'pending'", { status, responded_at: respondedAt, responded_by: respondedBy }, `${REQ} ${id} is not pending`),
      /** The conversation an accepted request opened. */
      attachChannel: (id, { channelId }) => guarded(REQ, { id }, "status = 'accepted' AND contact_channel_id IS NULL", { contact_channel_id: channelId }, `${REQ} ${id} is not an accepted request without a channel`),
      /** An urgent safety report froze the pending request. */
      suspend: (id) => guarded(REQ, { id }, "status = 'pending'", { status: 'suspended' }, `${REQ} ${id} is not pending`),
      /** The trial an accepted invitation became. */
      linkTrial: (id, { trialId }) => guarded(REQ, { id }, "type = 'trial' AND trial_id IS NULL", { trial_id: trialId }, `${REQ} ${id} is not a trial invitation without a trial`),
    }),
  };

  // ---- trial acts, each `act(id, input, bookkeeping)`; it returns the stored trial.
  const TRIAL = 'trials';
  const OPEN = 'completion_state IS NULL';
  const ended = (id) => `trials ${id} has ended`;
  /** Append one ordered child row: `encode(position)` at the owner's next position (within `scope`). */
  const appendTo = (table, id, encode, scope = {}) => st.ins[table].run(encode(nextPosition(table, 'trial_id', id, scope)));
  /** An act that inserts a sub-record checks it reads back as written, as a create does. */
  const storedAs = (id, written, path, pick) => (stored) => readsBackAsWritten(TRIAL, id, written, pick(stored), path);
  const setCols = (id, cols) => q(`UPDATE trials SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(nulls({ ...cols, id }));
  /**
   * The bookkeeping an act leaves on its trial: the rev bump (`bump`, by `revBy`, `{ id, name }`, at `at`), its history
   * entries (only ever appended) and the client key it was sent with (`key`, `{ act, key, fp }`; the newest are kept).
   */
  const applyAct = (id, { at = null, revBy = null, bump = false, history = [], key = null } = {}) => {
    if (bump) q('UPDATE trials SET rev = rev + 1, rev_at = @at, rev_by_user_id = @uid, rev_by_name = @name WHERE id = @id').run({ id, at, uid: revBy?.id ?? null, name: revBy?.name ?? null });
    for (const h of listOf(TRIAL, id, 'history', history, { objects: true })) rowStep(TRIAL, id, `history ${h.id}`, () => appendTo('trial_history', id, (p) => historyRow(id, h, p)));
    if (key?.key) {
      rowStep(TRIAL, id, `key ${key.act}`, () => appendTo('trial_keys', id, (p) => keyRow(id, key.act, { key: key.key, fp: key.fp, at }, p), { act: key.act }));
      q('DELETE FROM trial_keys WHERE trial_id = @id AND act = @act AND position <= (SELECT MAX(position) FROM trial_keys WHERE trial_id = @id AND act = @act) - @kept').run({ id, act: key.act, kept: KEYS_KEPT });
    }
  };
  const trialActs = (defs) => {
    const run = (name, id, fn, bookkeeping) => operation(() => {
      if (!st.trialById.get(id)) throw refusal('NOT_FOUND', `trials ${id} is not a record of the repository`);
      const check = rowStep(TRIAL, id, name, fn); applyAct(id, bookkeeping);
      const stored = must('trials', id); if (typeof check === 'function') check(stored); return stored;
    });
    return writes({
      ...Object.fromEntries(Object.entries(defs).map(([name, fn]) => [name, (id, input = {}, bookkeeping = {}) => run(name, id, () => fn(id, input), bookkeeping)])),
      recordAct: (id, bookkeeping = {}) => run('recordAct', id, () => {}, bookkeeping),
    });
  };
  /** Replace the current sessions with `sessions`: a kept session (same id) keeps its evidence links, a dropped one loses them. */
  const replaceSessions = (id, sessions) => {
    const keep = new Set(sessions.map((s) => s.id));
    const had = new Set(q('SELECT id FROM trial_schedule_sessions WHERE trial_id = ?').all(id).map((r) => r.id));
    for (const sid of had) if (!keep.has(sid)) q('DELETE FROM trial_schedule_sessions WHERE trial_id = ? AND id = ?').run(id, sid);
    q('UPDATE trial_schedule_sessions SET position = -1 - position WHERE trial_id = ?').run(id); // free the positions
    const cols = COLS.trial_schedule_sessions.filter((c) => c !== 'trial_id' && c !== 'id');
    sessions.forEach((s, i) => (had.has(s.id)
      ? q(`UPDATE trial_schedule_sessions SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE trial_id = @trial_id AND id = @id`).run(nulls(scheduleSessionRow(id, s, i)))
      : st.ins.trial_schedule_sessions.run(scheduleSessionRow(id, s, i))));
  };

  const trialWrites = {
    ...writes({ create: create('trials') }),
    ...trialActs({
      /**
       * A schedule proposal, revision `revision` (one past the current): the open revisions are superseded, the new one
       * recorded with its sessions, and the current sessions replaced. `keepsConfirmation` keeps the recipient's
       * confirmation (a change that is not material); otherwise it is cleared and asked for again.
       */
      proposeSchedule: (id, { revision, timezone, sessions, proposedAt, proposedBy, keepsConfirmation = false, reason = null, material = null, workflowState }) => {
        if (!Number.isSafeInteger(revision) || revision < 1) throw invalid(`trials ${id} schedule revision: must be a positive integer`);
        const list = listOf(TRIAL, id, 'schedule.sessions', sessions, { objects: true });
        const confirmed = q('SELECT schedule_confirmed_at AS at FROM trials WHERE id = ?').get(id).at;
        guarded(TRIAL, { id }, `${OPEN} AND COALESCE(schedule_revision, 0) = ${revision - 1}`, {
          schedule_timezone: timezone, schedule_revision: revision, schedule_proposed_at: proposedAt, ...actorRow('schedule_proposed_by', proposedBy),
          ...(keepsConfirmation ? {} : { schedule_confirmed_at: null, ...actorRow('schedule_confirmed_by', null) }),
          schedule_declined_at: null, ...actorRow('schedule_declined_by', null), workflow_state: workflowState,
        }, `trials ${id} is not open at schedule revision ${revision - 1}`);
        q('UPDATE trial_schedule_revisions SET superseded_at = ? WHERE trial_id = ? AND superseded_at IS NULL').run(proposedAt, id);
        const rev = { revision, timezone, sessions: list, proposedAt, proposedBy, confirmedAt: keepsConfirmation ? confirmed : null, confirmedBy: null, supersededAt: null, reason, material };
        appendTo('trial_schedule_revisions', id, (p) => revisionRow(id, rev, p));
        list.forEach((s, i) => st.ins.trial_revision_sessions.run(revisionSessionRow(id, revision, s, i)));
        replaceSessions(id, list);
        return (stored) => {
          storedAs(id, rev, `schedule.revisions ${revision}`, (t) => t.schedule.revisions.find((r) => r.revision === revision))(stored);
          storedAs(id, list, 'schedule.sessions', (t) => t.schedule.sessions)(stored);
        };
      },
      /** The recipient confirmed the proposed schedule; `recipient` is who answered. */
      confirmSchedule: (id, { at, by, recipient, workflowState }) => {
        guardiansExist(TRIAL, id, [recipient?.guardianId]);
        guarded(TRIAL, { id }, `${OPEN} AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL`, { schedule_confirmed_at: at, ...actorRow('schedule_confirmed_by', by), schedule_declined_at: null, ...recipientCols(recipient), workflow_state: workflowState }, `trials ${id} has no proposed schedule awaiting confirmation`);
        q(`UPDATE trial_schedule_revisions SET confirmed_at = @at, ${Object.keys(actorRow('confirmed_by', null)).map((c) => `${c} = @${c}`).join(', ')} WHERE trial_id = @id AND revision = (SELECT schedule_revision FROM trials WHERE id = @id)`).run(nulls({ id, at, ...actorRow('confirmed_by', by) }));
      },
      /** The recipient declined the proposed schedule. */
      declineSchedule: (id, { at, by }) => guarded(TRIAL, { id }, `${OPEN} AND schedule_revision IS NOT NULL AND schedule_confirmed_at IS NULL AND schedule_declined_at IS NULL`, { schedule_declined_at: at, ...actorRow('schedule_declined_by', by) }, `trials ${id} has no proposed schedule awaiting an answer`),
      /** The trial is cancelled, by the club or the recipient (`cancelledBy`), from `phase`. */
      cancel: (id, { at, by, reason = null, phase, cancelledBy }) => guarded(TRIAL, { id }, OPEN, { ...completionCols({ state: 'cancelled', at, by, reason, phase, cancelledBy }), workflow_state: 'cancelled' }, ended(id)),
      /** The club recorded the scheduled trial as completed. */
      complete: (id, { at, by }) => guarded(TRIAL, { id }, `${OPEN} AND workflow_state = 'scheduled'`, { ...completionCols({ state: 'completed', at, by, phase: 'scheduled' }), workflow_state: 'completed' }, `trials ${id} is not scheduled`),
      /** What happened at a session; appended, never corrected. */
      recordAttendance: (id, { attendance: a }) => { appendTo('trial_attendance', id, (p) => attendanceRow(id, a, p)); return storedAs(id, a, 'attendance', (t) => t.attendance.at(-1)); },
      /** A Box Cam session cited on a trial session (a reference, nothing copied). */
      linkEvidence: (id, { sessionId, evidence: e }) => { appendTo('trial_session_evidence', id, (p) => evidenceRow(id, sessionId, e, p), { session_id: sessionId }); return storedAs(id, e, `evidence ${e.id}`, (t) => t.schedule?.sessions.find((s) => s.id === sessionId)?.evidence.find((x) => x.id === e.id)); },
      /** An evidence link withdrawn: tombstoned with its removal, never erased. */
      unlinkEvidence: (id, { evidenceId, at, by }) => guarded('trial_session_evidence', { trial_id: id, id: evidenceId }, 'removed_at IS NULL', { removed_at: at, ...actorRow('removed_by', by) }, `trials ${id} evidence ${evidenceId} is not an active link`),
      /** What the case's lifecycle did with the trial's last step (`{ applied, from, to, at }` or `{ applied: false, reason, at }`). */
      recordLifecycle: (id, { lifecycle }) => { setCols(id, lifecycleCols(lifecycle)); return storedAs(id, lifecycle, 'lifecycle', (t) => t.lifecycle); },
      /** The mandatory report, filed once; it counts in the player's profile figure. */
      fileReport: (id, { report }) => {
        guarded(TRIAL, { id }, "status = 'awaiting_report'", { status: 'reported' }, `trials ${id} already has its report`);
        st.ins.trial_reports.run(reportRow(id, report));
        refreshProfileSignals(sqlite, [st.trialById.get(id).player_id]);
        return storedAs(id, report, 'report', (t) => t.report);
      },
      /** The overdue-report escalation, once. */
      escalateFeedback: (id, { at }) => guarded(TRIAL, { id }, 'feedback_escalated_at IS NULL', { feedback_escalated_at: at }, `trials ${id} was already escalated`),
      /** The one-shot report-due reminder. */
      markReportReminderSent: (id) => guarded(TRIAL, { id }, 'reminder_sent = 0', { reminder_sent: 1 }, `trials ${id} was already reminded of its report`),
      /** Reminder markers `{ marker: sentAt }`, each set once. */
      markReminders: (id, { markers }) => { for (const [marker, at] of Object.entries(markers)) st.ins.trial_reminders.run({ trial_id: id, marker, sent_at: at }); },
      // The trial day.
      addStaff: (id, { staff: s }) => { appendTo('trial_day_staff', id, (p) => staffRow(id, s, p)); return storedAs(id, s, `day.staff ${s.id}`, (t) => t.day.staff.find((x) => x.id === s.id)); },
      /** Arrival details replace the last; a collection policy only when one is given. */
      setArrival: (id, { arrival, collection }) => setCols(id, { ...arrivalCols(arrival), ...(collection ? { day_collection_policy: collection.policy } : {}) }),
      /** A cancellation or postponement of the day; a postponement moves the date and the report deadline. */
      recordDayStatus: (id, { event, proposedDate, reportDueAt }) => {
        appendTo('trial_day_status_events', id, (p) => statusEventRow(id, event, p));
        if (proposedDate !== undefined) setCols(id, { proposed_date: proposedDate, report_due_at: reportDueAt });
        return storedAs(id, event, 'day.statusEvents', (t) => t.day.statusEvents.at(-1));
      },
      /** The player checked in; `attendance` is the session the check-in attends, when there is one. */
      checkIn: (id, { checkin, attendance = null }) => {
        appendTo('trial_day_checkins', id, (p) => checkinRow(id, checkin, p));
        if (attendance) appendTo('trial_attendance', id, (p) => attendanceRow(id, attendance, p));
        return (stored) => { storedAs(id, checkin, 'day.checkins', (t) => t.day.checkins.at(-1))(stored); if (attendance) storedAs(id, attendance, 'attendance', (t) => t.attendance.at(-1))(stored); };
      },
      /** Event consent, once per person and scope. */
      giveConsent: (id, { consent: c }) => { appendTo('trial_day_consents', id, (p) => consentRow(id, c, p)); return storedAs(id, c, `day.consents ${c.id}`, (t) => t.day.consents.find((x) => x.id === c.id)); },
      /** The family's emergency contact for the day, replacing the last. */
      setEmergencyContact: (id, { emergency }) => setCols(id, emergencyCols(emergency)),
      /** Trust & Safety's review of a staff member's filed check; `expiresAt` only when given. */
      reviewStaffCheck: (id, { staffId, status, reviewedBy, reviewedAt, expiresAt }) => guarded('trial_day_staff', { trial_id: id, id: staffId }, 'check_status IS NOT NULL', { check_status: status, check_reviewed_by: reviewedBy, check_reviewed_at: reviewedAt, ...(expiresAt !== undefined && expiresAt !== null ? { check_expires_at: expiresAt } : {}) }, `trials ${id} staff ${staffId} has no check`),
    }),
  };

  const pageOfRequestsBy = new Map();
  const pageOfRequests = (args, where, page) => {
    if (!pageOfRequestsBy.has(where)) pageOfRequestsBy.set(where, newestFirst('requests', 'recruitment_requests', () => where));
    return pageOfRequestsBy.get(where)(args, page);
  };
  const pageOfTrials = newestFirst('trials', 'trials', () => 'org_id = ?');
  const trialHistoryFrom = (orgId, actions) => ({ from: 'trial_history h JOIN trials t ON t.id = h.trial_id', where: `t.org_id = ? AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`, params: [orgId, ...actions] });
  const requests = {
    ...requestWrites,
    byId: (id) => read('requests', id),
    forOrg: list('requests', 'SELECT * FROM recruitment_requests WHERE org_id = ? ORDER BY rowid'),
    forPlayer: list('requests', 'SELECT * FROM recruitment_requests WHERE player_id = ? ORDER BY rowid'),
    forPlayers: inList('requests', 'recruitment_requests', 'player_id'),
    forOrgPlayer: list('requests', 'SELECT * FROM recruitment_requests WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    forCase: list('requests', 'SELECT * FROM recruitment_requests WHERE case_id = ? ORDER BY rowid'),
    /** The requests of several cases (a player's journeys), in insertion order. */
    forCases: inList('requests', 'recruitment_requests', 'case_id'),
    countForOrg: count('SELECT COUNT(*) AS n FROM recruitment_requests WHERE org_id = ?'),
    countForOrgStatus: count('SELECT COUNT(*) AS n FROM recruitment_requests WHERE org_id = ? AND status = ?'),
    /** The club's Requests list, newest first, by cursor: `{ items, nextCursor }`. */
    pageForOrg: (orgId, page) => pageOfRequests([orgId], 'org_id = ?', page),
    /** A player's Inbox, newest first, by cursor. */
    pageForPlayer: (playerId, page) => pageOfRequests([playerId], 'player_id = ?', page),
    /** A guardian's Inbox: the requests routed to the guardian about any of `playerIds`, newest first, by cursor. */
    pageForGuardianOf(playerIds, page) {
      const want = [...new Set((playerIds ?? []).filter((v) => typeof v === 'string'))];
      if (!want.length) return { items: [], nextCursor: null };
      return pageOfRequests(want, `player_id IN (${placeholders(want)}) AND routed_to = 'guardian'`, page);
    },
  };
  const staffPage = {
    first: (pendingOnly) => sqlite.prepare(`SELECT t.rowid AS page_trial, s.position AS page_position, s.*, t.org_id, t.org_name FROM trial_day_staff s JOIN trials t ON t.id = s.trial_id WHERE s.check_status IS NOT NULL ${pendingOnly ? "AND s.check_status = 'pending'" : ''} ORDER BY t.rowid, s.position LIMIT ?`),
    after: (pendingOnly) => sqlite.prepare(`SELECT t.rowid AS page_trial, s.position AS page_position, s.*, t.org_id, t.org_name FROM trial_day_staff s JOIN trials t ON t.id = s.trial_id WHERE s.check_status IS NOT NULL ${pendingOnly ? "AND s.check_status = 'pending'" : ''} AND (t.rowid > ? OR (t.rowid = ? AND s.position > ?)) ORDER BY t.rowid, s.position LIMIT ?`),
  };
  const staffStmts = { true: { first: staffPage.first(true), after: staffPage.after(true) }, false: { first: staffPage.first(false), after: staffPage.after(false) } };
  const trials = {
    ...trialWrites,
    byId: (id) => read('trials', id),
    forOrg: list('trials', 'SELECT * FROM trials WHERE org_id = ? ORDER BY rowid'),
    forOrgStatus: list('trials', 'SELECT * FROM trials WHERE org_id = ? AND status = ? ORDER BY rowid'),
    forPlayer: list('trials', 'SELECT * FROM trials WHERE player_id = ? ORDER BY rowid'),
    forPlayers: inList('trials', 'trials', 'player_id'),
    forOrgPlayer: list('trials', 'SELECT * FROM trials WHERE org_id = ? AND player_id = ? ORDER BY rowid'),
    forCase: list('trials', 'SELECT * FROM trials WHERE case_id = ? ORDER BY rowid'),
    /** The trials of several cases (a player's journeys), in insertion order. */
    forCases: inList('trials', 'trials', 'case_id'),
    countForOrg: count('SELECT COUNT(*) AS n FROM trials WHERE org_id = ?'),
    countForOrgStatus: count('SELECT COUNT(*) AS n FROM trials WHERE org_id = ? AND status = ?'),
    /**
     * The history of the organisation's trials with one of `actions`, newest first, for a merged feed (the audit feed):
     * `{ trialId, caseId, playerId, entry }`. See `newestHistory` (database.mjs) for `atMost` and `n`.
     */
    historyFeed(orgId, actions, atMost, n) {
      return newestHistory(sqlite, { select: 'h.*, t.case_id AS owner_case_id, t.player_id AS owner_player_id', ...trialHistoryFrom(orgId, actions) }, atMost, n)
        .map((h) => ({ trialId: h.trial_id, caseId: h.owner_case_id, playerId: h.owner_player_id, entry: trialHistoryOut(h) }));
    },
    historyCount(orgId, actions) { const f = trialHistoryFrom(orgId, actions); return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${f.from} WHERE ${f.where}`).get(...f.params).n; },
    /** The players of the organisation's trials at `status` (a Set; nothing decoded). */
    playerIdsForOrgStatus: (orgId, status) => new Set(sqlite.prepare('SELECT DISTINCT player_id FROM trials WHERE org_id = ? AND status = ?').all(orgId, status).map((r) => r.player_id)),
    /** The club's Trials list, newest first, by cursor: `{ items, nextCursor }`. */
    pageForOrg: (orgId, page) => pageOfTrials([orgId], page),
    /** The report sweep: a deadline passed, no report, never escalated, the subject not removed. */
    reportOverdue: list('trials', 'SELECT * FROM trials t WHERE t.report_due_at < ? AND t.feedback_escalated_at IS NULL AND t.subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reports r WHERE r.trial_id = t.id) ORDER BY t.rowid'),
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
      return (now) => decodeAll('trials', stmt.all({ now }));
    })(),
    /** The assessment reminder: completed at or before `before`, the subject not removed, not yet reminded. */
    completedUnreminded: list('trials', "SELECT * FROM trials t WHERE t.completion_state = 'completed' AND t.completion_at <= ? AND t.subject_removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM trial_reminders m WHERE m.trial_id = t.id AND m.marker = 'assessmentPending') ORDER BY t.rowid"),
    /** The admin staff-check queue by cursor (trial, then staff position): `{ items, nextCursor }` rows, not trials. */
    staffChecksPage({ pendingOnly, limit, after = null }) {
      const s = staffStmts[pendingOnly ? 'true' : 'false'];
      const rows = after ? s.after.all(after[0], after[0], after[1], limit + 1) : s.first.all(limit + 1);
      const page = pageOf(rows, limit, (r) => [r.page_trial, r.page_position]);
      return { items: page.items.map((r) => ({ trialId: r.trial_id, orgId: r.org_id, orgName: r.org_name, staffId: r.id, name: r.name, role: r.role, check: { kind: r.check_kind, ref: r.check_ref, status: r.check_status, expiresAt: r.check_expires_at, reviewedBy: r.check_reviewed_by, reviewedAt: r.check_reviewed_at } })), nextCursor: page.nextCursor };
    },
  };
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = { requests: sqlite.prepare('SELECT COUNT(*) AS n FROM recruitment_requests'), trials: sqlite.prepare('SELECT COUNT(*) AS n FROM trials'), trialReports: sqlite.prepare('SELECT COUNT(*) AS n FROM trial_reports') };
  const OF_PLAYER = 'SELECT id FROM trials WHERE player_id = @p';
  const nullActor = (p, keepKind = true) => [...(keepKind ? [] : [`${p}_kind`]), `${p}_user_id`, `${p}_actor_id`, `${p}_name`].map((c) => `${c} = NULL`).join(', ');

  return {
    requests, trials,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({ requests: readOnly(requests), trials: readOnly(trials) }),
    /**
     * The deletion unit: what the player's requests and trials keep when the player removes their account. The rule
     * is the ledger's: ids, states, times and the club's own filed numbers stay, so a case that cites a trial still
     * resolves; what describes the person goes: their name, the club's notes about them, the message and subject sent
     * to them, the family's emergency contact and the arrival details written for them, session instructions and
     * address lines, attendance notes, the feedback in a report, the Box Cam evidence links (the player's sessions are
     * no longer the club's to cite), the recipient and guardian ids, actors' names (their kind stays) and history
     * detail text. `subjectRemovedAt` tells every reader why.
     */
    redactPlayer(playerId, at) {
      return operation(() => {
        const p = { p: playerId }; const pa = { p: playerId, at };
        const requestsDone = q(`UPDATE recruitment_requests SET player_name = NULL, message = NULL, subject = NULL, trial_notes = CASE WHEN type = 'trial' THEN '' END,
          trial_private_venue_address = NULL, trial_private_instructions = NULL, guardian_id = NULL, contact_channel_id = NULL,
          recipient_type = NULL, recipient_player_id = NULL, recipient_guardian_id = NULL, recipient_minor = NULL, invite_key = NULL, invite_fp = NULL,
          subject_removed_at = @at WHERE player_id = @p`).run(pa).changes;
        q('UPDATE request_trial_slots SET venue_address = NULL WHERE request_id IN (SELECT id FROM recruitment_requests WHERE player_id = @p)').run(p);
        const inTrials = `trial_id IN (${OF_PLAYER})`;
        q(`DELETE FROM trial_session_evidence WHERE ${inTrials}`).run(p);
        for (const t of ['trial_schedule_sessions', 'trial_revision_sessions']) q(`UPDATE ${t} SET venue_address = NULL, instructions = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_schedule_revisions SET ${nullActor('proposed_by')}, ${nullActor('confirmed_by', false)}, reason = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_attendance SET note = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_reports SET notes = NULL, strength_note = NULL, focus_note = NULL WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_day_consents SET ${nullActor('by')} WHERE ${inTrials}`).run(p);
        q(`UPDATE trial_history SET ${nullActor('by')} WHERE ${inTrials}`).run(p);
        for (const h of q(`SELECT trial_id, position, detail_json FROM trial_history WHERE detail_json IS NOT NULL AND ${inTrials}`).all(p)) q('UPDATE trial_history SET detail_json = ? WHERE trial_id = ? AND position = ?').run(redactedDetail(h.detail_json), h.trial_id, h.position);
        const trialsDone = q(`UPDATE trials SET player_name = NULL, notes = '', ${nullActor('schedule_proposed_by')}, ${nullActor('schedule_confirmed_by')},
          schedule_declined_at = NULL, ${nullActor('schedule_declined_by', false)}, ${nullActor('completion_by')}, completion_reason = NULL, completion_cancelled_by = NULL,
          recipient_player_id = NULL, recipient_guardian_id = NULL, ${Object.keys(lifecycleCols(null)).map((c) => `${c} = NULL`).join(', ')},
          ${Object.keys({ ...arrivalCols(null), ...emergencyCols(null) }).map((c) => `${c} = NULL`).join(', ')}, day_collection_policy = NULL,
          rev_by_user_id = NULL, rev_by_name = NULL, subject_removed_at = @at WHERE player_id = @p`).run(pa).changes;
        if (trialsDone) refreshProfileSignals(sqlite, [playerId]);
        return { requests: requestsDone, trials: trialsDone };
      });
    },
    /** The derived `players[].trialReports`: the reports filed on the player's trials, in filing order. */
    trialReportsFor(playerId) {
      return reportsOf([playerId]).get(playerId) ?? [];
    },
    /**
     * The trial reports of many players at once (one query): Map player id → reports in filing order. Read from the
     * report rows alone, never by decoding the trials: every player read pays this. The composite key to trials
     * makes a report's player its trial's player.
     */
    trialReportsForPlayers: (playerIds) => reportsOf(playerIds),
    /** Check migration 0015 is recorded; there is nothing to load. */
    attach() {
      if (!recruitmentLive(sqlite)) throw new Error(`the recruitment repository needs ${RECRUITMENT_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return { requests: counters.requests.get().n, trials: counters.trials.get().n, trialReports: counters.trialReports.get().n }; },
    pending: () => 0,
    exportAll() { return RECRUITMENT_RECORDS.read(sqlite); },
    log,
    now,
  };
}
