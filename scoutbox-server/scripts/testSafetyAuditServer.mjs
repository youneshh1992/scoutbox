// The eight audit collections through the REAL server (server.mjs booted as a child process on temporary data
// directories, synthetic seed records only): every writer and reader through its route, the admin actions (the block
// lift deletes the row: Q5), a report naming an unknown player stored without a lookup (Q4), the junk the routes
// refuse, an account deletion that retains every audit row with its now-unresolved id, the coupled units (a block and
// its ledger row, the IDV entry and the guardian's column, an urgent report and its suspension block) under failure
// seams, real COMMIT failures and SIGKILL, and backup/restore. Every database read goes through a second read-only
// connection. Nothing here touches DATA_DIR or real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { createSafetyAuditRepository } from '../repositories/safetyAudit.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000, step = 40) => { const t0 = Date.now(); for (;;) { const v = await check(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const MIGRATION = '0013_safety_audit';
const COLLECTIONS = ['blocks', 'reports', 'moderationLog', 'orgNotes', 'ledger', 'opsEvents', 'sourceChanges', 'idvQueue'];
const TABLES = { blocks: 'blocks', reports: 'reports', moderationLog: 'moderation_log', orgNotes: 'org_notes', ledger: 'ledger', opsEvents: 'ops_events', sourceChanges: 'source_changes', idvQueue: 'idv_queue' };
/** The keys of each record, in the writers' order (repositories/safetyAudit.mjs). */
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

async function boot(dir, env = {}, server = SERVER) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawnChild(process.execPath, [server], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
   
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
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000).unref();
  });
}
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction so several reads see one committed state. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const live = (dir) => !!q1(dir, 'SELECT 1 AS one FROM data_migrations WHERE id = ?', MIGRATION);
/** Whether the file still has the retired blob table (dropped by migration 0039). */
const hasBlobTable = (dir) => !!q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'collections'");
/** The typed record: every key of the collection in the writer's order, an absent key null. */
const ordered = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k] === undefined ? null : row[k]]));
/** The rows as the DATABASE holds them, in insertion order, as typed records (decoded by the repository's own export reader on a second, read-only connection). */
const stored = (dir, name) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return createSafetyAuditRepository({ sqlite: s }).exportAll()[name].map((r) => ordered(r, KEYS[name])); } finally { s.close(); } };
const storedAll = (dir) => Object.fromEntries(COLLECTIONS.map((n) => [n, stored(dir, n)]));
const canon = (name, rows) => rows.map((r) => ordered(r, KEYS[name]));

const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, `org login ${orgId}: ${r.text}`); return r.body.token; };
const playerLogin = async (S, playerId) => { const r = await S.j('POST', '/auth/player/login', { playerId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const guardianLogin = async (S, guardianId) => { const r = await S.j('POST', '/auth/guardian/login', { guardianId }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); return { pid: r.body.playerId, token: r.body.token }; };
const signupGuardian = async (S, name, email) => { const r = await S.j('POST', '/auth/guardian/signup', { name, email, password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text); assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: r.body.guardianId, code: r.body.devEmailCode })).status, 200); return { gid: r.body.guardianId, token: r.body.token }; };
const adminReports = async (S) => (await S.j('GET', '/admin/reports?limit=100', undefined, null, A)).body.items;
const adminBlocks = async (S) => (await S.j('GET', '/admin/blocks?limit=100', undefined, null, A)).body.items;
const adminModeration = async (S) => (await S.j('GET', '/admin/moderation?limit=100', undefined, null, A)).body.items;
const adminIdv = async (S) => (await S.j('GET', '/admin/guardians', undefined, null, A)).body.idvQueue;
const orgLedger = async (S, token) => (await S.j('GET', '/org/ledger?limit=100', undefined, token)).body.items;
const orgNotesOf = async (S, token, pid) => (await S.j('GET', `/org/players/${pid}`, undefined, token)).body.orgNotes;
const count = (text, re) => (text.match(re) ?? []).length;
const waitForLog = async (S, re, above) => { for (let i = 0; i < 80 && count(S.log(), re) <= above; i++) await sleep(25); return count(S.log(), re) > above; };
/** The whole audit state the admin and the owners see, in one object (what a restart and a restore must reproduce). */
async function audited(S, maria) {
  return { reports: await adminReports(S), blocks: await adminBlocks(S), moderation: await adminModeration(S), idv: await adminIdv(S), ledger: await orgLedger(S, maria) };
}

