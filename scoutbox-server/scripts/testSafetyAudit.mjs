// S6b — the eight audit collections as tables (repositories/safetyAudit.mjs, migration
// 0013_safety_audit): Candidate A of
// docs/architecture/sqlite-migration-plan.md §D.4 as accepted at 1792fc7, with the
// Founder's three decisions of 19 October 2026 — Q4 (the five historical player
// references are TOLERANT: an unresolved id is counted, never refused, never given a
// fabricated parent, never deleted; no parent-existence rule), Q4b (the idv_queue
// guardian reference is STRICT: a missing guardian refuses the write, the import and
// the final state of every snapshot that touches the queue or the identity pair),
// Q5 (lifting a block deletes its row, as today).
//
// Covered: the migration (DDL only, no blob import); junk refused at a snapshot
// save (positions, ids and reasons, never a text); the actual schema (typed columns only,
// no foreign key on any of the eight tables, a unique id per table, insertion order);
// the repository (append — an unknown key dropped, an off-type value refused by name —,
// the block removal, the report and IDV status patches, the first-matching IDV entry, the
// source-change cap, the two write modes, joined units, real COMMIT failure, hook
// registration, held views restored in place); the snapshot dispatcher (round trip,
// omission, empty, malformed, an unknown key dropped, an off-type value refused, tolerant
// player references under an identity rewrite, the strict guardian assertion in every
// direction, identity-only replacement with the queue omitted). Temporary databases
// only; nothing touches DATA_DIR. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runDataMigrations } from '../repositories/database.mjs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir, openRaw, applied, dump, FIXTURE, ORGS, USERS, SESSIONS } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const dbFile = (dir) => path.join(dir, 'scoutbox.db');
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const MIN = 60_000;
const MIGRATION = '0013_safety_audit';
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
/** The typed record of a valid literal: every key of the collection in the writer's order, an absent key null. */
const canonRow = (name, r) => Object.fromEntries(KEYS[name].map((k) => [k, r[k] === undefined ? null : r[k]]));
const canon = (name, rows) => rows.map((r) => canonRow(name, r));

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

/** The fixture's identity, organisation and staff with the given audit collections, as a snapshot-mode save writes them. */
const fixtureDb = (blobs = {}) => ({ ...FIXTURE(), orgs: ORGS(), users: USERS(), sessions: SESSIONS(), vouches: [], ...blobs });
/** A fully migrated file holding the fixture and the given audit rows, written by a snapshot-mode save (the writers' validation applies). */
function s7dFile(dir, { blobs = {} } = {}) {
  const tool = openStore(dir); tool.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(blobs) }); tool.sqlite.close();
}
const migrate = (s, { now = NOW } = {}) => runDataMigrations(s, DATA_MIGRATIONS, { now, context: { sessionTtlMs: TTL } });
let mod = null;
try { mod = await import('../repositories/safetyAudit.mjs'); } catch { mod = null; }
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
/** Every table's typed records, through the module's own reader. */
const stored = (s) => { const { AUDIT_SNAPSHOT_TABLES } = needModule(); const out = {}; for (const t of AUDIT_SNAPSHOT_TABLES) out[t.name] = t.read(s); return out; };

