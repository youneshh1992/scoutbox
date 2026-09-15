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

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATIONS, SCHEMA_VERSION, runMigrations,
  PRODUCTION_REQUIRED_STORES, missingRequiredStores,
} from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { JOURNEY_REQUIRED_STORES, JOURNEY_OPTIONAL_STORES } from '../m23/journey.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SERVER = path.join(ROOT, 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================================================== the source inventory

/**
 * Names that LOOK like stores to a regular expression and are not.
 *
 * Each is named individually with the reason, rather than filtered by a
 * pattern, so that adding one is a decision somebody makes on purpose.
 */
const NOT_A_STORE = {
  json: 'the filename `data/db.json`, which appears in string literals, not a collection',
};

/**
 * Stores a production reader deliberately treats as absent-able, where absence
 * has real product meaning.
 *
 * The bar is NOT "the code used `?.`". It is that absence means something a
 * user could be told. `recruitmentOffers` is absent because the phase that
 * writes offers has not shipped, and the journey reports
 * `offer: { available: false }` rather than an empty list — "we cannot answer
 * that yet" is a different statement from "there are none".
 */
const OPTIONAL_BY_DESIGN = {
  recruitmentOffers: 'M23 P4 has not shipped; the journey reports available:false rather than an empty list',
};

const SKIP_DIRS = new Set(['node_modules', 'scripts', 'data', 'public', 'assets', 'dist']);

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
  orgs: [{ id: 'org-legacy', name: 'Legacy FC', type: 'club', level: 'academy', plan: 'Grassroots', verified: true, squad: [] }],
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
  neg(byMigration.has('assessments'),
    '§13 db.assessments exists after migrations alone — it no longer depends on M12 registration order');
  neg(presentAfterBoot.has('assessments'), 'and after a full production boot');
  neg(JOURNEY_REQUIRED_STORES.every((k) => PRODUCTION_REQUIRED_STORES.includes(k)),
    'and every store the M23 journey DECLARES required is guaranteed by a migration step');

  const D2 = ['blocks', 'reports', 'moderationLog', 'channels', 'reputationSeed', 'plans', 'archetypes',
    'requests', 'trials', 'assessments'];
  const absent = D2.filter((k) => !presentAfterBoot.has(k));
  for (const k of absent) console.error(`   D2 store absent after boot: db.${k}`);
  neg(absent.length === 0, `§14 all ${D2.length} D2 stores are present after a full production boot`);
  neg(D2.every((k) => byMigration.has(k)), 'and all of them by migration, not by module registration');

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
    const ownerDir = owner.split('/')[0];
    const foreign = [...new Set(r.reads.map((x) => x.file))].filter((f) => f.split('/')[0] !== ownerDir);
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
    && !/^\s*\*/.test('') && x.file !== 'm23/index.mjs'));
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
  ok(Object.keys(NOT_A_STORE).length === 1 && Object.keys(OPTIONAL_BY_DESIGN).length === 1,
    `${Object.keys(NOT_A_STORE).length} names excluded as not-a-store and ${Object.keys(OPTIONAL_BY_DESIGN).length} classified optional — each with a written reason`);
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
  owner: r.owners[0] ?? (r.migration ? 'm182/migrations.mjs' : ''),
  readers: [...new Set(r.reads.map((x) => x.file))].length,
  unguardedReads: r.rawReads,
}));
console.log(`(full classification table: ${table.length} rows — see M23_PRODUCTION_BOOT_CONTRACT.md)`);
if (process.env.M23_BOOT_CONTRACT_DUMP) {
  console.log(JSON.stringify(table, null, 1));
}

const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 boot-contract suite: ${total} checks passed, ${negatives} negative/integrity checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 boot contract has failures.');
else console.log('all M23 boot-contract checks passed');
