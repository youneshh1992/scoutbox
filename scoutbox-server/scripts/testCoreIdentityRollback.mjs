// Behavioural tests for the S4a rollback tool (readiness review §8):
// repositories/coreIdentityRollback.mjs and scripts/coreIdentityRollback.mjs
// produce, on a COPY, a database the pre-S4 build reads — and the real
// migration 0005 brings that copy back to the live state (round trip). Every
// database is a throwaway file with synthetic records; the tool is never
// pointed at a real data directory. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { createSessionsRepository } from '../repositories/sessions.mjs';
import { ORGS_TABLE } from '../repositories/orgs.mjs';
import { createIdentityRepositories, CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
import { CORE_IDENTITY_LIVE_MIGRATION } from '../repositories/identityPreflight.mjs';
import { rollbackCoreIdentityCopy, KNOWN_MIGRATIONS, S1_IDENTITY_SHADOW_DDL } from '../repositories/coreIdentityRollback.mjs';
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { rollbackNotificationsCopy } from '../repositories/notificationsRollback.mjs';
import { rollbackDispatchesCopy } from '../repositories/dispatchesRollback.mjs';
import { rollbackOutboxPushCopy } from '../repositories/outboxPushRollback.mjs';
import { rollbackChannelsCopy } from '../repositories/channelsRollback.mjs';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';
import { rollbackPlayerErasureCopy } from '../repositories/playerErasureRollback.mjs';
import { rollbackRecruitmentCopy } from '../repositories/recruitmentRollback.mjs';
import { rollbackRecruitmentCasesCopy } from '../repositories/recruitmentCasesRollback.mjs';
import { rollbackToPreS8c as rollbackRecruitmentContactsOffersCopy } from '../repositories/rollbackChain.mjs'; // S8d: the S8d step-back then the S8c tool, as one link (a live file carries 0018)
import { RECRUITMENT_TABLES } from '../repositories/recruitment.mjs';
import { RECRUITMENT_CASES_TABLES } from '../repositories/recruitmentCases.mjs';
import { RECRUITMENT_CONTACTS_OFFERS_TABLES } from '../repositories/recruitmentContactsOffers.mjs';
import { SIGNINGS_FOLLOWUPS_TABLES } from '../repositories/signingsFollowUps.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';
import * as m0002 from '../repositories/migrations/0002_core_identity_shadow.mjs';
import * as m0005 from '../repositories/migrations/0005_core_identity_live.mjs';
import { openStore } from '../store.mjs';
import {
  NOW, DAY, TTL, tempDir, sha256, adult, child, gSignup, FIXTURE, SESSIONS, S3_MIGRATIONS,
  s3File, freshFile, openRaw, migrate, applied, isLive, blob, blobText, meta, sessionRows, links, dump, identityDump, filesDigest,
} from './coreIdentityTestFixtures.mjs';
// S6b: a file this tree wrote carries 0013 too; the S7d tool refuses a later schema step, so the rollback chain starts with the S6b tool's copy-only output (nothing lost) and the S7d tool works on that.
const preS6b = (file) => { const s8c = tempDir('s8c-to-s8b'); rollbackRecruitmentContactsOffersCopy(file, s8c); /* S8c: the file carries 0017; its rollback (copy-only, the contacts and offers written back as blobs) goes first */ const s8b = tempDir('s8b-to-s8a'); rollbackRecruitmentCasesCopy(path.join(s8c, 'scoutbox.db'), s8b); /* then S8b: the file carries 0016; its rollback (copy-only, the cases and the four room collections written back as blobs) goes first */ const s8a = tempDir('s8a-to-s4br'); rollbackRecruitmentCopy(path.join(s8b, 'scoutbox.db'), s8a); /* then S8a (requests and trials written back as blobs) */ const s4br = tempDir('s4br-to-s6b'); rollbackPlayerErasureCopy(path.join(s8a, 'scoutbox.db'), s4br); /* then S4b-R */ const out = tempDir('s6b-to-s7d'); rollbackSafetyAuditCopy(path.join(s4br, 'scoutbox.db'), out); return path.join(out, 'scoutbox.db'); };

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
/** S5: a live file carries 0007, which the S4a tool refuses outright; the chain is the S5 rollback (copy-only, keeps everything else) and then the S4a tool on ITS output. Returns the S4a-shaped copy's directory. */
// S6a: the file carries 0008 as well; the S6a rollback (copy-only, codes invalidated, everything else kept) goes first, then the S5 tool on ITS output.
const s4aCopy = (dir) => { const s7c = tempDir('s7d-to-s7c'); rollbackChannelsCopy(preS6b(dbFile(dir)), s7c); /* S7d first: the live file carries 0012 */ const s7b = tempDir('s7c-to-s7b'); rollbackOutboxPushCopy(dbFile(s7c), s7b); const s7a = tempDir('s7b-to-s7a'); rollbackDispatchesCopy(dbFile(s7b), s7a); const s6a = tempDir('s7a-to-s6a'); rollbackNotificationsCopy(dbFile(s7a), s6a); const s5 = tempDir('s6a-to-s5'); rollbackOneTimeCodesCopy(dbFile(s6a), s5); const out = tempDir('s5-to-s4a'); rollbackPlayerSubrecordsCopy(dbFile(s5), out); return out; };
let counter = 7000;
const nextId = (p) => `${p}-${++counter}`;
/**
 * What "the source is never modified" means, measured: the main file's bytes
 * are identical and so is the logical content. SQLite's read-only open of a
 * WAL-mode database may create an EMPTY -wal and a -shm index next to the
 * source when none existed (a reader needs the index; a read-only connection
 * cannot checkpoint or remove them) — housekeeping, not content, and the next
 * ordinary open-and-close removes them, which is asserted too.
 */
function assertSourceUntouched(src, before, logicalBefore, label) {
  const after = filesDigest(src);
  assert.equal(after['scoutbox.db'], before['scoutbox.db'], `${label}: the main file is byte-identical`);
  assert.ok(after['scoutbox.db-wal'] === 'absent' || /^0 bytes/.test(after['scoutbox.db-wal']), `${label}: the WAL side file is absent or empty, never content (${after['scoutbox.db-wal']})`);
  const s = openRaw(src); assert.equal(dump(s), logicalBefore, `${label}: the logical content is unchanged`); s.close();
  assert.deepEqual(filesDigest(src), before, `${label}: after an ordinary open and close the directory is exactly as before`);
}

/**
 * An S3 file cut over by the real migration, then USED on the S4 build: the
 * identity repositories insert, update, link, unlink, age up and remove, a
 * facet is edited and saved, a session is minted, a blob changes. Returns what
 * the rollback must carry.
 */
function liveDatabaseWithHistory(dir) {
  s3File(dir);
  const s = openRaw(dir); migrate(s, { now: NOW }); s.close();
  const store = openStore(dir, { tableBacked: [...TABLE_BACKED, 'players', 'guardians'] });
  const loaded = store.load(); const db = { ...loaded.db };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW });
  const identity = layer.identity; // attached by the data layer (S4a): the same participant the server uses
  const snapshot = () => ({ savedAt: NOW + DAY, idCounter: 1200, db });
  // Post-S4 history, standalone and inside a unit of work.
  identity.guardians.insert({ id: 'gd-new', name: 'New Parent', email: 'new@example.test', password: 'scrypt$ee$ff', emailVerified: false, emailCode: 'ZZ9QQ1', idVerified: false, disclaimerAccepted: false, childIds: [] });
  identity.players.insert({ ...child('pl-new', 'gd-new', '2017-07-07'), name: 'New Child' });
  identity.players.update('pl-seeded', { name: 'Seeded Renamed', medical: { shared: false } });
  identity.guardians.update('gd-primary', { name: 'Primary Renamed', idvReference: 'idv-2' });
  identity.players.link('gd-new', 'pl-child1', 'co');
  identity.players.unlink('gd-co', 'pl-child2');
  identity.players.ageUp('pl-grown');
  identity.players.remove('pl-adult');
  identity.players.addItem('pl-seeded', 'badges', 'PostS4'); // S5: a row of player_badges
  db.guardians.find((g) => g.id === 'gd-signup').coGuardians = [{ id: 'gd-new', name: 'New Parent', email: 'new@example.test' }];
  db.vouches[0].status = 'post-s4';
  store.unitOfWork(() => { identity.players.insert({ ...child('pl-unit', 'gd-primary', '2018-02-02'), name: 'Unit Child' }); db.vouches.push({ id: 'vch-2', status: 'in-unit' }); }, { snapshot });
  const minted = layer.sessions.create('guardian', 'gd-new');
  store.save(snapshot());
  const expected = { players: JSON.parse(JSON.stringify(db.players)), guardians: JSON.parse(JSON.stringify(db.guardians)), live: identityDump(store.sqlite), sessions: sessionRows(store.sqlite), minted: minted.token, others: dump(store.sqlite, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', ...SUBRECORD_TABLES, ...RECRUITMENT_TABLES, ...RECRUITMENT_CASES_TABLES, ...RECRUITMENT_CONTACTS_OFFERS_TABLES, ...SIGNINGS_FOLLOWUPS_TABLES] }), blobs: Object.fromEntries(['users', 'sessions', 'orgs', 'vouches'].map((n) => [n, blobText(store.sqlite, n)])), saveSeq: Number(meta(store.sqlite, 'saveSeq')) };
  store.sqlite.close();
  return expected;
}

test('the S1 shadow definitions the tool restores equal migration 0002\'s, column for column and index for index', () => {
  const a = new DatabaseSync(':memory:'); a.exec('PRAGMA foreign_keys = ON;'); runDataMigrations(a, [m0002]);
  const b = new DatabaseSync(':memory:'); b.exec('PRAGMA foreign_keys = ON;'); b.exec(S1_IDENTITY_SHADOW_DDL);
  for (const t of ['guardians', 'players', 'guardian_children']) {
    const cols = (d) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}:${c.dflt_value ?? ''}`);
    assert.deepEqual(cols(b), cols(a), `${t} columns`);
    const idx = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(idx(b), idx(a), `${t} indexes`);
    const fks = (d) => d.prepare(`PRAGMA foreign_key_list(${t})`).all().map((f) => `${f.from}->${f.table}.${f.to}:${f.on_delete}`).sort();
    assert.deepEqual(fks(b), fks(a), `${t} foreign keys`);
  }
  assert.deepEqual([...KNOWN_MIGRATIONS], ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', CORE_IDENTITY_LIVE_MIGRATION, '0006_media_deletions']);
  a.close(); b.close();
});

test('rollback: the copy holds every post-S4 player, guardian and link in the two blobs (inserted present, removed gone, updates, link changes and facet edits kept, the outstanding e-mail codes plain), the S1 shadow tables empty, sessions by hash, staff, organisations and other blobs untouched, the S4 bookkeeping gone, the revision advanced; the source is unchanged (main file digest, logical content; the WAL side files are accounted for); the pre-S4 data layer reads the copy', () => {
  const src = tempDir('s4-rb-src'); const expected = liveDatabaseWithHistory(src);
  const srcBefore = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  const out = tempDir('s4-rb-out');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(src), out), (err) => err.code === 'LATER_SCHEMA' && /0007_player_subrecords/.test(err.message), 'S5: the S4a tool never accepts a file carrying 0007 (it would lose the child rows)');
  assert.deepEqual(fs.readdirSync(out), [], 'no output from the refusal');
  const s4a = s4aCopy(src);
  const result = rollbackCoreIdentityCopy(dbFile(s4a), out);
  assertSourceUntouched(src, srcBefore, logicalBefore, 'after a successful rollback');
  // The result.
  assert.equal(result.output, dbFile(out)); assert.equal(result.recordRemoved, true);
  assert.equal(result.players, 6, 'five fixture players − the removed adult + the new child + the unit child'); assert.equal(result.guardians, 4); assert.equal(result.links, 6, 'five fixture links + the new child + the co link − the unlink − the ageUp + the unit child'); assert.equal(result.sessions, 4); assert.equal(result.saveSeq, expected.saveSeq + 13, 'the S8d step advanced the revision once, the S8c tool once, the S8b tool once, the S8a tool once, the S4b-R tool once, the S6b tool once, the S7d tool once, the S7c tool once, the S7b tool once, the S7a tool once, the S6a tool once, the S5 tool once, this tool once more'); assert.ok(true, 'the S5 tool advanced the revision once, this tool once more');
  assert.deepEqual(fs.readdirSync(out), ['scoutbox.db'], 'one file, no WAL leftovers after VACUUM');
  const o = openRaw(out);
  assert.deepEqual(applied(o), ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live']);
  assert.equal(meta(o, CORE_IDENTITY_INIT_META), undefined); assert.equal(meta(o, m0005.CORE_IDENTITY_CUTOVER_META), undefined); assert.equal(Number(meta(o, 'saveSeq')), expected.saveSeq + 13); // S8d, S8c, S8b, S8a, S4b-R, S6b, S7d, S7c, S7b, S7a, S6a, S5 and this tool each advanced it once
  // The blobs: exactly what the repositories served after the history (byte-identical records, childIds in link order).
  const players = blob(o, 'players'); const guardians = blob(o, 'guardians');
  assert.equal(JSON.stringify(players), JSON.stringify(expected.players), 'the players blob equals the live view, record for record');
  assert.equal(JSON.stringify(guardians), JSON.stringify(expected.guardians), 'the guardians blob equals the live view, record for record');
  assert.deepEqual(players.map((p) => p.id), ['pl-child1', 'pl-seeded', 'pl-child2', 'pl-grown', 'pl-new', 'pl-unit'], 'the removed player is not resurrected; the inserted ones are there');
  assert.equal(players.find((p) => p.id === 'pl-seeded').name, 'Seeded Renamed'); assert.equal(players.find((p) => p.id === 'pl-seeded').medical.shared, false); assert.deepEqual(players.find((p) => p.id === 'pl-seeded').badges, ['Finisher', 'PostS4']);
  assert.equal(players.find((p) => p.id === 'pl-grown').guardianId, null, 'aged up');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-primary').childIds, ['pl-child1', 'pl-child2', 'pl-unit'], 'unlinked by ageUp, linked by the unit');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-co').childIds, ['pl-child1'], 'unlink');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-new').childIds, ['pl-new', 'pl-child1'], 'the new guardian\'s primary and co links, in link order');
  assert.equal(guardians.find((g) => g.id === 'gd-primary').name, 'Primary Renamed'); assert.equal(guardians.find((g) => g.id === 'gd-primary').idvReference, 'idv-2');
  assert.equal(guardians.find((g) => g.id === 'gd-signup').emailCode, 'K7Q2ZP', 'the outstanding code, plain'); assert.equal(guardians.find((g) => g.id === 'gd-new').emailCode, 'ZZ9QQ1');
  assert.deepEqual(guardians.find((g) => g.id === 'gd-signup').coGuardians, [{ id: 'gd-new', name: 'New Parent', email: 'new@example.test' }], 'a facet edit saved after the cutover');
  assert.equal(blobText(o, 'players').split('K7Q2ZP').length - 1, 0); assert.equal(blobText(o, 'guardians').split('K7Q2ZP').length - 1, 1, 'the code appears exactly once, in the guardians blob');
  // The tables: the S1 shadow definition, empty.
  for (const t of ['players', 'guardians', 'guardian_children']) { assert.equal(o.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} empty`); assert.equal(isLive(o, t), false, `${t} is the shadow definition`); }
  // Untouched: sessions (the minted one included), staff, organisations, other blobs (the post-S4 blob edit kept).
  assert.deepEqual(sessionRows(o), expected.sessions); assert.ok(o.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(expected.minted)));
  assert.equal(dump(o, { except: ['players', 'guardians', 'guardian_children', 'collections', 'meta', 'data_migrations', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'channels', 'messages', 'message_attachments', 'blocks', 'reports', 'moderation_log', 'org_notes', 'ledger', 'ops_events', 'source_changes', 'idv_queue', ...SUBRECORD_TABLES, ...RECRUITMENT_TABLES, ...RECRUITMENT_CASES_TABLES, ...RECRUITMENT_CONTACTS_OFFERS_TABLES, ...SIGNINGS_FOLLOWUPS_TABLES] }), expected.others);
  for (const [n, text] of Object.entries(expected.blobs)) assert.equal(blobText(o, n), text, `${n} blob untouched`);
  assert.equal(blob(o, 'vouches')[0].status, 'post-s4'); assert.equal(blob(o, 'vouches')[1].id, 'vch-2');
  assert.deepEqual(o.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(o.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  o.close();
  // The pre-S4 build's view of the copy: its registered steps (0001–0004) are all recorded (its runner applies nothing),
  // its sessions repository finds the minted session, and the snapshot store reads players and guardians as the blobs
  // and writes them back as blobs. (The real pre-S4 build is booted on a rollback copy in the verification evidence.)
  const pre = openRaw(out);
  assert.deepEqual(runDataMigrations(pre, S3_MIGRATIONS, { now: NOW + 2 * DAY, context: { sessionTtlMs: TTL } }).ran, [], 'the pre-S4 runner applies nothing to the copy');
  const sessions = createSessionsRepository({ sqlite: pre, sessionTtlMs: TTL }); sessions.attach();
  assert.equal(sessions.count(), 4); assert.ok(sessions.byToken(expected.minted), 'the session minted after the cutover works on the pre-S4 build');
  assert.equal(ORGS_TABLE.read(pre).length, 1);
  pre.close();
  const store = openStore(out); // snapshot mode: no cutover record for the identity pair, so the blobs are what it reads and writes
  const loaded = store.load();
  assert.equal(JSON.stringify(loaded.db.players), JSON.stringify(expected.players)); assert.equal(JSON.stringify(loaded.db.guardians), JSON.stringify(expected.guardians));
  const db = { ...loaded.db };
  db.players.push({ ...adult(), id: 'pl-pre-s4', name: 'Added on the pre-S4 build' });
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1300, db });
  assert.equal(blob(store.sqlite, 'players').at(-1).id, 'pl-pre-s4', 'the pre-S4 build persists players as a blob again');
  assert.equal(store.sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0, 'and never promotes the shadow table');
  store.sqlite.close();
  rm(src, out);
});

