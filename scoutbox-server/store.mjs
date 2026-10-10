// SQLite-backed snapshot store (node:sqlite, no native deps). The working set
// stays in memory — the API's data model is unchanged — but every save is an
// atomic transaction into data/scoutbox.db, one row per collection, so a crash
// mid-write can never corrupt state the way a half-written JSON file could.
// A legacy data/db.json snapshot is imported once and then set aside.
//
// node:sqlite is REQUIRED (Node.js 22.5 or later; it is on by default). There
// is no JSON fallback: `openStore` throws a compatibility error before touching
// the data directory, and server.mjs lets that error end the process. Sessions
// (plan step S2) are stored only as token hashes in a table, which a JSON
// snapshot could not hold without keeping plain tokens again.
//
// The data layer under repositories/ moves collections out of this blob store
// one domain at a time, into real tables in the same database file. The store
// has two modes for them:
//
//   server mode   openStore(dir, { tableBacked: [...] }) — the running server.
//                 Those collections belong to their repositories: `save` skips
//                 them (and deletes any blob row left from before the move)
//                 and `load` hands back only what is still a blob, so the
//                 repository can import a legacy blob on the first boot after
//                 the move.
//   snapshot mode openStore(dir) — backups, restores, fixtures and the
//                 persistence suites, which treat the file as one snapshot.
//                 `load` merges each table-backed collection in from its table
//                 and `save` writes it back into that table, so the database
//                 reads and writes as the single shape the server sees.
//
// Whether a table-backed collection is read from and written to its table is
// decided by the domain's cutover record in `data_migrations`
// (repositories/*.mjs, `migrationApplied`), never by whether the table exists:
// before the record the blob is authoritative and the table (an S1 shadow, or a
// rollback copy's emptied table) is left alone; after it the blob is gone.

import fs from 'node:fs';
import path from 'node:path';
import { readTableBacked, writeTableBacked } from './repositories/index.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Reported by openStore, which refuses to run without it.
}

export function openStore(dataDir, { tableBacked = null } = {}) {
  if (!DatabaseSync) {
    const err = new Error(`SQLITE_REQUIRED: ScoutBox needs the node:sqlite module (Node.js 22.5 or later, enabled by default; this is ${process.version}${process.execArgv.some((a) => /no-experimental-sqlite/.test(a)) ? ', started with --no-experimental-sqlite' : ''}). There is no JSON fallback. The data directory was not touched.`);
    err.code = 'SQLITE_REQUIRED';
    throw err;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(dataDir, 'db.json');
  const serverMode = Array.isArray(tableBacked);
  const skip = new Set(serverMode ? tableBacked : []);

  const sqlite = new DatabaseSync(path.join(dataDir, 'scoutbox.db'));
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // A second connection on the same file (backup tooling, the validation
  // command's read-only open, a persistence suite) waits for a writer to
  // finish instead of failing with SQLITE_BUSY.
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const upsertCollection = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
  const deleteCollection = sqlite.prepare('DELETE FROM collections WHERE name = ?');
  const upsertMeta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const readSaveSeq = sqlite.prepare('SELECT value FROM meta WHERE key = ?');

  // Server mode only: an optional projection the data layer registers
  // (repositories/shadow.mjs) when shadow validation is enabled. It runs
  // inside every save transaction, in a savepoint of its own, so a projection
  // failure is recorded and rolled back without touching the blob save. With
  // no projection registered (the default) a save is exactly the S0 path.
  let projection = null;
  let projectionFailures = 0;
  let lastProjectionError = null;

  /**
   * One save transaction. `asSnapshot` writes every collection the way snapshot
   * mode does — into its table when the domain has cut over, as a blob
   * otherwise — regardless of the mode the store was opened in. Server-mode
   * saves pass false and skip table-backed collections (their repositories
   * write their tables row by row).
   */
  function write(snapshot, { asSnapshot }) {
    sqlite.exec('BEGIN');
    try {
      const inTables = new Set(asSnapshot ? writeTableBacked(sqlite, snapshot.db) : []);
      for (const [name, value] of Object.entries(snapshot.db)) {
        if ((!asSnapshot && skip.has(name)) || inTables.has(name)) { deleteCollection.run(name); continue; }
        upsertCollection.run(name, JSON.stringify(value));
      }
      upsertMeta.run('idCounter', String(snapshot.idCounter));
      upsertMeta.run('savedAt', String(snapshot.savedAt ?? Date.now()));
      // The save revision is what ties a shadow projection to the snapshot
      // it was taken from: wall-clock savedAt can repeat, this cannot.
      const saveSeq = (Number(readSaveSeq.get('saveSeq')?.value) || 0) + 1;
      upsertMeta.run('saveSeq', String(saveSeq));
      if (!asSnapshot && projection) {
        sqlite.exec('SAVEPOINT shadow');
        try {
          projection({ ...snapshot, saveSeq });
          sqlite.exec('RELEASE shadow');
        } catch (err) {
          sqlite.exec('ROLLBACK TO shadow');
          sqlite.exec('RELEASE shadow');
          projectionFailures += 1;
          lastProjectionError = { at: Date.now(), message: String(err?.message ?? err).slice(0, 200) };
        }
      }
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  const store = {
    engine: 'sqlite',
    sqlite,
    setProjection(fn) { projection = typeof fn === 'function' ? fn : null; },
    projectionState: () => ({ enabled: projection !== null, failures: projectionFailures, lastError: lastProjectionError }),
    load() {
      const rows = sqlite.prepare('SELECT name, value FROM collections').all();
      if (rows.length === 0) {
        // One-time import of the pre-SQLite JSON snapshot, then retire the
        // file. EVERY collection the JSON holds is written into the database
        // first — table-backed ones included, as blobs when their domain has
        // not cut over yet (the cutover migration then imports them from the
        // file, which is its one authoritative input), into their tables when
        // it has. Only after that commit is db.json renamed. A failure leaves
        // db.json in place, writes nothing, and is fatal to the caller: it must
        // never be mistaken for "no snapshot, run from seed".
        let legacy = null;
        try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { legacy = null; }
        if (!legacy?.db) return null;
        try {
          write(legacy, { asSnapshot: true });
        } catch (err) {
          const wrapped = new Error(`LEGACY_IMPORT_FAILED: db.json could not be imported into scoutbox.db (${err?.message ?? err}). db.json was left in place and the database was not changed; the server must not start from seed over it.`);
          wrapped.code = 'LEGACY_IMPORT_FAILED';
          wrapped.cause = err;
          throw wrapped;
        }
        fs.renameSync(legacyFile, `${legacyFile}.migrated`);
        return legacy;
      }
      const db = {};
      for (const row of rows) db[row.name] = JSON.parse(row.value);
      if (!serverMode) Object.assign(db, readTableBacked(sqlite));
      const idCounter = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('idCounter')?.value) || 0;
      const savedAt = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('savedAt')?.value) || null;
      const saveSeq = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('saveSeq')?.value) || 0;
      return { db, idCounter, savedAt, saveSeq };
    },
    /** The persisted save revision: incremented by every save of the snapshot, in either mode. */
    revision() { return Number(readSaveSeq.get('saveSeq')?.value) || 0; },
    save(snapshot) { write(snapshot, { asSnapshot: !serverMode }); },
  };
  return store;
}
