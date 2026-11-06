/**
 * The mail outbox, the push log and the device push tokens as typed tables with explicit writes (S7c, migration
 * `0011_outbox_push`; explicit since S14d, docs/architecture/migration.md §4.6; sql/03_messaging_safety_audit.sql).
 *
 * Records (the keys every reader sees):
 *   outbox, two sources told apart by `source` in the table and by their keys in the record:
 *     mailer   { id, ts, to, subject, text, transport, delivered }   adapters.mjs createMailer.send: `text` withholds
 *              every one-time code passed as a secret; `delivered` is the provider's answer (true on the dev outbox);
 *     delivery { id, at, channel, to, text, providerMessageId, provider }   m13/delivery.mjs, the local fake
 *              provider's record of an accepted e-mail dispatch (`text` the first 300 characters of the notice).
 *   push log   { id, ts, audience: { kind, id }, title, body, transport }   adapters.mjs createPushSender.send.
 *   push token { kind, refId, token, ts }   POST /push/register: a player's or a guardian's device.
 *
 * Tables: `outbox` (the structural CHECK ties each source to its columns; vocabulary CHECKs for the transport and
 * channel; both sources carry an address), `push_log` (audience kind and transport CHECKs) and `push_tokens` (one row
 * per device token: registering a token another account holds moves it to the new account, so a phone receives
 * only the notices of the account that last signed in on it).
 *
 * WRITES are explicit operations, each joining the open unit of work, the caller's transaction or its own. READS are
 * SQL: no mirror, no db.* view; fresh, frozen records. The admin outbox and push log page by cursor, newest first.
 *
 * Nothing here carries a key: the outbox and push rows outlive the accounts they were addressed to (retention is
 * open, Q6). Refusals name tables, ids and fields, never an address, a mail text or a token.
 */
import { transaction, migrationApplied } from './database.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const OUTBOX_PUSH_MIGRATION = '0011_outbox_push';
export const OUTBOX_PUSH_TABLES = Object.freeze(['outbox', 'push_log', 'push_tokens']);
export const MAIL_TRANSPORTS = Object.freeze(['sendgrid', 'dev-outbox']);
export const DELIVERY_PROVIDER = 'local-fake';
export const PUSH_TRANSPORTS = Object.freeze(['expo', 'dev-log']);
export const PUSH_AUDIENCE_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
/** Who may register a device: the Player app's two kinds of account. */
export const PUSH_TOKEN_KINDS = Object.freeze(['player', 'guardian']);
export const OUTBOX_LIMITS = Object.freeze({ id: 80, address: 320, subject: 300, text: 10000, deliveryText: 300, providerMessageId: 80, title: 100, body: 4000, token: 200 });
const L = OUTBOX_LIMITS;
const list = (v) => v.map((x) => `'${x}'`).join(', ');
const len = (c, max, min = 1) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

export const OUTBOX_PUSH_DDL = `
CREATE TABLE outbox (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE ${len('id', L.id)},
  source              TEXT NOT NULL CHECK (source IN ('mailer', 'delivery')),
  created_at          INTEGER NOT NULL,
  to_address          TEXT NOT NULL ${len('to_address', L.address)},
  subject             TEXT ${len('subject', L.subject, 0)},
  text                TEXT NOT NULL ${len('text', L.text, 0)},
  transport           TEXT NOT NULL CHECK (transport IN (${list([...MAIL_TRANSPORTS, DELIVERY_PROVIDER])})),
  delivered           INTEGER,
  channel             TEXT CHECK (channel IS NULL OR channel = 'email'),
  provider_message_id TEXT ${len('provider_message_id', L.providerMessageId)},
  CHECK ((source = 'mailer' AND subject IS NOT NULL AND delivered IS NOT NULL AND delivered IN (0, 1) AND channel IS NULL AND provider_message_id IS NULL AND transport IN (${list(MAIL_TRANSPORTS)}))
      OR (source = 'delivery' AND subject IS NULL AND delivered IS NULL AND channel IS NOT NULL AND provider_message_id IS NOT NULL AND transport = '${DELIVERY_PROVIDER}' AND length(text) <= ${L.deliveryText}))
) STRICT;
CREATE TABLE push_log (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE ${len('id', L.id)},
  created_at    INTEGER NOT NULL,
  audience_kind TEXT NOT NULL CHECK (audience_kind IN (${list(PUSH_AUDIENCE_KINDS)})),
  audience_id   TEXT NOT NULL ${len('audience_id', L.id)},
  title         TEXT NOT NULL ${len('title', L.title)},
  body          TEXT NOT NULL ${len('body', L.body, 0)},
  transport     TEXT NOT NULL CHECK (transport IN (${list(PUSH_TRANSPORTS)}))
) STRICT;
CREATE TABLE push_tokens (
  seq           INTEGER PRIMARY KEY,
  ref_kind      TEXT NOT NULL CHECK (ref_kind IN (${list(PUSH_TOKEN_KINDS)})),
  ref_id        TEXT NOT NULL ${len('ref_id', L.id)},
  token         TEXT NOT NULL UNIQUE ${len('token', L.token)},
  registered_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_tokens_ref ON push_tokens (ref_kind, ref_id);`;

