// S7a — notifications and category notification preferences
// (repositories/notifications.mjs, migration 0009, repositories/notificationsRollback.mjs):
// the migration from the legacy blobs (shapes, normalisation, refusals, absent /
// empty / malformed / duplicate collections, first installation, reruns); the
// repository (the durable insertion-order key, coalescing exactly as the
// reverse scan always did — one row, the six-hour boundary included, the stop
// at the first older-than-cutoff row — proven differentially against the
// verbatim pre-S7a algorithm; reads; mark-read; deletion; acknowledgment;
// preferences with a stored mandatory false that the effective view forces on);
// the two write modes (immediate: own transaction, joined unit, raw caller
// transaction; staged: the server's mode, where a standalone write lands in the
// next snapshot save together with the blobs it announces and a unit's writes
// land in the unit's commit); the snapshot dispatcher; the copy-only rollback
// tool. Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import {
  createNotificationsRepository, validateNotificationRows, validateNotificationPrefsRows,
  NOTIFICATIONS_MIGRATION, NOTIFICATIONS_CUTOVER_META, NOTIFICATION_TABLES, NOTIFY_COALESCE_MS,
} from '../repositories/notifications.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { registerNotificationPrefs, CATEGORY_NAMES } from '../m182/notificationPrefs.mjs';
import { registerDelivery } from '../m13/delivery.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, blob, meta, dump, filesDigest } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
/** A second, independent connection: what it reads is what is committed. */
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'rowid') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const idsOf = (dir) => rowsOf(dir, 'notifications', 'seq').map((r) => r.id);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const tableExists = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const ORG_USER = { kind: 'org_user', id: 'usr-1' };
const PLAYER = { kind: 'player', id: 'pl-adult' };
/** A notification the way every pre-S7a build wrote it (the M18.2 literal). */
const ntf = (over = {}) => ({ id: `ntf-${over.id ?? 'a'}`, ts: NOW - MIN, audience: ORG_USER, type: 'message', text: 'Eastport FC (Head of Recruitment) sent a message.', refId: 'chan-1', read: false, repeatCount: 1, groupKey: 'message:chan-1', category: 'messages', deferredPush: false, ...over, ...(over.id ? { id: over.id } : {}) });
const pref = (over = {}) => ({ audienceKind: 'org_user', audienceId: 'usr-1', categories: { mentions: false }, emailIntent: false, updatedAt: NOW - HOUR, ...over });

/** A file at S6a (0001–0008 applied) carrying the notification blobs the way every pre-S7a build wrote them. */
function s6File(dir, { notifications, notificationPrefs } = {}) {
  const extra = { requests: [], ledger: [] };
  if (notifications !== undefined) extra.notifications = notifications;
  if (notificationPrefs !== undefined) extra.notificationPrefs = notificationPrefs;
  s3File(dir, { extra });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW, db: given } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = given ?? (store.load()?.db ?? {});
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, warnings, notifications: layer.notifications, snapshot, save: () => store.save(snapshot()), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test, the migration): own transaction per mutation. */
const bare = (s, over = {}) => createNotificationsRepository({ sqlite: s, now: () => NOW, nextId, ...over });

/**
 * The pre-S7a coalescing scan, VERBATIM from server.mjs notify() at 812e13b
 * (lines 843–854): the reference every differential check below compares the
 * repository against. Newest first by array position, a break at the first row
 * older than the cutoff (whatever lies before it is never examined), read rows
 * skipped, same audience/type/text/refId.
 */
function legacyCoalesceTarget(list, audience, type, text, refId, now) {
  const cutoff = now - NOTIFY_COALESCE_MS;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.ts < cutoff) break; // the array is append-ordered by time
    if (c.read) continue;
    if (c.audience.kind !== audience.kind || c.audience.id !== audience.id) continue;
    if (c.type !== type || c.text !== text || (c.refId ?? null) !== (refId ?? null)) continue;
    return c;
  }
  return null;
}

// ============================================================= migration 0009
test('migration 0009 (legacy blobs): every notification is imported with its id, fields, array position (the feed order) and acknowledgment contract; a pre-M18.2 row without repeatCount/groupKey/category/deferredPush is normalised exactly as the snapshot migration m182_005 did (repeatCount 1) and the other absent fields default (counted, never silently); an unknown field is kept and round-trips; the preferences are imported as stored — a mandatory category stored false included; the blob rows are retired; the cutover record carries counts only', () => {
  const dir = tempDir('ntf-mig');
  const legacy = [
    ntf({ id: 'ntf-1', ts: NOW - 3 * HOUR }),
    { id: 'ntf-2', ts: NOW - 2 * HOUR, audience: PLAYER, type: 'badge', text: 'Badge earned: Regular.', refId: 'pl-adult', read: true }, // pre-M18.2 shape
    ntf({ id: 'ntf-3', ts: NOW - HOUR, type: 'transition', text: 'A pack was withdrawn.', refId: 'trn-1', category: 'security_account', actionRequired: { deadline: NOW + 7 * 86_400_000, ackedAt: null, ackedBy: null }, future: { nested: [1, 2] } }),
    ntf({ id: 'ntf-4', ts: NOW - 4 * HOUR, read: false, repeatCount: 3 }), // older ts AFTER a newer row: a coalesce refresh moved its clock, not its position
  ];
  const prefs = [pref(), pref({ audienceKind: 'player', audienceId: 'pl-adult', categories: { compliance: false, discovery_nudges: true }, emailIntent: true, updatedAt: null })];
  s6File(dir, { notifications: legacy, notificationPrefs: prefs });
  const s = openRaw(dir);
  assert.deepEqual(migrate(s).ran, [NOTIFICATIONS_MIGRATION]);
  assert.deepEqual(s.prepare('SELECT seq, id FROM notifications ORDER BY seq').all().map((r) => [r.seq, r.id]), [[1, 'ntf-1'], [2, 'ntf-2'], [3, 'ntf-3'], [4, 'ntf-4']], 'the array position is the durable ordering key, whatever the timestamps');
  const r2 = s.prepare('SELECT * FROM notifications WHERE id = ?').get('ntf-2');
  assert.equal(r2.repeat_count, 1); assert.equal(r2.read, 1); assert.equal(r2.group_key, null); assert.equal(r2.category, null); assert.equal(r2.deferred_push, 0); assert.equal(r2.action_required, 0);
  const r3 = s.prepare('SELECT * FROM notifications WHERE id = ?').get('ntf-3');
  assert.equal(r3.action_required, 1); assert.equal(r3.action_deadline_at, NOW + 7 * 86_400_000); assert.equal(r3.action_acked_at, null); assert.deepEqual(JSON.parse(r3.extra_json), { future: { nested: [1, 2] } });
  assert.equal(s.prepare('SELECT repeat_count FROM notifications WHERE id = ?').get('ntf-4').repeat_count, 3);
  assert.deepEqual(s.prepare('SELECT * FROM notification_prefs ORDER BY rowid').all().map((r) => ({ ...r })), [
    { audience_kind: 'org_user', audience_id: 'usr-1', email_intent: 0, updated_at: NOW - HOUR },
    { audience_kind: 'player', audience_id: 'pl-adult', email_intent: 1, updated_at: null },
  ]);
  assert.deepEqual(s.prepare('SELECT audience_id, category, enabled FROM notification_pref_categories ORDER BY rowid').all().map((r) => [r.audience_id, r.category, r.enabled]), [['usr-1', 'mentions', 0], ['pl-adult', 'compliance', 0], ['pl-adult', 'discovery_nudges', 1]], 'a stored mandatory false is imported as it was stored (the effective view forces it on; nothing is rewritten silently)');
  assert.equal(blob(s, 'notifications'), undefined); assert.equal(blob(s, 'notificationPrefs'), undefined);
  const record = JSON.parse(meta(s, NOTIFICATIONS_CUTOVER_META));
  assert.deepEqual(record, { at: NOW, notifications: { imported: 4, normalised: { repeatCount: 1, read: 0, groupKey: 1, category: 1, deferredPush: 1 }, withExtraFields: 1, withActionRequired: 1 }, notificationPrefs: { imported: 2, categories: 3, normalised: { emailIntent: 0, updatedAt: 0 } } });
  assert.doesNotMatch(JSON.stringify(record), /sent a message|withdrawn|Badge/, 'the record carries no notification text');
  // The export reproduces the legacy shape, position for position, the unknown field included.
  const repo = bare(s);
  const exported = repo.exportRows();
  assert.deepEqual(exported.map((n) => n.id), ['ntf-1', 'ntf-2', 'ntf-3', 'ntf-4']);
  assert.deepEqual(exported[2], plain(legacy[2]));
  assert.deepEqual(exported[1], { ...legacy[1], repeatCount: 1, groupKey: null, category: null, deferredPush: false }, 'the normalised row in its exported shape');
  assert.deepEqual(exported[0], plain(legacy[0]));
  assert.deepEqual(repo.exportPrefs(), plain(prefs));
  s.close(); rm(dir);
});

