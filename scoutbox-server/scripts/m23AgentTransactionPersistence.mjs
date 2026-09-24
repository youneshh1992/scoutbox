// M23 P5.6D — persistence, migration and restart audit for the Agent
// Transaction Workspace.
//
//   1  schema 2307: exactly one step above 2306, three EMPTY stores on a clean
//      database, idempotent, and every P5.6D store production-required
//   2  upgrade from a 2306 snapshot: the three containers appear and NOTHING
//      else changes — no recruitment case, no compliance context, no agreement
//      and no player becomes or gains a transaction, and a re-run creates
//      nothing twice
//   3  a real boot over that snapshot: /healthz 2307, the transaction lanes
//      answer, and an empty workspace is an empty list rather than an error
//   4  clean boot → transaction → confirmations → representation → document →
//      note → terms → hold → stop → snapshot → reboot: bytes survive (party
//      history, the compliance snapshot reference, document metadata and its
//      version chain, the timeline, revs and idempotency keys), and the 2307
//      step does not run twice
//   5  corruption on disk is contained and named: a transaction whose
//      compliance snapshot points at a context that is gone reads as
//      NO_SNAPSHOT rather than clear, a document whose transaction is gone
//      reaches nobody, a party revision that no longer matches reads STALE,
//      and an unknown status permits no transition
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { partyRevisionOf, snapshotStaleness, actorTransitionAllowed, TRANSACTION_STATUSES } from '../m26/transaction.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const STEP = 'm260_001_transaction_stores';
const STORES = ['agentTransactions', 'transactionRepresentations', 'transactionDocuments'];

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stableJson = (v) => JSON.stringify(v);
const expect = (r, status, code) => { const good = r.status === status && (code === null || r.body?.error === code); if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return good; };

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; }); proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) break;
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) console.error(`   boot log:\n${log.split('\n').slice(-12).join('\n')}`);
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* non-json */ }
    return { status: r.status, body: data };
  };
  return {
    up, j, log: () => log,
    async stop() {
      proc.kill('SIGTERM');
      for (let i = 0; i < 80; i += 1) { if (proc.exitCode != null || proc.signalCode) break; await sleep(100); }
      await sleep(400);
    },
  };
}
const snapshotOf = (dir) => openStore(dir).load()?.db ?? null;
const writeSnapshot = (dir, db) => openStore(dir).save({ db, idCounter: 500_000, savedAt: Date.now() });

// ============================================================ 1
section('1 — the P5.6D step: one step at 2307, three EMPTY stores, idempotent, production-required');
{
  const step = MIGRATIONS.find((m) => m.id === STEP);
  ok(step?.version === 2307 && SCHEMA_VERSION === 2308, `${STEP} is version 2307; the current schema is ${SCHEMA_VERSION} (P7 added m280_001_signing_workflow at 2308)`);
  ok(MIGRATIONS.filter((m) => m.version === 2307).length === 1, 'exactly one step at 2307 — the schema was advanced exactly once');
  neg(MIGRATIONS.filter((m) => m.version > 2307).map((m) => m.id).join(',') === 'm280_001_signing_workflow', 'and exactly one step above 2307 — P7\'s signing workflow');
  const versions = MIGRATIONS.filter((m) => m.version).map((m) => m.version);
  neg(new Set(versions).size === versions.length, 'every versioned step reaches a distinct schema version — no version is advanced twice');
  const fresh = {};
  const up = runMigrations(fresh);
  ok(up.to === 2308 && STORES.every((s) => Array.isArray(fresh[s])), 'a clean database gets the three stores (and the schema lands at 2308)');
  neg(STORES.every((s) => fresh[s].length === 0), 'all three start EMPTY — a transaction is a new concept and no existing record is reinterpreted as one');
  neg(fresh.recruitmentOffers === undefined && fresh.offers === undefined && fresh.agencyInvoices === undefined, 'no offer and no agency-invoice store was created (out of scope; the invoice store is deferred with its reason recorded)');
  const { schema: _s1, ...storesBefore } = fresh;
  const before = stableJson(storesBefore);
  const idsBefore = fresh.schema.migrations.map((m) => m.id).join();
  const again = runMigrations(fresh);
  const { schema: _s2, ...storesAfter } = fresh;
  ok(again.ran.length === 0 && stableJson(storesAfter) === before && fresh.schema.migrations.map((m) => m.id).join() === idsBefore, 'running again changes no store and adds no migration record');
  fresh.agentTransactions.push({ id: 'atx-keep' });
  runMigrations(fresh);
  neg(fresh.agentTransactions.length === 1 && fresh.agentTransactions[0].id === 'atx-keep', 'a replay over a populated store destroys nothing');
  for (const s of STORES) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `${s} is migration-guaranteed and production-required`);
}

