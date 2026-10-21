// S7d through the REAL server (server.mjs booted as a child process on temporary
// data directories, synthetic seed records only): message threads as tables —
// both acceptance paths (an adult player accepts; a guardian accepts for a minor),
// messages from all three sender kinds, both attachment shapes (a clip of the
// player's media, a filed trial report), the duplicate-clientMsgId answer, the three
// read-receipt routes, typing, the per-audience views (the player's and the
// guardian's views carry no orgId/guardianId; the org's carries orgId; the admin's
// everything), the export, the SSE lookup, the blocked-organisation refusal, the
// account deletion reproducing today's behaviour (D-B: the deleted player's threads
// go, guardian–club threads included, other players' threads stay) — plus the
// cutover itself: migration 0012 recorded at boot, the three tables with no blob
// behind them, a thread durable in the acceptance route's own save (SIGKILL right
// after the answer), a message durable before the sender hears 201 (SIGKILL), a
// failed ordinary save at the REAL COMMIT keeping the message in memory and landing
// it ONCE with the next save, a legacy orgUserIdForNotify and unknown fields carried
// through the import, the admin backup in the legacy shape, a restore importing
// through 0012, the S7c tool refusing the file, the copy-only rollback booted by the
// accepted b67bce5 build (SCOUTBOX_PRE_S7D_SERVER: it reads the same threads and posts a
// message into its blob) and the re-upgrade. Every database read goes through a
// second read-only connection. Nothing here touches DATA_DIR or real data. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged b67bce5 tree before the implementation):
// [compat] tests read the threads through a storage adapter (the tables after the
// cutover, the blob before it) and PASS on both trees — they are the behaviour the
// migration must preserve; [cutover] tests assert the 0012 record, the tables, the
// absence of the blob and the rollback tool and FAIL on b67bce5 on concrete assertions.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { AUDIT_SNAPSHOT_TABLES } from '../repositories/safetyAudit.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
// S6b: a file this build wrote carries 0013 too; the S7d tool refuses a later schema step, so every rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6bDir = (dir) => { const s4br = tempDir('s4br-to-s6b'); execFileSync(process.execPath, [path.join(HERE, 'playerErasureRollback.mjs'), dir, s4br], { stdio: 'pipe' }); /* S4b-R: the file carries 0014; its rollback (copy-only, the retained records kept as a blob) goes first */ const out = tempDir('s6b-to-s7d'); execFileSync(process.execPath, [path.join(HERE, 'safetyAuditRollback.mjs'), s4br, out], { stdio: 'pipe' }); return out; };
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const MIGRATION = '0012_channels';
/** seed.mjs `med()`: the media id is derived from the title; the first clip of pl-adeyemi. */
const hash = (s) => { let h = 0; for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0; return h; };
const MEDIA_ID = `media-${Math.abs(hash('Match highlights vs Riverside'))}`;
const REPORT = { acceleration: 7, sprintSpeedKmh: 31, distanceKm: 6.2, passCompletionPct: 78, duelSuccessPct: 55, coachRating: 8 };

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
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000);
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
const seqOf = (dir) => Number(q1(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0;
const blobRows = (c, name) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
// S6b: the ledger is a table since 0013 — read in the writer's literal through the repository's own reader when the blob is retired.
const ledgerRows = (dir) => { const t = AUDIT_SNAPSHOT_TABLES.find((x) => x.name === 'ledger'); const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const r = s.prepare("SELECT value FROM collections WHERE name = 'ledger'").get(); if (r) return JSON.parse(r.value); return s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get() ? t.read(s) : []; } finally { s.close(); } };
const requestsOf = (dir) => snap(dir, (c) => blobRows(c, 'requests') ?? []);
const CHANNEL_KEYS = ['id', 'requestId', 'playerId', 'playerName', 'orgId', 'orgName', 'orgVerified', 'scoutName', 'scoutRole', 'counterparty', 'guardianId', 'createdAt', 'messages', 'readBy'];
const MESSAGE_KEYS = ['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId'];
/** Unknown own fields first, then the literal's present keys in the writer's order (the export convention). */
const ordered = (row, keys) => { const o = {}; for (const k of Object.keys(row)) if (!keys.includes(k)) o[k] = row[k]; for (const k of keys) if (Object.hasOwn(row, k)) o[k] = row[k]; return o; };
const attachmentOf = (r) => (r.kind === 'clip' ? { ...(r.extra_json ? JSON.parse(r.extra_json) : {}), kind: 'clip', mediaId: r.media_id, title: r.title, url: r.url, verifiedClip: r.verified_clip === 1 } : { ...(r.extra_json ? JSON.parse(r.extra_json) : {}), kind: 'trial_report', reportId: r.report_id, orgName: r.org_name, summary: r.summary });
/**
 * The threads as the DATABASE holds them, in insertion order and in the legacy
 * (export) shape: the three tables after the cutover, the blob before it — so a
 * check reads the same way on both builds. Absent optional keys stay absent
 * (absent_keys_json); unknown fields come back from extra_json at their level.
 */
const readStored = (c) => {
  if (!c.get('SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION)) return blobRows(c, 'channels') ?? [];
  const attachments = new Map(c.all('SELECT * FROM message_attachments').map((r) => [r.message_id, r]));
  const messages = new Map();
  for (const m of c.all('SELECT * FROM messages ORDER BY channel_id, position')) {
    const extra = m.extra_json ? JSON.parse(m.extra_json) : {}; const absent = m.absent_keys_json ? JSON.parse(m.absent_keys_json) : [];
    const sender = { ...(extra.sender ?? {}), kind: m.sender_kind, id: m.sender_id, ...(absent.includes('sender.name') ? {} : { name: m.sender_name }) };
    const { sender: _s, ...rest } = extra;
    const row = { ...rest, id: m.id, ts: m.created_at, sender, text: m.text };
    if (!absent.includes('attachment')) row.attachment = attachments.has(m.id) ? attachmentOf(attachments.get(m.id)) : null;
    if (m.client_msg_id !== null) row.clientMsgId = m.client_msg_id;
    if (!messages.has(m.channel_id)) messages.set(m.channel_id, []);
    messages.get(m.channel_id).push(ordered(row, MESSAGE_KEYS));
  }
  return c.all('SELECT * FROM channels ORDER BY seq').map((r) => {
    const extra = r.extra_json ? JSON.parse(r.extra_json) : {}; const absent = r.absent_keys_json ? JSON.parse(r.absent_keys_json) : [];
    const { readBy: readByExtra, ...rest } = extra;
    const row = { ...rest, id: r.id, requestId: r.request_id, playerId: r.player_id, orgId: r.org_id, orgName: r.org_name, counterparty: r.counterparty, createdAt: r.created_at, messages: messages.get(r.id) ?? [], readBy: { ...(readByExtra ?? {}) } };
    if (!absent.includes('playerName')) row.playerName = r.player_name;
    if (!absent.includes('orgVerified')) row.orgVerified = r.org_verified === null ? null : r.org_verified === 1;
    if (!absent.includes('scoutName')) row.scoutName = r.scout_name;
    if (!absent.includes('scoutRole')) row.scoutRole = r.scout_role;
    if (!absent.includes('guardianId')) row.guardianId = r.guardian_id;
    if (!absent.includes('readBy.org')) row.readBy.org = r.read_by_org_at;
    if (!absent.includes('readBy.counterparty')) row.readBy.counterparty = r.read_by_counterparty_at;
    return ordered(row, CHANNEL_KEYS);
  });
};
const stored = (dir) => snap(dir, readStored);
/** The export convention applied to a legacy blob whose unknown keys may sit anywhere: unknown own fields first at every level, then the literal's present keys in the writer's order (what the tables give back). */
const canon = (threads) => threads.map((c) => ordered({ ...c, readBy: ordered(c.readBy, ['org', 'counterparty']), messages: c.messages.map((m) => ordered({ ...m, sender: ordered(m.sender, ['kind', 'id', 'name']), ...(m.attachment ? { attachment: ordered(m.attachment, m.attachment.kind === 'clip' ? ['kind', 'mediaId', 'title', 'url', 'verifiedClip'] : ['kind', 'reportId', 'orgName', 'summary']) } : {}) }, MESSAGE_KEYS)) }, CHANNEL_KEYS));
const storedIds = (dir) => stored(dir).map((c) => [c.id, c.messages.map((m) => m.id)]);

const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); assert.equal(r.status, 200, r.text); return r.body.token; };
/** A contact request answered by the ADULT player: the thread between the club and the player. */
async function adultThread(S, maria, playerToken, playerId = 'pl-adeyemi') {
  const req = await S.j('POST', `/org/players/${playerId}/request`, { type: 'contact', message: 'Synthetic contact request.' }, maria); assert.equal(req.status, 201, req.text); assert.equal(req.body.routedTo, 'player');
  const ans = await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, playerToken); assert.equal(ans.status, 200, ans.text);
  const channel = (await S.j('GET', '/player/channels', undefined, playerToken)).body.find((c) => c.requestId === req.body.requestId); assert.ok(channel?.id, 'the thread is listed at once');
  return { requestId: req.body.requestId, channel };
}
/** A contact request for the MINOR, routed to and answered by the guardian: the thread between the club and the guardian. */
async function guardianThread(S, maria, amara, playerId = 'pl-guni') {
  const req = await S.j('POST', `/org/players/${playerId}/request`, { type: 'contact', message: 'Synthetic contact request for the child.' }, maria); assert.equal(req.status, 201, req.text); assert.equal(req.body.routedTo, 'guardian', 'a minor\'s request is routed to the guardian');
  const ans = await S.j('POST', `/guardian/requests/${req.body.requestId}/respond`, { accept: true }, amara); assert.equal(ans.status, 200, ans.text);
  const channel = (await S.j('GET', '/guardian/channels', undefined, amara)).body.find((c) => c.requestId === req.body.requestId); assert.ok(channel?.id);
  return { requestId: req.body.requestId, channel };
}
/** One SSE stream for a session: the frames it receives, collected until `close()`. */
async function stream(S, token) {
  const t = await S.j('POST', '/events/ticket', {}, token); assert.equal(t.status, 200, t.text);
  const ctrl = new AbortController();
  const r = await fetch(`http://127.0.0.1:${S.port}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ctrl.signal });
  assert.equal(r.status, 200);
  const frames = []; let buffer = '';
  const reader = r.body.getReader(); const decoder = new TextDecoder();
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let i; while ((i = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2); const data = frame.split('\n').find((l) => l.startsWith('data: ')); if (data) frames.push(JSON.parse(data.slice(6))); } } } catch { /* aborted */ } })();
  await until(async () => frames.some((f) => f.event === 'connected'), 5000);
  return { frames, close: () => ctrl.abort() };
}

// ============================================================= [compat] the behaviour the storage move must preserve
await test('[compat] both acceptance paths, all three sender kinds, both attachment shapes, the duplicate clientMsgId, the three receipt routes, typing, the per-audience views, the export and the admin audit: a contact request accepted by the ADULT player opens a player thread; one for the MINOR is routed to the guardian and opens a guardian thread; the org, the player and the guardian each post (sender kind, id and composed name as before); a clip attachment of the player\'s media and a filed trial report attach in their two shapes; a retried send with the same clientMsgId answers 201 with the SAME stored message and stores it once; receipts stamp readBy.org / readBy.counterparty and answer { readBy }; the player\'s and the guardian\'s views carry neither orgId nor guardianId, the org\'s carries orgId, the admin audit carries both; the stored threads equal the views in order and content; a restart serves the same', async () => {
  const dir = tempDir('s7d-compat'); let S = await boot(dir);
  const maria = await orgLogin(S); let kola = await playerLogin(S, 'pl-adeyemi'); const amara = await guardianLogin(S, 'gd-amara');
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, kola)).body, []); assert.deepEqual(stored(dir), [], 'no thread before any acceptance');
  const { requestId: reqA, channel: adult } = await adultThread(S, maria, kola);
  assert.equal(adult.counterparty, 'player'); assert.equal(adult.playerId, 'pl-adeyemi'); assert.equal(adult.playerName, 'Kola Adeyemi'); assert.equal(adult.orgName, 'Eastport FC'); assert.equal(adult.scoutName, 'Maria Keane'); assert.equal(adult.scoutRole, 'Head of Recruitment'); assert.deepEqual(adult.messages, []); assert.deepEqual(adult.readBy, { org: null, counterparty: null });
  assert.equal(Object.hasOwn(adult, 'orgId'), false, 'the player\'s view holds no orgId'); assert.equal(Object.hasOwn(adult, 'guardianId'), false, 'nor a guardianId');
  const { requestId: reqG, channel: guardian } = await guardianThread(S, maria, amara);
  assert.equal(guardian.counterparty, 'guardian'); assert.equal(guardian.playerId, 'pl-guni'); assert.equal(Object.hasOwn(guardian, 'orgId'), false); assert.equal(Object.hasOwn(guardian, 'guardianId'), false, 'the guardian\'s view holds no guardianId either');
  // The thread and the request's answer are durable together (the acceptance route's one save).
  const st = snap(dir, (c) => ({ threads: readStored(c), requests: blobRows(c, 'requests') }));
  assert.deepEqual(st.threads.map((c) => [c.id, c.requestId, c.playerId, c.orgId, c.counterparty, c.guardianId]), [[adult.id, reqA, 'pl-adeyemi', 'org-eastport', 'player', null], [guardian.id, reqG, 'pl-guni', 'org-eastport', 'guardian', 'gd-amara']], 'stored in insertion order with the ids the views withhold');
  assert.deepEqual(st.requests.filter((r) => [reqA, reqG].includes(r.id)).map((r) => [r.status, r.contactChannel]), [['accepted', adult.id], ['accepted', guardian.id]], 'the request\'s status and contactChannel in the same committed state');
  // The org's view carries orgId; the three audiences post.
  const orgView = (await S.j('GET', '/org/channels', undefined, maria)).body; assert.deepEqual(orgView.map((c) => c.id), [adult.id, guardian.id]); assert.ok(orgView.every((c) => c.orgId === 'org-eastport' && !Object.hasOwn(c, 'guardianId')));
  const m1 = await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic club message to the player.' }, maria); assert.equal(m1.status, 201, m1.text);
  assert.deepEqual(m1.body.sender, { kind: 'org_user', id: m1.body.sender.id, name: 'Maria Keane · Head of Recruitment · Eastport FC' }); assert.equal(m1.body.attachment, null); assert.equal(Object.hasOwn(m1.body, 'clientMsgId'), false, 'no clientMsgId key when the client sent none');
  const m2 = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic reply with a clip.', attachMediaId: MEDIA_ID, clientMsgId: 'client-clip-1' }, kola); assert.equal(m2.status, 201, m2.text);
  assert.deepEqual(m2.body.sender, { kind: 'player', id: 'pl-adeyemi', name: 'Kola Adeyemi' }); assert.equal(m2.body.clientMsgId, 'client-clip-1');
  assert.deepEqual(Object.keys(m2.body.attachment), ['kind', 'mediaId', 'title', 'url', 'verifiedClip']); assert.equal(m2.body.attachment.kind, 'clip'); assert.equal(m2.body.attachment.mediaId, MEDIA_ID); assert.equal(m2.body.attachment.title, 'Match highlights vs Riverside');
  assert.equal((await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'x', attachMediaId: 'media-unknown' }, kola)).body.error, 'MEDIA_NOT_FOUND');
  // The duplicate: the same clientMsgId from the same sender answers the SAME message, stored once.
  const dup = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic retry (must not duplicate).', clientMsgId: 'client-clip-1' }, kola); assert.equal(dup.status, 201); assert.deepEqual(dup.body, m2.body, 'the retried send answers the stored message');
  assert.equal((await S.j('GET', '/player/channels', undefined, kola)).body[0].messages.length, 2, 'stored once');
  const m3 = await S.j('POST', `/org/channels/${guardian.id}/messages`, { text: 'Synthetic club message to the guardian.' }, maria); assert.equal(m3.status, 201, m3.text);
  const m4 = await S.j('POST', `/guardian/channels/${guardian.id}/messages`, { text: 'Synthetic guardian reply.', clientMsgId: 'client-g-1' }, amara); assert.equal(m4.status, 201, m4.text); assert.deepEqual(m4.body.sender, { kind: 'guardian', id: 'gd-amara', name: m4.body.sender.name }); assert.equal(typeof m4.body.sender.name, 'string');
  // A trial report attachment: a trial request accepted, the mandatory report filed, attached by the club in the player thread.
  const trialReq = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Synthetic trial invitation.', proposedDate: '2026-12-05', altSlots: ['2026-12-12'], venue: 'Eastport Dome', notes: 'Synthetic.' }, maria); assert.equal(trialReq.status, 201, trialReq.text);
  assert.equal((await S.j('POST', `/player/requests/${trialReq.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const trialThread = (await S.j('GET', '/player/channels', undefined, kola)).body.find((c) => c.requestId === trialReq.body.requestId); assert.ok(trialThread?.id, 'a trial acceptance opens a thread of its own too (as before)'); assert.deepEqual(trialThread.messages, []);
  const trial = (await S.j('GET', '/org/trials', undefined, maria)).body.find((t) => t.requestId === trialReq.body.requestId); assert.ok(trial?.id, 'the accepted trial');
  const filed = await S.j('POST', `/org/trials/${trial.id}/report`, REPORT, maria); assert.equal(filed.status, 201, filed.text);
  const m5 = await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic message with the trial report.', attachTrialReportId: filed.body.report.id }, maria); assert.equal(m5.status, 201, m5.text);
  assert.deepEqual(m5.body.attachment, { kind: 'trial_report', reportId: filed.body.report.id, orgName: 'Eastport FC', summary: 'accel 7/10 · 31 km/h · 6.2 km · pass 78% · duels 55% · coach 8/10' });
  assert.equal((await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'x', attachTrialReportId: 'rep-unknown' }, kola)).body.error, 'TRIAL_REPORT_NOT_FOUND');
  // Receipts, typing.
  const r1 = await S.j('POST', `/player/channels/${adult.id}/read`, {}, kola); assert.equal(r1.status, 200); assert.deepEqual(Object.keys(r1.body), ['readBy']); assert.equal(r1.body.readBy.org, null); assert.equal(typeof r1.body.readBy.counterparty, 'number');
  const r2 = await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria); assert.equal(typeof r2.body.readBy.org, 'number'); assert.equal(r2.body.readBy.counterparty, r1.body.readBy.counterparty);
  const r3 = await S.j('POST', `/guardian/channels/${guardian.id}/read`, {}, amara); assert.equal(typeof r3.body.readBy.counterparty, 'number'); assert.equal(r3.body.readBy.org, null);
  assert.equal((await S.j('POST', `/player/channels/${adult.id}/typing`, {}, kola)).status, 200); assert.equal((await S.j('POST', `/guardian/channels/${guardian.id}/typing`, {}, amara)).status, 200);
  // The stored threads equal the views, in order and content.
  const expectThreads = (rows, label) => {
    assert.deepEqual(rows.map((c) => [c.id, c.messages.map((m) => m.id)]), [[adult.id, [m1.body.id, m2.body.id, m5.body.id]], [guardian.id, [m3.body.id, m4.body.id]], [trialThread.id, []]], `${label}: threads in insertion order, messages in post order`);
    assert.deepEqual(rows[0].messages.map((m) => [m.sender.kind, m.attachment?.kind ?? null, m.clientMsgId ?? '(absent)']), [['org_user', null, '(absent)'], ['player', 'clip', 'client-clip-1'], ['org_user', 'trial_report', '(absent)']], label);
    assert.deepEqual(rows[1].messages.map((m) => [m.sender.kind, m.clientMsgId ?? '(absent)']), [['org_user', '(absent)'], ['guardian', 'client-g-1']], label);
    assert.deepEqual(rows[0].readBy, r2.body.readBy, `${label}: the adult thread's receipts`); assert.deepEqual(rows[1].readBy, r3.body.readBy);
    assert.ok(rows[0].messages.every((m) => typeof m.ts === 'number' && Object.hasOwn(m, 'attachment')), `${label}: every message carries ts and the attachment key`);
  };
  const admin = (await S.j('GET', '/admin/channels', undefined, null, A)).body; expectThreads(admin, 'the admin audit');
  assert.deepEqual(admin.map((c) => [c.orgId, c.guardianId]), [['org-eastport', null], ['org-eastport', 'gd-amara'], ['org-eastport', null]], 'the admin audit carries both ids');
  const onDisk = stored(dir); expectThreads(onDisk, 'the database');
  assert.deepEqual(onDisk.map((c) => Object.keys(c)), admin.map((c) => Object.keys(c)), 'the stored shape is the literal\'s shape, key for key');
  assert.deepEqual(onDisk, admin, 'the stored threads equal the admin audit exactly');
  const pc = (await S.j('GET', '/player/channels', undefined, kola)).body; const gc = (await S.j('GET', '/guardian/channels', undefined, amara)).body; expectThreads([pc[0], gc[0], pc[1]], 'the audiences\' views');
  assert.equal((await S.j('GET', '/admin/overview', undefined, null, A)).body.channels, 3);
  const exp = (await S.j('GET', '/player/export', undefined, kola)).body; assert.deepEqual(exp.threads.map((c) => [c.id, c.messages.length]), [[adult.id, 3], [trialThread.id, 0]]); assert.equal(Object.hasOwn(exp.threads[0], 'orgId'), false);
  const gexp = (await S.j('GET', '/guardian/export', undefined, amara)).body; assert.deepEqual(gexp.children.flatMap((c) => c.threads.map((t) => t.id)), [guardian.id], 'the guardian\'s export carries the child\'s thread');
  // A restart serves the same.
  await S.stop(); S = await boot(dir); kola = await playerLogin(S, 'pl-adeyemi');
  assert.deepEqual((await S.j('GET', '/admin/channels', undefined, null, A)).body, admin, 'the restart serves the same threads');
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, kola)).body.map((c) => [c.id, c.messages.length]), [[adult.id, 3], [trialThread.id, 0]]);
  await S.stop(); rm(dir);
});

