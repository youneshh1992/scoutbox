// S8a-core through the REAL server (server.mjs booted as a child process on temporary
// data directories, synthetic seed records only): requests and trials as tables — the
// direct trial invitation, the player's acceptance (the request's answer, the thread with
// its REAL request key and the trial row in ONE save), the mandatory report, the trial-day
// staff route, the inbox/listing routes answering as before, the duplicate-pending answer of
// the direct route beside two stored open-day invitations for one player (D2), a SIGKILL
// right after the acceptance, the deletion unit's tombstones (requests and trials reduced in
// place, the thread deleted) with a REAL COMMIT failure leaving everything as it was, a
// request naming a historically missing player served and counted (Q7a), and the admin
// backup (a copy of the database) restored into a NEW directory row for row. Every database read goes
// through a second read-only connection. Nothing here touches DATA_DIR or real data.
// Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { readTrials } from '../repositories/recruitment.mjs';
import { openStore } from '../store.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll until `check` is truthy (a route that lands its rows in the debounced persist() rather than a persistNow()). */
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const MIGRATION = '0015_recruitment';
const TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
const REPORT = { acceleration: 7, sprintSpeedKmh: 31, distanceKm: 6.2, passCompletionPct: 78, duelSuccessPct: 55, coachRating: 8, notes: 'Quick feet.' };

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(proc); proc.on('exit', () => children.delete(proc));
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
const blobOf = (dir, name) => snap(dir, (c) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : undefined; });
const tableExists = (dir, t) => !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const recDump = (dir) => JSON.stringify(Object.fromEntries([...TABLES, 'channels', 'messages'].filter((t) => tableExists(dir, t)).map((t) => [t, qAll(dir, `SELECT * FROM ${t} ORDER BY rowid`)])));
const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
/** A direct trial invitation (the legacy route) answered by the adult: the request's answer, the thread and the trial in one save. */
async function inviteAndAccept(S, maria, pid, token, { proposedDate = '2026-11-01' } = {}) {
  const inv = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'Come and train with us.', proposedDate, altSlots: ['2026-11-02'], venue: 'Eastport Ground', notes: 'Bring boots' }, maria); assert.equal(inv.status, 201, inv.text);
  const acc = await S.j('POST', `/player/requests/${inv.body.requestId}/respond`, { accept: true, chosenSlot: proposedDate }, token); assert.equal(acc.status, 200, acc.text);
  return { requestId: inv.body.requestId, trialId: acc.body.trialId, channelId: acc.body.contactChannel };
}

