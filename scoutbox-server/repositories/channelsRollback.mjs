/**
 * S7d rollback on a COPY (see scripts/channelsRollback.mjs for the operator
 * contract; docs/architecture/s7-readiness-review.md §11.5). Exported separately
 * so the behaviour is unit-tested without spawning the CLI. The source file is
 * NEVER modified: it is opened read-only and copied with VACUUM INTO (whatever
 * the WAL side file holds is in the copy), and everything below happens on the
 * copy, which is removed again if any step fails — a refused or failed rollback
 * leaves no usable partial output.
 *
 * What it reconstructs: the storage representation the pre-S7d build (the
 * commit `b67bce5`, whose source under test is byte-identical to the accepted
 * `9119187`) reads — the `channels` blob with EVERY thread of the `channels`
 * table in `seq` order, each in the openChannel literal (its optional keys present
 * or absent exactly as recorded), its messages nested in `position` order in the
 * postMessage literal (`clientMsgId` present only when stored, the attachment in
 * its clip or trial-report shape), the receipts, and every legacy or unknown field
 * spread first at its own level — so nothing written after the cutover is lost and
 * the acceptance routes, postMessage, the receipt routes, the readers, the export
 * and the admin audit read identically there; the three tables dropped, the
 * `0012_channels` record and `meta.channelsCutover` removed, `meta.saveSeq`
 * advanced. Nothing else is touched: the S7a, S7b and S7c tables included.
 *
 * Refusals (no output): a copy carrying a schema step this tool does not know
 * (`LATER_SCHEMA`), a copy that never applied 0012 (`NOT_CUT_OVER`), an output
 * directory that is not empty (`OUTPUT_NOT_EMPTY`), a recorded 0012 whose tables
 * are missing (`UNEXPECTED_SCHEMA`). The completed copy is revalidated before it
 * is reported: integrity, foreign keys, the tables and the record gone, the blob
 * present with exactly the thread count the table held, every other table exactly
 * that of the source. Logs and results carry counts only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S7C_KNOWN_MIGRATIONS } from './outboxPushRollback.mjs';
import { CHANNELS_MIGRATION, CHANNELS_CUTOVER_META, CHANNELS_TABLES, CHANNELS_TABLE, CHANNELS_COLLECTION } from './channels.mjs';

/** The schema steps this tool understands; any other recorded id is a later step it must not touch. */
export const KNOWN_MIGRATIONS = Object.freeze([...S7C_KNOWN_MIGRATIONS, CHANNELS_MIGRATION]);

const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['sessions', 'players', 'guardians', 'guardian_children', 'orgs', 'org_users', 'media_deletions', 'email_challenges', 'pairing_codes', 'notifications', 'notification_prefs', 'notification_pref_categories', 'dispatches', 'dispatch_attempts', 'outbox', 'push_log', 'push_tokens', 'collections'];

export function rollbackChannelsCopy(sourceFile, outDir, { now = Date.now(), _failBeforeCommit = false } = {}) {
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
    if (!applied.includes(CHANNELS_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${CHANNELS_MIGRATION}; there is nothing to roll back`);
    const missing = CHANNELS_TABLES.filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${CHANNELS_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    // Every other table, as it is: compared again after the rewrite. (The blob
    // row this tool writes is excluded from the collections comparison.)
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare('SELECT name, value FROM collections WHERE name <> ? ORDER BY name').all(CHANNELS_COLLECTION))
      : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));

    // 1. What that build reads: every thread in insertion order, its messages in array order, in the writers' literals.
    const threads = CHANNELS_TABLE.read(sqlite);
    const counts = { channels: threads.length, messages: threads.reduce((n, c) => n + c.messages.length, 0) };

    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved;
    try {
      sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(CHANNELS_COLLECTION, JSON.stringify(threads));
      // 2. The tables (children first) and the bookkeeping go.
      for (const t of [...CHANNELS_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(CHANNELS_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(CHANNELS_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      if (_failBeforeCommit) throw new Error('synthetic commit failure (test seam)');
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
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(CHANNELS_MIGRATION)) problems.push('the 0012 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(CHANNELS_CUTOVER_META)) problems.push('the S7d meta key is still present');
    for (const t of CHANNELS_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(CHANNELS_COLLECTION)?.value;
      let count = null; let messages = null; try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) { count = parsed.length; messages = parsed.reduce((n, c) => n + (Array.isArray(c?.messages) ? c.messages.length : 0), 0); } } catch { /* reported below */ }
      if (count !== counts.channels) problems.push(`the channels blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${counts.channels} the table held`);
      if (messages !== counts.messages) problems.push(`the channels blob nests ${messages ?? 'no readable'} messages, not the ${counts.messages} the messages table held`);
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
