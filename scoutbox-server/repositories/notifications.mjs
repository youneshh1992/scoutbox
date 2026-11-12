/**
 * Notifications and category notification preferences.
 *
 * Record (the keys every reader sees):
 *   { id, ts, audience: { kind, id }, type, text, refId, read, repeatCount, groupKey, category, deferredPush,
 *     dispatchedAt[, actionRequired: { deadline, ackedAt, ackedBy }] }
 *   `groupKey` is worked out (`type:refId` when there is a refId) and `ackedBy` is the audience's id: neither is
 *   stored. `dispatchedAt` is the delivery centre's marker (domains/messaging/delivery.mjs): when it made the notice's dispatches.
 *   Responses use `feedItem` (an allowlist), never the record.
 * Preference record: { audienceKind, audienceId, categories: { [category]: boolean }, emailIntent, updatedAt }.
 *
 * Tables:
 *   notifications                 the feed, one row per notification; `seq` is insertion order, the feed order (a
 *                                 coalesced row keeps its place, so `occurred_at` is never an ordering key)
 *   notification_prefs            one row per person who ever saved a preference
 *   notification_pref_categories  the categories that person set (an absent one is the default)
 * The audience kind is `player`, `guardian` or `org_user`; a staff audience is a RESTRICT key to `org_users` through
 * the generated `staff_id` column (staff are removed softly, so the key never blocks); player and guardian ids carry
 * no key (tolerant: a deleted player's rows go in the deletion unit, their preferences are kept by decision).
 *
 * COALESCING. An identical unread notice (same audience, type, text and refId) whose last occurrence was at most six
 * hours ago is refreshed and counted rather than duplicated (`findCoalescible`, then `coalesce`); the newest such row.
 *
 * Each write joins the open unit of work, the caller's transaction or its own. The push and the live event of a
 * notification are the caller's `store.afterCommit` effects. Records are deep-frozen.
 *
 * Refusals name the table, the id and the field, never a text or a preference.
 */
import { migrationApplied, operationOn } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { CATEGORY_NAMES } from '../domains/platform/notificationPrefs.mjs';

export const NOTIFICATIONS_MIGRATION = '0009_notifications';
export const NOTIFICATION_TABLES = Object.freeze([
  'notifications',
  'notification_prefs',
  'notification_pref_categories',
]);
/** How long an identical UNREAD notification stays coalescible. */
export const NOTIFY_COALESCE_MS = 6 * 60 * 60 * 1000;
export const NOTIFICATION_AUDIENCE_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
export const NOTIFICATION_LIMITS = Object.freeze({ id: 80, type: 80, text: 2000, refId: 200 });
const L = NOTIFICATION_LIMITS;
const list = (v) => v.map((x) => `'${x}'`).join(', ');
const len = (c, max, min = 1) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;
const STAFF =
  "GENERATED ALWAYS AS (CASE WHEN audience_kind = 'org_user' THEN audience_id END) STORED REFERENCES org_users(id) ON DELETE RESTRICT";

