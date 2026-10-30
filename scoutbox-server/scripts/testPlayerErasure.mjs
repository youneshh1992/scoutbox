// S4b-R — the retained player record (migration plan §D.6/§D.6.1; the Founder's
// decisions: the full birth date, 12 October 2026, and the country code KEPT,
// 21 October 2026). The identity repositories on temporary databases through the
// real data layer: `players.erase` retains exactly the agreed row and nothing
// else of the person, removes the owned rows and links, is excluded from every
// account reader, survives repeated and partial snapshot saves byte-identical,
// refuses the reintroduction of a retained id, keeps the under-18 refusal for
// LIVE records, fails atomically (memory restored, held views included) and
// lands once on retry; migration 0014 (a record, the `playersRetained` import
// from a restored backup, every refusal); the copy-only rollback and the
// re-upgrade. Synthetic records only; nothing here touches DATA_DIR. Run with:
// npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged d16362f tree before the
// implementation): every test below fails there on a concrete assertion
// (no players.erase, no retained accessor, no 0014 record, no rollback module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { attachDataLayer, TABLE_BACKED, DATA_MIGRATIONS, readTableBacked } from '../repositories/index.mjs';
import { runDataMigrations } from '../repositories/database.mjs';
import { MINOR_WITHOUT_LINK_REASON } from '../repositories/identityPreflight.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';
import { rollbackRecruitmentCopy } from '../repositories/recruitmentRollback.mjs';
import { rollbackRecruitmentCasesCopy } from '../repositories/recruitmentCasesRollback.mjs';
import { rollbackToPreS8c as rollbackRecruitmentContactsOffersCopy } from '../repositories/rollbackChain.mjs'; // S8d: the live file carries 0018 too; the chain helper steps it back first
import { RECRUITMENT_CASES_TABLES } from '../repositories/recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_TABLES } from '../repositories/recruitmentContactsOffers.mjs';
import { SIGNINGS_FOLLOWUPS_TABLES } from '../repositories/signingsFollowUps.mjs';
import { NOW, TTL, DAY, tempDir, clone, adult, child, seeded, gPrimary, gCo, gSignup, s3File, openRaw, applied, blob, meta, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0014_player_erasure';
const RECRUITMENT_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys']; // S8a (0015) creates these on the same boot
const META = 'playerErasureCutover';
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let erasureMod = null; let rollbackMod = null;
try { erasureMod = await import('../repositories/identity.mjs'); } catch { erasureMod = null; }
try { rollbackMod = await import('../repositories/playerErasureRollback.mjs'); } catch { rollbackMod = null; }
const needRollback = () => { assert.ok(rollbackMod?.rollbackPlayerErasureCopy, 'repositories/playerErasureRollback.mjs exports rollbackPlayerErasureCopy (the S4b-R rollback module)'); return rollbackMod.rollbackPlayerErasureCopy; };

/** The retained row, column by column (plan §D.6.1 item 1): the identifier, the deletion instant, the two retained facts, fixed placeholders, NULL everywhere else. */
const RETAINED_ROW = (id, deletedAt, birthDate, country) => ({
  id, name: 'Deleted player', birth_date: birthDate, country, city: null, position: null, foot: null, height_cm: null, weight_kg: null, squad_number: null,
  contract_until_date: null, market_value_range: null, agent_name: null, academy_plus: 0, first_team_seeker: 0, availability: 'not_seeking', contract_status: 'unknown', level: 'amateur',
  football_category: null, identity_verified: 0, guardian_id: null, lat: null, lng: null, stats_appearances: null, stats_goals: null, stats_assists: null, stats_pace_kmh: null,
  stats_pass_completion_pct: null, stats_duel_success_pct: null, stats_clean_sheets: null, medical_shared: 0, medical_condition_status: 'unknown', prefs_quiet_start: null,
  prefs_quiet_end: null, prefs_school_hours_mute: null, prefs_timezone: null, programme_track: null, programme_started_at: null, password_hash: null, created_at: null,
  deleted_at: deletedAt, facets_json: null,
});
const RECORD = (id, deletedAt, birthDate, country) => ({ id, deletedAt, birthDate, country });

// ------------------------------------------------------------------ harness (the identity suite's, with the whole data layer attached)
const FIXTURE = () => ({ players: [adult(), child('pl-child1', 'gd-primary', '2014-03-03'), seeded(), child('pl-child2', 'gd-primary', '2016-08-08')], guardians: [gPrimary(), gCo(), gSignup()] });
const ORGS = () => [{ id: 'org-pro', name: 'Eastport FC', type: 'club', level: 'pro', plan: 'Pro', country: 'GB', squad: [] }];
const baseDb = (players, guardians) => ({ orgs: ORGS(), users: [{ id: 'usr-1', orgId: 'org-pro', name: 'Maria', role: 'Head of Recruitment', createdAt: 1 }], sessions: [], players, guardians, requests: [], ledger: [], trials: [], channels: [], notifications: [], dispatches: [] });
function boot(dir, { players = [], guardians = [], warnings = [] } = {}) {
  const db = baseDb(clone(players), clone(guardians));
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  return wire({ store, layer, db, warnings });
}
function reopen(dir, { warnings = [] } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  return wire({ store, layer, db, warnings });
}
function wire({ store, layer, db, warnings }) {
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  store.save(snapshot());
  const raw = (sql, ...p) => { const r = store.sqlite.prepare(sql).get(...p); return r ? { ...r } : r; };
  const all = (sql, ...p) => store.sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
  const row = (id) => raw('SELECT * FROM players WHERE id = ?', id);
  const OWNED_TABLES = SUBRECORD_TABLES.filter((t) => t !== 'player_media_tags'); // the tag rows hang off player_media (media_id), not the player
  const childRows = (id) => OWNED_TABLES.reduce((n, t) => n + raw(`SELECT COUNT(*) AS n FROM ${t} WHERE player_id = ?`, id).n, 0);
  const links = (id) => all('SELECT guardian_id, player_id, role FROM guardian_children WHERE player_id = ? ORDER BY rowid', id);
  const revision = () => store.revision();
  return { store, layer, db, warnings, players: layer.identity.players, guardians: layer.identity.guardians, codes: layer.codes, sessions: layer.sessions, mediaDeletions: layer.mediaDeletions,
    snapshot, save: (over = {}) => store.save({ ...snapshot(), db: { ...db, ...over } }), raw, all, row, childRows, links, revision,
    unit: (fn) => store.unitOfWork(fn, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------------ the erase
test('erase: a deleted player keeps EXACTLY the agreed row — id, the deletion instant, the full birth date and the country; a fixed placeholder in every NOT NULL column (never the previous value: a verified semi-pro academy player reads 0 / amateur / not_seeking afterwards), NULL everywhere else, no facets — the twelve child tables and the links are emptied explicitly, every guardian stops listing the id (the held childIds array in place); the retained row is served by no account reader (db.players, byId, byGuardian, count, linksOf, the snapshot read) and only by the narrow accessor; a second erase, remove, update, link and a re-creation under the same id are refused before any statement', () => {
  const dir = tempDir('erase-row'); const t = boot(dir, FIXTURE());
  assert.equal(typeof t.players.erase, 'function', 'players.erase exists (S4b-R)');
  const before = t.row('pl-seeded');
  assert.deepEqual([before.identity_verified, before.academy_plus, before.level, before.availability, before.contract_status, before.medical_shared, before.medical_condition_status], [1, 1, 'semi_pro', 'available_now', 'expiring_summer', 1, 'fully_fit'], 'the fixture carries non-default values in every placeholder column');
  assert.ok(t.childRows('pl-seeded') > 5, 'the fixture has child rows'); assert.ok(before.facets_json, 'and facets');
  const kids = t.guardians.byId('gd-primary').childIds; const coKids = t.guardians.byId('gd-co').childIds;
  const countBefore = t.players.count();
  // An adult, outside a unit (the repository's own transaction).
  const result = t.players.erase('pl-seeded', { at: NOW });
  assert.deepEqual(result, { id: 'pl-seeded', deletedAt: NOW });
  assert.deepEqual(t.row('pl-seeded'), RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'), 'the retained row, column by column');
  assert.equal(t.childRows('pl-seeded'), 0, 'every child row is gone'); assert.deepEqual(t.links('pl-seeded'), []);
  assert.equal(t.players.byId('pl-seeded'), null); assert.equal(t.db.players.some((p) => p.id === 'pl-seeded'), false); assert.equal(t.players.count(), countBefore - 1);
  assert.deepEqual(t.guardians.linksOf('pl-seeded'), []);
  assert.deepEqual(t.players.retained('pl-seeded'), RECORD('pl-seeded', NOW, '2004-03-14', 'GB')); assert.equal(t.players.isRetained('pl-seeded'), true); assert.equal(t.players.isRetained('pl-adult'), false);
  assert.deepEqual(t.players.retainedRecords(), [RECORD('pl-seeded', NOW, '2004-03-14', 'GB')]); assert.equal(t.players.retainedCount(), 1);
  assert.equal(t.players.retained('pl-adult'), null, 'a live player is not a retained record');
  const read = readTableBacked(t.store.sqlite);
  assert.equal(read.players.some((p) => p.id === 'pl-seeded'), false, 'the snapshot read serves no retained row as a player'); assert.deepEqual(read.playersRetained, [RECORD('pl-seeded', NOW, '2004-03-14', 'GB')], 'and serves the retained records under their own name');
  // A guardian-managed child, inside a unit (as the deletion route runs it): links and childIds.
  assert.deepEqual([...kids], ['pl-child1', 'pl-child2']); assert.deepEqual([...coKids], ['pl-child1', 'pl-child2']);
  t.unit(() => { t.codes.revokePairingCodesFor('pl-child1'); t.players.erase('pl-child1', { at: NOW + DAY }); });
  assert.deepEqual(t.row('pl-child1'), RETAINED_ROW('pl-child1', NOW + DAY, '2014-03-03', 'GB'));
  assert.deepEqual([...kids], ['pl-child2'], 'the held primary childIds array was spliced in place'); assert.deepEqual([...coKids], ['pl-child2'], 'and the co-guardian\'s');
  assert.deepEqual(t.links('pl-child1'), []); assert.deepEqual(t.players.byGuardian('gd-primary').map((p) => p.id), ['pl-child2']); assert.equal(t.players.retainedCount(), 2);
  assert.equal(t.raw('SELECT COUNT(*) AS n FROM players').n, countBefore + 0, 'the table keeps every row (two of them retained)');
  // Refusals, before any statement: the table and the counters are untouched afterwards.
  const snapshotOfTable = () => JSON.stringify(t.all('SELECT * FROM players ORDER BY rowid'));
  const tableBefore = snapshotOfTable();
  assert.throws(() => t.players.erase('pl-seeded'), /pl-seeded .*retained/);
  assert.throws(() => t.players.remove('pl-seeded'), /does not exist|retained/);
  assert.throws(() => t.players.update('pl-seeded', { city: 'X' }), /does not exist/);
  assert.throws(() => t.players.link('gd-co', 'pl-child1', 'co'), /does not exist/);
  assert.throws(() => t.players.insert({ ...adult(), id: 'pl-seeded' }), /pl-seeded .*retained/, 'a deleted account is not re-created under its id');
  assert.throws(() => t.players.erase('pl-nobody'), /does not exist/);
  assert.equal(snapshotOfTable(), tableBefore); assert.equal(t.players.count(), countBefore - 2); assert.equal(t.players.retainedCount(), 2);
  assert.equal(t.players.insert({ ...adult(), id: 'pl-new' }).id, 'pl-new', 'a new id is created as before');
  // A reopen agrees.
  t.close();
  const r = reopen(dir);
  assert.deepEqual(r.row('pl-seeded'), RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB')); assert.equal(r.players.byId('pl-seeded'), null); assert.equal(r.db.players.some((p) => p.id === 'pl-child1'), false);
  assert.deepEqual(r.players.retainedRecords(), [RECORD('pl-seeded', NOW, '2004-03-14', 'GB'), RECORD('pl-child1', NOW + DAY, '2014-03-03', 'GB')]); assert.deepEqual([...r.guardians.byId('gd-primary').childIds], ['pl-child2']);
  assert.throws(() => r.players.insert({ ...adult(), id: 'pl-child1' }), /retained/);
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

/** A SNAPSHOT-MODE store on an existing directory (the persistence tools' and the restore's path): every table-backed collection is read as plain arrays and a save dispatches each supplied collection into its table. */
function snapshotStore(dir) {
  const store = openStore(dir); const loaded = store.load();
  const all = (sql, ...p) => store.sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));
  const save = (over = {}) => { const db = { ...loaded.db, ...over }; for (const k of Object.keys(over)) if (over[k] === undefined) delete db[k]; return store.save({ savedAt: NOW, idCounter: 1000, db }); };
  return { store, db: loaded.db, all, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}

test('snapshots: an unchanged save keeps the retained rows byte-identical and advances the revision — an ordinary server-mode save, then in snapshot mode with the collection supplied, supplied twice, omitted (partial snapshot) and through the identity replace (every players row deleted and reinserted); a snapshot that lists a retained id as a LIVE player is refused atomically with ids only (no birth date in the message), nothing changed, revision unchanged; a playersRetained collection that is not an array, an entry without an id, a non-integer deletedAt, a malformed birth date, a country that is not text, a duplicate id, an unknown field, or an id that is also a live player is refused the same way; the under-18-without-guardian refusal still holds for LIVE records while retained rows sit beside them; a pairing code left behind by an erase that did not revoke it names a retained id and refuses the next identity-rewriting save (ids only) — cleared, it is accepted; a subset of the stored retained records is refused, never pruned (review of 6d66655)', () => {
  const dir = tempDir('erase-snapshot'); const t = boot(dir, FIXTURE());
  t.codes.issuePairingCode('pl-child2'); // a live child's code, left behind on purpose by the erase below (the route revokes it in the same unit; the repository does not)
  t.players.erase('pl-seeded', { at: NOW }); t.unit(() => t.players.erase('pl-child2', { at: NOW + 1 }));
  const expected = JSON.stringify([RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'), RETAINED_ROW('pl-child2', NOW + 1, '2016-08-08', 'GB')]);
  const rowsT = () => JSON.stringify(t.all('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid'));
  assert.equal(rowsT(), expected);
  const r0 = t.revision(); t.save(); assert.equal(rowsT(), expected, 'an ordinary server-mode save: kept'); assert.equal(t.revision(), r0 + 1); t.close();
  const S = snapshotStore(dir);
  const rows = () => JSON.stringify(S.all('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid'));
  const live = () => JSON.stringify(S.all('SELECT id FROM players WHERE deleted_at IS NULL ORDER BY rowid'));
  assert.deepEqual(S.db.playersRetained, [RECORD('pl-seeded', NOW, '2004-03-14', 'GB'), RECORD('pl-child2', NOW + 1, '2016-08-08', 'GB')], 'the snapshot read carries the records under their own name'); assert.equal(S.db.players.some((p) => p.id === 'pl-seeded' || p.id === 'pl-child2'), false, 'and never inside players');
  let r1 = S.revision();
  const rowsNow = () => rows(); const liveNow = () => live();
  const refused = (over, pattern, label) => {
    const liveBefore = liveNow(); const revBefore = S.revision();
    let err = null; try { S.save(over); } catch (e) { err = e; }
    assert.ok(err, `${label}: refused`); assert.match(String(err.message), pattern, `${label}: ${err?.message}`);
    assert.doesNotMatch(String(err.message), /2004-03-14|2016-08-08|2001-05-20/, `${label}: no birth date in the message`);
    assert.equal(rowsNow(), expected, `${label}: retained rows unchanged`); assert.equal(liveNow(), liveBefore, `${label}: live rows unchanged`); assert.equal(S.revision(), revBefore, `${label}: revision unchanged`);
  };
  // A pairing code never resolves to a retained id: the stale code the erase left behind (the loaded snapshot carries it) refuses every save that writes the codes — the final-state check and the import read live rows only; cleared, the save is accepted.
  refused({}, /pl-child2/, 'a pairing code naming a retained id');
  S.save({ pairingCodes: [] }); S.db.pairingCodes = []; assert.equal(rows(), expected, 'supplied: identical'); assert.equal(S.revision(), r1 + 1);
  S.save({}); assert.equal(rows(), expected, 'supplied again: identical'); assert.equal(S.revision(), r1 + 2);
  S.save({ playersRetained: undefined }); assert.equal(rows(), expected, 'omitted: kept as it is'); assert.equal(S.revision(), r1 + 3);
  const identity = () => ({ players: clone(S.db.players), guardians: clone(S.db.guardians) });
  S.save({ ...identity() }); assert.equal(rows(), expected, 'the identity pair rewritten (every players row deleted and reinserted by the replace): the retained rows survive'); assert.equal(S.revision(), r1 + 4);
  refused({ players: [...clone(S.db.players), { ...seeded(), id: 'pl-seeded' }], guardians: clone(S.db.guardians) }, /pl-seeded/, 'a retained id listed as a live player');
  refused({ playersRetained: { id: 'x' } }, /playersRetained/, 'not an array');
  refused({ playersRetained: [{ deletedAt: NOW, birthDate: '2004-03-14', country: 'GB' }] }, /id/, 'an entry without an id');
  refused({ playersRetained: [{ id: 'pl-x', deletedAt: 'yesterday', birthDate: '2004-03-14', country: 'GB' }] }, /deletedAt/, 'deletedAt not an integer');
  refused({ playersRetained: [{ id: 'pl-x', deletedAt: NOW, birthDate: '14/03/2004', country: 'GB' }] }, /birthDate/, 'a malformed birth date');
  refused({ playersRetained: [{ id: 'pl-x', deletedAt: NOW, birthDate: '2004-03-14', country: 7 }] }, /country/, 'a country that is not text');
  refused({ playersRetained: [{ ...RECORD('pl-x', NOW, '2004-03-14', 'GB'), name: 'A Name' }] }, /unknown field.*name/, 'an unknown field (nothing of the person travels with the record)');
  refused({ playersRetained: [RECORD('pl-x', NOW, '2004-03-14', 'GB'), RECORD('pl-x', NOW, '2004-03-14', 'GB')] }, /pl-x.*duplicate/, 'a duplicate id');
  refused({ playersRetained: [RECORD('pl-adult', NOW, '2001-05-20', 'GB')] }, /pl-adult/, 'a retained record whose id is a live player');
  // The Founder's rule for live records is unchanged: a minor with no guardian link refuses the whole save.
  refused({ players: [...clone(S.db.players), child('pl-orphan', null, '2015-05-05')], guardians: clone(S.db.guardians) }, new RegExp(MINOR_WITHOUT_LINK_REASON.slice(0, 30)), 'a live minor without a guardian link');
  // Review of 6d66655, F1: the earlier expectation here — that a supplied collection REPLACES the retained set, so
  // listing a subset prunes the rest — conflicted with the promise the retained record exists for (a deletion fact
  // that survives and an id that is never re-created). A supplied collection may only ADD records: a stored record
  // that is not listed, or listed with a changed fact, refuses the whole save (ids only). The protected contract is
  // proven in the next test; here the subset is refused and both records stay.
  refused({ playersRetained: [RECORD('pl-seeded', NOW, '2004-03-14', 'GB')] }, /pl-child2/, 'a subset of the stored retained records (pruning is refused, not performed)');
  S.close();
  const r = reopen(dir); assert.deepEqual(r.players.retainedRecords(), [RECORD('pl-seeded', NOW, '2004-03-14', 'GB'), RECORD('pl-child2', NOW + 1, '2016-08-08', 'GB')]); assert.equal(r.players.byId('pl-child2'), null); r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshot contract (review of 6d66655, F1): stored retained records are PROTECTED — a supplied playersRetained collection may only add records; an empty collection, a subset, or a record whose birth date, country or deletion instant differs from the stored one refuses the WHOLE save atomically with ids only (an accompanying change to another collection is rolled back too, no transaction stays open, the tool\'s loaded view is untouched); the two-save sequence prune-then-recreate is refused at both steps and the id stays retained; a direct live-id collision is refused as before; a superset that adds a new record is accepted with every stored record byte-identical; unchanged, repeated and omitted saves stay positive controls', () => {
  const dir = tempDir('erase-protected'); const t = boot(dir, FIXTURE());
  t.players.erase('pl-seeded', { at: NOW }); t.unit(() => t.players.erase('pl-child2', { at: NOW + 1 })); t.save(); t.close();
  const S = snapshotStore(dir);
  const expected = JSON.stringify([RETAINED_ROW('pl-seeded', NOW, '2004-03-14', 'GB'), RETAINED_ROW('pl-child2', NOW + 1, '2016-08-08', 'GB')]);
  const rows = () => JSON.stringify(S.all('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid'));
  const live = () => JSON.stringify(S.all('SELECT id FROM players WHERE deleted_at IS NULL ORDER BY rowid'));
  const requestsBlob = () => S.all("SELECT value FROM collections WHERE name = 'requests'")[0]?.value ?? null;
  assert.equal(rows(), expected);
  const loadedView = JSON.stringify(S.db.playersRetained); const liveBefore = live(); const requestsBefore = requestsBlob();
  const seeded = RECORD('pl-seeded', NOW, '2004-03-14', 'GB'); const kid = RECORD('pl-child2', NOW + 1, '2016-08-08', 'GB');
  const refused = (over, pattern, label) => {
    const revBefore = S.revision();
    let err = null; try { S.save(over); } catch (e) { err = e; }
    assert.ok(err, `${label}: refused`); assert.match(String(err.message), pattern, `${label}: ${err?.message}`);
    assert.doesNotMatch(String(err.message), /2004-03-14|2016-08-08|1990-01-01|2001-05-20/, `${label}: no birth date in the message`);
    assert.equal(rows(), expected, `${label}: every stored retained row byte-identical`); assert.equal(live(), liveBefore, `${label}: live rows unchanged`);
    assert.equal(S.revision(), revBefore, `${label}: revision unchanged`); assert.equal(S.store.sqlite.isTransaction, false, `${label}: no open transaction`);
    assert.equal(JSON.stringify(S.db.playersRetained), loadedView, `${label}: the tool's loaded view is untouched`); assert.equal(requestsBlob(), requestsBefore, `${label}: an accompanying change to another collection did not land`);
  };
  refused({ playersRetained: [] }, /pl-child2|pl-seeded/, 'an empty collection');
  refused({ playersRetained: [seeded] }, /pl-child2/, 'a subset');
  refused({ playersRetained: [{ ...seeded, birthDate: '1990-01-01' }, kid] }, /pl-seeded/, 'a changed birth date');
  refused({ playersRetained: [{ ...seeded, country: 'DE' }, kid] }, /pl-seeded/, 'a changed country');
  refused({ playersRetained: [{ ...seeded, deletedAt: NOW + 1000 }, kid] }, /pl-seeded/, 'a changed deletion instant');
  refused({ playersRetained: [], requests: [{ id: 'req-rolled-back', status: 'pending' }] }, /pl-/, 'an empty collection with an accompanying requests change');
  // The two-save sequence: prune (refused), then recreate the id as a live player (refused by the identity replace: the record is still there).
  refused({ playersRetained: [] }, /pl-/, 'step one of prune-then-recreate');
  refused({ players: [...clone(S.db.players), { ...adult(), id: 'pl-seeded' }], guardians: clone(S.db.guardians) }, /pl-seeded/, 'step two of prune-then-recreate');
  refused({ playersRetained: [seeded, kid, RECORD('pl-adult', NOW, '2001-05-20', 'GB')] }, /pl-adult/, 'a direct live-id collision');
  // Positive controls: unchanged, repeated, omitted; a superset adds a record and changes nothing stored.
  let r1 = S.revision();
  S.save({}); assert.equal(rows(), expected); S.save({}); assert.equal(rows(), expected); S.save({ playersRetained: undefined }); assert.equal(rows(), expected); assert.equal(S.revision(), r1 + 3);
  S.save({ playersRetained: [seeded, kid, RECORD('pl-imported', NOW + 2, '2003-01-01', 'FR')] });
  assert.equal(rows(), JSON.stringify([...JSON.parse(expected), RETAINED_ROW('pl-imported', NOW + 2, '2003-01-01', 'FR')]), 'the new record is added; the stored rows are byte-identical');
  assert.equal(S.revision(), r1 + 4); assert.equal(S.store.sqlite.isTransaction, false);
  S.close();
  const r = reopen(dir);
  assert.deepEqual(r.players.retainedRecords(), [seeded, kid, RECORD('pl-imported', NOW + 2, '2003-01-01', 'FR')]);
  assert.throws(() => r.players.insert({ ...adult(), id: 'pl-seeded' }), /retained/, 'the id stays retained after every attempt');
  r.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('unit of work: an erase inside a unit that fails after every write — and one whose REAL COMMIT fails — leaves the account exactly as it was: the row, the child rows, the links, the session, the media queue, the pairing code; memory restored through the memento (the same held view object, the held childIds array with its content, the indexes, no retained record, the facet tracking), an unrelated pending facet edit survives; the retry lands everything once and a second erase is refused; the audit rows (a ledger row naming the player) are untouched throughout', () => {
  const dir = tempDir('erase-unit'); const t = boot(dir, FIXTURE());
  t.sessions.create('player', 'pl-child1');
  const code = t.codes.issuePairingCode('pl-child1');
  assert.ok(code?.code, 'a pairing code was issued');
  t.layer.safetyAudit.ledger.append({ id: 'led-erase', ts: NOW, type: 'view', playerId: 'pl-child1', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria' });
  t.save();
  const ledgerBefore = JSON.stringify(t.all('SELECT * FROM ledger ORDER BY seq'));
  const view = t.players.byId('pl-child1'); const kids = t.guardians.byId('gd-primary').childIds;
  const sessionsBefore = t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n; assert.equal(sessionsBefore, 1);
  const stateOf = () => JSON.stringify({ row: t.row('pl-child1'), children: t.childRows('pl-child1'), links: t.links('pl-child1'), sessions: t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n, queue: t.raw('SELECT COUNT(*) AS n FROM media_deletions').n, codes: t.raw("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-child1'").n, ledger: t.all('SELECT * FROM ledger ORDER BY seq') });
  const before = stateOf(); const r0 = t.revision();
  // An unrelated pending facet edit, made before the unit (the seeded adult's unknown field).
  t.players.byId('pl-seeded').futureField.nested.push(3);
  const attempt = (label, failHow) => {
    assert.throws(() => t.unit(() => {
      t.mediaDeletions.enqueue(['med-x'], { playerId: 'pl-child1', at: NOW });
      t.sessions.revokeFor('player', 'pl-child1');
      t.codes.revokePairingCodesFor('pl-child1');
      t.players.erase('pl-child1', { at: NOW });
      assert.equal(t.players.byId('pl-child1'), null, `${label}: inside the unit the account is gone`); assert.equal(t.players.isRetained('pl-child1'), true);
      failHow();
    }), /synthetic|constraint failed|FOREIGN KEY/i, `${label}: the unit fails`);
    assert.equal(stateOf(), before, `${label}: the file is exactly as before`); assert.equal(t.revision(), r0, `${label}: no save`);
    assert.equal(t.players.byId('pl-child1'), view, `${label}: the same held view object`); assert.equal(view.name, 'Child pl-child1');
    assert.equal(t.guardians.byId('gd-primary').childIds, kids, `${label}: the held childIds array`); assert.deepEqual([...kids], ['pl-child1', 'pl-child2']);
    assert.equal(t.players.isRetained('pl-child1'), false); assert.equal(t.players.retainedCount(), 0); assert.equal(t.db.players.some((p) => p.id === 'pl-child1'), true);
    assert.deepEqual(t.players.byGuardian('gd-primary').map((p) => p.id), ['pl-child1', 'pl-child2']); assert.deepEqual(t.guardians.linksOf('pl-child1'), [{ guardianId: 'gd-primary', role: 'primary' }, { guardianId: 'gd-co', role: 'co' }]);
    assert.deepEqual(t.players.byId('pl-seeded').futureField.nested, [1, 2, 3], `${label}: the unrelated pending edit survives`);
  };
  attempt('failure after the writes', () => { throw new Error('synthetic failure after the erase'); });
  attempt('failure at the real COMMIT', () => t.store.failCommitOfOpenTransaction());
  // The retry lands everything once.
  t.unit(() => { t.mediaDeletions.enqueue(['med-x'], { playerId: 'pl-child1', at: NOW }); t.sessions.revokeFor('player', 'pl-child1'); t.codes.revokePairingCodesFor('pl-child1'); t.players.erase('pl-child1', { at: NOW }); });
  assert.deepEqual(t.row('pl-child1'), RETAINED_ROW('pl-child1', NOW, '2014-03-03', 'GB')); assert.equal(t.childRows('pl-child1'), 0); assert.deepEqual(t.links('pl-child1'), []);
  assert.equal(t.raw("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = 'pl-child1'").n, 0); assert.equal(t.raw("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-child1'").n, 0); assert.equal(t.raw('SELECT COUNT(*) AS n FROM media_deletions').n, 1);
  assert.equal(t.players.byId('pl-child1'), null); assert.deepEqual([...kids], ['pl-child2']); assert.equal(t.players.retainedCount(), 1);
  assert.throws(() => t.unit(() => t.players.erase('pl-child1', { at: NOW })), /retained/);
  t.save(); assert.equal(JSON.stringify(t.all('SELECT * FROM ledger ORDER BY seq')), ledgerBefore, 'the ledger row naming the deleted child is exactly as it was');
  assert.deepEqual(JSON.parse(t.raw("SELECT facets_json FROM players WHERE id = 'pl-seeded'").facets_json).futureField.nested, [1, 2, 3], 'the unrelated edit persisted with the next save');
  t.close(); fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ migration 0014
test('migration 0014_player_erasure: registered last; on a file this build\'s predecessor wrote (0001–0013) it records the step and its counts and changes no row and no table; a restored backup\'s playersRetained blob is imported as retained rows exactly and the blob retired; a blob naming a live player, a malformed entry, a duplicate id, or a players row that already carries deleted_at refuses the step with ids only — nothing written, the blob untouched, the next run refuses the same way; a second run is a no-op', () => {
  assert.equal(DATA_MIGRATIONS.map((m) => m.id).at(-5), MIGRATION, 'registered after 0013 (S8a\'s 0015, S8b\'s 0016, S8c\'s 0017 and S8d\'s 0018 follow it)');
  const preS4bR = (dir, { rawBlobs = {} } = {}) => { s3File(dir, { extra: { requests: [], channels: [], notifications: [], dispatches: [], blocks: [], reports: [], moderationLog: [], orgNotes: [], ledger: [], opsEvents: [], sourceChanges: [], idvQueue: [] }, rawBlobs }); const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }); return s; };
  const tables = (s) => s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  // (a) a plain file.
  const a = tempDir('m14-plain'); let s = preS4bR(a);
  const tablesBefore = tables(s); const playersBefore = JSON.stringify(s.prepare('SELECT * FROM players ORDER BY rowid').all());
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }).ran, [MIGRATION, '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']); // S8a–S8d: 0015–0018 follow on the same run
  assert.ok(applied(s).includes(MIGRATION)); assert.deepEqual(JSON.parse(meta(s, META)), { at: NOW, imported: 0 }); assert.deepEqual(tables(s).filter((t) => !RECRUITMENT_TABLES.includes(t) && !RECRUITMENT_CASES_TABLES.includes(t) && !RECRUITMENT_CONTACTS_OFFERS_TABLES.includes(t) && !SIGNINGS_FOLLOWUPS_TABLES.includes(t)), tablesBefore, 'no table created by 0014 (the fifteen recruitment tables are 0015\'s, S8a; the twenty-five case and room tables 0016\'s, S8b)'); assert.equal(JSON.stringify(s.prepare('SELECT * FROM players ORDER BY rowid').all()), playersBefore);
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { now: NOW + 1 }).ran, [], 'never twice'); s.close();
  // (b) a restored backup carrying retained records.
  const b = tempDir('m14-restore'); s = preS4bR(b, { rawBlobs: { playersRetained: JSON.stringify([RECORD('pl-gone', NOW - DAY, '2001-01-01', 'GB'), RECORD('pl-gone2', NOW - 2 * DAY, '2010-12-31', 'KR')]) } });
  assert.deepEqual(runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }).ran, [MIGRATION, '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']); // S8a and S8b: 0015 and 0016 follow on the same run
  assert.deepEqual(s.prepare('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid').all().map((r) => ({ ...r })), [RETAINED_ROW('pl-gone', NOW - DAY, '2001-01-01', 'GB'), RETAINED_ROW('pl-gone2', NOW - 2 * DAY, '2010-12-31', 'KR')]);
  assert.equal(blob(s, 'playersRetained'), undefined, 'the blob is retired'); assert.deepEqual(JSON.parse(meta(s, META)), { at: NOW, imported: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(readTableBacked(s).playersRetained)), [RECORD('pl-gone2', NOW - 2 * DAY, '2010-12-31', 'KR'), RECORD('pl-gone', NOW - DAY, '2001-01-01', 'GB')], 'the snapshot read lists retained records by deletion instant, then id'); s.close();
  // (c) refusals: nothing written, the blob untouched, the same refusal again.
  const refuses = (tag, rawBlobs, pattern, { tamper = null } = {}) => {
    const d = tempDir(`m14-${tag}`); const c = preS4bR(d, { rawBlobs }); if (tamper) tamper(c);
    const before = JSON.stringify(dump(c, { except: ['data_migrations'] })); const appliedBefore = applied(c);
    for (const round of [1, 2]) {
      let err = null; try { runDataMigrations(c, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }); } catch (e) { err = e; }
      assert.ok(err, `${tag} (round ${round}): refused`); assert.match(String(err.message), pattern, tag); assert.match(String(err.message), /PLAYER_ERASURE_IMPORT_BLOCKED|UNEXPECTED/, tag);
      assert.doesNotMatch(String(err.message), /2001-01-01|2001-05-20/, `${tag}: no birth date in the message`);
      assert.equal(JSON.stringify(dump(c, { except: ['data_migrations'] })), before, `${tag}: nothing written`); assert.deepEqual(applied(c), appliedBefore, `${tag}: no record`);
    }
    c.close(); fs.rmSync(d, { recursive: true, force: true });
  };
  refuses('collision', { playersRetained: JSON.stringify([RECORD('pl-adult', NOW, '2001-05-20', 'GB')]) }, /pl-adult/);
  refuses('shape', { playersRetained: JSON.stringify({ id: 'pl-x' }) }, /playersRetained/);
  refuses('entry', { playersRetained: JSON.stringify([{ id: 'pl-x', deletedAt: NOW, birthDate: '2001-01-01' }]) }, /pl-x.*country|country.*pl-x/);
  refuses('duplicate', { playersRetained: JSON.stringify([RECORD('pl-x', NOW, '2001-01-01', 'GB'), RECORD('pl-x', NOW, '2001-01-01', 'GB')]) }, /pl-x/);
  refuses('stray-deleted-at', {}, /deleted_at|pl-adult/, { tamper: (c) => c.prepare("UPDATE players SET deleted_at = ? WHERE id = 'pl-adult'").run(NOW) });
  fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
});

// ------------------------------------------------------------------ rollback (copy-only) and re-upgrade
test('rollback (copy-only): the retained rows leave the players table of the COPY and become the playersRetained legacy blob (exactly the records, in insertion order), the 0014 record and its meta key go, saveSeq advances, every other table is byte-identical, the source is untouched; refusals leave no output (a later schema step, a file that never applied 0014, a non-empty output directory, an injected failure before COMMIT); the S6b tool refuses the live file (LATER_SCHEMA) and accepts the copy; the real migration re-upgrades the copy to the same retained rows; the erased personal data is restored by nothing', () => {
  const rollbackPlayerErasureCopy = needRollback();
  const dir = tempDir('erase-rb'); const t = boot(dir, FIXTURE());
  t.players.erase('pl-seeded', { at: NOW }); t.unit(() => t.players.erase('pl-child2', { at: NOW + 5 })); t.save(); t.close();
  // S8a: the live file carries 0015, which this tool refuses outright (LATER_SCHEMA); the S8a rollback (copy-only) goes first and this tool works on ITS output
  { const o = tempDir('erase-rb-s8a-refused'); let err = null; try { rollbackPlayerErasureCopy(dbFile(dir), o); } catch (e) { err = e; } assert.equal(err?.code, 'LATER_SCHEMA'); assert.match(err.message, /0015_recruitment/); assert.deepEqual(fs.readdirSync(o), []); }
  const s8c = tempDir('erase-rb-s8c'); rollbackRecruitmentContactsOffersCopy(dbFile(dir), s8c); // S8d then S8c: the live file carries 0018 and 0017 too; their rollbacks go first
  const s8b = tempDir('erase-rb-s8b'); rollbackRecruitmentCasesCopy(dbFile(s8c), s8b); // then S8b (0016)
  const s8a = tempDir('erase-rb-s8a'); rollbackRecruitmentCopy(dbFile(s8b), s8a);
  const source = dbFile(s8a); const sourceBytes = fs.readFileSync(source);
  const out = tempDir('erase-rb-out');
  const result = rollbackPlayerErasureCopy(source, out);
  assert.equal(result.output, dbFile(out)); assert.equal(result.recordRemoved, true); assert.equal(result.retained, 2);
  assert.ok(fs.readFileSync(source).equals(sourceBytes), 'the source file is byte-identical');
  const s = openRaw(s8a); const c = openRaw(out); // compared with THIS tool's source, the S8a-rolled copy
  assert.ok(!applied(c).includes(MIGRATION)); assert.equal(meta(c, META), undefined); assert.equal(Number(meta(c, 'saveSeq')), Number(meta(s, 'saveSeq')) + 1);
  assert.deepEqual(blob(c, 'playersRetained'), [RECORD('pl-seeded', NOW, '2004-03-14', 'GB'), RECORD('pl-child2', NOW + 5, '2016-08-08', 'GB')], 'the legacy blob: exactly the records');
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM players WHERE deleted_at IS NOT NULL').get().n, 0); assert.deepEqual(c.prepare("SELECT id FROM players WHERE id IN ('pl-seeded', 'pl-child2')").all(), [], 'no retained row in the copy\'s table');
  const except = ['data_migrations', 'meta', 'players', 'collections'];
  assert.equal(JSON.stringify(dump(c, { except })), JSON.stringify(dump(s, { except })), 'every other table byte-identical');
  assert.equal(JSON.stringify(c.prepare('SELECT * FROM players ORDER BY rowid').all()), JSON.stringify(s.prepare('SELECT * FROM players WHERE deleted_at IS NULL ORDER BY rowid').all()), 'the live rows identical');
  assert.equal(JSON.stringify(c.prepare("SELECT name, value FROM collections WHERE name <> 'playersRetained' ORDER BY name").all()), JSON.stringify(s.prepare('SELECT name, value FROM collections ORDER BY name').all()), 'every other blob identical');
  assert.equal(c.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); c.close();
  // Refusals leave no output.
  const refuse = (tag, file, code, opts = {}) => { const o = tempDir(`erase-rb-${tag}`); let err = null; try { rollbackPlayerErasureCopy(file, o, opts); } catch (e) { err = e; } assert.equal(err?.code, code, `${tag}: ${err?.message}`); assert.deepEqual(fs.readdirSync(o), [], `${tag}: no output`); fs.rmSync(o, { recursive: true, force: true }); };
  const later = tempDir('erase-rb-later'); fs.copyFileSync(source, dbFile(later)); { const l = openRaw(later); l.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)').run('0099_future', NOW); l.close(); }
  refuse('later', dbFile(later), 'LATER_SCHEMA');
  refuse('not-cut-over', dbFile(out), 'NOT_CUT_OVER');
  refuse('fail-before-commit', source, undefined, { _failBeforeCommit: true });
  { const busy = tempDir('erase-rb-busy'); fs.writeFileSync(path.join(busy, 'x'), ''); let err = null; try { rollbackPlayerErasureCopy(source, busy); } catch (e) { err = e; } assert.equal(err?.code, 'OUTPUT_NOT_EMPTY'); assert.deepEqual(fs.readdirSync(busy), ['x']); }
  // The S6b tool refuses the live file and accepts the copy; the chain to S7d works on this tool's output.
  { const o = tempDir('erase-rb-s6b-refused'); let err = null; try { rollbackSafetyAuditCopy(source, o); } catch (e) { err = e; } assert.equal(err?.code, 'LATER_SCHEMA'); assert.deepEqual(fs.readdirSync(o), []); }
  { const o = tempDir('erase-rb-s6b'); rollbackSafetyAuditCopy(dbFile(out), o); const x = openRaw(o); assert.ok(!applied(x).includes('0013_safety_audit')); assert.deepEqual(blob(x, 'playersRetained').map((r) => r.id), ['pl-seeded', 'pl-child2'], 'the blob travels down the chain'); x.close(); }
  // Re-upgrade: the real migration imports the blob back, to the same rows.
  const up = openRaw(out);
  assert.deepEqual(runDataMigrations(up, DATA_MIGRATIONS, { now: NOW + 9, context: { sessionTtlMs: TTL } }).ran, [MIGRATION, '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']); // S8a and S8b: 0015 and 0016 follow on the same run
  assert.equal(JSON.stringify(up.prepare('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid').all()), JSON.stringify(s.prepare('SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid').all()), 'the retained rows are exactly those of the source');
  assert.equal(blob(up, 'playersRetained'), undefined); assert.deepEqual(JSON.parse(meta(up, META)), { at: NOW + 9, imported: 2 });
  assert.equal(up.prepare("SELECT name FROM players WHERE id = 'pl-seeded'").get().name, 'Deleted player', 'nothing of the person came back');
  up.close(); s.close();
  for (const d of [dir, s8a, out, later]) fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\n${passed} player-erasure checks passed`);