// ============================================================= [compat] the routes' behaviour
await test('[compat] every writer through its route and every reader: a guardian\'s block and report (urgent → the suspension block and the frozen request), a report naming an unknown player (accepted: Q4), the junk the routes refuse (a block or a report naming an organisation that does not exist — 404 ORG_NOT_FOUND —, a NUMERIC targetPlayerId, an object targetOrgId, an object orgId or reason on a block, a non-text note, an object documentType — 400, nothing stored), an organisation\'s report and private note, two moderation hits (a contact hit; a grooming hit that escalates to an automatic urgent report with no targetPlayerId key), the IDV entry, a source change, a backup ops event, the ledger rows the blocks write; the admin triage order, the reporters\' own lists, the guardian\'s log, the org ledger, the data; report resolution, the block lift (Q5: the row is deleted and returned once), the IDV toggle (the FIRST entry); the stored rows equal the views; a restart serves the same', async () => {
  const dir = tempDir('s6b-compat'); let S = await boot(dir);
  const maria = await orgLogin(S); const amara = await guardianLogin(S, 'gd-amara'); const { pid, token: adult } = await signupAdult(S, 'Audit Adult');
  // Guardian: a block of the child, then an urgent report against the club that suspends the pending request.
  const req = await S.j('POST', '/org/players/pl-guni/request', { type: 'contact', message: 'Synthetic contact request for the child.' }, maria); assert.equal(req.status, 201, req.text);
  assert.equal((await S.j('POST', '/guardian/block', { orgId: 'org-harbour', playerId: 'pl-guni', reason: 'synthetic guardian block' }, amara)).status, 201);
  const gRep = await S.j('POST', '/guardian/report', { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic urgent guardian report.', urgent: true }, amara); assert.equal(gRep.status, 201, gRep.text); assert.equal(gRep.body.suspended, true);
  assert.equal((await S.j('GET', '/guardian/inbox', undefined, amara)).body.items.find((r) => r.id === req.body.requestId)?.status, 'suspended', 'the pending request froze with the suspension block');
  // Adult: a block or a report naming an organisation that does not exist is refused (organisations are keys); a report naming an unknown player is accepted (Q4).
  for (const [route, body] of [['/player/block', { orgId: 'org-does-not-exist', reason: 'synthetic' }], ['/player/report', { targetKind: 'club', targetOrgId: 'org-does-not-exist', reason: 'Synthetic report naming no club.' }]]) {
    const r = await S.j('POST', route, body, adult); assert.deepEqual([r.status, r.body?.error], [404, 'ORG_NOT_FOUND'], `${route}: an unknown organisation is refused (${r.text})`);
  }
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adult)).status, 201, 'a block naming a real organisation');
  // Over-long text is refused, naming the field.
  for (const [route, body, field, token] of [['/player/report', { targetKind: 'scout', targetScoutName: 'Synthetic Scout', reason: 'x'.repeat(2001) }, 'reason', adult], [`/org/players/${pid}/notes`, { text: 'x'.repeat(2001) }, 'text', maria]]) {
    const r = await S.j('POST', route, body, token); assert.deepEqual([r.status, r.body?.error, r.body?.field], [400, 'FIELD_INVALID', field], `${route}: over-long ${field} (${r.text})`);
  }
  const pRep1 = await S.j('POST', '/player/report', { targetKind: 'player', targetPlayerId: 'pl-nobody', reason: 'Synthetic report naming an unknown player.' }, adult); assert.equal(pRep1.status, 201, pRep1.text);
  // Junk the text columns cannot hold is refused at the route (400 FIELD_INVALID, naming the field), and nothing is stored.
  for (const [route, body, field, token] of [
    ['/player/report', { targetKind: 'player', targetPlayerId: 123, reason: 'Synthetic report with a numeric id.' }, 'targetPlayerId', adult],
    ['/org/report', { targetKind: 'club', targetOrgId: { id: 'org-harbour' }, reason: 'Synthetic report with an object org id.' }, 'targetOrgId', maria],
    ['/guardian/report', { targetKind: 'scout', targetScoutName: ['Synthetic Scout'], reason: 'Synthetic report with an array name.' }, 'targetScoutName', amara],
    ['/player/block', { orgId: { id: 'org-harbour' } }, 'orgId', adult],
    ['/player/block', { orgId: 'org-harbour', reason: 42 }, 'reason', adult],
    ['/guardian/block', { orgId: 'org-harbour', playerId: 'pl-guni', reason: { why: 'object' } }, 'reason', amara],
  ]) { const r = await S.j('POST', route, body, token); assert.equal(r.status, 400, `${route} ${field}: ${r.text}`); assert.deepEqual([r.body.error, r.body.field], ['FIELD_INVALID', field], `${route}: the field is named`); }
  const badNote = await S.j('POST', `/org/players/${pid}/notes`, { text: ['Synthetic note as an array.'] }, maria); assert.equal(badNote.status, 400, badNote.text); assert.equal(badNote.body.error, 'TEXT_REQUIRED');
  const pRep2 = await S.j('POST', '/player/report', { targetKind: 'scout', targetScoutName: 'Synthetic Scout', reason: 'Synthetic report about a scout.' }, adult); assert.equal(pRep2.status, 201, pRep2.text);
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
  const badIdv = await S.j('POST', '/guardian/verify-id', { documentType: { kind: 'passport' }, documentRef: 'P1234567' }, gtok); assert.equal(badIdv.status, 400, badIdv.text); assert.deepEqual([badIdv.body.error, badIdv.body.field], ['FIELD_INVALID', 'documentType']);
  // A source change (the passport primary position) and an ops event (the backup).
  const prefs = await S.j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'ST', secondary: [] } }, adult); assert.equal(prefs.status, 200, prefs.text);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  // The views.
  const reports = await adminReports(S);
  const rank = (r) => (r.status === 'pending_review' ? (r.urgent ? 0 : 1) : 2);
  assert.ok(reports.every((r, i) => i === 0 || rank(reports[i - 1]) <= rank(r)), 'triage order: urgent pending first'); assert.equal(reports.length, 5);
  const auto = reports.find((r) => r.by === 'system'); assert.ok(auto, 'the grooming hit escalated'); assert.equal(auto.urgent, true); assert.equal(auto.targetPlayerId, null, 'the automatic report has no player target'); assert.equal(auto.targetKind, 'player'); assert.equal(auto.targetOrgId, null);
  assert.equal(reports.find((r) => r.id === pRep1.body.reportId).targetPlayerId, 'pl-nobody'); assert.equal(reports.find((r) => r.id === pRep2.body.reportId).targetScoutName, 'Synthetic Scout'); assert.equal(reports.find((r) => r.id === pRep2.body.reportId).targetPlayerId, null); assert.equal(reports.find((r) => r.id === oRep.body.reportId).byOrgId, 'org-eastport');
  assert.deepEqual((await S.j('GET', '/player/reports', undefined, adult)).body.map((r) => r.id), [pRep2.body.reportId, pRep1.body.reportId], 'the reporter\'s own list, newest first'); assert.deepEqual((await S.j('GET', '/guardian/reports', undefined, amara)).body.map((r) => r.id), [gRep.body.reportId]); assert.deepEqual((await S.j('GET', '/org/reports', undefined, maria)).body.map((r) => r.id), [oRep.body.reportId]);
  const blocks = await adminBlocks(S); assert.deepEqual(blocks.map((b) => [b.playerId, b.orgId, b.by, b.reason]), [[pid, 'org-harbour', 'player', 'synthetic'], ['pl-guni', 'org-eastport', 'guardian', 'suspended_pending_review'], ['pl-guni', 'org-harbour', 'guardian', 'synthetic guardian block']], 'newest first');
  const moderation = await adminModeration(S); assert.deepEqual(moderation.map((m) => [m.severity, m.flags, m.context.kind, m.context.playerId]), [['grooming', ['secrecy'], 'timeline_event', pid], ['contact', ['phone_number'], 'timeline_event', pid]]); assert.equal(moderation[1].excerpt, 'Call me on +44 7700 900123 please');
  const idvRows = await adminIdv(S); assert.deepEqual(idvRows.filter((q) => q.guardianId === gid).map((q) => [q.documentType, q.documentRef, q.provider, q.status]), [['passport', '4567', 'dev-attestation', 'approved'], ['licence', '4321', 'dev-attestation', 'approved']]);
  const ledger = await orgLedger(S, maria); assert.ok(ledger.some((l) => l.type === 'org_blocked_by_guardian' && l.playerId === 'pl-guni' && l.orgId === 'org-harbour') === false, 'the guardian block of ANOTHER club is not in this club\'s ledger'); assert.ok((await S.j('GET', '/guardian/log?limit=100', undefined, amara)).body.items.some((l) => l.type === 'org_blocked_by_guardian' && l.playerId === 'pl-guni'), 'the guardian\'s log carries the block row');
  assert.deepEqual((await orgNotesOf(S, maria, pid)).map((n) => n.text), ['Synthetic private note.']);
  assert.ok((await S.j('GET', '/player/export', undefined, adult)).body.ledgerEvents.some((l) => l.type === 'org_blocked_by_player'));
  const overview = (await S.j('GET', '/admin/overview', undefined, null, A)).body; assert.equal(overview.openReports, 5); assert.equal(overview.blocks, 3); assert.equal(overview.moderationHits, 2); assert.equal(overview.groomingEscalations, 1);
  const metrics = (await S.j('GET', '/admin/metrics', undefined, null, A)).body; assert.ok(metrics.opsEvents.some((e) => e.kind === 'backup_created'), 'the backup ops event');
  const sc = stored(dir, 'sourceChanges'); assert.deepEqual(sc.map((c) => [c.playerId, c.type, c.sourceSystem, c.detail]), [[pid, 'position_changed', 'passport_prefs', { to: 'ST', submittedBy: 'player' }]]);
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
  assert.equal(stored(dir, 'reports').some((r) => typeof r.targetPlayerId === 'number' || /numeric id|object org id|array name/.test(r.reason)), false, 'the refused reports were never stored');
  assert.equal(JSON.stringify(stored(dir, 'ledger').filter((l) => l.orgId === 'org-eastport').slice().reverse()), JSON.stringify(canon('ledger', all.ledger)), 'the org ledger equals the stored rows');
  // A restart serves the same.
  await S.stop(); S = await boot(dir); const maria2 = await orgLogin(S);
  assert.deepEqual(await audited(S, maria2), all, 'the restart serves the same rows');
  assert.deepEqual((await orgNotesOf(S, maria2, pid)).map((n) => n.text), ['Synthetic private note.']);
  await S.stop(); rm(dir, bk.body.dir);
});

