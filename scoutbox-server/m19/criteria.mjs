/**
 * M19 — the canonical criteria schema.
 *
 * A criterion is a fact test the CLUB wrote. ScoutBox evaluates it and says
 * whether it was met. There is no weighting, no scoring and no hidden rule:
 * everything a match depends on is one of the typed criteria below, and every
 * one of them is shown to the person who wrote it.
 *
 * Two classes, and the distinction is the whole point of M19:
 *
 *   required   decides whether the player is in the match set at all
 *   preferred  adds context; a player still matches when it is not met
 *
 * Preferred criteria are counted ("2 of 3 met") and never converted into a
 * percentage, a rank, a tier or any other overall figure. A count of the
 * club's own criteria is a fact; a score would be a judgement ScoutBox has no
 * business making.
 *
 * Operators live in ONE table (§98). A client submits criteria, never an
 * evaluator: there is no path by which a caller can supply code, a weight or
 * a result.
 */
import {
  POSITIONS, TRUST_BANDS, EVIDENCE_REQUIREMENTS, PROHIBITED_BRIEF_FIELDS,
} from '../m18/shared.mjs';

/** The semantic interpretation rules. Bump when the MEANING of a criterion
 *  changes, even if its shape does not — a stored explanation is only
 *  comparable to a new one at the same policy version. */
export const MATCH_POLICY_VERSION = 1;
/** The shape of a stored criteria set. */
export const CRITERIA_SCHEMA_VERSION = 1;

export const CRITERION_CLASSES = ['required', 'preferred'];

/**
 * Every operator ScoutBox can evaluate, and what it means. Nothing else is
 * accepted; an unknown operator is a refusal, never a silently skipped
 * criterion (§18).
 */
export const OPERATORS = {
  in: { arity: 'list', note: 'the fact is one of the listed values' },
  equals: { arity: 'scalar', note: 'the fact equals the value' },
  between: { arity: 'range', note: 'the fact is within the inclusive range' },
  gte: { arity: 'scalar', note: 'the fact is at least the value' },
  lte: { arity: 'scalar', note: 'the fact is at most the value' },
  within_radius: { arity: 'scalar', note: 'the player is inside the permitted area at this radius' },
  within_days: { arity: 'scalar', note: 'the fact is dated within this many days' },
  exists: { arity: 'key', note: 'the named fact is present and current' },
};
export const OPERATOR_NAMES = Object.freeze(Object.keys(OPERATORS));

const LEVELS = ['amateur', 'semi_pro', 'pro'];
const FEET = ['Left', 'Right', 'Both'];

/**
 * The availability values ScoutBox records today, published in the vocabulary
 * so a club picks one instead of guessing a spelling that would silently match
 * nobody. Deliberately NOT enforced: a deployment may legitimately carry a
 * value this list has not caught up with, and refusing it would be ScoutBox
 * overruling a fact it holds.
 */
export const AVAILABILITY_VALUES = ['available_now', 'end_of_season', 'loan_open', 'overseas_open', 'not_seeking'];

/**
 * The v1 criterion vocabulary. Only facts ScoutBox can evaluate honestly from
 * data it already holds — nothing inferred from video, nothing speculative,
 * and no training-volume proxy for ability (§15).
 */
