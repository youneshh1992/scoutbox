/**
 * Delivery dispatch records and their attempts — migration plan step S7b
 * (docs/architecture/s7-readiness-review.md §9 as corrected by the review of
 * dc4b559: option A for the notification reference, the total attempt-shape
 * CHECK, the timestamp contract, the first-match callback lookup).
 *
 * Owns two tables and the read-only view `db.dispatches`:
 *
 *   dispatches         one row per delivery dispatch (one per notification × destination)
 *   dispatch_attempts  the nested `attempts` entries, keyed by (dispatch, position)
 *
 * WHAT A DISPATCH IS. Since M13 the delivery sweep (m13/delivery.mjs) has
 * written ONE literal with exactly eighteen keys — { id, notificationId,
 * audience, channel, to, provider, status, skipReason, providerMessageId,
 * attempts, nextAt, actionDeadline, createdAt, deliveredAt, openedAt,
 * actionedAt, failedAt, failReason } — null (never absent) when a value is
 * unset. The import requires every one of those keys and normalises NOTHING:
 * a key that is absent is a row this build never wrote, refused by name.
 * Unknown OWN keys (a legacy row an older tool annotated) are kept in
 * `extra_json` and spread back first on export, as the S7a repository does
 * (an own "__proto__" key is data: `Object.defineProperty`, never assignment).
 * UNKNOWN NESTED DATA IS DETACHED (review of 26d492b, finding 2): an unknown
 * field is copied as a prototype-safe JSON clone at ingress (create, import,
 * snapshot replace), on export and in every transaction snapshot, so a caller
 * that mutates its input after `create`, or a returned export, never changes
 * the mirror; a value JSON cannot carry (undefined, a function, a symbol, a
 * bigint, a non-finite number, a class instance) refuses the whole write by
 * name — nothing is dropped or nulled silently. The read-only views refuse a
 * nested write as they refuse a top-level one.
 * The audience refuses unknown fields (its two columns are all the schema
 * keeps). Vocabularies are OPEN: any non-empty status, channel or provider is
 * stored as written (the ladder's RANK lives in m13/delivery.mjs, not here);
 * `failReason` is stored untruncated; no uniqueness of (notification, channel)
 * and none of `providerMessageId` — duplicates are legal.
 *
 * THE ORDERING KEY. Every reader depends on insertion order (the admin view
 * reverses it; the callback lookup takes the FIRST match; the sweep processes
 * rows in it). `seq INTEGER PRIMARY KEY` is that order, durable: assigned at
 * insert, preserved by the migration (array position), by backup/restore and
 * by the rollback (rows written back in `seq` order). Attempts are ordered by
 * their position inside the dispatch (`dispatch_attempts.seq`, 0-based); no
 * attempt id is minted and no global counter is consumed.
 *
 * THE NOTIFICATION REFERENCE (option A). `notification_id` is a plain indexed
 * reference: no foreign key, no cascade. An ordinary account deletion removes
 * a person's notification rows and leaves their dispatch rows behind, exactly
 * as every build since M13 did (the preparation probe counted four of
 * eighteen). The migration imports such orphans unchanged and COUNTS them
 * (`orphanReferences` in the cutover record); nothing prunes, re-parents or
 * blocks on them. Retention is a separate, open decision.
 *
 * TWO ATTEMPT SHAPES, ONE TOTAL CHECK (review of dc4b559, finding 1). A send
 * is { at, ok, error } (ok a boolean, error a string or null); a quiet-hours
 * re-check note is { at, note } and is never counted as a send. In SQL a send
 * row is `kind = 'send'` with `ok IS NOT NULL AND ok IN (0,1) AND note IS NULL`
 * and a note row is `kind = 'quiet_recheck'` with `ok IS NULL AND error IS NULL
 * AND note IS NOT NULL` — the predicate is total, so a NULL outcome cannot slip
 * through SQLite's "NULL CHECK passes" rule; scripts/testDispatches.mjs proves
 * it through direct SQL on the real DDL.
 *
 * THE TIMESTAMP CONTRACT (finding 2). Every clock this server writes itself
 * (`createdAt`, `nextAt`, `actionDeadline`, `actionedAt`, `failedAt`, an
 * attempt's `at`) is `Date.now()` or a sum of it: an integer, stored in an
 * INTEGER column, a fraction refused. `deliveredAt` and `openedAt` are written
 * by the provider callback route as `Number(ev.at) || Date.now()`: a finite
 * number that MAY be fractional (1700000000000.5 is a value the accepted build
 * stores and the JSON blob preserves). The repository accepts exactly what
 * that writer produces — a finite JavaScript number, integer-valued or not, or
 * null — and stores it in a REAL column: a JavaScript number is a 64-bit
 * double, the column is the same double, so the value comes back exactly
 * (integer-valued timestamps included; node:sqlite binds every number as a
 * double, and a REAL column states what is actually stored instead of
 * converting it). A string, an object, NaN or ±Infinity in a legacy blob or a
 * snapshot is refused at import and at create (JSON never carries them). The
 * ONE exception is the live callback path (review of 26d492b, finding 3): the
 * previous build held `Number('Infinity') || Date.now()` — Infinity — in
 * memory, where its nullish-assignment rule treated the clock as SET for every
 * later event in the process, while its JSON save wrote `null`. `patch` accepts
 * that non-finite number for `deliveredAt` / `openedAt` exactly so: the MIRROR
 * keeps the number (a later event cannot replace it; a view or an HTTP response
 * serialises it as null, as before), the COLUMN stores NULL, the export and the
 * backup shape carry null, a transaction snapshot keeps the in-memory number
 * (a rolled-back unit restores it; a committed one keeps it), and a restart —
 * which reloads the file — shows null, as a restart of that build did. The
 * bookkeeping is the mirror row itself: nothing else is kept, nothing leaks
 * into a stored shape, nothing survives a restart.
 *
 * THE CALLBACK LOOKUP (finding 3). `byProviderMessageId(v)` is today's
 * `Array.find(x => x.providerMessageId === v)` over the in-memory mirror: the
 * FIRST row in insertion order whose stored id strictly equals the value; an
 * explicit null matches the first row whose id is null; `undefined` (an
 * omitted field) matches nothing; no string coercion, no SQL equality to NULL.
 *
 * THE MIRROR AND THE TWO WRITE MODES are those of repositories/notifications.mjs
 * (S7a, accepted at 0641b2c), copied rather than shared so each repository's
 * contract reads on its own: every row in memory in insertion order (the array
 * behind `db.dispatches`), kept current on every mutation; immediate mode for
 * tools, tests and the migration (own transaction per mutation, joined inside
 * an open unit of work, raw caller transaction with the `reload()` contract);
 * staged mode for the running server (the mirror changes at once, the SQL
 * waits for the next snapshot save — an ordinary save, a persistNow or a
 * unit's commit — so a dispatch row is durable TOGETHER WITH the blob edits
 * made alongside it: the outbox row the fake provider wrote, the
 * failure-injection counter it decremented, the ops event and the webhook
 * delivery intent of an exhausted retry). Inside a unit a mutation joins it
 * (a refused argument, a missing row, a missing hook poisons the unit even
 * when caught — every refusal of create, recordAttempt and patch is raised
 * inside the joined boundary; review of 26d492b, finding 1);
 * on rollback the mirror and the queue return to the state they had when the
 * unit began. An owned immediate transaction that fails — at a statement or at
 * COMMIT — restores the mirror in place, attempts arrays and held views
 * included. There is NO effects queue: a dispatch has no push and no live
 * event of its own, and the sweep's webhook intent is a persisted blob row,
 * not an after-durable effect (the next-step instruction forbids adding one).
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0010_dispatches` in `data_migrations`, never by the tables existing or by
 * row counts. Snapshot format (backups, restores, the persistence suites): the
 * legacy shape exactly, one entry per row, attempts nested, in insertion
 * order. An entry the validators refuse refuses the whole write (a save, the
 * migration) with DISPATCHES_IMPORT_BLOCKED, naming the entry index and the
 * reason and NEVER an address, a provider id or a provider text.
 */
