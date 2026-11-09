// Notifications and category notification preferences as typed tables with explicit writes (repositories/
// notifications.mjs, migration 0009; explicit since S14e, docs/architecture/migration.md §4.6): the migration;
// fixtures written through the repository (typed, junk refused whole, a staff audience a key); the repository's writes (each joins the open unit
// of work or runs in its own transaction; junk refused by field) and its SQL reads (the feed in reverse insertion
// order, coalescing, the counts, the undispatched notices, preferences); units of work (a failure, a caught refusal or
// a real COMMIT failure leaves nothing); the M18.2 preference module over the repository; m13 notifyAction; the boot
// (no mirror, the old db.* names throw). Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createNotificationsRepository, feedItem, typeNotification, typeNotificationPrefs, NOTIFICATIONS_MIGRATION, NOTIFICATION_TABLES, NOTIFY_COALESCE_MS, NOTIFICATION_LIMITS } from '../repositories/notifications.mjs';
import { createOutboxPushRepository } from '../repositories/outboxPush.mjs';
import { createDispatchesRepository } from '../repositories/dispatches.mjs';
import { registerNotificationPrefs, CATEGORY_NAMES } from '../domains/platform/notificationPrefs.mjs';
import { createOperationsRepository } from '../repositories/operations.mjs';
import { registerDelivery } from '../m13/delivery.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, freshFile, FIXTURE, ORGS, USERS, SESSIONS, openRaw, dump, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const tableExists = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const plain = (v) => JSON.parse(JSON.stringify(v));
const fileDump = (dir) => { const s = new DatabaseSync(`${dir}/scoutbox.db`, { readOnly: true }); try { return dump(s); } finally { s.close(); } };
const STAFF = { kind: 'org_user', id: 'usr-1' };
const PLAYER = { kind: 'player', id: 'pl-adult' };
const TEXT = 'Eastport FC (Head of Recruitment) sent a message.';
/** A notification record in the shape the repository reads back. */
const ntf = (over = {}) => ({ id: 'ntf-a', ts: NOW - MIN, audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', read: false, repeatCount: 1, category: 'messages', deferredPush: false, ...over });
const pref = (over = {}) => ({ audienceKind: 'org_user', audienceId: 'usr-1', categories: { mentions: false }, emailIntent: false, updatedAt: NOW - HOUR, ...over });

const recordInvalid = (reason) => Object.assign(new Error(`NOTIFICATION_RECORD_INVALID: ${reason}`), { code: 'NOTIFICATION_RECORD_INVALID' });
/**
 * The fixture writers: a whole notification record typed (junk refused by field), then written the way the routes
 * write it (create, a coalesce per repeat, the acknowledgment, the delivery marker, markRead); a preference record
 * typed, then one updatePrefs. markRead reads the audience's whole feed, so a read record cannot follow an unread one
 * of the same audience.
 */
const WRITERS = {
  notifications: (L, records) => {
    const repo = L.notifications;
    for (const raw of records) {
      const v = typeNotification(raw); if (!v.ok) throw recordInvalid(v.reason);
      const r = v.row;
      if (r.read && repo.unreadCount(r.audience.kind, r.audience.id) > 0) throw new Error(`fixture: notification ${r.id} is read but an earlier one of its audience is not (markRead reads the whole feed)`);
      repo.create({ id: r.id, audience: r.audience, type: r.type, text: r.text, refId: r.refId, category: r.category, deferredPush: r.deferredPush, actionRequired: r.action ? { deadline: r.action.deadline } : null, at: r.ts });
      for (let i = 1; i < r.repeatCount; i++) repo.coalesce(r.id, { at: r.ts });
      if (r.action && r.action.ackedAt !== null) repo.ack(r.id, r.audience, { at: r.action.ackedAt });
      if (r.dispatchedAt !== null) repo.markDispatched(r.id, { at: r.dispatchedAt });
      if (r.read) repo.markRead(r.audience.kind, r.audience.id);
    }
  },
  notificationPrefs: (L, records) => {
    for (const raw of records) {
      const v = typeNotificationPrefs(raw); if (!v.ok) throw recordInvalid(v.reason);
      L.notifications.updatePrefs(v.row.audienceKind, v.row.audienceId, { categories: v.row.categories, emailIntent: v.row.emailIntent }, { at: v.row.updatedAt });
    }
  },
};
const write = (dir, collections) => writeFixture(dir, collections, { now: NOW, idCounter: 1000, writers: WRITERS });
/** A migrated file holding the fixture's staff, organisations, players and guardians, plus any notification collections given (written through the repositories). */
function fixtureFile(dir, { notifications, notificationPrefs } = {}) {
  const db = { users: USERS(), sessions: SESSIONS(), orgs: ORGS(), ...FIXTURE(), requests: [], ledger: [] };
  if (notifications !== undefined) db.notifications = notifications;
  if (notificationPrefs !== undefined) db.notificationPrefs = notificationPrefs;
  write(dir, db);
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
/** A server-mode store with the data layer attached, as the server runs it. */
function live(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, repo: layer.notifications, close: () => store.sqlite.close() };
}
const bare = (s) => createNotificationsRepository({ sqlite: s, now: () => NOW, nextId });

// ============================================================= the migration
test('migration 0009: a first installation creates the tables and imports nothing; a rerun is a no-op; 0008 must be recorded first; tables that exist without the record refuse the step', () => {
  const none = tempDir('ntf-mig-none'); fixtureFile(none);
  let s = openRaw(none);
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM notifications').get().n + s.prepare('SELECT COUNT(*) AS n FROM notification_prefs').get().n, 0);
  assert.deepEqual(migrate(s, { now: NOW + 1 }).ran, [], 'a rerun does nothing'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(NOTIFICATIONS_MIGRATION).n, 1);
  assert.equal(hasBlobTable(s), false);
  s.close();
  const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW }).ran.includes(NOTIFICATIONS_MIGRATION)); for (const t of NOTIFICATION_TABLES) assert.ok(tableExists(mem, t), t); mem.close();
  const early = tempDir('ntf-mig-early'); freshFile(early);
  s = openRaw(early);
  assert.throws(() => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < '0008' || m.id === NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } }), /0008_one_time_codes must be recorded first/);
  assert.equal(tableExists(s, 'notifications'), false); s.close();
  const odd = tempDir('ntf-mig-odd'); freshFile(odd);
  s = openRaw(odd); runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < NOTIFICATIONS_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.exec('CREATE TABLE notification_prefs (x INTEGER) STRICT');
  assert.throws(() => migrate(s), /notification_prefs already exist without the migration record; refusing to guess/); s.close();
  rm(none, early, odd);
});

