/**
 * Sessions become authoritative in their table (S2): rows carry token hashes, never tokens. The table was created
 * by 0002; on a new database it is empty here. The step records the session lifetime the expiries are computed with.
 * REGISTERED in DATA_MIGRATIONS.
 */
import { SESSIONS_CUTOVER_MIGRATION, DEFAULT_SESSION_TTL_MS } from '../sessions.mjs';

export const id = SESSIONS_CUTOVER_MIGRATION;
export const note = 'sessions become table-backed (token hashes only)';

export function up(sqlite, { sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  sqlite.prepare("INSERT INTO meta (key, value) VALUES ('sessionTtlMs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(sessionTtlMs));
}
