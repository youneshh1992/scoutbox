/**
 * One-time codes:
 *
 *   email_challenges  the club e-mail-domain verification code (POST /org/verification/email → …/confirm): one row per
 *                     organisation, 30-minute lifetime, consumed on success, failed confirmations counted on the row and
 *                     the challenge invalidated after EMAIL_CHALLENGE_MAX_ATTEMPTS of them.
 *   pairing_codes     the child device pairing code (POST /guardian/children/:id/pairing-code → POST /auth/player/pair):
 *                     one row per child, 15-minute lifetime, single use.
 *
 * A row never stores the code: only `code_hash`, sha256 hex of the code trimmed and upper-cased (the routes' comparison
 * form). The plain code exists once outside the client: in the return value of the issue methods, which the routes put
 * in the e-mail (challenge) or the guardian's response (pairing code). Nothing here logs, reports or exports it. A
 * sha256 of a six-character code from a 31-character alphabet (≈ 2^29.7 values) protects against casual disclosure of a
 * database or a backup, not against an offline search by someone holding the file: the lifetimes (15 and 30 minutes)
 * bound that exposure; this is stated in OPERATIONS.md, not hidden.
 *
 * Expiry is judged on every read and consume (`expires_at > now`); expired rows are also swept at boot and before every
 * issue. An issue replaces the owner's previous row (one live code per organisation / per child).
 *
 * `pairing_codes.player_id` carries no foreign key on purpose: player ids carry no key (records outlive an account).
 * Instead the deletion unit revokes the child's codes explicitly (`revokePairingCodesFor`). `email_challenges.org_id`
 * references `orgs(id)`.
 *
 * Every mutation runs through one boundary (`operation`, documented at the factory), so a failure after a statement
 * already ran poisons the enclosing unit even when the caller catches it.
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { migrationApplied, operationOn, type UnitParticipant } from './database.ts';

export const ONE_TIME_CODES_MIGRATION = '0008_one_time_codes';
export const EMAIL_CHALLENGE_TTL_MS = 30 * 60 * 1000;
export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong confirmations an e-mail challenge survives; the one that reaches this count invalidates it (the organisation requests a fresh code). */
export const EMAIL_CHALLENGE_MAX_ATTEMPTS = 10;
/** The alphabet every ScoutBox one-time code is drawn from (no I, L, O, 0, 1): the same as adapters.mjs `randomCode`. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const ONE_TIME_CODE_TABLES = Object.freeze(['email_challenges', 'pairing_codes'] as const);

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

export const sha256 = (s: unknown) => crypto.createHash('sha256').update(String(s)).digest('hex');
/** The comparison form: trimmed, upper-cased. */
export const normaliseCode = (code: unknown) =>
  String(code ?? '')
    .trim()
    .toUpperCase();
/** The stored form of a code: sha256 hex of its normalised value. */
export const hashCode = (code: unknown) => sha256(normaliseCode(code));
/** A random code from the alphabet (CSPRNG), as adapters.mjs mints them. */
export function randomCode(length = CODE_LENGTH): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
  ).join('');
}
export const codesLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, ONE_TIME_CODES_MIGRATION);

const EMAIL_SELECT = 'SELECT org_id, email, code_hash, expires_at, attempts FROM email_challenges';
const PAIRING_SELECT = 'SELECT code_hash, player_id, expires_at FROM pairing_codes';
/** An organisation's e-mail challenge in its stored form: the code's hash, never the code. */
export type EmailChallengeRow = {
  orgId: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  /** Wrong confirmations so far. */
  attempts: number;
};
/** A child's pairing code in its stored form: the code's hash, never the code. */
export type PairingCodeRow = { codeHash: string; playerId: string; expiresAt: number };
type EmailDbRow = { org_id: string; email: string; code_hash: string; expires_at: number; attempts: number };
type PairingDbRow = { code_hash: string; player_id: string; expires_at: number };
/** How many rows of each table. */
export type CodeCounts = { emailChallenges: number; pairingCodes: number };
/** A freshly issued code, returned once; only its hash is stored. */
export type IssuedCode = { code: string; expiresAt: number };
/** A presented e-mail challenge code, judged without consuming or counting it. */
export type EmailChallengeCheck =
  | { status: 'none' }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'ok'; email: string };
type At = { at?: number };

