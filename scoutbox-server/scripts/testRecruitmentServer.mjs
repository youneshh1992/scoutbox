// Recruitment requests and trials through the REAL server (booted as a child process on temporary data directories,
// synthetic seed records only): the invitation and acceptance (request, thread and trial in one unit), the report,
// the trial-day staff route, the duplicate-pending answer (D2), a SIGKILL, the deletion unit with a real COMMIT
// failure, a historically missing player counted (Q7a), and backup/restore. Every database read goes through a second
// read-only connection. Nothing here touches DATA_DIR or real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { readTrials } from '../repositories/recruitment.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const MIGRATION = '0015_recruitment';
const TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
const REPORT = { acceleration: 7, sprintSpeedKmh: 31, distanceKm: 6.2, passCompletionPct: 78, duelSuccessPct: 55, coachRating: 8, notes: 'Quick feet.' };

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
   
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
const applied = (dir) => qAll(dir, 'SELECT id FROM data_migrations ORDER BY id').map((r) => r.id);
const noBlobTable = (dir) => !q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'collections'");
const fullDump = (s) => JSON.stringify(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => [r.name, s.prepare(`SELECT * FROM "${r.name}"`).all().map((x) => ({ ...x }))]));
const tableExists = (dir, t) => !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const recDump = (dir) => JSON.stringify(Object.fromEntries([...TABLES, 'channels', 'messages'].filter((t) => tableExists(dir, t)).map((t) => [t, qAll(dir, `SELECT * FROM ${t} ORDER BY rowid`)])));
const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
/** A direct trial invitation (the legacy route) answered by the adult: the request's answer, the thread and the trial in one unit. */
async function inviteAndAccept(S, maria, pid, token, { proposedDate = '2026-11-01' } = {}) {
  const inv = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'Come and train with us.', proposedDate, altSlots: ['2026-11-02'], venue: 'Eastport Ground', notes: 'Bring boots' }, maria); assert.equal(inv.status, 201, inv.text);
  const acc = await S.j('POST', `/player/requests/${inv.body.requestId}/respond`, { accept: true, chosenSlot: proposedDate }, token); assert.equal(acc.status, 200, acc.text);
  return { requestId: inv.body.requestId, trialId: acc.body.trialId, channelId: acc.body.contactChannel };
}

