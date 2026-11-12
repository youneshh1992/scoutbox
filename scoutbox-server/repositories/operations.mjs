/**
 * Operations: upload sessions, saved searches, invoices, the demo reputation seed and the delivery centre's
 * bookkeeping.
 *
 * Records:
 *   - An upload session (`uploads`): a player's resumable upload (domains/media/uploads.mjs), the chunk numbers received
 *     as rows. open → finalised | aborted | abandoned (the 24-hour sweep). The chunk bytes live on disk, not here.
 *     Deleting a player deletes their sessions (`removeForPlayer`), in the deletion's unit.
 *   - A saved search (`savedSearches`): a club's "tell me when…" search, its filters as typed columns (no JSON). The
 *     scout's name is read live from the staff row.
 *   - An invoice (`invoices`): the success fee of one signing, stored exactly in minor units; one per signing.
 *   - The demo reputation track records (`reputationSeed`): empty in production; imported once with a first
 *     installation's seed.
 *   - The delivery centre's bookkeeping (`delivery`): the provider callback ids already applied (the newest 5,000, at
 *     most 1,000 more), the instant the delivery centre started (one row, written by the migration: notifications older
 *     than it are never sent externally) and the admin-injected provider failures still to fire, by channel.
 *
 * Plans and archetypes are not tables: they are constants (catalogue.mjs).
 *
 * Every write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen. Modules
 * receive the queries as `operationsReads`.
 *
 * References. Organisations, staff and signings are RESTRICT keys. Player ids carry no key (an upload session goes
 * with the player explicitly; an invoice keeps its copy of the player's name: a billing record).
 */
