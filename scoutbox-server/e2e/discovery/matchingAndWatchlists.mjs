// Explainable Matching and Dynamic Watchlists battery.
//
// Matching answers exactly two questions and refuses the third:
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
// The pure engines, the vocabulary and the declared tables (§1–§9b) are checked in
// scripts/rules/discovery/matchingAndWatchlists.mjs; this battery is the HTTP half
// (§10–§22) and a second boot (§23). The abuse cases checked there are RULES_ABUSE below.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../support/sqlFixture.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import criteriaSpec from '../support/spec/discovery/matching/criteria.json' with { type: 'json' };
import schemasSpec from '../support/spec/discovery/schemas.json' with { type: 'json' };

const { MATCH_POLICY_VERSION, CRITERIA_SCHEMA_VERSION, LIMITS } = criteriaSpec;
const { MATCH_SORTS, DEFAULT_MATCH_SORT } = schemasSpec;

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m19-'));

let passed = 0;
let negatives = 0;
const seenAbuse = new Set();
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
/** A numbered abuse case (A1–A60), or one check that proves several; the summary checks every number was exercised. */
const abuse = (n, cond, msg) => {
  const ns = [n].flat();
  for (const x of ns) seenAbuse.add(x);
  neg(cond, `${ns.map((x) => `A${x}`).join(' ')} — ${msg}`);
};
/** A numbered positive case: the feature works, with everything above true. */
const expect = (n, cond, msg) => ok(cond, `E${n} — ${msg}`);
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ HTTP boot
section('§10 — a clean database boots with matching in place');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
};
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
async function boot(env, base) {
  const proc = spawn(...serverCommand(), { cwd: serverDir, env, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
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
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
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
ok(
  [maria, tom, rita, dee, nia, kola].every((x) => x?.token),
  'HTTP actors logged in',
);
{
  const h = await j('GET', '/healthz');
  ok(
    h.body.schemaVersion === SCHEMA_VERSION,
    `/healthz reports schema ${SCHEMA_VERSION} with the matching migration applied`,
  );
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
  const grass = await j('GET', '/org/matching/vocabulary', undefined, dee.token);
  expect(
    1,
    grass.status === 200 && grass.body.criterionTypes.length === 11 && grass.body.operators.length === 8,
    'a Grassroots club can read every criterion type and operator ScoutBox can evaluate',
  );
  neg(
    v.status === 200 &&
      v.body.criterionTypes.length === 10 &&
      !v.body.criterionTypes.some((c) => c.type === 'geography'),
    'a Pro club is not offered a distance criterion, which it cannot see',
  );
  ok(
    v.body.policyVersion === MATCH_POLICY_VERSION && v.body.schemaVersion === CRITERIA_SCHEMA_VERSION,
    'the vocabulary declares its policy and schema versions',
  );
  ok(
    v.body.combineProtocols.length > 0 && v.body.availabilityValues.length > 0,
    'the Combine protocols and availability values are published, so nothing has to be guessed',
  );
  abuse(
    59,
    /no hidden criterion/i.test(v.body.note) &&
      !/weight|score/i.test(v.body.note.replace(/no weighting|match score/gi, '')),
    'the vocabulary says out loud that there is no hidden criterion and no weighting',
  );
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
  expect(
    2,
    m.status === 200 && m.body.items.length > 0,
    `matching returns the visible candidates that satisfy the criteria (${EASTPORT_TOTAL})`,
  );
  expect(
    3,
    m.body.items.every((i) => i.required.length > 0 && i.required.every((r) => r.met && r.text)),
    'every player on the list carries a met explanation for every required criterion',
  );
  ok(
    m.headers.get('x-scoutbox-ordering') === `${DEFAULT_MATCH_SORT},player_id`,
    'the response declares the ordering it used',
  );
  ok(
    m.body.ordering === m.headers.get('x-scoutbox-ordering'),
    'the declared ordering is in the body as well as the header',
  );
  ok(
    m.body.criteriaVersion.startsWith('cv1:') && m.body.policyVersion === MATCH_POLICY_VERSION,
    'the answer is stamped with the criteria and policy it was computed under',
  );
  neg(/no match score/i.test(m.body.scoreNote), 'the payload states that there is no match score');
  const json = JSON.stringify(m.body);
  abuse(
    38,
    !/"score"|"rank"|"rating"|"percentile"|"tier"|"fit"/.test(json),
    'no scoring field anywhere in the matching payload',
  );
  abuse(
    1,
    !/best match|recommended|should sign|top prospect/i.test(json),
    'no recommending language anywhere in the matching payload',
  );

  const cdm = await j('POST', '/org/matching', q(CDM), maria.token);
  expect(
    4,
    cdm.body.items.every((i) => i.position === 'CDM' || (i.secondaryPositions ?? []).includes('CDM')),
    'a position criterion returns only players who actually play it',
  );
  neg(cdm.body.total < EASTPORT_TOTAL, 'a narrower criteria set returns fewer players, not the same list re-ordered');

  const withPreferred = await j(
    'POST',
    '/org/matching',
    {
      criteria: {
        required: [{ type: 'position', operator: 'in', values: ['CDM'] }],
        preferred: [{ type: 'foot', operator: 'in', values: ['Left'] }],
      },
    },
    maria.token,
  );
  expect(
    5,
    withPreferred.body.total === cdm.body.total && withPreferred.body.items.every((i) => i.preferredTotal === 1),
    'adding a preferred criterion changes the explanation, never the membership',
  );
  abuse(
    40,
    withPreferred.body.items.some((i) => i.preferredMet === 0),
    'a player who meets none of the preferred criteria is still on the list, and still explained',
  );
  {
    // The list must NOT come back sorted by how many preferred criteria each
    // player met — that would be the ranking matching refuses to produce, arrived
    // at by the back door.
    const counts = withPreferred.body.items.map((i) => i.preferredMet);
    const byPreferred = [...counts].sort((a, b) => b - a);
    const varied = new Set(counts).size > 1;
    abuse(
      50,
      !varied || JSON.stringify(counts) !== JSON.stringify(byPreferred),
      'the returned order is NOT the preferred-criteria count in disguise',
    );
  }
}

// ====================== §13 authorization runs BEFORE matching, always
section('§13 — the candidate universe is authorization, not a filter over everyone');
{
  const east = await j('POST', '/org/matching', ANY_AGE, maria.token);
  const harbour = await j('POST', '/org/matching', ANY_AGE, rita.token);
  const grass = await j('POST', '/org/matching', ANY_AGE, dee.token);
  expect(
    6,
    east.body.total !== harbour.body.total && grass.body.total < harbour.body.total,
    `each organisation matches over its OWN visible universe (${east.body.total} / ${harbour.body.total} / ${grass.body.total})`,
  );
  const eastNames = new Set(east.body.items.map((i) => i.name));
  const harbourNames = new Set(harbour.body.items.map((i) => i.name));
  // Authorisation decides the candidates before any criterion is read: a player hidden from a club is not a
  // candidate there, so no criterion can surface them and no total counts them.
  abuse(
    [60, 54, 55],
    [...harbourNames].every((n) => eastNames.has(n)) &&
      [...eastNames].some((n) => !harbourNames.has(n)) &&
      harbour.body.total === harbour.body.items.length,
    'a player one club may see and another may not is simply absent from the second club’s answer, and from its total',
  );
  abuse(
    24,
    !JSON.stringify(east.body).includes('consideredVisible') || typeof east.body.consideredVisible !== 'number',
    'no field reports how many players were considered as a raw count of the database',
  );
  abuse(
    3,
    !/"dob"|"guardian"|"medical"|"email"|"phone"/i.test(JSON.stringify(east.body)),
    'a match card carries nothing the projection already strips',
  );

  // The grassroots club is the only one authorised to see distance.
  abuse(
    35,
    east.body.items.every((i) => i.distanceKm === null),
    'a Pro club is not handed a distance it is not authorised to see',
  );
  ok(
    grass.body.items.every((i) => typeof i.distanceKm === 'number'),
    'the grassroots club, which is authorised, does see distance',
  );
  const sortAsPro = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'distance' }), maria.token);
  abuse(
    35,
    sortAsPro.status === 400 && sortAsPro.body.error === 'SORT_NOT_AVAILABLE',
    'ordering by distance is refused where distance is not authorised — the ordering cannot leak what the field does not',
  );
  const sortAsGrass = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'distance' }), dee.token);
  ok(sortAsGrass.status === 200, 'the same ordering is available where distance IS authorised');

  const foreignBrief = await j(
    'POST',
    '/org/recruitment-briefs',
    { title: 'Harbour only', positions: ['CB'] },
    rita.token,
  );
  ok(foreignBrief.status === 201, 'fixture: another organisation writes a brief');
  const stolen = await j('POST', '/org/matching', { briefId: foreignBrief.body.brief.id }, maria.token);
  abuse(
    60,
    stolen.status === 404 && stolen.body.error === 'BRIEF_NOT_FOUND',
    'another organisation’s brief id is NOT FOUND, not forbidden — a 403 would confirm it exists',
  );
  const noAuth = await j('POST', '/org/matching', ANY_AGE);
  neg(noAuth.status === 401, 'matching without a session is refused');
  const asPlayer = await j('POST', '/org/matching', ANY_AGE, kola.token);
  abuse(
    53,
    asPlayer.status === 401 || asPlayer.status === 403,
    'a player cannot run matching, so no player can learn who is matching on them',
  );
}

