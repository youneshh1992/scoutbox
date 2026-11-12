/**
 * The match engine: does a player satisfy every required criterion, and which preferred ones are met? Nothing is
 * graded, so no caller can derive a score. Briefs and Nobody Missed use it too, with every criterion required.
 *
 * Fail closed: a missing fact does not satisfy a criterion about it.
 */
import { EVIDENCE_REQUIREMENTS, TRUST_BANDS } from '../shared.mjs';
import { MATCH_POLICY_VERSION, criteriaVersion } from './criteria.mjs';
import { ageOn, haversineKm } from '../../../domain.mjs';
import { bornByForAge } from '../../../repositories/identity.mjs';
import { bandRankExpr } from '../../../repositories/matchFacts.mjs';

// Built on first use: shared.mjs imports this module, so TRUST_BANDS may still be initialising when it evaluates.
let BAND_RANK_MEMO = null;
const bandRank = () => (BAND_RANK_MEMO ??= Object.fromEntries(TRUST_BANDS.map((b, i) => [b, i])));
const LEVEL_RANK = { amateur: 0, semi_pro: 1, pro: 2 };

/** `now` is passed in rather than read, so an explanation is reproducible. */
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
      const lo = c.operator === 'between' ? c.values[0] : c.operator === 'gte' ? c.value : null;
      const hi = c.operator === 'between' ? c.values[1] : c.operator === 'lte' ? c.value : null;
      if (lo != null && facts.age < lo)
        return { key: 'age', met: false, text: `Age ${facts.age} is below the criteria` };
      if (hi != null && facts.age > hi)
        return { key: 'age', met: false, text: `Age ${facts.age} is above the criteria` };
      return { key: 'age', met: true, text: `Matches age criteria (${facts.age})` };
    }
    case 'geography': {
      if (facts.distanceKm == null) return { key: 'location', met: false, text: 'Distance could not be established' };
      if (facts.distanceKm > c.value) return { key: 'location', met: false, text: 'Outside the permitted search area' };
      // No number: explaining a match must not become a way to learn where a player (often a child) lives.
      return { key: 'location', met: true, text: 'Within the club’s permitted search area' };
    }
    case 'level': {
      if (c.operator === 'in') {
        if (!facts.level) return { key: 'level', met: false, text: 'Level is not on record' };
        return c.values.includes(facts.level)
          ? { key: 'level', met: true, text: 'Within the level criteria' }
          : { key: 'level', met: false, text: 'Plays at a level outside the criteria' };
      }
      // An unknown level does not block.
      if (c.value === 'semi_pro' && facts.level === 'pro')
        return { key: 'level', met: false, text: 'Plays at a level above the criteria' };
      if (facts.level && LEVEL_RANK[facts.level] > LEVEL_RANK[c.value])
        return { key: 'level', met: false, text: 'Plays at a level above the criteria' };
      return { key: 'level', met: true, text: 'Within the level criteria' };
    }
    case 'foot': {
      if (!facts.foot) return { key: 'foot', met: false, text: 'Preferred foot is not on record' };
      // Case-insensitive: the vocabulary is written "Right" and the stored fact "right".
      const want = c.values.map((v) => String(v).toLowerCase());
      const have = String(facts.foot).toLowerCase();
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
      // Simulated results never reach the facts projection.
      if (v == null) return { key, met: false, text: `No ${c.protocol} Combine Verified measurement` };
      const met = c.operator === 'gte' ? v >= c.value : v <= c.value;
      return met
        ? {
            key,
            met: true,
            text: `${c.protocol} ${v} meets the club’s threshold (${c.operator === 'gte' ? '≥' : '≤'} ${c.value})`,
          }
        : {
            key,
            met: false,
            text: `${c.protocol} ${v} does not meet the club’s threshold (${c.operator === 'gte' ? '≥' : '≤'} ${c.value})`,
          };
    }
    default:
      // Unreachable through validateCriteria.
      return { key: `unknown:${c.type}`, met: false, text: 'This criterion cannot be evaluated' };
  }
}

