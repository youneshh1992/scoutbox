// S7c through the REAL server (server.mjs booted as a child process on temporary
// data directories, synthetic seed records only): the three observations of the
// independent review of 6ca66ba as table-aware regressions — (D1) a push row is
// written AFTER the notification's save committed and lands in a LATER save that
// the sender's nextId()/persist() already schedules (normal mode: about two
// seconds, zero delivery sweeps; accelerated mode: a sweep's save may carry it
// first — never the notification's own save); (D2) POST /push/register accepts
// a string token only (400 TOKEN_INVALID for a number — raw JSON 1e400 included —
// an object or an array), a repeated token replaces its earlier row, tokens are
// preserved through storage, backup and restore; (to:null) an accepted
// queued dispatch without a destination is swept into a delivery outbox record
// with to: null that survives restart and backup — plus the cutover
// itself: the mailer's rows commit in the save their route always used (the
// invite with its invite row, the sign-up with the debounced save, the club
// challenge with the withheld text and the admin view's process-local full text
// until a restart), the sweep's delivery record in the same save as its dispatch
// rows, a failed ordinary save keeping the row pending for the next save (landed
// once), a SIGKILL between the notification's commit and the push save (no push
// row, no re-send), an ordinary deletion leaving the three collections alone, the
// admin backup carrying the three collections in their legacy shapes and a
// restore importing them (migration 0011); POST /org/invites and the m14 player
// invite refusing a non-string e-mail (it used to reach the mailer as an array).
// Every database read goes through a second read-only connection. Nothing here
// touches DATA_DIR or real data; no real provider is called. Run with: npm test
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
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The servers save on a shortened debounce (SCOUTBOX_SAVE_DEBOUNCE_MS) so the suite does not spend its time
 * waiting for the normal 2-second one. `settle(S)` lets one whole save window of that server pass. The servers
 * that measure the real delay, or need the gap before a save (a SIGKILL in it, a row read before the next save),
 * boot with REAL_SAVE_DELAY.
 */
const SAVE_MS = 300;
const settle = (S) => sleep(S.saveMs + 500);
const REAL_SAVE_DELAY = { SCOUTBOX_SAVE_DEBOUNCE_MS: '' };
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const PLACEHOLDER = '[code withheld — delivered to the recipient only]';
/** Five registrations with repeats: three persisted rows (a repeated token removes its earlier row and is appended last). */
const BASELINE_TOKENS = ['ExponentPushToken[synthetic-a]', 'ExponentPushToken[synthetic-a]', 'ExponentPushToken[synthetic-b]', 'ExponentPushToken[synthetic-c]', 'ExponentPushToken[synthetic-b]'];

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', SCOUTBOX_SAVE_DEBOUNCE_MS: String(SAVE_MS), ...env };
    const proc = spawnChild(process.execPath, [server], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
   
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    /** The same request with the body sent as given (raw JSON text): what a client's parser produced is not pre-normalised by JSON.stringify here. */
    const raw = async (method, p, bodyText, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: bodyText });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const saveMs = Number(childEnv.SCOUTBOX_SAVE_DEBOUNCE_MS) || 2000;
    const S = { proc, port, dir, saveMs, log: () => log, j, raw, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
const live = (dir) => !!q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0011_outbox_push'");
const seqOf = (dir) => Number(q1(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0;
const blobRows = (c, name) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
const outboxFromRow = (r) => (r.source === 'mailer' ? { id: r.id, ts: r.created_at, to: r.to_address, subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 } : { id: r.id, at: r.created_at, channel: r.channel, to: r.to_address, text: r.text, providerMessageId: r.provider_message_id, provider: r.transport });
/** The three collections as the DATABASE holds them, in insertion order. */
const readStored = (c) => ({
    outbox: c.all(`SELECT seq, id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id FROM outbox ORDER BY seq`).map(outboxFromRow),
    pushLog: c.all('SELECT id, created_at, audience_kind, audience_id, title, body, transport FROM push_log ORDER BY seq').map((r) => ({ id: r.id, ts: r.created_at, audience: { kind: r.audience_kind, id: r.audience_id }, title: r.title, body: r.body, transport: r.transport })),
    pushTokens: c.all('SELECT ref_kind, ref_id, token, registered_at FROM push_tokens ORDER BY seq').map((r) => ({ kind: r.ref_kind, refId: r.ref_id, token: r.token, ts: r.registered_at })),
    seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0,
});
const stored = (dir) => snap(dir, readStored);
const playerTokens = (dir, id = 'pl-adeyemi') => stored(dir).pushTokens.filter((t) => t.kind === 'player' && t.refId === id);
const orgLogin = async (S, orgId, scoutName, role) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const sweep = async (S) => { const r = await S.j('POST', '/admin/delivery/sweep', {}, null, A); assert.equal(r.status, 200, r.text); return r.body.processed; };
/** The accept of a contact request produces pushes of its own; let them and their debounced save settle before a timing measurement. */
async function adultChannel(S, maria, kola) {
  const req = await S.j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Synthetic review request' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', `/player/requests/${req.body.requestId}/respond`, { accept: true }, kola)).status, 200);
  const channel = (await S.j('GET', '/player/channels', undefined, kola)).body[0]; assert.ok(channel?.id);
  await settle(S);
  return channel;
}
/**
 * Content-free state for a timing failure (the independent review of 40aa05c saw the normal-mode
 * row miss its 12 s window twice on Node 24/macOS and then pass unchanged; the cause is unconfirmed):
 * elapsed time, the save revisions, the row counts, the staged-write and pending-effect counts the
 * server reports, the child's exit code and its log tail with addresses redacted.
 */
