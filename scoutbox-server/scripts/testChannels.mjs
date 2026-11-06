// S7d — message threads as tables (repositories/channels.mjs, migration 0012),
// the bounded storage migration the Founder
// approved through D-A (messaging first with a transitional code-checked request
// reference) and D-B (today's explicit deletion of a deleted player's threads
// reproduced; retention left open). The migration (DDL only, no blob import);
// the actual schema (no FK on request_id/player_id/guardian_id, the org
// FK, the two internal cascades, the unique request index); the repository (open with
// the checked request reference, append in array order, receipts, deletion for a
// player, the two write modes, joined units, real COMMIT failure, hook registration, a
// failed ordinary save keeping its pending state versus an aborted unit restoring the
// pre-unit state); the snapshot dispatcher and the FINAL-STATE assertion in every
// direction (channels only, requests only, identity only, coordinated, malformed,
// absence versus empty array, parent-prune order).
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// Fixtures are written by a snapshot-mode save (openStore(dir).save), which runs
// every migration first, so the threads meet the final schema (the request key
// is real since S8a).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, applied, dump, FIXTURE, ORGS, USERS, SESSIONS, freshFile, hasBlobTable } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const MIGRATION = '0012_channels';
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'rowid') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const tableExistsIn = (dir, t) => { const s = second(dir); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); } finally { s.close(); } };
const channelIds = (dir) => (tableExistsIn(dir, 'channels') ? rowsOf(dir, 'channels', 'seq').map((r) => r.id) : null);
const messageRows = (dir) => (tableExistsIn(dir, 'messages') ? rowsOf(dir, 'messages', 'channel_id, position').map((r) => [r.channel_id, r.position, r.id, r.client_msg_id]) : null);
/** Every table of the file, as committed (rewritten in S14a: replaces the save revision as the "nothing landed" check). */
const fileDump = (dir) => { const s = second(dir); try { return dump(s); } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
/** The channel literal, as openChannel writes it (an adult thread with the fixture's request req-1 of pl-adult, organisation org-pro). */
const channel = (over = {}) => ({ id: 'chan-1', requestId: 'req-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: NOW - 2 * MIN, messages: [], readBy: { org: null, counterparty: null }, ...over });
/** A guardian thread (the fixture's gd-primary, child pl-child1, request req-g). */
const guardianChannel = (over = {}) => channel({ id: 'chan-g', requestId: 'req-g', playerId: 'pl-child1', playerName: 'Child pl-child1', counterparty: 'guardian', guardianId: 'gd-primary', ...over });
/** The message literal, as postMessage writes it (`clientMsgId` present only when given). */
const message = (over = {}) => ({ id: `msg-${++counter}`, ts: NOW - MIN, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC' }, text: 'Synthetic message text.', attachment: null, ...over });
const clip = (over = {}) => ({ kind: 'clip', mediaId: 'med-1', title: 'Highlights', url: null, verifiedClip: false, ...over });
const trialReport = (over = {}) => ({ kind: 'trial_report', reportId: 'rep-1', orgName: 'Eastport FC', summary: 'accel 7/10 · 31 km/h', ...over });
/** A request in the direct route's literal (S8a: the requests are rows of recruitment_requests since 0015, so the fixture carries the writer's identifiers; `history` is an unknown field kept in extra_json). */
const REQ = (id, playerId, contactChannel, over = {}) => ({ id, playerId, playerName: playerId === 'pl-adult' ? 'Adult Signup' : `Child ${playerId}`, orgId: 'org-pro', orgName: 'Eastport FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false, userId: 'usr-1', scoutName: 'Maria', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Synthetic invitation.', trialDetails: { proposedDate: '2026-11-01', altSlots: [], venue: 'Eastport Ground', notes: '' }, status: 'accepted', createdAt: NOW - 3 * MIN, routedTo: 'player', guardianId: null, contactChannel, ...over });
const REQUESTS = () => [REQ('req-1', 'pl-adult', 'chan-1'), REQ('req-g', 'pl-child1', 'chan-g'), REQ('req-free', 'pl-adult', null), REQ('req-solo', 'pl-child2', 'chan-solo')];
const requestRow = (dir, id) => (tableExistsIn(dir, 'recruitment_requests') ? rowsOf(dir, 'recruitment_requests').find((r) => r.id === id) : undefined);
/** A guardian thread naming the fixture's CHILDLESS guardian gd-signup (removing that guardian is valid for the identity snapshot itself, so the channel assertion is what refuses). */
const soloChannel = (over = {}) => channel({ id: 'chan-solo', requestId: 'req-solo', playerId: 'pl-child2', playerName: 'Child pl-child2', counterparty: 'guardian', guardianId: 'gd-signup', ...over });

/** A fully migrated file holding the fixture's identity, organisation and staff, the requests the threads reference and the given threads, written by a snapshot-mode save (the writers' validation applies). */
function s7cFile(dir, { channels, requests = REQUESTS(), extra: more = {} } = {}) {
  const db = { ...FIXTURE(), orgs: ORGS(), users: USERS(), sessions: SESSIONS(), requests, ...more };
  if (channels !== undefined) db.channels = channels;
  const tool = openStore(dir); tool.save({ idCounter: 1000, db }); tool.sqlite.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id <= MIGRATION), { now, context: { sessionTtlMs: TTL } }); // up to 0012 (a no-op on a fixture, which is fully migrated)
let mod = null;
try { mod = await import('../repositories/channels.mjs'); } catch { mod = null; }
const needModule = () => { assert.ok(mod, 'repositories/channels.mjs exists (the S7d repository module)'); return mod; };
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {};
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  return { store, db, layer, warnings, repo: layer.channels, save: () => store.save(), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test): own transaction per mutation. */
const bare = (s, requests = REQUESTS(), over = {}) => needModule().createChannelsRepository({ sqlite: s, now: () => NOW, requestExists: (id) => requests.some((r) => r?.id === id), ...over });

// ============================================================= [compat] what the accepted representation already does
test('[compat] the message literal: a message without a clientMsgId has NO such key while one sent with a client id does, and the attachment key is always present (null without one)', () => {
  const legacy = JSON.parse(JSON.stringify({ ...channel(), messages: [message({ id: 'm1' }), message({ id: 'm2', clientMsgId: 'c-1' })] }));
  assert.equal(Object.hasOwn(legacy.messages[0], 'clientMsgId'), false); assert.equal(legacy.messages[1].clientMsgId, 'c-1');
  assert.equal(Object.hasOwn(legacy.messages[0], 'attachment'), true); assert.equal(legacy.messages[0].attachment, null);
});

test('[cutover] migration 0012 is registered after 0011; the actual schema: no side columns, channels references orgs (RESTRICT) and nothing else — no foreign key on request_id, player_id or guardian_id (D-A: the checked reference; D-B: no lifecycle clause; the code-validated guardian); a unique index on request_id; messages → channels and message_attachments → messages CASCADE; the three sender kinds, the two counterparties and the two attachment kinds are CHECKed; the attachment CHECK ties each kind to its columns; every table STRICT', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).filter((id) => id <= MIGRATION).slice(-2), ['0011_outbox_push', MIGRATION], '0012 is registered after 0011');
  { // The final state: since S8a (0015) the request reference is a real key.
    const full = tempDir('ch-schema-full'); s7cFile(full, { channels: [] }); const f = openRaw(full);
    assert.equal(hasBlobTable(f), false, 'no blob table (rewritten in S14a)');
    assert.deepEqual(f.prepare('PRAGMA foreign_key_list(channels)').all().map((k) => [k.from, k.table, k.on_delete]).sort(), [['org_id', 'orgs', 'RESTRICT'], ['request_id', 'recruitment_requests', 'RESTRICT']]);
    f.close(); rm(full);
  }
  // The 0012 step's own DDL, on a new database migrated up to 0012.
  const dir = tempDir('ch-schema'); freshFile(dir); const s = openRaw(dir); migrate(s);
  assert.ok(applied(s).includes(MIGRATION));
  s.exec("INSERT INTO orgs (id, name, type, level, plan, country) VALUES ('org-pro', 'Eastport FC', 'club', 'pro', 'Pro', 'GB')");
  for (const t of ['channels', 'messages', 'message_attachments']) assert.deepEqual(s.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /_json$/.test(c.name)).map((c) => c.name), [], `${t}: no side columns`);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_list(channels)').all().map((f) => [f.from, f.table, f.on_delete]), [['org_id', 'orgs', 'RESTRICT']]);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_list(messages)').all().map((f) => [f.from, f.table, f.on_delete]), [['channel_id', 'channels', 'CASCADE']]);
  assert.deepEqual(s.prepare('PRAGMA foreign_key_list(message_attachments)').all().map((f) => [f.from, f.table, f.on_delete]), [['message_id', 'messages', 'CASCADE']]);
  assert.equal(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'channels_request_id'").get().sql.includes('UNIQUE'), true);
  for (const t of ['channels', 'messages', 'message_attachments']) assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/);
  s.exec("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at) VALUES ('c1', 'r1', 'p1', 'org-pro', 'O', 'player', 1)");
  assert.throws(() => s.exec("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at) VALUES ('c2', 'r1', 'p1', 'org-pro', 'O', 'player', 1)"), /UNIQUE/, 'one channel per request');
  assert.throws(() => s.exec("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at) VALUES ('c3', 'r3', 'p1', 'org-missing', 'O', 'player', 1)"), /FOREIGN KEY/, 'the org FK');
  assert.throws(() => s.exec("INSERT INTO channels (id, request_id, player_id, org_id, org_name, counterparty, created_at) VALUES ('c4', 'r4', 'p1', 'org-pro', 'O', 'admin', 1)"), /CHECK/, 'the counterparty CHECK');
  s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_id, text) VALUES ('m1', 'c1', 0, 1, 'player', 'p1', 't')");
  assert.throws(() => s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_id, text) VALUES ('m2', 'c1', 0, 1, 'player', 'p1', 't')"), /UNIQUE/, 'one message per position');
  assert.throws(() => s.exec("INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_id, text) VALUES ('m3', 'c1', 1, 1, 'admin', 'p1', 't')"), /CHECK/, 'the sender-kind CHECK');
  assert.throws(() => s.exec("INSERT INTO message_attachments (message_id, kind, media_id, verified_clip, summary) VALUES ('m1', 'clip', 'x', 1, 'leak')"), /CHECK/, 'a clip carries no trial-report column');
  s.exec("INSERT INTO message_attachments (message_id, kind, media_id, verified_clip) VALUES ('m1', 'clip', 'x', 1)");
  s.exec("DELETE FROM channels WHERE id = 'c1'"); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0, 'messages cascade with their channel'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM message_attachments').get().n, 0, 'attachments cascade with their message');
  s.close(); rm(dir);
});

