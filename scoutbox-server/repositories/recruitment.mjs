/**
 * Recruitment requests (with their trial slots) and accepted trials (with their schedule, attendance, history, keys,
 * reminders, reports and trial-day rows).
 *
 * Every field is a typed column with the vocabulary CHECKs of the domain rules (server.mjs issueRecruitmentRequest and
 * issueAcceptedTrial, domains/recruitment/lifecycle/trial.mjs, domains/recruitment/lifecycle/trialRoutes.mjs,
 * domains/scouting/journeys.mjs). A record the columns cannot hold, an unknown field at any level included, is refused
 * with its id at a repository write (the unit rolls back). An `undefined` field is an absent one; an absent field reads
 * back as null, an absent list as empty. A trial always reads back with its trial-day container, its five client-key
 * lists and its reminder map, so a reader never has to create them.
 *
 * References. `org_id` → orgs, `user_id` → org_users and `case_id` (both tables) → recruitment_cases (RESTRICT).
 * `recruitment_requests.trial_id` → trials is DEFERRABLE INITIALLY DEFERRED (checked at COMMIT): a request and the
 * trial it names are written in one unit. `trials.request_id` → recruitment_requests is immediate. Player ids: no key,
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
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

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
  focus_note TEXT
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


// ------------------------------------------------------------------ typing (the one place a value is judged)
const isInt = (v) => Number.isSafeInteger(v);
const isStr = (v) => typeof v === 'string';
const absent = (v) => v === undefined || v === null;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A typing failure carries `reason` (record, field, what it holds — never the value of a text field). */
class Bad extends Error {}
const fail = (label, field, what) => { throw new Bad(`${label}.${field} ${what}`); };
/** Refuse an own key the tables have no column for; an `undefined` value is an absent key. */
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
const num = (v, label, field) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(label, field, `must be a finite number (got ${describe(v)})`); return v; };
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
const list = (v, label, field) => { if (absent(v)) return []; if (!Array.isArray(v)) fail(label, field, `must be a list (got ${describe(v)})`); return v; };
const obj = (v, keys, label, field) => (absent(v) ? null : onlyKeys(v, keys, label, field));
const unique = (items, keyOf, label, field) => { const seen = new Set(); for (const x of items) { const k = keyOf(x); if (seen.has(k)) fail(label, field, `repeats ${k}`); seen.add(k); } };

/**
 * An actor as the trial writers build it: an organisation member `{kind:'org', userId, name}` (trialRoutes orgActor)
 * or a family member / the system `{kind, id, name}`. A tombstone keeps the kind alone.
 */
function typeActor(v, label, field) {
  const a = obj(v, ['kind', 'userId', 'id', 'name'], label, field);
  if (!a) return null;
  const kind = oneOf(a.kind, ACTOR_KINDS, label, `${field}.kind`);
  if (absent(a.userId) && absent(a.id) && absent(a.name)) return { kind }; // a tombstone keeps the kind alone
  if (kind === 'org') { if (!absent(a.id)) fail(label, `${field}.id`, 'is not stored for an organisation actor (userId is)'); return { kind, userId: str(a.userId, label, `${field}.userId`), name: str(a.name, label, `${field}.name`) }; }
  if (!absent(a.userId)) fail(label, `${field}.userId`, 'is only stored for an organisation actor');
  return { kind, id: str(a.id, label, `${field}.id`), name: str(a.name, label, `${field}.name`) };
}
function typeVenue(v, label, field) {
  const x = obj(v, ['name', 'town', 'address'], label, field);
  if (!x) return null;
  return { name: str(x.name, label, `${field}.name`, { required: true, max: TRIAL_LIMITS.venueName }), town: str(x.town, label, `${field}.town`, { max: TRIAL_LIMITS.venueTown }), address: str(x.address, label, `${field}.address`, { max: TRIAL_LIMITS.venueAddress }) };
}
function typeSession(s, label, { withEvidence }) {
  onlyKeys(s, ['id', 'kind', 'startsAt', 'endsAt', 'venue', 'instructions', ...(withEvidence ? ['evidence'] : [])], label, 'session');
  const out = { id: str(s.id, label, 'id', { required: true }), kind: oneOf(s.kind, TRIAL_SESSION_KINDS, label, 'kind'), startsAt: int(s.startsAt, label, 'startsAt', { required: true }), endsAt: int(s.endsAt, label, 'endsAt', { required: true }), venue: typeVenue(s.venue, label, 'venue'), instructions: str(s.instructions, label, 'instructions', { max: TRIAL_LIMITS.instructions }) };
  if (out.endsAt <= out.startsAt) fail(label, 'endsAt', 'must be after startsAt');
  if (withEvidence) {
    out.evidence = list(s.evidence, label, 'evidence').map((e, i) => {
      const L = `${label} evidence[${i}]`;
      onlyKeys(e, ['id', 'kind', 'sessionId', 'linkedAt', 'linkedBy', 'removedAt', 'removedBy'], L, 'entry');
      return { id: str(e.id, L, 'id', { required: true }), kind: oneOf(e.kind, EVIDENCE_KINDS, L, 'kind'), sessionId: str(e.sessionId, L, 'sessionId', { required: true }), linkedAt: int(e.linkedAt, L, 'linkedAt', { required: true }), linkedBy: typeActor(e.linkedBy, L, 'linkedBy'), removedAt: int(e.removedAt, L, 'removedAt'), removedBy: typeActor(e.removedBy, L, 'removedBy') };
    });
    unique(out.evidence.filter((e) => e.removedAt === null), (e) => e.sessionId, label, 'evidence (active links)');
  }
  return out;
}

const REQUEST_KEYS = ['id', 'playerId', 'playerName', 'orgId', 'orgName', 'orgType', 'orgVerified', 'orgSafeguardingCertified', 'trustedPartner', 'userId', 'scoutName', 'scoutRole', 'type', 'message', 'subject', 'contactId', 'trialDetails', 'status', 'createdAt', 'respondedAt', 'respondedBy', 'routedTo', 'guardianId', 'contactChannel', 'caseId', 'trialId', 'recipient', 'keys', 'subjectRemovedAt'];

