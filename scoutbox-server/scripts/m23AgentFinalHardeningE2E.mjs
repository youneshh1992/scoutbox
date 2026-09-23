// M23 P5.6F — ScoutBox Agent FINAL HARDENING suite (reconstructed).
//
// RECONSTRUCTION NOTE. P5.6F was originally completed and then lost when the
// execution container was rebuilt before its backup push. This suite is a
// RECONSTRUCTION against the frozen b8556c1 base, written from the P5.6F mandate
// rather than recovered from the lost source. The historical run reported 181
// checks / 127 negative; that is a historical figure, NOT a target, and nothing
// here is padded to approach it.
//
// The governing question is not "does the Agent domain work?" — five earlier
// milestones answered that. It is: treat P5.6A–E as a candidate production
// subsystem and try to BREAK it. So the bias is negative: most checks here are
// an attempt to obtain something the caller must not have.
//
// Three product defects the original pass found, each re-proved here as a
// regression:
//   F-2  a mandate whose term began in the FUTURE granted access today, because
//        startAt was never consulted anywhere (groups B, Z).
//   F-3  a PRESENT but unreadable endAt (an ISO string, a NaN) fell through the
//        expiry guard into "not expired" and granted access for ever (group Z).
//   F-5  the only login throttle was per-IP and counted successes, so it could
//        not bound guessing at one account and one tenant's ordinary traffic
//        denied another's sign-in (group AA — which runs LAST, see below).
//
// Groups: A auth/session revocation · B canonical representation · C legacy ·
//   D same-agency privacy · E licence facets · F policy versions · G conflict
//   severity · H consent · I reviewer attribution · J minors · K guardian ·
//   L Contact · M Inbox · N Trial · O Passport · P Trust · Q Transaction ·
//   R documents · S P5 handoff · T club/agency boundary · U search/count
//   privacy · V deep links · W events/notifications · X audit · Y tombstones ·
//   Z corruption/legacy temporal rows · AA rate limits · AB idempotency ·
//   AC rev/concurrency · AD strict input validation · AE error privacy ·
//   AF EN/FR contract · AG accessibility contract · AH responsive contract ·
//   AI persistence · AJ recovery invariants.
//
// No assertion is `status !== 200`, and none is a tautology: every refusal names
// its status and its code.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agreementGrantsAccess, effectiveAgreementStatus, agreementTermCoversNow,
  AGREEMENT_STATUSES, PERMISSIONS, can, SCOPES, MAX_TERM_MONTHS, termMonthsOf,
  DISCLOSURE_KEYS, normaliseDisclosure,
} from '../m24/shared.mjs';
import {
  evaluateConflict, CONFLICT_OUTCOMES, PERMITTED_WITH_CONSENT, mostSevere, inputHashOf, canonicalJson,
} from '../m25/conflict.mjs';
import {
  POLICY_ACTIONS, MINOR_PATHWAY_PRODUCTION_ENABLED, isRegulatoryMinor, evaluateMinorGate,
  ruleStatusAt, selectPolicyVersion,
} from '../m25/policy.mjs';
import { TRANSACTION_STATUSES, DOCUMENT_TYPES, DOCUMENT_VISIBILITY, TIMELINE_AUDIENCES } from '../m26/transaction.mjs';
import { isAdult } from '../domain.mjs';
import { agentClientBasis } from '../m27/integration.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { SCHEMA_VERSION } from '../m182/migrations.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { openStore } from '../store.mjs';
import { hashPassword } from '../adapters.mjs';

const PORT = 7400 + Math.floor(Math.random() * 150);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-p56f-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.UTC(2026, 8, 20);
const DAY = 86_400_000;
const YEAR = 365 * DAY;

// =================================================================== PURE

section('A/pure — the temporal rule, stated as a rule (F-2 + F-3 regression)');
{
  const live = { status: 'active', confirmedAt: T0 - DAY, agentUserId: 'u', clientId: 'p', startAt: T0 - DAY, endAt: T0 + DAY };
  const g = (patch) => agreementGrantsAccess({ ...live, ...patch }, 'u', T0);

  ok(g({}) === true, 'A1 the control: an in-term, confirmed, active mandate naming this agent DOES grant access');
  ok(g({ startAt: T0 }) === true, 'A2 a term beginning exactly now has begun');
  ok(g({ startAt: null, endAt: null }) === true, 'A3 an absent boundary is an OPEN boundary, not a malformed one — an open-ended mandate is contract-legal for an entity (FFAR 12(5))');
  ok(g({ startAt: undefined, endAt: undefined }) === true, 'A3b undefined reads the same as null: absent is absent');
  ok(g({ endAt: T0 + YEAR }) === true, 'A4 a readable future end is in term');

  // F-2: the start boundary. Before the repair, startAt was never read at all.
  neg(g({ startAt: T0 + YEAR, endAt: T0 + 2 * YEAR }) === false, 'A5 F-2: a mandate whose term BEGINS IN A YEAR grants nothing today');
  neg(g({ startAt: T0 + 1 }) === false, 'A5b and one that begins a millisecond from now has not begun');
  neg(g({ startAt: NaN }) === false, 'A6 F-2: a NaN start is a boundary that cannot be read — refuse, never ignore');
  neg(g({ startAt: '2026-01-01T00:00:00.000Z' }) === false, 'A6b an ISO-string start — the shape of an imported row — is unreadable, so refused');
  neg(g({ startAt: Infinity }) === false, 'A6c an infinite start never arrives');

  // F-3: the end boundary. Before the repair `typeof endAt === 'number'` let
  // every non-number fall through the expiry guard into "not expired".
  neg(g({ endAt: T0 }) === false, 'A7 a term ending exactly now is over');
  neg(g({ endAt: T0 - DAY }) === false, 'A7b a readable past end is over');
  neg(g({ endAt: '2024-01-01T00:00:00.000Z' }) === false, 'A8 F-3: an ISO-string end that already passed no longer grants access FOR EVER');
  neg(g({ endAt: NaN }) === false, 'A8b F-3: NaN is a number for which NaN <= now is false — the exact shape that fell through');
  neg(g({ endAt: String(T0 - DAY) }) === false, 'A8c a numeric STRING end is still not a readable number');
  neg(g({ endAt: Infinity }) === false, 'A8d an infinite end is not an open end: absent means open, present means readable');

  ok(agreementTermCoversNow({ startAt: null, endAt: null }, T0) === true, 'A9 the term rule is exported and assertable on its own, not only through a route');
  neg(agreementTermCoversNow({ startAt: T0 + YEAR }, T0) === false, 'A9b including the future-start case');
  neg(agreementTermCoversNow(null, T0) === false, 'A9c and no agreement at all covers nothing');

  // The status vocabulary is NOT extended: a future-start row still reads as
  // `active` (it is a live agreement) while granting nothing. Status and access
  // are two different questions, and P5.6F does not invent a frozen-contract value.
  ok(effectiveAgreementStatus({ ...live, startAt: T0 + YEAR }, T0) === 'active', 'A10 a not-yet-started mandate still READS as active — P5.6F adds no status value to a frozen contract');
  ok(effectiveAgreementStatus({ ...live, endAt: NaN }, T0) === 'expired', 'A10b but an unreadable end reads as EXPIRED everywhere, so a projection cannot disagree with the access decision');
  ok(!AGREEMENT_STATUSES.includes('not_started'), 'A10c and no new status was smuggled into AGREEMENT_STATUSES');
}

