// The target schema in docs/architecture/sql/*.sql must stay executable: this
// loads every file, in order, into an in-memory SQLite database with foreign
// keys on, then checks that every FOREIGN KEY names an existing table and that
// the identity section of 01_identity.sql matches migrations 0001–0003 column for
// column (the migrations copy that DDL; the two must not drift).
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_DIR = path.join(ROOT, 'docs', 'architecture', 'sql');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
const docs = new DatabaseSync(':memory:');
docs.exec('PRAGMA foreign_keys = ON;');

for (const f of files) {
  test(`${f} executes`, () => {
    try { docs.exec(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')); } catch (err) { throw new Error(`${f}: ${err.message}`); }
  });
}

const tables = docs.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
// Every table is STRICT: org_users was created non-STRICT by migration 0001 and
// rebuilt STRICT (with the orgs foreign key and json_valid checks) at S3.
test(`the target schema defines ${tables.length} tables, all STRICT`, () => {
  assert.ok(tables.length >= 100, `expected the full model, found ${tables.length}`);
  for (const t of tables) {
    const sql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.match(sql, /STRICT\s*$/i, `${t} is STRICT`);
  }
});
test('every foreign key points at a table the schema defines', () => {
  const missing = [];
  for (const t of tables) {
    for (const fk of docs.prepare(`PRAGMA foreign_key_list(${t})`).all()) {
      if (!tables.includes(fk.table)) missing.push(`${t}.${fk.from} -> ${fk.table}`);
    }
  }
  assert.deepEqual(missing, []);
});
test('every table has a primary key', () => {
  const without = tables.filter((t) => !docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.pk > 0));
  assert.deepEqual(without, []);
});
test('every index references an existing table', () => {
  const bad = docs.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().filter((i) => !tables.includes(i.tbl_name));
  assert.deepEqual(bad, []);
});

// The migrations that implement steps S0–S2 must match the documented DDL.
// They are applied by the real runner (which owns `meta` and `data_migrations`),
// exactly as a boot applies them, so a migration that needs the runner's
// bookkeeping tables is exercised the way it runs in production.
test('migrations 0001–0003 match the identity section of 01_identity.sql column for column', () => {
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { log: () => {} });
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
  for (const t of ['orgs', 'guardians', 'players', 'guardian_children', 'sessions', 'org_users']) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(mig), cols(docs), `${t} columns`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx(mig), idx(docs), `${t} indexes`);
  }
});

// The intended S4a live schema (migration 0005, implemented but NOT registered)
// is the documented identity DDL plus exactly one transitional column,
// `facets_json`, on players and guardians — and the registered migrations still
// leave the three tables as the S1 shadow (no facets_json). Both facts are
// asserted so the documents, the registered state and the unregistered
// migration cannot drift apart silently.
test('migration 0005 (unregistered) matches the identity section of 01_identity.sql plus exactly facets_json on players and guardians; the registered migrations leave the S1 shadow', async () => {
  const m0005 = await import('../repositories/migrations/0005_core_identity_live.mjs');
  assert.equal(DATA_MIGRATIONS.includes(m0005), false, 'not registered');
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { log: () => {} });
  for (const t of ['players', 'guardians']) assert.equal(mig.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json'), false, `${t}: the registered state is the S1 shadow`);
  runDataMigrations(mig, [...DATA_MIGRATIONS, m0005], { now: Date.UTC(2026, 9, 11, 12), log: () => {} });
  for (const t of ['guardians', 'players', 'guardian_children']) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    const extra = cols(mig).filter((c) => !cols(docs).includes(c));
    assert.deepEqual(extra, t === 'guardian_children' ? [] : ['facets_json:TEXT:0:0:'], `${t}: the only column the live definition adds`);
    assert.deepEqual(cols(docs).filter((c) => !cols(mig).includes(c)), [], `${t}: every documented column is present`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx(mig), idx(docs), `${t} indexes`);
  }
  // The documents say so: the status header names the unregistered migration.
  const header = fs.readFileSync(path.join(SQL_DIR, '01_identity.sql'), 'utf8').split('\n').slice(0, 20).join('\n');
  assert.match(header, /Migration 0005[\s\S]{0,240}?implemented[\s\S]{0,120}?NOT registered/, 'the status header of 01_identity.sql states that 0005 is implemented but not registered');
});

console.log(`\n${passed} schema-DDL checks passed (${files.length} files, ${tables.length} tables)`);
