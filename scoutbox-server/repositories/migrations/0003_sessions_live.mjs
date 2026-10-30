/**
 * Sessions cut over (migration plan step S2).
 *
 * Inside the one transaction the runner opens, this migration:
 *   1. reads the authoritative legacy `sessions` blob straight from the
 *      `collections` table (not from memory, so a stale in-memory copy or a
 *      half-loaded boot cannot influence it);
 *   2. validates every row without coercion — a string token, a known kind,
 *      a refId, an integer creation time, a staff row for org sessions, no
 *      unknown field, unique token and sid — and ABORTS on the first problem
 *      set, naming sids and reasons (never tokens). The runner rolls back,
 *      the boot refuses, the file is untouched and the blob stays the source
 *      of truth. Nothing is dropped silently and nothing is repaired;
 *   3. deletes whatever the S1 shadow left in the `sessions` table (derived
 *      rows), imports the validated sessions with hashed tokens and a
 *      materialised expiry, records the import under `meta.sessionsCutover`
 *      and the lifetime under `meta.sessionTtlMs`;
 *   4. deletes the legacy blob row.
 * The runner then writes the `data_migrations` row and commits. Completion
 * is decided only by that row (repositories/sessions.mjs `attach` refuses to
 * run without it); table occupancy means nothing — an empty deployment has
 * zero sessions and a complete cutover.
 */
import { validateSessionRow, SESSIONS_CUTOVER_MIGRATION, DEFAULT_SESSION_TTL_MS } from '../sessions.mjs';
import { USERS_TABLE } from '../users.mjs';

export const id = SESSIONS_CUTOVER_MIGRATION;
export const note = 'sessions become table-backed: legacy blob validated and imported with hashed tokens, blob retired, in one transaction';

export function up(sqlite, { sessionTtlMs = DEFAULT_SESSION_TTL_MS, now = Date.now() } = {}) {
  // A first installation (or a bare test database) has no `collections` table
  // yet: there is no legacy blob, so the cutover imports nothing and records
  // completion — an empty deployment is a complete cutover.
  const hasCollections = !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get();
  const blobRow = hasCollections ? sqlite.prepare("SELECT value FROM collections WHERE name = 'sessions'").get() : null;
  let legacy = [];
  if (blobRow) {
    try { legacy = JSON.parse(blobRow.value); } catch { throw new Error('SESSIONS_CUTOVER_BLOCKED: the legacy sessions blob is not valid JSON'); }
    if (!Array.isArray(legacy)) throw new Error('SESSIONS_CUTOVER_BLOCKED: the legacy sessions blob is not an array');
  }
  // Staff rows an org session may name live in org_users, which the session
  // foreign key enforces. On a legacy database upgrade (a pre-S0 file whose
  // staff still sit in the `users` blob) that table is empty at this point
  // and the S0 repository would import the blob only after the migrations;
  // so this migration performs that import first, inside the same
  // transaction, with the S0 tooling's own row rule, and retires the users
  // blob. No row is invented: a session naming a staff id that is in neither
  // place is still unsupported and aborts the cutover.
  if (hasCollections && sqlite.prepare('SELECT COUNT(*) AS n FROM org_users').get().n === 0) {
    const usersBlob = sqlite.prepare("SELECT value FROM collections WHERE name = 'users'").get();
    let users = null;
    try { users = usersBlob ? JSON.parse(usersBlob.value) : null; } catch { throw new Error('SESSIONS_CUTOVER_BLOCKED: the legacy users blob is not valid JSON'); }
    if (Array.isArray(users) && users.length) {
      USERS_TABLE.replace(sqlite, users);
      sqlite.prepare("DELETE FROM collections WHERE name = 'users'").run();
    }
  }
  const orgUserExists = (uid) => !!sqlite.prepare('SELECT 1 FROM org_users WHERE id = ?').get(uid);
  const problems = [];
  const rows = [];
  const seenHash = new Set();
  const seenSid = new Set();
  let sidsDerived = 0;
  legacy.forEach((raw, i) => {
    const v = validateSessionRow(raw, { orgUserExists });
    const label = typeof raw?.sid === 'string' ? `sid ${raw.sid}` : `entry #${i}`;
    if (!v.ok) { problems.push(`${label}: ${v.reason}`); return; }
    if (seenHash.has(v.row.tokenHash)) { problems.push(`${label}: duplicate token`); return; }
    if (seenSid.has(v.row.sid)) { problems.push(`${label}: duplicate sid`); return; }
    seenHash.add(v.row.tokenHash); seenSid.add(v.row.sid);
    if (v.sidDerived) sidsDerived += 1;
    rows.push(v.row);
  });
  if (problems.length) {
    throw new Error(`SESSIONS_CUTOVER_BLOCKED: ${problems.length} unsupported session(s) in the legacy blob; revoke or repair them on the current build first — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`);
  }

  sqlite.exec('DELETE FROM sessions'); // the S1 shadow's derived rows, if any
  const insert = sqlite.prepare('INSERT INTO sessions (token_hash, sid, kind, ref_id, org_user_id, via, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.tokenHash, r.sid, r.kind, r.refId, r.userId, r.via, r.createdAt, r.createdAt + sessionTtlMs);
  const meta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  meta.run('sessionsCutover', JSON.stringify({ at: now, imported: rows.length, sidsDerived, blobPresent: !!blobRow }));
  meta.run('sessionTtlMs', String(sessionTtlMs));
  if (hasCollections) sqlite.prepare("DELETE FROM collections WHERE name = 'sessions'").run();
}