// ============================================================= fixtures
test('fixtures: rows are written in array position (the feed order, whatever the timestamps) with their acknowledgment contracts; absent read, repeatCount, category, deferredPush and dispatchedAt take their defaults; groupKey and ackedBy are worked out on read, never stored; preferences are written as given (a stored mandatory false included); reading back gives the same records', () => {
  const dir = tempDir('ntf-snap');
  const rows = [
    ntf({ id: 'ntf-1', ts: NOW - 3 * HOUR }),
    { id: 'ntf-2', ts: NOW - 2 * HOUR, audience: PLAYER, type: 'badge', text: 'Badge earned: Regular.', refId: 'pl-adult', read: true },
    ntf({ id: 'ntf-3', ts: NOW - HOUR, type: 'transition', text: 'A pack was withdrawn.', refId: 'trn-1', category: 'security_account', actionRequired: { deadline: NOW + 7 * 86_400_000, ackedAt: NOW, ackedBy: 'usr-1' }, groupKey: 'transition:trn-1' }),
    ntf({ id: 'ntf-4', ts: NOW - 4 * HOUR, repeatCount: 3, refId: null, dispatchedAt: NOW - HOUR }),
  ];
  const prefs = [pref(), pref({ audienceKind: 'player', audienceId: 'pl-adult', categories: { compliance: false, discovery_nudges: true }, emailIntent: true })];
  fixtureFile(dir, { notifications: rows, notificationPrefs: prefs });
  const s = openRaw(dir);
  assert.deepEqual(s.prepare('SELECT seq, id FROM notifications ORDER BY seq').all().map((r) => [r.seq, r.id]), [[1, 'ntf-1'], [2, 'ntf-2'], [3, 'ntf-3'], [4, 'ntf-4']]);
  const r2 = s.prepare('SELECT * FROM notifications WHERE id = ?').get('ntf-2');
  assert.deepEqual([r2.repeat_count, r2.read, r2.category, r2.deferred_push, r2.dispatched_at, r2.action_required, r2.staff_id], [1, 1, null, 0, null, 0, null]);
  assert.equal(s.prepare('SELECT staff_id FROM notifications WHERE id = ?').get('ntf-1').staff_id, 'usr-1', 'a staff audience is keyed through the generated column');
  const back = readRecords(dir).notifications;
  assert.deepEqual(back.map((n) => n.groupKey), ['message:chan-1', 'badge:pl-adult', 'transition:trn-1', null], 'worked out from type and refId');
  assert.deepEqual(back[2].actionRequired, { deadline: NOW + 7 * 86_400_000, ackedAt: NOW, ackedBy: 'usr-1' });
  assert.deepEqual(back[1], { id: 'ntf-2', ts: NOW - 2 * HOUR, audience: PLAYER, type: 'badge', text: 'Badge earned: Regular.', refId: 'pl-adult', read: true, repeatCount: 1, groupKey: 'badge:pl-adult', category: null, deferredPush: false, dispatchedAt: null });
  assert.equal(back[3].dispatchedAt, NOW - HOUR);
  assert.deepEqual(s.prepare('SELECT audience_id, category, enabled FROM notification_pref_categories ORDER BY rowid').all().map((r) => [r.audience_id, r.category, r.enabled]), [['usr-1', 'mentions', 0], ['pl-adult', 'compliance', 0], ['pl-adult', 'discovery_nudges', 1]]);
  assert.deepEqual(plain(readRecords(dir).notificationPrefs), plain(prefs), 'the preferences read back as written');
  s.close(); rm(dir);
});

