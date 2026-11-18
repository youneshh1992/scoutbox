// Persistence, migration and restart audit for the Agent Transaction Workspace:
// (1) migration 0029 and its empty tables, (2) no existing case, context or
// agreement becomes a transaction, (3) a real boot over that database, (4) a full
// workspace survives a restart byte for byte, (5) corruption is refused by the
// typed tables or, where a row can hold it, planted and read as STALE.
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture, writeFixture, SCHEMA_VERSION, TABLE_MIGRATIONS } from '../support/sqlFixture.mjs';
import { readRows, rows } from '../support/sqlRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

const STEP = '0029_agent_transactions';
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => rows(dir, 'data_migrations').map((r) => ({ id: r.id, at: r.applied_at }));
/** Every table's rows as stored. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return R.all();
  } finally {
    R.close();
  }
};
const STORES = ['agent_transactions', 'transaction_representations', 'transaction_documents'];

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
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
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
const fixture = (dir, tables) => writeFixture(dir, { rows: tables }, { idCounter: 500_000 });
/** Plant a state between boots with plain SQL, in one transaction. */
const plant = (dir, work) => {
  const F = openFixture(dir);
  try {
    return F.transaction(() => work(F));
  } finally {
    F.close();
  }
};

// ============================================================ 1
section('1 — migration 0029: registered once; the three stores are tables, EMPTY on a clean database');
{
  const ids = TABLE_MIGRATIONS;
  ok(
    ids.filter((id) => id === STEP).length === 1 && SCHEMA_VERSION >= 29,
    `${STEP} is registered once; the current schema is ${SCHEMA_VERSION}`,
  );
  neg(
    new Set(ids.map((id) => id.slice(0, 4))).size === ids.length,
    'every migration reaches a distinct schema version — no version is advanced twice',
  );
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-fresh-'));
  const tables = stored(freshDir);
  neg(
    STORES.every((s) => Array.isArray(tables[s]) && tables[s].length === 0),
    'all three tables start EMPTY — a transaction is a new concept and no existing record is reinterpreted as one',
  );
  neg(
    !['offers', 'agency_invoices'].some((n) => n in tables),
    'no offer and no agency-invoice store exists (out of scope; the invoice store is deferred with its reason recorded)',
  );
  const recordsBefore = appliedMigrations(freshDir);
  ok(
    stableJson(stored(freshDir)) === stableJson(tables) &&
      stableJson(appliedMigrations(freshDir)) === stableJson(recordsBefore),
    'reopening the file changes no table and records no migration again',
  );
  for (const s of STORES) ok(s in tables, `${s} is a table of the agent transactions repository, not a collection`);
}

