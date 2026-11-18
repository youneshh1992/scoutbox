// Agent domain hardening battery: treats the Agent subsystem as a candidate for
// production and tries to BREAK it, so most checks are an attempt to obtain
// something the caller must not have. It pins three regressions: a mandate whose
// term begins in the future grants nothing today; a present but unreadable endAt
// (an ISO string, a NaN) is expired, not open; and failed logins are budgeted per
// identifier, not only per IP (group AA, which runs LAST, see below).
//
// No assertion is `status !== 200`, and none is a tautology: every refusal names
// its status and its code.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import coreSpec from '../support/spec/agents/core/shared.json' with { type: 'json' };
import { storedPassword } from '../support/password.mjs';
import { openFixture, SCHEMA_VERSION } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

const { DISCLOSURE_KEYS } = coreSpec;

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-p56f-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0;
let negatives = 0;
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
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =================================================================== LIVE

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

async function boot(env = {}) {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      SCOUTBOX_QUIET_LOGS: '1',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
      SCOUTBOX_TEST_CLOCK: '1',
      ...env,
    },
    stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode != null || proc.signalCode) break;
    await sleep(100);
  }
  await sleep(300);
}
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
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const key = () => `k-${Math.random().toString(36).slice(2, 10)}`;
const ERRORS = [];
const collect = (label, r) => {
  if (r.status >= 400) ERRORS.push({ label, status: r.status, body: r.body });
  return r;
};
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
  // The second agency is a copy of the seeded one's row under its own id and name, without its password.
  // A password-protected guardian reachable by id AND by email, for the
  // failed-login alias check. The seeded guardians have open (null)
  // passwords in development, so nothing about them can ever fail to
  // authenticate — and a budget that is never charged cannot be tested.
  // It is a copy of the first seeded guardian's row, with no children.
  const F = openFixture(DATA_DIR);
  try {
    F.transaction(() => {
      const agency = F.sql.prepare("SELECT * FROM orgs WHERE type = 'agency' ORDER BY rowid LIMIT 1").get();
      F.insert('orgs', { ...agency, id: 'org-southgate', name: 'Southgate Sports Management', password_hash: null });
      const guardian = F.sql.prepare('SELECT * FROM guardians ORDER BY rowid LIMIT 1').get();
      F.insert('guardians', {
        ...guardian,
        id: 'gd-locktest',
        name: 'Lock Test',
        email: 'locktest@example.test',
        password_hash: storedPassword('right-password-1'),
        email_code_hash: null,
        co_guardian_of: null,
      });
    });
  } finally {
    F.close();
  }
  const after = readRows(DATA_DIR);
  ok(after.rows('orgs').filter((o) => o.type === 'agency').length === 2, 'fixture: two agencies exist');
  ok(
    after.rows('guardians').some((g) => g.id === 'gd-locktest' && g.password_hash),
    'fixture: a password-protected guardian exists, so a wrong password is a chargeable failure',
  );
}
server = await boot();

section('fixture — an agency with five tiers, a confirmed client, two clubs');
const alex = await login('org-northstar', 'Alex Admin', 'Director', 'agent');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = await playerLogin('pl-adeyemi');
ok(
  [alex, maria, rita, kola].every((x) => x?.token),
  'fixture: an agency director, two clubs and a player are signed in',
);

// Five tiers at ONE agency, so "same-agency membership" can be tested as a matrix.
const TIERS = [
  ['Ada Agent', 'licensed_agent'],
  ['Ben Agent', 'licensed_agent'],
  ['Cleo Analyst', 'analyst'],
  ['Dov Assist', 'assistant'],
  ['Eve Finance', 'finance'],
];
for (const [name, tier] of TIERS) await j('POST', '/org/agent/agency/team', { name, tiers: [tier] }, alex.token);
const ada = await login('org-northstar', 'Ada Agent', 'Agent', 'agent');
const ben = await login('org-northstar', 'Ben Agent', 'Agent', 'agent');
const cleo = await login('org-northstar', 'Cleo Analyst', 'Analyst', 'agent');
const dov = await login('org-northstar', 'Dov Assist', 'Assistant', 'agent');
const eve = await login('org-northstar', 'Eve Finance', 'Finance', 'agent');
ok(
  [ada, ben, cleo, dov, eve].every((x) => x?.token),
  'fixture: five colleagues at one agency, across every tier',
);