/** A request as issueRecruitmentRequest (and the trial invitation) writes it, typed. Returns `{ ok: true, record }` or `{ ok: false, reason }`. */
export function typeRequest(raw, at = 'requests') {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
    if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
    const L = `${at} ${raw.id}`;
    onlyKeys(raw, REQUEST_KEYS, L, 'record');
    const type = oneOf(raw.type, REQUEST_TYPES, L, 'type');
    let trialDetails = null;
    if (type === 'trial') {
      const td = obj(raw.trialDetails, ['proposedDate', 'altSlots', 'venue', 'notes', 'slots', 'private'], L, 'trialDetails');
      if (!td) fail(L, 'trialDetails', 'is required on a trial request');
      const priv = obj(td.private, ['venueAddress', 'instructions'], L, 'trialDetails.private');
      const slots = list(td.slots, L, 'trialDetails.slots').map((s, i) => {
        const SL = `${L} trialDetails.slots[${i}]`;
        onlyKeys(s, ['id', 'day', 'kind', 'startsAt', 'endsAt', 'timezone', 'venue'], SL, 'slot');
        const slot = { id: str(s.id, SL, 'id', { required: true }), day: dayOf(s.day, SL, 'day', { required: true }), kind: oneOf(s.kind, TRIAL_SESSION_KINDS, SL, 'kind'), startsAt: int(s.startsAt, SL, 'startsAt', { required: true }), endsAt: int(s.endsAt, SL, 'endsAt', { required: true }), timezone: str(s.timezone, SL, 'timezone', { required: true }), venue: typeVenue(s.venue, SL, 'venue') };
        if (slot.endsAt <= slot.startsAt) fail(SL, 'endsAt', 'must be after startsAt');
        return slot;
      });
      unique(slots, (s) => s.day, L, 'trialDetails.slots');
      const privateDetails = priv && (!absent(priv.venueAddress) || !absent(priv.instructions)) ? { venueAddress: str(priv.venueAddress, L, 'trialDetails.private.venueAddress', { max: TRIAL_LIMITS.venueAddress }), instructions: str(priv.instructions, L, 'trialDetails.private.instructions', { max: TRIAL_LIMITS.instructions }) } : null;
      trialDetails = {
        proposedDate: dayOf(td.proposedDate, L, 'trialDetails.proposedDate'),
        altSlots: list(td.altSlots, L, 'trialDetails.altSlots').map((d, i) => dayOf(d, L, `trialDetails.altSlots[${i}]`, { required: true })),
        venue: str(td.venue, L, 'trialDetails.venue'), notes: str(td.notes, L, 'trialDetails.notes'),
        slots, private: privateDetails,
      };
    } else if (!absent(raw.trialDetails)) fail(L, 'trialDetails', 'is only stored on a trial request');
    const r = obj(raw.recipient, ['type', 'playerId', 'guardianId', 'minor'], L, 'recipient');
    const recipient = r ? { type: oneOf(r.type, PARTIES, L, 'recipient.type'), playerId: str(r.playerId, L, 'recipient.playerId'), guardianId: str(r.guardianId, L, 'recipient.guardianId'), minor: flag(r.minor, L, 'recipient.minor', { required: true }) } : null;
    const keys = obj(raw.keys, ['invite'], L, 'keys');
    const inv = keys ? obj(keys.invite, ['key', 'fp'], L, 'keys.invite') : null;
    const record = {
      id: raw.id, playerId: str(raw.playerId, L, 'playerId', { required: true }), playerName: str(raw.playerName, L, 'playerName'),
      orgId: str(raw.orgId, L, 'orgId', { required: true }), orgName: str(raw.orgName, L, 'orgName', { required: true }), orgType: oneOf(raw.orgType, ORG_TYPES, L, 'orgType', { required: false }),
      orgVerified: flag(raw.orgVerified, L, 'orgVerified', { required: true }), orgSafeguardingCertified: flag(raw.orgSafeguardingCertified, L, 'orgSafeguardingCertified', { required: true }), trustedPartner: flag(raw.trustedPartner, L, 'trustedPartner'),
      userId: str(raw.userId, L, 'userId', { required: true }), scoutName: str(raw.scoutName, L, 'scoutName'), scoutRole: str(raw.scoutRole, L, 'scoutRole'),
      type, message: str(raw.message, L, 'message'), subject: str(raw.subject, L, 'subject'), contactId: str(raw.contactId, L, 'contactId'),
      trialDetails, status: oneOf(raw.status, REQUEST_STATUSES, L, 'status'), createdAt: int(raw.createdAt, L, 'createdAt', { required: true }),
      respondedAt: int(raw.respondedAt, L, 'respondedAt'), respondedBy: oneOf(raw.respondedBy, PARTIES, L, 'respondedBy', { required: false }),
      routedTo: oneOf(raw.routedTo, PARTIES, L, 'routedTo'), guardianId: str(raw.guardianId, L, 'guardianId'), contactChannel: str(raw.contactChannel, L, 'contactChannel'),
      caseId: str(raw.caseId, L, 'caseId'), trialId: str(raw.trialId, L, 'trialId'), recipient,
      keys: { invite: inv ? { key: str(inv.key, L, 'keys.invite.key', { required: true, max: TRIAL_LIMITS.clientKey }), fp: str(inv.fp, L, 'keys.invite.fp', { required: true }) } : null },
      subjectRemovedAt: int(raw.subjectRemovedAt, L, 'subjectRemovedAt'),
    };
    return { ok: true, record };
  } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
}

const TRIAL_KEYS = ['id', 'requestId', 'caseId', 'playerId', 'playerName', 'orgId', 'orgName', 'scoutName', 'acceptedAt', 'acceptedBy', 'guardianApproved', 'proposedDate', 'venue', 'notes', 'reportDueAt', 'status', 'reminderSent', 'feedbackEscalatedAt', 'report', 'day', 'workflowState', 'schedule', 'attendance', 'completion', 'recipient', 'keys', 'history', 'reminders', 'lifecycle', 'rev', 'revAt', 'revBy', 'subjectRemovedAt'];
/** The trial-day container every trial reads back with (domains/scouting/journeys.mjs). */
export const emptyTrialDay = () => ({ staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] });