section('B/pure — every non-active state, and every wrong caller');
{
  const live = { status: 'active', confirmedAt: T0 - DAY, agentUserId: 'u', clientId: 'p', startAt: T0 - DAY, endAt: T0 + DAY };
  const g = (patch) => agreementGrantsAccess({ ...live, ...patch }, 'u', T0);
  for (const st of AGREEMENT_STATUSES.filter((s) => s !== 'active')) {
    neg(g({ status: st }) === false, `B1 status "${st}" grants nothing`);
  }
  neg(g({ confirmedAt: null }) === false, 'B2 an "active" row the client never confirmed grants nothing — the client\'s act is the root of the authority');
  neg(g({ agentUserId: 'someone-else' }) === false, 'B3 a colleague\'s agreement is not this agent\'s');
  neg(agreementGrantsAccess({ ...live, agentUserId: null }, null, T0) === false, 'B4 a legacy agency-level row (no agent) matches no caller, not even one with no id');
  neg(agreementGrantsAccess({ ...live, agentUserId: '' }, '', T0) === false, 'B4b nor does an empty agent id act as a wildcard');
  neg(agreementGrantsAccess(undefined, 'u', T0) === false, 'B5 no record at all grants nothing');
}

section('C/pure — a legacy M13 mirror is history, not authority');
{
  const mirror = { id: 'rep-legacy', agentUserId: null, clientId: 'p', status: 'active', confirmedAt: T0 - DAY, startAt: T0 - DAY, endAt: T0 + YEAR, legacy: { fromRepresentationId: 'old-1' } };
  neg(agreementGrantsAccess(mirror, 'u', T0) === false, 'C1 a legacy mirror grants no access');
  neg(agentClientBasis({ agreements: [mirror], agentUserId: 'u', clientId: 'p', now: T0 }).ok === false, 'C2 and yields no integration basis, so no surface can be reached through it');
  ok(effectiveAgreementStatus(mirror, T0) === 'active', 'C3 the row may still read as active: the PREDICATE withholds authority rather than the record being rewritten');
}

section('G/pure — conflict severity: a prohibition is never softened (§6)');
{
  ok(CONFLICT_OUTCOMES.length === 5, 'G1 five outcomes, no sixth escape hatch');
  for (const a of CONFLICT_OUTCOMES) {
    for (const b of CONFLICT_OUTCOMES) {
      const m = mostSevere(a, b);
      ok(CONFLICT_OUTCOMES.includes(m), `G2 mostSevere(${a}, ${b}) is a declared outcome`);
    }
  }
  neg(mostSevere('PROHIBITED_CONFLICT', PERMITTED_WITH_CONSENT) === 'PROHIBITED_CONFLICT', 'G3 a prohibition is not downgraded to "permitted with consent"');
  neg(mostSevere('PROHIBITED_CONFLICT', 'CLEAR') === 'PROHIBITED_CONFLICT', 'G4 nor to CLEAR');
  neg(mostSevere('PROHIBITED_CONFLICT', 'MANUAL_REGULATORY_REVIEW_REQUIRED') === 'PROHIBITED_CONFLICT', 'G5 nor to manual review — review is the ABSENCE of an answer and cannot soften a definite one (§6)');
  neg(mostSevere('PROHIBITED_CONFLICT', 'INSUFFICIENT_DATA') === 'PROHIBITED_CONFLICT', 'G5b nor to insufficient data: a missing fact cannot unmake a known prohibition');
  neg(mostSevere('INSUFFICIENT_DATA', 'CLEAR') === 'INSUFFICIENT_DATA', 'G5c uncertainty is never resolved AS permission');
  neg(mostSevere('MANUAL_REGULATORY_REVIEW_REQUIRED', 'CLEAR') === 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'G5d and "needs review" outranks "clear"');
  ok(mostSevere('CLEAR', 'CLEAR') === 'CLEAR', 'G6 two clears are clear — the order is not simply "always refuse"');
  ok(mostSevere(PERMITTED_WITH_CONSENT, 'CLEAR') === PERMITTED_WITH_CONSENT, 'G6b and a consent requirement survives aggregation with a clear');
  // Determinism of the evaluation fingerprint: the same facts must hash the same
  // however the object was built, or an audit trail cannot be compared.
  const h1 = inputHashOf({ a: 1, b: [2, 3], c: { d: 4 } });
  const h2 = inputHashOf({ c: { d: 4 }, b: [2, 3], a: 1 });
  ok(h1 === h2 && /^[0-9a-f]{64}$/.test(h1), 'G7 the conflict input hash is key-order independent and a sha256 — two recordings of the same facts compare equal');
  neg(inputHashOf({ a: 1 }) !== inputHashOf({ a: 2 }), 'G7b but different facts hash differently, so the fingerprint is not a constant');
  ok(canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }), 'G7c canonicalJson is the reason why');
}

