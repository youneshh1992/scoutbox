/**
 * Message threads — migration plan step S7d (docs/architecture/s7-readiness-review.md
 * §11.5 as corrected by the independent reviews of 46e5afe (§11.7) and 8330f08
 * (§11.8); approved by the Founder's two explicit decisions, D-A and D-B).
 *
 * Owns three tables and one read-only view:
 *
 *   channels             one row per thread (the `openChannel` literal)        → db.channels
 *   messages             one row per message, in the thread's array order      → channel.messages (nested)
 *   message_attachments  0..1 row per message (the clip or trial-report shape)  → message.attachment (nested)
 *
 * WHAT THE ROWS ARE. `db.channels` was a JSON blob every build since M9 wrote
 * through TWO literal writers and three receipt writers in server.mjs:
 *
 *   the CHANNEL literal (openChannel): { id, requestId, playerId, playerName, orgId,
 *     orgName, orgVerified, scoutName, scoutRole, counterparty, guardianId, createdAt,
 *     messages: [], readBy: { org, counterparty } } — one writer, called by the two
 *     acceptance routes with the accepted request as its argument;
 *   the MESSAGE literal (postMessage): { id, ts, sender: { kind, id, name }, text,
 *     attachment, ...(clientMsgId ? { clientMsgId } : {}) } — `attachment` is null or
 *     one of the two shapes buildAttachment produces, the CLIP { kind: 'clip',
 *     mediaId, title, url, verifiedClip } or the TRIAL REPORT { kind: 'trial_report',
 *     reportId, orgName, summary }; `clientMsgId` is PRESENT only when the client
 *     sent one (absent otherwise — never null);
 *   the RECEIPTS: `channel.readBy.org = Date.now()` / `channel.readBy.counterparty =
 *     Date.now()` by the three read routes.
 *
 * TYPED COLUMNS, VALID INPUT ONLY (the S8d fidelity rule, 3 November 2026). Every
 * field is a typed column; there is no `extra_json` or `absent_keys_json`. A record
 * read back is built from the columns alone: every channel key is present (an optional
 * column that is NULL reads as null, the way openChannel writes it), `readBy` carries
 * both receipts, a message always carries `attachment` (null or one of the two shapes)
 * and carries `clientMsgId` only when it has one (the writer's own rule). Writes
 * (`open`, `appendMessage`, a snapshot `replace`) drop unknown keys silently and refuse a
 * wrong-typed value by field and id. The import (migration 0012) drops unknown fields
 * and a wrong-typed optional value (an unusable attachment included) and REPORTS each
 * with the record's id in `meta.channelsCutover.notes` and the boot log; it refuses only
 * a record that is unusable (no id, a wrong-typed required field, a missing reference).
 * The legacy `orgUserIdForNotify` was never written by any build and its one reader in
 * postMessage was dead code; it is dropped like any unknown field.
 *
 * THE ORDERING KEYS. The channel list every reader sees is `db.channels` array
 * order: `seq INTEGER PRIMARY KEY`, assigned at insert, preserved by the migration
 * (array position) and by backup/restore. A thread's messages are array order: `position` per channel (array
 * index at import, the next position at append), unique per channel, so ties on
 * `ts` keep their order. No new externally visible id is minted.
 *
 * REFERENCES — THE APPROVED SCOPE (D-A, D-B; review §11.5):
 *   request_id   NOT NULL, UNIQUE (the one channel a request opens — the rule the
 *                routes enforce by construction), NO foreign key: `recruitment_requests`
 *                is an S8 table that does not exist yet. The TRANSITIONAL CHECKED
 *                REFERENCE (D-A): `open` refuses a requestId that is not the id of a
 *                request in the authoritative `requests` blob; the migration refuses
 *                the cutover when a channel's request is not in the file's blob; every
 *                whole-snapshot write validates the FINAL combined state (below). When
 *                S8a creates the table, its migration rebuilds `channels` with the
 *                foreign key after its own preflight — true by construction if this
 *                validation has held.
 *   player_id    NOT NULL, NO foreign key and NO lifecycle clause (D-B): today's
 *                explicit deletion of a deleted player's threads — guardian–club
 *                threads included — is reproduced by `deleteForPlayer` inside the
 *                account-deletion unit of work, exactly where the array filter ran;
 *                the retention question stays open for S4b and nothing here decides
 *                it (no CASCADE, no RESTRICT, no new retention rule).
 *   guardian_id  nullable, NO foreign key — a bounded code-validated reference, NOT a
 *                SQLite necessity (review of 8330f08, §11.8): the identity snapshot
 *                write rewrites the guardians table (DELETE then reinsert) and runs an
 *                early foreign_key_check, so a declared RESTRICT would need the store's
 *                transaction setup and that check changed; instead `open` refuses a
 *                guardian that does not exist, and the final-state assertion checks
 *                every retained or incoming channel against the FINAL guardians table.
 *   org_id       NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT — kept as DDL
 *                (organisations are upserted and pruned, never rewritten).
 *   messages.channel_id → channels CASCADE and message_attachments.message_id →
 *                messages CASCADE: internal parent–child cascades that fire only after
 *                an explicit channel deletion and reproduce today's nesting.
 *
 * SNAPSHOT VALIDATION — THE FINAL COMBINED STATE, BOTH DIRECTIONS (review §11.5).
 * The snapshot contract allows partial writes: an omitted collection is retained,
 * an explicit non-array refuses, an empty array is a supplied value. The assertion
 * `assertChannelReferencesConsistent` runs (repositories/index.mjs) when ANY of
 * these holds — `channels` was written, the snapshot carries `requests`, the
 * identity pair was written — after the prunes and before the blob loop, and reads
 * the FINAL tables (channels, guardians, orgs) and the final requests (the supplied
 * collection, or the retained blob read from the file when omitted; never an empty
 * set for an omission). A miss refuses the whole transaction with ids only.
 *
 * WHERE A ROW BECOMES DURABLE (nothing new). STAGED mode in the server: a mutation
 * changes the mirror at once and its SQL waits for the next snapshot save, so each
 * row lands in exactly the save that carried its blob before S7d — the channel with
 * the acceptance route's persistNow() (with the request's status, the trial, the
 * ledger row and the notification), a message with postMessage's persistNow(), a
 * receipt with its route's persistNow(). A failed ordinary save keeps the mirror and
 * the queue as they are (memory is the intended state; the next save lands them
 * once); an aborted unit of work restores the mirror and the queue to the pre-unit
 * state, held views included — EVERY object of the mirror by identity (the graph
 * memento, repositories/memento.mjs): the thread list, each thread, its `readBy`, its
 * messages array, each message, its `sender` and its `attachment` go back to their pre-unit keys and values IN PLACE, so a caller holding
 * the receipts object itself (`channels.byId(id).readBy`), not only the thread, reads
 * the pre-unit value afterwards and follows the next committed write (the review of
 * 62e9c1a: a restore that replaced the nested objects with clones left such a held
 * view attached to the discarded value). Deletion joins the deletion unit.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0012_channels` in `data_migrations`, never by the tables existing or by row
 * counts. Refusals (CHANNELS_IMPORT_BLOCKED and the reference codes) name
 * collections, positions, ids and reasons — never a message text, a name or an
 * address.
 */
