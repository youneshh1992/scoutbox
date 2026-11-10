// The mail outbox, the push log and the device push tokens through the REAL server (server.mjs booted as a child
// process on temporary data directories, synthetic seed records only). Every mail record is
// durable when its route answers (the club challenge's text withheld in the table, the full text served from process
// memory until a restart), the live provider's answer is written to the row as soon as it returns, the delivery
// centre's record commits with its accepted dispatch, a push record is written once its notification is durable; the
// admin lists page by cursor, newest first; POST /push/register keeps one row per device token (a shared phone's token
// moves to the account that signed in last), refuses junk and staff sessions; an ordinary deletion leaves the three
// tables alone; the admin backup and its restore carry them; the invite routes refuse a non-string e-mail; the live
// push sender calls the provider once per token. Every database read goes through a second read-only connection.
// Nothing here touches DATA_DIR or real data; no real provider is called. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) {
  if (only && !name.includes(only)) return;
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};
const PLACEHOLDER = '[code withheld — delivered to the recipient only]';

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      SCOUTBOX_QUIET_LOGS: '1',
      SCOUTBOX_FAST_SWEEPS: '1',
      ...env,
    };
    const proc = spawnChild(process.execPath, [server], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* no body */
      }
      return { status: r.status, body: parsed, text };
    };
    /** The same request with the body sent as given (raw JSON text): what a client's parser produced is not pre-normalised by JSON.stringify here. */
    const raw = async (method, p, bodyText, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: bodyText,
      });
      const text = await r.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* no body */
      }
      return { status: r.status, body: parsed, text };
    };
    const S = {
      proc,
      port,
      dir,
      log: () => log,
      j,
      raw,
      stop: () =>
        new Promise((res) => {
          proc.on('exit', () => res());
          proc.kill('SIGTERM');
        }),
      kill: () =>
        new Promise((res) => {
          proc.on('exit', () => res());
          proc.kill('SIGKILL');
        }),
    };
    proc.stdout.on('data', (d) => {
      log += d;
      if (/listening on/.test(log)) resolve(S);
    });
    proc.stderr.on('data', (d) => {
      log += d;
    });
    proc.on('exit', (code, signal) =>
      reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })),
    );
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => {
  const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    s.exec('BEGIN');
    try {
      return fn({
        get: (sql, ...p) => {
          const r = s.prepare(sql).get(...p);
          return r ? { ...r } : r;
        },
        all: (sql, ...p) =>
          s
            .prepare(sql)
            .all(...p)
            .map((r) => ({ ...r })),
      });
    } finally {
      s.exec('COMMIT');
    }
  } finally {
    s.close();
  }
};
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
/** Whether the file still has the retired blob table (dropped by migration 0039). */
const hasBlobTable = (dir) =>
  !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'collections'");
const outboxFromRow = (r) =>
  r.source === 'mailer'
    ? {
        id: r.id,
        ts: r.created_at,
        to: r.to_address,
        subject: r.subject,
        text: r.text,
        transport: r.transport,
        delivered: r.delivered === 1,
      }
    : {
        id: r.id,
        at: r.created_at,
        channel: r.channel,
        to: r.to_address,
        text: r.text,
        providerMessageId: r.provider_message_id,
        provider: r.transport,
      };
/** The three collections as the DATABASE holds them, in insertion order. */
const readStored = (c) => ({
  outbox: c
    .all(
      `SELECT seq, id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id FROM outbox ORDER BY seq`,
    )
    .map(outboxFromRow),
  pushLog: c
    .all('SELECT id, created_at, audience_kind, audience_id, title, body, transport FROM push_log ORDER BY seq')
    .map((r) => ({
      id: r.id,
      ts: r.created_at,
      audience: { kind: r.audience_kind, id: r.audience_id },
      title: r.title,
      body: r.body,
      transport: r.transport,
    })),
  pushTokens: c
    .all('SELECT ref_kind, ref_id, token, registered_at FROM push_tokens ORDER BY seq')
    .map((r) => ({ kind: r.ref_kind, refId: r.ref_id, token: r.token, ts: r.registered_at })),
});
const stored = (dir) => snap(dir, readStored);
const playerTokens = (dir, id = 'pl-adeyemi') =>
  stored(dir).pushTokens.filter((t) => t.kind === 'player' && t.refId === id);
