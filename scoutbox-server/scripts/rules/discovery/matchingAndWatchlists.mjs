// The matching engine behind the matching and watchlists battery (e2e/discovery/matchingAndWatchlists.mjs), checked in
// this process: the criterion vocabulary and its validation, criterion identity and versions, the one engine and its
// failing closed, reconciliation, ordering, the declared events, notifications, limits and schema, and the age and
// recency boundaries (§1–§9b). The numbered abuse cases checked here are RULES_ABUSE; the battery checks the rest.
import {
  CRITERION_CLASSES,
  CRITERION_TYPES,
  CRITERION_TYPE_NAMES,
  OPERATORS,
  OPERATOR_NAMES,
  LIMITS,
  MATCH_POLICY_VERSION,
  CRITERIA_SCHEMA_VERSION,
  AVAILABILITY_VALUES,
  validateCriteria,
  criterionId,
  criteriaVersion,
  describeCriteria,
  isProhibitedCriterion,
} from '../../../domains/discovery/matching/criteria.mjs';
import {
  matchPlayerToCriteria,
  briefCriteriaToCanonical,
  matchBrief,
} from '../../../domains/discovery/matching/match.mjs';
import {
  WATCHLIST_MODES,
  WATCHLIST_STATUSES,
  WATCHLIST_SOURCES,
  ENTRY_REASONS,
  EXIT_REASONS,
  PRIVACY_SAFE_EXIT,
  reconcileMembership,
  transitionFingerprint,
  explainTransition,
  membershipSummary,
  membershipNotification,
  watchlistBlockedState,
} from '../../../domains/discovery/matching/watchlists.mjs';
import { MATCH_SORTS, DEFAULT_MATCH_SORT } from '../../../domains/discovery/matching/index.mjs';
import {
  POSITIONS,
  TRUST_BANDS,
  EVIDENCE_REQUIREMENTS,
  PROHIBITED_BRIEF_FIELDS,
} from '../../../domains/discovery/shared.mjs';
import { playerMatchesBrief } from '../../../domains/discovery/matching/match.mjs';
import { EVENT_REGISTRY, isRegistered, minimizePayload } from '../../../domains/platform/eventRegistry.mjs';
import { audienceFor } from '../../../domains/platform/eventAudience.mjs';
import { CATEGORIES, TYPE_CATEGORY, categoryOf } from '../../../domains/platform/notificationPrefs.mjs';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { DISCOVERY_MIGRATION, DISCOVERY_COLLECTIONS } from '../../../repositories/discovery.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { SOURCE_CONTEXTS } from '../../../domains/recruitment/rooms/shared.mjs';
import { ageOn } from '../../../domain.ts';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('discovery/matchingAndWatchlists');
const seenAbuse = new Set();
/** A numbered abuse case, or one check that proves several; the end checks every number in RULES_ABUSE was exercised. */
const abuse = (n, cond, msg) => {
  const ns = [n].flat();
  for (const x of ns) seenAbuse.add(x);
  neg(cond, `${ns.map((x) => `A${x}`).join(' ')} — ${msg}`);
};
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);

// A synthetic facts projection. Nothing here comes from the database: these
// sections test the ENGINE, and an engine that only behaves on seeded data is
// an engine nobody has tested.
const FACTS = {
  playerId: 'pl-x',
  name: 'Test Player',
  age: 17,
  position: 'CDM',
  secondaryPositions: ['CM'],
  level: 'amateur',
  foot: 'right',
  availability: 'available_now',
  distanceKm: 12,
  trustBand: 'strong_evidence',
  combineProtocols: ['combine-box-touch-60'],
  combineMeasurements: { 'combine-box-touch-60': 172 },
  evidenceFlags: {
    recent_full_match: true,
    coach_reference: true,
    confirmed_current_club: false,
    combine_verified: true,
  },
  lastEvidenceAt: NOW - 10 * DAY,
  lastFootageAt: NOW - 20 * DAY,
};
const EMPTY_FACTS = {
  playerId: 'pl-empty',
  name: 'No Facts',
  age: null,
  position: null,
  secondaryPositions: [],
  level: null,
  foot: null,
  availability: null,
  distanceKm: null,
  trustBand: null,
  combineProtocols: [],
  combineMeasurements: {},
  evidenceFlags: {},
  lastEvidenceAt: null,
  lastFootageAt: null,
};
const crit = (list, orgLevel = 'pro') => {
  const v = validateCriteria(list, { orgLevel, protocols: null });
  if (!v.ok) throw new Error(`fixture criteria rejected: ${JSON.stringify(v)}`);
  return v.criteria;
};
// Only a Grassroots club may write a distance criterion.
const one = (c, facts = FACTS) =>
  matchPlayerToCriteria(facts, crit({ required: [c], preferred: [] }, c.type === 'geography' ? 'grassroots' : 'pro'), {
    now: NOW,
  }).required[0];