// ============================================================= [cutover] the repository (immediate mode)
test('[cutover] repository, immediate mode: open appends a thread at the END with the checked request reference (a request not in the collection, a second thread for one request, a missing organisation, a missing guardian are refused by name; the array stays as it was); appendMessage keeps array order with positions and ties; a wrong-typed value is refused by field and id and an unknown key is dropped; markRead updates the receipt (an absent receipt reads as null until written); deleteForPlayer removes the player\'s threads — guardian–club threads included — with their messages and attachments and nothing else; a refused operation inside its own transaction restores the mirror in place (held views included); reload reproduces the stored rows', () => {
  const dir = tempDir('ch-repo'); s7cFile(dir, { channels: [channel(), guardianChannel()], requests: [...REQUESTS(), REQ('req-nk', 'pl-child1', null)] }); const s = openRaw(dir); migrate(s); // req-nk: the stored row behind the thread opened below (the request key is real since S8a)
  const requests = REQUESTS(); const repo = bare(s, requests);
  assert.equal(repo.count(), 2); assert.deepEqual(repo.view.map((c) => c.id), ['chan-1', 'chan-g']);
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-missing' })), /CHANNEL_REQUEST_MISSING/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-1' })), /already opened thread chan-1/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', orgId: 'org-missing' })), /CHANNEL_ORG_MISSING/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', guardianId: 'gd-missing' })), /CHANNEL_GUARDIAN_MISSING/);
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', counterparty: 'admin' })), /counterparty must be 'player' or 'guardian'/);
  assert.equal(repo.count(), 2, 'refusals leave the mirror as it was'); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g']);
  // A wrong-typed value is refused by field and id; an unknown key is dropped silently.
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', playerName: 42 })), (e) => e instanceof TypeError && /\(chan-x\): playerName must be a string or null/.test(e.message));
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', readBy: { org: 'yesterday' } })), /\(chan-x\): readBy\.org must be an integer timestamp or null/);
  assert.equal(repo.count(), 2);
  const opened = repo.open(channel({ id: 'chan-3', requestId: 'req-free', orgUserIdForNotify: 'usr-legacy' }));
  assert.equal(opened.id, 'chan-3'); assert.equal(Object.hasOwn(opened, 'orgUserIdForNotify'), false, 'the unknown key is not stored'); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g', 'chan-3']); assert.throws(() => { opened.orgName = 'x'; }, /written through its domain repository/);
  const held = repo.byId('chan-1');
  const m1 = repo.appendMessage('chan-1', message({ id: 'm-1', ts: NOW })); repo.appendMessage('chan-1', message({ id: 'm-2', ts: NOW, clientMsgId: 'cid', attachment: clip() })); repo.appendMessage('chan-g', message({ id: 'm-g', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, attachment: trialReport() }));
  assert.deepEqual(held.messages.map((m) => m.id), ['m-1', 'm-2'], 'the held view sees the appended messages'); assert.equal(m1.text, 'Synthetic message text.');
  assert.deepEqual(messageRows(dir), [['chan-1', 0, 'm-1', null], ['chan-1', 1, 'm-2', 'cid'], ['chan-g', 0, 'm-g', null]]);
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-1' })), /already holds message m-1/); assert.throws(() => repo.appendMessage('chan-9', message()), /no thread chan-9/);
  assert.throws(() => repo.appendMessage('chan-1', message({ sender: { kind: 'admin', id: 'a', name: 'b' } })), /sender\.kind/);
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-bad', clientMsgId: 5 })), /\(m-bad\): clientMsgId must be a non-empty string when present/);
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-bad', attachment: clip({ verifiedClip: 'yes' }) })), /\(m-bad\): attachment\.verifiedClip must be a boolean/);
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-bad', attachment: { kind: 'file' } })), /\(m-bad\): attachment\.kind must be 'clip' or 'trial_report'/); assert.deepEqual(held.messages.map((m) => m.id), ['m-1', 'm-2'], 'a refused append changes nothing');
  assert.deepEqual(repo.markRead('chan-1', 'org', NOW + 1), { org: NOW + 1, counterparty: null }); assert.equal(held.readBy.org, NOW + 1); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 1);
  assert.throws(() => repo.markRead('chan-1', 'admin', NOW), /'org' or 'counterparty'/); assert.throws(() => repo.markRead('chan-1', 'org', 1.5), /integer timestamp/);
  // An absent receipt key is an unread receipt (null) until it is written.
  const noKey = guardianChannel({ id: 'chan-nk', requestId: 'req-nk', readBy: { org: null } }); requests.push({ id: 'req-nk', playerId: 'pl-child1', status: 'accepted' }); repo.open(noKey);
  assert.deepEqual(plain(repo.byId('chan-nk').readBy), { org: null, counterparty: null }); repo.markRead('chan-nk', 'counterparty', NOW + 2); assert.equal(rowsOf(dir, 'channels', 'seq').at(-1).read_by_counterparty_at, NOW + 2); assert.equal(repo.byId('chan-nk').readBy.counterparty, NOW + 2);
  // Deletion: the player's threads — the guardian thread of the child included — go; the others stay.
  assert.deepEqual(repo.deleteForPlayer('pl-child1'), { channels: 2, messages: 1 });
  assert.deepEqual(repo.view.map((c) => c.id), ['chan-1', 'chan-3']); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-3']); assert.deepEqual(messageRows(dir), [['chan-1', 0, 'm-1', null], ['chan-1', 1, 'm-2', 'cid']]); assert.equal(rowsOf(dir, 'message_attachments').length, 1, 'the deleted thread\'s attachment went with it; the other stays');
  assert.deepEqual(repo.deleteForPlayer('pl-nobody'), { channels: 0, messages: 0 });
  // A failure inside the repository's own transaction restores the mirror in place.
  s.exec("CREATE TEMP TRIGGER ch_fail BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'synthetic statement failure'); END");
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-fail' })), /synthetic statement failure/);
  assert.deepEqual(held.messages.map((m) => m.id), ['m-1', 'm-2'], 'the held view is back'); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-1', 'm-2']);
  s.exec('DROP TRIGGER ch_fail');
  const exported = repo.exportRows(); assert.deepEqual(exported.map((c) => c.id), ['chan-1', 'chan-3']); exported[0].messages.push({ id: 'edit' }); assert.equal(held.messages.length, 2, 'the export is detached');
  repo.reload(); assert.deepEqual(repo.view.map((c) => c.id), ['chan-1', 'chan-3']); assert.deepEqual(repo.byId('chan-1').messages.map((m) => m.id), ['m-1', 'm-2']); assert.deepEqual(plain(repo.byId('chan-3')), { ...channel({ id: 'chan-3', requestId: 'req-free' }) }, 'the stored thread reads back as opened, without the unknown key');
  s.close(); rm(dir);
});

