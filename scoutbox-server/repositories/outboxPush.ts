/**
 * The mail outbox, the push log and the device push tokens (`outbox`, `push_log`, `push_tokens`).
 *
 * The outbox has two sources, told apart by `source` in the table and by their keys in the record:
 *   mailer   { id, ts, to, subject, text, transport, delivered }   adapters.mjs createMailer.send: `text` withholds
 *            every one-time code passed as a secret; `delivered` is the provider's answer (true on the dev outbox);
 *   delivery { id, at, channel, to, text, providerMessageId, provider }   domains/messaging/delivery.mjs, the local fake provider's
 *            record of an accepted e-mail dispatch (`text` the first 300 characters of the notice).
 *
 * One row per device token: registering a token another account holds moves it to the new account, so a phone
 * receives only the notices of the account that last signed in on it.
 *
 * Nothing here carries a key: the outbox and push rows outlive the accounts they were addressed to (retention is open,
 * Q6 in docs/decisions.md). Refusals name tables, ids and fields, never an address, a mail text or a token.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrationApplied, operationOn, type UnitParticipant } from './database.ts';
import { isPlainObject } from './fieldSpecs.ts';
import { pageOf, textOk as text } from './identityRules.ts';
import { NOTIFICATION_AUDIENCE_KINDS, type NotificationAudience } from './notifications.ts';

export const OUTBOX_PUSH_MIGRATION = '0011_outbox_push';
export const OUTBOX_PUSH_TABLES = Object.freeze(['outbox', 'push_log', 'push_tokens'] as const);
export const MAIL_TRANSPORTS = Object.freeze(['sendgrid', 'dev-outbox'] as const);
export const DELIVERY_PROVIDER = 'local-fake';
export const PUSH_TRANSPORTS = Object.freeze(['expo', 'dev-log'] as const);
/** A push goes to a notification's audience. */
export const PUSH_AUDIENCE_KINDS = NOTIFICATION_AUDIENCE_KINDS;
/** Who may register a device: the Player app's two kinds of account. */
export const PUSH_TOKEN_KINDS = Object.freeze(['player', 'guardian'] as const);
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];
export type PushTransport = (typeof PUSH_TRANSPORTS)[number];
export type PushTokenKind = (typeof PUSH_TOKEN_KINDS)[number];
export const OUTBOX_LIMITS = Object.freeze({
  id: 80,
  address: 320,
  subject: 300,
  text: 10000,
  deliveryText: 300,
  providerMessageId: 80,
  title: 100,
  body: 4000,
  token: 200,
});
const L = OUTBOX_LIMITS;
const list = (v: readonly string[]) => v.map((x) => `'${x}'`).join(', ');
const len = (c: string, max: number, min = 1) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

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

export const outboxPushLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, OUTBOX_PUSH_MIGRATION);

/** A mail the mailer recorded before its provider call; `delivered` is the provider's answer. */
export type MailerRecord = {
  id: string;
  ts: number;
  to: string;
  subject: string;
  text: string;
  transport: MailTransport;
  delivered: boolean;
};
/** The local fake provider's record of an accepted e-mail dispatch. */
export type DeliveryRecord = {
  id: string;
  at: number;
  channel: 'email';
  to: string;
  text: string;
  providerMessageId: string;
  provider: typeof DELIVERY_PROVIDER;
};
export type OutboxSource = 'mailer' | 'delivery';
/** One outbox record as the repository reads it back, frozen. */
export type OutboxRecord = Readonly<MailerRecord> | Readonly<DeliveryRecord>;
type PushLogFields = {
  id: string;
  ts: number;
  audience: NotificationAudience;
  title: string;
  body: string;
  transport: PushTransport;
};
/** One push log record, frozen at every level. */
export type PushLogRecord = Readonly<Omit<PushLogFields, 'audience'> & { audience: Readonly<NotificationAudience> }>;
type PushTokenFields = { kind: PushTokenKind; refId: string; token: string; ts: number };
/** One device token, frozen. */
export type PushToken = Readonly<PushTokenFields>;
/** A page of a table, newest first: `after` is the previous page's last key. */
export type NewestPageRequest = { after?: readonly [number] | null; limit: number };
export type NewestPage<T> = { items: T[]; nextCursor: string | null };

type Refusal = Error & { code: string };
const refusal = (code: string, message: string): Refusal => Object.assign(new Error(`${code}: ${message}`), { code });
const describe = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isOneOf = <T extends string>(vals: readonly T[], v: unknown): v is T => (vals as readonly unknown[]).includes(v);

