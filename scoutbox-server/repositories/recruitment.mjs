/**
 * Recruitment requests and accepted trials — migration plan step S8a-core
 * (docs/architecture/sqlite-migration-plan.md §D.7 as corrected after the independent
 * reviews of a6c40f3, cd7dc95 and f2121b5 and accepted at d0f0205; approved by the
 * Founder's three explicit decisions of 22 October 2026: Q7a tolerant player
 * references, Q7b strict case references in code until S8b, Q7c strict guardian
 * references in code without the drafted SET NULL key).
 *
 * Owns fifteen tables (and, since migration 0015, the `channels` definition carrying
 * the REAL `request_id` foreign key — the conversion D-A promised) and two read-only
 * collection views:
 *
 *   recruitment_requests, request_trial_slots                    → db.requests
 *   trials, trial_schedule_sessions, trial_session_evidence,
 *   trial_schedule_revisions, trial_attendance, trial_reminders,
 *   trial_day_staff, trial_day_consents, trial_day_checkins,
 *   trial_day_status_events, trial_reports, trial_history          → db.trials
 *   idempotency_keys (the `keys` of both)
 *
 * WHAT THE ROWS ARE. `db.requests` and `db.trials` were JSON blobs every build since
 * M9 wrote and mutated IN PLACE from twenty-five modules: the writers' literals
 * (server.mjs issueRecruitmentRequest, the open-day outcome route, issueAcceptedTrial,
 * the report route, tombstoneRequest/tombstoneTrial; m23/trialRoutes.mjs the P4B
 * invitation and the schedule/cancel/attendance/complete/evidence/recipient routes;
 * m12/journeys.mjs the day containers; m12/operations.mjs the reminder markers) and
 * dozens of field assignments and nested pushes. This step keeps that contract: the
 * two views are read-only ARRAYS (push/splice/assignment refused) whose elements are
 * the plain, mutable records the routes hold, and every change a route makes in
 * place — a status, a schedule, a pushed attendance row, a day container, a report —
 * is detected and written by the next save's `flush` (the organisations' facet
 * contract since S3), so each row lands in exactly the save that carried its blob
 * before: the invitation in issueRecruitmentRequest's persistNow(), the answer,
 * the thread and the trial in the respond route's one save (P4A-D15), the report
 * in its route's save, a day change in its route's save. New records enter through
 * `addRequest` / `addTrial` (the three former `push` sites) and the deletion unit's
 * tombstones through `tombstoneForPlayer` (the two former array replacements).
 *
 * LOSSLESS, AT EVERY LEVEL (plan §D.7.3, D3). Every record is mapped by a shape: the
 * literal's keys in the writer's order, each scalar to its column, each known nested
 * object (trialDetails, trialDetails.private, recipient, schedule, schedule.proposedBy,
 * completion, completion.by, lifecycle, revBy, day, day.arrival, day.emergency,
 * day.collection, …) to columns of the same row, each list to a child table in list
 * order (`position`), each map (`reminders`, `keys`) to its table. A known key that is
 * ABSENT is listed in `absent_keys_json` (dotted for nested keys) and comes back
 * absent; a present `null` is a NULL column and comes back null; a present value the
 * column cannot hold (a string where an integer belongs, `null` where an object
 * belongs, a non-array where a list belongs) is kept verbatim in `offtype_json` under
 * its path and comes back as it was; every unknown own key at any level is kept in
 * `extra_json` (nested extras under their known parent key) and spread back first.
 * `blockedBy` (read by trialClubView, carried by tombstoneTrial) is a column;
 * `trials.keys.accept {key: null, fp}` cannot be an idempotency row (a null key) and
 * is kept as the value it is; the tombstone's present-and-null
 * `trialDetails.instructions` is a column; the `day` container's presence is
 * recorded; `recipient.playerId` is stored (and counted when it differs from the
 * row's player). A live `undefined` is absence and a non-finite number persists as
 * JSON null — the blob's own rules. No vocabulary or length CHECK is applied to a
 * value the writers validate (a storage-only step changes no product behaviour);
 * the NOT NULL columns are the identifiers the FKs need.
 *
 * REFERENCES — THE APPROVED SCOPE:
 *   player_id (both tables)   NO key, TOLERANT (Q7a): a live id resolves, a retained id
 *                             resolves to the retained record, a historically missing
 *                             id is preserved and counted — never refused, never given
 *                             a fabricated account, never deleted.
 *   case_id (both tables)     NO key yet (S8b creates recruitment_cases): STRICT in code
 *                             (Q7b) — a write or import naming a case that is not in the
 *                             retained `recruitmentCases` collection is refused with ids
 *                             only; every save asserts the FINAL state.
 *   guardian_id, recipient_guardian_id (requests), recipient_guardian_id (trials)
 *                             NO key (the drafted SET NULL would fire at every identity
 *                             rewrite): STRICT in code (Q7c) — refused when the guardian
 *                             does not exist; the FINAL state asserted on every save.
 *   trials.request_id         NOT NULL UNIQUE REFERENCES recruitment_requests RESTRICT.
 *   recruitment_requests.trial_id   REFERENCES trials ON DELETE SET NULL.
 *   org_id / user_id          REFERENCES orgs / org_users RESTRICT (the parent-preserving
 *                             upsert-and-prune tables).
 *   channels.request_id       REFERENCES recruitment_requests RESTRICT (rebuilt by 0015).
 *   the child tables          CASCADE from their owner; trial_reports and trial_history
 *                             RESTRICT (deleted explicitly, first, on a departure).
 *   recruitment_requests_one_pending  WITHDRAWN (D2): the direct route keeps its
 *                             code-level REQUEST_PENDING answer; the open-day outcome
 *                             route keeps its several pending invitations.
 *
 * THE WRITE (plan §D.7.5, six phases, constraints IMMEDIATE, no deferral), the same
 * for a flush, a whole snapshot, the cutover import and a restore:
 *   1. requests upserted, the back-reference PARKED (NULL on insert; a survivor keeps
 *      its stored trial_id only when it equals the final one); slots and keys rewritten;
 *   2. trials: (a) DEPARTURES — rows no longer listed or whose request_id changes — their
 *      RESTRICT children deleted first, then the row; (b) RELEASES — a survivor leaving
 *      its trials_one_open_per_case slot (terminal state, another case, no case) has
 *      case_id PARKED to NULL by a parent-preserving update, never deleted, before any
 *      arrival; (c) upserts with the final case/state, children rewritten in list order;
 *   3. the supplied requests' final trial_id assigned (the trial exists now);
 *   4. channels (its own replace; its key is real now);
 *   5. requests no longer listed pruned (CASCADE takes the slots; a request still named
 *      by a trial or a thread refuses the save — an intentional removal removes its
 *      dependants in the same snapshot);
 *   6. the FINAL-state assertions: the pair (a request naming a trial is named back by
 *      it; a trial's request names it, or carries NO trialId key at all — the pre-P4B
 *      legacy pair, counted, never fabricated), every case id in the final
 *      recruitmentCases, every guardian id in the final guardians table.
 * A case-only change with `requests` omitted persists exactly what the same change
 * with the unchanged requests persists; no link is ever reconstructed from a trial.
 *
 * TWO FAILURE CONTRACTS (the store's, unchanged): a failed ORDINARY save leaves the
 * records as they are — memory is the intended state — and the next save lands them
 * once (change tracking reflects COMMITTED state only); an aborted UNIT OF WORK rolls
 * the tables back AND restores the whole mirror in place through the graph memento
 * (every record, nested object and array by identity: a held `trial.schedule` reads
 * the pre-unit value), the pending edits made before the unit still pending.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0015_recruitment` in `data_migrations`, never by the tables existing. Refusals
 * (RECRUITMENT_IMPORT_BLOCKED and the reference codes) name collections, positions,
 * ids and reasons — never a name, a message, an address or a note.
 */
import { readonlyView, markView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { cloneJson } from './outboxPush.mjs';
import { readTrialsBlob, trialReportsFor as trialReportsOf } from './playerSubrecords.mjs';

export const RECRUITMENT_MIGRATION = '0015_recruitment';
/** `meta` key holding the cutover record: counts only, never data. */
export const RECRUITMENT_CUTOVER_META = 'recruitmentCutover';
export const RECRUITMENT_COLLECTIONS = Object.freeze(['requests', 'trials']);
/** The collections the strict references resolve against and the identity table they are checked in. */
export const CASES_COLLECTION = 'recruitmentCases';

const EXTRA_CHECK = (col) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'object'))`;
const ABSENT_CHECK = "CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array'))";
const JSON_CHECK = (col) => `CHECK (${col} IS NULL OR json_valid(${col}))`;

export const recruitmentLive = (sqlite) => migrationApplied(sqlite, RECRUITMENT_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`RECRUITMENT_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'RECRUITMENT_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
/** The blob's JSON rules: a non-finite number is kept live (persisted as null), a nested undefined is stored as JSON.stringify stored it. */
const JSON_RULES = Object.freeze({ nonFinite: 'keep', undefinedNested: 'json' });
const clone = (v, at) => cloneJson(v, at, JSON_RULES);
const parseJson = (text, at) => clone(JSON.parse(text), at).value;
const ids = (list) => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');
const jsonOrNull = (obj) => (Object.keys(obj).length ? JSON.stringify(obj) : null);
const TERMINAL = Object.freeze(['completed', 'cancelled']);
const inSlot = (caseId, state) => typeof caseId === 'string' && !TERMINAL.includes(state);

// ------------------------------------------------------------------ the shapes (the writers' literals, key for key)
// kinds: text (string) | int (safe integer) | num (finite number) | bool | json (any JSON value) | id (non-empty string)
const by3 = (cols) => ({ keys: ['kind', 'userId', 'id', 'name'], cols: { kind: [cols[0], 'text'], userId: [cols[1], 'text'], id: [cols[2], 'text'], name: [cols[3], 'text'] } });
const VENUE = (p) => ({ keys: ['name', 'town', 'address'], cols: { name: [`${p}_name`, 'text'], town: [`${p}_town`, 'text'], address: [`${p}_address`, 'text'] } });

