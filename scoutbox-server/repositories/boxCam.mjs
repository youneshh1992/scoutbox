/**
 * Box Cam, the At-Home Combine and the production CV results.
 *
 * Records:
 *   - Box Cam privacy preferences, one per player who ever saved them. Reading never creates a row: a player with no
 *     row has the defaults (`defaultPrefs`).
 *   - Box Challenges (an organisation's, or ScoutBox's own two, which the migration inserts) and the entries players
 *     join, one per challenge and player. An entry's session ids are not stored: progress is worked out from the
 *     sessions on every finalize.
 *   - Box assignments a verified club gives a player (its target as columns; the objective it serves a key).
 *   - Box sessions, server-minted. The nonce is stored only as its SHA-256 (`nonceHash`); the plain value exists in the
 *     creation response alone. The accepted observation stream is ordered child rows (`box_session_observations`),
 *     read only by finalize (`observationsOf`); the verification reasons and the append-only integrity history are child
 *     rows too. A session cites at most one challenge entry (a column). `integrity`, `captureMode` and the note's
 *     provenance are constants, worked out by the view.
 *   - Disputes of a session's result, with their resolution as columns.
 *   - Combine requests (the protocols as ordered rows) and Combine attempts (the reasons and the calibration checks as
 *     ordered rows; the calibration a protocol requires comes from its pinned version, never stored).
 *   - Production CV results: the provider's canonical result, decomposed into columns, its quality reasons and
 *     secondary diagnostics as coded rows and its bounded trace as rows. Immutable once recorded.
 *
 * WRITES are explicit: `create(record)` and `update(id, (draft) => …)` (the draft typed whole, fields that never change
 * kept, a nested update refused), plus `sessions.recordBatch` (append accepted observations), `prefs.save` and
 * `cvResults.record`. Each joins the open unit of work, the caller's open transaction, or opens its own.
 *
 * Queries decode deep-frozen records, a list's child rows in one batch. Modules receive them as `boxCamReads`.
 *
 * References. Player, guardian, media and staff-author ids on a player's own records carry no key (tolerant).
 * Organisations → orgs, the assigning or requesting staff → org_users and an assignment's objective → dev_objectives
 * are immediate RESTRICT, as are the keys between this domain's tables. Child rows cascade with their owner, which is
 * never deleted.
 */
import crypto from 'node:crypto';
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, num, bool, oneOf, group, tableDdl, bad, typeSpec, encode, decode, upsertSql, insertSql, flat } from './fieldSpecs.mjs';
import { QUALITY } from '../domains/development/boxcam/shared.mjs';
import { DRILLS, PROVIDERS, LIVENESS_CHALLENGES } from '../domains/development/boxcam/drills.mjs';
import { combineProtocol, METRIC_TYPES } from '../domains/development/boxcam/combineShared.mjs';
import { CANDIDATE_PROTOCOLS, CV_PROVIDER_ID } from '../domains/development/boxcam/cv/policy.mjs';

