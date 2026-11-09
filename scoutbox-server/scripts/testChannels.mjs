// Message threads as typed tables with explicit writes (repositories/channels.mjs, migration 0012): the schema (the request, organisation and staff-sender keys, the sender typed by kind, the length CHECKs,
// the retry id unique per thread and sender, the cascades); the repository's writes (open, appendMessage, markRead,
// deleteForPlayer: typed input, unknown fields and wrong types refused by field and id, references checked) and its
// SQL reads (fresh frozen records, the organisation's and the admin pages most recently active first, the filters,
// the counts); units of work (all or nothing, reads inside a unit see its writes, no mirror and no db.channels);
// fixtures written through the repository (the thread's references checked as it is opened).
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// Fixtures are written through the repositories (scripts/dataLayerFixture.mjs); the threads through `channels.open`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createChannelsRepository, MESSAGE_LIMITS } from '../repositories/channels.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, dump, FIXTURE, ORGS, USERS, SESSIONS, hasBlobTable } from './coreIdentityTestFixtures.mjs';
import { writeFixture, readRecords } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'rowid') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const channelIds = (dir) => rowsOf(dir, 'channels', 'seq').map((r) => r.id);
const messageRows = (dir) => rowsOf(dir, 'messages', 'channel_id, position').map((r) => [r.channel_id, r.position, r.id, r.client_msg_id]);
const fileDump = (dir) => { const s = second(dir); try { return dump(s); } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The channel literal, as openChannel writes it (an adult thread with the fixture's request req-1 of pl-adult, organisation org-pro). */
const channel = (over = {}) => ({ id: 'chan-1', requestId: 'req-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: NOW - 2 * MIN, messages: [], readBy: { org: null, counterparty: null }, ...over });
/** A guardian thread (the fixture's gd-primary, child pl-child1, request req-g). */
const guardianChannel = (over = {}) => channel({ id: 'chan-g', requestId: 'req-g', playerId: 'pl-child1', playerName: 'Child pl-child1', counterparty: 'guardian', guardianId: 'gd-primary', ...over });
/** A guardian thread naming the fixture's CHILDLESS guardian gd-signup. */
const soloChannel = (over = {}) => channel({ id: 'chan-solo', requestId: 'req-solo', playerId: 'pl-child2', playerName: 'Child pl-child2', counterparty: 'guardian', guardianId: 'gd-signup', ...over });
/** The message literal, as postMessage writes it (`clientMsgId` present only when given). The staff sender is the fixture's usr-1. */
const message = (over = {}) => ({ id: `msg-${++counter}`, ts: NOW - MIN, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC' }, text: 'Synthetic message text.', attachment: null, ...over });
const fromGuardian = (over = {}) => message({ sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, ...over });
const fromPlayer = (over = {}) => message({ sender: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, ...over });
const clip = (over = {}) => ({ kind: 'clip', mediaId: 'med-1', title: 'Highlights', url: null, verifiedClip: false, ...over });
const trialReport = (over = {}) => ({ kind: 'trial_report', reportId: 'rep-1', orgName: 'Eastport FC', summary: 'accel 7/10 · 31 km/h', ...over });
/** A request in the direct route's literal (the rows of recruitment_requests the threads name). */
const REQ = (id, playerId, contactChannel, over = {}) => ({ id, playerId, playerName: playerId === 'pl-adult' ? 'Adult Signup' : `Child ${playerId}`, orgId: 'org-pro', orgName: 'Eastport FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false, userId: 'usr-1', scoutName: 'Maria', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Synthetic invitation.', trialDetails: { proposedDate: '2026-11-01', altSlots: [], venue: 'Eastport Ground', notes: '' }, status: 'accepted', createdAt: NOW - 3 * MIN, routedTo: 'player', guardianId: null, contactChannel, ...over });
const REQUESTS = () => [REQ('req-1', 'pl-adult', 'chan-1'), REQ('req-g', 'pl-child1', 'chan-g'), REQ('req-free', 'pl-adult', null), REQ('req-solo', 'pl-child2', 'chan-solo'), REQ('req-2', 'pl-adult', null), REQ('req-3', 'pl-adult', null)];

/** The threads' fixture writer: each thread opened through the repository, with its messages and receipts (after the requests it names). */
/** Write `collections` (additive) through the repositories, the threads included. */
const write = (dir, collections) => writeFixture(dir, collections, { now: NOW, idCounter: 1000 });
/** A fully migrated file holding the fixture's identity, organisation and staff, the requests and the given threads, written through the repositories. */
function fixtureFile(dir, { channels, requests = REQUESTS(), extra = {} } = {}) {
  const db = { ...FIXTURE(), orgs: ORGS(), users: USERS(), sessions: SESSIONS(), requests, ...extra };
  if (channels !== undefined) db.channels = channels;
  write(dir, db);
}
/** A live server-mode store with the data layer attached, as the server runs it. */
function live(dir) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  return { store, layer, repo: layer.channels, close: () => store.sqlite.close() };
}
/** A repository on a bare connection (a tool, a test): its own transaction per write. */
const bare = (s) => createChannelsRepository({ sqlite: s, now: () => NOW });

// ============================================================= the schema
test('the schema: channels names its request and organisation and a message its staff sender as RESTRICT keys (player and guardian ids carry none); the sender is typed columns by kind; text is 1–4,000 characters and the retry id at most 64; the retry id is unique per thread and sender; one thread per request and one message per position; messages and attachments cascade with their thread; every table STRICT and no side column', () => {
  const dir = tempDir('ch-schema'); fixtureFile(dir, { channels: [] }); const s = openRaw(dir);
  assert.equal(hasBlobTable(s), false);
  const keys = (t) => s.prepare(`PRAGMA foreign_key_list(${t})`).all().map((k) => [k.from, k.table, k.on_delete]).sort();
  assert.deepEqual(keys('channels'), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
  assert.deepEqual(keys('messages'), [['channel_id', 'channels', 'CASCADE'], ['sender_user_id', 'org_users', 'RESTRICT']]);
  assert.deepEqual(keys('message_attachments'), [['message_id', 'messages', 'CASCADE']]);
  for (const t of ['channels', 'messages', 'message_attachments']) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/);
    assert.deepEqual(s.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /_json$/.test(c.name)).map((c) => c.name), [], `${t}: no side columns`);
  }
  const ins = (sql) => () => s.exec(sql);
  s.exec("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c1', 'req-1', 'p1', 'org-pro', 'O', 'player', 1, 1)");
  assert.throws(ins("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c2', 'req-1', 'p1', 'org-pro', 'O', 'player', 1, 1)"), /UNIQUE/, 'one thread per request');
  assert.throws(ins("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c3', 'req-nope', 'p1', 'org-pro', 'O', 'player', 1, 1)"), /FOREIGN KEY/, 'the request key');
  assert.throws(ins("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c4', 'req-2', 'p1', 'org-nope', 'O', 'player', 1, 1)"), /FOREIGN KEY/, 'the organisation key');
  assert.throws(ins("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c5', 'req-2', 'p1', 'org-pro', 'O', 'admin', 1, 1)"), /CHECK/, 'the counterparty vocabulary');
  assert.throws(ins("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at, last_activity_at) VALUES ('c6', 'req-2', 'p1', 'org-pro', 'O', 'player', 5, 4)"), /CHECK/, 'activity is never before the thread');
  s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text) VALUES ('m1', 'c1', 0, 1, 'player', 'p1', 't')");
  const msg = (id, cols, vals) => ins(`INSERT INTO messages (id, channel_id, position, created_at, sender_kind, ${cols}, text) VALUES ('${id}', 'c1', ${vals}, 't')`);
  assert.throws(msg('m2', 'sender_person_id', "0, 1, 'player', 'p1'"), /UNIQUE/, 'one message per position');
  assert.throws(msg('m3', 'sender_person_id', "1, 1, 'admin', 'p1'"), /CHECK/, 'the sender vocabulary');
  assert.throws(msg('m4', 'sender_person_id', "1, 1, 'org_user', 'usr-1'"), /CHECK/, 'a staff sender is the staff column');
  assert.throws(msg('m5', 'sender_user_id', "1, 1, 'player', 'usr-1'"), /CHECK/, 'a player sender is the person column');
  assert.throws(msg('m6', 'sender_user_id', "1, 1, 'org_user', 'usr-nope'"), /FOREIGN KEY/, 'the staff key');
  s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_user_id, text) VALUES ('m7', 'c1', 1, 1, 'org_user', 'usr-1', 't')");
  assert.throws(ins(`INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text) VALUES ('m8', 'c1', 2, 1, 'player', 'p1', '${'x'.repeat(MESSAGE_LIMITS.text + 1)}')`), /CHECK/, 'text at most 4,000 characters');
  assert.throws(ins("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text) VALUES ('m9', 'c1', 2, 1, 'player', 'p1', '')"), /CHECK/, 'no empty text');
  s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text, client_msg_id) VALUES ('m10', 'c1', 2, 1, 'player', 'p1', 't', 'cid')");
  assert.throws(ins("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text, client_msg_id) VALUES ('m11', 'c1', 3, 1, 'player', 'p1', 't', 'cid')"), /UNIQUE/, 'a retry id once per thread and sender');
  s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_user_id, text, client_msg_id) VALUES ('m12', 'c1', 3, 1, 'org_user', 'usr-1', 't', 'cid')"); // another sender may use the same id
  assert.throws(ins(`INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_person_id, text, client_msg_id) VALUES ('m13', 'c1', 4, 1, 'player', 'p1', 't', '${'c'.repeat(65)}')`), /CHECK/, 'a retry id at most 64 characters');
  assert.throws(ins("INSERT INTO message_attachments (message_id, kind, media_id, verified_clip, summary) VALUES ('m1', 'clip', 'x', 1, 'leak')"), /CHECK/, 'a clip carries no trial-report column');
  s.exec("INSERT INTO message_attachments (message_id, kind, media_id, verified_clip) VALUES ('m1', 'clip', 'x', 1)");
  assert.throws(ins("DELETE FROM org_users WHERE id = 'usr-1'"), /FOREIGN KEY/, 'a staff member who wrote in a thread cannot be deleted under it');
  s.exec("DELETE FROM channels WHERE id = 'c1'");
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0, 'messages cascade with their thread'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM message_attachments').get().n, 0, 'attachments cascade with their message');
  s.close(); rm(dir);
});

