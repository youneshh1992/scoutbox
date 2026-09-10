// M16.1 — At-Home Combine pure engine + standardized protocol registry.
//
// At-Home Combine is a MEASUREMENT LAYER over Box Cam. It does not add a
// second camera/observation stack: every Combine Attempt binds to a real
// Box Cam session and inherits all of its integrity (server-minted id,
// nonce, liveness, monotonic events, drift bounds, server-derived values,
// client fields ignored, no upload-to-verify). This module is the pure,
// unit-testable part: the versioned protocol registry, the measurement
// derivation, personal bests and the club comparison — all pure functions
// over plain data.
//
// "Combine Verified" is not decoration. It means, precisely: the result was
// measured from a standardized ScoutBox Combine Protocol, during a live Box
// Cam session, using a detector/provider that genuinely supports the metric,
// with liveness + calibration passed, the measurement server-derived, and
// integrity intact. If any of that is untrue, another honest state is used.
import crypto from 'node:crypto';

// ------------------------------------------------------------------ states
export const COMBINE_STATES = [
  'not_started', 'setup_required', 'ready', 'attempt_in_progress', 'processing',
  'combine_verified', 'partially_measured', 'measurement_unavailable',
  'protocol_invalid', 'integrity_review', 'invalidated', 'cancelled',
];
export const COMBINE_TERMINAL = new Set([
  'combine_verified', 'partially_measured', 'measurement_unavailable',
  'protocol_invalid', 'integrity_review', 'invalidated', 'cancelled',
]);
export const METRIC_TYPES = ['count', 'time', 'distance', 'duration', 'set', 'percentage'];

export const COMBINE_STATE_COPY = {
  combine_verified: 'Measured from a standardized ScoutBox Combine Protocol during a live Box Cam session, with a supported detector, and passed the required integrity checks.',
  partially_measured: 'The standardized measurement window was not fully observed, so this attempt is recorded as a measurement but is not Combine Verified. No value is projected or estimated.',
  measurement_unavailable: 'This Combine measurement is not yet supported on this device. ScoutBox does not estimate or fabricate a result.',
  protocol_invalid: 'The attempt did not follow the standardized protocol, so no verified measurement was produced.',
  integrity_review: 'This result is under integrity review and does not currently count as Combine Verified.',
  invalidated: 'This Combine result was invalidated after review and no longer counts as Combine Verified.',
  cancelled: 'This Combine Attempt was cancelled before completion.',
};

// Capabilities beyond the Box Cam detector set that FUTURE athletic protocols
// need. No provider in this environment has them — not even the deterministic
// test provider — so those protocols can never be Combine Verified here. This
// is the honest boundary: we architect them, we never fake them.
export const FUTURE_CAPABILITIES = ['spatial_scale', 'timing_gate', 'target_zone'];

// ------------------------------------------------------------- protocols
// Every protocol is versioned. A historical attempt pins protocolId +
// protocolVersion + measurementAlgorithmVersion forever; a rule change is a
// NEW version and never rewrites past measurements.
const protocol = (p) => ({
  status: 'active',
  captureContexts: ['at_home', 'club', 'event'],
  maxVerifiedPerWindow: 3,
  windowMs: 86_400_000, // attempt-limit window (24h)
  practiceAllowed: true,
  calibrationRequirements: [],
  measurementAlgorithmVersion: 1,
  ageRestrictions: null,
  ...p,
});

