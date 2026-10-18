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
 * LOSSLESS, AT EVERY LEVEL (review of 46e5afe). Every present, JSON-compatible own
 * field a record carries that the mapping does not name is preserved — in
 * `extra_json` of the channel, the message or the attachment; the unknown own keys
 * INSIDE the known nested objects `readBy` and `sender` are kept under those known
 * key names inside the parent's `extra_json` (a known key never collides with an
 * unknown one). `orgUserIdForNotify` — never written by the current creator but
 * observable through the spread-based views and the export when a legacy record
 * carries it — is one such field, preserved exactly. Extras are spread back FIRST on
 * export (the S7a/S7b/S7c convention); copies are detached and prototype-safe (an
 * own "__proto__" key is data, `setOwn`). ABSENCE IS PRESERVED AS ABSENCE: the
 * optional literal keys (`playerName`, `orgVerified`, `scoutName`, `scoutRole`,
 * `guardianId`, `readBy.org`, `readBy.counterparty`, a message's `attachment`) may be
 * present-and-null or absent; a NULL column alone cannot tell the two apart, so the
 * row's `absent_keys_json` lists the literal keys that were ABSENT (NULL when every
 * key was present — the common case) and the way back manufactures no null and
 * drops no present value. A message's `clientMsgId` follows the writer's own rule:
 * present ⇔ a non-empty string, absent ⇔ NULL. Nothing is coerced, no vocabulary is
 * narrowed beyond the literal's own (`counterparty`, `sender.kind`, the attachment
 * `kind` — the three sets the writers produce), and a non-finite number inside a
 * live unknown field is kept live and persisted as the blob's JSON would have
 * written it (null; the S7c rule), never a refusal of the whole record.
 *
 * THE ORDERING KEYS. The channel list every reader sees is `db.channels` array
 * order: `seq INTEGER PRIMARY KEY`, assigned at insert, preserved by the migration
 * (array position), by backup/restore and by the rollback (rows written back in
 * `seq` order). A thread's messages are array order: `position` per channel (array
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
 * state, held views included. Deletion joins the deletion unit.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0012_channels` in `data_migrations`, never by the tables existing or by row
 * counts. Refusals (CHANNELS_IMPORT_BLOCKED and the reference codes) name
 * collections, positions, ids and reasons — never a message text, a name or an
 * address.
 */
import { readonlyView } from './readonly.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { cloneJson, NON_FINITE_KEPT } from './outboxPush.mjs';

export const CHANNELS_MIGRATION = '0012_channels';
/** `meta` key holding the cutover record: counts only, never data. */
export const CHANNELS_CUTOVER_META = 'channelsCutover';
export const CHANNELS_TABLES = Object.freeze(['channels', 'messages', 'message_attachments']);
/** The blob collection the three tables replace. */
export const CHANNELS_COLLECTION = 'channels';

const EXTRA_CHECK = "CHECK (extra_json IS NULL OR (json_valid(extra_json) AND json_type(extra_json) = 'object'))";
const ABSENT_CHECK = "CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array'))";
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
  read_by_counterparty_at INTEGER,
  absent_keys_json        TEXT ${ABSENT_CHECK},
  extra_json              TEXT ${EXTRA_CHECK}
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
  client_msg_id    TEXT,
  absent_keys_json TEXT ${ABSENT_CHECK},
  extra_json       TEXT ${EXTRA_CHECK}
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
  extra_json    TEXT ${EXTRA_CHECK},
  CHECK ((kind = 'clip' AND media_id IS NOT NULL AND verified_clip IS NOT NULL AND report_id IS NULL AND org_name IS NULL AND summary IS NULL)
      OR (kind = 'trial_report' AND report_id IS NOT NULL AND media_id IS NULL AND title IS NULL AND url IS NULL AND verified_clip IS NULL))
) STRICT;`;

