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
// S6b: a file this build wrote carries 0013 too; the S7d tool refuses a later schema step, so every rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6bDir = (dir) => { const s8a = tempDir('s8a-to-s4br'); execFileSync(process.execPath, [path.join(HERE, 'recruitmentRollback.mjs'), dir, s8a], { stdio: 'pipe' }); /* S8a: the file carries 0015; its rollback (copy-only, requests and trials written back as blobs) goes first */ const s4br = tempDir('s4br-to-s6b'); execFileSync(process.execPath, [path.join(HERE, 'playerErasureRollback.mjs'), s8a, s4br], { stdio: 'pipe' }); /* then S4b-R (copy-only, the retained records kept as a blob) */ const out = tempDir('s6b-to-s7d'); execFileSync(process.execPath, [path.join(HERE, 'safetyAuditRollback.mjs'), s4br, out], { stdio: 'pipe' }); return out; };
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
    /** The same request with the body sent as given (raw JSON text): what a client's parser produced is not pre-normalised by JSON.stringify here. */
    const raw = async (method, p, bodyText, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: bodyText });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const S = { proc, port, dir, log: () => log, j, raw, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
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
/** The destination as the row holds it: a string in to_address, any other JSON value in to_json (review of 40aa05c, F2), NULL/NULL = null. */
const destinationOf = (r) => (r.to_json != null ? JSON.parse(r.to_json) : r.to_address);
const outboxFromRow = (r) => (r.source === 'mailer' ? { id: r.id, ts: r.created_at, to: destinationOf(r), subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 } : { id: r.id, at: r.created_at, channel: r.channel, to: destinationOf(r), text: r.text, providerMessageId: r.provider_message_id, provider: r.transport });
/** The three collections as the DATABASE holds them, in insertion order: the tables after the cutover, the blobs before it (so a check reads the same way on both builds). */
const readStored = (c) => {
  const cut = !!c.get("SELECT 1 AS one FROM data_migrations WHERE id = '0011_outbox_push'");
  if (!cut) return { outbox: blobRows(c, 'outbox') ?? [], pushLog: blobRows(c, 'pushLog') ?? [], pushTokens: blobRows(c, 'pushTokens') ?? [], seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0 };
  return {
    outbox: c.all(`SELECT seq, id, source, created_at, to_address, ${c.get("SELECT 1 AS one FROM pragma_table_info('outbox') WHERE name = 'to_json'") ? 'to_json' : 'NULL AS to_json'}, subject, text, transport, delivered, channel, provider_message_id FROM outbox ORDER BY seq`).map(outboxFromRow),
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
  const copy = tempDir('s7c-rollback'); const s7cCopy = tempDir('s7c-rollback-s7d'); execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), s7cCopy], { encoding: 'utf8' }); // S7d first (the file carries 0012)
  const out = execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), s7cCopy, copy], { encoding: 'utf8' });
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

