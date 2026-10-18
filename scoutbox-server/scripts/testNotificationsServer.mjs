// S7a through the REAL server (server.mjs booted as a child process on
// temporary data directories, synthetic records only): the feed order and the
// coalescing rules exactly as before (reverse insertion order, a refreshed
// clock that does not move the row, one row coalesced, the six-hour window and
// the stop at the first older row — planted rows included), the notification
// row durable in its table with the message it announces and across a SIGKILL,
// the acknowledgment atomic with the dispatch blob under a real COMMIT failure,
// preferences (a mandatory category stored false through numeric zero, forced
// on; a muted category never creates a row), mark-read, account deletion, the
// admin backup and its restore in the legacy shape, and — when
// SCOUTBOX_PRE_S7A_SERVER points at the pre-S7a build's server.mjs — the
// copy-only rollback booted by that build. Nothing here touches DATA_DIR or any
// real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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
const HOUR = 3_600_000; const MIN = 60_000;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
// Every database read goes through a SECOND, read-only connection: what it sees is what is committed.
const q1 = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; } finally { s.close(); } };
const qAll = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const live = (dir) => !!q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0009_notifications'");
const blobRows = (dir, name) => { const r = q1(dir, 'SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
/** The feed as the database holds it, in insertion order: the table after the cutover, the blob before it — so a check reads the same way on both builds. */
const stored = (dir) => (live(dir)
  ? qAll(dir, 'SELECT id, occurred_at AS ts, audience_kind, audience_id, repeat_count AS repeatCount, read, action_acked_at AS ackedAt FROM notifications ORDER BY seq').map((r) => ({ id: r.id, ts: r.ts, audience: { kind: r.audience_kind, id: r.audience_id }, repeatCount: r.repeatCount, read: !!r.read, ackedAt: r.ackedAt }))
  : (blobRows(dir, 'notifications') ?? []).map((n) => ({ id: n.id, ts: n.ts, audience: n.audience, repeatCount: n.repeatCount ?? 1, read: !!n.read, ackedAt: n.actionRequired?.ackedAt ?? null })));
/** Plant notification rows (legacy shape) at the END of the stored feed, server stopped: into the table after the cutover, into the blob before it. */
function plant(dir, rows) {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA busy_timeout = 5000;');
  try {
    if (live(dir)) {
      const ins = s.prepare('INSERT INTO notifications (id, occurred_at, audience_kind, audience_id, type, text, ref_id, read, repeat_count, group_key, category, deferred_push, action_required, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)');
      for (const n of rows) ins.run(n.id, n.ts, n.audience.kind, n.audience.id, n.type, n.text, n.refId ?? null, n.read ? 1 : 0, n.repeatCount ?? 1, n.groupKey ?? null, n.category ?? null, n.deferredPush ? 1 : 0);
    } else {
      const arr = JSON.parse(s.prepare("SELECT value FROM collections WHERE name = 'notifications'").get().value);
      arr.push(...rows);
      s.prepare("UPDATE collections SET value = ? WHERE name = 'notifications'").run(JSON.stringify(arr));
    }
  } finally { s.close(); }
}
const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const COMMIT_SEAM = 'internal:unit.sqlite_commit';
/** A preference write is saved by the debounced snapshot save (2 s) on both builds: wait for it. */
async function settled(check) { for (let i = 0; i < 120; i++) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); } return check(); }
/** Arm one seam, perform the operation once, prove it was answered 500 and left `unchanged()`, disarm. */
async function refusedBy(S, rule, act, unchanged) {
  assert.equal((await S.j('POST', '/__faults', { rules: rule })).status, 200);
  const r = await act();
  assert.equal(r.status, 500, `${rule}: a unit that did not commit must not be answered as success — got ${r.status} ${r.text}`);
  assert.equal(r.body?.error, 'INTERNAL');
  await unchanged(rule);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
}
/** The contact thread between Eastport (Maria) and the adult seed player: a request, its acceptance, the channel. */
async function openThread(S, maria, kola) {
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'We would like to talk about next season.' }, maria);
  assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const channels = await S.j('GET', '/player/channels', undefined, kola);
  const channel = channels.body.find((c) => c.id === (channels.body[0]?.id)) ?? channels.body[0];
  assert.ok(channel?.id, channels.text);
  return { requestId: req.body.requestId, channelId: channel.id };
}
const feedOf = async (S, p, token) => { const r = await S.j('GET', p, undefined, token); assert.equal(r.status, 200, r.text); return r.body; };
const sameFeed = (feed) => feed.map((n) => ({ id: n.id, ts: n.ts, repeatCount: n.repeatCount, read: n.read, ackedAt: n.actionRequired?.ackedAt ?? null }));

