/**
 * Upload sessions: a player's resumable upload (domains/media/uploads.mjs), the chunk numbers received as rows.
 * open → finalised | aborted | abandoned (the 24-hour sweep). The chunk bytes live on disk, not here. Deleting a player
 * deletes their sessions (`removeForPlayer`), in the deletion's unit.
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen. Player ids
 * carry no key: a session goes with the player explicitly.
 */
import {
  isPlainObject,
  describe,
  text,
  int,
  oneOf,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
} from './fieldSpecs.mjs';
import { migrationApplied, childRowsOf, operationOn } from './database.mjs';
import { writeKit } from './writes.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';

export const UPLOAD_SESSIONS_MIGRATION = '0038_operations';
export const UPLOAD_SESSIONS_COLLECTIONS = Object.freeze(['uploadSessions']);
export const UPLOAD_SESSIONS_TABLES = Object.freeze(['upload_sessions', 'upload_session_chunks']);

export const UPLOAD_MIMES = Object.freeze([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const UPLOAD_STATUSES = Object.freeze(['open', 'finalised', 'aborted', 'abandoned']);
export const UPLOAD_LIMITS = Object.freeze({ id: 80, title: 120, maxBytes: 40 * 1024 * 1024, maxChunks: 1024 });
const L = UPLOAD_LIMITS;
export const isSha256 = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);

const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };
const UPLOAD_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  int('size', 'size_bytes', req),
  oneOf('mime', 'mime', UPLOAD_MIMES, req),
  text('title', 'title', L.title, { req: true, nonEmpty: true }),
  text('sha256', 'declared_sha256', 64),
  int('chunkSize', 'chunk_size', req),
  int('totalChunks', 'total_chunks', req),
  oneOf('status', 'status', UPLOAD_STATUSES, req),
  int('createdAt', 'created_at', req),
  idf('finalisedMediaId', 'finalised_media_id'),
];

export const UPLOAD_SESSIONS_DDL = [
  tableDdl('upload_sessions', UPLOAD_SPEC, [
    `CHECK (size_bytes > 0 AND size_bytes <= ${L.maxBytes})`,
    'CHECK (chunk_size > 0)',
    `CHECK (total_chunks >= 1 AND total_chunks <= ${L.maxChunks})`,
    'CHECK (declared_sha256 IS NULL OR length(declared_sha256) = 64)',
    "CHECK ((status = 'finalised') = (finalised_media_id IS NOT NULL))",
  ]),
  'CREATE INDEX upload_sessions_player ON upload_sessions (player_id);',
  "CREATE INDEX upload_sessions_open ON upload_sessions (created_at) WHERE status = 'open';",
  `CREATE TABLE upload_session_chunks (
  upload_session_id TEXT NOT NULL CHECK (length(upload_session_id) > 0 AND length(upload_session_id) <= ${L.id}),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (upload_session_id, chunk_index)
) STRICT;`,
].join('\n');

const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
export function typeUpload(raw, at = 'uploadSessions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { received, ...rest } = raw;
  const t = typeSpec(UPLOAD_SPEC, rest, label);
  if (!t.ok) return t;
  const u = t.record;
  if (u.size <= 0 || u.size > L.maxBytes) return bad(label, 'size', `must be from 1 to ${L.maxBytes} bytes`);
  if (u.chunkSize <= 0) return bad(label, 'chunkSize', 'must be positive');
  if (u.totalChunks !== Math.ceil(u.size / u.chunkSize) || u.totalChunks > L.maxChunks)
    return bad(label, 'totalChunks', 'must be the size divided by the chunk size, rounded up');
  if (u.sha256 !== null && !isSha256(u.sha256)) return bad(label, 'sha256', 'must be 64 hexadecimal characters');
  if ((u.status === 'finalised') !== (u.finalisedMediaId !== null))
    return bad(label, 'finalisedMediaId', 'is set exactly when the upload is finalised');
  if (!Array.isArray(received)) return bad(label, 'received', 'must be a list');
  for (const [i, x] of received.entries())
    if (!Number.isSafeInteger(x) || x < 0 || x >= u.totalChunks)
      return bad(label, `received[${i}]`, `must be a chunk number below ${u.totalChunks}`);
  if (new Set(received).size !== received.length) return bad(label, 'received', 'names a chunk twice');
  return { ok: true, record: { ...u, received: [...received] } };
}

const decodeUploads = (sqlite, rows) => {
  const chunks = childRowsOf(
    sqlite,
    'upload_session_chunks',
    'upload_session_id',
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({ ...decode(UPLOAD_SPEC, row), received: chunks.all(row.id).map((c) => c.chunk_index) }));
};