// ============================================================= review of 40aa05c — two independently reproduced compatibility defects, through the real routes
await test('[review of 40aa05c, F2] POST /org/invites with a destination the route COERCES (email given as a JSON array: RegExp.test coerces it, the invite stores String(email), the mailer receives the ORIGINAL array — the accepted build persisted that array): the response is the same 201, the process stays alive, the invite row and its mail record are durable in the route\'s one save with the array destination; a two-element array the regular expression also passes, an ordinary string and an object (400, unchanged) behave as before; the admin view, a restart, the backup, a restore, the copy-only rollback blob and the re-upgrade keep the array by value and type; on the live transport (provider intercepted locally) the provider receives the same JSON as before and the row records its answer; the accepted 6ca66ba build reads the rollback copy, writes an array itself, and a file it created from scratch with an array invite upgrades on this build', async () => {
  const dir = tempDir('s7c-f2'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const seq0 = seqOf(dir); const logBefore = S.log().length;
  const ONE = ['synthetic-review@example.invalid']; const TWO = ['synthetic-second@example.invalid', 'x'];
  const r = await S.j('POST', '/org/invites', { email: ONE, name: 'Synthetic Reviewer', role: 'Scout' }, maria);
  assert.equal(r.status, 201, r.text); assert.equal(r.body.invite.email, ONE[0], 'the invite stores String(email), as before');
  await sleep(600); assert.equal(S.proc.exitCode, null, 'the process is alive (no unobserved rejection)'); assert.doesNotMatch(S.log().slice(logBefore), /to must be a string or null|cannot be stored as JSON|UnhandledPromiseRejection|not recorded/, 'no refusal in the log');
  const after = snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), mail: readStored(c).outbox.find((m) => m.subject && /invited you/.test(m.subject) && /Hi Synthetic Reviewer/.test(m.text)), inviteRow: (blobRows(c, 'orgInvites') ?? []).some((i) => i.id === r.body.invite.id) }));
  assert.equal(after.seq, seq0 + 1, 'one save (the route\'s persistNow)'); assert.ok(after.inviteRow, 'the invite row is durable'); assert.ok(after.mail, 'the mail record is durable in that same save'); assert.deepEqual(after.mail.to, ONE, 'with the array the mailer received'); assert.equal(after.mail.transport, 'dev-outbox'); assert.equal(after.mail.delivered, true);
  assert.equal((await S.j('POST', '/org/invites', { email: TWO, name: 'Synthetic Second', role: 'Scout' }, maria)).status, 201, 'a two-element array the regular expression also passes');
  assert.equal((await S.j('POST', '/org/invites', { email: 'synthetic-plain@example.invalid', name: 'Synthetic Plain', role: 'Scout' }, maria)).status, 201);
  assert.equal((await S.j('POST', '/org/invites', { email: { a: 1 }, name: 'Synthetic Object', role: 'Scout' }, maria)).status, 400, 'an object never passed the route\'s regular expression (unchanged)');
  await sleep(300); assert.equal(S.proc.exitCode, null);
  const view = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; const byName = (list, n) => list.find((m) => typeof m.text === 'string' && m.text.includes(`Hi ${n},`));
  assert.deepEqual(byName(view, 'Synthetic Reviewer').to, ONE, 'the admin view returns the array, as the accepted build did'); assert.deepEqual(byName(view, 'Synthetic Second').to, TWO); assert.equal(byName(view, 'Synthetic Plain').to, 'synthetic-plain@example.invalid');
  const idsBefore = view.map((m) => m.id);
  // Restart, backup, restore.
  await S.stop(); S = await boot(dir);
  const viewAfter = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(viewAfter.map((m) => m.id), idsBefore, 'same ids, same order after a restart'); assert.deepEqual(byName(viewAfter, 'Synthetic Reviewer').to, ONE, 'the array after a restart');
  const all = stored(dir); const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8')); assert.deepEqual(snapshot.db.outbox, all.outbox, 'the backup carries the arrays'); assert.ok(snapshot.db.outbox.some((m) => Array.isArray(m.to) && m.to.length === 2));
  await S.stop();
  const restored = tempDir('s7c-f2-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true }); S = await boot(restored); assert.ok(live(restored)); assert.deepEqual(stored(restored).outbox, all.outbox, 'restored row for row (migration 0011)'); await S.stop();
  // Live transport, provider intercepted locally (never a real request).
  const liveDir = tempDir('s7c-f2-live'); const stubLog = path.join(liveDir, '..', `${path.basename(liveDir)}-sendgrid.log`);
  const SL = await boot(liveDir, { SENDGRID_API_KEY: 'synthetic-not-a-real-key', SENDGRID_STUB_LOG: stubLog, NODE_OPTIONS: `--import=${path.join(HERE, 'testSendgridStub.mjs')}` });
  const lm = await orgLogin(SL, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  assert.equal((await SL.j('POST', '/org/invites', { email: ONE, name: 'Synthetic Live', role: 'Scout' }, lm)).status, 201); await sleep(600); assert.equal(SL.proc.exitCode, null);
  const providerBody = JSON.parse(fs.readFileSync(stubLog, 'utf8').trim().split('\n').at(-1)); assert.deepEqual(providerBody.personalizations[0].to[0].email, ONE, 'the provider input is the original value, as before');
  const liveMem = byName((await SL.j('GET', '/admin/outbox', undefined, null, A)).body, 'Synthetic Live'); assert.deepEqual([liveMem.transport, liveMem.delivered, liveMem.to], ['sendgrid', true, ONE], 'the provider\'s answer on the record at once (memory), the array kept');
  assert.equal(byName(stored(liveDir).outbox, 'Synthetic Live').delivered, false, 'the route\'s save carried the record before the provider answered; the answer lands with the NEXT save, as the mutated blob entry did (§10.8 reading ii)');
  assert.equal((await SL.j('POST', '/org/invites', { email: 'synthetic-live-2@example.invalid', name: 'Synthetic Live Two', role: 'Scout' }, lm)).status, 201); // that next save
  const liveRow = byName(stored(liveDir).outbox, 'Synthetic Live'); assert.deepEqual([liveRow.transport, liveRow.delivered, liveRow.to], ['sendgrid', true, ONE], 'the provider\'s answer recorded on the row, the array kept');
  await SL.stop(); rm(liveDir); fs.rmSync(stubLog, { force: true });
  // Rollback and the accepted build.
  const copy = tempDir('s7c-f2-rollback'); const s7cCopy = tempDir('s7c-f2-rollback-s7d'); execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), s7cCopy], { encoding: 'utf8' }); execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), s7cCopy, copy], { encoding: 'utf8' });
  assert.equal(live(copy), false); assert.deepEqual(stored(copy).outbox, all.outbox, 'the blob holds every row, the arrays by value and type');
  const OLD = process.env.SCOUTBOX_PRE_S7C_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    const old = await boot(copy, {}, OLD); const om = await orgLogin(old, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
    assert.deepEqual(byName((await old.j('GET', '/admin/outbox', undefined, null, A)).body, 'Synthetic Reviewer').to, ONE, 'the accepted build reads the array back');
    assert.equal((await old.j('POST', '/org/invites', { email: ['synthetic-old@example.invalid'], name: 'Synthetic Old', role: 'Scout' }, om)).status, 201); await sleep(300); assert.equal(old.proc.exitCode, null); await old.stop();
    assert.deepEqual(byName(stored(copy).outbox, 'Synthetic Old').to, ['synthetic-old@example.invalid'], 'the accepted build wrote its array into the blob');
    const up = await boot(copy); assert.ok(live(copy), 're-upgraded'); const re = stored(copy).outbox; assert.deepEqual(re.slice(0, all.outbox.length), all.outbox); assert.deepEqual(byName(re, 'Synthetic Old').to, ['synthetic-old@example.invalid']); await up.stop();
    const fresh = tempDir('s7c-f2-old-fresh'); const o2 = await boot(fresh, {}, OLD); const fm = await orgLogin(o2, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
    assert.equal((await o2.j('POST', '/org/invites', { email: ['synthetic-upgrade@example.invalid'], name: 'Synthetic Upgrade', role: 'Scout' }, fm)).status, 201); await o2.stop();
    assert.deepEqual(byName(stored(fresh).outbox, 'Synthetic Upgrade').to, ['synthetic-upgrade@example.invalid'], 'the pre-S7c file holds the array');
    const up2 = await boot(fresh); assert.ok(live(fresh), 'this build upgrades a file the accepted build wrote'); assert.deepEqual(byName(stored(fresh).outbox, 'Synthetic Upgrade').to, ['synthetic-upgrade@example.invalid'], 'with the array intact'); assert.doesNotMatch(up2.log(), /OUTBOX_PUSH_IMPORT_BLOCKED/); await up2.stop();
    console.log('    (pre-S7c build: reads the rollback copy, writes an array destination, and its own file upgrades on this build)'); rm(fresh);
  } else {
    console.log('    (SCOUTBOX_PRE_S7C_SERVER not set: the old-build array-destination proofs were not exercised here)');
  }
  rm(dir, bk.body.dir, restored, copy);
});

