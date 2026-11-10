/**
 * Drops the `collections` table and moves the id counter from `meta` into `counters`.
 */
import { OPERATIONS_MIGRATION } from '../operations.mjs';
import { migrationApplied } from '../database.mjs';
import { COUNTERS_DDL, ID_COUNTER_FLOOR } from '../counters.mjs';

export const id = '0039_retire_blob';
export const note = 'The blob store is retired: the collections table is dropped and the id counter becomes a row of counters';

export function up(sqlite) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, OPERATIONS_MIGRATION)) throw new Error(`${id}: ${OPERATIONS_MIGRATION} must be recorded first`);
  const counter = Number(sqlite.prepare("SELECT value FROM meta WHERE key = 'idCounter'").get()?.value) || 0;
  sqlite.exec('DROP TABLE IF EXISTS collections');
  sqlite.exec(COUNTERS_DDL);
  sqlite.prepare("INSERT INTO counters (name, value) VALUES ('id', ?)").run(Math.max(ID_COUNTER_FLOOR, counter));
  sqlite.exec("DELETE FROM meta WHERE key IN ('idCounter', 'savedAt', 'saveSeq')");
}
