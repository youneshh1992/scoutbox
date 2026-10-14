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

// The registered migrations that implement steps S0–S4a must match the
// documented DDL column for column and index for index. They are applied by
// the real runner (which owns `meta` and `data_migrations`), exactly as a boot
// applies them on a genuinely new database (migration 0005 then finds no saved
// blobs: a first installation, nothing to import), so a migration that needs
// the runner's bookkeeping tables is exercised the way it runs in production.
// players and guardians carry the documented transitional `facets_json`
// column (S4a); media_deletions (0006) is documented in 08; the twelve
// player sub-record tables (0007, S5) are in 01 with their position and
// extra_json columns.
test('the registered migrations 0001–0009 match 01_identity.sql (identity, facets_json and the twelve player sub-record tables included), 08 (media_deletions) and 03 (email_challenges, pairing_codes, notifications, notification_prefs, notification_pref_categories) column for column', () => {
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { now: Date.UTC(2026, 9, 11, 12), log: () => {} });
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications']);
  const S5_TABLES = ['player_season_history', 'player_badges', 'player_drills', 'player_attendance', 'player_timeline', 'player_media', 'player_media_tags', 'player_medical_records', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_programme_completions'];
  for (const t of ['orgs', 'guardians', 'players', 'guardian_children', 'sessions', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', ...S5_TABLES]) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(mig), cols(docs), `${t} columns`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(t).map((r) => r.name);
    assert.deepEqual(idx(mig), idx(docs), `${t} indexes`);
    assert.match(mig.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/i, `${t} is STRICT in the migrations too`);
  }
  for (const t of ['players', 'guardians']) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json'), `${t}: the documented transitional column`);
  // The documents say so: the status header states that 0005 is registered and the projection retired.
  const header = fs.readFileSync(path.join(SQL_DIR, '01_identity.sql'), 'utf8').split('\n').slice(0, 20).join('\n');
  assert.match(header, /migration 0005[\s\S]{0,160}?REGISTERED/, 'the status header of 01_identity.sql states that 0005 is registered');
  assert.match(header, /0007_player_subrecords[\s\S]{0,200}?REGISTERED/, 'the status header of 01_identity.sql states that 0007 is registered');
  assert.doesNotMatch(header, /NOT registered/);
  // S6a: the status of the two one-time-code tables is stated in 03's scope header.
  const header03 = fs.readFileSync(path.join(SQL_DIR, '03_messaging_safety_audit.sql'), 'utf8').split('\n').slice(0, 30).join('\n');
  assert.match(header03, /email_challenges[^\n]*0008_one_time_codes[^\n]*REGISTERED/, 'the scope header of 03 states that email_challenges is live since 0008');
  assert.match(header03, /pairing_codes[^\n]*0008_one_time_codes[^\n]*REGISTERED/, 'the scope header of 03 states that pairing_codes is live since 0008');
  // S7a: the notification tables.
  assert.match(header03, /notifications\s+→ notifications[^\n]*0009_notifications[^\n]*REGISTERED/, 'the scope header of 03 states that notifications is live since 0009');
  assert.match(header03, /notificationPrefs[^\n]*0009_notifications[^\n]*REGISTERED/, 'the scope header of 03 states that the preference tables are live since 0009');
});

console.log(`\n${passed} schema-DDL checks passed (${files.length} files, ${tables.length} tables)`);