test('migration 0009: a missing collection, an empty collection, an empty database and a first installation import nothing (and never infer anything from the seed or from row counts); a rerun is a no-op; 0008 must be recorded first; tables that exist without the record refuse the step', () => {
  const none = tempDir('ntf-mig-none'); s6File(none);
  let s = openRaw(none); migrate(s);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n + s.prepare('SELECT COUNT(*) AS n FROM notification_prefs').get().n, 0);
  assert.deepEqual(JSON.parse(meta(s, NOTIFICATIONS_CUTOVER_META)).notifications.imported, 0);
  assert.deepEqual(migrate(s, { now: NOW + 1 }).ran, [], 'a rerun does nothing'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(NOTIFICATIONS_MIGRATION).n, 1);
  s.close();
  const empty = tempDir('ntf-mig-empty'); s6File(empty, { notifications: [], notificationPrefs: [] });
  s = openRaw(empty); migrate(s); assert.equal(blob(s, 'notifications'), undefined, 'an empty blob is retired too'); assert.equal(blob(s, 'notificationPrefs'), undefined); s.close();
  const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW }).ran.includes(NOTIFICATIONS_MIGRATION)); for (const t of NOTIFICATION_TABLES) assert.ok(tableExists(mem, t), t); mem.close();
  // Prerequisite: 0008 first.
  const early = tempDir('ntf-mig-early'); s3File(early);
  s = openRaw(early);
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < '0008' || m.id === NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }), /0009_notifications failed: 0009_notifications: 0008_one_time_codes must be recorded first/);
  assert.equal(tableExists(s, 'notifications'), false); s.close();
  // Tables without the record: refused, never guessed.
  const odd = tempDir('ntf-mig-odd'); s6File(odd);
  s = openRaw(odd); s.exec('CREATE TABLE notification_prefs (x INTEGER) STRICT');
  assert.throws(() => migrate(s), /notification_prefs already exist without the migration record; refusing to guess/); s.close();
  rm(none, empty, early, odd);
});

