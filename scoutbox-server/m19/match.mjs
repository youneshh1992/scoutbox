/**
 * M19 — the explainable match engine. There is exactly one of these.
 *
 * `matchPlayerToCriteria(facts, criteria)` answers two questions and nothing
 * else:
 *
 *   does this player satisfy every REQUIRED criterion?
 *   which PREFERRED criteria are met?
 *
 * It returns one line per criterion, each with the criterion's id, whether it
 * was met, and the words a person reads. There is no score, no weight, no
 * ordering hint and no summary number — a caller cannot derive one from the
 * output because nothing here is graded.
 *
 * M18's `playerMatchesBrief` delegates to this function with every criterion
 * in the required class (see `briefCriteriaToCanonical`), so Nobody Missed and
 * Matching evaluate the same facts through the same code. Adding a second
 * engine would let the two disagree about what a club asked for.
 *
 * Fail closed, always: a fact that is missing does not satisfy a criterion
 * about it. An unknown age is not "probably fine", and a distance that could
 * not be established is not "probably near".
 */
import { EVIDENCE_REQUIREMENTS, TRUST_BANDS } from '../m18/shared.mjs';
import { MATCH_POLICY_VERSION, criteriaVersion } from './criteria.mjs';

// Built on first use, never at module load: m18/shared.mjs imports this
// module, so TRUST_BANDS may still be initialising while this file evaluates.
let BAND_RANK_MEMO = null;
const bandRank = () => (BAND_RANK_MEMO ??= Object.fromEntries(TRUST_BANDS.map((b, i) => [b, i])));
const LEVEL_RANK = { amateur: 0, semi_pro: 1, pro: 2 };

/**
 * Evaluate one criterion. Returns `{ key, met, text }` where `key` is the
 * legacy-compatible reason key (so M18 consumers see exactly what they always
 * saw) and `text` is the sentence shown to the person.
 *
 * `now` is passed in rather than read, so an explanation is reproducible.
 */