export const CRITERION_TYPES = {
  position: {
    operators: ['in'],
    label: 'Position',
    validate: (c) => {
      const values = uniqStrings(c.values);
      if (!values.length) return 'CRITERION_VALUES_REQUIRED';
      if (values.length > LIMITS.maxPositions) return 'CRITERION_TOO_MANY_VALUES';
      if (values.some((v) => !POSITIONS.includes(v))) return 'CRITERION_VALUE_UNKNOWN';
      return null;
    },
    normalise: (c) => ({ values: uniqStrings(c.values), primaryOnly: c.primaryOnly === true }),
  },
  age: {
    operators: ['between', 'gte', 'lte'],
    label: 'Age',
    validate: (c) => {
      const nums = c.operator === 'between' ? c.values : [c.value];
      if (nums.some((n) => !Number.isInteger(Number(n)) || Number(n) < 5 || Number(n) > 60)) return 'CRITERION_VALUE_OUT_OF_RANGE';
      if (c.operator === 'between') {
        if (!Array.isArray(c.values) || c.values.length !== 2) return 'CRITERION_RANGE_INVALID';
        if (Number(c.values[0]) > Number(c.values[1])) return 'CRITERION_RANGE_INVALID';
      }
      return null;
    },
    normalise: (c) => (c.operator === 'between'
      ? { values: [Number(c.values[0]), Number(c.values[1])] }
      : { value: Number(c.value) }),
  },
  geography: {
    operators: ['within_radius'],
    label: 'Recruitment area',
    validate: (c) => {
      const km = Number(c.value);
      // A negative or absurd radius is a refusal, not a clamp that quietly
      // means something else than the club asked for (abuse 19).
      if (!Number.isFinite(km) || km <= 0 || km > LIMITS.maxRadiusKm) return 'CRITERION_VALUE_OUT_OF_RANGE';
      return null;
    },
    normalise: (c, { orgLevel }) => ({
      // The grassroots ceiling is a platform rule and outranks the club's number.
      value: orgLevel === 'grassroots' ? Math.min(Number(c.value), 50) : Number(c.value),
    }),
  },
  level: {
    operators: ['lte', 'in'],
    label: 'Level',
    validate: (c) => {
      const vals = c.operator === 'in' ? uniqStrings(c.values) : [String(c.value)];
      if (!vals.length) return 'CRITERION_VALUES_REQUIRED';
      if (vals.some((v) => !LEVELS.includes(v))) return 'CRITERION_VALUE_UNKNOWN';
      return null;
    },
    normalise: (c, { orgLevel }) => {
      if (c.operator === 'in') return { values: uniqStrings(c.values).filter((v) => orgLevel !== 'grassroots' || v !== 'pro') };
      return { value: orgLevel === 'grassroots' && c.value === 'pro' ? 'semi_pro' : String(c.value) };
    },
  },
  foot: {
    operators: ['in'],
    label: 'Preferred foot',
    validate: (c) => {
      const values = uniqStrings(c.values);
      if (!values.length) return 'CRITERION_VALUES_REQUIRED';
      if (values.some((v) => !FEET.includes(v))) return 'CRITERION_VALUE_UNKNOWN';
      return null;
    },
    normalise: (c) => ({ values: uniqStrings(c.values) }),
  },
  availability: {
    operators: ['equals'],
    label: 'Availability',
    validate: (c) => (String(c.value ?? '').trim() ? null : 'CRITERION_VALUES_REQUIRED'),
    normalise: (c) => ({ value: String(c.value).trim().slice(0, 40) }),
  },
  evidence: {
    operators: ['exists'],
    label: 'Evidence',
    validate: (c) => (EVIDENCE_REQUIREMENTS.some((r) => r.key === c.value) ? null : 'CRITERION_VALUE_UNKNOWN'),
    normalise: (c) => ({ value: String(c.value) }),
  },
  evidence_recency: {
    operators: ['within_days'],
    label: 'Evidence recency',
    validate: (c) => {
      const d = Number(c.value);
      if (!Number.isInteger(d) || d < 1 || d > LIMITS.maxRecencyDays) return 'CRITERION_VALUE_OUT_OF_RANGE';
      if (c.evidenceKind && !['any', 'footage'].includes(String(c.evidenceKind))) return 'CRITERION_VALUE_UNKNOWN';
      return null;
    },
    normalise: (c) => ({ value: Number(c.value), evidenceKind: c.evidenceKind ? String(c.evidenceKind) : 'footage' }),
  },
  trust_band: {
    operators: ['gte'],
    label: 'Evidence confidence',
    validate: (c) => (TRUST_BANDS.includes(c.value) ? null : 'CRITERION_VALUE_UNKNOWN'),
    normalise: (c) => ({ value: String(c.value) }),
  },
  combine_result: {
    operators: ['exists'],
    label: 'Combine result',
    validate: (c, { protocols }) => {
      if (!String(c.value ?? '').trim()) return 'CRITERION_VALUES_REQUIRED';
      if (protocols && !protocols.includes(String(c.value))) return 'CRITERION_VALUE_UNKNOWN';
      return null;
    },
    normalise: (c) => ({ value: String(c.value) }),
  },
  combine_measurement: {
    operators: ['gte', 'lte'],
    label: 'Combine measurement',
    validate: (c, { protocols }) => {
      if (!String(c.protocol ?? '').trim()) return 'CRITERION_VALUES_REQUIRED';
      if (protocols && !protocols.includes(String(c.protocol))) return 'CRITERION_VALUE_UNKNOWN';
      if (!Number.isFinite(Number(c.value))) return 'CRITERION_VALUE_OUT_OF_RANGE';
      return null;
    },
    normalise: (c) => ({ protocol: String(c.protocol), value: Number(c.value) }),
  },
};
export const CRITERION_TYPE_NAMES = Object.freeze(Object.keys(CRITERION_TYPES));