async function timingDiagnostics(S, dir, t0, atResponse, before) {
  let cap = null; try { cap = (await S.j('GET', '/capabilities')).body; } catch { /* the child may be gone */ }
  const domains = cap?.persistence?.dataLayer?.domains ?? cap?.dataLayer?.domains ?? {};
  const st = stored(dir);
  return JSON.stringify({ elapsedMs: Date.now() - t0, seqAtResponse: atResponse.seq, seqNow: st.seq, pushRowsBefore: before, pushRowsNow: st.pushLog.length, outboxPushPendingWrites: domains.outboxPush?.pendingWrites ?? null, notificationsPendingEffects: domains.notifications?.pendingEffects ?? null, childExitCode: S.proc.exitCode, logTail: S.log().slice(-1200).replace(/[\w.+-]+@[\w.-]+/g, '<address>') });
}
/** Send one message and watch the push row land WITHOUT any further request: when, with which revision, and how many dispatch rows the notice had by then. */
async function measurePush(S, dir, channel, maria) {
  const before = stored(dir).pushLog.length; const memBefore = (await S.j('GET', '/admin/push-log', undefined, null, A)).body.length;
  const t0 = Date.now();
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic timing message' }, maria)).status, 201);
  const atResponse = snap(dir, (c) => { const st = readStored(c); return { notice: c.get("SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message' ORDER BY seq DESC LIMIT 1"), pushRows: st.pushLog.length, seq: st.seq }; });
  assert.ok(atResponse.notice, 'the notification row is committed when the route answers'); assert.equal(atResponse.pushRows, before, 'the push row is NOT in the notification\'s commit');
  const memory = (await S.j('GET', '/admin/push-log', undefined, null, A)).body; assert.equal(memory.length, memBefore + 1, 'THIS message\'s push row is in memory at once (the after-durable effect ran)');
  const landed = await until(async () => snap(dir, (c) => { const st = readStored(c); if (st.pushLog.length <= before) return null; return { afterMs: Date.now() - t0, seq: st.seq, dispatchRows: c.get('SELECT COUNT(*) AS n FROM dispatches WHERE notification_id = ?', atResponse.notice.id).n, row: st.pushLog.at(-1) }; }), 12_000, 20);
  if (!landed) assert.fail(`the push row landed within 12 s without a further request — ${await timingDiagnostics(S, dir, t0, atResponse, before)}`);
  assert.ok(landed.seq > atResponse.seq, 'the push row is in a LATER save than the notification'); assert.equal(landed.row.audience.kind, 'player'); assert.equal(landed.row.audience.id, 'pl-adeyemi');
  return { ...landed, noticeId: atResponse.notice.id, noticeSeq: atResponse.seq };
}

// ============================================================= [compat] D1 — the push row's existing save scheduling
await test('[compat] D1, normal mode (M13_FAST_RETRY unset, the 60-second sweep never runs): a message commits its notification row at once; the push row is written by the after-durable effect AFTER that commit, is in memory (admin push log) at once but in no save, and lands about two seconds later with a LATER revision through the debounced save the sender\'s nextId() already schedules — with ZERO dispatch rows for the notice (no sweep ran) and no further request; the delay is the existing best-effort debounce, not a guarantee', async () => {
  const dir = tempDir('s7c-d1-normal'); const S = await boot(dir, { M13_FAST_RETRY: '', ...REAL_SAVE_DELAY });
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const channel = await adultChannel(S, maria, kola);
  const m = await measurePush(S, dir, channel, maria);
  assert.equal(m.dispatchRows, 0, 'the normal 60-second sweep did not run: the push row did not ride on a sweep save'); assert.ok(m.afterMs >= 1500 && m.afterMs < 6000, `landed through the 2 s debounce (${m.afterMs} ms)`);
  await S.stop(); rm(dir);
});