await test('[compat] a REAL adult account deletion retains every audit row that names the person, with its now-unresolved id, as today: the ledger, report, note, block and source-change rows survive DELETE /player/account; an unchanged save succeeds afterwards (the admin backup\'s persistNow); the backup carries the rows; a restore into a NEW directory imports them row for row; a report naming an unknown player stays accepted throughout', async () => {
  const dir = tempDir('s6b-deletion'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token: adult } = await signupAdult(S, 'Deleted Adult');
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adult)).status, 201);
  const byThem = await S.j('POST', '/player/report', { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic report by the adult.' }, adult); assert.equal(byThem.status, 201);
  const aboutThem = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic report about the adult.' }, maria); assert.equal(aboutThem.status, 201);
  assert.equal((await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic note about the adult.' }, maria)).status, 201);
  assert.equal((await S.j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'CM', secondary: [] } }, adult)).status, 200);
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 200, 'the club reads the adult before the deletion');
  const bkBefore = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bkBefore.status, 201);
  const before = storedAll(dir);
  const naming = (rows) => rows.filter((r) => r.playerId === pid || r.targetPlayerId === pid);
  assert.deepEqual([naming(before.blocks).length, naming(before.reports).length, naming(before.orgNotes).length, naming(before.ledger).length >= 1, naming(before.sourceChanges).length], [1, 1, 1, true, 1], 'rows in all five player-audit tables name the adult');
  const del = await S.j('DELETE', '/player/account', {}, adult); assert.equal(del.status, 200, del.text);
  assert.ok(Number.isInteger(q1(dir, 'SELECT deleted_at FROM players WHERE id = ?', pid)?.deleted_at), 'the player row is the retained record (migration 0014) — the audit rows below are unchanged either way');
  const after = storedAll(dir);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(after[n]), JSON.stringify(before[n]), `${n}: every row exactly as before the deletion (the id now resolves to nothing)`);
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 404);
  assert.ok((await adminReports(S)).some((r) => r.targetPlayerId === pid), 'the admin still lists the report about the deleted person');
  // The backup carries the rows.
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, `an unchanged save after the deletion succeeds: ${bk.text}`);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(bk.body.dir, n)), JSON.stringify(after[n]), `the backup's ${n} equals the stored rows`);
  const unknown = await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: 'pl-never-existed', reason: 'Synthetic report naming an unknown player.' }, maria); assert.equal(unknown.status, 201, 'a report naming an unknown player stays accepted');
  assert.ok(stored(dir, 'reports').some((r) => r.targetPlayerId === 'pl-never-existed'), 'and is committed at the response');
  await S.stop();
  // A restore into a new directory.
  const restored = tempDir('s6b-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); const mariaR = await orgLogin(S);
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(restored, n)), JSON.stringify(after[n]), `the restore reproduced ${n} row for row`);
  assert.ok((await adminReports(S)).some((r) => r.targetPlayerId === pid)); assert.ok((await orgLedger(S, mariaR)).some((l) => l.playerId === pid), 'the org ledger still carries the deleted person\'s id');
  await S.stop();
  rm(dir, bkBefore.body.dir, bk.body.dir, restored);
});

