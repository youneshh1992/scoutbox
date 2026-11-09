/**
 * Records the session lifetime that session expiries are computed with. Session rows carry token hashes, never
 * tokens.
 */
import { SESSIONS_CUTOVER_MIGRATION, DEFAULT_SESSION_TTL_MS } from '../sessions.mjs';

export const id = SESSIONS_CUTOVER_MIGRATION;
export const note = 'sessions become table-backed (token hashes only)';

export function up(sqlite, { sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
  sqlite.prepare("INSERT INTO meta (key, value) VALUES ('sessionTtlMs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(sessionTtlMs));
}