test('round trip: the real migration cuts the rollback copy over again and the live tables equal the pre-rollback live state row for row (facets included), the repositories attach and serve the same records; a record added on the pre-S4 build is imported with them', () => {
  const src = tempDir('s4-rt-src'); const expected = liveDatabaseWithHistory(src);
  const out = tempDir('s4-rt-out');
  rollbackCoreIdentityCopy(dbFile(s4aCopy(src)), out);
  const o = openRaw(out);
  migrate(o, { now: NOW + 3 * DAY });
  assert.equal(identityDump(o), expected.live, 'players, guardians and links are identical to the pre-rollback live state');
  assert.deepEqual(sessionRows(o), expected.sessions); assert.equal(meta(o, CORE_IDENTITY_INIT_META), 'done');
  const identity = createIdentityRepositories({ sqlite: o, now: () => NOW });
  identity.attach();
  assert.equal(JSON.stringify(identity.players.view), JSON.stringify(expected.players)); assert.equal(JSON.stringify(identity.guardians.view), JSON.stringify(expected.guardians));
  o.close();
  // A write on the pre-S4 build between rollback and re-upgrade (a new guardian with a child) is imported with everything else.
  const out2 = tempDir('s4-rt-out2');
  rollbackCoreIdentityCopy(dbFile(s4aCopy(src)), out2);
  const store = openStore(out2); // the pre-S4 build's snapshot store: the blobs are authoritative on the copy
  const loaded = store.load(); const db = { ...loaded.db };
  db.guardians.push({ ...gSignup(), id: 'gd-pre', email: 'pre@example.test', emailCode: 'PRE123', childIds: ['pl-pre'] });
  db.players.push(child('pl-pre', 'gd-pre', '2016-06-06'));
  db.guardians.find((g) => g.id === 'gd-signup').emailVerified = true; db.guardians.find((g) => g.id === 'gd-signup').emailCode = null; // verified on the pre-S4 build
  store.save({ savedAt: NOW + 2 * DAY, idCounter: 1300, db }); store.sqlite.close();
  const o2 = openRaw(out2);
  migrate(o2, { now: NOW + 3 * DAY });
  assert.equal(o2.prepare('SELECT COUNT(*) AS n FROM players').get().n, 7); assert.deepEqual(o2.prepare("SELECT guardian_id, role FROM guardian_children WHERE player_id = 'pl-pre'").all().map((r) => ({ ...r })), [{ guardian_id: 'gd-pre', role: 'primary' }]);
  const identity2 = createIdentityRepositories({ sqlite: o2, now: () => NOW }); identity2.attach();
  assert.equal(identity2.guardians.byId('gd-pre').emailCode, 'PRE123'); assert.equal(identity2.guardians.byId('gd-signup').emailVerified, true); assert.equal(identity2.guardians.byId('gd-signup').emailCode, null);
  o2.close(); rm(src, out, out2);
});