import { readonlyView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { readRequests, recruitmentLive } from './recruitment.mjs';

export const CHANNELS_MIGRATION = '0012_channels';
export const CHANNELS_TABLES = Object.freeze(['channels', 'messages', 'message_attachments']);
/** The blob collection the three tables replace. */
export const CHANNELS_COLLECTION = 'channels';

export const CHANNELS_DDL = `
CREATE TABLE channels (
  seq                     INTEGER PRIMARY KEY,
  id                      TEXT NOT NULL UNIQUE,
  request_id              TEXT NOT NULL,
  player_id               TEXT NOT NULL,
  player_name             TEXT,
  org_id                  TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  org_name                TEXT NOT NULL,
  org_verified            INTEGER CHECK (org_verified IS NULL OR org_verified IN (0, 1)),
  scout_name              TEXT,
  scout_role              TEXT,
  counterparty            TEXT NOT NULL CHECK (counterparty IN ('player', 'guardian')),
  guardian_id             TEXT,
  created_at              INTEGER NOT NULL,
  read_by_org_at          INTEGER,
  read_by_counterparty_at INTEGER
) STRICT;
CREATE UNIQUE INDEX channels_request_id ON channels (request_id);
CREATE INDEX channels_org_id ON channels (org_id);
CREATE INDEX channels_guardian_id ON channels (guardian_id);
CREATE INDEX channels_player_id_counterparty ON channels (player_id, counterparty);
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL UNIQUE,
  channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  sender_kind      TEXT NOT NULL CHECK (sender_kind IN ('player', 'guardian', 'org_user')),
  sender_id        TEXT NOT NULL,
  sender_name      TEXT,
  text             TEXT NOT NULL,
  client_msg_id    TEXT
) STRICT;
CREATE UNIQUE INDEX messages_channel_position ON messages (channel_id, position);
CREATE TABLE message_attachments (
  message_id    TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('clip', 'trial_report')),
  media_id      TEXT,
  title         TEXT,
  url           TEXT,
  verified_clip INTEGER CHECK (verified_clip IS NULL OR verified_clip IN (0, 1)),
  report_id     TEXT,
  org_name      TEXT,
  summary       TEXT,
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL AND org_name IS NULL AND summary IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL AND title IS NULL AND url IS NULL AND verified_clip IS NULL))
) STRICT;`;

export const channelsLive = (sqlite) => migrationApplied(sqlite, CHANNELS_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`CHANNELS_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'CHANNELS_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const isString = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const isBool = (v) => typeof v === 'boolean';
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const ids = (list) => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');

// ------------------------------------------------------------------ the records and their typing
/** The channel record's keys, in openChannel's order. */
export const CHANNEL_KEYS = Object.freeze(['id', 'requestId', 'playerId', 'playerName', 'orgId', 'orgName', 'orgVerified', 'scoutName', 'scoutRole', 'counterparty', 'guardianId', 'createdAt', 'messages', 'readBy']);
const READ_BY_KEYS = Object.freeze(['org', 'counterparty']);
/** The message record's keys, in postMessage's order (`clientMsgId` present only when the client sent one). */
export const MESSAGE_KEYS = Object.freeze(['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId']);
const SENDER_KEYS = Object.freeze(['kind', 'id', 'name']);
const SENDER_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
export const CLIP_KEYS = Object.freeze(['kind', 'mediaId', 'title', 'url', 'verifiedClip']);
export const TRIAL_REPORT_KEYS = Object.freeze(['kind', 'reportId', 'orgName', 'summary']);

/**
 * The typing context. STRICT (every write): an unknown key is dropped silently, a
 * wrong-typed value is refused by field. LENIENT (the import): an unknown key and a
 * wrong-typed optional value are dropped and noted with the record's id. A required
 * field that does not hold is refused in both.
 */
const STRICT = Object.freeze({ lenient: false });
const lenientContext = () => ({ lenient: true, notes: [] });
const fail = (reason) => ({ ok: false, reason });
/** An optional value: null when absent or null; wrong-typed → `{ reason }` (strict) or null with a note (lenient). */
function optional(obj, key, field, holds, what, at, ctx) {
  const v = Object.hasOwn(obj, key) ? obj[key] : undefined;
  if (v === undefined || v === null) return { value: null };
  if (holds(v)) return { value: v };
  if (ctx.lenient) { ctx.notes.push(`${at}: ${field} is not ${what}; dropped`); return { value: null }; }
  return { reason: `${at}: ${field} must be ${what} or null` };
}
function noteUnknown(obj, known, prefix, at, ctx) {
  if (ctx.lenient) for (const k of Object.keys(obj)) if (!known.includes(k)) ctx.notes.push(`${at}: unknown field ${prefix}${k} dropped`);
}

/** One attachment: `{ ok, value }` (null or the clip / trial-report record) or `{ ok: false, reason }`. A lenient import drops an unusable one. */
export function typeAttachment(raw, at = 'message', ctx = STRICT) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const unusable = (problem) => (ctx.lenient ? (ctx.notes.push(`${at}: ${problem}; the attachment dropped`), { ok: true, value: null }) : fail(`${at}: ${problem}`));
  if (!isPlainObject(raw)) return unusable(`attachment must be null or an object (got ${describe(raw)})`);
  if (raw.kind === 'clip') {
    if (!nonEmpty(raw.mediaId)) return unusable('attachment.mediaId must be a non-empty string');
    const title = optional(raw, 'title', 'attachment.title', isString, 'a string', at, ctx); if (title.reason) return fail(title.reason);
    const url = optional(raw, 'url', 'attachment.url', isString, 'a string', at, ctx); if (url.reason) return fail(url.reason);
    let verifiedClip = raw.verifiedClip;
    if (!isBool(verifiedClip)) {
      if (!ctx.lenient) return fail(`${at}: attachment.verifiedClip must be a boolean`);
      ctx.notes.push(`${at}: attachment.verifiedClip is not a boolean; recorded as false (unverified)`); verifiedClip = false;
    }
    noteUnknown(raw, CLIP_KEYS, 'attachment.', at, ctx);
    return { ok: true, value: { kind: 'clip', mediaId: raw.mediaId, title: title.value, url: url.value, verifiedClip } };
  }
  if (raw.kind === 'trial_report') {
    if (!nonEmpty(raw.reportId)) return unusable('attachment.reportId must be a non-empty string');
    const orgName = optional(raw, 'orgName', 'attachment.orgName', isString, 'a string', at, ctx); if (orgName.reason) return fail(orgName.reason);
    const summary = optional(raw, 'summary', 'attachment.summary', isString, 'a string', at, ctx); if (summary.reason) return fail(summary.reason);
    noteUnknown(raw, TRIAL_REPORT_KEYS, 'attachment.', at, ctx);
    return { ok: true, value: { kind: 'trial_report', reportId: raw.reportId, orgName: orgName.value, summary: summary.value } };
  }
  return unusable("attachment.kind must be 'clip' or 'trial_report' (the two shapes buildAttachment produces)");
}

/** One message: `{ ok: true, row }` (the record, detached) or `{ ok: false, reason }`. */
export function typeMessage(raw, at = 'message', ctx = STRICT) {
  if (!isPlainObject(raw)) return fail(`${at}: not an object (${describe(raw)})`);
  if (!nonEmpty(raw.id)) return fail(`${at}: id must be a non-empty string`);
  at = `${at} (${raw.id})`;
  if (!isInt(raw.ts)) return fail(`${at}: ts must be an integer timestamp`);
  if (!isPlainObject(raw.sender)) return fail(`${at}: sender must be an object { kind, id, name } (got ${describe(raw.sender)})`);
  if (!SENDER_KINDS.includes(raw.sender.kind)) return fail(`${at}: sender.kind must be one of ${SENDER_KINDS.join(', ')}`);
  if (!nonEmpty(raw.sender.id)) return fail(`${at}: sender.id must be a non-empty string`);
  const name = optional(raw.sender, 'name', 'sender.name', isString, 'a string', at, ctx); if (name.reason) return fail(name.reason);
  noteUnknown(raw.sender, SENDER_KEYS, 'sender.', at, ctx);
  if (!isString(raw.text)) return fail(`${at}: text must be a string`);
  const attachment = typeAttachment(raw.attachment, at, ctx); if (!attachment.ok) return attachment;
  let clientMsgId = null;
  if (raw.clientMsgId !== undefined && raw.clientMsgId !== null) {
    if (nonEmpty(raw.clientMsgId)) clientMsgId = raw.clientMsgId;
    else if (ctx.lenient) ctx.notes.push(`${at}: clientMsgId is not a non-empty string; dropped`);
    else return fail(`${at}: clientMsgId must be a non-empty string when present`);
  }
  noteUnknown(raw, MESSAGE_KEYS, '', at, ctx);
  return { ok: true, row: messageRecord({ id: raw.id, ts: raw.ts, sender: { kind: raw.sender.kind, id: raw.sender.id, name: name.value }, text: raw.text, attachment: attachment.value, clientMsgId }) };
}
const messageRecord = ({ id, ts, sender, text, attachment, clientMsgId }) => ({ id, ts, sender, text, attachment, ...(clientMsgId !== null ? { clientMsgId } : {}) });

const CHANNEL_OPTIONAL = Object.freeze([['playerName', isString, 'a string'], ['orgVerified', isBool, 'a boolean'], ['scoutName', isString, 'a string'], ['scoutRole', isString, 'a string'], ['guardianId', nonEmpty, 'a non-empty string']]);
/** One channel, its messages included: `{ ok: true, row }` (the record, detached; `messages` the message records, `readBy` the receipts) or `{ ok: false, reason }`. */
export function typeChannel(raw, at = 'channel', ctx = STRICT) {
  if (!isPlainObject(raw)) return fail(`${at}: not an object (${describe(raw)})`);
  if (!nonEmpty(raw.id)) return fail(`${at}: id must be a non-empty string`);
  at = `${at} (${raw.id})`;
  for (const k of ['requestId', 'playerId', 'orgId']) if (!nonEmpty(raw[k])) return fail(`${at}: ${k} must be a non-empty string`);
  if (!isString(raw.orgName)) return fail(`${at}: orgName must be a string`);
  if (raw.counterparty !== 'player' && raw.counterparty !== 'guardian') return fail(`${at}: counterparty must be 'player' or 'guardian'`);
  if (!isInt(raw.createdAt)) return fail(`${at}: createdAt must be an integer timestamp`);
  if (!Array.isArray(raw.messages)) return fail(`${at}: messages must be an array (got ${describe(raw.messages)})`);
  const opt = {};
  for (const [k, holds, what] of CHANNEL_OPTIONAL) { const o = optional(raw, k, k, holds, what, at, ctx); if (o.reason) return fail(o.reason); opt[k] = o.value; }
  let rawReadBy = raw.readBy ?? {};
  if (!isPlainObject(rawReadBy)) {
    if (!ctx.lenient) return fail(`${at}: readBy must be an object { org, counterparty } (got ${describe(rawReadBy)})`);
    ctx.notes.push(`${at}: readBy is not an object; both receipts recorded as null`); rawReadBy = {};
  }
  const readBy = {};
  for (const k of READ_BY_KEYS) { const o = optional(rawReadBy, k, `readBy.${k}`, isInt, 'an integer timestamp', at, ctx); if (o.reason) return fail(o.reason); readBy[k] = o.value; }
  noteUnknown(rawReadBy, READ_BY_KEYS, 'readBy.', at, ctx);
  noteUnknown(raw, CHANNEL_KEYS, '', at, ctx);
  const messages = []; const seen = new Set();
  for (let i = 0; i < raw.messages.length; i++) {
    const m = typeMessage(raw.messages[i], `${at} message #${i}`, ctx); if (!m.ok) return m;
    if (seen.has(m.row.id)) return fail(`${at} message #${i}: duplicates the id of an earlier message (${m.row.id})`);
    seen.add(m.row.id); messages.push(m.row);
  }
  return { ok: true, row: { id: raw.id, requestId: raw.requestId, playerId: raw.playerId, playerName: opt.playerName, orgId: raw.orgId, orgName: raw.orgName, orgVerified: opt.orgVerified, scoutName: opt.scoutName, scoutRole: opt.scoutRole, counterparty: raw.counterparty, guardianId: opt.guardianId, createdAt: raw.createdAt, messages, readBy } };
}

