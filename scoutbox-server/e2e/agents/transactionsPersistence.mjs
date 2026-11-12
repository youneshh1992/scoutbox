// Persistence, migration and restart audit for the Agent Transaction Workspace:
// (1) migration 0029 and its empty tables, (2) no existing case, context or
// agreement becomes a transaction, (3) a real boot over that database, (4) a full
// workspace survives a restart byte for byte, (5) corruption is refused by the
// typed tables or, where a row can hold it, planted and read as STALE.
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { pickPort } from '../../scripts/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openLayer, readRecords, writeFixture } from '../../scripts/dataLayerFixture.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { AGENT_TRANSACTIONS_MIGRATION } from '../../repositories/agentTransactions.mjs';
import {
  partyRevisionOf,
  snapshotStaleness,
  actorTransitionAllowed,
  TRANSACTION_STATUSES,
} from '../../domains/agents/transactions/transaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');
const STEP = AGENT_TRANSACTIONS_MIGRATION;
const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => {
  const st = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    return st
      .prepare('SELECT id, applied_at FROM data_migrations ORDER BY id')
      .all()
      .map((r) => ({ id: r.id, at: r.applied_at }));
  } finally {
    st.close();
  }
};
const STORES = ['agentTransactions', 'transactionRepresentations', 'transactionDocuments'];

let passed = 0;
let negatives = 0;
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`✓ ${m}`);
  } else fail(m);
};
const neg = (c, m) => {
  negatives++;
  ok(c, `[neg] ${m}`);
};
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stableJson = (v) => JSON.stringify(v);
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
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

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SCOUTBOX_QUIET_LOGS: '1',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => {
    log += b;
  });
  proc.stderr.on('data', (b) => {
    log += b;
  });
  proc.unref();
  proc.stdout.unref();
  proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) break;
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) console.error(`   boot log:\n${log.split('\n').slice(-12).join('\n')}`);
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, {
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
  };
  return {
    up,
    j,
    log: () => log,
    async stop() {
      proc.kill('SIGTERM');
      for (let i = 0; i < 80; i += 1) {
        if (proc.exitCode != null || proc.signalCode) break;
        await sleep(100);
      }
      await sleep(400);
    },
  };
}
const fixture = (dir, collections) => writeFixture(dir, collections, { idCounter: 500_000 });
/** Plant a state between boots through the repositories, as a route writes it, or with SQL for a state no route writes. */
const plant = (dir, work) => {
  const L = openLayer(dir);
  try {
    return L.unit(() => work(L.layer, L.sqlite));
  } finally {
    L.close();
  }
};

// ============================================================ 1
section('1 — migration 0029: registered once; the three stores are tables, EMPTY on a clean database');
{
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  ok(
    ids.filter((id) => id === STEP).length === 1 && SCHEMA_VERSION >= 29,
    `${STEP} is registered once; the current schema is ${SCHEMA_VERSION}`,
  );
  neg(
    new Set(ids.map((id) => id.slice(0, 4))).size === ids.length,
    'every migration reaches a distinct schema version — no version is advanced twice',
  );
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-fresh-'));
  const tables = readRecords(freshDir);
  neg(
    STORES.every((s) => Array.isArray(tables[s]) && tables[s].length === 0),
    'all three tables start EMPTY — a transaction is a new concept and no existing record is reinterpreted as one',
  );
  neg(
    !['offers', 'agencyInvoices'].some((n) => TABLE_BACKED.includes(n)),
    'no offer and no agency-invoice store exists (out of scope; the invoice store is deferred with its reason recorded)',
  );
  const recordsBefore = appliedMigrations(freshDir);
  ok(
    stableJson(readRecords(freshDir)) === stableJson(tables) &&
      stableJson(appliedMigrations(freshDir)) === stableJson(recordsBefore),
    'reopening the file changes no table and records no migration again',
  );
  for (const s of STORES)
    ok(TABLE_BACKED.includes(s), `${s} is a table of the agent transactions repository, not a collection`);
}

