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
 * Writes (repositories/writes.mjs). A record is created whole and must read back as written (`prefs.save` and
 * `cvResults.record` too), then changes only through named acts (`sessions.start`, `finish`, `invalidate`, `restore`,
 * `attempts.measure`, `disputes.resolve`, …), each an UPDATE of named columns guarded by the state it moves from, or an
 * INSERT of new rows; `sessions.recordBatch` appends the accepted observations. Each joins the open unit of work, the
 * caller's open transaction, or opens its own. No act touches a record's identity, binding, target or nonce; a
 * session's integrity history is only inserted. The columns and keys are the only check on stored values.
 *
 * Queries decode deep-frozen records, a list's child rows in one batch. Modules receive them as `boxCamReads`.
 *
 * References. Player, guardian, media and staff-author ids on a player's own records carry no key (tolerant).
 * Organisations → orgs, the assigning or requesting staff → org_users and an assignment's objective → dev_objectives
 * are immediate RESTRICT, as are the keys between this domain's tables. A session's assignment and challenge entry, a
 * dispute's session and an attempt's session and request are the same player's (composite keys). Child rows cascade
 * with their owner, which is never deleted.
 */
import crypto from 'node:crypto';
import { isPlainObject, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import {
  text,
  int,
  num,
  bool,
  oneOf,
  group,
  tableDdl,
  encode,
  decode,
  upsertSql,
  insertSql,
  flat,
} from './fieldSpecs.mjs';
import { QUALITY, OBSERVATION_KINDS } from '../domains/development/boxcam/shared.mjs';
import { DRILLS, PROVIDERS, LIVENESS_CHALLENGES } from '../domains/development/boxcam/drills.mjs';
import { combineProtocol, METRIC_TYPES } from '../domains/development/boxcam/combineShared.mjs';
import { CANDIDATE_PROTOCOLS, CV_PROVIDER_ID } from '../domains/development/boxcam/cv/policy.mjs';

export const BOX_CAM_MIGRATION = '0031_box_cam';
export const BOX_CAM_COLLECTIONS = Object.freeze([
  'boxCamPrefs',
  'boxChallenges',
  'boxChallengeEntries',
  'boxAssignments',
  'boxSessions',
  'boxCamDisputes',
  'combineRequests',
  'combineAttempts',
  'boxCamCvResults',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition; the routes import them)
export const SHARE_CHOICES = Object.freeze(['private', 'recruitment']);
export const PREF_ACTOR_KINDS = Object.freeze(['player', 'guardian']);
export const CHALLENGE_METRICS = Object.freeze(['reps', 'active_minutes']);
export const CHALLENGE_PUBLISHERS = Object.freeze(['org', 'scoutbox']);
export const ENTRY_STATUSES = Object.freeze(['active', 'completed']);
/** 'superseded' was read in places but never written: not a state. */
export const ASSIGNMENT_STATES = Object.freeze([
  'assigned',
  'accepted',
  'in_progress',
  'partially_completed',
  'completed',
  'cancelled',
]);
/** The target types a drill offers (the engine also knows 'combined', which no drill offers). */
export const BOX_TARGET_TYPES = Object.freeze([...new Set(DRILLS.flatMap((d) => d.targetTypes))]);
/** SESSION_STATES that are ever written ('not_started' and 'ready' never are). */
export const SESSION_STATUSES = Object.freeze([
  'setup_required',
  'recording',
  'processing',
  'verified',
  'partially_verified',
  'unable_to_verify',
  'completed_unverified',
  'cancelled',
  'invalidated',
]);
export const VERIFICATION_STATES = Object.freeze([
  'verified',
  'partially_verified',
  'unable_to_verify',
  'completed_unverified',
  'cancelled',
  'invalidated',
]);
export const RESTORABLE_STATES = Object.freeze(VERIFICATION_STATES.filter((s) => s !== 'invalidated'));
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
export const CAPTURE_CONTEXTS = Object.freeze(['at_home', 'club', 'event']);
export const DISPUTE_OUTCOMES = Object.freeze(['stands', 'invalidated', 'provider_bug']);
export const REQUEST_STATES = Object.freeze(['requested', 'completed', 'cancelled']);
export const ATTEMPT_MODES = Object.freeze(['verified', 'practice']);
export const COMBINE_STATES_STORED = Object.freeze([
  'ready',
  'combine_verified',
  'partially_measured',
  'measurement_unavailable',
  'protocol_invalid',
  'invalidated',
  'cancelled',
]);
export const MEASUREMENT_STATES = Object.freeze([
  'measured',
  'practice',
  'partially_measured',
  'measurement_unavailable',
  'protocol_invalid',
  'invalidated',
  'cancelled',
]);
export const DIRECTIONS = Object.freeze(['higher', 'lower']);
export const BOX_CAM_LIMITS = Object.freeze({
  id: 80,
  name: 200,
  role: 80,
  title: 120,
  instructions: 300,
  note: 300,
  disputeReason: 500,
  resolutionReason: 400,
  hash: 64,
  code: 80,
  detail: 300,
  unit: 40,
  calibrationChecks: 10,
  calibrationCheck: 60,
  protocols: 20,
  reasons: 40,
  qualityReasons: 40,
  trace: 256,
  maxObservations: 4_000,
});
const L = BOX_CAM_LIMITS;
/** A machine reason code: letters, digits and underscores. */
const CODE_SQL = (c) => `length(${c}) > 0 AND length(${c}) <= ${L.code} AND ${c} NOT GLOB '*[^A-Za-z0-9_]*'`;

export const hashNonce = (nonce) => crypto.createHash('sha256').update(String(nonce)).digest('hex');
/** Does the plain `nonce` a client sent match the stored hash? Constant time; a missing nonce never matches. */
export function nonceMatches(session, nonce) {
  if (typeof nonce !== 'string' || !nonce || !session?.nonceHash) return false;
  const a = Buffer.from(hashNonce(nonce), 'hex');
  const b = Buffer.from(session.nonceHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const defaultPrefs = (playerId) => ({
  playerId,
  shareDevelopmentActivity: 'private',
  retainClips: false,
  updatedAt: null,
  updatedBy: null,
});

/** The ScoutBox challenges the migration inserts. */
export function scoutboxChallenges(now) {
  return [
    {
      id: 'boxc-scoutbox-1000-touch',
      title: 'The 1,000 Touch Box Challenge',
      publisher: { kind: 'scoutbox' },
      drillId: 'box-touches',
      metric: 'reps',
      targetTotal: 1000,
      startsAt: now,
      endsAt: now + 30 * 86_400_000,
      adultOnly: false,
      cap: null,
      status: 'active',
      createdAt: now,
    },
    {
      id: 'boxc-scoutbox-first-touch',
      title: '7-Day First Touch Box Challenge',
      publisher: { kind: 'scoutbox' },
      drillId: 'box-control',
      metric: 'active_minutes',
      targetTotal: 60,
      startsAt: now,
      endsAt: now + 7 * 86_400_000,
      adultOnly: false,
      cap: null,
      status: 'active',
      createdAt: now,
    },
  ];
}

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const PREFS_SPEC = [
  idf('playerId', 'player_id', req),
  oneOf('shareDevelopmentActivity', 'share_development_activity', SHARE_CHOICES, req),
  bool('retainClips', 'retain_clips', req),
  int('updatedAt', 'updated_at'),
  group('updatedBy', [oneOf('kind', 'updated_by_kind', PREF_ACTOR_KINDS, req), idf('id', 'updated_by_id', req)], {
    nullable: true,
  }),
];
const CHALLENGE_SPEC = [
  idf('id', 'id', req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  group(
    'publisher',
    [
      oneOf('kind', 'publisher_kind', CHALLENGE_PUBLISHERS, req),
      idf('orgId', 'publisher_org_id'),
      text('orgName', 'publisher_org_name', L.name),
      text('byName', 'publisher_by_name', L.name),
    ],
    { sparse: true },
  ),
  idf('drillId', 'drill_id', req),
  oneOf('metric', 'metric', CHALLENGE_METRICS, req),
  int('targetTotal', 'target_total', req),
  int('startsAt', 'starts_at', req),
  int('endsAt', 'ends_at', req),
  bool('adultOnly', 'adult_only', req),
  int('cap', 'cap'),
  oneOf('status', 'status', ['active'], req),
  int('createdAt', 'created_at', req),
];
const ENTRY_SPEC = [
  idf('id', 'id', req),
  idf('challengeId', 'challenge_id', req),
  idf('playerId', 'player_id', req),
  oneOf('status', 'status', ENTRY_STATUSES, req),
  int('progress', 'progress', req),
  int('joinedAt', 'joined_at', req),
  group('joinedBy', [oneOf('kind', 'joined_by_kind', PREF_ACTOR_KINDS, req), idf('id', 'joined_by_id', req)]),
  int('completedAt', 'completed_at'),
];
const ASSIGNMENT_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  idf('orgId', 'org_id', req),
  text('orgName', 'org_name', L.name),
  group('assignedBy', [
    idf('userId', 'assigned_by_user_id', req),
    text('name', 'assigned_by_name', L.name),
    text('role', 'assigned_by_role', L.role),
    bool('orgVerifiedAtAssignment', 'assigned_by_org_verified', req),
    int('at', 'assigned_at', req),
  ]),
  idf('drillId', 'drill_id', req),
  int('drillVersion', 'drill_version', req),
  group('target', [oneOf('type', 'target_type', BOX_TARGET_TYPES, req), num('value', 'target_value', req)]),
  int('frequencyPerWeek', 'frequency_per_week'),
  text('dueDate', 'due_date', 10),
  text('instructions', 'instructions', L.instructions),
  idf('objectiveId', 'objective_id'),
  oneOf('state', 'state', ASSIGNMENT_STATES, req),
  int('createdAt', 'created_at', req),
  int('updatedAt', 'updated_at', req),
];
const SESSION_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  idf('drillId', 'drill_id', req),
  int('drillVersion', 'drill_version', req),
  idf('assignmentId', 'assignment_id'),
  idf('challengeEntryId', 'challenge_entry_id'),
  group('target', [oneOf('type', 'target_type', BOX_TARGET_TYPES, req), num('value', 'target_value', req)]),
  text('nonceHash', 'nonce_hash', L.hash, { req: true, nonEmpty: true }),
  oneOf('livenessChallenge', 'liveness_challenge', LIVENESS_CHALLENGES, req),
  oneOf('provider', 'provider_id', PROVIDER_IDS, req),
  int('providerVersion', 'provider_version', req),
  oneOf('status', 'status', SESSION_STATUSES, req),
  int('createdAt', 'created_at', req),
  int('expiresAt', 'expires_at', req),
  int('startedAt', 'started_at'),
  int('endedAt', 'ended_at'),
  int('livenessPassedAt', 'liveness_passed_at'),
  int('lastSeq', 'last_seq', req),
  int('batches', 'batches', req),
  oneOf('captureContext', 'capture_context', CAPTURE_CONTEXTS),
  num('sessionDurationMs', 'session_duration_ms'),
  num('verifiedActiveMs', 'verified_active_ms'),
  int('verifiedReps', 'verified_reps'),
  int('setsCompleted', 'sets_completed'),
  bool('targetCompleted', 'target_completed'),
  oneOf('quality', 'quality', QUALITY),
  int('interruptionsCount', 'interruptions_count'),
  oneOf('verificationState', 'verification_state', VERIFICATION_STATES),
  text('resultHash', 'result_hash', L.hash),
  int('finalizedAt', 'finalized_at'),
  text('note', 'note', L.note),
  idf('clipMediaId', 'clip_media_id'),
  oneOf('previousVerificationState', 'previous_verification_state', RESTORABLE_STATES),
  int('invalidatedAt', 'invalidated_at'),
  idf('cvProviderSessionId', 'cv_provider_session_id'),
];
const INTEGRITY_SPEC = [
  oneOf('type', 'type', ['invalidated', 'restored'], req),
  int('at', 'at', req),
  idf('disputeId', 'dispute_id'),
  oneOf('outcome', 'outcome', ['invalidated', 'provider_bug']),
  oneOf('to', 'to_state', RESTORABLE_STATES),
];
const DISPUTE_SPEC = [
  idf('id', 'id', req),
  idf('sessionId', 'session_id', req),
  idf('playerId', 'player_id', req),
  group('by', [
    oneOf('kind', 'by_kind', PREF_ACTOR_KINDS, req),
    idf('id', 'by_id', req),
    text('name', 'by_name', L.name),
  ]),
  text('reason', 'reason', L.disputeReason, { req: true, nonEmpty: true }),
  oneOf('status', 'status', ['open', 'resolved'], req),
  group(
    'resolution',
    [
      oneOf('outcome', 'resolution_outcome', DISPUTE_OUTCOMES, req),
      text('reason', 'resolution_reason', L.resolutionReason, { req: true, nonEmpty: true }),
      int('at', 'resolved_at', req),
    ],
    { nullable: true },
  ),
  int('createdAt', 'created_at', req),
];
const REQUEST_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  text('orgName', 'org_name', L.name),
  group('requestedBy', [
    idf('userId', 'requested_by_user_id', req),
    text('name', 'requested_by_name', L.name),
    text('role', 'requested_by_role', L.role),
    int('at', 'requested_at', req),
  ]),
  idf('playerId', 'player_id', req),
  text('title', 'title', L.title, { nonEmpty: true }),
  text('deadline', 'deadline_date', 10),
  text('instructions', 'instructions', L.instructions),
  oneOf('state', 'state', REQUEST_STATES, req),
  int('createdAt', 'created_at', req),
  int('completedAt', 'completed_at'),
];
const ATTEMPT_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  idf('protocolId', 'protocol_id', req),
  int('protocolVersion', 'protocol_version', req),
  idf('boxSessionId', 'box_session_id', req),
  int('attemptNumber', 'attempt_number', req),
  oneOf('mode', 'mode', ATTEMPT_MODES, req),
  oneOf('captureContext', 'capture_context', CAPTURE_CONTEXTS, req),
  idf('requestId', 'request_id'),
  oneOf('metricType', 'metric_type', METRIC_TYPES, req),
  text('metricUnit', 'metric_unit', L.unit, { req: true, nonEmpty: true }),
  oneOf('direction', 'direction', DIRECTIONS, req),
  int('measurementAlgorithmVersion', 'measurement_algorithm_version', req),
  oneOf('provider', 'provider_id', PROVIDER_IDS, req),
  int('providerVersion', 'provider_version', req),
  num('measuredValue', 'measured_value'),
  oneOf('measurementState', 'measurement_state', MEASUREMENT_STATES),
  oneOf('combineState', 'combine_state', COMBINE_STATES_STORED, req),
  int('startedAt', 'started_at'),
  int('completedAt', 'completed_at'),
  text('resultHash', 'result_hash', L.hash),
  int('createdAt', 'created_at', req),
];
const CALIBRATION_SPEC = [bool('passed', 'calibration_passed', req), int('at', 'calibrated_at', req)];
const CV_SPEC = [
  idf('providerSessionId', 'provider_session_id', req),
  idf('sessionId', 'session_id', req),
  oneOf('protocolId', 'protocol_id', Object.keys(CANDIDATE_PROTOCOLS), req),
  oneOf('providerId', 'provider_id', [CV_PROVIDER_ID], req),
  int('providerVersion', 'provider_version', req),
  int('engineVersion', 'engine_version', req),
  int('cvPolicyVersion', 'cv_policy_version', req),
  oneOf('outcome', 'outcome', ['accepted', 'refused'], req),
  text('refusalReason', 'refusal_reason', L.code),
  text('refusalDetail', 'refusal_detail', L.detail),
  group('observationQuality', [
    bool('sufficient', 'oq_sufficient', req),
    oneOf('state', 'oq_state', ['sufficient', 'insufficient']),
    num('aggregateConfidence', 'oq_aggregate_confidence'),
    num('coverage', 'oq_coverage'),
  ]),
  group('derived', [
    bool('personPresent', 'person_present', req),
    bool('ballPresent', 'ball_present', req),
    int('touchCount', 'touch_count'),
    int('juggleCount', 'juggle_count'),
    num('activeDurationMs', 'active_duration_ms', req),
  ]),
  group('experimental', [
    int('exactCount', 'experimental_exact_count'),
    oneOf('status', 'experimental_status', ['experimental_unvalidated'], req),
  ]),
  group('integrity', [
    bool('ok', 'integrity_ok', req),
    int('framesAccepted', 'frames_accepted', req),
    int('framesRejected', 'frames_rejected', req),
    int('framesDroppedByServer', 'frames_dropped_by_server', req),
    int('duplicatesRejected', 'duplicates_rejected', req),
    int('outOfOrderRejected', 'out_of_order_rejected', req),
    int('clientClockAnomalies', 'client_clock_anomalies', req),
    int('framesAnalysed', 'frames_analysed'),
    int('duplicateFrames', 'duplicate_frames'),
    num('effectiveFps', 'effective_fps'),
    num('maxBallGapMs', 'max_ball_gap_ms'),
    bool('nonceBound', 'nonce_bound', req),
    bool('serverTimeline', 'server_timeline', req),
  ]),
  bool('traceTruncated', 'trace_truncated', req),
  int('serverStartedAt', 'server_started_at'),
  int('serverEndedAt', 'server_ended_at'),
  int('serverDurationMs', 'server_duration_ms', req),
  bool('combineVerified', 'combine_verified', req),
  text('combineVerifiedBlockedBy', 'combine_verified_blocked_by', L.code),
];
/** The constant copy every experimental count carries (stated on the result, never stored). */
export const EXPERIMENTAL_NOTE = 'Experimental observation. Not a standardised Combine measurement.';

// ------------------------------------------------------------------ DDL (generated from the specs)
const rowOf = (name, c) => `FOREIGN KEY (${c}) REFERENCES ${name}(id) ON DELETE RESTRICT`;
/** A key to a record of the same player: `(c, player_id)` names a row of `name` (id, player_id). */
const samePlayer = (name, c, action = 'RESTRICT') =>
  `FOREIGN KEY (${c}, player_id) REFERENCES ${name}(id, player_id) ON DELETE ${action}`;
const ownedBy = (name, c, col = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${col}) ON DELETE CASCADE`;
const pad = (c) => c.padEnd(40);
const idCol = (c) => `${pad(c)} TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`;
const ordCol = (max = null) => `${pad('ord')} INTEGER NOT NULL CHECK (ord >= 0${max ? ` AND ord < ${max}` : ''})`;
const codeCol = (c = 'code') => `${pad(c)} TEXT NOT NULL CHECK (${CODE_SQL(c)})`;
const DAY_SQL = (c) =>
  `(${c} IS NULL OR (length(${c}) = 10 AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'))`;
const codeTable = (table, parent, parentTable, max, parentCol = 'id') =>
  `CREATE TABLE ${table} (\n  ${idCol(parent)},\n  ${ordCol(max)},\n  ${codeCol()},\n  ${ownedBy(parentTable, parent, parentCol)},\n  PRIMARY KEY (${parent}, ord)\n) STRICT;`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');

export const BOX_CAM_DDL = [
  tableDdl('box_cam_prefs', PREFS_SPEC, [
    'PRIMARY KEY (player_id)',
    'CHECK ((updated_at IS NULL) = (updated_by_kind IS NULL) AND (updated_at IS NULL) = (updated_by_id IS NULL))',
  ]),
  tableDdl('box_challenges', CHALLENGE_SPEC, [
    rowOf('orgs', 'publisher_org_id'),
    "CHECK ((publisher_kind = 'org') = (publisher_org_id IS NOT NULL))",
    "CHECK (publisher_kind = 'org' OR (publisher_org_name IS NULL AND publisher_by_name IS NULL))",
    'CHECK (target_total >= 1)',
    'CHECK (ends_at > starts_at)',
    'CHECK (cap IS NULL OR cap >= 1)',
  ]),
  'CREATE INDEX box_challenges_publisher_org ON box_challenges (publisher_org_id) WHERE publisher_org_id IS NOT NULL;',
  'CREATE INDEX box_challenges_status_ends ON box_challenges (status, ends_at);',
  tableDdl('box_challenge_entries', ENTRY_SPEC, [
    rowOf('box_challenges', 'challenge_id'),
    'UNIQUE (id, player_id)',
    'CHECK (progress >= 0)',
    "CHECK ((status = 'completed') = (completed_at IS NOT NULL))",
  ]),
  'CREATE UNIQUE INDEX box_challenge_entries_challenge_player ON box_challenge_entries (challenge_id, player_id);',
  'CREATE INDEX box_challenge_entries_player ON box_challenge_entries (player_id, status);',
  tableDdl('box_assignments', ASSIGNMENT_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'assigned_by_user_id'),
    rowOf('dev_objectives', 'objective_id'),
    'UNIQUE (id, player_id)',
    'CHECK (target_value > 0)',
    'CHECK (frequency_per_week IS NULL OR frequency_per_week BETWEEN 1 AND 14)',
    `CHECK ${DAY_SQL('due_date')}`,
  ]),
  'CREATE INDEX box_assignments_org ON box_assignments (org_id, player_id);',
  'CREATE INDEX box_assignments_player ON box_assignments (player_id);',
  tableDdl('box_sessions', SESSION_SPEC, [
    samePlayer('box_assignments', 'assignment_id'),
    samePlayer('box_challenge_entries', 'challenge_entry_id'),
    'UNIQUE (id, player_id)',
    "CHECK (length(nonce_hash) = 64 AND nonce_hash NOT GLOB '*[^0-9a-f]*')",
    'CHECK (last_seq >= 0 AND batches >= 0)',
    "CHECK (status NOT IN ('verified','partially_verified','unable_to_verify','completed_unverified','invalidated') OR status = verification_state)",
    "CHECK ((verification_state = 'invalidated') = (previous_verification_state IS NOT NULL))",
  ]),
  'CREATE INDEX box_sessions_player ON box_sessions (player_id, ended_at);',
  'CREATE INDEX box_sessions_assignment ON box_sessions (assignment_id) WHERE assignment_id IS NOT NULL;',
  `CREATE TABLE box_session_observations (\n  ${idCol('session_id')},\n  ${ordCol(L.maxObservations)},\n  ${pad('kind')} TEXT NOT NULL CHECK (kind IN (${enumIn(OBSERVATION_KINDS)})),\n  ${pad('from_ms')} REAL,\n  ${pad('to_ms')} REAL,\n  ${pad('at_ms')} REAL,\n  ${pad('quality')} TEXT CHECK (quality IS NULL OR quality IN (${enumIn(QUALITY)})),\n  ${pad('confidence')} REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),\n  ${ownedBy('box_sessions', 'session_id')},\n  PRIMARY KEY (session_id, ord),\n  CHECK (kind NOT IN ('active','presence','ball','interruption','multi_person') OR (from_ms IS NOT NULL AND to_ms IS NOT NULL AND at_ms IS NULL)),\n  CHECK (kind NOT IN ('rep','set') OR (at_ms IS NOT NULL AND from_ms IS NULL AND to_ms IS NULL)),\n  CHECK (kind <> 'pause' OR (from_ms IS NOT NULL AND at_ms IS NULL)),\n  CHECK (kind IN ('active','presence') OR quality IS NULL),\n  CHECK (kind = 'rep' OR confidence IS NULL)\n) STRICT;`,
  codeTable('box_session_reasons', 'session_id', 'box_sessions', L.reasons),
  tableDdl(
    'box_session_integrity_events',
    [idf('sessionId', 'session_id', req), int('ord', 'ord', req), ...INTEGRITY_SPEC],
    [
      ownedBy('box_sessions', 'session_id'),
      'PRIMARY KEY (session_id, ord)',
      'CHECK (ord >= 0)',
      "CHECK ((type = 'invalidated') = (outcome IS NOT NULL))",
      "CHECK ((type = 'restored') = (to_state IS NOT NULL))",
      "CHECK (type = 'invalidated' OR dispute_id IS NULL)",
    ],
  ),
  tableDdl('box_cam_disputes', DISPUTE_SPEC, [
    samePlayer('box_sessions', 'session_id', 'CASCADE'),
    "CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))",
    'CHECK ((resolved_at IS NULL) = (resolution_outcome IS NULL) AND (resolved_at IS NULL) = (resolution_reason IS NULL))',
  ]),
  'CREATE INDEX box_cam_disputes_queue ON box_cam_disputes (status, created_at, id);',
  'CREATE INDEX box_cam_disputes_created ON box_cam_disputes (created_at, id);',
  tableDdl('combine_requests', REQUEST_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'requested_by_user_id'),
    'UNIQUE (id, player_id)',
    `CHECK ${DAY_SQL('deadline_date')}`,
    "CHECK ((state = 'completed') = (completed_at IS NOT NULL) OR state = 'cancelled')",
  ]),
  'CREATE INDEX combine_requests_org ON combine_requests (org_id, player_id);',
  'CREATE INDEX combine_requests_player ON combine_requests (player_id, state);',
  `CREATE TABLE combine_request_protocols (\n  ${idCol('request_id')},\n  ${ordCol(L.protocols)},\n  ${idCol('protocol_id')},\n  ${ownedBy('combine_requests', 'request_id')},\n  PRIMARY KEY (request_id, ord),\n  UNIQUE (request_id, protocol_id)\n) STRICT;`,
  tableDdl(
    'combine_attempts',
    [...ATTEMPT_SPEC, ...CALIBRATION_SPEC.map((f) => ({ ...f, req: false }))],
    [
      samePlayer('box_sessions', 'box_session_id'),
      samePlayer('combine_requests', 'request_id'),
      'CHECK ((calibration_passed IS NULL) = (calibrated_at IS NULL))',
      'CHECK (attempt_number >= 1)',
    ],
  ),
  'CREATE UNIQUE INDEX combine_attempts_box_session ON combine_attempts (box_session_id);',
  'CREATE INDEX combine_attempts_player ON combine_attempts (player_id, protocol_id, created_at);',
  codeTable('combine_attempt_reasons', 'attempt_id', 'combine_attempts', L.reasons),
  `CREATE TABLE combine_attempt_calibration_checks (\n  ${idCol('attempt_id')},\n  ${ordCol(L.calibrationChecks)},\n  ${pad('check_name')} TEXT NOT NULL CHECK (length(check_name) > 0 AND length(check_name) <= ${L.calibrationCheck}),\n  ${ownedBy('combine_attempts', 'attempt_id')},\n  PRIMARY KEY (attempt_id, ord)\n) STRICT;`,
  tableDdl('box_cam_cv_results', CV_SPEC, [
    ownedBy('box_sessions', 'session_id'),
    'PRIMARY KEY (provider_session_id)',
    "CHECK ((outcome = 'refused') = (refusal_reason IS NOT NULL))",
    'CHECK (combine_verified = 0)',
  ]),
  'CREATE INDEX box_cam_cv_results_session ON box_cam_cv_results (session_id);',
  `CREATE TABLE box_cam_cv_result_codes (\n  ${idCol('provider_session_id')},\n  ${pad('list')} TEXT NOT NULL CHECK (list IN ('quality','secondary')),\n  ${ordCol(L.qualityReasons)},\n  ${codeCol()},\n  ${pad('value')} REAL,\n  ${pad('threshold')} REAL,\n  ${ownedBy('box_cam_cv_results', 'provider_session_id', 'provider_session_id')},\n  PRIMARY KEY (provider_session_id, list, ord),\n  CHECK (list = 'quality' OR (value IS NULL AND threshold IS NULL))\n) STRICT;`,
  `CREATE TABLE box_cam_cv_result_trace (\n  ${idCol('provider_session_id')},\n  ${ordCol(L.trace)},\n  ${pad('at_ms')} REAL,\n  ${pad('confidence')} REAL,\n  ${ownedBy('box_cam_cv_results', 'provider_session_id', 'provider_session_id')},\n  PRIMARY KEY (provider_session_id, ord)\n) STRICT;`,
].join('\n');
export const BOX_CAM_TABLES = Object.freeze([
  'box_cam_prefs',
  'box_challenges',
  'box_challenge_entries',
  'box_assignments',
  'box_sessions',
  'box_session_observations',
  'box_session_reasons',
  'box_session_integrity_events',
  'box_cam_disputes',
  'combine_requests',
  'combine_request_protocols',
  'combine_attempts',
  'combine_attempt_reasons',
  'combine_attempt_calibration_checks',
  'box_cam_cv_results',
  'box_cam_cv_result_codes',
  'box_cam_cv_result_trace',
]);

