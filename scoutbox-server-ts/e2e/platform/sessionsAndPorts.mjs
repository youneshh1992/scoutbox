// Server regressions: sessions, async handler errors, typed request fields, the production boot and the test
// harness's port picker.
//
//   S  sessions: a session has an absolute lifetime, decided in ONE
//      place and applied to every way a session is resolved — the bearer
//      lookup, the event-stream ticket and connect, a signed media link. A
//      session with no valid creation time is expired (fail closed). Sign-out
//      revokes the token. Expired sessions are pruned at the next login and
//      stay refused across a restart. A fresh session is unaffected.
//   A  a malformed body to an unauthenticated route is a 400, not the end of the process. (That a rejected async
//      handler reaches the error middleware is a check of this implementation's Express patch, in
//      scripts/testPlatformHelpers.mjs.)
//   P  production configuration is proved in productionHardening.mjs §48; here a
//      real production boot is refused without its own admin key, or with a proxy setting it can't read.
//   X  the client address that per-address budgets key on: the socket's, unless SCOUTBOX_TRUST_PROXY names the
//      proxies whose X-Forwarded-For to believe.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture, tokenHash, writeFixture } from '../support/sqlFixture.mjs';
import { rows } from '../support/sqlRows.mjs';
import { freePort, isFetchBlockedPort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

let passed = 0;
let negatives = 0;
let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`✓ ${m}`);
  } else fail(m);
};
const neg = (c, m) => {
  negatives++;
  ok(c, `[neg] ${m}`);
};
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'sbx-prem24-'));
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