await test('[routes] a fresh boot records 0015_recruitment (followed by 0016) and the fifteen tables exist with channels carrying the real request key; the direct invitation and the adult\'s acceptance land as rows (the request answered, the trial with its history and keys.accept, the thread naming the request through the key) with no blob behind them; /org/requests, /org/trials, /player/inbox and /player/trials answer as before; the report lands in trial_reports and the day staff in trial_day_staff; the direct route still answers REQUEST_PENDING; a SIGKILL right after the acceptance loses nothing; /capabilities counts the rows', async () => {
  const dir = tempDir('s8a-boot'); const S = await boot(dir);
  assert.equal(applied(dir).filter((id) => id < '0019').at(-4), MIGRATION, 'the recruitment migration, recorded before 0016, 0017 and 0018'); for (const t of TABLES) assert.ok(tableExists(dir, t), `${t} exists`);
  assert.ok(qAll(dir, 'PRAGMA foreign_key_list(channels)').some((r) => r.table === 'recruitment_requests'), 'channels.request_id is a real key');
  const maria = await orgLogin(S); const { pid, token } = await signupAdult(S, 'Invited Adult');
  const dup = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'First.', proposedDate: '2026-11-01', venue: 'G', notes: '' }, maria); assert.equal(dup.status, 201);
  const pending = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'Second.', proposedDate: '2026-11-01', venue: 'G', notes: '' }, maria); assert.equal(pending.status, 409); assert.equal(pending.body.error, 'REQUEST_PENDING');
  const acc = await S.j('POST', `/player/requests/${dup.body.requestId}/respond`, { accept: true, chosenSlot: '2026-11-01' }, token); assert.equal(acc.status, 200, acc.text);
  const requestId = dup.body.requestId; const trialId = acc.body.trialId;
  assert.ok(noBlobTable(dir), 'no blob table');
  const row = q1(dir, 'SELECT status, trial_id, contact_channel_id, player_id FROM recruitment_requests WHERE id = ?', requestId); assert.equal(row.status, 'accepted'); assert.equal(row.trial_id, trialId); assert.equal(row.player_id, pid);
  assert.equal(q1(dir, 'SELECT request_id FROM channels WHERE id = ?', row.contact_channel_id).request_id, requestId);
  const t = q1(dir, 'SELECT request_id, workflow_state, player_id FROM trials WHERE id = ?', trialId); assert.equal(t.request_id, requestId); assert.equal(t.workflow_state, 'accepted');
  assert.equal(qAll(dir, 'SELECT action FROM trial_history WHERE trial_id = ? ORDER BY position', trialId).map((r) => r.action).join(','), 'trial_accepted');
  assert.equal(q1(dir, "SELECT count(*) AS n FROM idempotency_keys WHERE owner_id = ? AND act = 'accept'", trialId).n, 0, 'keys.accept carries a null key: retained on the row, not an idempotency row');
  const list = await S.j('GET', '/org/trials', undefined, maria); assert.equal(list.body.items.find((x) => x.id === trialId).requestId, requestId);
  const inbox = await S.j('GET', '/player/inbox', undefined, token); assert.equal(inbox.body.items[0].id, requestId); assert.equal(inbox.body.items[0].status, 'accepted'); assert.equal(inbox.body.items[0].trialId, trialId);
  const mine = await S.j('GET', '/player/trials', undefined, token); assert.ok(mine.body.some((x) => x.id === trialId));
  const staff = await S.j('POST', `/org/trials/${trialId}/staff`, { name: 'Coach Dan', role: 'Lead coach' }, maria); assert.equal(staff.status, 201, staff.text);
  assert.equal(q1(dir, 'SELECT name FROM trial_day_staff WHERE trial_id = ?', trialId).name, 'Coach Dan');
  const rep = await S.j('POST', `/org/trials/${trialId}/report`, REPORT, maria); assert.equal(rep.status, 201, rep.text);
  assert.ok(q1(dir, 'SELECT 1 AS one FROM trial_reports WHERE trial_id = ?', trialId), 'the report is committed at the response');
  assert.equal(q1(dir, 'SELECT coach_rating, filed_at FROM trial_reports WHERE trial_id = ?', trialId).coach_rating, 8); assert.equal(q1(dir, 'SELECT status FROM trials WHERE id = ?', trialId).status, 'reported');
  const profile = await S.j('GET', `/org/players/${pid}`, undefined, maria); assert.equal(profile.body.trialReports?.length ?? profile.body.player?.trialReports?.length, 1, 'the derived trialReports on the profile');
  const cap = await S.j('GET', '/capabilities'); const dom = cap.body.dataLayer.domains.recruitment; assert.equal(dom.mode, 'live'); assert.equal(dom.rows.requests, 1); assert.equal(dom.rows.trials, 1);
  // SIGKILL right after an acceptance: the rows were committed by the route's own unit
  const b = await signupAdult(S, 'Killed Adult'); const second = await inviteAndAccept(S, maria, b.pid, b.token, { proposedDate: '2026-11-05' });
  await S.kill();
  assert.equal(q1(dir, 'SELECT status FROM recruitment_requests WHERE id = ?', second.requestId).status, 'accepted'); assert.ok(q1(dir, 'SELECT 1 AS one FROM trials WHERE id = ?', second.trialId));
  const S2 = await boot(dir); const mariaR = await orgLogin(S2); assert.equal((await S2.j('GET', '/org/trials', undefined, mariaR)).body.items.length, 2); await S2.stop(); rm(dir);
});