test('migration 0009 refusals: a notification that is not an object, without an id, with a duplicate id, a non-integer ts, a missing or malformed audience, a missing type, a non-string text, a non-string refId, a non-boolean read, a repeatCount below 1, an unknown category, a malformed acknowledgment contract; a preference with an unknown field, an unknown category, a non-boolean value, a prototype-named category, a duplicate audience, a malformed audience; a blob that is not JSON or not an array — each aborts the whole step with NOTIFICATIONS_IMPORT_BLOCKED (entry index and reason, never the text), creates nothing, keeps the blobs byte for byte, and the next run refuses the same way', () => {
  const SECRET = 'SECRET-TEXT-ZQX9 do not log me';
  const cases = [
    ['not an object', { notifications: [null] }, /entry #0: not an object/],
    ['no id', { notifications: [ntf({ id: '', text: SECRET })] }, /entry #0: id must be a non-empty string/],
    ['a duplicate id', { notifications: [ntf({ id: 'ntf-dup', text: SECRET }), ntf({ id: 'ntf-dup' })] }, /entry #1: duplicates the id of an earlier entry/],
    ['a non-integer ts', { notifications: [ntf({ ts: '2026-10-11', text: SECRET })] }, /ts must be a non-negative integer timestamp/],
    ['a missing audience', { notifications: [ntf({ audience: undefined, text: SECRET })] }, /audience must be an object/],
    ['a malformed audience', { notifications: [ntf({ audience: { kind: 'org_user' }, text: SECRET })] }, /audience\.id must be a non-empty string/],
    ['a missing type', { notifications: [ntf({ type: null, text: SECRET })] }, /type must be a non-empty string/],
    ['a non-string text', { notifications: [ntf({ text: 42 })] }, /text must be a string/],
    ['a non-string refId', { notifications: [ntf({ refId: 7, text: SECRET })] }, /refId must be a string, null or absent/],
    ['a non-boolean read', { notifications: [ntf({ read: 'yes', text: SECRET })] }, /read must be a boolean/],
    ['repeatCount 0', { notifications: [ntf({ repeatCount: 0, text: SECRET })] }, /repeatCount must be an integer of at least 1/],
    ['an unknown category', { notifications: [ntf({ category: 'gossip', text: SECRET })] }, /category gossip is not a notification category/],
    ['a malformed acknowledgment contract', { notifications: [ntf({ actionRequired: { deadline: 'soon' }, text: SECRET })] }, /actionRequired\.deadline must be an integer timestamp or null/],
    ['an acknowledgment contract with an unknown field', { notifications: [ntf({ actionRequired: { deadline: null, ackedAt: null, ackedBy: null, note: 'x' }, text: SECRET })] }, /actionRequired carries unknown field\(s\) note/],
    ['a preference with an unknown field', { notificationPrefs: [pref({ note: SECRET })] }, /entry #0: unknown field\(s\) note/],
    ['a preference naming an unknown category', { notificationPrefs: [pref({ categories: { gossip: true } })] }, /entry #0: categories\.gossip is not a notification category/],
    ['a preference with a non-boolean value', { notificationPrefs: [pref({ categories: { mentions: 0 } })] }, /entry #0: categories\.mentions must be a boolean/],
    ['a prototype-named category', { notificationPrefs: [JSON.parse('{"audienceKind":"org_user","audienceId":"usr-1","categories":{"__proto__":{"polluted":true}},"emailIntent":false,"updatedAt":null}')] }, /entry #0: categories\.__proto__ is not a notification category/],
    ['a duplicate audience', { notificationPrefs: [pref(), pref({ categories: {} })] }, /entry #1: a second entry for org_user usr-1/],
    ['a malformed preference audience', { notificationPrefs: [pref({ audienceId: 5 })] }, /audienceId must be a non-empty string/],
    ['a non-array notifications blob', { notifications: { id: 'x' } }, /the notifications blob must be an array/],
    ['a non-array preferences blob', { notificationPrefs: 'none' }, /the notificationPrefs blob must be an array/],
  ];
  for (const [label, blobs, re] of cases) {
    const dir = tempDir('ntf-refuse'); s6File(dir, blobs);
    const s = openRaw(dir);
    const before = Object.fromEntries(['notifications', 'notificationPrefs'].map((n) => [n, s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value]));
    let err = null; try { migrate(s); } catch (e) { err = e; }
    assert.ok(err, `${label}: must refuse`); assert.match(err.message, /NOTIFICATIONS_IMPORT_BLOCKED/, label); assert.match(err.message, re, `${label}: ${err.message}`);
    assert.equal(err.message.includes(SECRET), false, `${label}: the refusal never carries the notification text`);
    assert.equal(s.isTransaction, false); for (const t of NOTIFICATION_TABLES) assert.equal(tableExists(s, t), false, `${label}: ${t} not created`);
    assert.equal(applied(s).includes(NOTIFICATIONS_MIGRATION), false);
    for (const n of Object.keys(before)) assert.equal(s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value, before[n], `${label}: the ${n} blob is kept as it was`);
    assert.throws(() => migrate(s), /NOTIFICATIONS_IMPORT_BLOCKED/, `${label}: the next run refuses the same way`);
    s.close(); rm(dir);
  }
  const notJson = tempDir('ntf-refuse-json'); s6File(notJson);
  { const s = openRaw(notJson); s.prepare("INSERT INTO collections (name, value) VALUES ('notifications', '{not json')").run(); assert.throws(() => migrate(s), /the notifications blob is not valid JSON/); s.close(); }
  rm(notJson);
  // The validators report the counts a caller may want and refuse without coercing.
  assert.deepEqual(validateNotificationRows([ntf(), { id: 'n2', ts: 1, audience: PLAYER, type: 't', text: '' }]).normalised, { read: 1, repeatCount: 1, groupKey: 1, category: 1, deferredPush: 1 });
  assert.throws(() => validateNotificationPrefsRows([pref({ emailIntent: 'yes' })]), /emailIntent must be a boolean/);
  assert.throws(() => validateNotificationPrefsRows([pref({ updatedAt: 1.5 })]), /updatedAt must be an integer timestamp, null or absent/);
});

// ============================================================= the repository: ordering, coalescing, reads
test('repository: the feed is reverse insertion order with a durable key — coalescing refreshes ts and counts the repeat WITHOUT moving the row, timestamps may tie, and the order survives a reopen; create returns the row in the shape every reader expects; the views and rows refuse writes', () => {
  const dir = tempDir('ntf-order'); s6File(dir);
  let s = openRaw(dir); migrate(s);
  let t = NOW; let repo = bare(s, { now: () => t });
  const a = repo.create({ audience: ORG_USER, type: 'message', text: 'Eastport FC (Head of Recruitment) sent a message.', refId: 'chan-1', category: 'messages', deferredPush: false });
  assert.deepEqual(plain(a), { id: a.id, ts: NOW, audience: ORG_USER, type: 'message', text: 'Eastport FC (Head of Recruitment) sent a message.', refId: 'chan-1', read: false, repeatCount: 1, groupKey: 'message:chan-1', category: 'messages', deferredPush: false });
  assert.match(a.id, /^ntf-/);
  t = NOW + MIN; const b = repo.create({ audience: ORG_USER, type: 'request', text: 'A trial request was accepted.', refId: 'req-1', category: 'messages', deferredPush: false, at: t });
  t = NOW + 2 * MIN; const c = repo.create({ audience: ORG_USER, type: 'case', text: 'Assigned.', refId: null, category: null, deferredPush: true, at: t }); // the same instant twice: a tie
  const d = repo.create({ audience: ORG_USER, type: 'case', text: 'Assigned too.', refId: null, category: null, deferredPush: false, at: t });
  assert.equal(c.groupKey, null, 'no refId, no group key');
  // Coalesce a: its clock moves to NOW+3min (now the newest), its position does not.
  t = NOW + 3 * MIN;
  const found = repo.findCoalescible({ audience: ORG_USER, type: 'message', text: a.text, refId: 'chan-1', at: t });
  assert.equal(found?.id, a.id);
  repo.coalesce(a.id, { at: t });
  assert.equal(a.ts, t, 'the row object every holder sees is refreshed in place'); assert.equal(a.repeatCount, 2);
  const feed = () => repo.forAudience('org_user', 'usr-1').map((n) => n.id);
  assert.deepEqual(feed(), [d.id, c.id, b.id, a.id], 'reverse insertion order: the refreshed row stays where it was inserted');
  assert.deepEqual(repo.view.map((n) => n.id), [a.id, b.id, c.id, d.id], 'the view is the insertion order (what every scan over it relies on)');
  s.close(); s = openRaw(dir); repo = bare(s);
  assert.deepEqual(repo.forAudience('org_user', 'usr-1').map((n) => n.id), [d.id, c.id, b.id, a.id], 'after a reopen the order is the same: the key is durable, not the timestamp');
  assert.equal(repo.byId(a.id).repeatCount, 2); assert.equal(repo.byId(a.id).ts, NOW + 3 * MIN);
  assert.deepEqual(repo.forAudience('player', 'pl-adult'), [], 'another audience sees nothing');
  assert.throws(() => repo.view.push({}), /written through its domain repository/);
  assert.throws(() => { repo.byId(a.id).read = true; }, /written through its domain repository/);
  assert.throws(() => repo.prefsView.push({}), /written through its domain repository/);
  s.close(); rm(dir);
});

test('repository: coalescing — only the reverse scan\'s selected row (the last matching unread row) coalesces even when an older identical unread row exists; a read row is skipped and a new occurrence after reading gets its own row; a different audience, type, text or refId never matches; exactly six hours old is INCLUDED, one millisecond older is not; the scan stops at the first row older than the cutoff, so a matching row behind it is never coalesced (the pre-S7a behaviour, preserved)', () => {
  const dir = tempDir('ntf-coalesce'); s6File(dir);
  const s = openRaw(dir); migrate(s);
  let t = NOW; const repo = bare(s, { now: () => t });
  const same = { audience: ORG_USER, type: 'message', text: 'Eastport FC (Head of Recruitment) sent a message.', refId: 'chan-1' };
  const mk = (over = {}, at = t) => repo.create({ ...same, category: 'messages', deferredPush: false, ...over, at });
  const target = (at = t, over = {}) => repo.findCoalescible({ ...same, ...over, at })?.id ?? null;
  const older = mk({}, NOW - 5 * HOUR); const newer = mk({}, NOW - HOUR);
  assert.equal(target(), newer.id, 'two identical unread rows: the later one is selected');
  repo.coalesce(newer.id, { at: NOW });
  assert.equal(older.repeatCount, 1, 'the older identical row is untouched'); assert.equal(newer.repeatCount, 2);
  // Read rows are skipped.
  repo.markRead('org_user', 'usr-1');
  assert.equal(target(), null, 'once read, nothing coalesces: a new occurrence is genuinely new');
  const fresh = mk({}, NOW); assert.equal(target(), fresh.id);
  // Isolation.
  assert.equal(target(t, { audience: { kind: 'org_user', id: 'usr-2' } }), null); assert.equal(target(t, { audience: { kind: 'player', id: 'usr-1' } }), null, 'the same id string under another kind is another person');
  assert.equal(target(t, { type: 'request' }), null); assert.equal(target(t, { text: 'Eastport FC (Head of Recruitment) sent a message' }), null); assert.equal(target(t, { refId: 'chan-2' }), null); assert.equal(target(t, { refId: null }), null);
  // The boundary: the row's ts against now - 6h, inclusive.
  const boundary = tempDir('ntf-boundary'); s6File(boundary); const s2 = openRaw(boundary); migrate(s2);
  const r2 = bare(s2, { now: () => NOW });
  const atSix = r2.create({ ...same, category: 'messages', deferredPush: false, at: NOW - NOTIFY_COALESCE_MS });
  assert.equal(r2.findCoalescible({ ...same, at: NOW })?.id, atSix.id, 'exactly six hours old is still coalescible');
  const r3dir = tempDir('ntf-boundary2'); s6File(r3dir); const s3 = openRaw(r3dir); migrate(s3);
  const r3 = bare(s3, { now: () => NOW });
  r3.create({ ...same, category: 'messages', deferredPush: false, at: NOW - NOTIFY_COALESCE_MS - 1 });
  assert.equal(r3.findCoalescible({ ...same, at: NOW }), null, 'one millisecond older is not');
  // The stop: an unrelated row older than the cutoff AFTER a matching row hides it.
  const r4dir = tempDir('ntf-stop'); s6File(r4dir); const s4 = openRaw(r4dir); migrate(s4);
  const r4 = bare(s4, { now: () => NOW });
  const hidden = r4.create({ ...same, category: 'messages', deferredPush: false, at: NOW - 5 * HOUR });
  r4.coalesce(hidden.id, { at: NOW - MIN }); // its clock is recent now…
  r4.create({ audience: PLAYER, type: 'badge', text: 'Badge earned.', refId: 'pl-adult', category: 'discovery_nudges', deferredPush: false, at: NOW - 8 * HOUR }); // …but a later row carries an old clock (a restored backup, a clock set back)
  assert.equal(r4.findCoalescible({ ...same, at: NOW }), null, 'the scan stopped at the old row and never saw the matching one (preserved behaviour)');
  assert.equal(legacyCoalesceTarget(plain(r4.view), same.audience, same.type, same.text, same.refId, NOW), null, 'exactly what the pre-S7a scan does');
  s.close(); s2.close(); s3.close(); s4.close(); rm(dir, boundary, r3dir, r4dir);
});

test('repository: differential — on 300 random feeds (ties, refreshed clocks, read rows, mixed audiences, null and absent refIds, rows older than the cutoff in every position) the repository selects exactly the row the verbatim pre-S7a scan selects', () => {
  let seed = 20261014;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const audiences = [ORG_USER, { kind: 'org_user', id: 'usr-2' }, PLAYER];
  const types = ['message', 'request']; const texts = ['A', 'B']; const refs = ['r1', null, undefined];
  let agreed = 0; let nonNull = 0;
  for (let round = 0; round < 300; round++) {
    const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW });
    const repo = createNotificationsRepository({ sqlite: mem, now: () => NOW, nextId });
    const n = 1 + rnd(9);
    for (let i = 0; i < n; i++) {
      const at = NOW - rnd(8) * HOUR - rnd(3) * NOTIFY_COALESCE_MS / 6 + (rnd(2) ? 0 : 1); // clocks around and across the cutoff, ties included
      const row = repo.create({ audience: audiences[rnd(3)], type: types[rnd(2)], text: texts[rnd(2)], refId: refs[rnd(3)] ?? null, category: null, deferredPush: false, at: Math.max(0, at) });
      if (rnd(4) === 0) repo.coalesce(row.id, { at: NOW - rnd(7) * HOUR }); // a refreshed clock out of order with the position
      if (rnd(3) === 0) repo.markRead(row.audience.kind, row.audience.id);
    }
    const q = { audience: audiences[rnd(3)], type: types[rnd(2)], text: texts[rnd(2)], refId: refs[rnd(3)] };
    const expected = legacyCoalesceTarget(plain(repo.view), q.audience, q.type, q.text, q.refId, NOW)?.id ?? null;
    const actual = repo.findCoalescible({ ...q, at: NOW })?.id ?? null;
    assert.equal(actual, expected, `round ${round}: ${JSON.stringify({ q, feed: plain(repo.view) })}`);
    agreed += 1; if (expected) nonNull += 1;
    mem.close();
  }
  assert.equal(agreed, 300); assert.ok(nonNull > 30, `the cases include real matches (${nonNull})`);
});

test('repository: reads and the other mutations — unread count, awaiting-ack count, by id; mark-read flips every row of one audience only; deletion removes one audience\'s rows and keeps everyone else\'s and the person\'s preferences; the acknowledgment contract is set at creation or on a coalesced row (resetting an earlier ack, as notifyAction always did), acknowledged once (the second ack is a no-op that returns the first), and refused for another audience or a row without one', () => {
  const dir = tempDir('ntf-reads'); s6File(dir);
  const s = openRaw(dir); migrate(s);
  const repo = bare(s);
  const a = repo.create({ audience: ORG_USER, type: 'transition', text: 'Withdrawn.', refId: 'trn-1', category: 'security_account', deferredPush: false, actionRequired: { deadline: NOW + HOUR } });
  assert.deepEqual(plain(a.actionRequired), { deadline: NOW + HOUR, ackedAt: null, ackedBy: null });
  const b = repo.create({ audience: ORG_USER, type: 'message', text: 'M', refId: 'c', category: 'messages', deferredPush: false });
  const p = repo.create({ audience: PLAYER, type: 'message', text: 'M', refId: 'c', category: 'messages', deferredPush: false });
  repo.updatePrefs('player', 'pl-adult', { categories: { messages: false } });
  assert.equal(repo.unreadCount('org_user', 'usr-1'), 2); assert.equal(repo.unreadCount('player', 'pl-adult'), 1); assert.equal(repo.awaitingAckCount(), 1);
  assert.equal(repo.markRead('org_user', 'usr-1'), 2); assert.equal(repo.markRead('org_user', 'usr-1'), 0, 'nothing left to flip');
  assert.equal(repo.unreadCount('org_user', 'usr-1'), 0); assert.equal(p.read, false, 'the player\'s row is untouched');
  assert.deepEqual(s.prepare('SELECT id FROM notifications WHERE read = 1 ORDER BY seq').all().map((r) => r.id), [a.id, b.id]);
  // Acknowledgment.
  assert.deepEqual(repo.ack(a.id, PLAYER, { at: NOW + 1 }), { status: 'not_found' }, 'another audience cannot acknowledge it');
  assert.deepEqual(repo.ack(b.id, ORG_USER, { at: NOW + 1 }), { status: 'no_action' });
  assert.deepEqual(repo.ack(a.id, ORG_USER, { at: NOW + 2 }), { status: 'ok', ackedAt: NOW + 2, already: false });
  assert.deepEqual(plain(a.actionRequired), { deadline: NOW + HOUR, ackedAt: NOW + 2, ackedBy: 'usr-1' }); assert.equal(repo.awaitingAckCount(), 0);
  assert.deepEqual(repo.ack(a.id, ORG_USER, { at: NOW + 3 }), { status: 'ok', ackedAt: NOW + 2, already: true }, 'acknowledged once');
  assert.equal(s.prepare('SELECT action_acked_at FROM notifications WHERE id = ?').get(a.id).action_acked_at, NOW + 2);
  // A repeat of an action notice resets the contract (notifyAction overwrote it before S7a).
  const again = repo.create({ audience: ORG_USER, type: 'transition', text: 'Withdrawn.', refId: 'trn-1', category: 'security_account', deferredPush: false, at: NOW + 4 });
  repo.coalesce(again.id, { at: NOW + 5, actionRequired: { deadline: NOW + 2 * HOUR } });
  assert.deepEqual(plain(again.actionRequired), { deadline: NOW + 2 * HOUR, ackedAt: null, ackedBy: null }); assert.equal(repo.awaitingAckCount(), 1);
  // Deletion: one audience, rows only — preferences are retained.
  assert.equal(repo.deleteForAudience('player', 'pl-adult'), 1);
  assert.equal(repo.byId(p.id), null); assert.equal(repo.count(), 3); assert.ok(repo.prefsFor('player', 'pl-adult'), 'the preferences survive the deletion (retained by decision)');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notification_pref_categories WHERE audience_id = ?').get('pl-adult').n, 1);
  assert.equal(repo.deleteForAudience('player', 'pl-adult'), 0);
  s.close(); rm(dir);
});

// ============================================================= preferences
test('preferences through the real M18.2 module over the repository: defaults are the module\'s, a stored row overrides them, a mandatory category stored false (numeric zero through the route, a legacy row) is kept as stored and forced ON by the effective view and by the gate, an unknown category or a literal false on a mandatory category is refused by the route, an unknown type is delivered, and a preference is keyed by kind AND id', () => {
  const dir = tempDir('ntf-prefs'); s6File(dir, { notificationPrefs: [pref({ audienceKind: 'guardian', audienceId: 'g-1', categories: { combine: false, security_account: false } })] });
  const s = openRaw(dir); migrate(s);
  const repo = bare(s);
  const routes = {}; const stubFor = (prefix) => ({ get(p, h) { routes[`get ${prefix}${p}`] = h; }, put(p, h) { routes[`put ${prefix}${p}`] = h; } });
  const { allows, effective } = registerNotificationPrefs({ db: {}, notifications: repo, orgRouter: stubFor('/org'), playerRouter: stubFor('/player'), guardianRouter: stubFor('/guardian'), persist() {} });
  const tom = { kind: 'org_user', id: 'u-tom' }; const maria = { kind: 'org_user', id: 'u-maria' };
  assert.equal(allows(tom, 'recruitment_room', 'Maria mentioned you'), true, 'a mention is delivered by default');
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  let r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'u-tom' }, body: { categories: { mentions: false, compliance: 0 } } }, r);
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.deepEqual(plain(repo.prefsFor('org_user', 'u-tom').categories), { mentions: false, compliance: false }, 'numeric zero is coerced and stored false — as the route always did');
  assert.equal(allows(tom, 'recruitment_room', 'Maria mentioned you'), false, 'mentions are off for Tom');
  assert.equal(allows(maria, 'recruitment_room', 'Tom mentioned you'), true, 'isolation');
  assert.equal(allows(tom, 'regulatory_review_required', 'x'), true, 'the mandatory category is delivered whatever is stored');
  assert.equal(effective('org_user', 'u-tom').categories.compliance, true, 'and the effective view forces it on');
  assert.equal(r.body.preferences.categories.find((c) => c.id === 'compliance').enabled, true);
  assert.equal(effective('guardian', 'g-1').categories.security_account, true, 'a legacy stored false on security_account is forced on too'); assert.equal(repo.prefsFor('guardian', 'g-1').categories.security_account, false, 'and never rewritten');
  assert.equal(allows({ kind: 'guardian', id: 'g-1' }, 'combine', 'x'), false); assert.equal(allows({ kind: 'player', id: 'g-1' }, 'combine', 'x'), true, 'kind AND id');
  assert.equal(allows(tom, 'never_seen_type', 'x'), true, 'an unknown type is delivered');
  r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'u-tom' }, body: { categories: { compliance: false } } }, r); assert.equal(r.code, 400); assert.equal(r.body.error, 'PREF_CATEGORY_MANDATORY');
  r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'u-tom' }, body: { categories: { gossip: true } } }, r); assert.equal(r.code, 400); assert.equal(r.body.error, 'PREF_CATEGORY_UNKNOWN');
  r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'u-tom' }, body: { categories: [] } }, r); assert.equal(r.code, 400); assert.equal(r.body.error, 'PREFS_INVALID');
  r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'u-tom' }, body: { emailIntent: 1 } }, r); assert.equal(r.code, 200); assert.equal(repo.prefsFor('org_user', 'u-tom').emailIntent, true); assert.deepEqual(plain(repo.prefsFor('org_user', 'u-tom').categories), { mentions: false, compliance: false }, 'a write without categories keeps the stored ones');
  assert.deepEqual(s.prepare('SELECT category, enabled FROM notification_pref_categories WHERE audience_id = ? ORDER BY category').all('u-tom').map((x) => [x.category, x.enabled]), [['compliance', 0], ['mentions', 0]]);
  assert.equal(s.prepare('SELECT email_intent FROM notification_prefs WHERE audience_id = ?').get('u-tom').email_intent, 1);
  // The repository's own validation (the route coerces before it; a direct caller is refused, never coerced).
  assert.throws(() => repo.updatePrefs('org_user', 'u-x', { categories: { mentions: 0 } }), /categories\.mentions must be a boolean/);
  assert.throws(() => repo.updatePrefs('org_user', 'u-x', { categories: { gossip: true } }), /not a notification category/);
  assert.throws(() => repo.updatePrefs('org_user', '', { categories: {} }), /audience id/);
  assert.equal(repo.prefsFor('org_user', 'u-x'), null, 'nothing was stored');
  assert.throws(() => registerNotificationPrefs({ db: {}, orgRouter: stubFor('/x'), playerRouter: stubFor('/x'), guardianRouter: stubFor('/x'), persist() {} }), /needs the notifications repository/);
  assert.ok(CATEGORY_NAMES.includes('security_account'));
  s.close(); rm(dir);
});

