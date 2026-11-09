// Recruitment requests and accepted trials (repositories/recruitment.mjs, migration 0015): the typed tables, typed
// writes and refusals, SQL reads that match a table scan, units of work, the deletion unit's tombstones and the derived
// trial reports. The trial key is deferred to COMMIT so a request or trial may name a case written later in the same
// unit. Player references are counted, never refused (Q7a); a missing guardian is refused (Q7c; docs/decisions.md).
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { checkHistoryFeed } from './historyFeedCheck.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { computeTrustScore, TRUST } from '../domain.mjs';
import { openStore } from '../store.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { NOW, TTL, tempDir, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { legacyTrialRequest, contactRequest, openDayRequest, p4bInvitation, minorInvitation, acceptedRequest, scheduledTrial, acceptedTrial, session, preP4bTrial, workedTrial, cancelledTrial, report, CASES, persisted, T, saveFixture } from './recruitmentTestFixtures.mjs';

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
const recDump = (s) => JSON.stringify(TABLES.map((t) => s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }))));
const ddlOf = (s, t) => s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)?.sql ?? null;
const col = (s, sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? Object.values({ ...r })[0] : undefined; };
const CHANNEL = (over = {}) => ({ id: 'chan-1', requestId: 'req-p4b', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T.accepted, messages: [], readBy: { org: null, counterparty: null }, ...over });
/** The typed expectation of a writer's literal: what every read returns. */
const typed = (name, raw) => { const t = (name === 'requests' ? rec.typeRequest : rec.typeTrial)(persisted(raw)); assert.ok(t.ok, t.reason); return plain(t.record); };