// ============================================================= the writes
test('writes: open stores the channel literal and returns the stored thread; a second thread for a request, and a request, organisation or guardian that does not exist, are refused by code; an unknown field or a wrong-typed value is refused by field and id (never a text); appendMessage keeps thread order and moves the activity time; a used retry id, an unknown staff sender and junk are refused; markRead returns the stored receipts; deleteForPlayer removes the player\'s threads (guardian threads included) with their messages and attachments and nothing else; a failed write leaves nothing', () => {
  const dir = tempDir('ch-writes'); fixtureFile(dir, { channels: [] }); const s = openRaw(dir); const repo = bare(s);
  const opened = repo.open(channel());
  assert.deepEqual(plain(opened), { ...channel(), lastActivityAt: NOW - 2 * MIN }, 'the stored thread is the literal with its activity time');
  assert.ok(Object.isFrozen(opened) && Object.isFrozen(opened.readBy), 'a fresh frozen record');
  repo.open(guardianChannel());
  const refused = (fn, re, label) => { const before = fileDump(dir); assert.throws(fn, re, label); assert.deepEqual(fileDump(dir), before, `${label}: nothing written`); };
  refused(() => repo.open(channel({ id: 'chan-x' })), /CHANNEL_DUPLICATE: request req-1 already opened thread chan-1/, 'one thread per request');
  refused(() => repo.open(channel()), /CHANNEL_DUPLICATE: channels chan-1 already exists/, 'a used id');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-missing' })), /CHANNEL_REQUEST_MISSING/, 'a missing request');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', orgId: 'org-missing' })), /CHANNEL_ORG_MISSING/, 'a missing organisation');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', guardianId: 'gd-missing' })), /CHANNEL_GUARDIAN_MISSING/, 'a missing guardian');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', counterparty: 'admin' })), /CHANNEL_RECORD_INVALID[\s\S]*\(chan-x\): counterparty must be one of player, guardian/, 'the counterparty vocabulary');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', orgUserIdForNotify: 'usr-legacy' })), /\(chan-x\): unknown field orgUserIdForNotify/, 'an unknown field');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', playerName: 42 })), /\(chan-x\): playerName must be text or null/, 'a wrong-typed value');
  refused(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', readBy: { org: 'yesterday' } })), /\(chan-x\): readBy\.org must be an integer timestamp or null/, 'a wrong-typed receipt');
  // Messages.
  const m1 = repo.appendMessage('chan-1', message({ id: 'm-1', ts: NOW }));
  assert.deepEqual(plain(m1), plain(message({ id: 'm-1', ts: NOW })), 'the stored message is the literal'); assert.equal(Object.hasOwn(m1, 'clientMsgId'), false, 'no clientMsgId key without one');
  const m2 = repo.appendMessage('chan-1', fromPlayer({ id: 'm-2', ts: NOW, clientMsgId: 'cid', attachment: clip() }));
  assert.equal(m2.clientMsgId, 'cid'); assert.deepEqual(plain(m2.attachment), clip()); assert.deepEqual(plain(m2.sender), { kind: 'player', id: 'pl-adult', name: 'Adult Signup' });
  repo.appendMessage('chan-g', fromGuardian({ id: 'm-g', ts: NOW + 1, attachment: trialReport() }));
  assert.deepEqual(messageRows(dir), [['chan-1', 0, 'm-1', null], ['chan-1', 1, 'm-2', 'cid'], ['chan-g', 0, 'm-g', null]], 'thread order by position');
  assert.deepEqual(rowsOf(dir, 'messages', 'seq').map((r) => [r.sender_kind, r.sender_user_id, r.sender_person_id]), [['org_user', 'usr-1', null], ['player', null, 'pl-adult'], ['guardian', null, 'gd-primary']], 'the sender as typed columns by kind');
  assert.deepEqual(rowsOf(dir, 'channels', 'seq').map((r) => r.last_activity_at), [NOW, NOW + 1], 'the activity time follows the newest message');
  repo.appendMessage('chan-1', message({ id: 'm-old', ts: NOW - 10 * MIN }));
  assert.equal(rowsOf(dir, 'channels', 'seq')[0].last_activity_at, NOW, 'an earlier timestamp never moves the activity time back');
  assert.deepEqual(plain(repo.byClientMsgId('chan-1', { kind: 'player', id: 'pl-adult' }, 'cid')), plain(m2), 'the retry lookup finds the stored message');
  assert.equal(repo.byClientMsgId('chan-1', { kind: 'org_user', id: 'usr-1' }, 'cid'), null, 'another sender\'s retry id is not this one');
  assert.equal(repo.byClientMsgId('chan-g', { kind: 'player', id: 'pl-adult' }, 'cid'), null, 'nor another thread\'s');
  refused(() => repo.appendMessage('chan-1', fromPlayer({ id: 'm-dup', clientMsgId: 'cid' })), /MESSAGE_DUPLICATE: channels chan-1: this sender already sent client message id cid/, 'a used retry id');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-1' })), /MESSAGE_DUPLICATE: messages m-1 already exists/, 'a used message id');
  refused(() => repo.appendMessage('chan-9', message()), /CHANNEL_NOT_FOUND/, 'a thread that does not exist');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', sender: { kind: 'org_user', id: 'usr-nobody', name: 'x' } })), /CHANNEL_SENDER_MISSING/, 'an unknown staff sender');
  const SECRET = 'SECRET-MESSAGE-TEXT-77';
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', text: SECRET, sender: { kind: 'admin', id: 'a', name: 'b' } })), (e) => /\(m-bad\): sender\.kind must be one of/.test(e.message) && !e.message.includes(SECRET), 'the sender vocabulary, without the text');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', clientMsgId: 5 })), /\(m-bad\): clientMsgId must be text or null/, 'a non-text retry id');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', clientMsgId: 'c'.repeat(65) })), /\(m-bad\): clientMsgId must be 1–64 characters/, 'an over-long retry id');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', text: 'x'.repeat(MESSAGE_LIMITS.text + 1) })), /\(m-bad\): text must be 1–4000 characters/, 'an over-long text');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', text: '' })), /\(m-bad\): text must be 1–4000 characters/, 'an empty text');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', attachment: clip({ verifiedClip: 'yes' }) })), /\(m-bad\): attachment\.verifiedClip must be a boolean/, 'a wrong-typed attachment field');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', attachment: { kind: 'file' } })), /\(m-bad\): attachment\.kind must be one of clip, trial_report/, 'an unknown attachment kind');
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-bad', attachment: clip({ extra: 1 }) })), /\(m-bad\): unknown field attachment\.extra/, 'an unknown attachment field');
  // Receipts.
  assert.deepEqual(plain(repo.markRead('chan-1', 'org', NOW + 1)), { org: NOW + 1, counterparty: null }); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 1);
  assert.deepEqual(plain(repo.byId('chan-1').readBy), { org: NOW + 1, counterparty: null }, 'a fresh read sees the receipt');
  assert.throws(() => repo.markRead('chan-1', 'admin', NOW), /'org' or 'counterparty'/); assert.throws(() => repo.markRead('chan-1', 'org', 1.5), /integer timestamp/); assert.throws(() => repo.markRead('chan-9', 'org', NOW), /CHANNEL_NOT_FOUND/);
  // A statement failure inside the repository's own transaction leaves nothing.
  s.exec("CREATE TEMP TRIGGER ch_fail AFTER INSERT ON message_attachments BEGIN SELECT RAISE(ABORT, 'synthetic statement failure'); END");
  refused(() => repo.appendMessage('chan-1', message({ id: 'm-fail', attachment: clip() })), /synthetic statement failure/, 'the message and its attachment together or not at all');
  s.exec('DROP TRIGGER ch_fail');
  // Deletion: the player's threads, the guardian thread of the child included, go; the others stay.
  repo.open(channel({ id: 'chan-3', requestId: 'req-free' }));
  assert.deepEqual(repo.deleteForPlayer('pl-child1'), { channels: 1, messages: 1 });
  assert.deepEqual(channelIds(dir), ['chan-1', 'chan-3']); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-1', 'm-2', 'm-old']); assert.equal(rowsOf(dir, 'message_attachments').length, 1, 'the deleted thread\'s attachment went with it');
  assert.deepEqual(repo.deleteForPlayer('pl-nobody'), { channels: 0, messages: 0 });
  s.close(); rm(dir);
});