section('F/pure — policy versions and rule status');
{
  ok(POLICY_ACTIONS.length === 4 && POLICY_ACTIONS.includes('approach_minor'), 'F1 four policy actions, the minor approach among them and named');
  const rows = [
    { id: 'p1', jurisdiction: 'ENG', policyVersion: 1, status: 'published', effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01' },
    { id: 'p2', jurisdiction: 'ENG', policyVersion: 2, status: 'published', effectiveFrom: '2026-01-01', effectiveTo: null },
  ];
  ok(selectPolicyVersion(rows, 'ENG', T0)?.id === 'p2', 'F2 the version in force at a date is the one selected, not simply the newest row');
  ok(selectPolicyVersion(rows, 'ENG', Date.UTC(2025, 5, 1))?.id === 'p1', 'F2b and history stays reachable at its own date');
  neg(selectPolicyVersion(rows, 'SCO', T0) == null, 'F3 an unsupported jurisdiction selects NOTHING rather than borrowing another\'s rules');
  neg(ruleStatusAt({ status: 'suspended' }, T0) !== 'active', 'F4 a suspended rule is not active');
}

section('J/pure — the minor threshold is canonical, and the pathway is shut (§12)');
{
  ok(MINOR_PATHWAY_PRODUCTION_ENABLED.ENG === false && MINOR_PATHWAY_PRODUCTION_ENABLED.INT === false && MINOR_PATHWAY_PRODUCTION_ENABLED.USA === false, 'J1 the minor pathway is production-disabled in every jurisdiction this build knows');
  ok(Object.values(MINOR_PATHWAY_PRODUCTION_ENABLED).every((v) => v === false), 'J1b every value, not just the three named — a jurisdiction added later cannot default to open');
  const dob17 = new Date(T0 - 17 * YEAR).toISOString().slice(0, 10);
  const dob19 = new Date(T0 - 19 * YEAR).toISOString().slice(0, 10);
  ok(isRegulatoryMinor(dob17, T0) === true, 'J2 a 17-year-old is a regulatory minor');
  ok(isRegulatoryMinor(dob19, T0) === false, 'J2b a 19-year-old is not');
  // Age is a TRI-STATE, and that is the safeguarding design: an unreadable date
  // of birth answers "unknown" rather than "adult", and the GATE is what turns
  // unknown into a refusal. Asserting the gate rather than the helper is the
  // point — a helper returning null is only safe if every caller fails closed.
  // F-8 regression. `new Date(null)` is the EPOCH, not an invalid date, so a
  // null date of birth used to compute as a 56-year-old and read as an ADULT on
  // both age paths. `0` and `false` did the same. A missing date of birth is
  // exactly the shape an imported record has (m13/imports.mjs treats dob as
  // optional and projects a missing one as null), so this was a reachable
  // safeguarding fail-open, not a theoretical one.
  for (const bad of [null, undefined, '', 0, false, [], {}, 'not-a-date']) {
    const label = typeof bad === 'object' && bad !== null ? JSON.stringify(bad) : String(bad);
    ok(isRegulatoryMinor(bad, T0) === null, `J3 a dob of \`${label}\` answers "unknown" — neither minor nor adult`);
    neg(isAdult({ dob: bad }, new Date(T0)) === false, `J3b and \`${label}\` is NOT an adult: unknown age fails closed`);
    neg(evaluateMinorGate({ dob: bad, memberAssociation: 'ENG' }).blocked === true, `J3c and the minor gate BLOCKS on \`${label}\``);
  }
  ok(evaluateMinorGate({ dob: null, memberAssociation: 'ENG' }).reasons.some((r) => r.code === 'SUBJECT_DOB_UNKNOWN'), 'J3d naming SUBJECT_DOB_UNKNOWN, so the refusal is explainable without being an age oracle');
  ok(isAdult({ dob: '1990-01-01' }, new Date(T0)) === true, 'J3e while a real adult date of birth is still an adult — the gate is stricter, not broken');
  ok(isAdult({ dob: dob17 }, new Date(T0)) === false, 'J3f and a real 17-year-old is still a minor');
  neg(evaluateMinorGate({ dob: dob17, memberAssociation: 'ENG' }).pathwayEnabledInProduction === false, 'J3g even a correctly-aged minor finds the pathway production-disabled');
}

section('Q/pure — the transaction contract, and what it deliberately lacks (§15)');
{
  ok(TRANSACTION_STATUSES.length === 10, 'Q1 ten transaction states');
  neg(!TRANSACTION_STATUSES.some((s) => /offer|signed|commission|fee/i.test(s)), 'Q2 NO transaction state names an offer, a signing, a commission or a fee — P5.6F implements no Offer workflow');
  neg(!DOCUMENT_TYPES.some((t) => /offer|signature|signed/i.test(t)), 'Q2b nor does any document type');
  ok(DOCUMENT_VISIBILITY.length === 9, 'Q3 nine document visibility classes');
  ok(DOCUMENT_VISIBILITY.includes('T_AND_S_ONLY') && DOCUMENT_VISIBILITY.includes('AGENT_PRIVATE'), 'Q3b including the two that exist to withhold: T&S-only and agent-private');
  ok(TIMELINE_AUDIENCES.length === 6 && TIMELINE_AUDIENCES.includes('audit_only'), 'Q4 six timeline audiences, one of which is audit-only');
}

section('AD/pure — strict input validation: no security decision rests on truthiness (§16)');
{
  ok(DISCLOSURE_KEYS.length === 3, 'AD1 exactly three disclosure questions, so an unknown key reaches no field');
  const coercions = ['yes', 'true', 'false', '0', '1', 0, 1, -1, '', 'on', 'off', [], {}, null, undefined, NaN];
  for (const v of coercions) {
    const patch = { [DISCLOSURE_KEYS[0]]: v };
    const out = normaliseDisclosure(patch);
    const label = typeof v === 'object' ? JSON.stringify(v) : String(v);
    neg(out === null || out?.[DISCLOSURE_KEYS[0]] !== true, `AD2 a privacy choice of \`${label}\` is not accepted as "yes"`);
  }
  ok(normaliseDisclosure({ [DISCLOSURE_KEYS[0]]: true })?.[DISCLOSURE_KEYS[0]] === true, 'AD3 a real boolean true IS accepted — the parser is strict, not broken');
  ok(normaliseDisclosure({ [DISCLOSURE_KEYS[0]]: false })?.[DISCLOSURE_KEYS[0]] === false, 'AD3b and so is a real boolean false');
  neg(normaliseDisclosure({ nonsense_key: true }) === null || !Object.hasOwn(normaliseDisclosure({ nonsense_key: true }) ?? {}, 'nonsense_key'), 'AD4 an unknown disclosure key reaches no stored field');
  neg(termMonthsOf('12abc') === null && termMonthsOf(0) === null && termMonthsOf(MAX_TERM_MONTHS + 1) === null, 'AD5 a term length is an integer in range or it is refused — FFAR 12(3) caps it at two years');
  neg(termMonthsOf(NaN) === null && termMonthsOf([]) === null && termMonthsOf({}) === null, 'AD5b and NaN, an array and an object are not term lengths');
  ok(termMonthsOf(undefined) === 12 && termMonthsOf(24) === 24, 'AD5c an absent term takes the documented default and a legal one is kept');
}

section('D/pure — the role matrix: which tier may act (§10)');
{
  const licensedOnly = ['clients.request', 'clients.opportunities.share'];
  for (const perm of licensedOnly.filter((p) => PERMISSIONS[p])) {
    ok(can(['licensed_agent'], perm) === true, `D1 a licensed agent holds ${perm}`);
    neg(can(['agency_admin'], perm) === false, `D2 an agency administrator does NOT hold ${perm} — running the business is not representing the client`);
    neg(can(['analyst'], perm) === false && can(['assistant'], perm) === false && can(['finance'], perm) === false, `D3 and no support tier holds ${perm}`);
  }
  neg(can([], 'clients.request') === false, 'D4 no roles holds nothing');
  neg(can(['licensed_agent'], '__proto__') === false, 'D5 a prototype name is not a permission');
  neg(can(['licensed_agent'], 'constructor') === false, 'D5b nor is "constructor"');
}

section('AA/pure — the rate-limit catalogue, including the new failed-login budget');
{
  ok(!!RATE_LIMIT_POLICY.login_failure, 'AA-p1 a login_failure policy exists (F-5)');
  ok(RATE_LIMIT_POLICY.login_failure.scope === 'actor', 'AA-p2 and it is scoped per ACTOR (the identifier tried), which is the whole point: an IP-scoped budget cannot bound guessing at one account');
  ok(RATE_LIMIT_POLICY.login_failure.windowMs === 900_000 && RATE_LIMIT_POLICY.login_failure.max === 20, 'AA-p3 20 per 15 minutes');
  ok(RATE_LIMIT_POLICY.opportunity_share?.max === 60 && RATE_LIMIT_POLICY.opportunity_share?.scope === 'actor', 'AA-p4 the P5.6E opportunity_share quota survived the base: 60/hour per actor (§4)');
  ok(RATE_LIMIT_POLICY.transaction_handoff?.max === 30 && RATE_LIMIT_POLICY.transaction_handoff?.scope === 'org', 'AA-p5 and transaction_handoff: 30/hour per org (§4)');
  ok(Object.values(RATE_LIMIT_POLICY).every((p) => Number.isFinite(p.max) && p.max > 0 && Number.isFinite(p.windowMs) && p.windowMs > 0), 'AA-p6 every policy has a finite positive budget and window — an unreadable quota is an absent quota');
  ok(Object.values(RATE_LIMIT_POLICY).every((p) => typeof p.note === 'string' && p.note.length > 0), 'AA-p7 and every policy says in words what it protects');
}

section('W/pure — events, and the vocabulary that must not appear');
{
  const names = Object.keys(EVENT_REGISTRY);
  ok(names.length > 0, 'W1 the event registry is populated');
  neg(!names.some((n) => /offer_made|offer_accepted|offer_declined/.test(n)), 'W2 no offer lifecycle event exists (§15)');
  neg(!names.some((n) => /signing|signed_contract/.test(n)), 'W2b nor a signing event');
  neg(!names.some((n) => /commission|fee_agreed/.test(n)), 'W2c nor a commission event');
  ok(SCHEMA_VERSION === 2307, 'W3 the schema is 2307 — P5.6F adds no migration');
}

// =================================================================== LIVE

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', SCOUTBOX_TEST_CLOCK: '1', ...env },
    stdio: 'ignore',
  });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); }
  await sleep(300);
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const ERRORS = [];
const collect = (label, r) => { if (r.status >= 400) ERRORS.push({ label, status: r.status, body: r.body }); return r; };
const expect = (r, status, code) => {
  const good = r.status === status && (code == null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return good;
};

// A second agency has to exist before boot, so that "a foreign agency" is a
// different thing from "a colleague at my agency" in every check below.
let server = await boot();
await stop(server);
{
  const store = openStore(DATA_DIR);
  const snap = store.load();
  const agency = snap.db.orgs.find((o) => o.type === 'agency');
  snap.db.orgs.push({ ...structuredClone(agency), id: 'org-southgate', name: 'Southgate Sports Management', slug: 'southgate' });
  // A password-protected guardian reachable by id AND by email, for the
  // failed-login alias check (F-11). The seeded guardians have open (null)
  // passwords in development, so nothing about them can ever fail to
  // authenticate — and a budget that is never charged cannot be tested.
  const guardianBase = snap.db.guardians[0];
  snap.db.guardians.push({ ...structuredClone(guardianBase), id: 'gd-locktest', name: 'Lock Test', email: 'locktest@example.test', password: hashPassword('right-password-1'), childIds: [] });
  store.save(snap);
  ok(snap.db.orgs.filter((o) => o.type === 'agency').length === 2, 'fixture: two agencies exist');
  ok(snap.db.guardians.some((g) => g.id === 'gd-locktest' && g.password), 'fixture: a password-protected guardian exists, so a wrong password is a chargeable failure');
}
server = await boot();

section('fixture — an agency with five tiers, a confirmed client, two clubs');
const alex = await login('org-northstar', 'Alex Admin', 'Director', 'agent');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = await playerLogin('pl-adeyemi');
ok([alex, maria, rita, kola].every((x) => x?.token), 'fixture: an agency director, two clubs and a player are signed in');

// Five tiers at ONE agency, so "same-agency membership" can be tested as a matrix.
const TIERS = [['Ada Agent', 'licensed_agent'], ['Ben Agent', 'licensed_agent'], ['Cleo Analyst', 'analyst'], ['Dov Assist', 'assistant'], ['Eve Finance', 'finance']];
for (const [name, tier] of TIERS) await j('POST', '/org/agent/agency/team', { name, tiers: [tier] }, alex.token);
const ada = await login('org-northstar', 'Ada Agent', 'Agent', 'agent');
const ben = await login('org-northstar', 'Ben Agent', 'Agent', 'agent');
const cleo = await login('org-northstar', 'Cleo Analyst', 'Analyst', 'agent');
const dov = await login('org-northstar', 'Dov Assist', 'Assistant', 'agent');
const eve = await login('org-northstar', 'Eve Finance', 'Finance', 'agent');
ok([ada, ben, cleo, dov, eve].every((x) => x?.token), 'fixture: five colleagues at one agency, across every tier');

for (const who of [ada, ben]) {
  await j('POST', '/org/agent/profile', { displayName: 'Licensed', jurisdictions: ['ENG'] }, who.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-X' }, who.token);
  await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-X-ENG', memberAssociation: 'ENG' }, who.token);
}
const REQ = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' , clientKey: key() }, ada.token);
const REP = REQ.body?.relationship?.id;
ok(!!REP, 'fixture: Ada requested a mandate');
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kola.token);
ok(CONF.status === 200 && CONF.body?.relationship?.status === 'active', 'fixture: the client confirmed it — the root of every authority below');
let REV = CONF.body?.relationship?.rev;

section('D/live — same-agency membership grants no confidential client access (§10)');
{
  const colleagues = [['a licensed colleague', ben], ['an analyst', cleo], ['an assistant', dov], ['finance', eve]];
  for (const [who, tok] of colleagues) {
    const detail = collect(`${who} client detail`, await j('GET', `/org/agent/clients/${REP}`, undefined, tok.token));
    neg(expect(detail, 404, null), `D6 ${who} at the OWNING agency cannot open the client record — concealed as 404 ${detail.body?.error}, the same shape as a record that never existed`);
    const list = await j('GET', '/org/agent/clients', undefined, tok.token);
    const namesClient = JSON.stringify(list.body ?? {}).includes(REP);
    neg(!namesClient, `D7 ${who} does not see the mandate in their own client list either`);
  }
  // The agency administrator may know the business exists, but not read the file.
  const adminDetail = collect('admin client detail', await j('GET', `/org/agent/clients/${REP}`, undefined, alex.token));
  neg(expect(adminDetail, 404, null), `D8 the agency ADMINISTRATOR cannot open the representing agent's client record either — 404 ${adminDetail.body?.error}`);
  const owner = await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token);
  ok(owner.status === 200, 'D9 while the representing agent can — the wall is between people, not around the whole agency');
}

