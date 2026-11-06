// S7c — the mail outbox, the push log and the device push tokens as tables
// (repositories/outboxPush.mjs, migration 0011), under the fidelity rule of
// 3 November 2026 (typed columns, valid input only): the migration (DDL only,
// no blob import) and the typed export (two outbox literals told apart
// structurally, a delivery record with to: null); the actual schema (the structural source CHECK in SQL, the
// nullable destination, the string token column, no side columns); the
// repository (insertion order, the registration rule, the two write modes with
// owned-transaction memory restore, joined units, real COMMIT failure, hook
// registration, a failed ordinary save keeping its pending state versus an
// aborted unit restoring its pre-unit state, wrong-typed writes refused by
// name); the snapshot dispatcher (omitted / empty / malformed collections).
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const MIGRATION = '0011_outbox_push';
/** A second, independent connection: what it reads is what is committed. */
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'seq') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const tableExistsIn = (dir, t) => { const s = second(dir); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); } finally { s.close(); } };
const outboxIds = (dir) => (tableExistsIn(dir, 'outbox') ? rowsOf(dir, 'outbox').map((r) => r.id) : null);
const tokenRows = (dir) => (tableExistsIn(dir, 'push_tokens') ? rowsOf(dir, 'push_tokens').map((r) => [r.ref_kind, r.ref_id, r.token, r.registered_at]) : null);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const MAILER_KEYS = ['id', 'ts', 'to', 'subject', 'text', 'transport', 'delivered'];
const DELIVERY_KEYS = ['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider'];
const ADDRESS = 'synthetic-recipient@example.test';
/** The mailer literal, as adapters.mjs writes it. */
const mail = (over = {}) => ({ id: 'mail-1', ts: NOW - MIN, to: ADDRESS, subject: 'Synthetic subject', text: 'Synthetic body [code withheld — delivered to the recipient only]', transport: 'dev-outbox', delivered: true, ...over });
/** The delivery-centre literal, as m13/delivery.mjs fakeSend writes it. */
const delivery = (over = {}) => ({ id: 'mail-2', at: NOW - MIN, channel: 'email', to: ADDRESS, text: 'Synthetic notification text', providerMessageId: 'fm_000000000000000a', provider: 'local-fake', ...over });
/** The sender literal, as adapters.mjs writes it. */
const push = (over = {}) => ({ id: 'push-1', ts: NOW - MIN, audience: { kind: 'player', id: 'pl-adult' }, title: 'ScoutBox', body: 'Synthetic push body', transport: 'dev-log', ...over });
/** The registration literal, as POST /push/register writes it. */
const token = (value, over = {}) => ({ kind: 'player', refId: 'pl-adult', token: value, ts: NOW - MIN, ...over });
/** Five registrations with repeats: three rows remain (a repeated token removes its earlier row and is appended last). */
const BASELINE_TOKENS = ['tok-a', 'tok-a', 'tok-b', 'tok-c', 'tok-b'];
/** The route's rule applied to an array: filter-then-push. */
const routeRegister = (list, kind, refId, value, ts) => { const kept = list.filter((t) => !(t.kind === kind && t.refId === refId && t.token === value)); kept.push({ kind, refId, token: value, ts }); return kept; };

/** A file at S7b (0001–0010 applied), nothing of this domain in it. */
function s7bFile(dir) {
  s3File(dir, { extra: { requests: [], blobNotes: [], ledger: [], notifications: [], dispatches: [], opsEvents: [], deliveryCallbacksSeen: [] } });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
const mod = await import('../repositories/outboxPush.mjs');
/** A fully migrated file holding the given rows, written through the immediate-mode repository. */
function fileWith(dir, { outbox = [], pushLog = [], pushTokens = [] } = {}) {
  s7bFile(dir); const s = openRaw(dir); migrate(s); const r = bare(s);
  for (const o of outbox) r.outbox.append(o); for (const p of pushLog) r.pushLog.append(p); for (const t of pushTokens) r.pushTokens.register(t);
  s.close();
}
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = store.load()?.db ?? {};
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, warnings, repo: layer.outboxPush, snapshot, save: () => store.save(snapshot()), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test): own transaction per mutation. */
const bare = (s, over = {}) => mod.createOutboxPushRepository({ sqlite: s, now: () => NOW, ...over });
const ALL_AFTER_0010 = [MIGRATION, '0012_channels', '0013_safety_audit', '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups'];