await test('[routes] two stored open-day invitations for one player (the shape the open-day outcome route writes, no one-pending guard) boot, are both served in the inbox and survive a save; a request naming a historically missing player is served and counted (Q7a), never refused; the deletion unit tombstones the requests and trials in place and deletes the thread — a failure of the REAL COMMIT leaves every row as it was; the retry lands once', async () => {
  const dir = tempDir('s8a-openday'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token } = await signupAdult(S, 'Open Day Adult'); const flow = await inviteAndAccept(S, maria, pid, token);
  await S.stop();
  assert.ok(noBlobTable(dir), 'no blob table');
  // two pending open-day invitations for the same org/player/type and one request of a missing player, written through
  // the repository (as the open-day outcome route writes them); then the backup of that database restored into a NEW directory
  { const L = openLayer(dir); const base = L.layer.recruitment.requests.byId(flow.requestId);
    const openDay = (id) => ({ id, playerId: pid, playerName: 'Open Day Adult', orgId: base.orgId, orgName: base.orgName, orgType: base.orgType, orgVerified: base.orgVerified, orgSafeguardingCertified: base.orgSafeguardingCertified, trustedPartner: base.trustedPartner, userId: base.userId, scoutName: base.scoutName, scoutRole: base.scoutRole, type: 'trial', message: 'We liked what we saw at "Open day" — come for a proper trial.', trialDetails: { proposedDate: null, altSlots: [], venue: 'Eastport Ground', notes: 'Follow-up from open day "Open day".' }, status: 'pending', createdAt: base.createdAt + 1, routedTo: 'player', guardianId: null, contactChannel: null });
    try { L.unit(() => { for (const r of [openDay('req-od1'), openDay('req-od2'), { ...openDay('req-gone'), playerId: 'pl-gone-long-ago', playerName: 'Gone' }]) L.layer.recruitment.requests.create(r); }); } finally { L.close(); } }
  S = await boot(dir); const bkp = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bkp.status, 201, bkp.text); await S.stop();
  const restored = tempDir('s8a-restored'); fs.cpSync(bkp.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.ok(live(restored));
  const inbox = await S.j('GET', '/player/inbox', undefined, (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token); assert.equal(inbox.body.items.filter((r) => r.status === 'pending' && r.type === 'trial').length, 2, 'both open-day invitations served');
  const mariaR = await orgLogin(S); assert.ok((await S.j('GET', '/org/requests', undefined, mariaR)).body.items.some((r) => r.id === 'req-gone'), 'the request of a missing player is served as today');
  const cap = await S.j('GET', '/capabilities'); assert.equal(cap.body.dataLayer.domains.recruitment.unresolvedPlayerReferences.requests, 1);
  assert.equal(q1(restored, "SELECT count(*) AS n FROM recruitment_requests WHERE status = 'pending' AND player_id = ?", pid).n, 2, 'both rows stored: no universal duplicate rejection');
  // the deletion unit, failed at the REAL COMMIT, then retried
  const before = recDump(restored);
  const tokenR = (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token;
  const inject = await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' }); assert.equal(inject.status, 200, inject.text); // the development fault layer's seam: the REAL COMMIT of the deletion unit fails once
  const failed = await S.j('DELETE', '/player/account', {}, tokenR); assert.equal(failed.status, 500, failed.text);
  assert.equal(recDump(restored), before, 'a failed REAL COMMIT leaves every recruitment and thread row as it was'); assert.equal((await S.j('GET', '/player/me', undefined, tokenR)).status, 200);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const ok = await S.j('DELETE', '/player/account', {}, tokenR); assert.equal(ok.status, 200, ok.text);
  assert.equal(q1(restored, 'SELECT count(*) AS n FROM recruitment_requests WHERE player_id = ? AND subject_removed_at IS NULL', pid).n, 0, 'every request of the person tombstoned in place'); assert.equal(q1(restored, 'SELECT player_name, message FROM recruitment_requests WHERE id = ?', flow.requestId).player_name, null);
  assert.equal(q1(restored, 'SELECT player_name, subject_removed_at FROM trials WHERE id = ?', flow.trialId).player_name, null); assert.ok(q1(restored, 'SELECT subject_removed_at FROM trials WHERE id = ?', flow.trialId).subject_removed_at);
  assert.equal(q1(restored, 'SELECT count(*) AS n FROM channels WHERE player_id = ?', pid).n, 0, 'the thread deleted (D-B), the request it named stays (RESTRICT satisfied by the order)');
  assert.ok(q1(restored, 'SELECT 1 AS one FROM recruitment_requests WHERE id = ?', 'req-gone'), 'the other person\'s request untouched');
  await S.stop(); rm(dir, restored, bkp.body.dir);
});

await test('[backup] the admin backup is a copy of the database: its requests and trials (the day staff, the report, the acceptance) equal the live rows, and a restore into a NEW directory serves them row for row', async () => {
  const dir = tempDir('s8a-backup'); let S = await boot(dir);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Backup Adult'); const flow = await inviteAndAccept(S, maria, a.pid, a.token);
  assert.equal((await S.j('POST', `/org/trials/${flow.trialId}/staff`, { name: 'Coach Dan', role: 'Lead coach' }, maria)).status, 201);
  assert.equal((await S.j('POST', `/org/trials/${flow.trialId}/report`, REPORT, maria)).status, 201); // the club's report obligation closed (either build refuses a new invitation while one is outstanding)
  assert.ok(await until(() => q1(dir, 'SELECT 1 AS one FROM trial_reports WHERE trial_id = ?', flow.trialId)), 'the report landed');
  const b = await signupAdult(S, 'Pending Adult'); assert.equal((await S.j('POST', `/org/players/${b.pid}/request`, { type: 'contact', message: 'Hello there.' }, maria)).status, 201);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  await S.stop();
  const liveDump = recDump(dir); assert.equal(recDump(bk.body.dir), liveDump, 'the backup holds every recruitment and thread row');
  assert.equal(q1(bk.body.dir, 'SELECT count(*) AS n FROM recruitment_requests').n, 2); assert.equal(q1(bk.body.dir, 'SELECT name FROM trial_day_staff WHERE trial_id = ?', flow.trialId).name, 'Coach Dan');
  { const s = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); const t = readTrials(s)[0]; assert.equal(t.requestId, flow.requestId); assert.deepEqual(t.history.map((h) => h.action).slice(0, 1), ['trial_accepted'], 'the acceptance is in the copy (recorded by the history entry)'); s.close(); }
  const restored = tempDir('s8a-restore'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); assert.equal(recDump(restored), liveDump, 'row for row');
  const mariaR = await orgLogin(S); assert.ok((await S.j('GET', '/org/trials', undefined, mariaR)).body.items.some((x) => x.id === flow.trialId), 'the restored server serves the trial'); await S.stop();
  rm(dir, restored, bk.body.dir);
});

// ------------------------------------------------------------- idempotency keys through the real routes
await test('[routes] through the real routes: an invitation with a clientKey replays (the same row, idempotent) and conflicts (TRIAL_IDEMPOTENCY_CONFLICT); a reschedule with a clientKey replays across a restart; a repository write of an act the routes never write (an unknown act, a prototype-named own act) is refused with the trial\'s id, and the real keys survive a backup and a restore (where the same clientKey still replays)', async () => {
  const dir = tempDir('s8a-f1'); let S = await boot(dir); let maria = await orgLogin(S); const a = await signupAdult(S, 'Keyed Adult');
  const room = await S.j('POST', '/org/rooms', { playerId: a.pid, sourceContext: 'search' }, maria); assert.equal(room.status, 201, room.text); const RID = room.body.room.roomId;
  const jr = (await S.j('GET', `/org/rooms/${RID}/journey`, undefined, maria)).body; if (jr.lifecycle.currentStage === 'watching') { const mv = await S.j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, maria); assert.equal(mv.status, 200, mv.text); }
  const T0 = Date.now(); const H = 3_600_000;
  const INVITE = (extra = {}) => ({ timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' }, message: 'Come and train.', instructions: 'Ask for Priya.', slots: [{ startsAt: T0 + 48 * H, endsAt: T0 + 50 * H, kind: 'training' }], clientKey: 'inv-key-1', ...extra });
  const inv = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE(), maria); assert.equal(inv.status, 201, inv.text);
  const replay = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE(), maria); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.idempotent, true, 'the same clientKey and payload: a replay');
  const conflict = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE({ message: 'A different message.' }), maria); assert.equal(conflict.body.error, 'TRIAL_IDEMPOTENCY_CONFLICT', conflict.text);
  assert.equal(q1(dir, 'SELECT count(*) AS n FROM recruitment_requests WHERE case_id = ?', RID).n, 1, 'one request row'); assert.equal(q1(dir, 'SELECT invite_key FROM recruitment_requests WHERE case_id = ?', RID).invite_key, 'inv-key-1', 'keys.invite as the request\'s own column');
  const pending = (await S.j('GET', '/player/inbox', undefined, a.token)).body.items.find((r) => r.type === 'trial' && r.status === 'pending'); assert.ok(pending, 'the invitation in the inbox');
  const acc = await S.j('POST', `/player/requests/${pending.id}/respond`, { accept: true, chosenSlot: pending.trialDetails.proposedDate }, a.token); assert.equal(acc.status, 200, acc.text); const TID = acc.body.trialId;
  const current = async (srv, token) => (await srv.j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, token)).body;
  // the revision moves the accepted slot's session (its id is stable, so the payload fingerprint is stable and the clientKey can replay; a NEW session gets a minted id)
  const SID = q1(dir, 'SELECT id FROM trial_schedule_sessions WHERE trial_id = ? ORDER BY position', TID).id; assert.ok(SID, 'the accepted slot became a session');
  const RESCHEDULE = (rev) => ({ timezone: 'Europe/London', expectedRev: rev, sessions: [{ id: SID, startsAt: T0 + 72 * H, endsAt: T0 + 74 * H, venue: { name: 'Eastport Dome', town: 'Eastport' }, kind: 'training' }], clientKey: 'sched-key-1' });
  const t0 = await current(S, maria); const res = await S.j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, RESCHEDULE(t0.trial?.rev ?? t0.rev), maria); assert.equal(res.status, 200, res.text);
  const replayS = async (srv, token, label) => { const t = await srv.j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, token); const r = await srv.j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, RESCHEDULE(t.body.trial?.rev ?? t.body.rev), token); assert.equal(r.status, 200, `${label}: ${r.text}`); assert.equal(r.body.idempotent, true, `${label}: the schedule clientKey replays`); return r; };
  await replayS(S, maria, 'same process');
  await S.stop(); S = await boot(dir); maria = await orgLogin(S); await replayS(S, maria, 'after a restart'); await S.stop();
  // An act the routes never write (an unknown act, a prototype-named own act) is refused by the trial's
  // repository update with the trial's id — nothing written — and the real keys survive a backup and a restore, where they still replay.
  { const L = openLayer(dir); const trials = L.layer.recruitment.trials; const t = trials.byId(TID); assert.ok(t && Array.isArray(t.keys.schedule) && t.keys.schedule[0].key === 'sched-key-1');
    const before = fullDump(L.sqlite);
    try {
      for (const [label, edit] of [['an unknown act', (k) => { k.extraEmpty = {}; }], ['a prototype-named own act', (k) => { Object.defineProperty(k, '__proto__', { value: { key: 'proto-key', fp: 'proto-fp' }, enumerable: true, writable: true, configurable: true }); }]]) {
        assert.throws(() => trials.update(TID, (x) => { edit(x.keys); }), (e) => e.code === 'RECRUITMENT_INPUT_INVALID' && e.message.includes(TID) && /keys\.(extraEmpty|__proto__)/.test(e.message), `${label} is refused with the trial's id`);
        assert.equal(fullDump(L.sqlite), before, `${label}: nothing written`);
      }
    } finally { L.close(); } }
  const expectKeys = (keys, label) => { assert.ok(Array.isArray(keys.cancel) && keys.cancel.length === 0, `${label}: an act with no key reads back as an empty list`); assert.equal(keys.schedule[0].key, 'sched-key-1', `${label}: the real key`); assert.deepEqual(Object.keys(keys).sort(), ['attendance', 'cancel', 'complete', 'link', 'schedule'], `${label}: the five acts and nothing else`); };
  S = await boot(dir); maria = await orgLogin(S); await replayS(S, maria, 'after the refused edits');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text); await S.stop();
  { const s = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); expectKeys(readTrials(s).find((x) => x.id === TID).keys, 'the backup copy'); s.close(); }
  const restored = tempDir('s8a-f1-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); maria = await orgLogin(S); await replayS(S, maria, 'the restore'); await S.stop();
  expectKeys(readRecords(restored).trials.find((x) => x.id === TID).keys, 'read back from the restored tables');
  rm(dir, restored, bk.body.dir);
});