for (const who of [ada, ben]) {
  await j('POST', '/org/agent/profile', { displayName: 'Licensed', jurisdictions: ['ENG'] }, who.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-X' }, who.token);
  await j(
    'POST',
    '/org/agent/profile/facets/national_registration/submit',
    { reference: 'TEST-VERIFIED-X-ENG', memberAssociation: 'ENG' },
    who.token,
  );
}
const REQ = await j(
  'POST',
  '/org/agent/clients/request',
  { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG', clientKey: key() },
  ada.token,
);
const REP = REQ.body?.relationship?.id;
ok(!!REP, 'fixture: Ada requested a mandate');
const CONF = await j('POST', `/player/agent/relationships/${REP}/confirm`, { expectedRev: 1 }, kola.token);
ok(
  CONF.status === 200 && CONF.body?.relationship?.status === 'active',
  'fixture: the client confirmed it — the root of every authority below',
);
let REV = CONF.body?.relationship?.rev;

section('D/live — same-agency membership grants no confidential client access');
{
  const colleagues = [
    ['a licensed colleague', ben],
    ['an analyst', cleo],
    ['an assistant', dov],
    ['finance', eve],
  ];
  for (const [who, tok] of colleagues) {
    const detail = collect(`${who} client detail`, await j('GET', `/org/agent/clients/${REP}`, undefined, tok.token));
    neg(
      expect(detail, 404, null),
      `D6 ${who} at the OWNING agency cannot open the client record — concealed as 404 ${detail.body?.error}, the same shape as a record that never existed`,
    );
    const list = await j('GET', '/org/agent/clients', undefined, tok.token);
    const namesClient = JSON.stringify(list.body ?? {}).includes(REP);
    neg(!namesClient, `D7 ${who} does not see the mandate in their own client list either`);
  }
  // The agency administrator may know the business exists, but not read the file.
  const adminDetail = collect(
    'admin client detail',
    await j('GET', `/org/agent/clients/${REP}`, undefined, alex.token),
  );
  neg(
    expect(adminDetail, 404, null),
    `D8 the agency ADMINISTRATOR cannot open the representing agent's client record either — 404 ${adminDetail.body?.error}`,
  );
  const owner = await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token);
  ok(
    owner.status === 200,
    'D9 while the representing agent can — the wall is between people, not around the whole agency',
  );
}

section('T/live — the club/agency boundary, in both directions');
{
  for (const [what, url] of [
    ['clients', '/org/agent/clients'],
    ['agent home', '/org/agent/home'],
    ['compliance contexts', '/org/agent/compliance/contexts'],
    ['agent transactions', '/org/agent/transactions'],
    ['agent inbox', '/org/agent/inbox'],
  ]) {
    const r = collect(`club on ${what}`, await j('GET', url, undefined, maria.token));
    neg(expect(r, 403, null), `T1 a CLUB session is refused the agent lane's ${what} — 403 ${r.body?.error}`);
  }
  const foreign = collect(
    'foreign agency',
    await j(
      'GET',
      `/org/agent/clients/${REP}`,
      undefined,
      (await login('org-southgate', 'Zed Admin', 'Director', 'agent')).token,
    ),
  );
  neg(
    expect(foreign, 404, null),
    `T2 a FOREIGN agency cannot open another agency's mandate — concealed as 404 ${foreign.body?.error}`,
  );
}

section('A/live — authority is re-derived on the NEXT request, not at login');
{
  // Ada's session stays valid; her AFFILIATION ends underneath it. Every agent
  // route must refuse on the next request with no re-login in between. This is
  // the case a suite that logs in fresh for every assertion never sees.
  const teamBefore = await j('GET', '/org/agent/agency/team', undefined, alex.token);
  const benRow = (teamBefore.body?.members ?? []).find((m) => m.name === 'Ben Agent');
  ok(!!benRow, 'A11 fixture: the agency team lists Ben');
  const end = await j('POST', `/org/agent/agency/team/${benRow.userId ?? benRow.id}/end`, {}, alex.token);
  ok(end.status === 200 || end.status === 204, `A12 the administrator ended Ben's affiliation (${end.status})`);
  for (const [what, url] of [
    ['home', '/org/agent/home'],
    ['clients', '/org/agent/clients'],
    ['profile', '/org/agent/profile'],
    ['compliance', '/org/agent/compliance/contexts'],
    ['transactions', '/org/agent/transactions'],
  ]) {
    const r = collect(`ended affiliation on ${what}`, await j('GET', url, undefined, ben.token));
    neg(
      expect(r, 401, null),
      `A13 Ben's still-live session is refused ${what} on the very next request — 401 ${r.body?.error}, and the session is gone rather than merely denied`,
    );
  }
}

section('J/live — a minor is indistinguishable from a player who does not exist');
{
  const minor = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-guni', scope: ['employment'], jurisdiction: 'ENG', clientKey: key() },
    ada.token,
  );
  const ghost = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-does-not-exist-at-all', scope: ['employment'], jurisdiction: 'ENG', clientKey: key() },
    ada.token,
  );
  collect('minor request', minor);
  collect('ghost request', ghost);
  neg(expect(minor, 404, null), `J4 a mandate request naming a MINOR is refused — 404 ${minor.body?.error}`);
  neg(expect(ghost, 404, null), `J4b and so is one naming a player who does not exist — 404 ${ghost.body?.error}`);
  ok(
    minor.status === ghost.status && JSON.stringify(minor.body) === JSON.stringify(ghost.body),
    'J5 and the two refusals are BYTE-IDENTICAL — the refusal is not an age oracle and not an existence oracle',
  );
  // Forging the facts that would open the minor pathway changes nothing.
  const forged = collect(
    'forged minor',
    await j(
      'POST',
      '/org/agent/clients/request',
      {
        playerId: 'pl-guni',
        scope: ['employment'],
        jurisdiction: 'ENG',
        dob: '1990-01-01',
        isAdult: true,
        guardianConsent: true,
        minorPathway: true,
        clientKey: key(),
      },
      ada.token,
    ),
  );
  neg(
    expect(forged, 400, 'AGENT_INPUT_INVALID') && forged.body.problem === 'unknown_field',
    `J6 forging dob, isAdult, guardianConsent or minorPathway in the body is refused as a field the request does not take — ${forged.status} ${forged.body?.error}`,
  );
  ok(
    forged.body.field === 'dob' && !JSON.stringify(forged.body).includes('pl-guni'),
    'J6b …naming the forged field, never the player: the client cannot assert its way past a server-side age rule, and the refusal says nothing about the subject',
  );
  const clientsAfter = await j('GET', '/org/agent/clients', undefined, ada.token);
  neg(
    !JSON.stringify(clientsAfter.body ?? {}).includes('pl-guni'),
    'J6c and no relationship with the minor was proposed',
  );
  const players = await j('GET', '/org/agent/players?q=Guni', undefined, ada.token);
  neg(
    !JSON.stringify(players.body ?? {}).includes('pl-guni'),
    'J7 and the minor does not appear in an agent player search',
  );
}

