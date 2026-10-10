/**
 * The relational data layer's foundation: versioned table migrations and a
 * transaction helper over the node:sqlite handle that store.mjs opens.
 *
 * Why a second migration registry next to m182/migrations.mjs: that one
 * shapes the in-memory snapshot (collections present, fields backfilled) and
 * runs against the loaded object. This one shapes TABLES, runs SQL, and is
 * recorded in the database itself, so a restored file carries its own schema
 * history. The two meet in one place — repositories/index.mjs — which runs
 * the table migrations after the snapshot ones and attaches each domain
 * repository.
 *
 * Every migration is a module in repositories/migrations/ exporting `{ id,
 * note, up(sqlite) }`. Ids sort lexically (`0001_…`); a migration runs once,
 * inside a transaction, and a failure rolls it back and aborts the boot with
 * the database untouched.
 */

export function runDataMigrations(sqlite, migrations, { now = Date.now(), log = () => {}, context = {} } = {}) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const applied = new Set(sqlite.prepare('SELECT id FROM data_migrations').all().map((r) => r.id));
  const ran = [];
  const sorted = [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const step of sorted) {
    if (applied.has(step.id)) continue;
    sqlite.exec('BEGIN');
    try {
      // `context` carries runtime configuration a data migration needs (the
      // session lifetime, the clock); a migration never reads env itself.
      step.up(sqlite, { now, ...context });
      sqlite.prepare('INSERT INTO data_migrations (id, applied_at) VALUES (?, ?)').run(step.id, now);
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new Error(`data migration ${step.id} failed: ${err?.message ?? err}. Boot aborted; the database was not modified.`);
    }
    ran.push(step.id);
    log(`data migration applied: ${step.id} — ${step.note}`);
  }
  return { ran, applied: applied.size + ran.length, known: sorted.length };
}

/** Run `fn` inside one transaction; rethrow after rolling back. */
export function transaction(sqlite, fn) {
  sqlite.exec('BEGIN');
  try {
    const out = fn();
    sqlite.exec('COMMIT');
    return out;
  } catch (err) {
    sqlite.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Has this migration been recorded as applied? False when the bookkeeping
 * table does not exist yet. This is the ONLY way to tell whether a domain has
 * cut over: a table's existence or occupancy says nothing (the S1 shadow
 * created `sessions` long before S2 made it authoritative).
 */
export function migrationApplied(sqlite, id) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get()) return false;
  return !!sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(id);
}

/** Operator-facing view of the table schema: ids and counts only. */
export function dataSchemaReport(sqlite, migrations) {
  if (!sqlite) throw new TypeError('dataSchemaReport needs a SQLite connection; the data layer has no in-memory engine');
  const applied = sqlite.prepare('SELECT COUNT(*) AS n FROM data_migrations').get()?.n ?? 0;
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('collections', 'meta', 'data_migrations') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const appliedIds = sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id);
  return { engine: 'sqlite', migrationsApplied: applied, migrationsKnown: migrations.length, migrations: appliedIds, tables };
}