// ------------------------------------------------------------------ typing (no coercion; a refusal names the field)
export const MAILER_KEYS: readonly (keyof MailerRecord)[] = Object.freeze([
  'id',
  'ts',
  'to',
  'subject',
  'text',
  'transport',
  'delivered',
]);
export const DELIVERY_KEYS: readonly (keyof DeliveryRecord)[] = Object.freeze([
  'id',
  'at',
  'channel',
  'to',
  'text',
  'providerMessageId',
  'provider',
]);
export const PUSH_LOG_KEYS: readonly (keyof PushLogFields)[] = Object.freeze([
  'id',
  'ts',
  'audience',
  'title',
  'body',
  'transport',
]);
export const PUSH_TOKEN_KEYS: readonly (keyof PushTokenFields)[] = Object.freeze(['kind', 'refId', 'token', 'ts']);
/** Null when `raw` is an object with exactly `keys`; otherwise what is wrong with it. */
const keysProblem = (raw: unknown, keys: readonly string[], what: string): string | null => {
  if (!isPlainObject(raw)) return `${what} must be an object (got ${describe(raw)})`;
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  if (unknown.length) return `${what} carries unknown field(s) ${unknown.join(', ')}`;
  const missing = keys.filter((k) => !Object.hasOwn(raw, k));
  return missing.length ? `${what} lacks ${missing.join(', ')}` : null;
};
type Typed<R> = { ok: true; row: R } | { ok: false; reason: string };
const ok = <R>(row: R) => ({ ok: true, row }) as const;
const no = (reason: string) => ({ ok: false, reason }) as const;
const idOf = (raw: Record<string, unknown>) => (typeof raw.id === 'string' ? raw.id : '(no id)');

export type TypedOutbox =
  | { ok: true; row: MailerRecord; source: 'mailer' }
  | { ok: true; row: DeliveryRecord; source: 'delivery' }
  | { ok: false; reason: string };
/** Type one outbox record (either source, told apart by its keys): `{ ok, row, source }` or `{ ok: false, reason }`. */
export function typeOutbox(raw: unknown): TypedOutbox {
  const source = isPlainObject(raw) && Object.hasOwn(raw, 'providerMessageId') ? 'delivery' : 'mailer';
  const p = keysProblem(raw, source === 'mailer' ? MAILER_KEYS : DELIVERY_KEYS, `an outbox ${source} record`);
  if (p || !isPlainObject(raw)) return no(p as string);
  const at = `outbox ${idOf(raw)}`;
  if (!text(raw.id, L.id)) return no(`id must be text of 1 to ${L.id} characters`);
  if (!text(raw.to, L.address)) return no(`${at}: to must be an address of 1 to ${L.address} characters`);
  if (source === 'mailer') {
    if (!isInt(raw.ts)) return no(`${at}: ts must be an integer timestamp`);
    if (!text(raw.subject, L.subject, 0)) return no(`${at}: subject must be text of at most ${L.subject} characters`);
    if (!text(raw.text, L.text, 0)) return no(`${at}: text must be text of at most ${L.text} characters`);
    if (!isOneOf(MAIL_TRANSPORTS, raw.transport))
      return no(`${at}: transport must be one of ${MAIL_TRANSPORTS.join(', ')}`);
    if (typeof raw.delivered !== 'boolean') return no(`${at}: delivered must be a boolean`);
    return {
      ...ok<MailerRecord>({
        id: raw.id,
        ts: raw.ts,
        to: raw.to,
        subject: raw.subject,
        text: raw.text,
        transport: raw.transport,
        delivered: raw.delivered,
      }),
      source,
    };
  }
  if (!isInt(raw.at)) return no(`${at}: at must be an integer timestamp`);
  if (raw.channel !== 'email') return no(`${at}: channel must be email`);
  if (!text(raw.text, L.deliveryText, 0)) return no(`${at}: text must be text of at most ${L.deliveryText} characters`);
  if (!text(raw.providerMessageId, L.providerMessageId))
    return no(`${at}: providerMessageId must be text of 1 to ${L.providerMessageId} characters`);
  if (raw.provider !== DELIVERY_PROVIDER) return no(`${at}: provider must be ${DELIVERY_PROVIDER}`);
  return {
    ...ok<DeliveryRecord>({
      id: raw.id,
      at: raw.at,
      channel: raw.channel,
      to: raw.to,
      text: raw.text,
      providerMessageId: raw.providerMessageId,
      provider: raw.provider,
    }),
    source,
  };
}
export function typePushLog(raw: unknown): Typed<PushLogFields> {
  const p = keysProblem(raw, PUSH_LOG_KEYS, 'a push log record');
  if (p || !isPlainObject(raw)) return no(p as string);
  const at = `push log ${idOf(raw)}`;
  if (!text(raw.id, L.id)) return no(`id must be text of 1 to ${L.id} characters`);
  if (!isInt(raw.ts)) return no(`${at}: ts must be an integer timestamp`);
  const audience = raw.audience;
  if (
    keysProblem(audience, ['kind', 'id'], 'audience') ||
    !isPlainObject(audience) ||
    !isOneOf(PUSH_AUDIENCE_KINDS, audience.kind) ||
    !text(audience.id, L.id)
  )
    return no(`${at}: audience must be { kind: ${PUSH_AUDIENCE_KINDS.join(' | ')}, id }`);
  if (!text(raw.title, L.title)) return no(`${at}: title must be text of 1 to ${L.title} characters`);
  if (!text(raw.body, L.body, 0)) return no(`${at}: body must be text of at most ${L.body} characters`);
  if (!isOneOf(PUSH_TRANSPORTS, raw.transport))
    return no(`${at}: transport must be one of ${PUSH_TRANSPORTS.join(', ')}`);
  return ok({
    id: raw.id,
    ts: raw.ts,
    audience: { kind: audience.kind, id: audience.id },
    title: raw.title,
    body: raw.body,
    transport: raw.transport,
  });
}
export function typePushToken(raw: unknown): Typed<PushTokenFields> {
  const p = keysProblem(raw, PUSH_TOKEN_KEYS, 'a device token registration');
  if (p || !isPlainObject(raw)) return no(p as string);
  if (!isOneOf(PUSH_TOKEN_KINDS, raw.kind)) return no(`kind must be one of ${PUSH_TOKEN_KINDS.join(', ')}`);
  if (!text(raw.refId, L.id)) return no(`refId must be text of 1 to ${L.id} characters`);
  if (!text(raw.token, L.token)) return no(`token must be text of 1 to ${L.token} characters`);
  if (!isInt(raw.ts)) return no('ts must be an integer timestamp');
  return ok({ kind: raw.kind, refId: raw.refId, token: raw.token, ts: raw.ts });
}

