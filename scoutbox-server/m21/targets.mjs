/**
 * M21 — objective targets.
 *
 * Some development goals define their own measurement. "Improve Box Touch 60
 * from 140 to 160+" is a goal whose objective is stated in the goal itself, so
 * ScoutBox can honestly say whether the stated number has been reached without
 * claiming anything about the player beyond it.
 *
 * Three rules shape this file, and the third is the important one:
 *
 *   1. A target is a COMPARISON, not a formula (§30). One metric, one
 *      operator, one number. There is no expression language here and there
 *      will not be one: an evaluable formula is a score with extra steps.
 *
 *   2. Only production-valid evidence can satisfy a production target (§29).
 *      The predicate is M16.1's own `isProductionValidCombine` — a demo or
 *      test-provider result is labelled simulated everywhere it appears and
 *      must never quietly cross a real threshold.
 *
 *   3. Meeting a target NEVER marks the goal achieved (§97/§98). Nothing in
 *      this file writes anything. It answers one question — is the stated
 *      measurement currently met — and a human decides what that means for
 *      the wider football objective, which a single number does not contain.
 *
 * Honest limitation, stated once here and carried on every payload: the only
 * source that can satisfy a target is an At-Home Combine attempt. Box Cam
 * sessions record observed training, not a verified metric; assessments record
 * an evaluator's opinion on a scale that is not comparable across templates.
 * Pretending either could satisfy a numeric threshold would be exactly the
 * fake quantification §31 forbids.
 */
import {
  COMBINE_PROTOCOLS, combineProtocol, latestCombineProtocol, isProductionValidCombine,
} from '../m16/combineShared.mjs';
import { PROVIDERS } from '../m16/drills.mjs';

/** Sources a target may measure against. Deliberately one. */
export const TARGET_SOURCES = Object.freeze(['combine_attempt']);

export const TARGET_OPERATORS = Object.freeze(['gte', 'gt', 'lte', 'lt', 'eq']);