// ==================================================== §1 the vocabulary
section('§1 — the criterion vocabulary is complete, closed and self-consistent');
{
  ok(CRITERION_TYPE_NAMES.length === 11, `${CRITERION_TYPE_NAMES.length} criterion types in v1`);
  ok(CRITERION_CLASSES.join() === 'required,preferred', 'exactly two classes, and preferred is the second');
  for (const [type, def] of Object.entries(CRITERION_TYPES)) {
    ok(
      def.label &&
        def.operators.length > 0 &&
        typeof def.validate === 'function' &&
        typeof def.normalise === 'function',
      `${type}: labelled, has operators, validates and normalises`,
    );
    neg(
      def.operators.every((o) => OPERATOR_NAMES.includes(o)),
      `${type}: every operator it offers exists in the ONE operator table`,
    );
  }
  neg(
    Object.values(OPERATORS).every((o) => o.arity && o.note),
    'every operator declares an arity and says what it means',
  );
  abuse(
    1,
    !CRITERION_TYPE_NAMES.some((t) => /score|rating|potential|talent|ceiling|\bability\b|quality|grade/i.test(t)),
    'no criterion type is a judgement about a player rather than a fact about one',
  );
  abuse(2, !CRITERION_TYPE_NAMES.some(isProhibitedCriterion), 'no criterion type names a protected characteristic');
  abuse(
    3,
    PROHIBITED_BRIEF_FIELDS.every((f) => isProhibitedCriterion(f)),
    'every protected field a Recruitment Brief refuses, matching refuses too',
  );
  abuse(
    4,
    isProhibitedCriterion('player_ethnicity') &&
      isProhibitedCriterion('Family-Income') &&
      isProhibitedCriterion('SCHOOL TYPE'),
    'a protected trait is caught whatever the spelling, casing or separator',
  );
  ok(MATCH_POLICY_VERSION === 1 && CRITERIA_SCHEMA_VERSION === 1, 'the policy and schema versions are declared');
  ok(
    AVAILABILITY_VALUES.includes('available_now'),
    'the availability suggestions include what the platform actually records',
  );
}

