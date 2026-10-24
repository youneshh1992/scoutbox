// S5 rollback: produce a copy of a database that the S4a build (480afdb) can run.
//
// Restoring a pre-S5 backup is NOT a rollback: it discards every write made
// since the backup. This tool instead works on a copy of the CURRENT file
// (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0007_player_subrecords;
//   3. writes every player's arrays (media, attendance, timeline, badges,
//      drills, drill results, activity, external ids, season history, medical
//      records, programme completions) back inside facets_json, in the layout
//      the S4a build reads, from the rows of the twelve tables in their order
//      — post-S5 inserts, updates and removals included — and rebuilds the
//      trialReports copies that build reads from the trials collection;
//      drops the twelve tables; leaves players' scalars, guardians, links,
//      sessions, staff, organisations, the media-removal queue and every
//      other collection exactly as they are — nobody signs in again;
//   4. removes the 0007 record and its meta key, advances the save revision,
//      checks every foreign key, VACUUMs and revalidates the copy.
// A failure at any step removes the output: there is never a partial copy.
// To go further back (to the S3 build), run scripts/coreIdentityRollback.mjs
// on THIS tool's output: that tool refuses a database carrying 0007.
//
// Usage: node scripts/playerSubrecordsRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0007,
//             9 the trials collection cannot be read (the trialReports copies cannot be rebuilt),
//             10 a recorded 0007 whose tables are missing or whose players table is not the live one,
//             11 a player row whose shape says a composite (medical, programme) is null or absent while
//                its child rows exist (an inconsistent file: the copy would hide them; resolve by hand).
import fs from 'node:fs';
import path from 'node:path';
import { rollbackPlayerSubrecordsCopy } from '../repositories/playerSubrecordsRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/playerSubrecordsRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackPlayerSubrecordsCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  if (err?.code === 'NOT_CUT_OVER') { console.error(`refused: ${err.message}`); process.exit(5); }
  if (err?.code === 'TRIALS_UNREADABLE') { console.error(`refused: ${err.message}`); process.exit(9); }
  if (err?.code === 'UNEXPECTED_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(10); }
  if (err?.code === 'INCONSISTENT_ROWS') { console.error(`refused: ${err.message}`); process.exit(11); }
  if (err?.code === 'OUTPUT_NOT_EMPTY' || err?.code === 'NO_SOURCE') { console.error(`refused: ${err.message}`); process.exit(1); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`players: ${result.players} (arrays back in facets_json; trialReports rebuilt from the trials); rows moved per table: ${Object.entries(result.rows).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`sessions untouched: ${result.sessions}; 0007 record removed: ${result.recordRemoved}; saveSeq now ${result.saveSeq}`);
  console.log('Point the S4a build (480afdb) at the output directory to run it; the source directory is unchanged.');
}
