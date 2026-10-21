// Behavioural tests for the REAL migration 0005_core_identity_live (plan step
// S4a), run through the real runner — the REGISTERED list, so 0006 (the
// media-deletion queue) follows it — on temporary S3-shaped databases, plus
// the integrated boot (attachDataLayer as production runs it). Synthetic
// fixtures and throwaway databases only. Run with: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import { runDataMigrations, migrationApplied } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
import { CANDIDATE_DDL, CORE_IDENTITY_LIVE_MIGRATION, MINOR_WITHOUT_LINK_REASON } from '../repositories/identityPreflight.mjs';
import * as m0005 from '../repositories/migrations/0005_core_identity_live.mjs';
import { openStore } from '../store.mjs';
import {
  NOW, DAY, TTL, tempDir, clone, adult, child, seeded, gPrimary, gCo, gSignup, FIXTURE, ORGS, USERS, SESSIONS, EXTRA, S4_MIGRATION_IDS,
  s3File, freshFile, openRaw, migrate, applied, tableCols, isLive, blob, blobText, meta, sessionRows, links, dump, identityDump, filesDigest, failExecOnce, failRunAt,
} from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const nextId = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const sameShape = (a, b, what) => { assert.deepEqual(Object.keys(b), Object.keys(a), `${what}: key order`); assert.equal(JSON.stringify(b), JSON.stringify(a), `${what}: byte-identical JSON`); };
const blocked = (re) => (err) => { assert.match(err.message, new RegExp(`data migration ${CORE_IDENTITY_LIVE_MIGRATION} failed: CORE_IDENTITY_CUTOVER_BLOCKED`)); assert.match(err.message, re); assert.match(err.message, /Boot aborted; the database was not modified/); return true; };
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
/** Assert that a file is still the pre-migration S3 state: no record, the shadow definition, both blobs as written, everything else as dumped before. */
function assertUntouched(s, { before, playersText, guardiansText }) {
  assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), false, 'no cutover record');
  assert.equal(isLive(s, 'players') || isLive(s, 'guardians'), false, 'the shadow definitions are still in place');
  assert.equal(blobText(s, 'players'), playersText, 'the players blob is byte-identical'); assert.equal(blobText(s, 'guardians'), guardiansText, 'the guardians blob is byte-identical');
  assert.equal(meta(s, CORE_IDENTITY_INIT_META), undefined); assert.equal(meta(s, m0005.CORE_IDENTITY_CUTOVER_META), undefined);
  assert.equal(dump(s), before, 'every table — meta, data_migrations, sessions, staff, organisations, the shadow rows, every blob — is exactly as before');
  assert.equal(s.isTransaction, false); assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on');
}

