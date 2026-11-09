// Delivery dispatches as typed tables with explicit writes (repositories/dispatches.mjs, migration 0010; explicit since
// S14d): the schema (vocabulary and length CHECKs, the staff audience's organisation as a deferred RESTRICT key, the
// total attempt-shape CHECK, the unique provider message id, the address of an e-mail dispatch that is not skipped);
// the repository's writes (create, recordAttempt, patch: typed input, unknown fields and wrong types refused by field
// and id) and SQL reads (fresh frozen records, the sweep's queries, the organisation's page newest first, the
// counts); units of work (all or nothing, no mirror and no db.dispatches); fixtures written through the repository.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';
import { createDispatchesRepository, DISPATCH_STATUSES } from '../repositories/dispatches.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, FIXTURE, ORGS, USERS, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, sql) => { const s = second(dir); try { return s.prepare(sql).all().map((r) => ({ ...r })); } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));

/** The record the sweep creates for an e-mail to the fixture's staff member usr-1 of org-pro. */
const email = (over = {}) => ({
  id: `dsp-${++counter}`, notificationId: 'ntf-1', audience: { kind: 'org_user', id: 'usr-1' }, orgId: 'org-pro',
  channel: 'email', to: 'maria@eastport.example', provider: 'local-fake', status: 'queued', skipReason: null, providerMessageId: null,
  attempts: [], nextAt: NOW, actionDeadline: null, createdAt: NOW, deliveredAt: null, openedAt: null, actionedAt: null, failedAt: null, failReason: null, ...over,
});
const inApp = (over = {}) => email({ channel: 'in_app', to: 'org_user:usr-1', provider: 'in_app', status: 'delivered', deliveredAt: NOW, ...over });
const forPlayer = (over = {}) => email({ audience: { kind: 'player', id: 'pl-adult' }, orgId: null, to: 'adult@example.test', ...over });

/** A fully migrated file holding the fixture's identity, organisation and staff (written through the repositories). */
function fixtureFile(dir, extra = {}) { writeFixture(dir, { ...FIXTURE(), orgs: ORGS(), users: USERS(), ...extra }, { now: NOW, idCounter: 1000 }); }
/** A live server-mode store with the data layer attached, as the server runs it. */
function live(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, repo: layer.dispatches, close: () => store.sqlite.close() };
}
const bare = (s) => createDispatchesRepository({ sqlite: s, now: () => NOW });
const refuses = (fn, re) => assert.throws(fn, re);

