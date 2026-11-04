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
 * Typed columns, valid input only: a record holds the named fields and
 * nothing else. Unknown keys are not stored (a legacy blob import drops them
 * and reports each with the row id); a known field of the wrong type is
 * refused by name, never stored.
 *
 * node:sqlite is required: the repository has no in-memory engine, and
 * `createUsersRepository` refuses a missing connection (store.mjs refuses to
 * open at all without node:sqlite, before any data is touched).
 */
import { readonlyView } from './readonly.mjs';
import { transaction, migrationApplied } from './database.mjs';

/**
 * The typed columns (the fidelity rule, 3 November 2026: typed columns, valid
 * input only). A record holds these fields and nothing else; a field the
 * schema does not name is not stored.
 */
const STRINGS = {
  orgId: 'org_id', name: 'name', role: 'role', email: 'email', ssoSubject: 'sso_subject',
  removedBy: 'removed_by', provenance: 'provenance',
};
const INTEGERS = { createdAt: 'created_at', removedAt: 'removed_at' };
const OBJECTS = { mfa: 'mfa_json', deliveryPrefs: 'delivery_prefs_json' };
const KNOWN = new Set(['id', ...Object.keys(STRINGS), ...Object.keys(INTEGERS), ...Object.keys(OBJECTS)]);

const SELECT = 'SELECT id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json FROM org_users';
const COLUMN_LIST = 'id, org_id, name, role, email, sso_subject, created_at, removed_at, removed_by, provenance, mfa_json, delivery_prefs_json';
const PARAM_LIST = '@id, @org_id, @name, @role, @email, @sso_subject, @created_at, @removed_at, @removed_by, @provenance, @mfa_json, @delivery_prefs_json';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Why `value` cannot be stored as `key`, or null when it can (null/undefined mean "unset" and always can). */
function offType(key, value) {
  if (value === undefined || value === null) return null;
  if (key in STRINGS) return typeof value === 'string' ? null : 'must be text';
  if (key in INTEGERS) return Number.isSafeInteger(value) ? null : 'must be an integer timestamp';
  if (key in OBJECTS) return isPlainObject(value) ? null : 'must be an object';
  return null;
}

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
  return row;
}

/** Column parameters for a record whose known fields are already typed (unknown keys are ignored). */
function toParams(row) {
  return {
    id: row.id, org_id: row.orgId, name: row.name, role: row.role ?? null,
    email: row.email ?? null, sso_subject: row.ssoSubject ?? null,
    created_at: row.createdAt ?? null, removed_at: row.removedAt ?? null, removed_by: row.removedBy ?? null,
    provenance: row.provenance ?? null,
    mfa_json: row.mfa == null ? null : JSON.stringify(row.mfa),
    delivery_prefs_json: row.deliveryPrefs == null ? null : JSON.stringify(row.deliveryPrefs),
  };
}

/** The record's known, set fields only (a copy); unknown keys and unset values are left out. */
function knownFields(row) {
  const out = {};
  for (const key of Object.keys(row)) if (KNOWN.has(key) && row[key] !== undefined && row[key] !== null) out[key] = clone(row[key]);
  return out;
}

/**
 * Type a staff row from a legacy blob for import: unknown fields and
 * wrong-typed optional values are dropped, each reported with the row id and
 * field name (never the value). The caller has already checked isStaffRow.
 */
function typeForImport(raw) {
  const notes = [];
  const record = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) { notes.push(`staff ${raw.id}: unknown field ${key} dropped`); continue; }
    const why = offType(key, raw[key]);
    if (why) { notes.push(`staff ${raw.id}: ${key} ${why}; dropped`); continue; }
    if (raw[key] !== undefined && raw[key] !== null) record[key] = clone(raw[key]);
  }
  return { record, notes };
}