/** Bounds that stop a pathological criteria set (§101) without constraining a
 *  legitimate club. Extends the M18 table rather than starting a second one. */
export const LIMITS = {
  maxCriteria: 24,
  maxRequired: 16,
  maxPreferred: 16,
  // A literal, not POSITIONS.length: m18/shared.mjs imports the engine, so
  // the vocabulary is still initialising when this module is first evaluated.
  // Membership in POSITIONS is checked at call time, where it is safe.
  maxPositions: 13,
  maxRadiusKm: 20000,
  maxRecencyDays: 3650,
  maxNameLength: 80,
  watchlistsPerOrg: 60,
};

const uniqStrings = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x)))] : []);

/** A criterion type that names a protected characteristic is refused outright,
 *  in whatever shape it arrives (§19). */
export const isProhibitedCriterion = (type) => {
  const k = String(type ?? '').toLowerCase().replace(/[^a-z]+/g, '_');
  return PROHIBITED_BRIEF_FIELDS.some((p) => k === p || k.includes(p));
};

/**
 * Validate and normalise a whole criteria set.
 *
 * Returns `{ ok: true, criteria }` where `criteria` is
 * `{ required: [...], preferred: [...], schemaVersion }` with every criterion
 * carrying a stable id, or `{ ok: false, error, details }`. Nothing is ever
 * silently dropped: an unknown type, operator or value is a refusal.
 */
export function validateCriteria(input = {}, { orgLevel = 'pro', protocols = null } = {}) {
  const details = [];
  const out = { required: [], preferred: [] };

  const raw = [
    ...(Array.isArray(input.required) ? input.required.map((c) => ({ ...c, class: 'required' })) : []),
    ...(Array.isArray(input.preferred) ? input.preferred.map((c) => ({ ...c, class: 'preferred' })) : []),
  ];

  if (raw.length > LIMITS.maxCriteria) {
    return { ok: false, error: 'CRITERIA_TOO_MANY', limit: LIMITS.maxCriteria, message: `A criteria set may hold at most ${LIMITS.maxCriteria} criteria.` };
  }

  // A protected characteristic is refused before anything else, with its own
  // code, so the refusal is unambiguous in an audit.
  const prohibited = raw.map((c) => c.type).filter(isProhibitedCriterion);
  if (prohibited.length) {
    return {
      ok: false, error: 'CRITERION_PROHIBITED', prohibited: [...new Set(prohibited.map(String))],
      message: 'Players can never be matched on a protected characteristic.',
    };
  }

  const seen = new Set();
  for (const [i, c] of raw.entries()) {
    const where = { index: i, class: c.class, type: c.type ?? null };
    const def = CRITERION_TYPES[c.type];
    if (!def) { details.push({ ...where, error: 'CRITERION_TYPE_UNKNOWN' }); continue; }
    if (!OPERATOR_NAMES.includes(c.operator)) { details.push({ ...where, error: 'CRITERION_OPERATOR_UNKNOWN' }); continue; }
    if (!def.operators.includes(c.operator)) { details.push({ ...where, error: 'CRITERION_OPERATOR_NOT_SUPPORTED', supported: def.operators }); continue; }
    const problem = def.validate(c, { orgLevel, protocols });
    if (problem) { details.push({ ...where, error: problem }); continue; }

    const body = def.normalise(c, { orgLevel, protocols });
    const id = criterionId(c.type, c.operator, body);
    // The same test twice is one test — a duplicate would double-count in the
    // preferred coverage and read as two different facts.
    if (seen.has(`${c.class}:${id}`)) continue;
    seen.add(`${c.class}:${id}`);
    out[c.class].push({ id, type: c.type, operator: c.operator, class: c.class, ...body });
  }

  if (details.length) {
    return { ok: false, error: 'CRITERIA_INVALID', details, message: 'These criteria cannot be saved as written.' };
  }
  if (out.required.length > LIMITS.maxRequired || out.preferred.length > LIMITS.maxPreferred) {
    return { ok: false, error: 'CRITERIA_TOO_MANY', message: 'Too many criteria in one class.' };
  }
  return { ok: true, criteria: { ...out, schemaVersion: CRITERIA_SCHEMA_VERSION } };
}

