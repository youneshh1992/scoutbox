// Agent Conflict & Compliance Engine battery.
//
// The governing principle this suite enforces: ScoutBox never
// converts an agency relationship, a stale licence, an ambiguous rule, a
// missing consent, an unsupported jurisdiction, a shared reviewer credential
// or an old conflict check into authority to perform a regulated
// football-agent workflow. Every regulated action is grounded in an
// attributable actor, current client authority, current policy, current
// verification, current consent and current conflict state.
//
// A real server; the pure groups are scripts/rules/agents/compliance.mjs. The adversarial cases are numbered (#n)
// in their check labels.
//
// No assertion is `status !== 200`. Every refusal names the status and code.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRows } from '../support/sqlRows.mjs';
import conflictSpec from '../support/spec/agents/compliance/conflict.json' with { type: 'json' };
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import { liveStream } from '../support/liveEvents.mjs';

const { PERMITTED_WITH_CONSENT } = conflictSpec;
// The latest table migration's number, as the migrated schema records it.
const SCHEMA_VERSION = Number(
  (() => {
    const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m25-schema-')));
    try {
      return R.rows('data_migrations').map((r) => r.id);
    } finally {
      R.close();
    }
  })()
    .sort()
    .at(-1)
    .slice(0, 4),
);

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m25-'));
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
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
};
const T0 = Date.UTC(2026, 8, 18);
const DAY = 86_400_000;
const codes = (r) => (r.reasons ?? []).map((x) => x.code);

// ============================================================ C/D — versions and statuses (pure)
section('HTTP — booting a real server (synthetic verification provider ON)');
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
      ...env,
    },
    stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 400 && !up; i++) {
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
let server = await boot();
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
const login = async (orgId, scoutName, role, platform = 'agent') =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const reviewerLogin = async (reviewerId, secret) => await j('POST', '/auth/reviewer/login', { reviewerId, secret });
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController();
  const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        frames.push(dec.decode(value));
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    stop: async () => {
      await sleep(ms);
      ac.abort();
      await done;
      return frames.join('');
    },
  };
}
const ERROR_BODIES = [];
const collect = (label, r) => {
  if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body });
  return r;
};

// ============================================================ A — G-C0
section('A — G-C0: reviewer identity is authenticated, derived by the server, and never the shared key');
let PRIYA, MARCUS, LEA;
{
  ok(
    (await j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION && SCHEMA_VERSION >= 28,
    `A0 schema ${SCHEMA_VERSION} (the compliance tables need 0028)`,
  );
  neg(
    expect(
      collect('A1', await j('GET', '/ts/compliance/reviews', undefined, null, ADMIN)),
      401,
      'REVIEWER_AUTH_REQUIRED',
    ),
    'A1 the shared admin key alone gets no reviewer lane (#1)',
  );
  neg(
    expect(
      collect('A2', await j('POST', '/ts/compliance/reviews/rrv-1/resolve', { outcome: 'APPROVED' }, null, ADMIN)),
      401,
      'REVIEWER_AUTH_REQUIRED',
    ),
    'A2 …and cannot resolve anything',
  );
  PRIYA = (await reviewerLogin('tsr-dev-admin', 'dev-reviewer-admin')).body;
  ok(
    PRIYA?.token &&
      PRIYA.reviewer.id === 'tsr-dev-admin' &&
      PRIYA.reviewer.role === 'trust_safety_admin' &&
      PRIYA.reviewer.secretHash === undefined,
    'A3 a reviewer logs in with credentials; the response carries no secret hash',
  );
  const me = await j('GET', '/ts/me', undefined, PRIYA.token);
  ok(
    me.status === 200 && me.body.reviewer.id === 'tsr-dev-admin' && me.body.attribution === 'authenticated_reviewer',
    'A4 /ts/me resolves the identity from the session',
  );
  neg(
    expect(collect('A5', await reviewerLogin('tsr-dev-admin', 'wrong')), 401, 'REVIEWER_CREDENTIALS_INVALID') &&
      expect(
        collect('A5b', await reviewerLogin('tsr-nobody', 'dev-reviewer-admin')),
        401,
        'REVIEWER_CREDENTIALS_INVALID',
      ),
    'A5 a wrong secret and an unknown id fail alike',
  );
  MARCUS = (await reviewerLogin('tsr-dev-reviewer', 'dev-reviewer')).body;
  LEA = (await reviewerLogin('tsr-dev-admin2', 'dev-reviewer-admin2')).body;
  ok(
    MARCUS?.reviewer.role === 'trust_safety_reviewer' && LEA?.reviewer.role === 'trust_safety_admin',
    'A6 a reviewer and a second administrator log in',
  );
  neg(
    expect(
      collect(
        'A7',
        await j(
          'POST',
          '/ts/reviewers',
          { id: 'tsr-x', name: 'X', role: 'trust_safety_reviewer', secret: 'twelve-characters!' },
          MARCUS.token,
        ),
      ),
      403,
      'REVIEWER_ROLE_REQUIRED',
    ),
    'A7 a reviewer cannot provision reviewers',
  );
  neg(
    expect(
      collect(
        'A8',
        await j(
          'POST',
          '/ts/reviewers',
          { id: 'tsr-temp', name: 'Temp', role: 'trust_safety_reviewer', secret: 'short' },
          PRIYA.token,
        ),
      ),
      400,
      'COMPLIANCE_INPUT_INVALID',
    ) &&
      expect(
        collect(
          'A8b',
          await j(
            'POST',
            '/ts/reviewers',
            { id: 'tsr-temp', name: 'Temp', role: 'god', secret: 'twelve-characters!' },
            PRIYA.token,
          ),
        ),
        400,
        'COMPLIANCE_INPUT_INVALID',
      ),
    'A8 a short secret and an unknown role are refused',
  );
  const temp = await j(
    'POST',
    '/ts/reviewers',
    { id: 'tsr-temp', name: 'Temp Reviewer', role: 'trust_safety_reviewer', secret: 'twelve-characters!' },
    PRIYA.token,
  );
  ok(temp.status === 201 && temp.body.reviewer.status === 'active', 'A9 an administrator provisions a reviewer');
  neg(
    expect(
      collect(
        'A10',
        await j(
          'POST',
          '/ts/reviewers',
          { id: 'tsr-temp', name: 'Temp Reviewer', role: 'trust_safety_reviewer', secret: 'twelve-characters!' },
          PRIYA.token,
        ),
      ),
      409,
      'REVIEWER_EXISTS',
    ),
    'A10 not twice',
  );
  const TEMP = (await reviewerLogin('tsr-temp', 'twelve-characters!')).body;
  ok((await j('GET', '/ts/me', undefined, TEMP.token)).body.reviewer.id === 'tsr-temp', 'A11 the new reviewer logs in');
  const rv = await j('POST', '/ts/reviewers/tsr-temp/revoke', { reason: 'left', expectedRev: 1 }, PRIYA.token);
  ok(rv.status === 200 && rv.body.reviewer.status === 'revoked', 'B1 the administrator revokes the reviewer');
  const dead = collect('B2', await j('GET', '/ts/me', undefined, TEMP.token));
  neg(
    dead.status === 401 && ['REVIEWER_REVOKED', 'REVIEWER_AUTH_REQUIRED'].includes(dead.body.error),
    'B2 the stale session is dead at once — revocation removes the sessions themselves (#3)',
  );
  neg(
    expect(collect('B3', await reviewerLogin('tsr-temp', 'twelve-characters!')), 401, 'REVIEWER_CREDENTIALS_INVALID'),
    'B3 and the revoked reviewer cannot log back in',
  );
  ok(
    (await j('POST', '/ts/reviewers/tsr-temp/revoke', {}, PRIYA.token)).body.idempotent === true,
    'B4 revoking again is idempotent',
  );
  neg(
    expect(
      collect('B5', await j('POST', '/ts/reviewers/tsr-nobody/revoke', {}, PRIYA.token)),
      404,
      'REVIEWER_NOT_FOUND',
    ),
    'B5 an unknown reviewer is 404',
  );
  const list = await j('GET', '/ts/reviewers', undefined, LEA.token);
  ok(
    list.status === 200 &&
      list.body.items.length === 4 &&
      /shared_admin_key/.test(list.body.legacyNote) &&
      list.body.items.every((r) => r.secretHash === undefined),
    'A12 the reviewer list names four reviewers, no secrets, and states how legacy shared-key records are preserved',
  );
  const ro = await j('GET', '/admin/compliance/reviews', undefined, null, ADMIN);
  ok(
    ro.status === 200 && ro.body.readOnly === true && /adjudicate nothing/.test(ro.body.note),
    'A13 the legacy shared key reads reviews read-only and says so',
  );
  neg(
    expect(
      collect('A14', await j('POST', '/admin/compliance/reviews/rrv-1/resolve', { outcome: 'APPROVED' }, null, ADMIN)),
      404,
      null,
    ) &&
      expect(collect('A14b', await j('POST', '/admin/agent/relationships/rep-1/resolve', {}, null, ADMIN)), 404, null),
    'A14 no shared-key mutation route exists for reviews or relationships',
  );
}

// ============================================================ setup — agency, agents, players
section('setup — agency members, profiles, verified facets, relationships');
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', null);
const harbour = await login('org-harbour', 'Dev Ansah', 'Coach', null);
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const chinedu = await playerLogin('pl-okafor');
const filip = await playerLogin('pl-nowak');
const theo = await playerLogin('pl-martin');
const guni = await playerLogin('pl-guni');
let ANA, DAN, BEN, EVE, ANA_ID, DAN_ID, EVE_ID, REL_KOLA, REL_MATEUS, REL_CHINEDU, REL_THEO;
{
  const add = async (name, tiers) =>
    (await j('POST', '/org/agent/agency/team', { name, tiers }, tomas.token)).body.member;
  ANA_ID = (await add('Ana Costa', ['licensed_agent'])).userId;
  DAN_ID = (await add('Dan Mensah', ['licensed_agent'])).userId;
  EVE_ID = (await add('Eve Laurent', ['licensed_agent'])).userId;
  await add('Ben Okoro', ['analyst']);
  ANA = await login('org-northstar', 'Ana Costa', 'Agent');
  DAN = await login('org-northstar', 'Dan Mensah', 'Agent');
  EVE = await login('org-northstar', 'Eve Laurent', 'Agent');
  BEN = await login('org-northstar', 'Ben Okoro', 'Analyst');
  const prof = async (tok, name, jur) =>
    (await j('POST', '/org/agent/profile', { displayName: name, jurisdictions: jur }, tok)).status;
  ok(
    (await prof(ANA.token, 'Ana Costa', ['ENG', 'INT'])) === 201 &&
      (await prof(DAN.token, 'Dan Mensah', ['ENG'])) === 201 &&
      (await prof(EVE.token, 'Eve Laurent', ['INT', 'ENG'])) === 201,
    'S1 three agent profiles',
  );
  const sub = (tok, facet, reference, ma) =>
    j(
      'POST',
      `/org/agent/profile/facets/${facet}/submit`,
      { reference, ...(ma ? { memberAssociation: ma } : {}) },
      tok,
    );
  ok(
    (await sub(ANA.token, 'fifa_licence', 'TEST-VERIFIED-ANA')).body.facet.state === 'VERIFIED' &&
      (await sub(ANA.token, 'national_registration', 'TEST-VERIFIED-ANA-FA', 'ENG')).body.facet.state === 'VERIFIED',
    'G5 Ana: FIFA licence and FA registration VERIFIED by the synthetic provider',
  );
  ok(
    (await sub(DAN.token, 'fifa_licence', 'TEST-VERIFIED-DAN')).body.facet.state === 'VERIFIED' &&
      (await sub(DAN.token, 'national_registration', 'TEST-VERIFIED-DAN-FA', 'ENG')).body.facet.state === 'VERIFIED',
    'G6 Dan likewise',
  );
  const req = async (tok, playerId, over = {}) =>
    await j(
      'POST',
      '/org/agent/clients/request',
      { playerId, scope: ['employment', 'transfer'], jurisdiction: 'ENG', ...over },
      tok,
    );
  const r1 = await req(ANA.token, 'pl-adeyemi');
  REL_KOLA = r1.body?.relationship?.id;
  ok(
    r1.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_KOLA}/confirm`, { expectedRev: 1 }, kola.token)).body
        .relationship.status === 'active',
    'S2 Ana ↔ Kola: ENG employment + transfer, confirmed',
  );
  const r2 = await req(ANA.token, 'pl-carvalho', { jurisdiction: 'INT', scope: ['employment'] });
  REL_MATEUS = r2.body?.relationship?.id;
  ok(
    r2.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_MATEUS}/confirm`, { expectedRev: 1 }, mateus.token)).body
        .relationship.status === 'active',
    'S3 Ana ↔ Mateus: INT employment, confirmed',
  );
  const r3 = await req(DAN.token, 'pl-okafor');
  REL_CHINEDU = r3.body?.relationship?.id;
  ok(
    r3.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_CHINEDU}/confirm`, { expectedRev: 1 }, chinedu.token)).body
        .relationship.status === 'active',
    'S4 Dan ↔ Chinedu: ENG, confirmed',
  );
  const r4 = await req(ANA.token, 'pl-martin', { scope: ['commercial'] });
  REL_THEO = r4.body?.relationship?.id;
  ok(
    r4.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_THEO}/confirm`, { expectedRev: 1 }, theo.token)).body
        .relationship.status === 'active',
    'S5 Ana ↔ Theo: ENG commercial only, confirmed',
  );
  ok(
    r1.body.relationship.policyVersion === 1 && Array.isArray(r1.body.relationship.history),
    'S6 relationship records carry their policy versions',
  );
}