export const BOX_CAM_MIGRATION = '0031_box_cam';
export const BOX_CAM_COLLECTIONS = Object.freeze([
  'boxCamPrefs', 'boxChallenges', 'boxChallengeEntries', 'boxAssignments', 'boxSessions', 'boxCamDisputes',
  'combineRequests', 'combineAttempts', 'boxCamCvResults',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const SHARE_CHOICES = Object.freeze(['private', 'recruitment']);
export const PREF_ACTOR_KINDS = Object.freeze(['player', 'guardian']);
export const CHALLENGE_METRICS = Object.freeze(['reps', 'active_minutes']);
export const CHALLENGE_PUBLISHERS = Object.freeze(['org', 'scoutbox']);
export const ENTRY_STATUSES = Object.freeze(['active', 'completed']);
/** 'superseded' was read in places but never written: not a state. */
export const ASSIGNMENT_STATES = Object.freeze(['assigned', 'accepted', 'in_progress', 'partially_completed', 'completed', 'cancelled']);
/** The target types a drill offers (the engine also knows 'combined', which no drill offers). */
export const BOX_TARGET_TYPES = Object.freeze([...new Set(DRILLS.flatMap((d) => d.targetTypes))]);
/** SESSION_STATES that are ever written ('not_started' and 'ready' never are). */
export const SESSION_STATUSES = Object.freeze(['setup_required', 'recording', 'processing', 'verified', 'partially_verified', 'unable_to_verify', 'completed_unverified', 'cancelled', 'invalidated']);
export const VERIFICATION_STATES = Object.freeze(['verified', 'partially_verified', 'unable_to_verify', 'completed_unverified', 'cancelled', 'invalidated']);
export const RESTORABLE_STATES = Object.freeze(VERIFICATION_STATES.filter((s) => s !== 'invalidated'));
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
export const CAPTURE_CONTEXTS = Object.freeze(['at_home', 'club', 'event']);
export const OBSERVATION_KINDS = Object.freeze(['active', 'presence', 'ball', 'rep', 'set', 'pause', 'interruption', 'multi_person']);
export const DISPUTE_OUTCOMES = Object.freeze(['stands', 'invalidated', 'provider_bug']);
export const REQUEST_STATES = Object.freeze(['requested', 'completed', 'cancelled']);
export const ATTEMPT_MODES = Object.freeze(['verified', 'practice']);
export const COMBINE_STATES_STORED = Object.freeze(['ready', 'combine_verified', 'partially_measured', 'measurement_unavailable', 'protocol_invalid', 'invalidated', 'cancelled']);
export const MEASUREMENT_STATES = Object.freeze(['measured', 'practice', 'partially_measured', 'measurement_unavailable', 'protocol_invalid', 'invalidated', 'cancelled']);
export const DIRECTIONS = Object.freeze(['higher', 'lower']);
export const BOX_CAM_LIMITS = Object.freeze({
  id: 80, name: 200, role: 80, title: 120, instructions: 300, note: 300, disputeReason: 500, resolutionReason: 400,
  hash: 64, code: 80, detail: 300, unit: 40, calibrationChecks: 10, calibrationCheck: 60, protocols: 20, reasons: 40,
  qualityReasons: 40, trace: 256, maxObservations: 4_000,
});
const L = BOX_CAM_LIMITS;
/** A machine reason code: upper or lower snake case. */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const CODE_SQL = (c) => `length(${c}) > 0 AND length(${c}) <= ${L.code} AND ${c} NOT GLOB '*[^A-Za-z0-9_]*'`;

export const hashNonce = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');
/** Does the plain `nonce` a client sent match the stored hash? Constant time; a missing nonce never matches. */
export function nonceMatches(session, nonce) {
  if (typeof nonce !== 'string' || !nonce || !session?.nonceHash) return false;
  const a = Buffer.from(hashNonce(nonce), 'hex'); const b = Buffer.from(session.nonceHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const defaultPrefs = (playerId) => ({ playerId, shareDevelopmentActivity: 'private', retainClips: false, updatedAt: null, updatedBy: null });

/** The ScoutBox challenges the migration inserts. */
export function scoutboxChallenges(now) {
  return [
    { id: 'boxc-scoutbox-1000-touch', title: 'The 1,000 Touch Box Challenge', publisher: { kind: 'scoutbox' }, drillId: 'box-touches', metric: 'reps', targetTotal: 1000, startsAt: now, endsAt: now + 30 * 86_400_000, adultOnly: false, cap: null, status: 'active', createdAt: now },
    { id: 'boxc-scoutbox-first-touch', title: '7-Day First Touch Box Challenge', publisher: { kind: 'scoutbox' }, drillId: 'box-control', metric: 'active_minutes', targetTotal: 60, startsAt: now, endsAt: now + 7 * 86_400_000, adultOnly: false, cap: null, status: 'active', createdAt: now },
  ];
}

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const PREFS_SPEC = [
  idf('playerId', 'player_id', req), oneOf('shareDevelopmentActivity', 'share_development_activity', SHARE_CHOICES, req), bool('retainClips', 'retain_clips', req),
  int('updatedAt', 'updated_at'), group('updatedBy', [oneOf('kind', 'updated_by_kind', PREF_ACTOR_KINDS, req), idf('id', 'updated_by_id', req)], { nullable: true }),
];
const CHALLENGE_SPEC = [
  idf('id', 'id', req), text('title', 'title', L.title, { req: true, nonEmpty: true }),
  group('publisher', [oneOf('kind', 'publisher_kind', CHALLENGE_PUBLISHERS, req), idf('orgId', 'publisher_org_id'), text('orgName', 'publisher_org_name', L.name), text('byName', 'publisher_by_name', L.name)], { sparse: true }),
  idf('drillId', 'drill_id', req), oneOf('metric', 'metric', CHALLENGE_METRICS, req), int('targetTotal', 'target_total', req),
  int('startsAt', 'starts_at', req), int('endsAt', 'ends_at', req), bool('adultOnly', 'adult_only', req), int('cap', 'cap'),
  oneOf('status', 'status', ['active'], req), int('createdAt', 'created_at', req),
];
const ENTRY_SPEC = [
  idf('id', 'id', req), idf('challengeId', 'challenge_id', req), idf('playerId', 'player_id', req), oneOf('status', 'status', ENTRY_STATUSES, req),
  int('progress', 'progress', req), int('joinedAt', 'joined_at', req),
  group('joinedBy', [oneOf('kind', 'joined_by_kind', PREF_ACTOR_KINDS, req), idf('id', 'joined_by_id', req)]), int('completedAt', 'completed_at'),
];
const ASSIGNMENT_SPEC = [
  idf('id', 'id', req), idf('playerId', 'player_id', req), idf('orgId', 'org_id', req), text('orgName', 'org_name', L.name),
  group('assignedBy', [idf('userId', 'assigned_by_user_id', req), text('name', 'assigned_by_name', L.name), text('role', 'assigned_by_role', L.role), bool('orgVerifiedAtAssignment', 'assigned_by_org_verified', req), int('at', 'assigned_at', req)]),
  idf('drillId', 'drill_id', req), int('drillVersion', 'drill_version', req),
  group('target', [oneOf('type', 'target_type', BOX_TARGET_TYPES, req), num('value', 'target_value', req)]),
  int('frequencyPerWeek', 'frequency_per_week'), text('dueDate', 'due_date', 10), text('instructions', 'instructions', L.instructions),
  idf('objectiveId', 'objective_id'), oneOf('state', 'state', ASSIGNMENT_STATES, req), int('createdAt', 'created_at', req), int('updatedAt', 'updated_at', req),
];
const SESSION_SPEC = [
  idf('id', 'id', req), idf('playerId', 'player_id', req), idf('drillId', 'drill_id', req), int('drillVersion', 'drill_version', req),
  idf('assignmentId', 'assignment_id'), idf('challengeEntryId', 'challenge_entry_id'),
  group('target', [oneOf('type', 'target_type', BOX_TARGET_TYPES, req), num('value', 'target_value', req)]),
  text('nonceHash', 'nonce_hash', L.hash, { req: true, nonEmpty: true }), oneOf('livenessChallenge', 'liveness_challenge', LIVENESS_CHALLENGES, req),
  oneOf('provider', 'provider_id', PROVIDER_IDS, req), int('providerVersion', 'provider_version', req), oneOf('status', 'status', SESSION_STATUSES, req),
  int('createdAt', 'created_at', req), int('expiresAt', 'expires_at', req), int('startedAt', 'started_at'), int('endedAt', 'ended_at'), int('livenessPassedAt', 'liveness_passed_at'),
  int('lastSeq', 'last_seq', req), int('batches', 'batches', req), oneOf('captureContext', 'capture_context', CAPTURE_CONTEXTS),
  num('sessionDurationMs', 'session_duration_ms'), num('verifiedActiveMs', 'verified_active_ms'), int('verifiedReps', 'verified_reps'), int('setsCompleted', 'sets_completed'),
  bool('targetCompleted', 'target_completed'), oneOf('quality', 'quality', QUALITY), int('interruptionsCount', 'interruptions_count'),
  oneOf('verificationState', 'verification_state', VERIFICATION_STATES), text('resultHash', 'result_hash', L.hash), int('finalizedAt', 'finalized_at'),
  text('note', 'note', L.note), idf('clipMediaId', 'clip_media_id'), oneOf('previousVerificationState', 'previous_verification_state', RESTORABLE_STATES),
  int('invalidatedAt', 'invalidated_at'), idf('cvProviderSessionId', 'cv_provider_session_id'),
];
const INTEGRITY_SPEC = [
  oneOf('type', 'type', ['invalidated', 'restored'], req), int('at', 'at', req), idf('disputeId', 'dispute_id'),
  oneOf('outcome', 'outcome', ['invalidated', 'provider_bug']), oneOf('to', 'to_state', RESTORABLE_STATES),
];
const DISPUTE_SPEC = [
  idf('id', 'id', req), idf('sessionId', 'session_id', req), idf('playerId', 'player_id', req),
  group('by', [oneOf('kind', 'by_kind', PREF_ACTOR_KINDS, req), idf('id', 'by_id', req), text('name', 'by_name', L.name)]),
  text('reason', 'reason', L.disputeReason, { req: true, nonEmpty: true }), oneOf('status', 'status', ['open', 'resolved'], req),
  group('resolution', [oneOf('outcome', 'resolution_outcome', DISPUTE_OUTCOMES, req), text('reason', 'resolution_reason', L.resolutionReason, { req: true, nonEmpty: true }), int('at', 'resolved_at', req)], { nullable: true }),
  int('createdAt', 'created_at', req),
];
const REQUEST_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('orgName', 'org_name', L.name),
  group('requestedBy', [idf('userId', 'requested_by_user_id', req), text('name', 'requested_by_name', L.name), text('role', 'requested_by_role', L.role), int('at', 'requested_at', req)]),
  idf('playerId', 'player_id', req), text('title', 'title', L.title, { nonEmpty: true }), text('deadline', 'deadline_date', 10),
  text('instructions', 'instructions', L.instructions), oneOf('state', 'state', REQUEST_STATES, req), int('createdAt', 'created_at', req), int('completedAt', 'completed_at'),
];
const ATTEMPT_SPEC = [
  idf('id', 'id', req), idf('playerId', 'player_id', req), idf('protocolId', 'protocol_id', req), int('protocolVersion', 'protocol_version', req),
  idf('boxSessionId', 'box_session_id', req), int('attemptNumber', 'attempt_number', req), oneOf('mode', 'mode', ATTEMPT_MODES, req),
  oneOf('captureContext', 'capture_context', CAPTURE_CONTEXTS, req), idf('requestId', 'request_id'),
  oneOf('metricType', 'metric_type', METRIC_TYPES, req), text('metricUnit', 'metric_unit', L.unit, { req: true, nonEmpty: true }), oneOf('direction', 'direction', DIRECTIONS, req),
  int('measurementAlgorithmVersion', 'measurement_algorithm_version', req), oneOf('provider', 'provider_id', PROVIDER_IDS, req), int('providerVersion', 'provider_version', req),
  num('measuredValue', 'measured_value'), oneOf('measurementState', 'measurement_state', MEASUREMENT_STATES), oneOf('combineState', 'combine_state', COMBINE_STATES_STORED, req),
  int('startedAt', 'started_at'), int('completedAt', 'completed_at'), text('resultHash', 'result_hash', L.hash), int('createdAt', 'created_at', req),
];
const CALIBRATION_SPEC = [bool('passed', 'calibration_passed', req), int('at', 'calibrated_at', req)];
const CV_SPEC = [
  idf('providerSessionId', 'provider_session_id', req), idf('sessionId', 'session_id', req), oneOf('protocolId', 'protocol_id', Object.keys(CANDIDATE_PROTOCOLS), req),
  oneOf('providerId', 'provider_id', [CV_PROVIDER_ID], req), int('providerVersion', 'provider_version', req), int('engineVersion', 'engine_version', req), int('cvPolicyVersion', 'cv_policy_version', req),
  oneOf('outcome', 'outcome', ['accepted', 'refused'], req), text('refusalReason', 'refusal_reason', L.code), text('refusalDetail', 'refusal_detail', L.detail),
  group('observationQuality', [bool('sufficient', 'oq_sufficient', req), oneOf('state', 'oq_state', ['sufficient', 'insufficient']), num('aggregateConfidence', 'oq_aggregate_confidence'), num('coverage', 'oq_coverage')]),
  group('derived', [bool('personPresent', 'person_present', req), bool('ballPresent', 'ball_present', req), int('touchCount', 'touch_count'), int('juggleCount', 'juggle_count'), num('activeDurationMs', 'active_duration_ms', req)]),
  group('experimental', [int('exactCount', 'experimental_exact_count'), oneOf('status', 'experimental_status', ['experimental_unvalidated'], req)]),
  group('integrity', [
    bool('ok', 'integrity_ok', req), int('framesAccepted', 'frames_accepted', req), int('framesRejected', 'frames_rejected', req), int('framesDroppedByServer', 'frames_dropped_by_server', req),
    int('duplicatesRejected', 'duplicates_rejected', req), int('outOfOrderRejected', 'out_of_order_rejected', req), int('clientClockAnomalies', 'client_clock_anomalies', req),
    int('framesAnalysed', 'frames_analysed'), int('duplicateFrames', 'duplicate_frames'), num('effectiveFps', 'effective_fps'), num('maxBallGapMs', 'max_ball_gap_ms'),
    bool('nonceBound', 'nonce_bound', req), bool('serverTimeline', 'server_timeline', req),
  ]),
  bool('traceTruncated', 'trace_truncated', req), int('serverStartedAt', 'server_started_at'), int('serverEndedAt', 'server_ended_at'), int('serverDurationMs', 'server_duration_ms', req),
  bool('combineVerified', 'combine_verified', req), text('combineVerifiedBlockedBy', 'combine_verified_blocked_by', L.code),
];
/** The constant copy every experimental count carries (stated on the result, never stored). */
export const EXPERIMENTAL_NOTE = 'Experimental observation. Not a standardised Combine measurement.';

// ------------------------------------------------------------------ DDL (generated from the specs)
const rowOf = (name, c) => `FOREIGN KEY (${c}) REFERENCES ${name}(id) ON DELETE RESTRICT`;
const ownedBy = (name, c, col = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${col}) ON DELETE CASCADE`;
const pad = (c) => c.padEnd(40);
const idCol = (c) => `${pad(c)} TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`;
const ordCol = (max = null) => `${pad('ord')} INTEGER NOT NULL CHECK (ord >= 0${max ? ` AND ord < ${max}` : ''})`;
const codeCol = (c = 'code') => `${pad(c)} TEXT NOT NULL CHECK (${CODE_SQL(c)})`;
const DAY_SQL = (c) => `(${c} IS NULL OR (length(${c}) = 10 AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'))`;
const codeTable = (table, parent, parentTable, max, parentCol = 'id') => `CREATE TABLE ${table} (\n  ${idCol(parent)},\n  ${ordCol(max)},\n  ${codeCol()},\n  ${ownedBy(parentTable, parent, parentCol)},\n  PRIMARY KEY (${parent}, ord)\n) STRICT;`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');

export const BOX_CAM_DDL = [
  tableDdl('box_cam_prefs', PREFS_SPEC, ['PRIMARY KEY (player_id)', 'CHECK ((updated_at IS NULL) = (updated_by_kind IS NULL))']),
  tableDdl('box_challenges', CHALLENGE_SPEC, [
    rowOf('orgs', 'publisher_org_id'),
    "CHECK ((publisher_kind = 'org') = (publisher_org_id IS NOT NULL))",
    "CHECK (publisher_kind = 'org' OR (publisher_org_name IS NULL AND publisher_by_name IS NULL))",
    'CHECK (target_total >= 1)', 'CHECK (ends_at > starts_at)', 'CHECK (cap IS NULL OR cap >= 1)',
  ]),
  'CREATE INDEX box_challenges_publisher_org ON box_challenges (publisher_org_id) WHERE publisher_org_id IS NOT NULL;',
  'CREATE INDEX box_challenges_status_ends ON box_challenges (status, ends_at);',
  tableDdl('box_challenge_entries', ENTRY_SPEC, [rowOf('box_challenges', 'challenge_id'), 'CHECK (progress >= 0)', "CHECK ((status = 'completed') = (completed_at IS NOT NULL))"]),
  'CREATE UNIQUE INDEX box_challenge_entries_challenge_player ON box_challenge_entries (challenge_id, player_id);',
  'CREATE INDEX box_challenge_entries_player ON box_challenge_entries (player_id, status);',
  tableDdl('box_assignments', ASSIGNMENT_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('org_users', 'assigned_by_user_id'), rowOf('dev_objectives', 'objective_id'),
    'CHECK (target_value > 0)', 'CHECK (frequency_per_week IS NULL OR frequency_per_week BETWEEN 1 AND 14)', `CHECK ${DAY_SQL('due_date')}`,
  ]),
  'CREATE INDEX box_assignments_org ON box_assignments (org_id, player_id);',
  'CREATE INDEX box_assignments_player ON box_assignments (player_id);',
  tableDdl('box_sessions', SESSION_SPEC, [
    rowOf('box_assignments', 'assignment_id'), rowOf('box_challenge_entries', 'challenge_entry_id'),
    'CHECK (length(nonce_hash) = 64)', 'CHECK (last_seq >= 0 AND batches >= 0)',
    "CHECK (status NOT IN ('verified','partially_verified','unable_to_verify','completed_unverified','invalidated') OR status = verification_state)",
    "CHECK ((verification_state = 'invalidated') = (previous_verification_state IS NOT NULL))",
  ]),
  'CREATE INDEX box_sessions_player ON box_sessions (player_id, ended_at);',
  'CREATE INDEX box_sessions_assignment ON box_sessions (assignment_id) WHERE assignment_id IS NOT NULL;',
  `CREATE TABLE box_session_observations (\n  ${idCol('session_id')},\n  ${ordCol(L.maxObservations)},\n  ${pad('kind')} TEXT NOT NULL CHECK (kind IN (${enumIn(OBSERVATION_KINDS)})),\n  ${pad('from_ms')} REAL,\n  ${pad('to_ms')} REAL,\n  ${pad('at_ms')} REAL,\n  ${pad('quality')} TEXT CHECK (quality IS NULL OR quality IN (${enumIn(QUALITY)})),\n  ${pad('confidence')} REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),\n  ${ownedBy('box_sessions', 'session_id')},\n  PRIMARY KEY (session_id, ord),\n  CHECK (kind NOT IN ('active','presence','ball','interruption','multi_person') OR (from_ms IS NOT NULL AND to_ms IS NOT NULL AND at_ms IS NULL)),\n  CHECK (kind NOT IN ('rep','set') OR (at_ms IS NOT NULL AND from_ms IS NULL AND to_ms IS NULL)),\n  CHECK (kind <> 'pause' OR (from_ms IS NOT NULL AND at_ms IS NULL)),\n  CHECK (kind IN ('active','presence') OR quality IS NULL),\n  CHECK (kind = 'rep' OR confidence IS NULL)\n) STRICT;`,
  codeTable('box_session_reasons', 'session_id', 'box_sessions', L.reasons),
  tableDdl('box_session_integrity_events', [idf('sessionId', 'session_id', req), int('ord', 'ord', req), ...INTEGRITY_SPEC], [
    ownedBy('box_sessions', 'session_id'), 'PRIMARY KEY (session_id, ord)', 'CHECK (ord >= 0)',
    "CHECK ((type = 'invalidated') = (outcome IS NOT NULL))", "CHECK ((type = 'restored') = (to_state IS NOT NULL))", "CHECK (type = 'invalidated' OR dispute_id IS NULL)",
  ]),
  tableDdl('box_cam_disputes', DISPUTE_SPEC, [ownedBy('box_sessions', 'session_id'), "CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))"]),
  'CREATE INDEX box_cam_disputes_queue ON box_cam_disputes (status, created_at, id);',
  'CREATE INDEX box_cam_disputes_created ON box_cam_disputes (created_at, id);',
  tableDdl('combine_requests', REQUEST_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('org_users', 'requested_by_user_id'), `CHECK ${DAY_SQL('deadline_date')}`,
    "CHECK ((state = 'completed') = (completed_at IS NOT NULL) OR state = 'cancelled')",
  ]),
  'CREATE INDEX combine_requests_org ON combine_requests (org_id, player_id);',
  'CREATE INDEX combine_requests_player ON combine_requests (player_id, state);',
  `CREATE TABLE combine_request_protocols (\n  ${idCol('request_id')},\n  ${ordCol(L.protocols)},\n  ${idCol('protocol_id')},\n  ${ownedBy('combine_requests', 'request_id')},\n  PRIMARY KEY (request_id, ord),\n  UNIQUE (request_id, protocol_id)\n) STRICT;`,
  tableDdl('combine_attempts', [...ATTEMPT_SPEC, ...CALIBRATION_SPEC.map((f) => ({ ...f, req: false }))], [
    rowOf('box_sessions', 'box_session_id'), rowOf('combine_requests', 'request_id'),
    'CHECK ((calibration_passed IS NULL) = (calibrated_at IS NULL))', 'CHECK (attempt_number >= 1)',
  ]),
  'CREATE UNIQUE INDEX combine_attempts_box_session ON combine_attempts (box_session_id);',
  'CREATE INDEX combine_attempts_player ON combine_attempts (player_id, protocol_id, created_at);',
  codeTable('combine_attempt_reasons', 'attempt_id', 'combine_attempts', L.reasons),
  `CREATE TABLE combine_attempt_calibration_checks (\n  ${idCol('attempt_id')},\n  ${ordCol(L.calibrationChecks)},\n  ${pad('check_name')} TEXT NOT NULL CHECK (length(check_name) > 0 AND length(check_name) <= ${L.calibrationCheck}),\n  ${ownedBy('combine_attempts', 'attempt_id')},\n  PRIMARY KEY (attempt_id, ord)\n) STRICT;`,
  tableDdl('box_cam_cv_results', CV_SPEC, [
    ownedBy('box_sessions', 'session_id'), 'PRIMARY KEY (provider_session_id)',
    "CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL))", 'CHECK (combine_verified = 0)',
  ]),
  'CREATE INDEX box_cam_cv_results_session ON box_cam_cv_results (session_id);',
  `CREATE TABLE box_cam_cv_result_codes (\n  ${idCol('provider_session_id')},\n  ${pad('list')} TEXT NOT NULL CHECK (list IN ('quality','secondary')),\n  ${ordCol(L.qualityReasons)},\n  ${codeCol()},\n  ${pad('value')} REAL,\n  ${pad('threshold')} REAL,\n  ${ownedBy('box_cam_cv_results', 'provider_session_id', 'provider_session_id')},\n  PRIMARY KEY (provider_session_id, list, ord),\n  CHECK (list = 'quality' OR (value IS NULL AND threshold IS NULL))\n) STRICT;`,
  `CREATE TABLE box_cam_cv_result_trace (\n  ${idCol('provider_session_id')},\n  ${ordCol(L.trace)},\n  ${pad('at_ms')} REAL,\n  ${pad('confidence')} REAL,\n  ${ownedBy('box_cam_cv_results', 'provider_session_id', 'provider_session_id')},\n  PRIMARY KEY (provider_session_id, ord)\n) STRICT;`,
].join('\n');
export const BOX_CAM_TABLES = Object.freeze([
  'box_cam_prefs', 'box_challenges', 'box_challenge_entries', 'box_assignments', 'box_sessions', 'box_session_observations', 'box_session_reasons',
  'box_session_integrity_events', 'box_cam_disputes', 'combine_requests', 'combine_request_protocols', 'combine_attempts', 'combine_attempt_reasons',
  'combine_attempt_calibration_checks', 'box_cam_cv_results', 'box_cam_cv_result_codes', 'box_cam_cv_result_trace',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : isPlainObject(raw) && typeof raw.providerSessionId === 'string' ? raw.providerSessionId : ''}`.trim();
function typeCodes(list, label, field, max) {
  if (list === undefined || list === null) return { ok: true, value: [] };
  if (!Array.isArray(list)) return bad(label, field, `must be a list (got ${describe(list)})`);
  if (list.length > max) return bad(label, field, `holds more than ${max} entries`);
  const i = list.findIndex((x) => typeof x !== 'string' || x.length > L.code || !CODE_RE.test(x));
  if (i >= 0) return bad(label, `${field}[${i}]`, `must be a reason code (got ${describe(list[i])})`);
  return { ok: true, value: [...list] };
}
const isMs = (v) => typeof v === 'number' && Number.isFinite(v);

export const typePrefs = (raw, at = 'boxCamPrefs') => {
  const t = typeSpec(PREFS_SPEC, raw, isPlainObject(raw) ? `${at} ${raw.playerId ?? ''}`.trim() : at);
  if (t.ok && (t.record.updatedAt === null) !== (t.record.updatedBy === null)) return bad(at, 'updatedBy', 'is recorded exactly when the preferences were saved');
  return t;
};
export function typeChallenge(raw, at = 'boxChallenges') {
  const label = labelOf(at, raw);
  const t = typeSpec(CHALLENGE_SPEC, raw, label); if (!t.ok) return t;
  const r = t.record; const p = r.publisher;
  if ((p.kind === 'org') !== (p.orgId !== undefined && p.orgId !== null)) return bad(label, 'publisher.orgId', 'is set exactly for an organisation publisher');
  if (p.kind !== 'org' && (p.orgName != null || p.byName != null)) return bad(label, 'publisher', 'names an organisation only for an organisation publisher');
  if (r.targetTotal < 1) return bad(label, 'targetTotal', 'must be at least 1');
  if (r.endsAt <= r.startsAt) return bad(label, 'endsAt', 'must be after startsAt');
  if (r.cap !== null && r.cap < 1) return bad(label, 'cap', 'must be at least 1 or null');
  return t;
}
export function typeEntry(raw, at = 'boxChallengeEntries') {
  const label = labelOf(at, raw);
  if (isPlainObject(raw) && Object.hasOwn(raw, 'sessionIds')) { const { sessionIds: _derived, ...rest } = raw; raw = rest; } // worked out on every finalize, never stored
  const t = typeSpec(ENTRY_SPEC, raw, label); if (!t.ok) return t;
  if ((t.record.status === 'completed') !== (t.record.completedAt !== null)) return bad(label, 'completedAt', 'is set exactly when the entry is completed');
  if (t.record.progress < 0) return bad(label, 'progress', 'must not be negative');
  return t;
}
export function typeAssignment(raw, at = 'boxAssignments') {
  const label = labelOf(at, raw);
  const t = typeSpec(ASSIGNMENT_SPEC, raw, label); if (!t.ok) return t;
  const r = t.record;
  if (!(r.target.value > 0)) return bad(label, 'target.value', 'must be greater than 0');
  if (r.frequencyPerWeek !== null && (r.frequencyPerWeek < 1 || r.frequencyPerWeek > 14)) return bad(label, 'frequencyPerWeek', 'must be from 1 to 14');
  if (r.dueDate !== null && !DAY_RE.test(r.dueDate)) return bad(label, 'dueDate', 'must be a day written YYYY-MM-DD');
  return t;
}
function typeIntegrityEvent(raw, at) {
  const t = typeSpec(INTEGRITY_SPEC, raw, at); if (!t.ok) return t;
  const r = t.record;
  if ((r.type === 'invalidated') !== (r.outcome !== null)) return bad(at, 'outcome', 'is recorded exactly on an invalidation');
  if ((r.type === 'restored') !== (r.to !== null)) return bad(at, 'to', 'is recorded exactly on a restore');
  if (r.type === 'restored' && r.disputeId !== null) return bad(at, 'disputeId', 'is recorded on an invalidation only');
  return { ok: true, record: Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) };
}
/** One accepted observation as the events route maps it: `{ kind, fromMs?, toMs?, atMs?, quality?, confidence? }`. */
export function typeObservation(raw, at) {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !['kind', 'fromMs', 'toMs', 'atMs', 'quality', 'confidence'].includes(k));
  if (unknown.length) return { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` };
  const { kind, fromMs = null, toMs = null, atMs = null, quality = null, confidence = null } = raw;
  if (!OBSERVATION_KINDS.includes(kind)) return bad(at, 'kind', `must be one of ${OBSERVATION_KINDS.join('|')}`);
  const interval = ['active', 'presence', 'ball', 'interruption', 'multi_person'].includes(kind);
  for (const [k, v] of [['fromMs', fromMs], ['toMs', toMs], ['atMs', atMs]]) if (v !== null && !isMs(v)) return bad(at, k, `must be a number (got ${describe(v)})`);
  if (interval && (fromMs === null || toMs === null || atMs !== null)) return bad(at, 'fromMs', 'and toMs are required on an interval (and atMs is not)');
  if ((kind === 'rep' || kind === 'set') && (atMs === null || fromMs !== null || toMs !== null)) return bad(at, 'atMs', 'is required on a point observation (and fromMs/toMs are not)');
  if (kind === 'pause' && (fromMs === null || atMs !== null)) return bad(at, 'fromMs', 'is required on a pause');
  if (quality !== null && (!['active', 'presence'].includes(kind) || !QUALITY.includes(quality))) return bad(at, 'quality', `must be one of ${QUALITY.join('|')} on an active or presence interval`);
  if (confidence !== null && (kind !== 'rep' || !isMs(confidence) || confidence < 0 || confidence > 1)) return bad(at, 'confidence', 'must be a number from 0 to 1 on a rep');
  return { ok: true, record: { kind, fromMs, toMs, atMs, quality, confidence } };
}
const OBS_KEYS = { active: 'active', presence: 'presence', ball: 'ball', rep: 'reps', set: 'sets', pause: 'pauses', interruption: 'interruptions', multi_person: 'multiPerson' };
const emptyObs = () => ({ active: [], presence: [], ball: [], reps: [], sets: [], pauses: [], interruptions: [], multiPerson: [] });
/** The engine's view of the stream (what `finalize()` reads), from ordered rows. */
function obsFromRows(rows) {
  const obs = emptyObs();
  for (const r of rows) {
    const k = OBS_KEYS[r.kind];
    if (r.kind === 'rep') obs.reps.push({ atMs: r.atMs, confidence: r.confidence });
    else if (r.kind === 'set') obs.sets.push({ atMs: r.atMs });
    else if (r.kind === 'pause' || r.kind === 'ball' || r.kind === 'interruption' || r.kind === 'multi_person') obs[k].push({ fromMs: r.fromMs, toMs: r.toMs });
    else obs[k].push({ fromMs: r.fromMs, toMs: r.toMs, quality: r.quality });
  }
  return obs;
}
/** The rows of an engine-shaped stream, in kind order. */
function rowsFromObs(obs, label) {
  if (!isPlainObject(obs)) return bad(label, 'obs', `must be an object (got ${describe(obs)})`);
  const unknown = Object.keys(obs).filter((k) => !Object.values(OBS_KEYS).includes(k));
  if (unknown.length) return bad(label, 'obs', `names lists this build does not store: ${unknown.join(', ')}`);
  const rows = [];
  for (const [kind, key] of Object.entries(OBS_KEYS)) {
    for (const [i, x] of (obs[key] ?? []).entries()) {
      const t = typeObservation({ kind, ...(isPlainObject(x) ? x : { bad: x }) }, `${label}.obs.${key}[${i}]`); if (!t.ok) return t;
      rows.push(t.record);
    }
  }
  if (rows.length > L.maxObservations) return bad(label, 'obs', `holds more than ${L.maxObservations} observations`);
  return { ok: true, value: rows };
}
export function typeSession(raw, at = 'boxSessions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { verificationReasons = [], integrityEvents = [], obs, ...rest } = raw;
  const t = typeSpec(SESSION_SPEC, rest, label); if (!t.ok) return t;
  const r = t.record;
  if (r.nonceHash.length !== 64 || !/^[0-9a-f]+$/.test(r.nonceHash)) return bad(label, 'nonceHash', 'must be a SHA-256 in hex (the plain nonce is never stored)');
  if (VERIFICATION_STATES.includes(r.status) && r.status !== 'cancelled' && r.status !== r.verificationState) return bad(label, 'status', 'of a finished session is its verification state');
  if ((r.verificationState === 'invalidated') !== (r.previousVerificationState !== null)) return bad(label, 'previousVerificationState', 'is kept exactly while the result is invalidated');
  const reasons = typeCodes(verificationReasons, label, 'verificationReasons', L.reasons); if (!reasons.ok) return reasons;
  if (!Array.isArray(integrityEvents)) return bad(label, 'integrityEvents', `must be a list (got ${describe(integrityEvents)})`);
  const events = [];
  for (const [i, e] of integrityEvents.entries()) { const x = typeIntegrityEvent(e, `${label}.integrityEvents[${i}]`); if (!x.ok) return x; events.push(x.record); }
  const out = { ...r, verificationReasons: reasons.value, integrityEvents: events };
  if (obs !== undefined) { const o = rowsFromObs(obs, label); if (!o.ok) return o; out.obs = o.value; }
  return { ok: true, record: out };
}
export function typeDispute(raw, at = 'boxCamDisputes') {
  const label = labelOf(at, raw);
  const t = typeSpec(DISPUTE_SPEC, raw, label); if (!t.ok) return t;
  if ((t.record.status === 'resolved') !== (t.record.resolution !== null)) return bad(label, 'resolution', 'is recorded exactly when the dispute is resolved');
  return t;
}
export function typeRequest(raw, at = 'combineRequests') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { protocolIds, ...rest } = raw;
  const t = typeSpec(REQUEST_SPEC, rest, label); if (!t.ok) return t;
  const r = t.record;
  if (r.deadline !== null && !DAY_RE.test(r.deadline)) return bad(label, 'deadline', 'must be a day written YYYY-MM-DD');
  if (r.state === 'completed' && r.completedAt === null) return bad(label, 'completedAt', 'is set once the request is completed');
  if (r.state === 'requested' && r.completedAt !== null) return bad(label, 'completedAt', 'is set only once the request is completed');
  if (!Array.isArray(protocolIds) || !protocolIds.length || protocolIds.length > L.protocols) return bad(label, 'protocolIds', `must list 1 to ${L.protocols} protocols (got ${describe(protocolIds)})`);
  const i = protocolIds.findIndex((x) => typeof x !== 'string' || !x.length || x.length > L.id);
  if (i >= 0) return bad(label, `protocolIds[${i}]`, `must be a protocol id (got ${describe(protocolIds[i])})`);
  if (new Set(protocolIds).size !== protocolIds.length) return bad(label, 'protocolIds', 'names a protocol twice');
  return { ok: true, record: { ...r, protocolIds: [...protocolIds] } };
}
export function typeAttempt(raw, at = 'combineAttempts') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { reasons = [], calibrationResult = null, ...rest } = raw;
  const t = typeSpec(ATTEMPT_SPEC, rest, label); if (!t.ok) return t;
  const rs = typeCodes(reasons, label, 'reasons', L.reasons); if (!rs.ok) return rs;
  let cal = null;
  if (calibrationResult !== null) {
    if (!isPlainObject(calibrationResult)) return bad(label, 'calibrationResult', `must be an object or null (got ${describe(calibrationResult)})`);
    const { checks = [], required: _derived, ...c } = calibrationResult; // `required` is the pinned protocol's, worked out on read
    const ct = typeSpec(CALIBRATION_SPEC, c, `${label}.calibrationResult`); if (!ct.ok) return ct;
    if (!Array.isArray(checks) || checks.length > L.calibrationChecks) return bad(label, 'calibrationResult.checks', `must list at most ${L.calibrationChecks} checks`);
    const j = checks.findIndex((x) => typeof x !== 'string' || !x.length || x.length > L.calibrationCheck);
    if (j >= 0) return bad(label, `calibrationResult.checks[${j}]`, `must be text of 1 to ${L.calibrationCheck} characters (got ${describe(checks[j])})`);
    cal = { passed: ct.record.passed, checks: [...checks], at: ct.record.at };
  }
  if (t.record.attemptNumber < 1) return bad(label, 'attemptNumber', 'must be at least 1');
  return { ok: true, record: { ...t.record, calibrationResult: cal, reasons: rs.value } };
}
export function typeCvResult(raw, at = 'boxCamCvResults') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { observationQuality, experimental, trace = [], ...rest } = raw;
  if (!isPlainObject(observationQuality)) return bad(label, 'observationQuality', 'is required');
  if (!isPlainObject(experimental)) return bad(label, 'experimental', 'is required');
  const { reasons = [], secondaryDiagnostics = [], ...oq } = observationQuality;
  const { note: _constant, ...ex } = experimental;
  const t = typeSpec(CV_SPEC, { ...rest, observationQuality: oq, experimental: ex }, label); if (!t.ok) return t;
  if ((t.record.outcome === 'refused') !== (t.record.refusalReason !== null)) return bad(label, 'refusalReason', 'is recorded exactly on a refusal');
  if (t.record.combineVerified) return bad(label, 'combineVerified', 'is never true: no protocol has completed real-world validation');
  if (!Array.isArray(reasons) || reasons.length > L.qualityReasons) return bad(label, 'observationQuality.reasons', `must list at most ${L.qualityReasons} reasons`);
  const qr = [];
  for (const [i, x] of reasons.entries()) {
    const a = `${label}.observationQuality.reasons[${i}]`;
    if (!isPlainObject(x) || Object.keys(x).some((k) => !['code', 'value', 'threshold'].includes(k))) return { ok: false, reason: `${a} must be { code, value, threshold } (got ${describe(x)})` };
    if (typeof x.code !== 'string' || !CODE_RE.test(x.code) || x.code.length > L.code) return bad(a, 'code', 'must be a reason code');
    for (const k of ['value', 'threshold']) if (x[k] != null && !isMs(x[k])) return bad(a, k, `must be a number or null (got ${describe(x[k])})`);
    qr.push({ code: x.code, value: x.value ?? null, threshold: x.threshold ?? null });
  }
  const sd = typeCodes(secondaryDiagnostics, label, 'observationQuality.secondaryDiagnostics', L.qualityReasons); if (!sd.ok) return sd;
  if (!Array.isArray(trace) || trace.length > L.trace) return bad(label, 'trace', `must list at most ${L.trace} events`);
  const tr = [];
  for (const [i, x] of trace.entries()) {
    if (!isPlainObject(x) || Object.keys(x).some((k) => !['atMs', 'confidence'].includes(k))) return { ok: false, reason: `${label}.trace[${i}] must be { atMs, confidence } (got ${describe(x)})` };
    for (const k of ['atMs', 'confidence']) if (x[k] != null && !isMs(x[k])) return bad(`${label}.trace[${i}]`, k, 'must be a number or null');
    tr.push({ atMs: x.atMs ?? null, confidence: x.confidence ?? null });
  }
  const r = t.record;
  return { ok: true, record: { ...r, observationQuality: { ...r.observationQuality, reasons: qr, secondaryDiagnostics: sd.value }, experimental: { ...r.experimental, note: EXPERIMENTAL_NOTE }, trace: tr } };
}