export const NOTIFICATIONS_DDL = `
CREATE TABLE notifications (
  seq                INTEGER PRIMARY KEY,
  id                 TEXT NOT NULL UNIQUE ${len('id', L.id)},
  occurred_at        INTEGER NOT NULL,
  audience_kind      TEXT NOT NULL CHECK (audience_kind IN (${list(NOTIFICATION_AUDIENCE_KINDS)})),
  audience_id        TEXT NOT NULL ${len('audience_id', L.id)},
  staff_id           TEXT ${STAFF},
  type               TEXT NOT NULL ${len('type', L.type)},
  text               TEXT NOT NULL ${len('text', L.text)},
  ref_id             TEXT ${len('ref_id', L.refId)},
  read               INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  repeat_count       INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  category           TEXT CHECK (category IS NULL OR category IN (${list(CATEGORY_NAMES)})),
  deferred_push      INTEGER NOT NULL DEFAULT 0 CHECK (deferred_push IN (0, 1)),
  dispatched_at      INTEGER,
  action_required    INTEGER NOT NULL DEFAULT 0 CHECK (action_required IN (0, 1)),
  action_deadline_at INTEGER,
  action_acked_at    INTEGER,
  CHECK (action_required = 1 OR (action_deadline_at IS NULL AND action_acked_at IS NULL))
) STRICT;
CREATE INDEX notifications_audience_seq ON notifications (audience_kind, audience_id, seq);
CREATE INDEX notifications_unread ON notifications (audience_kind, audience_id, type, occurred_at) WHERE read = 0;
CREATE INDEX notifications_staff ON notifications (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX notifications_undispatched ON notifications (seq) WHERE dispatched_at IS NULL;
CREATE INDEX notifications_awaiting_ack ON notifications (seq) WHERE action_required = 1 AND action_acked_at IS NULL;
CREATE TABLE notification_prefs (
  audience_kind TEXT NOT NULL CHECK (audience_kind IN (${list(NOTIFICATION_AUDIENCE_KINDS)})),
  audience_id   TEXT NOT NULL ${len('audience_id', L.id)},
  staff_id      TEXT ${STAFF},
  email_intent  INTEGER NOT NULL DEFAULT 0 CHECK (email_intent IN (0, 1)),
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (audience_kind, audience_id)
) STRICT;
CREATE INDEX notification_prefs_staff ON notification_prefs (staff_id) WHERE staff_id IS NOT NULL;
CREATE TABLE notification_pref_categories (
  audience_kind TEXT NOT NULL,
  audience_id   TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN (${list(CATEGORY_NAMES)})),
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  PRIMARY KEY (audience_kind, audience_id, category),
  FOREIGN KEY (audience_kind, audience_id) REFERENCES notification_prefs(audience_kind, audience_id) ON DELETE CASCADE
) STRICT;`;

export const notificationsLive = (sqlite) => migrationApplied(sqlite, NOTIFICATIONS_MIGRATION);
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isClock = (v) => isInt(v) && v >= 0;
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isCategory = (k) => CATEGORY_NAMES.includes(k);
const unknownOf = (raw, known) => Object.keys(raw).filter((k) => !known.includes(k));
const groupKeyOf = (type, refId) => (refId ? `${type}:${refId}` : null);