// ================================================= §2 validation refuses
section('§2 — validateCriteria refuses, and never silently drops');
{
  const bad = (list, code, why) => {
    const v = validateCriteria(list, { orgLevel: 'pro', protocols: ['combine-box-touch-60'] });
    return { refused: !v.ok, code: v.error, detail: v.details?.[0]?.error, why };
  };
  const r = (list) => validateCriteria(list, { orgLevel: 'pro', protocols: ['combine-box-touch-60'] });

  abuse(
    5,
    r({ required: [{ type: 'iq', operator: 'gte', value: 120 }] }).details?.[0]?.error === 'CRITERION_TYPE_UNKNOWN',
    'a criterion type ScoutBox cannot evaluate is refused, not ignored',
  );
  abuse(
    6,
    r({ required: [{ type: 'age', operator: 'regex', value: '.*' }] }).details?.[0]?.error ===
      'CRITERION_OPERATOR_UNKNOWN',
    'an operator outside the table is refused — no client-supplied evaluator',
  );
  abuse(
    7,
    r({ required: [{ type: 'age', operator: 'in', values: [17] }] }).details?.[0]?.error ===
      'CRITERION_OPERATOR_NOT_SUPPORTED',
    'a real operator applied to a type that does not support it is refused',
  );
  abuse(
    8,
    r({ required: [{ type: 'position', operator: 'in', values: [] }] }).details?.[0]?.error ===
      'CRITERION_VALUES_REQUIRED',
    'an empty position list is refused rather than treated as "any position"',
  );
  abuse(
    9,
    r({ required: [{ type: 'position', operator: 'in', values: ['DM'] }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'a position outside the taxonomy is refused (DM is not CDM)',
  );
  abuse(
    10,
    r({ required: [{ type: 'age', operator: 'between', values: [22, 16] }] }).details?.[0]?.error ===
      'CRITERION_RANGE_INVALID',
    'an age range that starts after it ends is refused, not quietly swapped',
  );
  abuse(
    11,
    r({ required: [{ type: 'age', operator: 'gte', value: 3 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'an age below the platform floor is refused',
  );
  abuse(
    12,
    r({ required: [{ type: 'age', operator: 'lte', value: 900 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'an absurd age ceiling is refused',
  );
  abuse(
    13,
    r({ required: [{ type: 'geography', operator: 'within_radius', value: -50 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'a negative radius is refused, not clamped into something the club did not ask for',
  );
  abuse(
    14,
    r({ required: [{ type: 'geography', operator: 'within_radius', value: 0 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'a zero radius is refused rather than matching nobody in silence',
  );
  abuse(
    15,
    r({ required: [{ type: 'geography', operator: 'within_radius', value: 99999 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'a radius larger than the planet is refused',
  );
  abuse(
    16,
    r({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 0 }] }).details?.[0]?.error ===
      'CRITERION_VALUE_OUT_OF_RANGE',
    'a recency window of zero days is refused',
  );
  abuse(
    17,
    r({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 30, evidenceKind: 'telepathy' }] })
      .details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'an evidence kind ScoutBox does not hold is refused',
  );
  abuse(
    18,
    r({ required: [{ type: 'trust_band', operator: 'gte', value: 'excellent' }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'an invented evidence-confidence band is refused',
  );
  abuse(
    19,
    r({ required: [{ type: 'evidence', operator: 'exists', value: 'vibes' }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'an evidence requirement ScoutBox does not record is refused',
  );
  abuse(
    20,
    r({ required: [{ type: 'combine_result', operator: 'exists', value: 'combine-made-up' }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'a Combine protocol that does not exist is refused',
  );
  abuse(
    21,
    r({ required: [{ type: 'combine_measurement', operator: 'gte', protocol: '', value: 10 }] }).details?.[0]?.error ===
      'CRITERION_VALUES_REQUIRED',
    'a Combine threshold with no protocol is refused — a number about nothing',
  );
  abuse(
    22,
    r({ required: [{ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 'many' }] })
      .details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a non-numeric Combine threshold is refused',
  );
  abuse(
    23,
    r({ required: [{ type: 'foot', operator: 'in', values: ['Sideways'] }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'a foot that is not a foot is refused',
  );
  abuse(
    24,
    r({ required: [{ type: 'level', operator: 'in', values: ['elite'] }] }).details?.[0]?.error ===
      'CRITERION_VALUE_UNKNOWN',
    'a level outside the platform taxonomy is refused',
  );
  abuse(
    25,
    r({ required: [{ type: 'ethnicity', operator: 'in', values: ['x'] }] }).error === 'CRITERION_PROHIBITED',
    'a protected characteristic is refused with its OWN code, before any other validation',
  );
  abuse(
    26,
    r({ preferred: [{ type: 'religion', operator: 'equals', value: 'x' }] }).error === 'CRITERION_PROHIBITED',
    'a protected characteristic is refused in the preferred class too — it is not a "soft" preference',
  );
  abuse(
    27,
    r({
      required: [
        { type: 'position', operator: 'in', values: POSITIONS },
        ...Array.from({ length: 30 }, () => ({ type: 'age', operator: 'gte', value: 16 })),
      ],
    }).error === 'CRITERIA_TOO_MANY',
    'a criteria set beyond the cap is refused rather than evaluated 30 times per candidate',
  );
  abuse(
    28,
    r({ required: [{ type: 'position', operator: 'in', values: [...POSITIONS, 'GK', 'CB'] }] }).ok === true &&
      r({ required: [{ type: 'position', operator: 'in', values: [...POSITIONS, 'GK', 'CB'] }] }).criteria.required[0]
        .values.length === POSITIONS.length,
    'duplicate positions collapse instead of inflating the value count past its limit',
  );
  {
    const v = r({
      required: [
        { type: 'age', operator: 'gte', value: 16 },
        { type: 'age', operator: 'gte', value: 16 },
      ],
    });
    abuse(
      29,
      v.ok && v.criteria.required.length === 1,
      'the same test written twice is one test, so it cannot double-count',
    );
  }
  {
    const v = r({
      required: [
        { type: 'iq', operator: 'gte', value: 1 },
        { type: 'nope', operator: 'gte', value: 1 },
      ],
    });
    abuse(
      30,
      v.details.length === 2 && v.details[0].index === 0 && v.details[1].index === 1,
      'every offending row is named by index and class, so the editor can point at it',
    );
  }
  abuse(
    31,
    r({ required: 'not-an-array', preferred: null }).ok === true && r({ required: 'x' }).criteria.required.length === 0,
    'a criteria body of the wrong shape yields no criteria rather than throwing',
  );
  {
    const g = validateCriteria(
      { required: [{ type: 'geography', operator: 'within_radius', value: 500 }] },
      { orgLevel: 'grassroots' },
    );
    abuse(
      32,
      g.ok && g.criteria.required[0].value === 50,
      'a grassroots club asking for 500 km gets the platform ceiling, not its own number',
    );
    const gl = validateCriteria(
      { required: [{ type: 'level', operator: 'lte', value: 'pro' }] },
      { orgLevel: 'grassroots' },
    );
    abuse(
      33,
      gl.ok && gl.criteria.required[0].value === 'semi_pro',
      'a grassroots club cannot write itself a professional-level criterion',
    );
  }
  void bad;
}

// ============================================ §3 identity and versioning
section('§3 — a criterion has a stable identity, and a criteria set has a version');
{
  const a = criterionId('position', 'in', { values: ['CDM', 'CM'], primaryOnly: false });
  const b = criterionId('position', 'in', { primaryOnly: false, values: ['CM', 'CDM'] });
  ok(a === b, 'the same test written in a different order is the same criterion id');
  const s1 = crit({
    required: [
      { type: 'age', operator: 'gte', value: 16 },
      { type: 'position', operator: 'in', values: ['CDM'] },
    ],
  });
  const s2 = crit({
    required: [
      { type: 'position', operator: 'in', values: ['CDM'] },
      { type: 'age', operator: 'gte', value: 16 },
    ],
  });
  ok(
    criteriaVersion(s1) === criteriaVersion(s2),
    'criteria order does not change the version — a re-save is not a change',
  );
  const s3 = crit({
    required: [
      { type: 'age', operator: 'gte', value: 17 },
      { type: 'position', operator: 'in', values: ['CDM'] },
    ],
  });
  neg(criteriaVersion(s1) !== criteriaVersion(s3), 'a real change to a criterion DOES change the version');
  const p1 = crit({ required: [{ type: 'age', operator: 'gte', value: 16 }], preferred: [] });
  const p2 = crit({
    required: [{ type: 'age', operator: 'gte', value: 16 }],
    preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }],
  });
  neg(criteriaVersion(p1) !== criteriaVersion(p2), 'moving a criterion into the preferred class changes the version');
  ok(/^cv1:[0-9a-f]{8}$/.test(criteriaVersion(s1)), 'the version token declares its own scheme');
  const d = describeCriteria(s2);
  ok(d.required.length === 2 && d.preferred.length === 0, 'describeCriteria renders both classes separately');
  abuse(
    34,
    !JSON.stringify(d).match(/score|rank|rating|%/i),
    'the plain-language rendering carries no score, rank or percentage',
  );
}

// ======================================================= §4 the engine
section('§4 — one engine, evaluating facts, failing closed');
{
  ok(one({ type: 'position', operator: 'in', values: ['CDM'] }).met, 'a primary position matches');
  ok(one({ type: 'position', operator: 'in', values: ['CM'] }).met, 'a secondary position matches by default');
  neg(
    !one({ type: 'position', operator: 'in', values: ['CM'], primaryOnly: true }).met,
    'primaryOnly excludes a secondary position',
  );
  neg(
    !one({ type: 'position', operator: 'in', values: ['GK'] }).met,
    'a position the player does not play does not match',
  );
  ok(one({ type: 'age', operator: 'between', values: [16, 18] }).met, 'an age inside the range matches');
  neg(!one({ type: 'age', operator: 'between', values: [18, 20] }).met, 'an age below the range does not match');
  neg(
    /Age 17 is below the criteria/.test(one({ type: 'age', operator: 'between', values: [18, 20] }).text),
    'an unmet age criterion says which side of the range the player fell on',
  );
  ok(one({ type: 'geography', operator: 'within_radius', value: 20 }).met, 'a player inside the radius matches');
  neg(
    !one({ type: 'geography', operator: 'within_radius', value: 5 }).met,
    'a player outside the radius does not match',
  );
  abuse(
    35,
    !/\d/.test(one({ type: 'geography', operator: 'within_radius', value: 20 }).text),
    'the geography explanation carries NO number — explaining a match must not become a way to locate a child',
  );
  ok(
    one({ type: 'foot', operator: 'in', values: ['Right'] }).met,
    'the foot criterion matches the stored fact whatever its casing',
  );
  neg(!one({ type: 'foot', operator: 'in', values: ['Left'] }).met, 'the wrong foot does not match');
  ok(
    one({ type: 'foot', operator: 'in', values: ['Left'] }, { ...FACTS, foot: 'Both' }).met,
    'a two-footed player satisfies either foot',
  );
  ok(one({ type: 'availability', operator: 'equals', value: 'available_now' }).met, 'availability matches exactly');
  ok(one({ type: 'evidence', operator: 'exists', value: 'recent_full_match' }).met, 'a recorded evidence flag matches');
  neg(
    !one({ type: 'evidence', operator: 'exists', value: 'confirmed_current_club' }).met,
    'an absent evidence flag does not match',
  );
  ok(one({ type: 'evidence_recency', operator: 'within_days', value: 30 }).met, 'footage inside the window matches');
  neg(
    !one({ type: 'evidence_recency', operator: 'within_days', value: 10 }).met,
    'footage older than the window does not match',
  );
  ok(
    one({ type: 'evidence_recency', operator: 'within_days', value: 15, evidenceKind: 'any' }).met,
    '"any" evidence reads the broader clock',
  );
  ok(
    one({ type: 'trust_band', operator: 'gte', value: 'established_evidence' }).met,
    'a higher evidence band satisfies a lower floor',
  );
  neg(
    !one({ type: 'trust_band', operator: 'gte', value: 'very_strong_evidence' }).met,
    'a lower band does not satisfy a higher floor',
  );
  ok(
    one({ type: 'combine_result', operator: 'exists', value: 'combine-box-touch-60' }).met,
    'a production Combine result matches',
  );
  ok(
    one({ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 150 }).met,
    'a Combine measurement above the threshold matches',
  );
  neg(
    !one({ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 200 }).met,
    'a Combine measurement below the threshold does not match',
  );
  ok(
    one({ type: 'combine_measurement', operator: 'lte', protocol: 'combine-box-touch-60', value: 200 }).met,
    'a "at most" threshold is evaluated the other way round',
  );

  // Fail closed: an absent fact never satisfies a criterion about it.
  const failsClosed = [
    { type: 'position', operator: 'in', values: ['CDM'] },
    { type: 'age', operator: 'gte', value: 16 },
    { type: 'geography', operator: 'within_radius', value: 500 },
    { type: 'level', operator: 'in', values: ['amateur'] },
    { type: 'foot', operator: 'in', values: ['Left'] },
    { type: 'availability', operator: 'equals', value: 'available_now' },
    { type: 'evidence', operator: 'exists', value: 'recent_full_match' },
    { type: 'evidence_recency', operator: 'within_days', value: 3650 },
    { type: 'trust_band', operator: 'gte', value: 'limited_evidence' },
    { type: 'combine_result', operator: 'exists', value: 'combine-box-touch-60' },
    { type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 0 },
  ];
  for (const c of failsClosed) {
    abuse(36, !one(c, EMPTY_FACTS).met, `a player with no ${c.type} fact does not satisfy a ${c.type} criterion`);
  }
  abuse(
    37,
    one({ type: 'evidence_recency', operator: 'within_days', value: 3650 }, EMPTY_FACTS).text ===
      'No dated evidence on record',
    '"we do not know when" is never rendered as "just now"',
  );

  const r = matchPlayerToCriteria(
    FACTS,
    crit({
      required: [{ type: 'position', operator: 'in', values: ['CDM'] }],
      preferred: [
        { type: 'foot', operator: 'in', values: ['Left'] },
        { type: 'trust_band', operator: 'gte', value: 'strong_evidence' },
      ],
    }),
    { now: NOW },
  );
  ok(r.matchesRequired === true, 'required criteria alone decide membership');
  ok(r.preferredMet === 1 && r.preferredTotal === 2, 'preferred criteria are COUNTED');
  abuse(
    38,
    !('score' in r) && !('rank' in r) && !('percentage' in r) && !('fit' in r) && !('tier' in r),
    'the engine result carries no score, rank, percentage, fit or tier field',
  );
  abuse(
    39,
    !/\b(score|rating|rank|tier|best|recommend)\b/i.test(JSON.stringify(r).replace(/never scored/gi, '')),
    'no reason text and no note in the result uses scoring or recommending language',
  );
  const unmetPreferred = matchPlayerToCriteria(
    FACTS,
    crit({
      required: [{ type: 'position', operator: 'in', values: ['CDM'] }],
      preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }],
    }),
    { now: NOW },
  );
  abuse(
    40,
    unmetPreferred.matchesRequired === true,
    'an unmet PREFERRED criterion never removes a player from the match set',
  );
  abuse(
    41,
    r.required.every((x) => x.criterionId && typeof x.met === 'boolean' && x.text),
    'every required line names its criterion, its outcome and its words — nothing matches for an unstated reason',
  );
  abuse(
    42,
    matchPlayerToCriteria(
      FACTS,
      { required: [{ id: 'x', type: 'not_a_type', operator: 'equals', value: 1 }] },
      { now: NOW },
    ).matchesRequired === false,
    'a criterion type that somehow reaches the engine unvalidated fails CLOSED, never open',
  );
  const twice = [1, 2].map(() =>
    JSON.stringify(
      matchPlayerToCriteria(FACTS, crit({ required: [{ type: 'age', operator: 'gte', value: 16 }] }), { now: NOW }),
    ),
  );
  ok(twice[0] === twice[1], 'the same facts and criteria at the same instant produce byte-identical explanations');
}

// ===================================== §5 one engine, and Nobody Missed delegates
section('§5 — there is ONE matching engine, and Nobody Missed uses it');
{
  const brief = {
    positions: ['CDM'],
    minAge: 16,
    maxAge: 18,
    maxLevel: 'semi_pro',
    minTrustBand: 'established_evidence',
  };
  const viaM18 = playerMatchesBrief(FACTS, brief, { now: NOW });
  const viaM19 = matchBrief(FACTS, brief, { now: NOW });
  ok(
    JSON.stringify(viaM18) === JSON.stringify(viaM19),
    "Nobody Missed's playerMatchesBrief IS the matching engine — identical output, not a second implementation",
  );
  ok(
    viaM18.matched === true && viaM18.reasons.every((x) => x.key && x.text),
    'the Nobody Missed contract is unchanged: matched + keyed reasons',
  );
  const canonical = briefCriteriaToCanonical(brief);
  abuse(
    43,
    canonical.preferred.length === 0 && canonical.required.length > 0,
    'a Recruitment Brief becomes ALL-required criteria — matching cannot silently soften what a club wrote as a requirement',
  );
}

// ================================== §6 the watchlist reconciliation core
section('§6 — reconciliation: what changed, why, and only once');
{
  const d = reconcileMembership(['a', 'b', 'c'], ['b', 'c', 'd']);
  ok(
    d.entered.join() === 'd' && d.left.join() === 'a' && d.unchanged.join() === 'b,c',
    'entered / left / unchanged are computed correctly',
  );
  ok(reconcileMembership(['a'], ['a']).changed === false, 'no change is reported as no change');
  const s1 = JSON.stringify(reconcileMembership(['c', 'a'], ['b', 'a']));
  const s2 = JSON.stringify(reconcileMembership(['a', 'c'], ['a', 'b']));
  ok(s1 === s2, 'reconciliation is order-independent and deterministic');
  const f = {
    watchlistId: 'wl1',
    playerId: 'p1',
    criteriaVersion: 'cv1:abc',
    transition: 'entered',
    reason: 'criterion_now_met',
  };
  ok(transitionFingerprint(f) === transitionFingerprint({ ...f }), 'the same transition fingerprints the same');
  neg(
    transitionFingerprint(f) !== transitionFingerprint({ ...f, criteriaVersion: 'cv1:def' }),
    'the same player entering under DIFFERENT criteria is a different transition',
  );
  const prev = { required: [{ criterionId: 'age:gte:value=16', met: false }] };
  const cur = { required: [{ criterionId: 'age:gte:value=16', met: true, text: 'Matches age criteria (16)' }] };
  const e = explainTransition({ previousMatch: prev, currentMatch: cur, transition: 'entered' });
  ok(
    e.reason === 'criterion_now_met' && e.criterionId === 'age:gte:value=16',
    'entering names the criterion that actually flipped',
  );
  const x = explainTransition({
    previousMatch: cur,
    currentMatch: { required: [{ criterionId: 'age:gte:value=16', met: false, text: 'Age 15 is below the criteria' }] },
    transition: 'left',
  });
  ok(x.reason === 'criterion_no_longer_met', 'leaving names the criterion that stopped being met');
  abuse(
    45,
    explainTransition({ previousMatch: cur, currentMatch: null, transition: 'left' }).reason === PRIVACY_SAFE_EXIT,
    'a player who left because they are no longer VISIBLE gets the privacy-safe reason — never "they blocked you"',
  );
  abuse(
    46,
    !/block|report|safeguard|delete|suspend|removed/i.test(EXIT_REASONS.unavailable),
    'the privacy-safe exit reason names none of the things it could have been',
  );
  ok(
    explainTransition({ criteriaChanged: true, transition: 'entered' }).reason === 'criteria_changed',
    'a criteria edit is reported as a criteria edit, not as a player change',
  );
  ok(
    explainTransition({ briefChanged: true, transition: 'left' }).reason === 'brief_changed',
    'a brief edit is reported as a brief edit',
  );
  const sum = membershipSummary({ entered: ['a', 'b'], left: ['c'], unchanged: ['d'] });
  ok(
    sum.newlyMatched === 2 && sum.noLongerMatches === 1 && sum.current === 3,
    'the summary counts entered, left and the current set',
  );
  abuse(
    47,
    /not an improvement in a player/i.test(sum.note) && !/score|rank/i.test(sum.note),
    'the summary says out loud that entering a list is not an improvement in a player',
  );
  const n = membershipNotification({
    watchlistName: 'W',
    entered: Array.from({ length: 25 }, (_, i) => `p${i}`),
    left: [],
    reason: 'criteria_changed',
  });
  abuse(
    48,
    n.grouped === true && n.entered === 25 && n.text.split('.').length <= 2,
    'twenty-five players entering after a criteria edit is ONE grouped sentence, not twenty-five notifications',
  );
  ok(
    membershipNotification({ watchlistName: 'W', entered: [], left: [] }) === null,
    'no change produces no notification at all',
  );
  ok(
    watchlistBlockedState({ status: 'active', mode: 'snapshot' }).blocked === false,
    'an active saved-criteria watchlist is not blocked',
  );
  neg(
    watchlistBlockedState({ status: 'archived' }).blocked === true,
    'an archived watchlist stops maintaining membership',
  );
  neg(
    watchlistBlockedState({ status: 'paused' }).paused === true &&
      watchlistBlockedState({ status: 'paused' }).blocked === false,
    'a paused watchlist still SHOWS membership; only the notifications stop',
  );
  neg(
    watchlistBlockedState({ status: 'active', mode: 'live_linked', brief: null }).blocked === true,
    'a live-linked watchlist whose brief is gone says so instead of showing an empty list as a fact',
  );
  neg(
    watchlistBlockedState({ status: 'active', mode: 'live_linked', brief: { status: 'archived' } }).blocked === true,
    'a live-linked watchlist whose brief is archived says so',
  );
  ok(
    Object.keys(ENTRY_REASONS).length >= 5 && Object.keys(EXIT_REASONS).length >= 4,
    'every transition reason is enumerated, not free text',
  );
  abuse(
    49,
    !Object.values({ ...ENTRY_REASONS, ...EXIT_REASONS }).some((t) =>
      /better|worse|improved|declined|talent|potential/i.test(t),
    ),
    'no transition reason says a player got better or worse',
  );
}

// ====================================== §7 orderings, and what is absent
section('§7 — ordering is declared, deterministic, and never a ranking');
{
  ok(
    MATCH_SORTS.length === 5 && MATCH_SORTS.includes(DEFAULT_MATCH_SORT),
    'the sort vocabulary is closed and the default is inside it',
  );
  abuse(
    50,
    !MATCH_SORTS.some((s) => /best|match|relevan|score|rank|recommend|fit/i.test(s)),
    'no ordering option is a match-quality ranking',
  );
  abuse(
    51,
    DEFAULT_MATCH_SORT === 'recent_evidence',
    'the default ordering is the least suggestive useful one, not a quality order',
  );
}

// ========================== §9 registry, preferences, limits, migration
section('§9 — the matching events, notifications, limits and schema are all declared');
{
  const MATCHING_EVENTS = [
    'watchlist_created',
    'watchlist_updated',
    'watchlist_membership_changed',
    'watchlist_archived',
    'matching_room_created',
  ];
  for (const e of MATCHING_EVENTS) {
    ok(isRegistered(e), `${e} is in the event registry`);
    abuse(56, audienceFor(e) === 'org_private', `${e} never leaves the organisation that owns it`);
    neg(
      EVENT_REGISTRY[e].payload.every((k) => /Id$/.test(k)),
      `${e} carries ids only — never a player name, a criterion or a count`,
    );
  }
  ok(!!CATEGORIES.watchlist_changes, 'watchlist changes are their own notification category');
  ok(categoryOf('watchlist') === 'watchlist_changes', 'a watchlist notification maps to that category');
  abuse(
    57,
    CATEGORIES.watchlist_changes.mandatory !== true,
    'watchlist notifications can be turned off — nothing about a saved search is safety-critical',
  );
  ok(
    !!RATE_LIMIT_POLICY.matching_query && !!RATE_LIMIT_POLICY.watchlist_write,
    'matching and watchlist writes are both rate-limited',
  );
  neg(
    RATE_LIMIT_POLICY.matching_query.scope === 'org' && RATE_LIMIT_POLICY.watchlist_write.scope === 'org',
    'both limits are per ORGANISATION, so one member cannot spend a colleague’s budget or evade their own',
  );
  // The watchlist stores must arrive through a numbered, recorded migration.
  ok(
    DATA_MIGRATIONS.filter((m) => m.id === DISCOVERY_MIGRATION).length === 1 &&
      ['dynamicWatchlists', 'watchlistHistory'].every((c) => DISCOVERY_COLLECTIONS.includes(c)),
    `the watchlist stores arrive through a numbered migration (${DISCOVERY_MIGRATION})`,
  );
  ok(
    SOURCE_CONTEXTS.includes('dynamic_watchlist') && SOURCE_CONTEXTS.includes('matching'),
    'a Room can record that it came from matching or a watchlist',
  );
  ok(LIMITS.watchlistsPerOrg > 0 && LIMITS.maxCriteria > 0, 'the pathological-input bounds exist');
  ok(
    TYPE_CATEGORY.watchlist === 'watchlist_changes' && TRUST_BANDS.length === 5 && EVIDENCE_REQUIREMENTS.length > 0,
    'the shared vocabularies matching borrows are intact',
  );
  const { payload, dropped } = minimizePayload('watchlist_membership_changed', {
    orgId: 'o',
    watchlistId: 'w',
    playerId: 'p',
    playerName: 'K',
    entered: 4,
  });
  abuse(
    58,
    !('playerId' in payload) && !('playerName' in payload) && !('entered' in payload) && dropped.length === 3,
    'a membership-change event never ships who moved or how many — the recipient re-reads under their own authorization',
  );
}

// ========== §9b the boundaries that nothing else covers
section('§9b — age boundaries, time-driven change, and the things matching must NOT be');
{
  // Age comes from `ageOn` (UTC calendar days). A birthday that lands
  // exactly on the boundary must flip on the day, not the day after.
  const dob = '2008-06-01';
  const dayBefore = ageOn(dob, new Date(Date.UTC(2026, 4, 31)));
  const onTheDay = ageOn(dob, new Date(Date.UTC(2026, 5, 1)));
  ok(dayBefore === 17 && onTheDay === 18, `age flips on the birthday itself, in UTC (${dayBefore} → ${onTheDay})`);
  const ageCrit = crit({ required: [{ type: 'age', operator: 'lte', value: 17 }] });
  const before = matchPlayerToCriteria({ ...EMPTY_FACTS, age: dayBefore }, ageCrit, { now: NOW });
  const after = matchPlayerToCriteria({ ...EMPTY_FACTS, age: onTheDay }, ageCrit, { now: NOW });
  abuse(
    25,
    before.matchesRequired === true && after.matchesRequired === false,
    'a player ages out of a criteria set with no write to any record — the fact changed, not the player',
  );

  // Recency expires the same way: the same facts, a later clock, no writes.
  const rec = crit({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 30 }] });
  const fresh = matchPlayerToCriteria(FACTS, rec, { now: NOW });
  const stale = matchPlayerToCriteria(FACTS, rec, { now: NOW + 60 * DAY });
  abuse(
    25,
    fresh.matchesRequired === true && stale.matchesRequired === false,
    'evidence expires out of a criteria set as the clock moves, with no player write',
  );

  // Training volume is not a criterion, and cannot become one by spelling.
  for (const t of ['training_volume', 'sessions_per_week', 'box_cam_minutes', 'streak', 'effort']) {
    abuse(
      11,
      !CRITERION_TYPE_NAMES.includes(t) && !validateCriteria({ required: [{ type: t, operator: 'gte', value: 1 }] }).ok,
      `"${t}" is not a criterion — training volume is not a proxy for ability`,
    );
  }
}

// The abuse cases this suite checks; e2e/discovery/matchingAndWatchlists.mjs lists the same numbers as checked here.
const RULES_ABUSE = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 56, 57, 58,
];
const missing = RULES_ABUSE.filter((n) => !seenAbuse.has(n));
const extra = [...seenAbuse].filter((n) => !RULES_ABUSE.includes(n));
ok(
  missing.length === 0 && extra.length === 0,
  `the abuse cases checked here are exactly RULES_ABUSE${missing.length ? `: missing A${missing.join(', A')}` : ''}${extra.length ? `; unlisted A${extra.join(', A')}` : ''}`,
);
done();