export const channelsLive = (sqlite) => migrationApplied(sqlite, CHANNELS_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`CHANNELS_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'CHANNELS_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
/** A detached, prototype-safe clone; a non-finite number in live unknown data is kept live (persisted as JSON null, the blob's rule). */
const clone = (v, at) => cloneJson(v, at, NON_FINITE_KEPT);
const parseJson = (text, at) => clone(JSON.parse(text), at).value;
const ids = (list) => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');

// ------------------------------------------------------------------ the literals
/** The channel literal's keys, in openChannel's order. */
export const CHANNEL_KEYS = Object.freeze(['id', 'requestId', 'playerId', 'playerName', 'orgId', 'orgName', 'orgVerified', 'scoutName', 'scoutRole', 'counterparty', 'guardianId', 'createdAt', 'messages', 'readBy']);
/** The optional channel keys: present-and-null or absent, both preserved (absence recorded in absent_keys_json). */
const CHANNEL_OPTIONAL = Object.freeze(['playerName', 'orgVerified', 'scoutName', 'scoutRole', 'guardianId']);
const READ_BY_KEYS = Object.freeze(['org', 'counterparty']);
/** The message literal's keys, in postMessage's order (`clientMsgId` present only when the client sent one). */
export const MESSAGE_KEYS = Object.freeze(['id', 'ts', 'sender', 'text', 'attachment', 'clientMsgId']);
const SENDER_KEYS = Object.freeze(['kind', 'id', 'name']);
const SENDER_KINDS = Object.freeze(['player', 'guardian', 'org_user']);
export const CLIP_KEYS = Object.freeze(['kind', 'mediaId', 'title', 'url', 'verifiedClip']);
export const TRIAL_REPORT_KEYS = Object.freeze(['kind', 'reportId', 'orgName', 'summary']);

/** The unknown own keys of `raw` (outside `known`), each a detached clone: `{ extra, hasExtra }` or `{ reason }`. */
function extrasOf(raw, known, at) {
  const extra = {};
  for (const k of Object.keys(raw)) if (!known.includes(k)) { const c = clone(raw[k], `${at}.${k}`); if (c.reason) return { reason: c.reason }; setOwn(extra, k, c.value); }
  return { extra, hasExtra: Object.keys(extra).length > 0 };
}
/** A mirror object: extras first (the export convention), then the literal's present keys in the writer's order. */
function assemble(extra, literal) { const row = {}; for (const k of Object.keys(extra)) setOwn(row, k, extra[k]); for (const [k, v] of literal) row[k] = v; return row; }
const optionalString = (v) => v === null || typeof v === 'string';

/** Validate one attachment value: `{ ok: true, value, kind, hasExtra }` (null allowed) or `{ ok: false, reason }`. */
export function validateAttachment(raw, at = 'attachment') {
  if (raw === null) return { ok: true, value: null, kind: null, hasExtra: false };
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} must be null or an object (got ${describe(raw)})` };
  if (raw.kind === 'clip') {
    for (const k of CLIP_KEYS) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${at}.${k} is absent (a clip attachment always carries ${CLIP_KEYS.join(', ')})` };
    if (!nonEmpty(raw.mediaId)) return { ok: false, reason: `${at}.mediaId must be a non-empty string` };
    if (!optionalString(raw.title)) return { ok: false, reason: `${at}.title must be a string or null` };
    if (!optionalString(raw.url)) return { ok: false, reason: `${at}.url must be a string or null` };
    if (typeof raw.verifiedClip !== 'boolean') return { ok: false, reason: `${at}.verifiedClip must be a boolean` };
    const e = extrasOf(raw, CLIP_KEYS, at); if (e.reason) return { ok: false, reason: e.reason };
    return { ok: true, kind: 'clip', hasExtra: e.hasExtra, value: assemble(e.extra, [['kind', 'clip'], ['mediaId', raw.mediaId], ['title', raw.title], ['url', raw.url], ['verifiedClip', raw.verifiedClip]]) };
  }
  if (raw.kind === 'trial_report') {
    for (const k of TRIAL_REPORT_KEYS) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${at}.${k} is absent (a trial-report attachment always carries ${TRIAL_REPORT_KEYS.join(', ')})` };
    if (!nonEmpty(raw.reportId)) return { ok: false, reason: `${at}.reportId must be a non-empty string` };
    if (!optionalString(raw.orgName)) return { ok: false, reason: `${at}.orgName must be a string or null` };
    if (!optionalString(raw.summary)) return { ok: false, reason: `${at}.summary must be a string or null` };
    const e = extrasOf(raw, TRIAL_REPORT_KEYS, at); if (e.reason) return { ok: false, reason: e.reason };
    return { ok: true, kind: 'trial_report', hasExtra: e.hasExtra, value: assemble(e.extra, [['kind', 'trial_report'], ['reportId', raw.reportId], ['orgName', raw.orgName], ['summary', raw.summary]]) };
  }
  return { ok: false, reason: `${at}.kind must be 'clip' or 'trial_report' (the two shapes buildAttachment produces)` };
}

