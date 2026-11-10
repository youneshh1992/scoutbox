/**
 * Safety and audit: blocks, reports, the moderation log, club notes, the Discovery Ledger, ops events, source changes
 * and the ID-check queue.
 *
 * Records (the keys every reader sees):
 *   blocks          { id, playerId, orgId, by, reason, ts }: a player or guardian blocking an organisation, or an
 *                   urgent report's suspension. Lifting a block deletes it (Q5).
 *   reports         { id, ts, by, byId, byOrgId, targetKind, targetOrgId, targetScoutName, targetPlayerId, reason,
 *                     urgent, status, outcome, resolvedAt }: one-click reports and moderation's automatic escalations.
 *   moderationLog   { id, ts, context, flags, severity, excerpt }: every text moderation blocked. `context` is
 *                   `{ kind, playerId?, orgId?, userId?, channelId?, requestId?, trialId? }`; the flags are ordered rows.
 *   orgNotes        { id, orgId, playerId, userId, scoutName, text, ts }: a club's private notes on a player.
 *   ledger          { id, ts, type, playerId, orgId, orgName, userId, scoutName, detail }: the Discovery Ledger, append
 *                   only. `detail` is typed columns by type (LEDGER_DETAIL), null when the type has none.
 *   opsEvents       { id, at, kind, detail }: operational events; `detail` is typed columns by kind (OPS_DETAIL).
 *   sourceChanges   { id, playerId, type, sourceSystem, sourceId, occurredAt, detail }: the canonical change log,
 *                   capped at the newest SOURCE_CHANGE_CAP rows.
 *   idvQueue        { id, guardianId, guardianName, documentType, documentRef, provider, reference, ts, status }.
 *
 * Each write joins the open unit of work, the caller's transaction or its own. Records are deep-frozen; lists that
 * grow without limit page by `seq`, newest first.
 *
 * References. Organisations and staff are RESTRICT keys. Player ids carry no key and no existence rule (Q4 in
 * docs/decisions.md: a row outlives the account; an unresolved id is counted, never refused). The ID-check queue's
 * guardian is checked in code on every write (Q4b), without a key.
 *
 * Refusals name tables, ids and fields, never a reason, note, excerpt, name or document value.
 */
import { isPlainObject, describe, ids } from './recruitment.mjs';
import { transaction, migrationApplied, childRowsOf } from './database.mjs';
import { deepFreeze } from '../domains/platform/values.mjs';
import { text, int, bool, oneOf, columnDdl, bad, typeSpec, typeScalar, encode, decode, flat, quote } from './fieldSpecs.mjs';
import { pageOf } from '../domains/platform/paging.mjs';
import { MODERATION_FLAGS, MODERATION_SEVERITIES } from '../domain.mjs';

export const SAFETY_AUDIT_MIGRATION = '0013_safety_audit';
export const AUDIT_COLLECTIONS = Object.freeze(['blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue']);

// ------------------------------------------------------------------ vocabularies and limits (one definition)
export const BLOCK_BY = Object.freeze(['player', 'guardian']);
export const REPORT_BY = Object.freeze(['player', 'guardian', 'org_user', 'system']);
export const REPORT_TARGETS = Object.freeze(['club', 'scout', 'player']);
export const REPORT_STATUSES = Object.freeze(['pending_review', 'resolved']);
export const IDV_STATUSES = Object.freeze(['approved', 'revoked']);
export const SOURCE_SYSTEMS = Object.freeze(['passport_prefs', 'position_history']);
export const SOURCE_CHANGE_CAP = 20_000;
const REQUEST_LEDGER = ['contact', 'trial'].flatMap((t) => [`${t}_request`, `${t}_request_to_guardian`, `${t}_accepted`, `${t}_accepted_by_guardian`, `${t}_declined`, `${t}_declined_by_guardian`]);
export const LEDGER_TYPES = Object.freeze([
  'view', 'save', 'shortlist', ...REQUEST_LEDGER, 'message', 'signing', 'released_by_club', 'staff_removed',
  'org_blocked_by_player', 'org_blocked_by_guardian', 'account_transitioned', 'assessment_submitted', 'attendance_verified',
  'clip_tagged', 'coach_affiliation_confirmed', 'level_review', 'matchday_logged', 'open_trial_posted', 'open_trial_registration',
  'open_trial_registration_by_guardian', 'opportunity_application', 'passport_view', 'passport_recruitment_view',
  'passport_share_created', 'passport_share_revoked', 'recruitment_room_created', 'transition_pack_view', 'trial_checkin',
  'trial_report', 'box_assignment_created', 'box_assignment_cancelled', 'box_challenge_published', 'box_clip_saved',
  'box_prefs_changed', 'box_result_invalidated', 'box_result_restored', 'combine_attempt_completed', 'combine_request_created',
  'combine_request_completed', 'verification_decision', 'verification_root_approved',
]);
export const OPS_KINDS = Object.freeze(['staff_bootstrapped', 'audit_export', 'backup_created', 'backup_refused', 'backup_failed', 'delivery_failed', 'webhook_failed']);
export const AUDIT_LIMITS = Object.freeze({ id: 80, name: 200, reason: 2000, note: 2000, outcome: 2000, excerpt: 140, contextKind: 60, detailText: 300, documentType: 60, documentRef: 20, provider: 60, reference: 200, position: 40, protocols: 50 });
const L = AUDIT_LIMITS;

// ------------------------------------------------------------------ field specs
const req = { req: true };
const idf = (k, c, o = {}) => text(k, c, L.id, { nonEmpty: true, ...o });
const name = (k, c, o = {}) => text(k, c, L.name, o);