const SLOT = { table: 'request_trial_slots', ownerCols: ['request_id'], shape: { keys: ['id', 'day', 'kind', 'startsAt', 'endsAt', 'timezone', 'venue'], cols: { id: ['id', 'text'], day: ['day', 'text'], kind: ['kind', 'text'], startsAt: ['starts_at', 'int'], endsAt: ['ends_at', 'int'], timezone: ['timezone', 'text'] }, objects: { venue: VENUE('venue') } }, indexes: ['CREATE INDEX request_trial_slots_id ON request_trial_slots (id)', 'CREATE UNIQUE INDEX request_trial_slots_one_per_day ON request_trial_slots (request_id, day) WHERE day IS NOT NULL'] }; // one slot per day per invitation (validateInvitation, trialRoutes.mjs; plan §D.7.3)
const KEYS_REQUESTS = { table: 'idempotency_keys', ownerTable: 'recruitment_requests' };
const KEYS_TRIALS = { table: 'idempotency_keys', ownerTable: 'trials' };
const REQUEST_SHAPE = {
  keys: ['id', 'playerId', 'playerName', 'orgId', 'orgName', 'orgType', 'orgVerified', 'orgSafeguardingCertified', 'trustedPartner', 'userId', 'scoutName', 'scoutRole', 'type', 'message', 'subject', 'contactId', 'trialDetails', 'status', 'createdAt', 'respondedAt', 'respondedBy', 'routedTo', 'guardianId', 'contactChannel', 'caseId', 'trialId', 'recipient', 'keys', 'subjectRemovedAt'],
  cols: { id: ['id', 'id'], playerId: ['player_id', 'text'], playerName: ['player_name', 'text'], orgId: ['org_id', 'text'], orgName: ['org_name', 'text'], orgType: ['org_type', 'text'], orgVerified: ['org_verified', 'bool'], orgSafeguardingCertified: ['org_safeguarding_certified', 'bool'], trustedPartner: ['org_trusted_partner', 'bool'], userId: ['user_id', 'text'], scoutName: ['scout_name', 'text'], scoutRole: ['scout_role', 'text'], type: ['type', 'text'], message: ['message', 'text'], subject: ['subject', 'text'], contactId: ['contact_id', 'text'], status: ['status', 'text'], createdAt: ['created_at', 'int'], respondedAt: ['responded_at', 'int'], respondedBy: ['responded_by', 'text'], routedTo: ['routed_to', 'text'], guardianId: ['guardian_id', 'text'], contactChannel: ['contact_channel_id', 'text'], caseId: ['case_id', 'text'], trialId: ['trial_id', 'text'], subjectRemovedAt: ['subject_removed_at', 'int'] },
  objects: {
    trialDetails: { keys: ['proposedDate', 'altSlots', 'venue', 'notes', 'slots', 'private', 'instructions'], cols: { proposedDate: ['trial_proposed_date', 'text'], altSlots: ['trial_alt_slots_json', 'json'], venue: ['trial_venue', 'text'], notes: ['trial_notes', 'text'], instructions: ['trial_instructions', 'text'] }, lists: { slots: SLOT }, objects: { private: { keys: ['venueAddress', 'instructions'], cols: { venueAddress: ['trial_private_venue_address', 'text'], instructions: ['trial_private_instructions', 'text'] } } } },
    recipient: { keys: ['type', 'playerId', 'guardianId', 'minor'], cols: { type: ['recipient_type', 'text'], playerId: ['recipient_player_id', 'text'], guardianId: ['recipient_guardian_id', 'text'], minor: ['recipient_minor', 'bool'] } },
  },
  maps: { keys: KEYS_REQUESTS },
};
const EVIDENCE = { table: 'trial_session_evidence', ownerCols: ['trial_id', 'session_position'], shape: { keys: ['id', 'kind', 'sessionId', 'linkedAt', 'linkedBy', 'removedAt', 'removedBy'], cols: { id: ['id', 'text'], kind: ['kind', 'text'], sessionId: ['box_session_id', 'text'], linkedAt: ['linked_at', 'int'], removedAt: ['removed_at', 'int'] }, objects: { linkedBy: by3(['linked_by_kind', 'linked_by_user_id', 'linked_by_id', 'linked_by_name']), removedBy: by3(['removed_by_kind', 'removed_by_user_id', 'removed_by_id', 'removed_by_name']) } }, indexes: ['CREATE INDEX trial_session_evidence_box_session ON trial_session_evidence (box_session_id)', 'CREATE UNIQUE INDEX trial_session_evidence_one_active ON trial_session_evidence (trial_id, session_position, box_session_id) WHERE removed_at IS NULL AND box_session_id IS NOT NULL'] }; // one ACTIVE link per (session, box session): D-12, trialRoutes.mjs (linking twice is a replay); plan §D.7.3
const SESSION = { table: 'trial_schedule_sessions', ownerCols: ['trial_id'], shape: { keys: ['id', 'kind', 'startsAt', 'endsAt', 'venue', 'instructions', 'evidence'], cols: { id: ['id', 'text'], kind: ['kind', 'text'], startsAt: ['starts_at', 'int'], endsAt: ['ends_at', 'int'], instructions: ['instructions', 'text'] }, objects: { venue: VENUE('venue') }, lists: { evidence: EVIDENCE } }, indexes: ['CREATE INDEX trial_schedule_sessions_id ON trial_schedule_sessions (id)', 'CREATE INDEX trial_schedule_sessions_trial_starts ON trial_schedule_sessions (trial_id, starts_at)'] };
const REVISION = { table: 'trial_schedule_revisions', ownerCols: ['trial_id'], shape: { keys: ['revision', 'timezone', 'sessions', 'proposedAt', 'proposedBy', 'confirmedAt', 'confirmedBy', 'supersededAt', 'reason', 'material'], cols: { revision: ['revision', 'int'], timezone: ['timezone', 'text'], sessions: ['sessions_json', 'json'], proposedAt: ['proposed_at', 'int'], confirmedAt: ['confirmed_at', 'int'], supersededAt: ['superseded_at', 'int'], reason: ['reason', 'text'], material: ['material', 'bool'] }, objects: { proposedBy: by3(['proposed_by_kind', 'proposed_by_user_id', 'proposed_by_id', 'proposed_by_name']), confirmedBy: by3(['confirmed_by_kind', 'confirmed_by_user_id', 'confirmed_by_id', 'confirmed_by_name']) } } };
const ATTENDANCE = { table: 'trial_attendance', ownerCols: ['trial_id'], shape: { keys: ['sessionId', 'state', 'source', 'recordedBy', 'recordedAt', 'note'], cols: { sessionId: ['session_id', 'text'], state: ['state', 'text'], source: ['source', 'text'], recordedAt: ['recorded_at', 'int'], note: ['note', 'text'] }, objects: { recordedBy: by3(['recorded_by_kind', 'recorded_by_user_id', 'recorded_by_id', 'recorded_by_name']) } }, indexes: ['CREATE INDEX trial_attendance_trial_session_at ON trial_attendance (trial_id, session_id, recorded_at)'] };
const HISTORY = { table: 'trial_history', ownerCols: ['trial_id'], restrict: true, shape: { keys: ['id', 'at', 'action', 'by', 'detail'], cols: { id: ['id', 'text'], at: ['at', 'int'], action: ['action', 'text'], detail: ['detail_json', 'json'] }, objects: { by: by3(['by_kind', 'by_user_id', 'by_id', 'by_name']) } }, indexes: ['CREATE INDEX trial_history_trial_at ON trial_history (trial_id, at)', 'CREATE INDEX trial_history_id ON trial_history (id)'] };
const STAFF = { table: 'trial_day_staff', ownerCols: ['trial_id'], shape: { keys: ['id', 'name', 'role', 'check', 'addedBy', 'addedAt'], cols: { id: ['id', 'text'], name: ['name', 'text'], role: ['role', 'text'], addedBy: ['added_by_name', 'text'], addedAt: ['added_at', 'int'] }, objects: { check: { keys: ['kind', 'ref', 'status', 'expiresAt', 'reviewedBy', 'reviewedAt'], cols: { kind: ['check_kind', 'text'], ref: ['check_ref', 'text'], status: ['check_status', 'text'], expiresAt: ['check_expires_raw', 'text'], reviewedBy: ['check_reviewed_by_name', 'text'], reviewedAt: ['check_reviewed_at', 'int'] } } } } };
const CONSENT = { table: 'trial_day_consents', ownerCols: ['trial_id'], shape: { keys: ['id', 'by', 'scope', 'at'], cols: { id: ['id', 'text'], scope: ['scope', 'text'], at: ['at', 'int'] }, objects: { by: by3(['by_kind', 'by_user_id', 'by_id', 'by_name']) } }, indexes: ['CREATE UNIQUE INDEX trial_day_consents_one_per_actor ON trial_day_consents (trial_id, scope, by_id) WHERE by_id IS NOT NULL AND scope IS NOT NULL'] };
const CHECKIN = { table: 'trial_day_checkins', ownerCols: ['trial_id'], shape: { keys: ['playerId', 'at', 'byUserId', 'byName'], cols: { playerId: ['player_id', 'text'], at: ['at', 'int'], byUserId: ['by_user_id', 'text'], byName: ['by_name', 'text'] } } };
const STATUS_EVENT = { table: 'trial_day_status_events', ownerCols: ['trial_id'], shape: { keys: ['kind', 'at', 'by', 'reason', 'newDate'], cols: { kind: ['kind', 'text'], at: ['at', 'int'], by: ['by_name', 'text'], reason: ['reason', 'text'], newDate: ['new_date', 'text'] } }, indexes: ['CREATE INDEX trial_day_status_events_trial_at ON trial_day_status_events (trial_id, at)'] };
const REPORT = { table: 'trial_reports', ownerCols: ['trial_id'], single: true, restrict: true, shape: { keys: ['id', 'trialId', 'playerId', 'orgId', 'orgName', 'userId', 'scoutName', 'filedAt', 'acceleration', 'sprintSpeedKmh', 'distanceKm', 'passCompletionPct', 'duelSuccessPct', 'coachRating', 'notes', 'strengthNote', 'focusNote'], cols: { id: ['id', 'text'], trialId: ['report_trial_id', 'text'], playerId: ['player_id', 'text'], orgId: ['org_id', 'text'], orgName: ['org_name', 'text'], userId: ['user_id', 'text'], scoutName: ['scout_name', 'text'], filedAt: ['filed_at', 'int'], acceleration: ['acceleration', 'num'], sprintSpeedKmh: ['sprint_speed_kmh', 'num'], distanceKm: ['distance_km', 'num'], passCompletionPct: ['pass_completion_pct', 'num'], duelSuccessPct: ['duel_success_pct', 'num'], coachRating: ['coach_rating', 'num'], notes: ['notes', 'text'], strengthNote: ['strength_note', 'text'], focusNote: ['focus_note', 'text'] } }, indexes: ['CREATE INDEX trial_reports_player ON trial_reports (player_id)', 'CREATE INDEX trial_reports_org ON trial_reports (org_id, filed_at)', 'CREATE INDEX trial_reports_id ON trial_reports (id)'] };
const REMINDERS = { table: 'trial_reminders', ownerCols: ['trial_id'], map: true };
const TRIAL_SHAPE = {
  keys: ['id', 'requestId', 'caseId', 'playerId', 'playerName', 'orgId', 'orgName', 'scoutName', 'acceptedAt', 'acceptedBy', 'guardianApproved', 'proposedDate', 'venue', 'notes', 'reportDueAt', 'status', 'reminderSent', 'feedbackEscalatedAt', 'report', 'day', 'workflowState', 'schedule', 'attendance', 'completion', 'recipient', 'keys', 'history', 'reminders', 'lifecycle', 'rev', 'revAt', 'revBy', 'blockedBy', 'subjectRemovedAt'],
  cols: { id: ['id', 'id'], requestId: ['request_id', 'text'], caseId: ['case_id', 'text'], playerId: ['player_id', 'text'], playerName: ['player_name', 'text'], orgId: ['org_id', 'text'], orgName: ['org_name', 'text'], scoutName: ['scout_name', 'text'], acceptedAt: ['accepted_at', 'int'], acceptedBy: ['accepted_by', 'text'], guardianApproved: ['guardian_approved', 'bool'], proposedDate: ['proposed_date', 'text'], venue: ['venue', 'text'], notes: ['notes', 'text'], reportDueAt: ['report_due_at', 'int'], status: ['status', 'text'], reminderSent: ['reminder_sent', 'bool'], feedbackEscalatedAt: ['feedback_escalated_at', 'int'], workflowState: ['workflow_state', 'text'], rev: ['rev', 'int'], revAt: ['rev_at', 'int'], blockedBy: ['blocked_by_json', 'json'], subjectRemovedAt: ['subject_removed_at', 'int'] },
  objects: {
    schedule: { keys: ['timezone', 'revision', 'proposedAt', 'proposedBy', 'confirmedAt', 'confirmedBy', 'declinedAt', 'declinedBy', 'sessions', 'revisions'], cols: { timezone: ['schedule_timezone', 'text'], revision: ['schedule_revision', 'int'], proposedAt: ['schedule_proposed_at', 'int'], confirmedAt: ['schedule_confirmed_at', 'int'], declinedAt: ['schedule_declined_at', 'int'] }, objects: { proposedBy: by3(['schedule_proposed_by_kind', 'schedule_proposed_by_user_id', 'schedule_proposed_by_id', 'schedule_proposed_by_name']), confirmedBy: by3(['schedule_confirmed_by_kind', 'schedule_confirmed_by_user_id', 'schedule_confirmed_by_id', 'schedule_confirmed_by_name']), declinedBy: by3(['schedule_declined_by_kind', 'schedule_declined_by_user_id', 'schedule_declined_by_id', 'schedule_declined_by_name']) }, lists: { sessions: SESSION, revisions: REVISION } },
    completion: { keys: ['state', 'at', 'by', 'reason', 'phase', 'cancelledBy'], cols: { state: ['completion_state', 'text'], at: ['completion_at', 'int'], reason: ['completion_reason', 'text'], phase: ['completion_phase', 'text'], cancelledBy: ['completion_cancelled_by', 'text'] }, objects: { by: by3(['completion_by_kind', 'completion_by_user_id', 'completion_by_id', 'completion_by_name']) } },
    recipient: { keys: ['type', 'playerId', 'guardianId', 'minor', 'at'], cols: { type: ['recipient_type', 'text'], playerId: ['recipient_player_id', 'text'], guardianId: ['recipient_guardian_id', 'text'], minor: ['recipient_minor', 'bool'], at: ['recipient_at', 'int'] } },
    lifecycle: { keys: ['applied', 'from', 'to', 'at', 'reason'], cols: { applied: ['lifecycle_applied', 'bool'], from: ['lifecycle_from', 'text'], to: ['lifecycle_to', 'text'], at: ['lifecycle_at', 'int'], reason: ['lifecycle_reason', 'text'] } },
    revBy: { keys: ['userId', 'name'], cols: { userId: ['rev_by_user_id', 'text'], name: ['rev_by_name', 'text'] } },
    day: { keys: ['staff', 'consents', 'arrival', 'emergency', 'checkins', 'collection', 'statusEvents'], cols: {}, objects: { arrival: { keys: ['time', 'address', 'notes'], cols: { time: ['day_arrival_time', 'text'], address: ['day_arrival_address', 'text'], notes: ['day_arrival_notes', 'text'] } }, emergency: { keys: ['name', 'phone', 'setBy', 'at'], cols: { name: ['day_emergency_name', 'text'], phone: ['day_emergency_phone', 'text'], setBy: ['day_emergency_set_by', 'text'], at: ['day_emergency_at', 'int'] } }, collection: { keys: ['policy'], cols: { policy: ['day_collection_policy', 'text'] } } }, lists: { staff: STAFF, consents: CONSENT, checkins: CHECKIN, statusEvents: STATUS_EVENT } },
  },
  lists: { attendance: ATTENDANCE, history: HISTORY },
  object: { report: REPORT },
  maps: { keys: KEYS_TRIALS, reminders: REMINDERS },
};
const REQUESTS = { table: 'recruitment_requests', shape: REQUEST_SHAPE };
const TRIALS = { table: 'trials', shape: TRIAL_SHAPE };
/** The child tables of a parent, in write order (a sub-child after its owner). */
const childSpecs = (shape, out = []) => { for (const s of Object.values(shape.lists ?? {})) { out.push(s); childSpecs(s.shape, out); } for (const s of Object.values(shape.object ?? {})) out.push(s); for (const s of Object.values(shape.objects ?? {})) childSpecs(s, out); return out; };
const REQUEST_CHILDREN = Object.freeze(childSpecs(REQUEST_SHAPE));
const TRIAL_CHILDREN = Object.freeze(childSpecs(TRIAL_SHAPE));
export const RECRUITMENT_TABLES = Object.freeze(['recruitment_requests', ...REQUEST_CHILDREN.map((c) => c.table), 'trials', ...TRIAL_CHILDREN.map((c) => c.table), 'trial_reminders', 'idempotency_keys']);
/** The unique indexes the write strategy retains (plan §D.7.3): structural, or enforced by every writer. */

