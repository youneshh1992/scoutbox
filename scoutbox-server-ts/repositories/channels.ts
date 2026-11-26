/**
 * Message threads: `channels`, `messages` and `message_attachments`.
 *
 * A thread exists only because a request was accepted (one per request). For a minor the counterparty is the
 * guardian; the child is never in the thread.
 *
 * Records (the keys every reader sees):
 *   channel   { id, requestId, playerId, playerName, orgId, orgName, orgVerified, scoutName, scoutRole, counterparty,
 *               guardianId, createdAt, lastActivityAt, messages, readBy: { org, counterparty } }
 *   message   { id, ts, sender: { kind, id, name }, text, attachment, clientMsgId? }: `attachment` is null, a clip
 *             { kind: 'clip', mediaId, title, url, verifiedClip } or a trial report { kind: 'trial_report', reportId,
 *             orgName, summary }; `clientMsgId` is present only when the client sent one.
 *
 * Tables: `channels` (one row per thread; `last_activity_at` is the creation time, then the newest message's, and
 * orders the inboxes), `messages` (in thread order by `position`; the sender as typed columns by kind: staff in
 * `sender_user_id`, a player or guardian in `sender_person_id`; the client's retry id unique per thread and sender)
 * and `message_attachments` (0..1 per message, typed columns by kind).
 *
 * Each write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen; a list decodes
 * its threads' messages in one batch. The organisation's thread list and the admin list page by cursor, most recently
 * active first.
 *
 * References. The request (`recruitment_requests`), the organisation and a staff sender are RESTRICT keys. Player and
 * guardian ids carry no key (tolerant); `open` still refuses a guardian that does not exist. A deleted player's threads
 * are deleted explicitly with the account (D-B in docs/decisions.md).
 *
 * Refusals name tables, ids and fields, never a message text or a name.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { migrationApplied, childRowsOf, operationOn, type UnitParticipant } from './database.ts';
import { deepFreeze, type DeepReadonly } from '../domains/platform/values.ts';
import { isPlainObject } from './fieldSpecs.ts';
import { pageOf, readsOf } from './identityRules.ts';

export const CHANNELS_MIGRATION = '0012_channels';
export const CHANNELS_TABLES = Object.freeze(['channels', 'messages', 'message_attachments'] as const);
/** The collection name (the whole-domain read). */
export const CHANNELS_COLLECTION = 'channels';
export const SENDER_KINDS = Object.freeze(['player', 'guardian', 'org_user'] as const);
export const COUNTERPARTIES = Object.freeze(['player', 'guardian'] as const);
export const ATTACHMENT_KINDS = Object.freeze(['clip', 'trial_report'] as const);
export type SenderKind = (typeof SENDER_KINDS)[number];
export type Counterparty = (typeof COUNTERPARTIES)[number];
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const MESSAGE_LIMITS = Object.freeze({
  id: 80,
  text: 4000,
  clientMsgId: 64,
  name: 200,
  title: 300,
  url: 2000,
  summary: 500,
});
const L = MESSAGE_LIMITS;
const list = (v: readonly string[]) => v.map((x) => `'${x}'`).join(', ');
const len = (c: string, max: number, min = 0) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

export const CHANNELS_DDL = `
CREATE TABLE channels (
  seq                     INTEGER PRIMARY KEY,
  id                      TEXT NOT NULL UNIQUE ${len('id', L.id, 1)},
  request_id              TEXT NOT NULL REFERENCES recruitment_requests(id) ON DELETE RESTRICT,
  player_id               TEXT NOT NULL ${len('player_id', L.id, 1)},
  player_name             TEXT ${len('player_name', L.name)},
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL ${len('org_name', L.name)},
  org_verified            INTEGER CHECK (org_verified IS NULL OR org_verified IN (0, 1)),
  scout_name              TEXT ${len('scout_name', L.name)},
  scout_role              TEXT ${len('scout_role', L.name)},
  counterparty            TEXT NOT NULL CHECK (counterparty IN (${list(COUNTERPARTIES)})),
  guardian_id             TEXT ${len('guardian_id', L.id, 1)},
  created_at              INTEGER NOT NULL,
  last_activity_at        INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER,
  CHECK (last_activity_at >= created_at)
) STRICT;
CREATE UNIQUE INDEX channels_request_id ON channels (request_id);
CREATE INDEX channels_org_activity ON channels (org_id, last_activity_at, seq);
CREATE INDEX channels_activity ON channels (last_activity_at, seq);
CREATE INDEX channels_guardian_id ON channels (guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels (player_id, counterparty);
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE ${len('id', L.id, 1)},
  channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  created_at       INTEGER NOT NULL,
  sender_kind      TEXT NOT NULL CHECK (sender_kind IN (${list(SENDER_KINDS)})),
  sender_user_id   TEXT REFERENCES org_users(id) ON DELETE RESTRICT,
  sender_person_id TEXT ${len('sender_person_id', L.id, 1)},
  sender_name      TEXT ${len('sender_name', L.name)},
  text             TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND ${L.text}),
  client_msg_id    TEXT ${len('client_msg_id', L.clientMsgId, 1)},
  CHECK ((sender_kind = 'org_user' AND sender_user_id IS NOT NULL AND sender_person_id IS NULL)
      OR (sender_kind <> 'org_user' AND sender_person_id IS NOT NULL AND sender_user_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX messages_channel_position ON messages (channel_id, position);
CREATE UNIQUE INDEX messages_client_msg_id ON messages (channel_id, sender_kind, COALESCE(sender_user_id, sender_person_id), client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX messages_sender_user_id ON messages (sender_user_id);
CREATE TABLE message_attachments (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN (${list(ATTACHMENT_KINDS)})),
  media_id      TEXT ${len('media_id', L.id, 1)},
  title         TEXT ${len('title', L.title)},
  url           TEXT ${len('url', L.url)},
  verified_clip INTEGER CHECK (verified_clip IS NULL OR verified_clip IN (0, 1)),
  report_id     TEXT ${len('report_id', L.id, 1)},
  org_name      TEXT ${len('org_name', L.name)},
  summary       TEXT ${len('summary', L.summary)},
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL AND org_name IS NULL AND summary IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL AND title IS NULL AND url IS NULL AND verified_clip IS NULL))
) STRICT;`;