export const outboxPushLive = (sqlite) => migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION);
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const blocked = (detail, extra = {}) => refusal('OUTBOX_PUSH_IMPORT_BLOCKED', `${detail}; nothing was written`, extra);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const text = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max;

// ------------------------------------------------------------------ typing (no coercion; a refusal names the field)
export const MAILER_KEYS = Object.freeze(['id', 'ts', 'to', 'subject', 'text', 'transport', 'delivered']);
export const DELIVERY_KEYS = Object.freeze(['id', 'at', 'channel', 'to', 'text', 'providerMessageId', 'provider']);
export const PUSH_LOG_KEYS = Object.freeze(['id', 'ts', 'audience', 'title', 'body', 'transport']);
export const PUSH_TOKEN_KEYS = Object.freeze(['kind', 'refId', 'token', 'ts']);
const keysProblem = (raw, keys, what) => {
  if (!isPlainObject(raw)) return `${what} must be an object (got ${describe(raw)})`;
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  if (unknown.length) return `${what} carries unknown field(s) ${unknown.join(', ')}`;
  const missing = keys.filter((k) => !Object.hasOwn(raw, k));
  return missing.length ? `${what} lacks ${missing.join(', ')}` : null;
};
const ok = (row) => ({ ok: true, row });
const no = (reason) => ({ ok: false, reason });