// ============================================================ G/H/I — provider over HTTP; the facet review lane
section('G/H/I/R — provider states over HTTP; a facet that needs review is decided by a NAMED reviewer');
let EVE_REVIEW, EVE_REVIEW2;
{
  const sub = (tok, facet, reference, ma) =>
    j(
      'POST',
      `/org/agent/profile/facets/${facet}/submit`,
      { reference, ...(ma ? { memberAssociation: ma } : {}) },
      tok,
    );
  const stale = await sub(EVE.token, 'fifa_licence', 'TEST-STALE-EVE');
  neg(
    stale.status === 200 && stale.body.facet.state === 'STALE' && stale.body.facet.storedState === 'VERIFIED',
    'H2 a STALE answer stores VERIFIED with a lapsed recheck date and READS stale',
  );
  neg(
    expect(
      collect(
        'H3',
        await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', jurisdiction: 'INT' }, EVE.token),
      ),
      403,
      'AGENT_VERIFICATION_REQUIRED',
    ) &&
      (await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', jurisdiction: 'INT' }, EVE.token)).body
        .state === 'STALE',
    'H3 a stale licence authorises no approach (#5)',
  );
  const rc = await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, EVE.token);
  neg(
    rc.status === 200 && rc.body.facet.state === 'STALE',
    'H4 a recheck against the same stale reference stays stale — the recheck is honest, not a refresh button',
  );
  neg(
    expect(
      collect('H5', await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, BEN.token)),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'H5 an analyst cannot recheck a licence',
  );
  const un = await sub(EVE.token, 'national_registration', 'TEST-UNAVAILABLE-1', 'ENG');
  neg(
    expect(collect('I4', un), 503, 'REGULATORY_PROVIDER_UNAVAILABLE') &&
      typeof un.body.retryAfter === 'number' &&
      (await j('GET', '/org/agent/profile', undefined, EVE.token)).body.profile.facets.national_registration.ENG ===
        undefined,
    'I4 a provider outage answers 503 and writes NOTHING (#18)',
  );
  const nv = await sub(EVE.token, 'national_registration', 'TEST-NOTVERIFIED-1', 'ENG');
  neg(
    nv.status === 200 && nv.body.facet.state === 'UNVERIFIED' && /No matching record/.test(nv.body.facet.note),
    'I5 NOT_VERIFIED is recorded as UNVERIFIED with the honest note',
  );
  const ev = await sub(EVE.token, 'fifa_licence', 'TEST-VERIFIED-EVE');
  ok(ev.body.facet.state === 'VERIFIED', 'G7 Eve re-verifies the licence');
  const dom = await sub(EVE.token, 'domestic_authorisation', 'TEST-VERIFIED-BGC', 'USA');
  ok(
    dom.status === 200 && dom.body.profile.facets.domestic_authorisation.USA.state === 'VERIFIED',
    'G8 the fourth facet, domestic authorisation, is recorded separately (USA background check + SafeSport)',
  );
  const manual = await sub(EVE.token, 'national_registration', 'FA-REAL-42', 'ENG');
  neg(
    manual.status === 200 &&
      manual.body.facet.state === 'MANUAL_REVIEW_REQUIRED' &&
      /queued for attributed/.test(manual.body.facet.note),
    'R1 a real-looking reference is MANUAL_REVIEW_REQUIRED and says it is queued for attributed review',
  );
  const ov = await j('GET', '/org/agent/compliance/overview', undefined, EVE.token);
  ok(
    ov.status === 200 &&
      ov.body.counts.reviewsPending === 1 &&
      ov.body.reviews[0].kind === 'verification_facet' &&
      ov.body.reviews[0].status === 'PENDING' &&
      ov.body.provider.live === false &&
      ov.body.freshness.some(
        (f) => f.facet === 'fifa_licence' && f.state === 'VERIFIED' && typeof f.daysUntilRecheck === 'number',
      ),
    "R2 Eve's overview shows one pending review, the honest provider status and facet freshness",
  );
  neg(
    !JSON.stringify(ov.body.reviews).includes('FA-REAL-42') && ov.body.reviews[0].decision === null,
    "R3 the agent's review projection carries no reference and no reviewer material",
  );
  EVE_REVIEW = ov.body.reviews[0].id;
  const list = await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, MARCUS.token);
  ok(
    list.status === 200 &&
      list.body.items.some((r) => r.id === EVE_REVIEW) &&
      list.body.reviewer.id === 'tsr-dev-reviewer',
    'R4 the reviewer sees the pending item',
  );
  const detail = await j('GET', `/ts/compliance/reviews/${EVE_REVIEW}`, undefined, MARCUS.token);
  ok(
    detail.status === 200 &&
      detail.body.subjectDetail.reference === 'FA-REAL-42' &&
      detail.body.subjectDetail.agentDisplayName === 'Eve Laurent' &&
      detail.body.review.honest.includes('not a legal determination'),
    "R5 the reviewer sees exactly the review's need: the reference, the agent name, the state — and the honest framing",
  );
  neg(
    expect(
      collect(
        'R6',
        await j(
          'POST',
          `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
          { outcome: 'APPROVED', reasonCode: 'fa_list_match', reason: 'Listed on the FA register of 18 Sep 2026.' },
          MARCUS.token,
        ),
      ),
      400,
      'REVIEW_INPUT_INVALID',
    ),
    'R6 an approval without evidence references is refused',
  );
  neg(
    expect(
      collect(
        'R7',
        await j(
          'POST',
          `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
          { outcome: 'MAYBE', reasonCode: 'x', reason: 'y', evidenceRefs: ['e'] },
          MARCUS.token,
        ),
      ),
      400,
      'REVIEW_INPUT_INVALID',
    ),
    'R7 an unknown outcome is refused',
  );
  neg(
    expect(
      collect('R8', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/start`, { expectedRev: 9 }, MARCUS.token)),
      409,
      'REVIEW_VERSION_CONFLICT',
    ),
    'AA1 a stale rev is refused',
  );
  const start = await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/start`, { expectedRev: 1 }, MARCUS.token);
  ok(
    start.status === 200 &&
      start.body.review.status === 'IN_REVIEW' &&
      start.body.review.startedBy.id === 'tsr-dev-reviewer',
    'R9 Marcus starts the review; it is attributed to him',
  );
  const before = Date.now();
  const decisionBody = {
    outcome: 'APPROVED',
    reasonCode: 'fa_list_match',
    reason: 'Listed on the FA register of 18 Sep 2026.',
    evidenceRefs: ['FA registered agents list 2026-09-18, row 412'],
    clientKey: 'eve-fa-1',
  };
  for (const [field, value] of [
    ['reviewerId', 'tsr-dev-admin'],
    ['decidedAt', 1_000],
    ['at', 1_000],
  ]) {
    const forged = await j(
      'POST',
      `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
      { ...decisionBody, [field]: value },
      MARCUS.token,
    );
    neg(
      forged.status === 400 &&
        forged.body.error === 'REVIEW_INPUT_INVALID' &&
        forged.body.field === field &&
        forged.body.problem === 'unknown_field',
      `A14b a resolution naming its own ${field} is refused by name`,
    );
  }
  const stillOpen = await j('GET', `/ts/compliance/reviews/${EVE_REVIEW}`, undefined, MARCUS.token);
  neg(stillOpen.body.review.status === 'IN_REVIEW', 'A14c a refused resolution decides nothing');
  const res = await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, decisionBody, MARCUS.token);
  ok(
    res.status === 200 &&
      res.body.review.status === 'APPROVED' &&
      res.body.review.decision.reviewer.id === 'tsr-dev-reviewer' &&
      res.body.review.decision.reviewer.name === 'Marcus Bell' &&
      res.body.review.decision.reviewer.role === 'trust_safety_reviewer',
    'A15 the decision is attributed to Marcus — the reviewer who held the session',
  );
  neg(
    res.body.review.decision.reviewer.id !== 'tsr-dev-admin',
    'A16 the decision names the session reviewer: Marcus cannot be mistaken for Priya (#2)',
  );
  neg(
    res.body.review.decision.at >= before && res.body.review.decidedAt >= before,
    'A17 the decision time is the server clock; a backdated timestamp in the body is ignored',
  );
  ok(
    res.body.review.decision.evidenceRefs.length === 1 &&
      res.body.review.decision.policyVersions.includes('jp-eng-2026-27-1') &&
      res.body.review.decision.priorState.facetState === 'MANUAL_REVIEW_REQUIRED' &&
      res.body.review.decision.resultingState.facetState === 'VERIFIED',
    'A18 the record carries evidence, policy versions, prior and resulting state',
  );
  const prof = await j('GET', '/org/agent/profile', undefined, EVE.token);
  ok(
    prof.body.profile.facets.national_registration.ENG.state === 'VERIFIED' &&
      prof.body.profile.facets.national_registration.ENG.provenance.provider === 'attributed_review' &&
      prof.body.profile.facets.national_registration.ENG.provenance.reviewerId === 'tsr-dev-reviewer' &&
      typeof prof.body.profile.facets.national_registration.ENG.recheckAt === 'number',
    'R10 the facet is VERIFIED with attributed-review provenance naming the reviewer and a recheck date',
  );
  ok(
    (
      await j(
        'POST',
        `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
        {
          outcome: 'APPROVED',
          reasonCode: 'fa_list_match',
          reason: 'Listed on the FA register of 18 Sep 2026.',
          evidenceRefs: ['FA registered agents list 2026-09-18, row 412'],
          clientKey: 'eve-fa-1',
        },
        MARCUS.token,
      )
    ).body.idempotent === true,
    'AB1 replaying the decision with its key is idempotent — no duplicate decision (#29)',
  );
  neg(
    expect(
      collect(
        'AB2',
        await j(
          'POST',
          `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
          { outcome: 'REJECTED', reasonCode: 'x', reason: 'y', clientKey: 'eve-fa-1' },
          MARCUS.token,
        ),
      ),
      409,
      'REVIEW_IDEMPOTENCY_CONFLICT',
    ),
    'AB2 the same key with a different decision is a collision',
  );
  neg(
    expect(
      collect(
        'R11',
        await j(
          'POST',
          `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
          { outcome: 'REJECTED', reasonCode: 'x', reason: 'y' },
          PRIYA.token,
        ),
      ),
      409,
      'REVIEW_NOT_PENDING',
    ),
    'R11 a decided review cannot be decided again',
  );
  const audit = await j('GET', '/ts/compliance/audit', undefined, PRIYA.token);
  ok(
    audit.status === 200 &&
      audit.body.items.some(
        (x) =>
          x.reviewId === EVE_REVIEW &&
          x.action === 'regulatory_review_resolved' &&
          x.reviewer.reviewerId === 'tsr-dev-reviewer' &&
          x.reviewer.attribution === 'authenticated_reviewer' &&
          x.evidenceRefs.length === 1 &&
          x.outcome === 'APPROVED',
      ),
    'A19 the Trust & Safety audit preserves the reviewer identity, role, evidence and outcome',
  );
  neg(
    expect(
      collect('A20', await j('GET', '/ts/compliance/audit', undefined, ANA.token)),
      401,
      'REVIEWER_AUTH_REQUIRED',
    ) &&
      expect(
        collect('A20b', await j('GET', '/ts/compliance/reviews', undefined, kola.token)),
        401,
        'REVIEWER_AUTH_REQUIRED',
      ),
    'A20 an agent or a player token is not a reviewer (#5 foreign user)',
  );
  // Concurrency: two reviewers decide the same review at once.
  const m2 = await sub(EVE.token, 'minors_authorisation', 'FA-MIN-1', 'ENG');
  EVE_REVIEW2 = (await j('GET', '/org/agent/compliance/overview', undefined, EVE.token)).body.reviews.find(
    (r) => r.status === 'PENDING',
  )?.id;
  ok(m2.body.facet.state === 'MANUAL_REVIEW_REQUIRED' && EVE_REVIEW2, 'R12 a second facet review is pending');
  const body = (code) => ({
    outcome: 'APPROVED',
    reasonCode: code,
    reason: 'concurrent',
    evidenceRefs: ['FA letter'],
    expectedRev: 1,
  });
  const [c1, c2] = await Promise.all([
    j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/resolve`, body('one'), MARCUS.token),
    j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/resolve`, body('two'), PRIYA.token),
  ]);
  const wins = [c1, c2].filter((r) => r.status === 200);
  const loses = [c1, c2].filter((r) => r.status === 409);
  neg(
    wins.length === 1 &&
      loses.length === 1 &&
      ['REVIEW_VERSION_CONFLICT', 'REVIEW_NOT_PENDING'].includes(loses[0].body.error),
    'R13 two reviewers resolving at once: exactly one wins, the other gets 409, no double final state (#30)',
  );
  const one = await j('GET', `/ts/compliance/reviews/${EVE_REVIEW2}`, undefined, LEA.token);
  ok(
    one.body.review.status === 'APPROVED' &&
      ['tsr-dev-reviewer', 'tsr-dev-admin'].includes(one.body.review.decision.reviewer.id) &&
      one.body.review.history === undefined,
    'R14 one decision, one named reviewer',
  );
  // Supersession keeps the old decision.
  const sup = await j(
    'POST',
    `/ts/compliance/reviews/${EVE_REVIEW2}/supersede`,
    { reason: 'New evidence: the FA letter was withdrawn.' },
    PRIYA.token,
  );
  ok(
    sup.status === 201 &&
      sup.body.review.status === 'PENDING' &&
      sup.body.review.supersedes === EVE_REVIEW2 &&
      sup.body.superseded.status === 'SUPERSEDED' &&
      sup.body.superseded.decision?.outcome === 'APPROVED',
    'R15 reconsideration creates a superseding review; the old final decision is retained, never rewritten',
  );
  neg(
    expect(
      collect(
        'R16',
        await j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/supersede`, { reason: 'again' }, PRIYA.token),
      ),
      409,
      'REVIEW_NOT_PENDING',
    ),
    'R16 a superseded review cannot be superseded again',
  );
  const rej = await j(
    'POST',
    `/ts/compliance/reviews/${sup.body.review.id}/resolve`,
    { outcome: 'REJECTED', reasonCode: 'letter_withdrawn', reason: 'The FA letter was withdrawn.' },
    LEA.token,
  );
  ok(
    rej.status === 200 &&
      (await j('GET', '/org/agent/profile', undefined, EVE.token)).body.profile.facets.minors_authorisation.ENG
        .state === 'UNVERIFIED',
    'R17 the superseding decision (rejected) takes effect: the facet is UNVERIFIED again',
  );
  const cancelMe = await sub(DAN.token, 'minors_authorisation', 'FA-MIN-D', 'ENG');
  const cr = (await j('GET', '/org/agent/compliance/overview', undefined, DAN.token)).body.reviews.find(
    (r) => r.status === 'PENDING',
  )?.id;
  neg(
    expect(
      collect('R18', await j('POST', `/ts/compliance/reviews/${cr}/cancel`, {}, PRIYA.token)),
      400,
      'REVIEW_INPUT_INVALID',
    ),
    'R18 a cancellation needs a reason',
  );
  ok(
    cancelMe.status === 200 &&
      (await j('POST', `/ts/compliance/reviews/${cr}/cancel`, { reason: 'duplicate submission' }, PRIYA.token)).body
        .review.status === 'CANCELLED',
    'R19 an administrator cancels a review with a reason',
  );
  neg(
    expect(
      collect(
        'R20',
        await j(
          'POST',
          `/ts/compliance/reviews/${cr}/resolve`,
          { outcome: 'APPROVED', reasonCode: 'x', reason: 'y', evidenceRefs: ['e'] },
          PRIYA.token,
        ),
      ),
      409,
      'REVIEW_NOT_PENDING',
    ),
    'R20 a cancelled review cannot be decided',
  );
  neg(
    expect(
      collect('R21', await j('GET', '/ts/compliance/reviews/__proto__', undefined, PRIYA.token)),
      404,
      'REVIEW_NOT_FOUND',
    ) &&
      expect(
        collect('R21b', await j('POST', '/ts/compliance/reviews/constructor/start', {}, PRIYA.token)),
        404,
        'REVIEW_NOT_FOUND',
      ),
    'R21 prototype names are not reviews',
  );
}

// ============================================================ K–O — contexts over HTTP
section('K–O — compliance contexts: the regulated declaration re-authorises at mutation time');
let CTX1, CTX1_REV, KOLA_CONSENT, CLUB_CONSENT, MARIA_ID;
{
  neg(
    expect(
      collect(
        'K8',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          { type: 'employment_contract', jurisdictions: ['ENG'] },
          BEN.token,
        ),
      ),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'K8 an analyst cannot open a context (#25)',
  );
  neg(
    expect(
      collect(
        'K9',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          { type: 'employment_contract', jurisdictions: ['ENG'] },
          tomas.token,
        ),
      ),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'K9 an agency administrator without the licensed_agent role cannot either (#26)',
  );
  neg(
    expect(
      collect(
        'K10',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          { type: 'employment_contract', jurisdictions: ['ENG'] },
          maria.token,
        ),
      ),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'K10 a club user has no agent workspace',
  );
  neg(
    expect(
      collect(
        'K11',
        await j('POST', '/org/agent/compliance/contexts', { type: 'offer', jurisdictions: ['ENG'] }, ANA.token),
      ),
      400,
      'CONTEXT_INPUT_INVALID',
    ) &&
      expect(
        collect(
          'K11b',
          await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: [] }, ANA.token),
        ),
        400,
        'CONTEXT_INPUT_INVALID',
      ),
    'K11 "offer" is not a context type; jurisdictions are required',
  );
  neg(
    expect(
      collect(
        'K12',
        await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['FRA'] }, ANA.token),
      ),
      422,
      'JURISDICTION_UNSUPPORTED',
    ),
    'K12 an unsupported jurisdiction cannot open a context (#17)',
  );
  const minorTry = collect(
    'K13',
    await j(
      'POST',
      '/org/agent/compliance/contexts',
      {
        type: 'employment_contract',
        jurisdictions: ['ENG'],
        parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }],
      },
      ANA.token,
    ),
  );
  const noneTry = collect(
    'K13b',
    await j(
      'POST',
      '/org/agent/compliance/contexts',
      {
        type: 'employment_contract',
        jurisdictions: ['ENG'],
        parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-nobody' }],
      },
      ANA.token,
    ),
  );
  neg(
    expect(minorTry, 404, 'PARTY_NOT_FOUND') &&
      expect(noneTry, 404, 'PARTY_NOT_FOUND') &&
      JSON.stringify(minorTry.body) === JSON.stringify(noneTry.body),
    'K13 a minor and a non-existent player answer with byte-identical bodies (#23)',
  );
  const contextsBeforeK14 = (await j('GET', '/org/agent/compliance/contexts', undefined, ANA.token)).body.items.length;
  const k14 = collect(
    'K14',
    await j(
      'POST',
      '/org/agent/compliance/contexts',
      {
        type: 'employment_contract',
        jurisdictions: ['ENG'],
        parties: [
          {
            partyRole: 'individual',
            subjectKind: 'player',
            subjectId: 'pl-tomasz',
            guardianConsent: true,
            dob: '2000-01-01',
          },
        ],
      },
      ANA.token,
    ),
  );
  neg(
    expect(k14, 400, 'CONTEXT_INPUT_INVALID') &&
      // Either forged field may be named: JSON object members carry no order a client relies on.
      ['parties[0].guardianConsent', 'parties[0].dob'].includes(k14.body.field) &&
      k14.body.problem === 'unknown_field' &&
      (await j('GET', '/org/agent/compliance/contexts', undefined, ANA.token)).body.items.length === contextsBeforeK14,
    'K14 a forged guardian consent or a client-supplied date of birth is refused by name, and nothing is opened (#19, #20)',
  );
  neg(
    expect(
      collect(
        'K15',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [{ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-nope' }],
          },
          ANA.token,
        ),
      ),
      404,
      'PARTY_NOT_FOUND',
    ),
    'K15 an unknown club is 404',
  );
  const create = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
      clientKey: 'ctx-1',
    },
    ANA.token,
  );
  ok(
    create.status === 201 &&
      create.body.context.status === 'open' &&
      create.body.context.scope === 'national' &&
      create.body.context.clearance.outcome === 'CLEAR' &&
      create.body.context.parties.length === 2 &&
      create.body.context.parties[0].name === 'Kola Adeyemi',
    'K16 Ana opens an England employment context with Kola and Eastport FC; with no representation declared it evaluates CLEAR',
  );
  CTX1 = create.body.context.id;
  ok(
    (
      await j(
        'POST',
        '/org/agent/compliance/contexts',
        {
          type: 'employment_contract',
          jurisdictions: ['ENG'],
          parties: [
            { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
            { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
          ],
          clientKey: 'ctx-1',
        },
        ANA.token,
      )
    ).body.idempotent === true,
    'AB3 the creation key replays',
  );
  neg(
    expect(
      collect(
        'AB4',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          { type: 'transfer', jurisdictions: ['ENG'], clientKey: 'ctx-1' },
          ANA.token,
        ),
      ),
      409,
      'CONTEXT_IDEMPOTENCY_CONFLICT',
    ),
    'AB4 the same key with a different payload collides',
  );
  neg(
    expect(
      collect(
        'AB4b',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [
              { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
              { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-other' },
            ],
            clientKey: 'ctx-1',
          },
          ANA.token,
        ),
      ),
      409,
      'CONTEXT_IDEMPOTENCY_CONFLICT',
    ),
    'AB4b the same key with different parties collides, not a replay of the first context',
  );
  neg(
    expect(
      collect(
        'K17',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/representations`,
          { partyRole: 'individual', agreementId: REL_MATEUS },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    'K17 an agreement with a different client authorises nothing here',
  );
  neg(
    expect(
      collect(
        'K18',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/representations`,
          { partyRole: 'individual', agreementId: REL_CHINEDU },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    "K18 a colleague's agreement is not the agent's",
  );
  const ctxT = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }],
    },
    ANA.token,
  );
  neg(
    expect(
      collect(
        'J9',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${ctxT.body.context.id}/representations`,
          { partyRole: 'individual', agreementId: REL_THEO },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_SCOPE_INSUFFICIENT',
    ) &&
      (
        await j(
          'POST',
          `/org/agent/compliance/contexts/${ctxT.body.context.id}/representations`,
          { partyRole: 'individual', agreementId: REL_THEO },
          ANA.token,
        )
      ).body.required.join() === 'employment',
    'J9 a commercial-only agreement does not cover an employment contract; the refusal names the scope needed',
  );
  globalThis.CTX_THEO = ctxT.body.context.id;
  const dec = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/representations`,
    { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-kola' },
    ANA.token,
  );
  ok(
    dec.status === 201 &&
      dec.body.representation.status === 'verified' &&
      dec.body.evaluation.outcome === 'CLEAR' &&
      dec.body.context.representations[0].firstActAt > 0 &&
      dec.body.context.clearance.policyVersions.join() === 'jp-fifa-2025-1,jp-eng-2026-27-1',
    'K19 Ana declares she represents Kola under the active confirmed agreement → recorded, CLEAR, versioned',
  );
  ok(
    (
      await j(
        'POST',
        `/org/agent/compliance/contexts/${CTX1}/representations`,
        { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-kola' },
        ANA.token,
      )
    ).body.idempotent === true,
    'AB5 the declaration key replays',
  );
  neg(
    expect(
      collect(
        'K20',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/representations`,
          { partyRole: 'individual', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      409,
      'CONTEXT_PARTY_EXISTS',
    ),
    'K20 a party is represented once',
  );
  CTX1_REV = dec.body.context.rev;
  const club = collect(
    'L7',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX1}/representations`,
      { partyRole: 'engaging_entity' },
      ANA.token,
    ),
  );
  neg(
    expect(club, 422, 'REGULATORY_REVIEW_REQUIRED') &&
      club.body.reviewId &&
      club.body.reasons.some((r) => r.code === 'REPRESENTATION_UNVERIFIED') &&
      /not effective until/.test(club.body.message),
    'L7 declaring the engaging club — an entity with no ScoutBox agreement — records a declared-only representation and needs attributed review (DR-18)',
  );
  const c1 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(
    c1.body.context.representations.find((r) => r.partyRole === 'engaging_entity').status === 'pending_review' &&
      c1.body.context.clearance.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED',
    'L8 the context shows the pending representation and a manual-review clearance',
  );
  const approve = await j(
    'POST',
    `/ts/compliance/reviews/${club.body.reviewId}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'club_mandate_seen',
      reason: 'The club mandate letter was examined.',
      evidenceRefs: ['Eastport FC mandate letter, 12 Sep 2026'],
    },
    MARCUS.token,
  );
  ok(
    approve.status === 200 && approve.body.review.decision.resultingState.representationStatus === 'verified',
    'L9 Marcus confirms the fact; the representation becomes verified',
  );
  const c2 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(
    c2.body.context.clearance.outcome === PERMITTED_WITH_CONSENT &&
      c2.body.context.clearance.alias === 'PERMITTED_WITH_CONSENT' &&
      c2.body.context.clearance.consentsOutstanding
        .map((x) => x.partyRole)
        .sort()
        .join() === 'engaging_entity,individual',
    'L10 with both parties represented the clearance is PERMITTED_WITH_CONSENT: consent is outstanding from the individual AND the engaging club',
  );
  neg(
    expect(
      collect(
        'L11',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/consents/request`,
          { partyRole: 'releasing_entity' },
          ANA.token,
        ),
      ),
      404,
      'PARTY_NOT_FOUND',
    ),
    'L11 consent can only be requested from a party that exists',
  );
  neg(
    expect(
      collect(
        'L12',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/consents/request`,
          { partyRole: 'individual' },
          DAN.token,
        ),
      ),
      404,
      'CONTEXT_NOT_FOUND',
    ),
    "L12 a colleague cannot request consent in Ana's context (personal record; 404 not 403)",
  );
  const req1 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/consents/request`,
    {
      partyRole: 'individual',
      fullParticularsProvided: true,
      legalAdviceOffered: true,
      proposedFeeDisclosed: true,
      clientKey: 'cons-kola',
    },
    ANA.token,
  );
  ok(
    req1.status === 201 && req1.body.consent.status === 'requested' && req1.body.consent.ruleIds.join() === 'ENG-6.3',
    "P1 Ana requests Kola's written consent under ENG-6.3",
  );
  KOLA_CONSENT = req1.body.consent.id;
  ok(
    (
      await j(
        'POST',
        `/org/agent/compliance/contexts/${CTX1}/consents/request`,
        {
          partyRole: 'individual',
          fullParticularsProvided: true,
          legalAdviceOffered: true,
          proposedFeeDisclosed: true,
          clientKey: 'cons-kola',
        },
        ANA.token,
      )
    ).body.idempotent === true,
    'AB6 the consent request key replays',
  );
  neg(
    expect(
      collect(
        'P2',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/consents/request`,
          { partyRole: 'individual' },
          ANA.token,
        ),
      ),
      409,
      'CONSENT_ALREADY_REQUESTED',
    ),
    'P2 not requested twice while one is open',
  );
  const kl = await j('GET', '/player/agent/consents', undefined, kola.token);
  ok(
    kl.status === 200 &&
      kl.body.items.length === 1 &&
      kl.body.items[0].agent.displayName === 'Ana Costa' &&
      kl.body.items[0].agent.agency === 'North Star Sports Agency' &&
      kl.body.items[0].context.parties.some((p) => p.name === 'Eastport FC') &&
      kl.body.items[0].otherPartyRoles.join() === 'engaging_entity' &&
      /You may decline/.test(kl.body.items[0].honest),
    'P3 Kola sees who asks, for which transaction, which other party, and that he may decline',
  );
  neg(!JSON.stringify(kl.body).match(/\bfee\b|commission|%/i), 'P4 no fee term reaches the consent view');
  neg(
    (await j('GET', '/player/agent/consents', undefined, mateus.token)).body.items.length === 0 &&
      expect(
        collect(
          'P5',
          await j(
            'POST',
            `/player/agent/consents/${KOLA_CONSENT}/grant`,
            { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
            mateus.token,
          ),
        ),
        404,
        'CONSENT_NOT_FOUND',
      ),
    'P5 another player sees nothing and cannot answer for Kola (#13)',
  );
  neg(
    (await j('GET', '/player/agent/consents', undefined, guni.token)).body.minor === true &&
      expect(
        collect(
          'P6',
          await j(
            'POST',
            `/player/agent/consents/${KOLA_CONSENT}/grant`,
            { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
            guni.token,
          ),
        ),
        403,
        'COMPLIANCE_ACTION_NOT_PERMITTED',
      ),
    'P6 a minor has no consents and cannot act',
  );
  neg(
    expect(
      collect(
        'P7',
        await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true }, kola.token),
      ),
      400,
      'CONSENT_INPUT_INVALID',
    ),
    'P7 a grant needs both acknowledgements',
  );
  neg(
    expect(
      collect(
        'AA2',
        await j(
          'POST',
          `/player/agent/consents/${KOLA_CONSENT}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, expectedRev: 7 },
          kola.token,
        ),
      ),
      409,
      'CONSENT_VERSION_CONFLICT',
    ),
    'AA2 a stale rev on a consent is refused',
  );
  const forgedGrant = await j(
    'POST',
    `/player/agent/consents/${KOLA_CONSENT}/grant`,
    { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, grantedAt: 1_000, clientKey: 'kola-forged' },
    kola.token,
  );
  neg(
    expect(forgedGrant, 400, 'CONSENT_INPUT_INVALID') &&
      forgedGrant.body.field === 'grantedAt' &&
      forgedGrant.body.problem === 'unknown_field' &&
      (await j('GET', '/player/agent/consents', undefined, kola.token)).body.items.find((k) => k.id === KOLA_CONSENT)
        ?.status === 'requested',
    'P8a a grant naming its own grantedAt is refused, and the consent stays requested',
  );
  const t1 = Date.now();
  const grant = await j(
    'POST',
    `/player/agent/consents/${KOLA_CONSENT}/grant`,
    { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, clientKey: 'kola-grant' },
    kola.token,
  );
  ok(
    grant.status === 200 && grant.body.consent.status === 'granted' && grant.body.consent.grantedAt >= t1,
    "P8 Kola grants; the timestamp is the server's",
  );
  ok(
    (
      await j(
        'POST',
        `/player/agent/consents/${KOLA_CONSENT}/grant`,
        { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, clientKey: 'kola-grant' },
        kola.token,
      )
    ).body.idempotent === true,
    'AB7 the grant key replays',
  );
  const c3 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(
    c3.body.context.clearance.outcome === PERMITTED_WITH_CONSENT &&
      c3.body.context.clearance.consentsOutstanding.map((x) => x.partyRole).join() === 'engaging_entity',
    "P9 the context re-evaluated on the grant: only the club's consent is outstanding now",
  );
  const req2 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/consents/request`,
    {
      partyRole: 'engaging_entity',
      fullParticularsProvided: true,
      legalAdviceOffered: true,
      proposedFeeDisclosed: true,
    },
    ANA.token,
  );
  ok(req2.status === 201, "P10 Ana requests the club's consent");
  CLUB_CONSENT = req2.body.consent.id;
  const ml = await j('GET', '/org/compliance/consents', undefined, maria.token);
  ok(
    ml.status === 200 && ml.body.items.length === 1 && ml.body.signatory === false,
    'P11 Eastport sees the request; Maria is not yet a recorded signatory',
  );
  neg(
    expect(
      collect(
        'P12',
        await j(
          'POST',
          `/org/compliance/consents/${CLUB_CONSENT}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          maria.token,
        ),
      ),
      403,
      'SIGNATORY_REQUIRED',
    ),
    'P12 a club user who is not a recorded signatory cannot bind the club',
  );
  neg(
    expect(
      collect(
        'P13',
        await j(
          'POST',
          `/org/compliance/consents/${CLUB_CONSENT}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          harbour.token,
        ),
      ),
      404,
      'CONSENT_NOT_FOUND',
    ),
    'P13 another club cannot see or answer it',
  );
  neg(
    expect(
      collect(
        'P14',
        await j(
          'POST',
          `/org/compliance/consents/${CLUB_CONSENT}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          ANA.token,
        ),
      ),
      404,
      'CONSENT_NOT_FOUND',
    ),
    "P14 the agent cannot consent on the club's behalf",
  );
  MARIA_ID = maria.userId;
  const appoint = await j(
    'POST',
    '/admin/verification/orgs/org-eastport/appoint-root',
    { userId: MARIA_ID, reason: 'compliance suite: club signatory' },
    PRIYA.token,
    ADMIN,
  );
  ok(
    appoint.status === 201 && appoint.body.rootAdminUserId === MARIA_ID,
    "P15 Trust & Safety records Maria as Eastport's verification root (the club signatory), attributed to Priya's session",
  );
  const cg = await j(
    'POST',
    `/org/compliance/consents/${CLUB_CONSENT}/grant`,
    { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
    maria.token,
  );
  ok(cg.status === 200 && cg.body.consent.status === 'granted', 'P16 the signatory grants for the club');
  const c4 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(
    c4.body.context.clearance.outcome === 'CLEAR' &&
      c4.body.context.clearance.reasons.some((r) => r.code === 'DUAL_CONSENTED') &&
      c4.body.context.clearance.current === true,
    'L13 with both party-specific consents recorded the clearance is CLEAR (DUAL_CONSENTED)',
  );
}

// ============================================================ S/T — revocation, stale submits, party change
section('S/T — revocation, stale client submits, party change invalidates the prior check');
{
  const rv = await j('POST', `/player/agent/consents/${KOLA_CONSENT}/revoke`, { clientKey: 'kola-revoke' }, kola.token);
  ok(
    rv.status === 200 && rv.body.consent.status === 'revoked' && typeof rv.body.consent.revokedAt === 'number',
    'R22 Kola revokes his consent',
  );
  const R0 = readRows(DATA_DIR);
  const granted = R0.row('regulatory_consents', { id: KOLA_CONSENT });
  const revRow = R0.row('regulatory_consent_revocations', { consent_id: KOLA_CONSENT });
  R0.close();
  neg(
    granted.status === 'granted' && revRow && revRow.revoked_at > granted.granted_at,
    'AE4 the ledger is append-only: the granted row is untouched and the revocation is a new row',
  );
  const c5 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  neg(
    c5.body.context.clearance.outcome === PERMITTED_WITH_CONSENT &&
      c5.body.context.clearance.consentsOutstanding[0].reasonCode === 'CONSENT_REVOKED',
    "S5 the context re-evaluated at once: the individual's consent is outstanding again (revoked)",
  );
  const wd = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/representations/${c5.body.context.representations[0].id}/withdraw`,
    {},
    ANA.token,
  );
  ok(
    wd.status === 200 && wd.body.context.representations[0].status === 'withdrawn',
    'S6 Ana withdraws her own representation of Kola',
  );
  neg(
    expect(
      collect(
        'S7',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/representations`,
          { partyRole: 'individual', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      422,
      'CONSENT_REQUIRED',
    ),
    'S7 a stale client re-submitting the declaration after the revocation is refused at mutation time — nothing recorded (#12)',
  );
  neg(
    (
      await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)
    ).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1,
    'S8 only the club representation remains',
  );
  const req3 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/consents/request`,
    { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true },
    ANA.token,
  );
  ok(req3.status === 201, 'Q2 after a revocation a new request may be made');
  const dc = await j('POST', `/player/agent/consents/${req3.body.consent.id}/decline`, {}, kola.token);
  ok(dc.status === 200 && dc.body.consent.status === 'declined', 'Q3 Kola declines');
  neg(
    expect(
      collect(
        'Q4',
        await j(
          'POST',
          `/player/agent/consents/${req3.body.consent.id}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          kola.token,
        ),
      ),
      409,
      'CONSENT_NOT_PENDING',
    ),
    'Q4 a declined consent cannot then be granted',
  );
  neg(
    expect(
      collect('Q5', await j('POST', `/player/agent/consents/${req3.body.consent.id}/revoke`, {}, kola.token)),
      409,
      'CONSENT_NOT_PENDING',
    ),
    'Q5 nor revoked',
  );
  neg(
    expect(
      collect(
        'S9',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/representations`,
          { partyRole: 'individual', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      422,
      'CONSENT_REQUIRED',
    ),
    'S9 a declined consent is not consent: the declaration is still refused',
  );
  const req4 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/consents/request`,
    { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true },
    ANA.token,
  );
  ok(
    req4.status === 201 &&
      (
        await j(
          'POST',
          `/player/agent/consents/${req4.body.consent.id}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          kola.token,
        )
      ).body.consent.status === 'granted',
    'Q6 asked again, Kola grants',
  );
  const redo = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/representations`,
    { partyRole: 'individual', agreementId: REL_KOLA },
    ANA.token,
  );
  ok(
    redo.status === 201 && redo.body.evaluation.outcome === 'CLEAR',
    'S10 with current consents the declaration is recorded and CLEAR',
  );
  const ctx = (await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context;
  const before = ctx.evaluationCount;
  neg(
    expect(
      collect(
        'T1',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/parties`,
          { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-harbour' },
          ANA.token,
        ),
      ),
      409,
      'CONTEXT_PARTY_EXISTS',
    ),
    'T1 the engaging club cannot be silently swapped: a role is filled once (#9)',
  );
  neg(
    expect(
      collect(
        'AA3',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/parties`,
          { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour', expectedRev: ctx.rev + 5 },
          ANA.token,
        ),
      ),
      409,
      'CONTEXT_VERSION_CONFLICT',
    ),
    'AA3 a stale context rev is refused',
  );
  const add = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX1}/parties`,
    { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour', expectedRev: ctx.rev },
    ANA.token,
  );
  ok(
    add.status === 201 && add.body.context.evaluationCount === before + 1 && add.body.evaluation.outcome === 'CLEAR',
    'T2 adding the releasing club re-evaluates the context at once (#10, #11); with no representation of it the clearance stays CLEAR',
  );
  const rel = collect(
    'T3',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX1}/representations`,
      { partyRole: 'releasing_entity' },
      ANA.token,
    ),
  );
  neg(
    expect(rel, 403, 'REPRESENTATION_CONFLICT') &&
      rel.body.outcome === 'PROHIBITED_CONFLICT' &&
      rel.body.reasons.some(
        (r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleId === 'ENG-6.4' && r.ruleStatus === 'ACTIVE',
      ),
    'T3 declaring the releasing club too is REFUSED outright under the ACTIVE prohibition — an entity with no ScoutBox agreement does not soften it into review',
  );
  {
    const after = (await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context;
    const queue = (await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, MARCUS.token)).body.items;
    neg(
      rel.body.reviewId === undefined &&
        !after.representations.some((r) => r.partyRole === 'releasing_entity' && r.status !== 'withdrawn') &&
        !queue.some((r) => r.subject?.contextId === CTX1 && r.subject?.partyRole === 'releasing_entity'),
      'T4 nothing was recorded: no representation, no review id in the refusal, and no review item a reviewer could never resolve (#28)',
    );
  }
  neg(
    expect(
      collect(
        'T6',
        await j('POST', `/org/agent/compliance/contexts/${CTX1}/override`, { outcome: 'CLEAR' }, ANA.token),
      ),
      404,
      null,
    ),
    'T6 the agent has no override route (#27)',
  );
  {
    const forged = await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX1}/evaluate`,
      { outcome: 'CLEAR', clearance: 'CLEAR' },
      ANA.token,
    );
    const clean = await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, {}, ANA.token);
    neg(
      expect(forged, 400, 'CONTEXT_INPUT_INVALID') &&
        // Either forged field may be named: JSON object members carry no order a client relies on.
        ['outcome', 'clearance'].includes(forged.body.field) &&
        forged.body.problem === 'unknown_field' &&
        clean.body.evaluation.outcome === 'CLEAR',
      'T7 an outcome in the body is refused by name; the engine alone decides it (#27)',
    );
  }
  // A prohibited combination refused at mutation time, nothing recorded.
  const ctx2 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'transfer',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
        { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' },
      ],
    },
    ANA.token,
  );
  const r2 = collect(
    'M4',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${ctx2.body.context.id}/representations`,
      { partyRole: 'releasing_entity' },
      ANA.token,
    ),
  );
  const ap = await j(
    'POST',
    `/ts/compliance/reviews/${r2.body.reviewId}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'club_mandate_seen',
      reason: 'Harbour City mandate seen.',
      evidenceRefs: ['Harbour City FC mandate, 1 Sep 2026'],
    },
    MARCUS.token,
  );
  ok(
    ctx2.status === 201 &&
      r2.status === 422 &&
      ap.status === 200 &&
      ap.body.review.decision.resultingState.representationStatus === 'verified',
    "M4 in a transfer context Ana is confirmed as the releasing club's agent",
  );
  const m5 = collect(
    'M5',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${ctx2.body.context.id}/representations`,
      { partyRole: 'individual', agreementId: REL_KOLA },
      ANA.token,
    ),
  );
  neg(
    expect(m5, 403, 'REPRESENTATION_CONFLICT') &&
      m5.body.reasons.some((r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleStatus === 'ACTIVE') &&
      m5.body.outcome === 'PROHIBITED_CONFLICT',
    'M5 declaring the individual as well → 403 REPRESENTATION_CONFLICT under the ACTIVE rule; nothing is recorded',
  );
  ok(
    (
      await j('GET', `/org/agent/compliance/contexts/${ctx2.body.context.id}`, undefined, ANA.token)
    ).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1,
    'M6 the context still holds one representation',
  );
  globalThis.CTX2 = ctx2.body.context.id;
}

// ============================================================ N/O — uncertain FIFA rule, connected agents over HTTP
section('N/O — an uncertain rule goes to attributed review; a colleague is attributed');
let CTX3, CTX3_REVIEW;
{
  const ctx3 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['INT'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
    },
    ANA.token,
  );
  CTX3 = ctx3.body.context.id;
  ok(ctx3.status === 201 && ctx3.body.context.scope === 'international', 'N9 an international-dimension context');
  const club = collect(
    'N10',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX3}/representations`,
      { partyRole: 'engaging_entity' },
      ANA.token,
    ),
  );
  const ap = await j(
    'POST',
    `/ts/compliance/reviews/${club.body.reviewId}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'club_mandate_seen',
      reason: 'Eastport mandate seen.',
      evidenceRefs: ['Eastport FC mandate, 12 Sep 2026'],
    },
    MARCUS.token,
  );
  ok(club.status === 422 && ap.status === 200, 'N10 the club representation is confirmed by review');
  const ind = collect(
    'N11',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX3}/representations`,
      { partyRole: 'individual', agreementId: REL_MATEUS },
      ANA.token,
    ),
  );
  neg(
    expect(ind, 422, 'REGULATORY_REVIEW_REQUIRED') &&
      ind.body.reasons.some(
        (r) => r.code === 'RULE_STATUS_UNCERTAIN' && r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'UNDER_LEGAL_REVIEW',
      ) &&
      ind.body.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED',
    'N11 declaring Mateus too under the FIFA text: the deciding rule is UNDER_LEGAL_REVIEW → attributed review, never CLEAR, never prohibited',
  );
  CTX3_REVIEW = ind.body.reviewId;
  neg(
    (
      await j('GET', `/org/agent/compliance/contexts/${CTX3}`, undefined, ANA.token)
    ).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1,
    'N12 nothing was recorded for Mateus',
  );
  neg(
    expect(
      collect(
        'N13',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX3}/consents/request`,
          { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true },
          ANA.token,
        ),
      ),
      422,
      'REGULATORY_REVIEW_REQUIRED',
    ),
    'N13 consent cannot be requested under an uncertain rule — consent would not cure it',
  );
  neg(
    expect(
      collect(
        'N14',
        await j(
          'POST',
          `/ts/compliance/reviews/${CTX3_REVIEW}/resolve`,
          { outcome: 'APPROVED', reasonCode: 'looks_fine', reason: 'Seems permitted.', evidenceRefs: ['FAQ'] },
          PRIYA.token,
        ),
      ),
      409,
      'REVIEW_REQUIRES_POLICY_VERSION',
    ),
    'N14 a reviewer cannot approve past an uncertain rule: only a published policy version can settle it',
  );
  const rv = await j('GET', `/ts/compliance/reviews/${CTX3_REVIEW}`, undefined, PRIYA.token);
  ok(
    rv.body.review.status === 'PENDING' &&
      rv.body.review.policyVersions.join() === 'jp-fifa-2025-1' &&
      rv.body.review.snapshot.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED',
    'N15 the review item preserves the evaluation snapshot and the policy version it was made under',
  );
  // Connected agents: Dan's context on the same transaction.
  const ctx4 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-okafor' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
    },
    DAN.token,
  );
  const d1 = await j(
    'POST',
    `/org/agent/compliance/contexts/${ctx4.body.context.id}/representations`,
    { partyRole: 'individual', agreementId: REL_CHINEDU },
    DAN.token,
  );
  ok(
    ctx4.status === 201 && d1.status === 201 && d1.body.evaluation.outcome === 'CLEAR',
    'O5 Dan represents Chinedu in an England employment context: CLEAR',
  );
  const ctx5 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-okafor' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
    },
    ANA.token,
  );
  const a1 = collect(
    'O6',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${ctx5.body.context.id}/representations`,
      { partyRole: 'engaging_entity' },
      ANA.token,
    ),
  );
  await j(
    'POST',
    `/ts/compliance/reviews/${a1.body.reviewId}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'club_mandate_seen',
      reason: 'Eastport mandate seen.',
      evidenceRefs: ['Eastport FC mandate, 12 Sep 2026'],
    },
    MARCUS.token,
  );
  const d2 = await j('POST', `/org/agent/compliance/contexts/${ctx4.body.context.id}/evaluate`, {}, DAN.token);
  neg(
    d2.body.evaluation.outcome === PERMITTED_WITH_CONSENT &&
      d2.body.evaluation.reasons.some(
        (r) =>
          r.code === 'CONNECTED_AGENT_ATTRIBUTION' &&
          r.ruleId === 'ENG-6.5' &&
          r.partyRoles.join() === 'engaging_entity',
      ),
    'O6 Ana — a colleague at the same agency — being confirmed for the engaging club in the SAME transaction is attributed to Dan: his clearance is now consent-required (FA 6.5)',
  );
  neg(
    !JSON.stringify(d2.body).includes(ANA_ID) && !JSON.stringify(d2.body).includes('Ana Costa'),
    'O7 the attribution names party roles only — never the colleague',
  );
  globalThis.CTX4 = ctx4.body.context.id;
}

// ============================================================ U/V/W — minors over HTTP
section('U/V/W — minors: readiness is evaluated against no subject; discovery stays closed');
{
  const ov = await j('GET', '/org/agent/compliance/overview', undefined, ANA.token);
  const eng = ov.body.minorReadiness.find((m) => m.memberAssociation === 'ENG');
  neg(
    eng &&
      eng.pathwayEnabledInProduction === false &&
      eng.timingEncoded === true &&
      eng.agentReady === false &&
      eng.gaps.some((g) => g.facet === 'minors_authorisation') &&
      /prohibited/.test(eng.honest),
    'U10 England: the timing rule is encoded, the agent is not ready (no minors authorisation), and no pathway is live',
  );
  const sub = (facet, reference, ma) =>
    j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, memberAssociation: ma }, ANA.token);
  ok(
    (await sub('minors_authorisation', 'TEST-VERIFIED-MIN-ENG', 'ENG')).body.facet.state === 'VERIFIED' &&
      (await sub('minors_authorisation', 'TEST-VERIFIED-MIN-INT', 'INT')).status === 400,
    'U11 an England minors authorisation is recorded; INT is not a member association for it',
  );
  const ov2 = await j('GET', '/org/agent/compliance/overview', undefined, ANA.token);
  const eng2 = ov2.body.minorReadiness.find((m) => m.memberAssociation === 'ENG');
  neg(
    eng2.pathwayEnabledInProduction === false && eng2.gaps.every((g) => g.memberAssociation === 'INT'),
    'U12 with the FA authorisation the only gap left is the FIFA minors accreditation — and the pathway is STILL not live',
  );
  neg(
    (await j('GET', '/org/agent/players?q=gu', undefined, ANA.token)).body.items.length === 0 &&
      (await j('GET', '/org/agent/players?q=tom', undefined, ANA.token)).body.items.length === 0,
    "U13 minors remain invisible to the lookup whatever the agent's accreditation",
  );
  neg(
    expect(
      collect(
        'U14',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX1}/parties`,
          { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' },
          ANA.token,
        ),
      ),
      404,
      'PARTY_NOT_FOUND',
    ),
    'U14 adding a minor to an open context is the uniform 404 even though the role is already filled — no oracle on the role, no oracle on the minor',
  );
  neg(
    expect(
      collect('U15', await j('POST', '/org/agent/compliance/minors/approach', { playerId: 'pl-guni' }, ANA.token)),
      404,
      null,
    ) &&
      expect(
        collect('U15b', await j('POST', '/org/agent/compliance/minors/evaluate', { dob: '2011-03-15' }, ANA.token)),
        404,
        null,
      ),
    'U15 no minors approach or subject-evaluation route exists',
  );
}