test('fixture refusals: an unknown field, a wrong-typed field, a duplicate id, an audience kind outside player/guardian/org_user, a staff audience that does not exist, an empty or over-long text, an unknown category, a group key that is not the worked-out one, an acknowledger who is not the audience; a preference with an unknown field, a non-boolean value, an unknown category or no updatedAt, or of a staff member that does not exist — each refuses the whole fixture, naming the entry and never the text, and writes nothing', () => {
  const dir = tempDir('ntf-fix-bad'); fixtureFile(dir, { notifications: [ntf({ id: 'ok' })], notificationPrefs: [pref()] });
  const SECRET = 'SECRET-TEXT-S14E';
  const before = fileDump(dir);
  // A valid notice goes first in each refused fixture: the whole unit rolls back, so it is not written either.
  const refuse = (db, re, label) => {
    assert.throws(() => write(dir, { ...db, notifications: [ntf({ id: 'ok-2' }), ...(db.notifications ?? [])] }), (e) => re.test(e.message) && !e.message.includes(SECRET), label);
    assert.equal(fileDump(dir), before, `${label}: nothing written`);
  };
  for (const [label, over, re] of [
    ['an unknown field', { future: { x: 1 } }, /notification bad: unknown field\(s\) future/],
    ['a string ts', { ts: String(NOW) }, /notification bad: ts must be/],
    ['a system audience', { audience: { kind: 'system', id: 'x' } }, /notification bad: audience\.kind must be one of player, guardian, org_user/],
    ['an audience with an extra field', { audience: { ...PLAYER, name: 'x' } }, /audience carries unknown field/],
    ['an empty text', { text: '' }, /notification bad: text must be text of 1 to 2000/],
    ['an over-long text', { text: SECRET + 'x'.repeat(2000) }, /notification bad: text must be text of 1 to 2000/],
    ['an unknown category', { category: 'gossip' }, /notification bad: category must be a notification category/],
    ['a numeric-string deferredPush', { deferredPush: '1' }, /notification bad: deferredPush must be a boolean/],
    ['a repeatCount of 0', { repeatCount: 0 }, /notification bad: repeatCount must be/],
    ['a group key not worked out', { groupKey: 'message:other' }, /notification bad: groupKey is worked out/],
    ['another acknowledger', { actionRequired: { deadline: null, ackedAt: NOW, ackedBy: 'usr-2' } }, /notification bad: actionRequired\.ackedBy/],
    ['an acknowledger without an acknowledgment', { actionRequired: { deadline: null, ackedAt: null, ackedBy: 'usr-1' } }, /notification bad: actionRequired\.ackedBy/],
  ]) refuse({ notifications: [ntf({ id: 'bad', text: SECRET, ...over })] }, new RegExp(`NOTIFICATION_RECORD_INVALID[\\s\\S]*${re.source}`), label);
  refuse({ notifications: [ntf({ id: 'dup' }), ntf({ id: 'dup' })] }, /NOTIFICATION_DUPLICATE: notifications dup already exists/, 'a duplicate id');
  refuse({ notifications: [ntf({ id: 'ghost', audience: { kind: 'org_user', id: 'usr-ghost' } })] }, /NOTIFICATIONS_STAFF_MISSING[\s\S]*usr-ghost/, 'a staff member that does not exist');
  for (const [label, over, re] of [
    ['an unknown field', { extra: 1 }, /unknown field\(s\) extra/],
    ['a numeric value', { categories: { mentions: 0 } }, /categories\.mentions must be a boolean/],
    ['an unknown category', { categories: { gossip: true } }, /categories\.gossip is not a notification category/],
    ['a prototype-named category', { categories: JSON.parse('{"__proto__": true}') }, /categories\.__proto__ is not a notification category/],
    ['no updatedAt', { updatedAt: null }, /updatedAt must be an integer timestamp/],
    ['a system audience', { audienceKind: 'system' }, /audienceKind \/ audienceId\.kind must be one of/],
  ]) refuse({ notificationPrefs: [pref(over)] }, re, `preference: ${label}`);
  refuse({ notificationPrefs: [pref({ audienceId: 'usr-ghost' })] }, /NOTIFICATIONS_STAFF_MISSING[\s\S]*usr-ghost/, 'a preference of a staff member that does not exist');
  rm(dir);
});

