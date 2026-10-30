// S8d step-back: produce a copy of a database that the pre-S8d build (c0022be and earlier on this branch) can run.
// Kept ONLY as the first link of the existing rollback chain the backend gate proves until the merge (CLAUDE.md
// "Facts about the data": there is no production data; no new rollback tooling beyond this link). Works on a copy of
// the CURRENT file (server stopped): the source is opened read-only and copied (VACUUM INTO); the four blobs are
// written back from the typed tables in insertion order; idempotency_keys is recreated with the S8c owner CHECK; the
// ten tables, the 0018 record and its meta key go; the save revision advances; the copy is revalidated. A failure
// removes the output. To go further back, run scripts/recruitmentContactsOffersRollback.mjs on THIS tool's output.
//
// Usage: node scripts/signingsFollowUpsRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty, 4 a later schema step,
//             5 the copy never applied 0018, 10 a recorded 0018 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackSigningsFollowUpsCopy } from '../repositories/signingsFollowUpsRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/signingsFollowUpsRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackSigningsFollowUpsCopy(source, outDir);
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
  console.log(`${result.signingPackages} package(s), ${result.signings} signing(s), ${result.followUps} follow-up(s) and ${result.outcomeReports} report(s) written back into the four blobs; idempotency_keys recreated with the S8c owner CHECK (${result.rebuilt.idempotencyKeys} row(s))`);
  console.log(`0018_signings_follow_ups record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
