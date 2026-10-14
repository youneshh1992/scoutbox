/**
 * Notifications and category notification preferences — migration plan step
 * S7a (docs/architecture/s7-readiness-review.md §3, §5–§8; the four
 * compatibility corrections of the S7a review).
 *
 * Owns three tables and the read-only views `db.notifications` and
 * `db.notificationPrefs`:
 *
 *   notifications                 the in-app feed, one row per notification
 *   notification_prefs            one row per person who ever saved a preference
 *   notification_pref_categories  the categories that person set (absent key = default)
 *
 * THE ORDERING KEY. The feed every reader expects is reverse INSERTION order,
 * not timestamp order: coalescing refreshes a row's `ts` and counts the repeat
 * without moving the row (server.mjs notify, since M18.1). `seq INTEGER
 * PRIMARY KEY` is that order, durable: assigned at insert, preserved by the
 * migration (array position), by every backup and restore (array position in
 * the exported collection) and by the rollback (rows written back in `seq`
 * order). The feed is `ORDER BY seq DESC`; `occurred_at` is never an ordering key.
 *
 * COALESCING is the pre-S7a reverse scan, unchanged, over the in-memory mirror
 * (which IS the insertion order): newest first, a stop at the first row older
 * than the six-hour cutoff — whatever lies before it is never examined, even a
 * matching row whose clock was refreshed — read rows skipped, same audience,
 * type, text and refId. Exactly six hours old is included. Only the row that
 * scan selects coalesces. The repository's `findCoalescible` is that scan;
 * scripts/testNotifications.mjs proves it differentially against the verbatim
 * pre-S7a code.
 *
 * THE MIRROR. The repository keeps every row in memory (the array behind
 * `db.notifications`, loaded once from the table in `seq` order) and keeps it
 * current on every mutation, so reads cost what they cost before S7a and the
 * coalescing scan is the same loop over the same array. Rows are plain objects
 * in the shape every reader expects ({ id, ts, audience, type, text, refId,
 * read, repeatCount, groupKey, category, deferredPush[, actionRequired] });
 * fields a row carried that this repository does not know are kept in
 * `extra_json` and spread back onto the row.
 *
 * TWO WRITE MODES.
 *   immediate (tools, tests, the migration; `staged: false`): every mutation
 *     runs through one boundary — joined inside an open unit of work through
 *     the store's participant API (a failure poisons the unit even when the
 *     caller catches it), as part of a raw transaction a tool opened on the
 *     connection (no BEGIN of its own), in a transaction of its own otherwise.
 *   staged (the running server; `staged: true`, registered as a save hook):
 *     a mutation updates the mirror at once and queues its SQL; the queue runs
 *     inside the NEXT snapshot save transaction — an ordinary save, a
 *     persistNow, or a unit of work's commit — before the blob rows are
 *     written, so a notification is durable TOGETHER WITH the blob edits made
 *     alongside it (the message it announces, the request it reports) and
 *     never ahead of them. Inside an open unit the mutation still joins the
 *     unit (a refused argument poisons it) and its SQL runs in the unit's
 *     commit; on a rollback the mirror and the queue return to the state they
 *     had when the unit began, writes queued BEFORE the unit stay queued. A
 *     foreign transaction the repository did not open is refused in this mode
 *     (its outcome could never be reported back to the queue). The queue is
 *     FIFO and drained whole at every flush, so the order of the file is the
 *     order of memory. This is a deliberate reading of "own transaction when
 *     standalone" for a server whose ~170 notify() call sites edit blobs saved
 *     later: the transaction a standalone notification belongs to is the save
 *     that carries those blobs (S7a review, §3.2 as corrected).
 *
 * EFFECTS WAIT FOR THE DURABLE WRITE (review of ba6956d, finding 1). A write
 * usually has external effects — the push, the `notify` event on the live
 * streams and in the replay log — and those must not happen before the state
 * they announce is committed. `afterDurable(fn)` registers an effect for the
 * writes queued so far; in staged mode it is held in a second FIFO queue,
 * bounded by the same save that carries the writes, and is run only when the
 * store reports that save's COMMIT: never before the save, never after a
 * failed flush or a failed COMMIT (the write and its effects stay queued for
 * the retry, which delivers them exactly once), discarded with a rolled-back
 * unit of work (effects of writes queued BEFORE the unit survive and run when
 * the next save or unit commits them, in order). Each effect is run through
 * `runEffect` (the store's `afterCommit`: counted, logged, never thrown into
 * the save — a provider error after COMMIT is a delivery failure, never a
 * database rollback, and never a replay of the batch). An effect never
 * schedules a save of its own. This is a durability boundary, not an
 * exactly-once guarantee: a crash between COMMIT and the effect loses the
 * push/event, exactly as it did before S7a. In immediate mode a standalone
 * write is durable when the operation returns (its own transaction), so
 * `afterDurable` hands the effect to `runEffect` at once; inside an open unit
 * of work — in EITHER mode, whatever `runEffect` is (review of 7655bae,
 * finding 1) — the effect is queued through the joined boundary and run only
 * when the registered save hook reports the unit's COMMIT, discarded with its
 * rollback; a caller-owned raw transaction is refused (the repository could
 * not see its outcome).
 *
 * PARTICIPANT PRECONDITIONS ARE PARTICIPANT FAILURES (review of 7655bae,
 * finding 2). While a unit of work is open, every precondition this
 * repository checks before a write or an effect — the save hook taken for
 * registration, the argument shape — is checked INSIDE `unit.join`, so a
 * refusal poisons the unit even when the caller catches it: the unit's other
 * edits can never commit around a notification that was refused.
 *
 * OWNED TRANSACTION FAILURE RESTORES MEMORY (finding 2). An immediate-mode
 * operation that runs in a transaction of its own takes a snapshot of the
 * mirror first and restores it in place — rows, the id index, preference
 * records, every read-only view a caller holds — when the transaction fails,
 * at a statement or at COMMIT itself, so memory never shows a row the file
 * refused and the same id can be retried. A joined unit restores through the
 * store's rollback, which is why a repository given the participant API
 * refuses to join a unit until its `saveHook()` was taken for registration
 * (without the hook the unit's rollback could not reach the mirror). Only a
 * caller-owned raw transaction keeps the explicit `reload()` contract.
 *
 * UNKNOWN DATA IS NEVER LOST SILENTLY (finding 3). Fields this repository does
 * not know are copied as own data properties (`Object.defineProperty`, never
 * assignment: an own "__proto__" key of legacy JSON is data, and assignment
 * would rewrite the prototype and drop it) at validation, storage, read,
 * export, snapshot and rollback. Nested objects whose shape the schema maps
 * to columns (the audience, the acknowledgment contract, a category map)
 * refuse unknown fields — the whole migration or snapshot write, before any
 * row is written or any blob retired — because a field dropped there would be
 * lost without a trace.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0009_notifications` in `data_migrations`, never by the tables existing or
 * by row counts. Preferences are retained when a person's notifications are
 * deleted (no cascade: a decision recorded in the readiness review). The
 * audience is polymorphic (no foreign key, any non-empty kind: the reports
 * path writes a `system` audience today and must keep importing). A stored
 * mandatory category `false` is accepted at storage (the route accepts numeric
 * zero and stores it; a legacy row may hold it) and forced ON by the effective
 * view and the gate in m182/notificationPrefs.mjs — nothing is rewritten.
 *
 * Snapshot format (backups, restores, the persistence suites): the legacy
 * shapes exactly, one entry per row / per person, in insertion order. An entry
 * the validators below refuse — and they coerce nothing — refuses the whole
 * write (a save, the migration) with NOTIFICATIONS_IMPORT_BLOCKED, naming the
 * entry index and the reason and NEVER the text. Normalisations are the ones
 * the pre-S7a snapshot migrations applied or the literal always set:
 * repeatCount absent → 1 (m182_005), read absent → false, groupKey / category
 * absent → null, deferredPush absent → false; each is counted in the cutover
 * record. Logs carry counts, never a text or a preference.
 */