// ============================================================= junk refused at the snapshot save
test('snapshot-save refusals (SAFETY_AUDIT_IMPORT_BLOCKED: collections, positions, ids and reasons — never a text): a duplicate id within a collection, an entry without an id, an entry that is not an object, a non-array collection, an IDV entry whose guardian does not exist (STRICT — IDV_GUARDIAN_MISSING), an IDV entry whose guardianId is not a string — each refuses the whole save: every table and saveSeq untouched; a player-audit row naming a missing player is NOT a refusal (Domain P: stored as it is)', () => {
  const SECRET = 'SECRET-NOTE-TEXT-44';
  const cases = [
    ['duplicate id', { ledger: [led(), led()] }, /ledger[^;]*duplicates the id/],
    ['no id', { orgNotes: [{ ...note({ text: SECRET }), id: undefined }] }, /orgNotes[^;]*id must be a non-empty string/],
    ['not an object', { blocks: [block(), 'blk-2'] }, /blocks[^;]*entry #1[^;]*not an object/],
    ['not an array', { reports: { id: 'rep-1' } }, /reports[^;]*must be an array/],
    ['guardian missing', { idvQueue: [idv({ guardianId: 'gd-missing' })] }, /IDV_GUARDIAN_MISSING[^;]*idv-1/],
    ['guardianId not a string', { idvQueue: [idv({ guardianId: 7 })] }, /idvQueue[^;]*guardianId must be a non-empty string/],
  ];
  const dir = tempDir('sa-refuse'); s7dFile(dir);
  const tool = openStore(dir); const before = dump(tool.sqlite); const seq = tool.revision();
  for (const [label, blobs, re] of cases) {
    assert.throws(() => tool.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(blobs) }), (e) => (/SAFETY_AUDIT_IMPORT_BLOCKED/.test(e.message) || /must be an array/.test(e.message)) && re.test(e.message) && !e.message.includes(SECRET), `${label}: ${(() => { try { tool.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb(blobs) }); return 'did not throw'; } catch (e) { return e.message.slice(0, 300); } })()}`);
    assert.equal(tool.revision(), seq, `${label}: saveSeq unchanged`); assert.deepEqual(dump(tool.sqlite), before, `${label}: nothing changed`);
  }
  tool.save({ savedAt: NOW, idCounter: 1000, db: fixtureDb({ ledger: [led({ playerId: 'pl-gone' })], blocks: [block({ playerId: 'pl-gone' })], reports: [report({ targetKind: 'player', targetPlayerId: 'pl-gone' })], orgNotes: [note({ playerId: 'pl-gone' })], sourceChanges: [srcc({ playerId: 'pl-gone' })] }) });
  for (const t of ['ledger', 'blocks', 'org_notes', 'source_changes']) assert.equal(tool.sqlite.prepare(`SELECT player_id FROM ${t}`).get().player_id, 'pl-gone', `${t}: stored as it is`);
  assert.equal(tool.sqlite.prepare('SELECT target_player_id AS p FROM reports').get().p, 'pl-gone');
  tool.sqlite.close(); rm(dir);
});