// ============================================================= [cutover] the tables, the coupled units, the strict reference at boot
await test('[cutover] the cutover and the save points: a fresh boot records 0013_safety_audit after 0012 and creates the eight tables and the file has no blob table (the data layer reports the domain); a player\'s block and its ledger row are committed together before the 201; the IDV entry commits with the guardian\'s column before the 200 — both failure seams and the real COMMIT leave nothing, the retry lands, a SIGKILL right after the response loses nothing, a restart serves it; an urgent report whose unit fails at the REAL COMMIT is answered 500 and leaves neither the report nor its suspension block, and the retry lands each ONCE; the block lift is durable before its response', async () => {
  const dir = tempDir('s6b-cutover'); let S = await boot(dir, { M13_FAST_RETRY: '' });
  assert.ok(live(dir), 'the boot recorded 0013');
  assert.deepEqual(snap(dir, (c) => c.all('SELECT id FROM data_migrations ORDER BY applied_at, id').map((r) => r.id).filter((id) => id < '0019').slice(-7)), ['0012_channels', MIGRATION, '0014_player_erasure', '0015_recruitment', '0016_recruitment_cases', '0017_recruitment_contacts_offers', '0018_signings_follow_ups']);
  for (const t of Object.values(TABLES)) assert.ok(q1(dir, "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?", t), `${t} exists`);
  assert.equal(hasBlobTable(dir), false, 'no blob table');
  const cap = (await S.j('GET', '/capabilities')).body; const domains = cap?.persistence?.dataLayer?.domains ?? cap?.dataLayer?.domains ?? {}; assert.ok(domains.safetyAudit, `the data layer reports the safetyAudit domain (${Object.keys(domains).join(', ')})`);
  // A block and its ledger row: one unit, committed before the response (read in one read transaction).
  const { pid, token: adult } = await signupAdult(S, 'Cutover Adult');
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adult)).status, 201); // not org-eastport: its user writes the note below, and a blocked organisation reads the player as absent
  const landed = snap(dir, (c) => { const block = c.get('SELECT org_id, reason FROM blocks WHERE player_id = ?', pid); return block ? { block, ledger: c.all('SELECT type FROM ledger WHERE player_id = ? AND type = ?', pid, 'org_blocked_by_player') } : null; });
  assert.ok(landed, 'the block is committed when the response is sent'); assert.deepEqual(landed.block, { org_id: 'org-harbour', reason: 'synthetic' }); assert.equal(landed.ledger.length, 1, 'the ledger row committed with it');
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
  // An urgent report and its suspension are one unit: a failure at the REAL COMMIT leaves neither, the retry lands each once.
  const maria = await orgLogin(S);
  const reportOf = (reason) => snap(dir, (c) => c.all('SELECT id FROM reports WHERE reason = ?', reason));
  const suspensions = () => snap(dir, (c) => c.all("SELECT id FROM blocks WHERE player_id = ? AND org_id = 'org-eastport' AND reason = 'suspended_pending_review'", pid));
  const urgent = { targetKind: 'club', targetOrgId: 'org-eastport', reason: 'Synthetic urgent report whose unit fails at COMMIT.', urgent: true };
  assert.equal((await S.j('POST', '/__faults', { rules: 'internal:unit.sqlite_commit' })).status, 200); const commitFailures = count(S.log(), /FOREIGN KEY constraint failed/g);
  const failed = await S.j('POST', '/player/report', urgent, adult); assert.equal(failed.status, 500, `not answered as success (${failed.text})`);
  assert.ok(await waitForLog(S, /FOREIGN KEY constraint failed/g, commitFailures), 'the unit failed at the real COMMIT');
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  assert.deepEqual([reportOf(urgent.reason).length, suspensions().length], [0, 0], 'neither the report nor its suspension block landed');
  assert.equal((await adminReports(S)).some((r) => r.reason === urgent.reason), false, 'and the admin does not list it');
  const retry = await S.j('POST', '/player/report', urgent, adult); assert.equal(retry.status, 201, retry.text); assert.equal(retry.body.suspended, true);
  assert.deepEqual([reportOf(urgent.reason).length, suspensions().length], [1, 1], 'the retry landed the report and its suspension block, once each');
  const liftSuspension = await S.j('POST', `/admin/blocks/${suspensions()[0].id}/lift`, {}, null, A); assert.equal(liftSuspension.status, 200, liftSuspension.text); // Maria writes a note on the player below
  const note = await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic note.' }, maria); assert.equal(note.status, 201, note.text);
  assert.ok(q1(dir, 'SELECT 1 AS one FROM org_notes WHERE id = ?', note.body.id), 'the note is committed when the response is sent');
  // The block lift (Q5) is durable before its response.
  const blockId = (await adminBlocks(S)).find((b) => b.playerId === pid).id;
  const lift = await S.j('POST', `/admin/blocks/${blockId}/lift`, {}, null, A); assert.equal(lift.status, 200, lift.text);
  assert.equal(q1(dir, 'SELECT 1 AS one FROM blocks WHERE id = ?', blockId), undefined, 'the lifted block row is deleted in the file');
  await S.stop(); rm(dir);
});