const BLOCK_SPEC = [idf('id', 'id', req), idf('playerId', 'player_id', req), idf('orgId', 'org_id', req), oneOf('by', 'by_kind', BLOCK_BY, req), text('reason', 'reason', L.reason, req), int('ts', 'created_at', req)];
const REPORT_SPEC = [
  idf('id', 'id', req), int('ts', 'created_at', req), oneOf('by', 'by_kind', REPORT_BY, req), idf('byId', 'by_id', req), idf('byOrgId', 'by_org_id'),
  oneOf('targetKind', 'target_kind', REPORT_TARGETS, req), idf('targetOrgId', 'target_org_id'), name('targetScoutName', 'target_scout_name', { nonEmpty: true }),
  name('targetPlayerId', 'target_player_id', { nonEmpty: true }), text('reason', 'reason', L.reason, { req: true, nonEmpty: true }), bool('urgent', 'urgent', req),
  oneOf('status', 'status', REPORT_STATUSES, req), text('outcome', 'outcome', L.outcome, { nonEmpty: true }), int('resolvedAt', 'resolved_at'),
];
const CONTEXT_SPEC = [
  text('kind', 'context_kind', L.contextKind, { req: true, nonEmpty: true }), idf('playerId', 'context_player_id'), idf('orgId', 'context_org_id'),
  idf('userId', 'context_user_id'), idf('channelId', 'context_channel_id'), idf('requestId', 'context_request_id'), idf('trialId', 'context_trial_id'),
];
const MODERATION_SPEC = [idf('id', 'id', req), int('ts', 'created_at', req), { k: 'context', group: CONTEXT_SPEC, sparse: true }, oneOf('severity', 'severity', MODERATION_SEVERITIES, req), text('excerpt', 'excerpt', L.excerpt, req)];
const NOTE_SPEC = [idf('id', 'id', req), idf('orgId', 'org_id', req), idf('playerId', 'player_id', req), idf('userId', 'user_id', req), name('scoutName', 'scout_name', req), text('text', 'text', L.note, { req: true, nonEmpty: true }), int('ts', 'created_at', req)];
const LEDGER_BASE = [idf('id', 'id', req), int('ts', 'occurred_at', req), oneOf('type', 'type', LEDGER_TYPES, req), idf('playerId', 'player_id'), idf('orgId', 'org_id'), name('orgName', 'org_name'), idf('userId', 'user_id'), name('scoutName', 'actor_name')];
const OPS_BASE = [idf('id', 'id', req), int('at', 'occurred_at', req), oneOf('kind', 'kind', OPS_KINDS, req)];
const SOURCE_BASE = [idf('id', 'id', req), idf('playerId', 'player_id', req), oneOf('type', 'type', ['position_changed'], req), oneOf('sourceSystem', 'source_system', SOURCE_SYSTEMS, req), name('sourceId', 'source_id', { nonEmpty: true }), int('occurredAt', 'occurred_at', req)];
const IDV_SPEC = [
  idf('id', 'id', req), idf('guardianId', 'guardian_id', req), name('guardianName', 'guardian_name'), text('documentType', 'document_type', L.documentType, { req: true, nonEmpty: true }),
  text('documentRef', 'document_ref_last4', L.documentRef, req), text('provider', 'provider', L.provider, { req: true, nonEmpty: true }),
  text('reference', 'reference', L.reference, { req: true, nonEmpty: true }), int('ts', 'created_at', req), oneOf('status', 'status', IDV_STATUSES, req),
];

/**
 * A polymorphic detail as typed columns: `fields` are the possible keys (a field spec each; `target` is the pair
 * targetType/targetValue, and `protocols` the one list, stored as child rows); `byType` names the keys each type may
 * carry. A detail key the type does not carry is refused; a column holds a value only for the types that carry its
 * key (a CHECK each). Decoded, a detail keeps its non-null keys, and is null when it has none.
 */
