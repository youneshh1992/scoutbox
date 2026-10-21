/**
 * The eight audit collections as tables — migration plan step S6b (Candidate A of
 * docs/architecture/sqlite-migration-plan.md §D.4 as accepted at 1792fc7; the Founder's
 * decisions Q4, Q4b and Q5 of 19 October 2026, recorded in §D.5).
 *
 * Owns eight tables, one read-only view each, one participant:
 *
 *   blocks          { id, playerId, orgId, by, reason, ts }                                   → db.blocks
 *   reports         { id, ts, by, byId, byOrgId?, targetKind, targetOrgId, targetScoutName?,
 *                     targetPlayerId?, reason, urgent, status, outcome, resolvedAt }          → db.reports
 *   moderation_log  { id, ts, context, flags, severity, excerpt }                            → db.moderationLog
 *   org_notes       { id, orgId, playerId, userId, scoutName, text, ts }                     → db.orgNotes
 *   ledger          { id, ts, ...entry }  (type, playerId, orgId, orgName, userId, scoutName,
 *                     detail — and whatever else a caller passed)                            → db.ledger
 *   ops_events      { id, at, kind, detail }                                                 → db.opsEvents
 *   source_changes  { id, playerId, type, sourceSystem, sourceId, occurredAt, detail }       → db.sourceChanges
 *   idv_queue       { id, guardianId, guardianName, documentType, documentRef, provider,
 *                     reference, ts, status }                                                → db.idvQueue
 *
 * WHAT THE ROWS ARE. Each collection was a JSON blob every build wrote through the
 * literals above (server.mjs ledgerAppend, handleReport, moderateOrRefuse, the block
 * and note routes, the IDV route; m13 delivery/enterprise/imports for the ops events;
 * m181 recordSourceChange). The mapping is key for key, in the writer's order.
 *
 * LOSSLESS, BY CONSTRUCTION. Nothing a blob held is coerced, narrowed or dropped:
 *   - every unknown own field of a record is kept in `extra_json` and spread back FIRST
 *     (the S7 export convention; own "__proto__" keys are data, never assigned);
 *   - a known key that is ABSENT is recorded in `absent_keys_json` and comes back absent
 *     (the automatic report has no targetPlayerId key; a user report has no byOrgId; an
 *     org-only ledger row may have no playerId key); a present null comes back null;
 *   - a known key whose value is NOT the column's type — handleReport stores the
 *     `targetPlayerId` it received (a number, an object), the player block route stores
 *     any truthy `orgId` and `reason`, a legacy `ts` may be a float — is kept as JSON in
 *     `offtype_json` under its key and comes back exactly; the column stays NULL;
 *   - nested values (`context`, `flags`, `detail`) are whole JSON values;
 *   - vocabularies are OPEN (no CHECK on `by`, `severity`, `provider`, `status`, `kind`,
 *     `type`, `sourceSystem`, `targetKind`): the writers' sets are not narrowed and the
 *     two ops-event kinds the first DDL draft forgot (backup_refused, backup_failed) are
 *     ordinary rows;
 *   - a non-finite number in live data is kept live and persisted as the blob's JSON
 *     would have written it (null; the S7c rule).
 * The only refusals: an entry that is not an object, an `id` that is not a non-empty
 * string, a duplicate id within a collection, a value JSON cannot carry, and — for the
 * IDV queue only — a `guardianId` that is not a non-empty string or names no guardian.
 *
 * REFERENCES — THE APPROVED CONTRACT (plan §D.4, Q4/Q4b/Q5):
 *   Domain P (TOLERANT, historical): blocks.player_id, reports.target_player_id,
 *     org_notes.player_id, ledger.player_id, source_changes.player_id carry NO foreign key
 *     and NO parent-existence rule. An unresolved id — a player deleted today (the hard
 *     delete keeps these rows, server.mjs deletePlayerData), a pre-S4a import, a report
 *     naming a player that never existed — is COUNTED (the cutover record, the data-layer
 *     report, `unresolvedPlayerReferences`) and never refused, never given a fabricated
 *     parent, never deleted. An absent id proves nothing about why it is absent. The
 *     organisation and staff references (org_id, by_org_id, target_org_id, user_id) are
 *     historical pointers the routes never checked (a player's block names any truthy
 *     orgId) and carry no foreign key either.
 *   Domain G (STRICT, live): idv_queue.guardian_id carries NO foreign key yet (the
 *     identity snapshot deletes and reinserts every guardian row — plan §D.2a) but every
 *     write refuses a guardian that does not exist (IDV_GUARDIAN_MISSING), the import
 *     refuses an entry naming a missing guardian, and `assertIdvQueueGuardiansConsistent`
 *     checks every retained or incoming entry against the FINAL guardians table whenever
 *     a snapshot writes the queue OR rewrites the identity pair (the queue omitted
 *     included). A miss refuses the whole write with ids only.
 *   Q5: lifting a block DELETES its row (blocks.remove), as the route always did; no
 *     lifted_at/lifted_by, no retained block history.
 * The source-change cap (20 000, m181) stays a DELETE of the oldest rows by insertion
 * order (sourceChanges.trimTo). A report's resolution and an IDV status change are
 * UPDATEs by row id of exactly the fields the routes change (reports.patch: status,
 * outcome, resolvedAt; idvQueue.patch: status). Everything else is append-only.
 *
 * THE ORDERING KEY. Each table has `seq INTEGER PRIMARY KEY`: array position at import,
 * the next value at append, preserved by backup/restore and the rollback. Every reader
 * (newest-first lists are `slice().reverse()` of the view) sees insertion order.
 *
 * WHERE A ROW BECOMES DURABLE (nothing new). STAGED mode in the server: a mutation
 * changes the mirror at once and its SQL waits for the next snapshot save, so each row
 * lands in exactly the save that carried its blob before S6b — a block with its ledger
 * row in the next save, a moderation hit in moderateOrRefuse's persist(), a report in
 * the next save (its suspension blocks and frozen requests alongside), a note in the
 * next save, a source change in m181's persistNow(), an ops event in its caller's save;
 * the IDV entry and the admin toggle join their units of work (the guardian column
 * commits with them). A failed ordinary save keeps the mirror and the queue (the next
 * save lands them once); an aborted unit restores the pre-unit state IN PLACE through
 * the graph memento (repositories/memento.mjs), held views and nested values included.
 *
 * Whether the tables are authoritative is decided by the cutover record
 * `0013_safety_audit` in `data_migrations`, never by the tables existing. Refusals
 * (SAFETY_AUDIT_IMPORT_BLOCKED, IDV_GUARDIAN_MISSING) name collections, positions, ids
 * and reasons — never a reason text, a note, an excerpt, a name or a document value.
 */