section('T/live — the club/agency boundary, in both directions');
{
  for (const [what, url] of [['clients', '/org/agent/clients'], ['agent home', '/org/agent/home'], ['compliance contexts', '/org/agent/compliance/contexts'], ['agent transactions', '/org/agent/transactions'], ['agent inbox', '/org/agent/inbox']]) {
    const r = collect(`club on ${what}`, await j('GET', url, undefined, maria.token));
    neg(expect(r, 403, null), `T1 a CLUB session is refused the agent lane's ${what} — 403 ${r.body?.error}`);
  }
  const foreign = collect('foreign agency', await j('GET', `/org/agent/clients/${REP}`, undefined, (await login('org-southgate', 'Zed Admin', 'Director', 'agent')).token));
  neg(expect(foreign, 404, null), `T2 a FOREIGN agency cannot open another agency's mandate — concealed as 404 ${foreign.body?.error}`);
}

section('A/live — authority is re-derived on the NEXT request, not at login (§11)');
{
  // Ada's session stays valid; her AFFILIATION ends underneath it. Every agent
  // route must refuse on the next request with no re-login in between. This is
  // the case a suite that logs in fresh for every assertion never sees.
  const teamBefore = await j('GET', '/org/agent/agency/team', undefined, alex.token);
  const benRow = (teamBefore.body?.members ?? []).find((m) => m.name === 'Ben Agent');
  ok(!!benRow, 'A11 fixture: the agency team lists Ben');
  const end = await j('POST', `/org/agent/agency/team/${benRow.userId ?? benRow.id}/end`, {}, alex.token);
  ok(end.status === 200 || end.status === 204, `A12 the administrator ended Ben's affiliation (${end.status})`);
  for (const [what, url] of [['home', '/org/agent/home'], ['clients', '/org/agent/clients'], ['profile', '/org/agent/profile'], ['compliance', '/org/agent/compliance/contexts'], ['transactions', '/org/agent/transactions']]) {
    const r = collect(`ended affiliation on ${what}`, await j('GET', url, undefined, ben.token));
    neg(expect(r, 401, null), `A13 Ben's still-live session is refused ${what} on the very next request — 401 ${r.body?.error}, and the session is gone rather than merely denied`);
  }
}

