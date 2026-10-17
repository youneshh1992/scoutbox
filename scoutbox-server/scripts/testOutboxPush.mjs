// S7c — the mail outbox, the push log and the device push tokens as tables
// (repositories/outboxPush.mjs, migration 0011, repositories/outboxPushRollback.mjs),
// after the independent review of 6ca66ba corrected three design assumptions
// (a push row's existing save scheduling; lossless JSON token storage with the
// route's `===` matching and no uniqueness constraint; a nullable delivery
// destination): the migration from the three legacy blobs (two outbox literals
// told apart structurally, tokens of every JSON type, duplicates legal, a
// delivery record with to: null, extras, absent / empty / malformed / duplicate
// collections, first installation, reruns, text-free refusals); the actual
// schema (the structural source CHECK in SQL, the nullable destination, the JSON
// token column); the repository (insertion order, the registration rule with
// primitives collapsing and objects never, the two write modes with
// owned-transaction memory restore, joined units, real COMMIT failure, hook
// registration, a failed ordinary save keeping its pending state versus an
// aborted unit restoring its pre-unit state); the snapshot dispatcher (omitted /
// empty / malformed collections); the copy-only rollback tool to the accepted
// 6ca66ba build. Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 6ca66ba tree before the implementation):
// the tests marked [cutover] need the 0011 migration and the repository module and
// FAIL there on concrete assertions (the migration id is absent from DATA_MIGRATIONS;
// the three tables do not exist; the blobs survive). The tests marked [compat] exercise
// behaviour the accepted build already has (JSON round trips through STRICT SQLite,
// the route's matching rule reproduced on arrays) and pass on both trees.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, blob, meta, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
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
const tokenRows = (dir) => (tableExistsIn(dir, 'push_tokens') ? rowsOf(dir, 'push_tokens').map((r) => [r.ref_kind, r.ref_id, r.token_json, r.registered_at]) : null);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
/** The export convention (S7a, S7b, S7c): unknown own fields come FIRST, then the literal's keys in the writer's order. */
const extrasFirst = (row, keys) => { const o = {}; for (const k of Object.keys(row)) if (!keys.includes(k)) setOwn(o, k, row[k]); for (const k of keys) if (Object.hasOwn(row, k)) o[k] = row[k]; return o; };
const MAILER_KEYS = ['id', 'ts', 'to', 'subject', 'text', 'transport', 'delivered'];
const DELIVERY_KEYS = ['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider'];
const PUSH_KEYS = ['id', 'ts', 'audience', 'title', 'body', 'transport'];
const TOKEN_KEYS = ['kind', 'refId', 'token', 'ts'];
const ADDRESS = 'synthetic-recipient@example.test';
/** The mailer literal, as adapters.mjs writes it. */
const mail = (over = {}) => ({ id: 'mail-1', ts: NOW - MIN, to: ADDRESS, subject: 'Synthetic subject', text: 'Synthetic body [code withheld — delivered to the recipient only]', transport: 'dev-outbox', delivered: true, ...over });
/** The delivery-centre literal, as m13/delivery.mjs fakeSend writes it. */
const delivery = (over = {}) => ({ id: 'mail-2', at: NOW - MIN, channel: 'email', to: ADDRESS, text: 'Synthetic notification text', providerMessageId: 'fm_000000000000000a', provider: 'local-fake', ...over });
/** The sender literal, as adapters.mjs writes it. */
const push = (over = {}) => ({ id: 'push-1', ts: NOW - MIN, audience: { kind: 'player', id: 'pl-adult' }, title: 'ScoutBox', body: 'Synthetic push body', transport: 'dev-log', ...over });
/** The registration literal, as POST /push/register writes it. */
const token = (value, over = {}) => ({ kind: 'player', refId: 'pl-adult', token: value, ts: NOW - MIN, ...over });
/** The nine registrations of the independent baseline: 7 persisted rows (1 number, 1 string, 1 boolean, 2 objects, 2 arrays). */
const BASELINE_TOKENS = [424242, 424242, '424242', true, true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic']];
/** Today's route applied to an array: filter-then-push with `===`. */
const routeRegister = (list, kind, refId, value, ts) => { const kept = list.filter((t) => !(t.kind === kind && t.refId === refId && t.token === value)); kept.push({ kind, refId, token: value, ts }); return kept; };

/** A file at S7b (0001–0010 applied) carrying the three blobs the way the 6ca66ba build wrote them. */
function s7bFile(dir, { outbox, pushLog, pushTokens, rawBlobs } = {}) {
  const extra = { requests: [], ledger: [], notifications: [], dispatches: [], opsEvents: [], deliveryCallbacksSeen: [] };
  if (outbox !== undefined) extra.outbox = outbox;
  if (pushLog !== undefined) extra.pushLog = pushLog;
  if (pushTokens !== undefined) extra.pushTokens = pushTokens;
  s3File(dir, { extra, rawBlobs });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
let mod = null;
try { mod = await import('../repositories/outboxPush.mjs'); } catch { mod = null; }
let rollbackMod = null;
try { rollbackMod = await import('../repositories/outboxPushRollback.mjs'); } catch { rollbackMod = null; }
const needModule = () => { assert.ok(mod, 'repositories/outboxPush.mjs exists (the S7c repository module)'); return mod; };
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
const bare = (s, over = {}) => needModule().createOutboxPushRepository({ sqlite: s, now: () => NOW, ...over });

// ============================================================= [compat] the three observations of the review of 6ca66ba, on the accepted representation
test('[compat] the route\'s token rule reproduced on an array (the accepted build\'s representation): nine registrations of number, string, boolean, equal objects and equal arrays persist 7 rows (1/1/1/2/2) — a repeated primitive collapses its earlier row and is appended last, structurally equal objects and arrays never collapse; and every value round-trips through a STRICT SQLite JSON text column with its type (the representation S7c stores)', () => {
  let list = [];
  BASELINE_TOKENS.forEach((v, i) => { list = routeRegister(list, 'player', 'pl-adult', v, NOW + i); });
  const types = (l) => ({ numbers: l.filter((t) => typeof t.token === 'number').length, strings: l.filter((t) => typeof t.token === 'string').length, booleans: l.filter((t) => typeof t.token === 'boolean').length, objects: l.filter((t) => t.token && typeof t.token === 'object' && !Array.isArray(t.token)).length, arrays: l.filter((t) => Array.isArray(t.token)).length });
  assert.deepEqual(types(list), { numbers: 1, strings: 1, booleans: 1, objects: 2, arrays: 2 });
  assert.deepEqual(list.map((t) => t.ts), [NOW + 1, NOW + 2, NOW + 4, NOW + 5, NOW + 6, NOW + 7, NOW + 8], 'a repeated primitive is removed and appended LAST with the later ts; objects and arrays are appended as new rows');
  const s = new DatabaseSync(':memory:'); s.exec('CREATE TABLE t (seq INTEGER PRIMARY KEY, token_json TEXT NOT NULL CHECK (json_valid(token_json))) STRICT');
  for (const t of list) s.prepare('INSERT INTO t (token_json) VALUES (?)').run(JSON.stringify(t.token));
  const back = s.prepare('SELECT token_json FROM t ORDER BY seq').all().map((r) => JSON.parse(r.token_json));
  assert.deepEqual(back, list.map((t) => t.token), 'values and types back exactly'); assert.equal(typeof back[0], 'number'); assert.equal(typeof back[1], 'string'); assert.equal(typeof back[2], 'boolean');
  assert.throws(() => s.prepare('INSERT INTO t (token_json) VALUES (?)').run('{not json'), /CHECK constraint failed/); s.close();
});

// ============================================================= [cutover] the migration from the legacy blobs
test('[cutover] migration 0011 (legacy blobs): every outbox record is imported in its own literal (the mailer record and the delivery record told apart structurally; a delivery record with to: null kept as present-and-null; sendgrid/dev-outbox/local-fake stored as written; an own "__proto__" extra kept), every push log record and every token (number, string, boolean, equal objects, equal arrays, an extra field, an object token with an own "__proto__" key) with its array position as seq; the blobs are retired; the cutover record carries counts only; the export reproduces every entry byte for byte up to the export convention; 0011 is the next unused identifier and TABLE_BACKED names the three collections', () => {
  const dir = tempDir('obp-mig');
  const special = JSON.parse('{"id":"mail-9","ts":1,"to":"synthetic-special@example.test","subject":"S","text":"T","transport":"sendgrid","delivered":false,"__proto__":{"legacyMarker":"keep-me"},"nested":{"a":[1,{"b":null}]}}');
  const outbox = [mail(), delivery(), delivery({ id: 'mail-3', to: null, providerMessageId: 'fm_000000000000000b' }), special];
  const pushLog = [push(), push({ id: 'push-2', audience: { kind: 'org_user', id: 'usr-1' }, transport: 'expo', annotation: { by: 'tool' } })];
  let list = []; BASELINE_TOKENS.forEach((v, i) => { list = routeRegister(list, 'player', 'pl-adult', v, NOW + i); });
  const protoToken = JSON.parse('{"kind":"guardian","refId":"gd-primary","token":{"__proto__":{"deviceMarker":"x"},"id":"dev-1"},"ts":5}');
  const pushTokens = [...list, { kind: 'org', refId: 'org-pro', token: 'ExponentPushToken[synthetic]', ts: NOW, extra: 'kept' }, protoToken];
  s7bFile(dir, { outbox, pushLog, pushTokens });
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).slice(-2), ['0010_dispatches', MIGRATION], '0011_outbox_push is registered as the next unused identifier');
  assert.deepEqual([...TABLE_BACKED].slice(-3), ['outbox', 'pushLog', 'pushTokens']);
  const s = openRaw(dir);
  assert.deepEqual(migrate(s).ran, [MIGRATION]); assert.ok(applied(s).includes(MIGRATION));
  // The outbox table: order, source, NULL = absent key.
  const o = s.prepare('SELECT seq, id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id, extra_json FROM outbox ORDER BY seq').all().map((r) => ({ ...r }));
  assert.deepEqual(o.map((r) => [r.seq, r.id, r.source]), [[1, 'mail-1', 'mailer'], [2, 'mail-2', 'delivery'], [3, 'mail-3', 'delivery'], [4, 'mail-9', 'mailer']]);
  assert.deepEqual([o[0].subject, o[0].delivered, o[0].channel, o[0].provider_message_id, o[0].transport], ['Synthetic subject', 1, null, null, 'dev-outbox']);
  assert.deepEqual([o[1].subject, o[1].delivered, o[1].channel, o[1].provider_message_id, o[1].transport, o[1].to_address], [null, null, 'email', 'fm_000000000000000a', 'local-fake', ADDRESS]);
  assert.equal(o[2].to_address, null, 'the null destination is stored as NULL'); assert.equal(o[3].delivered, 0); assert.equal(o[3].transport, 'sendgrid');
  assert.equal(JSON.parse(o[3].extra_json).__proto__.legacyMarker, 'keep-me'); assert.deepEqual(JSON.parse(o[3].extra_json).nested, { a: [1, { b: null }] });
  // The push log and the tokens.
  assert.deepEqual(s.prepare('SELECT id, audience_kind, audience_id, transport, extra_json FROM push_log ORDER BY seq').all().map((r) => [r.id, r.audience_kind, r.audience_id, r.transport, r.extra_json]), [['push-1', 'player', 'pl-adult', 'dev-log', null], ['push-2', 'org_user', 'usr-1', 'expo', '{"annotation":{"by":"tool"}}']]);
  const t = s.prepare('SELECT seq, ref_kind, ref_id, token_json, registered_at, extra_json FROM push_tokens ORDER BY seq').all().map((r) => ({ ...r }));
  assert.equal(t.length, 9, 'seven baseline rows + the org token + the prototype-keyed token');
  assert.deepEqual(t.slice(0, 7).map((r) => r.token_json), ['424242', '"424242"', 'true', '{"review":"synthetic"}', '{"review":"synthetic"}', '["synthetic"]', '["synthetic"]'], 'types kept in the JSON text; duplicates legal');
  assert.deepEqual([t[7].ref_kind, t[7].ref_id, t[7].extra_json], ['org', 'org-pro', '{"extra":"kept"}']); assert.equal(t[8].token_json, '{"__proto__":{"deviceMarker":"x"},"id":"dev-1"}');
  for (const n of ['outbox', 'pushLog', 'pushTokens']) assert.equal(blob(s, n), undefined, `the ${n} blob row is retired`);
  const record = JSON.parse(meta(s, 'outboxPushCutover'));
  assert.deepEqual(record, { at: NOW, outbox: { imported: 4, withExtraFields: 1, bySource: { mailer: 2, delivery: 2 } }, pushLog: { imported: 2, withExtraFields: 1, byAudienceKind: { player: 1, org_user: 1 } }, pushTokens: { imported: 9, withExtraFields: 1, byKind: { player: 7, org: 1, guardian: 1 }, byTokenType: { number: 1, string: 2, boolean: 1, object: 3, array: 2 } } });
  assert.doesNotMatch(JSON.stringify(record), /example\.test|Synthetic|ExponentPushToken|424242/, 'the record carries no address, text or token');
  // The export reproduces the legacy shapes, position for position.
  const repo = bare(s);
  const ex = repo.outbox.exportRows();
  assert.deepEqual(ex.slice(0, 3), [mail(), delivery(), delivery({ id: 'mail-3', to: null, providerMessageId: 'fm_000000000000000b' })], 'byte-identical: the delivery record has no subject/delivered key, the mailer record no channel/providerMessageId key, the null destination present');
  assert.deepEqual(Object.keys(ex[1]), DELIVERY_KEYS); assert.deepEqual(Object.keys(ex[0]), MAILER_KEYS); assert.ok(Object.hasOwn(ex[2], 'to') && ex[2].to === null);
  assert.equal(JSON.stringify(ex[3]), JSON.stringify(extrasFirst(special, MAILER_KEYS))); assert.ok(Object.hasOwn(ex[3], '__proto__') && ex[3].__proto__.legacyMarker === 'keep-me'); assert.equal(Object.getPrototypeOf(ex[3]), Object.prototype);
  assert.equal(JSON.stringify(repo.pushLog.exportRows()), JSON.stringify([push(), extrasFirst(pushLog[1], PUSH_KEYS)]));
  const tx = repo.pushTokens.exportRows();
  assert.deepEqual(tx.slice(0, 7), list, 'tokens with their values and types'); assert.equal(typeof tx[0].token, 'number'); assert.equal(typeof tx[1].token, 'string'); assert.equal(typeof tx[2].token, 'boolean');
  assert.equal(JSON.stringify(tx[7]), JSON.stringify(extrasFirst(pushTokens[7], TOKEN_KEYS))); assert.ok(Object.hasOwn(tx[8].token, '__proto__') && tx[8].token.__proto__.deviceMarker === 'x', 'an own __proto__ key inside a token is data');
  assert.deepEqual(repo.pushTokens.forAudience('player', 'pl-adult').map((r) => r.token), list.map((r) => r.token), 'the sender filter returns the registered values and types');
  // Rerun: nothing happens twice.
  assert.deepEqual(migrate(s).ran, []); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 9);
  s.close(); rm(dir);
});