import { readonlyView } from './readonly.mjs';
import { captureGraph, restoreGraph } from './memento.mjs';
import { migrationApplied, transaction } from './database.mjs';
import { cloneJson } from './outboxPush.mjs';

export const SAFETY_AUDIT_MIGRATION = '0013_safety_audit';
/** `meta` key holding the cutover record: counts only, never data. */
export const SAFETY_AUDIT_CUTOVER_META = 'safetyAuditCutover';

const EXTRA_CHECK = (col) => `CHECK (${col} IS NULL OR (json_valid(${col}) AND json_type(${col}) = 'object'))`;
const ABSENT_CHECK = "CHECK (absent_keys_json IS NULL OR (json_valid(absent_keys_json) AND json_type(absent_keys_json) = 'array'))";
const JSON_CHECK = (col) => `CHECK (${col} IS NULL OR json_valid(${col}))`;

/**
 * The eight domains: the table, the writer's literal as [column, key, kind] in the
 * writer's order (`id` first), the player reference key (Domain P) or the guardian
 * reference key (Domain G), the indexes. Kinds: text (a string in the column, anything
 * else in offtype_json), int (a safe integer), bool (0/1), json (any JSON value).
 */
const DOMAINS = Object.freeze({
  blocks: { table: 'blocks', playerKey: 'playerId', cols: [['id', 'id', 'id'], ['player_id', 'playerId', 'text'], ['org_id', 'orgId', 'text'], ['by_kind', 'by', 'text'], ['reason', 'reason', 'text'], ['created_at', 'ts', 'int']], indexes: [['blocks_player_id_org_id', 'player_id, org_id']] },
  reports: { table: 'reports', playerKey: 'targetPlayerId', cols: [['id', 'id', 'id'], ['created_at', 'ts', 'int'], ['by_kind', 'by', 'text'], ['by_id', 'byId', 'text'], ['by_org_id', 'byOrgId', 'text'], ['target_kind', 'targetKind', 'text'], ['target_org_id', 'targetOrgId', 'text'], ['target_scout_name', 'targetScoutName', 'text'], ['target_player_id', 'targetPlayerId', 'text'], ['reason', 'reason', 'text'], ['urgent', 'urgent', 'bool'], ['status', 'status', 'text'], ['outcome', 'outcome', 'text'], ['resolved_at', 'resolvedAt', 'int']], indexes: [['reports_by_kind_by_id', 'by_kind, by_id'], ['reports_target_org_id_urgent_status', 'target_org_id, urgent, status'], ['reports_status_created_at', 'status, created_at'], ['reports_target_player_id', 'target_player_id']] },
  moderationLog: { table: 'moderation_log', cols: [['id', 'id', 'id'], ['created_at', 'ts', 'int'], ['context_json', 'context', 'json'], ['flags_json', 'flags', 'json'], ['severity', 'severity', 'text'], ['excerpt', 'excerpt', 'text']], indexes: [['moderation_log_severity', 'severity'], ['moderation_log_created_at', 'created_at']] },
  orgNotes: { table: 'org_notes', playerKey: 'playerId', cols: [['id', 'id', 'id'], ['org_id', 'orgId', 'text'], ['player_id', 'playerId', 'text'], ['user_id', 'userId', 'text'], ['scout_name', 'scoutName', 'text'], ['text', 'text', 'text'], ['created_at', 'ts', 'int']], indexes: [['org_notes_org_id_player_id_created_at', 'org_id, player_id, created_at']] },
  ledger: { table: 'ledger', playerKey: 'playerId', cols: [['id', 'id', 'id'], ['occurred_at', 'ts', 'int'], ['type', 'type', 'text'], ['player_id', 'playerId', 'text'], ['org_id', 'orgId', 'text'], ['org_name', 'orgName', 'text'], ['user_id', 'userId', 'text'], ['actor_name', 'scoutName', 'text'], ['detail_json', 'detail', 'json']], indexes: [['ledger_player_id_type', 'player_id, type'], ['ledger_player_id_org_id_occurred_at', 'player_id, org_id, occurred_at'], ['ledger_org_id_type', 'org_id, type'], ['ledger_occurred_at', 'occurred_at']] },
  opsEvents: { table: 'ops_events', cols: [['id', 'id', 'id'], ['occurred_at', 'at', 'int'], ['kind', 'kind', 'text'], ['detail_json', 'detail', 'json']], indexes: [['ops_events_kind', 'kind'], ['ops_events_occurred_at', 'occurred_at']] },
  sourceChanges: { table: 'source_changes', playerKey: 'playerId', cols: [['id', 'id', 'id'], ['player_id', 'playerId', 'text'], ['type', 'type', 'text'], ['source_system', 'sourceSystem', 'text'], ['source_id', 'sourceId', 'text'], ['occurred_at', 'occurredAt', 'int'], ['detail_json', 'detail', 'json']], indexes: [['source_changes_player_id_occurred_at', 'player_id, occurred_at']] },
  idvQueue: { table: 'idv_queue', guardianKey: 'guardianId', cols: [['id', 'id', 'id'], ['guardian_id', 'guardianId', 'guardian'], ['guardian_name', 'guardianName', 'text'], ['document_type', 'documentType', 'text'], ['document_ref_last4', 'documentRef', 'text'], ['provider', 'provider', 'text'], ['reference', 'reference', 'text'], ['created_at', 'ts', 'int'], ['status', 'status', 'text']], indexes: [['idv_queue_guardian_id_created_at', 'guardian_id, created_at']] },
});
/** The collections, in snapshot-dispatch order. */
export const AUDIT_COLLECTIONS = Object.freeze(Object.keys(DOMAINS));
export const AUDIT_TABLE_NAMES = Object.freeze(AUDIT_COLLECTIONS.map((n) => DOMAINS[n].table));
/** The five tolerant player references (Domain P), by collection → the table and column. */
export const PLAYER_REFERENCE_TABLES = Object.freeze(AUDIT_COLLECTIONS.filter((n) => DOMAINS[n].playerKey).map((n) => ({ name: n, table: DOMAINS[n].table, column: DOMAINS[n].cols.find((c) => c[1] === DOMAINS[n].playerKey)[0] })));
/** The literal keys of each collection, in the writer's order (the export convention's second half). */
export const AUDIT_KEYS = Object.freeze(Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, Object.freeze(DOMAINS[n].cols.map((c) => c[1]))])));

