// S6b through the REAL server (server.mjs booted as a child process on temporary data
// directories, synthetic seed records only): the eight audit collections as tables —
// every writer through its route (guardian and player blocks, the three report callers
// and the automatic escalation, moderation hits, organisation notes, the ledger, the
// IDV queue, source changes, ops events), every reader (the admin triage, lists and
// counts, the reporters' own lists, the guardian's log, the org ledger and notes, the
// data-layer report), the admin actions (report resolution, the block lift — Q5: the
// row is deleted as today — and the IDV toggle on the FIRST entry), the shapes a route
// stores without checking (a report naming an unknown player, a numeric targetPlayerId,
// a block naming an organisation that does not exist), a REAL adult account deletion
// that retains every audit row with its now-unresolved id — through an unchanged save,
// the admin backup, a restore into a new directory, the copy-only rollback booted by the
// accepted pre-S6b build (SCOUTBOX_PRE_S6B_SERVER) and the re-upgrade — plus the cutover
// itself: migration 0013 recorded at boot, the eight tables with no blob behind them, a
// block and its ledger row durable together in one save, the IDV entry committed with
// the guardian's column (both failure seams, real COMMIT failure, SIGKILL, retry), a
// failed ordinary save keeping the row and landing it once, legacy and unknown shapes
// through the import, and a legacy file whose IDV entry names a missing guardian refused
// at boot (STRICT, Q4b) with the blobs untouched. Every database read goes through a
// second read-only connection. Nothing here touches DATA_DIR or real data. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged 1792fc7 tree before the implementation):
// [compat] tests read the rows through a storage adapter (the tables after the cutover,
// the blobs before it) and PASS on both trees — they are the behaviour the migration
// must preserve; [cutover] tests assert the 0013 record, the tables, the absence of the
// blobs, the rollback tool and the strict boot refusal and FAIL on 1792fc7 on concrete
// assertions.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const MIGRATION = '0013_safety_audit';
const COLLECTIONS = ['blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue'];
const TABLES = { blocks: 'blocks', reports: 'reports', moderationLog: 'moderation_log', orgNotes: 'org_notes', ledger: 'ledger', opsEvents: 'ops_events', sourceChanges: 'source_changes', idvQueue: 'idv_queue' };
/** The column mapping, in the writers' key order: [column, key, kind] — the same mapping repositories/safetyAudit.mjs applies. */
const COLS = {
  blocks: [['id', 'id', 'text'], ['player_id', 'playerId', 'text'], ['org_id', 'orgId', 'text'], ['by_kind', 'by', 'text'], ['reason', 'reason', 'text'], ['created_at', 'ts', 'int']],
  reports: [['id', 'id', 'text'], ['created_at', 'ts', 'int'], ['by_kind', 'by', 'text'], ['by_id', 'byId', 'text'], ['by_org_id', 'byOrgId', 'text'], ['target_kind', 'targetKind', 'text'], ['target_org_id', 'targetOrgId', 'text'], ['target_scout_name', 'targetScoutName', 'text'], ['target_player_id', 'targetPlayerId', 'text'], ['reason', 'reason', 'text'], ['urgent', 'urgent', 'bool'], ['status', 'status', 'text'], ['outcome', 'outcome', 'text'], ['resolved_at', 'resolvedAt', 'int']],
  moderationLog: [['id', 'id', 'text'], ['created_at', 'ts', 'int'], ['context_json', 'context', 'json'], ['flags_json', 'flags', 'json'], ['severity', 'severity', 'text'], ['excerpt', 'excerpt', 'text']],
  orgNotes: [['id', 'id', 'text'], ['org_id', 'orgId', 'text'], ['player_id', 'playerId', 'text'], ['user_id', 'userId', 'text'], ['scout_name', 'scoutName', 'text'], ['text', 'text', 'text'], ['created_at', 'ts', 'int']],
  ledger: [['id', 'id', 'text'], ['occurred_at', 'ts', 'int'], ['type', 'type', 'text'], ['player_id', 'playerId', 'text'], ['org_id', 'orgId', 'text'], ['org_name', 'orgName', 'text'], ['user_id', 'userId', 'text'], ['actor_name', 'scoutName', 'text'], ['detail_json', 'detail', 'json']],
  opsEvents: [['id', 'id', 'text'], ['occurred_at', 'at', 'int'], ['kind', 'kind', 'text'], ['detail_json', 'detail', 'json']],
  sourceChanges: [['id', 'id', 'text'], ['player_id', 'playerId', 'text'], ['type', 'type', 'text'], ['source_system', 'sourceSystem', 'text'], ['source_id', 'sourceId', 'text'], ['occurred_at', 'occurredAt', 'int'], ['detail_json', 'detail', 'json']],
  idvQueue: [['id', 'id', 'text'], ['guardian_id', 'guardianId', 'text'], ['guardian_name', 'guardianName', 'text'], ['document_type', 'documentType', 'text'], ['document_ref_last4', 'documentRef', 'text'], ['provider', 'provider', 'text'], ['reference', 'reference', 'text'], ['created_at', 'ts', 'int'], ['status', 'status', 'text']],
};
const KEYS = Object.fromEntries(Object.entries(COLS).map(([n, cols]) => [n, cols.map((c) => c[1])]));

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(proc); proc.on('exit', () => children.delete(proc));
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let parsed = null; try { parsed = JSON.parse(text); } catch { /* no body */ }
      return { status: r.status, body: parsed, text };
    };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}): ${log.slice(-1500)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000);
  });
}
/** A boot expected to FAIL: resolves with { code, log } once the child exited. */
async function bootRefused(dir, env = {}) {
  const port = await freePort();
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(proc); let log = '';
    proc.stdout.on('data', (d) => { log += d; }); proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code) => { children.delete(proc); resolve({ code, log }); });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 30_000);
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
const seqOf = (dir) => Number(q1(dir, "SELECT value FROM meta WHERE key = 'saveSeq'")?.value) || 0;
const blobRows = (c, name) => { const r = c.get('SELECT value FROM collections WHERE name = ?', name); return r ? JSON.parse(r.value) : null; };
const setOwn = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
/** Unknown own fields first, then the literal's present keys in the writer's order (the export convention). */
const ordered = (row, keys) => { const o = {}; for (const k of Object.keys(row)) if (!keys.includes(k)) setOwn(o, k, row[k]); for (const k of keys) if (Object.hasOwn(row, k)) o[k] = row[k]; return o; };
/**
 * The rows as the DATABASE holds them, in insertion order and in the legacy (export)
 * shape: the table after the cutover, the blob before it — so a check reads the same
 * way on both builds. Absent keys stay absent (absent_keys_json); values of a known
 * key that were not the column's type come back from offtype_json; unknown fields come
 * back from extra_json, first.
 */
