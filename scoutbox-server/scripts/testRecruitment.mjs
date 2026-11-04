// S8a — recruitment requests and accepted trials as typed tables with EXPLICIT writes (repositories/recruitment.mjs,
// migration 0015; docs/architecture/migration.md §4.3). What this suite proves: the migration creates the sixteen typed
// tables (no lossless side column, the vocabulary CHECKs, the case key immediate and the trial key deferred to COMMIT) and channels with
// the real request key; a snapshot save (fixtures, tools) types every writer shape into its columns and reads back the
// typed record, refuses a record it cannot type and names every missing reference with ids; the player references are
// counted, never refused (Q7a), and a missing guardian is refused (Q7c); the repository's operations write rows at once
// and return fresh read-only records, there is no db.* view (§4.3 step 2) and every query matches a table scan, a unit
// of work rolls the rows back and a read inside it sees its writes,
// and a request or a trial may name a case the staged S8b repository writes at the same unit's COMMIT; the deletion
// unit's tombstones; the derived trial reports; the live report.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { legacyTrialRequest, contactRequest, openDayRequest, p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, acceptedTrial, preP4bTrial, workedTrial, cancelledTrial, report, CASES, persisted, T, saveFixture, fixtureDb } from './recruitmentTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const MIGRATION = '0015_recruitment';
const rec = await import('../repositories/recruitment.mjs');
const TABLES = rec.RECRUITMENT_TABLES;
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const withRo = (dir, fn) => { const s = second(dir); try { return fn(s); } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const recDump = (s) => JSON.stringify(TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))));
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const CHANNEL = (over = {}) => ({ id: 'chan-1', requestId: 'req-p4b', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T.accepted, messages: [], readBy: { org: null, counterparty: null }, ...over });
/** The typed expectation of a writer's literal: what every read returns. */
const typed = (name, raw) => { const t = (name === 'requests' ? rec.typeRequest : rec.typeTrial)(persisted(raw)); assert.ok(t.ok, t.reason); return plain(t.record); };

/** Every writer shape: the accepted P4B pair (req-p4b ↔ trial-1, thread chan-1), a contact, an open-day invitation, a pending date-only invitation, the minor's invitation, and the M12-shaped reported trial on req-old. */
const FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), contactRequest(), openDayRequest(), legacyTrialRequest(), minorInvitation(), legacyTrialRequest({ id: 'req-old', status: 'accepted', respondedAt: T.accepted - 30 * 86_400_000, respondedBy: 'player', contactChannel: null })], trials: [scheduledTrial(), preP4bTrial()] });
function fixtureCollections({ requests, trials, cases = CASES(), channels = [CHANNEL()], more = {} } = {}) {
  const db = { notifications: [], dispatches: [], recruitmentCases: cases, ...more };
  if (requests !== undefined) db.requests = requests; if (trials !== undefined) db.trials = trials; if (channels !== undefined) db.channels = channels;
  return db;
}
const file = (tag, fixture = FIX()) => saveFixture(tempDir(`s8a-${tag}`), fixtureCollections(fixture));
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /Adult Signup|Come and train|Gate B|Harbour Road|Quick feet/, `${label}: ids only, never a name, a message or an address`); return err; };
/** Save the fixtures, with `over`, into a new database and expect the save refused, atomically, twice. */
const refusedSave = (tag, fixture, pattern) => {
  const d = tempDir(`s8a-ref-${tag}`); const st = openStore(d); const before = fullDump(st.sqlite);
  for (const label of [tag, `${tag} (again)`]) { refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(fixtureCollections(fixture)) }), pattern, label); assert.equal(st.sqlite.isTransaction, false); assert.equal(fullDump(st.sqlite), before, `${label}: nothing written`); assert.equal(st.revision(), 0); }
  st.sqlite.close(); rm(d);
};
function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const loaded = store.load();
  const db = { ...loaded.db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, layer, db, snapshot, save: () => store.save(snapshot()), unit: (w) => store.unitOfWork(w, { snapshot }), revision: () => store.revision(), repo: layer.recruitment, close: () => store.sqlite.close() };
}
function snapshotOpen(dir) {
  const store = openStore(dir); const db = store.load().db;
  const save = (over = {}, { omit = [] } = {}) => { const d = { ...db, ...over }; for (const k of omit) delete d[k]; return store.save({ savedAt: NOW, idCounter: 1000, db: d }); };
  return { store, db, save, revision: () => store.revision(), close: () => store.sqlite.close() };
}