export const channelsLive = (sqlite: DatabaseSync) => migrationApplied(sqlite, CHANNELS_MIGRATION);

/** A clip from the player's media. */
export type ClipAttachment = {
  kind: 'clip';
  mediaId: string;
  title: string | null;
  url: string | null;
  verifiedClip: boolean;
};
/** A trial report on the player. */
export type TrialReportAttachment = {
  kind: 'trial_report';
  reportId: string;
  orgName: string | null;
  summary: string | null;
};
export type Attachment = ClipAttachment | TrialReportAttachment;
/** Who wrote a message: a staff member (`org_user`), the player or the guardian. */
export type MessageSender = { kind: SenderKind; id: string; name: string | null };
type MessageFields = {
  id: string;
  ts: number;
  sender: MessageSender;
  text: string;
  attachment: Attachment | null;
  /** Present only when the client sent one. */
  clientMsgId?: string;
};
/** Read receipts: when the organisation and the counterparty last opened the thread. */
export type ReadBy = { org: number | null; counterparty: number | null };
type ChannelFields = {
  id: string;
  requestId: string;
  playerId: string;
  playerName: string | null;
  orgId: string;
  orgName: string;
  orgVerified: boolean | null;
  scoutName: string | null;
  scoutRole: string | null;
  counterparty: Counterparty;
  guardianId: string | null;
  createdAt: number;
  lastActivityAt: number;
  messages: MessageFields[];
  readBy: ReadBy;
};
/** A message as the repository reads it back, frozen at every level. */
export type Message = DeepReadonly<MessageFields>;
/** A thread with its messages as the repository reads it back, frozen at every level. */
export type Channel = DeepReadonly<ChannelFields>;
/** Who a thread is between, without its messages. */
export type ChannelParties = Readonly<Pick<ChannelFields, 'id' | 'orgId' | 'playerId' | 'counterparty' | 'guardianId'>>;

/**
 * A new message: an absent optional field is null (`clientMsgId` absent). Typed when written, so a caller still in
 * JavaScript can pass anything and be refused by field.
 */
export type MessageInput = {
  id: string;
  ts: number;
  sender: { kind: SenderKind; id: string; name?: string | null };
  text: string;
  attachment?:
    | { kind: 'clip'; mediaId: string; title?: string | null; url?: string | null; verifiedClip: boolean }
    | { kind: 'trial_report'; reportId: string; orgName?: string | null; summary?: string | null }
    | null;
  clientMsgId?: string | null;
};
type ChannelOptional = 'playerName' | 'orgVerified' | 'scoutName' | 'scoutRole' | 'guardianId' | 'lastActivityAt';
/**
 * A new thread: an absent optional field is null, `messages` empty, the receipts unset, and `lastActivityAt` the
 * newest of its creation and its messages.
 */
export type ChannelInput = Omit<ChannelFields, ChannelOptional | 'messages' | 'readBy'> & {
  [K in ChannelOptional]?: ChannelFields[K] | null;
} & { messages?: MessageInput[]; readBy?: { org?: number | null; counterparty?: number | null } };

/** A page of threads, most recently active first: `after` is the previous page's last key `[lastActivityAt, seq]`. */
export type ActivePageRequest = { after?: readonly [number, number] | null; limit: number };
export type ChannelPage = { items: Channel[]; nextCursor: string | null };