// ============================================================= the reads
test('reads: byId and parties; a player\'s threads (all, or only their own adult threads) and a guardian\'s, oldest first; the organisation\'s page and the admin page most recently active first with a cursor that continues where the page ended, and the playerId filter; the club\'s counts (threads, and messages from the player or guardian since it last opened each thread); the staff who wrote in a thread; every record is fresh and frozen', () => {
  const dir = tempDir('ch-reads');
  fixtureFile(dir, { channels: [
    channel({ createdAt: NOW - 30 * MIN, messages: [message({ id: 'a-1', ts: NOW - 29 * MIN }), fromPlayer({ id: 'a-2', ts: NOW - 20 * MIN })], readBy: { org: NOW - 25 * MIN, counterparty: null } }),
    guardianChannel({ createdAt: NOW - 28 * MIN, messages: [fromGuardian({ id: 'g-1', ts: NOW - 5 * MIN }), fromGuardian({ id: 'g-2', ts: NOW - 4 * MIN })] }),
    channel({ id: 'chan-2', requestId: 'req-2', createdAt: NOW - 10 * MIN }),
    channel({ id: 'chan-3', requestId: 'req-3', createdAt: NOW - 10 * MIN }),
  ] });
  const s = openRaw(dir); const repo = bare(s);
  assert.deepEqual(repo.byId('chan-g').messages.map((m) => m.id), ['g-1', 'g-2']); assert.equal(repo.byId('chan-nope'), null); assert.equal(repo.byId(5), null);
  assert.ok(Object.isFrozen(repo.byId('chan-g').messages[0].sender));
  assert.notEqual(repo.byId('chan-g'), repo.byId('chan-g'), 'fresh records, not a shared mirror');
  assert.deepEqual(plain(repo.parties('chan-g')), { id: 'chan-g', orgId: 'org-pro', playerId: 'pl-child1', counterparty: 'guardian', guardianId: 'gd-primary' }); assert.equal(repo.parties('chan-nope'), null);
  assert.deepEqual(repo.forPlayer('pl-adult').map((c) => c.id), ['chan-1', 'chan-2', 'chan-3']);
  assert.deepEqual(repo.forPlayer('pl-child1', { counterparty: 'player' }).map((c) => c.id), [], 'a child has no thread of its own');
  assert.deepEqual(repo.forGuardian('gd-primary').map((c) => c.id), ['chan-g']);
  // Activity: chan-g (NOW-4m) > chan-1 (NOW-20m) and chan-3, chan-2 (both NOW-10m: the later row first).
  const order = ['chan-g', 'chan-3', 'chan-2', 'chan-1'];
  const p1 = repo.pageForOrg('org-pro', {}, { after: null, limit: 3 });
  assert.deepEqual(p1.items.map((c) => c.id), order.slice(0, 3)); assert.ok(p1.nextCursor);
  const after = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString('utf8'));
  const p2 = repo.pageForOrg('org-pro', {}, { after, limit: 3 }); assert.deepEqual(p2.items.map((c) => c.id), order.slice(3)); assert.equal(p2.nextCursor, null);
  assert.deepEqual(repo.pageForOrg('org-pro', { playerId: 'pl-child1' }, { after: null, limit: 50 }).items.map((c) => c.id), ['chan-g'], 'one player\'s threads');
  assert.deepEqual(repo.pageForOrg('org-other', {}, { after: null, limit: 50 }).items, [], 'another organisation sees none');
  assert.deepEqual(repo.page({ after: null, limit: 50 }).items.map((c) => c.id), order, 'the admin page, the same order');
  // A new message moves its thread to the top.
  repo.appendMessage('chan-1', fromPlayer({ id: 'a-3', ts: NOW }));
  assert.deepEqual(repo.pageForOrg('org-pro', {}, { after: null, limit: 50 }).items.map((c) => c.id), ['chan-1', 'chan-g', 'chan-3', 'chan-2']);
  // Counts: chan-1 has a-2 and a-3 from the player after the club's receipt (a-1 is the club's own); chan-g has g-1 and g-2 (never opened).
  assert.deepEqual(repo.countsForOrg('org-pro'), { threads: 4, unreadMessages: 4 });
  repo.markRead('chan-g', 'org', NOW); assert.deepEqual(repo.countsForOrg('org-pro'), { threads: 4, unreadMessages: 2 });
  assert.deepEqual(repo.countsForOrg('org-other'), { threads: 0, unreadMessages: 0 });
  assert.deepEqual(repo.staffSenders('chan-1'), ['usr-1']); assert.deepEqual(repo.staffSenders('chan-g'), []);
  assert.deepEqual(repo.counts(), { channels: 4, messages: 5, attachments: 0 });
  assert.deepEqual(Object.keys(repo.reads).filter((k) => ['open', 'appendMessage', 'markRead', 'deleteForPlayer'].includes(k)), [], 'the reads object has no write');
  s.close(); rm(dir);
});

