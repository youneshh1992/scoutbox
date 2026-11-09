/**
 * One-time codes — migration plan step S6a (docs/architecture/s6-readiness-review.md §5–§6).
 *
 * Owns two tables:
 *
 *   email_challenges  the club e-mail-domain verification code
 *                     (POST /org/verification/email → …/confirm): one row per
 *                     organisation, 30-minute lifetime, consumed on success,
 *                     failed confirmations counted on the row and the challenge
 *                     invalidated after EMAIL_CHALLENGE_MAX_ATTEMPTS of them.
 *   pairing_codes     the child device pairing code
 *                     (POST /guardian/children/:id/pairing-code →
 *                     POST /auth/player/pair): one row per child, 15-minute
 *                     lifetime, single use.
 *
 * A row never stores the code: only `code_hash` — sha256 hex of the code
 * trimmed and upper-cased, which is exactly the comparison the routes made on
 * the plain value (the sessions convention, `repositories/sessions.mjs`). The
 * plain code exists once outside the client: in the return value of the issue
 * methods, which the routes put in the e-mail (challenge) or the guardian's
 * response (pairing code). Nothing here logs, reports or exports it. A sha256
 * of a six-character code from a 31-character alphabet (≈ 2^29.7 values)
 * protects against casual disclosure of a database or a backup, not against an
 * offline search by someone holding the file — the lifetimes (15 and 30
 * minutes) bound that exposure; this is stated in OPERATIONS.md, not hidden.
 *
 * Expiry is judged on every read and consume (`expires_at > now`); expired rows
 * are also swept at boot and before every issue, so a dead row never lingers
 * for long. An issue replaces the owner's previous row (one live code per
 * organisation / per child, as the filter-then-push did).
 *
 * `pairing_codes.player_id` carries NO foreign key on purpose: player ids carry
 * no key (records outlive an account, migration.md §4.3). Instead the deletion unit
 * revokes the child's codes explicitly (`revokePairingCodesFor`), and the migration
 * refuses an outstanding code for a player that does not exist. `email_challenges.org_id`
 * does reference `orgs(id)` (organisations are upserted and pruned, never
 * rewritten whole; a pruned organisation takes its challenge with it).
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0008_one_time_codes` in `data_migrations`, never by the tables existing.
 *
 * Transactions. The repository is a participant in the store's unit of work:
 * every mutation runs through one boundary (`operation`, documented at the
 * factory) that joins an open unit through the store's participant API, runs
 * in a transaction of its own outside a unit, and runs as part of a raw
 * transaction a tool or test opened without a BEGIN of its own. A failure
 * after a statement already ran therefore poisons the enclosing unit even when
 * the caller catches it; the unit refuses to commit and its rollback undoes the
 * statements (review of b2a237e).
 *
 * Snapshot formats (backups, restores, the persistence suites). An entry of
 * the `emailChallenges` / `pairingCodes` collection is ONE of:
 *   legacy  { orgId, email, code, expiresAt }       / { code, playerId, expiresAt }
 *           — the plain-code shape every build before S6a wrote and every
 *           backup taken before S6a holds; hashed on the way in, never stored;
 *   stored  { orgId, email, codeHash, expiresAt, attempts } / { codeHash, playerId, expiresAt }
 *           — the row form this repository exports and a backup taken after
 *           S6a holds.
 * An entry that carries both `code` and `codeHash`, neither, an unknown field,
 * a malformed hash, a non-integer expiry, a negative or non-integer attempt
 * count, a missing owner, or that duplicates an owner or a hash, is refused
 * with the entry index and the reason (`ONE_TIME_CODES_IMPORT_BLOCKED`), and
 * the migration is rolled back. Nothing is
 * coerced, reinterpreted or dropped silently. The one deliberate drop is the
 * migration's: entries already expired at cutover time are not imported, and
 * their count is recorded in `meta.oneTimeCodesCutover` and logged.
 */
import crypto from 'node:crypto';
import { migrationApplied, transaction } from './database.mjs';