/** Validate one message entry: `{ ok: true, row, absent, hasExtra, attachmentKind }` (the mirror row, detached) or `{ ok: false, reason }`. */
export function validateMessage(raw, at = 'message') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  for (const k of ['id', 'ts', 'sender', 'text']) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${at}.${k} is absent (the message literal always carries id, ts, sender and text)` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (!isInt(raw.ts)) return { ok: false, reason: `${at}.ts must be an integer timestamp` };
  if (!isPlainObject(raw.sender)) return { ok: false, reason: `${at}.sender must be an object { kind, id, name } (got ${describe(raw.sender)})` };
  if (!SENDER_KINDS.includes(raw.sender.kind)) return { ok: false, reason: `${at}.sender.kind must be one of ${SENDER_KINDS.join(', ')}` };
  if (!nonEmpty(raw.sender.id)) return { ok: false, reason: `${at}.sender.id must be a non-empty string` };
  if (Object.hasOwn(raw.sender, 'name') && !optionalString(raw.sender.name)) return { ok: false, reason: `${at}.sender.name must be a string or null` };
  const se = extrasOf(raw.sender, SENDER_KEYS, `${at}.sender`); if (se.reason) return { ok: false, reason: se.reason };
  if (typeof raw.text !== 'string') return { ok: false, reason: `${at}.text must be a string` };
  const absent = [];
  let attachment = null; let attachmentKind = null; let attachmentExtra = false;
  if (Object.hasOwn(raw, 'attachment')) { const a = validateAttachment(raw.attachment, `${at}.attachment`); if (!a.ok) return { ok: false, reason: a.reason }; attachment = a.value; attachmentKind = a.kind; attachmentExtra = a.hasExtra; } else absent.push('attachment');
  if (Object.hasOwn(raw, 'clientMsgId') && !nonEmpty(raw.clientMsgId)) return { ok: false, reason: `${at}.clientMsgId must be a non-empty string when present (the writer omits the key otherwise)` };
  const e = extrasOf(raw, MESSAGE_KEYS, at); if (e.reason) return { ok: false, reason: e.reason };
  const sender = assemble(se.extra, [['kind', raw.sender.kind], ['id', raw.sender.id], ...(Object.hasOwn(raw.sender, 'name') ? [['name', raw.sender.name]] : [])]);
  if (!Object.hasOwn(raw.sender, 'name')) absent.push('sender.name');
  const literal = [['id', raw.id], ['ts', raw.ts], ['sender', sender], ['text', raw.text]];
  if (Object.hasOwn(raw, 'attachment')) literal.push(['attachment', attachment]);
  if (Object.hasOwn(raw, 'clientMsgId')) literal.push(['clientMsgId', raw.clientMsgId]);
  return { ok: true, absent, hasExtra: e.hasExtra || se.hasExtra || attachmentExtra, attachmentKind, row: assemble(e.extra, literal) };
}

/**
 * Validate one channel entry (its messages included): `{ ok: true, row, absent, hasExtra, messages: [{ absent, hasExtra, attachmentKind }] }`
 * — the mirror row, detached, with `messages` the array of mirror message rows and `readBy` the receipt object — or `{ ok: false, reason }`.
 */
export function validateChannel(raw, at = 'channel') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  for (const k of ['id', 'requestId', 'playerId', 'orgId', 'orgName', 'counterparty', 'createdAt', 'messages', 'readBy']) if (!Object.hasOwn(raw, k)) return { ok: false, reason: `${at}.${k} is absent (the channel literal always carries it)` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (!nonEmpty(raw.requestId)) return { ok: false, reason: `${at}.requestId must be a non-empty string` };
  if (!nonEmpty(raw.playerId)) return { ok: false, reason: `${at}.playerId must be a non-empty string` };
  if (!nonEmpty(raw.orgId)) return { ok: false, reason: `${at}.orgId must be a non-empty string` };
  if (typeof raw.orgName !== 'string') return { ok: false, reason: `${at}.orgName must be a string` };
  if (raw.counterparty !== 'player' && raw.counterparty !== 'guardian') return { ok: false, reason: `${at}.counterparty must be 'player' or 'guardian'` };
  if (!isInt(raw.createdAt)) return { ok: false, reason: `${at}.createdAt must be an integer timestamp` };
  if (!Array.isArray(raw.messages)) return { ok: false, reason: `${at}.messages must be an array (got ${describe(raw.messages)})` };
  if (!isPlainObject(raw.readBy)) return { ok: false, reason: `${at}.readBy must be an object { org, counterparty } (got ${describe(raw.readBy)})` };
  const absent = [];
  const optional = [];
  for (const k of CHANNEL_OPTIONAL) {
    if (!Object.hasOwn(raw, k)) { absent.push(k); continue; }
    const v = raw[k];
    if (k === 'orgVerified') { if (v !== null && typeof v !== 'boolean') return { ok: false, reason: `${at}.orgVerified must be a boolean or null` }; }
    else if (k === 'guardianId') { if (v !== null && !nonEmpty(v)) return { ok: false, reason: `${at}.guardianId must be a non-empty string or null` }; }
    else if (!optionalString(v)) return { ok: false, reason: `${at}.${k} must be a string or null` };
    optional.push([k, v]);
  }
  for (const k of READ_BY_KEYS) {
    if (!Object.hasOwn(raw.readBy, k)) { absent.push(`readBy.${k}`); continue; }
    if (raw.readBy[k] !== null && !isInt(raw.readBy[k])) return { ok: false, reason: `${at}.readBy.${k} must be an integer timestamp or null` };
  }
  const re = extrasOf(raw.readBy, READ_BY_KEYS, `${at}.readBy`); if (re.reason) return { ok: false, reason: re.reason };
  const e = extrasOf(raw, CHANNEL_KEYS, at); if (e.reason) return { ok: false, reason: e.reason };
  const messages = []; const messageMeta = []; const seen = new Set();
  for (let i = 0; i < raw.messages.length; i++) {
    const m = validateMessage(raw.messages[i], `${at}.messages[${i}]`); if (!m.ok) return { ok: false, reason: m.reason };
    if (seen.has(m.row.id)) return { ok: false, reason: `${at}.messages[${i}] duplicates the id of an earlier message (${m.row.id})` };
    seen.add(m.row.id); messages.push(m.row); messageMeta.push({ absent: m.absent, hasExtra: m.hasExtra, attachmentKind: m.attachmentKind });
  }
  const readBy = assemble(re.extra, READ_BY_KEYS.filter((k) => Object.hasOwn(raw.readBy, k)).map((k) => [k, raw.readBy[k]]));
  const literal = [['id', raw.id], ['requestId', raw.requestId], ['playerId', raw.playerId]];
  const opt = Object.fromEntries(optional);
  for (const k of CHANNEL_KEYS.slice(3)) {
    if (k === 'messages') literal.push(['messages', messages]);
    else if (k === 'readBy') literal.push(['readBy', readBy]);
    else if (CHANNEL_OPTIONAL.includes(k)) { if (Object.hasOwn(opt, k)) literal.push([k, opt[k]]); }
    else literal.push([k, raw[k]]);
  }
  return { ok: true, absent, hasExtra: e.hasExtra || re.hasExtra, messages: messageMeta, row: assemble(e.extra, literal) };
}

/** Validate a whole channels collection (unique ids, unique requestIds); throws CHANNELS_IMPORT_BLOCKED. Returns `{ rows, counts }`. */
export function validateChannelRows(rows, { label = 'channels' } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const seenIds = new Set(); const seenRequests = new Map();
  const counts = { imported: 0, messages: 0, attachments: 0, withExtraFields: 0, withAbsentKeys: 0, byCounterparty: {} };
  rows.forEach((raw, i) => {
    const v = validateChannel(raw, `${label} entry #${i}`);
    if (!v.ok) { problems.push(v.reason); return; }
    if (seenIds.has(v.row.id)) { problems.push(`${label} entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; }
    if (seenRequests.has(v.row.requestId)) { problems.push(`${label} entry #${i}: a second channel for request ${v.row.requestId} (the first is ${seenRequests.get(v.row.requestId)}); a request opens one channel`); return; }
    seenIds.add(v.row.id); seenRequests.set(v.row.requestId, v.row.id);
    if (v.hasExtra || v.messages.some((m) => m.hasExtra)) counts.withExtraFields += 1;
    if (v.absent.length || v.messages.some((m) => m.absent.length)) counts.withAbsentKeys += 1;
    counts.messages += v.row.messages.length; counts.attachments += v.messages.filter((m) => m.attachmentKind).length;
    counts.byCounterparty[v.row.counterparty] = (counts.byCounterparty[v.row.counterparty] ?? 0) + 1;
    out.push({ row: v.row, absent: v.absent, messages: v.messages });
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  counts.imported = out.length;
  return { rows: out, counts };
}

// ------------------------------------------------------------------ rows ↔ the tables
const CHANNEL_SELECT = 'SELECT seq, id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, read_by_org_at, read_by_counterparty_at, absent_keys_json, extra_json FROM channels';
const CHANNEL_INSERT = 'INSERT INTO channels (id, request_id, player_id, player_name, org_id, org_name, org_verified, scout_name, scout_role, counterparty, guardian_id, created_at, read_by_org_at, read_by_counterparty_at, absent_keys_json, extra_json) VALUES (@id, @request_id, @player_id, @player_name, @org_id, @org_name, @org_verified, @scout_name, @scout_role, @counterparty, @guardian_id, @created_at, @read_by_org_at, @read_by_counterparty_at, @absent_keys_json, @extra_json)';
const MESSAGE_SELECT = 'SELECT seq, id, channel_id, position, created_at, sender_kind, sender_id, sender_name, text, client_msg_id, absent_keys_json, extra_json FROM messages';
const MESSAGE_INSERT = 'INSERT INTO messages (id, channel_id, position, created_at, sender_kind, sender_id, sender_name, text, client_msg_id, absent_keys_json, extra_json) VALUES (@id, @channel_id, @position, @created_at, @sender_kind, @sender_id, @sender_name, @text, @client_msg_id, @absent_keys_json, @extra_json)';
const ATTACHMENT_SELECT = 'SELECT message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary, extra_json FROM message_attachments';
const ATTACHMENT_INSERT = 'INSERT INTO message_attachments (message_id, kind, media_id, title, url, verified_clip, report_id, org_name, summary, extra_json) VALUES (@message_id, @kind, @media_id, @title, @url, @verified_clip, @report_id, @org_name, @summary, @extra_json)';
const READ_UPDATE = { org: 'UPDATE channels SET read_by_org_at = ?, absent_keys_json = ? WHERE id = ?', counterparty: 'UPDATE channels SET read_by_counterparty_at = ?, absent_keys_json = ? WHERE id = ?' };
const DELETE_FOR_PLAYER = 'DELETE FROM channels WHERE player_id = ?';

const jsonOrNull = (obj) => (Object.keys(obj).length ? JSON.stringify(obj) : null);
const extraJsonOf = (row, known) => { const extra = {}; for (const k of Object.keys(row)) if (!known.includes(k)) setOwn(extra, k, clone(row[k], k).value); return extra; };
const bool = (v) => (v === null || v === undefined ? null : v ? 1 : 0);
/** The literal keys ABSENT from a mirror channel (what absent_keys_json records). */
const channelAbsent = (row) => [...CHANNEL_OPTIONAL.filter((k) => !Object.hasOwn(row, k)), ...READ_BY_KEYS.filter((k) => !Object.hasOwn(row.readBy, k)).map((k) => `readBy.${k}`)];
const messageAbsent = (row) => [...(Object.hasOwn(row, 'attachment') ? [] : ['attachment']), ...(Object.hasOwn(row.sender, 'name') ? [] : ['sender.name'])];
function channelParams(row) {
  const extra = extraJsonOf(row, CHANNEL_KEYS);
  const readByExtra = extraJsonOf(row.readBy, READ_BY_KEYS);
  if (Object.keys(readByExtra).length) setOwn(extra, 'readBy', readByExtra);
  const absent = channelAbsent(row);
  return {
    id: row.id, request_id: row.requestId, player_id: row.playerId, player_name: row.playerName ?? null, org_id: row.orgId, org_name: row.orgName,
    org_verified: bool(row.orgVerified), scout_name: row.scoutName ?? null, scout_role: row.scoutRole ?? null, counterparty: row.counterparty, guardian_id: row.guardianId ?? null,
    created_at: row.createdAt, read_by_org_at: row.readBy.org ?? null, read_by_counterparty_at: row.readBy.counterparty ?? null,
    absent_keys_json: absent.length ? JSON.stringify(absent) : null, extra_json: jsonOrNull(extra),
  };
}
function messageParams(channelId, position, row) {
  const extra = extraJsonOf(row, MESSAGE_KEYS);
  const senderExtra = extraJsonOf(row.sender, SENDER_KEYS);
  if (Object.keys(senderExtra).length) setOwn(extra, 'sender', senderExtra);
  const absent = messageAbsent(row);
  return { id: row.id, channel_id: channelId, position, created_at: row.ts, sender_kind: row.sender.kind, sender_id: row.sender.id, sender_name: row.sender.name ?? null, text: row.text, client_msg_id: Object.hasOwn(row, 'clientMsgId') ? row.clientMsgId : null, absent_keys_json: absent.length ? JSON.stringify(absent) : null, extra_json: jsonOrNull(extra) };
}
function attachmentParams(messageId, a) {
  const known = a.kind === 'clip' ? CLIP_KEYS : TRIAL_REPORT_KEYS;
  return a.kind === 'clip'
    ? { message_id: messageId, kind: 'clip', media_id: a.mediaId, title: a.title, url: a.url, verified_clip: a.verifiedClip ? 1 : 0, report_id: null, org_name: null, summary: null, extra_json: jsonOrNull(extraJsonOf(a, known)) }
    : { message_id: messageId, kind: 'trial_report', media_id: null, title: null, url: null, verified_clip: null, report_id: a.reportId, org_name: a.orgName, summary: a.summary, extra_json: jsonOrNull(extraJsonOf(a, known)) };
}
function attachmentFromDb(r) {
  const extra = r.extra_json ? parseJson(r.extra_json, 'extra_json') : {};
  return r.kind === 'clip'
    ? assemble(extra, [['kind', 'clip'], ['mediaId', r.media_id], ['title', r.title], ['url', r.url], ['verifiedClip', r.verified_clip === 1]])
    : assemble(extra, [['kind', 'trial_report'], ['reportId', r.report_id], ['orgName', r.org_name], ['summary', r.summary]]);
}
function messageFromDb(r, attachmentRow) {
  const extraAll = r.extra_json ? parseJson(r.extra_json, 'extra_json') : {};
  const absent = r.absent_keys_json ? JSON.parse(r.absent_keys_json) : [];
  const senderExtra = Object.hasOwn(extraAll, 'sender') ? extraAll.sender : {};
  const extra = {}; for (const k of Object.keys(extraAll)) if (k !== 'sender') setOwn(extra, k, extraAll[k]);
  const sender = assemble(senderExtra, [['kind', r.sender_kind], ['id', r.sender_id], ...(absent.includes('sender.name') ? [] : [['name', r.sender_name]])]);
  const literal = [['id', r.id], ['ts', r.created_at], ['sender', sender], ['text', r.text]];
  if (!absent.includes('attachment')) literal.push(['attachment', attachmentRow ? attachmentFromDb(attachmentRow) : null]);
  if (r.client_msg_id !== null) literal.push(['clientMsgId', r.client_msg_id]);
  return assemble(extra, literal);
}
function channelFromDb(r, messages) {
  const extraAll = r.extra_json ? parseJson(r.extra_json, 'extra_json') : {};
  const absent = r.absent_keys_json ? JSON.parse(r.absent_keys_json) : [];
  const readByExtra = Object.hasOwn(extraAll, 'readBy') ? extraAll.readBy : {};
  const extra = {}; for (const k of Object.keys(extraAll)) if (k !== 'readBy') setOwn(extra, k, extraAll[k]);
  const readBy = assemble(readByExtra, READ_BY_KEYS.filter((k) => !absent.includes(`readBy.${k}`)).map((k) => [k, k === 'org' ? r.read_by_org_at : r.read_by_counterparty_at]));
  const optional = { playerName: r.player_name, orgVerified: r.org_verified === null ? null : r.org_verified === 1, scoutName: r.scout_name, scoutRole: r.scout_role, guardianId: r.guardian_id };
  const literal = [['id', r.id], ['requestId', r.request_id], ['playerId', r.player_id]];
  for (const k of CHANNEL_KEYS.slice(3)) {
    if (k === 'messages') literal.push(['messages', messages]);
    else if (k === 'readBy') literal.push(['readBy', readBy]);
    else if (CHANNEL_OPTIONAL.includes(k)) { if (!absent.includes(k)) literal.push([k, optional[k]]); }
    else literal.push([k, k === 'orgId' ? r.org_id : k === 'orgName' ? r.org_name : k === 'counterparty' ? r.counterparty : r.created_at]);
  }
  return assemble(extra, literal);
}

/** Every channel with its messages (array order) and attachments, in `seq` order: fresh objects from the file. */
function readChannels(sqlite) {
  const attachments = new Map(sqlite.prepare(ATTACHMENT_SELECT).all().map((r) => [r.message_id, r]));
  const byChannel = new Map();
  for (const m of sqlite.prepare(`${MESSAGE_SELECT} ORDER BY channel_id, position`).all()) { if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []); byChannel.get(m.channel_id).push(messageFromDb(m, attachments.get(m.id) ?? null)); }
  return sqlite.prepare(`${CHANNEL_SELECT} ORDER BY seq`).all().map((r) => channelFromDb(r, byChannel.get(r.id) ?? []));
}
/** Write the validated mirror rows, in array order (the array position is the durable order). */
function writeChannels(sqlite, rows) {
  sqlite.exec('DELETE FROM channels;'); // the cascades take the messages and the attachments
  const ins = sqlite.prepare(CHANNEL_INSERT); const insM = sqlite.prepare(MESSAGE_INSERT); const insA = sqlite.prepare(ATTACHMENT_INSERT);
  for (const row of rows) {
    ins.run(channelParams(row));
    row.messages.forEach((m, i) => { insM.run(messageParams(row.id, i, m)); if (m.attachment) insA.run(attachmentParams(m.id, m.attachment)); });
  }
  return rows.length;
}
/** The retained `requests` blob as the file holds it: `undefined` when the collection does not exist, the parsed value otherwise (the callers require an array; `null` when the blob is not valid JSON). */
export function readRequestsBlob(sqlite) {
  if (!tableExists(sqlite, 'collections')) return undefined;
  const row = sqlite.prepare("SELECT value FROM collections WHERE name = 'requests'").get();
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return null; }
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
  const noRequest = rows.filter((r) => !requestIds.has(r.row.requestId)); if (noRequest.length) throw blocked(`CHANNEL_REQUEST_MISSING: ${noRequest.length} channel(s) in ${label} name a request that is not in the requests collection (channels ${ids(noRequest.map((r) => r.row.id))}; requests ${ids([...new Set(noRequest.map((r) => r.row.requestId))])})`, { code: 'CHANNEL_REQUEST_MISSING' });
  const noGuardian = rows.filter((r) => Object.hasOwn(r.row, 'guardianId') && r.row.guardianId !== null && !guardianIds.has(r.row.guardianId)); if (noGuardian.length) throw blocked(`CHANNEL_GUARDIAN_MISSING: ${noGuardian.length} channel(s) in ${label} name a guardian that does not exist (channels ${ids(noGuardian.map((r) => r.row.id))})`, { code: 'CHANNEL_GUARDIAN_MISSING' });
  const noOrg = rows.filter((r) => !orgIds.has(r.row.orgId)); if (noOrg.length) throw blocked(`CHANNEL_ORG_MISSING: ${noOrg.length} channel(s) in ${label} name an organisation that does not exist (channels ${ids(noOrg.map((r) => r.row.id))})`, { code: 'CHANNEL_ORG_MISSING' });
}

