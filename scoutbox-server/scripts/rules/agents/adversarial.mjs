// The rules behind the agent hardening battery (e2e/agents/adversarial.mjs), checked in this process: the temporal
// rule of a mandate, every non-active state, legacy mirrors, conflict severity, policy versions, the minor threshold
// and its pathway, the transaction contract, strict input validation of dates, the role matrix, the rate-limit
// catalogue, and the declared events and schema.
import {
  agreementGrantsAccess,
  effectiveAgreementStatus,
  agreementTermCoversNow,
  AGREEMENT_STATUSES,
  PERMISSIONS,
  can,
  SCOPES,
  MAX_TERM_MONTHS,
  termMonthsOf,
  DISCLOSURE_KEYS,
  normaliseDisclosure,
} from '../../../domains/agents/core/shared.mjs';
import {
  evaluateConflict,
  CONFLICT_OUTCOMES,
  PERMITTED_WITH_CONSENT,
  mostSevere,
  inputHashOf,
  canonicalJson,
} from '../../../domains/agents/compliance/conflict.mjs';
import {
  POLICY_ACTIONS,
  MINOR_PATHWAY_PRODUCTION_ENABLED,
  isRegulatoryMinor,
  evaluateMinorGate,
  ruleStatusAt,
  selectPolicyVersion,
} from '../../../domains/agents/compliance/policy.mjs';
import {
  TRANSACTION_STATUSES,
  DOCUMENT_TYPES,
  DOCUMENT_VISIBILITY,
  TIMELINE_AUDIENCES,
} from '../../../domains/agents/transactions/transaction.mjs';
import { isAdult, ageOn, parseDob } from '../../../domain.ts';
import { agentClientBasis } from '../../../domains/agents/integration/integration.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('agents/adversarial');

const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
const T0 = Date.UTC(2026, 8, 20);
const DAY = 86_400_000;
const YEAR = 365 * DAY;

section('A/pure — the temporal rule, stated as a rule');
{
  const live = {
    status: 'active',
    confirmedAt: T0 - DAY,
    agentUserId: 'u',
    clientId: 'p',
    startAt: T0 - DAY,
    endAt: T0 + DAY,
  };
  const g = (patch) => agreementGrantsAccess({ ...live, ...patch }, 'u', T0);

  ok(g({}) === true, 'A1 the control: an in-term, confirmed, active mandate naming this agent DOES grant access');
  ok(g({ startAt: T0 }) === true, 'A2 a term beginning exactly now has begun');
  ok(
    g({ startAt: null, endAt: null }) === true,
    'A3 an absent boundary is an OPEN boundary, not a malformed one — an open-ended mandate is contract-legal for an entity (FFAR 12(5))',
  );
  ok(g({ startAt: undefined, endAt: undefined }) === true, 'A3b undefined reads the same as null: absent is absent');
  ok(g({ endAt: T0 + YEAR }) === true, 'A4 a readable future end is in term');

  // The start boundary.
  neg(
    g({ startAt: T0 + YEAR, endAt: T0 + 2 * YEAR }) === false,
    'A5 a mandate whose term BEGINS IN A YEAR grants nothing today',
  );
  neg(g({ startAt: T0 + 1 }) === false, 'A5b and one that begins a millisecond from now has not begun');
  neg(g({ startAt: NaN }) === false, 'A6 a NaN start is a boundary that cannot be read — refuse, never ignore');
  neg(
    g({ startAt: '2026-01-01T00:00:00.000Z' }) === false,
    'A6b an ISO-string start — the shape of an imported row — is unreadable, so refused',
  );
  neg(g({ startAt: Infinity }) === false, 'A6c an infinite start never arrives');

  // The end boundary: a present end that is not a finite number must not fall
  // through the expiry guard into "not expired".
  neg(g({ endAt: T0 }) === false, 'A7 a term ending exactly now is over');
  neg(g({ endAt: T0 - DAY }) === false, 'A7b a readable past end is over');
  neg(
    g({ endAt: '2024-01-01T00:00:00.000Z' }) === false,
    'A8 an ISO-string end that already passed no longer grants access FOR EVER',
  );
  neg(
    g({ endAt: NaN }) === false,
    'A8b NaN is a number for which NaN <= now is false — the exact shape that fell through',
  );
  neg(g({ endAt: String(T0 - DAY) }) === false, 'A8c a numeric STRING end is still not a readable number');
  neg(
    g({ endAt: Infinity }) === false,
    'A8d an infinite end is not an open end: absent means open, present means readable',
  );

  ok(
    agreementTermCoversNow({ startAt: null, endAt: null }, T0) === true,
    'A9 the term rule is exported and assertable on its own, not only through a route',
  );
  neg(agreementTermCoversNow({ startAt: T0 + YEAR }, T0) === false, 'A9b including the future-start case');
  neg(agreementTermCoversNow(null, T0) === false, 'A9c and no agreement at all covers nothing');

  // The status vocabulary is NOT extended: a future-start row still reads as
  // `active` (it is a live agreement) while granting nothing. Status and access
  // are two different questions, and the status contract is frozen.
  ok(
    effectiveAgreementStatus({ ...live, startAt: T0 + YEAR }, T0) === 'active',
    'A10 a not-yet-started mandate still READS as active — no status value is added to a frozen contract',
  );
  ok(
    effectiveAgreementStatus({ ...live, endAt: NaN }, T0) === 'expired',
    'A10b but an unreadable end reads as EXPIRED everywhere, so a projection cannot disagree with the access decision',
  );
  ok(!AGREEMENT_STATUSES.includes('not_started'), 'A10c and no new status was smuggled into AGREEMENT_STATUSES');
}

