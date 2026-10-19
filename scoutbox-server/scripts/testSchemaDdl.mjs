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
test('the registered migrations 0001–0013 match 01_identity.sql (identity, facets_json and the twelve player sub-record tables included), 08 (media_deletions) and 03 (email_challenges, pairing_codes, notifications, notification_prefs, notification_pref_categories, dispatches, dispatch_attempts, outbox, push_log, push_tokens, channels, messages, message_attachments, and the eight S6b audit tables: blocks, reports, moderation_log, org_notes, ledger, ops_events, source_changes, idv_queue) column for column', () => {
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { now: Date.UTC(2026, 9, 11, 12), log: () => {} });
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit']);
  const AUDIT_TABLES = ['blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue'];
  const S5_TABLES = ['player_season_history', 'player_badges', 'player_drills', 'player_attendance', 'player_timeline', 'player_media', 'player_media_tags', 'player_medical_records', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_programme_completions'];
  for (const t of ['orgs', 'guardians', 'players', 'guardian_children', 'sessions', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', ...AUDIT_TABLES, ...S5_TABLES]) {
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
  // S7b: the dispatch tables; the attempt-shape CHECK is total in the documented DDL too (review of dc4b559, finding 1).
  assert.match(header03, /dispatches\s+→ dispatches, dispatch_attempts[^\n]*0010_dispatches[^\n]*REGISTERED/, 'the scope header of 03 states that the dispatch tables are live since 0010');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_attempts'").get().sql, /ok IS NOT NULL/, 'the documented attempt CHECK rejects a NULL send outcome');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(dispatches)').all(), [], 'the documented dispatches table has no foreign key (option A: an indexed reference, no cascade)');
  // S7c: the outbox and push tables (review of 6ca66ba): the structural source CHECK, a nullable destination, a JSON token column, no uniqueness on tokens, no vocabulary CHECK.
  for (const t of ['outbox', 'push_log', 'push_tokens']) assert.match(header03, new RegExp(`${t}[^\\n]*0011_outbox_push[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0011`);
  const outboxSql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get().sql;
  assert.match(outboxSql, /source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL/, 'the documented outbox CHECK ties each source to its columns');
  assert.equal(docs.prepare("PRAGMA table_info(outbox)").all().find((c) => c.name === 'to_address').notnull, 0, 'the documented destination is nullable');
  const toJson = docs.prepare("PRAGMA table_info(outbox)").all().find((c) => c.name === 'to_json'); assert.ok(toJson && toJson.notnull === 0, 'review of 40aa05c, F2: the documented to_json column exists and is nullable');
  assert.match(outboxSql, /to_json IS NULL OR \(json_valid\(to_json\) AND json_type\(to_json\) NOT IN \('text', 'null'\)\)/, 'to_json holds any JSON value that is not a JSON string or JSON null'); assert.match(outboxSql, /CHECK \(to_address IS NULL OR to_json IS NULL\)/, 'a destination is in one column or null');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'push_tokens'").get().sql, /token_json\s+TEXT NOT NULL CHECK \(json_valid\(token_json\)\)/, 'the documented token column is JSON text');
  assert.equal(docs.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_tokens' AND sql LIKE '%UNIQUE%'").get().n, 0, 'no unique index on the documented tokens');
  for (const t of ['outbox', 'push_log', 'push_tokens']) { assert.doesNotMatch(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /transport IN \(|audience_kind IN \(|ref_kind IN \(|channel IN \(/, `${t}: no vocabulary CHECK`); assert.deepEqual(docs.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing`); }
  // S7d (review §11.5 as corrected by the reviews of 46e5afe and 8330f08; D-A, D-B): the thread tables.
  for (const t of ['channels', 'messages', 'message_attachments']) assert.match(header03, new RegExp(`${t}[^\\n]*0012_channels[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0012`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]), [['org_id', 'orgs', 'RESTRICT']], 'the documented channels table references orgs only: request_id (D-A, the transitional checked reference), player_id (D-B, no lifecycle clause) and guardian_id (the bounded code-validated reference) carry no foreign key');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(messages)').all().map((f) => [f.from, f.table, f.on_delete]), [['channel_id', 'channels', 'CASCADE']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(message_attachments)').all().map((f) => [f.from, f.table, f.on_delete]), [['message_id', 'messages', 'CASCADE']]);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'channels_request_id'").get().sql, /UNIQUE/, 'one thread per request');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'messages_channel_position'").get().sql, /UNIQUE/, 'one message per position in a thread');
  for (const t of ['channels', 'messages']) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'absent_keys_json'), `${t}: the documented absent-keys column (absence preserved as absence)`);
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_attachments'").get().sql, /kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL/, 'the documented attachment CHECK ties each kind to its columns');
  // S6b (plan §D.4 Candidate A as accepted at 1792fc7; Q4, Q4b, Q5): the eight audit tables — no foreign key on any (the five player references tolerant, the organisation/staff references historical pointers, the IDV guardian reference checked in code), no vocabulary CHECK, every literal column nullable, seq order, the three lossless columns, the documented indexes (reports_target_player_id included).
  for (const t of AUDIT_TABLES) {
    assert.match(header03, new RegExp(`${t}[^\\n]*0013_safety_audit[^\\n]*REGISTERED`), `the scope header of 03 states that ${t} is live since 0013`);
    const sql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql;
    assert.deepEqual(docs.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing (Q4: tolerant player references; the organisation and staff ids are historical pointers; Q4b: the guardian check is in code)`);
    assert.doesNotMatch(sql, /\bIN \(/, `${t}: no vocabulary CHECK`);
    const cols = docs.prepare(`PRAGMA table_info(${t})`).all();
    assert.deepEqual(cols.slice(0, 2).map((c) => [c.name, c.type, c.notnull, c.pk]), [['seq', 'INTEGER', 0, 1], ['id', 'TEXT', 1, 0]], `${t}: seq is the order, id the writer's id`);
    for (const c of ['absent_keys_json', 'offtype_json', 'extra_json']) assert.ok(cols.some((x) => x.name === c && x.notnull === 0), `${t}: the lossless column ${c}`);
    for (const c of cols) if (!['id', 'guardian_id'].includes(c.name)) assert.equal(c.notnull, 0, `${t}.${c.name}: every literal column is nullable (absence is absence)`);
    assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?").get(t, 'sqlite_autoindex_' + t + '_1')?.sql ?? 'UNIQUE', /UNIQUE|^$/, `${t}: id is UNIQUE`);
  }
  assert.equal(docs.prepare('PRAGMA table_info(idv_queue)').all().find((c) => c.name === 'guardian_id').notnull, 1, 'idv_queue.guardian_id is NOT NULL (Domain G, strict)');
  assert.equal(docs.prepare('PRAGMA table_info(ledger)').all().some((c) => c.name === 'actor_kind'), false, 'the ledger derives no actor kind: user_id and actor_name are stored verbatim');
  assert.ok(docs.prepare('PRAGMA table_info(moderation_log)').all().some((c) => c.name === 'context_json'), 'the moderation context is kept whole');
  assert.ok(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'reports_target_player_id'").get(), 'the unresolved-player count reads reports by target_player_id');
});

console.log(`\n${passed} schema-DDL checks passed (${files.length} files, ${tables.length} tables)`);