async function boot(env = {}, dataDir = DATA, port = PORT) {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SCOUTBOX_QUIET_LOGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => {
    log += b;
  });
  proc.stderr.on('data', (b) => {
    log += b;
  });
  let up = false;
  for (let i = 0; i < 400 && !up; i++) {
    if (proc.exitCode != null) return { proc, up: false, log: () => log };
    try {
      up = (await fetch(`http://localhost:${port}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  return { proc, up, log: () => log };
}
async function stop(s) {
  s.proc.kill('SIGTERM');
  for (let i = 0; i < 80 && s.proc.exitCode == null; i++) await sleep(100);
}
const j = async (method, url, body, token) => {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let b = null;
  try {
    b = await r.json();
  } catch {
    /* none */
  }
  return { status: r.status, body: b };
};
const orgLogin = async () =>
  (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }))
    .body.token;
const playerLogin = async (id = 'pl-adeyemi') => (await j('POST', '/auth/player/login', { playerId: id })).body.token;

// ================================================================ S — sessions
section('S — sessions have a lifetime, sign-out revokes, every resolution path agrees');
let S = await boot();
ok(S.up, 'server booted');
neg(
  !/never emits|EVENT REGISTRY/.test(S.log()),
  `S0 the boot log carries no event-registry drift warning${/never emits/.test(S.log()) ? `: ${S.log().match(/never emits[^\n]*/)[0]}` : ''}`,
);
{
  // S1–S2 sign-out revokes the bearer token (org and player)
  const t = await orgLogin();
  ok((await j('GET', '/org/notifications', undefined, t)).status === 200, 'S1 a fresh org session is honoured');
  const lo = await j('POST', '/auth/logout', {}, t);
  const after = await j('GET', '/org/notifications', undefined, t);
  neg(
    lo.status === 200 && after.status === 401,
    `S1b after sign-out the same token is refused (${after.status} ${after.body?.error})`,
  );
  const pt = await playerLogin();
  await j('POST', '/auth/logout', {}, pt);
  neg((await j('GET', '/player/me', undefined, pt)).status === 401, 'S2 a signed-out player token is refused');
  const tk = await j('POST', '/events/ticket', {}, t);
  neg(tk.status === 401, `S2b a signed-out token cannot mint an event-stream ticket (${tk.status})`);
}
// S3–S6: plant an expired session, a session with no creation time and a fresh one, offline.
const tExpired = await orgLogin();
const tNoBirth = await playerLogin('pl-svensson');
const tFresh = await orgLogin();
const ticket = (await j('POST', '/events/ticket', {}, tExpired)).body?.ticket;
ok(!!ticket, 'setup: a ticket minted while the session was still live');
await stop(S);
// The sessions table holds a token HASH, never the token, so the planted rows
// are found by hash. A row whose creation time is missing or malformed cannot
// be represented in the sessions table at all (NOT NULL, a STRICT integer
// column): a write that tries is refused and changes nothing, so such a
// session never reaches the store. Fail-closed here means "never stored": the
// bearer path answers 401 because the token names nothing, and the untouched
// sessions stay honoured. No repository operation back-dates a session, so the
// expired sessions are planted with plain SQL on the stopped server's file.
const sessionHash = tokenHash;
const TTL_MS = 30 * DAY;
/** The stored sessions: `{ tokenHash, createdAt }`. */
const storedSessions = () =>
  rows(DATA, 'sessions', {}, { order: 'sid' }).map((r) => ({ tokenHash: r.token_hash, createdAt: r.created_at }));
/** Run `fn` on a writable connection to the stopped server's file. */
const onFile = (fn) => {
  const F = openFixture(DATA);
  try {
    return fn(F.sql);
  } finally {
    F.close();
  }
};
const backdate = (token, createdAt, ttl = TTL_MS) =>
  onFile(
    (s) =>
      s
        .prepare('UPDATE sessions SET created_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(createdAt, createdAt + ttl, sessionHash(token)).changes,
  );
{
  const sessionsBefore = JSON.stringify(storedSessions());
  let refused = false;
  try {
    onFile((s) => s.prepare('UPDATE sessions SET created_at = NULL WHERE token_hash = ?').run(sessionHash(tNoBirth)));
  } catch (err) {
    refused = /NOT NULL constraint failed: sessions\.created_at/.test(err.message);
  }
  neg(
    refused && JSON.stringify(storedSessions()) === sessionsBefore,
    "S4 stripping a stored session's creation time is refused by the sessions table; the stored sessions are untouched",
  );
  refused = false;
  try {
    onFile((s) =>
      s
        .prepare(
          "INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, created_at, expires_at) VALUES (?, 'sidgarbage01', 'player', 'pl-adeyemi', NULL, 'yesterday', ?)",
        )
        .run(sessionHash('tok-garbage-birth'), Date.now()),
    );
  } catch (err) {
    refused = /cannot store TEXT value in INTEGER column sessions\.created_at/.test(err.message);
  }
  neg(
    refused && JSON.stringify(storedSessions()) === sessionsBefore,
    'S4b a session with a malformed creation time is refused by the sessions table and never stored',
  );
  const at = Date.now() - 31 * DAY;
  ok(
    backdate(tExpired, at) === 1 &&
      storedSessions().find((x) => x.tokenHash === sessionHash(tExpired)).createdAt === at,
    'setup: an expired but well-formed session can be planted',
  );
}
S = await boot();
ok(
  S.up,
  'setup: rebooted on the planted store (an expired session, one fresh; the unrepresentable rows never reached it)',
);
{
  const r1 = await j('GET', '/org/notifications', undefined, tExpired);
  neg(
    r1.status === 401,
    `S3 a session older than the lifetime (31 days > 30) is refused on the bearer path (${r1.status} ${r1.body?.error})`,
  );
  const r2 = await j('GET', '/player/me', undefined, tNoBirth);
  ok(
    r2.status === 200,
    `S4c the session whose creation time a refused write tried to strip is still intact and honoured (${r2.status})`,
  );
  const r3 = await j('GET', '/org/notifications', undefined, 'tok-garbage-birth');
  neg(r3.status === 401, `S4d the token of the never-stored row names nothing (${r3.status})`);
  const r4 = await j('POST', '/events/ticket', {}, tExpired);
  neg(r4.status === 401, `S5 an expired session cannot mint an event-stream ticket (${r4.status})`);
  const r5 = await fetch(`${BASE}/events?ticket=${encodeURIComponent(ticket)}`);
  neg(
    r5.status === 401,
    `S5b a ticket minted before expiry does not open a stream for an expired session (${r5.status}; the ticket store did not survive the restart either way)`,
  );
  ok((await j('GET', '/org/notifications', undefined, tFresh)).status === 200, 'S6 a fresh session is unaffected');
}
await stop(S);
{
  const sessions = storedSessions();
  neg(
    sessions.some((x) => x.tokenHash === sessionHash(tExpired)) &&
      !sessions.some((x) => x.tokenHash === sessionHash('tok-garbage-birth')),
    'S7 presenting the expired session was refused without writing (a read never writes; the next login prunes it); the malformed row was never stored',
  );
  ok(
    sessions.some((x) => x.tokenHash === sessionHash(tNoBirth)),
    'S7b the session a refused write tried to damage is still stored, unchanged',
  );
}
// S8: an expired session nobody presents is pruned at the next login.
writeFixture(DATA, {
  sessions: [
    {
      token: 'tok-stale-unused',
      sid: 'sidstaleunus',
      kind: 'player',
      refId: 'pl-kim',
      createdAt: Date.now() - 40 * DAY,
    },
  ],
});
ok(
  storedSessions().some((x) => x.tokenHash === sessionHash('tok-stale-unused')),
  'setup: a stale session nobody presents is planted',
);
S = await boot();
await playerLogin('pl-kim');
await stop(S);
{
  const sessions = storedSessions();
  neg(
    !sessions.some((x) => x.tokenHash === sessionHash('tok-stale-unused')),
    'S8 an expired session nobody presents is pruned at the next login',
  );
  ok(
    sessions.some((x) => x.tokenHash === sessionHash(tFresh)),
    'S8b a live session survives the prune',
  );
}
// S9: the lifetime is configurable; a short lifetime expires a session that is only hours old.
backdate(tFresh, Date.now() - 2 * DAY);
S = await boot({ SESSION_TTL_DAYS: '1' });
{
  const r = await j('GET', '/org/notifications', undefined, tFresh);
  neg(r.status === 401, `S9 SESSION_TTL_DAYS=1: a two-day-old session is refused (${r.status})`);
  const t = await orgLogin();
  ok(
    (await j('GET', '/org/notifications', undefined, t)).status === 200,
    'S9b a session minted under the short lifetime is honoured',
  );
}
await stop(S);

// ================================================================ A — async handler errors
section('A — a malformed body to an unauthenticated route answers 400 and the process keeps serving');
S = await boot();
{
  const anon = await j('POST', '/auth/guardian/signup', { name: { x: 1 }, email: { y: 2 }, password: { z: 3 } });
  neg(
    anon.status === 400,
    `A4 the unauthenticated request that used to END the server is a 400 (${anon.status} ${anon.body?.error})`,
  );
  ok((await fetch(`${BASE}/healthz`)).status === 200, 'A5 the server is still up');
}

// ================================================================ T — typed request fields
section('T — free text is a string: a non-string is a 400 naming the field, never a 500 or a stored object');
{
  const org = await orgLogin();
  const grass = (
    await j('POST', '/auth/org/login', {
      orgId: 'org-mossside',
      scoutName: 'Pat Doyle',
      role: 'Head Coach',
      platform: 'grassroots',
    })
  ).body.token;
  const player = await playerLogin();
  const O = { x: 1 };
  const cases = [
    ['anon', 'POST', '/auth/guardian/signup', { name: O, email: 'g@example.com', password: 'longenough1' }],
    [
      'anon',
      'POST',
      '/auth/org/register-grassroots',
      { name: O, federation: 'FA', registrationId: 'R1', lat: 53.4, lng: -2.2, scoutName: 'Sam' },
    ],
    [
      'anon',
      'POST',
      '/auth/org/register-grassroots',
      { name: 'Sweep FC', city: O, federation: 'FA', registrationId: 'R1', lat: 53.4, lng: -2.2, scoutName: 'Sam' },
    ],
    ['anon', 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: O, role: 'Scout' }],
    ['anon', 'POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: O }],
    [org, 'POST', '/org/searches', { name: O }],
    [org, 'POST', '/org/searches', { name: 'Wingers', filters: [1, 2] }],
    [org, 'POST', '/org/verification/email', { email: O }],
    [org, 'POST', '/org/invites', { email: 'x@example.com', name: O }],
    [org, 'POST', '/org/support', { subject: O }],
    [org, 'POST', '/org/verification/licence', { licenceType: O, issuer: 'FA' }],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: O }],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: '25:99' }],
    [grass, 'POST', '/org/squad', { name: O }],
    [grass, 'POST', '/org/squad', { name: 'Sam', position: O }],
    [grass, 'POST', '/org/open-trials', { title: 'Open day', date: '2099-05-01', venue: 'Rec', notes: O }],
    [grass, 'POST', '/org/friendlies', { date: '2099-05-01', ageGroup: O }],
    [player, 'POST', '/player/media', { title: O }],
    [player, 'POST', '/player/medical/records', { title: O }],
    [player, 'POST', '/player/medical/records', { title: 'Knock', layoffWeeks: 'three' }],
    [player, 'POST', '/player/medical/records', { title: 'Knock', cleared: 'yes' }],
  ];
  const bad = [];
  for (const [tok, m, url, body] of cases) {
    const r = await j(m, url, body, tok === 'anon' ? undefined : tok);
    if (r.status !== 400 || JSON.stringify(r.body ?? {}).includes('"x":1'))
      bad.push(`${m} ${url} ${JSON.stringify(body).slice(0, 60)} → ${r.status} ${r.body?.error}`);
  }
  neg(
    bad.length === 0,
    `T1 ${cases.length} malformed bodies across ${new Set(cases.map((c) => c[2])).size} routes each answer 400 and store nothing${bad.length ? ': ' + bad.join(' | ') : ''}`,
  );
  const good = [
    [org, 'POST', '/org/searches', { name: 'Wingers', filters: { position: 'RW' } }, 201],
    [org, 'PUT', '/org/delivery/prefs', { quietStart: '21:00', quietEnd: '07:30', email: true }, 200],
    [grass, 'POST', '/org/squad', { name: 'Sam Keeper', position: 'GK' }, 201],
    [
      player,
      'POST',
      '/player/medical/records',
      { type: 'injury', title: 'Knock', layoffWeeks: 2, cleared: false },
      201,
    ],
    [player, 'POST', '/player/media', { title: 'Highlights' }, 201],
  ];
  const off = [];
  for (const [tok, m, url, body, want] of good) {
    const r = await j(m, url, body, tok);
    if (r.status !== want) off.push(`${url} → ${r.status} ${r.body?.error}`);
  }
  ok(
    off.length === 0,
    `T2 well-formed bodies to the same routes still succeed${off.length ? ': ' + off.join(' | ') : ''}`,
  );
  ok((await fetch(`${BASE}/healthz`)).status === 200, 'T3 the server is up after every malformed request');
}
await stop(S);

// ================================================================ P — production boot
section('P — production refuses to start without its own admin key');
{
  const d2 = mkdtempSync(path.join(tmpdir(), 'sbx-prem24p-'));
  const p1 = await boot(
    { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef' },
    d2,
    await freePort(),
  );
  neg(
    !p1.up && /Refusing to start: .*ADMIN_KEY_UNSAFE/.test(p1.log()),
    'P1 NODE_ENV=production with no ADMIN_KEY: the server refuses to start (ADMIN_KEY_UNSAFE)',
  );
  const p2 = await boot(
    { NODE_ENV: 'production', MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef', ADMIN_KEY: 'scoutbox-admin' },
    d2,
    await freePort(),
  );
  neg(!p2.up && /ADMIN_KEY_UNSAFE/.test(p2.log()), 'P2 the development default key is refused too');
  const P3_PORT = await freePort();
  const p3 = await boot(
    {
      NODE_ENV: 'production',
      MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
      ADMIN_KEY: 'sweep-production-admin-key-0123',
    },
    d2,
    P3_PORT,
  );
  ok(p3.up, 'P3 with its own key the production server starts');
  if (p3.up) {
    const def = await fetch(`http://localhost:${P3_PORT}/admin/reports`, {
      headers: { 'x-admin-key': 'scoutbox-admin' },
    });
    const own = await fetch(`http://localhost:${P3_PORT}/admin/reports`, {
      headers: { 'x-admin-key': 'sweep-production-admin-key-0123' },
    });
    neg(
      def.status === 401 && own.status === 200,
      `P4 the public default key is refused (${def.status}); the configured key works (${own.status})`,
    );
    const dev = await fetch(`http://localhost:${P3_PORT}/auth/org/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' }),
    });
    neg(dev.status !== 200, `P5 passwordless demo logins stay refused in production (${dev.status})`);
    await stop(p3);
  }
  const p4 = await boot(
    {
      NODE_ENV: 'production',
      MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
      ADMIN_KEY: 'sweep-production-admin-key-0123',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
    },
    d2,
    await freePort(),
  );
  neg(
    !p4.up && /AGENT_TEST_PROVIDER_IN_PRODUCTION/.test(p4.log()),
    'P6 the synthetic agent licence register is refused in production',
  );
  const p5 = await boot(
    {
      NODE_ENV: 'production',
      MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
      ADMIN_KEY: 'sweep-production-admin-key-0123',
      SCOUTBOX_TRUST_PROXY: 'fly',
    },
    d2,
    await freePort(),
  );
  neg(
    !p5.up && /TRUST_PROXY_INVALID/.test(p5.log()),
    'P7 a SCOUTBOX_TRUST_PROXY that is not a hop count, true/false or a list of addresses is refused in production',
  );
  const P8_PORT = await freePort();
  const p6 = await boot(
    {
      NODE_ENV: 'production',
      MEDIA_SECRET: 'synthetic-media-secret-0123456789abcdef',
      ADMIN_KEY: 'sweep-production-admin-key-0123',
      SCOUTBOX_TRUST_PROXY: 'loopback, 10.0.0.0/8',
    },
    d2,
    P8_PORT,
  );
  ok(p6.up, 'P8 a list of trusted proxies starts the production server');
  if (p6.up) await stop(p6);
}

// ================================================================ X — the client address
section('X — the client address is the socket unless SCOUTBOX_TRUST_PROXY says which proxies to believe');
{
  // A public share link spends `passport_share_read` under the client address, so the bucket a request draws on
  // (GET /__rate-limits) shows the address the server settled on, without spending the budget.
  const shareKey = async (port, forwardedFor) => {
    const base = `http://localhost:${port}`;
    const buckets = async () =>
      new Map(
        (await (await fetch(`${base}/__rate-limits`)).json()).buckets
          .filter((b) => b.action === 'passport_share_read')
          .map((b) => [b.key, b.spent]),
      );
    const before = await buckets();
    const r = await fetch(`${base}/passport/shared/no-such-link`, {
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    });
    const after = await buckets();
    const drawn = [...after].filter(([k, n]) => n > (before.get(k) ?? 0)).map(([k]) => k);
    return { status: r.status, key: drawn.length === 1 ? drawn[0] : `(${drawn.length} buckets drawn)` };
  };
  const SETTINGS = {
    unset: undefined,
    one: '1',
    two: '2',
    all: 'true',
    loopback: 'loopback',
    listed: 'loopback, 10.0.0.0/8',
    invalid: 'fly',
  };
  const servers = Object.fromEntries(
    await Promise.all(
      Object.entries(SETTINGS).map(async ([name, value]) => {
        const port = await freePort();
        const s = await boot(
          { SCOUTBOX_SEED_DEMO: '0', ...(value === undefined ? {} : { SCOUTBOX_TRUST_PROXY: value }) },
          mkdtempSync(path.join(tmpdir(), `sbx-proxy-${name}-`)),
          port,
        );
        return [name, { ...s, port }];
      }),
    ),
  );
  ok(
    Object.values(servers).every((s) => s.up),
    'X0 a development server starts with each setting, the invalid one included',
  );
  const CHAIN = '198.51.100.9, 203.0.113.7';
  const key = (name, forwardedFor) => shareKey(servers[name].port, forwardedFor);
  const proxyTrust = async (name) =>
    (await (await fetch(`http://localhost:${servers[name].port}/capabilities`)).json()).capabilities.proxy_trust;

  const socket = await key('unset');
  ok(socket.status === 404 && !socket.key.startsWith('('), `X1 a request spends the share budget once (${socket.key})`);
  neg(
    (await key('unset', '203.0.113.7')).key === socket.key,
    'X2 unset, a forwarded address is ignored: a client cannot choose its own address',
  );
  neg(
    (await key('invalid', '203.0.113.7')).key === (await key('invalid')).key,
    'X3 an invalid setting trusts nothing either',
  );
  ok((await key('one', CHAIN)).key === '203.0.113.7', 'X4 one hop: the address the trusted proxy saw connect');
  ok((await key('two', CHAIN)).key === '198.51.100.9', 'X5 two hops: one further back along the chain');
  ok(
    (await key('two', '203.0.113.7')).key === '203.0.113.7',
    'X6 more hops than the chain holds: the furthest address there is',
  );
  ok((await key('all', CHAIN)).key === '198.51.100.9', 'X7 true: the first address in the chain');
  ok(
    (await key('loopback', '198.51.100.9, 10.0.0.5')).key === '10.0.0.5',
    'X8 a list: the walk back stops at the first address that is not a trusted proxy',
  );
  ok((await key('listed', '198.51.100.9, 10.0.0.5')).key === '198.51.100.9', 'X9 a subnet in the list is trusted too');
  ok((await key('one')).key === socket.key, 'X10 a trusted proxy that forwards nothing leaves the socket address');
  const states = {
    unset: (await proxyTrust('unset')).state,
    one: (await proxyTrust('one')).state,
    listed: (await proxyTrust('listed')).state,
    invalid: (await proxyTrust('invalid')).state,
  };
  ok(
    states.unset === 'not_configured' &&
      states.one === 'configured' &&
      states.listed === 'configured' &&
      states.invalid === 'invalid',
    `X11 /capabilities reports each setting's state (${JSON.stringify(states)})`,
  );
  for (const s of Object.values(servers)) if (s.up) await stop(s);
}

// ================================================================ H — the test harness itself
section('H — no suite can draw a port that fetch() refuses');
{
  // H1 the cause: Node's fetch() refuses a Fetch-standard "bad port" before it opens a socket.
  const refused = await fetch('http://localhost:6000/healthz').then(
    () => null,
    (e) => String(e?.cause?.message ?? e),
  );
  neg(
    refused === 'bad port',
    `H1 fetch() refuses port 6000 outright (${refused}) — why a random port there failed a suite mid-way`,
  );
  // H2 the operating system never hands a suite a fetch-refused port (its ephemeral range is clear of them).
  let clean = true;
  for (let i = 0; i < 400; i++) if (isFetchBlockedPort(await freePort())) clean = false;
  neg(clean, 'H2 freePort never hands out a fetch-refused port (400 draws)');
  // Every suite takes each server's port from freePort, so H2 covers them all.
}

console.log(`\nplatform/sessionsAndPorts: ${passed} checks passed, ${negatives} negative, ${failures} failed`);
if (failures) console.error(`✗ platform/sessionsAndPorts have ${failures} failure(s).`);
process.exit(failures ? 1 : 0);