function typeDay(d, L) {
  if (!d) return emptyTrialDay();
  const staff = list(d.staff, L, 'day.staff').map((s, i) => {
    const SL = `${L} day.staff[${i}]`;
    onlyKeys(s, ['id', 'name', 'role', 'check', 'addedBy', 'addedAt'], SL, 'entry');
    const ch = obj(s.check, ['kind', 'ref', 'status', 'expiresAt', 'reviewedBy', 'reviewedAt'], SL, 'check');
    return { id: str(s.id, SL, 'id', { required: true }), name: str(s.name, SL, 'name', { required: true, max: 80 }), role: str(s.role, SL, 'role', { required: true, max: 60 }), check: ch ? { kind: str(ch.kind, SL, 'check.kind', { max: 60 }), ref: str(ch.ref, SL, 'check.ref', { max: 60 }), status: oneOf(ch.status, TRIAL_STAFF_CHECK_STATES, SL, 'check.status'), expiresAt: str(ch.expiresAt, SL, 'check.expiresAt', { max: 40 }), reviewedBy: str(ch.reviewedBy, SL, 'check.reviewedBy', { max: 80 }), reviewedAt: int(ch.reviewedAt, SL, 'check.reviewedAt') } : null, addedBy: str(s.addedBy, SL, 'addedBy'), addedAt: int(s.addedAt, SL, 'addedAt', { required: true }) };
  });
  unique(staff, (s) => s.id, L, 'day.staff');
  const consents = list(d.consents, L, 'day.consents').map((x, i) => { const CL = `${L} day.consents[${i}]`; onlyKeys(x, ['id', 'by', 'scope', 'at'], CL, 'entry'); return { id: str(x.id, CL, 'id', { required: true }), by: typeActor(x.by, CL, 'by'), scope: oneOf(x.scope, TRIAL_CONSENT_SCOPES, CL, 'scope'), at: int(x.at, CL, 'at', { required: true }) }; });
  const checkins = list(d.checkins, L, 'day.checkins').map((x, i) => { const CL = `${L} day.checkins[${i}]`; onlyKeys(x, ['playerId', 'at', 'byUserId', 'byName'], CL, 'entry'); return { playerId: str(x.playerId, CL, 'playerId', { required: true }), at: int(x.at, CL, 'at', { required: true }), byUserId: str(x.byUserId, CL, 'byUserId'), byName: str(x.byName, CL, 'byName') }; });
  const statusEvents = list(d.statusEvents, L, 'day.statusEvents').map((x, i) => { const EL = `${L} day.statusEvents[${i}]`; onlyKeys(x, ['kind', 'at', 'by', 'reason', 'newDate'], EL, 'entry'); return { kind: oneOf(x.kind, TRIAL_DAY_EVENT_KINDS, EL, 'kind'), at: int(x.at, EL, 'at', { required: true }), by: str(x.by, EL, 'by'), reason: str(x.reason, EL, 'reason', { max: 200 }), newDate: dayOf(x.newDate, EL, 'newDate') }; });
  const ar = obj(d.arrival, ['time', 'address', 'notes'], L, 'day.arrival');
  const arrival = ar ? { time: str(ar.time, L, 'day.arrival.time', { max: 40 }), address: str(ar.address, L, 'day.arrival.address', { max: 200 }), notes: str(ar.notes, L, 'day.arrival.notes', { max: 300 }) } : null;
  const em = obj(d.emergency, ['name', 'phone', 'setBy', 'at'], L, 'day.emergency');
  const emergency = em ? { name: str(em.name, L, 'day.emergency.name', { required: true, max: 80 }), phone: str(em.phone, L, 'day.emergency.phone', { required: true, max: 30 }), setBy: oneOf(em.setBy, PARTIES, L, 'day.emergency.setBy', { required: false }), at: int(em.at, L, 'day.emergency.at', { required: true }) } : null;
  const co = obj(d.collection, ['policy'], L, 'day.collection');
  const collection = co ? { policy: str(co.policy, L, 'day.collection.policy', { required: true, max: 300 }) } : null;
  // An arrival with nothing in it is no arrival: it reads back as null.
  return { staff, consents, arrival: arrival && (arrival.time !== null || arrival.address !== null || arrival.notes !== null) ? arrival : null, emergency, checkins, collection, statusEvents };
}

