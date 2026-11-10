/**
 * Delivery dispatches and their attempts (`dispatches`, `dispatch_attempts`).
 *
 * A dispatch is one notification on one channel: every notification gets an `in_app` row (delivered at once) and an
 * `email` row (sent through the provider, skipped, or held for quiet hours). The delivery centre (domains/messaging/delivery.mjs)
 * creates them, records each send and moves them along the status ladder; the provider callback and the
 * acknowledgment move them further. An attempt is a send { at, ok, error } or a quiet-hours re-check note { at, note }
 * (never counted as a send).
 *
 * `org_id` is the staff member's organisation for an `org_user` audience, a deferred RESTRICT key to `orgs`. The
 * notification reference and the audience carry no key: a dispatch outlives its notification after an account
 * deletion (retention is open, Q6 in docs/decisions.md).
 *
 * Refusals name tables, ids and fields, never an address or a provider text.
 */
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const DISPATCHES_MIGRATION = '0010_dispatches';
export const DISPATCH_TABLES = Object.freeze(['dispatches', 'dispatch_attempts']);
/** The collection name (the whole-domain read). */
export const DISPATCHES_COLLECTION = 'dispatches';
export const DISPATCH_CHANNELS = Object.freeze(['in_app', 'email']);
export const DISPATCH_PROVIDERS = Object.freeze(['in_app', 'local-fake']);
/** The ladder (queued/held → accepted → delivered → opened → actioned) and its side states; the RANK lives in domains/messaging/delivery.mjs. */
export const DISPATCH_STATUSES = Object.freeze([
  'queued',
  'held_quiet_hours',
  'accepted',
  'delivered',
  'opened',
  'actioned',
  'skipped',
  'failed',
  'retrying',
]);
export const AUDIENCE_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
export const DISPATCH_LIMITS = Object.freeze({
  id: 80,
  address: 320,
  skipReason: 200,
  providerMessageId: 80,
  failReason: 500,
  note: 200,
  error: 500,
});
const L = DISPATCH_LIMITS;
const list = (v) => v.map((x) => `'${x}'`).join(', ');
const len = (c, max, min = 0) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

export const DISPATCHES_DDL = `
CREATE TABLE dispatches (
  seq                 INTEGER PRIMARY KEY,
  id                  TEXT NOT NULL UNIQUE ${len('id', L.id, 1)},
  notification_id     TEXT NOT NULL ${len('notification_id', L.id, 1)},
  audience_kind       TEXT NOT NULL CHECK (audience_kind IN (${list(AUDIENCE_KINDS)})),
  audience_id         TEXT NOT NULL ${len('audience_id', L.id, 1)},
  org_id              TEXT REFERENCES orgs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  channel             TEXT NOT NULL CHECK (channel IN (${list(DISPATCH_CHANNELS)})),
  to_address          TEXT ${len('to_address', L.address, 1)},
  provider            TEXT NOT NULL CHECK (provider IN (${list(DISPATCH_PROVIDERS)})),
  status              TEXT NOT NULL CHECK (status IN (${list(DISPATCH_STATUSES)})),
  skip_reason         TEXT ${len('skip_reason', L.skipReason, 1)},
  provider_message_id TEXT ${len('provider_message_id', L.providerMessageId, 1)},
  next_at             INTEGER NOT NULL,
  action_deadline_at  INTEGER,
  created_at          INTEGER NOT NULL,
  delivered_at        INTEGER,
  opened_at           INTEGER,
  actioned_at         INTEGER,
  failed_at           INTEGER,
  fail_reason         TEXT ${len('fail_reason', L.failReason, 1)},
  CHECK (org_id IS NULL OR audience_kind = 'org_user'),
  CHECK ((channel = 'in_app') = (provider = 'in_app')),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK (channel <> 'email' OR status = 'skipped' OR to_address IS NOT NULL)
) STRICT;
CREATE INDEX dispatches_notification ON dispatches (notification_id);
CREATE UNIQUE INDEX dispatches_provider_message ON dispatches (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX dispatches_status_next ON dispatches (status, next_at);
CREATE INDEX dispatches_org_seq ON dispatches (org_id, seq) WHERE org_id IS NOT NULL;
CREATE INDEX dispatches_unopened_in_app ON dispatches (seq) WHERE channel = 'in_app' AND opened_at IS NULL;
CREATE TABLE dispatch_attempts (
  dispatch_seq INTEGER NOT NULL REFERENCES dispatches(seq) ON DELETE CASCADE,
  seq          INTEGER NOT NULL CHECK (seq >= 0),
  kind         TEXT NOT NULL CHECK (kind IN ('send', 'quiet_recheck')),
  attempted_at INTEGER NOT NULL,
  ok           INTEGER,
  error        TEXT ${len('error', L.error, 1)},
  note         TEXT ${len('note', L.note, 1)},
  PRIMARY KEY (dispatch_seq, seq),
  CHECK ((kind = 'send' AND ok IS NOT NULL AND ok IN (0, 1) AND note IS NULL)
      OR (kind = 'quiet_recheck' AND ok IS NULL AND error IS NULL AND note IS NOT NULL))
) STRICT;`;