// ============================================================ 2
section('2 — a case, a context and an agreement: nothing moves, and nothing is invented');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-up-'));
  // A real database: players, orgs, staff, a recruitment case, an agreement, a compliance context; the seeded
  // policies are rows of migration 0027.
  const db = { orgs: [], players: [], guardians: [], users: [], recruitmentCases: [] };
  db.orgs.push({
    id: 'org-a',
    name: 'Agency',
    type: 'agency',
    level: 'agency',
    plan: 'Agency',
    verified: false,
    location: null,
  });
  db.players.push({
    id: 'pl-1',
    name: 'Adult Player',
    dob: '1998-04-02',
    country: 'GB',
    city: 'London',
    media: [],
    attendance: [],
    trialReports: [],
    badges: [],
    timeline: [],
    medical: { shared: false, records: [], conditionStatus: 'unknown' },
    level: 'amateur',
    location: { lat: 51.5, lng: -0.1 },
  });
  db.users.push({ id: 'usr-1', orgId: 'org-a', name: 'Agency Agent', role: 'Agent', createdAt: 1 }); // the agent the context and the agreement name, and the case's owner
  db.recruitmentCases.push({
    id: 'case-1',
    orgId: 'org-a',
    playerId: 'pl-1',
    playerName: 'Adult Player',
    vacancyId: null,
    ownerUserId: 'usr-1',
    ownerName: 'Agency Agent',
    stage: 'identified',
    priority: 'medium',
    deadline: null,
    restricted: false,
    assignments: [],
    tasks: [],
    approvals: [],
    decision: null,
    links: { requestIds: [], trialIds: [], signingId: null },
    createdAt: 1,
    history: [],
    room: null,
    decisionDraft: null,
    transactionHandoff: null,
    budget: null,
    subjectRemovedAt: null,
  }); // the workspace case literal (the typed table refuses a partial one)
  // The context is a row of the compliance records, planted in the writer's whole literal.
  db.complianceContexts = [
    {
      id: 'ctx-1',
      agencyOrgId: 'org-a',
      agentUserId: 'usr-1',
      type: 'transfer',
      jurisdictions: ['ENG'],
      parties: [],
      representations: [],
      resolvedFacts: [],
      reEvaluationPending: false,
      reviewRejectedAt: null,
      status: 'open',
      openedAt: 1,
      closedAt: null,
      keys: {},
      rev: 1,
      revAt: 1,
      revBy: null,
      history: [],
    },
  ];
  // The agreement is a row of the agent core, planted in the writer's whole literal (the typed create refuses a partial one).
  db.representationAgreements = [
    {
      id: 'rep-1',
      agentUserId: 'usr-1',
      agencyOrgId: 'org-a',
      clientKind: 'player',
      clientId: 'pl-1',
      jurisdiction: 'ENG',
      exclusive: false,
      termMonths: 12,
      startAt: 1,
      endAt: null,
      status: 'active',
      proposedAt: 1,
      confirmedAt: 1,
      confirmedBy: { kind: 'player', id: 'pl-1' },
      declinedAt: null,
      terminatedAt: null,
      terminatedBy: null,
      terminationReasonCode: null,
      disputedAt: null,
      disputeReason: null,
      shareWithAgencyStaff: false,
      scope: ['transfer'],
      policyVersions: [],
      keys: {},
      createdAt: 1,
      rev: 1,
      revAt: 1,
      revBy: null,
      history: [],
    },
  ];
  // A partial transaction record is not a row the typed table can hold: the repository refuses it, naming it.
  let refusedPartial = null;
  try {
    fixture(mkdtempSync(path.join(tmpdir(), 'sbx-m26p-partial-')), {
      ...db,
      agentTransactions: [{ id: 'atx-partial' }],
    });
  } catch (e) {
    refusedPartial = e;
  }
  neg(
    refusedPartial?.code === 'AGENT_TRANSACTIONS_INPUT_INVALID' && /atx-partial/.test(refusedPartial.message),
    'a partial transaction record is refused by the repository, naming it — nothing is written',
  );
  fixture(dir, db);
  const back = readRecords(dir);
  neg(
    STORES.every((s) => back[s].length === 0),
    'no transaction row appears (the tables are empty until a route writes one)',
  );
  const c = back.recruitmentCases.find((x) => x.id === 'case-1');
  neg(
    c && c.stage === 'identified' && c.transactionHandoff === null && !('transactionId' in c),
    'the recruitment case did not become a transaction and gained no transaction field',
  );
  const ctx = back.complianceContexts.find((x) => x.id === 'ctx-1');
  neg(
    ctx && ctx.status === 'open' && !ctx.transactionId && ctx.rev === 1,
    'the compliance context is not reinterpreted as a transaction either',
  );
  neg(
    back.representationAgreements.length === 1 &&
      back.representationAgreements[0].status === 'active' &&
      back.representationAgreements[0].rev === 1 &&
      back.players.some((p) => p.id === 'pl-1'),
    'no agreement and no player row was touched',
  );
  globalThis.UPGRADE_DIR = dir;
}