import { readonlyView } from './readonly.mjs';
import { migrationApplied, transaction } from './database.mjs';

export const DISPATCHES_MIGRATION = '0010_dispatches';
/** `meta` key holding the cutover record: counts only, never data. */
export const DISPATCHES_CUTOVER_META = 'dispatchesCutover';
export const DISPATCH_TABLES = Object.freeze(['dispatches', 'dispatch_attempts']);

export const DISPATCHES_DDL = `
CREATE TABLE dispatches (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  notification_id     TEXT NOT NULL,
  audience_kind       TEXT NOT NULL,
  audience_id         TEXT NOT NULL,
  channel             TEXT NOT NULL,
  to_address          TEXT,
  provider            TEXT NOT NULL,
  status              TEXT NOT NULL,
  skip_reason         TEXT,
  provider_message_id TEXT,
  next_at             INTEGER NOT NULL,
  action_deadline_at  INTEGER,
  created_at          INTEGER NOT NULL,
  delivered_at        REAL,
  opened_at           REAL,
  actioned_at         INTEGER,
  failed_at           INTEGER,
  fail_reason         TEXT,
  extra_json          TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))
) STRICT;
CREATE INDEX dispatches_notification ON dispatches (notification_id);
CREATE INDEX dispatches_provider_message ON dispatches (provider_message_id);
CREATE INDEX dispatches_status_next ON dispatches (status, next_at);
CREATE INDEX dispatches_audience_seq ON dispatches (audience_kind, audience_id, seq);
CREATE TABLE dispatch_attempts (
  dispatch_seq INTEGER NOT NULL REFERENCES dispatches(seq) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('send', 'quiet_recheck')),
  attempted_at INTEGER NOT NULL,
  ok           INTEGER,
  error        TEXT,
  note         TEXT,
  PRIMARY KEY (dispatch_seq, seq),
  CHECK ((kind = 'send' AND ok IS NOT NULL AND ok IN (0, 1) AND note IS NULL)
      OR (kind = 'quiet_recheck' AND ok IS NULL AND error IS NULL AND note IS NOT NULL))
) STRICT;`;