await test('[compat] privacy, visibility and the live lookup: another adult player lists no thread and gets 404 on the thread\'s routes; the guardian cannot post in the adult thread nor the player in the guardian thread (404); a child\'s own session cannot post (guardian-managed); the SSE stream of the player receives the `messages` event of its own thread and nothing of the guardian thread, the guardian\'s stream the reverse, the club\'s both; after the player BLOCKS the organisation both sides are refused with BLOCKED on a new message, the club\'s list marks the thread closed and the history stays (as before)', async () => {
  const dir = tempDir('s7d-privacy'); const S = await boot(dir);
  const maria = await orgLogin(S); const kola = await playerLogin(S, 'pl-adeyemi'); const amara = await guardianLogin(S, 'gd-amara'); const mateus = await playerLogin(S, 'pl-carvalho');
  const { channel: adult } = await adultThread(S, maria, kola); const { channel: guardian } = await guardianThread(S, maria, amara);
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, mateus)).body, []);
  for (const p of [`/player/channels/${adult.id}/messages`, `/player/channels/${adult.id}/read`, `/player/channels/${guardian.id}/messages`]) assert.equal((await S.j('POST', p, { text: 'Synthetic intrusion.' }, mateus)).status, 404, p);
  assert.equal((await S.j('POST', `/guardian/channels/${adult.id}/messages`, { text: 'Synthetic intrusion.' }, amara)).status, 404); assert.equal((await S.j('POST', `/player/channels/${guardian.id}/messages`, { text: 'Synthetic intrusion.' }, kola)).status, 404);
  const guniLogin = await S.j('POST', '/auth/player/login', { playerId: 'pl-guni' });
  if (guniLogin.status === 200) { const childPost = await S.j('POST', `/player/channels/${guardian.id}/messages`, { text: 'Synthetic child message.' }, guniLogin.body.token); assert.ok([403, 404].includes(childPost.status), `a child never posts (${childPost.status})`); }
  assert.deepEqual(stored(dir).map((c) => c.messages.length), [0, 0], 'no intrusion stored');
  const sk = await stream(S, kola); const sa = await stream(S, amara); const sm = await stream(S, maria);
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic to the player.' }, maria)).status, 201);
  assert.equal((await S.j('POST', `/org/channels/${guardian.id}/messages`, { text: 'Synthetic to the guardian.' }, maria)).status, 201);
  assert.ok(await until(async () => sk.frames.some((f) => f.event === 'messages' && f.channelId === adult.id), 5000), 'the player\'s stream got its thread\'s event');
  assert.ok(await until(async () => sa.frames.some((f) => f.event === 'messages' && f.channelId === guardian.id), 5000), 'the guardian\'s stream got its thread\'s event');
  assert.ok(await until(async () => sm.frames.filter((f) => f.event === 'messages').length >= 2, 5000), 'the club\'s stream got both');
  await sleep(300);
  assert.equal(sk.frames.some((f) => f.channelId === guardian.id), false, 'nothing of the guardian thread reached the player'); assert.equal(sa.frames.some((f) => f.channelId === adult.id), false, 'nothing of the adult thread reached the guardian');
  sk.close(); sa.close(); sm.close();
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'synthetic' }, kola)).status, 201);
  const blocked = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic after the block.' }, kola); assert.equal(blocked.status, 403); assert.equal(blocked.body.error, 'BLOCKED');
  assert.equal((await S.j('GET', '/player/channels', undefined, kola)).body[0].messages.length, 1, 'the history stays');
  const clubBlocked = await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic club message after the block.' }, maria); assert.equal(clubBlocked.status, 403); assert.equal(clubBlocked.body.error, 'BLOCKED', 'the club\'s side is closed by the same standing check, as before');
  assert.equal((await S.j('GET', '/org/channels', undefined, maria)).body.find((c) => c.id === adult.id).closed, true, 'the club\'s list marks the thread closed');
  assert.deepEqual(stored(dir).map((c) => c.messages.length), [1, 1], 'nothing new after the block; the history stays');
  await S.stop(); rm(dir);
});