/** A stable id for a criterion: same test, same id, whatever the key order. */
export function criterionId(type, operator, body = {}) {
  const parts = Object.keys(body).sort().map((k) => `${k}=${Array.isArray(body[k]) ? [...body[k]].sort().join('|') : body[k]}`);
  return `${type}:${operator}${parts.length ? `:${parts.join(',')}` : ''}`;
}

/**
 * A deterministic version token for a criteria set. Two sets that test the
 * same things produce the same token, so a watchlist can tell "the criteria
 * changed" from "the criteria were re-saved".
 */
export function criteriaVersion(criteria = {}) {
  const hit = VERSION_MEMO.get(criteria);
  if (hit) return hit;
  const line = (list = []) => list.map((c) => c.id).sort().join(';');
  const v = `cv1:${hash32(`${line(criteria.required)}#${line(criteria.preferred)}`)}`;
  VERSION_MEMO.set(criteria, v);
  return v;
}

/**
 * The version of a criteria SET is a property of the set, and a matching run
 * asks for it once per candidate. The M19 performance probe measured that
 * recomputing it dominated the cost of a match: 3.3 µs of a 5.1 µs
 * eight-criterion evaluation was this hash, run again for every player.
 *
 * A WeakMap keyed on the set itself is safe because a validated criteria set
 * is never mutated in place — validateCriteria builds a fresh object, and the
 * routes replace rather than edit. If that ever stops being true, the memo is
 * wrong and this comment is where to look.
 */
const VERSION_MEMO = new WeakMap();

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** The criteria set in plain language, for a summary line (§64). */
export function describeCriteria(criteria = {}) {
  const one = (c) => {
    switch (c.type) {
      case 'position': return `${c.values.join(' / ')}${c.primaryOnly ? ' (primary)' : ''}`;
      case 'age': return c.operator === 'between' ? `${c.values[0]}–${c.values[1]}` : `age ${c.operator === 'gte' ? '≥' : '≤'} ${c.value}`;
      case 'geography': return `within ${c.value} km`;
      case 'level': return c.operator === 'in' ? c.values.join(' / ') : `up to ${c.value}`;
      case 'foot': return c.values.join(' / ');
      case 'availability': return c.value;
      case 'evidence': return EVIDENCE_REQUIREMENTS.find((r) => r.key === c.value)?.label ?? c.value;
      case 'evidence_recency': return `evidence within ${c.value} days`;
      case 'trust_band': return `${c.value.replace(/_/g, ' ')} or higher`;
      case 'combine_result': return `${c.value} result available`;
      case 'combine_measurement': return `${c.protocol} ${c.operator === 'gte' ? '≥' : '≤'} ${c.value}`;
      default: return c.type;
    }
  };
  return {
    required: (criteria.required ?? []).map(one),
    preferred: (criteria.preferred ?? []).map(one),
  };
}