// ============================================================ agency markets
section('agency markets — the jurisdictions an agency declares in its settings count for every member');
{
  const marketsOf = (body) => [...body.inEffect.map((p) => p.jurisdiction), ...body.missing];
  neg(
    !marketsOf((await j('GET', '/org/agent/compliance/policies', undefined, DAN.token)).body).includes('USA'),
    'AM1 before: Dan declares only England, so no US rules apply to him',
  );
  const set = await j('PATCH', '/org/agent/agency/settings', { jurisdictions: ['USA'] }, tomas.token);
  ok(
    set.status === 200 && set.body.settings.jurisdictions.includes('USA'),
    'AM2 the agency administrator declares the United States as an agency market',
  );
  ok(
    marketsOf((await j('GET', '/org/agent/compliance/policies', undefined, DAN.token)).body).includes('USA'),
    'AM3 the policy set for Dan now covers the agency market too',
  );
  const ov = await j('GET', '/org/agent/compliance/overview', undefined, DAN.token);
  ok(
    ov.body.minorReadiness.some((m) => m.memberAssociation === 'USA') &&
      ov.body.minorReadiness.some((m) => m.memberAssociation === 'ENG'),
    'AM4 and so does his compliance overview, beside his own England declaration',
  );
  ok(
    (await j('PATCH', '/org/agent/agency/settings', { jurisdictions: [] }, tomas.token)).status === 200,
    'AM5 (the agency markets are cleared again for the rest of the run)',
  );
}

