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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrationApplied, childRowsOf, operationOn, type UnitParticipant } from './database.ts';
import type { DeepReadonly } from '../domains/platform/values.ts';
import { deepFreeze } from '../domains/platform/values.ts';
import { isPlainObject } from './fieldSpecs.ts';
import { readsOf, pageOf } from './identityRules.ts';
import { NOTIFICATION_AUDIENCE_KINDS, type NotificationAudience } from './notifications.ts';

export const DISPATCHES_MIGRATION = '0010_dispatches';
export const DISPATCH_TABLES = Object.freeze(['dispatches', 'dispatch_attempts'] as const);
/** The collection name (the whole-domain read). */
export const DISPATCHES_COLLECTION = 'dispatches';
export const DISPATCH_CHANNELS = Object.freeze(['in_app', 'email'] as const);
export const DISPATCH_PROVIDERS = Object.freeze(['in_app', 'local-fake'] as const);
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
] as const);
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number];
export type DispatchProvider = (typeof DISPATCH_PROVIDERS)[number];
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
/** A dispatch's audience is its notification's. */
const AUDIENCE_KINDS = NOTIFICATION_AUDIENCE_KINDS;
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
const list = (v: readonly string[]) => v.map((x) => `'${x}'`).join(', ');
const len = (c: string, max: number, min = 0) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

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

export const dispatchesLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, DISPATCHES_MIGRATION);

/** A send `{ at, ok, error }` or a quiet-hours re-check note `{ at, note }` (never counted as a send). */
export type DispatchAttempt = { at: number; ok: boolean; error: string | null } | { at: number; note: string };
type DispatchFields = {
  id: string;
  notificationId: string;
  audience: NotificationAudience;
  /** The staff member's organisation, for an `org_user` audience. */
  orgId: string | null;
  channel: DispatchChannel;
  /** The address an e-mail goes to; null for in-app, or a skipped e-mail. */
  to: string | null;
  provider: DispatchProvider;
  status: DispatchStatus;
  skipReason: string | null;
  providerMessageId: string | null;
  attempts: DispatchAttempt[];
  nextAt: number;
  actionDeadline: number | null;
  createdAt: number;
  deliveredAt: number | null;
  openedAt: number | null;
  actionedAt: number | null;
  failedAt: number | null;
  failReason: string | null;
};
/** A dispatch as the repository reads it back, frozen at every level. */
export type Dispatch = DeepReadonly<DispatchFields>;
type Defaulted =
  | 'orgId'
  | 'skipReason'
  | 'providerMessageId'
  | 'attempts'
  | 'actionDeadline'
  | 'deliveredAt'
  | 'openedAt'
  | 'actionedAt'
  | 'failedAt'
  | 'failReason';
/**
 * A new dispatch: absent optional fields are null (attempts empty). Typed when written, so a caller still in
 * JavaScript can pass anything and be refused by field.
 */
export type DispatchInput = Omit<DispatchFields, Defaulted> & Partial<Pick<DispatchFields, Defaulted>>;
/** The fields that move after creation. */
export type DispatchPatch = Partial<
  Pick<
    DispatchFields,
    'status' | 'providerMessageId' | 'nextAt' | 'deliveredAt' | 'openedAt' | 'actionedAt' | 'failedAt' | 'failReason'
  >
>;
type PatchKey = keyof DispatchPatch;

const refusal = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(`${code}: ${message}`), { code });
const describe = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const textOrNull = (v: unknown, max: number): v is string | null => v === null || text(v, max);
const intOrNull = (v: unknown): v is number | null => v === null || isInt(v);
const isOneOf = <T extends string>(vals: readonly T[], v: unknown): v is T => (vals as readonly unknown[]).includes(v);