await test('[compat] D1, accelerated mode (M13_FAST_RETRY=1, a 400 ms sweep): the push row is still never in the notification\'s commit; it lands in a LATER save — the sweep\'s persistNow() when that comes first (the notice then has its dispatch rows) or the debounced save — in both modes the row\'s durability is "the next save", never the notification\'s preceding commit', async () => {
  const dir = tempDir('s7c-d1-fast'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const channel = await adultChannel(S, maria, kola);
  const m = await measurePush(S, dir, channel, maria);
  assert.ok(m.afterMs < 6000, `landed with a later save (${m.afterMs} ms; ${m.dispatchRows} dispatch rows for the notice at that point)`);
  await S.stop(); rm(dir);
});

// ============================================================= D2 — the registration route's acceptance and matching rule
await test('D2 through the real route: five string registrations with repeats are all answered 201 and persist 3 rows in registration order (a repeated token removes its earlier row and is appended LAST with a new ts); a number, a boolean, an object, an array and raw JSON 1e400 / -1e400 / {"n":1e400} / [1e400] are refused with 400 TOKEN_INVALID and store nothing; unauthenticated and token-less requests are refused as before; the admin backup carries the tokens', async () => {
  const dir = tempDir('s7c-d2'); const S = await boot(dir);
  const kola = await playerLogin(S, 'pl-adeyemi');
  for (const token of BASELINE_TOKENS) { const r = await S.j('POST', '/push/register', { token }, kola); assert.equal(r.status, 201, r.text); assert.deepEqual(r.body, { registered: true }); }
  const three = await until(async () => { const t = playerTokens(dir); return t.length === 3 ? t : null; }, 8000); assert.ok(three, 'three rows persisted');
  assert.deepEqual(three.map((t) => t.token), ['ExponentPushToken[synthetic-a]', 'ExponentPushToken[synthetic-c]', 'ExponentPushToken[synthetic-b]'], 'registration order after the collapses');
  const tsBefore = three[0].ts; await sleep(5);
  assert.equal((await S.j('POST', '/push/register', { token: 'ExponentPushToken[synthetic-a]' }, kola)).status, 201);
  const moved = await until(async () => { const t = playerTokens(dir); return t.length === 3 && t.at(-1).token === 'ExponentPushToken[synthetic-a]' && t.at(-1).ts > tsBefore ? t : null; }, 8000); assert.ok(moved, 'the token moved last with a later ts, the count unchanged');
  for (const token of [424242, true, { review: 'synthetic' }, ['synthetic']]) { const r = await S.j('POST', '/push/register', { token }, kola); assert.equal(r.status, 400, `${JSON.stringify(token)}: ${r.text}`); assert.deepEqual(r.body, { error: 'TOKEN_INVALID' }); }
  for (const b of ['{"token":1e400}', '{"token":-1e400}', '{"token":{"n":1e400}}', '{"token":[1e400]}']) { const r = await S.raw('POST', '/push/register', b, kola); assert.equal(r.status, 400, b); assert.equal(r.body.error, 'TOKEN_INVALID'); }
  for (const b of ['{"token":0}', '{"token":null}', '{"token":""}', '{"token":false}', '{}']) { const r = await S.raw('POST', '/push/register', b, kola); assert.equal(r.status, 400, b); assert.equal(r.body.error, 'TOKEN_REQUIRED', `falsy token refused as before: ${b}`); }
  assert.equal((await S.j('POST', '/push/register', { token: 'x' })).status, 401);
  await settle(S); assert.deepEqual(playerTokens(dir), moved, 'nothing stored by a refusal'); assert.equal(S.proc.exitCode, null);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  assert.deepEqual(playerTokens(bk.body.dir), moved, 'the backup\'s database copy carries the tokens');
  await S.stop(); rm(dir, bk.body.dir);
});

// ============================================================= [compat] the null destination
await test('[compat] an accepted queued dispatch with to: null (the stored state the review of 6ca66ba wrote through the real dispatch repository) is swept by the real boot sweep into a delivery outbox record with an explicit to: null and the dispatch is accepted; the record survives a restart and is listed by the admin outbox; the admin backup carries it with the key present', async () => {
  const dir = tempDir('s7c-null'); let S = await boot(dir); await S.stop();
  const { createDispatchesRepository } = await import('../repositories/dispatches.mjs');
  { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;'); const dispatches = createDispatchesRepository({ sqlite: s, now: Date.now }); dispatches.create({ id: 'synthetic-null-dest', notificationId: 'synthetic-orphan', audience: { kind: 'player', id: 'pl-adeyemi' }, channel: 'email', to: null, provider: 'local-fake', status: 'queued', skipReason: null, providerMessageId: null, attempts: [], nextAt: Date.now(), actionDeadline: null, createdAt: Date.now(), deliveredAt: null, openedAt: null, actionedAt: null, failedAt: null, failReason: null }); s.close(); }
  S = await boot(dir);
  const row = await until(async () => { await sweep(S); return stored(dir).outbox.find((m) => m.provider === 'local-fake' && m.to === null) ?? null; }, 10_000);
  assert.ok(row, 'the sweep wrote and saved a delivery record with to: null'); assert.ok(Object.hasOwn(row, 'to') && row.to === null); assert.equal(row.channel, 'email'); assert.equal(typeof row.providerMessageId, 'string');
  assert.equal(q1(dir, 'SELECT status FROM dispatches WHERE id = ?', 'synthetic-null-dest').status, 'accepted');
  await S.stop(); S = await boot(dir);
  assert.ok(stored(dir).outbox.some((m) => m.id === row.id && m.to === null), 'survives the restart'); const admin = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; assert.ok(admin.some((m) => m.id === row.id && m.to === null), 'listed by the admin view with to: null');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201);
  const entry = stored(bk.body.dir).outbox.find((m) => m.id === row.id); assert.ok(entry && Object.hasOwn(entry, 'to') && entry.to === null, 'the backup\'s database copy keeps the null destination');
  await S.stop(); rm(dir, bk.body.dir);
});

// ============================================================= [cutover] the tables and the mailer's commit points
await test('[cutover] the cutover and the mailer\'s rows: a fresh boot records 0011_outbox_push and creates the three tables with no blob behind them; the org invite\'s mail row is in the SAME revision as the invite row (the route\'s persistNow); the guardian sign-up\'s mail row is absent at the response and lands with the debounced save; the club challenge persists the withheld text while the admin view serves the process-local full text — and the placeholder after a restart; the sweep\'s delivery record is in the same committed state as the dispatch row that carries its provider message id; the admin overview counts the tables', async () => {
  const dir = tempDir('s7c-cut'); let S = await boot(dir);
  assert.ok(live(dir), 'this proof reads the S7c tables'); // fails on the pre-S7c build (6ca66ba): the migration record does not exist
  for (const t of ['outbox', 'push_log', 'push_tokens']) assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  for (const n of ['outbox', 'pushLog', 'pushTokens']) assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM collections WHERE name = ?', n).n, 0, `no ${n} blob after the cutover`);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara');
  // The invite: one revision for the invite row and its mail row.
  await settle(S); const seq0 = seqOf(dir); // the logins' own debounced save lands first, so the count below is the invite's alone
  const invite = await S.j('POST', '/org/invites', { email: 'synthetic-invitee@example.invalid', name: 'Synthetic Invitee', role: 'Scout' }, maria); assert.equal(invite.status, 201, invite.text);
  const after = snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), mail: readStored(c).outbox.find((m) => m.subject && /invited you/.test(m.subject)), inviteRow: (blobRows(c, 'orgInvites') ?? []).some((i) => i.id === invite.body.invite.id) }));
  assert.equal(after.seq, seq0 + 1, 'one save'); assert.ok(after.mail && after.inviteRow, 'the mail row and the invite row are in that save'); assert.equal(after.mail.transport, 'dev-outbox'); assert.equal(after.mail.delivered, true);
  // The sign-up: no save of its own; the debounced one carries it.
  const signup = await S.j('POST', '/auth/guardian/signup', { name: 'Synthetic Guardian', email: 'synthetic-guardian@example.invalid', password: 'synthetic-password-1' }); assert.equal(signup.status, 201, signup.text);
  const memSignup = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.find((m) => m.subject && /guardian account/i.test(m.subject)); assert.ok(memSignup, 'in memory at once');
  assert.equal(stored(dir).outbox.some((m) => m.id === memSignup.id), false, 'not in the database at the response');
  assert.ok(await until(async () => stored(dir).outbox.some((m) => m.id === memSignup.id), 6000), 'landed with the debounced save');
  // The challenge: the withheld text is the column; the full text is process memory.
  const challenge = await S.j('POST', '/org/verification/email', { email: 'synthetic-club@example-club.invalid' }, maria); assert.equal(challenge.status, 201, challenge.text);
  const memChallenge = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.find((m) => m.subject && /^Verify .* on ScoutBox$/.test(m.subject)); assert.ok(memChallenge);
  const dbChallenge = await until(async () => stored(dir).outbox.find((m) => m.id === memChallenge.id) ?? null, 6000);
  assert.ok(dbChallenge.text.includes(PLACEHOLDER), 'the column holds the withheld text'); assert.equal(memChallenge.text.includes(PLACEHOLDER), false, 'the admin view serves the full text from memory'); assert.notEqual(memChallenge.text, dbChallenge.text);
  assert.doesNotMatch(S.log(), /synthetic-guardian@|synthetic-club@/, 'no address in the log');
  // The sweep: the delivery record and the dispatch row that references it are in one committed state.
  const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic contact request about the under-18 player.' }, maria); assert.equal(req.status, 201, req.text);
  const notice = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req.body.requestId)); assert.ok(notice);
  const pair = await until(async () => { await sweep(S); return snap(dir, (c) => { const d = c.get('SELECT provider_message_id, status FROM dispatches WHERE notification_id = ? AND channel = ?', notice.id, 'email'); if (!d || d.status !== 'accepted') return null; const row = readStored(c).outbox.find((m) => m.providerMessageId === d.provider_message_id); return { d, row }; }); }, 15_000);
  assert.ok(pair?.row, 'the delivery record is committed with the accepted dispatch row'); assert.equal(pair.row.provider, 'local-fake'); assert.equal(pair.row.channel, 'email'); assert.equal(typeof pair.row.to, 'string');
  const overview = (await S.j('GET', '/admin/overview', undefined, null, A)).body; assert.equal(overview.emailsSent, stored(dir).outbox.length, 'the overview counts the table');
  // Restart: the admin view now serves the placeholder (the process memory is gone), same ids, same order.
  const idsBefore = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.map((m) => m.id);
  await S.stop(); S = await boot(dir);
  const viewAfter = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(viewAfter.map((m) => m.id), idsBefore); assert.ok(viewAfter.find((m) => m.id === memChallenge.id).text.includes(PLACEHOLDER), 'the placeholder after the restart');
  assert.doesNotMatch(S.log(), /0011_outbox_push/, 'the second boot applies nothing');
  await S.stop(); rm(dir);
});