// ================================================= §14 refusals over HTTP
section('§14 — a criteria refusal is an answer the editor can act on');
{
  const proRadius = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'geography', operator: 'within_radius', value: 30 }] } },
    maria.token,
  );
  neg(
    proRadius.status === 400 && proRadius.body.details?.[0]?.error === 'CRITERION_NOT_AVAILABLE',
    'IN5 a Pro club asking for players within a distance is refused: it cannot see distance, so it would match nobody',
  );
  const grassRadius = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'geography', operator: 'within_radius', value: 30 }] } },
    dee.token,
  );
  ok(grassRadius.status === 200, 'IN6 a Grassroots club may ask for players within a distance');
  const stray = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'age', operator: 'gte', value: 16, weight: 5 }] } },
    maria.token,
  );
  neg(
    stray.status === 400 &&
      stray.body.field === 'criteria.required[0].weight' &&
      stray.body.problem === 'unknown_field',
    'IN7 a criterion carrying a weight is refused, naming it: there are no weights',
  );
  const prohibited = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'ethnicity', operator: 'in', values: ['x'] }] } },
    maria.token,
  );
  abuse(
    25,
    prohibited.status === 400 &&
      prohibited.body.error === 'CRITERION_PROHIBITED' &&
      prohibited.body.prohibited.includes('ethnicity'),
    'a protected characteristic is refused over HTTP, by name, with its own code',
  );
  const unknownOp = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'age', operator: 'sql', value: 1 }] } },
    maria.token,
  );
  abuse(
    6,
    unknownOp.status === 400 && unknownOp.body.details[0].error === 'CRITERION_OPERATOR_UNKNOWN',
    'an unknown operator is refused over HTTP',
  );
  const injection = await j(
    'POST',
    '/org/matching',
    { criteria: { required: [{ type: 'position', operator: 'in', values: ["CDM'; DROP TABLE"] }] } },
    maria.token,
  );
  abuse(
    9,
    injection.status === 400,
    'a value crafted to look like an injection is refused as an unknown position, not interpreted',
  );
  const huge = await j(
    'POST',
    '/org/matching',
    { criteria: { required: Array.from({ length: 60 }, () => ({ type: 'age', operator: 'gte', value: 16 })) } },
    maria.token,
  );
  abuse(
    27,
    huge.status === 400 && huge.body.error === 'CRITERIA_TOO_MANY',
    'an oversized criteria set is refused before it is evaluated',
  );
  const nothing = await j('POST', '/org/matching', { criteria: { required: [], preferred: [] } }, maria.token);
  ok(nothing.status === 200, 'an empty criteria set is a legal question over the visible universe');
  abuse(
    28,
    nothing.body.total === EASTPORT_TOTAL && nothing.body.criteria.required.length === 0,
    'and it returns exactly the visible universe — no criteria is not "everyone on the platform"',
  );
}

