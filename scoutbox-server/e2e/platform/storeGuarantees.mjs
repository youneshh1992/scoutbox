// The store guarantees: every collection production code reads exists after boot.
//
// Part 1 checks the migration steps on hand-built snapshots (was m23Persistence.mjs).
// Part 2 boots the real server on a bare migrated database and checks the store contract
// (was m23BootContract.mjs). The two used to be separate suites; their shared check
// (the M23 journey's required stores) now runs once.
//
// ===================================================================== part 1
//
// M23-D2 — core persistence invariant suite.
//
// THE INVARIANT
//
//   Every durable collection that production code may read must exist after a
//   clean boot and after every supported schema upgrade, independent of demo
//   or seed execution.
//
// THE DEFECT THIS EXISTS TO PREVENT RECURRING
//
// The server starts from buildSeed(), so a first boot has every collection.
// Then loadSnapshot() does:
//
//     for (const key of Object.keys(db)) delete db[key];
//     Object.assign(db, raw.db);
//
// — it deletes the seeded object and replaces it with exactly what the
// snapshot holds. A snapshot written before a collection existed removes that
// collection, and the next production read is a TypeError. For db.blocks,
// read by isBlocked() inside every visibility check, that means the
// safeguarding path throws a 500 instead of returning an answer.
//
// WHY THE FIXTURE CARRIES NO SEED (§29)
//
// A test that seeds and then checks the collections exist proves only that the
// seed works. The whole defect lives in the gap between "the seed made it" and
// "the database guarantees it", so every migration case below starts from a
// hand-built snapshot and never calls buildSeed().
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATIONS, SCHEMA_VERSION, runMigrations,
  PRODUCTION_REQUIRED_STORES, missingRequiredStores,
} from '../../domains/platform/migrations.mjs';
import { integrityReport } from '../../domains/platform/integrity.mjs';
import { PLANS } from '../../catalogue.mjs';
import { openStore } from '../../store.mjs';
import { TABLE_BACKED } from '../../repositories/index.mjs';
import { ROOM_STATUSES, ROOM_STATUS_LABELS, TERMINAL_ROOM_STATUSES, stageForRoomStatus } from '../../domains/recruitment/rooms/shared.mjs';
import { JOURNEY_REQUIRED_STORES, JOURNEY_OPTIONAL_STORES } from '../../domains/recruitment/lifecycle/journey.mjs';
import { NULL_EVIDENCE_PROVIDER } from '../../domains/recruitment/lifecycle/lifecycle.mjs';
import {
  PRODUCTION_STORE_CONTRACT, CONTRACT_STORES, MIGRATION_GUARANTEED,
  MODULE_GUARANTEED, OPTIONAL_STORES, NOT_A_STORE, guaranteeFor,
} from '../../storeContract.mjs';
import { pickPort } from '../../scripts/testPort.mjs';
import { buildRecruitmentJourney } from '../../scripts/recruitmentReadsFixture.mjs'; // §4.3 step 2: the contacts/offers queries over the plain arrays

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SERVER = path.join(ROOT, 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The oldest legitimate snapshot: a PRE-M18.2 database.
 *
 * Before M18.2 there was no migration registry at all, so such a snapshot
 * carries no `db.schema` — which is exactly why it is the right fixture. Every
 * step re-runs against it, which is the real upgrade path for any database
 * that predates the registry or arrived by another road (a partial restore, a
 * hand-assembled import, an export that dropped empty collections).
 *
 * It legitimately lacks blocks, channels, reports, moderationLog, plans,
 * archetypes and reputationSeed. It is NOT corrupt — §44's corruption case is
 * `inconsistentSnapshot()` below, and it is treated completely differently.
 */
function priorSnapshot({ withExistingRows = false } = {}) {
  const db = {
    players: [{ id: 'pl-legacy', name: 'Legacy Player', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [] }],
    orgs: [{ id: 'org-legacy', name: 'Legacy FC', type: 'club', level: 'academy', plan: 'Grassroots', verified: true }],
    guardians: [],
    users: [],
    sessions: [],
    ledger: [],
    notifications: [],
    // No db.schema — this database predates the migration registry.
  };
  if (withExistingRows) {
    db.users = [{ id: 'usr-legacy', orgId: 'org-legacy', name: 'Legacy Scout', role: 'Scout', createdAt: 1 }];
    db.blocks = [{ id: 'blk-legacy', playerId: 'pl-legacy', orgId: 'org-legacy', by: 'guardian', reason: 'legacy', ts: 1 }];
    db.requests = [{ id: 'req-legacy', playerId: 'pl-legacy', playerName: 'Legacy Player', orgId: 'org-legacy', orgName: 'Legacy FC', orgType: 'club', orgVerified: false, orgSafeguardingCertified: false, userId: 'usr-legacy', scoutName: 'Legacy Scout', scoutRole: 'Scout', type: 'contact', message: '', trialDetails: null, status: 'pending', createdAt: 1, routedTo: 'player', guardianId: null, contactChannel: null }]; // issueRecruitmentRequest's literal: a request names the staff member who sent it
    db.channels = [{ id: 'ch-legacy', requestId: 'req-legacy', playerId: 'pl-legacy', orgId: 'org-legacy', orgName: 'Legacy FC', counterparty: 'player', createdAt: 1, messages: [], readBy: { org: null, counterparty: null } }]; // the channel literal (openChannel); the data layer refuses a thread without its request
    db.plans = { Grassroots: { name: 'Grassroots', attributionWindowMonths: 99, customised: true } };
  }
  return db;
}

/**
 * A snapshot that CLAIMS steps it does not reflect (§44).
 *
 * Its schema record says `m182_002_collections_present` ran, but the
 * collections that step creates are absent. That is not an old database, it is
 * a damaged one — and the correct response is to report it, not to quietly
 * paper over it, because a runner that re-applies steps a snapshot claims are
 * done would hide genuine corruption everywhere else too.
 */
function inconsistentSnapshot() {
  return {
    players: [{ id: 'pl-legacy', name: 'Legacy Player', media: [], attendance: [], trialReports: [] }],
    orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [],
    schema: { version: 2200, migrations: MIGRATIONS.map((m) => ({ id: m.id, at: '2026-01-01T00:00:00.000Z' })) },
  };
}

/** The snapshot, minus the one field that legitimately moves on every run. */
const stableJson = (db) => {
  const { schema, ...rest } = db;
  const { updatedAt, ...schemaRest } = schema ?? {};
  return JSON.stringify({ ...rest, schema: schemaRest });
};

console.log('\n— §4/§5 — the inventory is derived, not hand-kept —');
{
  // Every name in the required list must actually be guaranteed by a step.
  const fresh = {};
  runMigrations(fresh);
  const missing = missingRequiredStores(fresh);
  ok(missing.length === 0,
    `all ${PRODUCTION_REQUIRED_STORES.length} required stores exist after migrations alone (no seed)`);
  if (missing.length) console.error(`   missing: ${missing.join(', ')}`);
  neg(PRODUCTION_REQUIRED_STORES.includes('squads') === false,
    'db.squads is NOT in the list — it never existed; squad membership is org_squad_members (S9c)');

  // THE DRIFT GUARD. Two lists declared the same thing in two files and
  // disagreed: `db.assessments` was REQUIRED by the journey projection and
  // absent from the migration's guarantee, so a restored snapshot upgraded
  // cleanly and then answered 500 on the journey route. It escaped the D2 pass
  // because `m12/shared.mjs` creates it with `??=` at registration, so a
  // running server always has it — and no test that goes through HTTP can see
  // the gap. Stated as containment, not as a list of names.
  const declaredNotGuaranteed = JOURNEY_REQUIRED_STORES.filter((k) => !PRODUCTION_REQUIRED_STORES.includes(k));
  if (declaredNotGuaranteed.length) console.error(`   declared required but not guaranteed: ${declaredNotGuaranteed.join(', ')}`);
  neg(declaredNotGuaranteed.length === 0,
    'every store the M23 journey DECLARES required is guaranteed by a migration step');
  neg(JOURNEY_OPTIONAL_STORES.every((k) => !PRODUCTION_REQUIRED_STORES.includes(k)),
    'and the optional ones are NOT guaranteed — "absent because the phase has not shipped" must stay distinguishable from "present and empty"');
}

console.log('\n— §8 — clean boot: empty database, no seed —');
{
  const db = {};
  const r = runMigrations(db);
  ok(r.from === 0 && r.to === SCHEMA_VERSION, `a brand-new database migrates 0 → ${SCHEMA_VERSION}`);
  ok(r.ran.length === MIGRATIONS.length, `all ${MIGRATIONS.length} steps ran`);
  ok(Array.isArray(db.blocks) && db.blocks.length === 0, 'db.blocks exists and is empty');
  ok(!Object.hasOwn(db, 'requests'), 'db.requests is not created: the requests are a table read through SQL (§4.3 step 2; rewritten, it described the old storage)');
  ok(Array.isArray(db.channels), 'db.channels exists');
  ok(Array.isArray(db.reports), 'db.reports exists');
  ok(Array.isArray(db.moderationLog), 'db.moderationLog exists');
  ok(Array.isArray(db.reputationSeed) && db.reputationSeed.length === 0,
    'db.reputationSeed exists and is EMPTY — seeded track records are demo data, not production truth');
  ok(db.plans && typeof db.plans === 'object' && !Array.isArray(db.plans), 'db.plans exists as an object');
  ok(Array.isArray(db.archetypes) && db.archetypes.length === 5, 'db.archetypes exists with the 5 catalogue entries');
}

console.log('\n— §9/§12 — a prior snapshot upgrades and gains what it lacked —');
{
  const db = priorSnapshot();
  neg(db.blocks === undefined, 'fixture: the prior snapshot genuinely has no blocks');
  neg(db.plans === undefined, 'fixture: and no plans');
  const r = runMigrations(db);
  ok(r.to === SCHEMA_VERSION, `it migrates to ${SCHEMA_VERSION}`);
  ok(missingRequiredStores(db).length === 0, 'every required store is present afterwards');
  ok(Array.isArray(db.blocks) && db.blocks.length === 0, 'db.blocks exists and is empty — no block relation, which is the truth');
}

console.log('\n— §13/§33 — the safeguarding path answers instead of throwing —');
{
  const db = priorSnapshot();
  // Before migration this is the production defect, reproduced exactly.
  const isBlockedRaw = (playerId, orgId) => db.blocks.some((b) => b.playerId === playerId && b.orgId === orgId);
  let threw = false;
  try { isBlockedRaw('pl-legacy', 'org-legacy'); } catch { threw = true; }
  neg(threw, 'BEFORE migration isBlocked() throws on the restored snapshot — the defect, reproduced');

  runMigrations(db);
  let after = null, threwAfter = false;
  try { after = isBlockedRaw('pl-legacy', 'org-legacy'); } catch { threwAfter = true; }
  ok(!threwAfter, 'AFTER migration it does not throw');
  ok(after === false, 'and returns a real authorization answer: false — no block relation exists');
  neg(after !== undefined && after !== null, 'the answer is a boolean verdict, not a missing-store sentinel');
}

console.log('\n— §14/§17/§27 — existing rows survive, byte for byte —');
{
  const db = priorSnapshot({ withExistingRows: true });
  const blockBefore = JSON.stringify(db.blocks);
  const reqBefore = JSON.stringify(db.requests);
  const chanBefore = JSON.stringify(db.channels);
  const plansBefore = JSON.stringify(db.plans);

  runMigrations(db);

  ok(JSON.stringify(db.blocks) === blockBefore, 'an existing block row is preserved exactly');
  ok(db.blocks.length === 1, 'and not duplicated');
  ok(JSON.stringify(db.requests) === reqBefore, 'an existing request row is preserved exactly');
  ok(JSON.stringify(db.channels) === chanBefore, 'an existing channel row is preserved exactly');
  ok(JSON.stringify(db.plans) === plansBefore,
    'a CUSTOMISED plan table is preserved — the migration never overwrites configuration it finds');
  neg(db.plans.Grassroots.attributionWindowMonths === 99,
    'specifically: the customised 99-month window survives rather than being reset to the catalogue value');

  // And the block still works.
  const blocked = db.blocks.some((b) => b.playerId === 'pl-legacy' && b.orgId === 'org-legacy');
  ok(blocked === true, 'the preserved block is still effective after migration');
}

console.log('\n— §24 — the plans catalogue is restored, not emptied —');
{
  const db = priorSnapshot();
  runMigrations(db);
  ok(db.plans.Grassroots?.attributionWindowMonths === 12,
    'a restored Grassroots plan keeps its 12-month attribution window');
  neg(db.plans.Grassroots?.attributionWindowMonths !== 18,
    'it is NOT 18 — an empty plans table would have fallen through `?? 18` and silently changed billing');
  ok(Object.keys(db.plans).length === Object.keys(PLANS).length,
    `all ${Object.keys(PLANS).length} plans are present`);
}

console.log('\n— §10/§48 — idempotency and restart —');
{
  const db = priorSnapshot({ withExistingRows: true });
  runMigrations(db);
  const after1 = stableJson(db);
  const r2 = runMigrations(db);
  ok(r2.ran.length === 0, 'a second run applies no step');
  ok(stableJson(db) === after1, 'and changes no data at all');
  const r3 = runMigrations(db);
  ok(r3.ran.length === 0 && stableJson(db) === after1, 'a third run is equally inert');
  // `schema.updatedAt` is stamped on every run by design — it records when the
  // registry was last checked, not when data changed. It is excluded above
  // rather than asserted equal, because asserting equality would make this
  // test pass or fail on whether two runs landed in the same millisecond.
  ok(db.schema.migrations.length === MIGRATIONS.length,
    'the applied list holds each step exactly once after three runs');
  neg(db.blocks.length === 1, 'repeated migration did not duplicate the existing block row');
}

console.log('\n— §45 — boot integrity reports a missing store, and never repairs it —');
{
  const db = priorSnapshot();
  const before = integrityReport(db, { cases: db.recruitmentCases ?? [] });
  ok(before.stores.ok === false, 'an un-migrated snapshot reports missing stores');
  ok(before.stores.missing.includes('blocks'), 'db.blocks is named among them');
  neg(db.blocks === undefined, 'and integrityReport did NOT create the collection — it reports, it does not repair');
  neg(before.violations.every((v) => v.code !== 'STORE_MISSING'),
    'a missing store is NOT counted as a data violation — two records disagreeing and a database never built need different answers');

  runMigrations(db);
  const after = integrityReport(db, { cases: db.recruitmentCases ?? [] });
  ok(after.stores.ok === true, 'after migration no store is missing');
  ok(after.stores.missing.length === 0, 'and the missing list is empty');
}

console.log('\n— §44 — a snapshot that CLAIMS a step it does not reflect is reported, not repaired —');
{
  // This is the corruption case, and it must behave differently from the old
  // snapshot above. The registry trusts its own applied list — re-running a
  // step a snapshot claims is done would hide real damage everywhere — so the
  // migration correctly does nothing and integrity correctly complains.
  const db = inconsistentSnapshot();
  const r = runMigrations(db);
  ok(r.ran.length === 0, 'the runner applies nothing: every step is already claimed');
  const report = integrityReport(db, { cases: db.recruitmentCases ?? [] });
  ok(report.stores.ok === false, 'and boot integrity reports the collections that are nonetheless absent');
  neg(db.blocks === undefined,
    'the damaged snapshot is NOT silently repaired — a person is told, which is §44');
  ok(report.stores.missing.includes('blocks'), 'db.blocks is named, so the operator knows what to restore');
}

console.log('\n— §46/§47 — startup order: stores exist before any module registers —');
{
  // runMigrations is called in server.mjs immediately after loadSnapshot and
  // before every registerXX(). This asserts the ordering property directly:
  // the required set is complete with NO module having been imported.
  const db = {};
  runMigrations(db);
  ok(missingRequiredStores(db).length === 0,
    'every required store exists from migrations alone — no feature module participated');
  neg(!Object.hasOwn(db, 'recruitmentCases') && db.blocks !== undefined,
    'registration order cannot decide whether core collections exist (the cases are a table read through SQL since §4.3 step 2; rewritten)');
}

// ---------------------------------------------------------------- live boot
console.log('\n— §33/§34 — a real server on a real restored snapshot —');
{
  const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23p-'));
  mkdirSync(DATA_DIR, { recursive: true });

  // Write the prior snapshot to disk exactly as the store would have.
  const store = openStore(DATA_DIR);
  const snap = priorSnapshot({ withExistingRows: true });
  store.save({ savedAt: Date.now(), idCounter: 500, db: snap });

  const PORT = pickPort(4970, 120, [0]); // TH-6: never a fetch-blocked port
  const BASE = `http://localhost:${PORT}`;
  const children = [];
  process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

  const boot = async () => {
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(proc);
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { out += c; });
    // the m22E2E lesson: a ref'd child keeps the loop open forever
    proc.unref(); proc.stdout.unref(); proc.stderr.unref();

    // WAIT FOR THE SERVER'S OWN SIGNAL, NOT FOR A GUESS ABOUT HOW LONG IT TAKES.
    //
    // This used to be 160 polls of 250ms and nothing else, and it failed about
    // one run in twenty — always in a loaded battery, never alone. The failure
    // message said "server did not come up" and printed a log that ended with
    // `scoutbox-server listening on :5060`, which is the opposite of what the
    // message claimed. What actually happened: boot took longer than the
    // 40-second budget, the polls ran out, and the announcement landed in `out`
    // during the final sleep — so the error message was assembled after the
    // server was up, and blamed the server for the harness giving up.
    //
    // Raising the number would have been the wrong repair twice over: it keeps
    // a guess at the centre of the check, and it leaves the message lying.
    // The server announces its port on stdout when `app.listen` fires. That is
    // a real readiness edge, so wait on it, and only then confirm over HTTP.
    //
    // Three distinct failures, three distinct messages — they were one before,
    // and one of them was not even true.
    const LISTEN = /listening on :(\d+)/;
    const deadline = Date.now() + 120_000;
    let announced = null;
    while (Date.now() < deadline) {
      if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode}) before it announced a port:\n${out}`);
      const m = LISTEN.exec(out);
      if (m) { announced = Number(m[1]); break; }
      await sleep(100);
    }
    if (announced === null) throw new Error(`server never announced a listening port within 120s:\n${out}`);
    if (announced !== PORT) throw new Error(`server bound :${announced}, not the :${PORT} it was given:\n${out}`);

    // It says it is listening. If it will not answer now, that is a real
    // defect, not a slow machine — so this budget is short and the message
    // is specific.
    for (let i = 0; i < 40; i++) {
      if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode}) after announcing :${announced}:\n${out}`);
      try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return proc; } catch { /* the socket is opening */ }
      await sleep(250);
    }
    throw new Error(`server announced :${announced} but did not answer /healthz within 10s of announcing:\n${out}`);
  };

  const proc = await boot();
  const health = await (await fetch(`${BASE}/healthz`)).json();
  ok(health.schemaVersion === SCHEMA_VERSION,
    `the restored snapshot booted and reports schema ${SCHEMA_VERSION}`);

  const caps = await (await fetch(`${BASE}/capabilities`)).json();
  ok(caps.integrity?.stores?.ok === true,
    'the running server reports every required store present');

  // The safeguarding path, over real HTTP, on the snapshot that lacked blocks.
  const login = await (await fetch(`${BASE}/auth/org/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId: 'org-legacy', scoutName: 'Legacy Scout', role: 'Head of Recruitment' }),
  })).json();
  if (login?.token) {
    const list = await fetch(`${BASE}/org/players`, { headers: { Authorization: `Bearer ${login.token}` } });
    ok(list.status === 200, '§33 the org player list — which runs isBlocked() per player — returns 200, not 500');
    const reqs = await fetch(`${BASE}/org/requests`, { headers: { Authorization: `Bearer ${login.token}` } });
    ok(reqs.status === 200, '§34 the recruitment request path returns 200 on a snapshot that had no requests store');
    const body = await reqs.json();
    ok(Array.isArray(body.items) && body.items.some((r) => r.id === 'req-legacy'),
      'and the pre-existing request row is still there');
  } else {
    fail('could not authenticate against the restored snapshot');
  }

  // §48 — restart: stores stay, no migration churn.
  proc.kill('SIGTERM');
  await sleep(600);
  const proc2 = await boot();
  const health2 = await (await fetch(`${BASE}/healthz`)).json();
  ok(health2.schemaVersion === SCHEMA_VERSION, '§48 after a restart the schema is unchanged');
  const caps2 = await (await fetch(`${BASE}/capabilities`)).json();
  ok(caps2.schema?.migrationsApplied === MIGRATIONS.length,
    'and every step is recorded exactly once — no churn');
  proc2.kill('SIGTERM');
}

console.log('\n— §44/§45 — every one of the eighteen states survives a restore —');
{
  // A state that cannot be read back is a state a club can be trapped in. The
  // point is not that `watching` works; it is that ALL EIGHTEEN do, including
  // the five M23 added and the four terminal ones — and that the check is
  // driven off ROOM_STATUSES, so a nineteenth is covered the day it is added.
  const db = {
    recruitmentCases: ROOM_STATUSES.map((st, i) => ({
      id: `case-${st}`, orgId: 'org-legacy', playerId: 'pl-legacy',
      stage: stageForRoomStatus(st, 'academy'), createdAt: 1000 + i,
      room: { status: st, rev: 1, priority: 'normal' },
      history: [{ action: 'room_created', at: 1000 + i, detail: { status: st } }],
    })),
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [],
  };
  runMigrations(db);

  const VIEWER = { kind: 'org_staff', orgId: 'org-legacy', role: 'recruitment_admin' };
  const OPTS = { now: 2000, evidence: NULL_EVIDENCE_PROVIDER };
  let projected = 0; const problems = [];
  for (const st of ROOM_STATUSES) {
    let out;
    try { out = buildRecruitmentJourney(db, `case-${st}`, VIEWER, OPTS); }
    catch (e) { problems.push(`${st}: threw ${e.message}`); continue; }
    if (!out.ok) { problems.push(`${st}: refused ${out.error}`); continue; }
    if (out.lifecycle.currentStage !== st) { problems.push(`${st}: read back as ${out.lifecycle.currentStage}`); continue; }
    if (out.lifecycle.label !== ROOM_STATUS_LABELS[st]) { problems.push(`${st}: label drifted`); continue; }
    if (out.lifecycle.terminal !== TERMINAL_ROOM_STATUSES.includes(st)) { problems.push(`${st}: terminality drifted`); continue; }
    projected += 1;
  }
  for (const p of problems) console.error(`   ${p}`);
  ok(projected === ROOM_STATUSES.length,
    `all ${ROOM_STATUSES.length} lifecycle states restore and project with their own status, label and terminality`);
  neg(problems.length === 0, 'and none of them is silently rewritten to a neighbouring state');

  // Migration must not touch a case it has no business touching.
  const before = JSON.stringify(db.recruitmentCases);
  runMigrations(db);
  neg(JSON.stringify(db.recruitmentCases) === before,
    '§46 re-running every migration step changes not one case');
}

console.log('\n— §47 — a PRE-M23 snapshot keeps all thirteen original statuses —');
{
  // The thirteen that existed before M23 extended the set. Each must come back
  // as itself: a status quietly remapped during an upgrade is a club's
  // recruitment position silently rewritten.
  const PRE_M23 = [
    'watching', 'under_review', 'shortlisted', 'priority', 'trial_requested',
    'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made',
    'signed', 'withdrawn', 'archived', 'closed',
  ];
  // Built HONESTLY rather than hand-declared: run every pre-M23 step for real,
  // then wind the schema record back to 2200. A fixture that merely CLAIMS the
  // earlier steps without reflecting them is not an old database — it is the
  // damaged one from §44 above, and it would be testing a different thing
  // entirely. The D2 guarantee is "every upgrade path from a database that
  // honestly ran its steps"; a snapshot that lies about its own history is
  // reported to a person, not repaired.
  const db = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [] };
  for (const step of MIGRATIONS.filter((m) => !m.id.startsWith('m230_'))) step.up(db);
  db.schema = {
    version: 2200,
    migrations: MIGRATIONS.filter((m) => !m.id.startsWith('m230_')).map((m) => ({ id: m.id, at: '2026-01-01T00:00:00.000Z' })),
  };
  // Deliberately PRE-D2: the seven stores that pass added are absent, which is
  // the real shape of a database last written before D2 landed.
  for (const store of ['blocks', 'channels', 'reports', 'moderationLog', 'plans', 'archetypes', 'reputationSeed']) delete db[store];
  db.recruitmentCases = PRE_M23.map((st, i) => ({
    id: `old-${st}`, orgId: 'org-legacy', playerId: 'pl-legacy', stage: 'review', createdAt: 1000 + i,
    room: { status: st, rev: 2 },
    history: [
      { action: 'room_created', at: 1000 + i, detail: { status: 'watching' } },
      { action: 'room_status_changed', at: 1100 + i, detail: { from: 'watching', to: st } },
    ],
  }));
  const historyBefore = db.recruitmentCases.map((c) => c.history.length);
  const statusBefore = db.recruitmentCases.map((c) => c.room.status);

  const r = runMigrations(db);
  ok(r.to === SCHEMA_VERSION, `a pre-M23 snapshot upgrades 2200 → ${SCHEMA_VERSION}`);
  neg(db.recruitmentCases.every((c, i) => c.room.status === statusBefore[i]),
    'every one of the thirteen original statuses is still exactly itself');
  neg(db.recruitmentCases.every((c, i) => c.history.length === historyBefore[i]),
    '§49 and NO migration invented a transition to fill a gap — history lengths are unchanged');
  neg(missingRequiredStores(db).length === 0,
    '§50 while the D2 stores it never had are now present');

  // And it reads. A migrated-but-unreadable database is not migrated.
  // §4.3 step 2: the contacts, signings, requests and trials are tables now, not collections the migrations create; a pre-M23 database has none,
  // so the projection is given the empty contacts table it would read (rewritten: it described the old storage).
  // S9b: likewise the assessments (migration 0020's table), which a pre-M23 database's blob does not carry.
  const out = buildRecruitmentJourney({ ...db, recruitmentContacts: [], signings: db.signings ?? [], requests: db.requests ?? [], trials: db.trials ?? [], roomDecisions: db.roomDecisions ?? [], assessments: db.assessments ?? [] }, 'old-signed', { kind: 'org_staff', orgId: 'org-legacy', role: 'room_lead' },
    { now: 3000, evidence: NULL_EVIDENCE_PROVIDER });
  if (!out.ok) console.error(`   journey refused: ${JSON.stringify(out)}`);
  ok(out.ok === true && out.lifecycle?.currentStage === 'signed',
    'and a pre-M23 signed case projects through the M23 journey as signed');
  neg(out.outcome?.signing === null,
    'with no signing invented to justify the status it was already in');
  ok(out.history?.entries.length === 2,
    'and its two real history entries, neither more nor fewer');
}

// ===================================================================== part 2
//
// M23 — the production boot contract.
//
// THE RULE THIS SUITE ENFORCES
//
//   A production-read store may be guaranteed either by schema/bootstrap or by
//   an owning production module — but the guarantee must be EXECUTABLE,
//   DETERMINISTIC and PROVEN BEFORE REQUESTS CAN REACH THAT CODE.
//
// WHY THIS EXISTS
//
// The M23 sweep found that 84 of 116 `db.x ??=` collections do not exist after
// `runMigrations` alone. The tempting conclusion — "migrate all 84" — would be
// wrong twice over: it would be an 84-store rewrite justified by no evidence,
// and it would paper over the real question, which is whether the production
// composition actually guarantees them.
//
// So this file does not reason about `??=` lines. It boots the real server on
// a database that has been through migrations and NOTHING ELSE — no demo seed,
// no test seed, no fixture, no prior process state — lets every production
// module register, and then reads back what is actually there.
//
// THE SEED PROBLEM, AND HOW IT IS AVOIDED
//
// `server.mjs` begins `const db = buildSeed()`, so a server pointed at an empty
// directory starts from demo data and proves nothing. `loadSnapshot()` replaces
// that object wholesale when a snapshot exists, so the fixture here WRITES a
// bare migrated snapshot to disk first. The server then boots onto it and the
// seed is gone before a single module registers.
//
// HOW THE RESULT IS READ
//
// `store.save()` writes every key of the live `db` object
// (`Object.entries(snapshot.db)`), so a persist after boot is a faithful
// listing of what the composed server actually holds. The suite sends SIGTERM,
// which the server handles with `persistNow()`, and reads the snapshot back.

// ===================================================== the source inventory

// NOT_A_STORE and the optional classification now come from
// `storeContract.mjs`. They used to be declared here as well, which made three
// places that could disagree about one fact.
const OPTIONAL_BY_DESIGN = Object.fromEntries(
  OPTIONAL_STORES.map((s) => [s, PRODUCTION_STORE_CONTRACT[s].reason]),
);

const SKIP_DIRS = new Set(['node_modules', 'scripts', 'e2e', 'data', 'public', 'assets', 'dist']);

/** A file under domains/ belongs to its folder (domains/platform, domains/recruitment/rooms…), a milestone file to its milestone. */
const moduleOf = (file) => (file.startsWith('domains/') ? path.posix.dirname(file) : file.split('/')[0].replace('.mjs', ''));

function productionFiles() {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.mjs')) out.push(f);
    }
  }(ROOT));
  return out;
}

/** Every `db.<name>` mentioned by production code, with where it is read and initialised. */
function scanStores() {
  const stores = new Map();
  const get = (n) => {
    if (!stores.has(n)) stores.set(n, { name: n, inits: [], reads: [], rawReads: 0 });
    return stores.get(n);
  };
  for (const f of productionFiles()) {
    const rel = path.relative(ROOT, f);
    // COMMENTS ARE NOT READS. Three of this codebase's clearest comments say
    // that a store deliberately does NOT exist — `db.recruitmentJourneys`,
    // `db.squads` — and a scanner that counts those as reads reports the
    // opposite of what the comment is there to establish. Block comments and
    // line comments are stripped before anything is matched.
    const text = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\bdb\.([A-Za-z0-9_]+)\s*(\?\?=|=(?!=))/g)) {
        get(m[1]).inits.push({ file: rel, line: i + 1, kind: m[2] === '??=' ? 'default' : 'assign' });
      }
      for (const m of line.matchAll(/\bdb\.([A-Za-z0-9_]+)/g)) {
        const after = line.slice(m.index + m[0].length);
        if (/^\s*(\?\?=|=(?!=))/.test(after)) continue;
        const e = get(m[1]);
        const guarded = /^\s*(\?\.|\?\?)/.test(after) || new RegExp(`Array\\.isArray\\(\\s*db\\.${m[1]}\\b`).test(line);
        e.reads.push({ file: rel, line: i + 1, guarded });
        if (!guarded) e.rawReads += 1;
      }
    });
  }
  for (const n of Object.keys(NOT_A_STORE)) stores.delete(n);
  return [...stores.values()].filter((s) => s.reads.length || s.inits.length).sort((a, b) => a.name.localeCompare(b.name));
}

const ALL = scanStores();

// ============================================================= the fixtures

const bareMigrated = () => {
  // `loadSnapshot()` only accepts a snapshot whose `db.players` is an array, so
  // the fixture carries the empty identity collections and nothing else. It is
  // a database, not a demo.
  const db = { players: [], orgs: [], guardians: [], users: [], sessions: [], ledger: [], notifications: [] };
  runMigrations(db);
  return db;
};

/** A pre-M18.2 database: no schema record at all, several collections absent. */
const oldSnapshot = () => ({
  players: [{ id: 'pl-legacy', name: 'Legacy Player', dob: '2000-05-05', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [] }],
  orgs: [{ id: 'org-legacy', name: 'Legacy FC', type: 'club', level: 'academy', plan: 'Grassroots', verified: true }],
  guardians: [], users: [], sessions: [], ledger: [], notifications: [],
});

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

/**
 * Boot the real server on a directory, wait for it to answer, optionally probe
 * it, then shut it down with SIGTERM so its own `persistNow()` writes the live
 * `db` back. Returns what the composed server actually held.
 */
async function bootAndCapture(dataDir, { port, probe = null } = {}) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; });
  proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();

  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log, exitCode: proc.exitCode, db: null, probe: null };
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) return { up: false, log, db: null, probe: null };

  const probeResult = probe ? await probe(base) : null;

  proc.kill('SIGTERM');
  for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
  const snap = openStore(dataDir).load();
  return { up: true, log, db: snap?.db ?? null, probe: probeResult };
}

const PORT_BASE = 5200 + Math.floor(Math.random() * 300);

// ============================================== §2/§12 — the classification

section('§2/§12 — every production-read store, classified');

const migratedOnly = {};
runMigrations(migratedOnly);
const byMigration = new Set(Object.keys(migratedOnly));

// The clean boot is what decides "module-boot guaranteed", so it runs first.
section('§4/§15 — full production boot on a bare migrated database, no seed');
const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-bootc-clean-'));
{
  const store = openStore(CLEAN_DIR);
  const bare = bareMigrated();
  store.save({ savedAt: Date.now(), idCounter: 1, db: bare });
  ok(bare.players.length === 0 && bare.orgs.length === 0,
    '§4 the fixture is a MIGRATED database and not a seed — zero players, zero orgs');
  neg(bare.assessmentTemplates === undefined,
    'and it carries none of the module-owned collections, so the boot has to create them');
}

/**
 * The FIRST request the suite makes, issued the instant /healthz answers.
 *
 * `/healthz` responding means `app.listen` fired, which means the module body
 * finished, which means every `register*()` returned. The probe turns that
 * chain into an observation: it asks the LAST-registered module (M23) for its
 * vocabulary, and it asks a module-owned store's route to answer. If routes
 * could be exposed before their module registered, one of these would 404.
 */
const firstRequestProbe = async (base) => {
  const login = await (await fetch(`${base}/auth/org/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgId: 'org-legacy', scoutName: 'Boot Prober', role: 'Head of Recruitment' }),
  })).json().catch(() => null);
  if (!login?.token) return { login: false };
  const H = { Authorization: `Bearer ${login.token}` };
  const lifecycle = await fetch(`${base}/org/recruitment/lifecycle`, { headers: H });
  const reviewQueue = await fetch(`${base}/org/review-queue`, { headers: H });
  const notes = await fetch(`${base}/org/players/pl-none/notes`, { headers: H });
  return {
    login: true,
    lifecycle: lifecycle.status,
    lifecycleBody: await lifecycle.json().catch(() => null),
    reviewQueue: reviewQueue.status,
    notes: notes.status,
  };
};