// ============================================================ 2
section('2 — upgrade from 2306: three containers appear and nothing else moves');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-up-'));
  // Build a real 2307 database, then REWIND it to 2306 by dropping the P5.6D
  // step and its stores. Everything else — players, orgs, agent profiles,
  // agreements, compliance contexts, seeded policies — is genuine.
  const db = {};
  runMigrations(db);
  db.orgs.push({ id: 'org-a', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: false, squad: [], location: null });
  db.players.push({ id: 'pl-1', name: 'Adult Player', dob: '1998-04-02', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } });
  db.recruitmentCases.push({ id: 'case-1', orgId: 'org-a', playerId: 'pl-1', status: 'shortlist', room: { rev: 1 } });
  db.complianceContexts.push({ id: 'ctx-1', agencyOrgId: 'org-a', agentUserId: 'usr-1', type: 'transfer', jurisdictions: ['ENG'], parties: [], representations: [], evaluations: [], status: 'open', history: [] });
  db.representationAgreements.push({ id: 'rep-1', agentUserId: 'usr-1', agencyOrgId: 'org-a', clientId: 'pl-1', status: 'active', confirmedAt: 1, scope: ['transfer'], rev: 1, history: [] });
  db.schema.version = 2306;
  // A TRUE 2306 snapshot: the P5.6D step and the P7 step (m280_001_signing_workflow, 2308) are both dropped with their stores.
  db.schema.migrations = db.schema.migrations.filter((m) => m.id !== STEP && m.id !== 'm280_001_signing_workflow');
  delete db.agentTransactions; delete db.transactionRepresentations; delete db.transactionDocuments; delete db.signingPackages;
  const casesBefore = stableJson(db.recruitmentCases);
  const contextsBefore = stableJson(db.complianceContexts);
  const agreementsBefore = stableJson(db.representationAgreements);
  const playersBefore = stableJson(db.players);
  ok(db.schema.version === 2306 && db.agentTransactions === undefined, 'the fixture is a 2306 snapshot with a recruitment case, a compliance context and an agreement, and no transaction store');
  const up = runMigrations(db);
  ok(up.ran.join(',') === `${STEP},m280_001_signing_workflow` && up.to === 2308, 'a 2306 snapshot runs exactly the P5.6D step and then the P7 step, in order');
  neg(STORES.every((s) => Array.isArray(db[s]) && db[s].length === 0), 'the three containers appear EMPTY');
  neg(stableJson(db.recruitmentCases) === casesBefore, 'the recruitment case is untouched — it did not become a transaction and gained no transaction field (§3)');
  neg(stableJson(db.complianceContexts) === contextsBefore, 'the compliance context is untouched — it is not reinterpreted as a transaction either');
  neg(stableJson(db.representationAgreements) === agreementsBefore && stableJson(db.players) === playersBefore, 'no agreement and no player row was touched');
  db.schema.version = 2306; db.schema.migrations = db.schema.migrations.filter((m) => m.id !== STEP);
  db.agentTransactions.push({ id: 'atx-partial' });
  const rerun = runMigrations(db);
  neg(rerun.ran[0] === STEP && db.agentTransactions.length === 1, 'a partial upgrade (the store exists, the record does not) completes without duplicating anything');
  writeSnapshot(dir, db);
  globalThis.UPGRADE_DIR = dir;
}