await test('[cutover] the admin backup and a restore: the backup\'s database copy holds the eight collections exactly as stored (its own backup_created event is appended after the copy); a restore into a NEW directory reproduces them row for row and the admin views serve them', async () => {
  const dir = tempDir('s6b-backup2'); let S = await boot(dir);
  const maria = await orgLogin(S); const { pid, token: adult } = await signupAdult(S, 'Backup Adult');
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'synthetic' }, adult)).status, 201);
  assert.equal((await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic.' }, maria)).status, 201);
  const { token: gtok } = await signupGuardian(S, 'Backup Parent', 'backup-parent@example.test'); assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, gtok)).status, 200);
  assert.equal((await S.j('POST', '/player/timeline', { year: 2026, event: 'Call me on +44 7700 900123 please' }, adult)).status, 400, 'a moderation hit');
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const storedAtBackup = (n) => { const rows = stored(dir, n); if (n !== 'opsEvents') return rows; const last = rows.at(-1); assert.equal(last?.kind, 'backup_created'); assert.equal(last.detail?.dir, path.basename(bk.body.dir)); return rows.slice(0, -1); };
  const copy = Object.fromEntries(COLLECTIONS.map((n) => [n, stored(bk.body.dir, n)]));
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(copy[n]), JSON.stringify(storedAtBackup(n)), `the backup's ${n} equals the stored rows exactly`);
  for (const n of ['blocks', 'reports', 'ledger', 'idvQueue', 'moderationLog']) assert.ok(copy[n].length > 0, `${n} has rows to carry`);
  await S.stop();
  const restored = tempDir('s6b-restored2'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored); assert.ok(live(restored));
  for (const n of COLLECTIONS) assert.equal(JSON.stringify(stored(restored, n)), JSON.stringify(copy[n]), `row for row: ${n}`);
  assert.equal(hasBlobTable(restored), false, 'no blob table');
  assert.equal((await adminBlocks(S)).length, copy.blocks.length, 'the admin lists the restored blocks');
  assert.ok((await adminReports(S)).some((r) => r.targetPlayerId === pid)); assert.equal((await adminIdv(S)).length, copy.idvQueue.length); assert.equal((await adminModeration(S)).length, copy.moderationLog.length);
  await S.stop();
  rm(dir, restored);
});