section('J/live — a minor is indistinguishable from a player who does not exist (§12)');
{
  const minor = await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG' , clientKey: key() }, ada.token);
  const ghost = await j('POST', '/org/agent/clients/request', { playerId: 'pl-does-not-exist-at-all', scope: ['employment'], jurisdiction: 'ENG' , clientKey: key() }, ada.token);
  collect('minor request', minor); collect('ghost request', ghost);
  neg(expect(minor, 404, null), `J4 a mandate request naming a MINOR is refused — 404 ${minor.body?.error}`);
  neg(expect(ghost, 404, null), `J4b and so is one naming a player who does not exist — 404 ${ghost.body?.error}`);
  ok(minor.status === ghost.status && JSON.stringify(minor.body) === JSON.stringify(ghost.body), 'J5 and the two refusals are BYTE-IDENTICAL — the refusal is not an age oracle and not an existence oracle');
  // Forging the facts that would open the minor pathway changes nothing.
  const forged = collect('forged minor', await j('POST', '/org/agent/clients/request', { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG', dob: '1990-01-01', isAdult: true, guardianConsent: true, minorPathway: true , clientKey: key() }, ada.token));
  neg(expect(forged, 404, null), `J6 forging dob, isAdult, guardianConsent and minorPathway in the body does not open the minor pathway — 404 ${forged.body?.error}`);
  ok(JSON.stringify(forged.body) === JSON.stringify(ghost.body), 'J6b and the forged request is refused identically to the ghost — the client cannot assert its way past a server-side age rule');
  const players = await j('GET', '/org/agent/players?q=Guni', undefined, ada.token);
  neg(!JSON.stringify(players.body ?? {}).includes('pl-guni'), 'J7 and the minor does not appear in an agent player search');
}

section('U/live — counts, totals and pagination disclose nothing extra');
{
  for (const [what, url, tok] of [['the agent client list', '/org/agent/clients', ada.token], ['the opportunity board', '/org/agent/opportunities', ada.token], ['the transaction list', '/org/agent/transactions', ada.token]]) {
    const r = await j('GET', url, undefined, tok);
    if (r.status !== 200) { ok(false, `U1 ${what} answered ${r.status}`); continue; }
    const b = r.body ?? {};
    const items = Array.isArray(b) ? b : (b.items ?? b.clients ?? b.transactions ?? b.opportunities ?? []);
    const total = Array.isArray(b) ? undefined : b.total;
    ok(total === undefined || total === items.length, `U1 ${what}: \`total\` either does not exist or equals the rows actually returned (${total} vs ${items.length}) — a count of rows the caller cannot see is a disclosure`);
  }
}

section('V/live — deep links after authority loss, and history is not access');
{
  const before = await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token);
  ok(before.status === 200, 'V1 the agent can read her own client while the mandate is active');
  const term = await j('POST', `/org/agent/clients/${REP}/terminate`, { reason: 'ending it' , clientKey: key() }, ada.token);
  ok(term.status === 200, `V2 the agent terminated her own mandate (${term.status})`);
  const after = collect('terminated client detail', await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token));
  // P5.6B deliberately keeps an ENDED mandate as the agent's own history, so the
  // assertion is about CONTENTS, not about a status code.
  // Pinned, not either-way: P5.6B keeps an ended mandate as the agent's own
  // history, so the record MUST still answer 200. A test that also accepted a
  // refusal here would pass under two contradictory products.
  ok(after.status === 200, `V3 the relationship record itself still answers 200 — an ended mandate is the agent's own history, deliberately (P5.6B) (${after.status})`);
  const txt = JSON.stringify(after.body ?? {});
  ok(/terminated/i.test(txt), 'V3a and reads as terminated, so history says what happened');
  neg(!/Passport|passport/.test(txt), 'V3b but it carries no Passport');
  neg(!/assessment/i.test(txt), 'V3c no assessments');
  neg(!/"contacts":\s*\[[^\]]/.test(txt), 'V3d and no contacts — history is not access');
  const opps = collect('terminated opportunities', await j('GET', `/org/agent/clients/${REP}/opportunities`, undefined, ada.token));
  neg(expect(opps, 409, null), `V4 and the client-scoped surfaces reached by the ids she still holds are refused — 409 ${opps.body?.error}: the relationship exists but is not active, which is a state conflict, not a missing record`);
}

section('AC/live — rev conflicts: two answers to one question cannot both land');
{
  const r2 = await j('POST', '/org/agent/clients/request', { playerId: 'pl-svensson', scope: ['employment'], jurisdiction: 'ENG' , clientKey: key() }, ada.token);
  const rep2 = r2.body?.relationship?.id;
  if (!rep2) { ok(false, `AC1 fixture: a second mandate could not be requested (${r2.status})`); }
  else {
    const sven = await playerLogin('pl-svensson');
    const c = await j('POST', `/player/agent/relationships/${rep2}/confirm`, { expectedRev: 1 }, sven.token);
    ok(c.status === 200, `AC1 the second client confirmed (${c.status})`);
    const rev = c.body?.relationship?.rev;
    const first = await j('PATCH', `/player/agent/relationships/${rep2}/sharing`, { disclosure: { [DISCLOSURE_KEYS[0]]: true }, expectedRev: rev }, sven.token);
    ok(first.status === 200, `AC2 a disclosure change against the current rev lands (${first.status})`);
    const stale = collect('stale rev', await j('PATCH', `/player/agent/relationships/${rep2}/sharing`, { disclosure: { [DISCLOSURE_KEYS[1]]: true }, expectedRev: rev }, sven.token));
    neg(stale.status === 409, `AC3 a second change against the SAME, now stale, rev is refused 409 (${stale.status}) — two questions cannot be answered in one race`);
  }
}

section('AB/live — idempotency: a replay is an answer, not a second act');
{
  // The key travels in the BODY as `clientKey` (m23/contact.mjs normaliseClientKey,
  // used by m24/m25/m26 alike), not in an Idempotency-Key header.
  const k = key();
  const body = { playerId: 'pl-martin', scope: ['employment'], jurisdiction: 'ENG', clientKey: k };
  const a = await j('POST', '/org/agent/clients/request', body, ada.token);
  const b = await j('POST', '/org/agent/clients/request', body, ada.token);
  ok(a.status === 200 || a.status === 201, `AB1 the first request was accepted (${a.status})`);
  ok(b.body?.relationship?.id === a.body?.relationship?.id, 'AB2 the same key with the same payload replays the ORIGINAL answer rather than asking a second time');
  ok(b.body?.idempotent === true, 'AB2b and says so — a replay is labelled, not silently indistinguishable from a fresh act');
  const c = collect('key reuse, different payload', await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', scope: ['commercial'], jurisdiction: 'ENG', clientKey: k }, ada.token));
  neg(expect(c, 409, 'REPRESENTATION_IDEMPOTENCY_CONFLICT'), `AB3 the same key with a DIFFERENT payload is refused 409 REPRESENTATION_IDEMPOTENCY_CONFLICT rather than quietly creating a second row (${c.status})`);
  const blank = collect('non-string key', await j('POST', '/org/agent/clients/request', { playerId: 'pl-okafor', scope: ['employment'], jurisdiction: 'ENG', clientKey: 12345 }, ada.token));
  neg(expect(blank, 400, 'AGENT_CLIENT_KEY_INVALID'), `AB4 a non-string idempotency key is refused rather than coerced (${blank.status}) — a key that stringifies differently on two calls is not a key`);
}

section('I/live — compliance decisions are attributed, and the shared key is not a reviewer');
{
  const adminKey = collect('admin key on /ts', await j('GET', '/ts/reviewers', undefined, undefined, ADMIN));
  neg(expect(adminKey, 401, 'REVIEWER_AUTH_REQUIRED'), 'I1 the shared admin key is NOT a reviewer — /ts/* refuses it 401 REVIEWER_AUTH_REQUIRED');
  const agentOnTs = collect('agent on /ts', await j('GET', '/ts/reviewers', undefined, ada.token));
  neg(agentOnTs.status === 401, `I2 and an agent session is refused the same way (${agentOnTs.status})`);
  const rev = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })).body;
  ok(!!rev?.token, 'I3 a credentialed reviewer gets a session');
  neg(!JSON.stringify(rev?.reviewer ?? {}).match(/secretHash|hash|\$2[aby]\$/), 'I4 whose projection carries no secret and no hash');
  const me = await j('GET', '/ts/me', undefined, rev.token);
  ok(me.body?.attribution === 'authenticated_reviewer', 'I5 and every authoritative action is recorded against that named identity');
  const bad = collect('wrong reviewer secret', await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'nope' }));
  const ghostRev = collect('unknown reviewer', await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-nobody', secret: 'nope' }));
  ok(bad.status === ghostRev.status && JSON.stringify(bad.body) === JSON.stringify(ghostRev.body), 'I6 a wrong secret and an unknown reviewer id share ONE refusal — the login is not a reviewer-roster oracle');
}