/** Every writer shape: the accepted P4B pair (req-p4b ↔ trial-1, thread chan-1), a contact, an open-day invitation, a pending date-only invitation, the minor's invitation, and the legacy reported trial on req-old. */
const FIX = () => ({ requests: [acceptedRequest(p4bInvitation(), 'trial-1'), contactRequest(), openDayRequest(), legacyTrialRequest(), minorInvitation(), legacyTrialRequest({ id: 'req-old', status: 'accepted', respondedAt: T.accepted - 30 * 86_400_000, respondedBy: 'player', contactChannel: null })], trials: [scheduledTrial(), preP4bTrial()] });
/** FIX plus the accepted, worked (every child table) and cancelled trials, with their requests. */
const EVERY_TRIAL_SHAPE = () => {
  const fix = FIX(); const extra = { requests: [legacyTrialRequest({ id: 'req-legacy2', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', trialId: 'trial-legacy' }), legacyTrialRequest({ id: 'req-worked', status: 'accepted', trialId: 'trial-worked', caseId: 'case-2', respondedAt: T.accepted, respondedBy: 'player' }), legacyTrialRequest({ id: 'req-cancelled', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', trialId: 'trial-cancelled' })], trials: [acceptedTrial({ requestId: 'req-legacy2' }), workedTrial({ id: 'trial-worked', requestId: 'req-worked', caseId: 'case-2', report: report({ trialId: 'trial-worked' }) }), cancelledTrial({ caseId: null })] };
  return { requests: [...fix.requests, ...extra.requests], trials: [...fix.trials, ...extra.trials] };
};
function fixtureCollections({ requests, trials, cases = CASES(), channels = [CHANNEL()], more = {} } = {}) {
  const db = { notifications: [], dispatches: [], recruitmentCases: cases, ...more };
  if (requests !== undefined) db.requests = requests; if (trials !== undefined) db.trials = trials; if (channels !== undefined) db.channels = channels;
  return db;
}
const file = (tag, fixture = FIX()) => saveFixture(tempDir(`s8a-${tag}`), fixtureCollections(fixture));
const refused = (fn, pattern, label = '') => { let err = null; try { fn(); } catch (e) { err = e; } assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`); assert.doesNotMatch(String(err.message), /Adult Signup|Come and train|Gate B|Harbour Road|Quick feet/, `${label}: ids only, never a name, a message or an address`); return err; };
const RECRUITMENT_ROWS = (s) => TABLES.concat(['recruitment_cases', 'channels']).reduce((n, t) => n + col(s, `SELECT count(*) FROM ${t}`), 0);
/** Write the fixtures into a new database and expect the write refused, atomically: no recruitment row written. */
const refusedSave = (tag, fixture, pattern) => {
  const d = tempDir(`s8a-ref-${tag}`);
  const err = refused(() => saveFixture(d, fixtureCollections(fixture)), pattern, tag);
  assert.equal(withRo(d, RECRUITMENT_ROWS), 0, `${tag}: nothing written`); rm(d);
  return err;
};
function serverOpen(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, unit: (w) => store.unitOfWork(w), repo: layer.recruitment, close: () => store.sqlite.close() };
}

test('[schema] migration 0015 is registered before 0016–0018 and creates the sixteen typed STRICT tables (no lossless side column, the vocabulary CHECKs, the case key immediate and the trial key deferred to COMMIT) and channels with the real request key; a fresh database holds no row and no blob', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id); assert.ok(ids.indexOf(MIGRATION) >= 0 && ids.indexOf(MIGRATION) < ids.indexOf('0016_recruitment_cases'), '0015 before 0016');
  for (const n of rec.RECRUITMENT_COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const d = tempDir('s8a-fresh'); const F = openLayer(d); const f = F.sqlite;
  for (const t of TABLES) {
    const sql = ddlOf(f, t); assert.ok(sql, `${t} exists`); assert.match(sql, /STRICT\s*$/, `${t} is STRICT`); assert.equal(col(f, `SELECT count(*) FROM ${t}`), 0);
    for (const c of ['raw_json', 'extra_json', 'absent_keys_json', 'offtype_json']) assert.ok(!f.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c), `${t}: no ${c}`);
  }
  for (const t of ['recruitment_requests', 'trials']) assert.match(ddlOf(f, t), /case_id TEXT REFERENCES recruitment_cases\(id\) ON DELETE RESTRICT,/, `${t}.case_id is an immediate key: the case is written first`);
  assert.match(ddlOf(f, 'recruitment_requests'), /trial_id TEXT REFERENCES trials\(id\) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED/);
  assert.match(ddlOf(f, 'trials'), /request_id TEXT NOT NULL UNIQUE REFERENCES recruitment_requests\(id\) ON DELETE RESTRICT/);
  assert.match(ddlOf(f, 'recruitment_requests'), /status IN \('pending','accepted','declined','suspended'\)/); assert.match(ddlOf(f, 'trials'), /workflow_state IN \('legacy_accepted'/); assert.match(ddlOf(f, 'trial_attendance'), /source IN \('checkin','manual'\)/);
  assert.deepEqual(f.prepare('PRAGMA foreign_key_list(channels)').all().map((x) => [x.from, x.table, x.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  assert.equal(hasBlobTable(f), false, 'no blob table');
  F.close(); rm(d);
});

test('[fixtures][typed] every writer shape is typed into its columns and reads back as the typed record (an absent field null, an absent list empty, the trial-day container, the five key lists and the reminder map always present): the P4B invitation (slots, private details, invitation key, recipient), the contact, the open-day literal, the legacy and the minor\'s invitations, the scheduled, accepted, M12-shaped, worked and cancelled trials', () => {
  const all = EVERY_TRIAL_SHAPE();
  const d = file('typed', all); const S = { db: readRecords(d) };
  assert.deepEqual(plain(S.db.requests), all.requests.map((r) => typed('requests', r)), 'every request reads back as its typed record');
  assert.deepEqual(plain(S.db.trials), all.trials.map((t) => typed('trials', t)), 'every trial reads back as its typed record');
  const worked = S.db.trials.find((t) => t.id === 'trial-worked');
  assert.equal(worked.schedule.sessions[0].evidence.length, 2); assert.equal(worked.day.staff[0].check.status, 'pending'); assert.equal(worked.report.coachRating, 8); assert.equal(worked.reminders['t48:tses-2:2'], T.session + 86_400_000 - 48 * 3_600_000); assert.equal(worked.keys.schedule[0].key, 'k-sched-1');
  const old = S.db.trials.find((t) => t.id === 'trial-old'); assert.deepEqual(plain(old.day), { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] }, 'a trial without a day reads back with the empty container'); assert.deepEqual(Object.keys(old.keys).sort(), ['attendance', 'cancel', 'complete', 'link', 'schedule']);
  const contact = S.db.requests.find((r) => r.id === 'req-contact'); assert.equal(contact.trialDetails, null); assert.equal(contact.subject, 'Next season');
  const inv = S.db.requests.find((r) => r.id === 'req-p4b'); assert.equal(inv.trialDetails.slots.length, 2); assert.deepEqual(plain(inv.trialDetails.private), { venueAddress: '1 Harbour Road', instructions: 'Gate B, ask for Maria' }); assert.deepEqual(plain(inv.keys.invite), { key: 'client-key-1', fp: 'fp-1' });
  rm(d);
});

test('[fixtures][typed] a write STOPS with the ids on a record the tables cannot hold — nothing written: an unknown field (top level and nested), a status outside the vocabulary, an off-type rev, a trial without its request, a request naming no case, a missing guardian, two open trials in one case, alien entries (each one named)', () => {
  const fix = FIX();
  refusedSave('unknown field', { ...fix, requests: [{ ...fix.requests[0], legacyFlag: true }, ...fix.requests.slice(1)] }, /RECRUITMENT_INPUT_INVALID[\s\S]*req-p4b\.record\.legacyFlag is not a field/);
  refusedSave('unknown nested field', { ...fix, trials: [scheduledTrial({ blockedBy: null, keys: { accept: { key: null, fp: 'x' } } }), fix.trials[1]] }, /trial-1\.record\.blockedBy|trial-1\.keys\.accept/);
  refusedSave('status', { ...fix, requests: [{ ...fix.requests[0], status: 'maybe' }, ...fix.requests.slice(1)] }, /req-p4b\.status must be one of/);
  refusedSave('off-type rev', { ...fix, trials: [scheduledTrial({ rev: '3' }), fix.trials[1]] }, /trial-1\.rev must be an integer/);
  refusedSave('trial without its request', { ...fix, trials: [...fix.trials, acceptedTrial({ id: 'trial-orphan', requestId: 'req-ghost' })] }, /FOREIGN KEY|RECRUITMENT_REFERENCE_MISSING[\s\S]*trial-orphan/);
  refusedSave('request naming no case', { ...fix, requests: [...fix.requests, p4bInvitation({ id: 'req-ghost-case', caseId: 'case-ghost', trialId: null })] }, /RECRUITMENT_CASE_MISSING[\s\S]*req-ghost-case → recruitment_cases case-ghost/);
  refusedSave('missing guardian', { ...fix, requests: [...fix.requests, minorInvitation({ id: 'req-ghost-g', guardianId: 'gd-ghost', recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-ghost', minor: true }, caseId: null })] }, /RECRUITMENT_GUARDIAN_MISSING[\s\S]*req-ghost-g names a guardian that does not exist \(gd-ghost/);
  refusedSave('two open trials in one case', { requests: [...fix.requests, legacyTrialRequest({ id: 'req-second', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', caseId: 'case-1' })], trials: [...fix.trials, acceptedTrial({ id: 'trial-second', requestId: 'req-second', caseId: 'case-1' })] }, /UNIQUE constraint failed: trials\.case_id/);
  for (const alien of [null, 'x', 7]) refusedSave(`alien ${JSON.stringify(alien)}`, { ...fix, trials: [fix.trials[0], alien] }, /RECRUITMENT_INPUT_INVALID/);
});

test('[fixtures] Q7a: a request naming a missing player is stored and counted, never refused', () => {
  const fix = FIX(); const d = file('q7a', { ...fix, requests: [...fix.requests, contactRequest({ id: 'req-gone-player', playerId: 'pl-gone' })] });
  const L = serverOpen(d); assert.equal(L.layer.report().domains.recruitment.unresolvedPlayerReferences.requests, 1, 'the missing player is counted'); L.close(); rm(d);
});

test('[repository] explicit writes: there is no db.requests or db.trials (reading or assigning throws, naming the repository) and every returned record is read-only (a field assignment and a nested push throw); create and update write their rows at once and return the stored record; an update is typed whole (a refusal changes nothing), cannot change an identifier, and names no value; a duplicate create is refused; byId', () => {
  const d = file('repo'); const L = serverOpen(d); const { requests, trials } = L.repo;
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

test('[repository] SQL reads: byId and every list query return exactly what a scan of the tables would, in insertion order; the counts agree; the sweep queries are the old filters (report overdue, completed a week ago without the reminder); the staff-check pages walk every check, pending only or all, at every page size; `reads` carries no write', () => {
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
  for (const t of all.trials) for (const st of [t.status, 'nothing']) assert.deepEqual([...trials.playerIdsForOrgStatus(t.orgId, st)].sort(), [...new Set(all.trials.filter((x) => x.orgId === t.orgId && x.status === st).map((x) => x.playerId))].sort(), `trials.playerIdsForOrgStatus ${st}`);
  for (const t of all.trials) for (const st of [t.status, 'nothing']) { check(`trials.forOrgStatus ${st}`, trials.forOrgStatus(t.orgId, st), all.trials.filter((x) => x.orgId === t.orgId && x.status === st)); assert.equal(trials.countForOrgStatus(t.orgId, st), all.trials.filter((x) => x.orgId === t.orgId && x.status === st).length); }
  for (const at of [0, NOW, NOW + 400 * 86_400_000]) {
    check(`trials.reportOverdue ${at}`, trials.reportOverdue(at), all.trials.filter((t) => Number.isFinite(t.reportDueAt) && t.reportDueAt < at && !t.report && !t.feedbackEscalatedAt && !t.subjectRemovedAt));
    check(`trials.completedUnreminded ${at}`, trials.completedUnreminded(at), all.trials.filter((t) => t.completion?.state === 'completed' && t.completion.at <= at && !t.subjectRemovedAt && !t.reminders?.assessmentPending));
  }
  checkHistoryFeed('trials.historyFeed', { feed: trials.historyFeed, count: trials.historyCount, records: all.trials, ownerKey: 'trialId' });
  const checks = (pendingOnly) => all.trials.flatMap((t) => (t.day?.staff ?? []).filter((x) => x.check && (!pendingOnly || x.check.status === 'pending')).map((x) => `${t.id}/${x.id}`));
  const walk = (pendingOnly, limit) => { const seen = []; let after = null; for (let i = 0; i < 50; i += 1) { const page = trials.staffChecksPage({ pendingOnly, limit, after }); seen.push(...page.items.map((r) => `${r.trialId}/${r.staffId}`)); if (!page.nextCursor) return seen; after = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8')); } throw new Error('the pages never ended'); };
  for (const pendingOnly of [true, false]) for (const limit of [1, 2, 100]) assert.deepEqual(walk(pendingOnly, limit), checks(pendingOnly), `staffChecksPage pendingOnly=${pendingOnly} by ${limit}`);
  for (const n of ['requests', 'trials']) { assert.ok(Object.isFrozen(L.repo.reads[n])); assert.equal(L.repo.reads[n].byId, L.repo[n].byId); assert.equal(L.repo.reads[n].create, undefined); assert.equal(L.repo.reads[n].update, undefined); }
  assert.deepEqual(L.repo.counts(), { requests: all.requests.length, trials: all.trials.length, trialReports: all.trials.filter((t) => t.report).length });
  L.close(); rm(d);
});

test('[repository] batched trial lists: every list, page and sweep decodes its trials\' child rows in one batch, and each trial is exactly the one byId decodes on its own (the worked trial exercises every child table); a page of five trials runs as many SQL statements as a page of two', () => {
  const d = file('batch', EVERY_TRIAL_SHAPE()); const L = serverOpen(d); const { trials } = L.repo;
  const all = L.repo.exportAll().trials;
  assert.ok(all.length >= 5 && all.some((t) => t.id === 'trial-worked'), 'the fixture has the worked trial among five or more');
  const whole = (label, list) => { assert.ok(list.length >= 2, `${label} is a list of several`); assert.deepEqual(plain(list), plain(list.map((t) => trials.byId(t.id))), `${label}: a batch-decoded list is the per-trial decode`); };
  const players = [...new Set(all.map((t) => t.playerId))];
  whole('forPlayers', trials.forPlayers(players));
  for (const o of new Set(all.map((t) => t.orgId))) if (trials.forOrg(o).length >= 2) whole(`forOrg ${o}`, trials.forOrg(o));
  const org = all.find((t) => t.id === 'trial-worked').orgId;
  whole('pageForOrg', trials.pageForOrg(org, { limit: 50 }).items);
  const counted = { on: false, n: 0 }; const original = StatementSync.prototype.all;
  StatementSync.prototype.all = function counting(...args) { if (counted.on) counted.n += 1; return original.apply(this, args); };
  try {
    const statementsFor = (limit) => { counted.n = 0; counted.on = true; const page = trials.pageForOrg(org, { limit }); counted.on = false; assert.equal(page.items.length, limit); return counted.n; };
    const two = statementsFor(2); const five = statementsFor(5);
    assert.ok(two > 0, 'the counter saw the statements');
    assert.equal(five, two, `a page's statements do not grow with its length (2 trials: ${two}, 5 trials: ${five})`);
  } finally { StatementSync.prototype.all = original; }
  L.close(); rm(d);
});

