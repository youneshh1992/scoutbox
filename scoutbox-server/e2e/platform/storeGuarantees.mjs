// The store guarantees: what a ScoutBox database is, and that a server answers on any database this build can create.
//
// Every domain lives in its own tables: the table migrations create every table before any module registers, and a
// boot on a database that holds nothing but one organisation must answer its first requests. This battery checks:
//
//   part 1  the file — what a first boot on an empty directory creates (the table migrations, the counter, no blob),
//           a server that refuses to start without its id counter, and the catalogue plans;
//   part 2  the server — composition order (every module registers before the socket opens), the first requests on
//           a bare database, and a restart that changes nothing.
//
// The archetype count and every lifecycle state projecting as itself are checked in scripts/rules/platform/storeGuarantees.mjs.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture, writeFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

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

const dirs = [];
const tempDir = (label) => {
  const d = mkdtempSync(path.join(tmpdir(), `sbx-guarantees-${label}-`));
  dirs.push(d);
  return d;
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
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(tempDir('schema'));
  try {
    return R.rows('data_migrations').map((r) => r.id);
  } finally {
    R.close();
  }
})();
const LATEST = Number(MIGRATIONS.at(-1).slice(0, 4));

/** One organisation and one player: a database, not a demo. */
const LEGACY_ORG = {
  id: 'org-legacy',
  name: 'Legacy FC',
  type: 'club',
  level: 'academy',
  plan: 'Grassroots',
  verified: 1,
  created_at: Date.UTC(2026, 0, 5),
};
const LEGACY_PLAYER = {
  id: 'pl-legacy',
  name: 'Legacy Player',
  birth_date: '2000-05-05',
  country: 'GB',
  city: 'London',
  availability: 'not_seeking',
  contract_status: 'unknown',
  level: 'amateur',
  medical_condition_status: 'unknown',
  profile_signal: 30,
};

/** Boot the real server on a directory, optionally probe it, then stop it with SIGTERM. */
async function bootOnce(dataDir, { port, probe = null } = {}) {
  const base = `http://localhost:${port}`;
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SCOUTBOX_QUIET_LOGS: '1', SCOUTBOX_SEED_DEMO: '0' },
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
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, exited: proc.exitCode, log };
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) {
    proc.kill('SIGKILL');
    return { up: false, log };
  }
  const probeResult = probe ? await probe(base) : null;
  const health = await (await fetch(`${base}/healthz`)).json();
  const header = (await fetch(`${base}/healthz`)).headers.get('x-scoutbox-schema');
  const caps = await (await fetch(`${base}/capabilities`)).json();
  const meta = await (await fetch(`${base}/meta`)).json();
  proc.kill('SIGTERM');
  for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
  return { up: true, log, probe: probeResult, health, header, caps, meta };
}

/**
 * The FIRST requests to a freshly booted server, issued the instant /healthz answers: /healthz answering means
 * `app.listen` fired, so every `register*()` returned. It asks a late-registered module (the recruitment lifecycle, `registerLifecycle`) for its vocabulary,
 * asks routes over tables owned by three different repositories to answer, and asks the last module registered.
 */
