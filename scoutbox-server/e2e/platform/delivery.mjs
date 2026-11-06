// The delivery centre, the mail outbox and push (S14d: the dispatches and outbox/push repositories' explicit writes
// and SQL reads), against a real server on a temporary data directory with the synthetic seed and the fast retry
// ladder.
//
//   A a notice gets an in-app record (delivered at once) and an e-mail dispatch the local fake provider accepts —
//     never reported as delivered or read until the provider says so; the delivery record is in the outbox
//   B a staff member's e-mail whose retries run out ends failed, counted as a delivery failure, and the club's
//     webhook receives delivery.failed
//   C provider callbacks: signed, idempotent, out-of-order safe, forward-only; junk is refused whole with 400 naming
//     the field, nothing of the batch applied
//   D the club's delivery list pages by cursor and holds only its own staff's dispatches
//   E device tokens: a player's and a guardian's register; a token another account registers moves to it; staff and
//     junk are refused
//   F the admin outbox and push log page by cursor, newest first; junk paging is refused
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../scripts/testPort.mjs';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = await freePort();
const RCV_PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-delivery-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };
const CALLBACK_SECRET = 'local-fake-callback-secret';

let passed = 0; let negatives = 0;
let child = null; let receiver = null;
function cleanup() { if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } receiver?.close(); fs.rmSync(DATA, { recursive: true, force: true }); }
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
const until = async (check, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
const admin = async (p) => (await j('GET', p, undefined, null, ADMIN)).body;
const sweep = () => j('POST', '/admin/delivery/sweep', {}, null, ADMIN);
const callback = (events) => {
  const body = JSON.stringify({ provider: 'local-fake', events }); const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', CALLBACK_SECRET).update(`callback.${ts}.${body}`).digest('hex');
  return j('POST', '/callbacks/delivery', JSON.parse(body), null, { 'x-provider-timestamp': ts, 'x-provider-signature': sig });
};

const hooks = [];
receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { hooks.push(JSON.parse(b)); } catch { /* not JSON */ } res.writeHead(200); res.end('ok'); }); });
await new Promise((r) => receiver.listen(RCV_PORT, '127.0.0.1', r));

