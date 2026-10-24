/**
 * S7c rollback on a COPY (see scripts/outboxPushRollback.mjs for the operator
 * contract; docs/architecture/s7-readiness-review.md §10.5). Exported separately
 * so the behaviour is unit-tested without spawning the CLI. The source file is
 * NEVER modified: it is opened read-only and copied with VACUUM INTO (whatever
 * the WAL side file holds is in the copy), and everything below happens on the
 * copy, which is removed again if any step fails — a refused or failed rollback
 * leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the pre-S7c build (the
 * accepted commit `6ca66ba`, which carries the notification nested-extras
 * correction) reads — the `outbox`, `pushLog` and `pushTokens` blobs with
 * EVERY row of the three tables in `seq` order, each in the literal the writer
 * wrote (the mailer record or the delivery record with exactly its keys, a null
 * destination kept as present-and-null, a non-string destination decoded from
 * to_json back to its value — review of 40aa05c, F2; a copy created by the
 * unaccepted 40aa05c build, whose outbox has no to_json column, is read too, so
 * such a scratch database can be taken back and re-upgraded); the sender record; the registration
 * record with its token decoded to the value and type it was registered with)
 * and unknown fields spread first — so nothing written after the cutover is
 * lost and the mailer, the sweep, the sender, the registration route and the
 * admin views read identically there; the three tables dropped, the
 * `0011_outbox_push` record and `meta.outboxPushCutover` removed, `meta.saveSeq`
 * advanced. Nothing else is touched: the S7a and S7b tables included.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0011 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0011 whose
 * tables are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated
 * before it is reported: integrity, foreign keys, the tables and the record
 * gone, each blob present with exactly the count its table held, every other
 * table exactly that of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S7B_KNOWN_MIGRATIONS } from './dispatchesRollback.mjs';
import { OUTBOX_PUSH_MIGRATION, OUTBOX_PUSH_CUTOVER_META, OUTBOX_PUSH_TABLES, OUTBOX_PUSH_SNAPSHOT_TABLES } from './outboxPush.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S7B_KNOWN_MIGRATIONS, OUTBOX_PUSH_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'collections'];
const BLOBS = OUTBOX_PUSH_SNAPSHOT_TABLES.map((t) => t.name); // outbox, pushLog, pushTokens

export function rollbackOutboxPushCopy(sourceFile, outDir, { now = Date.now() } = {}) {
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
    if (!applied.includes(OUTBOX_PUSH_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${OUTBOX_PUSH_MIGRATION}; there is nothing to roll back`);
    const missing = OUTBOX_PUSH_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${OUTBOX_PUSH_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The blob
    // rows this tool writes are excluded from the collections comparison.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare("SELECT name, value FROM collections WHERE name NOT IN ('outbox', 'pushLog', 'pushTokens') ORDER BY name").all())
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));

    // 1. What that build reads: every row, in insertion order, in the writer's literal.
    const blobs = Object.fromEntries(OUTBOX_PUSH_SNAPSHOT_TABLES.map((t) => [t.name, t.read(sqlite)]));
    const counts = Object.fromEntries(BLOBS.map((n) => [n, blobs[n].length]));

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      const upsert = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      for (const n of BLOBS) upsert.run(n, JSON.stringify(blobs[n]));
      // 2. The tables and the bookkeeping go.
      for (const t of OUTBOX_PUSH_TABLES) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(OUTBOX_PUSH_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(OUTBOX_PUSH_CUTOVER_META);
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(OUTBOX_PUSH_MIGRATION)) problems.push('the 0011 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(OUTBOX_PUSH_CUTOVER_META)) problems.push('the S7c meta key is still present');
    for (const t of OUTBOX_PUSH_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    for (const n of BLOBS) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value;
      let count = null; try { const parsed = JSON.parse(v); count = Array.isArray(parsed) ? parsed.length : null; } catch { /* reported below */ }
      if (count !== counts[n]) problems.push(`the ${n} blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${counts[n]} the table held`);
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
