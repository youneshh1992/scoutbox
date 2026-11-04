// S7a — notifications and category notification preferences
// (repositories/notifications.mjs, migration 0009):
// the migration (first installation, reruns, prerequisites); the snapshot save
// (shapes, normalisation, refusals of malformed or duplicate entries); the
// repository (the durable insertion-order key, coalescing exactly as the
// reverse scan always did — one row, the six-hour boundary included, the stop
// at the first older-than-cutoff row — proven differentially against the
// verbatim pre-S7a algorithm; reads; mark-read; deletion; acknowledgment;
// preferences with a stored mandatory false that the effective view forces on);
// the two write modes (immediate: own transaction, joined unit, raw caller
// transaction; staged: the server's mode, where a standalone write lands in the
// next snapshot save together with the blobs it announces and a unit's writes
// land in the unit's commit); the snapshot dispatcher. Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import {
  createNotificationsRepository, validateNotificationRows, validateNotificationPrefsRows,
  NOTIFICATIONS_MIGRATION, NOTIFICATION_TABLES, NOTIFY_COALESCE_MS,
} from '../repositories/notifications.mjs';
import { createOutboxPushRepository } from '../repositories/outboxPush.mjs';
import { createDispatchesRepository } from '../repositories/dispatches.mjs';
import { registerNotificationPrefs, CATEGORY_NAMES } from '../domains/platform/notificationPrefs.mjs';
import { registerDelivery } from '../m13/delivery.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, freshFile, FIXTURE, ORGS, USERS, SESSIONS, openRaw, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
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

/**
 * A saved fixture: every migration applied and the fixture's staff, sessions,
 * organisations, players and guardians written through a snapshot-mode save
 * (the tables, never blobs). Notification collections given here go through
 * the same save, so a malformed one is refused by it.
 */
function s6File(dir, { notifications, notificationPrefs } = {}) {
  const db = { users: USERS(), sessions: SESSIONS(), orgs: ORGS(), ...FIXTURE(), requests: [], vouches: [], ledger: [] };
  if (notifications !== undefined) db.notifications = notifications;
  if (notificationPrefs !== undefined) db.notificationPrefs = notificationPrefs;
  const tool = openStore(dir);
  try { tool.save({ savedAt: NOW, idCounter: 1000, db }); } finally { tool.sqlite.close(); }
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
test('snapshot save: every notification is written with its id, fields, array position (the feed order) and acknowledgment contract; a pre-M18.2 row without repeatCount/groupKey/category/deferredPush is normalised exactly as the snapshot migration m182_005 did (repeatCount 1) and the other absent fields default; an unknown field is dropped; the preferences are written as given — a mandatory category stored false included; no blob row is written', () => {
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
  assert.deepEqual(s.prepare('SELECT seq, id FROM notifications ORDER BY seq').all().map((r) => [r.seq, r.id]), [[1, 'ntf-1'], [2, 'ntf-2'], [3, 'ntf-3'], [4, 'ntf-4']], 'the array position is the durable ordering key, whatever the timestamps');
  const r2 = s.prepare('SELECT * FROM notifications WHERE id = ?').get('ntf-2');
  assert.equal(r2.repeat_count, 1); assert.equal(r2.read, 1); assert.equal(r2.group_key, null); assert.equal(r2.category, null); assert.equal(r2.deferred_push, 0); assert.equal(r2.action_required, 0);
  const r3 = s.prepare('SELECT * FROM notifications WHERE id = ?').get('ntf-3');
  assert.equal(r3.action_required, 1); assert.equal(r3.action_deadline_at, NOW + 7 * 86_400_000); assert.equal(r3.action_acked_at, null); assert.equal(Object.hasOwn(r3, 'extra_json'), false, 'no side column');
  assert.equal(s.prepare('SELECT repeat_count FROM notifications WHERE id = ?').get('ntf-4').repeat_count, 3);
  assert.deepEqual(s.prepare('SELECT * FROM notification_prefs ORDER BY rowid').all().map((r) => ({ ...r })), [
    { audience_kind: 'org_user', audience_id: 'usr-1', email_intent: 0, updated_at: NOW - HOUR },
    { audience_kind: 'player', audience_id: 'pl-adult', email_intent: 1, updated_at: null },
  ]);
  assert.deepEqual(s.prepare('SELECT audience_id, category, enabled FROM notification_pref_categories ORDER BY rowid').all().map((r) => [r.audience_id, r.category, r.enabled]), [['usr-1', 'mentions', 0], ['pl-adult', 'compliance', 0], ['pl-adult', 'discovery_nudges', 1]], 'a stored mandatory false is written as given (the effective view forces it on; nothing is rewritten silently)');
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('notifications', 'notificationPrefs')").get().n, 0, 'no blob row');
  // The export reproduces the legacy shape, position for position, the unknown field dropped.
  const repo = bare(s);
  const exported = repo.exportRows();
  assert.deepEqual(exported.map((n) => n.id), ['ntf-1', 'ntf-2', 'ntf-3', 'ntf-4']);
  const { future: _dropped, ...known3 } = legacy[2];
  assert.deepEqual(exported[2], plain(known3));
  assert.deepEqual(exported[1], { ...legacy[1], repeatCount: 1, groupKey: null, category: null, deferredPush: false }, 'the normalised row in its exported shape');
  assert.deepEqual(exported[0], plain(legacy[0]));
  assert.deepEqual(repo.exportPrefs(), plain(prefs));
  s.close(); rm(dir);
});

test('migration 0009: a first installation creates the tables and imports nothing; a rerun is a no-op; 0008 must be recorded first; tables that exist without the record refuse the step', () => {
  const none = tempDir('ntf-mig-none'); s6File(none);
  let s = openRaw(none);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n + s.prepare('SELECT COUNT(*) AS n FROM notification_prefs').get().n, 0);
  assert.deepEqual(migrate(s, { now: NOW + 1 }).ran, [], 'a rerun does nothing'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(NOTIFICATIONS_MIGRATION).n, 1);
  s.close();
  const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW }).ran.includes(NOTIFICATIONS_MIGRATION)); for (const t of NOTIFICATION_TABLES) assert.ok(tableExists(mem, t), t); mem.close();
  // Prerequisite: 0008 first.
  const early = tempDir('ntf-mig-early'); freshFile(early);
  s = openRaw(early);
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < '0008' || m.id === NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }), /0009_notifications failed: 0009_notifications: 0008_one_time_codes must be recorded first/);
  assert.equal(tableExists(s, 'notifications'), false); s.close();
  // Tables without the record: refused, never guessed.
  const odd = tempDir('ntf-mig-odd'); freshFile(odd);
  s = openRaw(odd); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.exec('CREATE TABLE notification_prefs (x INTEGER) STRICT');
  assert.throws(() => migrate(s), /notification_prefs already exist without the migration record; refusing to guess/); s.close();
  rm(none, early, odd);
});