type Refusal = Error & { code: string };
const refusal = (code: string, message: string): Refusal => Object.assign(new Error(`${code}: ${message}`), { code });
const describe = (v: unknown) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isOneOf = <T extends string>(vals: readonly T[], v: unknown): v is T => (vals as readonly unknown[]).includes(v);
const ids = (xs: string[]) => xs.slice(0, 20).join(', ') + (xs.length > 20 ? ', …' : '');

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const CHANNEL_KEYS: readonly (keyof ChannelFields)[] = Object.freeze([
  'id',
  'requestId',
  'playerId',
  'playerName',
  'orgId',
  'orgName',
  'orgVerified',
  'scoutName',
  'scoutRole',
  'counterparty',
  'guardianId',
  'createdAt',
  'lastActivityAt',
  'messages',
  'readBy',
]);
const READ_BY_KEYS = Object.freeze(['org', 'counterparty'] as const);
type ReadSide = (typeof READ_BY_KEYS)[number];
export const MESSAGE_KEYS: readonly (keyof MessageFields)[] = Object.freeze([
  'id',
  'ts',
  'sender',
  'text',
  'attachment',
  'clientMsgId',
]);
const SENDER_KEYS: readonly (keyof MessageSender)[] = Object.freeze(['kind', 'id', 'name']);
export const CLIP_KEYS: readonly (keyof ClipAttachment)[] = Object.freeze([
  'kind',
  'mediaId',
  'title',
  'url',
  'verifiedClip',
]);
export const TRIAL_REPORT_KEYS: readonly (keyof TrialReportAttachment)[] = Object.freeze([
  'kind',
  'reportId',
  'orgName',
  'summary',
]);

class Invalid extends Error {}
type Obj = Record<string, unknown>;
const bad = (at: string, what: string): never => {
  throw new Invalid(`${at}: ${what}`);
};
const unknown = (obj: Obj, known: readonly string[], prefix: string, at: string) => {
  for (const k of Object.keys(obj)) if (!known.includes(k)) bad(at, `unknown field ${prefix}${k}`);
};
type Opts = { req?: boolean; field?: string };
type StrOpts = Opts & { max: number; min?: number };
function str(obj: Obj, k: string, at: string, o: StrOpts & { req: true }): string;
function str(obj: Obj, k: string, at: string, o: StrOpts): string | null;
function str(obj: Obj, k: string, at: string, { req = false, max, min = 0, field = k }: StrOpts): string | null {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') return bad(at, `${field} must be text${req ? '' : ' or null'} (got ${describe(v)})`);
  if (v.length < min || v.length > max) bad(at, `${field} must be ${min ? `${min}–` : 'at most '}${max} characters`);
  return v;
}
function int(obj: Obj, k: string, at: string, o: Opts & { req: true }): number;
function int(obj: Obj, k: string, at: string, o?: Opts): number | null;
function int(obj: Obj, k: string, at: string, { req = false, field = k }: Opts = {}): number | null {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (!isInt(v)) return bad(at, `${field} must be an integer timestamp${req ? '' : ' or null'}`);
  return v;
}
function boolOf(obj: Obj, k: string, at: string, o: Opts & { req: true }): boolean;
function boolOf(obj: Obj, k: string, at: string, o?: Opts): boolean | null;
function boolOf(obj: Obj, k: string, at: string, { req = false, field = k }: Opts = {}): boolean | null {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (typeof v !== 'boolean') return bad(at, `${field} must be a boolean${req ? '' : ' or null'}`);
  return v;
}
function idOf(obj: Obj, k: string, at: string, o: Opts & { req: true }): string;
function idOf(obj: Obj, k: string, at: string, o?: Opts): string | null;
function idOf(obj: Obj, k: string, at: string, o: Opts = {}): string | null {
  return str(obj, k, at, { max: L.id, min: 1, ...o });
}
type Typed<R> = { ok: true; row: R } | { ok: false; reason: string };
/** `{ ok: true, row }` or `{ ok: false, reason }` from a typer that throws Invalid. */
const attempt = <R>(fn: () => R): Typed<R> => {
  try {
    return { ok: true, row: fn() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    throw e;
  }
};

function attachmentOf(raw: unknown, at: string): Attachment | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) return bad(at, `attachment must be null or an object (got ${describe(raw)})`);
  if (raw.kind === 'clip') {
    unknown(raw, CLIP_KEYS, 'attachment.', at);
    return {
      kind: 'clip',
      mediaId: idOf(raw, 'mediaId', at, { req: true, field: 'attachment.mediaId' }),
      title: str(raw, 'title', at, { max: L.title, field: 'attachment.title' }),
      url: str(raw, 'url', at, { max: L.url, field: 'attachment.url' }),
      verifiedClip: boolOf(raw, 'verifiedClip', at, { req: true, field: 'attachment.verifiedClip' }),
    };
  }
  if (raw.kind === 'trial_report') {
    unknown(raw, TRIAL_REPORT_KEYS, 'attachment.', at);
    return {
      kind: 'trial_report',
      reportId: idOf(raw, 'reportId', at, { req: true, field: 'attachment.reportId' }),
      orgName: str(raw, 'orgName', at, { max: L.name, field: 'attachment.orgName' }),
      summary: str(raw, 'summary', at, { max: L.summary, field: 'attachment.summary' }),
    };
  }
  return bad(at, `attachment.kind must be one of ${ATTACHMENT_KINDS.join(', ')}`);
}