// ============================================================= the migration and the typed export
test('migration 0011 is registered after 0010 and TABLE_BACKED names the three collections; a fresh boot creates the three tables with no blob behind them and installs read-only views; the export is the typed literals — both outbox literals in the writer\'s key order, the null destination kept, push records and tokens position for position', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).filter((id) => id < '0019').slice(-9), ['0010_dispatches', ...ALL_AFTER_0010], '0011_outbox_push is registered after 0010');
  assert.deepEqual([...TABLE_BACKED].slice(-118, -115), ['outbox', 'pushLog', 'pushTokens']); // followed by channels (S7d), the eight S6b audit collections, the two S8a collections, the five S8b collections, the two S8c collections the four S8d collections the three S9a collections, the four S9b collections, the six S9c collections, the five S9d collections, the S10a and S10b collections, the two S10c collections the three S11a collections the two S11b-1 collections, the three S11b-2 collections the three S11c collections the seven S12a collections, the nine S12b collections, the five S12c collections, the seven S12d collections, the six S13a collections and the five S13b collections
  const boot = tempDir('obp-boot'); s7bFile(boot);
  { const L = live(boot); assert.deepEqual(L.repo.counts(), { outbox: 0, pushLog: 0, pushTokens: 0 }); assert.ok(Array.isArray(L.db.outbox) && L.db.outbox.length === 0); assert.throws(() => L.db.outbox.push({}), /written through its domain repository/); for (const n of ['outbox', 'pushLog', 'pushTokens']) assert.equal(blobOf(boot, n), null, `no ${n} blob`); L.close(); }
  const dir = tempDir('obp-export'); s7bFile(dir);
  const s = openRaw(dir); assert.ok(migrate(s).ran.includes(MIGRATION)); assert.ok(applied(s).includes(MIGRATION)); assert.deepEqual(migrate(s).ran, [], 'a rerun does nothing');
  assert.deepEqual(s.prepare('PRAGMA table_info(outbox)').all().map((c) => c.name), ['seq', 'id', 'source', 'created_at', 'to_address', 'subject', 'text', 'transport', 'delivered', 'channel', 'provider_message_id']);
  assert.deepEqual(s.prepare('PRAGMA table_info(push_tokens)').all().map((c) => c.name), ['seq', 'ref_kind', 'ref_id', 'token', 'registered_at']);
  const repo = bare(s);
  const outbox = [mail(), delivery(), delivery({ id: 'mail-3', to: null, providerMessageId: 'fm_000000000000000b' }), mail({ id: 'mail-9', ts: 1, to: 'synthetic-special@example.test', subject: 'S', text: 'T', transport: 'sendgrid', delivered: false })];
  for (const o of outbox) repo.outbox.append(o);
  const pushes = [push(), push({ id: 'push-2', audience: { kind: 'org_user', id: 'usr-1' }, transport: 'expo' })];
  for (const p of pushes) repo.pushLog.append(p);
  const tokens = [token('tok-a', { ts: NOW }), { kind: 'org', refId: 'org-pro', token: 'ExponentPushToken[synthetic]', ts: NOW + 2 }];
  for (const t of tokens) repo.pushTokens.register(t);
  assert.deepEqual(s.prepare('SELECT seq, id, source FROM outbox ORDER BY seq').all().map((r) => [r.seq, r.id, r.source]), [[1, 'mail-1', 'mailer'], [2, 'mail-2', 'delivery'], [3, 'mail-3', 'delivery'], [4, 'mail-9', 'mailer']]);
  const o = s.prepare('SELECT * FROM outbox ORDER BY seq').all().map((r) => ({ ...r }));
  assert.deepEqual([o[0].subject, o[0].delivered, o[0].channel, o[0].provider_message_id, o[0].transport], ['Synthetic subject', 1, null, null, 'dev-outbox']);
  assert.deepEqual([o[1].subject, o[1].delivered, o[1].channel, o[1].provider_message_id, o[1].transport, o[1].to_address], [null, null, 'email', 'fm_000000000000000a', 'local-fake', ADDRESS]);
  assert.equal(o[2].to_address, null, 'the null destination is stored as NULL'); assert.equal(o[3].delivered, 0);
  const fresh = bare(s);
  const ex = fresh.outbox.exportRows();
  assert.deepEqual(ex, outbox); assert.deepEqual(Object.keys(ex[1]), DELIVERY_KEYS); assert.deepEqual(Object.keys(ex[3]), MAILER_KEYS); assert.ok(Object.hasOwn(ex[2], 'to') && ex[2].to === null);
  assert.deepEqual(fresh.pushLog.exportRows(), pushes); assert.deepEqual(fresh.pushTokens.exportRows(), tokens);
  s.close(); rm(dir, boot);
});

