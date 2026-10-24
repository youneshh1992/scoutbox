// S6b rollback: produce a copy of a database that the pre-S6b build (the accepted
// commit 4f954ad, whose scoutbox-server source is byte-identical to 1792fc7) can run.
//
// Restoring a pre-S6b backup is NOT a rollback: it discards every write made since
// the backup. This tool instead works on a copy of the CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not know
//      (a later schema step needs its own rollback; no partial downgrade) and a
//      copy that never applied 0013_safety_audit;
//   3. writes the eight blobs that build reads — blocks, reports, moderationLog,
//      orgNotes, ledger, opsEvents, sourceChanges, idvQueue — with EVERY row of each
//      table in insertion order in the writer's literal (unknown fields first, absent
//      keys absent, values a route stored as received restored exactly), so nothing
//      written, updated or deleted after the cutover is lost: a lifted block is
//      absent, a resolved report carries its resolution, and every route, list,
//      export and admin console of that build reads identically;
//   4. drops the eight tables, removes the 0013 record and its meta key, advances
//      the save revision, checks every foreign key, VACUUMs and revalidates the copy
//      (each blob holds exactly the rows its table held; every other table — the
//      identity, S5, S6a, S7a–S7d tables included — is unchanged).
// A failure at any step removes the output: there is never a partial copy.
// To go further back (to the S7c build), run scripts/channelsRollback.mjs on THIS
// tool's output: that tool refuses a database carrying 0013.
//
// Usage: node scripts/safetyAuditRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0013,
//             10 a recorded 0013 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackSafetyAuditCopy } from '../repositories/safetyAuditRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/safetyAuditRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackSafetyAuditCopy(source, outDir);
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
  console.log(`${Object.entries(result.counts).map(([n, c]) => `${c} ${n}`).join(', ')} written back as the eight legacy blobs in their insertion order; nothing written after the cutover is lost`);
  console.log(`0013_safety_audit record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