const orgLogin = async (S, orgId, scoutName, role) => {
  const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role });
  assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`);
  return r.body.token;
};
const playerLogin = async (S, playerId) => {
  const r = await S.j('POST', '/auth/player/login', { playerId });
  assert.equal(r.status, 200, r.text);
  return r.body.token;
};
const guardianLogin = async (S, guardianId) => {
  const r = await S.j('POST', '/auth/guardian/login', { guardianId });
  assert.equal(r.status, 200, r.text);
  return r.body.token;
};
const sweep = async (S) => {
  const r = await S.j('POST', '/admin/delivery/sweep', {}, null, A);
  assert.equal(r.status, 200, r.text);
  return r.body.processed;
};
/** A contact request the adult player accepts: the club's thread with him. */
async function adultChannel(S, maria, kola) {
  const req = await S.j(
    'POST',
    '/org/players/pl-adeyemi/request',
    { type: 'contact', message: 'Synthetic review request' },
    maria,
  );
  assert.equal(req.status, 201, req.text);
  assert.equal(
    (await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status,
    200,
  );
  const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0];
  assert.ok(channel?.id);
  return channel;
}

// ============================================================= the mail records and the admin lists
await test("mail records are durable when their route answers: the staff invite's, the guardian sign-up's and the club challenge's (the table holds the withheld text, the admin view the full text, the placeholder after a restart); the delivery centre's record commits with its accepted dispatch; the admin outbox and push log page by cursor newest first and refuse junk paging; the overview counts the tables; no blob table", async () => {
  const dir = tempDir('s14d-mail');
  let S = await boot(dir);
  for (const t of ['outbox', 'push_log', 'push_tokens'])
    assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  assert.equal(hasBlobTable(dir), false);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const amara = await guardianLogin(S, 'gd-amara');
  const invite = await S.j(
    'POST',
    '/org/invites',
    { email: 'synthetic-invitee@example.invalid', name: 'Synthetic Invitee', role: 'Scout' },
    maria,
  );
  assert.equal(invite.status, 201, invite.text);
  const mail = stored(dir).outbox.find((m) => m.to === 'synthetic-invitee@example.invalid');
  assert.ok(mail, 'committed at the response');
  assert.deepEqual([mail.transport, mail.delivered], ['dev-outbox', true]);
  const signup = await S.j('POST', '/auth/guardian/signup', {
    name: 'Synthetic Guardian',
    email: 'synthetic-guardian@example.invalid',
    password: 'synthetic-password-1',
  });
  assert.equal(signup.status, 201, signup.text);
  assert.ok(
    stored(dir).outbox.some((m) => m.to === 'synthetic-guardian@example.invalid'),
    "the sign-up's mail is committed at the response (no debounced save)",
  );
  const challenge = await S.j(
    'POST',
    '/org/verification/email',
    { email: 'synthetic-club@example-club.invalid' },
    maria,
  );
  assert.equal(challenge.status, 201, challenge.text);
  const dbChallenge = stored(dir).outbox.find((m) => m.to === 'synthetic-club@example-club.invalid');
  assert.ok(dbChallenge.text.includes(PLACEHOLDER), 'the table holds the withheld text');
  const view = (await S.j('GET', '/admin/outbox', undefined, null, A)).body;
  const viewChallenge = view.items.find((m) => m.id === dbChallenge.id);
  assert.equal(viewChallenge.text.includes(PLACEHOLDER), false, 'the admin view serves the full text from memory');
  assert.deepEqual(
    view.items.map((m) => m.id),
    stored(dir)
      .outbox.map((m) => m.id)
      .reverse(),
    'newest first',
  );
  assert.doesNotMatch(S.log(), /synthetic-guardian@|synthetic-club@/, 'no address in the log');
  const req = await S.j(
    'POST',
    '/org/players/pl-guni/request',
    { type: 'contact', message: 'Synthetic contact request about the under-18 player.' },
    maria,
  );
  assert.equal(req.status, 201, req.text);
  const notice = await until(async () =>
    (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find(
      (n) => n.type === 'request' && n.refId === req.body.requestId,
    ),
  );
  assert.ok(notice);
  const pair = await until(async () => {
    await sweep(S);
    return snap(dir, (c) => {
      const d = c.get(
        'SELECT provider_message_id, status FROM dispatches WHERE notification_id = ? AND channel = ?',
        notice.id,
        'email',
      );
      if (!d || d.status !== 'accepted') return null;
      return { d, row: readStored(c).outbox.find((m) => m.providerMessageId === d.provider_message_id) };
    });
  }, 15_000);
  assert.ok(pair?.row, 'the delivery record is committed with the accepted dispatch');
  assert.deepEqual([pair.row.provider, pair.row.channel, typeof pair.row.to], ['local-fake', 'email', 'string']);
  const all = stored(dir).outbox;
  assert.ok(all.length >= 4);
  const p1 = (await S.j('GET', '/admin/outbox?limit=2', undefined, null, A)).body;
  assert.equal(p1.items.length, 2);
  assert.ok(p1.nextCursor);
  const rest = (await S.j('GET', `/admin/outbox?limit=100&cursor=${p1.nextCursor}`, undefined, null, A)).body;
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(
    [...p1.items, ...rest.items].map((m) => m.id),
    all.map((m) => m.id).reverse(),
    'the pages together list every record once, newest first',
  );
  for (const q of ['limit=0', 'limit=101', 'limit=abc', 'cursor=junk']) {
    assert.equal((await S.j('GET', `/admin/outbox?${q}`, undefined, null, A)).status, 400, q);
    assert.equal((await S.j('GET', `/admin/push-log?${q}`, undefined, null, A)).status, 400, q);
  }
  const pushes = (await S.j('GET', '/admin/push-log', undefined, null, A)).body;
  assert.ok(Array.isArray(pushes.items));
  assert.deepEqual(
    pushes.items.map((p) => p.id),
    stored(dir)
      .pushLog.map((p) => p.id)
      .reverse()
      .slice(0, 50),
  );
  const overview = (await S.j('GET', '/admin/overview', undefined, null, A)).body;
  assert.deepEqual(
    [overview.emailsSent, overview.pushesSent],
    [stored(dir).outbox.length, stored(dir).pushLog.length],
    'the overview counts the tables',
  );
  await S.stop();
  S = await boot(dir);
  const afterRestart = (await S.j('GET', '/admin/outbox?limit=100', undefined, null, A)).body.items;
  assert.deepEqual(
    afterRestart.map((m) => m.id),
    all.map((m) => m.id).reverse(),
  );
  assert.ok(
    afterRestart.find((m) => m.id === dbChallenge.id).text.includes(PLACEHOLDER),
    'the placeholder after a restart',
  );
  await S.stop();
  rm(dir);
});

// ============================================================= the push record
await test("a message's push record is written once its notification is durable (the after-commit effect), for the right person, and survives a restart", async () => {
  const dir = tempDir('s14d-push');
  let S = await boot(dir, { SCOUTBOX_FAST_SWEEPS: '' });
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const kola = await playerLogin(S, 'pl-adeyemi');
  const channel = await adultChannel(S, maria, kola);
  const before = stored(dir).pushLog.length;
  assert.equal(
    (await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic push message' }, maria)).status,
    201,
  );
  const row = await until(async () => {
    const p = stored(dir).pushLog;
    return p.length > before ? p.at(-1) : null;
  }, 4000);
  assert.ok(row, 'the push row is in the table');
  assert.deepEqual(row.audience, { kind: 'player', id: 'pl-adeyemi' });
  assert.equal(row.title, 'ScoutBox');
  assert.equal(row.transport, 'dev-log');
  assert.ok(
    q1(
      dir,
      "SELECT 1 AS one FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message'",
    ),
    'its notification is durable',
  );
  await S.kill();
  S = await boot(dir, { SCOUTBOX_FAST_SWEEPS: '' });
  assert.ok(
    stored(dir).pushLog.some((p) => p.id === row.id),
    'the row survives a SIGKILL and a restart',
  );
  await S.stop();
  rm(dir);
});

// ============================================================= the registration route
await test("POST /push/register: a string token is stored at once (201 { registered, moved }); the same account again keeps one row and updates its time; another account registering the token takes it over (moved: true), so the first account's pushes no longer reach that phone; a number, a boolean, an object, an array, raw JSON 1e400 and a token over 200 characters are refused with 400 TOKEN_INVALID, a falsy token with TOKEN_REQUIRED, no session with 401, a staff session with 403 PUSH_NOT_AVAILABLE — storing nothing; the admin backup carries the tokens", async () => {
  const dir = tempDir('s14d-tokens');
  const S = await boot(dir);
  const kola = await playerLogin(S, 'pl-adeyemi');
  const amara = await guardianLogin(S, 'gd-amara');
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const reg = (token, who) => S.j('POST', '/push/register', { token }, who);
  for (const t of ['ExponentPushToken[synthetic-a]', 'ExponentPushToken[synthetic-b]']) {
    const r = await reg(t, kola);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.body, { registered: true, moved: false });
  }
  assert.deepEqual(
    playerTokens(dir).map((t) => t.token),
    ['ExponentPushToken[synthetic-a]', 'ExponentPushToken[synthetic-b]'],
    'durable at once',
  );
  const tsBefore = playerTokens(dir)[0].ts;
  await sleep(5);
  assert.deepEqual((await reg('ExponentPushToken[synthetic-a]', kola)).body, { registered: true, moved: false });
  const again = playerTokens(dir);
  assert.equal(again.length, 2, 'one row per token');
  assert.ok(again.find((t) => t.token === 'ExponentPushToken[synthetic-a]').ts > tsBefore, 'its time updated');
  assert.deepEqual(
    (await reg('ExponentPushToken[synthetic-a]', amara)).body,
    { registered: true, moved: true },
    'a shared phone: the guardian signed in on it',
  );
  assert.deepEqual(
    playerTokens(dir).map((t) => t.token),
    ['ExponentPushToken[synthetic-b]'],
  );
  assert.deepEqual(
    stored(dir)
      .pushTokens.filter((t) => t.kind === 'guardian')
      .map((t) => [t.refId, t.token]),
    [['gd-amara', 'ExponentPushToken[synthetic-a]']],
  );
  const snapshot = stored(dir).pushTokens;
  for (const token of [424242, true, { review: 'synthetic' }, ['synthetic'], `ExponentPushToken[${'x'.repeat(200)}]`]) {
    const r = await reg(token, kola);
    assert.equal(r.status, 400, `${JSON.stringify(token).slice(0, 40)}: ${r.text}`);
    assert.equal(r.body.error, 'TOKEN_INVALID');
  }
  for (const b of ['{"token":1e400}', '{"token":-1e400}', '{"token":{"n":1e400}}', '{"token":[1e400]}']) {
    const r = await S.raw('POST', '/push/register', b, kola);
    assert.equal(r.status, 400, b);
    assert.equal(r.body.error, 'TOKEN_INVALID');
  }
  for (const b of ['{"token":0}', '{"token":null}', '{"token":""}', '{"token":false}', '{}']) {
    const r = await S.raw('POST', '/push/register', b, kola);
    assert.equal(r.status, 400, b);
    assert.equal(r.body.error, 'TOKEN_REQUIRED');
  }
  assert.equal((await S.j('POST', '/push/register', { token: 'x' })).status, 401);
  const staff = await reg('ExponentPushToken[synthetic-staff]', maria);
  assert.equal(staff.status, 403, staff.text);
  assert.equal(staff.body.error, 'PUSH_NOT_AVAILABLE');
  assert.deepEqual(stored(dir).pushTokens, snapshot, 'nothing stored by a refusal');
  assert.equal(S.proc.exitCode, null);
  const bk = await S.j('POST', '/admin/backup', {}, null, A);
  assert.equal(bk.status, 201, bk.text);
  assert.deepEqual(stored(bk.body.dir).pushTokens, snapshot, "the backup's database copy carries the tokens");
  await S.stop();
  rm(dir, bk.body.dir);
});

// ============================================================= deletion, backup/restore
await test("an ordinary account deletion leaves the three tables alone (the deleted player's token and push rows stay); the admin backup's database copy carries outbox, push log and tokens row for row (both outbox sources); a restore into a NEW directory boots with the same rows and the admin view lists them", async () => {
  const dir = tempDir('s14d-backup');
  let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const amara = await guardianLogin(S, 'gd-amara');
  const kola = await playerLogin(S, 'pl-adeyemi');
  for (const token of ['ExponentPushToken[synthetic-d]', 'ExponentPushToken[synthetic-e]'])
    assert.equal((await S.j('POST', '/push/register', { token }, kola)).status, 201);
  assert.equal(
    (await S.j('POST', '/push/register', { token: 'ExponentPushToken[synthetic-guardian]' }, amara)).status,
    201,
  );
  assert.equal(
    (
      await S.j(
        'POST',
        '/org/invites',
        { email: 'synthetic-invitee-3@example.invalid', name: 'Synthetic Three', role: 'Scout' },
        maria,
      )
    ).status,
    201,
  );
  const req = await S.j(
    'POST',
    '/org/players/pl-guni/request',
    { type: 'contact', message: 'Synthetic contact request.' },
    maria,
  );
  assert.equal(req.status, 201);
  const notice = await until(async () =>
    (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find(
      (n) => n.type === 'request' && n.refId === req.body.requestId,
    ),
  );
  assert.ok(notice);
  assert.ok(
    await until(async () => {
      await sweep(S);
      return q1(
        dir,
        'SELECT 1 AS one FROM dispatches WHERE notification_id = ? AND channel = ? AND status = ?',
        notice.id,
        'email',
        'accepted',
      );
    }, 15_000),
  );
  const channel = await adultChannel(S, maria, kola);
  assert.equal(
    (await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message' }, maria)).status,
    201,
  );
  assert.ok(
    await until(
      async () => stored(dir).pushLog.some((p) => p.audience.kind === 'player' && p.audience.id === 'pl-adeyemi'),
      8000,
    ),
    'a push row for the player',
  );
  const beforeDel = stored(dir);
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200);
  await until(
    async () =>
      q1(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'")
        .n === 0,
  );
  const afterDel = stored(dir);
  assert.deepEqual(
    afterDel.pushTokens,
    beforeDel.pushTokens,
    "the deleted person's tokens stay (no cascade; retention is open)",
  );
  assert.deepEqual(afterDel.pushLog.slice(0, beforeDel.pushLog.length), beforeDel.pushLog);
  assert.deepEqual(afterDel.outbox.slice(0, beforeDel.outbox.length), beforeDel.outbox);
  const all = stored(dir);
  const bk = await S.j('POST', '/admin/backup', {}, null, A);
  assert.equal(bk.status, 201, bk.text);
  const copy = stored(bk.body.dir);
  assert.deepEqual(copy, all, 'row for row');
  assert.ok(
    copy.outbox.some((m) => Object.hasOwn(m, 'subject')) &&
      copy.outbox.some((m) => Object.hasOwn(m, 'providerMessageId')),
    'both sources',
  );
  await S.stop();
  const restored = tempDir('s14d-restored');
  fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.deepEqual(stored(restored), all, 'restored row for row');
  assert.equal(hasBlobTable(restored), false);
  assert.deepEqual(
    (await S.j('GET', '/admin/outbox?limit=100', undefined, null, A)).body.items.map((m) => m.id),
    all.outbox.map((m) => m.id).reverse(),
    'the admin view lists the restored outbox',
  );
  await S.stop();
  rm(dir, bk.body.dir, restored);
});

// ============================================================= valid input only: a non-string e-mail never reaches the mailer
await test('POST /org/invites and POST /org/verification/player-invites refuse an e-mail that is not a string (an array, an array holding raw JSON 1e400, an object, a number) with 400, storing no invite and no mail record; an ordinary string is answered 201 with its mail record committed; on the live transport (provider intercepted locally) the provider receives the address and its answer is written to the row as soon as it returns', async () => {
  const dir = tempDir('s14d-email');
  const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const logBefore = S.log().length;
  const counts = () =>
    snap(dir, (c) => ({
      mails: readStored(c).outbox.length,
      invites: c.get('SELECT COUNT(*) AS n FROM org_invites').n,
      playerInvites: c.get('SELECT COUNT(*) AS n FROM ver_player_invites').n,
    }));
  const before = counts();
  for (const email of [['synthetic-review@example.invalid'], ['synthetic-second@example.invalid', 'x'], { a: 1 }, 7]) {
    const r = await S.j('POST', '/org/invites', { email, name: 'Synthetic Reviewer', role: 'Scout' }, maria);
    assert.equal(r.status, 400, `${JSON.stringify(email)}: ${r.text}`);
    assert.equal(r.body.error, 'EMAIL_INVALID');
    const p = await S.j('POST', '/org/verification/player-invites', { email, name: 'Synthetic Player' }, maria);
    assert.equal(p.status, 400, `${JSON.stringify(email)}: ${p.text}`);
    assert.equal(p.body.error, 'EMAIL_SYNTAX');
  }
  for (const b of [
    '{"email":[1e400,"synthetic-overflow@example.invalid"],"name":"Synthetic Overflow","role":"Scout"}',
    '{"email":[[-1e400],"synthetic-nested@example.invalid"],"name":"Synthetic Nested","role":"Scout"}',
  ]) {
    const r = await S.raw('POST', '/org/invites', b, maria);
    assert.equal(r.status, 400, b);
    assert.equal(r.body.error, 'EMAIL_INVALID');
  }
  assert.deepEqual(counts(), before, 'no invite, no mail record');
  assert.equal(S.proc.exitCode, null);
  assert.doesNotMatch(S.log().slice(logBefore), /UnhandledPromiseRejection|not recorded/);
  assert.equal(
    (
      await S.j(
        'POST',
        '/org/invites',
        { email: 'synthetic-plain@example.invalid', name: 'Synthetic Plain', role: 'Scout' },
        maria,
      )
    ).status,
    201,
  );
  assert.ok(
    stored(dir).outbox.some((m) => m.to === 'synthetic-plain@example.invalid'),
    'committed at the response',
  );
  assert.equal(
    (
      await S.j(
        'POST',
        '/org/verification/player-invites',
        { email: 'synthetic-player@example.invalid', name: 'Synthetic Player' },
        maria,
      )
    ).status,
    201,
  );
  assert.ok(
    await until(async () => stored(dir).outbox.some((m) => m.to === 'synthetic-player@example.invalid'), 6000),
    "the player invite's mail record",
  );
  await S.stop();
  rm(dir);
  const liveDir = tempDir('s14d-email-live');
  const stubLog = path.join(liveDir, '..', `${path.basename(liveDir)}-sendgrid.log`);
  const SL = await boot(liveDir, {
    SENDGRID_API_KEY: 'synthetic-not-a-real-key',
    SENDGRID_STUB_LOG: stubLog,
    NODE_OPTIONS: `--import=${path.join(HERE, 'testSendgridStub.mjs')}`,
  });
  const lm = await orgLogin(SL, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  assert.equal(
    (
      await SL.j(
        'POST',
        '/org/invites',
        { email: 'synthetic-live@example.invalid', name: 'Synthetic Live', role: 'Scout' },
        lm,
      )
    ).status,
    201,
  );
  const row = await until(async () => {
    const m = stored(liveDir).outbox.find((x) => x.to === 'synthetic-live@example.invalid');
    return m?.delivered ? m : null;
  }, 6000);
  assert.ok(row, "the provider's answer is written to the row without waiting for any later save");
  assert.equal(row.transport, 'sendgrid');
  const providerBody = JSON.parse(fs.readFileSync(stubLog, 'utf8').trim().split('\n').at(-1));
  assert.equal(providerBody.personalizations[0].to[0].email, 'synthetic-live@example.invalid');
  await SL.stop();
  rm(liveDir);
  fs.rmSync(stubLog, { force: true });
});

await test('the push sender hands the live provider (intercepted locally) each registered token of the audience, one call per token', async () => {
  const d = tempDir('s14d-expo');
  const stubLog = path.join(d, '..', `${path.basename(d)}-expo.log`);
  const X = await boot(d, {
    SCOUTBOX_FAST_SWEEPS: '',
    EXPO_ACCESS_TOKEN: 'synthetic-not-a-real-token',
    EXPO_STUB_LOG: stubLog,
    NODE_OPTIONS: `--import=${path.join(HERE, 'testExpoStub.mjs')}`,
  });
  const m = await orgLogin(X, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const k = await playerLogin(X, 'pl-adeyemi');
  for (const token of ['ExponentPushToken[synthetic-1]', 'ExponentPushToken[synthetic-2]'])
    assert.equal((await X.j('POST', '/push/register', { token }, k)).status, 201);
  const channel = await adultChannel(X, m, k);
  await sleep(300);
  fs.writeFileSync(stubLog, '');
  assert.equal(
    (await X.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic payload message' }, m)).status,
    201,
  );
  const lines = await until(async () => {
    const l = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean);
    return l.length >= 2 ? l : null;
  }, 8000);
  assert.ok(lines, 'one provider call per registered token');
  await sleep(300);
  const parsed = fs
    .readFileSync(stubLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    parsed.map((l) => ({ to: l.to, title: l.title })),
    [
      { to: 'ExponentPushToken[synthetic-1]', title: 'ScoutBox' },
      { to: 'ExponentPushToken[synthetic-2]', title: 'ScoutBox' },
    ],
  );
  await X.stop();
  rm(d);
  fs.rmSync(stubLog, { force: true });
});

console.log(`\n${passed} outbox/push server checks passed`);