// ------------------------------------------------------------------ rows
const cols = (spec) => flat(spec).map((f) => f.c);
const OBS_KEYS = {
  active: 'active',
  presence: 'presence',
  ball: 'ball',
  rep: 'reps',
  set: 'sets',
  pause: 'pauses',
  interruption: 'interruptions',
  multi_person: 'multiPerson',
};
const OBS_FIELDS = ['kind', 'fromMs', 'toMs', 'atMs', 'quality', 'confidence'];
/** The engine's view of the stream (what `finalize()` reads), from ordered rows. */
function obsFromRows(rows) {
  const obs = Object.fromEntries(Object.values(OBS_KEYS).map((k) => [k, []]));
  for (const r of rows) {
    const k = OBS_KEYS[r.kind];
    if (r.kind === 'rep') obs.reps.push({ atMs: r.atMs, confidence: r.confidence });
    else if (r.kind === 'set') obs.sets.push({ atMs: r.atMs });
    else if (r.kind === 'active' || r.kind === 'presence')
      obs[k].push({ fromMs: r.fromMs, toMs: r.toMs, quality: r.quality });
    else obs[k].push({ fromMs: r.fromMs, toMs: r.toMs });
  }
  return obs;
}
const decodeObsRow = (r) => ({
  kind: r.kind,
  fromMs: r.from_ms,
  toMs: r.to_ms,
  atMs: r.at_ms,
  quality: r.quality,
  confidence: r.confidence,
});
function decodeSessions(sqlite, rows, { obs = false } = {}) {
  const sids = rows.map((r) => r.id);
  const reasons = childRowsOf(sqlite, 'box_session_reasons', 'session_id', sids, { order: 'ord' });
  const events = childRowsOf(sqlite, 'box_session_integrity_events', 'session_id', sids, { order: 'ord' });
  const ob = obs ? childRowsOf(sqlite, 'box_session_observations', 'session_id', sids, { order: 'ord' }) : null;
  return rows.map((row) => ({
    ...decode(SESSION_SPEC, row),
    verificationReasons: reasons.all(row.id).map((x) => x.code),
    integrityEvents: events
      .all(row.id)
      .map((e) => Object.fromEntries(Object.entries(decode(INTEGRITY_SPEC, e)).filter(([, v]) => v !== null))),
    ...(obs ? { obs: obsFromRows(ob.all(row.id).map(decodeObsRow)) } : {}),
  }));
}
function decodeRequests(sqlite, rows) {
  const pr = childRowsOf(
    sqlite,
    'combine_request_protocols',
    'request_id',
    rows.map((r) => r.id),
    { order: 'ord' },
  );
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
      calibrationResult:
        row.calibrated_at === null
          ? null
          : {
              required: [...required],
              passed: row.calibration_passed === 1,
              checks: ck.all(row.id).map((x) => x.check_name),
              at: row.calibrated_at,
            },
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
      sessionId: r.sessionId,
      providerSessionId: r.providerSessionId,
      protocolId: r.protocolId,
      providerId: r.providerId,
      providerVersion: r.providerVersion,
      engineVersion: r.engineVersion,
      cvPolicyVersion: r.cvPolicyVersion,
      outcome: r.outcome,
      refusalReason: r.refusalReason,
      refusalDetail: r.refusalDetail,
      observationQuality: {
        ...r.observationQuality,
        reasons: c
          .filter((x) => x.list === 'quality')
          .map((x) => ({ code: x.code, value: x.value, threshold: x.threshold })),
        secondaryDiagnostics: c.filter((x) => x.list === 'secondary').map((x) => x.code),
      },
      derived: r.derived,
      experimental: { ...r.experimental, note: EXPERIMENTAL_NOTE },
      integrity: r.integrity,
      trace: trace.all(row.provider_session_id).map((x) => ({ atMs: x.at_ms, confidence: x.confidence })),
      traceTruncated: r.traceTruncated,
      serverStartedAt: r.serverStartedAt,
      serverEndedAt: r.serverEndedAt,
      serverDurationMs: r.serverDurationMs,
      combineVerified: r.combineVerified,
      combineVerifiedBlockedBy: r.combineVerifiedBlockedBy,
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
  read(sqlite) {
    return boxCamLive(sqlite) ? readAll(sqlite) : null;
  },
};
const PLAYER_REFS_SQL =
  'SELECT player_id AS pid FROM box_sessions UNION ALL SELECT player_id FROM box_assignments UNION ALL SELECT player_id FROM combine_attempts UNION ALL SELECT player_id FROM combine_requests';