const sqlType = (kind) => (kind === 'int' || kind === 'bool' ? 'INTEGER' : 'TEXT');
function tableDdl(name) {
  const d = DOMAINS[name];
  const cols = d.cols.filter((c) => c[2] !== 'id').map(([col, , kind]) => `  ${col.padEnd(18)} ${sqlType(kind)}${kind === 'guardian' ? ' NOT NULL' : ''}${kind === 'json' ? ` ${JSON_CHECK(col)}` : ''}`);
  return `CREATE TABLE ${d.table} (\n  seq                INTEGER PRIMARY KEY,\n  id                 TEXT NOT NULL UNIQUE,\n${cols.join(',\n')},\n  absent_keys_json   TEXT ${ABSENT_CHECK},\n  offtype_json       TEXT ${EXTRA_CHECK('offtype_json')},\n  extra_json         TEXT ${EXTRA_CHECK('extra_json')}\n) STRICT;\n${d.indexes.map(([idx, on]) => `CREATE INDEX ${idx} ON ${d.table} (${on});`).join('\n')}`;
}
export const SAFETY_AUDIT_DDL = AUDIT_COLLECTIONS.map(tableDdl).join('\n');

export const safetyAuditLive = (sqlite) => migrationApplied(sqlite, SAFETY_AUDIT_MIGRATION);
const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`);
const blocked = (detail, extra = {}) => Object.assign(new Error(`SAFETY_AUDIT_IMPORT_BLOCKED: ${detail}; nothing was imported`), { code: 'SAFETY_AUDIT_IMPORT_BLOCKED', ...extra });
const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const tableExists = (sqlite, name) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
/**
 * A detached, prototype-safe clone with the pre-S6b blob's JSON rules: a non-finite number in live data is kept live
 * (persisted as JSON null), and a NESTED undefined is stored as JSON.stringify stored it — an object property omitted,
 * an array entry null (review of c6cf5e1, F2: the Box Cam prefs writer's `detail.share` on a partial prefs row). A
 * function, a symbol, a BigInt, a non-plain object or a cycle is still refused by name.
 */
const AUDIT_JSON = Object.freeze({ nonFinite: 'keep', undefinedNested: 'json' });
const clone = (v, at) => cloneJson(v, at, AUDIT_JSON);
const parseJson = (text, at) => clone(JSON.parse(text), at).value;
const ids = (list) => list.slice(0, 20).join(', ') + (list.length > 20 ? ', …' : '');
/** A mirror object: extras first (the export convention), then the literal's present keys in the writer's order. */
function assemble(extra, literal) { const row = {}; for (const k of Object.keys(extra)) setOwn(row, k, extra[k]); for (const [k, v] of literal) row[k] = v; return row; }
const columnHolds = (kind, v) => (kind === 'text' || kind === 'guardian' || kind === 'id' ? typeof v === 'string' : kind === 'int' ? Number.isSafeInteger(v) : kind === 'bool' ? typeof v === 'boolean' : true);

// ------------------------------------------------------------------ validation (no coercion; every refusal names the reason, never a value)
/**
 * Validate one entry of `name`: `{ ok: true, row, absent, hasExtra, hasOfftype }` (the
 * mirror row, detached, extras first) or `{ ok: false, reason }`. A present `undefined`
 * is absent (JSON could not have carried it).
 */
export function validateAuditEntry(name, raw, at = name) {
  const d = DOMAINS[name]; if (!d) return { ok: false, reason: `${at}: unknown audit collection` };
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} is not an object (${describe(raw)})` };
  if (!nonEmpty(raw.id)) return { ok: false, reason: `${at}.id must be a non-empty string` };
  if (d.guardianKey && !nonEmpty(raw[d.guardianKey])) return { ok: false, reason: `${at}.${d.guardianKey} must be a non-empty string (the IDV queue names an existing guardian)` };
  const known = d.cols.map((c) => c[1]);
  const extra = {}; let hasExtra = false;
  for (const k of Object.keys(raw)) {
    if (known.includes(k) || raw[k] === undefined) continue;
    const c = clone(raw[k], `${at}.${k}`); if (c.reason) return { ok: false, reason: c.reason };
    setOwn(extra, k, c.value); hasExtra = true;
  }
  const literal = []; const absent = []; let hasOfftype = false;
  for (const [, key, kind] of d.cols) {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) { absent.push(key); continue; }
    const c = clone(raw[key], `${at}.${key}`); if (c.reason) return { ok: false, reason: c.reason };
    if (c.value !== null && !columnHolds(kind, c.value)) hasOfftype = true;
    literal.push([key, c.value]);
  }
  return { ok: true, row: assemble(extra, literal), absent, hasExtra, hasOfftype };
}
/** Validate a whole collection (unique ids); throws SAFETY_AUDIT_IMPORT_BLOCKED. Returns `{ rows, counts }`. */
export function validateAuditRows(name, rows, { label = name } = {}) {
  if (!Array.isArray(rows)) throw blocked(`${label} must be an array of entries (got ${describe(rows)})`);
  const out = []; const problems = []; const seen = new Set();
  const counts = { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0 };
  rows.forEach((raw, i) => {
    const v = validateAuditEntry(name, raw, `${label} entry #${i}`);
    if (!v.ok) { problems.push(v.reason); return; }
    if (seen.has(v.row.id)) { problems.push(`${label} entry #${i}: duplicates the id of an earlier entry (${v.row.id})`); return; }
    seen.add(v.row.id);
    if (v.hasExtra) counts.withExtraFields += 1; if (v.absent.length) counts.withAbsentKeys += 1; if (v.hasOfftype) counts.withOfftypeValues += 1;
    out.push(v.row);
  });
  if (problems.length) throw blocked(`${problems.length} invalid entr${problems.length === 1 ? 'y' : 'ies'} — ${problems.slice(0, 20).join('; ')}${problems.length > 20 ? '; …' : ''}`, { problems });
  counts.imported = out.length;
  return { rows: out, counts };
}

