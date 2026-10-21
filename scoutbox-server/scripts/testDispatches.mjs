// S7b — delivery dispatch records and their attempts as tables
// (repositories/dispatches.mjs, migration 0010, repositories/dispatchesRollback.mjs):
// the migration from the legacy `dispatches` blob (the one 18-key literal every
// build since M13 wrote, nested attempts of the two shapes, extras, orphan
// references counted — never refused — absent / empty / malformed / duplicate
// collections, first installation, reruns, text-free refusals); the actual
// schema (the attempt-shape CHECK rejecting a NULL send outcome in SQL, the
// finite-fractional callback timestamps preserved exactly); the repository
// (insertion order, the first-match provider lookup with duplicates, an
// explicit null and a missing id, the two write modes with owned-transaction
// memory restore, joined units, real COMMIT failure, hook registration); the
// snapshot dispatcher (omitted / empty / malformed collections); the copy-only
// rollback tool. Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import {
  createDispatchesRepository, validateDispatchRows,
  DISPATCHES_MIGRATION, DISPATCHES_CUTOVER_META, DISPATCH_TABLES, DISPATCH_KEYS,
} from '../repositories/dispatches.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
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
/** A second, independent connection: what it reads is what is committed. */
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'rowid') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const idsOf = (dir) => rowsOf(dir, 'dispatches', 'seq').map((r) => r.id);
const attemptsOf = (dir) => rowsOf(dir, 'dispatch_attempts', 'dispatch_seq, seq').map((r) => [r.dispatch_seq, r.seq, r.kind, r.ok, r.error, r.note]);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const tableExists = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The export convention (S7a, kept for S7b): unknown own fields come FIRST, then the eighteen keys in the literal's order. A legacy row with extras elsewhere is byte-identical to this reordering. */
const extrasFirst = (d) => { const o = {}; for (const k of Object.keys(d)) if (!DISPATCH_KEYS.includes(k)) Object.defineProperty(o, k, { value: d[k], enumerable: true, writable: true, configurable: true }); for (const k of DISPATCH_KEYS) if (Object.hasOwn(d, k)) o[k] = d[k]; return o; };
const FRACTIONAL = 1700000000000.5; // what the signed callback route writes for a finite fractional `at` (design probe of dc4b559)
const ORG_USER = { kind: 'org_user', id: 'usr-1' };
/** A notification in the legacy blob shape (the 0009 import needs them so references resolve). */
const ntf = (id) => ({ id, ts: NOW - MIN, audience: ORG_USER, type: 'message', text: 'Synthetic.', refId: 'chan-1', read: false, repeatCount: 1, groupKey: 'message:chan-1', category: 'messages', deferredPush: false });
/** A dispatch the way every build since M13 wrote it: all 18 keys, null (never absent) when unset. */
const dsp = (over = {}) => ({ id: 'dsp-a', notificationId: 'ntf-1', audience: { kind: 'org_user', id: 'usr-1' }, channel: 'email', to: 'synthetic@example.test', provider: 'local-fake', status: 'accepted', skipReason: null, providerMessageId: 'fm_000000000000000a', attempts: [{ at: NOW - MIN, ok: true, error: null }], nextAt: NOW - MIN, actionDeadline: null, createdAt: NOW - 2 * MIN, deliveredAt: null, openedAt: null, actionedAt: null, failedAt: null, failReason: null, ...over });
const inApp = (id, notificationId) => dsp({ id, notificationId, channel: 'in_app', to: `org_user:usr-1`, provider: 'in_app', status: 'delivered', providerMessageId: null, attempts: [], deliveredAt: NOW - 2 * MIN });

/** A file at S7a (0001–0009 applied) carrying the dispatches blob the way the 0641b2c build wrote it. */
function s7aFile(dir, { dispatches, notifications = [ntf('ntf-1'), ntf('ntf-2')], rawBlobs } = {}) {
  const extra = { requests: [], ledger: [], notifications, outbox: [], opsEvents: [], deliveryCallbacksSeen: [] };
  if (dispatches !== undefined) extra.dispatches = dispatches;
  s3File(dir, { extra, rawBlobs });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < DISPATCHES_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = store.load()?.db ?? {};
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, warnings, dispatches: layer.dispatches, snapshot, save: () => store.save(snapshot()), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test): own transaction per mutation. */
const bare = (s, over = {}) => createDispatchesRepository({ sqlite: s, now: () => NOW, ...over });

// ============================================================= migration 0010
test('migration 0010 (legacy blob): every dispatch is imported with its 18 fields, its array position (the insertion order every reader depends on) and its attempts in order — a quiet re-check note row as kind quiet_recheck with ok NULL, send rows with ok 0/1 — a finite fractional deliveredAt/openedAt written by the callback route is stored exactly, an unknown own key (a "__proto__" key included) round-trips through extra_json, a dispatch whose notification no longer exists is imported and COUNTED (never refused, deleted or re-parented), the blob row is retired, and the cutover record carries counts only', () => {
  const dir = tempDir('dsp-mig');
  const legacy = [
    inApp('dsp-1', 'ntf-1'),
    dsp({ id: 'dsp-2', notificationId: 'ntf-1', status: 'opened', attempts: [{ at: NOW - 3 * MIN, note: 'quiet hours re-check' }, { at: NOW - 2 * MIN, ok: false, error: 'injected provider failure' }, { at: NOW - MIN, ok: true, error: null }], deliveredAt: FRACTIONAL, openedAt: FRACTIONAL }),
    dsp({ id: 'dsp-3', notificationId: 'ntf-gone', status: 'skipped', to: null, skipReason: 'no email on record', providerMessageId: null, attempts: [] }), // an orphan: ordinary deletion left it behind
    JSON.parse(JSON.stringify(dsp({ id: 'dsp-4', notificationId: 'ntf-2', status: 'failed', attempts: [{ at: NOW - MIN, ok: false, error: 'synthetic provider error that is deliberately longer than one hundred and twenty characters so that the untruncated storage of the sweep is proven here' }], failedAt: NOW - MIN, failReason: 'synthetic provider error that is deliberately longer than one hundred and twenty characters so that the untruncated storage of the sweep is proven here' })).replace('"failReason"', '"__proto__":{"legacyMarker":"keep-me"},"nested":{"a":[1,{"b":null}]},"failReason"')),
  ];
  s7aFile(dir, { dispatches: legacy });
  const s = openRaw(dir);
  assert.deepEqual(migrate(s).ran, [DISPATCHES_MIGRATION, '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure']); // S7c: 0011 follows on the same run
  assert.deepEqual(s.prepare('SELECT seq, id FROM dispatches ORDER BY seq').all().map((r) => [r.seq, r.id]), [[1, 'dsp-1'], [2, 'dsp-2'], [3, 'dsp-3'], [4, 'dsp-4']], 'the array position is the durable ordering key');
  assert.deepEqual(s.prepare('SELECT dispatch_seq, seq, kind, ok, error, note FROM dispatch_attempts ORDER BY dispatch_seq, seq').all().map((r) => [r.dispatch_seq, r.seq, r.kind, r.ok, r.error, r.note]), [
    [2, 0, 'quiet_recheck', null, null, 'quiet hours re-check'], [2, 1, 'send', 0, 'injected provider failure', null], [2, 2, 'send', 1, null, null],
    [4, 0, 'send', 0, legacy[3].attempts[0].error, null],
  ], 'attempts keyed by (dispatch, position); a note row has ok NULL, a send row 0/1');
  const r2 = s.prepare('SELECT delivered_at, opened_at, typeof(delivered_at) AS t FROM dispatches WHERE id = ?').get('dsp-2');
  assert.equal(r2.delivered_at, FRACTIONAL); assert.equal(r2.opened_at, FRACTIONAL); assert.equal(r2.t, 'real', 'a finite fractional callback timestamp is stored as it was written, not rounded');
  const r4 = s.prepare('SELECT fail_reason, extra_json FROM dispatches WHERE id = ?').get('dsp-4');
  assert.equal(r4.fail_reason.length, legacy[3].failReason.length, 'failReason is stored untruncated (the sweep never truncates)');
  assert.equal(JSON.parse(r4.extra_json).__proto__.legacyMarker, 'keep-me'); assert.deepEqual(JSON.parse(r4.extra_json).nested, { a: [1, { b: null }] });
  assert.equal(blob(s, 'dispatches'), undefined, 'the blob row is retired');
  const record = JSON.parse(meta(s, DISPATCHES_CUTOVER_META));
  assert.deepEqual(record, { at: NOW, dispatches: { imported: 4, attempts: 4, withExtraFields: 1, orphanReferences: 1, byStatus: { delivered: 1, opened: 1, skipped: 1, failed: 1 } } });
  assert.doesNotMatch(JSON.stringify(record), /example\.test|synthetic provider/, 'the record carries no address and no provider text');
  // The export reproduces the legacy shape, position for position, attempts included, the own special key included.
  const repo = bare(s);
  const exported = repo.exportRows();
  assert.deepEqual(exported.map((d) => d.id), ['dsp-1', 'dsp-2', 'dsp-3', 'dsp-4']);
  for (let i = 0; i < 3; i++) assert.deepEqual(exported[i], plain(legacy[i]), `row ${i} byte-identical`);
  assert.ok(Object.hasOwn(exported[3], '__proto__') && exported[3].__proto__.legacyMarker === 'keep-me', 'the own __proto__ key is an own key of the export'); assert.equal(Object.getPrototypeOf(exported[3]), Object.prototype);
  assert.equal(JSON.stringify(exported[3]), JSON.stringify(extrasFirst(legacy[3])), 'byte-identical up to the export convention (unknown fields first, then the eighteen keys in order)');
  assert.deepEqual(exported[1].attempts, legacy[1].attempts, 'a note row comes back as {at, note} only; send rows as {at, ok, error}');
  assert.equal(repo.byId('dsp-3').notificationId, 'ntf-gone', 'the orphan keeps its reference as stored');
  s.close(); rm(dir);
});