test('m13 notifyAction: a muted notification (the gate returned null) yields null instead of crashing, and an allowed one carries the acknowledgment contract', () => {
  const dir = tempDir('ntf-action'); s6File(dir);
  const s = openRaw(dir); migrate(s);
  const repo = bare(s);
  const router = { post() {}, get() {}, put() {} };
  let muted = false;
  const notify = (audience, type, text, refId = null, { actionRequired = null } = {}) => (muted ? null : repo.create({ audience, type, text, refId, category: 'security_account', deferredPush: false, actionRequired }));
  const ctx = { db: { dispatches: [], notifications: repo.view, users: [], guardians: [], outbox: [] }, notifications: repo, users: [], app: { post() {} }, orgRouter: router, playerRouter: router, guardianRouter: router, adminRouter: router, nextId, persist() {}, persistNow() {}, notify, findPlayer: () => null, isAdult: () => true, signBody: () => '', timingSafeEq: () => false, paginate: (_r, x) => x, unit: (w) => w() };
  const saveInterval = globalThis.setInterval; globalThis.setInterval = () => ({ unref() {} });
  try { registerDelivery(ctx); } finally { globalThis.setInterval = saveInterval; }
  const n = ctx.notifyAction(ORG_USER, 'transition', 'Withdrawn.', 'trn-1', NOW + HOUR);
  assert.deepEqual(plain(n.actionRequired), { deadline: NOW + HOUR, ackedAt: null, ackedBy: null });
  muted = true;
  assert.equal(ctx.notifyAction(ORG_USER, 'transition', 'Withdrawn.', 'trn-1', NOW + HOUR), null, 'muted: null, no throw');
  s.close(); rm(dir);
});

