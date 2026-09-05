// Connected-mode E2E for the M11 hardening. Unlike apiE2E.mjs this script
// OWNS its server processes: it boots isolated instances on a throwaway
// DATA_DIR, kills one with SIGKILL to prove durability, and reboots in
// production mode to prove the dev-login gate. Run standalone:
//   node scripts/connectedE2E.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4101;
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-connected-'));

let passed = 0;
const ok = (cond, name) => {
  if (!cond) { console.error(`✗ ${name}`); cleanup(); process.exit(1); }
  passed++; console.log(`✓ ${name}`);
};
const j = async (pathname, opts = {}, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, { ...opts, headers: { 'content-type': 'application/json', ...headers } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const admin = { 'x-admin-key': 'scoutbox-admin' };

let child = null;
function cleanup() {
  if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function startServer(extraEnv = {}) {
  child = spawn('node', ['server.mjs'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ...extraEnv },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return;
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not boot');
}

// Collect SSE frames from an /events stream for a bounded window.
async function collectEvents(ticket, ms, lastEventId = 0) {
  const controller = new AbortController();
  const events = [];
  const url = `${API}/events?ticket=${ticket}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`;
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { status: res.status, events };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) events.push({ id: idLine ? Number(idLine.slice(4)) : null, ...JSON.parse(dataLine.slice(6)) });
        }
      }
    } catch { /* aborted */ }
    return { status: res.status, events };
  })();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  return done;
}

console.log(`isolated data dir: ${DATA}`);
await startServer();

