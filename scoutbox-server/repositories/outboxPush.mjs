/**
 * The mail outbox, the push log and the device push tokens — migration plan
 * step S7c (docs/architecture/s7-readiness-review.md §10 as corrected by the
 * independent review of 6ca66ba: the push row's existing save scheduling kept,
 * lossless JSON token storage without a uniqueness assumption, a nullable
 * delivery destination).
 *
 * Owns three tables and three read-only views:
 *
 *   outbox       one row per mail handed to a transport      → db.outbox
 *   push_log     one row per push handed to the push sender  → db.pushLog
 *   push_tokens  one row per registered device token         → db.pushTokens
 *
 * WHAT THE ROWS ARE. Three collections every build since M13 wrote as JSON
 * blobs, each by a handful of literal writers:
 *
 *   outbox, TWO shapes told apart structurally (never by a value):
 *     (a) the MAILER record  { id, ts, to, subject, text, transport, delivered }
 *         (adapters.mjs createMailer.send — `text` already withheld of every
 *         `secrets` value, `delivered` a boolean: `!live` at creation, the
 *         provider's synchronous answer afterwards);
 *     (b) the DELIVERY record { id, at, channel, to, text, providerMessageId, provider }
 *         (m13/delivery.mjs fakeSend — `text` the first 300 characters of the
 *         notification text, `to` the dispatch's destination, which an accepted
 *         queued dispatch may hold as NULL: the review of 6ca66ba drove the real
 *         boot sweep over such a row and it wrote `to: null`, so the column is
 *         nullable and the key is preserved as present-and-null).
 *     A shape's keys must ALL be present (every build wrote the whole literal;
 *     nothing is normalised) and none of the other shape's keys may be: an
 *     entry matching both or neither is refused by position. `source` records
 *     which literal a row is, and the structural CHECK below ties each source
 *     to its columns — NULL in a column means "that key is absent in this
 *     shape", never a value, so the way back rebuilds exactly the writer's
 *     literal with exactly its keys in the writer's order.
 *   push_log: the SENDER record { id, ts, audience: { kind, id }, title, body, transport }
 *     (adapters.mjs createPushSender.send), the audience the notification
 *     repository already validated (kind and id, both non-empty strings,
 *     nothing else; the kind is OPEN, as for notifications).
 *   push_tokens: the ROUTE record { kind, refId, token, ts } (POST /push/register).
 *     `token` is ANY JSON value the route accepted — the route checks truthiness
 *     only, and the review of 6ca66ba registered a number, a string, a boolean,
 *     objects and arrays through it — stored LOSSLESSLY as JSON text
 *     (`token_json`, decoded on read into an ordinary value of the same type;
 *     a consumer never sees the encoded string). There is NO uniqueness
 *     constraint: the route's matching rule is JavaScript `===` on the token —
 *     a primitive collapses an earlier row holding the same value of the same
 *     type (424242 and '424242' are different tokens), an object or an array
 *     NEVER matches an existing row (every request body is freshly parsed, so
 *     two structurally equal objects are two rows) — and `register` reproduces
 *     exactly that: primitives by strict equality of value and type (in SQL:
 *     equality of the JSON text, which for primitives is the same relation),
 *     objects and arrays never. Re-registration removes the matching rows and
 *     appends a new one at the end, so the view's order is "last registration
 *     last", as the array's was.
 *
 * Vocabularies are OPEN: `transport`, `provider`, `channel`, `audience.kind`
 * and `kind` are stored as written (the review of 6ca66ba: no new enum
 * restriction; the sender filters staff pushes by 'org_user' while the route
 * registers 'org' — the known mismatch is carried through unchanged, not
 * decided here). Unknown OWN keys on any entry are kept in `extra_json` and
 * spread back FIRST on export (the S7a/S7b convention). UNKNOWN NESTED DATA
 * AND TOKEN DATA ARE DETACHED: a prototype-safe JSON clone at ingress, on
 * export, in every transaction snapshot and on restore (an own "__proto__",
 * "constructor" or "toString" key is data at every depth); a value JSON cannot
 * carry — undefined, a function, a symbol, a bigint, a non-finite number, a
 * class instance — refuses the whole write by name. Cloning does not change
 * the token matching rule: primitives compare by value, and an object token a
 * caller still holds is compared by reference against the mirror's DETACHED
 * copy, i.e. never matches — the rule the route's freshly parsed bodies always
 * had.
 *
 * THE ORDERING KEY. Array position was the only total order (ids are minted by
 * one counter and do not sort as strings; timestamps may tie). `seq INTEGER
 * PRIMARY KEY` is that order, durable: assigned at insert, preserved by the
 * migration (array position), by backup/restore and by the rollback (rows
 * written back in `seq` order). No new externally visible id is minted.
 *
 * WHERE A ROW BECOMES DURABLE (nothing new; the review of 6ca66ba, D1). The
 * server attaches this repository in STAGED mode: a mutation changes the
 * mirror at once and its SQL waits for the next snapshot save, so each row
 * lands in exactly the save that carried its blob entry before S7c — a mailer
 * record with the route's own persistNow() or the debounced save `nextId`
 * schedules; a delivery record with the sweep's persistNow(), together with
 * the dispatch rows and attempts of the same pass; a token with the route's
 * persist(). A push record is written by `createPushSender.send`, which the
 * notification repository runs as an after-durable effect AFTER the save
 * carrying the notification row committed — so the push row is never in that
 * save; the sender's `nextId('push')` calls `persist()`, the existing
 * best-effort debounced save (about two seconds, not a guarantee: a failed
 * save, a crash or event-loop delay still lose or delay it), and the row lands
 * in that later save or in any earlier one (a sweep's persistNow). Nothing here
 * schedules a save, retries a save or reports a row durable before its save
 * committed; the mailer's and the sender's provider calls stay outside every
 * transaction.
 *
 * FAILURE RECOVERY, two different things. An ordinary staged save that fails
 * (at a statement or at the real COMMIT) leaves the mirror as it is and keeps
 * every queued statement for the next save: memory is the intended state,
 * nothing is dropped, the next save by anybody lands it once. An aborted UNIT
 * OF WORK restores the mirror and the queue to the state they had when the unit
 * began (`snapshotState` / `restoreState`), held views included. An owned
 * immediate transaction that fails restores the mirror in place.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0011_outbox_push` in `data_migrations`, never by the tables existing or by
 * row counts. Snapshot format (backups, restores, the persistence suites): the
 * legacy shapes exactly, one entry per row, in insertion order; a snapshot that
 * omits a collection leaves its table alone. An entry the validators refuse
 * refuses the whole write (a save, the migration) with
 * OUTBOX_PUSH_IMPORT_BLOCKED, naming the collection, the entry position, the
 * reason and NEVER an address, a mail text, a token or a code.
 */
