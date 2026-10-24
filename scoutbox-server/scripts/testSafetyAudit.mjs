// S6b — the eight audit collections as tables (repositories/safetyAudit.mjs, migration
// 0013_safety_audit, repositories/safetyAuditRollback.mjs): Candidate A of
// docs/architecture/sqlite-migration-plan.md §D.4 as accepted at 1792fc7, with the
// Founder's three decisions of 19 October 2026 — Q4 (the five historical player
// references are TOLERANT: an unresolved id is counted, never refused, never given a
// fabricated parent, never deleted; no parent-existence rule), Q4b (the idv_queue
// guardian reference is STRICT: a missing guardian refuses the write, the import and
// the final state of every snapshot that touches the queue or the identity pair),
// Q5 (lifting a block deletes its row, as today).
//
// Covered: the migration from the eight legacy blobs (every writer literal, unknown
// own fields at row and nested level, absent versus null, values of a known key that
// are not the column's type — the unchecked `targetPlayerId`, `orgId` and `reason` a
// route stores as it received them — kept losslessly; refusals name positions, ids and
// reasons, never a text); the actual schema (no foreign key on any of the eight
// tables, a unique id per table, insertion order); the repository (append, the block
// removal, the report and IDV status patches, the first-matching IDV entry, the
// source-change cap, the two write modes, joined units, real COMMIT failure, hook
// registration, held views restored in place); the snapshot dispatcher (round trip,
// omission, empty, malformed, tolerant player references under an identity rewrite,
// the strict guardian assertion in every direction, identity-only replacement with
// the queue omitted); the copy-only rollback tool. Temporary databases only; nothing
// touches DATA_DIR. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 1792fc7 tree before the implementation):
// the tests marked [cutover] need the 0013 migration, the repository module and the
// rollback module and FAIL there on concrete assertions (the migration id is absent
// from DATA_MIGRATIONS; the eight tables do not exist; the blobs survive). The tests
// marked [compat] exercise what the accepted representation already does and pass on
// both trees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { cloneJson as outboxCloneJson, validateOutboxRow, validatePushTokenRow, validatePushLogRow } from '../repositories/outboxPush.mjs';
import { NOW, TTL, tempDir, s3File, openRaw, applied, blob, meta, dump } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const MIGRATION = '0013_safety_audit';
const META = 'safetyAuditCutover';
const COLLECTIONS = ['blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue'];
const TABLES = { blocks: 'blocks', reports: 'reports', moderationLog: 'moderation_log', orgNotes: 'org_notes', ledger: 'ledger', opsEvents: 'ops_events', sourceChanges: 'source_changes', idvQueue: 'idv_queue' };
/** The writers' literals, key for key (server.mjs, m13, m181). */
const KEYS = {
  blocks: ['id', 'playerId', 'orgId', 'by', 'reason', 'ts'],
  reports: ['id', 'ts', 'by', 'byId', 'byOrgId', 'targetKind', 'targetOrgId', 'targetScoutName', 'targetPlayerId', 'reason', 'urgent', 'status', 'outcome', 'resolvedAt'],
  moderationLog: ['id', 'ts', 'context', 'flags', 'severity', 'excerpt'],
  orgNotes: ['id', 'orgId', 'playerId', 'userId', 'scoutName', 'text', 'ts'],
  ledger: ['id', 'ts', 'type', 'playerId', 'orgId', 'orgName', 'userId', 'scoutName', 'detail'],
  opsEvents: ['id', 'at', 'kind', 'detail'],
  sourceChanges: ['id', 'playerId', 'type', 'sourceSystem', 'sourceId', 'occurredAt', 'detail'],
  idvQueue: ['id', 'guardianId', 'guardianName', 'documentType', 'documentRef', 'provider', 'reference', 'ts', 'status'],
};
const second = (dir) => new DatabaseSync(dbFile(dir), { readOnly: true });
const rowsOf = (dir, table, order = 'seq') => { const s = second(dir); try { return s.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r })); } finally { s.close(); } };
const tableExistsIn = (dir, t) => { const s = second(dir); try { return !!s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); } finally { s.close(); } };
const idsIn = (dir, table) => (tableExistsIn(dir, table) ? rowsOf(dir, table).map((r) => r.id) : null);
const blobOf = (dir, name) => { const s = second(dir); try { return s.prepare('SELECT value FROM collections WHERE name = ?').get(name)?.value ?? null; } finally { s.close(); } };
const seqOf = (dir) => { const s = second(dir); try { return Number(s.prepare("SELECT value FROM meta WHERE key = 'saveSeq'").get()?.value) || 0; } finally { s.close(); } };
const plain = (v) => JSON.parse(JSON.stringify(v));
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
/** The export convention: unknown own fields FIRST, then the literal's present keys in the writer's order. */
const extrasFirst = (row, keys) => { const o = {}; for (const k of Object.keys(row)) if (!keys.includes(k)) setOwn(o, k, row[k]); for (const k of keys) if (Object.hasOwn(row, k)) o[k] = row[k]; return o; };
const canon = (name, rows) => rows.map((r) => extrasFirst(r, KEYS[name]));

// ------------------------------------------------------------------ the literals (synthetic values only)
const T = NOW - MIN;
const block = (over = {}) => ({ id: 'blk-1', playerId: 'pl-adult', orgId: 'org-pro', by: 'player', reason: 'synthetic reason', ts: T, ...over });
const report = (over = {}) => ({ id: 'rep-1', ts: T, by: 'player', byId: 'pl-adult', targetKind: 'club', targetOrgId: 'org-pro', targetScoutName: null, targetPlayerId: null, reason: 'Synthetic report reason.', urgent: false, status: 'pending_review', outcome: null, resolvedAt: null, ...over });
/** The automatic escalation literal (moderateOrRefuse): no targetPlayerId key, no byOrgId key. */
const autoReport = (over = {}) => ({ id: 'rep-auto', ts: T, by: 'system', byId: 'moderation', targetKind: 'club', targetOrgId: 'org-pro', reason: 'Automatic escalation: grooming-pattern language blocked (secrecy) in player_message.', urgent: true, status: 'pending_review', outcome: null, resolvedAt: null, ...over });
const modHit = (over = {}) => ({ id: 'mod-1', ts: T, context: { kind: 'player_message', channelId: 'chan-1' }, flags: ['email'], severity: 'contact', excerpt: 'synthetic excerpt with an address', ...over });
const note = (over = {}) => ({ id: 'note-1', orgId: 'org-pro', playerId: 'pl-adult', userId: 'usr-1', scoutName: 'Maria', text: 'Synthetic note text.', ts: T, ...over });
const led = (over = {}) => ({ id: 'led-1', ts: T, type: 'view', playerId: 'pl-adult', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', ...over });
const ops = (over = {}) => ({ id: 'ops-1', at: T, kind: 'backup_created', detail: { dir: '2026-10-19', files: 3, queuedForRemoval: 0 }, ...over });
const srcc = (over = {}) => ({ id: 'srcc-1', playerId: 'pl-adult', type: 'position_changed', sourceSystem: 'passport_prefs', sourceId: 'pl-adult:ST', occurredAt: T, detail: { from: null, to: 'ST', submittedBy: 'player' }, ...over });
const idv = (over = {}) => ({ id: 'idv-1', guardianId: 'gd-primary', guardianName: 'Primary Parent', documentType: 'passport', documentRef: '4567', provider: 'dev-attestation', reference: 'idv_0123456789abcdef', ts: T, status: 'approved', ...over });

/** A file at S7d (0001–0012 applied) carrying the eight audit blobs the way the 4f954ad build wrote them. */
function s7dFile(dir, { blobs = {}, rawBlobs, omit = [] } = {}) {
  const extra = { requests: [], vouches: [], channels: [], notifications: [], dispatches: [], blocks: [], reports: [], moderationLog: [], orgNotes: [], ledger: [], opsEvents: [], sourceChanges: [], idvQueue: [], ...blobs };
  for (const name of omit) delete extra[name];
  s3File(dir, { extra, rawBlobs });
  const s = openRaw(dir);
  runDataMigrations(s, DATA_MIGRATIONS.filter((m) => m.id < MIGRATION), { now: NOW, context: { sessionTtlMs: TTL } });
  s.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
let mod = null;
try { mod = await import('../repositories/safetyAudit.mjs'); } catch { mod = null; }
let rollbackMod = null;
try { rollbackMod = await import('../repositories/safetyAuditRollback.mjs'); } catch { rollbackMod = null; }
// S4b-R: a file this build writes carries 0014 too; the S4b-R tool (copy-only, the retained records kept as a blob) goes first and the S6b tool works on its output.
let erasureRollbackMod = null;
try { erasureRollbackMod = await import('../repositories/playerErasureRollback.mjs'); } catch { erasureRollbackMod = null; }
const preS4bR = (file) => { if (!erasureRollbackMod) return file; const s8c = tempDir('sa-s8c-to-s8b'); recruitmentContactsOffersRollbackMod.rollbackRecruitmentContactsOffersCopy(file, s8c); /* S8c: the file carries 0017; its rollback goes first */ const s8b = tempDir('sa-s8b-to-s8a'); recruitmentCasesRollbackMod.rollbackRecruitmentCasesCopy(dbFile(s8c), s8b); /* then S8b */ const s8a = tempDir('sa-s8a-to-s4br'); recruitmentRollbackMod.rollbackRecruitmentCopy(dbFile(s8b), s8a); /* then S8a */ const out = tempDir('sa-s4br-to-s6b'); erasureRollbackMod.rollbackPlayerErasureCopy(dbFile(s8a), out); return dbFile(out); };
const recruitmentRollbackMod = await import('../repositories/recruitmentRollback.mjs');
const recruitmentCasesRollbackMod = await import('../repositories/recruitmentCasesRollback.mjs');
const recruitmentContactsOffersRollbackMod = await import('../repositories/recruitmentContactsOffersRollback.mjs');
const { RECRUITMENT_TABLES } = await import('../repositories/recruitment.mjs'); // S8a: the fifteen tables the S8a rollback drops
const { RECRUITMENT_CASES_TABLES } = await import('../repositories/recruitmentCases.mjs'); // S8b: the twenty-five tables the S8b rollback drops
const { RECRUITMENT_CONTACTS_OFFERS_TABLES } = await import('../repositories/recruitmentContactsOffers.mjs'); // S8c: the nine tables the S8c rollback (the chain's first link) drops
const needModule = () => { assert.ok(mod, 'repositories/safetyAudit.mjs exists (the S6b repository module)'); return mod; };
/** A live server-mode store with the data layer attached: the repository in its STAGED mode, as the server runs it. */
function live(dir, { now = () => NOW } = {}) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = store.load()?.db ?? {};
  const warnings = [];
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now, warn: (m) => warnings.push(m) });
  const snapshot = () => ({ savedAt: NOW, idCounter: counter, db });
  return { store, db, layer, warnings, repo: layer.safetyAudit, snapshot, save: () => store.save(snapshot()), close: () => store.sqlite.close() };
}
/** An immediate-mode repository on a bare connection (a tool, a test): own transaction per mutation. */
const bare = (s, over = {}) => needModule().createSafetyAuditRepository({ sqlite: s, now: () => NOW, ...over });
/** Every table's rows in the legacy shape, through the module's own reader. */
const stored = (s) => { const { AUDIT_SNAPSHOT_TABLES } = needModule(); const out = {}; for (const t of AUDIT_SNAPSHOT_TABLES) out[t.name] = t.read(s); return out; };