// ------------------------------------------------------------------ rows ↔ the tables
const jsonOrNull = (obj) => (Object.keys(obj).length ? JSON.stringify(obj) : null);
/** The INSERT/UPDATE parameters of a mirror row: the column holds the value when it is of the column's type, offtype_json keeps it otherwise; absent keys and extras recorded. */
function params(name, row) {
  const d = DOMAINS[name]; const known = d.cols.map((c) => c[1]);
  const out = {}; const absent = []; const off = {}; const extra = {};
  for (const k of Object.keys(row)) if (!known.includes(k)) setOwn(extra, k, row[k]);
  for (const [col, key, kind] of d.cols) {
    if (!Object.hasOwn(row, key)) { absent.push(key); out[col] = null; continue; }
    const v = row[key];
    if (v === null) { out[col] = null; continue; }
    if (!columnHolds(kind, v)) { setOwn(off, key, v); out[col] = null; continue; }
    out[col] = kind === 'bool' ? (v ? 1 : 0) : kind === 'json' ? JSON.stringify(v) : v;
  }
  out.absent_keys_json = absent.length ? JSON.stringify(absent) : null;
  out.offtype_json = jsonOrNull(off);
  out.extra_json = jsonOrNull(extra);
  return out;
}
function fromDb(name, r) {
  const d = DOMAINS[name];
  const extra = r.extra_json ? parseJson(r.extra_json, 'extra_json') : {};
  const absent = r.absent_keys_json ? JSON.parse(r.absent_keys_json) : [];
  const off = r.offtype_json ? parseJson(r.offtype_json, 'offtype_json') : {};
  const literal = [];
  for (const [col, key, kind] of d.cols) {
    if (absent.includes(key)) continue;
    if (Object.hasOwn(off, key)) { literal.push([key, off[key]]); continue; }
    const v = r[col];
    literal.push([key, v === null ? null : kind === 'bool' ? v === 1 : kind === 'json' ? parseJson(v, col) : v]);
  }
  return assemble(extra, literal);
}
const SELECT = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, `SELECT * FROM ${DOMAINS[n].table}`]));
const INSERT = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => { const cols = [...DOMAINS[n].cols.map((c) => c[0]), 'absent_keys_json', 'offtype_json', 'extra_json']; return [n, `INSERT INTO ${DOMAINS[n].table} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`]; }));
const UPDATE = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => { const cols = [...DOMAINS[n].cols.map((c) => c[0]).filter((c) => c !== 'id'), 'absent_keys_json', 'offtype_json', 'extra_json']; return [n, `UPDATE ${DOMAINS[n].table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`]; }));
const DELETE_BY_ID = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, `DELETE FROM ${DOMAINS[n].table} WHERE id = ?`]));
/** Every row of a collection in `seq` order: fresh objects from the file. */
function readRows(sqlite, name) { return sqlite.prepare(`${SELECT[name]} ORDER BY seq`).all().map((r) => fromDb(name, r)); }
/** Write the validated mirror rows in array order (the array position is the durable order). */
function writeRows(sqlite, name, rows) {
  sqlite.exec(`DELETE FROM ${DOMAINS[name].table};`);
  const ins = sqlite.prepare(INSERT[name]);
  for (const row of rows) ins.run(params(name, row));
  return rows.length;
}
const existingIds = (sqlite, table) => (tableExists(sqlite, table) ? new Set(sqlite.prepare(`SELECT id FROM ${table}`).all().map((r) => r.id)) : new Set());

