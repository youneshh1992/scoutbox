/**
 * Objective targets: one Combine metric, one operator, one number. A
 * comparison, not a formula, since a formula is a score by another name.
 * Only production-valid results count, and meeting a target never marks the
 * goal achieved; a person decides that.
 */
import {
  COMBINE_PROTOCOLS,
  combineProtocol,
  latestCombineProtocol,
  isProductionValidCombine,
} from '../boxcam/combineShared.mjs';
import { PROVIDERS } from '../boxcam/drills.mjs';

/**
 * Box Cam sessions record observed training, not a verified metric, and
 * assessment scales are not comparable across templates, so only Combine
 * attempts can satisfy a target.
 */
export const TARGET_SOURCES = Object.freeze(['combine_attempt']);

export const TARGET_OPERATORS = Object.freeze(['gte', 'gt', 'lte', 'lt', 'eq']);

export const OPERATOR_SYMBOLS = Object.freeze({ gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' });

export const TARGET_STATES = Object.freeze(['target_met', 'target_not_met', 'no_current_valid_measurement']);

export const TARGET_LIMITATION =
  'A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.';

export const NO_MEASUREMENT_REASONS = Object.freeze([
  'no_attempts',
  'no_production_valid_attempt',
  'protocol_version_mismatch',
  'measurement_invalidated',
]);

const MAX_TARGET_VALUE = 100_000;

/** Nothing is repaired: each mismatch is a 400 with its reason. */
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
      detail:
        'Only a standardized At-Home Combine measurement can satisfy an objective target. Box Cam records observed training and an assessment records an opinion — neither is a comparable number.',
    };
  }

  const protocolId = String(raw.protocolId ?? '');
  const known = COMBINE_PROTOCOLS.some((p) => p.id === protocolId);
  if (!known) {
    return {
      error: 'TARGET_PROTOCOL_UNKNOWN',
      protocolId,
      allowed: [...new Set(COMBINE_PROTOCOLS.map((p) => p.id))],
      detail: `"${protocolId}" is not a standardized Combine protocol.`,
    };
  }

  // Pinned at creation: results are never compared across protocol versions.
  const version =
    raw.protocolVersion == null || raw.protocolVersion === ''
      ? latestCombineProtocol(protocolId)?.version
      : Number(raw.protocolVersion);
  const proto = combineProtocol(protocolId, version);
  if (!proto) {
    return {
      error: 'TARGET_PROTOCOL_VERSION_UNKNOWN',
      protocolId,
      protocolVersion: version,
      detail: `Protocol ${protocolId} has no version ${raw.protocolVersion}.`,
    };
  }

  const metricType = raw.metricType == null || raw.metricType === '' ? proto.metricType : String(raw.metricType);
  if (metricType !== proto.metricType) {
    return {
      error: 'TARGET_METRIC_MISMATCH',
      protocolId,
      expected: proto.metricType,
      received: metricType,
      detail: `${proto.title} measures ${proto.metricType}, not ${metricType}.`,
    };
  }

  const operator = String(raw.operator ?? '');
  if (!TARGET_OPERATORS.includes(operator)) {
    return { error: 'TARGET_OPERATOR_UNKNOWN', allowed: TARGET_OPERATORS, detail: `Unknown operator "${operator}".` };
  }
  // An operator pointing against the metric's direction would set out to get worse.
  const wantsMore = ['gte', 'gt'].includes(operator);
  const wantsLess = ['lte', 'lt'].includes(operator);
  if (proto.direction === 'higher' && wantsLess) {
    return {
      error: 'TARGET_OPERATOR_INCOMPATIBLE',
      operator,
      direction: proto.direction,
      detail: `${proto.title} improves as the number rises, so a "${OPERATOR_SYMBOLS[operator]}" target would set out to get worse.`,
    };
  }
  if (proto.direction === 'lower' && wantsMore) {
    return {
      error: 'TARGET_OPERATOR_INCOMPATIBLE',
      operator,
      direction: proto.direction,
      detail: `${proto.title} improves as the number falls, so a "${OPERATOR_SYMBOLS[operator]}" target would set out to get worse.`,
    };
  }
  // Exact equality is unreachable on a sub-unit measurement.
  if (operator === 'eq' && proto.precision !== 'integer') {
    return {
      error: 'TARGET_OPERATOR_INCOMPATIBLE',
      operator,
      detail: `${proto.title} is measured to ${proto.precision}, so an exact-equality target could never be reached.`,
    };
  }

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return { error: 'TARGET_VALUE_INVALID', detail: 'A target value must be a number.' };
  if (value <= 0) return { error: 'TARGET_VALUE_INVALID', detail: 'A target value must be greater than zero.' };
  if (value > MAX_TARGET_VALUE)
    return {
      error: 'TARGET_VALUE_OUT_OF_RANGE',
      max: MAX_TARGET_VALUE,
      detail: `A target value must be at most ${MAX_TARGET_VALUE}.`,
    };
  if (proto.precision === 'integer' && !Number.isInteger(value)) {
    return {
      error: 'TARGET_VALUE_INVALID',
      detail: `${proto.title} is counted in whole ${proto.metricUnit}, so the target must be a whole number.`,
    };
  }
  // A fixed-window protocol cannot measure a duration longer than its window.
  if (proto.metricType === 'duration' && proto.protocolWindowMs) {
    const ceiling = proto.protocolWindowMs / 1000;
    if (value > ceiling) {
      return {
        error: 'TARGET_VALUE_OUT_OF_RANGE',
        max: ceiling,
        detail: `${proto.title} measures at most ${ceiling} ${proto.metricUnit}.`,
      };
    }
  }

  return {
    value: {
      sourceType,
      protocolId,
      protocolVersion: proto.version,
      metricType: proto.metricType,
      metricUnit: proto.metricUnit,
      operator,
      value,
      // Frozen so a later protocol revision cannot change what was agreed.
      protocolTitle: proto.title,
      direction: proto.direction,
      precision: proto.precision,
    },
  };
}

