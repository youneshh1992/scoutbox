// Child process for scripts/testCoreIdentityMigration.mjs: runs the real
// migration 0005 through the real runner on <dir>/scoutbox.db (a new temporary
// database the parent prepared with 0001–0004) and kills itself with SIGKILL at
// the moment the runner asks for COMMIT — after the shadow tables were dropped,
// the live tables created and the init state written. The parent
// reopens the file and expects the pre-migration state everywhere (SQLite's
// journal rolls the open transaction back on the next open). Synthetic data only.
//   node scripts/coreIdentityMigrationCrashChild.mjs <data-dir>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import { CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';
// The registered list now includes 0005 (and 0006 after it); the crash is armed on 0005's COMMIT.

const dir = process.argv[2];
const NOW = Date.UTC(2026, 9, 11, 12);
const sqlite = new DatabaseSync(path.join(dir, 'scoutbox.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const exec = sqlite.exec.bind(sqlite);
sqlite.exec = (sql) => {
  if (sql === 'COMMIT') {
    const live = sqlite.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('players') WHERE name = 'facets_json'").get().n;
    const marker = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(CORE_IDENTITY_INIT_META)?.value;
    if (live !== 1 || marker !== 'pending') throw new Error(`fixture: expected the live table and the init state inside the transaction (live=${live}, init=${marker})`);
    process.stdout.write('ABOUT_TO_CRASH\n');
    process.kill(process.pid, 'SIGKILL');
  }
  return exec(sql);
};
runDataMigrations(sqlite, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: 30 * 86_400_000 } });
process.stdout.write('SURVIVED\n');
