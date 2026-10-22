// S7d — message threads as tables (repositories/channels.mjs, migration 0012,
// repositories/channelsRollback.mjs), the bounded storage migration the Founder
// approved through D-A (messaging first with a transitional code-checked request
// reference) and D-B (today's explicit deletion of a deleted player's threads
// reproduced; retention left open). The migration from the legacy blob (the
// channel and message literals, both attachment shapes, present legacy and unknown
// fields at every level, absent versus null, duplicate ids, a second channel for one
// request, orphan references, malformed blobs, first installation, reruns, text-free
// refusals); the actual schema (no FK on request_id/player_id/guardian_id, the org
// FK, the two internal cascades, the unique request index); the repository (open with
// the checked request reference, append in array order, receipts, deletion for a
// player, the two write modes, joined units, real COMMIT failure, hook registration, a
// failed ordinary save keeping its pending state versus an aborted unit restoring the
// pre-unit state); the snapshot dispatcher and the FINAL-STATE assertion in every
// direction (channels only, requests only, identity only, coordinated, malformed,
// absence versus empty array, parent-prune order); the copy-only rollback tool.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged b67bce5 tree before the implementation):
// the tests marked [cutover] need the 0012 migration and the repository module and FAIL
// there on concrete assertions (the migration id is absent from DATA_MIGRATIONS; the
// three tables do not exist; the channels blob survives). The tests marked [compat]
// exercise behaviour the accepted build already has and pass on both trees. The check
// named "the review of 62e9c1a" was recorded FAILING on the unchanged 62e9c1a source
// (a held nested receipts view kept the failed value after an aborted unit) before the
// repository's snapshot/restore moved to the graph memento.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
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
const MIGRATION = '0012_channels';
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'rowid') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const tableExistsIn = (dir, t) => { const s = second(dir); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); } finally { s.close(); } };
const channelIds = (dir) => (tableExistsIn(dir, 'channels') ? rowsOf(dir, 'channels', 'seq').map((r) => r.id) : null);
const messageRows = (dir) => (tableExistsIn(dir, 'messages') ? rowsOf(dir, 'messages', 'channel_id, position').map((r) => [r.channel_id, r.position, r.id, r.client_msg_id]) : null);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const CHANNEL_KEYS = ['id', 'requestId', 'playerId', 'playerName', 'orgId', 'orgName', 'orgVerified', 'scoutName', 'scoutRole', 'counterparty', 'guardianId', 'createdAt', 'messages', 'readBy'];
/** The export convention: unknown own fields FIRST, then the literal's present keys in the writer's order. */
const extrasFirst = (row, keys) => { const o = {}; for (const k of Object.keys(row)) if (!keys.includes(k)) setOwn(o, k, row[k]); for (const k of keys) if (Object.hasOwn(row, k)) o[k] = row[k]; return o; };
/** The channel literal, as openChannel writes it (an adult thread with the fixture's request req-1 of pl-adult, organisation org-pro). */
const channel = (over = {}) => ({ id: 'chan-1', requestId: 'req-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: NOW - 2 * MIN, messages: [], readBy: { org: null, counterparty: null }, ...over });
/** A guardian thread (the fixture's gd-primary, child pl-child1, request req-g). */
const guardianChannel = (over = {}) => channel({ id: 'chan-g', requestId: 'req-g', playerId: 'pl-child1', playerName: 'Child pl-child1', counterparty: 'guardian', guardianId: 'gd-primary', ...over });
/** The message literal, as postMessage writes it (`clientMsgId` present only when given). */
const message = (over = {}) => ({ id: `msg-${++counter}`, ts: NOW - MIN, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC' }, text: 'Synthetic message text.', attachment: null, ...over });
const clip = (over = {}) => ({ kind: 'clip', mediaId: 'med-1', title: 'Highlights', url: null, verifiedClip: false, ...over });
const trialReport = (over = {}) => ({ kind: 'trial_report', reportId: 'rep-1', orgName: 'Eastport FC', summary: 'accel 7/10 · 31 km/h', ...over });
/** A request in the direct route's literal (S8a: the requests are rows of recruitment_requests since 0015, so the fixture carries the writer's identifiers; `history` is an unknown field kept in extra_json). */
const REQ = (id, playerId, contactChannel, over = {}) => ({ id, playerId, playerName: playerId === 'pl-adult' ? 'Adult Signup' : `Child ${playerId}`, orgId: 'org-pro', orgName: 'Eastport FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false, userId: 'usr-1', scoutName: 'Maria', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Synthetic invitation.', trialDetails: { proposedDate: '2026-11-01', altSlots: [], venue: 'Eastport Ground', notes: '' }, status: 'accepted', createdAt: NOW - 3 * MIN, routedTo: 'player', guardianId: null, contactChannel, history: [], ...over });
const REQUESTS = () => [REQ('req-1', 'pl-adult', 'chan-1'), REQ('req-g', 'pl-child1', 'chan-g'), REQ('req-free', 'pl-adult', null), REQ('req-solo', 'pl-child2', 'chan-solo')];
const requestRow = (dir, id) => (tableExistsIn(dir, 'recruitment_requests') ? rowsOf(dir, 'recruitment_requests').find((r) => r.id === id) : undefined);
/** A guardian thread naming the fixture's CHILDLESS guardian gd-signup (removing that guardian is valid for the identity snapshot itself, so the channel assertion is what refuses). */
const soloChannel = (over = {}) => channel({ id: 'chan-solo', requestId: 'req-solo', playerId: 'pl-child2', playerName: 'Child pl-child2', counterparty: 'guardian', guardianId: 'gd-signup', ...over });

/** A file at S7c (0001–0011 applied) carrying the channels blob the way the b67bce5 build wrote it, with the requests blob the threads reference. */
function s7cFile(dir, { channels, requests = REQUESTS(), rawBlobs, extra: more = {} } = {}) {
  const extra = { requests, ledger: [], vouches: [], notifications: [], dispatches: [], ...more }; // vouches: the unrelated plain blob the snapshot tests below touch (the ledger is a table since S6b)
  if (channels !== undefined) extra.channels = channels;
  s3File(dir, { extra, rawBlobs });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id <= MIGRATION), { now, context: { sessionTtlMs: TTL } }); // up to 0012: this suite exercises the S7d step and its tool (S6b's 0013 and its tool have their own suite, testSafetyAudit.mjs)
let mod = null;
try { mod = await import('../repositories/channels.mjs'); } catch { mod = null; }
let rollbackMod = null;
try { rollbackMod = await import('../repositories/channelsRollback.mjs'); } catch { rollbackMod = null; }
const needModule = () => { assert.ok(mod, 'repositories/channels.mjs exists (the S7d repository module)'); return mod; };
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = store.load()?.db ?? {};
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, warnings, repo: layer.channels, snapshot, save: () => store.save(snapshot()), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test): own transaction per mutation. */
const bare = (s, requests = REQUESTS(), over = {}) => needModule().createChannelsRepository({ sqlite: s, now: () => NOW, requests: () => requests, ...over });

// ============================================================= [compat] what the accepted representation already does
test('[compat] the legacy blob representation: a channel record carrying a present legacy field (orgUserIdForNotify) and an unknown own key serialises them, the spread-based view keeps them, and a message without a clientMsgId has NO such key while one sent with a client id does — the absence/presence the storage move must preserve', () => {
  const legacy = JSON.parse(JSON.stringify({ ...channel(), orgUserIdForNotify: 'usr-legacy', futureField: { nested: [1] }, messages: [message({ id: 'm1' }), message({ id: 'm2', clientMsgId: 'c-1' })] }));
  const spread = { ...legacy };
  assert.equal(spread.orgUserIdForNotify, 'usr-legacy'); assert.deepEqual(spread.futureField, { nested: [1] });
  assert.equal(Object.hasOwn(legacy.messages[0], 'clientMsgId'), false); assert.equal(legacy.messages[1].clientMsgId, 'c-1');
  assert.equal(Object.hasOwn(legacy.messages[0], 'attachment'), true); assert.equal(legacy.messages[0].attachment, null);
});

// ============================================================= [cutover] the migration from the legacy blob
test('[cutover] migration 0012 is registered after 0011 and imports the channels blob losslessly: two threads (an adult and a guardian thread) with messages of all three sender kinds, both attachment shapes, a message with and one without clientMsgId, a present legacy orgUserIdForNotify, unknown own keys at channel/message/attachment/readBy/sender level (own "__proto__" keys included), an ABSENT optional key next to a present-and-null one; array order becomes seq/position; the blob row is retired; the cutover record carries counts only (no text, no name); a second run applies nothing', () => {
  const dir = tempDir('ch-mig');
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"},"constructor":"own-constructor"}');
  const adultThread = channel({ orgUserIdForNotify: 'usr-legacy', futureChannelField: [1, 2], messages: [
    message({ id: 'm-1', ts: NOW - 5 * MIN, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC', ...special }, futureMessageField: true }),
    message({ id: 'm-2', ts: NOW - 4 * MIN, sender: { kind: 'player', id: 'pl-adult', name: 'Adult Signup' }, text: 'Reply.', clientMsgId: 'client-7', attachment: clip({ futureAttachmentField: 'x' }) }),
    message({ id: 'm-3', ts: NOW - 4 * MIN, sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC' }, text: 'Same ts, later position.', attachment: trialReport() }),
  ], readBy: { org: NOW - 3 * MIN, counterparty: null, futureReadByField: 1 } });
  const gThread = { ...guardianChannel({ messages: [message({ id: 'm-g1', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' } })] }) };
  delete gThread.scoutRole; gThread.playerName = null; // ABSENT next to present-and-null
  const noAttachmentKey = message({ id: 'm-g2', sender: { kind: 'org_user', id: 'usr-1', name: 'Maria · Head of Recruitment · Eastport FC' } }); delete noAttachmentKey.attachment; gThread.messages.push(noAttachmentKey);
  s7cFile(dir, { channels: [adultThread, gThread] });
  const s = openRaw(dir);
  assert.ok(!applied(s).includes(MIGRATION)); assert.ok(blob(s, 'channels'));
  const ran = migrate(s);
  assert.ok(ran.ran.includes(MIGRATION), `0012 ran (${ran.ran.join(', ')})`); // fails on b67bce5: the id is not registered
  assert.deepEqual(applied(s).slice(-2), ['0011_outbox_push', MIGRATION]);
  for (const t of ['channels', 'messages', 'message_attachments']) assert.ok(s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `${t} exists`);
  assert.equal(blob(s, 'channels'), undefined, 'the blob row is retired');
  const ch = s.prepare('SELECT * FROM channels ORDER BY seq').all();
  assert.deepEqual(ch.map((r) => [r.id, r.request_id, r.counterparty, r.guardian_id, r.read_by_org_at, r.read_by_counterparty_at]), [['chan-1', 'req-1', 'player', null, NOW - 3 * MIN, null], ['chan-g', 'req-g', 'guardian', 'gd-primary', null, null]]);
  assert.deepEqual(JSON.parse(ch[0].extra_json), { orgUserIdForNotify: 'usr-legacy', futureChannelField: [1, 2], readBy: { futureReadByField: 1 } }, 'channel extras, readBy extras nested under the known key'); assert.equal(ch[0].absent_keys_json, null);
  assert.deepEqual(JSON.parse(ch[1].absent_keys_json), ['scoutRole'], 'the absent key is recorded'); assert.equal(ch[1].player_name, null); assert.equal(ch[1].scout_role, null);
  const ms = s.prepare('SELECT * FROM messages ORDER BY channel_id, position').all();
  assert.deepEqual(ms.map((r) => [r.channel_id, r.position, r.id, r.sender_kind, r.client_msg_id, r.created_at]), [['chan-1', 0, 'm-1', 'org_user', null, NOW - 5 * MIN], ['chan-1', 1, 'm-2', 'player', 'client-7', NOW - 4 * MIN], ['chan-1', 2, 'm-3', 'org_user', null, NOW - 4 * MIN], ['chan-g', 0, 'm-g1', 'guardian', null, NOW - MIN], ['chan-g', 1, 'm-g2', 'org_user', null, NOW - MIN]], 'array order is position; a tie on ts keeps its order');
  assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(ms[0].extra_json))), JSON.parse('{"futureMessageField":true,"sender":{"__proto__":{"legacyMarker":"keep-me"},"constructor":"own-constructor"}}'), 'message extras and sender extras (own prototype-like keys as data)');
  assert.deepEqual(JSON.parse(ms[4].absent_keys_json), ['attachment'], 'an absent attachment key is recorded; a null one is not');
  const at = s.prepare('SELECT * FROM message_attachments ORDER BY message_id').all();
  assert.deepEqual(at.map((r) => [r.message_id, r.kind, r.media_id, r.verified_clip, r.report_id, r.summary]), [['m-2', 'clip', 'med-1', 0, null, null], ['m-3', 'trial_report', null, null, 'rep-1', 'accel 7/10 · 31 km/h']]); assert.deepEqual(JSON.parse(at[0].extra_json), { futureAttachmentField: 'x' });
  const record = JSON.parse(meta(s, 'channelsCutover'));
  assert.deepEqual([record.imported, record.messages, record.attachments, record.withExtraFields, record.withAbsentKeys, record.byCounterparty], [2, 5, 2, 1, 1, { player: 1, guardian: 1 }]);
  assert.doesNotMatch(JSON.stringify(record), /Synthetic message|Maria|Reply|keep-me/, 'counts only');
  assert.deepEqual(migrate(s).ran, [], 'a second run applies nothing');
  // The way back is lossless: the exported shape equals the input, extras first, absence preserved.
  const { CHANNELS_TABLE } = needModule(); const back = CHANNELS_TABLE.read(s);
  const MK = ['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId']; const SK = ['kind', 'id', 'name']; const AK = ['kind', 'mediaId', 'title', 'url', 'verifiedClip'];
  const expectedMessages = [extrasFirst({ ...adultThread.messages[0], sender: extrasFirst(adultThread.messages[0].sender, SK) }, MK), extrasFirst({ ...adultThread.messages[1], attachment: extrasFirst(adultThread.messages[1].attachment, AK) }, MK), adultThread.messages[2]];
  assert.equal(JSON.stringify(back[0]), JSON.stringify(extrasFirst({ ...adultThread, messages: expectedMessages, readBy: { futureReadByField: 1, org: NOW - 3 * MIN, counterparty: null } }, CHANNEL_KEYS)), 'the adult thread round-trips (extras first at every level: channel, message, sender, attachment, readBy)');
  assert.ok(Object.hasOwn(back[0].messages[0].sender, '__proto__'), 'the own __proto__ key of the sender survives'); assert.equal(back[0].messages[0].sender.constructor, 'own-constructor');
  assert.equal(Object.hasOwn(back[1], 'scoutRole'), false, 'absent stays absent'); assert.equal(back[1].playerName, null, 'present-and-null stays null'); assert.equal(Object.hasOwn(back[1].messages[1], 'attachment'), false); assert.equal(back[1].messages[0].attachment, null);
  assert.equal(Object.hasOwn(back[0].messages[0], 'clientMsgId'), false); assert.equal(back[0].messages[1].clientMsgId, 'client-7');
  s.close(); rm(dir);
});

test('[cutover] migration refusals (CHANNELS_IMPORT_BLOCKED: positions, ids and reasons — never a message text): a duplicate channel id, a second channel for one request, a channel whose request is not in the requests blob, a channel whose guardian does not exist, a channel whose organisation does not exist, a sender kind outside the three, an attachment of neither shape, a present null clientMsgId, a non-finite-free but non-JSON entry (a non-array blob), a malformed requests blob behind a non-empty channels blob — each aborts the whole step: no table, the blob and saveSeq untouched; an absent blob and an empty blob import nothing and record the cutover', () => {
  const cases = [
    ['duplicate id', { channels: [channel(), channel({ requestId: 'req-free' })] }, /duplicates the id/],
    ['second channel for one request', { channels: [channel(), channel({ id: 'chan-2' })] }, /a second channel for request req-1/],
    ['request missing', { channels: [channel({ requestId: 'req-missing' })] }, /name a request that is not in the requests collection[^;]*chan-1/],
    ['guardian missing', { channels: [guardianChannel({ guardianId: 'gd-missing' })] }, /name a guardian that does not exist/],
    ['org missing', { channels: [channel({ orgId: 'org-missing' })] }, /name an organisation that does not exist/],
    ['sender kind', { channels: [channel({ messages: [message({ sender: { kind: 'admin', id: 'x', name: 'y' } })] })] }, /sender\.kind must be one of player, guardian, org_user/],
    ['attachment shape', { channels: [channel({ messages: [message({ attachment: { kind: 'file', url: 'x' } })] })] }, /attachment\.kind must be 'clip' or 'trial_report'/],
    ['null clientMsgId', { channels: [channel({ messages: [message({ clientMsgId: null })] })] }, /clientMsgId must be a non-empty string when present/],
    ['blob not an array', { rawBlobs: { channels: '{"id":"chan-1"}' } }, /must be an array of entries/],
    ['requests blob malformed', { channels: [channel()], rawBlobs: { requests: '"not-an-array"' } }, /requests collection is a string, not an array/],
  ];
  for (const [label, file, re] of cases) {
    const dir = tempDir('ch-refuse'); s7cFile(dir, file); const s = openRaw(dir);
    const before = { blob: blob(s, 'channels') ?? s.prepare("SELECT value FROM collections WHERE name = 'channels'").get()?.value, seq: meta(s, 'saveSeq') };
    assert.throws(() => migrate(s), (e) => /CHANNELS_IMPORT_BLOCKED/.test(e.message) && re.test(e.message) && !/Synthetic message text/.test(e.message), label);
    assert.ok(!applied(s).includes(MIGRATION), `${label}: not recorded`); assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels'").get(), undefined, `${label}: no table`);
    assert.deepEqual([blob(s, 'channels') ?? s.prepare("SELECT value FROM collections WHERE name = 'channels'").get()?.value, meta(s, 'saveSeq')], [before.blob, before.seq], `${label}: untouched`);
    s.close(); rm(dir);
  }
  for (const [label, file] of [['absent', {}], ['empty', { channels: [] }]]) {
    const dir = tempDir('ch-empty'); s7cFile(dir, file); const s = openRaw(dir);
    migrate(s); assert.ok(applied(s).includes(MIGRATION), label); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM channels').get().n, 0); assert.equal(blob(s, 'channels'), undefined); assert.equal(JSON.parse(meta(s, 'channelsCutover')).imported, 0);
    s.close(); rm(dir);
  }
});

test('[cutover] the actual schema: channels references orgs (RESTRICT) and nothing else — no foreign key on request_id, player_id or guardian_id (D-A: the checked reference; D-B: no lifecycle clause; the code-validated guardian); a unique index on request_id; messages → channels and message_attachments → messages CASCADE; the three sender kinds, the two counterparties and the two attachment kinds are CHECKed; the attachment CHECK ties each kind to its columns; every table STRICT', () => {
  const dir = tempDir('ch-schema'); s7cFile(dir, { channels: [] }); const s = openRaw(dir); migrate(s);
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
test('[cutover] repository, immediate mode: open appends a thread at the END with the checked request reference (a request not in the collection, a second thread for one request, a missing organisation, a missing guardian are refused by name; the array stays as it was); appendMessage keeps array order with positions and ties; markRead updates the receipt (an absent receipt key becomes present); deleteForPlayer removes the player\'s threads — guardian–club threads included — with their messages and attachments and nothing else; a refused operation inside its own transaction restores the mirror in place (held views included); reload reproduces the stored rows', () => {
  const dir = tempDir('ch-repo'); s7cFile(dir, { channels: [channel(), guardianChannel()] }); const s = openRaw(dir); migrate(s);
  const requests = REQUESTS(); const repo = bare(s, requests);
  assert.equal(repo.count(), 2); assert.deepEqual(repo.view.map((c) => c.id), ['chan-1', 'chan-g']);
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-missing' })), /CHANNEL_REQUEST_MISSING/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-1' })), /already opened thread chan-1/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', orgId: 'org-missing' })), /CHANNEL_ORG_MISSING/); assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', guardianId: 'gd-missing' })), /CHANNEL_GUARDIAN_MISSING/);
  assert.throws(() => repo.open(channel({ id: 'chan-x', requestId: 'req-free', counterparty: 'admin' })), /counterparty must be 'player' or 'guardian'/);
  assert.equal(repo.count(), 2, 'refusals leave the mirror as it was'); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g']);
  const opened = repo.open(channel({ id: 'chan-3', requestId: 'req-free', orgUserIdForNotify: 'usr-legacy' }));
  assert.equal(opened.id, 'chan-3'); assert.equal(opened.orgUserIdForNotify, 'usr-legacy'); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g', 'chan-3']); assert.throws(() => { opened.orgName = 'x'; }, /written through its domain repository/);
  const held = repo.byId('chan-1');
  const m1 = repo.appendMessage('chan-1', message({ id: 'm-1', ts: NOW })); repo.appendMessage('chan-1', message({ id: 'm-2', ts: NOW, clientMsgId: 'cid', attachment: clip() })); repo.appendMessage('chan-g', message({ id: 'm-g', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, attachment: trialReport() }));
  assert.deepEqual(held.messages.map((m) => m.id), ['m-1', 'm-2'], 'the held view sees the appended messages'); assert.equal(m1.text, 'Synthetic message text.');
  assert.deepEqual(messageRows(dir), [['chan-1', 0, 'm-1', null], ['chan-1', 1, 'm-2', 'cid'], ['chan-g', 0, 'm-g', null]]);
  assert.throws(() => repo.appendMessage('chan-1', message({ id: 'm-1' })), /already holds message m-1/); assert.throws(() => repo.appendMessage('chan-9', message()), /no thread chan-9/);
  assert.throws(() => repo.appendMessage('chan-1', message({ sender: { kind: 'admin', id: 'a', name: 'b' } })), /sender\.kind/); assert.deepEqual(held.messages.map((m) => m.id), ['m-1', 'm-2'], 'a refused append changes nothing');
  assert.deepEqual(repo.markRead('chan-1', 'org', NOW + 1), { org: NOW + 1, counterparty: null }); assert.equal(held.readBy.org, NOW + 1); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 1);
  assert.throws(() => repo.markRead('chan-1', 'admin', NOW), /'org' or 'counterparty'/); assert.throws(() => repo.markRead('chan-1', 'org', 1.5), /integer timestamp/);
  // An absent receipt key becomes present when it is written.
  const noKey = guardianChannel({ id: 'chan-nk', requestId: 'req-nk', readBy: { org: null } }); requests.push({ id: 'req-nk', playerId: 'pl-child1', status: 'accepted' }); repo.open(noKey);
  assert.equal(rowsOf(dir, 'channels', 'seq').at(-1).absent_keys_json, '["readBy.counterparty"]'); repo.markRead('chan-nk', 'counterparty', NOW + 2); assert.equal(rowsOf(dir, 'channels', 'seq').at(-1).absent_keys_json, null); assert.equal(repo.byId('chan-nk').readBy.counterparty, NOW + 2);
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
  repo.reload(); assert.deepEqual(repo.view.map((c) => c.id), ['chan-1', 'chan-3']); assert.deepEqual(repo.byId('chan-1').messages.map((m) => m.id), ['m-1', 'm-2']); assert.equal(repo.byId('chan-3').orgUserIdForNotify, 'usr-legacy');
  s.close(); rm(dir);
});

// ============================================================= [cutover] the staged mode (the server's)
test('[cutover] staged mode (the server): a thread, a message and a receipt are visible in memory at once but NOT durable ahead of the next snapshot save, which lands them in ONE revision with the blob edits made alongside (the request\'s contactChannel); a FAILED ORDINARY SAVE (statement or real COMMIT) keeps the mirror and the queue as they are — pending state retained — and the retry lands everything once; an ABORTED UNIT OF WORK restores the mirror and the queue to the pre-unit state (held views and nested message arrays included) whether the unit threw, a queued statement failed at the flush, the real COMMIT failed or a participant refusal was caught; deletion joins the unit; writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('ch-staged'); s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-0' })] })] });
  const L = live(dir); L.save(); const seq0 = seqOf(dir);
  const req = L.db.requests.find((r) => r.id === 'req-free');
  const opened = L.repo.open(channel({ id: 'chan-2', requestId: 'req-free' })); req.contactChannel = 'chan-2';
  const held = L.repo.byId('chan-1'); L.repo.appendMessage('chan-1', message({ id: 'm-1' })); L.repo.markRead('chan-1', 'org', NOW);
  assert.equal(L.repo.pending(), 3); assert.deepEqual(channelIds(dir), ['chan-1'], 'nothing durable before the save'); assert.deepEqual(L.db.channels.map((c) => c.id), ['chan-1', 'chan-2'], 'memory shows the thread at once'); assert.equal(held.messages.length, 2);
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_fx BEFORE INSERT ON channels BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(channelIds(dir), ['chan-1']); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3); assert.equal(requestRow(dir, 'req-free').contact_channel_id, null, 'the request\'s answer (a recruitment_requests row since S8a) did not land without the thread rows');
  L.store.sqlite.exec('DROP TRIGGER rv_fx');
  L.store.sqlite.exec('CREATE TEMP TABLE rv_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE rv_child (parent_id TEXT NOT NULL REFERENCES rv_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER rv_commit AFTER INSERT ON messages BEGIN INSERT INTO rv_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(channelIds(dir), ['chan-1']); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 3);
  L.store.sqlite.exec('DROP TRIGGER rv_commit');
  L.save();
  assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-2']); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-1']); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW); assert.equal(requestRow(dir, 'req-free').contact_channel_id, 'chan-2'); assert.equal(L.repo.pending(), 0);
  L.save(); assert.equal(seqOf(dir), seq0 + 2); assert.equal(messageRows(dir).length, 2, 'a later save does not replay');
  // A unit of work: together or not at all.
  L.repo.appendMessage('chan-2', message({ id: 'm-pre' })); assert.equal(L.repo.pending(), 1);
  const state = () => ({ export: plain(L.repo.exportRows()), heldMessages: held.messages.map((m) => m.id), heldRead: plain(held.readBy), requests: JSON.stringify(L.db.requests), durable: [channelIds(dir), messageRows(dir), seqOf(dir)] });
  const before = state();
  const unchanged = (label) => { assert.deepEqual(state(), before, label); assert.equal(L.repo.pending(), 1, `${label}: the pre-unit write is still pending`); assert.equal(L.store.sqlite.isTransaction, false); };
  const work = () => { L.layer.recruitment.addRequest(REQ('req-u', 'pl-adult', null)); /* S8a: the former blob push, through the recruitment repository (joins the unit) */ L.repo.appendMessage('chan-1', message({ id: 'm-u', attachment: clip() })); L.repo.markRead('chan-1', 'counterparty', NOW + 5); L.repo.open(channel({ id: 'chan-u', requestId: 'req-u' })); L.repo.deleteForPlayer('pl-adult'); };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), /synthetic unit failure/);
  unchanged('thrown'); assert.deepEqual(held.messages.map((m) => m.id), ['m-0', 'm-1'], 'the nested array is back on the held view'); assert.equal(opened.id, 'chan-2');
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.layer.recruitment.addRequest(REQ('req-u', 'pl-adult', null)); L.repo.appendMessage('chan-1', message({ id: 'm-ok' })); L.repo.markRead('chan-1', 'counterparty', NOW + 5); try { L.repo.appendMessage('chan-2', message({ id: 'm-bad', sender: { kind: 'admin', id: 'a', name: 'b' } })); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /sender\.kind/); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back'); unchanged('caught');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_j BEFORE DELETE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /synthetic joined failure/); unchanged('statement failure at the unit\'s flush');
  L.store.sqlite.exec('DROP TRIGGER rv_j');
  L.store.sqlite.exec("CREATE TEMP TRIGGER rv_commit2 AFTER INSERT ON message_attachments BEGIN INSERT INTO rv_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/); unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER rv_commit2');
  L.store.unitOfWork(work, { snapshot: L.snapshot });
  assert.equal(seqOf(dir), before.durable[2] + 1); assert.deepEqual(channelIds(dir), [], 'every thread of pl-adult went (chan-1, chan-2 and the just-opened chan-u)'); assert.deepEqual(messageRows(dir), []); assert.ok(requestRow(dir, 'req-u'), 'the request added inside the unit landed with it'); assert.equal(L.repo.pending(), 0); assert.deepEqual(L.db.channels.map((c) => c.id), []);
  // Hook registration is a precondition inside the joined boundary.
  const { createChannelsRepository } = needModule();
  const bareUnit = createChannelsRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, requests: () => L.db.requests });
  const stagedUnit = createChannelsRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true, requests: () => L.db.requests });
  for (const [label, w] of [['immediate', () => bareUnit.open(channel({ id: 'chan-h', requestId: 'req-free' }))], ['staged', () => stagedUnit.open(channel({ id: 'chan-h', requestId: 'req-free' }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.layer.recruitment.addRequest(REQ('req-h', 'pl-adult', null)); try { w(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(requestRow(dir, 'req-h'), undefined); assert.equal(L.db.requests.some((r) => r.id === 'req-h'), false, 'the request added inside the refused unit is gone from memory too');
  }
  assert.throws(() => stagedUnit.open(channel({ id: 'chan-h', requestId: 'req-free' })), /save hook/); assert.throws(() => createChannelsRepository({ sqlite: L.store.sqlite, staged: true }), /needs the store's participant API/);
  L.close(); rm(dir);
});

// The review of 62e9c1a (FAILING-FIRST, recorded on the unchanged 62e9c1a tree): the restore replaced the NESTED objects of a
// channel (readBy, each message's sender and attachment, unknown nested fields) with fresh clones, so a caller holding
// channels.byId(id).readBy — not the outer channel — kept reading the failed value and never followed later commits.
test('[cutover] an ABORTED UNIT OF WORK restores the NESTED objects of a held view IN PLACE (the review of 62e9c1a): a caller holding channels.byId(id).readBy before the unit reads the pre-unit value afterwards and the SAME object is what a fresh lookup returns, a second connection agrees, the failed receipt leaves no pending SQL, a write queued BEFORE the unit survives it and lands exactly once, and the held receipts follow the NEXT committed write — whether the unit body threw or the receipt UPDATE itself failed at the unit\'s flush; a message\'s sender and attachment and an unknown nested field keep their identity too; the immediate mode\'s own transaction restores the same way', () => {
  for (const failure of ['body', 'flush']) {
    const dir = tempDir(`ch-held-${failure}`); s7cFile(dir, { channels: [channel({ legacyMeta: { tag: 'keep-me' }, messages: [message({ id: 'm-0', attachment: clip() })] })] });
    const L = live(dir); L.save(); const seq0 = seqOf(dir);
    const heldChannel = L.repo.byId('chan-1'); const heldReceipts = heldChannel.readBy; const heldSender = heldChannel.messages[0].sender; const heldAttachment = heldChannel.messages[0].attachment; const heldExtra = heldChannel.legacyMeta;
    assert.equal(heldReceipts.org, null); assert.deepEqual(plain(heldExtra), { tag: 'keep-me' });
    L.repo.appendMessage('chan-1', message({ id: 'm-pre' })); assert.equal(L.repo.pending(), 1, 'a write queued BEFORE the unit');
    if (failure === 'flush') L.store.sqlite.exec("CREATE TEMP TRIGGER rv_held BEFORE UPDATE ON channels BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    assert.throws(() => L.store.unitOfWork(() => { L.repo.markRead('chan-1', 'org', NOW + 1); assert.equal(heldReceipts.org, NOW + 1, 'inside the unit the held receipts show the change'); if (failure === 'body') throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), failure === 'body' ? /synthetic unit failure/ : /synthetic receipt failure/);
    if (failure === 'flush') L.store.sqlite.exec('DROP TRIGGER rv_held');
    const fresh = L.repo.byId('chan-1');
    assert.equal(heldReceipts.org, null, `${failure}: the held receipts object reads the pre-unit value`); assert.equal(heldReceipts.counterparty, null);
    assert.equal(fresh.readBy.org, null, `${failure}: a fresh lookup agrees`); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, null, `${failure}: a second connection agrees`);
    assert.equal(fresh.readBy, heldReceipts, `${failure}: the fresh lookup returns the SAME receipts object the caller held (restored in place, not replaced)`);
    assert.equal(fresh.messages[0].sender, heldSender, `${failure}: the sender keeps its identity`); assert.equal(fresh.messages[0].attachment, heldAttachment, `${failure}: the attachment keeps its identity`); assert.equal(fresh.legacyMeta, heldExtra, `${failure}: the unknown nested field keeps its identity`);
    assert.deepEqual(plain(heldSender), message().sender); assert.deepEqual(plain(heldAttachment), clip()); assert.deepEqual(plain(heldExtra), { tag: 'keep-me' });
    assert.equal(L.repo.pending(), 1, `${failure}: the pre-unit write is still pending and the failed receipt left no SQL behind`); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0'], 'nothing landed yet'); assert.equal(seqOf(dir), seq0);
    L.repo.markRead('chan-1', 'org', NOW + 2); L.save();
    assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(messageRows(dir).map((r) => r[2]), ['m-0', 'm-pre'], 'the pre-unit write landed with the retry'); assert.equal(rowsOf(dir, 'channels', 'seq')[0].read_by_org_at, NOW + 2); assert.equal(L.repo.pending(), 0);
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
test('[cutover] snapshot dispatcher: a tool that loads and saves the whole file round-trips every thread (extras first, absence preserved, both attachment shapes, order and ties) byte for byte; channels OMITTED leaves the tables alone while other collections are rewritten; an explicit EMPTY array clears the threads; a malformed channels collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid entry refuses with a text-free diagnostic; the channels blob is never recreated', () => {
  const dir = tempDir('ch-snap');
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"}}');
  const g = guardianChannel({ messages: [message({ id: 'm-g', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, attachment: trialReport() })] }); delete g.scoutName;
  s7cFile(dir, { channels: [channel({ ...special, orgUserIdForNotify: 'usr-legacy', messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW, attachment: clip(), clientMsgId: 'c' })] }), g] });
  { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load();
  assert.equal(snap.db.channels.length, 2); assert.ok(Object.hasOwn(snap.db.channels[0], '__proto__')); assert.equal(snap.db.channels[0].orgUserIdForNotify, 'usr-legacy'); assert.equal(Object.hasOwn(snap.db.channels[1], 'scoutName'), false);
  const text0 = JSON.stringify(snap.db.channels);
  const seq0 = tool.revision(); tool.save(snap); assert.equal(tool.revision(), seq0 + 1);
  const again = tool.load(); assert.equal(JSON.stringify(again.db.channels), text0, 'round-tripped through replace'); assert.ok(Object.hasOwn(again.db.channels[0], '__proto__')); assert.equal(Object.hasOwn(again.db.channels[1], 'scoutName'), false);
  const { channels: _omit, ...without } = snap.db; tool.save({ ...snap, db: { ...without, vouches: [{ id: 'vch-1' }] } });
  assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g'], 'an omitted collection leaves its tables alone'); assert.equal(blobOf(dir, 'channels'), null, 'no shadow blob'); assert.equal(JSON.parse(blobOf(dir, 'vouches')).length, 1);
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, vouches: [{ id: 'vch-x' }], channels: { id: 'x' } } }), /channels: the snapshot collection must be an array/);
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (vouches included)');
  const SECRET = 'SECRET-MESSAGE-TEXT-77';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, channels: [channel({ messages: [message({ text: SECRET, sender: { kind: 'admin', id: 'a', name: 'b' } })] })] } }), (e) => /CHANNELS_IMPORT_BLOCKED/.test(e.message) && /sender\.kind/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  tool.save({ ...snap, db: { ...snap.db, channels: [] } }); assert.deepEqual(channelIds(dir), []); assert.deepEqual(messageRows(dir), []); assert.equal(blobOf(dir, 'channels'), null);
  tool.sqlite.close(); rm(dir);
});