// ------------------------------------------------------------- the cutover
test('cutover: an S3 file with every record shape cuts over — three live tables, every field and link (roles per side), blobs retired, coreIdentityInit = done, sessions identical by hash, staff, organisations and other blobs untouched, emailCode byte-identical once, the repositories attach and serve every record byte-identical', () => {
  const dir = tempDir('s4-cutover'); s3File(dir);
  const s = openRaw(dir);
  const sessionsBefore = sessionRows(s); const othersBefore = dump(s, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations', 'media_deletions', ...SUBRECORD_TABLES] });
  const blobsBefore = Object.fromEntries(['users', 'sessions', 'orgs', 'requests'].map((n) => [n, blobText(s, n)]));
  const result = migrate(s, { now: NOW });
  assert.deepEqual(result.ran, [...S4_MIGRATION_IDS]); assert.deepEqual([...S4_MIGRATION_IDS], [CORE_IDENTITY_LIVE_MIGRATION, '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure']); assert.equal(result.applied, 14);
  assert.deepEqual(applied(s), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', CORE_IDENTITY_LIVE_MIGRATION, '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure']);
  for (const t of ['players', 'guardians']) assert.ok(isLive(s, t), `${t} has the live definition`);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 5); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 3);
  assert.deepEqual(links(s), [
    { guardian_id: 'gd-primary', player_id: 'pl-child1', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-child2', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-grown', role: 'primary' },
    { guardian_id: 'gd-co', player_id: 'pl-child1', role: 'co' }, { guardian_id: 'gd-co', player_id: 'pl-child2', role: 'co' },
  ], 'one link row per childIds entry, in guardian order then childIds order, the role from the player\'s guardianId');
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(blobText(s, 'players'), undefined); assert.equal(blobText(s, 'guardians'), undefined);
  assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'done');
  const record = JSON.parse(meta(s, m0005.CORE_IDENTITY_CUTOVER_META));
  assert.deepEqual(record.imported, { guardians: 3, players: 5, links: 5 }); assert.equal(record.firstInstallation, false); assert.equal(record.at, NOW); assert.equal(record.evaluatedAt, NOW);
  assert.deepEqual(record.findings, { coLinks: 2, primaryLinks: 3, adultsStillLinked: 1, minorsWithCoLinksOnly: 0, coGuardianArrangements: 1 });
  assert.deepEqual(record.blobs, { players: true, guardians: true }); assert.deepEqual(record.shadowRowsDiscarded, { guardian_children: 0, players: 0, guardians: 0 });
  assert.ok(!/@|scrypt|K7Q2ZP/.test(meta(s, m0005.CORE_IDENTITY_CUTOVER_META)), 'the record carries counts, never data');
  // Untouched: sessions (by hash), staff, organisations, the other blobs.
  assert.deepEqual(sessionRows(s), sessionsBefore); assert.equal(dump(s, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', ...SUBRECORD_TABLES] }), othersBefore);
  for (const [n, text] of Object.entries(blobsBefore)) assert.equal(blobText(s, n), text, `${n} blob untouched`);
  // The code: plain, once, in the facets; never in a column.
  assert.equal(s.prepare("SELECT facets_json FROM guardians WHERE id = 'gd-signup'").get().facets_json.split('K7Q2ZP').length - 1, 1);
  assert.equal(s.prepare("SELECT email_code_hash FROM guardians WHERE id = 'gd-signup'").get().email_code_hash, null);
  // The repositories attach (initState done) and serve every record byte-identical, childIds in link order.
  const warnings = [];
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.equal(identity.initState(), 'done');
  const boot = identity.attach();
  assert.deepEqual(boot, { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 0 });
  for (const rec of FIXTURE().players) sameShape(rec, identity.players.byId(rec.id), `player ${rec.id}`);
  for (const rec of FIXTURE().guardians) sameShape(rec, identity.guardians.byId(rec.id), `guardian ${rec.id}`);
  assert.deepEqual([...identity.guardians.byId('gd-primary').childIds], ['pl-child1', 'pl-child2', 'pl-grown']);
  assert.equal(identity.guardians.byId('gd-signup').emailCode, 'K7Q2ZP');
  assert.throws(() => identity.initialize({ players: [adult()], guardians: [] }, { now: NOW }), /already initialised/);
  s.close(); rm(dir);
});

test('database kinds are explicit state, never row counts: a genuinely new database cuts over empty with coreIdentityInit = pending and the data layer\'s first import happens once; a saved EMPTY snapshot is done and stays empty whatever array a later boot holds; a saved snapshot missing a collection, or with a malformed one, is refused — never seeded, never read as empty', () => {
  // (a) Genuinely new: nothing was ever saved.
  const fresh = tempDir('s4-fresh'); freshFile(fresh);
  let s = openRaw(fresh);
  assert.deepEqual(m0005.describeDatabase(s), { hasCollections: true, everSaved: false, liveAlready: false });
  migrate(s, { now: NOW });
  assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'pending'); assert.equal(JSON.parse(meta(s, m0005.CORE_IDENTITY_CUTOVER_META)).firstInstallation, true);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 0);
  let identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  assert.equal(identity.initState(), 'pending');
  assert.throws(() => identity.attach(), /initialisation is pending/);
  assert.equal(identity.initialize({ players: [adult()], guardians: [gSignup()] }, { now: NOW }).imported, 2);
  assert.equal(identity.initState(), 'done');
  identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  assert.deepEqual(identity.attach([adult(), seeded()], [gSignup()]).players, 1, 'a second boot attaches; the seed array is never imported again');
  s.close(); rm(fresh);
  // (b) A saved snapshot with explicitly empty collections: done, empty, and a later array is ignored.
  const empty = tempDir('s4-empty'); s3File(empty, { players: [], guardians: [], sessions: [] });
  s = openRaw(empty);
  assert.equal(m0005.describeDatabase(s).everSaved, true);
  migrate(s, { now: NOW });
  assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'done'); assert.equal(JSON.parse(meta(s, m0005.CORE_IDENTITY_CUTOVER_META)).firstInstallation, false);
  const warnings = [];
  identity = createIdentityRepositories({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.deepEqual(identity.attach([adult()], [gSignup()]), { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 });
  assert.equal(warnings.length, 2); assert.match(warnings[0], /authoritative.*ignored/);
  assert.throws(() => identity.initialize({ players: [adult()], guardians: [] }, { now: NOW }), /already initialised/);
  s.close(); rm(empty);
  // (c) A saved snapshot that lacks a collection, or whose collection is malformed: refused as a whole, file untouched, nothing seeded.
  const cases = [
    ['no players blob', { omit: ['players'] }, /no players blob; a saved snapshot always carries both collections/],
    ['no guardians blob', { omit: ['guardians'] }, /no guardians blob/],
    ['players blob not JSON', { rawBlobs: { players: '{not json' } }, /the saved players blob is not valid JSON/],
    ['players blob an object', { rawBlobs: { players: '{"id":"not-an-array"}' } }, /the saved players blob is an object, not an array/],
    ['guardians blob null', { rawBlobs: { guardians: 'null' } }, /the saved guardians blob is null, not an array/],
    ['guardians blob a string', { rawBlobs: { guardians: '"x"' } }, /the saved guardians blob is a string, not an array/],
    ['players blob a number', { rawBlobs: { players: '7' } }, /the saved players blob is a number, not an array/],
  ];
  for (const [label, opts, re] of cases) {
    const d = tempDir('s4-malformed'); s3File(d, opts);
    const x = openRaw(d);
    const before = dump(x); const pt = blobText(x, 'players'); const gt = blobText(x, 'guardians');
    assert.throws(() => migrate(x, { now: NOW }), blocked(re), label);
    assertUntouched(x, { before, playersText: pt, guardiansText: gt });
    assert.throws(() => migrate(x, { now: NOW }), blocked(re), `${label}: the next boot aborts the same way`);
    x.close(); rm(d);
  }
});