test('migration 0010: a missing collection, an empty collection, an empty database and a first installation import nothing (and never infer anything from the seed or from row counts); a rerun is a no-op; 0009 must be recorded first; tables that exist without the record refuse the step', () => {
  const none = tempDir('dsp-mig-none'); s7aFile(none);
  let s = openRaw(none); migrate(s);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n, 0); assert.equal(JSON.parse(meta(s, DISPATCHES_CUTOVER_META)).dispatches.imported, 0);
  assert.deepEqual(migrate(s, { now: NOW + 1 }).ran, [], 'a rerun does nothing'); s.close();
  const empty = tempDir('dsp-mig-empty'); s7aFile(empty, { dispatches: [] });
  s = openRaw(empty); migrate(s); assert.equal(blob(s, 'dispatches'), undefined, 'an empty blob is retired too'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM dispatches').get().n, 0); s.close();
  const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW }).ran.includes(DISPATCHES_MIGRATION)); for (const t of DISPATCH_TABLES) assert.ok(tableExists(mem, t), t); mem.close();
  const early = tempDir('dsp-mig-early'); s3File(early);
  s = openRaw(early);
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < '0009' || m.id === DISPATCHES_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }), /0010_dispatches failed: 0010_dispatches: 0009_notifications must be recorded first/);
  assert.equal(tableExists(s, 'dispatches'), false); s.close();
  const odd = tempDir('dsp-mig-odd'); s7aFile(odd);
  s = openRaw(odd); s.exec('CREATE TABLE dispatch_attempts (x INTEGER) STRICT');
  assert.throws(() => migrate(s), /dispatch_attempts already exist without the migration record; refusing to guess/); s.close();
  rm(none, empty, early, odd);
});