// ------------------------------------------------------------- the feed order and coalescing, through the real routes
await test('feed and coalescing through the real routes: an identical message notification coalesces into one row (repeatCount, refreshed ts, no second row); the feed is reverse INSERTION order — a later, different notification stays above the refreshed one; a planted identical row older than six hours is not coalesced and STOPS the scan (a new row is created although a recent identical unread row sits behind it); a planted identical row inside the window is the one coalesced, the earlier identical row untouched; the order survives a SIGKILL; and after the cutover the rows are in the notifications table with the message that announced them', async () => {
  const dir = tempDir('s7a-feed'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const { channelId } = await openThread(S, maria, kola);
  const say = (text) => S.j('POST', `/org/channels/${channelId}/messages`, { text }, maria);
  assert.equal((await say('First message of the day.')).status, 201);
  let feed = await feedOf(S, '/player/notifications', kola);
  const msg = feed.find((n) => n.type === 'message' && n.refId === channelId);
  assert.ok(msg, JSON.stringify(feed)); assert.equal(msg.repeatCount, 1); assert.equal(feed[0].id, msg.id, 'the newest insertion is first');
  const text = msg.text;
  // A later, different notification: a trial request.
  const trial = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'trial', message: 'Assessment day.', proposedDate: '2026-12-05' }, maria);
  assert.equal(trial.status, 201, trial.text);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await say('Second message — the same sentence for the recipient.')).status, 201);
  feed = await feedOf(S, '/player/notifications', kola);
  const again = feed.find((n) => n.id === msg.id);
  assert.equal(again.repeatCount, 2, 'coalesced, not duplicated'); assert.ok(again.ts > msg.ts, 'the clock was refreshed');
  assert.equal(feed.filter((n) => n.type === 'message' && n.refId === channelId).length, 1, 'exactly one message row');
  assert.equal(feed[0].type, 'request', 'the trial request, inserted later, is still first'); assert.equal(feed[1].id, msg.id, 'the refreshed row did not move');
  assert.ok(feed[1].ts > feed[0].ts, 'although its clock is now the newest: the order is insertion, never occurred_at');
  const orderBefore = feed.map((n) => n.id);
  if (live(dir)) {
    assert.deepEqual(qAll(dir, 'SELECT id FROM notifications WHERE audience_kind = ? AND audience_id = ? ORDER BY seq DESC', 'player', 'pl-adeyemi').map((r) => r.id), orderBefore, 'the table holds the feed in its durable order (second connection)');
    assert.equal(q1(dir, 'SELECT repeat_count AS n FROM notifications WHERE id = ?', msg.id).n, 2, 'the coalesce is durable with the message it announces (postMessage saves at once)');
    // S7d: the message is a row of the messages table after the 0012 cutover; before it, an entry of the channels blob — the same file either way.
    const channelsCut = !!q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0012_channels'");
    const storedMessages = channelsCut ? qAll(dir, 'SELECT text FROM messages WHERE channel_id = ? ORDER BY position', channelId).map((r) => r.text).join('\n') : q1(dir, "SELECT value FROM collections WHERE name = 'channels'").value;
    assert.ok(storedMessages.includes('Second message'), 'the message is in the same file (the messages table since S7d; the channels blob before)');
  }
  // SIGKILL: the order and the counts are what the file holds.
  await S.kill(); S = await boot(dir);
  assert.deepEqual((await feedOf(S, '/player/notifications', kola)).map((n) => n.id), orderBefore, 'the order survived a SIGKILL');
  // Plant an identical unread row older than the window at the END of the feed: it is never coalesced and it stops the scan.
  await S.stop();
  const now = Date.now();
  const planted = (id, ts) => ({ id, ts, audience: { kind: 'player', id: 'pl-adeyemi' }, type: 'message', text, refId: channelId, read: false, repeatCount: 1, groupKey: `message:${channelId}`, category: 'messages', deferredPush: false });
  plant(dir, [planted('ntf-planted-old', now - 6 * HOUR - 2 * MIN)]);
  S = await boot(dir);
  assert.equal((await say('Third message.')).status, 201);
  feed = await feedOf(S, '/player/notifications', kola);
  assert.equal(feed.find((n) => n.id === 'ntf-planted-old').repeatCount, 1, 'the row older than six hours is not coalesced');
  assert.equal(feed.find((n) => n.id === msg.id).repeatCount, 2, 'the recent identical unread row behind it was never examined (the scan stopped)');
  const created = feed.filter((n) => n.type === 'message' && n.refId === channelId);
  assert.equal(created.length, 3, 'so a NEW row was created'); assert.equal(feed[0].id, created.find((n) => !['ntf-planted-old', msg.id].includes(n.id)).id, 'and it is first');
  // Plant an identical unread row inside the window at the END: it is the one coalesced; the new row above stays at 1.
  await S.stop();
  plant(dir, [planted('ntf-planted-recent', now - 5 * HOUR)]);
  S = await boot(dir);
  assert.equal((await say('Fourth message.')).status, 201);
  feed = await feedOf(S, '/player/notifications', kola);
  assert.equal(feed.find((n) => n.id === 'ntf-planted-recent').repeatCount, 2, 'the last matching unread row coalesces');
  assert.equal(feed.filter((n) => n.type === 'message' && n.refId === channelId).length, 4, 'no fifth row');
  assert.equal(feed.filter((n) => n.repeatCount === 2).length, 2, 'only one row per coalesce; the earlier rows are untouched');
  assert.equal(feed[0].id, 'ntf-planted-recent', 'planted last, it is the newest insertion');
  // Reading, then a new occurrence: a new row (a read row never coalesces).
  assert.equal((await S.j('POST', '/player/notifications/read', {}, kola)).status, 200);
  assert.equal((await say('Fifth message.')).status, 201);
  feed = await feedOf(S, '/player/notifications', kola);
  assert.equal(feed.filter((n) => n.type === 'message' && n.refId === channelId).length, 5); assert.equal(feed[0].read, false); assert.equal(feed[1].read, true);
  if (live(dir)) assert.deepEqual(qAll(dir, 'SELECT id, read FROM notifications WHERE audience_kind = ? ORDER BY seq DESC LIMIT 2', 'player').map((r) => r.read), [0, 1], 'mark-read is durable');
  // The server log never carries a notification text in its data-layer lines.
  for (const line of S.log().split('\n').filter((l) => /notifications/i.test(l))) assert.equal(line.includes(text), false, `a log line carries notification text: ${line}`);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- acknowledgment: atomic with the dispatch blob