export const OPERATOR_SYMBOLS = Object.freeze({ gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' });

/** The three states a target can be in. There is no fourth, and no number. */
export const TARGET_STATES = Object.freeze(['target_met', 'target_not_met', 'no_current_valid_measurement']);

export const TARGET_LIMITATION =
  'A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.';

/** Machine-readable reasons a target has no current measurement. */
export const NO_MEASUREMENT_REASONS = Object.freeze([
  'no_attempts', 'no_production_valid_attempt', 'protocol_version_mismatch', 'measurement_invalidated',
]);

const MAX_TARGET_VALUE = 100_000;

/**
 * Validate a target a client asked to attach to a goal (§96).
 *
 * Nothing is repaired. An unknown protocol, an operator pointing the wrong way
 * down the metric, a fractional value on an integer metric — each is a 400
 * with the reason, because every one of them means the author was describing
 * something other than what they typed.
 */
export function validateTarget(raw) {
  if (raw == null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'TARGET_MALFORMED', detail: 'A target must be an object.' };
  }

  const sourceType = String(raw.sourceType ?? '');
  if (!TARGET_SOURCES.includes(sourceType)) {
    return {
      error: 'TARGET_SOURCE_UNSUPPORTED',
      allowed: TARGET_SOURCES,
      detail: 'Only a standardized At-Home Combine measurement can satisfy an objective target. Box Cam records observed training and an assessment records an opinion — neither is a comparable number.',
    };
  }

  const protocolId = String(raw.protocolId ?? '');
  const known = COMBINE_PROTOCOLS.some((p) => p.id === protocolId);
  if (!known) {
    return {
      error: 'TARGET_PROTOCOL_UNKNOWN', protocolId,
      allowed: [...new Set(COMBINE_PROTOCOLS.map((p) => p.id))],
      detail: `"${protocolId}" is not a standardized Combine protocol.`,
    };
  }

  // Version is pinned at creation: a measurement taken under a different
  // version of the protocol is a different measurement, and silently comparing
  // across versions is how a target starts lying.
  const version = raw.protocolVersion == null || raw.protocolVersion === ''
    ? latestCombineProtocol(protocolId)?.version
    : Number(raw.protocolVersion);
  const proto = combineProtocol(protocolId, version);
  if (!proto) {
    return { error: 'TARGET_PROTOCOL_VERSION_UNKNOWN', protocolId, protocolVersion: version, detail: `Protocol ${protocolId} has no version ${raw.protocolVersion}.` };
  }

  // The metric is a property of the protocol, not of the request. A client
  // that names a different one is describing a measurement that does not exist.
  const metricType = raw.metricType == null || raw.metricType === '' ? proto.metricType : String(raw.metricType);
  if (metricType !== proto.metricType) {
    return {
      error: 'TARGET_METRIC_MISMATCH', protocolId, expected: proto.metricType, received: metricType,
      detail: `${proto.title} measures ${proto.metricType}, not ${metricType}.`,
    };
  }

  const operator = String(raw.operator ?? '');
  if (!TARGET_OPERATORS.includes(operator)) {
    return { error: 'TARGET_OPERATOR_UNKNOWN', allowed: TARGET_OPERATORS, detail: `Unknown operator "${operator}".` };
  }
  // An operator that points down a higher-is-better metric encodes "get
  // worse". It is almost always a mistake, and it is never a development
  // target, so it is refused rather than stored.
  const wantsMore = ['gte', 'gt'].includes(operator);
  const wantsLess = ['lte', 'lt'].includes(operator);
  if (proto.direction === 'higher' && wantsLess) {
    return { error: 'TARGET_OPERATOR_INCOMPATIBLE', operator, direction: proto.direction, detail: `${proto.title} improves as the number rises, so a "${OPERATOR_SYMBOLS[operator]}" target would set out to get worse.` };
  }
  if (proto.direction === 'lower' && wantsMore) {
    return { error: 'TARGET_OPERATOR_INCOMPATIBLE', operator, direction: proto.direction, detail: `${proto.title} improves as the number falls, so a "${OPERATOR_SYMBOLS[operator]}" target would set out to get worse.` };
  }
  // Equality on a measurement with sub-unit precision is unreachable in
  // practice; refusing it is kinder than storing a target that can never be met.
  if (operator === 'eq' && proto.precision !== 'integer') {
    return { error: 'TARGET_OPERATOR_INCOMPATIBLE', operator, detail: `${proto.title} is measured to ${proto.precision}, so an exact-equality target could never be reached.` };
  }

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return { error: 'TARGET_VALUE_INVALID', detail: 'A target value must be a number.' };
  if (value <= 0) return { error: 'TARGET_VALUE_INVALID', detail: 'A target value must be greater than zero.' };
  if (value > MAX_TARGET_VALUE) return { error: 'TARGET_VALUE_OUT_OF_RANGE', max: MAX_TARGET_VALUE, detail: `A target value must be at most ${MAX_TARGET_VALUE}.` };
  if (proto.precision === 'integer' && !Number.isInteger(value)) {
    return { error: 'TARGET_VALUE_INVALID', detail: `${proto.title} is counted in whole ${proto.metricUnit}, so the target must be a whole number.` };
  }
  // A protocol with a fixed measurement window cannot produce a number larger
  // than the window: "80 seconds of control in a 60-second protocol" is not an
  // ambitious target, it is an impossible one.
  if (proto.metricType === 'duration' && proto.protocolWindowMs) {
    const ceiling = proto.protocolWindowMs / 1000;
    if (value > ceiling) {
      return { error: 'TARGET_VALUE_OUT_OF_RANGE', max: ceiling, detail: `${proto.title} measures at most ${ceiling} ${proto.metricUnit}.` };
    }
  }

  return {
    value: {
      sourceType, protocolId, protocolVersion: proto.version,
      metricType: proto.metricType, metricUnit: proto.metricUnit,
      operator, value,
      // Frozen at creation so a later protocol revision cannot change what a
      // stored target meant when it was agreed.
      protocolTitle: proto.title, direction: proto.direction, precision: proto.precision,
    },
  };
}

/** Does one measurement satisfy the comparison? Pure, and the only place it happens. */
export function compare(measured, operator, target) {
  switch (operator) {
    case 'gte': return measured >= target;
    case 'gt': return measured > target;
    case 'lte': return measured <= target;
    case 'lt': return measured < target;
    case 'eq': return measured === target;
    default: return false;
  }
}

/**
 * The best production-valid attempt for a target, or null.
 *
 * "Best" means best in the protocol's own direction — the highest count, the
 * lowest time. Ties break on the earliest completion, so the same data always
 * yields the same attempt.
 */
export function bestValidAttempt({ attempts, sessions, target }) {
  const sessionById = sessions instanceof Map ? sessions : new Map((sessions ?? []).map((s) => [s.id, s]));
  const candidates = (attempts ?? []).filter((a) =>
    a.protocolId === target.protocolId
    && Number(a.protocolVersion) === Number(target.protocolVersion)
    && isProductionValidCombine(a, sessionById.get(a.boxSessionId) ?? null, PROVIDERS[a.provider]));
  if (!candidates.length) return null;
  const better = target.direction === 'lower'
    ? (x, y) => x.measuredValue < y.measuredValue
    : (x, y) => x.measuredValue > y.measuredValue;
  let best = candidates[0];
  for (const a of candidates.slice(1)) {
    if (better(a, best) || (a.measuredValue === best.measuredValue && (a.completedAt ?? 0) < (best.completedAt ?? 0))) best = a;
  }
  return best;
}

/**
 * Evaluate a target against a player's Combine attempts, right now.
 *
 * Three states, three different sentences — the M20 discipline applied here:
 * "not met" and "not measured" are different facts and must never render the
 * same way. A target whose only supporting result was invalidated returns to
 * `no_current_valid_measurement`, and the reason says which of the four
 * situations it is, so history stays honest rather than preserving a success
 * the evidence has withdrawn (§99).
 */
export function evaluateTarget({ target, attempts, sessions }) {
  if (!target) return null;
  const base = {
    sourceType: target.sourceType,
    protocolId: target.protocolId,
    protocolVersion: target.protocolVersion,
    protocolTitle: target.protocolTitle,
    operator: target.operator,
    operatorSymbol: OPERATOR_SYMBOLS[target.operator],
    value: target.value,
    metricUnit: target.metricUnit,
    statement: `${target.protocolTitle} ${OPERATOR_SYMBOLS[target.operator]} ${target.value} ${target.metricUnit}`,
    limitation: TARGET_LIMITATION,
  };

  const forProtocol = (attempts ?? []).filter((a) => a.protocolId === target.protocolId);
  const best = bestValidAttempt({ attempts, sessions, target });

  if (!best) {
    // Which absence is it? A player who has never attempted the protocol, one
    // whose only attempts were simulated, one who used a different version,
    // and one whose result was invalidated are four different situations and
    // a coach reading the plan needs to know which.
    const sessionById = sessions instanceof Map ? sessions : new Map((sessions ?? []).map((s) => [s.id, s]));
    let reason = 'no_attempts';
    if (forProtocol.length) {
      const sameVersion = forProtocol.filter((a) => Number(a.protocolVersion) === Number(target.protocolVersion));
      if (!sameVersion.length) reason = 'protocol_version_mismatch';
      else if (sameVersion.some((a) => {
        const s = sessionById.get(a.boxSessionId) ?? null;
        return s?.verificationState === 'invalidated' && ['combine_verified', 'partially_measured'].includes(a.combineState);
      })) reason = 'measurement_invalidated';
      else reason = 'no_production_valid_attempt';
    }
    return {
      ...base,
      state: 'no_current_valid_measurement',
      reason,
      measured: null,
      note: NO_MEASUREMENT_NOTES[reason],
    };
  }

  const met = compare(best.measuredValue, target.operator, target.value);
  return {
    ...base,
    state: met ? 'target_met' : 'target_not_met',
    reason: null,
    measured: {
      value: best.measuredValue,
      attemptId: best.id,
      completedAt: best.completedAt ?? null,
      protocolVersion: best.protocolVersion,
      combineVerified: true,
    },
    // §97/§98, on the payload rather than only in a document, because this is
    // the exact moment somebody would otherwise tick the goal automatically.
    note: met
      ? 'The stated measurement has been reached. Whether the wider development goal is achieved is a decision for the plan owner or reviewer — one measurement is not the whole objective.'
      : 'The stated measurement has not been reached yet.',
  };
}

const NO_MEASUREMENT_NOTES = Object.freeze({
  no_attempts: 'No Combine attempt has been recorded for this protocol yet.',
  no_production_valid_attempt: 'There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target.',
  protocol_version_mismatch: 'Results exist for this protocol, but under a different version of it. Measurements are not compared across protocol versions.',
  measurement_invalidated: 'The supporting Combine result was invalidated after review, so there is no current valid measurement. The link and its history are kept.',
});

export { NO_MEASUREMENT_NOTES };
