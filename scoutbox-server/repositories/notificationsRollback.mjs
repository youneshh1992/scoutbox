/**
 * S7a rollback on a COPY (see scripts/notificationsRollback.mjs for the
 * operator contract; docs/architecture/s7-readiness-review.md §6–§7).
 * Exported separately so the behaviour is unit-tested without spawning the
 * CLI. The source file is NEVER modified: it is opened read-only and copied
 * with VACUUM INTO (whatever the WAL side file holds is in the copy), and
 * everything below happens on the copy, which is removed again if any step
 * fails — a refused or failed rollback leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the pre-S7a build
 * (`812e13b`, whose server code is that of the accepted S6a commit `2d7ddeb`)
 * reads —
 *   - the `notifications` blob: EVERY row of the table, in `seq` order (the
 *     feed order that build relies on), in the legacy shape — ids, clocks as
 *     refreshed, repeat counts, read flags, acknowledgment contracts, the
 *     unknown fields kept in extra_json — so nothing written after the cutover
 *     is lost and the feed reads identically there;
 *   - the `notificationPrefs` blob: every preference record exactly as stored,
 *     a mandatory category stored false included (that build forces it on in
 *     its effective view, as this one does);
 *   - the three tables dropped, the `0009_notifications` record and
 *     `meta.notificationsCutover` removed, `meta.saveSeq` advanced.
 * Nothing else is touched.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0009 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0009 whose
 * tables are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated
 * before it is reported: integrity, foreign keys, the tables and the record
 * gone, the two blobs present with exactly the counts the tables held, every
 * other table exactly that of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S6A_KNOWN_MIGRATIONS } from './oneTimeCodesRollback.mjs';
import { NOTIFICATIONS_MIGRATION, NOTIFICATIONS_CUTOVER_META, NOTIFICATION_TABLES, NOTIFICATIONS_TABLE, NOTIFICATION_PREFS_TABLE } from './notifications.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S6A_KNOWN_MIGRATIONS, NOTIFICATIONS_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'collections'];

export function rollbackNotificationsCopy(sourceFile, outDir, { now = Date.now() } = {}) {
  if (!fs.existsSync(sourceFile)) throw refusal('NO_SOURCE', `${sourceFile} does not exist`);
  fs.mkdirSync(outDir, { recursive: true });
  const leftovers = fs.readdirSync(outDir);
  if (leftovers.length) throw refusal('OUTPUT_NOT_EMPTY', `${outDir} is not empty (${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'}); the rollback needs a fresh, empty output directory and never overwrites anything`);
  const output = path.join(outDir, 'scoutbox.db');

  let sqlite = null;
  let done = false;
  try {
    copyDatabaseReadOnly(sourceFile, output);
    sqlite = new DatabaseSync(output);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const applied = hasTable('data_migrations') ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) throw refusal('LATER_SCHEMA', `the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
    if (!applied.includes(NOTIFICATIONS_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${NOTIFICATIONS_MIGRATION}; there is nothing to roll back`);
    const missing = NOTIFICATION_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${NOTIFICATIONS_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The two
    // blob rows this tool writes are excluded from the collections comparison.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare("SELECT name, value FROM collections WHERE name NOT IN ('notifications', 'notificationPrefs') ORDER BY name").all())
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));

    // 1. What that build reads: every row, in insertion order, in the legacy shape.
    const notifications = NOTIFICATIONS_TABLE.read(sqlite);
    const prefs = NOTIFICATION_PREFS_TABLE.read(sqlite);
    const counts = { notifications: notifications.length, notificationPrefs: prefs.length };

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      const put = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      put.run('notifications', JSON.stringify(notifications));
      put.run('notificationPrefs', JSON.stringify(prefs));
      // 2. The tables (children first) and the bookkeeping go.
      for (const t of [...NOTIFICATION_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(NOTIFICATIONS_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(NOTIFICATIONS_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    }
    sqlite.exec('VACUUM');

    // 3. Revalidate the completed copy before reporting it.
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(NOTIFICATIONS_MIGRATION)) problems.push('the 0009 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(NOTIFICATIONS_CUTOVER_META)) problems.push('the S7a meta key is still present');
    for (const t of NOTIFICATION_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    for (const [name, expected] of [['notifications', counts.notifications], ['notificationPrefs', counts.notificationPrefs]]) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
      let n = null; try { n = JSON.parse(v).length; } catch { /* reported below */ }
      if (n !== expected) problems.push(`the ${name} blob holds ${n === null ? 'nothing readable' : `${n} entries`}, not the ${expected} the table held`);
    }
    for (const t of UNTOUCHED) {
      const after = hasTable(t) ? snapshotOf(t) : null;
      if (after !== before[t]) problems.push(`the ${t} table changed`);
    }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, counts, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