import crypto from 'node:crypto';
import { readonlyView } from './readonly.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { CATEGORY_NAMES } from '../m182/notificationPrefs.mjs';

export const NOTIFICATIONS_MIGRATION = '0009_notifications';
/** `meta` key holding the cutover record: counts only, never data. */
export const NOTIFICATIONS_CUTOVER_META = 'notificationsCutover';
export const NOTIFICATION_TABLES = Object.freeze(['notifications', 'notification_prefs', 'notification_pref_categories']);
/** How long an identical UNREAD notification stays coalescible (M18.1; server.mjs NOTIFY_COALESCE_MS before S7a). */
export const NOTIFY_COALESCE_MS = 6 * 60 * 60 * 1000;

export const NOTIFICATIONS_DDL = `
CREATE TABLE notifications (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE,
  occurred_at        INTEGER NOT NULL,
  audience_kind      TEXT NOT NULL,
  audience_id        TEXT NOT NULL,
  type               TEXT NOT NULL,
  text               TEXT NOT NULL,
  ref_id             TEXT,
  read               INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  repeat_count       INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  group_key          TEXT,
  category           TEXT,
  deferred_push      INTEGER NOT NULL DEFAULT 0 CHECK (deferred_push IN (0,1)),
  action_required    INTEGER NOT NULL DEFAULT 0 CHECK (action_required IN (0,1)),
  action_deadline_at INTEGER,
  action_acked_at    INTEGER,
  action_acked_by    TEXT,
  extra_json         TEXT CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object')),
  CHECK (action_required = 1 OR (action_deadline_at IS NULL AND action_acked_at IS NULL AND action_acked_by IS NULL))
) STRICT;
CREATE INDEX notifications_audience_seq ON notifications (audience_kind, audience_id, seq);
CREATE TABLE notification_prefs (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  email_intent  INTEGER NOT NULL DEFAULT 0 CHECK (email_intent IN (0,1)),
  updated_at    INTEGER,
  PRIMARY KEY (audience_kind, audience_id)
) STRICT;
CREATE TABLE notification_pref_categories (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  category      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  PRIMARY KEY (audience_kind, audience_id, category),
  FOREIGN KEY (audience_kind, audience_id) REFERENCES notification_prefs(audience_kind, audience_id) ON DELETE CASCADE
) STRICT;`;