await test('[compat] account deletion reproduces today\'s behaviour (D-B, as approved for this storage-only step): DELETE /player/account removes every thread of the adult — its messages, attachments and receipts with it — and leaves the other players\' threads intact, the guardian–club thread included; DELETE /guardian/children/:id removes the child\'s guardian–club thread; the removals are committed when the routes answer (second connection), the club\'s list and the admin audit agree, and a restart changes nothing; no retention rule appears (the ledger rows of the threads stay, id-only)', async () => {
  const dir = tempDir('s7d-delete'); let S = await boot(dir);
  const maria = await orgLogin(S); const kola = await playerLogin(S, 'pl-adeyemi'); const amara = await guardianLogin(S, 'gd-amara'); const mateus = await playerLogin(S, 'pl-carvalho');
  const { channel: adult } = await adultThread(S, maria, kola); const { channel: guardian } = await guardianThread(S, maria, amara); const { channel: other } = await adultThread(S, maria, mateus, 'pl-carvalho');
  assert.equal((await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic with a clip.', attachMediaId: MEDIA_ID }, kola)).status, 201);
  assert.equal((await S.j('POST', `/org/channels/${guardian.id}/messages`, { text: 'Synthetic to the guardian.' }, maria)).status, 201);
  assert.equal((await S.j('POST', `/player/channels/${other.id}/messages`, { text: 'Synthetic other player.' }, mateus)).status, 201);
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria)).status, 200);
  const ledgerBefore = ledgerRows(dir).filter((l) => l.type === 'message').length;
  assert.deepEqual(storedIds(dir).map(([id, ms]) => [id, ms.length]), [[adult.id, 1], [guardian.id, 1], [other.id, 1]]);
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200);
  assert.deepEqual(storedIds(dir).map(([id, ms]) => [id, ms.length]), [[guardian.id, 1], [other.id, 1]], 'the adult\'s thread went with its message when the route answered; the others stay');
  if (live(dir)) assert.deepEqual(snap(dir, (c) => [c.get('SELECT COUNT(*) AS n FROM messages').n, c.get('SELECT COUNT(*) AS n FROM message_attachments').n]), [2, 0], 'its message and attachment rows went with it (the cascades)');
  assert.deepEqual((await S.j('GET', '/org/channels', undefined, maria)).body.map((c) => c.id), [guardian.id, other.id]);
  assert.equal((await S.j('DELETE', `/guardian/children/pl-guni`, {}, amara)).status, 200);
  assert.deepEqual(storedIds(dir).map(([id]) => id), [other.id], 'the guardian–club thread of the deleted child went too (today\'s behaviour, kept)');
  assert.deepEqual((await S.j('GET', '/guardian/channels', undefined, amara)).body, []);
  assert.deepEqual((await S.j('GET', '/admin/channels', undefined, null, A)).body.map((c) => c.id), [other.id]);
  assert.equal(ledgerRows(dir).filter((l) => l.type === 'message').length, ledgerBefore, 'the ledger rows stay (append-only, ids only)');
  await S.stop(); S = await boot(dir);
  assert.deepEqual((await S.j('GET', '/admin/channels', undefined, null, A)).body.map((c) => [c.id, c.messages.length]), [[other.id, 1]]);
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, await playerLogin(S, 'pl-carvalho'))).body.map((c) => c.id), [other.id], 'the other player\'s thread is intact after the restart');
  await S.stop(); rm(dir);
});

