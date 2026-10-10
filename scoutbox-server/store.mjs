// SQLite-backed snapshot store (node:sqlite, no native deps). The working set
// stays in memory — the API's data model is unchanged — but every save is an
// atomic transaction into data/scoutbox.db, one row per collection, so a crash
// mid-write can never corrupt state the way a half-written JSON file could.
// A legacy data/db.json snapshot is imported once and then set aside.
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

import fs from 'node:fs';
import path from 'node:path';
import { readTableBacked, writeTableBacked } from './repositories/index.mjs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Very old Node: the JSON fallback below keeps persistence working.
}

export function openStore(dataDir, { tableBacked = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(dataDir, 'db.json');
  const jsonFile = path.join(dataDir, 'db.json'); // fallback target when sqlite is unavailable
  const serverMode = Array.isArray(tableBacked);
  const skip = new Set(serverMode ? tableBacked : []);

  if (!DatabaseSync) {
    return {
      engine: 'json-fallback',
      sqlite: null,
      setProjection() {},
      projectionState: () => ({ enabled: false, failures: 0, lastError: null }),
      revision: () => 0,
      load() {
        try { return JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { return null; }
      },
      save(snapshot) {
        const tmp = `${jsonFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(snapshot));
        fs.renameSync(tmp, jsonFile);
      },
    };
  }

  const sqlite = new DatabaseSync(path.join(dataDir, 'scoutbox.db'));
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
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

  const store = {
    engine: 'sqlite',
    sqlite,
    setProjection(fn) { projection = typeof fn === 'function' ? fn : null; },
    projectionState: () => ({ enabled: projection !== null, failures: projectionFailures, lastError: lastProjectionError }),
    load() {
      const rows = sqlite.prepare('SELECT name, value FROM collections').all();
      if (rows.length === 0) {
        // One-time import of the pre-M7 JSON snapshot, then retire the file.
        try {
          const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
          if (legacy?.db) {
            store.save(legacy);
            fs.renameSync(legacyFile, `${legacyFile}.migrated`);
            return legacy;
          }
        } catch { /* no legacy snapshot — first boot runs from seed */ }
        return null;
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
    save(snapshot) {
      sqlite.exec('BEGIN');
      try {
        const inTables = new Set(serverMode ? [] : writeTableBacked(sqlite, snapshot.db));
        for (const [name, value] of Object.entries(snapshot.db)) {
          if (skip.has(name) || inTables.has(name)) { deleteCollection.run(name); continue; }
          upsertCollection.run(name, JSON.stringify(value));
        }
        upsertMeta.run('idCounter', String(snapshot.idCounter));
        upsertMeta.run('savedAt', String(snapshot.savedAt ?? Date.now()));
        // The save revision is what ties a shadow projection to the snapshot
        // it was taken from: wall-clock savedAt can repeat, this cannot.
        const saveSeq = (Number(readSaveSeq.get('saveSeq')?.value) || 0) + 1;
        upsertMeta.run('saveSeq', String(saveSeq));
        if (serverMode && projection) {
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
    },
  };
  return store;
}
