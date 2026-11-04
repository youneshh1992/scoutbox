// Behavioural tests for the REAL migration 0005_core_identity_live (plan step
// S4a), run through the real runner — the REGISTERED list — on new temporary
// databases, the identity repository's one-time seed import, and the
// integrated boot (attachDataLayer as production runs it). Synthetic
// fixtures and throwaway databases only. Run with: npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SUBRECORD_TABLES, placeSubrecords } from '../repositories/playerSubrecords.mjs';
import { runDataMigrations, migrationApplied } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
import { CANDIDATE_DDL, CORE_IDENTITY_LIVE_MIGRATION } from '../repositories/identityPreflight.mjs';
import * as m0005 from '../repositories/migrations/0005_core_identity_live.mjs';
import { openStore } from '../store.mjs';
import {
  NOW, T0, TTL, tempDir, clone, adult, child, gPrimary, gSignup, FIXTURE, ORGS, USERS, S4_MIGRATION_IDS,
  freshFile, openRaw, migrate, applied, isLive, blob, blobText, meta, links, dump, identityDump, failExecOnce, failRunAt,
} from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const nextId = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;
const sameShape = (a, b, what) => { assert.deepEqual(Object.keys(b), Object.keys(a), `${what}: key order`); assert.equal(JSON.stringify(b), JSON.stringify(a), `${what}: byte-identical JSON`); };
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
// ------------------------------------------------------------- the migration
test('migration: a new database gets three live tables (the S1 shadow tables, stale rows and all, are dropped), coreIdentityInit = pending, and the repository imports the seed once — never again, whatever array a later boot holds; up() refuses to run outside the runner, and the runner never repeats a recorded step', () => {
  const dir = tempDir('s4-fresh'); freshFile(dir);
  let s = openRaw(dir);
  s.prepare("INSERT INTO players (id, name, birth_date, country) VALUES ('pl-stale', 'Stale', '2010-01-01', 'GB')").run();
  const result = migrate(s, { now: NOW });
  assert.deepEqual(result.ran, [...S4_MIGRATION_IDS]); assert.equal(result.applied, DATA_MIGRATIONS.length);
  assert.deepEqual(applied(s), DATA_MIGRATIONS.map((m) => m.id));
  for (const t of ['players', 'guardians']) assert.ok(isLive(s, t), `${t} has the live definition`);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM players').get().n + s.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 0, 'the shadow rows are gone');
  assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'pending');
  let identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  assert.equal(identity.initState(), 'pending');
  assert.throws(() => identity.attach(), /initialisation is pending/);
  const fx = FIXTURE();
  assert.equal(identity.initialize({ players: fx.players, guardians: fx.guardians }, { now: NOW }).imported, 8);
  assert.equal(identity.initState(), 'done');
  assert.deepEqual(links(s), [
    { guardian_id: 'gd-primary', player_id: 'pl-child1', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-child2', role: 'primary' }, { guardian_id: 'gd-primary', player_id: 'pl-grown', role: 'primary' },
    { guardian_id: 'gd-co', player_id: 'pl-child1', role: 'co' }, { guardian_id: 'gd-co', player_id: 'pl-child2', role: 'co' },
  ], 'one link row per childIds entry, in guardian order then childIds order, the role from the player\'s guardianId');
  assert.deepEqual(s.prepare('PRAGMA foreign_key_check').all(), []);
  // The code: plain, once, in the facets; never in a column.
  assert.equal(s.prepare("SELECT facets_json FROM guardians WHERE id = 'gd-signup'").get().facets_json.split('K7Q2ZP').length - 1, 1);
  assert.equal(s.prepare("SELECT email_code_hash FROM guardians WHERE id = 'gd-signup'").get().email_code_hash, null);
  // A second boot attaches and serves every record byte-identical, childIds in link order; the seed is never imported again.
  identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  assert.deepEqual(identity.attach([adult(), { ...adult(), id: 'pl-stale-seed' }], [gSignup()]), { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 0 });
  for (const rec of FIXTURE().players) sameShape(placeSubrecords(clone(rec)), identity.players.byId(rec.id), `player ${rec.id}`);
  for (const rec of FIXTURE().guardians) sameShape(rec, identity.guardians.byId(rec.id), `guardian ${rec.id}`);
  assert.equal(identity.players.byId('pl-stale-seed'), null);
  assert.deepEqual([...identity.guardians.byId('gd-primary').childIds], ['pl-child1', 'pl-child2', 'pl-grown']);
  assert.throws(() => identity.initialize({ players: [adult()], guardians: [] }, { now: NOW }), /already initialised/);
  const liveBefore = identityDump(s);
  assert.deepEqual(migrate(s, { now: NOW }).ran, [], 'recorded: the runner skips it');
  assert.throws(() => m0005.up(s, { now: NOW }), /inside the migration runner's transaction only/);
  assert.equal(identityDump(s), liveBefore, 'the live domain is untouched');
  s.close(); rm(dir);
});

test('the seed import refuses invalid input whole — duplicates, missing references, the two sides of a link disagreeing, a duplicate e-mail, an invalid field and a legacy minor without any guardian link — with ids and reasons; nothing is written and the state stays pending', () => {
  const run = (label, mutate, re) => {
    const fx = FIXTURE(); mutate(fx);
    const d = tempDir('s4-refuse'); freshFile(d);
    const x = openRaw(d); migrate(x, { now: NOW });
    const identity = createIdentityRepositories({ sqlite: x, now: () => NOW });
    assert.throws(() => identity.initialize({ players: fx.players, guardians: fx.guardians }, { now: NOW }), re, label);
    assert.equal(identity.initState(), 'pending', `${label}: still pending`);
    assert.equal(x.prepare('SELECT COUNT(*) AS n FROM players').get().n + x.prepare('SELECT COUNT(*) AS n FROM guardians').get().n + x.prepare('SELECT COUNT(*) AS n FROM guardian_children').get().n, 0, `${label}: nothing written`);
    x.close(); rm(d);
  };
  run('duplicate player id', (fx) => fx.players.push(clone(fx.players[0])), /pl-adult/);
  run('duplicate guardian e-mail (case-insensitive)', (fx) => { fx.guardians[2].email = 'PRIMARY@example.test'; }, /gd-primary|gd-signup/);
  run('guardianId names nobody', (fx) => { fx.players[1].guardianId = 'gd-nobody'; }, /pl-child1/);
  run('childIds names nobody', (fx) => { fx.guardians[1].childIds.push('pl-ghost'); }, /pl-ghost/);
  run('the two sides of a primary link disagree', (fx) => { fx.players[1].guardianId = 'gd-signup'; }, /pl-child1/);
  run('an invalid record', (fx) => { fx.players[0].heightCm = 1e20; }, /heightCm/);
  run('a legacy minor without any guardian link', (fx) => fx.players.push(child('pl-orphan', null, '2013-04-04')), /pl-orphan/);
});

// ------------------------------------------------------------- failures
test('injected failures — after the destructive DDL (the live DDL fails), at the init-state write and at COMMIT — each leave the new database as it was (no record, the shadow tables and their rows, no init state), the failure is proven to have occurred, and the next attempt succeeds', () => {
  const dir = tempDir('s4-inject'); freshFile(dir);
  const s = openRaw(dir);
  s.prepare("INSERT INTO players (id, name, birth_date, country) VALUES ('pl-stale', 'Stale', '2010-01-01', 'GB')").run();
  const before = dump(s);
  const injections = [
    ['after the destructive DDL (the three DROPs ran; the live DDL fails)', () => failExecOnce(s, (sql) => sql === CANDIDATE_DDL, 'injected failure after DROP TABLE')],
    ['at the init-state write', () => failRunAt(s, (sql) => /^INSERT INTO meta /.test(sql), 1, 'injected failure at the metadata')],
    ['at COMMIT', () => failExecOnce(s, (sql) => sql === 'COMMIT', 'injected COMMIT failure')],
  ];
  for (const [label, arm] of injections) {
    const probe = arm();
    let err = null;
    try { migrate(s, { now: NOW }); } catch (e) { err = e; } finally { probe.restore(); }
    assert.equal(probe.fired, 1, `${label}: the failure must actually have been injected`);
    assert.match(String(err?.message), /data migration 0005_core_identity_live failed: injected/, label);
    assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), false, `${label}: no record`);
    assert.equal(isLive(s, 'players'), false, `${label}: the shadow definition is back`);
    assert.equal(dump(s), before, `${label}: every table is exactly as before`);
    assert.equal(s.isTransaction, false); assert.equal(s.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on');
  }
  migrate(s, { now: NOW });
  assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), true); assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'pending');
  s.close(); rm(dir);
});

