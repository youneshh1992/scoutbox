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
/** A stored record holds everything the writer's literal said (absent and null say nothing), at every depth. */
const storedAs = (written, stored, at) => {
  if (written === undefined || written === null) return;
  if (typeof written !== 'object') { assert.equal(stored, written, at); return; }
  assert.ok(stored !== null && typeof stored === 'object' && Array.isArray(stored) === Array.isArray(written), `${at}: stored as ${Array.isArray(written) ? 'a list' : 'an object'}`);
  if (Array.isArray(written)) assert.equal(stored.length, written.length, `${at}: length`);
  for (const [k, v] of Object.entries(written)) storedAs(v, stored[k], `${at}.${k}`);
};

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

test('[fixtures] every writer shape is written into its columns and reads back as written (an absent field null, an absent list empty, the trial-day container, the five key lists and the reminder map always present): the P4B invitation (slots, private details, invitation key, recipient), the contact, the open-day literal, the legacy and the minor\'s invitations, the scheduled, accepted, M12-shaped, worked and cancelled trials', () => {
  const all = EVERY_TRIAL_SHAPE();
  const d = file('typed', all); const S = { db: readRecords(d) };
  assert.deepEqual(S.db.requests.map((r) => r.id), all.requests.map((r) => r.id)); assert.deepEqual(S.db.trials.map((t) => t.id), all.trials.map((t) => t.id));
  all.requests.forEach((r, i) => storedAs(persisted(r), plain(S.db.requests[i]), r.id)); all.trials.forEach((t, i) => storedAs(persisted(t), plain(S.db.trials[i]), t.id));
  for (const r of S.db.requests) assert.ok(r.playerName !== undefined && r.subject !== undefined && r.recipient !== undefined && 'invite' in r.keys, `${r.id}: an absent field reads back as null`);
  const worked = S.db.trials.find((t) => t.id === 'trial-worked');
  assert.equal(worked.schedule.sessions[0].evidence.length, 2); assert.equal(worked.day.staff[0].check.status, 'pending'); assert.equal(worked.report.coachRating, 8); assert.equal(worked.reminders['t48:tses-2:2'], T.session + 86_400_000 - 48 * 3_600_000); assert.equal(worked.keys.schedule[0].key, 'k-sched-1');
  const old = S.db.trials.find((t) => t.id === 'trial-old'); assert.deepEqual(plain(old.day), { staff: [], consents: [], arrival: null, emergency: null, checkins: [], collection: null, statusEvents: [] }, 'a trial without a day reads back with the empty container'); assert.deepEqual(Object.keys(old.keys).sort(), ['attendance', 'cancel', 'complete', 'link', 'schedule']);
  const contact = S.db.requests.find((r) => r.id === 'req-contact'); assert.equal(contact.trialDetails, null); assert.equal(contact.subject, 'Next season');
  const inv = S.db.requests.find((r) => r.id === 'req-p4b'); assert.equal(inv.trialDetails.slots.length, 2); assert.deepEqual(plain(inv.trialDetails.private), { venueAddress: '1 Harbour Road', instructions: 'Gate B, ask for Maria' }); assert.deepEqual(plain(inv.keys.invite), { key: 'client-key-1', fp: 'fp-1' });
  rm(d);
});