// ------------------------------------------------------------------ the DDL (generated from the shapes; amended into docs/architecture/sql/02_recruitment.sql at this step)
const sqlType = (kind) => (kind === 'int' || kind === 'bool' ? 'INTEGER' : kind === 'num' ? 'REAL' : 'TEXT');
const columnsOf = (shape, out = []) => { for (const k of shape.keys) { if (shape.cols?.[k]) out.push(shape.cols[k]); else if (shape.objects?.[k]) columnsOf(shape.objects[k], out); } return out; };
const CONSTRAINTS = {
  recruitment_requests: { id: 'TEXT NOT NULL UNIQUE', player_id: 'TEXT NOT NULL', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT', user_id: 'TEXT NOT NULL REFERENCES org_users(id) ON DELETE RESTRICT', trial_id: 'TEXT REFERENCES trials(id) ON DELETE SET NULL' },
  trials: { id: 'TEXT NOT NULL UNIQUE', request_id: 'TEXT NOT NULL UNIQUE REFERENCES recruitment_requests(id) ON DELETE RESTRICT', player_id: 'TEXT NOT NULL', org_id: 'TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT' },
  trial_reports: { org_id: 'TEXT REFERENCES orgs(id) ON DELETE RESTRICT' },
};
function parentDdl(spec, indexes) {
  const cols = columnsOf(spec.shape).map(([col, kind]) => `  ${col.padEnd(32)} ${CONSTRAINTS[spec.table]?.[col] ?? sqlType(kind)}${kind === 'json' && !CONSTRAINTS[spec.table]?.[col] ? ` ${JSON_CHECK(col)}` : ''}`);
  return `CREATE TABLE ${spec.table} (\n  seq                              INTEGER PRIMARY KEY,\n${cols.join(',\n')},\n  absent_keys_json                 TEXT ${ABSENT_CHECK},\n  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')},\n  extra_json                       TEXT ${EXTRA_CHECK('extra_json')}\n) STRICT;\n${indexes.map((ix) => `${ix};`).join('\n')}`;
}
function childDdl(spec) {
  const owner = spec.ownerCols.map((c, i) => `  ${c.padEnd(32)} ${i === 0 ? `TEXT NOT NULL REFERENCES ${spec.ownerCols[0] === 'trial_id' ? 'trials' : 'recruitment_requests'}(id) ON DELETE ${spec.restrict ? 'RESTRICT' : 'CASCADE'}` : 'INTEGER NOT NULL'}`);
  const cols = columnsOf(spec.shape).map(([col, kind]) => `  ${col.padEnd(32)} ${CONSTRAINTS[spec.table]?.[col] ?? sqlType(kind)}${kind === 'json' ? ` ${JSON_CHECK(col)}` : ''}`);
  const pk = spec.single ? `PRIMARY KEY (${spec.ownerCols.join(', ')})` : `PRIMARY KEY (${[...spec.ownerCols, 'position'].join(', ')})`;
  return `CREATE TABLE ${spec.table} (\n${owner.join(',\n')},\n  position                         INTEGER NOT NULL,\n${cols.join(',\n')},\n  raw_json                         TEXT ${JSON_CHECK('raw_json')},\n  absent_keys_json                 TEXT ${ABSENT_CHECK},\n  offtype_json                     TEXT ${EXTRA_CHECK('offtype_json')},\n  extra_json                       TEXT ${EXTRA_CHECK('extra_json')},\n  ${pk}\n) STRICT;\n${(spec.indexes ?? []).map((ix) => `${ix};`).join('\n')}`;
}
export const RECRUITMENT_DDL = [
  parentDdl(REQUESTS, ['CREATE INDEX recruitment_requests_org_player_type_status ON recruitment_requests (org_id, player_id, type, status)', 'CREATE INDEX recruitment_requests_player ON recruitment_requests (player_id, created_at)', 'CREATE INDEX recruitment_requests_routed_guardian ON recruitment_requests (routed_to, guardian_id)', 'CREATE INDEX recruitment_requests_case_type_created ON recruitment_requests (case_id, type, created_at)', 'CREATE INDEX recruitment_requests_contact ON recruitment_requests (contact_id)', 'CREATE INDEX recruitment_requests_trial ON recruitment_requests (trial_id)']),
  ...REQUEST_CHILDREN.map(childDdl),
  parentDdl(TRIALS, ['CREATE INDEX trials_org_status ON trials (org_id, status)', 'CREATE INDEX trials_org_player_case ON trials (org_id, player_id, case_id)', 'CREATE INDEX trials_player ON trials (player_id)', 'CREATE INDEX trials_case ON trials (case_id)', 'CREATE INDEX trials_status_report_due ON trials (status, report_due_at)', 'CREATE INDEX trials_workflow_confirmed ON trials (workflow_state, schedule_confirmed_at)', "CREATE UNIQUE INDEX trials_one_open_per_case ON trials (case_id) WHERE case_id IS NOT NULL AND workflow_state NOT IN ('completed', 'cancelled')"]),
  ...TRIAL_CHILDREN.map(childDdl),
  `CREATE TABLE trial_reminders (\n  trial_id                         TEXT NOT NULL REFERENCES trials(id) ON DELETE CASCADE,\n  position                         INTEGER NOT NULL,\n  marker                           TEXT NOT NULL,\n  sent_at                          INTEGER,\n  value_json                       TEXT ${JSON_CHECK('value_json')},\n  PRIMARY KEY (trial_id, position)\n) STRICT;\nCREATE UNIQUE INDEX trial_reminders_marker ON trial_reminders (trial_id, marker);`,
  `CREATE TABLE idempotency_keys (\n  owner_table                      TEXT NOT NULL CHECK (owner_table IN ('recruitment_requests', 'trials')),\n  owner_id                         TEXT NOT NULL,\n  position                         INTEGER NOT NULL,\n  act                              TEXT NOT NULL,\n  shape                            TEXT NOT NULL CHECK (shape IN ('list', 'value')),\n  key                              TEXT,\n  fp                               TEXT,\n  at                               INTEGER,\n  entry_json                       TEXT NOT NULL ${JSON_CHECK('entry_json')},\n  PRIMARY KEY (owner_table, owner_id, position)\n) STRICT;\nCREATE INDEX idempotency_keys_owner_act_key ON idempotency_keys (owner_table, owner_id, act, key);`,
].join('\n');
/** `channels` as migration 0015 rebuilds it: the 0012 definition with the REAL request key (messages and attachments unchanged). */
export const CHANNELS_DDL_WITH_KEY = `
CREATE TABLE channels (
  seq                     INTEGER PRIMARY KEY,
  id                      TEXT NOT NULL UNIQUE,
  request_id              TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL,
  player_name             TEXT,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL,
  org_verified            INTEGER CHECK (org_verified IS NULL OR org_verified IN (0, 1)),
  scout_name              TEXT,
  scout_role              TEXT,
  counterparty            TEXT NOT NULL CHECK (counterparty IN ('player', 'guardian')),
  guardian_id             TEXT,
  created_at              INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER,
  absent_keys_json        TEXT ${ABSENT_CHECK},
  extra_json              TEXT ${EXTRA_CHECK('extra_json')}
) STRICT;
CREATE UNIQUE INDEX channels_request_id ON channels (request_id);
CREATE INDEX channels_org_id ON channels (org_id);
CREATE INDEX channels_guardian_id ON channels (guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels (player_id, counterparty);`;

// ------------------------------------------------------------------ the mapping engine (record ↔ row + child rows)
const columnHolds = (kind, v) => (kind === 'text' ? typeof v === 'string' : kind === 'id' ? nonEmpty(v) : kind === 'int' ? Number.isSafeInteger(v) : kind === 'num' ? (typeof v === 'number' && Number.isFinite(v)) : kind === 'bool' ? typeof v === 'boolean' : true);
const toCol = (kind, v) => (kind === 'bool' ? (v ? 1 : 0) : kind === 'json' ? JSON.stringify(clone(v, 'json').value) : v);
const fromCol = (kind, v, col) => (v === null ? null : kind === 'bool' ? v === 1 : kind === 'json' ? parseJson(v, col) : v);
/**
 * Encode one object against a shape level: columns, absent paths, off-type values, extras (nested extras under their
 * known key), and the children to write (`{ spec, path, items | map }`).
 */
function encodeLevel(shape, obj, prefix, out, extraHolder) {
  for (const k of Object.keys(obj)) { if (shape.keys.includes(k) || obj[k] === undefined) continue; const c = clone(obj[k], `${prefix}${k}`); if (c.reason) throw new TypeError(c.reason); setOwn(extraHolder, k, c.value); }
  for (const k of shape.keys) {
    const path = `${prefix}${k}`;
    if (!Object.hasOwn(obj, k) || obj[k] === undefined) { out.absent.push(path); continue; }
    const v = obj[k];
    if (shape.objects?.[k]) {
      if (!isPlainObject(v)) { out.offtype[path] = clone(v, path).value; continue; }
      const sub = {}; encodeLevel(shape.objects[k], v, `${path}.`, out, sub); if (Object.keys(sub).length) setOwn(extraHolder, k, sub);
    } else if (shape.lists?.[k]) { if (!Array.isArray(v)) out.offtype[path] = clone(v, path).value; else out.children.push({ spec: shape.lists[k], path, items: v }); }
    else if (shape.object?.[k]) { if (!isPlainObject(v)) out.offtype[path] = clone(v, path).value; else out.children.push({ spec: shape.object[k], path, items: [v] }); }
    else if (shape.maps?.[k]) {
      if (!isPlainObject(v)) { out.offtype[path] = clone(v, path).value; continue; }
      if (!shape.maps[k].ownerTable) { out.children.push({ spec: shape.maps[k], path, map: v }); continue; }
      // the idempotency keys: a list act and a value act carrying a string key are rows; a value act WITHOUT a key
      // (`trials.keys.accept {key: null, fp}`, plan §D.7.3) is not replayable and stays on the owner row, under `keys`
      // in extra_json, exactly as it is
      const rows = {}; const held = {};
      for (const [act, entry] of Object.entries(v)) { if (entry === undefined) continue; if (Array.isArray(entry) || (isPlainObject(entry) && typeof entry.key === 'string')) rows[act] = entry; else setOwn(held, act, clone(entry, `${path}.${act}`).value); }
      if (Object.keys(held).length) setOwn(extraHolder, k, held);
      out.children.push({ spec: shape.maps[k], path, map: rows });
    }
    else { const [col, kind] = shape.cols[k]; if (v === null) out.cols[col] = null; else if (columnHolds(kind, v)) out.cols[col] = toCol(kind, v); else { out.cols[col] = null; out.offtype[path] = clone(v, path).value; } }
  }
}
function encode(shape, obj) {
  const out = { cols: {}, absent: [], offtype: {}, extra: {}, children: [] };
  encodeLevel(shape, obj, '', out, out.extra);
  return out;
}
/** Decode one shape level from a row (its columns, the parsed absent/offtype/extra of the record) and the children already decoded by path. */
function decodeLevel(shape, row, prefix, extraHolder, absent, offtype, children) {
  const obj = {};
  for (const k of Object.keys(extraHolder)) if (!shape.keys.includes(k)) setOwn(obj, k, extraHolder[k]);
  for (const k of shape.keys) {
    const path = `${prefix}${k}`;
    if (absent.has(path)) continue;
    if (Object.hasOwn(offtype, path)) { setOwn(obj, k, offtype[path]); continue; }
    if (shape.objects?.[k]) obj[k] = decodeLevel(shape.objects[k], row, `${path}.`, isPlainObject(extraHolder[k]) ? extraHolder[k] : {}, absent, offtype, children);
    else if (shape.lists?.[k]) obj[k] = children.get(path) ?? [];
    else if (shape.object?.[k]) obj[k] = (children.get(path) ?? [null])[0];
    else if (shape.maps?.[k]) { const held = shape.maps[k].ownerTable && isPlainObject(extraHolder[k]) ? extraHolder[k] : {}; const o = {}; for (const a of Object.keys(held)) setOwn(o, a, held[a]); for (const [a, val] of Object.entries(children.get(path) ?? {})) setOwn(o, a, val); obj[k] = o; }
    else { const [col, kind] = shape.cols[k]; obj[k] = fromCol(kind, row[col], col); }
  }
  return obj;
}
const rowMeta = (enc) => ({ absent_keys_json: enc.absent.length ? JSON.stringify(enc.absent) : null, offtype_json: jsonOrNull(enc.offtype), extra_json: jsonOrNull(enc.extra) });
const metaOf = (r) => ({ absent: new Set(r.absent_keys_json ? JSON.parse(r.absent_keys_json) : []), offtype: r.offtype_json ? parseJson(r.offtype_json, 'offtype_json') : {}, extra: r.extra_json ? parseJson(r.extra_json, 'extra_json') : {} });

// ------------------------------------------------------------------ statements (lazily prepared per connection; re-prepared when the connection's `prepare` is replaced — the suites' statement-failure seam wraps it)
const stmtCache = new WeakMap();
function stmts(sqlite) {
  let s = stmtCache.get(sqlite); if (s && s.preparedBy === sqlite.prepare) return s;
  const insertFor = (table, cols) => sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  const parentCols = (spec) => [...columnsOf(spec.shape).map((c) => c[0]), 'absent_keys_json', 'offtype_json', 'extra_json'];
  const upsertFor = (spec, parked) => { const cols = parentCols(spec); const set = cols.filter((c) => c !== 'id' && !(parked && c === 'trial_id')).map((c) => `${c} = excluded.${c}`); return sqlite.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map((c) => (parked && c === 'trial_id' ? 'NULL' : `@${c}`)).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${set.join(', ')}${parked ? `, trial_id = CASE WHEN ${spec.table}.trial_id IS @trial_id THEN ${spec.table}.trial_id ELSE NULL END` : ''}`); };
  const child = (spec) => ({ insert: insertFor(spec.table, [...spec.ownerCols, 'position', ...columnsOf(spec.shape).map((c) => c[0]), 'raw_json', 'absent_keys_json', 'offtype_json', 'extra_json']), deleteOwner: sqlite.prepare(`DELETE FROM ${spec.table} WHERE ${spec.ownerCols[0]} = ?`), select: sqlite.prepare(`SELECT * FROM ${spec.table} ORDER BY ${[...spec.ownerCols, 'position'].join(', ')}`) });
  s = {
    requests: { upsert: upsertFor(REQUESTS, true), select: sqlite.prepare('SELECT * FROM recruitment_requests ORDER BY seq'), assign: sqlite.prepare('UPDATE recruitment_requests SET trial_id = ? WHERE id = ?'), del: sqlite.prepare('DELETE FROM recruitment_requests WHERE id = ?'), children: Object.fromEntries(REQUEST_CHILDREN.map((c) => [c.table, child(c)])) },
    trials: { upsert: upsertFor(TRIALS, false), select: sqlite.prepare('SELECT * FROM trials ORDER BY seq'), stored: sqlite.prepare('SELECT id, request_id, case_id, workflow_state FROM trials'), park: sqlite.prepare('UPDATE trials SET case_id = NULL WHERE id = ?'), del: sqlite.prepare('DELETE FROM trials WHERE id = ?'), children: Object.fromEntries(TRIAL_CHILDREN.map((c) => [c.table, child(c)])) },
    reminders: { insert: insertFor('trial_reminders', ['trial_id', 'position', 'marker', 'sent_at', 'value_json']), deleteOwner: sqlite.prepare('DELETE FROM trial_reminders WHERE trial_id = ?'), select: sqlite.prepare('SELECT * FROM trial_reminders ORDER BY trial_id, position') },
    keys: { insert: insertFor('idempotency_keys', ['owner_table', 'owner_id', 'position', 'act', 'shape', 'key', 'fp', 'at', 'entry_json']), deleteOwner: sqlite.prepare('DELETE FROM idempotency_keys WHERE owner_table = ? AND owner_id = ?'), select: sqlite.prepare('SELECT * FROM idempotency_keys WHERE owner_table = ? ORDER BY owner_id, position') },
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'),
    preparedBy: sqlite.prepare,
  };
  stmtCache.set(sqlite, s); return s;
}

/** Write one parent record (its row by upsert; every child row deleted and reinserted in list order). */
function writeRecord(sqlite, spec, record) {
  const S = stmts(sqlite); const P = spec === REQUESTS ? S.requests : S.trials;
  const enc = encode(spec.shape, record);
  P.upsert.run({ ...Object.fromEntries(columnsOf(spec.shape).map(([col]) => [col, enc.cols[col] ?? null])), ...rowMeta(enc) });
  const children = spec === REQUESTS ? REQUEST_CHILDREN : TRIAL_CHILDREN;
  for (const c of children) P.children[c.table].deleteOwner.run(record.id);
  if (spec === TRIALS) S.reminders.deleteOwner.run(record.id);
  S.keys.deleteOwner.run(spec.table, record.id);
  writeChildren(sqlite, spec, enc.children, [record.id]);
}
function writeChildren(sqlite, parentSpec, children, ownerValues) {
  const S = stmts(sqlite); const P = parentSpec === REQUESTS ? S.requests : S.trials;
  for (const ch of children) {
    if (ch.spec.map) { // reminders
      let i = 0; for (const [marker, v] of Object.entries(ch.map)) { if (v === undefined) continue; const c = clone(v, `reminders.${marker}`).value; S.reminders.insert.run({ trial_id: ownerValues[0], position: i++, marker, sent_at: Number.isSafeInteger(c) ? c : null, value_json: Number.isSafeInteger(c) ? null : JSON.stringify(c) }); }
      continue;
    }
    if (ch.spec.ownerTable) { // idempotency keys
      let i = 0;
      for (const [act, v] of Object.entries(ch.map)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const e of v) { const c = clone(e, `keys.${act}`).value; S.keys.insert.run({ owner_table: ch.spec.ownerTable, owner_id: ownerValues[0], position: i++, act, shape: 'list', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: isPlainObject(c) && Number.isSafeInteger(c.at) ? c.at : null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
        else { const c = clone(v, `keys.${act}`).value; S.keys.insert.run({ owner_table: ch.spec.ownerTable, owner_id: ownerValues[0], position: i++, act, shape: 'value', key: isPlainObject(c) && typeof c.key === 'string' ? c.key : null, fp: isPlainObject(c) && typeof c.fp === 'string' ? c.fp : null, at: null, entry_json: JSON.stringify(c === undefined ? null : c) }); }
      }
      continue;
    }
    const st = P.children[ch.spec.table];
    ch.items.forEach((item, position) => {
      const owner = Object.fromEntries(ch.spec.ownerCols.map((c, i) => [c, ownerValues[i]]));
      if (!isPlainObject(item)) { st.insert.run({ ...owner, position, ...Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, null])), raw_json: JSON.stringify(clone(item, ch.path).value), absent_keys_json: null, offtype_json: null, extra_json: null }); return; }
      const enc = encode(ch.spec.shape, item);
      st.insert.run({ ...owner, position, ...Object.fromEntries(columnsOf(ch.spec.shape).map(([col]) => [col, enc.cols[col] ?? null])), raw_json: null, ...rowMeta(enc) });
      if (enc.children.length) writeChildren(sqlite, parentSpec, enc.children, [...ownerValues, position]);
    });
  }
}
/** Read every parent record of a spec with its children, in `seq` order: fresh objects from the file. */
function readRecords(sqlite, spec) {
  const S = stmts(sqlite); const P = spec === REQUESTS ? S.requests : S.trials;
  const children = spec === REQUESTS ? REQUEST_CHILDREN : TRIAL_CHILDREN;
  // child rows grouped by owner key (the owner column values joined), each decoded with its own sub-children
  const groups = new Map(); // `${table}|${ownerKey}` → rows
  for (const c of children) for (const r of P.children[c.table].select.all()) { const key = `${c.table}|${c.ownerCols.map((col) => r[col]).join('|')}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ ...r }); }
  const reminders = new Map(); if (spec === TRIALS) for (const r of S.reminders.select.all()) { if (!reminders.has(r.trial_id)) reminders.set(r.trial_id, []); reminders.get(r.trial_id).push(r); }
  const keys = new Map(); for (const r of S.keys.select.all(spec.table)) { if (!keys.has(r.owner_id)) keys.set(r.owner_id, []); keys.get(r.owner_id).push(r); }
  const decodeChildren = (shape, ownerValues, out = new Map(), prefix = '') => {
    for (const [k, sub] of Object.entries(shape.lists ?? {})) out.set(`${prefix}${k}`, (groups.get(`${sub.table}|${ownerValues.join('|')}`) ?? []).map((r) => decodeChild(sub, r, ownerValues)));
    for (const [k, sub] of Object.entries(shape.object ?? {})) out.set(`${prefix}${k}`, (groups.get(`${sub.table}|${ownerValues.join('|')}`) ?? []).map((r) => decodeChild(sub, r, ownerValues)));
    for (const [k, sub] of Object.entries(shape.maps ?? {})) {
      if (sub.map) { const o = {}; for (const r of reminders.get(ownerValues[0]) ?? []) setOwn(o, r.marker, r.sent_at !== null ? r.sent_at : parseJson(r.value_json, 'value_json')); out.set(`${prefix}${k}`, o); }
      else { const o = {}; for (const r of keys.get(ownerValues[0]) ?? []) { const v = parseJson(r.entry_json, 'entry_json'); if (r.shape === 'list') { if (!Array.isArray(o[r.act])) setOwn(o, r.act, []); o[r.act].push(v); } else setOwn(o, r.act, v); } out.set(`${prefix}${k}`, o); }
    }
    for (const [k, sub] of Object.entries(shape.objects ?? {})) decodeChildren(sub, ownerValues, out, `${prefix}${k}.`);
    return out;
  };
  const decodeChild = (sub, r, ownerValues) => {
    if (r.raw_json !== null) return parseJson(r.raw_json, 'raw_json');
    const m = metaOf(r); const kids = decodeChildren(sub.shape, [...ownerValues, r.position]);
    return decodeLevel(sub.shape, r, '', m.extra, m.absent, m.offtype, kids);
  };
  return P.select.all().map((r) => { const m = metaOf(r); return decodeLevel(spec.shape, r, '', m.extra, m.absent, m.offtype, decodeChildren(spec.shape, [r.id])); });
}
export const readRequests = (sqlite) => readRecords(sqlite, REQUESTS);
export const readTrials = (sqlite) => readRecords(sqlite, TRIALS);
/** The trials collection as the file holds it: the tables once 0015 is recorded, the blob before (`[]` when there is none; `null` when the blob is not valid JSON) — what the identity snapshot reconciles trialReports against. */
export const readTrialsCollection = (sqlite) => (recruitmentLive(sqlite) ? readTrials(sqlite) : readTrialsBlob(sqlite));
/** The requests collection as the file holds it (the tables, or the blob): ids are what the callers need. */
export function readRequestsCollection(sqlite) {
  if (recruitmentLive(sqlite)) return readRequests(sqlite);
  if (!tableExists(sqlite, 'collections')) return undefined;
  const row = sqlite.prepare("SELECT value FROM collections WHERE name = 'requests'").get();
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return null; }
}
export function readCasesCollection(sqlite) {
  if (!tableExists(sqlite, 'collections')) return [];
  const row = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(CASES_COLLECTION);
  if (!row) return [];
  try { const v = JSON.parse(row.value); return Array.isArray(v) ? v : null; } catch { return null; }
}

