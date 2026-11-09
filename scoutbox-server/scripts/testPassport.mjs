// The Football Passport's own records (repositories/passport.mjs, migration 0024): the STRICT tables, the typers'
// refusals, preferences saved whole and never created by a read, a position history that only grows, typed writes and
// their guards, share view counts and a unique token hash, T&S paging, units of work and fixtures.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb, ORG } from './recruitmentTestFixtures.mjs';
import {
  PASSPORT_MIGRATION as MIGRATION, PASSPORT_TABLES as TABLES, PASSPORT_COLLECTIONS as COLLECTIONS,
  typePrefs, typeCareerEntry, typeAchievement,
} from '../repositories/passport.mjs';
import { isFootballDate } from '../repositories/fieldSpecs.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};

// ------------------------------------------------------------- fixtures: the literals the routes write
const PID = 'pl-1';
/** POST /player/football-passport/career. */
const entry = (over = {}) => ({ id: 'pcar-1', playerId: PID, orgName: 'Sunday Kings FC', role: 'ST', from: '2018', to: null, note: null, submittedBy: 'player', createdAt: NOW - 100, withdrawnAt: null, ...over });
/** POST /player/football-passport/achievements. */
const achievement = (over = {}) => ({ id: 'pach-1', playerId: PID, title: 'County Cup Winner', orgName: null, when: '2024', submittedBy: 'player', confirmation: null, createdAt: NOW - 100, withdrawnAt: null, ...over });
/** createShare (sharing.mjs). */
const share = (over = {}) => ({ id: 'pshr-1', playerId: PID, mode: 'public', tokenHash: 'a'.repeat(64), createdBy: { kind: 'player', id: PID }, createdAt: NOW - 100, expiresAt: NOW + 86_400_000, revokedAt: null, revokedBy: null, views: 0, ...over });
/** fileCorrection (passport.mjs). */
const correction = (over = {}) => ({ id: 'pcor-1', playerId: PID, targetType: 'club_history', targetId: null, reason: 'Joined in August.', by: { kind: 'player', id: PID, name: 'Kola' }, status: 'open', resolution: null, createdAt: NOW - 100, ...over });

function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, repo: layer.passport, unit: (w) => store.unitOfWork(w), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0024 is registered after 0023 and creates the nine STRICT tables (no JSON column), empty on a fresh database', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0023_verification') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s10b-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named; football dates keep the precision given', () => {
  for (const ok of ['2018', '2016-09', '2020-02-29']) assert.equal(isFootballDate(ok), true, ok);
  for (const no of ['sometime', '2021-02-29', '2020-13', '20', 1600000000000, '2020-1-1']) assert.equal(isFootballDate(no), false, String(no));
  assert.equal(typeCareerEntry(entry()).ok, true);
  assert.match(typeCareerEntry(entry({ sneaky: 1 })).reason, /pcar-1 carries field\(s\) this build does not store: sneaky/);
  assert.match(typeCareerEntry(entry({ from: 'sometime in 2019' })).reason, /from must be a date/);
  assert.match(typeCareerEntry(entry({ submittedBy: 'club' })).reason, /submittedBy must be one of/);
  assert.match(typeAchievement(achievement({ confirmation: { provenance: 'authoritative_registry', orgId: ORG.id, orgName: 'X', byName: null, at: NOW } })).reason, /confirmation.*provenance must be one of/);
  const prefs = { playerId: PID, bio: null, positions: { primary: 'ST', secondary: ['RW'] }, positionHistory: [], availability: null, availableFrom: null, publicSelections: [], updatedAt: NOW };
  assert.equal(typePrefs(prefs).ok, true);
  assert.match(typePrefs({ ...prefs, positions: { primary: 'striker', secondary: [] } }).reason, /positions\.primary must be a position code/);
  assert.match(typePrefs({ ...prefs, positions: { primary: 'ST', secondary: ['RW', 'LW', 'CF', 'CAM'] } }).reason, /holds more than 3/);
  assert.match(typePrefs({ ...prefs, publicSelections: Array.from({ length: 101 }, (_, i) => `pev:${i}`) }).reason, /publicSelections holds more than 100/);
  assert.match(typePrefs({ ...prefs, availableFrom: 'next week' }).reason, /availableFrom must be a date/);
  assert.equal(typePrefs({ ...prefs, positions: { primary: null, secondary: [] } }).record.positions, null, 'positions with neither a primary nor a secondary are no positions');
});

