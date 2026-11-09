/**
 * Players, guardians and the guardian–child links (repositories/identity.mjs `IDENTITY_DDL`).
 * `meta.coreIdentityInit` starts `pending`: the data layer imports the seed once, on the first boot
 * (repositories/identity.mjs `initialize`).
 */
import { IDENTITY_DDL, CORE_IDENTITY_LIVE_MIGRATION, CORE_IDENTITY_INIT_META } from '../identity.mjs';

export const id = CORE_IDENTITY_LIVE_MIGRATION;
export const note = 'players, guardians and guardian_children become typed tables (S4a; explicit writes and SQL reads since S14h)';
export { IDENTITY_DDL };

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  sqlite.exec(IDENTITY_DDL);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CORE_IDENTITY_INIT_META, 'pending');
}