function readStored(c, name) {
  if (!c.get('SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION)) return (blobRows(c, name) ?? []).map((r) => ordered(r, KEYS[name]));
  return c.all(`SELECT * FROM ${TABLES[name]} ORDER BY seq`).map((r) => {
    const extra = r.extra_json ? JSON.parse(r.extra_json) : {}; const absent = r.absent_keys_json ? JSON.parse(r.absent_keys_json) : []; const off = r.offtype_json ? JSON.parse(r.offtype_json) : {};
    const row = {}; for (const k of Object.keys(extra)) setOwn(row, k, extra[k]);
    for (const [col, key, kind] of COLS[name]) {
      if (absent.includes(key)) continue;
      if (Object.hasOwn(off, key)) { row[key] = off[key]; continue; }
      const v = r[col];
      row[key] = v === null ? null : kind === 'bool' ? v === 1 : kind === 'json' ? JSON.parse(v) : v;
    }
    return row;
  });
}
const stored = (dir, name) => snap(dir, (c) => readStored(c, name));
const storedAll = (dir) => Object.fromEntries(COLLECTIONS.map((n) => [n, stored(dir, n)]));
const canon = (name, rows) => rows.map((r) => ordered(r, KEYS[name]));

const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
const signupGuardian = async (S, name, email) => { const r = await S.j('POST', '/auth/guardian/signup', { name, email, password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: r.body.guardianId, code: r.body.devEmailCode })).status, 200); return { gid: r.body.guardianId, token: r.body.token }; };
const adminReports = async (S) => (await S.j('GET', '/admin/reports', undefined, null, A)).body;
const adminBlocks = async (S) => (await S.j('GET', '/admin/blocks', undefined, null, A)).body;
const adminModeration = async (S) => (await S.j('GET', '/admin/moderation', undefined, null, A)).body;
const adminIdv = async (S) => (await S.j('GET', '/admin/guardians', undefined, null, A)).body.idvQueue;
const orgLedger = async (S, token) => (await S.j('GET', '/org/ledger', undefined, token)).body;
const orgNotesOf = async (S, token, pid) => (await S.j('GET', `/org/players/${pid}`, undefined, token)).body.orgNotes;
const count = (text, re) => (text.match(re) ?? []).length;
const waitForLog = async (S, re, above) => { for (let i = 0; i < 80 && count(S.log(), re) <= above; i++) await sleep(25); return count(S.log(), re) > above; };
/** The whole audit state the admin and the owners see, in one object (what a restart, a restore, a rollback and a re-upgrade must reproduce). */
async function audited(S, maria) {
  return { reports: await adminReports(S), blocks: await adminBlocks(S), moderation: await adminModeration(S), idv: await adminIdv(S), ledger: await orgLedger(S, maria) };
}

