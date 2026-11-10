// One-time codes (repositories/oneTimeCodes.mjs, migration 0008): the
// fixture's refusals (the entry typing the repository exports); the repository (hashing, expiry,
// attempts, reissue, sweep, hash-free views); the two consumption operations
// inside units of work under injected failures and real COMMIT faults, read
// back through an independent connection; concurrent redemption; codes read
// back in their stored form (legacy versus stored format). Temporary
// databases and directories only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transaction } from '../repositories/database.mjs';
import { attachDataLayer, TABLE_BACKED } from '../repositories/index.mjs';
import {
  createOneTimeCodesRepository,
  hashCode,
  normaliseCode,
  EMAIL_CHALLENGE_MAX_ATTEMPTS,
  EMAIL_CHALLENGE_TTL_MS,
  PAIRING_CODE_TTL_MS,
  CODE_ALPHABET,
  randomCode,
} from '../repositories/oneTimeCodes.mjs';
import { openStore } from '../store.mjs';
import { createMailer, OUTBOX_SECRET_PLACEHOLDER } from '../adapters.mjs';
import {
  NOW,
  TTL,
  tempDir,
  FIXTURE,
  ORGS,
  USERS,
  SESSIONS,
  openRaw,
  dump,
  hasBlobTable,
} from './coreIdentityTestFixtures.mjs';
import { writeFixture } from './dataLayerFixture.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
async function testAsync(name, fn) {
  if (only && !name.includes(only)) return;
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
/** A second, independent connection: what it reads is what is committed. */
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table) => {
  const s = second(dir);
  try {
    return s
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((r) => ({ ...r }));
  } finally {
    s.close();
  }
};
/** Whether org-pro is suspended in the committed file: the unrelated edit the units below make. */
const suspendedOf = (dir) => rowsOf(dir, 'orgs').find((o) => o.id === 'org-pro').suspended;
const legacyChallenge = (over = {}) => ({
  orgId: 'org-pro',
  email: 'recruitment@eastport.test',
  code: 'CHAL22',
  expiresAt: NOW + 20 * MIN,
  ...over,
});
const legacyPairing = (over = {}) => ({ code: 'PAIR22', playerId: 'pl-child1', expiresAt: NOW + 10 * MIN, ...over });
/**
 * The code fixtures' writers: hashed rows planted directly (an issue operation mints its own code, so a fixture's code
 * cannot go through it). A fixture may give the plain `code`; only its hash is stored. A challenge names an
 * organisation (its key).
 */
const CODE_WRITERS = {
  emailChallenges: (L, records) => {
    const ins = L.sqlite.prepare(
      'INSERT INTO email_challenges (org_id, email, code_hash, expires_at, attempts) VALUES (@orgId, @email, @codeHash, @expiresAt, @attempts)',
    );
    for (const { code, ...r } of records) ins.run({ attempts: 0, ...r, codeHash: r.codeHash ?? hashCode(code) });
  },
  pairingCodes: (L, records) => {
    const ins = L.sqlite.prepare(
      'INSERT INTO pairing_codes (code_hash, player_id, expires_at) VALUES (@codeHash, @playerId, @expiresAt)',
    );
    for (const { code, ...r } of records) ins.run({ ...r, codeHash: r.codeHash ?? hashCode(code) });
  },
};
const writeCodes = (dir, collections) => writeFixture(dir, collections, { now: NOW, writers: CODE_WRITERS });
/**
 * A saved fixture: every migration applied and the fixture's staff, sessions,
 * organisations, players and guardians written through the repositories. Code
 * collections given here are written after them, in a fixture of their own, so
 * a malformed one is refused with nothing of it written.
 */