test('an active WAL is carried: a change still in the source\'s WAL (writer connection open, no checkpoint) is in the copy, and the tool neither checkpointed nor modified the source', () => {
  const src = tempDir('s4-rb-wal'); liveDatabaseWithHistory(src);
  const writer = openRaw(src); writer.exec('PRAGMA wal_autocheckpoint = 0;');
  writer.prepare("UPDATE players SET name = 'In The WAL' WHERE id = 'pl-seeded'").run();
  const before = filesDigest(src);
  assert.notEqual(before['scoutbox.db-wal'], 'absent'); assert.ok(!/^0 bytes/.test(before['scoutbox.db-wal']), 'the change sits in the WAL side file');
  const out = tempDir('s4-rb-wal-out');
  const result = rollbackCoreIdentityCopy(dbFile(s4aCopy(src)), out);
  assert.equal(result.players, 6);
  const after = filesDigest(src);
  assert.equal(after['scoutbox.db'], before['scoutbox.db'], 'the main file is byte-identical: the read-only open did not checkpoint');
  assert.equal(after['scoutbox.db-wal'], before['scoutbox.db-wal'], 'the WAL side file is byte-identical');
  // (The -shm index is shared memory a reader may touch; its bytes are not content and are not asserted.)
  const o = openRaw(out);
  assert.equal(blob(o, 'players').find((p) => p.id === 'pl-seeded').name, 'In The WAL', 'the copy holds the uncheckpointed change');
  o.close(); writer.close(); rm(src, out);
});

