// S7d rollback: produce a copy of a database that the pre-S7d build (the commit b67bce5,
// whose source under test is byte-identical to the accepted 9119187) can run.
//
// Restoring a pre-S7d backup is NOT a rollback: it discards every write made
// since the backup. This tool instead works on a copy of the CURRENT file
// (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0012_channels;
//   3. writes the `channels` blob that build reads with EVERY thread of the
//      channels table in insertion order — each in the openChannel literal with
//      its optional keys present or absent exactly as recorded, its messages
//      nested in array order in the postMessage literal (clientMsgId present only
//      when stored; the attachment in its clip or trial-report shape), the
//      receipts, and every legacy or unknown field kept at its own level — so
//      nothing written after the cutover is lost and the acceptance routes, the
//      message routes, the receipt routes, the readers, the export and the admin
//      audit read identically there;
//   4. drops the three tables, removes the 0012 record and its meta key,
//      advances the save revision, checks every foreign key, VACUUMs and
//      revalidates the copy (the blob holds exactly the threads and messages the
//      tables held; every other table — the S7a, S7b and S7c tables included — is
//      unchanged).
// A failure at any step removes the output: there is never a partial copy.
// To go further back (to the S7b build), run scripts/outboxPushRollback.mjs
// on THIS tool's output: that tool refuses a database carrying 0012.
//
// Usage: node scripts/channelsRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0012,
//             10 a recorded 0012 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackChannelsCopy } from '../repositories/channelsRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/channelsRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackChannelsCopy(source, outDir);
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
  console.log(`${result.counts.channels} thread(s) with ${result.counts.messages} message(s) written back as the channels blob in their insertion and message order; nothing written after the cutover is lost`);
  console.log(`0012 record removed: ${result.recordRemoved}; saveSeq now ${result.saveSeq}; every other table untouched`);
  console.log('Point the pre-S7d build (b67bce5) at the output directory to run it; the source directory is unchanged.');
}