function s5File(dir, { emailChallenges, pairingCodes } = {}) {
  writeFixture(
    dir,
    { users: USERS(), sessions: SESSIONS(), orgs: ORGS(), ...FIXTURE(), requests: [], ledger: [] },
    { now: NOW, idCounter: 1000 },
  );
  const codes = {};
  if (emailChallenges !== undefined) codes.emailChallenges = emailChallenges;
  if (pairingCodes !== undefined) codes.pairingCodes = pairingCodes;
  if (Object.keys(codes).length) writeCodes(dir, codes);
}
const fileDump = (dir) => {
  const s = second(dir);
  try {
    return dump(s);
  } finally {
    s.close();
  }
};
/** The codes in their stored form, read on a second connection (opening the data layer would sweep the fixture's codes at the real clock). */
const storedCodes = (dir) => ({
  pairingCodes: rowsOf(dir, 'pairing_codes')
    .sort((a, b) => a.player_id.localeCompare(b.player_id))
    .map((r) => ({ codeHash: r.code_hash, playerId: r.player_id, expiresAt: r.expires_at })),
  emailChallenges: rowsOf(dir, 'email_challenges')
    .sort((a, b) => a.org_id.localeCompare(b.org_id))
    .map((r) => ({
      orgId: r.org_id,
      email: r.email,
      codeHash: r.code_hash,
      expiresAt: r.expires_at,
      attempts: r.attempts,
    })),
});
/** A live server-mode store with the data layer attached at `now`. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir);
  const layer = attachDataLayer({ store, nextId, sessionTtlMs: TTL, now, warn: () => {} });
  return { store, layer, codes: layer.codes, close: () => store.sqlite.close() };
}

// ============================================================= a fixture refuses junk
// ============================================================= the repository
test('repository: an issue returns the plain code once and stores its hash; a reissue replaces the previous code (one per organisation, one per child) and resets the attempts; expiry is judged on every read and the sweep removes dead rows; the views carry no code and no hash and refuse writes; codes are drawn from the documented alphabet', () => {
  const dir = tempDir('otc-repo');
  s5File(dir);
  let t = NOW;
  const s = openRaw(dir);
  let n = 0;
  const fixed = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'];
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => t, newCode: () => fixed[n++] });
  const a = codes.issueEmailChallenge('org-pro', 'x@eastport.test');
  assert.deepEqual(a, { code: 'AAAAAA', expiresAt: NOW + EMAIL_CHALLENGE_TTL_MS });
  assert.equal(s.prepare('SELECT code_hash FROM email_challenges').get().code_hash, hashCode('AAAAAA'));
  codes.noteFailedEmailAttempt('org-pro');
  const b = codes.issueEmailChallenge('org-pro', 'y@eastport.test');
  assert.equal(b.code, 'BBBBBB');
  assert.deepEqual(
    codes.checkEmailChallenge('org-pro', 'AAAAAA').status,
    'invalid',
    'the replaced code no longer works',
  );
  assert.deepEqual(
    s
      .prepare('SELECT email, attempts FROM email_challenges')
      .all()
      .map((r) => ({ ...r })),
    [{ email: 'y@eastport.test', attempts: 0 }],
    'one row, attempts reset',
  );
  const p1 = codes.issuePairingCode('pl-child1');
  const p2 = codes.issuePairingCode('pl-child1');
  assert.equal(codes.peekPairingCode(p1.code), null, 'the reissued child code replaced the first');
  assert.deepEqual(codes.peekPairingCode(p2.code), { playerId: 'pl-child1' });
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM pairing_codes').get().n, 1);
  // No plain code is stored: only its hash.
  assert.deepEqual(
    s
      .prepare('SELECT player_id, expires_at FROM pairing_codes')
      .all()
      .map((r) => ({ ...r })),
    [{ player_id: 'pl-child1', expires_at: NOW + PAIRING_CODE_TTL_MS }],
  );
  assert.doesNotMatch(
    JSON.stringify([
      ...s.prepare('SELECT * FROM pairing_codes').all(),
      ...s.prepare('SELECT * FROM email_challenges').all(),
    ]),
    /CCCCCC|BBBBBB|AAAAAA/,
  );
  // Expiry: judged on read, then swept.
  t = NOW + PAIRING_CODE_TTL_MS;
  assert.equal(codes.peekPairingCode(p2.code), null, 'expired at exactly expires_at');
  assert.equal(codes.consumePairingCode(p2.code), null);
  assert.deepEqual(codes.outstanding(), { emailChallenges: 1, pairingCodes: 0 });
  t = NOW + EMAIL_CHALLENGE_TTL_MS;
  assert.deepEqual(codes.checkEmailChallenge('org-pro', 'BBBBBB'), { status: 'none' });
  assert.equal(codes.consumeEmailChallenge('org-pro', 'BBBBBB'), null);
  assert.deepEqual(
    codes.noteFailedEmailAttempt('org-pro'),
    { attemptsRemaining: 0, invalidated: false },
    'an expired challenge counts nothing',
  );
  assert.deepEqual(codes.sweepExpired(), { emailChallenges: 1, pairingCodes: 1 });
  assert.deepEqual(codes.counts(), { emailChallenges: 0, pairingCodes: 0 });
  for (let i = 0; i < 200; i++) assert.match(randomCode(), new RegExp(`^[${CODE_ALPHABET}]{6}$`));
  assert.equal(normaliseCode('  ab3 '), 'AB3');
  s.close();
  rm(dir);
});

test(`repository: wrong confirmations are counted on the row (they survive a reopen); the ${EMAIL_CHALLENGE_MAX_ATTEMPTS}th wrong code invalidates the challenge, after which even the correct code is refused until a fresh one is issued`, () => {
  const dir = tempDir('otc-attempts');
  s5File(dir);
  let s = openRaw(dir);
  let codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  const { code } = codes.issueEmailChallenge('org-pro', 'x@eastport.test');
  for (let i = 1; i <= 4; i++)
    assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), {
      attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - i,
      invalidated: false,
    });
  s.close();
  s = openRaw(dir);
  codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  assert.equal(s.prepare('SELECT attempts FROM email_challenges').get().attempts, 4, 'the count survived the reopen');
  assert.deepEqual(codes.checkEmailChallenge('org-pro', 'WRONG2'), {
    status: 'invalid',
    attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - 5,
  });
  for (let i = 5; i < EMAIL_CHALLENGE_MAX_ATTEMPTS; i++) codes.noteFailedEmailAttempt('org-pro');
  assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: 0, invalidated: true });
  assert.deepEqual(
    codes.checkEmailChallenge('org-pro', code),
    { status: 'none' },
    'the correct code no longer works: the challenge is gone',
  );
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM email_challenges').get().n, 0);
  s.close();
  rm(dir);
});

// ============================================================= atomic consumption (units of work)
test('e-mail confirmation as one unit of work: a failure after the consumption and a failure of the real COMMIT both leave the challenge live and the organisation unverified (independent connection), memory included; the retry consumes the challenge and verifies the organisation together; the consumed code cannot be used again', () => {
  const dir = tempDir('otc-confirm');
  s5File(dir);
  const L = live(dir);
  const { code } = L.codes.issueEmailChallenge('org-pro', 'scout@eastport.test');
  const confirm = (fault) =>
    L.store.unitOfWork(() => {
      const consumed = L.codes.consumeEmailChallenge('org-pro', code);
      assert.ok(consumed);
      if (fault === 'after_consume') throw new Error('injected failure after the consumption');
      L.layer.orgs.update('org-pro', (d) => {
        d.emailDomain = consumed.email.split('@')[1];
        d.emailDomainVerified = true;
      });
      if (fault === 'commit') L.store.failCommitOfOpenTransaction();
    });
  const state = () => ({
    challenge: rowsOf(dir, 'email_challenges').map((r) => r.org_id),
    verified: rowsOf(dir, 'orgs').find((o) => o.id === 'org-pro').email_domain_verified,
  });
  for (const [fault, re] of [
    ['after_consume', /injected failure after the consumption/],
    ['commit', /FOREIGN KEY constraint failed/],
  ]) {
    assert.throws(() => confirm(fault), re, fault);
    assert.deepEqual(
      state(),
      { challenge: ['org-pro'], verified: 0 },
      `${fault}: the challenge is retained and the organisation unverified`,
    );
    assert.equal(L.layer.orgs.byId('org-pro').emailDomainVerified, false, `${fault}: nothing committed`);
    assert.deepEqual(L.codes.checkEmailChallenge('org-pro', code).status, 'ok', `${fault}: the code still works`);
  }
  confirm(null);
  assert.deepEqual(state(), { challenge: [], verified: 1 });
  assert.equal(L.codes.consumeEmailChallenge('org-pro', code), null, 'single use');
  L.close();
  rm(dir);
});

test('pairing as one unit of work: a failure after the consumption and a failure of the real COMMIT both leave the code live and create no session (independent connection); the retry consumes the code and creates the session together; a second exchange of the same code finds nothing', () => {
  const dir = tempDir('otc-pair');
  s5File(dir);
  const L = live(dir);
  const { code } = L.codes.issuePairingCode('pl-child1');
  const sessionsOf = () =>
    rowsOf(dir, 'sessions').filter((r) => r.kind === 'player' && r.ref_id === 'pl-child1').length;
  const before = sessionsOf();
  const pair = (fault) =>
    L.store.unitOfWork(() => {
      const consumed = L.codes.consumePairingCode(code);
      assert.ok(consumed);
      if (fault === 'after_consume') throw new Error('injected failure after the consumption');
      const token = L.layer.sessions.create('player', consumed.playerId).token;
      if (fault === 'commit') L.store.failCommitOfOpenTransaction();
      return token;
    });
  for (const [fault, re] of [
    ['after_consume', /injected failure after the consumption/],
    ['commit', /FOREIGN KEY constraint failed/],
  ]) {
    assert.throws(() => pair(fault), re, fault);
    assert.equal(rowsOf(dir, 'pairing_codes').length, 1, `${fault}: the code is retained`);
    assert.equal(sessionsOf(), before, `${fault}: no session was created`);
  }
  const token = pair(null);
  assert.ok(token);
  assert.equal(rowsOf(dir, 'pairing_codes').length, 0);
  assert.equal(sessionsOf(), before + 1);
  assert.equal(L.codes.consumePairingCode(code), null, 'single use');
  L.close();
  rm(dir);
});

// ============================================================= the repository joins the store's unit of work
/** Durable state read through an independent connection: the code rows and the unrelated organisation row. */
const durable = (dir) => ({
  codes: rowsOf(dir, 'pairing_codes').map((r) => r.code_hash),
  challenges: rowsOf(dir, 'email_challenges').map((r) => [r.org_id, r.attempts]),
  suspended: suspendedOf(dir),
});
/** Run `work` in a unit of work, beside an unrelated organisation edit, whose caller swallows the repository error; returns what the caller caught and what the unit threw. */
const swallowing = (L, work) => {
  let caught = null;
  let outer = null;
  try {
    L.store.unitOfWork(() => {
      L.layer.orgs.update('org-pro', (d) => {
        d.suspended = true;
      });
      try {
        work();
      } catch (e) {
        caught = e;
      }
    });
  } catch (e) {
    outer = e;
  }
  return { caught, outer };
};