// ============================================================= the staged mode (the server's): a write lands with the blobs it announces
/** Durable state read through an independent connection. */
const durable = (dir) => ({ ids: idsOf(dir), rows: rowsOf(dir, 'notifications', 'seq').map((r) => [r.id, r.occurred_at, r.repeat_count, r.read]), prefs: rowsOf(dir, 'notification_pref_categories').map((r) => [r.audience_id, r.category, r.enabled]), requests: blobOf(dir, 'requests'), seq: seqOf(dir) });

test('staged mode (the server): a standalone create, coalesce, mark-read or preference write is visible in memory at once but is NOT durable ahead of the snapshot save that carries the blob edits made alongside it — the next save lands them together in ONE revision (independent connection); a failed save keeps them pending and the retry lands them; the write-ahead order of the file is the memory order', () => {
  const dir = tempDir('ntf-staged'); s6File(dir);
  const L = live(dir); L.save();
  const before = durable(dir);
  L.db.requests.push({ id: 'req-announced', status: 'pending' }); // the action…
  const n = L.notifications.create({ audience: ORG_USER, type: 'request', text: 'A request landed.', refId: 'req-announced', category: 'messages', deferredPush: false }); // …and the notification announcing it
  assert.equal(L.notifications.byId(n.id)?.id, n.id, 'visible in memory at once'); assert.equal(L.notifications.pending(), 1);
  assert.deepEqual(durable(dir), before, 'nothing durable yet: the notification does not commit ahead of the request it announces');
  L.save();
  const after = durable(dir);
  assert.deepEqual(after.ids, [n.id]); assert.match(after.requests, /req-announced/); assert.equal(after.seq, before.seq + 1, 'one save, one revision, both in it'); assert.equal(L.notifications.pending(), 0);
  // A failed save: the pending write is kept and retried.
  L.store.sqlite.exec("CREATE TEMP TRIGGER t_ntf_upd BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
  L.notifications.coalesce(n.id, { at: NOW + MIN });
  assert.throws(() => L.save(), /injected update failure/);
  assert.equal(L.store.sqlite.isTransaction, false); assert.deepEqual(durable(dir), after, 'nothing changed'); assert.equal(n.repeatCount, 2, 'memory is the intended state'); assert.equal(L.notifications.pending(), 1, 'still pending');
  L.store.sqlite.exec('DROP TRIGGER t_ntf_upd');
  L.save();
  assert.deepEqual(durable(dir).rows, [[n.id, NOW + MIN, 2, 0]]); assert.equal(L.notifications.pending(), 0);
  // Mark-read and a preference write: the same path.
  L.notifications.markRead('org_user', 'usr-1'); L.notifications.updatePrefs('org_user', 'usr-1', { categories: { mentions: false } });
  assert.equal(rowsOf(dir, 'notifications')[0].read, 0); assert.deepEqual(durable(dir).prefs, []);
  L.save();
  assert.equal(rowsOf(dir, 'notifications')[0].read, 1); assert.deepEqual(durable(dir).prefs, [['usr-1', 'mentions', 0]]);
  // Order: a standalone write, then a unit's write, then another standalone write — the file holds them in that order.
  const s1 = L.notifications.create({ audience: ORG_USER, type: 'case', text: 'one', refId: null, category: null, deferredPush: false });
  const u1 = L.store.unitOfWork(() => L.notifications.create({ audience: ORG_USER, type: 'case', text: 'two', refId: null, category: null, deferredPush: false }), { snapshot: L.snapshot });
  const s2 = L.notifications.create({ audience: ORG_USER, type: 'case', text: 'three', refId: null, category: null, deferredPush: false });
  assert.deepEqual(idsOf(dir), [n.id, s1.id, u1.id], 'the unit\'s commit carried the earlier standalone write with it, in order; the later one is pending');
  L.save();
  assert.deepEqual(idsOf(dir), [n.id, s1.id, u1.id, s2.id]); assert.deepEqual(L.notifications.view.map((x) => x.id), [n.id, s1.id, u1.id, s2.id], 'durable order == memory order');
  L.close(); rm(dir);
});

/** Run `work` in a unit of work whose caller swallows the repository error; returns what the caller caught and what the unit threw. */
const swallowing = (L, work) => {
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.db.requests.push({ id: 'unrelated-edit', status: 'pending' }); try { work(); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  return { caught, outer };
};

test('staged mode inside a unit of work: the notification and the blob edit commit together in one revision; a failure after the write (thrown), a failure of the real COMMIT, a failure of the flush SQL itself (temporary trigger) and a caught validation failure each leave the file unchanged (independent connection), restore the feed, the row objects, the counts and the preferences in memory, keep the writes that were pending BEFORE the unit (landed by the next save), leave no transaction open; the retry lands everything; side effects registered for after the commit never run on a rollback', () => {
  const dir = tempDir('ntf-unit'); s6File(dir);
  const L = live(dir); L.save();
  const pre = L.notifications.create({ audience: ORG_USER, type: 'case', text: 'pending before the unit', refId: null, category: null, deferredPush: false }); // pending, not yet saved
  const seq0 = seqOf(dir); const memoryBefore = () => ({ ids: L.notifications.view.map((x) => x.id), requests: JSON.stringify(L.db.requests), unread: L.notifications.unreadCount('org_user', 'usr-1'), prefs: plain(L.notifications.prefsView), pending: L.notifications.pending() });
  const m0 = memoryBefore();
  let effects = 0;
  const op = (fault) => L.store.unitOfWork(() => {
    L.db.requests.push({ id: 'req-unit', status: 'pending' });
    const n = L.notifications.create({ audience: ORG_USER, type: 'request', text: 'In the unit.', refId: 'req-unit', category: 'messages', deferredPush: false });
    L.notifications.updatePrefs('org_user', 'usr-1', { categories: { mentions: false }, emailIntent: true });
    L.notifications.markRead('org_user', 'usr-1');
    L.store.afterCommit(() => { effects += 1; });
    if (fault === 'after_write') throw new Error('injected failure after the write');
    if (fault === 'commit') L.store.failCommitOfOpenTransaction();
    return n.id;
  }, { snapshot: L.snapshot });
  for (const [fault, re] of [['after_write', /injected failure after the write/], ['commit', /FOREIGN KEY constraint failed/], ['flush', /injected insert failure/]]) {
    if (fault === 'flush') L.store.sqlite.exec("CREATE TEMP TRIGGER t_ntf_ins BEFORE INSERT ON notifications WHEN NEW.text = 'In the unit.' BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END");
    assert.throws(() => op(fault === 'flush' ? null : fault), re, fault);
    if (fault === 'flush') L.store.sqlite.exec('DROP TRIGGER t_ntf_ins');
    assert.equal(seqOf(dir), seq0, `${fault}: no revision`); assert.deepEqual(idsOf(dir), [], `${fault}: nothing in the file (the pre-unit write is still pending, not lost)`);
    assert.deepEqual(memoryBefore(), m0, `${fault}: memory restored — the feed, the unrelated edit, the unread count, the preferences, the pending count`);
    assert.equal(pre.read, false, `${fault}: the pre-unit row object was restored in place`);
    assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false); assert.equal(effects, 0, `${fault}: no side effect ran`);
  }
  // A caught validation failure still poisons the unit.
  const { caught, outer } = swallowing(L, () => L.notifications.create({ audience: { kind: 'org_user' }, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }));
  assert.match(caught?.message ?? '', /audience/); assert.ok(outer, 'the unit refused to commit'); assert.match(outer.message, /cannot commit.*audience/s); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(memoryBefore(), m0); assert.equal(seqOf(dir), seq0);
  // The retry.
  const id = op(null);
  assert.equal(seqOf(dir), seq0 + 1, 'one commit, one revision'); assert.deepEqual(idsOf(dir), [pre.id, id], 'the pre-unit write landed first, inside the unit\'s commit');
  assert.match(blobOf(dir, 'requests'), /req-unit/); assert.deepEqual(durable(dir).prefs, [['usr-1', 'mentions', 0]]); assert.deepEqual(rowsOf(dir, 'notifications', 'seq').map((r) => r.read), [1, 1]);
  assert.equal(effects, 1, 'the side effect ran once, after the commit'); assert.equal(L.notifications.pending(), 0);
  // The two-connection read: a brand-new connection sees exactly the committed rows.
  const o = openRaw(dir); assert.deepEqual(bare(o).forAudience('org_user', 'usr-1').map((x) => x.id), [id, pre.id]); o.close();
  L.close(); rm(dir);
});

test('staged mode refuses a foreign raw transaction (it cannot learn that transaction\'s outcome; the server\'s transactions are units of work or saves), and the repository refuses a malformed participant API or a staged mode without a store', () => {
  const dir = tempDir('ntf-raw'); s6File(dir);
  const L = live(dir);
  L.store.sqlite.exec('BEGIN');
  assert.throws(() => L.notifications.create({ audience: ORG_USER, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }), /cannot take part in a transaction it did not open/);
  L.store.sqlite.exec('ROLLBACK');
  assert.equal(L.notifications.count(), 0, 'nothing was staged');
  const s = openRaw(dir);
  assert.throws(() => createNotificationsRepository({ sqlite: s, unit: { active: () => false } }), /participant API/);
  assert.throws(() => createNotificationsRepository({ sqlite: s, staged: true }), /staged mode needs the store's participant API/);
  assert.throws(() => createNotificationsRepository({}), /SQLite connection/);
  s.close(); L.close(); rm(dir);
});

// ============================================================= the immediate mode: own transaction, joined unit, raw transaction (the S6a contract)
test('immediate mode (tools, tests, the migration): a mutation runs in a transaction of its own — a multi-statement preference write whose second statement fails (temporary trigger) rolls its first back; inside a unit of work the operation joins it, so the same failure caught by the caller still refuses the unit (file unchanged, unrelated edit restored, no transaction open) and the retry lands; a raw transaction a tool opened is honoured without a BEGIN of its own and its ROLLBACK undoes the operation', () => {
  const dir = tempDir('ntf-immediate'); s6File(dir);
  const L = live(dir); L.save();
  // A second, immediate-mode instance on the store's connection (a tool sharing the connection with the running process is not a server scenario; this proves the boundary).
  const tool = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit });
  L.store.sqlite.exec("CREATE TEMP TRIGGER t_cat_ins BEFORE INSERT ON notification_pref_categories BEGIN SELECT RAISE(ABORT, 'injected category insert failure'); END");
  assert.throws(() => tool.updatePrefs('org_user', 'usr-9', { categories: { mentions: false }, emailIntent: true }), /injected category insert failure/);
  assert.equal(rowsOf(dir, 'notification_prefs').length, 0, 'standalone: the parent row went back with the failed category row'); assert.equal(L.store.sqlite.isTransaction, false);
  const before = durable(dir); const memoryBefore = JSON.stringify(L.db.requests);
  const { caught, outer } = swallowing(L, () => tool.updatePrefs('org_user', 'usr-9', { categories: { mentions: false }, emailIntent: true }));
  assert.match(caught?.message ?? '', /injected category insert failure/); assert.ok(outer, 'the enclosing unit refused to commit'); assert.match(outer.message, /cannot commit.*injected category insert failure/s); assert.equal(outer.cause, caught); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(durable(dir), before); assert.equal(JSON.stringify(L.db.requests), memoryBefore); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false);
  L.store.sqlite.exec('DROP TRIGGER t_cat_ins');
  L.store.unitOfWork(() => tool.updatePrefs('org_user', 'usr-9', { categories: { mentions: false }, emailIntent: true }), { snapshot: L.snapshot });
  assert.deepEqual(durable(dir).prefs, [['usr-9', 'mentions', 0]]); assert.equal(seqOf(dir), before.seq + 1);
  // A raw transaction on a bare connection.
  L.close();
  const s = openRaw(dir); const repo = bare(s);
  s.exec('BEGIN'); const r = repo.create({ audience: ORG_USER, type: 'x', text: 'raw', refId: null, category: null, deferredPush: false });
  assert.equal(s.isTransaction, true, 'the caller still owns the transaction'); assert.equal(repo.byId(r.id)?.id, r.id);
  s.exec('ROLLBACK');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0, "the tool's ROLLBACK undid the operation");
  assert.equal(repo.byId(r.id)?.id, r.id, 'the mirror cannot see a ROLLBACK the repository did not issue (documented: the tool reloads)');
  assert.deepEqual(repo.reload(), { notifications: 0, notificationPrefs: 1 }, 'the table: no notification, the one committed preference record'); assert.equal(repo.byId(r.id), null, 'after reload() the mirror is the table again');
  // Expected negatives are results, never failures.
  assert.equal(repo.findCoalescible({ audience: ORG_USER, type: 'x', text: 'nothing', refId: null, at: NOW }), null); assert.equal(repo.markRead('org_user', 'nobody'), 0); assert.equal(repo.deleteForAudience('player', 'nobody'), 0);
  s.close(); rm(dir);
});

