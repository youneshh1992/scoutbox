/**
 * Bearer sessions: the `sessions` table.
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
import { migrationApplied } from './database.mjs';

export const SESSION_KINDS = Object.freeze(['player', 'guardian', 'org', 'ts_reviewer']);
export const SESSION_VIAS = Object.freeze(['sso']);
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSIONS_CUTOVER_MIGRATION = '0003_sessions_live';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');


const SELECT = 'SELECT sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions';
const toRow = (r) => {
  const row = { sid: r.sid, kind: r.kind, refId: r.ref_id, createdAt: r.created_at, expiresAt: r.expires_at };
  if (r.org_user_id != null) row.userId = r.org_user_id;
  if (r.via != null) row.via = r.via;
  return row;
};
/** The table is trusted only once its migration is recorded. */
const cutOver = (sqlite) => migrationApplied(sqlite, SESSIONS_CUTOVER_MIGRATION);

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SESSIONS_TABLE = {
  name: 'sessions',
  read(sqlite) {
    if (!cutOver(sqlite)) return null;
    return sqlite.prepare('SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY created_at, sid').all()
      .map((r) => ({ ...toRow(r), tokenHash: r.token_hash }));
  },
};

export function createSessionsRepository({ sqlite, sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = Date.now, newToken = () => crypto.randomBytes(24).toString('hex'), newSid = () => crypto.randomBytes(6).toString('hex'), log = () => {} }) {
  if (!sqlite) throw new TypeError('the sessions repository needs a SQLite connection (node:sqlite); sessions have no in-memory or JSON fallback');
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) throw new TypeError('sessionTtlMs must be a positive number of milliseconds');
  const stmt = {
    byHash: sqlite.prepare(`${SELECT} WHERE token_hash = ?`),
    bySid: sqlite.prepare(`${SELECT} WHERE sid = ?`),
    insert: sqlite.prepare('INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
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
    metaPut: sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
  };

  const live = (row, at = now()) => !!row && Number.isInteger(row.createdAt) && row.createdAt > 0 && at - row.createdAt < sessionTtlMs;

  // Every read is a query and every write a statement on the store's connection, so a write inside a unit of work
  // joins it and is undone by its rollback.

  const repo = {
    ttlMs: sessionTtlMs,
    isLive: live,

    /** Boot: refuse to run without the migration record; align expires_at with the configured lifetime. */
    attach() {
      if (!stmt.cutover.get(SESSIONS_CUTOVER_MIGRATION)) throw new Error(`sessions: the cutover record ${SESSIONS_CUTOVER_MIGRATION} is missing from data_migrations; the table cannot be trusted as the source of truth`);
      const stored = Number(stmt.metaGet.get('sessionTtlMs')?.value) || null;
      if (stored !== sessionTtlMs) {
        stmt.retime.run(sessionTtlMs);
        stmt.metaPut.run('sessionTtlMs', String(sessionTtlMs));
        if (stored) log(`sessions: the configured lifetime changed from ${stored} ms to ${sessionTtlMs} ms; expiry of every stored session was recomputed`);
      }
      return { engine: 'sqlite', rows: stmt.count.get().n };
    },

    /** Mint a session. Returns the plain token once, with the stored row beside it. */
    create(kind, refId, { userId = null, via = null } = {}) {
      if (!SESSION_KINDS.includes(kind)) throw new TypeError(`"${kind}" is not a session kind`);
      if (typeof refId !== 'string' || !refId) throw new TypeError('a session needs a refId');
      if (kind === 'org' && (typeof userId !== 'string' || !userId)) throw new TypeError('an org session needs a staff member');
      if (via !== null && !SESSION_VIAS.includes(via)) throw new TypeError(`via "${via}" is not supported`);
      repo.prune();
      const token = newToken();
      const createdAt = now();
      const row = { sid: newSid(), kind, refId, createdAt, expiresAt: createdAt + sessionTtlMs };
      if (kind === 'org') row.userId = userId;
      if (via) row.via = via;
      stmt.insert.run(sha256(token), row.sid, kind, refId, kind === 'org' ? userId : null, via, createdAt, createdAt + sessionTtlMs);
      return { token, session: row };
    },

    /** The live session for a presented bearer token, or null; an expired one is removed on sight. */
    byToken(token) {
      if (typeof token !== 'string' || !token) return null;
      const hash = sha256(token);
      const r = stmt.byHash.get(hash);
      if (!r) return null;
      const row = toRow(r);
      if (!live(row)) { stmt.delHash.run(hash); return null; }
      return row;
    },
    /** The live session with this id (media links are bound to it), or null. */
    bySid(sid) {
      if (typeof sid !== 'string' || !sid) return null;
      const r = stmt.bySid.get(sid);
      const row = r ? toRow(r) : null;
      return live(row) ? row : null;
    },
    /** Does this bearer token name this session? (own-session listing marks the current one) */
    isCurrent(row, token) { return !!row && typeof token === 'string' && !!token && stmt.byHash.get(sha256(token))?.sid === row.sid; },

    listFor: (kind, refId) => stmt.listFor.all(kind, refId).map(toRow),
    listOrgUser: (userId) => stmt.listOrgUser.all(userId).map(toRow),
    count: () => stmt.count.get().n,
    /** Every stored row with its `tokenHash` (never a token). */
    exportRows: () => SESSIONS_TABLE.read(sqlite) ?? [],

    revokeSid: (sid) => stmt.delSid.run(sid).changes,
    revokeToken: (token) => (typeof token === 'string' && token ? stmt.delHash.run(sha256(token)).changes : 0),
    revokeFor: (kind, refId) => stmt.delFor.run(kind, refId).changes,
    revokeOrgUser: (userId) => stmt.delOrgUser.run(userId).changes,
    revokeOwn: (userId, sid) => stmt.delOwn.run(userId, sid).changes,
    /** Delete every expired session. Returns how many went. */
    prune: (at = now()) => stmt.delExpired.run(at - sessionTtlMs).changes,
  };
  return repo;
}