await test('[routes] a fresh boot records 0015_recruitment (followed by S8b\'s 0016 since that step) and the fifteen tables exist with channels carrying the real request key; the direct invitation and the adult\'s acceptance land as rows (the request answered, the trial with its history and keys.accept, the thread naming the request through the key) with no blob behind them; /org/requests, /org/trials, /player/inbox and /player/trials answer as before; the report lands in trial_reports and the day staff in trial_day_staff; the direct route still answers REQUEST_PENDING; a SIGKILL right after the acceptance loses nothing; /capabilities counts the rows', async () => {
  const dir = tempDir('s8a-boot'); const S = await boot(dir);
  assert.equal(applied(dir).at(-4), MIGRATION, 'the S8a migration, recorded before S8b\'s 0016, S8c\'s 0017 and S8d\'s 0018'); for (const t of TABLES) assert.ok(tableExists(dir, t), `${t} exists`);
  assert.ok(qAll(dir, 'PRAGMA foreign_key_list(channels)').some((r) => r.table === 'recruitment_requests'), 'channels.request_id is a real key');
  const maria = await orgLogin(S); const { pid, token } = await signupAdult(S, 'Invited Adult');
  const dup = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'First.', proposedDate: '2026-11-01', venue: 'G', notes: '' }, maria); assert.equal(dup.status, 201);
  const pending = await S.j('POST', `/org/players/${pid}/request`, { type: 'trial', message: 'Second.', proposedDate: '2026-11-01', venue: 'G', notes: '' }, maria); assert.equal(pending.status, 409); assert.equal(pending.body.error, 'REQUEST_PENDING');
  const acc = await S.j('POST', `/player/requests/${dup.body.requestId}/respond`, { accept: true, chosenSlot: '2026-11-01' }, token); assert.equal(acc.status, 200, acc.text);
  const requestId = dup.body.requestId; const trialId = acc.body.trialId;
  assert.equal(blobOf(dir, 'requests'), undefined); assert.equal(blobOf(dir, 'trials'), undefined);
  const row = q1(dir, 'SELECT status, trial_id, contact_channel_id, player_id FROM recruitment_requests WHERE id = ?', requestId); assert.equal(row.status, 'accepted'); assert.equal(row.trial_id, trialId); assert.equal(row.player_id, pid);
  assert.equal(q1(dir, 'SELECT request_id FROM channels WHERE id = ?', row.contact_channel_id).request_id, requestId);
  const t = q1(dir, 'SELECT request_id, workflow_state, player_id FROM trials WHERE id = ?', trialId); assert.equal(t.request_id, requestId); assert.equal(t.workflow_state, 'accepted');
  assert.equal(qAll(dir, 'SELECT action FROM trial_history WHERE trial_id = ? ORDER BY position', trialId).map((r) => r.action).join(','), 'trial_accepted');
  assert.equal(q1(dir, "SELECT count(*) AS n FROM idempotency_keys WHERE owner_id = ? AND act = 'accept'", trialId).n, 0, 'keys.accept carries a null key: retained on the row, not an idempotency row');
  const list = await S.j('GET', '/org/trials', undefined, maria); assert.equal(list.body.find((x) => x.id === trialId).requestId, requestId);
  const inbox = await S.j('GET', '/player/inbox', undefined, token); assert.equal(inbox.body[0].id, requestId); assert.equal(inbox.body[0].status, 'accepted'); assert.equal(inbox.body[0].trialId, trialId);
  const mine = await S.j('GET', '/player/trials', undefined, token); assert.ok(mine.body.some((x) => x.id === trialId));
  const staff = await S.j('POST', `/org/trials/${trialId}/staff`, { name: 'Coach Dan', role: 'Lead coach' }, maria); assert.equal(staff.status, 201, staff.text);
  assert.equal(q1(dir, 'SELECT name FROM trial_day_staff WHERE trial_id = ?', trialId).name, 'Coach Dan');
  const rep = await S.j('POST', `/org/trials/${trialId}/report`, REPORT, maria); assert.equal(rep.status, 201, rep.text);
  assert.ok(await until(() => q1(dir, 'SELECT 1 AS one FROM trial_reports WHERE trial_id = ?', trialId)), 'the report lands in the route\'s debounced save (as its blob did)');
  assert.equal(q1(dir, 'SELECT coach_rating, filed_at FROM trial_reports WHERE trial_id = ?', trialId).coach_rating, 8); assert.equal(q1(dir, 'SELECT status FROM trials WHERE id = ?', trialId).status, 'reported');
  const profile = await S.j('GET', `/org/players/${pid}`, undefined, maria); assert.equal(profile.body.trialReports?.length ?? profile.body.player?.trialReports?.length, 1, 'the derived trialReports on the profile');
  const cap = await S.j('GET', '/capabilities'); const dom = cap.body.dataLayer.domains.recruitment; assert.equal(dom.mode, 'live'); assert.equal(dom.rows.requests, 1); assert.equal(dom.rows.trials, 1);
  // SIGKILL right after an acceptance: the rows were in the route's own save
  const b = await signupAdult(S, 'Killed Adult'); const second = await inviteAndAccept(S, maria, b.pid, b.token, { proposedDate: '2026-11-05' });
  await S.kill();
  assert.equal(q1(dir, 'SELECT status FROM recruitment_requests WHERE id = ?', second.requestId).status, 'accepted'); assert.ok(q1(dir, 'SELECT 1 AS one FROM trials WHERE id = ?', second.trialId));
  const S2 = await boot(dir); const mariaR = await orgLogin(S2); assert.equal((await S2.j('GET', '/org/trials', undefined, mariaR)).body.length, 2); await S2.stop(); rm(dir);
});