/** The STRICT check an INCOMING idv_queue collection must pass before its rows are written: every guardianId names a guardian in the table as it stands (ids only). */
function checkIncomingGuardians(sqlite, rows, { label }) {
  if (!rows.length) return;
  const guardians = existingIds(sqlite, 'guardians');
  const missing = rows.filter((r) => !guardians.has(r.guardianId));
  if (missing.length) throw blocked(`IDV_GUARDIAN_MISSING: ${missing.length} IDV entr${missing.length === 1 ? 'y' : 'ies'} in ${label} name a guardian that does not exist (entries ${ids(missing.map((r) => r.id))}; guardians ${ids([...new Set(missing.map((r) => r.guardianId))])})`, { code: 'IDV_GUARDIAN_MISSING', entries: missing.map((r) => r.id) });
}
/**
 * The FINAL-STATE assertion for Domain G (Q4b): every idv_queue row names a guardian
 * present in the FINAL guardians table. Runs inside the caller's transaction whenever
 * a snapshot wrote the queue or rewrote the identity pair (the queue omitted included);
 * a miss THROWS with ids only, so the whole write rolls back. A no-op before the
 * cutover record exists.
 */
export function assertIdvQueueGuardiansConsistent(sqlite, { label = 'the snapshot' } = {}) {
  if (!safetyAuditLive(sqlite)) return;
  const rows = sqlite.prepare('SELECT id, guardian_id FROM idv_queue ORDER BY seq').all();
  if (!rows.length) return;
  const guardians = existingIds(sqlite, 'guardians');
  const missing = rows.filter((r) => !guardians.has(r.guardian_id));
  if (missing.length) throw refusal('IDV_GUARDIAN_MISSING', `${missing.length} IDV entr${missing.length === 1 ? 'y' : 'ies'} in ${label} name a guardian that does not exist in the final guardians table (entries ${ids(missing.map((r) => r.id))}; guardians ${ids([...new Set(missing.map((r) => r.guardian_id))])}); the write was rolled back and nothing was changed — remove the entries with their guardian, or keep the guardian`, { entries: missing.map((r) => r.id) });
}
/**
 * Domain P, the diagnostic (never a refusal): per collection, how many rows name a
 * player id (a string in the column) that is not in the players table. A count, not
 * provenance — it says how many rows resolve to nothing, not why.
 */
export function unresolvedPlayerReferences(sqlite) {
  const out = {};
  const players = tableExists(sqlite, 'players');
  for (const { name, table, column } of PLAYER_REFERENCE_TABLES) {
    if (!tableExists(sqlite, table)) { out[name] = 0; continue; }
    out[name] = players ? sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM players)`).get().n : sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL`).get().n;
  }
  return out;
}
/**
 * S4b-R, the companion diagnostic: per collection, how many rows name a player whose
 * record is RETAINED (an account deleted under the new behaviour). A count beside the
 * unresolved one — the unresolved count keeps counting the ids that resolve to no row
 * at all (players deleted before S4b-R, pre-S4a imports, ids that never existed: Q4),
 * for which nothing is fabricated.
 */