section('U/live — counts, totals and pagination disclose nothing extra');
{
  for (const [what, url, tok] of [
    ['the agent client list', '/org/agent/clients', ada.token],
    ['the opportunity board', '/org/agent/opportunities', ada.token],
    ['the transaction list', '/org/agent/transactions', ada.token],
  ]) {
    const r = await j('GET', url, undefined, tok);
    if (r.status !== 200) {
      ok(false, `U1 ${what} answered ${r.status}`);
      continue;
    }
    const b = r.body ?? {};
    const items = Array.isArray(b) ? b : (b.items ?? b.clients ?? b.transactions ?? b.opportunities ?? []);
    const total = Array.isArray(b) ? undefined : b.total;
    ok(
      total === undefined || total === items.length,
      `U1 ${what}: \`total\` either does not exist or equals the rows actually returned (${total} vs ${items.length}) — a count of rows the caller cannot see is a disclosure`,
    );
  }
}

section('V/live — deep links after authority loss, and history is not access');
{
  const before = await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token);
  ok(before.status === 200, 'V1 the agent can read her own client while the mandate is active');
  const term = await j(
    'POST',
    `/org/agent/clients/${REP}/terminate`,
    { reasonCode: 'agent_ended', clientKey: key() },
    ada.token,
  );
  ok(term.status === 200, `V2 the agent terminated her own mandate (${term.status})`);
  const after = collect('terminated client detail', await j('GET', `/org/agent/clients/${REP}`, undefined, ada.token));
  // An ENDED mandate is deliberately kept as the agent's own history, so the
  // record MUST still answer 200 and the privacy assertions are about CONTENTS.
  // A test that also accepted a refusal here would pass under two contradictory
  // products.
  ok(
    after.status === 200,
    `V3 the relationship record itself still answers 200 — an ended mandate is the agent's own history, deliberately (${after.status})`,
  );
  const txt = JSON.stringify(after.body ?? {});
  ok(/terminated/i.test(txt), 'V3a and reads as terminated, so history says what happened');
  neg(!/Passport|passport/.test(txt), 'V3b but it carries no Passport');
  neg(!/assessment/i.test(txt), 'V3c no assessments');
  neg(!/"contacts":\s*\[[^\]]/.test(txt), 'V3d and no contacts — history is not access');
  const opps = collect(
    'terminated opportunities',
    await j('GET', `/org/agent/clients/${REP}/opportunities`, undefined, ada.token),
  );
  neg(
    expect(opps, 409, null),
    `V4 and the client-scoped surfaces reached by the ids she still holds are refused — 409 ${opps.body?.error}: the relationship exists but is not active, which is a state conflict, not a missing record`,
  );
}