/** Type one outbox record (either source, told apart by its keys): `{ ok, row, source }` or `{ ok: false, reason }`. */
export function typeOutbox(raw) {
  const source = isPlainObject(raw) && Object.hasOwn(raw, 'providerMessageId') ? 'delivery' : 'mailer';
  const p = keysProblem(raw, source === 'mailer' ? MAILER_KEYS : DELIVERY_KEYS, `an outbox ${source} record`); if (p) return no(p);
  const at = `outbox ${typeof raw.id === 'string' ? raw.id : '(no id)'}`;
  if (!text(raw.id, L.id)) return no(`id must be text of 1 to ${L.id} characters`);
  if (!text(raw.to, L.address)) return no(`${at}: to must be an address of 1 to ${L.address} characters`);
  if (source === 'mailer') {
    if (!isInt(raw.ts)) return no(`${at}: ts must be an integer timestamp`);
    if (!text(raw.subject, L.subject, 0)) return no(`${at}: subject must be text of at most ${L.subject} characters`);
    if (!text(raw.text, L.text, 0)) return no(`${at}: text must be text of at most ${L.text} characters`);
    if (!MAIL_TRANSPORTS.includes(raw.transport)) return no(`${at}: transport must be one of ${MAIL_TRANSPORTS.join(', ')}`);
    if (typeof raw.delivered !== 'boolean') return no(`${at}: delivered must be a boolean`);
    return { ...ok({ id: raw.id, ts: raw.ts, to: raw.to, subject: raw.subject, text: raw.text, transport: raw.transport, delivered: raw.delivered }), source };
  }
  if (!isInt(raw.at)) return no(`${at}: at must be an integer timestamp`);
  if (raw.channel !== 'email') return no(`${at}: channel must be email`);
  if (!text(raw.text, L.deliveryText, 0)) return no(`${at}: text must be text of at most ${L.deliveryText} characters`);
  if (!text(raw.providerMessageId, L.providerMessageId)) return no(`${at}: providerMessageId must be text of 1 to ${L.providerMessageId} characters`);
  if (raw.provider !== DELIVERY_PROVIDER) return no(`${at}: provider must be ${DELIVERY_PROVIDER}`);
  return { ...ok({ id: raw.id, at: raw.at, channel: raw.channel, to: raw.to, text: raw.text, providerMessageId: raw.providerMessageId, provider: raw.provider }), source };
}
export function typePushLog(raw) {
  const p = keysProblem(raw, PUSH_LOG_KEYS, 'a push log record'); if (p) return no(p);
  const at = `push log ${typeof raw.id === 'string' ? raw.id : '(no id)'}`;
  if (!text(raw.id, L.id)) return no(`id must be text of 1 to ${L.id} characters`);
  if (!isInt(raw.ts)) return no(`${at}: ts must be an integer timestamp`);
  if (keysProblem(raw.audience, ['kind', 'id'], 'audience') || !PUSH_AUDIENCE_KINDS.includes(raw.audience.kind) || !text(raw.audience.id, L.id)) return no(`${at}: audience must be { kind: ${PUSH_AUDIENCE_KINDS.join(' | ')}, id }`);
  if (!text(raw.title, L.title)) return no(`${at}: title must be text of 1 to ${L.title} characters`);
  if (!text(raw.body, L.body, 0)) return no(`${at}: body must be text of at most ${L.body} characters`);
  if (!PUSH_TRANSPORTS.includes(raw.transport)) return no(`${at}: transport must be one of ${PUSH_TRANSPORTS.join(', ')}`);
  return ok({ id: raw.id, ts: raw.ts, audience: { kind: raw.audience.kind, id: raw.audience.id }, title: raw.title, body: raw.body, transport: raw.transport });
}
export function typePushToken(raw) {
  const p = keysProblem(raw, PUSH_TOKEN_KEYS, 'a device token registration'); if (p) return no(p);
  if (!PUSH_TOKEN_KINDS.includes(raw.kind)) return no(`kind must be one of ${PUSH_TOKEN_KINDS.join(', ')}`);
  if (!text(raw.refId, L.id)) return no(`refId must be text of 1 to ${L.id} characters`);
  if (!text(raw.token, L.token)) return no(`token must be text of 1 to ${L.token} characters`);
  if (!isInt(raw.ts)) return no('ts must be an integer timestamp');
  return ok({ kind: raw.kind, refId: raw.refId, token: raw.token, ts: raw.ts });
}

// ------------------------------------------------------------------ rows ↔ the tables
const OUTBOX_INSERT = 'INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id) VALUES (@id, @source, @created_at, @to_address, @subject, @text, @transport, @delivered, @channel, @provider_message_id)';
const PUSH_INSERT = 'INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (@id, @created_at, @audience_kind, @audience_id, @title, @body, @transport)';
const TOKEN_UPSERT = 'INSERT INTO push_tokens (ref_kind, ref_id, token, registered_at) VALUES (@ref_kind, @ref_id, @token, @registered_at) ON CONFLICT (token) DO UPDATE SET ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, registered_at = excluded.registered_at';
const outboxParams = (row, source) => (source === 'mailer'
  ? { id: row.id, source, created_at: row.ts, to_address: row.to, subject: row.subject, text: row.text, transport: row.transport, delivered: row.delivered ? 1 : 0, channel: null, provider_message_id: null }
  : { id: row.id, source, created_at: row.at, to_address: row.to, subject: null, text: row.text, transport: row.provider, delivered: null, channel: row.channel, provider_message_id: row.providerMessageId });
const outboxFromDb = (r) => Object.freeze(r.source === 'mailer'
  ? { id: r.id, ts: r.created_at, to: r.to_address, subject: r.subject, text: r.text, transport: r.transport, delivered: r.delivered === 1 }
  : { id: r.id, at: r.created_at, channel: r.channel, to: r.to_address, text: r.text, providerMessageId: r.provider_message_id, provider: r.transport });