child = spawn('node', ['server.mjs'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, M13_FAST_RETRY: '1', M13_QUIET_LOGS: '1', ALLOW_LOCAL_WEBHOOKS: '1' }, stdio: 'ignore' });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${API}/health`)).ok) break; } catch { /* booting */ }
  if (i > 80) throw new Error('server did not boot');
  await sleep(250);
}

const maria = await login('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' });
const harbour = await login('/auth/org/login', { orgId: 'org-harbour', scoutName: 'Harbour Scout', role: 'Head of Recruitment' });
const kola = await login('/auth/player/login', { playerId: 'pl-adeyemi' });
const amara = await login('/auth/guardian/login', { guardianId: 'gd-amara' });

section('A — a notice: in-app at once, the e-mail accepted by the provider');
const req = await j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic contact request about the under-18 player.' }, maria);
ok(req.status === 201, 'the club asks for a conversation about an under-18 player');
const notice = await until(async () => (await j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.refId === req.body.requestId));
ok(!!notice, 'the guardian is notified');
const mine = async () => (await admin('/admin/delivery')).recent.filter((d) => d.notificationId === notice.id);
const accepted = await until(async () => { await sweep(); const rows = await mine(); return rows.find((d) => d.channel === 'email' && d.status === 'accepted') ? rows : null; });
ok(!!accepted, 'the e-mail dispatch is accepted by the provider');
const inApp = accepted.find((d) => d.channel === 'in_app'); const email = accepted.find((d) => d.channel === 'email');
ok(inApp.status === 'delivered' && inApp.deliveredAt, 'the in-app record is delivered at once');
neg(email.deliveredAt === null && email.openedAt === null, 'accepted is never reported as delivered or read');
ok(email.to === 'amara.adebayo@example.com' && email.providerMessageId?.startsWith('fm_') && email.attempts.length === 1, 'sent to the guardian, with the provider\'s message id and one attempt');
const outbox = (await admin('/admin/outbox')).items;
ok(outbox.some((m) => m.providerMessageId === email.providerMessageId && m.provider === 'local-fake' && m.to === email.to), 'the provider\'s record is in the outbox');

section('B — retries run out: failed, counted, and the club\'s webhook told');
ok((await j('POST', '/org/webhooks', { url: `http://127.0.0.1:${RCV_PORT}/hook`, events: ['delivery.failed'] }, maria)).status === 201, 'the club subscribes a webhook to delivery.failed');
const inv = await j('POST', '/org/invites', { email: 'synthetic.delivery@example.test', name: 'Synthetic Delivery', role: 'Scout' }, maria);
ok(inv.status === 201, 'the club invites a scout with an e-mail address');
const inviteCode = (await admin('/admin/outbox')).items.find((m) => m.to === 'synthetic.delivery@example.test')?.text.match(/invite code: ([0-9a-f]+)/)?.[1];
const scout = (await j('POST', '/auth/org/accept-invite', { token: inviteCode, scoutName: 'Synthetic Delivery' })).body?.token;
ok(!!scout, 'the scout joins');
const failuresBefore = (await admin('/admin/metrics')).deliveryFailures;
ok((await j('POST', '/admin/delivery/inject-failure', { channel: 'email', count: 4 }, null, ADMIN)).status === 200, 'four provider failures injected');
const ticket = await j('POST', '/org/support', { subject: 'Synthetic ticket', body: 'x', refs: [] }, scout);
ok((await j('POST', `/admin/support/${ticket.body.ticket.id}/reply`, { text: 'Synthetic reply.' }, null, ADMIN)).status === 200, 'support replies to the scout (a notice to them)');
const failed = await until(async () => { await sweep(); return (await admin('/admin/delivery')).recent.find((d) => d.to === 'synthetic.delivery@example.test' && d.status === 'failed'); }, 20_000);
ok(!!failed && failed.attempts.length === 4 && failed.failReason === 'injected provider failure' && failed.failedAt, 'after four sends the dispatch is failed, with the provider\'s reason');
ok(failed.orgId === 'org-eastport', 'the staff member\'s dispatch carries the club');
ok((await admin('/admin/metrics')).deliveryFailures === failuresBefore + 1, 'counted once as a delivery failure');
const hook = await until(async () => hooks.find((h) => h.type === 'delivery.failed' && h.data?.dispatchId === failed.id), 10_000);
ok(!!hook, 'the club\'s webhook receives delivery.failed for that dispatch');

section('C — provider callbacks');
const pm = email.providerMessageId; const at = Date.now();
let c = await j('POST', '/callbacks/delivery', { events: [] }, null, { 'x-provider-timestamp': String(Date.now()), 'x-provider-signature': 'bad' });
neg(c.status === 401, 'an unsigned callback is refused');
c = await callback([{ callbackId: 'e2e-cb-1', providerMessageId: pm, status: 'opened', at }]);
ok(c.status === 200 && c.body.applied === 1, 'an out-of-order OPENED applies');
let row = (await mine()).find((d) => d.id === email.id);
ok(row.status === 'opened' && row.openedAt === at && row.deliveredAt === at, 'opened implies delivered, at the provider\'s clock');
c = await callback([{ callbackId: 'e2e-cb-1', providerMessageId: pm, status: 'opened', at: at + 5 }]);
neg(c.body.applied === 0 && c.body.duplicates === 1, 'a repeated callback id applies nothing');
c = await callback([{ callbackId: 'e2e-cb-2', providerMessageId: pm, status: 'bounced', reason: 'synthetic late bounce' }]);
row = (await mine()).find((d) => d.id === email.id);
neg(row.status === 'opened' && row.failReason === 'synthetic late bounce', 'a late bounce is recorded but never regresses a confirmed open');
for (const [bad, field, what] of [
  [{ status: 'teleported' }, 'events[1].status', 'an unknown status'], [{ at: 1.5 }, 'events[1].at', 'a fractional clock'], [{ at: 'Infinity' }, 'events[1].at', 'a clock that is not a number'],
  [{ providerMessageId: 42 }, 'events[1].providerMessageId', 'a provider id that is not text'], [{ callbackId: '' }, 'events[1].callbackId', 'an empty callback id'],
]) {
  c = await callback([{ callbackId: 'e2e-cb-ok', providerMessageId: pm, status: 'delivered' }, { callbackId: 'e2e-cb-bad', providerMessageId: pm, status: 'delivered', ...bad }]);
  neg(c.status === 400 && c.body.error === 'FIELD_INVALID' && c.body.field === field, `${what} is refused naming ${field}`);
}
c = await callback([{ callbackId: 'e2e-cb-ok', providerMessageId: pm, status: 'delivered' }]);
neg(c.body.applied === 1 && c.body.duplicates === 0, 'nothing of a refused batch was applied or remembered: its good event applies later');