test('review (64ef3aa): an interrupted first installation — 0005 applied, coreIdentityInit still pending — is refused explicitly (INIT_PENDING, exit 6, no output, source untouched) instead of becoming an initialised-empty domain; a malformed marker is refused (INIT_STATE_INVALID, exit 7), an absent marker keeps the documented done-compatibility, and a saved empty domain still rolls back and re-upgrades as done/empty', () => {
  // Pending: a genuinely new database that applied 0005 and whose initialisation never committed.
  const pending = tempDir('s4-rb-pending'); freshFile(pending);
  let s = openRaw(pending); migrate(s, { now: NOW }); assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'pending'); s.close();
  const before = filesDigest(pending); const sIn = openRaw(pending); const logicalBefore = dump(sIn); sIn.close();
  const out = tempDir('s4-rb-pending-out');
  const pendingS4a = s4aCopy(pending);
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(pendingS4a), out), (err) => err.code === 'INIT_PENDING' && /initialisation .*has not completed|pending/.test(err.message) && /boot|retry|fresh/.test(err.message), 'refused with an actionable explanation');
  assert.deepEqual(fs.readdirSync(out), [], 'no output');
  assertSourceUntouched(pending, before, logicalBefore, 'after the pending refusal');
  const script = path.join(HERE, 'coreIdentityRollback.mjs');
  const run = (...a) => { try { execFileSync(process.execPath, [script, ...a], { stdio: 'pipe' }); return 0; } catch (err) { return err.status; } };
  assert.equal(run(pendingS4a, path.join(tempDir('s4-rb-pending-cli'), 'x')), 6, 'CLI exit 6: initialisation pending');
  // The same database, once the initialisation completes (the first boot's import), rolls back normally.
  s = openRaw(pending);
  const identity = createIdentityRepositories({ sqlite: s, now: () => NOW });
  identity.initialize({ players: [adult()], guardians: [gSignup()] }, { now: NOW }); s.close();
  const out2 = tempDir('s4-rb-pending-out2');
  const result = rollbackCoreIdentityCopy(dbFile(s4aCopy(pending)), out2);
  assert.equal(result.players, 1); assert.equal(result.guardians, 1);
  const o2 = openRaw(out2); migrate(o2, { now: NOW + DAY }); assert.equal(meta(o2, CORE_IDENTITY_INIT_META), 'done'); assert.equal(o2.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1); o2.close();
  // A malformed marker is refused, not erased or guessed.
  const odd = tempDir('s4-rb-odd-init'); liveDatabaseWithHistory(odd);
  const od = openRaw(odd); od.prepare("UPDATE meta SET value = 'maybe' WHERE key = ?").run(CORE_IDENTITY_INIT_META); od.close();
  const out3 = tempDir('s4-rb-odd-out');
  const oddS4a = s4aCopy(odd);
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(oddS4a), out3), (err) => err.code === 'INIT_STATE_INVALID' && /"maybe"/.test(err.message));
  assert.deepEqual(fs.readdirSync(out3), []);
  assert.equal(run(oddS4a, path.join(tempDir('s4-rb-odd-cli'), 'x')), 7, 'CLI exit 7: malformed initialisation marker');
  // An absent marker reads as done (the repositories' documented compatibility for a cut-over file whose marker was never written): rolled back normally.
  const absent = tempDir('s4-rb-absent-init'); liveDatabaseWithHistory(absent);
  const ab = openRaw(absent); ab.prepare('DELETE FROM meta WHERE key = ?').run(CORE_IDENTITY_INIT_META); ab.close();
  const out4 = tempDir('s4-rb-absent-out');
  assert.equal(rollbackCoreIdentityCopy(dbFile(s4aCopy(absent)), out4).players, 6);
  // Control: a legitimately saved EMPTY domain is done, rolls back and re-upgrades as done/empty.
  const empty = tempDir('s4-rb-empty'); s3File(empty, { players: [], guardians: [], sessions: [] });
  s = openRaw(empty); migrate(s, { now: NOW }); assert.equal(meta(s, CORE_IDENTITY_INIT_META), 'done'); s.close();
  const out5 = tempDir('s4-rb-empty-out');
  assert.deepEqual([rollbackCoreIdentityCopy(dbFile(s4aCopy(empty)), out5).players, rollbackCoreIdentityCopy.length], [0, 2]);
  const o5 = openRaw(out5);
  assert.deepEqual(blob(o5, 'players'), []); assert.deepEqual(blob(o5, 'guardians'), []);
  migrate(o5, { now: NOW + DAY }); assert.equal(meta(o5, CORE_IDENTITY_INIT_META), 'done'); assert.equal(o5.prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  assert.throws(() => createIdentityRepositories({ sqlite: o5, now: () => NOW }).initialize({ players: [adult()], guardians: [] }, { now: NOW }), /already initialised/);
  o5.close();
  rm(pending, out, out2, odd, out3, absent, out4, empty, out5);
});