export const COMBINE_PROTOCOLS = [
  protocol({
    id: 'combine-box-touch-60', version: 1, title: 'Box Touch 60', category: 'ball_mastery',
    description: 'As many controlled alternating touches on top of the ball as possible in 60 seconds.',
    drillId: 'box-touches', drillTarget: { type: 'repetitions', value: 2000 },
    metricType: 'count', metricUnit: 'touches', direction: 'higher', precision: 'integer',
    protocolWindowMs: 60_000,
    requiredCapabilities: ['player_presence', 'ball_presence', 'rep_count'],
    setupRequirements: 'Full body and ball in frame, stable phone, 2m × 2m clear area.',
    cameraRequirements: 'Portrait, ~2.5m distance, whole body and ball visible throughout.',
    spaceRequirements: '2m × 2m clear, level surface.',
    equipmentRequirements: ['ball'],
    startRule: 'The 60-second measurement window begins when the attempt starts.',
    finishRule: 'The window closes at 60 seconds. Only touches observed inside the window count.',
    validAttemptRules: 'Player and ball must remain observable. If observation is lost, the attempt is partially measured, never estimated.',
    scoringMethod: 'Verified, de-duplicated touch count inside the 60-second window.',
    safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.',
  }),
  protocol({
    id: 'combine-box-juggle', version: 1, title: 'Box Juggle', category: 'ball_mastery',
    description: 'Total verified juggles (keepy-uppies) within a 60-second window.',
    drillId: 'box-juggles', drillTarget: { type: 'repetitions', value: 2000 },
    metricType: 'count', metricUnit: 'juggles', direction: 'higher', precision: 'integer',
    protocolWindowMs: 60_000,
    requiredCapabilities: ['player_presence', 'ball_presence', 'rep_count'],
    setupRequirements: 'Full body in frame, ball never leaves the frame vertically.',
    cameraRequirements: 'Portrait, ~3m distance, high ceiling or outdoors preferred.',
    spaceRequirements: '2m × 2m clear area.',
    equipmentRequirements: ['ball'],
    startRule: 'The 60-second window begins when the attempt starts.',
    finishRule: 'Total verified juggles inside the window. Maximum-consecutive is not measured (no reliable detector).',
    validAttemptRules: 'Player and ball must remain observable throughout.',
    scoringMethod: 'Verified, de-duplicated juggle count inside the window.',
    safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.',
  }),
  protocol({
    id: 'combine-box-control-60', version: 1, title: 'Box Control 60', category: 'close_control',
    description: 'Verified active close-control time inside a fixed 60-second protocol.',
    drillId: 'box-control', drillTarget: { type: 'duration', value: 60_000 },
    metricType: 'duration', metricUnit: 'seconds', direction: 'higher', precision: 'tenths',
    protocolWindowMs: 60_000,
    // Duration only — this is the metric the production WEB provider genuinely
    // supports, so Box Control 60 can be Combine Verified in production today.
    requiredCapabilities: ['player_presence', 'ball_presence', 'active_duration'],
    setupRequirements: 'Whole 3m × 3m training area in frame.',
    cameraRequirements: 'Landscape, ~4m distance, entire area visible.',
    spaceRequirements: '3m × 3m clear, level surface.',
    equipmentRequirements: ['ball'],
    startRule: 'The 60-second window begins when the attempt starts.',
    finishRule: 'Verified active control time observed inside the window (max 60.0s).',
    validAttemptRules: 'If the ball or player leaves frame, that time does not count; a short-observed window is partially measured.',
    scoringMethod: 'Verified active-control seconds ∩ ball-visible, inside the window.',
    safetyNotes: 'Warm up first. Stop on any pain — recorded work still counts.',
  }),
  protocol({
    id: 'combine-box-footwork', version: 1, title: 'Box Footwork', category: 'footwork',
    description: 'Completed standardized lateral footwork intervals.',
    drillId: 'box-footwork', drillTarget: { type: 'sets', value: 5 },
    metricType: 'set', metricUnit: 'intervals', direction: 'higher', precision: 'integer',
    protocolWindowMs: 5 * 60_000,
    requiredCapabilities: ['player_presence', 'active_duration', 'interval_completion'],
    setupRequirements: 'Feet clearly visible between two markers.',
    cameraRequirements: 'Portrait, ~3m distance, feet visible.',
    spaceRequirements: '2m × 2m clear area.',
    equipmentRequirements: [],
    startRule: 'Intervals begin when the attempt starts.',
    finishRule: 'Number of completed intervals out of the target.',
    validAttemptRules: 'Player must remain observable during work intervals; rest intervals never count against the result.',
    scoringMethod: 'Count of completed intervals.',
    safetyNotes: 'Rest 30–60s between sets. Stop on any pain.',
  }),
  protocol({
    id: 'combine-box-strength-60', version: 1, title: 'Box Strength 60', category: 'strength',
    description: 'Valid observed bodyweight squat repetitions in 60 seconds. General physical-development evidence — not a measure of football ability.',
    drillId: 'box-strength', drillTarget: { type: 'repetitions', value: 2000 },
    metricType: 'count', metricUnit: 'reps', direction: 'higher', precision: 'integer',
    protocolWindowMs: 60_000,
    requiredCapabilities: ['player_presence', 'active_motion', 'rep_count'],
    setupRequirements: 'Full body side-on in frame.',
    cameraRequirements: 'Portrait, ~2.5m distance, side-on.',
    spaceRequirements: '2m × 1m clear area.',
    equipmentRequirements: [],
    startRule: 'The 60-second window begins when the attempt starts.',
    finishRule: 'Valid observed repetitions inside the window.',
    validAttemptRules: 'Controlled tempo; partial-range reps are not counted.',
    scoringMethod: 'Verified, de-duplicated squat count inside the window.',
    safetyNotes: 'Bodyweight only. Stop on any pain. Not medical advice.',
  }),

  // --------- FUTURE athletic protocols: architected, never fabricated -----
  // Each needs a capability no provider (test included) has, so its
  // measurementCapability is permanently `not_configured` here and no attempt
  // can ever be Combine Verified until a real detector ships.
  protocol({
    id: 'combine-agility-5-10-5', version: 1, title: '5-10-5 Agility', category: 'athletic',
    description: 'Standardized 5-10-5 pro-agility shuttle. Requires spatial calibration and automated timing gates.',
    drillId: null, metricType: 'time', metricUnit: 'seconds', direction: 'lower', precision: 'hundredths',
    protocolWindowMs: 60_000, requiredCapabilities: ['timing_gate', 'spatial_scale'],
    calibrationRequirements: ['box_marker_5m'], practiceAllowed: false,
    setupRequirements: 'Three markers exactly 5 metres apart (Box Marker).',
    scoringMethod: 'Automated start/finish timing — not available in this environment.',
    safetyNotes: 'Requires a large, flat, clear surface.',
  }),
  protocol({
    id: 'combine-accel-10m', version: 1, title: '10 m Acceleration', category: 'athletic',
    description: 'Standardized 10-metre acceleration. Requires spatial calibration and automated timing gates.',
    drillId: null, metricType: 'time', metricUnit: 'seconds', direction: 'lower', precision: 'hundredths',
    protocolWindowMs: 60_000, requiredCapabilities: ['timing_gate', 'spatial_scale'],
    calibrationRequirements: ['box_marker_10m'], practiceAllowed: false,
    setupRequirements: 'Two markers exactly 10 metres apart (Box Marker).',
    scoringMethod: 'Automated start/finish timing — not available in this environment.',
    safetyNotes: 'Requires a straight, flat, clear 15m+ run.',
  }),
  protocol({
    id: 'combine-broad-jump', version: 1, title: 'Standing Broad Jump', category: 'athletic',
    description: 'Standardized standing broad jump. Requires physical-scale calibration.',
    drillId: null, metricType: 'distance', metricUnit: 'centimetres', direction: 'higher', precision: 'centimetres',
    protocolWindowMs: 60_000, requiredCapabilities: ['spatial_scale'],
    calibrationRequirements: ['box_marker_scale'], practiceAllowed: false,
    setupRequirements: 'Calibration marker of known size in frame (Box Marker).',
    scoringMethod: 'Calibrated distance measurement — not available in this environment.',
    safetyNotes: 'Land safely on a soft, clear surface.',
  }),
  protocol({
    id: 'combine-passing-target', version: 1, title: 'Passing Target', category: 'technical',
    description: 'Successful passes into a defined target zone out of attempts. Requires target-zone detection.',
    drillId: null, metricType: 'percentage', metricUnit: '%', direction: 'higher', precision: 'integer',
    protocolWindowMs: 120_000, requiredCapabilities: ['target_zone', 'spatial_scale'],
    calibrationRequirements: ['box_marker_target'], practiceAllowed: false,
    setupRequirements: 'Defined target zone visible in frame.',
    scoringMethod: 'Objective successful/attempted ratio — not available in this environment.',
    safetyNotes: 'Clear the area around the target.',
  }),
];