/** A trial as issueAcceptedTrial, the trial routes and the trial-day routes write it, typed. */
export function typeTrial(raw, at = 'trials') {
  try {
    if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
    if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
    const L = `${at} ${raw.id}`;
    onlyKeys(raw, TRIAL_KEYS, L, 'record');
    const sc = obj(raw.schedule, ['timezone', 'revision', 'proposedAt', 'proposedBy', 'confirmedAt', 'confirmedBy', 'declinedAt', 'declinedBy', 'sessions', 'revisions'], L, 'schedule');
    const schedule = sc ? (() => {
      const sessions = list(sc.sessions, L, 'schedule.sessions').map((s, i) => typeSession(s, `${L} schedule.sessions[${i}]`, { withEvidence: true }));
      unique(sessions, (s) => s.id, L, 'schedule.sessions');
      const revisions = list(sc.revisions, L, 'schedule.revisions').map((r, i) => {
        const RL = `${L} schedule.revisions[${i}]`;
        onlyKeys(r, ['revision', 'timezone', 'sessions', 'proposedAt', 'proposedBy', 'confirmedAt', 'confirmedBy', 'supersededAt', 'reason', 'material'], RL, 'revision');
        return { revision: int(r.revision, RL, 'revision', { required: true, min: 1 }), timezone: str(r.timezone, RL, 'timezone', { required: true }), sessions: list(r.sessions, RL, 'sessions').map((s, j) => typeSession(s, `${RL} sessions[${j}]`, { withEvidence: false })), proposedAt: int(r.proposedAt, RL, 'proposedAt'), proposedBy: typeActor(r.proposedBy, RL, 'proposedBy'), confirmedAt: int(r.confirmedAt, RL, 'confirmedAt'), confirmedBy: typeActor(r.confirmedBy, RL, 'confirmedBy'), supersededAt: int(r.supersededAt, RL, 'supersededAt'), reason: str(r.reason, RL, 'reason', { max: TRIAL_LIMITS.reason }), material: flag(r.material, RL, 'material') };
      });
      unique(revisions, (r) => r.revision, L, 'schedule.revisions');
      return { timezone: str(sc.timezone, L, 'schedule.timezone', { required: true }), revision: int(sc.revision, L, 'schedule.revision', { required: true, min: 1 }), proposedAt: int(sc.proposedAt, L, 'schedule.proposedAt'), proposedBy: typeActor(sc.proposedBy, L, 'schedule.proposedBy'), confirmedAt: int(sc.confirmedAt, L, 'schedule.confirmedAt'), confirmedBy: typeActor(sc.confirmedBy, L, 'schedule.confirmedBy'), declinedAt: int(sc.declinedAt, L, 'schedule.declinedAt'), declinedBy: typeActor(sc.declinedBy, L, 'schedule.declinedBy'), sessions, revisions };
    })() : null;
    const c = obj(raw.completion, ['state', 'at', 'by', 'reason', 'phase', 'cancelledBy'], L, 'completion');
    const completion = c ? { state: oneOf(c.state, TRIAL_COMPLETION_STATES, L, 'completion.state'), at: int(c.at, L, 'completion.at', { required: true }), by: typeActor(c.by, L, 'completion.by'), reason: str(c.reason, L, 'completion.reason', { max: TRIAL_LIMITS.reason }), phase: oneOf(c.phase, TRIAL_WORKFLOW_STATES, L, 'completion.phase', { required: false }), cancelledBy: oneOf(c.cancelledBy, TRIAL_CANCEL_ACTORS, L, 'completion.cancelledBy', { required: false }) } : null;
    const r = obj(raw.recipient, ['type', 'playerId', 'guardianId', 'minor', 'at'], L, 'recipient');
    const recipient = r ? { type: oneOf(r.type, PARTIES, L, 'recipient.type'), playerId: str(r.playerId, L, 'recipient.playerId'), guardianId: str(r.guardianId, L, 'recipient.guardianId'), minor: flag(r.minor, L, 'recipient.minor', { required: true }), at: int(r.at, L, 'recipient.at') } : null;
    const lc = obj(raw.lifecycle, ['applied', 'from', 'to', 'at', 'reason'], L, 'lifecycle');
    const lifecycle = lc ? (() => {
      const applied = flag(lc.applied, L, 'lifecycle.applied', { required: true });
      if (applied) { if (!absent(lc.reason)) fail(L, 'lifecycle.reason', 'is not stored on an applied move'); return { applied, from: str(lc.from, L, 'lifecycle.from'), to: str(lc.to, L, 'lifecycle.to'), at: int(lc.at, L, 'lifecycle.at') }; }
      if (!absent(lc.from) || !absent(lc.to)) fail(L, 'lifecycle.from', 'is not stored on a move that was not applied');
      return { applied, reason: str(lc.reason, L, 'lifecycle.reason'), at: int(lc.at, L, 'lifecycle.at') };
    })() : null;
    const attendance = list(raw.attendance, L, 'attendance').map((a, i) => {
      const AL = `${L} attendance[${i}]`;
      onlyKeys(a, ['sessionId', 'state', 'source', 'recordedBy', 'recordedAt', 'note'], AL, 'entry');
      return { sessionId: str(a.sessionId, AL, 'sessionId', { required: true }), state: oneOf(a.state, TRIAL_ATTENDANCE_STATES, AL, 'state'), source: oneOf(a.source, TRIAL_ATTENDANCE_SOURCES, AL, 'source'), recordedBy: typeActor(a.recordedBy, AL, 'recordedBy'), recordedAt: int(a.recordedAt, AL, 'recordedAt', { required: true }), note: str(a.note, AL, 'note', { max: TRIAL_LIMITS.note }) };
    });
    const history = list(raw.history, L, 'history').map((h, i) => {
      const HL = `${L} history[${i}]`;
      onlyKeys(h, ['id', 'at', 'action', 'by', 'detail'], HL, 'entry');
      if (!absent(h.detail) && !isPlainObject(h.detail)) fail(HL, 'detail', 'must be an object or null');
      return { id: str(h.id, HL, 'id', { required: true }), at: int(h.at, HL, 'at', { required: true }), action: str(h.action, HL, 'action', { required: true, max: 64 }), by: typeActor(h.by, HL, 'by'), detail: absent(h.detail) ? null : clone(h.detail) };
    });
    unique(history, (h) => h.id, L, 'history');
    const k = obj(raw.keys, TRIAL_KEY_ACTS, L, 'keys') ?? {};
    const keys = Object.fromEntries(TRIAL_KEY_ACTS.map((act) => [act, list(k[act], L, `keys.${act}`).map((e, i) => { const KL = `${L} keys.${act}[${i}]`; onlyKeys(e, ['key', 'fp', 'at'], KL, 'entry'); return { key: str(e.key, KL, 'key', { required: true, max: TRIAL_LIMITS.clientKey }), fp: str(e.fp, KL, 'fp', { required: true }), at: int(e.at, KL, 'at', { required: true }) }; })]));
    const rm = absent(raw.reminders) ? {} : raw.reminders;
    if (!isPlainObject(rm)) fail(L, 'reminders', `must be an object (got ${describe(rm)})`);
    const reminders = {};
    for (const [marker, v] of Object.entries(rm)) {
      if (v === undefined) continue;
      if (marker.length > 120) fail(L, 'reminders', 'carries a marker longer than 120 characters');
      Object.defineProperty(reminders, marker, { value: int(v, L, 'reminders (a marker\'s instant)', { required: true }), enumerable: true, writable: true, configurable: true });
    }
    const rep = obj(raw.report, ['id', 'trialId', 'playerId', 'orgId', 'orgName', 'userId', 'scoutName', 'filedAt', ...TRIAL_REPORT_FIELDS, 'notes', 'strengthNote', 'focusNote'], L, 'report');
    const report = rep ? (() => {
      if (rep.trialId !== raw.id) fail(L, 'report.trialId', 'must name the trial it is filed on');
      return { id: str(rep.id, L, 'report.id', { required: true }), trialId: raw.id, playerId: str(rep.playerId, L, 'report.playerId', { required: true }), orgId: str(rep.orgId, L, 'report.orgId', { required: true }), orgName: str(rep.orgName, L, 'report.orgName'), userId: str(rep.userId, L, 'report.userId'), scoutName: str(rep.scoutName, L, 'report.scoutName'), filedAt: int(rep.filedAt, L, 'report.filedAt', { required: true }), ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, num(rep[f], L, `report.${f}`)])), notes: str(rep.notes, L, 'report.notes'), strengthNote: str(rep.strengthNote, L, 'report.strengthNote'), focusNote: str(rep.focusNote, L, 'report.focusNote') };
    })() : null;
    const rb = obj(raw.revBy, ['userId', 'name'], L, 'revBy');
    const record = {
      id: raw.id, requestId: str(raw.requestId, L, 'requestId', { required: true }), caseId: str(raw.caseId, L, 'caseId'),
      playerId: str(raw.playerId, L, 'playerId', { required: true }), playerName: str(raw.playerName, L, 'playerName'),
      orgId: str(raw.orgId, L, 'orgId', { required: true }), orgName: str(raw.orgName, L, 'orgName', { required: true }), scoutName: str(raw.scoutName, L, 'scoutName'),
      acceptedAt: int(raw.acceptedAt, L, 'acceptedAt', { required: true }), acceptedBy: oneOf(raw.acceptedBy, PARTIES, L, 'acceptedBy', { required: false }), guardianApproved: flag(raw.guardianApproved, L, 'guardianApproved'),
      proposedDate: dayOf(raw.proposedDate, L, 'proposedDate'), venue: str(raw.venue, L, 'venue'), notes: str(raw.notes, L, 'notes'),
      reportDueAt: int(raw.reportDueAt, L, 'reportDueAt'), status: oneOf(raw.status, TRIAL_STATUSES, L, 'status'),
      reminderSent: flag(raw.reminderSent, L, 'reminderSent') ?? false, feedbackEscalatedAt: int(raw.feedbackEscalatedAt, L, 'feedbackEscalatedAt'),
      report, day: typeDay(obj(raw.day, ['staff', 'consents', 'arrival', 'emergency', 'checkins', 'collection', 'statusEvents'], L, 'day'), L),
      workflowState: oneOf(raw.workflowState, TRIAL_WORKFLOW_STATES, L, 'workflowState'), schedule, attendance, completion, recipient, keys, history, reminders, lifecycle,
      rev: int(raw.rev, L, 'rev', { required: true, min: 0 }), revAt: int(raw.revAt, L, 'revAt'), revBy: rb ? { userId: str(rb.userId, L, 'revBy.userId'), name: str(rb.name, L, 'revBy.name') } : null,
      subjectRemovedAt: int(raw.subjectRemovedAt, L, 'subjectRemovedAt'),
    };
    if (report && report.playerId !== record.playerId) fail(L, 'report.playerId', 'must name the trial\'s player');
    return { ok: true, record };
  } catch (e) { if (e instanceof Bad) return { ok: false, reason: e.message }; throw e; }
}

