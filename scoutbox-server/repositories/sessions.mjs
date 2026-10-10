/**
 * Bearer sessions — the second live domain (plan step S2).
 *
 * Owns the `sessions` table and the `db.sessions` read-only view. A session
 * row never stores the bearer token: only `token_hash` (sha256 hex) is kept,
 * and a token is looked up by hashing what the client presents. The token
 * string exists exactly once outside the client: in the return value of
 * `create`, which the login handlers put in their response. Nothing here logs,
 * reports or exports it.
 *
 * Lifetime. A session is live while `now - created_at < sessionTtlMs` and
 * `created_at > 0`, the same rule the server has applied since PRE-M24
 * (`sessionLive`), evaluated against the TTL configured NOW. `expires_at`
 * (= created_at + TTL) is a materialised copy for the prune index and for
 * reporting; when the configured lifetime changes between boots, `attach`
 * rewrites `expires_at` for every row and records the new lifetime in `meta`,
 * so a TTL change applies to existing sessions immediately — exactly as the
 * blob store did, where the TTL was read at boot and applied to every lookup.
 *
 * Rows that cannot be represented (no token, unknown kind, non-integer
 * creation time, an org session without a staff row) are refused: by the
 * cutover migration with an abort (repositories/migrations/0003_sessions_live.mjs)
 * and by the snapshot tooling with a skip it reports. The server itself never
 * creates such a row.
 */
import crypto from 'node:crypto';
import { readonlyView } from './readonly.mjs';

export const SESSION_KINDS = Object.freeze(['player', 'guardian', 'org', 'ts_reviewer']);
export const SESSION_VIAS = Object.freeze(['sso']);
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
export const SESSIONS_CUTOVER_MIGRATION = '0003_sessions_live';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const KNOWN_KEYS = new Set(['token', 'tokenHash', 'sid', 'kind', 'refId', 'userId', 'via', 'createdAt', 'expiresAt']);

/**
 * Decide whether a snapshot session row can be stored, without coercing it.
 * Returns `{ ok: true, row }` with the row normalised to the table's fields
 * (`tokenHash`, `sid`, `kind`, `refId`, `userId`, `via`, `createdAt`), or
 * `{ ok: false, reason }`. `orgUserExists(id)` answers whether a staff row
 * exists. A missing `sid` is derived from the token hash (the server has
 * backfilled sids at boot since M13; that is the one normalisation kept).
 */
export function validateSessionRow(raw, { orgUserExists }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) return { ok: false, reason: `unknown field "${key}"` };
  let tokenHash = null;
  if (typeof raw.token === 'string' && raw.token.length > 0) tokenHash = sha256(raw.token);
  else if (isHash(raw.tokenHash)) tokenHash = raw.tokenHash;
  else return { ok: false, reason: 'no token' };
  if (!SESSION_KINDS.includes(raw.kind)) return { ok: false, reason: `kind "${String(raw.kind)}" is not a session kind` };
  if (typeof raw.refId !== 'string' || !raw.refId) return { ok: false, reason: 'no refId' };
  if (!Number.isInteger(raw.createdAt) || raw.createdAt <= 0) return { ok: false, reason: 'createdAt is not a positive integer timestamp' };
  if (raw.via !== undefined && raw.via !== null && !SESSION_VIAS.includes(raw.via)) return { ok: false, reason: `via "${String(raw.via)}" is not supported` };
  if (raw.kind === 'org') {
    if (typeof raw.userId !== 'string' || !raw.userId) return { ok: false, reason: 'an org session names no staff member' };
    if (!orgUserExists(raw.userId)) return { ok: false, reason: `staff member ${raw.userId} does not exist` };
  } else if (raw.userId !== undefined && raw.userId !== null) {
    return { ok: false, reason: `a ${raw.kind} session must not name a staff member` };
  }
  let sid = raw.sid;
  let sidDerived = false;
  if (sid === undefined || sid === null) { sid = tokenHash.slice(0, 12); sidDerived = true; }
  if (typeof sid !== 'string' || !sid) return { ok: false, reason: 'sid is not a string' };
  return { ok: true, sidDerived, row: { tokenHash, sid, kind: raw.kind, refId: raw.refId, userId: raw.kind === 'org' ? raw.userId : null, via: raw.via ?? null, createdAt: raw.createdAt } };
}