import { readonlyView } from './readonly.mjs';
import { migrationApplied, transaction } from './database.mjs';

export const OUTBOX_PUSH_MIGRATION = '0011_outbox_push';
/** `meta` key holding the cutover record: counts only, never data. */
export const OUTBOX_PUSH_CUTOVER_META = 'outboxPushCutover';
export const OUTBOX_PUSH_TABLES = Object.freeze(['outbox', 'push_log', 'push_tokens']);
/** The blob collections the three tables replace, in the order the migration imports them. */
export const OUTBOX_PUSH_COLLECTIONS = Object.freeze(['outbox', 'pushLog', 'pushTokens']);

const EXTRA_CHECK = "CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))";
export const OUTBOX_PUSH_DDL = `
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE,
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT,
  subject             TEXT,
  text                TEXT NOT NULL,
  transport           TEXT NOT NULL,
  delivered           INTEGER,
  channel             TEXT,
  provider_message_id TEXT,
  extra_json          TEXT ${EXTRA_CHECK},
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL)
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL))
) STRICT;
CREATE INDEX outbox_created_at ON outbox (created_at);
CREATE TABLE push_log (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  transport     TEXT NOT NULL,
  extra_json    TEXT ${EXTRA_CHECK}
) STRICT;
CREATE INDEX push_log_created_at ON push_log (created_at);
CREATE INDEX push_log_audience_seq ON push_log (audience_kind, audience_id, seq);
CREATE TABLE push_tokens (
  seq           INTEGER PRIMARY KEY,
  ref_kind      TEXT NOT NULL,
  ref_id        TEXT NOT NULL,
  token_json    TEXT NOT NULL CHECK (json_valid(token_json)),
  registered_at INTEGER NOT NULL,
  extra_json    TEXT ${EXTRA_CHECK}
) STRICT;
CREATE INDEX push_tokens_ref_seq ON push_tokens (ref_kind, ref_id, seq);`;