// ============================================================= boot and attach
test('boot: the data layer attaches to the tables as they are — an in-memory notifications or preferences array (the seed container, a stale copy, the blob the migration just imported) is never imported, is reported when it is not empty, and its blob row is deleted so no save can bring it back; intentionally empty live tables stay empty; a pre-M18.2 file (no preferences blob at all, rows without repeatCount) boots; the report carries counts only', () => {
  const dir = tempDir('ntf-boot'); s6File(dir, { notifications: [ntf({ id: 'ntf-old' })] });
  let L = live(dir); // the migration runs here
  assert.deepEqual(L.notifications.view.map((n) => n.id), ['ntf-old']); assert.deepEqual(L.warnings, [], 'the blob the migration imported is dropped silently');
  assert.equal(Object.getOwnPropertyDescriptor(L.db, 'notifications').writable, false); assert.equal(Object.getOwnPropertyDescriptor(L.db, 'notificationPrefs').writable, false);
  L.close();
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, notifications: [ntf({ id: 'ntf-stale', text: 'STALE-TEXT' })], notificationPrefs: [pref()] };
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.ok(warnings.some((w) => /an in-memory notifications array with 1 entry was ignored/.test(w)), JSON.stringify(warnings)); assert.ok(warnings.some((w) => /an in-memory notificationPrefs array with 1 entry was ignored/.test(w)));
  assert.equal(warnings.join('\n').includes('STALE-TEXT'), false, 'the warning carries a count, never the text');
  assert.equal(layer.notifications.byId('ntf-stale'), null, 'the stale array was not imported'); assert.deepEqual(db.notifications.map((n) => n.id), ['ntf-old']);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('notifications', 'notificationPrefs')").get().n, 0, 'no shadow blob');
  const report = JSON.stringify(layer.report());
  assert.match(report, /"notifications":\{"mode":"live","rows":\{"notifications":1,"notificationPrefs":0\}/); assert.doesNotMatch(report, /sent a message/);
  store.sqlite.close();
  // Intentionally empty live tables.
  const empty = tempDir('ntf-boot-empty'); s6File(empty, { notifications: [], notificationPrefs: [] });
  L = live(empty); assert.equal(L.notifications.count(), 0); L.close();
  L = live(empty, { db: { notifications: [ntf({ id: 'seed-row' })] } }); assert.equal(L.notifications.count(), 0, 'a seed array never initialises live tables'); assert.equal(L.warnings.length, 1); L.close();
  // Pre-M18.2 file.
  const old = tempDir('ntf-boot-old'); s6File(old, { notifications: [{ id: 'n1', ts: NOW - HOUR, audience: PLAYER, type: 'badge', text: 'Badge', refId: 'pl-adult', read: false }] });
  L = live(old); assert.equal(L.notifications.byId('n1').repeatCount, 1); assert.equal(L.notifications.prefsFor('player', 'pl-adult'), null); L.close();
  // The attach refuses without the record.
  const bad = tempDir('ntf-boot-bad'); s6File(bad);
  { const s = openRaw(bad); migrate(s); s.prepare('DELETE FROM data_migrations WHERE id = ?').run(NOTIFICATIONS_MIGRATION); s.close(); }
  assert.throws(() => live(bad), /already exist without the migration record/);
  rm(dir, empty, old, bad);
});

