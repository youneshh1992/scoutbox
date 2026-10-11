/**
 * Organisation staff — the first domain repository.
 *
 * Owns the `org_users` table and the `db.users` view. Every write to a staff
 * record goes through `insert` or `update`, which write one row inside the
 * database immediately (no debounce, no whole-collection rewrite) and then
 * refresh the in-memory view the rest of the server reads. The view keeps
 * the exact row shapes routes have always seen: a field that is unset is
 * absent, not null, so no response changes shape.
 *
 * node:sqlite is required: the repository has no in-memory engine, and
 * `createUsersRepository` refuses a missing connection (store.mjs refuses to
 * open at all without node:sqlite, before any data is touched).
 */
import { readonlyView } from './readonly.mjs';
import { transaction, migrationApplied } from './database.mjs';

/** Fields with a column of their own; everything else is kept in extra_json. */
const COLUMNS = {
  orgId: 'org_id', name: 'name', role: 'role', email: 'email', ssoSubject: 'sso_subject',
  createdAt: 'created_at', removedAt: 'removed_at', removedBy: 'removed_by', provenance: 'provenance',
};
const JSON_COLUMNS = { mfa: 'mfa_json', deliveryPrefs: 'delivery_prefs_json' };
const KNOWN = new Set(['id', ...Object.keys(COLUMNS), ...Object.keys(JSON_COLUMNS)]);

const SELECT = 'SELECT id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json FROM org_users';

function toRow(dbRow) {
  const row = { id: dbRow.id, orgId: dbRow.org_id, name: dbRow.name };
  if (dbRow.role != null) row.role = dbRow.role;
  if (dbRow.created_at != null) row.createdAt = dbRow.created_at;
  if (dbRow.email != null) row.email = dbRow.email;
  if (dbRow.sso_subject != null) row.ssoSubject = dbRow.sso_subject;
  if (dbRow.removed_at != null) row.removedAt = dbRow.removed_at;
  if (dbRow.removed_by != null) row.removedBy = dbRow.removed_by;
  if (dbRow.provenance != null) row.provenance = dbRow.provenance;
  if (dbRow.mfa_json != null) row.mfa = JSON.parse(dbRow.mfa_json);
  if (dbRow.delivery_prefs_json != null) row.deliveryPrefs = JSON.parse(dbRow.delivery_prefs_json);
  if (dbRow.extra_json != null) Object.assign(row, JSON.parse(dbRow.extra_json));
  return row;
}

function toParams(row) {
  const extra = {};
  for (const key of Object.keys(row)) if (!KNOWN.has(key)) extra[key] = row[key];
  return {
    id: row.id, org_id: row.orgId, name: row.name, role: row.role ?? null,
    email: row.email ?? null, sso_subject: row.ssoSubject ?? null,
    created_at: row.createdAt ?? null, removed_at: row.removedAt ?? null, removed_by: row.removedBy ?? null,
    provenance: row.provenance ?? null,
    mfa_json: row.mfa == null ? null : JSON.stringify(row.mfa),
    delivery_prefs_json: row.deliveryPrefs == null ? null : JSON.stringify(row.deliveryPrefs),
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

/** A staff row from a snapshot is one with an id, an organisation and a name; anything else is not a staff row. */
const isStaffRow = (u) => !!u && typeof u === 'object' && typeof u.id === 'string' && u.id && typeof u.orgId === 'string' && u.orgId && typeof u.name === 'string' && u.name;

/** The table is authoritative once migration 0001 is recorded (it created the table and cut the domain over in one step). */
const cutOver = (sqlite) => migrationApplied(sqlite, '0001_org_users');

/**
 * Whole-table access for tools that treat the database file as one snapshot
 * (backups, restores, the persistence suites' fixtures). Returns null before
 * the cutover record exists, so a caller keeps using the blob.
 */
export const USERS_TABLE = {
  name: 'users',
  read(sqlite) {
    if (!cutOver(sqlite)) return null;
    return sqlite.prepare(`${SELECT} ORDER BY rowid`).all().map(toRow);
  },
  /**
   * Make the table's contents equal to `rows`; the caller owns the transaction.
   * Rows are upserted in place and only ids absent from `rows` are deleted:
   * `sessions.org_user_id` cascades on delete, so a blanket DELETE + INSERT
   * would silently destroy every staff session whenever a snapshot tool wrote
   * the users collection back. A staff member who is genuinely gone from the
   * snapshot still takes their sessions with them, which is the intent.
   */
  replace(sqlite, rows) {
    if (!cutOver(sqlite)) return false;
    const keep = [];
    const upsert = sqlite.prepare(`INSERT INTO org_users (id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json)
      VALUES (@id, @org_id, @name, @role, @email, @sso_subject, @created_at, @removed_at, @removed_by, @provenance, @mfa_json, @delivery_prefs_json, @extra_json)
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, name = excluded.name, role = excluded.role, email = excluded.email, sso_subject = excluded.sso_subject,
        created_at = excluded.created_at, removed_at = excluded.removed_at, removed_by = excluded.removed_by, provenance = excluded.provenance,
        mfa_json = excluded.mfa_json, delivery_prefs_json = excluded.delivery_prefs_json, extra_json = excluded.extra_json`);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isStaffRow(row)) continue;
      upsert.run(toParams(clone(row)));
      keep.push(row.id);
    }
    const del = sqlite.prepare('DELETE FROM org_users WHERE id = ?');
    for (const r of sqlite.prepare('SELECT id FROM org_users').all()) if (!keep.includes(r.id)) del.run(r.id);
    return true;
  },
};