section('B/pure — every non-active state, and every wrong caller');
{
  const live = {
    status: 'active',
    confirmedAt: T0 - DAY,
    agentUserId: 'u',
    clientId: 'p',
    startAt: T0 - DAY,
    endAt: T0 + DAY,
  };
  const g = (patch) => agreementGrantsAccess({ ...live, ...patch }, 'u', T0);
  for (const st of AGREEMENT_STATUSES.filter((s) => s !== 'active')) {
    neg(g({ status: st }) === false, `B1 status "${st}" grants nothing`);
  }
  neg(
    g({ confirmedAt: null }) === false,
    'B2 an "active" row the client never confirmed grants nothing — the client\'s act is the root of the authority',
  );
  neg(g({ agentUserId: 'someone-else' }) === false, "B3 a colleague's agreement is not this agent's");
  neg(
    agreementGrantsAccess({ ...live, agentUserId: null }, null, T0) === false,
    'B4 a legacy agency-level row (no agent) matches no caller, not even one with no id',
  );
  neg(
    agreementGrantsAccess({ ...live, agentUserId: '' }, '', T0) === false,
    'B4b nor does an empty agent id act as a wildcard',
  );
  neg(agreementGrantsAccess(undefined, 'u', T0) === false, 'B5 no record at all grants nothing');
}

section('C/pure — a legacy mirror is history, not authority');
{
  const mirror = {
    id: 'rep-legacy',
    agentUserId: null,
    clientId: 'p',
    status: 'active',
    confirmedAt: T0 - DAY,
    startAt: T0 - DAY,
    endAt: T0 + YEAR,
    legacy: { fromRepresentationId: 'old-1' },
  };
  neg(agreementGrantsAccess(mirror, 'u', T0) === false, 'C1 a legacy mirror grants no access');
  neg(
    agentClientBasis({ agreements: [mirror], agentUserId: 'u', clientId: 'p', now: T0 }).ok === false,
    'C2 and yields no integration basis, so no surface can be reached through it',
  );
  ok(
    effectiveAgreementStatus(mirror, T0) === 'active',
    'C3 the row may still read as active: the PREDICATE withholds authority rather than the record being rewritten',
  );
}

