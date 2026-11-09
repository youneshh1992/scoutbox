// The store guarantees: what a ScoutBox database is, and that a server answers on any database this build can create.
//
// Since S14a every domain lives in its own tables and the blob store is retired: there is no `collections` table, no
// `db.schema` record and no list of in-memory containers to guarantee. What used to be "every collection production
// code reads exists after boot" (M23-D2) is now a property of the schema: the table migrations create every table
// before any module registers, and a boot on a database that holds nothing but one organisation must answer its
// first requests. This battery checks:
//
//   part 1  the file — the table migrations, the counter, no blob, the catalogue constants, and every lifecycle
//           state projecting as itself;
//   part 2  the server — composition order (every module registers before the socket opens), the first requests on
//           a bare database, and a restart that changes nothing.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANS, ARCHETYPES } from '../../catalogue.mjs';
import { ORG_PLANS } from '../../repositories/orgs.mjs';
import { DatabaseSync } from 'node:sqlite';
import { openLayer, writeFixture } from '../../scripts/dataLayerFixture.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { createIdCounter } from '../../repositories/counters.mjs';
import { ROOM_STATUSES, ROOM_STATUS_LABELS, TERMINAL_ROOM_STATUSES, stageForRoomStatus } from '../../domains/recruitment/rooms/shared.mjs';
import { NULL_EVIDENCE_PROVIDER } from '../../domains/recruitment/lifecycle/lifecycle.mjs';
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

const dirs = [];
const tempDir = (label) => { const d = mkdtempSync(path.join(tmpdir(), `sbx-guarantees-${label}-`)); dirs.push(d); return d; };
const children = [];
process.on('exit', () => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const LATEST = Number(DATA_MIGRATIONS.map((m) => m.id).sort().at(-1).slice(0, 4));
const tableNames = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);

/** One organisation and one player: a database, not a demo. */
const LEGACY_ORG = { id: 'org-legacy', name: 'Legacy FC', type: 'club', level: 'academy', plan: 'Grassroots', verified: true };
const LEGACY_PLAYER = { id: 'pl-legacy', name: 'Legacy Player', dob: '2000-05-05', country: 'GB', city: 'London' };

// ===================================================================== part 1

section('§1 — a new database file: every table migration, no blob');
{
  const dir = tempDir('fresh');
  const store = openLayer(dir); // server mode migrates the file as it opens it, exactly as a boot would
  const tables = tableNames(store.sqlite);
  neg(!tables.includes('collections'), 'there is no `collections` table: the blob store is retired (S14a)');
  const applied = store.sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id);
  ok(applied.length === DATA_MIGRATIONS.length && applied.join() === DATA_MIGRATIONS.map((m) => m.id).sort().join(), `all ${DATA_MIGRATIONS.length} table migrations are recorded, once each`);
  ok(LATEST === 39 || LATEST > 39, `the schema version is the latest migration's number (${LATEST})`);
  const counter = store.sqlite.prepare("SELECT value FROM counters WHERE name = 'id'").get()?.value;
  ok(Number(counter) >= 1000, `the id counter is a row of counters, starting at the floor (${counter})`);
  neg(!store.sqlite.prepare("SELECT 1 FROM meta WHERE key IN ('idCounter', 'savedAt', 'saveSeq')").get(), 'and meta carries no snapshot bookkeeping');
  store.sqlite.close();
}

section('§2 — the records are table rows and the id counter is a row of counters');
{
  const dir = tempDir('save');
  writeFixture(dir, { orgs: [LEGACY_ORG], players: [], guardians: [] }, { idCounter: 4200 });
  const store = openLayer(dir);
  ok(store.sqlite.prepare("SELECT value FROM counters WHERE name = 'id'").get().value === 4200 && store.sqlite.prepare('SELECT COUNT(*) AS n FROM orgs').get().n === 1, 'the organisation is a row and the id counter is written to counters');
  store.sqlite.prepare("DELETE FROM counters WHERE name = 'id'").run();
  let missing = null;
  try { createIdCounter({ sqlite: store.sqlite }); } catch (err) { missing = err; }
  neg(/COUNTER_MISSING/.test(missing?.message ?? ''), 'without its counter row the server refuses to mint ids it could not store');
  ok(TABLE_BACKED.includes('blocks') && TABLE_BACKED.includes('assessments') && TABLE_BACKED.includes('reputationSeed'), 'the safeguarding blocks, the assessments and the demo reputation rows are tables');
  store.sqlite.close();
}

