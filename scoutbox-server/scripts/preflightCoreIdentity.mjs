// Read-only S4a preflight: validate the guardians and players a snapshot holds
// against the intended live schema and relationships, and say whether a
// migration candidate could be built — without running any migration,
// writing the source, or starting a server (migration plan step S4; readiness
// review §5, §7.1). The source is either a data directory holding scoutbox.db
// (opened read-only and copied with VACUUM INTO to a temporary file that is
// deleted afterwards — the established snapshot/tooling contract of
// scripts/validateShadow.mjs; a read-only open of a WAL-mode file may make
// SQLite create empty -wal/-shm side files next to it, which hold nothing)
// or a JSON snapshot file ({ db: { players, guardians } } or { players,
// guardians }) such as a synthetic fixture.
//
// Usage: node scripts/preflightCoreIdentity.mjs <data-dir | snapshot.json> [--json] [--now <ms>]
//   --json   print the public report as JSON (ids, reasons and counts; never
//            the candidate rows, which carry hashes and e-mail codes)
//   --now    evaluation instant for adult/minor, integer milliseconds
//            (default: now); pass it to make two runs comparable
// Exit codes: 0 complete (the data fits; this is NOT an approval of the cutover),
//             1 usage error, 2 invalid (refusals listed), 3 blocked on a policy
//             decision (ids listed), 4 the source could not be read.
// Never prints an e-mail address, a code, a hash or a record.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from '../repositories/shadowValidate.mjs';
import { validateCoreIdentity, publicReport, CORE_IDENTITY_LIVE_MIGRATION, PREFLIGHT_STATUS } from '../repositories/identityPreflight.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const nowArg = args.includes('--now') ? args[args.indexOf('--now') + 1] : null;
const source = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--now');
if (!source) { console.error('usage: node scripts/preflightCoreIdentity.mjs <data-dir | snapshot.json> [--json] [--now <ms>]'); process.exit(1); }
const now = nowArg === null ? Date.now() : Number(nowArg);
if (!Number.isInteger(now) || now < 0) { console.error('--now must be an integer millisecond timestamp'); process.exit(1); }

/**
 * Read `players` and `guardians` from the source without changing it. A data
 * directory is copied read-only; the copy is opened read-only too and only the
 * blob rows and a few meta/migration facts are read. A JSON file is parsed.
 */
function readSource(src) {
  let stat;
  try { stat = fs.statSync(src); } catch (err) { return { error: `cannot read ${src} (${err?.code ?? err?.message ?? err})` }; }
  if (stat.isFile() && src.endsWith('.json')) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (err) { return { error: `${src} is not valid JSON (${err?.message ?? err})` }; }
    const db = parsed && typeof parsed === 'object' && parsed.db && typeof parsed.db === 'object' ? parsed.db : parsed;
    return { kind: 'json', db, facts: {} };
  }
  const file = stat.isDirectory() ? path.join(src, 'scoutbox.db') : src;
  if (!fs.existsSync(file)) return { error: `no scoutbox.db in ${src}` };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preflight-'));
  const copy = path.join(work, 'scoutbox.db');
  try {
    copyDatabaseReadOnly(file, copy);
    const ro = new DatabaseSync(copy, { readOnly: true });
    try {
      const has = (t) => !!ro.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
      const facts = { migrationsRecorded: [], alreadyCutOver: false, saveSeq: null, blobs: [] };
      if (has('data_migrations')) {
        facts.migrationsRecorded = ro.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id);
        facts.alreadyCutOver = facts.migrationsRecorded.includes(CORE_IDENTITY_LIVE_MIGRATION);
      }
      if (has('meta')) facts.saveSeq = Number(ro.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value ?? null) || null;
      const db = {};
      if (has('collections')) {
        for (const name of ['players', 'guardians']) {
          const row = ro.prepare('SELECT value FROM collections WHERE name = ?').get(name);
          if (!row) continue;
          facts.blobs.push(name);
          try { db[name] = JSON.parse(row.value); } catch { db[name] = Symbol('unparseable'); }
        }
      }
      return { kind: 'database', db, facts };
    } finally { ro.close(); }
  } catch (err) {
    return { error: `could not copy or read the database (${err?.message ?? err})` };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const read = readSource(source);
if (read.error) { console.error(read.error); process.exit(4); }
const report = publicReport(validateCoreIdentity(read.db, { now }));
if (read.facts.alreadyCutOver) {
  report.status = PREFLIGHT_STATUS.INVALID;
  report.refusals.unshift({ collection: 'snapshot', id: null, reason: `${CORE_IDENTITY_LIVE_MIGRATION} is already recorded in data_migrations: the blobs are not the source of truth of this file` });
  report.candidate = null;
}
const out = { source: { kind: read.kind, path: source, ...read.facts }, ...report };

if (json) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`S4a preflight of ${source} (${read.kind === 'database' ? 'worked on a read-only copy; the source was not opened for writing' : 'JSON snapshot file'})`);
  if (read.kind === 'database') console.log(`  migrations recorded: ${read.facts.migrationsRecorded.length ? read.facts.migrationsRecorded.join(', ') : 'none'}; blob collections read: ${read.facts.blobs.join(', ') || 'none'}; save revision ${read.facts.saveSeq ?? 'n/a'}`);
  console.log(`  status: ${out.status}   evaluated at ${new Date(out.evaluatedAt).toISOString()}`);
  const c = out.counts;
  console.log(`  players ${c.players} (valid ${c.validPlayers})  guardians ${c.guardians} (valid ${c.validGuardians})  links ${c.links} (primary ${c.primaryLinks}, co ${c.coLinks})  adults still linked ${c.adultsStillLinked}  co-guardian arrangements ${c.coGuardianArrangements}`);
  for (const r of out.refusals) console.log(`  refused ${r.collection}${r.id ? ` ${r.id}` : ''}: ${r.reason}`);
  for (const d of out.decisionsRequired) console.log(`  decision required ${d.id}: ${d.kind} (readiness review §5.5 — import unchanged and list, or refuse until resolved by hand; not chosen here)`);
  for (const f of out.findings) console.log(`  finding ${f.kind} ${f.id}: ${f.detail}`);
  console.log(`  candidate: ${out.candidate ? `${out.candidate.guardians} guardian row(s), ${out.candidate.players} player row(s), ${out.candidate.links} link row(s) — not written anywhere` : 'none'}`);
  console.log(`  ${out.authorises}`);
}
process.exit(out.status === PREFLIGHT_STATUS.COMPLETE ? 0 : out.status === PREFLIGHT_STATUS.INVALID ? 2 : 3);