export const outboxPushLive = (sqlite) => migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`OUTBOX_PUSH_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'OUTBOX_PUSH_IMPORT_BLOCKED', ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const stringOrNull = (v) => v === null || typeof v === 'string';
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
/** Set an own data property — never `obj[k] = v`, which for an own "__proto__" key of parsed JSON would rewrite the prototype and lose the field. */
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
/**
 * A DETACHED, prototype-safe copy of a JSON value: null, booleans, strings,
 * finite numbers, arrays and plain objects, every own key copied with `setOwn`
 * at every depth. Anything JSON cannot carry is refused by name, never dropped
 * or coerced. Returns `{ value }` or `{ reason }`.
 */
export function cloneJson(v, at) {
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
/** JSON.parse with every own key set as data (JSON.parse already creates own keys; `cloneJson` re-copies so a mirror row never shares the parser's object with anything). */
const parseJson = (text, at) => cloneJson(JSON.parse(text), at).value;
/** The type a token value has, for counts (never the value). */
const tokenType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// ------------------------------------------------------------------ validation (no coercion; every refusal names the reason, never an address, a text or a token)
/** The mailer literal's keys, in its order (adapters.mjs createMailer.send). */
export const MAILER_KEYS = Object.freeze(['id', 'ts', 'to', 'subject', 'text', 'transport', 'delivered']);
/** The delivery-centre literal's keys, in its order (m13/delivery.mjs fakeSend). */
export const DELIVERY_KEYS = Object.freeze(['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider']);
/** The push sender literal's keys, in its order (adapters.mjs createPushSender.send). */
export const PUSH_LOG_KEYS = Object.freeze(['id', 'ts', 'audience', 'title', 'body', 'transport']);
/** The registration literal's keys, in its order (POST /push/register). */
export const PUSH_TOKEN_KEYS = Object.freeze(['kind', 'refId', 'token', 'ts']);
const AUDIENCE_KEYS = Object.freeze(['kind', 'id']);
const MAILER_ONLY = MAILER_KEYS.filter((k) => !DELIVERY_KEYS.includes(k));
const DELIVERY_ONLY = DELIVERY_KEYS.filter((k) => !MAILER_KEYS.includes(k));

/** The unknown own keys of `raw` (those outside `known`), each a detached clone: `{ extra, hasExtra }` or `{ reason }`. */
function extrasOf(raw, known) {
  const extra = {};
  for (const k of Object.keys(raw)) if (!known.includes(k)) { const c = cloneJson(raw[k], k); if (c.reason) return { reason: c.reason }; setOwn(extra, k, c.value); }
  return { extra, hasExtra: Object.keys(extra).length > 0 };
}
/** The mirror row: extras first (the export convention), then the literal's keys in the writer's order. */
function assemble(extra, literal) { const row = {}; for (const k of Object.keys(extra)) setOwn(row, k, extra[k]); for (const [k, v] of literal) row[k] = v; return row; }

/** Which outbox literal `raw` is: 'mailer', 'delivery', or a reason. Structural: all of one shape's keys present, none of the other shape's. */
export function outboxSourceOf(raw) {
  if (!isPlainObject(raw)) return { reason: `not an object (${describe(raw)})` };
  const hasMailer = MAILER_ONLY.filter((k) => Object.hasOwn(raw, k)); const hasDelivery = DELIVERY_ONLY.filter((k) => Object.hasOwn(raw, k));
  if (hasMailer.length && hasDelivery.length) return { reason: `matches both outbox shapes (carries ${hasMailer.join(', ')} and ${hasDelivery.join(', ')}); an entry is the mailer record or the delivery record, never both` };
  const shape = hasDelivery.length ? 'delivery' : hasMailer.length ? 'mailer' : null;
  if (!shape) return { reason: 'matches neither outbox shape (neither the mailer record\'s ts/subject/transport/delivered nor the delivery record\'s at/channel/providerMessageId/provider)' };
  const keys = shape === 'mailer' ? MAILER_KEYS : DELIVERY_KEYS;
  for (const k of keys) if (!Object.hasOwn(raw, k)) return { reason: `${k} is absent (the ${shape} record always carries all of ${keys.join(', ')}; nothing is normalised)` };
  return { source: shape };
}
/** Validate one outbox entry: `{ ok: true, row, source, hasExtra }` (the mirror row, a detached copy) or `{ ok: false, reason }`. */
export function validateOutboxRow(raw) {
  const s = outboxSourceOf(raw); if (s.reason) return { ok: false, reason: s.reason };
  if (!nonEmpty(raw.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!stringOrNull(raw.to)) return { ok: false, reason: 'to must be a string or null (a queued dispatch may carry no destination)' };
  if (typeof raw.text !== 'string') return { ok: false, reason: 'text must be a string' };
  const e = extrasOf(raw, s.source === 'mailer' ? MAILER_KEYS : DELIVERY_KEYS); if (e.reason) return { ok: false, reason: e.reason };
  if (s.source === 'mailer') {
    if (!isInt(raw.ts)) return { ok: false, reason: 'ts must be an integer timestamp' };
    if (typeof raw.subject !== 'string') return { ok: false, reason: 'subject must be a string' };
    if (!nonEmpty(raw.transport)) return { ok: false, reason: 'transport must be a non-empty string' };
    if (typeof raw.delivered !== 'boolean') return { ok: false, reason: 'delivered must be a boolean' };
    return { ok: true, source: 'mailer', hasExtra: e.hasExtra, row: assemble(e.extra, [['id', raw.id], ['ts', raw.ts], ['to', raw.to], ['subject', raw.subject], ['text', raw.text], ['transport', raw.transport], ['delivered', raw.delivered]]) };
  }
  if (!isInt(raw.at)) return { ok: false, reason: 'at must be an integer timestamp' };
  if (!nonEmpty(raw.channel)) return { ok: false, reason: 'channel must be a non-empty string' };
  if (!nonEmpty(raw.providerMessageId)) return { ok: false, reason: 'providerMessageId must be a non-empty string' };
  if (!nonEmpty(raw.provider)) return { ok: false, reason: 'provider must be a non-empty string' };
  return { ok: true, source: 'delivery', hasExtra: e.hasExtra, row: assemble(e.extra, [['id', raw.id], ['at', raw.at], ['channel', raw.channel], ['to', raw.to], ['text', raw.text], ['providerMessageId', raw.providerMessageId], ['provider', raw.provider]]) };
}
function audienceOf(raw) {
  if (!isPlainObject(raw)) return { reason: `audience must be an object { kind, id } (got ${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !AUDIENCE_KEYS.includes(k));
  if (unknown.length) return { reason: `audience carries unknown field(s) ${unknown.join(', ')} (the schema keeps an audience as kind and id only; a field dropped here would be lost)` };
  if (!nonEmpty(raw.kind)) return { reason: 'audience.kind must be a non-empty string' };
  if (!nonEmpty(raw.id)) return { reason: 'audience.id must be a non-empty string' };
  return { audience: { kind: raw.kind, id: raw.id } };
}
/** Validate one push-log entry: `{ ok: true, row, hasExtra }` or `{ ok: false, reason }`. */
export function validatePushLogRow(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  for (const k of PUSH_LOG_KEYS) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${k} is absent (the push sender always wrote all of ${PUSH_LOG_KEYS.join(', ')}; nothing is normalised)` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: 'id must be a non-empty string' };
  if (!isInt(raw.ts)) return { ok: false, reason: 'ts must be an integer timestamp' };
  const a = audienceOf(raw.audience); if (a.reason) return { ok: false, reason: a.reason };
  if (typeof raw.title !== 'string') return { ok: false, reason: 'title must be a string' };
  if (typeof raw.body !== 'string') return { ok: false, reason: 'body must be a string' };
  if (!nonEmpty(raw.transport)) return { ok: false, reason: 'transport must be a non-empty string' };
  const e = extrasOf(raw, PUSH_LOG_KEYS); if (e.reason) return { ok: false, reason: e.reason };
  return { ok: true, hasExtra: e.hasExtra, row: assemble(e.extra, [['id', raw.id], ['ts', raw.ts], ['audience', a.audience], ['title', raw.title], ['body', raw.body], ['transport', raw.transport]]) };
}
/** Validate one push-token entry: `{ ok: true, row, hasExtra }` (the token a detached clone of ANY JSON value) or `{ ok: false, reason }`. */
export function validatePushTokenRow(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  for (const k of PUSH_TOKEN_KEYS) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${k} is absent (the registration route always wrote all of ${PUSH_TOKEN_KEYS.join(', ')}; nothing is normalised)` };
  if (!nonEmpty(raw.kind)) return { ok: false, reason: 'kind must be a non-empty string (the session kind)' };
  if (!nonEmpty(raw.refId)) return { ok: false, reason: 'refId must be a non-empty string' };
  const t = cloneJson(raw.token, 'token'); if (t.reason) return { ok: false, reason: t.reason };
  if (!isInt(raw.ts)) return { ok: false, reason: 'ts must be an integer timestamp' };
  const e = extrasOf(raw, PUSH_TOKEN_KEYS); if (e.reason) return { ok: false, reason: e.reason };
  return { ok: true, hasExtra: e.hasExtra, row: assemble(e.extra, [['kind', raw.kind], ['refId', raw.refId], ['token', t.value], ['ts', raw.ts]]) };
}
function validateRows(rows, validate, { label, unique = true, tally }) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const ids = new Set(); const counts = { imported: 0, withExtraFields: 0 };
  rows.forEach((raw, i) => {
    const v = validate(raw);
    if (!v.ok) { problems.push(`${label} entry #${i}: ${v.reason}`); return; }
    if (unique) { if (ids.has(v.row.id)) { problems.push(`${label} entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; } ids.add(v.row.id); }
    if (v.hasExtra) counts.withExtraFields += 1;
    tally?.(counts, v);
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  counts.imported = out.length;
  return { rows: out, counts };
}
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
/** Validate a whole outbox collection; throws OUTBOX_PUSH_IMPORT_BLOCKED. Returns `{ rows, counts: { imported, withExtraFields, bySource } }`. */
export const validateOutboxRows = (rows, { label = 'outbox' } = {}) => validateRows(rows, validateOutboxRow, { label, tally: (c, v) => { c.bySource ??= {}; bump(c.bySource, v.source); } });
/** Validate a whole push-log collection. Returns `{ rows, counts: { imported, withExtraFields, byAudienceKind } }`. */
export const validatePushLogRows = (rows, { label = 'pushLog' } = {}) => validateRows(rows, validatePushLogRow, { label, tally: (c, v) => { c.byAudienceKind ??= {}; bump(c.byAudienceKind, v.row.audience.kind); } });
/** Validate a whole push-token collection (no uniqueness: duplicates are legal). Returns `{ rows, counts: { imported, withExtraFields, byKind, byTokenType } }`. */
export const validatePushTokenRows = (rows, { label = 'pushTokens' } = {}) => validateRows(rows, validatePushTokenRow, { label, unique: false, tally: (c, v) => { c.byKind ??= {}; bump(c.byKind, v.row.kind); c.byTokenType ??= {}; bump(c.byTokenType, tokenType(v.row.token)); } });

// ------------------------------------------------------------------ rows ↔ the tables
const OUTBOX_SELECT = 'SELECT seq, id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id, extra_json FROM outbox';
const OUTBOX_INSERT = 'INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id, extra_json) VALUES (@id, @source, @created_at, @to_address, @subject, @text, @transport, @delivered, @channel, @provider_message_id, @extra_json)';
const PUSH_SELECT = 'SELECT seq, id, created_at, audience_kind, audience_id, title, body, transport, extra_json FROM push_log';
const PUSH_INSERT = 'INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport, extra_json) VALUES (@id, @created_at, @audience_kind, @audience_id, @title, @body, @transport, @extra_json)';
const TOKEN_SELECT = 'SELECT seq, ref_kind, ref_id, token_json, registered_at, extra_json FROM push_tokens';
const TOKEN_INSERT = 'INSERT INTO push_tokens (ref_kind, ref_id, token_json, registered_at, extra_json) VALUES (@ref_kind, @ref_id, @token_json, @registered_at, @extra_json)';
/** The route's filter for a PRIMITIVE token in SQL: the same (kind, refId) and the same JSON text — for primitives, JSON-text equality is strict equality of value and type; objects and arrays are excluded, as `===` never matched them. */
const TOKEN_DELETE_PRIMITIVE = "DELETE FROM push_tokens WHERE ref_kind = ? AND ref_id = ? AND token_json = ? AND json_type(token_json) NOT IN ('object', 'array')";
const extraJsonOf = (row, known) => { const extra = {}; for (const k of Object.keys(row)) if (!known.includes(k)) setOwn(extra, k, cloneJson(row[k], k).value); return Object.keys(extra).length ? JSON.stringify(extra) : null; };
const sourceOfRow = (row) => (Object.hasOwn(row, 'transport') ? 'mailer' : 'delivery');
function outboxParams(row) {
  return sourceOfRow(row) === 'mailer'
    ? { id: row.id, source: 'mailer', created_at: row.ts, to_address: row.to, subject: row.subject, text: row.text, transport: row.transport, delivered: row.delivered ? 1 : 0, channel: null, provider_message_id: null, extra_json: extraJsonOf(row, MAILER_KEYS) }
    : { id: row.id, source: 'delivery', created_at: row.at, to_address: row.to, subject: null, text: row.text, transport: row.provider, delivered: null, channel: row.channel, provider_message_id: row.providerMessageId, extra_json: extraJsonOf(row, DELIVERY_KEYS) };
}
function outboxFromDb(r) {
  const extra = r.extra_json ? parseJson(r.extra_json, 'extra_json') : {};
  return r.source === 'mailer'
    ? assemble(extra, [['id', r.id], ['ts', r.created_at], ['to', r.to_address], ['subject', r.subject], ['text', r.text], ['transport', r.transport], ['delivered', r.delivered === 1]])
    : assemble(extra, [['id', r.id], ['at', r.created_at], ['channel', r.channel], ['to', r.to_address], ['text', r.text], ['providerMessageId', r.provider_message_id], ['provider', r.transport]]);
}
const pushParams = (row) => ({ id: row.id, created_at: row.ts, audience_kind: row.audience.kind, audience_id: row.audience.id, title: row.title, body: row.body, transport: row.transport, extra_json: extraJsonOf(row, PUSH_LOG_KEYS) });
const pushFromDb = (r) => assemble(r.extra_json ? parseJson(r.extra_json, 'extra_json') : {}, [['id', r.id], ['ts', r.created_at], ['audience', { kind: r.audience_kind, id: r.audience_id }], ['title', r.title], ['body', r.body], ['transport', r.transport]]);
const tokenParams = (row) => ({ ref_kind: row.kind, ref_id: row.refId, token_json: JSON.stringify(row.token), registered_at: row.ts, extra_json: extraJsonOf(row, PUSH_TOKEN_KEYS) });
const tokenFromDb = (r) => assemble(r.extra_json ? parseJson(r.extra_json, 'extra_json') : {}, [['kind', r.ref_kind], ['refId', r.ref_id], ['token', parseJson(r.token_json, 'token')], ['ts', r.registered_at]]);

/** A DETACHED copy of a mirror row (the transaction snapshot / export shape: nothing shared with the mirror, nested data cloned). */
const copyRow = (row) => { const c = {}; for (const k of Object.keys(row)) setOwn(c, k, cloneJson(row[k], k).value); return c; };

const readOutbox = (sqlite) => sqlite.prepare(`${OUTBOX_SELECT} ORDER BY seq`).all().map(outboxFromDb);
const readPushLog = (sqlite) => sqlite.prepare(`${PUSH_SELECT} ORDER BY seq`).all().map(pushFromDb);
const readTokens = (sqlite) => sqlite.prepare(`${TOKEN_SELECT} ORDER BY seq`).all().map(tokenFromDb);
function writeOutbox(sqlite, rows) { sqlite.exec('DELETE FROM outbox;'); const ins = sqlite.prepare(OUTBOX_INSERT); for (const r of rows) ins.run(outboxParams(r)); return rows.length; }
function writePushLog(sqlite, rows) { sqlite.exec('DELETE FROM push_log;'); const ins = sqlite.prepare(PUSH_INSERT); for (const r of rows) ins.run(pushParams(r)); return rows.length; }
function writeTokens(sqlite, rows) { sqlite.exec('DELETE FROM push_tokens;'); const ins = sqlite.prepare(TOKEN_INSERT); for (const r of rows) ins.run(tokenParams(r)); return rows.length; }

/**
 * Whole-table access for the tools that treat the file as one snapshot
 * (backups, restores, the persistence suites). Before the cutover record both
 * methods decline (`null` / `false`): the caller keeps the legacy blob, which
 * the migration imports on the next boot. Afterwards `read` returns the rows in
 * the legacy shape, in insertion order, and `replace` validates every entry,
 * rewrites the table inside the caller's transaction (array position → seq) and
 * refuses the whole write on the first problem.
 */
const table = (name, read, write, validate) => ({
  name,
  read(sqlite) { if (!outboxPushLive(sqlite)) return null; return read(sqlite); }, // fresh objects from the file: nothing shared with any mirror
  replace(sqlite, rows) {
    if (!outboxPushLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error(`${name}: replace() runs inside the caller's transaction`);
    write(sqlite, validate(rows, { label: `the ${name} snapshot collection` }).rows);
    return true;
  },
});
export const OUTBOX_TABLE = table('outbox', readOutbox, writeOutbox, validateOutboxRows);
export const PUSH_LOG_TABLE = table('pushLog', readPushLog, writePushLog, validatePushLogRows);
export const PUSH_TOKENS_TABLE = table('pushTokens', readTokens, writeTokens, validatePushTokenRows);
export const OUTBOX_PUSH_SNAPSHOT_TABLES = Object.freeze([OUTBOX_TABLE, PUSH_LOG_TABLE, PUSH_TOKENS_TABLE]);

/**
 * Import the three legacy (or exported) blobs into the tables, inside the
 * migration's transaction: validation of every entry, insertion in array order,
 * the blob rows retired. An absent blob imports nothing; an empty array imports
 * nothing; a non-array or non-JSON blob refuses the step. Returns the counts
 * the migration records in `meta` (never a value).
 */
export function importOutboxPushBlobs(sqlite) {
  const hasCollections = tableExists(sqlite, 'collections');
  const readBlob = (name) => {
    const row = hasCollections ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null;
    if (!row) return undefined;
    try { return JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); }
  };
  const empty = { imported: 0, withExtraFields: 0 };
  const out = { outbox: { ...empty, bySource: {} }, pushLog: { ...empty, byAudienceKind: {} }, pushTokens: { ...empty, byKind: {}, byTokenType: {} } };
  const steps = [['outbox', validateOutboxRows, writeOutbox], ['pushLog', validatePushLogRows, writePushLog], ['pushTokens', validatePushTokenRows, writeTokens]];
  for (const [name, validate, write] of steps) {
    const parsed = readBlob(name);
    if (parsed === undefined) continue;
    const v = validate(parsed, { label: `the ${name} blob` });
    write(sqlite, v.rows);
    out[name] = { ...out[name], ...v.counts };
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
  }
  return out;
}

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a
 * tool, a test, the migration). `staged` selects the server's write mode (see
 * the header); it needs `unit`, and the store must register `saveHook()` —
 * with `unit` given, no operation joins a unit until `saveHook()` was taken.
 * One participant for the three tables: one queue, one snapshot.
 */
