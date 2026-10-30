/**
 * The mail outbox, the push log and the device push tokens become their own
 * tables (migration plan step S7c; docs/architecture/s7-readiness-review.md §10
 * as corrected by the independent review of 6ca66ba). REGISTERED in
 * DATA_MIGRATIONS.
 *
 * Inside the runner's one transaction, after 0010 (dispatches):
 *   1. Create `outbox`, `push_log` and `push_tokens` (OUTBOX_PUSH_DDL).
 *   2. Import the three blobs the file holds — `outbox` (the mailer literal
 *      and the delivery-centre literal, told apart structurally; a delivery
 *      record's `to` may be null), `pushLog` (the sender literal), `pushTokens`
 *      (the route literal, the token ANY JSON value, stored losslessly as JSON
 *      text; duplicates legal) — through the repository's own validation:
 *      every entry is checked, nothing is coerced or normalised; the array
 *      position becomes the durable ordering key; unknown own fields are kept
 *      in `extra_json`. ANY refusal aborts the whole migration with
 *      OUTBOX_PUSH_IMPORT_BLOCKED (collection, entry positions and reasons,
 *      never an address, a text, a token or a code): the runner rolls back,
 *      the blobs and saveSeq are untouched, the next boot refuses the same way.
 *   3. Retire the blob rows; record the counts in `meta.outboxPushCutover`.
 * A file without a blob (a first installation, a collection a build never
 * created) creates the tables and imports nothing for it — never from the
 * seed, never from memory. The step never runs twice (recorded) and refuses to
 * run before 0010 or when any of the three tables already exists.
 */
import { migrationApplied } from '../database.mjs';
import { DISPATCHES_MIGRATION } from '../dispatches.mjs';
import { OUTBOX_PUSH_MIGRATION, OUTBOX_PUSH_CUTOVER_META, OUTBOX_PUSH_DDL, OUTBOX_PUSH_TABLES, importOutboxPushBlobs } from '../outboxPush.mjs';

export const id = OUTBOX_PUSH_MIGRATION;
export const note = 'the mail outbox, the push log and the device push tokens become their own tables (insertion order kept; two outbox shapes told apart structurally; tokens and non-string destinations stored losslessly as JSON (review of 40aa05c))';

export function up(sqlite, { now = Date.now() } = {}) {
  if (!sqlite.isTransaction) throw new Error(`${id}: up() runs inside the migration runner's transaction only`);
  if (!migrationApplied(sqlite, DISPATCHES_MIGRATION)) throw new Error(`${id}: ${DISPATCHES_MIGRATION} must be recorded first`);
  const hasTable = (t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const existing = OUTBOX_PUSH_TABLES.filter(hasTable);
  if (existing.length) throw new Error(`${id}: ${existing.join(', ')} already exist without the migration record; refusing to guess their state`);
  sqlite.exec(OUTBOX_PUSH_DDL);
  const counts = importOutboxPushBlobs(sqlite);
  sqlite.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OUTBOX_PUSH_CUTOVER_META, JSON.stringify({ at: now, ...counts }));
}