// ------------------------------------------------------------------ validation (the literal's contract: never a value in a message)
/** Validate one request entry: `{ ok: true }` or `{ ok: false, reason }`. The contract is the identifiers the keys and tolerant references need; everything else is lossless. */
export function validateRequest(raw, at = 'request') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (!nonEmpty(raw.playerId)) return { ok: false, reason: `${at}.playerId must be a non-empty string (${raw.id})` };
  if (!nonEmpty(raw.orgId)) return { ok: false, reason: `${at}.orgId must be a non-empty string (${raw.id})` };
  if (!nonEmpty(raw.userId)) return { ok: false, reason: `${at}.userId must be a non-empty string (${raw.id})` };
  if (Object.hasOwn(raw, 'trialId') && raw.trialId !== undefined && raw.trialId !== null && !nonEmpty(raw.trialId)) return { ok: false, reason: `${at}.trialId must be a string or null (${raw.id})` };
  if (Object.hasOwn(raw, 'caseId') && raw.caseId !== undefined && raw.caseId !== null && !nonEmpty(raw.caseId)) return { ok: false, reason: `${at}.caseId must be a string or null (${raw.id})` };
  for (const k of ['guardianId']) if (Object.hasOwn(raw, k) && raw[k] !== undefined && raw[k] !== null && !nonEmpty(raw[k])) return { ok: false, reason: `${at}.${k} must be a string or null (${raw.id})` };
  try { encode(REQUEST_SHAPE, raw); } catch (e) { return { ok: false, reason: `${at} (${raw.id}): ${e.message}` }; }
  return { ok: true };
}
export function validateTrial(raw, at = 'trial') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (!nonEmpty(raw.requestId)) return { ok: false, reason: `${at}.requestId must be a non-empty string (${raw.id})` };
  if (!nonEmpty(raw.playerId)) return { ok: false, reason: `${at}.playerId must be a non-empty string (${raw.id})` };
  if (!nonEmpty(raw.orgId)) return { ok: false, reason: `${at}.orgId must be a non-empty string (${raw.id})` };
  if (Object.hasOwn(raw, 'caseId') && raw.caseId !== undefined && raw.caseId !== null && !nonEmpty(raw.caseId)) return { ok: false, reason: `${at}.caseId must be a string or null (${raw.id})` };
  try { encode(TRIAL_SHAPE, raw); } catch (e) { return { ok: false, reason: `${at} (${raw.id}): ${e.message}` }; }
  return { ok: true };
}
/** Unknown fields at the record level (the `keys` holder of a non-replayable act is a known value kept in place, not an unknown field). */
const unknownExtras = (enc) => Object.keys(enc.extra).some((k) => k !== 'keys');
const guardianRefsOfRequest = (r) => [r.guardianId, isPlainObject(r.recipient) ? r.recipient.guardianId : null].filter((g) => typeof g === 'string' && g.length);
const guardianRefsOfTrial = (t) => [isPlainObject(t.recipient) ? t.recipient.guardianId : null].filter((g) => typeof g === 'string' && g.length);
const caseRefOf = (x) => (typeof x.caseId === 'string' && x.caseId.length ? x.caseId : null);
/**
 * Validate whole collections and their cross references (ids only). `stored` gives the
 * retained side for a partial write: `{ requests, trials }` as arrays of records (or null
 * when that side is supplied). `cases` is the FINAL recruitmentCases collection (array) and
 * `guardianExists(id)` the FINAL guardians table. Throws RECRUITMENT_IMPORT_BLOCKED (a
 * collection problem) or the reference refusal codes. Returns `{ counts }`.
 */