// ------------------------------------------------------------------ rows
const b = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
const flagOut = (v) => (v === null ? null : v === 1);
const actorRow = (p, a) => ({ [`${p}_kind`]: a?.kind ?? null, [`${p}_user_id`]: a?.kind === 'org' ? a.userId ?? null : null, [`${p}_actor_id`]: a && a.kind !== 'org' ? a.id ?? null : null, [`${p}_name`]: a?.name ?? null });
const actorOut = (row, p) => (row[`${p}_kind`] === null ? null : row[`${p}_user_id`] === null && row[`${p}_actor_id`] === null && row[`${p}_name`] === null ? { kind: row[`${p}_kind`] } : row[`${p}_kind`] === 'org' ? { kind: 'org', userId: row[`${p}_user_id`], name: row[`${p}_name`] } : { kind: row[`${p}_kind`], id: row[`${p}_actor_id`], name: row[`${p}_name`] });
const trialHistoryOut = (h) => ({ id: h.id, at: h.at, action: h.action, by: actorOut(h, 'by'), detail: h.detail_json === null ? null : JSON.parse(h.detail_json) });
const venueRow = (p, v) => ({ [`${p}_name`]: v?.name ?? null, [`${p}_town`]: v?.town ?? null, [`${p}_address`]: v?.address ?? null });
const venueOut = (row, p) => (row[`${p}_name`] === null ? null : { name: row[`${p}_name`], town: row[`${p}_town`], address: row[`${p}_address`] });
const sessionRow = (s) => ({ id: s.id, kind: s.kind, starts_at: s.startsAt, ends_at: s.endsAt, ...venueRow('venue', s.venue), instructions: s.instructions });
const sessionOut = (r) => ({ id: r.id, kind: r.kind, startsAt: r.starts_at, endsAt: r.ends_at, venue: venueOut(r, 'venue'), instructions: r.instructions });

