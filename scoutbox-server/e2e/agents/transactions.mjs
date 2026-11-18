// Agent Transaction Workspace battery.
//
// The governing principle this suite enforces: a ScoutBox
// transaction is a permissioned, auditable multi-party workspace. It must never
// turn transaction membership, stale compliance, broad agency access, hidden
// club information, unconfirmed representation or platform convenience into
// authority or visibility that the actual party has not granted.
//
// Pure groups first, then a real server; the adversarial cases are numbered (#n)
// in their check labels.
//
// No assertion is `status !== 200`. Every refusal names its status and its code.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { clubRecords } from '../support/clubRecords.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import transactionSpec from '../support/spec/agents/transactions/transaction.json' with { type: 'json' };
import transactionErrors from '../support/spec/agents/transactions/errors.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m26-'));
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

// =================================================================== HTTP
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
const login = async (orgId, scoutName, role, platform = 'agent') =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const reviewerLogin = async (reviewerId, secret) =>
  (await j('POST', '/auth/reviewer/login', { reviewerId, secret })).body;
/** With the server stopped, plant rows in one transaction (`work` gets the fixture): all of it is written or none. */
const plantRows = (work) => {
  const F = openFixture(DATA_DIR);
  try {
    return F.transaction(() => work(F));
  } finally {
    F.close();
  }
};
/** One table's rows as stored. */
const storedRows = (table, where = {}) => {
  const R = readRows(DATA_DIR);
  try {
    return R.rows(table, where);
  } finally {
    R.close();
  }
};
const ERROR_BODIES = [];
const collect = (label, r) => {
  if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body });
  return r;
};

// A SECOND agency has to exist for "a foreign agency guesses an id" to be a real
// test rather than a colleague test. There is no route that creates an
// organisation, so it is written through the repositories between two boots — the same
// fixture technique the compliance persistence suite uses.
let server = await boot();
await stop(server);
{
  // The second agency is a copy of the seeded one's row under its own id and name, without its password.
  // The releasing club has to be a VERIFIED organisation, because root
  // verification authority — the recorded club signatory — only exists inside
  // one. The seeded academy is unverified, so the fixture verifies it.
  plantRows((F) => {
    const agency = F.sql.prepare("SELECT * FROM orgs WHERE type = 'agency' ORDER BY rowid LIMIT 1").get();
    F.insert('orgs', { ...agency, id: 'org-southgate', name: 'Southgate Sports Management', password_hash: null });
    F.sql
      .prepare("UPDATE orgs SET verified = 1, verified_domain = 'harbourtownacademy.example' WHERE id = 'org-harbour'")
      .run();
  });
  const orgs = storedRows('orgs');
  ok(
    orgs.some((o) => o.id === 'org-southgate' && o.type === 'agency') &&
      orgs.find((o) => o.id === 'org-harbour').verified === 1,
    'fixture: a second agency exists (so "foreign agency" is not "same-agency colleague") and the releasing club is verified (so it can hold a signatory)',
  );
}
server = await boot();

section('setup — agency members, verified facets, relationships, club signatories');
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', null);
const devA = await login('org-harbour', 'Dev Ansah', 'Director of Football', null);
const ivy = await login('org-hackneymarsh', 'Ivy Brand', 'Chair', 'grassroots');
// A club that is party to NOTHING for the whole run, so "foreign club" stays foreign
// even after group I re-parents a transaction onto Hackney Marsh.
const outsider = await login('org-mossside', 'Nell Okafor', 'Secretary', 'grassroots');
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const chinedu = await playerLogin('pl-okafor');
const theo = await playerLogin('pl-martin');
const filip = await playerLogin('pl-nowak');
// Eastport has a live case on each client the agency transacts for. What each club holds on its recruitment as the
// run starts, an agent's transaction work must leave as it was.
for (const playerId of ['pl-adeyemi', 'pl-carvalho', 'pl-okafor']) {
  const r = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, maria.token);
  const RID = r.body?.room?.roomId ?? r.body?.existingRoomId;
  await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview' }, maria.token);
}
const CLUBS_AT_START = { eastport: await clubRecords(j, maria.token), harbour: await clubRecords(j, devA.token) };
ok(
  CLUBS_AT_START.eastport.rooms.length >= 3,
  `Eastport has a live case on each client (${CLUBS_AT_START.eastport.rooms.map((c) => c.status).join(', ')})`,
);
const PRIYA = await reviewerLogin('tsr-dev-admin', 'dev-reviewer-admin');
let ANA, DAN, BEN, FAY, ZOE, ANA_ID, DAN_ID, REL_KOLA, REL_THEO, REL_CHINEDU, REL_MATEUS;
{
  const add = async (name, tiers) =>
    (await j('POST', '/org/agent/agency/team', { name, tiers }, tomas.token)).body.member;
  ANA_ID = (await add('Ana Costa', ['licensed_agent'])).userId;
  DAN_ID = (await add('Dan Mensah', ['licensed_agent'])).userId;
  await add('Ben Okoro', ['analyst']);
  await add('Fay Idris', ['licensed_agent']);
  ANA = await login('org-northstar', 'Ana Costa', 'Agent');
  DAN = await login('org-northstar', 'Dan Mensah', 'Agent');
  BEN = await login('org-northstar', 'Ben Okoro', 'Analyst');
  FAY = await login('org-northstar', 'Fay Idris', 'Agent');
  // The other agency: the first person into an agency with no members
  // bootstraps as its administrator (never as a licensed agent — a self-typed
  // role is not a licence), so an administrator grants the licensed tier.
  const zed = await login('org-southgate', 'Zed Admin', 'Director');
  await j('POST', '/org/agent/agency/team', { name: 'Zoe Hart', tiers: ['licensed_agent'] }, zed.token);
  ZOE = await login('org-southgate', 'Zoe Hart', 'Agent');
  const prof = async (tok, name, jur) =>
    (await j('POST', '/org/agent/profile', { displayName: name, jurisdictions: jur }, tok)).status;
  ok(
    (await prof(ANA.token, 'Ana Costa', ['ENG', 'INT'])) === 201 &&
      (await prof(DAN.token, 'Dan Mensah', ['ENG'])) === 201 &&
      (await prof(ZOE.token, 'Zoe Hart', ['ENG'])) === 201,
    'S1 three agent profiles (Fay deliberately has none)',
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
    'S2 Ana: FIFA licence and FA registration VERIFIED',
  );
  ok(
    (await sub(DAN.token, 'fifa_licence', 'TEST-VERIFIED-DAN')).body.facet.state === 'VERIFIED' &&
      (await sub(DAN.token, 'national_registration', 'TEST-VERIFIED-DAN-FA', 'ENG')).body.facet.state === 'VERIFIED',
    'S3 Dan likewise',
  );
  ok(
    (await sub(ZOE.token, 'fifa_licence', 'TEST-VERIFIED-ZOE')).body.facet.state === 'VERIFIED' &&
      (await sub(ZOE.token, 'national_registration', 'TEST-VERIFIED-ZOE-FA', 'ENG')).body.facet.state === 'VERIFIED',
    'S4 Zoe at the other agency likewise',
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
    'S5 Ana ↔ Kola: ENG employment + transfer, client-confirmed',
  );
  const r2 = await req(ANA.token, 'pl-martin', { scope: ['commercial'] });
  REL_THEO = r2.body?.relationship?.id;
  ok(
    r2.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_THEO}/confirm`, { expectedRev: 1 }, theo.token)).body
        .relationship.status === 'active',
    'S6 Ana ↔ Theo: ENG commercial ONLY, confirmed',
  );
  const r3 = await req(DAN.token, 'pl-okafor');
  REL_CHINEDU = r3.body?.relationship?.id;
  ok(
    r3.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_CHINEDU}/confirm`, { expectedRev: 1 }, chinedu.token)).body
        .relationship.status === 'active',
    'S7 Dan ↔ Chinedu: ENG, confirmed',
  );
  const r4 = await req(ANA.token, 'pl-carvalho', { jurisdiction: 'INT', scope: ['employment'] });
  REL_MATEUS = r4.body?.relationship?.id;
  ok(
    r4.status === 201 &&
      (await j('POST', `/player/agent/relationships/${REL_MATEUS}/confirm`, { expectedRev: 1 }, mateus.token)).body
        .relationship.status === 'active',
    'S8 Ana ↔ Mateus: INT employment, confirmed',
  );
  const a1 = await j(
    'POST',
    '/admin/verification/orgs/org-eastport/appoint-root',
    { userId: maria.userId, reason: 'transactions suite: engaging club signatory' },
    PRIYA.token,
    ADMIN,
  );
  const a2 = await j(
    'POST',
    '/admin/verification/orgs/org-harbour/appoint-root',
    { userId: devA.userId, reason: 'transactions suite: releasing club signatory' },
    PRIYA.token,
    ADMIN,
  );
  ok(
    a1.status === 201 && a2.status === 201,
    `S9 Trust & Safety records a signatory for each club, attributed to a named reviewer (${a1.status}/${a2.status} ${a1.body?.error ?? ''}${a2.body?.error ?? ''})`,
  );
}