// ============================================================= the actual schema (direct SQL)
test('the actual schema (direct SQL on the real DDL): the structural source CHECK refuses a mailer row without subject or delivered and a delivery row carrying subject or delivered (NULL means "absent key", never a value); to_address NULL is accepted for BOTH sources (an accepted queued dispatch yields to: null); the token is a non-empty TEXT column; no uniqueness on tokens; no vocabulary CHECK on transport, channel, audience kind or ref kind; no side columns', () => {
  const dir = tempDir('obp-ddl'); s7bFile(dir); const s = openRaw(dir); migrate(s);
  const ins = (cols, vals) => s.prepare(`INSERT INTO outbox (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const base = ['id', 'source', 'created_at', 'to_address', 'text', 'transport'];
  ins([...base, 'subject', 'delivered'], ['m1', 'mailer', 1, null, 'x', 'dev-outbox', 'S', 1]); // mailer, NULL destination accepted
  ins([...base, 'channel', 'provider_message_id'], ['d1', 'delivery', 1, null, 'x', 'local-fake', 'email', 'fm_x']); // delivery, NULL destination accepted
  assert.throws(() => ins([...base, 'delivered'], ['m2', 'mailer', 1, 'a', 'x', 'dev-outbox', 1]), /CHECK constraint failed/, 'a mailer row needs a subject');
  assert.throws(() => ins([...base, 'subject'], ['m3', 'mailer', 1, 'a', 'x', 'dev-outbox', 'S']), /CHECK constraint failed/, 'a mailer row needs delivered (NULL would pass a lone CHECK; the source CHECK is total)');
  assert.throws(() => ins([...base, 'subject', 'delivered'], ['m4', 'mailer', 1, 'a', 'x', 'dev-outbox', 'S', 2]), /CHECK constraint failed/, 'delivered IN (0,1)');
  assert.throws(() => ins([...base, 'subject', 'delivered', 'channel'], ['m5', 'mailer', 1, 'a', 'x', 'dev-outbox', 'S', 1, 'email']), /CHECK constraint failed/, 'a mailer row carries no channel');
  assert.throws(() => ins([...base, 'channel', 'provider_message_id', 'delivered'], ['d2', 'delivery', 1, 'a', 'x', 'local-fake', 'email', 'fm_y', 0]), /CHECK constraint failed/, 'a delivery row carries no delivered');
  assert.throws(() => ins([...base, 'channel', 'provider_message_id', 'subject'], ['d3', 'delivery', 1, 'a', 'x', 'local-fake', 'email', 'fm_y', 'S']), /CHECK constraint failed/, 'a delivery row carries no subject');
  assert.throws(() => ins([...base, 'channel'], ['d4', 'delivery', 1, 'a', 'x', 'local-fake', 'email']), /CHECK constraint failed/, 'a delivery row needs its provider message id');
  assert.throws(() => ins([...base, 'subject', 'delivered'], ['m6', 'other', 1, 'a', 'x', 'dev-outbox', 'S', 1]), /CHECK constraint failed/, 'source is mailer or delivery');
  assert.throws(() => ins([...base, 'subject', 'delivered'], ['m1', 'mailer', 1, 'a', 'x', 'dev-outbox', 'S', 1]), /UNIQUE constraint failed: outbox.id/);
  ins([...base, 'subject', 'delivered'], ['m7', 'mailer', 1, 'a', 'x', 'any-transport-value', 'S', 1]); ins([...base, 'channel', 'provider_message_id'], ['d5', 'delivery', 1, 'a', 'x', 'local-fake', 'sms', 'fm_z']); // open vocabularies
  const tok = (kind, value) => s.prepare('INSERT INTO push_tokens (ref_kind, ref_id, token, registered_at) VALUES (?, ?, ?, ?)').run(kind, 'x', value, 1);
  tok('player', 'a'); tok('player', 'a'); tok('org_user', 'a'); tok('ts_reviewer', 't'); // duplicates legal; any kind
  assert.throws(() => tok('player', ''), /CHECK constraint failed/, 'an empty token is refused');
  assert.throws(() => s.prepare('INSERT INTO push_tokens (ref_kind, ref_id, registered_at) VALUES (?, ?, ?)').run('player', 'x', 1), /NOT NULL constraint failed: push_tokens.token/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 4);
  s.prepare('INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', 1, 'anything', 'x', 't', 'b', 'any-transport');
  assert.throws(() => s.prepare('INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p2', 1, null, 'x', 't', 'b', 'dev-log'), /NOT NULL constraint failed: push_log.audience_kind/);
  for (const t of ['outbox', 'push_log', 'push_tokens']) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/i); assert.deepEqual(s.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing`);
    assert.equal(s.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /_json$/.test(c.name)).length, 0, `${t} has no JSON side column`);
  }
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_tokens' AND sql LIKE '%UNIQUE%'").get().n, 0, 'no unique index on the tokens');
  s.close(); rm(dir);
});

