/**
 * Counters: named monotonic values. One today, `id`, behind every `<prefix>-<n>` id the
 * server mints (`nextId`).
 *
 * The process keeps the value in memory and writes each new value through at once (`MAX`, so a write never lowers
 * it). Inside a unit of work the write joins the unit's transaction; if the unit rolls back the row goes back with
 * it, but memory does not, so the process never hands out the same number twice. After a restart the number of a
 * rolled-back mint may come round again: harmless, because nothing that carried it was committed (side effects run
 * only after COMMIT).
 */

export const ID_COUNTER_FLOOR = 1000;

export const COUNTERS_DDL = `
CREATE TABLE counters (
  name  TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 40),
  value INTEGER NOT NULL CHECK (value >= 0)
) STRICT;
`;

export function createIdCounter({ sqlite }) {
  const read = sqlite.prepare("SELECT value FROM counters WHERE name = 'id'");
  const write = sqlite.prepare("UPDATE counters SET value = MAX(value, ?) WHERE name = 'id'");
  const stored = read.get();
  // Migration 0039 always inserts the row; without it every mint would be lost and ids reused after a restart.
  if (!stored)
    throw new Error(
      "COUNTER_MISSING: the counters table has no 'id' row (migration 0039 inserts it); refusing to mint ids that would not be stored",
    );
  let value = Math.max(ID_COUNTER_FLOOR, Number(stored.value) || 0);
  return {
    /** The next number, written through before it is returned. */
    next() {
      value += 1;
      write.run(value);
      return value;
    },
    /** The last number handed out (or the floor). */
    current: () => value,
  };
}