// ====================================== §15 ordering, paging, truncation
section('§15 — ordering and paging are deterministic');
{
  for (const sort of MATCH_SORTS.filter((s) => s !== 'distance')) {
    const a = await j('POST', '/org/matching', q(ANY_AGE_C, { sort }), maria.token);
    const b = await j('POST', '/org/matching', q(ANY_AGE_C, { sort }), maria.token);
    ok(
      JSON.stringify(a.body.items.map((i) => i.playerId)) === JSON.stringify(b.body.items.map((i) => i.playerId)),
      `${sort}: two identical reads return the same order`,
    );
  }
  const byName = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'name' }), maria.token);
  const names = byName.body.items.map((i) => i.name);
  ok(
    JSON.stringify(names) === JSON.stringify([...names].sort((x, y) => x.localeCompare(y))),
    'name ordering really is by name',
  );
  const bogus = await j('POST', '/org/matching', q(ANY_AGE_C, { sort: 'best_match' }), maria.token);
  abuse(
    50,
    bogus.status === 400 &&
      bogus.body.field === 'sort' &&
      bogus.body.problem === 'not_allowed' &&
      JSON.stringify(bogus.body.allowed) === JSON.stringify(MATCH_SORTS),
    'asking for an ordering called "best_match" is refused with the orderings that exist, because no such ordering exists',
  );
  // Matching pages by cursor, so a page is one query and only its players are decoded.
  const p1 = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 3 }), maria.token);
  const p2 = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 3, cursor: p1.body.nextCursor }), maria.token);
  expect(
    7,
    p1.body.items.length === 3 &&
      typeof p1.body.nextCursor === 'string' &&
      p2.body.items.length > 0 &&
      p1.body.total === p2.body.total &&
      !p1.body.items.some((a) => p2.body.items.some((b) => b.playerId === a.playerId)),
    'paging is stable: the total is the same and no player appears on two pages',
  );
  const negOffset = await j('POST', '/org/matching', q(ANY_AGE_C, { offset: -50 }), maria.token);
  neg(
    negOffset.status === 400 && negOffset.body.error === 'PAGE_OFFSET_UNSUPPORTED',
    'an offset is refused (the list pages by cursor), never used to read backwards',
  );
  const forged = await j('POST', '/org/matching', q(ANY_AGE_C, { cursor: 'not-a-cursor' }), maria.token);
  neg(
    forged.status === 400 && forged.body.error === 'PAGE_CURSOR_INVALID',
    'a cursor this list did not hand out is refused',
  );
  const hugeLimit = await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 100000 }), maria.token);
  neg(
    hugeLimit.status === 400 && hugeLimit.body.error === 'PAGE_LIMIT_INVALID',
    'an enormous page size is refused (400), never served',
  );
}