test('refusals: duplicates, missing references, both sides of a link disagreeing, a duplicate e-mail and the Founder\'s legacy-minor rule each abort the whole cutover with ids and reasons — the file is byte-identical, the next boot aborts the same way, the repaired file cuts over; age is evaluated at the migration instant', () => {
  const run = (label, mutate, re) => {
    const fx = FIXTURE(); mutate(fx);
    const d = tempDir('s4-refuse'); s3File(d, { players: fx.players, guardians: fx.guardians });
    const x = openRaw(d);
    const before = dump(x); const pt = blobText(x, 'players'); const gt = blobText(x, 'guardians'); const mainFile = filesDigest(d)['scoutbox.db'];
    assert.throws(() => migrate(x, { now: NOW }), blocked(re), label);
    assertUntouched(x, { before, playersText: pt, guardiansText: gt });
    x.close();
    // The main file is byte-identical. (The -wal/-shm side files exist while a connection is open and go when the last one closes: WAL housekeeping, not content.)
    assert.equal(filesDigest(d)['scoutbox.db'], mainFile, `${label}: the main file is byte-identical after the rolled-back attempt`);
    const y = openRaw(d);
    assert.throws(() => migrate(y, { now: NOW }), blocked(re), `${label}: the next boot aborts the same way`);
    y.close(); rm(d);
  };
  run('duplicate player id', (fx) => fx.players.push(clone(fx.players[0])), /players pl-adult: duplicate id \(2 records\)/);
  run('duplicate guardian e-mail (case-insensitive)', (fx) => { fx.guardians[2].email = 'PRIMARY@example.test'; }, /guardians gd-primary: shares its e-mail .* with gd-signup/);
  run('guardianId names nobody', (fx) => { fx.players[1].guardianId = 'gd-nobody'; }, /players pl-child1: guardianId names no record \(gd-nobody\)/);
  run('childIds names nobody', (fx) => { fx.guardians[1].childIds.push('pl-ghost'); }, /guardians gd-co: childIds names no record \(pl-ghost\)/);
  run('the two sides of a primary link disagree', (fx) => { fx.players[1].guardianId = 'gd-signup'; }, /players pl-child1: guardianId names gd-signup but that guardian's childIds does not list the player/);
  run('an invalid record', (fx) => { fx.players[0].heightCm = 1e20; }, /players pl-adult: heightCm/);
  // The Founder's rule: a legacy minor with no link at all refuses everything; nothing is omitted, linked, re-dated or deleted.
  run('a legacy minor without any guardian link', (fx) => fx.players.push(child('pl-orphan', null, '2013-04-04')), /legacy minors without any guardian link \(the Founder's decision.*\): pl-orphan/);
  // Age is evaluated at the migration instant: the same unlinked player is a minor the day before the 18th birthday and an adult the day after.
  const fx = FIXTURE(); fx.players.push(child('pl-turning', null, '2008-10-12'));
  const d = tempDir('s4-age'); s3File(d, { players: fx.players, guardians: fx.guardians });
  let x = openRaw(d);
  assert.throws(() => migrate(x, { now: Date.UTC(2026, 9, 11, 12) }), blocked(/players pl-turning: a minor on the evaluation date/));
  assert.equal(migrationApplied(x, CORE_IDENTITY_LIVE_MIGRATION), false);
  migrate(x, { now: Date.UTC(2026, 9, 13, 12) });
  assert.equal(migrationApplied(x, CORE_IDENTITY_LIVE_MIGRATION), true);
  assert.equal(JSON.parse(meta(x, m0005.CORE_IDENTITY_CUTOVER_META)).evaluatedAt, Date.UTC(2026, 9, 13, 12));
  assert.equal(x.prepare("SELECT guardian_id FROM players WHERE id = 'pl-turning'").get().guardian_id, null, 'imported unchanged, unlinked, as an adult');
  x.close(); rm(d);
  // Repair: the operator resolves the record on the current build (here: links the minor to an existing guardian on both sides); the retry cuts over.
  const fx2 = FIXTURE(); fx2.players.push(child('pl-orphan', null, '2013-04-04'));
  const d2 = tempDir('s4-repair'); s3File(d2, { players: fx2.players, guardians: fx2.guardians });
  x = openRaw(d2);
  assert.throws(() => migrate(x, { now: NOW }), blocked(/pl-orphan/));
  const players = blob(x, 'players'); const guardians = blob(x, 'guardians');
  players.find((p) => p.id === 'pl-orphan').guardianId = 'gd-signup'; guardians.find((g) => g.id === 'gd-signup').childIds.push('pl-orphan');
  const put = x.prepare('UPDATE collections SET value = ? WHERE name = ?'); put.run(JSON.stringify(players), 'players'); put.run(JSON.stringify(guardians), 'guardians');
  migrate(x, { now: NOW });
  assert.deepEqual(x.prepare("SELECT guardian_id, player_id, role FROM guardian_children WHERE player_id = 'pl-orphan'").all().map((r) => ({ ...r })), [{ guardian_id: 'gd-signup', player_id: 'pl-orphan', role: 'primary' }]);
  x.close(); rm(d2);
});

test('stale populated shadow rows are discarded unread: the live tables hold exactly the blobs\' records, the discarded counts are recorded, and after the cutover neither a stale blob nor a repeated run can overwrite the initialised live domain', () => {
  const dir = tempDir('s4-shadow');
  s3File(dir, { shadowRows: { guardians: [{ id: 'gd-stale', name: 'Stale', email: 'stale@example.test' }, { id: 'gd-primary', name: 'Old Shadow Name', email: 'old@example.test' }], players: [{ id: 'pl-stale', name: 'Stale Player', dob: '2010-01-01', country: 'GB', guardianId: 'gd-stale' }], links: [{ guardianId: 'gd-stale', playerId: 'pl-stale' }] } });
  const s = openRaw(dir);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1, 'the shadow holds a stale row before the cutover');
  migrate(s, { now: NOW });
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-stale'").get().n, 0); assert.equal(s.prepare("SELECT COUNT(*) AS n FROM guardians WHERE id = 'gd-stale'").get().n, 0);
  assert.equal(s.prepare("SELECT name FROM guardians WHERE id = 'gd-primary'").get().name, 'Primary Parent', 'the blob, not the shadow row');
  assert.deepEqual(s.prepare('SELECT id FROM players ORDER BY rowid').all().map((r) => r.id), FIXTURE().players.map((p) => p.id));
  assert.deepEqual(JSON.parse(meta(s, m0005.CORE_IDENTITY_CUTOVER_META)).shadowRowsDiscarded, { guardian_children: 1, players: 1, guardians: 2 });
  // After the cutover: a stale blob written back is ignored by the repositories; the migration refuses to run again over the live domain; the runner never repeats a recorded step.
  const liveBefore = identityDump(s);
  s.prepare("INSERT INTO collections (name, value) VALUES ('players', ?)").run(JSON.stringify([{ ...adult(), name: 'Stale Blob' }, child('pl-stale-blob', 'gd-primary', '2015-01-01')]));
  const warnings = [];
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW, warn: (m) => warnings.push(m) });
  identity.attach(blob(s, 'players'), null);
  assert.equal(identity.players.byId('pl-adult').name, 'Adult Signup'); assert.equal(identity.players.byId('pl-stale-blob'), null); assert.match(warnings[0], /1 record\(s\) the table does not hold was ignored/);
  assert.deepEqual(migrate(s, { now: NOW }).ran, [], 'recorded: the runner skips it');
  s.exec('BEGIN');
  assert.throws(() => m0005.up(s, { now: NOW }), /CORE_IDENTITY_CUTOVER_BLOCKED: the players\/guardians tables already have the live definition/);
  s.exec('ROLLBACK');
  assert.throws(() => m0005.up(s, { now: NOW }), /inside the migration runner's transaction only/);
  assert.equal(identityDump(s), liveBefore, 'the live domain is exactly as the cutover left it');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- failures
test('injected failures — after the destructive DDL, in the middle of the inserts, after every insert before the final metadata, and at COMMIT — each leave the file in the pre-migration state (blobs, shadow rows, sessions, staff, organisations, meta, no record), the failure is proven to have occurred, the next attempt refuses nothing and succeeds', () => {
  const dir = tempDir('s4-inject');
  s3File(dir, { shadowRows: { players: [{ id: 'pl-stale', name: 'Stale', dob: '2010-01-01', country: 'GB' }] } });
  const s = openRaw(dir);
  const before = dump(s); const pt = blobText(s, 'players'); const gt = blobText(s, 'guardians');
  const injections = [
    ['after the destructive DDL (the three DROPs ran; the live DDL fails)', () => failExecOnce(s, (sql) => sql === CANDIDATE_DDL, 'injected failure after DROP TABLE')],
    ['in the middle of the inserts (the 3rd player row)', () => failRunAt(s, (sql) => /^INSERT INTO players /.test(sql), 3, 'injected failure during the inserts')],
    ['after every insert, before the final metadata (the cutover record)', () => failRunAt(s, (sql) => /^INSERT INTO meta /.test(sql), 1, 'injected failure before the metadata')],
    ['at COMMIT', () => failExecOnce(s, (sql) => sql === 'COMMIT', 'injected COMMIT failure')],
  ];
  for (const [label, arm] of injections) {
    const probe = arm();
    let err = null;
    try { migrate(s, { now: NOW }); } catch (e) { err = e; } finally { probe.restore(); }
    assert.equal(probe.fired, 1, `${label}: the failure must actually have been injected`);
    assert.match(String(err?.message), /data migration 0005_core_identity_live failed: injected/, label);
    assertUntouched(s, { before, playersText: pt, guardiansText: gt });
    assert.equal(s.prepare("SELECT COUNT(*) AS n FROM players WHERE id = 'pl-stale'").get().n, 1, `${label}: the shadow rows are back too`);
  }
  // The injection before the metadata ran every insert: prove the probe saw the statement it was meant to see.
  migrate(s, { now: NOW });
  assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), true); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n, 5);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  s.close(); rm(dir);
});