// ============================================================= the schema
test('the schema: a staff audience\'s organisation is the one key (RESTRICT, deferred to COMMIT); the notification and the audience carry none; channel, provider, status and audience kind are vocabulary CHECKs; an e-mail dispatch that is not skipped carries its address, a skipped one its reason; the attempt-shape CHECK is total; a provider message id is unique; STRICT, no side column, no blob', () => {
  const dir = tempDir('dsp-schema'); fixtureFile(dir); const s = openRaw(dir);
  assert.equal(hasBlobTable(s), false);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_list(dispatches)').all().map((k) => [k.from, k.table, k.on_delete]), [['org_id', 'orgs', 'RESTRICT']]);
  assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE name = 'dispatches'").get().sql, /DEFERRABLE INITIALLY DEFERRED/);
  for (const t of ['dispatches', 'dispatch_attempts']) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/);
    assert.deepEqual(s.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /_json$/.test(c.name)), []);
  }
  const ins = (over = {}) => s.prepare('INSERT INTO dispatches (id, notification_id, audience_kind, audience_id, org_id, channel, to_address, provider, status, skip_reason, next_at, created_at, delivered_at) VALUES (@id, @n, @ak, @ai, @org, @ch, @to, @pr, @st, @sk, 1, 1, @da)')
    .run({ id: `raw-${++counter}`, n: 'ntf-x', ak: 'org_user', ai: 'usr-1', org: 'org-pro', ch: 'email', to: 'a@b.test', pr: 'local-fake', st: 'queued', sk: null, da: null, ...over });
  ins();
  for (const [over, why] of [[{ st: 'teleported' }, 'an unknown status'], [{ ch: 'sms' }, 'an unknown channel'], [{ pr: 'carrier-pigeon' }, 'an unknown provider'], [{ ak: 'org' }, 'an unknown audience kind'], [{ ch: 'in_app' }, 'an in-app row with the e-mail provider'], [{ to: null }, 'a queued e-mail without an address'], [{ st: 'skipped' }, 'a skipped row without its reason'], [{ sk: 'why' }, 'a reason on a row that is not skipped'], [{ ak: 'player', ai: 'pl-adult' }, 'an organisation on a player audience'], [{ da: 1.5 }, 'a fractional clock']]) {
    assert.throws(() => ins(over), /CHECK constraint failed|cannot store REAL/, why);
  }
  ins({ to: null, st: 'skipped', sk: 'no email on record' }); // a skipped e-mail needs no address
  // The organisation key is checked at COMMIT: inside a transaction an unknown organisation is accepted until then.
  s.exec('BEGIN'); ins({ org: 'org-nowhere' }); assert.throws(() => s.exec('COMMIT'), /FOREIGN KEY constraint failed/); s.exec('ROLLBACK');
  // The provider message id is unique.
  const seqA = Number(ins().lastInsertRowid); s.prepare('UPDATE dispatches SET provider_message_id = ? WHERE seq = ?').run('fm_1', seqA);
  assert.throws(() => s.prepare('UPDATE dispatches SET provider_message_id = ? WHERE seq = ?').run('fm_1', Number(ins().lastInsertRowid)), /UNIQUE constraint failed/);
  // The attempt-shape CHECK is total: a NULL outcome cannot pass as a send.
  const att = (kind, ok, error, note) => s.prepare('INSERT INTO dispatch_attempts (dispatch_seq, seq, kind, attempted_at, ok, error, note) VALUES (?, ?, ?, 1, ?, ?, ?)').run(seqA, ++counter, kind, ok, error, note);
  att('send', 1, null, null); att('quiet_recheck', null, null, 'quiet hours re-check');
  for (const [args, why] of [[['send', null, null, null], 'a send with no outcome'], [['send', 1, null, 'n'], 'a send with a note'], [['quiet_recheck', 0, null, 'n'], 'a note with an outcome'], [['quiet_recheck', null, 'e', 'n'], 'a note with an error'], [['retry', 1, null, null], 'an unknown kind']]) assert.throws(() => att(...args), /CHECK constraint failed/, why);
  s.close(); rm(dir);
});

// ============================================================= writes and reads
test('the repository: create types the whole record (an unknown field, a wrong-typed value, an unknown vocabulary value, a staff organisation on a player audience, an e-mail without an address, a duplicate id are refused by field and id, never by address); recordAttempt appends in order and patch changes only the fields that move after creation; reads are fresh frozen records', () => {
  const dir = tempDir('dsp-repo'); fixtureFile(dir); const s = openRaw(dir); const repo = bare(s);
  const d = repo.create(email({ id: 'dsp-a' }));
  assert.equal(d.status, 'queued'); assert.equal(d.orgId, 'org-pro'); assert.deepEqual(plain(d.attempts), []);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.audience) && Object.isFrozen(d.attempts));
  for (const [raw, re] of [
    [email({ extra: 1 }), /unknown field\(s\) extra/], [email({ status: 'teleported' }), /status must be one of/], [email({ channel: 'sms' }), /channel must be one of/],
    [email({ audience: { kind: 'org', id: 'org-pro' } }), /audience must be/], [forPlayer({ orgId: 'org-pro' }), /orgId is a staff audience/], [email({ to: null }), /needs its address/],
    [email({ status: 'skipped' }), /carries its skipReason/], [email({ nextAt: 1.5 }), /nextAt must be an integer/], [email({ deliveredAt: 'Infinity' }), /deliveredAt must be an integer/],
    [email({ attempts: [{ at: 1, ok: 'yes', error: null }] }), /ok must be a boolean/], [email({ id: 'dsp-a' }), /DISPATCH_DUPLICATE/],
  ]) refuses(() => repo.create(raw), re);
  assert.doesNotMatch((() => { try { repo.create(email({ to: 7 })); } catch (e) { return e.message; } })(), /maria@/, 'a refusal never quotes an address');
  repo.recordAttempt('dsp-a', { at: NOW + 1, note: 'quiet hours re-check' });
  const after = repo.recordAttempt('dsp-a', { at: NOW + 2, ok: false, error: 'injected provider failure' });
  assert.deepEqual(plain(after.attempts), [{ at: NOW + 1, note: 'quiet hours re-check' }, { at: NOW + 2, ok: false, error: 'injected provider failure' }]);
  refuses(() => repo.recordAttempt('dsp-nowhere', { at: 1, ok: true, error: null }), /DISPATCH_NOT_FOUND/);
  refuses(() => repo.recordAttempt('dsp-a', { at: 1, ok: true, error: null, extra: 1 }), /unknown field/);
  const p = repo.patch('dsp-a', { status: 'accepted', providerMessageId: 'fm_abc' });
  assert.equal(p.status, 'accepted'); assert.equal(repo.byProviderMessageId('fm_abc').id, 'dsp-a');
  refuses(() => repo.patch('dsp-a', { to: 'x@y.test' }), /cannot change to/);
  refuses(() => repo.patch('dsp-a', { status: 'teleported' }), /status must be one of/);
  refuses(() => repo.patch('dsp-a', { openedAt: 1.5 }), /openedAt must be an integer/);
  refuses(() => repo.patch('dsp-nowhere', { status: 'failed' }), /DISPATCH_NOT_FOUND/);
  assert.equal(repo.byProviderMessageId(null), null, 'only a text id matches');
  // Reads of the stored rows: a second connection sees exactly what the repository answered.
  assert.deepEqual(rowsOf(dir, "SELECT status, provider_message_id FROM dispatches WHERE id = 'dsp-a'"), [{ status: 'accepted', provider_message_id: 'fm_abc' }]);
  s.close(); rm(dir);
});