// ============================================================= units of work, no mirror
test('units of work: the threads join the open unit; a failure anywhere in it (a thrown error, a caught refusal, a statement failure, the real COMMIT) leaves the file and every read as they were; reads inside the unit see its writes; there is no mirror, no save hook and db.channels throws, naming the repository', () => {
  const dir = tempDir('ch-unit'); fixtureFile(dir, { channels: [channel({ messages: [message({ id: 'm-0' })] })] });
  const L = live(dir);
  assert.equal(L.repo.pending(), 0);
  const before = fileDump(dir);
  const unchanged = (label) => { assert.deepEqual(fileDump(dir), before, label); assert.deepEqual(L.repo.byId('chan-1').messages.map((m) => m.id), ['m-0'], `${label}: a read agrees`); assert.equal(L.store.sqlite.isTransaction, false); };
  const work = () => {
    L.layer.recruitment.requests.update('req-free', (d) => { d.contactChannel = 'chan-u'; });
    L.repo.open(channel({ id: 'chan-u', requestId: 'req-free' }));
    L.repo.appendMessage('chan-1', message({ id: 'm-u', attachment: clip() }));
    L.repo.markRead('chan-1', 'counterparty', NOW + 5);
    assert.deepEqual(L.repo.byId('chan-1').messages.map((m) => m.id), ['m-0', 'm-u'], 'a read inside the unit sees its writes');
    assert.equal(L.repo.byId('chan-u').id, 'chan-u');
  };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }), /synthetic unit failure/); unchanged('thrown');
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { work(); try { L.repo.appendMessage('chan-1', message({ sender: { kind: 'admin', id: 'a', name: 'b' } })); } catch (e) { caught = e; } }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /sender\.kind/); assert.ok(outer, 'a caught refusal inside the unit still refuses the unit'); unchanged('caught');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE UPDATE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic statement failure'); END");
  assert.throws(() => L.store.unitOfWork(work), /synthetic statement failure/); unchanged('statement failure');
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.store.sqlite.exec("CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON message_attachments BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(work), /FOREIGN KEY constraint failed/); unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  L.store.unitOfWork(work);
  assert.deepEqual(channelIds(dir), ['chan-1', 'chan-u']); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-u']); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_counterparty_at, NOW + 5);
  assert.equal(rowsOf(dir, 'recruitment_requests').find((r) => r.id === 'req-free').contact_channel_id, 'chan-u', 'the request and its thread together');
  // The account deletion's part, inside a unit.
  L.store.unitOfWork(() => { assert.deepEqual(L.repo.deleteForPlayer('pl-adult'), { channels: 2, messages: 2 }); });
  assert.deepEqual(channelIds(dir), []);
  L.close(); rm(dir);
});