await test('acknowledgment: a withdrawal notice (notifyAction) lands with its contract and the sweep creates its dispatch rows; a failure of the real COMMIT during the ack is answered 500 and leaves BOTH the notification (table, second connection) and the dispatch statuses (blob) unchanged; the retry acknowledges both together; a SIGKILL right after keeps both; a second ack is a no-op', async () => {
  const dir = tempDir('s7a-ack'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const me = (await S.j('GET', '/player/me', undefined, kola)).body; const mediaId = me.media?.[0]?.id ?? me.player?.media?.[0]?.id; assert.ok(mediaId);
  const trn = await S.j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Looking for a new club', periodDays: 60 }, kola); assert.equal(trn.status, 201, trn.text);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/recipients`, { orgId: 'org-eastport', days: 30 }, kola)).status, 201);
  assert.equal((await S.j('POST', `/player/transitions/${trn.body.transition.id}/revoke-recipient`, { orgId: 'org-eastport' }, kola)).status, 200);
  let feed = await feedOf(S, '/org/notifications', maria);
  const notice = feed.find((n) => n.type === 'transition' && n.actionRequired); assert.ok(notice, JSON.stringify(feed));
  assert.deepEqual(notice.actionRequired, { deadline: notice.actionRequired.deadline, ackedAt: null, ackedBy: null }); assert.ok(notice.actionRequired.deadline > Date.now());
  assert.ok(live(dir), 'this proof reads the notifications table'); // fails on the pre-S7a build: the table does not exist
  assert.deepEqual(q1(dir, 'SELECT action_required AS a, action_acked_at AS at FROM notifications WHERE id = ?', notice.id), { a: 1, at: null });
  assert.ok((await S.j('POST', '/admin/delivery/sweep', {}, null, A)).status === 200);
  // S7b: the dispatch rows live in the dispatches table (the blob before the 0010 cutover); the ack coupling is what this test checks either way.
  const dispatches = () => (q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0010_dispatches'")
    ? qAll(dir, 'SELECT id, status, actioned_at AS actionedAt, channel FROM dispatches WHERE notification_id = ? ORDER BY seq', notice.id)
    : blobRows(dir, 'dispatches').filter((d) => d.notificationId === notice.id));
  assert.ok(dispatches().length >= 1, 'the sweep created dispatch rows for the notice'); assert.ok(dispatches().every((d) => d.status !== 'actioned' && !d.actionedAt));
  const statusesBefore = dispatches().map((d) => [d.id, d.status]);
  const ack = () => S.j('POST', `/org/notifications/${notice.id}/ack`, {}, maria);
  await refusedBy(S, COMMIT_SEAM, ack, async (label) => {
    assert.equal(q1(dir, 'SELECT action_acked_at AS at FROM notifications WHERE id = ?', notice.id).at, null, `${label}: the notification is not acknowledged`);
    assert.deepEqual(dispatches().map((d) => [d.id, d.status]), statusesBefore, `${label}: the dispatch statuses are unchanged`);
    feed = await feedOf(S, '/org/notifications', maria); assert.equal(feed.find((n) => n.id === notice.id).actionRequired.ackedAt, null, `${label}: memory restored`);
  });
  const ok = await ack();
  assert.equal(ok.status, 200, ok.text); assert.ok(ok.body.ackedAt);
  assert.equal(q1(dir, 'SELECT action_acked_at AS at, action_acked_by AS by FROM notifications WHERE id = ?', notice.id).at, ok.body.ackedAt, 'durable when the response is sent');
  // A skipped external row (no e-mail on record) keeps 'skipped' and gains actionedAt, exactly as before S7a (the ladder never moves a terminal side state).
  assert.ok(dispatches().every((d) => d.actionedAt && (d.status === 'actioned' || d.status === 'skipped')), `the dispatch rows moved to actioned in the same commit: ${JSON.stringify(dispatches().map((d) => [d.channel, d.status]))}`);
  assert.ok(dispatches().some((d) => d.status === 'actioned'), 'the in-app row is actioned');
  const second = await ack(); assert.equal(second.status, 200); assert.equal(second.body.ackedAt, ok.body.ackedAt, 'a second ack returns the first');
  await S.kill(); S = await boot(dir);
  feed = await feedOf(S, '/org/notifications', maria); assert.equal(feed.find((n) => n.id === notice.id).actionRequired.ackedAt, ok.body.ackedAt, 'the ack survived the SIGKILL');
  const admin = await S.j('GET', '/admin/delivery', undefined, null, A); assert.equal(admin.body.awaitingAck, 0); assert.ok(admin.body.recent.filter((d) => d.notificationId === notice.id).every((d) => d.actionedAt && (d.status === 'actioned' || d.status === 'skipped')));
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- preferences
await test('preferences through the real routes: a category turned off never creates a notification (and creates one again once it is on); a mandatory category sent as numeric zero is accepted and stored false (table, second connection) while the view and the gate keep it on; a literal false, an unknown category and a non-object are refused; emailIntent is stored; everything survives a restart; the preferences of one person never touch another', async () => {
  const dir = tempDir('s7a-prefs'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const { channelId } = await openThread(S, maria, kola);
  const say = (text) => S.j('POST', `/org/channels/${channelId}/messages`, { text }, maria);
  const put = (body, token = kola) => S.j('PUT', '/player/notification-preferences', body, token);
  const messageRows = async () => (await feedOf(S, '/player/notifications', kola)).filter((n) => n.type === 'message' && n.refId === channelId);
  const rows = async () => (await messageRows()).length;
  assert.equal((await say('One.')).status, 201); assert.equal(await rows(), 1);
  let r = await put({ categories: { messages: false, compliance: 0 }, emailIntent: 1 });
  assert.equal(r.status, 200, r.text);
  const compliance = r.body.preferences.categories.find((c) => c.id === 'compliance'); assert.deepEqual([compliance.enabled, compliance.mandatory], [true, true], 'the view forces the mandatory category on');
  assert.equal(r.body.preferences.categories.find((c) => c.id === 'messages').enabled, false); assert.equal(r.body.preferences.emailIntent, true);
  if (live(dir)) {
    const cats = () => qAll(dir, 'SELECT category, enabled FROM notification_pref_categories WHERE audience_kind = ? AND audience_id = ? ORDER BY category', 'player', 'pl-adeyemi').map((x) => [x.category, x.enabled]);
    assert.ok(await settled(() => cats().length === 2), 'the preference write landed with the debounced save');
    assert.deepEqual(cats(), [['compliance', 0], ['messages', 0]], 'stored as the route coerced it: false, the mandatory one included');
    assert.equal(q1(dir, 'SELECT email_intent AS e FROM notification_prefs WHERE audience_id = ?', 'pl-adeyemi').e, 1);
  } else {
    const stored = () => (blobRows(dir, 'notificationPrefs') ?? []).find((p) => p.audienceKind === 'player' && p.audienceId === 'pl-adeyemi');
    assert.ok(await settled(() => !!stored()), 'the preference write landed with the debounced save');
    assert.deepEqual(stored().categories, { messages: false, compliance: false });
  }
  r = await put({ categories: { compliance: false } }); assert.equal(r.status, 400); assert.equal(r.body.error, 'PREF_CATEGORY_MANDATORY');
  r = await put({ categories: { gossip: true } }); assert.equal(r.status, 400); assert.equal(r.body.error, 'PREF_CATEGORY_UNKNOWN');
  r = await put({ categories: 'all' }); assert.equal(r.status, 400); assert.equal(r.body.error, 'PREFS_INVALID');
  // Muted: no row is created, not created-and-hidden.
  const before = Date.now();
  assert.equal((await say('Two, while muted.')).status, 201);
  assert.equal(await rows(), 1, 'no notification was created for a muted category');
  if (live(dir)) assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM notifications WHERE audience_id = ? AND occurred_at >= ?', 'pl-adeyemi', before).n, 0, 'nor in the table');
  const cap = await S.j('GET', '/capabilities'); assert.ok(Number(/"suppressedByPreference":(\d+)/.exec(cap.text)?.[1]) >= 1, `counted as suppressed: ${cap.text.slice(0, 200)}`);
  // Restart: the preferences and the mute hold.
  await S.kill(); S = await boot(dir);
  r = await S.j('GET', '/player/notification-preferences', undefined, kola);
  assert.equal(r.body.preferences.categories.find((c) => c.id === 'messages').enabled, false); assert.equal(r.body.preferences.categories.find((c) => c.id === 'compliance').enabled, true); assert.equal(r.body.preferences.emailIntent, true);
  assert.equal((await say('Three, still muted.')).status, 201); assert.equal(await rows(), 1);
  // Isolation: Maria's own preferences are untouched, and turning messages back on creates rows again.
  const mariaPrefs = await S.j('GET', '/org/notification-preferences', undefined, maria); assert.equal(mariaPrefs.body.preferences.categories.find((c) => c.id === 'messages').enabled, true);
  assert.equal((await put({ categories: { messages: true } })).status, 200);
  assert.equal((await say('Four, unmuted.')).status, 201);
  const after = await messageRows();
  assert.equal(after.length, 1, 'the identical unread row from before the mute coalesces again (the mute suppressed creation, it did not read or remove anything)'); assert.equal(after[0].repeatCount, 2);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- deletion
await test('account deletion: the person\'s notification rows go inside the deletion unit (table, second connection) and everyone else\'s stay; the person\'s preferences are retained (no cascade, by decision); a failure of the real COMMIT keeps the rows and the player', async () => {
  const dir = tempDir('s7a-delete'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const { channelId } = await openThread(S, maria, kola);
  assert.equal((await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'Hello.' }, maria)).status, 201);
  assert.equal((await S.j('PUT', '/player/notification-preferences', { categories: { combine: false } }, kola)).status, 200);
  assert.ok(live(dir), 'this proof reads the notifications table');
  const mine = () => q1(dir, 'SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = ? AND audience_id = ?', 'player', 'pl-adeyemi').n;
  const others = () => q1(dir, 'SELECT COUNT(*) AS n FROM notifications WHERE NOT (audience_kind = ? AND audience_id = ?)', 'player', 'pl-adeyemi').n;
  assert.ok(mine() >= 2); const othersBefore = others(); assert.ok(othersBefore >= 1, 'Maria has rows too');
  const del = () => S.j('DELETE', '/player/account', undefined, kola);
  await refusedBy(S, COMMIT_SEAM, del, async (label) => {
    assert.ok(mine() >= 2, `${label}: the rows are retained`); assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', 'pl-adeyemi').n, 1, `${label}: the player is retained`);
  });
  assert.equal((await del()).status, 200);
  assert.equal(mine(), 0); assert.equal(others(), othersBefore, 'nobody else lost a row'); assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', 'pl-adeyemi').n, 0);
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM notification_pref_categories WHERE audience_id = ?', 'pl-adeyemi').n, 1, 'the preferences are retained');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- backup and restore; the old-build rollback proof
await test('backup/restore: the admin backup exports the notifications and preferences in the legacy shape and order (a backup restores on any build); a restore into a NEW directory imports them (migration 0009) with the same feed, repeat counts and acknowledgment contracts; a backup whose notification entry is malformed is refused at boot (NOTIFICATIONS_IMPORT_BLOCKED), creates no table and is refused again; with SCOUTBOX_PRE_S7A_SERVER set, the copy-only rollback of the live directory boots on the pre-S7a build with the same feed and preferences, and that build can still write to it', async () => {
  const dir = tempDir('s7a-backup'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const { channelId } = await openThread(S, maria, kola);
  for (const t of ['One.', 'Two.']) assert.equal((await S.j('POST', `/org/channels/${channelId}/messages`, { text: t }, maria)).status, 201);
  assert.equal((await S.j('PUT', '/org/notification-preferences', { categories: { mentions: false, compliance: 0 }, emailIntent: true }, maria)).status, 200);
  const playerFeed = await feedOf(S, '/player/notifications', kola); const orgFeed = await feedOf(S, '/org/notifications', maria);
  assert.ok(playerFeed.some((n) => n.repeatCount === 2));
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  await S.stop();
  const jsonText = fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'); const snapshot = JSON.parse(jsonText);
  assert.ok(Array.isArray(snapshot.db.notifications) && Array.isArray(snapshot.db.notificationPrefs), 'both collections are in the backup');
  assert.deepEqual(snapshot.db.notifications.map((n) => n.id), stored(dir).map((n) => n.id), 'in the stored order');
  const exported = snapshot.db.notifications.find((n) => n.id === playerFeed[0].id);
  assert.deepEqual(Object.keys(exported).sort(), ['audience', 'category', 'deferredPush', 'groupKey', 'id', 'read', 'refId', 'repeatCount', 'text', 'ts', 'type'], 'the legacy shape, nothing more');
  const mariaPrefs = snapshot.db.notificationPrefs.find((p) => p.audienceKind === 'org_user'); assert.deepEqual(mariaPrefs.categories, { mentions: false, compliance: false }); assert.equal(mariaPrefs.emailIntent, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'manifest.json'), 'utf8')).counts.notifications, snapshot.db.notifications.length);
  // Restore.
  const restored = tempDir('s7a-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.ok(live(restored)); assert.deepEqual(stored(restored).map((n) => n.id), snapshot.db.notifications.map((n) => n.id), 'imported in order');
  assert.deepEqual(sameFeed(await feedOf(S, '/player/notifications', kola)), sameFeed(playerFeed), 'the player feed is identical (the session travelled too)');
  assert.deepEqual(sameFeed(await feedOf(S, '/org/notifications', maria)), sameFeed(orgFeed));
  const prefs = await S.j('GET', '/org/notification-preferences', undefined, maria); assert.equal(prefs.body.preferences.categories.find((c) => c.id === 'mentions').enabled, false); assert.equal(prefs.body.preferences.categories.find((c) => c.id === 'compliance').enabled, true);
  assert.equal(q1(restored, "SELECT COUNT(*) AS n FROM collections WHERE name IN ('notifications', 'notificationPrefs')").n, 0, 'no blob left behind');
  await S.stop();
  // Malformed entry: refused whole, nothing created, refused again.
  const bad = tempDir('s7a-badbk'); fs.cpSync(bk.body.dir, bad, { recursive: true });
  const b = JSON.parse(jsonText); b.db.notifications[0].ts = 'yesterday'; fs.writeFileSync(path.join(bad, 'db.json'), JSON.stringify(b));
  const r1 = await bootRefuses(bad); assert.notEqual(r1.code, 0); assert.match(r1.log, /NOTIFICATIONS_IMPORT_BLOCKED.*ts must be/);
  assert.equal(r1.log.includes(b.db.notifications[0].text), false, 'the refusal carries no notification text');
  assert.equal(q1(bad, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'notifications'").n, 0, 'no table created');
  const r2 = await bootRefuses(bad); assert.match(r2.log, /NOTIFICATIONS_IMPORT_BLOCKED/, 'refused again on the next boot');
  // The old build on the rollback copy (when its server.mjs is given).
  const OLD = process.env.SCOUTBOX_PRE_S7A_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    const copy = path.join(tempDir('s7a-rb'), 'copy'); const s7aCopy = path.join(tempDir('s7a-rb-s7b'), 'copy'); const s7bCopy = path.join(tempDir('s7a-rb-s7c'), 'copy'); const s7cCopy = path.join(tempDir('s7a-rb-s7d'), 'copy');
    execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), dir, s7cCopy], { encoding: 'utf8' }); // S7d: the file carries 0012; its rollback goes first,
    execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), s7cCopy, s7bCopy], { encoding: 'utf8' }); // then S7c (0011),
    execFileSync(process.execPath, [path.join(HERE, 'dispatchesRollback.mjs'), s7bCopy, s7aCopy], { encoding: 'utf8' }); // then S7b (0010),
    const out = execFileSync(process.execPath, [path.join(HERE, 'notificationsRollback.mjs'), s7aCopy, copy], { encoding: 'utf8' });
    assert.match(out, /written back as blobs/);
    const old = await boot(copy, {}, OLD);
    assert.ok(!/0009_notifications/.test(old.log()), 'the pre-S7a build knows nothing of 0009');
    assert.deepEqual(sameFeed(await feedOf(old, '/player/notifications', kola)), sameFeed(playerFeed), 'the pre-S7a build reads the same player feed from the reconstructed blob');
    assert.deepEqual(sameFeed(await feedOf(old, '/org/notifications', maria)), sameFeed(orgFeed));
    const op = await old.j('GET', '/org/notification-preferences', undefined, maria); assert.equal(op.body.preferences.categories.find((c) => c.id === 'mentions').enabled, false); assert.equal(op.body.preferences.categories.find((c) => c.id === 'compliance').enabled, true, 'a stored mandatory false is forced on there too');
    assert.equal((await old.j('POST', `/org/channels/${channelId}/messages`, { text: 'Written by the pre-S7a build.' }, maria)).status, 201, 'the old build still writes');
    const oldFeed = await feedOf(old, '/player/notifications', kola); assert.equal(oldFeed.find((n) => n.type === 'message').repeatCount, 3, 'and coalesces into the reconstructed row');
    await old.stop();
    assert.equal(live(copy), false); assert.equal(blobRows(copy, 'notifications').length, playerFeed.length + orgFeed.length, 'the old build saved the blob');
    console.log('    (pre-S7a build booted the rollback copy: feeds and preferences identical, writes accepted)');
    rm(path.dirname(copy));
  } else {
    console.log('    (SCOUTBOX_PRE_S7A_SERVER not set: the pre-S7a boot of the rollback copy was not exercised here)');
  }
  rm(dir, restored, bad);
});

// ------------------------------------------------------------- review of ba6956d, finding 1: effects after the durable save, through the real server
/**
 * An SSE stream for one session: the frames it received (each with the `id:` the
 * server stamped on it, when it stamped one), and a close. With `lastEventId` the
 * connection carries a real `Last-Event-ID` cursor, so the server's catch-up
 * branch runs (server.mjs GET /events: replay for lastId > 0, then `caught_up`);
 * the helper then WAITS for the `caught_up` (or `resync`) frame before it returns,
 * so what the caller reads is the replay's actual result. Without a cursor the
 * server replays nothing — a fresh connection proves nothing about the replay log.
 */
async function openSse(S, token, { lastEventId = null } = {}) {
  const t = await S.j('POST', '/events/ticket', {}, token); assert.equal(t.status, 200, t.text);
  const ctl = new AbortController();
  const frames = [];
  const headers = lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {};
  const res = await fetch(`http://127.0.0.1:${S.port}/events?ticket=${t.body.ticket}`, { signal: ctl.signal, headers });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const lines = chunk.split('\n'); const data = lines.find((l) => l.startsWith('data: ')); const idLine = lines.find((l) => l.startsWith('id: ')); if (data) { try { frames.push({ ...JSON.parse(data.slice(6)), sseId: idLine ? Number(idLine.slice(4)) : null }); } catch { /* ping */ } } } } } catch { /* closed */ } })();
  const settled = (f) => f.event === (lastEventId !== null ? 'caught_up' : 'connected') || f.event === 'resync';
  for (let i = 0; i < 150 && !frames.some(settled); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(frames.some(settled), lastEventId !== null ? `the catch-up for Last-Event-ID ${lastEventId} must end with caught_up (or resync); got ${JSON.stringify(frames.map((f) => f.event))}` : 'the stream must open');
  const notifyFrames = () => frames.filter((f) => f.event === 'notify');
  return { frames, notifyFrames, lastId: () => Math.max(0, ...frames.map((f) => f.sseId ?? 0)), caughtUp: () => frames.some((f) => f.event === 'caught_up'), resync: () => frames.some((f) => f.event === 'resync'), close: () => ctl.abort() };
}