export function createUsersRepository({ sqlite, nextId, log = () => {}, warn = () => {}, unit = null }) {
  if (!sqlite) throw new TypeError('the staff repository needs a SQLite connection (node:sqlite); the data layer has no in-memory fallback');
  const rows = [];                 // plain targets, insertion order
  const byIdMap = new Map();       // id → plain target
  const view = readonlyView(rows, 'a staff record');
  // Writes commit on their own. This repository's in-memory rows are NOT yet
  // integrated with the store's unit of work (no snapshotState/restoreState),
  // so a write inside a unit — or inside any other open transaction — is
  // refused rather than left half-tracked after a rollback.
  const requireAutocommit = (what) => {
    if (!sqlite.isTransaction) return;
    if (unit?.active?.()) throw new Error(`org_users.${what} is not integrated with the unit of work yet (its in-memory rows would survive a rollback); perform staff changes outside the unit`);
    throw new Error(`org_users.${what} writes in a transaction of its own and cannot run inside an open transaction`);
  };

  const insertStmt = sqlite.prepare(`INSERT INTO org_users (id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json)
    VALUES (@id, @org_id, @name, @role, @email, @sso_subject, @created_at, @removed_at, @removed_by, @provenance, @mfa_json, @delivery_prefs_json, @extra_json)`);
  const updateStmt = sqlite.prepare(`UPDATE org_users SET org_id = @org_id, name = @name, role = @role, email = @email, sso_subject = @sso_subject, created_at = @created_at,
    removed_at = @removed_at, removed_by = @removed_by, provenance = @provenance, mfa_json = @mfa_json, delivery_prefs_json = @delivery_prefs_json, extra_json = @extra_json WHERE id = @id`);

  const remember = (target) => { rows.push(target); byIdMap.set(target.id, target); return readonlyView(target, 'a staff record'); };

  function validate(row, { creating = false } = {}) {
    if (typeof row.orgId !== 'string' || !row.orgId) throw new TypeError('a staff record needs an orgId');
    if (typeof row.name !== 'string' || !row.name.trim()) throw new TypeError('a staff record needs a name');
    // Every record created here has a role; a row imported from an older
    // snapshot may lack one, and an update must not refuse to touch it.
    if ((creating || row.role !== undefined) && (typeof row.role !== 'string' || !row.role.trim())) throw new TypeError('a staff record needs a role');
    for (const key of Object.keys(row)) if (!KNOWN.has(key)) warn(`staff record field "${key}" has no column and is kept in extra_json; promote it in a data migration`);
  }

  const repo = {
    /** The read view the rest of the server uses as `db.users`. */
    view,

    byId: (id) => (id && byIdMap.has(id) ? readonlyView(byIdMap.get(id), 'a staff record') : null),
    byOrgAndName(orgId, name) {
      const wanted = String(name ?? '').trim().toLowerCase();
      if (!wanted) return null;
      const hit = rows.find((u) => u.orgId === orgId && u.name.toLowerCase() === wanted);
      return hit ? readonlyView(hit, 'a staff record') : null;
    },
    listByOrg: (orgId) => rows.filter((u) => u.orgId === orgId).map((u) => readonlyView(u, 'a staff record')),
    count: () => rows.length,

    /** Create a staff record; the id is assigned here, never by the caller. */
    insert(fields) {
      requireAutocommit('insert');
      const target = { ...clone(fields) };
      delete target.id;
      target.createdAt ??= Date.now();
      for (const key of Object.keys(target)) if (target[key] === undefined || target[key] === null) delete target[key];
      validate(target, { creating: true });
      // The id counter is persisted with the snapshot, which is debounced; a
      // row is written immediately. After an abrupt stop the counter can be
      // behind the table, so an id that already exists is skipped, not reused.
      let id = nextId('usr');
      while (byIdMap.has(id)) id = nextId('usr');
      target.id = id;
      insertStmt.run(toParams(target));
      return remember(target);
    },

    /**
     * Change fields on a staff record. `undefined` leaves a field alone and
     * `null` clears it. Nested values (mfa, deliveryPrefs) are replaced whole.
     * Returns the same view object callers already hold, now current.
     */
    update(id, patch) {
      requireAutocommit('update');
      const target = byIdMap.get(id);
      if (!target) throw new Error(`staff record ${id} does not exist`);
      if (patch.id !== undefined && patch.id !== id) throw new TypeError('a staff record id never changes');
      const next = { ...target };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || value === undefined) continue;
        if (value === null) delete next[key]; else next[key] = clone(value);
      }
      validate(next);
      updateStmt.run(toParams(next));
      for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
      Object.assign(target, next);
      return readonlyView(target, 'a staff record');
    },

    /**
     * Boot: load the table, or import the legacy blob array into it when the
     * table is empty (first boot after the move, or a restore from a backup
     * snapshot). Returns what happened, for the boot log.
     */
    attach(legacyRows) {
      const given = Array.isArray(legacyRows) ? legacyRows : [];
      const legacy = given.filter(isStaffRow);
      if (legacy.length !== given.length) warn(`org_users: ${given.length - legacy.length} entry(ies) in the users blob are not staff rows (no id, organisation or name) and were not imported`);
      const stored = sqlite.prepare(`${SELECT} ORDER BY rowid`).all();
      if (stored.length === 0 && legacy.length) {
        transaction(sqlite, () => { for (const u of legacy) insertStmt.run(toParams(clone(u))); });
        log(`org_users: imported ${legacy.length} staff record(s) from the users blob`);
        for (const u of sqlite.prepare(`${SELECT} ORDER BY rowid`).all()) remember(toRow(u));
        return { engine: 'sqlite', loaded: rows.length, imported: legacy.length };
      }
      if (stored.length && legacy.length) {
        // The in-memory array may be the blob a data migration imported into
        // the table a moment ago (S2 does this on a legacy upgrade): then it is
        // superseded, not stale. Only rows the table does not hold are stale.
        const ids = new Set(stored.map((r) => r.id));
        const unknown = legacy.filter((u) => !ids.has(u.id)).length;
        if (unknown) warn(`org_users: the table holds ${stored.length} row(s); a stale users blob with ${unknown} row(s) the table does not hold was ignored and will be deleted on the next save`);
        else log(`org_users: the users blob (${legacy.length} row(s)) is superseded by the table`);
      }
      for (const u of stored) remember(toRow(u));
      return { engine: 'sqlite', loaded: rows.length, imported: 0 };
    },
  };
  return repo;
}
