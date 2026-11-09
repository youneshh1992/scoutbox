/**
 * S13a — integrations as typed tables (migration `0034_integrations`; docs/architecture/migration.md §4.5 S13;
 * sql/08_operations_integrations.sql).
 *
 * Records:
 *   - An import batch (F1): one CSV upload's dry run. Its header row and the column mapping it was given are ordered
 *     column rows (`field` is the prospect field the mapping named for that column, or null); every data row is a row
 *     with the record's fields as columns (a field the CSV did not map is NULL, a mapped empty cell is ''), its
 *     validation messages as ordered child rows, its disposition and the platform player it matched. The summary
 *     counts are columns. Its history (validated, committed, reversed) is typed rows: a commit's detail is the number
 *     created, a reversal's the numbers removed and kept, a validation's the batch summary itself.
 *   - A prospect (F1): an organisation-private record an import created (or an identity review kept separate), never
 *     a platform account. At most one live (not reversed) prospect per (organisation, provider, external id).
 *     The batch lists the prospects its commit created, in order: the ones a reversal undoes.
 *   - An identity review (F1): an ambiguous row awaiting a lead. Its record is the batch row it names (a key), never
 *     a copy.
 *   - An API key (F1): stored only as the sha-256 of the plain key; its scopes are ordered rows.
 *   - A webhook endpoint (F1): its signing secrets are stored plain (the server signs with them; OPERATIONS.md) and
 *     never served by a list; its events are ordered rows.
 *   - A webhook delivery (F1): one event for one endpoint. The payload is typed by event: every event names one
 *     record (`subject_id`: the batch, review, transition or dispatch), an import commit also carries the number
 *     created and an identity resolution its resolution. Attempts are ordered rows, each an HTTP status or an error.
 *
 * WRITES are explicit operations; every write joins the open unit of work, the caller's transaction or its own.
 * READS are SQL: no mirror. Fresh, deep-frozen records; lists decode child rows in one batch. Modules receive the
 * queries as `integrationReads`.
 *
 * References. Player ids carry no key (tolerant: a match survives an account deletion as a tombstone). Organisations
 * and the staff named are RESTRICT keys; so are the keys inside the domain (a prospect's batch, a review's batch row,
 * a delivery's endpoint). Child rows cascade with their owner.
 */
import { isPlainObject, ids, describe } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from './scoutingEvidence.mjs';
import { text, int, bool, oneOf, tableDdl, bad, typeSpec, encode, decode, insertSql, upsertSql } from './fieldSpecs.mjs';
import { parseStrictDateOnly } from '../temporal.mjs';
import { pageOf } from '../domains/platform/paging.mjs';

export const INTEGRATIONS_MIGRATION = '0034_integrations';
export const INTEGRATIONS_COLLECTIONS = Object.freeze(['importBatches', 'prospects', 'identityReviews', 'apiKeys', 'webhookEndpoints', 'webhookDeliveries']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const PROSPECT_FIELDS = Object.freeze(['name', 'dob', 'position', 'foot', 'heightCm', 'provider', 'externalId', 'notes']);
export const PROSPECT_POSITIONS = Object.freeze(['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF']);
export const IMPORT_KINDS = Object.freeze(['prospects']);
export const IMPORT_STATUSES = Object.freeze(['validated', 'committed', 'reversed']);
export const IMPORT_DISPOSITIONS = Object.freeze(['create', 'error', 'duplicate_in_file', 'already_imported', 'linked_player_exists', 'ambiguous_identity']);
export const IMPORT_ACTIONS = Object.freeze(['validated', 'committed', 'reversed']);
export const REVIEW_STATUSES = Object.freeze(['open', 'resolved']);
export const REVIEW_RESOLUTIONS = Object.freeze(['linked', 'kept_separate']);
export const API_SCOPES = Object.freeze(['export:prospects', 'export:shortlist']);
export const WEBHOOK_EVENTS = Object.freeze(['import.committed', 'identity.resolved', 'transition.granted', 'transition.revoked', 'delivery.failed']);
export const DELIVERY_STATUSES = Object.freeze(['queued', 'retrying', 'delivered', 'failed', 'abandoned']);
export const OPEN_DELIVERY_STATUSES = Object.freeze(['queued', 'retrying']);
/** The record each event names, by the key its payload carries it under. */
const SUBJECT_KEY = Object.freeze({ 'import.committed': 'batchId', 'identity.resolved': 'reviewId', 'transition.granted': 'transitionId', 'transition.revoked': 'transitionId', 'delivery.failed': 'dispatchId' });
/** Summary keys, in order, and the disposition each counts. */
const SUMMARY = Object.freeze([['total', null], ['creatable', 'create'], ['errors', 'error'], ['duplicatesInFile', 'duplicate_in_file'], ['alreadyImported', 'already_imported'], ['linkedExisting', 'linked_player_exists'], ['ambiguous', 'ambiguous_identity']]);
export const INTEGRATIONS_LIMITS = Object.freeze({
  id: 80, name: 200, label: 60, url: 2000, secret: 200, header: 200, columns: 60, rows: 2000, errors: 20, error: 300, attemptError: 200,
  scopes: API_SCOPES.length, events: WEBHOOK_EVENTS.length, attempts: 10,
  // The longest text each record field may hold (a longer cell is a row error, kept cut to this length).
  record: Object.freeze({ name: 200, dob: 40, position: 20, foot: 20, heightCm: 20, provider: 80, externalId: 80, notes: 2000 }),
});
const L = INTEGRATIONS_LIMITS;
const RECORD_COLUMN = Object.freeze({ name: 'record_name', dob: 'record_dob', position: 'record_position', foot: 'record_foot', heightCm: 'record_height_cm', provider: 'record_provider', externalId: 'record_external_id', notes: 'record_notes' });

// ------------------------------------------------------------------ field specs
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const req = { req: true };

const BATCH_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), oneOf('kind', 'kind', IMPORT_KINDS, req),
  idf('createdBy', 'created_by_user_id', req), text('createdByName', 'created_by_name', L.name), int('createdAt', 'created_at', req),
  bool('mapped', 'mapped', req), oneOf('status', 'status', IMPORT_STATUSES, req),
  int('total', 'summary_total', req), int('creatable', 'summary_creatable', req), int('errors', 'summary_errors', req),
  int('duplicatesInFile', 'summary_duplicates_in_file', req), int('alreadyImported', 'summary_already_imported', req),
  int('linkedExisting', 'summary_linked_existing', req), int('ambiguous', 'summary_ambiguous', req),
  int('committedAt', 'committed_at'), int('reversedAt', 'reversed_at'),
];
const HISTORY_SPEC = [
  idf('id', 'id', req), idf('batchId', 'batch_id', req), int('at', 'at', req), oneOf('byKind', 'by_kind', ['org_user'], req),
  idf('byId', 'by_user_id', req), text('byName', 'by_name', L.name), oneOf('action', 'action', IMPORT_ACTIONS, req),
  int('created', 'created_count'), int('removed', 'removed_count'), int('kept', 'kept_count'),
];
const PROSPECT_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), idf('batchId', 'batch_id', req),
  text('name', 'name', L.record.name, { req: true, nonEmpty: true }), text('dob', 'dob', 10), oneOf('position', 'position', PROSPECT_POSITIONS),
  text('foot', 'foot', L.record.foot, { nonEmpty: true }), int('heightCm', 'height_cm'),
  text('provider', 'provider', L.record.provider, { req: true, nonEmpty: true }), text('externalId', 'external_id', L.record.externalId, { req: true, nonEmpty: true }),
  text('notes', 'notes', L.record.notes, { nonEmpty: true }), bool('minor', 'minor'), int('createdAt', 'created_at', req), int('reversedAt', 'reversed_at'),
];
const REVIEW_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), idf('batchId', 'batch_id', req), int('row', 'row_no', req),
  idf('candidatePlayerId', 'candidate_player_id', req), oneOf('status', 'status', REVIEW_STATUSES, req),
  text('resolvedBy', 'resolved_by_name', L.name), int('resolvedAt', 'resolved_at'), oneOf('resolution', 'resolution', REVIEW_RESOLUTIONS), int('createdAt', 'created_at', req),
];
const KEY_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('keyHash', 'key_hash', 64, req), text('label', 'label', L.label, req),
  text('createdBy', 'created_by_name', L.name), int('createdAt', 'created_at', req), int('revokedAt', 'revoked_at'), int('lastUsedAt', 'last_used_at'),
];
const ENDPOINT_SPEC = [
  idf('id', 'id', req), idf('orgId', 'org_id', req), text('url', 'url', L.url, { req: true, nonEmpty: true }),
  text('secret', 'secret', L.secret, { req: true, nonEmpty: true }), text('secretPrev', 'secret_prev', L.secret, { nonEmpty: true }), int('secretPrevValidUntil', 'secret_prev_valid_until'),
  bool('active', 'active', req), text('createdBy', 'created_by_name', L.name), int('createdAt', 'created_at', req),
];
const DELIVERY_SPEC = [
  idf('id', 'id', req), idf('endpointId', 'endpoint_id', req), idf('orgId', 'org_id', req), idf('eventId', 'event_id', req),
  oneOf('type', 'type', WEBHOOK_EVENTS, req), idf('subjectId', 'subject_id', req), int('created', 'created_count'), oneOf('resolution', 'resolution', REVIEW_RESOLUTIONS),
  oneOf('status', 'status', DELIVERY_STATUSES, req), int('nextAt', 'next_at', req), int('createdAt', 'created_at', req), int('deliveredAt', 'delivered_at'),
];