import { isPlainObject, ids, describe } from './fieldSpecs.mjs';
import { migrationApplied, childRowsOf, operationOn } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import {
  text,
  int,
  num,
  bool,
  oneOf,
  group,
  tableDdl,
  bad,
  typeSpec,
  encode,
  decode,
  insertSql,
} from './fieldSpecs.mjs';
import { PLAYER_POSITIONS, PLAYER_FEET, PLAYER_AVAILABILITY } from './identity.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const OPERATIONS_MIGRATION = '0038_operations';
/** The collections the whole-domain read returns. */
export const OPERATIONS_COLLECTIONS = Object.freeze([
  'uploadSessions',
  'savedSearches',
  'invoices',
  'reputationSeed',
  'deliveryCallbacksSeen',
]);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const UPLOAD_MIMES = Object.freeze([
  'video/webm',
  'video/mp4',
  'video/quicktime',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const UPLOAD_STATUSES = Object.freeze(['open', 'finalised', 'aborted', 'abandoned']);
export const SEARCH_AGE_GROUPS = Object.freeze(['u16', 'u18', '18-21', 'senior']);
export const INVOICE_PROVIDERS = Object.freeze(['dev-ledger', 'stripe']);
export const FAIL_INJECT_CHANNELS = Object.freeze(['email', 'push', 'contact', 'trial', 'decision']);
export const OPERATIONS_LIMITS = Object.freeze({
  id: 80,
  uploadTitle: 120,
  maxUploadBytes: 40 * 1024 * 1024,
  maxChunks: 1024,
  searchName: 120,
  searchQ: 120,
  country: 60,
  newDays: 3650,
  name: 200,
  description: 300,
  callbackId: 200,
  callbacksKept: 5000,
  callbacksPruned: 1000,
});
const L = OPERATIONS_LIMITS;
export const isSha256 = (v) => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const UPLOAD_SPEC = [
  idf('id', 'id', req),
  idf('playerId', 'player_id', req),
  int('size', 'size_bytes', req),
  oneOf('mime', 'mime', UPLOAD_MIMES, req),
  text('title', 'title', L.uploadTitle, { req: true, nonEmpty: true }),
  text('sha256', 'declared_sha256', 64),
  int('chunkSize', 'chunk_size', req),
  int('totalChunks', 'total_chunks', req),
  oneOf('status', 'status', UPLOAD_STATUSES, req),
  int('createdAt', 'created_at', req),
  idf('finalisedMediaId', 'finalised_media_id'),
];
const FILTER_SPEC = [
  text('q', 'q', L.searchQ, { nonEmpty: true }),
  oneOf('position', 'position', PLAYER_POSITIONS),
  oneOf('foot', 'foot', PLAYER_FEET),
  oneOf('availability', 'availability', PLAYER_AVAILABILITY),
  text('country', 'country', L.country, { nonEmpty: true }),
  bool('academyPlus', 'academy_plus'),
  oneOf('ageGroup', 'age_group', SEARCH_AGE_GROUPS),
  int('newDays', 'new_days'),
];
export const SAVED_SEARCH_FILTERS = Object.freeze(FILTER_SPEC.map((f) => f.k));
const SAVED_SEARCH_SPEC = [
  idf('id', 'id', req),
  idf('orgId', 'org_id', req),
  idf('userId', 'user_id', req),
  text('name', 'name', L.searchName, { req: true, nonEmpty: true }),
  group('filters', FILTER_SPEC, { sparse: true }),
  int('createdAt', 'created_at', req),
];
const INVOICE_SPEC = [
  idf('id', 'id', req),
  int('ts', 'created_at', req),
  idf('orgId', 'org_id', req),
  text('orgName', 'org_name', L.name, req),
  idf('signingId', 'signing_id', req),
  text('playerName', 'player_name', L.name, req),
  text('description', 'description', L.description, req),
  int('amountMinor', 'amount_minor', req),
  text('currency', 'currency', 3, req),
  oneOf('status', 'status', ['issued'], req),
  oneOf('provider', 'provider', INVOICE_PROVIDERS, req),
];
const REPUTATION_SPEC = [
  text('scoutName', 'scout_name', L.name, { req: true, nonEmpty: true }),
  text('orgName', 'org_name', L.name, { req: true, nonEmpty: true }),
  int('discoveries', 'discoveries', req),
  int('successRatePct', 'success_rate_pct', req),
  num('avgResaleMultiple', 'avg_resale_multiple', req),
];

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;

export const OPERATIONS_DDL = [
  tableDdl('upload_sessions', UPLOAD_SPEC, [
    `CHECK (size_bytes > 0 AND size_bytes <= ${L.maxUploadBytes})`,
    'CHECK (chunk_size > 0)',
    `CHECK (total_chunks >= 1 AND total_chunks <= ${L.maxChunks})`,
    'CHECK (declared_sha256 IS NULL OR length(declared_sha256) = 64)',
    "CHECK ((status = 'finalised') = (finalised_media_id IS NOT NULL))",
  ]),
  'CREATE INDEX upload_sessions_player ON upload_sessions (player_id);',
  "CREATE INDEX upload_sessions_open ON upload_sessions (created_at) WHERE status = 'open';",
  table('upload_session_chunks', [
    col(
      'upload_session_id',
      `TEXT NOT NULL CHECK (length(upload_session_id) > 0 AND length(upload_session_id) <= ${L.id})`,
    ),
    col('chunk_index', 'INTEGER NOT NULL CHECK (chunk_index >= 0)'),
    'FOREIGN KEY (upload_session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE',
    'PRIMARY KEY (upload_session_id, chunk_index)',
  ]),

  tableDdl('saved_searches', SAVED_SEARCH_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('org_users', 'user_id'),
    `CHECK (new_days IS NULL OR (new_days >= 1 AND new_days <= ${L.newDays}))`,
    'CHECK (academy_plus IS NULL OR academy_plus = 1)',
  ]),
  'CREATE INDEX saved_searches_org ON saved_searches (org_id);',

  tableDdl('invoices', INVOICE_SPEC, [
    rowOf('orgs', 'org_id'),
    rowOf('signings', 'signing_id'),
    'CHECK (amount_minor >= 0)',
    "CHECK (currency GLOB '[A-Z][A-Z][A-Z]')",
  ]),
  'CREATE UNIQUE INDEX invoices_signing ON invoices (signing_id);',
  'CREATE INDEX invoices_org ON invoices (org_id);',

  tableDdl('reputation_seed', REPUTATION_SPEC, [
    'PRIMARY KEY (scout_name, org_name)',
    'CHECK (discoveries >= 0)',
    'CHECK (success_rate_pct BETWEEN 0 AND 100)',
    'CHECK (avg_resale_multiple >= 0)',
  ]),

  table('delivery_callbacks_seen', [
    col('callback_id', `TEXT PRIMARY KEY CHECK (length(callback_id) > 0 AND length(callback_id) <= ${L.callbackId})`),
    col('seen_at', 'INTEGER NOT NULL'),
  ]),
  table('delivery_centre', [col('id', 'INTEGER PRIMARY KEY CHECK (id = 1)'), col('since', 'INTEGER NOT NULL')]),
  table('delivery_fail_injections', [
    col('channel', `TEXT PRIMARY KEY CHECK (channel IN (${FAIL_INJECT_CHANNELS.map((c) => `'${c}'`).join(',')}))`),
    col('remaining', 'INTEGER NOT NULL CHECK (remaining >= 0)'),
  ]),
].join('\n');
export const OPERATIONS_TABLES = Object.freeze([
  'upload_sessions',
  'upload_session_chunks',
  'saved_searches',
  'invoices',
  'reputation_seed',
  'delivery_callbacks_seen',
  'delivery_centre',
  'delivery_fail_injections',
]);
/** The migration's rows: the delivery centre starts now (nothing older is ever sent externally) and no failure is injected. */
export function seedOperationsRows(sqlite, now) {
  sqlite.prepare('INSERT INTO delivery_centre (id, since) VALUES (1, ?)').run(now);
  const inject = sqlite.prepare('INSERT INTO delivery_fail_injections (channel, remaining) VALUES (?, 0)');
  for (const c of FAIL_INJECT_CHANNELS) inject.run(c);
}

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) =>
  Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();

