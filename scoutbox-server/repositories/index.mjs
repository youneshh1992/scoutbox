/**
 * The data layer: real tables in the same SQLite file as the snapshot store,
 * one domain at a time. `attachDataLayer` runs the table migrations, attaches
 * each domain repository, and replaces that domain's `db.<collection>` with
 * the repository's read-only view. Everything else in `db` is still the blob
 * snapshot until its domain moves here.
 *
 * Order at boot (server.mjs): seed → loadSnapshot → snapshot migrations →
 * attachDataLayer → module registration → listen. A migrated collection is
 * therefore a plain array (seed or legacy blob) while the snapshot migrations
 * run, and a repository view from this point on.
 *
 * This directory is `repositories/`, not `data/`: `data/` is the server's
 * runtime data directory (DATA_DIR), which tests delete between runs.
 */
import { runDataMigrations, dataSchemaReport } from './database.mjs';
import { createUsersRepository, USERS_TABLE } from './users.mjs';
import * as m0001 from './migrations/0001_org_users.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001]);

const TABLES = Object.freeze([USERS_TABLE]);

/** Collections the data layer owns; the server's store never writes these blobs again. */
export const TABLE_BACKED = Object.freeze(TABLES.map((t) => t.name));

/**
 * Whole-snapshot access for tools that read or write the database file as one
 * unit: backups, restores and the persistence suites. `readTableBacked` returns
 * every table-backed collection whose table exists, as plain arrays in the
 * shape the server sees; `writeTableBacked` replaces the contents of every
 * such table from `db` and returns the names it wrote, so the caller writes
 * the remaining collections as blobs. The caller owns the transaction.
 */
export function readTableBacked(sqlite) {
  const out = {};
  for (const table of TABLES) {
    const rows = table.read(sqlite);
    if (rows) out[table.name] = rows;
  }
  return out;
}
export function writeTableBacked(sqlite, db) {
  const written = [];
  for (const table of TABLES) {
    if (!Array.isArray(db?.[table.name])) continue;
    if (table.replace(sqlite, db[table.name])) written.push(table.name);
  }
  return written;
}

export function attachDataLayer({ db, store, nextId, persist, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store.sqlite ?? null;
  const migrations = sqlite ? runDataMigrations(sqlite, DATA_MIGRATIONS, { log }) : { ran: [], applied: 0, known: DATA_MIGRATIONS.length };

  const users = createUsersRepository({ sqlite, nextId, persist, log, warn });
  const usersBoot = users.attach(db.users);
  Object.defineProperty(db, 'users', { value: users.view, writable: false, configurable: false, enumerable: true });

  return {
    users,
    migrations,
    boot: { users: usersBoot },
    report: () => ({ ...dataSchemaReport(sqlite, DATA_MIGRATIONS), domains: { users: { rows: users.count() } } }),
  };
}
