// S8b through the REAL server (server.mjs booted as a child process on temporary data directories, synthetic records
// only): recruitment cases, room comments, room snapshots, room decisions and room evidence states as tables. A room
// created and one adopting an M12 case, a comment edited and tombstoned, a task, a status move with its snapshot, an
// archive and a reopen, an evidence review overwritten in place, a decision draft replayed and conflicted, finalized
// with its key rows moved to the formal row, an M12 case with its budget scenario (lines, fx assumption, approval,
// actual), the handoff readiness route, the listing and reading routes answering as before, a SIGKILL right after a
// comment, /capabilities counting the rows; the player's and the guardian's surfaces acquiring no internal note, no
// decision and no mention of a room; another club's 404; the deletion unit tombstoning the cases in place with a REAL
// COMMIT failure leaving every row as it was and the retry landing once; a case naming a historically missing player
// restored, served and counted (Q8a); the admin backup (a copy of the database) holding the five collections, a restore
// into a NEW directory serving them row for row. Every database read goes through a
// second read-only connection. Nothing here touches DATA_DIR or real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { readCases, readRoomComments, readRoomDecisions } from '../repositories/recruitmentCases.mjs';
import { openStore } from '../store.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const MIGRATION = '0016_recruitment_cases';
const COLLECTIONS = ['recruitmentCases', 'roomComments', 'roomSnapshots', 'roomDecisions', 'roomEvidenceState'];
const CASE_TABLES = ['recruitment_cases', 'case_room_tags', 'case_assignments', 'case_tasks', 'case_approvals', 'case_history', 'case_request_links', 'case_trial_links', 'case_decision_drafts', 'case_decision_draft_reason_codes', 'case_decision_draft_evidence_refs', 'case_transaction_handoffs', 'case_budget_scenarios', 'case_budget_lines', 'case_budget_fx_assumptions', 'case_budget_actuals'];
const ROOM_TABLES = ['room_comments', 'room_comment_mentions', 'room_snapshots', 'room_snapshot_source_refs', 'room_decisions', 'room_decision_reason_codes', 'room_decision_evidence_refs', 'room_decision_assessment_ids', 'room_evidence_states'];
const TABLES = [...CASE_TABLES, ...ROOM_TABLES];
const S8A_TABLES = ['recruitment_requests', 'request_trial_slots', 'trials', 'trial_schedule_sessions', 'trial_session_evidence', 'trial_schedule_revisions', 'trial_attendance', 'trial_reminders', 'trial_day_staff', 'trial_day_consents', 'trial_day_checkins', 'trial_day_status_events', 'trial_reports', 'trial_history', 'idempotency_keys'];
const INTERNAL_COMMENT = 'Internal: prefers the left channel, watch 42:10.';
const INTERNAL_NOTE = 'Internal: hold until the winter window.';

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
const blobOf = (dir, name) => snap(dir, (c) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : undefined; });
const tableExists = (dir, t) => !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const fkOf = (dir, t) => qAll(dir, `PRAGMA foreign_key_list(${t})`).map((r) => `${r.from}->${r.table}(${r.to}) ${r.on_delete}`);
const ddlOf = (dir, t) => q1(dir, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", t)?.sql ?? null;
/** The S8b, S8a and thread tables as an exact dump (rowid order). */
const recDump = (dir) => JSON.stringify(Object.fromEntries([...TABLES, ...S8A_TABLES, 'channels', 'messages'].filter((t) => tableExists(dir, t)).map((t) => [t, qAll(dir, `SELECT * FROM ${t} ORDER BY rowid`)])));
const caseRow = (dir, id) => q1(dir, 'SELECT * FROM recruitment_cases WHERE id = ?', id);
const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
const playerLogin = async (S, pid) => (await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' })).body.token;
/** A verified guardian with one child (the player-erasure suite's recipe). */
async function guardianWithChild(S, tag) {
  const gs = await S.j('POST', '/auth/guardian/signup', { name: `Parent ${tag}`, email: `parent-${tag}@example.test`, password: 'synthetic-pass-1' }); assert.equal(gs.status, 201, gs.text);
  const token = gs.body.token;
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs.body.guardianId, code: gs.body.devEmailCode })).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, token)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, token)).status, 200);
  const kid = await S.j('POST', '/guardian/children', { name: `Kid ${tag}`, dob: '2015-05-05' }, token); assert.equal(kid.status, 201, kid.text);
  return { token, guardianId: gs.body.guardianId, childId: kid.body.playerId };
}
/** A room for a player (201) or the existing one. */
async function roomFor(S, token, playerId, extra = {}) { const r = await S.j('POST', '/org/rooms', { playerId, sourceContext: 'search', ...extra }, token); assert.ok(r.status === 201 || r.body?.existingRoomId, r.text); return { id: r.status === 201 ? r.body.room.roomId : r.body.existingRoomId, adopted: r.body?.adoptedExistingCase === true, status: r.status, body: r.body }; }
const roomRev = async (S, token, id) => (await S.j('GET', `/org/rooms/${id}`, undefined, token)).body.room.rev;
const moveStatus = async (S, token, id, status, extra = {}) => S.j('POST', `/org/rooms/${id}/status`, { status, expectedRev: await roomRev(S, token, id), ...extra }, token);