// ============================================================ 3
section('3 — a real boot over that database');
{
  const recordsBefore = appliedMigrations(globalThis.UPGRADE_DIR);
  const s = await bootOn(globalThis.UPGRADE_DIR, 6810 + Math.floor(Math.random() * 40));
  ok(s.up, 'the server boots over that database');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(h.body.schemaVersion === SCHEMA_VERSION, `and reports ${SCHEMA_VERSION}`);
    neg(
      stableJson(appliedMigrations(globalThis.UPGRADE_DIR)) === stableJson(recordsBefore),
      'no migration ran again at boot — the records say they already ran',
    );
    const org = await s.j('POST', '/auth/org/login', {
      orgId: 'org-a',
      scoutName: 'Boot Admin',
      role: 'Director',
      platform: 'agent',
    });
    const list = await s.j('GET', '/org/agent/transactions', undefined, org.body.token);
    ok(
      list.status === 200 &&
        Array.isArray(list.body.items) &&
        list.body.items.length === 0 &&
        list.body.statuses.length === 10,
      'an empty workspace is an empty list with the full state vocabulary — not an error',
    );
    const player = await s.j('POST', '/auth/player/login', { playerId: 'pl-1' });
    const canon = await s.j('GET', '/player/notifications', undefined, player.body?.token);
    ok(canon.status === 200, `the canonical player lane answers on this minimal database (${canon.status})`);
    const pl = await s.j('GET', '/player/transactions', undefined, player.body?.token);
    ok(
      pl.status === 200 && pl.body.items.length === 0,
      `and so is the individual's side (${pl.status} ${JSON.stringify(pl.body).slice(0, 80)})`,
    );
    neg(
      expect(
        await s.j('GET', '/org/agent/transactions/atx-partial', undefined, org.body.token),
        404,
        'TRANSACTION_NOT_FOUND',
      ),
      'the refused partial row is not on disk: it reads as absent',
    );
  }
  await s.stop();
}