/**
 * Whole-table access for the tools that treat the file as one snapshot (backups,
 * restores, the persistence suites). Before the cutover record both methods decline
 * (`null` / `false`): the caller keeps the legacy blob. Afterwards `read` returns
 * the channels in the legacy shape, in insertion order, with their messages nested;
 * `replace` validates every entry, checks the incoming rows' references against the
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
    writeChannels(sqlite, v.rows.map((r) => r.row));
    return true;
  },
};

/**
 * Import the legacy (or exported) `channels` blob into the three tables, inside the
 * migration's transaction: validation of every entry and every nested message and
 * attachment, the reference checks against the file's `requests` blob and the
 * guardians/orgs tables, insertion in array order, the blob row retired. An absent
 * blob imports nothing; an empty array imports nothing; a non-array or non-JSON blob
 * refuses the step. Returns the counts the migration records in `meta` (never a value).
 */
export function importChannelsBlob(sqlite) {
  const hasCollections = tableExists(sqlite, 'collections');
  const row = hasCollections ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(CHANNELS_COLLECTION) : null;
  const counts = { imported: 0, messages: 0, attachments: 0, withExtraFields: 0, withAbsentKeys: 0, byCounterparty: {} };
  if (!row) return counts;
  let parsed; try { parsed = JSON.parse(row.value); } catch { throw blocked('the channels blob is not valid JSON'); }
  const v = validateChannelRows(parsed, { label: 'the channels blob' });
  checkIncomingReferences(sqlite, v.rows, { requests: readRequestsBlob(sqlite), label: 'the channels blob' });
  writeChannels(sqlite, v.rows.map((r) => r.row));
  sqlite.prepare('DELETE FROM collections WHERE name = ?').run(CHANNELS_COLLECTION);
  return { ...counts, ...v.counts };
}