// ======================================= §16 watchlists: create and mode
section('§16 — a Dynamic Watchlist is saved criteria, and the mode is chosen');
let WL = null;
let BRIEF = null;
{
  const noName = await j('POST', '/org/watchlists', { mode: 'snapshot', criteria: CDM }, maria.token);
  neg(
    noName.status === 400 && noName.body.error === 'WATCHLIST_NAME_REQUIRED',
    'a watchlist without a name is refused',
  );
  const noMode = await j('POST', '/org/watchlists', { name: 'X', criteria: CDM }, maria.token);
  abuse(
    46,
    noMode.status === 400 && noMode.body.error === 'WATCHLIST_MODE_REQUIRED',
    'the mode is never inferred: a club is asked whether the list follows a brief or keeps its own criteria',
  );
  const emptyRequired = await j(
    'POST',
    '/org/watchlists',
    { name: 'X', mode: 'snapshot', criteria: { required: [], preferred: [] } },
    maria.token,
  );
  abuse(
    8,
    emptyRequired.status === 400 && emptyRequired.body.error === 'CRITERIA_REQUIRED_EMPTY',
    'a saved watchlist with no required criterion is refused — it would silently mean "everyone"',
  );
  const liveWithoutBrief = await j(
    'POST',
    '/org/watchlists',
    { name: 'X', mode: 'live_linked', criteria: CDM },
    maria.token,
  );
  abuse(
    46,
    liveWithoutBrief.status === 400 && liveWithoutBrief.body.error === 'WATCHLIST_MODE_INVALID',
    'only a watchlist linked to a brief can follow one live',
  );

  // A field of the wrong type is refused, naming it, rather than read as the default or cut down.
  const junk = async (body) =>
    (await j('POST', '/org/watchlists', { name: 'Junk', mode: 'snapshot', criteria: CDM, ...body }, maria.token)).body;
  neg(
    (await junk({ notify: 'no' })).field === 'notify',
    'a notify that is not true or false is refused, not read as "on"',
  );
  neg(
    (await junk({ sourceType: 'spreadsheet' })).error === 'WATCHLIST_SOURCE_UNKNOWN',
    'an unknown source type is refused, not read as saved criteria',
  );
  neg(
    (await junk({ sourceId: { id: 'x' } })).field === 'sourceId',
    'a source reference that is not short text is refused, not stored as it came',
  );
  neg(
    (await j('GET', '/org/watchlists?status=deleted', undefined, maria.token)).body.error ===
      'WATCHLIST_STATUS_UNKNOWN',
    'an unknown status filter is refused, not answered with an empty list',
  );
  {
    const before = (await j('GET', '/org/watchlists?status=active', undefined, maria.token)).body.total;
    const long = await junk({ name: 'W'.repeat(81) });
    const forged = await junk({ orgId: 'org-harbour' });
    const ageAsText = await junk({ criteria: { required: [{ type: 'age', operator: 'gte', value: '16' }] } });
    const after = (await j('GET', '/org/watchlists?status=active', undefined, maria.token)).body.total;
    neg(
      long.error === 'FIELD_INVALID' && long.field === 'name' && long.problem === 'too_long' && long.max === 80,
      'IN1 a watchlist name over 80 characters is refused, not cut down',
    );
    neg(
      forged.field === 'orgId' && forged.problem === 'unknown_field',
      'IN2 a watchlist naming its own organisation is refused: the organisation is the session’s',
    );
    neg(
      ageAsText.error === 'CRITERIA_INVALID' && ageAsText.details?.[0]?.error === 'CRITERION_VALUE_OUT_OF_RANGE',
      'IN3 an age written as text is refused, not read as the number it spells',
    );
    neg(before === after, 'IN4 and none of those refusals made a watchlist');
  }

  const created = await j(
    'POST',
    '/org/watchlists',
    { name: '2027 Defensive Midfielders', mode: 'snapshot', criteria: MIDFIELD },
    maria.token,
  );
  WL = created.body.watchlist;
  expect(
    8,
    created.status === 201 && WL.criteriaVersion.startsWith('cv1:') && WL.status === 'active' && WL.mode === 'snapshot',
    'a club saves its criteria as a Dynamic Watchlist',
  );
  ok(WL.createdBy === 'Maria Keane', 'the person who wrote it is attributed');
  abuse(
    47,
    !('members' in WL) && !('playerIds' in WL) && !('players' in WL),
    'the saved record holds CRITERIA, never a stored list of players treated as truth',
  );

  BRIEF = (
    await j(
      'POST',
      '/org/recruitment-briefs',
      { title: 'Left-sided CDM 2027', positions: ['CDM'], minAge: 16, maxAge: 30 },
      maria.token,
    )
  ).body.brief;
  ok(!!BRIEF?.id, 'fixture: a Recruitment Brief exists');
  const linked = await j(
    'POST',
    '/org/watchlists',
    { name: 'Follows the brief', mode: 'live_linked', sourceType: 'brief', briefId: BRIEF.id },
    maria.token,
  );
  expect(
    9,
    linked.status === 201 &&
      linked.body.watchlist.mode === 'live_linked' &&
      linked.body.watchlist.sourceId === BRIEF.id,
    'a watchlist can instead FOLLOW a Recruitment Brief, and says so',
  );
  const editLinked = await j(
    'PATCH',
    `/org/watchlists/${linked.body.watchlist.id}`,
    { criteria: CDM, expectedRev: linked.body.watchlist.rev },
    maria.token,
  );
  abuse(
    46,
    editLinked.status === 409 && editLinked.body.error === 'WATCHLIST_LIVE_LINKED',
    'editing the criteria of a live-linked watchlist is refused, with the two honest options named',
  );
}