// ============================================================= [cutover] a failed ordinary save keeps the pending state; a SIGKILL window
await test('[cutover] a failed ordinary save (internal:save.sqlite_commit at the REAL COMMIT) leaves the invite\'s mail row and a registration pending in memory and absent from the tables while the route already answered; the next save lands them ONCE (never twice); a SIGKILL right after a message\'s response — before the push row\'s later save — keeps the notification row and loses the push row: the restart does not re-send it (no push row for that notice after a sweep and the debounce window), the documented crash window', async () => {
  const dir = tempDir('s7c-fail'); let S = await boot(dir, { M13_FAST_RETRY: '' });
  let maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); let kola = await playerLogin(S, 'pl-adeyemi');
  await settle(S); const before = stored(dir); const logBefore = S.log().length; // the logins' own save lands first: the injected failure is for the invite's
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  const invite = await S.j('POST', '/org/invites', { email: 'synthetic-invitee-2@example.invalid', name: 'Synthetic Two', role: 'Scout' }, maria); assert.equal(invite.status, 201, 'the route answers although its save failed');
  assert.ok(await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 5000), 'the save failed at the real COMMIT');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const mid = stored(dir); assert.equal(mid.outbox.length, before.outbox.length, 'no mail row landed'); assert.equal(mid.seq, before.seq);
  assert.ok((await S.j('GET', '/admin/outbox', undefined, null, A)).body.some((m) => m.subject && /invited you/.test(m.subject)), 'memory is the intended state');
  assert.equal((await S.j('POST', '/push/register', { token: 'synthetic-device-token' }, kola)).status, 201); // schedules the next (debounced) save: it carries the pending mail row too
  const landed = await until(async () => { const st = stored(dir); return st.outbox.length === before.outbox.length + 1 && st.pushTokens.length === before.pushTokens.length + 1 ? st : null; }, 8000);
  assert.ok(landed, 'the next save landed the mail row and the token'); assert.equal(landed.outbox.filter((m) => m.subject && /invited you/.test(m.subject)).length, 1, 'once');
  await settle(S); assert.equal(stored(dir).outbox.length, before.outbox.length + 1, 'a later save does not replay');
  // The crash window between the notification's commit and the push row's later save: the real delay, so the SIGKILL lands inside it.
  await S.stop(); S = await boot(dir, { M13_FAST_RETRY: '', ...REAL_SAVE_DELAY });
  maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); kola = await playerLogin(S, 'pl-adeyemi');
  const channel = await adultChannel(S, maria, kola);
  const pushBefore = stored(dir).pushLog.length;
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message before the crash' }, maria)).status, 201);
  const notice = q1(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message' ORDER BY seq DESC LIMIT 1"); assert.ok(notice, 'the notification row is committed');
  assert.equal(stored(dir).pushLog.length, pushBefore, 'the push row is not in that commit'); await S.kill();
  assert.equal(stored(dir).pushLog.length, pushBefore, 'the push row never reached the file');
  S = await boot(dir);
  assert.ok(q1(dir, 'SELECT id FROM notifications WHERE id = ?', notice.id), 'the notification survived'); await sweep(S); await settle(S);
  assert.equal(stored(dir).pushLog.length, pushBefore, 'no re-send on restart: the push row is lost, the notification is intact (the documented crash window)');
  await S.stop(); rm(dir);
});

