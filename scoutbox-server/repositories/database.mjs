/**
 * The data layer's foundation: versioned table migrations and a transaction helper over the node:sqlite handle that
 * store.mjs opens.
 *
 * Every migration is a module in repositories/migrations/ exporting `{ id,
 * note, up(sqlite) }`. Ids sort lexically (`0001_…`); a migration runs once,
 * inside a transaction, and a failure rolls it back and aborts the boot with
 * the database untouched. */
// node:sqlite is required by the store, which refuses to open without it with
// a compatibility error (store.mjs, runtime.mjs); this module must stay
// importable without it so that refusal is what the operator sees.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export function runDataMigrations(sqlite, migrations, { now = Date.now(), log = () => {}, context = {} } = {}) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const applied = new Set(sqlite.prepare('SELECT id FROM data_migrations').all().map((r) => r.id));
  const ran = [];
  const sorted = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const step of sorted) {
    if (applied.has(step.id)) continue;
    // A step that rebuilds a table other tables reference (`foreignKeysOff`)
    // runs with foreign keys off: SQLite cannot change the setting inside a
    // transaction, and dropping a referenced table with them on would cascade
    // (sessions → org_users). Before such a step commits, foreign_key_check
    // must report nothing, so no dangling reference can be committed.
    const fkOff = step.foreignKeysOff === true;
    if (fkOff) sqlite.exec('PRAGMA foreign_keys = OFF;');
    try {
      sqlite.exec('BEGIN');
      try {
        // `context` carries runtime configuration a data migration needs (the
        // session lifetime, the clock); a migration never reads env itself.
        step.up(sqlite, { now, ...context });
        if (fkOff) {
          const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
          if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) after the rebuild (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
        }
        sqlite.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)').run(step.id, now);
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw new Error(`data migration ${step.id} failed: ${err?.message ?? err}. Boot aborted; the database was not modified.`);
      }
    } finally {
      if (fkOff) sqlite.exec('PRAGMA foreign_keys = ON;');
    }
    ran.push(step.id);
    log(`data migration applied: ${step.id} — ${step.note}`);
  }
  return { ran, applied: applied.size + ran.length, known: sorted.length };
}

/**
 * Work that must run inside every write transaction just before its COMMIT, on this connection: a derived projection
 * bringing itself up to date with what the transaction wrote (the match facts re-derive the players their triggers
 * marked). Runs in `transaction()` below and in the store's units of work; a failure rolls the transaction back like
 * any other. It never decides what the domains write.
 */
const BEFORE_COMMIT = new WeakMap();
export function onBeforeCommit(sqlite, fn) {
  if (typeof fn !== 'function') throw new TypeError('onBeforeCommit needs a function');
  const list = BEFORE_COMMIT.get(sqlite) ?? [];
  list.push(fn);
  BEFORE_COMMIT.set(sqlite, list);
  return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
}
export function runBeforeCommit(sqlite) {
  for (const fn of BEFORE_COMMIT.get(sqlite) ?? []) fn();
}

/** Run `fn` inside one transaction; rethrow after rolling back. */
export function transaction(sqlite, fn) {
  sqlite.exec('BEGIN');
  try {
    const out = fn();
    runBeforeCommit(sqlite);
    sqlite.exec('COMMIT');
    return out;
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * A newest-first history feed, one page's worth: the rows of `from` matching `where` with `h.at` at or
 * before `atMost` (all when null), newest first, enough of them that `n` remain after any skipped at `atMost` itself,
 * and every row that shares the oldest returned instant. A caller merging several feeds and ordering ties its own way
 * (the audit feed orders them by id) can therefore never miss a row that belongs before one it was given.
 * `from` names the history table as `h`; `select` is the column list.
 */
export function newestHistory(sqlite, { select, from, where, params = [] }, atMost, n) {
  const upTo = atMost === null ? '' : ' AND h.at <= ?';
  const p = atMost === null ? params : [...params, atMost];
  const tied = atMost === null ? 0 : sqlite.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where} AND h.at = ?`).get(...params, atMost).n;
  const edge = sqlite.prepare(`SELECT h.at FROM ${from} WHERE ${where}${upTo} ORDER BY h.at DESC LIMIT 1 OFFSET ?`).get(...p, n - 1 + tied);
  return sqlite.prepare(`SELECT ${select} FROM ${from} WHERE ${where}${upTo}${edge ? ' AND h.at >= ?' : ''} ORDER BY h.at DESC`).all(...p, ...(edge ? [edge.at] : []));
}

/**
 * The child rows of many parents in one query per chunk of ids, for decoding a list: rather than one
 * query per child table per record, a list reads each child table once. Returns a stand-in for the per-record
 * statement, `{ all(parentId, ...subKey) }`, answering the same rows in the same order: `order` must be the per-record
 * statement's ORDER BY, and `subKey` names the further columns that statement filters on (a revision, a session).
 * The ids travel as one JSON parameter, so each child table has one prepared statement, whatever the list's length.
 */
const childStatements = new WeakMap();
export function childRowsOf(sqlite, table, parentCol, parentIds, { order = 'rowid', subKey = [], where = '' } = {}) {
  const groups = new Map();
  const ids = [...new Set(parentIds)];
  if (ids.length) {
    let cache = childStatements.get(sqlite); if (!cache || cache.preparedBy !== sqlite.prepare) { cache = new Map(); cache.preparedBy = sqlite.prepare; childStatements.set(sqlite, cache); }
    const sql = `SELECT * FROM ${table} WHERE ${where ? `${where} AND ` : ''}${parentCol} IN (SELECT value FROM json_each(?)) ORDER BY ${parentCol}, ${order}`;
    let stmt = cache.get(sql); if (!stmt) cache.set(sql, (stmt = sqlite.prepare(sql)));
    for (const r of stmt.all(JSON.stringify(ids))) {
      const k = [r[parentCol], ...subKey.map((c) => r[c])].join('\u0000');
      let list = groups.get(k); if (!list) groups.set(k, (list = [])); list.push(r);
    }
  }
  return { all: (...k) => groups.get(k.join('\u0000')) ?? [] };
}

/**
 * Has this migration been recorded as applied? False when the bookkeeping table does not exist yet. A table's
 * existence or occupancy says nothing about which migrations have run.
 */
export function migrationApplied(sqlite, id) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get()) return false;
  return !!sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(id);
}

/** Operator-facing view of the table schema: ids and counts only. */
export function dataSchemaReport(sqlite, migrations) {
  if (!sqlite) throw new TypeError('dataSchemaReport needs a SQLite connection; the data layer has no in-memory engine');
  const applied = sqlite.prepare('SELECT COUNT(*) AS n FROM data_migrations').get()?.n ?? 0;
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('meta', 'data_migrations', 'counters') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const appliedIds = sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id);
  return { engine: 'sqlite', migrationsApplied: applied, migrationsKnown: migrations.length, migrations: appliedIds, tables };
}