section('G/pure — conflict severity: a prohibition is never softened');
{
  ok(CONFLICT_OUTCOMES.length === 5, 'G1 five outcomes, no sixth escape hatch');
  for (const a of CONFLICT_OUTCOMES) {
    for (const b of CONFLICT_OUTCOMES) {
      const m = mostSevere(a, b);
      ok(CONFLICT_OUTCOMES.includes(m), `G2 mostSevere(${a}, ${b}) is a declared outcome`);
    }
  }
  neg(
    mostSevere('PROHIBITED_CONFLICT', PERMITTED_WITH_CONSENT) === 'PROHIBITED_CONFLICT',
    'G3 a prohibition is not downgraded to "permitted with consent"',
  );
  neg(mostSevere('PROHIBITED_CONFLICT', 'CLEAR') === 'PROHIBITED_CONFLICT', 'G4 nor to CLEAR');
  neg(
    mostSevere('PROHIBITED_CONFLICT', 'MANUAL_REGULATORY_REVIEW_REQUIRED') === 'PROHIBITED_CONFLICT',
    'G5 nor to manual review — review is the ABSENCE of an answer and cannot soften a definite one',
  );
  neg(
    mostSevere('PROHIBITED_CONFLICT', 'INSUFFICIENT_DATA') === 'PROHIBITED_CONFLICT',
    'G5b nor to insufficient data: a missing fact cannot unmake a known prohibition',
  );
  neg(
    mostSevere('INSUFFICIENT_DATA', 'CLEAR') === 'INSUFFICIENT_DATA',
    'G5c uncertainty is never resolved AS permission',
  );
  neg(
    mostSevere('MANUAL_REGULATORY_REVIEW_REQUIRED', 'CLEAR') === 'MANUAL_REGULATORY_REVIEW_REQUIRED',
    'G5d and "needs review" outranks "clear"',
  );
  ok(mostSevere('CLEAR', 'CLEAR') === 'CLEAR', 'G6 two clears are clear — the order is not simply "always refuse"');
  ok(
    mostSevere(PERMITTED_WITH_CONSENT, 'CLEAR') === PERMITTED_WITH_CONSENT,
    'G6b and a consent requirement survives aggregation with a clear',
  );
  // Determinism of the evaluation fingerprint: the same facts must hash the same
  // however the object was built, or an audit trail cannot be compared.
  const h1 = inputHashOf({ a: 1, b: [2, 3], c: { d: 4 } });
  const h2 = inputHashOf({ c: { d: 4 }, b: [2, 3], a: 1 });
  ok(
    h1 === h2 && /^[0-9a-f]{64}$/.test(h1),
    'G7 the conflict input hash is key-order independent and a sha256 — two recordings of the same facts compare equal',
  );
  neg(
    inputHashOf({ a: 1 }) !== inputHashOf({ a: 2 }),
    'G7b but different facts hash differently, so the fingerprint is not a constant',
  );
  ok(canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }), 'G7c canonicalJson is the reason why');
}