export const notificationsLive = (sqlite) => migrationApplied(sqlite, NOTIFICATIONS_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`NOTIFICATIONS_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'NOTIFICATIONS_IMPORT_BLOCKED', ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const isCategory = (k) => Object.hasOwn(CATEGORIES_SET, k);
const CATEGORIES_SET = Object.freeze(Object.fromEntries(CATEGORY_NAMES.map((k) => [k, true])));
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
/** Set an own data property — never `obj[k] = v`, which for an own "__proto__" key of parsed JSON would rewrite the prototype and lose the field. */
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });

// ------------------------------------------------------------------ validation (no coercion; every refusal names the reason, never the text)
const KNOWN_KEYS = Object.freeze(['id', 'ts', 'audience', 'type', 'text', 'refId', 'read', 'repeatCount', 'groupKey', 'category', 'deferredPush', 'actionRequired']);
const ACTION_KEYS = Object.freeze(['deadline', 'ackedAt', 'ackedBy']);
const AUDIENCE_KEYS = Object.freeze(['kind', 'id']);
/** Validate one audience ({ kind, id }, both non-empty strings, nothing else: the two columns are all the schema keeps; the kind is open — polymorphic, no foreign key). */
function audienceOf(raw, field = 'audience') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object { kind, id } (got ${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !AUDIENCE_KEYS.includes(k));
  if (unknown.length) return { reason: `${field} carries unknown field(s) ${unknown.join(', ')} (the schema keeps an audience as kind and id only; a field dropped here would be lost)` };
  if (!nonEmpty(raw.kind)) return { reason: `${field}.kind must be a non-empty string` };
  if (!nonEmpty(raw.id)) return { reason: `${field}.id must be a non-empty string` };
  return { audience: { kind: raw.kind, id: raw.id } };
}
function actionOf(raw) {
  if (raw === undefined || raw === null) return { action: null };
  if (!isPlainObject(raw)) return { reason: `actionRequired must be an object { deadline, ackedAt, ackedBy } or null (got ${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !ACTION_KEYS.includes(k));
  if (unknown.length) return { reason: `actionRequired carries unknown field(s) ${unknown.join(', ')}` };
  const deadline = raw.deadline === undefined ? null : raw.deadline;
  if (deadline !== null && !isInt(deadline)) return { reason: 'actionRequired.deadline must be an integer timestamp or null' };
  const ackedAt = raw.ackedAt === undefined ? null : raw.ackedAt;
  if (ackedAt !== null && !isInt(ackedAt)) return { reason: 'actionRequired.ackedAt must be an integer timestamp or null' };
  const ackedBy = raw.ackedBy === undefined ? null : raw.ackedBy;
  if (ackedBy !== null && typeof ackedBy !== 'string') return { reason: 'actionRequired.ackedBy must be a string or null' };
  return { action: { deadline, ackedAt, ackedBy } };
}
/** Validate one exported notification: `{ ok: true, row, normalised: [...names] }` or `{ ok: false, reason }`. The row is the mirror shape. */
export function validateNotificationRow(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!isInt(raw.ts) || raw.ts < 0) return { ok: false, reason: 'ts must be a non-negative integer timestamp' };
  const a = audienceOf(raw.audience); if (a.reason) return { ok: false, reason: a.reason };
  if (!nonEmpty(raw.type)) return { ok: false, reason: 'type must be a non-empty string' };
  if (typeof raw.text !== 'string') return { ok: false, reason: 'text must be a string' };
  const refId = raw.refId === undefined ? null : raw.refId;
  if (refId !== null && typeof refId !== 'string') return { ok: false, reason: 'refId must be a string, null or absent' };
  const normalised = [];
  let read = raw.read; if (read === undefined) { read = false; normalised.push('read'); } else if (typeof read !== 'boolean') return { ok: false, reason: 'read must be a boolean' };
  let repeatCount = raw.repeatCount; if (repeatCount === undefined) { repeatCount = 1; normalised.push('repeatCount'); } else if (!isInt(repeatCount) || repeatCount < 1) return { ok: false, reason: 'repeatCount must be an integer of at least 1' };
  let groupKey = raw.groupKey; if (groupKey === undefined) { groupKey = null; normalised.push('groupKey'); } else if (groupKey !== null && typeof groupKey !== 'string') return { ok: false, reason: 'groupKey must be a string, null or absent' };
  let category = raw.category; if (category === undefined) { category = null; normalised.push('category'); } else if (category !== null && (typeof category !== 'string' || !isCategory(category))) return { ok: false, reason: `category ${typeof category === 'string' ? category : describe(category)} is not a notification category` };
  let deferredPush = raw.deferredPush; if (deferredPush === undefined) { deferredPush = false; normalised.push('deferredPush'); } else if (typeof deferredPush !== 'boolean') return { ok: false, reason: 'deferredPush must be a boolean' };
  const act = actionOf(raw.actionRequired); if (act.reason) return { ok: false, reason: act.reason };
  const extra = {};
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.includes(k)) setOwn(extra, k, raw[k]);
  try { JSON.stringify(extra); } catch { return { ok: false, reason: 'an unknown field cannot be serialised' }; }
  const row = { ...extra, id: raw.id, ts: raw.ts, audience: a.audience, type: raw.type, text: raw.text, refId, read, repeatCount, groupKey, category, deferredPush };
  if (act.action) row.actionRequired = act.action;
  return { ok: true, row, normalised, hasExtra: Object.keys(extra).length > 0 };
}
/** Validate a whole exported notifications collection; throws NOTIFICATIONS_IMPORT_BLOCKED (entries and reasons, never a text). Returns `{ rows, normalised, withExtraFields, withActionRequired }`. */
export function validateNotificationRows(rows, { label = 'the notifications collection' } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const ids = new Set();
  const normalised = { read: 0, repeatCount: 0, groupKey: 0, category: 0, deferredPush: 0 }; let withExtraFields = 0; let withActionRequired = 0;
  rows.forEach((raw, i) => {
    const v = validateNotificationRow(raw);
    if (!v.ok) { problems.push(`entry #${i}: ${v.reason}`); return; }
    if (ids.has(v.row.id)) { problems.push(`entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; }
    ids.add(v.row.id); for (const n of v.normalised) normalised[n] += 1; if (v.hasExtra) withExtraFields += 1; if (v.row.actionRequired) withActionRequired += 1;
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  return { rows: out, normalised, withExtraFields, withActionRequired };
}

const PREF_KEYS = Object.freeze(['audienceKind', 'audienceId', 'categories', 'emailIntent', 'updatedAt']);
/** Validate one category map (own keys only, every key a category, every value a boolean). Returns `{ categories }` or `{ reason }`. */
function categoriesOf(raw, field = 'categories') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object of category → boolean (got ${describe(raw)})` };
  const categories = {};
  for (const k of Object.keys(raw)) {
    if (!isCategory(k)) return { reason: `${field}.${k} is not a notification category` };
    if (typeof raw[k] !== 'boolean') return { reason: `${field}.${k} must be a boolean (got ${describe(raw[k])})` };
    categories[k] = raw[k];
  }
  return { categories };
}
/** Validate one exported preference record: `{ ok: true, row, normalised }` or `{ ok: false, reason }`. */
export function validateNotificationPrefsRow(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !PREF_KEYS.includes(k));
  if (unknown.length) return { ok: false, reason: `unknown field(s) ${unknown.join(', ')}` };
  if (!nonEmpty(raw.audienceKind)) return { ok: false, reason: 'audienceKind must be a non-empty string' };
  if (!nonEmpty(raw.audienceId)) return { ok: false, reason: 'audienceId must be a non-empty string' };
  const c = categoriesOf(raw.categories === undefined ? {} : raw.categories); if (c.reason) return { ok: false, reason: c.reason };
  const normalised = [];
  let emailIntent = raw.emailIntent; if (emailIntent === undefined) { emailIntent = false; normalised.push('emailIntent'); } else if (typeof emailIntent !== 'boolean') return { ok: false, reason: 'emailIntent must be a boolean' };
  let updatedAt = raw.updatedAt; if (updatedAt === undefined) { updatedAt = null; normalised.push('updatedAt'); } else if (updatedAt !== null && !isInt(updatedAt)) return { ok: false, reason: 'updatedAt must be an integer timestamp, null or absent' };
  return { ok: true, row: { audienceKind: raw.audienceKind, audienceId: raw.audienceId, categories: c.categories, emailIntent, updatedAt }, normalised };
}
/** Validate a whole exported preferences collection; throws NOTIFICATIONS_IMPORT_BLOCKED. Returns `{ rows, categories, normalised }`. */
export function validateNotificationPrefsRows(rows, { label = 'the notificationPrefs collection' } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const seen = new Set(); const normalised = { emailIntent: 0, updatedAt: 0 }; let categories = 0;
  rows.forEach((raw, i) => {
    const v = validateNotificationPrefsRow(raw);
    if (!v.ok) { problems.push(`entry #${i}: ${v.reason}`); return; }
    const key = `${v.row.audienceKind}\u0000${v.row.audienceId}`;
    if (seen.has(key)) { problems.push(`entry #${i}: a second entry for ${v.row.audienceKind} ${v.row.audienceId} (one record per person)`); return; }
    seen.add(key); for (const n of v.normalised) normalised[n] += 1; categories += Object.keys(v.row.categories).length;
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in ${label} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  return { rows: out, categories, normalised };
}

// ------------------------------------------------------------------ rows ↔ the table
const SELECT = 'SELECT seq, id, occurred_at, audience_kind, audience_id, type, text, ref_id, read, repeat_count, group_key, category, deferred_push, action_required, action_deadline_at, action_acked_at, action_acked_by, extra_json FROM notifications';
const INSERT = 'INSERT INTO notifications (id, occurred_at, audience_kind, audience_id, type, text, ref_id, read, repeat_count, group_key, category, deferred_push, action_required, action_deadline_at, action_acked_at, action_acked_by, extra_json) VALUES (@id, @occurred_at, @audience_kind, @audience_id, @type, @text, @ref_id, @read, @repeat_count, @group_key, @category, @deferred_push, @action_required, @action_deadline_at, @action_acked_at, @action_acked_by, @extra_json)';
/** The mirror row for a table row. */
function rowFromDb(r) {
  const extra = r.extra_json ? JSON.parse(r.extra_json) : {};
  const row = { ...extra, id: r.id, ts: r.occurred_at, audience: { kind: r.audience_kind, id: r.audience_id }, type: r.type, text: r.text, refId: r.ref_id, read: r.read === 1, repeatCount: r.repeat_count, groupKey: r.group_key, category: r.category, deferredPush: r.deferred_push === 1 };
  if (r.action_required === 1) row.actionRequired = { deadline: r.action_deadline_at, ackedAt: r.action_acked_at, ackedBy: r.action_acked_by };
  return row;
}
/** The insert parameters for a mirror row. */
function rowParams(row) {
  const extra = {}; for (const k of Object.keys(row)) if (!KNOWN_KEYS.includes(k)) setOwn(extra, k, row[k]);
  const a = row.actionRequired ?? null;
  return {
    id: row.id, occurred_at: row.ts, audience_kind: row.audience.kind, audience_id: row.audience.id, type: row.type, text: row.text, ref_id: row.refId, read: row.read ? 1 : 0, repeat_count: row.repeatCount,
    group_key: row.groupKey, category: row.category, deferred_push: row.deferredPush ? 1 : 0, action_required: a ? 1 : 0, action_deadline_at: a ? a.deadline : null, action_acked_at: a ? a.ackedAt : null, action_acked_by: a ? a.ackedBy : null,
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}
/** A plain copy of a mirror row (the export / snapshot shape; nothing shared with the mirror). */
const copyRow = (row) => { const c = { ...row, audience: { ...row.audience } }; if (row.actionRequired) c.actionRequired = { ...row.actionRequired }; return c; };
const copyPref = (p) => ({ audienceKind: p.audienceKind, audienceId: p.audienceId, categories: { ...p.categories }, emailIntent: p.emailIntent, updatedAt: p.updatedAt });
const prefKey = (kind, id) => `${kind}\u0000${id}`;

function readRows(sqlite) { return sqlite.prepare(`${SELECT} ORDER BY seq`).all().map(rowFromDb); }
function readPrefs(sqlite) {
  const out = []; const by = new Map();
  for (const r of sqlite.prepare('SELECT audience_kind, audience_id, email_intent, updated_at FROM notification_prefs ORDER BY rowid').all()) {
    const p = { audienceKind: r.audience_kind, audienceId: r.audience_id, categories: {}, emailIntent: r.email_intent === 1, updatedAt: r.updated_at };
    out.push(p); by.set(prefKey(p.audienceKind, p.audienceId), p);
  }
  for (const r of sqlite.prepare('SELECT audience_kind, audience_id, category, enabled FROM notification_pref_categories ORDER BY rowid').all()) by.get(prefKey(r.audience_kind, r.audience_id)).categories[r.category] = r.enabled === 1;
  return out;
}
function writeRows(sqlite, rows) {
  sqlite.exec('DELETE FROM notifications');
  const ins = sqlite.prepare(INSERT);
  for (const r of rows) ins.run(rowParams(r));
  return rows.length;
}
function writePrefs(sqlite, rows) {
  sqlite.exec('DELETE FROM notification_prefs'); // the categories cascade
  const parent = sqlite.prepare('INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES (?, ?, ?, ?)');
  const cat = sqlite.prepare('INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES (?, ?, ?, ?)');
  for (const p of rows) {
    parent.run(p.audienceKind, p.audienceId, p.emailIntent ? 1 : 0, p.updatedAt);
    for (const [k, v] of Object.entries(p.categories)) cat.run(p.audienceKind, p.audienceId, k, v ? 1 : 0);
  }
  return rows.length;
}

/**
 * Whole-table access for the tools that treat the file as one snapshot
 * (backups, restores, the persistence suites). Before the cutover record both
 * methods decline (`null` / `false`): the caller keeps the legacy blob, which
 * the migration imports on the next boot. Afterwards `read` returns the rows in
 * the legacy shape, in insertion order, and `replace` validates every entry,
 * rewrites the table inside the caller's transaction (array position → seq)
 * and refuses the whole write on the first problem.
 */
export const NOTIFICATIONS_TABLE = {
  name: 'notifications',
  read(sqlite) { if (!notificationsLive(sqlite)) return null; return readRows(sqlite); },
  replace(sqlite, rows) {
    if (!notificationsLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('notifications: replace() runs inside the caller\'s transaction');
    writeRows(sqlite, validateNotificationRows(rows).rows);
    return true;
  },
};
export const NOTIFICATION_PREFS_TABLE = {
  name: 'notificationPrefs',
  read(sqlite) { if (!notificationsLive(sqlite)) return null; return readPrefs(sqlite); },
  replace(sqlite, rows) {
    if (!notificationsLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('notification preferences: replace() runs inside the caller\'s transaction');
    writePrefs(sqlite, validateNotificationPrefsRows(rows).rows);
    return true;
  },
};

/**
 * Import the legacy (or exported) blobs into the tables, inside the migration's
 * transaction: validation of every entry, insertion in array order, the blob
 * rows retired. Returns the counts the migration records in `meta`.
 */
export function importNotificationBlobs(sqlite) {
  const counts = { notifications: { imported: 0, normalised: { read: 0, repeatCount: 0, groupKey: 0, category: 0, deferredPush: 0 }, withExtraFields: 0, withActionRequired: 0 }, notificationPrefs: { imported: 0, categories: 0, normalised: { emailIntent: 0, updatedAt: 0 } } };
  const hasCollections = tableExists(sqlite, 'collections');
  const readBlob = (name) => {
    const row = hasCollections ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null;
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); }
  };
  const notifications = readBlob('notifications');
  if (notifications !== undefined) {
    const v = validateNotificationRows(notifications, { label: 'the notifications blob' });
    writeRows(sqlite, v.rows);
    counts.notifications = { imported: v.rows.length, normalised: v.normalised, withExtraFields: v.withExtraFields, withActionRequired: v.withActionRequired };
  }
  const prefs = readBlob('notificationPrefs');
  if (prefs !== undefined) {
    const v = validateNotificationPrefsRows(prefs, { label: 'the notificationPrefs blob' });
    writePrefs(sqlite, v.rows);
    counts.notificationPrefs = { imported: v.rows.length, categories: v.categories, normalised: v.normalised };
  }
  if (hasCollections) sqlite.prepare("DELETE FROM collections WHERE name IN ('notifications', 'notificationPrefs')").run();
  return counts;
}

// ------------------------------------------------------------------ the repository
const defaultNextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

/** Run one effect without a store: it never throws into the caller; a failure (thrown or rejected) is reported through `warn`. */
const bareEffectRunner = (warn) => (fn) => {
  const failed = (err) => warn(`notifications: an effect failed after the write was durable (the write stands): ${String(err?.message ?? err).slice(0, 200)}`);
  let result; try { result = fn(); } catch (err) { failed(err); return; }
  if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') Promise.resolve(result).then(undefined, failed);
};

/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a
 * tool, a test, the migration). `staged` selects the server's write mode (see
 * the header); it needs `unit`, and the store must register `saveHook()` —
 * with `unit` given, no operation joins a unit until `saveHook()` was taken.
 * `runEffect(fn)` runs one durable effect (the store's `afterCommit`: counted,
 * logged, never thrown; a tool without a store gets a runner that reports
 * through `warn`). `nextId(prefix)` mints notification ids (the server's
 * generator; a tool may leave the default).
 */
export function createNotificationsRepository({ sqlite, now = Date.now, nextId = defaultNextId, log = () => {}, warn = () => {}, unit = null, staged = false, runEffect = bareEffectRunner(warn) } = {}) {
  if (!sqlite) throw new TypeError('the notifications repository needs a SQLite connection (node:sqlite); notifications have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the notifications repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the notifications repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  if (typeof runEffect !== 'function') throw new TypeError('runEffect must be a function (the store\'s afterCommit)');
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    insert: sqlite.prepare(INSERT),
    coalesce: sqlite.prepare('UPDATE notifications SET occurred_at = ?, repeat_count = ? WHERE id = ?'),
    action: sqlite.prepare('UPDATE notifications SET action_required = 1, action_deadline_at = ?, action_acked_at = NULL, action_acked_by = NULL WHERE id = ?'),
    ack: sqlite.prepare('UPDATE notifications SET action_acked_at = ?, action_acked_by = ? WHERE id = ?'),
    markRead: sqlite.prepare('UPDATE notifications SET read = 1 WHERE audience_kind = ? AND audience_id = ? AND read = 0'),
    deleteFor: sqlite.prepare('DELETE FROM notifications WHERE audience_kind = ? AND audience_id = ?'),
    prefUpsert: sqlite.prepare('INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id) DO UPDATE SET email_intent = excluded.email_intent, updated_at = excluded.updated_at'),
    catUpsert: sqlite.prepare('INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id, category) DO UPDATE SET enabled = excluded.enabled'),
  };

  // The mirror: every row, in insertion order; every preference record.
  const rows = []; const byId = new Map();
  const prefs = []; const prefsBy = new Map();
  const view = readonlyView(rows, 'a notification');
  const prefsView = readonlyView(prefs, 'a notification preference');
  const load = () => {
    rows.length = 0; byId.clear(); prefs.length = 0; prefsBy.clear();
    if (!notificationsLive(sqlite)) return;
    for (const r of readRows(sqlite)) { rows.push(r); byId.set(r.id, r); }
    for (const p of readPrefs(sqlite)) { prefs.push(p); prefsBy.set(prefKey(p.audienceKind, p.audienceId), p); }
  };
  load();

  // Staged mode: the SQL queue, FIFO, drained whole inside every save
  // transaction; and the effects queue, each entry bound to the writes queued
  // before it (`at` = how many), run when the save that carried them commits.
  const pending = []; let inFlight = 0;
  const effects = [];
  let hookTaken = false; // saveHook() was taken for registration with the store
  const inUnit = () => !!unit?.active?.();
  const hookRefusal = (what) => new Error(`notifications: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the queued statements and how a unit of work's rollback restores this repository's memory`);
  /**
   * The one boundary of every mutation. `fn(exec)` validates, then mutates the
   * mirror and hands each SQL statement to `exec` — run at once in immediate
   * mode, queued in staged mode. Joined inside an open unit in both modes,
   * its preconditions included (refused — as a participant failure — until
   * the save hook was taken). An owned immediate transaction that fails — a
   * statement, or COMMIT itself — restores the mirror in place.
   */
  const operation = (fn) => {
    if (inUnit()) {
      // Every participant precondition runs INSIDE the joined failure boundary
      // (review of 7655bae, finding 2): a refusal here is a participant failure
      // the store records, so a caller that catches it still cannot commit the
      // unit's other edits around the write that never happened.
      return unit.join(() => {
        if (!hookTaken) throw hookRefusal(staged ? 'a staged write inside a unit of work' : 'joining a unit of work');
        return staged ? fn((op) => { pending.push(op); }) : fn((op) => op());
      });
    }
    if (staged) {
      if (!hookTaken) throw hookRefusal('a staged write');
      if (sqlite.isTransaction) throw new Error('notifications: the staged repository cannot take part in a transaction it did not open (the server\'s transactions are units of work or snapshot saves)');
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
      if (k === 'actionRequired' && obj.actionRequired && v) { Object.assign(obj.actionRequired, v); continue; }
      if (k === 'categories' && obj.categories && v) { for (const c of Object.keys(obj.categories)) delete obj.categories[c]; Object.assign(obj.categories, v); continue; }
      setOwn(obj, k, v);
    }
  };

  const repo = {
    view,
    prefsView,
    coalesceMs: NOTIFY_COALESCE_MS,
    /** Boot: refuse to run without the cutover record; (re)load the mirror; report counts (never a text). */
    attach() {
      if (!stmt.cutover.get(NOTIFICATIONS_MIGRATION)) throw new Error(`notifications: the cutover record ${NOTIFICATIONS_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`notifications: ${rows.length} notification(s) and ${prefs.length} preference record(s) loaded from the tables`);
      return { engine: 'sqlite', rows: repo.counts() };
    },
    /**
     * Re-read the mirror from the tables. A tool that ran operations inside a
     * raw transaction of its own and then rolled that transaction back must
     * call this: the repository cannot see a ROLLBACK it did not issue, so until
     * then the mirror shows the statements it ran (immediate mode only; the
     * server's staged mode refuses foreign transactions for this reason).
     */
    reload() { load(); return repo.counts(); },
    count: () => rows.length,
    prefsCount: () => prefs.length,
    counts: () => ({ notifications: rows.length, notificationPrefs: prefs.length }),
    /** Staged writes not yet in a committed save (0 in immediate mode). */
    pending: () => pending.length,
    /** Effects waiting for the save or unit commit that carries their writes (0 outside a unit in immediate mode). */
    pendingEffects: () => effects.length,
    /**
     * Register an external effect of the writes made so far (a push, a live
     * event): see EFFECTS WAIT FOR THE DURABLE WRITE in the header. Inside an
     * open unit of work (either mode) it is queued, through the joined
     * boundary, until the store reports the unit's COMMIT — never run while
     * the unit is active, discarded with its rollback. Staged mode outside a
     * unit queues it until the store reports the carrying save's commit; a
     * failed save keeps it. Immediate mode outside a unit hands it to
     * `runEffect` now (the owned write already committed); refused inside a
     * caller-owned raw transaction.
     */
    afterDurable(fn) {
      if (inUnit()) {
        return unit.join(() => {
          if (typeof fn !== 'function') throw new TypeError('afterDurable needs a function');
          if (!hookTaken) throw hookRefusal('registering an effect inside a unit of work');
          effects.push({ fn, at: pending.length });
        });
      }
      if (typeof fn !== 'function') throw new TypeError('afterDurable needs a function');
      if (staged) {
        if (!hookTaken) throw hookRefusal('registering an effect');
        if (sqlite.isTransaction) throw new Error('notifications: an effect cannot be bound to a transaction the repository did not open');
        effects.push({ fn, at: pending.length });
        return;
      }
      if (sqlite.isTransaction) throw new Error('notifications: an effect inside a caller-owned transaction has no commit to wait for that the repository could see; register it after the caller\'s COMMIT');
      runEffect(fn);
    },

    // ---------------------------------------------------------- reads (the mirror)
    byId: (id) => { const r = byId.get(id); return r ? readonlyView(r, 'a notification') : null; },
    /** The feed: this audience's rows, newest insertion first. */
    forAudience(kind, id) {
      const out = [];
      for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (r.audience.kind === kind && r.audience.id === id) out.push(readonlyView(r, 'a notification')); }
      return out;
    },
    unreadCount(kind, id) { let n = 0; for (const r of rows) if (!r.read && r.audience.kind === kind && r.audience.id === id) n += 1; return n; },
    awaitingAckCount() { let n = 0; for (const r of rows) if (r.actionRequired && !r.actionRequired.ackedAt) n += 1; return n; },
    /**
     * The coalescing scan (see the header): the row an identical unread
     * notification would refresh, or null. A pure read.
     */
    findCoalescible({ audience, type, text, refId = null, at = now() }) {
      const cutoff = at - NOTIFY_COALESCE_MS;
      for (let i = rows.length - 1; i >= 0; i--) {
        const c = rows[i];
        if (c.ts < cutoff) break; // the array is append-ordered: whatever lies before the first old row is never examined
        if (c.read) continue;
        if (c.audience.kind !== audience.kind || c.audience.id !== audience.id) continue;
        if (c.type !== type || c.text !== text || (c.refId ?? null) !== (refId ?? null)) continue;
        return readonlyView(c, 'a notification');
      }
      return null;
    },
    prefsFor(kind, id) { const p = prefsBy.get(prefKey(kind, id)); return p ? readonlyView(p, 'a notification preference') : null; },

    // ---------------------------------------------------------- mutations
    /** A new row at the end of the feed. Returns it (read-only). */
    create({ audience, type, text, refId = null, category = null, deferredPush = false, actionRequired = null, at = now(), id = nextId('ntf') } = {}) {
      return operation((exec) => {
        const a = audienceOf(audience); if (a.reason) throw new TypeError(`a notification needs an audience: ${a.reason}`);
        if (!nonEmpty(type)) throw new TypeError('a notification needs a non-empty type');
        if (typeof text !== 'string') throw new TypeError('a notification needs a text (a string)');
        if (refId !== null && typeof refId !== 'string') throw new TypeError('refId must be a string or null');
        if (category !== null && (typeof category !== 'string' || !isCategory(category))) throw new TypeError('category must be a notification category or null');
        if (typeof deferredPush !== 'boolean') throw new TypeError('deferredPush must be a boolean');
        if (!isInt(at) || at < 0) throw new TypeError('at must be an integer timestamp');
        if (!nonEmpty(id)) throw new TypeError('a notification needs an id'); if (byId.has(id)) throw new Error(`notifications: a row with id ${id} already exists`);
        let action = null;
        if (actionRequired !== null) { if (!isPlainObject(actionRequired)) throw new TypeError('actionRequired must be an object { deadline } or null'); const d = actionRequired.deadline ?? null; if (d !== null && !isInt(d)) throw new TypeError('actionRequired.deadline must be an integer timestamp or null'); action = { deadline: d, ackedAt: null, ackedBy: null }; }
        const row = { id, ts: at, audience: a.audience, type, text, refId, read: false, repeatCount: 1, groupKey: refId ? `${type}:${refId}` : null, category, deferredPush };
        if (action) row.actionRequired = action;
        rows.push(row); byId.set(id, row);
        const params = rowParams(row);
        exec(() => stmt.insert.run(params));
        return readonlyView(row, 'a notification');
      });
    },
    /** Refresh an existing row's clock and count the repeat; with `actionRequired`, (re)set its acknowledgment contract as notifyAction always did. */
    coalesce(id, { at = now(), actionRequired = undefined } = {}) {
      return operation((exec) => {
        const row = byId.get(id); if (!row) throw new Error(`notifications: no row ${id} to coalesce`);
        if (!isInt(at) || at < 0) throw new TypeError('at must be an integer timestamp');
        let action; if (actionRequired !== undefined && actionRequired !== null) { if (!isPlainObject(actionRequired)) throw new TypeError('actionRequired must be an object { deadline } or null'); const d = actionRequired.deadline ?? null; if (d !== null && !isInt(d)) throw new TypeError('actionRequired.deadline must be an integer timestamp or null'); action = { deadline: d, ackedAt: null, ackedBy: null }; }
        row.ts = at; row.repeatCount += 1;
        const count = row.repeatCount;
        exec(() => stmt.coalesce.run(at, count, id));
        if (action) { if (row.actionRequired) Object.assign(row.actionRequired, action); else row.actionRequired = action; const d = action.deadline; exec(() => stmt.action.run(d, id)); }
        return readonlyView(row, 'a notification');
      });
    },
    /**
     * Acknowledge an action notice for its audience: `{ status: 'not_found' }`
     * (no such row for this audience), `{ status: 'no_action' }`, or
     * `{ status: 'ok', ackedAt, already }` (`already` when it had been
     * acknowledged before: nothing changes, the first ack is returned).
     */
    ack(id, audience, { at = now() } = {}) {
      const row = byId.get(id);
      if (!row || !audience || row.audience.kind !== audience.kind || row.audience.id !== audience.id) return { status: 'not_found' };
      if (!row.actionRequired) return { status: 'no_action' };
      if (row.actionRequired.ackedAt) return { status: 'ok', ackedAt: row.actionRequired.ackedAt, already: true };
      return operation((exec) => {
        if (!isInt(at) || at < 0) throw new TypeError('at must be an integer timestamp');
        row.actionRequired.ackedAt = at; row.actionRequired.ackedBy = audience.id;
        const by = audience.id;
        exec(() => stmt.ack.run(at, by, id));
        return { status: 'ok', ackedAt: at, already: false };
      });
    },
    /** Mark every unread row of one audience read. Returns how many changed (0 is a result, not an operation). */
    markRead(kind, id) {
      let n = 0; for (const r of rows) if (!r.read && r.audience.kind === kind && r.audience.id === id) n += 1;
      if (!n) return 0;
      return operation((exec) => {
        for (const r of rows) if (!r.read && r.audience.kind === kind && r.audience.id === id) r.read = true;
        exec(() => stmt.markRead.run(kind, id));
        return n;
      });
    },
    /** Remove every row of one audience (the deletion unit); the person's preferences are retained. Returns how many went. */
    deleteForAudience(kind, id) {
      if (!rows.some((r) => r.audience.kind === kind && r.audience.id === id)) return 0;
      return operation((exec) => {
        let n = 0;
        for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (r.audience.kind === kind && r.audience.id === id) { rows.splice(i, 1); byId.delete(r.id); n += 1; } }
        exec(() => stmt.deleteFor.run(kind, id));
        return n;
      });
    },
    /**
     * Merge a preference write for one person: the categories given are set
     * (the others kept), `emailIntent` when given, `updatedAt` stamped. The
     * values must be booleans and the categories known — the route coerces and
     * refuses before it calls this; a mandatory category may be stored false
     * (the effective view forces it on). Returns the stored record (read-only).
     */
    updatePrefs(kind, id, { categories = {}, emailIntent = undefined } = {}, { at = now() } = {}) {
      return operation((exec) => {
        if (!nonEmpty(kind)) throw new TypeError('a preference record needs an audience kind');
        if (!nonEmpty(id)) throw new TypeError('a preference record needs an audience id');
        const c = categoriesOf(categories); if (c.reason) throw new TypeError(c.reason);
        if (emailIntent !== undefined && typeof emailIntent !== 'boolean') throw new TypeError('emailIntent must be a boolean');
        if (!isInt(at) || at < 0) throw new TypeError('at must be an integer timestamp');
        const key = prefKey(kind, id);
        let p = prefsBy.get(key);
        if (!p) { p = { audienceKind: kind, audienceId: id, categories: {}, emailIntent: false, updatedAt: null }; prefs.push(p); prefsBy.set(key, p); }
        Object.assign(p.categories, c.categories);
        if (emailIntent !== undefined) p.emailIntent = emailIntent;
        p.updatedAt = at;
        const intent = p.emailIntent ? 1 : 0;
        exec(() => stmt.prefUpsert.run(kind, id, intent, at));
        for (const [k, v] of Object.entries(c.categories)) exec(() => stmt.catUpsert.run(kind, id, k, v ? 1 : 0));
        return readonlyView(p, 'a notification preference');
      });
    },

    /** Every row in the legacy export shape, in insertion order (the admin backup; the mirror is the intended state, like every blob collection). */
    exportRows: () => rows.map(copyRow),
    exportPrefs: () => prefs.map(copyPref),

    // ---------------------------------------------------------- the save hook (staged mode)
    /** Inside every save transaction: run the queued statements, in order; they count as committed only once the store reports `commit()`. */
    flush() {
      if (!sqlite.isTransaction) throw new Error('notifications.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      for (const op of pending) op();
      inFlight = pending.length;
      return inFlight;
    },
    /**
     * The store reports COMMIT: the flushed statements leave the queue, and the
     * effects bound to them — those registered after no more than the flushed
     * writes — run now, in order, each through `runEffect` (never thrown into
     * the store; a failure is a delivery failure, the data is committed).
     * Effects bound to writes that were not part of this save stay queued.
     * They are taken off the queue before any runs, so an effect that
     * registers another binds it to the writes of the NEXT save.
     */
    commit() {
      pending.splice(0, inFlight);
      const due = [];
      let i = 0; while (i < effects.length && effects[i].at <= inFlight) i += 1;
      due.push(...effects.splice(0, i));
      for (const e of effects) e.at -= inFlight;
      inFlight = 0;
      for (const e of due) runEffect(e.fn);
    },
    /** The store reports a failed save (flush, blob write or COMMIT): nothing the flush ran exists; the writes and their effects stay queued for the retry. */
    rollback() { inFlight = 0; },
    /** Unit-of-work participation: the mirror rows (by identity, restored in place) and both queue lengths when the unit began. */
    snapshotState: () => ({ pendingLength: pending.length, effectsLength: effects.length, rows: rows.map((r) => [r, copyRow(r)]), prefs: prefs.map((p) => [p, copyPref(p)]) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; effects.length = state.effectsLength; inFlight = 0;
      rows.length = 0; byId.clear();
      for (const [obj, copy] of state.rows) { restoreInto(obj, copy); rows.push(obj); byId.set(obj.id, obj); }
      prefs.length = 0; prefsBy.clear();
      for (const [obj, copy] of state.prefs) { restoreInto(obj, copy); prefs.push(obj); prefsBy.set(prefKey(obj.audienceKind, obj.audienceId), obj); }
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
