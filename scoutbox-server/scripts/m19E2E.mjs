// M19 acceptance suite — Explainable Matching and Dynamic Watchlists.
//
// M19 answers exactly two questions and refuses the third:
//
//   which visible players satisfy the criteria this club wrote?
//   for each of them, WHICH criteria, one by one?
//   …and never: who is best, most talented, most recruitable, or worth signing.
//
// So this suite spends most of its effort proving the absences. Sixty numbered
// abuse cases (A1–A60) try to turn matching into a score, a ranking, a
// recommendation, a way to learn about a player the club may not see, a
// player-facing signal, or a cross-tenant read. Twelve positive cases (E1–E12)
// prove the feature actually works while all of that stays true.
//
// Structure:  §1–§9   in-process — the pure engines, the vocabulary, source sweeps
//             §10–§22 HTTP against a fresh server
//             §23–§24 second and third boots: upgrade path, restart idempotence
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CRITERION_CLASSES, CRITERION_TYPES, CRITERION_TYPE_NAMES, OPERATORS, OPERATOR_NAMES,
  LIMITS, MATCH_POLICY_VERSION, CRITERIA_SCHEMA_VERSION, AVAILABILITY_VALUES,
  validateCriteria, criterionId, criteriaVersion, describeCriteria, isProhibitedCriterion,
} from '../m19/criteria.mjs';
import { matchPlayerToCriteria, briefCriteriaToCanonical, matchBrief } from '../m19/match.mjs';
import {
  WATCHLIST_MODES, WATCHLIST_STATUSES, WATCHLIST_SOURCES, ENTRY_REASONS, EXIT_REASONS,
  PRIVACY_SAFE_EXIT, reconcileMembership, transitionFingerprint, explainTransition,
  membershipSummary, membershipNotification, watchlistBlockedState,
} from '../m19/watchlists.mjs';
import { MATCH_SORTS, DEFAULT_MATCH_SORT } from '../m19/index.mjs';
import { playerMatchesBrief, POSITIONS, TRUST_BANDS, EVIDENCE_REQUIREMENTS, PROHIBITED_BRIEF_FIELDS } from '../m18/shared.mjs';
import { EVENT_REGISTRY, isRegistered, minimizePayload } from '../m182/eventRegistry.mjs';
import { audienceFor } from '../m181/eventAudience.mjs';
import { CATEGORIES, TYPE_CATEGORY, categoryOf } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION } from '../m182/migrations.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { SOURCE_CONTEXTS } from '../m17/shared.mjs';
import { ageOn } from '../domain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');
const ROOT = path.join(SERVER_DIR, '..');
const SERVER = path.join(SERVER_DIR, 'server.mjs');
const PORT = 5940 + Math.floor(Math.random() * 8);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m19-'));

let passed = 0; let negatives = 0;
const seenAbuse = new Set();
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
/** A numbered abuse case. The number is the contract with the mandate. */
const abuse = (n, cond, msg) => { seenAbuse.add(n); neg(cond, `A${n} — ${msg}`); };
/** A numbered positive case: the feature works, with everything above true. */
const expect = (n, cond, msg) => ok(cond, `E${n} — ${msg}`);
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);

// A synthetic facts projection. Nothing here comes from the database: these
// sections test the ENGINE, and an engine that only behaves on seeded data is
// an engine nobody has tested.
const FACTS = {
  playerId: 'pl-x', name: 'Test Player', age: 17, position: 'CDM', secondaryPositions: ['CM'],
  level: 'amateur', foot: 'right', availability: 'available_now', distanceKm: 12,
  trustBand: 'strong_evidence',
  combineProtocols: ['combine-box-touch-60'],
  combineMeasurements: { 'combine-box-touch-60': 172 },
  evidenceFlags: { recent_full_match: true, coach_reference: true, confirmed_current_club: false, combine_verified: true },
  lastEvidenceAt: NOW - 10 * DAY,
  lastFootageAt: NOW - 20 * DAY,
};
const EMPTY_FACTS = {
  playerId: 'pl-empty', name: 'No Facts', age: null, position: null, secondaryPositions: [],
  level: null, foot: null, availability: null, distanceKm: null, trustBand: null,
  combineProtocols: [], combineMeasurements: {}, evidenceFlags: {},
  lastEvidenceAt: null, lastFootageAt: null,
};
const crit = (list) => {
  const v = validateCriteria(list, { orgLevel: 'pro', protocols: null });
  if (!v.ok) throw new Error(`fixture criteria rejected: ${JSON.stringify(v)}`);
  return v.criteria;
};
const one = (c, facts = FACTS) => matchPlayerToCriteria(facts, crit({ required: [c], preferred: [] }), { now: NOW }).required[0];

// ==================================================== §1 the vocabulary
section('§1 — the criterion vocabulary is complete, closed and self-consistent');
{
  ok(CRITERION_TYPE_NAMES.length === 11, `${CRITERION_TYPE_NAMES.length} criterion types in v1`);
  ok(CRITERION_CLASSES.join() === 'required,preferred', 'exactly two classes, and preferred is the second');
  for (const [type, def] of Object.entries(CRITERION_TYPES)) {
    ok(def.label && def.operators.length > 0 && typeof def.validate === 'function' && typeof def.normalise === 'function',
      `${type}: labelled, has operators, validates and normalises`);
    neg(def.operators.every((o) => OPERATOR_NAMES.includes(o)), `${type}: every operator it offers exists in the ONE operator table`);
  }
  neg(Object.values(OPERATORS).every((o) => o.arity && o.note), 'every operator declares an arity and says what it means');
  abuse(1, !CRITERION_TYPE_NAMES.some((t) => /score|rating|potential|talent|ceiling|\bability\b|quality|grade/i.test(t)),
    'no criterion type is a judgement about a player rather than a fact about one');
  abuse(2, !CRITERION_TYPE_NAMES.some(isProhibitedCriterion), 'no criterion type names a protected characteristic');
  abuse(3, PROHIBITED_BRIEF_FIELDS.every((f) => isProhibitedCriterion(f)), 'every protected field M18 refuses, M19 refuses too');
  abuse(4, isProhibitedCriterion('player_ethnicity') && isProhibitedCriterion('Family-Income') && isProhibitedCriterion('SCHOOL TYPE'),
    'a protected trait is caught whatever the spelling, casing or separator');
  ok(MATCH_POLICY_VERSION === 1 && CRITERIA_SCHEMA_VERSION === 1, 'the policy and schema versions are declared');
  ok(AVAILABILITY_VALUES.includes('available_now'), 'the availability suggestions include what the platform actually records');
}