// ------------------------------------------------------------------ typing (no coercion; a refusal names the field)
/** The record's keys, in order. */
export const DISPATCH_KEYS: readonly (keyof DispatchFields)[] = Object.freeze([
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
export const PATCH_KEYS: readonly PatchKey[] = Object.freeze([
  'status',
  'providerMessageId',
  'nextAt',
  'deliveredAt',
  'openedAt',
  'actionedAt',
  'failedAt',
  'failReason',
]);
const unknownOf = (raw: object, known: readonly string[]) => Object.keys(raw).filter((k) => !known.includes(k));
const isPatchKey = (k: string): k is PatchKey => (PATCH_KEYS as readonly string[]).includes(k);

/** Type one attempt: `{ attempt }` or `{ reason }`. */
export function attemptOf(
  raw: unknown,
  field = 'attempt',
): { attempt: DispatchAttempt; reason?: undefined } | { reason: string } {
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
  const error = raw.error ?? null;
  if (!textOrNull(error, L.error))
    return { reason: `${field}.error must be text of 1 to ${L.error} characters or null` };
  return { attempt: { at: raw.at, ok: raw.ok, error } };
}

/** Check one field the record may change. Returns a reason or null. */
function patchProblem(k: PatchKey, v: unknown): string | null {
  switch (k) {
    case 'status':
      return isOneOf(DISPATCH_STATUSES, v) ? null : `status must be one of ${DISPATCH_STATUSES.join(', ')}`;
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
export function typeDispatch(raw: unknown): { ok: true; row: DispatchFields } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) return { ok: false, reason: `not an object (${describe(raw)})` };
  const unknown = unknownOf(raw, DISPATCH_KEYS);
  if (unknown.length) return { ok: false, reason: `unknown field(s) ${unknown.join(', ')}` };
  const r: Record<string, unknown> = {
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
  const audience = r.audience;
  if (
    !isPlainObject(audience) ||
    unknownOf(audience, ['kind', 'id']).length ||
    !isOneOf(AUDIENCE_KINDS, audience.kind) ||
    !text(audience.id, L.id)
  )
    return { ok: false, reason: `${at}: audience must be { kind: ${AUDIENCE_KINDS.join(' | ')}, id }` };
  if (r.orgId !== null && (!text(r.orgId, L.id) || audience.kind !== 'org_user'))
    return { ok: false, reason: `${at}: orgId is a staff audience's organisation id, or null` };
  if (!isOneOf(DISPATCH_CHANNELS, r.channel))
    return { ok: false, reason: `${at}: channel must be one of ${DISPATCH_CHANNELS.join(', ')}` };
  if (!isOneOf(DISPATCH_PROVIDERS, r.provider) || (r.channel === 'in_app') !== (r.provider === 'in_app'))
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
  const attempts: DispatchAttempt[] = [];
  for (let i = 0; i < r.attempts.length; i++) {
    const v = attemptOf(r.attempts[i], `${at}: attempts[${i}]`);
    if (v.reason !== undefined) return { ok: false, reason: v.reason };
    attempts.push(v.attempt);
  }
  const row: Record<string, unknown> = {};
  for (const k of DISPATCH_KEYS) row[k] = r[k];
  row.audience = { kind: audience.kind, id: audience.id };
  row.attempts = attempts;
  return { ok: true, row: row as DispatchFields };
}

// ------------------------------------------------------------------ rows ↔ the tables
const COLS =
  'id, notification_id, audience_kind, audience_id, org_id, channel, to_address, provider, status, skip_reason, provider_message_id, next_at, action_deadline_at, created_at, delivered_at, opened_at, actioned_at, failed_at, fail_reason';
const INSERT = `INSERT INTO dispatches (${COLS}) VALUES (${COLS.split(', ')
  .map((c) => `@${c}`)
  .join(', ')})`;
const INSERT_ATTEMPT =
  'INSERT INTO dispatch_attempts (dispatch_seq, seq, kind, attempted_at, ok, error, note) VALUES (?, ?, ?, ?, ?, ?, ?)';
const COLUMN: Readonly<Record<PatchKey, string>> = {
  status: 'status',
  providerMessageId: 'provider_message_id',
  nextAt: 'next_at',
  deliveredAt: 'delivered_at',
  openedAt: 'opened_at',
  actionedAt: 'actioned_at',
  failedAt: 'failed_at',
  failReason: 'fail_reason',
};
type DispatchRow = {
  seq: number;
  id: string;
  notification_id: string;
  audience_kind: NotificationAudience['kind'];
  audience_id: string;
  org_id: string | null;
  channel: DispatchChannel;
  to_address: string | null;
  provider: DispatchProvider;
  status: DispatchStatus;
  skip_reason: string | null;
  provider_message_id: string | null;
  next_at: number;
  action_deadline_at: number | null;
  created_at: number;
  delivered_at: number | null;
  opened_at: number | null;
  actioned_at: number | null;
  failed_at: number | null;
  fail_reason: string | null;
};
type AttemptRow = {
  kind: 'send' | 'quiet_recheck';
  attempted_at: number;
  ok: 0 | 1 | null;
  error: string | null;
  note: string | null;
};
const rowParams = (r: DispatchFields): Omit<DispatchRow, 'seq'> => ({
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
const attemptParams = (a: DispatchAttempt): [AttemptRow['kind'], number, 0 | 1 | null, string | null, string | null] =>
  'note' in a ? ['quiet_recheck', a.at, null, null, a.note] : ['send', a.at, a.ok ? 1 : 0, a.error, null];
const attemptFromDb = (r: AttemptRow): DispatchAttempt =>
  r.kind === 'quiet_recheck'
    ? { at: r.attempted_at, note: r.note as string }
    : { at: r.attempted_at, ok: r.ok === 1, error: r.error };
const fromDb = (r: DispatchRow, attempts: DispatchAttempt[]): DispatchFields => ({
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
function decode(sqlite: DatabaseSync, rows: DispatchRow[]): DispatchFields[] {
  const attempts = childRowsOf(
    sqlite,
    'dispatch_attempts',
    'dispatch_seq',
    rows.map((r) => r.seq),
    { order: 'seq' },
  );
  return rows.map((r) => fromDb(r, (attempts.all(r.seq) as AttemptRow[]).map(attemptFromDb)));
}
function insertDispatch(sqlite: DatabaseSync, row: DispatchFields) {
  const { lastInsertRowid } = sqlite.prepare(INSERT).run(rowParams(row));
  const att = sqlite.prepare(INSERT_ATTEMPT);
  row.attempts.forEach((a, i) => att.run(Number(lastInsertRowid), i, ...attemptParams(a)));
}
const readAll = (sqlite: DatabaseSync) =>
  decode(sqlite, sqlite.prepare('SELECT * FROM dispatches ORDER BY seq').all() as DispatchRow[]);

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const DISPATCHES_TABLE = {
  name: DISPATCHES_COLLECTION,
  read(sqlite: DatabaseSync): DispatchFields[] | null {
    return dispatchesLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = ['create', 'recordAttempt', 'patch'] as const;

/** `createDispatchesRepository({ sqlite, unit, now, log })`: the dispatches' writes and queries, plus `reads` (the queries alone). */
export function createDispatchesRepository(
  {
    sqlite,
    unit = null,
    now = Date.now,
    log = () => {},
  }: {
    sqlite: DatabaseSync;
    unit?: UnitParticipant | null;
    now?: () => number;
    log?: (message: string) => void;
  } = {} as { sqlite: DatabaseSync },
) {
  if (!sqlite)
    throw new TypeError(
      'the dispatches repository needs a SQLite connection (node:sqlite); dispatch records have no in-memory fallback',
    );
  const operation = operationOn(sqlite, unit);
  const cache = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const n = (row: unknown) => (row as { n: number }).n;
  const dec = (rows: unknown[]): Dispatch[] => decode(sqlite, rows as DispatchRow[]).map((r) => deepFreeze(r));
  const one = (sql: string, value: string): Dispatch | null => dec(q(sql).all(value))[0] ?? null;
  const byId = (id: unknown): Dispatch | null =>
    typeof id === 'string' ? one('SELECT * FROM dispatches WHERE id = ?', id) : null;
  const seqOf = (id: unknown): number | undefined =>
    (q('SELECT seq FROM dispatches WHERE id = ?').get(id as string) as { seq: number } | undefined)?.seq;

  const repo = {
    /** A new dispatch (its attempts normally empty). Refuses an unknown field, a wrong-typed value or a duplicate id. Returns the stored record. */
    create: (raw: DispatchInput): Dispatch =>
      operation(() => {
        const v = typeDispatch(raw);
        if (!v.ok) throw refusal('DISPATCH_RECORD_INVALID', v.reason);
        if (seqOf(v.row.id) !== undefined) throw refusal('DISPATCH_DUPLICATE', `dispatches ${v.row.id} already exists`);
        insertDispatch(sqlite, v.row);
        return byId(v.row.id) as Dispatch;
      }),
    /** One attempt at the next position: a send `{ at, ok, error }` or a quiet re-check note `{ at, note }`. Returns the stored record. */
    recordAttempt: (id: string, raw: DispatchAttempt): Dispatch =>
      operation(() => {
        const seq = seqOf(id);
        if (seq === undefined)
          throw refusal('DISPATCH_NOT_FOUND', `dispatches ${id} is not a record of the repository`);
        const v = attemptOf(raw);
        if (v.reason !== undefined) throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: ${v.reason}`);
        const { p: position } = q(
          'SELECT COALESCE(MAX(seq) + 1, 0) AS p FROM dispatch_attempts WHERE dispatch_seq = ?',
        ).get(seq) as { p: number };
        q(INSERT_ATTEMPT).run(seq, position, ...attemptParams(v.attempt));
        return byId(id) as Dispatch;
      }),
    /** Change the fields that move after creation (PATCH_KEYS), each typed. An unknown field is refused. Returns the stored record. */
    patch: (id: string, fields: DispatchPatch): Dispatch =>
      operation(() => {
        if (!isPlainObject(fields)) throw new TypeError('dispatches: a patch is an object of fields');
        const given = Object.keys(fields);
        const unknown = given.filter((k) => !isPatchKey(k));
        if (unknown.length)
          throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: a patch cannot change ${unknown.join(', ')}`);
        const keys = given as PatchKey[];
        for (const k of keys) {
          const p = patchProblem(k, fields[k]);
          if (p) throw refusal('DISPATCH_RECORD_INVALID', `dispatches ${id}: ${p}`);
        }
        if (seqOf(id) === undefined)
          throw refusal('DISPATCH_NOT_FOUND', `dispatches ${id} is not a record of the repository`);
        if (keys.length)
          q(`UPDATE dispatches SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(', ')} WHERE id = ?`).run(
            ...keys.map((k) => fields[k] as string | number | null),
            id,
          );
        return byId(id) as Dispatch;
      }),

    byId,
    /** Every dispatch of one notification, in creation order. */
    forNotification: (notificationId: string): Dispatch[] =>
      dec(q('SELECT * FROM dispatches WHERE notification_id = ? ORDER BY seq').all(notificationId)),
    /** The dispatch the provider accepted under this message id, or null. */
    byProviderMessageId: (value: unknown): Dispatch | null =>
      typeof value === 'string' ? one('SELECT * FROM dispatches WHERE provider_message_id = ?', value) : null,
    /** The external sends due at `at` (queued, retrying or held for quiet hours), in creation order. */
    due: (at: number): Dispatch[] =>
      dec(
        q(
          "SELECT * FROM dispatches WHERE status IN ('queued', 'retrying', 'held_quiet_hours') AND next_at <= ? ORDER BY seq",
        ).all(at),
      ),
    /** The in-app dispatches not yet opened whose notification was read, in creation order (the sweep marks them opened). */
    unopenedInAppRead: (): Readonly<{ id: string; notificationId: string; status: DispatchStatus }>[] =>
      (
        q(
          "SELECT d.id, d.notification_id, d.status FROM dispatches d JOIN notifications n ON n.id = d.notification_id WHERE d.channel = 'in_app' AND d.opened_at IS NULL AND n.read = 1 ORDER BY d.seq",
        ).all() as Pick<DispatchRow, 'id' | 'notification_id' | 'status'>[]
      ).map((r) => Object.freeze({ id: r.id, notificationId: r.notification_id, status: r.status })),
    /** A page of one organisation's staff dispatches, newest first: `{ items, nextCursor }`. */
    pageForOrg: (
      orgId: string,
      { after = null, limit }: { after?: readonly [number] | null; limit: number },
    ): { items: Dispatch[]; nextCursor: string | null } => {
      const rows = q(
        'SELECT * FROM dispatches WHERE org_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?',
      ).all(orgId, after?.[0] ?? null, after?.[0] ?? null, limit + 1) as DispatchRow[];
      const page = pageOf(rows, limit, (r) => [r.seq]);
      return { items: dec(page.items), nextCursor: page.nextCursor };
    },
    /** The newest `n` dispatches, newest first (the admin delivery centre). */
    recent: (limit: number): Dispatch[] => dec(q('SELECT * FROM dispatches ORDER BY seq DESC LIMIT ?').all(limit)),
    /** How many dispatches are in each status; a status with none is absent. */
    countsByStatus: (): Partial<Record<DispatchStatus, number>> =>
      Object.fromEntries(
        (
          q('SELECT status, COUNT(*) AS n FROM dispatches GROUP BY status ORDER BY status').all() as {
            status: DispatchStatus;
            n: number;
          }[]
        ).map((r) => [r.status, r.n]),
      ),
    /** Dispatches waiting on the provider: queued or retrying. */
    backlogCount: (): number =>
      n(q("SELECT COUNT(*) AS n FROM dispatches WHERE status IN ('queued', 'retrying')").get()),
    count: (): number => n(q('SELECT COUNT(*) AS n FROM dispatches').get()),
    attemptCount: (): number => n(q('SELECT COUNT(*) AS n FROM dispatch_attempts').get()),
    attach(): { engine: 'sqlite'; rows: number; attempts: number } {
      if (!dispatchesLive(sqlite)) throw new Error(`the dispatches repository needs ${DISPATCHES_MIGRATION} recorded`);
      const rows = repo.count();
      const attempts = repo.attemptCount();
      log(`dispatches: ${rows} dispatch(es) with ${attempts} attempt(s) in the tables`);
      return { engine: 'sqlite', rows, attempts };
    },
    now,
  };
  return Object.assign(repo, { reads: readsOf(repo, [...WRITES, 'attach']) });
}
export type DispatchesRepository = ReturnType<typeof createDispatchesRepository>;
export type DispatchReads = DispatchesRepository['reads'];