section('D — the club\'s delivery list');
let page = await j('GET', '/org/delivery?limit=1', undefined, maria);
ok(page.status === 200 && page.body.items.length === 1 && page.body.nextCursor, 'pages by cursor');
const seen = [...page.body.items];
while (page.body.nextCursor) { page = await j('GET', `/org/delivery?limit=100&cursor=${page.body.nextCursor}`, undefined, maria); seen.push(...page.body.items); }
ok(seen.length >= 2 && seen.every((d) => d.orgId === 'org-eastport') && seen.some((d) => d.id === failed.id), 'every page holds this club\'s staff dispatches, the failed one among them');
ok(seen.every((d, i) => i === 0 || seen[i - 1].createdAt >= d.createdAt), 'newest first');
neg((await j('GET', '/org/delivery', undefined, harbour)).body.items.every((d) => d.orgId !== 'org-eastport'), 'another club sees none of them');
neg((await j('GET', '/org/delivery?cursor=junk', undefined, maria)).status === 400, 'a junk cursor is refused');

section('E — device tokens');
const reg = (token, who) => j('POST', '/push/register', { token }, who);
ok((await reg('ExponentPushToken[e2e-shared]', kola)).status === 201, 'the player registers their phone');
c = await reg('ExponentPushToken[e2e-shared]', amara);
ok(c.status === 201 && c.body.moved === true, 'the guardian signs in on the same phone: the token moves to them');
neg((await reg('ExponentPushToken[e2e-staff]', maria)).status === 403, 'staff cannot register a device (the Player app\'s accounts only)');
neg((await reg(12345, kola)).body?.error === 'TOKEN_INVALID', 'a token that is not text is refused');
neg((await reg(`ExponentPushToken[${'x'.repeat(200)}]`, kola)).body?.error === 'TOKEN_INVALID', 'an over-long token is refused');

section('F — the admin outbox and push log');
// The sweep keeps running (the fast ladder), so a newer record may arrive between two reads: the pages are checked
// for order and continuity, not against a fixed position.
const first = await admin('/admin/outbox?limit=1');
const rest = await admin(`/admin/outbox?limit=100&cursor=${first.nextCursor}`);
const all = (await admin('/admin/outbox?limit=100')).items;
const paged = [...first.items, ...rest.items].map((m) => m.id); const at0 = all.findIndex((m) => m.id === paged[0]);
ok(first.items.length === 1 && first.nextCursor && rest.items.length >= 1 && at0 >= 0 && JSON.stringify(all.slice(at0).map((m) => m.id)) === JSON.stringify(paged), 'the outbox pages by cursor, newest first, each record once');
const pushes = await admin('/admin/push-log');
ok(Array.isArray(pushes.items) && pushes.items.length > 0 && 'nextCursor' in pushes, 'the push log pages by cursor');
const overview = await admin('/admin/overview');
ok(overview.emailsSent >= all.length && overview.pushesSent >= pushes.items.length, 'the overview counts the tables');
for (const q of ['limit=0', 'limit=500', 'cursor=junk']) neg((await j('GET', `/admin/outbox?${q}`, undefined, null, ADMIN)).status === 400, `junk paging (${q}) is refused`);

console.log(`\n${passed} delivery checks passed (${negatives} negative)`);
cleanup();
process.exit(0);