export const ONE_TIME_CODES_MIGRATION = '0008_one_time_codes';
export const EMAIL_CHALLENGE_TTL_MS = 30 * 60 * 1000;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong confirmations an e-mail challenge survives; the one that reaches this count invalidates it (the organisation requests a fresh code). */
export const EMAIL_CHALLENGE_MAX_ATTEMPTS = 10;
/** The alphabet every ScoutBox one-time code is drawn from (no I, L, O, 0, 1): the same as adapters.mjs `randomCode`. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const ONE_TIME_CODE_TABLES = Object.freeze(['email_challenges', 'pairing_codes']);

export const ONE_TIME_CODES_DDL = `
CREATE TABLE email_challenges (
  org_id     TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
) STRICT;
CREATE INDEX email_challenges_expires_at ON email_challenges (expires_at);
CREATE TABLE pairing_codes (
  code_hash  TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  player_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX pairing_codes_player_id ON pairing_codes (player_id);
CREATE INDEX pairing_codes_expires_at ON pairing_codes (expires_at);`;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** The comparison form the routes have always used: trimmed, upper-cased. */
export const normaliseCode = (code) => String(code ?? '').trim().toUpperCase();
/** The stored form of a code: sha256 hex of its normalised value. */
export const hashCode = (code) => sha256(normaliseCode(code));
const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
/** A random code from the alphabet (CSPRNG), as adapters.mjs mints them. */
export function randomCode(length = CODE_LENGTH) {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
export const codesLive = (sqlite) => migrationApplied(sqlite, ONE_TIME_CODES_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

// ------------------------------------------------------------------ validation (no coercion; every refusal names the reason)
/**
 * Decide which snapshot format an entry is in and extract its hash. Returns
 * `{ codeHash, format }` or `{ reason }`. The two shapes are told apart by the
 * presence of exactly one of `code` (legacy, plain) and `codeHash` (stored).
 */
function codeOf(raw) {
  const hasCode = Object.hasOwn(raw, 'code');
  const hasHash = Object.hasOwn(raw, 'codeHash');
  if (hasCode && hasHash) return { reason: 'carries both code and codeHash (a legacy entry has code, a stored one codeHash)' };
  if (!hasCode && !hasHash) return { reason: 'has neither code (legacy) nor codeHash (stored)' };
  if (hasCode) {
    if (typeof raw.code !== 'string' || !raw.code.trim()) return { reason: 'code must be a non-empty string (legacy format)' };
    if (raw.code.length > 64) return { reason: 'code is longer than any code this server issues' };
    return { codeHash: hashCode(raw.code), format: 'legacy' };
  }
  if (!isHash(raw.codeHash)) return { reason: 'codeHash must be 64 lower-case hex characters (stored format)' };
  return { codeHash: raw.codeHash, format: 'stored' };
}
const expiryOf = (raw) => (Number.isSafeInteger(raw.expiresAt) && raw.expiresAt > 0 ? { expiresAt: raw.expiresAt } : { reason: 'expiresAt must be a positive integer timestamp' });


const PAIRING_LEGACY_KEYS = ['code', 'playerId', 'expiresAt'];
const PAIRING_STORED_KEYS = ['codeHash', 'playerId', 'expiresAt'];
/** Validate one exported pairing code: `{ ok: true, row, format }` or `{ ok: false, reason }`. */
export function validatePairingCodeRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  const c = codeOf(raw);
  if (c.reason) return { ok: false, reason: c.reason };
  const allowed = c.format === 'legacy' ? PAIRING_LEGACY_KEYS : PAIRING_STORED_KEYS;
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) return { ok: false, reason: `unknown field(s) ${unknown.join(', ')} for the ${c.format} format` };
  if (typeof raw.playerId !== 'string' || !raw.playerId) return { ok: false, reason: 'playerId must be a non-empty string' };
  const e = expiryOf(raw);
  if (e.reason) return { ok: false, reason: e.reason };
  return { ok: true, format: c.format, row: { codeHash: c.codeHash, playerId: raw.playerId, expiresAt: e.expiresAt } };
}