// ============================================================= [compat] the behaviour the storage move must preserve
await test('[compat] every writer through its route and every reader: a guardian\'s block and report (urgent → the suspension block and the frozen request), an adult\'s block naming an organisation that does not exist and reports naming an unknown player and a NUMERIC targetPlayerId (accepted and stored as received), an organisation\'s report and private note, two moderation hits (a contact hit; a grooming hit that escalates to an automatic urgent report with no targetPlayerId key), the IDV entry, a source change, a backup ops event, the ledger rows the blocks write; the admin triage order, the reporters\' own lists, the guardian\'s log, the org ledger, the data; report resolution, the block lift (Q5: the row is deleted and returned once), the IDV toggle (the FIRST entry); the stored rows equal the views; a restart serves the same', async () => {
  const dir = tempDir('s6b-compat'); let S = await boot(dir);
  const maria = await orgLogin(S); const amara = await guardianLogin(S, 'gd-amara'); const { pid, token: adult } = await signupAdult(S, 'Audit Adult');
  // Guardian: a block of the child, then an urgent report against the club that suspends the pending request.
  const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic contact request for the child.' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', '/guardian/block', { orgId: 'org-harbour', playerId: 'pl-guni', reason: 'synthetic guardian block' }, amara)).status, 201);
  const gRep = await S.j('POST', '/guardian/report', { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic urgent guardian report.', urgent: true }, amara); assert.equal(gRep.status, 201, gRep.text); assert.equal(gRep.body.suspended, true);
  assert.equal((await S.j('GET', '/guardian/inbox', undefined, amara)).body.find((r) => r.id === req.body.requestId)?.status, 'suspended', 'the pending request froze with the suspension block');
  // Adult: a block naming an organisation that does not exist (the route checks truthiness only), reports naming an unknown player and a numeric id (handleReport stores what it received).
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-does-not-exist', reason: 'synthetic' }, adult)).status, 201, 'a block naming an unknown organisation is accepted, as before');
  const pRep1 = await S.j('POST', '/player/report', { targetKind: 'player', targetPlayerId: 'pl-nobody', reason: 'Synthetic report naming an unknown player.' }, adult); assert.equal(pRep1.status, 201, pRep1.text);
  const pRep2 = await S.j('POST', '/player/report', { targetKind: 'scout', targetScoutName: 'Synthetic Scout', targetPlayerId: 123, reason: 'Synthetic report with a numeric id.' }, adult); assert.equal(pRep2.status, 201, pRep2.text);
  // Org: a report and a private note on the adult.
  const oRep = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic org report.' }, maria); assert.equal(oRep.status, 201, oRep.text);
  const noteRes = await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic private note.' }, maria); assert.equal(noteRes.status, 201, noteRes.text); assert.deepEqual(Object.keys(noteRes.body), ['id', 'orgId', 'playerId', 'userId', 'scoutName', 'text', 'ts']);
  // Moderation: a contact hit, then a grooming hit that escalates.
  const hit1 = await S.j('POST', '/player/timeline', { year: 2026, event: 'Call me on +44 7700 900123 please' }, adult); assert.equal(hit1.status, 400); assert.equal(hit1.body.error, 'MODERATION_BLOCKED');
  const hit2 = await S.j('POST', '/player/timeline', { year: 2026, event: 'keep this a secret from everyone' }, adult); assert.equal(hit2.status, 400);
  // IDV: a new guardian verifies twice (two entries; the toggle acts on the first).
  const { gid, token: gtok } = await signupGuardian(S, 'Audit Parent', 'audit-parent@example.test');
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, gtok)).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'licence', documentRef: 'L7654321' }, gtok)).status, 200);
  // A source change (the passport primary position) and an ops event (the backup).
  const prefs = await S.j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'ST', secondary: [] } }, adult); assert.equal(prefs.status, 200, prefs.text);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  // The views.
  const reports = await adminReports(S);
  const rank = (r) => (r.status === 'pending_review' ? (r.urgent ? 0 : 1) : 2);
  assert.ok(reports.every((r, i) => i === 0 || rank(reports[i - 1]) <= rank(r)), 'triage order: urgent pending first'); assert.equal(reports.length, 5);
  const auto = reports.find((r) => r.by === 'system'); assert.ok(auto, 'the grooming hit escalated'); assert.equal(auto.urgent, true); assert.equal(Object.hasOwn(auto, 'targetPlayerId'), false, 'the automatic report has no targetPlayerId key'); assert.equal(auto.targetKind, 'player'); assert.equal(auto.targetOrgId, null);
  assert.equal(reports.find((r) => r.id === pRep1.body.reportId).targetPlayerId, 'pl-nobody'); assert.equal(reports.find((r) => r.id === pRep2.body.reportId).targetPlayerId, 123, 'the numeric id is served as received'); assert.equal(reports.find((r) => r.id === oRep.body.reportId).byOrgId, 'org-eastport');
  assert.deepEqual((await S.j('GET', '/player/reports', undefined, adult)).body.map((r) => r.id), [pRep2.body.reportId, pRep1.body.reportId], 'the reporter\'s own list, newest first'); assert.deepEqual((await S.j('GET', '/guardian/reports', undefined, amara)).body.map((r) => r.id), [gRep.body.reportId]); assert.deepEqual((await S.j('GET', '/org/reports', undefined, maria)).body.map((r) => r.id), [oRep.body.reportId]);
  const blocks = await adminBlocks(S); assert.deepEqual(blocks.map((b) => [b.playerId, b.orgId, b.by, b.reason]), [[pid, 'org-does-not-exist', 'player', 'synthetic'], ['pl-guni', 'org-eastport', 'guardian', 'suspended_pending_review'], ['pl-guni', 'org-harbour', 'guardian', 'synthetic guardian block']], 'newest first');
  const moderation = await adminModeration(S); assert.deepEqual(moderation.map((m) => [m.severity, m.flags, m.context.kind, m.context.playerId]), [['grooming', ['secrecy'], 'timeline_event', pid], ['contact', ['phone_number'], 'timeline_event', pid]]); assert.equal(moderation[1].excerpt, 'Call me on +44 7700 900123 please');
  const idvRows = await adminIdv(S); assert.deepEqual(idvRows.filter((q) => q.guardianId === gid).map((q) => [q.documentType, q.documentRef, q.provider, q.status]), [['passport', '4567', 'dev-attestation', 'approved'], ['licence', '4321', 'dev-attestation', 'approved']]);
  const ledger = await orgLedger(S, maria); assert.ok(ledger.some((l) => l.type === 'org_blocked_by_guardian' && l.playerId === 'pl-guni' && l.orgId === 'org-harbour') === false, 'the guardian block of ANOTHER club is not in this club\'s ledger'); assert.ok((await S.j('GET', '/guardian/log', undefined, amara)).body.some((l) => l.type === 'org_blocked_by_guardian' && l.playerId === 'pl-guni'), 'the guardian\'s log carries the block row');
  assert.deepEqual((await orgNotesOf(S, maria, pid)).map((n) => n.text), ['Synthetic private note.']);
  assert.ok((await S.j('GET', '/player/export', undefined, adult)).body.ledgerEvents.some((l) => l.type === 'org_blocked_by_player'));
  const overview = (await S.j('GET', '/admin/overview', undefined, null, A)).body; assert.equal(overview.openReports, 5); assert.equal(overview.blocks, 3); assert.equal(overview.moderationHits, 2); assert.equal(overview.groomingEscalations, 1);
  const metrics = (await S.j('GET', '/admin/metrics', undefined, null, A)).body; assert.ok(metrics.opsEvents.some((e) => e.kind === 'backup_created'), 'the backup ops event');
  const sc = stored(dir, 'sourceChanges'); assert.deepEqual(sc.map((c) => [c.playerId, c.type, c.sourceSystem, c.detail]), [[pid, 'position_changed', 'passport_prefs', { from: null, to: 'ST', submittedBy: 'player' }]]);
  // Admin actions: resolve, lift (Q5), toggle (first entry).
  const resolved = await S.j('POST', `/admin/reports/${gRep.body.reportId}/resolve`, { outcome: 'Synthetic outcome.', action: 'dismiss' }, null, A); assert.equal(resolved.status, 200, resolved.text);
  assert.equal((await S.j('POST', `/admin/reports/${gRep.body.reportId}/resolve`, { outcome: 'again' }, null, A)).status, 409, 'ALREADY_RESOLVED');
  const toLift = blocks[0]; const lift = await S.j('POST', `/admin/blocks/${toLift.id}/lift`, {}, null, A); assert.equal(lift.status, 200, lift.text); assert.deepEqual(lift.body, { lifted: toLift }, 'the lifted row is returned once'); assert.equal((await adminBlocks(S)).some((b) => b.id === toLift.id), false, 'and exists nowhere afterwards (Q5)'); assert.equal((await S.j('POST', `/admin/blocks/${toLift.id}/lift`, {}, null, A)).status, 404);
  const toggled = await S.j('POST', `/admin/guardians/${gid}/idv`, { approved: false }, null, A); assert.equal(toggled.status, 200, toggled.text); assert.equal(toggled.body.idVerified, false);
  assert.deepEqual((await adminIdv(S)).filter((q) => q.guardianId === gid).map((q) => q.status), ['revoked', 'approved'], 'the FIRST entry flipped, the later one kept (today\'s rule)');
  // The stored rows equal the views (newest-first lists reversed), key for key.
  const all = await audited(S, maria);
  assert.deepEqual(stored(dir, 'reports').map((r) => r.id), all.reports.slice().sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)).map((r) => r.id).sort(), 'the same report ids are stored');
  assert.equal(JSON.stringify(stored(dir, 'blocks').slice().reverse()), JSON.stringify(canon('blocks', all.blocks)), 'the stored blocks equal the admin list, key for key');
  assert.equal(JSON.stringify(stored(dir, 'moderationLog').slice().reverse()), JSON.stringify(canon('moderationLog', all.moderation)));
  assert.equal(JSON.stringify(stored(dir, 'idvQueue')), JSON.stringify(canon('idvQueue', all.idv)));
  assert.equal(JSON.stringify(stored(dir, 'reports').find((r) => r.id === gRep.body.reportId)), JSON.stringify(ordered(all.reports.find((r) => r.id === gRep.body.reportId), KEYS.reports)), 'the resolved report, resolution fields included');
  assert.equal(stored(dir, 'reports').find((r) => r.id === pRep2.body.reportId).targetPlayerId, 123, 'the numeric id is stored as received');
  assert.equal(JSON.stringify(stored(dir, 'ledger').filter((l) => l.orgId === 'org-eastport').slice().reverse()), JSON.stringify(canon('ledger', all.ledger)), 'the org ledger equals the stored rows');
  // A restart serves the same.
  await S.stop(); S = await boot(dir); const maria2 = await orgLogin(S);
  assert.deepEqual(await audited(S, maria2), all, 'the restart serves the same rows');
  assert.deepEqual((await orgNotesOf(S, maria2, pid)).map((n) => n.text), ['Synthetic private note.']);
  await S.stop(); rm(dir, bk.body.dir);
});