test('[repository] the reminder sweep query: remindersDue(now) is exactly the confirmed, open trials the sweep would remind at that instant — a session starting within 48 hours whose marker for the current revision is unset, or the last session ended over a day ago without completionPending — at every boundary', () => {
  const H = 3_600_000; const D = 24 * H;
  const copy = ({ evidence: _e, ...x }) => x;
  const multi = (id, starts, over = {}) => {
    const base = scheduledTrial(); const sessions = starts.map((at, i) => session({ id: `${id}-s${i}`, startsAt: at, endsAt: at + 90 * 60_000 }));
    return scheduledTrial({ id, requestId: `req-${id}`, caseId: null, schedule: { ...base.schedule, sessions, revisions: [{ ...base.schedule.revisions[0], sessions: sessions.map(copy) }] }, ...over });
  };
  const reqFor = (id) => acceptedRequest(p4bInvitation({ id: `req-${id}`, caseId: null, keys: { invite: { key: `ck-${id}`, fp: `fp-${id}` } } }), id);
  const made = [
    multi('trial-a', [T.session, T.session + 3 * D], { reminders: { 't48:trial-a-s0:1': T.session - 40 * H } }), // the first session reminded
    multi('trial-b', [T.session], { reminders: { 't48:trial-b-s0:0': T.accepted } }), // a marker of an older revision
    multi('trial-c', [T.session], { reminders: { completionPending: T.accepted } }),
    multi('trial-d', [T.session - 4 * D, T.session]), // one session past, one to come
  ];
  const fix = FIX(); fix.requests.push(...made.map((t) => reqFor(t.id)), legacyTrialRequest({ id: 'req-cancelled', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', trialId: 'trial-cancelled' }));
  fix.trials.push(...made, cancelledTrial({ caseId: null }));
  const d = file('reminders', fix); const L = serverOpen(d); const { trials } = L.repo;
  const all = L.repo.exportAll().trials;
  const due = (t, now) => {
    if (!t.schedule?.confirmedAt || t.completion || t.subjectRemovedAt) return false;
    const ss = t.schedule.sessions ?? [];
    if (ss.some((x) => x.startsAt > now && x.startsAt - now <= 48 * H && !t.reminders[`t48:${x.id}:${t.schedule.revision}`])) return true;
    const lastEnd = ss.reduce((m, x) => Math.max(m, x.endsAt), 0);
    return Boolean(lastEnd) && now - lastEnd > 24 * H && !t.reminders.completionPending;
  };
  const instants = new Set();
  for (let k = -24; k <= 32; k += 1) instants.add(T.session + k * 6 * H);
  for (const t of all) for (const x of t.schedule?.sessions ?? []) for (const at of [x.startsAt - 48 * H - 1, x.startsAt - 48 * H, x.startsAt - 1, x.startsAt, x.endsAt + 24 * H - 1, x.endsAt + 24 * H, x.endsAt + 24 * H + 1]) instants.add(at);
  let some = 0;
  for (const at of instants) { const want = all.filter((t) => due(t, at)); some += want.length; assert.deepEqual(trials.remindersDue(at).map((t) => t.id), want.map((t) => t.id), `remindersDue at ${at - T.session}`); }
  assert.ok(some > 0, 'the instants exercise due reminders');
  assert.deepEqual(trials.remindersDue(T.session - 47 * H).map((t) => t.id), ['trial-1', 'trial-b', 'trial-c', 'trial-d'], 'trial-a\'s session is reminded; a marker of an older revision is not this revision\'s');
  assert.deepEqual(trials.remindersDue(T.session + 2 * D).map((t) => t.id), ['trial-1', 'trial-a', 'trial-b', 'trial-d'], 'over a day after the session: completion pending except trial-c (marked); trial-a\'s second session is within 48 hours');
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

test('[repository] a player\'s stored profile figure (players.profile_signal) counts the reports filed on their trials: right after the fixture is written, and refreshed by the trial write that files one, in its own unit (a unit that fails leaves it as it was)', () => {
  const d = file('signal'); const L = serverOpen(d);
  const stored = () => withRo(d, (s) => col(s, "SELECT profile_signal FROM players WHERE id = 'pl-adult'"));
  const derived = () => computeTrustScore(L.layer.players.byId('pl-adult'));
  assert.equal(L.layer.players.byId('pl-adult').trialReports.length, 1, 'the fixture\'s reported trial');
  assert.equal(stored(), derived(), 'the fixture\'s trial writes refreshed the figure');
  const before = stored();
  assert.throws(() => L.unit(() => { L.repo.trials.update('trial-1', (x) => { x.report = report(); }); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  assert.equal(stored(), before, 'a failed unit leaves the figure as it was');
  L.repo.trials.update('trial-1', (x) => { x.report = report(); });
  assert.equal(L.layer.players.byId('pl-adult').trialReports.length, 2);
  assert.equal(stored(), derived(), 'the write that files a report refreshes the figure');
  assert.equal(stored(), Math.min(before + TRUST.PER_TRIAL_REPORT, TRUST.MAX), 'by one report\'s worth');
  L.close(); rm(d);
});

test('[capabilities] the live report: explicit write mode, no pending writes, the counts and the player counters', () => {
  const d = file('caps'); const L = serverOpen(d); const r = L.layer.report().domains.recruitment;
  assert.equal(r.mode, 'live'); assert.match(r.writeMode, /explicit/); assert.equal(r.pendingWrites, 0); assert.deepEqual(plain(r.rows), { requests: 6, trials: 2, trialReports: 1 }); assert.deepEqual(plain(r.unresolvedPlayerReferences), { requests: 0, trials: 0 });
  L.close(); rm(d);
});

console.log(`\n${passed} recruitment checks passed`);