export function typeUpload(raw, at = 'uploadSessions') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { received, ...rest } = raw;
  const t = typeSpec(UPLOAD_SPEC, rest, label);
  if (!t.ok) return t;
  const u = t.record;
  if (u.size <= 0 || u.size > L.maxUploadBytes)
    return bad(label, 'size', `must be from 1 to ${L.maxUploadBytes} bytes`);
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
export function typeSavedSearch(raw, at = 'savedSearches') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { scoutName: _live, ...rest } = raw; // the scout's name is read live from the staff row, never stored
  const t = typeSpec(SAVED_SEARCH_SPEC, rest, label);
  if (!t.ok) return t;
  const f = t.record.filters;
  if (f.academyPlus === false) return bad(label, 'filters.academyPlus', 'is true or absent');
  if (f.newDays !== undefined && (f.newDays < 1 || f.newDays > L.newDays))
    return bad(label, 'filters.newDays', `must be from 1 to ${L.newDays}`);
  return t;
}
export function typeInvoice(raw, at = 'invoices') {
  const label = labelOf(at, raw);
  const t = typeSpec(INVOICE_SPEC, raw, label);
  if (!t.ok) return t;
  if (t.record.amountMinor < 0) return bad(label, 'amountMinor', 'must not be negative');
  if (!/^[A-Z]{3}$/.test(t.record.currency)) return bad(label, 'currency', 'must be a three-letter currency code');
  return t;
}
export function typeReputation(raw, at = 'reputationSeed') {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const { seeded: _derived, ...rest } = raw; // always true for these rows; derived on read
  const t = typeSpec(REPUTATION_SPEC, rest, at);
  if (!t.ok) return t;
  const r = t.record;
  if (r.discoveries < 0) return bad(at, 'discoveries', 'must not be negative');
  if (r.successRatePct < 0 || r.successRatePct > 100) return bad(at, 'successRatePct', 'must be from 0 to 100');
  if (r.avgResaleMultiple < 0) return bad(at, 'avgResaleMultiple', 'must not be negative');
  return t;
}