export const unresolvedPlayerReferences = (sqlite) =>
  boxCamLive(sqlite)
    ? {
        boxCam: sqlite
          .prepare(
            `SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`,
          )
          .get().n,
      }
    : null;

// ------------------------------------------------------------------ the repository
/** The sort key of a newest-first page of records: `[createdAt, id]`. */
export const newestFirstKey = (r) => [r.createdAt, r.id];
/** The states an assignment's progress moves it to (from any state but cancelled). */
export const ASSIGNMENT_PROGRESS_STATES = Object.freeze(['in_progress', 'partially_completed', 'completed']);
/** The columns `sessions.finish` sets: the result the engine worked out from the accepted stream. */
const FINISH_FIELDS = new Set([
  'status',
  'endedAt',
  'sessionDurationMs',
  'verifiedActiveMs',
  'verifiedReps',
  'setsCompleted',
  'targetCompleted',
  'quality',
  'interruptionsCount',
  'verificationState',
  'resultHash',
  'finalizedAt',
]);
/** The columns `attempts.measure` sets. */
const MEASURE_FIELDS = new Set(['measuredValue', 'measurementState', 'combineState', 'completedAt', 'resultHash']);
const FINISHED_SQL = (c = 'status') => `${c} IN (${enumIn(VERIFICATION_STATES)})`;