export const combineProtocol = (id, version) => COMBINE_PROTOCOLS.find((p) => p.id === id && p.version === Number(version)) ?? null;
export const latestCombineProtocol = (id) => COMBINE_PROTOCOLS.filter((p) => p.id === id).sort((a, b) => b.version - a.version)[0] ?? null;

/** Is this protocol's metric genuinely measurable by the given provider
 *  capabilities? Pure set-containment — the single honesty gate that keeps
 *  unsupported measurements out of Combine Verified. */
export function measurementSupported(protocolDef, providerCapabilities = []) {
  const caps = new Set(providerCapabilities);
  return (protocolDef.requiredCapabilities ?? []).every((c) => caps.has(c));
}

/** The public measurement-capability status for a protocol given the
 *  best available production/active provider capabilities. */
export function measurementCapability(protocolDef, providerCapabilities = []) {
  return measurementSupported(protocolDef, providerCapabilities) ? 'configured' : 'not_configured';
}

// ---------------------------------------------------------- measurement
/** Derive a Combine measurement from a FINALIZED bound Box Cam session.
 *  Everything comes from the session's server-derived values — never a
 *  client field. Returns the measured value, the measurement state and the
 *  Combine state, with machine-readable reasons. No projection or
 *  extrapolation ever happens: a short-observed window is partial, not
 *  scaled up. */