// ============================================================= fixtures and the references a thread names
test('fixtures: every thread written through the repository (typed records, both attachment shapes, order and ties) reads back as written; an unknown field or a wrong-typed value refuses the whole fixture by field and id, never quoting a text, and nothing of it lands', () => {
  const dir = tempDir('ch-fix');
  const g = guardianChannel({ scoutName: null, messages: [fromGuardian({ id: 'm-g', attachment: trialReport() })] });
  const written = [channel({ messages: [message({ id: 'm-1', ts: NOW }), fromPlayer({ id: 'm-2', ts: NOW, attachment: clip(), clientMsgId: 'c' })] }), g];
  fixtureFile(dir, { channels: written });
  const back = readRecords(dir).channels;
  assert.equal(back.length, 2); assert.equal(back[1].scoutName, null); assert.equal(back[0].lastActivityAt, NOW, 'the activity time is the newest message\'s');
  assert.deepEqual(plain(back), plain([{ ...written[0], lastActivityAt: NOW }, { ...g, lastActivityAt: NOW - MIN }]), 'read back as written');
  const beforeDump = fileDump(dir);
  const refuses = (channels, re, label) => { assert.throws(() => write(dir, { channels }), re, label); assert.deepEqual(fileDump(dir), beforeDump, `${label}: nothing of the fixture landed`); };
  // New threads on the fixture's free requests (req-free, req-2, req-3), so only the refusal under test applies.
  const fresh = (over = {}) => channel({ id: 'chan-n', requestId: 'req-free', ...over });
  refuses([fresh({ orgUserIdForNotify: 'usr-legacy' })], /CHANNEL_RECORD_INVALID[\s\S]*\(chan-n\): unknown field orgUserIdForNotify/, 'an unknown field');
  refuses([fresh({ messages: [fromPlayer({ id: 'm-n', attachment: { ...clip(), extra: 'x' } })] })], /\(m-n\): unknown field attachment\.extra/, 'an unknown nested field');
  const SECRET = 'SECRET-MESSAGE-TEXT-77';
  refuses([fresh({ messages: [message({ text: SECRET, sender: { kind: 'admin', id: 'a', name: 'b' } })] })], (e) => /CHANNEL_RECORD_INVALID/.test(e.message) && /sender\.kind/.test(e.message) && !e.message.includes(SECRET), 'a wrong sender kind');
  refuses([fresh({ scoutRole: { secret: SECRET } })], (e) => /\(chan-n\): scoutRole must be text or null/.test(e.message) && !e.message.includes(SECRET), 'a wrong-typed value');
  refuses([fresh({ messages: [message({ sender: { kind: 'org_user', id: 'usr-nobody', name: 'x' } })] })], /CHANNEL_SENDER_MISSING/, 'a staff sender that does not exist');
  refuses([fresh({ messages: [message({ id: 'same' })] }), fresh({ id: 'chan-n2', requestId: 'req-2', messages: [message({ id: 'same' })] })], /UNIQUE constraint failed: messages\.id/, 'a message id in two threads');
  rm(dir);
});