export function validateCollections(sqlite, { requests, trials }, { stored = {}, cases, orgs, users, label = 'the snapshot' } = {}) {
  const problems = [];
  const reqList = requests === undefined ? (stored.requests ?? []) : requests; const trList = trials === undefined ? (stored.trials ?? []) : trials;
  if (requests !== undefined && !Array.isArray(requests)) throw blocked(`${label}: requests must be an array of entries (got ${describe(requests)})`);
  if (trials !== undefined && !Array.isArray(trials)) throw blocked(`${label}: trials must be an array of entries (got ${describe(trials)})`);
  const counts = { requests: { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0 }, trials: { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0, legacyPairs: 0, preP4bShape: 0, recipientMismatch: 0 }, players: { live: 0, retained: 0, missing: 0 } };
  const seenR = new Set(); const seenT = new Set();
  if (requests !== undefined) requests.forEach((raw, i) => { const v = validateRequest(raw, `requests entry #${i}`); if (!v.ok) { problems.push(v.reason); return; } if (seenR.has(raw.id)) { problems.push(`requests entry #${i}: duplicates the id of an earlier entry (${raw.id})`); return; } seenR.add(raw.id); const e = encode(REQUEST_SHAPE, raw); counts.requests.imported += 1; if (unknownExtras(e)) counts.requests.withExtraFields += 1; if (e.absent.length) counts.requests.withAbsentKeys += 1; if (Object.keys(e.offtype).length) counts.requests.withOfftypeValues += 1; });
  if (trials !== undefined) trials.forEach((raw, i) => { const v = validateTrial(raw, `trials entry #${i}`); if (!v.ok) { problems.push(v.reason); return; } if (seenT.has(raw.id)) { problems.push(`trials entry #${i}: duplicates the id of an earlier entry (${raw.id})`); return; } seenT.add(raw.id); const e = encode(TRIAL_SHAPE, raw); counts.trials.imported += 1; if (unknownExtras(e)) counts.trials.withExtraFields += 1; if (e.absent.length) counts.trials.withAbsentKeys += 1; if (Object.keys(e.offtype).length) counts.trials.withOfftypeValues += 1; if (!Object.hasOwn(raw, 'workflowState')) counts.trials.preP4bShape += 1; if (isPlainObject(raw.recipient) && typeof raw.recipient.playerId === 'string' && raw.recipient.playerId !== raw.playerId) counts.trials.recipientMismatch += 1; });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  // cross references on the FINAL combined state
  const reqById = new Map(reqList.filter(isPlainObject).map((r) => [r.id, r])); const trById = new Map(trList.filter(isPlainObject).map((t) => [t.id, t]));
  const byRequest = new Map();
  for (const t of trById.values()) {
    if (!reqById.has(t.requestId)) problems.push(`trial ${t.id} names request ${t.requestId}, which is not in the final requests`);
    else if (byRequest.has(t.requestId)) problems.push(`trial ${t.id} and trial ${byRequest.get(t.requestId)} both name request ${t.requestId}; a request has one trial`);
    byRequest.set(t.requestId, t.id);
    const r = reqById.get(t.requestId);
    if (r) { if (!Object.hasOwn(r, 'trialId') || r.trialId === undefined) counts.trials.legacyPairs += 1; else if (r.trialId !== t.id) problems.push(`trial ${t.id} names request ${t.requestId}, which names ${r.trialId === null ? 'no trial' : `trial ${r.trialId}`}`); }
  }
  // A SUPPLIED request's values are authoritative: a trial it names must be in the final trials. A RETAINED request whose
  // trial is removed by this write keeps nothing of it: the departure sets its back-reference NULL (the key's SET NULL) —
  // the deliberate removal of plan §D.7.5; a retained request whose trial is reassigned to another request is a mismatch.
  for (const r of reqById.values()) { if (typeof r.trialId === 'string') { const t = trById.get(r.trialId); if (!t) { if (requests !== undefined) problems.push(`request ${r.id} names trial ${r.trialId}, which is not in the final trials`); } else if (t.requestId !== r.id) problems.push(`request ${r.id} names trial ${r.trialId}, which names request ${t.requestId}`); } }
  if (problems.length) throw refusal('PAIR_MISMATCH', `${problems.length} request/trial relationship(s) in ${label} do not agree (${ids(problems)}); the write was rolled back and nothing was changed`, { problems });
  const caseIds = cases === undefined ? null : new Set((cases ?? []).filter(isPlainObject).map((c) => c.id));
  if (caseIds) { const missing = [...reqById.values(), ...trById.values()].filter((x) => caseRefOf(x) && !caseIds.has(x.caseId)); if (missing.length) throw refusal('RECRUITMENT_CASE_MISSING', `${missing.length} row(s) in ${label} name a case that is not in the final ${CASES_COLLECTION} collection (rows ${ids(missing.map((x) => x.id))}; cases ${ids([...new Set(missing.map((x) => x.caseId))])}); the write was rolled back and nothing was changed — resolve the case id by hand, never by guessing (Q7b)`, { rows: missing.map((x) => x.id) }); }
  // the organisation and staff keys (RESTRICT): checked here with ids only, so a dangling reference is named before the
  // engine's bare "FOREIGN KEY constraint failed" — against the FINAL collections when the snapshot supplies them (their
  // prunes run after this write), the tables otherwise
  const idsOf = (list) => new Set((Array.isArray(list) ? list : []).filter(isPlainObject).map((x) => x.id));
  const orgIds = orgs !== undefined ? idsOf(orgs) : tableExists(sqlite, 'orgs') ? new Set(sqlite.prepare('SELECT id FROM orgs').all().map((r) => r.id)) : null;
  const userIds = users !== undefined ? idsOf(users) : tableExists(sqlite, 'org_users') ? new Set(sqlite.prepare('SELECT id FROM org_users').all().map((r) => r.id)) : null;
  if (orgIds) { const noOrg = [...(requests === undefined ? [] : reqById.values()), ...(trials === undefined ? [] : trById.values())].filter((x) => !orgIds.has(x.orgId)); if (noOrg.length) throw refusal('RECRUITMENT_ORG_MISSING', `${noOrg.length} row(s) in ${label} name an organisation that does not exist in the final orgs table (rows ${ids(noOrg.map((x) => x.id))}; organisations ${ids([...new Set(noOrg.map((x) => x.orgId))])}); the write was rolled back and nothing was changed`, { rows: noOrg.map((x) => x.id) }); }
  if (userIds && requests !== undefined) { const noUser = [...reqById.values()].filter((r) => !userIds.has(r.userId)); if (noUser.length) throw refusal('RECRUITMENT_USER_MISSING', `${noUser.length} request(s) in ${label} name a staff member that does not exist in the final org_users table (rows ${ids(noUser.map((x) => x.id))}; staff ${ids([...new Set(noUser.map((x) => x.userId))])}); the write was rolled back and nothing was changed`, { rows: noUser.map((x) => x.id) }); }
  const S = stmts(sqlite); const noGuardian = [];
  for (const r of reqById.values()) for (const g of guardianRefsOfRequest(r)) if (!S.guardian.get(g)) noGuardian.push([r.id, g]);
  for (const t of trById.values()) for (const g of guardianRefsOfTrial(t)) if (!S.guardian.get(g)) noGuardian.push([t.id, g]);
  if (noGuardian.length) throw refusal('RECRUITMENT_GUARDIAN_MISSING', `${noGuardian.length} row(s) in ${label} name a guardian that does not exist in the final guardians table (rows ${ids(noGuardian.map((x) => x[0]))}; guardians ${ids([...new Set(noGuardian.map((x) => x[1]))])}); the write was rolled back and nothing was changed (Q7c)`, { rows: noGuardian.map((x) => x[0]) });
  // the tolerant player references, counted
  if (tableExists(sqlite, 'players')) {
    const live = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NULL').all().map((r) => r.id)); const retained = new Set(sqlite.prepare('SELECT id FROM players WHERE deleted_at IS NOT NULL').all().map((r) => r.id));
    for (const x of [...(requests === undefined ? [] : reqById.values()), ...(trials === undefined ? [] : trById.values())]) { if (live.has(x.playerId)) counts.players.live += 1; else if (retained.has(x.playerId)) counts.players.retained += 1; else counts.players.missing += 1; }
  }
  return { counts };
}