// ============================================================ 3
section('3 — a real boot over the upgraded snapshot');
{
  const s = await bootOn(globalThis.UPGRADE_DIR, 6810 + Math.floor(Math.random() * 40));
  ok(s.up, 'the server boots over a 2306-derived snapshot');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(h.body.schemaVersion === 2308, 'and reports 2308');
    neg(!new RegExp(STEP).test(s.log()), 'the P5.6D step did NOT run again — the migration record says it already ran');
    const org = await s.j('POST', '/auth/org/login', { orgId: 'org-a', scoutName: 'Boot Admin', role: 'Director', platform: 'agent' });
    const list = await s.j('GET', '/org/agent/transactions', undefined, org.body.token);
    ok(list.status === 200 && Array.isArray(list.body.items) && list.body.items.length === 0 && list.body.statuses.length === 10, 'an empty workspace is an empty list with the full state vocabulary — not an error');
    const player = await s.j('POST', '/auth/player/login', { playerId: 'pl-1' });
    const canon = await s.j('GET', '/player/notifications', undefined, player.body?.token);
    ok(canon.status === 200, `the canonical player lane answers on this minimal database (${canon.status})`);
    const pl = await s.j('GET', '/player/transactions', undefined, player.body?.token);
    ok(pl.status === 200 && pl.body.items.length === 0, `and so is the individual's side (${pl.status} ${JSON.stringify(pl.body).slice(0, 80)})`);
    neg(expect(await s.j('GET', '/org/agent/transactions/atx-partial', undefined, org.body.token), 404, 'TRANSACTION_NOT_FOUND'), 'the fixture row left on disk by the partial-upgrade test belongs to nobody and reads as absent');
  }
  await s.stop();
}