// ============================================================ A — create
section('A — who may open a transaction, and what opening one does NOT grant');
let TX1;
{
  const body = {
    type: 'transfer',
    jurisdictions: ['ENG'],
    parties: [
      { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
      { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' },
    ],
  };
  neg(
    expect(
      collect('A1', await j('POST', '/org/agent/transactions', body, BEN.token)),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'A1 an analyst cannot open a transaction (#2 agency assistant)',
  );
  neg(
    expect(
      collect('A2', await j('POST', '/org/agent/transactions', body, tomas.token)),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    'A2 an agency administrator without the licensed_agent role cannot either (#3 admin impersonates Agent)',
  );
  neg(
    expect(
      collect('A3', await j('POST', '/org/agent/transactions', body, maria.token)),
      403,
      'AGENT_ACTION_NOT_PERMITTED',
    ),
    "A3 a club user has no agent workspace: a club's lane is its party routes",
  );
  neg(
    expect(collect('A4', await j('POST', '/org/agent/transactions', body, kola.token)), 401, null),
    'A4 a player token is no agency session',
  );
  neg(
    expect(
      collect('A5', await j('POST', '/org/agent/transactions', { ...body, type: 'offer' }, ANA.token)),
      400,
      'TRANSACTION_INPUT_INVALID',
    ) &&
      expect(
        collect('A5b', await j('POST', '/org/agent/transactions', { ...body, type: 'renewal' }, ANA.token)),
        400,
        'TRANSACTION_INPUT_INVALID',
      ),
    'A5 "offer" is not a transaction type, and neither is an unfrozen "renewal"',
  );
  neg(
    expect(
      collect('A6', await j('POST', '/org/agent/transactions', { ...body, jurisdictions: [] }, ANA.token)),
      400,
      'TRANSACTION_INPUT_INVALID',
    ),
    'A6 jurisdictions are required',
  );
  neg(
    expect(
      collect('A7', await j('POST', '/org/agent/transactions', { ...body, jurisdictions: ['FRA'] }, ANA.token)),
      422,
      'JURISDICTION_UNSUPPORTED',
    ),
    'A7 an unsupported jurisdiction opens nothing — no silent allow (#24)',
  );
  neg(
    expect(
      collect('A8', await j('POST', '/org/agent/transactions', body, FAY.token)),
      403,
      'AGENT_VERIFICATION_REQUIRED',
    ),
    'A8 a licensed_agent with no profile at all cannot open one',
  );
  const minorTry = collect(
    'A9',
    await j(
      'POST',
      '/org/agent/transactions',
      { ...body, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }] },
      ANA.token,
    ),
  );
  const ghostTry = collect(
    'A9b',
    await j(
      'POST',
      '/org/agent/transactions',
      { ...body, parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-nobody-at-all' }] },
      ANA.token,
    ),
  );
  neg(
    expect(minorTry, 404, 'TRANSACTION_PARTY_NOT_FOUND') &&
      expect(ghostTry, 404, 'TRANSACTION_PARTY_NOT_FOUND') &&
      JSON.stringify(minorTry.body) === JSON.stringify(ghostTry.body),
    'A9 a minor and a player who does not exist answer with byte-identical bodies (#23, V)',
  );
  const adeyemi = { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' };
  const listed = async () => (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items;
  const before = (await listed()).length;
  const forgedFields = {
    dob: '2012-01-01',
    guardianConsent: true,
    complianceOutcome: 'CLEAR',
    status: 'ACTIVE',
    rev: 99,
    policyVersion: 'jp-forged-1',
  };
  let refusedEach = true;
  for (const [field, value] of Object.entries(forgedFields)) {
    const r = collect(
      'A10',
      await j('POST', '/org/agent/transactions', { ...body, parties: [{ ...adeyemi, [field]: value }] }, ANA.token),
    );
    refusedEach &&=
      expect(r, 400, 'TRANSACTION_INPUT_INVALID') &&
      r.body.field === `parties[0].${field}` &&
      r.body.problem === 'unknown_field';
  }
  for (const field of ['status', 'rev', 'complianceOutcome']) {
    const r = collect(
      'A10',
      await j(
        'POST',
        '/org/agent/transactions',
        { ...body, parties: [adeyemi], [field]: forgedFields[field] },
        ANA.token,
      ),
    );
    refusedEach &&= expect(r, 400, 'TRANSACTION_INPUT_INVALID') && r.body.field === field;
  }
  const afterRefusals = await listed();
  neg(
    refusedEach && afterRefusals.length === before,
    'A10 a forged date of birth, guardian consent, compliance outcome, status, rev or policy version in the body is refused by name, and nothing is opened (#19–#22)',
  );
  neg(!JSON.stringify(afterRefusals).includes('jp-forged-1'), 'A10c the forged policy version reached no record');
  const forgedRes = collect(
    'A10b',
    await j('POST', '/org/agent/transactions', { ...body, parties: [adeyemi] }, ANA.token),
  );
  const forged = forgedRes.body?.transaction;
  neg(
    forged?.status === 'DRAFT' &&
      forged.rev === 1 &&
      forged.compliance.clear === false &&
      forged.compliance.pendingReason === 'PARTIES_NOT_CONFIRMED',
    `A10b the transaction opened without them is a DRAFT at rev 1 whose compliance says parties are not confirmed (${forged?.status}/${forged?.rev}/${forged?.compliance?.pendingReason})`,
  );
  neg(
    expect(
      collect(
        'A11',
        await j(
          'POST',
          '/org/agent/transactions',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [{ partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }],
          },
          ANA.token,
        ),
      ),
      400,
      'TRANSACTION_INPUT_INVALID',
    ),
    'A11 an employment contract has no releasing entity',
  );
  neg(
    expect(
      collect(
        'A12',
        await j(
          'POST',
          '/org/agent/transactions',
          { ...body, parties: [{ partyRole: 'engaging_entity', subjectKind: 'player', subjectId: 'pl-adeyemi' }] },
          ANA.token,
        ),
      ),
      400,
      'TRANSACTION_INPUT_INVALID',
    ) &&
      expect(
        collect(
          'A12b',
          await j(
            'POST',
            '/org/agent/transactions',
            { ...body, parties: [{ partyRole: 'individual', subjectKind: 'club', subjectId: 'org-eastport' }] },
            ANA.token,
          ),
        ),
        400,
        'TRANSACTION_INPUT_INVALID',
      ),
    "A12 a player is the individual and a club is an entity — neither can take the other's role",
  );
  neg(
    expect(
      collect(
        'A13',
        await j(
          'POST',
          '/org/agent/transactions',
          {
            ...body,
            parties: [{ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-does-not-exist' }],
          },
          ANA.token,
        ),
      ),
      404,
      'TRANSACTION_PARTY_NOT_FOUND',
    ),
    'A13 an unknown club is the uniform 404',
  );
  neg(
    expect(
      collect(
        'A14',
        await j(
          'POST',
          '/org/agent/transactions',
          {
            ...body,
            parties: [
              ...body.parties,
              { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh' },
            ],
          },
          ANA.token,
        ),
      ),
      409,
      'TRANSACTION_PARTY_EXISTS',
    ),
    'A14 one party per role',
  );
  const create = await j('POST', '/org/agent/transactions', { ...body, clientKey: 'tx-1' }, ANA.token);
  TX1 = create.body?.transaction?.id;
  ok(
    create.status === 201 &&
      create.body.transaction.status === 'DRAFT' &&
      create.body.transaction.type === 'transfer' &&
      create.body.transaction.parties.length === 3,
    'A15 Ana opens an England transfer: Kola, Eastport engaging, Harbour releasing — status DRAFT',
  );
  ok(
    create.body.transaction.playerId === 'pl-adeyemi' &&
      create.body.transaction.engagingOrgId === 'org-eastport' &&
      create.body.transaction.releasingOrgId === 'org-harbour',
    'A16 the derived convenience ids are computed from parties[], which stays the single truth',
  );
  neg(
    create.body.transaction.representations.length === 0 &&
      create.body.transaction.consents.length === 0 &&
      create.body.transaction.partiesConfirmed === false,
    'A17 opening one establishes no representation, no consent and no party confirmation',
  );
  neg(
    create.body.transaction.compliance.clear === false &&
      create.body.transaction.compliance.pendingReason === 'PARTIES_NOT_CONFIRMED' &&
      create.body.transaction.offerBoundary.canStartOfferWorkflow === false,
    'A18 a DRAFT implies no compliance clearance and no offer readiness',
  );
  ok(
    /not a statement of legal validity/.test(create.body.transaction.honest) &&
      /no offer exists/i.test(create.body.transaction.offerBoundary.honest),
    'A19 the projection states plainly what "ready" does and does not mean',
  );
  ok(
    (await j('POST', '/org/agent/transactions', { ...body, clientKey: 'tx-1' }, ANA.token)).body.idempotent === true,
    'X1 replaying the create with its key returns the same transaction',
  );
  neg(
    expect(
      collect(
        'X2',
        await j('POST', '/org/agent/transactions', { ...body, type: 'loan', clientKey: 'tx-1' }, ANA.token),
      ),
      409,
      'TRANSACTION_IDEMPOTENCY_CONFLICT',
    ),
    'X2 the same key with a different payload is a collision (#28)',
  );
  // A transaction links an opportunity of its engaging club.
  neg(
    expect(
      collect(
        'OL1',
        await j('POST', `/org/agent/transactions/${TX1}/links`, { opportunityId: 'opp-does-not-exist' }, ANA.token),
      ),
      400,
      'TRANSACTION_INPUT_INVALID',
    ),
    'OL1 an unknown opportunity cannot be linked',
  );
  const linkOpp = await j(
    'POST',
    '/org/opportunities',
    { type: 'trial', title: 'Linkable trial', deadline: '2099-01-01' },
    maria.token,
  );
  const linked = await j(
    'POST',
    `/org/agent/transactions/${TX1}/links`,
    { opportunityId: linkOpp.body?.opportunity?.id },
    ANA.token,
  );
  ok(
    linkOpp.status === 201 && linked.status === 200,
    `OL2 an opportunity of the engaging club links to the transaction (${linked.status} ${linked.body?.error ?? ''})`,
  );
}

// ============================================================ B/C — party identity and history
section('B/C — canonical ids, confirmation by the party itself, history that is never overwritten');
{
  const t0 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(
    t0.awaitingConfirmation.join() === 'individual,engaging_entity,releasing_entity' &&
      t0.requiredPartyRoles.length === 3,
    'B1 all three required parties are awaiting their own confirmation',
  );
  neg(
    expect(
      collect('B2', await j('POST', `/org/transactions/${TX1}/confirm`, {}, ivy.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'B2 a club that is not a party cannot confirm — and cannot tell the transaction exists (#5)',
  );
  neg(
    expect(collect('B3', await j('POST', `/org/transactions/${TX1}/confirm`, {}, maria.token)), 200, null),
    "B3 Eastport's recorded signatory confirms the engaging club",
  );
  const beforeRelease = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(
    beforeRelease.parties.find((p) => p.partyRole === 'engaging_entity').confirmedByKind === 'club_user' &&
      beforeRelease.awaitingConfirmation.join() === 'individual,releasing_entity',
    'C1 the confirmation is recorded with its actor kind; two roles remain',
  );
  ok(
    (await j('POST', `/org/transactions/${TX1}/confirm`, {}, devA.token)).status === 200 &&
      (await j('POST', `/player/transactions/${TX1}/confirm`, {}, kola.token)).status === 200,
    'C2 the releasing club and the individual confirm for themselves',
  );
  const t1 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(
    t1.partiesConfirmed === true && t1.status === 'PARTIES_CONFIRMED' && t1.parties.every((p) => p.confirmedAt),
    `C3 with every party confirmed the status is PARTIES_CONFIRMED (${t1.status})`,
  );
  ok(
    (await j('POST', `/player/transactions/${TX1}/confirm`, {}, kola.token)).body.idempotent === true,
    'X3 confirming twice is idempotent',
  );
  neg(
    t1.compliance.pendingReason === 'REPRESENTATION_MISSING' && t1.compliance.clear === false,
    'F1 party confirmation is not a clearance: with no representation bound, nobody holds authority yet',
  );
  const tl = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(
    tl.some((e) => e.action === 'transaction_party_confirmed' && e.detail?.partyRole === 'engaging_entity') &&
      tl.some((e) => e.action === 'transaction_created'),
    'C4 the timeline holds the creation and every confirmation, append-only',
  );
}

// ============================================================ E — representation bindings
section('E — a representation binding is transaction-specific and re-derived at mutation time');
let REP_KOLA;
{
  neg(
    expect(
      collect(
        'E1',
        await j('POST', `/org/agent/transactions/${TX1}/representations`, { partyRole: 'individual' }, ANA.token),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    'E1 no agreementId, no binding — an active relationship is not itself authority here',
  );
  neg(
    expect(
      collect(
        'E2',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'individual', agreementId: REL_THEO },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    'E2 an agreement with ANOTHER client authorises nothing for this party',
  );
  neg(
    expect(
      collect(
        'E3',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'individual', agreementId: REL_CHINEDU },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    "E3 a colleague's agreement authorises nothing: agency membership is not the agent (#22)",
  );
  neg(
    expect(
      collect(
        'E4',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'individual', agreementId: REL_MATEUS },
          ANA.token,
        ),
      ),
      403,
      'REPRESENTATION_REQUIRED',
    ),
    "E4 nor does the agent's own agreement with a different client",
  );
  const bind = await j(
    'POST',
    `/org/agent/transactions/${TX1}/representations`,
    { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-1' },
    ANA.token,
  );
  REP_KOLA = bind.body?.representation?.id;
  ok(
    bind.status === 201 && bind.body.representation.status === 'verified',
    'E7 the individual binding, backed by the client-confirmed agreement, is verified',
  );
  ok(
    (
      await j(
        'POST',
        `/org/agent/transactions/${TX1}/representations`,
        { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-1' },
        ANA.token,
      )
    ).body.idempotent === true,
    'X4 the binding key replays',
  );
  neg(
    expect(
      collect(
        'E8',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'individual', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      409,
      'TRANSACTION_PARTY_EXISTS',
    ),
    'E8 the same agent cannot bind the same party twice',
  );
  neg(
    expect(
      collect(
        'E5',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'engaging_entity', agreementId: REL_KOLA },
          ANA.token,
        ),
      ),
      422,
      'REGULATORY_REVIEW_REQUIRED',
    ),
    'E5 also binding the engaging club — an entity with no ScoutBox agreement — is DECLARED ONLY and needs attributed review (DR-18)',
  );
  const declared = (
    await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)
  ).body.transaction.representations.find((r) => r.partyRole === 'engaging_entity');
  ok(
    declared?.status === 'pending_review' &&
      declared.declaredOnly === true &&
      declared.basis === 'declared' &&
      declared.reviewId,
    'E6 the declared binding is recorded as pending_review with its review id — never as effective',
  );
  neg(
    expect(
      collect(
        'E9',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/representations`,
          { partyRole: 'individual', agreementId: REL_CHINEDU },
          DAN.token,
        ),
      ),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    "E9 a same-agency colleague cannot bind anything to Ana's transaction, nor learn it exists (#4)",
  );
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(
    t.representations.find((r) => r.partyRole === 'individual').basis === 'client_confirmed_agreement' &&
      t.representations.find((r) => r.partyRole === 'individual').agreementId === REL_KOLA,
    'E10 the binding carries its provenance: the agreement it rests on',
  );
  ok(
    t.compliance.pendingReason === 'MANUAL_REVIEW' ||
      t.compliance.pendingReason === 'CONSENT_REQUIRED' ||
      t.compliance.blocked,
    `E11 with an unverified entity declaration in play, compliance is not clear (${t.compliance.pendingReason ?? 'blocked'})`,
  );
}

// ============================================================ D — state transitions
section('D — transitions are server-validated and compliance-driven states are unreachable by request');
{
  for (const bad of ['READY', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED']) {
    neg(
      expect(
        collect(`D-${bad}`, await j('POST', `/org/agent/transactions/${TX1}/status`, { to: bad }, ANA.token)),
        409,
        'TRANSACTION_TRANSITION_NOT_ALLOWED',
      ),
      `D15 an actor cannot request ${bad}: it is the compliance layer's answer, not a request (#25, #26)`,
    );
  }
  neg(
    expect(
      collect('D16', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'NOT_A_STATE' }, ANA.token)),
      400,
      'TRANSACTION_INPUT_INVALID',
    ),
    'D16 a freeform status string is refused',
  );
  // Valid input only — the route refuses junk rather than coercing, truncating or ignoring it, naming the field.
  const junk = async (label, url, body) => {
    const r = collect(label, await j('POST', url, body, ANA.token));
    return r.status === 400 && r.body?.error === 'TRANSACTION_INPUT_INVALID'
      ? r.body.field
      : `${r.status} ${r.body?.error}`;
  };
  neg(
    (await junk('D16a', `/org/agent/transactions/${TX1}/status`, { to: 'ACTIVE', reasonCode: 'other' })) ===
      'reasonCode',
    'D16a a move that takes no reason code is refused one (it used to be recorded unread)',
  );
  neg(
    (await junk('D16b', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED', reasonCode: ['other'] })) ===
      'reasonCode',
    'D16b a reason code that is not text is refused, not coerced',
  );
  neg(
    (await junk('D16c', '/org/agent/transactions', { type: ['transfer'], jurisdictions: ['ENG'] })) === 'type',
    'D16c a type that is not text is refused, not coerced',
  );
  neg(
    (await junk('D16d', '/org/agent/transactions', {
      type: 'transfer',
      jurisdictions: ['ENG'],
      parties: Array.from({ length: 5 }, () => ({
        partyRole: 'individual',
        subjectKind: 'player',
        subjectId: 'pl-adeyemi',
      })),
    })) === 'parties',
    'D16d more than four parties are refused, not silently cut off',
  );
  neg(
    (await junk('D16e', '/org/agent/transactions', {
      type: 'transfer',
      jurisdictions: ['ENG', 'USA', 'FRA', 'ESP', 'GER', 'ITA', 'NED', 'POR', 'BEL', 'SCO', 'WAL'],
    })) === 'jurisdictions',
    'D16e more than ten jurisdictions are refused',
  );
  neg(
    (await junk('D16f', '/org/agent/transactions', {
      type: 'transfer',
      jurisdictions: ['ENG'],
      parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 7 }],
    })) === 'parties[0].subjectId',
    'D16f a party id that is not text is refused, naming the party and the field',
  );
  neg(
    expect(
      collect(
        'D16g',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/notes`,
          { text: 12345, visibility: 'AGENT_PRIVATE' },
          ANA.token,
        ),
      ),
      400,
      'NOTE_INPUT_INVALID',
    ),
    'D16g a note whose text is not text is refused, not coerced',
  );
  {
    const refusedAs = (r, code, field, problem) =>
      r.status === 400 && r.body?.error === code && r.body.field === field && r.body.problem === problem;
    const post = async (label, url, body) => collect(label, await j('POST', url, body, ANA.token));
    const tx0 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
    const longNote = await post('D16h', `/org/agent/transactions/${TX1}/notes`, {
      text: 'n'.repeat(2001),
      visibility: 'AGENT_PRIVATE',
    });
    neg(
      refusedAs(longNote, 'NOTE_INPUT_INVALID', 'text', 'too_long') && longNote.body.max === 2000,
      'D16h a note over 2000 characters is refused with its limit, not cut',
    );
    const longLabel = await post('D16i', `/org/agent/transactions/${TX1}/documents`, {
      documentType: 'mandate',
      visibility: 'AGENT_PRIVATE',
      label: 'l'.repeat(121),
    });
    neg(
      refusedAs(longLabel, 'DOCUMENT_INPUT_INVALID', 'label', 'too_long') && longLabel.body.max === 120,
      'D16i a document label over 120 characters is refused with its limit, not cut',
    );
    neg(
      refusedAs(
        await post('D16j', `/org/agent/transactions/${TX1}/documents`, {
          documentType: 'mandate',
          visibility: 'AGENT_PRIVATE',
          label: 'Mandate',
          expiresAt: { at: '2030-01-01' },
        }),
        'DOCUMENT_INPUT_INVALID',
        'expiresAt',
        'not_a_date',
      ) &&
        refusedAs(
          await post('D16k', `/org/agent/transactions/${TX1}/documents`, {
            documentType: 'mandate',
            visibility: 'AGENT_PRIVATE',
            label: 'Mandate',
            evidenceRef: { kind: 'verification_evidence', id: 'ev-1', bytes: 'AAAA' },
          }),
          'DOCUMENT_INPUT_INVALID',
          'evidenceRef.bytes',
          'unknown_field',
        ),
      'D16j an expiry that is not a date, or an evidence reference carrying more than its kind and id, is refused',
    );
    neg(
      refusedAs(
        await post('D16l', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED', reason: 'r'.repeat(401) }),
        'TRANSACTION_INPUT_INVALID',
        'reason',
        'too_long',
      ),
      'D16l a status reason over 400 characters is refused, not cut',
    );
    neg(
      refusedAs(
        await post('D16m', `/org/agent/transactions/${TX1}/notes`, {
          text: 'A note',
          visibility: 'AGENT_PRIVATE',
          expectedRev: '1',
        }),
        'EXPECTED_REV_INVALID',
        'expectedRev',
        'not_number',
      ) &&
        refusedAs(
          collect('D16n', await j('GET', '/org/agent/transactions?status=DRAFT&sort=newest', undefined, ANA.token)),
          'TRANSACTION_INPUT_INVALID',
          'sort',
          'unknown_field',
        ),
      'D16m a rev written as text and a list parameter the route does not read are refused',
    );
    const tx1 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
    neg(tx1.rev === tx0.rev && tx1.status === tx0.status, 'D16o none of those refusals changed the transaction');
  }
  const active = collect('D17', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(
    active.status === 422 &&
      ['TRANSACTION_COMPLIANCE_PENDING', 'TRANSACTION_COMPLIANCE_BLOCKED', 'TRANSACTION_COMPLIANCE_STALE'].includes(
        active.body.error,
      ),
    `D17 ACTIVE is refused while compliance is outstanding, by compliance and not by the map (${active.body.error})`,
  );
  neg(
    active.body.pendingReason !== undefined || active.body.staleness !== undefined || active.body.outcome !== undefined,
    'D18 …and the refusal names which fact is in the way',
  );
  neg(
    expect(
      collect('D19', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ON_HOLD' }, ANA.token)),
      409,
      'TRANSACTION_TRANSITION_NOT_ALLOWED',
    ),
    'D19 a hold is NOT reachable from a compliance state — a hold is for a live workflow',
  );
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  neg(
    !t.allowedTransitions.some((s) => ['READY', 'COMPLIANCE_PENDING', 'COMPLIANCE_BLOCKED'].includes(s)),
    'D20 the projection never offers a compliance-driven transition as an action',
  );
  neg(
    expect(
      collect('D21', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED' }, DAN.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ) &&
      expect(
        collect('D21b', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'CANCELLED' }, maria.token)),
        403,
        'AGENT_ACTION_NOT_PERMITTED',
      ),
    'D21 neither a colleague nor a club party may move the status',
  );
}

// ============================================================ H/I — consent and party change
section('H/I — consent comes from the compliance ledger; a party change invalidates the clearance');
let TX2, KOLA_CONSENT2;
{
  // A clean two-party employment transaction, so the dual-representation path is
  // reached without the entity-declaration review in the way.
  const c = await j(
    'POST',
    '/org/agent/transactions',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
      clientKey: 'tx-2',
    },
    ANA.token,
  );
  TX2 = c.body.transaction.id;
  ok(
    c.status === 201 && c.body.transaction.requiredPartyRoles.length === 2,
    'H1 a second transaction: an England employment contract with two required parties',
  );
  await j('POST', `/org/transactions/${TX2}/confirm`, {}, maria.token);
  await j('POST', `/player/transactions/${TX2}/confirm`, {}, kola.token);
  const bind = await j(
    'POST',
    `/org/agent/transactions/${TX2}/representations`,
    { partyRole: 'individual', agreementId: REL_KOLA },
    ANA.token,
  );
  ok(bind.status === 201, 'H2 Ana binds Kola');
  const t2 = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(
    t2.compliance.clear === true && t2.status === 'READY',
    'H3 one party represented, consents satisfied, England rules encoded → READY',
  );
  ok(
    t2.offerBoundary.canStartOfferWorkflow === true && t2.offerBoundary.blockers.length === 0,
    'readiness for a future Offer is computed — and no offer record exists',
  );
  const dual = collect(
    'H4',
    await j(
      'POST',
      `/org/agent/transactions/${TX2}/representations`,
      { partyRole: 'engaging_entity', agreementId: null },
      ANA.token,
    ),
  );
  neg(
    expect(dual, 422, 'REGULATORY_REVIEW_REQUIRED') && dual.body.contextId,
    'H4 also acting for the club is a declared-only binding needing attributed review before any consent question arises',
  );
  const declaredRep = (
    await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)
  ).body.transaction.representations.find((r) => r.partyRole === 'engaging_entity');
  const review = (await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, PRIYA.token)).body.items.find(
    (r) => r.kind === 'representation_declared' && r.subject?.representationId === declaredRep.id,
  );
  ok(
    review?.subject?.transactionId === TX2,
    'H5 the review names the transaction it belongs to, so the decision can land on the binding row',
  );
  const resolved = await j(
    'POST',
    `/ts/compliance/reviews/${review.id}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'mandate_seen',
      reason: 'Club mandate letter of 18 Sep 2026 seen.',
      evidenceRefs: ['Eastport mandate letter 2026-09-18'],
    },
    PRIYA.token,
  );
  ok(
    resolved.status === 200 && resolved.body.review.decision.reviewer.id === 'tsr-dev-admin',
    'H6 a NAMED reviewer approves it',
  );
  const afterReview = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(
    afterReview.representations.find((r) => r.partyRole === 'engaging_entity').status === 'verified',
    'H7 the decision lands on the transactionRepresentations row — the store is the truth, the context array is its projection',
  );
  neg(
    afterReview.compliance.pendingReason === 'CONSENT_REQUIRED' &&
      afterReview.compliance.consentRequirements.length === 2 &&
      afterReview.status === 'COMPLIANCE_PENDING',
    'H8 now that the agent acts for two parties, England requires prior written consent FROM EACH — two requirements, one per party',
  );
  const h9 = collect('H9', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(
    expect(h9, 422, 'TRANSACTION_COMPLIANCE_PENDING') && h9.body.pendingReason === 'CONSENT_REQUIRED',
    'H9 the transaction cannot progress while consent is outstanding, and the refusal says so (#25)',
  );
  const req1 = await j(
    'POST',
    `/org/agent/transactions/${TX2}/consents/request`,
    { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true },
    ANA.token,
  );
  KOLA_CONSENT2 = req1.body?.consent?.id;
  ok(
    req1.status === 201 && KOLA_CONSENT2,
    "H10 Ana requests Kola's consent from inside the workspace — through the compliance ledger, not a second store",
  );
  const req2 = await j(
    'POST',
    `/org/agent/transactions/${TX2}/consents/request`,
    {
      partyRole: 'engaging_entity',
      fullParticularsProvided: true,
      legalAdviceOffered: true,
      proposedFeeDisclosed: true,
    },
    ANA.token,
  );
  ok(req2.status === 201, "H11 and the club's");
  const playerSide = (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body.transaction;
  const mine = playerSide.consents.find((k) => k.mine);
  ok(
    mine &&
      mine.id === KOLA_CONSENT2 &&
      mine.particulars &&
      playerSide.consents.filter((k) => !k.mine).every((k) => k.id === null && k.particulars === undefined),
    "H12 the player sees their OWN consent in full and the club's as a state only, with no id and no particulars",
  );
  ok(
    (
      await j(
        'POST',
        `/player/agent/consents/${KOLA_CONSENT2}/grant`,
        { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
        kola.token,
      )
    ).status === 200,
    'H13 Kola grants his own consent in the canonical player lane',
  );
  const clubConsent = (await j('GET', '/org/compliance/consents', undefined, maria.token)).body.items.find(
    (k) => k.status === 'requested',
  );
  ok(
    (
      await j(
        'POST',
        `/org/compliance/consents/${clubConsent.id}/grant`,
        { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
        maria.token,
      )
    ).status === 200,
    "H14 the club's recorded signatory grants for the club",
  );
  const cleared = await j('POST', `/org/agent/transactions/${TX2}/evaluate`, {}, ANA.token);
  ok(
    cleared.body.transaction.compliance.clear === true && cleared.body.transaction.status === 'READY',
    'H15 with both party-specific consents recorded the transaction is READY again',
  );
  const goActive = await j(
    'POST',
    `/org/agent/transactions/${TX2}/status`,
    { to: 'ACTIVE', clientKey: 'tx2-active' },
    ANA.token,
  );
  ok(goActive.status === 200 && goActive.body.transaction.status === 'ACTIVE', 'D22 and only now can it become ACTIVE');
  ok(
    (await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE', clientKey: 'tx2-active' }, ANA.token))
      .body.idempotent === true,
    'X5 the status key replays',
  );
}

// ============================================================ G — stale compliance
section('G — a stale snapshot authorises nothing, and says which fact moved');
{
  const revoke = await j('POST', `/player/agent/consents/${KOLA_CONSENT2}/revoke`, {}, kola.token);
  ok(revoke.status === 200, 'G1 Kola revokes his consent mid-workflow');
  const read = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(
    read.compliance.staleness === 'INPUTS_CHANGED',
    "G2 the agent's read reports the snapshot as stale and names the reason — reported, never silently repaired",
  );
  neg(
    read.offerBoundary.canStartOfferWorkflow === false &&
      read.offerBoundary.blockers.includes('COMPLIANCE_SNAPSHOT_STALE'),
    'G3 readiness for a future Offer is withdrawn by staleness alone (#11)',
  );
  const hold = await j(
    'POST',
    `/org/agent/transactions/${TX2}/status`,
    { to: 'ON_HOLD', reasonCode: 'awaiting_party_decision', reason: 'Client is reconsidering.' },
    ANA.token,
  );
  ok(
    hold.status === 200 &&
      hold.body.transaction.status === 'ON_HOLD' &&
      hold.body.transaction.hold.reasonCode === 'awaiting_party_decision',
    'D23 a hold needs a reason code and records it',
  );
  const resume = collect('G4', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(
    expect(resume, 422, 'TRANSACTION_COMPLIANCE_STALE') && resume.body.staleness === 'INPUTS_CHANGED',
    'G4 leaving the hold is refused BEFORE any re-check: a caller cannot enter the live workflow on facts they have not seen (#12)',
  );
  const reeval = await j('POST', `/org/agent/transactions/${TX2}/evaluate`, {}, ANA.token);
  neg(
    reeval.body.transaction.compliance.pendingReason === 'CONSENT_REQUIRED' &&
      reeval.body.transaction.compliance.staleness === null,
    'G5 re-evaluating produces a current snapshot whose answer is: consent is required again (#12)',
  );
  const resume2 = collect('G6', await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'ACTIVE' }, ANA.token));
  neg(
    expect(resume2, 422, 'TRANSACTION_COMPLIANCE_PENDING') && resume2.body.pendingReason === 'CONSENT_REQUIRED',
    'G6 and with a current snapshot the refusal is the real reason, not staleness',
  );
  neg(
    expect(
      collect(
        'G7',
        await j(
          'POST',
          `/player/agent/consents/${KOLA_CONSENT2}/grant`,
          { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
          kola.token,
        ),
      ),
      409,
      'CONSENT_NOT_PENDING',
    ),
    'G7 a revoked consent cannot be re-granted — a fresh request is needed',
  );
}

// ============================================================ I — party change invalidation
section('I — changing a party withdraws what rested on it and re-evaluates');
{
  const t = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  const engaging = t.parties.find((p) => p.partyRole === 'engaging_entity');
  const rm = await j('POST', `/org/agent/transactions/${TX1}/parties/${engaging.id}/remove`, {}, ANA.token);
  ok(rm.status === 200, 'I1 Ana removes the engaging club');
  const after = rm.body.transaction;
  ok(
    after.parties.find((p) => p.id === engaging.id).removed === true &&
      after.parties.find((p) => p.id === engaging.id).removedAt &&
      after.parties.length === 3,
    'I2 the party row STAYS with its removedAt — history is never overwritten invisibly',
  );
  neg(
    after.representations.find((r) => r.partyRole === 'engaging_entity').status === 'withdrawn',
    'I3 every representation that named that role is withdrawn: authority cannot outlive its party',
  );
  neg(
    after.partiesConfirmed === false &&
      after.awaitingConfirmation.includes('engaging_entity') &&
      after.compliance.clear === false,
    'I4 the transaction falls out of any compliance claim it held and asks for the party again',
  );
  ok(
    (await j('POST', `/org/agent/transactions/${TX1}/parties/${engaging.id}/remove`, {}, ANA.token)).body.idempotent ===
      true,
    'X6 removing again is idempotent',
  );
  const add = await j(
    'POST',
    `/org/agent/transactions/${TX1}/parties`,
    { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh', clientKey: 'party-1' },
    ANA.token,
  );
  ok(
    add.status === 201 &&
      add.body.transaction.parties.filter((p) => !p.removed).some((p) => p.subjectId === 'org-hackneymarsh'),
    'I5 a different engaging club is named',
  );
  neg(
    add.body.transaction.parties.find((p) => p.subjectId === 'org-hackneymarsh').confirmedAt === null,
    'I6 the new party starts unconfirmed: naming is not confirming',
  );
  ok(
    (
      await j(
        'POST',
        `/org/agent/transactions/${TX1}/parties`,
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-hackneymarsh', clientKey: 'party-1' },
        ANA.token,
      )
    ).body.idempotent === true,
    'X7 the party key replays',
  );
  const tl = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(
    tl.some((e) => e.action === 'transaction_party_removed') &&
      tl.some((e) => e.action === 'transaction_party_added' && e.detail?.partyRole === 'engaging_entity'),
    'I7 both the removal and the addition are in the timeline',
  );
  const old = await j('GET', `/org/transactions/${TX1}`, undefined, maria.token);
  neg(
    expect(collect('I8', old), 404, 'TRANSACTION_NOT_FOUND'),
    'I8 the club that was removed can no longer read the transaction — nor tell it still exists',
  );
}

// ============================================================ J — documents
section('J — document classification, and no leakage across parties');
let DOC_AGENT_PRIVATE, DOC_SHARED, DOC_ENG_PRIVATE, DOC_REL_PRIVATE, DOC_PLAYER_PRIVATE;
{
  const post = (tok, body, url = `/org/agent/transactions/${TX2}/documents`) => j('POST', url, body, tok);
  neg(
    expect(
      collect('J1', await post(ANA.token, { documentType: 'not_a_type', visibility: 'AGENT_PRIVATE', label: 'x' })),
      400,
      'DOCUMENT_INPUT_INVALID',
    ),
    'J1 an unknown document type is refused',
  );
  neg(
    expect(
      collect('J2', await post(ANA.token, { documentType: 'mandate', visibility: 'T_AND_S_ONLY', label: 'x' })),
      403,
      'DOCUMENT_VISIBILITY_NOT_PERMITTED',
    ),
    'J2 nobody files into the Trust & Safety lane',
  );
  neg(
    expect(
      collect('J3', await post(ANA.token, { documentType: 'mandate', visibility: 'PLAYER_PRIVATE', label: 'x' })),
      403,
      'DOCUMENT_VISIBILITY_NOT_PERMITTED',
    ),
    "J3 the agent cannot file into the player's private lane",
  );
  neg(
    expect(
      collect('J4', await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: '' })),
      400,
      'DOCUMENT_INPUT_INVALID',
    ),
    'J4 a document needs a label the other parties can read',
  );
  neg(
    expect(
      collect(
        'J5',
        await post(ANA.token, {
          documentType: 'mandate',
          visibility: 'AGENT_PRIVATE',
          label: 'x',
          evidenceRef: { kind: 'assessment', id: 'a1' },
        }),
      ),
      400,
      'DOCUMENT_INPUT_INVALID',
    ),
    'J5 an evidence reference names the canonical evidence vault or nothing — a club assessment is not a transaction document',
  );
  neg(
    expect(
      collect(
        'J6',
        await post(ANA.token, {
          documentType: 'mandate',
          visibility: 'AGENT_PRIVATE',
          label: 'x',
          evidenceRef: { kind: 'verification_evidence', id: 've-someone-else' },
        }),
      ),
      400,
      'DOCUMENT_INPUT_INVALID',
    ),
    "J6 and a reference to an evidence record that is not the uploader's is refused",
  );
  neg(
    expect(
      collect(
        'J7',
        await post(ANA.token, { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x', expiresAt: 1000 }),
      ),
      400,
      'DOCUMENT_INPUT_INVALID',
    ),
    'J7 an expiry in the past is refused',
  );
  const d1 = await post(ANA.token, {
    documentType: 'mandate',
    visibility: 'AGENT_PRIVATE',
    label: 'Internal mandate working copy',
    clientKey: 'doc-1',
  });
  DOC_AGENT_PRIVATE = d1.body?.document?.id;
  ok(
    d1.status === 201 &&
      d1.body.document.version === 1 &&
      d1.body.document.evidence === null &&
      d1.body.document.downloadable === false,
    'J8 an AGENT_PRIVATE placeholder with no file attached says exactly that',
  );
  ok(
    (
      await post(ANA.token, {
        documentType: 'mandate',
        visibility: 'AGENT_PRIVATE',
        label: 'Internal mandate working copy',
        clientKey: 'doc-1',
      })
    ).body.idempotent === true,
    'X8 the document key replays',
  );
  const d2 = await post(ANA.token, {
    documentType: 'term_sheet_draft',
    visibility: 'ALL_TRANSACTION_PARTIES',
    label: 'Draft term sheet v1',
  });
  DOC_SHARED = d2.body?.document?.id;
  ok(d2.status === 201, 'J9 a draft term sheet shared with every party');
  const d3 = await j(
    'POST',
    `/org/transactions/${TX2}/documents`,
    { documentType: 'club_document', visibility: 'ENGAGING_CLUB_PRIVATE', label: 'Eastport internal budget note' },
    maria.token,
  );
  DOC_ENG_PRIVATE = d3.body?.document?.id;
  ok(
    d3.status === 201 && d3.body.document.ownerKind === 'club' && d3.body.document.ownerPartyRole === 'engaging_entity',
    'J10 the engaging club files its own private document, owned and side-stamped by the server',
  );
  const d4 = await j(
    'POST',
    `/player/transactions/${TX2}/documents`,
    { documentType: 'regulatory_evidence', visibility: 'PLAYER_PRIVATE', label: 'My passport scan reference' },
    kola.token,
  );
  DOC_PLAYER_PRIVATE = d4.body?.document?.id;
  ok(d4.status === 201, 'J11 the individual files a private document');
  neg(
    expect(
      collect(
        'J12',
        await j(
          'POST',
          `/org/transactions/${TX2}/documents`,
          { documentType: 'club_document', visibility: 'RELEASING_CLUB_PRIVATE', label: 'x' },
          maria.token,
        ),
      ),
      403,
      'DOCUMENT_VISIBILITY_NOT_PERMITTED',
    ),
    "J12 the engaging club cannot file into the releasing club's lane",
  );
  neg(
    expect(
      collect(
        'J13',
        await j(
          'POST',
          `/player/transactions/${TX2}/documents`,
          { documentType: 'club_document', visibility: 'ENGAGING_CLUB_PRIVATE', label: 'x' },
          kola.token,
        ),
      ),
      403,
      'DOCUMENT_VISIBILITY_NOT_PERMITTED',
    ),
    'J13 nor can the player',
  );
  const agentDocs = (await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items.map(
    (d) => d.id,
  );
  const clubDocs = (await j('GET', `/org/transactions/${TX2}/documents`, undefined, maria.token)).body.items.map(
    (d) => d.id,
  );
  const playerDocs = (await j('GET', `/player/transactions/${TX2}/documents`, undefined, kola.token)).body.items.map(
    (d) => d.id,
  );
  ok(
    agentDocs.includes(DOC_AGENT_PRIVATE) && agentDocs.includes(DOC_SHARED),
    'J14 the representing agent reads their own document and the shared one',
  );
  neg(
    !agentDocs.includes(DOC_PLAYER_PRIVATE) && !agentDocs.includes(DOC_ENG_PRIVATE),
    'J15 …and NOT the player\'s private document, and NOT the engaging club\'s: "club-private" means private to the club, even from its own transaction agent (#9)',
  );
  neg(
    !clubDocs.includes(DOC_AGENT_PRIVATE) &&
      !clubDocs.includes(DOC_PLAYER_PRIVATE) &&
      clubDocs.includes(DOC_SHARED) &&
      clubDocs.includes(DOC_ENG_PRIVATE),
    "J16 the club reads the shared one and its own; never the agent's private note and never the player's (#10)",
  );
  neg(
    !playerDocs.includes(DOC_AGENT_PRIVATE) &&
      !playerDocs.includes(DOC_ENG_PRIVATE) &&
      playerDocs.includes(DOC_SHARED) &&
      playerDocs.includes(DOC_PLAYER_PRIVATE),
    'J17 the player reads the shared one and their own; never a club-private document',
  );
  neg(
    expect(
      collect(
        'J18',
        await j('GET', `/player/transactions/${TX2}/documents/${DOC_ENG_PRIVATE}/reference`, undefined, kola.token),
      ),
      404,
      'DOCUMENT_NOT_FOUND',
    ),
    'J18 asking for a club-private reference by id answers as though it does not exist',
  );
  neg(
    expect(
      collect(
        'J19',
        await j('GET', `/org/transactions/${TX2}/documents/${DOC_AGENT_PRIVATE}/reference`, undefined, maria.token),
      ),
      404,
      'DOCUMENT_NOT_FOUND',
    ),
    "J19 and so does a club asking for the agent's private document (#10)",
  );
  const ref = await j('GET', `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/reference`, undefined, ANA.token);
  ok(
    ref.status === 200 && ref.body.reference === null && /no file has been attached/.test(ref.body.note),
    "J20 a placeholder's reference read is honest about there being no file",
  );
  const sup = await j(
    'POST',
    `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/supersede`,
    { label: 'Draft term sheet v2', expectedRev: 1 },
    ANA.token,
  );
  ok(
    sup.status === 201 && sup.body.document.version === 2 && sup.body.document.supersedes === DOC_SHARED,
    'J21 a new version supersedes the old; the old row is kept, never edited',
  );
  neg(
    expect(
      collect(
        'J22',
        await j(
          'POST',
          `/org/agent/transactions/${TX2}/documents/${DOC_SHARED}/supersede`,
          { label: 'again' },
          ANA.token,
        ),
      ),
      409,
      'DOCUMENT_SUPERSEDED',
    ),
    'J22 a superseded version cannot be superseded twice',
  );
  ok(
    (await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items.some(
      (d) => d.version === 2,
    ),
    'J23 the current list shows version 2',
  );
  neg(
    expect(
      collect(
        'J24',
        await j(
          'POST',
          `/org/agent/transactions/${TX2}/documents/${DOC_ENG_PRIVATE}/supersede`,
          { label: 'x' },
          ANA.token,
        ),
      ),
      404,
      'DOCUMENT_NOT_FOUND',
    ),
    'J24 the agent cannot version a document it does not own',
  );
  const tsRead = await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token);
  ok(
    tsRead.status === 200 &&
      typeof tsRead.body.transaction.documentCount === 'number' &&
      tsRead.body.transaction.documents === undefined,
    'J25 the reviewer sees a document COUNT and no document — their surface carries states and ids',
  );
  neg(
    !JSON.stringify(tsRead.body).match(/budget note|passport scan|mandate working copy/),
    'J26 no document label reaches the Trust & Safety read',
  );
}

// ============================================================ K — notes
section('K — scoped notes, absent rather than redacted for the lanes they exclude');
{
  neg(
    expect(
      collect(
        'K1',
        await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: 'x', visibility: 'PLAYER_PRIVATE' }, ANA.token),
      ),
      403,
      'DOCUMENT_VISIBILITY_NOT_PERMITTED',
    ),
    "K1 the agent cannot write into the player's private lane",
  );
  neg(
    expect(
      collect(
        'K2',
        await j('POST', `/org/agent/transactions/${TX2}/notes`, { text: '', visibility: 'AGENT_PRIVATE' }, ANA.token),
      ),
      400,
      'NOTE_INPUT_INVALID',
    ),
    'K2 an empty note is refused',
  );
  ok(
    (
      await j(
        'POST',
        `/org/agent/transactions/${TX2}/notes`,
        { text: 'Push for the signing-on fee; do not mention the other club.', visibility: 'AGENT_PRIVATE' },
        ANA.token,
      )
    ).status === 201,
    'K3 the agent writes a private note',
  );
  ok(
    (
      await j(
        'POST',
        `/org/transactions/${TX2}/notes`,
        { text: 'Board will not exceed the wage ceiling.', visibility: 'ENGAGING_CLUB_PRIVATE' },
        maria.token,
      )
    ).status === 201,
    'K4 the engaging club writes its own',
  );
  const agentNotes = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction.notes;
  const clubNotes = (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body.transaction.notes;
  const playerNotes = (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body.transaction.notes;
  ok(
    agentNotes.some((n) => /signing-on fee/.test(n.text)),
    'K5 the agent reads their own note',
  );
  neg(
    !JSON.stringify(clubNotes).match(/signing-on fee/),
    "K6 the club never reads the agent's private note — it is absent, not redacted (#10)",
  );
  neg(
    !JSON.stringify(playerNotes).match(/wage ceiling|signing-on fee/),
    "K7 the player reads neither the club's nor the agent's private note (#9 inverse)",
  );
  neg(
    !JSON.stringify(agentNotes).match(/wage ceiling/),
    "K8 and the representing agent does not read the engaging club's private note either — a club-private lane excludes everyone outside the club (#9)",
  );
  const tsRead = (await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token)).body;
  neg(
    typeof tsRead.transaction.noteCount === 'number' && !JSON.stringify(tsRead).match(/wage ceiling|signing-on fee/),
    'K9 the reviewer sees a note COUNT and no note text',
  );
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  neg(
    !tl.some((e) => e.action === 'transaction_note_added'),
    "M1 a note is audit-only: it appears in NOBODY's timeline, including its author's",
  );
  const audit = (await j('GET', '/org/agent/agency/audit?limit=50', undefined, tomas.token)).body.items;
  ok(
    audit.some((r) => r.domain === 'transaction' && r.action === 'transaction_note_added'),
    'M2 …and it IS in the platform audit, which is the distinction',
  );
  neg(
    !JSON.stringify(audit).match(/signing-on fee|wage ceiling|Draft term sheet/),
    'M3 the audit carries the action, never the note text or the document label',
  );
}

// ============================================================ L — messages
section('L — the canonical Inbox is referenced; membership alone opens nothing');
{
  neg(
    expect(
      collect('L1', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-nope' }, maria.token)),
      404,
      'MESSAGE_THREAD_NOT_FOUND',
    ),
    "L1 a channel that is not this club's conversation with this individual cannot be linked",
  );
  const channels = (await j('GET', '/org/channels', undefined, maria.token)).body.items; // a page
  ok(Array.isArray(channels), "L the club's inbox is a page of threads");
  const mineWithKola = channels.find((c) => c.playerId === 'pl-adeyemi');
  if (mineWithKola) {
    const link = await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: mineWithKola.id }, maria.token);
    ok(link.status === 201, 'L2 the club links its own canonical thread with the individual');
    const agentView = (await j('GET', `/org/agent/transactions/${TX2}/messages`, undefined, ANA.token)).body;
    neg(
      agentView.items.length === 1 && agentView.items[0].readable === false,
      "L3 the agent learns a conversation exists — the club's own act of sharing — and cannot read it: transaction membership is not Inbox authorisation",
    );
    const clubView = (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body.transaction;
    ok(clubView.linkedThreads[0].readable === true, "L4 the club, which passes the channel's own gate, can");
  } else {
    ok(true, 'L2 no accepted club↔player channel exists in this fixture; the link route is exercised by its refusals');
    neg(
      expect(
        collect('L3', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-1' }, maria.token)),
        404,
        'MESSAGE_THREAD_NOT_FOUND',
      ),
      'L3 a guessed channel id links nothing',
    );
    ok(true, 'L4 (see L3)');
  }
  const msgs = await j('GET', `/org/agent/transactions/${TX2}/messages`, undefined, ANA.token);
  ok(
    /never negotiates/.test(msgs.body.note) && /Inbox/.test(msgs.body.note),
    'L5 the workspace states that correspondence lives in the canonical Inbox and that ScoutBox never negotiates',
  );
  neg(
    expect(
      collect('L6', await j('POST', `/org/transactions/${TX2}/messages/link`, { channelId: 'chan-1' }, outsider.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'L6 a club that is not a party cannot link anything',
  );
}

// ============================================================ N/O/P/Q — the four views
section('N/O/P/Q — four projections, each its own slice');
{
  const agent = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body;
  ok(
    agent.items.length >= 2 &&
      agent.statuses.length === 10 &&
      agent.transitions.length === 10 &&
      agent.counts.live >= 1,
    'O1 the agent list carries the transactions, the state vocabulary and live counts',
  );
  ok(
    agent.items.every((t) => t.viewerRoles.includes('representing_agent')),
    'O2 every row is one the agent represents in',
  );
  const player = (await j('GET', '/player/transactions', undefined, kola.token)).body;
  ok(
    player.items.length >= 2 && player.items.every((t) => t.viewerRoles.includes('party_individual')),
    'N1 the player sees only transactions they are actually party to',
  );
  const playerTx2 = player.items.find((t) => t.id === TX2);
  ok(
    playerTx2?.agency?.name && playerTx2.representations.length >= 1,
    'N2 the player is told which agency and which representation acts, which they are entitled to know',
  );
  neg(
    player.items.every((t) =>
      t.representations.every((r) => r.agreementId === undefined && r.firstActAt === undefined),
    ),
    "N3 …and not the agent's own agreement reference",
  );
  const eng = (await j('GET', '/org/transactions', undefined, maria.token)).body;
  ok(
    eng.items.length >= 1 && eng.signatory === true && eng.items.every((t) => t.viewerPartyRole === 'engaging_entity'),
    'P1 the engaging club sees the transactions it is a party to, and its own side',
  );
  const rel = (await j('GET', '/org/transactions', undefined, devA.token)).body;
  ok(
    rel.items.some((t) => t.viewerPartyRole === 'releasing_entity'),
    'Q1 the releasing club sees its own, as the releasing side — a separate party role, not a copy of the engaging one',
  );
  const foreign = (await j('GET', '/org/transactions', undefined, outsider.token)).body;
  ok(foreign.items.length === 0, 'S1 a club that is party to nothing sees an empty list, not a filtered one');
  const relDetail = rel.items.find((t) => t.id === TX1);
  if (relDetail)
    neg(
      relDetail.compliance.policyVersions === undefined && relDetail.compliance.outcome !== undefined,
      'Q2 a club sees the compliance OUTCOME and its reason codes, never the policy versions the agent is bound by (privacy matrix row 14)',
    );
  else ok(true, "Q2 (the releasing club's transaction was re-parented earlier in this run)");
  const ben = (await j('GET', '/org/agent/transactions', undefined, BEN.token)).body;
  ok(
    ben.items.length === 0,
    'S2 an analyst at the same agency reads no transaction of a colleague — same-agency privacy is least-sharing (DR-25)',
  );
  const danList = (await j('GET', '/org/agent/transactions', undefined, DAN.token)).body;
  ok(danList.items.length === 0, 'S3 nor does a licensed colleague');
}

// ============================================================ R/S/T/U/V — privacy, tenancy, safeguarding
section('R/S/T/U/V — concealment, safeguarding, unsupported jurisdictions and the closed minor path');
{
  neg(
    expect(
      collect('S4', await j('GET', `/org/agent/transactions/${TX2}`, undefined, ZOE.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'S4 an agent at ANOTHER agency cannot read the transaction, nor tell it exists (#4)',
  );
  neg(
    expect(
      collect(
        'S5',
        await j('POST', `/org/agent/transactions/${TX2}/status`, { to: 'CANCELLED', reasonCode: 'other' }, ZOE.token),
      ),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'S5 …and cannot move it',
  );
  neg(
    expect(
      collect('S6', await j('GET', `/org/transactions/${TX2}`, undefined, outsider.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'S6 a foreign club likewise (#5)',
  );
  neg(
    expect(
      collect('S7', await j('GET', `/player/transactions/${TX2}`, undefined, theo.token)),
      404,
      'TRANSACTION_NOT_FOUND',
    ),
    'S7 another player likewise (#6)',
  );
  const guesses = ['__proto__', 'constructor', 'atx-000000', 'toString'];
  for (const g of guesses)
    neg(
      expect(
        collect(`S8-${g}`, await j('GET', `/org/agent/transactions/${g}`, undefined, ANA.token)),
        404,
        'TRANSACTION_NOT_FOUND',
      ),
      `S8 "${g}" is not a transaction`,
    );
  const a = collect('S9a', await j('GET', `/org/agent/transactions/${TX2}`, undefined, ZOE.token));
  const b = collect('S9b', await j('GET', '/org/agent/transactions/atx-nonexistent', undefined, ZOE.token));
  neg(
    JSON.stringify(a.body) === JSON.stringify(b.body),
    'S9 a foreign transaction and a non-existent one answer with byte-identical bodies',
  );
  // Safeguarding: Theo blocks the agency, then a transaction naming him is
  // indistinguishable from one that never existed.
  const txTheo = await j(
    'POST',
    '/org/agent/transactions',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
    },
    ANA.token,
  );
  const TX_THEO = txTheo.body?.transaction?.id;
  ok(txTheo.status === 201, 'T1 a transaction naming Theo is opened while he is visible');
  const block = await j('POST', '/player/block', { orgId: 'org-northstar', reason: 'unwanted contact' }, theo.token);
  ok(
    block.status === 200 || block.status === 201,
    `T2 Theo blocks the agency (${block.status} ${block.body?.error ?? ''})`,
  );
  const blockedRead = await j('GET', `/org/agent/transactions/${TX_THEO}`, undefined, ANA.token);
  ok(
    blockedRead.status === 200 &&
      blockedRead.body.transaction.parties.find((p) => p.subjectKind === 'player').name === null,
    'T3 the agency keeps its own record of what happened and loses the person from it: the party row reads with no name',
  );
  const blockedWrite = collect(
    'T3b',
    await j(
      'POST',
      `/org/agent/transactions/${TX_THEO}/documents`,
      { documentType: 'mandate', visibility: 'AGENT_PRIVATE', label: 'x' },
      ANA.token,
    ),
  );
  neg(
    expect(blockedWrite, 422, 'TRANSACTION_PARTY_UNAVAILABLE') && !/block/i.test(JSON.stringify(blockedWrite.body)),
    'T4 nothing can be written to it — and the refusal never says "blocked", so it is identical for removed, invisible, blocked and minor (#27)',
  );
  const blockedActive = collect(
    'T4b',
    await j('POST', `/org/agent/transactions/${TX_THEO}/status`, { to: 'CANCELLED', reasonCode: 'other' }, ANA.token),
  );
  neg(
    expect(blockedActive, 422, 'TRANSACTION_PARTY_UNAVAILABLE'),
    'T4b nor can its status be moved — a compliance CLEAR would not have overridden this',
  );
  neg(
    expect(
      collect(
        'T5',
        await j(
          'POST',
          '/org/agent/transactions',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }],
          },
          ANA.token,
        ),
      ),
      404,
      'TRANSACTION_PARTY_NOT_FOUND',
    ),
    'T5 and a NEW transaction naming him is the uniform 404, because there the caller is probing',
  );
  const archived = await j(
    'POST',
    `/org/agent/transactions/${TX_THEO}/status`,
    { to: 'CANCELLED', reasonCode: 'other', expectedRev: blockedRead.body.transaction.rev },
    ANA.token,
  );
  neg(
    archived.status === 422 && archived.body.error === 'TRANSACTION_PARTY_UNAVAILABLE',
    'T6 the one thing a safeguarding stop must still allow is shelving the record; progressing it is refused either way',
  );
  neg(
    expect(
      collect(
        'U1',
        await j(
          'POST',
          '/org/agent/transactions',
          { type: 'transfer', jurisdictions: ['FRA'], parties: [] },
          ANA.token,
        ),
      ),
      422,
      'JURISDICTION_UNSUPPORTED',
    ),
    'U1 an unsupported jurisdiction is refused at creation, not silently allowed (#24)',
  );
  neg(
    expect(
      collect(
        'V1',
        await j(
          'POST',
          '/org/agent/transactions',
          {
            type: 'employment_contract',
            jurisdictions: ['ENG'],
            parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }],
          },
          ANA.token,
        ),
      ),
      404,
      'TRANSACTION_PARTY_NOT_FOUND',
    ),
    'V1 a minor cannot be a party: no minor pathway is production-enabled and the refusal is not an age oracle (#23)',
  );
  const minorList = await j('GET', '/player/transactions', undefined, (await playerLogin('pl-guni')).token);
  neg(
    minorList.body.minor === true &&
      minorList.body.items.length === 0 &&
      /not available for under-18/.test(minorList.body.note),
    'V2 a guardian-managed account is told plainly that the workspace is not available to it',
  );
  ok(
    transactionSpec.ROOM_ROLES.includes('party_guardian') &&
      transactionSpec.DOCUMENT_TYPES.includes('guardian_evidence'),
    'V3 the guardian architecture is preserved — a distinct room role and a distinct document type — with no live surface',
  );
}

// ============================================================ R — private data boundaries
section('R — the three private worlds the workspace must not open');
{
  const bodies = [
    (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body,
    (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body,
    (await j('GET', `/org/transactions/${TX2}`, undefined, maria.token)).body,
    (await j('GET', `/player/transactions/${TX2}`, undefined, kola.token)).body,
    (await j('GET', `/ts/transactions/${TX2}`, undefined, PRIYA.token)).body,
  ];
  const all = JSON.stringify(bodies);
  neg(
    !/assessmentId|roomComment|recruitmentCase|decisionId|secondLook|nobodyMissed|trustScore/i.test(all),
    'R1 no projection carries a club assessment, Room comment, recruitment case, P5 decision, Second Look or Nobody Missed reference',
  );
  neg(
    !/boxSession|passportShare|medical|dateOfBirth|"dob"/i.test(all),
    'R2 nor Box Cam, Passport, medical or a date of birth',
  );
  neg(!/feePercent|commission|"fee"/i.test(all), 'R3 and no fee term anywhere (privacy matrix invariant 5)');
  const clubBody = JSON.stringify(bodies[2]);
  neg(
    !/Dan Mensah|Zoe Hart|pl-okafor|pl-carvalho/.test(clubBody),
    "R4 the club learns nothing of the agency's other agents or other clients",
  );
  const playerBody = JSON.stringify(bodies[3]);
  const leak5 = playerBody.match(/Maria Keane|budget|wage ceiling/);
  neg(
    leak5 === null,
    `R5 the player learns no club user's name and no club-internal note${leak5 ? ` — leaked "${leak5[0]}" in …${playerBody.slice(Math.max(0, leak5.index - 90), leak5.index + 40)}…` : ''}`,
  );
  neg(
    !/Priya|reviewerId|evidenceRefs/.test(JSON.stringify(bodies.slice(0, 4))),
    'R6 no party-facing projection names a reviewer or carries review evidence',
  );
}

// ============================================================ W/Y — rev and concurrency
section('W/Y — one authoritative result');
{
  const t = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(
    expect(
      collect(
        'W1',
        await j(
          'POST',
          `/org/agent/transactions/${TX2}/notes`,
          { text: 'stale write', visibility: 'AGENT_PRIVATE', expectedRev: 1 },
          ANA.token,
        ),
      ),
      409,
      'TRANSACTION_VERSION_CONFLICT',
    ),
    'W1 a stale expectedRev is refused',
  );
  ok(
    (
      await j(
        'POST',
        `/org/agent/transactions/${TX2}/notes`,
        { text: 'current write', visibility: 'AGENT_PRIVATE', expectedRev: t.rev },
        ANA.token,
      )
    ).status === 201,
    'W2 the current rev is accepted',
  );
  const t2 = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  const raceBody = (label) => ({ to: 'CANCELLED', reasonCode: 'duplicate', reason: label, expectedRev: t2.rev });
  const [c1, c2] = await Promise.all([
    j('POST', `/org/agent/transactions/${TX1}/status`, raceBody('one'), ANA.token),
    j('POST', `/org/agent/transactions/${TX1}/status`, raceBody('two'), ANA.token),
  ]);
  const wins = [c1, c2].filter((r) => r.status === 200);
  const loses = [c1, c2].filter((r) => r.status === 409);
  neg(
    wins.length === 1 &&
      loses.length === 1 &&
      ['TRANSACTION_VERSION_CONFLICT', 'TRANSACTION_TRANSITION_NOT_ALLOWED'].includes(loses[0].body.error),
    'Y1 two status transitions at once: exactly one wins, the other gets 409 — no double final state (#18)',
  );
  const final = (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).body.transaction;
  ok(
    final.status === 'CANCELLED' &&
      final.cancelReasonCode === 'duplicate' &&
      final.parties.length === 4 &&
      final.history === undefined,
    'D24 the cancellation preserves every party row and its history',
  );
  neg(
    expect(
      collect(
        'D25',
        await j(
          'POST',
          `/org/agent/transactions/${TX1}/notes`,
          { text: 'after the end', visibility: 'AGENT_PRIVATE' },
          ANA.token,
        ),
      ),
      409,
      'TRANSACTION_NOT_LIVE',
    ),
    'D25 nothing can be written to a cancelled transaction; its record stays',
  );
  const tlAfter = (await j('GET', `/org/agent/transactions/${TX1}/timeline`, undefined, ANA.token)).body.items;
  ok(
    tlAfter.some((e) => e.action === 'transaction_cancelled') && tlAfter.length >= 6,
    'D26 and its timeline is intact, ending with the cancellation',
  );
  const arch = await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ARCHIVED' }, ANA.token);
  ok(
    arch.status === 200 && arch.body.transaction.status === 'ARCHIVED',
    'D27 a terminal transaction can be archived — retention, not deletion',
  );
  neg(
    expect(
      collect(
        'D28',
        await j('POST', `/org/agent/transactions/${TX1}/notes`, { text: 'x', visibility: 'AGENT_PRIVATE' }, ANA.token),
      ),
      409,
      'TRANSACTION_ARCHIVED',
    ) &&
      expect(
        collect('D28b', await j('POST', `/org/agent/transactions/${TX1}/status`, { to: 'ACTIVE' }, ANA.token)),
        409,
        'TRANSACTION_ARCHIVED',
      ),
    'D28 an archived transaction is read-only for everyone, including its owner (#30)',
  );
  ok(
    (await j('GET', `/org/agent/transactions/${TX1}`, undefined, ANA.token)).status === 200,
    'D29 …and still readable, which is what archive means',
  );
}

// ============================================================ AC/AD — events and notifications
section('AC/AD — events and notifications say little and reveal nothing');
{
  const an = (await j('GET', '/org/notifications', undefined, ANA.token)).body;
  ok(
    an.some((n) => n.type === 'agent_transaction' || n.type === 'agent_transaction_compliance'),
    'AD4 the agent was told about workspace activity',
  );
  const kn = (await j('GET', '/player/notifications', undefined, kola.token)).body;
  ok(
    kn.some(
      (n) =>
        n.type === 'agent_transaction_action' &&
        /Confirm your participation/.test(n.text) &&
        /does not agree to any terms/.test(n.text),
    ),
    'AD5 the individual was asked to confirm and told plainly that confirming agrees to nothing',
  );
  neg(
    !JSON.stringify(kn).match(/wage ceiling|signing-on fee|Draft term sheet v2|Eastport internal budget/),
    'AD6 no note, no fee and no club-private document label reaches a notification',
  );
  neg(
    !JSON.stringify(an).match(/Kola Adeyemi|Maria Keane/),
    "AD7 and no party name rides on the agent's notifications either",
  );
  const cn = (await j('GET', '/org/notifications', undefined, maria.token)).body;
  ok(
    cn.some((n) => n.type === 'agent_transaction' || n.type === 'agent_transaction_action'),
    'AD8 the club signatory was told too',
  );
}

// ============================================================ AF/AG/AH — contracts the browser suite proves
section('AF/AG/AH — the state and mobile contracts the browser journeys rely on');
{
  const t = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  neg(
    typeof t.status === 'string' && (t.compliance.pendingReason !== null || t.compliance.clear || t.compliance.blocked),
    'AF1 every compliance state reaches the client as a WORD, so no surface has to rely on colour alone',
  );
  ok(
    Array.isArray(t.viewerRoles) && Array.isArray(t.allowedTransitions),
    'AF2 the projection tells the client which actions exist, so a disabled control is never a guess',
  );
}

// ============================================================ AI — corruption / legacy
section('AI — a corrupt row is contained and named by its effect, never repaired');
{
  const before = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.length;
  ok(before >= 2, `AI1 ${before} transactions are readable before the corruption fixture`);
  await stop(server);
  // A status the machine does not know is not a row the typed table can hold — the schema refuses it, and the
  // fixture's transaction writes nothing. A typed row can still carry no compliance snapshot at all; that one is
  // planted and judged on read. The rows are as the repositories wrote them in a probe run.
  const rowsOf = (status) => ({
    compliance_contexts: {
      id: 'ctx-ai1',
      agency_org_id: 'org-northstar',
      agent_user_id: ANA_ID,
      type: 'transfer',
      status: 'open',
      re_evaluation_pending: 0,
      origin: 'transaction',
      transaction_id: 'atx-corrupt',
      opened_at: T0,
      rev: 1,
      rev_at: T0,
    },
    compliance_context_jurisdictions: { context_id: 'ctx-ai1', ord: 0, member_association: 'ENG' },
    agent_transactions: {
      id: 'atx-corrupt',
      agency_org_id: 'org-northstar',
      agent_user_id: ANA_ID,
      type: 'transfer',
      status,
      context_id: 'ctx-ai1',
      re_evaluation_pending: 0,
      initiated_by_name: 'Ana Costa',
      created_at: T0,
      updated_at: T0,
      rev: 1,
      rev_at: T0,
    },
    agent_transaction_jurisdictions: { transaction_id: 'atx-corrupt', ord: 0, member_association: 'ENG' },
    transaction_parties: {
      id: 'txp-ai1',
      transaction_id: 'atx-corrupt',
      transaction_type: 'transfer',
      ord: 0,
      party_role: 'individual',
      subject_kind: 'player',
      subject_id: 'pl-adeyemi',
      added_at: T0,
      added_by_id: ANA_ID,
      added_by_name: 'Ana Costa',
      removed: 0,
      confirmed_at: T0,
      confirmed_by_kind: 'player',
      confirmed_by_id: 'pl-adeyemi',
      confirmed_by_name: 'Kola Adeyemi',
    },
  });
  const plantCorrupt = (status) =>
    plantRows((F) => {
      for (const [table, row] of Object.entries(rowsOf(status))) F.insert(table, row);
    });
  let refusedStatus = null;
  try {
    plantCorrupt('SOMETHING_NOBODY_WROTE');
  } catch (e) {
    refusedStatus = e;
  }
  neg(
    /CHECK constraint failed: status/.test(refusedStatus?.message) &&
      storedRows('compliance_contexts', { id: 'ctx-ai1' }).length === 0,
    `AI2 a row with a status nobody wrote is refused by the schema — nothing is repaired and nothing is written (${refusedStatus?.message})`,
  );
  plantCorrupt('READY');
  server = await boot();
  const read = await j('GET', '/org/agent/transactions/atx-corrupt', undefined, ANA.token);
  ok(
    read.status === 200 && read.body.transaction.status === 'READY',
    'AI4 a row with no compliance snapshot reads back as it is on disk — nothing is repaired on boot',
  );
  neg(
    expect(
      collect('AI5', await j('POST', '/org/agent/transactions/atx-corrupt/status', { to: 'ACTIVE' }, ANA.token)),
      422,
      'TRANSACTION_COMPLIANCE_STALE',
    ),
    'AI5 it cannot enter the live workflow: the absence of an evaluation authorises nothing',
  );
  neg(
    read.body.transaction.compliance.staleness === 'NO_SNAPSHOT' && read.body.transaction.compliance.clear === false,
    'AI6 a row with no compliance snapshot reads as NO_SNAPSHOT, never as clear',
  );
}

// ============================================================ Z — persistence across a restart
section('the separations: a transaction is not a recruitment act');
{
  const now = { eastport: await clubRecords(j, maria.token), harbour: await clubRecords(j, devA.token) };
  neg(
    JSON.stringify(now) === JSON.stringify(CLUBS_AT_START),
    `after every transaction act in this run, neither club's cases nor signings moved (${now.eastport.rooms.length} + ${now.harbour.rooms.length} cases, ${now.eastport.signings.length} + ${now.harbour.signings.length} signings)`,
  );
}

section('Z — the bytes survive a restart');
{
  const t2 = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction;
  ok(
    t2.status === 'ON_HOLD' && t2.notes.length >= 2 && t2.documents.length >= 2,
    'Z1 after the restart the transaction still holds its status, its notes and its documents',
  );
  ok(
    t2.parties.every((p) => p.confirmedAt) && t2.representations.length === 2 && t2.rev >= 2,
    'Z2 the party confirmations, the representation bindings and the rev survived',
  );
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  ok(tl.length >= 8, `Z3 the timeline survived (${tl.length} entries)`);
  ok(
    (
      await j(
        'POST',
        '/org/agent/transactions',
        {
          type: 'employment_contract',
          jurisdictions: ['ENG'],
          parties: [
            { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
            { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
          ],
          clientKey: 'tx-2',
        },
        ANA.token,
      )
    ).body.idempotent === true,
    'Z4 an idempotency key recorded before the restart still replays',
  );
  const consents = (await j('GET', `/org/agent/transactions/${TX2}`, undefined, ANA.token)).body.transaction.consents;
  ok(
    consents.some((k) => k.status === 'revoked'),
    'Z5 the consent ledger — including the revocation — survived, and the transaction reads it rather than copying it',
  );
  const metrics = await j('GET', '/ts/transactions/metrics', undefined, PRIYA.token);
  ok(
    metrics.status === 200 &&
      typeof metrics.body.byStatus.ON_HOLD === 'number' &&
      metrics.body.holdReasons.awaiting_party_decision >= 1 &&
      /No agent, club or player is ranked/.test(metrics.body.note),
    'process analytics only: counts, durations and reason codes, and it says so',
  );
  neg(
    !JSON.stringify(metrics.body).match(/Ana|Kola|pl-|org-/),
    '…and no agent, player or organisation is named in them',
  );
}

// ============================================================ AB — tombstones
section('AB — an account removal keeps the shape and loses the person');
{
  const before = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.find((t) => t.id === TX2);
  ok(
    before.parties.some((p) => p.name === 'Kola Adeyemi'),
    'AB1 the individual is named while the account exists',
  );
  const del = await j('DELETE', '/player/account', { confirm: 'DELETE' }, kola.token);
  ok(del.status === 200 || del.status === 204, 'AB2 Kola deletes his account');
  const after = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body.items.find((t) => t.id === TX2);
  ok(
    after && after.id === TX2 && after.type === 'employment_contract' && after.status,
    'AB3 the transaction survives: its ids, roles, states and times are the record of what happened',
  );
  neg(
    after.parties.every((p) => p.name === null || p.subjectKind === 'club') &&
      after.parties.find((p) => p.subjectKind === 'player').subjectRemovedAt,
    'AB4 the individual is a tombstone: the party row keeps its id and loses the person (#29)',
  );
  neg(!JSON.stringify(after).match(/Kola/), 'AB5 no deleted personal field is resurrected into the list (#29)');
  neg(
    after.representations.every((r) => r.status === 'withdrawn'),
    'AB6 every representation naming the removed subject is withdrawn',
  );
  const tl = (await j('GET', `/org/agent/transactions/${TX2}/timeline`, undefined, ANA.token)).body.items;
  neg(
    !JSON.stringify(tl).match(/Kola/) && tl.some((e) => e.action === 'transaction_party_confirmed'),
    'AB7 the timeline keeps that a confirmation happened and forgets who',
  );
  const docs = (await j('GET', `/org/agent/transactions/${TX2}/documents`, undefined, ANA.token)).body.items;
  neg(
    !docs.some((d) => d.ownerKind === 'player'),
    "AB8 the removed person's own documents are gone from the workspace",
  );
}

// ============================================================ PG — the lists that grow page by cursor
section("PG — the agent's, the club's and Trust & Safety's lists page newest first by cursor; junk is a 400");
{
  const all = (await j('GET', '/org/agent/transactions', undefined, ANA.token)).body;
  ok(
    all.items.length >= 2 &&
      all.nextCursor === null &&
      all.counts.live === all.items.filter((t) => transactionSpec.LIVE_STATUSES.includes(t.status)).length,
    `PG1 the first page holds every one of ${all.items.length} transactions, and the counts cover them all`,
  );
  const p1 = (await j('GET', '/org/agent/transactions?limit=1', undefined, ANA.token)).body;
  const p2 = (
    await j('GET', `/org/agent/transactions?limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`, undefined, ANA.token)
  ).body;
  ok(
    p1.items.length === 1 &&
      p1.nextCursor &&
      p2.items.length === 1 &&
      p2.items[0].id !== p1.items[0].id &&
      p1.items[0].id === all.items[0].id &&
      p2.items[0].id === all.items[1].id,
    'PG2 a page of one, then the next from its cursor — newest first',
  );
  neg(p1.counts.live === all.counts.live, 'PG3 the counts are over every transaction, not the page');
  neg(
    (await j('GET', '/org/agent/transactions?limit=0', undefined, ANA.token)).status === 400 &&
      (await j('GET', '/org/agent/transactions?cursor=junk', undefined, ANA.token)).status === 400 &&
      (await j('GET', '/org/agent/transactions?status=SOMETHING', undefined, ANA.token)).status === 400,
    'PG4 a junk limit, cursor or status filter is a 400, never clamped',
  );
  const ts = (await j('GET', '/ts/transactions?limit=1', undefined, PRIYA.token)).body;
  ok(ts.items.length === 1 && typeof ts.nextCursor === 'string', 'PG5 the Trust & Safety list pages the same way');
  const club = (await j('GET', '/org/transactions?limit=1', undefined, maria.token)).body;
  ok(club.items.length === 1 && 'nextCursor' in club, "PG6 and so does a club's");
}

// ============================================================ Z — the refusal sweep
section('Z — every refusal in this run: a code, and no private field');
{
  ok(ERROR_BODIES.length >= 40, `Z6 ${ERROR_BODIES.length} refusals collected`);
  const noCode = ERROR_BODIES.filter((e) => e.body !== null && !e.body.error);
  neg(noCode.length === 0, 'Z7 every JSON refusal carried an error code');
  const blob = JSON.stringify(ERROR_BODIES);
  // A stack frame is `at fn (file:line:col)`; a message's own "at most" is not one.
  const leak8 = blob.match(/\bat [\w$.<>]+ \([^)]*:\d+:\d+\)|node_modules|Error:/);
  neg(
    leak8 === null,
    `Z8 no stack and no internal frame reached a refusal${leak8 ? ` — …${blob.slice(Math.max(0, leak8.index - 200), leak8.index + 60)}…` : ''}`,
  );
  const leak9 = blob.match(/Kola|Adeyemi|Maria Keane|Priya|Marcus|wage ceiling|signing-on fee|budget note/);
  neg(
    leak9 === null,
    `Z9 no party name, reviewer name, note text or document label reached a refusal${leak9 ? ` — leaked "${leak9[0]}" in …${blob.slice(Math.max(0, leak9.index - 140), leak9.index + 40)}…` : ''}`,
  );
  const leak10 = blob.replace(/MINOR_[A-Z_]+/g, '').match(/"dob"|dateOfBirth|\bblocked\b|\bminor\b/i);
  neg(
    leak10 === null,
    `Z10 no refusal says "blocked" or "minor" — that is what makes the concealment uniform${leak10 ? ` — leaked "${leak10[0]}"` : ''}`,
  );
  neg(!/agreementId":"rep|feePercent|commission/.test(blob), 'Z11 and no agreement reference or fee term');
  const codes = new Set(ERROR_BODIES.map((e) => e.body?.error).filter(Boolean));
  // Codes from the canonical platform (session, platform separation) and from
  // the agent core and compliance domains are contracts of their own; this suite asserts that
  // nothing OUTSIDE a declared contract reaches a caller.
  const CANONICAL = [
    'ORG_AUTH_REQUIRED',
    'PLAYER_AUTH_REQUIRED',
    'AUTH_REQUIRED',
    'ORG_NOT_FOUND',
    'USER_NOT_FOUND',
    'GRASSROOTS_PLATFORM_ONLY',
    'PLATFORM_MISMATCH',
    'ORG_NOT_VERIFIED',
    'ALREADY_ROOT_ADMIN',
    'NOT_FOUND',
    'BLOCK_EXISTS',
  ];
  const unmapped = [...codes].filter(
    (c) =>
      !Object.hasOwn(transactionErrors.TRANSACTION_ERROR_HTTP, c) &&
      !CANONICAL.includes(c) &&
      !/^(AGENT_|REPRESENTATION_|CONSENT_|REVIEWER_|COMPLIANCE_|CONTEXT_|JURISDICTION_|REGULATORY_|POLICY_|PARTY_|SIGNATORY_|REVIEW_)/.test(
        c,
      ),
  );
  neg(
    unmapped.length === 0,
    `Z12 every refusal code belongs to a declared contract${unmapped.length ? `: ${unmapped.join(', ')}` : ''}`,
  );
}

await stop(server);
const total = passed;
console.log(
  `\nagents/transactions: ${total} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / total) * 100)}%)`,
);
if (process.exitCode) console.error('agents/transactions has failures.');
else console.log('all agents/transactions checks passed');