export const dispatchesLive = (sqlite) => migrationApplied(sqlite, DISPATCHES_MIGRATION);
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const textOrNull = (v, max) => v === null || text(v, max);
const intOrNull = (v) => v === null || isInt(v);

// ------------------------------------------------------------------ typing (no coercion; a refusal names the field)
/** The record's keys, in order. */
export const DISPATCH_KEYS = Object.freeze([
  'id',
  'notificationId',
  'audience',
  'orgId',
  'channel',
  'to',
  'provider',
  'status',
  'skipReason',
  'providerMessageId',
  'attempts',
  'nextAt',
  'actionDeadline',
  'createdAt',
  'deliveredAt',
  'openedAt',
  'actionedAt',
  'failedAt',
  'failReason',
]);
/** The fields the sweep, the callback and the acknowledgment change after a row exists; everything else is fixed at creation. */
export const PATCH_KEYS = Object.freeze([
  'status',
  'providerMessageId',
  'nextAt',
  'deliveredAt',
  'openedAt',
  'actionedAt',
  'failedAt',
  'failReason',
]);
const unknownOf = (raw, known) => Object.keys(raw).filter((k) => !known.includes(k));

/** Type one attempt: `{ attempt }` or `{ reason }`. */
export function attemptOf(raw, field = 'attempt') {
  if (!isPlainObject(raw)) return { reason: `${field} must be an object (got ${describe(raw)})` };
  const isNote = Object.hasOwn(raw, 'note');
  const unknown = unknownOf(raw, isNote ? ['at', 'note'] : ['at', 'ok', 'error']);
  if (unknown.length)
    return {
      reason: `${field} carries unknown field(s) ${unknown.join(', ')} (a send is {at, ok, error}, a quiet re-check {at, note})`,
    };
  if (!isInt(raw.at)) return { reason: `${field}.at must be an integer timestamp` };
  if (isNote)
    return text(raw.note, L.note)
      ? { attempt: { at: raw.at, note: raw.note } }
      : { reason: `${field}.note must be text of 1 to ${L.note} characters` };
  if (typeof raw.ok !== 'boolean') return { reason: `${field}.ok must be a boolean` };
  if (!textOrNull(raw.error ?? null, L.error))
    return { reason: `${field}.error must be text of 1 to ${L.error} characters or null` };
  return { attempt: { at: raw.at, ok: raw.ok, error: raw.error ?? null } };
}

/** Check one field the record may change. Returns a reason or null. */
function patchProblem(k, v) {
  switch (k) {
    case 'status':
      return DISPATCH_STATUSES.includes(v) ? null : `status must be one of ${DISPATCH_STATUSES.join(', ')}`;
    case 'providerMessageId':
      return textOrNull(v, L.providerMessageId)
        ? null
        : `providerMessageId must be text of 1 to ${L.providerMessageId} characters or null`;
    case 'nextAt':
      return isInt(v) ? null : 'nextAt must be an integer timestamp';
    case 'failReason':
      return textOrNull(v, L.failReason) ? null : `failReason must be text of 1 to ${L.failReason} characters or null`;
    default:
      return intOrNull(v) ? null : `${k} must be an integer timestamp or null`;
  }
}