const D = (k, c, t, o = {}) => ({ k, c: `detail_${c}`, t, ...o });
const did = (k, c) => D(k, c, 'text', { max: L.id, nonEmpty: true });
const dtext = (k, c, max = L.detailText) => D(k, c, 'text', { max });
const LEDGER_DETAIL_FIELDS = [
  did('assignmentId', 'assignment_id'), did('drillId', 'drill_id'), dtext('targetType', 'target_type', 40), D('targetValue', 'target_value', 'num'),
  did('challengeId', 'challenge_id'), did('sessionId', 'session_id'), did('mediaId', 'media_id'), dtext('by', 'by', 40), dtext('share', 'share', 40),
  D('retainClips', 'retain_clips', 'bool'), did('disputeId', 'dispute_id'), dtext('outcome', 'outcome', 40), dtext('reason', 'reason'),
  did('attemptId', 'attempt_id'), dtext('protocol', 'protocol', 120), dtext('state', 'state', 40), did('requestId', 'request_id'),
  dtext('from', 'from_value', 40), dtext('to', 'to_value', 40), did('trialId', 'trial_id'), dtext('via', 'via', 40), dtext('mode', 'mode', 40),
  did('shareId', 'share_id'), did('claimId', 'claim_id'), dtext('action', 'action', 40), did('request', 'root_request_id'),
];
/** Ledger detail keys by type. `target` is `{ type, value }` (the targetType/targetValue columns); `protocols` a list. */
export const LEDGER_DETAIL = Object.freeze({
  box_assignment_cancelled: ['assignmentId'],
  box_assignment_created: ['drillId', 'target'],
  box_challenge_published: ['challengeId', 'drillId'],
  box_clip_saved: ['sessionId', 'mediaId'],
  box_prefs_changed: ['by', 'share', 'retainClips'],
  box_result_invalidated: ['sessionId', 'disputeId', 'outcome'],
  box_result_restored: ['sessionId', 'reason'],
  combine_attempt_completed: ['attemptId', 'protocol', 'state'],
  combine_request_completed: ['requestId'],
  combine_request_created: ['requestId', 'protocols'],
  level_review: ['from', 'to', 'reason'],
  open_trial_posted: ['trialId'],
  passport_recruitment_view: ['via'],
  passport_share_created: ['mode', 'shareId'],
  passport_share_revoked: ['shareId', 'by'],
  verification_decision: ['claimId', 'action'],
  verification_root_approved: ['request'],
});
const OPS_DETAIL_FIELDS = [
  did('orgId', 'org_id'), did('userId', 'user_id'), dtext('by', 'by', L.name), dtext('dir', 'dir', 200), D('files', 'files', 'int'),
  D('queuedForRemoval', 'queued_for_removal', 'int'), dtext('error', 'error'), D('conflictCount', 'conflict_count', 'int'),
  did('dispatchId', 'dispatch_id'), dtext('channel', 'channel', 40), did('deliveryId', 'delivery_id'), did('endpointId', 'endpoint_id'),
];
export const OPS_DETAIL = Object.freeze({
  staff_bootstrapped: ['orgId', 'userId', 'by'],
  audit_export: ['orgId', 'by'],
  backup_created: ['dir', 'files', 'queuedForRemoval'],
  backup_refused: ['dir', 'error', 'conflictCount'],
  backup_failed: ['dir', 'error'],
  delivery_failed: ['dispatchId', 'channel'],
  webhook_failed: ['deliveryId', 'endpointId'],
});
const SOURCE_DETAIL_FIELDS = [dtext('from', 'position_from', L.position), dtext('to', 'position_to', L.position), dtext('submittedBy', 'submitted_by', 40)];
const SOURCE_DETAIL = Object.freeze({ position_changed: ['from', 'to', 'submittedBy'] });

function detailCodec(fields, byType, typeColumn) {
  const byKey = new Map(fields.map((f) => [f.k, f]));
  const keysOf = (type) => byType[type] ?? [];
  /** Type `detail` for `type` into `{ ok, cols, protocols }`. */
  const type = (t, detail, at) => {
    const cols = Object.fromEntries(fields.map((f) => [f.c, null]));
    let protocols = [];
    if (detail === undefined || detail === null) return { ok: true, cols, protocols };
    if (!isPlainObject(detail)) return bad(at, 'detail', `must be an object or null (got ${describe(detail)})`);
    const allowed = keysOf(t);
    for (const [k, v] of Object.entries(detail)) {
      if (v === undefined) continue;
      if (!allowed.includes(k)) return bad(at, `detail.${k}`, `is not part of a ${t} detail`);
      if (k === 'target') {
        if (v === null) continue;
        if (!isPlainObject(v) || Object.keys(v).some((x) => x !== 'type' && x !== 'value')) return bad(at, 'detail.target', 'must be { type, value }');
        for (const [kk, f] of [['type', byKey.get('targetType')], ['value', byKey.get('targetValue')]]) { const r = typeScalar({ ...f, req: true }, v[kk], `${at}.detail.target`); if (!r.ok) return r; cols[f.c] = r.value; }
        continue;
      }
      if (k === 'protocols') {
        if (v === null) continue;
        if (!Array.isArray(v) || v.length > L.protocols || v.some((p) => typeof p !== 'string' || !p.length || p.length > 120)) return bad(at, 'detail.protocols', 'must be a list of protocol ids');
        protocols = [...v];
        continue;
      }
      const f = byKey.get(k);
      const r = typeScalar(f, v, `${at}.detail`); if (!r.ok) return r;
      cols[f.c] = f.t === 'bool' && r.value !== null ? (r.value ? 1 : 0) : r.value;
    }
    return { ok: true, cols, protocols };
  };
  const decodeDetail = (t, row, protocols = []) => {
    const out = {};
    for (const k of keysOf(t)) {
      if (k === 'target') { if (row.detail_target_type !== null && row.detail_target_type !== undefined) out.target = { type: row.detail_target_type, value: row.detail_target_value }; continue; }
      if (k === 'protocols') { if (protocols.length) out.protocols = protocols; continue; }
      const f = byKey.get(k); const v = row[f.c];
      if (v !== null && v !== undefined) out[k] = f.t === 'bool' ? v === 1 : v;
    }
    return Object.keys(out).length ? out : null;
  };
  /** The column definitions, each with its CHECK limiting it to the types that carry its key. */
  const ddl = () => fields.map((f) => {
    const key = f.k === 'targetType' || f.k === 'targetValue' ? 'target' : f.k;
    const types = Object.keys(byType).filter((t) => byType[t].includes(key));
    return `${f.c.padEnd(32)} ${columnDdl(f)} CHECK (${f.c} IS NULL OR ${typeColumn} IN (${types.map(quote).join(', ')}))`;
  });
  return { type, decode: decodeDetail, ddl, columns: fields.map((f) => f.c) };
}
const LEDGER_CODEC = detailCodec(LEDGER_DETAIL_FIELDS, LEDGER_DETAIL, 'type');
const OPS_CODEC = detailCodec(OPS_DETAIL_FIELDS, OPS_DETAIL, 'kind');
const SOURCE_CODEC = detailCodec(SOURCE_DETAIL_FIELDS, SOURCE_DETAIL, 'type');