await test('[routes] two stored open-day invitations for one player (the shape the open-day outcome route writes, no one-pending guard) boot, are both served in the inbox and survive a save; a request naming a historically missing player is served and counted (Q7a), never refused; the deletion unit tombstones the requests and trials in place and deletes the thread — a failure of the REAL COMMIT leaves every row as it was; the retry lands once', async () => {
  const dir = tempDir('s8a-openday'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token } = await signupAdult(S, 'Open Day Adult'); const flow = await inviteAndAccept(S, maria, pid, token);
  await S.stop();
  assert.equal(blobOf(dir, 'requests'), undefined, 'no blob');
  // two pending open-day invitations for the same org/player/type and one request of a missing player, written by a
  // snapshot-mode save (as a tool would); then the backup of that database restored into a NEW directory
  { const store = openStore(dir); const loaded = store.load(); const base = loaded.db.requests.find((r) => r.id === flow.requestId);
    const openDay = (id) => ({ id, playerId: pid, playerName: 'Open Day Adult', orgId: base.orgId, orgName: base.orgName, orgType: base.orgType, orgVerified: base.orgVerified, orgSafeguardingCertified: base.orgSafeguardingCertified, trustedPartner: base.trustedPartner, userId: base.userId, scoutName: base.scoutName, scoutRole: base.scoutRole, type: 'trial', message: 'We liked what we saw at "Open day" — come for a proper trial.', trialDetails: { proposedDate: null, altSlots: [], venue: 'Eastport Ground', notes: 'Follow-up from open day "Open day".' }, status: 'pending', createdAt: base.createdAt + 1, routedTo: 'player', guardianId: null, contactChannel: null });
    loaded.db.requests = [...loaded.db.requests, openDay('req-od1'), openDay('req-od2'), { ...openDay('req-gone'), playerId: 'pl-gone-long-ago', playerName: 'Gone' }];
    store.save(loaded); store.sqlite.close(); }
  S = await boot(dir); const bkp = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bkp.status, 201, bkp.text); await S.stop();
  const restored = tempDir('s8a-restored'); fs.cpSync(bkp.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.ok(live(restored));
  const inbox = await S.j('GET', '/player/inbox', undefined, (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token); assert.equal(inbox.body.filter((r) => r.status === 'pending' && r.type === 'trial').length, 2, 'both open-day invitations served');
  const mariaR = await orgLogin(S); assert.ok((await S.j('GET', '/org/requests', undefined, mariaR)).body.some((r) => r.id === 'req-gone'), 'the request of a missing player is served as today');
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

await test('[backup] the admin backup is a copy of the database: its requests and trials (the day staff, the report, keys.accept) equal the live rows, and a restore into a NEW directory serves them row for row', async () => {
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
  { const s = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); assert.deepEqual(readTrials(s)[0].keys.accept, { key: null, fp: JSON.stringify({ requestId: flow.requestId, day: '2026-11-01' }) }); s.close(); }
  const restored = tempDir('s8a-restore'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); assert.equal(recDump(restored), liveDump, 'row for row');
  const mariaR = await orgLogin(S); assert.ok((await S.j('GET', '/org/trials', undefined, mariaR)).body.some((x) => x.id === flow.trialId), 'the restored server serves the trial'); await S.stop();
  rm(dir, restored, bk.body.dir);
});

// ------------------------------------------------------------- review of 6d77aa7 (F1)
await test('[routes] F1 (review of 6d77aa7) through the real routes: an invitation with a clientKey replays (the same row, idempotent) and conflicts (TRIAL_IDEMPOTENCY_CONFLICT); a reschedule with a clientKey replays across a restart; a trial whose keys carry an empty list act, an empty object act and a prototype-named own act (written by a snapshot-mode save — no route produces them today) keeps every act distinctly through a backup and a restore (where the same clientKey still replays)', async () => {
  const dir = tempDir('s8a-f1'); let S = await boot(dir); let maria = await orgLogin(S); const a = await signupAdult(S, 'Keyed Adult');
  const room = await S.j('POST', '/org/rooms', { playerId: a.pid, sourceContext: 'search' }, maria); assert.equal(room.status, 201, room.text); const RID = room.body.room.roomId;
  const jr = (await S.j('GET', `/org/rooms/${RID}/journey`, undefined, maria)).body; if (jr.lifecycle.currentStage === 'watching') { const mv = await S.j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, maria); assert.equal(mv.status, 200, mv.text); }
  const T0 = Date.now(); const H = 3_600_000;
  const INVITE = (extra = {}) => ({ timezone: 'Europe/London', venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' }, message: 'Come and train.', instructions: 'Ask for Priya.', slots: [{ startsAt: T0 + 48 * H, endsAt: T0 + 50 * H, kind: 'training' }], clientKey: 'inv-key-1', ...extra });
  const inv = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE(), maria); assert.equal(inv.status, 201, inv.text);
  const replay = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE(), maria); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.idempotent, true, 'the same clientKey and payload: a replay');
  const conflict = await S.j('POST', `/org/rooms/${RID}/trials`, INVITE({ message: 'A different message.' }), maria); assert.equal(conflict.body.error, 'TRIAL_IDEMPOTENCY_CONFLICT', conflict.text);
  assert.equal(q1(dir, 'SELECT count(*) AS n FROM recruitment_requests WHERE case_id = ?', RID).n, 1, 'one request row'); assert.equal(q1(dir, "SELECT key FROM idempotency_keys WHERE owner_table = 'recruitment_requests' AND act = 'invite'").key, 'inv-key-1', 'keys.invite as a row');
  const pending = (await S.j('GET', '/player/inbox', undefined, a.token)).body.find((r) => r.type === 'trial' && r.status === 'pending'); assert.ok(pending, 'the invitation in the inbox');
  const acc = await S.j('POST', `/player/requests/${pending.id}/respond`, { accept: true, chosenSlot: pending.trialDetails.proposedDate }, a.token); assert.equal(acc.status, 200, acc.text); const TID = acc.body.trialId;
  const current = async (srv, token) => (await srv.j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, token)).body;
  // the revision moves the accepted slot's session (its id is stable, so the payload fingerprint is stable and the clientKey can replay; a NEW session gets a minted id — a route rule outside this step)
  const SID = q1(dir, 'SELECT id FROM trial_schedule_sessions WHERE trial_id = ? ORDER BY position', TID).id; assert.ok(SID, 'the accepted slot became a session');
  const RESCHEDULE = (rev) => ({ timezone: 'Europe/London', expectedRev: rev, sessions: [{ id: SID, startsAt: T0 + 72 * H, endsAt: T0 + 74 * H, venue: { name: 'Eastport Dome', town: 'Eastport' }, kind: 'training' }], clientKey: 'sched-key-1' });
  const t0 = await current(S, maria); const res = await S.j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, RESCHEDULE(t0.trial?.rev ?? t0.rev), maria); assert.equal(res.status, 200, res.text);
  const replayS = async (srv, token, label) => { const t = await srv.j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, token); const r = await srv.j('POST', `/org/rooms/${RID}/trials/${TID}/reschedule`, RESCHEDULE(t.body.trial?.rev ?? t.body.rev), token); assert.equal(r.status, 200, `${label}: ${r.text}`); assert.equal(r.body.idempotent, true, `${label}: the schedule clientKey replays`); return r; };
  await replayS(S, maria, 'same process');
  await S.stop(); S = await boot(dir); maria = await orgLogin(S); await replayS(S, maria, 'after a restart'); await S.stop();
  // the hand-written acts: an empty list, an empty object and a prototype-named own act beside the real schedule key
  { const store = openStore(dir); const loaded = store.load(); const t = loaded.db.trials.find((x) => x.id === TID); assert.ok(t && Array.isArray(t.keys.schedule) && t.keys.schedule[0].key === 'sched-key-1');
    t.keys.cancel = []; t.keys.extraEmpty = {}; Object.defineProperty(t.keys, '__proto__', { value: { key: 'proto-key', fp: 'proto-fp' }, enumerable: true, writable: true, configurable: true });
    store.save(loaded); store.sqlite.close(); }
  const expectKeys = (keys, label) => { assert.ok(Object.hasOwn(keys, 'cancel') && Array.isArray(keys.cancel) && keys.cancel.length === 0, `${label}: the empty list act is present and empty`); assert.ok(Object.hasOwn(keys, 'extraEmpty') && Object.keys(keys.extraEmpty).length === 0, `${label}: the empty object act`); assert.ok(Object.hasOwn(keys, '__proto__') && keys.__proto__.key === 'proto-key', `${label}: the prototype-named own act`); assert.equal(keys.schedule[0].key, 'sched-key-1', `${label}: the real key`); };
  S = await boot(dir); maria = await orgLogin(S); await replayS(S, maria, 'after the hand edit');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text); await S.stop();
  { const s = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); expectKeys(readTrials(s).find((x) => x.id === TID).keys, 'the backup copy'); s.close(); }
  const restored = tempDir('s8a-f1-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); maria = await orgLogin(S); await replayS(S, maria, 'the restore'); await S.stop();
  { const store = openStore(restored); expectKeys(store.load().db.trials.find((x) => x.id === TID).keys, 'read back from the restored tables'); store.sqlite.close(); }
  rm(dir, restored, bk.body.dir);
});

console.log(`\n${passed} recruitment server checks passed`);