export function measureAttempt({ protocolDef, session, calibrationPassed, providerCapabilities = [], mode = 'verified' }) {
  const reasons = [];
  const fail = (combineState, r, extra = {}) => ({ combineState, measurementState: combineState === 'combine_verified' ? 'measured' : combineState, measuredValue: null, reasons: [...reasons, r].filter(Boolean), ...extra });

  if (!protocolDef) return fail('protocol_invalid', 'PROTOCOL_UNKNOWN');
  if (!session) return fail('protocol_invalid', 'SESSION_MISSING');

  // Honesty gate: the active provider must genuinely support every required
  // capability. Otherwise the measurement is unavailable — never estimated.
  if (!measurementSupported(protocolDef, providerCapabilities)) {
    return fail('measurement_unavailable', 'MEASUREMENT_NOT_SUPPORTED', {
      missingCapabilities: protocolDef.requiredCapabilities.filter((c) => !providerCapabilities.includes(c)),
    });
  }

  // The bound session must itself be a legitimate Box Cam result. Note that
  // whether the session's *drill target* completed is irrelevant to a
  // Combine — a Combine has its own metric and measurement window. So
  // `verified` and `partially_verified` are treated identically here (both
  // mean Box Cam observed reliably); only a total observation failure, a
  // missing liveness/provider, cancellation or invalidation blocks a
  // measurement.
  if (session.verificationState === 'invalidated') return fail('invalidated', 'SESSION_INVALIDATED');
  if (session.verificationState === 'cancelled') return fail('cancelled', 'SESSION_CANCELLED');
  if (session.verificationState === 'completed_unverified') return fail('protocol_invalid', 'LIVENESS_OR_PROVIDER_MISSING');
  if (session.verificationState === 'unable_to_verify') return fail('measurement_unavailable', 'NO_RELIABLE_OBSERVATION');
  if (!['verified', 'partially_verified'].includes(session.verificationState)) return fail('protocol_invalid', 'SESSION_NOT_FINALIZED');

  const windowMs = protocolDef.protocolWindowMs;
  // The measurement is valid only if the standardized window was actually
  // observed. The window is "fully observed" when the server-known session
  // duration reaches it (±1 ms). A short capture is partial — NEVER projected.
  const observedMs = Math.min(session.sessionDurationMs ?? 0, windowMs);
  const windowFullyObserved = (session.sessionDurationMs ?? 0) >= windowMs - 1;
  let measuredValue = null;

  switch (protocolDef.metricType) {
    case 'count':
      if (session.verifiedReps == null) return fail('measurement_unavailable', 'COUNT_NOT_SUPPORTED');
      measuredValue = session.verifiedReps;
      break;
    case 'duration': {
      // Verified active seconds inside the window, tenths precision.
      const ms = Math.min(session.verifiedActiveMs ?? 0, windowMs);
      measuredValue = Math.round(ms / 100) / 10;
      break;
    }
    case 'set':
      if (session.setsCompleted == null) return fail('measurement_unavailable', 'INTERVAL_NOT_SUPPORTED');
      measuredValue = session.setsCompleted;
      break;
    default:
      return fail('measurement_unavailable', 'METRIC_NOT_SUPPORTED');
  }

  // Calibration binding, where the protocol requires it.
  if ((protocolDef.calibrationRequirements ?? []).length > 0 && !calibrationPassed) {
    return fail('protocol_invalid', 'CALIBRATION_NOT_PASSED', { measuredValue });
  }

  // Practice attempts never become Combine Verified.
  if (mode === 'practice') {
    return { combineState: 'partially_measured', measurementState: 'practice', measuredValue, reasons: [...reasons, 'PRACTICE_ATTEMPT'], practice: true, observedMs, windowMs };
  }

  // Combine Verified needs the full standardized window observed at good
  // quality. Otherwise it is a recorded measurement, not Combine Verified —
  // no projection, no estimation.
  if (!windowFullyObserved) {
    reasons.push('MEASUREMENT_WINDOW_INCOMPLETE');
    return { combineState: 'partially_measured', measurementState: 'partially_measured', measuredValue, observedMs, windowMs, reasons };
  }
  if (session.quality !== 'good') {
    reasons.push('OBSERVATION_QUALITY_DEGRADED');
    return { combineState: 'partially_measured', measurementState: 'partially_measured', measuredValue, observedMs, windowMs, reasons };
  }
  return { combineState: 'combine_verified', measurementState: 'measured', measuredValue, observedMs, windowMs, reasons };
}

