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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATIONS, SCHEMA_VERSION, runMigrations,
  PRODUCTION_REQUIRED_STORES, missingRequiredStores,
} from '../m182/migrations.mjs';
import { integrityReport } from '../m182/integrity.mjs';
import { PLANS } from '../catalogue.mjs';
import { openStore } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

let passed = 0, negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
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
    orgs: [{ id: 'org-legacy', name: 'Legacy FC', type: 'club', level: 'academy', plan: 'Grassroots', verified: true, squad: [] }],
    guardians: [],
    users: [],
    sessions: [],
    ledger: [],
    notifications: [],
    // No db.schema — this database predates the migration registry.
  };
  if (withExistingRows) {
    db.blocks = [{ id: 'blk-legacy', playerId: 'pl-legacy', orgId: 'org-legacy', by: 'guardian', reason: 'legacy', ts: 1 }];
    db.requests = [{ id: 'req-legacy', playerId: 'pl-legacy', orgId: 'org-legacy', type: 'contact', status: 'pending', createdAt: 1 }];
    db.channels = [{ id: 'ch-legacy', playerId: 'pl-legacy', orgId: 'org-legacy', messages: [] }];
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
    'db.squads is NOT in the list — it never existed; squad membership is org.squad');
}

console.log('\n— §8 — clean boot: empty database, no seed —');
{
  const db = {};
  const r = runMigrations(db);
  ok(r.from === 0 && r.to === SCHEMA_VERSION, `a brand-new database migrates 0 → ${SCHEMA_VERSION}`);
  ok(r.ran.length === MIGRATIONS.length, `all ${MIGRATIONS.length} steps ran`);
  ok(Array.isArray(db.blocks) && db.blocks.length === 0, 'db.blocks exists and is empty');
  ok(Array.isArray(db.requests), 'db.requests exists');
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
  const before = integrityReport(db);
  ok(before.stores.ok === false, 'an un-migrated snapshot reports missing stores');
  ok(before.stores.missing.includes('blocks'), 'db.blocks is named among them');
  neg(db.blocks === undefined, 'and integrityReport did NOT create the collection — it reports, it does not repair');
  neg(before.violations.every((v) => v.code !== 'STORE_MISSING'),
    'a missing store is NOT counted as a data violation — two records disagreeing and a database never built need different answers');

  runMigrations(db);
  const after = integrityReport(db);
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
  const report = integrityReport(db);
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
  neg(db.recruitmentCases !== undefined && db.blocks !== undefined,
    'registration order cannot decide whether core collections exist');
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

  const PORT = 4970 + Math.floor(Math.random() * 120);
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
    for (let i = 0; i < 160; i++) {
      if (proc.exitCode != null) throw new Error(`server exited (${proc.exitCode}):\n${out}`);
      try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return proc; } catch { /* booting */ }
      await sleep(250);
    }
    throw new Error(`server did not come up:\n${out}`);
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
    ok(Array.isArray(body) && body.some((r) => r.id === 'req-legacy'),
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

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23-D2 persistence suite: ${total} checks passed, ${negatives} negative/integrity checks (${ratio}%)`);