const emailStored = (r: EmailDbRow): EmailChallengeRow => ({
  orgId: r.org_id,
  email: r.email,
  codeHash: r.code_hash,
  expiresAt: r.expires_at,
  attempts: r.attempts,
});
const pairingStored = (r: PairingDbRow): PairingCodeRow => ({
  codeHash: r.code_hash,
  playerId: r.player_id,
  expiresAt: r.expires_at,
});

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const EMAIL_CHALLENGES_TABLE = {
  name: 'emailChallenges',
  read(sqlite: DatabaseSync): EmailChallengeRow[] | null {
    if (!codesLive(sqlite)) return null;
    return (sqlite.prepare(`${EMAIL_SELECT} ORDER BY org_id`).all() as EmailDbRow[]).map(emailStored);
  },
};
export const PAIRING_CODES_TABLE = {
  name: 'pairingCodes',
  read(sqlite: DatabaseSync): PairingCodeRow[] | null {
    if (!codesLive(sqlite)) return null;
    return (sqlite.prepare(`${PAIRING_SELECT} ORDER BY player_id`).all() as PairingDbRow[]).map(pairingStored);
  },
};

// ------------------------------------------------------------------ the repository
/**
 * `newCode()` mints a plain code (injectable for tests; the default draws from CODE_ALPHABET with the platform
 * CSPRNG). `unit` is the store's participant API ({ active(), join(work) }) or null (a tool, a test).
 *
 * Every mutation (issue, consumption, the failed-attempt count, revocation, the sweep) runs through one boundary,
 * `operation`: inside an open unit of work it joins the unit through `unit.join`, so a failure after a statement
 * already ran (the reissue's delete before a failed insert, the tenth attempt's increment before a failed
 * cancellation) poisons the unit even when the caller catches the error, and the unit's rollback undoes the
 * statements. Outside a unit a mutation runs in a transaction of its own; inside a raw SQLite transaction that a tool
 * or a test opened (no unit active) it runs as part of that transaction, with no BEGIN of its own. Validation is part
 * of the operation (a refused argument inside a unit poisons it like any other failure); expected negative results
 * (no live row, no match, nothing to delete) are return values, never failures.
 */