// ------------------------------------------------------------------ detached copies and in-place restore
const copyMessage = (m) => { const c = {}; for (const k of Object.keys(m)) setOwn(c, k, clone(m[k], k).value); return c; };
/** A DETACHED copy of a mirror channel (the export shape): every key cloned, the messages array cloned message by message. */
const copyChannel = (row) => { const c = {}; for (const k of Object.keys(row)) setOwn(c, k, k === 'messages' ? row.messages.map(copyMessage) : clone(row[k], k).value); return c; };
/** Restore a mirror object IN PLACE from its detached copy (held views stay valid); `keep` names keys restored by the caller. */
const restoreInto = (obj, copy, keep = []) => {
  for (const k of Object.keys(obj)) if (!Object.hasOwn(copy, k) && !keep.includes(k)) delete obj[k];
  for (const k of Object.keys(copy)) if (!keep.includes(k)) setOwn(obj, k, clone(copy[k], k).value);
};

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a tool, a
 * test, the migration). `staged` selects the server's write mode (see the header); it
 * needs `unit`, and the store must register `saveHook()` — with `unit` given, no
 * operation joins a unit until `saveHook()` was taken. `requests` is an accessor for
 * the authoritative requests collection (the live blob: `() => db.requests`) that
 * `open` checks the transitional reference against; without it `open` refuses.
 */