// ============================================================= snapshots (backups, restores, persistence suites)
test('snapshot dispatcher: after the cutover a tool reads both collections in the legacy shape (position order, acknowledgment contracts, unknown fields) and writes them back through the tables; a collection the snapshot omits leaves its table alone; a malformed entry, a duplicate id, an unknown category or a non-array collection refuses the WHOLE save (nothing written, the revision not advanced, the unrelated edit not written); no blob row is ever written for them; before 0009 the tool writes the blobs and the migration imports them', () => {
  const dir = tempDir('ntf-snap'); s6File(dir, { notifications: [ntf({ id: 'ntf-1', extra: 'kept' }), ntf({ id: 'ntf-2', ts: NOW - 9 * HOUR, actionRequired: { deadline: null, ackedAt: NOW, ackedBy: 'usr-1' } })], notificationPrefs: [pref()] });
  { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.notifications.map((n) => n.id), ['ntf-1', 'ntf-2']); assert.equal(snap.db.notifications[0].extra, 'kept'); assert.deepEqual(snap.db.notifications[1].actionRequired, { deadline: null, ackedAt: NOW, ackedBy: 'usr-1' });
  assert.deepEqual(snap.db.notificationPrefs, [pref()]);
  snap.db.notifications.push({ id: 'ntf-3', ts: NOW, audience: PLAYER, type: 'badge', text: 'B', refId: 'pl-adult', read: false }); // a legacy-shaped entry
  snap.db.notificationPrefs.push(pref({ audienceKind: 'player', audienceId: 'pl-adult', categories: { combine: false } }));
  tool.save(snap);
  assert.deepEqual(idsOf(dir), ['ntf-1', 'ntf-2', 'ntf-3']); assert.equal(rowsOf(dir, 'notifications', 'seq')[2].repeat_count, 1);
  assert.deepEqual(rowsOf(dir, 'notification_pref_categories').map((r) => [r.audience_id, r.category]), [['usr-1', 'mentions'], ['pl-adult', 'combine']]);
  assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('notifications', 'notificationPrefs')").get().n, 0, 'never a blob once the tables are live');
  // Omitted collections leave the tables alone.
  snap = tool.load(); delete snap.db.notifications; delete snap.db.notificationPrefs; snap.db.notes = [{ id: 'n' }]; tool.save(snap);
  assert.deepEqual(idsOf(dir), ['ntf-1', 'ntf-2', 'ntf-3']); assert.equal(rowsOf(dir, 'notification_prefs').length, 2);
  const before = dump(tool.sqlite); const seq = tool.revision();
  const refused = (label, mutate, re) => {
    const s2 = tool.load(); mutate(s2.db); s2.db.notes = [{ id: 'unrelated-change' }];
    assert.throws(() => tool.save(s2), re, label);
    assert.equal(tool.sqlite.isTransaction, false); assert.equal(dump(tool.sqlite), before, `${label}: nothing changed, the unrelated edit included`); assert.equal(tool.revision(), seq, `${label}: the revision did not advance`);
  };
  refused('a malformed entry', (d) => { d.notifications[0].ts = 'yesterday'; }, /NOTIFICATIONS_IMPORT_BLOCKED.*ts must be/);
  refused('a duplicate id', (d) => { d.notifications.push({ ...d.notifications[0] }); }, /duplicates the id/);
  refused('an unknown category', (d) => { d.notificationPrefs[0].categories.gossip = true; }, /categories\.gossip is not a notification category/);
  refused('a non-boolean preference', (d) => { d.notificationPrefs[0].categories.mentions = 'no'; }, /must be a boolean/);
  refused('a non-array notifications collection', (d) => { d.notifications = { id: 'x' }; }, /notifications: the snapshot collection must be an array/);
  refused('a non-array preferences collection', (d) => { d.notificationPrefs = null; }, /notificationPrefs: the snapshot collection must be an array/);
  tool.sqlite.close();
  // Before 0009: the blob, then the migration imports it (the restore path of a backup taken on any build).
  const pre = tempDir('ntf-snap-pre'); s6File(pre);
  const t2 = openStore(pre); const s3 = t2.load(); assert.equal(s3.db.notifications, undefined, 'nothing read before the record');
  s3.db.notifications = [ntf({ id: 'ntf-pre' })]; s3.db.notificationPrefs = [pref()]; t2.save(s3);
  assert.deepEqual(blob(t2.sqlite, 'notifications').map((n) => n.id), ['ntf-pre'], 'written as a blob'); t2.sqlite.close();
  { const s = openRaw(pre); migrate(s); assert.deepEqual(s.prepare('SELECT id FROM notifications').all().map((r) => r.id), ['ntf-pre']); s.close(); }
  rm(dir, pre);
});