await test('[routes] a fresh boot records 0016_recruitment_cases last; the twenty-five tables exist, recruitment_requests and trials carry the REAL case key, idempotency_keys the broadened CHECK, no blob behind any of the five; a room created, a comment (edited, tombstoned), a task, a status move with its snapshot, an archive and a reopen, an evidence review overwritten in place, a draft replayed/conflicted/patched/finalized with its key rows, an M12 case with its budget and a room adopting it land as rows the moment the route answers; the handoff readiness route, the listing and reading routes answer as before; a SIGKILL right after a comment loses nothing; /capabilities counts the rows; [compat] another club gets 404, the player\'s and the guardian\'s surfaces carry no internal note, no decision and no room', async () => {
  const dir = tempDir('s8b-boot'); let S = await boot(dir);
  assert.equal(applied(dir).at(-3), MIGRATION, 'the recorded migration (0017_recruitment_contacts_offers, S8c, and 0018_signings_follow_ups, S8d, follow it on the same boot)'); assert.equal(applied(dir).at(-2), '0017_recruitment_contacts_offers'); assert.equal(applied(dir).at(-1), '0018_signings_follow_ups'); for (const t of TABLES) assert.ok(tableExists(dir, t), `${t} exists`);
  for (const t of ['recruitment_requests', 'trials']) assert.ok(fkOf(dir, t).includes('case_id->recruitment_cases(id) RESTRICT'), `${t}.case_id is a real key: ${fkOf(dir, t)}`);
  assert.match(ddlOf(dir, 'idempotency_keys') ?? '', /'case_decision_drafts', 'case_transaction_handoffs', 'room_decisions'/, 'the broadened owner CHECK');
  for (const n of COLLECTIONS) assert.equal(blobOf(dir, n), undefined, `${n}: no blob`);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Room Adult'); const b = await signupAdult(S, 'Case Adult'); const c = await signupAdult(S, 'Adopted Adult');
  // the room
  const room = await roomFor(S, maria, a.pid); assert.equal(room.status, 201); const RID = room.id;
  const row0 = caseRow(dir, RID); assert.ok(row0, 'the case row'); assert.equal(row0.player_id, a.pid); assert.equal(row0.room_status, room.body.room.status, 'the status the route answered (the M23 initial status)'); assert.equal(row0.org_id, 'org-eastport'); assert.equal(row0.room_rev, 1);
  if (row0.room_status === 'watching') { const mv = await S.j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview', expectedRev: await roomRev(S, maria, RID) }, maria); assert.equal(mv.status, 200, mv.text); assert.equal(caseRow(dir, RID).room_status, 'under_review', 'the lifecycle move landed'); }
  const hist0 = qAll(dir, 'SELECT position, action FROM case_history WHERE case_id = ? ORDER BY position', RID); assert.ok(hist0.length >= 1 && hist0.some((r) => r.action === 'room_created'), 'the room_created history entry is a row'); assert.deepEqual(hist0.map((r) => r.position), hist0.map((_, i) => i), 'history rows in list order');
  // comments
  const cm = await S.j('POST', `/org/rooms/${RID}/comments`, { body: INTERNAL_COMMENT }, maria); assert.equal(cm.status, 201, cm.text); const CID = cm.body.comment.id;
  assert.equal(q1(dir, 'SELECT body, author_user_id, edit_count FROM room_comments WHERE id = ?', CID).body, INTERNAL_COMMENT);
  const ed = await S.j('PATCH', `/org/rooms/${RID}/comments/${CID}`, { body: `${INTERNAL_COMMENT} Edited.` }, maria); assert.equal(ed.status, 200, ed.text); assert.equal(q1(dir, 'SELECT edit_count FROM room_comments WHERE id = ?', CID).edit_count, 1);
  const cm2 = await S.j('POST', `/org/rooms/${RID}/comments`, { body: 'Second thought.', replyToId: CID }, maria); assert.equal(cm2.status, 201, cm2.text);
  const del = await S.j('DELETE', `/org/rooms/${RID}/comments/${cm2.body.comment.id}`, {}, maria); assert.equal(del.status, 200, del.text); assert.ok(q1(dir, 'SELECT deleted_at FROM room_comments WHERE id = ?', cm2.body.comment.id).deleted_at, 'the tombstone');
  const thread = await S.j('GET', `/org/rooms/${RID}/comments`, undefined, maria); assert.equal(thread.status, 200); assert.equal((thread.body.comments ?? thread.body.items ?? thread.body).length, 2, '[compat] the thread keeps its shape');
  // a task
  const task = await S.j('POST', `/org/rooms/${RID}/tasks`, { title: 'Review Box Cam evidence' }, maria); assert.equal(task.status, 201, task.text);
  assert.equal(q1(dir, 'SELECT title, status FROM case_tasks WHERE case_id = ? AND id = ?', RID, task.body.task.id).title, 'Review Box Cam evidence');
  // a status move with its snapshot; an archive; a reopen
  const sl = await moveStatus(S, maria, RID, 'shortlisted'); assert.equal(sl.status, 200, sl.text);
  assert.equal(caseRow(dir, RID).room_status, 'shortlisted'); assert.equal(caseRow(dir, RID).stage, sl.body.room.stage);
  if (sl.body.snapshot) { assert.ok(q1(dir, 'SELECT 1 AS one FROM room_snapshots WHERE id = ?', sl.body.snapshot.id), 'the status snapshot is a row'); assert.equal(q1(dir, 'SELECT trigger FROM room_snapshots WHERE id = ?', sl.body.snapshot.id).trigger, 'status:shortlisted'); }
  const ar = await moveStatus(S, maria, RID, 'archived', { reasonCodes: ['insufficient_recent_evidence'] }); assert.equal(ar.status, 200, ar.text); assert.ok(caseRow(dir, RID).room_archived_at);
  const re = await moveStatus(S, maria, RID, 'under_review', { reasonCodes: ['continue_monitoring'] }); assert.equal(re.status, 200, re.text);
  const reRow = caseRow(dir, RID); assert.equal(reRow.room_status, 'under_review'); assert.equal(reRow.room_archived_at, null); assert.ok(reRow.room_reopened_from === 'archived' || /archived/.test(String(reRow.room_reopened_json ?? '')), `the reopen facet persisted: ${JSON.stringify(reRow)}`);
  // an evidence review, overwritten in place
  const ev = await S.j('POST', '/player/evidence', { claimType: 'statistic', label: 'League goals 2025/26', value: 14, units: 'goals', season: '2025/26' }, a.token); assert.equal(ev.status, 201, ev.text); const EID = ev.body.evidence.id;
  const rv = await S.j('POST', `/org/rooms/${RID}/evidence/${EID}/review`, { state: 'reviewed', note: 'Good angle.' }, maria); assert.equal(rv.status, 200, rv.text);
  assert.equal(q1(dir, 'SELECT state, note FROM room_evidence_states WHERE room_id = ? AND evidence_id = ?', RID, EID).state, 'reviewed');
  const rv2 = await S.j('POST', `/org/rooms/${RID}/evidence/${EID}/review`, { state: 'needs_follow_up' }, maria); assert.equal(rv2.status, 200, rv2.text);
  assert.deepEqual(qAll(dir, 'SELECT state, note FROM room_evidence_states WHERE room_id = ? AND evidence_id = ?', RID, EID), [{ state: 'needs_follow_up', note: 'Good angle.' }], 'one row, overwritten in place (the note kept as the route keeps it)');
  // the decision: draft, replay, conflict, patch, finalize, replay
  const DRAFT = { outcome: 'hold', reasonCodes: ['technical_fit'], note: INTERNAL_NOTE, clientKey: 'draft-key-a' };
  const dr = await S.j('POST', `/org/rooms/${RID}/decision/draft`, DRAFT, maria); assert.equal(dr.status, 201, dr.text); const DID = dr.body.draft.id;
  assert.equal(q1(dir, 'SELECT id, outcome, note FROM case_decision_drafts WHERE case_id = ?', RID).id, DID); assert.equal(q1(dir, "SELECT key FROM idempotency_keys WHERE owner_table = 'case_decision_drafts' AND owner_id = ? AND act = 'create'", RID).key, 'draft-key-a', 'keys.create as a row owned by the CASE id (review of b7c0dd0, F2)'); assert.equal(q1(dir, 'SELECT count(*) AS n FROM idempotency_keys WHERE owner_id = ?', DID).n, 0, 'never under the draft id');
  assert.deepEqual(qAll(dir, 'SELECT code FROM case_decision_draft_reason_codes WHERE case_id = ? ORDER BY position', RID).map((r) => r.code), ['technical_fit']);
  const replay = await S.j('POST', `/org/rooms/${RID}/decision/draft`, DRAFT, maria); assert.equal(replay.status, 200, replay.text); assert.equal(replay.body.idempotent, true, '[compat] the same clientKey replays');
  const conflict = await S.j('POST', `/org/rooms/${RID}/decision/draft`, { ...DRAFT, note: 'Different.' }, maria); assert.equal(conflict.body.error, 'DECISION_IDEMPOTENCY_CONFLICT', conflict.text);
  const pt = await S.j('PATCH', `/org/rooms/${RID}/decision/draft`, { note: `${INTERNAL_NOTE} Patched.`, expectedRev: dr.body.draft.rev }, maria); assert.equal(pt.status, 200, pt.text); assert.equal(q1(dir, 'SELECT rev FROM case_decision_drafts WHERE id = ?', DID).rev, 2);
  const fin = await S.j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: pt.body.draft.rev, clientKey: 'fin-key-a' }, maria); assert.equal(fin.status, 201, fin.text); const FID = fin.body.decision.id;
  const frow = q1(dir, 'SELECT * FROM room_decisions WHERE id = ?', FID); assert.equal(frow.kind, 'formal'); assert.equal(frow.outcome, 'hold'); assert.equal(frow.draft_id, DID); assert.equal(frow.room_id, RID);
  assert.deepEqual(qAll(dir, "SELECT act, key FROM idempotency_keys WHERE owner_table = 'room_decisions' AND owner_id = ? ORDER BY position", FID).map((r) => [r.act, r.key]), [['finalize', 'fin-key-a'], ['draft', 'draft-key-a']], 'the formal row\'s keys as rows');
  assert.equal(q1(dir, 'SELECT count(*) AS n FROM case_decision_drafts WHERE case_id = ?', RID).n, 0, 'the draft row gone'); assert.equal(q1(dir, "SELECT count(*) AS n FROM idempotency_keys WHERE owner_table = 'case_decision_drafts'").n, 0, 'the draft\'s key row cleaned');
  assert.equal(caseRow(dir, RID).room_status, fin.body.lifecycle.to, 'the case moved with the decision');
  if (fin.body.decision.snapshot?.snapshotId ?? frow.snapshot_id) assert.ok(q1(dir, 'SELECT 1 AS one FROM room_snapshots WHERE id = ?', frow.snapshot_id), 'the decision\'s snapshot copy names a stored snapshot');
  const finReplay = await S.j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: 0, clientKey: 'fin-key-a' }, maria); assert.equal(finReplay.status, 200, finReplay.text); assert.equal(finReplay.body.idempotent, true, '[compat] the finalize replays');
  const surface = await S.j('GET', `/org/rooms/${RID}/decision`, undefined, maria); assert.equal(surface.status, 200); assert.equal(surface.body.current.id, FID, '[compat] the decision surface'); assert.equal(surface.body.draft, null);
  const ho = await S.j('GET', `/org/rooms/${RID}/transaction-handoff`, undefined, maria); assert.equal(ho.status, 200, ho.text); assert.equal(ho.body.handoff, null); assert.ok(ho.body.blockers.includes('HANDOFF_DECISION_REQUIRED'), '[compat] the handoff readiness route');
  // the M12 case with its budget; a room adopting it
  const kase = await S.j('POST', '/org/cases', { playerId: b.pid }, maria); assert.equal(kase.status, 201, kase.text); const KID = kase.body.case.id;
  assert.equal(caseRow(dir, KID).room_status, null, 'an M12 case has no room facet'); assert.equal(caseRow(dir, KID).stage, kase.body.case.stage);
  const scn = await S.j('POST', `/org/cases/${KID}/budget/scenarios`, { label: 'Base offer', currency: 'GBP', termMonths: 24, lines: [{ kind: 'wage', label: 'Wage', amountMinor: 150000, currency: 'GBP', schedule: 'weekly', confirmed: true }, { kind: 'bonus', label: 'Appearance bonus', amountMinor: 50000, currency: 'EUR', schedule: 'one_off', confirmed: false, conditional: { assumption: '20 appearances' } }], fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.861234', source: 'club treasury', date: '2026-09-01' }] }, maria); assert.equal(scn.status, 201, scn.text); const SID = scn.body.scenario.id;
  assert.equal(q1(dir, 'SELECT label, term_months FROM case_budget_scenarios WHERE case_id = ? AND id = ?', KID, SID).term_months, 24); assert.equal(qAll(dir, 'SELECT * FROM case_budget_lines WHERE case_id = ? ORDER BY position', KID).length, 2); assert.equal(q1(dir, 'SELECT rate FROM case_budget_fx_assumptions WHERE case_id = ?', KID).rate, '0.861234');
  const ap = await S.j('POST', `/org/cases/${KID}/budget/scenarios/${SID}/approve`, {}, maria); assert.equal(ap.status, 200, ap.text); assert.equal(q1(dir, 'SELECT approval_version FROM case_budget_scenarios WHERE id = ?', SID).approval_version, 1);
  const ac = await S.j('POST', `/org/cases/${KID}/budget/scenarios/${SID}/actuals`, { lineId: 'ln-1', amountMinor: 118000 }, maria); assert.equal(ac.status, 200, ac.text); assert.equal(q1(dir, 'SELECT amount_minor FROM case_budget_actuals WHERE case_id = ?', KID).amount_minor, 118000);
  const m12c = await S.j('POST', '/org/cases', { playerId: c.pid }, maria); assert.equal(m12c.status, 201); const adopted = await roomFor(S, maria, c.pid); assert.equal(adopted.adopted, true, 'the room adopts the open case'); assert.equal(adopted.id, m12c.body.case.id); assert.ok(caseRow(dir, adopted.id).room_status, 'the same row gained the facet');
  // listings
  const rooms = await S.j('GET', '/org/rooms', undefined, maria); assert.equal(rooms.status, 200); assert.ok(rooms.body.items.some((r) => (r.roomId ?? r.id) === RID), '[compat] the room listing');
  const cases = await S.j('GET', '/org/cases', undefined, maria); assert.equal(cases.status, 200); assert.ok((cases.body.cases ?? cases.body.items ?? cases.body).some((x) => x.id === KID), '[compat] the case listing');
  const cap = await S.j('GET', '/capabilities'); const dom = cap.body.dataLayer.domains.recruitmentCases; assert.ok(dom, '/capabilities carries the recruitmentCases domain'); assert.equal(dom.mode, 'live'); assert.equal(dom.rows.recruitmentCases, 3); assert.equal(dom.rows.roomComments, 2); assert.equal(dom.rows.roomDecisions, q1(dir, 'SELECT count(*) AS n FROM room_decisions').n, 'the formal decision and whatever M17 recommendation the archive recorded'); assert.ok(dom.rows.roomDecisions >= 1); assert.equal(dom.rows.roomEvidenceState, 1); assert.equal(dom.rows.roomSnapshots, q1(dir, 'SELECT count(*) AS n FROM room_snapshots').n);
  // [compat] another club, the player, the guardian
  const rita = await orgLogin(S, 'org-harbour', 'Rita Vale', 'Head of Recruitment');
  assert.equal((await S.j('GET', `/org/rooms/${RID}`, undefined, rita)).status, 404, '[compat] another club: 404'); assert.equal((await S.j('GET', `/org/cases/${KID}`, undefined, rita)).status, 404); assert.equal((await S.j('GET', `/org/rooms/${RID}/comments`, undefined, rita)).status, 404);
  const pBlob = JSON.stringify([(await S.j('GET', '/player/football-passport', undefined, a.token)).body, (await S.j('GET', '/player/trust-profile', undefined, a.token)).body, (await S.j('GET', '/player/notifications', undefined, a.token)).body, (await S.j('GET', '/player/me', undefined, a.token)).body]);
  assert.equal(pBlob.includes('prefers the left channel'), false, '[compat] the player sees no room comment'); assert.equal(pBlob.includes('winter window'), false, '[compat] the player sees no decision note'); assert.doesNotMatch(pBlob, /roomId|recruitmentRoom|room_comment|technical_fit/i, '[compat] the player\'s surfaces mention no room');
  const g = await guardianWithChild(S, 's8b'); const kidRoom = await S.j('POST', '/org/rooms', { playerId: g.childId, sourceContext: 'search' }, maria);
  if (kidRoom.status === 201) {
    assert.equal((await S.j('POST', `/org/rooms/${kidRoom.body.room.roomId}/comments`, { body: 'Internal: the parent is keen, the coach is not.' }, maria)).status, 201);
    assert.equal((await S.j('POST', `/org/rooms/${kidRoom.body.room.roomId}/decision/draft`, { outcome: 'hold', note: 'Internal: revisit at 12.' }, maria)).status, 201);
  }
  const gBlob = JSON.stringify([(await S.j('GET', '/guardian/children', undefined, g.token)).body, (await S.j('GET', `/guardian/children/${g.childId}/insights`, undefined, g.token)).body, (await S.j('GET', '/guardian/inbox', undefined, g.token)).body, (await S.j('GET', '/guardian/notifications', undefined, g.token)).body, (await S.j('GET', '/guardian/digest', undefined, g.token)).body]);
  assert.equal(gBlob.includes('the parent is keen'), false, '[compat] the guardian sees no room comment'); assert.equal(gBlob.includes('revisit at 12'), false, '[compat] the guardian sees no decision note'); assert.doesNotMatch(gBlob, /roomId|recruitmentRoom|room_comment/i, '[compat] the guardian\'s surfaces mention no room');
  // SIGKILL right after a comment
  const last = await S.j('POST', `/org/rooms/${RID}/comments`, { body: 'Right before the kill.' }, maria); assert.equal(last.status, 201);
  await S.kill();
  assert.equal(q1(dir, 'SELECT body FROM room_comments WHERE id = ?', last.body.comment.id).body, 'Right before the kill.', 'the comment was in the route\'s own save');
  S = await boot(dir); const mariaR = await orgLogin(S);
  const thread2 = await S.j('GET', `/org/rooms/${RID}/comments`, undefined, mariaR); assert.ok(JSON.stringify(thread2.body).includes('Right before the kill.'), 'served after the restart');
  assert.equal((await S.j('GET', `/org/rooms/${RID}/decision`, undefined, mariaR)).body.current.id, FID); assert.equal((await S.j('GET', `/org/cases/${KID}/budget`, undefined, mariaR)).body.scenarios[0].lines.length, 2, '[compat] the budget read back');
  await S.stop(); rm(dir);
});

