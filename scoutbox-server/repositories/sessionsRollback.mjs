/**
 * S2 rollback on a copy (see scripts/sessionsRollback.mjs for the operator
 * contract). Exported separately so the behaviour is unit-tested without
 * spawning the CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { SESSIONS_CUTOVER_MIGRATION } from './sessions.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze(['0001_org_users', '0002_core_identity_shadow', SESSIONS_CUTOVER_MIGRATION]);

export function rollbackSessionsCopy(sourceFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const output = path.join(outDir, 'scoutbox.db');
  if (fs.existsSync(output)) throw new Error(`${output} already exists`);
  copyDatabaseReadOnly(sourceFile, output);

  const sqlite = new DatabaseSync(output);
  let done = false;
  try {
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const hasMigrations = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get();
    const applied = hasMigrations ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) {
      const err = new Error(`the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
      err.code = 'LATER_SCHEMA';
      throw err;
    }
    sqlite.exec('BEGIN');
    try {
      const recordRemoved = hasMigrations ? sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(SESSIONS_CUTOVER_MIGRATION).changes > 0 : false;
      const hasTable = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
      const sessionsRemoved = hasTable ? sqlite.prepare('DELETE FROM sessions').run().changes : 0;
      sqlite.exec('CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, value TEXT NOT NULL);');
      sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      sqlite.prepare("INSERT INTO collections (name, value) VALUES ('sessions', '[]') ON CONFLICT(name) DO UPDATE SET value = excluded.value").run();
      sqlite.prepare("DELETE FROM meta WHERE key IN ('sessionsCutover', 'sessionTtlMs')").run();
      const seq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(seq));
      sqlite.exec('COMMIT');
      sqlite.exec('VACUUM'); // the deleted hashed rows are not left in free pages of the copy
      done = true;
      return { output, applied, recordRemoved, sessionsRemoved };
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  } finally {
    sqlite.close();
    // A refused or failed run leaves no output: the untouched copy would
    // otherwise sit in the output directory looking like a finished rollback
    // (and, for a later schema, still carrying its hashed sessions).
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