test('a caught repository failure cannot commit partial work: the pairing reissue deletes the old row, then the replacement insert fails (temporary trigger) and the caller catches the error; the enclosing unit refuses to commit — the old code is kept (independent connection), the unrelated edit is rolled back in the file and in memory, no transaction is left open; the standalone control still rolls back on its own; an explicit retry lands', () => {
  const dir = tempDir('otc-joined-pair');
  s5File(dir);
  const L = live(dir);
  const first = L.codes.issuePairingCode('pl-child1');
  const before = durable(dir);
  assert.equal(before.codes.length, 1);
  L.store.sqlite.exec(
    "CREATE TEMP TRIGGER t_pair_insert BEFORE INSERT ON pairing_codes BEGIN SELECT RAISE(ABORT, 'injected pairing insert failure'); END",
  );
  // Standalone: the repository's own transaction rolls the deletion back with the failed insert.
  assert.throws(() => L.codes.issuePairingCode('pl-child1'), /injected pairing insert failure/);
  assert.deepEqual(durable(dir), before, 'standalone: the old code is kept');
  assert.equal(L.store.sqlite.isTransaction, false, 'standalone: no transaction left open');
  // Joined, and the error swallowed by the caller.
  const { caught, outer } = swallowing(L, () => L.codes.issuePairingCode('pl-child1'));
  assert.match(caught?.message ?? '', /injected pairing insert failure/, 'the operation threw into its caller');
  assert.ok(outer, 'the enclosing unit refused to commit although its work swallowed the error');
  assert.match(outer.message, /cannot commit.*injected pairing insert failure/s);
  assert.equal(outer.cause, caught, 'the unit names the swallowed error as its cause');
  assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(durable(dir), before, 'nothing durable changed: the old code and the unrelated organisation row');
  assert.ok(!L.layer.orgs.byId('org-pro').suspended, 'the unrelated edit was restored in memory');
  assert.equal(L.store.sqlite.isTransaction, false, 'no transaction left open');
  assert.equal(L.store.unitOfWorkState().active, false, 'the unit is closed');
  assert.deepEqual(L.codes.peekPairingCode(first.code), { playerId: 'pl-child1' }, 'the old code still works');
  // Retry, explicitly, once the fault is gone.
  L.store.sqlite.exec('DROP TRIGGER t_pair_insert');
  const retry = L.store.unitOfWork(() => L.codes.issuePairingCode('pl-child1'));
  assert.equal(rowsOf(dir, 'pairing_codes').length, 1);
  assert.equal(L.codes.peekPairingCode(first.code), null, 'replaced');
  assert.deepEqual(L.codes.peekPairingCode(retry.code), { playerId: 'pl-child1' });
  L.close();
  rm(dir);
});