await test('[routes] the deletion unit tombstones the person\'s cases in place (player_name NULL, subject_removed_at set; the room rows, the comments and the decision stay) — a failure of the REAL COMMIT leaves every row as it was and the retry lands once; a restored backup to which a case naming a historically missing player is added (a snapshot-mode save) serves it as today and counts it (Q8a), never refused', async () => {
  const dir = tempDir('s8b-unit'); let S = await boot(dir);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Leaving Adult'); const room = await roomFor(S, maria, a.pid); const RID = room.id;
  assert.equal((await S.j('POST', `/org/rooms/${RID}/comments`, { body: 'Before they left.' }, maria)).status, 201);
  const dr = await S.j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'hold', clientKey: 'k-leave' }, maria); assert.equal(dr.status, 201, dr.text);
  const before = recDump(dir); const tok = await playerLogin(S, a.pid); const statusBefore = caseRow(dir, RID).room_status;
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  const failed = await S.j('DELETE', '/player/account', {}, tok); assert.equal(failed.status, 500, failed.text);
  assert.equal(recDump(dir), before, 'a failed REAL COMMIT leaves every case, room and thread row as it was'); assert.equal((await S.j('GET', '/player/me', undefined, tok)).status, 200);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const ok = await S.j('DELETE', '/player/account', {}, tok); assert.equal(ok.status, 200, ok.text);
  const row = caseRow(dir, RID); assert.equal(row.player_name, null, 'the case\'s copy of the name goes with the person'); assert.ok(row.subject_removed_at, 'subject_removed_at set'); assert.equal(row.player_id, a.pid, 'the id stays'); assert.equal(row.room_status, statusBefore, 'the status is not touched');
  assert.equal(q1(dir, 'SELECT count(*) AS n FROM room_comments WHERE room_id = ?', RID).n, 1, 'the room\'s comment stays'); assert.ok(q1(dir, 'SELECT 1 AS one FROM case_decision_drafts WHERE case_id = ?', RID), 'the draft stays');
  const cap = await S.j('GET', '/capabilities'); assert.equal(cap.body.dataLayer.domains.recruitmentCases.retainedPlayerReferences.recruitmentCases, 1, 'the retained person counted');
  const again = await S.j('GET', `/org/rooms/${RID}`, undefined, maria); assert.equal(again.status, 200, again.text); assert.equal(again.body.room.subjectRemoved ?? again.body.room.playerName === null, true, '[compat] the room is served as a removed subject');
  // Q8a: a historically missing player, through a restored backup
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text); await S.stop();
  const restored = tempDir('s8b-q8a'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  { const store = openStore(restored); const loaded = store.load(); const base = loaded.db.recruitmentCases.find((c) => c.id === RID);
    loaded.db.recruitmentCases = [...loaded.db.recruitmentCases, { ...base, id: 'case-gone', playerId: 'pl-gone-long-ago', playerName: 'Gone Player', subjectRemovedAt: undefined, room: null, decisionDraft: null, history: [], links: { requestIds: [], trialIds: [], signingId: null } }];
    store.save(loaded); store.sqlite.close(); }
  S = await boot(restored); assert.ok(live(restored));
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.recruitmentCases.retainedPlayerReferences.recruitmentCases, 1, 'the retained person still counted after the restore');
  const mariaR = await orgLogin(S); const list = await S.j('GET', '/org/cases', undefined, mariaR); assert.ok((list.body.cases ?? list.body.items ?? list.body).some((x) => x.id === 'case-gone'), 'the case of a missing player is served as today');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.recruitmentCases.unresolvedPlayerReferences.recruitmentCases, 1);
  await S.stop(); rm(dir, restored, bk.body.dir);
});

