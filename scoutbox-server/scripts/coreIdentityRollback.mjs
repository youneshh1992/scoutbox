// S4a rollback: produce a copy of a database that the PRE-S4 build can run.
//
// Restoring a pre-S4 backup is NOT a rollback: it discards every write made
// since the backup (players, guardians, cases, organisations, …) and brings
// back every session that existed then, revoked ones included. This tool
// instead works on a copy of the CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO, so
//      whatever the WAL side file holds is in the copy) to <out-dir>/scoutbox.db
//      — the source is never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not
//      know (a later schema step needs its own rollback; no partial downgrade)
//      and a copy that never applied 0005_core_identity_live;
//   3. writes every player and guardian back into the two blobs exactly as the
//      live tables render them (columns and facets merged, original shape,
//      childIds from the link rows in their order, the outstanding e-mail code
//      as stored — it is not hashed by S4a, so it still verifies on the pre-S4
//      build), post-S4 inserts, updates and removals included; restores the S1
//      shadow definitions of the three tables (empty); leaves sessions, staff,
//      organisations and every other collection exactly as they are — nobody
//      signs in again;
//   4. removes the 0005 record and the two S4 meta keys, advances the save
//      revision, checks every foreign key, VACUUMs and revalidates the copy.
// A failure at any step removes the output: there is never a partial copy.
//
// Usage: node scripts/coreIdentityRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never cut over.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackCoreIdentityCopy } from '../repositories/coreIdentityRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/coreIdentityRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackCoreIdentityCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  if (err?.code === 'NOT_CUT_OVER') { console.error(`refused: ${err.message}`); process.exit(5); }
  if (err?.code === 'OUTPUT_NOT_EMPTY' || err?.code === 'NO_SOURCE') { console.error(`refused: ${err.message}`); process.exit(1); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`  players written back to the blob: ${result.players}; guardians: ${result.guardians} (from ${result.links} link row(s)); sessions kept as they are: ${result.sessions}; save revision now ${result.saveSeq}`);
  console.log(`  cutover record removed: ${result.recordRemoved ? 'yes' : 'no (was absent)'}; start the pre-S4 build on the output directory`);
}