const SELECT = 'SELECT sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions';
const toRow = (r) => {
  const row = { sid: r.sid, kind: r.kind, refId: r.ref_id, createdAt: r.created_at, expiresAt: r.expires_at };
  if (r.org_user_id != null) row.userId = r.org_user_id;
  if (r.via != null) row.via = r.via;
  return row;
};
const tableExists = (sqlite) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
const readTtl = (sqlite) => Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'sessionTtlMs'").get()?.value) || DEFAULT_SESSION_TTL_MS;

/**
 * Whole-table access for tools that treat the file as one snapshot (backups,
 * restores, the persistence suites). Rows carry `tokenHash`, never a token: a
 * hash cannot be turned back into a bearer token, so a snapshot that is
 * written back keeps exactly the sessions it read. A tool may also supply a
 * plain `token` on a row it fabricates (test fixtures); it is hashed on the
 * way in and never stored.
 */
export const SESSIONS_TABLE = {
  name: 'sessions',
  read(sqlite) {
    if (!tableExists(sqlite)) return null;
    return sqlite.prepare('SELECT token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at FROM sessions ORDER BY created_at, sid').all()
      .map((r) => ({ ...toRow(r), tokenHash: r.token_hash }));
  },
  /** Replace the table's contents with `rows`; the caller owns the transaction. Unrepresentable rows are skipped and counted. */
  replace(sqlite, rows, { warn = () => {} } = {}) {
    if (!tableExists(sqlite)) return false;
    const ttl = readTtl(sqlite);
    const orgUserExists = (id) => !!sqlite.prepare('SELECT 1 FROM org_users WHERE id = ?').get(id);
    sqlite.exec('DELETE FROM sessions');
    const insert = sqlite.prepare('INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    let skipped = 0;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const v = validateSessionRow(raw, { orgUserExists });
      if (!v.ok) { skipped += 1; warn(`sessions: a snapshot row was not written (${v.reason})`); continue; }
      const r = v.row;
      try { insert.run(r.tokenHash, r.sid, r.kind, r.refId, r.userId, r.via, r.createdAt, r.createdAt + ttl); }
      catch (err) { skipped += 1; warn(`sessions: a snapshot row was not written (${String(err?.message ?? err).replace(/^SQLITE_\w+:\s*/, '')})`); }
    }
    return { written: true, skipped };
  },
};

export function createSessionsRepository({ sqlite, sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = Date.now, newToken = () => crypto.randomBytes(24).toString('hex'), newSid = () => crypto.randomBytes(6).toString('hex'), log = () => {} }) {
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) throw new TypeError('sessionTtlMs must be a positive number of milliseconds');
  const stmt = sqlite ? {
    byHash: sqlite.prepare(`${SELECT} WHERE token_hash = ?`),
    bySid: sqlite.prepare(`${SELECT} WHERE sid = ?`),
    insert: sqlite.prepare('INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    listFor: sqlite.prepare(`${SELECT} WHERE kind = ? AND ref_id = ? ORDER BY created_at, sid`),
    listOrgUser: sqlite.prepare(`${SELECT} WHERE kind = 'org' AND org_user_id = ? ORDER BY created_at, sid`),
    all: sqlite.prepare(`${SELECT} ORDER BY created_at, sid`),
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
  } : null;

  const live = (row, at = now()) => !!row && Number.isInteger(row.createdAt) && row.createdAt > 0 && at - row.createdAt < sessionTtlMs;

  // db.sessions: a read-only view whose rows are read from the table on each
  // access, with no token or hash. Routes do not iterate sessions any more;
  // this exists so snapshot contracts and any straggling reader keep working.
  const mirror = [];
  const refresh = () => {
    if (!stmt) return;
    let rows;
    try { rows = stmt.all.all(); } catch { return; } // connection closed (a tool serialising after close): keep the last rows
    mirror.length = 0;
    for (const r of rows) mirror.push(toRow(r));
  };
  const view = new Proxy(readonlyView(mirror, 'a session'), { get(target, prop, receiver) { refresh(); return Reflect.get(target, prop, receiver); } });

  const repo = {
    view,
    ttlMs: sessionTtlMs,
    isLive: live,

    /** Boot: refuse to run without the cutover record; align expires_at with the configured lifetime. */
    attach() {
      if (!stmt) return { engine: 'memory', rows: 0 };
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