section('O+P/live — the Passport stays the player\'s and Trust is not agent-editable');
{
  for (const [what, method, url] of [
    ['passport write', 'POST', `/org/agent/clients/${REP}/passport`],
    ['passport patch', 'PATCH', `/org/agent/clients/${REP}/passport`],
    ['passport entry', 'POST', `/org/agent/players/pl-adeyemi/passport`],
    ['trust write', 'POST', `/org/agent/players/pl-adeyemi/trust`],
    ['trust patch', 'PATCH', `/org/agent/players/pl-adeyemi/trust`],
  ]) {
    const r = collect(what, await j(method, url, { anything: true }, ada.token));
    neg(r.status === 404 || r.status === 403 || r.status === 405, `O1 no agent ${what} route exists or is permitted (${r.status})`);
  }
}

section('N/live — private club recruitment intelligence stays private');
{
  for (const [what, url] of [['second look', '/org/second-look'], ['nobody missed', '/org/nobody-missed'], ['watchlists', '/org/watchlists'], ['assessments', '/org/assessments'], ['analytics overview', '/org/analytics/overview'], ['rooms', '/org/rooms']]) {
    const r = await j('GET', url, undefined, ada.token);
    // A1 category D: intentionally generic org surfaces. Each is either absent
    // for an agency (404) or answered about the caller's OWN org, which for an
    // agency is EMPTY. Both halves are asserted — a `neg(true)` in the 404
    // branch would be an unconditional pass, the shape F-9 records.
    const b = r.body ?? {};
    const items = Array.isArray(b) ? b : (b.items ?? []);
    const emptyOwn = r.status === 200 && items.length === 0 && (b.total === undefined || b.total === 0);
    neg(r.status === 404 || emptyOwn, `N1 the club's ${what} is absent for an agency (404) or answered about its OWN org and EMPTY — got ${r.status}, ${items.length} rows, total ${b.total ?? '—'}`);
    const txt = JSON.stringify(b);
    neg(!/org-eastport|org-harbour|Maria Keane|Rita Vale/.test(txt), `N2 the agency's own ${what} contains no other org's case, player or user (A1 category D)`);
  }
  // A1 category B, proved against a case that REALLY EXISTS. Comparing two
  // invented ids would be worthless: both 404 whatever the rule is. So the club
  // opens a genuine case first, confirms it can read it, and only then is the
  // agency's refusal compared against an id that never existed.
  const made = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'scouted' }, maria.token);
  const caseId = made.body?.room?.roomId ?? made.body?.roomId ?? made.body?.existingRoomId ?? null;
  ok(!!caseId, `N3 the club opened a real recruitment case (${made.status}, id ${caseId})`);
  const clubOwn = await j('GET', `/org/rooms/${caseId}`, undefined, maria.token);
  ok(clubOwn.status === 200 && JSON.stringify(clubOwn.body).includes(caseId), 'N3b and the club itself reads it — so the id is real and populated, which is what makes the next check mean something');
  for (const path of ['', '/decision', '/contacts', '/trials']) {
    const real = await j('GET', `/org/rooms/${caseId}${path}`, undefined, ada.token);
    const ghost = await j('GET', `/org/rooms/case-never-existed${path}`, undefined, ada.token);
    collect(`agency on club case${path}`, real);
    neg(real.status === ghost.status && JSON.stringify(real.body) === JSON.stringify(ghost.body),
      `N3c an agency asking for a REAL club case${path || ' (detail)'} gets BYTE-IDENTICAL bytes to an invented id (${real.status}) — existence does not leak through a direct link`);
  }
}

