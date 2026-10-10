// Isolated shadow validation (migration plan step S1).
//
// Runs the core identity projection against a COPY of a ScoutBox database
// file and prints the reconciliation report with row-level detail. The source
// file is opened read-only and copied with VACUUM INTO, so nothing here
// modifies, reseeds or migrates the database it is pointed at; the copy is
// deleted afterwards.
//
// Usage: node scripts/validateShadow.mjs <data-dir> [--json] [--keep]
//   <data-dir>  a directory holding scoutbox.db (a DATA_DIR or a backup)
//   --json      print the full report as JSON instead of the summary
//   --keep      leave the working copy in place and print its path
// Exit code: 0 when the projection ran (status complete or partial), 2 when
// the projection itself failed, 1 on a usage error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { runDataMigrations, transaction } from '../repositories/database.mjs';
import { createCoreIdentityShadow } from '../repositories/shadow.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const keep = args.includes('--keep');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) { console.error('usage: node scripts/validateShadow.mjs <data-dir> [--json] [--keep]'); process.exit(1); }
const source = path.join(dir, 'scoutbox.db');
if (!fs.existsSync(source)) { console.error(`no scoutbox.db in ${dir}`); process.exit(1); }

export function validateCopy(sourceFile, { sessionTtlMs = 30 * 24 * 3600 * 1000 } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-validate-'));
  const copy = path.join(work, 'scoutbox.db');
  // Read-only open + VACUUM INTO: a consistent copy, no write to the source.
  const ro = new DatabaseSync(sourceFile, { readOnly: true });
  try { ro.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); } finally { ro.close(); }

  const store = openStore(work, { tableBacked: TABLE_BACKED });
  const migrations = runDataMigrations(store.sqlite, DATA_MIGRATIONS);
  const snapshot = store.load() ?? { db: {}, savedAt: null };
  const shadow = createCoreIdentityShadow({ sqlite: store.sqlite, sessionTtlMs });
  let error = null;
  const t0 = process.hrtime.bigint();
  try {
    transaction(store.sqlite, () => shadow.project(snapshot.db, { savedAt: snapshot.savedAt }));
  } catch (err) {
    error = String(err?.message ?? err);
  }
  const projectionMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const report = shadow.report(snapshot.db, { enabled: false, details: true });
  store.sqlite.close();
  return { work, copy, migrationsRan: migrations.ran, projectionMs, error, report };
}

const out = validateCopy(source);
if (json) {
  console.log(JSON.stringify({ source, ...out, work: keep ? out.work : undefined, copy: keep ? out.copy : undefined }, null, 2));
} else {
  console.log(`shadow validation of ${source} (worked on a copy; the source was opened read-only)`);
  if (out.migrationsRan.length) console.log(`  table migrations applied to the copy: ${out.migrationsRan.join(', ')}`);
  console.log(`  status: ${out.report.status}${out.error ? ` — ${out.error}` : ''}   projection ${out.projectionMs.toFixed(1)} ms`);
  for (const [t, r] of Object.entries(out.report.tables)) {
    const line = `  ${t.padEnd(18)} snapshot ${String(r.projectedRows ?? r.snapshotRows).padStart(6)}  table ${String(r.tableRows).padStart(6)}  skipped ${String(r.skipped ?? 0).padStart(5)}  findings ${String(r.findings ?? 0).padStart(5)}  ${r.accountedFor === false ? 'NOT ACCOUNTED FOR' : ''}`;
    console.log(line);
    for (const s of r.details?.skipped ?? []) console.log(`      refused ${s.id ?? '(no id)'}: ${s.reason}`);
    for (const f of r.details?.findings ?? []) console.log(`      adjusted ${f.id}: ${f.finding}`);
  }
  if (keep) console.log(`  working copy kept at ${out.copy}`);
}
if (!keep) fs.rmSync(out.work, { recursive: true, force: true });
process.exit(out.error ? 2 : 0);