// ------------------------------------------------------------------ rows ↔ the tables
const OUTBOX_INSERT =
  'INSERT INTO outbox (id, source, created_at, to_address, subject, text, transport, delivered, channel, provider_message_id) VALUES (@id, @source, @created_at, @to_address, @subject, @text, @transport, @delivered, @channel, @provider_message_id)';
const PUSH_INSERT =
  'INSERT INTO push_log (id, created_at, audience_kind, audience_id, title, body, transport) VALUES (@id, @created_at, @audience_kind, @audience_id, @title, @body, @transport)';
const TOKEN_UPSERT =
  'INSERT INTO push_tokens (ref_kind, ref_id, token, registered_at) VALUES (@ref_kind, @ref_id, @token, @registered_at) ON CONFLICT (token) DO UPDATE SET ref_kind = excluded.ref_kind, ref_id = excluded.ref_id, registered_at = excluded.registered_at';
type OutboxRow = {
  seq: number;
  id: string;
  source: OutboxSource;
  created_at: number;
  to_address: string;
  subject: string | null;
  text: string;
  transport: MailTransport | typeof DELIVERY_PROVIDER;
  delivered: 0 | 1 | null;
  channel: 'email' | null;
  provider_message_id: string | null;
};
type PushLogRow = {
  seq: number;
  id: string;
  created_at: number;
  audience_kind: NotificationAudience['kind'];
  audience_id: string;
  title: string;
  body: string;
  transport: PushTransport;
};
type PushTokenRow = { seq: number; ref_kind: PushTokenKind; ref_id: string; token: string; registered_at: number };

const outboxParams = (v: Extract<TypedOutbox, { ok: true }>): Omit<OutboxRow, 'seq'> =>
  v.source === 'mailer'
    ? {
        id: v.row.id,
        source: v.source,
        created_at: v.row.ts,
        to_address: v.row.to,
        subject: v.row.subject,
        text: v.row.text,
        transport: v.row.transport,
        delivered: v.row.delivered ? 1 : 0,
        channel: null,
        provider_message_id: null,
      }
    : {
        id: v.row.id,
        source: v.source,
        created_at: v.row.at,
        to_address: v.row.to,
        subject: null,
        text: v.row.text,
        transport: v.row.provider,
        delivered: null,
        channel: v.row.channel,
        provider_message_id: v.row.providerMessageId,
      };
