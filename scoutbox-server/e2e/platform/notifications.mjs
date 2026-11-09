// The notification feed and preferences, against a real server on a temporary data directory with the synthetic seed.
//
//   A the feed: a notice reaches the person it is for, newest first, each row an allowlist with its resolved target
//   B coalescing: the same unread sentence about the same thread is one row counted twice, no second push; once read,
//     a new occurrence is a new row
//   C mark-read: one person's feed only
//   D acknowledgment: an action notice is acknowledged once; another person's notice is not found
//   E preferences: non-boolean values, unknown categories and turning off the mandatory category are refused, nothing
//     stored; a muted category creates no notice
//   F a unit that fails at its real COMMIT leaves no message, no notification and no push; the retry delivers once
//   G the delivery centre makes a notice's dispatches exactly once, however often it sweeps
//   H a notice whose text would be too long is shortened, never refused
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-notifications-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };

let passed = 0; let negatives = 0;
let child = null;
function cleanup() { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } fs.rmSync(DATA, { recursive: true, force: true }); }
process.on('exit', cleanup);
const ok = (cond, name) => { if (!cond) { console.error(`✗ ${name}`); cleanup(); process.exit(1); } passed++; console.log(`✓ ${name}`); };
const neg = (cond, name) => { negatives++; ok(cond, `[neg] ${name}`); };
const section = (name) => console.log(`\n— ${name} —`);
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const login = async (route, body) => { const r = await j('POST', route, body); ok(r.status === 200, `login ${route} ${JSON.stringify(body)}`); return r.body.token; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = async (p) => (await j('GET', p, undefined, null, ADMIN)).body;
const feed = async (who, token) => (await j('GET', `/${who}/notifications`, undefined, token)).body;

child = spawn('node', ['server.mjs'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, M13_QUIET_LOGS: '1' }, stdio: 'ignore' });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* booting */ }
  if (i > 80) throw new Error('server did not boot');
  await sleep(250);
}

const maria = await login('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' });
const kola = await login('/auth/player/login', { playerId: 'pl-adeyemi' });
const amara = await login('/auth/guardian/login', { guardianId: 'gd-amara' });