/** ageOn's rule in SQL: whole UTC years, one fewer before the birthday. */
export const AGE_SQL = (now) => {
  const d = new Date(now);
  return {
    sql: '(? - CAST(substr(p.birth_date, 1, 4) AS INTEGER) - (? < substr(p.birth_date, 6, 5)))',
    args: [
      d.getUTCFullYear(),
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    ],
  };
};
export const BAND_RANK_SQL = (col = 'f.trust_band') => bandRankExpr(col); // the facts' band index is on this expression
const LEVEL_RANK_SQL = `COALESCE(CASE p.level ${Object.entries(LEVEL_RANK)
  .map(([l, i]) => `WHEN '${l}' THEN ${i}`)
  .join(' ')} END, -1)`;
const json = (vs) => JSON.stringify(vs);
/**
 * The same test as `evaluate`, as an SQL condition over `players p` joined to `player_match_facts f`.
 * scripts/testMatchFacts.mjs runs both over generated facts and requires them to agree.
 */
export function criterionSql(c, { now, org }) {
  switch (c.type) {
    case 'position':
      return c.primaryOnly
        ? { sql: 'f.position IN (SELECT value FROM json_each(?))', args: [json(c.values)] }
        : {
            sql: 'p.id IN (SELECT player_id FROM player_match_facts WHERE position IN (SELECT value FROM json_each(?)) UNION SELECT player_id FROM player_match_fact_positions WHERE code IN (SELECT value FROM json_each(?)))',
            args: [json(c.values), json(c.values)],
          };
    case 'age': {
      // Age ≥ n exactly when the birth day is on or before n years before today (age N starts at 00:00 UTC on the
      // birthday), so no per-row function is called and the index can serve it.
      const lo = c.operator === 'between' ? c.values[0] : c.operator === 'gte' ? c.value : null;
      const hi = c.operator === 'between' ? c.values[1] : c.operator === 'lte' ? c.value : null;
      return {
        sql: `p.birth_date IS NOT NULL${lo != null ? ' AND p.birth_date <= ?' : ''}${hi != null ? ' AND p.birth_date > ?' : ''}`,
        args: [...(lo != null ? [bornByForAge(lo, now)] : []), ...(hi != null ? [bornByForAge(hi + 1, now)] : [])],
      };
    }
    case 'geography':
      // Only a Grassroots club may see distance (views/playerViews.mjs).
      if ((org?.level ?? null) !== 'grassroots' || !org.location) return { sql: '0', args: [] };
      return {
        sql: 'distance_tenths(?, ?, p.lat, p.lng) IS NOT NULL AND distance_tenths(?, ?, p.lat, p.lng) / 10.0 <= ?',
        args: [org.location.lat, org.location.lng, org.location.lat, org.location.lng, c.value],
      };
    case 'level':
      if (c.operator === 'in') return { sql: 'p.level IN (SELECT value FROM json_each(?))', args: [json(c.values)] };
      // An unknown level does not block.
      return { sql: `${LEVEL_RANK_SQL} <= ?`, args: [LEVEL_RANK[c.value] ?? -1] };
    case 'foot':
      return {
        sql: "p.foot IS NOT NULL AND (lower_js(p.foot) IN (SELECT value FROM json_each(?)) OR lower_js(p.foot) = 'both')",
        args: [json(c.values.map((v) => String(v).toLowerCase()))],
      };
    case 'availability':
      return { sql: 'f.availability = ?', args: [c.value] };
    case 'evidence':
      switch (c.value) {
        case 'recent_full_match':
          return { sql: 'f.last_footage_at > ?', args: [now - 180 * 86_400_000] };
        case 'coach_reference':
          return { sql: 'f.coach_reference = 1', args: [] };
        case 'confirmed_current_club':
          return { sql: 'f.club_confirmed = 1', args: [] };
        case 'combine_verified':
          return { sql: 'EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id)', args: [] };
        default:
          return { sql: '0', args: [] };
      }
    case 'evidence_recency':
      // floor((now - at) / day) <= days  ⇔  at > now - (days + 1) · day
      return {
        sql: `${c.evidenceKind === 'any' ? 'f.last_evidence_at' : 'f.last_footage_at'} > ?`,
        args: [now - (c.value + 1) * 86_400_000],
      };
    case 'trust_band':
      return {
        sql: `f.trust_band IS NOT NULL AND ${BAND_RANK_SQL()} >= ?`,
        args: [bandRank()[c.value] ?? TRUST_BANDS.length],
      };
    case 'combine_result':
      return {
        sql: 'EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id AND mc.protocol_id = ?)',
        args: [c.value],
      };
    case 'combine_measurement':
      return {
        sql: `EXISTS (SELECT 1 FROM player_match_fact_combine mc WHERE mc.player_id = p.id AND mc.protocol_id = ? AND mc.best_value IS NOT NULL AND mc.best_value ${c.operator === 'gte' ? '>=' : '<='} ?)`,
        args: [c.protocol, c.value],
      };
    default:
      return { sql: '0', args: [] };
  }
}