const messageRecord = ({
  id,
  ts,
  sender,
  text,
  attachment,
  clientMsgId,
}: Omit<MessageFields, 'clientMsgId'> & { clientMsgId: string | null }): MessageFields => ({
  id,
  ts,
  sender,
  text,
  attachment,
  ...(clientMsgId !== null ? { clientMsgId } : {}),
});
function messageOf(raw: unknown, at: string): MessageFields {
  if (!isPlainObject(raw)) return bad(at, `not an object (${describe(raw)})`);
  const id = idOf(raw, 'id', at, { req: true });
  at = `${at} (${id})`;
  unknown(raw, MESSAGE_KEYS, '', at);
  const ts = int(raw, 'ts', at, { req: true });
  const rawSender = raw.sender;
  if (!isPlainObject(rawSender))
    return bad(at, `sender must be an object { kind, id, name } (got ${describe(rawSender)})`);
  unknown(rawSender, SENDER_KEYS, 'sender.', at);
  if (!isOneOf(SENDER_KINDS, rawSender.kind)) return bad(at, `sender.kind must be one of ${SENDER_KINDS.join(', ')}`);
  const sender: MessageSender = {
    kind: rawSender.kind,
    id: idOf(rawSender, 'id', at, { req: true, field: 'sender.id' }),
    name: str(rawSender, 'name', at, { max: L.name, field: 'sender.name' }),
  };
  const text = str(raw, 'text', at, { req: true, min: 1, max: L.text });
  const attachment = attachmentOf(raw.attachment, at);
  const clientMsgId = str(raw, 'clientMsgId', at, { min: 1, max: L.clientMsgId });
  return messageRecord({ id, ts, sender, text, attachment, clientMsgId });
}

function channelOf(raw: unknown, at: string): ChannelFields {
  if (!isPlainObject(raw)) return bad(at, `not an object (${describe(raw)})`);
  const id = idOf(raw, 'id', at, { req: true });
  at = `${at} (${id})`;
  unknown(raw, CHANNEL_KEYS, '', at);
  const counterparty = raw.counterparty;
  if (!isOneOf(COUNTERPARTIES, counterparty))
    return bad(at, `counterparty must be one of ${COUNTERPARTIES.join(', ')}`);
  const createdAt = int(raw, 'createdAt', at, { req: true });
  const messagesRaw = raw.messages ?? [];
  if (!Array.isArray(messagesRaw)) return bad(at, `messages must be an array (got ${describe(messagesRaw)})`);
  const readByRaw = raw.readBy ?? {};
  if (!isPlainObject(readByRaw))
    return bad(at, `readBy must be an object { org, counterparty } (got ${describe(readByRaw)})`);
  unknown(readByRaw, READ_BY_KEYS, 'readBy.', at);
  const readBy: ReadBy = {
    org: int(readByRaw, 'org', at, { field: 'readBy.org' }),
    counterparty: int(readByRaw, 'counterparty', at, { field: 'readBy.counterparty' }),
  };
  const seen = new Set<string>();
  const messages = messagesRaw.map((m: unknown, i) => {
    const msg = messageOf(m, `${at} message #${i}`);
    if (seen.has(msg.id)) bad(`${at} message #${i}`, `duplicates the id of an earlier message (${msg.id})`);
    seen.add(msg.id);
    return msg;
  });
  const newest = Math.max(createdAt, ...messages.map((m) => m.ts));
  const lastActivityAt = int(raw, 'lastActivityAt', at) ?? newest;
  if (lastActivityAt < newest) bad(at, 'lastActivityAt must not be earlier than the thread or its newest message');
  return {
    id,
    requestId: idOf(raw, 'requestId', at, { req: true }),
    playerId: idOf(raw, 'playerId', at, { req: true }),
    playerName: str(raw, 'playerName', at, { max: L.name }),
    orgId: idOf(raw, 'orgId', at, { req: true }),
    orgName: str(raw, 'orgName', at, { req: true, max: L.name }),
    orgVerified: boolOf(raw, 'orgVerified', at),
    scoutName: str(raw, 'scoutName', at, { max: L.name }),
    scoutRole: str(raw, 'scoutRole', at, { max: L.name }),
    counterparty,
    guardianId: idOf(raw, 'guardianId', at),
    createdAt,
    lastActivityAt,
    messages,
    readBy,
  };
}

/** One message: `{ ok: true, row }` or `{ ok: false, reason }` (an unknown field or a wrong-typed value refuses, by field and id). */
export const typeMessage = (raw: unknown, at = 'message'): Typed<MessageFields> => attempt(() => messageOf(raw, at));
/** One thread with its messages: `{ ok: true, row }` or `{ ok: false, reason }`. */
export const typeChannel = (raw: unknown, at = 'channel'): Typed<ChannelFields> => attempt(() => channelOf(raw, at));

// ------------------------------------------------------------------ rows ↔ the tables
const CHANNEL_INSERT =
  'INSERT INTO channels (id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, last_activity_at, read_by_org_at, read_by_counterparty_at) VALUES (@id, @request_id, @player_id, @player_name, @org_id, @org_name, @org_verified, @scout_name, @scout_role, @counterparty, @guardian_id, @created_at, @last_activity_at, @read_by_org_at, @read_by_counterparty_at)';