await test('review of ba6956d, finding 1 — through the real server: a message whose snapshot save fails at the REAL COMMIT (development seam internal:save.sqlite_commit) delivers NO push (admin push log), NO notify SSE frame and NO replay-log entry (a reconnect with a real Last-Event-ID cursor catches up to nothing new, while the same cursor mechanism does replay an earlier committed notify event — the positive control), and leaves no notification row; the next successful save (a second write) commits the pending notification and delivers its push and its SSE frame exactly once, and a cursor reconnect now replays exactly that event; a coalescing repeat delivers one SSE frame and no second push', async () => {
  const dir = tempDir('s7a-rv-effects'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const { channelId } = await openThread(S, maria, kola);
  const sse = await openSse(S, kola);
  const pushes = async () => (await S.j('GET', '/admin/push-log', undefined, null, A)).body.filter((p) => p.audience?.kind === 'player' && p.audience.id === 'pl-adeyemi' && /sent a message/.test(p.body ?? ''));
  const rows = () => q1(dir, 'SELECT COUNT(*) AS n FROM notifications WHERE audience_id = ? AND type = ?', 'pl-adeyemi', 'message').n;
  const settle = async (ok) => { for (let i = 0; i < 150 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 20)); };
  assert.equal((await pushes()).length, 0); assert.equal(sse.notifyFrames().length, 0);
  // 1. A committed notification first (no fault): the positive control for the replay log.
  //    Its notify frame carries the event id the catch-up checks are anchored on.
  assert.equal((await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'Zero — a committed message before the fault.' }, maria)).status, 201);
  await settle(async () => sse.notifyFrames().length === 1 && rows() === 1 && (await pushes()).length === 1);
  assert.equal(rows(), 1); assert.equal((await pushes()).length, 1); assert.equal(sse.notifyFrames().length, 1);
  const n0 = sse.notifyFrames()[0].sseId; assert.ok(Number.isInteger(n0) && n0 >= 2, `the committed notify frame carries a replayable event id (got ${n0})`);
  const control = await openSse(S, kola, { lastEventId: n0 - 1 });
  assert.ok(control.caughtUp(), 'the cursor branch ran'); assert.deepEqual(control.notifyFrames().map((f) => f.sseId), [n0], 'positive control: a committed notify event the client missed IS replayed from the log'); control.close();
  // The recipient reads the feed, so the next identical sentence is a NEW row (and a new push), not a coalesce.
  assert.equal((await S.j('POST', '/player/notifications/read', {}, kola)).status, 200);
  await settle(async () => q1(dir, 'SELECT read AS r FROM notifications WHERE audience_id = ? AND type = ?', 'pl-adeyemi', 'message')?.r === 1);
  // 2. The save that carries the next message and its notification fails at COMMIT.
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  const logBefore = S.log().length;
  const first = await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'First, under a failing save.' }, maria);
  assert.equal(first.status, 201, first.text);
  for (let i = 0; i < 100 && !/snapshot save failed/.test(S.log().slice(logBefore)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(S.log().slice(logBefore), /snapshot save failed: FOREIGN KEY constraint failed/, 'the save really failed at COMMIT');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(rows(), 1, 'no second notification row (the save rolled back)');
  assert.equal((await pushes()).length, 1, 'no push before the durable save'); assert.equal(sse.notifyFrames().length, 1, 'no SSE notify frame before the durable save');
  const replay = await openSse(S, kola, { lastEventId: n0 }); // a real catch-up from the committed frame: the replay log holds no notify entry after it
  assert.ok(replay.caughtUp(), 'the cursor branch ran (caught_up received)'); assert.equal(replay.notifyFrames().length, 0, 'no replay-log entry for the uncommitted notification'); replay.close();
  const feed = await feedOf(S, '/player/notifications', kola); assert.equal(feed.filter((n) => n.type === 'message').length, 2, 'the feed (memory) shows the pending notification, as every unsaved blob edit shows');
  // 3. A second write saves successfully: the pending notification commits and its effects run once.
  assert.equal((await S.j('POST', `/org/channels/${channelId}/read`, {}, maria)).status, 200);
  await settle(async () => rows() === 2);
  assert.equal(rows(), 2, 'the retry committed the notification with the read receipt');
  await settle(async () => sse.notifyFrames().length === 2);
  assert.equal((await pushes()).length, 2, 'exactly one more push, after the commit'); assert.equal(sse.notifyFrames().length, 2, 'exactly one more SSE notify frame, after the commit');
  const n1 = sse.notifyFrames()[1].sseId; assert.ok(n1 > n0);
  const after = await openSse(S, kola, { lastEventId: n0 });
  assert.ok(after.caughtUp()); assert.deepEqual(after.notifyFrames().map((f) => f.sseId), [n1], 'the committed notification now replays from the log — exactly once, with the id the live stream saw'); after.close();
  // 4. A coalescing repeat: one more SSE frame, no second push.
  assert.equal((await S.j('POST', `/org/channels/${channelId}/messages`, { text: 'Second — the same sentence for the recipient.' }, maria)).status, 201);
  await settle(async () => sse.notifyFrames().length >= 3);
  assert.equal(sse.notifyFrames().length, 3); assert.equal((await pushes()).length, 2, 'no second push for a coalesced notification'); assert.equal(rows(), 2);
  assert.equal(q1(dir, 'SELECT repeat_count AS n FROM notifications WHERE audience_id = ? AND type = ? AND read = 0', 'pl-adeyemi', 'message').n, 2);
  sse.close();
  await S.stop(); rm(dir);
});

console.log(`\n${passed} notification server checks passed`);