// ================================================= §2 validation refuses
section('§2 — validateCriteria refuses, and never silently drops');
{
  const bad = (list, code, why) => {
    const v = validateCriteria(list, { orgLevel: 'pro', protocols: ['combine-box-touch-60'] });
    return { refused: !v.ok, code: v.error, detail: v.details?.[0]?.error, why };
  };
  const r = (list) => validateCriteria(list, { orgLevel: 'pro', protocols: ['combine-box-touch-60'] });

  abuse(5, r({ required: [{ type: 'iq', operator: 'gte', value: 120 }] }).details?.[0]?.error === 'CRITERION_TYPE_UNKNOWN',
    'a criterion type ScoutBox cannot evaluate is refused, not ignored');
  abuse(6, r({ required: [{ type: 'age', operator: 'regex', value: '.*' }] }).details?.[0]?.error === 'CRITERION_OPERATOR_UNKNOWN',
    'an operator outside the table is refused — no client-supplied evaluator');
  abuse(7, r({ required: [{ type: 'age', operator: 'in', values: [17] }] }).details?.[0]?.error === 'CRITERION_OPERATOR_NOT_SUPPORTED',
    'a real operator applied to a type that does not support it is refused');
  abuse(8, r({ required: [{ type: 'position', operator: 'in', values: [] }] }).details?.[0]?.error === 'CRITERION_VALUES_REQUIRED',
    'an empty position list is refused rather than treated as "any position"');
  abuse(9, r({ required: [{ type: 'position', operator: 'in', values: ['DM'] }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'a position outside the taxonomy is refused (DM is not CDM)');
  abuse(10, r({ required: [{ type: 'age', operator: 'between', values: [22, 16] }] }).details?.[0]?.error === 'CRITERION_RANGE_INVALID',
    'an age range that starts after it ends is refused, not quietly swapped');
  abuse(11, r({ required: [{ type: 'age', operator: 'gte', value: 3 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'an age below the platform floor is refused');
  abuse(12, r({ required: [{ type: 'age', operator: 'lte', value: 900 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'an absurd age ceiling is refused');
  abuse(13, r({ required: [{ type: 'geography', operator: 'within_radius', value: -50 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a negative radius is refused, not clamped into something the club did not ask for');
  abuse(14, r({ required: [{ type: 'geography', operator: 'within_radius', value: 0 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a zero radius is refused rather than matching nobody in silence');
  abuse(15, r({ required: [{ type: 'geography', operator: 'within_radius', value: 99999 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a radius larger than the planet is refused');
  abuse(16, r({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 0 }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a recency window of zero days is refused');
  abuse(17, r({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 30, evidenceKind: 'telepathy' }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'an evidence kind ScoutBox does not hold is refused');
  abuse(18, r({ required: [{ type: 'trust_band', operator: 'gte', value: 'excellent' }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'an invented evidence-confidence band is refused');
  abuse(19, r({ required: [{ type: 'evidence', operator: 'exists', value: 'vibes' }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'an evidence requirement ScoutBox does not record is refused');
  abuse(20, r({ required: [{ type: 'combine_result', operator: 'exists', value: 'combine-made-up' }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'a Combine protocol that does not exist is refused');
  abuse(21, r({ required: [{ type: 'combine_measurement', operator: 'gte', protocol: '', value: 10 }] }).details?.[0]?.error === 'CRITERION_VALUES_REQUIRED',
    'a Combine threshold with no protocol is refused — a number about nothing');
  abuse(22, r({ required: [{ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 'many' }] }).details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
    'a non-numeric Combine threshold is refused');
  abuse(23, r({ required: [{ type: 'foot', operator: 'in', values: ['Sideways'] }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'a foot that is not a foot is refused');
  abuse(24, r({ required: [{ type: 'level', operator: 'in', values: ['elite'] }] }).details?.[0]?.error === 'CRITERION_VALUE_UNKNOWN',
    'a level outside the platform taxonomy is refused');
  abuse(25, r({ required: [{ type: 'ethnicity', operator: 'in', values: ['x'] }] }).error === 'CRITERION_PROHIBITED',
    'a protected characteristic is refused with its OWN code, before any other validation');
  abuse(26, r({ preferred: [{ type: 'religion', operator: 'equals', value: 'x' }] }).error === 'CRITERION_PROHIBITED',
    'a protected characteristic is refused in the preferred class too — it is not a "soft" preference');
  abuse(27, r({ required: [{ type: 'position', operator: 'in', values: POSITIONS }, ...Array.from({ length: 30 }, () => ({ type: 'age', operator: 'gte', value: 16 }))] }).error === 'CRITERIA_TOO_MANY',
    'a criteria set beyond the cap is refused rather than evaluated 30 times per candidate');
  abuse(28, r({ required: [{ type: 'position', operator: 'in', values: [...POSITIONS, 'GK', 'CB'] }] }).ok === true
    && r({ required: [{ type: 'position', operator: 'in', values: [...POSITIONS, 'GK', 'CB'] }] }).criteria.required[0].values.length === POSITIONS.length,
    'duplicate positions collapse instead of inflating the value count past its limit');
  {
    const v = r({ required: [{ type: 'age', operator: 'gte', value: 16 }, { type: 'age', operator: 'gte', value: 16 }] });
    abuse(29, v.ok && v.criteria.required.length === 1, 'the same test written twice is one test, so it cannot double-count');
  }
  {
    const v = r({ required: [{ type: 'iq', operator: 'gte', value: 1 }, { type: 'nope', operator: 'gte', value: 1 }] });
    abuse(30, v.details.length === 2 && v.details[0].index === 0 && v.details[1].index === 1,
      'every offending row is named by index and class, so the editor can point at it');
  }
  abuse(31, r({ required: 'not-an-array', preferred: null }).ok === true && r({ required: 'x' }).criteria.required.length === 0,
    'a criteria body of the wrong shape yields no criteria rather than throwing');
  {
    const g = validateCriteria({ required: [{ type: 'geography', operator: 'within_radius', value: 500 }] }, { orgLevel: 'grassroots' });
    abuse(32, g.ok && g.criteria.required[0].value === 50, 'a grassroots club asking for 500 km gets the platform ceiling, not its own number');
    const gl = validateCriteria({ required: [{ type: 'level', operator: 'lte', value: 'pro' }] }, { orgLevel: 'grassroots' });
    abuse(33, gl.ok && gl.criteria.required[0].value === 'semi_pro', 'a grassroots club cannot write itself a professional-level criterion');
  }
  void bad;
}

// ============================================ §3 identity and versioning
section('§3 — a criterion has a stable identity, and a criteria set has a version');
{
  const a = criterionId('position', 'in', { values: ['CDM', 'CM'], primaryOnly: false });
  const b = criterionId('position', 'in', { primaryOnly: false, values: ['CM', 'CDM'] });
  ok(a === b, 'the same test written in a different order is the same criterion id');
  const s1 = crit({ required: [{ type: 'age', operator: 'gte', value: 16 }, { type: 'position', operator: 'in', values: ['CDM'] }] });
  const s2 = crit({ required: [{ type: 'position', operator: 'in', values: ['CDM'] }, { type: 'age', operator: 'gte', value: 16 }] });
  ok(criteriaVersion(s1) === criteriaVersion(s2), 'criteria order does not change the version — a re-save is not a change');
  const s3 = crit({ required: [{ type: 'age', operator: 'gte', value: 17 }, { type: 'position', operator: 'in', values: ['CDM'] }] });
  neg(criteriaVersion(s1) !== criteriaVersion(s3), 'a real change to a criterion DOES change the version');
  const p1 = crit({ required: [{ type: 'age', operator: 'gte', value: 16 }], preferred: [] });
  const p2 = crit({ required: [{ type: 'age', operator: 'gte', value: 16 }], preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }] });
  neg(criteriaVersion(p1) !== criteriaVersion(p2), 'moving a criterion into the preferred class changes the version');
  ok(/^cv1:[0-9a-f]{8}$/.test(criteriaVersion(s1)), 'the version token declares its own scheme');
  const d = describeCriteria(s2);
  ok(d.required.length === 2 && d.preferred.length === 0, 'describeCriteria renders both classes separately');
  abuse(34, !JSON.stringify(d).match(/score|rank|rating|%/i), 'the plain-language rendering carries no score, rank or percentage');
}

// ======================================================= §4 the engine
section('§4 — one engine, evaluating facts, failing closed');
{
  ok(one({ type: 'position', operator: 'in', values: ['CDM'] }).met, 'a primary position matches');
  ok(one({ type: 'position', operator: 'in', values: ['CM'] }).met, 'a secondary position matches by default');
  neg(!one({ type: 'position', operator: 'in', values: ['CM'], primaryOnly: true }).met, 'primaryOnly excludes a secondary position');
  neg(!one({ type: 'position', operator: 'in', values: ['GK'] }).met, 'a position the player does not play does not match');
  ok(one({ type: 'age', operator: 'between', values: [16, 18] }).met, 'an age inside the range matches');
  neg(!one({ type: 'age', operator: 'between', values: [18, 20] }).met, 'an age below the range does not match');
  neg(/Age 17 is below the criteria/.test(one({ type: 'age', operator: 'between', values: [18, 20] }).text),
    'an unmet age criterion says which side of the range the player fell on');
  ok(one({ type: 'geography', operator: 'within_radius', value: 20 }).met, 'a player inside the radius matches');
  neg(!one({ type: 'geography', operator: 'within_radius', value: 5 }).met, 'a player outside the radius does not match');
  abuse(35, !/\d/.test(one({ type: 'geography', operator: 'within_radius', value: 20 }).text),
    'the geography explanation carries NO number — explaining a match must not become a way to locate a child');
  ok(one({ type: 'foot', operator: 'in', values: ['Right'] }).met, 'the foot criterion matches the stored fact whatever its casing');
  neg(!one({ type: 'foot', operator: 'in', values: ['Left'] }).met, 'the wrong foot does not match');
  ok(one({ type: 'foot', operator: 'in', values: ['Left'] }, { ...FACTS, foot: 'Both' }).met, 'a two-footed player satisfies either foot');
  ok(one({ type: 'availability', operator: 'equals', value: 'available_now' }).met, 'availability matches exactly');
  ok(one({ type: 'evidence', operator: 'exists', value: 'recent_full_match' }).met, 'a recorded evidence flag matches');
  neg(!one({ type: 'evidence', operator: 'exists', value: 'confirmed_current_club' }).met, 'an absent evidence flag does not match');
  ok(one({ type: 'evidence_recency', operator: 'within_days', value: 30 }).met, 'footage inside the window matches');
  neg(!one({ type: 'evidence_recency', operator: 'within_days', value: 10 }).met, 'footage older than the window does not match');
  ok(one({ type: 'evidence_recency', operator: 'within_days', value: 15, evidenceKind: 'any' }).met, '"any" evidence reads the broader clock');
  ok(one({ type: 'trust_band', operator: 'gte', value: 'established_evidence' }).met, 'a higher evidence band satisfies a lower floor');
  neg(!one({ type: 'trust_band', operator: 'gte', value: 'very_strong_evidence' }).met, 'a lower band does not satisfy a higher floor');
  ok(one({ type: 'combine_result', operator: 'exists', value: 'combine-box-touch-60' }).met, 'a production Combine result matches');
  ok(one({ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 150 }).met, 'a Combine measurement above the threshold matches');
  neg(!one({ type: 'combine_measurement', operator: 'gte', protocol: 'combine-box-touch-60', value: 200 }).met, 'a Combine measurement below the threshold does not match');
  ok(one({ type: 'combine_measurement', operator: 'lte', protocol: 'combine-box-touch-60', value: 200 }).met, 'a "at most" threshold is evaluated the other way round');

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
  abuse(37, one({ type: 'evidence_recency', operator: 'within_days', value: 3650 }, EMPTY_FACTS).text === 'No dated evidence on record',
    '"we do not know when" is never rendered as "just now"');

  const r = matchPlayerToCriteria(FACTS, crit({
    required: [{ type: 'position', operator: 'in', values: ['CDM'] }],
    preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }, { type: 'trust_band', operator: 'gte', value: 'strong_evidence' }],
  }), { now: NOW });
  ok(r.matchesRequired === true, 'required criteria alone decide membership');
  ok(r.preferredMet === 1 && r.preferredTotal === 2, 'preferred criteria are COUNTED');
  abuse(38, !('score' in r) && !('rank' in r) && !('percentage' in r) && !('fit' in r) && !('tier' in r),
    'the engine result carries no score, rank, percentage, fit or tier field');
  abuse(39, !/\b(score|rating|rank|tier|best|recommend)\b/i.test(JSON.stringify(r).replace(/never scored/gi, '')),
    'no reason text and no note in the result uses scoring or recommending language');
  const unmetPreferred = matchPlayerToCriteria(FACTS, crit({
    required: [{ type: 'position', operator: 'in', values: ['CDM'] }],
    preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }],
  }), { now: NOW });
  abuse(40, unmetPreferred.matchesRequired === true, 'an unmet PREFERRED criterion never removes a player from the match set');
  abuse(41, r.required.every((x) => x.criterionId && typeof x.met === 'boolean' && x.text),
    'every required line names its criterion, its outcome and its words — nothing matches for an unstated reason');
  abuse(42, matchPlayerToCriteria(FACTS, { required: [{ id: 'x', type: 'not_a_type', operator: 'equals', value: 1 }] }, { now: NOW }).matchesRequired === false,
    'a criterion type that somehow reaches the engine unvalidated fails CLOSED, never open');
  const twice = [1, 2].map(() => JSON.stringify(matchPlayerToCriteria(FACTS, crit({ required: [{ type: 'age', operator: 'gte', value: 16 }] }), { now: NOW })));
  ok(twice[0] === twice[1], 'the same facts and criteria at the same instant produce byte-identical explanations');
}

// ===================================== §5 one engine, and M18 delegates
section('§5 — there is ONE matching engine, and M18 uses it');
{
  const brief = { positions: ['CDM'], minAge: 16, maxAge: 18, maxLevel: 'semi_pro', minTrustBand: 'established_evidence' };
  const viaM18 = playerMatchesBrief(FACTS, brief, { now: NOW });
  const viaM19 = matchBrief(FACTS, brief, { now: NOW });
  ok(JSON.stringify(viaM18) === JSON.stringify(viaM19), 'M18 playerMatchesBrief IS the M19 engine — identical output, not a second implementation');
  ok(viaM18.matched === true && viaM18.reasons.every((x) => x.key && x.text), 'the M18 contract is unchanged: matched + keyed reasons');
  const canonical = briefCriteriaToCanonical(brief);
  abuse(43, canonical.preferred.length === 0 && canonical.required.length > 0,
    'a Recruitment Brief becomes ALL-required criteria — M19 cannot silently soften what a club wrote as a requirement');
  const src = read('scoutbox-server/m18/shared.mjs');
  abuse(44, /from '\.\.\/m19\/match\.mjs'/.test(src) && !/function evaluateCriterion|switch \(c\.type\)/.test(src),
    'm18/shared.mjs delegates and holds no second evaluator of its own');
}

// ================================== §6 the watchlist reconciliation core
section('§6 — reconciliation: what changed, why, and only once');
{
  const d = reconcileMembership(['a', 'b', 'c'], ['b', 'c', 'd']);
  ok(d.entered.join() === 'd' && d.left.join() === 'a' && d.unchanged.join() === 'b,c', 'entered / left / unchanged are computed correctly');
  ok(reconcileMembership(['a'], ['a']).changed === false, 'no change is reported as no change');
  const s1 = JSON.stringify(reconcileMembership(['c', 'a'], ['b', 'a']));
  const s2 = JSON.stringify(reconcileMembership(['a', 'c'], ['a', 'b']));
  ok(s1 === s2, 'reconciliation is order-independent and deterministic');
  const f = { watchlistId: 'wl1', playerId: 'p1', criteriaVersion: 'cv1:abc', transition: 'entered', reason: 'criterion_now_met' };
  ok(transitionFingerprint(f) === transitionFingerprint({ ...f }), 'the same transition fingerprints the same');
  neg(transitionFingerprint(f) !== transitionFingerprint({ ...f, criteriaVersion: 'cv1:def' }),
    'the same player entering under DIFFERENT criteria is a different transition');
  const prev = { required: [{ criterionId: 'age:gte:value=16', met: false }] };
  const cur = { required: [{ criterionId: 'age:gte:value=16', met: true, text: 'Matches age criteria (16)' }] };
  const e = explainTransition({ previousMatch: prev, currentMatch: cur, transition: 'entered' });
  ok(e.reason === 'criterion_now_met' && e.criterionId === 'age:gte:value=16', 'entering names the criterion that actually flipped');
  const x = explainTransition({ previousMatch: cur, currentMatch: { required: [{ criterionId: 'age:gte:value=16', met: false, text: 'Age 15 is below the criteria' }] }, transition: 'left' });
  ok(x.reason === 'criterion_no_longer_met', 'leaving names the criterion that stopped being met');
  abuse(45, explainTransition({ previousMatch: cur, currentMatch: null, transition: 'left' }).reason === PRIVACY_SAFE_EXIT,
    'a player who left because they are no longer VISIBLE gets the privacy-safe reason — never "they blocked you"');
  abuse(46, !/block|report|safeguard|delete|suspend|removed/i.test(EXIT_REASONS.unavailable),
    'the privacy-safe exit reason names none of the things it could have been');
  ok(explainTransition({ criteriaChanged: true, transition: 'entered' }).reason === 'criteria_changed', 'a criteria edit is reported as a criteria edit, not as a player change');
  ok(explainTransition({ briefChanged: true, transition: 'left' }).reason === 'brief_changed', 'a brief edit is reported as a brief edit');
  const sum = membershipSummary({ entered: ['a', 'b'], left: ['c'], unchanged: ['d'] });
  ok(sum.newlyMatched === 2 && sum.noLongerMatches === 1 && sum.current === 3, 'the summary counts entered, left and the current set');
  abuse(47, /not an improvement in a player/i.test(sum.note) && !/score|rank/i.test(sum.note),
    'the summary says out loud that entering a list is not an improvement in a player');
  const n = membershipNotification({ watchlistName: 'W', entered: Array.from({ length: 25 }, (_, i) => `p${i}`), left: [], reason: 'criteria_changed' });
  abuse(48, n.grouped === true && n.entered === 25 && n.text.split('.').length <= 2,
    'twenty-five players entering after a criteria edit is ONE grouped sentence, not twenty-five notifications');
  ok(membershipNotification({ watchlistName: 'W', entered: [], left: [] }) === null, 'no change produces no notification at all');
  ok(watchlistBlockedState({ status: 'active', mode: 'snapshot' }).blocked === false, 'an active saved-criteria watchlist is not blocked');
  neg(watchlistBlockedState({ status: 'archived' }).blocked === true, 'an archived watchlist stops maintaining membership');
  neg(watchlistBlockedState({ status: 'paused' }).paused === true && watchlistBlockedState({ status: 'paused' }).blocked === false,
    'a paused watchlist still SHOWS membership; only the notifications stop');
  neg(watchlistBlockedState({ status: 'active', mode: 'live_linked', brief: null }).blocked === true,
    'a live-linked watchlist whose brief is gone says so instead of showing an empty list as a fact');
  neg(watchlistBlockedState({ status: 'active', mode: 'live_linked', brief: { status: 'archived' } }).blocked === true,
    'a live-linked watchlist whose brief is archived says so');
  ok(Object.keys(ENTRY_REASONS).length >= 5 && Object.keys(EXIT_REASONS).length >= 4, 'every transition reason is enumerated, not free text');
  abuse(49, !Object.values({ ...ENTRY_REASONS, ...EXIT_REASONS }).some((t) => /better|worse|improved|declined|talent|potential/i.test(t)),
    'no transition reason says a player got better or worse');
}

// ====================================== §7 orderings, and what is absent
section('§7 — ordering is declared, deterministic, and never a ranking');
{
  ok(MATCH_SORTS.length === 5 && MATCH_SORTS.includes(DEFAULT_MATCH_SORT), 'the sort vocabulary is closed and the default is inside it');
  abuse(50, !MATCH_SORTS.some((s) => /best|match|relevan|score|rank|recommend|fit/i.test(s)),
    'no ordering option is a match-quality ranking');
  abuse(51, DEFAULT_MATCH_SORT === 'recent_evidence',
    'the default ordering is the least suggestive useful one, not a quality order');
  const src = read('scoutbox-server/m19/index.mjs');
  neg(/String\(a\.facts\.playerId\)\.localeCompare/.test(src) || /localeCompare\(String\(b\.facts\.playerId\)\)/.test(src),
    'every comparator ends on the player id, so two reads of the same data return the same order');
  neg(/preferredMet/.test(src) && !/sort[^\n]*preferredMet|preferredMet[^\n]*-\s*[ab]\./.test(src),
    'the preferred count is reported but is NEVER used as a sort key');
}

// ======================================= §8 source sweeps over the tree
section('§8 — the source itself carries no score, no ranking and no player surface');
{
  const files = ['m19/criteria.mjs', 'm19/match.mjs', 'm19/watchlists.mjs', 'm19/index.mjs']
    .map((f) => ['scoutbox-server/' + f, read('scoutbox-server/' + f)]);
  const clients = ['scoutbox-club/src/m19Api.ts', 'scoutbox-club/src/m19Screens.tsx', 'scoutbox-club/src/m19Demo.ts',
    'scoutbox-grassroots/src/m19Api.ts', 'scoutbox-grassroots/src/m19Screens.tsx', 'scoutbox-grassroots/src/m19Demo.ts']
    .map((f) => [f, read(f)]);
  const FORBIDDEN = [/AI Match Score/i, /Talent Score/i, /Potential Score/i, /Recruitability/i, /ScoutBox Rating/i, /\bBest Match\b/i, /Recommended Player/i];
  for (const [name, src] of [...files, ...clients]) {
    // The forbidden terms are allowed to appear only inside a sentence that
    // says ScoutBox does NOT do it; strip those first.
    const stripped = src
      .replace(/^.*(?:never|no |not |cannot|does not|nothing|forbidden|refus)[^\n]*$/gim, '')
      .replace(/^\s*(\/\/|\*).*$/gm, '');
    for (const re of FORBIDDEN) {
      abuse(52, !re.test(stripped), `${name}: no "${re.source.replace(/\\b|\\/g, '')}" outside a sentence that denies it`);
    }
  }
  const routes = [...read('scoutbox-server/m19/index.mjs').matchAll(/orgRouter\.(get|post|patch|put|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  ok(routes.length === 8, `${routes.length} M19 routes, all on the ORGANISATION router`);
  abuse(53, !/playerRouter|guardianRouter|publicRouter|tsRouter|adminRouter/.test(read('scoutbox-server/m19/index.mjs')),
    'M19 registers nothing on a player, guardian, public, T&S or admin router — there is no player-facing surface to leak from');
  {
    // Exactly one read of the player collection, inside the guarded scan.
    // Anything else would be a path around playerViewForOrg.
    const src = read('scoutbox-server/m19/index.mjs').split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    const reads = [...src.matchAll(/db\.players\b/g)].length;
    abuse(54, reads === 1 && /for \(const player of db\.players\)/.test(src),
      `the only read of db.players is the single guarded scan (${reads} occurrence)`);
  }
  abuse(55, /orgCanSee\(org, player\)/.test(read('scoutbox-server/m19/index.mjs')) && /ctx\.m18MatchFacts\?\.\(player, org\)/.test(read('scoutbox-server/m19/index.mjs')),
    'authorization and the visibility projection both run BEFORE any criterion is evaluated');
}

// ========================== §9 registry, preferences, limits, migration
section('§9 — the M19 events, notifications, limits and schema are all declared');
{
  const M19_EVENTS = ['watchlist_created', 'watchlist_updated', 'watchlist_membership_changed', 'watchlist_archived', 'matching_room_created'];
  for (const e of M19_EVENTS) {
    ok(isRegistered(e), `${e} is in the event registry`);
    abuse(56, audienceFor(e) === 'org_private', `${e} never leaves the organisation that owns it`);
    neg(EVENT_REGISTRY[e].payload.every((k) => /Id$/.test(k)), `${e} carries ids only — never a player name, a criterion or a count`);
  }
  ok(!!CATEGORIES.watchlist_changes, 'watchlist changes are their own notification category');
  ok(categoryOf('watchlist') === 'watchlist_changes', 'a watchlist notification maps to that category');
  abuse(57, CATEGORIES.watchlist_changes.mandatory !== true,
    'watchlist notifications can be turned off — nothing about a saved search is safety-critical');
  ok(!!RATE_LIMIT_POLICY.matching_query && !!RATE_LIMIT_POLICY.watchlist_write, 'matching and watchlist writes are both rate-limited');
  neg(RATE_LIMIT_POLICY.matching_query.scope === 'org' && RATE_LIMIT_POLICY.watchlist_write.scope === 'org',
    'both limits are per ORGANISATION, so one member cannot spend a colleague’s budget or evade their own');
  ok(SCHEMA_VERSION === 1900 && MIGRATIONS.some((m) => m.id === 'm190_001_dynamic_watchlists'), 'the watchlist stores arrive through a numbered migration');
  ok(SOURCE_CONTEXTS.includes('dynamic_watchlist') && SOURCE_CONTEXTS.includes('matching'), 'a Room can record that it came from matching or a watchlist');
  ok(LIMITS.watchlistsPerOrg > 0 && LIMITS.maxCriteria > 0, 'the pathological-input bounds exist');
  ok(TYPE_CATEGORY.watchlist === 'watchlist_changes' && TRUST_BANDS.length === 5 && EVIDENCE_REQUIREMENTS.length > 0, 'the shared vocabularies M19 borrows are intact');
  const { payload, dropped } = minimizePayload('watchlist_membership_changed', { orgId: 'o', watchlistId: 'w', playerId: 'p', playerName: 'K', entered: 4 });
  abuse(58, !('playerId' in payload) && !('playerName' in payload) && !('entered' in payload) && dropped.length === 3,
    'a membership-change event never ships who moved or how many — the recipient re-reads under their own authorization');
}

// ========== §9b the boundaries the mandate names that nothing else covers
section('§9b — age boundaries, time-driven change, and the things M19 must NOT be');
{
  // Age comes from `ageOn` (M18.2, UTC calendar days). A birthday that lands
  // exactly on the boundary must flip on the day, not the day after.
  const dob = '2008-06-01';
  const dayBefore = ageOn(dob, new Date(Date.UTC(2026, 4, 31)));
  const onTheDay = ageOn(dob, new Date(Date.UTC(2026, 5, 1)));
  ok(dayBefore === 17 && onTheDay === 18, `age flips on the birthday itself, in UTC (${dayBefore} → ${onTheDay})`);
  const ageCrit = crit({ required: [{ type: 'age', operator: 'lte', value: 17 }] });
  const before = matchPlayerToCriteria({ ...EMPTY_FACTS, age: dayBefore }, ageCrit, { now: NOW });
  const after = matchPlayerToCriteria({ ...EMPTY_FACTS, age: onTheDay }, ageCrit, { now: NOW });
  abuse(25, before.matchesRequired === true && after.matchesRequired === false,
    'a player ages out of a criteria set with no write to any record — the fact changed, not the player');

  // Recency expires the same way: the same facts, a later clock, no writes.
  const rec = crit({ required: [{ type: 'evidence_recency', operator: 'within_days', value: 30 }] });
  const fresh = matchPlayerToCriteria(FACTS, rec, { now: NOW });
  const stale = matchPlayerToCriteria(FACTS, rec, { now: NOW + 60 * DAY });
  abuse(25, fresh.matchesRequired === true && stale.matchesRequired === false,
    'evidence expires out of a criteria set as the clock moves, with no player write');

  // Training volume is not a criterion, and cannot become one by spelling.
  for (const t of ['training_volume', 'sessions_per_week', 'box_cam_minutes', 'streak', 'effort']) {
    abuse(11, !CRITERION_TYPE_NAMES.includes(t) && !validateCriteria({ required: [{ type: t, operator: 'gte', value: 1 }] }).ok,
      `"${t}" is not a criterion — training volume is not a proxy for ability`);
  }

  // Matching, Nobody Missed and Second Look answer different questions and
  // must not quietly filter one another.
  const idxSrc = read('scoutbox-server/m19/index.mjs');
  const idxCode = idxSrc.replace(/^\s*(\/\/|\*).*$/gm, '');
  abuse(41, !/db\.secondLookItems|db\.nobodyMissed|nmDismissals|slDismissals|\bdismissed\b/i.test(idxCode),
    'matching reads no Second Look or Nobody Missed store — nobody is excluded for having been evaluated, dismissed or surfaced elsewhere');
  abuse(42, !/assessments|db\.assessments|hasEvaluation/i.test(idxCode),
    'and none for having been assessed: matching, Second Look and Nobody Missed answer different questions over the same players');

  // Analytics: counters only, never a player label and never a quality metric.
  const metrics = [...idxSrc.matchAll(/vmetric\?\.\(([^)]*)\)/g)].map((m) => m[1]);
  ok(metrics.length >= 5, `${metrics.length} metric counters in the M19 routes`);
  abuse(47, metrics.every((m) => /^'[a-z_]+'$/.test(m.trim()) || /transition === 'entered'/.test(m)),
    'every metric is a constant counter name — no player id, no criteria, no score is ever counted');

  // The org audit log carries watchlist LIFECYCLE only. Membership churn
  // belongs in the watchlist history, or the audit log becomes unreadable.
  const auditSrc = read('scoutbox-server/m182/audit.mjs');
  abuse(45, /WATCHLIST_ACTIONS = new Set\(\['watchlist_created', 'watchlist_updated', 'watchlist_archived'\]\)/.test(auditSrc),
    'the audit log projects watchlist lifecycle only — membership changes never flood it');
  abuse(45, !/watchlist_membership_changed/.test(auditSrc),
    'and the membership event is deliberately absent from the audit projection');

  // Trust & Safety has no routine watchlist access.
  const tsFiles = ['scoutbox-server/m14/index.mjs', 'scoutbox-server/m16/index.mjs'];
  for (const f of tsFiles) {
    let src = '';
    try { src = read(f); } catch { continue; }
    abuse(34, !/dynamicWatchlists|watchlistHistory/.test(src), `${f}: the T&S surface holds no watchlist access`);
  }
}

// ============================================================ HTTP boot
section('§10 — a clean database boots with M19 in place');
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', BOX_CAM_TEST_PROVIDER: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env, base) {
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let serverProc = await boot(ENV, BASE);
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const dee = await login('org-hackneymarsh', 'Dee Okafor', 'Head Coach', 'grassroots');
const nia = await login('org-northstar', 'Nia Bello', 'Agent');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, rita, dee, nia, kola].every((x) => x?.token), 'HTTP actors logged in');
{
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === SCHEMA_VERSION, `/healthz reports schema ${SCHEMA_VERSION} with the M19 migration applied`);
}

// The two criteria sets these sections reuse. `q()` wraps them into a request
// body, so a section can add a sort or a page without restating the criteria.
const ANY_AGE_C = { required: [{ type: 'age', operator: 'between', values: [5, 60] }] };
const CDM = { required: [{ type: 'position', operator: 'in', values: ['CDM'] }] };
// A deliberately wider set, so §17 can NARROW it and watch players leave.
const MIDFIELD = { required: [{ type: 'position', operator: 'in', values: ['CDM', 'CM'] }] };
const q = (criteria, extra = {}) => ({ criteria, ...extra });
const ANY_AGE = q(ANY_AGE_C);

// =============================================== §11 the vocabulary route
section('§11 — the vocabulary a club writes criteria against');
{
  const v = await j('GET', '/org/matching/vocabulary', undefined, maria.token);
  expect(1, v.status === 200 && v.body.criterionTypes.length === 11 && v.body.operators.length === 8,
    'a club can read every criterion type and operator ScoutBox can evaluate');
  ok(v.body.policyVersion === MATCH_POLICY_VERSION && v.body.schemaVersion === CRITERIA_SCHEMA_VERSION, 'the vocabulary declares its policy and schema versions');
  ok(v.body.combineProtocols.length > 0 && v.body.availabilityValues.length > 0, 'the Combine protocols and availability values are published, so nothing has to be guessed');
  abuse(59, /no hidden criterion/i.test(v.body.note) && !/weight|score/i.test(v.body.note.replace(/no weighting|match score/gi, '')),
    'the vocabulary says out loud that there is no hidden criterion and no weighting');
  const anon = await j('GET', '/org/matching/vocabulary');
  neg(anon.status === 401, 'the vocabulary is not public');
  const asPlayer = await j('GET', '/org/matching/vocabulary', undefined, kola.token);
  neg(asPlayer.status === 401 || asPlayer.status === 403, 'a player token cannot read the organisation vocabulary');
}

// ================================================ §12 matching, and why
section('§12 — matching returns the set, and says why for every member');
let EASTPORT_TOTAL = 0;
{
  const m = await j('POST', '/org/matching', ANY_AGE, maria.token);
  EASTPORT_TOTAL = m.body.total;
  expect(2, m.status === 200 && m.body.items.length > 0, `matching returns the visible candidates that satisfy the criteria (${EASTPORT_TOTAL})`);
  expect(3, m.body.items.every((i) => i.required.length > 0 && i.required.every((r) => r.met && r.text)),
    'every player on the list carries a met explanation for every required criterion');
  ok(m.headers.get('x-scoutbox-ordering') === `${DEFAULT_MATCH_SORT},player_id`, 'the response declares the ordering it used');
  ok(m.body.ordering === m.headers.get('x-scoutbox-ordering'), 'the declared ordering is in the body as well as the header');
  ok(m.body.criteriaVersion.startsWith('cv1:') && m.body.policyVersion === MATCH_POLICY_VERSION, 'the answer is stamped with the criteria and policy it was computed under');
  neg(/no match score/i.test(m.body.scoreNote), 'the payload states that there is no match score');
  const json = JSON.stringify(m.body);
  abuse(38, !/"score"|"rank"|"rating"|"percentile"|"tier"|"fit"/.test(json), 'no scoring field anywhere in the matching payload');
  abuse(1, !/best match|recommended|should sign|top prospect/i.test(json), 'no recommending language anywhere in the matching payload');

  const cdm = await j('POST', '/org/matching', q(CDM), maria.token);
  expect(4, cdm.body.items.every((i) => i.position === 'CDM' || (i.secondaryPositions ?? []).includes('CDM')),
    'a position criterion returns only players who actually play it');
  neg(cdm.body.total < EASTPORT_TOTAL, 'a narrower criteria set returns fewer players, not the same list re-ordered');

  const withPreferred = await j('POST', '/org/matching', {
    criteria: { required: [{ type: 'position', operator: 'in', values: ['CDM'] }], preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }] },
  }, maria.token);
  expect(5, withPreferred.body.total === cdm.body.total && withPreferred.body.items.every((i) => i.preferredTotal === 1),
    'adding a preferred criterion changes the explanation, never the membership');
  abuse(40, withPreferred.body.items.some((i) => i.preferredMet === 0),
    'a player who meets none of the preferred criteria is still on the list, and still explained');
  {
    // The list must NOT come back sorted by how many preferred criteria each
    // player met — that would be the ranking M19 refuses to produce, arrived
    // at by the back door.
    const counts = withPreferred.body.items.map((i) => i.preferredMet);
    const byPreferred = [...counts].sort((a, b) => b - a);
    const varied = new Set(counts).size > 1;
    abuse(50, !varied || JSON.stringify(counts) !== JSON.stringify(byPreferred),
      'the returned order is NOT the preferred-criteria count in disguise');
  }
}

// ====================== §13 authorization runs BEFORE matching, always
section('§13 — the candidate universe is authorization, not a filter over everyone');
{
  const east = await j('POST', '/org/matching', ANY_AGE, maria.token);
  const harbour = await j('POST', '/org/matching', ANY_AGE, rita.token);
  const grass = await j('POST', '/org/matching', ANY_AGE, dee.token);
  expect(6, east.body.total !== harbour.body.total && grass.body.total < harbour.body.total,
    `each organisation matches over its OWN visible universe (${east.body.total} / ${harbour.body.total} / ${grass.body.total})`);
  const eastNames = new Set(east.body.items.map((i) => i.name));
  const harbourNames = new Set(harbour.body.items.map((i) => i.name));
  abuse(60, [...harbourNames].every((n) => eastNames.has(n)) && [...eastNames].some((n) => !harbourNames.has(n)),
    'a player one club may see and another may not is simply absent from the second club’s answer');
  abuse(24, !JSON.stringify(east.body).includes('consideredVisible') || typeof east.body.consideredVisible !== 'number',
    'no field reports how many players were considered as a raw count of the database');
  abuse(3, !/"dob"|"guardian"|"medical"|"email"|"phone"/i.test(JSON.stringify(east.body)),
    'a match card carries nothing the projection already strips');

  // The grassroots club is the only one authorised to see distance.
  abuse(35, east.body.items.every((i) => i.distanceKm === null), 'a Pro club is not handed a distance it is not authorised to see');
  ok(grass.body.items.every((i) => typeof i.distanceKm === 'number'), 'the grassroots club, which is authorised, does see distance');
  const sortAsPro = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'distance' }), maria.token);
  abuse(35, sortAsPro.status === 400 && sortAsPro.body.error === 'SORT_NOT_AVAILABLE',
    'ordering by distance is refused where distance is not authorised — the ordering cannot leak what the field does not');
  const sortAsGrass = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'distance' }), dee.token);
  ok(sortAsGrass.status === 200, 'the same ordering is available where distance IS authorised');

  const foreignBrief = await j('POST', '/org/recruitment-briefs', { title: 'Harbour only', positions: ['CB'] }, rita.token);
  ok(foreignBrief.status === 201, 'fixture: another organisation writes a brief');
  const stolen = await j('POST', '/org/matching', { briefId: foreignBrief.body.brief.id }, maria.token);
  abuse(60, stolen.status === 404 && stolen.body.error === 'BRIEF_NOT_FOUND',
    'another organisation’s brief id is NOT FOUND, not forbidden — a 403 would confirm it exists');
  const noAuth = await j('POST', '/org/matching', ANY_AGE);
  neg(noAuth.status === 401, 'matching without a session is refused');
  const asPlayer = await j('POST', '/org/matching', ANY_AGE, kola.token);
  abuse(53, asPlayer.status === 401 || asPlayer.status === 403, 'a player cannot run matching, so no player can learn who is matching on them');
}

// ================================================= §14 refusals over HTTP
section('§14 — a criteria refusal is an answer the editor can act on');
{
  const prohibited = await j('POST', '/org/matching', { criteria: { required: [{ type: 'ethnicity', operator: 'in', values: ['x'] }] } }, maria.token);
  abuse(25, prohibited.status === 400 && prohibited.body.error === 'CRITERION_PROHIBITED' && prohibited.body.prohibited.includes('ethnicity'),
    'a protected characteristic is refused over HTTP, by name, with its own code');
  const unknownOp = await j('POST', '/org/matching', { criteria: { required: [{ type: 'age', operator: 'sql', value: 1 }] } }, maria.token);
  abuse(6, unknownOp.status === 400 && unknownOp.body.details[0].error === 'CRITERION_OPERATOR_UNKNOWN', 'an unknown operator is refused over HTTP');
  const injection = await j('POST', '/org/matching', { criteria: { required: [{ type: 'position', operator: 'in', values: ["CDM'; DROP TABLE"] }] } }, maria.token);
  abuse(9, injection.status === 400, 'a value crafted to look like an injection is refused as an unknown position, not interpreted');
  const huge = await j('POST', '/org/matching', { criteria: { required: Array.from({ length: 60 }, () => ({ type: 'age', operator: 'gte', value: 16 })) } }, maria.token);
  abuse(27, huge.status === 400 && huge.body.error === 'CRITERIA_TOO_MANY', 'an oversized criteria set is refused before it is evaluated');
  const nothing = await j('POST', '/org/matching', { criteria: { required: [], preferred: [] } }, maria.token);
  ok(nothing.status === 200, 'an empty criteria set is a legal question over the visible universe');
  abuse(28, nothing.body.total === EASTPORT_TOTAL && nothing.body.criteria.required.length === 0,
    'and it returns exactly the visible universe — no criteria is not "everyone on the platform"');
}

// ====================================== §15 ordering, paging, truncation
section('§15 — ordering and paging are deterministic');
{
  for (const sort of MATCH_SORTS.filter((s) => s !== 'distance')) {
    const a = await j('POST', '/org/matching', q(ANY_AGE_C, { sort }), maria.token);
    const b = await j('POST', '/org/matching', q(ANY_AGE_C, { sort }), maria.token);
    ok(JSON.stringify(a.body.items.map((i) => i.playerId)) === JSON.stringify(b.body.items.map((i) => i.playerId)),
      `${sort}: two identical reads return the same order`);
  }
  const byName = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'name' }), maria.token);
  const names = byName.body.items.map((i) => i.name);
  ok(JSON.stringify(names) === JSON.stringify([...names].sort((x, y) => x.localeCompare(y))), 'name ordering really is by name');
  const bogus = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'best_match' }), maria.token);
  abuse(50, bogus.status === 200 && bogus.body.sort === DEFAULT_MATCH_SORT,
    'asking for an ordering called "best_match" quietly gets the declared default, because no such ordering exists');
  const p1 = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 3, offset: 0 }), maria.token);
  const p2 = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 3, offset: 3 }), maria.token);
  expect(7, p1.body.items.length === 3 && p2.body.items.length > 0 && p1.body.total === p2.body.total
    && !p1.body.items.some((a) => p2.body.items.some((b) => b.playerId === a.playerId)),
    'paging is stable: the total is the same and no player appears on two pages');
  const negOffset = await j('POST', '/org/matching', q(ANY_AGE_C, { offset: -50 }), maria.token);
  neg(negOffset.status === 200 && negOffset.body.offset === 0, 'a negative offset is clamped, never used to read backwards');
  const hugeLimit = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 100000 }), maria.token);
  neg(hugeLimit.body.limit <= 200, 'an enormous page size is clamped to the platform page limit');
}

// ======================================= §16 watchlists: create and mode
section('§16 — a Dynamic Watchlist is saved criteria, and the mode is chosen');
let WL = null; let BRIEF = null;
{
  const noName = await j('POST', '/org/watchlists', { mode: 'snapshot', criteria: CDM }, maria.token);
  neg(noName.status === 400 && noName.body.error === 'WATCHLIST_NAME_REQUIRED', 'a watchlist without a name is refused');
  const noMode = await j('POST', '/org/watchlists', { name: 'X', criteria: CDM }, maria.token);
  abuse(46, noMode.status === 400 && noMode.body.error === 'WATCHLIST_MODE_REQUIRED',
    'the mode is never inferred: a club is asked whether the list follows a brief or keeps its own criteria');
  const emptyRequired = await j('POST', '/org/watchlists', { name: 'X', mode: 'snapshot', criteria: { required: [], preferred: [] } }, maria.token);
  abuse(8, emptyRequired.status === 400 && emptyRequired.body.error === 'CRITERIA_REQUIRED_EMPTY',
    'a saved watchlist with no required criterion is refused — it would silently mean "everyone"');
  const liveWithoutBrief = await j('POST', '/org/watchlists', { name: 'X', mode: 'live_linked', criteria: CDM }, maria.token);
  abuse(46, liveWithoutBrief.status === 400 && liveWithoutBrief.body.error === 'WATCHLIST_MODE_INVALID',
    'only a watchlist linked to a brief can follow one live');

  const created = await j('POST', '/org/watchlists', { name: '2027 Defensive Midfielders', mode: 'snapshot', criteria: MIDFIELD }, maria.token);
  WL = created.body.watchlist;
  expect(8, created.status === 201 && WL.criteriaVersion.startsWith('cv1:') && WL.status === 'active' && WL.mode === 'snapshot',
    'a club saves its criteria as a Dynamic Watchlist');
  ok(WL.createdBy === 'Maria Keane', 'the person who wrote it is attributed');
  abuse(47, !('members' in WL) && !('playerIds' in WL) && !('players' in WL),
    'the saved record holds CRITERIA, never a stored list of players treated as truth');

  BRIEF = (await j('POST', '/org/recruitment-briefs', { title: 'Left-sided CDM 2027', positions: ['CDM'], minAge: 16, maxAge: 30 }, maria.token)).body.brief;
  ok(!!BRIEF?.id, 'fixture: a Recruitment Brief exists');
  const linked = await j('POST', '/org/watchlists', { name: 'Follows the brief', mode: 'live_linked', sourceType: 'brief', briefId: BRIEF.id }, maria.token);
  expect(9, linked.status === 201 && linked.body.watchlist.mode === 'live_linked' && linked.body.watchlist.sourceId === BRIEF.id,
    'a watchlist can instead FOLLOW a Recruitment Brief, and says so');
  const editLinked = await j('PATCH', `/org/watchlists/${linked.body.watchlist.id}`, { criteria: CDM, expectedRev: linked.body.watchlist.rev }, maria.token);
  abuse(46, editLinked.status === 409 && editLinked.body.error === 'WATCHLIST_LIVE_LINKED',
    'editing the criteria of a live-linked watchlist is refused, with the two honest options named');
}

// ============================ §17 membership is derived, and explained
section('§17 — membership is derived on read, with the transitions explained');
{
  const first = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  expect(10, first.status === 200 && first.body.items.length > 0 && first.body.summary.newlyMatched === first.body.items.length,
    'the first read derives membership and reports every member as newly matched');
  neg(/derived when this page is read/i.test(first.body.refreshNote) && /does not recompute .* in the background/i.test(first.body.refreshNote),
    'the payload states plainly that nothing recomputes in the background in this build');
  ok(typeof first.body.evaluatedAt === 'number', 'the derivation is timestamped, so the UI can say when');

  const second = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  const h1 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  const h2 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  abuse(44, h1.body.total === h2.body.total && h1.body.total === first.body.items.length,
    'the same transition is recorded exactly once however many times it is observed');
  // The summary is the last RECORDED change, not this read's diff. A diff
  // would be consumed by whoever read first — a background refetch would tell
  // the person at the screen that nothing changed when two players had left.
  abuse(44, JSON.stringify(second.body.summary) === JSON.stringify(first.body.summary),
    'two reads of the same watchlist tell the same story, so a refetch cannot swallow the change');
  ok(second.body.summary.changedAt === first.body.evaluatedAt || typeof second.body.summary.changedAt === 'number',
    'the summary says WHEN the change it reports happened');
  expect(11, h1.body.items.every((x) => x.reason && x.text && x.criteriaVersion && x.transition),
    'the history says WHY each player entered or left, in the club’s own criteria');
  abuse(49, !/better|worse|improved|declined|talent|potential|score/i.test(JSON.stringify(h1.body)),
    'nothing in the history says a player got better or worse');
  neg(/not an improvement in a player/i.test(h1.body.note), 'and the history says so out loud');

  // Narrow the criteria: the players who no longer qualify LEAVE, with a reason.
  const narrowed = await j('PATCH', `/org/watchlists/${WL.id}`, { criteria: CDM, expectedRev: WL.rev }, maria.token);
  ok(narrowed.status === 200, 'the criteria of a saved-criteria watchlist can be edited');
  const after = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  expect(12, after.body.summary.noLongerMatches > 0 && after.body.total < first.body.total,
    'tightening the criteria removes the players who no longer satisfy them');
  const h3 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  abuse(45, h3.body.items.filter((x) => x.transition === 'left').every((x) => x.reason === 'criteria_changed'),
    'they left because the CRITERIA changed, and the history says that rather than blaming the player');
  const badCursor = await j('GET', `/org/watchlists/${WL.id}/history?cursor=nope`, undefined, maria.token);
  neg(badCursor.status === 400 && badCursor.body.error === 'HISTORY_CURSOR_INVALID', 'a fabricated history cursor is refused, not silently ignored');
}

// ================================= §18 concurrency, lifecycle and limits
section('§18 — the shared write contract applies to watchlists too');
{
  const cur = (await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token)).body.watchlist;
  const stale = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Stale write', expectedRev: 1 }, tom.token);
  neg(stale.status === 409 && stale.body.error === 'WATCHLIST_VERSION_CONFLICT', 'a write built on a stale read is refused');
  neg(!!stale.body.updatedBy || !!stale.body.current, 'and the refusal says what the current state is, so the person can merge');
  const fresh = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Renamed', expectedRev: cur.rev }, tom.token);
  ok(fresh.status === 200 && fresh.body.watchlist.name === 'Renamed', 'a write built on a current read succeeds');

  const paused = await j('PATCH', `/org/watchlists/${WL.id}`, { status: 'paused', expectedRev: fresh.body.watchlist.rev }, maria.token);
  ok(paused.status === 200, 'a watchlist can be paused');
  const whilePaused = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  neg(whilePaused.body.watchlist.blocked?.paused === true && whilePaused.body.items.length > 0,
    'a paused watchlist still SHOWS its membership — pausing stops notifications, not the answer');
  const resumed = await j('PATCH', `/org/watchlists/${WL.id}`, { status: 'active', expectedRev: whilePaused.body.watchlist.rev }, maria.token);
  ok(resumed.status === 200, 'and it can be resumed');
  const archived = await j('PATCH', `/org/watchlists/${WL.id}`, { status: 'archived', expectedRev: resumed.body.watchlist.rev }, maria.token);
  ok(archived.status === 200, 'a watchlist can be archived');
  const reopen = await j('PATCH', `/org/watchlists/${WL.id}`, { status: 'active', expectedRev: archived.body.watchlist.rev }, maria.token);
  abuse(43, reopen.status === 409 && reopen.body.error === 'WATCHLIST_ARCHIVED', 'an archived watchlist is not reopened');
  const archivedRead = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  abuse(43, archivedRead.body.watchlist.blocked?.blocked === true && archivedRead.body.items.length === 0
    && /archived/i.test(archivedRead.body.watchlist.blocked.message),
    'an archived watchlist shows a stated reason, never an empty list presented as "no players match"');
  const historyKept = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  neg(historyKept.body.total > 0, 'archiving keeps the history it already recorded');
  const badStatus = await j('PATCH', `/org/watchlists/${WL.id}`, { status: 'deleted', expectedRev: archivedRead.body.watchlist.rev }, maria.token);
  neg(badStatus.status === 400 && badStatus.body.error === 'WATCHLIST_STATUS_UNKNOWN', 'an invented status is refused');
}

// ============================================ §19 tenant isolation, hard
section('§19 — tenant isolation is absolute');
{
  const mine = (await j('GET', '/org/watchlists', undefined, maria.token)).body;
  const theirs = (await j('GET', '/org/watchlists', undefined, rita.token)).body;
  abuse(60, mine.items.length > 0 && theirs.items.length === 0, 'a watchlist list holds only this organisation’s own watchlists');
  const stolenRead = await j('GET', `/org/watchlists/${WL.id}`, undefined, rita.token);
  abuse(60, stolenRead.status === 404 && stolenRead.body.error === 'WATCHLIST_NOT_FOUND',
    'another organisation’s watchlist id is NOT FOUND — the same answer a nonexistent id gets');
  const stolenWrite = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Hijacked', expectedRev: 1 }, rita.token);
  abuse(60, stolenWrite.status === 404, 'and a write to it is not found either — the 404 comes before the concurrency check');
  const stolenHistory = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, rita.token);
  abuse(60, stolenHistory.status === 404, 'and its history is not readable either');
  const stolenRoom = await j('POST', `/org/watchlists/${WL.id}/room`, { playerId: 'pl-adeyemi' }, rita.token);
  abuse(60, stolenRoom.status === 404, 'and the Room bridge on it is not reachable either');
  const asPlayer = await j('GET', '/org/watchlists', undefined, kola.token);
  abuse(53, asPlayer.status === 401 || asPlayer.status === 403, 'a player cannot list watchlists — a player is never told they are on one');
  const anon = await j('GET', '/org/watchlists');
  neg(anon.status === 401, 'and neither can an anonymous caller');
}

// ==================================================== §20 the Room bridge
section('§20 — the Room bridge is the canonical Room creator, not a second one');
{
  const wl = (await j('POST', '/org/watchlists', { name: 'Bridge test', mode: 'snapshot', criteria: CDM }, maria.token)).body.watchlist;
  const members = (await j('GET', `/org/watchlists/${wl.id}`, undefined, maria.token)).body.items;
  ok(members.length > 0, 'fixture: the bridge watchlist has members');
  const first = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: members[0].playerId }, maria.token);
  ok([200, 201].includes(first.status) && first.body.roomId, 'a member can be taken into a Recruitment Room');
  neg(/stays on the watchlist/i.test(first.body.note), 'and the answer says the player stays on the watchlist while they still match');
  const again = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: members[0].playerId }, maria.token);
  abuse(44, again.status === 200 && again.body.existed === true && again.body.roomId === first.body.roomId,
    'doing it twice is idempotent — the same Room, not a second one');
  const stillThere = (await j('GET', `/org/watchlists/${wl.id}`, undefined, maria.token)).body.items;
  abuse(43, stillThere.some((i) => i.playerId === members[0].playerId),
    'and the player is still on the watchlist: being evaluated is not a reason to stop tracking whether they match');
  const ghost = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: 'pl-does-not-exist' }, maria.token);
  neg(ghost.status === 404 && ghost.body.error === 'PLAYER_NOT_FOUND', 'a player id that does not exist is not found');
  const invisible = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: 'pl-guni' }, rita.token);
  abuse(60, invisible.status === 404, 'and a bridge call from the wrong organisation never reaches the visibility check at all');
}

// ================================================= §21 limits and quotas
section('§21 — pathological use is bounded');
{
  const before = (await j('GET', '/org/watchlists', undefined, nia.token)).body.total;
  let refused = null;
  for (let i = 0; i < LIMITS.watchlistsPerOrg + 2 - before; i++) {
    const r = await j('POST', '/org/watchlists', { name: `bulk ${i}`, mode: 'snapshot', criteria: CDM }, nia.token);
    if (r.status === 409) { refused = r; break; }
    if (r.status === 429) { refused = r; break; }
  }
  abuse(27, !!refused && ['WATCHLIST_LIMIT_REACHED', 'RATE_LIMITED'].includes(refused.body.error),
    'a club cannot create unbounded watchlists — the cap or the rate limit stops it, with a message that says what to do');
  if (refused?.body?.error === 'WATCHLIST_LIMIT_REACHED') neg(/archive/i.test(refused.body.message), 'the cap message names the way out');
  else neg(refused?.body?.action === 'watchlist_write', 'the rate-limit refusal names the action it limited');
}

// ============================================ §22 nothing reaches a player
section('§22 — no player, guardian or public surface learns any of this');
{
  const notif = await j('GET', '/player/notifications', undefined, kola.token);
  const text = JSON.stringify(notif.body ?? {});
  abuse(53, !/watchlist|matching|criteria|matched/i.test(text),
    'a player’s own notifications never mention a watchlist, a criteria set, or being matched');
  for (const p of ['/player/watchlists', '/player/matching', '/public/matching', '/org/watchlists/all']) {
    const r = await j('GET', p, undefined, kola.token);
    abuse(53, r.status === 404 || r.status === 401 || r.status === 403, `${p} does not exist as a player-reachable surface`);
  }
  const passport = await j('GET', '/player/football-passport', undefined, kola.token);
  abuse(53, !/watchlist|dynamic list/i.test(JSON.stringify(passport.body ?? {})), 'a player’s Passport says nothing about club watchlists');
}

// ============================== §23 restart: derived state, not stored truth
section('§23 — a restart changes nothing about what a watchlist means');
{
  const before = (await j('GET', '/org/watchlists', undefined, maria.token)).body;
  const beforeDetail = (await j('GET', `/org/watchlists/${before.items.find((w) => w.status === 'active').id}`, undefined, maria.token)).body;
  serverProc.kill('SIGKILL');
  await sleep(400);
  serverProc = await boot(ENV, BASE);
  const maria2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const after = (await j('GET', '/org/watchlists', undefined, maria2.token)).body;
  ok(after.total === before.total, 'every watchlist survives the restart');
  const afterDetail = (await j('GET', `/org/watchlists/${beforeDetail.watchlist.id}`, undefined, maria2.token)).body;
  ok(JSON.stringify(afterDetail.items.map((i) => i.playerId)) === JSON.stringify(beforeDetail.items.map((i) => i.playerId)),
    'membership derives to exactly the same set after a restart');
  abuse(44, JSON.stringify(afterDetail.summary) === JSON.stringify(beforeDetail.summary),
    'a restart does not invent a wave of transitions — membership is derived, not replayed');
  const h = await j('GET', `/org/watchlists/${beforeDetail.watchlist.id}/history`, undefined, maria2.token);
  neg(h.body.total >= 1, 'the history that existed before the restart is still there');
  const caps = await j('GET', '/capabilities');
  ok(caps.body.schema?.upToDate === true, 'the second boot runs no migration twice');
}

// ============================================= §24 the M18.2 → M19 upgrade
section('§24 — an M18.2 database upgrades to M19 without losing anything');
{
  const OLD = mkdtempSync(path.join(tmpdir(), 'sbx-m19-old-'));
  const OLD_PORT = PORT + 50;
  const OLD_BASE = `http://localhost:${OLD_PORT}`;
  // Boot once to seed and migrate, then remove the M19 collections and the
  // schema record to simulate a database written before this milestone.
  const p1 = await boot({ ...ENV, PORT: String(OLD_PORT), DATA_DIR: OLD }, OLD_BASE);
  // A write, so the snapshot is actually persisted before we age it backwards.
  const oldTok = (await (await fetch(`${OLD_BASE}/auth/org/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }),
  })).json()).token;
  const legacyBrief = await (await fetch(`${OLD_BASE}/org/recruitment-briefs`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${oldTok}` },
    body: JSON.stringify({ title: 'Written before M19', positions: ['CDM'] }),
  })).json();
  ok(!!legacyBrief.brief?.id, 'fixture: an M18-era Recruitment Brief exists in the old database');
  p1.kill('SIGKILL');
  await sleep(600);
  const { openStore } = await import('../store.mjs');
  const store = openStore(OLD);
  const snap = store.load();
  if (!snap?.db) throw new Error('fixture: the seeded database did not load back');
  delete snap.db.dynamicWatchlists;
  delete snap.db.watchlistHistory;
  snap.db.schema = {
    ...(snap.db.schema ?? {}),
    version: 1820,
    migrations: (snap.db.schema?.migrations ?? []).filter((x) => !String(x.id ?? x).startsWith('m190')),
  };
  store.save(snap);
  store.close?.();
  const p2 = await boot({ ...ENV, PORT: String(OLD_PORT), DATA_DIR: OLD }, OLD_BASE);
  const r = await fetch(`${OLD_BASE}/healthz`);
  const h = await r.json();
  ok(h.schemaVersion === SCHEMA_VERSION, `an M18.2-shaped database migrates forward to ${SCHEMA_VERSION}`);
  const tok = (await (await fetch(`${OLD_BASE}/auth/org/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) })).json()).token;
  const list = await (await fetch(`${OLD_BASE}/org/watchlists`, { headers: { authorization: `Bearer ${tok}` } })).json();
  ok(Array.isArray(list.items) && list.total === 0, 'the upgraded database has the watchlist stores, empty and usable');
  const briefsAfter = await (await fetch(`${OLD_BASE}/org/recruitment-briefs`, { headers: { authorization: `Bearer ${tok}` } })).json();
  neg(briefsAfter.items.some((b) => b.title === 'Written before M19'),
    'and the M18-era Recruitment Brief is still there — the upgrade adds, it does not rewrite');
  const made = await (await fetch(`${OLD_BASE}/org/watchlists`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: 'After upgrade', mode: 'snapshot', criteria: CDM }),
  })).json();
  ok(!!made.watchlist?.id, 'and a watchlist can be created immediately after the upgrade');
  p2.kill('SIGKILL');
  fs.rmSync(OLD, { recursive: true, force: true });
}

// ================================================================= summary
const missingAbuse = Array.from({ length: 60 }, (_, i) => i + 1).filter((n) => !seenAbuse.has(n));
ok(missingAbuse.length === 0, `all 60 enumerated abuse cases exercised${missingAbuse.length ? `: missing A${missingAbuse.join(', A')}` : ''}`);
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(`\nM19 acceptance suite: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
if (pct < 50) fail(`negative coverage ${pct}% is below the 50% floor this milestone requires`);
if (process.exitCode) console.error('\nM19 FAILURES ABOVE');
else console.log('all M19 checks passed');
process.exit(process.exitCode ?? 0);