const MESSAGE_INSERT =
  'INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_user_id, sender_person_id, sender_name, text, client_msg_id) VALUES (@id, @channel_id, @position, @created_at, @sender_kind, @sender_user_id, @sender_person_id, @sender_name, @text, @client_msg_id)';
const ATTACHMENT_INSERT =
  'INSERT INTO message_attachments (message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary) VALUES (@message_id, @kind, @media_id, @title, @url, @verified_clip, @report_id, @org_name, @summary)';

type ChannelRow = {
  seq: number;
  id: string;
  request_id: string;
  player_id: string;
  player_name: string | null;
  org_id: string;
  org_name: string;
  org_verified: 0 | 1 | null;
  scout_name: string | null;
  scout_role: string | null;
  counterparty: Counterparty;
  guardian_id: string | null;
  created_at: number;
  last_activity_at: number;
  read_by_org_at: number | null;
  read_by_counterparty_at: number | null;
};
type MessageRow = {
  seq: number;
  id: string;
  channel_id: string;
  position: number;
  created_at: number;
  sender_kind: SenderKind;
  sender_user_id: string | null;
  sender_person_id: string | null;
  sender_name: string | null;
  text: string;
  client_msg_id: string | null;
};
type AttachmentRow = {
  message_id: string;
  kind: AttachmentKind;
  media_id: string | null;
  title: string | null;
  url: string | null;
  verified_clip: 0 | 1 | null;
  report_id: string | null;
  org_name: string | null;
  summary: string | null;
};

const bit = (v: boolean | null): 0 | 1 | null => (v === null ? null : v ? 1 : 0);
const channelParams = (row: ChannelFields): Omit<ChannelRow, 'seq'> => ({
  id: row.id,
  request_id: row.requestId,
  player_id: row.playerId,
  player_name: row.playerName,
  org_id: row.orgId,
  org_name: row.orgName,
  org_verified: bit(row.orgVerified),
  scout_name: row.scoutName,
  scout_role: row.scoutRole,
  counterparty: row.counterparty,
  guardian_id: row.guardianId,
  created_at: row.createdAt,
  last_activity_at: row.lastActivityAt,
  read_by_org_at: row.readBy.org,
  read_by_counterparty_at: row.readBy.counterparty,
});
const messageParams = (channelId: string, position: number, m: MessageFields): Omit<MessageRow, 'seq'> => ({
  id: m.id,
  channel_id: channelId,
  position,
  created_at: m.ts,
  sender_kind: m.sender.kind,
  sender_user_id: m.sender.kind === 'org_user' ? m.sender.id : null,
  sender_person_id: m.sender.kind === 'org_user' ? null : m.sender.id,
  sender_name: m.sender.name,
  text: m.text,
  client_msg_id: m.clientMsgId ?? null,
});
const attachmentParams = (messageId: string, a: Attachment): AttachmentRow =>
  a.kind === 'clip'
    ? {
        message_id: messageId,
        kind: 'clip',
        media_id: a.mediaId,
        title: a.title,
        url: a.url,
        verified_clip: a.verifiedClip ? 1 : 0,
        report_id: null,
        org_name: null,
        summary: null,
      }
    : {
        message_id: messageId,
        kind: 'trial_report',
        media_id: null,
        title: null,
        url: null,
        verified_clip: null,
        report_id: a.reportId,
        org_name: a.orgName,
        summary: a.summary,
      };
// The table's CHECKs hold each attachment kind to its columns and a sender to one id column by kind, so the casts
// below are what they guarantee.
const attachmentFromDb = (r: AttachmentRow): Attachment =>
  r.kind === 'clip'
    ? { kind: 'clip', mediaId: r.media_id as string, title: r.title, url: r.url, verifiedClip: r.verified_clip === 1 }
    : { kind: 'trial_report', reportId: r.report_id as string, orgName: r.org_name, summary: r.summary };
const messageFromDb = (r: MessageRow, a: AttachmentRow | null): MessageFields =>
  messageRecord({
    id: r.id,
    ts: r.created_at,
    sender: { kind: r.sender_kind, id: (r.sender_user_id ?? r.sender_person_id) as string, name: r.sender_name },
    text: r.text,
    attachment: a ? attachmentFromDb(a) : null,
    clientMsgId: r.client_msg_id,
  });
const channelFromDb = (r: ChannelRow, messages: MessageFields[]): ChannelFields => ({
  id: r.id,
  requestId: r.request_id,
  playerId: r.player_id,
  playerName: r.player_name,
  orgId: r.org_id,
  orgName: r.org_name,
  orgVerified: r.org_verified === null ? null : r.org_verified === 1,
  scoutName: r.scout_name,
  scoutRole: r.scout_role,
  counterparty: r.counterparty,
  guardianId: r.guardian_id,
  createdAt: r.created_at,
  lastActivityAt: r.last_activity_at,
  messages,
  readBy: { org: r.read_by_org_at, counterparty: r.read_by_counterparty_at },
});