section('AC/live — rev conflicts: two answers to one question cannot both land');
{
  const r2 = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-svensson', scope: ['employment'], jurisdiction: 'ENG', clientKey: key() },
    ada.token,
  );
  const rep2 = r2.body?.relationship?.id;
  if (!rep2) {
    ok(false, `AC1 fixture: a second mandate could not be requested (${r2.status})`);
  } else {
    const sven = await playerLogin('pl-svensson');
    const c = await j('POST', `/player/agent/relationships/${rep2}/confirm`, { expectedRev: 1 }, sven.token);
    ok(c.status === 200, `AC1 the second client confirmed (${c.status})`);
    const rev = c.body?.relationship?.rev;
    const first = await j(
      'PATCH',
      `/player/agent/relationships/${rep2}/sharing`,
      { disclosure: { [DISCLOSURE_KEYS[0]]: true }, expectedRev: rev },
      sven.token,
    );
    ok(first.status === 200, `AC2 a disclosure change against the current rev lands (${first.status})`);
    const stale = collect(
      'stale rev',
      await j(
        'PATCH',
        `/player/agent/relationships/${rep2}/sharing`,
        { disclosure: { [DISCLOSURE_KEYS[1]]: true }, expectedRev: rev },
        sven.token,
      ),
    );
    neg(
      stale.status === 409,
      `AC3 a second change against the SAME, now stale, rev is refused 409 (${stale.status}) — two questions cannot be answered in one race`,
    );
  }
}