await test('[review of 40aa05c, F1] POST /push/register with RAW JSON bodies (1e400 twice, -1e400, {"n":1e400}, [1e400] — JSON.stringify would pre-normalise them): five 201 responses as the accepted build answered; four rows persisted [null,null,{"n":null},[null]] with the debounced save (a repeated positive Infinity collapses by strict equality on the live value, negative Infinity is a separate row); the same five again collapse only their own live rows; falsy tokens are still 400; the backup carries null; after a restart every non-finite value reads null and a new live Infinity removes none of them; finite primitives and structurally equal objects behave as before; the push sender hands the live provider (intercepted locally) the same JSON payload as the accepted build; the rollback blob holds the nulls, the accepted build boots it and persists its own raw overflow registration as null, and the re-upgrade keeps every row', async () => {
  const dir = tempDir('s7c-f1'); let S = await boot(dir, { M13_FAST_RETRY: '' }); let kola = await playerLogin(S, 'pl-adeyemi');
  const RAW = ['{"token":1e400}', '{"token":1e400}', '{"token":-1e400}', '{"token":{"n":1e400}}', '{"token":[1e400]}'];
  const statuses = []; for (const b of RAW) statuses.push((await S.raw('POST', '/push/register', b, kola)).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201], 'five 201 responses, as the accepted build answered'); assert.equal(S.proc.exitCode, null);
  const four = await until(async () => { const t = playerTokens(dir); return t.length === 4 ? t : null; }, 8000); assert.ok(four, `four rows persisted with the debounced save (${playerTokens(dir).length})`);
  assert.deepEqual(four.map((t) => t.token), [null, null, { n: null }, [null]], 'the accepted build\'s persisted values: +Infinity collapsed, -Infinity separate, nested nulls'); assert.ok(four[0].ts <= four[1].ts && four[1].ts <= four[2].ts && four[2].ts <= four[3].ts, 'registration order');
  for (const b of RAW) assert.equal((await S.raw('POST', '/push/register', b, kola)).status, 201);
  const six = await until(async () => { const t = playerTokens(dir); return t.length === 6 ? t : null; }, 8000); assert.ok(six, 'six rows: the two live primitives replaced their own rows, the object and the array are new');
  assert.deepEqual(six.map((t) => t.token), [{ n: null }, [null], null, null, { n: null }, [null]]);
  for (const b of ['{"token":0}', '{"token":null}', '{"token":""}', '{"token":false}', '{}']) assert.equal((await S.raw('POST', '/push/register', b, kola)).status, 400, `falsy token refused as before: ${b}`);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text); const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.deepEqual(snapshot.db.pushTokens.filter((t) => t.kind === 'player' && t.refId === 'pl-adeyemi').map((t) => t.token), six.map((t) => t.token), 'the backup carries null');
  // Restart: null for every non-finite value; a new live Infinity removes none of them.
  await S.stop(); S = await boot(dir, { M13_FAST_RETRY: '' }); kola = await playerLogin(S, 'pl-adeyemi');
  assert.equal((await S.raw('POST', '/push/register', '{"token":1e400}', kola)).status, 201);
  const seven = await until(async () => { const t = playerTokens(dir); return t.length === 7 ? t : null; }, 8000); assert.ok(seven, 'a persisted null from the previous process is not removed by the new live Infinity'); assert.deepEqual(seven.slice(0, 6).map((t) => t.ts), six.map((t) => t.ts), 'the earlier rows untouched');
  assert.equal((await S.raw('POST', '/push/register', '{"token":1e400}', kola)).status, 201); await sleep(2600);
  const again = playerTokens(dir); assert.equal(again.length, 7, 'the repeated live Infinity collapsed only its own row'); assert.deepEqual(again.slice(0, 6).map((t) => t.ts), six.map((t) => t.ts)); assert.ok(again[6].ts > seven[6].ts);
  for (const b of ['{"token":424242}', '{"token":424242}', '{"token":{"n":1e400}}']) assert.equal((await S.raw('POST', '/push/register', b, kola)).status, 201);
  const nine = await until(async () => { const t = playerTokens(dir); return t.length === 9 ? t : null; }, 8000); assert.ok(nine, 'one number row (collapsed) and one more object row'); assert.deepEqual(nine.slice(-2).map((t) => t.token), [424242, { n: null }]);
  await S.stop();
  // The provider payload (the live push transport, intercepted locally): JSON.stringify of the live values.
  const payloads = async (server) => {
    const d = tempDir('s7c-f1-expo'); const stubLog = path.join(d, '..', `${path.basename(d)}-expo.log`);
    const X = await boot(d, { M13_FAST_RETRY: '', EXPO_ACCESS_TOKEN: 'synthetic-not-a-real-token', EXPO_STUB_LOG: stubLog, NODE_OPTIONS: `--import=${path.join(HERE, 'testExpoStub.mjs')}` }, server);
    const m = await orgLogin(X, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const k = await playerLogin(X, 'pl-adeyemi');
    for (const b of ['{"token":1e400}', '{"token":{"n":1e400}}', '{"token":"ExponentPushToken[synthetic]"}']) assert.equal((await X.raw('POST', '/push/register', b, k)).status, 201);
    const channel = await adultChannel(X, m, k); fs.writeFileSync(stubLog, '');
    assert.equal((await X.j('POST', `/org/channels/${channel.id}/messages`, { text: 'Synthetic payload message' }, m)).status, 201);
    const lines = await until(async () => { const l = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean); return l.length >= 3 ? l : null; }, 8000); assert.ok(lines, 'one provider call per registered token');
    await sleep(300); const parsed = fs.readFileSync(stubLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    await X.stop(); rm(d); fs.rmSync(stubLog, { force: true });
    return parsed.map((l) => ({ to: l.to, title: l.title }));
  };
  const mine = await payloads(SERVER);
  assert.deepEqual(mine, [{ to: null, title: 'ScoutBox' }, { to: { n: null }, title: 'ScoutBox' }, { to: 'ExponentPushToken[synthetic]', title: 'ScoutBox' }], 'null for Infinity in the provider payload, as JSON.stringify always wrote');
  const OLD = process.env.SCOUTBOX_PRE_S7C_SERVER;
  if (OLD && fs.existsSync(OLD)) { assert.deepEqual(await payloads(OLD), mine, 'the accepted 6ca66ba build sends the identical payloads'); console.log('    (pre-S7c build: identical provider payloads for non-finite tokens)'); } else console.log('    (SCOUTBOX_PRE_S7C_SERVER not set: the old-build payload comparison was not exercised here)');
  // Rollback: the blob holds the nulls; the accepted build boots it and persists its own raw overflow registration as null; the re-upgrade keeps every row.
  const copy = tempDir('s7c-f1-rollback'); const s7cCopy = tempDir('s7c-f1-rollback-s7d'); execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), s7cCopy], { encoding: 'utf8' }); execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), s7cCopy, copy], { encoding: 'utf8' });
  assert.deepEqual(playerTokens(copy).map((t) => t.token), nine.map((t) => t.token), 'the blob the accepted build reads');
  if (OLD && fs.existsSync(OLD)) {
    const old = await boot(copy, {}, OLD); const ok = await playerLogin(old, 'pl-adeyemi');
    assert.equal((await old.raw('POST', '/push/register', '{"token":-1e400}', ok)).status, 201); assert.ok(await until(async () => playerTokens(copy).length === 10, 8000), 'the accepted build persisted its own null'); assert.equal(playerTokens(copy).at(-1).token, null); await old.stop();
    const up = await boot(copy); assert.ok(live(copy)); assert.equal(playerTokens(copy).length, 10); assert.deepEqual(playerTokens(copy).slice(0, 9).map((t) => t.token), nine.map((t) => t.token)); await up.stop();
    console.log('    (pre-S7c build booted the rollback copy: a raw overflow registration persisted as null; re-upgraded with every row)');
  }
  rm(dir, bk.body.dir, copy);
});