// The table's CHECK holds each source's columns to their record's shape, so the casts below are what it guarantees.
const outboxFromDb = (r: OutboxRow): OutboxRecord =>
  Object.freeze(
    r.source === 'mailer'
      ? {
          id: r.id,
          ts: r.created_at,
          to: r.to_address,
          subject: r.subject as string,
          text: r.text,
          transport: r.transport as MailTransport,
          delivered: r.delivered === 1,
        }
      : {
          id: r.id,
          at: r.created_at,
          channel: r.channel as 'email',
          to: r.to_address,
          text: r.text,
          providerMessageId: r.provider_message_id as string,
          provider: r.transport as typeof DELIVERY_PROVIDER,
        },
  );
const pushParams = (row: PushLogFields): Omit<PushLogRow, 'seq'> => ({
  id: row.id,
  created_at: row.ts,
  audience_kind: row.audience.kind,
  audience_id: row.audience.id,
  title: row.title,
  body: row.body,
  transport: row.transport,
});
const pushFromDb = (r: PushLogRow): PushLogRecord =>
  Object.freeze({
    id: r.id,
    ts: r.created_at,
    audience: Object.freeze({ kind: r.audience_kind, id: r.audience_id }),
    title: r.title,
    body: r.body,
    transport: r.transport,
  });
const tokenParams = (row: PushTokenFields): Omit<PushTokenRow, 'seq'> => ({
  ref_kind: row.kind,
  ref_id: row.refId,
  token: row.token,
  registered_at: row.ts,
});
const tokenFromDb = (r: PushTokenRow): PushToken =>
  Object.freeze({ kind: r.ref_kind, refId: r.ref_id, token: r.token, ts: r.registered_at });

/** Whole-table reads (the test suites' read-back): one entry per collection, its records in insertion order. */
const recordsTable = <N extends string, R, T>(name: N, table: string, fromDb: (r: R) => T) => ({
  name,
  read(sqlite: DatabaseSync): T[] | null {
    return outboxPushLive(sqlite)
      ? (sqlite.prepare(`SELECT * FROM ${table} ORDER BY seq`).all() as R[]).map(fromDb)
      : null;
  },
});
export const OUTBOX_TABLE = recordsTable('outbox', 'outbox', outboxFromDb);
export const PUSH_LOG_TABLE = recordsTable('pushLog', 'push_log', pushFromDb);
export const PUSH_TOKENS_TABLE = recordsTable('pushTokens', 'push_tokens', tokenFromDb);
export const OUTBOX_PUSH_RECORD_TABLES = Object.freeze([OUTBOX_TABLE, PUSH_LOG_TABLE, PUSH_TOKENS_TABLE] as const);
export const OUTBOX_PUSH_COLLECTIONS = Object.freeze(OUTBOX_PUSH_RECORD_TABLES.map((t) => t.name));

// ------------------------------------------------------------------ the repository
type Counts = { outbox: number; pushLog: number; pushTokens: number };

