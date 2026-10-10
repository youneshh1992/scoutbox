/**
 * Isolated shadow validation (plan step S1): run the core identity projection
 * against a COPY of a ScoutBox database file and report, without touching the
 * source. Used by scripts/validateShadow.mjs and by tests.
 *
 * The source is opened read-only and copied with VACUUM INTO, so a backup or a
 * running data directory is never modified. Every initialisation below happens
 * on the disposable copy only:
 *   - the table migrations the copy lacks are applied to it (an older backup
 *     may predate migration 0002, or 0001);
 *   - a copy from before the save-revision field existed (no `meta.saveSeq`,
 *     saved by a build before the second S1 correction) gets revision 0 written
 *     into ITS meta table, so the projection can be tied to the copy's current
 *     content and the report can call it current. The running server never
 *     does this: a live file without a revision keeps reporting `stale` until
 *     its next save writes one, which is the correct answer there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { runDataMigrations, transaction } from './database.mjs';
import { createCoreIdentityShadow } from './shadow.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from './index.mjs';

/** Open `sourceFile` read-only and write a consistent copy to `targetFile`. */
export function copyDatabaseReadOnly(sourceFile, targetFile) {
  const ro = new DatabaseSync(sourceFile, { readOnly: true });
  try { ro.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`); } finally { ro.close(); }
}

export function validateCopy(sourceFile, { sessionTtlMs = 30 * 24 * 3600 * 1000 } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-validate-'));
  const copy = path.join(work, 'scoutbox.db');
  copyDatabaseReadOnly(sourceFile, copy);

  const store = openStore(work, { tableBacked: TABLE_BACKED });
  const migrations = runDataMigrations(store.sqlite, DATA_MIGRATIONS);
  const snapshot = store.load() ?? { db: {}, savedAt: null, saveSeq: 0 };
  // Legacy copy without a save revision: give the COPY one, so "current" is
  // decidable. `store.load()` already reports 0 for a missing revision; the
  // meta row is what report() reads, so it has to exist on the copy too.
  let legacyRevisionInitialised = false;
  if (!store.sqlite.prepare("SELECT 1 FROM meta WHERE key = 'saveSeq'").get()) {
    store.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', '0')").run();
    legacyRevisionInitialised = true;
  }
  const shadow = createCoreIdentityShadow({ sqlite: store.sqlite, sessionTtlMs });
  let error = null;
  const t0 = process.hrtime.bigint();
  try {
    // Projected against the copy's own save revision, so the report on the
    // copy is "current" by construction and reflects exactly this snapshot.
    transaction(store.sqlite, () => shadow.project(snapshot.db, { savedAt: snapshot.savedAt, saveSeq: snapshot.saveSeq }));
  } catch (err) {
    error = String(err?.message ?? err);
  }
  const projectionMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const report = shadow.report(snapshot.db, { enabled: false, details: true });
  store.sqlite.close();
  return { work, copy, migrationsRan: migrations.ran, legacyRevisionInitialised, projectionMs, error, report };
}
