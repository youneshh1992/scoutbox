// S8c rollback: produce a copy of a database that the pre-S8c build (the accepted commit 7072dd9, whose server source
// the S8c design commits left byte-identical) can run.
//
// Booting that build directly on a live file that carries 0017 is no rollback: it skips the record it does not know,
// finds no recruitmentContacts and no recruitmentOffers blob and re-creates both as EMPTY arrays (its migration
// registry and its offer module do that by themselves) — measured on the actual build by
// scripts/testRecruitmentContactsOffersServer.mjs (the result is recorded there and in OPERATIONS.md). Restoring a
// pre-S8c backup is not a rollback either: it discards every write since the backup. This tool works on a copy of the
// CURRENT file (server stopped):
//   1. opens <data-dir>/scoutbox.db read-only and copies it (VACUUM INTO) to <out-dir>/scoutbox.db — the source is
//      never modified; <out-dir> must be empty;
//   2. refuses a copy whose data_migrations holds any id this tool does not know (a later schema step needs its own
//      rollback; no partial downgrade), a copy that never applied 0017_recruitment_contacts_offers, and a copy whose
//      S8b key format is not the one this build reads (nothing is decoded);
//   3. writes every contact and offer back into the two blobs in insertion order, each in its writer's literal with
//      attempts, history, revisions, documents, responses, receipts and keys nested in list order and every absent,
//      null, off-type, unknown field and every pointer as recorded — so nothing written since the cutover is lost;
//   4. recreates idempotency_keys with the S8b owner CHECK (the S8c owners' key rows live in the blobs' `keys` now;
//      every S8a and S8b row kept byte for byte; the S8b key-format marker untouched);
//   5. drops the nine tables, removes the 0017 record and its meta key, advances the save revision, checks every
//      foreign key, VACUUMs and revalidates the copy.
// A failure at any step removes the output. To go further back, run scripts/recruitmentCasesRollback.mjs on THIS
// tool's output (that tool refuses a database carrying 0017), then scripts/recruitmentRollback.mjs on its output.
//
// Usage: node scripts/recruitmentContactsOffersRollback.mjs <data-dir> <out-dir> [--json]
// Exit codes: 0 done, 1 usage error / no source / output directory not empty,
//             4 the copy carries a later schema step, 5 the copy never applied 0017,
//             6 the copy's S8b key format is not the one this tool reads, 10 a recorded 0017 whose tables are missing.
import fs from 'node:fs';
import path from 'node:path';
import { rollbackRecruitmentContactsOffersCopy } from '../repositories/recruitmentContactsOffersRollback.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/recruitmentContactsOffersRollback.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) { console.error(`${outDir} is not empty; use a fresh, empty directory (nothing is overwritten)`); process.exit(1); }

let result;
try {
  result = rollbackRecruitmentContactsOffersCopy(source, outDir);
} catch (err) {
  if (err?.code === 'LATER_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(4); }
  if (err?.code === 'NOT_CUT_OVER') { console.error(`refused: ${err.message}`); process.exit(5); }
  if (err?.code === 'FORMAT_UNSUPPORTED') { console.error(`refused: ${err.message}`); process.exit(6); }
  if (err?.code === 'UNEXPECTED_SCHEMA') { console.error(`refused: ${err.message}`); process.exit(10); }
  if (err?.code === 'OUTPUT_NOT_EMPTY' || err?.code === 'NO_SOURCE') { console.error(`refused: ${err.message}`); process.exit(1); }
  throw err;
}
if (json) console.log(JSON.stringify({ source, ...result }, null, 2));
else {
  console.log(`rollback copy written to ${result.output} (source opened read-only, not modified)`);
  console.log(`${result.recruitmentContacts} contact(s) and ${result.recruitmentOffers} offer(s) written back into the two legacy blobs; idempotency_keys recreated with the S8b owner CHECK (${result.rebuilt.idempotencyKeys} S8a/S8b key row(s)); nothing written since the cutover is lost`);
  console.log(`0017_recruitment_contacts_offers record removed: ${result.recordRemoved}; save revision now ${result.saveSeq}`);
}