test('snapshot save refusals: a notification that is not an object, without an id, with a duplicate id, a non-integer ts, a missing or malformed audience, a missing type, a non-string text, a non-string refId, a non-boolean read, a repeatCount below 1, an unknown category, a malformed acknowledgment contract; a preference with an unknown field, an unknown category, a non-boolean value, a prototype-named category, a duplicate audience, a malformed audience; a collection that is not an array — each refuses the whole save with NOTIFICATIONS_IMPORT_BLOCKED (entry index and reason, never the text) and writes nothing: no player, no notification, no preference, no save revision', () => {
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
    ['a non-array notifications collection', { notifications: { id: 'x' } }, /notifications: the snapshot collection must be an array/],
    ['a non-array preferences collection', { notificationPrefs: 'none' }, /notificationPrefs: the snapshot collection must be an array/],
  ];
  for (const [label, blobs, re] of cases) {
    const dir = tempDir('ntf-refuse');
    let err = null; try { s6File(dir, blobs); } catch (e) { err = e; }
    assert.ok(err, `${label}: must refuse`); assert.match(err.message, re, `${label}: ${err.message}`);
    if (!/snapshot collection/.test(err.message)) assert.match(err.message, /NOTIFICATIONS_IMPORT_BLOCKED/, label);
    assert.equal(err.message.includes(SECRET), false, `${label}: the refusal never carries the notification text`);
    const s = openRaw(dir);
    for (const t of ['players', ...NOTIFICATION_TABLES]) assert.equal(s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${label}: nothing written to ${t}`);
    assert.equal(seqOf(dir), 0, `${label}: the save revision did not advance`);
    s.close(); rm(dir);
  }
  // The validators report the counts a caller may want and refuse without coercing.
  assert.deepEqual(validateNotificationRows([ntf(), { id: 'n2', ts: 1, audience: PLAYER, type: 't', text: '' }]).normalised, { read: 1, repeatCount: 1, groupKey: 1, category: 1, deferredPush: 1 });
  assert.throws(() => validateNotificationPrefsRows([pref({ emailIntent: 'yes' })]), /emailIntent must be a boolean/);
  assert.throws(() => validateNotificationPrefsRows([pref({ updatedAt: 1.5 })]), /updatedAt must be an integer timestamp, null or absent/);
});

// ============================================================= the repository: ordering, coalescing, reads
test('repository: the feed is reverse insertion order with a durable key — coalescing refreshes ts and counts the repeat WITHOUT moving the row, timestamps may tie, and the order survives a reopen; create returns the row in the shape every reader expects; the views and rows refuse writes', () => {
  const dir = tempDir('ntf-order'); s6File(dir);
  let s = openRaw(dir);
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
  const s = openRaw(dir);
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
  const boundary = tempDir('ntf-boundary'); s6File(boundary); const s2 = openRaw(boundary);
  const r2 = bare(s2, { now: () => NOW });
  const atSix = r2.create({ ...same, category: 'messages', deferredPush: false, at: NOW - NOTIFY_COALESCE_MS });
  assert.equal(r2.findCoalescible({ ...same, at: NOW })?.id, atSix.id, 'exactly six hours old is still coalescible');
  const r3dir = tempDir('ntf-boundary2'); s6File(r3dir); const s3 = openRaw(r3dir);
  const r3 = bare(s3, { now: () => NOW });
  r3.create({ ...same, category: 'messages', deferredPush: false, at: NOW - NOTIFY_COALESCE_MS - 1 });
  assert.equal(r3.findCoalescible({ ...same, at: NOW }), null, 'one millisecond older is not');
  // The stop: an unrelated row older than the cutoff AFTER a matching row hides it.
  const r4dir = tempDir('ntf-stop'); s6File(r4dir); const s4 = openRaw(r4dir);
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
  const s = openRaw(dir);
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
  const s = openRaw(dir);
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
  const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }); // 0010 too: registerDelivery needs the dispatches repository (S7b)
  const repo = bare(s); const dispatches = createDispatchesRepository({ sqlite: s, now: () => NOW }); const outboxPush = createOutboxPushRepository({ sqlite: s, now: () => NOW }); // S7c: registerDelivery needs the outbox repository too
  const router = { post() {}, get() {}, put() {} };
  let muted = false;
  const notify = (audience, type, text, refId = null, { actionRequired = null } = {}) => (muted ? null : repo.create({ audience, type, text, refId, category: 'security_account', deferredPush: false, actionRequired }));
  const ctx = { db: { dispatches: dispatches.view, notifications: repo.view, users: [], guardians: [], outbox: outboxPush.outbox.view }, notifications: repo, dispatches, outbox: outboxPush.outbox, users: [], app: { post() {} }, orgRouter: router, playerRouter: router, guardianRouter: router, adminRouter: router, nextId, persist() {}, persistNow() {}, notify, findPlayer: () => null, isAdult: () => true, signBody: () => '', timingSafeEq: () => false, paginate: (_r, x) => x, unit: (w) => w() };
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
const durable = (dir) => ({ ids: idsOf(dir), rows: rowsOf(dir, 'notifications', 'seq').map((r) => [r.id, r.occurred_at, r.repeat_count, r.read]), prefs: rowsOf(dir, 'notification_pref_categories').map((r) => [r.audience_id, r.category, r.enabled]), requests: blobOf(dir, 'vouches'), seq: seqOf(dir) });

test('staged mode (the server): a standalone create, coalesce, mark-read or preference write is visible in memory at once but is NOT durable ahead of the snapshot save that carries the blob edits made alongside it — the next save lands them together in ONE revision (independent connection); a failed save keeps them pending and the retry lands them; the write-ahead order of the file is the memory order', () => {
  const dir = tempDir('ntf-staged'); s6File(dir);
  const L = live(dir); L.save();
  const before = durable(dir);
  L.db.vouches.push({ id: 'req-announced', status: 'pending' }); // the action…
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
  try { L.store.unitOfWork(() => { L.db.vouches.push({ id: 'unrelated-edit', status: 'pending' }); try { work(); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  return { caught, outer };
};

test('staged mode inside a unit of work: the notification and the blob edit commit together in one revision; a failure after the write (thrown), a failure of the real COMMIT, a failure of the flush SQL itself (temporary trigger) and a caught validation failure each leave the file unchanged (independent connection), restore the feed, the row objects, the counts and the preferences in memory, keep the writes that were pending BEFORE the unit (landed by the next save), leave no transaction open; the retry lands everything; side effects registered for after the commit never run on a rollback', () => {
  const dir = tempDir('ntf-unit'); s6File(dir);
  const L = live(dir); L.save();
  const pre = L.notifications.create({ audience: ORG_USER, type: 'case', text: 'pending before the unit', refId: null, category: null, deferredPush: false }); // pending, not yet saved
  const seq0 = seqOf(dir); const memoryBefore = () => ({ ids: L.notifications.view.map((x) => x.id), requests: JSON.stringify(L.db.vouches), unread: L.notifications.unreadCount('org_user', 'usr-1'), prefs: plain(L.notifications.prefsView), pending: L.notifications.pending() });
  const m0 = memoryBefore();
  let effects = 0;
  const op = (fault) => L.store.unitOfWork(() => {
    L.db.vouches.push({ id: 'req-unit', status: 'pending' });
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
  assert.match(blobOf(dir, 'vouches'), /req-unit/); assert.deepEqual(durable(dir).prefs, [['usr-1', 'mentions', 0]]); assert.deepEqual(rowsOf(dir, 'notifications', 'seq').map((r) => r.read), [1, 1]);
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
  // Since the review of ba6956d (finding 2) an instance given the participant API joins a unit only once its save hook is registered: the hook is how the unit's rollback restores its memory.
  const tool = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit });
  L.store.setSaveHook(tool.saveHook());
  L.store.sqlite.exec("CREATE TEMP TRIGGER t_cat_ins BEFORE INSERT ON notification_pref_categories BEGIN SELECT RAISE(ABORT, 'injected category insert failure'); END");
  assert.throws(() => tool.updatePrefs('org_user', 'usr-9', { categories: { mentions: false }, emailIntent: true }), /injected category insert failure/);
  assert.equal(rowsOf(dir, 'notification_prefs').length, 0, 'standalone: the parent row went back with the failed category row'); assert.equal(L.store.sqlite.isTransaction, false);
  const before = durable(dir); const memoryBefore = JSON.stringify(L.db.vouches);
  const { caught, outer } = swallowing(L, () => tool.updatePrefs('org_user', 'usr-9', { categories: { mentions: false }, emailIntent: true }));
  assert.match(caught?.message ?? '', /injected category insert failure/); assert.ok(outer, 'the enclosing unit refused to commit'); assert.match(outer.message, /cannot commit.*injected category insert failure/s); assert.equal(outer.cause, caught); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(durable(dir), before); assert.equal(JSON.stringify(L.db.vouches), memoryBefore); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false);
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
test('boot: the data layer attaches to the tables as they are — an in-memory notifications or preferences array (the seed container, a stale copy) is never imported and no blob row holds it; intentionally empty live tables stay empty; a fixture without preferences and with rows lacking repeatCount boots; the report carries counts only', () => {
  const dir = tempDir('ntf-boot'); s6File(dir, { notifications: [ntf({ id: 'ntf-old' })] });
  let L = live(dir);
  assert.deepEqual(L.notifications.view.map((n) => n.id), ['ntf-old']); assert.deepEqual(L.warnings, []);
  assert.equal(Object.getOwnPropertyDescriptor(L.db, 'notifications').writable, false); assert.equal(Object.getOwnPropertyDescriptor(L.db, 'notificationPrefs').writable, false);
  L.close();
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, notifications: [ntf({ id: 'ntf-stale', text: 'STALE-TEXT' })], notificationPrefs: [pref()] };
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: (m) => warnings.push(m) });
  assert.equal(layer.notifications.byId('ntf-stale'), null, 'the stale array was not imported'); assert.deepEqual(db.notifications.map((n) => n.id), ['ntf-old']);
  assert.equal(store.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('notifications', 'notificationPrefs')").get().n, 0, 'no shadow blob');
  const report = JSON.stringify(layer.report());
  assert.match(report, /"notifications":\{"mode":"live","rows":\{"notifications":1,"notificationPrefs":0\}/); assert.doesNotMatch(report, /sent a message/);
  store.sqlite.close();
  // Intentionally empty live tables.
  const empty = tempDir('ntf-boot-empty'); s6File(empty, { notifications: [], notificationPrefs: [] });
  L = live(empty); assert.equal(L.notifications.count(), 0); L.close();
  L = live(empty, { db: { notifications: [ntf({ id: 'seed-row' })] } }); assert.equal(L.notifications.count(), 0, 'a seed array never initialises live tables'); L.close();
  // Pre-M18.2 rows.
  const old = tempDir('ntf-boot-old'); s6File(old, { notifications: [{ id: 'n1', ts: NOW - HOUR, audience: PLAYER, type: 'badge', text: 'Badge', refId: 'pl-adult', read: false }] });
  L = live(old); assert.equal(L.notifications.byId('n1').repeatCount, 1); assert.equal(L.notifications.prefsFor('player', 'pl-adult'), null); L.close();
  // The attach refuses without the record.
  const bad = tempDir('ntf-boot-bad'); s6File(bad);
  { const s = openRaw(bad); s.prepare('DELETE FROM data_migrations WHERE id = ?').run(NOTIFICATIONS_MIGRATION); s.close(); }
  assert.throws(() => live(bad), /already exist without the migration record/);
  rm(dir, empty, old, bad);
});

// ============================================================= snapshots (backups, restores, persistence suites)
test('snapshot dispatcher: a tool reads both collections in the legacy shape (position order, acknowledgment contracts; an unknown field dropped) and writes them back through the tables, an unknown field of a written entry not stored; a collection the snapshot omits leaves its table alone; a malformed entry, a duplicate id, an unknown category or a non-array collection or a wrong-typed field (named with the row id) refuses the WHOLE save (nothing written, the revision not advanced, the unrelated edit not written); no blob row is ever written for them', () => {
  const dir = tempDir('ntf-snap'); s6File(dir, { notifications: [ntf({ id: 'ntf-1', extra: 'kept' }), ntf({ id: 'ntf-2', ts: NOW - 9 * HOUR, actionRequired: { deadline: null, ackedAt: NOW, ackedBy: 'usr-1' } })], notificationPrefs: [pref()] });
  const tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.notifications.map((n) => n.id), ['ntf-1', 'ntf-2']); assert.equal(Object.hasOwn(snap.db.notifications[0], 'extra'), false, 'dropped at the save'); assert.deepEqual(snap.db.notifications[1].actionRequired, { deadline: null, ackedAt: NOW, ackedBy: 'usr-1' });
  assert.deepEqual(snap.db.notificationPrefs, [pref()]);
  snap.db.notifications.push({ id: 'ntf-3', ts: NOW, audience: PLAYER, type: 'badge', text: 'B', refId: 'pl-adult', read: false, futureField: { x: 1 } }); // a legacy-shaped entry with an unknown field
  snap.db.notificationPrefs.push(pref({ audienceKind: 'player', audienceId: 'pl-adult', categories: { combine: false } }));
  tool.save(snap);
  assert.deepEqual(idsOf(dir), ['ntf-1', 'ntf-2', 'ntf-3']); assert.equal(rowsOf(dir, 'notifications', 'seq')[2].repeat_count, 1);
  assert.equal(Object.hasOwn(tool.load().db.notifications[2], 'futureField'), false, 'an unknown field of a snapshot entry is not stored');
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
  refused('a wrong-typed field, named with the row id', (d) => { d.notifications[1].read = 'yes'; }, /NOTIFICATIONS_IMPORT_BLOCKED.*entry #1 \(ntf-2\): read must be a boolean/);
  refused('a duplicate id', (d) => { d.notifications.push({ ...d.notifications[0] }); }, /duplicates the id/);
  refused('an unknown category', (d) => { d.notificationPrefs[0].categories.gossip = true; }, /categories\.gossip is not a notification category/);
  refused('a non-boolean preference', (d) => { d.notificationPrefs[0].categories.mentions = 'no'; }, /must be a boolean/);
  refused('a non-array notifications collection', (d) => { d.notifications = { id: 'x' }; }, /notifications: the snapshot collection must be an array/);
  refused('a non-array preferences collection', (d) => { d.notificationPrefs = null; }, /notificationPrefs: the snapshot collection must be an array/);
  tool.sqlite.close();
  rm(dir);
});

// ============================================================= review of ba6956d: the three corrected findings
/** Make the REAL COMMIT of the next transaction on `s` fail: a deferred foreign key violated by a trigger on the notifications insert/update. */
function armCommitFailure(s, on = 'INSERT') {
  s.exec('CREATE TEMP TABLE IF NOT EXISTS rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  s.exec(`CREATE TEMP TRIGGER rv_commit_fail AFTER ${on} ON notifications BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END`);
  return () => s.exec('DROP TRIGGER rv_commit_fail');
}

test('an owned immediate transaction that fails restores the repository\'s memory, not only the rows: a failing INSERT (statement failure), a failing category insert after the parent upsert (multi-statement), a failing UPDATE under a coalesce (in-place mutation) and a REAL COMMIT failure each leave the mirror, the id index, the counts, the preferences and previously held read-only views exactly as before; the retry with the same id and with different preference values lands without any reload', () => {
  const dir = tempDir('ntf-rv-owned'); s6File(dir);
  const s = openRaw(dir);
  const repo = bare(s);
  const first = repo.create({ audience: ORG_USER, type: 'message', text: 'first', refId: 'chan-1', category: 'messages', deferredPush: false, at: NOW - MIN });
  repo.updatePrefs('org_user', 'usr-1', { categories: { mentions: false }, emailIntent: false });
  const prefView = repo.prefsFor('org_user', 'usr-1');
  const snapshot = () => ({ rows: plain(repo.exportRows()), prefs: plain(repo.exportPrefs()), counts: repo.counts(), unread: repo.unreadCount('org_user', 'usr-1'), feed: repo.forAudience('org_user', 'usr-1').map((n) => n.id), first: plain(first), pref: plain(prefView), byId: !!repo.byId(first.id), sql: s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n + s.prepare('SELECT COUNT(*) AS n FROM notification_pref_categories').get().n });
  const before = snapshot();
  // 1. A failing INSERT.
  s.exec("CREATE TEMP TRIGGER rv_ins BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  assert.throws(() => repo.create({ id: 'ntf-review-one', audience: PLAYER, type: 'message', text: 'Synthetic', refId: null, category: null, deferredPush: false }), /synthetic insert failure/);
  assert.deepEqual(snapshot(), before, 'after a failed insert: nothing in memory either'); assert.equal(repo.byId('ntf-review-one'), null); assert.equal(s.isTransaction, false);
  s.exec('DROP TRIGGER rv_ins');
  const retried = repo.create({ id: 'ntf-review-one', audience: PLAYER, type: 'message', text: 'Synthetic', refId: null, category: null, deferredPush: false });
  assert.equal(retried.id, 'ntf-review-one', 'the same id is accepted on the retry'); assert.equal(repo.count(), 2); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 2);
  const after1 = snapshot();
  // 2. A multi-statement preference write whose second statement fails.
  s.exec("CREATE TEMP TRIGGER rv_cat BEFORE INSERT ON notification_pref_categories BEGIN SELECT RAISE(ABORT, 'synthetic category failure'); END");
  assert.throws(() => repo.updatePrefs('org_user', 'usr-1', { categories: { mentions: true, combine: false }, emailIntent: true }), /synthetic category failure/);
  assert.deepEqual(snapshot(), after1, 'the preference record is exactly as before (emailIntent, categories, the held view)');
  assert.throws(() => repo.updatePrefs('org_user', 'usr-new', { categories: { combine: false } }), /synthetic category failure/);
  assert.equal(repo.prefsFor('org_user', 'usr-new'), null, 'a record the failed write would have created is gone from memory'); assert.equal(repo.prefsCount(), 1);
  s.exec('DROP TRIGGER rv_cat');
  repo.updatePrefs('org_user', 'usr-1', { categories: { mentions: true, combine: false }, emailIntent: true });
  assert.deepEqual(plain(prefView.categories), { mentions: true, combine: false }); assert.equal(prefView.emailIntent, true, 'the retry with different values lands on the held view');
  const after2 = snapshot();
  // 3. An in-place mutation (coalesce) whose UPDATE fails.
  s.exec("CREATE TEMP TRIGGER rv_upd BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'synthetic update failure'); END");
  assert.throws(() => repo.coalesce(first.id, { at: NOW, actionRequired: { deadline: NOW + HOUR } }), /synthetic update failure/);
  assert.deepEqual(snapshot(), after2, 'the row object the caller holds shows the old clock, count and no contract');
  assert.equal(first.repeatCount, 1); assert.equal(first.ts, NOW - MIN); assert.equal(first.actionRequired, undefined);
  assert.throws(() => repo.markRead('org_user', 'usr-1'), /synthetic update failure/); assert.equal(first.read, false); assert.equal(repo.unreadCount('org_user', 'usr-1'), 1);
  s.exec('DROP TRIGGER rv_upd');
  repo.coalesce(first.id, { at: NOW }); assert.equal(first.repeatCount, 2);
  const after3 = snapshot();
  // 4. A REAL COMMIT failure (deferred foreign key refused by the engine at COMMIT).
  const disarm = armCommitFailure(s, 'INSERT');
  assert.throws(() => repo.create({ id: 'ntf-review-two', audience: PLAYER, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }), /FOREIGN KEY constraint failed/);
  assert.deepEqual(snapshot(), after3, 'after a failed COMMIT: nothing in memory'); assert.equal(repo.byId('ntf-review-two'), null); assert.equal(s.isTransaction, false);
  disarm();
  assert.equal(repo.create({ id: 'ntf-review-two', audience: PLAYER, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }).id, 'ntf-review-two');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 3); assert.equal(repo.count(), 3);
  // The caller-owned raw transaction keeps its explicit contract (the repository cannot see that ROLLBACK): distinguished from the owned case above.
  s.exec('BEGIN'); const raw = repo.create({ audience: PLAYER, type: 'raw', text: 'raw', refId: null, category: null, deferredPush: false }); s.exec('ROLLBACK');
  assert.equal(repo.byId(raw.id)?.id, raw.id, 'a transaction the caller owns: the mirror cannot follow the caller\'s ROLLBACK'); repo.reload(); assert.equal(repo.byId(raw.id), null);
  s.close(); rm(dir);
});

test('joined units in immediate mode: a repository given the participant API refuses to join a unit until its save hook is registered with the store (the hook is how a rollback restores its memory); once registered, a failure the caller catches still poisons the unit and the rollback restores the mirror, the held views and the counts', () => {
  const dir = tempDir('ntf-rv-joined'); s6File(dir);
  const L = live(dir); L.save();
  const tool = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit });
  assert.throws(() => L.store.unitOfWork(() => tool.create({ audience: ORG_USER, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }), { snapshot: L.snapshot }), /save hook/);
  assert.equal(tool.count(), 0, 'nothing staged or written by the refused join'); assert.equal(L.store.unitOfWorkState().active, false);
  L.store.setSaveHook(tool.saveHook());
  const held = tool.create({ audience: ORG_USER, type: 'message', text: 'held', refId: 'c', category: 'messages', deferredPush: false, at: NOW - MIN });
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  const before = { rows: plain(tool.exportRows()), held: plain(held), counts: tool.counts() };
  const { caught, outer } = swallowing(L, () => { tool.create({ audience: PLAYER, type: 'x', text: 'y', refId: null, category: null, deferredPush: false }); tool.coalesce(held.id, { at: NOW }); });
  assert.match(caught?.message ?? '', /synthetic joined failure/); assert.ok(outer, 'the unit refused to commit'); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual({ rows: plain(tool.exportRows()), held: plain(held), counts: tool.counts() }, before, 'the mirror, the held row view and the counts are restored');
  assert.equal(rowsOf(dir, 'notifications').length, 1); assert.equal(L.store.sqlite.isTransaction, false);
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.close(); rm(dir);
});

test('effects wait for the durable write: in staged mode an effect registered with a pending write (the push, the SSE frame) runs only once the save that carries the write COMMITTED — never before the save, never after a failed save (statement or real COMMIT failure; the write and its effect stay pending for the retry), exactly once on the successful retry; an effect registered inside a unit of work is discarded with the unit\'s rollback while effects of writes pending BEFORE the unit survive and run when the next save or unit commits them; an effect that throws or rejects is counted and never fails the save; no effect schedules another save', () => {
  const dir = tempDir('ntf-rv-effects'); s6File(dir);
  const L = live(dir); L.save();
  const ran = []; const effect = (label) => () => { ran.push(label); };
  const seq0 = seqOf(dir);
  // A standalone write with its effect.
  const a = L.notifications.create({ audience: ORG_USER, type: 'message', text: 'a', refId: 'c', category: 'messages', deferredPush: false });
  L.notifications.afterDurable(effect('a:push')); L.notifications.afterDurable(effect('a:sse'));
  assert.deepEqual(ran, [], 'nothing before the save'); assert.equal(L.notifications.pendingEffects(), 2);
  // A failed save (statement failure) keeps the write and its effects pending.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/);
  assert.deepEqual(ran, [], 'nothing after a failed flush'); assert.equal(L.notifications.pending(), 1); assert.equal(L.notifications.pendingEffects(), 2); assert.equal(seqOf(dir), seq0);
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  // A failed save (real COMMIT failure) keeps them too.
  const disarm = armCommitFailure(L.store.sqlite, 'INSERT');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/);
  assert.deepEqual(ran, [], 'nothing after a failed COMMIT'); assert.equal(L.notifications.pendingEffects(), 2); assert.equal(idsOf(dir).length, 0);
  disarm();
  // The retry: once.
  L.save();
  assert.deepEqual(ran, ['a:push', 'a:sse'], 'exactly once, after the commit'); assert.equal(L.notifications.pendingEffects(), 0); assert.deepEqual(idsOf(dir), [a.id]);
  L.save(); assert.deepEqual(ran, ['a:push', 'a:sse'], 'a later save does not replay them');
  // Inside a unit: discarded with the rollback; a pre-unit pending effect survives and runs with the unit that commits it.
  const b = L.notifications.create({ audience: ORG_USER, type: 'message', text: 'b', refId: 'c', category: 'messages', deferredPush: false });
  L.notifications.afterDurable(effect('b:sse'));
  assert.throws(() => L.store.unitOfWork(() => { L.notifications.create({ audience: PLAYER, type: 'x', text: 'u', refId: null, category: null, deferredPush: false }); L.notifications.afterDurable(effect('u:sse')); throw new Error('unit failure'); }, { snapshot: L.snapshot }), /unit failure/);
  assert.deepEqual(ran, ['a:push', 'a:sse'], 'neither the unit\'s effect nor the pre-unit effect ran'); assert.equal(L.notifications.pendingEffects(), 1, 'the pre-unit effect is still pending'); assert.equal(L.notifications.pending(), 1); assert.ok(L.notifications.byId(b.id));
  L.store.unitOfWork(() => { L.notifications.create({ audience: PLAYER, type: 'x', text: 'v', refId: null, category: null, deferredPush: false }); L.notifications.afterDurable(effect('v:sse')); }, { snapshot: L.snapshot });
  assert.deepEqual(ran, ['a:push', 'a:sse', 'b:sse', 'v:sse'], 'the unit\'s commit carried the pre-unit write and delivered both effects, in order'); assert.equal(L.notifications.pendingEffects(), 0);
  // A throwing / rejecting effect never fails the save and is counted; no effect triggers another save.
  const flushes = []; L.store.setSaveHook({ flush: () => { flushes.push(1); } });
  const c = L.notifications.create({ audience: ORG_USER, type: 'message', text: 'c', refId: 'c', category: 'messages', deferredPush: false });
  L.notifications.afterDurable(() => { throw new Error('provider down'); }); L.notifications.afterDurable(() => Promise.reject(new Error('provider rejected'))); L.notifications.afterDurable(effect('c:ok'));
  const failuresBefore = L.store.unitOfWorkState().afterCommitFailures;
  L.save();
  assert.deepEqual(idsOf(dir).slice(-1), [c.id], 'the save committed'); assert.deepEqual(ran.slice(-1), ['c:ok'], 'the later effect still ran');
  assert.equal(flushes.length, 1, 'one save: an effect never schedules another'); assert.equal(seqOf(dir), seq0 + 4);
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() => { assert.equal(L.store.unitOfWorkState().afterCommitFailures, failuresBefore + 2, 'both failures counted, neither a rollback'); L.close(); rm(dir); });
});

test('the default immediate participant (factory default runEffect, store.unit given, save hook registered) defers an effect registered inside a unit of work to the unit\'s COMMIT report: nothing while the unit is active, nothing after a thrown abort, a caught operation failure or a real COMMIT failure (the effect is discarded with the unit), exactly once after a successful commit and never again; a throwing or rejecting effect is reported through warn and never undoes the committed data; a standalone owned write still runs its effect at once after its own commit; a caller-owned raw transaction still refuses', () => {
  const dir = tempDir('ntf-rv2-effects'); s6File(dir);
  const L = live(dir); L.save();
  const warnings = [];
  const tool = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit, warn: (m) => warnings.push(m) });
  L.store.setSaveHook(tool.saveHook());
  const ran = []; const effect = (label) => () => { ran.push(label); };
  const row = (text) => ({ audience: PLAYER, type: 'message', text, refId: null, category: null, deferredPush: false });
  // A thrown abort: nothing while active, nothing after.
  let whileActive = null;
  assert.throws(() => L.store.unitOfWork(() => { tool.create(row('a')); tool.afterDurable(effect('a')); whileActive = ran.length; throw new Error('synthetic abort'); }, { snapshot: L.snapshot }), /synthetic abort/);
  assert.equal(whileActive, 0, 'nothing while the unit is active'); assert.deepEqual(ran, [], 'nothing after the abort'); assert.equal(tool.count(), 0); assert.equal(tool.pendingEffects(), 0); assert.equal(idsOf(dir).length, 0);
  // A caught operation failure: the effect registered before it goes with the unit.
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv2_ins BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
  const { caught, outer } = swallowing(L, () => { tool.afterDurable(effect('b-before')); tool.create(row('b')); tool.afterDurable(effect('b-after')); });
  assert.match(caught?.message ?? '', /synthetic insert failure/); assert.equal(outer?.unitOfWork, 'rolled_back'); assert.deepEqual(ran, [], 'nothing after a caught failure'); assert.equal(tool.pendingEffects(), 0);
  L.store.sqlite.exec('DROP TRIGGER rv2_ins');
  // A real COMMIT failure.
  const disarm = armCommitFailure(L.store.sqlite, 'INSERT');
  assert.throws(() => L.store.unitOfWork(() => { tool.create(row('c')); tool.afterDurable(effect('c')); }, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/);
  disarm();
  assert.deepEqual(ran, [], 'nothing after a failed COMMIT'); assert.equal(tool.count(), 0); assert.equal(idsOf(dir).length, 0); assert.equal(L.store.sqlite.isTransaction, false);
  // Success: exactly once, after the commit, the held view intact; a later save never replays it.
  let beforeCommit = null; let held = null;
  L.store.unitOfWork(() => { held = tool.create(row('d')); tool.afterDurable(effect('d')); beforeCommit = ran.length; }, { snapshot: L.snapshot });
  assert.equal(beforeCommit, 0, 'not before the commit'); assert.deepEqual(ran, ['d'], 'exactly once after the commit'); assert.deepEqual(idsOf(dir), [held.id]); assert.equal(held.text, 'd'); assert.equal(tool.pendingEffects(), 0);
  L.save(); assert.deepEqual(ran, ['d'], 'a later save does not replay it');
  // A throwing and a rejecting effect: reported, the data stays committed, the later effect still runs.
  L.store.unitOfWork(() => { tool.create(row('e')); tool.afterDurable(() => { throw new Error('provider down'); }); tool.afterDurable(() => Promise.reject(new Error('provider rejected'))); tool.afterDurable(effect('e')); }, { snapshot: L.snapshot });
  assert.deepEqual(ran, ['d', 'e']); assert.equal(tool.count(), 2); assert.equal(idsOf(dir).length, 2); assert.equal(L.store.sqlite.isTransaction, false);
  // A standalone owned write (no unit): the effect runs at once, after its own commit.
  const own = tool.create(row('f')); tool.afterDurable(effect('f')); assert.deepEqual(ran.slice(-1), ['f']); assert.deepEqual(idsOf(dir).slice(-1), [own.id]);
  // A caller-owned raw transaction: still refused.
  L.store.sqlite.exec('BEGIN'); assert.throws(() => tool.afterDurable(effect('g')), /caller-owned transaction/); L.store.sqlite.exec('ROLLBACK');
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() => { assert.equal(warnings.filter((w) => /provider down|provider rejected/.test(w)).length, 2, 'both provider failures reported through warn'); L.close(); rm(dir); });
});

test('a participant precondition refused inside a unit of work is a participant FAILURE: an immediate or staged repository given store.unit but no registered save hook refuses a write (and an effect) THROUGH unit.join, so a caller that catches the refusal still cannot commit the unit — the unrelated edit is restored, SQLite, the revision and the mirror unchanged, no transaction open — and uncaught it fails the same way; after store.setSaveHook(repo.saveHook()) the same unit succeeds; outside a unit the standalone refusal (staged) and the own transaction (immediate) are unchanged', () => {
  const dir = tempDir('ntf-rv2-guard'); s6File(dir);
  const L = live(dir); L.save();
  const seq0 = seqOf(dir); const blob0 = blobOf(dir, 'vouches'); const mem0 = JSON.stringify(L.db.vouches);
  const imm = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit });
  const stg = createNotificationsRepository({ sqlite: L.store.sqlite, now: () => NOW, nextId, unit: L.store.unit, staged: true });
  const row = (text) => ({ audience: PLAYER, type: 'message', text, refId: null, category: null, deferredPush: false });
  const unchanged = (label) => { assert.equal(seqOf(dir), seq0, `${label}: the revision did not advance`); assert.equal(blobOf(dir, 'vouches'), blob0, `${label}: the requests blob is unchanged`); assert.equal(JSON.stringify(L.db.vouches), mem0, `${label}: the unrelated edit is restored in memory`); assert.equal(idsOf(dir).length, 0, `${label}: no row`); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.store.unitOfWorkState().active, false); };
  for (const [label, repo, work] of [['immediate write', imm, () => imm.create(row('guard'))], ['staged write', stg, () => stg.create(row('guard'))], ['staged effect', stg, () => stg.afterDurable(() => {})], ['immediate effect', imm, () => imm.afterDurable(() => {})]]) {
    const { caught, outer } = swallowing(L, work);
    assert.match(caught?.message ?? '', /save hook/, `${label}: the refusal was exercised`); assert.ok(outer, `${label}: the caught refusal still refuses the unit`); assert.equal(outer.unitOfWork, 'rolled_back'); assert.match(outer.message, /cannot commit.*save hook/s);
    unchanged(label); assert.equal(repo.count(), 0); assert.equal(repo.pending(), 0); assert.equal(repo.pendingEffects(), 0);
    assert.throws(() => L.store.unitOfWork(() => { L.db.vouches.push({ id: 'unrelated-edit' }); work(); }, { snapshot: L.snapshot }), /save hook/, `${label}: uncaught`);
    unchanged(`${label} (uncaught)`);
  }
  // Outside a unit: the staged instance refuses standalone, the immediate instance runs its own transaction.
  assert.throws(() => stg.create(row('standalone')), /save hook/); assert.throws(() => stg.afterDurable(() => {}), /save hook/);
  const own = imm.create(row('own')); assert.deepEqual(idsOf(dir), [own.id]); assert.equal(imm.deleteForAudience(PLAYER.kind, PLAYER.id), 1); assert.equal(idsOf(dir).length, 0);
  // The retry after proper registration: the same unit succeeds, the coupled edit and both writes in one revision.
  L.store.setSaveHook(imm.saveHook()); L.store.setSaveHook(stg.saveHook());
  const ran = [];
  L.store.unitOfWork(() => { L.db.vouches.push({ id: 'req-with-notification' }); imm.create(row('imm')); stg.create(row('stg')); stg.afterDurable(() => { ran.push('stg'); }); imm.afterDurable(() => { ran.push('imm'); }); }, { snapshot: L.snapshot });
  assert.equal(seqOf(dir), seq0 + 1); assert.equal(idsOf(dir).length, 2); assert.deepEqual(ran.sort(), ['imm', 'stg']); assert.ok(JSON.parse(blobOf(dir, 'vouches')).some((r) => r.id === 'req-with-notification'));
  L.close(); rm(dir);
});

test('unknown data is dropped, never stored: an own "__proto__" key and nested unknown fields on a legacy notification are dropped by the snapshot save (the prototype never touched); an audience or acknowledgment contract that carries a field this schema has no column for refuses the whole snapshot write before anything is written (saveSeq unchanged, diagnostic text-free)', () => {
  const SECRET = 'SECRET-TEXT-RV3';
  const special = JSON.parse('{"id":"ntf-proto","ts":1,"audience":{"kind":"player","id":"pl-adult"},"type":"message","text":"Synthetic","read":false,"__proto__":{"legacyMarker":"keep-me"},"nested":{"a":[1,{"b":null}]}}');
  const dir = tempDir('ntf-rv-extra'); s6File(dir, { notifications: [special, ntf({ id: 'ntf-plain' })] });
  const s = openRaw(dir);
  assert.doesNotMatch(JSON.stringify(rowsOf(dir, 'notifications')), /keep-me|legacyMarker|nested/, 'the unknown data is not stored');
  const repo = bare(s);
  const exported = repo.exportRows()[0];
  assert.equal(Object.hasOwn(exported, '__proto__'), false); assert.equal(Object.hasOwn(exported, 'nested'), false); assert.equal(Object.getPrototypeOf(exported), Object.prototype, 'the prototype itself was never touched');
  assert.deepEqual(Object.keys(exported), ['id', 'ts', 'audience', 'type', 'text', 'refId', 'read', 'repeatCount', 'groupKey', 'category', 'deferredPush']);
  s.close();
  // An audience with an unknown field: refused whole, nothing written.
  const bad = tempDir('ntf-rv-aud');
  let err = null; try { s6File(bad, { notifications: [ntf({ id: 'ntf-aud', text: SECRET, audience: { kind: 'org_user', id: 'usr-1', name: 'Maria' } })] }); } catch (e) { err = e; }
  assert.match(err?.message ?? '', /NOTIFICATIONS_IMPORT_BLOCKED.*entry #0 \(ntf-aud\): audience carries unknown field\(s\) name/); assert.equal(err.message.includes(SECRET), false);
  assert.equal(rowsOf(bad, 'notifications').length, 0); assert.equal(seqOf(bad), 0);
  const snapDir = tempDir('ntf-rv-aud-snap'); s6File(snapDir);
  const t2 = openStore(snapDir); const before = dump(t2.sqlite); const seq = t2.revision();
  const s2 = t2.load(); s2.db.notifications = [ntf({ id: 'n', audience: { kind: 'player', id: 'pl-adult', extra: 1 } })]; s2.db.notes = [{ id: 'unrelated' }];
  assert.throws(() => t2.save(s2), /audience carries unknown field\(s\) extra/); assert.equal(dump(t2.sqlite), before); assert.equal(t2.revision(), seq); t2.sqlite.close();
  assert.throws(() => validateNotificationRows([ntf({ actionRequired: { deadline: null, ackedAt: null, ackedBy: null, extra: true } })]), /actionRequired carries unknown field\(s\) extra/);
  rm(dir, bad, snapDir);
});

// ============================================================= review of ac50b60 — restores in place (the extras parts retired with extra_json, S8d fidelity rule)
test('a repository write inside an aborted unit and a real COMMIT failure leave the held view on the restored row; a reload (restart) and the snapshot dispatcher reproduce the stored row; coalescing, preferences and the acknowledgment work on a row a snapshot wrote; a wrong-typed or non-JSON value for a known field refuses the validation and the snapshot write whole, by row id and field, never the text', () => {
  const dir = tempDir('ntf-rv-extras');
  const legacy = { ...ntf({ id: 'ntf-x' }), category: 'messages', text: 'Synthetic.', actionRequired: { deadline: NOW + HOUR, ackedAt: null, ackedBy: null } };
  s6File(dir, { notifications: [legacy, ntf({ id: 'plain' })] });
  const L = live(dir); L.save();
  const held = L.notifications.byId('ntf-x');
  assert.deepEqual(plain(held), plain(legacy), 'the written row, as given');
  assert.throws(() => { held.audience.id = 'other'; }, /written through its domain repository/, 'the view refuses a nested write');
  // An aborted unit: a repository write inside it is restored, the held view included.
  assert.throws(() => L.store.unitOfWork(() => { L.notifications.coalesce('ntf-x', { at: NOW }); assert.equal(held.repeatCount, 2); throw new Error('synthetic abort'); }, { snapshot: L.snapshot }), /synthetic abort/);
  assert.equal(held.repeatCount, 1); assert.equal(L.notifications.pending(), 0);
  // A real COMMIT failure of a unit that marks the row read: the held view shows the restored row.
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER UPDATE ON notifications BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.store.unitOfWork(() => { L.notifications.markRead('org_user', 'usr-1'); }, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/);
  assert.equal(held.read, false); assert.deepEqual(plain(held), plain(legacy)); L.store.sqlite.exec('DROP TRIGGER rv_commit');
  L.notifications.reload(); assert.deepEqual(plain(L.notifications.byId('ntf-x')), plain(legacy), 'after a reload');
  const c = L.notifications.findCoalescible({ audience: ORG_USER, type: 'message', text: 'Synthetic.', refId: 'chan-1', at: NOW }); assert.equal(c?.id, 'ntf-x', 'the coalescing scan still finds the row');
  assert.deepEqual(L.notifications.ack('ntf-x', ORG_USER, { at: NOW + 1 }), { status: 'ok', ackedAt: NOW + 1, already: false });
  L.notifications.updatePrefs('org_user', 'usr-1', { categories: { mentions: false } }); assert.equal(L.notifications.prefsFor('org_user', 'usr-1').categories.mentions, false);
  L.save(); L.close();
  { const tool = openStore(dir); const snap = tool.load(); const before = plain(snap.db.notifications); tool.save(snap); assert.deepEqual(plain(tool.load().db.notifications), before, 'round-tripped through replace'); tool.sqlite.close(); }
  // Wrong-typed and non-JSON values for known fields refuse the whole write (nothing written).
  const SECRET = 'SECRET-TEXT-RV4';
  for (const [label, over, re] of [['a function as refId', { refId: () => 1 }, /\(bad\): refId must be a string/], ['a bigint ts', { ts: 1n }, /\(bad\): ts must be/], ['a non-finite repeatCount', { repeatCount: Number.POSITIVE_INFINITY }, /\(bad\): repeatCount must be/], ['a class instance as read', { read: new Date(0) }, /\(bad\): read must be a boolean/], ['a numeric-string deferredPush', { deferredPush: '1' }, /\(bad\): deferredPush must be a boolean/]]) {
    assert.throws(() => validateNotificationRows([ntf({ id: 'bad', text: SECRET, ...over })]), (e) => /NOTIFICATIONS_IMPORT_BLOCKED/.test(e.message) && re.test(e.message) && !e.message.includes(SECRET), label);
  }
  const bad = tempDir('ntf-rv-extras-bad'); s6File(bad, { notifications: [ntf({ id: 'ok' })] });
  { const tool = openStore(bad); const snap = tool.load(); const seq0 = tool.revision(); assert.throws(() => tool.save({ ...snap, db: { ...snap.db, notifications: [ntf({ id: 'bad', text: SECRET, groupKey: { f: 1 } })] } }), (e) => /\(bad\): groupKey must be/.test(e.message) && !e.message.includes(SECRET)); assert.equal(tool.revision(), seq0); assert.deepEqual(tool.load().db.notifications.map((n) => n.id), ['ok']); tool.sqlite.close(); }
  rm(dir, bad);
});

console.log(`\n${passed} notification checks passed`);