test('migration 0010 refusals: a dispatch that is not an object, without an id, with a duplicate id, a missing key of the literal, an unknown audience field, a non-string notificationId / channel / provider / status, a non-integer nextAt or createdAt, a non-finite or non-numeric deliveredAt, a non-integer actionedAt, a non-string failReason, attempts that are not an array, an attempt with both note and ok, with neither, with an unknown key, a non-integer at, a non-boolean ok; a blob that is not JSON or not an array — each aborts the whole step with DISPATCHES_IMPORT_BLOCKED (entry index and reason, never an address or a provider text), creates nothing, keeps the blob byte for byte and saveSeq unchanged, and the next run refuses the same way', () => {
  const SECRET = 'SECRET-ADDRESS-ZQX9@example.test';
  const cases = [
    ['not an object', [null], /entry #0: not an object/],
    ['no id', [dsp({ id: '', to: SECRET })], /entry #0: id must be a non-empty string/],
    ['a duplicate id', [dsp({ id: 'dsp-dup', to: SECRET }), dsp({ id: 'dsp-dup' })], /entry #1: duplicates the id of an earlier entry/],
    ['a missing key of the literal', [(() => { const d = dsp({ to: SECRET }); delete d.failReason; return d; })()], /entry #0: failReason is absent \(every build wrote all 18 keys; nothing is normalised\)/],
    ['an unknown audience field', [dsp({ audience: { kind: 'org_user', id: 'usr-1', name: SECRET } })], /audience carries unknown field\(s\) name/],
    ['a non-string notificationId', [dsp({ notificationId: 7, to: SECRET })], /notificationId must be a non-empty string/],
    ['a non-string channel', [dsp({ channel: null, to: SECRET })], /channel must be a non-empty string/],
    ['a non-string status', [dsp({ status: 2, to: SECRET })], /status must be a non-empty string/],
    ['a fractional nextAt', [dsp({ nextAt: 1.5, to: SECRET })], /nextAt must be an integer timestamp/],
    ['a string createdAt', [dsp({ createdAt: '2026', to: SECRET })], /createdAt must be an integer timestamp/],
    ['a non-numeric deliveredAt', [dsp({ deliveredAt: '1700000000000.5', to: SECRET })], /deliveredAt must be a finite number \(integer or fractional\) or null/],
    ['a fractional actionedAt', [dsp({ actionedAt: 1.5, to: SECRET })], /actionedAt must be an integer timestamp or null/],
    ['a non-string failReason', [dsp({ failReason: 42, to: SECRET })], /failReason must be a string or null/],
    ['attempts not an array', [dsp({ attempts: {}, to: SECRET })], /attempts must be an array/],
    ['an attempt with both note and ok', [dsp({ attempts: [{ at: NOW, ok: true, error: null, note: 'x' }], to: SECRET })], /attempts\[0\] carries both note and ok/],
    ['an attempt with neither', [dsp({ attempts: [{ at: NOW }], to: SECRET })], /attempts\[0\] is neither a send row \{at, ok, error\} nor a quiet re-check row \{at, note\}/],
    ['an attempt with an unknown key', [dsp({ attempts: [{ at: NOW, ok: true, error: null, provider: SECRET }], to: SECRET })], /attempts\[0\] carries unknown field\(s\) provider/],
    ['a non-integer attempt clock', [dsp({ attempts: [{ at: 1.5, ok: true, error: null }], to: SECRET })], /attempts\[0\]\.at must be an integer timestamp/],
    ['a non-boolean ok', [dsp({ attempts: [{ at: NOW, ok: 1, error: null }], to: SECRET })], /attempts\[0\]\.ok must be a boolean/],
    ['a non-array blob', { id: 'x' }, /the dispatches blob must be an array/],
  ];
  for (const [label, dispatches, re] of cases) {
    const dir = tempDir('dsp-refuse'); s7aFile(dir, { dispatches });
    const s = openRaw(dir);
    const before = s.prepare('SELECT value FROM collections WHERE name = ?').get('dispatches')?.value; const seq0 = meta(s, 'saveSeq');
    let err = null; try { migrate(s); } catch (e) { err = e; }
    assert.ok(err, `${label}: must refuse`); assert.match(err.message, /DISPATCHES_IMPORT_BLOCKED/, label); assert.match(err.message, re, `${label}: ${err.message}`);
    assert.equal(err.message.includes(SECRET), false, `${label}: the refusal never carries an address`); assert.equal(err.message.includes('example.test'), false, label);
    assert.equal(s.isTransaction, false); for (const t of DISPATCH_TABLES) assert.equal(tableExists(s, t), false, `${label}: ${t} not created`);
    assert.equal(applied(s).includes(DISPATCHES_MIGRATION), false);
    assert.equal(s.prepare('SELECT value FROM collections WHERE name = ?').get('dispatches')?.value, before, `${label}: the blob is kept as it was`); assert.equal(meta(s, 'saveSeq'), seq0, `${label}: saveSeq unchanged`);
    assert.throws(() => migrate(s), /DISPATCHES_IMPORT_BLOCKED/, `${label}: the next run refuses the same way`);
    s.close(); rm(dir);
  }
  const notJson = tempDir('dsp-refuse-json'); s7aFile(notJson, { rawBlobs: { dispatches: '{not json' } });
  { const s = openRaw(notJson); assert.throws(() => migrate(s), /the dispatches blob is not valid JSON/); s.close(); }
  rm(notJson);
  assert.throws(() => validateDispatchRows([dsp({ openedAt: Number.POSITIVE_INFINITY })]), /openedAt must be a finite number/);
  assert.deepEqual(validateDispatchRows([dsp(), inApp('dsp-b', 'ntf-1')]).byStatus, { accepted: 1, delivered: 1 });
});

// ============================================================= the actual schema, in SQL
test('the actual schema (direct SQL, review of dc4b559 finding 1 and 2): dispatch_attempts refuses a send row with ok NULL (the CHECK is total: ok IS NOT NULL), a send row with a note, a note row with ok or error, an unknown kind; accepts both send outcomes and a quiet re-check note; the attempt key is (dispatch, position) with no minted id; the dispatch timestamp columns written by the callback route (delivered_at, opened_at) are REAL — the writer\'s JavaScript double, stored exactly whether integer-valued or fractional — and refuse text; the writer-only clocks are INTEGER columns that refuse a fraction', () => {
  const s = new DatabaseSync(':memory:'); s.exec('PRAGMA foreign_keys = ON;');
  migrate(s);
  s.prepare("INSERT INTO dispatches (id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, next_at, created_at) VALUES ('dsp-x', 'ntf-1', 'org_user', 'usr-1', 'email', NULL, 'local-fake', 'queued', 1, 1)").run();
  const seq = s.prepare("SELECT seq FROM dispatches WHERE id = 'dsp-x'").get().seq;
  const add = s.prepare('INSERT INTO dispatch_attempts (dispatch_seq, seq, kind, attempted_at, ok, error, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  assert.throws(() => add.run(seq, 0, 'send', 1, null, null, null), /CHECK constraint failed/, 'a send row with ok NULL is refused in SQL, not only in JavaScript');
  assert.throws(() => add.run(seq, 0, 'send', 1, 1, null, 'quiet hours re-check'), /CHECK constraint failed/, 'a send row never carries a note');
  assert.throws(() => add.run(seq, 0, 'quiet_recheck', 1, 0, null, 'quiet hours re-check'), /CHECK constraint failed/, 'a note row never carries ok');
  assert.throws(() => add.run(seq, 0, 'quiet_recheck', 1, null, 'x', 'quiet hours re-check'), /CHECK constraint failed/, 'a note row never carries an error');
  assert.throws(() => add.run(seq, 0, 'quiet_recheck', 1, null, null, null), /CHECK constraint failed/, 'a note row needs its note');
  assert.throws(() => add.run(seq, 0, 'other', 1, 1, null, null), /CHECK constraint failed/, 'an unknown kind is refused');
  add.run(seq, 0, 'quiet_recheck', 1, null, null, 'quiet hours re-check'); add.run(seq, 1, 'send', 2, 0, 'synthetic failure', null); add.run(seq, 2, 'send', 3, 1, null, null);
  assert.throws(() => add.run(seq, 2, 'send', 4, 1, null, null), /UNIQUE constraint failed|PRIMARY KEY/, 'one row per (dispatch, position)');
  assert.deepEqual(s.prepare('PRAGMA table_info(dispatch_attempts)').all().filter((c) => c.pk > 0).map((c) => c.name), ['dispatch_seq', 'seq'], 'the key is the pair; no minted id column');
  assert.throws(() => add.run(999, 0, 'send', 1, 1, null, null), /FOREIGN KEY constraint failed/, 'an attempt belongs to an existing dispatch');
  const set = s.prepare('UPDATE dispatches SET delivered_at = ?, opened_at = ? WHERE id = ?');
  set.run(1700000000000, FRACTIONAL, 'dsp-x');
  const r = s.prepare("SELECT delivered_at, opened_at, typeof(delivered_at) AS td, typeof(opened_at) AS tp FROM dispatches WHERE id = 'dsp-x'").get();
  assert.deepEqual([r.delivered_at, r.td, r.opened_at, r.tp], [1700000000000, 'real', FRACTIONAL, 'real'], 'both are the double the writer produced, exact (node:sqlite binds every JavaScript number as a double; the REAL column states what is stored)');
  assert.throws(() => set.run('soon', null, 'dsp-x'), /cannot store TEXT value in REAL column/, 'text is refused in a callback timestamp column (STRICT)');
  assert.throws(() => s.prepare('UPDATE dispatches SET next_at = ? WHERE id = ?').run(1.5, 'dsp-x'), /cannot store REAL value in INTEGER column|constraint failed/, 'a writer-only clock is an INTEGER column');
  s.close();
});

// ============================================================= the repository: immediate mode (tools, tests)
test('repository (immediate mode): create / recordAttempt / patch validate like the import (unknown patch keys, non-numeric callback timestamps and malformed attempts refused), insertion order is seq order, byProviderMessageId is the FIRST row in insertion order whose id strictly equals the value — duplicates legal, an explicit null matches the first null row, an omitted/undefined value matches nothing — counts by status and the backlog count, a finite fractional timestamp is durable exactly (second connection); an owned transaction that fails at a statement or at COMMIT restores the mirror in place (rows, attempts arrays, held views) and the retry lands; a caller-owned raw transaction keeps the explicit reload() contract', () => {
  const dir = tempDir('dsp-imm'); s7aFile(dir, { dispatches: [] });
  const s = openRaw(dir); migrate(s);
  const repo = bare(s);
  const a = repo.create(dsp({ id: 'dsp-1', providerMessageId: 'fm_dup', attempts: [] }));
  const b = repo.create(dsp({ id: 'dsp-2', providerMessageId: null, status: 'queued', attempts: [] }));
  const c = repo.create(dsp({ id: 'dsp-3', providerMessageId: 'fm_dup', status: 'retrying', attempts: [] }));
  const d = repo.create(inApp('dsp-4', 'ntf-2'));
  assert.deepEqual(idsOf(dir), ['dsp-1', 'dsp-2', 'dsp-3', 'dsp-4']); assert.deepEqual(repo.list().map((x) => x.id), ['dsp-1', 'dsp-2', 'dsp-3', 'dsp-4']);
  assert.equal(repo.byProviderMessageId('fm_dup').id, 'dsp-1', 'duplicates are legal; the first in insertion order matches'); assert.equal(repo.byProviderMessageId(null).id, 'dsp-2', 'an explicit null matches the first null row'); assert.equal(repo.byProviderMessageId(undefined), null, 'an omitted id matches nothing'); assert.equal(repo.byProviderMessageId('fm_none'), null);
  assert.deepEqual(repo.countsByStatus(), { accepted: 1, queued: 1, retrying: 1, delivered: 1 }); assert.equal(repo.backlogCount(), 2);
  assert.deepEqual(repo.forNotification('ntf-1').map((x) => x.id), ['dsp-1', 'dsp-2', 'dsp-3']); assert.deepEqual([...repo.notificationIdsWithRows()].sort(), ['ntf-1', 'ntf-2']);
  // Attempts: ordered, the two shapes, the counter skips the note.
  repo.recordAttempt('dsp-2', { at: NOW, note: 'quiet hours re-check' }); repo.recordAttempt('dsp-2', { at: NOW + 1, ok: false, error: 'synthetic' }); repo.recordAttempt('dsp-2', { at: NOW + 2, ok: true, error: null });
  assert.deepEqual(plain(b.attempts), [{ at: NOW, note: 'quiet hours re-check' }, { at: NOW + 1, ok: false, error: 'synthetic' }, { at: NOW + 2, ok: true, error: null }], 'the held view shows the attempts in order');
  assert.deepEqual(attemptsOf(dir), [[2, 0, 'quiet_recheck', null, null, 'quiet hours re-check'], [2, 1, 'send', 0, 'synthetic', null], [2, 2, 'send', 1, null, null]]);
  assert.throws(() => repo.recordAttempt('dsp-2', { at: NOW, ok: true, error: null, note: 'x' }), /carries both note and ok/); assert.throws(() => repo.recordAttempt('dsp-2', { at: 1.5, ok: true, error: null }), /at must be an integer/); assert.throws(() => repo.recordAttempt('dsp-9', { at: NOW, ok: true, error: null }), /no dispatch dsp-9/);
  // Patches: the callback and sweep fields, validated per column.
  repo.patch('dsp-1', { deliveredAt: FRACTIONAL, status: 'delivered' });
  assert.equal(a.deliveredAt, FRACTIONAL); { const r = second(dir); try { assert.deepEqual({ ...r.prepare("SELECT delivered_at AS v, typeof(delivered_at) AS t FROM dispatches WHERE id = 'dsp-1'").get() }, { v: FRACTIONAL, t: 'real' }, 'durable exactly, second connection'); } finally { r.close(); } }
  repo.patch('dsp-1', { openedAt: 1700000000000 }); assert.equal(rowsOf(dir, 'dispatches', 'seq')[0].opened_at, 1700000000000);
  assert.throws(() => repo.patch('dsp-1', { deliveredAt: '1' }), /deliveredAt must be a number/); assert.throws(() => repo.patch('dsp-1', { openedAt: {} }), /openedAt must be a number/); // a non-finite NUMBER is the legacy in-memory state the live route produces (review of 26d492b, finding 3; its test below)
  assert.throws(() => repo.patch('dsp-1', { nextAt: 1.5 }), /nextAt must be an integer/); assert.throws(() => repo.patch('dsp-1', { failReason: 7 }), /failReason must be a string or null/); assert.throws(() => repo.patch('dsp-1', { status: '' }), /status must be a non-empty string/);
  assert.throws(() => repo.patch('dsp-1', { audience: { kind: 'x', id: 'y' } }), /patch carries field\(s\) a dispatch does not change: audience/); assert.throws(() => repo.patch('dsp-1', { id: 'other' }), /patch carries field\(s\)/);
  repo.patch('dsp-1', {}); // a no-op patch
  const long = 'x'.repeat(300); repo.patch('dsp-3', { status: 'failed', failedAt: NOW, failReason: long }); assert.equal(rowsOf(dir, 'dispatches', 'seq')[2].fail_reason.length, 300, 'untruncated at storage');
  assert.throws(() => repo.create(dsp({ id: 'dsp-1' })), /already exists/); assert.throws(() => repo.create(dsp({ id: 'dsp-5', audience: { kind: 'player', id: 'p', extra: 1 } })), /audience carries unknown field/);
  // Owned-transaction failure: statement failure and a real COMMIT failure both restore memory in place.
  const snapshot = () => ({ rows: plain(repo.exportRows()), counts: repo.countsByStatus(), held: [plain(a), plain(b), plain(c), plain(d)], attempts: attemptsOf(dir), ids: idsOf(dir) });
  const before = snapshot();
  s.exec("CREATE TEMP TRIGGER rv_ins BEFORE INSERT ON dispatches BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  assert.throws(() => repo.create(dsp({ id: 'dsp-5', attempts: [] })), /synthetic insert failure/); assert.deepEqual(snapshot(), before, 'nothing in memory after a failed insert'); assert.equal(repo.byId('dsp-5'), null); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_ins');
  s.exec("CREATE TEMP TRIGGER rv_att BEFORE INSERT ON dispatch_attempts BEGIN SELECT RAISE(ABORT, 'synthetic attempt failure'); END");
  assert.throws(() => repo.recordAttempt('dsp-2', { at: NOW + 3, ok: true, error: null }), /synthetic attempt failure/); assert.deepEqual(snapshot(), before, 'the attempts array the caller holds is restored in place'); assert.equal(b.attempts.length, 3);
  s.exec('DROP TRIGGER rv_att');
  s.exec("CREATE TEMP TRIGGER rv_upd BEFORE UPDATE ON dispatches BEGIN SELECT RAISE(ABORT, 'synthetic update failure'); END");
  assert.throws(() => repo.patch('dsp-2', { status: 'accepted', providerMessageId: 'fm_new' }), /synthetic update failure/); assert.deepEqual(snapshot(), before); assert.equal(b.status, 'queued');
  s.exec('DROP TRIGGER rv_upd');
  s.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON dispatches BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => repo.create(dsp({ id: 'dsp-5', attempts: [] })), /FOREIGN KEY constraint failed/); assert.deepEqual(snapshot(), before, 'nothing in memory after a failed COMMIT'); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_commit');
  assert.equal(repo.create(dsp({ id: 'dsp-5', attempts: [] })).id, 'dsp-5', 'the same id is accepted on the retry'); assert.equal(repo.count(), 5);
  // A caller-owned raw transaction: the mirror cannot see the caller's ROLLBACK; reload() is the contract.
  s.exec('BEGIN'); repo.create(dsp({ id: 'dsp-raw', attempts: [] })); s.exec('ROLLBACK');
  assert.ok(repo.byId('dsp-raw')); repo.reload(); assert.equal(repo.byId('dsp-raw'), null); assert.equal(repo.count(), 5);
  s.close(); rm(dir);
});

// ============================================================= the staged mode (the server's): a write lands with the blobs it belongs to
test('staged mode (the server): a create, an attempt and a patch are visible in memory at once but NOT durable ahead of the snapshot save that carries the blob edits made alongside them (the outbox row, the fail-inject counter, an ops event) — the next save lands them together in ONE revision (independent connection); a failed save (statement or real COMMIT failure) keeps them pending and the retry lands them once; inside a unit of work the writes and the blob edit commit together, a thrown failure, a statement failure at the unit\'s flush, a real COMMIT failure and a CAUGHT participant failure (a refused argument) each roll everything back and restore the rows, the attempts arrays and the counters in memory, writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('dsp-staged'); s7aFile(dir, { dispatches: [] });
  const L = live(dir); L.save();
  const seq0 = seqOf(dir);
  L.layer.outbox.append({ id: 'mail-1', at: NOW, channel: 'email', to: 'synthetic@example.test', text: 'x', providerMessageId: 'fm_1', provider: 'local-fake' }); // S7c: the outbox row goes through its repository (staged into the same save)
  const a = L.dispatches.create(dsp({ id: 'dsp-1', status: 'queued', providerMessageId: null, attempts: [] }));
  L.dispatches.recordAttempt('dsp-1', { at: NOW, ok: true, error: null }); L.dispatches.patch('dsp-1', { status: 'accepted', providerMessageId: 'fm_1' });
  assert.equal(a.status, 'accepted', 'visible at once'); assert.equal(L.dispatches.pending(), 3); assert.deepEqual(idsOf(dir), [], 'nothing durable before the save'); assert.equal(rowsOf(dir, 'outbox', 'seq').length, 0);
  // A failed save (statement): pending stays.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON dispatches BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(idsOf(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.dispatches.pending(), 3); assert.equal(rowsOf(dir, 'outbox', 'seq').length, 0, 'the outbox row did not land without the dispatch rows');
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  // A failed save (real COMMIT): pending stays.
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON dispatches BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(idsOf(dir), []); assert.equal(seqOf(dir), seq0); assert.equal(L.dispatches.pending(), 3);
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  // The retry: one revision, the row, its attempt, its patch and the outbox row together.
  L.save();
  assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(idsOf(dir), ['dsp-1']); assert.deepEqual(rowsOf(dir, 'dispatches', 'seq').map((r) => [r.status, r.provider_message_id]), [['accepted', 'fm_1']]); assert.deepEqual(attemptsOf(dir), [[1, 0, 'send', 1, null, null]]); assert.equal(rowsOf(dir, 'outbox', 'seq').length, 1, 'the outbox row landed in the same save'); assert.equal(L.dispatches.pending(), 0);
  L.save(); assert.equal(seqOf(dir), seq0 + 2); assert.deepEqual(attemptsOf(dir).length, 1, 'a later save does not replay');
  // A unit of work: together or not at all; a caught participant failure still poisons the unit; pre-unit writes survive.
  const pre = L.dispatches.create(inApp('dsp-pre', 'ntf-2')); assert.equal(L.dispatches.pending(), 1);
  const before = { rows: plain(L.dispatches.exportRows()), held: plain(a), attempts: a.attempts.length, counts: L.dispatches.countsByStatus(), requests: JSON.stringify(L.db.requests), durable: attemptsOf(dir), ids: idsOf(dir), seq: seqOf(dir) };
  const unchanged = (label) => { assert.deepEqual({ rows: plain(L.dispatches.exportRows()), held: plain(a), attempts: a.attempts.length, counts: L.dispatches.countsByStatus(), requests: JSON.stringify(L.db.requests), durable: attemptsOf(dir), ids: idsOf(dir), seq: seqOf(dir) }, before, label); assert.equal(L.dispatches.pending(), 1, `${label}: the pre-unit write is still pending`); assert.ok(L.dispatches.byId('dsp-pre')); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false); };
  assert.throws(() => L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-u' }); L.dispatches.recordAttempt('dsp-1', { at: NOW + 1, ok: false, error: 'x' }); L.dispatches.patch('dsp-1', { status: 'retrying' }); L.dispatches.create(dsp({ id: 'dsp-u', attempts: [] })); throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), /synthetic unit failure/);
  unchanged('thrown');
  // A CAUGHT participant failure (a refused argument inside the joined boundary) still poisons the unit.
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-u2' }); L.dispatches.patch('dsp-1', { status: 'retrying' }); try { L.dispatches.recordAttempt('dsp-1', { at: 1.5, ok: true, error: null }); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /at must be an integer timestamp/); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back');
  unchanged('caught');
  // A queued statement that fails when the unit's commit flushes it (staged mode runs the SQL at the commit, not at the call): the unit rolls back.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE INSERT ON dispatch_attempts BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  assert.throws(() => L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-u2b' }); L.dispatches.patch('dsp-1', { status: 'retrying' }); L.dispatches.recordAttempt('dsp-1', { at: NOW + 1, ok: false, error: 'x' }); }, { snapshot: L.snapshot }), /synthetic joined failure/);
  unchanged('statement failure at the unit\'s flush');
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_commit2 AFTER INSERT ON dispatch_attempts BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-u3' }); L.dispatches.recordAttempt('dsp-1', { at: NOW + 1, ok: false, error: 'x' }); }, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/);
  unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER rv_commit2');
  L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-ok' }); L.dispatches.recordAttempt('dsp-1', { at: NOW + 1, ok: false, error: 'x' }); L.dispatches.patch('dsp-1', { status: 'retrying', nextAt: NOW + 5 }); }, { snapshot: L.snapshot });
  assert.equal(seqOf(dir), before.seq + 1); assert.deepEqual(idsOf(dir), ['dsp-1', 'dsp-pre'], 'the pre-unit write landed with the unit'); assert.equal(attemptsOf(dir).length, 2); assert.ok(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-ok')); assert.equal(L.dispatches.pending(), 0); assert.ok(pre.id);
  // Hook registration is a precondition inside the joined boundary.
  const bareUnit = createDispatchesRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit });
  const stagedUnit = createDispatchesRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true });
  for (const [label, work] of [['immediate', () => bareUnit.create(dsp({ id: 'dsp-h', attempts: [] }))], ['staged', () => stagedUnit.create(dsp({ id: 'dsp-h', attempts: [] }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-h' }); try { work(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(JSON.parse(blobOf(dir, 'requests')).some((r) => r.id === 'req-h'), false);
  }
  assert.throws(() => stagedUnit.create(dsp({ id: 'dsp-h', attempts: [] })), /save hook/, 'standalone staged write without the hook');
  L.close(); rm(dir);
});

// ============================================================= the snapshot dispatcher (backups, restores, the persistence suites)
test('snapshot dispatcher: a tool that loads and saves the whole file round-trips every dispatch and attempt byte for byte (the own special key included); a snapshot that OMITS the collection leaves the tables alone; an explicit EMPTY array clears them; a malformed collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid entry refuses the whole save with a text-free diagnostic', () => {
  const dir = tempDir('dsp-snap');
  const special = JSON.parse('{"id":"dsp-proto","notificationId":"ntf-1","audience":{"kind":"org_user","id":"usr-1"},"channel":"email","to":"synthetic@example.test","provider":"local-fake","status":"accepted","skipReason":null,"providerMessageId":"fm_p","attempts":[{"at":1,"note":"quiet hours re-check"},{"at":2,"ok":true,"error":null}],"nextAt":1,"actionDeadline":null,"createdAt":1,"deliveredAt":1700000000000.5,"openedAt":null,"actionedAt":null,"failedAt":null,"failReason":null,"__proto__":{"legacyMarker":"keep-me"}}');
  s7aFile(dir, { dispatches: [inApp('dsp-1', 'ntf-1'), special] });
  { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load();
  assert.equal(JSON.stringify(snap.db.dispatches[1]), JSON.stringify(extrasFirst(special)), 'read back byte-identical up to the export convention'); assert.ok(Object.hasOwn(snap.db.dispatches[1], '__proto__'));
  const seq0 = tool.revision(); tool.save(snap);
  assert.equal(tool.revision(), seq0 + 1); assert.equal(JSON.stringify(tool.load().db.dispatches), JSON.stringify([inApp('dsp-1', 'ntf-1'), extrasFirst(special)]), 'round-tripped through replace'); assert.equal(attemptsOf(dir).length, 2);
  // Omitted: left alone.
  const { dispatches: _omit, ...without } = snap.db; tool.save({ ...snap, db: without });
  assert.deepEqual(idsOf(dir), ['dsp-1', 'dsp-proto'], 'an omitted collection leaves the tables alone'); assert.equal(blobOf(dir, 'dispatches'), null, 'and never recreates a shadow blob');
  // Malformed: the whole save rolls back.
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, requests: [{ id: 'req-x' }], dispatches: { id: 'x' } } }), /dispatches: the snapshot collection must be an array/);
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (requests included)');
  const SECRET = 'SECRET-ADDRESS-77@example.test';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, dispatches: [dsp({ id: 'dsp-bad', to: SECRET, attempts: [{ at: 1 }] })] } }), (e) => /DISPATCHES_IMPORT_BLOCKED/.test(e.message) && /attempts\[0\] is neither/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  // Empty: cleared.
  tool.save({ ...snap, db: { ...snap.db, dispatches: [] } }); assert.deepEqual(idsOf(dir), []); assert.equal(attemptsOf(dir).length, 0); assert.equal(blobOf(dir, 'dispatches'), null);
  tool.sqlite.close(); rm(dir);
});