test('[cutover] migration 0011: a missing collection, an empty collection, an empty database and a first installation import nothing (never from the seed, never from memory); a rerun does nothing', () => {
  const none = tempDir('obp-mig-none'); s7bFile(none);
  { const s = openRaw(none); assert.deepEqual(migrate(s).ran, [MIGRATION]); for (const t of ['outbox', 'push_log', 'push_tokens']) assert.equal(s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0); assert.deepEqual(JSON.parse(meta(s, 'outboxPushCutover')).outbox, { imported: 0, withExtraFields: 0, bySource: {} }); s.close(); }
  const empty = tempDir('obp-mig-empty'); s7bFile(empty, { outbox: [], pushLog: [], pushTokens: [] });
  { const s = openRaw(empty); migrate(s); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0); assert.equal(blob(s, 'pushTokens'), undefined, 'the empty blob row is retired too'); s.close(); }
  const fresh = tempDir('obp-mig-fresh');
  { const s = openRaw(fresh); migrate(s); assert.ok(applied(s).includes(MIGRATION)); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM push_log').get().n, 0); s.close(); }
  // A first installation through the real boot: the seed's empty containers are dropped, nothing imported.
  const boot = tempDir('obp-mig-boot'); s7bFile(boot);
  { const L = live(boot); assert.deepEqual(L.repo.counts(), { outbox: 0, pushLog: 0, pushTokens: 0 }); assert.ok(Array.isArray(L.db.outbox) && L.db.outbox.length === 0); assert.throws(() => L.db.outbox.push({}), /written through its domain repository/); L.close(); }
  rm(none, empty, fresh, boot);
});

test('[cutover] migration 0011 refusals (whole write, nothing imported, blobs and saveSeq untouched, no address / text / token in the diagnostic): an outbox entry matching both shapes, neither shape, a missing key of its literal, a non-boolean delivered, a non-string subject, a duplicate id; a push record with an extra audience field or a non-string body; a token entry without a kind; a non-array collection; a non-JSON blob', () => {
  const SECRET = 'SECRET-ADDRESS-77@example.test'; const TEXTSECRET = 'SECRET-BODY-77'; const TOKENSECRET = 'ExponentPushToken[SECRET-77]';
  const cases = [
    ['outbox', [mail({ to: SECRET, at: 1, channel: 'email' })], /matches both outbox shapes/],
    ['outbox', [{ id: 'mail-x', to: SECRET, text: TEXTSECRET }], /matches neither outbox shape/],
    ['outbox', [{ id: 'mail-x', ts: 1, to: SECRET, subject: 'S', transport: 'dev-outbox', delivered: true }], /text is absent/],
    ['outbox', [{ id: 'mail-x', at: 1, channel: 'email', to: SECRET, text: TEXTSECRET, provider: 'local-fake' }], /providerMessageId is absent/],
    ['outbox', [mail({ to: SECRET, delivered: 'yes' })], /delivered must be a boolean/],
    ['outbox', [mail({ to: SECRET, subject: null })], /subject must be a string/],
    ['outbox', [mail({ to: SECRET }), mail({ to: SECRET })], /duplicates the id/],
    ['outbox', [delivery({ to: SECRET, text: 7 })], /text must be a string/],
    ['pushLog', [push({ body: TEXTSECRET, audience: { kind: 'player', id: 'pl-adult', name: 'x' } })], /audience carries unknown field/],
    ['pushLog', [push({ body: 7 })], /body must be a string/],
    ['pushTokens', [{ refId: 'pl-adult', token: TOKENSECRET, ts: 1 }], /kind is absent/],
    ['pushTokens', [token(TOKENSECRET, { ts: 1.5 })], /ts must be an integer/],
    ['pushTokens', { token: TOKENSECRET }, /must be an array of entries/],
  ];
  for (const [name, value, re] of cases) {
    const dir = tempDir('obp-mig-refuse'); const fixture = { outbox: [mail()], pushLog: [push()], pushTokens: [token('ok')] }; fixture[name] = value; s7bFile(dir, fixture);
    const s = openRaw(dir); const before = dump(s); const seq0 = Number(meta(s, 'saveSeq'));
    assert.throws(() => migrate(s), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && re.test(e.message) && new RegExp(`the ${name} blob`).test(e.message) && !e.message.includes(SECRET) && !e.message.includes(TEXTSECRET) && !e.message.includes(TOKENSECRET), `${name}: ${re}`);
    assert.equal(s.isTransaction, false); assert.deepEqual(dump(s), before, 'nothing changed'); assert.equal(Number(meta(s, 'saveSeq')), seq0); assert.ok(!applied(s).includes(MIGRATION)); assert.ok(blob(s, name) !== undefined, 'the blob is still there');
    for (const t of ['outbox', 'push_log', 'push_tokens']) assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined, `${t} not created`);
    s.close(); rm(dir);
  }
  const bad = tempDir('obp-mig-badjson'); s7bFile(bad, { rawBlobs: { pushLog: '{not json' } });
  { const s = openRaw(bad); assert.throws(() => migrate(s), /the pushLog blob is not valid JSON/); assert.ok(!applied(s).includes(MIGRATION)); s.close(); rm(bad); }
});