// ------------------------------------------------------------------ DDL
const rowOf = (tbl, c) => `FOREIGN KEY (${c}) REFERENCES ${tbl}(id) ON DELETE RESTRICT`;
const ownedBy = (tbl, c) => `FOREIGN KEY (${c}) REFERENCES ${tbl}(id) ON DELETE CASCADE`;
const specCols = (spec) => flat(spec).filter((f) => f.c !== 'id').map((f) => `${f.c.padEnd(32)} ${columnDdl(f)}`);
const table = (tbl, cols, extra = []) => `CREATE TABLE ${tbl} (\n  ${['seq                              INTEGER PRIMARY KEY', `id                               TEXT NOT NULL UNIQUE CHECK (length(id) > 0 AND length(id) <= ${L.id})`, ...cols, ...extra].join(',\n  ')}\n) STRICT;`;
const childTable = (tbl, parent, parentCol, valueCol, check) => `CREATE TABLE ${tbl} (\n  ${parentCol} TEXT NOT NULL,\n  ord INTEGER NOT NULL CHECK (ord >= 0),\n  ${valueCol} TEXT NOT NULL CHECK (${check}),\n  PRIMARY KEY (${parentCol}, ord),\n  ${ownedBy(parent, parentCol)}\n) STRICT;`;

export const SAFETY_AUDIT_DDL = [
  table('blocks', specCols(BLOCK_SPEC), [rowOf('orgs', 'org_id')]),
  'CREATE INDEX blocks_player_id_org_id ON blocks (player_id, org_id);',
  'CREATE INDEX blocks_org_id ON blocks (org_id);',
  table('reports', specCols(REPORT_SPEC), [
    rowOf('orgs', 'by_org_id'), rowOf('orgs', 'target_org_id'),
    "CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))", "CHECK (status = 'resolved' OR outcome IS NULL)",
    "CHECK ((by_kind = 'org_user') = (by_org_id IS NOT NULL))",
  ]),
  'CREATE INDEX reports_by_kind_by_id ON reports (by_kind, by_id);',
  'CREATE INDEX reports_target_org_id_urgent_status ON reports (target_org_id, urgent, status);',
  'CREATE INDEX reports_status_created_at ON reports (status, created_at);',
  'CREATE INDEX reports_target_player_id ON reports (target_player_id);',
  table('moderation_log', specCols(MODERATION_SPEC), [rowOf('orgs', 'context_org_id'), rowOf('org_users', 'context_user_id')]),
  'CREATE INDEX moderation_log_severity ON moderation_log (severity);',
  childTable('moderation_flags', 'moderation_log', 'moderation_id', 'flag', `flag IN (${MODERATION_FLAGS.map(quote).join(', ')})`),
  table('org_notes', specCols(NOTE_SPEC), [rowOf('orgs', 'org_id'), rowOf('org_users', 'user_id')]),
  'CREATE INDEX org_notes_org_id_player_id ON org_notes (org_id, player_id);',
  table('ledger', [...specCols(LEDGER_BASE), ...LEDGER_CODEC.ddl()], [rowOf('orgs', 'org_id'), rowOf('org_users', 'user_id')]),
  'CREATE INDEX ledger_player_id_type ON ledger (player_id, type);',
  'CREATE INDEX ledger_player_id_org_id ON ledger (player_id, org_id);',
  'CREATE INDEX ledger_org_id_type ON ledger (org_id, type);',
  'CREATE INDEX ledger_actor ON ledger (actor_name, org_name, type);',
  childTable('ledger_protocols', 'ledger', 'ledger_id', 'protocol', 'length(protocol) > 0 AND length(protocol) <= 120'),
  table('ops_events', [...specCols(OPS_BASE), ...OPS_CODEC.ddl()], [rowOf('orgs', 'detail_org_id'), rowOf('org_users', 'detail_user_id')]),
  'CREATE INDEX ops_events_kind ON ops_events (kind);',
  table('source_changes', [...specCols(SOURCE_BASE), ...SOURCE_CODEC.ddl()]),
  'CREATE INDEX source_changes_player_id_occurred_at ON source_changes (player_id, occurred_at);',
  table('idv_queue', specCols(IDV_SPEC)),
  'CREATE INDEX idv_queue_guardian_id ON idv_queue (guardian_id);',
].join('\n');
export const AUDIT_TABLE_NAMES = Object.freeze(['blocks', 'reports', 'moderation_log', 'moderation_flags', 'org_notes', 'ledger', 'ledger_protocols', 'ops_events', 'source_changes', 'idv_queue']);
const TABLE_OF = Object.freeze({ blocks: 'blocks', reports: 'reports', moderationLog: 'moderation_log', orgNotes: 'org_notes', ledger: 'ledger', opsEvents: 'ops_events', sourceChanges: 'source_changes', idvQueue: 'idv_queue' });
/** The five tolerant player references (Q4), by collection → the table and column. */
export const PLAYER_REFERENCE_TABLES = Object.freeze([
  { name: 'blocks', table: 'blocks', column: 'player_id' }, { name: 'reports', table: 'reports', column: 'target_player_id' },
  { name: 'orgNotes', table: 'org_notes', column: 'player_id' }, { name: 'ledger', table: 'ledger', column: 'player_id' },
  { name: 'sourceChanges', table: 'source_changes', column: 'player_id' },
]);

