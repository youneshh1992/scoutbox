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
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const CHANNELS_MIGRATION = '0012_channels';
export const CHANNELS_TABLES = Object.freeze(['channels', 'messages', 'message_attachments']);
/** The collection name (the whole-domain read). */
export const CHANNELS_COLLECTION = 'channels';
export const SENDER_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
export const COUNTERPARTIES = Object.freeze(['player', 'guardian']);
export const ATTACHMENT_KINDS = Object.freeze(['clip', 'trial_report']);
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
const list = (v) => v.map((x) => `'${x}'`).join(', ');
const len = (c, max, min = 0) => `CHECK (${c} IS NULL OR length(${c}) BETWEEN ${min} AND ${max})`;

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

export const channelsLive = (sqlite) => migrationApplied(sqlite, CHANNELS_MIGRATION);
const describe = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const ids = (xs) => xs.slice(0, 20).join(', ') + (xs.length > 20 ? ', …' : '');

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const CHANNEL_KEYS = Object.freeze([
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
const READ_BY_KEYS = Object.freeze(['org', 'counterparty']);
export const MESSAGE_KEYS = Object.freeze(['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId']);
const SENDER_KEYS = Object.freeze(['kind', 'id', 'name']);
export const CLIP_KEYS = Object.freeze(['kind', 'mediaId', 'title', 'url', 'verifiedClip']);
export const TRIAL_REPORT_KEYS = Object.freeze(['kind', 'reportId', 'orgName', 'summary']);

class Invalid extends Error {}
const bad = (at, what) => {
  throw new Invalid(`${at}: ${what}`);
};
const unknown = (obj, known, prefix, at) => {
  for (const k of Object.keys(obj)) if (!known.includes(k)) bad(at, `unknown field ${prefix}${k}`);
};
const str = (obj, k, at, { req = false, max, min = 0, field = k } = {}) => {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (typeof v !== 'string') bad(at, `${field} must be text${req ? '' : ' or null'} (got ${describe(v)})`);
  if (v.length < min || v.length > max) bad(at, `${field} must be ${min ? `${min}–` : 'at most '}${max} characters`);
  return v;
};
const int = (obj, k, at, { req = false, field = k } = {}) => {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (!isInt(v)) bad(at, `${field} must be an integer timestamp${req ? '' : ' or null'}`);
  return v;
};
const boolOf = (obj, k, at, { req = false, field = k } = {}) => {
  const v = obj[k];
  if (v === undefined || v === null) {
    if (req) bad(at, `${field} is required`);
    return null;
  }
  if (typeof v !== 'boolean') bad(at, `${field} must be a boolean${req ? '' : ' or null'}`);
  return v;
};
const idOf = (obj, k, at, o = {}) => str(obj, k, at, { max: L.id, min: 1, ...o });
/** `{ ok: true, value }` or `{ ok: false, reason }` from a typer that throws Invalid. */
const attempt = (fn) => {
  try {
    return { ok: true, ...fn() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    throw e;
  }
};

function attachmentOf(raw, at) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) bad(at, `attachment must be null or an object (got ${describe(raw)})`);
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

const messageRecord = ({ id, ts, sender, text, attachment, clientMsgId }) => ({
  id,
  ts,
  sender,
  text,
  attachment,
  ...(clientMsgId !== null ? { clientMsgId } : {}),
});
function messageOf(raw, at) {
  if (!isPlainObject(raw)) bad(at, `not an object (${describe(raw)})`);
  const id = idOf(raw, 'id', at, { req: true });
  at = `${at} (${id})`;
  unknown(raw, MESSAGE_KEYS, '', at);
  const ts = int(raw, 'ts', at, { req: true });
  if (!isPlainObject(raw.sender)) bad(at, `sender must be an object { kind, id, name } (got ${describe(raw.sender)})`);
  unknown(raw.sender, SENDER_KEYS, 'sender.', at);
  if (!SENDER_KINDS.includes(raw.sender.kind)) bad(at, `sender.kind must be one of ${SENDER_KINDS.join(', ')}`);
  const sender = {
    kind: raw.sender.kind,
    id: idOf(raw.sender, 'id', at, { req: true, field: 'sender.id' }),
    name: str(raw.sender, 'name', at, { max: L.name, field: 'sender.name' }),
  };
  const text = str(raw, 'text', at, { req: true, min: 1, max: L.text });
  const attachment = attachmentOf(raw.attachment, at);
  const clientMsgId = str(raw, 'clientMsgId', at, { min: 1, max: L.clientMsgId });
  return messageRecord({ id, ts, sender, text, attachment, clientMsgId });
}

function channelOf(raw, at) {
  if (!isPlainObject(raw)) bad(at, `not an object (${describe(raw)})`);
  const id = idOf(raw, 'id', at, { req: true });
  at = `${at} (${id})`;
  unknown(raw, CHANNEL_KEYS, '', at);
  if (!COUNTERPARTIES.includes(raw.counterparty)) bad(at, `counterparty must be one of ${COUNTERPARTIES.join(', ')}`);
  const createdAt = int(raw, 'createdAt', at, { req: true });
  const messagesRaw = raw.messages ?? [];
  if (!Array.isArray(messagesRaw)) bad(at, `messages must be an array (got ${describe(messagesRaw)})`);
  const readByRaw = raw.readBy ?? {};
  if (!isPlainObject(readByRaw)) bad(at, `readBy must be an object { org, counterparty } (got ${describe(readByRaw)})`);
  unknown(readByRaw, READ_BY_KEYS, 'readBy.', at);
  const readBy = {
    org: int(readByRaw, 'org', at, { field: 'readBy.org' }),
    counterparty: int(readByRaw, 'counterparty', at, { field: 'readBy.counterparty' }),
  };
  const seen = new Set();
  const messages = messagesRaw.map((m, i) => {
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
    counterparty: raw.counterparty,
    guardianId: idOf(raw, 'guardianId', at),
    createdAt,
    lastActivityAt,
    messages,
    readBy,
  };
}

/** One message: `{ ok: true, row }` or `{ ok: false, reason }` (an unknown field or a wrong-typed value refuses, by field and id). */
export const typeMessage = (raw, at = 'message') => {
  const r = attempt(() => ({ row: messageOf(raw, at) }));
  return r;
};
/** One thread with its messages: `{ ok: true, row }` or `{ ok: false, reason }`. */
export const typeChannel = (raw, at = 'channel') => attempt(() => ({ row: channelOf(raw, at) }));

// ------------------------------------------------------------------ rows ↔ the tables
const CHANNEL_INSERT =
  'INSERT INTO channels (id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, last_activity_at, read_by_org_at, read_by_counterparty_at) VALUES (@id, @request_id, @player_id, @player_name, @org_id, @org_name, @org_verified, @scout_name, @scout_role, @counterparty, @guardian_id, @created_at, @last_activity_at, @read_by_org_at, @read_by_counterparty_at)';
const MESSAGE_INSERT =
  'INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_user_id, sender_person_id, sender_name, text, client_msg_id) VALUES (@id, @channel_id, @position, @created_at, @sender_kind, @sender_user_id, @sender_person_id, @sender_name, @text, @client_msg_id)';
const ATTACHMENT_INSERT =
  'INSERT INTO message_attachments (message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary) VALUES (@message_id, @kind, @media_id, @title, @url, @verified_clip, @report_id, @org_name, @summary)';

const bit = (v) => (v === null ? null : v ? 1 : 0);
const channelParams = (row) => ({
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
const messageParams = (channelId, position, m) => ({
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
const attachmentParams = (messageId, a) =>
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
const attachmentFromDb = (r) =>
  r.kind === 'clip'
    ? { kind: 'clip', mediaId: r.media_id, title: r.title, url: r.url, verifiedClip: r.verified_clip === 1 }
    : { kind: 'trial_report', reportId: r.report_id, orgName: r.org_name, summary: r.summary };
const messageFromDb = (r, a) =>
  messageRecord({
    id: r.id,
    ts: r.created_at,
    sender: { kind: r.sender_kind, id: r.sender_user_id ?? r.sender_person_id, name: r.sender_name },
    text: r.text,
    attachment: a ? attachmentFromDb(a) : null,
    clientMsgId: r.client_msg_id,
  });
const channelFromDb = (r, messages) => ({
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
function decodeChannels(sqlite, rows) {
  const msgs = childRowsOf(
    sqlite,
    'messages',
    'channel_id',
    rows.map((r) => r.id),
    { order: 'position' },
  );
  const all = rows.flatMap((r) => msgs.all(r.id));
  const atts = childRowsOf(
    sqlite,
    'message_attachments',
    'message_id',
    all.map((m) => m.id),
  );
  return rows.map((r) =>
    channelFromDb(
      r,
      msgs.all(r.id).map((m) => messageFromDb(m, atts.all(m.id)[0] ?? null)),
    ),
  );
}
/** Every thread in insertion order (the whole-domain read): fresh objects. */
const readChannels = (sqlite) => decodeChannels(sqlite, sqlite.prepare('SELECT * FROM channels ORDER BY seq').all());
function insertChannel(sqlite, row) {
  sqlite.prepare(CHANNEL_INSERT).run(channelParams(row));
  const insM = sqlite.prepare(MESSAGE_INSERT);
  const insA = sqlite.prepare(ATTACHMENT_INSERT);
  row.messages.forEach((m, i) => {
    insM.run(messageParams(row.id, i, m));
    if (m.attachment) insA.run(attachmentParams(m.id, m.attachment));
  });
}

const existing = (sqlite, table, col = 'id') =>
  new Set(
    sqlite
      .prepare(`SELECT ${col} AS id FROM ${table}`)
      .all()
      .map((r) => r.id),
  );
/** Every reference a thread row names, against the tables as they stand: `[code, table, threadIds, missingIds]` per miss. */
function referenceMisses(sqlite, rows) {
  const requests = existing(sqlite, 'recruitment_requests');
  const orgs = existing(sqlite, 'orgs');
  const guardians = existing(sqlite, 'guardians');
  const staff = existing(sqlite, 'org_users');
  const misses = [];
  const check = (code, table, hit) => {
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
  read(sqlite) {
    return channelsLive(sqlite) ? readChannels(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['open', 'appendMessage', 'markRead', 'deleteForPlayer']);

/** `createChannelsRepository({ sqlite, unit, now, log })`: the threads' writes and queries, plus `reads` (the queries alone). */
export function createChannelsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite)
    throw new TypeError(
      'the channels repository needs a SQLite connection (node:sqlite); message threads have no in-memory fallback',
    );
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const isStr = (v) => typeof v === 'string';
  const dec = (rows) => decodeChannels(sqlite, rows).map(deepFreeze);
  const byId = (id) => (isStr(id) ? (dec(q('SELECT * FROM channels WHERE id = ?').all(id))[0] ?? null) : null);
  /** Rows after `after` ([lastActivityAt, seq]), most recently active first: `{ items, nextCursor }`. */
  const activePage = (where, args, { after = null, limit }) => {
    const rows = q(
      `SELECT * FROM channels WHERE ${where} AND (? IS NULL OR (last_activity_at, seq) < (?, ?)) ORDER BY last_activity_at DESC, seq DESC LIMIT ?`,
    ).all(...args, after ? 1 : null, after?.[0] ?? null, after?.[1] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.last_activity_at, r.seq]);
    return { items: dec(page.items), nextCursor: page.nextCursor };
  };
  const invalid = (what, v) => {
    if (!v.ok) throw refusal('CHANNEL_RECORD_INVALID', `${what}: ${v.reason}`);
    return v.row;
  };

  const repo = {
    /**
     * A new thread, in the channel literal (openChannel's; normally with no messages yet). Refuses an unknown field
     * or a wrong-typed value, a second thread for one request, and a request, organisation, guardian or staff sender
     * that does not exist. Returns the stored thread.
     */
    open: (raw) =>
      operation(() => {
        const row = invalid('a message thread needs the channel literal', typeChannel(raw));
        if (q('SELECT 1 FROM channels WHERE id = ?').get(row.id))
          throw refusal('CHANNEL_DUPLICATE', `channels ${row.id} already exists`);
        const held = q('SELECT id FROM channels WHERE request_id = ?').get(row.requestId);
        if (held)
          throw refusal(
            'CHANNEL_DUPLICATE',
            `request ${row.requestId} already opened thread ${held.id}; a request opens one thread`,
          );
        const [miss] = referenceMisses(sqlite, [row]);
        if (miss) throw refusal(miss[0], `channels ${row.id}: ${miss[1]} ${ids(miss[3])} does not exist`);
        insertChannel(sqlite, row);
        return byId(row.id);
      }),
    /**
     * A message at the end of the thread, in the message literal (postMessage's). Refuses a thread that does not
     * exist, a message id already stored, a retry id the same sender already used in this thread (the caller reads
     * `byClientMsgId` first and answers with the stored message), and a staff sender that does not exist. The
     * thread's activity time moves to the message's. Returns the stored message.
     */
    appendMessage: (channelId, raw) =>
      operation(() => {
        const thread = q('SELECT id, last_activity_at FROM channels WHERE id = ?').get(channelId);
        if (!thread) throw refusal('CHANNEL_NOT_FOUND', `channels ${channelId} is not a record of the repository`);
        const msg = invalid('a message needs the message literal', typeMessage(raw));
        if (q('SELECT 1 FROM messages WHERE id = ?').get(msg.id))
          throw refusal('MESSAGE_DUPLICATE', `messages ${msg.id} already exists`);
        if (msg.clientMsgId !== undefined && repo.byClientMsgId(channelId, msg.sender, msg.clientMsgId))
          throw refusal(
            'MESSAGE_DUPLICATE',
            `channels ${channelId}: this sender already sent client message id ${msg.clientMsgId}`,
          );
        if (msg.sender.kind === 'org_user' && !q('SELECT 1 FROM org_users WHERE id = ?').get(msg.sender.id))
          throw refusal('CHANNEL_SENDER_MISSING', `messages ${msg.id}: org_users ${msg.sender.id} does not exist`);
        const position = q('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM messages WHERE channel_id = ?').get(
          channelId,
        ).p;
        q(MESSAGE_INSERT).run(messageParams(channelId, position, msg));
        if (msg.attachment) q(ATTACHMENT_INSERT).run(attachmentParams(msg.id, msg.attachment));
        q('UPDATE channels SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?').run(msg.ts, channelId);
        return repo.messageById(msg.id);
      }),
    /** A read receipt: `side` is 'org' or 'counterparty', `at` an integer timestamp. Returns the stored receipts `{ org, counterparty }`. */
    markRead: (channelId, side, at) =>
      operation(() => {
        if (!READ_BY_KEYS.includes(side))
          throw new TypeError(`channels: a receipt side is 'org' or 'counterparty', not ${describe(side)}`);
        if (!isInt(at)) throw new TypeError('channels: a receipt needs an integer timestamp');
        const col = side === 'org' ? 'read_by_org_at' : 'read_by_counterparty_at';
        if (q(`UPDATE channels SET ${col} = ? WHERE id = ?`).run(at, channelId).changes !== 1)
          throw refusal('CHANNEL_NOT_FOUND', `channels ${channelId} is not a record of the repository`);
        const r = q('SELECT read_by_org_at, read_by_counterparty_at FROM channels WHERE id = ?').get(channelId);
        return Object.freeze({ org: r.read_by_org_at, counterparty: r.read_by_counterparty_at });
      }),
    /**
     * Every thread of the player, guardian–club threads included, with its messages and attachments (D-B: the
     * account deletion's behaviour, inside its unit). Returns `{ channels, messages }` removed.
     */
    deleteForPlayer: (playerId) =>
      operation(() => {
        if (!isStr(playerId) || !playerId) throw new TypeError('channels: deleteForPlayer needs a player id');
        const messages = q(
          'SELECT COUNT(*) AS n FROM messages WHERE channel_id IN (SELECT id FROM channels WHERE player_id = ?)',
        ).get(playerId).n;
        return { channels: q('DELETE FROM channels WHERE player_id = ?').run(playerId).changes, messages };
      }),

    byId,
    /** Who a thread is between, without its messages (the live-event check): `{ id, orgId, playerId, counterparty, guardianId }` or null. */
    parties: (id) => {
      const r = isStr(id)
        ? q('SELECT id, org_id, player_id, counterparty, guardian_id FROM channels WHERE id = ?').get(id)
        : null;
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
    messageById: (id) => {
      const r = isStr(id) ? q('SELECT * FROM messages WHERE id = ?').get(id) : null;
      return r
        ? deepFreeze(messageFromDb(r, q('SELECT * FROM message_attachments WHERE message_id = ?').get(id) ?? null))
        : null;
    },
    /** The message this sender already sent with this retry id in this thread, or null. */
    byClientMsgId: (channelId, sender, clientMsgId) => {
      if (!isStr(clientMsgId)) return null;
      const staff = sender.kind === 'org_user';
      const r = q(
        `SELECT id FROM messages WHERE channel_id = ? AND client_msg_id = ? AND sender_kind = ? AND ${staff ? 'sender_user_id' : 'sender_person_id'} = ?`,
      ).get(channelId, clientMsgId, sender.kind, sender.id);
      return r ? repo.messageById(r.id) : null;
    },
    /** The staff who have written in a thread, in the order they first did. */
    staffSenders: (channelId) =>
      q(
        'SELECT sender_user_id AS id FROM messages WHERE channel_id = ? AND sender_user_id IS NOT NULL GROUP BY sender_user_id ORDER BY MIN(position)',
      )
        .all(channelId)
        .map((r) => r.id),
    /** A player's threads, oldest first; `counterparty` limits them (an adult's own threads are 'player'). */
    forPlayer: (playerId, { counterparty = null } = {}) =>
      dec(
        q('SELECT * FROM channels WHERE player_id = ? AND (? IS NULL OR counterparty = ?) ORDER BY seq').all(
          playerId,
          counterparty,
          counterparty,
        ),
      ),
    /** A guardian's threads, oldest first. */
    forGuardian: (guardianId) => dec(q('SELECT * FROM channels WHERE guardian_id = ? ORDER BY seq').all(guardianId)),
    /** A page of one organisation's threads, most recently active first; `playerId` limits it to one player's. */
    pageForOrg: (orgId, { playerId = null } = {}, page) =>
      activePage('org_id = ? AND (? IS NULL OR player_id = ?)', [orgId, playerId, playerId], page),
    /** A page of every thread, most recently active first (Trust & Safety's thread audit). */
    page: (page) => activePage('1 = 1', [], page),
    /** One organisation's figures: `{ threads, unreadMessages }` (messages from the player or guardian since the club last opened the thread). */
    countsForOrg: (orgId) => {
      const threads = q('SELECT COUNT(*) AS n FROM channels WHERE org_id = ?').get(orgId).n;
      const unreadMessages = q(
        "SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.org_id = ? AND m.sender_kind <> 'org_user' AND m.created_at > COALESCE(c.read_by_org_at, 0)",
      ).get(orgId).n;
      return { threads, unreadMessages };
    },
    count: () => q('SELECT COUNT(*) AS n FROM channels').get().n,
    counts: () => ({
      channels: repo.count(),
      messages: q('SELECT COUNT(*) AS n FROM messages').get().n,
      attachments: q('SELECT COUNT(*) AS n FROM message_attachments').get().n,
    }),
    pending: () => 0,
    attach() {
      if (!channelsLive(sqlite)) throw new Error(`the channels repository needs ${CHANNELS_MIGRATION} recorded`);
      const c = repo.counts();
      log(`channels: ${c.channels} thread(s) with ${c.messages} message(s) in the tables`);
      return { engine: 'sqlite', ...c };
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