test('[fixtures] a write STOPS with the ids on a record the tables cannot hold — nothing written: an unknown field (top level and nested), a status outside the vocabulary, an off-type rev, a trial without its request, a request naming no case, a missing guardian, two open trials in one case, alien entries (each one named)', () => {
  const fix = FIX();
  refusedSave('unknown field', { ...fix, requests: [{ ...fix.requests[0], legacyFlag: true }, ...fix.requests.slice(1)] }, /RECRUITMENT_INPUT_INVALID[\s\S]*req-p4b legacyFlag: is not stored as written/);
  refusedSave('unknown nested field', { ...fix, trials: [scheduledTrial({ blockedBy: null, keys: { accept: { key: null, fp: 'x' } } }), fix.trials[1]] }, /trial-1 (blockedBy|keys\.accept): is not stored as written/);
  refusedSave('status', { ...fix, requests: [{ ...fix.requests[0], status: 'maybe' }, ...fix.requests.slice(1)] }, /req-p4b request: CHECK constraint failed: status/);
  refusedSave('off-type rev', { ...fix, trials: [scheduledTrial({ rev: '3' }), fix.trials[1]] }, /trial-1 rev: is not stored as written/);
  refusedSave('trial without its request', { ...fix, trials: [...fix.trials, acceptedTrial({ id: 'trial-orphan', requestId: 'req-ghost' })] }, /RECRUITMENT_INPUT_INVALID: trials trial-orphan trial: FOREIGN KEY constraint failed/);
  refusedSave('request naming no case', { ...fix, requests: [...fix.requests, p4bInvitation({ id: 'req-ghost-case', caseId: 'case-ghost', trialId: null })] }, /RECRUITMENT_CASE_MISSING[\s\S]*req-ghost-case → recruitment_cases case-ghost/);
  refusedSave('missing guardian', { ...fix, requests: [...fix.requests, minorInvitation({ id: 'req-ghost-g', guardianId: 'gd-ghost', recipient: { type: 'guardian', playerId: 'pl-child1', guardianId: 'gd-ghost', minor: true }, caseId: null })] }, /RECRUITMENT_GUARDIAN_MISSING[\s\S]*req-ghost-g names a guardian that does not exist \(gd-ghost/);
  refusedSave('two open trials in one case', { requests: [...fix.requests, legacyTrialRequest({ id: 'req-second', status: 'accepted', respondedAt: T.accepted, respondedBy: 'player', caseId: 'case-1' })], trials: [...fix.trials, acceptedTrial({ id: 'trial-second', requestId: 'req-second', caseId: 'case-1' })] }, /UNIQUE constraint failed: trials\.case_id/);
  for (const alien of [null, 'x', 7]) refusedSave(`alien ${JSON.stringify(alien)}`, { ...fix, trials: [fix.trials[0], alien] }, /RECRUITMENT_INPUT_INVALID/);
});

test('[fixtures] Q7a: a request naming a missing player is stored and counted, never refused', () => {
  const fix = FIX(); const d = file('q7a', { ...fix, requests: [...fix.requests, contactRequest({ id: 'req-gone-player', playerId: 'pl-gone' })] });
  const L = serverOpen(d); assert.equal(L.layer.report().domains.recruitment.unresolvedPlayerReferences.requests, 1, 'the missing player is counted'); L.close(); rm(d);
});

test('[repository] explicit writes: every returned record is read-only (a field assignment and a nested push throw); create writes its rows at once and returns the stored record; a duplicate create is refused; there is no whole-record update, only named acts, and a refused act changes nothing and names no value; byId', () => {
  const d = file('repo'); const L = serverOpen(d); const { requests, trials } = L.repo;
  assert.throws(() => { trials.byId('trial-1').status = 'reported'; }, /read only|Cannot assign/); assert.throws(() => trials.byId('trial-1').history.push({}), /not extensible|read only|Cannot add/);
  assert.equal(requests.update, undefined); assert.equal(trials.update, undefined);
  const made = requests.create(contactRequest({ id: 'req-new' })); assert.equal(made.id, 'req-new'); assert.throws(() => { made.status = 'accepted'; }, /read only|Cannot assign/);
  assert.equal(withRo(d, (s) => col(s, "SELECT status FROM recruitment_requests WHERE id = 'req-new'")), 'pending', 'written at once, no save');
  refused(() => requests.create(contactRequest({ id: 'req-new' })), /RECRUITMENT_DUPLICATE[\s\S]*req-new/, 'duplicate');
  const answered = requests.recordResponse('req-new', { status: 'accepted', respondedAt: NOW, respondedBy: 'player' }); assert.equal(answered.status, 'accepted'); assert.equal(requests.byId('req-new').status, 'accepted', 'a read serves the stored record');
  const rows = withRo(d, recDump);
  refused(() => requests.recordResponse('req-new', { status: 'declined', respondedAt: NOW, respondedBy: 'player' }), /RECRUITMENT_STATE_CONFLICT: recruitment_requests req-new is not pending/, 'a second answer');
  refused(() => requests.attachChannel('req-contact', { channelId: 'chan-x' }), /req-contact is not an accepted request without a channel/, 'a channel on a pending request');
  refused(() => trials.recordAttendance('trial-1', { attendance: { sessionId: 'tses-1', state: 'how it went', source: 'manual', recordedAt: NOW } }), /trials trial-1 recordAttendance: CHECK constraint failed: state IS NULL OR state IN/, 'vocabulary');
  refused(() => trials.recordAttendance('trial-1', { attendance: { sessionId: 'tses-1', state: 'attended', source: 'manual', recordedAt: NOW, mood: 'great' } }), /trials trial-1 attendance\.mood: is not stored as written/, 'a field with no column');
  refused(() => trials.cancel('trial-ghost', { at: NOW }), /RECRUITMENT_NOT_FOUND[\s\S]*trial-ghost/, 'no such trial');
  assert.equal(withRo(d, recDump), rows, 'a refused act changed no row');
  const t = trials.recordAttendance('trial-1', { attendance: { sessionId: 'tses-1', state: 'attended', source: 'manual', recordedBy: { kind: 'org', userId: 'usr-1', name: 'Maria' }, recordedAt: NOW, note: null } }, { at: NOW, bump: true, revBy: { id: 'usr-1', name: 'Maria' } });
  assert.equal(t.attendance.length, 1); assert.equal(withRo(d, (s) => col(s, "SELECT count(*) FROM trial_attendance WHERE trial_id = 'trial-1'")), 1); assert.equal(trials.byId('trial-1').rev, 2); assert.deepEqual(plain(t.revBy), { userId: 'usr-1', name: 'Maria' }); assert.equal(trials.byId('trial-ghost'), null);
  L.close(); rm(d);
});

test('[repository] the acts of a trial, each guarded in SQL: a schedule proposal is one past the current revision (it supersedes the open revision, keeps a kept session\'s evidence links and drops a dropped one\'s), a confirmation or a decline answers only a proposed schedule, nothing changes an ended trial, completion needs a scheduled trial, an evidence link is withdrawn once, a report is filed once; a trial keeps its newest client keys; the trial-day acts', () => {
  const d = file('acts'); const L = serverOpen(d); const { trials } = L.repo;
  const org = { kind: 'org', userId: 'usr-1', name: 'Maria' }; const fam = { kind: 'player', id: 'pl-adult', name: 'Adult Signup' };
  trials.linkEvidence('trial-1', { sessionId: 'tses-1', evidence: { id: 'tev-9', kind: 'box_cam_session', sessionId: 'box-9', linkedAt: NOW, linkedBy: org, removedAt: null, removedBy: null } });
  refused(() => trials.linkEvidence('trial-1', { sessionId: 'tses-ghost', evidence: { id: 'tev-10', kind: 'box_cam_session', sessionId: 'box-9', linkedAt: NOW } }), /trial-1 linkEvidence: FOREIGN KEY constraint failed/, 'evidence on a session the trial does not have');
  const s1 = { id: 'tses-1', kind: 'training', startsAt: T.session, endsAt: T.sessionEnd, venue: { name: 'Eastport Ground', town: 'Eastport', address: null }, instructions: null };
  const s2 = { id: 'tses-2', kind: 'match', startsAt: T.sessionEnd + 3_600_000, endsAt: T.sessionEnd + 7_200_000, venue: null, instructions: null };
  refused(() => trials.proposeSchedule('trial-1', { revision: 3, timezone: 'Europe/London', sessions: [s1], proposedAt: NOW, proposedBy: org, workflowState: 'accepted' }), /RECRUITMENT_STATE_CONFLICT: trials trial-1 is not open at schedule revision 2/, 'a revision that skips one');
  let t = trials.proposeSchedule('trial-1', { revision: 2, timezone: 'Europe/London', sessions: [s1, s2], proposedAt: NOW, proposedBy: org, reason: 'more', material: true, workflowState: 'accepted' }, { at: NOW, bump: true, revBy: { id: 'usr-1', name: 'Maria' }, key: { act: 'schedule', key: 'k-1', fp: 'fp-1' } });
  assert.equal(t.schedule.revision, 2); assert.equal(t.schedule.confirmedAt, null); assert.equal(t.workflowState, 'accepted'); assert.deepEqual(t.schedule.sessions.map((s) => s.id), ['tses-1', 'tses-2']);
  assert.equal(t.schedule.sessions[0].evidence.length, 1, 'a kept session keeps its evidence'); assert.deepEqual(t.schedule.revisions.map((r) => [r.revision, r.supersededAt]), [[1, NOW], [2, null]]); assert.equal(t.schedule.revisions[1].sessions.length, 2); assert.equal(t.keys.schedule[0].key, 'k-1');
  t = trials.proposeSchedule('trial-1', { revision: 3, timezone: 'Europe/London', sessions: [s2], proposedAt: NOW + 1, proposedBy: org, workflowState: 'accepted' });
  assert.deepEqual(t.schedule.sessions.map((s) => s.id), ['tses-2']); assert.equal(withRo(d, (s) => col(s, "SELECT count(*) FROM trial_session_evidence WHERE trial_id = 'trial-1'")), 0, 'a dropped session takes its evidence links with it');
  t = trials.declineSchedule('trial-1', { at: NOW, by: fam }); assert.equal(t.schedule.declinedAt, NOW);
  refused(() => trials.declineSchedule('trial-1', { at: NOW, by: fam }), /trial-1 has no proposed schedule awaiting an answer/, 'a second decline');
  refused(() => trials.complete('trial-1', { at: NOW, by: org }), /trial-1 is not scheduled/, 'completion before confirmation');
  t = trials.confirmSchedule('trial-1', { at: NOW, by: fam, recipient: { type: 'player', playerId: 'pl-adult', guardianId: null, minor: false, at: NOW }, workflowState: 'scheduled' });
  assert.equal(t.workflowState, 'scheduled'); assert.equal(t.schedule.confirmedAt, NOW); assert.equal(t.schedule.declinedAt, null); assert.equal(t.schedule.revisions.at(-1).confirmedAt, NOW);
  refused(() => trials.confirmSchedule('trial-1', { at: NOW, by: fam, recipient: null, workflowState: 'scheduled' }), /trial-1 has no proposed schedule awaiting confirmation/, 'a second confirmation');
  refused(() => trials.confirmSchedule('trial-1', { at: NOW, by: fam, recipient: { type: 'guardian', playerId: 'pl-adult', guardianId: 'gd-ghost', minor: true }, workflowState: 'scheduled' }), /RECRUITMENT_GUARDIAN_MISSING[\s\S]*gd-ghost/, 'a guardian that does not exist');
  t = trials.complete('trial-1', { at: NOW, by: org }); assert.equal(t.workflowState, 'completed'); assert.equal(t.completion.phase, 'scheduled');
  refused(() => trials.cancel('trial-1', { at: NOW, by: org, reason: 'x', phase: 'completed', cancelledBy: 'club' }), /RECRUITMENT_STATE_CONFLICT: trials trial-1 has ended/, 'nothing changes an ended trial');
  refused(() => trials.proposeSchedule('trial-1', { revision: 4, timezone: 'Europe/London', sessions: [s2], proposedAt: NOW, proposedBy: org, workflowState: 'accepted' }), /trial-1 is not open/, 'nor a schedule');
  t = trials.recordLifecycle('trial-1', { lifecycle: { applied: true, from: 'trial_scheduled', to: 'trial_completed', at: NOW } }); assert.deepEqual(plain(t.lifecycle), { applied: true, from: 'trial_scheduled', to: 'trial_completed', at: NOW });
  refused(() => trials.recordLifecycle('trial-1', { lifecycle: { applied: true, from: 'a', to: 'b', at: NOW, reason: 'x' } }), /trial-1 lifecycle\.reason: is not stored as written/, 'an applied move carries no reason');
  t = trials.fileReport('trial-1', { report: report({ id: 'rep-9' }) }); assert.equal(t.status, 'reported'); assert.equal(t.report.id, 'rep-9');
  refused(() => trials.fileReport('trial-1', { report: report({ id: 'rep-10' }) }), /trial-1 already has its report/, 'a second report');
  refused(() => trials.fileReport('trial-old', { report: report({ id: 'rep-11', trialId: 'trial-old', playerId: 'pl-child1' }) }), /trial-old already has its report|FOREIGN KEY/, 'a report names its trial\'s player');
  // client keys: the newest are kept
  for (let i = 0; i < 52; i++) trials.recordAct('trial-old', { at: NOW + i, key: { act: 'cancel', key: `k-${i}`, fp: 'f' } });
  const keys = trials.byId('trial-old').keys.cancel; assert.equal(keys.length, 50); assert.equal(keys[0].key, 'k-2'); assert.equal(keys.at(-1).key, 'k-51');
  // reminders, escalation
  t = trials.markReminders('trial-old', { markers: { assessmentPending: NOW } }); assert.equal(t.reminders.assessmentPending, NOW);
  refused(() => trials.markReminders('trial-old', { markers: { assessmentPending: NOW } }), /trial-old markReminders: UNIQUE constraint failed/, 'a marker is set once');
  trials.escalateFeedback('trial-old', { at: NOW }); refused(() => trials.escalateFeedback('trial-old', { at: NOW }), /trial-old was already escalated/);
  trials.markReportReminderSent('trial-old'); refused(() => trials.markReportReminderSent('trial-old'), /trial-old was already reminded/);
  // the trial day
  t = trials.addStaff('trial-old', { staff: { id: 'stf-1', name: 'Coach', role: 'Coach', check: { kind: 'DBS', ref: 'R1', status: 'pending', expiresAt: null, reviewedBy: null }, addedBy: 'Maria', addedAt: NOW } });
  t = trials.reviewStaffCheck('trial-old', { staffId: 'stf-1', status: 'reviewed', reviewedBy: 'Trust & Safety', reviewedAt: NOW, expiresAt: '2030-01-01' }); assert.deepEqual([t.day.staff[0].check.status, t.day.staff[0].check.expiresAt], ['reviewed', '2030-01-01']);
  t = trials.addStaff('trial-old', { staff: { id: 'stf-2', name: 'Kit', role: 'Kit', check: null, addedBy: 'Maria', addedAt: NOW } });
  refused(() => trials.reviewStaffCheck('trial-old', { staffId: 'stf-2', status: 'reviewed', reviewedBy: 'T&S', reviewedAt: NOW }), /trial-old staff stf-2 has no check/, 'no check to review');
  t = trials.setArrival('trial-old', { arrival: { time: '10:00', address: null, notes: null }, collection: { policy: 'Parents collect' } }); assert.deepEqual(plain(t.day.arrival), { time: '10:00', address: null, notes: null }); assert.equal(t.day.collection.policy, 'Parents collect');
  t = trials.setArrival('trial-old', { arrival: { time: null, address: null, notes: null }, collection: null }); assert.equal(t.day.arrival, null); assert.equal(t.day.collection.policy, 'Parents collect', 'the policy stays unless replaced');
  t = trials.giveConsent('trial-old', { consent: { id: 'cns-1', by: fam, scope: 'player_event_consent', at: NOW } });
  refused(() => trials.giveConsent('trial-old', { consent: { id: 'cns-2', by: fam, scope: 'player_event_consent', at: NOW } }), /trial-old giveConsent: UNIQUE constraint failed/, 'one consent per person and scope');
  t = trials.setEmergencyContact('trial-old', { emergency: { name: 'Mum', phone: '0770', setBy: 'player', at: NOW } }); assert.equal(t.day.emergency.name, 'Mum');
  t = trials.recordDayStatus('trial-old', { event: { kind: 'postponed', at: NOW, by: 'Maria', reason: 'Rain', newDate: '2026-12-01' }, proposedDate: '2026-12-01', reportDueAt: NOW + 1 }); assert.equal(t.proposedDate, '2026-12-01'); assert.equal(t.reportDueAt, NOW + 1); assert.equal(t.day.statusEvents.length, 1);
  t = trials.checkIn('trial-old', { checkin: { playerId: 'pl-adult', at: NOW, byUserId: 'usr-1', byName: 'Maria' } }); assert.equal(t.day.checkins.length, 1); assert.equal(t.attendance.length, 0);
  L.close(); rm(d);
});

test('[repository] a unit of work: a request and a trial written in a unit with the case created first in the same unit commit together; a unit that fails rolls the rows back while a read inside it sees its writes; a request naming a missing case refuses the whole unit with its ids', () => {
  const d = file('unit'); const L = serverOpen(d); const { requests, trials } = L.repo;
  const rows = withRo(d, recDump); const before = JSON.stringify(L.repo.exportAll().requests);
  assert.throws(() => L.unit(() => { requests.create(contactRequest({ id: 'req-u' })); trials.recordAct('trial-1', { at: NOW, bump: true }); assert.ok(requests.byId('req-u'), 'a read inside the unit sees its create'); assert.equal(trials.byId('trial-1').rev, 2); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
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
  for (const n of ['requests', 'trials']) { assert.ok(Object.isFrozen(L.repo.reads[n])); assert.equal(L.repo.reads[n].byId, L.repo[n].byId); for (const w of ['create', 'recordResponse', 'suspend', 'proposeSchedule', 'cancel', 'fileReport', 'addStaff', 'recordAct']) assert.equal(L.repo.reads[n][w], undefined, `${n}.${w} is not a read`); }
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

test('[repository] the deletion unit: redactPlayer keeps every request and trial of the player with its ids, states, times and the club\'s filed numbers, and removes what describes the person (names, message, subject, notes, instructions and address lines, the emergency contact, report feedback, evidence links, recipient and guardian ids, actors\' names, long history detail); another player\'s rows are untouched; the derived trial reports are the reports on the player\'s trials in filing order', () => {
  const all = EVERY_TRIAL_SHAPE(); const d = file('tomb', all); const L = serverOpen(d);
  assert.deepEqual(L.repo.trialReportsFor('pl-adult').map((r) => r.id), ['rep-old', 'rep-1']);
  const before = plain(L.repo.trials.byId('trial-worked'));
  const n = L.repo.redactPlayer('pl-adult', NOW);
  assert.deepEqual(n, { requests: 8, trials: 5 });
  withRo(d, (s) => { assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE player_id = 'pl-adult' AND (subject_removed_at IS NULL OR player_name IS NOT NULL OR message IS NOT NULL OR subject IS NOT NULL OR trial_private_venue_address IS NOT NULL OR invite_key IS NOT NULL OR recipient_type IS NOT NULL)"), 0); assert.equal(col(s, "SELECT count(*) FROM recruitment_requests WHERE player_id = 'pl-child1' AND subject_removed_at IS NULL"), 1, 'another player\'s request untouched'); assert.equal(col(s, 'SELECT count(*) FROM request_trial_slots WHERE venue_address IS NOT NULL'), 0); });
  const t = plain(L.repo.trials.byId('trial-worked'));
  assert.equal(t.playerName, null); assert.equal(t.notes, ''); assert.equal(t.subjectRemovedAt, NOW); assert.equal(t.revBy, null); assert.equal(t.lifecycle, null);
  assert.deepEqual([t.id, t.requestId, t.caseId, t.status, t.workflowState, t.rev, t.acceptedAt, t.reportDueAt], [before.id, before.requestId, before.caseId, before.status, before.workflowState, before.rev, before.acceptedAt, before.reportDueAt], 'ids, states and times kept');
  assert.deepEqual([t.report.id, t.report.coachRating, t.report.notes, t.report.strengthNote, t.report.focusNote], [before.report.id, before.report.coachRating, null, null, null], 'the club\'s filed numbers kept, the feedback gone');
  assert.ok(t.schedule.sessions.every((s) => s.instructions === null && (s.venue === null || s.venue.address === null) && s.evidence.length === 0), 'sessions keep their times and venue, lose instructions, address and evidence');
  assert.ok(t.schedule.revisions.every((r) => r.confirmedBy === null && r.reason === null && (r.proposedBy === null || Object.keys(r.proposedBy).join() === 'kind')));
  assert.ok(t.history.every((h) => h.by === null || Object.keys(h.by).join() === 'kind'), 'history keeps who by kind only'); assert.deepEqual(t.history.map((h) => h.id), before.history.map((h) => h.id));
  assert.ok(t.history.every((h) => h.detail === null || Object.values(h.detail).every((v) => typeof v !== 'string' || v.length <= 40)), 'long history detail text goes');
  assert.ok(t.attendance.every((a) => a.note === null)); assert.equal(t.day.emergency, null); assert.equal(t.day.arrival, null); assert.equal(t.day.collection, null); assert.deepEqual(t.day.staff, before.day.staff, 'the club\'s own staff stay');
  assert.ok(t.day.consents.every((c) => c.by === null || Object.keys(c.by).join() === 'kind'));
  assert.equal(t.completion?.reason ?? null, null); assert.equal(t.recipient?.playerId ?? null, null);
  L.close(); rm(d);
});

test('[repository] a player\'s stored profile figure (players.profile_signal) counts the reports filed on their trials: right after the fixture is written, and refreshed by the trial write that files one, in its own unit (a unit that fails leaves it as it was)', () => {
  const d = file('signal'); const L = serverOpen(d);
  const stored = () => withRo(d, (s) => col(s, "SELECT profile_signal FROM players WHERE id = 'pl-adult'"));
  const derived = () => computeTrustScore(L.layer.players.byId('pl-adult'));
  assert.equal(L.layer.players.byId('pl-adult').trialReports.length, 1, 'the fixture\'s reported trial');
  assert.equal(stored(), derived(), 'the fixture\'s trial writes refreshed the figure');
  const before = stored();
  assert.throws(() => L.unit(() => { L.repo.trials.fileReport('trial-1', { report: report() }); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  assert.equal(stored(), before, 'a failed unit leaves the figure as it was');
  L.repo.trials.fileReport('trial-1', { report: report() });
  assert.equal(L.layer.players.byId('pl-adult').trialReports.length, 2);
  assert.equal(stored(), derived(), 'the write that files a report refreshes the figure');
  assert.equal(stored(), Math.min(before + TRUST.PER_TRIAL_REPORT, TRUST.MAX), 'by one report\'s worth');
  L.close(); rm(d);
});

test('[capabilities] the live report: the named-acts write mode, no pending writes, the counts and the player counters', () => {
  const d = file('caps'); const L = serverOpen(d); const r = L.layer.report().domains.recruitment;
  assert.equal(r.mode, 'live'); assert.match(r.writeMode, /named acts/); assert.equal(r.pendingWrites, 0); assert.deepEqual(plain(r.rows), { requests: 6, trials: 2, trialReports: 1 }); assert.deepEqual(plain(r.unresolvedPlayerReferences), { requests: 0, trials: 0 });
  L.close(); rm(d);
});

console.log(`\n${passed} recruitment checks passed`);