// ============================================================= the copy-only rollback to the accepted 0641b2c build
test('rollback (copy-only): every dispatch and every attempt is written back into the dispatches blob in insertion order and in the shapes that build wrote (a note row as {at, note}, a send row as {at, ok, error}, a fractional callback clock, an orphan reference, the own special key), the two tables are dropped, the 0010 record and its meta key removed, saveSeq advanced, every other table byte-identical, the source untouched; the real migration re-upgrades the copy to the same rows; the S7a tool refuses a 0010 file (LATER_SCHEMA); refusals leave no output: a later schema step (exit 4), a file that never applied 0010 (exit 5), a non-empty output directory (exit 1), a recorded 0010 whose tables are missing (exit 10), an injected COMMIT failure inside the tool', () => {
  const src = tempDir('dsp-rb-src');
  const special = JSON.parse('{"id":"dsp-proto","notificationId":"ntf-gone","audience":{"kind":"player","id":"pl-x"},"channel":"email","to":null,"provider":"local-fake","status":"skipped","skipReason":"no email on record","providerMessageId":null,"attempts":[],"nextAt":1,"actionDeadline":null,"createdAt":1,"deliveredAt":null,"openedAt":null,"actionedAt":null,"failedAt":null,"failReason":null,"__proto__":{"legacyMarker":"keep-me"}}');
  const legacy = [inApp('dsp-1', 'ntf-1'), dsp({ id: 'dsp-2', attempts: [{ at: 1, note: 'quiet hours re-check' }, { at: 2, ok: false, error: 'e' }, { at: 3, ok: true, error: null }], deliveredAt: FRACTIONAL, openedAt: FRACTIONAL, status: 'opened' }), special];
  s7aFile(src, { dispatches: legacy });
  { const s = openRaw(src); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id <= DISPATCHES_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }); const repo = bare(s); repo.create(dsp({ id: 'dsp-after', attempts: [{ at: 4, ok: true, error: null }] })); s.close(); } // S7c: this proof is the S7b tool on an S7b-level file (a file carrying 0011 is refused by it — LATER_SCHEMA, proven in testOutboxPush.mjs)
  const srcBytes = fs.readFileSync(dbFile(src)); const srcDump = (() => { const s = openRaw(src); try { return dump(s); } finally { s.close(); } })();
  const out = tempDir('dsp-rb-out');
  const result = rollbackDispatchesCopy(dbFile(src), out, { now: NOW });
  assert.deepEqual(result.counts, { dispatches: 4, attempts: 4 }); assert.equal(result.recordRemoved, true);
  assert.ok(fs.readFileSync(dbFile(src)).equals(srcBytes), 'the source file is untouched'); { const s = openRaw(src); try { assert.deepEqual(dump(s), srcDump); } finally { s.close(); } }
  const o = openRaw(out);
  const back = JSON.parse(o.prepare("SELECT value FROM collections WHERE name = 'dispatches'").get().value);
  assert.equal(JSON.stringify(back.slice(0, 3)), JSON.stringify(legacy.map(extrasFirst)), 'byte-identical to what that build wrote (unknown fields first), the special key and the fractional clock included'); assert.equal(back[3].id, 'dsp-after'); assert.deepEqual(back[3].attempts, [{ at: 4, ok: true, error: null }], 'nothing written after the cutover is lost');
  assert.ok(Object.hasOwn(back[2], '__proto__') && back[2].__proto__.legacyMarker === 'keep-me'); assert.equal(back[1].deliveredAt, FRACTIONAL);
  for (const t of DISPATCH_TABLES) assert.equal(tableExists(o, t), false);
  assert.equal(applied(o).includes(DISPATCHES_MIGRATION), false); assert.equal(meta(o, DISPATCHES_CUTOVER_META), undefined); assert.equal(Number(meta(o, 'saveSeq')), Number(meta(openRaw(src), 'saveSeq')) + 1);
  assert.equal(o.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); assert.ok(tableExists(o, 'notifications'), 'the S7a tables are untouched');
  // Re-upgrade: the real migration brings the copy back to the same rows.
  assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [DISPATCHES_MIGRATION, '0011_outbox_push', '0012_channels', '0013_safety_audit', '0014_player_erasure']); // S7c: the rollback copy predates 0011 too
  assert.equal(JSON.stringify(bare(o).exportRows()), JSON.stringify(back), 'the same rows after the re-upgrade'); assert.equal(JSON.parse(meta(o, DISPATCHES_CUTOVER_META)).dispatches.orphanReferences, 1);
  o.close();
  // The S7a tool refuses a 0010 file: no partial downgrade.
  const s7aOut = tempDir('dsp-rb-s7a'); assert.throws(() => rollbackNotificationsCopy(dbFile(src), s7aOut), (e) => e.code === 'LATER_SCHEMA' && /0010_dispatches/.test(e.message)); assert.deepEqual(fs.readdirSync(s7aOut), []);
  // Refusals and the CLI.
  const script = path.join(HERE, 'dispatchesRollback.mjs');
  const run = (args) => { try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  const later = tempDir('dsp-rb-later'); fs.copyFileSync(dbFile(src), dbFile(later)); { const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0011_future_step', 1)").run(); l.close(); }
  const o1 = tempDir('dsp-rb-o1'); assert.throws(() => rollbackDispatchesCopy(dbFile(later), o1), (e) => e.code === 'LATER_SCHEMA' && /0011_future_step/.test(e.message)); assert.deepEqual(fs.readdirSync(o1), []); assert.equal(run([later, tempDir('dsp-rb-o1b')]).code, 4);
  const notCut = tempDir('dsp-rb-notcut'); s7aFile(notCut, { dispatches: [] }); const o2 = tempDir('dsp-rb-o2'); assert.throws(() => rollbackDispatchesCopy(dbFile(notCut), o2), (e) => e.code === 'NOT_CUT_OVER'); assert.deepEqual(fs.readdirSync(o2), []); assert.equal(run([notCut, tempDir('dsp-rb-o2b')]).code, 5);
  const o3 = tempDir('dsp-rb-o3'); fs.writeFileSync(path.join(o3, 'keep.txt'), 'x'); assert.throws(() => rollbackDispatchesCopy(dbFile(src), o3), (e) => e.code === 'OUTPUT_NOT_EMPTY'); assert.equal(run([src, o3]).code, 1); assert.deepEqual(fs.readdirSync(o3), ['keep.txt']);
  const odd = tempDir('dsp-rb-odd'); fs.copyFileSync(dbFile(src), dbFile(odd)); { const x = openRaw(odd); x.exec('DROP TABLE dispatch_attempts'); x.close(); } const o4 = tempDir('dsp-rb-o4'); assert.throws(() => rollbackDispatchesCopy(dbFile(odd), o4), (e) => e.code === 'UNEXPECTED_SCHEMA'); assert.deepEqual(fs.readdirSync(o4), []); assert.equal(run([odd, tempDir('dsp-rb-o4b')]).code, 10);
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the S7b rollback tool'); } return exec.call(this, sql); };
  const o5 = tempDir('dsp-rb-o5');
  try { assert.throws(() => rollbackDispatchesCopy(dbFile(src), o5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.deepEqual(fs.readdirSync(o5), [], 'a failure inside the tool leaves no output');
  const cli = run([src, tempDir('dsp-rb-cli'), '--json']); assert.equal(cli.code, 0); assert.deepEqual(JSON.parse(cli.out).counts, { dispatches: 4, attempts: 4 });
  rm(src, out, s7aOut, later, o1, notCut, o2, o3, odd, o4, o5);
});


// ============================================================= review of 26d492b (three independently reproduced findings)
test('review of 26d492b, finding 1 — EVERY patch refusal is a participant failure: a null or non-object patch, a missing row, an unknown field and an invalid value each refuse INSIDE the joined boundary, so a unit that catches the refusal still rolls back — the earlier patch of the same unit, the blob row it appended, the status in the table (second connection) and saveSeq are all as before, the held view shows the restored row — caught and uncaught, for the staged repository and for an immediate one participating in the same store unit, and for a repository whose hook is not registered; a write pending BEFORE the refused unit stays pending and lands with the successful retry; a valid empty patch stays a no-op', () => {
  const dir = tempDir('dsp-rv1'); s7aFile(dir, { dispatches: [] });
  const L = live(dir); L.dispatches.create(dsp({ id: 'dsp-1', attempts: [] })); L.save();
  const seq0 = seqOf(dir); const held = L.dispatches.byId('dsp-1');
  const durable = () => ({ status: rowsOf(dir, 'dispatches', 'seq')[0].status, seq: seqOf(dir), requests: JSON.parse(blobOf(dir, 'requests')).map((r) => r.id), attempts: attemptsOf(dir).length });
  const before = durable();
  const bad = {
    'null patch': () => L.dispatches.patch('dsp-1', null),
    'non-object patch': () => L.dispatches.patch('dsp-1', 'delivered'),
    'missing row': () => L.dispatches.patch('absent', { status: 'opened' }),
    'unknown field': () => L.dispatches.patch('dsp-1', { audience: { kind: 'x', id: 'y' } }),
    'invalid value': () => L.dispatches.patch('dsp-1', { nextAt: 1.5 }),
    'missing row, empty patch': () => L.dispatches.patch('absent', {}),
  };
  for (const [label, refuse] of Object.entries(bad)) {
    let caught = null; let outer = null;
    try { L.store.unitOfWork(() => { L.db.requests.push({ id: `req-${label}` }); L.dispatches.patch('dsp-1', { status: 'delivered' }); assert.equal(held.status, 'delivered'); try { refuse(); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
    assert.ok(caught, `${label}: the invalid call fails`); assert.ok(outer, `${label}: the unit is refused although the caller caught the failure`); assert.equal(outer.unitOfWork, 'rolled_back', label);
    assert.deepEqual(durable(), before, `${label}: nothing of the unit is durable`); assert.equal(held.status, 'accepted', `${label}: the held view shows the restored row`); assert.equal(L.dispatches.pending(), 0, `${label}: nothing stays queued from the rolled-back unit`); assert.equal(L.store.sqlite.isTransaction, false);
    assert.throws(() => L.store.unitOfWork(() => { L.db.requests.push({ id: `req-${label}-u` }); L.dispatches.patch('dsp-1', { status: 'delivered' }); refuse(); }, { snapshot: L.snapshot }), `${label}: uncaught`);
    assert.deepEqual(durable(), before, `${label}: uncaught — nothing durable`); assert.equal(held.status, 'accepted'); assert.equal(L.dispatches.pending(), 0);
  }
  // A write pending BEFORE the refused unit survives it and lands with the retry.
  L.dispatches.recordAttempt('dsp-1', { at: NOW, ok: true, error: null }); assert.equal(L.dispatches.pending(), 1);
  let outer = null; try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-x' }); try { L.dispatches.patch('dsp-1', null); } catch { /* caught */ } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.ok(outer); assert.equal(L.dispatches.pending(), 1, 'the pre-unit write is still pending'); assert.equal(attemptsOf(dir).length, 0); assert.equal(held.attempts.length, 1, 'and still in memory');
  L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-ok' }); L.dispatches.patch('dsp-1', { status: 'delivered' }); }, { snapshot: L.snapshot });
  assert.deepEqual(durable(), { status: 'delivered', seq: seq0 + 1, requests: ['req-ok'], attempts: 1 }, 'the retry lands the unit and the pre-unit write in one revision'); assert.equal(L.dispatches.pending(), 0);
  // A valid empty patch is a no-op (nothing queued, nothing written), inside and outside a unit.
  L.dispatches.patch('dsp-1', {}); assert.equal(L.dispatches.pending(), 0); L.save(); assert.equal(seqOf(dir), seq0 + 2);
  L.store.unitOfWork(() => { L.dispatches.patch('dsp-1', {}); }, { snapshot: L.snapshot }); assert.equal(L.dispatches.pending(), 0);
  // An immediate repository participating in the same store unit (hook registered): the same boundary.
  const imm = createDispatchesRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit }); L.store.setSaveHook(imm.saveHook());
  const before2 = durable();
  for (const [label, refuse] of [['null', () => imm.patch('dsp-1', null)], ['missing', () => imm.patch('absent', { status: 'opened' })], ['value', () => imm.patch('dsp-1', { failReason: 7 })]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.db.requests.push({ id: `req-imm-${label}` }); imm.patch('dsp-1', { status: 'opened' }); try { refuse(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.ok(c, label); assert.ok(o, `immediate ${label}: the unit is refused`); assert.deepEqual(durable(), before2, `immediate ${label}: nothing durable`); assert.equal(imm.byId('dsp-1').status, 'delivered', `immediate ${label}: its mirror restored`); assert.equal(L.store.sqlite.isTransaction, false);
  }
  // A repository given the participant API but whose hook was never registered: the caught refusal is still a participant failure.
  const noHook = createDispatchesRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true });
  { let c = null; let o = null; try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'req-nohook' }); try { noHook.patch('dsp-1', null); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; } assert.match(c?.message ?? '', /save hook/); assert.ok(o); assert.deepEqual(durable(), before2); }
  L.close(); rm(dir);
});

test('review of 26d492b, finding 2 — nested unknown data is DETACHED at ingress, export and transaction snapshots: mutating the input after create, or a returned export, never changes the mirror or a later export; own prototype-like keys ("__proto__", "constructor", "toString") survive at every depth with arrays, nulls and booleans; a rolled-back unit and a real COMMIT failure leave the held view on the restored row; a reload (restart) and the snapshot dispatcher reproduce the stored JSON; unsupported non-JSON values are refused whole (nothing written, nothing queued); attempt order is unchanged', () => {
  const dir = tempDir('dsp-rv2'); s7aFile(dir, { dispatches: [] });
  const L = live(dir);
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me","inner":{"__proto__":["deep"],"toString":null}},"constructor":{"toString":[1,{"__proto__":{"x":false}}]},"futureField":{"labels":["original"],"n":null,"b":true,"list":[[1,2],{"k":"v"}]}}');
  const input = dsp({ id: 'dsp-1', attempts: [{ at: 1, note: 'quiet hours re-check' }, { at: 2, ok: false, error: 'e' }, { at: 3, ok: true, error: null }], ...special });
  Object.defineProperty(input, '__proto__', { value: special.__proto__, enumerable: true, writable: true, configurable: true });
  const expectedExtras = plain(special); // a JSON round-trip: an object literal's `__proto__` key would set the prototype, the parsed one is an own key
  const extrasOf = (row) => { const o = {}; for (const k of Object.keys(row)) if (!DISPATCH_KEYS.includes(k)) Object.defineProperty(o, k, { value: row[k], enumerable: true, writable: true, configurable: true }); return plain(o); };
  const createdView = L.dispatches.create(input); L.save();
  assert.deepEqual(extrasOf(createdView), expectedExtras, 'the mirror carries every nested extra'); assert.ok(Object.hasOwn(L.dispatches.exportRows()[0], '__proto__') && Object.hasOwn(L.dispatches.exportRows()[0].__proto__.inner, '__proto__'));
  // Input aliasing.
  input.futureField.labels.push('input-alias'); input.constructor.toString.push('input-alias'); special.__proto__.inner.__proto__.push('input-alias');
  assert.deepEqual(extrasOf(L.dispatches.byId('dsp-1')), expectedExtras, 'the mirror is detached from the input');
  // Export aliasing.
  const exported = L.dispatches.exportRows()[0]; exported.futureField.labels.push('export-alias'); exported.__proto__.inner.__proto__.push('export-alias'); exported.futureField.list[0].push(3);
  assert.deepEqual(extrasOf(L.dispatches.byId('dsp-1')), expectedExtras, 'the mirror is detached from an export'); assert.deepEqual(extrasOf(L.dispatches.exportRows()[0]), expectedExtras, 'a later export is detached from an earlier one');
  assert.throws(() => { L.dispatches.byId('dsp-1').futureField.labels.push('view'); }, /written through its domain repository/, 'the view refuses a nested write');
  // A rolled-back unit: an export edit inside it changes nothing; a repository write inside it is restored, the held view included.
  const held = L.dispatches.byId('dsp-1');
  assert.throws(() => L.store.unitOfWork(() => { L.dispatches.exportRows()[0].futureField.labels.push('aborted-unit'); L.dispatches.patch('dsp-1', { status: 'delivered', failReason: 'x' }); assert.equal(held.status, 'delivered'); throw new Error('synthetic abort'); }, { snapshot: L.snapshot }), /synthetic abort/);
  assert.deepEqual(extrasOf(held), expectedExtras); assert.equal(held.status, 'accepted'); assert.equal(held.failReason, null); assert.equal(L.dispatches.pending(), 0);
  // A real COMMIT failure of a unit that creates a row with nested extras: no row in memory afterwards; the retry lands it.
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON dispatches BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.store.unitOfWork(() => { L.dispatches.create(dsp({ id: 'dsp-2', attempts: [], futureField: { labels: ['two'] } })); }, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/);
  assert.equal(L.dispatches.byId('dsp-2'), null); assert.equal(L.dispatches.count(), 1); L.store.sqlite.exec('DROP TRIGGER rv_commit');
  L.store.unitOfWork(() => { L.dispatches.create(dsp({ id: 'dsp-2', attempts: [], futureField: { labels: ['two'] } })); }, { snapshot: L.snapshot }); assert.deepEqual(plain(L.dispatches.byId('dsp-2').futureField), { labels: ['two'] });
  // Stored, reloaded (a restart) and round-tripped through the snapshot dispatcher: the same JSON; attempt order unchanged.
  const storedExtra = JSON.parse(rowsOf(dir, 'dispatches', 'seq')[0].extra_json); assert.deepEqual(storedExtra, expectedExtras); assert.ok(Object.hasOwn(storedExtra, '__proto__'));
  L.dispatches.reload(); assert.deepEqual(extrasOf(L.dispatches.byId('dsp-1')), expectedExtras, 'after a reload'); assert.deepEqual(plain(L.dispatches.byId('dsp-1').attempts), [{ at: 1, note: 'quiet hours re-check' }, { at: 2, ok: false, error: 'e' }, { at: 3, ok: true, error: null }], 'attempt order unchanged');
  L.close();
  { const tool = openStore(dir); const snap = tool.load(); assert.deepEqual(extrasOf(snap.db.dispatches[0]), expectedExtras); tool.save(snap); assert.deepEqual(extrasOf(tool.load().db.dispatches[0]), expectedExtras, 'round-tripped through replace'); tool.sqlite.close(); }
  // Unsupported non-JSON values are refused whole: nothing written, nothing queued, the count unchanged.
  const L2 = live(dir); const count = L2.dispatches.count();
  for (const [label, value] of [['a function', () => 1], ['an undefined inside an object', { x: undefined }], ['a bigint', 1n], ['a non-finite number', Number.POSITIVE_INFINITY], ['a NaN in an array', [1, Number.NaN]], ['a class instance', new Date(0)], ['a symbol', Symbol('s')]]) {
    assert.throws(() => L2.dispatches.create(dsp({ id: 'dsp-bad', attempts: [], futureField: value })), /futureField.*cannot be stored as JSON|unknown field.*cannot be/, label);
    assert.equal(L2.dispatches.byId('dsp-bad'), null, label); assert.equal(L2.dispatches.count(), count, label); assert.equal(L2.dispatches.pending(), 0, label);
  }
  assert.throws(() => validateDispatchRows([dsp({ attempts: [], futureField: { f: () => 1 } })]), /DISPATCHES_IMPORT_BLOCKED.*cannot be stored as JSON/);
  L2.close(); rm(dir);
});

test('review of 26d492b, finding 3 (the repository) — a non-finite callback clock is the legacy in-memory state the live route produces (`Number(ev.at) || Date.now()`): patch accepts it for deliveredAt / openedAt, the MIRROR keeps the number (a later nullish assignment sees the clock as set, as before S7b), the COLUMN stores NULL, the export and the snapshot shape carry null (what the JSON save persisted), a unit rollback restores the in-memory value, a reload (restart) shows null; create and the import still refuse a non-finite value (JSON never carries one); finite clocks are unchanged', () => {
  const dir = tempDir('dsp-rv3'); s7aFile(dir, { dispatches: [] });
  const L = live(dir); L.dispatches.create(dsp({ id: 'dsp-1', attempts: [] })); L.dispatches.create(dsp({ id: 'dsp-2', attempts: [], providerMessageId: 'fm_2' })); L.save();
  const held = L.dispatches.byId('dsp-1');
  L.dispatches.patch('dsp-1', { deliveredAt: Number.POSITIVE_INFINITY, status: 'delivered' }); L.save();
  assert.equal(held.deliveredAt, Number.POSITIVE_INFINITY, 'the mirror keeps the non-finite clock'); assert.equal(held.deliveredAt == null, false, 'a nullish check sees it as set');
  { const r = second(dir); try { assert.deepEqual({ ...r.prepare("SELECT delivered_at AS v, typeof(delivered_at) AS t, status FROM dispatches WHERE id = 'dsp-1'").get() }, { v: null, t: 'null', status: 'delivered' }, 'the column stores NULL'); } finally { r.close(); } }
  assert.equal(L.dispatches.exportRows()[0].deliveredAt, null, 'the export carries null'); assert.equal(JSON.parse(JSON.stringify(L.db.dispatches[0])).deliveredAt, null, 'a JSON view carries null');
  // A unit that changes the row and rolls back restores the in-memory non-finite value; one that commits keeps it.
  assert.throws(() => L.store.unitOfWork(() => { L.dispatches.patch('dsp-1', { deliveredAt: 5, openedAt: Number.NEGATIVE_INFINITY }); throw new Error('abort'); }, { snapshot: L.snapshot }), /abort/);
  assert.equal(held.deliveredAt, Number.POSITIVE_INFINITY); assert.equal(held.openedAt, null);
  L.store.unitOfWork(() => { L.dispatches.patch('dsp-1', { openedAt: Number.NEGATIVE_INFINITY, status: 'opened' }); }, { snapshot: L.snapshot });
  assert.equal(held.openedAt, Number.NEGATIVE_INFINITY); assert.equal(rowsOf(dir, 'dispatches', 'seq')[0].opened_at, null);
  // Finite clocks are unchanged: exact, fractional included.
  L.dispatches.patch('dsp-2', { deliveredAt: FRACTIONAL, openedAt: 1700000000000 }); L.save();
  assert.deepEqual(rowsOf(dir, 'dispatches', 'seq')[1].delivered_at, FRACTIONAL); assert.equal(L.dispatches.exportRows()[1].deliveredAt, FRACTIONAL);
  // A restart: the table's NULL is what the old build's JSON save left — the clock can be set again.
  L.dispatches.reload(); assert.equal(L.dispatches.byId('dsp-1').deliveredAt, null); assert.equal(L.dispatches.byId('dsp-1').openedAt, null);
  // Creation and import never accept a non-finite value (JSON cannot carry one; nothing is normalised there).
  assert.throws(() => L.dispatches.create(dsp({ id: 'dsp-3', attempts: [], deliveredAt: Number.POSITIVE_INFINITY })), /deliveredAt must be a finite number/);
  assert.throws(() => validateDispatchRows([dsp({ openedAt: Number.NaN })]), /openedAt must be a finite number/);
  assert.throws(() => L.dispatches.patch('dsp-1', { deliveredAt: '1' }), /deliveredAt must be a number/); assert.throws(() => L.dispatches.patch('dsp-1', { actionedAt: Number.POSITIVE_INFINITY }), /actionedAt must be an integer/);
  L.close(); rm(dir);
});

console.log(`\n${passed} dispatch checks passed`);
