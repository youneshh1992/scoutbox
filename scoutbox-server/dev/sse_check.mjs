// The server-sent events check: does the event stream behave as platform/connectedMode reads it,
// and how does it hold up with many open streams?
//
//   1. Behaviour, with the battery's own frame reader: tickets are required, a stream is scoped to its holder,
//      typing is live but never replayed, a reconnect replays what it missed and says when it has caught up, a
//      stale cursor is told to resync, and a sign-out ends a ticket.
//   2. Fan-out: N streams open on one player's thread (N = 100, 1000), then one message at a time is sent to it.
//      For each message: from the start of the POST to each stream's frame (p50, p99), and to the last stream's.
//      The server's resident memory before, with the streams open, and after they close.
//
//   gleam export erlang-shipment && node dev/sse_check.mjs [streams=100,1000] [messages=20]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GL = path.resolve(HERE, '..');
const FANOUT = (process.argv[2] ?? '100,1000').split(',').map(Number);
const MESSAGES = Number(process.argv[3] ?? 20);

const servers = Object.entries({
  gleam: { cmd: path.join(GL, 'build/erlang-shipment/entrypoint.sh'), args: ['run'], cwd: GL },
});

let failures = 0;
const check = (cond, name) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
};

async function boot(server, data, port) {
  const child = spawn(server.cmd, server.args, {
    cwd: server.cwd,
    env: { ...process.env, PORT: String(port), DATA_DIR: data, SCOUTBOX_QUIET_LOGS: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/health`)).ok) break;
    } catch {}
    if (i > 240) throw new Error('did not boot');
    await new Promise((r) => setTimeout(r, 250));
  }
  return child;
}
const stop = (child) => new Promise((r) => (child.once('exit', r), child.kill('SIGTERM')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rssMb = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;

/** An open stream: its frames as they arrive (with the time each arrived), until `close()`. */
function openStream(api, ticket, lastEventId = 0) {
  const controller = new AbortController();
  const frames = [];
  const waiters = [];
  const url = `${api}/events?ticket=${ticket}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`;
  const done = (async () => {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return res.status;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const at = performance.now();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // The battery's reader: an `id: ` line and a `data: ` line.
          const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          frames.push({ id: idLine ? Number(idLine.slice(4)) : null, at, ...JSON.parse(dataLine.slice(6)) });
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch {
      /* aborted */
    }
    return res.status;
  })();
  /** Resolves when some frame satisfies `pred`. */
  const until = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
      const test = () => {
        const f = frames.find(pred);
        if (f) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(test);
      };
      test();
    });
  return { frames, until, done, close: () => controller.abort() };
}

async function run(name, server) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `scoutbox-sse-${name}-`));
  const port = 4300 + Math.floor(Math.random() * 500);
  const API = `http://localhost:${port}`;
  const child = await boot(server, data, port);
  const j = async (pathname, opts = {}, token) => {
    const res = await fetch(`${API}${pathname}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const post = (pathname, body, token) => j(pathname, { method: 'POST', body: JSON.stringify(body ?? {}) }, token);
  const login = async (playerId) => (await post('/auth/player/login', { playerId })).body.token;
  const ticket = async (token) => (await post('/events/ticket', {}, token)).body.ticket;

  console.log(`\n${name}`);
  try {
    const EASTPORT = (await post('/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body.token;
    const KOLA = await login('pl-adeyemi');
    const SVEN = await login('pl-svensson');
    const thread = async (playerId, token) => {
      const r = await post(`/org/players/${playerId}/request`, { type: 'contact', message: 'Synthetic: a word about next season.' }, EASTPORT);
      await post(`/player/requests/${r.body.requestId}/respond`, { accept: true }, token);
      return (await j('/player/channels', {}, token)).body[0].id;
    };
    const kolaChan = await thread('pl-adeyemi', KOLA);
    const svenChan = await thread('pl-svensson', SVEN);
    const send = (chan, text) => post(`/org/channels/${chan}/messages`, { text }, EASTPORT);

    // ---- 1. behaviour
    console.log(' behaviour');
    check((await j('/events')).status === 401, 'no ticket: 401');
    check((await post('/events/ticket', {})).status === 401, 'a ticket needs a session');
    const kola = openStream(API, await ticket(KOLA));
    const org = openStream(API, await ticket(EASTPORT));
    await kola.until((f) => f.event === 'connected');
    await org.until((f) => f.event === 'connected');
    check(kola.frames[0].event === 'connected' && kola.frames[0].id === null, 'the first frame is `connected`, without an id');
    await send(svenChan, 'Synthetic: Svensson only.');
    await send(kolaChan, 'Synthetic: Kola, Thursday?');
    await post(`/org/channels/${kolaChan}/typing`, {}, EASTPORT);
    await kola.until((f) => f.event === 'typing');
    await org.until((f) => f.event === 'messages' && f.channelId === kolaChan);
    await sleep(200);
    check(kola.frames.some((f) => f.event === 'messages' && f.channelId === kolaChan), "a player's stream carries their thread");
    check(!kola.frames.some((f) => f.channelId === svenChan), "and never another player's");
    check(kola.frames.some((f) => f.event === 'notify' && f.audienceId === 'pl-adeyemi'), 'a notice reaches its audience');
    check(org.frames.some((f) => f.channelId === svenChan) && org.frames.some((f) => f.channelId === kolaChan), "the club's stream carries both of its threads");
    const typing = kola.frames.find((f) => f.event === 'typing');
    check(typing?.side === 'org' && typing.id > 0, 'typing is live, with an id');
    const lastSeen = Math.max(...kola.frames.map((f) => f.id ?? 0));
    kola.close();
    await kola.done;
    await send(kolaChan, 'Synthetic: sent while offline.');
    await post(`/org/channels/${kolaChan}/typing`, {}, EASTPORT);
    await sleep(200);
    const back = openStream(API, await ticket(KOLA), lastSeen);
    await back.until((f) => f.event === 'caught_up');
    const replayed = back.frames.filter((f) => f.id);
    check(replayed.length > 0 && replayed.every((f) => f.id > lastSeen), 'a reconnect replays only what came after its cursor');
    check(replayed.some((f) => f.event === 'messages' && f.channelId === kolaChan), 'including the missed message');
    check(!replayed.some((f) => f.event === 'typing'), 'but never typing');
    check(back.frames.at(-1).event === 'caught_up', 'and then says it has caught up');
    back.close();
    const stale = openStream(API, await ticket(KOLA), 9_999_999);
    check((await stale.until((f) => f.event === 'resync')).event === 'resync', 'a cursor from the future is told to resync');
    stale.close();
    const t = await ticket(KOLA);
    await post('/auth/logout', {}, KOLA).catch(() => null);
    const after = openStream(API, t);
    const status = await Promise.race([after.done, sleep(1000).then(() => 'still open')]);
    after.close();
    const unported = (await post('/auth/logout', {}, KOLA)).status === 404;
    check(status === 401 || unported, `a signed-out session's ticket is refused (${status}${unported ? '; logout is not ported yet' : ''})`);
    org.close();

    // ---- 2. fan-out
    const KOLA2 = await login('pl-adeyemi');
    for (const n of FANOUT) {
      const before = rssMb(child.pid);
      const tickets = await Promise.all(Array.from({ length: n }, () => ticket(KOLA2)));
      const streams = tickets.map((tk) => openStream(API, tk));
      await Promise.all(streams.map((s) => s.until((f) => f.event === 'connected', 30000)));
      await sleep(500);
      const open = rssMb(child.pid);
      const each = [];
      const last = [];
      for (let m = 0; m < MESSAGES; m++) {
        // Each stream's next `messages` frame is this message's: the next is sent only once every stream has it.
        const seen = streams.map((s) => s.frames.length);
        const t0 = performance.now();
        await send(kolaChan, `Synthetic fan-out ${m}.`);
        const got = await Promise.all(
          streams.map((s, i) => s.until((f) => f.event === 'messages' && s.frames.indexOf(f) >= seen[i], 30000)),
        );
        const lat = got.map((f) => f.at - t0);
        each.push(...lat);
        last.push(Math.max(...lat));
      }
      for (const s of streams) s.close();
      await Promise.all(streams.map((s) => s.done));
      await sleep(1500);
      const closed = rssMb(child.pid);
      // The hub still answers promptly once they're gone.
      const one = openStream(API, await ticket(KOLA2));
      await one.until((f) => f.event === 'connected');
      const t0 = performance.now();
      await send(kolaChan, 'Synthetic: after the crowd left.');
      const solo = (await one.until((f) => f.event === 'messages')).at - t0;
      one.close();
      const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
      const ms = (x) => `${x.toFixed(1)} ms`;
      console.log(
        ` ${n} streams × ${MESSAGES} messages: per stream p50 ${ms(pct(each, 50))}, p99 ${ms(pct(each, 99))}; ` +
          `last stream p50 ${ms(pct(last, 50))}, max ${ms(Math.max(...last))}; alone afterwards ${ms(solo)}`,
      );
      console.log(
        `   memory: ${before.toFixed(0)} MB → ${open.toFixed(0)} MB open (${(((open - before) * 1024) / n).toFixed(1)} KB a stream) → ${closed.toFixed(0)} MB closed`,
      );
    }
  } finally {
    await stop(child);
    fs.rmSync(data, { recursive: true, force: true });
  }
}

for (const [name, server] of servers) await run(name, server);
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