// ============================ §17 membership is derived, and explained
section('§17 — membership is derived on read, with the transitions explained');
{
  const first = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  expect(
    10,
    first.status === 200 && first.body.items.length > 0 && first.body.summary.newlyMatched === first.body.items.length,
    'the first read derives membership and reports every member as newly matched',
  );
  neg(
    /derived when this page is read/i.test(first.body.refreshNote) &&
      /does not recompute .* in the background/i.test(first.body.refreshNote),
    'the payload states plainly that nothing recomputes in the background in this build',
  );
  ok(typeof first.body.evaluatedAt === 'number', 'the derivation is timestamped, so the UI can say when');

  const second = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  const h1 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  const h2 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  abuse(
    44,
    h1.body.total === h2.body.total && h1.body.total === first.body.items.length,
    'the same transition is recorded exactly once however many times it is observed',
  );
  // The summary is the last RECORDED change, not this read's diff. A diff
  // would be consumed by whoever read first — a background refetch would tell
  // the person at the screen that nothing changed when two players had left.
  abuse(
    44,
    JSON.stringify(second.body.summary) === JSON.stringify(first.body.summary),
    'two reads of the same watchlist tell the same story, so a refetch cannot swallow the change',
  );
  ok(
    second.body.summary.changedAt === first.body.evaluatedAt || typeof second.body.summary.changedAt === 'number',
    'the summary says WHEN the change it reports happened',
  );
  expect(
    11,
    h1.body.items.every((x) => x.reason && x.text && x.criteriaVersion && x.transition),
    'the history says WHY each player entered or left, in the club’s own criteria',
  );
  abuse(
    49,
    !/better|worse|improved|declined|talent|potential|score/i.test(JSON.stringify(h1.body)),
    'nothing in the history says a player got better or worse',
  );
  neg(/not an improvement in a player/i.test(h1.body.note), 'and the history says so out loud');

  // Narrow the criteria: the players who no longer qualify LEAVE, with a reason.
  const narrowed = await j('PATCH', `/org/watchlists/${WL.id}`, { criteria: CDM, expectedRev: WL.rev }, maria.token);
  ok(narrowed.status === 200, 'the criteria of a saved-criteria watchlist can be edited');
  const after = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  expect(
    12,
    after.body.summary.noLongerMatches > 0 && after.body.total < first.body.total,
    'tightening the criteria removes the players who no longer satisfy them',
  );
  const h3 = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  abuse(
    45,
    h3.body.items.filter((x) => x.transition === 'left').every((x) => x.reason === 'criteria_changed'),
    'they left because the CRITERIA changed, and the history says that rather than blaming the player',
  );
  const badCursor = await j('GET', `/org/watchlists/${WL.id}/history?cursor=nope`, undefined, maria.token);
  neg(
    badCursor.status === 400 && badCursor.body.error === 'HISTORY_CURSOR_INVALID',
    'a fabricated history cursor is refused, not silently ignored',
  );
  // The transitions page by cursor: two pages hold every transition once, newest first.
  const pg1 = await j('GET', `/org/watchlists/${WL.id}/history?limit=1`, undefined, maria.token);
  const pg2 = await j(
    'GET',
    `/org/watchlists/${WL.id}/history?limit=100&cursor=${pg1.body.nextCursor}`,
    undefined,
    maria.token,
  );
  ok(
    pg1.body.items.length === 1 &&
      typeof pg1.body.nextCursor === 'string' &&
      pg2.status === 200 &&
      [...pg1.body.items, ...pg2.body.items].map((x) => x.id).join() === h3.body.items.map((x) => x.id).join() &&
      pg2.body.nextCursor === null,
    'the history pages: the second page continues exactly where the first stopped',
  );
  neg(
    (await j('GET', `/org/watchlists/${WL.id}/history?limit=abc`, undefined, maria.token)).body.error ===
      'PAGE_LIMIT_INVALID',
    'a junk page size is refused, not clamped',
  );
  const wl1 = await j('GET', '/org/watchlists?limit=1', undefined, maria.token);
  const wl2 = await j('GET', `/org/watchlists?limit=100&cursor=${wl1.body.nextCursor}`, undefined, maria.token);
  ok(
    wl1.body.items.length === 1 &&
      typeof wl1.body.total === 'number' &&
      new Set([...wl1.body.items, ...wl2.body.items].map((w) => w.id)).size === wl1.body.total,
    'the watchlist list pages too, every watchlist exactly once',
  );
}