test('refusals and failures leave no output and never touch the source: a later schema step (exit 4), a file that never cut over (exit 5), a non-empty output directory (exit 1), a recorded 0005 over shadow tables, and an injected COMMIT failure inside the tool', () => {
  const src = tempDir('s4-rb-refuse'); liveDatabaseWithHistory(src);
  const before = filesDigest(src); const sIn = openRaw(src); const logicalBefore = dump(sIn); sIn.close();
  // Later schema.
  const srcS4a = s4aCopy(src);
  const later = tempDir('s4-rb-later'); fs.copyFileSync(dbFile(srcS4a), dbFile(later));
  const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0008_future_step', 1)").run(); l.close();
  const out1 = tempDir('s4-rb-o1');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(later), out1), (err) => err.code === 'LATER_SCHEMA' && /0008_future_step/.test(err.message));
  assert.deepEqual(fs.readdirSync(out1), [], 'no output');
  // Never cut over (an S3 file).
  const s3 = tempDir('s4-rb-s3'); s3File(s3);
  const out2 = tempDir('s4-rb-o2');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(s3), out2), (err) => err.code === 'NOT_CUT_OVER');
  assert.deepEqual(fs.readdirSync(out2), []);
  // Non-empty output.
  const out3 = tempDir('s4-rb-o3'); fs.writeFileSync(path.join(out3, 'keep.txt'), 'x');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(src), out3), (err) => err.code === 'OUTPUT_NOT_EMPTY');
  assert.deepEqual(fs.readdirSync(out3), ['keep.txt'], 'nothing was written next to it');
  // A recorded 0005 whose tables are not the live definition: refused, not guessed.
  const odd = tempDir('s4-rb-odd'); s3File(odd);
  const od = openRaw(odd); od.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, 1)').run(CORE_IDENTITY_LIVE_MIGRATION); od.close();
  const out4 = tempDir('s4-rb-o4');
  assert.throws(() => rollbackCoreIdentityCopy(dbFile(odd), out4), (err) => err.code === 'UNEXPECTED_SCHEMA');
  assert.deepEqual(fs.readdirSync(out4), []);
  // An injected failure at the copy's COMMIT: the partial copy is removed.
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the rollback tool'); } return exec.call(this, sql); };
  const out5 = tempDir('s4-rb-o5');
  try { assert.throws(() => rollbackCoreIdentityCopy(dbFile(srcS4a), out5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.equal(fired, 1, 'the failure must actually have been injected');
  assert.deepEqual(fs.readdirSync(out5), [], 'no usable partial output');
  // The source after every refusal and the failure: untouched.
  assertSourceUntouched(src, before, logicalBefore, 'after the refusals and the injected failure');
  // The CLI's exit codes.
  const script = path.join(HERE, 'coreIdentityRollback.mjs');
  const run = (...a) => { try { execFileSync(process.execPath, [script, ...a], { stdio: 'pipe' }); return 0; } catch (err) { return err.status; } };
  assert.equal(run(later, path.join(tempDir('s4-rb-cli'), 'x')), 4);
  assert.equal(run(s3, path.join(tempDir('s4-rb-cli2'), 'x')), 5);
  assert.equal(run(src, out3), 1);
  assert.equal(run(src), 1, 'usage');
  assert.equal(run(src, path.join(tempDir('s4-rb-cli4'), 'x')), 4, 'CLI exit 4 on the S5 file itself: 0007 is a later step for this tool');
  const cliOut = path.join(tempDir('s4-rb-cli3'), 'copy');
  const json = JSON.parse(execFileSync(process.execPath, [script, srcS4a, cliOut, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(json.players, 6); assert.equal(json.recordRemoved, true); assert.ok(fs.existsSync(path.join(cliOut, 'scoutbox.db')));
  assertSourceUntouched(src, before, logicalBefore, 'after the CLI runs');
  rm(src, srcS4a, later, s3, odd, out1, out2, out3, out4, out5, path.dirname(cliOut));
});

console.log(`\n${passed} core-identity rollback checks passed`);
