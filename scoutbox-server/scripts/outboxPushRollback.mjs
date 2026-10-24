// S7c rollback: produce a copy of a database that the pre-S7c build (the accepted commit 6ca66ba) can run.
//
// Restoring a pre-S7c backup is NOT a rollback: it discards every write made
// since the backup. This tool instead works on a copy of the CURRENT file
// (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0011_outbox_push;
//   3. writes the `outbox`, `pushLog` and `pushTokens` blobs that build reads
//      with EVERY row of the three tables in insertion order, each in the
//      literal its writer wrote — the mailer record or the delivery record with
//      exactly its keys (a null destination kept), the sender record, the
//      registration record with its token decoded to the value and type it was
//      registered with, unknown fields kept — so nothing written after the
//      cutover is lost and the mailer, the sweep, the sender, the registration
//      route and the admin views read identically there;
//   4. drops the three tables, removes the 0011 record and its meta key,
//      advances the save revision, checks every foreign key, VACUUMs and
//      revalidates the copy (each blob holds exactly the rows its table held;
//      every other table — the S7a and S7b tables included — is unchanged).
// A failure at any step removes the output: there is never a partial copy.
// To go further back (to the S7a build), run scripts/dispatchesRollback.mjs
// on THIS tool's output: that tool refuses a database carrying 0011.
//
// Usage: node scripts/outboxPushRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0011,
//             10 a recorded 0011 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackOutboxPushCopy } from '../repositories/outboxPushRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/outboxPushRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackOutboxPushCopy(source, outDir);
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
  console.log(`${result.counts.outbox} outbox record(s), ${result.counts.pushLog} push log record(s) and ${result.counts.pushTokens} device token(s) written back as blobs in their insertion order; nothing written after the cutover is lost`);
  console.log(`0011 record removed: ${result.recordRemoved}; saveSeq now ${result.saveSeq}; every other table untouched`);
  console.log('Point the pre-S7c build (6ca66ba) at the output directory to run it; the source directory is unchanged.');
}
