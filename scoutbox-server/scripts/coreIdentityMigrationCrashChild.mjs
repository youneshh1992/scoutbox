// Child process for scripts/testCoreIdentityMigration.mjs: runs the real
// migration 0005 through the real runner on <dir>/scoutbox.db (an S3-shaped
// temporary database the parent prepared) and kills itself with SIGKILL at the
// moment the runner asks for COMMIT — after the shadow tables were dropped, the
// live tables created, every row imported and the metadata written. The parent
// reopens the file and expects the pre-migration state everywhere (SQLite's
// journal rolls the open transaction back on the next open). Synthetic data only.
//   node scripts/coreIdentityMigrationCrashChild.mjs <data-dir>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { DATA_MIGRATIONS } from '../repositories/index.mjs';
import * as m0005 from '../repositories/migrations/0005_core_identity_live.mjs';
// The registered list now includes 0005 (and 0006 after it); the crash is armed on 0005's COMMIT.

const dir = process.argv[2];
const NOW = Date.UTC(2026, 9, 11, 12);
const sqlite = new DatabaseSync(path.join(dir, 'scoutbox.db'));
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
const exec = sqlite.exec.bind(sqlite);
sqlite.exec = (sql) => {
  if (sql === 'COMMIT') {
    const live = sqlite.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('players') WHERE name = 'facets_json'").get().n;
    const rows = sqlite.prepare('SELECT COUNT(*) AS n FROM players').get().n;
    const marker = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(m0005.CORE_IDENTITY_CUTOVER_META);
    if (live !== 1 || rows === 0 || !marker) throw new Error(`fixture: expected the live table, imported rows and the cutover record inside the transaction (live=${live}, rows=${rows}, marker=${!!marker})`);
    process.stdout.write('ABOUT_TO_CRASH\n');
    process.kill(process.pid, 'SIGKILL');
  }
  return exec(sql);
};
runDataMigrations(sqlite, DATA_MIGRATIONS, { now: NOW, context: { sessionTtlMs: 30 * 86_400_000 } });
process.stdout.write('SURVIVED\n');