// ============================================================= [compat] what the accepted representation already does
test('[compat] the legacy blob representation: handleReport stores the targetPlayerId it received (a number, an object) without a type or existence check and omits the key on the automatic path; a ledger entry is `{ id, ts, ...entry }` with whatever keys the caller passed; JSON keeps absent and null apart; a non-finite number serialises as null — the shapes the storage move must keep', () => {
  const blobRows = JSON.parse(JSON.stringify([report({ targetPlayerId: 123 }), report({ id: 'rep-2', targetPlayerId: { id: 'pl-x' } }), autoReport(), { ...led({ id: 'led-x' }), detail: { shareId: 's1' }, futureKey: Infinity }]));
  assert.equal(blobRows[0].targetPlayerId, 123); assert.deepEqual(blobRows[1].targetPlayerId, { id: 'pl-x' });
  assert.equal(Object.hasOwn(blobRows[2], 'targetPlayerId'), false, 'the automatic report has no targetPlayerId key'); assert.equal(Object.hasOwn(blobRows[2], 'byOrgId'), false);
  assert.equal(blobRows[3].futureKey, null, 'a non-finite number is null in the blob'); assert.deepEqual(Object.keys(blobRows[3]).slice(0, 3), ['id', 'ts', 'type']);
  assert.equal(Object.hasOwn(blobRows[0], 'targetScoutName'), true); assert.equal(blobRows[0].targetScoutName, null);
});

// ============================================================= [cutover] the migration from the eight legacy blobs
test('[cutover] migration 0013 is registered after 0012 and imports the eight blobs losslessly: every writer literal, an unknown own key at row level and inside a nested context/detail (own "__proto__" keys included), an ABSENT optional key next to a present-and-null one, values of a known key that are not the column type (a numeric targetPlayerId, an object orgId, a float ts), a ledger row with no playerId key, rows naming a player that does not exist (Domain P: counted per table, imported as they are), a backup_refused and a backup_failed ops event, two IDV entries of one guardian; array order becomes seq; the eight blob rows are retired; the cutover record carries counts only; a second run applies nothing; the way back equals the input (extras first, absence preserved, odd values restored)', () => {
  const dir = tempDir('sa-mig');
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"},"constructor":"own-constructor"}');
  const blobs = {
    blocks: [block(), block({ id: 'blk-2', playerId: 'pl-gone', orgId: { not: 'a string' }, reason: 42, by: 'guardian', futureBlockField: [1] }), block({ id: 'blk-3', playerId: 'pl-child1', orgId: 'org-pro', by: 'guardian', reason: 'suspended_pending_review' })],
    reports: [report(), report({ id: 'rep-2', by: 'org_user', byId: 'usr-1', byOrgId: 'org-pro', targetKind: 'player', targetPlayerId: 'pl-gone', targetOrgId: null }), report({ id: 'rep-3', targetKind: 'player', targetPlayerId: 123, ts: 1.5 }), autoReport({ ...special })],
    moderationLog: [modHit(), modHit({ id: 'mod-2', context: { kind: 'org_message', channelId: 'chan-2', futureContextField: { deep: true }, ...special }, flags: ['secrecy', 'url'], severity: 'grooming' })],
    orgNotes: [note(), note({ id: 'note-2', playerId: 'pl-gone', userId: null })],
    ledger: [led(), led({ id: 'led-2', type: 'open_trial_posted', playerId: null, userId: 'usr-1', scoutName: 'Maria', detail: { trialId: 't1' } }), { id: 'led-3', ts: T, type: 'staff_removed', orgId: 'org-pro', orgName: 'Eastport FC', userId: null, scoutName: 'system' }, led({ id: 'led-4', playerId: 'pl-gone', type: 'shortlist', futureLedgerField: 'kept' }), led({ id: 'led-5', playerId: 'pl-child1', type: 'message', scoutName: 'Primary Parent', userId: null })],
    opsEvents: [ops(), ops({ id: 'ops-2', kind: 'backup_refused', detail: { dir: 'x', error: 'MEDIA_QUEUE_OWNERSHIP_CONFLICT', conflicts: [{ mediaId: 'med-1', owners: ['pl-adult'] }] } }), ops({ id: 'ops-3', kind: 'backup_failed', detail: { dir: 'x', error: 'ENOSPC' } }), ops({ id: 'ops-4', kind: 'future_kind', detail: null })],
    sourceChanges: [srcc(), srcc({ id: 'srcc-2', playerId: 'pl-gone', sourceSystem: 'position_history', sourceId: 'ppos-1', detail: { to: 'CM', submittedBy: 'guardian' } })],
    idvQueue: [idv(), idv({ id: 'idv-2', ts: T + 1, documentType: { odd: 'object' }, status: 'revoked' }), idv({ id: 'idv-3', guardianId: 'gd-signup', guardianName: 'Signup Parent' })],
  };
  const noKey = { ...autoReport({ id: 'rep-nokey' }) }; delete noKey.outcome; blobs.reports.push(noKey); // an ABSENT key next to present-and-null ones
  s7dFile(dir, { blobs });
  const s = openRaw(dir);
  assert.ok(!applied(s).includes(MIGRATION)); for (const n of COLLECTIONS) assert.ok(blob(s, n), `${n} blob before`);
  const ran = migrate(s);
  assert.ok(ran.ran.includes(MIGRATION), `0013 ran (${ran.ran.join(', ')})`); // fails on 1792fc7: the id is not registered
  assert.deepEqual(applied(s).slice(-6), ['0012_channels', MIGRATION, '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers']); // S4b-R, S8a, S8b and S8c registered after this step
  for (const t of Object.values(TABLES)) assert.ok(s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `${t} exists`);
  for (const n of COLLECTIONS) assert.equal(blob(s, n), undefined, `the ${n} blob row is retired`);
  // Columns and order.
  const bl = s.prepare('SELECT * FROM blocks ORDER BY seq').all();
  assert.deepEqual(bl.map((r) => [r.seq, r.id, r.player_id, r.org_id, r.by_kind, r.reason, r.created_at]), [[1, 'blk-1', 'pl-adult', 'org-pro', 'player', 'synthetic reason', T], [2, 'blk-2', 'pl-gone', null, 'guardian', null, T], [3, 'blk-3', 'pl-child1', 'org-pro', 'guardian', 'suspended_pending_review', T]], 'array order is seq; a non-string orgId/reason leaves the column NULL');
  assert.deepEqual(JSON.parse(bl[1].offtype_json), { orgId: { not: 'a string' }, reason: 42 }, 'the odd values are kept as JSON under their key'); assert.deepEqual(JSON.parse(bl[1].extra_json), { futureBlockField: [1] }); assert.equal(bl[0].offtype_json, null); assert.equal(bl[0].extra_json, null); assert.equal(bl[0].absent_keys_json, null);
  const rp = s.prepare('SELECT * FROM reports ORDER BY seq').all();
  assert.deepEqual(rp.map((r) => [r.id, r.by_kind, r.by_org_id, r.target_kind, r.target_player_id, r.urgent, r.status, r.outcome, r.resolved_at, r.created_at]), [['rep-1', 'player', null, 'club', null, 0, 'pending_review', null, null, T], ['rep-2', 'org_user', 'org-pro', 'player', 'pl-gone', 0, 'pending_review', null, null, T], ['rep-3', 'player', null, 'player', null, 0, 'pending_review', null, null, null], ['rep-auto', 'system', null, 'club', null, 1, 'pending_review', null, null, T], ['rep-nokey', 'system', null, 'club', null, 1, 'pending_review', null, null, T]]);
  assert.deepEqual(JSON.parse(rp[0].absent_keys_json), ['byOrgId'], 'a user report has no byOrgId key: recorded as absent'); assert.deepEqual(JSON.parse(rp[2].offtype_json), { targetPlayerId: 123, ts: 1.5 }, 'a numeric targetPlayerId and a float ts are kept as JSON'); assert.deepEqual(JSON.parse(rp[3].absent_keys_json), ['byOrgId', 'targetScoutName', 'targetPlayerId'], 'the automatic report: three absent keys'); assert.deepEqual(JSON.parse(rp[4].absent_keys_json), ['byOrgId', 'targetScoutName', 'targetPlayerId', 'outcome']);
  assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(rp[3].extra_json))), JSON.parse('{"__proto__":{"legacyMarker":"keep-me"},"constructor":"own-constructor"}'), 'own prototype-like keys are data');
  const ml = s.prepare('SELECT * FROM moderation_log ORDER BY seq').all();
  assert.deepEqual(ml.map((r) => [r.id, r.severity, r.excerpt, r.flags_json]), [['mod-1', 'contact', 'synthetic excerpt with an address', '["email"]'], ['mod-2', 'grooming', 'synthetic excerpt with an address', '["secrecy","url"]']]);
  assert.deepEqual(JSON.parse(JSON.stringify(JSON.parse(ml[1].context_json))), JSON.parse('{"kind":"org_message","channelId":"chan-2","futureContextField":{"deep":true},"__proto__":{"legacyMarker":"keep-me"},"constructor":"own-constructor"}'), 'the whole context, unknown keys included, as JSON');
  const on = s.prepare('SELECT * FROM org_notes ORDER BY seq').all(); assert.deepEqual(on.map((r) => [r.id, r.org_id, r.player_id, r.user_id, r.scout_name, r.text, r.created_at]), [['note-1', 'org-pro', 'pl-adult', 'usr-1', 'Maria', 'Synthetic note text.', T], ['note-2', 'org-pro', 'pl-gone', null, 'Maria', 'Synthetic note text.', T]]);
  const lg = s.prepare('SELECT * FROM ledger ORDER BY seq').all();
  assert.deepEqual(lg.map((r) => [r.id, r.type, r.player_id, r.org_id, r.org_name, r.user_id, r.actor_name, r.detail_json, r.absent_keys_json, r.extra_json]), [
    ['led-1', 'view', 'pl-adult', 'org-pro', 'Eastport FC', 'usr-1', 'Maria', null, '["detail"]', null],
    ['led-2', 'open_trial_posted', null, 'org-pro', 'Eastport FC', 'usr-1', 'Maria', '{"trialId":"t1"}', null, null],
    ['led-3', 'staff_removed', null, 'org-pro', 'Eastport FC', null, 'system', null, '["playerId","detail"]', null],
    ['led-4', 'shortlist', 'pl-gone', 'org-pro', 'Eastport FC', 'usr-1', 'Maria', null, '["detail"]', '{"futureLedgerField":"kept"}'],
    ['led-5', 'message', 'pl-child1', 'org-pro', 'Eastport FC', null, 'Primary Parent', null, '["detail"]', null],
  ], 'userId/scoutName verbatim (no actor kind derived); a row without a playerId key records the absence; a null playerId stays null');
  const oe = s.prepare('SELECT * FROM ops_events ORDER BY seq').all(); assert.deepEqual(oe.map((r) => [r.id, r.kind, r.occurred_at, r.detail_json]), [['ops-1', 'backup_created', T, '{"dir":"2026-10-19","files":3,"queuedForRemoval":0}'], ['ops-2', 'backup_refused', T, '{"dir":"x","error":"MEDIA_QUEUE_OWNERSHIP_CONFLICT","conflicts":[{"mediaId":"med-1","owners":["pl-adult"]}]}'], ['ops-3', 'backup_failed', T, '{"dir":"x","error":"ENOSPC"}'], ['ops-4', 'future_kind', T, null]], 'every kind imported, the two the first DDL draft forgot included; an open vocabulary');
  const sc = s.prepare('SELECT * FROM source_changes ORDER BY seq').all(); assert.deepEqual(sc.map((r) => [r.id, r.player_id, r.type, r.source_system, r.source_id, r.occurred_at, r.detail_json]), [['srcc-1', 'pl-adult', 'position_changed', 'passport_prefs', 'pl-adult:ST', T, '{"from":null,"to":"ST","submittedBy":"player"}'], ['srcc-2', 'pl-gone', 'position_changed', 'position_history', 'ppos-1', T, '{"to":"CM","submittedBy":"guardian"}']]);
  const iq = s.prepare('SELECT * FROM idv_queue ORDER BY seq').all(); assert.deepEqual(iq.map((r) => [r.id, r.guardian_id, r.guardian_name, r.document_type, r.document_ref_last4, r.provider, r.reference, r.created_at, r.status, r.offtype_json]), [['idv-1', 'gd-primary', 'Primary Parent', 'passport', '4567', 'dev-attestation', 'idv_0123456789abcdef', T, 'approved', null], ['idv-2', 'gd-primary', 'Primary Parent', null, '4567', 'dev-attestation', 'idv_0123456789abcdef', T + 1, 'revoked', '{"documentType":{"odd":"object"}}'], ['idv-3', 'gd-signup', 'Signup Parent', 'passport', '4567', 'dev-attestation', 'idv_0123456789abcdef', T, 'approved', null]]);
  // The cutover record: counts only.
  const record = JSON.parse(meta(s, META));
  assert.deepEqual(Object.fromEntries(COLLECTIONS.map((n) => [n, record[n].imported])), { blocks: 3, reports: 5, moderationLog: 2, orgNotes: 2, ledger: 5, opsEvents: 4, sourceChanges: 2, idvQueue: 3 });
  assert.deepEqual([record.blocks.withExtraFields, record.blocks.withOfftypeValues, record.reports.withAbsentKeys, record.reports.withOfftypeValues, record.reports.withExtraFields, record.moderationLog.withExtraFields, record.ledger.withAbsentKeys, record.idvQueue.withOfftypeValues], [1, 1, 4, 1, 1, 0, 4, 1], 'per-collection counts (rep-2 and led-2 carry every key; a nested unknown key inside context is part of the context value, not an extra field)');
  assert.deepEqual(Object.fromEntries(['blocks', 'reports', 'orgNotes', 'ledger', 'sourceChanges'].map((n) => [n, [record[n].unresolvedPlayerIds, record[n].withoutPlayerId]])), { blocks: [1, 0], reports: [1, 4], orgNotes: [1, 0], ledger: [1, 2], sourceChanges: [1, 0] }, 'Domain P: unresolved ids counted per table (a count, not provenance); rows without a usable player id counted apart');
  assert.doesNotMatch(JSON.stringify(record), /Synthetic|excerpt|address|Maria|Primary|4567|keep-me|pl-gone/, 'counts only — no text, no name, no id');
  assert.deepEqual(migrate(s).ran, [], 'a second run applies nothing');
  // The way back is lossless.
  const back = stored(s);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(back[n]), JSON.stringify(canon(n, blobs[n])), `${n} round-trips (extras first, absence preserved, odd values restored)`);
  assert.equal(back.reports[2].targetPlayerId, 123); assert.equal(back.reports[2].ts, 1.5); assert.deepEqual(back.blocks[1].orgId, { not: 'a string' }); assert.equal(back.blocks[1].reason, 42);
  assert.equal(Object.hasOwn(back.reports[3], 'targetPlayerId'), false, 'absent stays absent'); assert.equal(back.reports[0].targetPlayerId, null, 'present-and-null stays null'); assert.equal(Object.hasOwn(back.reports[4], 'outcome'), false);
  assert.equal(Object.hasOwn(back.ledger[2], 'playerId'), false); assert.equal(back.ledger[1].playerId, null);
  assert.ok(Object.hasOwn(back.reports[3], '__proto__'), 'the own __proto__ key survives'); assert.equal(back.reports[3].constructor, 'own-constructor'); assert.ok(Object.hasOwn(back.moderationLog[1].context, '__proto__'));
  s.close(); rm(dir);
});