/** Type a whole record: `{ ok: true, row }` or `{ ok: false, reason }`. An unknown field is refused. */
export function typeDispatch(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  const unknown = unknownOf(raw, DISPATCH_KEYS);
  if (unknown.length) return { ok: false, reason: `unknown field(s) ${unknown.join(', ')}` };
  const r = {
    orgId: null,
    skipReason: null,
    providerMessageId: null,
    attempts: [],
    actionDeadline: null,
    deliveredAt: null,
    openedAt: null,
    actionedAt: null,
    failedAt: null,
    failReason: null,
    ...raw,
  };
  const at = `dispatch ${typeof r.id === 'string' ? r.id : '(no id)'}`;
  if (!text(r.id, L.id)) return { ok: false, reason: `id must be text of 1 to ${L.id} characters` };
  if (!text(r.notificationId, L.id))
    return { ok: false, reason: `${at}: notificationId must be text of 1 to ${L.id} characters` };
  if (
    !isPlainObject(r.audience) ||
    unknownOf(r.audience, ['kind', 'id']).length ||
    !AUDIENCE_KINDS.includes(r.audience.kind) ||
    !text(r.audience.id, L.id)
  )
    return { ok: false, reason: `${at}: audience must be { kind: ${AUDIENCE_KINDS.join(' | ')}, id }` };
  if (r.orgId !== null && (!text(r.orgId, L.id) || r.audience.kind !== 'org_user'))
    return { ok: false, reason: `${at}: orgId is a staff audience's organisation id, or null` };
  if (!DISPATCH_CHANNELS.includes(r.channel))
    return { ok: false, reason: `${at}: channel must be one of ${DISPATCH_CHANNELS.join(', ')}` };
  if (!DISPATCH_PROVIDERS.includes(r.provider) || (r.channel === 'in_app') !== (r.provider === 'in_app'))
    return { ok: false, reason: `${at}: provider must be in_app for the in_app channel and local-fake otherwise` };
  if (!textOrNull(r.to, L.address))
    return { ok: false, reason: `${at}: to must be text of 1 to ${L.address} characters or null` };
  if (!textOrNull(r.skipReason, L.skipReason))
    return { ok: false, reason: `${at}: skipReason must be text of 1 to ${L.skipReason} characters or null` };
  for (const k of PATCH_KEYS) {
    const p = patchProblem(k, r[k]);
    if (p) return { ok: false, reason: `${at}: ${p}` };
  }
  if (!isInt(r.createdAt)) return { ok: false, reason: `${at}: createdAt must be an integer timestamp` };
  if (!intOrNull(r.actionDeadline))
    return { ok: false, reason: `${at}: actionDeadline must be an integer timestamp or null` };
  if ((r.status === 'skipped') !== (r.skipReason !== null))
    return { ok: false, reason: `${at}: a skipped dispatch carries its skipReason, and only a skipped one does` };
  if (r.channel === 'email' && r.status !== 'skipped' && r.to === null)
    return { ok: false, reason: `${at}: an e-mail dispatch that is not skipped needs its address` };
  if (!Array.isArray(r.attempts)) return { ok: false, reason: `${at}: attempts must be an array` };
  const attempts = [];
  for (let i = 0; i < r.attempts.length; i++) {
    const v = attemptOf(r.attempts[i], `${at}: attempts[${i}]`);
    if (v.reason) return { ok: false, reason: v.reason };
    attempts.push(v.attempt);
  }
  const row = {};
  for (const k of DISPATCH_KEYS) row[k] = r[k];
  row.audience = { kind: r.audience.kind, id: r.audience.id };
  row.attempts = attempts;
  return { ok: true, row };
}

// ------------------------------------------------------------------ rows ↔ the tables
const COLS =
  'id, notification_id, audience_kind, audience_id, org_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason';
const INSERT = `INSERT INTO dispatches (${COLS}) VALUES (${COLS.split(', ')
  .map((c) => `@${c}`)
  .join(', ')})`;
const INSERT_ATTEMPT =
  'INSERT INTO dispatch_attempts (dispatch_seq, seq, kind, attempted_at, ok, error, note) VALUES (?, ?, ?, ?, ?, ?, ?)';