// ================================= §18 concurrency, lifecycle and limits
section('§18 — the shared write contract applies to watchlists too');
{
  const cur = (await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token)).body.watchlist;
  const stale = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Stale write', expectedRev: 1 }, tom.token);
  neg(
    stale.status === 409 && stale.body.error === 'WATCHLIST_VERSION_CONFLICT',
    'a write built on a stale read is refused',
  );
  neg(
    !!stale.body.updatedBy || !!stale.body.current,
    'and the refusal says what the current state is, so the person can merge',
  );
  const fresh = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Renamed', expectedRev: cur.rev }, tom.token);
  ok(fresh.status === 200 && fresh.body.watchlist.name === 'Renamed', 'a write built on a current read succeeds');

  const paused = await j(
    'PATCH',
    `/org/watchlists/${WL.id}`,
    { status: 'paused', expectedRev: fresh.body.watchlist.rev },
    maria.token,
  );
  ok(paused.status === 200, 'a watchlist can be paused');
  const whilePaused = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  neg(
    whilePaused.body.watchlist.blocked?.paused === true && whilePaused.body.items.length > 0,
    'a paused watchlist still SHOWS its membership — pausing stops notifications, not the answer',
  );
  const resumed = await j(
    'PATCH',
    `/org/watchlists/${WL.id}`,
    { status: 'active', expectedRev: whilePaused.body.watchlist.rev },
    maria.token,
  );
  ok(resumed.status === 200, 'and it can be resumed');
  const archived = await j(
    'PATCH',
    `/org/watchlists/${WL.id}`,
    { status: 'archived', expectedRev: resumed.body.watchlist.rev },
    maria.token,
  );
  ok(archived.status === 200, 'a watchlist can be archived');
  const reopen = await j(
    'PATCH',
    `/org/watchlists/${WL.id}`,
    { status: 'active', expectedRev: archived.body.watchlist.rev },
    maria.token,
  );
  abuse(
    43,
    45,
    reopen.status === 409 && reopen.body.error === 'WATCHLIST_ARCHIVED',
    'an archived watchlist is not reopened',
  );
  const archivedRead = await j('GET', `/org/watchlists/${WL.id}`, undefined, maria.token);
  abuse(
    43,
    archivedRead.body.watchlist.blocked?.blocked === true &&
      archivedRead.body.items.length === 0 &&
      /archived/i.test(archivedRead.body.watchlist.blocked.message),
    'an archived watchlist shows a stated reason, never an empty list presented as "no players match"',
  );
  const historyKept = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, maria.token);
  neg(historyKept.body.total > 0, 'archiving keeps the history it already recorded');
  const badStatus = await j(
    'PATCH',
    `/org/watchlists/${WL.id}`,
    { status: 'deleted', expectedRev: archivedRead.body.watchlist.rev },
    maria.token,
  );
  neg(badStatus.status === 400 && badStatus.body.error === 'WATCHLIST_STATUS_UNKNOWN', 'an invented status is refused');
}

// ============================================ §19 tenant isolation, hard
section('§19 — tenant isolation is absolute');
{
  const mine = (await j('GET', '/org/watchlists', undefined, maria.token)).body;
  const theirs = (await j('GET', '/org/watchlists', undefined, rita.token)).body;
  abuse(
    60,
    mine.items.length > 0 && theirs.items.length === 0,
    'a watchlist list holds only this organisation’s own watchlists',
  );
  const stolenRead = await j('GET', `/org/watchlists/${WL.id}`, undefined, rita.token);
  abuse(
    60,
    stolenRead.status === 404 && stolenRead.body.error === 'WATCHLIST_NOT_FOUND',
    'another organisation’s watchlist id is NOT FOUND — the same answer a nonexistent id gets',
  );
  const stolenWrite = await j('PATCH', `/org/watchlists/${WL.id}`, { name: 'Hijacked', expectedRev: 1 }, rita.token);
  abuse(
    60,
    stolenWrite.status === 404,
    'and a write to it is not found either — the 404 comes before the concurrency check',
  );
  const stolenHistory = await j('GET', `/org/watchlists/${WL.id}/history`, undefined, rita.token);
  abuse(60, stolenHistory.status === 404, 'and its history is not readable either');
  const stolenRoom = await j('POST', `/org/watchlists/${WL.id}/room`, { playerId: 'pl-adeyemi' }, rita.token);
  abuse(60, stolenRoom.status === 404, 'and the Room bridge on it is not reachable either');
  const asPlayer = await j('GET', '/org/watchlists', undefined, kola.token);
  abuse(
    53,
    asPlayer.status === 401 || asPlayer.status === 403,
    'a player cannot list watchlists — a player is never told they are on one',
  );
  const anon = await j('GET', '/org/watchlists');
  neg(anon.status === 401, 'and neither can an anonymous caller');
}

