/**
 * TEST SUPPORT ONLY — prepares a temporary database the way migration 0005 will
 * leave a real one, so the identity repositories can be exercised against the
 * intended live schema before that migration exists:
 *   - drops the S1 shadow tables (`guardian_children`, `players`, `guardians`,
 *     created by migration 0002 without `facets_json`) when present;
 *   - creates the live definitions (`CANDIDATE_DDL`: the documented identity DDL
 *     plus `facets_json`);
 *   - records the cutover marker `0005_core_identity_live` in `data_migrations`
 *     and the initialisation state in `meta.coreIdentityInit`.
 *
 * It is imported by test scripts only. It is not a migration module (the
 * runner only knows the DATA_MIGRATIONS list in repositories/index.mjs), it
 * is never reached by server boot, and it must never be pointed at a real
 * data directory: it exists so tests do not have to bypass the repositories'
 * authority checks — they satisfy them the way the real migration will.
 */
import { CANDIDATE_DDL, CORE_IDENTITY_LIVE_MIGRATION } from '../repositories/identityPreflight.mjs';
import { CORE_IDENTITY_INIT_META } from '../repositories/identity.mjs';

export function prepareLiveIdentitySchema(sqlite, { initState = 'done', now = Date.now() } = {}) {
  if (sqlite.isTransaction) throw new Error('prepareLiveIdentitySchema runs outside a transaction (it toggles foreign keys)');
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const isShadow = (t) => hasTable(t) && !sqlite.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'facets_json');
  const liveAlready = hasTable('players') && !isShadow('players') && hasTable('guardians') && !isShadow('guardians') && hasTable('guardian_children');
  if (!liveAlready) {
    sqlite.exec('PRAGMA foreign_keys = OFF;');
    try {
      for (const t of ['guardian_children', 'players', 'guardians']) if (hasTable(t)) sqlite.exec(`DROP TABLE ${t}`);
      sqlite.exec(CANDIDATE_DDL);
    } finally { sqlite.exec('PRAGMA foreign_keys = ON;'); }
  }
  sqlite.exec('CREATE TABLE IF NOT EXISTS data_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);');
  sqlite.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  sqlite.prepare('INSERT OR IGNORE INTO data_migrations (id, applied_at) VALUES (?, ?)').run(CORE_IDENTITY_LIVE_MIGRATION, now);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CORE_IDENTITY_INIT_META, initState);
}