// ------------------------------------------------------------------ typing (no coercion; a refusal names the field, never the text)
/** Type an audience `{ kind, id }`: `{ audience }` or `{ reason }`. */
export function audienceOf(raw, field = 'audience') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object { kind, id } (got ${describe(raw)})` };
  const unknown = unknownOf(raw, ['kind', 'id']);
  if (unknown.length) return { reason: `${field} carries unknown field(s) ${unknown.join(', ')}` };
  if (!NOTIFICATION_AUDIENCE_KINDS.includes(raw.kind))
    return { reason: `${field}.kind must be one of ${NOTIFICATION_AUDIENCE_KINDS.join(', ')}` };
  if (!text(raw.id, L.id)) return { reason: `${field}.id must be text of 1 to ${L.id} characters` };
  return { audience: { kind: raw.kind, id: raw.id } };
}
/** An acknowledgment contract given to `create` / `coalesce`: `{ deadline }` (an integer or null). */
function contractOf(raw) {
  if (raw === null || raw === undefined) return { action: null };
  if (!isPlainObject(raw) || unknownOf(raw, ['deadline']).length)
    return { reason: 'actionRequired must be { deadline } or null' };
  const deadline = raw.deadline ?? null;
  if (deadline !== null && !isClock(deadline))
    return { reason: 'actionRequired.deadline must be an integer timestamp or null' };
  return { action: { deadline, ackedAt: null } };
}

/** Type a category map (own keys, every key a category, every value a boolean): `{ categories }` or `{ reason }`. */
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

// ------------------------------------------------------------------ rows ↔ the tables
const COLS =
  'id, occurred_at, audience_kind, audience_id, type, text, ref_id, read, repeat_count, category, deferred_push, dispatched_at, action_required, action_deadline_at, action_acked_at';
const INSERT = `INSERT INTO notifications (${COLS}) VALUES (${COLS.split(', ')
  .map((c) => `@${c}`)
  .join(', ')})`;
const SELECT = `SELECT seq, ${COLS} FROM notifications`;
const rowParams = (r) => ({
  id: r.id,
  occurred_at: r.ts,
  audience_kind: r.audience.kind,
  audience_id: r.audience.id,
  type: r.type,
  text: r.text,
  ref_id: r.refId,
  read: r.read ? 1 : 0,
  repeat_count: r.repeatCount,
  category: r.category,
  deferred_push: r.deferredPush ? 1 : 0,
  dispatched_at: r.dispatchedAt,
  action_required: r.action ? 1 : 0,
  action_deadline_at: r.action ? r.action.deadline : null,
  action_acked_at: r.action ? r.action.ackedAt : null,
});
/** The record for a table row (a plain object; the repository freezes what it hands out). */
function fromDb(r) {
  const row = {
    id: r.id,
    ts: r.occurred_at,
    audience: { kind: r.audience_kind, id: r.audience_id },
    type: r.type,
    text: r.text,
    refId: r.ref_id,
    read: r.read === 1,
    repeatCount: r.repeat_count,
    groupKey: groupKeyOf(r.type, r.ref_id),
    category: r.category,
    deferredPush: r.deferred_push === 1,
    dispatchedAt: r.dispatched_at,
  };
  if (r.action_required === 1)
    row.actionRequired = {
      deadline: r.action_deadline_at,
      ackedAt: r.action_acked_at,
      ackedBy: r.action_acked_at === null ? null : r.audience_id,
    };
  return row;
}
/** What a feed response carries for one record: an allowlist (the delivery marker is the server's). */
export function feedItem(n) {
  const out = {
    id: n.id,
    ts: n.ts,
    audience: { kind: n.audience.kind, id: n.audience.id },
    type: n.type,
    text: n.text,
    refId: n.refId,
    read: n.read,
    repeatCount: n.repeatCount,
    groupKey: n.groupKey,
    category: n.category,
    deferredPush: n.deferredPush,
  };
  if (n.actionRequired)
    out.actionRequired = {
      deadline: n.actionRequired.deadline,
      ackedAt: n.actionRequired.ackedAt,
      ackedBy: n.actionRequired.ackedBy,
    };
  return out;
}
const readRows = (sqlite) => sqlite.prepare(`${SELECT} ORDER BY seq`).all().map(fromDb);
function readPrefs(sqlite) {
  const out = [];
  const by = new Map();
  for (const r of sqlite
    .prepare('SELECT audience_kind, audience_id, email_intent, updated_at FROM notification_prefs ORDER BY rowid')
    .all()) {
    const p = {
      audienceKind: r.audience_kind,
      audienceId: r.audience_id,
      categories: {},
      emailIntent: r.email_intent === 1,
      updatedAt: r.updated_at,
    };
    out.push(p);
    by.set(`${p.audienceKind}\u0000${p.audienceId}`, p);
  }
  for (const r of sqlite
    .prepare('SELECT audience_kind, audience_id, category, enabled FROM notification_pref_categories ORDER BY rowid')
    .all())
    by.get(`${r.audience_kind}\u0000${r.audience_id}`).categories[r.category] = r.enabled === 1;
  return out;
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const NOTIFICATIONS_TABLE = {
  name: 'notifications',
  read(sqlite) {
    return notificationsLive(sqlite) ? readRows(sqlite) : null;
  },
};
export const NOTIFICATION_PREFS_TABLE = {
  name: 'notificationPrefs',
  read(sqlite) {
    return notificationsLive(sqlite) ? readPrefs(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'coalesce', 'ack', 'markRead', 'markDispatched', 'deleteForAudience', 'updatePrefs']);
const defaultNextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;

/** `createNotificationsRepository({ sqlite, unit, now, nextId, log })`: the notifications' writes and queries, plus `reads` (the queries alone). */
export function createNotificationsRepository({
  sqlite,
  unit = null,
  now = Date.now,
  nextId = defaultNextId,
  log = () => {},
} = {}) {
  if (!sqlite)
    throw new TypeError(
      'the notifications repository needs a SQLite connection (node:sqlite); notifications have no in-memory fallback',
    );
  const operation = operationOn(sqlite, unit);
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const dec = (rows) => rows.map((r) => deepFreeze(fromDb(r)));
  const byId = (id) => (typeof id === 'string' ? (dec(q(`${SELECT} WHERE id = ?`).all(id))[0] ?? null) : null);
  const notFound = (id) => refusal('NOTIFICATION_NOT_FOUND', `notifications ${id} is not a record of the repository`);
  const invalid = (reason) => refusal('NOTIFICATION_RECORD_INVALID', reason);
  const prefsFor = (kind, id) => {
    const p = q(
      'SELECT email_intent, updated_at FROM notification_prefs WHERE audience_kind = ? AND audience_id = ?',
    ).get(kind, id);
    if (!p) return null;
    const categories = {};
    for (const c of q(
      'SELECT category, enabled FROM notification_pref_categories WHERE audience_kind = ? AND audience_id = ? ORDER BY rowid',
    ).all(kind, id))
      categories[c.category] = c.enabled === 1;
    return deepFreeze({
      audienceKind: kind,
      audienceId: id,
      categories,
      emailIntent: p.email_intent === 1,
      updatedAt: p.updated_at,
    });
  };
  const staffExists = (audience) =>
    audience.kind !== 'org_user' || !!q('SELECT 1 FROM org_users WHERE id = ?').get(audience.id);

  const repo = {
    coalesceMs: NOTIFY_COALESCE_MS,

    // ---------------------------------------------------------- writes
    /** A new row at the end of the feed. Refuses junk by field and a staff audience that does not exist. Returns the stored record. */
    create: ({
      audience,
      type,
      text: body,
      refId = null,
      category = null,
      deferredPush = false,
      actionRequired = null,
      at = now(),
      id = nextId('ntf'),
    } = {}) =>
      operation(() => {
        const a = audienceOf(audience);
        if (a.reason) throw invalid(`a notification's ${a.reason}`);
        if (!text(type, L.type)) throw invalid(`a notification's type must be text of 1 to ${L.type} characters`);
        if (!text(body, L.text)) throw invalid(`a notification's text must be text of 1 to ${L.text} characters`);
        if (refId !== null && !text(refId, L.refId))
          throw invalid(`a notification's refId must be text of 1 to ${L.refId} characters or null`);
        if (category !== null && !isCategory(category))
          throw invalid("a notification's category must be a notification category or null");
        if (typeof deferredPush !== 'boolean') throw invalid('deferredPush must be a boolean');
        if (!isClock(at)) throw invalid('at must be an integer timestamp');
        if (!text(id, L.id)) throw invalid(`a notification's id must be text of 1 to ${L.id} characters`);
        const c = contractOf(actionRequired);
        if (c.reason) throw invalid(c.reason);
        if (q('SELECT 1 FROM notifications WHERE id = ?').get(id))
          throw refusal('NOTIFICATION_DUPLICATE', `notifications ${id} already exists`);
        if (!staffExists(a.audience))
          throw refusal(
            'NOTIFICATIONS_STAFF_MISSING',
            `notifications ${id}: org_users ${a.audience.id} does not exist`,
          );
        q(INSERT).run(
          rowParams({
            id,
            ts: at,
            audience: a.audience,
            type,
            text: body,
            refId,
            read: false,
            repeatCount: 1,
            category,
            deferredPush,
            dispatchedAt: null,
            action: c.action,
          }),
        );
        return byId(id);
      }),
    /** Refresh a row's clock and count the repeat; with `actionRequired`, (re)set its acknowledgment contract. Returns the stored record. */
    coalesce: (id, { at = now(), actionRequired = null } = {}) =>
      operation(() => {
        if (!isClock(at)) throw invalid('at must be an integer timestamp');
        const c = contractOf(actionRequired);
        if (c.reason) throw invalid(c.reason);
        const { changes } = q(
          'UPDATE notifications SET occurred_at = ?, repeat_count = repeat_count + 1 WHERE id = ?',
        ).run(at, id);
        if (!changes) throw notFound(id);
        if (c.action)
          q(
            'UPDATE notifications SET action_required = 1, action_deadline_at = ?, action_acked_at = NULL WHERE id = ?',
          ).run(c.action.deadline, id);
        return byId(id);
      }),
    /**
     * Acknowledge an action notice for its audience: `{ status: 'not_found' }` (no such row for this audience),
     * `{ status: 'no_action' }`, or `{ status: 'ok', ackedAt, already }` (`already`: the first acknowledgment stands).
     */
    ack: (id, audience, { at = now() } = {}) =>
      operation(() => {
        const n = byId(id);
        if (!n || !audience || n.audience.kind !== audience.kind || n.audience.id !== audience.id)
          return { status: 'not_found' };
        if (!n.actionRequired) return { status: 'no_action' };
        if (n.actionRequired.ackedAt !== null)
          return { status: 'ok', ackedAt: n.actionRequired.ackedAt, already: true };
        if (!isClock(at)) throw invalid('at must be an integer timestamp');
        q('UPDATE notifications SET action_acked_at = ? WHERE id = ?').run(at, id);
        return { status: 'ok', ackedAt: at, already: false };
      }),
    /** Mark every unread row of one audience read. Returns how many changed. */
    markRead: (kind, id) =>
      operation(() =>
        Number(
          q('UPDATE notifications SET read = 1 WHERE audience_kind = ? AND audience_id = ? AND read = 0').run(kind, id)
            .changes,
        ),
      ),
    /** The delivery centre made this notice's dispatches (its sweep, in the same unit). Returns the stored record. */
    markDispatched: (id, { at = now() } = {}) =>
      operation(() => {
        if (!isClock(at)) throw invalid('at must be an integer timestamp');
        if (!q('SELECT 1 FROM notifications WHERE id = ?').get(id)) throw notFound(id);
        q('UPDATE notifications SET dispatched_at = ? WHERE id = ? AND dispatched_at IS NULL').run(at, id);
        return byId(id);
      }),
    /** Remove every row of one audience (the deletion unit); the person's preferences are kept. Returns how many went. */
    deleteForAudience: (kind, id) =>
      operation(() =>
        Number(q('DELETE FROM notifications WHERE audience_kind = ? AND audience_id = ?').run(kind, id).changes),
      ),
    /**
     * Merge a preference write for one person: the categories given are set (the others kept), `emailIntent` when
     * given, `updatedAt` stamped. The values must be booleans and the categories known (the route refuses first).
     * Returns the stored record.
     */
    updatePrefs: (kind, id, { categories = {}, emailIntent = undefined } = {}, { at = now() } = {}) =>
      operation(() => {
        const a = audienceOf({ kind, id });
        if (a.reason) throw invalid(`a preference record's ${a.reason}`);
        const c = categoriesOf(categories);
        if (c.reason) throw invalid(c.reason);
        if (emailIntent !== undefined && typeof emailIntent !== 'boolean')
          throw invalid('emailIntent must be a boolean');
        if (!isClock(at)) throw invalid('at must be an integer timestamp');
        if (!staffExists(a.audience))
          throw refusal('NOTIFICATIONS_STAFF_MISSING', `notification preferences: org_users ${id} does not exist`);
        const intent = emailIntent === undefined ? (prefsFor(kind, id)?.emailIntent ?? false) : emailIntent;
        q(
          'INSERT INTO notification_prefs (audience_kind, audience_id, email_intent, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id) DO UPDATE SET email_intent = excluded.email_intent, updated_at = excluded.updated_at',
        ).run(kind, id, intent ? 1 : 0, at);
        const cat = q(
          'INSERT INTO notification_pref_categories (audience_kind, audience_id, category, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(audience_kind, audience_id, category) DO UPDATE SET enabled = excluded.enabled',
        );
        for (const [k, v] of Object.entries(c.categories)) cat.run(kind, id, k, v ? 1 : 0);
        return prefsFor(kind, id);
      }),

    // ---------------------------------------------------------- reads
    byId,
    /** The feed: this audience's rows, newest insertion first; `limit` caps it (the Agent inbox). */
    forAudience: (kind, id, { limit = null } = {}) =>
      dec(
        limit === null
          ? q(`${SELECT} WHERE audience_kind = ? AND audience_id = ? ORDER BY seq DESC`).all(kind, id)
          : q(`${SELECT} WHERE audience_kind = ? AND audience_id = ? ORDER BY seq DESC LIMIT ?`).all(kind, id, limit),
      ),
    unreadCount: (kind, id) =>
      q('SELECT COUNT(*) AS n FROM notifications WHERE audience_kind = ? AND audience_id = ? AND read = 0').get(
        kind,
        id,
      ).n,
    awaitingAckCount: () =>
      q('SELECT COUNT(*) AS n FROM notifications WHERE action_required = 1 AND action_acked_at IS NULL').get().n,
    /** The row an identical unread notice would refresh (last occurrence at most six hours before `at`), or null. */
    findCoalescible: ({ audience, type, text: body, refId = null, at = now() }) =>
      dec(
        q(
          `${SELECT} WHERE audience_kind = ? AND audience_id = ? AND read = 0 AND type = ? AND occurred_at >= ? AND text = ? AND ref_id IS ? ORDER BY seq DESC LIMIT 1`,
        ).all(audience.kind, audience.id, type, at - NOTIFY_COALESCE_MS, body, refId ?? null),
      )[0] ?? null,
    /** The notices the delivery centre has not made dispatches for yet, in insertion order after `afterSeq`, at most `limit`: `[{ seq, notification }]`. */
    undispatched: ({ afterSeq = 0, limit = 500 } = {}) =>
      q(`${SELECT} WHERE dispatched_at IS NULL AND seq > ? ORDER BY seq LIMIT ?`)
        .all(afterSeq, limit)
        .map((r) => Object.freeze({ seq: r.seq, notification: deepFreeze(fromDb(r)) })),
    prefsFor,
    count: () => q('SELECT COUNT(*) AS n FROM notifications').get().n,
    prefsCount: () => q('SELECT COUNT(*) AS n FROM notification_prefs').get().n,
    counts: () => ({ notifications: repo.count(), notificationPrefs: repo.prefsCount() }),
    pending: () => 0,
    attach() {
      if (!notificationsLive(sqlite))
        throw new Error(`the notifications repository needs ${NOTIFICATIONS_MIGRATION} recorded`);
      const rows = repo.counts();
      log(
        `notifications: ${rows.notifications} notification(s) and ${rows.notificationPrefs} preference record(s) in the tables`,
      );
      return { engine: 'sqlite', rows };
    },
    now,
  };
  repo.reads = Object.freeze(
    Object.fromEntries(
      Object.entries(repo).filter(([k, v]) => typeof v === 'function' && !WRITES.has(k) && k !== 'attach'),
    ),
  );
  return repo;
}