// ---- setup: Eastport (pro) + Kola (adult) with an accepted contact channel
let r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }) });
ok(r.status === 200, 'dev login works in development mode');
const EASTPORT = r.body.token;
const KOLA = (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).body.token;
const SVEN = (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-svensson' }) })).body.token;

r = await j('/org/players/pl-adeyemi/request', { method: 'POST', body: JSON.stringify({ type: 'contact', message: 'Quick word about next season.' }) }, bearer(EASTPORT));
const reqId = r.body.requestId;
ok(r.status === 201 && reqId, 'contact request created');
r = await j(`/player/requests/${reqId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) }, bearer(KOLA));
ok(r.status === 200, 'player accepted — channel open');
let channels = await j('/player/channels', {}, bearer(KOLA));
const chan = channels.body[0];
ok(!!chan, 'player sees the channel');

// A second channel (Eastport ↔ Svensson) to prove scoping.
r = await j('/org/players/pl-svensson/request', { method: 'POST', body: JSON.stringify({ type: 'contact', message: 'About your wing play.' }) }, bearer(EASTPORT));
await j(`/player/requests/${r.body.requestId}/respond`, { method: 'POST', body: JSON.stringify({ accept: true }) }, bearer(SVEN));
const svenChan = (await j('/player/channels', {}, bearer(SVEN))).body[0];

// ---- 1. SSE is authenticated
r = await j('/events');
ok(r.status === 401, 'the event stream refuses connections without a ticket');
r = await j('/events/ticket', { method: 'POST' });
ok(r.status === 401, 'tickets require an authenticated session');
const kolaTicket = (await j('/events/ticket', { method: 'POST' }, bearer(KOLA))).body.ticket;
ok(!!kolaTicket, 'authenticated session mints a connect ticket');

// ---- 2. SSE is scoped: Kola's stream sees his channel's messages, never Svensson's
const collecting = collectEvents(kolaTicket, 2500);
await new Promise((res) => setTimeout(res, 600)); // stream attached
await j(`/org/channels/${svenChan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Svensson-only thread message.' }) }, bearer(EASTPORT));
await j(`/org/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Kola, are you free Thursday?' }) }, bearer(EASTPORT));
const { events: kolaEvents } = await collecting;
const msgEvents = kolaEvents.filter((e) => e.event === 'messages');
ok(msgEvents.some((e) => e.channelId === chan.id), "player's stream carries his own channel events");
ok(!msgEvents.some((e) => e.channelId === svenChan.id), "player's stream never carries another player's channel events");
const lastSeen = Math.max(0, ...kolaEvents.map((e) => e.id ?? 0));

// ---- 3. reconnect catch-up: events missed while offline replay by id
await j(`/org/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Sent while you were offline.' }) }, bearer(EASTPORT));
const t2 = (await j('/events/ticket', { method: 'POST' }, bearer(KOLA))).body.ticket;
const { events: replayed } = await collectEvents(t2, 1200, lastSeen);
ok(replayed.some((e) => e.event === 'messages' && e.channelId === chan.id), 'reconnect with lastEventId replays the missed message event');
ok(replayed.some((e) => e.event === 'caught_up'), 'stream signals when catch-up is complete');

// ---- 4. media is authorised, not public
const profile = await j('/org/players/pl-adeyemi', {}, bearer(EASTPORT));
const signedUrl = profile.body.media.find((m) => m.url)?.url;
ok(!!signedUrl && /\/media\/[a-z0-9-]+\?e=\d+&s=/i.test(signedUrl), 'media URLs leave the API signed with an expiry');
const mediaId = /\/media\/([a-z0-9-]+)\?/i.exec(signedUrl)[1];
let mres = await fetch(`${API}${signedUrl}`);
ok(mres.ok, 'a signed media URL serves without further auth (the URL is the capability)');
mres = await fetch(`${API}/media/${mediaId}`);
ok(mres.status === 401, 'a bare media id without signature or session is refused');
mres = await fetch(`${API}/media/${mediaId}`, { headers: bearer(KOLA) });
ok(mres.ok, "the owning player's bearer session may fetch their own media directly");
mres = await fetch(`${API}/media/${mediaId}?e=1&s=stale`, {});
ok(mres.status === 401, 'an expired or forged signature is refused');

// ---- 5. idempotent sends: a retry with the same client id never duplicates
const before = (await j('/player/channels', {}, bearer(KOLA))).body[0].messages.length;
await j(`/player/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'One shot only.', clientMsgId: 'retry-123' }) }, bearer(KOLA));
await j(`/player/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'One shot only.', clientMsgId: 'retry-123' }) }, bearer(KOLA));
const after = (await j('/player/channels', {}, bearer(KOLA))).body[0].messages.length;
ok(after === before + 1, 'a retried send with the same clientMsgId lands exactly once');

// ---- 5b. wrong-organisation access to channels and media is refused
const HARBOUR = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-harbour', scoutName: 'D. Ansah' }) })).body.token;
r = await j(`/org/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'not my thread' }) }, bearer(HARBOUR));
ok(r.status === 404, "another organisation cannot write into a channel it isn't part of");
r = await j('/org/channels', {}, bearer(HARBOUR));
ok(!r.body.some((c) => c.id === chan.id), "another organisation's channel list never contains the thread");
const MOSS = (await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-mossside', scoutName: 'Pat Doyle', platform: 'grassroots' }) })).body.token;
const svenMediaId = (await j('/org/players/pl-svensson', {}, bearer(EASTPORT))).body.media.find((m) => m.url) ? /\/media\/([a-z0-9-]+)\?/i.exec((await j('/org/players/pl-svensson', {}, bearer(EASTPORT))).body.media.find((m) => m.url).url)[1] : null;
if (svenMediaId) {
  const forbidden = await fetch(`${API}/media/${svenMediaId}`, { headers: bearer(MOSS) });
  ok(forbidden.status === 401, 'a grassroots org cannot fetch media of a player outside its radius, even with a valid session');
}

// ---- 6. blocks and suspensions close open channels
await j('/player/block', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport' }) }, bearer(KOLA));
r = await j(`/org/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'Still there?' }) }, bearer(EASTPORT));
ok(r.status === 403 && r.body.error === 'BLOCKED', 'a block closes the org side of an open channel immediately');
r = await j(`/player/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'ignore' }) }, bearer(KOLA));
ok(r.status === 403 && r.body.error === 'BLOCKED', 'the blocking side cannot message through its own block either');
let chView = await j('/org/channels', {}, bearer(EASTPORT));
ok(chView.body.find((c) => c.id === chan.id)?.closed === true, 'the org sees the thread marked closed (history retained)');
// lift the block via admin so suspension can be tested on a live channel
const blockRow = (await j('/admin/blocks', {}, admin)).body.find((b) => b.orgId === 'org-eastport' && b.playerId === 'pl-adeyemi');
await j(`/admin/blocks/${blockRow.id}/lift`, { method: 'POST' }, admin);
await j('/admin/clubs/org-eastport/verification', { method: 'POST', body: JSON.stringify({ suspended: true }) }, admin);
r = await j(`/player/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'hello?' }) }, bearer(KOLA));
ok(r.status === 403 && r.body.error === 'ORG_SUSPENDED', 'a suspension pauses the thread for the counterparty too');
r = await j('/org/channels', {}, bearer(EASTPORT));
ok(r.status === 403 && r.body.error === 'ORG_SUSPENDED', 'a suspended org loses API access entirely');
r = await j('/events/ticket', { method: 'POST' }, bearer(EASTPORT));
ok(r.status === 401, 'a suspended org cannot open an event stream');
await j('/admin/clubs/org-eastport/verification', { method: 'POST', body: JSON.stringify({ suspended: false }) }, admin);