await test('[compat] a REAL adult account deletion retains every audit row that names the person, with its now-unresolved id, as today: the ledger, report, note, block and source-change rows survive DELETE /player/account; an unchanged save succeeds afterwards (the admin backup\'s persistNow); the backup carries the rows; a restore into a NEW directory imports them row for row; the copy-only rollback copy boots on the accepted pre-S6b build (SCOUTBOX_PRE_S6B_SERVER) with the same rows in its routes and accepts a new block and a new report there; this build re-upgrades the copy with those writes; a report naming an unknown player stays accepted throughout', async () => {
  const dir = tempDir('s6b-deletion'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token: adult } = await signupAdult(S, 'Deleted Adult');
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adult)).status, 201);
  const byThem = await S.j('POST', '/player/report', { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic report by the adult.' }, adult); assert.equal(byThem.status, 201);
  const aboutThem = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic report about the adult.' }, maria); assert.equal(aboutThem.status, 201);
  assert.equal((await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic note about the adult.' }, maria)).status, 201);
  assert.equal((await S.j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'CM', secondary: [] } }, adult)).status, 200);
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 200, 'the club reads the adult before the deletion');
  const bkBefore = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bkBefore.status, 201); // flushes every pending write
  const before = storedAll(dir);
  const naming = (rows) => rows.filter((r) => r.playerId === pid || r.targetPlayerId === pid);
  assert.deepEqual([naming(before.blocks).length, naming(before.reports).length, naming(before.orgNotes).length, naming(before.ledger).length >= 1, naming(before.sourceChanges).length], [1, 1, 1, true, 1], 'rows in all five player-audit tables name the adult');
  const del = await S.j('DELETE', '/player/account', {}, adult); assert.equal(del.status, 200, del.text);
  assert.equal(q1(dir, 'SELECT 1 AS one FROM players WHERE id = ?', pid), undefined, 'the player row is gone (today\'s hard delete)');
  const after = storedAll(dir);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(after[n]), JSON.stringify(before[n]), `${n}: every row exactly as before the deletion (the id now resolves to nothing)`);
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 404);
  assert.ok((await adminReports(S)).some((r) => r.targetPlayerId === pid), 'the admin still lists the report about the deleted person');
  // An unchanged save succeeds (the backup flushes) and the backup carries the rows.
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, `an unchanged save after the deletion succeeds: ${bk.text}`);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(canon(n, snapshot.db[n])), JSON.stringify(after[n]), `the backup's ${n} equals the stored rows`);
  const unknown = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: 'pl-never-existed', reason: 'Synthetic report naming an unknown player.' }, maria); assert.equal(unknown.status, 201, 'a report naming an unknown player stays accepted');
  const seqBeforeIdle = seqOf(dir); await sleep(2600); assert.ok(seqOf(dir) >= seqBeforeIdle, 'the debounced save after the report did not fail'); assert.ok(stored(dir, 'reports').some((r) => r.targetPlayerId === 'pl-never-existed'), 'and landed');
  await S.stop();
  // A restore into a new directory.
  const restored = tempDir('s6b-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); const mariaR = await orgLogin(S);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(restored, n)), JSON.stringify(after[n]), `the restore reproduced ${n} row for row`);
  assert.ok((await adminReports(S)).some((r) => r.targetPlayerId === pid)); assert.ok((await orgLedger(S, mariaR)).some((l) => l.playerId === pid), 'the org ledger still carries the deleted person\'s id');
  await S.stop();
  // The copy-only rollback and the accepted build.
  const copy = tempDir('s6b-copy');
  const OLD = process.env.SCOUTBOX_PRE_S6B_SERVER;
  let rolled = null;
  try { rolled = execFileSync(process.execPath, [path.join(HERE, 'safetyAuditRollback.mjs'), dir, copy], { encoding: 'utf8' }); } catch (e) { rolled = null; }
  if (rolled === null) { console.log('    (scripts/safetyAuditRollback.mjs is not on this tree: the rollback copy was not produced — expected on the unchanged 1792fc7 tree)'); }
  else {
    const final = storedAll(dir);
    for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(copy, n)), JSON.stringify(final[n]), `the rollback copy's ${n} blob holds every row in order`);
    if (OLD && fs.existsSync(OLD)) {
      const old = await boot(copy, {}, OLD); const oldMaria = await orgLogin(old);
      assert.ok(!/0013_safety_audit/.test(old.log()), 'the accepted build knows nothing of 0013');
      assert.ok((await adminReports(old)).some((r) => r.targetPlayerId === pid), 'the old build lists the report about the deleted person'); assert.ok((await orgLedger(old, oldMaria)).some((l) => l.playerId === pid));
      assert.deepEqual((await adminBlocks(old)).map((b) => b.id), final.blocks.slice().reverse().map((b) => b.id), 'the old build lists the same blocks');
      const { token: oldAdult, pid: oldPid } = await signupAdult(old, 'Old Build Adult');
      assert.equal((await old.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'from the old build' }, oldAdult)).status, 201);
      const oldRep = await old.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: oldPid, reason: 'Synthetic report from the old build.' }, oldMaria); assert.equal(oldRep.status, 201);
      await old.stop();
      assert.ok(snap(copy, (c) => (blobRows(c, 'blocks') ?? [])).some((b) => b.reason === 'from the old build'), 'the old build kept writing to its blobs');
      console.log('    (pre-S6b build booted the rollback copy: same rows, a new block and a new report accepted)');
      const re = await boot(copy); assert.ok(live(copy), 'this build re-upgraded the copy');
      const reBlocks = await adminBlocks(re); assert.ok(reBlocks.some((b) => b.reason === 'from the old build'), 'the old build\'s block is in the tables'); assert.ok((await adminReports(re)).some((r) => r.id === oldRep.body.reportId));
      await re.stop();
    } else {
      console.log('    (SCOUTBOX_PRE_S6B_SERVER not set: the pre-S6b boot of the rollback copy was not exercised here)');
    }
  }
  rm(dir, bkBefore.body.dir, bk.body.dir, restored, copy);
});