// ============================================================= rollback (copy-only, to the pre-S7a build 812e13b)
test('rollback: the copy-only tool writes the notifications and notificationPrefs blobs the pre-S7a build reads — EVERY row, in insertion order, timestamps (refreshed and tied), repeat counts, acknowledgment contracts, unknown fields and the stored preferences exactly as they are — drops the three tables and the 0009 record, advances the revision, never touches the source, keeps every other table exactly; the real migration re-upgrades the copy to the same rows; the S6a tool refuses the S7a file (LATER_SCHEMA) and accepts the copy', () => {
  const src = tempDir('ntf-rb-src'); s6File(src, { notifications: [ntf({ id: 'ntf-1', extra: 'kept' })], notificationPrefs: [pref({ categories: { compliance: false, mentions: false } })] });
  { const s = openRaw(src); migrate(s); const r = bare(s); r.create({ audience: PLAYER, type: 'transition', text: 'After the cutover.', refId: 'trn-1', category: 'security_account', deferredPush: true, actionRequired: { deadline: NOW + HOUR }, at: NOW - 2 * HOUR });
    const tie = r.create({ audience: PLAYER, type: 'case', text: 'tie', refId: null, category: null, deferredPush: false, at: NOW - 2 * HOUR }); r.coalesce('ntf-1', { at: NOW + MIN }); r.ack(tie.id, PLAYER, { at: NOW }); r.updatePrefs('player', 'pl-adult', { categories: { combine: false }, emailIntent: true }); s.close(); }
  const expectedRows = (() => { const s = openRaw(src); try { return bare(s).exportRows(); } finally { s.close(); } })();
  const expectedPrefs = (() => { const s = openRaw(src); try { return bare(s).exportPrefs(); } finally { s.close(); } })();
  assert.equal(expectedRows.length, 3); assert.equal(expectedRows[0].ts, NOW + MIN, 'the first row carries the newest clock: the order is not the clock');
  const digest = filesDigest(src); const content = (() => { const s = openRaw(src); try { return dump(s); } finally { s.close(); } })();
  const out = tempDir('ntf-rb-out');
  const result = rollbackNotificationsCopy(dbFile(src), out, { now: NOW });
  assert.deepEqual(result.counts, { notifications: 3, notificationPrefs: 2 }); assert.equal(result.recordRemoved, true);
  assert.equal(filesDigest(src)['scoutbox.db'], digest['scoutbox.db'], 'the source main file is byte-identical');
  { const s = openRaw(src); assert.equal(dump(s), content, 'the source content is unchanged'); s.close(); }
  const o = openRaw(out);
  for (const t of NOTIFICATION_TABLES) assert.equal(tableExists(o, t), false, t);
  assert.equal(applied(o).includes(NOTIFICATIONS_MIGRATION), false); assert.equal(meta(o, NOTIFICATIONS_CUTOVER_META), undefined);
  assert.deepEqual(blob(o, 'notifications'), expectedRows, 'every row, in order, as the pre-S7a build reads it'); assert.deepEqual(blob(o, 'notificationPrefs'), expectedPrefs);
  assert.equal(legacyCoalesceTarget(blob(o, 'notifications'), ORG_USER, 'message', ntf().text, 'chan-1', NOW + 2 * MIN)?.id, 'ntf-1', 'the pre-S7a scan over the reconstructed blob finds what it found before');
  for (const t of ['players', 'guardians', 'orgs', 'sessions', 'org_users', 'guardian_children', 'pairing_codes', 'email_challenges']) assert.equal(JSON.stringify(o.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()), (() => { const s = openRaw(src); try { return JSON.stringify(s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()); } finally { s.close(); } })(), `${t} untouched`);
  assert.equal(Number(meta(o, 'saveSeq')), result.saveSeq);
  assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [NOTIFICATIONS_MIGRATION], 're-upgrade: 0009 runs again on the reconstructed blobs');
  assert.deepEqual(bare(o).exportRows(), expectedRows, 'and reproduces the rows'); assert.deepEqual(bare(o).exportPrefs(), expectedPrefs);
  o.close();
  const s6out = tempDir('ntf-rb-s6'); const s6out2 = tempDir('ntf-rb-s6b');
  assert.throws(() => rollbackOneTimeCodesCopy(dbFile(src), s6out), (err) => err.code === 'LATER_SCHEMA' && /0009_notifications/.test(err.message)); assert.deepEqual(fs.readdirSync(s6out), []);
  const out2 = tempDir('ntf-rb-out2'); rollbackNotificationsCopy(dbFile(src), out2, { now: NOW });
  assert.equal(rollbackOneTimeCodesCopy(dbFile(out2), s6out2).recordRemoved, true, 'the S6a tool accepts the S7a copy');
  rm(src, out, out2, s6out, s6out2);
});

test('rollback refusals leave no output and never touch the source: a later schema step (exit 4), a file that never applied 0009 (exit 5), a non-empty output directory (exit 1), a recorded 0009 whose tables are missing (exit 10), an injected COMMIT failure inside the tool; the CLI reports the counts', () => {
  const src = tempDir('ntf-rf-src'); s6File(src, { notifications: [ntf()] }); { const s = openRaw(src); migrate(s); s.close(); }
  const digest = filesDigest(src);
  const script = path.join(HERE, 'notificationsRollback.mjs');
  const run = (...a) => { try { return { status: 0, out: execFileSync(process.execPath, [script, ...a], { stdio: 'pipe', encoding: 'utf8' }) }; } catch (err) { return { status: err.status }; } };
  const later = tempDir('ntf-rf-later'); fs.copyFileSync(dbFile(src), dbFile(later)); { const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0010_future_step', 1)").run(); l.close(); }
  const o1 = tempDir('ntf-rf-o1'); assert.throws(() => rollbackNotificationsCopy(dbFile(later), o1), (e) => e.code === 'LATER_SCHEMA' && /0010_future_step/.test(e.message)); assert.deepEqual(fs.readdirSync(o1), []);
  assert.equal(run(later, path.join(tempDir('ntf-rf-c1'), 'x')).status, 4);
  const s6 = tempDir('ntf-rf-s6'); s6File(s6);
  const o2 = tempDir('ntf-rf-o2'); assert.throws(() => rollbackNotificationsCopy(dbFile(s6), o2), (e) => e.code === 'NOT_CUT_OVER'); assert.equal(run(s6, path.join(tempDir('ntf-rf-c2'), 'x')).status, 5);
  const o3 = tempDir('ntf-rf-o3'); fs.writeFileSync(path.join(o3, 'keep.txt'), 'x'); assert.throws(() => rollbackNotificationsCopy(dbFile(src), o3), (e) => e.code === 'OUTPUT_NOT_EMPTY'); assert.deepEqual(fs.readdirSync(o3), ['keep.txt']); assert.equal(run(src, o3).status, 1);
  const odd = tempDir('ntf-rf-odd'); fs.copyFileSync(dbFile(src), dbFile(odd)); { const d = openRaw(odd); d.exec('DROP TABLE notification_pref_categories'); d.close(); }
  const o4 = tempDir('ntf-rf-o4'); assert.throws(() => rollbackNotificationsCopy(dbFile(odd), o4), (e) => e.code === 'UNEXPECTED_SCHEMA' && /notification_pref_categories/.test(e.message)); assert.equal(run(odd, path.join(tempDir('ntf-rf-c4'), 'x')).status, 10);
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the S7a rollback tool'); } return exec.call(this, sql); };
  const o5 = tempDir('ntf-rf-o5');
  try { assert.throws(() => rollbackNotificationsCopy(dbFile(src), o5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.equal(fired, 1); assert.deepEqual(fs.readdirSync(o5), [], 'no usable partial output');
  const ok = run(src, path.join(tempDir('ntf-rf-ok'), 'copy'));
  assert.equal(ok.status, 0); assert.match(ok.out, /1 notification\(s\) and 0 preference record\(s\) written back as blobs/);
  assert.equal(ok.out.includes(ntf().text), false, 'the CLI never prints a notification text');
  assert.equal(filesDigest(src)['scoutbox.db'], digest['scoutbox.db'], 'the source was never touched');
  rm(src, later, s6, odd, o1, o2, o3, o4, o5);
});

console.log(`\n${passed} notification checks passed`);