await test('[paging] the club Requests and Trials lists and both inboxes page newest first by cursor ({ items, nextCursor }): every row exactly once across the pages, junk limit and cursor refused with 400; /org/recruitment-counts gives the home figures from SQL, past the first page, and only for the asking club', async () => {
  const dir = tempDir('s8a-paging'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token } = await signupAdult(S, 'Paging Adult'); const flow = await inviteAndAccept(S, maria, pid, token);
  await S.stop();
  { const L = openLayer(dir); const base = L.layer.recruitment.requests.byId(flow.requestId);
    const pending = (id, i, over = {}) => ({ id, playerId: pid, playerName: 'Paging Adult', orgId: base.orgId, orgName: base.orgName, orgType: base.orgType, orgVerified: base.orgVerified, orgSafeguardingCertified: base.orgSafeguardingCertified, trustedPartner: base.trustedPartner, userId: base.userId, scoutName: base.scoutName, scoutRole: base.scoutRole, type: 'trial', message: 'Synthetic open-day follow-up.', trialDetails: { proposedDate: null, altSlots: [], venue: 'Eastport Ground', notes: 'Synthetic.' }, status: 'pending', createdAt: base.createdAt + 1 + i, routedTo: 'player', guardianId: null, contactChannel: null, ...over });
    const toPlayer = Array.from({ length: 55 }, (_, i) => pending(`req-pg-${String(i).padStart(2, '0')}`, i));
    const toGuardian = Array.from({ length: 3 }, (_, i) => pending(`req-pgg-${i}`, 100 + i, { playerId: 'pl-guni', playerName: 'Guni', routedTo: 'guardian', guardianId: 'gd-amara' }));
    try { L.unit(() => { for (const r of [...toPlayer, ...toGuardian]) L.layer.recruitment.requests.create(r); }); } finally { L.close(); } }
  S = await boot(dir);
  const maria2 = await orgLogin(S); const adult = (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token;
  const amara = (await S.j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token; const harbour = await orgLogin(S, 'org-harbour', 'Synthetic Scout', 'Scout');
  /** Every page of `route` (limit `n`): the ids in order, and the page sizes. */
  const walk = async (route, who, n = 50) => { const ids = []; const sizes = []; let cursor = null;
    for (let guard = 0; guard < 20; guard++) { const r = await S.j('GET', `${route}?limit=${n}${cursor ? `&cursor=${cursor}` : ''}`, undefined, who); assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.body).sort(), ['items', 'nextCursor']); ids.push(...r.body.items.map((x) => x.id)); sizes.push(r.body.items.length); cursor = r.body.nextCursor; if (!cursor) return { ids, sizes }; }
    throw new Error(`${route} never ended`); };
  const newestFirst = (table, where, ...p) => qAll(dir, `SELECT id FROM ${table} WHERE ${where} ORDER BY rowid DESC`, ...p).map((r) => r.id);

  const orgReqs = await walk('/org/requests', maria2);
  assert.deepEqual(orgReqs.ids, newestFirst('recruitment_requests', "org_id = 'org-eastport'"), 'the club list: every request once, newest first');
  assert.equal(orgReqs.sizes[0], 50, 'the default page is 50'); assert.equal(orgReqs.ids[0], 'req-pgg-2');
  const inbox = await walk('/player/inbox', adult, 20);
  assert.deepEqual(inbox.ids, newestFirst('recruitment_requests', 'player_id = ?', pid), 'the player Inbox: every request once, newest first');
  assert.deepEqual(inbox.sizes, [20, 20, 16]);
  const gInbox = await walk('/guardian/inbox', amara, 2);
  assert.deepEqual(gInbox.ids, ['req-pgg-2', 'req-pgg-1', 'req-pgg-0'], 'the guardian Inbox: only the requests routed to the guardian, newest first');
  const trials = await walk('/org/trials', maria2);
  assert.deepEqual(trials.ids, [flow.trialId]);
  assert.deepEqual((await walk('/org/requests', harbour)).ids, [], 'another club sees none of them');

  for (const [q, code] of [['limit=0', 'PAGE_LIMIT_INVALID'], ['limit=101', 'PAGE_LIMIT_INVALID'], ['limit=ten', 'PAGE_LIMIT_INVALID'], ['cursor=junk', 'PAGE_CURSOR_INVALID']]) {
    for (const [route, who] of [['/org/requests', maria2], ['/org/trials', maria2], ['/player/inbox', adult], ['/guardian/inbox', amara]]) {
      const r = await S.j('GET', `${route}?${q}`, undefined, who); assert.equal(r.status, 400, `${route}?${q}`); assert.equal(r.body.error, code);
    }
  }

  const counts = await S.j('GET', '/org/recruitment-counts', undefined, maria2); assert.equal(counts.status, 200, counts.text);
  assert.deepEqual(counts.body, {
    requestsPending: q1(dir, "SELECT count(*) AS n FROM recruitment_requests WHERE org_id = 'org-eastport' AND status = 'pending'").n,
    trialsAwaitingReport: q1(dir, "SELECT count(*) AS n FROM trials WHERE org_id = 'org-eastport' AND status = 'awaiting_report'").n,
    trials: 1,
  });
  assert.equal(counts.body.requestsPending, 58, 'the figure counts past the first page');
  assert.deepEqual((await S.j('GET', '/org/recruitment-counts', undefined, harbour)).body, { requestsPending: 0, trialsAwaitingReport: 0, trials: 0 }, 'another club counts only its own');
  assert.equal((await S.j('GET', '/org/recruitment-counts')).status, 401, 'staff only');
  await S.stop(); rm(dir);
});

console.log(`\n${passed} recruitment server checks passed`);