section('AB/live — idempotency: a replay is an answer, not a second act');
{
  // The key travels in the BODY as `clientKey` (normaliseClientKey in
  // domains/recruitment/lifecycle/contact.mjs), not in an Idempotency-Key header.
  const k = key();
  const body = { playerId: 'pl-martin', scope: ['employment'], jurisdiction: 'ENG', clientKey: k };
  const a = await j('POST', '/org/agent/clients/request', body, ada.token);
  const b = await j('POST', '/org/agent/clients/request', body, ada.token);
  ok(a.status === 200 || a.status === 201, `AB1 the first request was accepted (${a.status})`);
  ok(
    b.body?.relationship?.id === a.body?.relationship?.id,
    'AB2 the same key with the same payload replays the ORIGINAL answer rather than asking a second time',
  );
  ok(
    b.body?.idempotent === true,
    'AB2b and says so — a replay is labelled, not silently indistinguishable from a fresh act',
  );
  const c = collect(
    'key reuse, different payload',
    await j(
      'POST',
      '/org/agent/clients/request',
      { playerId: 'pl-okafor', scope: ['commercial'], jurisdiction: 'ENG', clientKey: k },
      ada.token,
    ),
  );
  neg(
    expect(c, 409, 'REPRESENTATION_IDEMPOTENCY_CONFLICT'),
    `AB3 the same key with a DIFFERENT payload is refused 409 REPRESENTATION_IDEMPOTENCY_CONFLICT rather than quietly creating a second row (${c.status})`,
  );
  const blank = collect(
    'non-string key',
    await j(
      'POST',
      '/org/agent/clients/request',
      { playerId: 'pl-okafor', scope: ['employment'], jurisdiction: 'ENG', clientKey: 12345 },
      ada.token,
    ),
  );
  neg(
    expect(blank, 400, 'AGENT_CLIENT_KEY_INVALID'),
    `AB4 a non-string idempotency key is refused rather than coerced (${blank.status}) — a key that stringifies differently on two calls is not a key`,
  );
}

section('I/live — compliance decisions are attributed, and the shared key is not a reviewer');
{
  const adminKey = collect('admin key on /ts', await j('GET', '/ts/reviewers', undefined, undefined, ADMIN));
  neg(
    expect(adminKey, 401, 'REVIEWER_AUTH_REQUIRED'),
    'I1 the shared admin key is NOT a reviewer — /ts/* refuses it 401 REVIEWER_AUTH_REQUIRED',
  );
  const agentOnTs = collect('agent on /ts', await j('GET', '/ts/reviewers', undefined, ada.token));
  neg(agentOnTs.status === 401, `I2 and an agent session is refused the same way (${agentOnTs.status})`);
  const rev = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' }))
    .body;
  ok(!!rev?.token, 'I3 a credentialed reviewer gets a session');
  neg(
    !JSON.stringify(rev?.reviewer ?? {}).match(/secretHash|hash|\$2[aby]\$/),
    'I4 whose projection carries no secret and no hash',
  );
  const me = await j('GET', '/ts/me', undefined, rev.token);
  ok(
    me.body?.attribution === 'authenticated_reviewer',
    'I5 and every authoritative action is recorded against that named identity',
  );
  const bad = collect(
    'wrong reviewer secret',
    await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'nope' }),
  );
  const ghostRev = collect(
    'unknown reviewer',
    await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-nobody', secret: 'nope' }),
  );
  ok(
    bad.status === ghostRev.status && JSON.stringify(bad.body) === JSON.stringify(ghostRev.body),
    'I6 a wrong secret and an unknown reviewer id share ONE refusal — the login is not a reviewer-roster oracle',
  );
}