test('a staff member a notification names is a RESTRICT key: deleting the staff row is refused and nothing changes', () => {
  const dir = tempDir('ntf-fix-staff');
  fixtureFile(dir, { notifications: [ntf({ id: 'n-staff' })], notificationPrefs: [pref()] });
  const before = fileDump(dir);
  const s = openRaw(dir);
  try { assert.throws(() => s.prepare("DELETE FROM org_users WHERE id = 'usr-1'").run(), /FOREIGN KEY constraint failed/); } finally { s.close(); }
  assert.equal(fileDump(dir), before);
  rm(dir);
});

// ============================================================= the repository
test('writes and the feed: create appends to the feed; the feed is reverse insertion order (a coalesce refreshes the clock and counts the repeat without moving the row); records are fresh and frozen; feedItem is an allowlist (no delivery marker)', () => {
  const dir = tempDir('ntf-feed'); fixtureFile(dir); const s = openRaw(dir); const repo = bare(s);
  const a = repo.create({ audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', category: 'messages', at: NOW - 2 * MIN });
  const b = repo.create({ audience: STAFF, type: 'request', text: 'A trial request.', refId: 'req-1', at: NOW - MIN });
  repo.create({ audience: PLAYER, type: 'badge', text: 'Badge.', at: NOW - MIN });
  assert.deepEqual([a.repeatCount, a.read, a.groupKey, a.dispatchedAt], [1, false, 'message:chan-1', null]);
  const c = repo.coalesce(a.id, { at: NOW });
  assert.deepEqual([c.repeatCount, c.ts], [2, NOW]);
  assert.deepEqual(repo.forAudience('org_user', 'usr-1').map((n) => n.id), [b.id, a.id], 'the refreshed row keeps its place');
  assert.deepEqual(repo.forAudience('org_user', 'usr-1', { limit: 1 }).map((n) => n.id), [b.id]);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.audience)); assert.throws(() => { c.read = true; }, TypeError);
  assert.equal(Object.hasOwn(feedItem(c), 'dispatchedAt'), false);
  assert.deepEqual(Object.keys(feedItem(c)), ['id', 'ts', 'audience', 'type', 'text', 'refId', 'read', 'repeatCount', 'groupKey', 'category', 'deferredPush']);
  const act = repo.create({ audience: PLAYER, type: 'transition', text: 'Withdrawn.', refId: 'trn-1', actionRequired: { deadline: NOW + HOUR } });
  assert.deepEqual(plain(feedItem(act).actionRequired), { deadline: NOW + HOUR, ackedAt: null, ackedBy: null });
  s.close(); rm(dir);
});