// ------------------------------------------------------------------ the six phases against the tables
/**
 * Phases 1–3 and 5 (plan §D.7.5) for the supplied collections against the table state. `requests`/`trials` are
 * arrays of records (a full collection) or `undefined` (omitted, retained). `only` restricts the rows written to
 * the given ids (a flush writes the changed ones; a snapshot writes every supplied one). Runs inside the caller's
 * transaction. Phase 4 (channels) is the caller's, between `phases123` and `prune`.
 */
export function phases123(sqlite, { requests, trials }, { only = null } = {}) {
  const S = stmts(sqlite);
  const dirty = (id) => !only || only.has(id);
  if (requests) for (const r of requests) if (dirty(r.id)) writeRecord(sqlite, REQUESTS, r); // phase 1 (the back-reference parked by the upsert)
  if (trials) {
    const supplied = new Map(trials.map((t) => [t.id, t]));
    const stored = S.trials.stored.all().map((r) => ({ ...r }));
    const departing = stored.filter((st) => { const t = supplied.get(st.id); return !t || t.requestId !== st.request_id; });
    for (const { id } of departing) { for (const c of TRIAL_CHILDREN) if (c.restrict) S.trials.children[c.table].deleteOwner.run(id); S.keys.deleteOwner.run('trials', id); S.trials.del.run(id); } // (a): the RESTRICT children and the keys (no key of their own: a polymorphic owner) first, the cascades take the rest
    const gone = new Set(departing.map((d) => d.id));
    for (const st of stored) { if (gone.has(st.id)) continue; const t = supplied.get(st.id); const wasIn = inSlot(st.case_id, st.workflow_state); const keeps = inSlot(t.caseId, t.workflowState) && t.caseId === st.case_id; if (wasIn && !keeps) S.trials.park.run(st.id); } // (b)
    for (const t of trials) if (dirty(t.id) || gone.has(t.id)) writeRecord(sqlite, TRIALS, t); // (c)
  }
  if (requests) for (const r of requests) if (dirty(r.id)) S.requests.assign.run(typeof r.trialId === 'string' ? r.trialId : null, r.id); // phase 3
}
export function prune(sqlite, { requests, label = 'the snapshot' }) {
  if (!requests) return;
  const S = stmts(sqlite); const keep = new Set(requests.map((r) => r.id));
  const gone = sqlite.prepare('SELECT id FROM recruitment_requests').all().map((r) => r.id).filter((id) => !keep.has(id));
  if (!gone.length) return;
  // A thread still naming a request this write removes: named with ids (the RESTRICT key would refuse it without them).
  if (tableExists(sqlite, 'channels')) {
    const goneSet = new Set(gone); const held = sqlite.prepare('SELECT id, request_id FROM channels ORDER BY seq').all().filter((c) => goneSet.has(c.request_id));
    if (held.length) throw refusal('CHANNEL_REQUEST_MISSING', `${held.length} channel(s) in ${label} name a request that is not in the final requests collection (channels ${ids(held.map((c) => c.id))}; requests ${ids([...new Set(held.map((c) => c.request_id))])}); the write was rolled back and nothing was changed — remove the thread with its request, or keep the request`, { channels: held.map((c) => c.id) });
  }
  for (const id of gone) { S.keys.deleteOwner.run('recruitment_requests', id); S.requests.del.run(id); } // phase 5 (the keys first: no key of their own; the slots cascade; a trial still naming the request is refused by its RESTRICT key — the pre-write check names it first)
}
/**
 * Phase 6 — the FINAL-state assertions, inside the caller's transaction: the request/trial pair (a request naming a
 * trial is named back; a trial's request names it or carries no trialId key — the legacy pair), every case id in the
 * final recruitmentCases (`cases`: the supplied collection, or the retained blob when omitted), every guardian id in
 * the final guardians table. Throws with ids only. A no-op before the cutover record.
 */