// ============================================================= [cutover] the tables, the save points, the crash windows
await test('[cutover] the cutover and the save points: a fresh boot records 0012_channels after 0011 and creates channels, messages and message_attachments with no blob behind them (the data layer reports the domain); the thread opened by an acceptance is in the SAME revision as the request\'s answer and survives a SIGKILL right after the response; a message is in the file before the sender hears 201 (SIGKILL right after); a FAILED ORDINARY SAVE at the REAL COMMIT (internal:save.sqlite_commit) leaves the message in memory and absent from the table while the route answered 201, and the next save (a receipt) lands the message and the receipt ONCE — a later save does not replay; rows carry seq/position in post order', async () => {
  const dir = tempDir('s7d-cutover'); let S = await boot(dir, { M13_FAST_RETRY: '' });
  assert.ok(live(dir), 'the boot recorded 0012'); // fails on b67bce5: no such record
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id FROM data_migrations ORDER BY applied_at, id').map((r) => r.id).slice(-4)), ['0011_outbox_push', MIGRATION, '0013_safety_audit', '0014_player_erasure']); // S6b: 0013 follows on the same boot
  for (const t of ['channels', 'messages', 'message_attachments']) assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  assert.equal(q1(dir, "SELECT COUNT(*) AS n FROM collections WHERE name = 'channels'").n, 0, 'no channels blob');
  const cap = (await S.j('GET', '/capabilities')).body; const domains = cap?.persistence?.dataLayer?.domains ?? cap?.dataLayer?.domains ?? {}; assert.ok(domains.channels, `the data layer reports the channels domain (${Object.keys(domains).join(', ')})`);
  const maria = await orgLogin(S); let kola = await playerLogin(S, 'pl-adeyemi');
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic contact request.' }, maria); assert.equal(req.status, 201);
  const seqBefore = seqOf(dir);
  const ans = await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola); assert.equal(ans.status, 200, ans.text);
  await S.kill();
  const afterKill = snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), threads: c.all('SELECT seq, id, request_id FROM channels ORDER BY seq'), request: blobRows(c, 'requests').find((r) => r.id === req.body.requestId) }));
  assert.equal(afterKill.threads.length, 1, 'the thread is in the file although the process was killed right after the answer'); assert.equal(afterKill.threads[0].request_id, req.body.requestId); assert.equal(afterKill.request.status, 'accepted'); assert.equal(afterKill.request.contactChannel, afterKill.threads[0].id); assert.ok(afterKill.seq > seqBefore, 'one later revision carries both');
  const channelId = afterKill.threads[0].id;
  S = await boot(dir, { M13_FAST_RETRY: '' }); kola = await playerLogin(S, 'pl-adeyemi'); const maria2 = await orgLogin(S);
  assert.deepEqual((await S.j('GET', '/player/channels', undefined, kola)).body.map((c) => c.id), [channelId]);
  const m1 = await S.j('POST', `/player/channels/${channelId}/messages`, { text: 'Synthetic message durable before 201.', attachMediaId: MEDIA_ID }, kola); assert.equal(m1.status, 201, m1.text);
  await S.kill();
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id, position FROM messages WHERE channel_id = ? ORDER BY position', channelId)), [{ id: m1.body.id, position: 0 }], 'the message is in the file when the sender hears 201');
  assert.equal(q1(dir, 'SELECT kind FROM message_attachments WHERE message_id = ?', m1.body.id).kind, 'clip');
  // The real COMMIT failure.
  S = await boot(dir, { M13_FAST_RETRY: '' }); kola = await playerLogin(S, 'pl-adeyemi'); const maria3 = await orgLogin(S);
  const logBefore = S.log().length; const seq0 = seqOf(dir);
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  const m2 = await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'Synthetic message whose save fails at COMMIT.' }, maria3); assert.equal(m2.status, 201, 'the route answers although its save failed');
  assert.ok(await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 5000), 'the save failed at the real COMMIT');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id FROM messages WHERE channel_id = ? ORDER BY position', channelId)).map((r) => r.id), [m1.body.id], 'the message did not land'); assert.equal(seqOf(dir), seq0);
  assert.deepEqual((await S.j('GET', '/org/channels', undefined, maria3)).body[0].messages.map((m) => m.id), [m1.body.id, m2.body.id], 'memory is the intended state');
  const rc = await S.j('POST', `/org/channels/${channelId}/read`, {}, maria3); assert.equal(rc.status, 200);
  const landed = snap(dir, (c) => ({ messages: c.all('SELECT id, position FROM messages WHERE channel_id = ? ORDER BY position', channelId), read: c.get('SELECT read_by_org_at FROM channels WHERE id = ?', channelId).read_by_org_at, seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value) }));
  assert.deepEqual(landed.messages, [{ id: m1.body.id, position: 0 }, { id: m2.body.id, position: 1 }], 'the next save landed the message once, at the next position'); assert.equal(landed.read, rc.body.readBy.org); assert.equal(landed.seq, seq0 + 1);
  assert.equal((await S.j('POST', `/player/channels/${channelId}/read`, {}, kola)).status, 200);
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id FROM messages WHERE channel_id = ?', channelId)).length, 2, 'a later save does not replay');
  void maria; void maria2;
  await S.stop(); rm(dir);
});