// ============================================================= [cutover] deletion, backup/restore
await test('[cutover] an ordinary account deletion leaves the three tables alone (the deleted player\'s token rows and push rows stay); the admin backup\'s database copy carries outbox, pushLog and pushTokens row for row (both outbox literals, the null destination, the tokens); a restore into a NEW directory boots with the same rows and no blob', async () => {
  const dir = tempDir('s7c-backup'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara'); let kola = await playerLogin(S, 'pl-adeyemi');
  for (const token of [...BASELINE_TOKENS, 'ExponentPushToken[synthetic-d]', 'ExponentPushToken[synthetic-e]', 'ExponentPushToken[synthetic-f]', 'ExponentPushToken[synthetic-g]']) assert.equal((await S.j('POST', '/push/register', { token }, kola)).status, 201);
  assert.equal((await S.j('POST', '/push/register', { token: 'ExponentPushToken[synthetic-guardian]' }, amara)).status, 201);
  assert.equal((await S.j('POST', '/org/invites', { email: 'synthetic-invitee-3@example.invalid', name: 'Synthetic Three', role: 'Scout' }, maria)).status, 201);
  const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic contact request.' }, maria); assert.equal(req.status, 201);
  const notice = await until(async () => (await S.j('GET', '/guardian/notifications', undefined, amara)).body?.find((n) => n.type === 'request' && n.refId === req.body.requestId)); assert.ok(notice);
  assert.ok(await until(async () => { await sweep(S); return q1(dir, 'SELECT 1 AS one FROM dispatches WHERE notification_id = ? AND channel = ? AND status = ?', notice.id, 'email', 'accepted'); }, 15_000));
  // A null destination through the real dispatch repository (the review's case), then the channel pushes.
  await S.stop();
  { const { createDispatchesRepository } = await import('../repositories/dispatches.mjs'); const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.exec('PRAGMA foreign_keys = ON;'); createDispatchesRepository({ sqlite: s, now: Date.now }).create({ id: 'synthetic-null-dest', notificationId: 'synthetic-orphan', audience: { kind: 'player', id: 'pl-adeyemi' }, channel: 'email', to: null, provider: 'local-fake', status: 'queued', skipReason: null, providerMessageId: null, attempts: [], nextAt: Date.now(), actionDeadline: null, createdAt: Date.now(), deliveredAt: null, openedAt: null, actionedAt: null, failedAt: null, failReason: null }); s.close(); }
  S = await boot(dir); kola = await playerLogin(S, 'pl-adeyemi');
  assert.ok(await until(async () => { await sweep(S); return stored(dir).outbox.some((m) => m.provider === 'local-fake' && m.to === null); }, 10_000), 'the null-destination delivery record');
  const channel = await adultChannel(S, maria, kola);
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message' }, maria)).status, 201);
  assert.ok(await until(async () => stored(dir).pushLog.some((p) => p.audience.kind === 'player' && p.audience.id === 'pl-adeyemi'), 8000), 'a push row for the player');
  await settle(S);
  // Deletion leaves the three tables alone.
  const beforeDel = stored(dir); const playerRows = { tokens: beforeDel.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length, pushes: beforeDel.pushLog.filter((p) => p.audience.kind === 'player' && p.audience.id === 'pl-adeyemi').length };
  assert.ok(playerRows.tokens >= 7 && playerRows.pushes >= 1);
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200); await until(async () => q1(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").n === 0); await settle(S);
  const afterDel = stored(dir); assert.deepEqual([afterDel.outbox.length, afterDel.pushLog.length, afterDel.pushTokens.length], [beforeDel.outbox.length, beforeDel.pushLog.length, beforeDel.pushTokens.length], 'untouched by the deletion');
  assert.equal(afterDel.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length, playerRows.tokens, 'the deleted person\'s token rows stay (no cascade, by decision)');
  // The backup.
  const all = stored(dir); const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const copy = stored(bk.body.dir);
  assert.deepEqual(copy.outbox, all.outbox, 'both outbox literals, the null destination present'); assert.deepEqual(copy.pushLog, all.pushLog); assert.deepEqual(copy.pushTokens, all.pushTokens, 'the tokens');
  assert.ok(copy.outbox.some((m) => Object.hasOwn(m, 'to') && m.to === null)); assert.ok(copy.outbox.some((m) => Object.hasOwn(m, 'subject')) && copy.outbox.some((m) => !Object.hasOwn(m, 'subject') && Object.hasOwn(m, 'providerMessageId')));
  assert.equal(copy.pushTokens.filter((t) => t.kind === 'player').length, 7);
  await S.stop();
  const restored = tempDir('s7c-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored));
  const back = stored(restored); assert.deepEqual([back.outbox, back.pushLog, back.pushTokens], [all.outbox, all.pushLog, all.pushTokens], 'restored row for row');
  for (const n of ['outbox', 'pushLog', 'pushTokens']) assert.equal(q1(restored, 'SELECT COUNT(*) AS n FROM collections WHERE name = ?', n).n, 0, 'no blob');
  assert.equal((await S.j('GET', '/admin/outbox', undefined, null, A)).body.length, all.outbox.length, 'the admin view lists the restored outbox');
  await S.stop();
  rm(dir, bk.body.dir, restored);
});

// ============================================================= valid input only: a non-string e-mail never reaches the mailer
await test('[valid input only] POST /org/invites and POST /org/verification/player-invites refuse an e-mail that is not a string — a JSON array (which RegExp.test / emailProblem used to coerce, handing the ORIGINAL array to the mailer), an array holding raw JSON 1e400, an object, a number — with 400 (EMAIL_INVALID / EMAIL_SYNTAX), storing no invite and no mail record; an ordinary string is answered 201 with its mail record in the route\'s one save, as before; on the live transport (provider intercepted locally) the provider receives the string and the row records its answer with the next save', async () => {
  const dir = tempDir('s7c-email'); const S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const logBefore = S.log().length;
  const counts = () => snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), mails: readStored(c).outbox.length, invites: (blobRows(c, 'orgInvites') ?? []).length, playerInvites: (blobRows(c, 'verPlayerInvites') ?? []).length }));
  await settle(S); const before = counts(); // the login's own debounced save lands first
  for (const email of [['synthetic-review@example.invalid'], ['synthetic-second@example.invalid', 'x'], { a: 1 }, 7]) {
    const r = await S.j('POST', '/org/invites', { email, name: 'Synthetic Reviewer', role: 'Scout' }, maria); assert.equal(r.status, 400, `${JSON.stringify(email)}: ${r.text}`); assert.equal(r.body.error, 'EMAIL_INVALID');
    const p = await S.j('POST', '/org/verification/player-invites', { email, name: 'Synthetic Player' }, maria); assert.equal(p.status, 400, `${JSON.stringify(email)}: ${p.text}`); assert.equal(p.body.error, 'EMAIL_SYNTAX');
  }
  for (const b of ['{"email":[1e400,"synthetic-overflow@example.invalid"],"name":"Synthetic Overflow","role":"Scout"}', '{"email":[[-1e400],"synthetic-nested@example.invalid"],"name":"Synthetic Nested","role":"Scout"}']) { const r = await S.raw('POST', '/org/invites', b, maria); assert.equal(r.status, 400, b); assert.equal(r.body.error, 'EMAIL_INVALID'); }
  await settle(S); assert.deepEqual(counts(), before, 'no invite, no mail record, no save (a whole save window passed)'); assert.equal(S.proc.exitCode, null); assert.doesNotMatch(S.log().slice(logBefore), /UnhandledPromiseRejection|not recorded/);
  const ok = await S.j('POST', '/org/invites', { email: 'synthetic-plain@example.invalid', name: 'Synthetic Plain', role: 'Scout' }, maria); assert.equal(ok.status, 201, ok.text);
  const after = snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), mail: readStored(c).outbox.find((m) => /Hi Synthetic Plain,/.test(m.text)) }));
  assert.equal(after.seq, before.seq + 1, 'one save (the route\'s persistNow)'); assert.equal(after.mail?.to, 'synthetic-plain@example.invalid');
  const pOk = await S.j('POST', '/org/verification/player-invites', { email: 'synthetic-player@example.invalid', name: 'Synthetic Player' }, maria); assert.equal(pOk.status, 201, pOk.text);
  assert.ok(await until(async () => stored(dir).outbox.some((m) => m.to === 'synthetic-player@example.invalid'), 6000), 'the player invite\'s mail record');
  await S.stop(); rm(dir);
  // Live transport, provider intercepted locally (never a real request).
  const liveDir = tempDir('s7c-email-live'); const stubLog = path.join(liveDir, '..', `${path.basename(liveDir)}-sendgrid.log`);
  const SL = await boot(liveDir, { SENDGRID_API_KEY: 'synthetic-not-a-real-key', SENDGRID_STUB_LOG: stubLog, NODE_OPTIONS: `--import=${path.join(HERE, 'testSendgridStub.mjs')}`, ...REAL_SAVE_DELAY }); // reads the row BEFORE the next save
  const lm = await orgLogin(SL, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const byName = (list, n) => list.find((m) => typeof m.text === 'string' && m.text.includes(`Hi ${n},`));
  assert.equal((await SL.j('POST', '/org/invites', { email: 'synthetic-live@example.invalid', name: 'Synthetic Live', role: 'Scout' }, lm)).status, 201); await sleep(600); assert.equal(SL.proc.exitCode, null);
  const providerBody = JSON.parse(fs.readFileSync(stubLog, 'utf8').trim().split('\n').at(-1)); assert.equal(providerBody.personalizations[0].to[0].email, 'synthetic-live@example.invalid');
  const liveMem = byName((await SL.j('GET', '/admin/outbox', undefined, null, A)).body, 'Synthetic Live'); assert.deepEqual([liveMem.transport, liveMem.delivered], ['sendgrid', true], 'the provider\'s answer on the record at once (memory)');
  assert.equal(byName(stored(liveDir).outbox, 'Synthetic Live').delivered, false, 'the route\'s save carried the record before the provider answered; the answer lands with the NEXT save');
  assert.equal((await SL.j('POST', '/org/invites', { email: 'synthetic-live-2@example.invalid', name: 'Synthetic Live Two', role: 'Scout' }, lm)).status, 201); // that next save
  const liveRow = byName(stored(liveDir).outbox, 'Synthetic Live'); assert.deepEqual([liveRow.transport, liveRow.delivered, liveRow.to], ['sendgrid', true, 'synthetic-live@example.invalid'], 'the provider\'s answer recorded on the row');
  await SL.stop(); rm(liveDir); fs.rmSync(stubLog, { force: true });
});