// ============================================================ X/Y/Z — blocks, tenant, privacy
section('X/Y/Z — blocks beat clearance; tenancy; nothing private in a refusal');
{
  const blk = await j('POST', '/player/block', { orgId: 'org-northstar', reason: 'no thanks' }, theo.token);
  ok(blk.status === 201, 'X3 Theo blocks the agency');
  const ct = await j('GET', `/org/agent/compliance/contexts/${globalThis.CTX_THEO}`, undefined, ANA.token);
  neg(ct.body.context.parties[0].name === null, "X4 the blocked party's name is gone from the agent's context");
  const ev = await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX_THEO}/evaluate`, {}, ANA.token);
  neg(
    ev.body.evaluation.outcome === 'INSUFFICIENT_DATA' && codes(ev.body.evaluation).includes('PARTY_REMOVED'),
    'X5 the evaluation reads the party as removed: INSUFFICIENT_DATA, never CLEAR (#22)',
  );
  neg(
    expect(
      collect(
        'X6',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${globalThis.CTX_THEO}/representations`,
          { partyRole: 'individual', agreementId: REL_THEO },
          ANA.token,
        ),
      ),
      404,
      'PARTY_NOT_FOUND',
    ),
    'X6 a declaration for a blocked player is the uniform 404',
  );
  neg(
    expect(
      collect(
        'X7',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }],
          },
          ANA.token,
        ),
      ),
      404,
      'PARTY_NOT_FOUND',
    ),
    'X7 nor can a new context name him',
  );
  neg(
    expect(
      collect('Y1', await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, maria.token)),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'Y1 a club user cannot read an agency context',
  );
  neg(
    expect(
      collect('Y2', await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, DAN.token)),
      404,
      'CONTEXT_NOT_FOUND',
    ),
    "Y2 a colleague cannot read Ana's context (personal; 404 not 403)",
  );
  neg(
    expect(
      collect('Y3', await j('GET', '/org/agent/compliance/contexts/__proto__', undefined, ANA.token)),
      404,
      'CONTEXT_NOT_FOUND',
    ) &&
      expect(
        collect('Y3b', await j('POST', '/org/agent/compliance/contexts/constructor/evaluate', {}, ANA.token)),
        404,
        'CONTEXT_NOT_FOUND',
      ),
    'Y3 prototype names are not contexts',
  );
  neg(
    expect(collect('Y4', await j('GET', '/org/agent/compliance/overview', undefined, kola.token)), 401, null),
    'Y4 a player token is no agent session',
  );
  neg(
    expect(
      collect(
        'Y5',
        await j(
          'POST',
          '/player/agent/consents/__proto__/grant',
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          kola.token,
        ),
      ),
      404,
      'CONSENT_NOT_FOUND',
    ) &&
      expect(
        collect(
          'Y5b',
          await j(
            'POST',
            `/player/agent/consents/${CLUB_CONSENT}/grant`,
            { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
            kola.token,
          ),
        ),
        404,
        'CONSENT_NOT_FOUND',
      ),
    "Y5 a player cannot guess a consent id nor answer the club's consent (#24)",
  );
  neg(
    expect(
      collect('Y6', await j('POST', `/org/compliance/consents/${KOLA_CONSENT}/revoke`, {}, maria.token)),
      404,
      'CONSENT_NOT_FOUND',
    ),
    "Y6 a club signatory cannot touch a player's consent",
  );
  const ben = await j('GET', '/org/agent/compliance/overview', undefined, BEN.token);
  ok(
    ben.status === 200 && ben.body.contexts.length === 0 && ben.body.consents.length === 0 && ben.body.facets === null,
    'Y7 an analyst reads only his own (empty) compliance state',
  );
  const audit = await j('GET', '/org/agent/agency/audit?limit=50', undefined, tomas.token);
  ok(
    audit.status === 200 &&
      audit.body.items.some((x) => x.domain === 'compliance' && x.action === 'regulatory_consent_granted') &&
      audit.body.items.some(
        (x) =>
          x.domain === 'compliance' &&
          x.action === 'regulatory_review_resolved' &&
          x.actor?.name === 'Trust & Safety (attributed)',
      ),
    'AE5 the agency audit feed carries compliance rows; a reviewer appears as an attributed role',
  );
  neg(
    !JSON.stringify(audit.body).match(/mandate letter|withdrawn\.|Seems permitted|Marcus|Priya|evidenceRefs/),
    'AE6 the agency feed carries no reason text, no evidence and no reviewer name',
  );
  const kn = await j('GET', '/player/notifications', undefined, kola.token);
  ok(
    kn.body.some((n) => n.type === 'regulatory_consent_requested' && /You may decline/.test(n.text)),
    'AF3 Kola was told about the consent request and that he may decline',
  );
  const an = await j('GET', '/org/notifications', undefined, ANA.token);
  ok(
    an.body.some((n) => n.type === 'regulatory_consent_revoked') &&
      an.body.some((n) => n.type === 'regulatory_review_completed' && /not a legal determination/.test(n.text)),
    'AF4 Ana was told of the revocation and of the review outcome, framed as a platform decision',
  );
  neg(
    !JSON.stringify(an.body).match(/Kola|Eastport FC mandate/),
    'AF5 no party name and no evidence reaches a notification',
  );
}