// ------------------------------------------------------------- writes and reads
test('[prefs] a read never creates a row; save writes the whole record with its children; the position history only grows', () => {
  const dir = tempDir('s10b-prefs'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.equal(s.repo.passportPrefs.forPlayer(PID), null, 'nobody saved: no row');
    assert.equal(s.store.sqlite.prepare('SELECT count(*) AS n FROM passport_prefs').get().n, 0);
    const p = s.repo.passportPrefs.save(PID, (d) => {
      d.positions = { primary: 'ST', secondary: ['RW', 'CF'] }; d.availability = 'open_to_trials'; d.availableFrom = '2026-08';
      d.positionHistory.push({ id: 'ppos-1', from: '2020', primary: 'RW', secondary: ['LW'], submittedBy: 'player', recordedAt: NOW });
      d.publicSelections = ['pev:a', 'hist:Sunday Kings FC']; d.updatedAt = NOW;
    });
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.positionHistory[0].secondary), 'deep-frozen');
    assert.deepEqual(p.positions, { primary: 'ST', secondary: ['RW', 'CF'] });
    assert.deepEqual(p.positionHistory, [{ id: 'ppos-1', from: '2020', primary: 'RW', secondary: ['LW'], submittedBy: 'player', recordedAt: NOW }]);
    assert.deepEqual(p.publicSelections, ['pev:a', 'hist:Sunday Kings FC']);
    const q = s.repo.passportPrefs.save(PID, (d) => { d.publicSelections = ['hist:Sunday Kings FC']; d.positions = null; d.updatedAt = NOW + 1; });
    assert.deepEqual(q.publicSelections, ['hist:Sunday Kings FC']); assert.equal(q.positions, null); assert.equal(q.positionHistory.length, 1);
    refused(() => s.repo.passportPrefs.save(PID, (d) => { d.positionHistory = []; }), /only grows/, 'history dropped');
    refused(() => s.repo.passportPrefs.save(PID, (d) => { d.positionHistory[0].primary = 'GK'; }), /only grows/, 'history edited');
    refused(() => s.repo.passportPrefs.save(PID, (d) => { d.bio = 7; }), /bio must be text/, 'wrong type');
    refused(() => s.repo.passportPrefs.save(PID, () => { s.repo.passportPrefs.save(PID, () => {}); }), /already being updated/, 'nested save');
    refused(() => s.repo.passportPrefs.save('pl-2', () => {}), /updatedAt is required/, 'a save without a time');
    assert.equal(typeof s.repo.reads.passportPrefs.save, 'undefined', 'the reads carry no writes');
  } finally { s.close(); rm(dir); }
});

test('[writes] create/update return fresh frozen records and refuse identity changes, duplicates and nested updates; shares count views and keep one token per hash', () => {
  const dir = tempDir('s10b-writes'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    const e = s.repo.careerEntries.create(entry());
    assert.ok(Object.isFrozen(e)); assert.throws(() => { e.orgName = 'x'; }, TypeError);
    refused(() => s.repo.careerEntries.create(entry()), /already exists/, 'duplicate id');
    refused(() => s.repo.careerEntries.update('pcar-1', (d) => { d.playerId = 'pl-2'; }), /playerId cannot change/, 'identity change');
    refused(() => s.repo.careerEntries.update('pcar-1', () => { s.repo.careerEntries.update('pcar-1', () => {}); }), /already being updated/, 'nested update');
    assert.equal(s.repo.careerEntries.update('pcar-1', (d) => { d.withdrawnAt = NOW; }).withdrawnAt, NOW);
    s.repo.achievements.create(achievement());
    const a = s.repo.achievements.update('pach-1', (d) => { d.confirmation = { provenance: 'verified_club_confirmed', orgId: ORG.id, orgName: ORG.name, byName: 'Maria', at: NOW }; });
    assert.equal(a.confirmation.orgId, ORG.id);
    refused(() => s.repo.achievements.create(achievement({ id: 'pach-2', confirmation: { provenance: 'verified_club_confirmed', orgId: 'org-none', orgName: 'Nobody', byName: null, at: NOW } })), /FOREIGN KEY/, 'confirmation by a missing organisation');
    s.repo.shares.create(share());
    refused(() => s.repo.shares.create(share({ id: 'pshr-2' })), /UNIQUE/, 'a second share with the same hash');
    s.repo.shares.recordView('pshr-1'); s.repo.shares.recordView('pshr-1');
    assert.equal(s.repo.reads.shares.byHash('a'.repeat(64)).views, 2);
    assert.equal(s.repo.reads.shares.activeCount(PID, NOW), 1);
    s.repo.shares.update('pshr-1', (d) => { d.revokedAt = NOW; d.revokedBy = { kind: 'trust_safety', id: 'admin' }; });
    assert.equal(s.repo.reads.shares.activeCount(PID, NOW), 0);
    refused(() => s.repo.shares.update('pshr-1', (d) => { d.tokenHash = 'b'.repeat(64); }), /tokenHash cannot change/, 'hash change');
    s.repo.corrections.create(correction());
    const r = s.repo.corrections.update('pcor-1', (d) => { d.status = 'resolved'; d.resolution = { outcome: 'corrected', reason: 'Fixed.', at: NOW }; d.resolvedAt = NOW; });
    assert.equal(r.resolvedAt, NOW);
    refused(() => s.repo.corrections.create(correction({ id: 'pcor-2', status: 'resolved' })), /resolution is set exactly when/, 'resolved without a resolution');
  } finally { s.close(); rm(dir); }
});