// ------------------------------------------------------------------ rows
const cols = (spec) => flat(spec).map((f) => f.c);
function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  const attemptSpec = [...ATTEMPT_SPEC, ...CALIBRATION_SPEC];
  return {
    prefs: p(upsertSql('box_cam_prefs', PREFS_SPEC, ['player_id'])),
    challenge: p(insertSql('box_challenges', CHALLENGE_SPEC)),
    entry: p(upsertSql('box_challenge_entries', ENTRY_SPEC)),
    assignment: p(upsertSql('box_assignments', ASSIGNMENT_SPEC)),
    session: p(upsertSql('box_sessions', SESSION_SPEC)),
    obs: p('INSERT INTO box_session_observations (session_id, ord, kind, from_ms, to_ms, at_ms, quality, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    obsCount: p('SELECT count(*) AS n FROM box_session_observations WHERE session_id = ?'),
    openPause: p("SELECT ord FROM box_session_observations WHERE session_id = ? AND kind = 'pause' AND to_ms IS NULL ORDER BY ord LIMIT 1"),
    closePause: p('UPDATE box_session_observations SET to_ms = ? WHERE session_id = ? AND ord = ?'),
    reasonsOf: p('DELETE FROM box_session_reasons WHERE session_id = ?'),
    reason: p('INSERT INTO box_session_reasons (session_id, ord, code) VALUES (?, ?, ?)'),
    integrity: p(insertSql('box_session_integrity_events', [idf('sessionId', 'session_id'), int('ord', 'ord'), ...INTEGRITY_SPEC])),
    dispute: p(upsertSql('box_cam_disputes', DISPUTE_SPEC)),
    request: p(upsertSql('combine_requests', REQUEST_SPEC)),
    requestProtocol: p('INSERT INTO combine_request_protocols (request_id, ord, protocol_id) VALUES (?, ?, ?)'),
    attempt: p(upsertSql('combine_attempts', attemptSpec)),
    attemptReasonsOf: p('DELETE FROM combine_attempt_reasons WHERE attempt_id = ?'),
    attemptReason: p('INSERT INTO combine_attempt_reasons (attempt_id, ord, code) VALUES (?, ?, ?)'),
    checksOf: p('DELETE FROM combine_attempt_calibration_checks WHERE attempt_id = ?'),
    check: p('INSERT INTO combine_attempt_calibration_checks (attempt_id, ord, check_name) VALUES (?, ?, ?)'),
    cv: p(insertSql('box_cam_cv_results', CV_SPEC)),
    cvCode: p('INSERT INTO box_cam_cv_result_codes (provider_session_id, list, ord, code, value, threshold) VALUES (?, ?, ?, ?, ?, ?)'),
    cvTrace: p('INSERT INTO box_cam_cv_result_trace (provider_session_id, ord, at_ms, confidence) VALUES (?, ?, ?, ?)'),
  };
}
function insertObservations(st, sessionId, rows, from = 0) {
  rows.forEach((o, i) => st.obs.run(sessionId, from + i, o.kind, o.fromMs, o.toMs, o.atMs, o.quality, o.confidence));
}
function writeSession(st, rec, { isNew, knownEvents = 0 }) {
  st.session.run(encode(SESSION_SPEC, rec));
  st.reasonsOf.run(rec.id);
  rec.verificationReasons.forEach((c, i) => st.reason.run(rec.id, i, c));
  rec.integrityEvents.slice(knownEvents).forEach((e, i) => st.integrity.run({ session_id: rec.id, ord: knownEvents + i, ...encode(INTEGRITY_SPEC, e) }));
  if (isNew && rec.obs) insertObservations(st, rec.id, rec.obs);
}
function writeRequest(st, rec, { isNew }) {
  st.request.run(encode(REQUEST_SPEC, rec));
  if (isNew) rec.protocolIds.forEach((p, i) => st.requestProtocol.run(rec.id, i, p));
}
function writeAttempt(st, rec) {
  st.attempt.run({ ...encode(ATTEMPT_SPEC, rec), calibration_passed: rec.calibrationResult ? (rec.calibrationResult.passed ? 1 : 0) : null, calibrated_at: rec.calibrationResult?.at ?? null });
  st.attemptReasonsOf.run(rec.id); st.checksOf.run(rec.id);
  rec.reasons.forEach((c, i) => st.attemptReason.run(rec.id, i, c));
  (rec.calibrationResult?.checks ?? []).forEach((c, i) => st.check.run(rec.id, i, c));
}
function writeCv(st, rec) {
  st.cv.run(encode(CV_SPEC, rec));
  rec.observationQuality.reasons.forEach((r, i) => st.cvCode.run(rec.providerSessionId, 'quality', i, r.code, r.value, r.threshold));
  rec.observationQuality.secondaryDiagnostics.forEach((c, i) => st.cvCode.run(rec.providerSessionId, 'secondary', i, c, null, null));
  rec.trace.forEach((x, i) => st.cvTrace.run(rec.providerSessionId, i, x.atMs, x.confidence));
}