test('[cutover] migration refusals (SAFETY_AUDIT_IMPORT_BLOCKED: collections, positions, ids and reasons — never a text): a duplicate id within a collection, an entry without an id, an entry that is not an object, a non-array blob, an IDV entry whose guardian does not exist (STRICT — IDV_GUARDIAN_MISSING), an IDV entry whose guardianId is not a string — each aborts the whole step: no table, every blob and saveSeq untouched; an absent blob and an empty blob import nothing and record the cutover; a player-audit row naming a missing player is NOT a refusal', () => {
  const SECRET = 'SECRET-NOTE-TEXT-44';
  const cases = [
    ['duplicate id', { blobs: { ledger: [led(), led()] } }, /ledger[^;]*duplicates the id/],
    ['no id', { blobs: { orgNotes: [{ ...note({ text: SECRET }), id: undefined }] } }, /orgNotes[^;]*id must be a non-empty string/],
    ['not an object', { blobs: { blocks: [block(), 'blk-2'] } }, /blocks blob entry #1[^;]*not an object/],
    ['blob not an array', { rawBlobs: { reports: '{"id":"rep-1"}' } }, /reports[^;]*must be an array/],
    ['guardian missing', { blobs: { idvQueue: [idv({ guardianId: 'gd-missing' })] } }, /IDV_GUARDIAN_MISSING[^;]*idv-1/],
    ['guardianId not a string', { blobs: { idvQueue: [idv({ guardianId: 7 })] } }, /idvQueue[^;]*guardianId must be a non-empty string/],
  ];
  for (const [label, file, re] of cases) {
    const dir = tempDir('sa-refuse'); s7dFile(dir, file); const s = openRaw(dir);
    const before = { blobs: COLLECTIONS.map((n) => s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value ?? null), seq: meta(s, 'saveSeq') };
    assert.throws(() => migrate(s), (e) => /SAFETY_AUDIT_IMPORT_BLOCKED/.test(e.message) && re.test(e.message) && !e.message.includes(SECRET), `${label}: ${(() => { try { migrate(s); return 'did not throw'; } catch (e) { return e.message.slice(0, 300); } })()}`);
    assert.ok(!applied(s).includes(MIGRATION), `${label}: not recorded`); for (const t of Object.values(TABLES)) assert.equal(s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined, `${label}: no ${t} table`);
    assert.deepEqual({ blobs: COLLECTIONS.map((n) => s.prepare('SELECT value FROM collections WHERE name = ?').get(n)?.value ?? null), seq: meta(s, 'saveSeq') }, before, `${label}: untouched`);
    s.close(); rm(dir);
  }
  for (const [label, file] of [['absent', { omit: COLLECTIONS }], ['empty', {}]]) {
    const dir = tempDir('sa-empty'); s7dFile(dir, file); const s = openRaw(dir);
    migrate(s); assert.ok(applied(s).includes(MIGRATION), label); for (const t of Object.values(TABLES)) assert.equal(s.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${label}: ${t} empty`); for (const n of COLLECTIONS) assert.equal(blob(s, n), undefined);
    assert.deepEqual(Object.fromEntries(COLLECTIONS.map((n) => [n, JSON.parse(meta(s, META))[n].imported])), Object.fromEntries(COLLECTIONS.map((n) => [n, 0])));
    s.close(); rm(dir);
  }
  const dir = tempDir('sa-tolerant'); s7dFile(dir, { blobs: { ledger: [led({ playerId: 'pl-gone' })], blocks: [block({ playerId: 'pl-gone' })], reports: [report({ targetKind: 'player', targetPlayerId: 'pl-gone' })], orgNotes: [note({ playerId: 'pl-gone' })], sourceChanges: [srcc({ playerId: 'pl-gone' })] } }); const s = openRaw(dir);
  migrate(s); assert.ok(applied(s).includes(MIGRATION), 'Domain P: a missing player refuses nothing'); const rec = JSON.parse(meta(s, META)); assert.deepEqual(['blocks', 'reports', 'orgNotes', 'ledger', 'sourceChanges'].map((n) => rec[n].unresolvedPlayerIds), [1, 1, 1, 1, 1]); assert.equal(s.prepare("SELECT player_id FROM ledger").get().player_id, 'pl-gone', 'imported as it is');
  s.close(); rm(dir);
});

test('[cutover] the actual schema: NO foreign key on any of the eight tables (Q4: the five player references are historical; Q4b: the guardian reference is checked in code; organisation and staff references are historical pointers the routes never checked); every table STRICT with a seq order key and a UNIQUE id; the documented indexes exist; no CHECK narrows a vocabulary the writers leave open', () => {
  const dir = tempDir('sa-schema'); s7dFile(dir); const s = openRaw(dir); migrate(s);
  for (const t of Object.values(TABLES)) {
    assert.deepEqual(s.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t}: no foreign key`);
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql; assert.match(sql, /STRICT\s*$/, `${t} STRICT`); assert.match(sql, /seq\s+INTEGER PRIMARY KEY/, `${t} seq`); assert.match(sql, /\bid\s+TEXT NOT NULL UNIQUE/, `${t} unique id`);
    assert.doesNotMatch(sql, /CHECK \((by_kind|severity|provider|status|kind|type|source_system|target_kind) IN/, `${t}: no vocabulary CHECK`);
  }
  const idx = s.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN ('blocks','reports','moderation_log','org_notes','ledger','ops_events','source_changes','idv_queue') ORDER BY name").all().map((r) => r.name);
  for (const i of ['blocks_player_id_org_id', 'reports_by_kind_by_id', 'reports_target_org_id_urgent_status', 'reports_status_created_at', 'reports_target_player_id', 'moderation_log_severity', 'moderation_log_created_at', 'org_notes_org_id_player_id_created_at', 'ledger_player_id_type', 'ledger_player_id_org_id_occurred_at', 'ledger_org_id_type', 'ledger_occurred_at', 'ops_events_kind', 'ops_events_occurred_at', 'source_changes_player_id_occurred_at', 'idv_queue_guardian_id_created_at']) assert.ok(idx.includes(i), `index ${i}`);
  s.exec("INSERT INTO blocks (id, player_id, org_id, by_kind, reason, created_at) VALUES ('b1', 'pl-nobody', 'org-nobody', 'player', '', 1)");
  assert.throws(() => s.exec("INSERT INTO blocks (id, player_id, org_id, by_kind, reason, created_at) VALUES ('b1', 'p', 'o', 'player', '', 1)"), /UNIQUE/, 'one row per id');
  s.exec("INSERT INTO idv_queue (id, guardian_id, status) VALUES ('i1', 'gd-nobody', 'approved')"); // no FK: the strict check is the code's, not the engine's
  s.close(); rm(dir);
});

// ============================================================= [cutover] the repository (immediate mode)
test('[cutover] repository, immediate mode: append on each of the eight collections keeps insertion order; blocks.remove returns the lifted row and deletes it (Q5); reports.patch changes status/outcome/resolvedAt by row id and refuses any other key; idvQueue.append refuses a missing guardian by name (IDV_GUARDIAN_MISSING) and leaves the mirror as it was, idvQueue.firstForGuardian is the FIRST entry in insertion order and patch flips its status; sourceChanges.trimTo deletes the oldest beyond the cap; a value JSON cannot carry is refused; unresolved player references are counted, never refused; a refused operation inside its own transaction restores the mirror in place (held views included); exportRows is detached; reload reproduces the stored rows', () => {
  const dir = tempDir('sa-repo'); s7dFile(dir, { blobs: { idvQueue: [idv()], ledger: [led()] } }); const s = openRaw(dir); migrate(s);
  const repo = bare(s);
  assert.deepEqual(repo.counts(), { blocks: 0, reports: 0, moderationLog: 0, orgNotes: 0, ledger: 1, opsEvents: 0, sourceChanges: 0, idvQueue: 1 });
  const b1 = repo.blocks.append(block({ id: 'blk-a' })); const b2 = repo.blocks.append(block({ id: 'blk-b', orgId: { odd: true } })); assert.equal(b1.id, 'blk-a'); assert.throws(() => { b1.reason = 'x'; }, /written through its domain repository/);
  assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-a', 'blk-b']); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-a', 'blk-b']); assert.deepEqual(plain(b2.orgId), { odd: true }, 'the odd value is live as given');
  assert.throws(() => repo.blocks.append(block({ id: 'blk-a' })), /blocks: a row with id blk-a already exists/); assert.throws(() => repo.blocks.append({ playerId: 'x' }), /id must be a non-empty string/); assert.throws(() => repo.blocks.append(block({ id: 'blk-fn', reason: () => 1 })), /cannot be stored as JSON|not a JSON value/);
  assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-a', 'blk-b'], 'refusals leave the mirror as it was');
  const lifted = repo.blocks.remove('blk-a'); assert.deepEqual(plain(lifted), block({ id: 'blk-a' })); assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-b']); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-b']); assert.equal(repo.blocks.remove('blk-none'), null);
  repo.reports.append(report({ id: 'rep-a' })); repo.reports.append(autoReport({ id: 'rep-b' })); repo.reports.append(report({ id: 'rep-c', targetKind: 'player', targetPlayerId: 'pl-nobody' }));
  const held = repo.reports.byId('rep-a'); assert.equal(held.status, 'pending_review');
  assert.deepEqual(plain(repo.reports.patch('rep-a', { status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic outcome.' })), report({ id: 'rep-a', status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic outcome.' })); assert.equal(held.status, 'resolved'); assert.equal(held.resolvedAt, NOW);
  assert.deepEqual(rowsOf(dir, 'reports').map((r) => [r.id, r.status, r.outcome, r.resolved_at]), [['rep-a', 'resolved', 'Synthetic outcome.', NOW], ['rep-b', 'pending_review', null, null], ['rep-c', 'pending_review', null, null]]);
  assert.throws(() => repo.reports.patch('rep-a', { reason: 'rewritten' }), /reports: patch changes status, outcome and resolvedAt only/); assert.throws(() => repo.reports.patch('rep-none', { status: 'resolved' }), /no report rep-none/);
  repo.moderationLog.append(modHit({ id: 'mod-a' })); repo.orgNotes.append(note({ id: 'note-a', playerId: 'pl-nobody' })); repo.ledger.append(led({ id: 'led-a', playerId: 'pl-nobody' })); repo.ledger.append({ id: 'led-b', ts: T, type: 'open_trial_posted', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', detail: { trialId: 't1' }, extraKey: 'kept' }); repo.opsEvents.append(ops({ id: 'ops-a', kind: 'backup_refused' }));
  assert.deepEqual(repo.ledger.view.map((l) => l.id), ['led-1', 'led-a', 'led-b']); assert.deepEqual(plain(repo.ledger.view[2]), extrasFirst({ id: 'led-b', ts: T, type: 'open_trial_posted', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', detail: { trialId: 't1' }, extraKey: 'kept' }, KEYS.ledger));
  assert.deepEqual(repo.unresolvedPlayerReferences(), { blocks: 0, reports: 1, orgNotes: 1, ledger: 1, sourceChanges: 0 }, 'Domain P: counted, never refused');
  // IDV: strict.
  assert.throws(() => repo.idvQueue.append(idv({ id: 'idv-x', guardianId: 'gd-missing' })), (e) => e.code === 'IDV_GUARDIAN_MISSING' && /gd-missing/.test(e.message) && !/Primary Parent|4567/.test(e.message)); assert.deepEqual(repo.idvQueue.view.map((q) => q.id), ['idv-1']); assert.deepEqual(idsIn(dir, 'idv_queue'), ['idv-1']);
  repo.idvQueue.append(idv({ id: 'idv-2', ts: T + 1 })); repo.idvQueue.append(idv({ id: 'idv-3', guardianId: 'gd-signup', guardianName: 'Signup Parent' }));
  assert.equal(repo.idvQueue.firstForGuardian('gd-primary').id, 'idv-1', 'the FIRST entry in insertion order (the admin toggle\'s rule)'); assert.equal(repo.idvQueue.firstForGuardian('gd-nobody'), null);
  assert.equal(repo.idvQueue.patch('idv-1', { status: 'revoked' }).status, 'revoked'); assert.deepEqual(rowsOf(dir, 'idv_queue').map((r) => [r.id, r.status]), [['idv-1', 'revoked'], ['idv-2', 'approved'], ['idv-3', 'approved']]); assert.throws(() => repo.idvQueue.patch('idv-1', { guardianId: 'x' }), /idvQueue: patch changes status only/);
  // Source changes: the cap.
  for (let i = 0; i < 5; i++) repo.sourceChanges.append(srcc({ id: `srcc-${i}`, occurredAt: T + i }));
  assert.equal(repo.sourceChanges.trimTo(3), 2); assert.deepEqual(repo.sourceChanges.view.map((c) => c.id), ['srcc-2', 'srcc-3', 'srcc-4']); assert.deepEqual(idsIn(dir, 'source_changes'), ['srcc-2', 'srcc-3', 'srcc-4']); assert.equal(repo.sourceChanges.trimTo(3), 0);
  // A failure inside the repository's own transaction restores the mirror in place.
  const heldLedger = repo.ledger.view; const heldDetail = repo.ledger.byId('led-b').detail;
  s.exec("CREATE TEMP TRIGGER sa_fail BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'synthetic statement failure'); END");
  assert.throws(() => repo.ledger.append(led({ id: 'led-fail' })), /synthetic statement failure/);
  assert.deepEqual(heldLedger.map((l) => l.id), ['led-1', 'led-a', 'led-b'], 'the held view is back'); assert.equal(repo.ledger.byId('led-b').detail, heldDetail, 'nested identity kept'); assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-a', 'led-b']);
  s.exec('DROP TRIGGER sa_fail');
  const exported = repo.exportAll(); assert.deepEqual(Object.keys(exported), COLLECTIONS); exported.ledger[2].detail.trialId = 'edited'; assert.equal(repo.ledger.byId('led-b').detail.trialId, 't1', 'the export is detached'); assert.deepEqual(exported.blocks.map((b) => b.id), ['blk-b']);
  repo.reload(); assert.deepEqual(repo.ledger.view.map((l) => l.id), ['led-1', 'led-a', 'led-b']); assert.equal(repo.reports.byId('rep-a').status, 'resolved'); assert.deepEqual(plain(repo.blocks.byId('blk-b').orgId), { odd: true }); assert.equal(repo.idvQueue.byId('idv-1').status, 'revoked');
  s.close(); rm(dir);
});

// ============================================================= [cutover] the staged mode (the server's)
test('[cutover] staged mode (the server): a block, a ledger row, a report patch, a block removal and an IDV entry are visible in memory at once but NOT durable ahead of the next snapshot save, which lands them in ONE revision with the blob edits made alongside (the suspended request); a FAILED ORDINARY SAVE (statement or real COMMIT) keeps the mirror and the queue as they are and the retry lands everything once; an ABORTED UNIT OF WORK restores the mirror and the queue to the pre-unit state (held views, nested detail objects and the sequence state included) whether the unit threw, a queued statement failed at the flush, the real COMMIT failed or a participant refusal was caught; the removal joins the unit; writes pending before the unit stay pending; a repository given the participant API refuses to join or write until its save hook is registered', () => {
  const dir = tempDir('sa-staged'); s7dFile(dir, { blobs: { blocks: [block()], reports: [report()], ledger: [led()], idvQueue: [idv()] } });
  const L = live(dir); L.save(); const seq0 = seqOf(dir);
  L.db.vouches.push({ id: 'req-s', playerId: 'pl-adult', orgId: 'org-pro', status: 'pending' });
  L.repo.blocks.append(block({ id: 'blk-2', reason: 'suspended_pending_review' })); L.db.vouches[0].status = 'suspended';
  L.repo.ledger.append(led({ id: 'led-2', type: 'org_blocked_by_player', userId: null, scoutName: 'player' })); L.repo.reports.patch('rep-1', { status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic.' }); L.repo.blocks.remove('blk-1'); L.repo.idvQueue.append(idv({ id: 'idv-2' }));
  assert.equal(L.repo.pending(), 5); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1'], 'nothing durable before the save'); assert.deepEqual(L.db.blocks.map((b) => b.id), ['blk-2'], 'memory shows the new block and not the lifted one'); assert.equal(L.db.reports[0].status, 'resolved'); assert.equal(L.db.idvQueue.length, 2);
  L.store.sqlite.exec("CREATE TEMP TRIGGER sa_fx BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'synthetic flush failure'); END");
  assert.throws(() => L.save(), /synthetic flush failure/); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1']); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 5); assert.equal(JSON.parse(blobOf(dir, 'vouches')).length, 0, 'the blob did not land without the rows');
  L.store.sqlite.exec('DROP TRIGGER sa_fx');
  L.store.sqlite.exec('CREATE TEMP TABLE sa_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE sa_child (parent_id TEXT NOT NULL REFERENCES sa_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER sa_commit AFTER INSERT ON ledger BEGIN INSERT INTO sa_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1']); assert.equal(seqOf(dir), seq0); assert.equal(L.repo.pending(), 5);
  L.store.sqlite.exec('DROP TRIGGER sa_commit');
  L.save();
  assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-2']); assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2']); assert.deepEqual(rowsOf(dir, 'reports').map((r) => [r.id, r.status]), [['rep-1', 'resolved']]); assert.deepEqual(idsIn(dir, 'idv_queue'), ['idv-1', 'idv-2']); assert.equal(JSON.parse(blobOf(dir, 'vouches'))[0].status, 'suspended'); assert.equal(L.repo.pending(), 0);
  L.save(); assert.equal(seqOf(dir), seq0 + 2); assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2'], 'a later save does not replay');
  // A unit of work: together or not at all.
  L.repo.ledger.append(led({ id: 'led-pre' })); assert.equal(L.repo.pending(), 1);
  const heldReport = L.repo.reports.byId('rep-1'); const heldDetailRow = L.repo.ledger.append({ ...led({ id: 'led-d' }), detail: { tag: 'keep' } }); const heldDetail = L.repo.ledger.byId('led-d').detail; assert.equal(L.repo.pending(), 2);
  const state = () => ({ export: plain(L.repo.exportAll()), heldStatus: heldReport.status, heldDetail: plain(heldDetail), requests: JSON.stringify(L.db.vouches), durable: [idsIn(dir, 'blocks'), idsIn(dir, 'ledger'), idsIn(dir, 'idv_queue'), seqOf(dir)] });
  const before = state();
  const unchanged = (label) => { assert.deepEqual(state(), before, label); assert.equal(L.repo.pending(), 2, `${label}: the pre-unit writes are still pending`); assert.equal(L.store.sqlite.isTransaction, false); assert.equal(L.repo.ledger.byId('led-d').detail, heldDetail, `${label}: nested identity kept`); };
  const work = () => { L.db.vouches.push({ id: 'req-u', playerId: 'pl-adult', status: 'accepted' }); L.repo.blocks.append(block({ id: 'blk-u' })); L.repo.blocks.remove('blk-2'); L.repo.reports.patch('rep-1', { status: 'pending_review', resolvedAt: null, outcome: null }); L.repo.ledger.byId('led-d'); L.repo.idvQueue.patch('idv-1', { status: 'revoked' }); L.repo.sourceChanges.append(srcc({ id: 'srcc-u' })); };
  assert.throws(() => L.store.unitOfWork(() => { work(); throw new Error('synthetic unit failure'); }, { snapshot: L.snapshot }), /synthetic unit failure/);
  unchanged('thrown'); assert.equal(heldDetail.tag, 'keep', 'the nested detail object reads its pre-unit value'); assert.throws(() => { heldDetail.tag = 'x'; }, /written through its domain repository/, 'the held nested view is read-only');
  let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.db.vouches.push({ id: 'req-u' }); L.repo.blocks.append(block({ id: 'blk-ok' })); try { L.repo.idvQueue.append(idv({ id: 'idv-bad', guardianId: 'gd-missing' })); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.equal(caught?.code, 'IDV_GUARDIAN_MISSING'); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back'); unchanged('caught');
  L.store.sqlite.exec("CREATE TEMP TRIGGER sa_j BEFORE DELETE ON blocks BEGIN SELECT RAISE(ABORT, 'synthetic joined failure'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /synthetic joined failure/); unchanged('statement failure at the unit\'s flush');
  L.store.sqlite.exec('DROP TRIGGER sa_j');
  L.store.sqlite.exec("CREATE TEMP TRIGGER sa_commit2 AFTER INSERT ON source_changes BEGIN INSERT INTO sa_child (parent_id) VALUES ('missing-on-purpose'); END");
  assert.throws(() => L.store.unitOfWork(work, { snapshot: L.snapshot }), /FOREIGN KEY constraint failed/); unchanged('real COMMIT failure');
  L.store.sqlite.exec('DROP TRIGGER sa_commit2');
  L.store.unitOfWork(work, { snapshot: L.snapshot });
  assert.equal(seqOf(dir), before.durable[3] + 1); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-u']); assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2', 'led-pre', 'led-d'], 'the pre-unit writes landed with the unit'); assert.deepEqual(rowsOf(dir, 'reports').map((r) => [r.id, r.status]), [['rep-1', 'pending_review']]); assert.deepEqual(rowsOf(dir, 'idv_queue').map((r) => [r.id, r.status]), [['idv-1', 'revoked'], ['idv-2', 'approved']]); assert.deepEqual(idsIn(dir, 'source_changes'), ['srcc-u']); assert.ok(JSON.parse(blobOf(dir, 'vouches')).some((r) => r.id === 'req-u')); assert.equal(L.repo.pending(), 0);
  // Hook registration is a precondition inside the joined boundary.
  const { createSafetyAuditRepository } = needModule();
  const bareUnit = createSafetyAuditRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit });
  const stagedUnit = createSafetyAuditRepository({ sqlite: L.store.sqlite, now: () => NOW, unit: L.store.unit, staged: true });
  for (const [label, w] of [['immediate', () => bareUnit.blocks.append(block({ id: 'blk-h' }))], ['staged', () => stagedUnit.blocks.append(block({ id: 'blk-h' }))]]) {
    let c = null; let o = null;
    try { L.store.unitOfWork(() => { L.db.vouches.push({ id: 'req-h' }); try { w(); } catch (e) { c = e; } }, { snapshot: L.snapshot }); } catch (e) { o = e; }
    assert.match(c?.message ?? '', /save hook/, label); assert.ok(o, `${label}: the caught refusal still refuses the unit`); assert.equal(JSON.parse(blobOf(dir, 'vouches')).some((r) => r.id === 'req-h'), false);
  }
  assert.throws(() => stagedUnit.blocks.append(block({ id: 'blk-h' })), /save hook/); assert.throws(() => createSafetyAuditRepository({ sqlite: L.store.sqlite, staged: true }), /needs the store's participant API/);
  void heldDetailRow;
  L.close(); rm(dir);
});

// ============================================================= [cutover] the snapshot dispatcher: tolerant and strict references
test('[cutover] snapshot dispatcher: a tool that loads and saves the whole file round-trips all eight collections byte for byte (extras first, absence preserved, odd values); a collection OMITTED leaves its table alone while others are rewritten; an explicit EMPTY array clears a table; a malformed collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid entry refuses with a text-free diagnostic; the blobs are never recreated; Domain P: a snapshot whose audit rows name players that are absent is ACCEPTED, and an identity-only replacement that REMOVES a player every audit table names is ACCEPTED with every audit row and reference value exactly as before (unresolved references counted, never refused)', () => {
  const dir = tempDir('sa-snap');
  const blobs = { blocks: [block(), block({ id: 'blk-2', orgId: { odd: 1 }, futureField: true })], reports: [report(), autoReport()], moderationLog: [modHit()], orgNotes: [note()], ledger: [led(), led({ id: 'led-2', playerId: 'pl-child1', type: 'shortlist', detail: { x: 1 } })], opsEvents: [ops()], sourceChanges: [srcc()], idvQueue: [idv(), idv({ id: 'idv-2', guardianId: 'gd-signup' })] };
  s7dFile(dir, { blobs }); { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load();
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(snap.db[n]), JSON.stringify(canon(n, blobs[n])), `${n} loaded in the legacy shape`);
  const texts0 = Object.fromEntries(COLLECTIONS.map((n) => [n, JSON.stringify(snap.db[n])]));
  const seq0 = tool.revision(); tool.save(snap); assert.equal(tool.revision(), seq0 + 1);
  const again = tool.load(); for (const n of COLLECTIONS) assert.equal(JSON.stringify(again.db[n]), texts0[n], `${n} round-tripped through replace`);
  assert.deepEqual(plain(again.db.blocks[1].orgId), { odd: 1 }); assert.equal(Object.hasOwn(again.db.reports[1], 'targetPlayerId'), false);
  const { ledger: _omit, blocks: _omit2, ...without } = snap.db; tool.save({ ...snap, db: { ...without, vouches: [{ id: 'v-1' }] } });
  assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2'], 'an omitted collection leaves its table alone'); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1', 'blk-2']); for (const n of COLLECTIONS) assert.equal(blobOf(dir, n), null, `no shadow ${n} blob`); assert.equal(JSON.parse(blobOf(dir, 'vouches')).length, 1);
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, vouches: [{ id: 'v-x' }], ledger: { id: 'x' } } }), /ledger: the snapshot collection must be an array/);
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (vouches included)');
  const SECRET = 'SECRET-NOTE-TEXT-77';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, orgNotes: [note({ id: 'note-1', text: SECRET }), note({ id: 'note-1', text: SECRET })] } }), (e) => /SAFETY_AUDIT_IMPORT_BLOCKED/.test(e.message) && /duplicates the id/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  tool.save({ ...snap, db: { ...snap.db, moderationLog: [] } }); assert.deepEqual(idsIn(dir, 'moderation_log'), []); assert.equal(blobOf(dir, 'moderationLog'), null); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1', 'blk-2']);
  // Domain P, tolerant: audit rows naming absent players are accepted; an identity-only replacement removing a named player is accepted with the audit rows untouched.
  tool.save({ ...snap, db: { ...snap.db, ledger: [...snap.db.ledger, led({ id: 'led-orphan', playerId: 'pl-nobody' })], blocks: [...snap.db.blocks, block({ id: 'blk-orphan', playerId: 'pl-nobody' })] } });
  assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2', 'led-orphan']); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1', 'blk-2', 'blk-orphan']);
  const base = tool.load().db; const auditBefore = Object.fromEntries(COLLECTIONS.map((n) => [n, JSON.stringify(base[n])])); const rowsBefore = Object.fromEntries(Object.values(TABLES).map((t) => [t, rowsOf(dir, t)]));
  const { blocks: _b, reports: _r, moderationLog: _m, orgNotes: _o, ledger: _l, opsEvents: _e, sourceChanges: _s, idvQueue: _q, ...identityOnly } = base;
  const withoutAdult = base.players.filter((p) => p.id !== 'pl-adult'); assert.equal(withoutAdult.length, base.players.length - 1);
  tool.save({ ...snap, db: { ...identityOnly, players: withoutAdult, guardians: base.guardians } });
  assert.equal(rowsOf(dir, 'players', 'rowid').some((p) => p.id === 'pl-adult'), false, 'the player is gone from the identity table');
  const after = tool.load().db; for (const n of COLLECTIONS) assert.equal(JSON.stringify(after[n]), auditBefore[n], `${n}: every row and reference value exactly as before the identity rewrite`);
  assert.deepEqual(Object.fromEntries(Object.values(TABLES).map((t) => [t, rowsOf(dir, t)])), rowsBefore, 'the stored rows (seq included) are byte-identical');
  assert.deepEqual(needModule().unresolvedPlayerReferences(tool.sqlite), { blocks: 3, reports: 0, orgNotes: 1, ledger: 2, sourceChanges: 1 }, 'the unresolved references are counted (blk-1 and blk-2 name the removed adult, blk-orphan a player that never existed) — a count, not a claim about why the ids are absent');
  tool.sqlite.close(); rm(dir);
});