const COLUMN = {
  status: 'status',
  providerMessageId: 'provider_message_id',
  nextAt: 'next_at',
  deliveredAt: 'delivered_at',
  openedAt: 'opened_at',
  actionedAt: 'actioned_at',
  failedAt: 'failed_at',
  failReason: 'fail_reason',
};
const rowParams = (r) => ({
  id: r.id,
  notification_id: r.notificationId,
  audience_kind: r.audience.kind,
  audience_id: r.audience.id,
  org_id: r.orgId,
  channel: r.channel,
  to_address: r.to,
  provider: r.provider,
  status: r.status,
  skip_reason: r.skipReason,
  provider_message_id: r.providerMessageId,
  next_at: r.nextAt,
  action_deadline_at: r.actionDeadline,
  created_at: r.createdAt,
  delivered_at: r.deliveredAt,
  opened_at: r.openedAt,
  actioned_at: r.actionedAt,
  failed_at: r.failedAt,
  fail_reason: r.failReason,
});
const attemptParams = (a) =>
  Object.hasOwn(a, 'note') ? ['quiet_recheck', a.at, null, null, a.note] : ['send', a.at, a.ok ? 1 : 0, a.error, null];
const attemptFromDb = (r) =>
  r.kind === 'quiet_recheck'
    ? { at: r.attempted_at, note: r.note }
    : { at: r.attempted_at, ok: r.ok === 1, error: r.error };
const fromDb = (r, attempts) => ({
  id: r.id,
  notificationId: r.notification_id,
  audience: { kind: r.audience_kind, id: r.audience_id },
  orgId: r.org_id,
  channel: r.channel,
  to: r.to_address,
  provider: r.provider,
  status: r.status,
  skipReason: r.skip_reason,
  providerMessageId: r.provider_message_id,
  attempts,
  nextAt: r.next_at,
  actionDeadline: r.action_deadline_at,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
  openedAt: r.opened_at,
  actionedAt: r.actioned_at,
  failedAt: r.failed_at,
  failReason: r.fail_reason,
});
/** Decode table rows with their attempts in one batch. */
function decode(sqlite, rows) {
  const attempts = childRowsOf(
    sqlite,
    'dispatch_attempts',
    'dispatch_seq',
    rows.map((r) => r.seq),
    { order: 'seq' },
  );
  return rows.map((r) => fromDb(r, attempts.all(r.seq).map(attemptFromDb)));
}
function insertDispatch(sqlite, row) {
  const { lastInsertRowid } = sqlite.prepare(INSERT).run(rowParams(row));
  const att = sqlite.prepare(INSERT_ATTEMPT);
  row.attempts.forEach((a, i) => att.run(Number(lastInsertRowid), i, ...attemptParams(a)));
}
const readAll = (sqlite) => decode(sqlite, sqlite.prepare('SELECT * FROM dispatches ORDER BY seq').all());

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const DISPATCHES_TABLE = {
  name: DISPATCHES_COLLECTION,
  read(sqlite) {
    return dispatchesLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'recordAttempt', 'patch']);

