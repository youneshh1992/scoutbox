// S8b rollback: produce a copy of a database that the pre-S8b build (the accepted commit 7a7efc6, whose server source
// the S8b design commits left byte-identical) can run.
//
// Booting that build directly on a live file that carries 0016 is no rollback: it skips the record it does not know
// and finds none of the five blobs (the rows are invisible to it) — measured on the actual build by
// scripts/testRecruitmentCasesServer.mjs: INTEGRITY STORE_MISSING for recruitmentCases, roomComments, roomDecisions,
// roomEvidenceState, roomSnapshots; nothing served from the tables. Restoring a pre-S8b backup is not a rollback
// either: it discards every write since the backup. This tool works on a copy of the CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so whatever the WAL side file holds is in
//      the copy) to <out-dir>/scoutbox.db — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not know (a later schema step needs its own
//      rollback; no partial downgrade) and a copy that never applied 0016_recruitment_cases;
//   3. writes every case, comment, snapshot, decision and evidence state back into the five blobs in insertion order,
//      each in its writer's literal with the room facet, assignments, tasks, approvals, history, links, decision
//      draft, transaction handoff, budget, mentions, source references, reason codes, evidence refs and keys nested in
//      list order and every absent, null, off-type and unknown field as recorded — so nothing written since the
//      cutover is lost;
//   4. recreates recruitment_requests and trials in their S8a definitions (no case key: that build never had one) with
//      every row copied back, and idempotency_keys with the S8a owner CHECK (the S8b owners' key rows live in the
//      blobs' `keys` now);
//   5. drops the twenty-five case and room tables, removes the 0016 record and its meta key, advances the save
//      revision, checks every foreign key, VACUUMs and revalidates the copy (the five blobs holding exactly the counts
//      the tables held, the two parents and the S8a key rows row for row, every other table exactly as in the source).
// A failure at any step removes the output. To go further back (to the pre-S8a build), run
// scripts/recruitmentRollback.mjs on THIS tool's output: that tool refuses a database carrying 0016.
//
// Usage: node scripts/recruitmentCasesRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0016,
//             10 a recorded 0016 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackRecruitmentCasesCopy } from '../repositories/recruitmentCasesRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/recruitmentCasesRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackRecruitmentCasesCopy(source, outDir);
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
  console.log(`${result.recruitmentCases} case(s), ${result.roomComments} comment(s), ${result.roomSnapshots} snapshot(s), ${result.roomDecisions} decision(s) and ${result.roomEvidenceState} evidence state(s) written back into the five legacy blobs; recruitment_requests (${result.rebuilt.requests} row(s)) and trials (${result.rebuilt.trials} row(s)) recreated without the case key; idempotency_keys recreated with the S8a owner CHECK (${result.rebuilt.idempotencyKeys} S8a key row(s)); nothing written since the cutover is lost`);
  console.log(`0016_recruitment_cases record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
