/**
 * The data layer: real tables in the same SQLite file as the snapshot store,
 * one domain at a time. `attachDataLayer` runs the table migrations, attaches
 * each domain repository, and replaces that domain's `db.<collection>` with
 * the repository's read-only view. Everything else in `db` is still the blob
 * snapshot until its domain moves here.
 *
 * Two kinds of table exist today (docs/architecture/sqlite-migration-plan.md):
 *   - LIVE tables, owned by a repository: org_users (step S0) and sessions
 *     (step S2, hashed tokens). Writes go through the repository and the
 *     blob is never written again.
 *   - SHADOW tables (step S1): orgs, guardians, players, guardian_children.
 *     The blob stays the source of truth. The projection that
 *     fills them from the snapshot is OFF by default; with
 *     `shadowValidation: true` (SCOUTBOX_SHADOW_VALIDATION=1) the store
 *     re-projects them inside every save, and the report shows what the
 *     target schema refuses. `scripts/validateShadow.mjs` runs the same
 *     projection against a copy of a database file.
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
import { createSessionsRepository, SESSIONS_TABLE } from './sessions.mjs';
import { createOrgsRepository, ORGS_TABLE } from './orgs.mjs';
import { createCoreIdentityShadow, CORE_SHADOW_TABLES } from './shadow.mjs';
import * as m0001 from './migrations/0001_org_users.mjs';
import * as m0002 from './migrations/0002_core_identity_shadow.mjs';
import * as m0003 from './migrations/0003_sessions_live.mjs';
import * as m0004 from './migrations/0004_orgs_live.mjs';

export const DATA_MIGRATIONS = Object.freeze([m0001, m0002, m0003, m0004]);

// Order matters for snapshot writes: organisations first (staff reference
// them), then staff (sessions reference them), then sessions. Deletions of
// rows a snapshot no longer lists (`prune`) run afterwards in reverse order.
const TABLES = Object.freeze([ORGS_TABLE, USERS_TABLE, SESSIONS_TABLE]);

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
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);

/**
 * Check the shape of every table-backed collection a snapshot carries, before
 * anything is dispatched to a table or written as a blob. A collection that
 * is absent (or `undefined`, which JSON cannot carry) is OMITTED: a partial
 * snapshot that leaves that domain alone. A collection that is present but
 * not an array — an object, null, a string, a number — is an explicitly
 * supplied invalid value and THROWS, so the caller's transaction rolls back
 * with nothing written: no table row, and no blob that could carry whatever
 * the value held (a plaintext token, say). Returns the names that are present.
 */
export function checkTableBackedShapes(db) {
  const present = [];
  for (const table of TABLES) {
    const value = db?.[table.name];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new TypeError(`${table.name}: the snapshot collection must be an array of records (got ${describe(value)}); the save was rolled back and nothing was written`);
    present.push(table.name);
  }
  return present;
}

export function writeTableBacked(sqlite, db) {
  const written = [];
  const present = checkTableBackedShapes(db);
  for (const name of present) {
    const table = TABLES.find((t) => t.name === name);
    // `replace` is false before the domain's cutover record exists (the blob
    // is still authoritative, so the caller writes it) and THROWS on a row the
    // table refuses, which rolls the caller's whole transaction back.
    if (table.replace(sqlite, db[name])) written.push(name);
  }
  // Rows the snapshot no longer lists go last, children before parents, so a
  // parent that is still referenced makes the foreign key refuse the save
  // instead of the row disappearing under its dependants.
  for (const name of [...present].reverse()) {
    const table = TABLES.find((t) => t.name === name);
    if (written.includes(name)) table.prune?.(sqlite, db[name]);
  }
  return written;
}

export function attachDataLayer({ db, store, nextId, sessionTtlMs, shadowValidation = false, log = () => {}, warn = (m) => console.warn(m) }) {
  const sqlite = store?.sqlite ?? null;
  if (!sqlite) throw new TypeError('the data layer needs a store with a SQLite connection (node:sqlite); there is no in-memory or JSON fallback');
  const migrations = runDataMigrations(sqlite, DATA_MIGRATIONS, { log, context: { sessionTtlMs } });

  // Organisations (S3) attach before staff: `org_users.org_id` references
  // `orgs`, so a first boot that imports the seed must have its organisations
  // in the table before a staff row can be inserted. Facet changes made on the
  // records between saves are flushed inside every save transaction.
  const orgs = createOrgsRepository({ sqlite, log, warn });
  const orgsBoot = orgs.attach(db.orgs);
  Object.defineProperty(db, 'orgs', { value: orgs.view, writable: false, configurable: false, enumerable: true });
  store.setFlush?.(() => orgs.flush());

  const users = createUsersRepository({ sqlite, nextId, log, warn });
  const usersBoot = users.attach(db.users);
  Object.defineProperty(db, 'users', { value: users.view, writable: false, configurable: false, enumerable: true });

  // Sessions (S2): live table, hashed tokens. The in-memory blob copy loaded
  // before the migrations ran is discarded here; the migration imported the
  // authoritative blob from the file inside its own transaction.
  const sessions = createSessionsRepository({ sqlite, sessionTtlMs, log });
  const sessionsBoot = sessions.attach();
  Object.defineProperty(db, 'sessions', { value: sessions.view, writable: false, configurable: false, enumerable: true });

  // The shadow projects during saves only when validation is switched on.
  // Off by default: a normal save then never touches it.
  const shadow = createCoreIdentityShadow({ sqlite, sessionTtlMs });
  const shadowEnabled = Boolean(shadowValidation);
  if (shadowEnabled) {
    store.setProjection?.((snapshot) => shadow.project(snapshot.db, { savedAt: snapshot.savedAt, saveSeq: snapshot.saveSeq }));
    log('data layer: shadow validation is ON — the five core identity tables are re-projected inside every save');
  }

  return {
    orgs,
    users,
    sessions,
    shadow,
    migrations,
    boot: { orgs: orgsBoot, users: usersBoot, sessions: sessionsBoot },
    /** `details: true` adds row ids, refusal reasons and error text — admin and tooling only. */
    report: ({ details = false } = {}) => ({
      ...dataSchemaReport(sqlite, DATA_MIGRATIONS),
      domains: {
        orgs: { rows: orgs.count(), mode: 'live', transitional: 'facets_json (tactical, squad, lookingFor, federationCheck, agencySettings, verification, unknown fields)' },
        users: { rows: users.count(), mode: 'live' },
        sessions: { rows: sessions.count(), mode: 'live', lifetimeMs: sessions.ttlMs },
      },
      shadow: { ...shadow.report(db, { enabled: shadowEnabled, details }), store: publicStoreState(store.projectionState?.(), details) },
    }),
  };
}

// The store's error text is internal; only the admin report carries it.
function publicStoreState(state, details) {
  if (!state) return null;
  return details ? state : { enabled: state.enabled, failures: state.failures, lastErrorAt: state.lastError?.at ?? null };
}