/** `createDispatchesRepository({ sqlite, unit, now, log })`: the dispatches' writes and queries, plus `reads` (the queries alone). */
export function createDispatchesRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite)
    throw new TypeError(
      'the dispatches repository needs a SQLite connection (node:sqlite); dispatch records have no in-memory fallback',
    );
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const dec = (rows) => decode(sqlite, rows).map(deepFreeze);
  const one = (sql, ...args) => dec(q(sql).all(...args))[0] ?? null;
  const byId = (id) => (typeof id === 'string' ? one('SELECT * FROM dispatches WHERE id = ?', id) : null);
  const seqOf = (id) => q('SELECT seq FROM dispatches WHERE id = ?').get(id)?.seq;

  const repo = {
    /** A new dispatch (its attempts normally empty). Refuses an unknown field, a wrong-typed value or a duplicate id. Returns the stored record. */
    create: (raw) =>
      operation(() => {
        const v = typeDispatch(raw);
        if (!v.ok) throw refusal('DISPATCH_RECORD_INVALID', v.reason);
        if (seqOf(v.row.id) !== undefined) throw refusal('DISPATCH_DUPLICATE', `dispatches ${v.row.id} already exists`);
        insertDispatch(sqlite, v.row);
        return byId(v.row.id);
      }),
    /** One attempt at the next position: a send `{ at, ok, error }` or a quiet re-check note `{ at, note }`. Returns the stored record. */
    recordAttempt: (id, raw) =>
      operation(() => {
        const seq = seqOf(id);
        if (seq === undefined)
          throw refusal('DISPATCH_NOT_FOUND', `dispatches ${id} is not a record of the repository`);
        const v = attemptOf(raw);
        if (v.reason) throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: ${v.reason}`);
        const position = q('SELECT COALESCE(MAX(seq) + 1, 0) AS p FROM dispatch_attempts WHERE dispatch_seq = ?').get(
          seq,
        ).p;
        q(INSERT_ATTEMPT).run(seq, position, ...attemptParams(v.attempt));
        return byId(id);
      }),
    /** Change the fields that move after creation (PATCH_KEYS), each typed. An unknown field is refused. Returns the stored record. */
    patch: (id, fields) =>
      operation(() => {
        if (!isPlainObject(fields)) throw new TypeError('dispatches: a patch is an object of fields');
        const keys = Object.keys(fields);
        const unknown = keys.filter((k) => !PATCH_KEYS.includes(k));
        if (unknown.length)
          throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: a patch cannot change ${unknown.join(', ')}`);
        for (const k of keys) {
          const p = patchProblem(k, fields[k]);
          if (p) throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: ${p}`);
        }
        if (seqOf(id) === undefined)
          throw refusal('DISPATCH_NOT_FOUND', `dispatches ${id} is not a record of the repository`);
        if (keys.length)
          q(`UPDATE dispatches SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')} WHERE id = ?`).run(
            ...keys.map((k) => fields[k]),
            id,
          );
        return byId(id);
      }),

    byId,
    /** Every dispatch of one notification, in creation order. */
    forNotification: (notificationId) =>
      dec(q('SELECT * FROM dispatches WHERE notification_id = ? ORDER BY seq').all(notificationId)),
    /** The dispatch the provider accepted under this message id, or null. */
    byProviderMessageId: (value) =>
      typeof value === 'string' ? one('SELECT * FROM dispatches WHERE provider_message_id = ?', value) : null,
    /** The external sends due at `at` (queued, retrying or held for quiet hours), in creation order. */
    due: (at) =>
      dec(
        q(
          "SELECT * FROM dispatches WHERE status IN ('queued', 'retrying', 'held_quiet_hours') AND next_at <= ? ORDER BY seq",
        ).all(at),
      ),
    /** The in-app dispatches not yet opened whose notification was read, in creation order (the sweep marks them opened). */
    unopenedInAppRead: () =>
      q(
        "SELECT d.id, d.notification_id, d.status FROM dispatches d JOIN notifications n ON n.id = d.notification_id WHERE d.channel = 'in_app' AND d.opened_at IS NULL AND n.read = 1 ORDER BY d.seq",
      )
        .all()
        .map((r) => Object.freeze({ id: r.id, notificationId: r.notification_id, status: r.status })),
    /** A page of one organisation's staff dispatches, newest first: `{ items, nextCursor }`. */
    pageForOrg: (orgId, { after = null, limit }) => {
      const rows = q(
        'SELECT * FROM dispatches WHERE org_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?',
      ).all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.seq]);
      return { items: dec(page.items), nextCursor: page.nextCursor };
    },
    /** The newest `n` dispatches, newest first (the admin delivery centre). */
    recent: (n) => dec(q('SELECT * FROM dispatches ORDER BY seq DESC LIMIT ?').all(n)),
    countsByStatus: () =>
      Object.fromEntries(
        q('SELECT status, COUNT(*) AS n FROM dispatches GROUP BY status ORDER BY status')
          .all()
          .map((r) => [r.status, r.n]),
      ),
    /** Dispatches waiting on the provider: queued or retrying. */
    backlogCount: () => q("SELECT COUNT(*) AS n FROM dispatches WHERE status IN ('queued', 'retrying')").get().n,
    count: () => q('SELECT COUNT(*) AS n FROM dispatches').get().n,
    attemptCount: () => q('SELECT COUNT(*) AS n FROM dispatch_attempts').get().n,
    pending: () => 0,
    attach() {
      if (!dispatchesLive(sqlite)) throw new Error(`the dispatches repository needs ${DISPATCHES_MIGRATION} recorded`);
      const rows = repo.count();
      const attempts = repo.attemptCount();
      log(`dispatches: ${rows} dispatch(es) with ${attempts} attempt(s) in the tables`);
      return { engine: 'sqlite', rows, attempts };
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