// ------------------------------------------------------------------ DDL
const rowOf = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE RESTRICT`;
const ownedBy = (name, c, key = 'id') => `FOREIGN KEY (${c}) REFERENCES ${name}(${key}) ON DELETE CASCADE`;
const col = (c, def) => `${c.padEnd(40)} ${def}`;
const idCol = (c) => col(c, `TEXT NOT NULL CHECK (length(${c}) > 0 AND length(${c}) <= ${L.id})`);
const ordCol = (c = 'ord') => col(c, `INTEGER NOT NULL CHECK (${c} >= 0)`);
const table = (name, cols) => `CREATE TABLE ${name} (\n  ${cols.join(',\n  ')}\n) STRICT;`;
const enumIn = (vals) => vals.map((v) => `'${v}'`).join(',');
const optText = (c, max) => col(c, `TEXT CHECK (${c} IS NULL OR length(${c}) <= ${max})`);

export const INTEGRATIONS_DDL = [
  tableDdl('import_batches', BATCH_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('org_users', 'created_by_user_id'),
    `CHECK (summary_total >= 0 AND summary_total <= ${L.rows})`,
    'CHECK (summary_creatable >= 0 AND summary_errors >= 0 AND summary_duplicates_in_file >= 0 AND summary_already_imported >= 0 AND summary_linked_existing >= 0 AND summary_ambiguous >= 0)',
    'CHECK (summary_total = summary_creatable + summary_errors + summary_duplicates_in_file + summary_already_imported + summary_linked_existing + summary_ambiguous)',
    "CHECK ((status = 'validated') = (committed_at IS NULL))", "CHECK ((status = 'reversed') = (reversed_at IS NOT NULL))",
  ]),
  'CREATE INDEX import_batches_org_status ON import_batches (org_id, status);',
  table('import_batch_columns', [
    idCol('batch_id'), ordCol(), col('header', `TEXT NOT NULL CHECK (length(header) <= ${L.header})`),
    col('field', `TEXT CHECK (field IS NULL OR field IN (${enumIn(PROSPECT_FIELDS)}))`),
    ownedBy('import_batches', 'batch_id'), 'PRIMARY KEY (batch_id, ord)',
  ]),
  table('import_batch_rows', [
    idCol('batch_id'), col('row_no', 'INTEGER NOT NULL CHECK (row_no >= 2)'),
    ...PROSPECT_FIELDS.map((f) => optText(RECORD_COLUMN[f], L.record[f])),
    col('disposition', `TEXT NOT NULL CHECK (disposition IN (${enumIn(IMPORT_DISPOSITIONS)}))`),
    col('match_player_id', `TEXT CHECK (match_player_id IS NULL OR (length(match_player_id) > 0 AND length(match_player_id) <= ${L.id}))`),
    ownedBy('import_batches', 'batch_id'), 'PRIMARY KEY (batch_id, row_no)',
    "CHECK ((match_player_id IS NOT NULL) = (disposition IN ('linked_player_exists','ambiguous_identity')))",
  ]),
  table('import_batch_row_errors', [
    idCol('batch_id'), col('row_no', 'INTEGER NOT NULL'), ordCol(), col('message', `TEXT NOT NULL CHECK (length(message) > 0 AND length(message) <= ${L.error})`),
    'FOREIGN KEY (batch_id, row_no) REFERENCES import_batch_rows(batch_id, row_no) ON DELETE CASCADE', 'PRIMARY KEY (batch_id, row_no, ord)',
  ]),
  tableDdl('import_batch_history', HISTORY_SPEC, [
    ownedBy('import_batches', 'batch_id'), rowOf('org_users', 'by_user_id'),
    "CHECK ((action = 'committed') = (created_count IS NOT NULL))",
    "CHECK ((action = 'reversed') = (removed_count IS NOT NULL))", "CHECK ((action = 'reversed') = (kept_count IS NOT NULL))",
    'CHECK (created_count IS NULL OR created_count >= 0)', 'CHECK (removed_count IS NULL OR (removed_count >= 0 AND kept_count >= 0))',
  ]),
  'CREATE INDEX import_batch_history_batch ON import_batch_history (batch_id, at);',

  tableDdl('prospects', PROSPECT_SPEC, [
    rowOf('orgs', 'org_id'), rowOf('import_batches', 'batch_id'),
    "CHECK (dob IS NULL OR dob GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')",
    'CHECK (height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 230))',
  ]),
  'CREATE UNIQUE INDEX prospects_live_identity ON prospects (org_id, provider, external_id) WHERE reversed_at IS NULL;',
  'CREATE INDEX prospects_org ON prospects (org_id, reversed_at);',
  'CREATE INDEX prospects_batch ON prospects (batch_id);',
  table('import_batch_created_prospects', [
    idCol('batch_id'), ordCol(), idCol('prospect_id'),
    ownedBy('import_batches', 'batch_id'), rowOf('prospects', 'prospect_id'), 'PRIMARY KEY (batch_id, ord)', 'UNIQUE (prospect_id)',
  ]),

  tableDdl('identity_reviews', REVIEW_SPEC, [
    rowOf('orgs', 'org_id'), 'FOREIGN KEY (batch_id, row_no) REFERENCES import_batch_rows(batch_id, row_no) ON DELETE RESTRICT',
    "CHECK ((status = 'resolved') = (resolution IS NOT NULL))", "CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))",
    'UNIQUE (batch_id, row_no)',
  ]),
  'CREATE INDEX identity_reviews_org_status ON identity_reviews (org_id, status);',

  tableDdl('api_keys', KEY_SPEC, [rowOf('orgs', 'org_id'), "CHECK (key_hash GLOB '[0-9a-f]*' AND length(key_hash) = 64)", 'UNIQUE (key_hash)']),
  'CREATE INDEX api_keys_org ON api_keys (org_id);',
  table('api_key_scopes', [
    idCol('api_key_id'), ordCol(), col('scope', `TEXT NOT NULL CHECK (scope IN (${enumIn(API_SCOPES)}))`),
    ownedBy('api_keys', 'api_key_id'), 'PRIMARY KEY (api_key_id, ord)', 'UNIQUE (api_key_id, scope)',
  ]),

  tableDdl('webhook_endpoints', ENDPOINT_SPEC, [rowOf('orgs', 'org_id'), 'CHECK ((secret_prev IS NULL) = (secret_prev_valid_until IS NULL))']),
  'CREATE INDEX webhook_endpoints_org ON webhook_endpoints (org_id, active);',
  table('webhook_endpoint_events', [
    idCol('endpoint_id'), ordCol(), col('event', `TEXT NOT NULL CHECK (event IN (${enumIn(WEBHOOK_EVENTS)}))`),
    ownedBy('webhook_endpoints', 'endpoint_id'), 'PRIMARY KEY (endpoint_id, ord)', 'UNIQUE (endpoint_id, event)',
  ]),
  tableDdl('webhook_deliveries', DELIVERY_SPEC, [
    rowOf('webhook_endpoints', 'endpoint_id'), rowOf('orgs', 'org_id'), 'UNIQUE (event_id)',
    "CHECK ((type = 'import.committed') = (created_count IS NOT NULL))", 'CHECK (created_count IS NULL OR created_count >= 0)',
    "CHECK ((type = 'identity.resolved') = (resolution IS NOT NULL))",
    "CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))",
  ]),
  'CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id);',
  'CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_at);',
  table('webhook_delivery_attempts', [
    idCol('delivery_id'), col('attempt_no', 'INTEGER NOT NULL CHECK (attempt_no >= 1)'), col('attempted_at', 'INTEGER NOT NULL'),
    col('http_status', 'INTEGER CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599))'),
    optText('error', L.attemptError),
    ownedBy('webhook_deliveries', 'delivery_id'), 'PRIMARY KEY (delivery_id, attempt_no)', 'CHECK ((http_status IS NULL) <> (error IS NULL))',
  ]),
].join('\n');
export const INTEGRATIONS_TABLES = Object.freeze([
  'import_batches', 'import_batch_columns', 'import_batch_rows', 'import_batch_row_errors', 'import_batch_history',
  'prospects', 'import_batch_created_prospects', 'identity_reviews', 'api_keys', 'api_key_scopes',
  'webhook_endpoints', 'webhook_endpoint_events', 'webhook_deliveries', 'webhook_delivery_attempts',
]);

// ------------------------------------------------------------------ typing
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && parseStrictDateOnly(v).ok;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= L.id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const withOnly = (raw, at, keys) => {
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  return unknown.length ? { ok: false, reason: `${at} carries field(s) this build does not store: ${unknown.join(', ')}` } : { ok: true };
};
/** A list of distinct values of `vals`, 1 to `max` long. */
function typeVocabList(list, label, field, vals, max) {
  if (!Array.isArray(list) || !list.length || list.length > max) return bad(label, field, `must list 1 to ${max} of ${vals.join('|')}`);
  const i = list.findIndex((x) => !vals.includes(x));
  if (i >= 0) return bad(label, `${field}[${i}]`, `must be one of ${vals.join('|')} (got ${describe(list[i])})`);
  if (new Set(list).size !== list.length) return bad(label, field, 'names a value twice');
  return { ok: true, value: [...list] };
}

/** An import row's record: the mapped fields only, each text within its limit. */
function typeImportRecord(raw, at) {
  const shape = withOnly(raw, at, PROSPECT_FIELDS); if (!shape.ok) return shape;
  const out = {};
  for (const f of PROSPECT_FIELDS) {
    if (!Object.hasOwn(raw, f)) continue;
    const v = raw[f];
    if (typeof v !== 'string' || v.length > L.record[f]) return bad(at, f, `must be text of at most ${L.record[f]} characters (got ${describe(v)})`);
    out[f] = v;
  }
  return { ok: true, record: out };
}
function typeImportRow(raw, at) {
  const shape = withOnly(raw, at, ['row', 'record', 'errors', 'disposition', 'matchPlayerId']); if (!shape.ok) return shape;
  if (!Number.isSafeInteger(raw.row) || raw.row < 2) return bad(at, 'row', `must be a CSV line number from 2 (got ${describe(raw.row)})`);
  const rec = typeImportRecord(raw.record, `${at}.record`); if (!rec.ok) return rec;
  if (!Array.isArray(raw.errors) || raw.errors.length > L.errors) return bad(at, 'errors', `must be a list of at most ${L.errors} messages`);
  const e = raw.errors.findIndex((m) => typeof m !== 'string' || !m.length || m.length > L.error);
  if (e >= 0) return bad(at, `errors[${e}]`, `must be a message of at most ${L.error} characters`);
  if (!IMPORT_DISPOSITIONS.includes(raw.disposition)) return bad(at, 'disposition', `must be one of ${IMPORT_DISPOSITIONS.join('|')} (got ${describe(raw.disposition)})`);
  if ((raw.disposition === 'error') !== (raw.errors.length > 0)) return bad(at, 'errors', 'are listed exactly when the disposition is error');
  const m = raw.matchPlayerId ?? null;
  const matches = ['linked_player_exists', 'ambiguous_identity'].includes(raw.disposition);
  if (matches ? !isId(m) : m !== null) return bad(at, 'matchPlayerId', matches ? 'names the matched player' : 'is null unless a player matched');
  return { ok: true, record: { row: raw.row, record: rec.record, errors: [...raw.errors], disposition: raw.disposition, matchPlayerId: m } };
}
function typeHistory(raw, at, batch) {
  const shape = withOnly(raw, at, ['id', 'at', 'byKind', 'byId', 'byName', 'action', 'detail']); if (!shape.ok) return shape;
  const { detail, ...rest } = raw;
  const t = typeSpec(HISTORY_SPEC.filter((f) => !['batchId', 'created', 'removed', 'kept'].includes(f.k)), rest, at); if (!t.ok) return t;
  const h = t.record;
  if (h.action === 'validated') {
    if (!same(detail, batch.summary)) return bad(at, 'detail', 'of a validation is the batch summary');
    return { ok: true, record: { ...h, detail: { ...batch.summary } } };
  }
  if (h.action === 'committed') {
    const d = withOnly(detail, `${at}.detail`, ['created']); if (!d.ok) return d;
    if (!Number.isSafeInteger(detail.created) || detail.created < 0) return bad(`${at}.detail`, 'created', 'must be a count');
    return { ok: true, record: { ...h, detail: { created: detail.created } } };
  }
  const d = withOnly(detail, `${at}.detail`, ['removed', 'kept']); if (!d.ok) return d;
  if (![detail.removed, detail.kept].every((n) => Number.isSafeInteger(n) && n >= 0)) return bad(`${at}.detail`, 'removed', 'and kept must be counts');
  return { ok: true, record: { ...h, detail: { removed: detail.removed, kept: detail.kept } } };
}
export function typeBatch(raw, at = 'importBatches') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { header, mapping = null, rows, summary, createdProspectIds = [], history = [], ...rest } = raw;
  const sum = withOnly(summary, `${label}.summary`, SUMMARY.map(([k]) => k)); if (!sum.ok) return sum;
  const t = typeSpec(BATCH_SPEC, { ...rest, ...summary, mapped: mapping !== null }, label); if (!t.ok) return t;
  const r = t.record;
  if (!Array.isArray(header) || !header.length || header.length > L.columns) return bad(label, 'header', `must list 1 to ${L.columns} column names`);
  const hi = header.findIndex((h) => typeof h !== 'string' || h.length > L.header);
  if (hi >= 0) return bad(label, `header[${hi}]`, `must be a column name of at most ${L.header} characters`);
  let map = null;
  if (mapping !== null) {
    if (!isPlainObject(mapping)) return bad(label, 'mapping', `must be an object from CSV column to prospect field (got ${describe(mapping)})`);
    map = {};
    for (const [k, v] of Object.entries(mapping)) {
      if (!header.includes(k)) return bad(label, 'mapping', `names a column the CSV does not have (${k.slice(0, 40)})`);
      if (v !== null && !PROSPECT_FIELDS.includes(v)) return bad(label, `mapping.${k.slice(0, 40)}`, `must be one of ${PROSPECT_FIELDS.join('|')} or null`);
      if (v !== null) map[k] = v;
    }
  }
  if (!Array.isArray(rows) || rows.length > L.rows) return bad(label, 'rows', `must be a list of at most ${L.rows} rows`);
  const typedRows = [];
  const seenRows = new Set();
  for (const [i, x] of rows.entries()) {
    const row = typeImportRow(x, `${label}.rows[${i}]`); if (!row.ok) return row;
    if (seenRows.has(row.record.row)) return bad(`${label}.rows[${i}]`, 'row', 'repeats a line number');
    seenRows.add(row.record.row);
    typedRows.push(row.record);
  }
  for (const [k, disp] of SUMMARY) {
    const n = disp === null ? typedRows.length : typedRows.filter((x) => x.disposition === disp).length;
    if (r[k] !== n) return bad(label, `summary.${k}`, `must count the rows (${n})`);
  }
  if (!Array.isArray(createdProspectIds) || createdProspectIds.some((x) => !isId(x)) || new Set(createdProspectIds).size !== createdProspectIds.length) return bad(label, 'createdProspectIds', 'must be a list of distinct prospect ids');
  if (r.status === 'validated' && createdProspectIds.length) return bad(label, 'createdProspectIds', 'are listed once the batch is committed');
  if ((r.status === 'validated') !== (r.committedAt === null)) return bad(label, 'committedAt', 'is set exactly when the batch was committed');
  if ((r.status === 'reversed') !== (r.reversedAt !== null)) return bad(label, 'reversedAt', 'is set exactly when the batch was reversed');
  const summaryOut = Object.fromEntries(SUMMARY.map(([k]) => [k, r[k]]));
  if (!Array.isArray(history)) return bad(label, 'history', `must be a list (got ${describe(history)})`);
  const hist = [];
  for (const [i, x] of history.entries()) { const h = typeHistory(x, `${label}.history[${i}]`, { summary: summaryOut }); if (!h.ok) return h; hist.push(h.record); }
  const base = Object.fromEntries(Object.entries(r).filter(([k]) => !SUMMARY.some(([s]) => s === k) && k !== 'mapped'));
  return { ok: true, record: { ...base, header: [...header], mapping: map, rows: typedRows, summary: summaryOut, createdProspectIds: [...createdProspectIds], history: hist } };
}
export function typeProspect(raw, at = 'prospects') {
  const label = labelOf(at, raw);
  const t = typeSpec(PROSPECT_SPEC, raw, label); if (!t.ok) return t;
  const r = t.record;
  if (r.dob !== null && !isDay(r.dob)) return bad(label, 'dob', `must be a calendar day written YYYY-MM-DD (got ${describe(r.dob)})`);
  if (r.heightCm !== null && (r.heightCm < 100 || r.heightCm > 230)) return bad(label, 'heightCm', 'must be from 100 to 230');
  return t;
}
export function typeReview(raw, at = 'identityReviews') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { record, ...rest } = raw;
  const t = typeSpec(REVIEW_SPEC, rest, label); if (!t.ok) return t;
  const r = t.record;
  if ((r.status === 'resolved') !== (r.resolution !== null) || (r.status === 'resolved') !== (r.resolvedAt !== null)) return bad(label, 'resolution', 'and resolvedAt are set exactly when the review is resolved');
  if (record !== undefined && !isPlainObject(record)) return bad(label, 'record', 'is the batch row\'s record');
  return { ok: true, record: r, claimed: record };
}
export function typeApiKey(raw, at = 'apiKeys') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { scopes, ...rest } = raw;
  const t = typeSpec(KEY_SPEC, rest, label); if (!t.ok) return t;
  if (!/^[0-9a-f]{64}$/.test(t.record.keyHash)) return bad(label, 'keyHash', 'must be a sha-256 hex digest');
  const s = typeVocabList(scopes, label, 'scopes', API_SCOPES, L.scopes); if (!s.ok) return s;
  return { ok: true, record: { ...t.record, scopes: s.value } };
}
export function typeEndpoint(raw, at = 'webhookEndpoints') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { events, ...rest } = raw;
  const t = typeSpec(ENDPOINT_SPEC, rest, label); if (!t.ok) return t;
  if ((t.record.secretPrev === null) !== (t.record.secretPrevValidUntil === null)) return bad(label, 'secretPrevValidUntil', 'is set exactly when a previous secret is kept');
  const e = typeVocabList(events, label, 'events', WEBHOOK_EVENTS, L.events); if (!e.ok) return e;
  return { ok: true, record: { ...t.record, events: e.value } };
}
/** A delivery's payload, by event type: `{ subjectId, created, resolution }` or a refusal. */
function typePayload(type, data, at) {
  const key = SUBJECT_KEY[type];
  if (!key) return bad(at, 'type', `must be one of ${WEBHOOK_EVENTS.join('|')}`);
  const keys = type === 'import.committed' ? [key, 'created'] : type === 'identity.resolved' ? [key, 'resolution'] : [key];
  const shape = withOnly(data, `${at}.data`, keys); if (!shape.ok) return shape;
  if (!isId(data[key])) return bad(`${at}.data`, key, `must be an id (got ${describe(data[key])})`);
  if (type === 'import.committed' && (!Number.isSafeInteger(data.created) || data.created < 0)) return bad(`${at}.data`, 'created', 'must be a count');
  if (type === 'identity.resolved' && !REVIEW_RESOLUTIONS.includes(data.resolution)) return bad(`${at}.data`, 'resolution', `must be one of ${REVIEW_RESOLUTIONS.join('|')}`);
  return { ok: true, value: { subjectId: data[key], created: type === 'import.committed' ? data.created : null, resolution: type === 'identity.resolved' ? data.resolution : null } };
}
const dataOf = (d) => ({ [SUBJECT_KEY[d.type]]: d.subjectId, ...(d.type === 'import.committed' ? { created: d.created } : {}), ...(d.type === 'identity.resolved' ? { resolution: d.resolution } : {}) });
function typeAttempt(raw, at) {
  const shape = withOnly(raw, at, ['at', 'status', 'error']); if (!shape.ok) return shape;
  if (!Number.isSafeInteger(raw.at)) return bad(at, 'at', 'must be an instant');
  const hasStatus = raw.status !== undefined && raw.status !== null;
  const hasError = raw.error !== undefined && raw.error !== null;
  if (hasStatus === hasError) return bad(at, 'status', 'or error: exactly one is recorded');
  if (hasStatus && (!Number.isSafeInteger(raw.status) || raw.status < 100 || raw.status > 599)) return bad(at, 'status', 'must be an HTTP status');
  if (hasError && (typeof raw.error !== 'string' || !raw.error.length || raw.error.length > L.attemptError)) return bad(at, 'error', `must be text of at most ${L.attemptError} characters`);
  return { ok: true, record: hasStatus ? { at: raw.at, status: raw.status } : { at: raw.at, error: raw.error } };
}
export function typeDelivery(raw, at = 'webhookDeliveries') {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { data, attempts = [], deliveredAt = null, ...rest } = raw;
  const p = typePayload(rest.type, data, label); if (!p.ok) return p;
  const t = typeSpec(DELIVERY_SPEC, { ...rest, ...p.value, deliveredAt }, label); if (!t.ok) return t;
  if ((t.record.status === 'delivered') !== (t.record.deliveredAt !== null)) return bad(label, 'deliveredAt', 'is set exactly when the delivery was delivered');
  if (!Array.isArray(attempts) || attempts.length > L.attempts) return bad(label, 'attempts', `must be a list of at most ${L.attempts}`);
  const out = [];
  for (const [i, x] of attempts.entries()) { const a = typeAttempt(x, `${label}.attempts[${i}]`); if (!a.ok) return a; out.push(a.record); }
  return { ok: true, record: { ...t.record, attempts: out } };
}

// ------------------------------------------------------------------ rows
const recordRow = (rec) => Object.fromEntries(PROSPECT_FIELDS.map((f) => [RECORD_COLUMN[f], Object.hasOwn(rec, f) ? rec[f] : null]));
const recordOf = (row) => Object.fromEntries(PROSPECT_FIELDS.filter((f) => row[RECORD_COLUMN[f]] !== null).map((f) => [f, row[RECORD_COLUMN[f]]]));
const ROW_COLUMNS = ['batch_id', 'row_no', ...PROSPECT_FIELDS.map((f) => RECORD_COLUMN[f]), 'disposition', 'match_player_id'];
const historyRow = (batchId, h) => encode(HISTORY_SPEC, { ...h, batchId, created: h.detail.created ?? null, removed: h.detail.removed ?? null, kept: h.detail.kept ?? null });
const batchRow = (b) => encode(BATCH_SPEC, { ...b, ...b.summary, mapped: b.mapping !== null });

function statements(sqlite) {
  const p = (sql) => sqlite.prepare(sql);
  return {
    batch: p(upsertSql('import_batches', BATCH_SPEC)),
    column: p('INSERT INTO import_batch_columns (batch_id, ord, header, field) VALUES (?, ?, ?, ?)'),
    row: p(`INSERT INTO import_batch_rows (${ROW_COLUMNS.join(', ')}) VALUES (${ROW_COLUMNS.map((c) => `@${c}`).join(', ')})`),
    rowError: p('INSERT INTO import_batch_row_errors (batch_id, row_no, ord, message) VALUES (?, ?, ?, ?)'),
    history: p(insertSql('import_batch_history', HISTORY_SPEC)),
    prospect: p(upsertSql('prospects', PROSPECT_SPEC)),
    created: p('INSERT INTO import_batch_created_prospects (batch_id, ord, prospect_id) VALUES (?, ?, ?)'),
    review: p(upsertSql('identity_reviews', REVIEW_SPEC)),
    key: p(upsertSql('api_keys', KEY_SPEC)),
    scope: p('INSERT INTO api_key_scopes (api_key_id, ord, scope) VALUES (?, ?, ?)'),
    endpoint: p(upsertSql('webhook_endpoints', ENDPOINT_SPEC)),
    event: p('INSERT INTO webhook_endpoint_events (endpoint_id, ord, event) VALUES (?, ?, ?)'),
    delivery: p(upsertSql('webhook_deliveries', DELIVERY_SPEC)),
    attempt: p('INSERT INTO webhook_delivery_attempts (delivery_id, attempt_no, attempted_at, http_status, error) VALUES (?, ?, ?, ?, ?)'),
  };
}
function writeBatch(st, b) {
  st.batch.run(batchRow(b));
  b.header.forEach((h, i) => st.column.run(b.id, i, h, b.mapping?.[h] ?? null));
  for (const r of b.rows) {
    st.row.run({ batch_id: b.id, row_no: r.row, ...recordRow(r.record), disposition: r.disposition, match_player_id: r.matchPlayerId });
    r.errors.forEach((m, i) => st.rowError.run(b.id, r.row, i, m));
  }
  for (const h of b.history) st.history.run(historyRow(b.id, h));
}
function writeKey(st, k) { st.key.run(encode(KEY_SPEC, k)); k.scopes.forEach((s, i) => st.scope.run(k.id, i, s)); }
function writeEndpoint(st, w) { st.endpoint.run(encode(ENDPOINT_SPEC, w)); w.events.forEach((e, i) => st.event.run(w.id, i, e)); }
function writeDelivery(st, d, { attempts = true } = {}) {
  st.delivery.run(encode(DELIVERY_SPEC, d));
  if (attempts) d.attempts.forEach((a, i) => st.attempt.run(d.id, i + 1, a.at, a.status ?? null, a.error ?? null));
}

// ---- decoding (lists read each child table once)
const batchCore = (row) => {
  const b = decode(BATCH_SPEC, row);
  return {
    id: b.id, orgId: b.orgId, kind: b.kind, createdBy: b.createdBy, createdByName: b.createdByName, createdAt: b.createdAt,
    status: b.status, summary: Object.fromEntries(SUMMARY.map(([k]) => [k, b[k]])), committedAt: b.committedAt, reversedAt: b.reversedAt,
  };
};
function decodeBatches(sqlite, rows, { full = true } = {}) {
  const bids = rows.map((r) => r.id);
  const cols = childRowsOf(sqlite, 'import_batch_columns', 'batch_id', bids, { order: 'ord' });
  const hist = full ? childRowsOf(sqlite, 'import_batch_history', 'batch_id', bids, { order: 'at, rowid' }) : null;
  const created = full ? childRowsOf(sqlite, 'import_batch_created_prospects', 'batch_id', bids, { order: 'ord' }) : null;
  const dataRows = full ? childRowsOf(sqlite, 'import_batch_rows', 'batch_id', bids, { order: 'row_no' }) : null;
  const errors = full ? childRowsOf(sqlite, 'import_batch_row_errors', 'batch_id', bids, { order: 'ord', subKey: ['row_no'] }) : null;
  return rows.map((row) => {
    const b = batchCore(row);
    const c = cols.all(row.id);
    const out = { ...b, header: c.map((x) => x.header), mapping: row.mapped ? Object.fromEntries(c.filter((x) => x.field !== null).map((x) => [x.header, x.field])) : null };
    if (!full) return out;
    return {
      ...out,
      rows: dataRows.all(row.id).map((r) => ({ row: r.row_no, record: recordOf(r), errors: errors.all(row.id, r.row_no).map((e) => e.message), disposition: r.disposition, matchPlayerId: r.match_player_id })),
      createdProspectIds: created.all(row.id).map((x) => x.prospect_id),
      history: hist.all(row.id).map((h) => {
        const x = decode(HISTORY_SPEC, h);
        const detail = x.action === 'validated' ? { ...b.summary } : x.action === 'committed' ? { created: x.created } : { removed: x.removed, kept: x.kept };
        return { id: x.id, at: x.at, byKind: x.byKind, byId: x.byId, byName: x.byName, action: x.action, detail };
      }),
    };
  });
}
const decodeProspect = (row) => decode(PROSPECT_SPEC, row);
/** Reviews are selected with their batch row's record columns (REVIEW_SELECT): the record is that row's, never a copy. */
const REVIEW_SELECT = `SELECT r.*, ${PROSPECT_FIELDS.map((f) => `b.${RECORD_COLUMN[f]}`).join(', ')} FROM identity_reviews r LEFT JOIN import_batch_rows b ON b.batch_id = r.batch_id AND b.row_no = r.row_no`;
function decodeReviews(rows) {
  return rows.map((row) => {
    const r = decode(REVIEW_SPEC, row);
    return { id: r.id, orgId: r.orgId, batchId: r.batchId, row: r.row, record: recordOf(row), candidatePlayerId: r.candidatePlayerId, status: r.status, resolvedBy: r.resolvedBy, resolvedAt: r.resolvedAt, resolution: r.resolution, createdAt: r.createdAt };
  });
}
function decodeKeys(sqlite, rows) {
  const scopes = childRowsOf(sqlite, 'api_key_scopes', 'api_key_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(KEY_SPEC, row), scopes: scopes.all(row.id).map((x) => x.scope) }));
}
function decodeEndpoints(sqlite, rows) {
  const events = childRowsOf(sqlite, 'webhook_endpoint_events', 'endpoint_id', rows.map((r) => r.id), { order: 'ord' });
  return rows.map((row) => ({ ...decode(ENDPOINT_SPEC, row), events: events.all(row.id).map((x) => x.event) }));
}
function decodeDeliveries(sqlite, rows) {
  const attempts = childRowsOf(sqlite, 'webhook_delivery_attempts', 'delivery_id', rows.map((r) => r.id), { order: 'attempt_no' });
  return rows.map((row) => {
    const d = decode(DELIVERY_SPEC, row);
    return {
      id: d.id, endpointId: d.endpointId, orgId: d.orgId, eventId: d.eventId, type: d.type, data: dataOf(d), status: d.status,
      attempts: attempts.all(row.id).map((a) => (a.http_status !== null ? { at: a.attempted_at, status: a.http_status } : { at: a.attempted_at, error: a.error })),
      nextAt: d.nextAt, createdAt: d.createdAt, deliveredAt: d.deliveredAt,
    };
  });
}

// ------------------------------------------------------------------ snapshot (fixtures and the persistence batteries)
export const integrationsLive = (sqlite) => migrationApplied(sqlite, INTEGRATIONS_MIGRATION);
function readAll(sqlite) {
  const all = (t) => sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return {
    importBatches: decodeBatches(sqlite, all('import_batches')),
    prospects: all('prospects').map(decodeProspect),
    identityReviews: decodeReviews(sqlite.prepare(`${REVIEW_SELECT} ORDER BY r.rowid`).all()),
    apiKeys: decodeKeys(sqlite, all('api_keys')),
    webhookEndpoints: decodeEndpoints(sqlite, all('webhook_endpoints')),
    webhookDeliveries: decodeDeliveries(sqlite, all('webhook_deliveries')),
  };
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back); null before its migration. */
export const INTEGRATIONS_RECORDS = {
  names: INTEGRATIONS_COLLECTIONS,
  read(sqlite) { return integrationsLive(sqlite) ? readAll(sqlite) : null; },
};
const PLAYER_REFS_SQL = 'SELECT match_player_id AS pid FROM import_batch_rows WHERE match_player_id IS NOT NULL UNION ALL SELECT candidate_player_id FROM identity_reviews';
export const unresolvedPlayerReferences = (sqlite) => (integrationsLive(sqlite)
  ? sqlite.prepare(`SELECT count(*) AS n FROM (${PLAYER_REFS_SQL}) x WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = x.pid)`).get().n
  : null);

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['create', 'commit', 'reverse', 'keepSeparate', 'resolve', 'revoke', 'touch', 'rotate', 'deactivate', 'recordAttempt', 'abandon']);

/**
 * `createIntegrationsRepository({ sqlite, unit, now, log })`: `batches`, `prospects`, `reviews`, `apiKeys`, `endpoints`
 * and `deliveries`, each with its writes and queries, plus `reads` (the queries alone: `integrationReads`).
 */
export function createIntegrationsRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the integrations repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const st = statements(sqlite);
  const typedOr = (type, raw, name) => { const t = type(raw, name); if (!t.ok) throw refusal('INTEGRATIONS_INPUT_INVALID', t.reason); return t.record; };
  const str = (v) => typeof v === 'string';
  const needOrg = (table, rec) => { if (!q('SELECT 1 FROM orgs WHERE id = ?').get(rec.orgId)) throw refusal('INTEGRATIONS_REFERENCE_MISSING', `${table} ${rec.id}: orgId names no organisation (${rec.orgId})`); };
  const needStaff = (table, rec, userId, field) => {
    const u = q('SELECT org_id FROM org_users WHERE id = ?').get(userId);
    if (!u) throw refusal('INTEGRATIONS_REFERENCE_MISSING', `${table} ${rec.id}: ${field} names no staff member (${userId})`);
    if (u.org_id !== rec.orgId) throw refusal('INTEGRATIONS_INPUT_INVALID', `${table} ${rec.id}: ${field} is another organisation's staff member`);
  };
  const notFound = (table, id) => refusal('INTEGRATIONS_NOT_FOUND', `${table} ${id} is not a record of the repository`);
  const pageBy = (sql, params, { after = null, limit }, map) => {
    const rows = q(sql).all(...params, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.rowid]);
    return { items: map(page.items), nextCursor: page.nextCursor };
  };

  // ---- import batches
  const decB = (rows, o) => decodeBatches(sqlite, rows, o).map(deepFreeze);
  const batchById = (id) => (str(id) ? decB(q('SELECT * FROM import_batches WHERE id = ?').all(id))[0] ?? null : null);
  const withRowCount = (rows) => {
    const counts = new Map(q('SELECT batch_id, COUNT(*) AS n FROM import_batch_rows WHERE batch_id IN (SELECT value FROM json_each(?)) GROUP BY batch_id').all(JSON.stringify(rows.map((r) => r.id))).map((r) => [r.batch_id, r.n]));
    const created = new Map(q('SELECT batch_id, COUNT(*) AS n FROM import_batch_created_prospects WHERE batch_id IN (SELECT value FROM json_each(?)) GROUP BY batch_id').all(JSON.stringify(rows.map((r) => r.id))).map((r) => [r.batch_id, r.n]));
    return decodeBatches(sqlite, rows, { full: false }).map((b) => deepFreeze({ ...b, rowCount: counts.get(b.id) ?? 0, created: created.get(b.id) ?? 0 }));
  };
  const appendHistory = (b, entry) => st.history.run(historyRow(b.id, typedOr((raw, at) => typeHistory(raw, at, b), entry, `import_batch_history ${b.id}`)));
  const liveKeyTaken = (orgId, provider, externalId) => !!q('SELECT 1 FROM prospects WHERE org_id = ? AND provider = ? AND external_id = ? AND reversed_at IS NULL').get(orgId, provider, externalId);
  const insertProspect = (raw, batch) => {
    const p = typedOr(typeProspect, raw, 'prospects');
    if (p.orgId !== batch.orgId || p.batchId !== batch.id) throw refusal('INTEGRATIONS_INPUT_INVALID', `prospects ${p.id}: names another batch or organisation`);
    if (q('SELECT 1 FROM prospects WHERE id = ?').get(p.id)) throw refusal('INTEGRATIONS_DUPLICATE', `prospects ${p.id} already exists`);
    if (p.reversedAt === null && liveKeyTaken(p.orgId, p.provider, p.externalId)) throw refusal('IMPORT_IDENTITY_TAKEN', `prospects ${p.id}: ${p.provider} ${p.externalId} is already a live prospect of the organisation`, { provider: p.provider, externalId: p.externalId });
    st.prospect.run(encode(PROSPECT_SPEC, p));
    return p;
  };
  const batches = {
    /** A validated batch (the dry run): the batch, its columns, rows and first history entry. */
    create: (raw) => operation(() => {
      const b = typedOr(typeBatch, raw, 'importBatches');
      if (b.status !== 'validated' || b.history.length !== 1 || b.history[0].action !== 'validated') throw refusal('INTEGRATIONS_INPUT_INVALID', `import_batches ${b.id}: a new batch is validated, with its validation entry only`);
      if (batchById(b.id)) throw refusal('INTEGRATIONS_DUPLICATE', `import_batches ${b.id} already exists`);
      needOrg('import_batches', b); needStaff('import_batches', b, b.createdBy, 'createdBy');
      writeBatch(st, b);
      return batchById(b.id);
    }),
    /**
     * Commit a validated batch at `at` by `by` (`{ id, name }`): the prospects (in order; the batch lists them as the
     * ones a reversal undoes), the identity reviews, the status and the history entry, at once.
     */
    commit: (id, { at, by, prospects: newProspects, reviews: newReviews, historyId }) => operation(() => {
      const b = batchById(id);
      if (!b) throw notFound('import_batches', id);
      if (b.status !== 'validated') throw refusal('INTEGRATIONS_INPUT_INVALID', `import_batches ${id} is ${b.status}, not validated`);
      newProspects.forEach((p, i) => { insertProspect(p, b); st.created.run(b.id, i, p.id); });
      for (const raw of newReviews) {
        const r = typedOr((x, a) => typeReview(x, a), raw, 'identityReviews');
        if (r.orgId !== b.orgId || r.batchId !== b.id || r.status !== 'open') throw refusal('INTEGRATIONS_INPUT_INVALID', `identity_reviews ${r.id}: a new review is open and names this batch`);
        const row = b.rows.find((x) => x.row === r.row);
        if (row?.disposition !== 'ambiguous_identity' || row.matchPlayerId !== r.candidatePlayerId) throw refusal('INTEGRATIONS_INPUT_INVALID', `identity_reviews ${r.id}: names no ambiguous row of the batch`);
        st.review.run(encode(REVIEW_SPEC, r));
      }
      q("UPDATE import_batches SET status = 'committed', committed_at = ? WHERE id = ?").run(at, id);
      appendHistory(b, { id: historyId, at, byKind: 'org_user', byId: by.id, byName: by.name, action: 'committed', detail: { created: newProspects.length } });
      return batchById(id);
    }),
    /** Reverse a committed batch: its own prospects that are still live are reversed at `at`. Returns `{ batch, removed }`. */
    reverse: (id, { at, by, historyId }) => operation(() => {
      const b = batchById(id);
      if (!b) throw notFound('import_batches', id);
      if (b.status !== 'committed') throw refusal('INTEGRATIONS_INPUT_INVALID', `import_batches ${id} is ${b.status}, not committed`);
      const removed = q('UPDATE prospects SET reversed_at = ? WHERE reversed_at IS NULL AND id IN (SELECT prospect_id FROM import_batch_created_prospects WHERE batch_id = ?)').run(at, id).changes;
      q("UPDATE import_batches SET status = 'reversed', reversed_at = ? WHERE id = ?").run(at, id);
      appendHistory(b, { id: historyId, at, byKind: 'org_user', byId: by.id, byName: by.name, action: 'reversed', detail: { removed, kept: 0 } });
      return { batch: batchById(id), removed };
    }),
    byId: batchById,
    forOrgById: (orgId, id) => { const b = batchById(id); return b && b.orgId === orgId ? b : null; },
    /** A page of the organisation's batches, newest first, without their rows (`rowCount` and `created` instead). */
    page: (orgId, page) => pageBy('SELECT rowid, * FROM import_batches WHERE org_id = ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?', [orgId], page, withRowCount),
    /** The newest batches of every organisation, without their rows (the admin view). */
    recent: (limit = 50) => withRowCount(q('SELECT * FROM import_batches ORDER BY rowid DESC LIMIT ?').all(limit)),
    /** The organisation's batches named by `batchIds`, without their rows. */
    forOrgByIds: (orgId, batchIds) => withRowCount(q('SELECT * FROM import_batches WHERE org_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid').all(orgId, JSON.stringify(batchIds))),
    /** Every batch's history of the organisation (the audit export): `[{ id, history }]`, oldest batch first. */
    historiesForOrg: (orgId) => decB(q('SELECT * FROM import_batches WHERE org_id = ? ORDER BY rowid').all(orgId)).map((b) => deepFreeze({ id: b.id, history: b.history })),
    hasCommitted: (orgId) => !!q("SELECT 1 FROM import_batches WHERE org_id = ? AND status = 'committed'").get(orgId),
  };

  // ---- prospects
  const prospectById = (id) => (str(id) ? ((r) => (r ? deepFreeze(decodeProspect(r)) : null))(q('SELECT * FROM prospects WHERE id = ?').get(id)) : null);
  const prospects = {
    /** An identity review kept separate: a prospect of the review's batch, outside the batch's created list. */
    keepSeparate: (raw) => operation(() => {
      const b = batchById(raw?.batchId);
      if (!b) throw refusal('INTEGRATIONS_REFERENCE_MISSING', `prospects ${raw?.id}: no batch ${raw?.batchId}`);
      return deepFreeze(insertProspect(raw, b));
    }),
    byId: prospectById,
    liveKeyTaken,
    /** A page of the organisation's live prospects, newest first. */
    page: (orgId, page) => pageBy('SELECT rowid, * FROM prospects WHERE org_id = ? AND reversed_at IS NULL AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?', [orgId], page, (rows) => rows.map((r) => deepFreeze(decodeProspect(r)))),
    /** Every live prospect of the organisation, oldest first (the versioned export: one organisation's own records). */
    liveForOrg: (orgId) => q('SELECT * FROM prospects WHERE org_id = ? AND reversed_at IS NULL ORDER BY rowid').all(orgId).map((r) => deepFreeze(decodeProspect(r))),
    anyForOrg: (orgId) => !!q('SELECT 1 FROM prospects WHERE org_id = ?').get(orgId),
  };

  // ---- identity reviews
  const decR = (rows) => decodeReviews(rows).map(deepFreeze);
  const reviewById = (id) => (str(id) ? decR(q(`${REVIEW_SELECT} WHERE r.id = ?`).all(id))[0] ?? null : null);
  const reviews = {
    /** Resolve an open review: `{ resolution, by, at }`. */
    resolve: (id, { resolution, by, at }) => operation(() => {
      const r = reviewById(id);
      if (!r) throw notFound('identity_reviews', id);
      if (r.status !== 'open') throw refusal('INTEGRATIONS_DUPLICATE', `identity_reviews ${id} is already resolved`);
      const t = typedOr(typeReview, { ...r, record: undefined, status: 'resolved', resolution, resolvedBy: by, resolvedAt: at }, 'identityReviews');
      st.review.run(encode(REVIEW_SPEC, t));
      return reviewById(id);
    }),
    byId: reviewById,
    forOrgById: (orgId, id) => { const r = reviewById(id); return r && r.orgId === orgId ? r : null; },
    openForOrg: (orgId) => decR(q(`${REVIEW_SELECT} WHERE r.org_id = ? AND r.status = 'open' ORDER BY r.rowid`).all(orgId)),
  };

  // ---- API keys
  const decK = (rows) => decodeKeys(sqlite, rows).map(deepFreeze);
  const keyById = (id) => (str(id) ? decK(q('SELECT * FROM api_keys WHERE id = ?').all(id))[0] ?? null : null);
  const apiKeys = {
    create: (raw) => operation(() => {
      const k = typedOr(typeApiKey, raw, 'apiKeys');
      if (k.revokedAt !== null || k.lastUsedAt !== null) throw refusal('INTEGRATIONS_INPUT_INVALID', `api_keys ${k.id}: a new key is neither revoked nor used`);
      if (keyById(k.id)) throw refusal('INTEGRATIONS_DUPLICATE', `api_keys ${k.id} already exists`);
      needOrg('api_keys', k);
      writeKey(st, k);
      return keyById(k.id);
    }),
    /** Revoke once (a revoked key keeps its first revocation). */
    revoke: (id, at) => operation(() => {
      if (!keyById(id)) throw notFound('api_keys', id);
      q('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
      return keyById(id);
    }),
    /** Record a use of the key at `at`. */
    touch: (id, at) => operation(() => { q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id); }),
    byId: keyById,
    forOrgById: (orgId, id) => { const k = keyById(id); return k && k.orgId === orgId ? k : null; },
    /** The live key with this hash, or null. */
    liveByHash: (hash) => decK(q('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').all(String(hash)))[0] ?? null,
    forOrg: (orgId) => decK(q('SELECT * FROM api_keys WHERE org_id = ? ORDER BY rowid').all(orgId)),
  };

  // ---- webhook endpoints
  const decE = (rows) => decodeEndpoints(sqlite, rows).map(deepFreeze);
  const endpointById = (id) => (str(id) ? decE(q('SELECT * FROM webhook_endpoints WHERE id = ?').all(id))[0] ?? null : null);
  const endpoints = {
    create: (raw) => operation(() => {
      const w = typedOr(typeEndpoint, raw, 'webhookEndpoints');
      if (!w.active || w.secretPrev !== null) throw refusal('INTEGRATIONS_INPUT_INVALID', `webhook_endpoints ${w.id}: a new endpoint is active, with one secret`);
      if (endpointById(w.id)) throw refusal('INTEGRATIONS_DUPLICATE', `webhook_endpoints ${w.id} already exists`);
      needOrg('webhook_endpoints', w);
      writeEndpoint(st, w);
      return endpointById(w.id);
    }),
    /** A new signing secret; the current one stays valid for verification until `prevValidUntil`. */
    rotate: (id, { secret, prevValidUntil }) => operation(() => {
      const w = endpointById(id);
      if (!w) throw notFound('webhook_endpoints', id);
      const t = typedOr(typeEndpoint, { ...w, events: [...w.events], secret, secretPrev: w.secret, secretPrevValidUntil: prevValidUntil }, 'webhookEndpoints');
      st.endpoint.run(encode(ENDPOINT_SPEC, t));
      return endpointById(id);
    }),
    deactivate: (id) => operation(() => {
      if (!endpointById(id)) throw notFound('webhook_endpoints', id);
      q('UPDATE webhook_endpoints SET active = 0 WHERE id = ?').run(id);
      return endpointById(id);
    }),
    byId: endpointById,
    forOrgById: (orgId, id) => { const w = endpointById(id); return w && w.orgId === orgId ? w : null; },
    forOrg: (orgId) => decE(q('SELECT * FROM webhook_endpoints WHERE org_id = ? ORDER BY rowid').all(orgId)),
    /** The organisation's active endpoints subscribed to `type`. */
    subscribed: (orgId, type) => decE(q('SELECT w.* FROM webhook_endpoints w JOIN webhook_endpoint_events e ON e.endpoint_id = w.id WHERE w.org_id = ? AND w.active = 1 AND e.event = ? ORDER BY w.rowid').all(orgId, type)),
  };

  // ---- webhook deliveries
  const decD = (rows) => decodeDeliveries(sqlite, rows).map(deepFreeze);
  const deliveryById = (id) => (str(id) ? decD(q('SELECT * FROM webhook_deliveries WHERE id = ?').all(id))[0] ?? null : null);
  const deliveries = {
    create: (raw) => operation(() => {
      const d = typedOr(typeDelivery, raw, 'webhookDeliveries');
      if (d.status !== 'queued' || d.attempts.length) throw refusal('INTEGRATIONS_INPUT_INVALID', `webhook_deliveries ${d.id}: a new delivery is queued, with no attempts`);
      if (deliveryById(d.id)) throw refusal('INTEGRATIONS_DUPLICATE', `webhook_deliveries ${d.id} already exists`);
      const w = endpointById(d.endpointId);
      if (!w) throw refusal('INTEGRATIONS_REFERENCE_MISSING', `webhook_deliveries ${d.id}: no endpoint ${d.endpointId}`);
      if (w.orgId !== d.orgId) throw refusal('INTEGRATIONS_INPUT_INVALID', `webhook_deliveries ${d.id}: the endpoint is another organisation's`);
      writeDelivery(st, d);
      return deliveryById(d.id);
    }),
    /**
     * Record one attempt (`{ at, status }` or `{ at, error }`) and where the delivery stands after it: `{ status,
     * nextAt, deliveredAt }` (the fields not given are kept).
     */
    recordAttempt: (id, attempt, change = {}) => operation(() => {
      const d = deliveryById(id);
      if (!d) throw notFound('webhook_deliveries', id);
      const a = typedOr((x, at) => typeAttempt(x, at), attempt, `webhook_deliveries ${id} attempt`);
      if (d.attempts.length >= L.attempts) throw refusal('INTEGRATIONS_INPUT_INVALID', `webhook_deliveries ${id} holds ${L.attempts} attempts already`);
      const next = typedOr(typeDelivery, { ...d, data: { ...d.data }, attempts: [...d.attempts, a], ...change }, 'webhookDeliveries');
      writeDelivery(st, next, { attempts: false });
      st.attempt.run(id, d.attempts.length + 1, a.at, a.status ?? null, a.error ?? null);
      return deliveryById(id);
    }),
    /** The endpoint is gone or inactive: the delivery is abandoned without an attempt. */
    abandon: (id) => operation(() => {
      if (!deliveryById(id)) throw notFound('webhook_deliveries', id);
      q("UPDATE webhook_deliveries SET status = 'abandoned' WHERE id = ? AND status IN ('queued','retrying')").run(id);
      return deliveryById(id);
    }),
    byId: deliveryById,
    /** The deliveries due at `at` (queued or retrying, their time come), oldest due first. */
    due: (at, limit = 200) => decD(q("SELECT * FROM webhook_deliveries WHERE status IN ('queued','retrying') AND next_at <= ? ORDER BY next_at, rowid LIMIT ?").all(at, limit)),
    /** The endpoint's newest deliveries, newest first. */
    recentForEndpoint: (endpointId, limit = 100) => decD(q('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY rowid DESC LIMIT ?').all(endpointId, limit)),
    backlogCount: () => q("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('queued','retrying')").get().n,
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const repo = { batches, prospects, reviews, apiKeys, endpoints, deliveries };
  const counters = Object.fromEntries([
    ['importBatches', 'import_batches'], ['prospects', 'prospects'], ['identityReviews', 'identity_reviews'],
    ['apiKeys', 'api_keys'], ['webhookEndpoints', 'webhook_endpoints'], ['webhookDeliveries', 'webhook_deliveries'],
  ].map(([n, t]) => [n, q(`SELECT COUNT(*) AS n FROM ${t}`)]));
  return {
    ...repo,
    /** The queries alone, for modules that must not write (`integrationReads`). */
    reads: Object.freeze(Object.fromEntries(Object.entries(repo).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!integrationsLive(sqlite)) throw new Error(`the integrations repository needs ${INTEGRATIONS_MIGRATION} recorded; it never imports an in-memory array`);
      return { counts: this.counts() };
    },
    counts() { return Object.fromEntries(INTEGRATIONS_COLLECTIONS.map((n) => [n, counters[n].get().n])); },
    pending: () => 0,
    exportAll() { return INTEGRATIONS_RECORDS.read(sqlite); },
    log,
    now,
  };
}