export function createOneTimeCodesRepository({
  sqlite,
  now = Date.now,
  newCode = randomCode,
  log = () => {},
  unit = null,
}: {
  sqlite: DatabaseSync;
  now?: () => number;
  newCode?: () => string;
  log?: (message: string) => void;
  unit?: UnitParticipant | null;
}) {
  if (!sqlite)
    throw new TypeError(
      'the one-time-code repository needs a SQLite connection (node:sqlite); codes have no in-memory or JSON fallback',
    );
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function'))
    throw new TypeError(
      "the one-time-code repository needs the store's participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation's failure to the unit of work",
    );
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    emailByOrg: sqlite.prepare(`${EMAIL_SELECT} WHERE org_id = ?`),
    emailUpsert: sqlite.prepare(
      'INSERT INTO email_challenges (org_id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(org_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
    ),
    emailFail: sqlite.prepare(
      'UPDATE email_challenges SET attempts = attempts + 1 WHERE org_id = ? RETURNING attempts',
    ),
    emailDelete: sqlite.prepare('DELETE FROM email_challenges WHERE org_id = ?'),
    emailConsume: sqlite.prepare(
      'DELETE FROM email_challenges WHERE org_id = ? AND code_hash = ? AND expires_at > ? AND attempts < ?',
    ),
    // An exhausted row (attempts at the limit) is as dead as an expired one: the sweep removes both.
    emailSweep: sqlite.prepare('DELETE FROM email_challenges WHERE expires_at <= ? OR attempts >= ?'),
    emailCount: sqlite.prepare('SELECT COUNT(*) AS n FROM email_challenges'),
    pairByHash: sqlite.prepare(`${PAIRING_SELECT} WHERE code_hash = ?`),
    pairDeleteFor: sqlite.prepare('DELETE FROM pairing_codes WHERE player_id = ?'),
    pairInsert: sqlite.prepare('INSERT INTO pairing_codes (code_hash, player_id, expires_at) VALUES (?, ?, ?)'),
    pairConsume: sqlite.prepare('DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ?'),
    pairSweep: sqlite.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?'),
    pairCount: sqlite.prepare('SELECT COUNT(*) AS n FROM pairing_codes'),
  };
  /** The one transactional boundary of every mutation (see the header): joined inside a unit; the caller's own transaction when a tool opened one; a transaction of its own otherwise. */
  const operation = operationOn(sqlite, unit);
  /** Redeemable: present, unexpired, and below the attempt limit (an exhausted row that somehow exists is never redeemed). */
  const liveChallenge = (r: EmailDbRow | undefined, at: number): r is EmailDbRow =>
    !!r && r.expires_at > at && r.attempts < EMAIL_CHALLENGE_MAX_ATTEMPTS;

  const changes = (n: number | bigint) => Number(n);
  const n = (row: unknown) => (row as { n: number }).n;
  const emailOf = (orgId: string) => stmt.emailByOrg.get(orgId) as EmailDbRow | undefined;
  const pairingOf = (hash: string) => stmt.pairByHash.get(hash) as PairingDbRow | undefined;

  const repo = {
    emailChallengeTtlMs: EMAIL_CHALLENGE_TTL_MS,
    pairingCodeTtlMs: PAIRING_CODE_TTL_MS,
    maxEmailAttempts: EMAIL_CHALLENGE_MAX_ATTEMPTS,

    /** Boot: refuse to run without the migration record; sweep expired rows; report counts (never a code or a hash). */
    attach({ at = now() }: At = {}): { engine: 'sqlite'; rows: CodeCounts; swept: CodeCounts } {
      if (!stmt.cutover.get(ONE_TIME_CODES_MIGRATION))
        throw new Error(
          `one-time codes: the cutover record ${ONE_TIME_CODES_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`,
        );
      const swept = repo.sweepExpired(at);
      if (swept.emailChallenges || swept.pairingCodes)
        log(
          `one-time codes: ${swept.emailChallenges} expired e-mail challenge(s) and ${swept.pairingCodes} expired pairing code(s) removed at boot`,
        );
      return { engine: 'sqlite', rows: repo.counts(), swept };
    },
    /** Delete every expired row of both tables. Returns how many went. */
    sweepExpired(at = now()): CodeCounts {
      return operation(() => ({
        emailChallenges: changes(stmt.emailSweep.run(at, EMAIL_CHALLENGE_MAX_ATTEMPTS).changes),
        pairingCodes: changes(stmt.pairSweep.run(at).changes),
      }));
    },
    counts: (): CodeCounts => ({ emailChallenges: n(stmt.emailCount.get()), pairingCodes: n(stmt.pairCount.get()) }),

    // ---------------------------------------------------------- e-mail challenges
    /** Issue (or replace) the organisation's challenge. Returns the plain code ONCE, with the expiry. Durable before it returns. */
    issueEmailChallenge(orgId: string, email: string, { at = now() }: At = {}): IssuedCode {
      return operation(() => {
        if (typeof orgId !== 'string' || !orgId) throw new TypeError('an e-mail challenge needs an organisation id');
        if (typeof email !== 'string' || !email)
          throw new TypeError('an e-mail challenge needs the mailbox it was sent to');
        const code = newCode();
        const expiresAt = at + EMAIL_CHALLENGE_TTL_MS;
        stmt.emailSweep.run(at, EMAIL_CHALLENGE_MAX_ATTEMPTS);
        stmt.emailUpsert.run(orgId, email, hashCode(code), expiresAt);
        return { code, expiresAt };
      });
    },
    /**
     * Judge a presented code WITHOUT consuming it or counting it:
     * `{ status: 'none' }` (no live challenge — missing or expired),
     * `{ status: 'invalid', attemptsRemaining }`, or `{ status: 'ok', email }`.
     */
    checkEmailChallenge(orgId: string, code: unknown, { at = now() }: At = {}): EmailChallengeCheck {
      const r = emailOf(orgId);
      if (!liveChallenge(r, at)) return { status: 'none' };
      if (r.code_hash !== hashCode(code))
        return { status: 'invalid', attemptsRemaining: Math.max(0, EMAIL_CHALLENGE_MAX_ATTEMPTS - r.attempts - 1) };
      return { status: 'ok', email: r.email };
    },
    /**
     * Count one wrong confirmation on the organisation's live challenge (its own
     * statement: a wrong guess is recorded even though the request is refused).
     * Reaching EMAIL_CHALLENGE_MAX_ATTEMPTS invalidates the challenge. Returns
     * `{ attemptsRemaining, invalidated }`; a missing or expired challenge counts nothing.
     */
    noteFailedEmailAttempt(
      orgId: string,
      { at = now() }: At = {},
    ): { attemptsRemaining: number; invalidated: boolean } {
      return operation(() => {
        const r = emailOf(orgId);
        if (!liveChallenge(r, at)) return { attemptsRemaining: 0, invalidated: false };
        const { attempts } = stmt.emailFail.get(orgId) as { attempts: number };
        if (attempts >= EMAIL_CHALLENGE_MAX_ATTEMPTS) {
          stmt.emailDelete.run(orgId);
          return { attemptsRemaining: 0, invalidated: true };
        }
        return { attemptsRemaining: EMAIL_CHALLENGE_MAX_ATTEMPTS - attempts, invalidated: false };
      });
    },
    /**
     * Consume the organisation's live challenge if `code` matches: deletes the
     * row and returns `{ email }`, or returns null (nothing changed). Meant for
     * the confirmation unit of work, so the deletion commits with the
     * organisation's verification or not at all.
     */
    consumeEmailChallenge(orgId: string, code: unknown, { at = now() }: At = {}): { email: string } | null {
      return operation(() => {
        const r = emailOf(orgId);
        if (!liveChallenge(r, at) || r.code_hash !== hashCode(code)) return null;
        const { changes } = stmt.emailConsume.run(orgId, r.code_hash, at, EMAIL_CHALLENGE_MAX_ATTEMPTS);
        if (changes !== 1)
          throw new Error(
            `email challenges: the challenge of organisation ${orgId} could not be consumed (${changes} row(s) deleted)`,
          );
        return { email: r.email };
      });
    },
    /** Remove the organisation's challenge, live or not (an explicit act). Returns how many rows went. */
    revokeEmailChallenge: (orgId: string): number => operation(() => changes(stmt.emailDelete.run(orgId).changes)),

    // ---------------------------------------------------------- pairing codes
    /** Mint (or replace) the child's pairing code. Returns the plain code ONCE, with the expiry. Durable before it returns. */
    issuePairingCode(playerId: string, { at = now() }: At = {}): IssuedCode {
      // The code is the lookup key: a fresh draw that equals another child's live code (≈ live codes / 31^6) is redrawn, never shared.
      return operation(() => {
        if (typeof playerId !== 'string' || !playerId) throw new TypeError('a pairing code needs a player id');
        const expiresAt = at + PAIRING_CODE_TTL_MS;
        stmt.pairSweep.run(at);
        stmt.pairDeleteFor.run(playerId);
        for (let draw = 0; draw < 8; draw++) {
          const code = newCode();
          if (pairingOf(hashCode(code))) continue;
          stmt.pairInsert.run(hashCode(code), playerId, expiresAt);
          return { code, expiresAt };
        }
        throw new Error('pairing codes: eight consecutive draws collided with live codes; nothing was issued');
      });
    },
    /** The live code's owner, without consuming it: `{ playerId }` or null. */
    peekPairingCode(code: unknown, { at = now() }: At = {}): { playerId: string } | null {
      const r = pairingOf(hashCode(code));
      return r && r.expires_at > at ? { playerId: r.player_id } : null;
    },
    /**
     * Consume a live pairing code: deletes the row and returns `{ playerId }`,
     * or returns null (nothing changed). Meant for the pairing unit of work, so
     * the code goes exactly when the session it buys is committed.
     */
    consumePairingCode(code: unknown, { at = now() }: At = {}): { playerId: string } | null {
      return operation(() => {
        const hash = hashCode(code);
        const r = pairingOf(hash);
        if (!r || r.expires_at <= at) return null;
        const { changes } = stmt.pairConsume.run(hash, at);
        if (changes !== 1)
          throw new Error(
            `pairing codes: the code of player ${r.player_id} could not be consumed (${changes} row(s) deleted)`,
          );
        return { playerId: r.player_id };
      });
    },
    /** Remove the child's codes, live or not (the deletion unit calls this before the player row goes). Returns how many rows went. */
    revokePairingCodesFor: (playerId: string): number =>
      operation(() => changes(stmt.pairDeleteFor.run(playerId).changes)),

    /** Every stored row in its stored form (`codeHash`, never a code). */
    exportEmailChallenges: (): EmailChallengeRow[] => EMAIL_CHALLENGES_TABLE.read(sqlite) ?? [],
    exportPairingCodes: (): PairingCodeRow[] => PAIRING_CODES_TABLE.read(sqlite) ?? [],
  };
  return repo;
}
export type OneTimeCodesRepository = ReturnType<typeof createOneTimeCodesRepository>;