const decodeObsRow = (r) => ({ kind: r.kind, fromMs: r.from_ms, toMs: r.to_ms, atMs: r.at_ms, quality: r.quality, confidence: r.confidence });
function decodeSessions(sqlite, rows, { obs = false } = {}) {
  const sids = rows.map((r) => r.id);
  const reasons = childRowsOf(sqlite, 'box_session_reasons', 'session_id', sids, { order: 'ord' });
  const events = childRowsOf(sqlite, 'box_session_integrity_events', 'session_id', sids, { order: 'ord' });
  const ob = obs ? childRowsOf(sqlite, 'box_session_observations', 'session_id', sids, { order: 'ord' }) : null;
  return rows.map((row) => ({
    ...decode(SESSION_SPEC, row),
    verificationReasons: reasons.all(row.id).map((x) => x.code),
    integrityEvents: events.all(row.id).map((e) => Object.fromEntries(Object.entries(decode(INTEGRITY_SPEC, e)).filter(([, v]) => v !== null))),
    ...(obs ? { obs: obsFromRows(ob.all(row.id).map(decodeObsRow)) } : {}),
  }));
}
function decodeRequests(sqlite, rows) {
  const pr = childRowsOf(sqlite, 'combine_request_protocols', 'request_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(REQUEST_SPEC, row), protocolIds: pr.all(row.id).map((x) => x.protocol_id) }));
}
function decodeAttempts(sqlite, rows) {
  const aids = rows.map((r) => r.id);
  const rs = childRowsOf(sqlite, 'combine_attempt_reasons', 'attempt_id', aids, { order: 'ord' });
  const ck = childRowsOf(sqlite, 'combine_attempt_calibration_checks', 'attempt_id', aids, { order: 'ord' });
  return rows.map((row) => {
    const a = decode(ATTEMPT_SPEC, row);
    const required = combineProtocol(a.protocolId, a.protocolVersion)?.calibrationRequirements ?? [];
    return {
      ...a,
      calibrationResult: row.calibrated_at === null ? null : { required: [...required], passed: row.calibration_passed === 1, checks: ck.all(row.id).map((x) => x.check_name), at: row.calibrated_at },
      reasons: rs.all(row.id).map((x) => x.code),
    };
  });
}
function decodeCv(sqlite, rows) {
  const keys = rows.map((r) => r.provider_session_id);
  const codes = childRowsOf(sqlite, 'box_cam_cv_result_codes', 'provider_session_id', keys, { order: 'list, ord' });
  const trace = childRowsOf(sqlite, 'box_cam_cv_result_trace', 'provider_session_id', keys, { order: 'ord' });
  return rows.map((row) => {
    const r = decode(CV_SPEC, row);
    const c = codes.all(row.provider_session_id);
    return {
      sessionId: r.sessionId, providerSessionId: r.providerSessionId, protocolId: r.protocolId, providerId: r.providerId,
      providerVersion: r.providerVersion, engineVersion: r.engineVersion, cvPolicyVersion: r.cvPolicyVersion,
      outcome: r.outcome, refusalReason: r.refusalReason, refusalDetail: r.refusalDetail,
      observationQuality: {
        ...r.observationQuality,
        reasons: c.filter((x) => x.list === 'quality').map((x) => ({ code: x.code, value: x.value, threshold: x.threshold })),
        secondaryDiagnostics: c.filter((x) => x.list === 'secondary').map((x) => x.code),
      },
      derived: r.derived,
      experimental: { ...r.experimental, note: EXPERIMENTAL_NOTE },
      integrity: r.integrity,
      trace: trace.all(row.provider_session_id).map((x) => ({ atMs: x.at_ms, confidence: x.confidence })),
      traceTruncated: r.traceTruncated, serverStartedAt: r.serverStartedAt, serverEndedAt: r.serverEndedAt, serverDurationMs: r.serverDurationMs,
      combineVerified: r.combineVerified, combineVerifiedBlockedBy: r.combineVerifiedBlockedBy,
    };
  });
}
const decodeWith = (spec) => (rows) => rows.map((r) => decode(spec, r));

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const boxCamLive = (sqlite) => migrationApplied(sqlite, BOX_CAM_MIGRATION);
function readAll(sqlite) {
  const all = (t, order = 'rowid') => sqlite.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all();
  return {
    boxCamPrefs: decodeWith(PREFS_SPEC)(all('box_cam_prefs')),
    boxChallenges: decodeWith(CHALLENGE_SPEC)(all('box_challenges')),
    boxChallengeEntries: decodeWith(ENTRY_SPEC)(all('box_challenge_entries')),
    boxAssignments: decodeWith(ASSIGNMENT_SPEC)(all('box_assignments')),
    boxSessions: decodeSessions(sqlite, all('box_sessions'), { obs: true }),
    boxCamDisputes: decodeWith(DISPUTE_SPEC)(all('box_cam_disputes')),
    combineRequests: decodeRequests(sqlite, all('combine_requests')),
    combineAttempts: decodeAttempts(sqlite, all('combine_attempts')),
    boxCamCvResults: decodeCv(sqlite, all('box_cam_cv_results')),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const BOX_CAM_RECORDS = {
  names: BOX_CAM_COLLECTIONS,
  read(sqlite) { return boxCamLive(sqlite) ? readAll(sqlite) : null; },
};
const PLAYER_REFS_SQL = 'SELECT player_id AS pid FROM box_sessions UNION ALL SELECT player_id FROM box_assignments UNION ALL SELECT player_id FROM combine_attempts UNION ALL SELECT player_id FROM combine_requests';
export const unresolvedPlayerReferences = (sqlite) => (boxCamLive(sqlite) ? { boxCam: sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n } : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'update', 'save', 'record', 'recordBatch']);
const clone = (v) => JSON.parse(JSON.stringify(v));
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** The sort key of a newest-first page of records: `[createdAt, id]`. */
export const newestFirstKey = (r) => [r.createdAt, r.id];

/**
 * `createBoxCamRepository({ sqlite, unit, now, log })`: `prefs`, `challenges`, `entries`, `assignments`, `sessions`,
 * `disputes`, `requests`, `attempts` and `cvResults`, each with its writes and queries, plus `reads` (the queries
 * alone: `boxCamReads`).
 */
export function createBoxCamRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the Box Cam repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const updating = new Set();
  const guard = (key, fn) => {
    if (updating.has(key)) throw refusal('BOX_CAM_NESTED_UPDATE', `${key} is already being updated; make the second change after the first returns`);
    updating.add(key);
    try { return fn(); } finally { updating.delete(key); }
  };
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('BOX_CAM_INPUT_INVALID', t.reason); return t.record; };
  const updater = ({ table, type, byId: find, immutable, write, check = () => {} }) => (id, change) => guard(`${table} ${id}`, () => operation(() => {
    if (typeof change !== 'function') throw new TypeError(`${table}.update(id, change) needs a function that edits the copy it is given`);
    const stored = find(id);
    if (!stored) throw refusal('BOX_CAM_NOT_FOUND', `${table} ${id} is not a record of the repository`);
    const draft = clone(stored);
    const returned = change(draft);
    const next = typedOr(type, returned === undefined ? draft : returned, table);
    for (const k of immutable) if (!same(next[k], stored[k])) throw refusal('BOX_CAM_INPUT_INVALID', `${table} ${id}: ${k} cannot change`);
    check(next, stored);
    write(next, stored);
    return find(id);
  }));
  const one = (decoder) => (sql) => (id) => { if (typeof id !== 'string') return null; const row = q(sql).get(id); return row ? deepFreeze(decoder([row])[0]) : null; };
  const many = (decoder) => (sql) => (...args) => decoder(q(sql).all(...args)).map(deepFreeze);
  const json = (list) => JSON.stringify([...list]);

  // ---- prefs
  const prefsOf = one(decodeWith(PREFS_SPEC))('SELECT * FROM box_cam_prefs WHERE player_id = ?');
  const prefs = {
    /** The player's saved preferences, or the defaults (reading never creates a row). */
    forPlayer: (playerId) => prefsOf(playerId) ?? deepFreeze(defaultPrefs(playerId)),
    /** Has the player shared development activity for recruitment? */
    sharesForRecruitment: (playerId) => !!q("SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment'").get(playerId),
    save: (raw) => operation(() => { const r = typedOr(typePrefs, raw, 'boxCamPrefs'); st.prefs.run(encode(PREFS_SPEC, r)); return prefsOf(r.playerId); }),
  };

  // ---- challenges and entries
  const decC = decodeWith(CHALLENGE_SPEC);
  const challengeById = one(decC)('SELECT * FROM box_challenges WHERE id = ?');
  const challenges = {
    create: (raw) => operation(() => {
      const r = typedOr(typeChallenge, raw, 'boxChallenges');
      if (challengeById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `box_challenges ${r.id} already exists`);
      st.challenge.run(encode(CHALLENGE_SPEC, r));
      return challengeById(r.id);
    }),
    byId: challengeById,
    /** An organisation's own challenges, newest first. */
    forOrg: many(decC)("SELECT * FROM box_challenges WHERE publisher_kind = 'org' AND publisher_org_id = ? ORDER BY created_at DESC, id DESC"),
    /** Active challenges that have not ended at `at`, oldest first (the eligibility rule is the route's). */
    open: (at) => many(decC)("SELECT * FROM box_challenges WHERE status = 'active' AND ends_at >= ? ORDER BY rowid")(at),
    /** Entries per challenge: Map id → count. */
    participants: (challengeIds) => new Map(challengeIds.map((id) => [id, 0]).concat(q('SELECT challenge_id AS id, count(*) AS n FROM box_challenge_entries WHERE challenge_id IN (SELECT value FROM json_each(?)) GROUP BY challenge_id').all(json(challengeIds)).map((r) => [r.id, r.n]))),
  };
  const decE = decodeWith(ENTRY_SPEC);
  const entryById = one(decE)('SELECT * FROM box_challenge_entries WHERE id = ?');
  const entries = {
    create: (raw) => operation(() => {
      const r = typedOr(typeEntry, raw, 'boxChallengeEntries');
      if (entryById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `box_challenge_entries ${r.id} already exists`);
      if (!challengeById(r.challengeId)) throw refusal('BOX_CAM_REFERENCE_MISSING', `box_challenge_entries ${r.id}: challengeId names no challenge (${r.challengeId})`);
      if (q('SELECT 1 FROM box_challenge_entries WHERE challenge_id = ? AND player_id = ?').get(r.challengeId, r.playerId)) throw refusal('BOX_CAM_DUPLICATE', `${r.playerId} already joined ${r.challengeId}`);
      st.entry.run(encode(ENTRY_SPEC, r));
      return entryById(r.id);
    }),
    /** `update(id, change)`: the challenge, player and joining never change; a completed entry stays completed. */
    update: updater({
      table: 'box_challenge_entries', type: typeEntry, byId: entryById, immutable: ['id', 'challengeId', 'playerId', 'joinedAt', 'joinedBy'],
      check: (next, stored) => { if (stored.status === 'completed' && next.status !== 'completed') throw refusal('BOX_CAM_INPUT_INVALID', `box_challenge_entries ${stored.id}: a completed entry stays completed`); },
      write: (next) => st.entry.run(encode(ENTRY_SPEC, next)),
    }),
    byId: entryById,
    /** The player's entries, oldest first. */
    forPlayer: many(decE)('SELECT * FROM box_challenge_entries WHERE player_id = ? ORDER BY rowid'),
    countFor: (challengeId) => q('SELECT count(*) AS n FROM box_challenge_entries WHERE challenge_id = ?').get(challengeId).n,
  };

  // ---- assignments
  const decA = decodeWith(ASSIGNMENT_SPEC);
  const assignmentById = one(decA)('SELECT * FROM box_assignments WHERE id = ?');
  const assignments = {
    create: (raw) => operation(() => {
      const r = typedOr(typeAssignment, raw, 'boxAssignments');
      if (assignmentById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `box_assignments ${r.id} already exists`);
      st.assignment.run(encode(ASSIGNMENT_SPEC, r));
      return assignmentById(r.id);
    }),
    /** `update(id, change)`: only the state and updatedAt change. */
    update: updater({
      table: 'box_assignments', type: typeAssignment, byId: assignmentById,
      immutable: ['id', 'playerId', 'orgId', 'orgName', 'assignedBy', 'drillId', 'drillVersion', 'target', 'frequencyPerWeek', 'dueDate', 'instructions', 'objectiveId', 'createdAt'],
      write: (next) => st.assignment.run(encode(ASSIGNMENT_SPEC, next)),
    }),
    byId: assignmentById,
    /** The player's assignments, oldest first. */
    forPlayer: many(decA)('SELECT * FROM box_assignments WHERE player_id = ? ORDER BY rowid'),
    /** An organisation's assignments (optionally for one player), newest first. */
    forOrg: (orgId, { playerId = null } = {}) => many(decA)('SELECT * FROM box_assignments WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC')(orgId, playerId, playerId),
  };

  // ---- sessions
  const decS = (rows) => decodeSessions(sqlite, rows);
  const sessionById = one(decS)('SELECT * FROM box_sessions WHERE id = ?');
  const SESSION_IMMUTABLE = ['id', 'playerId', 'drillId', 'drillVersion', 'assignmentId', 'challengeEntryId', 'target', 'nonceHash', 'livenessChallenge', 'provider', 'providerVersion', 'createdAt', 'expiresAt', 'captureContext', 'lastSeq', 'batches'];
  const sessionRefs = (r) => {
    if (r.assignmentId && assignmentById(r.assignmentId)?.playerId !== r.playerId) throw refusal('BOX_CAM_REFERENCE_MISSING', `box_sessions ${r.id}: assignmentId names no assignment of ${r.playerId} (${r.assignmentId})`);
    if (r.challengeEntryId && entryById(r.challengeEntryId)?.playerId !== r.playerId) throw refusal('BOX_CAM_REFERENCE_MISSING', `box_sessions ${r.id}: challengeEntryId names no entry of ${r.playerId} (${r.challengeEntryId})`);
  };
  const sessions = {
    create: (raw) => operation(() => {
      const r = typedOr(typeSession, raw, 'boxSessions');
      if (sessionById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `box_sessions ${r.id} already exists`);
      sessionRefs(r);
      writeSession(st, r, { isNew: true });
      return sessionById(r.id);
    }),
    /**
     * `update(id, change)`: the identity, binding, target and nonce never change, nor the sequence (recordBatch owns
     * it); the verification reasons are rewritten whole; the integrity history only grows.
     */
    update: updater({
      table: 'box_sessions', type: (raw, at) => { if (isPlainObject(raw) && 'obs' in raw) return bad(at, 'obs', 'is appended by recordBatch, never edited'); return typeSession(raw, at); },
      byId: sessionById, immutable: SESSION_IMMUTABLE,
      check: (next, stored) => { if (stored.integrityEvents.some((e, i) => !same(e, next.integrityEvents[i]))) throw refusal('BOX_CAM_INPUT_INVALID', `box_sessions ${stored.id}: the integrity history only grows`); },
      write: (next, stored) => writeSession(st, next, { isNew: false, knownEvents: stored.integrityEvents.length }),
    }),
    /**
     * Append one accepted batch: `observations` (typed rows; a `{ kind: 'resume', atMs }` closes the earliest open
     * pause, as the engine does), then `lastSeq` and one more batch.
     */
    recordBatch: (id, { observations, lastSeq }) => guard(`box_sessions ${id}`, () => operation(() => {
      const s = sessionById(id);
      if (!s) throw refusal('BOX_CAM_NOT_FOUND', `box_sessions ${id} is not a record of the repository`);
      if (!Number.isSafeInteger(lastSeq) || lastSeq <= s.lastSeq) throw refusal('BOX_CAM_INPUT_INVALID', `box_sessions ${id}: lastSeq must grow (was ${s.lastSeq})`);
      if (!Array.isArray(observations)) throw refusal('BOX_CAM_INPUT_INVALID', `box_sessions ${id}: observations must be a list`);
      let ord = st.obsCount.get(id).n;
      for (const [i, raw] of observations.entries()) {
        if (isPlainObject(raw) && raw.kind === 'resume') {
          if (!isMs(raw.atMs)) throw refusal('BOX_CAM_INPUT_INVALID', `box_sessions ${id}: observations[${i}].atMs must be a number`);
          const open = st.openPause.get(id);
          if (open) st.closePause.run(raw.atMs, id, open.ord);
          continue;
        }
        const o = typedOr(typeObservation, raw, `box_sessions ${id} observations[${i}]`);
        if (ord >= L.maxObservations) throw refusal('BOX_CAM_INPUT_INVALID', `box_sessions ${id}: holds ${L.maxObservations} observations already`);
        insertObservations(st, id, [o], ord); ord += 1;
      }
      q('UPDATE box_sessions SET last_seq = ?, batches = batches + 1 WHERE id = ?').run(lastSeq, id);
      return sessionById(id);
    })),
    byId: sessionById,
    /** The accepted stream in the engine's shape `{ active, presence, ball, reps, sets, pauses, interruptions, multiPerson }`. */
    observationsOf: (id) => obsFromRows(q('SELECT * FROM box_session_observations WHERE session_id = ? ORDER BY ord').all(id).map(decodeObsRow)),
    /** How many observations the session holds. */
    observationCount: (id) => st.obsCount.get(id).n,
    /** How many observations of the four bounded kinds the session holds (the storage limit). */
    storedIntervals: (id) => q("SELECT count(*) AS n FROM box_session_observations WHERE session_id = ? AND kind IN ('active','presence','ball','rep')").get(id).n,
    /** All the player's sessions, in the order they were minted. */
    forPlayer: many(decS)('SELECT * FROM box_sessions WHERE player_id = ? ORDER BY rowid'),
    /** The player's finished sessions (a terminal status), newest ended first; `limit` caps the list. */
    finishedForPlayer: (playerId, { limit = -1 } = {}) => many(decS)(`SELECT * FROM box_sessions WHERE player_id = ? AND status IN (${enumIn(VERIFICATION_STATES)}) ORDER BY ended_at IS NULL, ended_at DESC, id DESC LIMIT ?`)(playerId, limit),
    /** Sessions run against this assignment. */
    forAssignment: many(decS)('SELECT * FROM box_sessions WHERE assignment_id = ? ORDER BY rowid'),
    byIds: (sessionIds) => many(decS)('SELECT * FROM box_sessions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid')(json(sessionIds)),
  };

  // ---- disputes
  const decD = decodeWith(DISPUTE_SPEC);
  const disputeById = one(decD)('SELECT * FROM box_cam_disputes WHERE id = ?');
  const disputes = {
    create: (raw) => operation(() => {
      const r = typedOr(typeDispute, raw, 'boxCamDisputes');
      if (disputeById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `box_cam_disputes ${r.id} already exists`);
      if (sessionById(r.sessionId)?.playerId !== r.playerId) throw refusal('BOX_CAM_REFERENCE_MISSING', `box_cam_disputes ${r.id}: sessionId names no session of ${r.playerId}`);
      st.dispute.run(encode(DISPUTE_SPEC, r));
      return disputeById(r.id);
    }),
    /** `update(id, change)`: a dispute is resolved once; nothing else changes. */
    update: updater({
      table: 'box_cam_disputes', type: typeDispute, byId: disputeById, immutable: ['id', 'sessionId', 'playerId', 'by', 'reason', 'createdAt'],
      check: (next, stored) => { if (stored.status === 'resolved') throw refusal('BOX_CAM_INPUT_INVALID', `box_cam_disputes ${stored.id} is already resolved`); },
      write: (next) => st.dispute.run(encode(DISPUTE_SPEC, next)),
    }),
    byId: disputeById,
    /** The T&S queue, oldest first, one page: open ones unless `all`; `after` is the previous page's last `[createdAt, id]`. */
    queue: ({ all = false, after = null, limit = 50 } = {}) => many(decD)('SELECT * FROM box_cam_disputes WHERE (? = 1 OR status = \'open\') AND (? IS NULL OR (created_at, id) > (?, ?)) ORDER BY created_at, id LIMIT ?')(all ? 1 : 0, after ? 1 : null, after?.[0] ?? null, after?.[1] ?? null, limit),
  };

  // ---- Combine requests and attempts
  const decR = (rows) => decodeRequests(sqlite, rows);
  const requestById = one(decR)('SELECT * FROM combine_requests WHERE id = ?');
  const requests = {
    create: (raw) => operation(() => {
      const r = typedOr(typeRequest, raw, 'combineRequests');
      if (requestById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `combine_requests ${r.id} already exists`);
      writeRequest(st, r, { isNew: true });
      return requestById(r.id);
    }),
    /** `update(id, change)`: only the state and completedAt change. */
    update: updater({
      table: 'combine_requests', type: typeRequest, byId: requestById, immutable: ['id', 'orgId', 'orgName', 'requestedBy', 'playerId', 'title', 'protocolIds', 'deadline', 'instructions', 'createdAt'],
      write: (next) => writeRequest(st, next, { isNew: false }),
    }),
    byId: requestById,
    /** The player's requests, oldest first. */
    forPlayer: many(decR)('SELECT * FROM combine_requests WHERE player_id = ? ORDER BY rowid'),
    /** An organisation's requests (optionally for one player), newest first. */
    forOrg: (orgId, { playerId = null } = {}) => many(decR)('SELECT * FROM combine_requests WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC')(orgId, playerId, playerId),
    /** Does this organisation hold a request to this player that is not cancelled (the Combine consent rule)? */
    activeBetween: (orgId, playerId) => !!q("SELECT 1 FROM combine_requests WHERE org_id = ? AND player_id = ? AND state <> 'cancelled' LIMIT 1").get(orgId, playerId),
    /** Players with a completed request from this organisation. */
    completedPlayerIds: (orgId) => new Set(q("SELECT DISTINCT player_id AS p FROM combine_requests WHERE org_id = ? AND state = 'completed'").all(orgId).map((r) => r.p)),
  };
  const decT = (rows) => decodeAttempts(sqlite, rows);
  const attemptById = one(decT)('SELECT * FROM combine_attempts WHERE id = ?');
  const attempts = {
    create: (raw) => operation(() => {
      const r = typedOr(typeAttempt, raw, 'combineAttempts');
      if (attemptById(r.id)) throw refusal('BOX_CAM_DUPLICATE', `combine_attempts ${r.id} already exists`);
      if (sessionById(r.boxSessionId)?.playerId !== r.playerId) throw refusal('BOX_CAM_REFERENCE_MISSING', `combine_attempts ${r.id}: boxSessionId names no session of ${r.playerId}`);
      if (q('SELECT 1 FROM combine_attempts WHERE box_session_id = ?').get(r.boxSessionId)) throw refusal('BOX_CAM_DUPLICATE', `box_sessions ${r.boxSessionId} is already bound to an attempt`);
      if (r.requestId && requestById(r.requestId)?.playerId !== r.playerId) throw refusal('BOX_CAM_REFERENCE_MISSING', `combine_attempts ${r.id}: requestId names no request of ${r.playerId}`);
      writeAttempt(st, r);
      return attemptById(r.id);
    }),
    /** `update(id, change)`: the binding, protocol and frozen metric never change. */
    update: updater({
      table: 'combine_attempts', type: typeAttempt, byId: attemptById,
      immutable: ['id', 'playerId', 'protocolId', 'protocolVersion', 'boxSessionId', 'attemptNumber', 'mode', 'captureContext', 'requestId', 'metricType', 'metricUnit', 'direction', 'measurementAlgorithmVersion', 'provider', 'providerVersion', 'createdAt'],
      write: (next) => writeAttempt(st, next),
    }),
    byId: attemptById,
    /** The player's attempts, newest created first. */
    forPlayer: many(decT)('SELECT * FROM combine_attempts WHERE player_id = ? ORDER BY created_at DESC, id DESC'),
    /** The attempt bound to this session, or null. */
    bySession: one(decT)('SELECT * FROM combine_attempts WHERE box_session_id = ?'),
    /** How many of the player's attempts at this protocol (optionally in one mode, since `since`). */
    count: (playerId, protocolId, { mode = null, since = null } = {}) => q('SELECT count(*) AS n FROM combine_attempts WHERE player_id = ? AND protocol_id = ? AND (? IS NULL OR mode = ?) AND (? IS NULL OR created_at >= ?)').get(playerId, protocolId, mode, mode, since, since).n,
  };

  // ---- CV results
  const decV = (rows) => decodeCv(sqlite, rows);
  const cvByKey = one(decV)('SELECT * FROM box_cam_cv_results WHERE provider_session_id = ?');
  const cvResults = {
    /** Record the provider's canonical result, once; it never changes. */
    record: (raw) => operation(() => {
      const r = typedOr(typeCvResult, raw, 'boxCamCvResults');
      if (cvByKey(r.providerSessionId)) throw refusal('BOX_CAM_DUPLICATE', `box_cam_cv_results ${r.providerSessionId} already exists`);
      if (!sessionById(r.sessionId)) throw refusal('BOX_CAM_REFERENCE_MISSING', `box_cam_cv_results ${r.providerSessionId}: sessionId names no session (${r.sessionId})`);
      writeCv(st, r);
      return cvByKey(r.providerSessionId);
    }),
    byProviderSession: cvByKey,
    /** The latest result recorded for this Box Cam session, or null. */
    latestForSession: (sessionId) => { const row = q('SELECT * FROM box_cam_cv_results WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sessionId); return row ? deepFreeze(decV([row])[0]) : null; },
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { prefs, challenges, entries, assignments, sessions, disputes, requests, attempts, cvResults };
  const counters = Object.fromEntries([
    ['boxCamPrefs', 'box_cam_prefs'], ['boxChallenges', 'box_challenges'], ['boxChallengeEntries', 'box_challenge_entries'], ['boxAssignments', 'box_assignments'],
    ['boxSessions', 'box_sessions'], ['boxCamDisputes', 'box_cam_disputes'], ['combineRequests', 'combine_requests'], ['combineAttempts', 'combine_attempts'], ['boxCamCvResults', 'box_cam_cv_results'],
  ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]));
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`boxCamReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!boxCamLive(sqlite)) throw new Error(`the Box Cam repository needs ${BOX_CAM_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(BOX_CAM_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return BOX_CAM_RECORDS.read(sqlite); },
    log,
    now,
  };
}

/** Insert the ScoutBox challenges (the migration). */
export function seedScoutboxChallenges(sqlite, now) {
  const st = sqlite.prepare(insertSql('box_challenges', CHALLENGE_SPEC));
  for (const c of scoutboxChallenges(now)) {
    const t = typeChallenge(c);
    if (!t.ok) throw new Error(`the ScoutBox challenge seed is invalid: ${t.reason}`);
    st.run(encode(CHALLENGE_SPEC, t.record));
  }
}
export const BOX_CAM_COLUMNS = Object.freeze({ session: cols(SESSION_SPEC), attempt: cols(ATTEMPT_SPEC) });