export const dispatchesLive = (sqlite) => migrationApplied(sqlite, DISPATCHES_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`DISPATCHES_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'DISPATCHES_IMPORT_BLOCKED', ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
/** Set an own data property — never `obj[k] = v`, which for an own "__proto__" key of parsed JSON would rewrite the prototype and lose the field. */
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
/**
 * A DETACHED, prototype-safe copy of a JSON value (review of 26d492b, finding
 * 2): null, booleans, strings, finite numbers, arrays and plain objects, every
 * own key copied with `setOwn` at every depth (an own "__proto__", "constructor"
 * or "toString" key is data). Anything JSON cannot carry — undefined, a
 * function, a symbol, a bigint, a non-finite number, a class instance — is
 * refused by name, never dropped or coerced (`JSON.stringify` would drop or
 * null it silently). Returns `{ value }` or `{ reason }`.
 */
function cloneJson(v, at) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return { value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { reason: `${at} is a non-finite number and cannot be stored as JSON` };
  if (Array.isArray(v)) { const out = []; for (let i = 0; i < v.length; i++) { const r = cloneJson(v[i], `${at}[${i}]`); if (r.reason) return r; out.push(r.value); } return { value: out }; }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { reason: `${at} is not a plain object and cannot be stored as JSON` };
    const out = {}; for (const k of Object.keys(v)) { const r = cloneJson(v[k], `${at}.${k}`); if (r.reason) return r; setOwn(out, k, r.value); } return { value: out };
  }
  return { reason: `${at} (${typeof v}) cannot be stored as JSON` };
}
/** The unknown own fields of a mirror row, each a detached copy (the mirror only ever holds values `cloneJson` accepted). */
function cloneExtras(row) { const extra = {}; for (const k of Object.keys(row)) if (!DISPATCH_KEYS.includes(k)) setOwn(extra, k, cloneJson(row[k], k).value); return extra; }

// ------------------------------------------------------------------ validation (no coercion; every refusal names the reason, never an address or a text)
/** The eighteen keys of the literal every build since M13 wrote, in its order. */
export const DISPATCH_KEYS = Object.freeze(['id', 'notificationId', 'audience', 'channel', 'to', 'provider', 'status', 'skipReason', 'providerMessageId', 'attempts', 'nextAt', 'actionDeadline', 'createdAt', 'deliveredAt', 'openedAt', 'actionedAt', 'failedAt', 'failReason']);
const AUDIENCE_KEYS = Object.freeze(['kind', 'id']);
const SEND_KEYS = Object.freeze(['at', 'ok', 'error']);
const NOTE_KEYS = Object.freeze(['at', 'note']);
/** The fields the sweep and the callback route change after a row exists; everything else is fixed at creation. */
const PATCH_KEYS = Object.freeze(['status', 'providerMessageId', 'nextAt', 'deliveredAt', 'openedAt', 'actionedAt', 'failedAt', 'failReason']);

function audienceOf(raw, field = 'audience') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object { kind, id } (got ${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !AUDIENCE_KEYS.includes(k));
  if (unknown.length) return { reason: `${field} carries unknown field(s) ${unknown.join(', ')} (the schema keeps an audience as kind and id only; a field dropped here would be lost)` };
  if (!nonEmpty(raw.kind)) return { reason: `${field}.kind must be a non-empty string` };
  if (!nonEmpty(raw.id)) return { reason: `${field}.id must be a non-empty string` };
  return { audience: { kind: raw.kind, id: raw.id } };
}
/** Validate one attempt entry: `{ attempt }` (a plain copy in its shape) or `{ reason }`. */
export function attemptOf(raw, field = 'attempt') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object (got ${describe(raw)})` };
  const keys = Object.keys(raw);
  const hasNote = Object.hasOwn(raw, 'note'); const hasOk = Object.hasOwn(raw, 'ok');
  if (hasNote && hasOk) return { reason: `${field} carries both note and ok (a send row and a quiet re-check row are different shapes)` };
  const shape = hasNote ? NOTE_KEYS : hasOk && Object.hasOwn(raw, 'error') ? SEND_KEYS : null;
  if (!shape) return { reason: `${field} is neither a send row {at, ok, error} nor a quiet re-check row {at, note}` };
  const unknown = keys.filter((k) => !shape.includes(k));
  if (unknown.length) return { reason: `${field} carries unknown field(s) ${unknown.join(', ')}` };
  if (!isInt(raw.at)) return { reason: `${field}.at must be an integer timestamp` };
  if (hasNote) {
    if (!nonEmpty(raw.note)) return { reason: `${field}.note must be a non-empty string` };
    return { attempt: { at: raw.at, note: raw.note } };
  }
  if (typeof raw.ok !== 'boolean') return { reason: `${field}.ok must be a boolean` };
  if (raw.error !== null && typeof raw.error !== 'string') return { reason: `${field}.error must be a string or null` };
  return { attempt: { at: raw.at, ok: raw.ok, error: raw.error } };
}
const stringOrNull = (v) => v === null || typeof v === 'string';
const intOrNull = (v) => v === null || isInt(v);
const finiteOrNull = (v) => v === null || isFiniteNumber(v);
/** Validate one exported dispatch: `{ ok: true, row, hasExtra }` or `{ ok: false, reason }`. The row is the mirror shape (a plain copy, attempts copied). */
export function validateDispatchRow(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  for (const k of DISPATCH_KEYS) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${k} is absent (every build wrote all 18 keys; nothing is normalised)` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!nonEmpty(raw.notificationId)) return { ok: false, reason: 'notificationId must be a non-empty string' };
  const a = audienceOf(raw.audience); if (a.reason) return { ok: false, reason: a.reason };
  if (!nonEmpty(raw.channel)) return { ok: false, reason: 'channel must be a non-empty string' };
  if (!stringOrNull(raw.to)) return { ok: false, reason: 'to must be a string or null' };
  if (!nonEmpty(raw.provider)) return { ok: false, reason: 'provider must be a non-empty string' };
  if (!nonEmpty(raw.status)) return { ok: false, reason: 'status must be a non-empty string' };
  if (!stringOrNull(raw.skipReason)) return { ok: false, reason: 'skipReason must be a string or null' };
  if (!stringOrNull(raw.providerMessageId)) return { ok: false, reason: 'providerMessageId must be a string or null' };
  if (!Array.isArray(raw.attempts)) return { ok: false, reason: `attempts must be an array (got ${describe(raw.attempts)})` };
  const attempts = [];
  for (let i = 0; i < raw.attempts.length; i++) { const v = attemptOf(raw.attempts[i], `attempts[${i}]`); if (v.reason) return { ok: false, reason: v.reason }; attempts.push(v.attempt); }
  if (!isInt(raw.nextAt)) return { ok: false, reason: 'nextAt must be an integer timestamp' };
  if (!intOrNull(raw.actionDeadline)) return { ok: false, reason: 'actionDeadline must be an integer timestamp or null' };
  if (!isInt(raw.createdAt)) return { ok: false, reason: 'createdAt must be an integer timestamp' };
  if (!finiteOrNull(raw.deliveredAt)) return { ok: false, reason: 'deliveredAt must be a finite number (integer or fractional) or null' };
  if (!finiteOrNull(raw.openedAt)) return { ok: false, reason: 'openedAt must be a finite number (integer or fractional) or null' };
  if (!intOrNull(raw.actionedAt)) return { ok: false, reason: 'actionedAt must be an integer timestamp or null' };
  if (!intOrNull(raw.failedAt)) return { ok: false, reason: 'failedAt must be an integer timestamp or null' };
  if (!stringOrNull(raw.failReason)) return { ok: false, reason: 'failReason must be a string or null' };
  const extra = {};
  for (const k of Object.keys(raw)) if (!DISPATCH_KEYS.includes(k)) { const c = cloneJson(raw[k], k); if (c.reason) return { ok: false, reason: c.reason }; setOwn(extra, k, c.value); }
  const row = { ...extra, id: raw.id, notificationId: raw.notificationId, audience: a.audience, channel: raw.channel, to: raw.to, provider: raw.provider, status: raw.status, skipReason: raw.skipReason, providerMessageId: raw.providerMessageId, attempts, nextAt: raw.nextAt, actionDeadline: raw.actionDeadline, createdAt: raw.createdAt, deliveredAt: raw.deliveredAt, openedAt: raw.openedAt, actionedAt: raw.actionedAt, failedAt: raw.failedAt, failReason: raw.failReason };
  return { ok: true, row, hasExtra: Object.keys(extra).length > 0 };
}
/** Validate a whole exported dispatches collection; throws DISPATCHES_IMPORT_BLOCKED (entries and reasons, never an address). Returns `{ rows, attempts, withExtraFields, byStatus }`. */
export function validateDispatchRows(rows, { label = 'the dispatches collection' } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const ids = new Set();
  let attempts = 0; let withExtraFields = 0; const byStatus = {};
  rows.forEach((raw, i) => {
    const v = validateDispatchRow(raw);
    if (!v.ok) { problems.push(`entry #${i}: ${v.reason}`); return; }
    if (ids.has(v.row.id)) { problems.push(`entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; }
    ids.add(v.row.id); attempts += v.row.attempts.length; if (v.hasExtra) withExtraFields += 1; byStatus[v.row.status] = (byStatus[v.row.status] ?? 0) + 1;
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  return { rows: out, attempts, withExtraFields, byStatus };
}

// ------------------------------------------------------------------ rows ↔ the tables
const SELECT = 'SELECT seq, id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason, extra_json FROM dispatches';
const INSERT = 'INSERT INTO dispatches (id, notification_id, audience_kind, audience_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason, extra_json) VALUES (@id, @notification_id, @audience_kind, @audience_id, @channel, @to_address, @provider, @status, @skip_reason, @provider_message_id, @next_at, @action_deadline_at, @created_at, @delivered_at, @opened_at, @actioned_at, @failed_at, @fail_reason, @extra_json)';
/** The attempt insert resolves the dispatch's seq by id, so it works queued (staged mode) before the dispatch's own INSERT has run. */
const INSERT_ATTEMPT = 'INSERT INTO dispatch_attempts (dispatch_seq, seq, kind, attempted_at, ok, error, note) SELECT seq, ?, ?, ?, ?, ?, ? FROM dispatches WHERE id = ?';
const SELECT_ATTEMPTS = 'SELECT dispatch_seq, seq, kind, attempted_at, ok, error, note FROM dispatch_attempts ORDER BY dispatch_seq, seq';
const attemptFromDb = (r) => (r.kind === 'quiet_recheck' ? { at: r.attempted_at, note: r.note } : { at: r.attempted_at, ok: r.ok === 1, error: r.error });
const attemptParams = (a) => (Object.hasOwn(a, 'note') ? ['quiet_recheck', a.at, null, null, a.note] : ['send', a.at, a.ok ? 1 : 0, a.error, null]);
/** The mirror row for a table row (attempts attached by the reader). */
function rowFromDb(r, attempts) {
  const extra = r.extra_json ? JSON.parse(r.extra_json) : {};
  const row = { ...extra, id: r.id, notificationId: r.notification_id, audience: { kind: r.audience_kind, id: r.audience_id }, channel: r.channel, to: r.to_address, provider: r.provider, status: r.status, skipReason: r.skip_reason, providerMessageId: r.provider_message_id, attempts, nextAt: r.next_at, actionDeadline: r.action_deadline_at, createdAt: r.created_at, deliveredAt: r.delivered_at, openedAt: r.opened_at, actionedAt: r.actioned_at, failedAt: r.failed_at, failReason: r.fail_reason };
  // `{ ...extra }` copies an own "__proto__" key as an own key (spread uses CreateDataProperty); nothing else is needed.
  return row;
}
/**
 * What the file holds for a callback clock: the number itself when finite, NULL
 * for the non-finite in-memory state (review of 26d492b, finding 3): the
 * previous build's JSON save wrote `null` for `Infinity`, and so does this
 * column, while the mirror keeps the number (see THE TIMESTAMP CONTRACT).
 */
const storedClock = (v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v);
function rowParams(row) {
  const extra = cloneExtras(row);
  return {
    id: row.id, notification_id: row.notificationId, audience_kind: row.audience.kind, audience_id: row.audience.id, channel: row.channel, to_address: row.to, provider: row.provider, status: row.status,
    skip_reason: row.skipReason, provider_message_id: row.providerMessageId, next_at: row.nextAt, action_deadline_at: row.actionDeadline, created_at: row.createdAt, delivered_at: storedClock(row.deliveredAt), opened_at: storedClock(row.openedAt),
    actioned_at: row.actionedAt, failed_at: row.failedAt, fail_reason: row.failReason, extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}
const copyAttempt = (a) => ({ ...a });
/** A DETACHED copy of a mirror row (the transaction snapshot shape: nothing shared with the mirror, unknown nested data cloned, the in-memory clocks as they are). */
const copyRow = (row) => { const c = { ...row, audience: { ...row.audience }, attempts: row.attempts.map(copyAttempt) }; for (const k of Object.keys(row)) if (!DISPATCH_KEYS.includes(k)) setOwn(c, k, cloneJson(row[k], k).value); return c; };
/** The export / snapshot-file shape: a detached copy whose callback clocks are what JSON carries (a non-finite in-memory clock → null, as the previous build's save wrote it). */
const exportRow = (row) => { const c = copyRow(row); c.deliveredAt = storedClock(row.deliveredAt); c.openedAt = storedClock(row.openedAt); return c; };

function readRows(sqlite) {
  const bySeq = new Map();
  for (const r of sqlite.prepare(SELECT_ATTEMPTS).all()) { let list = bySeq.get(r.dispatch_seq); if (!list) { list = []; bySeq.set(r.dispatch_seq, list); } list.push(attemptFromDb(r)); }
  return sqlite.prepare(`${SELECT} ORDER BY seq`).all().map((r) => rowFromDb(r, bySeq.get(r.seq) ?? []));
}
function writeRows(sqlite, rows) {
  sqlite.exec('DELETE FROM dispatch_attempts; DELETE FROM dispatches;');
  const ins = sqlite.prepare(INSERT); const att = sqlite.prepare(INSERT_ATTEMPT);
  for (const r of rows) {
    ins.run(rowParams(r));
    r.attempts.forEach((a, i) => att.run(i, ...attemptParams(a), r.id));
  }
  return rows.length;
}

/**
 * Whole-table access for the tools that treat the file as one snapshot
 * (backups, restores, the persistence suites). Before the cutover record both
 * methods decline (`null` / `false`): the caller keeps the legacy blob, which
 * the migration imports on the next boot. Afterwards `read` returns the rows in
 * the legacy shape (attempts nested), in insertion order, and `replace`
 * validates every entry, rewrites both tables inside the caller's transaction
 * (array position → seq) and refuses the whole write on the first problem.
 */
export const DISPATCHES_TABLE = {
  name: 'dispatches',
  read(sqlite) { if (!dispatchesLive(sqlite)) return null; return readRows(sqlite); }, // fresh objects from the file: nothing shared with any mirror
  replace(sqlite, rows) {
    if (!dispatchesLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('dispatches: replace() runs inside the caller\'s transaction');
    writeRows(sqlite, validateDispatchRows(rows).rows);
    return true;
  },
};

/**
 * Import the legacy (or exported) blob into the tables, inside the migration's
 * transaction: validation of every entry, insertion in array order (attempts
 * in their positions), the blob row retired. Orphan references — a
 * notificationId with no row in `notifications` — are imported unchanged and
 * counted. Returns the counts the migration records in `meta`.
 */
export function importDispatchesBlob(sqlite) {
  let counts = { imported: 0, attempts: 0, withExtraFields: 0, orphanReferences: 0, byStatus: {} };
  const hasCollections = tableExists(sqlite, 'collections');
  const row = hasCollections ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get('dispatches') : null;
  if (row) {
    let parsed; try { parsed = JSON.parse(row.value); } catch { throw blocked('the dispatches blob is not valid JSON'); }
    const v = validateDispatchRows(parsed, { label: 'the dispatches blob' });
    writeRows(sqlite, v.rows);
    let orphanReferences = 0;
    if (tableExists(sqlite, 'notifications')) {
      const exists = sqlite.prepare('SELECT 1 FROM notifications WHERE id = ?');
      for (const r of v.rows) if (!exists.get(r.notificationId)) orphanReferences += 1;
    } else orphanReferences = v.rows.length;
    counts = { imported: v.rows.length, attempts: v.attempts, withExtraFields: v.withExtraFields, orphanReferences, byStatus: v.byStatus };
    sqlite.prepare("DELETE FROM collections WHERE name = 'dispatches'").run();
  }
  return { dispatches: counts };
}

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a
 * tool, a test, the migration). `staged` selects the server's write mode (see
 * the header); it needs `unit`, and the store must register `saveHook()` —
 * with `unit` given, no operation joins a unit until `saveHook()` was taken.
 */
export function createDispatchesRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false } = {}) {
  if (!sqlite) throw new TypeError('the dispatches repository needs a SQLite connection (node:sqlite); dispatch records have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the dispatches repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the dispatches repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    insert: sqlite.prepare(INSERT),
    attempt: sqlite.prepare(INSERT_ATTEMPT),
  };
  const COLUMN = { status: 'status', providerMessageId: 'provider_message_id', nextAt: 'next_at', deliveredAt: 'delivered_at', openedAt: 'opened_at', actionedAt: 'actioned_at', failedAt: 'failed_at', failReason: 'fail_reason' };
  const updates = new Map();
  const updateFor = (keys) => { const sig = keys.join(','); let s = updates.get(sig); if (!s) { s = sqlite.prepare(`UPDATE dispatches SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')} WHERE id = ?`); updates.set(sig, s); } return s; };

  // The mirror: every row, in insertion order.
  const rows = []; const byId = new Map();
  const view = readonlyView(rows, 'a delivery dispatch');
  const load = () => {
    rows.length = 0; byId.clear();
    if (!dispatchesLive(sqlite)) return;
    for (const r of readRows(sqlite)) { rows.push(r); byId.set(r.id, r); }
  };
  load();

  // Staged mode: the SQL queue, FIFO, drained whole inside every save transaction.
  const pending = []; let inFlight = 0;
  let hookTaken = false;
  const inUnit = () => !!unit?.active?.();
  const hookRefusal = (what) => new Error(`dispatches: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the queued statements and how a unit of work's rollback restores this repository's memory`);
  /** The one boundary of every mutation (see repositories/notifications.mjs `operation`: identical contract). */
  const operation = (fn) => {
    if (inUnit()) {
      return unit.join(() => {
        if (!hookTaken) throw hookRefusal(staged ? 'a staged write inside a unit of work' : 'joining a unit of work');
        return staged ? fn((op) => { pending.push(op); }) : fn((op) => op());
      });
    }
    if (staged) {
      if (!hookTaken) throw hookRefusal('a staged write');
      if (sqlite.isTransaction) throw new Error('dispatches: the staged repository cannot take part in a transaction it did not open (the server\'s transactions are units of work or snapshot saves)');
      return fn((op) => { pending.push(op); });
    }
    const body = () => fn((op) => op());
    if (sqlite.isTransaction) return body(); // caller-owned: see reload()
    const state = repo.snapshotState();
    try { return transaction(sqlite, body); } catch (err) { repo.restoreState(state); throw err; }
  };
  const restoreInto = (obj, copy) => {
    for (const k of Object.keys(obj)) if (!Object.hasOwn(copy, k)) delete obj[k];
    for (const [k, v] of Object.entries(copy)) {
      if (k === 'audience' && obj.audience) { for (const c of Object.keys(obj.audience)) delete obj.audience[c]; Object.assign(obj.audience, v); continue; }
      if (k === 'attempts' && Array.isArray(obj.attempts)) { obj.attempts.length = 0; for (const a of v) obj.attempts.push(copyAttempt(a)); continue; }
      setOwn(obj, k, DISPATCH_KEYS.includes(k) ? v : cloneJson(v, k).value); // unknown nested data: a fresh detached copy, never the snapshot's object
    }
  };
  // deliveredAt / openedAt accept ANY number: a finite clock as the route
  // produces it, or the non-finite legacy in-memory state (`Number('Infinity')
  // || Date.now()`), kept in the mirror and stored NULL (finding 3).
  const patchValue = (k, v) => {
    switch (k) {
      case 'status': if (!nonEmpty(v)) throw new TypeError('status must be a non-empty string'); return v;
      case 'providerMessageId': if (!stringOrNull(v)) throw new TypeError('providerMessageId must be a string or null'); return v;
      case 'nextAt': if (!isInt(v)) throw new TypeError('nextAt must be an integer timestamp'); return v;
      case 'deliveredAt': if (v !== null && typeof v !== 'number') throw new TypeError('deliveredAt must be a number (the callback clock, finite or the legacy non-finite in-memory state) or null'); return v;
      case 'openedAt': if (v !== null && typeof v !== 'number') throw new TypeError('openedAt must be a number (the callback clock, finite or the legacy non-finite in-memory state) or null'); return v;
      case 'actionedAt': if (!intOrNull(v)) throw new TypeError('actionedAt must be an integer timestamp or null'); return v;
      case 'failedAt': if (!intOrNull(v)) throw new TypeError('failedAt must be an integer timestamp or null'); return v;
      case 'failReason': if (!stringOrNull(v)) throw new TypeError('failReason must be a string or null'); return v;
      default: throw new TypeError(`patch carries field(s) a dispatch does not change: ${k}`);
    }
  };

  const repo = {
    view,
    /** Boot: refuse to run without the cutover record; (re)load the mirror; report counts (never an address). */
    attach() {
      if (!stmt.cutover.get(DISPATCHES_MIGRATION)) throw new Error(`dispatches: the cutover record ${DISPATCHES_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      let attempts = 0; for (const r of rows) attempts += r.attempts.length;
      log(`dispatches: ${rows.length} dispatch record(s) with ${attempts} attempt(s) loaded from the tables`);
      return { engine: 'sqlite', rows: rows.length, attempts };
    },
    /** Re-read the mirror from the tables (a tool that rolled back a raw transaction of its own must call this; see the S7a contract). */
    reload() { load(); return rows.length; },
    count: () => rows.length,
    /** Staged writes not yet in a committed save (0 in immediate mode). */
    pending: () => pending.length,

    // ---------------------------------------------------------- reads (the mirror)
    byId: (id) => { const r = byId.get(id); return r ? readonlyView(r, 'a delivery dispatch') : null; },
    /** Every row, insertion order, read-only. */
    list: () => rows.map((r) => readonlyView(r, 'a delivery dispatch')),
    forNotification(notificationId) { const out = []; for (const r of rows) if (r.notificationId === notificationId) out.push(readonlyView(r, 'a delivery dispatch')); return out; },
    /** The notification ids that already have dispatch rows (the sweep's `seen` set). */
    notificationIdsWithRows() { const s = new Set(); for (const r of rows) s.add(r.notificationId); return s; },
    /** Today's `Array.find(x => x.providerMessageId === v)`: the FIRST row in insertion order whose id strictly equals `v`; null matches the first null row; undefined matches nothing. */
    byProviderMessageId(value) {
      if (value === undefined) return null;
      for (const r of rows) if (r.providerMessageId === value) return readonlyView(r, 'a delivery dispatch');
      return null;
    },
    countsByStatus() { const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1; return counts; },
    /** Rows waiting on the provider (the /admin/metrics `dispatchBacklog` of every build since M13: queued or retrying). */
    backlogCount() { let n = 0; for (const r of rows) if (r.status === 'queued' || r.status === 'retrying') n += 1; return n; },

    // ---------------------------------------------------------- mutations
    /** A new row at the end, in the full eighteen-key shape the sweep writes (validated exactly like an import). Returns it (read-only). */
    create(raw) {
      return operation((exec) => {
        const v = validateDispatchRow(raw); if (!v.ok) throw new TypeError(`a dispatch needs the eighteen-key shape: ${v.reason}`);
        if (byId.has(v.row.id)) throw new Error(`dispatches: a row with id ${v.row.id} already exists`);
        const row = v.row;
        rows.push(row); byId.set(row.id, row);
        const params = rowParams(row); const attempts = row.attempts.map((a, i) => [i, ...attemptParams(a), row.id]);
        exec(() => { stmt.insert.run(params); for (const a of attempts) stmt.attempt.run(...a); });
        return readonlyView(row, 'a delivery dispatch');
      });
    },
    /** Append one attempt — a send `{ at, ok, error }` or a quiet re-check note `{ at, note }` — at the next position. Returns the row (read-only). */
    recordAttempt(id, attempt) {
      return operation((exec) => {
        const row = byId.get(id); if (!row) throw new Error(`dispatches: no dispatch ${id} to record an attempt on`);
        const v = attemptOf(attempt, 'the attempt'); if (v.reason) throw new TypeError(`dispatches: ${v.reason}`);
        const position = row.attempts.length;
        row.attempts.push(v.attempt);
        const params = [position, ...attemptParams(v.attempt), id];
        exec(() => stmt.attempt.run(...params));
        return readonlyView(row, 'a delivery dispatch');
      });
    },
    /**
     * Change the fields the sweep and the callback route change (PATCH_KEYS),
     * each validated per column. EVERY refusal — a patch that is not an object,
     * a row that does not exist, an unknown field, an invalid value — is raised
     * INSIDE the participant boundary (review of 26d492b, finding 1), so inside
     * a unit of work it is a participant failure the store records even when the
     * caller catches it. Only a VALID empty patch on an existing row is a no-op
     * that touches nothing. Returns the row (read-only).
     */
    patch(id, fields) {
      if (isPlainObject(fields) && Object.keys(fields).length === 0 && byId.has(id)) return readonlyView(byId.get(id), 'a delivery dispatch');
      return operation((exec) => {
        if (!isPlainObject(fields)) throw new TypeError('patch needs an object of fields');
        const row = byId.get(id); if (!row) throw new Error(`dispatches: no dispatch ${id} to patch`);
        const keys = Object.keys(fields);
        const unknown = keys.filter((k) => !PATCH_KEYS.includes(k)); if (unknown.length) throw new TypeError(`patch carries field(s) a dispatch does not change: ${unknown.join(', ')}`);
        const values = keys.map((k) => patchValue(k, fields[k]));
        const stored = keys.map((k, i) => (k === 'deliveredAt' || k === 'openedAt' ? storedClock(values[i]) : values[i]));
        keys.forEach((k, i) => { row[k] = values[i]; });
        const update = updateFor(keys);
        exec(() => update.run(...stored, id));
        return readonlyView(row, 'a delivery dispatch');
      });
    },

    /** Every row in the legacy export shape (attempts nested, unknown nested data detached, callback clocks as JSON carries them), in insertion order (the admin backup; the mirror is the intended state, like every blob collection). */
    exportRows: () => rows.map(exportRow),

    // ---------------------------------------------------------- the save hook (staged mode)
    flush() {
      if (!sqlite.isTransaction) throw new Error('dispatches.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      for (const op of pending) op();
      inFlight = pending.length;
      return inFlight;
    },
    /** The store reports COMMIT: the flushed statements leave the queue. */
    commit() { pending.splice(0, inFlight); inFlight = 0; },
    /** The store reports a failed save: nothing the flush ran exists; the writes stay queued for the retry. */
    rollback() { inFlight = 0; },
    /** Unit-of-work participation: the mirror rows (by identity, restored in place, attempts arrays included) and the queue length when the unit began. */
    snapshotState: () => ({ pendingLength: pending.length, rows: rows.map((r) => [r, copyRow(r)]) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; inFlight = 0;
      rows.length = 0; byId.clear();
      for (const [obj, copy] of state.rows) { restoreInto(obj, copy); rows.push(obj); byId.set(obj.id, obj); }
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