// ============================================================= [cutover] the tables, the save points, the strict reference at boot
await test('[cutover] the cutover and the save points: a fresh boot records 0013_safety_audit after 0012 and creates the eight tables with no blob behind them (the data layer reports the domain); a player\'s block and its ledger row land together in ONE revision with the next save; the IDV entry commits with the guardian\'s column before the 200 — both failure seams and the real COMMIT leave nothing, the retry lands, a SIGKILL right after the response loses nothing, a restart serves it; a failed ordinary save at the REAL COMMIT keeps a report in memory and lands it ONCE with the next save; the block lift is durable in its route\'s save', async () => {
  const dir = tempDir('s6b-cutover'); let S = await boot(dir, { M13_FAST_RETRY: '' });
  assert.ok(live(dir), 'the boot recorded 0013'); // fails on 1792fc7: no such record
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id FROM data_migrations ORDER BY applied_at, id').map((r) => r.id).slice(-2)), ['0012_channels', MIGRATION]);
  for (const t of Object.values(TABLES)) assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  assert.equal(q1(dir, `SELECT COUNT(*) AS n FROM collections WHERE name IN (${COLLECTIONS.map((n) => `'${n}'`).join(', ')})`).n, 0, 'no audit blob');
  const cap = (await S.j('GET', '/capabilities')).body; const domains = cap?.persistence?.dataLayer?.domains ?? cap?.dataLayer?.domains ?? {}; assert.ok(domains.safetyAudit, `the data layer reports the safetyAudit domain (${Object.keys(domains).join(', ')})`);
  // A block and its ledger row: one save, one revision.
  const { pid, token: adult } = await signupAdult(S, 'Cutover Adult');
  const seq0 = seqOf(dir);
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adult)).status, 201); // not org-eastport: its user writes the note below, and a blocked organisation reads the player as absent
  assert.ok(await until(async () => q1(dir, 'SELECT 1 AS one FROM blocks WHERE player_id = ?', pid), 8000), 'the block lands with the next save');
  const landed = snap(dir, (c) => ({ seq: Number(c.get("SELECT value FROM meta WHERE key = 'saveSeq'").value), block: c.get('SELECT org_id, reason FROM blocks WHERE player_id = ?', pid), ledger: c.all('SELECT type FROM ledger WHERE player_id = ? AND type = ?', pid, 'org_blocked_by_player') }));
  assert.equal(landed.seq, seq0 + 1, 'one revision'); assert.deepEqual(landed.block, { org_id: 'org-harbour', reason: 'synthetic' }); assert.equal(landed.ledger.length, 1, 'the ledger row landed in the same save');
  // The IDV unit: the column and the entry together (both seams, the real COMMIT, SIGKILL, restart).
  const { gid, token: gtok } = await signupGuardian(S, 'Cutover Parent', 'cutover-parent@example.test');
  const dbState = () => ({ idVerified: q1(dir, 'SELECT id_verified AS v FROM guardians WHERE id = ?', gid).v, audit: snap(dir, (c) => c.all('SELECT status FROM idv_queue WHERE guardian_id = ? ORDER BY seq', gid)).map((r) => r.status) });
  const view = async (X) => { const me = (await X.j('GET', '/guardian/me', undefined, gtok)).body; return [me.idVerified, (await adminIdv(X)).filter((e) => e.guardianId === gid).map((e) => e.status)]; };
  const act = () => S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, gtok);
  const unchanged = async (label) => { assert.deepEqual(dbState(), { idVerified: 0, audit: [] }, `${label}: nothing in the database`); assert.deepEqual(await view(S), [false, []], `${label}: memory restored`); };
  for (const [rule, re] of [['internal:guardian.verify_id.after_row', /simulated failure at guardian\.verify_id\.after_row/g], ['internal:unit.sqlite_commit', /FOREIGN KEY constraint failed/g]]) {
    assert.equal((await S.j('POST', '/__faults', { rules: rule })).status, 200); const before = count(S.log(), re);
    const r = await act(); assert.equal(r.status, 500, `${rule}: not answered as success (${r.text})`); assert.ok(await waitForLog(S, re, before), `${rule}: the failure really happened`);
    await unchanged(`after ${rule}`); assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  }
  const ok = await act(); assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(dbState(), { idVerified: 1, audit: ['approved'] }, 'the column and the entry are committed when the response is sent'); assert.deepEqual(await view(S), [true, ['approved']]);
  await S.kill(); assert.deepEqual(dbState(), { idVerified: 1, audit: ['approved'] }, 'a SIGKILL right after the response loses nothing');
  S = await boot(dir, { M13_FAST_RETRY: '' }); assert.deepEqual(await view(S), [true, ['approved']], 'a restart serves the committed state');
  // A failed ordinary save at the REAL COMMIT: the report stays in memory and lands once.
  const maria = await orgLogin(S); const logBefore = S.log().length; const seqR = seqOf(dir);
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:save.sqlite_commit:1' })).status, 200);
  const rep = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic report whose save fails at COMMIT.' }, maria); assert.equal(rep.status, 201, 'the route answers although its save fails');
  assert.ok(await until(async () => /snapshot save failed: FOREIGN KEY constraint failed/.test(S.log().slice(logBefore)), 8000), 'the save failed at the real COMMIT');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  assert.equal(q1(dir, 'SELECT 1 AS one FROM reports WHERE id = ?', rep.body.reportId), undefined, 'the report did not land'); assert.equal(seqOf(dir), seqR);
  assert.ok((await adminReports(S)).some((r) => r.id === rep.body.reportId), 'memory is the intended state');
  const note = await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic note that carries the next save.' }, maria); assert.equal(note.status, 201);
  assert.ok(await until(async () => q1(dir, 'SELECT 1 AS one FROM reports WHERE id = ?', rep.body.reportId), 8000), 'the next save landed the report');
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM reports WHERE id = ?', rep.body.reportId).n, 1, 'once'); assert.ok(q1(dir, 'SELECT 1 AS one FROM org_notes WHERE id = ?', note.body.id));
  // The block lift (Q5) is durable in its route's save.
  const blockId = (await adminBlocks(S)).find((b) => b.playerId === pid).id;
  assert.equal((await S.j('POST', `/admin/blocks/${blockId}/lift`, {}, null, A)).status, 200);
  assert.ok(await until(async () => !q1(dir, 'SELECT 1 AS one FROM blocks WHERE id = ?', blockId), 8000), 'the lifted block row is deleted in the file');
  await S.stop(); rm(dir);
});