// ==================================================== §20 the Room bridge
section('§20 — the Room bridge is the canonical Room creator, not a second one');
{
  const wl = (await j('POST', '/org/watchlists', { name: 'Bridge test', mode: 'snapshot', criteria: CDM }, maria.token))
    .body.watchlist;
  const members = (await j('GET', `/org/watchlists/${wl.id}`, undefined, maria.token)).body.items;
  ok(members.length > 0, 'fixture: the bridge watchlist has members');
  const first = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: members[0].playerId }, maria.token);
  ok([200, 201].includes(first.status) && first.body.roomId, 'a member can be taken into a Recruitment Room');
  neg(
    /stays on the watchlist/i.test(first.body.note),
    'and the answer says the player stays on the watchlist while they still match',
  );
  const again = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: members[0].playerId }, maria.token);
  abuse(
    44,
    again.status === 200 && again.body.existed === true && again.body.roomId === first.body.roomId,
    'doing it twice is idempotent — the same Room, not a second one',
  );
  const stillThere = (await j('GET', `/org/watchlists/${wl.id}`, undefined, maria.token)).body.items;
  abuse(
    43,
    stillThere.some((i) => i.playerId === members[0].playerId),
    'and the player is still on the watchlist: being evaluated is not a reason to stop tracking whether they match',
  );
  const ghost = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: 'pl-does-not-exist' }, maria.token);
  neg(ghost.status === 404 && ghost.body.error === 'PLAYER_NOT_FOUND', 'a player id that does not exist is not found');
  const invisible = await j('POST', `/org/watchlists/${wl.id}/room`, { playerId: 'pl-guni' }, rita.token);
  abuse(
    60,
    invisible.status === 404,
    'and a bridge call from the wrong organisation never reaches the visibility check at all',
  );
}

// ================================================= §21 limits and quotas
section('§21 — pathological use is bounded');
{
  const before = (await j('GET', '/org/watchlists', undefined, nia.token)).body.total;
  let refused = null;
  for (let i = 0; i < LIMITS.watchlistsPerOrg + 2 - before; i++) {
    const r = await j('POST', '/org/watchlists', { name: `bulk ${i}`, mode: 'snapshot', criteria: CDM }, nia.token);
    if (r.status === 409) {
      refused = r;
      break;
    }
    if (r.status === 429) {
      refused = r;
      break;
    }
  }
  abuse(
    27,
    !!refused && ['WATCHLIST_LIMIT_REACHED', 'RATE_LIMITED'].includes(refused.body.error),
    'a club cannot create unbounded watchlists — the cap or the rate limit stops it, with a message that says what to do',
  );
  if (refused?.body?.error === 'WATCHLIST_LIMIT_REACHED')
    neg(/archive/i.test(refused.body.message), 'the cap message names the way out');
  else neg(refused?.body?.action === 'watchlist_write', 'the rate-limit refusal names the action it limited');
}

// ============================================ §22 nothing reaches a player
section('§22 — no player, guardian or public surface learns any of this');
{
  const notif = await j('GET', '/player/notifications', undefined, kola.token);
  const text = JSON.stringify(notif.body ?? {});
  abuse(
    53,
    !/watchlist|matching|criteria|matched/i.test(text),
    'a player’s own notifications never mention a watchlist, a criteria set, or being matched',
  );
  for (const p of ['/player/watchlists', '/player/matching', '/public/matching', '/org/watchlists/all']) {
    const r = await j('GET', p, undefined, kola.token);
    abuse(
      53,
      r.status === 404 || r.status === 401 || r.status === 403,
      `${p} does not exist as a player-reachable surface`,
    );
  }
  const passport = await j('GET', '/player/football-passport', undefined, kola.token);
  abuse(
    53,
    !/watchlist|dynamic list/i.test(JSON.stringify(passport.body ?? {})),
    'a player’s Passport says nothing about club watchlists',
  );
}