test('a process killed at COMMIT (after the DROPs, the live DDL, every insert and the metadata) leaves the pre-migration database — a fresh open sees the blobs, the shadow tables, no record, no marker, integrity ok — and the next run cuts over', () => {
  const dir = tempDir('s4-crash'); s3File(dir, { shadowRows: { players: [{ id: 'pl-stale', name: 'Stale', dob: '2010-01-01', country: 'GB' }] } });
  let s = openRaw(dir); const before = dump(s); const pt = blobText(s, 'players'); const gt = blobText(s, 'guardians'); s.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'coreIdentityMigrationCrashChild.mjs'), dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, 'SIGKILL', `the child must die by SIGKILL: status ${r.status} signal ${r.signal} ${r.stderr.slice(-400)}`);
  assert.match(r.stdout, /ABOUT_TO_CRASH/); assert.doesNotMatch(r.stdout, /SURVIVED/);
  s = openRaw(dir);
  assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assertUntouched(s, { before, playersText: pt, guardiansText: gt });
  migrate(s, { now: NOW });
  assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), true); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 5);
  s.close(); rm(dir);
});

// ------------------------------------------------------------- the integrated boot (the data layer as production runs it)
test('integrated boot: 0005 and 0006 are registered, players and guardians are table-backed, a first installation initialises once from the seed (never again), a saved-empty domain stays empty, a stale array or blob never replaces live data, and no identity blob is written again', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', CORE_IDENTITY_LIVE_MIGRATION, '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure']);
  assert.deepEqual([...TABLE_BACKED], ['orgs', 'players', 'guardians', 'playersRetained', 'users', 'sessions', 'mediaDeletions', 'emailChallenges', 'pairingCodes', 'notifications', 'notificationPrefs', 'dispatches', 'outbox', 'pushLog', 'pushTokens', 'channels', 'blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue']);
  assert.equal(m0005.id, CORE_IDENTITY_LIVE_MIGRATION); assert.equal(m0005.foreignKeysOff, true);
  // (a) A genuinely new database: the seed (the in-memory records) is imported once, atomically with the state change.
  const dir = tempDir('s4-boot'); let store = openStore(dir, { tableBacked: TABLE_BACKED });
  const seed = () => ({ orgs: ORGS(), users: USERS(), sessions: [], players: [adult(), child('pl-child1', 'gd-primary', '2014-03-03')], guardians: [{ ...gPrimary(), childIds: ['pl-child1'] }, gSignup()], requests: [] });
  let db = seed();
  let layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  assert.deepEqual(layer.report().migrations, DATA_MIGRATIONS.map((m) => m.id));
  assert.equal(migrationApplied(store.sqlite, CORE_IDENTITY_LIVE_MIGRATION), true);
  assert.ok(isLive(store.sqlite, 'players') && isLive(store.sqlite, 'guardians'), 'the live definitions');
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 2, links: 1, imported: 4 });
  assert.equal(layer.report().identity.initState, 'done');
  assert.throws(() => { db.players.push({ id: 'x' }); }, /identity repositories/, 'players are a read-only view');
  assert.throws(() => { db.players = []; }, TypeError);
  store.save({ savedAt: NOW, idCounter: 1000, db });
  assert.equal(blob(store.sqlite, 'players'), undefined); assert.equal(blob(store.sqlite, 'guardians'), undefined, 'no identity blob is written');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 1);
  store.sqlite.close();
  // (b) A restart with the seed in memory again: attached, never imported; a stale extra record is reported and ignored.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, ...seed() }; db.players.push({ ...adult(), id: 'pl-stale' });
  const warnings = [];
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 2, links: 1, imported: 0 });
  assert.equal(db.players.find((p) => p.id === 'pl-stale'), undefined, 'the stale seed record is not resurrected');
  assert.ok(warnings.some((w) => /players table holds 2 row\(s\).*1 record\(s\) the table does not hold was ignored/.test(w)), JSON.stringify(warnings));
  store.sqlite.close();
  // (c) A database whose identity domain was saved EMPTY on purpose stays empty: the seed is never imported into it.
  const emptyDir = tempDir('s4-boot-empty'); s3File(emptyDir, { players: [], guardians: [] });
  store = openStore(emptyDir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, players: [adult()], guardians: [gSignup()] };
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 });
  assert.equal(layer.report().identity.initState, 'done'); assert.equal(db.players.length, 0);
  store.sqlite.close();
  // (d) A migrated database whose blobs are gone (the normal post-cutover file): attach, with the seed in memory, imports nothing.
  const migratedDir = tempDir('s4-boot-migrated'); s3File(migratedDir);
  { const s = openRaw(migratedDir); migrate(s, { now: NOW }); assert.equal(blobText(s, 'players'), undefined); s.close(); }
  store = openStore(migratedDir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, players: [adult()], guardians: [] };
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 0 });
  assert.equal(db.players.find((p) => p.id === 'pl-seeded').name, 'Seeded Adult');
  store.sqlite.close();
  rm(dir, emptyDir, migratedDir);
});

console.log(`\n${passed} core-identity migration checks passed`);
