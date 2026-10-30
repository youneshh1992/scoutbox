// S6a rollback: produce a copy of a database that the S5 build (2178c5b / 7fbce74) can run.
//
// Restoring a pre-S6a backup is NOT a rollback: it discards every write made
// since the backup. This tool instead works on a copy of the CURRENT file
// (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0008_one_time_codes;
//   3. writes the `emailChallenges` and `pairingCodes` blobs that build reads
//      EMPTY — a stored row holds only the code's hash, which cannot become the
//      plain code the S5 build compares, so every outstanding (unexpired) code
//      is INVALIDATED and counted below; an organisation requests a fresh
//      challenge, a guardian mints a fresh pairing code; nothing else changes:
//      organisations and their verification flags, players, guardians, links,
//      sessions, staff, the media-removal queue, the sub-record tables and every
//      other collection are exactly as they are — nobody signs in again;
//   4. drops the two tables, removes the 0008 record and its meta key, advances
//      the save revision, checks every foreign key, VACUUMs and revalidates the copy.
// A failure at any step removes the output: there is never a partial copy.
// To go further back (to the S4a build), run scripts/playerSubrecordsRollback.mjs
// on THIS tool's output: that tool refuses a database carrying 0008.
//
// Usage: node scripts/oneTimeCodesRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0008,
//             10 a recorded 0008 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackOneTimeCodesCopy } from '../repositories/oneTimeCodesRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/oneTimeCodesRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackOneTimeCodesCopy(source, outDir);
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
  console.log(`INVALIDATED by this rollback (hashes cannot become codes): ${result.invalidated.emailChallenges} outstanding club e-mail challenge(s), ${result.invalidated.pairingCodes} outstanding child pairing code(s); also dropped: ${result.expired.emailChallenges} + ${result.expired.pairingCodes} already-expired row(s)`);
  console.log(`0008 record removed: ${result.recordRemoved}; saveSeq now ${result.saveSeq}; organisations, players, guardians and sessions untouched`);
  console.log('Point the S5 build (2178c5b or 7fbce74) at the output directory to run it; the source directory is unchanged. Affected organisations request a fresh code; affected guardians mint a fresh pairing code.');
}