export function retainedPlayerReferences(sqlite) {
  const out = {};
  const players = tableExists(sqlite, 'players');
  for (const { name, table, column } of PLAYER_REFERENCE_TABLES) {
    if (!tableExists(sqlite, table) || !players) { out[name] = 0; continue; }
    out[name] = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} IN (SELECT id FROM players WHERE deleted_at IS NOT NULL)`).get().n;
  }
  return out;
}
/** The two Domain P counts of a validated row set against a set of player ids: ids that resolve to nothing; rows with no usable (string) id. */
function playerReferenceCounts(name, rows, players) {
  const key = DOMAINS[name].playerKey; if (!key) return {};
  let unresolvedPlayerIds = 0; let withoutPlayerId = 0;
  for (const r of rows) { const v = r[key]; if (typeof v !== 'string') withoutPlayerId += 1; else if (!players.has(v)) unresolvedPlayerIds += 1; }
  return { unresolvedPlayerIds, withoutPlayerId };
}

/**
 * Whole-table access for the tools that treat the file as one snapshot (backups,
 * restores, the persistence suites), one entry per collection in dispatch order. Before
 * the cutover record both methods decline (`null` / `false`): the caller keeps the legacy
 * blob. Afterwards `read` returns the rows in the legacy shape, in insertion order;
 * `replace` validates every entry, checks an incoming IDV queue against the guardians
 * table as it stands (the identity pair is dispatched first), rewrites the table inside
 * the caller's transaction and refuses the whole write on the first problem. The caller
 * then runs `assertIdvQueueGuardiansConsistent` on the FINAL state.
 */
export const AUDIT_SNAPSHOT_TABLES = Object.freeze(AUDIT_COLLECTIONS.map((name) => Object.freeze({
  name,
  table: DOMAINS[name].table,
  read(sqlite) { if (!safetyAuditLive(sqlite)) return null; return readRows(sqlite, name); },
  replace(sqlite, rows) {
    if (!safetyAuditLive(sqlite)) return false;
    if (!sqlite.isTransaction) throw new Error(`${name}: replace() runs inside the caller's transaction`);
    const v = validateAuditRows(name, rows, { label: `the ${name} snapshot collection` });
    if (DOMAINS[name].guardianKey) checkIncomingGuardians(sqlite, v.rows, { label: `the ${name} snapshot collection` });
    writeRows(sqlite, name, v.rows);
    return true;
  },
})));

/**
 * Import the eight legacy (or exported) blobs into the tables, inside the migration's
 * transaction: validation of every entry, the strict guardian check for the IDV queue,
 * insertion in array order, the blob rows retired, the Domain P counts taken against the
 * players table. An absent blob imports nothing; an empty array imports nothing; a
 * non-array or non-JSON blob refuses the step. Returns the counts the migration records
 * in `meta` (never a value).
 */
export function importSafetyAuditBlobs(sqlite) {
  const hasCollections = tableExists(sqlite, 'collections');
  const players = existingIds(sqlite, 'players');
  const counts = {};
  for (const name of AUDIT_COLLECTIONS) {
    const row = hasCollections ? sqlite.prepare('SELECT value FROM collections WHERE name = ?').get(name) : null;
    if (!row) { counts[name] = { imported: 0, withExtraFields: 0, withAbsentKeys: 0, withOfftypeValues: 0, ...playerReferenceCounts(name, [], players) }; continue; }
    let parsed; try { parsed = JSON.parse(row.value); } catch { throw blocked(`the ${name} blob is not valid JSON`); }
    const v = validateAuditRows(name, parsed, { label: `the ${name} blob` });
    if (DOMAINS[name].guardianKey) checkIncomingGuardians(sqlite, v.rows, { label: `the ${name} blob` });
    writeRows(sqlite, name, v.rows);
    sqlite.prepare('DELETE FROM collections WHERE name = ?').run(name);
    counts[name] = { ...v.counts, ...playerReferenceCounts(name, v.rows, players) };
  }
  return counts;
}

// ------------------------------------------------------------------ detached copies (the export)
const copyRow = (row) => { const c = {}; for (const k of Object.keys(row)) setOwn(c, k, clone(row[k], k).value); return c; };

// ------------------------------------------------------------------ the repository
/**
 * `unit` is the store's participant API ({ active(), join(work) }) or null (a tool, a
 * test, the migration). `staged` selects the server's write mode (see the header); it
 * needs `unit`, and the store must register `saveHook()` — with `unit` given, no
 * operation joins a unit until `saveHook()` was taken.
 */