export function createChannelsRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false, requests = null } = {}) {
  if (!sqlite) throw new TypeError('the channels repository needs a SQLite connection (node:sqlite); message threads have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the channels repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the channels repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  if (requests !== null && typeof requests !== 'function') throw new TypeError('the channels repository takes `requests` as an accessor function returning the authoritative requests collection');
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
     * A new thread at the end, in the channel literal (validated exactly like an
     * import). The TRANSITIONAL CHECKED REFERENCE (D-A): the requestId must be the id
     * of a request in the authoritative requests collection and no other channel may
     * carry it; the organisation must exist; a guardian, when named, must exist.
     * Returns the thread (read-only).
     */
    open(raw) {
      return operation((exec) => {
        const v = validateChannel(raw); if (!v.ok) throw new TypeError(`a message thread needs the channel literal: ${v.reason}`);
        const row = v.row;
        if (byId.has(row.id)) throw new Error(`channels: a thread with id ${row.id} already exists`);
        if (byRequest.has(row.requestId)) throw new Error(`channels: request ${row.requestId} already opened thread ${byRequest.get(row.requestId).id}; a request opens one thread`);
        if (!requests) throw new Error('channels: open() needs the authoritative requests collection to check the request reference (the repository was created without `requests`)');
        const list = requests(); if (!Array.isArray(list)) throw new Error(`channels: the authoritative requests collection is ${describe(list)}, not an array; the request reference cannot be checked`);
        if (!list.some((r) => isPlainObject(r) && r.id === row.requestId)) throw refusal('CHANNEL_REQUEST_MISSING', `channels: request ${row.requestId} is not in the requests collection; a thread opens only for an existing request`);
        if (!stmt.org.get(row.orgId)) throw refusal('CHANNEL_ORG_MISSING', `channels: organisation ${row.orgId} does not exist`);
        if (Object.hasOwn(row, 'guardianId') && row.guardianId !== null && !stmt.guardian.get(row.guardianId)) throw refusal('CHANNEL_GUARDIAN_MISSING', `channels: guardian ${row.guardianId} does not exist`);
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
        const v = validateMessage(raw); if (!v.ok) throw new TypeError(`a message needs the message literal: ${v.reason}`);
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
        const absent = channelAbsent(row); const absentJson = absent.length ? JSON.stringify(absent) : null;
        exec(() => stmt.read[side].run(at, absentJson, row.id));
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
    /** Every thread in its legacy shape (extras first, then the literal's keys in the writer's order; messages nested in order), detached (the admin backup). */
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
    /** Unit-of-work participation: every mirror object by identity (channels and their messages, restored in place) and the queue length when the unit began. */
    snapshotState: () => ({ pendingLength: pending.length, channels: rows.map((r) => [r, copyChannel(r), r.messages.map((m) => [m, copyMessage(m)])]) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; inFlight = 0;
      rows.length = 0;
      for (const [obj, copy, messages] of state.channels) {
        restoreInto(obj, copy, ['messages']);
        obj.messages.length = 0;
        for (const [m, mcopy] of messages) { restoreInto(m, mcopy); obj.messages.push(m); }
        rows.push(obj);
      }
      index();
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
