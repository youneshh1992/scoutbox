/**
 * Bearer sessions: the `sessions` table.
 *
 * Record (`Session`, frozen): { sid, kind, refId, createdAt, expiresAt, userId?, via? }; `userId` (the staff member) is
 * present only on an org session, `via` only when the session came from SSO.
 *
 * A session row never stores the bearer token: only `token_hash` (sha256 hex) is kept, and a token is looked up by
 * hashing what the client presents. The token string exists exactly once outside the client: in the return value of
 * `create`, which the login handlers put in their response. Nothing here logs, reports or exports it.
 *
 * Lifetime. A session is live while `now - created_at < sessionTtlMs` and `created_at > 0`, evaluated against the TTL
 * configured now. `expires_at` (= created_at + TTL) is a materialised copy for the prune index and for reporting; when
 * the configured lifetime changes between boots, `attach` rewrites `expires_at` for every row and records the new
 * lifetime in `meta`, so a TTL change applies to existing sessions immediately.
 *
 * node:sqlite is required; there is no in-memory or JSON fallback (one would have to keep plain tokens somewhere).
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { migrationApplied, operationOn, type UnitParticipant } from './database.ts';

export const SESSION_KINDS = Object.freeze(['player', 'guardian', 'org', 'ts_reviewer'] as const);
export const SESSION_VIAS = Object.freeze(['sso'] as const);
export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionVia = (typeof SESSION_VIAS)[number];
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSIONS_TABLE_MIGRATION = '0003_sessions_live';

export const sha256 = (s: unknown) => crypto.createHash('sha256').update(String(s)).digest('hex');

type SessionFields = {
  sid: string;
  kind: SessionKind;
  /** The player, guardian, organisation or reviewer the session signs in. */
  refId: string;
  createdAt: number;
  expiresAt: number;
  /** The staff member, on an org session only. */
  userId?: string;
  via?: SessionVia;
};
/** A session as the repository reads it back, frozen. */
export type Session = Readonly<SessionFields>;
/** A session as the whole-domain read carries it: the record plus its token hash (never the token). */
export type SessionSnapshotRow = SessionFields & { tokenHash: string };