test('e-mail side, a multi-statement operation that already wrote: the tenth wrong attempt increments the count, then the cancellation fails (temporary trigger on the delete); standalone the count stays at nine; inside a unit whose caller catches the error the whole unit rolls back — nine in the file, the unrelated edit rolled back, no transaction open; the retry cancels the challenge', () => {
  const dir = tempDir('otc-joined-mail');
  s5File(dir);
  const L = live(dir);
  const { code } = L.codes.issueEmailChallenge('org-pro', 'x@eastport.test');
  for (let i = 1; i < EMAIL_CHALLENGE_MAX_ATTEMPTS; i++) L.codes.noteFailedEmailAttempt('org-pro');
  const before = durable(dir);
  assert.deepEqual(before.challenges, [['org-pro', EMAIL_CHALLENGE_MAX_ATTEMPTS - 1]]);
  L.store.sqlite.exec(
    "CREATE TEMP TRIGGER t_mail_delete BEFORE DELETE ON email_challenges BEGIN SELECT RAISE(ABORT, 'injected challenge delete failure'); END",
  );
  assert.throws(() => L.codes.noteFailedEmailAttempt('org-pro'), /injected challenge delete failure/);
  assert.deepEqual(durable(dir), before, 'standalone: the increment went back with the failed cancellation');
  assert.equal(L.store.sqlite.isTransaction, false);
  const { caught, outer } = swallowing(L, () => L.codes.noteFailedEmailAttempt('org-pro'));
  assert.match(caught?.message ?? '', /injected challenge delete failure/);
  assert.ok(outer, 'the enclosing unit refused to commit');
  assert.match(outer.message, /cannot commit.*injected challenge delete failure/s);
  assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(durable(dir), before, 'the count is still nine, the organisation row unchanged');
  assert.ok(!L.layer.orgs.byId('org-pro').suspended, 'memory restored');
  assert.equal(L.store.sqlite.isTransaction, false);
  assert.equal(L.store.unitOfWorkState().active, false);
  assert.deepEqual(
    L.codes.checkEmailChallenge('org-pro', code),
    { status: 'ok', email: 'x@eastport.test' },
    'the challenge is still live at nine',
  );
  L.store.sqlite.exec('DROP TRIGGER t_mail_delete');
  assert.deepEqual(
    L.store.unitOfWork(() => L.codes.noteFailedEmailAttempt('org-pro')),
    { attemptsRemaining: 0, invalidated: true },
    'the retry cancels the challenge',
  );
  assert.deepEqual(rowsOf(dir, 'email_challenges'), []);
  assert.deepEqual(L.codes.checkEmailChallenge('org-pro', code), { status: 'none' });
  L.close();
  rm(dir);
});

