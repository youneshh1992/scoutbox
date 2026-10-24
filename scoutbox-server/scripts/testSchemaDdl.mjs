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
test('the registered migrations 0001–0016 match 01_identity.sql (identity, facets_json and the twelve player sub-record tables included), 08 (media_deletions) and 03 (email_challenges, pairing_codes, notifications, notification_prefs, notification_pref_categories, dispatches, dispatch_attempts, outbox, push_log, push_tokens, channels, messages, message_attachments, and the eight S6b audit tables: blocks, reports, moderation_log, org_notes, ledger, ops_events, source_changes, idv_queue) and 02 (the sixteen S8a-core definitions: recruitment_requests, request_trial_slots, trials and its eleven child tables, idempotency_keys; channels rebuilt with the request key; the twenty-five S8b definitions: recruitment_cases and its fifteen owned child tables, the four room tables and their five child tables; the two parents rebuilt with the case key and idempotency_keys with the broadened owner CHECK) column for column', () => {
  const mig = new DatabaseSync(':memory:');
  mig.exec('PRAGMA foreign_keys = ON;');
  runDataMigrations(mig, DATA_MIGRATIONS, { now: Date.UTC(2026, 9, 11, 12), log: () => {} });
  assert.equal(mig.prepare('SELECT COUNT(*) AS n FROM data_migrations').get().n, DATA_MIGRATIONS.length);
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers']);
  const AUDIT_TABLES = ['blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue'];
  const S5_TABLES = ['player_season_history', 'player_badges', 'player_drills', 'player_attendance', 'player_timeline', 'player_media', 'player_media_tags', 'player_medical_records', 'player_drill_results', 'player_activity_log', 'player_external_ids', 'player_programme_completions'];
  const S8A_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
  const S8B_TABLES = ['recruitment_cases', 'case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals', 'room_comments', 'room_comment_mentions', 'room_snapshots', 'room_snapshot_source_refs', 'room_decisions', 'room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids', 'room_evidence_states'];
  const S8C_TABLES = ['recruitment_contacts', 'contact_attempts', 'contact_history', 'recruitment_offers', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts', 'offer_history'];
  for (const t of ['orgs', 'guardians', 'players', 'guardian_children', 'sessions', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', ...AUDIT_TABLES, ...S5_TABLES, ...S8A_TABLES, ...S8B_TABLES, ...S8C_TABLES]) {
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
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']], 'the documented channels table references orgs and, since migration 0015 (S8a-core, D-A converted), recruitment_requests; player_id (D-B, no lifecycle clause) and guardian_id (the bounded code-validated reference) carry no foreign key');
  assert.deepEqual(mig.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']], 'the migrations rebuild channels with the same two keys');
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
  // S8a-core (plan §D.7 as accepted at d0f0205; Q7a, Q7b, Q7c): the sixteen implemented definitions of 02 (and the channels rebuild) — compared with the migration above column for column; here the decisions.
  const header02 = fs.readFileSync(path.join(SQL_DIR, '02_recruitment.sql'), 'utf8').split('\n').slice(0, 80).join('\n');
  assert.match(header02, /0015_recruitment[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0015 is registered');
  for (const t of S8A_TABLES) { const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => f.table); for (const parent of ['players', 'guardians']) assert.ok(!fks.includes(parent), `${t}: no foreign key to ${parent} (Q7a tolerant; Q7c strict in code)`); }
  // S8b (migration 0016, Q7b's conversion): the two parents' case_id is a REAL key now, in the documents and in the migrations alike
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_requests)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['trial_id', 'trials', 'SET NULL'], ['user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(trials)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  for (const t of ['recruitment_requests', 'trials']) assert.deepEqual(mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), docs.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the migrations rebuild the same keys`);
  // S8b (readiness review §2–§3 as accepted at 4d2c74b; Q8a tolerant): the twenty-five definitions — no player or guardian key, no vocabulary CHECK, the lossless columns, the owned-history RESTRICT, the room tables' RESTRICT, the withdrawn one-open-room index, the broadened key CHECK
  assert.match(header02, /0016_recruitment_cases[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0016 is registered');
  // S8c (readiness review §2–§3 as accepted at 19f5ca8; Q8c-a tolerant, Q8c-b strict in code): the nine definitions — no player or guardian key, no vocabulary/length CHECK, the lossless columns, the owned-history RESTRICT, the one new real request key, the withdrawn unique request index, one-live-offer index, unique revision/response/document/receipt keys and SET NULL keys; the five pointers plain
  assert.match(header02, /0017_recruitment_contacts_offers[\s\S]{0,200}?REGISTERED/, 'the status header of 02 states that 0017 is registered');
  for (const t of S8C_TABLES) { const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians', 'room_decisions', 'outbox']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (Q8c-a tolerant; Q8c-b strict in code; decision and outbox ids plain)`); assert.doesNotMatch(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /CHECK \(\w+ IN \(|length\(/, `${t}: no vocabulary or length CHECK`); }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_contacts)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['cancelled_by_user_id', 'org_users', 'RESTRICT'], ['case_id', 'recruitment_cases', 'RESTRICT'], ['created_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['recorded_by_user_id', 'org_users', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT'], ['routing_agent_user_id', 'org_users', 'RESTRICT'], ['sent_by_user_id', 'org_users', 'RESTRICT']], 'the contact keys: the one new real request key, the case, the organisation and the nullable staff keys');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_offers)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['agent_share_user_id', 'org_users', 'RESTRICT'], ['case_id', 'recruitment_cases', 'RESTRICT'], ['created_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT']], 'the offer keys: no current_revision_id key (the pointer rule), no decision key');
  for (const t of ['contact_history', 'offer_history']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.on_delete === 'RESTRICT'), `${t}: the owned history keeps its RESTRICT`); for (const t of ['contact_attempts', 'offer_revisions', 'offer_revision_documents', 'offer_responses', 'offer_read_receipts']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().every((f) => f.on_delete === 'CASCADE'), `${t}: cascades with its owner`);
  assert.equal(docs.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('recruitment_contacts', 'recruitment_offers', 'offer_revisions', 'offer_responses', 'offer_read_receipts', 'offer_revision_documents') AND sql LIKE '%UNIQUE%'").get().n, 0, 'the drafted unique request index, one-live-offer index and unique child keys are withdrawn (review §3)');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(offer_revisions)').all().map((f) => f.from), ['offer_id'], 'the revision pointers (response_id, supersedes, superseded_by, discarded_by) are plain columns under the pointer rule');
  for (const t of ['recruitment_contacts', 'recruitment_offers']) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all(); assert.deepEqual(cols.filter((c) => c.notnull).map((c) => c.name), ['id', 'org_id', 'case_id', 'player_id'], `${t}: NOT NULL on the four identifiers only`); }
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get().sql, /'recruitment_contacts', 'recruitment_offers'\)/, 'the key table\'s owner CHECK names the two S8c parents');
  for (const t of S8C_TABLES.filter((x) => !['recruitment_contacts', 'recruitment_offers'].includes(x))) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'raw_json'), `${t}: a non-object list element is kept in raw_json`);
  for (const t of S8B_TABLES) { const fks = docs.prepare(`PRAGMA foreign_key_list(${t})`).all(); for (const parent of ['players', 'guardians']) assert.ok(!fks.some((f) => f.table === parent), `${t}: no foreign key to ${parent} (Q8a tolerant)`); assert.deepEqual(fks.map((f) => [f.from, f.table, f.on_delete]).sort(), mig.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => [f.from, f.table, f.on_delete]).sort(), `${t}: the same keys in the migration`); const sql = docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql; assert.doesNotMatch(sql, /\b(status|stage|priority|kind|state|outcome|currency|schedule|trigger|room_status) +TEXT[^,]*IN \(/, `${t}: no vocabulary CHECK`); for (const c of ['absent_keys_json', 'offtype_json', 'extra_json']) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c && x.notnull === 0), `${t}: the lossless column ${c}`); }
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(recruitment_cases)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['decision_by_user_id', 'org_users', 'RESTRICT'], ['org_id', 'orgs', 'RESTRICT'], ['owner_user_id', 'org_users', 'RESTRICT'], ['room_lead_scout_user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_history)').all().map((f) => [f.from, f.table, f.on_delete]), [['case_id', 'recruitment_cases', 'RESTRICT']], 'the owned history keeps its RESTRICT (removed explicitly before its owner)');
  for (const t of ['case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.from === 'case_id' && f.table === 'recruitment_cases' && f.on_delete === 'CASCADE'), `${t}: cascades with its owner`);
  for (const t of ['room_comments', 'room_snapshots', 'room_decisions', 'room_evidence_states']) assert.ok(docs.prepare(`PRAGMA foreign_key_list(${t})`).all().some((f) => f.from === 'room_id' && f.table === 'recruitment_cases' && f.on_delete === 'RESTRICT'), `${t}: an independent collection, RESTRICT`);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_request_links)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'CASCADE'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(case_trial_links)').all().map((f) => [f.from, f.table, f.on_delete]).sort(), [['case_id', 'recruitment_cases', 'CASCADE'], ['trial_id', 'trials', 'RESTRICT']]);
  assert.equal(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'recruitment_cases_one_open_room'").get(), undefined, 'the drafted one-open-room index is withdrawn (§3)');
  assert.equal(docs.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('room_decisions', 'room_evidence_states', 'room_comment_mentions', 'room_snapshot_source_refs') AND sql LIKE '%UNIQUE%'").get().n, 0, 'no drafted unique index on the room tables (the uniqueness rules are code rules; duplicates are kept)');
  assert.deepEqual(docs.prepare('PRAGMA foreign_key_list(room_decisions)').all().map((f) => f.from).sort(), ['org_id', 'room_id'], 'the decision chain is plain ids (no self key)');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get().sql, /owner_table IN \('recruitment_requests', 'trials', 'recruitment_cases', 'case_decision_drafts', 'case_transaction_handoffs', 'room_decisions', 'recruitment_contacts', 'recruitment_offers'\)/, 'the broadened owner CHECK');
  assert.equal(docs.prepare('PRAGMA table_info(case_decision_drafts)').all().filter((c) => c.pk > 0).map((c) => c.name).join(','), 'case_id', 'the draft is one row per case (its primary key is the owner)');
  assert.ok(docs.prepare('PRAGMA table_info(room_snapshots)').all().some((c) => c.name === 'note'), 'the snapshot note is stored as written'); assert.ok(docs.prepare('PRAGMA table_info(room_decisions)').all().some((c) => c.name === 'snapshot_source_refs_json') && docs.prepare('PRAGMA table_info(room_decisions)').all().some((c) => c.name === 'snapshot_trust_score'), 'the decision\'s full snapshot copy');
  for (const t of ['case_history']) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'by_kind') && docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'actor_kind'), 'both history literals side by side');
  assert.equal(docs.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'recruitment_requests_one_pending'").get(), undefined, 'the drafted one-pending index is withdrawn (D2)');
  assert.match(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'trials_one_open_per_case'").get().sql, /UNIQUE[\s\S]*WHERE case_id IS NOT NULL AND workflow_state NOT IN \('completed', 'cancelled'\)/, 'one open trial per case is kept (the release-before-arrival write rule)');
  for (const t of ['recruitment_requests', 'trials']) { const cols = docs.prepare(`PRAGMA table_info(${t})`).all(); assert.deepEqual(cols.slice(0, 2).map((c) => [c.name, c.type, c.notnull, c.pk]), [['seq', 'INTEGER', 0, 1], ['id', 'TEXT', 1, 0]], `${t}: seq is the order, id the writer's id`); for (const c of ['absent_keys_json', 'offtype_json', 'extra_json']) assert.ok(cols.some((x) => x.name === c && x.notnull === 0), `${t}: the lossless column ${c}`); assert.doesNotMatch(docs.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /\b(status|type|kind|workflow_state|routed_to) TEXT[^,]*IN \(/, `${t}: no vocabulary CHECK`); }
  for (const t of S8A_TABLES.filter((x) => !['recruitment_requests', 'trials', 'trial_reminders', 'idempotency_keys'].includes(x))) assert.ok(docs.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'raw_json'), `${t}: a non-object list element is kept verbatim`);
});

console.log(`\n${passed} schema-DDL checks passed (${files.length} files, ${tables.length} tables)`);