// ============================================================= [cutover] the actual schema (direct SQL)
test('[cutover] the actual schema (direct SQL on the real DDL): the structural source CHECK refuses a mailer row without subject or delivered and a delivery row carrying subject or delivered (NULL means "absent key", never a value); to_address NULL is accepted for BOTH sources (the review of 6ca66ba: an accepted queued dispatch yields to: null); token_json must be valid JSON and admits every JSON type; no uniqueness on tokens; no vocabulary CHECK on transport, channel, audience kind or ref kind', () => {
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
  const tok = (kind, json) => s.prepare('INSERT INTO push_tokens (ref_kind, ref_id, token_json, registered_at) VALUES (?, ?, ?, ?)').run(kind, 'x', json, 1);
  for (const j of ['424242', '"424242"', 'true', 'null', '{"a":[1]}', '[1,2]']) tok('player', j);
  tok('player', '424242'); tok('org_user', '424242'); tok('ts_reviewer', '"t"'); // duplicates legal; any kind
  assert.throws(() => tok('player', '{bad'), /CHECK constraint failed/, 'token_json must be valid JSON');
  assert.throws(() => s.prepare('INSERT INTO push_tokens (ref_kind, ref_id, registered_at) VALUES (?, ?, ?)').run('player', 'x', 1), /NOT NULL constraint failed: push_tokens.token_json/);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 9);
  s.prepare('INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p1', 1, 'anything', 'x', 't', 'b', 'any-transport');
  assert.throws(() => s.prepare('INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p2', 1, null, 'x', 't', 'b', 'dev-log'), /NOT NULL constraint failed: push_log.audience_kind/);
  for (const t of ['outbox', 'push_log', 'push_tokens']) { assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/i); assert.deepEqual(s.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t} references nothing`); }
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_tokens' AND sql LIKE '%UNIQUE%'").get().n, 0, 'no unique index on the tokens');
  s.close(); rm(dir);
});

// ============================================================= [cutover] the repository, immediate mode
test('[cutover] repository (immediate mode): append validates like the import (both literals, a duplicate id, a non-JSON extra refused); markDelivered updates the mailer record (a delivery record, a missing id, a non-boolean refused inside the boundary); register reproduces the route — the nine baseline registrations persist 7 rows with the same types and order, a repeated primitive is removed and appended LAST with a new seq, an object never matches an existing row (its clone in the mirror included), 424242 and "424242" are different tokens, a token the caller keeps mutating never changes the mirror; forAudience returns detached copies with the registered types; insertion order is seq order (second connection); an owned transaction that fails at a statement or at COMMIT restores the mirrors in place (held views included) and the retry lands; a caller-owned raw transaction keeps the explicit reload() contract', () => {
  const dir = tempDir('obp-repo'); s7bFile(dir); { const s = openRaw(dir); migrate(s); s.close(); }
  const s = openRaw(dir); const repo = bare(s);
  const a = repo.outbox.append(mail()); const b = repo.outbox.append(delivery({ to: null })); assert.equal(a.delivered, true); assert.equal(b.to, null);
  assert.throws(() => repo.outbox.append(mail()), /already exists/); assert.throws(() => repo.outbox.append({ id: 'x' }), /matches neither outbox shape/); assert.throws(() => repo.outbox.append(mail({ id: 'mail-u', note: undefined })), /note \(undefined\) cannot be stored as JSON/); assert.equal(repo.outbox.count(), 2);
  assert.throws(() => repo.outbox.append(mail({ id: 'mail-f', fn: () => 1 })), /fn \(function\) cannot be stored as JSON/);
  repo.outbox.markDelivered('mail-1', false); assert.equal(a.delivered, false); assert.equal(rowsOf(dir, 'outbox')[0].delivered, 0);
  assert.throws(() => repo.outbox.markDelivered('mail-2', true), /is a delivery record/); assert.throws(() => repo.outbox.markDelivered('mail-none', true), /no record mail-none/); assert.throws(() => repo.outbox.markDelivered('mail-1', 'yes'), /delivered must be a boolean/);
  repo.pushLog.append(push()); assert.throws(() => repo.pushLog.append(push()), /already exists/); assert.throws(() => repo.pushLog.append(push({ id: 'push-2', audience: { kind: 'player' } })), /audience.id must be a non-empty string/);
  // The route's rule.
  BASELINE_TOKENS.forEach((v, i) => repo.pushTokens.register(token(v, { ts: NOW + i })));
  const mine = repo.pushTokens.forAudience('player', 'pl-adult');
  assert.deepEqual(mine.map((t) => t.token), [424242, '424242', true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic']]); assert.deepEqual(mine.map((t) => t.ts), [NOW + 1, NOW + 2, NOW + 4, NOW + 5, NOW + 6, NOW + 7, NOW + 8]);
  assert.deepEqual(tokenRows(dir).map((r) => r[2]), ['424242', '"424242"', 'true', '{"review":"synthetic"}', '{"review":"synthetic"}', '["synthetic"]', '["synthetic"]'], 'seq order = registration order after the collapses');
  const r = repo.pushTokens.register(token(424242, { ts: NOW + 20 })); assert.equal(r.removed, 1); assert.deepEqual(repo.pushTokens.forAudience('player', 'pl-adult').map((t) => t.token), ['424242', true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic'], 424242], 'the primitive moved last'); assert.equal(tokenRows(dir).length, 7);
  const obj = { review: 'synthetic' }; const r2 = repo.pushTokens.register(token(obj, { ts: NOW + 21 })); assert.equal(r2.removed, 0, 'an object never matches'); obj.review = 'mutated after the call'; assert.equal(repo.pushTokens.forAudience('player', 'pl-adult').at(-1).token.review, 'synthetic', 'the mirror holds a detached copy');
  const r3 = repo.pushTokens.register(token(obj, { ts: NOW + 22 })); assert.equal(r3.removed, 0, 'the same object reference again: the mirror holds a clone, so even an in-process caller reusing the object gets a new row (the route\'s bodies are always fresh)');
  assert.equal(repo.pushTokens.register(token('424242', { ts: NOW + 23 })).removed, 1, 'the string collapses the string row, not the number');
  repo.pushTokens.register({ kind: 'org', refId: 'org-pro', token: 424242, ts: NOW + 24 }); assert.equal(repo.pushTokens.forAudience('org', 'org-pro').length, 1); assert.equal(repo.pushTokens.forAudience('player', 'pl-adult').length, 9);
  assert.throws(() => repo.pushTokens.register(token(undefined)), /token \(undefined\) cannot be stored as JSON/); assert.throws(() => repo.pushTokens.register(token(() => 1)), /token \(function\) cannot be stored as JSON/); assert.throws(() => repo.pushTokens.register({ kind: 'player', token: 'x', ts: 1 }), /refId is absent/);
  const copies = repo.pushTokens.forAudience('player', 'pl-adult'); assert.deepEqual(copies.map((t) => t.token), [true, { review: 'synthetic' }, { review: 'synthetic' }, ['synthetic'], ['synthetic'], 424242, { review: 'synthetic' }, { review: 'mutated after the call' }, '424242'], 'the third registration cloned the object as it was at that call'); copies[1].token.review = 'edited'; assert.equal(repo.pushTokens.forAudience('player', 'pl-adult')[1].token.review, 'synthetic', 'forAudience hands out detached copies');
  assert.deepEqual(rowsOf(dir, 'push_tokens').map((x) => x.ref_kind), [...Array(9).fill('player'), 'org']);
  // Owned-transaction failure: statement and real COMMIT failures restore the mirrors in place.
  const snapshot = () => ({ outbox: plain(repo.outbox.exportRows()), push: plain(repo.pushLog.exportRows()), tokens: plain(repo.pushTokens.exportRows()), held: [plain(a), plain(b)], durable: [outboxIds(dir), tokenRows(dir)] });
  const before = snapshot();
  s.exec("CREATE TEMP TRIGGER rv_ins BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  assert.throws(() => repo.outbox.append(mail({ id: 'mail-5' })), /synthetic insert failure/); assert.deepEqual(snapshot(), before); assert.equal(repo.outbox.byId('mail-5'), null); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_ins');
  s.exec("CREATE TEMP TRIGGER rv_del BEFORE DELETE ON push_tokens BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
  assert.throws(() => repo.pushTokens.register(token(true, { ts: NOW + 30 })), /synthetic delete failure/); assert.deepEqual(snapshot(), before, 'the removed rows are back in their positions');
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
  assert.ok(repo.outbox.byId('mail-raw')); repo.reload(); assert.equal(repo.outbox.byId('mail-raw'), null); assert.equal(repo.outbox.count(), 2);
  s.close(); rm(dir);
});

// ============================================================= [cutover] the staged mode (the server's)
test('[cutover] staged mode (the server): an outbox record, a push record and a registration are visible in memory at once but NOT durable ahead of the next snapshot save, which lands them in ONE revision with the blob edits made alongside (second connection); a FAILED ORDINARY SAVE (statement or real COMMIT) keeps the mirrors and the queue as they are — pending state retained, nothing dropped — and the retry lands everything once, never twice; an ABORTED UNIT OF WORK restores the mirrors and the queue to the pre-unit state (held views included, a registration\'s removed rows back in place) whether the unit threw, a queued statement failed at the flush, the real COMMIT failed or a participant refusal was caught; writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('obp-staged'); s7bFile(dir, { pushTokens: [token('existing-primitive')] });
  const L = live(dir); L.save();
  const seq0 = seqOf(dir);
  L.db.requests.push({ id: 'req-1' });
  const a = L.repo.outbox.append(mail()); L.repo.pushLog.append(push()); const reg = L.repo.pushTokens.register(token('existing-primitive', { ts: NOW + 1 }));
  assert.equal(reg.removed, 1); assert.equal(L.repo.pending(), 3); assert.deepEqual(outboxIds(dir), [], 'nothing durable before the save'); assert.deepEqual(tokenRows(dir).map((r) => r[3]), [NOW - MIN], 'the old row is still the durable one'); assert.equal(L.db.pushTokens.length, 1, 'memory shows the re-registration at once');
  // A failed ordinary save (statement): pending state retained.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(outboxIds(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3); assert.equal(L.db.outbox.length, 1, 'memory is the intended state'); assert.equal(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-1'), false, 'the blob did not land without the rows');
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  // A failed ordinary save (real COMMIT): pending state retained.
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON push_log BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(outboxIds(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3);
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  // The retry: one revision, everything together, once.
  L.save();
  assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(outboxIds(dir), ['mail-1']); assert.deepEqual(rowsOf(dir, 'push_log').map((r) => r.id), ['push-1']); assert.deepEqual(tokenRows(dir), [['player', 'pl-adult', '"existing-primitive"', NOW + 1]], 'the old row deleted, the new one last'); assert.ok(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-1')); assert.equal(L.repo.pending(), 0);
  L.save(); assert.equal(seqOf(dir), seq0 + 2); assert.equal(tokenRows(dir).length, 1, 'a later save does not replay');
  // A unit of work: together or not at all; a caught participant failure still poisons the unit; pre-unit writes survive.
  const pre = L.repo.pushLog.append(push({ id: 'push-pre' })); assert.equal(L.repo.pending(), 1);
  const state = () => ({ outbox: plain(L.repo.outbox.exportRows()), push: plain(L.repo.pushLog.exportRows()), tokens: plain(L.repo.pushTokens.exportRows()), held: plain(a), requests: JSON.stringify(L.db.requests), durable: [outboxIds(dir), tokenRows(dir), seqOf(dir)] });
  const before = state();
  const unchanged = (label) => { assert.deepEqual(state(), before, label); assert.equal(L.repo.pending(), 1, `${label}: the pre-unit write is still pending`); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false); };
  const work = () => { L.db.requests.push({ id: 'req-u' }); L.repo.outbox.markDelivered('mail-1', false); L.repo.outbox.append(delivery({ id: 'mail-u' })); L.repo.pushTokens.register(token('existing-primitive', { ts: NOW + 9 })); L.repo.pushTokens.register(token({ o: 1 })); };
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
  assert.equal(seqOf(dir), before.durable[2] + 1); assert.deepEqual(outboxIds(dir), ['mail-1', 'mail-u']); assert.equal(rowsOf(dir, 'outbox')[0].delivered, 0); assert.deepEqual(rowsOf(dir, 'push_log').map((r) => r.id), ['push-1', 'push-pre'], 'the pre-unit write landed with the unit'); assert.deepEqual(tokenRows(dir).map((r) => r[2]), ['"existing-primitive"', '{"o":1}']); assert.ok(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-u')); assert.equal(L.repo.pending(), 0); assert.ok(pre.id);
  // Hook registration is a precondition inside the joined boundary.
  const { createOutboxPushRepository } = needModule();
  const bareUnit = createOutboxPushRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit });
  const stagedUnit = createOutboxPushRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true });
  for (const [label, w] of [['immediate', () => bareUnit.pushLog.append(push({ id: 'push-h' }))], ['staged', () => stagedUnit.pushLog.append(push({ id: 'push-h' }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-h' }); try { w(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-h'), false);
  }
  assert.throws(() => stagedUnit.pushLog.append(push({ id: 'push-h' })), /save hook/, 'standalone staged write without the hook');
  assert.throws(() => createOutboxPushRepository({ sqlite: L.store.sqlite, staged: true }), /needs the store's participant API/);
  L.close(); rm(dir);
});

// ============================================================= [cutover] detached data
test('[cutover] exports and token data are DETACHED: mutating a returned export, a forAudience copy or the caller\'s own input after append/register never changes the mirror or a later export; own prototype-like keys ("__proto__", "constructor", "toString") survive at every depth of an extra and of a token; a rolled-back unit leaves the held view on the restored row; a reload (restart) reproduces the stored JSON; a non-JSON extra or token refuses the write whole (nothing queued)', () => {
  const dir = tempDir('obp-detach'); s7bFile(dir); const L = live(dir); L.save();
  const input = JSON.parse('{"id":"mail-p","ts":1,"to":"synthetic@example.test","subject":"S","text":"T","transport":"dev-outbox","delivered":true,"__proto__":{"legacyMarker":"keep-me"},"constructor":{"toString":[null,true,{"__proto__":"deep"}]}}');
  const held = L.repo.outbox.append(input); input.constructor.toString.push('mutated after append'); input.__proto__.legacyMarker = 'mutated';
  const tokenInput = JSON.parse('{"kind":"player","refId":"pl-adult","token":{"__proto__":{"deviceMarker":"x"},"list":["a"]},"ts":1}');
  L.repo.pushTokens.register(tokenInput); tokenInput.token.list.push('mutated after register');
  // (built from JSON text: an object LITERAL with a `__proto__:` key would set the prototype instead of an own key)
  const expectedExtras = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"},"constructor":{"toString":[null,true,{"__proto__":"deep"}]}}');
  const extrasOf = (row) => { const o = {}; for (const k of Object.keys(row)) if (!MAILER_KEYS.includes(k)) setOwn(o, k, row[k]); return JSON.parse(JSON.stringify(o)); };
  assert.deepEqual(extrasOf(L.repo.outbox.exportRows()[0]), expectedExtras, 'the input\'s later mutation did not reach the mirror'); assert.deepEqual(plain(L.repo.pushTokens.forAudience('player', 'pl-adult')[0].token), JSON.parse('{"__proto__":{"deviceMarker":"x"},"list":["a"]}'));
  const ex = L.repo.outbox.exportRows(); ex[0].constructor.toString.push('export edit'); assert.equal(L.repo.outbox.exportRows()[0].constructor.toString.length, 3, 'an export edit does not reach the mirror'); assert.equal(held.constructor.toString.length, 3);
  assert.throws(() => { held.constructor.toString.push('x'); }, /written through its domain repository/, 'the view refuses a nested write');
  L.save();
  assert.throws(() => L.store.unitOfWork(() => { L.repo.outbox.exportRows()[0].constructor.toString.push('aborted'); L.repo.outbox.markDelivered('mail-p', false); throw new Error('abort'); }, { snapshot: L.snapshot }), /abort/);
  assert.equal(held.delivered, true); assert.equal(held.constructor.toString.length, 3);
  const stored = JSON.parse(rowsOf(dir, 'outbox')[0].extra_json); assert.deepEqual(JSON.parse(JSON.stringify(stored)), expectedExtras);
  L.close();
  const L2 = live(dir); assert.deepEqual(extrasOf(L2.repo.outbox.exportRows()[0]), expectedExtras, 'a restart reproduces the stored JSON'); assert.ok(Object.hasOwn(L2.repo.pushTokens.exportRows()[0].token, '__proto__'));
  for (const bad of [{ note: undefined }, { fn: () => 1 }, { big: 10n }, { inf: Infinity }, { inst: new Date(0) }]) assert.throws(() => L2.repo.outbox.append(mail({ id: 'mail-bad', ...bad })), /cannot be stored as JSON/);
  assert.throws(() => L2.repo.pushTokens.register(token({ inner: Symbol('x') })), /token.inner \(symbol\) cannot be stored as JSON/);
  assert.equal(L2.repo.pending(), 0, 'nothing queued by a refusal'); assert.equal(L2.repo.outbox.count(), 1);
  L2.close(); rm(dir);
});

// ============================================================= [cutover] the snapshot dispatcher (backups, restores, the persistence suites)
test('[cutover] snapshot dispatcher: a tool that loads and saves the whole file round-trips every outbox record (both literals, the null destination, the own special key), push record and token (types kept) byte for byte; a snapshot that OMITS a collection leaves its table alone (the other two rewritten); an explicit EMPTY array clears a table; a malformed collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid entry refuses the whole save with a text-free diagnostic', () => {
  const dir = tempDir('obp-snap');
  const special = JSON.parse('{"id":"mail-proto","ts":1,"to":"synthetic@example.test","subject":"S","text":"T","transport":"dev-outbox","delivered":true,"__proto__":{"legacyMarker":"keep-me"}}');
  let list = []; BASELINE_TOKENS.forEach((v, i) => { list = routeRegister(list, 'player', 'pl-adult', v, NOW + i); });
  s7bFile(dir, { outbox: [mail(), delivery({ to: null }), special], pushLog: [push()], pushTokens: list });
  { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load();
  assert.equal(JSON.stringify(snap.db.outbox), JSON.stringify([mail(), delivery({ to: null }), extrasFirst(special, MAILER_KEYS)])); assert.ok(Object.hasOwn(snap.db.outbox[2], '__proto__')); assert.deepEqual(snap.db.pushTokens, list); assert.equal(typeof snap.db.pushTokens[0].token, 'number');
  const seq0 = tool.revision(); tool.save(snap);
  assert.equal(tool.revision(), seq0 + 1); const again = tool.load(); assert.equal(JSON.stringify(again.db.outbox), JSON.stringify(snap.db.outbox), 'round-tripped through replace'); assert.deepEqual(again.db.pushTokens, list); assert.deepEqual(again.db.pushLog, [push()]);
  // Omitted: left alone; the others rewritten.
  const { pushTokens: _omit, ...without } = snap.db; tool.save({ ...snap, db: { ...without, pushLog: [] } });
  assert.equal(tokenRows(dir).length, 7, 'an omitted collection leaves its table alone'); assert.equal(rowsOf(dir, 'push_log').length, 0, 'an explicit empty array clears'); assert.equal(blobOf(dir, 'pushTokens'), null, 'and never recreates a shadow blob');
  // Malformed: the whole save rolls back.
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, requests: [{ id: 'req-x' }], outbox: { id: 'x' } } }), /outbox: the snapshot collection must be an array/);
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (requests included)');
  const SECRET = 'SECRET-ADDRESS-77@example.test';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, requests: [{ id: 'req-x' }], outbox: [mail({ id: 'mail-bad', to: SECRET, at: 5 })] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /matches both outbox shapes/.test(e.message) && !e.message.includes(SECRET));
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, pushTokens: [token(SECRET, { kind: '' })] } }), (e) => /OUTBOX_PUSH_IMPORT_BLOCKED/.test(e.message) && /kind must be a non-empty string/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  tool.save({ ...snap, db: { ...snap.db, outbox: [] } }); assert.deepEqual(outboxIds(dir), []); assert.equal(blobOf(dir, 'outbox'), null);
  tool.sqlite.close(); rm(dir);
});

// ============================================================= [cutover] the copy-only rollback to the accepted 6ca66ba build
test('[cutover] rollback (copy-only): every outbox record (each in its writer\'s literal with exactly its keys, the null destination present, the own special key), every push record and every token (values and types) is written back into the three blobs in insertion order; the three tables are dropped, the 0011 record and its meta key removed, saveSeq advanced, every other table byte-identical (the S7a and S7b tables included), the source untouched; the real migration re-upgrades the copy to the same rows; the S7b tool refuses a 0011 file (LATER_SCHEMA); refusals leave no output: a later schema step (exit 4), a file that never applied 0011 (exit 5), a non-empty output directory (exit 1), a recorded 0011 whose tables are missing (exit 10), an injected COMMIT failure inside the tool', () => {
  assert.ok(rollbackMod, 'repositories/outboxPushRollback.mjs exists'); const { rollbackOutboxPushCopy } = rollbackMod;
  const src = tempDir('obp-rb-src');
  const special = JSON.parse('{"id":"mail-proto","ts":1,"to":"synthetic@example.test","subject":"S","text":"T","transport":"sendgrid","delivered":false,"__proto__":{"legacyMarker":"keep-me"}}');
  let list = []; BASELINE_TOKENS.forEach((v, i) => { list = routeRegister(list, 'player', 'pl-adult', v, NOW + i); });
  const outbox = [mail(), delivery({ to: null }), special]; const pushLog = [push(), push({ id: 'push-2', audience: { kind: 'org_user', id: 'usr-1' } })];
  s7bFile(src, { outbox, pushLog, pushTokens: list });
  { const s = openRaw(src); migrate(s); const repo = bare(s); repo.outbox.append(delivery({ id: 'mail-after', providerMessageId: 'fm_after' })); repo.pushTokens.register({ kind: 'org', refId: 'org-pro', token: ['after', { cutover: true }], ts: NOW + 50 }); s.close(); }
  const before = { dump: dump(openRaw(src), { except: ['outbox', 'push_log', 'push_tokens', 'collections', 'meta', 'data_migrations'] }), bytes: fs.statSync(dbFile(src)).size, saveSeq: seqOf(src), notifications: rowsOf(src, 'notifications', 'rowid'), dispatches: rowsOf(src, 'dispatches', 'rowid') };
  const out = tempDir('obp-rb-out');
  const result = rollbackOutboxPushCopy(dbFile(src), out, { now: NOW });
  assert.equal(result.output, dbFile(out)); assert.deepEqual(result.counts, { outbox: 4, pushLog: 2, pushTokens: 8 }); assert.equal(result.recordRemoved, true); assert.equal(result.saveSeq, before.saveSeq + 1);
  assert.equal(fs.statSync(dbFile(src)).size, before.bytes, 'the source is untouched'); assert.equal(seqOf(src), before.saveSeq); assert.ok(tableExistsIn(src, 'outbox'));
  const o = openRaw(out);
  assert.ok(!applied(o).includes(MIGRATION)); for (const t of ['outbox', 'push_log', 'push_tokens']) assert.equal(o.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined); assert.equal(meta(o, 'outboxPushCutover'), undefined);
  const back = blob(o, 'outbox');
  assert.equal(JSON.stringify(back), JSON.stringify([mail(), delivery({ to: null }), extrasFirst(special, MAILER_KEYS), delivery({ id: 'mail-after', providerMessageId: 'fm_after' })]), 'every row in order, each in its literal, the post-cutover row included'); assert.ok(Object.hasOwn(back[1], 'to') && back[1].to === null); assert.deepEqual(Object.keys(back[1]), DELIVERY_KEYS);
  assert.deepEqual(blob(o, 'pushLog'), pushLog); const tokensBack = blob(o, 'pushTokens'); assert.deepEqual(tokensBack, [...list, { kind: 'org', refId: 'org-pro', token: ['after', { cutover: true }], ts: NOW + 50 }]); assert.equal(typeof tokensBack[0].token, 'number');
  assert.equal(dump(o, { except: ['outbox', 'push_log', 'push_tokens', 'collections', 'meta', 'data_migrations'] }), before.dump, 'every other table byte-identical'); assert.deepEqual(rowsOf(out, 'notifications', 'rowid'), before.notifications); assert.deepEqual(rowsOf(out, 'dispatches', 'rowid'), before.dispatches);
  assert.equal(o.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  // Re-upgrade: the real migration brings the same rows back.
  assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [MIGRATION]); assert.deepEqual(rowsOf(out, 'outbox').map((r) => [r.id, r.source, r.to_address]), [['mail-1', 'mailer', ADDRESS], ['mail-2', 'delivery', null], ['mail-proto', 'mailer', 'synthetic@example.test'], ['mail-after', 'delivery', ADDRESS]]); assert.equal(rowsOf(out, 'push_tokens').length, 8); assert.equal(blob(o, 'pushTokens'), undefined);
  o.close();
  // The S7b tool refuses the S7c file.
  const s7bOut = tempDir('obp-rb-s7b'); assert.throws(() => rollbackDispatchesCopy(dbFile(src), s7bOut), (e) => e.code === 'LATER_SCHEMA' && /0011_outbox_push/.test(e.message)); assert.deepEqual(fs.readdirSync(s7bOut), []);
  // The CLI and the refusals.
  const script = path.join(HERE, 'outboxPushRollback.mjs');
  const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  const cli = tempDir('obp-rb-cli'); const r0 = run([src, cli]); assert.equal(r0.code, 0, r0.out); assert.match(r0.out, /4 outbox record\(s\), 2 push log record\(s\) and 8 device token\(s\) written back/); assert.doesNotMatch(r0.out, /example\.test|424242/);
  const later = tempDir('obp-rb-later'); fs.copyFileSync(dbFile(src), dbFile(later)); { const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0012_future_step', 1)").run(); l.close(); }
  const o1 = tempDir('obp-rb-o1'); assert.throws(() => rollbackOutboxPushCopy(dbFile(later), o1), (e) => e.code === 'LATER_SCHEMA' && /0012_future_step/.test(e.message)); assert.deepEqual(fs.readdirSync(o1), []); assert.equal(run([later, tempDir('obp-rb-o1b')]).code, 4);
  const notCut = tempDir('obp-rb-notcut'); s7bFile(notCut); const o2 = tempDir('obp-rb-o2'); assert.throws(() => rollbackOutboxPushCopy(dbFile(notCut), o2), (e) => e.code === 'NOT_CUT_OVER'); assert.deepEqual(fs.readdirSync(o2), []); assert.equal(run([notCut, tempDir('obp-rb-o2b')]).code, 5);
  const o3 = tempDir('obp-rb-o3'); fs.writeFileSync(path.join(o3, 'keep.txt'), 'x'); assert.throws(() => rollbackOutboxPushCopy(dbFile(src), o3), (e) => e.code === 'OUTPUT_NOT_EMPTY'); assert.equal(run([src, o3]).code, 1); assert.deepEqual(fs.readdirSync(o3), ['keep.txt']);
  const odd = tempDir('obp-rb-odd'); fs.copyFileSync(dbFile(src), dbFile(odd)); { const x = openRaw(odd); x.exec('DROP TABLE push_tokens'); x.close(); } const o4 = tempDir('obp-rb-o4'); assert.throws(() => rollbackOutboxPushCopy(dbFile(odd), o4), (e) => e.code === 'UNEXPECTED_SCHEMA'); assert.deepEqual(fs.readdirSync(o4), []); assert.equal(run([odd, tempDir('obp-rb-o4b')]).code, 10);
  const o5 = tempDir('obp-rb-o5'); const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the S7c rollback tool'); } return exec.call(this, sql); };
  try { assert.throws(() => rollbackOutboxPushCopy(dbFile(src), o5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.deepEqual(fs.readdirSync(o5), [], 'no partial copy'); assert.equal(fs.statSync(dbFile(src)).size, before.bytes);
  rm(src, out, s7bOut, cli, later, o1, notCut, o2, o3, odd, o4, o5);
});

// ============================================================= review of 40aa05c — two independently reproduced compatibility defects
/** The `outbox` table exactly as the unaccepted 40aa05c build of migration 0011 created it (no `to_json` column): a scratch database at that build. */
const OUTBOX_DDL_40AA05C = `CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT,
  subject             TEXT,
  text                TEXT NOT NULL,
  transport           TEXT NOT NULL,
  delivered           INTEGER,
  channel             TEXT,
  provider_message_id TEXT,
  extra_json          TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL)
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL))
) STRICT;
CREATE INDEX outbox_created_at ON outbox (created_at);`;

test('[review of 40aa05c, F2] a mail destination the accepted build persisted as a JSON ARRAY (POST /org/invites validates with RegExp.test, which coerces, stores String(email) on the invite and hands the ORIGINAL value to the mailer; the m14 player invite does the same through emailProblem): migration 0011 imports it with its value and type, append accepts it, the table holds it losslessly beside string and null destinations (to_address for a string, to_json for any other JSON value, never both), the export / the snapshot reader / the backup round trip / the copy-only rollback reproduce the array exactly as the 6ca66ba blob held it, the re-upgrade keeps it; a non-JSON destination is still refused by name with nothing written; a scratch database created by the unaccepted 40aa05c build (0011 recorded, outbox without to_json) is refused by name at attach with the file untouched, read by the rollback tool, and re-upgraded into the corrected table', () => {
  const dir = tempDir('obp-f2');
  const ONE = ['synthetic-review@example.invalid']; const TWO = ['synthetic-second@example.invalid', 'x']; const NESTED = [['synthetic-nested@example.invalid'], 7, null, true];
  const arrayMail = mail({ id: 'mail-arr', to: ONE }); const twoMail = mail({ id: 'mail-two', to: TWO }); const nestedMail = mail({ id: 'mail-nested', to: NESTED });
  s7bFile(dir, { outbox: [mail(), arrayMail, delivery({ to: null }), twoMail, nestedMail] });
  assert.deepEqual(JSON.parse(blobOf(dir, 'outbox'))[1].to, ONE, 'the baseline: the 6ca66ba blob holds the array by value and type');
  const s = openRaw(dir);
  assert.deepEqual(migrate(s).ran, [MIGRATION], 'the array destination imports (the whole step, nothing refused)');
  const cols = s.prepare('PRAGMA table_info(outbox)').all().map((c) => c.name); assert.ok(cols.includes('to_json'), 'the corrected table carries to_json');
  assert.deepEqual(s.prepare('SELECT id, to_address, to_json FROM outbox ORDER BY seq').all().map((r) => [r.id, r.to_address, r.to_json]), [['mail-1', ADDRESS, null], ['mail-arr', null, JSON.stringify(ONE)], ['mail-2', null, null], ['mail-two', null, JSON.stringify(TWO)], ['mail-nested', null, JSON.stringify(NESTED)]], 'a string in to_address, null as NULL/NULL, any other JSON value in to_json');
  const repo = bare(s);
  const ex = repo.outbox.exportRows();
  assert.deepEqual(ex.map((m) => m.to), [ADDRESS, ONE, null, TWO, NESTED], 'the export reproduces every destination with its type'); assert.deepEqual(Object.keys(ex[1]), MAILER_KEYS); assert.equal(JSON.stringify(ex[1]), JSON.stringify(arrayMail), 'byte-identical to the accepted literal');
  ex[1].to.push('mutated export'); assert.deepEqual(plain(repo.outbox.exportRows()[1].to), ONE, 'the exported array is detached');
  const ap = repo.outbox.append(mail({ id: 'mail-ap', to: ['synthetic-append@example.invalid'] })); assert.deepEqual(plain(ap.to), ['synthetic-append@example.invalid'], 'append accepts what the route accepts');
  const dl = repo.outbox.append(delivery({ id: 'mail-dl', to: ['synthetic-delivery@example.invalid'], providerMessageId: 'fm_dl' })); assert.deepEqual(plain(dl.to), ['synthetic-delivery@example.invalid'], 'the representation is the literal\'s, in either shape');
  assert.deepEqual(repo.outbox.append(mail({ id: 'mail-null', to: null })).to, null, 'explicit null kept'); assert.equal(repo.outbox.append(mail({ id: 'mail-str', to: ADDRESS })).to, ADDRESS, 'an ordinary string kept');
  assert.throws(() => repo.outbox.append(mail({ id: 'mail-x', to: undefined })), /to \(undefined\) cannot be stored as JSON/, 'a non-JSON destination is still refused by name'); assert.throws(() => repo.outbox.append(mail({ id: 'mail-x', to: Symbol('s') })), /to \(symbol\) cannot be stored as JSON/); assert.throws(() => repo.outbox.append(mail({ id: 'mail-x', to: [() => 1] })), /to\[0\] \(function\) cannot be stored as JSON/);
  assert.equal(repo.outbox.byId('mail-x'), null, 'nothing written by a refusal'); assert.equal(repo.outbox.count(), 9);
  // The schema itself: exclusive columns; to_json never a JSON string or JSON null (those are to_address / NULL).
  const insert = (to_address, to_json) => s.prepare("INSERT INTO outbox (id, source, created_at, to_address, to_json, subject, text, transport, delivered) VALUES ('bad', 'mailer', 1, ?, ?, 'S', 'T', 'dev-outbox', 1)").run(to_address, to_json);
  for (const [a, j] of [['a@example.invalid', '["b"]'], [null, '"text"'], [null, 'null'], [null, 'not json']]) assert.throws(() => insert(a, j), /CHECK constraint failed/, `refused in SQL: to_address=${a} to_json=${j}`);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id = 'bad'").get().n, 0);
  // The snapshot reader (what the backup, the rollback tool and the reviewer's script read) and the dispatcher's round trip.
  assert.deepEqual(needModule().OUTBOX_TABLE.read(s).map((m) => m.to), [ADDRESS, ONE, null, TWO, NESTED, ['synthetic-append@example.invalid'], ['synthetic-delivery@example.invalid'], null, ADDRESS]);
  s.close();
  const tool = openStore(dir); const snap = tool.load(); assert.deepEqual(snap.db.outbox[1].to, ONE); tool.save(snap); assert.deepEqual(tool.load().db.outbox.map((m) => m.to), [ADDRESS, ONE, null, TWO, NESTED, ['synthetic-append@example.invalid'], ['synthetic-delivery@example.invalid'], null, ADDRESS], 'round-tripped through replace'); tool.sqlite.close();
  // The copy-only rollback: the blob holds the array exactly as the 6ca66ba build held it; the re-upgrade keeps it.
  assert.ok(rollbackMod, 'repositories/outboxPushRollback.mjs exists'); const out = tempDir('obp-f2-out');
  assert.equal(rollbackMod.rollbackOutboxPushCopy(dbFile(dir), out, { now: NOW }).counts.outbox, 9);
  const back = JSON.parse(blobOf(out, 'outbox')); assert.deepEqual(back.map((m) => m.to), [ADDRESS, ONE, null, TWO, NESTED, ['synthetic-append@example.invalid'], ['synthetic-delivery@example.invalid'], null, ADDRESS]); assert.equal(JSON.stringify(back[1]), JSON.stringify(arrayMail));
  { const o = openRaw(out); assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [MIGRATION]); assert.deepEqual(o.prepare('SELECT to_json FROM outbox ORDER BY seq').all().map((r) => r.to_json), [null, JSON.stringify(ONE), null, JSON.stringify(TWO), JSON.stringify(NESTED), '["synthetic-append@example.invalid"]', '["synthetic-delivery@example.invalid"]', null, null]); o.close(); }
  // A scratch database at the unaccepted 40aa05c build: refused by name, untouched, rolled back by the tool, re-upgraded.
  const stale = tempDir('obp-f2-stale'); s7bFile(stale, { outbox: [mail()], pushLog: [push()], pushTokens: [token('t')] });
  { const x = openRaw(stale); migrate(x); x.exec('BEGIN'); x.exec('DROP TABLE outbox'); x.exec(OUTBOX_DDL_40AA05C); x.prepare("INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered) VALUES ('mail-1', 'mailer', ?, ?, 'Synthetic subject', 'T', 'dev-outbox', 1)").run(NOW - MIN, ADDRESS); x.exec('COMMIT'); x.close(); }
  const staleBytes = fs.readFileSync(dbFile(stale));
  { const x = openRaw(stale); assert.throws(() => bare(x), (e) => e.code === 'OUTBOX_PUSH_SCHEMA_STALE' && /to_json/.test(e.message) && /40aa05c/.test(e.message) && !e.message.includes(ADDRESS), 'the repository refuses the 40aa05c shape by name (no address in the message)'); assert.equal(x.isTransaction, false); x.close(); }
  assert.throws(() => live(stale), /OUTBOX_PUSH_SCHEMA_STALE/, 'the data layer refuses to boot on it');
  assert.equal(Buffer.compare(fs.readFileSync(dbFile(stale)), staleBytes), 0, 'the refusal changes nothing');
  const staleOut = tempDir('obp-f2-stale-out');
  assert.deepEqual(rollbackMod.rollbackOutboxPushCopy(dbFile(stale), staleOut, { now: NOW }).counts, { outbox: 1, pushLog: 1, pushTokens: 1 }, 'the rollback tool reads the 40aa05c shape (every destination there is a string or null)');
  assert.equal(JSON.parse(blobOf(staleOut, 'outbox'))[0].to, ADDRESS);
  { const o = openRaw(staleOut); assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [MIGRATION]); assert.ok(o.prepare('PRAGMA table_info(outbox)').all().some((c) => c.name === 'to_json'), 're-upgraded into the corrected table'); const r = bare(o); assert.equal(r.outbox.count(), 1); assert.equal(r.outbox.exportRows()[0].to, ADDRESS); o.close(); }
  rm(dir, out, stale, staleOut);
});

test('[review of 40aa05c, F1] raw JSON number overflow in a token (1e400 parses to Infinity; also inside an object or an array): the route-reachable value is accepted and kept AS IS in the live mirror — the route\'s strict-equality rule needs the live value: a repeated positive Infinity collapses, negative Infinity is a different row, a persisted null from an earlier process is never the live Infinity — and written as JSON null at the save boundary exactly as the accepted build\'s JSON.stringify did; a replacement deletes exactly the removed row (by seq), never every row whose JSON text is "null"; registration order, timestamps, detached exports, aborted units, a failed save and its retry, the restart semantics (null after a restart), the backup and the rollback blob all match the accepted build; NaN cannot arrive from JSON but follows the same rule; genuinely unsupported values and the strict rule for every OTHER field (extras, outbox, push log) are unchanged', () => {
  const dir = tempDir('obp-f1');
  // A null row from an earlier process: what the accepted build persisted for a 1e400 registration (JSON.stringify(Infinity) === 'null').
  s7bFile(dir, { pushTokens: [token(null, { ts: NOW - 2 * MIN })] });
  const INF = JSON.parse('1e400'); const NEG = JSON.parse('-1e400'); assert.equal(INF, Infinity); assert.equal(NEG, -Infinity);
  // The accepted build's rule on its array: five registrations after the persisted null → five entries, JSON [null,null,null,{"n":null},[null]].
  let old = [token(null, { ts: NOW - 2 * MIN })]; [INF, INF, NEG, { n: INF }, [INF]].forEach((v, i) => { old = routeRegister(old, 'player', 'pl-adult', v, NOW + 1 + i); });
  assert.equal(JSON.stringify(old.map((t) => t.token)), '[null,null,null,{"n":null},[null]]'); assert.deepEqual(old.map((t) => t.ts), [NOW - 2 * MIN, NOW + 2, NOW + 3, NOW + 4, NOW + 5]);
  const L = live(dir); L.save();
  const r1 = L.repo.pushTokens.register(token(INF, { ts: NOW + 1 })); assert.equal(r1.removed, 0, 'the persisted null of an earlier process is not the live Infinity');
  assert.equal(L.repo.pushTokens.register(token(INF, { ts: NOW + 2 })).removed, 1, 'a repeated positive Infinity collapses (===)');
  assert.equal(L.repo.pushTokens.register(token(NEG, { ts: NOW + 3 })).removed, 0, 'negative Infinity is a different value');
  assert.equal(L.repo.pushTokens.register(token({ n: INF }, { ts: NOW + 4 })).removed, 0); assert.equal(L.repo.pushTokens.register(token([INF], { ts: NOW + 5 })).removed, 0);
  const live1 = L.repo.pushTokens.forAudience('player', 'pl-adult');
  assert.deepEqual(live1.map((t) => t.token), [null, Infinity, -Infinity, { n: Infinity }, [Infinity]], 'the live mirror keeps the values the sender compares and sends'); assert.deepEqual(live1.map((t) => t.ts), old.map((t) => t.ts), 'order and timestamps as the accepted build');
  assert.equal(JSON.stringify(live1.map((t) => t.token)), JSON.stringify(old.map((t) => t.token)), 'the provider payload and the backup JSON: null, as JSON.stringify always wrote');
  live1[1].token = 5; assert.equal(L.repo.pushTokens.forAudience('player', 'pl-adult')[1].token, Infinity, 'detached copies');
  assert.deepEqual(tokenRows(dir).map((r) => r[2]), ['null'], 'nothing durable before the save');
  L.save();
  assert.deepEqual(tokenRows(dir).map((r) => [r[2], r[3]]), [['null', NOW - 2 * MIN], ['null', NOW + 2], ['null', NOW + 3], ['{"n":null}', NOW + 4], ['[null]', NOW + 5]], 'persisted as JSON null at the save boundary; the earlier null row untouched; seq order = registration order');
  // Deletion is by row: a repeated -Infinity removes the -Infinity row only, although three rows read "null" in SQL.
  assert.equal(L.repo.pushTokens.register(token(NEG, { ts: NOW + 6 })).removed, 1); L.save();
  assert.deepEqual(tokenRows(dir).map((r) => r[3]), [NOW - 2 * MIN, NOW + 2, NOW + 4, NOW + 5, NOW + 6], 'exactly the -Infinity row went; the persisted null and the +Infinity row stayed');
  // An aborted unit restores the live values (Infinity, not null) and the durable rows.
  assert.throws(() => L.store.unitOfWork(() => { L.repo.pushTokens.register(token(INF, { ts: NOW + 7 })); throw new Error('abort'); }, { snapshot: L.snapshot }), /abort/);
  assert.deepEqual(L.repo.pushTokens.forAudience('player', 'pl-adult').map((t) => t.token), [null, Infinity, { n: Infinity }, [Infinity], -Infinity]); assert.equal(tokenRows(dir).length, 5);
  // A failed ordinary save keeps the pending state; the retry lands it once.
  assert.equal(L.repo.pushTokens.register(token(INF, { ts: NOW + 8 })).removed, 1, 'the live +Infinity collapses again');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_f1 BEFORE DELETE ON push_tokens BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
  assert.throws(() => L.save(), /synthetic delete failure/); assert.deepEqual(tokenRows(dir).map((r) => r[3]), [NOW - 2 * MIN, NOW + 2, NOW + 4, NOW + 5, NOW + 6]); assert.equal(L.repo.pending(), 1); assert.equal(L.repo.pushTokens.forAudience('player', 'pl-adult').at(-1).token, Infinity, 'memory is the intended state');
  L.store.sqlite.exec('DROP TRIGGER rv_f1'); L.save();
  assert.deepEqual(tokenRows(dir).map((r) => r[3]), [NOW - 2 * MIN, NOW + 4, NOW + 5, NOW + 6, NOW + 8], 'landed once: the +Infinity row moved last'); L.save(); assert.equal(tokenRows(dir).length, 5, 'no replay');
  // Restart semantics: a new process reads null for every non-finite value (as the accepted build did); a new live Infinity no longer matches any of them.
  L.close(); const L2 = live(dir);
  assert.deepEqual(L2.repo.pushTokens.forAudience('player', 'pl-adult').map((t) => t.token), [null, { n: null }, [null], null, null], 'after a restart: null');
  assert.equal(L2.repo.pushTokens.register(token(INF, { ts: NOW + 9 })).removed, 0, 'a persisted null is not removed by a new live Infinity'); L2.save(); assert.equal(tokenRows(dir).length, 6);
  assert.equal(L2.repo.pushTokens.register(token(INF, { ts: NOW + 10 })).removed, 1, 'and that live Infinity collapses only itself'); L2.save(); assert.equal(tokenRows(dir).length, 6); assert.deepEqual(tokenRows(dir).map((r) => r[3]).slice(0, 5), [NOW - 2 * MIN, NOW + 4, NOW + 5, NOW + 6, NOW + 8], 'the earlier rows untouched');
  // Finite primitives, fresh structurally equal objects, NaN.
  assert.equal(L2.repo.pushTokens.register(token(424242, { ts: NOW + 11 })).removed, 0); assert.equal(L2.repo.pushTokens.register(token(424242, { ts: NOW + 12 })).removed, 1, 'a finite primitive collapses as before');
  assert.equal(L2.repo.pushTokens.register(token({ n: INF }, { ts: NOW + 13 })).removed, 0, 'a fresh structurally equal object is a new row, as before');
  assert.equal(L2.repo.pushTokens.register(token(Number.NaN, { ts: NOW + 14 })).removed, 0); assert.equal(L2.repo.pushTokens.register(token(Number.NaN, { ts: NOW + 15 })).removed, 0, 'NaN never equals itself under ===, so it never collapses (the array behaved the same)'); L2.save();
  assert.deepEqual(tokenRows(dir).slice(-2).map((r) => r[2]), ['null', 'null'], 'NaN persists as null, as JSON.stringify wrote');
  // Unchanged refusals: non-JSON values everywhere; the strict number rule for every OTHER field.
  assert.throws(() => L2.repo.pushTokens.register(token(undefined)), /token \(undefined\) cannot be stored as JSON/); assert.throws(() => L2.repo.pushTokens.register(token(10n)), /cannot be stored as JSON/); assert.throws(() => L2.repo.pushTokens.register(token([Symbol('x')])), /token\[0\] \(symbol\) cannot be stored as JSON/);
  assert.throws(() => L2.repo.pushTokens.register(token('fine', { note: INF })), /note is a non-finite number/, 'an unknown field of a registration keeps the strict rule');
  assert.throws(() => L2.repo.outbox.append(mail({ id: 'mail-inf', note: INF })), /note is a non-finite number/); assert.throws(() => L2.repo.pushLog.append(push({ id: 'push-inf', note: INF })), /note is a non-finite number/);
  assert.equal(L2.repo.pending(), 0, 'nothing queued by a refusal');
  // The snapshot (backup) and the rollback blob carry null, as the accepted build's JSON did.
  const all = L2.repo.pushTokens.exportRows(); assert.equal(all.length, 10, 'two NaN rows: NaN never collapses');
  const tool = openStore(dir); const snap = tool.load(); assert.equal(JSON.stringify(snap.db.pushTokens.map((t) => t.token)), JSON.stringify(all.map((t) => t.token))); tool.sqlite.close();
  assert.ok(rollbackMod); const out = tempDir('obp-f1-out'); rollbackMod.rollbackOutboxPushCopy(dbFile(dir), out, { now: NOW });
  assert.equal(JSON.stringify(JSON.parse(blobOf(out, 'pushTokens')).map((t) => t.token)), JSON.stringify(all.map((t) => t.token)), 'the blob the accepted build reads');
  L2.close(); rm(dir, out);
});

test('[review of 78c14b9] numeric overflow INSIDE an accepted array destination (raw JSON [1e400,"…"] or [[-1e400],"…"] through the coercing invite route: the elements parse to ±Infinity, the accepted build kept the live array until a restart and its JSON persistence wrote null / nested null in those positions): append accepts the live array, the mirror and every detached copy keep ±Infinity, the save boundary writes the accepted build\'s JSON (to_json with null in the overflow positions), a failed save keeps it pending and the retry lands it once, an aborted unit restores the live value, a restart reads the nulls as the old restart did, the snapshot (backup) and the rollback blob carry the old JSON and the re-upgrade keeps it; a bare non-finite destination (not writer-reachable) follows the same boundary (live value kept, persisted as the old JSON null); every other field keeps the strict rule', () => {
  const dir = tempDir('obp-f2b');
  const OVER = JSON.parse('[1e400,"synthetic-overflow@example.invalid"]'); const NEST = JSON.parse('[[-1e400],"synthetic-nested@example.invalid"]');
  assert.equal(OVER[0], Infinity); assert.equal(NEST[0][0], -Infinity);
  const OVER_JSON = '[null,"synthetic-overflow@example.invalid"]'; const NEST_JSON = '[[null],"synthetic-nested@example.invalid"]';
  assert.equal(JSON.stringify(OVER), OVER_JSON); assert.equal(JSON.stringify(NEST), NEST_JSON); // what the accepted build's save wrote
  // A file the accepted build wrote (its JSON): imports as before.
  s7bFile(dir, { outbox: [mail({ id: 'mail-old', to: JSON.parse(OVER_JSON) })] });
  const L = live(dir); L.save(); assert.deepEqual(L.repo.outbox.exportRows()[0].to, [null, 'synthetic-overflow@example.invalid'], 'the imported row reads the old JSON');
  // The live writer's array: accepted, kept live, detached.
  const held = L.repo.outbox.append(mail({ id: 'mail-over', to: OVER })); const held2 = L.repo.outbox.append(mail({ id: 'mail-nest', to: NEST }));
  assert.equal(held.to[0], Infinity, 'the held view shows the live value'); assert.equal(held2.to[0][0], -Infinity);
  const ex = L.repo.outbox.exportRows(); assert.deepEqual(ex[1].to, [Infinity, 'synthetic-overflow@example.invalid'], 'an export keeps the live value (the admin view serialises it to null, as the old array did)'); assert.deepEqual(ex[2].to, [[-Infinity], 'synthetic-nested@example.invalid']);
  assert.equal(JSON.stringify(ex[1].to), OVER_JSON); assert.equal(JSON.stringify(ex[2].to), NEST_JSON);
  ex[1].to[0] = 7; OVER[1] = 'mutated after append'; assert.deepEqual(L.repo.outbox.exportRows()[1].to, [Infinity, 'synthetic-overflow@example.invalid'], 'detached from the export and from the caller\'s input');
  assert.deepEqual(rowsOf(dir, 'outbox').map((r) => r.id), ['mail-old'], 'nothing durable before the save');
  // A failed save keeps the pending rows; the retry lands them once with the old JSON.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_f2b BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.equal(L.repo.pending(), 2); assert.equal(held.to[0], Infinity, 'memory is the intended state');
  L.store.sqlite.exec('DROP TRIGGER rv_f2b'); L.save();
  assert.deepEqual(rowsOf(dir, 'outbox').map((r) => [r.id, r.to_address, r.to_json]), [['mail-old', null, OVER_JSON], ['mail-over', null, OVER_JSON], ['mail-nest', null, NEST_JSON]], 'persisted as the accepted build\'s JSON: null in the overflow positions, the array structure kept');
  L.save(); assert.equal(rowsOf(dir, 'outbox').length, 3, 'no replay');
  // An aborted unit restores the live values, not the JSON.
  assert.throws(() => L.store.unitOfWork(() => { L.repo.outbox.append(mail({ id: 'mail-u', to: OVER })); L.repo.outbox.markDelivered('mail-over', false); throw new Error('abort'); }, { snapshot: L.snapshot }), /abort/);
  assert.equal(L.repo.outbox.byId('mail-u'), null); assert.equal(held.delivered, true); assert.equal(held.to[0], Infinity, 'the restored row keeps the live value'); assert.equal(L.repo.outbox.exportRows()[2].to[0][0], -Infinity);
  // The snapshot table reader (backup, the reviewer's script, the rollback) and the dispatcher round trip: the old JSON.
  assert.deepEqual(needModule().OUTBOX_TABLE.read(L.store.sqlite).map((m) => m.to), [[null, 'synthetic-overflow@example.invalid'], [null, 'synthetic-overflow@example.invalid'], [[null], 'synthetic-nested@example.invalid']]);
  // A bare non-finite destination (no writer produces one — the route's regular expressions refuse it — but the boundary is the same): live value kept, persisted as the old JSON `null`.
  const bare = L.repo.outbox.append(mail({ id: 'mail-bare', to: Infinity })); assert.equal(bare.to, Infinity); L.save();
  assert.deepEqual(rowsOf(dir, 'outbox').at(-1).to_json, null); assert.deepEqual(rowsOf(dir, 'outbox').at(-1).to_address, null, 'NULL/NULL: what JSON.stringify(Infinity) → null meant in the blob');
  // Every other field keeps the strict rule.
  assert.throws(() => L.repo.outbox.append(mail({ id: 'mail-x', note: Infinity })), /note is a non-finite number/); assert.throws(() => L.repo.outbox.append(mail({ id: 'mail-x', to: [() => 1] })), /to\[0\] \(function\) cannot be stored as JSON/); assert.throws(() => L.repo.pushLog.append(push({ id: 'push-x', note: Infinity })), /note is a non-finite number/);
  assert.equal(L.repo.outbox.byId('mail-x'), null); assert.equal(L.repo.pending(), 0);
  L.close();
  // Restart: the nulls, as the old restart read them; the live value is gone with the process.
  const L2 = live(dir); assert.deepEqual(L2.repo.outbox.exportRows().map((m) => m.to), [[null, 'synthetic-overflow@example.invalid'], [null, 'synthetic-overflow@example.invalid'], [[null], 'synthetic-nested@example.invalid'], null]); L2.close();
  const tool = openStore(dir); const snap = tool.load(); assert.equal(JSON.stringify(snap.db.outbox.map((m) => m.to)), JSON.stringify([[null, 'synthetic-overflow@example.invalid'], [null, 'synthetic-overflow@example.invalid'], [[null], 'synthetic-nested@example.invalid'], null])); tool.save(snap); tool.sqlite.close();
  assert.ok(rollbackMod); const out = tempDir('obp-f2b-out'); assert.equal(rollbackMod.rollbackOutboxPushCopy(dbFile(dir), out, { now: NOW }).counts.outbox, 4);
  assert.equal(JSON.stringify(JSON.parse(blobOf(out, 'outbox')).map((m) => m.to)), JSON.stringify([[null, 'synthetic-overflow@example.invalid'], [null, 'synthetic-overflow@example.invalid'], [[null], 'synthetic-nested@example.invalid'], null]), 'the blob the accepted build reads: its own JSON');
  { const o = openRaw(out); assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [MIGRATION]); assert.deepEqual(rowsOf(out, 'outbox').map((r) => r.to_json), [OVER_JSON, OVER_JSON, NEST_JSON, null]); o.close(); }
  rm(dir, out);
});

console.log(`\n${passed} outbox/push checks passed`);