section('§3 — the plans and archetypes are constants and cannot be emptied');
{
  ok(PLANS.Grassroots?.attributionWindowMonths === 12, 'a Grassroots organisation keeps its 12-month attribution window');
  neg(PLANS.Grassroots?.attributionWindowMonths !== 18, 'it is NOT 18 — no plan lookup falls through to a default and silently changes billing');
  ok(Object.keys(PLANS).length === 4 && ORG_PLANS.every((p) => PLANS[p]), 'all 4 plans are present, and every plan an organisation can be on has its catalogue entry');
  ok(ARCHETYPES.length === 5, 'the archetypes are the 5 catalogue entries');
}

section('§4 — every lifecycle state projects as itself');
{
  // A state that cannot be read back is a state a club can be trapped in. Driven off ROOM_STATUSES, so a new state is
  // covered the day it is added.
  const db = {
    recruitmentCases: ROOM_STATUSES.map((st, i) => ({
      id: `case-${st}`, orgId: 'org-legacy', playerId: 'pl-legacy',
      stage: stageForRoomStatus(st, 'academy'), createdAt: 1000 + i,
      room: { status: st, rev: 1, priority: 'normal' },
      history: [{ action: 'room_created', at: 1000 + i, detail: { status: st } }],
    })),
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [],
  };
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
  ok(projected === ROOM_STATUSES.length, `all ${ROOM_STATUSES.length} lifecycle states project with their own status, label and terminality`);
  neg(problems.length === 0, 'and none of them is silently rewritten to a neighbouring state');

  // A signed case with two real history entries: projected as signed, nothing invented.
  const signed = {
    recruitmentCases: [{
      id: 'old-signed', orgId: 'org-legacy', playerId: 'pl-legacy', stage: 'review', createdAt: 1000,
      room: { status: 'signed', rev: 2 },
      history: [
        { action: 'room_created', at: 1000, detail: { status: 'watching' } },
        { action: 'room_status_changed', at: 1100, detail: { from: 'watching', to: 'signed' } },
      ],
    }],
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [], recruitmentContacts: [],
  };
  const out = buildRecruitmentJourney(signed, 'old-signed', { kind: 'org_staff', orgId: 'org-legacy', role: 'room_lead' }, { now: 3000, evidence: NULL_EVIDENCE_PROVIDER });
  ok(out.ok === true && out.lifecycle?.currentStage === 'signed', 'a signed case projects through the journey as signed');
  neg(out.outcome?.signing === null, 'with no signing invented to justify the status it was already in');
  ok(out.history?.entries.length === 2, 'and its two real history entries, neither more nor fewer');
}

// ===================================================================== part 2

section('§5 — every module registers before the socket opens');
{
  // `server.mjs` is one synchronous module body: every `register*()` call runs during evaluation and `app.listen` is
  // the last statement, so no request can arrive before every module has registered. Asserted against the source,
  // because it is a claim about evaluation order that a runtime probe cannot disprove by itself.
  const lines = readFileSync(SERVER, 'utf8').split('\n');
  const registerLines = [];
  lines.forEach((l, i) => { if (/^\s*(const \w+ = )?register[A-Z]\w*\(/.test(l)) registerLines.push(i + 1); });
  const listenLine = lines.findIndex((l) => /^app\.listen\(/.test(l)) + 1;
  ok(registerLines.length >= 10, `${registerLines.length} module registrations found in the composition root`);
  ok(listenLine > 0, 'and app.listen is a top-level statement');
  neg(registerLines.every((n) => n < listenLine), `every registration (lines ${Math.min(...registerLines)}–${Math.max(...registerLines)}) precedes app.listen (line ${listenLine})`);
  const between = lines.slice(Math.min(...registerLines) - 1, listenLine);
  const awaits = between.filter((l) => /^\s*(const|let|var)?\s*[\w{}[\], ]*=?\s*await\s/.test(l) && !/^\s*\/\//.test(l));
  for (const a of awaits) console.error(`   top-level await between registration and listen: ${a.trim().slice(0, 80)}`);
  neg(awaits.length === 0, 'and nothing between them awaits, so composition cannot yield to the event loop half-finished');
}

section('§6 — no production code creates or repairs a collection in memory');
{
  // The retired pattern: `db.x ??= []` at registration or inside a handler, which hid a missing store from every
  // boot-time check. Every domain is a table now, created by its migration; none may come back.
  const SKIP = new Set(['node_modules', 'scripts', 'e2e', 'data', 'public', 'assets', 'dist']);
  const offenders = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/(^|[^:])\/\/.*$/, '$1');
        if (/\bdb\.[A-Za-z0-9_]+\s*\?\?=/.test(code) || /\bdb\[[^\]]+\]\s*\?\?=/.test(code)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
      });
    }
  }(ROOT));
  for (const o of offenders) console.error(`   in-memory collection default: ${o}`);
  neg(offenders.length === 0, 'no `db.x ??=` line anywhere in production code');
}