await test('[review of 78c14b9] POST /org/invites with RAW JSON destinations the route coerces and accepts — ["…"] (control), [1e400,"…"] and [[-1e400],"…"] (the elements parse to ±Infinity): three 201 responses, the process alive, three invite rows and THREE mail records in the routes\' own saves with the array structure kept and the accepted build\'s JSON in the overflow positions (null, nested null); no refusal logged; the admin view, a restart, the backup, a restore, the live transport\'s provider payload (intercepted locally), the copy-only rollback blob and the re-upgrade all match; the actual 6ca66ba build persists the same destinations for the same raw bodies, reads the rollback copy and writes one itself', async () => {
  const dir = tempDir('s7c-f2b'); let S = await boot(dir);
  const maria = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment'); const seq0 = seqOf(dir); const logBefore = S.log().length;
  const RAW = ['{"email":["synthetic-control@example.invalid"],"name":"Synthetic Control","role":"Scout"}', '{"email":[1e400,"synthetic-overflow@example.invalid"],"name":"Synthetic Overflow","role":"Scout"}', '{"email":[[-1e400],"synthetic-nested@example.invalid"],"name":"Synthetic Nested","role":"Scout"}'];
  const EXPECTED = [['synthetic-control@example.invalid'], [null, 'synthetic-overflow@example.invalid'], [[null], 'synthetic-nested@example.invalid']]; // the accepted build's persisted JSON
  const statuses = []; for (const b of RAW) statuses.push((await S.raw('POST', '/org/invites', b, maria)).status);
  assert.deepEqual(statuses, [201, 201, 201]); await sleep(600); assert.equal(S.proc.exitCode, null, 'the process is alive');
  assert.doesNotMatch(S.log().slice(logBefore), /non-finite|cannot be stored as JSON|not recorded/, 'no refusal logged after a 201');
  const byName = (list, n) => list.find((m) => typeof m.text === 'string' && m.text.includes(`Hi ${n},`));
  const after = snap(dir, (c) => { const st = readStored(c); return { seq: st.seq, mails: ['Control', 'Overflow', 'Nested'].map((n) => byName(st.outbox, `Synthetic ${n}`)), invites: (blobRows(c, 'orgInvites') ?? []).filter((i) => /^Synthetic (Control|Overflow|Nested)$/.test(i.name)).length }; });
  assert.equal(after.seq, seq0 + 3, 'three saves (one persistNow per invite)'); assert.equal(after.invites, 3, 'three invite rows');
  assert.deepEqual(after.mails.map((m) => m?.to), EXPECTED, 'three mail records, the array structure kept, the old JSON in the overflow positions');
  assert.deepEqual(snap(dir, (c) => c.all("SELECT to_json FROM outbox WHERE text LIKE 'Hi Synthetic %' ORDER BY seq").map((r) => r.to_json)), EXPECTED.map((v) => JSON.stringify(v)), 'the stored JSON text');
  const view = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(['Control', 'Overflow', 'Nested'].map((n) => byName(view, `Synthetic ${n}`).to), EXPECTED, 'the admin view serialises the live array as the accepted build did');
  const idsBefore = view.map((m) => m.id);
  await S.stop(); S = await boot(dir);
  const viewAfter = (await S.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(viewAfter.map((m) => m.id), idsBefore); assert.deepEqual(['Control', 'Overflow', 'Nested'].map((n) => byName(viewAfter, `Synthetic ${n}`).to), EXPECTED, 'after a restart');
  const all = stored(dir); const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8')); assert.deepEqual(snapshot.db.outbox, all.outbox, 'the backup carries the arrays with the nulls');
  await S.stop();
  const restored = tempDir('s7c-f2b-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true }); S = await boot(restored); assert.ok(live(restored)); assert.deepEqual(stored(restored).outbox, all.outbox, 'restored row for row'); await S.stop();
  // Live transport, provider intercepted locally: the provider receives JSON.stringify of the live array (null in the overflow position), as before.
  const liveDir = tempDir('s7c-f2b-live'); const stubLog = path.join(liveDir, '..', `${path.basename(liveDir)}-sendgrid.log`);
  const SL = await boot(liveDir, { SENDGRID_API_KEY: 'synthetic-not-a-real-key', SENDGRID_STUB_LOG: stubLog, NODE_OPTIONS: `--import=${path.join(HERE, 'testSendgridStub.mjs')}` });
  const lm = await orgLogin(SL, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  assert.equal((await SL.raw('POST', '/org/invites', RAW[1], lm)).status, 201); await sleep(600); assert.equal(SL.proc.exitCode, null);
  const providerBody = JSON.parse(fs.readFileSync(stubLog, 'utf8').trim().split('\n').at(-1)); assert.deepEqual(providerBody.personalizations[0].to[0].email, EXPECTED[1], 'the provider payload, as before');
  assert.equal((await SL.j('POST', '/org/invites', { email: 'synthetic-live-3@example.invalid', name: 'Synthetic Live Three', role: 'Scout' }, lm)).status, 201); // the next save carries the provider's answer
  const liveRow = byName(stored(liveDir).outbox, 'Synthetic Overflow'); assert.deepEqual([liveRow.transport, liveRow.delivered, liveRow.to], ['sendgrid', true, EXPECTED[1]]);
  await SL.stop(); rm(liveDir); fs.rmSync(stubLog, { force: true });
  // Rollback: the blob holds the old JSON.
  const copy = tempDir('s7c-f2b-rollback'); const s7cCopy = tempDir('s7c-f2b-rollback-s7d'); execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), preS6bDir(dir), s7cCopy], { encoding: 'utf8' }); execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), s7cCopy, copy], { encoding: 'utf8' });
  assert.equal(live(copy), false); assert.deepEqual(stored(copy).outbox, all.outbox);
  const OLD = process.env.SCOUTBOX_PRE_S7C_SERVER;
  if (OLD && fs.existsSync(OLD)) {
    // The same raw bodies on the accepted build: the same persisted destinations.
    const oldDir = tempDir('s7c-f2b-old'); const o1 = await boot(oldDir, {}, OLD); const om1 = await orgLogin(o1, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
    const oldStatuses = []; for (const b of RAW) oldStatuses.push((await o1.raw('POST', '/org/invites', b, om1)).status); await sleep(300); assert.equal(o1.proc.exitCode, null); await o1.stop();
    assert.deepEqual(oldStatuses, [201, 201, 201]); assert.deepEqual(['Control', 'Overflow', 'Nested'].map((n) => byName(stored(oldDir).outbox, `Synthetic ${n}`).to), EXPECTED, 'the accepted build persisted the same destinations');
    const up0 = await boot(oldDir); assert.ok(live(oldDir)); assert.deepEqual(['Control', 'Overflow', 'Nested'].map((n) => byName(stored(oldDir).outbox, `Synthetic ${n}`).to), EXPECTED, 'and its file upgrades on this build with them intact'); await up0.stop();
    // The rollback copy on the accepted build.
    const old = await boot(copy, {}, OLD); const om = await orgLogin(old, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
    const oldView = (await old.j('GET', '/admin/outbox', undefined, null, A)).body; assert.deepEqual(['Control', 'Overflow', 'Nested'].map((n) => byName(oldView, `Synthetic ${n}`).to), EXPECTED, 'the accepted build reads the rollback copy');
    assert.equal((await old.raw('POST', '/org/invites', '{"email":[1e400,"synthetic-old-overflow@example.invalid"],"name":"Synthetic Old Overflow","role":"Scout"}', om)).status, 201); await sleep(300); assert.equal(old.proc.exitCode, null); await old.stop();
    assert.deepEqual(byName(stored(copy).outbox, 'Synthetic Old Overflow').to, [null, 'synthetic-old-overflow@example.invalid'], 'the accepted build wrote its JSON into the blob');
    const up = await boot(copy); assert.ok(live(copy)); const re = stored(copy).outbox; assert.deepEqual(re.slice(0, all.outbox.length), all.outbox); assert.deepEqual(byName(re, 'Synthetic Old Overflow').to, [null, 'synthetic-old-overflow@example.invalid']); await up.stop();
    console.log('    (pre-S7c build: same persisted destinations for the raw overflow bodies, its file upgrades, it reads and extends the rollback copy)'); rm(oldDir);
  } else {
    console.log('    (SCOUTBOX_PRE_S7C_SERVER not set: the old-build comparisons were not exercised here)');
  }
  rm(dir, bk.body.dir, restored, copy);
});

console.log(`\n${passed} outbox/push server checks passed`);
