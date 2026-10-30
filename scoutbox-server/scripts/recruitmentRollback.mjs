// S8a-core rollback: produce a copy of a database that the pre-S8a build (the accepted
// commit 9b109dc) can run.
//
// Booting that build directly on a live file that carries 0015 is no rollback: it skips
// the record it does not know, finds no `requests` / `trials` blob (the rows are invisible
// to it), and its boot-contract integrity check reports STORE_MISSING and exits 1 before
// listening — nothing served, nothing written (measured on the actual 9b109dc build by
// scripts/testRecruitmentServer.mjs). Restoring a pre-S8a backup is not a rollback
// either: it discards every write since the backup. This tool works on a copy of the
// CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so whatever
//      the WAL side file holds is in the copy) to <out-dir>/scoutbox.db — the source is
//      never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not know (a
//      later schema step needs its own rollback; no partial downgrade) and a copy that
//      never applied 0015_recruitment;
//   3. writes every request and every trial back into the `requests` and `trials` blobs
//      in insertion order, each in its writer's literal with its slots, sessions,
//      evidence, revisions, attendance, history, day containers, report, reminders and
//      keys nested in list order and every absent, null, off-type and unknown field as
//      recorded — so nothing written since the cutover is lost;
//   4. recreates `channels` in its 0012 definition (no request key: that build never
//      had one) with every thread, message and attachment copied back row for row;
//   5. drops the fifteen recruitment tables, removes the 0015 record and its meta key,
//      advances the save revision, checks every foreign key, VACUUMs and revalidates the
//      copy (both blobs holding exactly the counts the tables held, the threads row for
//      row, every other table exactly as in the source).
// A failure at any step removes the output. To go further back (to the S6b build), run
// scripts/playerErasureRollback.mjs on THIS tool's output: that tool refuses a database
// carrying 0015.
//
// Usage: node scripts/recruitmentRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0015,
//             10 a recorded 0015 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackRecruitmentCopy } from '../repositories/recruitmentRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/recruitmentRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackRecruitmentCopy(source, outDir);
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
  console.log(`${result.requests} request(s) and ${result.trials} trial(s) written back into the requests and trials legacy blobs; ${result.channels.channels} thread(s) with ${result.channels.messages} message(s) and ${result.channels.attachments} attachment(s) kept in channels without the request key; nothing written since the cutover is lost`);
  console.log(`0015_recruitment record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