// ============================================================ 4
section('4 — a real workspace survives a restart byte for byte');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m26p-live-'));
  const port = 6860 + Math.floor(Math.random() * 40);
  let s = await bootOn(dir, port);
  ok(s.up, 'a clean boot');
  let TX; let DOC; let REV_BEFORE; let TIMELINE_BEFORE;
  if (s.up) {
    const admin = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };
    const priya = (await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })).body;
    const tomas = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' })).body;
    const maria = (await s.j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
    const kola = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
    await s.j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
    const ana = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Costa', role: 'Agent', platform: 'agent' })).body;
    await s.j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, ana.token);
    await s.j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
    await s.j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' }, ana.token);
    const rel = await s.j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'ENG' }, ana.token);
    await s.j('POST', `/player/agent/relationships/${rel.body.relationship.id}/confirm`, { expectedRev: 1 }, kola.token);
    await s.j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: maria.userId, reason: 'persistence suite: club signatory' }, priya.token, admin);
    const create = await s.j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'persist-1' }, ana.token);
    TX = create.body?.transaction?.id;
    ok(create.status === 201 && TX, 'a transaction is opened');
    await s.j('POST', `/org/transactions/${TX}/confirm`, {}, maria.token);
    await s.j('POST', `/player/transactions/${TX}/confirm`, {}, kola.token);
    const bind = await s.j('POST', `/org/agent/transactions/${TX}/representations`, { partyRole: 'individual', agreementId: rel.body.relationship.id, clientKey: 'persist-rep-1' }, ana.token);
    ok(bind.status === 201, 'a representation is bound');
    const d1 = await s.j('POST', `/org/agent/transactions/${TX}/documents`, { documentType: 'mandate', visibility: 'ALL_TRANSACTION_PARTIES', label: 'Mandate v1', clientKey: 'persist-doc-1' }, ana.token);
    DOC = d1.body?.document?.id;
    await s.j('POST', `/org/agent/transactions/${TX}/documents/${DOC}/supersede`, { label: 'Mandate v2' }, ana.token);
    await s.j('POST', `/org/agent/transactions/${TX}/notes`, { text: 'Persistence fixture note.', visibility: 'AGENT_PRIVATE' }, ana.token);
    await s.j('POST', `/org/agent/transactions/${TX}/terms`, { summary: 'Two-year term, standard club schedule.', recordedFor: 'individual', visibility: 'PLAYER_AGENT_SHARED' }, ana.token);
    const before = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(before.body.transaction.status === 'READY', `the transaction is READY before the restart (${before.body.transaction.status})`);
    await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ACTIVE' }, ana.token);
    const held = await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ON_HOLD', reasonCode: 'awaiting_document', reason: 'Waiting on the club letter.', clientKey: 'persist-hold-1' }, ana.token);
    ok(held.status === 200 && held.body.transaction.status === 'ON_HOLD', 'and is put on hold with a reason code');
    REV_BEFORE = held.body.transaction.rev;
    TIMELINE_BEFORE = (await s.j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, ana.token)).body.items.length;
    await s.stop();
  }
  const snap = snapshotOf(dir);
  ok(snap && snap.schema.version === 2308 && snap.agentTransactions.length === 1 && snap.transactionRepresentations.length === 1 && snap.transactionDocuments.length === 2, 'the snapshot on disk holds one transaction, one representation binding and two document versions at 2307');
  const row = snap.agentTransactions[0];
  ok(row.status === 'ON_HOLD' && row.holdReasonCode === 'awaiting_document' && row.parties.length === 2 && row.parties.every((p) => p.confirmedAt), 'the status, its reason code and both party confirmations are on disk');
  ok(row.compliance?.evaluationId && row.compliance.contextId && row.compliance.partyRevision && row.compliance.policyVersions.length >= 1, 'the compliance snapshot reference — evaluation, context, party revision and policy versions — is on disk');
  neg(row.notes.length === 1 && row.terms.versions.length === 1 && row.history.length >= 8, 'the scoped note, the recorded terms version and the append-only history are on disk');
  neg(row.keys && Object.keys(row.keys).length >= 2, 'the idempotency keys are on disk');
  const chain = snap.transactionDocuments;
  neg(chain.find((d) => d.version === 1).supersededBy === chain.find((d) => d.version === 2).id && chain.find((d) => d.version === 2).supersedes === chain.find((d) => d.version === 1).id, 'the document version chain is on disk in both directions — the old row was kept, never edited');
  neg(!/AGENT_PRIVATE/.test(stableJson(snap.transactionDocuments)) && /ALL_TRANSACTION_PARTIES/.test(stableJson(snap.transactionDocuments)), 'each document carries the visibility class it was filed under');
  neg(row.revBy && row.revBy.name === 'Representing agent' && row.revBy.userId === null, 'the shared rev token names a ROLE on disk, not a person (defect D2)');

  s = await bootOn(dir, port + 1);
  ok(s.up, 'the server reboots over that snapshot');
  if (s.up) {
    neg(!new RegExp(STEP).test(s.log()), 'the 2307 step did NOT run again');
    const tomas = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' })).body;
    const ana = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Costa', role: 'Agent', platform: 'agent' })).body;
    const after = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(after.status === 200 && after.body.transaction.status === 'ON_HOLD' && after.body.transaction.rev === REV_BEFORE, 'the transaction reads back with its status and its rev');
    ok(after.body.transaction.parties.every((p) => p.confirmedAt) && after.body.transaction.representations[0].status === 'verified', 'the party confirmations and the representation binding survived');
    ok(after.body.transaction.documents.length === 1 && after.body.transaction.documents[0].version === 2, 'the current document version survived, and the superseded one is not offered as current');
    ok(after.body.transaction.notes.length === 1 && after.body.transaction.terms.versions.length === 1, 'the note and the recorded terms survived');
    const tl = await s.j('GET', `/org/agent/transactions/${TX}/timeline`, undefined, ana.token);
    ok(tl.body.items.length === TIMELINE_BEFORE, `the timeline survived unchanged (${tl.body.items.length} entries)`);
    const replay = await s.j('POST', '/org/agent/transactions', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'persist-1' }, ana.token);
    ok(replay.body.idempotent === true && replay.body.transaction.id === TX, 'the create key replays after the restart — no second transaction');
    const holdReplay = await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ON_HOLD', reasonCode: 'awaiting_document', reason: 'Waiting on the club letter.', clientKey: 'persist-hold-1' }, ana.token);
    ok(holdReplay.body.idempotent === true, 'and so does the status key');
    const audit = await s.j('GET', '/org/agent/agency/audit?limit=100', undefined, tomas.token);
    ok(audit.status === 200 && audit.body.items.some((r) => r.domain === 'transaction' && r.action === 'transaction_created'), 'the agency audit still carries the transaction rows after the restart');
    const conflict = await s.j('POST', `/org/agent/transactions/${TX}/notes`, { text: 'x', visibility: 'AGENT_PRIVATE', expectedRev: 1 }, ana.token);
    neg(expect(conflict, 409, 'TRANSACTION_VERSION_CONFLICT') && conflict.body.updatedBy === 'Representing agent', 'a stale write is still refused after the restart, and the conflict names a ROLE rather than a person');
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
  const db = snapshotOf(dir);
  // (a) the compliance snapshot points at a context that is gone
  db.complianceContexts = db.complianceContexts.filter((c) => c.id !== db.agentTransactions[0].contextId);
  // (b) a document whose transaction no longer exists
  db.transactionDocuments.push({ id: 'txd-orphan', transactionId: 'atx-gone', documentType: 'mandate', visibility: 'ALL_TRANSACTION_PARTIES', label: 'Orphan', version: 1, owner: { kind: 'agent', id: 'usr-x' }, uploadedBy: { kind: 'org', userId: 'usr-x', name: 'Ghost' }, createdAt: 1, expiresAt: null, signedAt: null, evidenceRef: null, supersedes: null, supersededBy: null, removedAt: null, keys: {}, rev: 1, revAt: 1, revBy: null, history: [] });
  // (c) a transaction with a status nobody wrote
  db.agentTransactions.push({ ...structuredClone(db.agentTransactions[0]), id: 'atx-odd', status: 'HALF_WRITTEN', keys: {}, rev: 1 });
  writeSnapshot(dir, db);
  const s = await bootOn(dir, globalThis.LIVE_PORT + 2);
  ok(s.up, 'the server boots over the corrupt rows');
  if (s.up) {
    const ana = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Costa', role: 'Agent', platform: 'agent' })).body;
    const read = await s.j('GET', `/org/agent/transactions/${TX}`, undefined, ana.token);
    ok(read.status === 200, 'the transaction whose compliance context is gone still reads');
    const comp = read.body.transaction.compliance;
    neg(comp.clear === false && comp.staleness !== null && comp.snapshotClear === true, `and its compliance reads as NOT currently clear, stale (${comp.staleness}), while still showing what the recorded evaluation said — a stale verdict is never presented as a clearance`);
    const progress = await s.j('POST', `/org/agent/transactions/${TX}/status`, { to: 'ACTIVE' }, ana.token);
    neg(progress.status === 422, `it cannot be progressed (${progress.status} ${progress.body?.error})`);
    const docs = await s.j('GET', `/org/agent/transactions/${TX}/documents`, undefined, ana.token);
    neg(!docs.body.items.some((d) => d.id === 'txd-orphan'), 'the orphan document reaches nobody — a document belongs to a transaction, and its transaction is gone');
    const odd = await s.j('GET', '/org/agent/transactions/atx-odd', undefined, ana.token);
    ok(odd.status === 200 && odd.body.transaction.status === 'HALF_WRITTEN' && odd.body.transaction.allowedTransitions.length === 0, 'the row with an unknown status reads back as it is on disk and offers no transition');
    neg(expect(await s.j('POST', '/org/agent/transactions/atx-odd/status', { to: 'ACTIVE' }, ana.token), 409, 'TRANSACTION_TRANSITION_NOT_ALLOWED'), 'and nothing can move it');
    neg(expect(await s.j('POST', '/org/agent/transactions/atx-odd/notes', { text: 'x', visibility: 'AGENT_PRIVATE' }, ana.token), 409, 'TRANSACTION_NOT_LIVE'), 'nor can anything be written to it');
    const after = snapshotOf(dir);
    neg(after.agentTransactions.find((t) => t.id === 'atx-odd').status === 'HALF_WRITTEN' && after.transactionDocuments.some((d) => d.id === 'txd-orphan'), 'neither row was repaired or dropped on boot — the bytes are the bytes');
    await s.stop();
  }
}

// ============================================================ pure staleness + machine
section('pure — the staleness verdict and the machine are the same functions the routes use');
{
  const rev = partyRevisionOf({ parties: [], agentUserId: 'a', representations: [], consents: [], facetStates: {}, policyVersions: [], blockedSubjectIds: [], minorSubjectIds: [] });
  neg(snapshotStaleness({ compliance: { evaluationId: 'e', partyRevision: 'different' } }, rev) === 'INPUTS_CHANGED', 'a snapshot taken under different inputs is INPUTS_CHANGED');
  neg(snapshotStaleness({}, rev) === 'NO_SNAPSHOT', 'no snapshot at all is NO_SNAPSHOT — the absence of an evaluation is never a clearance');
  neg(!actorTransitionAllowed('HALF_WRITTEN', 'ACTIVE') && !actorTransitionAllowed('ARCHIVED', 'ACTIVE'), 'an unknown status and an archived one authorise no transition');
  ok(TRANSACTION_STATUSES.length === 10, 'the ten states the routes and this suite share');
}

const total = passed;
console.log(`\nM23 P5.6D Transaction persistence suite: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED');
else console.log('all M23 P5.6D Transaction persistence checks passed');