export const uploadSessionsLive = (sqlite) => migrationApplied(sqlite, UPLOAD_SESSIONS_MIGRATION);
/** Every session read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const UPLOAD_SESSIONS_RECORDS = {
  names: UPLOAD_SESSIONS_COLLECTIONS,
  read: (sqlite) =>
    uploadSessionsLive(sqlite)
      ? { uploadSessions: decodeUploads(sqlite, sqlite.prepare('SELECT * FROM upload_sessions ORDER BY rowid').all()) }
      : null,
};

const WRITES = new Set(['open', 'receiveChunk', 'finalise', 'abort', 'abandonOpenBefore', 'removeForPlayer']);

/** `createUploadSessionsRepository({ sqlite, unit, now, log })`: the sessions' acts and queries, plus `reads`. */
export function createUploadSessionsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the upload sessions repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const { q, refusal, invalid } = writeKit(sqlite, 'UPLOAD');

  const byId = (id) =>
    typeof id === 'string'
      ? (decodeUploads(sqlite, q('SELECT * FROM upload_sessions WHERE id = ?').all(id)).map(deepFreeze)[0] ?? null)
      : null;
  const setStatus = (id, from, to, mediaId = null) => {
    const moved = q('UPDATE upload_sessions SET status = ?, finalised_media_id = ? WHERE id = ? AND status = ?').run(
      to,
      mediaId,
      id,
      from,
    ).changes;
    if (moved !== 1) throw refusal('NOT_OPEN', `upload_sessions ${id} is not ${from}`);
    return byId(id);
  };
  const acts = {
    /** A new open session; no chunks. */
    open: (raw) =>
      operation(() => {
        const t = typeUpload({ received: [], ...raw });
        if (!t.ok) throw invalid(t.reason);
        const u = t.record;
        if (u.status !== 'open' || u.received.length)
          throw invalid(`upload_sessions ${u.id}: a new session is open with no chunks`);
        if (q('SELECT 1 FROM upload_sessions WHERE id = ?').get(u.id))
          throw refusal('DUPLICATE', `upload_sessions ${u.id} already exists`);
        q(insertSql('upload_sessions', UPLOAD_SPEC)).run(encode(UPLOAD_SPEC, u));
        return byId(u.id);
      }),
    /** Records that chunk `index` arrived (again: a no-op); returns the session. */
    receiveChunk: (id, index) =>
      operation(() => {
        const u = byId(id);
        if (!u) throw refusal('NOT_FOUND', `upload_sessions ${id} is not a record of the repository`);
        if (u.status !== 'open') throw refusal('NOT_OPEN', `upload_sessions ${id} is ${u.status}`);
        if (!Number.isSafeInteger(index) || index < 0 || index >= u.totalChunks)
          throw invalid(`upload_sessions ${id}: chunk ${index} is out of range`);
        q('INSERT OR IGNORE INTO upload_session_chunks (upload_session_id, chunk_index) VALUES (?, ?)').run(id, index);
        return byId(id);
      }),
    finalise: (id, mediaId) => operation(() => setStatus(id, 'open', 'finalised', mediaId)),
    abort: (id) => operation(() => setStatus(id, 'open', 'aborted')),
    /** Abandons every open session created before `cutoff`; returns their ids (the caller removes their chunk files). */
    abandonOpenBefore: (cutoff) =>
      operation(() => {
        const gone = q("SELECT id FROM upload_sessions WHERE status = 'open' AND created_at < ? ORDER BY rowid")
          .all(cutoff)
          .map((r) => r.id);
        for (const id of gone) setStatus(id, 'open', 'abandoned');
        return gone;
      }),
    /** A deleted player's sessions go (the chunk rows cascade); returns their ids (the caller removes their chunk files). */
    removeForPlayer: (playerId) =>
      operation(() => {
        const gone = q('SELECT id FROM upload_sessions WHERE player_id = ?')
          .all(playerId)
          .map((r) => r.id);
        q('DELETE FROM upload_sessions WHERE player_id = ?').run(playerId);
        return gone;
      }),
    byId,
    forPlayerById: (playerId, id) => {
      const u = byId(id);
      return u && u.playerId === playerId ? u : null;
    },
  };
  const counts = () => ({ uploadSessions: q('SELECT COUNT(*) AS n FROM upload_sessions').get().n });
  return {
    ...acts,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(acts).filter(([k]) => !WRITES.has(k)))),
    attach() {
      if (!uploadSessionsLive(sqlite))
        throw new Error(`the upload sessions repository needs ${UPLOAD_SESSIONS_MIGRATION} recorded`);
      return { counts: counts() };
    },
    counts,
    pending: () => 0,
    exportAll: () => UPLOAD_SESSIONS_RECORDS.read(sqlite),
    log,
    now,
  };
}