// ============================================================= [cutover] the staged mode (the server's)
test('[cutover] staged mode (the server): a thread, a message and a receipt are visible in memory at once but NOT durable ahead of the next save, which lands them together; a FAILED ORDINARY SAVE (statement or real COMMIT) keeps the mirror and the queue as they are — pending state retained — and the retry lands everything once; an ABORTED UNIT OF WORK restores the mirror and the queue to the pre-unit state (held views and nested message arrays included) whether the unit threw, a queued statement failed at the flush, the real COMMIT failed or a participant refusal was caught; deletion joins the unit; writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('ch-staged'); s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-0' })] })] });
  const L = live(dir); L.save();
  const opened = L.repo.open(channel({ id: 'chan-2', requestId: 'req-free' })); L.layer.recruitment.requests.update('req-free', (d) => { d.contactChannel = 'chan-2'; }); // S8a: an explicit write
  const held = L.repo.byId('chan-1'); L.repo.appendMessage('chan-1', message({ id: 'm-1' })); L.repo.markRead('chan-1', 'org', NOW);
  assert.equal(L.repo.pending(), 3); assert.deepEqual(channelIds(dir), ['chan-1'], 'nothing durable before the save'); assert.deepEqual(L.db.channels.map((c) => c.id), ['chan-1', 'chan-2'], 'memory shows the thread at once'); assert.equal(held.messages.length, 2);
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON channels BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(channelIds(dir), ['chan-1']); assert.equal(L.repo.pending(), 3); assert.equal(requestRow(dir, 'req-free').contact_channel_id, 'chan-2', 'the request\'s answer is an explicit write (§4.3): durable at once, and the respond routes pair it with the thread in one unit');
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON messages BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(channelIds(dir), ['chan-1']); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0']); assert.equal(L.repo.pending(), 3);
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  L.save();
  assert.deepEqual(channelIds(dir), ['chan-1', 'chan-2']); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-1']); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW); assert.equal(requestRow(dir, 'req-free').contact_channel_id, 'chan-2'); assert.equal(L.repo.pending(), 0);
  { const landed = fileDump(dir); L.save(); assert.equal(fileDump(dir), landed, 'a later save does not replay'); }
  // A unit of work: together or not at all.
  L.repo.appendMessage('chan-2', message({ id: 'm-pre' })); assert.equal(L.repo.pending(), 1);
  const state = () => ({ export: plain(L.repo.exportRows()), heldMessages: held.messages.map((m) => m.id), heldRead: plain(held.readBy), requests: JSON.stringify(L.layer.recruitment.exportAll().requests), durable: fileDump(dir) });
  const before = state();
  const unchanged = (label) => { assert.deepEqual(state(), before, label); assert.equal(L.repo.pending(), 1, `${label}: the pre-unit write is still pending`); assert.equal(L.store.sqlite.isTransaction, false); };
  const work = () => { L.layer.recruitment.requests.create(REQ('req-u', 'pl-adult', null)); /* S8a: an explicit create, joining the unit */ L.repo.appendMessage('chan-1', message({ id: 'm-u', attachment: clip() })); L.repo.markRead('chan-1', 'counterparty', NOW + 5); L.repo.open(channel({ id: 'chan-u', requestId: 'req-u' })); L.repo.deleteForPlayer('pl-adult'); };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }), /synthetic unit failure/);
  unchanged('thrown'); assert.deepEqual(held.messages.map((m) => m.id), ['m-0', 'm-1'], 'the nested array is back on the held view'); assert.equal(opened.id, 'chan-2');
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.layer.recruitment.requests.create(REQ('req-u', 'pl-adult', null)); L.repo.appendMessage('chan-1', message({ id: 'm-ok' })); L.repo.markRead('chan-1', 'counterparty', NOW + 5); try { L.repo.appendMessage('chan-2', message({ id: 'm-bad', sender: { kind: 'admin', id: 'a', name: 'b' } })); } catch (e) { caught = e; } }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /sender\.kind/); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back'); unchanged('caught');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  assert.throws(() => L.store.unitOfWork(work), /synthetic joined failure/); unchanged('statement failure at the unit\'s flush');
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_commit2 AFTER INSERT ON message_attachments BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(work), /FOREIGN KEY constraint failed/); unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER rv_commit2');
  L.store.unitOfWork(work);
  assert.deepEqual(channelIds(dir), [], 'every thread of pl-adult went (chan-1, chan-2 and the just-opened chan-u)'); assert.deepEqual(messageRows(dir), []); assert.ok(requestRow(dir, 'req-u'), 'the request added inside the unit landed with it'); assert.equal(L.repo.pending(), 0); assert.deepEqual(L.db.channels.map((c) => c.id), []);
  // Hook registration is a precondition inside the joined boundary.
  const { createChannelsRepository } = needModule();
  const bareUnit = createChannelsRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, requestExists: (id) => !!L.layer.recruitment.requests.byId(id) });
  const stagedUnit = createChannelsRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true, requestExists: (id) => !!L.layer.recruitment.requests.byId(id) });
  for (const [label, w] of [['immediate', () => bareUnit.open(channel({ id: 'chan-h', requestId: 'req-free' }))], ['staged', () => stagedUnit.open(channel({ id: 'chan-h', requestId: 'req-free' }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.layer.recruitment.requests.create(REQ('req-h', 'pl-adult', null)); try { w(); } catch (e) { c = e; } }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(requestRow(dir, 'req-h'), undefined); assert.equal(L.layer.recruitment.requests.byId('req-h'), null, 'the request added inside the refused unit is gone from a read too');
  }
  assert.throws(() => stagedUnit.open(channel({ id: 'chan-h', requestId: 'req-free' })), /save hook/); assert.throws(() => createChannelsRepository({ sqlite: L.store.sqlite, staged: true }), /needs the store's participant API/);
  L.close(); rm(dir);
});

// The review of 62e9c1a (FAILING-FIRST, recorded on the unchanged 62e9c1a tree): the restore replaced the NESTED objects of a
// channel (readBy, each message's sender and attachment, unknown nested fields) with fresh clones, so a caller holding
// channels.byId(id).readBy — not the outer channel — kept reading the failed value and never followed later commits.
test('[cutover] an ABORTED UNIT OF WORK restores the NESTED objects of a held view IN PLACE: a caller holding channels.byId(id).readBy before the unit reads the pre-unit value afterwards and the SAME object is what a fresh lookup returns, a second connection agrees, the failed receipt leaves no pending SQL, a write queued BEFORE the unit survives it and lands exactly once, and the held receipts follow the NEXT committed write — whether the unit body threw or the receipt UPDATE itself failed at the unit\'s flush; a message\'s sender and attachment keep their identity too; the immediate mode\'s own transaction restores the same way', () => {
  for (const failure of ['body', 'flush']) {
    const dir = tempDir(`ch-held-${failure}`); s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-0', attachment: clip() })] })] });
    const L = live(dir); L.save(); const file0 = fileDump(dir);
    const heldChannel = L.repo.byId('chan-1'); const heldReceipts = heldChannel.readBy; const heldSender = heldChannel.messages[0].sender; const heldAttachment = heldChannel.messages[0].attachment;
    assert.equal(heldReceipts.org, null);
    L.repo.appendMessage('chan-1', message({ id: 'm-pre' })); assert.equal(L.repo.pending(), 1, 'a write queued BEFORE the unit');
    if (failure === 'flush') L.store.sqlite.exec("CREATE TEMP TRIGGER rv_held BEFORE UPDATE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    assert.throws(() => L.store.unitOfWork(() => { L.repo.markRead('chan-1', 'org', NOW + 1); assert.equal(heldReceipts.org, NOW + 1, 'inside the unit the held receipts show the change'); if (failure === 'body') throw new Error('synthetic unit failure'); }), failure === 'body' ? /synthetic unit failure/ : /synthetic receipt failure/);
    if (failure === 'flush') L.store.sqlite.exec('DROP TRIGGER rv_held');
    const fresh = L.repo.byId('chan-1');
    assert.equal(heldReceipts.org, null, `${failure}: the held receipts object reads the pre-unit value`); assert.equal(heldReceipts.counterparty, null);
    assert.equal(fresh.readBy.org, null, `${failure}: a fresh lookup agrees`); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, null, `${failure}: a second connection agrees`);
    assert.equal(fresh.readBy, heldReceipts, `${failure}: the fresh lookup returns the SAME receipts object the caller held (restored in place, not replaced)`);
    assert.equal(fresh.messages[0].sender, heldSender, `${failure}: the sender keeps its identity`); assert.equal(fresh.messages[0].attachment, heldAttachment, `${failure}: the attachment keeps its identity`);
    assert.deepEqual(plain(heldSender), message().sender); assert.deepEqual(plain(heldAttachment), clip());
    assert.equal(L.repo.pending(), 1, `${failure}: the pre-unit write is still pending and the failed receipt left no SQL behind`); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0'], 'nothing landed yet'); assert.equal(fileDump(dir), file0);
    L.repo.markRead('chan-1', 'org', NOW + 2); L.save();
    assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-pre'], 'the pre-unit write landed with the retry'); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 2); assert.equal(L.repo.pending(), 0);
    assert.equal(heldReceipts.org, NOW + 2, `${failure}: the held receipts follow the committed write`); assert.equal(fresh.readBy.org, NOW + 2);
    L.save(); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-pre'], 'exactly once'); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 2);
    L.close(); rm(dir);
  }
  // Immediate mode (a tool, a test): the repository's own transaction restores the same objects in place.
  const dir = tempDir('ch-held-bare'); s7cFile(dir, { channels: [channel()] }); const s = openRaw(dir); migrate(s); const repo = bare(s);
  const heldReceipts = repo.byId('chan-1').readBy;
  s.exec("CREATE TEMP TRIGGER rv_bare BEFORE UPDATE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
  assert.throws(() => repo.markRead('chan-1', 'org', NOW + 1), /synthetic receipt failure/); s.exec('DROP TRIGGER rv_bare');
  assert.equal(heldReceipts.org, null, 'immediate mode: the held receipts read the pre-operation value'); assert.equal(repo.byId('chan-1').readBy, heldReceipts, 'immediate mode: the same object'); assert.equal(s.prepare('SELECT read_by_org_at AS v FROM channels').get().v, null); assert.equal(s.isTransaction, false);
  repo.markRead('chan-1', 'org', NOW + 3); assert.equal(heldReceipts.org, NOW + 3, 'immediate mode: the held receipts follow the committed write'); assert.equal(s.prepare('SELECT read_by_org_at AS v FROM channels').get().v, NOW + 3);
  s.close(); rm(dir);
});

// ============================================================= [cutover] the snapshot dispatcher and the FINAL-STATE assertion
test('[cutover] snapshot dispatcher: a tool that loads and saves the whole file round-trips every thread (typed records, both attachment shapes, order and ties) byte for byte; an unknown key in a written snapshot is dropped silently and a wrong-typed value refuses the whole save by field and id; channels OMITTED leaves the tables alone while other collections are rewritten; an explicit EMPTY array clears the threads; a malformed channels collection (an object) rolls the WHOLE save back — every other collection unchanged; an invalid entry refuses with a text-free diagnostic', () => {
  const dir = tempDir('ch-snap');
  const g = guardianChannel({ scoutName: null, messages: [message({ id: 'm-g', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, attachment: trialReport() })] });
  s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW, attachment: clip(), clientMsgId: 'c' })] }), g] });
  const tool = openStore(dir); const snap = tool.load();
  assert.equal(snap.db.channels.length, 2); assert.equal(snap.db.channels[1].scoutName, null);
  const text0 = JSON.stringify(snap.db.channels);
  tool.save(snap);
  const again = tool.load(); assert.equal(JSON.stringify(again.db.channels), text0, 'round-tripped through replace');
  // An unknown key in a written snapshot (any level) is not stored.
  const withUnknown = plain(snap.db.channels); withUnknown[0].orgUserIdForNotify = 'usr-legacy'; withUnknown[0].readBy.extra = 1; withUnknown[0].messages[1].attachment.extra = 'x';
  tool.save({ ...snap, db: { ...snap.db, channels: withUnknown } }); assert.equal(JSON.stringify(tool.load().db.channels), text0, 'unknown keys dropped silently');
  const { channels: _omit, ...without } = snap.db; tool.save({ ...snap, db: { ...without, players: without.players.map((p) => (p.id === 'pl-adult' ? { ...p, name: 'Renamed Adult' } : p)) } });
  assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g'], 'an omitted collection leaves its tables alone'); assert.equal(rowsOf(dir, 'players').find((p) => p.id === 'pl-adult').name, 'Renamed Adult', 'the other collections were rewritten');
  const beforeDump = dump(tool.sqlite);
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, channels: { id: 'x' } } }), /channels: the snapshot collection must be an array/);
  assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (the player name included)');
  const SECRET = 'SECRET-MESSAGE-TEXT-77';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, channels: [channel({ messages: [message({ text: SECRET, sender: { kind: 'admin', id: 'a', name: 'b' } })] })] } }), (e) => /CHANNELS_IMPORT_BLOCKED/.test(e.message) && /sender\.kind/.test(e.message) && !e.message.includes(SECRET));
  assert.deepEqual(dump(tool.sqlite), beforeDump);
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, channels: [channel({ scoutRole: { secret: SECRET } })] } }), (e) => /CHANNELS_IMPORT_BLOCKED/.test(e.message) && /\(chan-1\): scoutRole must be a string or null/.test(e.message) && !e.message.includes(SECRET), 'a wrong-typed value refuses by field and id');
  assert.deepEqual(dump(tool.sqlite), beforeDump);
  tool.save({ ...snap, db: { ...snap.db, channels: [] } }); assert.deepEqual(channelIds(dir), []); assert.deepEqual(messageRows(dir), []);
  tool.sqlite.close(); rm(dir);
});