test('coalescing: the newest identical unread row (same audience, type, text and refId) whose last occurrence is at most six hours old — exactly six hours included; an older one, a read one, another audience, another refId (null against a value included) or another text never coalesces', () => {
  const dir = tempDir('ntf-coalesce'); fixtureFile(dir); const s = openRaw(dir); const repo = bare(s);
  const find = (over = {}) => repo.findCoalescible({ audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', at: NOW, ...over })?.id ?? null;
  assert.equal(find(), null, 'an empty feed');
  const old = repo.create({ id: 'old', audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', at: NOW - NOTIFY_COALESCE_MS - 1 });
  assert.equal(find(), null, 'one millisecond past six hours');
  const edge = repo.create({ id: 'edge', audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', at: NOW - NOTIFY_COALESCE_MS });
  assert.equal(find(), 'edge', 'exactly six hours is included');
  repo.create({ id: 'newer', audience: STAFF, type: 'message', text: TEXT, refId: 'chan-1', at: NOW - 2 * HOUR });
  assert.equal(find(), 'newer', 'the newest identical row');
  repo.coalesce(old.id, { at: NOW - MIN }); // an old row refreshed: its last occurrence is recent again
  assert.equal(find(), 'newer', 'still the newest insertion among the rows inside the window');
  repo.create({ id: 'other-audience', audience: { kind: 'org_user', id: 'usr-1' }, type: 'message', text: TEXT, refId: null, at: NOW });
  assert.equal(find(), 'newer', 'a null refId never matches a value'); assert.equal(find({ refId: null }), 'other-audience', 'and a null refId matches a null one');
  assert.equal(find({ audience: PLAYER }), null, 'another audience'); assert.equal(find({ text: 'Other.' }), null, 'another text'); assert.equal(find({ type: 'request' }), null, 'another type');
  repo.markRead('org_user', 'usr-1');
  assert.equal(find(), null, 'a read row never coalesces');
  assert.equal(edge.id, 'edge');
  s.close(); rm(dir);
});

test('reads and the other writes: unread and awaiting-acknowledgment counts; mark-read for one audience only (returns the count); acknowledgment statuses (not_found for another audience, no_action, ok, already) and its durable column; deletion of one audience\'s rows (preferences kept); the delivery marker and the undispatched notices by cursor', () => {
  const dir = tempDir('ntf-reads'); fixtureFile(dir); const s = openRaw(dir); const repo = bare(s);
  repo.create({ id: 'n1', audience: STAFF, type: 'message', text: 'One.' });
  repo.create({ id: 'n2', audience: PLAYER, type: 'badge', text: 'Two.' });
  repo.create({ id: 'n3', audience: PLAYER, type: 'transition', text: 'Three.', refId: 'trn-1', actionRequired: { deadline: NOW + HOUR } });
  repo.updatePrefs('player', 'pl-adult', { categories: { combine: false } });
  assert.equal(repo.unreadCount('player', 'pl-adult'), 2); assert.equal(repo.unreadCount('org_user', 'usr-1'), 1); assert.equal(repo.awaitingAckCount(), 1);
  assert.equal(repo.markRead('player', 'pl-adult'), 2); assert.equal(repo.markRead('player', 'pl-adult'), 0);
  assert.equal(repo.unreadCount('org_user', 'usr-1'), 1, 'another audience is untouched');
  assert.deepEqual(repo.ack('n3', STAFF), { status: 'not_found' }, 'another audience cannot acknowledge');
  assert.deepEqual(repo.ack('n2', PLAYER), { status: 'no_action' });
  assert.deepEqual(repo.ack('n3', PLAYER, { at: NOW + 1 }), { status: 'ok', ackedAt: NOW + 1, already: false });
  assert.deepEqual(repo.ack('n3', PLAYER, { at: NOW + 2 }), { status: 'ok', ackedAt: NOW + 1, already: true }, 'the first acknowledgment stands');
  assert.deepEqual(plain(repo.byId('n3').actionRequired), { deadline: NOW + HOUR, ackedAt: NOW + 1, ackedBy: 'pl-adult' }); assert.equal(repo.awaitingAckCount(), 0);
  assert.deepEqual(repo.undispatched().map((x) => x.notification.id), ['n1', 'n2', 'n3']);
  const page = repo.undispatched({ limit: 2 }); assert.deepEqual(page.map((x) => x.notification.id), ['n1', 'n2']);
  assert.deepEqual(repo.undispatched({ afterSeq: page[1].seq }).map((x) => x.notification.id), ['n3'], 'the cursor continues after a page');
  assert.equal(repo.markDispatched('n2', { at: NOW }).dispatchedAt, NOW); assert.equal(repo.markDispatched('n2', { at: NOW + 9 }).dispatchedAt, NOW, 'the first marker stands');
  assert.deepEqual(repo.undispatched().map((x) => x.notification.id), ['n1', 'n3']);
  assert.throws(() => repo.markDispatched('nope'), /NOTIFICATION_NOT_FOUND/);
  assert.equal(repo.deleteForAudience('player', 'pl-adult'), 2); assert.deepEqual(repo.forAudience('player', 'pl-adult'), []); assert.equal(repo.byId('n1').id, 'n1');
  assert.deepEqual(plain(repo.prefsFor('player', 'pl-adult').categories), { combine: false }, 'the preferences are kept');
  assert.deepEqual(repo.counts(), { notifications: 1, notificationPrefs: 1 });
  s.close(); rm(dir);
});

test('junk is refused by field and nothing is written: an audience kind outside the vocabulary, an audience with an extra field, a staff member that does not exist, an empty or over-long text, an over-long type, a non-text refId, an unknown category, a non-boolean deferredPush, a malformed contract, a duplicate id; a preference with a non-boolean value or an unknown category; a coalesce of an unknown row', () => {
  const dir = tempDir('ntf-junk'); fixtureFile(dir); const s = openRaw(dir); const repo = bare(s);
  const base = { audience: PLAYER, type: 'badge', text: 'Badge.' };
  repo.create({ ...base, id: 'taken' });
  const before = dump(s);
  for (const [label, over, re] of [
    ['a system audience', { audience: { kind: 'system', id: 'x' } }, /NOTIFICATION_RECORD_INVALID: a notification's audience\.kind must be one of/],
    ['an extra audience field', { audience: { ...PLAYER, name: 'x' } }, /audience carries unknown field/],
    ['a staff member that does not exist', { audience: { kind: 'org_user', id: 'usr-ghost' } }, /NOTIFICATIONS_STAFF_MISSING: .*org_users usr-ghost/],
    ['an empty text', { text: '' }, /text must be text of 1 to 2000/],
    ['an over-long text', { text: 'x'.repeat(NOTIFICATION_LIMITS.text + 1) }, /text must be text of 1 to 2000/],
    ['an over-long type', { type: 'x'.repeat(81) }, /type must be text of 1 to 80/],
    ['a numeric refId', { refId: 7 }, /refId must be text/],
    ['an unknown category', { category: 'gossip' }, /category must be a notification category/],
    ['a string deferredPush', { deferredPush: 'no' }, /deferredPush must be a boolean/],
    ['a malformed contract', { actionRequired: { deadline: 'soon' } }, /actionRequired\.deadline must be/],
    ['a contract with an extra field', { actionRequired: { deadline: null, ackedAt: NOW } }, /actionRequired must be \{ deadline \}/],
    ['a duplicate id', { id: 'taken' }, /NOTIFICATION_DUPLICATE/],
  ]) { assert.throws(() => repo.create({ ...base, ...over }), re, label); assert.equal(dump(s), before, `${label}: nothing written`); }
  assert.throws(() => repo.updatePrefs('player', 'pl-adult', { categories: { mentions: 0 } }), /categories\.mentions must be a boolean/);
  assert.throws(() => repo.updatePrefs('player', 'pl-adult', { categories: { gossip: true } }), /not a notification category/);
  assert.throws(() => repo.updatePrefs('player', 'pl-adult', { emailIntent: 1 }), /emailIntent must be a boolean/);
  assert.throws(() => repo.updatePrefs('org_user', 'usr-ghost', { categories: {} }), /NOTIFICATIONS_STAFF_MISSING/);
  assert.throws(() => repo.coalesce('nope'), /NOTIFICATION_NOT_FOUND/);
  assert.equal(dump(s), before);
  s.close(); rm(dir);
});

test('units of work: a notification, a coalesce, a mark-read, an acknowledgment and a preference written inside a unit commit with it; a thrown failure, a caught refusal and a failure of the real COMMIT leave none of them (independent connection); a read inside the unit sees its writes', () => {
  const dir = tempDir('ntf-unit'); fixtureFile(dir, { notifications: [ntf({ id: 'n-old', actionRequired: { deadline: null, ackedAt: null, ackedBy: null } })] });
  const L = live(dir);
  const committed = () => { const s = new DatabaseSync(`${dir}/scoutbox.db`, { readOnly: true }); try { return dump(s); } finally { s.close(); } };
  const before = committed();
  const work = () => {
    const n = L.repo.create({ id: 'n-new', audience: PLAYER, type: 'badge', text: 'Badge.' });
    L.repo.coalesce('n-old', { at: NOW });
    L.repo.markRead('org_user', 'usr-1');
    L.repo.ack('n-old', STAFF, { at: NOW });
    L.repo.updatePrefs('org_user', 'usr-1', { categories: { mentions: false } }, { at: NOW });
    assert.equal(L.repo.byId('n-new').id, n.id, 'a read inside the unit sees its writes'); assert.equal(L.repo.byId('n-old').repeatCount, 2);
  };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }), /synthetic unit failure/); assert.equal(committed(), before, 'thrown: nothing');
  let outer = null;
  try { L.store.unitOfWork(() => { work(); try { L.repo.create({ audience: { kind: 'system', id: 'x' }, type: 't', text: 'x' }); } catch { /* caught on purpose */ } }); } catch (e) { outer = e; }
  assert.ok(outer, 'a caught refusal inside the unit still refuses the unit'); assert.equal(committed(), before, 'caught: nothing');
  assert.throws(() => L.store.unitOfWork(() => { work(); L.store.failCommitOfOpenTransaction(); }), /FOREIGN KEY constraint failed/); assert.equal(committed(), before, 'real COMMIT failure: nothing');
  assert.equal(L.repo.byId('n-new'), null, 'and no memory to restore: the repository reads the table');
  L.store.unitOfWork(work);
  assert.notEqual(committed(), before);
  assert.equal(L.repo.byId('n-old').actionRequired.ackedAt, NOW); assert.equal(L.repo.prefsFor('org_user', 'usr-1').categories.mentions, false);
  L.close(); rm(dir);
});

// ============================================================= the preference module and notifyAction
test('preferences through the real M18.2 module over the repository: defaults are the module\'s, a stored row overrides them, a stored mandatory false is forced ON by the effective view and the gate, the route refuses a non-boolean value (numeric zero included), an unknown category, a literal false on a mandatory category and a non-object, an unknown type is delivered, and a preference is keyed by kind AND id', () => {
  const dir = tempDir('ntf-prefs'); fixtureFile(dir, { notificationPrefs: [pref({ audienceKind: 'guardian', audienceId: 'g-1', categories: { combine: false, security_account: false } })] });
  const s = openRaw(dir); const repo = bare(s);
  const routes = {}; const stubFor = (prefix) => ({ get(p, h) { routes[`get ${prefix}${p}`] = h; }, put(p, h) { routes[`put ${prefix}${p}`] = h; } });
  const { allows, effective } = registerNotificationPrefs({ notifications: repo, orgRouter: stubFor('/org'), playerRouter: stubFor('/player'), guardianRouter: stubFor('/guardian') });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const put = (body) => { const r = res(); routes['put /org/notification-preferences']({ orgUser: { id: 'usr-1' }, body }, r); return r; };
  assert.equal(allows(STAFF, 'recruitment_room', 'Maria mentioned you'), true, 'a mention is delivered by default');
  let r = put({ categories: { mentions: false, compliance: 0 } }); assert.equal(r.code, 400); assert.equal(r.body.error, 'PREFS_INVALID'); assert.equal(r.body.category, 'compliance');
  assert.equal(repo.prefsFor('org_user', 'usr-1'), null, 'a refused write stores nothing');
  r = put({ categories: { mentions: false } }); assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(allows(STAFF, 'recruitment_room', 'Maria mentioned you'), false, 'mentions are off');
  assert.equal(allows({ kind: 'org_user', id: 'usr-2' }, 'recruitment_room', 'x'), true, 'isolation');
  assert.equal(allows(STAFF, 'regulatory_review_required', 'x'), true, 'the mandatory category is delivered');
  assert.equal(effective('guardian', 'g-1').categories.security_account, true, 'a stored false on a mandatory category is forced on'); assert.equal(repo.prefsFor('guardian', 'g-1').categories.security_account, false, 'and never rewritten');
  assert.equal(allows({ kind: 'guardian', id: 'g-1' }, 'combine', 'x'), false); assert.equal(allows({ kind: 'player', id: 'g-1' }, 'combine', 'x'), true, 'kind AND id');
  assert.equal(allows(STAFF, 'never_seen_type', 'x'), true, 'an unknown type is delivered');
  for (const [body, code] of [[{ categories: { compliance: false } }, 'PREF_CATEGORY_MANDATORY'], [{ categories: { gossip: true } }, 'PREF_CATEGORY_UNKNOWN'], [{ categories: [] }, 'PREFS_INVALID'], [{ categories: { mentions: 'yes' } }, 'PREFS_INVALID'], [{ emailIntent: 1 }, 'PREFS_INVALID']]) {
    r = put(body); assert.equal(r.code, 400, JSON.stringify(body)); assert.equal(r.body.error, code, JSON.stringify(body));
  }
  r = put({ emailIntent: true }); assert.equal(r.code, 200); assert.equal(repo.prefsFor('org_user', 'usr-1').emailIntent, true); assert.deepEqual(plain(repo.prefsFor('org_user', 'usr-1').categories), { mentions: false }, 'a write without categories keeps the stored ones');
  assert.throws(() => registerNotificationPrefs({ orgRouter: stubFor('/x'), playerRouter: stubFor('/x'), guardianRouter: stubFor('/x') }), /needs the notifications repository/);
  assert.ok(CATEGORY_NAMES.includes('security_account'));
  s.close(); rm(dir);
});

test('m13 notifyAction: a muted notification (the gate returned null) yields null instead of crashing, and an allowed one carries the acknowledgment contract', () => {
  const dir = tempDir('ntf-action'); fixtureFile(dir);
  const s = openRaw(dir);
  const repo = bare(s); const dispatches = createDispatchesRepository({ sqlite: s, now: () => NOW }); const outboxPush = createOutboxPushRepository({ sqlite: s, now: () => NOW });
  const router = { post() {}, get() {}, put() {} };
  let muted = false;
  const notify = (audience, type, text, refId = null, { actionRequired = null } = {}) => (muted ? null : repo.create({ audience, type, text, refId, category: 'security_account', deferredPush: false, actionRequired }));
  const ctx = { notifications: repo, dispatches, outbox: outboxPush.outbox, users: [], app: { post() {} }, orgRouter: router, playerRouter: router, guardianRouter: router, adminRouter: router, nextId, persist() {}, persistNow() {}, notify, findPlayer: () => null, isAdult: () => true, signBody: () => '', timingSafeEq: () => false, unit: (w) => w(), operations: createOperationsRepository({ sqlite: s, now: () => NOW }) };
  const saveInterval = globalThis.setInterval; globalThis.setInterval = () => ({ unref() {} });
  try { registerDelivery(ctx); } finally { globalThis.setInterval = saveInterval; }
  const n = ctx.notifyAction(STAFF, 'transition', 'Withdrawn.', 'trn-1', NOW + HOUR);
  assert.deepEqual(plain(n.actionRequired), { deadline: NOW + HOUR, ackedAt: null, ackedBy: null });
  muted = true;
  assert.equal(ctx.notifyAction(STAFF, 'transition', 'Withdrawn.', 'trn-1', NOW + HOUR), null, 'muted: null, no throw');
  s.close(); rm(dir);
});

// ============================================================= the boot
test('boot: no mirror — db.notifications and db.notificationPrefs throw, naming the repository; an array handed in on db is never imported; the report carries counts only; the attach refuses tables without the migration record', () => {
  const dir = tempDir('ntf-boot'); fixtureFile(dir, { notifications: [ntf({ id: 'ntf-old' })] });
  const L = live(dir);
  assert.equal(L.repo.byId('ntf-old').id, 'ntf-old');
  const report = JSON.stringify(L.layer.report());
  assert.match(report, /"notifications":\{"mode":"live","rows":\{"notifications":1,"notificationPrefs":0\},"pendingWrites":0/); assert.doesNotMatch(report, /sent a message/);
  L.close();
  const bad = tempDir('ntf-boot-bad'); fixtureFile(bad);
  { const s = openRaw(bad); s.prepare('DELETE FROM data_migrations WHERE id = ?').run(NOTIFICATIONS_MIGRATION); s.close(); }
  assert.throws(() => live(bad), /already exist without the migration record/);
  rm(dir, bad);
});

console.log(`\n${passed} notification checks passed`);
