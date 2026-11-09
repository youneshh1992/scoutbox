// Structural rules for the schema the migrations build: every table is STRICT and has a primary key, and every
// foreign key and index names a table that exists. SQLite only notices a key to a missing table when a row is
// written, so this catches it at test time.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
runDataMigrations(db, DATA_MIGRATIONS, { now: Date.UTC(2026, 10, 9, 12), log: () => {} });

const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const names = new Set(tables.map((t) => t.name));

test(`every migration applies (${DATA_MIGRATIONS.length})`, () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
});
// The migration runner creates its own bookkeeping tables; they are not domain tables.
const RUNNER_TABLES = new Set(['data_migrations', 'meta']);
test(`all ${tables.length - RUNNER_TABLES.size} domain tables are STRICT`, () => {
  assert.deepEqual(tables.filter((t) => !RUNNER_TABLES.has(t.name) && !/\bSTRICT\s*$/i.test(t.sql)).map((t) => t.name), []);
});
test('every table has a primary key', () => {
  assert.deepEqual(tables.filter((t) => !db.prepare(`PRAGMA table_info("${t.name}")`).all().some((c) => c.pk > 0)).map((t) => t.name), []);
});
test('every foreign key points at an existing table', () => {
  const missing = [];
  for (const t of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all()) {
      if (!names.has(fk.table)) missing.push(`${t.name}.${fk.from} -> ${fk.table}`);
    }
  }
  assert.deepEqual(missing, []);
});
test('every index belongs to an existing table', () => {
  const bad = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().filter((i) => !names.has(i.tbl_name));
  assert.deepEqual(bad, []);
});

console.log(`\n${passed} passed`);