test('the references a thread names, checked as it is opened: a request that does not exist (CHANNEL_REQUEST_MISSING), a guardian that does not exist (CHANNEL_GUARDIAN_MISSING), an organisation that does not exist (CHANNEL_ORG_MISSING), a second thread for one request (CHANNEL_DUPLICATE); nothing changes on a refusal', () => {
  const dir = tempDir('ch-refs');
  fixtureFile(dir, { channels: [channel({ messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW })] }), guardianChannel({ messages: [fromGuardian({ id: 'm-g' })] }), soloChannel()] });
  const ALL = ['chan-1', 'chan-g', 'chan-solo'];
  const unchangedAfter = (channels, re, code, label) => { const before = fileDump(dir); assert.throws(() => write(dir, { channels }), (e) => re.test(e.message) && (!code || e.code === code), label); assert.deepEqual(fileDump(dir), before, `${label}: nothing changed`); };
  assert.deepEqual(channelIds(dir), ALL);
  unchangedAfter([channel({ id: 'chan-o', requestId: 'req-orphan' })], /CHANNEL_REQUEST_MISSING[\s\S]*req-orphan/, 'CHANNEL_REQUEST_MISSING', 'an orphan thread');
  unchangedAfter([guardianChannel({ id: 'chan-bad', requestId: 'req-free', guardianId: 'gd-missing' })], /CHANNEL_GUARDIAN_MISSING[\s\S]*gd-missing/, 'CHANNEL_GUARDIAN_MISSING', 'a thread naming a guardian that does not exist');
  unchangedAfter([channel({ id: 'chan-x', requestId: 'req-free', orgId: 'org-nowhere' })], /CHANNEL_ORG_MISSING|FOREIGN KEY constraint failed/, undefined, 'a thread naming an organisation that does not exist');
  unchangedAfter([channel({ id: 'chan-2' })], /CHANNEL_DUPLICATE[\s\S]*req-1 already opened thread chan-1/, 'CHANNEL_DUPLICATE', 'a second thread for one request');
  write(dir, { channels: [channel({ id: 'chan-free', requestId: 'req-free' })] }); assert.deepEqual(channelIds(dir), [...ALL, 'chan-free'], 'a thread on a free request is opened');
  rm(dir);
});

console.log(`\n${passed} channel checks passed`);