section('A — the feed');
const req = await j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic contact request.' }, maria);
ok(req.status === 201, 'the club asks the adult player for a conversation');
let kFeed = await feed('player', kola);
const notice = kFeed.find((n) => n.refId === req.body.requestId);
ok(!!notice && notice.read === false && notice.repeatCount === 1, 'the player is notified, unread');
ok(JSON.stringify(Object.keys(notice).sort()) === JSON.stringify(['audience', 'category', 'deferredPush', 'groupKey', 'id', 'read', 'refId', 'repeatCount', 'target', 'text', 'ts', 'type']), `the row is an allowlist with its resolved target: ${Object.keys(notice).join(', ')}`);
neg(!Object.hasOwn(notice, 'dispatchedAt'), 'the delivery centre\'s marker is not in the response');
ok(notice.groupKey === `${notice.type}:${notice.refId}`, 'the group key is type and refId');
neg(!(await feed('guardian', amara)).some((n) => n.id === notice.id), 'another person never sees it');
ok((await j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status === 200, 'the player accepts');
const channelId = (await j('GET', '/player/channels', undefined, kola)).body.find((c) => c.requestId === req.body.requestId)?.id;
ok(!!channelId, 'the thread is open');

section('B — coalescing');
const say = (text) => j('POST', `/org/channels/${channelId}/messages`, { text }, maria);
const pushes = async () => (await admin('/admin/push-log')).items.filter((p) => p.audience?.kind === 'player' && p.audience.id === 'pl-adeyemi' && /replied|sent a message/.test(p.body ?? '')).length;
ok((await say('First synthetic message.')).status === 201, 'the club writes');
kFeed = await feed('player', kola);
const msgRows = () => kFeed.filter((n) => n.type === 'message' && n.refId === channelId);
ok(msgRows().length === 1 && kFeed[0].id === msgRows()[0].id, 'one message notice, newest first');
const pushesAfterFirst = await pushes();
ok((await say('Second synthetic message.')).status === 201, 'the club writes again');
kFeed = await feed('player', kola);
ok(msgRows().length === 1 && msgRows()[0].repeatCount === 2, 'the same unread sentence is one row, counted twice');
neg((await pushes()) === pushesAfterFirst, 'and no second push');

section('C — mark-read');
const amaraUnreadBefore = (await feed('guardian', amara)).filter((n) => !n.read).length;
ok((await j('POST', '/player/notifications/read', {}, kola)).status === 200, 'the player marks the feed read');
kFeed = await feed('player', kola);
ok(kFeed.every((n) => n.read), 'every row of the player\'s feed is read');
neg((await feed('guardian', amara)).filter((n) => !n.read).length === amaraUnreadBefore, 'another person\'s feed is untouched');
ok((await say('Third synthetic message.')).status === 201, 'the club writes after the read');
kFeed = await feed('player', kola);
ok(msgRows().length === 2 && msgRows()[0].read === false && msgRows()[0].repeatCount === 1, 'a new occurrence after a read is a new row');

section('D — acknowledgment');
const me = (await j('GET', '/player/me', undefined, kola)).body; const mediaId = me.media?.[0]?.id ?? me.player?.media?.[0]?.id;
const trn = await j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Synthetic transition', periodDays: 60 }, kola);
ok(trn.status === 201, 'the player opens a transition pack');
ok((await j('POST', `/player/transitions/${trn.body.transition.id}/recipients`, { orgId: 'org-eastport', days: 30 }, kola)).status === 201, 'shares it with the club');
ok((await j('POST', `/player/transitions/${trn.body.transition.id}/revoke-recipient`, { orgId: 'org-eastport' }, kola)).status === 200, 'and withdraws it');
const action = (await feed('org', maria)).find((n) => n.type === 'transition' && n.actionRequired);
ok(!!action && action.actionRequired.ackedAt === null && action.actionRequired.ackedBy === null, 'the club gets an action notice, not yet acknowledged');
const awaiting = (await admin('/admin/delivery')).awaitingAck;
ok(awaiting >= 1, 'counted as awaiting acknowledgment');
neg((await j('POST', `/player/notifications/${action.id}/ack`, {}, kola)).status === 404, 'another person cannot acknowledge it (404)');
neg((await j('POST', `/player/notifications/${msgRows()[0].id}/ack`, {}, kola)).body?.error === 'NO_ACTION_REQUIRED', 'a notice without an action cannot be acknowledged');
const ack = await j('POST', `/org/notifications/${action.id}/ack`, {}, maria);
ok(ack.status === 200 && Number.isInteger(ack.body.ackedAt), 'the club acknowledges it');
const again = await j('POST', `/org/notifications/${action.id}/ack`, {}, maria);
ok(again.status === 200 && again.body.ackedAt === ack.body.ackedAt, 'a second acknowledgment returns the first');
const acked = (await feed('org', maria)).find((n) => n.id === action.id);
ok(acked.actionRequired.ackedAt === ack.body.ackedAt && acked.actionRequired.ackedBy === acked.audience.id, 'the feed shows who acknowledged it and when');
ok((await admin('/admin/delivery')).awaitingAck === awaiting - 1, 'no longer awaiting');

section('E — preferences');
const put = (body) => j('PUT', '/player/notification-preferences', body, kola);
for (const [body, code, label] of [
  [{ categories: { messages: 'no' } }, 'PREFS_INVALID', 'a text value'],
  [{ categories: { messages: 0 } }, 'PREFS_INVALID', 'a numeric value'],
  [{ categories: { security_account: 0 } }, 'PREFS_INVALID', 'numeric zero on the mandatory category'],
  [{ emailIntent: 'yes' }, 'PREFS_INVALID', 'a text emailIntent'],
  [{ categories: { security_account: false } }, 'PREF_CATEGORY_MANDATORY', 'turning off the mandatory category'],
  [{ categories: { gossip: true } }, 'PREF_CATEGORY_UNKNOWN', 'an unknown category'],
  [{ categories: ['messages'] }, 'PREFS_INVALID', 'a list'],
]) { const r = await put(body); neg(r.status === 400 && r.body?.error === code, `${label} is refused (400 ${code})`); }
let prefs = (await j('GET', '/player/notification-preferences', undefined, kola)).body.preferences;
neg(prefs.categories.find((c) => c.id === 'messages').enabled === true && prefs.emailIntent === false, 'nothing was stored');
ok((await put({ categories: { messages: false }, emailIntent: true })).status === 200, 'messages turned off, e-mail wanted');
prefs = (await j('GET', '/player/notification-preferences', undefined, kola)).body.preferences;
ok(prefs.categories.find((c) => c.id === 'messages').enabled === false && prefs.emailIntent === true && prefs.categories.find((c) => c.id === 'security_account').enabled === true, 'stored; the mandatory category stays on');
const before = msgRows().length;
ok((await say('A message while muted.')).status === 201, 'the club writes while messages are muted');
kFeed = await feed('player', kola);
neg(msgRows().length === before && msgRows()[0].repeatCount === 1, 'no notice was created or counted');
ok((await put({ categories: { messages: true } })).status === 200, 'messages back on');

section('F — a failed unit leaves no notice and sends no push');
await j('POST', '/player/notifications/read', {}, kola);
const pushesBefore = await pushes(); const rowsBefore = (await feed('player', kola)).length;
ok((await j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit:1' })).status === 200, 'the next unit\'s COMMIT will fail');
const failed = await say('A message whose unit fails.');
neg(failed.status === 500, 'the message is answered 500');
neg((await feed('player', kola)).length === rowsBefore, 'no notification row');
await sleep(200);
neg((await pushes()) === pushesBefore, 'no push');
ok((await j('POST', '/__faults', { rules: '' })).status === 200, 'the fault is cleared');
ok((await say('The retried message.')).status === 201, 'the retry is accepted');
kFeed = await feed('player', kola);
ok(kFeed.length === rowsBefore + 1 && kFeed[0].type === 'message' && kFeed[0].read === false, 'exactly one new notice');
await sleep(200);
ok((await pushes()) === pushesBefore + 1, 'and exactly one push');

section('G — the delivery centre makes a notice\'s dispatches once');
const newest = kFeed[0];
for (let i = 0; i < 3; i++) ok((await j('POST', '/admin/delivery/sweep', {}, null, ADMIN)).status === 200, `sweep ${i + 1}`);
const rows = (await admin('/admin/delivery')).recent.filter((d) => d.notificationId === newest.id);
ok(rows.filter((d) => d.channel === 'in_app').length === 1 && rows.filter((d) => d.channel === 'email').length === 1, `one in-app and one e-mail dispatch, whatever the sweeps: ${rows.map((d) => d.channel).join(', ')}`);
ok((await j('POST', '/player/notifications/read', {}, kola)).status === 200 && (await j('POST', '/admin/delivery/sweep', {}, null, ADMIN)).status === 200, 'the player reads the feed and the centre sweeps');
ok((await admin('/admin/delivery')).recent.find((d) => d.notificationId === newest.id && d.channel === 'in_app')?.status === 'opened', 'the in-app record is opened once the notice is read');

section('H — an over-long notice is shortened, never refused');
const rep = await j('POST', '/guardian/report', { targetKind: 'club', targetOrgId: 'org-harbour', reason: 'Synthetic report for the long outcome.' }, amara);
ok(rep.status === 201, 'the guardian reports a club');
const outcome = `Synthetic outcome ${'x'.repeat(1970)}`;
ok((await j('POST', `/admin/reports/${rep.body.reportId}/resolve`, { outcome, action: 'dismiss' }, null, ADMIN)).status === 200, 'the report is resolved with a 1,988-character outcome');
const resolved = (await feed('guardian', amara)).find((n) => n.type === 'report_resolved' && n.refId === rep.body.reportId);
ok(!!resolved && resolved.text.length === 2000 && resolved.text.endsWith('…') && resolved.text.startsWith('Your report was reviewed: Synthetic outcome'), `the reporter is told, the text shortened to 2,000 characters (${resolved?.text.length})`);

console.log(`\n${passed} notification checks passed (${negatives} negative)`);
process.exit(0);