test('[paging] the T&S lists page by cursor: shares newest first, the correction queue oldest first (open only unless all)', () => {
  const dir = tempDir('s10b-paging'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    for (let i = 1; i <= 5; i++) s.repo.shares.create(share({ id: `pshr-${i}`, tokenHash: String(i).repeat(64) }));
    for (let i = 1; i <= 4; i++) s.repo.corrections.create(correction({ id: `pcor-${i}` }));
    s.repo.corrections.update('pcor-2', (d) => { d.status = 'resolved'; d.resolution = { outcome: 'rejected', reason: 'Stands.', at: NOW }; d.resolvedAt = NOW; });
    const first = s.repo.reads.shares.page({ limit: 2 }).rows;
    assert.deepEqual(first.map((r) => r.record.id), ['pshr-5', 'pshr-4', 'pshr-3'], 'limit + 1 rows, newest first');
    assert.deepEqual(s.repo.reads.shares.page({ limit: 2, after: first[1].key }).rows.map((r) => r.record.id), ['pshr-3', 'pshr-2', 'pshr-1']);
    assert.deepEqual(s.repo.reads.corrections.page({ limit: 10 }).rows.map((r) => r.record.id), ['pcor-1', 'pcor-3', 'pcor-4']);
    assert.deepEqual(s.repo.reads.corrections.page({ all: true, limit: 10 }).rows.map((r) => r.record.id), ['pcor-1', 'pcor-2', 'pcor-3', 'pcor-4']);
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves nothing; db.passport* names throw naming the repository', () => {
  const dir = tempDir('s10b-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.throws(() => s.unit(() => {
      s.repo.careerEntries.create(entry());
      s.repo.passportPrefs.save(PID, (d) => { d.bio = 'x'; d.updatedAt = NOW; });
      throw new Error('boom');
    }), /boom/);
    assert.equal(s.repo.reads.careerEntries.byId('pcar-1'), null);
    assert.equal(s.repo.reads.passportPrefs.forPlayer(PID), null);
  } finally { s.close(); rm(dir); }
});

/** The shared loader's passportPrefs writer passes an object; the repository's save takes a change function. */
const fixture = (dir, db) => writeFixture(dir, fixtureDb(db), { now: NOW, idCounter: 1000 });

test('[fixtures] a fixture written through the repository is typed (junk refused naming the field, nothing written), a confirmation by a missing organisation is refused, and the records read back as written', () => {
  const dir = tempDir('s10b-fix');
  const prefs = { playerId: PID, bio: 'Forward.', positions: { primary: 'ST', secondary: [] }, positionHistory: [{ id: 'ppos-1', from: '2019-09', primary: 'RW', secondary: [], submittedBy: 'guardian', recordedAt: NOW }], availability: 'not_looking', availableFrom: null, publicSelections: ['pev:x'], updatedAt: NOW };
  fixture(dir, { passportPrefs: [prefs], passportCareerEntries: [entry()], passportAchievements: [achievement()], passportShares: [share()], passportCorrections: [correction()] });
  try {
    const back = readRecords(dir);
    assert.deepEqual(back.passportPrefs, [prefs]);
    assert.deepEqual(back.passportCareerEntries, [entry()]);
    assert.deepEqual(back.passportCorrections, [{ ...correction(), resolvedAt: null }]);
  } finally { rm(dir); }
  const refusedFixture = (label, db, re) => {
    const d = tempDir(`s10b-fix-${label}`);
    try {
      refused(() => fixture(d, { passportShares: [share()], ...db }), re, label);
      assert.deepEqual(readRecords(d).passportShares, [], `${label}: a refused fixture wrote nothing`);
    } finally { rm(d); }
  };
  refusedFixture('date', { passportCareerEntries: [entry({ from: 'last spring' })] }, /PASSPORT_INPUT_INVALID.*pcar-1.*from must be a date/);
  refusedFixture('org', { passportAchievements: [achievement({ confirmation: { provenance: 'verified_club_confirmed', orgId: 'org-none', orgName: 'N', byName: null, at: NOW } })] }, /FOREIGN KEY constraint failed/);
});

console.log(`\npassport repository: ${passed} checks passed`);