/**
 * `createBoxCamRepository({ sqlite, unit, now, log })`: `prefs`, `challenges`, `entries`, `assignments`, `sessions`,
 * `disputes`, `requests`, `attempts` and `cvResults`, each with its writes and queries, plus `reads` (the queries
 * alone: `boxCamReads`). An act is `act(id, input)` and returns the stored record.
 */
export function createBoxCamRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the Box Cam repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const {
    refusal: refuse,
    invalid,
    rowStep,
    listOf,
    readsBackAsWritten,
    newRecord,
    columnsOf,
    q,
    guarded,
  } = writeKit(sqlite, 'BOX_CAM');
  const WRITES = new Set();
  const writes = (o) => {
    for (const k of Object.keys(o)) WRITES.add(k);
    return o;
  };
  const insertRow = (table, row) => {
    const c = Object.keys(row);
    q(`INSERT INTO ${table} (${c.join(', ')}) VALUES (${c.map((x) => `@${x}`).join(', ')})`).run(row);
  };
  const one = (decoder) => (sql) => (id) => {
    if (typeof id !== 'string') return null;
    const row = q(sql).get(id);
    return row ? deepFreeze(decoder([row])[0]) : null;
  };
  const many =
    (decoder) =>
    (sql) =>
    (...args) =>
      decoder(q(sql).all(...args)).map(deepFreeze);
  const json = (list) => JSON.stringify([...list]);
  /** A whole new record: its row, then its child rows, then it must read back as written. */
  const create = (table, byId, t, write) =>
    operation(() => {
      newRecord(table, (id) => !!byId(id), t);
      write((part, fn) => rowStep(table, t.id, part, fn));
      const stored = byId(t.id);
      readsBackAsWritten(table, t.id, t, stored);
      return stored;
    });
  /** Named acts on one table: the record must exist, the act's writes run, and the stored record is returned. */
  const acts = (table, byId, defs) =>
    writes(
      Object.fromEntries(
        Object.entries(defs).map(([act, fn]) => [
          act,
          (id, input = {}) =>
            operation(() => {
              if (!byId(id)) throw refuse('NOT_FOUND', `${table} ${id} is not a record of the repository`);
              const check = rowStep(table, id, act, () => fn(id, input));
              const stored = byId(id);
              if (typeof check === 'function') check(stored);
              return stored;
            }),
        ]),
      ),
    );
  /** A record's coded child rows (`code` by `ord`), replaced whole. */
  const codeRows = (table, owner, id, field, list) => {
    q(`DELETE FROM ${table} WHERE ${owner} = ?`).run(id);
    listOf(table, id, field, list).forEach((code, i) => insertRow(table, { [owner]: id, ord: i, code }));
  };

  // ---- prefs
  const PREFS = 'box_cam_prefs';
  const prefsOf = one(decodeWith(PREFS_SPEC))('SELECT * FROM box_cam_prefs WHERE player_id = ?');
  const prefs = {
    /** The player's saved preferences, or the defaults (reading never creates a row). */
    forPlayer: (playerId) => prefsOf(playerId) ?? deepFreeze(defaultPrefs(playerId)),
    /** Has the player shared development activity for recruitment? */
    sharesForRecruitment: (playerId) =>
      !!q("SELECT 1 FROM box_cam_prefs WHERE player_id = ? AND share_development_activity = 'recruitment'").get(
        playerId,
      ),
    ...writes({
      /** Save the player's preferences whole (the row is created on the first save); they must read back as written. */
      save: (p) =>
        operation(() => {
          if (!isPlainObject(p) || typeof p.playerId !== 'string' || !p.playerId)
            throw invalid(`${PREFS}: preferences need a playerId`);
          rowStep(PREFS, p.playerId, 'row', () =>
            q(upsertSql(PREFS, PREFS_SPEC, ['player_id'])).run(columnsOf(PREFS, p.playerId, PREFS_SPEC, p)),
          );
          const stored = prefsOf(p.playerId);
          readsBackAsWritten(PREFS, p.playerId, p, stored);
          return stored;
        }),
    }),
  };

  // ---- challenges and entries
  const CHALLENGES = 'box_challenges';
  const decC = decodeWith(CHALLENGE_SPEC);
  const challengeById = one(decC)('SELECT * FROM box_challenges WHERE id = ?');
  const challenges = {
    ...writes({
      /** A new challenge, whole. */
      create: (c) =>
        create(CHALLENGES, challengeById, c, (step) =>
          step('row', () => insertRow(CHALLENGES, columnsOf(CHALLENGES, c.id, CHALLENGE_SPEC, c))),
        ),
    }),
    byId: challengeById,
    /** An organisation's own challenges, newest first. */
    forOrg: many(decC)(
      "SELECT * FROM box_challenges WHERE publisher_kind = 'org' AND publisher_org_id = ? ORDER BY created_at DESC, id DESC",
    ),
    /** Active challenges that have not ended at `at`, oldest first (the eligibility rule is the route's). */
    open: (at) =>
      many(decC)("SELECT * FROM box_challenges WHERE status = 'active' AND ends_at >= ? ORDER BY rowid")(at),
    /** Entries per challenge: Map id → count. */
    participants: (challengeIds) =>
      new Map(
        challengeIds
          .map((id) => [id, 0])
          .concat(
            q(
              'SELECT challenge_id AS id, count(*) AS n FROM box_challenge_entries WHERE challenge_id IN (SELECT value FROM json_each(?)) GROUP BY challenge_id',
            )
              .all(json(challengeIds))
              .map((r) => [r.id, r.n]),
          ),
      ),
  };
  const ENTRIES = 'box_challenge_entries';
  const decE = decodeWith(ENTRY_SPEC);
  const entryById = one(decE)('SELECT * FROM box_challenge_entries WHERE id = ?');
  const entries = {
    ...writes({
      /** A player joins a challenge, once. */
      create: (e) => {
        if (
          isPlainObject(e) &&
          q('SELECT 1 FROM box_challenge_entries WHERE challenge_id = ? AND player_id = ?').get(
            e.challengeId,
            e.playerId,
          )
        )
          throw refuse('DUPLICATE', `${e.playerId} already joined ${e.challengeId}`);
        return create(ENTRIES, entryById, e, (step) =>
          step('row', () => insertRow(ENTRIES, columnsOf(ENTRIES, e.id, ENTRY_SPEC, e))),
        );
      },
    }),
    ...acts(ENTRIES, entryById, {
      /** The progress worked out from the player's sessions; with `completedAt`, the entry completes (once). */
      progress: (id, { progress, completedAt = null }) =>
        guarded(
          ENTRIES,
          { id },
          "status = 'active'",
          { progress, ...(completedAt === null ? {} : { status: 'completed', completed_at: completedAt }) },
          `${ENTRIES} ${id} is not active`,
        ),
    }),
    byId: entryById,
    /** The player's entries, oldest first. */
    forPlayer: many(decE)('SELECT * FROM box_challenge_entries WHERE player_id = ? ORDER BY rowid'),
    countFor: (challengeId) =>
      q('SELECT count(*) AS n FROM box_challenge_entries WHERE challenge_id = ?').get(challengeId).n,
  };

  // ---- assignments
  const ASSIGNMENTS = 'box_assignments';
  const decA = decodeWith(ASSIGNMENT_SPEC);
  const assignmentById = one(decA)('SELECT * FROM box_assignments WHERE id = ?');
  const assignments = {
    ...writes({
      /** A new assignment, whole. */
      create: (a) =>
        create(ASSIGNMENTS, assignmentById, a, (step) =>
          step('row', () => insertRow(ASSIGNMENTS, columnsOf(ASSIGNMENTS, a.id, ASSIGNMENT_SPEC, a))),
        ),
    }),
    ...acts(ASSIGNMENTS, assignmentById, {
      /** The player (or their guardian) accepts an assignment still waiting for them. */
      accept: (id, { at }) =>
        guarded(
          ASSIGNMENTS,
          { id },
          "state = 'assigned'",
          { state: 'accepted', updated_at: at },
          `${ASSIGNMENTS} ${id} is not waiting to be accepted`,
        ),
      /** The club cancels it, once. */
      cancel: (id, { at }) =>
        guarded(
          ASSIGNMENTS,
          { id },
          "state <> 'cancelled'",
          { state: 'cancelled', updated_at: at },
          `${ASSIGNMENTS} ${id} is already cancelled`,
        ),
      /** A finished session moved it on; a cancelled assignment never moves. */
      progress: (id, { state, at }) => {
        if (!ASSIGNMENT_PROGRESS_STATES.includes(state))
          throw invalid(
            `${ASSIGNMENTS} ${id} state: progress moves an assignment to ${ASSIGNMENT_PROGRESS_STATES.join('|')}`,
          );
        guarded(
          ASSIGNMENTS,
          { id },
          "state <> 'cancelled'",
          { state, updated_at: at },
          `${ASSIGNMENTS} ${id} is cancelled`,
        );
      },
    }),
    byId: assignmentById,
    /** The player's assignments, oldest first. */
    forPlayer: many(decA)('SELECT * FROM box_assignments WHERE player_id = ? ORDER BY rowid'),
    /** An organisation's assignments (optionally for one player), newest first. */
    forOrg: (orgId, { playerId = null } = {}) =>
      many(decA)(
        'SELECT * FROM box_assignments WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC',
      )(orgId, playerId, playerId),
  };

  // ---- sessions
  const SESSIONS = 'box_sessions';
  const decS = (rows) => decodeSessions(sqlite, rows);
  const sessionById = one(decS)('SELECT * FROM box_sessions WHERE id = ?');
  const observationsOf = (id) =>
    obsFromRows(
      q('SELECT * FROM box_session_observations WHERE session_id = ? ORDER BY ord').all(id).map(decodeObsRow),
    );
  const obsCount = (id) => q('SELECT count(*) AS n FROM box_session_observations WHERE session_id = ?').get(id).n;
  /** One observation row; a field the table has no column for is refused, never dropped. */
  const insertObservation = (id, ord, o, at) => {
    if (!isPlainObject(o)) throw invalid(`${SESSIONS} ${id} ${at}: must be an object (got ${describe(o)})`);
    const unknown = Object.keys(o).filter((k) => !OBS_FIELDS.includes(k));
    if (unknown.length)
      throw invalid(`${SESSIONS} ${id} ${at}: carries field(s) this build does not store: ${unknown.join(', ')}`);
    insertRow('box_session_observations', {
      session_id: id,
      ord,
      kind: o.kind ?? null,
      from_ms: o.fromMs ?? null,
      to_ms: o.toMs ?? null,
      at_ms: o.atMs ?? null,
      quality: o.quality ?? null,
      confidence: o.confidence ?? null,
    });
  };
  const insertIntegrityEvent = (id, e) => {
    const ord = q('SELECT COALESCE(MAX(ord) + 1, 0) AS n FROM box_session_integrity_events WHERE session_id = ?').get(
      id,
    ).n;
    insertRow('box_session_integrity_events', { session_id: id, ord, ...columnsOf(SESSIONS, id, INTEGRITY_SPEC, e) });
  };
  const finished = (id, cols, what) =>
    guarded(SESSIONS, { id }, FINISHED_SQL(), cols, `${SESSIONS} ${id} is not finished; ${what} is refused`);
  const sessions = {
    ...writes({
      /** A new server-minted session, whole (with an accepted stream in the engine's shape, for fixtures). */
      create: (t) => {
        const { obs, ...rest } = isPlainObject(t) ? t : {};
        const stored = create(SESSIONS, sessionById, isPlainObject(t) ? rest : t, (step) => {
          step('row', () => insertRow(SESSIONS, columnsOf(SESSIONS, t.id, SESSION_SPEC, rest)));
          listOf(SESSIONS, t.id, 'verificationReasons', rest.verificationReasons).forEach((code, i) =>
            step(`verificationReasons[${i}]`, () =>
              insertRow('box_session_reasons', { session_id: t.id, ord: i, code }),
            ),
          );
          listOf(SESSIONS, t.id, 'integrityEvents', rest.integrityEvents, { objects: true }).forEach((e, i) =>
            step(`integrityEvents[${i}]`, () => insertIntegrityEvent(t.id, e)),
          );
          if (obs === undefined || obs === null) return;
          if (!isPlainObject(obs)) throw invalid(`${SESSIONS} ${t.id} obs: must be an object (got ${describe(obs)})`);
          let ord = 0;
          for (const [kind, key] of Object.entries(OBS_KEYS)) {
            listOf(SESSIONS, t.id, `obs.${key}`, obs[key], { objects: true }).forEach((x, i) =>
              step(`obs.${key}[${i}]`, () => insertObservation(t.id, ord++, { kind, ...x }, `obs.${key}[${i}]`)),
            );
          }
        });
        if (obs !== undefined && obs !== null) readsBackAsWritten(SESSIONS, t.id, obs, observationsOf(t.id), 'obs');
        return stored;
      },
      /**
       * Append one accepted batch: `observations` (`{ kind, fromMs, toMs, atMs, quality, confidence }`; a
       * `{ kind: 'resume', atMs }` closes the earliest open pause, as the engine does), then `lastSeq` and one more batch.
       */
      recordBatch: (id, { observations, lastSeq }) =>
        operation(() => {
          if (!sessionById(id)) throw refuse('NOT_FOUND', `${SESSIONS} ${id} is not a record of the repository`);
          let ord = obsCount(id);
          listOf(SESSIONS, id, 'observations', observations, { objects: true }).forEach((o, i) =>
            rowStep(SESSIONS, id, `observations[${i}]`, () => {
              if (o.kind !== 'resume') {
                insertObservation(id, ord++, o, `observations[${i}]`);
                return;
              }
              const open = q(
                "SELECT ord FROM box_session_observations WHERE session_id = ? AND kind = 'pause' AND to_ms IS NULL ORDER BY ord LIMIT 1",
              ).get(id);
              if (open)
                q('UPDATE box_session_observations SET to_ms = @at WHERE session_id = @id AND ord = @ord').run({
                  at: o.atMs ?? null,
                  id,
                  ord: open.ord,
                });
            }),
          );
          rowStep(SESSIONS, id, 'batch', () =>
            guarded(
              SESSIONS,
              { id },
              "status = 'recording' AND last_seq < @last_seq",
              { last_seq: lastSeq },
              `${SESSIONS} ${id}: lastSeq must grow while recording`,
              { set: 'batches = batches + 1' },
            ),
          );
          return sessionById(id);
        }),
    }),
    ...acts(SESSIONS, sessionById, {
      /** Liveness passed: recording starts. */
      start: (id, { at }) =>
        guarded(
          SESSIONS,
          { id },
          "status = 'setup_required'",
          { status: 'recording', liveness_passed_at: at, started_at: at },
          `${SESSIONS} ${id} is not waiting to start`,
        ),
      /** The session expired before it started. */
      expire: (id) =>
        guarded(
          SESSIONS,
          { id },
          "status = 'setup_required'",
          { status: 'cancelled' },
          `${SESSIONS} ${id} is not waiting to start`,
        ),
      /** Cancelled with no result to work out. */
      cancel: (id) =>
        guarded(
          SESSIONS,
          { id },
          `NOT ${FINISHED_SQL()}`,
          { status: 'cancelled', verification_state: 'cancelled' },
          `${SESSIONS} ${id} is already finished`,
        ),
      /** The production CV provider session bound to this recording. */
      bindCvSession: (id, { providerSessionId }) =>
        guarded(
          SESSIONS,
          { id },
          "status = 'recording'",
          { cv_provider_session_id: providerSessionId },
          `${SESSIONS} ${id} is not recording`,
        ),
      /** The result worked out from the accepted stream, once: the recording ends. */
      finish: (id, { verificationReasons = [], ...result }) => {
        guarded(
          SESSIONS,
          { id },
          "status = 'recording'",
          columnsOf(SESSIONS, id, SESSION_SPEC, result, { only: FINISH_FIELDS }),
          `${SESSIONS} ${id} is not recording`,
        );
        codeRows('box_session_reasons', 'session_id', id, 'verificationReasons', verificationReasons);
        return (stored) => readsBackAsWritten(SESSIONS, id, { ...result, verificationReasons }, stored);
      },
      /** The player's note on a finished session. */
      setNote: (id, { note }) => finished(id, { note }, 'a note'),
      /** The player's kept clip of a finished session. */
      attachClip: (id, { mediaId }) => finished(id, { clip_media_id: mediaId }, 'a clip'),
      /** Trust & Safety invalidates the result; the integrity history records it (only ever inserted). */
      invalidate: (id, { at, disputeId = null, outcome }) => {
        guarded(
          SESSIONS,
          { id },
          "verification_state IS NOT NULL AND verification_state <> 'invalidated'",
          { status: 'invalidated', invalidated_at: at },
          `${SESSIONS} ${id} has no result to invalidate`,
          { set: "previous_verification_state = verification_state, verification_state = 'invalidated'" },
        );
        insertIntegrityEvent(id, { type: 'invalidated', at, disputeId, outcome });
      },
      /** Trust & Safety restores the result the invalidation set aside. */
      restore: (id, { at }) => {
        const to =
          q(
            "SELECT previous_verification_state AS s FROM box_sessions WHERE id = ? AND verification_state = 'invalidated'",
          ).get(id)?.s ?? null;
        guarded(
          SESSIONS,
          { id },
          "verification_state = 'invalidated'",
          { status: to, verification_state: to, previous_verification_state: null, invalidated_at: null },
          `${SESSIONS} ${id} is not invalidated`,
        );
        insertIntegrityEvent(id, { type: 'restored', at, to });
      },
    }),
    byId: sessionById,
    /** The accepted stream in the engine's shape `{ active, presence, ball, reps, sets, pauses, interruptions, multiPerson }`. */
    observationsOf,
    /** How many observations the session holds. */
    observationCount: obsCount,
    /** How many observations of the four bounded kinds the session holds (the storage limit). */
    storedIntervals: (id) =>
      q(
        "SELECT count(*) AS n FROM box_session_observations WHERE session_id = ? AND kind IN ('active','presence','ball','rep')",
      ).get(id).n,
    /** All the player's sessions, in the order they were minted. */
    forPlayer: many(decS)('SELECT * FROM box_sessions WHERE player_id = ? ORDER BY rowid'),
    /** The player's finished sessions (a terminal status), newest ended first; `limit` caps the list. */
    finishedForPlayer: (playerId, { limit = -1 } = {}) =>
      many(decS)(
        `SELECT * FROM box_sessions WHERE player_id = ? AND ${FINISHED_SQL()} ORDER BY ended_at IS NULL, ended_at DESC, id DESC LIMIT ?`,
      )(playerId, limit),
    /** Sessions run against this assignment. */
    forAssignment: many(decS)('SELECT * FROM box_sessions WHERE assignment_id = ? ORDER BY rowid'),
    byIds: (sessionIds) =>
      many(decS)('SELECT * FROM box_sessions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY rowid')(
        json(sessionIds),
      ),
  };

  // ---- disputes
  const DISPUTES = 'box_cam_disputes';
  const decD = decodeWith(DISPUTE_SPEC);
  const disputeById = one(decD)('SELECT * FROM box_cam_disputes WHERE id = ?');
  const disputes = {
    ...writes({
      /** A dispute of one of the player's own sessions, whole. */
      create: (d) =>
        create(DISPUTES, disputeById, d, (step) =>
          step('row', () => insertRow(DISPUTES, columnsOf(DISPUTES, d.id, DISPUTE_SPEC, d))),
        ),
    }),
    ...acts(DISPUTES, disputeById, {
      /** Trust & Safety resolves it, once. */
      resolve: (id, { outcome, reason, at }) =>
        guarded(
          DISPUTES,
          { id },
          "status = 'open'",
          { status: 'resolved', resolution_outcome: outcome, resolution_reason: reason, resolved_at: at },
          `${DISPUTES} ${id} is already resolved`,
        ),
    }),
    byId: disputeById,
    /** The T&S queue, oldest first, one page: open ones unless `all`; `after` is the previous page's last `[createdAt, id]`. */
    queue: ({ all = false, after = null, limit = 50 } = {}) =>
      many(decD)(
        "SELECT * FROM box_cam_disputes WHERE (? = 1 OR status = 'open') AND (? IS NULL OR (created_at, id) > (?, ?)) ORDER BY created_at, id LIMIT ?",
      )(all ? 1 : 0, after ? 1 : null, after?.[0] ?? null, after?.[1] ?? null, limit),
  };

  // ---- Combine requests and attempts
  const REQUESTS = 'combine_requests';
  const decR = (rows) => decodeRequests(sqlite, rows);
  const requestById = one(decR)('SELECT * FROM combine_requests WHERE id = ?');
  const requests = {
    ...writes({
      /** A new request, whole, with the protocols it asks for in order. */
      create: (r) =>
        create(REQUESTS, requestById, r, (step) => {
          step('row', () => insertRow(REQUESTS, columnsOf(REQUESTS, r.id, REQUEST_SPEC, r)));
          listOf(REQUESTS, r.id, 'protocolIds', r.protocolIds).forEach((p, i) =>
            step(`protocolIds[${i}]`, () =>
              insertRow('combine_request_protocols', { request_id: r.id, ord: i, protocol_id: p }),
            ),
          );
        }),
    }),
    ...acts(REQUESTS, requestById, {
      /** Every protocol asked for was Combine Verified in the window: the request completes, once. */
      complete: (id, { at }) =>
        guarded(
          REQUESTS,
          { id },
          "state = 'requested'",
          { state: 'completed', completed_at: at },
          `${REQUESTS} ${id} is not open`,
        ),
      /** The club withdraws a request not yet completed. */
      cancel: (id) =>
        guarded(
          REQUESTS,
          { id },
          "state <> 'completed'",
          { state: 'cancelled' },
          `${REQUESTS} ${id} is already completed`,
        ),
    }),
    byId: requestById,
    /** The player's requests, oldest first. */
    forPlayer: many(decR)('SELECT * FROM combine_requests WHERE player_id = ? ORDER BY rowid'),
    /** An organisation's requests (optionally for one player), newest first. */
    forOrg: (orgId, { playerId = null } = {}) =>
      many(decR)(
        'SELECT * FROM combine_requests WHERE org_id = ? AND (? IS NULL OR player_id = ?) ORDER BY created_at DESC, id DESC',
      )(orgId, playerId, playerId),
    /** Does this organisation hold a request to this player that is not cancelled (the Combine consent rule)? */
    activeBetween: (orgId, playerId) =>
      !!q("SELECT 1 FROM combine_requests WHERE org_id = ? AND player_id = ? AND state <> 'cancelled' LIMIT 1").get(
        orgId,
        playerId,
      ),
    /** Players with a completed request from this organisation. */
    completedPlayerIds: (orgId) =>
      new Set(
        q("SELECT DISTINCT player_id AS p FROM combine_requests WHERE org_id = ? AND state = 'completed'")
          .all(orgId)
          .map((r) => r.p),
      ),
  };
  const ATTEMPTS = 'combine_attempts';
  const decT = (rows) => decodeAttempts(sqlite, rows);
  const attemptById = one(decT)('SELECT * FROM combine_attempts WHERE id = ?');
  const calibrationCols = (id, cal) => {
    if (cal === undefined || cal === null) return { calibration_passed: null, calibrated_at: null };
    if (!isPlainObject(cal))
      throw invalid(`${ATTEMPTS} ${id} calibrationResult: must be an object or null (got ${describe(cal)})`);
    return columnsOf(ATTEMPTS, id, CALIBRATION_SPEC, cal);
  };
  const checkRows = (id, checks) => {
    q('DELETE FROM combine_attempt_calibration_checks WHERE attempt_id = ?').run(id);
    listOf(ATTEMPTS, id, 'calibrationResult.checks', checks).forEach((c, i) =>
      insertRow('combine_attempt_calibration_checks', { attempt_id: id, ord: i, check_name: c }),
    );
  };
  const ready = (id, cols, what) =>
    guarded(
      ATTEMPTS,
      { id },
      "combine_state = 'ready'",
      cols,
      `${ATTEMPTS} ${id} is already finished; ${what} is refused`,
    );
  const attempts = {
    ...writes({
      /** A new attempt bound to its own freshly minted session (one attempt per session), whole. */
      create: (a) => {
        if (isPlainObject(a) && q('SELECT 1 FROM combine_attempts WHERE box_session_id = ?').get(a.boxSessionId))
          throw refuse('DUPLICATE', `${SESSIONS} ${a.boxSessionId} is already bound to an attempt`);
        return create(ATTEMPTS, attemptById, a, (step) => {
          step('row', () =>
            insertRow(ATTEMPTS, {
              ...columnsOf(ATTEMPTS, a.id, ATTEMPT_SPEC, a),
              ...calibrationCols(a.id, a.calibrationResult),
            }),
          );
          step('reasons', () => codeRows('combine_attempt_reasons', 'attempt_id', a.id, 'reasons', a.reasons));
          step('calibrationResult.checks', () => checkRows(a.id, a.calibrationResult?.checks));
        });
      },
    }),
    ...acts(ATTEMPTS, attemptById, {
      /** The calibration checks the player ran, replacing any earlier run. */
      calibrate: (id, { passed, checks, at }) => {
        ready(id, calibrationCols(id, { passed, at }), 'a calibration');
        checkRows(id, checks);
        return (stored) =>
          readsBackAsWritten(ATTEMPTS, id, { passed, checks, at }, stored.calibrationResult, 'calibrationResult');
      },
      /** The bound session's recording start, copied when the player submits it. */
      markStarted: (id, { startedAt }) => ready(id, { started_at: startedAt }, 'a start'),
      /** The player abandons the attempt. */
      cancel: (id, { at }) =>
        ready(id, { combine_state: 'cancelled', measurement_state: 'cancelled', completed_at: at }, 'a cancellation'),
      /** The measurement worked out from the finished session, once. */
      measure: (id, { reasons = [], ...result }) => {
        ready(id, columnsOf(ATTEMPTS, id, ATTEMPT_SPEC, result, { only: MEASURE_FIELDS }), 'a measurement');
        codeRows('combine_attempt_reasons', 'attempt_id', id, 'reasons', reasons);
        return (stored) => readsBackAsWritten(ATTEMPTS, id, { ...result, reasons }, stored);
      },
    }),
    byId: attemptById,
    /** The player's attempts, newest created first. */
    forPlayer: many(decT)('SELECT * FROM combine_attempts WHERE player_id = ? ORDER BY created_at DESC, id DESC'),
    /** The attempt bound to this session, or null. */
    bySession: one(decT)('SELECT * FROM combine_attempts WHERE box_session_id = ?'),
    /** How many of the player's attempts at this protocol (optionally in one mode, since `since`). */
    count: (playerId, protocolId, { mode = null, since = null } = {}) =>
      q(
        'SELECT count(*) AS n FROM combine_attempts WHERE player_id = ? AND protocol_id = ? AND (? IS NULL OR mode = ?) AND (? IS NULL OR created_at >= ?)',
      ).get(playerId, protocolId, mode, mode, since, since).n,
  };

  // ---- CV results
  const CV = 'box_cam_cv_results';
  const decV = (rows) => decodeCv(sqlite, rows);
  const cvByKey = one(decV)('SELECT * FROM box_cam_cv_results WHERE provider_session_id = ?');
  const cvResults = {
    ...writes({
      /** Record the provider's canonical result, once; it never changes and must read back as the provider built it. */
      record: (r) =>
        operation(() => {
          const key = isPlainObject(r) ? r.providerSessionId : undefined;
          if (typeof key !== 'string' || !key) throw invalid(`${CV}: a result needs a providerSessionId`);
          if (cvByKey(key)) throw refuse('DUPLICATE', `${CV} ${key} already exists`);
          const step = (part, fn) => rowStep(CV, key, part, fn);
          step('row', () => insertRow(CV, columnsOf(CV, key, CV_SPEC, r)));
          const oq = isPlainObject(r.observationQuality) ? r.observationQuality : {};
          listOf(CV, key, 'observationQuality.reasons', oq.reasons, { objects: true }).forEach((x, i) =>
            step(`observationQuality.reasons[${i}]`, () =>
              insertRow('box_cam_cv_result_codes', {
                provider_session_id: key,
                list: 'quality',
                ord: i,
                code: x.code ?? null,
                value: x.value ?? null,
                threshold: x.threshold ?? null,
              }),
            ),
          );
          listOf(CV, key, 'observationQuality.secondaryDiagnostics', oq.secondaryDiagnostics).forEach((c, i) =>
            step(`observationQuality.secondaryDiagnostics[${i}]`, () =>
              insertRow('box_cam_cv_result_codes', { provider_session_id: key, list: 'secondary', ord: i, code: c }),
            ),
          );
          listOf(CV, key, 'trace', r.trace, { objects: true }).forEach((x, i) =>
            step(`trace[${i}]`, () =>
              insertRow('box_cam_cv_result_trace', {
                provider_session_id: key,
                ord: i,
                at_ms: x.atMs ?? null,
                confidence: x.confidence ?? null,
              }),
            ),
          );
          const stored = cvByKey(key);
          readsBackAsWritten(CV, key, r, stored);
          return stored;
        }),
    }),
    byProviderSession: cvByKey,
    /** The latest result recorded for this Box Cam session, or null. */
    latestForSession: (sessionId) => {
      const row = q('SELECT * FROM box_cam_cv_results WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sessionId);
      return row ? deepFreeze(decV([row])[0]) : null;
    },
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { prefs, challenges, entries, assignments, sessions, disputes, requests, attempts, cvResults };
  const counters = Object.fromEntries(
    [
      ['boxCamPrefs', 'box_cam_prefs'],
      ['boxChallenges', 'box_challenges'],
      ['boxChallengeEntries', 'box_challenge_entries'],
      ['boxAssignments', 'box_assignments'],
      ['boxSessions', 'box_sessions'],
      ['boxCamDisputes', 'box_cam_disputes'],
      ['combineRequests', 'combine_requests'],
      ['combineAttempts', 'combine_attempts'],
      ['boxCamCvResults', 'box_cam_cv_results'],
    ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]),
  );
  return {
    ...repo,
    /** The queries alone, for modules and projectors that must not write (`boxCamReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!boxCamLive(sqlite))
        throw new Error(
          `the Box Cam repository needs ${BOX_CAM_MIGRATION} recorded; it never imports an in-memory array`,
        );
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(BOX_CAM_COLLECTIONS.map((n) => [n, counters[n].get().n]));
    },
    pending: () => 0,
    exportAll() {
      return BOX_CAM_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}

/** Insert the ScoutBox challenges (the migration). */
export function seedScoutboxChallenges(sqlite, now) {
  const st = sqlite.prepare(insertSql('box_challenges', CHALLENGE_SPEC));
  for (const c of scoutboxChallenges(now)) st.run(encode(CHALLENGE_SPEC, c));
}
export const BOX_CAM_COLUMNS = Object.freeze({ session: cols(SESSION_SPEC), attempt: cols(ATTEMPT_SPEC) });