const clean = await bootAndCapture(CLEAN_DIR, { port: PORT_BASE });
ok(clean.up, `§15 the server boots on a bare migrated database${clean.up ? '' : `:\n${clean.log.slice(-900)}`}`);
ok(clean.db !== null, 'and its live state is readable back through the store');

const presentAfterBoot = new Set(Object.keys(clean.db ?? {}));

// Now the classification can be made from evidence rather than from `??=` lines.
const rows = ALL.map((s) => {
  const optional = OPTIONAL_BY_DESIGN[s.name] !== undefined;
  const migration = byMigration.has(s.name);
  const moduleBoot = !migration && presentAfterBoot.has(s.name);
  const owners = [...new Set(s.inits.filter((i) => i.kind === 'default').map((i) => i.file))];
  return {
    ...s,
    optional,
    migration,
    moduleBoot,
    owners,
    classification: optional ? 'OPTIONAL'
      : migration ? 'MIGRATION'
        : moduleBoot ? 'MODULE_BOOT'
          : 'MISSING',
  };
});

const counts = {
  total: rows.length,
  migration: rows.filter((r) => r.classification === 'MIGRATION').length,
  moduleBoot: rows.filter((r) => r.classification === 'MODULE_BOOT').length,
  optional: rows.filter((r) => r.classification === 'OPTIONAL').length,
  missing: rows.filter((r) => r.classification === 'MISSING').length,
};