// ============================================================ 4
section('4 — a real workspace survives a restart byte for byte');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-live-'));
  const port = pickPort(6860, 40, [0, 1]);
  let s = await bootOn(dir, port);
  ok(s.up, 'a clean boot');
  let TX;
  let DOC;
  let REV_BEFORE;
  let TIMELINE_BEFORE;
  if (s.up) {
    const admin = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
    const priya = (
      await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })
    ).body;
    const tomas = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Tomás Rivera',
        role: 'Director',
        platform: 'agent',
      })
    ).body;
    const maria = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-eastport',
        scoutName: 'Maria Keane',
        role: 'Head of Recruitment',
      })
    ).body;
    const kola = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
    await s.j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
    const ana = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Ana Costa',
        role: 'Agent',
        platform: 'agent',
      })
    ).body;
    await s.j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, ana.token);
    await s.j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
    await s.j(
      'POST',
      '/org/agent/profile/facets/national_registration/submit',
      { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' },
      ana.token,
    );
    const rel = await s.j(
      'POST',
      '/org/agent/clients/request',
      { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' },
      ana.token,
    );
    await s.j(
      'POST',
      `/player/agent/relationships/${rel.body.relationship.id}/confirm`,
      { expectedRev: 1 },
      kola.token,
    );
    await s.j(
      'POST',
      '/admin/verification/orgs/org-eastport/appoint-root',
      { userId: maria.userId, reason: 'persistence suite: club signatory' },
      priya.token,
      admin,
    );
    const create = await s.j(
      'POST',
      '/org/agent/transactions',
      {
        type: 'employment_contract',
        jurisdictions: ['ENG'],
        parties: [
          { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
          { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
        ],
        clientKey: 'persist-1',
      },
      ana.token,
    );
    TX = create.body?.transaction?.id;
    ok(create.status === 201 && TX, 'a transaction is opened');
    await s.j('POST', `/org/transactions/${TX}/confirm`, {}, maria.token);
    await s.j('POST', `/player/transactions/${TX}/confirm`, {}, kola.token);
    const bind = await s.j(
      'POST',
      `/org/agent/transactions/${TX}/representations`,
      { partyRole: 'individual', agreementId: rel.body.relationship.id, clientKey: 'persist-rep-1' },
      ana.token,
    );
    ok(bind.status === 201, 'a representation is bound');
    const d1 = await s.j(
      'POST',
      `/org/agent/transactions/${TX}/documents`,
      {
        documentType: 'mandate',
        visibility: 'ALL_TRANSACTION_PARTIES',
        label: 'Mandate v1',
        clientKey: 'persist-doc-1',
      },
      ana.token,
    );
    DOC = d1.body?.document?.id;
    await s.j('POST', `/org/agent/transactions/${TX}/documents/${DOC}/supersede`, { label: 'Mandate v2' }, ana.token);
    await s.j(
      'POST',
      `/org/agent/transactions/${TX}/notes`,
      { text: 'Persistence fixture note.', visibility: 'AGENT_PRIVATE' },
      ana.token,
    );
    await s.j(
      'POST',
      `/org/agent/transactions/${TX}/terms`,
      {
        summary: 'Two-year term, standard club schedule.',
        recordedFor: 'individual',
        visibility: 'PLAYER_AGENT_SHARED',
      },
      ana.token,
    );
    const before = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(
      before.body.transaction.status === 'READY',
      `the transaction is READY before the restart (${before.body.transaction.status})`,
    );
    await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ACTIVE' }, ana.token);
    const held = await s.j(
      'POST',
      `/org/agent/transactions/${TX}/status`,
      {
        to: 'ON_HOLD',
        reasonCode: 'awaiting_document',
        reason: 'Waiting on the club letter.',
        clientKey: 'persist-hold-1',
      },
      ana.token,
    );
    ok(held.status === 200 && held.body.transaction.status === 'ON_HOLD', 'and is put on hold with a reason code');
    REV_BEFORE = held.body.transaction.rev;
    TIMELINE_BEFORE = (await s.j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, ana.token)).body.items
      .length;
    await s.stop();
  }
  const snap = readRecords(dir);
  const recordsAtStop = appliedMigrations(dir);
  ok(
    snap &&
      Number(recordsAtStop.at(-1)?.id.slice(0, 4)) === SCHEMA_VERSION &&
      snap.agentTransactions.length === 1 &&
      snap.transactionRepresentations.length === 1 &&
      snap.transactionDocuments.length === 2,
    `the file holds one transaction, one representation binding and two document versions, at schema ${SCHEMA_VERSION}`,
  );
  const row = snap.agentTransactions[0];
  ok(
    row.status === 'ON_HOLD' &&
      row.holdReasonCode === 'awaiting_document' &&
      row.parties.length === 2 &&
      row.parties.every((p) => p.confirmedAt),
    'the status, its reason code and both party confirmations are on disk',
  );
  // The snapshot names its evaluation row ('<context>#<n>'); the policy versions are that evaluation's own.
  const ctxRow = snap.complianceContexts.find((c) => c.id === row.contextId);
  const evaluation = ctxRow?.evaluations[Number(String(row.compliance?.evaluationId).split('#').pop()) - 1];
  ok(
    row.compliance?.evaluationId?.startsWith(`${row.contextId}#`) &&
      row.compliance.partyRevision &&
      evaluation?.policyVersions.length >= 1,
    'the compliance snapshot reference — the evaluation row of its context, the party revision and (through the evaluation) the policy versions — is on disk',
  );
  neg(
    row.notes.length === 1 && row.terms.versions.length === 1 && row.history.length >= 8,
    'the scoped note, the recorded terms version and the append-only history are on disk',
  );
  neg(row.keys && Object.keys(row.keys).length >= 2, 'the idempotency keys are on disk');
  const chain = snap.transactionDocuments;
  neg(
    chain.find((d) => d.version === 1).supersededBy === chain.find((d) => d.version === 2).id &&
      chain.find((d) => d.version === 2).supersedes === chain.find((d) => d.version === 1).id,
    'the document version chain is on disk in both directions — the old row was kept, never edited',
  );
  neg(
    !/AGENT_PRIVATE/.test(stableJson(snap.transactionDocuments)) &&
      /ALL_TRANSACTION_PARTIES/.test(stableJson(snap.transactionDocuments)),
    'each document carries the visibility class it was filed under',
  );
  neg(
    row.revBy && row.revBy.name === 'Representing agent' && row.revBy.userId === null,
    'the shared rev token names a ROLE on disk, not a person (defect D2)',
  );

  s = await bootOn(dir, port + 1);
  ok(s.up, 'the server reboots over that database');
  if (s.up) {
    neg(
      stableJson(appliedMigrations(dir)) === stableJson(recordsAtStop),
      'no migration ran again (every record keeps its original time)',
    );
    const tomas = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Tomás Rivera',
        role: 'Director',
        platform: 'agent',
      })
    ).body;
    const ana = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Ana Costa',
        role: 'Agent',
        platform: 'agent',
      })
    ).body;
    const after = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(
      after.status === 200 && after.body.transaction.status === 'ON_HOLD' && after.body.transaction.rev === REV_BEFORE,
      'the transaction reads back with its status and its rev',
    );
    ok(
      after.body.transaction.parties.every((p) => p.confirmedAt) &&
        after.body.transaction.representations[0].status === 'verified',
      'the party confirmations and the representation binding survived',
    );
    ok(
      after.body.transaction.documents.length === 1 && after.body.transaction.documents[0].version === 2,
      'the current document version survived, and the superseded one is not offered as current',
    );
    ok(
      after.body.transaction.notes.length === 1 && after.body.transaction.terms.versions.length === 1,
      'the note and the recorded terms survived',
    );
    const tl = await s.j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, ana.token);
    ok(tl.body.items.length === TIMELINE_BEFORE, `the timeline survived unchanged (${tl.body.items.length} entries)`);
    const replay = await s.j(
      'POST',
      '/org/agent/transactions',
      {
        type: 'employment_contract',
        jurisdictions: ['ENG'],
        parties: [
          { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
          { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
        ],
        clientKey: 'persist-1',
      },
      ana.token,
    );
    ok(
      replay.body.idempotent === true && replay.body.transaction.id === TX,
      'the create key replays after the restart — no second transaction',
    );
    const holdReplay = await s.j(
      'POST',
      `/org/agent/transactions/${TX}/status`,
      {
        to: 'ON_HOLD',
        reasonCode: 'awaiting_document',
        reason: 'Waiting on the club letter.',
        clientKey: 'persist-hold-1',
      },
      ana.token,
    );
    ok(holdReplay.body.idempotent === true, 'and so does the status key');
    const audit = await s.j('GET', '/org/agent/agency/audit?limit=50', undefined, tomas.token);
    ok(
      audit.status === 200 &&
        audit.body.items.some((r) => r.domain === 'transaction' && r.action === 'transaction_created'),
      'the agency audit still carries the transaction rows after the restart',
    );
    const conflict = await s.j(
      'POST',
      `/org/agent/transactions/${TX}/notes`,
      { text: 'x', visibility: 'AGENT_PRIVATE', expectedRev: 1 },
      ana.token,
    );
    neg(
      expect(conflict, 409, 'TRANSACTION_VERSION_CONFLICT') && conflict.body.updatedBy === 'Representing agent',
      'a stale write is still refused after the restart, and the conflict names a ROLE rather than a person',
    );
    await s.stop();
  }
  globalThis.LIVE_DIR = dir;
  globalThis.LIVE_TX = TX;
  globalThis.LIVE_PORT = port;
}