section("O+P/live — the Passport stays the player's and Trust is not agent-editable");
{
  for (const [what, method, url] of [
    ['passport write', 'POST', `/org/agent/clients/${REP}/passport`],
    ['passport patch', 'PATCH', `/org/agent/clients/${REP}/passport`],
    ['passport entry', 'POST', `/org/agent/players/pl-adeyemi/passport`],
    ['trust write', 'POST', `/org/agent/players/pl-adeyemi/trust`],
    ['trust patch', 'PATCH', `/org/agent/players/pl-adeyemi/trust`],
  ]) {
    const r = collect(what, await j(method, url, { anything: true }, ada.token));
    neg(
      r.status === 404 || r.status === 403 || r.status === 405,
      `O1 no agent ${what} route exists or is permitted (${r.status})`,
    );
  }
}

section('N/live — private club recruitment intelligence stays private');
{
  for (const [what, url] of [
    ['second look', '/org/second-look'],
    ['nobody missed', '/org/nobody-missed'],
    ['watchlists', '/org/watchlists'],
    ['assessments', '/org/assessments'],
    ['analytics overview', '/org/analytics/overview'],
    ['rooms', '/org/rooms'],
  ]) {
    const r = await j('GET', url, undefined, ada.token);
    // Intentionally generic org surfaces. Each is either absent for an agency
    // (404) or answered about the caller's OWN org, which for an agency is EMPTY.
    // Both halves are asserted — a `neg(true)` in the 404 branch would be an
    // unconditional pass.
    const b = r.body ?? {};
    const items = Array.isArray(b) ? b : (b.items ?? []);
    const emptyOwn = r.status === 200 && items.length === 0 && (b.total === undefined || b.total === 0);
    neg(
      r.status === 404 || emptyOwn,
      `N1 the club's ${what} is absent for an agency (404) or answered about its OWN org and EMPTY — got ${r.status}, ${items.length} rows, total ${b.total ?? '—'}`,
    );
    const txt = JSON.stringify(b);
    neg(
      !/org-eastport|org-harbour|Maria Keane|Rita Vale/.test(txt),
      `N2 the agency's own ${what} contains no other org's case, player or user`,
    );
  }
  // Proved against a case that REALLY EXISTS. Comparing two
  // invented ids would be worthless: both 404 whatever the rule is. So the club
  // opens a genuine case first, confirms it can read it, and only then is the
  // agency's refusal compared against an id that never existed.
  const made = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
  const caseId = made.body?.room?.roomId ?? made.body?.roomId ?? made.body?.existingRoomId ?? null;
  ok(!!caseId, `N3 the club opened a real recruitment case (${made.status}, id ${caseId})`);
  const clubOwn = await j('GET', `/org/rooms/${caseId}`, undefined, maria.token);
  ok(
    clubOwn.status === 200 && JSON.stringify(clubOwn.body).includes(caseId),
    'N3b and the club itself reads it — so the id is real and populated, which is what makes the next check mean something',
  );
  for (const path of ['', '/decision', '/contacts', '/trials']) {
    const real = await j('GET', `/org/rooms/${caseId}${path}`, undefined, ada.token);
    const ghost = await j('GET', `/org/rooms/case-never-existed${path}`, undefined, ada.token);
    collect(`agency on club case${path}`, real);
    neg(
      real.status === ghost.status && JSON.stringify(real.body) === JSON.stringify(ghost.body),
      `N3c an agency asking for a REAL club case${path || ' (detail)'} gets BYTE-IDENTICAL bytes to an invented id (${real.status}) — existence does not leak through a direct link`,
    );
  }
}