type SessionRow = {
  sid: string;
  kind: SessionKind;
  ref_id: string;
  org_user_id: string | null;
  via: SessionVia | null;
  created_at: number;
  expires_at: number;
};
const SELECT = 'SELECT sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions';
const fieldsOf = (r: SessionRow): SessionFields => {
  const row: SessionFields = {
    sid: r.sid,
    kind: r.kind,
    refId: r.ref_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
  if (r.org_user_id != null) row.userId = r.org_user_id;
  if (r.via != null) row.via = r.via;
  return row;
};
const toRow = (r: SessionRow): Session => Object.freeze(fieldsOf(r));
const isKind = (v: unknown): v is SessionKind => (SESSION_KINDS as readonly unknown[]).includes(v);
const isVia = (v: unknown): v is SessionVia => (SESSION_VIAS as readonly unknown[]).includes(v);
/** The table is trusted only once its migration is recorded. */
const cutOver = (sqlite: DatabaseSync) => migrationApplied(sqlite, SESSIONS_TABLE_MIGRATION);

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SESSIONS_TABLE = {
  name: 'sessions',
  read(sqlite: DatabaseSync): SessionSnapshotRow[] | null {
    if (!cutOver(sqlite)) return null;
    const rows = sqlite
      .prepare(
        'SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY created_at, sid',
      )
      .all() as (SessionRow & { token_hash: string })[];
    return rows.map((r) => ({ ...fieldsOf(r), tokenHash: r.token_hash }));
  },
};

export function createSessionsRepository({
  sqlite,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  now = Date.now,
  newToken = () => crypto.randomBytes(24).toString('hex'),
  newSid = () => crypto.randomBytes(6).toString('hex'),
  log = () => {},
  unit = null,
}: {
  sqlite: DatabaseSync;
  sessionTtlMs?: number;
  now?: () => number;
  newToken?: () => string;
  newSid?: () => string;
  log?: (message: string) => void;
  unit?: UnitParticipant | null;
}) {
  if (!sqlite)
    throw new TypeError(
      'the sessions repository needs a SQLite connection (node:sqlite); sessions have no in-memory or JSON fallback',
    );
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0)
    throw new TypeError('sessionTtlMs must be a positive number of milliseconds');
  const operation = operationOn(sqlite, unit);
  const stmt = {
    byHash: sqlite.prepare(`${SELECT} WHERE token_hash = ?`),
    bySid: sqlite.prepare(`${SELECT} WHERE sid = ?`),
    insert: sqlite.prepare(
      'INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    listFor: sqlite.prepare(`${SELECT} WHERE kind = ? AND ref_id = ? ORDER BY created_at, sid`),
    listOrgUser: sqlite.prepare(`${SELECT} WHERE kind = 'org' AND org_user_id = ? ORDER BY created_at, sid`),
    count: sqlite.prepare('SELECT COUNT(*) AS n FROM sessions'),
    delSid: sqlite.prepare('DELETE FROM sessions WHERE sid = ?'),
    delHash: sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    delFor: sqlite.prepare('DELETE FROM sessions WHERE kind = ? AND ref_id = ?'),
    delOrgUser: sqlite.prepare("DELETE FROM sessions WHERE kind = 'org' AND org_user_id = ?"),
    delOwn: sqlite.prepare("DELETE FROM sessions WHERE kind = 'org' AND org_user_id = ? AND sid = ?"),
    delExpired: sqlite.prepare('DELETE FROM sessions WHERE created_at <= 0 OR created_at <= ?'),
    retime: sqlite.prepare('UPDATE sessions SET expires_at = created_at + ?'),
    metaGet: sqlite.prepare('SELECT value FROM meta WHERE key = ?'),
    metaPut: sqlite.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
  };

  const live = (row: Pick<Session, 'createdAt'> | null | undefined, at = now()): boolean =>
    !!row && Number.isInteger(row.createdAt) && row.createdAt > 0 && at - row.createdAt < sessionTtlMs;
  const one = (r: unknown): Session | null => (r ? toRow(r as SessionRow) : null);
  const all = (rs: unknown[]): Session[] => (rs as SessionRow[]).map(toRow);
  const changes = (n: number | bigint) => Number(n);

  // Every read is a query and every write a statement on the store's connection, so a write inside a unit of work
  // joins it and is undone by its rollback.

  const repo = {
    ttlMs: sessionTtlMs,
    isLive: live,

    /** Boot: refuse to run without the migration record; align expires_at with the configured lifetime. */
    attach(): { engine: 'sqlite'; rows: number } {
      if (!stmt.cutover.get(SESSIONS_TABLE_MIGRATION))
        throw new Error(
          `sessions: the cutover record ${SESSIONS_TABLE_MIGRATION} is missing from data_migrations; the table cannot be trusted as the source of truth`,
        );
      const stored = Number((stmt.metaGet.get('sessionTtlMs') as { value: unknown } | undefined)?.value) || null;
      if (stored !== sessionTtlMs) {
        stmt.retime.run(sessionTtlMs);
        stmt.metaPut.run('sessionTtlMs', String(sessionTtlMs));
        if (stored)
          log(
            `sessions: the configured lifetime changed from ${stored} ms to ${sessionTtlMs} ms; expiry of every stored session was recomputed`,
          );
      }
      return { engine: 'sqlite', rows: repo.count() };
    },

    /** Mint a session. Returns the plain token once, with the stored row beside it. */
    create(
      kind: SessionKind,
      refId: string,
      { userId = null, via = null }: { userId?: string | null; via?: SessionVia | null } = {},
    ): { token: string; session: Session } {
      if (!isKind(kind)) throw new TypeError(`"${kind}" is not a session kind`);
      if (typeof refId !== 'string' || !refId) throw new TypeError('a session needs a refId');
      if (kind === 'org' && (typeof userId !== 'string' || !userId))
        throw new TypeError('an org session needs a staff member');
      if (via !== null && !isVia(via)) throw new TypeError(`via "${via}" is not supported`);
      const token = newToken();
      const createdAt = now();
      const row: SessionFields = { sid: newSid(), kind, refId, createdAt, expiresAt: createdAt + sessionTtlMs };
      if (kind === 'org') row.userId = userId as string;
      if (via) row.via = via;
      operation(() => {
        stmt.delExpired.run(createdAt - sessionTtlMs);
        stmt.insert.run(
          sha256(token),
          row.sid,
          kind,
          refId,
          kind === 'org' ? userId : null,
          via,
          createdAt,
          createdAt + sessionTtlMs,
        );
      });
      return { token, session: Object.freeze(row) };
    },

    /** The live session for a presented bearer token, or null. An expired row stays until the next mint prunes it: a read never writes. */
    byToken(token: unknown): Session | null {
      if (typeof token !== 'string' || !token) return null;
      const row = one(stmt.byHash.get(sha256(token)));
      return live(row) ? row : null;
    },
    /** The live session with this id (media links are bound to it), or null. */
    bySid(sid: unknown): Session | null {
      if (typeof sid !== 'string' || !sid) return null;
      const row = one(stmt.bySid.get(sid));
      return live(row) ? row : null;
    },
    /** Does this bearer token name this session? (own-session listing marks the current one) */
    isCurrent(row: Pick<Session, 'sid'> | null | undefined, token: unknown): boolean {
      return !!row && typeof token === 'string' && !!token && one(stmt.byHash.get(sha256(token)))?.sid === row.sid;
    },

    listFor: (kind: SessionKind, refId: string): Session[] => all(stmt.listFor.all(kind, refId)),
    listOrgUser: (userId: string): Session[] => all(stmt.listOrgUser.all(userId)),
    count: (): number => (stmt.count.get() as { n: number }).n,
    /** Every stored row with its `tokenHash` (never a token). */
    exportRows: (): SessionSnapshotRow[] => SESSIONS_TABLE.read(sqlite) ?? [],

    // Each revocation returns how many sessions it ended.
    revokeSid: (sid: string): number => operation(() => changes(stmt.delSid.run(sid).changes)),
    revokeToken: (token: unknown): number =>
      typeof token === 'string' && token ? operation(() => changes(stmt.delHash.run(sha256(token)).changes)) : 0,
    revokeFor: (kind: SessionKind, refId: string): number =>
      operation(() => changes(stmt.delFor.run(kind, refId).changes)),
    revokeOrgUser: (userId: string): number => operation(() => changes(stmt.delOrgUser.run(userId).changes)),
    revokeOwn: (userId: string, sid: string): number => operation(() => changes(stmt.delOwn.run(userId, sid).changes)),
    /** Delete every expired session. Returns how many went. */
    prune: (at = now()): number => operation(() => changes(stmt.delExpired.run(at - sessionTtlMs).changes)),
  };
  // Other domains read sessions; they end one only through the identity domain's `sessionEnds`.
  const reads = Object.freeze({
    ttlMs: sessionTtlMs,
    isLive: live,
    byToken: repo.byToken,
    bySid: repo.bySid,
    isCurrent: repo.isCurrent,
    listFor: repo.listFor,
    listOrgUser: repo.listOrgUser,
    count: repo.count,
  });
  return Object.assign(repo, { reads });
}
export type SessionsRepository = ReturnType<typeof createSessionsRepository>;
export type SessionReads = SessionsRepository['reads'];