const EMAIL_SELECT = 'SELECT org_id, email, code_hash, expires_at, attempts FROM email_challenges';
const PAIRING_SELECT = 'SELECT code_hash, player_id, expires_at FROM pairing_codes';
const emailStored = (r) => ({ orgId: r.org_id, email: r.email, codeHash: r.code_hash, expiresAt: r.expires_at, attempts: r.attempts });
const pairingStored = (r) => ({ codeHash: r.code_hash, playerId: r.player_id, expiresAt: r.expires_at });

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const EMAIL_CHALLENGES_TABLE = {
  name: 'emailChallenges',
  read(sqlite) { if (!codesLive(sqlite)) return null; return sqlite.prepare(`${EMAIL_SELECT} ORDER BY org_id`).all().map(emailStored); },
};
export const PAIRING_CODES_TABLE = {
  name: 'pairingCodes',
  read(sqlite) { if (!codesLive(sqlite)) return null; return sqlite.prepare(`${PAIRING_SELECT} ORDER BY player_id`).all().map(pairingStored); },
};

// ------------------------------------------------------------------ the repository
/**
 * `newCode()` mints a plain code (injectable for tests; the default draws from
 * CODE_ALPHABET with the platform CSPRNG).
 *
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a
 * tool, a test, the migration). Every mutation — issue, consumption, the
 * failed-attempt count, revocation, the sweep — runs through ONE boundary,
 * `operation` (review of b2a237e): inside an open unit of work it joins the
 * unit through `unit.join`, so a failure after a statement already ran (the
 * reissue's delete before a failed insert, the tenth attempt's increment
 * before a failed cancellation) poisons the unit even when the caller catches
 * the error — the unit cannot commit the fragment, and its one rollback undoes
 * the statements and restores memory. Outside a unit a mutation runs in a
 * transaction of its own; and inside a raw SQLite transaction that a tool or a
 * test opened on the connection (no unit active) it runs as part of that
 * transaction, with no BEGIN of its own — an open transaction is never taken
 * for a unit. Validation is part of the operation (a refused argument inside a
 * unit poisons it like any other failure); expected negative results (no live
 * row, no match, nothing to delete) are return values, never failures. The
 * repository keeps no memory state (the views are read from the table on each
 * access) and needs no snapshotState/restoreState.
 */