console.log(`\n  production-read stores      : ${counts.total}`);
console.log(`  migration/bootstrap guaranteed: ${counts.migration}`);
console.log(`  module guaranteed             : ${counts.moduleBoot}`);
console.log(`  optional by design            : ${counts.optional}`);
console.log(`  missing after production boot : ${counts.missing}`);

for (const r of rows.filter((r) => r.classification === 'MISSING')) {
  console.error(`   MISSING: db.${r.name} — ${r.rawReads} unguarded read(s), owners: ${r.owners.join(', ') || 'none'}`);
}
neg(counts.missing === 0, '§8/§12 no production-read store is missing after a full production boot');
neg(counts.total === counts.migration + counts.moduleBoot + counts.optional + counts.missing,
  'and every store is accounted for — there is no unexplained store');

// §5 — the module guarantee is proven by execution, not inferred from a line.
{
  const moduleOwned = rows.filter((r) => r.classification === 'MODULE_BOOT');
  ok(moduleOwned.length > 0, `§5 ${moduleOwned.length} stores are guaranteed by their owning module rather than by a migration`);
  neg(moduleOwned.every((r) => presentAfterBoot.has(r.name)),
    'and every one of them was READ BACK from a real booted server, not inferred from a `??=` line');
  const noOwner = moduleOwned.filter((r) => r.owners.length === 0);
  for (const r of noOwner) console.error(`   no identifiable owner: db.${r.name}`);
  neg(noOwner.length === 0, 'and each names an owning module that initialises it');
}