export function compare(measured, operator, target) {
  switch (operator) {
    case 'gte':
      return measured >= target;
    case 'gt':
      return measured > target;
    case 'lte':
      return measured <= target;
    case 'lt':
      return measured < target;
    case 'eq':
      return measured === target;
    default:
      return false;
  }
}

/** Best in the protocol's direction; ties go to the earliest completion. */
export function bestValidAttempt({ attempts, sessions, target }) {
  const sessionById = sessions instanceof Map ? sessions : new Map((sessions ?? []).map((s) => [s.id, s]));
  const candidates = (attempts ?? []).filter(
    (a) =>
      a.protocolId === target.protocolId &&
      Number(a.protocolVersion) === Number(target.protocolVersion) &&
      isProductionValidCombine(a, sessionById.get(a.boxSessionId) ?? null, PROVIDERS[a.provider]),
  );
  if (!candidates.length) return null;
  const better =
    target.direction === 'lower'
      ? (x, y) => x.measuredValue < y.measuredValue
      : (x, y) => x.measuredValue > y.measuredValue;
  let best = candidates[0];
  for (const a of candidates.slice(1)) {
    if (better(a, best) || (a.measuredValue === best.measuredValue && (a.completedAt ?? 0) < (best.completedAt ?? 0)))
      best = a;
  }
  return best;
}

/**
 * "Not met" and "not measured" are different facts. A target whose supporting
 * result was invalidated returns to `no_current_valid_measurement`.
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
    const sessionById = sessions instanceof Map ? sessions : new Map((sessions ?? []).map((s) => [s.id, s]));
    let reason = 'no_attempts';
    if (forProtocol.length) {
      const sameVersion = forProtocol.filter((a) => Number(a.protocolVersion) === Number(target.protocolVersion));
      if (!sameVersion.length) reason = 'protocol_version_mismatch';
      else if (
        sameVersion.some((a) => {
          const s = sessionById.get(a.boxSessionId) ?? null;
          return (
            s?.verificationState === 'invalidated' &&
            ['combine_verified', 'partially_measured'].includes(a.combineState)
          );
        })
      )
        reason = 'measurement_invalidated';
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
    note: met
      ? 'The stated measurement has been reached. Whether the wider development goal is achieved is a decision for the plan owner or reviewer — one measurement is not the whole objective.'
      : 'The stated measurement has not been reached yet.',
  };
}

const NO_MEASUREMENT_NOTES = Object.freeze({
  no_attempts: 'No Combine attempt has been recorded for this protocol yet.',
  no_production_valid_attempt:
    'There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target.',
  protocol_version_mismatch:
    'Results exist for this protocol, but under a different version of it. Measurements are not compared across protocol versions.',
  measurement_invalidated:
    'The supporting Combine result was invalidated after review, so there is no current valid measurement. The link and its history are kept.',
});

export { NO_MEASUREMENT_NOTES };