const requestRow = (q) => ({
  id: q.id, player_id: q.playerId, player_name: q.playerName, org_id: q.orgId, org_name: q.orgName, org_type: q.orgType, org_verified: b(q.orgVerified), org_safeguarding_certified: b(q.orgSafeguardingCertified), org_trusted_partner: b(q.trustedPartner),
  user_id: q.userId, scout_name: q.scoutName, scout_role: q.scoutRole, type: q.type, message: q.message, subject: q.subject, contact_id: q.contactId,
  trial_proposed_date: q.trialDetails?.proposedDate ?? null, trial_alt_days_json: q.trialDetails ? JSON.stringify(q.trialDetails.altSlots) : null, trial_venue: q.trialDetails?.venue ?? null, trial_notes: q.trialDetails?.notes ?? null,
  trial_private_venue_address: q.trialDetails?.private?.venueAddress ?? null, trial_private_instructions: q.trialDetails?.private?.instructions ?? null,
  status: q.status, created_at: q.createdAt, responded_at: q.respondedAt, responded_by: q.respondedBy, routed_to: q.routedTo, guardian_id: q.guardianId, contact_channel_id: q.contactChannel,
  case_id: q.caseId, trial_id: q.trialId, recipient_type: q.recipient?.type ?? null, recipient_player_id: q.recipient?.playerId ?? null, recipient_guardian_id: q.recipient?.guardianId ?? null, recipient_minor: b(q.recipient?.minor),
  invite_key: q.keys.invite?.key ?? null, invite_fp: q.keys.invite?.fp ?? null, subject_removed_at: q.subjectRemovedAt,
});
const trialRow = (t) => ({
  id: t.id, request_id: t.requestId, case_id: t.caseId, player_id: t.playerId, player_name: t.playerName, org_id: t.orgId, org_name: t.orgName, scout_name: t.scoutName,
  accepted_at: t.acceptedAt, accepted_by: t.acceptedBy, guardian_approved: b(t.guardianApproved), proposed_date: t.proposedDate, venue: t.venue, notes: t.notes,
  report_due_at: t.reportDueAt, status: t.status, reminder_sent: b(t.reminderSent), feedback_escalated_at: t.feedbackEscalatedAt, workflow_state: t.workflowState,
  schedule_timezone: t.schedule?.timezone ?? null, schedule_revision: t.schedule?.revision ?? null, schedule_proposed_at: t.schedule?.proposedAt ?? null, ...actorRow('schedule_proposed_by', t.schedule?.proposedBy),
  schedule_confirmed_at: t.schedule?.confirmedAt ?? null, ...actorRow('schedule_confirmed_by', t.schedule?.confirmedBy), schedule_declined_at: t.schedule?.declinedAt ?? null, ...actorRow('schedule_declined_by', t.schedule?.declinedBy),
  completion_state: t.completion?.state ?? null, completion_at: t.completion?.at ?? null, ...actorRow('completion_by', t.completion?.by), completion_reason: t.completion?.reason ?? null, completion_phase: t.completion?.phase ?? null, completion_cancelled_by: t.completion?.cancelledBy ?? null,
  recipient_type: t.recipient?.type ?? null, recipient_player_id: t.recipient?.playerId ?? null, recipient_guardian_id: t.recipient?.guardianId ?? null, recipient_minor: b(t.recipient?.minor), recipient_at: t.recipient?.at ?? null,
  lifecycle_applied: b(t.lifecycle?.applied), lifecycle_from: t.lifecycle?.from ?? null, lifecycle_to: t.lifecycle?.to ?? null, lifecycle_reason: t.lifecycle?.reason ?? null, lifecycle_at: t.lifecycle?.at ?? null,
  day_arrival_time: t.day.arrival?.time ?? null, day_arrival_address: t.day.arrival?.address ?? null, day_arrival_notes: t.day.arrival?.notes ?? null,
  day_emergency_name: t.day.emergency?.name ?? null, day_emergency_phone: t.day.emergency?.phone ?? null, day_emergency_set_by: t.day.emergency?.setBy ?? null, day_emergency_at: t.day.emergency?.at ?? null, day_collection_policy: t.day.collection?.policy ?? null,
  rev: t.rev, rev_at: t.revAt, rev_by_user_id: t.revBy?.userId ?? null, rev_by_name: t.revBy?.name ?? null, subject_removed_at: t.subjectRemovedAt,
});
const SAMPLE_REQUEST = { id: 'x', playerId: 'p', playerName: null, orgId: 'o', orgName: 'o', orgType: null, orgVerified: false, orgSafeguardingCertified: false, trustedPartner: null, userId: 'u', scoutName: null, scoutRole: null, type: 'contact', message: null, subject: null, contactId: null, trialDetails: null, status: 'pending', createdAt: 0, respondedAt: null, respondedBy: null, routedTo: 'player', guardianId: null, contactChannel: null, caseId: null, trialId: null, recipient: null, keys: { invite: null }, subjectRemovedAt: null };
const SAMPLE_TRIAL = { id: 'x', requestId: 'r', caseId: null, playerId: 'p', playerName: null, orgId: 'o', orgName: 'o', scoutName: null, acceptedAt: 0, acceptedBy: null, guardianApproved: null, proposedDate: null, venue: null, notes: null, reportDueAt: null, status: 'awaiting_report', reminderSent: false, feedbackEscalatedAt: null, report: null, day: emptyTrialDay(), workflowState: 'accepted', schedule: null, attendance: [], completion: null, recipient: null, keys: {}, history: [], reminders: {}, lifecycle: null, rev: 1, revAt: null, revBy: null, subjectRemovedAt: null };
const COLS = {
  recruitment_requests: Object.keys(requestRow(SAMPLE_REQUEST)),
  request_trial_slots: ['request_id', 'position', 'id', 'day', 'kind', 'starts_at', 'ends_at', 'timezone', 'venue_name', 'venue_town', 'venue_address'],
  trials: Object.keys(trialRow(SAMPLE_TRIAL)),
  trial_schedule_sessions: ['trial_id', 'position', ...Object.keys(sessionRow({ venue: null }))],
  trial_session_evidence: ['trial_id', 'session_id', 'position', 'id', 'kind', 'box_session_id', 'linked_at', ...Object.keys(actorRow('linked_by', null)), 'removed_at', ...Object.keys(actorRow('removed_by', null))],
  trial_schedule_revisions: ['trial_id', 'position', 'revision', 'timezone', 'proposed_at', ...Object.keys(actorRow('proposed_by', null)), 'confirmed_at', ...Object.keys(actorRow('confirmed_by', null)), 'superseded_at', 'reason', 'material'],
  trial_revision_sessions: ['trial_id', 'revision', 'position', ...Object.keys(sessionRow({ venue: null }))],
  trial_attendance: ['trial_id', 'position', 'session_id', 'state', 'source', ...Object.keys(actorRow('recorded_by', null)), 'recorded_at', 'note'],
  trial_history: ['trial_id', 'position', 'id', 'at', 'action', ...Object.keys(actorRow('by', null)), 'detail_json'],
  trial_keys: ['trial_id', 'act', 'position', 'key', 'fp', 'at'],
  trial_reminders: ['trial_id', 'marker', 'sent_at'],
  trial_reports: ['trial_id', 'id', 'player_id', 'org_id', 'org_name', 'user_id', 'scout_name', 'filed_at', ...TRIAL_REPORT_FIELDS.map(snake), 'notes', 'strength_note', 'focus_note'],
  trial_day_staff: ['trial_id', 'position', 'id', 'name', 'role', 'check_kind', 'check_ref', 'check_status', 'check_expires_at', 'check_reviewed_by', 'check_reviewed_at', 'added_by_name', 'added_at'],
  trial_day_consents: ['trial_id', 'position', 'id', ...Object.keys(actorRow('by', null)), 'scope', 'at'],
  trial_day_checkins: ['trial_id', 'position', 'player_id', 'at', 'by_user_id', 'by_name'],
  trial_day_status_events: ['trial_id', 'position', 'kind', 'at', 'by_name', 'reason', 'new_date'],
};
/** The trial's child tables, in delete order (a grandchild before its parent). */
const TRIAL_CHILDREN = ['trial_session_evidence', 'trial_schedule_sessions', 'trial_revision_sessions', 'trial_schedule_revisions', 'trial_attendance', 'trial_history', 'trial_keys', 'trial_reminders', 'trial_reports', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events'];

// ------------------------------------------------------------------ statements and the record readers
/** A trial's child rows in list order; reminders in insertion order, and a trial has at most one report. */
const TRIAL_CHILD_ORDER = (t) => (t === 'trial_reminders' || t === 'trial_reports' ? 'rowid' : 'position');
const stmtCache = new WeakMap();
function statements(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insert = (table, { upsert = false } = {}) => {
    const cols = COLS[table];
    const tail = upsert ? ` ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}` : '';
    return sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})${tail}`);
  };
  const childOf = (t) => sqlite.prepare(`SELECT * FROM ${t} WHERE trial_id = ? ORDER BY ${TRIAL_CHILD_ORDER(t)}`);
  s = {
    ins: Object.fromEntries(Object.keys(COLS).map((t) => [t, insert(t, { upsert: t === 'recruitment_requests' || t === 'trials' })])),
    slotsDel: sqlite.prepare('DELETE FROM request_trial_slots WHERE request_id = ?'),
    trialChildrenDel: TRIAL_CHILDREN.map((t) => sqlite.prepare(`DELETE FROM ${t} WHERE trial_id = ?`)),
    requestDel: sqlite.prepare('DELETE FROM recruitment_requests WHERE id = ?'), trialDel: sqlite.prepare('DELETE FROM trials WHERE id = ?'),
    requestById: sqlite.prepare('SELECT * FROM recruitment_requests WHERE id = ?'), requestAll: sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY rowid'),
    trialById: sqlite.prepare('SELECT * FROM trials WHERE id = ?'), trialAll: sqlite.prepare('SELECT * FROM trials ORDER BY rowid'),
    slotsOf: sqlite.prepare('SELECT * FROM request_trial_slots WHERE request_id = ? ORDER BY position'),
    of: Object.fromEntries(['trial_schedule_sessions', 'trial_schedule_revisions', 'trial_attendance', 'trial_history', 'trial_reminders', 'trial_reports', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events'].map((t) => [t, childOf(t)])),
    evidenceOf: sqlite.prepare('SELECT * FROM trial_session_evidence WHERE trial_id = ? AND session_id = ? ORDER BY position'),
    revisionSessionsOf: sqlite.prepare('SELECT * FROM trial_revision_sessions WHERE trial_id = ? AND revision = ? ORDER BY position'),
    keysOf: sqlite.prepare('SELECT * FROM trial_keys WHERE trial_id = ? ORDER BY act, position'),
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'),
    caseExists: sqlite.prepare('SELECT 1 FROM recruitment_cases WHERE id = ?'),
    ids: (table) => sqlite.prepare(`SELECT id FROM ${table} ORDER BY rowid`).all().map((r) => r.id),
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

/** The case a request or a trial names is written first (an immediate key): a miss is named with the ids. */
function caseMustExist(st, table, r) {
  if (r.caseId !== null && !st.caseExists.get(r.caseId)) throw refusal('RECRUITMENT_CASE_MISSING', `${table} holds 1 row naming a recruitment_cases row that is not there (${r.id} → recruitment_cases ${r.caseId}); the write was rolled back`);
}
/** Write a typed request whole: the row upserted (its rowid, and so its insertion order, kept), the slots replaced. */
function writeRequest(st, q) {
  caseMustExist(st, 'recruitment_requests', q);
  st.ins.recruitment_requests.run(requestRow(q));
  st.slotsDel.run(q.id);
  (q.trialDetails?.slots ?? []).forEach((s, i) => st.ins.request_trial_slots.run({ request_id: q.id, position: i, id: s.id, day: s.day, kind: s.kind, starts_at: s.startsAt, ends_at: s.endsAt, timezone: s.timezone, ...venueRow('venue', s.venue) }));
}
/** Write a typed trial whole: the row upserted, every child row replaced in list order. */
function writeTrial(st, t) {
  caseMustExist(st, 'trials', t);
  st.ins.trials.run(trialRow(t));
  for (const d of st.trialChildrenDel) d.run(t.id);
  const I = st.ins;
  (t.schedule?.sessions ?? []).forEach((s, i) => {
    I.trial_schedule_sessions.run({ trial_id: t.id, position: i, ...sessionRow(s) });
    s.evidence.forEach((e, j) => I.trial_session_evidence.run({ trial_id: t.id, session_id: s.id, position: j, id: e.id, kind: e.kind, box_session_id: e.sessionId, linked_at: e.linkedAt, ...actorRow('linked_by', e.linkedBy), removed_at: e.removedAt, ...actorRow('removed_by', e.removedBy) }));
  });
  (t.schedule?.revisions ?? []).forEach((r, i) => {
    I.trial_schedule_revisions.run({ trial_id: t.id, position: i, revision: r.revision, timezone: r.timezone, proposed_at: r.proposedAt, ...actorRow('proposed_by', r.proposedBy), confirmed_at: r.confirmedAt, ...actorRow('confirmed_by', r.confirmedBy), superseded_at: r.supersededAt, reason: r.reason, material: b(r.material) });
    r.sessions.forEach((s, j) => I.trial_revision_sessions.run({ trial_id: t.id, revision: r.revision, position: j, ...sessionRow(s) }));
  });
  t.attendance.forEach((a, i) => I.trial_attendance.run({ trial_id: t.id, position: i, session_id: a.sessionId, state: a.state, source: a.source, ...actorRow('recorded_by', a.recordedBy), recorded_at: a.recordedAt, note: a.note }));
  t.history.forEach((h, i) => I.trial_history.run({ trial_id: t.id, position: i, id: h.id, at: h.at, action: h.action, ...actorRow('by', h.by), detail_json: h.detail === null ? null : JSON.stringify(h.detail) }));
  for (const act of TRIAL_KEY_ACTS) t.keys[act].forEach((e, i) => I.trial_keys.run({ trial_id: t.id, act, position: i, key: e.key, fp: e.fp, at: e.at }));
  for (const [marker, at] of Object.entries(t.reminders)) I.trial_reminders.run({ trial_id: t.id, marker, sent_at: at });
  if (t.report) { const r = t.report; I.trial_reports.run({ trial_id: t.id, id: r.id, player_id: r.playerId, org_id: r.orgId, org_name: r.orgName, user_id: r.userId, scout_name: r.scoutName, filed_at: r.filedAt, ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [snake(f), r[f]])), notes: r.notes, strength_note: r.strengthNote, focus_note: r.focusNote }); }
  t.day.staff.forEach((s, i) => I.trial_day_staff.run({ trial_id: t.id, position: i, id: s.id, name: s.name, role: s.role, check_kind: s.check?.kind ?? null, check_ref: s.check?.ref ?? null, check_status: s.check?.status ?? null, check_expires_at: s.check?.expiresAt ?? null, check_reviewed_by: s.check?.reviewedBy ?? null, check_reviewed_at: s.check?.reviewedAt ?? null, added_by_name: s.addedBy, added_at: s.addedAt }));
  t.day.consents.forEach((c, i) => I.trial_day_consents.run({ trial_id: t.id, position: i, id: c.id, ...actorRow('by', c.by), scope: c.scope, at: c.at }));
  t.day.checkins.forEach((c, i) => I.trial_day_checkins.run({ trial_id: t.id, position: i, player_id: c.playerId, at: c.at, by_user_id: c.byUserId, by_name: c.byName }));
  t.day.statusEvents.forEach((e, i) => I.trial_day_status_events.run({ trial_id: t.id, position: i, kind: e.kind, at: e.at, by_name: e.by, reason: e.reason, new_date: e.newDate }));
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
    report: rep ? { id: rep.id, trialId: row.id, playerId: rep.player_id, orgId: rep.org_id, orgName: rep.org_name, userId: rep.user_id, scoutName: rep.scout_name, filedAt: rep.filed_at, ...Object.fromEntries(TRIAL_REPORT_FIELDS.map((f) => [f, rep[snake(f)]])), notes: rep.notes, strengthNote: rep.strength_note, focusNote: rep.focus_note } : null,
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
/** Every guardian id a typed record names. */
const guardianIdsOf = (name, r) => (name === 'requests' ? [r.guardianId, r.recipient?.guardianId ?? null] : [r.recipient?.guardianId ?? null]).filter((g) => g !== null);


// ------------------------------------------------------------------ the whole-domain read
const TYPERS = { requests: typeRequest, trials: typeTrial };
const TABLE_OF = { requests: 'recruitment_requests', trials: 'trials' };
export const RECRUITMENT_RECORDS = {
  names: RECRUITMENT_COLLECTIONS,
  read(sqlite) { if (!recruitmentLive(sqlite)) return null; return { requests: readRequests(sqlite), trials: readTrials(sqlite) }; },
};

// ------------------------------------------------------------------ the repository
const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
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
  const rowById = { requests: st.requestById, trials: st.trialById };
  const read = (name, id) => { if (typeof id !== 'string') return null; const row = rowById[name].get(id); return row ? decode[name](row) : null; };
  const must = (name, id) => { const r = read(name, id); if (!r) throw refusal('RECRUITMENT_NOT_FOUND', `${name} ${id} is not a record of the repository`); return r; };
  const list = (name, sql) => { const stmt = sqlite.prepare(sql); return (...args) => decodeAll(name, stmt.all(...args)); };
  const inList = (name, table, col) => (values) => { const want = [...new Set((values ?? []).filter((v) => typeof v === 'string'))]; if (!want.length) return []; return decodeAll(name, sqlite.prepare(`SELECT * FROM ${table} WHERE ${col} IN (${want.map(() => '?').join(',')}) ORDER BY rowid`).all(...want)); };
  const count = (sql) => { const stmt = sqlite.prepare(sql); return (...args) => stmt.get(...args).n; };
  /**
   * Newest first by cursor (domains/platform/paging.mjs): `where` takes `args`, the key is the rowid (insertion order;
   * an update is an upsert, so it never moves a row). `after` comes from readPage(query, ['number']).
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
  const typedOr = (name, raw) => { const t = TYPERS[name](raw, name); if (!t.ok) throw refusal('RECRUITMENT_INPUT_INVALID', t.reason); return t.record; };
  const IMMUTABLE = { requests: ['id', 'playerId', 'orgId', 'userId', 'type', 'createdAt'], trials: ['id', 'requestId', 'playerId', 'orgId', 'acceptedAt'] };
  const guardiansExist = (name, r) => { const missing = guardianIdsOf(name, r).filter((g) => !st.guardian.get(g)); if (missing.length) throw refusal('RECRUITMENT_GUARDIAN_MISSING', `${TABLE_OF[name]} ${r.id} names a guardian that does not exist (${ids(missing)})`); };
  // A trial's filed report counts in its player's profile figure, refreshed with the write.
  const write = (name, record) => { guardiansExist(name, record); if (name === 'requests') writeRequest(st, record); else { writeTrial(st, record); refreshProfileSignals(sqlite, [record.playerId]); } };

  /** `create(record)`: a new record, typed whole; an existing id is refused. */
  const create = (name) => (raw) => operation(() => {
    const r = typedOr(name, raw);
    if (rowById[name].get(r.id)) throw refusal('RECRUITMENT_DUPLICATE', `${TABLE_OF[name]} ${r.id} already exists`);
    write(name, r); return must(name, r.id);
  });
  /**
   * `update(id, change)`: `change` receives a plain copy of the stored record and edits it (or returns a replacement);
   * the result is typed whole and written at once. The identifiers and the creation instant cannot change.
   */
  const update = (name) => (id, change) => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${name}.update(id, change) needs a function that edits the copy it is given`);
    const before = must(name, id);
    const draft = clone(before);
    const returned = change(draft);
    const next = typedOr(name, returned === undefined ? draft : returned);
    for (const k of IMMUTABLE[name]) if (next[k] !== before[k]) throw refusal('RECRUITMENT_INPUT_INVALID', `${TABLE_OF[name]} ${id}: ${k} cannot change`);
    write(name, next); return must(name, id);
  });

  const pageOfRequestsBy = new Map();
  const pageOfRequests = (args, where, page) => {
    if (!pageOfRequestsBy.has(where)) pageOfRequestsBy.set(where, newestFirst('requests', 'recruitment_requests', () => where));
    return pageOfRequestsBy.get(where)(args, page);
  };
  const pageOfTrials = newestFirst('trials', 'trials', () => 'org_id = ?');
  const trialHistoryFrom = (orgId, actions) => ({ from: 'trial_history h JOIN trials t ON t.id = h.trial_id', where: `t.org_id = ? AND h.action IN (${actions.map(() => '?').join(', ') || 'NULL'})`, params: [orgId, ...actions] });
  const requests = {
    create: create('requests'), update: update('requests'),
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
    create: create('trials'), update: update('trials'),
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
  const WRITES = new Set(['create', 'update']);
  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const counters = { requests: sqlite.prepare('SELECT COUNT(*) AS n FROM recruitment_requests'), trials: sqlite.prepare('SELECT COUNT(*) AS n FROM trials'), trialReports: sqlite.prepare('SELECT COUNT(*) AS n FROM trial_reports') };

  return {
    requests, trials,
    /** The queries alone, for the pure projectors and providers that must not write. */
    reads: Object.freeze({ requests: readOnly(requests), trials: readOnly(trials) }),
    /**
     * The deletion unit: every request and trial of the player becomes the tombstone the callbacks build
     * from a plain copy (ids, states and times kept; the person-shaped fields gone), written at once.
     */
    tombstoneForPlayer(playerId, { request, trial }) {
      return operation(() => {
        let n = 0; let m = 0;
        for (const { id } of sqlite.prepare('SELECT id FROM recruitment_requests WHERE player_id = ? ORDER BY rowid').all(playerId)) { update('requests')(id, (d) => request(d)); n += 1; }
        for (const { id } of sqlite.prepare('SELECT id FROM trials WHERE player_id = ? ORDER BY rowid').all(playerId)) { update('trials')(id, (d) => trial(d)); m += 1; }
        return { requests: n, trials: m };
      });
    },
    /** The derived `players[].trialReports`: the reports filed on the player's trials, in filing order. */
    trialReportsFor(playerId) {
      return trials.forPlayer(playerId).filter((t) => t.report).map((t) => t.report).sort((a, b) => a.filedAt - b.filedAt);
    },
    /** The trial reports of many players at once (one query): Map player id → reports in filing order. */
    trialReportsForPlayers(playerIds) {
      const out = new Map();
      for (const t of trials.forPlayers(playerIds)) if (t.report) { if (!out.has(t.playerId)) out.set(t.playerId, []); out.get(t.playerId).push(t.report); }
      for (const list of out.values()) list.sort((a, b) => a.filedAt - b.filedAt);
      return out;
    },
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