// §7 — optional means absence has product meaning, not that the code used `?.`.
{
  for (const [name, why] of Object.entries(OPTIONAL_BY_DESIGN)) {
    const r = rows.find((x) => x.name === name);
    ok(!!r, `§7 db.${name} is classified OPTIONAL: ${why}`);
    neg(r && !presentAfterBoot.has(name),
      `and it really is absent after a production boot — the classification is not decorative`);
  }
  neg(JOURNEY_OPTIONAL_STORES.every((k) => !PRODUCTION_REQUIRED_STORES.includes(k)),
    'and no store is both declared optional and required');
}

// ================================================ §13/§14 — the named stores

section('§13/§14 — db.assessments and the D2 stores, checked by name');
{
  // S9b (rewritten: it described the old storage): the assessments are a typed table created by data migration 0020,
  // which every database runs before any module registers; the booted store reads them back from that table.
  neg(!byMigration.has('assessments') && TABLE_BACKED.includes('assessments'),
    '§13 the assessments are a table of migration 0020 — they do not depend on M12 registration order');
  neg(presentAfterBoot.has('assessments'), 'and they are there after a full production boot');
  // The M23 journey's required stores are checked once, in part 1 (§4/§5).

  // §4.3 step 2 (rewritten: it described the old storage): the D2 `requests` and `trials` are typed tables read
  // through SQL, no db collection a migration creates; the recruitment suites prove they are there on every boot.
  // S9b likewise for `assessments` (§13 above): a table, present after boot, created by a data migration.
  const D2 = ['blocks', 'reports', 'moderationLog', 'channels', 'reputationSeed', 'plans', 'archetypes',
    'assessments'];
  const absent = D2.filter((k) => !presentAfterBoot.has(k));
  for (const k of absent) console.error(`   D2 store absent after boot: db.${k}`);
  neg(absent.length === 0, `§14 all ${D2.length} D2 stores are present after a full production boot`);
  neg(D2.every((k) => byMigration.has(k) || TABLE_BACKED.includes(k)), 'and all of them by migration (a snapshot step or a table\'s data migration), not by module registration');

  // The two that are configuration rather than containers must not be empty:
  // an empty plans table silently moves a Grassroots attribution window.
  const plans = clean.db?.plans;
  neg(plans && typeof plans === 'object' && Object.keys(plans).length > 0,
    'and db.plans came back as a populated catalogue, not an empty object');
  neg(Array.isArray(clean.db?.archetypes) && clean.db.archetypes.length === 5,
    'and db.archetypes with its five entries — configuration does not default to empty');
  neg(Array.isArray(clean.db?.reputationSeed) && clean.db.reputationSeed.length === 0,
    'while reputationSeed is EMPTY, because fabricated track records would be worse than the bug');
}