function evaluate(c, facts, { now = Date.now() } = {}) {
  switch (c.type) {
    case 'position': {
      const has = c.primaryOnly
        ? [facts.position].filter(Boolean)
        : [facts.position, ...(facts.secondaryPositions ?? [])].filter(Boolean);
      const hit = has.filter((p) => c.values.includes(p));
      return hit.length
        ? { key: 'position', met: true, text: `Matches position criteria (${hit.join(', ')})` }
        : { key: 'position', met: false, text: 'Does not match the position criteria' };
    }
    case 'age': {
      if (facts.age == null) return { key: 'age', met: false, text: 'Age is not on record' };
      const lo = c.operator === 'between' ? c.values[0] : (c.operator === 'gte' ? c.value : null);
      const hi = c.operator === 'between' ? c.values[1] : (c.operator === 'lte' ? c.value : null);
      if (lo != null && facts.age < lo) return { key: 'age', met: false, text: `Age ${facts.age} is below the criteria` };
      if (hi != null && facts.age > hi) return { key: 'age', met: false, text: `Age ${facts.age} is above the criteria` };
      return { key: 'age', met: true, text: `Matches age criteria (${facts.age})` };
    }
    case 'geography': {
      if (facts.distanceKm == null) return { key: 'location', met: false, text: 'Distance could not be established' };
      if (facts.distanceKm > c.value) return { key: 'location', met: false, text: 'Outside the permitted search area' };
      // Deliberately no number: explaining a match must not become a way to
      // learn where a player (often a child) lives. Where the organisation is
      // already authorised to see distance, the card shows it separately.
      return { key: 'location', met: true, text: 'Within the club’s permitted search area' };
    }
    case 'level': {
      if (c.operator === 'in') {
        if (!facts.level) return { key: 'level', met: false, text: 'Level is not on record' };
        return c.values.includes(facts.level)
          ? { key: 'level', met: true, text: 'Within the level criteria' }
          : { key: 'level', met: false, text: 'Plays at a level outside the criteria' };
      }
      // `lte`: M18 semantics preserved exactly — only a pro player against a
      // semi-pro ceiling fails, and an unknown level does not block.
      if (c.value === 'semi_pro' && facts.level === 'pro') return { key: 'level', met: false, text: 'Plays at a level above the criteria' };
      if (facts.level && LEVEL_RANK[facts.level] > LEVEL_RANK[c.value]) return { key: 'level', met: false, text: 'Plays at a level above the criteria' };
      return { key: 'level', met: true, text: 'Within the level criteria' };
    }
    case 'foot': {
      if (!facts.foot) return { key: 'foot', met: false, text: 'Preferred foot is not on record' };
      // Case-insensitive on purpose. The vocabulary is written "Right" and the
      // stored fact has always been "right"; comparing them literally made the
      // foot criterion unsatisfiable for every real player while still passing
      // every synthetic test, which is the worst shape a bug can take.
      const want = c.values.map((v) => String(v).toLowerCase());
      const have = String(facts.foot).toLowerCase();
      // "Both" satisfies a criterion for either foot.
      return want.includes(have) || have === 'both'
        ? { key: 'foot', met: true, text: `Matches foot criteria (${facts.foot})` }
        : { key: 'foot', met: false, text: 'Does not match the foot criteria' };
    }
    case 'availability': {
      if (!facts.availability) return { key: 'availability', met: false, text: 'Availability is not on record' };
      return facts.availability === c.value
        ? { key: 'availability', met: true, text: 'Matches the availability criteria' }
        : { key: 'availability', met: false, text: 'Does not match the availability criteria' };
    }
    case 'evidence': {
      const label = EVIDENCE_REQUIREMENTS.find((r) => r.key === c.value)?.label ?? c.value;
      return facts.evidenceFlags?.[c.value]
        ? { key: `evidence:${c.value}`, met: true, text: label }
        : { key: `evidence:${c.value}`, met: false, text: `${label} — not on record` };
    }
    case 'evidence_recency': {
      const at = c.evidenceKind === 'any' ? facts.lastEvidenceAt : facts.lastFootageAt;
      const key = `recency:${c.evidenceKind}:${c.value}`;
      // A missing date is not recent. Treating "we do not know when" as "just
      // now" would put stale records in front of a recruiter as fresh ones.
      if (!at) return { key, met: false, text: 'No dated evidence on record' };
      const days = Math.floor((now - at) / 86_400_000);
      return days <= c.value
        ? { key, met: true, text: `Evidence within the last ${c.value} days` }
        : { key, met: false, text: `Most recent evidence is older than ${c.value} days` };
    }
    case 'trust_band': {
      const have = bandRank()[facts.trustBand];
      const need = bandRank()[c.value];
      if (have == null) return { key: 'minTrustBand', met: false, text: 'Evidence confidence is not available' };
      return have >= need
        ? { key: 'minTrustBand', met: true, text: `Evidence confidence meets the criteria (${facts.trustBand})` }
        : { key: 'minTrustBand', met: false, text: `Evidence confidence is below the criteria (${facts.trustBand})` };
    }
    case 'combine_result': {
      return facts.combineProtocols?.includes(c.value)
        ? { key: `combine:${c.value}`, met: true, text: `${c.value} Combine Verified result available` }
        : { key: `combine:${c.value}`, met: false, text: `No ${c.value} Combine Verified result` };
    }
    case 'combine_measurement': {
      const key = `combineValue:${c.protocol}`;
      const v = facts.combineMeasurements?.[c.protocol];
      // Only a production-valid Combine Verified measurement reaches the facts
      // projection, so a simulated result can never satisfy a threshold.
      if (v == null) return { key, met: false, text: `No ${c.protocol} Combine Verified measurement` };
      const met = c.operator === 'gte' ? v >= c.value : v <= c.value;
      return met
        ? { key, met: true, text: `${c.protocol} ${v} meets the club’s threshold (${c.operator === 'gte' ? '≥' : '≤'} ${c.value})` }
        : { key, met: false, text: `${c.protocol} ${v} does not meet the club’s threshold (${c.operator === 'gte' ? '≥' : '≤'} ${c.value})` };
    }
    default:
      // Unreachable through validateCriteria; if it is ever reached, fail
      // closed rather than treat an unknown test as satisfied.
      return { key: `unknown:${c.type}`, met: false, text: 'This criterion cannot be evaluated' };
  }
}