const pushParams = (row) => ({ id: row.id, created_at: row.ts, audience_kind: row.audience.kind, audience_id: row.audience.id, title: row.title, body: row.body, transport: row.transport });
const pushFromDb = (r) => Object.freeze({ id: r.id, ts: r.created_at, audience: Object.freeze({ kind: r.audience_kind, id: r.audience_id }), title: r.title, body: r.body, transport: r.transport });
const tokenParams = (row) => ({ ref_kind: row.kind, ref_id: row.refId, token: row.token, registered_at: row.ts });
const tokenFromDb = (r) => Object.freeze({ kind: r.ref_kind, refId: r.ref_id, token: r.token, ts: r.registered_at });

/**
 * Whole-table access for snapshot mode (tools, fixtures, the persistence suites): one entry per collection. `read`
 * returns its records in insertion order; `replace` types every entry (an unknown field or a wrong-typed value
 * refuses the whole write, naming the entry) and rewrites the table inside the caller's transaction. Both decline
 * before the 0011 record.
 */
const snapshotTable = (name, table, type, insert, fromDb, { unique }) => ({
  name,
  read(sqlite) { return outboxPushLive(sqlite) ? sqlite.prepare(`SELECT * FROM ${table} ORDER BY seq`).all().map(fromDb) : null; },
  replace(sqlite, rows) {
    if (!outboxPushLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error(`${name}: replace() runs inside the caller's transaction`);
    if (!Array.isArray(rows)) throw blocked(`the ${name} snapshot collection must be an array (got ${describe(rows)})`);
    const typed = []; const seen = new Set(); const problems = [];
    rows.forEach((raw, i) => {
      const v = type(raw);
      const key = v.ok ? unique(v.row) : null;
      if (!v.ok) problems.push(`entry #${i}: ${v.reason}`);
      else if (seen.has(key)) problems.push(`entry #${i}: duplicates an earlier entry's ${name === 'pushTokens' ? 'token' : `id ${key}`}`);
      else { seen.add(key); typed.push(v); }
    });
    if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} in the ${name} snapshot collection — ${problems.slice(0, 20).join('; ')}`, { problems });
    sqlite.exec(`DELETE FROM ${table};`);
    const ins = sqlite.prepare(insert);
    for (const v of typed) ins.run(v.source ? outboxParams(v.row, v.source) : table === 'push_log' ? pushParams(v.row) : tokenParams(v.row));
    return true;
  },
});
export const OUTBOX_TABLE = snapshotTable('outbox', 'outbox', typeOutbox, OUTBOX_INSERT, outboxFromDb, { unique: (r) => r.id });
export const PUSH_LOG_TABLE = snapshotTable('pushLog', 'push_log', typePushLog, PUSH_INSERT, pushFromDb, { unique: (r) => r.id });
export const PUSH_TOKENS_TABLE = snapshotTable('pushTokens', 'push_tokens', typePushToken, TOKEN_UPSERT, tokenFromDb, { unique: (r) => r.token });
export const OUTBOX_PUSH_SNAPSHOT_TABLES = Object.freeze([OUTBOX_TABLE, PUSH_LOG_TABLE, PUSH_TOKENS_TABLE]);
export const OUTBOX_PUSH_COLLECTIONS = Object.freeze(OUTBOX_PUSH_SNAPSHOT_TABLES.map((t) => t.name));

// ------------------------------------------------------------------ the repository
/** `createOutboxPushRepository({ sqlite, unit, now, log })`: `{ outbox, pushLog, pushTokens }`, each with its writes and queries. */
export function createOutboxPushRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the outbox/push repository needs a SQLite connection (node:sqlite); these records have no in-memory fallback');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const count = (table) => q(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  /** A page of a table, newest first by seq: `{ items, nextCursor }`. */
  const newestPage = (table, fromDb, { after = null, limit }) => {
    const rows = q(`SELECT * FROM ${table} WHERE (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`).all(after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.seq]);
    return { items: page.items.map(fromDb), nextCursor: page.nextCursor };
  };
  const invalid = (what, v) => { if (!v.ok) throw refusal('OUTBOX_RECORD_INVALID', `${what}: ${v.reason}`); return v; };
  const outboxById = (id) => { const r = typeof id === 'string' ? q('SELECT * FROM outbox WHERE id = ?').get(id) : null; return r ? outboxFromDb(r) : null; };

  const repo = {
    outbox: {
      /** A new record (the mailer's or the delivery centre's). Refuses an unknown field, a wrong-typed value or a duplicate id. Returns the stored record. */
      append: (raw) => operation(() => {
        const v = invalid('an outbox record', typeOutbox(raw));
        if (outboxById(v.row.id)) throw refusal('OUTBOX_DUPLICATE', `outbox ${v.row.id} already exists`);
        q(OUTBOX_INSERT).run(outboxParams(v.row, v.source));
        return outboxById(v.row.id);
      }),
      /** The live transport's answer on a mailer record. Returns the stored record. */
      markDelivered: (id, delivered) => operation(() => {
        if (typeof delivered !== 'boolean') throw new TypeError('outbox: delivered is a boolean');
        const r = q('SELECT source FROM outbox WHERE id = ?').get(id);
        if (!r) throw refusal('OUTBOX_NOT_FOUND', `outbox ${id} is not a record of the repository`);
        if (r.source !== 'mailer') throw refusal('OUTBOX_RECORD_INVALID', `outbox ${id} is a delivery record; only a mailer record carries a delivered flag`);
        q('UPDATE outbox SET delivered = ? WHERE id = ?').run(delivered ? 1 : 0, id);
        return outboxById(id);
      }),
      byId: outboxById,
      page: (page) => newestPage('outbox', outboxFromDb, page),
      count: () => count('outbox'),
    },
    pushLog: {
      /** A new record, in the sender's literal. Returns the stored record. */
      append: (raw) => operation(() => {
        const v = invalid('a push log record', typePushLog(raw));
        if (q('SELECT 1 FROM push_log WHERE id = ?').get(v.row.id)) throw refusal('OUTBOX_DUPLICATE', `push_log ${v.row.id} already exists`);
        q(PUSH_INSERT).run(pushParams(v.row));
        return pushFromDb(q('SELECT * FROM push_log WHERE id = ?').get(v.row.id));
      }),
      page: (page) => newestPage('push_log', pushFromDb, page),
      count: () => count('push_log'),
    },
    pushTokens: {
      /**
       * A device token for a player or a guardian. A token another account holds moves to this one; the same
       * account registering it again updates its time. Returns `{ moved, row }`.
       */
      register: (raw) => operation(() => {
        const v = invalid('a device token registration', typePushToken(raw));
        const held = q('SELECT ref_kind, ref_id FROM push_tokens WHERE token = ?').get(v.row.token);
        q(TOKEN_UPSERT).run(tokenParams(v.row));
        return { moved: !!held && (held.ref_kind !== v.row.kind || held.ref_id !== v.row.refId), row: tokenFromDb(q('SELECT * FROM push_tokens WHERE token = ?').get(v.row.token)) };
      }),
      /** The device tokens registered to this account, oldest registration first. */
      forAudience: (kind, id) => q('SELECT * FROM push_tokens WHERE ref_kind = ? AND ref_id = ? ORDER BY registered_at, seq').all(kind, id).map(tokenFromDb),
      count: () => count('push_tokens'),
    },
    counts: () => ({ outbox: count('outbox'), pushLog: count('push_log'), pushTokens: count('push_tokens') }),
    pending: () => 0,
    attach() {
      if (!outboxPushLive(sqlite)) throw new Error(`the outbox/push repository needs ${OUTBOX_PUSH_MIGRATION} recorded`);
      const c = repo.counts();
      log(`outbox/push: ${c.outbox} outbox record(s), ${c.pushLog} push log record(s) and ${c.pushTokens} device token(s) in the tables`);
      return { engine: 'sqlite', ...c };
    },
    now,
  };
  return repo;
}
