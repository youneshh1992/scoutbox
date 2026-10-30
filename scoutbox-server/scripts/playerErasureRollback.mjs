// S4b-R rollback: produce a copy of a database that the pre-S4b-R build (the accepted
// commit f0abd34) can run.
//
// NEVER boot that build directly on a live file that carries 0014: it skips the record
// it does not know, reads every players row as an account and would serve a retained
// record as a live, passwordless player named "Deleted player". Restoring a pre-S4b-R
// backup is not a rollback either: it discards every write since the backup. This tool
// works on a copy of the CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so whatever
//      the WAL side file holds is in the copy) to <out-dir>/scoutbox.db — the source is
//      never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not know (a
//      later schema step needs its own rollback; no partial downgrade) and a copy that
//      never applied 0014_player_erasure;
//   3. moves every retained player record (id, deletedAt, birthDate, country) out of
//      the players table into the `playersRetained` legacy blob — which that build loads
//      under a name no route reads, keeps through its saves and exports in its backups,
//      and serves to nobody as an account — so nothing written since the cutover is
//      lost and no retained record is ever served as a player;
//   4. removes the 0014 record and its meta key, advances the save revision, checks
//      every foreign key, VACUUMs and revalidates the copy (the live rows and every other
//      table exactly as in the source; the blob holding exactly the records).
// The erased personal data is restored by NOTHING: the copy carries the retained
// records, not the deleted accounts. A failure at any step removes the output.
// To go further back (to the S7d build), run scripts/safetyAuditRollback.mjs on THIS
// tool's output: that tool refuses a database carrying 0014.
//
// Usage: node scripts/playerErasureRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0014,
//             10 a recorded 0014 whose table is missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackPlayerErasureCopy } from '../repositories/playerErasureRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/playerErasureRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackPlayerErasureCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  if (err?.code === 'NOT_CUT_OVER') { console.error(`refused: ${err.message}`); process.exit(5); }
  if (err?.code === 'UNEXPECTED_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(10); }
  if (err?.code === 'OUTPUT_NOT_EMPTY' || err?.code === 'NO_SOURCE') { console.error(`refused: ${err.message}`); process.exit(1); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`${result.retained} retained player record(s) moved out of the players table into the playersRetained legacy blob; nothing written since the cutover is lost; the erased personal data is not restored`);
  console.log(`0014_player_erasure record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