/** Boot the real server on a directory, optionally probe it, then stop it with SIGTERM. */
async function bootOnce(dataDir, { port, probe = null } = {}) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', SCOUTBOX_SEED_DEMO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; });
  proc.stderr.on('data', (b) => { log += b; });
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log };
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) { proc.kill('SIGKILL'); return { up: false, log }; }
  const probeResult = probe ? await probe(base) : null;
  const health = await (await fetch(`${base}/healthz`)).json();
  const header = (await fetch(`${base}/healthz`)).headers.get('x-scoutbox-schema');
  const caps = await (await fetch(`${base}/capabilities`)).json();
  proc.kill('SIGTERM');
  for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
  return { up: true, log, probe: probeResult, health, header, caps };
}

/**
 * The FIRST requests to a freshly booted server, issued the instant /healthz answers: /healthz answering means
 * `app.listen` fired, so every `register*()` returned. It asks the last-registered module (M23) for its vocabulary
 * and asks routes over tables owned by three different repositories to answer.
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
  return { login: true, lifecycle: lifecycle.status, lifecycleBody: await lifecycle.json().catch(() => null), reviewQueue: reviewQueue.status, notes: notes.status };
};

const readOnly = (dir) => new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
const tableContent = (dir) => {
  const sqlite = readOnly(dir);
  try {
    const out = {};
    for (const t of tableNames(sqlite).sort()) {
      if (t === 'sessions' || t === 'counters') continue; // a login writes a session and mints ids
      out[t] = sqlite.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all().map((r) => ({ ...r }));
    }
    return { json: JSON.stringify(out), counter: Number(sqlite.prepare("SELECT value FROM counters WHERE name = 'id'").get().value) };
  } finally { sqlite.close(); }
};

const PORT_BASE = 5200 + Math.floor(Math.random() * 300);
const BARE_DIR = tempDir('bare');
writeFixture(BARE_DIR, { orgs: [LEGACY_ORG], players: [LEGACY_PLAYER], guardians: [] }, { idCounter: 400 });

section('§7 — a bare database: the first requests answer');
const first = await bootOnce(BARE_DIR, { port: PORT_BASE, probe: firstRequestProbe });
{
  ok(first.up, `the server boots on a database holding one organisation and one player${first.up ? '' : `:\n${first.log.slice(-900)}`}`);
  const p = first.probe;
  ok(p?.login === true, 'the very first request to a freshly booted server authenticates');
  neg(p?.lifecycle === 200, 'and the LAST-registered module (M23) already serves its routes on that first request');
  ok(Array.isArray(p?.lifecycleBody?.actions) && p.lifecycleBody.actions.length === 19, 'answering with all 19 lifecycle actions, so the module is composed and not half-registered');
  neg(p?.reviewQueue === 200, 'and a route over the review-later deferrals answers on the first request');
  neg(p?.notes !== undefined && p.notes < 500, 'and a route over the club notes answers on its own terms, not with a 500');
  ok(first.health?.schemaVersion === LATEST && first.header === String(LATEST), `/healthz and X-ScoutBox-Schema state schema ${LATEST}`);
  ok(first.caps?.schema?.upToDate === true && first.caps.schema.migrationsApplied === DATA_MIGRATIONS.length, 'and /capabilities reports every table migration applied');
  neg(first.caps?.integrity?.ok === true && !('stores' in (first.caps?.integrity ?? {})), 'integrity is clean, and there is no store inventory left to report');
  const s = readOnly(BARE_DIR);
  neg(!tableNames(s).includes('collections'), 'and the file the server wrote has no blob table');
  s.close();
}

section('§8 — a restart changes nothing');
{
  // Booting must not be a mutation: a server that rewrites the database merely by starting makes every restore
  // non-deterministic.
  const before = tableContent(BARE_DIR);
  const again = await bootOnce(BARE_DIR, { port: PORT_BASE + 1 });
  ok(again.up, 'the server restarts on the database its own first boot produced');
  const after = tableContent(BARE_DIR);
  neg(after.json === before.json, 'and booting changed no table (sessions and the counter aside)');
  neg(after.counter >= before.counter, `and the id counter never goes back (${before.counter} → ${after.counter})`);
  neg(again.caps?.schema?.migrationsApplied === DATA_MIGRATIONS.length, `all ${DATA_MIGRATIONS.length} migrations stay recorded exactly once — no churn`);
}

// ===================================================================== report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nStore guarantees suite: ${total} checks passed, ${negatives} negative/integrity checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ the store guarantees have failures.');
else console.log('all store guarantee checks passed');
process.exit(process.exitCode ?? 0);
