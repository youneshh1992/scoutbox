// Isolated shadow validation (migration plan step S1).
//
// Runs the core identity projection against a COPY of a ScoutBox database
// file and prints the reconciliation report with row-level detail. The source
// file is opened read-only and copied with VACUUM INTO, so nothing here
// modifies, reseeds or migrates the database it is pointed at; the copy is
// deleted afterwards. Older backups are supported: table migrations the copy
// lacks, and the save-revision field introduced by the second S1 correction,
// are initialised on the copy only (repositories/shadowValidate.mjs).
//
// Usage: node scripts/validateShadow.mjs <data-dir> [--strict] [--json] [--keep]
//   <data-dir>  a directory holding scoutbox.db (a DATA_DIR or a backup)
//   --strict    migration-readiness gate: exit 3 unless the result is
//               `complete` (no refused row, no adjusted relationship, every
//               snapshot row in the tables). Use this before a cutover.
//   --json      print the full report as JSON instead of the summary
//   --keep      leave the working copy in place and print its path
// Exit codes: 0 the projection ran (informational mode: complete OR partial),
//             1 usage error, 2 the projection itself failed,
//             3 strict mode and the result is not complete.
import fs from 'node:fs';
import path from 'node:path';
import { validateCopy } from '../repositories/shadowValidate.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const keep = args.includes('--keep');
const strict = args.includes('--strict');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: node scripts/validateShadow.mjs <data-dir> [--strict] [--json] [--keep]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }

const out = validateCopy(source);
if (json) {
  console.log(JSON.stringify({ source, ...out, work: keep ? out.work : undefined, copy: keep ? out.copy : undefined }, null, 2));
} else {
  console.log(`shadow validation of ${source} (worked on a copy; the source was opened read-only)`);
  if (out.migrationsRan.length) console.log(`  table migrations applied to the copy: ${out.migrationsRan.join(', ')}`);
  if (out.legacyRevisionInitialised) console.log('  legacy backup: the copy had no save revision; one was initialised on the copy only');
  console.log(`  status: ${out.report.status}${out.error ? ` — ${out.error}` : ''}   refused ${out.report.skipped ?? 0}, adjusted ${out.report.findings ?? 0}   projection ${out.projectionMs.toFixed(1)} ms`);
  for (const [t, r] of Object.entries(out.report.tables)) {
    const line = `  ${t.padEnd(18)} snapshot ${String(r.projectedRows ?? r.snapshotRows).padStart(6)}  table ${String(r.tableRows).padStart(6)}  skipped ${String(r.skipped ?? 0).padStart(5)}  findings ${String(r.findings ?? 0).padStart(5)}  ${r.accountedFor === false ? 'NOT ACCOUNTED FOR' : ''}`;
    console.log(line);
    for (const s of r.details?.skipped ?? []) console.log(`      refused ${s.id ?? '(no id)'}: ${s.reason}`);
    for (const f of r.details?.findings ?? []) console.log(`      adjusted ${f.id}: ${f.finding}`);
  }
  if (keep) console.log(`  working copy kept at ${out.copy}`);
}
if (!keep) fs.rmSync(out.work, { recursive: true, force: true });
if (out.error) process.exit(2);
if (strict && out.report.status !== 'complete') {
  console.error(`strict: migration readiness FAILED — status ${out.report.status} (refused ${out.report.skipped ?? 0}, adjusted ${out.report.findings ?? 0})`);
  process.exit(3);
}
process.exit(0);
