// The first two links of the copy-only rollback chain as one command, for the server suites that prove the chain on a
// file this build wrote: the S8d step-back (0018 → the four blobs) into a scratch copy, then the S8c tool
// (scripts/recruitmentContactsOffersRollback.mjs) on that copy into <out-dir>, with the S8c tool's own output and exit
// code. A file that does not carry 0018 goes straight to the S8c tool. Kept with the chain until the merge.
//
// Usage: node scripts/rollbackToPreS8c.mjs <data-dir> <out-dir> [--json]
// Exit codes: the S8c tool's (0 done, 1 usage, 4 later schema, 5 not cut over, 6 S8b key format, 10 unexpected schema);
//             before it, the S8d step's refusals map the same way (4 / 5 / 10 / 1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { rollbackSigningsFollowUpsCopy } from '../repositories/signingsFollowUpsRollback.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION } from '../repositories/signingsFollowUps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const passthrough = args.filter((a) => a.startsWith('--'));
const [dir, outDir] = args.filter((a) => !a.startsWith('--'));
if (!dir || !outDir) { console.error('usage: node scripts/rollbackToPreS8c.mjs <data-dir> <out-dir> [--json]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }
const carries = (() => { const s = new DatabaseSync(source, { readOnly: true }); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'data_migrations'").get() && !!s.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(SIGNINGS_FOLLOWUPS_MIGRATION); } finally { s.close(); } })();
let input = dir; let scratch = null;
if (carries) {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-s8d-to-s8c-'));
  try { rollbackSigningsFollowUpsCopy(source, scratch); } catch (err) {
    fs.rmSync(scratch, { recursive: true, force: true });
    const code = err?.code === 'LATER_SCHEMA' ? 4 : err?.code === 'NOT_CUT_OVER' ? 5 : err?.code === 'UNEXPECTED_SCHEMA' ? 10 : err?.code === 'OUTPUT_NOT_EMPTY' || err?.code === 'NO_SOURCE' ? 1 : null;
    if (code === null) throw err;
    console.error(`refused (S8d step): ${err.message}`); process.exit(code);
  }
  input = scratch;
}
try {
  execFileSync(process.execPath, [path.join(HERE, 'recruitmentContactsOffersRollback.mjs'), input, outDir, ...passthrough], { stdio: 'inherit' });
} catch (err) {
  process.exit(typeof err?.status === 'number' ? err.status : 1);
} finally {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