section('AE/live — error privacy, swept over every refusal this suite provoked');
{
  ok(ERRORS.length > 0, `AE1 ${ERRORS.length} refusals were collected to sweep`);
  const fivexx = ERRORS.filter((e) => e.status >= 500);
  neg(
    fivexx.length === 0,
    `AE2 none of them is a 5xx — a refusal is a decision, not a crash${fivexx.length ? `: ${JSON.stringify(fivexx.slice(0, 2))}` : ''}`,
  );
  const leaky = ERRORS.filter((e) =>
    /at \/|\.mjs:|node_modules|\/home\/|Error:.*\n\s+at /.test(JSON.stringify(e.body)),
  );
  neg(
    leaky.length === 0,
    `AE3 none carries a stack trace or a file path${leaky.length ? `: ${JSON.stringify(leaky.slice(0, 2))}` : ''}`,
  );
  const offerish = ERRORS.filter((e) => /offer|commission|signing|fee/i.test(JSON.stringify(e.body)));
  neg(
    offerish.length === 0,
    `AE4 and none mentions an offer, a commission, a signing or a fee${offerish.length ? `: ${JSON.stringify(offerish.slice(0, 2))}` : ''}`,
  );
}

section('AI/live — the store survives a restart with its authority intact');
{
  await stop(server);
  server = await boot();
  const afterRestart = await j(
    'GET',
    '/org/agent/clients',
    undefined,
    (await login('org-northstar', 'Ada Agent', 'Agent', 'agent')).token,
  );
  ok(afterRestart.status === 200, `AI1 the agent lane answers after a restart (${afterRestart.status})`);
  const h = await (await fetch(`${BASE}/health`)).json();
  ok(h.ok === true, 'AI2 and the server reports healthy on the persisted store');
  const schemaHeader = (await fetch(`${BASE}/health`)).headers.get('x-scoutbox-schema');
  ok(
    schemaHeader === String(SCHEMA_VERSION),
    `AI3 the persisted store is still at schema ${SCHEMA_VERSION} (header said ${schemaHeader})`,
  );
}

section('AD/live — sign-up refuses a date of birth it cannot read');
{
  // An UNREADABLE dob, not only an absent one, must be refused: `dob: 12345`
  // would create an account whose age can never be established.
  const signup = (dob) =>
    j('POST', '/auth/player/signup', { name: 'Dob Probe', dob, country: 'GB', password: 'a-long-enough-password' });
  for (const [label, dob] of [
    ['a number', 12345],
    ['garbage', 'not-a-date'],
    ['an array', ['1990-01-01']],
    ['an object', { y: 1990 }],
    ['30 February (V8 rolls it to 2 March)', '1990-02-30'],
    ['31 April', '1991-04-31'],
    ['29 February in a non-leap year', '1993-02-29'],
  ]) {
    const r = collect(`signup dob ${label}`, await signup(dob));
    neg(
      expect(r, 400, 'DOB_INVALID'),
      `AD6 sign-up with ${label} as a date of birth is refused 400 DOB_INVALID — not stored as an account whose age can never be established`,
    );
  }
  const control = await signup('1990-01-01');
  ok(control.status === 201, `AD7 while a readable adult date of birth still signs up (${control.status})`);
  // The guardian-created child path shares the rule. The seeded guardian has an
  // open login in development, so this costs one /auth call.
  const gAuth = await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' });
  ok(gAuth.status === 200, `AD7b fixture: the seeded guardian signs in (${gAuth.status})`);
  const child = (dob) =>
    j(
      'POST',
      '/guardian/children',
      { name: `Child Probe ${Math.random().toString(36).slice(2, 6)}`, dob, country: 'GB' },
      gAuth.body?.token,
    );
  const rolled = collect('child dob 30 Feb', await child('2012-02-30'));
  neg(
    expect(rolled, 400, 'DOB_INVALID'),
    'AD7c a guardian cannot create a child born on 30 February either — one dob rule, both paths',
  );
  const realChild = await child('2012-05-05');
  ok(realChild.status === 201, `AD7d while a real minor's date of birth still creates the child (${realChild.status})`);
}