export function createOneTimeCodesRepository({ sqlite, now = Date.now, newCode = randomCode, log = () => {}, unit = null }) {
  if (!sqlite) throw new TypeError('the one-time-code repository needs a SQLite connection (node:sqlite); codes have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the one-time-code repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    emailByOrg: sqlite.prepare(`${EMAIL_SELECT} WHERE org_id = ?`),
    emailUpsert: sqlite.prepare('INSERT INTO email_challenges (org_id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(org_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0'),
    emailFail: sqlite.prepare('UPDATE email_challenges SET attempts = attempts + 1 WHERE org_id = ? RETURNING attempts'),
    emailDelete: sqlite.prepare('DELETE FROM email_challenges WHERE org_id = ?'),
    emailConsume: sqlite.prepare('DELETE FROM email_challenges WHERE org_id = ? AND code_hash = ? AND expires_at > ? AND attempts < ?'),
    // An exhausted row (attempts at the limit) is as dead as an expired one: the sweep removes both.
    emailSweep: sqlite.prepare('DELETE FROM email_challenges WHERE expires_at <= ? OR attempts >= ?'),
    emailCount: sqlite.prepare('SELECT COUNT(*) AS n FROM email_challenges'),
    emailLive: sqlite.prepare('SELECT COUNT(*) AS n FROM email_challenges WHERE expires_at > ? AND attempts < ?'),
    pairByHash: sqlite.prepare(`${PAIRING_SELECT} WHERE code_hash = ?`),
    pairDeleteFor: sqlite.prepare('DELETE FROM pairing_codes WHERE player_id = ?'),
    pairInsert: sqlite.prepare('INSERT INTO pairing_codes (code_hash, player_id, expires_at) VALUES (?, ?, ?)'),
    pairConsume: sqlite.prepare('DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ?'),
    pairSweep: sqlite.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?'),
    pairCount: sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_codes'),
    pairLive: sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_codes WHERE expires_at > ?'),
  };
  const inUnit = () => !!unit?.active?.();
  /** The one transactional boundary of every mutation (see the header): joined inside a unit; the caller's own transaction when a tool opened one; a transaction of its own otherwise. */
  const operation = (fn) => {
    if (inUnit()) return unit.join(fn);
    if (sqlite.isTransaction) return fn();
    return transaction(sqlite, fn);
  };
  /** Redeemable: present, unexpired, and below the attempt limit (an exhausted row that somehow exists is never redeemed). */
  const liveChallenge = (r, at) => !!r && r.expires_at > at && r.attempts < EMAIL_CHALLENGE_MAX_ATTEMPTS;

  const repo = {
    emailChallengeTtlMs: EMAIL_CHALLENGE_TTL_MS,
    pairingCodeTtlMs: PAIRING_CODE_TTL_MS,
    maxEmailAttempts: EMAIL_CHALLENGE_MAX_ATTEMPTS,

    /** Boot: refuse to run without the cutover record; sweep expired rows; report counts (never a code or a hash). */
    attach({ at = now() } = {}) {
      if (!stmt.cutover.get(ONE_TIME_CODES_MIGRATION)) throw new Error(`one-time codes: the cutover record ${ONE_TIME_CODES_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      const swept = repo.sweepExpired(at);
      if (swept.emailChallenges || swept.pairingCodes) log(`one-time codes: ${swept.emailChallenges} expired e-mail challenge(s) and ${swept.pairingCodes} expired pairing code(s) removed at boot`);
      return { engine: 'sqlite', rows: repo.counts(), swept };
    },
    /** Delete every expired row of both tables. Returns how many went. */
    sweepExpired(at = now()) {
      return operation(() => ({ emailChallenges: stmt.emailSweep.run(at, EMAIL_CHALLENGE_MAX_ATTEMPTS).changes, pairingCodes: stmt.pairSweep.run(at).changes }));
    },
    counts: () => ({ emailChallenges: stmt.emailCount.get().n, pairingCodes: stmt.pairCount.get().n }),
    /** Rows that are still live at `at` (what a rollback would invalidate). */
    outstanding: (at = now()) => ({ emailChallenges: stmt.emailLive.get(at, EMAIL_CHALLENGE_MAX_ATTEMPTS).n, pairingCodes: stmt.pairLive.get(at).n }),

    // ---------------------------------------------------------- e-mail challenges
    /** Issue (or replace) the organisation's challenge. Returns the plain code ONCE, with the expiry. Durable before it returns. */
    issueEmailChallenge(orgId, email, { at = now() } = {}) {
      return operation(() => {
        if (typeof orgId !== 'string' || !orgId) throw new TypeError('an e-mail challenge needs an organisation id');
        if (typeof email !== 'string' || !email) throw new TypeError('an e-mail challenge needs the mailbox it was sent to');
        const code = newCode();
        const expiresAt = at + EMAIL_CHALLENGE_TTL_MS;
        stmt.emailSweep.run(at, EMAIL_CHALLENGE_MAX_ATTEMPTS); stmt.emailUpsert.run(orgId, email, hashCode(code), expiresAt);
        return { code, expiresAt };
      });
    },
    /**
     * Judge a presented code WITHOUT consuming it or counting it:
     * `{ status: 'none' }` (no live challenge — missing or expired),
     * `{ status: 'invalid', attemptsRemaining }`, or `{ status: 'ok', email }`.
     */
    checkEmailChallenge(orgId, code, { at = now() } = {}) {
      const r = stmt.emailByOrg.get(orgId);
      if (!liveChallenge(r, at)) return { status: 'none' };
      if (r.code_hash !== hashCode(code)) return { status: 'invalid', attemptsRemaining: Math.max(0, EMAIL_CHALLENGE_MAX_ATTEMPTS - r.attempts - 1) };
      return { status: 'ok', email: r.email };
    },
    /**
     * Count one wrong confirmation on the organisation's live challenge (its own
     * statement: a wrong guess is recorded even though the request is refused).
     * Reaching EMAIL_CHALLENGE_MAX_ATTEMPTS invalidates the challenge. Returns
     * `{ attemptsRemaining, invalidated }`; a missing or expired challenge counts nothing.
     */
    noteFailedEmailAttempt(orgId, { at = now() } = {}) {
      return operation(() => {
        const r = stmt.emailByOrg.get(orgId);
        if (!liveChallenge(r, at)) return { attemptsRemaining: 0, invalidated: false };
        const attempts = stmt.emailFail.get(orgId).attempts;
        if (attempts >= EMAIL_CHALLENGE_MAX_ATTEMPTS) { stmt.emailDelete.run(orgId); return { attemptsRemaining: 0, invalidated: true }; }
        return { attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - attempts, invalidated: false };
      });
    },
    /**
     * Consume the organisation's live challenge if `code` matches: deletes the
     * row and returns `{ email }`, or returns null (nothing changed). Meant for
     * the confirmation unit of work, so the deletion commits with the
     * organisation's verification or not at all.
     */
    consumeEmailChallenge(orgId, code, { at = now() } = {}) {
      return operation(() => {
        const r = stmt.emailByOrg.get(orgId);
        if (!liveChallenge(r, at) || r.code_hash !== hashCode(code)) return null;
        const { changes } = stmt.emailConsume.run(orgId, r.code_hash, at, EMAIL_CHALLENGE_MAX_ATTEMPTS);
        if (changes !== 1) throw new Error(`email challenges: the challenge of organisation ${orgId} could not be consumed (${changes} row(s) deleted)`);
        return { email: r.email };
      });
    },
    /** Remove the organisation's challenge, live or not (an explicit act). Returns how many rows went. */
    revokeEmailChallenge: (orgId) => operation(() => stmt.emailDelete.run(orgId).changes),

    // ---------------------------------------------------------- pairing codes
    /** Mint (or replace) the child's pairing code. Returns the plain code ONCE, with the expiry. Durable before it returns. */
    issuePairingCode(playerId, { at = now() } = {}) {
      // The code is the lookup key: a fresh draw that equals another child's live code (≈ live codes / 31^6) is redrawn, never shared.
      return operation(() => {
        if (typeof playerId !== 'string' || !playerId) throw new TypeError('a pairing code needs a player id');
        const expiresAt = at + PAIRING_CODE_TTL_MS;
        stmt.pairSweep.run(at); stmt.pairDeleteFor.run(playerId);
        for (let draw = 0; draw < 8; draw++) {
          const code = newCode();
          if (stmt.pairByHash.get(hashCode(code))) continue;
          stmt.pairInsert.run(hashCode(code), playerId, expiresAt);
          return { code, expiresAt };
        }
        throw new Error('pairing codes: eight consecutive draws collided with live codes; nothing was issued');
      });
    },
    /** The live code's owner, without consuming it: `{ playerId }` or null. */
    peekPairingCode(code, { at = now() } = {}) {
      const r = stmt.pairByHash.get(hashCode(code));
      return r && r.expires_at > at ? { playerId: r.player_id } : null;
    },
    /**
     * Consume a live pairing code: deletes the row and returns `{ playerId }`,
     * or returns null (nothing changed). Meant for the pairing unit of work, so
     * the code goes exactly when the session it buys is committed.
     */
    consumePairingCode(code, { at = now() } = {}) {
      return operation(() => {
        const hash = hashCode(code);
        const r = stmt.pairByHash.get(hash);
        if (!r || r.expires_at <= at) return null;
        const { changes } = stmt.pairConsume.run(hash, at);
        if (changes !== 1) throw new Error(`pairing codes: the code of player ${r.player_id} could not be consumed (${changes} row(s) deleted)`);
        return { playerId: r.player_id };
      });
    },
    /** Remove the child's codes, live or not (the deletion unit calls this before the player row goes). Returns how many rows went. */
    revokePairingCodesFor: (playerId) => operation(() => stmt.pairDeleteFor.run(playerId).changes),

    /** Every stored row in its stored form (`codeHash`, never a code), for the admin backup; the views cannot round-trip and must not be exported. */
    exportEmailChallenges: () => EMAIL_CHALLENGES_TABLE.read(sqlite) ?? [],
    exportPairingCodes: () => PAIRING_CODES_TABLE.read(sqlite) ?? [],
  };
  return repo;
}