/** Format a measured value for display at the protocol's declared precision.
 *  Never invents precision the calibration/metric cannot support. */
export function formatCombineValue(protocolDef, value) {
  if (value == null) return '—';
  switch (protocolDef.precision) {
    case 'integer': return `${Math.round(value)}`;
    case 'tenths': return value.toFixed(1);
    case 'hundredths': return value.toFixed(2);
    case 'centimetres': return `${Math.round(value)}`;
    default: return `${value}`;
  }
}

/** Personal best for a protocol@version, respecting metric direction. Only
 *  compares attempts with the SAME protocol id + version + metric semantics,
 *  and only Combine-Verified attempts whose bound session still stands. */
export function personalBest(attempts) {
  const verified = (attempts ?? []).filter((a) => a.effectiveState === 'combine_verified' && a.measuredValue != null);
  if (verified.length === 0) return null;
  const dir = verified[0].direction ?? 'higher';
  return verified.reduce((best, a) => {
    if (!best) return a;
    if (dir === 'lower') return a.measuredValue < best.measuredValue ? a : best;
    return a.measuredValue > best.measuredValue ? a : best;
  }, null);
}

/** Canonical Combine result hash — integrity provenance, not a blockchain.
 *  Covers player, attempt, protocol@version, bound session, the accepted
 *  metric input, the measured value, provider/version, algorithm version,
 *  completion time and integrity state. */
export function combineResultHash(attempt) {
  const canonical = JSON.stringify({
    playerId: attempt.playerId, attemptId: attempt.id,
    protocolId: attempt.protocolId, protocolVersion: attempt.protocolVersion,
    boxSessionId: attempt.boxSessionId,
    metricType: attempt.metricType, measuredValue: attempt.measuredValue,
    provider: attempt.provider, providerVersion: attempt.providerVersion,
    measurementAlgorithmVersion: attempt.measurementAlgorithmVersion,
    completedAt: attempt.completedAt, combineState: attempt.combineState,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Build a comparison matrix for a set of players over a set of protocols.
 *  Missing results are null (never zero); no overall ranking is produced —
 *  clubs sort individual columns themselves. */
export function comparisonMatrix({ players, protocols, bestByPlayerProtocol }) {
  return {
    protocols: protocols.map((p) => ({ id: p.id, version: p.version, title: p.title, metricUnit: p.metricUnit, direction: p.direction })),
    rows: players.map((pl) => ({
      playerId: pl.id, playerName: pl.name,
      cells: protocols.map((p) => {
        const b = bestByPlayerProtocol.get(`${pl.id}::${p.id}@${p.version}`) ?? null;
        return b ? { value: b.measuredValue, display: formatCombineValue(p, b.measuredValue), verified: true, at: b.completedAt } : null;
      }),
    })),
    note: 'Verified numbers only (✓). A blank cell means no verified result — not zero. ScoutBox does not rank players overall.',
  };
}