test('[cutover] the FINAL-STATE assertion, every direction (review §11.5): channels supplied with requests omitted — valid against the RETAINED requests passes, an orphan refuses (CHANNEL_REQUEST_MISSING, nothing written); requests supplied with channels omitted — a request removed under a retained channel refuses, a set that keeps every referenced id passes; both supplied — a coordinated removal passes, an invalid combination refuses whole with unrelated collections untouched; requests supplied as an EMPTY array with retained channels refuses (absence ≠ empty); a non-array requests collection refuses; and the five guardian cases: identity pair only with a referenced guardian removed refuses atomically (tables, unrelated blobs and saveSeq unchanged), identity pair only with every guardian retained succeeds with channel/message order and content unchanged, identity pair and channels with a guardian and its channel removed together succeeds, an invalid coordinated replacement refuses whole, channels only with an invalid guardian refuses against the retained identity tables; an organisation removed with its channel retained refuses (the org FK at the prune), removed together with its channels succeeds', () => {
  const dir = tempDir('ch-final');
  s7cFile(dir, { channels: [channel({ messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW })] }), guardianChannel({ messages: [message({ id: 'm-g' })] }), soloChannel()] });
  { const s = openRaw(dir); runDataMigrations(s, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }); s.close(); } // every registered step: since S8a the requests are rows and the channel key is real, which is the final state this test asserts
  const tool = openStore(dir); const snap = tool.load(); const base = { ...snap.db }; const seqAt = () => tool.revision();
  const ALL = ['chan-1', 'chan-g', 'chan-solo'];
  const unchangedAfter = (fn, re, code, label) => { const before = dump(tool.sqlite); const seq = seqAt(); assert.throws(fn, (e) => re.test(e.message) && (!code || e.code === code), label); assert.equal(seqAt(), seq, `${label}: saveSeq unchanged`); assert.deepEqual(dump(tool.sqlite), before, `${label}: nothing changed`); };
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
  save({ ...base, requests: base.requests.filter((r) => r.id !== 'req-g'), channels: base.channels.filter((c) => c.id !== 'chan-g'), vouches: [{ id: 'vch-coord' }] }); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-solo'], 'a coordinated removal passes'); assert.equal(JSON.parse(blobOf(dir, 'vouches'))[0].id, 'vch-coord');
  const requestsNow = base.requests.filter((r) => r.id !== 'req-g'); // the current state: chan-1 only, req-1 and req-free
  unchangedAfter(() => save({ ...base, requests: requestsNow.filter((r) => r.id !== 'req-1'), channels: base.channels.filter((c) => c.id !== 'chan-g'), vouches: [{ id: 'vch-invalid' }] }), /CHANNEL_REQUEST_MISSING/, 'CHANNEL_REQUEST_MISSING', 'an invalid combination (vouches untouched)');
  assert.equal(JSON.parse(blobOf(dir, 'vouches'))[0].id, 'vch-coord', 'the unrelated collection is untouched');
  // the five guardian cases (the guardian thread put back first, coordinated with its request)
  save({ ...base, requests: base.requests, channels: base.channels }); assert.deepEqual(channelIds(dir), ALL);
  const { channels: _c2, requests: _r2, ...identityOnly } = base;
  const textBefore = JSON.stringify(tool.load().db.channels);
  // gd-signup has no child and no co-guardian link: its removal is valid for the identity snapshot itself, so the refusal below is the channel assertion's.
  const withoutSolo = base.guardians.filter((g) => g.id !== 'gd-signup'); assert.equal(withoutSolo.length, base.guardians.length - 1);
  unchangedAfter(() => save({ ...identityOnly, players: base.players, guardians: withoutSolo }), /CHANNEL_GUARDIAN_MISSING[^;]*chan-solo/, 'CHANNEL_GUARDIAN_MISSING', '(i) identity pair only, referenced guardian removed');
  save({ ...identityOnly, players: base.players, guardians: base.guardians }); assert.equal(JSON.stringify(tool.load().db.channels), textBefore, '(ii) identity pair only, every guardian retained: the threads unchanged in order and content');
  save({ ...identityOnly, players: base.players, guardians: withoutSolo, channels: base.channels.filter((c) => c.id !== 'chan-solo'), requests: base.requests.filter((r) => r.id !== 'req-solo'), vouches: [{ id: 'vch-iii' }] }); assert.deepEqual(channelIds(dir), ['chan-1', 'chan-g'], '(iii) guardian and its channel removed together'); assert.equal(rowsOf(dir, 'guardians').some((g) => g.id === 'gd-signup'), false);
  save({ ...base }); assert.deepEqual(channelIds(dir), ALL); assert.ok(rowsOf(dir, 'guardians').some((g) => g.id === 'gd-signup'), 'the guardian is back');
  unchangedAfter(() => save({ ...identityOnly, players: base.players, guardians: withoutSolo, channels: base.channels, vouches: [{ id: 'vch-iv' }] }), /CHANNEL_GUARDIAN_MISSING[^;]*chan-solo/, 'CHANNEL_GUARDIAN_MISSING', '(iv) invalid coordinated replacement: guardian removed, its channel kept');
  assert.deepEqual(JSON.parse(blobOf(dir, 'vouches')), base.vouches, '(iv) the unrelated collection is untouched (the base vouches the previous save wrote, not vch-iv)');
  unchangedAfter(() => save({ ...noRequests, channels: [...base.channels, guardianChannel({ id: 'chan-bad', requestId: 'req-free', guardianId: 'gd-missing' })] }), /CHANNEL_GUARDIAN_MISSING/, undefined, '(v) channels only with an invalid guardian, against the retained identity tables');
  // the organisation
  unchangedAfter(() => save({ ...noChannels, orgs: [] }), /no longer lists organisation org-pro but other records still reference it|RECRUITMENT_ORG_MISSING[\s\S]*organisations org-pro/, undefined, 'an organisation removed with its channel retained (S8a: the requests that name it are refused first, ids only)');
  save({ ...base, orgs: [], users: [], sessions: [], channels: [], requests: [] }); assert.deepEqual(channelIds(dir), []); assert.equal(rowsOf(dir, 'orgs').length, 0, 'an organisation removed together with its channels (and its staff and their sessions, which reference it too; since S8a the requests, which reference the organisation and its staff, go with it)');
  tool.sqlite.close(); rm(dir);
});