test('the sweep\'s and the screens\' queries: due() returns queued, retrying and held sends whose time has come, in creation order; unopenedInAppRead() the in-app rows not yet opened whose notification was read (a join); forNotification; pageForOrg pages one organisation\'s staff dispatches newest first by cursor and never another\'s; recent, the counts and the backlog are SQL', () => {
  const dir = tempDir('dsp-reads'); fixtureFile(dir, { orgs: [...ORGS(), { ...ORGS()[0], id: 'org-two', name: 'Northside' }], users: [...USERS(), { id: 'usr-2', orgId: 'org-two', name: 'Rita', role: 'Scout', createdAt: 1 }] }); const s = openRaw(dir); const repo = bare(s);
  repo.create(email({ id: 'q-due', notificationId: 'n1' })); repo.create(inApp({ id: 'ia-1', notificationId: 'n1' }));
  repo.create(email({ id: 'q-later', notificationId: 'n2', nextAt: NOW + 60_000 })); repo.create(email({ id: 'r-due', notificationId: 'n3', status: 'retrying' }));
  repo.create(email({ id: 'h-due', notificationId: 'n4', status: 'held_quiet_hours' })); repo.create(email({ id: 'acc', notificationId: 'n5', status: 'accepted' }));
  repo.create(email({ id: 'other', notificationId: 'n6', audience: { kind: 'org_user', id: 'usr-2' }, orgId: 'org-two' })); repo.create(inApp({ id: 'ia-op', notificationId: 'n7', openedAt: NOW, status: 'opened' }));
  repo.create(forPlayer({ id: 'pl', notificationId: 'n8', status: 'skipped', skipReason: 'no email on record', to: null }));
  assert.deepEqual(repo.due(NOW).map((d) => d.id), ['q-due', 'r-due', 'h-due', 'other']);
  const note = s.prepare("INSERT INTO notifications (id, occurred_at, audience_kind, audience_id, type, text, read) VALUES (?, ?, 'player', 'pl-adult', 'badge', 'B', ?)");
  note.run('n1', NOW, 0); note.run('n7', NOW, 1);
  assert.deepEqual(repo.unopenedInAppRead().map((d) => d.id), [], 'n1 is unread: its in-app row is not opened yet');
  s.prepare("UPDATE notifications SET read = 1 WHERE id = 'n1'").run();
  assert.deepEqual(repo.unopenedInAppRead().map((d) => d.id), ['ia-1'], 'once n1 is read, its unopened in-app row is due (ia-op is already opened)');
  assert.deepEqual(repo.forNotification('n1').map((d) => d.id), ['q-due', 'ia-1']);
  const p1 = repo.pageForOrg('org-pro', { limit: 3 });
  assert.deepEqual(p1.items.map((d) => d.id), ['ia-op', 'acc', 'h-due']); assert.ok(p1.nextCursor);
  const after = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString());
  const p2 = repo.pageForOrg('org-pro', { limit: 10, after });
  assert.deepEqual(p2.items.map((d) => d.id), ['r-due', 'q-later', 'ia-1', 'q-due']); assert.equal(p2.nextCursor, null);
  assert.deepEqual(repo.pageForOrg('org-two', { limit: 10 }).items.map((d) => d.id), ['other']);
  assert.deepEqual(repo.recent(2).map((d) => d.id), ['pl', 'ia-op']);
  assert.deepEqual(repo.countsByStatus(), { accepted: 1, delivered: 1, held_quiet_hours: 1, opened: 1, queued: 3, retrying: 1, skipped: 1 });
  assert.equal(repo.backlogCount(), 4); assert.equal(repo.count(), 9);
  assert.ok(Object.keys(repo.countsByStatus()).every((k) => DISPATCH_STATUSES.includes(k)));
  s.close(); rm(dir);
});

