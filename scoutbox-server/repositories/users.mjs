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
 * Without node:sqlite (the JSON fallback engine) the repository keeps the
 * same API over the snapshot store, so behaviour is identical and only
 * durability differs.
 */
import { readonlyView } from './readonly.mjs';
import { transaction } from './database.mjs';

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

const tableExists = (sqlite) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_users'").get();

/**
 * Whole-table access for tools that treat the database file as one snapshot
 * (backups, restores, the persistence suites' fixtures). Returns null when the
 * table does not exist yet, so a caller can fall back to the blob.
 */
export const USERS_TABLE = {
  name: 'users',
  read(sqlite) {
    if (!tableExists(sqlite)) return null;
    return sqlite.prepare(`${SELECT} ORDER BY rowid`).all().map(toRow);
  },
  /** Replace the table's contents with `rows`; the caller owns the transaction. */
  replace(sqlite, rows) {
    if (!tableExists(sqlite)) return false;
    sqlite.exec('DELETE FROM org_users');
    const insert = sqlite.prepare(`INSERT INTO org_users (id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json)
      VALUES (@id, @org_id, @name, @role, @email, @sso_subject, @created_at, @removed_at, @removed_by, @provenance, @mfa_json, @delivery_prefs_json, @extra_json)`);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isStaffRow(row)) continue;
      insert.run(toParams(clone(row)));
    }
    return true;
  },
};

export function createUsersRepository({ sqlite, nextId, persist, log = () => {}, warn = () => {} }) {
  const rows = [];                 // plain targets, insertion order
  const byIdMap = new Map();       // id → plain target
  const view = readonlyView(rows, 'a staff record');

  const insertStmt = sqlite && sqlite.prepare(`INSERT INTO org_users (id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json, extra_json)
    VALUES (@id, @org_id, @name, @role, @email, @sso_subject, @created_at, @removed_at, @removed_by, @provenance, @mfa_json, @delivery_prefs_json, @extra_json)`);
  const updateStmt = sqlite && sqlite.prepare(`UPDATE org_users SET org_id = @org_id, name = @name, role = @role, email = @email, sso_subject = @sso_subject, created_at = @created_at,
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
      if (insertStmt) insertStmt.run(toParams(target)); else persist();
      return remember(target);
    },

    /**
     * Change fields on a staff record. `undefined` leaves a field alone and
     * `null` clears it. Nested values (mfa, deliveryPrefs) are replaced whole.
     * Returns the same view object callers already hold, now current.
     */
    update(id, patch) {
      const target = byIdMap.get(id);
      if (!target) throw new Error(`staff record ${id} does not exist`);
      if (patch.id !== undefined && patch.id !== id) throw new TypeError('a staff record id never changes');
      const next = { ...target };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || value === undefined) continue;
        if (value === null) delete next[key]; else next[key] = clone(value);
      }
      validate(next);
      if (updateStmt) updateStmt.run(toParams(next));
      for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
      Object.assign(target, next);
      if (!updateStmt) persist();
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
      if (!sqlite) {
        for (const u of legacy) remember(clone(u));
        return { engine: 'memory', loaded: rows.length, imported: 0 };
      }
      const stored = sqlite.prepare(`${SELECT} ORDER BY rowid`).all();
      if (stored.length === 0 && legacy.length) {
        transaction(sqlite, () => { for (const u of legacy) insertStmt.run(toParams(clone(u))); });
        log(`org_users: imported ${legacy.length} staff record(s) from the users blob`);
        for (const u of sqlite.prepare(`${SELECT} ORDER BY rowid`).all()) remember(toRow(u));
        return { engine: 'sqlite', loaded: rows.length, imported: legacy.length };
      }
      if (stored.length && legacy.length) warn(`org_users: the table holds ${stored.length} row(s); a stale users blob with ${legacy.length} row(s) was ignored and will be deleted on the next save`);
      for (const u of stored) remember(toRow(u));
      return { engine: 'sqlite', loaded: rows.length, imported: 0 };
    },
  };
  return repo;
}