/** Refuse (by code, id and field, never the value) a record whose known field holds the wrong type. */
function refuseOffType(row, code) {
  for (const key of Object.keys(row)) {
    if (!KNOWN.has(key)) continue;
    const why = offType(key, row[key]);
    if (why) throw new TypeError(`${code}: staff ${typeof row.id === 'string' ? row.id : '(no id)'}: ${key} ${why}`);
  }
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
   * `prune: false` (S8a-core) leaves the deletions to a later `prune(sqlite, rows)`
   * call: since migration 0015 the recruitment_requests rows reference org_users
   * (RESTRICT), so a snapshot write prunes the requests it no longer lists before
   * the staff rows they named — the same children-before-parents order every
   * other prune of the snapshot write follows.
   */
  replace(sqlite, rows, { prune = true } = {}) {
    if (!cutOver(sqlite)) return false;
    const list = (Array.isArray(rows) ? rows : []).filter(isStaffRow);
    // Unknown keys are not stored; a known field of the wrong type refuses the
    // whole write before any row is touched.
    for (const row of list) refuseOffType(row, 'ORG_USERS_SNAPSHOT_INVALID');
    const upsert = sqlite.prepare(`INSERT INTO org_users (${COLUMN_LIST}) VALUES (${PARAM_LIST})
      ON CONFLICT(id) DO UPDATE SET org_id = excluded.org_id, name = excluded.name, role = excluded.role, email = excluded.email, sso_subject = excluded.sso_subject,
        created_at = excluded.created_at, removed_at = excluded.removed_at, removed_by = excluded.removed_by, provenance = excluded.provenance,
        mfa_json = excluded.mfa_json, delivery_prefs_json = excluded.delivery_prefs_json`);
    for (const row of list) upsert.run(toParams(knownFields(row)));
    if (prune) USERS_TABLE.prune(sqlite, rows);
    return true;
  },
  /**
   * Import a legacy `users` blob into an empty table (the sessions cutover,
   * migration 0003, does this on a pre-S0 file; the caller owns the
   * transaction). Entries that are not staff rows are skipped; unknown fields
   * and wrong-typed optional values are dropped. Returns counts and the notes
   * (row ids and field names only) for the caller's cutover record.
   */
  importLegacy(sqlite, rows) {
    const given = Array.isArray(rows) ? rows : [];
    const insert = sqlite.prepare(`INSERT INTO org_users (${COLUMN_LIST}) VALUES (${PARAM_LIST})`);
    const notes = [];
    const seen = new Set();
    let imported = 0, normalised = 0;
    for (const raw of given) {
      if (!isStaffRow(raw)) continue;
      if (seen.has(raw.id)) { notes.push(`staff ${raw.id}: duplicate id; the later entry skipped`); continue; }
      seen.add(raw.id);
      const t = typeForImport(raw);
      insert.run(toParams(t.record));
      imported += 1;
      if (t.notes.length) { normalised += 1; notes.push(...t.notes); }
    }
    return { imported, skipped: given.length - imported, normalised, notes };
  },
  /** Delete every staff row whose id is absent from `rows` (the second half of `replace`; the caller owns the transaction). */
  prune(sqlite, rows) {
    if (!cutOver(sqlite)) return;
    const keep = (Array.isArray(rows) ? rows : []).filter(isStaffRow).map((r) => r.id);
    const del = sqlite.prepare('DELETE FROM org_users WHERE id = ?');
    for (const r of sqlite.prepare('SELECT id FROM org_users').all()) if (!keep.includes(r.id)) del.run(r.id);
  },
};

export function createUsersRepository({ sqlite, nextId, log = () => {}, warn = () => {}, unit = null }) {
  if (!sqlite) throw new TypeError('the staff repository needs a SQLite connection (node:sqlite); the data layer has no in-memory fallback');
  const rows = [];                 // plain targets, insertion order
  const byIdMap = new Map();       // id → plain target
  const byOrgMap = new Map();      // orgId → plain targets, insertion order
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

  const insertStmt = sqlite.prepare(`INSERT INTO org_users (${COLUMN_LIST}) VALUES (${PARAM_LIST})`);
  const updateStmt = sqlite.prepare(`UPDATE org_users SET org_id = @org_id, name = @name, role = @role, email = @email, sso_subject = @sso_subject, created_at = @created_at,
    removed_at = @removed_at, removed_by = @removed_by, provenance = @provenance, mfa_json = @mfa_json, delivery_prefs_json = @delivery_prefs_json WHERE id = @id`);

  const indexOrg = (target) => { if (!byOrgMap.has(target.orgId)) byOrgMap.set(target.orgId, []); byOrgMap.get(target.orgId).push(target); };
  const remember = (target) => { rows.push(target); byIdMap.set(target.id, target); indexOrg(target); return readonlyView(target, 'a staff record'); };

  function validate(row, { creating = false } = {}) {
    if (typeof row.orgId !== 'string' || !row.orgId) throw new TypeError('a staff record needs an orgId');
    if (typeof row.name !== 'string' || !row.name.trim()) throw new TypeError('a staff record needs a name');
    // Every record created here has a role; a row imported from an older
    // snapshot may lack one, and an update must not refuse to touch it.
    if ((creating || row.role !== undefined) && (typeof row.role !== 'string' || !row.role.trim())) throw new TypeError('a staff record needs a role');
    for (const key of Object.keys(row)) { const why = offType(key, row[key]); if (why) throw new TypeError(`a staff record's ${key} ${why}`); }
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
    listByOrg: (orgId) => (byOrgMap.get(orgId) ?? []).map((u) => readonlyView(u, 'a staff record')),
    count: () => rows.length,

    /** Create a staff record; the id is assigned here, never by the caller. */
    insert(fields) {
      requireAutocommit('insert');
      // Only the typed fields are kept: a key the schema does not name is not stored.
      const target = knownFields(fields);
      delete target.id;
      target.createdAt ??= Date.now();
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
        if (key === 'id' || value === undefined || !KNOWN.has(key)) continue; // a key the schema does not name is not stored
        if (value === null) delete next[key]; else next[key] = clone(value);
      }
      validate(next);
      updateStmt.run(toParams(next));
      const movedOrg = next.orgId !== target.orgId;
      if (movedOrg) { const list = byOrgMap.get(target.orgId); list.splice(list.indexOf(target), 1); }
      for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
      Object.assign(target, next);
      if (movedOrg) { byOrgMap.clear(); for (const u of rows) indexOrg(u); } // keeps each organisation's list in insertion order
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
        const result = transaction(sqlite, () => USERS_TABLE.importLegacy(sqlite, legacy));
        for (const note of result.notes) warn(`org_users: ${note}`);
        log(`org_users: imported ${result.imported} staff record(s) from the users blob${result.normalised ? `; ${result.normalised} with fields dropped` : ''}`);
        for (const u of sqlite.prepare(`${SELECT} ORDER BY rowid`).all()) remember(toRow(u));
        return { engine: 'sqlite', loaded: rows.length, imported: result.imported };
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
