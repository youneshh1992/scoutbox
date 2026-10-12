// S6a — one-time codes (repositories/oneTimeCodes.mjs, migration 0008,
// repositories/oneTimeCodesRollback.mjs): the migration from the legacy blobs
// and from exported rows (both formats, refusals, expired entries, missing
// collections, empty databases, reruns); the repository (hashing, expiry,
// attempts, reissue, sweep, hash-free views); the two consumption operations
// inside units of work under injected failures and real COMMIT faults, read
// back through an independent connection; concurrent redemption; the snapshot
// dispatcher (legacy versus stored format, final-state checks); the copy-only
// rollback tool and the S5 tool's refusal of an S6a file. Temporary databases
// and directories only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import {
  createOneTimeCodesRepository, hashCode, normaliseCode, validateCodeRows, EMAIL_CHALLENGE_MAX_ATTEMPTS, EMAIL_CHALLENGE_TTL_MS, PAIRING_CODE_TTL_MS,
  ONE_TIME_CODES_MIGRATION, ONE_TIME_CODES_CUTOVER_META, CODE_ALPHABET, randomCode,
} from '../repositories/oneTimeCodes.mjs';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, s3File, migrate, openRaw, applied, blob, meta, dump, filesDigest } from './coreIdentityTestFixtures.mjs';

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
const rowsOf = (dir, table) => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const tableExists = (s, t) => !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const legacyChallenge = (over = {}) => ({ orgId: 'org-pro', email: 'recruitment@eastport.test', code: 'CHAL22', expiresAt: NOW + 20 * MIN, ...over });
const legacyPairing = (over = {}) => ({ code: 'PAIR22', playerId: 'pl-child1', expiresAt: NOW + 10 * MIN, ...over });
/** A file at S5 (0001–0007 applied) carrying the code blobs the way every pre-S6a build wrote them. */
function s5File(dir, { emailChallenges, pairingCodes } = {}) {
  const extra = { requests: [], ledger: [] };
  if (emailChallenges !== undefined) extra.emailChallenges = emailChallenges;
  if (pairingCodes !== undefined) extra.pairingCodes = pairingCodes;
  s3File(dir, { extra });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < ONE_TIME_CODES_MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
/** A live server-mode store with the data layer attached at `now`. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = store.load()?.db ?? {};
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, codes: layer.codes, snapshot, close: () => store.sqlite.close() };
}

// ============================================================= migration 0008
test('migration 0008 (legacy blobs): every live entry is imported as a hash — the plain code is stored nowhere, the blob rows are retired, an expired entry is not imported and is counted, the cutover record carries counts only; the code still verifies through the repository (case and spaces normalised as the routes always did)', () => {
  const dir = tempDir('otc-mig');
  s5File(dir, { emailChallenges: [legacyChallenge(), legacyChallenge({ orgId: 'org-gone-but-expired', expiresAt: NOW - MIN })], pairingCodes: [legacyPairing(), legacyPairing({ code: 'OLD999', playerId: 'pl-child2', expiresAt: NOW - 1 })] });
  const s = openRaw(dir);
  assert.deepEqual(migrate(s, { now: NOW }).ran, [ONE_TIME_CODES_MIGRATION]);
  const challenge = s.prepare('SELECT * FROM email_challenges').all().map((r) => ({ ...r }));
  assert.deepEqual(challenge, [{ org_id: 'org-pro', email: 'recruitment@eastport.test', code_hash: hashCode('CHAL22'), expires_at: NOW + 20 * MIN, attempts: 0 }]);
  const pairing = s.prepare('SELECT * FROM pairing_codes').all().map((r) => ({ ...r }));
  assert.deepEqual(pairing, [{ code_hash: hashCode('PAIR22'), player_id: 'pl-child1', expires_at: NOW + 10 * MIN }]);
  assert.equal(blob(s, 'emailChallenges'), undefined); assert.equal(blob(s, 'pairingCodes'), undefined);
  const record = JSON.parse(meta(s, ONE_TIME_CODES_CUTOVER_META));
  assert.deepEqual(record, { at: NOW, emailChallenges: { imported: 1, droppedExpired: 1, legacy: 2, stored: 0 }, pairingCodes: { imported: 1, droppedExpired: 1, legacy: 2, stored: 0 } });
  assert.doesNotMatch(dump(s), /CHAL22|PAIR22|OLD999/, 'no plain code anywhere in the file');
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  assert.deepEqual(codes.checkEmailChallenge('org-pro', ' chal22 '), { status: 'ok', email: 'recruitment@eastport.test' });
  assert.deepEqual(codes.peekPairingCode('pair22'), { playerId: 'pl-child1' });
  s.close(); rm(dir);
});

test('migration 0008 (stored-format blobs, a backup taken after S6a): codeHash entries are imported as they are, attempts kept; a missing collection, an empty database and a first installation import nothing; a rerun is a no-op (recorded once)', () => {
  const dir = tempDir('otc-mig-stored');
  s5File(dir, { emailChallenges: [{ orgId: 'org-pro', email: 'a@b.test', codeHash: hashCode('ABC234'), expiresAt: NOW + MIN, attempts: 3 }], pairingCodes: [{ codeHash: hashCode('XYZ789'), playerId: 'pl-adult', expiresAt: NOW + MIN }] });
  let s = openRaw(dir); migrate(s, { now: NOW });
  assert.deepEqual(s.prepare('SELECT org_id, attempts FROM email_challenges').all().map((r) => ({ ...r })), [{ org_id: 'org-pro', attempts: 3 }]);
  assert.equal(s.prepare('SELECT code_hash FROM pairing_codes').get().code_hash, hashCode('XYZ789'));
  assert.deepEqual(JSON.parse(meta(s, ONE_TIME_CODES_CUTOVER_META)).pairingCodes, { imported: 1, droppedExpired: 0, legacy: 0, stored: 1 });
  assert.deepEqual(migrate(s, { now: NOW + 1 }).ran, [], 'a rerun does nothing'); assert.equal(s.prepare('SELECT COUNT(*) AS n FROM data_migrations WHERE id = ?').get(ONE_TIME_CODES_MIGRATION).n, 1);
  s.close();
  // Missing collections: an S5 file whose codes were never saved (the pairing code was never persisted by the old build at mint).
  const none = tempDir('otc-mig-none'); s5File(none);
  s = openRaw(none); migrate(s, { now: NOW });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM email_challenges').get().n + s.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get().n, 0);
  assert.deepEqual(JSON.parse(meta(s, ONE_TIME_CODES_CUTOVER_META)).emailChallenges, { imported: 0, droppedExpired: 0, legacy: 0, stored: 0 }); s.close();
  // Empty collections and a genuinely new, in-memory database.
  const empty = tempDir('otc-mig-empty'); s5File(empty, { emailChallenges: [], pairingCodes: [] });
  s = openRaw(empty); migrate(s, { now: NOW }); assert.equal(blob(s, 'pairingCodes'), undefined, 'empty blob retired too'); s.close();
  const mem = new DatabaseSync(':memory:'); mem.exec('PRAGMA foreign_keys = ON;');
  assert.ok(runDataMigrations(mem, DATA_MIGRATIONS, { now: NOW }).ran.includes(ONE_TIME_CODES_MIGRATION)); assert.ok(tableExists(mem, 'pairing_codes')); mem.close();
  rm(dir, none, empty);
});

test('migration 0008 refusals: an entry with both code and codeHash, with neither, an unknown field, a malformed hash, a non-integer expiry, negative attempts, a missing owner, a duplicate organisation or child, a duplicate code, a blob that is not JSON or not an array, a live challenge for an organisation that does not exist, a live code for a player that does not exist — each aborts the whole step with ONE_TIME_CODES_IMPORT_BLOCKED (entry and reason, never a code), creates nothing, keeps the blob byte for byte, and the next run refuses the same way', () => {
  const cases = [
    ['both formats', { pairingCodes: [{ ...legacyPairing(), codeHash: hashCode('PAIR22') }] }, /entry #0: carries both code and codeHash/],
    ['neither format', { pairingCodes: [{ playerId: 'pl-child1', expiresAt: NOW + MIN }] }, /entry #0: has neither code/],
    ['an unknown field', { emailChallenges: [{ ...legacyChallenge(), attempts: 2 }] }, /unknown field\(s\) attempts for the legacy format/],
    ['a malformed hash', { pairingCodes: [{ codeHash: 'ZZ', playerId: 'pl-child1', expiresAt: NOW + MIN }] }, /codeHash must be 64 lower-case hex/],
    ['a non-integer expiry', { pairingCodes: [legacyPairing({ expiresAt: '2026-10-12' })] }, /expiresAt must be a positive integer/],
    ['negative attempts', { emailChallenges: [{ orgId: 'org-pro', email: 'a@b.test', codeHash: hashCode('A'), expiresAt: NOW + MIN, attempts: -1 }] }, /attempts must be a non-negative integer/],
    ['a missing owner', { pairingCodes: [legacyPairing({ playerId: '' })] }, /playerId must be a non-empty string/],
    ['a duplicate child', { pairingCodes: [legacyPairing(), legacyPairing({ code: 'OTHER2' })] }, /entry #1: a second entry for playerId pl-child1/],
    ['a duplicate organisation', { emailChallenges: [legacyChallenge(), legacyChallenge({ code: 'NEWONE' })] }, /entry #1: a second entry for orgId org-pro/],
    ['a duplicate code', { pairingCodes: [legacyPairing(), legacyPairing({ playerId: 'pl-child2', code: 'pair22' })] }, /entry #1: duplicates the code of an earlier entry/],
    ['a non-array blob', { pairingCodes: { code: 'PAIR22' } }, /the pairingCodes blob must be an array/],
    ['an unknown organisation', { emailChallenges: [legacyChallenge({ orgId: 'org-nowhere' })] }, /organisation org-nowhere names an organisation that does not exist/],
    ['an unknown player', { pairingCodes: [legacyPairing({ playerId: 'pl-nowhere' })] }, /player pl-nowhere names a player that does not exist/],
  ];
  for (const [label, blobs, re] of cases) {
    const dir = tempDir('otc-refuse'); s5File(dir, blobs);
    const s = openRaw(dir);
    const before = Object.fromEntries(['emailChallenges', 'pairingCodes'].map((n) => [n, s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value]));
    let err = null; try { migrate(s, { now: NOW }); } catch (e) { err = e; }
    assert.ok(err, `${label}: must refuse`); assert.match(err.message, /ONE_TIME_CODES_IMPORT_BLOCKED/, label); assert.match(err.message, re, label);
    assert.doesNotMatch(err.message, /PAIR22|CHAL22|OTHER2|NEWONE/i, `${label}: the refusal never carries a code`);
    assert.equal(s.isTransaction, false); assert.equal(tableExists(s, 'pairing_codes') || tableExists(s, 'email_challenges'), false, `${label}: nothing created`);
    assert.equal(applied(s).includes(ONE_TIME_CODES_MIGRATION), false);
    for (const n of Object.keys(before)) assert.equal(s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value, before[n], `${label}: the ${n} blob is kept as it was`);
    assert.throws(() => migrate(s, { now: NOW }), /ONE_TIME_CODES_IMPORT_BLOCKED/, `${label}: the next run refuses the same way`);
    s.close(); rm(dir);
  }
  const notJson = tempDir('otc-refuse-json'); s5File(notJson);
  { const s = openRaw(notJson); s.prepare("INSERT INTO collections (name, value) VALUES ('pairingCodes', '{not json')").run(); assert.throws(() => migrate(s, { now: NOW }), /the pairingCodes blob is not valid JSON/); s.close(); }
  rm(notJson);
});

// ============================================================= the repository
test('repository: an issue returns the plain code once and stores its hash; a reissue replaces the previous code (one per organisation, one per child) and resets the attempts; expiry is judged on every read and the sweep removes dead rows; the views carry no code and no hash and refuse writes; codes are drawn from the documented alphabet', () => {
  const dir = tempDir('otc-repo'); s5File(dir);
  let t = NOW; const s = openRaw(dir); migrate(s, { now: NOW });
  let n = 0; const fixed = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'];
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => t, newCode: () => fixed[n++] });
  const a = codes.issueEmailChallenge('org-pro', 'x@eastport.test');
  assert.deepEqual(a, { code: 'AAAAAA', expiresAt: NOW + EMAIL_CHALLENGE_TTL_MS });
  assert.equal(s.prepare('SELECT code_hash FROM email_challenges').get().code_hash, hashCode('AAAAAA'));
  codes.noteFailedEmailAttempt('org-pro');
  const b = codes.issueEmailChallenge('org-pro', 'y@eastport.test');
  assert.equal(b.code, 'BBBBBB'); assert.deepEqual(codes.checkEmailChallenge('org-pro', 'AAAAAA').status, 'invalid', 'the replaced code no longer works');
  assert.deepEqual(s.prepare('SELECT email, attempts FROM email_challenges').all().map((r) => ({ ...r })), [{ email: 'y@eastport.test', attempts: 0 }], 'one row, attempts reset');
  const p1 = codes.issuePairingCode('pl-child1'); const p2 = codes.issuePairingCode('pl-child1');
  assert.equal(codes.peekPairingCode(p1.code), null, 'the reissued child code replaced the first'); assert.deepEqual(codes.peekPairingCode(p2.code), { playerId: 'pl-child1' });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get().n, 1);
  // The views: hash-free and read-only.
  assert.deepEqual(JSON.parse(JSON.stringify(codes.pairingCodesView)), [{ playerId: 'pl-child1', expiresAt: NOW + PAIRING_CODE_TTL_MS }]);
  assert.doesNotMatch(JSON.stringify([codes.pairingCodesView, codes.emailChallengesView]), /[0-9a-f]{64}|CCCCCC|BBBBBB/);
  assert.throws(() => codes.pairingCodesView.push({}), /written through its domain repository/);
  // Expiry: judged on read, then swept.
  t = NOW + PAIRING_CODE_TTL_MS;
  assert.equal(codes.peekPairingCode(p2.code), null, 'expired at exactly expires_at'); assert.equal(codes.consumePairingCode(p2.code), null);
  assert.deepEqual(codes.outstanding(), { emailChallenges: 1, pairingCodes: 0 });
  t = NOW + EMAIL_CHALLENGE_TTL_MS;
  assert.deepEqual(codes.checkEmailChallenge('org-pro', 'BBBBBB'), { status: 'none' }); assert.equal(codes.consumeEmailChallenge('org-pro', 'BBBBBB'), null);
  assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: 0, invalidated: false }, 'an expired challenge counts nothing');
  assert.deepEqual(codes.sweepExpired(), { emailChallenges: 1, pairingCodes: 1 }); assert.deepEqual(codes.counts(), { emailChallenges: 0, pairingCodes: 0 });
  for (let i = 0; i < 200; i++) assert.match(randomCode(), new RegExp(`^[${CODE_ALPHABET}]{6}$`));
  assert.equal(normaliseCode('  ab3 '), 'AB3');
  s.close(); rm(dir);
});

test(`repository: wrong confirmations are counted on the row (they survive a reopen); the ${EMAIL_CHALLENGE_MAX_ATTEMPTS}th wrong code invalidates the challenge, after which even the correct code is refused until a fresh one is issued`, () => {
  const dir = tempDir('otc-attempts'); s5File(dir);
  let s = openRaw(dir); migrate(s, { now: NOW });
  let codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  const { code } = codes.issueEmailChallenge('org-pro', 'x@eastport.test');
  for (let i = 1; i <= 4; i++) assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - i, invalidated: false });
  s.close(); s = openRaw(dir); codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  assert.equal(s.prepare('SELECT attempts FROM email_challenges').get().attempts, 4, 'the count survived the reopen');
  assert.deepEqual(codes.checkEmailChallenge('org-pro', 'WRONG2'), { status: 'invalid', attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - 5 });
  for (let i = 5; i < EMAIL_CHALLENGE_MAX_ATTEMPTS; i++) codes.noteFailedEmailAttempt('org-pro');
  assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: 0, invalidated: true });
  assert.deepEqual(codes.checkEmailChallenge('org-pro', code), { status: 'none' }, 'the correct code no longer works: the challenge is gone');
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM email_challenges').get().n, 0);
  s.close(); rm(dir);
});

// ============================================================= atomic consumption (units of work)
test('e-mail confirmation as one unit of work: a failure after the consumption and a failure of the real COMMIT both leave the challenge live and the organisation unverified (independent connection), memory included; the retry consumes the challenge and verifies the organisation together; the consumed code cannot be used again', () => {
  const dir = tempDir('otc-confirm'); s5File(dir);
  const L = live(dir);
  const { code } = L.codes.issueEmailChallenge('org-pro', 'scout@eastport.test');
  const confirm = (fault) => L.store.unitOfWork(() => {
    const consumed = L.codes.consumeEmailChallenge('org-pro', code);
    assert.ok(consumed);
    if (fault === 'after_consume') throw new Error('injected failure after the consumption');
    L.layer.orgs.update('org-pro', { emailDomain: consumed.email.split('@')[1], emailDomainVerified: true });
    if (fault === 'commit') L.store.failCommitOfOpenTransaction();
  }, { snapshot: L.snapshot });
  const state = () => ({ challenge: rowsOf(dir, 'email_challenges').map((r) => r.org_id), verified: rowsOf(dir, 'orgs').find((o) => o.id === 'org-pro').email_domain_verified });
  for (const [fault, re] of [['after_consume', /injected failure after the consumption/], ['commit', /FOREIGN KEY constraint failed/]]) {
    assert.throws(() => confirm(fault), re, fault);
    assert.deepEqual(state(), { challenge: ['org-pro'], verified: 0 }, `${fault}: the challenge is retained and the organisation unverified`);
    assert.equal(L.db.orgs.find((o) => o.id === 'org-pro').emailDomainVerified ?? false, false, `${fault}: memory restored`);
    assert.deepEqual(L.codes.checkEmailChallenge('org-pro', code).status, 'ok', `${fault}: the code still works`);
  }
  confirm(null);
  assert.deepEqual(state(), { challenge: [], verified: 1 });
  assert.equal(L.codes.consumeEmailChallenge('org-pro', code), null, 'single use');
  L.close(); rm(dir);
});

test('pairing as one unit of work: a failure after the consumption and a failure of the real COMMIT both leave the code live and create no session (independent connection); the retry consumes the code and creates the session together; a second exchange of the same code finds nothing', () => {
  const dir = tempDir('otc-pair'); s5File(dir);
  const L = live(dir);
  const { code } = L.codes.issuePairingCode('pl-child1');
  const sessionsOf = () => rowsOf(dir, 'sessions').filter((r) => r.kind === 'player' && r.ref_id === 'pl-child1').length;
  const before = sessionsOf();
  const pair = (fault) => L.store.unitOfWork(() => {
    const consumed = L.codes.consumePairingCode(code);
    assert.ok(consumed);
    if (fault === 'after_consume') throw new Error('injected failure after the consumption');
    const token = L.layer.sessions.create('player', consumed.playerId).token;
    if (fault === 'commit') L.store.failCommitOfOpenTransaction();
    return token;
  }, { snapshot: L.snapshot });
  for (const [fault, re] of [['after_consume', /injected failure after the consumption/], ['commit', /FOREIGN KEY constraint failed/]]) {
    assert.throws(() => pair(fault), re, fault);
    assert.equal(rowsOf(dir, 'pairing_codes').length, 1, `${fault}: the code is retained`);
    assert.equal(sessionsOf(), before, `${fault}: no session was created`);
  }
  const token = pair(null);
  assert.ok(token); assert.equal(rowsOf(dir, 'pairing_codes').length, 0); assert.equal(sessionsOf(), before + 1);
  assert.equal(L.codes.consumePairingCode(code), null, 'single use');
  L.close(); rm(dir);
});

test('concurrent redemption across two connections: both see the code, one consumes it, the other finds nothing — and a consumption that loses the race inside its own transaction throws (zero rows deleted), so its unit rolls back instead of minting a second session', () => {
  const dir = tempDir('otc-race'); s5File(dir);
  const s1 = openRaw(dir); migrate(s1, { now: NOW });
  const s2 = openRaw(dir);
  const a = createOneTimeCodesRepository({ sqlite: s1, now: () => NOW }); const b = createOneTimeCodesRepository({ sqlite: s2, now: () => NOW });
  const { code } = a.issuePairingCode('pl-child1');
  assert.deepEqual([a.peekPairingCode(code), b.peekPairingCode(code)], [{ playerId: 'pl-child1' }, { playerId: 'pl-child1' }]);
  assert.deepEqual(transaction(s1, () => a.consumePairingCode(code)), { playerId: 'pl-child1' });
  assert.equal(transaction(s2, () => b.consumePairingCode(code)), null, 'the loser re-reads and finds nothing');
  // The narrow window: connection 2 has already read the row inside its open transaction when connection 1
  // consumes it and commits. Connection 2's consumption must not succeed: SQLite refuses to upgrade its stale
  // read snapshot to a write (SQLITE_BUSY_SNAPSHOT, "database is locked"), or the DELETE finds no row and the
  // repository throws — either way its unit rolls back and no second session can be minted.
  const c2 = a.issuePairingCode('pl-child2');
  s2.exec('BEGIN');
  assert.deepEqual(b.peekPairingCode(c2.code), { playerId: 'pl-child2' }, 'connection 2 read the live row');
  assert.deepEqual(transaction(s1, () => a.consumePairingCode(c2.code)), { playerId: 'pl-child2' }, 'connection 1 consumed and committed');
  let outcome;
  try { outcome = b.consumePairingCode(c2.code); } catch (e) { outcome = e; }
  s2.exec('ROLLBACK');
  assert.ok(outcome instanceof Error || outcome === null, `the stale reader must not consume the code a second time (got ${JSON.stringify(outcome)})`);
  if (outcome instanceof Error) assert.match(outcome.message, /database is locked|could not be consumed \(0 row\(s\) deleted\)/);
  assert.equal(rowsOf(dir, 'pairing_codes').some((r) => r.player_id === 'pl-child2'), false);
  s1.close(); s2.close(); rm(dir);
});

// ============================================================= deletion
test('player deletion revokes the pairing code inside the deletion unit: a failure of the real COMMIT keeps both the player and the code; the retry removes both', () => {
  const dir = tempDir('otc-delete'); s5File(dir);
  const L = live(dir);
  L.codes.issuePairingCode('pl-child1');
  const del = (fault) => L.store.unitOfWork(() => {
    L.layer.sessions.revokeFor('player', 'pl-child1');
    L.codes.revokePairingCodesFor('pl-child1');
    L.layer.players.remove('pl-child1');
    if (fault) L.store.failCommitOfOpenTransaction();
  }, { snapshot: L.snapshot });
  assert.throws(() => del(true), /FOREIGN KEY constraint failed/);
  assert.equal(rowsOf(dir, 'pairing_codes').length, 1, 'the code survived the failed deletion'); assert.ok(rowsOf(dir, 'players').some((p) => p.id === 'pl-child1'));
  del(false);
  assert.equal(rowsOf(dir, 'pairing_codes').length, 0); assert.equal(rowsOf(dir, 'players').some((p) => p.id === 'pl-child1'), false);
  L.close(); rm(dir);
});

// ============================================================= snapshots (backups, restores, persistence suites)
test('snapshot dispatcher: a tool reads the codes in their stored form (codeHash, never a code) and writes them back through the tables; a legacy plain-code entry written by a tool is hashed on the way in; a malformed stored entry, a duplicate, a challenge for an unknown organisation, or a whole-snapshot player rewrite that drops a player a retained code names refuses the WHOLE save (nothing written, the revision not advanced); before 0008 the tool writes the blobs and the migration imports them', () => {
  const dir = tempDir('otc-snap'); s5File(dir);
  { const s = openRaw(dir); migrate(s, { now: NOW }); const c = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => 'LIVE22' }); c.issuePairingCode('pl-child1'); c.issueEmailChallenge('org-pro', 'x@eastport.test'); s.close(); }
  const tool = openStore(dir);
  let snap = tool.load();
  assert.deepEqual(snap.db.pairingCodes, [{ codeHash: hashCode('LIVE22'), playerId: 'pl-child1', expiresAt: NOW + PAIRING_CODE_TTL_MS }]);
  assert.equal(snap.db.emailChallenges[0].codeHash, hashCode('LIVE22')); assert.equal(snap.db.emailChallenges[0].attempts, 0);
  // A legacy entry from a fabricated snapshot: hashed, the plain value stored nowhere.
  snap.db.pairingCodes.push({ code: 'FIXT33', playerId: 'pl-child2', expiresAt: NOW + MIN });
  tool.save(snap);
  assert.deepEqual(tool.sqlite.prepare('SELECT player_id, code_hash FROM pairing_codes ORDER BY player_id').all().map((r) => [r.player_id, r.code_hash]), [['pl-child1', hashCode('LIVE22')], ['pl-child2', hashCode('FIXT33')]]);
  assert.doesNotMatch(dump(tool.sqlite), /FIXT33/); assert.equal(tool.sqlite.prepare("SELECT COUNT(*) AS n FROM collections WHERE name IN ('pairingCodes', 'emailChallenges')").get().n, 0, 'never a blob once the tables are live');
  const before = dump(tool.sqlite); const seq = tool.revision();
  const refused = (label, mutate, re) => {
    const s2 = tool.load(); mutate(s2.db); s2.db.notes = [{ id: 'unrelated-change' }];
    assert.throws(() => tool.save(s2), re, label);
    assert.equal(tool.sqlite.isTransaction, false); assert.equal(dump(tool.sqlite), before, `${label}: nothing changed, the unrelated edit included`); assert.equal(tool.revision(), seq);
  };
  refused('a malformed stored hash', (d) => { d.pairingCodes[0].codeHash = 'not-a-hash'; }, /ONE_TIME_CODES_IMPORT_BLOCKED.*codeHash must be 64/);
  refused('an unknown field on a stored entry', (d) => { d.pairingCodes[0].code = 'LIVE22'; }, /carries both code and codeHash/);
  refused('a duplicate child', (d) => { d.pairingCodes.push({ codeHash: hashCode('ANOTHR'), playerId: 'pl-child1', expiresAt: NOW + MIN }); }, /second entry for playerId pl-child1/);
  refused('a challenge for an unknown organisation', (d) => { d.emailChallenges[0].orgId = 'org-nowhere'; }, /EMAIL_CHALLENGE_ORG_MISSING/);
  refused('a code for a player not in the snapshot', (d) => { d.pairingCodes.push({ codeHash: hashCode('GHOST2'), playerId: 'pl-ghost', expiresAt: NOW + MIN }); }, /PAIRING_CODE_PLAYER_MISSING.*pl-ghost/);
  refused('a player rewrite that drops a player a retained code names', (d) => { delete d.pairingCodes; d.players = d.players.filter((p) => p.id !== 'pl-child2'); d.guardians.forEach((g) => { g.childIds = (g.childIds ?? []).filter((id) => id !== 'pl-child2'); }); }, /PAIRING_CODE_PLAYER_MISSING.*pl-child2/);
  refused('a non-array collection', (d) => { d.pairingCodes = { codeHash: 'x' }; }, /pairingCodes: the snapshot collection must be an array/);
  tool.sqlite.close();
  // Before 0008: the blob, then the migration imports it (the restore path of a backup taken on any build).
  const pre = tempDir('otc-snap-pre'); s5File(pre);
  const t2 = openStore(pre); const s3 = t2.load(); assert.equal(s3.db.pairingCodes, undefined, 'nothing read before the record');
  s3.db.pairingCodes = [legacyPairing()]; t2.save(s3); assert.deepEqual(blob(t2.sqlite, 'pairingCodes'), [legacyPairing()], 'written as a blob'); t2.sqlite.close();
  { const s = openRaw(pre); migrate(s, { now: NOW }); assert.equal(s.prepare('SELECT code_hash FROM pairing_codes').get().code_hash, hashCode('PAIR22')); s.close(); }
  rm(dir, pre);
});

test('boot: a stale in-memory code array (a seed container, a restored blob the migration already imported) is never imported — the table is the record; expired rows are swept at attach; the report carries counts and lifetimes, never a code or a hash', () => {
  const dir = tempDir('otc-boot'); s5File(dir, { pairingCodes: [legacyPairing(), legacyPairing({ playerId: 'pl-child2', code: 'SOON22', expiresAt: NOW + MIN })] });
  let L = live(dir); // the migration runs here, at NOW
  assert.deepEqual(L.codes.counts(), { emailChallenges: 0, pairingCodes: 2 });
  L.close();
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, pairingCodes: [{ code: 'STALE2', playerId: 'pl-adult', expiresAt: NOW + 99 * MIN }] };
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW + 2 * MIN, warn: (m) => warnings.push(m) });
  assert.ok(warnings.some((w) => /an in-memory pairingCodes array with 1 entry was ignored/.test(w)), JSON.stringify(warnings));
  assert.deepEqual(layer.boot.codes.swept, { emailChallenges: 0, pairingCodes: 1 }, 'the expired code was swept at attach');
  assert.equal(layer.codes.peekPairingCode('STALE2'), null, 'the stale array was not imported');
  const report = JSON.stringify(layer.report());
  assert.match(report, /"oneTimeCodes":\{"mode":"live","rows":\{"emailChallenges":0,"pairingCodes":1\}/); assert.doesNotMatch(report, /[0-9a-f]{64}|PAIR22/);
  store.sqlite.close(); rm(dir);
});

// ============================================================= rollback (copy-only, to the S5 build)
test('rollback: the copy-only tool writes the empty code blobs the S5 build reads, drops the two tables and the 0008 record, advances the revision, counts the outstanding codes it invalidates (and the expired rows it drops), never touches the source (digest and content), keeps organisations, players, guardians and sessions exactly; the S5 data layer attaches to the copy; the real migration re-upgrades it; the S5 tool refuses the S6a file (LATER_SCHEMA) and accepts the copy', () => {
  const src = tempDir('otc-rb-src'); s5File(src);
  { const s = openRaw(src); migrate(s, { now: NOW }); const c = createOneTimeCodesRepository({ sqlite: s, now: () => NOW }); c.issuePairingCode('pl-child1'); c.issueEmailChallenge('org-pro', 'x@eastport.test');
    s.prepare('INSERT INTO pairing_codes (code_hash, player_id, expires_at) VALUES (?, ?, ?)').run(hashCode('DEAD22'), 'pl-child2', NOW - MIN); s.close(); }
  const digest = filesDigest(src); const content = (() => { const s = openRaw(src); try { return dump(s); } finally { s.close(); } })();
  const out = tempDir('otc-rb-out');
  const result = rollbackOneTimeCodesCopy(dbFile(src), out, { now: NOW });
  assert.deepEqual(result.invalidated, { emailChallenges: 1, pairingCodes: 1 }); assert.deepEqual(result.expired, { emailChallenges: 0, pairingCodes: 1 }); assert.equal(result.recordRemoved, true);
  assert.equal(filesDigest(src)['scoutbox.db'], digest['scoutbox.db'], 'the source main file is byte-identical');
  { const s = openRaw(src); assert.equal(dump(s), content, 'the source content is unchanged'); s.close(); }
  const o = openRaw(out);
  assert.equal(tableExists(o, 'pairing_codes') || tableExists(o, 'email_challenges'), false);
  assert.equal(applied(o).includes(ONE_TIME_CODES_MIGRATION), false); assert.equal(meta(o, ONE_TIME_CODES_CUTOVER_META), undefined);
  assert.deepEqual([blob(o, 'pairingCodes'), blob(o, 'emailChallenges')], [[], []]);
  for (const t of ['players', 'guardians', 'orgs', 'sessions', 'org_users', 'guardian_children']) assert.equal(JSON.stringify(o.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()), (() => { const s = openRaw(src); try { return JSON.stringify(s.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()); } finally { s.close(); } })(), `${t} untouched`);
  assert.deepEqual(migrate(o, { now: NOW + MIN }).ran, [ONE_TIME_CODES_MIGRATION], 're-upgrade: 0008 runs again on the empty blobs'); assert.equal(o.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get().n, 0);
  o.close();
  const s5out = tempDir('otc-rb-s5'); const s5out2 = tempDir('otc-rb-s5b');
  assert.throws(() => rollbackPlayerSubrecordsCopy(dbFile(src), s5out), (err) => err.code === 'LATER_SCHEMA' && /0008_one_time_codes/.test(err.message)); assert.deepEqual(fs.readdirSync(s5out), []);
  const out2 = tempDir('otc-rb-out2'); rollbackOneTimeCodesCopy(dbFile(src), out2, { now: NOW });
  assert.equal(rollbackPlayerSubrecordsCopy(dbFile(out2), s5out2).recordRemoved, true, 'the S5 tool accepts the S6a copy');
  rm(src, out, out2, s5out, s5out2);
});

test('rollback refusals leave no output and never touch the source: a later schema step (exit 4), a file that never applied 0008 (exit 5), a non-empty output directory (exit 1), a recorded 0008 whose tables are missing (exit 10), an injected COMMIT failure inside the tool; the CLI reports the invalidated counts', () => {
  const src = tempDir('otc-rf-src'); s5File(src); { const s = openRaw(src); migrate(s, { now: NOW }); s.close(); }
  const digest = filesDigest(src);
  const script = path.join(HERE, 'oneTimeCodesRollback.mjs');
  const run = (...a) => { try { return { status: 0, out: execFileSync(process.execPath, [script, ...a], { stdio: 'pipe', encoding: 'utf8' }) }; } catch (err) { return { status: err.status }; } };
  const later = tempDir('otc-rf-later'); fs.copyFileSync(dbFile(src), dbFile(later)); { const l = openRaw(later); l.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0009_future_step', 1)").run(); l.close(); }
  const o1 = tempDir('otc-rf-o1'); assert.throws(() => rollbackOneTimeCodesCopy(dbFile(later), o1), (e) => e.code === 'LATER_SCHEMA' && /0009_future_step/.test(e.message)); assert.deepEqual(fs.readdirSync(o1), []);
  assert.equal(run(later, path.join(tempDir('otc-rf-c1'), 'x')).status, 4);
  const s5 = tempDir('otc-rf-s5'); s5File(s5);
  const o2 = tempDir('otc-rf-o2'); assert.throws(() => rollbackOneTimeCodesCopy(dbFile(s5), o2), (e) => e.code === 'NOT_CUT_OVER'); assert.equal(run(s5, path.join(tempDir('otc-rf-c2'), 'x')).status, 5);
  const o3 = tempDir('otc-rf-o3'); fs.writeFileSync(path.join(o3, 'keep.txt'), 'x'); assert.throws(() => rollbackOneTimeCodesCopy(dbFile(src), o3), (e) => e.code === 'OUTPUT_NOT_EMPTY'); assert.deepEqual(fs.readdirSync(o3), ['keep.txt']); assert.equal(run(src, o3).status, 1);
  const odd = tempDir('otc-rf-odd'); fs.copyFileSync(dbFile(src), dbFile(odd)); { const d = openRaw(odd); d.exec('DROP TABLE pairing_codes'); d.close(); }
  const o4 = tempDir('otc-rf-o4'); assert.throws(() => rollbackOneTimeCodesCopy(dbFile(odd), o4), (e) => e.code === 'UNEXPECTED_SCHEMA' && /pairing_codes/.test(e.message)); assert.equal(run(odd, path.join(tempDir('otc-rf-c4'), 'x')).status, 10);
  const proto = DatabaseSync.prototype; const exec = proto.exec; let fired = 0;
  proto.exec = function patched(sql) { if (sql === 'COMMIT' && !fired) { fired += 1; throw new Error('injected COMMIT failure in the S6a rollback tool'); } return exec.call(this, sql); };
  const o5 = tempDir('otc-rf-o5');
  try { assert.throws(() => rollbackOneTimeCodesCopy(dbFile(src), o5), /injected COMMIT failure/); } finally { proto.exec = exec; }
  assert.equal(fired, 1); assert.deepEqual(fs.readdirSync(o5), [], 'no usable partial output');
  const ok = run(src, path.join(tempDir('otc-rf-ok'), 'copy'));
  assert.equal(ok.status, 0); assert.match(ok.out, /INVALIDATED by this rollback .*0 outstanding club e-mail challenge\(s\), 0 outstanding child pairing code\(s\)/);
  assert.equal(filesDigest(src)['scoutbox.db'], digest['scoutbox.db'], 'the source was never touched');
  rm(src, later, s5, odd, o1, o2, o3, o4, o5);
});

test('collisions: two organisations may hold the same e-mail code by chance (each challenge is found by its organisation) and both import and verify; a minted pairing code equal to another child\'s live code is redrawn, never shared, and eight consecutive collisions refuse the issue with nothing written', () => {
  const dir = tempDir('otc-collide'); s5File(dir);
  let s = openRaw(dir); migrate(s, { now: NOW });
  s.prepare("INSERT INTO orgs (id, name, type, plan, facets_json) VALUES ('org-two', 'Two FC', 'club', 'Pro', '{}')").run();
  let n = 0; const draws = ['SAME22', 'SAME22', 'SAME22', 'OTHER3'];
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => draws[n++] });
  codes.issueEmailChallenge('org-pro', 'a@eastport.test'); codes.issueEmailChallenge('org-two', 'b@two.test');
  assert.equal(codes.checkEmailChallenge('org-pro', 'SAME22').status, 'ok'); assert.equal(codes.checkEmailChallenge('org-two', 'SAME22').status, 'ok');
  assert.equal(validateCodeRows('emailChallenges', codes.exportEmailChallenges()).rows.length, 2, 'the same code under two organisations is a valid export');
  const first = codes.issuePairingCode('pl-child1'); const secondCode = codes.issuePairingCode('pl-child2');
  assert.deepEqual([first.code, secondCode.code], ['SAME22', 'OTHER3'], 'the colliding draw was redrawn');
  assert.deepEqual([codes.peekPairingCode('SAME22'), codes.peekPairingCode('OTHER3')], [{ playerId: 'pl-child1' }, { playerId: 'pl-child2' }]);
  const stuck = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => 'SAME22' });
  assert.throws(() => stuck.issuePairingCode('pl-adult'), /eight consecutive draws collided/);
  assert.equal(s.prepare("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-adult'").get().n, 0, 'nothing was issued');
  s.close(); rm(dir);
});

test('validation is format-exact and never coerces: validateCodeRows reports the format counts and refuses an entry it would otherwise have to reinterpret', () => {
  assert.deepEqual(validateCodeRows('pairingCodes', [legacyPairing(), { codeHash: hashCode('B'), playerId: 'pl-x', expiresAt: 5 }]).formats, { legacy: 1, stored: 1 });
  assert.throws(() => validateCodeRows('pairingCodes', [legacyPairing({ code: 123456 })]), /code must be a non-empty string/);
  assert.throws(() => validateCodeRows('pairingCodes', [legacyPairing({ code: '   ' })]), /code must be a non-empty string/);
  assert.throws(() => validateCodeRows('emailChallenges', [legacyChallenge({ email: null })]), /email must be a non-empty string/);
  assert.throws(() => validateCodeRows('emailChallenges', [null]), /entry #0: not an object/);
  assert.throws(() => validateCodeRows('pairingCodes', [legacyPairing({ expiresAt: 1.5 })]), /expiresAt must be a positive integer/);
});

console.log(`\n${passed} one-time-code checks passed`);