// ============================================================ 2
section('2 — a case, a context and an agreement: nothing moves, and nothing is invented');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-up-'));
  // A real database: players, orgs, staff, a recruitment case, an agreement, a compliance context; the seeded
  // policies are rows of migration 0027. The rows are as the repositories wrote them in a probe run.
  const db = {
    orgs: [
      { id: 'org-a', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: 0, created_at: 1 },
    ],
    players: [
      {
        id: 'pl-1',
        name: 'Adult Player',
        birth_date: '1998-04-02',
        country: 'GB',
        city: 'London',
        availability: 'not_seeking',
        contract_status: 'unknown',
        level: 'amateur',
        lat: 51.5,
        lng: -0.1,
        medical_shared: 0,
        medical_condition_status: 'unknown',
        profile_signal: 30,
      },
    ],
    // the agent the context and the agreement name, and the case's owner
    org_users: [
      { id: 'usr-1', org_id: 'org-a', name: 'Agency Agent', name_key: 'agency agent', role: 'Agent', created_at: 1 },
    ],
    recruitment_cases: [
      {
        id: 'case-1',
        org_id: 'org-a',
        player_id: 'pl-1',
        player_name: 'Adult Player',
        owner_user_id: 'usr-1',
        owner_name: 'Agency Agent',
        stage: 'identified',
        priority: 'medium',
        restricted: 0,
        created_at: 1,
      },
    ],
    compliance_contexts: [
      {
        id: 'ctx-1',
        agency_org_id: 'org-a',
        agent_user_id: 'usr-1',
        type: 'transfer',
        status: 'open',
        re_evaluation_pending: 0,
        opened_at: 1,
        rev: 1,
        rev_at: 1,
      },
    ],
    compliance_context_jurisdictions: [{ context_id: 'ctx-1', ord: 0, member_association: 'ENG' }],
    representation_agreements: [
      {
        id: 'rep-1',
        agent_user_id: 'usr-1',
        agency_org_id: 'org-a',
        client_kind: 'player',
        client_id: 'pl-1',
        jurisdiction: 'ENG',
        exclusive: 0,
        term_months: 12,
        start_at: 1,
        status: 'active',
        proposed_at: 1,
        confirmed_at: 1,
        confirmed_by_player_id: 'pl-1',
        share_with_agency_staff: 0,
        disclosure_club_presence: 0,
        disclosure_contact_routing: 0,
        disclosure_trial_visibility: 0,
        created_at: 1,
        rev: 1,
        rev_at: 1,
      },
    ],
    agreement_scopes: [{ agreement_id: 'rep-1', ord: 0, scope: 'transfer' }],
  };
  // A partial transaction record is not a row the typed table can hold: the schema refuses it.
  let refusedPartial = null;
  const partialDir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-partial-'));
  try {
    fixture(partialDir, { ...db, agent_transactions: [{ id: 'atx-partial' }] });
  } catch (e) {
    refusedPartial = e;
  }
  neg(
    /constraint failed: agent_transactions\./.test(refusedPartial?.message) &&
      stored(partialDir).recruitment_cases.length === 0,
    `a partial transaction record is refused by the schema — nothing is written (${refusedPartial?.message})`,
  );
  fixture(dir, db);
  const back = stored(dir);
  neg(
    STORES.every((s) => back[s].length === 0),
    'no transaction row appears (the tables are empty until a route writes one)',
  );
  const c = back.recruitment_cases.find((x) => x.id === 'case-1');
  neg(
    c &&
      c.stage === 'identified' &&
      !back.case_transaction_handoffs.some((h) => h.case_id === 'case-1') &&
      !Object.keys(c).some((col) => /transaction/.test(col)),
    'the recruitment case did not become a transaction and gained no transaction field',
  );
  const ctx = back.compliance_contexts.find((x) => x.id === 'ctx-1');
  neg(
    ctx && ctx.status === 'open' && !ctx.transaction_id && ctx.rev === 1,
    'the compliance context is not reinterpreted as a transaction either',
  );
  neg(
    back.representation_agreements.length === 1 &&
      back.representation_agreements[0].status === 'active' &&
      back.representation_agreements[0].rev === 1 &&
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
  const port = await freePort();
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
  const snap = stored(dir);
  const recordsAtStop = appliedMigrations(dir);
  ok(
    Number(recordsAtStop.at(-1)?.id.slice(0, 4)) === SCHEMA_VERSION &&
      snap.agent_transactions.length === 1 &&
      snap.transaction_representations.length === 1 &&
      snap.transaction_documents.length === 2,
    `the file holds one transaction, one representation binding and two document versions, at schema ${SCHEMA_VERSION}`,
  );
  const row = snap.agent_transactions[0];
  const of = (table, col = 'transaction_id') => snap[table].filter((r) => r[col] === row.id);
  const parties = of('transaction_parties');
  ok(
    row.status === 'ON_HOLD' &&
      row.hold_reason_code === 'awaiting_document' &&
      parties.length === 2 &&
      parties.every((p) => p.confirmed_at),
    'the status, its reason code and both party confirmations are on disk',
  );
  // The snapshot names its evaluation row ('<context>#<n>'); the policy versions are that evaluation's own.
  const evaluation = snap.compliance_evaluations.find(
    (e) => e.id === row.compliance_evaluation_id && e.context_id === row.context_id,
  );
  ok(
    row.compliance_evaluation_id?.startsWith(`${row.context_id}#`) &&
      row.compliance_party_revision &&
      evaluation &&
      snap.compliance_evaluation_policy_versions.filter((v) => v.evaluation_id === evaluation.id).length >= 1,
    'the compliance snapshot reference — the evaluation row of its context, the party revision and (through the evaluation) the policy versions — is on disk',
  );
  neg(
    of('transaction_notes').length === 1 &&
      of('transaction_terms_versions').length === 1 &&
      of('transaction_history').length >= 8,
    'the scoped note, the recorded terms version and the append-only history are on disk',
  );
  neg(of('transaction_keys').length + (row.create_key ? 1 : 0) >= 2, 'the idempotency keys are on disk');
  const chain = snap.transaction_documents;
  neg(
    chain.find((d) => d.version === 2).supersedes_id === chain.find((d) => d.version === 1).id &&
      snap.transaction_document_history.some(
        (h) =>
          h.document_id === chain.find((d) => d.version === 1).id && h.action === 'transaction_document_superseded',
      ),
    'the document version chain is on disk — the old row was kept and its supersession recorded, never edited',
  );
  neg(
    !/AGENT_PRIVATE/.test(stableJson(snap.transaction_documents)) &&
      /ALL_TRANSACTION_PARTIES/.test(stableJson(snap.transaction_documents)),
    'each document carries the visibility class it was filed under',
  );
  neg(
    row.rev_by_label === 'Representing agent' && !Object.keys(row).some((c) => /^rev_by_(id|name)$/.test(c)),
    'the shared rev token names a ROLE on disk, and the row has no column for a person (defect D2)',
  );

  s = await bootOn(dir, await freePort());
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
}