await test('[cutover] legacy and unknown shapes through the import, the admin backup, a restore, the S7d tool\'s refusal, and the STRICT boot refusal: a rollback copy edited by hand (unknown fields at row and nested level, an absent key, an object orgId, a numeric targetPlayerId, a ledger row naming a player that never existed, a backup_refused ops event) is imported row for row by this build and served unchanged; the backup equals the stored rows and a restore imports them again; the S7d tool refuses the 0013 file; a copy whose IDV entry names a guardian that does not exist refuses the WHOLE boot (IDV_GUARDIAN_MISSING: ids only), records nothing and leaves every blob as it was', async () => {
  const dir = tempDir('s6b-legacy'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token: adult } = await signupAdult(S, 'Legacy Adult');
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'synthetic' }, adult)).status, 201);
  assert.equal((await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic.' }, maria)).status, 201);
  const { gid, token: gtok } = await signupGuardian(S, 'Legacy Parent', 'legacy-parent@example.test'); assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, gtok)).status, 200);
  assert.equal((await S.j('POST', '/admin/backup', {}, null, A)).status, 201); // flushes
  const original = storedAll(dir);
  await S.stop();
  // The S7d tool refuses the 0013 file.
  try { execFileSync(process.execPath, [path.join(HERE, 'channelsRollback.mjs'), dir, tempDir('s6b-s7dtool')], { stdio: 'pipe' }); assert.fail('the S7d tool must refuse a 0013 file'); } catch (e) { assert.equal(e.status, 4, String(e.stderr)); }
  // The rollback copy, edited by hand.
  const copy = tempDir('s6b-copy'); const out = execFileSync(process.execPath, [path.join(HERE, 'safetyAuditRollback.mjs'), dir, copy], { encoding: 'utf8' }); assert.match(out, /written back/); assert.equal(live(copy), false);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(copy, n)), JSON.stringify(original[n]), `the copy's ${n} blob`);
  const SECRET = 'SECRET-LEGACY-MARKER-55';
  { const s = new DatabaseSync(path.join(copy, 'scoutbox.db'));
    const edit = (name, fn) => { const rows = JSON.parse(s.prepare('SELECT value FROM collections WHERE name = ?').get(name).value); fn(rows); s.prepare('UPDATE collections SET value = ? WHERE name = ?').run(JSON.stringify(rows), name); };
    edit('blocks', (rows) => { rows[0].futureBlockField = { nested: [SECRET] }; rows.push({ id: 'blk-legacy', playerId: 'pl-never-existed', orgId: { odd: 'object' }, by: 'player', reason: 7, ts: 1 }); });
    edit('reports', (rows) => { delete rows[0].targetScoutName; rows.push({ id: 'rep-legacy', ts: 2, by: 'player', byId: pid, targetKind: 'player', targetOrgId: null, targetScoutName: null, targetPlayerId: 123, reason: 'Synthetic legacy report.', urgent: false, status: 'pending_review', outcome: null, resolvedAt: null }); });
    edit('ledger', (rows) => { rows.push({ id: 'led-legacy', ts: 3, type: 'view', playerId: 'pl-never-existed', orgId: 'org-eastport', orgName: 'Eastport FC', userId: 'usr-legacy', scoutName: 'Legacy Scout', futureLedgerField: true }); });
    edit('opsEvents', (rows) => { rows.push({ id: 'ops-legacy', at: 4, kind: 'backup_refused', detail: { dir: 'x', error: 'MEDIA_QUEUE_OWNERSHIP_CONFLICT', conflicts: [] } }); });
    edit('moderationLog', (rows) => { rows.push({ id: 'mod-legacy', ts: 5, context: { kind: 'org_message', channelId: 'chan-x', futureContextField: 1 }, flags: ['url'], severity: 'contact', excerpt: 'synthetic excerpt' }); });
    s.close(); }
  const legacy = Object.fromEntries(COLLECTIONS.map((n) => [n, canon(n, stored(copy, n))]));
  // This build imports the hand-edited copy.
  const up = tempDir('s6b-up'); fs.cpSync(copy, up, { recursive: true });
  S = await boot(up); assert.ok(live(up), 'imported through 0013');
  assert.equal(q1(up, `SELECT COUNT(*) AS n FROM collections WHERE name IN (${COLLECTIONS.map((n) => `'${n}'`).join(', ')})`).n, 0, 'the blobs are retired');
  const record = JSON.parse(q1(up, "SELECT value FROM meta WHERE key = 'safetyAuditCutover'").value); assert.equal(record.blocks.withExtraFields, 1); assert.equal(record.blocks.withOfftypeValues, 1); assert.equal(record.reports.withOfftypeValues, 1); assert.equal(record.ledger.unresolvedPlayerIds, 1); assert.equal(record.blocks.unresolvedPlayerIds, 1); assert.doesNotMatch(JSON.stringify(record) + S.log(), new RegExp(SECRET), 'never a text');
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(up, n)), JSON.stringify(legacy[n]), `${n}: the tables read back the legacy blob exactly (extras first, absence preserved, odd values restored)`);
  const blocks = await adminBlocks(S); assert.deepEqual(blocks[0].orgId, { odd: 'object' }); assert.equal(blocks[0].reason, 7); assert.deepEqual(blocks[1].futureBlockField, { nested: [SECRET] });
  const reports = await adminReports(S); assert.equal(reports.find((r) => r.id === 'rep-legacy').targetPlayerId, 123); assert.equal(Object.hasOwn(reports.find((r) => r.id !== 'rep-legacy'), 'targetScoutName'), false, 'the absent key stays absent in the view');
  assert.ok((await adminModeration(S)).some((m) => m.context.futureContextField === 1)); assert.ok((await S.j('GET', '/admin/metrics', undefined, null, A)).body.opsEvents.some((e) => e.kind === 'backup_refused'));
  // The admin backup carries the legacy and unknown fields exactly; a restore imports them again.
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  // The backup's own `backup_created` event is appended AFTER the file is written (as every build did), so it is the one stored row the file cannot hold.
  const storedAtBackup = (n) => { const rows = stored(up, n); if (n !== 'opsEvents') return rows; const last = rows.at(-1); assert.equal(last?.kind, 'backup_created'); assert.equal(last.detail?.dir, path.basename(bk.body.dir)); return rows.slice(0, -1); };
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(snapshot.db[n]), JSON.stringify(storedAtBackup(n)), `the backup's ${n} equals the stored rows exactly`);
  await S.stop();
  const restored = tempDir('s6b-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored)); for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(restored, n)), JSON.stringify(snapshot.db[n]), `row for row: ${n}`);
  await S.stop();
  // STRICT (Q4b): a legacy file whose IDV entry names a missing guardian refuses the whole boot.
  const strict = tempDir('s6b-strict'); fs.cpSync(copy, strict, { recursive: true });
  { const s = new DatabaseSync(path.join(strict, 'scoutbox.db')); const rows = JSON.parse(s.prepare("SELECT value FROM collections WHERE name = 'idvQueue'").get().value); rows.push({ ...rows[0], id: 'idv-orphan', guardianId: 'gd-never-existed' }); s.prepare("UPDATE collections SET value = ? WHERE name = 'idvQueue'").run(JSON.stringify(rows)); s.close(); }
  const blobsBefore = snap(strict, (c) => COLLECTIONS.map((n) => c.get('SELECT value FROM collections WHERE name = ?', n)?.value ?? null)); const seqBefore = seqOf(strict);
  const refused = await bootRefused(strict);
  assert.notEqual(refused.code, 0, 'the boot refused'); assert.match(refused.log, /SAFETY_AUDIT_IMPORT_BLOCKED/); assert.match(refused.log, /IDV_GUARDIAN_MISSING[^\n]*idv-orphan/); assert.doesNotMatch(refused.log, /Legacy Parent|P1234567|4567/, 'ids only');
  assert.equal(live(strict), false, 'nothing recorded'); assert.equal(q1(strict, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'idv_queue'"), undefined, 'no table');
  assert.deepEqual(snap(strict, (c) => COLLECTIONS.map((n) => c.get('SELECT value FROM collections WHERE name = ?', n)?.value ?? null)), blobsBefore, 'every blob as it was'); assert.equal(seqOf(strict), seqBefore);
  void gid;
  rm(dir, copy, up, bk.body.dir, restored, strict);
});

console.log(`\n${passed} safety-audit server checks passed`);
