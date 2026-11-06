// Delivery dispatches through the REAL server (server.mjs booted as a child process on temporary data directories,
// synthetic seed records only, M13_FAST_RETRY so the sweep runs every 400 ms and the retry ladder is [0, 300, 600,
// 900] ms). Explicit since S14d: each send is ONE unit of work (its attempt, its status, the outbox row, the injected
// failure it used and, on the last failure, the ops event and the webhook intent) — a unit whose real COMMIT fails
// leaves none of them and the next pass sends once; the retry ladder with the quiet-hours note; provider callbacks
// (integer clocks kept exactly, an existing clock kept, duplicates, a late bounce, junk refused whole before anything
// is applied, each event committed with its seen marker); the acknowledgment unit under a real COMMIT failure;
// dispatch rows retained after an ordinary account deletion; the webhook intent; a SIGKILL mid-retry; the club's
// delivery list paged and scoped; the admin backup and its restore. Every database read goes through a second
// read-only connection. Nothing here touches DATA_DIR or real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { SAFETY_AUDIT_SNAPSHOT } from '../repositories/safetyAudit.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const CALLBACK_SECRET = 'local-fake-callback-secret';
const CLOCK = 1700000000123;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };

async function boot(dir, env = {}) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
   
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
const q1 = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; } finally { s.close(); } };
const qAll = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
// S6b: opsEvents is the ops_events table since 0013 — read in the writer's literal through the repository's own reader.
// S13e: the delivery centre's bookkeeping is rows of repositories/operations.mjs (rewritten: the blob reads described the old storage).
const seenIds = (dir) => qAll(dir, 'SELECT callback_id FROM delivery_callbacks_seen ORDER BY rowid').map((r) => r.callback_id);
const injected = (dir) => Object.fromEntries(qAll(dir, 'SELECT channel, remaining FROM delivery_fail_injections').map((r) => [r.channel, r.remaining]));
const auditRows = (dir, name) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return SAFETY_AUDIT_SNAPSHOT.read(s)?.[name] ?? null; } finally { s.close(); } };
/** The webhook deliveries as the DATABASE holds them (S13a: rows of webhook_deliveries, the payload typed, attempts counted). */
const webhookRows = (dir) => qAll(dir, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_deliveries'").length
  ? qAll(dir, 'SELECT d.id, d.type, d.endpoint_id, d.subject_id, (SELECT COUNT(*) FROM webhook_delivery_attempts a WHERE a.delivery_id = d.id) AS attempts FROM webhook_deliveries d ORDER BY d.rowid')
    .map((r) => ({ id: r.id, type: r.type, endpointId: r.endpoint_id, data: r.type === 'delivery.failed' ? { dispatchId: r.subject_id } : null, attempts: r.attempts }))
  : null;
/** The mail outbox as the DATABASE holds it, in insertion order. */
const outboxRows = (dir) => qAll(dir, 'SELECT id, provider_message_id FROM outbox ORDER BY seq').map((r) => ({ id: r.id, providerMessageId: r.provider_message_id }));
/** The dispatch records as the DATABASE holds them, in insertion order, with attempts re-nested. */
const stored = (dir) => {
  const rows = qAll(dir, 'SELECT seq, id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason, org_id FROM dispatches ORDER BY seq');
  const attempts = qAll(dir, 'SELECT dispatch_seq, seq, kind, attempted_at, ok, error, note FROM dispatch_attempts ORDER BY dispatch_seq, seq');
  return rows.map((r) => ({ id: r.id, notificationId: r.notification_id, audience: { kind: r.audience_kind, id: r.audience_id }, channel: r.channel, to: r.to_address, provider: r.provider, status: r.status, skipReason: r.skip_reason, providerMessageId: r.provider_message_id, attempts: attempts.filter((a) => a.dispatch_seq === r.seq).map((a) => (a.kind === 'quiet_recheck' ? { at: a.attempted_at, note: a.note } : { at: a.attempted_at, ok: a.ok === 1, error: a.error })), nextAt: r.next_at, actionDeadline: r.action_deadline_at, createdAt: r.created_at, deliveredAt: r.delivered_at, openedAt: r.opened_at, actionedAt: r.actioned_at, failedAt: r.failed_at, failReason: r.fail_reason, orgId: r.org_id }));
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

// ------------------------------------------------------------- 1. a send is one unit of work
await test('a send is ONE unit: the attempt, the status, the outbox row the provider accepted and the injected failure it used are durable together (second connection) — when that unit fails at its REAL COMMIT (internal:unit.sqlite_commit) none of them is durable and the dispatch is unchanged; the next pass sends it once (exactly one outbox row for the accepted send); no blob table', async () => {
  const dir = tempDir('s14d-send'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  await inject(S, 1); // the first send fails: the row is retrying until the next pass
  const notice = await guardianNotice(S, maria, amara);
  const emailId = await until(async () => { await sweep(S); const d = stored(dir).find((x) => x.notificationId === notice.id && x.channel === 'email'); return d?.attempts.length ? d.id : null; });
  assert.ok(emailId, 'the sweep created the dispatch and recorded the first send');
  const first = storedRow(dir, emailId); assert.equal(first.status, 'retrying'); assert.deepEqual(first.attempts.map((a) => [a.ok, a.error]), [[false, 'injected provider failure']]);
  assert.deepEqual(injected(dir).email, 0, 'the injected failure was used in the same unit');
  assert.equal(q1(dir, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'collections'"), undefined, 'no blob table');
  const outboxBefore = outboxRows(dir).length; const logBefore = S.log().length;
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  await until(async () => new RegExp(`delivery sweep: dispatch ${emailId} was not processed`).test(S.log().slice(logBefore)), 8000);
  assert.match(S.log().slice(logBefore), new RegExp(`delivery sweep: dispatch ${emailId} was not processed`), 'the send\'s unit failed at its COMMIT');
  const afterFailure = storedRow(dir, emailId);
  assert.equal(afterFailure.status, 'retrying'); assert.equal(afterFailure.attempts.length, 1, 'the attempt is not durable'); assert.equal(afterFailure.providerMessageId, null);
  assert.equal(outboxRows(dir).length, outboxBefore, 'the outbox row went with its unit');
  assert.equal((await admin(S)).recent.find((d) => d.id === emailId).status, 'retrying', 'no mirror: the admin view reads the table');
  const landed = await until(async () => { const d = storedRow(dir, emailId); return d.status === 'accepted' ? d : null; }, 8000);
  assert.ok(landed, 'the next pass sent it'); assert.deepEqual(landed.attempts.map((a) => a.ok), [false, true]); assert.ok(landed.providerMessageId);
  assert.equal(outboxRows(dir).filter((m) => m.providerMessageId === landed.providerMessageId).length, 1, 'exactly one outbox row for the one accepted send');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 2. the retry ladder and the quiet-hours note
await test('retry ladder: a deferred-push notice is held (held_quiet_hours), its first due pass records the quiet re-check NOTE row first, then the send rows — two injected failures, then the acceptance — the note is kind quiet_recheck with ok NULL in the table and never counts as a send; exhausted retries (four injected failures) end failed with failedAt, the provider\'s reason and one delivery_failed ops event', async () => {
  const dir = tempDir('s14d-ladder'); const S = await boot(dir);
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
  assert.equal((await S.j('POST', '/guardian/prefs', { quietStart: null, quietEnd: null, timezone: 'Europe/London' }, amara)).status, 200);
  await inject(S, 4);
  const notice2 = await guardianNotice(S, maria, amara, 'trial');
  const failed = await emailRowOf(S, dir, notice2);
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts.length, 4); assert.ok(failed.failedAt); assert.equal(failed.failReason, 'injected provider failure');
  assert.equal((auditRows(dir, 'opsEvents') ?? []).filter((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failed.id).length, 1, 'the ops event committed with the failure');
  assert.equal((await S.j('GET', '/admin/metrics', undefined, null, A)).body.dispatchBacklog, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 3. callbacks
await test('provider callbacks through the real route: a whole-number `at` becomes deliveredAt/openedAt exactly; a null or omitted `at` is the server clock; an existing clock is kept; a duplicate callbackId applies nothing; a late bounce records its reason without regressing; an unknown provider id applies nothing but is remembered; junk (an unknown status, a fractional or non-numeric `at`, a non-text provider id or callback id, a non-list, more than 100 events) is refused with 400 naming the field and NOTHING of the batch is applied or remembered; an event whose unit fails at COMMIT leaves neither its change nor its marker', async () => {
  const dir = tempDir('s14d-callbacks'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  const n1 = await guardianNotice(S, maria, amara); const r1 = await emailRowOf(S, dir, n1); assert.equal(r1.status, 'accepted');
  const n2 = await guardianNotice(S, maria, amara, 'trial'); const r2 = await emailRowOf(S, dir, n2); assert.equal(r2.status, 'accepted');
  const seenBefore = seenIds(dir).length;
  let c = await callback(S, [{ callbackId: 'cb-open', providerMessageId: r1.providerMessageId, status: 'opened', at: CLOCK }]); assert.deepEqual(c.body, { applied: 1, duplicates: 0 });
  let s1 = storedRow(dir, r1.id); assert.equal(s1.status, 'opened'); assert.equal(s1.openedAt, CLOCK); assert.equal(s1.deliveredAt, CLOCK, 'opened implies delivered, at the same clock');
  c = await callback(S, [{ callbackId: 'cb-open', providerMessageId: r1.providerMessageId, status: 'opened', at: 1 }]); assert.deepEqual(c.body, { applied: 0, duplicates: 1 }); assert.equal(storedRow(dir, r1.id).openedAt, CLOCK);
  c = await callback(S, [{ callbackId: 'cb-bounce', providerMessageId: r1.providerMessageId, status: 'bounced', reason: 'synthetic late bounce', at: 5 }, { callbackId: 'cb-deliv', providerMessageId: r1.providerMessageId, status: 'delivered', at: 7 }]);
  assert.deepEqual(c.body, { applied: 2, duplicates: 0 });
  s1 = storedRow(dir, r1.id); assert.equal(s1.status, 'opened'); assert.equal(s1.failedAt, null); assert.equal(s1.failReason, 'synthetic late bounce'); assert.equal(s1.deliveredAt, CLOCK, 'an existing clock is kept');
  const before = Date.now();
  c = await callback(S, [{ callbackId: 'cb-null', providerMessageId: r2.providerMessageId, status: 'delivered', at: null }]); assert.equal(c.body.applied, 1);
  const s2 = storedRow(dir, r2.id); assert.equal(s2.status, 'delivered'); assert.ok(Number.isInteger(s2.deliveredAt) && s2.deliveredAt >= before, 'null is the server clock');
  c = await callback(S, [{ callbackId: 'cb-unknown', providerMessageId: 'fm_nobody', status: 'delivered' }]); assert.deepEqual(c.body, { applied: 0, duplicates: 0 });
  c = await callback(S, [{ callbackId: 'cb-unknown', providerMessageId: 'fm_nobody', status: 'delivered' }]); assert.deepEqual(c.body, { applied: 0, duplicates: 1 }, 'remembered although it matched nothing');
  const good = { callbackId: 'cb-good', providerMessageId: r2.providerMessageId, status: 'opened', at: CLOCK };
  for (const [events, field] of [
    [[good, { ...good, callbackId: 'cb-j1', status: 'teleported' }], 'events[1].status'], [[good, { ...good, callbackId: 'cb-j2', at: CLOCK + 0.5 }], 'events[1].at'], [[good, { ...good, callbackId: 'cb-j3', at: 'Infinity' }], 'events[1].at'],
    [[good, { ...good, callbackId: 'cb-j4', providerMessageId: null }], 'events[1].providerMessageId'], [[good, { ...good, callbackId: undefined }], 'events[1].callbackId'], [[good, { ...good, callbackId: 'x'.repeat(201) }], 'events[1].callbackId'],
    [[good, 'not an event'], 'events[1]'], [{ not: 'a list' }, 'events'], [Array.from({ length: 101 }, (_, i) => ({ ...good, callbackId: `cb-many-${i}` })), 'events'],
  ]) {
    c = await callback(S, events); assert.equal(c.status, 400, c.text); assert.deepEqual([c.body.error, c.body.field], ['FIELD_INVALID', field]);
  }
  assert.equal(storedRow(dir, r2.id).status, 'delivered', 'nothing of a refused batch was applied'); assert.ok(!seenIds(dir).includes('cb-good'), 'nor remembered');
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  c = await callback(S, [good]); assert.equal(c.status, 500, c.text);
  assert.equal(storedRow(dir, r2.id).status, 'delivered'); assert.ok(!seenIds(dir).includes('cb-good'), 'the marker went with its change');
  c = await callback(S, [good]); assert.deepEqual(c.body, { applied: 1, duplicates: 0 }, 'the provider\'s retry applies it');
  assert.equal(storedRow(dir, r2.id).status, 'opened'); assert.equal(storedRow(dir, r2.id).openedAt, CLOCK);
  assert.equal(seenIds(dir).length, seenBefore + 6, 'every distinct applied or unknown callbackId is remembered, and only those');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 4. acknowledgment: one unit with the notification contract
await test('acknowledgment: a failure of the real COMMIT during the ack (internal:unit.sqlite_commit) is answered 500 and leaves BOTH the notification contract and every dispatch row of the notice unchanged; the retry acknowledges both together — the in_app row actioned, the skipped e-mail row keeps skipped and gains actionedAt — a SIGKILL right after keeps both; a second ack is a no-op', async () => {
  const dir = tempDir('s14d-ack'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const me = (await S.j('GET', '/player/me', undefined, kola)).body; const mediaId = me.media?.[0]?.id ?? me.player?.media?.[0]?.id; assert.ok(mediaId);
  const trn = await S.j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Synthetic transition', periodDays: 60 }, kola); assert.equal(trn.status, 201, trn.text);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/recipients`, { orgId: 'org-eastport', days: 30 }, kola)).status, 201);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/revoke-recipient`, { orgId: 'org-eastport' }, kola)).status, 200);
  const notice = (await S.j('GET', '/org/notifications', undefined, maria)).body.find((n) => n.type === 'transition' && n.actionRequired); assert.ok(notice);
  await sweep(S);
  const rowsFor = () => stored(dir).filter((d) => d.notificationId === notice.id).map((d) => [d.channel, d.status, d.actionedAt]);
  const before = rowsFor(); assert.deepEqual(before.map((r) => r[1]), ['delivered', 'skipped']); assert.ok(before.every((r) => r[2] === null));
  assert.ok(stored(dir).filter((d) => d.notificationId === notice.id).every((d) => d.orgId === 'org-eastport'), 'a staff audience\'s dispatches carry its organisation');
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status, 200);
  const refused = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(refused.status, 500, refused.text);
  assert.equal(q1(dir, 'SELECT action_acked_at AS at FROM notifications WHERE id = ?', notice.id).at, null, 'the contract is not acknowledged'); assert.deepEqual(rowsFor(), before, 'the dispatch rows are unchanged');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const ok = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(ok.status, 200, ok.text);
  assert.equal(q1(dir, 'SELECT action_acked_at AS at FROM notifications WHERE id = ?', notice.id).at, ok.body.ackedAt);
  assert.deepEqual(rowsFor(), [['in_app', 'actioned', ok.body.ackedAt], ['email', 'skipped', ok.body.ackedAt]], 'both rows in the same commit; the terminal skipped row keeps its status and gains actionedAt');
  const again = await S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria); assert.equal(again.body.ackedAt, ok.body.ackedAt);
  await S.kill(); S = await boot(dir);
  assert.deepEqual(rowsFor(), [['in_app', 'actioned', ok.body.ackedAt], ['email', 'skipped', ok.body.ackedAt]]); assert.equal((await admin(S)).awaitingAck, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 5. ordinary deletion keeps the dispatch rows
await test('ordinary account deletion: the player\'s notification rows go and every dispatch row that referenced them STAYS in the table with its status, the next sweep leaves them unchanged, /admin/delivery still lists them, the backlog count ignores them', async () => {
  const dir = tempDir('s14d-delete'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic: a conversation about next season.' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0]; assert.ok(channel?.id);
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message before deletion.' }, maria)).status, 201);
  await until(async () => { await sweep(S); return qAll(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").every((n) => stored(dir).some((d) => d.notificationId === n.id)); });
  const playerNotices = qAll(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").map((r) => r.id); assert.ok(playerNotices.length >= 1);
  const theirs = () => stored(dir).filter((d) => playerNotices.includes(d.notificationId));
  const before = theirs(); assert.ok(before.length >= 2, 'rows exist for the player\'s notices'); const total = stored(dir).length;
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200);
  await until(async () => q1(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").n === 0);
  assert.deepEqual(theirs(), before, 'every dispatch row that referenced the deleted notifications is still there, unchanged'); assert.equal(stored(dir).length, total);
  await sweep(S); await sleep(100); assert.deepEqual(theirs(), before, 'the next sweep leaves them alone');
  const recent = (await admin(S)).recent; assert.ok(before.every((d) => recent.some((r) => r.id === d.id)), 'the admin view still lists them');
  assert.equal((await S.j('GET', '/admin/metrics', undefined, null, A)).body.dispatchBacklog, 0);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 6. a configured webhook: the delivery row commits with the failed dispatch
await test('webhook intent (synthetic configured endpoint, ALLOW_LOCAL_WEBHOOKS=1): when the retries of a staff member\'s e-mail dispatch run out, the failed dispatch, the delivery_failed ops event and the webhook_deliveries row for the club\'s endpoint (found by the dispatch\'s organisation) commit together; the webhook sweep then attempts the unreachable destination without touching the dispatch', async () => {
  const dir = tempDir('s14d-webhook'); const S = await boot(dir, { ALLOW_LOCAL_WEBHOOKS: '1' });
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const unreachable = await freePort();
  const hook = await S.j('POST', '/org/webhooks', { url: `http://127.0.0.1:${unreachable}/hook`, events: ['delivery.failed'] }, maria); assert.equal(hook.status, 201, hook.text);
  const invite = await S.j('POST', '/org/invites', { email: 'synthetic.scout@example.test', name: 'Synthetic Scout', role: 'Scout' }, maria); assert.equal(invite.status, 201, invite.text);
  const mail = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.items.find((m) => m.to === 'synthetic.scout@example.test'); assert.ok(mail);
  const token = (mail.text ?? '').match(/invite code: ([0-9a-f]{36})/)?.[1]; assert.ok(token);
  const accept = await S.j('POST', '/auth/org/accept-invite', { token, scoutName: 'Synthetic Scout' }); assert.equal(accept.status, 201, accept.text);
  await inject(S, 4);
  const ticket = await S.j('POST', '/org/support', { subject: 'Synthetic ticket', body: 'x', refs: [] }, accept.body.token); assert.equal(ticket.status, 201, ticket.text);
  assert.equal((await S.j('POST', `/admin/support/${ticket.body.ticket.id}/reply`, { text: 'Synthetic reply that will fail to send.' }, null, A)).status, 200);
  const failed = await until(async () => { await sweep(S); return stored(dir).find((d) => d.channel === 'email' && d.to === 'synthetic.scout@example.test' && d.status === 'failed'); }, 20_000);
  assert.ok(failed, 'the e-mail dispatch ran out of retries'); assert.equal(failed.attempts.length, 4); assert.equal(failed.orgId, 'org-eastport');
  const delivery = (webhookRows(dir) ?? []).find((w) => w.type === 'delivery.failed' && w.data?.dispatchId === failed.id);
  assert.ok(delivery, 'the webhook row committed with the failure'); assert.equal(delivery.endpointId, hook.body.endpoint.id);
  assert.ok((auditRows(dir, 'opsEvents') ?? []).some((e) => e.kind === 'delivery_failed' && e.detail?.dispatchId === failed.id));
  await until(async () => (webhookRows(dir) ?? []).find((w) => w.id === delivery.id)?.attempts >= 1, 8000);
  assert.equal(storedRow(dir, failed.id).attempts.length, 4, 'the webhook sweep touched the webhook row, not the dispatch');
  // The club's delivery list: its staff's dispatches only, newest first, paged by cursor; junk paging refused.
  const ids = stored(dir).filter((d) => d.orgId === 'org-eastport').map((d) => d.id).reverse(); assert.ok(ids.length >= 2);
  const page = await S.j('GET', '/org/delivery?limit=1', undefined, maria); assert.equal(page.status, 200, page.text);
  assert.deepEqual(page.body.items.map((d) => d.id), ids.slice(0, 1)); assert.ok(page.body.nextCursor); assert.ok(page.body.items.every((d) => d.orgId === 'org-eastport'));
  const next = await S.j('GET', `/org/delivery?limit=100&cursor=${page.body.nextCursor}`, undefined, maria); assert.deepEqual(next.body.items.map((d) => d.id), ids.slice(1)); assert.equal(next.body.nextCursor, null);
  const rita = await orgLogin(S, 'org-harbour', 'Rita', 'Scout');
  const theirs = await S.j('GET', '/org/delivery', undefined, rita); assert.equal(theirs.status, 200, theirs.text);
  assert.ok(theirs.body.items.every((d) => d.orgId === 'org-harbour'), 'never another club\'s');
  assert.equal((await S.j('GET', '/org/delivery?limit=0', undefined, maria)).status, 400);
  assert.equal((await S.j('GET', '/org/delivery?cursor=junk', undefined, maria)).status, 400);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 7. crash recovery around a retry
await test('crash recovery: a SIGKILL while an e-mail dispatch is retrying loses nothing committed — the reboot resumes the ladder from the table and the row ends accepted with the sends in order', async () => {
  const dir = tempDir('s14d-crash'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  await inject(S, 3);
  const notice = await guardianNotice(S, maria, amara);
  const id = await until(async () => { await sweep(S); return stored(dir).find((x) => x.notificationId === notice.id && x.channel === 'email' && x.attempts.length >= 1)?.id; });
  const atKill = storedRow(dir, id); assert.equal(atKill.status, 'retrying');
  await S.kill(); S = await boot(dir);
  assert.deepEqual(storedRow(dir, id).attempts.slice(0, atKill.attempts.length), atKill.attempts, 'the attempts committed before the kill are intact');
  const done = await until(async () => { const d = storedRow(dir, id); return d.status === 'accepted' ? d : null; }, 20_000);
  assert.ok(done, `the ladder resumed after the restart — ${done ? '' : S.log().slice(-1500)}`); assert.equal(done.attempts.length, 4); assert.deepEqual(done.attempts.map((a) => a.ok), [false, false, false, true]);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- 8. backup and restore
await test('backup/restore: the admin backup\'s database copy holds every dispatch with its attempts, its clocks and its organisation, and the orphan of a deleted account; a restore into a NEW directory gives the same rows', async () => {
  const dir = tempDir('s14d-backup'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara'); const kola = await playerLogin(S, 'pl-adeyemi');
  await inject(S, 1);
  const notice = await guardianNotice(S, maria, amara); const row = await emailRowOf(S, dir, notice); assert.equal(row.status, 'accepted');
  assert.equal((await callback(S, [{ callbackId: 'cb-b1', providerMessageId: row.providerMessageId, status: 'opened', at: CLOCK }])).body.applied, 1);
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic.' }, maria); assert.equal(req.status, 201);
  await sweep(S); assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200); await sleep(300);
  const all = stored(dir); assert.ok(all.length >= 4);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  assert.deepEqual(stored(bk.body.dir), all, 'the copy carries every dispatch, attempts in order');
  const orphans = (d) => stored(d).filter((x) => !qAll(d, 'SELECT id FROM notifications').some((n) => n.id === x.notificationId)).map((x) => x.id);
  assert.ok(orphans(bk.body.dir).length >= 1, 'the orphan of the deleted account is in the copy');
  await S.stop();
  const restored = tempDir('s14d-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.deepEqual(stored(restored), all, 'restored row for row, attempt for attempt');
  assert.equal(storedRow(restored, row.id).openedAt, CLOCK);
  await S.stop();
  rm(dir, restored);
});

console.log(`\n${passed} dispatch server checks passed`);
