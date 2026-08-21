// SQLite-backed snapshot store (node:sqlite, no native deps). The working set
// stays in memory — the API's data model is unchanged — but every save is an
// atomic transaction into data/scoutbox.db, one row per collection, so a crash
// mid-write can never corrupt state the way a half-written JSON file could.
// A legacy data/db.json snapshot is imported once and then set aside.

import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Very old Node: the JSON fallback below keeps persistence working.
}

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(dataDir, 'db.json');
  const jsonFile = path.join(dataDir, 'db.json'); // fallback target when sqlite is unavailable

  if (!DatabaseSync) {
    return {
      engine: 'json-fallback',
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
  sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const upsertCollection = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
  const upsertMeta = sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  const store = {
    engine: 'sqlite',
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
      const idCounter = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('idCounter')?.value) || 0;
      const savedAt = Number(sqlite.prepare('SELECT value FROM meta WHERE key = ?').get('savedAt')?.value) || null;
      return { db, idCounter, savedAt };
    },
    save(snapshot) {
      sqlite.exec('BEGIN');
      try {
        for (const [name, value] of Object.entries(snapshot.db)) {
          upsertCollection.run(name, JSON.stringify(value));
        }
        upsertMeta.run('idCounter', String(snapshot.idCounter));
        upsertMeta.run('savedAt', String(snapshot.savedAt ?? Date.now()));
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return store;
}