section('F/pure — policy versions and rule status');
{
  ok(
    POLICY_ACTIONS.length === 4 && POLICY_ACTIONS.includes('approach_minor'),
    'F1 four policy actions, the minor approach among them and named',
  );
  const rows = [
    {
      id: 'p1',
      jurisdiction: 'ENG',
      policyVersion: 1,
      status: 'published',
      effectiveFrom: '2025-01-01',
      effectiveTo: '2026-01-01',
    },
    {
      id: 'p2',
      jurisdiction: 'ENG',
      policyVersion: 2,
      status: 'published',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
  ];
  ok(
    selectPolicyVersion(rows, 'ENG', T0)?.id === 'p2',
    'F2 the version in force at a date is the one selected, not simply the newest row',
  );
  ok(
    selectPolicyVersion(rows, 'ENG', Date.UTC(2025, 5, 1))?.id === 'p1',
    'F2b and history stays reachable at its own date',
  );
  neg(
    selectPolicyVersion(rows, 'SCO', T0) == null,
    "F3 an unsupported jurisdiction selects NOTHING rather than borrowing another's rules",
  );
  neg(ruleStatusAt({ status: 'suspended' }, T0) !== 'active', 'F4 a suspended rule is not active');
}

section('J/pure — the minor threshold is canonical, and the pathway is shut');
{
  ok(
    MINOR_PATHWAY_PRODUCTION_ENABLED.ENG === false &&
      MINOR_PATHWAY_PRODUCTION_ENABLED.INT === false &&
      MINOR_PATHWAY_PRODUCTION_ENABLED.USA === false,
    'J1 the minor pathway is production-disabled in every jurisdiction this build knows',
  );
  ok(
    Object.values(MINOR_PATHWAY_PRODUCTION_ENABLED).every((v) => v === false),
    'J1b every value, not just the three named — a jurisdiction added later cannot default to open',
  );
  const dob17 = new Date(T0 - 17 * YEAR).toISOString().slice(0, 10);
  const dob19 = new Date(T0 - 19 * YEAR).toISOString().slice(0, 10);
  ok(isRegulatoryMinor(dob17, T0) === true, 'J2 a 17-year-old is a regulatory minor');
  ok(isRegulatoryMinor(dob19, T0) === false, 'J2b a 19-year-old is not');
  // Age is a TRI-STATE, and that is the safeguarding design: an unreadable date
  // of birth answers "unknown" rather than "adult", and the GATE is what turns
  // unknown into a refusal. Asserting the gate rather than the helper is the
  // point — a helper returning null is only safe if every caller fails closed.
  // `new Date(null)` is the EPOCH, not an invalid date, so a null date of birth
  // (as are `0` and `false`) would otherwise compute as a 56-year-old ADULT. A
  // missing dob is exactly the shape an imported record has
  // (domains/integrations/imports.mjs projects a missing one as null), so this is
  // a reachable safeguarding fail-open.
  for (const bad of [null, undefined, '', 0, false, [], {}, 'not-a-date']) {
    const label = typeof bad === 'object' && bad !== null ? JSON.stringify(bad) : String(bad);
    ok(isRegulatoryMinor(bad, T0) === null, `J3 a dob of \`${label}\` answers "unknown" — neither minor nor adult`);
    neg(
      isAdult({ dob: bad }, new Date(T0)) === false,
      `J3b and \`${label}\` is NOT an adult: unknown age fails closed`,
    );
    neg(
      evaluateMinorGate({ dob: bad, memberAssociation: 'ENG' }).blocked === true,
      `J3c and the minor gate BLOCKS on \`${label}\``,
    );
  }
  ok(
    evaluateMinorGate({ dob: null, memberAssociation: 'ENG' }).reasons.some((r) => r.code === 'SUBJECT_DOB_UNKNOWN'),
    'J3d naming SUBJECT_DOB_UNKNOWN, so the refusal is explainable without being an age oracle',
  );
  ok(
    isAdult({ dob: '1990-01-01' }, new Date(T0)) === true,
    'J3e while a real adult date of birth is still an adult — the gate is stricter, not broken',
  );
  ok(isAdult({ dob: dob17 }, new Date(T0)) === false, 'J3f and a real 17-year-old is still a minor');
  neg(
    evaluateMinorGate({ dob: dob17, memberAssociation: 'ENG' }).pathwayEnabledInProduction === false,
    'J3g even a correctly-aged minor finds the pathway production-disabled',
  );
}

section('Q/pure — the transaction contract, and what it deliberately lacks');
{
  ok(TRANSACTION_STATUSES.length === 10, 'Q1 ten transaction states');
  neg(
    !TRANSACTION_STATUSES.some((s) => /offer|signed|commission|fee/i.test(s)),
    'Q2 NO transaction state names an offer, a signing, a commission or a fee — the Agent domain implements no Offer workflow',
  );
  neg(!DOCUMENT_TYPES.some((t) => /offer|signature|signed/i.test(t)), 'Q2b nor does any document type');
  ok(DOCUMENT_VISIBILITY.length === 9, 'Q3 nine document visibility classes');
  ok(
    DOCUMENT_VISIBILITY.includes('T_AND_S_ONLY') && DOCUMENT_VISIBILITY.includes('AGENT_PRIVATE'),
    'Q3b including the two that exist to withhold: T&S-only and agent-private',
  );
  ok(
    TIMELINE_AUDIENCES.length === 6 && TIMELINE_AUDIENCES.includes('audit_only'),
    'Q4 six timeline audiences, one of which is audit-only',
  );
}

section('AD/pure — strict input validation: no security decision rests on truthiness');
{
  ok(DISCLOSURE_KEYS.length === 3, 'AD1 exactly three disclosure questions, so an unknown key reaches no field');
  const coercions = ['yes', 'true', 'false', '0', '1', 0, 1, -1, '', 'on', 'off', [], {}, null, undefined, NaN];
  for (const v of coercions) {
    const patch = { [DISCLOSURE_KEYS[0]]: v };
    const out = normaliseDisclosure(patch);
    const label = typeof v === 'object' ? JSON.stringify(v) : String(v);
    neg(
      out === null || out?.[DISCLOSURE_KEYS[0]] !== true,
      `AD2 a privacy choice of \`${label}\` is not accepted as "yes"`,
    );
  }
  ok(
    normaliseDisclosure({ [DISCLOSURE_KEYS[0]]: true })?.[DISCLOSURE_KEYS[0]] === true,
    'AD3 a real boolean true IS accepted — the parser is strict, not broken',
  );
  ok(
    normaliseDisclosure({ [DISCLOSURE_KEYS[0]]: false })?.[DISCLOSURE_KEYS[0]] === false,
    'AD3b and so is a real boolean false',
  );
  neg(
    normaliseDisclosure({ nonsense_key: true }) === null ||
      !Object.hasOwn(normaliseDisclosure({ nonsense_key: true }) ?? {}, 'nonsense_key'),
    'AD4 an unknown disclosure key reaches no stored field',
  );
  neg(
    termMonthsOf('12abc') === null && termMonthsOf(0) === null && termMonthsOf(MAX_TERM_MONTHS + 1) === null,
    'AD5 a term length is an integer in range or it is refused — FFAR 12(3) caps it at two years',
  );
  neg(
    termMonthsOf(NaN) === null && termMonthsOf([]) === null && termMonthsOf({}) === null,
    'AD5b and NaN, an array and an object are not term lengths',
  );
  ok(
    termMonthsOf(undefined) === 12 && termMonthsOf(24) === 24,
    'AD5c an absent term takes the documented default and a legal one is kept',
  );
  // `new Date('2010-02-30')` is not invalid in V8 — it is 2 March — so a format
  // check alone lets birthdays that do not exist through. The platform's one dob
  // reading round-trips the day.
  for (const [label, dob] of [
    ['30 February', '2010-02-30'],
    ['31 April', '2011-04-31'],
    ['29 February in a non-leap year', '2023-02-29'],
  ]) {
    neg(
      parseDob(dob) === null,
      `AD8 ${label} (${dob}) is not a date of birth — V8 would have rolled it over, and the platform refuses to`,
    );
    neg(Number.isNaN(ageOn(dob, new Date(T0))), `AD8b so it has no age`);
    neg(isAdult({ dob }, new Date(T0)) === false, `AD8c and is never an adult`);
    neg(isRegulatoryMinor(dob, T0) === null, `AD8d and is "unknown" to the minor gate, which blocks`);
  }
  ok(
    parseDob('2012-02-29') === '2012-02-29' && Number.isFinite(ageOn('2012-02-29', new Date(T0))),
    'AD8e while a REAL leap day still reads — strict is not the same as broken',
  );
  ok(parseDob('1990-01-01') === '1990-01-01', 'AD8f and an ordinary date round-trips unchanged');
  neg(
    parseDob('1990-1-1') === null && parseDob('01/01/1990') === null && parseDob('1990-01-01T00:00:00Z') === null,
    'AD8g only the canonical YYYY-MM-DD shape is a date of birth — every dob the seed and the import write is that shape, so nothing valid is refused',
  );
}

section('D/pure — the role matrix: which tier may act');
{
  const licensedOnly = ['clients.request', 'clients.opportunities.share'];
  for (const perm of licensedOnly.filter((p) => PERMISSIONS[p])) {
    ok(can(['licensed_agent'], perm) === true, `D1 a licensed agent holds ${perm}`);
    neg(
      can(['agency_admin'], perm) === false,
      `D2 an agency administrator does NOT hold ${perm} — running the business is not representing the client`,
    );
    neg(
      can(['analyst'], perm) === false && can(['assistant'], perm) === false && can(['finance'], perm) === false,
      `D3 and no support tier holds ${perm}`,
    );
  }
  neg(can([], 'clients.request') === false, 'D4 no roles holds nothing');
  neg(can(['licensed_agent'], '__proto__') === false, 'D5 a prototype name is not a permission');
  neg(can(['licensed_agent'], 'constructor') === false, 'D5b nor is "constructor"');
}

section('AA/pure — the rate-limit catalogue, including the new failed-login budget');
{
  ok(!!RATE_LIMIT_POLICY.login_failure, 'AA-p1 a login_failure policy exists');
  ok(
    RATE_LIMIT_POLICY.login_failure.scope === 'actor',
    'AA-p2 and it is scoped per ACTOR (the identifier tried), which is the whole point: an IP-scoped budget cannot bound guessing at one account',
  );
  ok(
    RATE_LIMIT_POLICY.login_failure.windowMs === 900_000 && RATE_LIMIT_POLICY.login_failure.max === 20,
    'AA-p3 20 per 15 minutes',
  );
  ok(
    RATE_LIMIT_POLICY.opportunity_share?.max === 60 && RATE_LIMIT_POLICY.opportunity_share?.scope === 'actor',
    'AA-p4 the opportunity_share quota survived the base: 60/hour per actor',
  );
  ok(
    RATE_LIMIT_POLICY.transaction_handoff?.max === 30 && RATE_LIMIT_POLICY.transaction_handoff?.scope === 'org',
    'AA-p5 and transaction_handoff: 30/hour per org',
  );
  ok(
    Object.values(RATE_LIMIT_POLICY).every(
      (p) => Number.isFinite(p.max) && p.max > 0 && Number.isFinite(p.windowMs) && p.windowMs > 0,
    ),
    'AA-p6 every policy has a finite positive budget and window — an unreadable quota is an absent quota',
  );
  ok(
    Object.values(RATE_LIMIT_POLICY).every((p) => typeof p.note === 'string' && p.note.length > 0),
    'AA-p7 and every policy says in words what it protects',
  );
}

section('W/pure — events, and the vocabulary that must not appear');
{
  const names = Object.keys(EVENT_REGISTRY);
  ok(names.length > 0, 'W1 the event registry is populated');
  neg(!names.some((n) => /offer_made|offer_accepted|offer_declined/.test(n)), 'W2 no offer lifecycle event exists');
  // The signing workflow has its own club-private events (signing_*); the AGENT domain emits none, and no `signed_contract` vocabulary exists.
  neg(
    !names.some((n) => /signed_contract/.test(n)) &&
      names
        .filter((n) => /signing/.test(n))
        .every((n) => /^signing_/.test(n) && EVENT_REGISTRY[n].audience === 'org_private') &&
      !names.some((n) => /^(agent|representation|transaction).*sign/.test(n)),
    "W2b nor an agent-domain signing event — the signing_* events are the club's own, org_private",
  );
  neg(!names.some((n) => /commission|fee_agreed/.test(n)), 'W2c nor a commission event');
  ok(DATA_MIGRATIONS.length === SCHEMA_VERSION, 'W3 the schema is 40, the latest table migration (0040_match_facts)');
}

done();