test('[schema] migration 0015 is registered before 0016–0018 and creates the sixteen typed STRICT tables (no lossless side column, the vocabulary CHECKs, the case key immediate and the trial key deferred to COMMIT) and channels with the real request key; a fresh database holds no row and no blob', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id); assert.ok(ids.indexOf(MIGRATION) >= 0 && ids.indexOf(MIGRATION) < ids.indexOf('0016_recruitment_cases'), '0015 before 0016');
  for (const n of rec.RECRUITMENT_COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const d = tempDir('s8a-fresh'); const f = openStore(d).sqlite;
  for (const t of TABLES) {
    const sql = ddlOf(f, t); assert.ok(sql, `${t} exists`); assert.match(sql, /STRICT\s*$/, `${t} is STRICT`); assert.equal(col(f, `SELECT count(*) FROM ${t}`), 0);
    for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!f.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c), `${t}: no ${c}`);
  }
  for (const t of ['recruitment_requests', 'trials']) assert.match(ddlOf(f, t), /case_id TEXT REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/, `${t}.case_id is an immediate key: the case is written first`);
  assert.match(ddlOf(f, 'recruitment_requests'), /trial_id TEXT REFERENCES trials\(id\) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddlOf(f, 'trials'), /request_id TEXT NOT NULL UNIQUE REFERENCES recruitment_requests\(id\) ON DELETE RESTRICT/);
  assert.match(ddlOf(f, 'recruitment_requests'), /status IN \('pending','accepted','declined','suspended'\)/); assert.match(ddlOf(f, 'trials'), /workflow_state IN \('legacy_accepted'/); assert.match(ddlOf(f, 'trial_attendance'), /source IN \('checkin','manual'\)/);
  assert.deepEqual(f.prepare('PRAGMA foreign_key_list(channels)').all().map((x) => [x.from, x.table, x.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  for (const n of rec.RECRUITMENT_COLLECTIONS) assert.equal(col(f, 'SELECT count(*) FROM collections WHERE name = ?', n), 0, `no ${n} blob`);
  f.close(); rm(d);
});

test('[snapshot][typed] every writer shape is typed into its columns and reads back as the typed record (an absent field null, an absent list empty, the trial-day container, the five key lists and the reminder map always present): the P4B invitation (slots, private details, invitation key, recipient), the contact, the open-day literal, the legacy and the minor\'s invitations, the scheduled, accepted, M12-shaped, worked and cancelled trials', () => {
  const fix = FIX(); const extra = { requests: [legacyTrialRequest({ id: 'req-legacy2', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', trialId: 'trial-legacy' }), legacyTrialRequest({ id: 'req-worked', status: 'accepted', trialId: 'trial-worked', caseId: 'case-2', respondedAt: T.accepted, respondedBy: 'player' }), legacyTrialRequest({ id: 'req-cancelled', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', trialId: 'trial-cancelled' })], trials: [acceptedTrial({ requestId: 'req-legacy2' }), workedTrial({ id: 'trial-worked', requestId: 'req-worked', caseId: 'case-2', report: report({ trialId: 'trial-worked' }) }), cancelledTrial({ caseId: null })] };
  const all = { requests: [...fix.requests, ...extra.requests], trials: [...fix.trials, ...extra.trials] };
  const d = file('typed', all); const S = snapshotOpen(d);
  assert.deepEqual(plain(S.db.requests), all.requests.map((r) => typed('requests', r)), 'every request reads back as its typed record');
  assert.deepEqual(plain(S.db.trials), all.trials.map((t) => typed('trials', t)), 'every trial reads back as its typed record');
  const worked = S.db.trials.find((t) => t.id === 'trial-worked');
  assert.equal(worked.schedule.sessions[0].evidence.length, 2); assert.equal(worked.day.staff[0].check.status, 'pending'); assert.equal(worked.report.coachRating, 8); assert.equal(worked.reminders['t48:tses-2:2'], T.session + 86_400_000 - 48 * 3_600_000); assert.equal(worked.keys.schedule[0].key, 'k-sched-1');
  const old = S.db.trials.find((t) => t.id === 'trial-old'); assert.deepEqual(plain(old.day), { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] }, 'a trial without a day reads back with the empty container'); assert.deepEqual(Object.keys(old.keys).sort(), ['attendance', 'cancel', 'complete', 'link', 'schedule']);
  const contact = S.db.requests.find((r) => r.id === 'req-contact'); assert.equal(contact.trialDetails, null); assert.equal(contact.subject, 'Next season');
  const inv = S.db.requests.find((r) => r.id === 'req-p4b'); assert.equal(inv.trialDetails.slots.length, 2); assert.deepEqual(plain(inv.trialDetails.private), { venueAddress: '1 Harbour Road', instructions: 'Gate B, ask for Maria' }); assert.deepEqual(plain(inv.keys.invite), { key: 'client-key-1', fp: 'fp-1' });
  const before = withRo(d, recDump); S.save(); assert.equal(withRo(d, recDump), before, 'an unchanged snapshot re-saved writes the same rows'); S.close(); rm(d);
});

test('[snapshot][typed] a save STOPS with the ids on a record the tables cannot hold — nothing written, the revision unchanged, the same save refused again: an unknown field (top level and nested), a status outside the vocabulary, an off-type rev, a trial without its request, a request naming no case, a missing guardian, a request naming a trial that does not name it back, two open trials in one case, alien entries (each one named)', () => {
  const fix = FIX();
  refusedSave('unknown field', { ...fix, requests: [{ ...fix.requests[0], legacyFlag: true }, ...fix.requests.slice(1)] }, /RECRUITMENT_INPUT_INVALID[\s\S]*req-p4b\.record\.legacyFlag is not a field/);
  refusedSave('unknown nested field', { ...fix, trials: [scheduledTrial({ blockedBy: null, keys: { accept: { key: null, fp: 'x' } } }), fix.trials[1]] }, /trial-1\.record\.blockedBy|trial-1\.keys\.accept/);
  refusedSave('status', { ...fix, requests: [{ ...fix.requests[0], status: 'maybe' }, ...fix.requests.slice(1)] }, /req-p4b\.status must be one of/);
  refusedSave('off-type rev', { ...fix, trials: [scheduledTrial({ rev: '3' }), fix.trials[1]] }, /trial-1\.rev must be an integer/);
  refusedSave('trial without its request', { ...fix, trials: [...fix.trials, acceptedTrial({ id: 'trial-orphan', requestId: 'req-ghost' })] }, /FOREIGN KEY|RECRUITMENT_REFERENCE_MISSING[\s\S]*trial-orphan/);
  refusedSave('request naming no case', { ...fix, requests: [...fix.requests, p4bInvitation({ id: 'req-ghost-case', caseId: 'case-ghost', trialId: null })] }, /RECRUITMENT_CASE_MISSING[\s\S]*req-ghost-case → recruitment_cases case-ghost/);
  refusedSave('missing guardian', { ...fix, requests: [...fix.requests, minorInvitation({ id: 'req-ghost-g', guardianId: 'gd-ghost', recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-ghost', minor: true }, caseId: null })] }, /RECRUITMENT_GUARDIAN_MISSING[\s\S]*req-ghost-g → guardians gd-ghost/);
  refusedSave('pair mismatch', { ...fix, requests: [...fix.requests.map((r) => (r.id === 'req-old' ? { ...r, trialId: 'trial-1' } : r))] }, /RECRUITMENT_PAIR_MISMATCH[\s\S]*req-old → trial-1/);
  refusedSave('two open trials in one case', { requests: [...fix.requests, legacyTrialRequest({ id: 'req-second', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', caseId: 'case-1' })], trials: [...fix.trials, acceptedTrial({ id: 'trial-second', requestId: 'req-second', caseId: 'case-1' })] }, /UNIQUE constraint failed: trials\.case_id/);
  const e = (() => { const dd = tempDir('s8a-alien'); const st = openStore(dd); try { return refused(() => st.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(fixtureCollections({ ...fix, trials: [fix.trials[0], null, 'x', 7] })) }), /RECRUITMENT_INPUT_INVALID/, 'alien'); } finally { st.sqlite.close(); rm(dd); } })();
  for (const n of [1, 2, 3]) assert.match(e.message, new RegExp(`trials entry #${n} is not an object`), `alien entry #${n} named`);
});

test('[snapshot] the collection rule: an omitted collection is retained whole; an array IS the whole final collection (an unlisted trial departs with its children and the request\'s back-reference is cleared, an unlisted request departs after the threads that named it); a request still named by a thread refuses the save with the thread\'s id (CHANNEL_REQUEST_MISSING); Q7a: a missing player is stored and counted, never refused', () => {
  const d = file('rule'); const S = snapshotOpen(d);
  S.save({ recruitmentCases: S.db.recruitmentCases }, { omit: ['requests', 'trials'] }); assert.equal(withRo(d, (s) => col(s, 'SELECT count(*) FROM trials')), 2, 'omitted: retained');
  S.save({ trials: S.db.trials.filter((t) => t.id !== 'trial-1') }, { omit: ['requests'] });
  withRo(d, (s) => { assert.equal(col(s, "SELECT count(*) FROM trials WHERE id = 'trial-1'"), 0); for (const t of ['trial_schedule_sessions', 'trial_revision_sessions', 'trial_history']) assert.equal(col(s, `SELECT count(*) FROM ${t} WHERE trial_id = 'trial-1'`), 0, `${t}: its rows went with it`); assert.equal(col(s, "SELECT trial_id FROM recruitment_requests WHERE id = 'req-p4b'"), null, 'the retained request\'s back-reference is cleared (SET NULL)'); });
  refused(() => S.save({ requests: S.db.requests.filter((r) => r.id !== 'req-p4b') }, { omit: ['trials', 'channels'] }), /CHANNEL_REQUEST_MISSING[\s\S]*chan-1/, 'a request removed under its thread');
  const nowRequests = () => S.db.requests.map((r) => (r.id === 'req-p4b' ? { ...r, trialId: null } : r)); // the request as the tables hold it now (its trial departed)
  S.save({ requests: nowRequests().filter((r) => r.id !== 'req-contact') }, { omit: ['trials'] }); assert.equal(withRo(d, (s) => col(s, "SELECT count(*) FROM recruitment_requests WHERE id = 'req-contact'")), 0, 'an unlisted request departs');
  S.save({ requests: [...nowRequests().filter((r) => r.id !== 'req-contact'), contactRequest({ id: 'req-gone-player', playerId: 'pl-gone' })] }, { omit: ['trials'] }); S.close();
  const L = serverOpen(d); assert.equal(L.layer.report().domains.recruitment.unresolvedPlayerReferences.requests, 1, 'the missing player is counted'); L.close(); rm(d);
});

test('[repository] explicit writes: there is no db.requests or db.trials (reading or assigning throws, naming the repository) and every returned record is read-only (a field assignment and a nested push throw); create and update write their rows at once and return the stored record; an update is typed whole (a refusal changes nothing), cannot change an identifier, and names no value; a duplicate create is refused; byId', () => {
  const d = file('repo'); const L = serverOpen(d); const { requests, trials } = L.repo;
  for (const n of ['requests', 'trials']) { assert.throws(() => L.db[n], new RegExp(`db\\.${n} is gone: read it through the recruitment repository`)); assert.throws(() => { L.db[n] = []; }, /is gone/); assert.equal(Object.keys(L.db).includes(n), false); }
  assert.throws(() => { trials.byId('trial-1').status = 'reported'; }, /read only|Cannot assign/); assert.throws(() => trials.byId('trial-1').history.push({}), /not extensible|read only|Cannot add/);
  const made = requests.create(contactRequest({ id: 'req-new' })); assert.equal(made.id, 'req-new'); assert.throws(() => { made.status = 'accepted'; }, /read only|Cannot assign/);
  assert.equal(withRo(d, (s) => col(s, "SELECT status FROM recruitment_requests WHERE id = 'req-new'")), 'pending', 'written at once, no save');
  refused(() => requests.create(contactRequest({ id: 'req-new' })), /RECRUITMENT_DUPLICATE[\s\S]*req-new/, 'duplicate');
  const answered = requests.update('req-new', (x) => { x.status = 'accepted'; x.respondedAt = NOW; x.respondedBy = 'player'; }); assert.equal(answered.status, 'accepted'); assert.equal(requests.byId('req-new').status, 'accepted', 'a read serves the stored record');
  const rows = withRo(d, recDump);
  refused(() => requests.update('req-new', (x) => { x.status = 'maybe'; }), /req-new\.status must be one of/, 'vocabulary'); refused(() => requests.update('req-new', (x) => { x.playerId = 'pl-other'; }), /playerId cannot change/, 'identifier');
  refused(() => trials.update('trial-1', (x) => { x.attendance.push({ sessionId: 'tses-1', state: 'how it went', source: 'manual', recordedAt: NOW }); }), /attendance\[0\]\.state must be one of/, 'nested vocabulary');
  assert.equal(withRo(d, recDump), rows, 'a refused update changed no row'); assert.equal(requests.byId('req-new').status, 'accepted', 'nor a read');
  const t = trials.update('trial-1', (x) => { x.attendance.push({ sessionId: 'tses-1', state: 'attended', source: 'manual', recordedBy: { kind: 'org', userId: 'usr-1', name: 'Maria' }, recordedAt: NOW, note: null }); x.rev += 1; });
  assert.equal(t.attendance.length, 1); assert.equal(withRo(d, (s) => col(s, "SELECT count(*) FROM trial_attendance WHERE trial_id = 'trial-1'")), 1); assert.equal(trials.byId('trial-1').rev, 2); assert.equal(trials.byId('trial-ghost'), null);
  L.close(); rm(d);
});

test('[repository] a unit of work: a request and a trial written in a unit with the case created first in the same unit commit together; a unit that fails rolls the rows back while a read inside it sees its writes; a request naming a missing case refuses the whole unit with its ids', () => {
  const d = file('unit'); const L = serverOpen(d); const { requests, trials } = L.repo;
  const rows = withRo(d, recDump); const before = JSON.stringify(L.repo.exportAll().requests);
  assert.throws(() => L.unit(() => { requests.create(contactRequest({ id: 'req-u' })); trials.update('trial-1', (x) => { x.rev += 1; }); assert.ok(requests.byId('req-u'), 'a read inside the unit sees its create'); assert.equal(trials.byId('trial-1').rev, 2); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  assert.equal(withRo(d, recDump), rows, 'no row changed'); assert.equal(JSON.stringify(L.repo.exportAll().requests), before, 'a fresh read sees the rollback'); assert.equal(trials.byId('trial-1').rev, 1);
  assert.throws(() => L.unit(() => { requests.create(p4bInvitation({ id: 'req-ghost', caseId: 'case-ghost', trialId: null, keys: { invite: null } })); }), /RECRUITMENT_CASE_MISSING[\s\S]*req-ghost → recruitment_cases case-ghost/, 'a request naming no case is refused with its ids (the case key is immediate)');
  assert.equal(requests.byId('req-ghost'), null); assert.equal(withRo(d, (s) => col(s, "SELECT count(*) FROM recruitment_requests WHERE id = 'req-ghost'")), 0);
  const kase = { ...CASES()[0], id: 'case-new' };
  L.unit(() => { L.layer.recruitmentCases.cases.create(kase); requests.create(p4bInvitation({ id: 'req-case-new', caseId: 'case-new', trialId: null, keys: { invite: null } })); });
  withRo(d, (s) => { assert.equal(col(s, "SELECT case_id FROM recruitment_requests WHERE id = 'req-case-new'"), 'case-new'); assert.equal(col(s, "SELECT count(*) FROM recruitment_cases WHERE id = 'case-new'"), 1); });
  L.close(); rm(d);
});

test('[repository] SQL reads (§4.3 step 2): byId and every list query return exactly what a scan of the tables would, in insertion order; the counts agree; the sweep queries are the old filters (report overdue, confirmed and open, completed a week ago without the reminder); the staff-check pages walk every check, pending only or all, at every page size; `reads` carries no write', () => {
  const d = file('reads'); const L = serverOpen(d); const { requests, trials } = L.repo;
  const all = L.repo.exportAll();
  assert.ok(all.requests.length >= 3 && all.trials.length >= 1, 'the fixture has records to query');
  const ids = (rows) => rows.map((r) => r.id);
  const values = (list, key) => [...new Set(list.map(key).filter((v) => v !== null && v !== undefined)), 'nobody'];
  const check = (label, got, want) => assert.deepEqual(ids(got), ids(want), label);
  for (const [name, repo] of [['requests', requests], ['trials', trials]]) {
    for (const r of all[name]) assert.deepEqual(plain(repo.byId(r.id)), plain(r), `${name}.byId ${r.id}`);
    for (const bad of ['nope', undefined, null, 42]) assert.equal(repo.byId(bad), null);
    for (const [key, q] of [['orgId', 'forOrg'], ['playerId', 'forPlayer'], ['caseId', 'forCase']]) for (const v of values(all[name], (r) => r[key])) check(`${name}.${q} ${v}`, repo[q](v), all[name].filter((r) => r[key] === v));
    for (const r of all[name]) check(`${name}.forOrgPlayer`, repo.forOrgPlayer(r.orgId, r.playerId), all[name].filter((x) => x.orgId === r.orgId && x.playerId === r.playerId));
    const players = values(all[name], (r) => r.playerId); check(`${name}.forPlayers`, repo.forPlayers([...players, 42, null, players[0]]), all[name].filter((r) => players.includes(r.playerId))); assert.deepEqual(repo.forPlayers([]), []);
    for (const v of values(all[name], (r) => r.orgId)) assert.equal(repo.countForOrg(v), all[name].filter((r) => r.orgId === v).length);
  }
  for (const t of all.trials) for (const st of [t.status, 'nothing']) { check(`trials.forOrgStatus ${st}`, trials.forOrgStatus(t.orgId, st), all.trials.filter((x) => x.orgId === t.orgId && x.status === st)); assert.equal(trials.countForOrgStatus(t.orgId, st), all.trials.filter((x) => x.orgId === t.orgId && x.status === st).length); }
  for (const at of [0, NOW, NOW + 400 * 86_400_000]) {
    check(`trials.reportOverdue ${at}`, trials.reportOverdue(at), all.trials.filter((t) => Number.isFinite(t.reportDueAt) && t.reportDueAt < at && !t.report && !t.feedbackEscalatedAt && !t.subjectRemovedAt));
    check(`trials.completedUnreminded ${at}`, trials.completedUnreminded(at), all.trials.filter((t) => t.completion?.state === 'completed' && t.completion.at <= at && !t.subjectRemovedAt && !t.reminders?.assessmentPending));
  }
  check('trials.confirmedOpen', trials.confirmedOpen(), all.trials.filter((t) => t.schedule?.confirmedAt && !t.completion && !t.subjectRemovedAt));
  const checks = (pendingOnly) => all.trials.flatMap((t) => (t.day?.staff ?? []).filter((x) => x.check && (!pendingOnly || x.check.status === 'pending')).map((x) => `${t.id}/${x.id}`));
  const walk = (pendingOnly, limit) => { const seen = []; let after = null; for (let i = 0; i < 50; i += 1) { const page = trials.staffChecksPage({ pendingOnly, limit, after }); seen.push(...page.items.map((r) => `${r.trialId}/${r.staffId}`)); if (!page.nextCursor) return seen; after = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')); } throw new Error('the pages never ended'); };
  for (const pendingOnly of [true, false]) for (const limit of [1, 2, 100]) assert.deepEqual(walk(pendingOnly, limit), checks(pendingOnly), `staffChecksPage pendingOnly=${pendingOnly} by ${limit}`);
  for (const n of ['requests', 'trials']) { assert.ok(Object.isFrozen(L.repo.reads[n])); assert.equal(L.repo.reads[n].byId, L.repo[n].byId); assert.equal(L.repo.reads[n].create, undefined); assert.equal(L.repo.reads[n].update, undefined); }
  assert.deepEqual(L.repo.counts(), { requests: all.requests.length, trials: all.trials.length, trialReports: all.trials.filter((t) => t.report).length });
  L.close(); rm(d);
});

test('[repository] the deletion unit: tombstoneForPlayer writes every request and trial of the player as the reduced record the callbacks build (ids, states and times kept); a tombstone that changes an identifier is refused; the derived trial reports are the reports on the player\'s trials in filing order', () => {
  const d = file('tomb'); const L = serverOpen(d);
  assert.deepEqual(L.repo.trialReportsFor('pl-adult').map((r) => r.id), ['rep-old']);
  refused(() => L.repo.tombstoneForPlayer('pl-adult', { request: (r) => ({ ...r, id: 'req-renamed' }), trial: (t) => t }), /id cannot change/, 'an identifier');
  const n = L.repo.tombstoneForPlayer('pl-adult', { request: (r) => ({ ...r, playerName: null, message: null, subjectRemovedAt: NOW }), trial: (t) => ({ ...t, playerName: null, subjectRemovedAt: NOW }) });
  assert.deepEqual(n, { requests: 5, trials: 2 });
  withRo(d, (s) => { assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE player_id = 'pl-adult' AND subject_removed_at IS NULL"), 0); assert.equal(col(s, "SELECT count(*) FROM trials WHERE player_id = 'pl-adult' AND player_name IS NOT NULL"), 0); assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE player_id = 'pl-child1' AND subject_removed_at IS NULL"), 1, 'another player\'s request untouched'); });
  L.close(); rm(d);
});

test('[capabilities] the live report: explicit write mode, no pending writes, the counts and the player counters', () => {
  const d = file('caps'); const L = serverOpen(d); const r = L.layer.report().domains.recruitment;
  assert.equal(r.mode, 'live'); assert.match(r.writeMode, /explicit/); assert.equal(r.pendingWrites, 0); assert.deepEqual(plain(r.rows), { requests: 6, trials: 2, trialReports: 1 }); assert.deepEqual(plain(r.unresolvedPlayerReferences), { requests: 0, trials: 0 });
  L.close(); rm(d);
});

console.log(`\n${passed} recruitment checks passed`);