const firstRequestProbe = async (base) => {
  const login = await (
    await fetch(`${base}/auth/org/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-legacy', scoutName: 'Boot Prober', role: 'Head of Recruitment' }),
    })
  )
    .json()
    .catch(() => null);
  if (!login?.token) return { login: false };
  const H = { Authorization: `Bearer ${login.token}` };
  const lifecycle = await fetch(`${base}/org/recruitment/lifecycle`, { headers: H });
  const reviewQueue = await fetch(`${base}/org/review-queue`, { headers: H });
  const notes = await fetch(`${base}/org/players/pl-none/notes`, { headers: H });
  // The data-rights routes are the last module the composition root registers.
  const exportRoute = await fetch(`${base}/player/export`);
  return {
    exportRoute: exportRoute.status,
    login: true,
    lifecycle: lifecycle.status,
    lifecycleBody: await lifecycle.json().catch(() => null),
    reviewQueue: reviewQueue.status,
    notes: notes.status,
  };
};

const tableContent = (dir) => {
  const R = readRows(dir);
  try {
    const { sessions, counters, ...tables } = R.all(); // a login writes a session and mints ids
    return { json: JSON.stringify(tables), counter: Number(R.row('counters', { name: 'id' }).value) };
  } finally {
    R.close();
  }
};

const BARE_DIR = tempDir('bare');
writeFixture(BARE_DIR, { rows: { orgs: [LEGACY_ORG], players: [LEGACY_PLAYER] } }, { idCounter: 400 });

// ===================================================================== part 1

const PORT_BASE = await freePort();

section('§1 — a new database file: every table migration, no blob');
const EMPTY_DIR = tempDir('fresh');
const created = await bootOnce(EMPTY_DIR, { port: await freePort() });
{
  ok(created.up, `the server boots on an empty directory${created.up ? '' : `:\n${created.log.slice(-900)}`}`);
  const R = readRows(EMPTY_DIR);
  const tables = R.tables();
  neg(!tables.includes('collections'), 'there is no `collections` table: the blob store is retired');
  const applied = R.rows('data_migrations').map((r) => r.id);
  ok(applied.join() === MIGRATIONS.join(), `all ${MIGRATIONS.length} table migrations are recorded, once each`);
  ok(LATEST >= 39, `the schema version is the latest migration's number (${LATEST})`);
  const counter = R.row('counters', { name: 'id' })?.value;
  ok(Number(counter) >= 1000, `the id counter is a row of counters, starting at the floor (${counter})`);
  neg(R.count('meta', { key: ['idCounter', 'savedAt', 'saveSeq'] }) === 0, 'and meta carries no snapshot bookkeeping');
  ok(
    ['blocks', 'assessments', 'reputation_seed'].every((t) => tables.includes(t)),
    'the safeguarding blocks, the assessments and the demo reputation rows are tables',
  );
  R.close();
}

section('§2 — the records are table rows and the id counter is a row of counters');
{
  const dir = tempDir('save');
  writeFixture(dir, { rows: { orgs: [LEGACY_ORG] } }, { idCounter: 4200 });
  const R = readRows(dir);
  ok(
    R.row('counters', { name: 'id' }).value === 4200 && R.count('orgs') === 1,
    'the organisation is a row and the id counter is written to counters',
  );
  R.close();
  const F = openFixture(dir);
  F.sql.prepare("DELETE FROM counters WHERE name = 'id'").run();
  F.close();
  const without = await bootOnce(dir, { port: await freePort() });
  neg(
    !without.up && without.exited != null && without.exited !== 0,
    'without its counter row the server refuses to start rather than mint ids it could not store',
  );
}

section('§3 — the plans are constants and cannot be emptied');
{
  const plans = created.meta?.plans ?? {};
  ok(
    plans.Grassroots?.attributionWindowMonths === 12,
    'a Grassroots organisation keeps its 12-month attribution window',
  );
  neg(
    plans.Grassroots?.attributionWindowMonths !== 18,
    'it is NOT 18 — no plan lookup falls through to a default and silently changes billing',
  );
  // The plans an organisation can be on are the ones its table's CHECK allows.
  const R = readRows(EMPTY_DIR);
  const orgsSql = R.sql.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orgs'").get().sql;
  R.close();
  const allowed = [...(orgsSql.match(/CHECK \(plan IN \(([^)]*)\)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1],
  );
  ok(
    Object.keys(plans).length === 4 && allowed.length > 0 && allowed.every((p) => plans[p]),
    'all 4 plans are present, and every plan an organisation can be on has its catalogue entry',
  );
}

// ===================================================================== part 2

section('§7 — a bare database: the first requests answer');
const first = await bootOnce(BARE_DIR, { port: PORT_BASE, probe: firstRequestProbe });
{
  ok(
    first.up,
    `the server boots on a database holding one organisation and one player${first.up ? '' : `:\n${first.log.slice(-900)}`}`,
  );
  const p = first.probe;
  ok(p?.login === true, 'the very first request to a freshly booted server authenticates');
  neg(p?.lifecycle === 200, 'and the lifecycle, registered late, already serves its routes on that first request');
  ok(
    Array.isArray(p?.lifecycleBody?.actions) && p.lifecycleBody.actions.length === 19,
    'answering with all 19 lifecycle actions, so the module is composed and not half-registered',
  );
  neg(p?.reviewQueue === 200, 'and a route over the review-later deferrals answers on the first request');
  neg(
    p?.exportRoute === 401,
    `and the last module registered (data rights) answers too: an anonymous export is a 401, not a missing route (${p?.exportRoute})`,
  );
  neg(
    p?.notes !== undefined && p.notes < 500,
    'and a route over the club notes answers on its own terms, not with a 500',
  );
  ok(
    first.health?.schemaVersion === LATEST && first.header === String(LATEST),
    `/healthz and X-ScoutBox-Schema state schema ${LATEST}`,
  );
  ok(
    first.caps?.schema?.upToDate === true && first.caps.schema.migrationsApplied === MIGRATIONS.length,
    'and /capabilities reports every table migration applied',
  );
  neg(
    first.caps?.integrity?.ok === true && !('stores' in (first.caps?.integrity ?? {})),
    'integrity is clean, and there is no store inventory left to report',
  );
  const R = readRows(BARE_DIR);
  neg(!R.tables().includes('collections'), 'and the file the server wrote has no blob table');
  R.close();
}

section('§8 — a restart changes nothing');
{
  // Booting must not be a mutation: a server that rewrites the database merely by starting makes every restore
  // non-deterministic.
  const before = tableContent(BARE_DIR);
  const again = await bootOnce(BARE_DIR, { port: await freePort() });
  ok(again.up, 'the server restarts on the database its own first boot produced');
  const after = tableContent(BARE_DIR);
  neg(after.json === before.json, 'and booting changed no table (sessions and the counter aside)');
  neg(after.counter >= before.counter, `and the id counter never goes back (${before.counter} → ${after.counter})`);
  neg(
    again.caps?.schema?.migrationsApplied === MIGRATIONS.length,
    `all ${MIGRATIONS.length} migrations stay recorded exactly once — no churn`,
  );
}

// ===================================================================== report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nStore guarantees suite: ${total} checks passed, ${negatives} negative/integrity checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ the store guarantees have failures.');
else console.log('all store guarantee checks passed');
process.exit(process.exitCode ?? 0);