// ------------------------------------------------------------------ typing (the one place a value is judged)
export const refusal = (code, message, extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });
const labelOf = (at, raw) => `${at} ${isPlainObject(raw) && typeof raw.id === 'string' ? raw.id : ''}`.trim();
const plainSpec = (spec) => (raw, at) => typeSpec(spec, raw, labelOf(at, raw));
function typeWithDetail(base, codec, typeKey) {
  return (raw, at) => {
    const label = labelOf(at, raw);
    if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
    const { detail, ...rest } = raw;
    const t = typeSpec(base, rest, label); if (!t.ok) return t;
    const d = codec.type(t.record[typeKey], detail, label); if (!d.ok) return d;
    return { ok: true, record: { ...t.record, detail: codec.decode(t.record[typeKey], d.cols, d.protocols) }, cols: d.cols, protocols: d.protocols };
  };
}
function typeModeration(raw, at) {
  const label = labelOf(at, raw);
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object (${describe(raw)})` };
  const { flags, ...rest } = raw;
  const t = typeSpec(MODERATION_SPEC, rest, label); if (!t.ok) return t;
  if (!Array.isArray(flags) || !flags.length || flags.some((f) => !MODERATION_FLAGS.includes(f)) || new Set(flags).size !== flags.length) return bad(label, 'flags', `must be a list of distinct moderation flags (${MODERATION_FLAGS.join('|')})`);
  return { ok: true, record: { ...t.record, flags: [...flags] } };
}
function typeReport(raw, at) {
  const t = plainSpec(REPORT_SPEC)(raw, at); if (!t.ok) return t;
  const r = t.record; const label = labelOf(at, raw);
  if ((r.status === 'resolved') !== (r.resolvedAt !== null)) return bad(label, 'resolvedAt', 'is set exactly when the report is resolved');
  if (r.status !== 'resolved' && r.outcome !== null) return bad(label, 'outcome', 'is set only on a resolved report');
  if ((r.by === 'org_user') !== (r.byOrgId !== null)) return bad(label, 'byOrgId', 'is set exactly when a club user filed the report');
  return t;
}
export const AUDIT_TYPERS = Object.freeze({
  blocks: plainSpec(BLOCK_SPEC),
  reports: typeReport,
  moderationLog: typeModeration,
  orgNotes: plainSpec(NOTE_SPEC),
  ledger: typeWithDetail(LEDGER_BASE, LEDGER_CODEC, 'type'),
  opsEvents: typeWithDetail(OPS_BASE, OPS_CODEC, 'kind'),
  sourceChanges: typeWithDetail(SOURCE_BASE, SOURCE_CODEC, 'type'),
  idvQueue: plainSpec(IDV_SPEC),
});
const BASE_OF = Object.freeze({ blocks: BLOCK_SPEC, reports: REPORT_SPEC, moderationLog: MODERATION_SPEC, orgNotes: NOTE_SPEC, ledger: LEDGER_BASE, opsEvents: OPS_BASE, sourceChanges: SOURCE_BASE, idvQueue: IDV_SPEC });
const CODEC_OF = Object.freeze({ ledger: [LEDGER_CODEC, 'type'], opsEvents: [OPS_CODEC, 'kind'], sourceChanges: [SOURCE_CODEC, 'type'] });

// ------------------------------------------------------------------ rows
const columnsOf = (n) => [...flat(BASE_OF[n]).map((f) => f.c), ...(CODEC_OF[n] ? CODEC_OF[n][0].columns : [])];
const INSERT = Object.fromEntries(AUDIT_COLLECTIONS.map((n) => { const cols = columnsOf(n); return [n, `INSERT INTO ${TABLE_OF[n]} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`]; }));
function writeRecord(sqlite, n, t) {
  sqlite.prepare(INSERT[n]).run({ ...encode(BASE_OF[n], t.record), ...(t.cols ?? {}) });
  if (n === 'moderationLog') t.record.flags.forEach((f, i) => sqlite.prepare('INSERT INTO moderation_flags (moderation_id, ord, flag) VALUES (?, ?, ?)').run(t.record.id, i, f));
  if (n === 'ledger') (t.protocols ?? []).forEach((p, i) => sqlite.prepare('INSERT INTO ledger_protocols (ledger_id, ord, protocol) VALUES (?, ?, ?)').run(t.record.id, i, p));
}
/** Decode rows of one collection (child rows in one batch per list). */
function decodeRows(sqlite, n, rows) {
  if (n === 'moderationLog') {
    const flags = childRowsOf(sqlite, 'moderation_flags', 'moderation_id', rows.map((r) => r.id), { order: 'ord' });
    return rows.map((r) => ({ ...decode(MODERATION_SPEC, r), flags: flags.all(r.id).map((f) => f.flag) }));
  }
  if (CODEC_OF[n]) {
    const [codec, key] = CODEC_OF[n];
    const protocols = n === 'ledger' ? childRowsOf(sqlite, 'ledger_protocols', 'ledger_id', rows.filter((r) => r.type === 'combine_request_created').map((r) => r.id), { order: 'ord' }) : null;
    return rows.map((r) => ({ ...decode(BASE_OF[n], r), detail: codec.decode(r[key], r, protocols ? protocols.all(r.id).map((p) => p.protocol) : []) }));
  }
  return rows.map((r) => decode(BASE_OF[n], r));
}

// ------------------------------------------------------------------ references
const tableExists = (sqlite, t) => !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
export const safetyAuditLive = (sqlite) => migrationApplied(sqlite, SAFETY_AUDIT_MIGRATION);
/** The organisation and staff references of a typed record: [[what, table, id]]. */
function referencesOf(n, r) {
  const out = [];
  const ref = (tbl) => (k, v) => { if (v !== null && v !== undefined) out.push([`${TABLE_OF[n]} ${r.id} ${k}`, tbl, v]); };
  const org = ref('orgs'); const staff = ref('org_users');
  if (n === 'blocks') org('orgId', r.orgId);
  if (n === 'reports') { org('byOrgId', r.byOrgId); org('targetOrgId', r.targetOrgId); }
  if (n === 'moderationLog') { org('context.orgId', r.context.orgId); staff('context.userId', r.context.userId); }
  if (n === 'orgNotes' || n === 'ledger') { org('orgId', r.orgId); staff('userId', r.userId); }
  if (n === 'opsEvents') { org('detail.orgId', r.detail?.orgId); staff('detail.userId', r.detail?.userId); }
  return out;
}
/** Q4, the diagnostic (never a refusal): per collection, rows naming a player id that is not in the players table. */
export function unresolvedPlayerReferences(sqlite) {
  const players = tableExists(sqlite, 'players');
  return Object.fromEntries(PLAYER_REFERENCE_TABLES.map(({ name: n, table: t, column }) => [n, !tableExists(sqlite, t) ? 0
    : sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${column} IS NOT NULL${players ? ` AND ${column} NOT IN (SELECT id FROM players)` : ''}`).get().n]));
}
/** The companion diagnostic: per collection, rows naming a player whose record is retained (an account deleted). */
export function retainedPlayerReferences(sqlite) {
  const players = tableExists(sqlite, 'players');
  return Object.fromEntries(PLAYER_REFERENCE_TABLES.map(({ name: n, table: t, column }) => [n, !tableExists(sqlite, t) || !players ? 0
    : sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${column} IS NOT NULL AND ${column} IN (SELECT id FROM players WHERE deleted_at IS NOT NULL)`).get().n]));
}

// ------------------------------------------------------------------ whole-domain read (the test suites)
function readAll(sqlite) {
  return Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, decodeRows(sqlite, n, sqlite.prepare(`SELECT * FROM ${TABLE_OF[n]} ORDER BY seq`).all())]));
}
/** The whole domain read back as plain records (`readAllRecords` in index.mjs: the test suites' read-back). */
export const SAFETY_AUDIT_RECORDS = {
  names: AUDIT_COLLECTIONS,
  read(sqlite) { return safetyAuditLive(sqlite) ? readAll(sqlite) : null; },
};

// ------------------------------------------------------------------ the repository
const WRITES = new Set(['add', 'lift', 'file', 'resolve', 'record', 'append', 'setStatus']);
const REPORT_RANK = "CASE WHEN status = 'pending_review' AND urgent = 1 THEN 0 WHEN status = 'pending_review' THEN 1 ELSE 2 END";
const REPORT_SORT = "CASE WHEN status = 'pending_review' THEN created_at ELSE -created_at END";

/**
 * `createSafetyAuditRepository({ sqlite, unit, now, log })`: one object per collection with its writes and queries,
 * plus `reads` (the queries alone, for modules that must not write).
 */
export function createSafetyAuditRepository({ sqlite, unit = null, now = Date.now, log = () => {} } = {}) {
  if (!sqlite) throw new TypeError('the safety-audit repository needs a SQLite connection (node:sqlite)');
  const operation = (fn) => (unit?.active?.() ? unit.join(fn) : sqlite.isTransaction ? fn() : transaction(sqlite, fn));
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = sqlite.prepare(sql))); return s; };
  const str = (v) => typeof v === 'string';
  const dec = (n, rows) => decodeRows(sqlite, n, rows).map(deepFreeze);
  const byIdOf = (n) => (id) => (str(id) ? dec(n, q(`SELECT * FROM ${TABLE_OF[n]} WHERE id = ?`).all(id))[0] ?? null : null);
  /** Rows after `after` ([seq]), newest first: `{ items, nextCursor }`. */
  const newestPage = (n, where, args, { after = null, limit }) => {
    const rows = q(`SELECT * FROM ${TABLE_OF[n]} WHERE ${where} AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?`).all(...args, after?.[0] ?? null, after?.[0] ?? null, limit + 1);
    const page = pageOf(rows, limit, (r) => [r.seq]);
    return { items: dec(n, page.items), nextCursor: page.nextCursor };
  };
  /** Type, check the references, insert; returns the stored record. */
  const insert = (n, raw) => {
    const t = AUDIT_TYPERS[n](raw, n);
    if (!t.ok) throw refusal('AUDIT_RECORD_INVALID', t.reason);
    if (q(`SELECT 1 FROM ${TABLE_OF[n]} WHERE id = ?`).get(t.record.id)) throw refusal('AUDIT_DUPLICATE', `${TABLE_OF[n]} ${t.record.id} already exists`);
    for (const [what, tbl, id] of referencesOf(n, t.record)) if (!q(`SELECT 1 FROM ${tbl} WHERE id = ?`).get(id)) throw refusal('AUDIT_REFERENCE_MISSING', `${what} names no ${tbl} row (${id})`);
    if (n === 'idvQueue' && !q('SELECT 1 FROM guardians WHERE id = ?').get(t.record.guardianId)) throw refusal('IDV_GUARDIAN_MISSING', `idv_queue ${t.record.id}: guardian ${t.record.guardianId} does not exist; an IDV entry names an existing guardian`);
    writeRecord(sqlite, n, t);
    return byIdOf(n)(t.record.id);
  };
  const typesArg = (types) => (types ? JSON.stringify(types) : null);

  const blocks = {
    /** A block (a player's or guardian's, or an urgent report's suspension). */
    add: (raw) => operation(() => insert('blocks', raw)),
    /** Q5: lifting a block deletes its row. Returns the lifted record, or null. */
    lift: (id) => operation(() => { const b = byIdOf('blocks')(id); if (!b) return null; q('DELETE FROM blocks WHERE id = ?').run(id); return b; }),
    byId: byIdOf('blocks'),
    /** Has `playerId` (or their guardian, or a suspension) blocked `orgId`? */
    has: (playerId, orgId) => str(playerId) && str(orgId) && !!q('SELECT 1 FROM blocks WHERE player_id = ? AND org_id = ? LIMIT 1').get(playerId, orgId),
    /** A page of every block, newest first (Trust & Safety). */
    page: (page) => newestPage('blocks', '1 = 1', [], page),
    count: () => q('SELECT COUNT(*) AS n FROM blocks').get().n,
  };

  const reports = {
    file: (raw) => operation(() => insert('reports', raw)),
    /** Resolve a pending report once with its `outcome` at `at`. Refuses a report already resolved. */
    resolve: (id, { outcome, at }) => operation(() => {
      const r = byIdOf('reports')(id);
      if (!r) throw refusal('REPORT_NOT_FOUND', `reports ${id} is not a record of the repository`);
      if (r.status !== 'pending_review') throw refusal('ALREADY_RESOLVED', `reports ${id} is already resolved`);
      const t = typeReport({ ...r, status: 'resolved', outcome, resolvedAt: at }, 'reports');
      if (!t.ok) throw refusal('AUDIT_RECORD_INVALID', t.reason);
      q("UPDATE reports SET status = 'resolved', outcome = ?, resolved_at = ? WHERE id = ?").run(t.record.outcome, t.record.resolvedAt, id);
      return byIdOf('reports')(id);
    }),
    byId: byIdOf('reports'),
    /** The reports one reporter filed, newest first. */
    forReporter: (by, byId) => dec('reports', q('SELECT * FROM reports WHERE by_kind = ? AND by_id = ? ORDER BY seq DESC').all(by, byId)),
    /** Is an urgent report against `orgId` still waiting for review (safeguarding certification)? */
    openUrgentAgainst: (orgId) => !!q("SELECT 1 FROM reports WHERE target_org_id = ? AND urgent = 1 AND status = 'pending_review' LIMIT 1").get(orgId),
    countOpen: () => q("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending_review'").get().n,
    /** A page in triage order: urgent pending first, then pending, both oldest first; then resolved, newest first. `after` is [rank, sortKey, seq]. */
    triagePage: ({ after = null, limit }) => {
      const rows = q(`SELECT *, ${REPORT_RANK} AS rank_, ${REPORT_SORT} AS sort_ FROM reports
        WHERE (? IS NULL OR (${REPORT_RANK}, ${REPORT_SORT}, seq) > (?, ?, ?)) ORDER BY rank_, sort_, seq LIMIT ?`).all(after ? 1 : null, after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, limit + 1);
      const page = pageOf(rows, limit, (r) => [r.rank_, r.sort_, r.seq]);
      return { items: dec('reports', page.items), nextCursor: page.nextCursor };
    },
  };

  const moderationLog = {
    record: (raw) => operation(() => insert('moderationLog', raw)),
    byId: byIdOf('moderationLog'),
    page: (page) => newestPage('moderationLog', '1 = 1', [], page),
    count: (severity = null) => q('SELECT COUNT(*) AS n FROM moderation_log WHERE (? IS NULL OR severity = ?)').get(severity, severity).n,
  };

  const orgNotes = {
    add: (raw) => operation(() => insert('orgNotes', raw)),
    byId: byIdOf('orgNotes'),
    /** One club's notes on one player, newest first. */
    forOrgPlayer: (orgId, playerId) => dec('orgNotes', q('SELECT * FROM org_notes WHERE org_id = ? AND player_id = ? ORDER BY seq DESC').all(orgId, playerId)),
  };

  const ledger = {
    append: (raw) => operation(() => insert('ledger', raw)),
    byId: byIdOf('ledger'),
    /** One player's ledger, oldest first; `types` limits it (null: every type). */
    forPlayer: (playerId, types = null) => dec('ledger', q('SELECT * FROM ledger WHERE player_id = ? AND (? IS NULL OR type IN (SELECT value FROM json_each(?))) ORDER BY seq').all(playerId, typesArg(types), typesArg(types))),
    /** One club's events about one player, oldest first (the Proof Pack, the signing's attribution). */
    forPlayerOrg: (playerId, orgId) => dec('ledger', q('SELECT * FROM ledger WHERE player_id = ? AND org_id = ? ORDER BY seq').all(playerId, orgId)),
    /** One club's events, oldest first; `types` limits it (null: every type: the enterprise export). */
    forOrg: (orgId, types = null) => dec('ledger', q('SELECT * FROM ledger WHERE org_id = ? AND (? IS NULL OR type IN (SELECT value FROM json_each(?))) ORDER BY seq').all(orgId, typesArg(types), typesArg(types))),
    /** A page of one club's ledger, newest first. */
    pageForOrg: (orgId, page) => newestPage('ledger', 'org_id = ?', [orgId], page),
    /** A page of these players' ledger, newest first (a guardian's log of their children). */
    pageForPlayers: (playerIds, page) => newestPage('ledger', 'player_id IN (SELECT value FROM json_each(?))', [JSON.stringify(playerIds)], page),
    /** The players a club put on these lists (default: its shortlist), in the order it first did. */
    playersListedBy: (orgId, types = ['shortlist']) => q('SELECT player_id AS id, MIN(seq) AS first FROM ledger WHERE org_id = ? AND type IN (SELECT value FROM json_each(?)) AND player_id IS NOT NULL GROUP BY player_id ORDER BY first').all(orgId, JSON.stringify(types)).map((r) => r.id),
    /** Has the club put this player on these lists (default: its shortlist)? */
    isListedBy: (orgId, playerId, types = ['shortlist']) => !!q('SELECT 1 FROM ledger WHERE org_id = ? AND player_id = ? AND type IN (SELECT value FROM json_each(?)) LIMIT 1').get(orgId, playerId, JSON.stringify(types)),
    countForPlayer: (playerId, type) => q('SELECT COUNT(*) AS n FROM ledger WHERE player_id = ? AND type = ?').get(playerId, type).n,
    /** One club's event counts by type: `{ [type]: n }`. */
    countsForOrg: (orgId) => Object.fromEntries(q('SELECT type, COUNT(*) AS n FROM ledger WHERE org_id = ? GROUP BY type').all(orgId).map((r) => [r.type, r.n])),
    /** One club's busiest actors: `[{ scoutName, events }]`, most events first (ties: who acted first), at most `n`. */
    topActorsForOrg: (orgId, n) => q("SELECT actor_name AS scoutName, COUNT(*) AS events FROM ledger WHERE org_id = ? AND actor_name IS NOT NULL AND actor_name <> '' GROUP BY actor_name ORDER BY events DESC, MIN(seq) LIMIT ?").all(orgId, n).map((r) => ({ scoutName: r.scoutName, events: r.events })),
    /** Every (actor, organisation, type) with its count, in first-seen order (the reputation board). */
    countsByActor: () => q('SELECT actor_name AS scoutName, org_name AS orgName, type, COUNT(*) AS n, MIN(seq) AS first FROM ledger GROUP BY actor_name, org_name, type ORDER BY first').all().map((r) => ({ scoutName: r.scoutName, orgName: r.orgName, type: r.type, n: r.n })),
  };

  const opsEvents = {
    record: (raw) => operation(() => insert('opsEvents', raw)),
    byId: byIdOf('opsEvents'),
    count: (kind = null) => q('SELECT COUNT(*) AS n FROM ops_events WHERE (? IS NULL OR kind = ?)').get(kind, kind).n,
    /** The newest `n`, newest first. */
    newest: (n) => dec('opsEvents', q('SELECT * FROM ops_events ORDER BY seq DESC LIMIT ?').all(n)),
  };

  const sourceChanges = {
    /** Append a change; the log keeps the newest `cap` rows (a change log, not the history of record). */
    record: (raw, { cap = SOURCE_CHANGE_CAP } = {}) => operation(() => {
      const c = insert('sourceChanges', raw);
      q('DELETE FROM source_changes WHERE seq <= (SELECT seq FROM source_changes ORDER BY seq DESC LIMIT 1 OFFSET ?)').run(cap);
      return c;
    }),
    byId: byIdOf('sourceChanges'),
    /** One player's changes, oldest first by when they happened. */
    forPlayer: (playerId) => dec('sourceChanges', q('SELECT * FROM source_changes WHERE player_id = ? ORDER BY occurred_at, seq').all(playerId)),
    count: () => q('SELECT COUNT(*) AS n FROM source_changes').get().n,
  };

  const idvQueue = {
    add: (raw) => operation(() => insert('idvQueue', raw)),
    /** The admin toggle: the status of one entry. */
    setStatus: (id, status) => operation(() => {
      if (!IDV_STATUSES.includes(status)) throw refusal('AUDIT_RECORD_INVALID', `idv_queue ${id}: status must be one of ${IDV_STATUSES.join('|')}`);
      if (q('UPDATE idv_queue SET status = ? WHERE id = ?').run(status, id).changes !== 1) throw refusal('IDV_ENTRY_NOT_FOUND', `idv_queue ${id} is not a record of the repository`);
      return byIdOf('idvQueue')(id);
    }),
    byId: byIdOf('idvQueue'),
    /** The guardian's first entry (the admin toggle's rule), or null. */
    firstForGuardian: (guardianId) => dec('idvQueue', q('SELECT * FROM idv_queue WHERE guardian_id = ? ORDER BY seq LIMIT 1').all(guardianId))[0] ?? null,
    /** Every entry, in the order the checks happened (about one per guardian). */
    all: () => dec('idvQueue', q('SELECT * FROM idv_queue ORDER BY seq').all()),
  };

  const readOnly = (o) => Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => !WRITES.has(k))));
  const parts = { blocks, reports, moderationLog, orgNotes, ledger, opsEvents, sourceChanges, idvQueue };
  const repo = {
    ...parts,
    /** The queries alone, for modules that must not write. */
    reads: Object.freeze(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, readOnly(v)]))),
    attach() {
      if (!safetyAuditLive(sqlite)) throw new Error(`the safety-audit repository needs ${SAFETY_AUDIT_MIGRATION} recorded`);
      const c = repo.counts();
      log(`safety audit: ${AUDIT_COLLECTIONS.map((n) => `${c[n]} ${n}`).join(', ')} in the tables`);
      return { engine: 'sqlite', ...c };
    },
    counts: () => Object.fromEntries(AUDIT_COLLECTIONS.map((n) => [n, q(`SELECT COUNT(*) AS n FROM ${TABLE_OF[n]}`).get().n])),
    pending: () => 0,
    unresolvedPlayerReferences: () => unresolvedPlayerReferences(sqlite),
    /** Every collection's records, detached. */
    exportAll: () => JSON.parse(JSON.stringify(readAll(sqlite))),
    now,
  };
  return repo;
}
