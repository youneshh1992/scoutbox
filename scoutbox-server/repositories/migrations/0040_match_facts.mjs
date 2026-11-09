/**
 * S14j: the match facts (repositories/matchFacts.mjs). Creates the facts tables, the dirty markers and the triggers
 * on every input table, and marks every live player so the first boot after it derives their facts. REGISTERED in
 * DATA_MIGRATIONS. Nothing is imported: the facts are derived, never a source.
 */
import { migrationApplied } from '../database.mjs';
import { MATCH_FACTS_DDL, matchFactsTriggersDdl } from '../matchFacts.mjs';

export const id = '0040_match_facts';
export const note = 'The match facts: a per-player projection kept by triggers on its inputs, read by matching and Nobody Missed (S14j)';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, '0039_retire_blob')) throw new Error(`${id}: 0039_retire_blob must be recorded first`);
  sqlite.exec(MATCH_FACTS_DDL);
  sqlite.exec(matchFactsTriggersDdl());
  sqlite.exec('INSERT OR IGNORE INTO player_match_facts_dirty (player_id) SELECT id FROM players WHERE deleted_at IS NULL');
}
