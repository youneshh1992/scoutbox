// S7b through the REAL server (server.mjs booted as a child process on temporary
// data directories, synthetic seed records only, M13_FAST_RETRY so the sweep runs
// every 400 ms and the retry ladder is [0, 300, 600, 900] ms): a sweep pass's
// dispatch rows, attempts and status changes commit in ONE save with the outbox
// row, the failure-injection counter and the ops event it wrote (a save that fails
// at the real COMMIT leaves none of them durable; the retry lands all of them);
// the retry ladder with the quiet-hours note row; provider callbacks (finite
// fractional, null, zero, existing and non-finite clocks; duplicates; a late
// bounce; the first-match lookup with duplicate, explicit-null and missing
// provider ids); the acknowledgment unit under a real COMMIT failure; dispatch
// rows retained after an ordinary account deletion; a configured synthetic
// webhook endpoint's delivery row persisted with the failed dispatch; a SIGKILL
// mid-retry; the admin backup and its restore; the copy-only rollback booted by
// the accepted 0641b2c build (SCOUTBOX_PRE_S7B_SERVER). Every database read goes
// through a second read-only connection. Nothing here touches DATA_DIR or real
// data. Run with: npm test
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const CALLBACK_SECRET = 'local-fake-callback-secret';
const FRACTIONAL = 1700000000000.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

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
async function bootRefuses(dir) {
  try { const S = await boot(dir); await S.kill(); throw new Error(`the server booted but must have refused: ${S.log().slice(-600)}`); }
  catch (err) { if (typeof err.code !== 'number') throw err; return { code: err.code, log: err.log }; }
}
const q1 = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; } finally { s.close(); } };
const qAll = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const live = (dir) => !!q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0010_dispatches'");
const seqOf = (dir) => Number(q1(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0;
const blobRows = (dir, name) => { const r = q1(dir, 'SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
/** The dispatch records as the DATABASE holds them, in insertion order, with attempts re-nested: the tables after the cutover, the blob before it (so a check reads the same way on both builds). */
const stored = (dir) => {
  if (!live(dir)) return (blobRows(dir, 'dispatches') ?? []).map((d) => ({ ...d }));
  const rows = qAll(dir, 'SELECT seq, id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason, typeof(delivered_at) AS delivered_type FROM dispatches ORDER BY seq');
  const attempts = qAll(dir, 'SELECT dispatch_seq, seq, kind, attempted_at, ok, error, note FROM dispatch_attempts ORDER BY dispatch_seq, seq');
  return rows.map((r) => ({ id: r.id, notificationId: r.notification_id, audience: { kind: r.audience_kind, id: r.audience_id }, channel: r.channel, to: r.to_address, provider: r.provider, status: r.status, skipReason: r.skip_reason, providerMessageId: r.provider_message_id, attempts: attempts.filter((a) => a.dispatch_seq === r.seq).map((a) => (a.kind === 'quiet_recheck' ? { at: a.attempted_at, note: a.note } : { at: a.attempted_at, ok: a.ok === 1, error: a.error })), nextAt: r.next_at, actionDeadline: r.action_deadline_at, createdAt: r.created_at, deliveredAt: r.delivered_at, openedAt: r.opened_at, actionedAt: r.actioned_at, failedAt: r.failed_at, failReason: r.fail_reason, deliveredType: r.delivered_type }));
};
const storedRow = (dir, id) => stored(dir).find((d) => d.id === id);
const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const sweep = async (S) => { const r = await S.j('POST', '/admin/delivery/sweep', {}, null, A); assert.equal(r.status, 200, r.text); return r.body.processed; };
const inject = async (S, count) => assert.equal((await S.j('POST', '/admin/delivery/inject-failure', { channel: 'email', count }, null, A)).status, 200);
const admin = async (S) => (await S.j('GET', '/admin/delivery', undefined, null, A)).body;
const callback = (S, events) => { const body = JSON.stringify({ provider: 'local-fake', events }); const ts = String(Date.now()); const sig = crypto.createHmac('sha256', CALLBACK_SECRET).update(`callback.${ts}.${body}`).digest('hex'); return S.j('POST', '/callbacks/delivery', JSON.parse(body), null, { 'x-provider-timestamp': ts, 'x-provider-signature': sig }); };
/** A guardian notice: Maria requests a conversation about the under-18 seed player; the guardian (who has an e-mail address) is notified. Returns the notice. */
async function guardianNotice(S, maria, amara, type = 'contact') {
  const req = await S.j('POST', '/org/players/pl-guni/request', { type, message: `Synthetic ${type} request about the under-18 player.`, ...(type === 'trial' ? { proposedDate: '2026-12-05' } : {}) }, maria);
  assert.equal(req.status, 201, req.text);
  const notice = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req.body.requestId));
  assert.ok(notice, 'the guardian was notified'); return notice;
}
const emailRowOf = (S, dir, notice) => until(async () => { await sweep(S); const d = storedRow(dir, stored(dir).find((x) => x.notificationId === notice.id && x.channel === 'email')?.id); return d && ['accepted', 'failed'].includes(d.status) ? d : null; }, 20_000);

// ------------------------------------------------------------- 1. a sweep pass commits with the blobs it wrote
await test('a sweep pass is ONE save: the dispatch rows it creates, the attempt it records, the status it sets, the outbox row the provider accepted and the failure-injection counter it decremented are durable together (second connection, one revision) — and when that save fails at the REAL COMMIT (internal:save.sqlite_commit) none of them is durable (no table row, no attempt, no outbox row, counter unchanged, saveSeq unchanged) while memory shows them; the next save lands all of them once; the rows are in the tables, not in a blob', async () => {
  const dir = tempDir('s7b-sweep'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  assert.ok(live(dir), 'this proof reads the dispatch tables'); // fails on the pre-S7b build (0641b2c): the tables do not exist
  await inject(S, 1); // the first send fails: the row stays retrying until the next pass
  const notice = await guardianNotice(S, maria, amara);
  const emailId = await until(async () => { await sweep(S); return stored(dir).find((x) => x.notificationId === notice.id && x.channel === 'email')?.id; });
  assert.ok(emailId, 'the sweep created and saved the dispatch rows');
  const first = storedRow(dir, emailId); assert.equal(first.status, 'retrying'); assert.deepEqual(first.attempts.map((a) => [a.ok, a.error]), [[false, 'injected provider failure']]);
  assert.equal(q1(dir, "SELECT COUNT(*) AS n FROM collections WHERE name = 'dispatches'").n, 0, 'no dispatches blob after the cutover');
  const outboxBefore = (blobRows(dir, 'outbox') ?? []).length; const seq0 = seqOf(dir); const injectBefore = blobRows(dir, 'deliveryFailInject');
  // The next pass sends (and the provider accepts): arm the seam so that pass's save fails at COMMIT.
  await inject(S, 0 + 1); await sleep(50); // one more failure, so the row is still retrying when the seam is armed and the following success is the one we watch
  await until(async () => storedRow(dir, emailId).attempts.length === 2, 5000);
  const seqArmed = seqOf(dir); const logBefore = S.log().length;
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 8000);
  assert.match(S.log().slice(logBefore), /snapshot save failed: FOREIGN KEY constraint failed/, 'the pass that accepted the send failed at its COMMIT');
  const afterFailure = storedRow(dir, emailId);
  assert.equal(afterFailure.status, 'retrying', 'the accepted status is not durable'); assert.equal(afterFailure.attempts.length, 2, 'the third attempt row is not durable'); assert.equal(afterFailure.providerMessageId, null);
  assert.equal((blobRows(dir, 'outbox') ?? []).length, outboxBefore, 'the outbox row did not land without the dispatch rows'); assert.equal(seqOf(dir), seqArmed, 'saveSeq unchanged');
  const inMemory = (await admin(S)).recent.find((d) => d.id === emailId); assert.equal(inMemory.status, 'accepted', 'memory shows the pass (every unsaved edit does)'); assert.equal(inMemory.attempts.length, 3);
  // The next save lands everything once. Memory is the intended state (the store's contract since S3): the failed save
  // schedules nothing by itself, and a pass that changes nothing saves nothing, so the retry rides on the next pass that
  // does change something — here a new notice whose rows the sweep creates — in ONE save with the row, its third
  // attempt, its status, the outbox row and the counter.
  const notice2 = await guardianNotice(S, maria, amara, 'trial');
  await until(async () => { await sweep(S); return storedRow(dir, emailId).status === 'accepted'; }, 8000);
  const landed = storedRow(dir, emailId);
  assert.equal(landed.status, 'accepted', 'the accepted status landed on the next save');
  assert.equal(landed.attempts.length, 3); assert.deepEqual(landed.attempts.map((a) => a.ok), [false, false, true]); assert.ok(landed.providerMessageId);
  assert.equal((blobRows(dir, 'outbox') ?? []).filter((m) => m.providerMessageId === landed.providerMessageId).length, 1, 'exactly one outbox row for the one accepted send (no replay of the failed save)');
  assert.ok((blobRows(dir, 'outbox') ?? []).length >= outboxBefore + 1); assert.ok(seqOf(dir) > seqArmed);
  assert.deepEqual(blobRows(dir, 'deliveryFailInject'), { ...injectBefore, email: 0 }, 'the counter landed with the rows');
  assert.ok(stored(dir).some((d) => d.notificationId === notice2.id), 'the new notice\'s rows landed in that same save');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 2. the retry ladder and the quiet-hours note
await test('retry ladder: a deferred-push notice is held (held_quiet_hours), its first due pass records the quiet re-check NOTE row first, then the send rows — two injected failures, then the acceptance — the note is kind quiet_recheck with ok NULL in the table and never counts as a send; exhausted retries (four injected failures) end failed with failedAt, an untruncated failReason and one delivery_failed ops event; the attempts table holds exactly the rows in order', async () => {
  const dir = tempDir('s7b-ladder'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  assert.equal((await S.j('POST', '/guardian/prefs', { quietStart: '00:00', quietEnd: '23:59', timezone: 'Europe/London' }, amara)).status, 200);
  await inject(S, 2);
  const notice = await guardianNotice(S, maria, amara);
  assert.equal(notice.deferredPush, true);
  const row = await emailRowOf(S, dir, notice);
  assert.equal(row.status, 'accepted');
  assert.deepEqual(row.attempts.map((a) => (Object.hasOwn(a, 'note') ? 'note' : a.ok ? 'send:ok' : 'send:fail')), ['note', 'send:fail', 'send:fail', 'send:ok']);
  assert.deepEqual(qAll(dir, 'SELECT kind, ok FROM dispatch_attempts WHERE dispatch_seq = (SELECT seq FROM dispatches WHERE id = ?) ORDER BY seq', row.id).map((a) => [a.kind, a.ok]), [['quiet_recheck', null], ['send', 0], ['send', 0], ['send', 1]]);
  assert.equal((await admin(S)).recent.find((d) => d.id === row.id).attempts.length, 4, 'the admin view shows the same four rows');
  // Exhausted retries.
  assert.equal((await S.j('POST', '/guardian/prefs', { quietStart: null, quietEnd: null, timezone: 'Europe/London' }, amara)).status, 200);
  await inject(S, 4);
  const notice2 = await guardianNotice(S, maria, amara, 'trial');
  const failed = await emailRowOf(S, dir, notice2);
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts.length, 4); assert.ok(failed.failedAt); assert.equal(failed.failReason, 'injected provider failure');
  await until(async () => (blobRows(dir, 'opsEvents') ?? []).some((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failed.id));
  assert.equal((blobRows(dir, 'opsEvents') ?? []).filter((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failed.id).length, 1);
  assert.equal((await S.j('GET', '/admin/metrics', undefined, null, A)).body.dispatchBacklog, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 3. callbacks
await test('provider callbacks through the real route: a finite fractional `at` becomes deliveredAt/openedAt EXACTLY (real in the table, second connection); a null or zero `at` falls back to the server clock and an existing clock is kept (nullish assignment); a non-finite `at` ("Infinity") records no clock — null, which is what the JSON save of the previous build persisted — while the status still rises; a duplicate callbackId applies nothing; a late bounce records failReason without regressing; an unknown status applies nothing; an explicit null providerMessageId matches the FIRST null row in insertion order; a missing providerMessageId matches nothing but is remembered; duplicates of a provider id resolve to the first row', async () => {
  const dir = tempDir('s7b-callbacks'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  const n1 = await guardianNotice(S, maria, amara); const r1 = await emailRowOf(S, dir, n1); assert.equal(r1.status, 'accepted');
  const n2 = await guardianNotice(S, maria, amara, 'trial'); const r2 = await emailRowOf(S, dir, n2); assert.equal(r2.status, 'accepted');
  const seenBefore = (blobRows(dir, 'deliveryCallbacksSeen') ?? []).length;
  // Fractional, exactly.
  let c = await callback(S, [{ callbackId: 'cb-frac', providerMessageId: r1.providerMessageId, status: 'opened', at: FRACTIONAL }]); assert.deepEqual(c.body, { applied: 1, duplicates: 0 });
  await until(async () => storedRow(dir, r1.id).status === 'opened');
  let s1 = storedRow(dir, r1.id); assert.equal(s1.openedAt, FRACTIONAL); assert.equal(s1.deliveredAt, FRACTIONAL); assert.equal(s1.deliveredType, 'real', 'stored as a real, not rounded');
  assert.equal((await admin(S)).recent.find((d) => d.id === r1.id).openedAt, FRACTIONAL, 'the admin view shows the same value');
  // Duplicate id.
  c = await callback(S, [{ callbackId: 'cb-frac', providerMessageId: r1.providerMessageId, status: 'opened', at: 1 }]); assert.deepEqual(c.body, { applied: 0, duplicates: 1 }); assert.equal(storedRow(dir, r1.id).openedAt, FRACTIONAL);
  // Late bounce: failReason recorded, no regression; a later delivered keeps the existing clock.
  c = await callback(S, [{ callbackId: 'cb-bounce', providerMessageId: r1.providerMessageId, status: 'bounced', reason: 'synthetic late bounce', at: 5 }]); assert.equal(c.body.applied, 1);
  c = await callback(S, [{ callbackId: 'cb-deliv', providerMessageId: r1.providerMessageId, status: 'delivered', at: 7 }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r1.id).failReason === 'synthetic late bounce');
  s1 = storedRow(dir, r1.id); assert.equal(s1.status, 'opened'); assert.equal(s1.failedAt, null); assert.equal(s1.deliveredAt, FRACTIONAL, 'an existing clock is kept');
  // Unknown status: counted as applied (as today), changes nothing.
  c = await callback(S, [{ callbackId: 'cb-odd', providerMessageId: r2.providerMessageId, status: 'teleported', at: 9 }]); assert.equal(c.body.applied, 1); await sleep(100); assert.equal(storedRow(dir, r2.id).status, 'accepted'); assert.equal(storedRow(dir, r2.id).deliveredAt, null);
  // Null `at` → server clock; zero `at` → server clock (the existing is kept).
  const before = Date.now();
  c = await callback(S, [{ callbackId: 'cb-null', providerMessageId: r2.providerMessageId, status: 'delivered', at: null }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r2.id).status === 'delivered');
  let s2 = storedRow(dir, r2.id); assert.ok(Number.isInteger(s2.deliveredAt) && s2.deliveredAt >= before, 'null falls back to the server clock');
  const kept = s2.deliveredAt;
  c = await callback(S, [{ callbackId: 'cb-zero', providerMessageId: r2.providerMessageId, status: 'delivered', at: 0 }]); assert.equal(c.body.applied, 1); await sleep(100); assert.equal(storedRow(dir, r2.id).deliveredAt, kept, 'zero never replaces an existing clock');
  // Non-finite: no clock recorded (null), the status still rises.
  c = await callback(S, [{ callbackId: 'cb-inf', providerMessageId: r2.providerMessageId, status: 'opened', at: 'Infinity' }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r2.id).status === 'opened');
  s2 = storedRow(dir, r2.id); assert.equal(s2.openedAt, null, 'a non-finite clock is recorded as null (what the JSON save persisted before S7b)'); assert.equal(s2.deliveredAt, kept);
  // Lookup semantics: an explicit null matches the first null-provider row in insertion order (the first in_app row); a missing id matches nothing but is remembered.
  const nullRows = stored(dir).filter((d) => d.providerMessageId === null); assert.ok(nullRows.length >= 2);
  c = await callback(S, [{ callbackId: 'cb-nullid', providerMessageId: null, status: 'opened', at: 11 }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, nullRows[0].id).openedAt === 11 || storedRow(dir, nullRows[0].id).openedAt !== nullRows[0].openedAt);
  assert.equal(storedRow(dir, nullRows[0].id).openedAt, nullRows[0].openedAt ?? 11, 'the FIRST null row is the one matched (its clock set if it had none)'); assert.equal(storedRow(dir, nullRows[1].id).openedAt, nullRows[1].openedAt, 'the second null row untouched');
  c = await callback(S, [{ callbackId: 'cb-missing', status: 'delivered', at: 13 }]); assert.deepEqual(c.body, { applied: 0, duplicates: 0 });
  c = await callback(S, [{ callbackId: 'cb-missing', status: 'delivered', at: 13 }]); assert.deepEqual(c.body, { applied: 0, duplicates: 1 }, 'remembered although it matched nothing');
  await until(async () => (blobRows(dir, 'deliveryCallbacksSeen') ?? []).length >= seenBefore + 9);
  assert.equal((blobRows(dir, 'deliveryCallbacksSeen') ?? []).length, seenBefore + 9, 'every distinct callbackId is remembered, in the same saves as the dispatch updates');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 4. acknowledgment: one unit with the notification contract
await test('acknowledgment: a failure of the real COMMIT during the ack (internal:unit.sqlite_commit) is answered 500 and leaves BOTH the notification contract and every dispatch row of the notice unchanged (tables, second connection); the retry acknowledges both together — the in_app row actioned, the skipped e-mail row keeps skipped and gains actionedAt — a SIGKILL right after keeps both; a second ack is a no-op', async () => {
  const dir = tempDir('s7b-ack'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const me = (await S.j('GET', '/player/me', undefined, kola)).body; const mediaId = me.media?.[0]?.id ?? me.player?.media?.[0]?.id; assert.ok(mediaId);
  const trn = await S.j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Synthetic transition', periodDays: 60 }, kola); assert.equal(trn.status, 201, trn.text);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/recipients`, { orgId: 'org-eastport', days: 30 }, kola)).status, 201);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/revoke-recipient`, { orgId: 'org-eastport' }, kola)).status, 200);
  const notice = (await S.j('GET', '/org/notifications', undefined, maria)).body.find((n) => n.type === 'transition' && n.actionRequired); assert.ok(notice);
  await sweep(S);
  const rowsFor = () => stored(dir).filter((d) => d.notificationId === notice.id).map((d) => [d.channel, d.status, d.actionedAt]);
  const before = rowsFor(); assert.deepEqual(before.map((r) => r[1]), ['delivered', 'skipped']); assert.ok(before.every((r) => r[2] === null));
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  const refused = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(refused.status, 500, refused.text);
  assert.equal(q1(dir, 'SELECT action_acked_at AS at FROM notifications WHERE id = ?', notice.id).at, null, 'the contract is not acknowledged'); assert.deepEqual(rowsFor(), before, 'the dispatch rows are unchanged in the tables');
  assert.deepEqual((await admin(S)).recent.filter((d) => d.notificationId === notice.id).map((d) => [d.channel, d.status, d.actionedAt]).reverse(), before, 'memory restored (recent lists newest first)');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const ok = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(ok.status, 200, ok.text);
  assert.equal(q1(dir, 'SELECT action_acked_at AS at FROM notifications WHERE id = ?', notice.id).at, ok.body.ackedAt);
  assert.deepEqual(rowsFor(), [['in_app', 'actioned', ok.body.ackedAt], ['email', 'skipped', ok.body.ackedAt]], 'both rows in the same commit; the terminal skipped row keeps its status and gains actionedAt');
  const second = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(second.body.ackedAt, ok.body.ackedAt);
  await S.kill(); S = await boot(dir);
  assert.deepEqual(rowsFor(), [['in_app', 'actioned', ok.body.ackedAt], ['email', 'skipped', ok.body.ackedAt]]); assert.equal((await admin(S)).awaitingAck, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 5. ordinary deletion keeps the dispatch rows
await test('ordinary account deletion: the player\'s notification rows go and every dispatch row that referenced them STAYS in the table with its status (the orphans the preparation probe recorded), the next sweep leaves them byte-identical, /admin/delivery still lists them, the backlog count ignores them; nothing is pruned, re-parented or blocked', async () => {
  const dir = tempDir('s7b-delete'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic: a conversation about next season.' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0]; assert.ok(channel?.id);
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message before deletion.' }, maria)).status, 201);
  await sweep(S);
  const playerNotices = qAll(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").map((r) => r.id); assert.ok(playerNotices.length >= 1);
  const theirs = () => stored(dir).filter((d) => playerNotices.includes(d.notificationId)).map(({ deliveredType, ...d }) => d);
  const before = theirs(); assert.ok(before.length >= 2, 'rows exist for the player\'s notices'); const total = stored(dir).length;
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200);
  await until(async () => q1(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").n === 0);
  assert.deepEqual(theirs(), before, 'every dispatch row that referenced the deleted notifications is still there, unchanged'); assert.equal(stored(dir).length, total);
  await sweep(S); await sleep(100); assert.deepEqual(theirs(), before, 'the next sweep leaves the orphans alone');
  const recent = (await admin(S)).recent; assert.ok(before.every((d) => recent.some((r) => r.id === d.id)), 'the admin view still lists them');
  assert.equal((await S.j('GET', '/admin/metrics', undefined, null, A)).body.dispatchBacklog, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 6. a configured webhook: the delivery row lands with the failed dispatch
await test('coupled webhook intent (synthetic configured endpoint, ALLOW_LOCAL_WEBHOOKS=1): when the retries of an org user\'s e-mail dispatch are exhausted, the failed dispatch row, the delivery_failed ops event and the webhookDeliveries row for the org\'s endpoint are all durable (second connection) and the webhook sweep then attempts the (unreachable) destination without touching the dispatch row', async () => {
  const dir = tempDir('s7b-webhook'); const S = await boot(dir, { ALLOW_LOCAL_WEBHOOKS: '1' });
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const unreachable = await freePort();
  const hook = await S.j('POST', '/org/webhooks', { url: `http://127.0.0.1:${unreachable}/hook`, events: ['delivery.failed'] }, maria); assert.equal(hook.status, 201, hook.text);
  // An org user with an e-mail address: invite one (the invite flow creates the staff record with an address).
  const invite = await S.j('POST', '/org/invites', { email: 'synthetic.scout@example.test', name: 'Synthetic Scout', role: 'Scout' }, maria); assert.equal(invite.status, 201, invite.text);
  assert.equal(invite.body.invite?.token, undefined, 'the invite code is never in the API response; it goes to the e-mail');
  const outbox = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; const mail = (Array.isArray(outbox) ? outbox : outbox.items ?? []).find((m) => /synthetic\.scout@example\.test/.test(m.to ?? '')); assert.ok(mail, JSON.stringify(outbox).slice(0, 300));
  const token = (mail.text ?? '').match(/invite code: ([0-9a-f]{36})/)?.[1]; assert.ok(token, `invite code in the dev outbox mail: ${JSON.stringify(mail).slice(0, 300)}`);
  const accept = await S.j('POST', '/auth/org/accept-invite', { token, scoutName: 'Synthetic Scout' });
  assert.equal(accept.status, 201, `accept-invite ${accept.status} ${accept.text.slice(0, 200)}`);
  const scout = accept.body.token;
  await inject(S, 4);
  const ticket = await S.j('POST', '/org/support', { subject: 'Synthetic ticket', body: 'x', refs: [] }, scout); assert.equal(ticket.status, 201, ticket.text);
  assert.equal((await S.j('POST', `/admin/support/${ticket.body.ticket.id}/reply`, { text: 'Synthetic reply that will fail to send.' }, null, A)).status, 200);
  const failed = await until(async () => { await sweep(S); return stored(dir).find((d) => d.channel === 'email' && d.to === 'synthetic.scout@example.test' && d.status === 'failed'); }, 20_000);
  assert.ok(failed, `the e-mail dispatch exhausted its retries: ${JSON.stringify(stored(dir).map((d) => [d.channel, d.to, d.status]))}`);
  assert.equal(failed.attempts.length, 4);
  await until(async () => (blobRows(dir, 'webhookDeliveries') ?? []).some((w) => w.type === 'delivery.failed' && w.data?.dispatchId === failed.id));
  const delivery = (blobRows(dir, 'webhookDeliveries') ?? []).find((w) => w.type === 'delivery.failed' && w.data?.dispatchId === failed.id);
  assert.ok(delivery, 'the webhook delivery row is durable'); assert.equal(delivery.endpointId, hook.body.endpoint.id);
  assert.ok((blobRows(dir, 'opsEvents') ?? []).some((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failed.id));
  await until(async () => (blobRows(dir, 'webhookDeliveries') ?? []).find((w) => w.id === delivery.id)?.attempts?.length >= 1, 8000);
  assert.deepEqual(storedRow(dir, failed.id).attempts.length, 4, 'the webhook sweep touched the webhook row, not the dispatch');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 7. crash recovery around a retry
await test('crash recovery: a SIGKILL while an e-mail dispatch is retrying loses nothing that was saved — the reboot resumes the ladder from the table (the attempts already recorded stay, the remaining ones follow) and the row ends accepted with the sends in order', async () => {
  const dir = tempDir('s7b-crash'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  await inject(S, 3);
  const notice = await guardianNotice(S, maria, amara);
  const id = await until(async () => { await sweep(S); return stored(dir).find((x) => x.notificationId === notice.id && x.channel === 'email' && x.attempts.length >= 1)?.id; });
  const atKill = storedRow(dir, id); assert.equal(atKill.status, 'retrying');
  await S.kill(); S = await boot(dir);
  assert.deepEqual(storedRow(dir, id).attempts.slice(0, atKill.attempts.length), atKill.attempts, 'the attempts saved before the kill are intact (the boot sweep may already have appended the next one)');
  const done = await until(async () => { const d = storedRow(dir, id); return d.status === 'accepted' ? d : null; }, 20_000);
  assert.ok(done, 'the ladder resumed after the restart'); assert.equal(done.attempts.length, 4); assert.deepEqual(done.attempts.map((a) => a.ok), [false, false, false, true]);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 8. backup, restore, rollback, the old build
await test('backup/restore and the old-build rollback proof: the admin backup exports `dispatches` explicitly in the legacy shape with nested attempts (a backup restores on any build); a restore into a NEW directory imports them (migration 0010) with the same rows, attempts, clocks and orphan count; a backup whose dispatch entry is malformed is refused at boot (DISPATCHES_IMPORT_BLOCKED) and creates no table; the S7a rollback tool refuses the S7b file (exit 4); with SCOUTBOX_PRE_S7B_SERVER set, the copy-only rollback of the live directory boots on the accepted 0641b2c build, which shows the same delivery records and keeps writing to its blob', async () => {
  const dir = tempDir('s7b-backup'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara'); const kola = await playerLogin(S, 'pl-adeyemi');
  await inject(S, 1);
  const notice = await guardianNotice(S, maria, amara); const row = await emailRowOf(S, dir, notice); assert.equal(row.status, 'accepted');
  assert.equal((await callback(S, [{ callbackId: 'cb-b1', providerMessageId: row.providerMessageId, status: 'opened', at: FRACTIONAL }])).body.applied, 1);
  await until(async () => storedRow(dir, row.id).openedAt === FRACTIONAL);
  // An orphan: an adult's notification deleted with the account.
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic.' }, maria); assert.equal(req.status, 201);
  await sweep(S); assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200); await sleep(300);
  const all = stored(dir).map(({ deliveredType, ...d }) => d); assert.ok(all.length >= 4);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.deepEqual(snapshot.db.dispatches, all, 'the backup carries the dispatches in the legacy shape, attempts nested, the fractional clock exact');
  await S.stop();
  const restored = tempDir('s7b-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.ok(live(restored)); assert.deepEqual(stored(restored).map(({ deliveredType, ...d }) => d), all, 'imported row for row, attempt for attempt');
  assert.equal(JSON.parse(q1(restored, "SELECT value FROM meta WHERE key = 'dispatchesCutover'").value).dispatches.orphanReferences, all.filter((d) => !qAll(restored, 'SELECT id FROM notifications').some((n) => n.id === d.notificationId)).length);
  assert.equal(q1(restored, "SELECT COUNT(*) AS n FROM collections WHERE name = 'dispatches'").n, 0, 'no blob left behind');
  await S.stop();
  const bad = tempDir('s7b-bad'); fs.cpSync(bk.body.dir, bad, { recursive: true });
  { const j = JSON.parse(fs.readFileSync(path.join(bad, 'db.json'), 'utf8')); j.db.dispatches[0].attempts = [{ at: 1 }]; fs.writeFileSync(path.join(bad, 'db.json'), JSON.stringify(j)); }
  const refusedBoot = await bootRefuses(bad); assert.match(refusedBoot.log, /DISPATCHES_IMPORT_BLOCKED/); assert.equal(refusedBoot.log.includes('example.test'), false, 'no address in the log'); assert.equal(live(bad), false);
  // The S7a tool refuses the S7b file.
  try { execFileSync(process.execPath, [path.join(HERE, 'notificationsRollback.mjs'), dir, tempDir('s7b-s7atool')], { stdio: 'pipe' }); assert.fail('must refuse'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // The copy-only rollback booted by the accepted build.
  const copy = tempDir('s7b-rollback');
  const out = execFileSync(process.execPath, [path.join(HERE, 'dispatchesRollback.mjs'), dir, copy], { encoding: 'utf8' });
  assert.match(out, /written back as a blob/); assert.equal(live(copy), false); assert.deepEqual(stored(copy), all, 'the blob holds every row and attempt in order');
  const OLD = process.env.SCOUTBOX_PRE_S7B_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    const old = await boot(copy, {}, OLD);
    assert.ok(!/0010_dispatches/.test(old.log()), 'the accepted build knows nothing of 0010');
    const oldAdmin = await (async () => (await old.j('GET', '/admin/delivery', undefined, null, A)).body)();
    const pick = (d) => ({ id: d.id, status: d.status, attempts: d.attempts, deliveredAt: d.deliveredAt, openedAt: d.openedAt, providerMessageId: d.providerMessageId });
    assert.deepEqual(oldAdmin.recent.slice().reverse().map(pick), all.map(pick), 'the old build shows the same delivery records, attempts and clocks');
    const oldMaria = await orgLogin(old, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const oldAmara = await guardianLogin(old, 'gd-amara');
    const n = await guardianNotice(old, oldMaria, oldAmara, 'trial');
    await until(async () => { await sweep(old); return (blobRows(copy, 'dispatches') ?? []).some((d) => d.notificationId === n.id); });
    assert.ok((blobRows(copy, 'dispatches') ?? []).some((d) => d.notificationId === n.id), 'the accepted build keeps writing to the blob of the copy');
    await old.stop();
    console.log('    (accepted 0641b2c build booted the rollback copy: same delivery records, new writes accepted)');
  } else {
    console.log('    (SCOUTBOX_PRE_S7B_SERVER not set: the old-build boot of the rollback copy was SKIPPED; the blob shape was checked by this process only)');
  }
  rm(dir, restored, bad, copy);
});


// ------------------------------------------------------------- review of 26d492b, finding 3: callback precedence through the real route
await test('review of 26d492b, finding 3 (real route) — the pre-S7b nullish precedence survives a non-finite clock: one signed batch with delivered at "Infinity" then at 1234 for the same provider id persists deliveredAt NULL (the in-memory clock is set, the second event cannot replace it, the save stores what JSON stored); a later request in the same process cannot set it either; the admin view and the backup export carry null; an opened sequence behaves the same; after a RESTART the table\'s null lets a finite callback set the clock, and an existing finite clock is then kept; a failed save (real COMMIT) keeps the callback\'s changes queued and the next save lands them', async () => {
  const dir = tempDir('s7b-rv3'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  const n1 = await guardianNotice(S, maria, amara); const r1 = await emailRowOf(S, dir, n1); assert.equal(r1.status, 'accepted');
  const n2 = await guardianNotice(S, maria, amara, 'trial'); const r2 = await emailRowOf(S, dir, n2); assert.equal(r2.status, 'accepted');
  // One batch: Infinity, then 1234.
  let c = await callback(S, [{ callbackId: 'rv-inf', providerMessageId: r1.providerMessageId, status: 'delivered', at: 'Infinity' }, { callbackId: 'rv-1234', providerMessageId: r1.providerMessageId, status: 'delivered', at: 1234 }]);
  assert.deepEqual(c.body, { applied: 2, duplicates: 0 });
  await until(async () => storedRow(dir, r1.id).status === 'delivered');
  let s1 = storedRow(dir, r1.id); assert.equal(s1.deliveredAt, null, 'the second event could not replace the non-finite clock; NULL is stored (what the JSON save of the previous build persisted)'); assert.equal(s1.deliveredType, 'null');
  // A later request in the same process: still set in memory, still null durable.
  c = await callback(S, [{ callbackId: 'rv-later', providerMessageId: r1.providerMessageId, status: 'delivered', at: 4321 }]); assert.equal(c.body.applied, 1); await sleep(150);
  assert.equal(storedRow(dir, r1.id).deliveredAt, null, 'a later finite event in the same process does not set it either (the in-memory clock is set)');
  const adminRow = (await admin(S)).recent.find((d) => d.id === r1.id); assert.equal(adminRow.deliveredAt, null, 'the admin view (JSON) carries null, as the previous build did');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const exported = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8')).db.dispatches.find((d) => d.id === r1.id); assert.equal(exported.deliveredAt, null, 'the backup export carries null');
  // An opened sequence: opened at Infinity, then delivered 999, then opened 5 — openedAt and deliveredAt stay null durable, the status is opened.
  c = await callback(S, [{ callbackId: 'rv-o1', providerMessageId: r2.providerMessageId, status: 'opened', at: 'Infinity' }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r2.id).status === 'opened');
  c = await callback(S, [{ callbackId: 'rv-o2', providerMessageId: r2.providerMessageId, status: 'delivered', at: 999 }, { callbackId: 'rv-o3', providerMessageId: r2.providerMessageId, status: 'opened', at: 5 }]); assert.equal(c.body.applied, 2); await sleep(150);
  let s2 = storedRow(dir, r2.id); assert.equal(s2.status, 'opened'); assert.equal(s2.openedAt, null); assert.equal(s2.deliveredAt, null, 'opened implied delivered with the same in-memory clock; both null durable');
  // Restart: the table's null is the state (as the old build's reload of its JSON); a finite callback now sets the clock, and a later one keeps it.
  await S.stop(); S = await boot(dir);
  assert.equal(storedRow(dir, r1.id).deliveredAt, null);
  c = await callback(S, [{ callbackId: 'rv-r1', providerMessageId: r1.providerMessageId, status: 'delivered', at: 4321 }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r1.id).deliveredAt === 4321); assert.equal(storedRow(dir, r1.id).deliveredAt, 4321, 'after a restart the clock can be set');
  c = await callback(S, [{ callbackId: 'rv-r2', providerMessageId: r1.providerMessageId, status: 'delivered', at: 8765 }]); assert.equal(c.body.applied, 1); await sleep(150); assert.equal(storedRow(dir, r1.id).deliveredAt, 4321, 'an existing finite clock is kept');
  // A failed save at the real COMMIT keeps the callback's changes queued; the next save lands them once.
  const seqBefore = seqOf(dir); const logBefore = S.log().length;
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  c = await callback(S, [{ callbackId: 'rv-f1', providerMessageId: r2.providerMessageId, status: 'delivered', at: 777 }]); assert.equal(c.body.applied, 1);
  await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 8000);
  assert.equal(storedRow(dir, r2.id).deliveredAt, null, 'not durable after the failed save'); assert.equal(seqOf(dir), seqBefore);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  c = await callback(S, [{ callbackId: 'rv-f2', providerMessageId: r2.providerMessageId, status: 'opened', at: 888 }]); assert.equal(c.body.applied, 1);
  await until(async () => storedRow(dir, r2.id).deliveredAt === 777);
  s2 = storedRow(dir, r2.id); assert.equal(s2.deliveredAt, 777, 'the retried change landed'); assert.equal(s2.openedAt, 888); assert.ok(seqOf(dir) > seqBefore);
  assert.ok((blobRows(dir, 'deliveryCallbacksSeen') ?? []).includes('rv-f1') && (blobRows(dir, 'deliveryCallbacksSeen') ?? []).includes('rv-f2'), 'the callback bookkeeping landed in the same save');
  await S.stop(); rm(dir);
});

console.log(`\n${passed} dispatch server checks passed`);