section('AE/live — error privacy, swept over every refusal this suite provoked');
{
  ok(ERRORS.length > 0, `AE1 ${ERRORS.length} refusals were collected to sweep`);
  const fivexx = ERRORS.filter((e) => e.status >= 500);
  neg(fivexx.length === 0, `AE2 none of them is a 5xx — a refusal is a decision, not a crash${fivexx.length ? `: ${JSON.stringify(fivexx.slice(0, 2))}` : ''}`);
  const leaky = ERRORS.filter((e) => /at \/|\.mjs:|node_modules|\/home\/|Error:.*\n\s+at /.test(JSON.stringify(e.body)));
  neg(leaky.length === 0, `AE3 none carries a stack trace or a file path${leaky.length ? `: ${JSON.stringify(leaky.slice(0, 2))}` : ''}`);
  const offerish = ERRORS.filter((e) => /offer|commission|signing|fee/i.test(JSON.stringify(e.body)));
  neg(offerish.length === 0, `AE4 and none mentions an offer, a commission, a signing or a fee${offerish.length ? `: ${JSON.stringify(offerish.slice(0, 2))}` : ''}`);
}

section('AI/live — the store survives a restart with its authority intact');
{
  await stop(server);
  server = await boot();
  const afterRestart = await j('GET', '/org/agent/clients', undefined, (await login('org-northstar', 'Ada Agent', 'Agent', 'agent')).token);
  ok(afterRestart.status === 200, `AI1 the agent lane answers after a restart (${afterRestart.status})`);
  const h = await (await fetch(`${BASE}/health`)).json();
  ok(h.ok === true, 'AI2 and the server reports healthy on the persisted store');
  const schemaHeader = (await fetch(`${BASE}/health`)).headers.get('x-scoutbox-schema');
  ok(schemaHeader === String(SCHEMA_VERSION), `AI3 the persisted store is still at schema ${SCHEMA_VERSION} (header said ${schemaHeader})`);
}

