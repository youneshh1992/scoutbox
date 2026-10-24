// S2 rollback: produce a copy of a database that the PRE-S2 build can run.
//
// Restoring a pre-S2 backup is NOT a rollback: the backup holds plain tokens
// of every session that existed then, so sessions revoked since would come
// back to life and every write since would be lost. This tool instead works
// on a copy of the CURRENT file and keeps everything except sessions:
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO) to
//      <out-dir>/scoutbox.db — the source is never modified;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step would need its own rollback; no partial
//      downgrade is attempted);
//   3. deletes the `0003_sessions_live` record, deletes every row of the
//      `sessions` table and writes an EMPTY `sessions` blob into
//      `collections`, which is what the pre-S2 store reads;
//   4. advances the save revision so S1's shadow report cannot call its rows
//      current, and prints the counts.
// Hashes cannot be turned back into bearer tokens, so every user signs in
// again on the rolled-back build. That is the point: no revoked credential
// can become usable, and no later write to any other collection is lost.
//
// Usage: node scripts/sessionsRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error, 4 the copy carries a later schema step.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackSessionsCopy } from '../repositories/sessionsRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/sessionsRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(path.join(outDir, 'scoutbox.db'))) { console.error(`${outDir} already holds a scoutbox.db; use an empty directory`); process.exit(1); }

let result;
try {
  result = rollbackSessionsCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`  sessions removed from the table: ${result.sessionsRemoved}; cutover record removed: ${result.recordRemoved ? 'yes' : 'no (was absent)'}`);
  console.log('  every user must sign in again on the pre-S2 build; other collections are unchanged');
  console.log('  historical plain tokens may remain in pre-S2 backups until they are rotated; see OPERATIONS.md');
}
