/**
 * The data layer: real tables in the same SQLite file as the snapshot store,
 * one domain at a time. `attachDataLayer` runs the table migrations, attaches
 * each domain repository, and replaces that domain's `db.<collection>` with
 * the repository's read-only view. Everything else in `db` is still the blob
 * snapshot until its domain moves here.
 *
 * Two kinds of table exist today (docs/architecture/sqlite-migration-plan.md):
 *   - LIVE tables, owned by a repository: org_users (step S0). Writes go
 *     through the repository and the blob is never written again.
 *   - SHADOW tables (step S1): orgs, guardians, players, guardian_children,
 *     sessions. The blob stays the source of truth; the store re-projects
 *     them on every save and the report shows what the target schema refuses.
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
import { createCoreIdentityShadow, CORE_SHADOW_TABLES } from './shadow.mjs';
import * as m0001 from './migrations/0001_org_users.mjs';
import * as m0002 from './migrations/0002_core_identity_shadow.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002]);

const TABLES = Object.freeze([USERS_TABLE]);

/** Collections the data layer owns; the server's store never writes these blobs again. */
export const TABLE_BACKED = Object.freeze(TABLES.map((t) => t.name));

/** Collections mirrored into shadow tables; the blob remains the source of truth. */
export const SHADOWED = CORE_SHADOW_TABLES;

/**
 * Whole-snapshot access for tools that read or write the database file as one
 * unit: backups, restores and the persistence suites. `readTableBacked` returns
 * every table-backed collection whose table exists, as plain arrays in the
 * shape the server sees; `writeTableBacked` replaces the contents of every
 * such table from `db` and returns the names it wrote, so the caller writes
 * the remaining collections as blobs. The caller owns the transaction. Shadow
 * tables are not collections and are not read or written here: the next
 * server save rebuilds them from the snapshot.
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

export function attachDataLayer({ db, store, nextId, persist, sessionTtlMs, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store.sqlite ?? null;
  const migrations = sqlite ? runDataMigrations(sqlite, DATA_MIGRATIONS, { log }) : { ran: [], applied: 0, known: DATA_MIGRATIONS.length };

  const users = createUsersRepository({ sqlite, nextId, persist, log, warn });
  const usersBoot = users.attach(db.users);
  Object.defineProperty(db, 'users', { value: users.view, writable: false, configurable: false, enumerable: true });

  // The shadow runs only on the SQLite engine; it has nothing to project
  // into on the JSON fallback.
  const shadow = sqlite ? createCoreIdentityShadow({ sqlite, sessionTtlMs }) : null;
  if (shadow) store.setProjection?.((snapshotDb) => shadow.project(snapshotDb));

  return {
    users,
    shadow,
    migrations,
    boot: { users: usersBoot },
    report: () => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      domains: { users: { rows: users.count(), mode: 'live' } },
      shadow: shadow ? { ...shadow.report(db), store: store.projectionState?.() ?? null } : { mode: 'unavailable', note: 'The JSON fallback engine has no tables.' },
    }),
  };
}
