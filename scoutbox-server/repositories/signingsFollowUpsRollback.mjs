/**
 * S8d step-back on a COPY — the predecessor link of the rollback chain, kept ONLY so the existing chain (the S8c tool and
 * the ones below it, booted for real by the backend gate until this branch is merged — CLAUDE.md "Facts about the
 * data") can still be proven on a file this build wrote. It is a test-chain tool, not an operator procedure: there is
 * no production data, and the rule of 30 October adds no rollback tooling beyond this link. It goes with the chain at
 * the merge.
 *
 * What it reconstructs: the four blobs the pre-S8d build (`c0022be` and earlier on this branch) reads —
 * `signingPackages`, `signings`, `followUps`, `outcomeReports` — each record decoded from the typed tables into the
 * writers' shapes in insertion order (the typed normalisations of the cutover stay: a legacy signing carries its
 * `method`, the copied ledger row is its reference); `idempotency_keys` recreated with the S8c owner CHECK, the
 * `signing_packages` key rows removed (they live in the packages' `keys` now) and every S8a/S8b/S8c row kept byte for
 * byte; the ten tables dropped; the `0018_signings_follow_ups` record and `meta.signingsFollowUpsCutover` removed;
 * `meta.saveSeq` advanced. Nothing else is touched. Refusals as the S8c tool's: `LATER_SCHEMA`, `NOT_CUT_OVER`,
 * `UNEXPECTED_SCHEMA`, `OUTPUT_NOT_EMPTY`, `NO_SOURCE`. The source is opened read-only and copied with VACUUM INTO; a
 * failed step removes the output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyDatabaseReadOnly } from './database.mjs';
import { KNOWN_MIGRATIONS as S8C_KNOWN_MIGRATIONS } from './recruitmentContactsOffersRollback.mjs';
import { idempotencyKeysDdl } from './recruitment.mjs';
import { S8C_KEY_OWNERS } from './recruitmentContactsOffers.mjs';
import { SIGNINGS_FOLLOWUPS_MIGRATION, SIGNINGS_FOLLOWUPS_CUTOVER_META, SIGNINGS_FOLLOWUPS_COLLECTIONS, SIGNINGS_FOLLOWUPS_TABLES, SIGNINGS_FOLLOWUPS_SNAPSHOT } from './signingsFollowUps.mjs';
import { rebuildTable } from './migrations/0016_recruitment_cases.mjs';

export const KNOWN_MIGRATIONS = Object.freeze([...S8C_KNOWN_MIGRATIONS, SIGNINGS_FOLLOWUPS_MIGRATION]);
const refusal = (code, message) => Object.assign(new Error(message), { code });
const UNTOUCHED = ['collections', 'data_migrations', 'recruitment_contacts', 'recruitment_offers', 'offer_revisions', 'recruitment_cases', 'recruitment_requests', 'trials', 'channels', 'players', 'guardians', 'orgs', 'org_users'];

export function rollbackSigningsFollowUpsCopy(sourceFile, outDir, { _failBeforeCommit = false } = {}) {
  if (!fs.existsSync(sourceFile)) throw refusal('NO_SOURCE', `${sourceFile} does not exist`);
  fs.mkdirSync(outDir, { recursive: true });
  const leftovers = fs.readdirSync(outDir);
  if (leftovers.length) throw refusal('OUTPUT_NOT_EMPTY', `${outDir} is not empty (${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'}); the rollback needs a fresh, empty output directory and never overwrites anything`);
  const output = path.join(outDir, 'scoutbox.db');
  let sqlite = null; let done = false;
  try {
    copyDatabaseReadOnly(sourceFile, output);
    sqlite = new DatabaseSync(output);
    sqlite.exec('PRAGMA foreign_keys = ON;');
    const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const applied = hasTable('data_migrations') ? sqlite.prepare('SELECT id FROM data_migrations ORDER BY id').all().map((r) => r.id) : [];
    const later = applied.filter((id) => !KNOWN_MIGRATIONS.includes(id));
    if (later.length) throw refusal('LATER_SCHEMA', `the database carries schema step(s) this tool does not know (${later.join(', ')}); a partial downgrade is not attempted`);
    if (!applied.includes(SIGNINGS_FOLLOWUPS_MIGRATION)) throw refusal('NOT_CUT_OVER', `the database has not applied ${SIGNINGS_FOLLOWUPS_MIGRATION}; there is nothing to roll back`);
    const missing = [...SIGNINGS_FOLLOWUPS_TABLES, 'idempotency_keys'].filter((t) => !hasTable(t));
    if (missing.length) throw refusal('UNEXPECTED_SCHEMA', `${SIGNINGS_FOLLOWUPS_MIGRATION} is recorded but ${missing.join(', ')} do not exist; refusing to guess`);
    const snapshotOf = (t) => (t === 'collections'
      ? JSON.stringify(sqlite.prepare(`SELECT name, value FROM collections WHERE name NOT IN (${SIGNINGS_FOLLOWUPS_COLLECTIONS.map(() => '?').join(', ')}) ORDER BY name`).all(...SIGNINGS_FOLLOWUPS_COLLECTIONS))
      : t === 'data_migrations' ? JSON.stringify(sqlite.prepare('SELECT * FROM data_migrations WHERE id <> ? ORDER BY id').all(SIGNINGS_FOLLOWUPS_MIGRATION))
        : JSON.stringify(sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const before = Object.fromEntries(UNTOUCHED.map((t) => [t, hasTable(t) ? snapshotOf(t) : null]));
    const keysBefore = JSON.stringify(sqlite.prepare(`SELECT * FROM idempotency_keys WHERE owner_table IN (${S8C_KEY_OWNERS.map(() => '?').join(', ')}) ORDER BY owner_table, owner_id, position`).all(...S8C_KEY_OWNERS));
    const collections = SIGNINGS_FOLLOWUPS_SNAPSHOT.read(sqlite);
    const counts = Object.fromEntries(SIGNINGS_FOLLOWUPS_COLLECTIONS.map((n) => [n, collections[n].length]));
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    sqlite.exec('BEGIN');
    let saveSeq; let recordRemoved; let rebuilt;
    try {
      const upsert = sqlite.prepare('INSERT INTO collections (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value');
      for (const n of SIGNINGS_FOLLOWUPS_COLLECTIONS) upsert.run(n, JSON.stringify(collections[n]));
      for (const t of [...SIGNINGS_FOLLOWUPS_TABLES].reverse()) sqlite.exec(`DROP TABLE ${t};`);
      sqlite.prepare(`DELETE FROM idempotency_keys WHERE owner_table NOT IN (${S8C_KEY_OWNERS.map(() => '?').join(', ')})`).run(...S8C_KEY_OWNERS);
      rebuilt = { idempotencyKeys: rebuildTable(sqlite, 'idempotency_keys', idempotencyKeysDdl(S8C_KEY_OWNERS)) };
      recordRemoved = sqlite.prepare('DELETE FROM data_migrations WHERE id = ?').run(SIGNINGS_FOLLOWUPS_MIGRATION).changes > 0;
      sqlite.prepare('DELETE FROM meta WHERE key = ?').run(SIGNINGS_FOLLOWUPS_CUTOVER_META);
      saveSeq = (Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0) + 1;
      sqlite.prepare("INSERT INTO meta (key, value) VALUES ('saveSeq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(saveSeq));
      const broken = sqlite.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`foreign_key_check found ${broken.length} broken reference(s) (first: ${broken[0].table} rowid ${broken[0].rowid} → ${broken[0].parent})`);
      if (_failBeforeCommit) throw new Error('synthetic commit failure (test seam)');
      sqlite.exec('COMMIT');
    } catch (err) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw err;
    } finally {
      sqlite.exec('PRAGMA foreign_keys = ON;');
    }
    sqlite.exec('VACUUM');
    const problems = [];
    const integrity = sqlite.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') problems.push(`integrity_check: ${integrity}`);
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) problems.push('foreign_key_check is not empty');
    if (sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?').get(SIGNINGS_FOLLOWUPS_MIGRATION)) problems.push('the 0018 record is still present');
    if (sqlite.prepare('SELECT 1 FROM meta WHERE key = ?').get(SIGNINGS_FOLLOWUPS_CUTOVER_META)) problems.push('the S8d meta key is still present');
    for (const t of SIGNINGS_FOLLOWUPS_TABLES) if (hasTable(t)) problems.push(`${t} still exists`);
    if (JSON.stringify(sqlite.prepare('SELECT * FROM idempotency_keys ORDER BY owner_table, owner_id, position').all()) !== keysBefore) problems.push('the S8a/S8b/S8c idempotency_keys rows changed');
    if (/signing_packages/.test(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'").get()?.sql ?? '')) problems.push('idempotency_keys still carries the S8d owner CHECK');
    for (const [name, n] of Object.entries(counts)) {
      const v = sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value;
      let count = null; try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) count = parsed.length; } catch { /* reported below */ }
      if (count !== n) problems.push(`the ${name} blob holds ${count === null ? 'nothing readable' : `${count} entries`}, not the ${n} the table held`);
    }
    for (const t of UNTOUCHED) { const after = hasTable(t) ? snapshotOf(t) : null; if (after !== before[t]) problems.push(`the ${t} table changed`); }
    if (problems.length) throw new Error(`the rollback copy failed revalidation and was removed: ${problems.join('; ')}`);
    done = true;
    return { output, applied, recordRemoved, ...counts, rebuilt, saveSeq };
  } finally {
    sqlite?.close();
    if (!done) for (const f of [output, `${output}-wal`, `${output}-shm`]) fs.rmSync(f, { force: true });
  }
}