/**
 * The whole answer for one player.
 *
 * `matchesRequired` is the only thing that decides membership. `preferredMet`
 * and `preferredTotal` are a count of the club's own criteria — never a score,
 * never normalised, never ordered against another player.
 */
export function matchPlayerToCriteria(facts, criteria = {}, { now = Date.now() } = {}) {
  const required = (criteria.required ?? []).map((c) => ({ criterionId: c.id, type: c.type, ...evaluate(c, facts, { now }) }));
  const preferred = (criteria.preferred ?? []).map((c) => ({ criterionId: c.id, type: c.type, ...evaluate(c, facts, { now }) }));
  return {
    matchesRequired: required.every((r) => r.met),
    required,
    preferred,
    preferredMet: preferred.filter((r) => r.met).length,
    preferredTotal: preferred.length,
    policyVersion: MATCH_POLICY_VERSION,
    criteriaVersion: criteriaVersion(criteria),
    // Said out loud in the payload so no consumer has to guess.
    note: 'Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.',
  };
}

/**
 * Translate an M18 Recruitment Brief's criteria into the canonical vocabulary.
 * Everything a brief carries is REQUIRED — that is what a brief has always
 * meant, and M18's behaviour must not change because M19 exists.
 */
export function briefCriteriaToCanonical(criteria = {}) {
  const required = [];
  const add = (type, operator, body) => {
    const parts = Object.keys(body).sort().map((k) => `${k}=${Array.isArray(body[k]) ? [...body[k]].sort().join('|') : body[k]}`);
    required.push({ id: `${type}:${operator}${parts.length ? `:${parts.join(',')}` : ''}`, type, operator, class: 'required', ...body });
  };
  if (criteria.positions?.length) add('position', 'in', { values: [...criteria.positions], primaryOnly: false });
  if (criteria.minAge != null || criteria.maxAge != null) {
    if (criteria.minAge != null && criteria.maxAge != null) add('age', 'between', { values: [criteria.minAge, criteria.maxAge] });
    else if (criteria.minAge != null) add('age', 'gte', { value: criteria.minAge });
    else add('age', 'lte', { value: criteria.maxAge });
  }
  if (criteria.maxLevel) add('level', 'lte', { value: criteria.maxLevel });
  if (criteria.radiusKm != null) add('geography', 'within_radius', { value: criteria.radiusKm });
  if (criteria.foot) add('foot', 'in', { values: [criteria.foot] });
  if (criteria.availability) add('availability', 'equals', { value: criteria.availability });
  for (const key of criteria.evidenceRequirements ?? []) add('evidence', 'exists', { value: key });
  if (criteria.minTrustBand) add('trust_band', 'gte', { value: criteria.minTrustBand });
  for (const p of criteria.combineProtocols ?? []) add('combine_result', 'exists', { value: p });
  return { required, preferred: [], schemaVersion: 1 };
}

/**
 * M18's contract, computed by the M19 engine. The order of the reasons follows
 * the brief's own order, exactly as before, and each carries the same key,
 * `met` flag and words.
 */
export function matchBrief(facts, briefCriteria = {}, opts = {}) {
  const canonical = briefCriteriaToCanonical(briefCriteria);
  const result = matchPlayerToCriteria(facts, canonical, opts);
  return {
    matched: result.matchesRequired,
    reasons: result.required.map(({ key, met, text }) => ({ key, met, text })),
  };
}