// ============================================================ AE — events
section('AE — SSE frames carry ids and state words only');
{
  const sse = await sseCollect(ANA.token, 900);
  await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, {}, ANA.token);
  const frames = await sse.stop();
  ok(
    /conflict_evaluated/.test(frames) && /ctxId/.test(frames) && /"outcome":"CLEAR"/.test(frames),
    "AE7 Ana's stream carries conflict_evaluated with the context id and the outcome word",
  );
  neg(!/Kola|Eastport|reason|evidence/.test(frames), 'AE8 and nothing else');
  const metrics = await j('GET', '/ts/compliance/metrics', undefined, PRIYA.token);
  ok(
    metrics.status === 200 &&
      typeof metrics.body.reviews.byStatus.APPROVED === 'number' &&
      typeof metrics.body.conflictOutcomes.CLEAR === 'number' &&
      /No agent is ranked/.test(metrics.body.note),
    'AE9 process metrics: counts only, and the note says no agent is ranked',
  );
  neg(!JSON.stringify(metrics.body).match(/Ana|Kola|usr-|pl-/), 'AE10 no identity in the metrics');
}

// ============================================================ adversarial — stale licence, departure, dispute, expiry
section('adversarial — a stale or inactive licence, a departure and a dispute between check and mutation');
{
  const sub = (tok, facet, reference, ma) =>
    j(
      'POST',
      `/org/agent/profile/facets/${facet}/submit`,
      { reference, ...(ma ? { memberAssociation: ma } : {}) },
      tok,
    );
  await sub(ANA.token, 'fifa_licence', 'TEST-INACTIVE-ANA');
  neg(
    expect(
      collect(
        'AD4',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${globalThis.CTX2}/parties`,
          { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
          ANA.token,
        ),
      ),
      201,
      null,
    ) &&
      expect(
        collect(
          'AD4b',
          await j(
            'POST',
            `/org/agent/compliance/contexts/${CTX3}/representations`,
            { partyRole: 'individual', agreementId: REL_MATEUS },
            ANA.token,
          ),
        ),
        403,
        'AGENT_LICENCE_INACTIVE',
      ),
    '#4 an INACTIVE licence on a live session: a regulated declaration is refused (adding a party is bookkeeping)',
  );
  await sub(ANA.token, 'fifa_licence', 'TEST-STALE-ANA');
  neg(
    expect(
      collect(
        'AD5',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${CTX3}/representations`,
          { partyRole: 'individual', agreementId: REL_MATEUS },
          ANA.token,
        ),
      ),
      403,
      'AGENT_VERIFICATION_STALE',
    ),
    '#5 a STALE licence between page load and mutation: refused',
  );
  neg(
    expect(
      collect(
        'AD5b',
        await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['ENG'] }, ANA.token),
      ),
      403,
      'AGENT_VERIFICATION_STALE',
    ),
    '#5b nor can a stale agent open a context',
  );
  ok(
    (await sub(ANA.token, 'fifa_licence', 'TEST-VERIFIED-ANA')).body.facet.state === 'VERIFIED',
    'AD6 Ana re-verifies',
  );
  const rc = await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, ANA.token);
  ok(
    rc.status === 200 && rc.body.facet.state === 'VERIFIED' && rc.body.facet.recheckAt > Date.now(),
    'H6 a recheck against a current reference refreshes the recheck date',
  );
  // The client's authority changes between check and mutation.
  const ctx6 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['INT'],
      parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' }],
    },
    ANA.token,
  );
  const rel = await j('GET', `/org/agent/clients/${REL_MATEUS}`, undefined, ANA.token);
  const disp = await j(
    'POST',
    `/player/agent/relationships/${REL_MATEUS}/dispute`,
    { expectedRev: rel.body.relationship.rev, reason: 'PRIVATE_DISPUTE_TEXT' },
    mateus.token,
  );
  ok(disp.status === 200 && disp.body.relationship.status === 'disputed', 'AD7 Mateus disputes the relationship');
  neg(
    expect(
      collect(
        'AD8',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${ctx6.body.context.id}/representations`,
          { partyRole: 'individual', agreementId: REL_MATEUS },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    '#7 a disputed relationship authorises no declaration',
  );
  const dr = (await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, PRIYA.token)).body.items.find(
    (r) => r.kind === 'representation_dispute' && r.subject.agreementId === REL_MATEUS,
  );
  ok(
    !!dr &&
      (await j('GET', `/ts/compliance/reviews/${dr.id}`, undefined, PRIYA.token)).body.subjectDetail.hadReason === true,
    'AD9 the dispute became an attributed review item; the reviewer sees that a reason exists',
  );
  neg(
    !JSON.stringify(await j('GET', `/ts/compliance/reviews/${dr.id}`, undefined, PRIYA.token)).includes(
      'PRIVATE_DISPUTE_TEXT',
    ),
    'AD10 the reason text itself stays with the client',
  );
  const reinstate = await j(
    'POST',
    `/ts/compliance/reviews/${dr.id}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'dispute_withdrawn',
      reason: 'The client withdrew the dispute in writing.',
      evidenceRefs: ['client message, 18 Sep 2026'],
    },
    PRIYA.token,
  );
  ok(
    reinstate.status === 200 &&
      reinstate.body.review.decision.resultingState.agreementStatus === 'active' &&
      (await j('GET', `/org/agent/clients/${REL_MATEUS}`, undefined, ANA.token)).body.access === true,
    'AD11 an attributed reviewer reinstates the disputed relationship: access resumes',
  );
  const rel2 = await j('GET', `/org/agent/clients/${REL_KOLA}`, undefined, ANA.token);
  const term = await j(
    'POST',
    `/player/agent/relationships/${REL_KOLA}/terminate`,
    { expectedRev: rel2.body.relationship.rev },
    kola.token,
  );
  ok(term.status === 200, 'AD12 Kola ends his relationship with Ana');
  const ctx7 = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }],
    },
    ANA.token,
  );
  neg(
    expect(
      collect(
        'AD13',
        await j(
          'POST',
          `/org/agent/compliance/contexts/${ctx7.body.context.id}/representations`,
          { partyRole: 'individual', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    '#6 a relationship ended between check and mutation authorises nothing',
  );
  neg(
    (await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context.clearance !== null,
    'AD14 the earlier CLEAR snapshot on the other context is history, not authority — every new act re-derives',
  );
  // Departure.
  const danAff = (await j('GET', '/org/agent/agency/team', undefined, tomas.token)).body.members.find(
    (m) => m.userId === DAN_ID,
  );
  const end = await j(
    'POST',
    `/org/agent/agency/team/${DAN_ID}/end`,
    { expectedRev: danAff.rev, reason: 'left' },
    tomas.token,
  );
  ok(end.status === 200, 'AD15 Dan leaves the agency');
  neg(
    expect(
      collect('AD16', await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX4}/evaluate`, {}, DAN.token)),
      401,
      null,
    ),
    "#8 the departed agent's session is dead before his next mutation",
  );
  // Exclusive-agreement window: review, never a block, never the other agent.
  const exc = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-nowak', jurisdiction: 'ENG', exclusive: true },
    EVE.token,
  );
  ok(
    exc.status === 201 &&
      (
        await j(
          'POST',
          `/player/agent/relationships/${exc.body.relationship.id}/confirm`,
          { expectedRev: 1 },
          filip.token,
        )
      ).body.relationship.status === 'active',
    'AD17 Eve holds an EXCLUSIVE agreement with Filip',
  );
  const ana2 = collect(
    'AD18',
    await j('POST', '/org/agent/clients/request', { playerId: 'pl-nowak', jurisdiction: 'ENG' }, ANA.token),
  );
  neg(
    expect(ana2, 422, 'REGULATORY_REVIEW_REQUIRED') &&
      ana2.body.reasons.some(
        (r) => r.code === 'EXCLUSIVITY_WINDOW_DOUBTFUL' && r.ruleStatus === 'UNDER_LEGAL_REVIEW',
      ) &&
      ana2.body.reviewId,
    "AD18 an approach to a player bound by another agent's exclusive agreement: the window rule is under legal review → attributed review, never a hard block (DR-33)",
  );
  neg(
    !JSON.stringify(ana2.body).includes(EVE_ID) &&
      !JSON.stringify(ana2.body).includes('Eve') &&
      !(await j('GET', '/org/agent/clients', undefined, ANA.token)).body.items.some((x) => x.clientId === 'pl-nowak'),
    'AD19 the other agent is never named and nothing was created',
  );
}

// ============================================================ policy publication — dual control, history preserved
section('policy — dual-control publication; historical snapshots keep their version');
{
  const cur = (await j('GET', '/ts/compliance/policies', undefined, PRIYA.token)).body.items.find(
    (p) => p.id === 'jp-fifa-2025-1',
  );
  const rules = Object.fromEntries(
    Object.entries(cur.rules).map(([id, r]) => [
      id,
      {
        ruleStatus: ['FIFA-12.8', 'FIFA-12.9', 'FIFA-12.10'].includes(id) ? 'ACTIVE' : r.ruleStatus,
        textStatus: r.textStatus,
        sourceRef: r.sourceRef,
        params: r.params,
        note: r.note,
      },
    ]),
  );
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    id: 'jp-fifa-2025-2',
    regulator: 'FIFA',
    jurisdiction: 'INT',
    policyVersion: 2,
    supersedes: 'jp-fifa-2025-1',
    effectiveFrom: today,
    rules,
  };
  neg(
    expect(
      collect(
        'C12',
        await j(
          'POST',
          '/ts/compliance/policies',
          { ...body, rules: { 'X-1': { ruleStatus: 'MAYBE', sourceRef: [] } } },
          PRIYA.token,
        ),
      ),
      400,
      'POLICY_INPUT_INVALID',
    ),
    'C12 an unknown rule status or a missing source reference is refused',
  );
  neg(
    expect(
      collect('C13', await j('POST', '/ts/compliance/policies', body, MARCUS.token)),
      403,
      'REVIEWER_ROLE_REQUIRED',
    ),
    'C13 a reviewer cannot propose a policy version',
  );
  const prop = await j('POST', '/ts/compliance/policies', body, PRIYA.token);
  ok(
    prop.status === 201 && prop.body.policy.status === 'proposed' && prop.body.policy.proposedBy.id === 'tsr-dev-admin',
    'C14 Priya proposes jp-fifa-2025-2 with 12(8)–(10) ACTIVE (a test fixture, not a statement about FIFA)',
  );
  neg(
    expect(collect('C15', await j('POST', '/ts/compliance/policies', body, PRIYA.token)), 409, 'POLICY_VERSION_EXISTS'),
    'C15 a version id is unique',
  );
  neg(
    expect(
      collect('C16', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, PRIYA.token)),
      403,
      'POLICY_DUAL_CONTROL_REQUIRED',
    ),
    'C16 the proposer cannot approve her own version',
  );
  neg(
    expect(
      collect('C17', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, MARCUS.token)),
      403,
      'REVIEWER_ROLE_REQUIRED',
    ),
    'C17 a reviewer cannot approve it',
  );
  neg(
    (await j('GET', '/org/agent/compliance/policies', undefined, ANA.token)).body.inEffect.every(
      (p) => p.id !== 'jp-fifa-2025-2',
    ),
    'C18 while proposed, the version is not in effect for anyone',
  );
  // A published version is a public catalogue ping: a player's stream hears it too.
  const kolaStream = await liveStream(BASE, j, kola.token);
  const appr = await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, LEA.token);
  ok(
    appr.status === 200 &&
      appr.body.policy.status === 'published' &&
      appr.body.policy.publishedBy.length === 2 &&
      appr.body.policy.approvedBy.id === 'tsr-dev-admin2',
    'C19 a DIFFERENT administrator approves: published, attributed to both',
  );
  const published = await kolaStream.waitFor((f) => f.event === 'policy_version_published');
  ok(
    !!published && JSON.stringify(Object.keys(published)) === JSON.stringify(['event', 'ts']),
    'LV1 publishing a version pings every stream, naming nothing',
  );
  await kolaStream.stop();
  neg(
    expect(
      collect('C20', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, LEA.token)),
      409,
      'POLICY_NOT_PROPOSED',
    ),
    'C20 not approved twice',
  );
  const c3 = await j('GET', `/org/agent/compliance/contexts/${CTX3}`, undefined, ANA.token);
  ok(
    c3.body.context.reEvaluationPending === true && c3.body.context.clearance.current === false,
    'C21 the international context is flagged for re-evaluation — never silently re-verdicted',
  );
  const re = await j('POST', `/org/agent/compliance/contexts/${CTX3}/evaluate`, {}, ANA.token);
  ok(
    re.body.evaluation.policyVersions.join() === 'jp-fifa-2025-2' && re.body.evaluation.outcome === 'CLEAR',
    'C22 re-evaluated under v2 (only the club is represented so far): CLEAR',
  );
  const ind = collect(
    'C23',
    await j(
      'POST',
      `/org/agent/compliance/contexts/${CTX3}/representations`,
      { partyRole: 'individual', agreementId: REL_MATEUS },
      ANA.token,
    ),
  );
  ok(
    expect(ind, 422, 'CONSENT_REQUIRED') && ind.body.policyVersions.join() === 'jp-fifa-2025-2',
    'C23 E16 over HTTP: what was "manual review" under v1 is "consent required" under v2 — a data change, not code',
  );
  const R = readRows(DATA_DIR);
  const evaluations = R.rows('compliance_evaluations', { context_id: CTX3 }, { order: 'position' });
  const versionsOf = (e) =>
    R.rows('compliance_evaluation_policy_versions', { evaluation_id: e.id }, { order: 'ord' })
      .map((v) => v.policy_version_id)
      .join();
  const ruleReasons = R.rows('compliance_evaluation_reasons', { evaluation_id: evaluations.map((e) => e.id) }).filter(
    (r) => r.rule_id !== null,
  );
  const c24 =
    evaluations.length > 1 &&
    versionsOf(evaluations[0]) === 'jp-fifa-2025-1' &&
    versionsOf(evaluations.at(-1)) === 'jp-fifa-2025-2' &&
    evaluations.every((e) => e.input_hash) &&
    ruleReasons.length > 0 &&
    ruleReasons.every((r) => r.rule_status !== null);
  R.close();
  ok(c24, 'C24 the earlier evaluation rows keep v1 and their rule statuses; the latest names v2');
  const oldReview = await j('GET', `/ts/compliance/reviews/${CTX3_REVIEW}`, undefined, PRIYA.token);
  ok(
    oldReview.body.review.policyVersions.join() === 'jp-fifa-2025-1' && oldReview.body.review.status === 'PENDING',
    'C25 the pending review still records the version it was raised under',
  );
  const rej = await j(
    'POST',
    `/ts/compliance/reviews/${CTX3_REVIEW}/resolve`,
    {
      outcome: 'REJECTED',
      reasonCode: 'superseded_by_policy',
      reason: 'jp-fifa-2025-2 settles the question; the item is closed.',
    },
    LEA.token,
  );
  ok(rej.status === 200, 'C26 it is closed by a named reviewer, not deleted');
  // An England v2 makes the ENG consents stale (#16).
  const engCur = (await j('GET', '/ts/compliance/policies', undefined, PRIYA.token)).body.items.find(
    (p) => p.id === 'jp-eng-2026-27-1',
  );
  const engRules = Object.fromEntries(
    Object.entries(engCur.rules).map(([id, r]) => [
      id,
      { ruleStatus: r.ruleStatus, textStatus: r.textStatus, sourceRef: r.sourceRef, params: r.params, note: r.note },
    ]),
  );
  await j(
    'POST',
    '/ts/compliance/policies',
    {
      id: 'jp-eng-2026-27-2',
      regulator: 'FA',
      jurisdiction: 'ENG',
      policyVersion: 2,
      supersedes: 'jp-eng-2026-27-1',
      effectiveFrom: today,
      rules: engRules,
    },
    PRIYA.token,
  );
  const ok2 = await j('POST', '/ts/compliance/policies/jp-eng-2026-27-2/approve', {}, LEA.token);
  const c1 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, {}, ANA.token);
  neg(
    ok2.status === 200 &&
      c1.body.evaluation.outcome === PERMITTED_WITH_CONSENT &&
      c1.body.evaluation.policyVersions.includes('jp-eng-2026-27-2') &&
      c1.body.evaluation.consentsOutstanding.some(
        (x) => x.partyRole === 'engaging_entity' && x.reasonCode === 'CONSENT_POLICY_VERSION_STALE',
      ),
    "#16 the club consent granted under the previous England version is not carried into v2: re-evaluation requires it again (the individual's later decline stands)",
  );
}

// ============================================================ IN — input is valid as sent, or refused
section('IN — strict bodies and queries: a wrong type, an unknown field or over-long text is refused by name');
{
  const refusedAs = (r, status, code, field, problem) =>
    expect(r, status, code) && r.body.field === field && r.body.problem === problem;
  neg(
    refusedAs(
      collect('IN1', await j('POST', '/auth/reviewer/login', { reviewerId: { id: 'tsr-dev-admin' }, secret: 'x' })),
      400,
      'COMPLIANCE_INPUT_INVALID',
      'reviewerId',
      'not_text',
    ),
    'IN1 a reviewer id that is not text is refused, not turned into "[object Object]"',
  );
  const longName = await j(
    'POST',
    '/ts/reviewers',
    { id: 'tsr-long-name', name: 'N'.repeat(81), secret: 'a-long-enough-secret' },
    PRIYA.token,
  );
  neg(
    refusedAs(collect('IN2', longName), 400, 'COMPLIANCE_INPUT_INVALID', 'name', 'too_long') &&
      longName.body.max === 80 &&
      !(await j('GET', '/ts/reviewers', undefined, PRIYA.token)).body.items.some((r) => r.id === 'tsr-long-name'),
    'IN2 a reviewer name over 80 characters is refused with its limit, not cut, and nobody is created',
  );
  neg(
    refusedAs(
      collect('IN3', await j('POST', '/ts/reviewers/tsr-dev-admin2/revoke', { reason: { why: 'x' } }, PRIYA.token)),
      400,
      'COMPLIANCE_INPUT_INVALID',
      'reason',
      'not_text',
    ) &&
      (await j('GET', '/ts/reviewers', undefined, PRIYA.token)).body.items.find((r) => r.id === 'tsr-dev-admin2')
        ?.status === 'active',
    'IN3 a revocation reason that is not text is refused and revokes nobody',
  );
  const rule = (extra) => ({
    ruleStatus: 'ACTIVE',
    sourceRef: [{ source: 'Synthetic test source', retrievedDate: '2026-09-18' }],
    ...extra,
  });
  const policy = (rules, extra = {}) => ({
    id: 'jp-eng-input-1',
    jurisdiction: 'ENG',
    policyVersion: 9,
    effectiveFrom: '2027-01-01',
    rules,
    ...extra,
  });
  const propose = async (label, body) => collect(label, await j('POST', '/ts/compliance/policies', body, PRIYA.token));
  neg(
    refusedAs(
      await propose('IN4', policy({ 'X-1': rule({ params: { licenceRequird: true } }) })),
      400,
      'POLICY_INPUT_INVALID',
      'rules.X-1.params.licenceRequird',
      'unknown_field',
    ),
    'IN4 a misspelt rule parameter is refused by name: the engine would never read it',
  );
  neg(
    refusedAs(
      await propose('IN5', policy({ 'X-1': rule({ params: { licenceRequired: 'yes' } }) })),
      400,
      'POLICY_INPUT_INVALID',
      'rules.X-1.params.licenceRequired',
      'not_boolean',
    ),
    'IN5 a rule parameter of the wrong type is refused',
  );
  const longNote = await propose('IN6', policy({ 'X-1': rule({ note: 'n'.repeat(1001) }) }));
  neg(
    refusedAs(longNote, 400, 'POLICY_INPUT_INVALID', 'rules.X-1.note', 'too_long') && longNote.body.max === 1000,
    'IN6 a rule note over 1000 characters is refused with its limit, not cut',
  );
  neg(
    refusedAs(
      await propose('IN7', policy({ 'X-1': rule() }, { effectiveFrom: '2027-01-01T00:00:00Z' })),
      400,
      'POLICY_INPUT_INVALID',
      'effectiveFrom',
      'not_a_date',
    ),
    'IN7 a date-time is not a calendar day',
  );
  neg(
    refusedAs(
      await propose('IN8', policy({ 'X-1': rule() }, { effectiveTo: '2026-12-31' })),
      400,
      'POLICY_INPUT_INVALID',
      'effectiveTo',
      'invalid',
    ) &&
      !(await j('GET', '/ts/compliance/policies', undefined, PRIYA.token)).body.items.some(
        (p) => p.id === 'jp-eng-input-1',
      ),
    'IN8 a policy that ends before it begins is refused, and none of these proposals was stored',
  );
  neg(
    refusedAs(
      collect(
        'IN9',
        await j(
          'POST',
          '/org/agent/compliance/contexts',
          { type: 'employment_contract', jurisdictions: ['EN'] },
          ANA.token,
        ),
      ),
      400,
      'CONTEXT_INPUT_INVALID',
      'jurisdictions[0]',
      'invalid',
    ),
    'IN9 a jurisdiction that is not a three-letter code is refused by position',
  );
  neg(
    refusedAs(
      collect(
        'IN10',
        await j(
          'POST',
          '/org/agent/compliance/facets/national_registration/recheck',
          { memberAssociation: 'ENGLAND' },
          ANA.token,
        ),
      ),
      400,
      'COMPLIANCE_INPUT_INVALID',
      'memberAssociation',
      'invalid',
    ),
    'IN10 a recheck names a three-letter member association or none',
  );
  neg(
    refusedAs(
      collect('IN11', await j('GET', '/ts/compliance/reviews?status=PENDING&sort=oldest', undefined, MARCUS.token)),
      400,
      'REVIEW_INPUT_INVALID',
      'sort',
      'unknown_field',
    ) &&
      refusedAs(
        collect('IN12', await j('GET', '/ts/compliance/reviews?status=pending', undefined, MARCUS.token)),
        400,
        'REVIEW_INPUT_INVALID',
        'status',
        'not_allowed',
      ),
    'IN11 the review queue takes only the parameters it reads, and a status that exists',
  );
  const before = (await j('GET', `/ts/compliance/reviews/${EVE_REVIEW}`, undefined, MARCUS.token)).body.review;
  const longReason = await j(
    'POST',
    `/ts/compliance/reviews/${EVE_REVIEW}/resolve`,
    { outcome: 'REJECTED', reasonCode: 'x', reason: 'r'.repeat(1001) },
    MARCUS.token,
  );
  const after = (await j('GET', `/ts/compliance/reviews/${EVE_REVIEW}`, undefined, MARCUS.token)).body.review;
  neg(
    refusedAs(collect('IN13', longReason), 400, 'REVIEW_INPUT_INVALID', 'reason', 'too_long') &&
      longReason.body.max === 1000 &&
      after.rev === before.rev,
    'IN13 a review reason over 1000 characters is refused with its limit, not cut, and the review is unchanged',
  );
  neg(
    refusedAs(
      collect(
        'IN14',
        await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/start`, { expectedRev: '3' }, MARCUS.token),
      ),
      400,
      'EXPECTED_REV_INVALID',
      'expectedRev',
      'not_number',
    ),
    'IN14 an expectedRev written as text is refused as a malformed rev, not a 500',
  );
}

// ============================================================ AJ — tombstones; last administrator
section('AJ — deletion leaves ids; the last administrator stays');
{
  const del = await j('DELETE', '/player/account', undefined, kola.token);
  ok(del.status === 200, 'AJ1 Kola deletes his account');
  const R = readRows(DATA_DIR);
  const individual = R.row('compliance_context_parties', { context_id: CTX1, party_role: 'individual' });
  const playerHistory = R.rows('compliance_context_history', { context_id: CTX1, by_kind: 'player' });
  const consents = R.rows('regulatory_consents', { subject_id: 'pl-adeyemi' });
  const consentHistory = R.rows('regulatory_consent_history', {
    consent_id: consents.map((k) => k.id),
    by_kind: 'player',
  });
  R.close();
  neg(
    individual.removed === 1 && playerHistory.length > 0 && playerHistory.every((h) => h.by_name === null),
    'AJ2 the context keeps the party as an id-only removed party; player attributions are nulled',
  );
  neg(
    consents.length > 0 &&
      consents.every((k) => k.granted_by_kind !== 'player' || k.granted_by_name === null) &&
      consentHistory.every((h) => h.by_name === null),
    "AJ3 consent rows keep the subject id and lose the person's name",
  );
  const c1 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  neg(
    c1.body.context.parties[0].name === null && c1.body.context.parties[0].removed === true,
    'AJ4 the agent sees a removed party with no name',
  );
  neg(
    expect(collect('AJ5', await j('POST', '/ts/reviewers/tsr-dev-admin2/revoke', {}, PRIYA.token)), 200, null) &&
      expect(
        collect('AJ6', await j('POST', '/ts/reviewers/tsr-dev-admin/revoke', {}, PRIYA.token)),
        409,
        'LAST_REVIEWER_ADMIN',
      ),
    'AJ5 with one administrator left, the last one cannot be revoked',
  );
}

// ============================================================ Z — the refusal sweep
section('Z — every refusal in this run: a code, no private field');
{
  ok(ERROR_BODIES.length > 60, `Z9 ${ERROR_BODIES.length} refusals collected`);
  neg(
    ERROR_BODIES.every((e) => typeof e.body?.error === 'string' || (e.body === null && e.status === 404)),
    'Z10 every JSON refusal carried an error code (a 404 for a route that does not exist has no body)',
  );
  neg(
    ERROR_BODIES.every((e) => !('stack' in (e.body ?? {})) && !('internal' in (e.body ?? {}))),
    'Z11 no stack or internal field',
  );
  const text = JSON.stringify(ERROR_BODIES.map((e) => e.body));
  neg(
    !/PRIVATE_DISPUTE_TEXT|mandate letter|Marcus|Priya|Léa|Eve Laurent|Dan Mensah|Kola Adeyemi|Mateus|evidenceRefs":\s*\[/.test(
      text,
    ),
    'Z12 no dispute reason, evidence, reviewer name or party name in any refusal',
  );
  neg(!/"agentUserId"|"note":/.test(text), 'Z13 no agent id and no prose reason rides on a reason entry');
}

console.log(
  `\nagents/compliance: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode) {
  console.error('agents/compliance has failures.');
} else console.log('all agents/compliance checks passed');
server.kill('SIGTERM');