test('the boundary itself: joined successes commit with the unit (issue, consume and an unrelated edit, one transaction); an uncaught failure rolls back as before; expected negative results stay return values and never poison a unit; a validation failure is part of the operation (caught inside a unit, it still poisons the unit); a raw SQLite transaction a tool opened is honoured without a nested BEGIN and is not mistaken for a unit (its ROLLBACK undoes the operation); a malformed participant API is refused at construction', () => {
  const dir = tempDir('otc-joined-edge');
  s5File(dir);
  const L = live(dir);
  // Joined successes: the unrelated edit is an organisation row, and the BEGINs are counted.
  const exec = L.store.sqlite.exec.bind(L.store.sqlite);
  let begins = 0;
  L.store.sqlite.exec = (sql) => {
    if (/^BEGIN/.test(sql)) begins += 1;
    return exec(sql);
  };
  const issued = L.store.unitOfWork(() => {
    const p = L.codes.issuePairingCode('pl-child1');
    L.layer.orgs.update('org-pro', (d) => {
      d.suspended = true;
    });
    assert.deepEqual(L.codes.consumePairingCode(p.code), { playerId: 'pl-child1' });
    return p;
  });
  L.store.sqlite.exec = exec;
  assert.ok(issued.code);
  assert.deepEqual(rowsOf(dir, 'pairing_codes'), []);
  assert.equal(suspendedOf(dir), 1);
  assert.equal(begins, 1, 'one transaction');
  // An uncaught failure.
  assert.throws(
    () =>
      L.store.unitOfWork(() => {
        L.codes.issuePairingCode('pl-child1');
        L.layer.orgs.update('org-pro', (d) => {
          d.suspended = false;
        });
        throw new Error('ordinary failure');
      }),
    /ordinary failure/,
  );
  assert.deepEqual(rowsOf(dir, 'pairing_codes'), []);
  assert.equal(suspendedOf(dir), 1);
  // Expected negatives inside a unit are results, not failures: the unit commits.
  L.store.unitOfWork(() => {
    assert.equal(L.codes.consumePairingCode('NOPE22'), null);
    assert.equal(L.codes.consumeEmailChallenge('org-pro', 'NOPE22'), null);
    assert.deepEqual(L.codes.checkEmailChallenge('org-pro', 'NOPE22'), { status: 'none' });
    assert.deepEqual(L.codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: 0, invalidated: false });
    assert.equal(L.codes.revokePairingCodesFor('pl-nobody'), 0);
    assert.equal(L.codes.revokeEmailChallenge('org-pro'), 0);
    assert.deepEqual(L.codes.sweepExpired(), { emailChallenges: 0, pairingCodes: 0 });
    L.layer.orgs.update('org-pro', (d) => {
      d.suspended = false;
    });
  });
  assert.equal(suspendedOf(dir), 0, 'the edit after the negatives committed');
  // Validation is inside the boundary.
  const v = swallowing(L, () => L.codes.issuePairingCode(''));
  assert.match(v.caught?.message ?? '', /player id/);
  assert.ok(v.outer, 'a caught validation failure still poisons the unit');
  assert.match(v.outer.message, /cannot commit.*player id/s);
  assert.equal(suspendedOf(dir), 0, 'the unrelated edit did not commit');
  // A raw transaction on the store's connection, outside any unit (a tool, a test): honoured, no BEGIN of its own, no unit inferred.
  L.store.sqlite.exec('BEGIN');
  const raw = L.codes.issuePairingCode('pl-child1');
  assert.equal(L.store.sqlite.isTransaction, true, 'the caller still owns the transaction');
  assert.equal(L.store.unitOfWorkState().active, false, 'not a unit');
  assert.deepEqual(L.codes.peekPairingCode(raw.code), { playerId: 'pl-child1' }, 'visible inside the transaction');
  L.store.sqlite.exec('ROLLBACK');
  assert.deepEqual(rowsOf(dir, 'pairing_codes'), [], "the tool's ROLLBACK undid the operation");
  assert.equal(L.codes.peekPairingCode(raw.code), null);
  // The same on a bare connection with no store at all.
  const bare = openRaw(dir);
  const codes = createOneTimeCodesRepository({ sqlite: bare, now: () => NOW });
  bare.exec('BEGIN');
  const b = codes.issuePairingCode('pl-child1');
  assert.equal(bare.isTransaction, true);
  bare.exec('ROLLBACK');
  assert.equal(codes.peekPairingCode(b.code), null);
  assert.throws(
    () => createOneTimeCodesRepository({ sqlite: bare, unit: { active: () => false } }),
    /participant API/,
    'a unit without join() is refused',
  );
  assert.throws(() => createOneTimeCodesRepository({ sqlite: bare, unit: 'yes' }), /participant API/);
  bare.close();
  L.close();
  rm(dir);
});