test('a process killed at COMMIT (after the DROPs, the live DDL and the init state) leaves the database as it was — a fresh open sees the shadow tables, no record, no init state, integrity ok — and the next run migrates', () => {
  const dir = tempDir('s4-crash'); freshFile(dir);
  let s = openRaw(dir); const before = dump(s); s.close();
  const r = spawnSync(process.execPath, [path.join(HERE, 'coreIdentityMigrationCrashChild.mjs'), dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, 'SIGKILL', `the child must die by SIGKILL: status ${r.status} signal ${r.signal} ${r.stderr.slice(-400)}`);
  assert.match(r.stdout, /ABOUT_TO_CRASH/); assert.doesNotMatch(r.stdout, /SURVIVED/);
  s = openRaw(dir);
  assert.equal(s.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(dump(s), before, 'every table is exactly as before');
  migrate(s, { now: NOW });
  assert.equal(migrationApplied(s, CORE_IDENTITY_LIVE_MIGRATION), true); assert.ok(isLive(s, 'players'));
  s.close(); rm(dir);
});

// ------------------------------------------------------------- the integrated boot (the data layer as production runs it)
test('integrated boot: 0005 and 0006 are registered, players and guardians are table-backed, a first installation initialises once from the seed (never again), a saved-empty domain stays empty, a stale array or blob never replaces live data, and no identity blob is written again', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', CORE_IDENTITY_LIVE_MIGRATION, '0006_media_deletions', '0007_player_subrecords', '0008_one_time_codes', '0009_notifications', '0010_dispatches', '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups', '0019_scouting_evidence', '0020_scouting_assessments']);
  assert.deepEqual([...TABLE_BACKED], ['orgs', 'players', 'guardians', 'playersRetained', 'users', 'sessions', 'mediaDeletions', 'emailChallenges', 'pairingCodes', 'notifications', 'notificationPrefs', 'dispatches', 'outbox', 'pushLog', 'pushTokens', 'channels', 'blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue', 'requests', 'trials', 'recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState', 'recruitmentContacts', 'recruitmentOffers', 'signingPackages', 'signings', 'followUps', 'outcomeReports', 'evidence', 'coachAffiliations', 'squadInvites', 'assessmentTemplates', 'assessments', 'videoSegments', 'playlists']);
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
  // (b) A restart with the seed in memory again: attached, never imported; a stale extra record is ignored.
  store = openStore(dir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, ...seed() }; db.players.push({ ...adult(), id: 'pl-stale' });
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 2, guardians: 2, links: 1, imported: 0 });
  assert.equal(db.players.find((p) => p.id === 'pl-stale'), undefined, 'the stale seed record is not resurrected');
  store.sqlite.close();
  // (c) A database whose identity domain was saved EMPTY on purpose (a snapshot save) stays empty: the seed is never imported into it.
  const emptyDir = tempDir('s4-boot-empty'); { const t = openStore(emptyDir); t.save({ savedAt: T0, idCounter: 1000, db: { orgs: ORGS(), users: USERS(), players: [], guardians: [] } }); t.sqlite.close(); }
  store = openStore(emptyDir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, players: [adult()], guardians: [gSignup()] };
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 0, guardians: 0, links: 0, imported: 0 });
  assert.equal(layer.report().identity.initState, 'done'); assert.equal(db.players.length, 0);
  store.sqlite.close();
  // (d) A database a snapshot save filled (a tool or a fixture): attach, with the seed in memory, imports nothing.
  const migratedDir = tempDir('s4-boot-migrated'); { const t = openStore(migratedDir); t.save({ savedAt: T0, idCounter: 1000, db: { orgs: ORGS(), users: USERS(), ...FIXTURE() } }); assert.equal(blobText(t.sqlite, 'players'), undefined, 'a snapshot save writes the tables, never an identity blob'); t.sqlite.close(); }
  store = openStore(migratedDir, { tableBacked: TABLE_BACKED });
  db = { ...store.load().db, players: [adult()], guardians: [] };
  layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  assert.deepEqual(layer.boot.identity, { engine: 'sqlite', players: 5, guardians: 3, links: 5, imported: 0 });
  assert.equal(db.players.find((p) => p.id === 'pl-seeded').name, 'Seeded Adult');
  store.sqlite.close();
  rm(dir, emptyDir, migratedDir);
});

console.log(`\n${passed} core-identity migration checks passed`);