/**
 * Type a whole channels collection (unique ids, unique requestIds); throws CHANNELS_IMPORT_BLOCKED.
 * `lenient` (the import) drops and notes what does not fit; otherwise (a snapshot write) a wrong-typed value refuses.
 * Returns `{ rows, counts, notes }` — the notes name ids and fields, never a value.
 */
export function validateChannelRows(rows, { label = 'channels', lenient = false } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const ctx = lenient ? lenientContext() : STRICT;
  const out = []; const problems = []; const seenIds = new Set(); const seenRequests = new Map();
  const counts = { imported: 0, messages: 0, attachments: 0, normalised: 0, byCounterparty: {} };
  rows.forEach((raw, i) => {
    const notesBefore = ctx.notes?.length ?? 0;
    const v = typeChannel(raw, `${label} entry #${i}`, ctx);
    if (!v.ok) { problems.push(v.reason); return; }
    if (seenIds.has(v.row.id)) { problems.push(`${label} entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; }
    if (seenRequests.has(v.row.requestId)) { problems.push(`${label} entry #${i}: a second channel for request ${v.row.requestId} (the first is ${seenRequests.get(v.row.requestId)}); a request opens one channel`); return; }
    seenIds.add(v.row.id); seenRequests.set(v.row.requestId, v.row.id);
    if ((ctx.notes?.length ?? 0) > notesBefore) counts.normalised += 1;
    counts.messages += v.row.messages.length; counts.attachments += v.row.messages.filter((m) => m.attachment).length;
    counts.byCounterparty[v.row.counterparty] = (counts.byCounterparty[v.row.counterparty] ?? 0) + 1;
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  counts.imported = out.length;
  return { rows: out, counts, notes: ctx.notes ?? [] };
}

// ------------------------------------------------------------------ rows ↔ the tables
const CHANNEL_SELECT = 'SELECT seq, id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, read_by_org_at, read_by_counterparty_at FROM channels';
const CHANNEL_INSERT = 'INSERT INTO channels (id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, read_by_org_at, read_by_counterparty_at) VALUES (@id, @request_id, @player_id, @player_name, @org_id, @org_name, @org_verified, @scout_name, @scout_role, @counterparty, @guardian_id, @created_at, @read_by_org_at, @read_by_counterparty_at)';
const MESSAGE_SELECT = 'SELECT seq, id, channel_id, position, created_at, sender_kind, sender_id, sender_name, text, client_msg_id FROM messages';
const MESSAGE_INSERT = 'INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_id, sender_name, text, client_msg_id) VALUES (@id, @channel_id, @position, @created_at, @sender_kind, @sender_id, @sender_name, @text, @client_msg_id)';
const ATTACHMENT_SELECT = 'SELECT message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary FROM message_attachments';
const ATTACHMENT_INSERT = 'INSERT INTO message_attachments (message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary) VALUES (@message_id, @kind, @media_id, @title, @url, @verified_clip, @report_id, @org_name, @summary)';
const READ_UPDATE = { org: 'UPDATE channels SET read_by_org_at = ? WHERE id = ?', counterparty: 'UPDATE channels SET read_by_counterparty_at = ? WHERE id = ?' };
const DELETE_FOR_PLAYER = 'DELETE FROM channels WHERE player_id = ?';

const bool = (v) => (v === null ? null : v ? 1 : 0);
const channelParams = (row) => ({
  id: row.id, request_id: row.requestId, player_id: row.playerId, player_name: row.playerName, org_id: row.orgId, org_name: row.orgName,
  org_verified: bool(row.orgVerified), scout_name: row.scoutName, scout_role: row.scoutRole, counterparty: row.counterparty, guardian_id: row.guardianId,
  created_at: row.createdAt, read_by_org_at: row.readBy.org, read_by_counterparty_at: row.readBy.counterparty,
});
const messageParams = (channelId, position, row) => ({ id: row.id, channel_id: channelId, position, created_at: row.ts, sender_kind: row.sender.kind, sender_id: row.sender.id, sender_name: row.sender.name, text: row.text, client_msg_id: row.clientMsgId ?? null });
const attachmentParams = (messageId, a) => (a.kind === 'clip'
  ? { message_id: messageId, kind: 'clip', media_id: a.mediaId, title: a.title, url: a.url, verified_clip: a.verifiedClip ? 1 : 0, report_id: null, org_name: null, summary: null }
  : { message_id: messageId, kind: 'trial_report', media_id: null, title: null, url: null, verified_clip: null, report_id: a.reportId, org_name: a.orgName, summary: a.summary });
const attachmentFromDb = (r) => (r.kind === 'clip'
  ? { kind: 'clip', mediaId: r.media_id, title: r.title, url: r.url, verifiedClip: r.verified_clip === 1 }
  : { kind: 'trial_report', reportId: r.report_id, orgName: r.org_name, summary: r.summary });
const messageFromDb = (r, attachmentRow) => messageRecord({ id: r.id, ts: r.created_at, sender: { kind: r.sender_kind, id: r.sender_id, name: r.sender_name }, text: r.text, attachment: attachmentRow ? attachmentFromDb(attachmentRow) : null, clientMsgId: r.client_msg_id });
const channelFromDb = (r, messages) => ({
  id: r.id, requestId: r.request_id, playerId: r.player_id, playerName: r.player_name, orgId: r.org_id, orgName: r.org_name,
  orgVerified: r.org_verified === null ? null : r.org_verified === 1, scoutName: r.scout_name, scoutRole: r.scout_role, counterparty: r.counterparty,
  guardianId: r.guardian_id, createdAt: r.created_at, messages, readBy: { org: r.read_by_org_at, counterparty: r.read_by_counterparty_at },
});

/** Every channel with its messages (array order) and attachments, in `seq` order: fresh objects from the file. */
function readChannels(sqlite) {
  const attachments = new Map(sqlite.prepare(ATTACHMENT_SELECT).all().map((r) => [r.message_id, r]));
  const byChannel = new Map();
  for (const m of sqlite.prepare(`${MESSAGE_SELECT} ORDER BY channel_id, position`).all()) { if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []); byChannel.get(m.channel_id).push(messageFromDb(m, attachments.get(m.id) ?? null)); }
  return sqlite.prepare(`${CHANNEL_SELECT} ORDER BY seq`).all().map((r) => channelFromDb(r, byChannel.get(r.id) ?? []));
}
/** Write the typed records, in array order (the array position is the durable order). */
function writeChannels(sqlite, rows) {
  sqlite.exec('DELETE FROM channels;'); // the cascades take the messages and the attachments
  const ins = sqlite.prepare(CHANNEL_INSERT); const insM = sqlite.prepare(MESSAGE_INSERT); const insA = sqlite.prepare(ATTACHMENT_INSERT);
  for (const row of rows) {
    ins.run(channelParams(row));
    row.messages.forEach((m, i) => { insM.run(messageParams(row.id, i, m)); if (m.attachment) insA.run(attachmentParams(m.id, m.attachment)); });
  }
  return rows.length;
}
/** The retained requests (the S8a table; `undefined` before migration 0015 is recorded). */
export function readRequestsBlob(sqlite) {
  return recruitmentLive(sqlite) ? readRequests(sqlite) : undefined;
}
const requestIdsOf = (requests) => { const s = new Set(); for (const r of requests) if (isPlainObject(r) && typeof r.id === 'string') s.add(r.id); return s; };
const existingIds = (sqlite, table) => (tableExists(sqlite, table) ? new Set(sqlite.prepare(`SELECT id FROM ${table}`).all().map((r) => r.id)) : new Set());

/**
 * The FINAL-STATE assertion (review §11.5): every channel row in the table names a
 * request present in the final requests (the supplied collection when the snapshot
 * carries `requests`, the retained blob otherwise — never an empty set for an
 * omission), a guardian present in the final guardians table when `guardian_id` is
 * not null, and an organisation present in the final orgs table. Runs inside the
 * caller's transaction; a miss THROWS with ids only, so the whole write rolls back.
 * A no-op before the cutover record exists.
 */
export function assertChannelReferencesConsistent(sqlite, { requests = undefined, label = 'the snapshot' } = {}) {
  if (!channelsLive(sqlite)) return;
  const rows = sqlite.prepare('SELECT id, request_id, guardian_id, org_id FROM channels ORDER BY seq').all();
  if (!rows.length) return;
  const finalRequests = requests === undefined ? readRequestsBlob(sqlite) : requests;
  if (!Array.isArray(finalRequests)) throw refusal('CHANNEL_REQUESTS_MALFORMED', `${rows.length} channel(s) in ${label} reference requests, but the ${requests === undefined ? 'retained requests collection' : 'requests collection supplied with the snapshot'} is ${finalRequests === undefined ? 'absent' : describe(finalRequests)}, not an array; the write was rolled back and nothing was changed`);
  const requestIds = requestIdsOf(finalRequests); const guardianIds = existingIds(sqlite, 'guardians'); const orgIds = existingIds(sqlite, 'orgs');
  const noRequest = rows.filter((r) => !requestIds.has(r.request_id));
  if (noRequest.length) throw refusal('CHANNEL_REQUEST_MISSING', `${noRequest.length} channel(s) in ${label} name a request that is not in the final requests collection (channels ${ids(noRequest.map((r) => r.id))}; requests ${ids([...new Set(noRequest.map((r) => r.request_id))])}); the write was rolled back and nothing was changed — write the snapshot with its requests and channels together, or without the channel`, { channels: noRequest.map((r) => r.id) });
  const noGuardian = rows.filter((r) => r.guardian_id !== null && !guardianIds.has(r.guardian_id));
  if (noGuardian.length) throw refusal('CHANNEL_GUARDIAN_MISSING', `${noGuardian.length} channel(s) in ${label} name a guardian that does not exist in the final guardians table (channels ${ids(noGuardian.map((r) => r.id))}; guardians ${ids([...new Set(noGuardian.map((r) => r.guardian_id))])}); the write was rolled back and nothing was changed — remove the channel with its guardian, or keep the guardian`, { channels: noGuardian.map((r) => r.id) });
  const noOrg = rows.filter((r) => !orgIds.has(r.org_id));
  if (noOrg.length) throw refusal('CHANNEL_ORG_MISSING', `${noOrg.length} channel(s) in ${label} name an organisation that does not exist (channels ${ids(noOrg.map((r) => r.id))}); the write was rolled back and nothing was changed`, { channels: noOrg.map((r) => r.id) });
}
/** The reference checks an INCOMING collection must pass before its rows are written (ids only): requests against `requests`, guardians and organisations against the tables as they stand. */
function checkIncomingReferences(sqlite, rows, { requests, label }) {
  if (!rows.length) return;
  if (!Array.isArray(requests)) throw blocked(`CHANNEL_REQUESTS_MALFORMED: ${rows.length} channel(s) in ${label} reference requests, but the requests collection is ${requests === undefined ? 'absent' : describe(requests)}, not an array`, { code: 'CHANNEL_REQUESTS_MALFORMED' });
  const requestIds = requestIdsOf(requests); const guardianIds = existingIds(sqlite, 'guardians'); const orgIds = existingIds(sqlite, 'orgs');
  const noRequest = rows.filter((r) => !requestIds.has(r.requestId)); if (noRequest.length) throw blocked(`CHANNEL_REQUEST_MISSING: ${noRequest.length} channel(s) in ${label} name a request that is not in the requests collection (channels ${ids(noRequest.map((r) => r.id))}; requests ${ids([...new Set(noRequest.map((r) => r.requestId))])})`, { code: 'CHANNEL_REQUEST_MISSING' });
  const noGuardian = rows.filter((r) => r.guardianId !== null && !guardianIds.has(r.guardianId)); if (noGuardian.length) throw blocked(`CHANNEL_GUARDIAN_MISSING: ${noGuardian.length} channel(s) in ${label} name a guardian that does not exist (channels ${ids(noGuardian.map((r) => r.id))})`, { code: 'CHANNEL_GUARDIAN_MISSING' });
  const noOrg = rows.filter((r) => !orgIds.has(r.orgId)); if (noOrg.length) throw blocked(`CHANNEL_ORG_MISSING: ${noOrg.length} channel(s) in ${label} name an organisation that does not exist (channels ${ids(noOrg.map((r) => r.id))})`, { code: 'CHANNEL_ORG_MISSING' });
}

/**
 * Whole-table access for the tools that treat the file as one snapshot (backups,
 * restores, the persistence suites). Before the cutover record both methods decline
 * (`null` / `false`): the caller keeps the legacy blob. Afterwards `read` returns
 * the channel records, in insertion order, with their messages nested;
 * `replace` types every entry (unknown keys dropped, a wrong-typed value refused), checks the incoming rows' references against the
 * requests the caller passes (the snapshot's own, or the retained blob) and the
 * tables as they stand, rewrites the three tables inside the caller's transaction
 * (array position → seq / position) and refuses the whole write on the first problem.
 * The caller then runs `assertChannelReferencesConsistent` on the FINAL state.
 */
export const CHANNELS_TABLE = {
  name: CHANNELS_COLLECTION,
  read(sqlite) { if (!channelsLive(sqlite)) return null; return readChannels(sqlite); },
  replace(sqlite, rows, { requests = undefined } = {}) {
    if (!channelsLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error('channels: replace() runs inside the caller\'s transaction');
    const v = validateChannelRows(rows, { label: 'the channels snapshot collection' });
    checkIncomingReferences(sqlite, v.rows, { requests: requests === undefined ? readRequestsBlob(sqlite) : requests, label: 'the channels snapshot collection' });
    writeChannels(sqlite, v.rows);
    return true;
  },
};

// ------------------------------------------------------------------ detached copies (the export)
/** A DETACHED copy of a mirror channel (the export shape). */
const copyChannel = (row) => structuredClone(row);
// The unit-of-work snapshot is NOT a detached copy: it is the graph memento of the mirror
// (repositories/memento.mjs — every plain object and array reachable from `rows`, by
// identity, with its own data properties by reference), restored IN PLACE. A clone-and-
// replace restore kept the outer thread but swapped its nested objects, so a held
// `readBy` (or sender, attachment) stayed attached to the failed value (the review of
// 62e9c1a). The mirror never deletes a key inside an operation, so no restore has to
// recreate one.

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a tool, a
 * test, the migration). `staged` selects the server's write mode (see the header); it
 * needs `unit`, and the store must register `saveHook()` — with `unit` given, no
 * operation joins a unit until `saveHook()` was taken. `requests` is an accessor for
 * the authoritative requests collection (the live blob: `() => db.requests`) that
 * `open` checks the transitional reference against; without it `open` refuses.
 */
export function createChannelsRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false, requestExists = null } = {}) {
  if (!sqlite) throw new TypeError('the channels repository needs a SQLite connection (node:sqlite); message threads have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the channels repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the channels repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  if (requestExists !== null && typeof requestExists !== 'function') throw new TypeError('the channels repository takes `requestExists(id)`, the requests repository\'s check that a request exists');
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    channel: sqlite.prepare(CHANNEL_INSERT), message: sqlite.prepare(MESSAGE_INSERT), attachment: sqlite.prepare(ATTACHMENT_INSERT),
    read: { org: sqlite.prepare(READ_UPDATE.org), counterparty: sqlite.prepare(READ_UPDATE.counterparty) },
    deleteForPlayer: sqlite.prepare(DELETE_FOR_PLAYER),
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'), org: sqlite.prepare('SELECT 1 FROM orgs WHERE id = ?'),
  };

  // The mirror: every channel, in insertion order, each with its messages nested in array order.
  const rows = []; const byId = new Map(); const byRequest = new Map();
  const view = readonlyView(rows, 'a message thread');
  const index = () => { byId.clear(); byRequest.clear(); for (const r of rows) { byId.set(r.id, r); byRequest.set(r.requestId, r); } };
  const load = () => { rows.length = 0; if (channelsLive(sqlite)) for (const r of readChannels(sqlite)) rows.push(r); index(); };
  load();

  // Staged mode: the SQL queue, FIFO, drained whole inside every save transaction.
  const pending = []; let inFlight = 0;
  let hookTaken = false;
  const inUnit = () => !!unit?.active?.();
  const hookRefusal = (what) => new Error(`channels: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the queued statements and how a unit of work's rollback restores this repository's memory`);
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
      if (sqlite.isTransaction) throw new Error('channels: the staged repository cannot take part in a transaction it did not open (the server\'s transactions are units of work or snapshot saves)');
      return fn((op) => { pending.push(op); });
    }
    const body = () => fn((op) => op());
    if (sqlite.isTransaction) return body(); // caller-owned: see reload()
    const state = repo.snapshotState();
    try { return transaction(sqlite, body); } catch (err) { repo.restoreState(state); throw err; }
  };
  const messageCount = () => rows.reduce((n, r) => n + r.messages.length, 0);

  const repo = {
    /** Boot: refuse to run without the cutover record; (re)load the mirror; report counts (never a value). */
    attach() {
      if (!stmt.cutover.get(CHANNELS_MIGRATION)) throw new Error(`channels: the cutover record ${CHANNELS_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      log(`channels: ${rows.length} thread(s) with ${messageCount()} message(s) loaded from the tables`);
      return { engine: 'sqlite', channels: rows.length, messages: messageCount() };
    },
    /** Re-read the mirror from the tables (a tool that rolled back a raw transaction of its own must call this). */
    reload() { load(); return rows.length; },
    view,
    count: () => rows.length,
    counts: () => ({ channels: rows.length, messages: messageCount(), attachments: rows.reduce((n, r) => n + r.messages.filter((m) => m.attachment).length, 0) }),
    /** Staged writes not yet in a committed save (0 in immediate mode). */
    pending: () => pending.length,
    byId: (id) => { const r = byId.get(id); return r ? readonlyView(r, 'a message thread') : null; },

    /**
     * A new thread at the end, in the channel literal (typed: unknown keys dropped, a
     * wrong-typed value refused by field). The TRANSITIONAL CHECKED REFERENCE (D-A): the requestId must be the id
     * of a request in the authoritative requests collection and no other channel may
     * carry it; the organisation must exist; a guardian, when named, must exist.
     * Returns the thread (read-only).
     */
    open(raw) {
      return operation((exec) => {
        const v = typeChannel(raw); if (!v.ok) throw new TypeError(`a message thread needs the channel literal: ${v.reason}`);
        const row = v.row;
        if (byId.has(row.id)) throw new Error(`channels: a thread with id ${row.id} already exists`);
        if (byRequest.has(row.requestId)) throw new Error(`channels: request ${row.requestId} already opened thread ${byRequest.get(row.requestId).id}; a request opens one thread`);
        if (typeof requestExists !== 'function') throw new Error('channels: open() needs the requests repository to check the request reference (the repository was created without `requestExists`)');
        if (!requestExists(row.requestId)) throw refusal('CHANNEL_REQUEST_MISSING', `channels: request ${row.requestId} is not in the requests collection; a thread opens only for an existing request`);
        if (!stmt.org.get(row.orgId)) throw refusal('CHANNEL_ORG_MISSING', `channels: organisation ${row.orgId} does not exist`);
        if (row.guardianId !== null && !stmt.guardian.get(row.guardianId)) throw refusal('CHANNEL_GUARDIAN_MISSING', `channels: guardian ${row.guardianId} does not exist`);
        rows.push(row); byId.set(row.id, row); byRequest.set(row.requestId, row);
        const params = channelParams(row); const messages = row.messages.map((m, i) => [messageParams(row.id, i, m), m.attachment ? attachmentParams(m.id, m.attachment) : null]);
        exec(() => { stmt.channel.run(params); for (const [mp, ap] of messages) { stmt.message.run(mp); if (ap) stmt.attachment.run(ap); } });
        return readonlyView(row, 'a message thread');
      });
    },
    /** A new message at the END of the thread, in the message literal (the caller — postMessage — keeps its duplicate-clientMsgId rule by reading the view first). Returns the message (read-only). */
    appendMessage(channelId, raw) {
      return operation((exec) => {
        const row = byId.get(channelId); if (!row) throw new Error(`channels: no thread ${channelId} to append to`);
        const v = typeMessage(raw); if (!v.ok) throw new TypeError(`a message needs the message literal: ${v.reason}`);
        if (row.messages.some((m) => m.id === v.row.id)) throw new Error(`channels: thread ${channelId} already holds message ${v.row.id}`);
        const msg = v.row; const position = row.messages.length; row.messages.push(msg);
        const mp = messageParams(row.id, position, msg); const ap = msg.attachment ? attachmentParams(msg.id, msg.attachment) : null;
        exec(() => { stmt.message.run(mp); if (ap) stmt.attachment.run(ap); });
        return readonlyView(msg, 'a message');
      });
    },
    /** A read receipt: `side` is 'org' or 'counterparty', `at` an integer timestamp (the route's Date.now()). Returns the receipts (read-only). */
    markRead(channelId, side, at) {
      return operation((exec) => {
        const row = byId.get(channelId); if (!row) throw new Error(`channels: no thread ${channelId} to mark read`);
        if (!READ_BY_KEYS.includes(side)) throw new TypeError(`channels: a receipt side is 'org' or 'counterparty', not ${describe(side)}`);
        if (!isInt(at)) throw new TypeError('channels: a receipt needs an integer timestamp');
        row.readBy[side] = at;
        exec(() => stmt.read[side].run(at, row.id));
        return readonlyView(row.readBy, 'a message thread');
      });
    },
    /**
     * Today's deletion behaviour, reproduced (D-B): every thread of the player —
     * guardian–club threads included — goes with its messages, attachments and
     * receipts, inside the caller's unit of work (the account-deletion unit). No
     * retention rule is introduced. Returns `{ channels, messages }` removed.
     */
    deleteForPlayer(playerId) {
      return operation((exec) => {
        if (!nonEmpty(playerId)) throw new TypeError('channels: deleteForPlayer needs a player id');
        const removed = rows.filter((r) => r.playerId === playerId);
        if (!removed.length) return { channels: 0, messages: 0 };
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].playerId === playerId) rows.splice(i, 1);
        index();
        exec(() => { stmt.deleteForPlayer.run(playerId); });
        return { channels: removed.length, messages: removed.reduce((n, r) => n + r.messages.length, 0) };
      });
    },
    /** Every thread (the literal's keys in the writer's order; messages nested in order), detached (the admin backup). */
    exportRows: () => rows.map(copyChannel),

    // ---------------------------------------------------------- the save hook (staged mode)
    flush() {
      if (!sqlite.isTransaction) throw new Error('channels.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      for (const op of pending) op();
      inFlight = pending.length;
      return inFlight;
    },
    commit() { pending.splice(0, inFlight); inFlight = 0; },
    rollback() { inFlight = 0; },
    /**
     * Unit-of-work participation: the graph memento of the whole mirror (the thread list,
     * every thread, its receipts, its messages, each sender and attachment — by identity,
     * restored IN PLACE so every held view, nested ones included, reads the pre-unit
     * state) and the queue length when the unit began. Objects added during the unit (a
     * new thread, a new message) are no longer referenced once their parents are
     * restored; nothing is cloned. A failed ORDINARY save never
     * reaches here: its mirror and queue are the intended state (see the header).
     */
    snapshotState: () => ({ pendingLength: pending.length, graph: captureGraph([rows]) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; inFlight = 0;
      restoreGraph(state.graph);
      index();
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