/** Thread rows → records, their messages and attachments read in one batch each. */
function decodeChannels(sqlite: DatabaseSync, rows: ChannelRow[]): ChannelFields[] {
  const msgs = childRowsOf(
    sqlite,
    'messages',
    'channel_id',
    rows.map((r) => r.id),
    { order: 'position' },
  );
  const messagesOf = (id: string) => msgs.all(id) as MessageRow[];
  const all = rows.flatMap((r) => messagesOf(r.id));
  const atts = childRowsOf(
    sqlite,
    'message_attachments',
    'message_id',
    all.map((m) => m.id),
  );
  return rows.map((r) =>
    channelFromDb(
      r,
      messagesOf(r.id).map((m) => messageFromDb(m, (atts.all(m.id)[0] as AttachmentRow | undefined) ?? null)),
    ),
  );
}
/** Every thread in insertion order (the whole-domain read): fresh objects. */
const readChannels = (sqlite: DatabaseSync) =>
  decodeChannels(sqlite, sqlite.prepare('SELECT * FROM channels ORDER BY seq').all() as ChannelRow[]);
function insertChannel(sqlite: DatabaseSync, row: ChannelFields) {
  sqlite.prepare(CHANNEL_INSERT).run(channelParams(row));
  const insM = sqlite.prepare(MESSAGE_INSERT);
  const insA = sqlite.prepare(ATTACHMENT_INSERT);
  row.messages.forEach((m, i) => {
    insM.run(messageParams(row.id, i, m));
    if (m.attachment) insA.run(attachmentParams(m.id, m.attachment));
  });
}

const existing = (sqlite: DatabaseSync, table: string, col = 'id') =>
  new Set((sqlite.prepare(`SELECT ${col} AS id FROM ${table}`).all() as { id: string }[]).map((r) => r.id));
type ReferenceMiss = [code: string, table: string, threadIds: string[], missingIds: string[]];
/** Every reference a thread row names, against the tables as they stand: `[code, table, threadIds, missingIds]` per miss. */
function referenceMisses(sqlite: DatabaseSync, rows: ChannelFields[]): ReferenceMiss[] {
  const requests = existing(sqlite, 'recruitment_requests');
  const orgs = existing(sqlite, 'orgs');
  const guardians = existing(sqlite, 'guardians');
  const staff = existing(sqlite, 'org_users');
  const misses: ReferenceMiss[] = [];
  const check = (code: string, table: string, hit: (r: ChannelFields) => string[]) => {
    const bad = rows.filter((r) => hit(r).length);
    if (bad.length) misses.push([code, table, bad.map((r) => r.id), [...new Set(bad.flatMap(hit))]]);
  };
  check('CHANNEL_REQUEST_MISSING', 'recruitment_requests', (r) => (requests.has(r.requestId) ? [] : [r.requestId]));
  check('CHANNEL_ORG_MISSING', 'orgs', (r) => (orgs.has(r.orgId) ? [] : [r.orgId]));
  check('CHANNEL_GUARDIAN_MISSING', 'guardians', (r) =>
    r.guardianId === null || guardians.has(r.guardianId) ? [] : [r.guardianId],
  );
  check('CHANNEL_SENDER_MISSING', 'org_users', (r) =>
    r.messages.filter((m) => m.sender.kind === 'org_user' && !staff.has(m.sender.id)).map((m) => m.sender.id),
  );
  return misses;
}