await test('[backup] the admin backup is a copy of the database: the five collections read back from it (insertion order, the budget lines, the decision keys reassembled, the comment); a restore into a NEW directory serves them row for row', async () => {
  const dir = tempDir('s8b-backup'); let S = await boot(dir);
  const maria = await orgLogin(S); const a = await signupAdult(S, 'Backup Adult'); const room = await roomFor(S, maria, a.pid); const RID = room.id;
  assert.equal((await S.j('POST', `/org/rooms/${RID}/comments`, { body: 'Kept through everything.' }, maria)).status, 201);
  const dr = await S.j('POST', `/org/rooms/${RID}/decision/draft`, { outcome: 'hold', reasonCodes: ['technical_fit'], clientKey: 'draft-key-b' }, maria); assert.equal(dr.status, 201, dr.text);
  const fin = await S.j('POST', `/org/rooms/${RID}/decision/finalize`, { expectedRev: dr.body.draft.rev, clientKey: 'fin-key-b' }, maria); assert.equal(fin.status, 201, fin.text); const FID = fin.body.decision.id;
  const b = await signupAdult(S, 'Budget Adult'); const kase = await S.j('POST', '/org/cases', { playerId: b.pid }, maria); assert.equal(kase.status, 201); const KID = kase.body.case.id;
  assert.equal((await S.j('POST', `/org/cases/${KID}/budget/scenarios`, { label: 'Base', currency: 'GBP', termMonths: 12, lines: [{ kind: 'wage', label: 'Wage', amountMinor: 150000, currency: 'GBP', schedule: 'weekly', confirmed: true }] }, maria)).status, 201);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  await S.stop();
  const liveDump = recDump(dir); assert.equal(recDump(bk.body.dir), liveDump, 'the backup holds every case, room and thread row');
  { const s = new DatabaseSync(path.join(bk.body.dir, 'scoutbox.db'), { readOnly: true }); const cases = readCases(s);
    assert.equal(cases.length, 2); assert.equal(cases[0].id, RID, 'insertion order');
    assert.equal(cases[1].budget.scenarios[0].lines[0].id, 'ln-1'); assert.equal(cases[0].room.status, fin.body.lifecycle.to);
    const fd = readRoomDecisions(s).find((d) => d.id === FID); assert.deepEqual(fd.keys.finalize.key, 'fin-key-b'); assert.equal(fd.keys.draft.key, 'draft-key-b', 'keys reassembled'); assert.equal(fd.kind, 'formal');
    assert.equal(readRoomComments(s)[0].body, 'Kept through everything.'); s.close(); }
  const restored = tempDir('s8b-restore'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); assert.equal(recDump(restored), liveDump, 'row for row'); const mariaR = await orgLogin(S); assert.equal((await S.j('GET', `/org/rooms/${RID}/decision`, undefined, mariaR)).body.current.id, FID); await S.stop();
  rm(dir, restored, bk.body.dir);
});

console.log(`\n${passed} recruitment cases server checks passed`);