test('[cutover] the STRICT guardian reference (Q4b), every direction, judged on the FINAL state after the coordinated replacement: identity pair only with a referenced guardian removed — the queue OMITTED — refuses atomically (IDV_GUARDIAN_MISSING; tables, unrelated blobs and saveSeq unchanged); identity pair only with every guardian retained succeeds with the queue\'s order and content unchanged; identity pair and queue with a guardian and its entries removed together succeeds; an invalid coordinated replacement (guardian removed, its entry kept) refuses whole with unrelated collections untouched; queue only with an entry naming a missing guardian refuses against the retained identity tables; a queue entry naming a guardian the SAME snapshot adds is accepted', () => {
  const dir = tempDir('sa-strict');
  s7dFile(dir, { blobs: { idvQueue: [idv(), idv({ id: 'idv-2', ts: T + 1 }), idv({ id: 'idv-3', guardianId: 'gd-signup', guardianName: 'Signup Parent' })], ledger: [led()] } }); { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load(); const base = { ...snap.db };
  const unchangedAfter = (fn, re, code, label) => { const before = dump(tool.sqlite); const seq = tool.revision(); assert.throws(fn, (e) => re.test(e.message) && (!code || e.code === code) && !/Primary Parent|Signup Parent|4567/.test(e.message), label); assert.equal(tool.revision(), seq, `${label}: saveSeq unchanged`); assert.deepEqual(dump(tool.sqlite), before, `${label}: nothing changed`); };
  const save = (db) => tool.save({ ...snap, db });
  const { idvQueue: _q, ...noQueue } = base;
  const textBefore = JSON.stringify(tool.load().db.idvQueue);
  // gd-signup has no child and no co-guardian link: its removal is valid for the identity snapshot itself, so the refusal is the queue's final-state assertion.
  const withoutSignup = base.guardians.filter((g) => g.id !== 'gd-signup'); assert.equal(withoutSignup.length, base.guardians.length - 1);
  unchangedAfter(() => save({ ...noQueue, guardians: withoutSignup, vouches: [{ id: 'v-i' }] }), /IDV_GUARDIAN_MISSING[^;]*idv-3/, 'IDV_GUARDIAN_MISSING', '(i) identity pair only, the queue omitted, a referenced guardian removed');
  save({ ...noQueue, guardians: base.guardians, vouches: [{ id: 'v-ii' }] }); assert.equal(JSON.stringify(tool.load().db.idvQueue), textBefore, '(ii) identity pair only, every guardian retained: the queue unchanged in order and content'); assert.equal(JSON.parse(blobOf(dir, 'vouches'))[0].id, 'v-ii');
  save({ ...base, guardians: withoutSignup, idvQueue: base.idvQueue.filter((q) => q.id !== 'idv-3'), vouches: [{ id: 'v-iii' }] }); assert.deepEqual(idsIn(dir, 'idv_queue'), ['idv-1', 'idv-2'], '(iii) guardian and its entries removed together'); assert.equal(rowsOf(dir, 'guardians', 'rowid').some((g) => g.id === 'gd-signup'), false);
  save({ ...base, vouches: [{ id: 'v-back' }] }); assert.deepEqual(idsIn(dir, 'idv_queue'), ['idv-1', 'idv-2', 'idv-3']); assert.ok(rowsOf(dir, 'guardians', 'rowid').some((g) => g.id === 'gd-signup'), 'the guardian is back');
  unchangedAfter(() => save({ ...base, guardians: withoutSignup, idvQueue: base.idvQueue, vouches: [{ id: 'v-iv' }] }), /IDV_GUARDIAN_MISSING[^;]*idv-3/, 'IDV_GUARDIAN_MISSING', '(iv) invalid coordinated replacement: guardian removed, its entry kept');
  assert.equal(JSON.parse(blobOf(dir, 'vouches'))[0].id, 'v-back', '(iv) the unrelated collection is untouched');
  const { players: _p, guardians: _g, ...noIdentity } = base;
  unchangedAfter(() => save({ ...noIdentity, idvQueue: [...base.idvQueue, idv({ id: 'idv-bad', guardianId: 'gd-missing' })] }), /IDV_GUARDIAN_MISSING/, undefined, '(v) queue only with an invalid guardian, against the retained identity tables');
  const newGuardian = { id: 'gd-new', name: 'New Parent', email: 'new@example.test', idVerified: false, disclaimerAccepted: false, childIds: [] };
  save({ ...base, guardians: [...base.guardians, newGuardian], idvQueue: [...base.idvQueue, idv({ id: 'idv-new', guardianId: 'gd-new', guardianName: 'New Parent' })] }); assert.deepEqual(idsIn(dir, 'idv_queue'), ['idv-1', 'idv-2', 'idv-3', 'idv-new'], '(vi) an entry naming a guardian the same snapshot adds');
  tool.sqlite.close(); rm(dir);
});

// ============================================================= [cutover] the copy-only rollback to the accepted pre-S6b build
test('[cutover] rollback (copy-only): every row of the eight tables is written back into its legacy blob in insertion order (extras first, absence preserved, odd values restored, the post-cutover rows included), the eight tables are dropped, the 0013 record and its meta key removed, saveSeq advanced, every other table byte-identical (the S7a–S7d tables included), the source untouched; the real migration re-upgrades the copy to the same rows; the S7d tool refuses a 0013 file (LATER_SCHEMA); refusals leave no output: a later schema step (exit 4), a file that never applied 0013 (exit 5), a non-empty output directory (exit 1), a recorded 0013 whose tables are missing (exit 10), an injected COMMIT failure inside the tool', () => {
  assert.ok(rollbackMod, 'repositories/safetyAuditRollback.mjs exists'); const { rollbackSafetyAuditCopy } = rollbackMod;
  const src = tempDir('sa-rb-src');
  const special = JSON.parse('{"__proto__":{"legacyMarker":"keep-me"}}');
  const blobs = { blocks: [block({ ...special }), block({ id: 'blk-2', orgId: { odd: 1 } })], reports: [report(), autoReport()], moderationLog: [modHit()], orgNotes: [note()], ledger: [led(), led({ id: 'led-2', detail: { x: 1 } })], opsEvents: [ops()], sourceChanges: [srcc()], idvQueue: [idv()] };
  s7dFile(src, { blobs, rawBlobs: { channels: JSON.stringify([{ id: 'chan-1', requestId: 'req-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgVerified: true, scoutName: 'Maria', scoutRole: 'Head of Recruitment', counterparty: 'player', guardianId: null, createdAt: T, messages: [], readBy: { org: null, counterparty: null } }]), requests: JSON.stringify([{ id: 'req-1', playerId: 'pl-adult', playerName: 'Adult Signup', orgId: 'org-pro', orgName: 'Eastport FC', orgType: 'club', orgVerified: true, orgSafeguardingCertified: true, trustedPartner: false, userId: 'usr-1', scoutName: 'Maria', scoutRole: 'Head of Recruitment', type: 'trial', message: 'Synthetic.', trialDetails: { proposedDate: '2026-11-01', altSlots: [], venue: 'G', notes: '' }, status: 'accepted', createdAt: T, routedTo: 'player', guardianId: null, contactChannel: 'chan-1', history: [] }]) } }); // S8a: the request in the writer's literal (a row of recruitment_requests since 0015)
  { const s = openRaw(src); migrate(s); const repo = bare(s); repo.blocks.append(block({ id: 'blk-after' })); repo.blocks.remove('blk-1'); repo.reports.patch('rep-1', { status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic.' }); repo.ledger.append(led({ id: 'led-after' })); repo.idvQueue.append(idv({ id: 'idv-after', status: 'revoked' })); s.close(); }
  const AUDIT_T = Object.values(TABLES);
  const before = { dump: dump(openRaw(src), { except: [...AUDIT_T, 'collections', 'meta', 'data_migrations', ...RECRUITMENT_TABLES, ...RECRUITMENT_CASES_TABLES, ...RECRUITMENT_CONTACTS_OFFERS_TABLES] }), bytes: fs.statSync(dbFile(src)).size, saveSeq: seqOf(src), stored: stored(openRaw(src)) };
  const out = tempDir('sa-rb-out');
  const s4brCopy = preS4bR(dbFile(src));
  const result = rollbackSafetyAuditCopy(s4brCopy, out, { now: NOW });
  assert.equal(result.output, dbFile(out)); assert.deepEqual(result.counts, { blocks: 2, reports: 2, moderationLog: 1, orgNotes: 1, ledger: 3, opsEvents: 1, sourceChanges: 1, idvQueue: 2 }); assert.equal(result.recordRemoved, true); assert.equal(result.saveSeq, before.saveSeq + 5, 'the S8c tool advanced the revision once, the S8b tool once, the S8a tool once, the S4b-R tool once, this tool once more');
  assert.equal(fs.statSync(dbFile(src)).size, before.bytes, 'the source is untouched'); assert.equal(seqOf(src), before.saveSeq); assert.ok(tableExistsIn(src, 'ledger'));
  const o = openRaw(out);
  assert.ok(!applied(o).includes(MIGRATION)); for (const t of AUDIT_T) assert.equal(o.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), undefined, `${t} dropped`); assert.equal(meta(o, META), undefined);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(blob(o, n)), JSON.stringify(before.stored[n]), `${n} blob equals the rows the tables held`);
  const back = blob(o, 'blocks'); assert.deepEqual(back.map((b) => b.id), ['blk-2', 'blk-after'], 'the lifted block is gone, the post-cutover block is there'); assert.deepEqual(back[0].orgId, { odd: 1 });
  assert.deepEqual(blob(o, 'reports').map((r) => [r.id, r.status, Object.hasOwn(r, 'targetPlayerId')]), [['rep-1', 'resolved', true], ['rep-auto', 'pending_review', false]]); assert.deepEqual(blob(o, 'ledger').map((l) => l.id), ['led-1', 'led-2', 'led-after']); assert.deepEqual(blob(o, 'idvQueue').map((q) => [q.id, q.status]), [['idv-1', 'approved'], ['idv-after', 'revoked']]);
  assert.equal(dump(o, { except: [...AUDIT_T, 'collections', 'meta', 'data_migrations', ...RECRUITMENT_TABLES, ...RECRUITMENT_CASES_TABLES, ...RECRUITMENT_CONTACTS_OFFERS_TABLES] }), before.dump, 'every other table byte-identical (channels, messages, notifications, dispatches, outbox, … included)');
  // Re-upgrade: the same rows.
  const beforeUp = JSON.stringify(before.stored); migrate(o); assert.ok(applied(o).includes(MIGRATION)); assert.equal(JSON.stringify(stored(o)), beforeUp, 're-upgraded to the same rows'); for (const n of COLLECTIONS) assert.equal(blob(o, n), undefined);
  o.close();
  // The S7d tool refuses the 0013 file.
  try { execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), src, tempDir('sa-s7dtool')], { stdio: 'pipe' }); assert.fail('must refuse'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // Refusals through the CLI.
  const cli = (dir, outDir) => { try { execFileSync(process.execPath, [path.join(HERE, 'safetyAuditRollback.mjs'), dir, outDir], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  const later = tempDir('sa-rb-later'); { fs.copyFileSync(dbFile(src), dbFile(later)); const s = openRaw(later); s.prepare("INSERT INTO data_migrations (id, applied_at) VALUES ('0099_future', 1)").run(); s.close(); }
  const laterOut = tempDir('sa-rb-later-out'); assert.equal(cli(later, laterOut), 4); assert.deepEqual(fs.readdirSync(laterOut), [], 'no output');
  const never = tempDir('sa-rb-never'); s7dFile(never); const neverOut = tempDir('sa-rb-never-out'); assert.equal(cli(never, neverOut), 5); assert.deepEqual(fs.readdirSync(neverOut), []);
  const full = tempDir('sa-rb-full'); fs.writeFileSync(path.join(full, 'keep.txt'), 'x'); assert.equal(cli(src, full), 1); assert.deepEqual(fs.readdirSync(full), ['keep.txt']);
  const missing = tempDir('sa-rb-missing'); { fs.copyFileSync(s4brCopy, dbFile(missing)); /* the S4b-R tool's output: a 0013 file without 0014, so this tool reaches its own refusal */ const s = openRaw(missing); s.exec('DROP TABLE ops_events; DROP TABLE org_notes;'); s.close(); } const missingOut = tempDir('sa-rb-missing-out'); assert.equal(cli(missing, missingOut), 10); assert.deepEqual(fs.readdirSync(missingOut), []);
  const injected = tempDir('sa-rb-inject-out');
  assert.throws(() => rollbackSafetyAuditCopy(s4brCopy, injected, { now: NOW, _failBeforeCommit: true }), /synthetic commit failure/); assert.deepEqual(fs.readdirSync(injected), [], 'a failure removes the output');
  rm(src, out, later, laterOut, never, neverOut, full, missing, missingOut, injected);
});

// ============================================================= [S6b correction] the two findings of the independent review of c6cf5e1
test('[S6b correction F1] a REJECTED staged patch changes nothing: reports.patch({ status, outcome }) with a valid status and an invalid LATER field (undefined; a function; a Map) throws and leaves the held view, a fresh view, the export, the pending queue (a valid write queued before it stays queued) and the file exactly as before; a later valid patch of another field persists only that field (the rejected status never lands); an idvQueue.patch with an invalid value changes nothing either; inside a unit of work the caught refusal still refuses the unit and restores the pre-unit state; an ACCEPTED patch whose save COMMIT fails is kept and lands once on the retry; held-view identity kept throughout', () => {
  const dir = tempDir('sa-f1'); s7dFile(dir, { blobs: { reports: [report()], idvQueue: [idv()] } });
  const L = live(dir); L.save(); const seq0 = seqOf(dir);
  const held = L.repo.reports.byId('rep-1'); const heldIdv = L.repo.idvQueue.byId('idv-1');
  L.repo.ledger.append(led({ id: 'led-queued' })); assert.equal(L.repo.pending(), 1, 'a valid write queued before the rejected patch');
  const fileReport = () => { const r = rowsOf(dir, 'reports')[0]; return { status: r.status, outcome: r.outcome, resolved_at: r.resolved_at }; };
  const state = () => ({ export: JSON.stringify(L.repo.exportAll()), held: [held.status, held.outcome, held.resolvedAt], fresh: [L.repo.reports.byId('rep-1').status, L.repo.reports.byId('rep-1').outcome], idv: [heldIdv.status, L.repo.idvQueue.byId('idv-1').status], pending: L.repo.pending(), file: fileReport(), seq: seqOf(dir) });
  const before = state();
  assert.deepEqual(before.held, ['pending_review', null, null]);
  for (const [label, bad] of [['undefined', undefined], ['a function', () => 'x'], ['a Map', new Map([['k', 'v']])]]) {
    assert.throws(() => L.repo.reports.patch('rep-1', { status: 'resolved', resolvedAt: NOW, outcome: bad }), /reports\.outcome/, `${label}: refused, naming the field`);
    assert.deepEqual(state(), before, `${label}: nothing changed — held and fresh views, export, queue and file`);
  }
  assert.throws(() => L.repo.reports.patch('rep-1', { status: 'resolved', bogus: 1 }), /patch changes status, outcome and resolvedAt only/); assert.deepEqual(state(), before, 'an unknown key changes nothing');
  assert.throws(() => L.repo.idvQueue.patch('idv-1', { status: () => 'revoked' }), /idvQueue\.status/); assert.deepEqual(state(), before, 'a rejected IDV patch changes nothing');
  assert.equal(L.repo.reports.byId('rep-1'), held, 'held-view identity kept after the refusals');
  // A later valid patch of ANOTHER field persists only that field.
  L.repo.reports.patch('rep-1', { outcome: 'Later valid outcome.' }); assert.equal(L.repo.pending(), 2);
  L.save();
  assert.deepEqual(fileReport(), { status: 'pending_review', outcome: 'Later valid outcome.', resolved_at: null }, 'the rejected status never lands'); assert.equal(seqOf(dir), seq0 + 1); assert.deepEqual(idsIn(dir, 'ledger'), ['led-queued'], 'the write queued before the refusal landed with the save');
  assert.deepEqual([held.status, held.outcome], ['pending_review', 'Later valid outcome.'], 'the held view follows the committed write');
  // Inside a unit of work: the caught refusal still refuses the unit, which restores the pre-unit state.
  const beforeUnit = state(); let caught = null; let outer = null;
  try { L.store.unitOfWork(() => { L.repo.ledger.append(led({ id: 'led-unit' })); try { L.repo.reports.patch('rep-1', { status: 'resolved', outcome: () => 'x' }); } catch (e) { caught = e; } }, { snapshot: L.snapshot }); } catch (e) { outer = e; }
  assert.match(caught?.message ?? '', /reports\.outcome/); assert.ok(outer, 'the caught participant failure still refuses the unit'); assert.equal(outer.unitOfWork, 'rolled_back');
  assert.deepEqual(state(), beforeUnit, 'the unit restored everything'); assert.equal(L.store.sqlite.isTransaction, false);
  // An ACCEPTED staged patch whose save COMMIT fails stays pending and lands once on the retry (unchanged behaviour).
  L.repo.reports.patch('rep-1', { status: 'resolved', resolvedAt: NOW, outcome: 'Resolved.' }); assert.equal(held.status, 'resolved');
  L.store.sqlite.exec('CREATE TEMP TABLE f1_parent (id TEXT PRIMARY KEY); CREATE TEMP TABLE f1_child (parent_id TEXT NOT NULL REFERENCES f1_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TEMP TRIGGER f1_commit AFTER UPDATE ON reports BEGIN INSERT INTO f1_child (parent_id) VALUES (\'missing-on-purpose\'); END');
  assert.throws(() => L.save(), /FOREIGN KEY constraint failed/); assert.equal(fileReport().status, 'pending_review'); assert.equal(L.repo.pending(), 1); assert.equal(held.status, 'resolved', 'the accepted write stays in memory');
  L.store.sqlite.exec('DROP TRIGGER f1_commit'); L.save();
  assert.deepEqual(fileReport(), { status: 'resolved', outcome: 'Resolved.', resolved_at: NOW }); assert.equal(L.repo.pending(), 0); L.save(); assert.equal(fileReport().status, 'resolved', 'no replay');
  L.close(); rm(dir);
});

test('[S6b correction F2] a nested OPTIONAL value that JSON cannot carry is stored the way the pre-S6b blob stored it, never refused: ledger detail { share: undefined } (the Box Cam prefs writer on a partial prefs row) is accepted, the key is ABSENT in the mirror, the file, the export and the rollback blob; an undefined array entry becomes null (JSON.stringify\'s rule); the same holds for a nested context, an unknown nested field and a report patch value; a TOP-LEVEL undefined stays an absent key (unchanged); a nested function, a Map, a BigInt or a cyclic object is still refused; cloneJson\'s default and the outbox / push-token / push-log validators that use it are unchanged and still refuse a nested undefined (object property and array entry), with accepted controls', () => {
  const dir = tempDir('sa-f2'); s7dFile(dir, { blobs: { reports: [report()] } });
  const L = live(dir); L.save();
  const detail = { by: 'player', share: undefined, retainClips: true };
  const row = L.repo.ledger.append({ ...led({ id: 'led-prefs', type: 'box_prefs_changed', orgId: null, userId: undefined }), detail });
  assert.deepEqual(Object.keys(row.detail), ['by', 'retainClips'], 'the undefined nested key is absent, as JSON would have it'); assert.equal(Object.hasOwn(row, 'userId'), false, 'a top-level undefined is an absent key (unchanged)');
  assert.equal(JSON.stringify(row), JSON.stringify({ ...led({ id: 'led-prefs', type: 'box_prefs_changed', orgId: null, userId: undefined }), detail }), 'the mirror is exactly the JSON form of what the writer passed');
  L.repo.moderationLog.append(modHit({ id: 'mod-u', context: { kind: 'player_message', channelId: undefined, list: [1, undefined, 3] }, flags: ['email', undefined] }));
  const m = L.repo.moderationLog.byId('mod-u'); assert.deepEqual(plain(m.context), { kind: 'player_message', list: [1, null, 3] }); assert.deepEqual(plain(m.flags), ['email', null]); assert.equal(Object.hasOwn(m.context, 'channelId'), false);
  L.repo.opsEvents.append({ ...ops({ id: 'ops-u' }), futureNested: { a: undefined, b: [undefined] } }); assert.deepEqual(plain(L.repo.opsEvents.byId('ops-u').futureNested), { b: [null] });
  L.repo.reports.patch('rep-1', { outcome: 'x' }); // a patch value that is a plain string (the route's) is unchanged
  for (const [label, bad] of [['a nested function', { f: () => 1 }], ['a nested Map', { m: new Map() }], ['a nested BigInt', { n: 10n }]]) assert.throws(() => L.repo.ledger.append({ ...led({ id: `led-bad-${label}` }), detail: bad }), /cannot be stored as JSON/, `${label} is still refused`);
  const cyc = { a: 1 }; cyc.self = cyc; assert.throws(() => L.repo.ledger.append({ ...led({ id: 'led-cyc' }), detail: cyc }), RangeError, 'a cyclic object is still refused (no partial row)');
  assert.equal(L.repo.ledger.byId('led-cyc'), null); assert.equal(L.repo.ledger.byId('led-bad-a nested function'), null);
  L.save();
  const fileRow = rowsOf(dir, 'ledger').find((r) => r.id === 'led-prefs'); assert.equal(fileRow.detail_json, JSON.stringify({ by: 'player', retainClips: true }));
  assert.equal(JSON.stringify(stored(L.store.sqlite).ledger.find((r) => r.id === 'led-prefs')), JSON.stringify(row), 'the file reads back the same row');
  assert.equal(JSON.stringify(L.repo.exportAll().ledger.find((r) => r.id === 'led-prefs')), JSON.stringify(row), 'the export (the admin backup) carries the same row');
  L.close();
  // A restart serves the same row; the rollback copy's blob is exactly what the pre-S6b build would have written.
  const L2 = live(dir); assert.equal(JSON.stringify(L2.repo.ledger.byId('led-prefs')), JSON.stringify(row)); L2.close();
  const out = tempDir('sa-f2-rb'); rollbackMod.rollbackSafetyAuditCopy(preS4bR(dbFile(dir)), out, { now: NOW });
  const legacy = JSON.parse(blobOf(out, 'ledger')).find((r) => r.id === 'led-prefs'); assert.equal(JSON.stringify(legacy), JSON.stringify({ ...led({ id: 'led-prefs', type: 'box_prefs_changed', orgId: null, userId: undefined }), detail }), 'the legacy blob row equals JSON.stringify of the writer literal');
  // ISOLATION: the opt-in is the audit repository's only. cloneJson's default and the S7c outbox / push validators that use
  // it still refuse a nested undefined exactly as before (an object property or an array entry), and still accept the same
  // values without it.
  assert.match(outboxCloneJson({ a: undefined }, 'to').reason ?? '', /cannot be stored as JSON/, 'cloneJson default: a nested undefined property is still refused');
  assert.match(outboxCloneJson([1, undefined], 'to').reason ?? '', /cannot be stored as JSON/, 'cloneJson default: an undefined array entry is still refused');
  const mail = { id: 'mail-iso', ts: NOW, to: 'a@example.test', subject: 's', text: 't', transport: 'dev', delivered: false };
  assert.equal(validateOutboxRow(mail).ok, true, 'outbox control: the same mailer row is accepted');
  assert.match(validateOutboxRow({ ...mail, to: ['a@example.test', undefined] }).reason ?? '', /to\[1\].*cannot be stored as JSON/, 'outbox: an undefined entry in an array destination is still refused');
  assert.match(validateOutboxRow({ ...mail, futureNested: { a: undefined } }).reason ?? '', /cannot be stored as JSON/, 'outbox: a nested undefined in an unknown field is still refused');
  const token = { kind: 'player', refId: 'pl-adult', token: { value: 'tok' }, ts: NOW };
  assert.equal(validatePushTokenRow(token).ok, true, 'push token control: accepted');
  assert.match(validatePushTokenRow({ ...token, token: { value: 'tok', extra: undefined } }).reason ?? '', /token\.extra.*cannot be stored as JSON/, 'push token: a nested undefined is still refused');
  const plog = { id: 'push-iso', ts: NOW, audience: { kind: 'player', id: 'pl-adult' }, title: 't', body: 'b', transport: 'dev' };
  assert.equal(validatePushLogRow(plog).ok, true, 'push log control: accepted');
  assert.match(validatePushLogRow({ ...plog, futureNested: [undefined] }).reason ?? '', /cannot be stored as JSON/, 'push log: an undefined array entry in an unknown field is still refused');
  rm(dir, out);
});

console.log(`\n${passed} safety-audit checks passed`);