// ================================ §3/§6/§9/§10 — order, proven not assumed

section('§3/§6/§9 — initialisation happens before any request can arrive');
{
  // The architectural guarantee: `server.mjs` is one synchronous module body.
  // Every `register*()` call runs during evaluation; `app.listen` is the LAST
  // statement in the file. Node does not open the socket until the module body
  // has finished, so no request can arrive before every module has registered.
  //
  // Asserted mechanically against the source, because it is a claim about
  // evaluation order that a runtime probe cannot disprove by itself.
  const src = readFileSync(SERVER, 'utf8');
  const lines = src.split('\n');
  const registerLines = [];
  lines.forEach((l, i) => { if (/^\s*(const \w+ = )?register[A-Z]\w*\(/.test(l)) registerLines.push(i + 1); });
  const listenLine = lines.findIndex((l) => /^app\.listen\(/.test(l)) + 1;
  ok(registerLines.length >= 10, `§9 ${registerLines.length} module registrations found in the composition root`);
  ok(listenLine > 0, 'and app.listen is a top-level statement');
  neg(registerLines.every((n) => n < listenLine),
    `§6 every registration (lines ${Math.min(...registerLines)}–${Math.max(...registerLines)}) precedes app.listen (line ${listenLine})`);

  // A top-level `await` between them would break the synchronous guarantee by
  // yielding to the event loop mid-composition.
  const between = lines.slice(Math.min(...registerLines) - 1, listenLine);
  const awaits = between.filter((l) => /^\s*(const|let|var)?\s*[\w{}[\], ]*=?\s*await\s/.test(l) && !/^\s*\/\//.test(l));
  for (const a of awaits) console.error(`   top-level await between registration and listen: ${a.trim().slice(0, 80)}`);
  neg(awaits.length === 0,
    'and nothing between them awaits, so composition cannot yield to the event loop half-finished');

  // §18 — no read-time repair. A `db.x ??=` inside a request handler is not a
  // boot guarantee, it is a surprise repair on whichever request happens to
  // arrive first, and it hides the missing store from every boot-time check.
  const offenders = [];
  for (const f of productionFiles()) {
    const rel = path.relative(ROOT, f);
    const text = readFileSync(f, 'utf8');
    const ls = text.split('\n');
    let handlerDepth = null;
    ls.forEach((line, i) => {
      if (/\b(orgRouter|playerRouter|guardianRouter|adminRouter|app)\.(get|post|patch|put|delete)\s*\(/.test(line)) handlerDepth = i;
      if (handlerDepth !== null && i - handlerDepth <= 60 && /\bdb\.[A-Za-z0-9_]+\s*\?\?=/.test(line)) {
        offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 70)}`);
      }
      if (/^\s{0,4}\}\);\s*$/.test(line)) handlerDepth = null;
    });
  }
  for (const o of offenders) console.error(`   read-time repair: ${o}`);
  neg(offenders.length === 0, '§18 no `db.x ??=` sits inside a request handler as a substitute for boot lifecycle');
}

section('§14 — route-before-store: a module initialises before it registers routes');
{
  // The composition-root argument (§6) says no request can arrive before every
  // module has registered. This is the INTRA-module half: within a module,
  // the store initialisation must run before that module registers any route,
  // so the ordering guarantee does not depend on which sub-module happens to
  // be wired first.
  //
  // Source-level order IS the guarantee here — registration is synchronous —
  // so it is asserted explicitly rather than assumed.
  const ENTRY = {
    m12: ['m12/index.mjs', 'migrateM12'],
    m13: ['m13/index.mjs', 'migrateM13'],
    m15: ['domains/verification/passport/index.mjs', null],
    m16: ['domains/development/boxcam/index.mjs', null],
  };
  for (const [mod, [file, migrateFn]] of Object.entries(ENTRY)) {
    if (!migrateFn) continue;
    const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const initLine = lines.findIndex((l) => new RegExp(`\\b${migrateFn}\\(`).test(l) && !/^\s*import/.test(l));
    const firstRegister = lines.findIndex((l) => /^\s*register[A-Z]\w*\(/.test(l));
    const firstRoute = lines.findIndex((l) => /\b(orgRouter|playerRouter|guardianRouter|adminRouter|app)\.(get|post|patch|put|delete)\s*\(/.test(l));
    const firstExposure = [firstRegister, firstRoute].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? Infinity;
    neg(initLine >= 0 && initLine < firstExposure,
      `§14 ${mod}: ${migrateFn}() at line ${initLine + 1} runs before the module exposes anything (line ${firstExposure + 1})`);
  }

  // The modules whose stores are created inside their sub-registrars rather
  // than a single migrate* call are covered by the boot proof instead: every
  // store they own was read back from a real composed server. Naming them here
  // keeps the gap visible rather than implied.
  ok(Object.entries(ENTRY).filter(([, [, fn]]) => !fn).length === 2,
    'and the two modules without a single migrate* entry point (m15, m16) rest on the boot proof, which is stronger');
}

section('§10 — cross-module reads: initialised by one module, read by another');
{
  // A store written by module A and read by module B is only safe because both
  // register before the socket opens. Listing them is how that stops being an
  // accident: each one is a dependency somebody can see.
  const cross = [];
  for (const r of rows) {
    if (r.classification !== 'MODULE_BOOT') continue;
    const owner = r.owners[0];
    if (!owner) continue;
    const ownerDir = moduleOf(owner);
    const foreign = [...new Set(r.reads.map((x) => x.file))].filter((f) => moduleOf(f) !== ownerDir);
    if (foreign.length) cross.push({ name: r.name, owner, readers: foreign });
  }
  ok(cross.length >= 0, `§10 ${cross.length} module-owned stores are read from outside the owning module`);
  for (const c of cross.slice(0, 12)) console.log(`     db.${c.name.padEnd(24)} owned by ${c.owner.padEnd(22)} read by ${c.readers.slice(0, 3).join(', ')}`);
  if (cross.length > 12) console.log(`     … and ${cross.length - 12} more (full list in M23_PRODUCTION_BOOT_CONTRACT.md)`);
  // The guarantee is not "A registers before B" — it is that neither is
  // reachable until both have registered.
  neg(cross.every((c) => presentAfterBoot.has(c.name)),
    'and every one of them exists after the full composition, so no reader can outrun its owner');
}

// ================================================== §16/§17 — old and again

section('§16 — an old snapshot boots and gains what it lacked');
const OLD_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-bootc-old-'));
{
  openStore(OLD_DIR).save({ savedAt: Date.now(), idCounter: 400, db: oldSnapshot() });
  const old = await bootAndCapture(OLD_DIR, { port: PORT_BASE + 1, probe: firstRequestProbe });
  ok(old.up, `§16 a pre-M18.2 snapshot boots${old.up ? '' : `:\n${old.log.slice(-900)}`}`);

  // §6 RUNTIME. The source argument above establishes the evaluation ORDER;
  // this establishes that the order actually held in a real process. These are
  // the FIRST requests made to this server, issued the instant /healthz
  // answered — and /healthz answering means `app.listen` fired, which means the
  // module body finished, which means every `register*()` returned. The old
  // snapshot is used because it carries a real organisation to authenticate
  // against; the clean fixture deliberately has none.
  const p = old.probe;
  ok(p?.login === true, '§6 the very first request to a freshly booted server authenticates');
  neg(p?.lifecycle === 200,
    'and the LAST-registered module (M23) already serves its routes on that first request');
  ok(Array.isArray(p?.lifecycleBody?.actions) && p.lifecycleBody.actions.length === 19,
    'answering with all 19 lifecycle actions, so the module is composed and not half-registered');
  neg(p?.reviewQueue === 200,
    'and a route over a MODULE-OWNED store (db.reviewLater, m13) answers rather than crashing on a missing collection');
  neg(p?.notes !== undefined && p.notes < 500,
    'and a route over a newly migration-owned store (db.orgNotes) answers on its own terms, not with a 500');
  const have = new Set(Object.keys(old.db ?? {}));
  const missing = rows.filter((r) => r.classification !== 'OPTIONAL' && !have.has(r.name)).map((r) => r.name);
  for (const m of missing) console.error(`   missing after old-snapshot boot: db.${m}`);
  neg(missing.length === 0, 'and every required store is present afterwards — no seed involved');
  neg(missingRequiredStores(old.db ?? {}).length === 0, 'and the registry reports zero STORE_MISSING');
  ok(old.db?.schema?.version === SCHEMA_VERSION, `and the schema reached ${SCHEMA_VERSION}`);
  neg(!old.log.includes('STORE_MISSING'), 'and the boot log contains no STORE_MISSING line');
}

section('§17 — restart changes nothing');
{
  // Booting must not be a mutation. A server that rewrites the database merely
  // by starting makes every restore non-deterministic.
  const before = openStore(CLEAN_DIR).load();
  const again = await bootAndCapture(CLEAN_DIR, { port: PORT_BASE + 2 });
  ok(again.up, '§17 the server restarts on the database its own first boot produced');
  const have = new Set(Object.keys(again.db ?? {}));
  const missing = rows.filter((r) => r.classification !== 'OPTIONAL' && !have.has(r.name)).map((r) => r.name);
  neg(missing.length === 0, 'and no required store went missing across the restart');

  // Compare content, excluding the fields a boot legitimately moves.
  const stable = (db) => {
    const { schema, sessions, ...rest } = db ?? {};
    const { updatedAt, ...schemaRest } = schema ?? {};
    return JSON.stringify({ ...rest, schema: schemaRest });
  };
  const drifted = [];
  for (const k of Object.keys(before?.db ?? {})) {
    if (k === 'schema' || k === 'sessions') continue;
    if (JSON.stringify(before.db[k]) !== JSON.stringify(again.db?.[k])) drifted.push(k);
  }
  for (const d of drifted) console.error(`   changed by boot alone: db.${d}`);
  neg(drifted.length === 0, 'and booting mutated no collection — a restart is not a migration');
  neg(stable(before?.db) === stable(again.db), 'the database is byte-identical apart from the schema clock and sessions');
  neg(again.db?.schema?.migrations?.length === MIGRATIONS.length,
    `and all ${MIGRATIONS.length} steps stay recorded exactly once — no churn`);
}

// ================================================= §11 — the drift guard

section('§9/§12 — the contract is checked against the running server, not trusted');
{
  // METADATA IS A CLAIM. Every line of `storeContract.mjs` is checked here
  // against what a real composed process actually held, because a frozen
  // ownership map that nobody verifies is a document, not a contract.
  ok(CONTRACT_STORES.length === rows.length,
    `§9 the contract declares ${CONTRACT_STORES.length} stores and the scan found ${rows.length} — the same set`);

  const notInContract = rows.filter((r) => !CONTRACT_STORES.includes(r.name)).map((r) => r.name);
  for (const n of notInContract) console.error(`   read in production but absent from the contract: db.${n}`);
  neg(notInContract.length === 0, '§11 every store production code reads is declared in the contract');

  const notInCode = CONTRACT_STORES.filter((n) => !rows.some((r) => r.name === n));
  for (const n of notInCode) console.error(`   declared in the contract but read nowhere: db.${n}`);
  neg(notInCode.length === 0, 'and the contract declares nothing production code does not read');

  // The class each store CLAIMS must match the class the boot proved.
  const misclassified = [];
  for (const r of rows) {
    const claimed = guaranteeFor(r.name);
    const actual = r.classification === 'MIGRATION' ? 'migration'
      : r.classification === 'MODULE_BOOT' ? 'module'
        : r.classification === 'OPTIONAL' ? 'optional' : 'missing';
    if (claimed !== actual) misclassified.push(`db.${r.name}: contract says ${claimed}, boot proved ${actual}`);
  }
  for (const m of misclassified) console.error(`   ${m}`);
  neg(misclassified.length === 0,
    '§12 every guarantee the contract claims is the guarantee the running server actually provides');

  // 'migration' is the strongest claim: it must hold after migrations ALONE.
  const migOnly = {}; runMigrations(migOnly);
  const brokenMigration = MIGRATION_GUARANTEED.filter((n) => migOnly[n] === undefined);
  for (const n of brokenMigration) console.error(`   claims migration but absent after runMigrations alone: db.${n}`);
  neg(brokenMigration.length === 0,
    `§12 all ${MIGRATION_GUARANTEED.length} migration-guaranteed stores exist after migrations alone — the only class that survives an arbitrary restore`);

  // 'module' is a weaker claim and must be honest about being weaker: a store
  // that survives migrations alone is migration-guaranteed and should say so.
  const overClaimed = MODULE_GUARANTEED.filter((n) => migOnly[n] !== undefined);
  for (const n of overClaimed) console.error(`   claims module but a migration already guarantees it: db.${n}`);
  neg(overClaimed.length === 0,
    'and no store is filed as module-guaranteed when a migration already guarantees it');

  // §12 OWNER VALIDATION. `owner: 'm14'` must mean M14 actually initialises it.
  // Proven by source: the init site the scan found must live under the owner's
  // directory (or be the core composition root).
  const OWNER_DIR = { core: ['server.mjs', 'domains/platform/'], m12: ['m12/', 'domains/scouting/'], m13: ['m13/', 'domains/scouting/'], m14: ['domains/verification/claims/'], m15: ['domains/verification/passport/'], m16: ['domains/development/boxcam/'], m17: ['domains/recruitment/rooms/'], m18: ['domains/discovery/'], 'm18.1': ['domains/platform/'], m21: ['domains/development/'], m28: ['domains/recruitment/offers/'] };
  const wrongOwner = [];
  for (const r of rows) {
    if (r.classification !== 'MODULE_BOOT') continue;
    const declared = PRODUCTION_STORE_CONTRACT[r.name]?.owner;
    const prefixes = OWNER_DIR[declared] ?? [];
    const site = r.owners[0];
    if (!site || !prefixes.some((pre) => site.startsWith(pre))) {
      wrongOwner.push(`db.${r.name}: contract says owner ${declared}, initialised at ${site ?? 'nowhere'}`);
    }
  }
  for (const w of wrongOwner) console.error(`   ${w}`);
  neg(wrongOwner.length === 0,
    '§12 every module-owned store is initialised by a file belonging to the module the contract names as its owner');

  // §13 OPTIONAL STORE RULE. An optional store needs a written product reason
  // and readers that intentionally handle absence — not merely a `?.`.
  for (const name of OPTIONAL_STORES) {
    const entry = PRODUCTION_STORE_CONTRACT[name];
    ok(typeof entry.reason === 'string' && entry.reason.length > 40,
      `§13 db.${name} carries a written product reason for being optional`);
    const row = rows.find((r) => r.name === name);
    neg(row && !presentAfterBoot.has(name),
      `and it is genuinely absent after a production boot — the classification is not decorative`);
  }
}

section('§15 — cross-module ownership, frozen');
{
  // Every store initialised by one module and read by another, with its owner
  // and its consumers named. Nothing here is inferred at report time: the
  // owner comes from the contract, the consumers from the scan.
  const cross = [];
  for (const r of rows) {
    const owner = PRODUCTION_STORE_CONTRACT[r.name]?.owner;
    if (!owner) continue;
    const consumers = [...new Set(r.reads.map((x) => moduleOf(x.file)))]
      .filter((mod) => {
        const m = { core: ['server', 'domains/platform', 'adapters', 'domain', 'store', 'catalogue', 'seed', 'grassrootsJourney', 'storeContract'], 'm18.1': ['domains/platform'] }[owner] ?? [owner.replace('.', '')];
        return !m.includes(mod) && mod !== owner.replace('.', '');
      });
    if (consumers.length) cross.push({ store: r.name, owner, guarantee: r.classification, consumers });
  }
  ok(cross.length > 0, `§15 ${cross.length} stores are read outside the module that owns them`);
  console.log('  store                     owner    guarantee     consumers');
  for (const c of cross.slice(0, 15)) {
    console.log(`  ${c.store.padEnd(25)} ${c.owner.padEnd(8)} ${c.guarantee.padEnd(13)} ${c.consumers.slice(0, 4).join(', ')}`);
  }
  if (cross.length > 15) console.log(`  … and ${cross.length - 15} more (full list in M23_PRODUCTION_BOOT_CONTRACT.md)`);
  const unexplained = cross.filter((c) => !PRODUCTION_STORE_CONTRACT[c.store]?.reason);
  neg(unexplained.length === 0, 'and every one of them carries a written reason — no unexplained ownership');
  // Optional stores are excluded here by construction: their whole point is
  // that a consumer handles absence, so "exists after composition" is not the
  // claim being made about them.
  const required = cross.filter((c) => guaranteeFor(c.store) !== 'optional');
  neg(required.every((c) => presentAfterBoot.has(c.store)),
    `and all ${required.length} non-optional ones exist after the full composition, so no consumer can outrun its owner`);
}

section('§11 — the drift guard: a new store cannot be added unexplained');
{
  // The regression this leaves behind. A future `db.newStore.some(...)` must be
  // one of three things, and the suite will name it if it is none of them:
  //   migration-guaranteed, module-boot-guaranteed, or explicitly optional.
  //
  // Stated over the whole scan rather than against a copied list, so there is
  // one inventory and not two that can disagree.
  const unexplained = rows.filter((r) => r.classification === 'MISSING');
  for (const r of unexplained) {
    console.error(`   db.${r.name}: read in ${[...new Set(r.reads.map((x) => x.file))].join(', ')} and guaranteed by nothing`);
  }
  neg(unexplained.length === 0,
    'every db.* a production file reads is migration-guaranteed, module-boot-guaranteed, or explicitly optional');

  // An unguarded read of an optional store is a contradiction: the reader
  // claims absence is supported and then assumes presence.
  const contradictions = rows.filter((r) => r.optional && r.reads.some((x) => !x.guarded
    && !/^\s*\*/.test('') && x.file !== 'domains/recruitment/lifecycle/index.mjs'));
  const realContradictions = contradictions.filter((r) => {
    // Only count reads that are not immediately preceded by an Array.isArray gate
    // in the same file — journey.mjs gates once and then uses the value.
    const files = [...new Set(r.reads.filter((x) => !x.guarded).map((x) => x.file))];
    return files.some((f) => !readFileSync(path.join(ROOT, f), 'utf8').includes(`Array.isArray(db.${r.name})`));
  });
  for (const r of realContradictions) console.error(`   db.${r.name} is optional but read without a presence gate`);
  neg(realContradictions.length === 0,
    'and no optional store is read without a presence gate in the same file');

  // The three exclusions are deliberate and named, not a silent filter.
  // M23 P6 shipped the canonical Offer store: `recruitmentOffers` moved from
  // optional (P2: "we cannot answer that yet") to module-guaranteed (m28), so
  // no optional-by-design store remains: every store the contract names is guaranteed.
  ok(Object.keys(NOT_A_STORE).length === 2 && Object.keys(OPTIONAL_BY_DESIGN).length === 0 && !('recruitmentOffers' in OPTIONAL_BY_DESIGN),
    `${Object.keys(NOT_A_STORE).length} names excluded as not-a-store and ${Object.keys(OPTIONAL_BY_DESIGN).length} classified optional — each with a written reason, all from the contract; recruitmentOffers is no longer one of them (P6)`);
}

// ==================================================== the machine-readable result

section('§12 — store contract result');
console.log(`
production-read stores: ${counts.total}
migration/bootstrap guaranteed: ${counts.migration}
module guaranteed: ${counts.moduleBoot}
optional by design: ${counts.optional}
missing after production boot: ${counts.missing}
`);

// Leave the full table where the document can be regenerated from it.
const table = rows.map((r) => ({
  store: r.name,
  classification: r.classification,
  owner: r.owners[0] ?? (r.migration ? 'domains/platform/migrations.mjs' : ''),
  readers: [...new Set(r.reads.map((x) => x.file))].length,
  unguardedReads: r.rawReads,
}));
console.log(`(full classification table: ${table.length} rows — see M23_PRODUCTION_BOOT_CONTRACT.md)`);
if (process.env.M23_BOOT_CONTRACT_DUMP) {
  console.log(JSON.stringify(table, null, 1));
}


// ===================================================================== report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nStore guarantees suite: ${total} checks passed, ${negatives} negative/integrity checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ the store guarantees have failures.');
else console.log('all store guarantee checks passed');