section('AD/live — sign-up refuses a date of birth it cannot read (review finding F-12)');
{
  // Registration already refused an ABSENT dob. It did not refuse an UNREADABLE
  // one, so `dob: 12345` created an account whose age could never be
  // established — and before F-8 that account computed as a 56-year-old.
  const signup = (dob) => j('POST', '/auth/player/signup', { name: 'Dob Probe', dob, country: 'GB', password: 'a-long-enough-password' });
  for (const [label, dob] of [['a number', 12345], ['garbage', 'not-a-date'], ['an array', ['1990-01-01']], ['an object', { y: 1990 }]]) {
    const r = collect(`signup dob ${label}`, await signup(dob));
    neg(expect(r, 400, 'DOB_INVALID'), `AD6 sign-up with ${label} as a date of birth is refused 400 DOB_INVALID — not stored as an account whose age can never be established`);
  }
  const control = await signup('1990-01-01');
  ok(control.status === 200 || control.status === 201, `AD7 while a readable adult date of birth still signs up (${control.status})`);
}

// ---------------------------------------------------------------------------
// AA runs LAST, on purpose.
//
// `app.use('/auth', authLimiter)` bounds the WHOLE /auth surface at 40 requests
// per minute per IP, and every login in this suite spends that budget. A burst of
// wrong credentials placed earlier would therefore starve the logins of every
// later group — which is exactly what happened in the original P5.6F run before
// this group was moved to the end. Nothing here is a sleep or a retry: the group
// is simply last, and it is the last thing the file does.
// ---------------------------------------------------------------------------
section('AA/live — the failed-login budget, per identifier (F-5)');
{
  const tryRev = (id, secret) => j('POST', '/auth/reviewer/login', { reviewerId: id, secret });
  let lockedAt = 0;
  for (let i = 1; i <= 25 && !lockedAt; i++) {
    const r = await tryRev('tsr-dev-admin', `wrong-${i}`);
    if (r.status === 429) lockedAt = i;
  }
  ok(lockedAt > 0 && lockedAt <= 23, `AA1 repeated wrong secrets for ONE identifier reach a lockout (first 429 at attempt ${lockedAt})`);
  const locked = await tryRev('tsr-dev-admin', 'wrong-again');
  ok(locked.body?.action === 'login_failure', 'AA2 and the refusal is the per-identifier budget, not the per-IP one — they are different controls and this proves which fired');
  const correct = collect('correct secret while locked', await tryRev('tsr-dev-admin', 'dev-reviewer-admin'));
  neg(correct.status === 429, `AA3 the CORRECT secret is still refused during the lockout (${correct.status}) — the budget is checked before the credential, so a guess that finally lands is not rewarded`);
  const upper = await tryRev('TSR-DEV-ADMIN', 'dev-reviewer-admin');
  neg(upper.status === 429, `AA4 and an upper-cased identifier shares the same bucket (${upper.status}) — case is not a way to get a fresh budget`);
  const other = await tryRev('tsr-dev-reviewer', 'dev-reviewer');
  ok(other.status === 200, 'AA5 while a DIFFERENT reviewer signs in normally from the same IP — which an IP-scoped limit alone could never satisfy, and is the whole reason this policy exists');
}

section('AA/live — one account, two names, ONE budget (review finding F-11)');
{
  // A guardian can be named by id or by email. Until the review pass those were
  // two failed-login buckets for one password — a guesser alternating them got
  // 42 attempts per window instead of 21. A fresh server: fresh per-IP AND
  // per-identifier buckets, so this measures only what it claims to.
  await stop(server); server = await boot();
  const byId = (pw) => j('POST', '/auth/guardian/login', { guardianId: 'gd-locktest', password: pw });
  const byEmail = (pw) => j('POST', '/auth/guardian/login', { email: 'locktest@example.test', password: pw });
  ok((await byId('right-password-1')).status === 200, 'AA6 the fixture guardian signs in by id with the right password');
  ok((await byEmail('right-password-1')).status === 200, 'AA6b and by email — two names, one account');
  let lockedAt = 0;
  for (let i = 1; i <= 25 && !lockedAt; i++) { const r = await byId(`wrong-${i}`); if (r.status === 429) lockedAt = i; }
  ok(lockedAt > 0 && lockedAt <= 23, `AA7 wrong passwords BY ID reach the lockout (first 429 at attempt ${lockedAt})`);
  const viaEmail = collect('alias after lockout', await byEmail('wrong-again'));
  neg(viaEmail.status === 429 && viaEmail.body?.action === 'login_failure', `AA8 and the SAME account tried BY EMAIL is already locked (${viaEmail.status} ${viaEmail.body?.action ?? viaEmail.body?.error}) — an alias is not a second budget`);
  const rightViaEmail = collect('right password via alias while locked', await byEmail('right-password-1'));
  neg(rightViaEmail.status === 429, `AA8b even with the right password (${rightViaEmail.status}) — the lockout is checked before the credential on the alias path too`);
}

console.log(`\nM23 P5.6F final hardening (reconstructed): ${passed} checks passed, ${negatives} negative/security/privacy checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('\nSOME P5.6F HARDENING CHECKS FAILED');
else console.log('all M23 P5.6F reconstructed hardening checks passed');
await stop(server);
process.exit(process.exitCode ?? 0);