// ============================================================ 5
section('5 — corruption on disk is contained and named by its effect, never repaired');
{
  const dir = globalThis.LIVE_DIR;
  const TX = globalThis.LIVE_TX;
  const db = readRecords(dir);
  // Three corruptions are rows the typed tables cannot hold — the repository refuses each, naming it,
  // and writes nothing (the fixture is one unit of work): (a) a transaction whose compliance context is gone, (b) a
  // document whose transaction is gone, (c) a status nobody wrote.
  const refusedWrite = (collections) => {
    try {
      fixture(dir, collections);
      return null;
    } catch (e) {
      return e;
    }
  };
  const copy = (over) => ({
    ...structuredClone(db.agentTransactions[0]),
    keys: {},
    rev: 1,
    notes: [],
    terms: { versions: [] },
    linkedThreads: [],
    history: [],
    ...over,
  });
  const goneCtx = refusedWrite({
    agentTransactions: [copy({ id: 'atx-ctxgone', contextId: 'ctx-gone', compliance: null })],
  });
  neg(
    goneCtx?.code === 'AGENT_TRANSACTIONS_REFERENCE_MISSING',
    `(a) a transaction whose compliance context is gone is refused by the repository (${goneCtx?.message})`,
  );
  const orphan = {
    id: 'txd-orphan',
    transactionId: 'atx-gone',
    documentType: 'mandate',
    visibility: 'ALL_TRANSACTION_PARTIES',
    label: 'Orphan',
    version: 1,
    owner: { kind: 'agent', id: 'usr-x' },
    ownerPartyRole: null,
    uploadedBy: { kind: 'org', userId: 'usr-x', name: 'Ghost' },
    createdAt: 1,
    expiresAt: null,
    evidenceRef: null,
    supersedes: null,
    supersededBy: null,
    removedAt: null,
    keys: {},
    rev: 1,
    revAt: 1,
    revBy: null,
    history: [],
  };
  const orphaned = refusedWrite({ transactionDocuments: [orphan] });
  neg(
    orphaned?.code === 'AGENT_TRANSACTIONS_REFERENCE_MISSING',
    `(b) a document whose transaction is gone is refused by the repository — a document belongs to a transaction (${orphaned?.code})`,
  );
  const odd = refusedWrite({ agentTransactions: [copy({ id: 'atx-odd', status: 'HALF_WRITTEN' })] });
  neg(
    odd?.code === 'AGENT_TRANSACTIONS_INPUT_INVALID' && /atx-odd.*status/.test(odd.message),
    `(c) a status nobody wrote is refused by the repository, naming the row (${odd?.message})`,
  );
  neg(stableJson(readRecords(dir)) === stableJson(db), 'and nothing of the refused writes is on disk');
  // A policy version published for the jurisdiction flags the transaction's compliance context. The transaction
  // reads that flag — its snapshot is POLICY_CHANGED and authorises nothing until it is re-evaluated.
  const ctxId = db.agentTransactions[0].contextId;
  plant(dir, (L, sqlite) => {
    L.complianceRecords.contexts.recordAct(ctxId, {
      history: [
        {
          id: 'aud-plant-policy',
          at: Date.now(),
          action: 'compliance_context_policy_changed',
          by: { kind: 'system', userId: null, name: 'policy publication' },
          detail: { policyVersions: ['jp-eng-2026-27-1'] },
        },
      ],
    });
    sqlite.prepare('UPDATE compliance_contexts SET re_evaluation_pending = 1 WHERE id = ?').run(ctxId);
  });
  const sp = await bootOn(dir, globalThis.LIVE_PORT + 3);
  ok(sp.up, 'the server boots over a context flagged by a policy publication');
  if (sp.up) {
    const ana = (
      await sp.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Ana Costa',
        role: 'Agent',
        platform: 'agent',
      })
    ).body;
    const comp = (await sp.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token)).body.transaction.compliance;
    neg(
      comp.staleness === 'POLICY_CHANGED' && comp.clear === false,
      `a transaction whose context a policy publication flagged reads POLICY_CHANGED, not clear (${comp.staleness})`,
    );
    const progress = await sp.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ACTIVE' }, ana.token);
    neg(
      progress.status === 422 &&
        progress.body.error === 'TRANSACTION_COMPLIANCE_STALE' &&
        progress.body.staleness === 'POLICY_CHANGED',
      `and it cannot enter the live workflow until re-evaluated (${progress.status} ${progress.body?.staleness})`,
    );
    await sp.stop();
  }
  plant(dir, (L) => L.complianceRecords.contexts.clearReEvaluation(ctxId));
  // What a typed row CAN still carry is planted and judged on read: a snapshot taken under a party revision the current
  // facts no longer produce.
  plant(dir, (_L, sqlite) =>
    sqlite.prepare('UPDATE agent_transactions SET compliance_party_revision = ? WHERE id = ?').run('f'.repeat(64), TX),
  );
  const s = await bootOn(dir, globalThis.LIVE_PORT + 2);
  ok(s.up, 'the server boots over the planted row');
  if (s.up) {
    const ana = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-northstar',
        scoutName: 'Ana Costa',
        role: 'Agent',
        platform: 'agent',
      })
    ).body;
    const read = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(read.status === 200, 'the transaction whose snapshot no longer matches the facts still reads');
    const comp = read.body.transaction.compliance;
    neg(
      comp.clear === false && comp.staleness === 'INPUTS_CHANGED' && comp.snapshotClear === true,
      `and its compliance reads as NOT currently clear, stale (${comp.staleness}), while still showing what the recorded evaluation said — a stale verdict is never presented as a clearance`,
    );
    const progress = await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ACTIVE' }, ana.token);
    neg(progress.status === 422, `it cannot be progressed (${progress.status} ${progress.body?.error})`);
    await s.stop();
    const after = readRecords(dir);
    neg(
      after.agentTransactions[0].compliance.partyRevision === 'f'.repeat(64),
      'the planted snapshot was not repaired on boot — the bytes are the bytes',
    );
  }
}