await test('the push sender hands the live provider (intercepted locally) each registered string token of the audience, one call per token', async () => {
  const d = tempDir('s7c-expo'); const stubLog = path.join(d, '..', `${path.basename(d)}-expo.log`);
  const X = await boot(d, { M13_FAST_RETRY: '', EXPO_ACCESS_TOKEN: 'synthetic-not-a-real-token', EXPO_STUB_LOG: stubLog, NODE_OPTIONS: `--import=${path.join(HERE, 'testExpoStub.mjs')}` });
  const m = await orgLogin(X, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const k = await playerLogin(X, 'pl-adeyemi');
  for (const token of ['ExponentPushToken[synthetic-1]', 'ExponentPushToken[synthetic-2]']) assert.equal((await X.j('POST', '/push/register', { token }, k)).status, 201);
  const channel = await adultChannel(X, m, k); fs.writeFileSync(stubLog, '');
  assert.equal((await X.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic payload message' }, m)).status, 201);
  const lines = await until(async () => { const l = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean); return l.length >= 2 ? l : null; }, 8000); assert.ok(lines, 'one provider call per registered token');
  await sleep(300); const parsed = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((l) => ({ to: l.to, title: l.title })), [{ to: 'ExponentPushToken[synthetic-1]', title: 'ScoutBox' }, { to: 'ExponentPushToken[synthetic-2]', title: 'ScoutBox' }]);
  await X.stop(); rm(d); fs.rmSync(stubLog, { force: true });
});

console.log(`\n${passed} outbox/push server checks passed`);