// ------------------------------------------------------------------ rows
const decodeUploads = (sqlite, rows) => {
  const chunks = childRowsOf(
    sqlite,
    'upload_session_chunks',
    'upload_session_id',
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({ ...decode(UPLOAD_SPEC, row), received: chunks.all(row.id).map((c) => c.chunk_index) }));
};
const SEARCH_SELECT =
  'SELECT s.rowid AS rowid, s.*, u.name AS scout_name FROM saved_searches s JOIN org_users u ON u.id = s.user_id';
const decodeSearch = (row) => {
  const d = decode(SAVED_SEARCH_SPEC, row);
  return {
    id: d.id,
    orgId: d.orgId,
    userId: d.userId,
    scoutName: row.scout_name,
    name: d.name,
    filters: d.filters,
    createdAt: d.createdAt,
  };
};
const decodeReputation = (row) => ({ ...decode(REPUTATION_SPEC, row), seeded: true });

// ------------------------------------------------------------------ whole-domain read (the test suites)
export const operationsLive = (sqlite) => migrationApplied(sqlite, OPERATIONS_MIGRATION);
function readAll(sqlite) {
  const all = (sql) => sqlite.prepare(sql).all();
  return {
    uploadSessions: decodeUploads(sqlite, all('SELECT * FROM upload_sessions ORDER BY rowid')),
    savedSearches: all(`${SEARCH_SELECT} ORDER BY s.rowid`).map(decodeSearch),
    invoices: all('SELECT * FROM invoices ORDER BY rowid').map((r) => decode(INVOICE_SPEC, r)),
    reputationSeed: all('SELECT * FROM reputation_seed ORDER BY rowid').map(decodeReputation),
    deliveryCallbacksSeen: all('SELECT callback_id FROM delivery_callbacks_seen ORDER BY rowid').map(
      (r) => r.callback_id,
    ),
  };
}
function typeList(name, list, typer, label, keyOf = (r) => r.id) {
  if (!Array.isArray(list))
    throw refusal(
      'OPERATIONS_IMPORT_BLOCKED',
      `the ${name} collection of ${label} must be an array of entries (got ${describe(list)})`,
    );
  const seen = new Set();
  return list.map((raw, i) => {
    const t = typer(raw, `${name} entry #${i}`);
    if (!t.ok) throw refusal('OPERATIONS_IMPORT_BLOCKED', `${label}: ${t.reason}`);
    const k = keyOf(t.record);
    if (seen.has(k))
      throw refusal('OPERATIONS_IMPORT_BLOCKED', `${label}: ${name} entry #${i} duplicates an earlier entry (${k})`);
    seen.add(k);
    return t.record;
  });
}
const TYPED = {
  uploadSessions: (list, label) => typeList('uploadSessions', list, typeUpload, label),
  savedSearches: (list, label) => typeList('savedSearches', list, typeSavedSearch, label),
  invoices: (list, label) => {
    const out = typeList('invoices', list, typeInvoice, label);
    if (new Set(out.map((x) => x.signingId)).size !== out.length)
      throw refusal('OPERATIONS_IMPORT_BLOCKED', `${label}: two invoices name one signing`);
    return out;
  },
  reputationSeed: (list, label) =>
    typeList('reputationSeed', list, typeReputation, label, (r) => `${r.scoutName}|${r.orgName}`),
  deliveryCallbacksSeen: (list, label) =>
    typeList(
      'deliveryCallbacksSeen',
      list,
      (v, at) =>
        typeof v === 'string' && v.length > 0 && v.length <= L.callbackId
          ? { ok: true, record: v }
          : { ok: false, reason: `${at} is not a callback id (${describe(v)})` },
      label,
      (v) => v,
    ),
};
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const OPERATIONS_RECORDS = {
  names: OPERATIONS_COLLECTIONS,
  read(sqlite) {
    return operationsLive(sqlite) ? readAll(sqlite) : null;
  },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set([
  'open',
  'receiveChunk',
  'finalise',
  'abort',
  'abandonOpenBefore',
  'removeForPlayer',
  'create',
  'remove',
  'issue',
  'markSeen',
  'inject',
  'consumeInjectedFailure',
]);

/**
 * `createOperationsRepository({ sqlite, unit, now, log })`: `uploads`, `savedSearches`, `invoices`, `reputationSeed` and
 * `delivery`, each with its writes and queries, plus `reads` (the queries alone: `operationsReads`).
 */
export function createOperationsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the operations repository needs a SQLite connection (node:sqlite)');
  const operation = operationOn(sqlite, unit);
  const cache = new Map();
  const q = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = sqlite.prepare(sql)));
    return s;
  };
  const typedOr = (type, raw, name) => {
    const t = type(raw, name);
    if (!t.ok) throw refusal('OPERATIONS_INPUT_INVALID', t.reason);
    return t.record;
  };
  const str = (v) => typeof v === 'string';
  const need = (what, tbl, id) => {
    if (!q(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(id))
      throw refusal('OPERATIONS_REFERENCE_MISSING', `${what} names no ${tbl} row (${id})`);
  };
  const duplicate = (tbl, id) => {
    if (q(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(id))
      throw refusal('OPERATIONS_DUPLICATE', `${tbl} ${id} already exists`);
  };
  /** Rows after `after` (a [rowid] key), newest first, decoded: `{ items, nextCursor }`. */
  const newestPage = (sql, args, { after = null, limit }, dec) => {
    const rows = q(`${sql} AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`).all(
      ...args,
      after?.[0] ?? null,
      after?.[0] ?? null,
      limit + 1,
    );
    const page = pageOf(rows, limit, (r) => [r.rowid]);
    return { items: page.items.map(dec), nextCursor: page.nextCursor };
  };

  // ---- upload sessions
  const decU = (rows) => decodeUploads(sqlite, rows).map(deepFreeze);
  const uploadById = (id) =>
    str(id) ? (decU(q('SELECT * FROM upload_sessions WHERE id = ?').all(id))[0] ?? null) : null;
  const setStatus = (id, from, to, mediaId = null) => {
    if (
      q('UPDATE upload_sessions SET status = ?, finalised_media_id = ? WHERE id = ? AND status = ?').run(
        to,
        mediaId,
        id,
        from,
      ).changes !== 1
    ) {
      throw refusal('UPLOAD_NOT_OPEN', `upload_sessions ${id} is not ${from}`);
    }
    return uploadById(id);
  };
  const uploads = {
    /** A new open session; no chunks. */
    open: (raw) =>
      operation(() => {
        const u = typedOr(typeUpload, { received: [], ...raw }, 'uploadSessions');
        if (u.status !== 'open' || u.received.length)
          throw refusal('OPERATIONS_INPUT_INVALID', `upload_sessions ${u.id}: a new session is open with no chunks`);
        duplicate('upload_sessions', u.id);
        q(insertSql('upload_sessions', UPLOAD_SPEC)).run(encode(UPLOAD_SPEC, u));
        return uploadById(u.id);
      }),
    /** Records that chunk `index` arrived (again: a no-op); returns the session. */
    receiveChunk: (id, index) =>
      operation(() => {
        const u = uploadById(id);
        if (!u) throw refusal('UPLOAD_NOT_FOUND', `upload_sessions ${id} is not a record of the repository`);
        if (u.status !== 'open') throw refusal('UPLOAD_NOT_OPEN', `upload_sessions ${id} is ${u.status}`);
        if (!Number.isSafeInteger(index) || index < 0 || index >= u.totalChunks)
          throw refusal('OPERATIONS_INPUT_INVALID', `upload_sessions ${id}: chunk ${index} is out of range`);
        q('INSERT OR IGNORE INTO upload_session_chunks (upload_session_id, chunk_index) VALUES (?, ?)').run(id, index);
        return uploadById(id);
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
    byId: uploadById,
    forPlayerById: (playerId, id) => {
      const u = uploadById(id);
      return u && u.playerId === playerId ? u : null;
    },
  };

  // ---- saved searches
  const searchById = (id) => {
    const row = str(id) ? q(`${SEARCH_SELECT} WHERE s.id = ?`).get(id) : null;
    return row ? deepFreeze(decodeSearch(row)) : null;
  };
  const savedSearches = {
    create: (raw) =>
      operation(() => {
        const s = typedOr(typeSavedSearch, raw, 'savedSearches');
        duplicate('saved_searches', s.id);
        need(`saved_searches ${s.id}`, 'orgs', s.orgId);
        need(`saved_searches ${s.id}`, 'org_users', s.userId);
        q(insertSql('saved_searches', SAVED_SEARCH_SPEC)).run(encode(SAVED_SEARCH_SPEC, s));
        return searchById(s.id);
      }),
    /** The organisation deletes its saved search. False when it has none by that id. */
    remove: (orgId, id) =>
      operation(() => q('DELETE FROM saved_searches WHERE id = ? AND org_id = ?').run(id, orgId).changes === 1),
    byId: searchById,
    /** The organisation's saved searches, oldest first (one club's list: not paged). */
    forOrg: (orgId) =>
      q(`${SEARCH_SELECT} WHERE s.org_id = ? ORDER BY s.rowid`)
        .all(orgId)
        .map((r) => deepFreeze(decodeSearch(r))),
    /**
     * The saved searches of current staff that could match a player with these fields: a search that names a position,
     * foot, country or availability is skipped unless it is the player's. The caller applies the whole filter.
     */
    candidatesFor: ({ position = null, foot = null, country = null, availability = null }) =>
      q(`${SEARCH_SELECT}
      WHERE u.removed_at IS NULL
        AND (s.position IS NULL OR s.position = ?) AND (s.foot IS NULL OR s.foot = ?)
        AND (s.country IS NULL OR s.country = ?) AND (s.availability IS NULL OR s.availability = ?)
      ORDER BY s.rowid`)
        .all(position, foot, country, availability)
        .map((r) => deepFreeze(decodeSearch(r))),
    count: () => q('SELECT COUNT(*) AS n FROM saved_searches').get().n,
  };

  // ---- invoices
  const decI = (row) => deepFreeze(decode(INVOICE_SPEC, row));
  const invoiceById = (id) => {
    const row = str(id) ? q('SELECT * FROM invoices WHERE id = ?').get(id) : null;
    return row ? decI(row) : null;
  };
  const invoices = {
    /** Issues the signing's invoice. A second invoice for one signing is refused (INVOICE_EXISTS). */
    issue: (raw) =>
      operation(() => {
        const i = typedOr(typeInvoice, raw, 'invoices');
        duplicate('invoices', i.id);
        if (q('SELECT 1 FROM invoices WHERE signing_id = ?').get(i.signingId))
          throw refusal('INVOICE_EXISTS', `signings ${i.signingId} already has an invoice`);
        need(`invoices ${i.id}`, 'orgs', i.orgId);
        need(`invoices ${i.id}`, 'signings', i.signingId);
        q(insertSql('invoices', INVOICE_SPEC)).run(encode(INVOICE_SPEC, i));
        return invoiceById(i.id);
      }),
    byId: invoiceById,
    forSigning: (signingId) => {
      const row = q('SELECT * FROM invoices WHERE signing_id = ?').get(signingId);
      return row ? decI(row) : null;
    },
    /** A page of the organisation's invoices, newest first. */
    pageForOrg: (orgId, page) => newestPage('SELECT rowid, * FROM invoices WHERE org_id = ?', [orgId], page, decI),
    /** A page of every invoice, newest first (Trust & Safety). */
    page: (page) => newestPage('SELECT rowid, * FROM invoices WHERE 1', [], page, decI),
    count: () => q('SELECT COUNT(*) AS n FROM invoices').get().n,
  };

  // ---- the demo reputation seed (read only; imported once with a first installation's seed)
  const reputationSeed = {
    all: () =>
      q('SELECT * FROM reputation_seed ORDER BY rowid')
        .all()
        .map((r) => deepFreeze(decodeReputation(r))),
    count: () => q('SELECT COUNT(*) AS n FROM reputation_seed').get().n,
  };

  // ---- the delivery centre's bookkeeping
  const delivery = {
    /** Remembers a provider callback id. False when it was already applied (the caller skips it). */
    markSeen: (callbackId, at) =>
      operation(() => {
        if (!str(callbackId) || !callbackId.length || callbackId.length > L.callbackId)
          throw refusal('OPERATIONS_INPUT_INVALID', `a callback id is 1 to ${L.callbackId} characters`);
        if (
          q('INSERT OR IGNORE INTO delivery_callbacks_seen (callback_id, seen_at) VALUES (?, ?)').run(callbackId, at)
            .changes !== 1
        )
          return false;
        if (q('SELECT COUNT(*) AS n FROM delivery_callbacks_seen').get().n > L.callbacksKept) {
          q(
            'DELETE FROM delivery_callbacks_seen WHERE rowid IN (SELECT rowid FROM delivery_callbacks_seen ORDER BY rowid LIMIT ?)',
          ).run(L.callbacksPruned);
        }
        return true;
      }),
    hasSeen: (callbackId) => !!q('SELECT 1 FROM delivery_callbacks_seen WHERE callback_id = ?').get(callbackId),
    seenCount: () => q('SELECT COUNT(*) AS n FROM delivery_callbacks_seen').get().n,
    /** Notifications created before this instant are never sent externally (no retroactive blast). */
    centreSince: () => q('SELECT since FROM delivery_centre WHERE id = 1').get().since,
    /** The next `count` sends on `channel` fail at the provider. Returns the channel's remaining count. */
    inject: (channel, count) =>
      operation(() => {
        if (!FAIL_INJECT_CHANNELS.includes(channel) || !Number.isSafeInteger(count) || count < 1)
          throw refusal('OPERATIONS_INPUT_INVALID', 'an injection names a channel and a positive count');
        q('UPDATE delivery_fail_injections SET remaining = remaining + ? WHERE channel = ?').run(count, channel);
        return delivery.injected(channel);
      }),
    /** Uses up one injected failure on `channel`: true when one was waiting (the send must fail). */
    consumeInjectedFailure: (channel) =>
      operation(
        () =>
          q('UPDATE delivery_fail_injections SET remaining = remaining - 1 WHERE channel = ? AND remaining > 0').run(
            channel,
          ).changes === 1,
      ),
    injected: (channel) =>
      q('SELECT remaining FROM delivery_fail_injections WHERE channel = ?').get(channel)?.remaining ?? 0,
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { uploads, savedSearches, invoices, reputationSeed, delivery };
  const counters = {
    uploadSessions: q('SELECT COUNT(*) AS n FROM upload_sessions'),
    savedSearches: q('SELECT COUNT(*) AS n FROM saved_searches'),
    invoices: q('SELECT COUNT(*) AS n FROM invoices'),
    reputationSeed: q('SELECT COUNT(*) AS n FROM reputation_seed'),
    deliveryCallbacksSeen: q('SELECT COUNT(*) AS n FROM delivery_callbacks_seen'),
  };
  return {
    ...repo,
    /** The queries alone, for modules that must not write (`operationsReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    /**
     * Attach to the tables. `seedReputation` is the first installation's demo track records (the seed's, handed in only
     * while the installation is being initialised): imported once, when the table is empty.
     */
    attach({ seedReputation = [] } = {}) {
      if (!operationsLive(sqlite))
        throw new Error(
          `the operations repository needs ${OPERATIONS_MIGRATION} recorded; it never imports an in-memory array`,
        );
      if (seedReputation.length && reputationSeed.count() === 0) {
        const rows = TYPED.reputationSeed(seedReputation, "the first installation's seed");
        operation(() => {
          const ins = q(insertSql('reputation_seed', REPUTATION_SPEC));
          for (const r of rows) ins.run(encode(REPUTATION_SPEC, r));
        });
      }
      return { counts: this.counts() };
    },
    counts() {
      return Object.fromEntries(Object.entries(counters).map(([n, s]) => [n, s.get().n]));
    },
    pending: () => 0,
    exportAll() {
      return OPERATIONS_RECORDS.read(sqlite);
    },
    log,
    now,
  };
}