// ============================================================ 5
section('5 — corruption on disk is contained and named by its effect, never repaired');
{
  const dir = globalThis.LIVE_DIR;
  const TX = globalThis.LIVE_TX;
  const db = stored(dir);
  // Three corruptions are rows the typed tables cannot hold — the schema refuses each and the fixture's transaction
  // writes nothing: (a) a transaction whose compliance context is gone, (b) a document whose transaction is gone,
  // (c) a status nobody wrote.
  const refusedWrite = (tables) => {
    try {
      fixture(dir, tables);
      return null;
    } catch (e) {
      return e;
    }
  };
  const copy = (over) => ({
    ...db.agent_transactions[0],
    create_key: null,
    create_fp: null,
    rev: 1,
    ...over,
  });
  const goneCtx = refusedWrite({
    agent_transactions: [
      copy({
        id: 'atx-ctxgone',
        context_id: 'ctx-gone',
        compliance_evaluation_id: null,
        compliance_evaluated_at: null,
        compliance_verification_freshness: null,
        compliance_party_revision: null,
      }),
    ],
  });
  neg(
    /FOREIGN KEY constraint failed/.test(goneCtx?.message),
    `(a) a transaction whose compliance context is gone is refused by the schema (${goneCtx?.message})`,
  );
  const orphan = {
    id: 'txd-orphan',
    transaction_id: 'atx-gone',
    document_type: 'mandate',
    visibility: 'ALL_TRANSACTION_PARTIES',
    label: 'Orphan',
    version: 1,
    owner_kind: 'agent',
    owner_id: 'usr-x',
    uploaded_by_kind: 'org',
    uploaded_by_id: 'usr-x',
    uploaded_by_name: 'Ghost',
    created_at: 1,
    rev: 1,
    rev_at: 1,
  };
  const orphaned = refusedWrite({ transaction_documents: [orphan] });
  neg(
    /FOREIGN KEY constraint failed/.test(orphaned?.message),
    `(b) a document whose transaction is gone is refused by the schema — a document belongs to a transaction (${orphaned?.message})`,
  );
  const odd = refusedWrite({ agent_transactions: [copy({ id: 'atx-odd', status: 'HALF_WRITTEN' })] });
  neg(
    /CHECK constraint failed: status/.test(odd?.message),
    `(c) a status nobody wrote is refused by the schema (${odd?.message})`,
  );
  neg(stableJson(stored(dir)) === stableJson(db), 'and nothing of the refused writes is on disk');
  // A policy version published for the jurisdiction flags the transaction's compliance context. The transaction
  // reads that flag — its snapshot is POLICY_CHANGED and authorises nothing until it is re-evaluated.
  const ctxId = db.agent_transactions[0].context_id;
  plant(dir, (F) => {
    F.sql
      .prepare(
        `INSERT INTO compliance_context_history (id, context_id, ord, at, by_kind, by_name, action, detail_policy_version_id)
         VALUES ('aud-plant-policy', ?, (SELECT COALESCE(MAX(ord) + 1, 0) FROM compliance_context_history WHERE context_id = ?), ?, 'system', 'policy publication', 'compliance_context_policy_changed', 'jp-eng-2026-27-1')`,
      )
      .run(ctxId, ctxId, Date.now());
    F.sql.prepare('UPDATE compliance_contexts SET re_evaluation_pending = 1 WHERE id = ?').run(ctxId);
  });
  const sp = await bootOn(dir, await freePort());
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
  plant(dir, (F) => F.sql.prepare('UPDATE compliance_contexts SET re_evaluation_pending = 0 WHERE id = ?').run(ctxId));
  // What a typed row CAN still carry is planted and judged on read: a snapshot taken under a party revision the current
  // facts no longer produce.
  plant(dir, (F) =>
    F.sql.prepare('UPDATE agent_transactions SET compliance_party_revision = ? WHERE id = ?').run('f'.repeat(64), TX),
  );
  const s = await bootOn(dir, await freePort());
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
    const after = stored(dir);
    neg(
      after.agent_transactions[0].compliance_party_revision === 'f'.repeat(64),
      'the planted snapshot was not repaired on boot — the bytes are the bytes',
    );
  }
}

const total = passed;
console.log(
  `\nagents/transactionsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`,
);
if (process.exitCode) console.error('SOME CHECKS FAILED');
else console.log('all agents/transactionsPersistence checks passed');