test('[cutover] the FINAL-STATE assertion, every direction: channels supplied with requests omitted — valid against the RETAINED requests passes, an orphan refuses (CHANNEL_REQUEST_MISSING, nothing written); requests supplied with channels omitted — a request removed under a retained channel refuses, a set that keeps every referenced id passes; both supplied — a coordinated removal passes, an invalid combination refuses whole with unrelated collections untouched; requests supplied as an EMPTY array with retained channels refuses (absence ≠ empty); a non-array requests collection refuses; and the five guardian cases: identity pair only with a referenced guardian removed refuses atomically (every table unchanged), identity pair only with every guardian retained succeeds with channel/message order and content unchanged, identity pair and channels with a guardian and its channel removed together succeeds, an invalid coordinated replacement refuses whole, channels only with an invalid guardian refuses against the retained identity tables; an organisation removed with its channel retained refuses (the org FK at the prune), removed together with its channels succeeds', () => {
  const dir = tempDir('ch-final');
  s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW })] }), guardianChannel({ messages: [message({ id: 'm-g' })] }), soloChannel()] });
  const tool = openStore(dir); const snap = tool.load(); const base = { ...snap.db };
  const ALL = ['chan-1', 'chan-g', 'chan-solo'];
  const unchangedAfter = (fn, re, code, label) => { const before = dump(tool.sqlite); assert.throws(fn, (e) => re.test(e.message) && (!code || e.code === code), label); assert.deepEqual(dump(tool.sqlite), before, `${label}: nothing changed`); };
  const save = (db) => tool.save({ ...snap, db });
  // channels supplied, requests omitted
  const { requests: _r1, ...noRequests } = base;
  save({ ...noRequests, channels: [...base.channels] }); assert.deepEqual(channelIds(dir), ALL, 'valid against the retained requests');
  unchangedAfter(() => save({ ...noRequests, channels: [...base.channels, channel({ id: 'chan-o', requestId: 'req-orphan' })] }), /CHANNEL_REQUEST_MISSING/, undefined, 'orphan channel against the retained requests');
  // requests supplied, channels omitted
  const { channels: _c1, ...noChannels } = base;
  unchangedAfter(() => save({ ...noChannels, requests: base.requests.filter((r) => r.id !== 'req-g') }), /CHANNEL_REQUEST_MISSING[^;]*chan-g/, 'CHANNEL_REQUEST_MISSING', 'a request removed under a retained channel');
  save({ ...noChannels, requests: [...base.requests, REQ('req-new', 'pl-adult', null, { status: 'pending' })] }); assert.equal(rowsOf(dir, 'recruitment_requests').length, 5, 'a request set that keeps every referenced id passes');
  unchangedAfter(() => save({ ...noChannels, requests: [] }), /CHANNEL_REQUEST_MISSING/, 'CHANNEL_REQUEST_MISSING', 'an explicit empty requests array with retained channels (S8a: the prune names the threads that still name a request, ids only)');
  unchangedAfter(() => save({ ...noChannels, requests: 'not-an-array' }), /requests: the snapshot collection must be an array/, undefined, 'a non-array requests collection (S8a: requests are a table-backed collection; the shape check refuses before anything is dispatched)');
  // both supplied
  save({ ...base, requests: base.requests.filter((r) => r.id !== 'req-g'), channels: base.channels.filter((c) => c.id !== 'chan-g') }); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-solo'], 'a coordinated removal passes');
  const requestsNow = base.requests.filter((r) => r.id !== 'req-g'); // the current state: chan-1 only, req-1 and req-free
  unchangedAfter(() => save({ ...base, requests: requestsNow.filter((r) => r.id !== 'req-1'), channels: base.channels.filter((c) => c.id !== 'chan-g') }), /CHANNEL_REQUEST_MISSING/, 'CHANNEL_REQUEST_MISSING', 'an invalid combination (every table untouched)');
  // the five guardian cases (the guardian thread put back first, coordinated with its request)
  save({ ...base, requests: base.requests, channels: base.channels }); assert.deepEqual(channelIds(dir), ALL);
  const { channels: _c2, requests: _r2, ...identityOnly } = base;
  const textBefore = JSON.stringify(tool.load().db.channels);
  // gd-signup has no child and no co-guardian link: its removal is valid for the identity snapshot itself, so the refusal below is the channel assertion's.
  const withoutSolo = base.guardians.filter((g) => g.id !== 'gd-signup'); assert.equal(withoutSolo.length, base.guardians.length - 1);
  unchangedAfter(() => save({ ...identityOnly, players: base.players, guardians: withoutSolo }), /CHANNEL_GUARDIAN_MISSING[^;]*chan-solo/, 'CHANNEL_GUARDIAN_MISSING', '(i) identity pair only, referenced guardian removed');
  save({ ...identityOnly, players: base.players, guardians: base.guardians }); assert.equal(JSON.stringify(tool.load().db.channels), textBefore, '(ii) identity pair only, every guardian retained: the threads unchanged in order and content');
  save({ ...identityOnly, players: base.players, guardians: withoutSolo, channels: base.channels.filter((c) => c.id !== 'chan-solo'), requests: base.requests.filter((r) => r.id !== 'req-solo') }); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g'], '(iii) guardian and its channel removed together'); assert.equal(rowsOf(dir, 'guardians').some((g) => g.id === 'gd-signup'), false);
  save({ ...base }); assert.deepEqual(channelIds(dir), ALL); assert.ok(rowsOf(dir, 'guardians').some((g) => g.id === 'gd-signup'), 'the guardian is back');
  unchangedAfter(() => save({ ...identityOnly, players: base.players, guardians: withoutSolo, channels: base.channels }), /CHANNEL_GUARDIAN_MISSING[^;]*chan-solo/, 'CHANNEL_GUARDIAN_MISSING', '(iv) invalid coordinated replacement: guardian removed, its channel kept');
  unchangedAfter(() => save({ ...noRequests, channels: [...base.channels, guardianChannel({ id: 'chan-bad', requestId: 'req-free', guardianId: 'gd-missing' })] }), /CHANNEL_GUARDIAN_MISSING/, undefined, '(v) channels only with an invalid guardian, against the retained identity tables');
  // the organisation
  unchangedAfter(() => save({ ...noChannels, orgs: [] }), /no longer lists organisation org-pro but other records still reference it|RECRUITMENT_ORG_MISSING[\s\S]*organisations org-pro/, undefined, 'an organisation removed with its channel retained (S8a: the requests that name it are refused first, ids only)');
  save({ ...base, orgs: [], users: [], sessions: [], channels: [], requests: [] }); assert.deepEqual(channelIds(dir), []); assert.equal(rowsOf(dir, 'orgs').length, 0, 'an organisation removed together with its channels (and its staff and their sessions, which reference it too; since S8a the requests, which reference the organisation and its staff, go with it)');
  tool.sqlite.close(); rm(dir);
});

console.log(`\n${passed} channel checks passed`);