// ============================================================= [cutover] the copy-only rollback to the accepted pre-S7d build
test('[cutover] rollback (copy-only): every thread is written back into the channels blob in insertion order with its messages in array order (extras first, absence preserved, both attachment shapes, clientMsgId present or absent, the post-cutover thread and message included), the three tables are dropped, the 0012 record and its meta key removed, saveSeq advanced, every other table byte-identical (the S7a–S7c tables included), the source untouched; the real migration re-upgrades the copy to the same rows; the S7c tool refuses a 0012 file (LATER_SCHEMA); refusals leave no output: a later schema step (exit 4), a file that never applied 0012 (exit 5), a non-empty output directory (exit 1), a recorded 0012 whose tables are missing (exit 10), an injected COMMIT failure inside the tool', () => {
  assert.ok(rollbackMod, 'repositories/channelsRollback.mjs exists'); const { rollbackChannelsCopy } = rollbackMod;
  const { execFileSync } = awaitSync();
  const src = tempDir('ch-rb-src');
  const g = guardianChannel({ messages: [message({ id: 'm-g', sender: { kind: 'guardian', id: 'gd-primary', name: 'Primary Parent' }, attachment: trialReport() })] }); delete g.scoutName;
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"}}');
  const threads = [channel({ ...special, orgUserIdForNotify: 'usr-legacy', messages: [message({ id: 'm-1', ts: NOW }), message({ id: 'm-2', ts: NOW, attachment: clip(), clientMsgId: 'c' })] }), g];
  s7cFile(src, { channels: threads });
  { const s = openRaw(src); migrate(s); const repo = bare(s); repo.open(channel({ id: 'chan-after', requestId: 'req-free' })); repo.appendMessage('chan-after', message({ id: 'm-after' })); repo.markRead('chan-1', 'org', NOW + 7); s.close(); }
  const before = { dump: dump(openRaw(src), { except: ['channels', 'messages', 'message_attachments', 'collections', 'meta', 'data_migrations'] }), bytes: fs.statSync(dbFile(src)).size, saveSeq: seqOf(src) };
  const out = tempDir('ch-rb-out');
  const result = rollbackChannelsCopy(dbFile(src), out, { now: NOW });
  assert.equal(result.output, dbFile(out)); assert.deepEqual(result.counts, { channels: 3, messages: 4 }); assert.equal(result.recordRemoved, true); assert.equal(result.saveSeq, before.saveSeq + 1);
  assert.equal(fs.statSync(dbFile(src)).size, before.bytes, 'the source is untouched'); assert.equal(seqOf(src), before.saveSeq); assert.ok(tableExistsIn(src, 'channels'));
  const o = openRaw(out);
  assert.ok(!applied(o).includes(MIGRATION)); for (const t of ['channels', 'messages', 'message_attachments']) assert.equal(o.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined); assert.equal(meta(o, 'channelsCutover'), undefined);
  const back = blob(o, 'channels');
  assert.deepEqual(back.map((c) => c.id), ['chan-1', 'chan-g', 'chan-after']); assert.deepEqual(back[0].messages.map((m) => m.id), ['m-1', 'm-2']); assert.equal(back[0].readBy.org, NOW + 7); assert.equal(back[0].orgUserIdForNotify, 'usr-legacy'); assert.ok(Object.hasOwn(back[0], '__proto__')); assert.deepEqual(Object.keys(back[0]).slice(0, 2), ['__proto__', 'orgUserIdForNotify'], 'extras first');
  assert.equal(Object.hasOwn(back[1], 'scoutName'), false, 'absence preserved'); assert.deepEqual(back[1].messages[0].attachment, trialReport()); assert.deepEqual(back[0].messages[1].attachment, clip()); assert.equal(back[0].messages[1].clientMsgId, 'c'); assert.equal(Object.hasOwn(back[0].messages[0], 'clientMsgId'), false);
  assert.deepEqual(back[2].messages.map((m) => m.id), ['m-after'], 'the post-cutover thread and message');
  assert.equal(dump(o, { except: ['channels', 'messages', 'message_attachments', 'collections', 'meta', 'data_migrations'] }), before.dump, 'every other table byte-identical');
  // Re-upgrade: the same rows.
  const beforeUp = JSON.stringify(back); migrate(o); assert.ok(applied(o).includes(MIGRATION)); assert.equal(JSON.stringify(needModule().CHANNELS_TABLE.read(o)), beforeUp, 're-upgraded to the same rows'); assert.equal(blob(o, 'channels'), undefined);
  o.close();
  // The S7c tool refuses the 0012 file.
  try { execFileSync(process.execPath, [path.join(HERE, 'outboxPushRollback.mjs'), src, tempDir('ch-s7ctool')], { stdio: 'pipe' }); assert.fail('must refuse'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // Refusals through the CLI.
  const cli = (dir, outDir) => { try { execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), dir, outDir], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  const later = tempDir('ch-rb-later'); { fs.copyFileSync(dbFile(src), dbFile(later)); const s = openRaw(later); s.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0099_future', 1)").run(); s.close(); }
  const laterOut = tempDir('ch-rb-later-out'); assert.equal(cli(later, laterOut), 4); assert.deepEqual(fs.readdirSync(laterOut), [], 'no output');
  const never = tempDir('ch-rb-never'); s7cFile(never, { channels: [] }); const neverOut = tempDir('ch-rb-never-out'); assert.equal(cli(never, neverOut), 5); assert.deepEqual(fs.readdirSync(neverOut), []);
  const full = tempDir('ch-rb-full'); fs.writeFileSync(path.join(full, 'keep.txt'), 'x'); assert.equal(cli(src, full), 1); assert.deepEqual(fs.readdirSync(full), ['keep.txt']);
  const missing = tempDir('ch-rb-missing'); { fs.copyFileSync(dbFile(src), dbFile(missing)); const s = openRaw(missing); s.exec('DROP TABLE message_attachments; DROP TABLE messages;'); s.close(); } const missingOut = tempDir('ch-rb-missing-out'); assert.equal(cli(missing, missingOut), 10); assert.deepEqual(fs.readdirSync(missingOut), []);
  const injected = tempDir('ch-rb-inject-out');
  assert.throws(() => rollbackChannelsCopy(dbFile(src), injected, { now: NOW, _failBeforeCommit: true }), /synthetic commit failure/); assert.deepEqual(fs.readdirSync(injected), [], 'a failure removes the output');
  rm(src, out, later, laterOut, never, neverOut, full, missing, missingOut, injected);
});
function awaitSync() { return { execFileSync: (...a) => execFileSyncRef(...a) }; }
import { execFileSync as execFileSyncRef } from 'node:child_process';

console.log(`\n${passed} channel checks passed`);
