// S3 rollback: produce a copy of a database that the PRE-S3 build (S2) can run.
//
// Restoring a pre-S3 backup is NOT a rollback: it discards every write made
// since the backup (organisations, staff, players, cases, …) and brings back
// every session that existed then, revoked ones included. This tool instead
// works on a copy of the CURRENT file:
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO) to
//      <out-dir>/scoutbox.db — the source is never modified;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0004_orgs_live;
//   3. writes every organisation back into the `orgs` blob exactly as the S3
//      table renders it (scalars and facets merged, original shape), restores
//      the S1 shadow definition of `orgs` (empty) and the migration-0001
//      definition of `org_users` (no organisation foreign key, not STRICT) with
//      every staff row carried over; `sessions` is left exactly as it is —
//      no session is revived or revoked, nobody has to sign in again;
//   4. removes the `0004_orgs_live` record and `meta.orgsCutover`, advances the
//      save revision, checks every foreign key and VACUUMs the copy.
// Organisation changes made on the S3 build are KEPT (they are in the blob the
// S2 build reads). The S2 build's shadow projection, if switched on, rebuilds
// the empty shadow `orgs` from that blob as it always did.
//
// Usage: node scripts/orgsRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error, 4 the copy carries a later schema step, 5 the copy never cut over.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackOrgsCopy } from '../repositories/orgsRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/orgsRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(path.join(outDir, 'scoutbox.db'))) { console.error(`${outDir} already holds a scoutbox.db; use an empty directory`); process.exit(1); }

let result;
try {
  result = rollbackOrgsCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  if (err?.code === 'NOT_CUT_OVER') { console.error(`refused: ${err.message}`); process.exit(5); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`  organisations written back to the blob: ${result.organisations}; staff rows carried over: ${result.staff}; sessions kept as they are: ${result.sessions}`);
  console.log(`  cutover record removed: ${result.recordRemoved ? 'yes' : 'no (was absent)'}; start the pre-S3 build on the output directory`);
}