export function createSafetyAuditRepository({ sqlite, now = Date.now, log = () => {}, unit = null, staged = false } = {}) {
  if (!sqlite) throw new TypeError('the safety-audit repository needs a SQLite connection (node:sqlite); the audit tables have no in-memory or JSON fallback');
  if (unit !== null && (typeof unit?.active !== 'function' || typeof unit?.join !== 'function')) throw new TypeError('the safety-audit repository needs the store\'s participant API `unit` ({ active(), join(work) }) or null; a unit without join() could not report an operation\'s failure to the unit of work');
  if (staged && !unit) throw new TypeError('the safety-audit repository in staged mode needs the store\'s participant API `unit` and the store must register its saveHook()');
  void now;
  const stmt = {
    cutover: sqlite.prepare('SELECT 1 FROM data_migrations WHERE id = ?'),
    guardian: sqlite.prepare('SELECT 1 FROM guardians WHERE id = ?'),
    insert: Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, sqlite.prepare(INSERT[n])])),
    update: Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, sqlite.prepare(UPDATE[n])])),
    remove: Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, sqlite.prepare(DELETE_BY_ID[n])])),
  };

  // The mirrors: every row of every collection, in insertion order.
  const rows = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, []]));
  const byId = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, new Map()]));
  const views = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, readonlyView(rows[n], `an audit record (${n})`)]));
  const index = (n) => { byId[n].clear(); for (const r of rows[n]) byId[n].set(r.id, r); };
  const load = () => { for (const n of AUDIT_COLLECTIONS) { rows[n].length = 0; if (safetyAuditLive(sqlite)) for (const r of readRows(sqlite, n)) rows[n].push(r); index(n); } };
  load();

  // Staged mode: the SQL queue, FIFO, drained whole inside every save transaction.
  const pending = []; let inFlight = 0;
  let hookTaken = false;
  const inUnit = () => !!unit?.active?.();
  const hookRefusal = (what) => new Error(`safetyAudit: ${what} needs the repository's save hook registered with the store first (store.setSaveHook(repo.saveHook())): the hook is how a save writes the queued statements and how a unit of work's rollback restores this repository's memory`);
  /** The one boundary of every mutation (repositories/channels.mjs `operation`: identical contract). */
  const operation = (fn) => {
    if (inUnit()) {
      return unit.join(() => {
        if (!hookTaken) throw hookRefusal(staged ? 'a staged write inside a unit of work' : 'joining a unit of work');
        return staged ? fn((op) => { pending.push(op); }) : fn((op) => op());
      });
    }
    if (staged) {
      if (!hookTaken) throw hookRefusal('a staged write');
      if (sqlite.isTransaction) throw new Error('safetyAudit: the staged repository cannot take part in a transaction it did not open (the server\'s transactions are units of work or snapshot saves)');
      return fn((op) => { pending.push(op); });
    }
    const body = () => fn((op) => op());
    if (sqlite.isTransaction) return body(); // caller-owned: see reload()
    const state = repo.snapshotState();
    try { return transaction(sqlite, body); } catch (err) { repo.restoreState(state); throw err; }
  };
  const label = (n) => `an audit record (${n})`;

  /** The append shared by every collection: validated exactly like an import; the IDV queue's guardian checked strictly. */
  const append = (n, raw) => operation((exec) => {
    const v = validateAuditEntry(n, raw, n); if (!v.ok) throw new TypeError(`${n}: an entry needs the writer's literal: ${v.reason}`);
    const row = v.row;
    if (byId[n].has(row.id)) throw new Error(`${n}: a row with id ${row.id} already exists`);
    if (DOMAINS[n].guardianKey && !stmt.guardian.get(row.guardianId)) throw refusal('IDV_GUARDIAN_MISSING', `${n}: guardian ${row.guardianId} does not exist; an IDV entry names an existing guardian`);
    rows[n].push(row); byId[n].set(row.id, row);
    const p = params(n, row);
    exec(() => { stmt.insert[n].run(p); });
    return readonlyView(row, label(n));
  });
  /**
   * Change exactly `allowed` keys of a row by id (the routes' status updates); the values become present keys.
   * ATOMIC (review of c6cf5e1, F1): every field is validated and cloned, and the UPDATE parameters computed from a
   * candidate copy, BEFORE anything is published — a refusal at any field leaves the row (and so every held or fresh
   * view), the queue and the file untouched. Only then are the values assigned to the live row (its identity, and so
   * every held view, is kept) and the statement queued.
   */
  const patch = (n, id, fields, allowed) => operation((exec) => {
    const row = byId[n].get(id); if (!row) throw new Error(`${n}: no ${n === 'reports' ? 'report' : 'entry'} ${id}`);
    if (!isPlainObject(fields)) throw new TypeError(`${n}: patch takes an object of fields`);
    const keys = Object.keys(fields);
    if (!keys.length || keys.some((k) => !allowed.includes(k))) throw new TypeError(`${n}: patch changes ${allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(', ')} and ${allowed.at(-1)}`} only`);
    const prepared = [];
    for (const k of keys) { const c = clone(fields[k], `${n}.${k}`); if (c.reason) throw new TypeError(`${n}: ${c.reason}`); prepared.push([k, c.value]); }
    const candidate = {}; for (const k of Object.keys(row)) setOwn(candidate, k, row[k]); for (const [k, v] of prepared) candidate[k] = v;
    const p = params(n, candidate);
    for (const [k, v] of prepared) row[k] = v;
    exec(() => { stmt.update[n].run(p); });
    return readonlyView(row, label(n));
  });
  /** Delete one row by id; returns a detached copy of what was removed, or null. */
  const remove = (n, id) => operation((exec) => {
    const i = rows[n].findIndex((r) => r.id === id); if (i < 0) return null;
    const [removed] = rows[n].splice(i, 1); byId[n].delete(id);
    exec(() => { stmt.remove[n].run(id); });
    return copyRow(removed);
  });
  const byIdView = (n, id) => { const r = byId[n].get(id); return r ? readonlyView(r, label(n)) : null; };
  const collection = (n) => ({
    view: views[n],
    count: () => rows[n].length,
    byId: (id) => byIdView(n, id),
    append: (raw) => append(n, raw),
    exportRows: () => rows[n].map(copyRow),
  });

  const repo = {
    /** Boot: refuse to run without the cutover record; (re)load the mirrors; report counts (never a value). */
    attach() {
      if (!stmt.cutover.get(SAFETY_AUDIT_MIGRATION)) throw new Error(`safetyAudit: the cutover record ${SAFETY_AUDIT_MIGRATION} is missing from data_migrations; the tables cannot be trusted as the source of truth`);
      load();
      const c = repo.counts();
      log(`safety audit: ${AUDIT_COLLECTIONS.map((n) => `${c[n]} ${n}`).join(', ')} loaded from the tables`);
      return { engine: 'sqlite', ...c };
    },
    /** Re-read the mirrors from the tables (a tool that rolled back a raw transaction of its own must call this). */
    reload() { load(); return repo.counts(); },
    counts: () => Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, rows[n].length])),
    /** Staged writes not yet in a committed save (0 in immediate mode). */
    pending: () => pending.length,
    /** Domain P, the diagnostic: per collection, rows whose player id (a string) is not in the players table. Never a refusal. */
    unresolvedPlayerReferences: () => unresolvedPlayerReferences(sqlite),
    /** Every collection in its legacy shape (extras first, then the literal's keys in the writer's order), detached (the admin backup). */
    exportAll: () => Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, rows[n].map(copyRow)])),
    views,

    blocks: { ...collection('blocks'), /** Q5: lifting a block deletes its row, as the route always did. Returns the lifted row (detached) or null. */ remove: (id) => remove('blocks', id) },
    reports: { ...collection('reports'), /** The resolve route's three fields, by row id. */ patch: (id, fields) => patch('reports', id, fields, ['status', 'outcome', 'resolvedAt']) },
    moderationLog: collection('moderationLog'),
    orgNotes: collection('orgNotes'),
    ledger: collection('ledger'),
    opsEvents: collection('opsEvents'),
    sourceChanges: { ...collection('sourceChanges'), /** m181's cap: delete the OLDEST rows beyond `cap` (insertion order). Returns the number removed. */ trimTo: (cap) => operation((exec) => {
      if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError('sourceChanges: trimTo needs a non-negative integer cap');
      const excess = rows.sourceChanges.length - cap; if (excess <= 0) return 0;
      const removed = rows.sourceChanges.splice(0, excess); for (const r of removed) byId.sourceChanges.delete(r.id);
      const removedIds = removed.map((r) => r.id);
      exec(() => { for (const id of removedIds) stmt.remove.sourceChanges.run(id); });
      return removed.length;
    }) },
    idvQueue: { ...collection('idvQueue'), /** The admin toggle's rule: the FIRST entry of the guardian in insertion order (read-only), or null. */ firstForGuardian: (guardianId) => { const r = rows.idvQueue.find((q) => q.guardianId === guardianId); return r ? readonlyView(r, label('idvQueue')) : null; }, /** The admin toggle: status only, by row id. */ patch: (id, fields) => patch('idvQueue', id, fields, ['status']) },

    // ---------------------------------------------------------- the save hook (staged mode)
    flush() {
      if (!sqlite.isTransaction) throw new Error('safetyAudit.flush runs inside a save transaction; the store reports its commit or rollback afterwards');
      for (const op of pending) op();
      inFlight = pending.length;
      return inFlight;
    },
    commit() { pending.splice(0, inFlight); inFlight = 0; },
    rollback() { inFlight = 0; },
    /**
     * Unit-of-work participation: the graph memento of every mirror (each row, its
     * nested context/detail/flags and unknown fields — by identity, restored IN PLACE so
     * every held view reads the pre-unit state) and the queue length when the unit began.
     */
    snapshotState: () => ({ pendingLength: pending.length, graph: captureGraph(AUDIT_COLLECTIONS.map((n) => rows[n])) }),
    restoreState(state) {
      if (!state) return;
      pending.length = state.pendingLength; inFlight = 0;
      restoreGraph(state.graph);
      for (const n of AUDIT_COLLECTIONS) index(n);
    },
    /** What the store registers (staged mode; and immediate mode with a `unit`, before any operation may join one). Taking it is the registration this repository can see. */
    saveHook: () => { hookTaken = true; return { flush: () => repo.flush(), commit: () => repo.commit(), rollback: () => repo.rollback(), snapshotState: () => repo.snapshotState(), restoreState: (s) => repo.restoreState(s) }; },
  };
  return repo;
}
