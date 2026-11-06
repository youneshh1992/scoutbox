// S4b-R through the REAL server (server.mjs booted as a child process on
// temporary data directories; synthetic records only): the retained player
// record on the two deletion routes (an adult's own account, a guardian's child),
// every account reader and authentication path afterwards, the audit rows
// untouched, SIGKILL and restart, the two failure seams of the deletion unit
// (a failure after the erase, the real COMMIT) with everything restored and the
// retry landing once; the admin backup (a database copy) keeping retained
// records separate from live accounts, a restore into a NEW directory. Every read of the file goes through a second connection. Nothing
// here touches DATA_DIR or real data. Run with: npm test
//
// FAILING-FIRST NOTE (recorded on the unchanged d16362f tree): every test fails
// there on a concrete assertion (the row is hard-deleted; no 0014).
import assert from 'node:assert/strict';
import { spawnChild } from './testChildren.mjs';
import { freePort } from './testPort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { SUBRECORD_TABLES } from '../repositories/playerSubrecords.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const MIGRATION = '0014_player_erasure';
const AUDIT_TABLES = ['blocks', 'reports', 'org_notes', 'ledger', 'source_changes'];

/** The retained row (plan §D.6.1 item 1): id, the deletion instant, the full birth date, the country; fixed placeholders; NULL everywhere else. */
const RETAINED_ROW = (id, deletedAt, birthDate, country) => ({
  id, name: 'Deleted player', birth_date: birthDate, country, city: null, position: null, foot: null, height_cm: null, weight_kg: null, squad_number: null,
  contract_until_date: null, market_value_range: null, agent_name: null, academy_plus: 0, first_team_seeker: 0, availability: 'not_seeking', contract_status: 'unknown', level: 'amateur',
  football_category: null, identity_verified: 0, guardian_id: null, lat: null, lng: null, stats_appearances: null, stats_goals: null, stats_assists: null, stats_pace_kmh: null,
  stats_pass_completion_pct: null, stats_duel_success_pct: null, stats_clean_sheets: null, medical_shared: 0, medical_condition_status: 'unknown', prefs_quiet_start: null,
  prefs_quiet_end: null, prefs_school_hours_mute: null, prefs_timezone: null, programme_track: null, programme_started_at: null, password_hash: null, created_at: null,
  deleted_at: deletedAt, facets_json: null,
});

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
/** Every read of the file goes through a second, read-only connection; `snap` pins ONE read transaction. */
const snap = (dir, fn) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { s.exec('BEGIN'); try { return fn({ get: (sql, ...p) => { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; }, all: (sql, ...p) => s.prepare(sql).all(...p).map((r) => ({ ...r })) }); } finally { s.exec('COMMIT'); } } finally { s.close(); } };
const q1 = (dir, sql, ...p) => snap(dir, (c) => c.get(sql, ...p));
const qAll = (dir, sql, ...p) => snap(dir, (c) => c.all(sql, ...p));
const row = (dir, id) => q1(dir, 'SELECT * FROM players WHERE id = ?', id);
const OWNED_TABLES = SUBRECORD_TABLES.filter((t) => t !== 'player_media_tags'); // the tag rows hang off player_media (media_id), not the player
const childRows = (dir, id) => snap(dir, (c) => OWNED_TABLES.reduce((n, t) => n + c.get(`SELECT COUNT(*) AS n FROM ${t} WHERE player_id = ?`, id).n, 0));
const links = (dir, id) => qAll(dir, 'SELECT guardian_id, player_id, role FROM guardian_children WHERE player_id = ? ORDER BY rowid', id);
const sessionsOf = (dir, id) => q1(dir, "SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = ?", id).n;
const codesOf = (dir, id) => q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = ?', id).n;
const queued = (dir) => q1(dir, 'SELECT COUNT(*) AS n FROM media_deletions').n;
const auditRows = (dir) => snap(dir, (c) => JSON.stringify(Object.fromEntries(AUDIT_TABLES.map((t) => [t, c.all(`SELECT * FROM ${t} ORDER BY seq`)]))));
const retainedRowsOf = (dir) => qAll(dir, 'SELECT * FROM players WHERE deleted_at IS NOT NULL ORDER BY rowid');
const orgLogin = async (S, orgId = 'org-eastport', scoutName = 'Maria Keane', role = 'Head of Recruitment') => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role }); assert.equal(r.status, 200, r.text); return r.body.token; };
const signupAdult = async (S, name, { media = true } = {}) => {
  const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1' }); assert.equal(r.status, 201, r.text);
  let mediaId = null;
  if (media) { const m = await S.j('POST', '/player/media', { title: 'Clip', kind: 'video', dataUrl: 'data:video/webm;base64,AAAAAAAA' }, r.body.token); assert.equal(m.status, 201, m.text); mediaId = m.body.media.id; }
  return { pid: r.body.playerId, token: r.body.token, mediaId, file: mediaId ? path.join(S.dir, 'media', `${mediaId}.webm`) : null };
};
async function guardianWithChild(S, tag) {
  const gs = await S.j('POST', '/auth/guardian/signup', { name: `Parent ${tag}`, email: `parent-${tag}@example.test`, password: 'synthetic-pass-1' }); assert.equal(gs.status, 201, gs.text);
  const token = gs.body.token;
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs.body.guardianId, code: gs.body.devEmailCode })).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, token)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, token)).status, 200);
  const kid = await S.j('POST', '/guardian/children', { name: `Kid ${tag}`, dob: '2015-05-05' }, token); assert.equal(kid.status, 201, kid.text);
  const mint = await S.j('POST', `/guardian/children/${kid.body.playerId}/pairing-code`, {}, token); assert.equal(mint.status, 201, mint.text);
  return { token, guardianId: gs.body.guardianId, childId: kid.body.playerId, code: mint.body.code };
}
/** Audit rows naming the adult, through the real routes (a block, a report about them, a note, a passport preference → ledger and source-change rows). */
async function auditFor(S, pid, adultToken, maria) {
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-harbour', reason: 'synthetic' }, adultToken)).status, 201);
  assert.equal((await S.j('POST', '/org/report', { targetKind: 'player', targetPlayerId: pid, reason: 'Synthetic report about the adult.' }, maria)).status, 201);
  assert.equal((await S.j('POST', `/org/players/${pid}/notes`, { text: 'Synthetic note about the adult.' }, maria)).status, 201);
  assert.equal((await S.j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'CM', secondary: [] } }, adultToken)).status, 200);
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 200, 'the club reads the adult before the deletion');
  assert.equal((await S.j('POST', '/admin/backup', {}, null, A)).status, 201); // flushes every staged write
}
const naming = (dir, pid) => snap(dir, (c) => Object.fromEntries(AUDIT_TABLES.map((t) => [t, c.get(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'reports' ? 'target_player_id' : 'player_id'} = ?`, pid).n])));

// ------------------------------------------------------------- the retained record through the routes
await test('[cutover] a fresh boot records 0014_player_erasure last; DELETE /player/account and DELETE /guardian/children/:id keep EXACTLY the agreed row (id, the deletion instant, the full birth date, the country; fixed placeholders; NULL elsewhere), remove the child rows, links, session, pairing code and queue the media file as today; afterwards the account is served by no reader — /player/me 401, login PLAYER_NOT_FOUND, the club\'s view and list 404/absent, the guardian\'s children list without the child, the pairing code refused, a second deletion refused — the audit rows naming the person are byte-identical and the Q4 count unchanged while the new retained-reference count names them; /capabilities counts the retained records; a SIGKILL and a restart serve the same', async () => {
  const dir = tempDir('s4br-routes'); let S = await boot(dir);
  let cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.migrations.filter((id) => id < '0019').at(-5), MIGRATION, `0014 recorded after 0013 (S8a's 0015, S8b's 0016, S8c's 0017 and S8d's 0018 follow it: ${cap.dataLayer.migrations.slice(-5).join(', ')})`);
  assert.equal(cap.dataLayer.domains.players.retained, 0, 'the report counts retained records');
  const maria = await orgLogin(S);
  const { pid, token, file } = await signupAdult(S, 'Erased Adult');
  await auditFor(S, pid, token, maria);
  const rowsBefore = cap.dataLayer.domains.players.rows + 1;
  assert.deepEqual(Object.values(naming(dir, pid)).map((n) => n >= 1), [true, true, true, true, true], 'rows in all five player-audit tables name the adult');
  const auditBefore = auditRows(dir); const unresolvedBefore = JSON.stringify((await S.j('GET', '/capabilities')).body.dataLayer.domains.safetyAudit.unresolvedPlayerReferences);
  assert.equal(row(dir, pid).deleted_at, null); assert.ok(childRows(dir, pid) >= 1, 'the media row'); assert.equal(sessionsOf(dir, pid), 1); assert.ok(fs.existsSync(file));
  const t0 = Date.now();
  const del = await S.j('DELETE', '/player/account', {}, token); assert.equal(del.status, 200, del.text); assert.deepEqual(del.body, { deleted: true });
  const r = row(dir, pid);
  assert.ok(Number.isInteger(r.deleted_at) && r.deleted_at >= t0 && r.deleted_at <= Date.now(), `deleted_at is the deletion instant (${r.deleted_at})`);
  assert.deepEqual(r, RETAINED_ROW(pid, r.deleted_at, '2000-01-01', 'GB'), 'the retained row, column by column');
  assert.equal(childRows(dir, pid), 0); assert.deepEqual(links(dir, pid), []); assert.equal(sessionsOf(dir, pid), 0); assert.equal(fs.existsSync(file), false, 'the file went after COMMIT'); assert.equal(queued(dir), 0);
  assert.equal((await S.j('GET', '/player/me', undefined, token)).status, 401, 'the session was revoked in the same unit');
  const login = await S.j('POST', '/auth/player/login', { playerId: pid, password: 'synthetic-pass-1' }); assert.equal(login.status, 404); assert.equal(login.body.error, 'PLAYER_NOT_FOUND');
  assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, maria)).status, 404);
  const list = await S.j('GET', '/org/players', undefined, maria); assert.equal(list.status, 200); assert.equal((Array.isArray(list.body) ? list.body : list.body.items).some((p) => p.id === pid), false, 'absent from the club\'s list');
  assert.equal((await S.j('DELETE', '/player/account', {}, token)).status, 401, 'a second deletion with the dead session is refused');
  assert.equal(auditRows(dir), auditBefore, 'every audit row exactly as before the deletion');
  cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.domains.players.rows, rowsBefore - 1); assert.equal(cap.dataLayer.domains.players.retained, 1);
  assert.equal(JSON.stringify(cap.dataLayer.domains.safetyAudit.unresolvedPlayerReferences), unresolvedBefore, 'the Q4 count is unchanged: the id resolves to the retained row, not to nothing');
  assert.deepEqual(Object.entries(cap.dataLayer.domains.safetyAudit.retainedPlayerReferences).filter(([, n]) => n >= 1).map(([k]) => k).sort(), ['blocks', 'ledger', 'orgNotes', 'reports', 'sourceChanges'], 'the new count names the five tables');
  // The guardian's child.
  const { token: gtok, childId, code } = await guardianWithChild(S, 'erase');
  assert.equal(codesOf(dir, childId), 1);
  const t1 = Date.now();
  const delKid = await S.j('DELETE', `/guardian/children/${childId}`, {}, gtok); assert.equal(delKid.status, 200, delKid.text);
  const k = row(dir, childId);
  assert.ok(Number.isInteger(k.deleted_at) && k.deleted_at >= t1); assert.deepEqual(k, RETAINED_ROW(childId, k.deleted_at, '2015-05-05', 'GB'));
  assert.deepEqual(links(dir, childId), []); assert.equal(codesOf(dir, childId), 0); assert.equal(childRows(dir, childId), 0);
  const kids = await S.j('GET', '/guardian/children', undefined, gtok); assert.equal(kids.status, 200); assert.equal(JSON.stringify(kids.body).includes(childId), false, 'the guardian\'s list no longer carries the child');
  assert.equal((await S.j('GET', '/guardian/me', undefined, gtok)).status, 200, 'the guardian account is untouched');
  const pair = await S.j('POST', '/auth/player/pair', { code }); assert.equal(pair.status, 404, pair.text); assert.equal(pair.body.error, 'CODE_INVALID');
  assert.equal((await S.j('DELETE', `/guardian/children/${childId}`, {}, gtok)).status, 404, 'a second deletion: CHILD_NOT_FOUND');
  cap = (await S.j('GET', '/capabilities')).body; assert.equal(cap.dataLayer.domains.players.retained, 2);
  // SIGKILL and restart.
  const retainedBefore = JSON.stringify(retainedRowsOf(dir));
  await S.kill(); S = await boot(dir);
  assert.equal(JSON.stringify(retainedRowsOf(dir)), retainedBefore); assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.players.retained, 2);
  const mariaR = await orgLogin(S); assert.equal((await S.j('GET', `/org/players/${pid}`, undefined, mariaR)).status, 404);
  assert.equal((await S.j('POST', '/auth/player/login', { playerId: childId })).status, 404);
  assert.equal(auditRows(dir), auditBefore);
  await S.stop(); rm(dir);
});

await test('[cutover] the deletion unit\'s failure seams: a failure after the erase (internal:player.delete.after_erase) and a failure of the REAL COMMIT (internal:unit.sqlite_commit) are answered 500 and leave the account exactly as it was — the row, the child rows, the links, the live session (/player/me 200), the pairing code, no queued removal, the media file on disk — for an adult and for a guardian\'s child; the retry lands everything once and a second attempt is refused', async () => {
  const dir = tempDir('s4br-seams'); const S = await boot(dir);
  const { pid, token, file } = await signupAdult(S, 'Seam Adult');
  const { token: gtok, childId } = await guardianWithChild(S, 'seam');
  const stateOf = (id) => JSON.stringify({ row: row(dir, id), children: childRows(dir, id), links: links(dir, id), sessions: sessionsOf(dir, id), codes: codesOf(dir, id), queued: queued(dir), file: fs.existsSync(file), players: qAll(dir, 'SELECT id FROM players WHERE deleted_at IS NULL ORDER BY rowid').length });
  const refusedBy = async (rule, act, id, label) => {
    const before = stateOf(id);
    assert.equal((await S.j('POST', '/__faults', { rules: rule })).status, 200);
    const r = await act();
    assert.equal(r.status, 500, `${label} under ${rule}: a unit that did not commit must not be answered as success — got ${r.status} ${r.text}`); assert.equal(r.body?.error, 'INTERNAL');
    assert.equal(stateOf(id), before, `${label} under ${rule}: the file is exactly as before`);
    assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
  };
  for (const rule of ['internal:player.delete.after_erase:1', 'internal:unit.sqlite_commit:1']) {
    await refusedBy(rule, () => S.j('DELETE', '/player/account', {}, token), pid, 'the adult');
    assert.equal((await S.j('GET', '/player/me', undefined, token)).status, 200, `${rule}: the session is still valid`);
    await refusedBy(rule, () => S.j('DELETE', `/guardian/children/${childId}`, {}, gtok), childId, 'the child');
    assert.equal(JSON.stringify((await S.j('GET', '/guardian/children', undefined, gtok)).body).includes(childId), true, `${rule}: the guardian still lists the child`);
  }
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.players.retained, 0);
  // The retries.
  assert.equal((await S.j('DELETE', '/player/account', {}, token)).status, 200); assert.deepEqual(row(dir, pid), RETAINED_ROW(pid, row(dir, pid).deleted_at, '2000-01-01', 'GB')); assert.equal(sessionsOf(dir, pid), 0); assert.equal(fs.existsSync(file), false);
  assert.equal((await S.j('DELETE', `/guardian/children/${childId}`, {}, gtok)).status, 200); assert.deepEqual(row(dir, childId), RETAINED_ROW(childId, row(dir, childId).deleted_at, '2015-05-05', 'GB')); assert.equal(codesOf(dir, childId), 0);
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.players.retained, 2);
  assert.equal((await S.j('DELETE', '/player/account', {}, token)).status, 401); assert.equal((await S.j('DELETE', `/guardian/children/${childId}`, {}, gtok)).status, 404);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- backup, restore
await test('[cutover] the admin backup is a copy of the database that keeps the retained rows exactly and apart from live accounts (the manifest counts live players and retained records separately); a restore into a NEW directory reproduces the retained rows and the audit rows exactly; nothing of the person comes back', async () => {
  const dir = tempDir('s4br-backup'); let S = await boot(dir);
  const maria = await orgLogin(S);
  const a = await signupAdult(S, 'Backup Erased'); const b = await signupAdult(S, 'Backup Live', { media: false });
  await auditFor(S, a.pid, a.token, maria);
  const { token: gtok, childId } = await guardianWithChild(S, 'backup');
  assert.equal((await S.j('DELETE', '/player/account', {}, a.token)).status, 200); assert.equal((await S.j('DELETE', `/guardian/children/${childId}`, {}, gtok)).status, 200);
  const retained = retainedRowsOf(dir); assert.deepEqual(retained.map((r) => r.id), [a.pid, childId]);
  const auditBefore = auditRows(dir);
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  await S.stop();
  assert.deepEqual(retainedRowsOf(bk.body.dir), retained, 'the backup holds the retained rows, exactly');
  const liveIds = qAll(bk.body.dir, 'SELECT id FROM players WHERE deleted_at IS NULL').map((r) => r.id);
  assert.equal(liveIds.includes(a.pid) || liveIds.includes(childId), false, 'no retained id is a live player'); assert.ok(liveIds.includes(b.pid), 'the live player is there');
  const manifest = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.players, liveIds.length, 'the manifest counts live players'); assert.equal(manifest.counts.retainedPlayers, 2);
  // A restore into a new directory.
  const restored = tempDir('s4br-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.deepEqual(retainedRowsOf(restored), retained, 'the retained rows, exactly');
  // Before any route reads a profile: a club's profile view is a ledger row written at once (S14b).
  assert.equal(auditRows(restored), auditBefore, 'the audit rows restored row for row');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.players.retained, 2);
  const mariaR = await orgLogin(S); assert.equal((await S.j('GET', `/org/players/${a.pid}`, undefined, mariaR)).status, 404); assert.equal((await S.j('GET', `/org/players/${b.pid}`, undefined, mariaR)).status, 200);
  assert.equal((await S.j('POST', '/auth/player/login', { playerId: a.pid, password: 'synthetic-pass-1' })).status, 404);
  await S.stop();
  rm(dir, restored);
});

console.log(`\n${passed} player-erasure server checks passed`);