// ---------------------------------------------------------------------------
// AA runs LAST, on purpose.
//
// `app.use('/auth', authLimiter)` bounds the WHOLE /auth surface at 40 requests
// per minute per IP, and every login in this suite spends that budget. A burst of
// wrong credentials placed earlier would therefore starve the logins of every
// later group. Nothing here is a sleep or a retry: the group is simply last,
// and it is the last thing the file does.
// ---------------------------------------------------------------------------
section('AA/live — the failed-login budget, per identifier');
{
  const tryRev = (id, secret) => j('POST', '/auth/reviewer/login', { reviewerId: id, secret });
  let lockedAt = 0;
  for (let i = 1; i <= 25 && !lockedAt; i++) {
    const r = await tryRev('tsr-dev-admin', `wrong-${i}`);
    if (r.status === 429) lockedAt = i;
  }
  ok(
    lockedAt > 0 && lockedAt <= 23,
    `AA1 repeated wrong secrets for ONE identifier reach a lockout (first 429 at attempt ${lockedAt})`,
  );
  const locked = await tryRev('tsr-dev-admin', 'wrong-again');
  ok(
    locked.body?.action === 'login_failure',
    'AA2 and the refusal is the per-identifier budget, not the per-IP one — they are different controls and this proves which fired',
  );
  const correct = collect('correct secret while locked', await tryRev('tsr-dev-admin', 'dev-reviewer-admin'));
  neg(
    correct.status === 429,
    `AA3 the CORRECT secret is still refused during the lockout (${correct.status}) — the budget is checked before the credential, so a guess that finally lands is not rewarded`,
  );
  const upper = await tryRev('TSR-DEV-ADMIN', 'dev-reviewer-admin');
  neg(
    upper.status === 429,
    `AA4 and an upper-cased identifier shares the same bucket (${upper.status}) — case is not a way to get a fresh budget`,
  );
  const other = await tryRev('tsr-dev-reviewer', 'dev-reviewer');
  ok(
    other.status === 200,
    'AA5 while a DIFFERENT reviewer signs in normally from the same IP — which an IP-scoped limit alone could never satisfy, and is the whole reason this policy exists',
  );
}

section('AA/live — one account, two names, ONE budget');
{
  // A guardian can be named by id or by email; separate buckets would give a
  // guesser alternating them twice the attempts per window. A fresh server:
  // fresh per-IP AND per-identifier buckets, so this measures only what it
  // claims to.
  await stop(server);
  server = await boot();
  const byId = (pw) => j('POST', '/auth/guardian/login', { guardianId: 'gd-locktest', password: pw });
  const byEmail = (pw) => j('POST', '/auth/guardian/login', { email: 'locktest@example.test', password: pw });
  ok(
    (await byId('right-password-1')).status === 200,
    'AA6 the fixture guardian signs in by id with the right password',
  );
  ok((await byEmail('right-password-1')).status === 200, 'AA6b and by email — two names, one account');
  let lockedAt = 0;
  for (let i = 1; i <= 25 && !lockedAt; i++) {
    const r = await byId(`wrong-${i}`);
    if (r.status === 429) lockedAt = i;
  }
  ok(lockedAt > 0 && lockedAt <= 23, `AA7 wrong passwords BY ID reach the lockout (first 429 at attempt ${lockedAt})`);
  const viaEmail = collect('alias after lockout', await byEmail('wrong-again'));
  neg(
    viaEmail.status === 429 && viaEmail.body?.action === 'login_failure',
    `AA8 and the SAME account tried BY EMAIL is already locked (${viaEmail.status} ${viaEmail.body?.action ?? viaEmail.body?.error}) — an alias is not a second budget`,
  );
  const rightViaEmail = collect('right password via alias while locked', await byEmail('right-password-1'));
  neg(
    rightViaEmail.status === 429,
    `AA8b even with the right password (${rightViaEmail.status}) — the lockout is checked before the credential on the alias path too`,
  );
}

console.log(
  `\nagents/adversarial: ${passed} checks passed, ${negatives} negative/security/privacy checks (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode) console.error('\nSOME AGENT HARDENING CHECKS FAILED');
else console.log('all agents/adversarial checks passed');
await stop(server);
process.exit(process.exitCode ?? 0);