// ---- 7. durability: a SIGKILL right after a send loses nothing
await j(`/player/channels/${chan.id}/messages`, { method: 'POST', body: JSON.stringify({ text: 'This message must survive a crash.' }) }, bearer(KOLA));
await j(`/org/channels/${chan.id}/read`, { method: 'POST' }, bearer(EASTPORT));
child.kill('SIGKILL'); // no graceful shutdown hook — the debounce never fires
await new Promise((res) => setTimeout(res, 300));
await startServer();
const KOLA2 = (await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi' }) })).body.token;
channels = await j('/player/channels', {}, bearer(KOLA2));
const revived = channels.body.find((c) => c.id === chan.id);
ok(revived?.messages.some((m) => m.text === 'This message must survive a crash.'), 'messages survive an abrupt SIGKILL restart');
ok(revived?.readBy?.org != null, 'read state survives the crash too');

// ---- 8. production gate: seeded shortcuts refuse outside development
child.kill('SIGKILL');
await new Promise((res) => setTimeout(res, 300));
await startServer({ NODE_ENV: 'production' });
r = await j('/auth/player/login', { method: 'POST', body: JSON.stringify({ playerId: 'pl-adeyemi' }) });
ok(r.status === 403 && r.body.error === 'DEV_LOGIN_DISABLED', 'passwordless seed player login refused in production');
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane' }) });
ok(r.status === 403 && r.body.error === 'DEV_LOGIN_DISABLED', 'credential-less org login refused in production');
r = await j('/auth/org/register-grassroots', {
  method: 'POST',
  body: JSON.stringify({ name: 'Provisioned FC', city: 'London', lat: 51.5, lng: -0.1, federation: 'The FA', registrationId: 'FA-9', scoutName: 'Sam', password: 'club-secret-1' }),
});
ok(r.status === 201 && !('password' in r.body.org), 'a club can provision real credentials at registration (hash never echoed)');
const provisionedId = r.body.org.id;
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: provisionedId, scoutName: 'Sam', platform: 'grassroots', password: 'club-secret-1' }) });
ok(r.status === 200 && r.body.token, 'a credentialed org logs in fine in production');
r = await j('/auth/org/login', { method: 'POST', body: JSON.stringify({ orgId: provisionedId, scoutName: 'Sam', platform: 'grassroots', password: 'wrong' }) });
ok(r.status === 401, 'a wrong org password is refused');

child.kill('SIGKILL');
child = null;
console.log(`\n${passed} connected-mode checks passed`);
cleanup();