// The Box Cam preferences are a typed row (repositories/boxCam.mjs): a player with no row reads the defaults, the
// PATCH writes the whole row, and its ledger row records the share and the clip choice together.
await test('the real authenticated PATCH /player/box-cam/prefs { retainClips: true } from the defaults: answered 200 with the whole preferences, the box_prefs_changed ledger row recorded with detail { by, share, retainClips }; the prefs and the row survive a SIGKILL and a restart; the admin backup carries the row exactly', async () => {
  const dir = tempDir('s6b-f2'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Prefs Adult');
  assert.deepEqual((await S.j('GET', '/player/box-cam/prefs', undefined, token)).body, { prefs: { playerId: pid, shareDevelopmentActivity: 'private', retainClips: false, updatedAt: null, updatedBy: null } }, 'no row: the defaults');
  const r = await S.j('PATCH', '/player/box-cam/prefs', { retainClips: true }, token);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.body.prefs), ['playerId', 'shareDevelopmentActivity', 'retainClips', 'updatedAt', 'updatedBy']); assert.equal(r.body.prefs.retainClips, true); assert.deepEqual(r.body.prefs.updatedBy, { kind: 'player', id: pid });
  const prefsRows = () => stored(dir, 'ledger').filter((l) => l.playerId === pid && l.type === 'box_prefs_changed');
  assert.ok(await until(async () => prefsRows().length === 1, 8000), 'the ledger row landed');
  const row = prefsRows()[0];
  assert.equal(JSON.stringify(row.detail), JSON.stringify({ by: 'player', share: 'private', retainClips: true }));
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  const backupRow = stored(bk.body.dir, 'ledger').find((l) => l.id === row.id);
  assert.equal(JSON.stringify(backupRow), JSON.stringify(row), 'the backup carries the row exactly');
  await S.kill(); // SIGKILL after the answers: nothing pending is lost
  S = await boot(dir);
  assert.equal((await S.j('GET', '/player/box-cam/prefs', undefined, token)).body.prefs.retainClips, true, 'the prefs survived the restart');
  assert.equal(JSON.stringify(prefsRows()[0]), JSON.stringify(row), 'the row survived the restart');
  await S.stop();
  rm(dir, bk.body.dir);
});

console.log(`\n${passed} safety-audit server checks passed`);