// ============================== §23 restart: derived state, not stored truth
section('§22b — matching answers its own question, and nothing in it is a score');
{
  const ids = async (body) =>
    ((await j('POST', '/org/matching', body, maria.token)).body.items ?? []).map((i) => i.playerId ?? i.id);
  const all = await ids(q(ANY_AGE_C, { limit: 100 }));
  ok(all.length >= 3, `fixture: the club matches several players (${all.length})`);
  // Dismissed in Nobody Missed for a brief: still a match, because matching answers a different question.
  const brief = await j(
    'POST',
    '/org/recruitment-briefs',
    { title: 'Z anyone', positions: ['CDM', 'CM', 'ST'] },
    maria.token,
  );
  const dismissed = await j(
    'POST',
    '/org/nobody-missed/dismiss',
    { briefId: brief.body?.brief?.id, playerId: all[0] },
    maria.token,
  );
  abuse(
    41,
    dismissed.status === 200 && (await ids(q(ANY_AGE_C, { limit: 100 }))).join() === all.join(),
    `a player dismissed in Nobody Missed is still matched, in the same place (${dismissed.status} ${dismissed.body?.error ?? ''})`,
  );
  // Preferred criteria are counted and explained, never used to reorder.
  const withPreferred = await ids({
    criteria: { ...ANY_AGE_C, preferred: [{ type: 'position', operator: 'in', values: ['CDM'] }] },
    limit: 100,
  });
  neg(withPreferred.join() === all.join(), 'adding preferred criteria leaves the order exactly as it was');
  // No score, ranking or verdict is served, under any name.
  const served = JSON.stringify((await j('POST', '/org/matching', q(ANY_AGE_C, { limit: 100 }), maria.token)).body);
  const named = [
    /AI Match Score/i,
    /Talent Score/i,
    /Potential Score/i,
    /Recruitability/i,
    /ScoutBox Rating/i,
    /\bBest Match\b/i,
    /Recommended Player/i,
  ].filter((re) => re.test(served));
  abuse(
    52,
    named.length === 0,
    `the matching response names no score, rating or recommendation (${named.map(String).join(', ') || 'none'})`,
  );
  // The audit log keeps watchlist lifecycle only; membership churn stays in the watchlist's own history.
  const actions = new Set();
  for (let cursor = null, page = 0; page < 40; page += 1) {
    const r = await j(
      'GET',
      `/org/audit?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined,
      maria.token,
    );
    for (const e of r.body.items) actions.add(e.action);
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  abuse(
    45,
    actions.has('watchlist_created') && !actions.has('watchlist_membership_changed'),
    'the audit log records watchlists being made, never players entering or leaving them',
  );
  // Trust & Safety has no routine watchlist access.
  const admin = await j('GET', '/admin/watchlists', undefined, undefined, {
    'x-admin-key': process.env.ADMIN_KEY ?? 'scoutbox-admin',
  });
  abuse(34, admin.status === 404, `there is no admin route to a club's watchlists (${admin.status})`);
}

section('§23 — a restart changes nothing about what a watchlist means');
{
  const before = (await j('GET', '/org/watchlists', undefined, maria.token)).body;
  const beforeDetail = (
    await j('GET', `/org/watchlists/${before.items.find((w) => w.status === 'active').id}`, undefined, maria.token)
  ).body;
  serverProc.kill('SIGKILL');
  await sleep(400);
  serverProc = await boot(ENV, BASE);
  const maria2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const after = (await j('GET', '/org/watchlists', undefined, maria2.token)).body;
  ok(after.total === before.total, 'every watchlist survives the restart');
  const afterDetail = (await j('GET', `/org/watchlists/${beforeDetail.watchlist.id}`, undefined, maria2.token)).body;
  ok(
    JSON.stringify(afterDetail.items.map((i) => i.playerId)) ===
      JSON.stringify(beforeDetail.items.map((i) => i.playerId)),
    'membership derives to exactly the same set after a restart',
  );
  abuse(
    44,
    JSON.stringify(afterDetail.summary) === JSON.stringify(beforeDetail.summary),
    'a restart does not invent a wave of transitions — membership is derived, not replayed',
  );
  const h = await j('GET', `/org/watchlists/${beforeDetail.watchlist.id}/history`, undefined, maria2.token);
  neg(h.body.total >= 1, 'the history that existed before the restart is still there');
  const caps = await j('GET', '/capabilities');
  ok(caps.body.schema?.upToDate === true, 'the second boot runs no migration twice');
}

// ================================================================= summary
// The abuse cases scripts/rules/discovery/matchingAndWatchlists.mjs checks (its RULES_ABUSE); every other one is here.
const RULES_ABUSE = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
  33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 50, 51, 56, 57, 58,
];
const missingAbuse = Array.from({ length: 60 }, (_, i) => i + 1).filter(
  (n) => !seenAbuse.has(n) && !RULES_ABUSE.includes(n),
);
ok(
  missingAbuse.length === 0,
  `all 60 enumerated abuse cases exercised${missingAbuse.length ? `: missing A${missingAbuse.join(', A')}` : ''}`,
);
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(
  `\ndiscovery/matchingAndWatchlists: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`,
);
if (pct < 50) fail(`negative coverage ${pct}% is below the 50% floor this milestone requires`);
if (process.exitCode) console.error('\ndiscovery/matchingAndWatchlists FAILURES ABOVE');
else console.log('all discovery/matchingAndWatchlists checks passed');
process.exit(process.exitCode ?? 0);