// ============================================================= units of work and the server's attachment
test('in the server: no mirror and no db.dispatches (the name throws, naming the repository); writes inside a unit commit together or not at all, and reads inside the unit see its writes; a staff dispatch naming an organisation that is not stored is refused at the unit\'s COMMIT', () => {
  const dir = tempDir('dsp-unit'); fixtureFile(dir); const L = live(dir);
  L.store.unitOfWork(() => { L.repo.create(email({ id: 'u-1' })); L.repo.recordAttempt('u-1', { at: NOW, ok: true, error: null }); assert.equal(L.repo.byId('u-1').attempts.length, 1, 'a read inside the unit sees its writes'); });
  assert.deepEqual(rowsOf(dir, "SELECT id FROM dispatches").map((r) => r.id), ['u-1'], 'committed');
  assert.throws(() => L.store.unitOfWork(() => { L.repo.patch('u-1', { status: 'accepted', providerMessageId: 'fm_u' }); L.repo.create(email({ id: 'u-2' })); throw new Error('refused later in the unit'); }), /refused later/);
  assert.equal(L.repo.byId('u-1').status, 'queued', 'the patch rolled back with the unit'); assert.equal(L.repo.byId('u-2'), null);
  assert.throws(() => L.store.unitOfWork(() => { L.repo.create(email({ id: 'u-3', orgId: 'org-nowhere' })); }), /FOREIGN KEY constraint failed/);
  assert.equal(L.repo.byId('u-3'), null, 'nothing of the refused unit is stored');
  assert.equal(L.layer.report().domains.dispatches.pendingWrites, 0);
  L.close(); rm(dir);
});

// ============================================================= fixtures
test('fixtures: a dispatch written through the repository reads back with its attempts in order; an entry the table cannot hold (an unknown field, an unknown status, a missing address, a duplicate id) refuses the whole fixture, naming the entry, and writes nothing', () => {
  const dir = tempDir('dsp-fix'); fixtureFile(dir);
  const rows = [email({ id: 's-1', attempts: [{ at: NOW, note: 'quiet hours re-check' }, { at: NOW + 1, ok: true, error: null }], status: 'accepted', providerMessageId: 'fm_s1' }), inApp({ id: 's-2' }), forPlayer({ id: 's-3', status: 'skipped', skipReason: 'guardian_routed', to: null })];
  writeFixture(dir, { dispatches: rows }, { now: NOW });
  assert.deepEqual(plain(readRecords(dir).dispatches), plain(rows));
  for (const [bad, re] of [[[email({ id: 'x', extra: 1 })], /DISPATCH_RECORD_INVALID[\s\S]*unknown field/], [[email({ id: 'x', status: 'gone' })], /status must be one of/], [[email({ id: 'x', to: null })], /needs its address/], [[email({ id: 'x' }), email({ id: 'x' })], /DISPATCH_DUPLICATE: dispatches x already exists/]]) {
    assert.throws(() => writeFixture(dir, { dispatches: bad }, { now: NOW }), re);
  }
  assert.deepEqual(readRecords(dir).dispatches.map((d) => d.id), ['s-1', 's-2', 's-3'], 'a refused fixture writes nothing');
  rm(dir);
});

console.log(`\n${passed} dispatch checks passed`);