test('concurrent redemption across two connections: both see the code, one consumes it, the other finds nothing — and a consumption that loses the race inside its own transaction throws (zero rows deleted), so its unit rolls back instead of minting a second session', () => {
  const dir = tempDir('otc-race');
  s5File(dir);
  const s1 = openRaw(dir);
  const s2 = openRaw(dir);
  const a = createOneTimeCodesRepository({ sqlite: s1, now: () => NOW });
  const b = createOneTimeCodesRepository({ sqlite: s2, now: () => NOW });
  const { code } = a.issuePairingCode('pl-child1');
  assert.deepEqual(
    [a.peekPairingCode(code), b.peekPairingCode(code)],
    [{ playerId: 'pl-child1' }, { playerId: 'pl-child1' }],
  );
  assert.deepEqual(
    transaction(s1, () => a.consumePairingCode(code)),
    { playerId: 'pl-child1' },
  );
  assert.equal(
    transaction(s2, () => b.consumePairingCode(code)),
    null,
    'the loser re-reads and finds nothing',
  );
  // The narrow window: connection 2 has already read the row inside its open transaction when connection 1
  // consumes it and commits. Connection 2's consumption must not succeed: SQLite refuses to upgrade its stale
  // read snapshot to a write (SQLITE_BUSY_SNAPSHOT, "database is locked"), or the DELETE finds no row and the
  // repository throws — either way its unit rolls back and no second session can be minted.
  const c2 = a.issuePairingCode('pl-child2');
  s2.exec('BEGIN');
  assert.deepEqual(b.peekPairingCode(c2.code), { playerId: 'pl-child2' }, 'connection 2 read the live row');
  assert.deepEqual(
    transaction(s1, () => a.consumePairingCode(c2.code)),
    { playerId: 'pl-child2' },
    'connection 1 consumed and committed',
  );
  let outcome;
  try {
    outcome = b.consumePairingCode(c2.code);
  } catch (e) {
    outcome = e;
  }
  s2.exec('ROLLBACK');
  assert.ok(
    outcome instanceof Error || outcome === null,
    `the stale reader must not consume the code a second time (got ${JSON.stringify(outcome)})`,
  );
  if (outcome instanceof Error)
    assert.match(outcome.message, /database is locked|could not be consumed \(0 row\(s\) deleted\)/);
  assert.equal(
    rowsOf(dir, 'pairing_codes').some((r) => r.player_id === 'pl-child2'),
    false,
  );
  s1.close();
  s2.close();
  rm(dir);
});

// ============================================================= deletion
test('player deletion revokes the pairing code inside the deletion unit: a failure of the real COMMIT keeps both the player and the code; the retry removes both', () => {
  const dir = tempDir('otc-delete');
  s5File(dir);
  const L = live(dir);
  L.codes.issuePairingCode('pl-child1');
  const del = (fault) =>
    L.store.unitOfWork(() => {
      L.layer.sessions.revokeFor('player', 'pl-child1');
      L.codes.revokePairingCodesFor('pl-child1');
      L.layer.players.erase('pl-child1'); // the account deletion (the row stays as the retained record)
      if (fault) L.store.failCommitOfOpenTransaction();
    });
  assert.throws(() => del(true), /FOREIGN KEY constraint failed/);
  assert.equal(rowsOf(dir, 'pairing_codes').length, 1, 'the code survived the failed deletion');
  assert.ok(rowsOf(dir, 'players').some((p) => p.id === 'pl-child1' && p.deleted_at === null));
  del(false);
  assert.equal(rowsOf(dir, 'pairing_codes').length, 0);
  assert.equal(
    rowsOf(dir, 'players').some((p) => p.id === 'pl-child1' && p.deleted_at === null),
    false,
  );
  L.close();
  rm(dir);
});

// ============================================================= the codes read back (backups, restores, persistence suites)
test('read back: the tables hold the codes in their stored form (codeHash, never a code); a plain-code entry in a fixture is hashed on the way in; a second code for a child or a challenge for an unknown organisation is refused by the table, and nothing changes', () => {
  const dir = tempDir('otc-read');
  s5File(dir);
  {
    const s = openRaw(dir);
    const c = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => 'LIVE22' });
    c.issuePairingCode('pl-child1');
    c.issueEmailChallenge('org-pro', 'x@eastport.test');
    s.close();
  }
  const back = storedCodes(dir);
  assert.deepEqual(back.pairingCodes, [
    { codeHash: hashCode('LIVE22'), playerId: 'pl-child1', expiresAt: NOW + PAIRING_CODE_TTL_MS },
  ]);
  assert.equal(back.emailChallenges[0].codeHash, hashCode('LIVE22'));
  assert.equal(back.emailChallenges[0].attempts, 0);
  // A legacy entry in a fixture: hashed, the plain value stored nowhere.
  writeCodes(dir, { pairingCodes: [{ code: 'FIXT33', playerId: 'pl-child2', expiresAt: NOW + MIN }] });
  assert.deepEqual(
    rowsOf(dir, 'pairing_codes')
      .map((r) => [r.player_id, r.code_hash])
      .sort(),
    [
      ['pl-child1', hashCode('LIVE22')],
      ['pl-child2', hashCode('FIXT33')],
    ],
  );
  assert.doesNotMatch(fileDump(dir), /FIXT33/);
  {
    const s = second(dir);
    assert.equal(hasBlobTable(s), false, 'never a blob');
    s.close();
  }
  const before = fileDump(dir);
  const refused = (label, collections, re) => {
    assert.throws(() => writeCodes(dir, collections), re, label);
    assert.equal(fileDump(dir), before, `${label}: nothing changed`);
  };
  refused(
    'a second code for a child',
    { pairingCodes: [{ codeHash: hashCode('ANOTHR'), playerId: 'pl-child1', expiresAt: NOW + MIN }] },
    /UNIQUE constraint failed: pairing_codes\.player_id/,
  );
  refused(
    'a challenge for an unknown organisation',
    {
      emailChallenges: [
        { orgId: 'org-nowhere', email: 'a@b.test', codeHash: hashCode('ORGX22'), expiresAt: NOW + MIN, attempts: 0 },
      ],
    },
    /FOREIGN KEY constraint failed/,
  );
  rm(dir);
});