// ============================================================ pure staleness + machine
section('pure — the staleness verdict and the machine are the same functions the routes use');
{
  const rev = partyRevisionOf({
    parties: [],
    agentUserId: 'a',
    representations: [],
    consents: [],
    facetStates: {},
    policyVersions: [],
    blockedSubjectIds: [],
    minorSubjectIds: [],
  });
  neg(
    snapshotStaleness({ compliance: { evaluationId: 'e', partyRevision: 'different' } }, rev) === 'INPUTS_CHANGED',
    'a snapshot taken under different inputs is INPUTS_CHANGED',
  );
  neg(
    snapshotStaleness({}, rev) === 'NO_SNAPSHOT',
    'no snapshot at all is NO_SNAPSHOT — the absence of an evaluation is never a clearance',
  );
  neg(
    !actorTransitionAllowed('HALF_WRITTEN', 'ACTIVE') && !actorTransitionAllowed('ARCHIVED', 'ACTIVE'),
    'an unknown status and an archived one authorise no transition',
  );
  ok(TRANSACTION_STATUSES.length === 10, 'the ten states the routes and this suite share');
}

const total = passed;
console.log(
  `\nagents/transactionsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`,
);
if (process.exitCode) console.error('SOME CHECKS FAILED');
else console.log('all agents/transactionsPersistence checks passed');
