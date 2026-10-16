// S7c through the REAL server (server.mjs booted as a child process on temporary
// data directories, synthetic seed records only): the three observations of the
// independent review of 6ca66ba as table-aware regressions — (D1) a push row is
// written AFTER the notification's save committed and lands in a LATER save that
// the sender's nextId()/persist() already schedules (normal mode: about two
// seconds, zero delivery sweeps; accelerated mode: a sweep's save may carry it
// first — never the notification's own save); (D2) POST /push/register keeps
// accepting any truthy JSON token, primitives collapse by strict equality,
// structurally equal objects and arrays are separate rows, values and types are
// preserved through storage, backup, restore and rollback; (to:null) an accepted
// queued dispatch without a destination is swept into a delivery outbox record
// with to: null that survives restart, backup and rollback — plus the cutover
// itself: the mailer's rows commit in the save their route always used (the
// invite with its invite row, the sign-up with the debounced save, the club
// challenge with the withheld text and the admin view's process-local full text
// until a restart), the sweep's delivery record in the same save as its dispatch
// rows, a failed ordinary save keeping the row pending for the next save (landed
// once), a SIGKILL between the notification's commit and the push save (no push
// row, no re-send), an ordinary deletion leaving the three collections alone, the
// admin backup carrying the three collections in their legacy shapes and a
// restore importing them (migration 0011), the S7b tool refusing the file, the
// copy-only rollback booted by the accepted 6ca66ba build (SCOUTBOX_PRE_S7C_SERVER)
// which reads the same records and keeps writing to its blobs, and the re-upgrade.
// Every database read goes through a second read-only connection. Nothing here
// touches DATA_DIR or real data; no real provider is called. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 6ca66ba tree before the implementation):
// [compat] tests read the collections through a storage adapter (the tables after the
// cutover, the blobs before it) and PASS on both trees — they are the review's
// observations, preserved; [cutover] tests assert the tables, the absence of the
// blobs and the migration record and FAIL on 6ca66ba on concrete assertions.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const PLACEHOLDER = '[code withheld — delivered to the recipient only]';
/** The nine registrations of the independent baseline: 7 persisted rows (1 number, 1 string, 1 boolean, 2 objects, 2 arrays). */
const BASELINE_TOKENS = [424242, 424242, '424242', true, true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic']];
const typeCounts = (tokens) => ({ numbers: tokens.filter((t) => typeof t === 'number').length, strings: tokens.filter((t) => typeof t === 'string').length, booleans: tokens.filter((t) => typeof t === 'boolean').length, objects: tokens.filter((t) => t && typeof t === 'object' && !Array.isArray(t)).length, arrays: tokens.filter(Array.isArray).length });

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
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
const live = (dir) => !!q1(dir, "SELECT 1 AS one FROM data_migrations WHERE id = '0011_outbox_push'");
const seqOf = (dir) => Number(q1(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0;
const blobRows = (c, name) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
const outboxFromRow = (r) => (r.source === 'mailer' ? { id: r.id, ts: r.created_at, to: r.to_address, subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 } : { id: r.id, at: r.created_at, channel: r.channel, to: r.to_address, text: r.text, providerMessageId: r.provider_message_id, provider: r.transport });
/** The three collections as the DATABASE holds them, in insertion order: the tables after the cutover, the blobs before it (so a check reads the same way on both builds). */
const readStored = (c) => {
  const cut = !!c.get("SELECT 1 AS one FROM data_migrations WHERE id = '0011_outbox_push'");
  if (!cut) return { outbox: blobRows(c, 'outbox') ?? [], pushLog: blobRows(c, 'pushLog') ?? [], pushTokens: blobRows(c, 'pushTokens') ?? [], seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0 };
  return {
    outbox: c.all('SELECT seq, id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id FROM outbox ORDER BY seq').map(outboxFromRow),
    pushLog: c.all('SELECT id, created_at, audience_kind, audience_id, title, body, transport FROM push_log ORDER BY seq').map((r) => ({ id: r.id, ts: r.created_at, audience: { kind: r.audience_kind, id: r.audience_id }, title: r.title, body: r.body, transport: r.transport })),
    pushTokens: c.all('SELECT ref_kind, ref_id, token_json, registered_at FROM push_tokens ORDER BY seq').map((r) => ({ kind: r.ref_kind, refId: r.ref_id, token: JSON.parse(r.token_json), ts: r.registered_at })),
    seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0,
  };
};
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
  await sleep(2600);
  return channel;
}
/** Send one message and watch the push row land WITHOUT any further request: when, with which revision, and how many dispatch rows the notice had by then. */
async function measurePush(S, dir, channel, maria) {
  const before = stored(dir).pushLog.length;
  const t0 = Date.now();
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic timing message' }, maria)).status, 201);
  const atResponse = snap(dir, (c) => { const st = readStored(c); return { notice: c.get("SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message' ORDER BY seq DESC LIMIT 1"), pushRows: st.pushLog.length, seq: st.seq }; });
  assert.ok(atResponse.notice, 'the notification row is committed when the route answers'); assert.equal(atResponse.pushRows, before, 'the push row is NOT in the notification\'s commit');
  const memory = (await S.j('GET', '/admin/push-log', undefined, null, A)).body; assert.ok(memory.length > 0);
  const landed = await until(async () => snap(dir, (c) => { const st = readStored(c); if (st.pushLog.length <= before) return null; return { afterMs: Date.now() - t0, seq: st.seq, dispatchRows: c.get('SELECT COUNT(*) AS n FROM dispatches WHERE notification_id = ?', atResponse.notice.id).n, row: st.pushLog.at(-1) }; }), 12_000, 20);
  assert.ok(landed, 'the push row landed within 12 s without a further request');
  assert.ok(landed.seq > atResponse.seq, 'the push row is in a LATER save than the notification'); assert.equal(landed.row.audience.kind, 'player'); assert.equal(landed.row.audience.id, 'pl-adeyemi');
  return { ...landed, noticeId: atResponse.notice.id, noticeSeq: atResponse.seq };
}

// ============================================================= [compat] D1 — the push row's existing save scheduling
await test('[compat] D1, normal mode (M13_FAST_RETRY unset, the 60-second sweep never runs): a message commits its notification row at once; the push row is written by the after-durable effect AFTER that commit, is in memory (admin push log) at once but in no save, and lands about two seconds later with a LATER revision through the debounced save the sender\'s nextId() already schedules — with ZERO dispatch rows for the notice (no sweep ran) and no further request; the delay is the existing best-effort debounce, not a guarantee', async () => {
  const dir = tempDir('s7c-d1-normal'); const S = await boot(dir, { M13_FAST_RETRY: '' });
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

// ============================================================= [compat] D2 — the registration route's acceptance and matching rule
await test('[compat] D2 through the real route: nine registrations of number, string, boolean, structurally equal objects and equal arrays are all answered 201 and persist 7 rows (1/1/1/2/2) with their types in registration order; re-registering a primitive removes its earlier row and appends it LAST with a new ts, 424242 and "424242" are different tokens; an object registered again is a new row; the admin backup carries the tokens with their values and types; unauthenticated and token-less requests are refused as before', async () => {
  const dir = tempDir('s7c-d2'); const S = await boot(dir);
  const kola = await playerLogin(S, 'pl-adeyemi');
  for (const token of BASELINE_TOKENS) { const r = await S.j('POST', '/push/register', { token }, kola); assert.equal(r.status, 201, r.text); assert.deepEqual(r.body, { registered: true }); }
  const seven = await until(async () => { const t = playerTokens(dir); return t.length === 7 ? t : null; }, 8000); assert.ok(seven, 'seven rows persisted');
  assert.deepEqual(typeCounts(seven.map((t) => t.token)), { numbers: 1, strings: 1, booleans: 1, objects: 2, arrays: 2 });
  assert.deepEqual(seven.map((t) => t.token), [424242, '424242', true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic']], 'registration order after the collapses');
  const tsBefore = seven[0].ts; await sleep(5);
  assert.equal((await S.j('POST', '/push/register', { token: 424242 }, kola)).status, 201);
  const moved = await until(async () => { const t = playerTokens(dir); return t.length === 7 && t.at(-1).token === 424242 && t.at(-1).ts > tsBefore ? t : null; }, 8000); assert.ok(moved, 'the primitive moved last with a later ts, the count unchanged');
  assert.deepEqual(moved.map((t) => t.token), ['424242', true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic'], 424242]);
  assert.equal((await S.j('POST', '/push/register', { token: { review: 'synthetic' } }, kola)).status, 201);
  const eight = await until(async () => { const t = playerTokens(dir); return t.length === 8 ? t : null; }, 8000); assert.ok(eight, 'an object is always a new row'); assert.deepEqual(eight.at(-1).token, { review: 'synthetic' });
  assert.equal((await S.j('POST', '/push/register', { token: 'x' })).status, 401); assert.equal((await S.j('POST', '/push/register', {}, kola)).status, 400); assert.equal((await S.j('POST', '/push/register', { token: 0 }, kola)).status, 400, 'a falsy token is refused as before');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.deepEqual(snapshot.db.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi'), eight, 'the backup carries values and types');
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
  const entry = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8')).db.outbox.find((m) => m.id === row.id); assert.ok(entry && Object.hasOwn(entry, 'to') && entry.to === null, 'the backup keeps the key present and null');
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
  const seq0 = seqOf(dir);
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
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const kola = await playerLogin(S, 'pl-adeyemi');
  const before = stored(dir); const logBefore = S.log().length;
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  const invite = await S.j('POST', '/org/invites', { email: 'synthetic-invitee-2@example.invalid', name: 'Synthetic Two', role: 'Scout' }, maria); assert.equal(invite.status, 201, 'the route answers although its save failed');
  assert.ok(await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 5000), 'the save failed at the real COMMIT');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  const mid = stored(dir); assert.equal(mid.outbox.length, before.outbox.length, 'no mail row landed'); assert.equal(mid.seq, before.seq);
  assert.ok((await S.j('GET', '/admin/outbox', undefined, null, A)).body.some((m) => m.subject && /invited you/.test(m.subject)), 'memory is the intended state');
  assert.equal((await S.j('POST', '/push/register', { token: 'synthetic-device-token' }, kola)).status, 201); // schedules the next (debounced) save: it carries the pending mail row too
  const landed = await until(async () => { const st = stored(dir); return st.outbox.length === before.outbox.length + 1 && st.pushTokens.length === before.pushTokens.length + 1 ? st : null; }, 8000);
  assert.ok(landed, 'the next save landed the mail row and the token'); assert.equal(landed.outbox.filter((m) => m.subject && /invited you/.test(m.subject)).length, 1, 'once');
  await sleep(2500); assert.equal(stored(dir).outbox.length, before.outbox.length + 1, 'a later save does not replay');
  // The crash window between the notification's commit and the push row's later save.
  const channel = await adultChannel(S, maria, kola);
  const pushBefore = stored(dir).pushLog.length;
  assert.equal((await S.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic message before the crash' }, maria)).status, 201);
  const notice = q1(dir, "SELECT id FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi' AND type = 'message' ORDER BY seq DESC LIMIT 1"); assert.ok(notice, 'the notification row is committed');
  assert.equal(stored(dir).pushLog.length, pushBefore, 'the push row is not in that commit'); await S.kill();
  assert.equal(stored(dir).pushLog.length, pushBefore, 'the push row never reached the file');
  S = await boot(dir);
  assert.ok(q1(dir, 'SELECT id FROM notifications WHERE id = ?', notice.id), 'the notification survived'); await sweep(S); await sleep(2600);
  assert.equal(stored(dir).pushLog.length, pushBefore, 'no re-send on restart: the push row is lost, the notification is intact (the documented crash window)');
  await S.stop(); rm(dir);
});

// ============================================================= [cutover] deletion, backup/restore, rollback, the old build, re-upgrade
await test('[cutover] an ordinary account deletion leaves the three tables alone (the deleted player\'s token rows and push rows stay); the admin backup exports outbox, pushLog and pushTokens in their legacy shapes (both outbox literals, the null destination, token values and types); a restore into a NEW directory imports them (migration 0011) row for row; a backup whose outbox entry matches both shapes is refused at boot (OUTBOX_PUSH_IMPORT_BLOCKED, no address in the log) and creates no table; the S7b rollback tool refuses the S7c file (exit 4); the copy-only rollback writes the three blobs back and, with SCOUTBOX_PRE_S7C_SERVER set, the accepted 6ca66ba build boots the copy, lists the same outbox and push-log records in the same order, registers a token and sends a mail into its blobs; this build then re-upgrades the copy with every row, the old build\'s included', async () => {
  const dir = tempDir('s7c-backup'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const amara = await guardianLogin(S, 'gd-amara'); let kola = await playerLogin(S, 'pl-adeyemi');
  for (const token of BASELINE_TOKENS) assert.equal((await S.j('POST', '/push/register', { token }, kola)).status, 201);
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
  await sleep(2600);
  // Deletion leaves the three tables alone.
  const beforeDel = stored(dir); const playerRows = { tokens: beforeDel.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length, pushes: beforeDel.pushLog.filter((p) => p.audience.kind === 'player' && p.audience.id === 'pl-adeyemi').length };
  assert.ok(playerRows.tokens >= 7 && playerRows.pushes >= 1);
  assert.equal((await S.j('DELETE', '/player/account', {}, kola)).status, 200); await until(async () => q1(dir, "SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = 'player' AND audience_id = 'pl-adeyemi'").n === 0); await sleep(2600);
  const afterDel = stored(dir); assert.deepEqual([afterDel.outbox.length, afterDel.pushLog.length, afterDel.pushTokens.length], [beforeDel.outbox.length, beforeDel.pushLog.length, beforeDel.pushTokens.length], 'untouched by the deletion');
  assert.equal(afterDel.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').length, playerRows.tokens, 'the deleted person\'s token rows stay (no cascade, by decision)');
  // The backup.
  const all = stored(dir); const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.deepEqual(snapshot.db.outbox, all.outbox, 'both outbox literals, the null destination present'); assert.deepEqual(snapshot.db.pushLog, all.pushLog); assert.deepEqual(snapshot.db.pushTokens, all.pushTokens, 'tokens with values and types');
  assert.ok(snapshot.db.outbox.some((m) => Object.hasOwn(m, 'to') && m.to === null)); assert.ok(snapshot.db.outbox.some((m) => Object.hasOwn(m, 'subject')) && snapshot.db.outbox.some((m) => !Object.hasOwn(m, 'subject') && Object.hasOwn(m, 'providerMessageId')));
  assert.deepEqual(typeCounts(snapshot.db.pushTokens.filter((t) => t.kind === 'player').map((t) => t.token)), { numbers: 1, strings: 1, booleans: 1, objects: 2, arrays: 2 });
  await S.stop();
  const restored = tempDir('s7c-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored), 'the restore imported through 0011');
  const back = stored(restored); assert.deepEqual([back.outbox, back.pushLog, back.pushTokens], [all.outbox, all.pushLog, all.pushTokens], 'imported row for row');
  for (const n of ['outbox', 'pushLog', 'pushTokens']) assert.equal(q1(restored, 'SELECT COUNT(*) AS n FROM collections WHERE name = ?', n).n, 0, 'no blob left behind');
  const record = JSON.parse(q1(restored, "SELECT value FROM meta WHERE key = 'outboxPushCutover'").value); assert.equal(record.outbox.imported, all.outbox.length); assert.equal(record.pushTokens.imported, all.pushTokens.length); assert.doesNotMatch(JSON.stringify(record), /example\.invalid|ExponentPushToken|424242/);
  await S.stop();
  const bad = tempDir('s7c-bad'); fs.cpSync(bk.body.dir, bad, { recursive: true });
  { const j = JSON.parse(fs.readFileSync(path.join(bad, 'db.json'), 'utf8')); j.db.outbox[0].channel = 'email'; j.db.outbox[0].providerMessageId = 'fm_x'; fs.writeFileSync(path.join(bad, 'db.json'), JSON.stringify(j)); }
  const refusedBoot = await (async () => { try { const x = await boot(bad); await x.kill(); throw new Error('must refuse'); } catch (e) { if (typeof e.code !== 'number') throw e; return e; } })();
  assert.match(refusedBoot.log, /OUTBOX_PUSH_IMPORT_BLOCKED/); assert.match(refusedBoot.log, /matches both outbox shapes/); assert.equal(/example\.invalid/.test(refusedBoot.log), false, 'no address in the log'); assert.equal(live(bad), false);
  // The S7b tool refuses the S7c file.
  try { execFileSync(process.execPath, [path.join(HERE, 'dispatchesRollback.mjs'), dir, tempDir('s7c-s7btool')], { stdio: 'pipe' }); assert.fail('must refuse'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // The copy-only rollback booted by the accepted build.
  const copy = tempDir('s7c-rollback');
  const out = execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), dir, copy], { encoding: 'utf8' });
  assert.match(out, /written back as blobs/); assert.equal(live(copy), false); assert.deepEqual([stored(copy).outbox, stored(copy).pushLog, stored(copy).pushTokens], [all.outbox, all.pushLog, all.pushTokens], 'the blobs hold every row in order');
  const OLD = process.env.SCOUTBOX_PRE_S7C_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    const old = await boot(copy, {}, OLD);
    assert.ok(!/0011_outbox_push/.test(old.log()), 'the accepted build knows nothing of 0011');
    const oldOutbox = (await old.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(oldOutbox.map((m) => m.id), all.outbox.map((m) => m.id).reverse(), 'the old build lists the same outbox records, newest first');
    const oldPush = (await old.j('GET', '/admin/push-log', undefined, null, A)).body; assert.deepEqual(oldPush.map((p) => p.id), all.pushLog.map((p) => p.id).reverse(), 'and the same push log');
    const oldMaria = await orgLogin(old, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const oldAmara = await guardianLogin(old, 'gd-amara');
    assert.equal((await old.j('POST', '/push/register', { token: { registeredOn: 'old-build' } }, oldAmara)).status, 201);
    assert.equal((await old.j('POST', '/org/invites', { email: 'synthetic-invitee-old@example.invalid', name: 'Synthetic Old', role: 'Scout' }, oldMaria)).status, 201);
    assert.ok(await until(async () => stored(copy).pushTokens.some((t) => t.kind === 'guardian' && t.token?.registeredOn === 'old-build') && stored(copy).outbox.length === all.outbox.length + 1, 8000), 'the old build keeps writing to its blobs');
    await old.stop();
    console.log('    (pre-S7c build booted the rollback copy: same records, new writes accepted)');
    // Re-upgrade: this build imports the blobs, the old build's writes included.
    const up = await boot(copy); assert.ok(live(copy), 'this build re-upgraded the copy'); const re = stored(copy);
    assert.deepEqual(re.outbox.slice(0, all.outbox.length), all.outbox); assert.equal(re.outbox.length, all.outbox.length + 1); assert.ok(re.pushTokens.some((t) => t.token?.registeredOn === 'old-build')); assert.deepEqual(re.pushLog, all.pushLog);
    await up.stop();
  } else {
    console.log('    (SCOUTBOX_PRE_S7C_SERVER not set: the pre-S7c boot of the rollback copy was not exercised here)');
  }
  rm(dir, bk.body.dir, restored, bad, copy);
});

console.log(`\n${passed} outbox/push server checks passed`);