test('boot: a stale code array handed in with the seed is never imported — the table is the record; expired rows are swept at attach; the report carries counts and lifetimes, never a code or a hash', () => {
  const dir = tempDir('otc-boot');
  s5File(dir, {
    pairingCodes: [legacyPairing(), legacyPairing({ playerId: 'pl-child2', code: 'SOON22', expiresAt: NOW + MIN })],
  });
  let L = live(dir);
  assert.deepEqual(L.codes.counts(), { emailChallenges: 0, pairingCodes: 2 });
  L.close();
  const store = openStore(dir);
  // The stale array is handed in as part of the seed, which an initialised file ignores.
  const seed = { pairingCodes: [{ code: 'STALE2', playerId: 'pl-adult', expiresAt: NOW + 99 * MIN }] };
  const warnings = [];
  const layer = attachDataLayer({
    seed,
    store,
    nextId,
    sessionTtlMs: TTL,
    now: () => NOW + 2 * MIN,
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(
    layer.boot.codes.swept,
    { emailChallenges: 0, pairingCodes: 1 },
    'the expired code was swept at attach',
  );
  assert.equal(layer.codes.peekPairingCode('STALE2'), null, 'the stale array was not imported');
  const report = JSON.stringify(layer.report());
  assert.match(report, /"oneTimeCodes":\{"mode":"live","rows":\{"emailChallenges":0,"pairingCodes":1\}/);
  assert.doesNotMatch(report, /[0-9a-f]{64}|PAIR22/);
  store.sqlite.close();
  rm(dir);
});

test("collisions: two organisations may hold the same e-mail code by chance (each challenge is found by its organisation) and both verify; a minted pairing code equal to another child's live code is redrawn, never shared, and eight consecutive collisions refuse the issue with nothing written", () => {
  const dir = tempDir('otc-collide');
  s5File(dir);
  let s = openRaw(dir);
  s.prepare("INSERT INTO orgs (id, name, type, plan, created_at) VALUES ('org-two', 'Two FC', 'club', 'Pro', 0)").run();
  let n = 0;
  const draws = ['SAME22', 'SAME22', 'SAME22', 'OTHER3'];
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => draws[n++] });
  codes.issueEmailChallenge('org-pro', 'a@eastport.test');
  codes.issueEmailChallenge('org-two', 'b@two.test');
  assert.equal(codes.checkEmailChallenge('org-pro', 'SAME22').status, 'ok');
  assert.equal(codes.checkEmailChallenge('org-two', 'SAME22').status, 'ok');
  assert.equal(codes.exportEmailChallenges().length, 2, 'two challenges with the same code, one per organisation');
  const first = codes.issuePairingCode('pl-child1');
  const secondCode = codes.issuePairingCode('pl-child2');
  assert.deepEqual([first.code, secondCode.code], ['SAME22', 'OTHER3'], 'the colliding draw was redrawn');
  assert.deepEqual(
    [codes.peekPairingCode('SAME22'), codes.peekPairingCode('OTHER3')],
    [{ playerId: 'pl-child1' }, { playerId: 'pl-child2' }],
  );
  const stuck = createOneTimeCodesRepository({ sqlite: s, now: () => NOW, newCode: () => 'SAME22' });
  assert.throws(() => stuck.issuePairingCode('pl-adult'), /eight consecutive draws collided/);
  assert.equal(
    s.prepare("SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = 'pl-adult'").get().n,
    0,
    'nothing was issued',
  );
  s.close();
  rm(dir);
});

// ============================================================= exhausted rows, attempt limits and the mailer's outbox
test('runtime: an exhausted row that somehow exists (planted directly) is never redeemed — check answers none, consumption returns nothing and deletes nothing, a wrong code counts nothing, it is not outstanding, and the sweep removes it; at nine attempts the tenth wrong code cancels a valid challenge', () => {
  const dir = tempDir('otc-f2-rt');
  s5File(dir);
  const s = openRaw(dir);
  const codes = createOneTimeCodesRepository({ sqlite: s, now: () => NOW });
  s.prepare('INSERT INTO email_challenges (org_id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, ?)').run(
    'org-pro',
    'x@eastport.test',
    hashCode('GOOD22'),
    NOW + MIN,
    EMAIL_CHALLENGE_MAX_ATTEMPTS,
  );
  assert.deepEqual(codes.checkEmailChallenge('org-pro', 'GOOD22'), { status: 'none' });
  assert.equal(
    transaction(s, () => codes.consumeEmailChallenge('org-pro', 'GOOD22')),
    null,
  );
  assert.equal(s.prepare('SELECT COUNT(*) AS n FROM email_challenges').get().n, 1, 'consumption deleted nothing');
  assert.deepEqual(codes.noteFailedEmailAttempt('org-pro'), { attemptsRemaining: 0, invalidated: false });
  assert.deepEqual(codes.outstanding(), { emailChallenges: 0, pairingCodes: 0 });
  s.close();
  const s2 = openRaw(dir);
  const codes2 = createOneTimeCodesRepository({ sqlite: s2, now: () => NOW });
  assert.deepEqual(
    codes2.sweepExpired(),
    { emailChallenges: 1, pairingCodes: 0 },
    'the sweep removes the exhausted row',
  );
  const { code } = codes2.issueEmailChallenge('org-pro', 'x@eastport.test');
  s2.prepare("UPDATE email_challenges SET attempts = ? WHERE org_id = 'org-pro'").run(EMAIL_CHALLENGE_MAX_ATTEMPTS - 1);
  assert.deepEqual(codes2.checkEmailChallenge('org-pro', code).status, 'ok', 'nine attempts: still redeemable');
  assert.deepEqual(
    codes2.noteFailedEmailAttempt('org-pro'),
    { attemptsRemaining: 0, invalidated: true },
    'the tenth wrong code cancels it',
  );
  assert.deepEqual(codes2.checkEmailChallenge('org-pro', code), { status: 'none' });
  s2.close();
  rm(dir);
});

await testAsync(
  "the mailer withholds the secrets it is given from the outbox record it keeps (the record is saved and backed up): on the dev transport the full text is kept in this process's memory only, for the admin outbox view; on the live transport the provider receives the full text and nothing keeps it; a mail without secrets is recorded unchanged",
  async () => {
    const savedKey = process.env.SENDGRID_API_KEY;
    delete process.env.SENDGRID_API_KEY;
    let n = 0;
    const nextIdLocal = (p) => `${p}-${++n}`;
    // A recording stand-in for the outbox repository (the mailer writes through it).
    const outboxStub = () => {
      const rows = [];
      return {
        rows,
        append: (r) => {
          rows.push({ ...r });
          return r;
        },
        markDelivered: (id, ok) => {
          rows.find((r) => r.id === id).delivered = ok;
        },
      };
    };
    const db = outboxStub();
    const dev = createMailer(nextIdLocal, { outbox: db });
    const text =
      'Your ScoutBox club verification code is QX7K2M.\n\nEntering it confirms Eastport FC controls this mailbox.';
    const rec = await dev.send({ to: 'a@eastport.test', subject: 'Verify', text, secrets: ['QX7K2M'] });
    assert.equal(rec.text.includes('QX7K2M'), false);
    assert.ok(rec.text.includes(OUTBOX_SECRET_PLACEHOLDER));
    assert.ok(rec.text.includes('Eastport FC controls this mailbox'), 'the rest of the mail is kept');
    assert.equal(dev.devDeliveredText(rec.id), text, 'the dev delivery keeps the full text in memory');
    const plain = await dev.send({ to: 'b@eastport.test', subject: 'Hello', text: 'An unrelated mail.' });
    assert.equal(plain.text, 'An unrelated mail.');
    assert.equal(dev.devDeliveredText(plain.id), null, 'nothing is withheld, nothing held');
    assert.equal(JSON.stringify(db.rows).includes('QX7K2M'), false, 'the stored outbox records hold no secret');
    // A subject or text longer than the outbox keeps (a name the routes do not bound) is shortened in the
    // stored record, never refused — the mail is still recorded and sent.
    const long = await dev.send({
      to: 'd@eastport.test',
      subject: `Reference request for ${'N'.repeat(400)}`,
      text: 'T'.repeat(12_000),
    });
    assert.deepEqual([long.subject.length, long.text.length], [300, 10_000]);
    assert.equal(db.rows.at(-1).id, long.id, 'recorded');
    // Live transport: fetch stubbed, no request leaves the process.
    process.env.SENDGRID_API_KEY = 'synthetic-not-a-real-key';
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: init.body });
      return new Response('', { status: 202 });
    };
    try {
      const liveDb = outboxStub();
      const live = createMailer(nextIdLocal, { outbox: liveDb });
      const r = await live.send({ to: 'c@eastport.test', subject: 'Verify', text, secrets: ['QX7K2M'] });
      assert.equal(sent.length, 1);
      assert.match(sent[0].url, /^https:\/\/api\.sendgrid\.com\//);
      assert.ok(sent[0].body.includes('QX7K2M'), 'the provider receives the full text');
      assert.equal(r.delivered, true);
      assert.equal(r.text.includes('QX7K2M'), false);
      assert.equal(live.devDeliveredText(r.id), null);
      assert.equal(liveDb.rows[0].delivered, true, "the provider's answer is written to the stored record");
      assert.equal(JSON.stringify(liveDb.rows).includes('QX7K2M'), false);
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.SENDGRID_API_KEY;
      else process.env.SENDGRID_API_KEY = savedKey;
    }
  },
);

console.log(`\n${passed} one-time-code checks passed`);