test('[cutover] migration 0013 is registered after 0012; the actual schema: no audit blob, typed columns only (no absent_keys_json, offtype_json or extra_json side column); NO foreign key on any of the eight tables (Q4: the five player references are historical; Q4b: the guardian reference is checked in code; organisation and staff references are historical pointers the routes never checked); every table STRICT with a seq order key and a UNIQUE id; the documented indexes exist; no CHECK narrows a vocabulary the writers leave open', () => {
  assert.deepEqual(DATA_MIGRATIONS.map((m) => m.id).filter((id) => id <= MIGRATION).slice(-2), ['0012_channels', MIGRATION], '0013 is registered after 0012');
  const dir = tempDir('sa-schema'); s7dFile(dir); const s = openRaw(dir); migrate(s);
  assert.ok(applied(s).includes(MIGRATION)); for (const n of COLLECTIONS) assert.equal(s.prepare('SELECT COUNT(*) AS n FROM collections WHERE name = ?').get(n).n, 0, `no ${n} blob`);
  for (const t of Object.values(TABLES)) {
    assert.deepEqual(s.prepare(`PRAGMA foreign_key_list(${t})`).all(), [], `${t}: no foreign key`);
    const sql = s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql; assert.match(sql, /STRICT\s*$/, `${t} STRICT`); assert.match(sql, /seq\s+INTEGER PRIMARY KEY/, `${t} seq`); assert.match(sql, /\bid\s+TEXT NOT NULL UNIQUE/, `${t} unique id`);
    assert.doesNotMatch(sql, /CHECK \((by_kind|severity|provider|status|kind|type|source_system|target_kind) IN/, `${t}: no vocabulary CHECK`);
    assert.deepEqual(s.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).filter((c) => /absent_keys|offtype|extra_json/.test(c)), [], `${t}: no side column`);
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
  const b1 = repo.blocks.append(block({ id: 'blk-a' })); const b2 = repo.blocks.append(block({ id: 'blk-b', futureField: 'dropped' })); assert.equal(b1.id, 'blk-a'); assert.throws(() => { b1.reason = 'x'; }, /written through its domain repository/);
  assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-a', 'blk-b']); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-a', 'blk-b']); assert.deepEqual(plain(b2), block({ id: 'blk-b' }), 'an unknown key is dropped at the repository boundary');
  // A wrong-typed value is refused by name: code, collection, field and id — never the value.
  for (const [field, bad] of [['orgId', { odd: 'SECRET-VALUE' }], ['reason', 42], ['ts', 1.5], ['playerId', ['SECRET-VALUE']]]) assert.throws(() => repo.blocks.append(block({ id: 'blk-odd', [field]: bad })), (e) => e.code === 'AUDIT_RECORD_INVALID' && e.message.includes(`blocks.${field} must be`) && e.message.includes('blk-odd') && !e.message.includes('SECRET-VALUE') && !e.message.includes('42'), `${field}: refused by name`);
  assert.throws(() => repo.reports.append(report({ id: 'rep-odd', urgent: 'yes' })), /reports\.urgent must be a boolean or null/);
  assert.throws(() => repo.blocks.append(block({ id: 'blk-a' })), /blocks: a row with id blk-a already exists/); assert.throws(() => repo.blocks.append({ playerId: 'x' }), /id must be a non-empty string/); assert.throws(() => repo.blocks.append(block({ id: 'blk-fn', reason: () => 1 })), /blocks\.reason must be a string or null \(got a function; id blk-fn\)/);
  assert.throws(() => repo.opsEvents.append(ops({ id: 'ops-fn', detail: { f: () => 1 } })), /opsEvents\.detail\.f \(function\) cannot be stored as JSON/);
  assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-a', 'blk-b'], 'refusals leave the mirror as it was');
  const lifted = repo.blocks.remove('blk-a'); assert.deepEqual(plain(lifted), block({ id: 'blk-a' })); assert.deepEqual(repo.blocks.view.map((b) => b.id), ['blk-b']); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-b']); assert.equal(repo.blocks.remove('blk-none'), null);
  repo.reports.append(report({ id: 'rep-a' })); repo.reports.append(autoReport({ id: 'rep-b' })); repo.reports.append(report({ id: 'rep-c', targetKind: 'player', targetPlayerId: 'pl-nobody' }));
  const held = repo.reports.byId('rep-a'); assert.equal(held.status, 'pending_review');
  assert.deepEqual(plain(repo.reports.patch('rep-a', { status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic outcome.' })), canonRow('reports', report({ id: 'rep-a', status: 'resolved', resolvedAt: NOW, outcome: 'Synthetic outcome.' }))); assert.equal(held.status, 'resolved'); assert.equal(held.resolvedAt, NOW);
  assert.deepEqual(rowsOf(dir, 'reports').map((r) => [r.id, r.status, r.outcome, r.resolved_at]), [['rep-a', 'resolved', 'Synthetic outcome.', NOW], ['rep-b', 'pending_review', null, null], ['rep-c', 'pending_review', null, null]]);
  assert.throws(() => repo.reports.patch('rep-a', { reason: 'rewritten' }), /reports: patch changes status, outcome and resolvedAt only/); assert.throws(() => repo.reports.patch('rep-a', { resolvedAt: 'yesterday' }), (e) => e.code === 'AUDIT_RECORD_INVALID' && /reports\.resolvedAt must be an integer or null/.test(e.message)); assert.equal(held.resolvedAt, NOW, 'a refused patch changes nothing'); assert.throws(() => repo.reports.patch('rep-none', { status: 'resolved' }), /no report rep-none/);
  repo.moderationLog.append(modHit({ id: 'mod-a' })); repo.orgNotes.append(note({ id: 'note-a', playerId: 'pl-nobody' })); repo.ledger.append(led({ id: 'led-a', playerId: 'pl-nobody' })); repo.ledger.append({ id: 'led-b', ts: T, type: 'open_trial_posted', orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', detail: { trialId: 't1' }, extraKey: 'dropped' }); repo.opsEvents.append(ops({ id: 'ops-a', kind: 'backup_refused' }));
  assert.deepEqual(repo.ledger.view.map((l) => l.id), ['led-1', 'led-a', 'led-b']); assert.deepEqual(plain(repo.ledger.view[2]), { id: 'led-b', ts: T, type: 'open_trial_posted', playerId: null, orgId: 'org-pro', orgName: 'Eastport FC', userId: 'usr-1', scoutName: 'Maria', detail: { trialId: 't1' } }, 'every key in the writer\'s order, an absent one null, the unknown one dropped');
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
  repo.reload(); assert.deepEqual(repo.ledger.view.map((l) => l.id), ['led-1', 'led-a', 'led-b']); assert.equal(repo.reports.byId('rep-a').status, 'resolved'); assert.deepEqual(plain(repo.blocks.byId('blk-b')), block({ id: 'blk-b' })); assert.equal(repo.idvQueue.byId('idv-1').status, 'revoked');
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
test('[cutover] snapshot dispatcher: a tool that loads and saves the whole file round-trips all eight collections byte for byte (typed records); an unknown key in a saved row is dropped silently; a wrong-typed value refuses the WHOLE save by name (collection, field, id — never the value); a collection OMITTED leaves its table alone while others are rewritten; an explicit EMPTY array clears a table; a malformed collection (an object) rolls the WHOLE save back — saveSeq and every other collection unchanged; an invalid entry refuses with a text-free diagnostic; the blobs are never recreated; Domain P: a snapshot whose audit rows name players that are absent is ACCEPTED, and an identity-only replacement that REMOVES a player every audit table names is ACCEPTED with every audit row and reference value exactly as before (unresolved references counted, never refused)', () => {
  const dir = tempDir('sa-snap');
  const blobs = { blocks: [block(), block({ id: 'blk-2', orgId: 'org-harbour' })], reports: [report(), autoReport()], moderationLog: [modHit()], orgNotes: [note()], ledger: [led(), led({ id: 'led-2', playerId: 'pl-child1', type: 'shortlist', detail: { x: 1 } })], opsEvents: [ops()], sourceChanges: [srcc()], idvQueue: [idv(), idv({ id: 'idv-2', guardianId: 'gd-signup' })] };
  s7dFile(dir, { blobs }); { const s = openRaw(dir); migrate(s); s.close(); }
  const tool = openStore(dir); const snap = tool.load();
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(snap.db[n]), JSON.stringify(canon(n, blobs[n])), `${n} loaded as typed records`);
  const texts0 = Object.fromEntries(COLLECTIONS.map((n) => [n, JSON.stringify(snap.db[n])]));
  const seq0 = tool.revision(); tool.save(snap); assert.equal(tool.revision(), seq0 + 1);
  const again = tool.load(); for (const n of COLLECTIONS) assert.equal(JSON.stringify(again.db[n]), texts0[n], `${n} round-tripped through replace`);
  assert.equal(again.db.reports[1].targetPlayerId, null, 'the automatic report\'s absent key reads back as null');
  const { ledger: _omit, blocks: _omit2, ...without } = snap.db; tool.save({ ...snap, db: { ...without, vouches: [{ id: 'v-1' }] } });
  assert.deepEqual(idsIn(dir, 'ledger'), ['led-1', 'led-2'], 'an omitted collection leaves its table alone'); assert.deepEqual(idsIn(dir, 'blocks'), ['blk-1', 'blk-2']); for (const n of COLLECTIONS) assert.equal(blobOf(dir, n), null, `no shadow ${n} blob`); assert.equal(JSON.parse(blobOf(dir, 'vouches')).length, 1);
  const beforeDump = dump(tool.sqlite); const seq1 = tool.revision();
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, vouches: [{ id: 'v-x' }], ledger: { id: 'x' } } }), /ledger: the snapshot collection must be an array/);
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the save landed (vouches included)');
  const SECRET = 'SECRET-NOTE-TEXT-77';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, orgNotes: [note({ id: 'note-1', text: SECRET }), note({ id: 'note-1', text: SECRET })] } }), (e) => /SAFETY_AUDIT_IMPORT_BLOCKED/.test(e.message) && /duplicates the id/.test(e.message) && !e.message.includes(SECRET));
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump);
  const SECRET_VALUE = 'SECRET-ORG-VALUE-55';
  assert.throws(() => tool.save({ ...snap, db: { ...snap.db, vouches: [{ id: 'v-x' }], blocks: [block(), block({ id: 'blk-2', orgId: { name: SECRET_VALUE } })] } }), (e) => /SAFETY_AUDIT_IMPORT_BLOCKED/.test(e.message) && /blocks snapshot collection entry #1\.orgId must be a string or null \(got an object; id blk-2\)/.test(e.message) && !e.message.includes(SECRET_VALUE), 'a wrong-typed value is refused by name');
  assert.equal(tool.revision(), seq1); assert.deepEqual(dump(tool.sqlite), beforeDump, 'nothing of the refused save landed');
  tool.save({ ...snap, db: { ...snap.db, ledger: snap.db.ledger.map((l) => ({ ...l, futureField: 'dropped' })) } });
  assert.equal(JSON.stringify(tool.load().db.ledger), texts0.ledger, 'an unknown key is dropped silently: the table holds exactly the typed records');
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

test('[S6b correction F2] a nested OPTIONAL value that JSON cannot carry is stored the way JSON.stringify stores it, never refused: ledger detail { share: undefined } (the Box Cam prefs writer on a partial prefs row) is accepted, the key is ABSENT in the mirror, the file and the export; an undefined array entry becomes null; the same holds for a nested context; a TOP-LEVEL undefined is a NULL column (null in the record); an unknown top-level field is dropped; a nested function, a Map, a BigInt or a cyclic object is still refused by path', () => {
  const dir = tempDir('sa-f2'); s7dFile(dir, { blobs: { reports: [report()] } });
  const L = live(dir); L.save();
  const detail = { by: 'player', share: undefined, retainClips: true };
  const row = L.repo.ledger.append({ ...led({ id: 'led-prefs', type: 'box_prefs_changed', orgId: null, userId: undefined }), detail });
  assert.deepEqual(Object.keys(row.detail), ['by', 'retainClips'], 'the undefined nested key is absent, as JSON would have it'); assert.equal(row.userId, null, 'a top-level undefined is a NULL column');
  assert.equal(JSON.stringify(row), JSON.stringify(canonRow('ledger', { ...led({ id: 'led-prefs', type: 'box_prefs_changed', orgId: null, userId: null }), detail })), 'the mirror is the typed record of what the writer passed');
  L.repo.moderationLog.append(modHit({ id: 'mod-u', context: { kind: 'player_message', channelId: undefined, list: [1, undefined, 3] }, flags: ['email', undefined] }));
  const m = L.repo.moderationLog.byId('mod-u'); assert.deepEqual(plain(m.context), { kind: 'player_message', list: [1, null, 3] }); assert.deepEqual(plain(m.flags), ['email', null]); assert.equal(Object.hasOwn(m.context, 'channelId'), false);
  L.repo.opsEvents.append({ ...ops({ id: 'ops-u' }), futureNested: { a: undefined, b: [undefined] } }); assert.deepEqual(Object.keys(L.repo.opsEvents.byId('ops-u')), KEYS.opsEvents, 'an unknown top-level field is dropped');
  L.repo.reports.patch('rep-1', { outcome: 'x' }); // a patch value that is a plain string (the route's) is unchanged
  for (const [label, bad] of [['a nested function', { f: () => 1 }], ['a nested Map', { m: new Map() }], ['a nested BigInt', { n: 10n }]]) assert.throws(() => L.repo.ledger.append({ ...led({ id: `led-bad-${label}` }), detail: bad }), /ledger\.detail\.[fmn] .*cannot be stored as JSON/, `${label} is still refused`);
  const cyc = { a: 1 }; cyc.self = cyc; assert.throws(() => L.repo.ledger.append({ ...led({ id: 'led-cyc' }), detail: cyc }), /ledger\.detail\.self is cyclic/, 'a cyclic object is still refused (no partial row)');
  assert.equal(L.repo.ledger.byId('led-cyc'), null); assert.equal(L.repo.ledger.byId('led-bad-a nested function'), null);
  L.save();
  const fileRow = rowsOf(dir, 'ledger').find((r) => r.id === 'led-prefs'); assert.equal(fileRow.detail_json, JSON.stringify({ by: 'player', retainClips: true }));
  assert.equal(JSON.stringify(stored(L.store.sqlite).ledger.find((r) => r.id === 'led-prefs')), JSON.stringify(row), 'the file reads back the same row');
  assert.equal(JSON.stringify(L.repo.exportAll().ledger.find((r) => r.id === 'led-prefs')), JSON.stringify(row), 'the export (the admin backup) carries the same row');
  L.close();
  // A restart serves the same row.
  const L2 = live(dir); assert.equal(JSON.stringify(L2.repo.ledger.byId('led-prefs')), JSON.stringify(row)); L2.close();
  rm(dir);
});

console.log(`\n${passed} safety-audit checks passed`);