await test('[cutover] the admin backup, a restore, the S7c tool\'s refusal, legacy and unknown fields through the import, the copy-only rollback booted by the accepted pre-S7d build and the re-upgrade: the backup\'s channels equal the stored threads exactly and a restore into a NEW directory imports them through 0012 row for row (counts-only record, no blob left); the S7c rollback tool refuses the file (exit 4); a rollback copy of a file with two threads has its blob written back in the legacy shape (then given a legacy orgUserIdForNotify and unknown fields at channel, message, attachment, readBy and sender level by hand, as an older file might carry); this build imports the copy through 0012 losslessly (the admin audit and the backup show the fields exactly; the cutover record counts only; the route that notifies the org reads orgUserIdForNotify as before; the backup and a restore carry the fields); with SCOUTBOX_PRE_S7D_SERVER set, the accepted build boots the rollback copy, lists the same threads, posts a message into its blob and this build re-upgrades the copy with that message included', async () => {
  const dir = tempDir('s7d-rollback'); let S = await boot(dir);
  const maria = await orgLogin(S); let kola = await playerLogin(S, 'pl-adeyemi'); const amara = await guardianLogin(S, 'gd-amara');
  const { channel: adult } = await adultThread(S, maria, kola); const { channel: guardian } = await guardianThread(S, maria, amara);
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic one.' }, maria)).status, 201);
  const clipMsg = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic two with a clip.', attachMediaId: MEDIA_ID, clientMsgId: 'client-rb' }, kola); assert.equal(clipMsg.status, 201);
  assert.equal((await S.j('POST', `/guardian/channels/${guardian.id}/messages`, { text: 'Synthetic guardian.' }, amara)).status, 201);
  assert.equal((await S.j('POST', `/org/channels/${adult.id}/read`, {}, maria)).status, 200);
  const original = stored(dir); assert.deepEqual(original.map((c) => c.messages.length), [2, 1]);
  // The admin backup carries the channels in the legacy shape; a restore imports them row for row through 0012.
  const bk0 = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk0.status, 201, bk0.text);
  const snapshot0 = JSON.parse(fs.readFileSync(path.join(bk0.body.dir, 'db.json'), 'utf8')); assert.equal(JSON.stringify(snapshot0.db.channels), JSON.stringify(original), 'the backup equals the stored threads exactly');
  await S.stop();
  const restored0 = tempDir('s7d-restored0'); fs.cpSync(bk0.body.dir, restored0, { recursive: true });
  S = await boot(restored0); assert.ok(live(restored0), 'the restore imported through 0012'); // fails on b67bce5: a restore keeps the blob, no 0012 record
  assert.equal(JSON.stringify(stored(restored0)), JSON.stringify(original), 'row for row'); assert.equal(q1(restored0, "SELECT COUNT(*) AS n FROM collections WHERE name = 'channels'").n, 0, 'no blob left behind');
  const record0 = JSON.parse(q1(restored0, "SELECT value FROM meta WHERE key = 'channelsCutover'").value); assert.deepEqual([record0.imported, record0.messages, record0.attachments], [2, 3, 1]); assert.doesNotMatch(JSON.stringify(record0), /Synthetic/, 'counts only');
  await S.stop();
  // The S7c tool refuses the S7d file (LATER_SCHEMA).
  try { execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), dir, tempDir('s7d-s7ctool')], { stdio: 'pipe' }); assert.fail('the S7c tool must refuse a 0012 file'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // The copy-only rollback, then legacy/unknown fields written into the blob by hand (what an older file might carry).
  const copy = tempDir('s7d-copy');
  const out = execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), copy], { encoding: 'utf8' }); // fails on b67bce5: no such tool
  assert.match(out, /written back/); assert.equal(live(copy), false); assert.deepEqual(stored(copy), original, 'the blob holds every thread in order, in the legacy shape');
  assert.ok(live(dir), 'the source is untouched'); assert.deepEqual(stored(dir), original);
  const SECRET = 'SECRET-LEGACY-MARKER-91';
  { const s = new DatabaseSync(path.join(copy, 'scoutbox.db')); const rows = JSON.parse(s.prepare("SELECT value FROM collections WHERE name = 'channels'").get().value);
    rows[0].orgUserIdForNotify = 'usr-legacy-notify'; rows[0].futureChannelField = { nested: [1, SECRET] }; rows[0].readBy.futureReadByField = 7;
    rows[0].messages[1].futureMessageField = true; rows[0].messages[1].sender.futureSenderField = 'kept'; rows[0].messages[1].attachment.futureAttachmentField = 'kept';
    delete rows[1].scoutRole; // an ABSENT optional key next to present-and-null ones
    s.prepare("UPDATE collections SET value = ? WHERE name = 'channels'").run(JSON.stringify(rows)); s.close(); }
  const legacy = canon(stored(copy)); // the blob as edited by hand (the added keys sit last there); the tables give the export convention back — unknown keys first at every level
  // This build imports the hand-edited copy.
  const up = tempDir('s7d-up'); fs.cpSync(copy, up, { recursive: true });
  S = await boot(up); assert.ok(live(up), 'imported through 0012');
  assert.equal(q1(up, "SELECT COUNT(*) AS n FROM collections WHERE name = 'channels'").n, 0, 'the blob is retired');
  const record = JSON.parse(q1(up, "SELECT value FROM meta WHERE key = 'channelsCutover'").value); assert.deepEqual([record.imported, record.messages, record.attachments, record.withExtraFields, record.withAbsentKeys], [2, 3, 1, 1, 1]); assert.doesNotMatch(JSON.stringify(record) + S.log(), new RegExp(SECRET), 'counts only; no value in the log');
  const audit = (await S.j('GET', '/admin/channels', undefined, null, A)).body;
  assert.equal(JSON.stringify(audit), JSON.stringify(legacy), 'the admin audit equals the legacy blob exactly — extras first at every level, absence preserved');
  assert.equal(audit[0].orgUserIdForNotify, 'usr-legacy-notify'); assert.deepEqual(audit[0].futureChannelField, { nested: [1, SECRET] }); assert.equal(audit[0].readBy.futureReadByField, 7); assert.equal(audit[0].messages[1].sender.futureSenderField, 'kept'); assert.equal(audit[0].messages[1].attachment.futureAttachmentField, 'kept'); assert.equal(Object.hasOwn(audit[1], 'scoutRole'), false);
  assert.equal(JSON.stringify(stored(up)), JSON.stringify(legacy), 'the tables read back the same');
  // orgUserIdForNotify is read by the message route as before: the player's message notifies that org user (the composed recipient), the message appends after the imported ones.
  kola = await playerLogin(S, 'pl-adeyemi'); const m = await S.j('POST', `/player/channels/${adult.id}/messages`, { text: 'Synthetic after the import.' }, kola); assert.equal(m.status, 201, m.text);
  assert.deepEqual(stored(up)[0].messages.map((x) => x.id), [...legacy[0].messages.map((x) => x.id), m.body.id]); assert.equal(stored(up)[0].orgUserIdForNotify, 'usr-legacy-notify', 'the legacy field survives the append');
  // The admin backup carries the legacy and unknown fields exactly; a restore of it imports them again.
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.equal(JSON.stringify(snapshot.db.channels), JSON.stringify(stored(up)), 'the backup equals the stored threads exactly (legacy and unknown fields included)');
  await S.stop();
  const restored = tempDir('s7d-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); assert.equal(JSON.stringify(stored(restored)), JSON.stringify(snapshot.db.channels), 'row for row'); assert.equal(q1(restored, "SELECT COUNT(*) AS n FROM collections WHERE name = 'channels'").n, 0);
  await S.stop();
  // The accepted build boots the (unedited) rollback copy of the original file.
  const copy2 = tempDir('s7d-copy2'); execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), copy2], { encoding: 'utf8' }); assert.deepEqual(stored(copy2), original);
  const OLD = process.env.SCOUTBOX_PRE_S7D_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    const old = await boot(copy2, {}, OLD);
    assert.ok(!/0012_channels/.test(old.log()), 'the accepted build knows nothing of 0012'); assert.equal(live(copy2), false);
    const oldAudit = (await old.j('GET', '/admin/channels', undefined, null, A)).body; assert.deepEqual(oldAudit, original, 'the old build lists the same threads, messages and receipts');
    const oldMaria = await orgLogin(old); const oldKola = await playerLogin(old, 'pl-adeyemi');
    assert.deepEqual((await old.j('GET', '/player/channels', undefined, oldKola)).body.map((c) => [c.id, c.messages.map((x) => x.id)]), [[adult.id, original[0].messages.map((x) => x.id)]]);
    const oldMsg = await old.j('POST', `/org/channels/${adult.id}/messages`, { text: 'Synthetic message from the accepted build.', clientMsgId: 'client-old' }, oldMaria); assert.equal(oldMsg.status, 201, oldMsg.text);
    assert.deepEqual(stored(copy2)[0].messages.map((x) => x.id), [...original[0].messages.map((x) => x.id), oldMsg.body.id], 'the old build keeps writing to its blob');
    await old.stop();
    console.log('    (pre-S7d build booted the rollback copy: same threads, a new message accepted)');
    const re = await boot(copy2); assert.ok(live(copy2), 'this build re-upgraded the copy');
    const reRows = stored(copy2); assert.deepEqual(reRows[0].messages.map((x) => x.id), [...original[0].messages.map((x) => x.id), oldMsg.body.id], 'the old build\'s message included'); assert.equal(reRows[0].messages.at(-1).clientMsgId, 'client-old'); assert.deepEqual(reRows[1], original[1]);
    assert.deepEqual((await re.j('GET', '/admin/channels', undefined, null, A)).body, reRows);
    await re.stop();
  } else {
    console.log('    (SCOUTBOX_PRE_S7D_SERVER not set: the pre-S7d boot of the rollback copy was not exercised here)');
  }
  rm(dir, bk0.body.dir, restored0, copy, up, bk.body.dir, restored, copy2);
});

console.log(`\n${passed} channel server checks passed`);