export function assertRecruitmentConsistent(sqlite, { cases = undefined, label = 'the snapshot' } = {}) {
  if (!recruitmentLive(sqlite)) return;
  const pairA = sqlite.prepare(`SELECT t.id AS trial_id, t.request_id, r.trial_id AS named FROM trials t JOIN recruitment_requests r ON r.id = t.request_id WHERE r.trial_id IS NOT t.id AND instr(coalesce(r.absent_keys_json, ''), '"trialId"') = 0`).all();
  const pairB = sqlite.prepare('SELECT r.id AS request_id, r.trial_id FROM recruitment_requests r LEFT JOIN trials t ON t.id = r.trial_id WHERE r.trial_id IS NOT NULL AND (t.id IS NULL OR t.request_id <> r.id)').all();
  if (pairA.length || pairB.length) throw refusal('PAIR_MISMATCH', `${pairA.length + pairB.length} request/trial relationship(s) in ${label} do not agree (trials ${ids(pairA.map((r) => r.trial_id))}; requests ${ids(pairB.map((r) => r.request_id))}); the write was rolled back and nothing was changed — write the requests and the trials of a relationship together`, { trials: pairA.map((r) => r.trial_id), requests: pairB.map((r) => r.request_id) });
  const finalCases = cases === undefined ? readCasesCollection(sqlite) : cases;
  const caseRows = sqlite.prepare("SELECT 'request' AS kind, id, case_id FROM recruitment_requests WHERE case_id IS NOT NULL UNION ALL SELECT 'trial', id, case_id FROM trials WHERE case_id IS NOT NULL").all();
  if (caseRows.length) {
    if (!Array.isArray(finalCases)) throw refusal('RECRUITMENT_CASES_MALFORMED', `${caseRows.length} row(s) in ${label} reference cases, but the ${cases === undefined ? `retained ${CASES_COLLECTION} collection` : `${CASES_COLLECTION} collection supplied with the snapshot`} is ${describe(finalCases)}, not an array; the write was rolled back and nothing was changed`);
    const caseIds = new Set(finalCases.filter(isPlainObject).map((c) => c.id)); const missing = caseRows.filter((r) => !caseIds.has(r.case_id));
    if (missing.length) throw refusal('RECRUITMENT_CASE_MISSING', `${missing.length} row(s) in ${label} name a case that is not in the final ${CASES_COLLECTION} collection (rows ${ids(missing.map((r) => r.id))}; cases ${ids([...new Set(missing.map((r) => r.case_id))])}); the write was rolled back and nothing was changed (Q7b)`, { rows: missing.map((r) => r.id) });
  }
  const guardianRows = sqlite.prepare(`SELECT id, guardian_id AS g FROM recruitment_requests WHERE guardian_id IS NOT NULL UNION ALL SELECT id, recipient_guardian_id FROM recruitment_requests WHERE recipient_guardian_id IS NOT NULL UNION ALL SELECT id, recipient_guardian_id FROM trials WHERE recipient_guardian_id IS NOT NULL`).all();
  const guardians = new Set(sqlite.prepare('SELECT id FROM guardians').all().map((r) => r.id));
  const noGuardian = guardianRows.filter((r) => !guardians.has(r.g));
  if (noGuardian.length) throw refusal('RECRUITMENT_GUARDIAN_MISSING', `${noGuardian.length} row(s) in ${label} name a guardian that does not exist in the final guardians table (rows ${ids([...new Set(noGuardian.map((r) => r.id))])}; guardians ${ids([...new Set(noGuardian.map((r) => r.g))])}); the write was rolled back and nothing was changed (Q7c)`, { rows: noGuardian.map((r) => r.id) });
}
/** The counts of the admin report: rows naming a player that is not in the players table, and rows naming a retained record (Q7a: counted, never refused). */
export function unresolvedPlayerReferences(sqlite) {
  if (!recruitmentLive(sqlite)) return null;
  const q = (t) => sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id)`).get().n;
  return { requests: q('recruitment_requests'), trials: q('trials') };
}
export function retainedPlayerReferences(sqlite) {
  if (!recruitmentLive(sqlite)) return null;
  const q = (t) => sqlite.prepare(`SELECT count(*) AS n FROM ${t} x WHERE EXISTS (SELECT 1 FROM players p WHERE p.id = x.player_id AND p.deleted_at IS NOT NULL)`).get().n;
  return { requests: q('recruitment_requests'), trials: q('trials') };
}

// ------------------------------------------------------------------ whole-snapshot access (writeTableBacked / readTableBacked)
export const RECRUITMENT_SNAPSHOT = {
  names: RECRUITMENT_COLLECTIONS,
  read(sqlite) { if (!recruitmentLive(sqlite)) return null; return { requests: readRequests(sqlite), trials: readTrials(sqlite) }; },
  /** Phases 1–3 for the supplied collections (both optional); returns the names written (empty before the cutover record: the caller writes the blobs). */
  replace(sqlite, { requests, trials }, { cases = undefined, orgs = undefined, users = undefined, label = 'the snapshot' } = {}) {
    if (!recruitmentLive(sqlite)) return [];
    if (!sqlite.isTransaction) throw new Error('recruitment: replace() runs inside the caller\'s transaction');
    if (requests === undefined && trials === undefined) return [];
    const stored = { requests: requests === undefined ? readRequests(sqlite) : null, trials: trials === undefined ? readTrials(sqlite) : null };
    validateCollections(sqlite, { requests, trials }, { stored, cases: cases === undefined ? readCasesCollection(sqlite) : cases, orgs, users, label });
    phases123(sqlite, { requests, trials });
    return [requests !== undefined ? 'requests' : null, trials !== undefined ? 'trials' : null].filter(Boolean);
  },
  prune(sqlite, { requests, label = 'the snapshot' }) { if (recruitmentLive(sqlite)) prune(sqlite, { requests, label }); },
};

/**
 * Import the legacy (or exported) `requests` and `trials` blobs into the tables inside the migration's transaction
 * (every entry validated, the cross references checked against the file's blobs and tables, insertion in array
 * order, the blob rows retired). An absent blob imports nothing; a non-array or non-JSON blob refuses the step.
 * Returns the counts the migration records (never a value).
 */
export function importRecruitmentBlobs(sqlite) {
  const read = (name) => { const row = tableExists(sqlite, 'collections') ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null; if (!row) return undefined; try { return JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); } };
  const requests = read('requests') ?? []; const trials = read('trials') ?? [];
  if (!Array.isArray(requests)) throw blocked(`the requests blob must be an array of entries (got ${describe(requests)})`);
  if (!Array.isArray(trials)) throw blocked(`the trials blob must be an array of entries (got ${describe(trials)})`);
  const cases = readCasesCollection(sqlite);
  let counts;
  try { ({ counts } = validateCollections(sqlite, { requests, trials }, { cases: cases ?? [], label: 'the recruitment blobs' })); }
  catch (e) { if (e?.code && e.code !== 'RECRUITMENT_IMPORT_BLOCKED') throw blocked(e.message, { refusal: e.code, rows: e.rows, problems: e.problems }); throw e; } // one code for the operator (the step is blocked), the specific refusal in the detail
  phases123(sqlite, { requests, trials });
  if (tableExists(sqlite, 'collections')) sqlite.prepare('DELETE FROM collections WHERE name IN (?, ?)').run('requests', 'trials');
  return counts;
}

// ------------------------------------------------------------------ detached copies (the export)
const copyRecord = (r) => { const c = {}; for (const k of Object.keys(r)) setOwn(c, k, clone(r[k], k).value); return c; };

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null; `staged` selects the server's write
 * mode (the save hook must be registered); `cases` is an accessor for the authoritative recruitmentCases collection
 * (the live blob: `() => db.recruitmentCases`) that the strict case references are checked against.
 */
export function createRecruitmentRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false, cases = null } = {}) {
  if (!sqlite) throw new TypeError('the recruitment repository needs a SQLite connection (node:sqlite); requests and trials have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the recruitment repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null');
  if (staged && !unit) throw new TypeError('the recruitment repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  if (cases !== null && typeof cases !== 'function') throw new TypeError('the recruitment repository takes `cases` as an accessor function returning the authoritative recruitmentCases collection');
  void now; void staged;
  const cutover = sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?');
  const refuse = (what) => { throw new TypeError(`${what} is written through the recruitment repository (addRequest / addTrial / tombstoneForPlayer), never directly on the in-memory collection; a record's own fields are edited in place and land in the next save`); };
  // The mirrors: plain, mutable records in insertion order; the views are read-only ARRAYS over them.
  const requests = []; const trials = [];
  const arrayView = (target, label) => markView(new Proxy(target, { set() { return refuse(`the ${label} collection`); }, deleteProperty() { return refuse(`the ${label} collection`); }, defineProperty() { return refuse(`the ${label} collection`); } }));
  const requestsView = arrayView(requests, 'requests'); const trialsView = arrayView(trials, 'trials');
  // Change tracking reflects COMMITTED state only: id → the fingerprint of the record as last committed (and, for trials, the key columns).
  const committed = { requests: new Map(), trials: new Map() };
  let inFlight = null; // what the open save transaction wrote: applied by commit(), discarded by rollback()
  const fp = (r) => JSON.stringify(r);
  const load = () => {
    requests.length = 0; trials.length = 0; committed.requests.clear(); committed.trials.clear();
    if (!recruitmentLive(sqlite)) return;
    for (const r of readRequests(sqlite)) { requests.push(r); committed.requests.set(r.id, fp(r)); }
    for (const t of readTrials(sqlite)) { trials.push(t); committed.trials.set(t.id, fp(t)); }
  };
  load();
  const inUnit = () => !!unit?.active?.();
  let hookTaken = false;
  const hookRefusal = (what) => new Error(`recruitment: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the changed records and how a unit of work's rollback restores this repository's memory`);
  /** A mutation of the mirror: inside a unit it joins (a failure poisons the unit); outside, the save that follows lands it. */
  const mutate = (fn) => { if (inUnit()) return unit.join(() => { if (!hookTaken) throw hookRefusal('a write inside a unit of work'); return fn(); }); if (staged && !hookTaken) throw hookRefusal('a write'); return fn(); };
  const casesNow = () => (cases ? cases() : undefined);

  const repo = {
    attach() {
      if (!cutover.get(RECRUITMENT_MIGRATION)) throw new Error(`recruitment: the cutover record ${RECRUITMENT_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`recruitment: ${requests.length} request(s) and ${trials.length} trial(s) loaded from the tables`);
      return { engine: 'sqlite', requests: requests.length, trials: trials.length };
    },
    reload() { load(); return requests.length + trials.length; },
    requestsView, trialsView,
    counts: () => ({ requests: requests.length, trials: trials.length, trialReports: trials.filter((t) => isPlainObject(t.report)).length }),
    /** Changed or new records not yet in a committed save. */
    pending: () => ({ requests: requests.filter((r) => committed.requests.get(r.id) !== fp(r)).length + [...committed.requests.keys()].filter((id) => !requests.some((r) => r.id === id)).length, trials: trials.filter((t) => committed.trials.get(t.id) !== fp(t)).length + [...committed.trials.keys()].filter((id) => !trials.some((t) => t.id === id)).length }),
    /** A new request at the end (the former `db.requests.push`): the record itself is kept, validated like an import; the strict references checked now (ids only). */
    addRequest(record) {
      return mutate(() => {
        const v = validateRequest(record); if (!v.ok) throw new TypeError(`a request needs the writer's literal: ${v.reason}`);
        if (requests.some((r) => r.id === record.id)) throw new Error(`recruitment: a request with id ${record.id} already exists`);
        if (caseRefOf(record) && casesNow() !== undefined) { const c = casesNow(); if (!(Array.isArray(c) && c.some((k) => isPlainObject(k) && k.id === record.caseId))) throw refusal('RECRUITMENT_CASE_MISSING', `recruitment: request ${record.id} names case ${record.caseId}, which is not in the ${CASES_COLLECTION} collection (Q7b)`); }
        for (const g of guardianRefsOfRequest(record)) if (!stmts(sqlite).guardian.get(g)) throw refusal('RECRUITMENT_GUARDIAN_MISSING', `recruitment: request ${record.id} names guardian ${g}, which does not exist (Q7c)`);
        requests.push(record); return record;
      });
    },
    /** A new trial at the end (the former `db.trials.push`): its request must exist in the collection. */
    addTrial(record) {
      return mutate(() => {
        const v = validateTrial(record); if (!v.ok) throw new TypeError(`a trial needs the writer's literal: ${v.reason}`);
        if (trials.some((t) => t.id === record.id)) throw new Error(`recruitment: a trial with id ${record.id} already exists`);
        if (!requests.some((r) => r.id === record.requestId)) throw refusal('RECRUITMENT_REQUEST_MISSING', `recruitment: trial ${record.id} names request ${record.requestId}, which is not in the requests collection`);
        if (trials.some((t) => t.requestId === record.requestId)) throw new Error(`recruitment: request ${record.requestId} already has trial ${trials.find((t) => t.requestId === record.requestId).id}; a request has one trial`);
        if (caseRefOf(record) && casesNow() !== undefined) { const c = casesNow(); if (!(Array.isArray(c) && c.some((k) => isPlainObject(k) && k.id === record.caseId))) throw refusal('RECRUITMENT_CASE_MISSING', `recruitment: trial ${record.id} names case ${record.caseId}, which is not in the ${CASES_COLLECTION} collection (Q7b)`); }
        for (const g of guardianRefsOfTrial(record)) if (!stmts(sqlite).guardian.get(g)) throw refusal('RECRUITMENT_GUARDIAN_MISSING', `recruitment: trial ${record.id} names guardian ${g}, which does not exist (Q7c)`);
        trials.push(record); return record;
      });
    },
    /** The deletion unit's tombstones (the former array replacements): every record of the player replaced in place by `request(r)` / `trial(t)`; ids and positions kept. Returns the counts. */
    tombstoneForPlayer(playerId, { request, trial }) {
      return mutate(() => {
        if (!nonEmpty(playerId)) throw new TypeError('recruitment: tombstoneForPlayer needs a player id');
        let n = 0;
        for (let i = 0; i < requests.length; i++) if (requests[i].playerId === playerId) { const next = request(requests[i]); if (!isPlainObject(next) || next.id !== requests[i].id) throw new Error(`recruitment: a tombstone keeps the id (${requests[i].id})`); requests[i] = next; n += 1; }
        let m = 0;
        for (let i = 0; i < trials.length; i++) if (trials[i].playerId === playerId) { const next = trial(trials[i]); if (!isPlainObject(next) || next.id !== trials[i].id || next.requestId !== trials[i].requestId) throw new Error(`recruitment: a tombstone keeps the id and the request (${trials[i].id})`); trials[i] = next; m += 1; }
        return { requests: n, trials: m };
      });
    },
    /** The derived `players[].trialReports`: the reports filed on the player's trials, in filing order (S5's rule), read from the mirror. */
    trialReportsFor: (playerId) => trialReportsOf(trials, playerId),
    /** Every record in its legacy shape, detached (the admin backup). */
    exportRequests: () => requests.map(copyRecord),
    exportTrials: () => trials.map(copyRecord),

    // ---------------------------------------------------------- the save hook
    flush() {
      if (!sqlite.isTransaction) throw new Error('recruitment.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      const changedR = new Set(); const changedT = new Set();
      for (const r of requests) if (committed.requests.get(r.id) !== fp(r)) changedR.add(r.id);
      for (const t of trials) if (committed.trials.get(t.id) !== fp(t)) changedT.add(t.id);
      const removedR = [...committed.requests.keys()].filter((id) => !requests.some((r) => r.id === id)); const removedT = [...committed.trials.keys()].filter((id) => !trials.some((t) => t.id === id));
      const touched = changedR.size + changedT.size + removedR.length + removedT.length > 0;
      if (touched) {
        for (const r of changedR) { const rec = requests.find((x) => x.id === r); const v = validateRequest(rec); if (!v.ok) throw new TypeError(`recruitment: a request cannot be saved: ${v.reason}`); }
        for (const t of changedT) { const rec = trials.find((x) => x.id === t); const v = validateTrial(rec); if (!v.ok) throw new TypeError(`recruitment: a trial cannot be saved: ${v.reason}`); }
        phases123(sqlite, { requests: changedR.size || removedR.length ? requests : undefined, trials: changedT.size || removedT.length ? trials : undefined }, { only: new Set([...changedR, ...changedT]) });
        prune(sqlite, { requests: removedR.length ? requests : undefined, label: 'the save' });
      }
      assertRecruitmentConsistent(sqlite, { cases: casesNow(), label: 'the save (requests, trials, recruitmentCases and guardians together)' });
      inFlight = { requests: new Map([...changedR].map((id) => [id, fp(requests.find((x) => x.id === id))])), trials: new Map([...changedT].map((id) => [id, fp(trials.find((x) => x.id === id))])), removedR, removedT };
      return changedR.size + changedT.size + removedR.length + removedT.length;
    },
    commit() { if (!inFlight) return; for (const [id, f] of inFlight.requests) committed.requests.set(id, f); for (const [id, f] of inFlight.trials) committed.trials.set(id, f); for (const id of inFlight.removedR) committed.requests.delete(id); for (const id of inFlight.removedT) committed.trials.delete(id); inFlight = null; },
    rollback() { inFlight = null; },
    /** Unit-of-work participation: the graph memento of both mirrors, restored IN PLACE (every record, nested object and array by identity). The committed fingerprints are not part of it: they reflect committed state, which a rollback does not change. */
    snapshotState: () => ({ graph: captureGraph([requests, trials]) }),
    restoreState(state) { if (!state) return; inFlight = null; restoreGraph(state.graph); },
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
void readonlyView;