/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const CHANNELS_TABLE = {
  name: CHANNELS_COLLECTION,
  read(sqlite: DatabaseSync): ChannelFields[] | null {
    return channelsLive(sqlite) ? readChannels(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = ['open', 'appendMessage', 'markRead', 'deleteForPlayer'] as const;
type Counts = { channels: number; messages: number; attachments: number };

/** `createChannelsRepository({ sqlite, unit, now, log })`: the threads' writes and queries, plus `reads` (the queries alone). */
export function createChannelsRepository(
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
      'the channels repository needs a SQLite connection (node:sqlite); message threads have no in-memory fallback',
    );
  const operation = operationOn(sqlite, unit);
  const cache = new Map<string, StatementSync>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const n = (row: unknown) => (row as { n: number }).n;
  const isStr = (v: unknown): v is string => typeof v === 'string';
  const dec = (rows: unknown[]): Channel[] => decodeChannels(sqlite, rows as ChannelRow[]).map((c) => deepFreeze(c));
  const byId = (id: unknown): Channel | null =>
    isStr(id) ? (dec(q('SELECT * FROM channels WHERE id = ?').all(id))[0] ?? null) : null;
  /** Rows after `after` ([lastActivityAt, seq]), most recently active first: `{ items, nextCursor }`. */
  const activePage = (
    where: string,
    args: (string | null)[],
    { after = null, limit }: ActivePageRequest,
  ): ChannelPage => {
    const rows = q(
      `SELECT * FROM channels WHERE ${where} AND (? IS NULL OR (last_activity_at, seq) < (?, ?)) ORDER BY last_activity_at DESC, seq DESC LIMIT ?`,
    ).all(...args, after ? 1 : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1) as ChannelRow[];
    const page = pageOf(rows, limit, (r) => [r.last_activity_at, r.seq]);
    return { items: dec(page.items), nextCursor: page.nextCursor };
  };
  const invalid = <R>(what: string, v: Typed<R>): R => {
    if (!v.ok) throw refusal('CHANNEL_RECORD_INVALID', `${what}: ${v.reason}`);
    return v.row;
  };
  const messageById = (id: unknown): Message | null => {
    const r = isStr(id) ? (q('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined) : undefined;
    if (!r) return null;
    const a = q('SELECT * FROM message_attachments WHERE message_id = ?').get(r.id) as AttachmentRow | undefined;
    return deepFreeze(messageFromDb(r, a ?? null));
  };
  /** The message this sender already sent with this retry id in this thread, or null. */
  const byClientMsgId = (
    channelId: string,
    sender: Pick<MessageSender, 'kind' | 'id'>,
    clientMsgId: unknown,
  ): Message | null => {
    if (!isStr(clientMsgId)) return null;
    const staff = sender.kind === 'org_user';
    const r = q(
      `SELECT id FROM messages WHERE channel_id = ? AND client_msg_id = ? AND sender_kind = ? AND ${staff ? 'sender_user_id' : 'sender_person_id'} = ?`,
    ).get(channelId, clientMsgId, sender.kind, sender.id) as { id: string } | undefined;
    return r ? messageById(r.id) : null;
  };
  const count = (): number => n(q('SELECT COUNT(*) AS n FROM channels').get());
  const counts = (): Counts => ({
    channels: count(),
    messages: n(q('SELECT COUNT(*) AS n FROM messages').get()),
    attachments: n(q('SELECT COUNT(*) AS n FROM message_attachments').get()),
  });

  const repo = {
    /**
     * A new thread, in the channel literal (openChannel's; normally with no messages yet). Refuses an unknown field
     * or a wrong-typed value, a second thread for one request, and a request, organisation, guardian or staff sender
     * that does not exist. Returns the stored thread.
     */
    open: (raw: ChannelInput): Channel =>
      operation(() => {
        const row = invalid('a message thread needs the channel literal', typeChannel(raw));
        if (q('SELECT 1 FROM channels WHERE id = ?').get(row.id))
          throw refusal('CHANNEL_DUPLICATE', `channels ${row.id} already exists`);
        const held = q('SELECT id FROM channels WHERE request_id = ?').get(row.requestId) as { id: string } | undefined;
        if (held)
          throw refusal(
            'CHANNEL_DUPLICATE',
            `request ${row.requestId} already opened thread ${held.id}; a request opens one thread`,
          );
        const [miss] = referenceMisses(sqlite, [row]);
        if (miss) throw refusal(miss[0], `channels ${row.id}: ${miss[1]} ${ids(miss[3])} does not exist`);
        insertChannel(sqlite, row);
        return byId(row.id) as Channel;
      }),
    /**
     * A message at the end of the thread, in the message literal (postMessage's). Refuses a thread that does not
     * exist, a message id already stored, a retry id the same sender already used in this thread (the caller reads
     * `byClientMsgId` first and answers with the stored message), and a staff sender that does not exist. The
     * thread's activity time moves to the message's. Returns the stored message.
     */
    appendMessage: (channelId: string, raw: MessageInput): Message =>
      operation(() => {
        const thread = q('SELECT id, last_activity_at FROM channels WHERE id = ?').get(channelId);
        if (!thread) throw refusal('CHANNEL_NOT_FOUND', `channels ${channelId} is not a record of the repository`);
        const msg = invalid('a message needs the message literal', typeMessage(raw));
        if (q('SELECT 1 FROM messages WHERE id = ?').get(msg.id))
          throw refusal('MESSAGE_DUPLICATE', `messages ${msg.id} already exists`);
        if (msg.clientMsgId !== undefined && byClientMsgId(channelId, msg.sender, msg.clientMsgId))
          throw refusal(
            'MESSAGE_DUPLICATE',
            `channels ${channelId}: this sender already sent client message id ${msg.clientMsgId}`,
          );
        if (msg.sender.kind === 'org_user' && !q('SELECT 1 FROM org_users WHERE id = ?').get(msg.sender.id))
          throw refusal('CHANNEL_SENDER_MISSING', `messages ${msg.id}: org_users ${msg.sender.id} does not exist`);
        const { p: position } = q('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM messages WHERE channel_id = ?').get(
          channelId,
        ) as { p: number };
        q(MESSAGE_INSERT).run(messageParams(channelId, position, msg));
        if (msg.attachment) q(ATTACHMENT_INSERT).run(attachmentParams(msg.id, msg.attachment));
        q('UPDATE channels SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?').run(msg.ts, channelId);
        return messageById(msg.id) as Message;
      }),
    /** A read receipt: `side` is 'org' or 'counterparty', `at` an integer timestamp. Returns the stored receipts `{ org, counterparty }`. */
    markRead: (channelId: string, side: ReadSide, at: number): Readonly<ReadBy> =>
      operation(() => {
        if (!isOneOf(READ_BY_KEYS, side))
          throw new TypeError(`channels: a receipt side is 'org' or 'counterparty', not ${describe(side)}`);
        if (!isInt(at)) throw new TypeError('channels: a receipt needs an integer timestamp');
        const col = side === 'org' ? 'read_by_org_at' : 'read_by_counterparty_at';
        if (q(`UPDATE channels SET ${col} = ? WHERE id = ?`).run(at, channelId).changes !== 1)
          throw refusal('CHANNEL_NOT_FOUND', `channels ${channelId} is not a record of the repository`);
        const r = q('SELECT read_by_org_at, read_by_counterparty_at FROM channels WHERE id = ?').get(channelId) as Pick<
          ChannelRow,
          'read_by_org_at' | 'read_by_counterparty_at'
        >;
        return Object.freeze({ org: r.read_by_org_at, counterparty: r.read_by_counterparty_at });
      }),
    /**
     * Every thread of the player, guardian–club threads included, with its messages and attachments (D-B: the
     * account deletion's behaviour, inside its unit). Returns `{ channels, messages }` removed.
     */
    deleteForPlayer: (playerId: string): { channels: number; messages: number } =>
      operation(() => {
        if (!isStr(playerId) || !playerId) throw new TypeError('channels: deleteForPlayer needs a player id');
        const messages = n(
          q('SELECT COUNT(*) AS n FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE player_id = ?)').get(
            playerId,
          ),
        );
        return { channels: Number(q('DELETE FROM channels WHERE player_id = ?').run(playerId).changes), messages };
      }),

    byId,
    /** Who a thread is between, without its messages (the live-event check): `{ id, orgId, playerId, counterparty, guardianId }` or null. */
    parties: (id: unknown): ChannelParties | null => {
      const r = isStr(id)
        ? (q('SELECT id, org_id, player_id, counterparty, guardian_id FROM channels WHERE id = ?').get(id) as
            | Pick<ChannelRow, 'id' | 'org_id' | 'player_id' | 'counterparty' | 'guardian_id'>
            | undefined)
        : undefined;
      return r
        ? Object.freeze({
            id: r.id,
            orgId: r.org_id,
            playerId: r.player_id,
            counterparty: r.counterparty,
            guardianId: r.guardian_id,
          })
        : null;
    },
    messageById,
    byClientMsgId,
    /** The staff who have written in a thread, in the order they first did. */
    staffSenders: (channelId: string): string[] =>
      (
        q(
          'SELECT sender_user_id AS id FROM messages WHERE channel_id = ? AND sender_user_id IS NOT NULL GROUP BY sender_user_id ORDER BY MIN(position)',
        ).all(channelId) as { id: string }[]
      ).map((r) => r.id),
    /** A player's threads, oldest first; `counterparty` limits them (an adult's own threads are 'player'). */
    forPlayer: (playerId: string, { counterparty = null }: { counterparty?: Counterparty | null } = {}): Channel[] =>
      dec(
        q('SELECT * FROM channels WHERE player_id = ? AND (? IS NULL OR counterparty = ?) ORDER BY seq').all(
          playerId,
          counterparty,
          counterparty,
        ),
      ),
    /** A guardian's threads, oldest first. */
    forGuardian: (guardianId: string): Channel[] =>
      dec(q('SELECT * FROM channels WHERE guardian_id = ? ORDER BY seq').all(guardianId)),
    /** A page of one organisation's threads, most recently active first; `playerId` limits it to one player's. */
    pageForOrg: (
      orgId: string,
      { playerId = null }: { playerId?: string | null } = {},
      page: ActivePageRequest,
    ): ChannelPage => activePage('org_id = ? AND (? IS NULL OR player_id = ?)', [orgId, playerId, playerId], page),
    /** A page of every thread, most recently active first (Trust & Safety's thread audit). */
    page: (page: ActivePageRequest): ChannelPage => activePage('1 = 1', [], page),
    /** One organisation's figures: `{ threads, unreadMessages }` (messages from the player or guardian since the club last opened the thread). */
    countsForOrg: (orgId: string): { threads: number; unreadMessages: number } => {
      const threads = n(q('SELECT COUNT(*) AS n FROM channels WHERE org_id = ?').get(orgId));
      const unreadMessages = n(
        q(
          "SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.org_id = ? AND m.sender_kind <> 'org_user' AND m.created_at > COALESCE(c.read_by_org_at, 0)",
        ).get(orgId),
      );
      return { threads, unreadMessages };
    },
    count,
    counts,
    attach(): { engine: 'sqlite' } & Counts {
      if (!channelsLive(sqlite)) throw new Error(`the channels repository needs ${CHANNELS_MIGRATION} recorded`);
      const c = counts();
      log(`channels: ${c.channels} thread(s) with ${c.messages} message(s) in the tables`);
      return { engine: 'sqlite', ...c };
    },
    now,
  };
  return Object.assign(repo, { reads: readsOf(repo, [...WRITES, 'attach']) });
}
export type ChannelsRepository = ReturnType<typeof createChannelsRepository>;
export type ChannelReads = ChannelsRepository['reads'];