/** `createOutboxPushRepository({ sqlite, unit, now, log })`: `{ outbox, pushLog, pushTokens }`, each with its writes and queries. */
export function createOutboxPushRepository(
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
      'the outbox/push repository needs a SQLite connection (node:sqlite); these records have no in-memory fallback',
    );
  const operation = operationOn(sqlite, unit);
  const cache = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const count = (table: string): number => (q(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  /** A page of a table, newest first by seq: `{ items, nextCursor }`. */
  const newestPage = <R extends { seq: number }, T>(
    table: string,
    fromDb: (r: R) => T,
    { after = null, limit }: NewestPageRequest,
  ): NewestPage<T> => {
    const rows = q(`SELECT * FROM ${table} WHERE (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`).all(
      after?.[0] ?? null,
      after?.[0] ?? null,
      limit + 1,
    ) as R[];
    const page = pageOf(rows, limit, (r) => [r.seq]);
    return { items: page.items.map(fromDb), nextCursor: page.nextCursor };
  };
  const invalid = <V extends { ok: boolean; reason?: string }>(what: string, v: V): Extract<V, { ok: true }> => {
    if (!v.ok) throw refusal('OUTBOX_RECORD_INVALID', `${what}: ${v.reason}`);
    return v as Extract<V, { ok: true }>;
  };
  const outboxById = (id: unknown): OutboxRecord | null => {
    const r = typeof id === 'string' ? (q('SELECT * FROM outbox WHERE id = ?').get(id) as OutboxRow | undefined) : null;
    return r ? outboxFromDb(r) : null;
  };

  const repo = {
    outbox: {
      /** A new record (the mailer's or the delivery centre's). Refuses an unknown field, a wrong-typed value or a duplicate id. Returns the stored record. */
      append: (raw: MailerRecord | DeliveryRecord): OutboxRecord =>
        operation(() => {
          const v = invalid('an outbox record', typeOutbox(raw));
          if (outboxById(v.row.id)) throw refusal('OUTBOX_DUPLICATE', `outbox ${v.row.id} already exists`);
          q(OUTBOX_INSERT).run(outboxParams(v));
          return outboxById(v.row.id) as OutboxRecord;
        }),
      /** The live transport's answer on a mailer record. Returns the stored record. */
      markDelivered: (id: string, delivered: boolean): OutboxRecord =>
        operation(() => {
          if (typeof delivered !== 'boolean') throw new TypeError('outbox: delivered is a boolean');
          const r = q('SELECT source FROM outbox WHERE id = ?').get(id) as Pick<OutboxRow, 'source'> | undefined;
          if (!r) throw refusal('OUTBOX_NOT_FOUND', `outbox ${id} is not a record of the repository`);
          if (r.source !== 'mailer')
            throw refusal(
              'OUTBOX_RECORD_INVALID',
              `outbox ${id} is a delivery record; only a mailer record carries a delivered flag`,
            );
          q('UPDATE outbox SET delivered = ? WHERE id = ?').run(delivered ? 1 : 0, id);
          return outboxById(id) as OutboxRecord;
        }),
      byId: outboxById,
      page: (page: NewestPageRequest): NewestPage<OutboxRecord> => newestPage('outbox', outboxFromDb, page),
      count: () => count('outbox'),
    },
    pushLog: {
      /** A new record, in the sender's literal. Returns the stored record. */
      append: (raw: PushLogFields): PushLogRecord =>
        operation(() => {
          const v = invalid('a push log record', typePushLog(raw));
          if (q('SELECT 1 FROM push_log WHERE id = ?').get(v.row.id))
            throw refusal('OUTBOX_DUPLICATE', `push_log ${v.row.id} already exists`);
          q(PUSH_INSERT).run(pushParams(v.row));
          return pushFromDb(q('SELECT * FROM push_log WHERE id = ?').get(v.row.id) as PushLogRow);
        }),
      page: (page: NewestPageRequest): NewestPage<PushLogRecord> => newestPage('push_log', pushFromDb, page),
      count: () => count('push_log'),
    },
    pushTokens: {
      /**
       * A device token for a player or a guardian. A token another account holds moves to this one; the same
       * account registering it again updates its time. Returns `{ moved, row }`.
       */
      register: (raw: PushTokenFields): { moved: boolean; row: PushToken } =>
        operation(() => {
          const v = invalid('a device token registration', typePushToken(raw));
          const held = q('SELECT ref_kind, ref_id FROM push_tokens WHERE token = ?').get(v.row.token) as
            | Pick<PushTokenRow, 'ref_kind' | 'ref_id'>
            | undefined;
          q(TOKEN_UPSERT).run(tokenParams(v.row));
          return {
            moved: !!held && (held.ref_kind !== v.row.kind || held.ref_id !== v.row.refId),
            row: tokenFromDb(q('SELECT * FROM push_tokens WHERE token = ?').get(v.row.token) as PushTokenRow),
          };
        }),
      /** The device tokens registered to this account, oldest registration first. */
      forAudience: (kind: NotificationAudience['kind'], id: string): PushToken[] =>
        (
          q('SELECT * FROM push_tokens WHERE ref_kind = ? AND ref_id = ? ORDER BY registered_at, seq').all(
            kind,
            id,
          ) as PushTokenRow[]
        ).map(tokenFromDb),
      count: () => count('push_tokens'),
    },
    counts: (): Counts => ({ outbox: count('outbox'), pushLog: count('push_log'), pushTokens: count('push_tokens') }),
    pending: () => 0,
    attach(): { engine: 'sqlite' } & Counts {
      if (!outboxPushLive(sqlite))
        throw new Error(`the outbox/push repository needs ${OUTBOX_PUSH_MIGRATION} recorded`);
      const c = repo.counts();
      log(
        `outbox/push: ${c.outbox} outbox record(s), ${c.pushLog} push log record(s) and ${c.pushTokens} device token(s) in the tables`,
      );
      return { engine: 'sqlite', ...c };
    },
    now,
  };
  return repo;
}
export type OutboxPushRepository = ReturnType<typeof createOutboxPushRepository>;
export type OutboxRepository = OutboxPushRepository['outbox'];
export type PushLogRepository = OutboxPushRepository['pushLog'];
export type PushTokensRepository = OutboxPushRepository['pushTokens'];