/** Age and the Grassroots distance are worked out here as the org view does. */
export function factsOfRow(row, children, { org, now }) {
  const age = ageOn(row.birth_date, now);
  const combine = children?.combine ?? {};
  const combineMeasurements = {};
  for (const [protocol, best] of Object.entries(combine)) if (best !== null) combineMeasurements[protocol] = best;
  const located = typeof row.lat === 'number' && typeof row.lng === 'number';
  const distanceKm =
    (org?.level ?? null) === 'grassroots' && org.location && located
      ? Math.round(haversineKm(org.location, { lat: row.lat, lng: row.lng }) * 10) / 10
      : null;
  return {
    playerId: row.id,
    name: row.name,
    age: Number.isFinite(age) ? age : null,
    position: row.f_position ?? null,
    secondaryPositions: children?.secondary ?? [],
    level: row.level ?? null,
    foot: row.foot ?? null,
    availability: row.f_availability ?? null,
    distanceKm,
    trustBand: row.f_trust_band ?? null,
    combineProtocols: Object.keys(combine),
    evidenceFlags: {
      recent_full_match: !!row.f_last_footage_at && row.f_last_footage_at > now - 180 * 86_400_000,
      coach_reference: row.f_coach_reference === 1,
      confirmed_current_club: row.f_club_confirmed === 1,
      combine_verified: Object.keys(combine).length > 0,
    },
    lastEvidenceAt: row.f_last_evidence_at ?? null,
    lastFootageAt: row.f_last_footage_at ?? null,
    combineMeasurements,
  };
}

export function matchPlayerToCriteria(facts, criteria = {}, { now = Date.now() } = {}) {
  const required = (criteria.required ?? []).map((c) => ({
    criterionId: c.id,
    type: c.type,
    ...evaluate(c, facts, { now }),
  }));
  const preferred = (criteria.preferred ?? []).map((c) => ({
    criterionId: c.id,
    type: c.type,
    ...evaluate(c, facts, { now }),
  }));
  return {
    matchesRequired: required.every((r) => r.met),
    required,
    preferred,
    preferredMet: preferred.filter((r) => r.met).length,
    preferredTotal: preferred.length,
    policyVersion: MATCH_POLICY_VERSION,
    criteriaVersion: criteriaVersion(criteria),
    note: 'Criteria the club wrote, evaluated as facts. Preferred criteria are counted, never scored.',
  };
}

/** Everything a brief carries is required. */
export function briefCriteriaToCanonical(criteria = {}) {
  const required = [];
  const add = (type, operator, body) => {
    const parts = Object.keys(body)
      .sort()
      .map((k) => `${k}=${Array.isArray(body[k]) ? [...body[k]].sort().join('|') : body[k]}`);
    required.push({
      id: `${type}:${operator}${parts.length ? `:${parts.join(',')}` : ''}`,
      type,
      operator,
      class: 'required',
      ...body,
    });
  };
  if (criteria.positions?.length) add('position', 'in', { values: [...criteria.positions], primaryOnly: false });
  if (criteria.minAge != null || criteria.maxAge != null) {
    if (criteria.minAge != null && criteria.maxAge != null)
      add('age', 'between', { values: [criteria.minAge, criteria.maxAge] });
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

/** Every criterion a brief carries is required. `facts` is the match projection, not a Passport. */
export const playerMatchesBrief = (facts, criteria = {}, opts = {}) => matchBrief(facts, criteria, opts);

export function matchBrief(facts, briefCriteria = {}, opts = {}) {
  const canonical = briefCriteriaToCanonical(briefCriteria);
  const result = matchPlayerToCriteria(facts, canonical, opts);
  return {
    matched: result.matchesRequired,
    reasons: result.required.map(({ key, met, text }) => ({ key, met, text })),
  };
}