// ============================================================= the repository, immediate mode
test('repository (immediate mode): append validates strictly (both literals, a duplicate id refused; an unknown key is not stored; a non-string destination refused by name); markDelivered updates the mailer record (a delivery record, a missing id, a non-boolean refused inside the boundary); register reproduces the route — a repeated token removes its earlier row and is appended LAST with a new seq, the same token under another owner is a separate row, a non-string token is refused by name; forAudience returns detached copies; insertion order is seq order (second connection); an owned transaction that fails at a statement or at COMMIT restores the mirrors in place (held views included) and the retry lands; a caller-owned raw transaction keeps the explicit reload() contract', () => {
  const dir = tempDir('obp-repo'); s7bFile(dir); { const s = openRaw(dir); migrate(s); s.close(); }
  const s = openRaw(dir); const repo = bare(s);
  const a = repo.outbox.append(mail()); const b = repo.outbox.append(delivery({ to: null })); assert.equal(a.delivered, true); assert.equal(b.to, null);
  assert.throws(() => repo.outbox.append(mail()), /already exists/); assert.throws(() => repo.outbox.append({ id: 'x' }), /matches neither outbox shape/); assert.equal(repo.outbox.count(), 2);
  const u = repo.outbox.append(mail({ id: 'mail-u', note: 'not a column', fn: () => 1 })); assert.deepEqual(Object.keys(u), MAILER_KEYS, 'unknown keys are not stored'); assert.deepEqual(Object.keys(rowsOf(dir, 'outbox')[2]).length, 11);
  for (const to of [['synthetic@example.invalid'], { a: 1 }, 7, Infinity, undefined]) assert.throws(() => repo.outbox.append(mail({ id: 'mail-bad', to })), /to must be a string e-mail address or null/);
  assert.throws(() => repo.outbox.append(delivery({ id: 'mail-bad', to: ['x'] })), /to must be a string e-mail address or null/); assert.equal(repo.outbox.byId('mail-bad'), null); assert.equal(repo.outbox.count(), 3);
  repo.outbox.markDelivered('mail-1', false); assert.equal(a.delivered, false); assert.equal(rowsOf(dir, 'outbox')[0].delivered, 0);
  assert.throws(() => repo.outbox.markDelivered('mail-2', true), /is a delivery record/); assert.throws(() => repo.outbox.markDelivered('mail-none', true), /no record mail-none/); assert.throws(() => repo.outbox.markDelivered('mail-1', 'yes'), /delivered must be a boolean/);
  repo.pushLog.append(push()); assert.throws(() => repo.pushLog.append(push()), /already exists/); assert.throws(() => repo.pushLog.append(push({ id: 'push-2', audience: { kind: 'player' } })), /audience.id must be a non-empty string/); assert.throws(() => repo.pushLog.append(push({ id: 'push-2', audience: { kind: 'player', id: 'x', name: 'y' } })), /audience carries unknown field/);
  // The route's rule.
  BASELINE_TOKENS.forEach((v, i) => repo.pushTokens.register(token(v, { ts: NOW + i })));
  let expected = []; BASELINE_TOKENS.forEach((v, i) => { expected = routeRegister(expected, 'player', 'pl-adult', v, NOW + i); });
  const mine = repo.pushTokens.forAudience('player', 'pl-adult');
  assert.deepEqual(mine, expected); assert.deepEqual(mine.map((t) => [t.token, t.ts]), [['tok-a', NOW + 1], ['tok-c', NOW + 3], ['tok-b', NOW + 4]]);
  assert.deepEqual(tokenRows(dir).map((r) => r[2]), ['tok-a', 'tok-c', 'tok-b'], 'seq order = registration order after the collapses');
  const r = repo.pushTokens.register(token('tok-a', { ts: NOW + 20 })); assert.equal(r.removed, 1); assert.deepEqual(repo.pushTokens.forAudience('player', 'pl-adult').map((t) => t.token), ['tok-c', 'tok-b', 'tok-a'], 'the token moved last'); assert.deepEqual(tokenRows(dir).map((x) => x[2]), ['tok-c', 'tok-b', 'tok-a']);
  assert.equal(repo.pushTokens.register({ kind: 'org', refId: 'org-pro', token: 'tok-a', ts: NOW + 24 }).removed, 0, 'another owner\'s token is a separate row'); assert.equal(repo.pushTokens.forAudience('org', 'org-pro').length, 1); assert.equal(repo.pushTokens.forAudience('player', 'pl-adult').length, 3);
  for (const bad of [424242, Infinity, -Infinity, Number.NaN, true, { review: 'x' }, ['x'], '', null, undefined]) assert.throws(() => repo.pushTokens.register(token(bad)), /token must be a non-empty string/);
  assert.throws(() => repo.pushTokens.register({ kind: 'player', token: 'x', ts: 1 }), /refId is absent/);
  const unknown = repo.pushTokens.register(token('tok-d', { ts: NOW + 25, device: 'not a column' })); assert.deepEqual(Object.keys(unknown.row), ['kind', 'refId', 'token', 'ts'], 'an unknown key is not stored');
  const copies = repo.pushTokens.forAudience('player', 'pl-adult'); copies[0].token = 'edited'; assert.equal(repo.pushTokens.forAudience('player', 'pl-adult')[0].token, 'tok-c', 'forAudience hands out detached copies');
  assert.deepEqual(rowsOf(dir, 'push_tokens').map((x) => x.ref_kind), ['player', 'player', 'player', 'org', 'player']);
  // Owned-transaction failure: statement and real COMMIT failures restore the mirrors in place.
  const snapshot = () => ({ outbox: plain(repo.outbox.exportRows()), push: plain(repo.pushLog.exportRows()), tokens: plain(repo.pushTokens.exportRows()), held: [plain(a), plain(b)], durable: [outboxIds(dir), tokenRows(dir)] });
  const before = snapshot();
  s.exec("CREATE TEMP TRIGGER rv_ins BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  assert.throws(() => repo.outbox.append(mail({ id: 'mail-5' })), /synthetic insert failure/); assert.deepEqual(snapshot(), before); assert.equal(repo.outbox.byId('mail-5'), null); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_ins');
  s.exec("CREATE TEMP TRIGGER rv_del BEFORE DELETE ON push_tokens BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
  assert.throws(() => repo.pushTokens.register(token('tok-c', { ts: NOW + 30 })), /synthetic delete failure/); assert.deepEqual(snapshot(), before, 'the removed rows are back in their positions');
  s.exec('DROP TRIGGER rv_del');
  s.exec("CREATE TEMP TRIGGER rv_upd BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic update failure'); END");
  assert.throws(() => repo.outbox.markDelivered('mail-1', true), /synthetic update failure/); assert.deepEqual(snapshot(), before); assert.equal(a.delivered, false);
  s.exec('DROP TRIGGER rv_upd');
  s.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON push_log BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => repo.pushLog.append(push({ id: 'push-5' })), /FOREIGN KEY constraint failed/); assert.deepEqual(snapshot(), before, 'nothing in memory after a failed COMMIT'); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_commit');
  assert.equal(repo.pushLog.append(push({ id: 'push-5' })).id, 'push-5', 'the same id is accepted on the retry'); assert.equal(repo.pushLog.count(), 2);
  // A caller-owned raw transaction: the mirror cannot see the caller's ROLLBACK; reload() is the contract.
  s.exec('BEGIN'); repo.outbox.append(mail({ id: 'mail-raw' })); s.exec('ROLLBACK');
  assert.ok(repo.outbox.byId('mail-raw')); repo.reload(); assert.equal(repo.outbox.byId('mail-raw'), null); assert.equal(repo.outbox.count(), 3);
  s.close(); rm(dir);
});

// ============================================================= the staged mode (the server's)
test('staged mode (the server): an outbox record, a push record and a registration are visible in memory at once but NOT durable ahead of the next snapshot save, which lands them in ONE revision with the blob edits made alongside (second connection); a FAILED ORDINARY SAVE (statement or real COMMIT) keeps the mirrors and the queue as they are — pending state retained, nothing dropped — and the retry lands everything once, never twice; an ABORTED UNIT OF WORK restores the mirrors and the queue to the pre-unit state (held views included, a registration\'s removed rows back in place) whether the unit threw, a queued statement failed at the flush, the real COMMIT failed or a participant refusal was caught; writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('obp-staged'); fileWith(dir, { pushTokens: [token('existing-device')] });
  const L = live(dir); L.save();
  const seq0 = seqOf(dir);
  L.db.blobNotes.push({ id: 'req-1' });
  const a = L.repo.outbox.append(mail()); L.repo.pushLog.append(push()); const reg = L.repo.pushTokens.register(token('existing-device', { ts: NOW + 1 }));
  assert.equal(reg.removed, 1); assert.equal(L.repo.pending(), 3); assert.deepEqual(outboxIds(dir), [], 'nothing durable before the save'); assert.deepEqual(tokenRows(dir).map((r) => r[3]), [NOW - MIN], 'the old row is still the durable one'); assert.equal(L.db.pushTokens.length, 1, 'memory shows the re-registration at once');
  // A failed ordinary save (statement): pending state retained.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(outboxIds(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3); assert.equal(L.db.outbox.length, 1, 'memory is the intended state'); assert.equal(JSON.parse(blobOf(dir, 'blobNotes')).some((r) => r.id === 'req-1'), false, 'the blob did not land without the rows');
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  // A failed ordinary save (real COMMIT): pending state retained.
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON push_log BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(outboxIds(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3);
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  // The retry: one revision, everything together, once.
  L.save();
  assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(outboxIds(dir), ['mail-1']); assert.deepEqual(rowsOf(dir, 'push_log').map((r) => r.id), ['push-1']); assert.deepEqual(tokenRows(dir), [['player', 'pl-adult', 'existing-device', NOW + 1]], 'the old row deleted, the new one last'); assert.ok(JSON.parse(blobOf(dir, 'blobNotes')).some((r) => r.id === 'req-1')); assert.equal(L.repo.pending(), 0);
  L.save(); assert.equal(seqOf(dir), seq0 + 2); assert.equal(tokenRows(dir).length, 1, 'a later save does not replay');
  // A unit of work: together or not at all; a caught participant failure still poisons the unit; pre-unit writes survive.
  const pre = L.repo.pushLog.append(push({ id: 'push-pre' })); assert.equal(L.repo.pending(), 1);
  const state = () => ({ outbox: plain(L.repo.outbox.exportRows()), push: plain(L.repo.pushLog.exportRows()), tokens: plain(L.repo.pushTokens.exportRows()), held: plain(a), requests: JSON.stringify(L.db.blobNotes), durable: [outboxIds(dir), tokenRows(dir), seqOf(dir)] });
  const before = state();
  const unchanged = (label) => { assert.deepEqual(state(), before, label); assert.equal(L.repo.pending(), 1, `${label}: the pre-unit write is still pending`); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false); };
  const work = () => { L.db.blobNotes.push({ id: 'req-u' }); L.repo.outbox.markDelivered('mail-1', false); L.repo.outbox.append(delivery({ id: 'mail-u' })); L.repo.pushTokens.register(token('existing-device', { ts: NOW + 9 })); L.repo.pushTokens.register(token('other-device')); };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), /synthetic unit failure/);
  unchanged('thrown'); assert.equal(a.delivered, true, 'the held view is back on the restored row');
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { work(); try { L.repo.outbox.append(mail({ id: 'mail-bad', delivered: 'yes' })); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /delivered must be a boolean/); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back');
  unchanged('caught');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE DELETE ON push_tokens BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /synthetic joined failure/);
  unchanged('statement failure at the unit\'s flush');
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_commit2 AFTER INSERT ON outbox BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/);
  unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER rv_commit2');
  L.store.unitOfWork(work, { snapshot: L.snapshot });
  assert.equal(seqOf(dir), before.durable[2] + 1); assert.deepEqual(outboxIds(dir), ['mail-1', 'mail-u']); assert.equal(rowsOf(dir, 'outbox')[0].delivered, 0); assert.deepEqual(rowsOf(dir, 'push_log').map((r) => r.id), ['push-1', 'push-pre'], 'the pre-unit write landed with the unit'); assert.deepEqual(tokenRows(dir).map((r) => r[2]), ['existing-device', 'other-device']); assert.ok(JSON.parse(blobOf(dir, 'blobNotes')).some((r) => r.id === 'req-u')); assert.equal(L.repo.pending(), 0); assert.ok(pre.id);
  // Hook registration is a precondition inside the joined boundary.
  const { createOutboxPushRepository } = mod;
  const bareUnit = createOutboxPushRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit });
  const stagedUnit = createOutboxPushRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true });
  for (const [label, w] of [['immediate', () => bareUnit.pushLog.append(push({ id: 'push-h' }))], ['staged', () => stagedUnit.pushLog.append(push({ id: 'push-h' }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.db.blobNotes.push({ id: 'req-h' }); try { w(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(JSON.parse(blobOf(dir, 'blobNotes')).some((r) => r.id === 'req-h'), false);
  }
  assert.throws(() => stagedUnit.pushLog.append(push({ id: 'push-h' })), /save hook/, 'standalone staged write without the hook');
  assert.throws(() => createOutboxPushRepository({ sqlite: L.store.sqlite, staged: true }), /needs the store's participant API/);
  L.close(); rm(dir);
});

// ============================================================= detached data
test('exports and copies are DETACHED: mutating a returned export, a forAudience copy or the caller\'s own input after append never changes the mirror or a later export; a held view refuses a write; a rolled-back unit leaves the held view on the restored row; a reload (restart) reproduces the rows; a refused write queues nothing', () => {
  const dir = tempDir('obp-detach'); s7bFile(dir); const L = live(dir); L.save();
  const input = mail({ id: 'mail-p' }); const held = L.repo.outbox.append(input); input.text = 'mutated after append';
  const pushInput = push({ id: 'push-p' }); L.repo.pushLog.append(pushInput); pushInput.audience.id = 'mutated';
  L.repo.pushTokens.register(token('tok-p'));
  assert.equal(L.repo.outbox.exportRows()[0].text, mail().text, 'the input\'s later mutation did not reach the mirror'); assert.equal(L.repo.pushLog.exportRows()[0].audience.id, 'pl-adult');
  const ex = L.repo.outbox.exportRows(); ex[0].text = 'export edit'; assert.equal(L.repo.outbox.exportRows()[0].text, mail().text, 'an export edit does not reach the mirror');
  const px = L.repo.pushLog.exportRows(); px[0].audience.kind = 'export edit'; assert.equal(L.repo.pushLog.exportRows()[0].audience.kind, 'player', 'a nested export edit does not reach the mirror');
  assert.throws(() => { held.text = 'x'; }, /written through its domain repository/, 'the view refuses a write');
  L.save();
  assert.throws(() => L.store.unitOfWork(() => { L.repo.outbox.markDelivered('mail-p', false); throw new Error('abort'); }, { snapshot: L.snapshot }), /abort/);
  assert.equal(held.delivered, true);
  L.close();
  const L2 = live(dir); assert.deepEqual(L2.repo.outbox.exportRows(), [mail({ id: 'mail-p' })], 'a restart reproduces the row'); assert.deepEqual(L2.repo.pushLog.exportRows(), [push({ id: 'push-p' })]); assert.deepEqual(L2.repo.pushTokens.exportRows(), [token('tok-p')]);
  assert.throws(() => L2.repo.outbox.append(mail({ id: 'mail-bad', ts: 1.5 })), /ts must be an integer/); assert.throws(() => L2.repo.pushTokens.register(token(Infinity)), /token must be a non-empty string/);
  assert.equal(L2.repo.pending(), 0, 'nothing queued by a refusal'); assert.equal(L2.repo.outbox.count(), 1);
  L2.close(); rm(dir);
});

// ============================================================= the snapshot dispatcher (backups, restores, the persistence suites)
test('snapshot dispatcher: a tool that loads and saves the whole file round-trips every outbox record (both literals, the null destination), push record and token; an unknown key in a snapshot entry is not stored; a snapshot that OMITS a collection leaves its table alone (the other two rewritten); an explicit EMPTY array clears a table; a malformed collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid or wrong-typed entry (a non-string destination or token) refuses the whole save with a text-free diagnostic', () => {
  const dir = tempDir('obp-snap');
  let list = []; BASELINE_TOKENS.forEach((v, i) => { list = routeRegister(list, 'player', 'pl-adult', v, NOW + i); });
  fileWith(dir, { outbox: [mail(), delivery({ to: null })], pushLog: [push()], pushTokens: list });
  const tool = openStore(dir); const snap = tool.load();
  assert.deepEqual(snap.db.outbox, [mail(), delivery({ to: null })]); assert.deepEqual(snap.db.pushTokens, list);
  const seq0 = tool.revision(); tool.save({ ...snap, db: { ...snap.db, outbox: [...snap.db.outbox, mail({ id: 'mail-extra', future: 'not a column' })] } });
  assert.equal(tool.revision(), seq0 + 1); const again = tool.load(); assert.deepEqual(again.db.outbox, [mail(), delivery({ to: null }), mail({ id: 'mail-extra' })], 'round-tripped through replace; the unknown key not stored'); assert.deepEqual(again.db.pushTokens, list); assert.deepEqual(again.db.pushLog, [push()]);
  // Omitted: left alone; the others rewritten.
  const { pushTokens: _omit, ...without } = again.db; tool.save({ ...again, db: { ...without, pushLog: [] } });
  assert.equal(tokenRows(dir).length, 3, 'an omitted collection leaves its table alone'); assert.equal(rowsOf(dir, 'push_log').length, 0, 'an explicit empty array clears'); assert.equal(blobOf(dir, 'pushTokens'), null, 'and never recreates a shadow blob');
  // Malformed: the whole save rolls back.
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, blobNotes: [{ id: 'vch-x' }], outbox: { id: 'x' } } }), /outbox: the snapshot collection must be an array/); // blobNotes: an unrelated plain blob (requests are table-backed since S8a)
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (blobNotes included)');
  const SECRET = 'SECRET-ADDRESS-77@example.test';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, blobNotes: [{ id: 'vch-x' }], outbox: [mail({ id: 'mail-bad', to: SECRET, at: 5 })] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /matches both outbox shapes/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, outbox: [mail({ id: 'mail-bad', to: [SECRET] })] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /to must be a string e-mail address or null/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, pushTokens: [token(SECRET, { kind: '' })] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /kind must be a non-empty string/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, pushTokens: [token(424242)] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /token must be a non-empty string/.test(e.message) && !e.message.includes('424242'));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  tool.save({ ...snap, db: { ...snap.db, outbox: [] } }); assert.deepEqual(outboxIds(dir), []); assert.equal(blobOf(dir, 'outbox'), null);
  tool.sqlite.close(); rm(dir);
});

console.log(`\n${passed} outbox/push checks passed`);