export function createOutboxPushRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false } = {}) {
  if (!sqlite) throw new TypeError('the outbox/push repository needs a SQLite connection (node:sqlite); these records have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the outbox/push repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the outbox/push repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    outbox: sqlite.prepare(OUTBOX_INSERT), delivered: sqlite.prepare('UPDATE outbox SET delivered = ? WHERE id = ?'),
    push: sqlite.prepare(PUSH_INSERT),
    token: sqlite.prepare(TOKEN_INSERT), tokenDelete: sqlite.prepare(TOKEN_DELETE_PRIMITIVE),
  };

  // The three mirrors: every row, in insertion order.
  const outboxRows = []; const outboxById = new Map(); const pushRows = []; const tokenRows = [];
  const outboxView = readonlyView(outboxRows, 'a mail outbox record');
  const pushView = readonlyView(pushRows, 'a push log record');
  const tokenView = readonlyView(tokenRows, 'a device push token');
  const load = () => {
    outboxRows.length = 0; outboxById.clear(); pushRows.length = 0; tokenRows.length = 0;
    if (!outboxPushLive(sqlite)) return;
    for (const r of readOutbox(sqlite)) { outboxRows.push(r); outboxById.set(r.id, r); }
    for (const r of readPushLog(sqlite)) pushRows.push(r);
    for (const r of readTokens(sqlite)) tokenRows.push(r);
  };
  load();

  // Staged mode: the SQL queue, FIFO, drained whole inside every save transaction.
  const pending = []; let inFlight = 0;
  let hookTaken = false;
  const inUnit = () => !!unit?.active?.();
  const hookRefusal = (what) => new Error(`outbox/push: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the queued statements and how a unit of work's rollback restores this repository's memory`);
  /** The one boundary of every mutation (repositories/dispatches.mjs `operation`: identical contract). */
  const operation = (fn) => {
    if (inUnit()) {
      return unit.join(() => {
        if (!hookTaken) throw hookRefusal(staged ? 'a staged write inside a unit of work' : 'joining a unit of work');
        return staged ? fn((op) => { pending.push(op); }) : fn((op) => op());
      });
    }
    if (staged) {
      if (!hookTaken) throw hookRefusal('a staged write');
      if (sqlite.isTransaction) throw new Error('outbox/push: the staged repository cannot take part in a transaction it did not open (the server\'s transactions are units of work or snapshot saves)');
      return fn((op) => { pending.push(op); });
    }
    const body = () => fn((op) => op());
    if (sqlite.isTransaction) return body(); // caller-owned: see reload()
    const state = repo.snapshotState();
    try { return transaction(sqlite, body); } catch (err) { repo.restoreState(state); throw err; }
  };
  /** Restore a mirror row IN PLACE from its snapshot copy (held views stay valid); every value a fresh detached clone, never the snapshot's object. */
  const restoreInto = (obj, copy) => {
    for (const k of Object.keys(obj)) if (!Object.hasOwn(copy, k)) delete obj[k];
    for (const k of Object.keys(copy)) setOwn(obj, k, cloneJson(copy[k], k).value);
  };
  const restoreList = (list, entries) => { list.length = 0; for (const [obj, copy] of entries) { restoreInto(obj, copy); list.push(obj); } };

  const repo = {
    /** Boot: refuse to run without the cutover record; (re)load the mirrors; report counts (never a value). */
    attach() {
      if (!stmt.cutover.get(OUTBOX_PUSH_MIGRATION)) throw new Error(`outbox/push: the cutover record ${OUTBOX_PUSH_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`outbox/push: ${outboxRows.length} outbox record(s), ${pushRows.length} push log record(s) and ${tokenRows.length} device token(s) loaded from the tables`);
      return { engine: 'sqlite', outbox: outboxRows.length, pushLog: pushRows.length, pushTokens: tokenRows.length };
    },
    /** Re-read the mirrors from the tables (a tool that rolled back a raw transaction of its own must call this; see the S7a contract). */
    reload() { load(); return outboxRows.length + pushRows.length + tokenRows.length; },
    counts: () => ({ outbox: outboxRows.length, pushLog: pushRows.length, pushTokens: tokenRows.length }),
    /** Staged writes not yet in a committed save (0 in immediate mode). */
    pending: () => pending.length,

    // ---------------------------------------------------------- the mail outbox
    outbox: {
      view: outboxView,
      count: () => outboxRows.length,
      byId: (id) => { const r = outboxById.get(id); return r ? readonlyView(r, 'a mail outbox record') : null; },
      /** A new record at the end, in EITHER literal (validated exactly like an import; a non-JSON value or an unmapped shape refuses). Returns it (read-only). */
      append(raw) {
        return operation((exec) => {
          const v = validateOutboxRow(raw); if (!v.ok) throw new TypeError(`an outbox record needs the mailer or the delivery shape: ${v.reason}`);
          if (outboxById.has(v.row.id)) throw new Error(`outbox: a record with id ${v.row.id} already exists`);
          const row = v.row; outboxRows.push(row); outboxById.set(row.id, row);
          const params = outboxParams(row);
          exec(() => stmt.outbox.run(params));
          return readonlyView(row, 'a mail outbox record');
        });
      },
      /** The live transport's answer on a MAILER record, after its provider call settled (`record.delivered = res.ok` before S7c). Refusals (a missing id, a delivery record, a non-boolean) are raised inside the participant boundary. */
      markDelivered(id, ok) {
        return operation((exec) => {
          const row = outboxById.get(id); if (!row) throw new Error(`outbox: no record ${id} to mark delivered`);
          if (sourceOfRow(row) !== 'mailer') throw new TypeError(`outbox: ${id} is a delivery record; only the mailer record carries a delivered flag`);
          if (typeof ok !== 'boolean') throw new TypeError('delivered must be a boolean');
          row.delivered = ok;
          const stored = ok ? 1 : 0;
          exec(() => stmt.delivered.run(stored, id));
          return readonlyView(row, 'a mail outbox record');
        });
      },
      /** Every record in its legacy shape (extras first, then the writer's keys), in insertion order, detached (the admin backup). */
      exportRows: () => outboxRows.map(copyRow),
    },

    // ---------------------------------------------------------- the push log
    pushLog: {
      view: pushView,
      count: () => pushRows.length,
      /** A new record at the end, in the sender's literal. Returns it (read-only). */
      append(raw) {
        return operation((exec) => {
          const v = validatePushLogRow(raw); if (!v.ok) throw new TypeError(`a push log record needs the sender's shape: ${v.reason}`);
          if (pushRows.some((r) => r.id === v.row.id)) throw new Error(`push log: a record with id ${v.row.id} already exists`);
          const row = v.row; pushRows.push(row);
          const params = pushParams(row);
          exec(() => stmt.push.run(params));
          return readonlyView(row, 'a push log record');
        });
      },
      exportRows: () => pushRows.map(copyRow),
    },

    // ---------------------------------------------------------- the device push tokens
    pushTokens: {
      view: tokenView,
      count: () => tokenRows.length,
      /**
       * The registration route's filter-then-push, exactly: every existing row
       * of the same (kind, refId) whose token `===` the given one goes (a
       * primitive by value and type; an object or an array never — see the
       * header), then the new row is appended at the END with a fresh `seq`.
       * Returns `{ removed, row }` (the row read-only).
       */
      register(raw) {
        return operation((exec) => {
          const v = validatePushTokenRow(raw); if (!v.ok) throw new TypeError(`a device token registration needs { kind, refId, token, ts }: ${v.reason}`);
          const row = v.row;
          const removed = [];
          for (let i = tokenRows.length - 1; i >= 0; i--) { const t = tokenRows[i]; if (t.kind === row.kind && t.refId === row.refId && t.token === raw.token) { removed.unshift(t); tokenRows.splice(i, 1); } }
          tokenRows.push(row);
          const params = tokenParams(row); const del = removed.length ? [row.kind, row.refId, params.token_json] : null;
          exec(() => { if (del) stmt.tokenDelete.run(...del); stmt.token.run(params); });
          return { removed: removed.length, row: readonlyView(row, 'a device push token') };
        });
      },
      /** The sender's filter: every row registered under exactly this (kind, id), in insertion order, each a DETACHED copy whose `token` has the type it was registered with (never the JSON text). */
      forAudience(kind, id) { const out = []; for (const t of tokenRows) if (t.kind === kind && t.refId === id) out.push(copyRow(t)); return out; },
      exportRows: () => tokenRows.map(copyRow),
    },

    // ---------------------------------------------------------- the save hook (staged mode)
    flush() {
      if (!sqlite.isTransaction) throw new Error('outbox/push.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      for (const op of pending) op();
      inFlight = pending.length;
      return inFlight;
    },
    /** The store reports COMMIT: the flushed statements leave the queue. */
    commit() { pending.splice(0, inFlight); inFlight = 0; },
    /** The store reports a failed save: nothing the flush ran exists; the writes stay queued for the next save (memory is the intended state). */
    rollback() { inFlight = 0; },
    /** Unit-of-work participation: the mirror rows (by identity, restored in place) and the queue length when the unit began. */
    snapshotState: () => ({ pendingLength: pending.length, outbox: outboxRows.map((r) => [r, copyRow(r)]), pushLog: pushRows.map((r) => [r, copyRow(r)]), pushTokens: tokenRows.map((r) => [r, copyRow(r)]) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; inFlight = 0;
      restoreList(outboxRows, state.outbox); outboxById.clear(); for (const r of outboxRows) outboxById.set(r.id, r);
      restoreList(pushRows, state.pushLog);
      restoreList(tokenRows, state.pushTokens);
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
