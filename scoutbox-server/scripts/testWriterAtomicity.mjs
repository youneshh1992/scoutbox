// The coupled writers of S4a through the REAL server (server.mjs booted as a
// child process on temporary data directories, synthetic records only). A
// request that changes a column AND something else — a facet on the same
// record, a blob collection, an audit entry, another domain's facet — must
// commit the whole change before it answers: a second connection sees all of
// it at once, a SIGKILL right after the response loses none of it, and an
// injected failure — after the first row write (a named seam) or of the REAL
// SQLite COMMIT (a deferred foreign-key violation the engine refuses at COMMIT;
// not a throw placed before the statement) — is answered as a failure, leaves
// nothing of the operation in the database or in memory, and the retry lands
// the whole operation. The seams are the development fault layer's
// `internal:<step>` rules (m182/faults.mjs), which cannot exist in production.
// Nothing here touches DATA_DIR or any real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from './coreIdentityTestFixtures.mjs';
import { AUDIT_SNAPSHOT_TABLES } from '../repositories/safetyAudit.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
/** A port the kernel reports free right now (asked for each boot, so a server left by an earlier failure never collides). */
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// Every server this suite spawns; a failure anywhere must not leave one listening.
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* already gone */ } } });

/** Boot the real server on `dir` on a free port; resolves once it listens, rejects if it exits first. */
async function boot(dir) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(proc); proc.on('exit', () => children.delete(proc));
    let log = '';
    const j = async (method, p, body, token, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      let parsed = null; try { parsed = await r.json(); } catch { /* no body */ }
      return { status: r.status, body: parsed };
    };
    const S = { proc, port, dir, log: () => log, j, stop: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGTERM'); }), kill: () => new Promise((res) => { proc.on('exit', () => res()); proc.kill('SIGKILL'); }) };
    proc.stdout.on('data', (d) => { log += d; if (/listening on/.test(log)) resolve(S); });
    proc.stderr.on('data', (d) => { log += d; });
    proc.on('exit', (code, signal) => reject(Object.assign(new Error(`server exited ${code} (${signal}) on port ${port}: ${log.slice(-1200)}`), { code, log })));
    setTimeout(() => reject(new Error(`boot timeout: ${log.slice(-800)}`)), 30_000);
  });
}
// Every database read below goes through a SECOND connection (read-only), never the server's: what it sees is what is committed.
const q1 = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).get(...p); } finally { s.close(); } };
const facets = (dir, table, id) => JSON.parse(q1(dir, `SELECT facets_json FROM ${table} WHERE id = ?`, id).facets_json);
// S6b: the eight audit collections are tables since 0013 — read in the writer's literal through the repository's own reader when the blob is retired.
const blob = (dir, name) => { const r = q1(dir, 'SELECT value FROM collections WHERE name = ?', name); if (r) return JSON.parse(r.value); const t = AUDIT_SNAPSHOT_TABLES.find((x) => x.name === name); if (!t) return []; const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t.table) ? t.read(s) : []; } finally { s.close(); } };
const orgLogin = async (S, orgId, scoutName, role, platform) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) }); assert.equal(r.status, 200, `org login ${orgId}: ${JSON.stringify(r.body)}`); return r.body.token; };
const signupAdult = async (S, name, extra = {}) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2000-01-01', country: 'GB', password: 'synthetic-pass-1', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { pid: r.body.playerId, token: r.body.token }; };
const count = (text, re) => (text.match(re) ?? []).length;
const waitForLog = async (S, re, above) => { for (let i = 0; i < 80 && count(S.log(), re) <= above; i++) await new Promise((r) => setTimeout(r, 25)); return count(S.log(), re) > above; };

const COMMIT_SEAM = 'internal:unit.sqlite_commit';
// The real failure, as SQLite reports it when a deferred foreign key is checked at COMMIT.
const COMMIT_LOG = /FOREIGN KEY constraint failed/g;
/**
 * Arm one development seam, perform the operation once, and prove: it was not
 * answered as success; the failure the seam stands for really happened (the
 * server log carries it); nothing of the operation is in the database or in
 * memory. Then disarm the seam so the retry runs for real.
 */
async function refusedBy(S, rule, act, unchanged, logRe) {
  assert.equal((await S.j('POST', '/__faults', { rules: rule })).status, 200);
  const before = count(S.log(), logRe);
  const r = await act();
  assert.equal(r.status, 500, `${rule}: a unit that did not commit must not be answered as success — got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.error, 'INTERNAL');
  assert.ok(await waitForLog(S, logRe, before), `${rule}: the failure really happened (${logRe})`);
  await unchanged(`after ${rule}`);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
}

/**
 * One coupled writer, end to end: both seams refuse and leave nothing; the real
 * call commits everything before it answers; a SIGKILL right after the
 * response loses nothing; a restart serves the same.
 */
async function coupled(S, dir, { seam, act, dbState, before, after, view, viewBefore, viewAfter, okStatus = 200 }) {
  const unchanged = async (label) => {
    assert.deepEqual(dbState(), before, `${label}: nothing of the operation is in the database`);
    assert.deepEqual(await view(S), viewBefore, `${label}: memory restored (the view shows the pre-operation state)`);
  };
  await refusedBy(S, `internal:${seam}`, act, unchanged, new RegExp(`simulated failure at ${seam.replace(/\./g, '\\.')}`, 'g'));
  await refusedBy(S, COMMIT_SEAM, act, unchanged, COMMIT_LOG);
  const ok = await act();
  assert.equal(ok.status, okStatus, `the retry lands: ${JSON.stringify(ok.body)}`);
  assert.deepEqual(dbState(), after, 'every half of the operation is committed when the response is sent (second connection, before any delayed save)');
  assert.deepEqual(await view(S), viewAfter, 'the view agrees with the database');
  await S.kill();
  assert.deepEqual(dbState(), after, 'a SIGKILL right after the response loses nothing');
  const again = await boot(dir);
  assert.deepEqual(await view(again), viewAfter, 'a restart serves the committed state');
  return again;
}

// ------------------------------------------------------------- medical record (the reviewer's reproduction)
await test('medical record: the condition column and the record (a facet) commit together before the 201 — a second connection sees both at once, a SIGKILL right after the response loses neither; a failure after the row write and a failure of the real COMMIT are answered 500, leave neither in the database nor in memory, and the retry lands both', async () => {
  const dir = tempDir('s4wa-medical'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Medical Adult');
  S = await coupled(S, dir, {
    seam: 'medical.records.after_row',
    act: () => S.j('POST', '/player/medical/records', { title: 'Synthetic recovery record', conditionStatus: 'fully_fit', date: '2026-10-11' }, token),
    okStatus: 201,
    dbState: () => ({ condition: q1(dir, 'SELECT medical_condition_status AS c FROM players WHERE id = ?', pid).c, records: q1(dir, 'SELECT COUNT(*) AS n FROM player_medical_records WHERE player_id = ?', pid).n }), // S5: rows of player_medical_records
    before: { condition: 'unknown', records: 0 }, after: { condition: 'fully_fit', records: 1 },
    view: async (X) => { const me = (await X.j('GET', '/player/me', undefined, token)).body; return [me.medical.conditionStatus, me.medical.records.length]; },
    viewBefore: ['unknown', 0], viewAfter: ['fully_fit', 1],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- guardian ID verification + its audit entry
await test('guardian ID verification: the provider is asked first, outside any transaction; then the idVerified column and the audit-queue entry (a blob) commit together before the 200 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s4wa-idv'); let S = await boot(dir);
  const gs = await S.j('POST', '/auth/guardian/signup', { name: 'Audit Parent', email: 'audit@example.test', password: 'synthetic-pass-1' }); assert.equal(gs.status, 201, JSON.stringify(gs.body));
  const gid = gs.body.guardianId; const token = gs.body.token;
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gid, code: gs.body.devEmailCode })).status, 200);
  S = await coupled(S, dir, {
    seam: 'guardian.verify_id.after_row',
    act: () => S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, token),
    dbState: () => ({ idVerified: q1(dir, 'SELECT id_verified AS v FROM guardians WHERE id = ?', gid).v, audit: blob(dir, 'idvQueue').filter((e) => e.guardianId === gid).map((e) => e.status) }),
    before: { idVerified: 0, audit: [] }, after: { idVerified: 1, audit: ['approved'] },
    view: async (X) => { const me = (await X.j('GET', '/guardian/me', undefined, token)).body; const admin = (await X.j('GET', '/admin/guardians', undefined, null, A)).body; return [me.idVerified, admin.idvQueue.filter((e) => e.guardianId === gid).map((e) => e.status)]; },
    viewBefore: [false, []], viewAfter: [true, ['approved']],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- programme selection + the reset of completed sessions
await test('programme selection: the track columns and the reset of the completed sessions (a facet) commit together before the 201 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s4wa-programme'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Programme Adult');
  assert.equal((await S.j('POST', '/player/programme', { track: 'attack' }, token)).status, 201);
  const done = await S.j('POST', '/player/programme/sessions/atk-sprint/complete', {}, token); assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(done.body.current.doneThisWeek, 1);
  // Completing a session is a facet-only write (no column): it is persisted by the next ordinary, debounced save (the S3 contract), so the pre-state is awaited in the database before the coupled operation is exercised.
  const completedInDb = () => q1(dir, 'SELECT COUNT(*) AS n FROM player_programme_completions WHERE player_id = ?', pid).n; // S5: rows
  for (let i = 0; i < 200 && completedInDb() !== 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(completedInDb(), 1, 'the completed session reached the database through the ordinary save');
  S = await coupled(S, dir, {
    seam: 'programme.select.after_row',
    act: () => S.j('POST', '/player/programme', { track: 'midfield' }, token),
    okStatus: 201,
    dbState: () => ({ track: q1(dir, 'SELECT programme_track AS t FROM players WHERE id = ?', pid).t, completed: completedInDb() }),
    before: { track: 'attack', completed: 1 }, after: { track: 'midfield', completed: 0 },
    view: async (X) => { const cur = (await X.j('GET', '/player/programme', undefined, token)).body.current; return [cur.track, cur.doneThisWeek]; },
    viewBefore: ['attack', 1], viewAfter: ['midfield', 0],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- Academy+ + its badge
await test('Academy+: the column and the badge (a facet) commit together before the 200 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s4wa-academy'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Academy Adult');
  S = await coupled(S, dir, {
    seam: 'academyplus.after_row',
    act: () => S.j('POST', '/player/academyplus', { enabled: true }, token),
    dbState: () => ({ academyPlus: q1(dir, 'SELECT academy_plus AS a FROM players WHERE id = ?', pid).a, badge: q1(dir, "SELECT COUNT(*) AS n FROM player_badges WHERE player_id = ? AND badge = 'Fresh Start'", pid).n > 0 }), // S5: rows of player_badges
    before: { academyPlus: 0, badge: false }, after: { academyPlus: 1, badge: true },
    view: async (X) => { const me = (await X.j('GET', '/player/me', undefined, token)).body; return [me.academyPlus, me.badges.includes('Fresh Start')]; },
    viewBefore: [false, false], viewAfter: [true, true],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- stats + the activity bookkeeping
await test('stats: the stat columns and the activity log (a facet) commit together before the 200 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s4wa-stats'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Stats Adult');
  S = await coupled(S, dir, {
    seam: 'stats.after_row',
    act: () => S.j('POST', '/player/stats', { goals: 3, appearances: 10 }, token),
    dbState: () => { const r = q1(dir, 'SELECT stats_goals AS g, stats_appearances AS a FROM players WHERE id = ?', pid); return { goals: r.g, appearances: r.a, activity: q1(dir, 'SELECT COUNT(*) AS n FROM player_activity_log WHERE player_id = ?', pid).n }; },
    before: { goals: null, appearances: null, activity: 0 }, after: { goals: 3, appearances: 10, activity: 1 },
    view: async (X) => { const me = (await X.j('GET', '/player/me', undefined, token)).body; return [me.stats?.goals ?? null, me.stats?.appearances ?? null]; },
    viewBefore: [null, null], viewAfter: [3, 10],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- squad release (an organisation facet, player columns, a vouch, the ledger, notifications)
await test('squad release: the organisation\'s squad (a facet), the player\'s availability and contract columns, the published reference (a blob) and the ledger row commit together before the 200 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s4wa-release'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Near Hackney', { lat: 51.55, lng: -0.02 });
  assert.equal((await S.j('POST', '/player/availability', { availability: 'not_seeking' }, token)).status, 200);
  const grass = await orgLogin(S, 'org-hackneymarsh', 'Pat', 'Manager', 'grassroots');
  const added = await S.j('POST', '/org/squad', { name: 'Near Hackney', position: 'ST', playerId: pid }, grass); assert.equal(added.status, 201, JSON.stringify(added.body));
  const entryId = added.body.entries.find((e) => e.playerId === pid).id;
  // Adding a squad entry is a facet-only write on the organisation (no column): the ordinary, debounced save persists it, so the pre-state is awaited in the database first.
  const onSquadInDb = () => (facets(dir, 'orgs', 'org-hackneymarsh').squad ?? []).some((e) => e.id === entryId);
  for (let i = 0; i < 200 && !onSquadInDb(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(onSquadInDb(), true, 'the squad entry reached the database through the ordinary save');
  const grassLogin = (X) => orgLogin(X, 'org-hackneymarsh', 'Pat', 'Manager', 'grassroots');
  S = await coupled(S, dir, {
    seam: 'squad.release.after_row',
    act: () => S.j('POST', `/org/squad/${entryId}/release`, { referenceText: 'A reliable, committed player all season.' }, grass),
    dbState: () => {
      const p = q1(dir, 'SELECT availability AS a, contract_status AS c FROM players WHERE id = ?', pid);
      return { availability: p.a, contract: p.c, onSquad: (facets(dir, 'orgs', 'org-hackneymarsh').squad ?? []).some((e) => e.id === entryId), vouches: blob(dir, 'vouches').filter((v) => v.playerId === pid).length, ledger: blob(dir, 'ledger').filter((l) => l.playerId === pid && l.type === 'released_by_club').length };
    },
    before: { availability: 'not_seeking', contract: 'unknown', onSquad: true, vouches: 0, ledger: 0 },
    after: { availability: 'available_now', contract: 'free_agent', onSquad: false, vouches: 1, ledger: 1 },
    view: async (X) => { const g = await grassLogin(X); const squad = (await X.j('GET', '/org/squad', undefined, g)).body; const me = (await X.j('GET', '/player/me', undefined, token)).body; return [squad.entries.some((e) => e.id === entryId), me.availability, me.contractStatus]; },
    viewBefore: [true, 'not_seeking', 'unknown'], viewAfter: [false, 'available_now', 'free_agent'],
  });
  await S.stop(); rm(dir);
});

// ============================================================= S5: the sub-record tables
// Since S5 every array of the player record is rows of its own table. The
// writers below couple a row of one sub-record table with rows of others (and
// with blobs); the same contract as above is proven through the real routes.
const qAll = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const rows = (dir, table, pid) => q1(dir, `SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`, pid).n;

// ------------------------------------------------------------- media upload + the activity it records; then the club's tags + the ledger
await test('media upload (S5): the clip row (player_media) and the activity row it records commit together before the 201 — second connection, SIGKILL, both failure seams, retry; then a club\'s tags: the tag rows (player_media_tags) and the ledger row commit together, a failure of the real COMMIT leaves neither, the retry lands both, the player\'s aggregated view and the served file agree after a restart', async () => {
  const dir = tempDir('s5wa-media'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Media Adult');
  // (The bytes are written to disk before the unit, as before S5: a refused
  // unit leaves an unreferenced file, which nothing serves — unchanged
  // behaviour, out of S5's scope. Only the rows are the contract here.)
  S = await coupled(S, dir, {
    seam: 'media.after_row',
    act: () => S.j('POST', '/player/media', { title: 'Synthetic clip', kind: 'video', dataUrl: 'data:video/webm;base64,AAAAAAAA' }, token),
    okStatus: 201,
    dbState: () => ({ media: rows(dir, 'player_media', pid), activity: rows(dir, 'player_activity_log', pid), titles: qAll(dir, 'SELECT title, url IS NOT NULL AS has_url FROM player_media WHERE player_id = ? ORDER BY position', pid) }),
    before: { media: 0, activity: 0, titles: [] },
    after: { media: 1, activity: 1, titles: [{ title: 'Synthetic clip', has_url: 1 }] }, // the url carries the minted id: compared below
    view: async (X) => { const me = (await X.j('GET', '/player/me', undefined, token)).body; return me.media.map((m) => [m.title, m.views, m.tags]); },
    viewBefore: [], viewAfter: [['Synthetic clip', 0, {}]],
  });
  const mediaId = q1(dir, 'SELECT id, url FROM player_media WHERE player_id = ?', pid);
  assert.equal(mediaId.url, `/media/${mediaId.id}`);
  assert.equal((await S.j('GET', `/media/${mediaId.id}`, undefined, token)).status, 200, 'the file is served to its owner after the restart (ownership read from player_media)');
  // The club tags the clip: tag rows + ledger row in one unit.
  const pro = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const tagAct = () => S.j('POST', `/org/players/${pid}/media/${mediaId.id}/tags`, { tags: ['pace', 'vision', 'pace'] }, pro);
  const tagState = () => ({ tags: qAll(dir, 'SELECT tag, count FROM player_media_tags WHERE media_id = ? ORDER BY position', mediaId.id), ledger: blob(dir, 'ledger').filter((l) => l.type === 'clip_tagged' && l.playerId === pid).length });
  const tagView = async (X) => (await X.j('GET', '/player/me', undefined, token)).body.media[0].tags;
  await refusedBy(S, COMMIT_SEAM, tagAct, async (label) => { assert.deepEqual(tagState(), { tags: [], ledger: 0 }, `${label}: no tag row, no ledger row`); assert.deepEqual(await tagView(S), {}, `${label}: memory restored`); }, COMMIT_LOG);
  const tagged = await tagAct(); assert.equal(tagged.status, 200, JSON.stringify(tagged.body)); assert.deepEqual(tagged.body.tags, { pace: 2, vision: 1 });
  assert.deepEqual(tagState(), { tags: [{ tag: 'pace', count: 2 }, { tag: 'vision', count: 1 }], ledger: 1 }, 'tag rows and the ledger row are committed when the response is sent');
  assert.deepEqual(await tagView(S), { pace: 2, vision: 1 });
  await S.kill();
  assert.deepEqual(tagState(), { tags: [{ tag: 'pace', count: 2 }, { tag: 'vision', count: 1 }], ledger: 1 }, 'a SIGKILL right after the response loses nothing');
  S = await boot(dir);
  assert.deepEqual(await tagView(S), { pace: 2, vision: 1 }, 'a restart serves the tags from their rows');
  assert.equal((await S.j('GET', `/media/${mediaId.id}`, undefined, token)).status, 200);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- verified attendance + activity + the Turnstile badge + the ledger
await test('verified attendance (S5): the attendance row (GPS kept), the activity row, the Turnstile badge row and the ledger row commit together before the 201 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s5wa-attendance'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Attendance Adult');
  S = await coupled(S, dir, {
    seam: 'attendance.after_row',
    act: () => S.j('POST', '/player/attendance', { fixture: 'Synthetic FC v Test Town', venue: 'Test Park', date: '2026-10-10', gps: { lat: 51.5, lng: -0.1 }, deviceId: 'dev-synthetic' }, token),
    okStatus: 201,
    dbState: () => ({ attendance: qAll(dir, 'SELECT fixture, lat, lng, verified, device_confirmed FROM player_attendance WHERE player_id = ? ORDER BY position', pid), activity: rows(dir, 'player_activity_log', pid), badges: qAll(dir, 'SELECT badge FROM player_badges WHERE player_id = ? ORDER BY position', pid).map((b) => b.badge), ledger: blob(dir, 'ledger').filter((l) => l.type === 'attendance_verified' && l.playerId === pid).length }),
    before: { attendance: [], activity: 0, badges: [], ledger: 0 },
    after: { attendance: [{ fixture: 'Synthetic FC v Test Town', lat: 51.5, lng: -0.1, verified: 1, device_confirmed: 1 }], activity: 1, badges: ['Turnstile'], ledger: 1 },
    view: async (X) => { const me = (await X.j('GET', '/player/me', undefined, token)).body; return [me.attendance.map((a) => [a.fixture, a.gps]), me.badges]; },
    viewBefore: [[], []], viewAfter: [[['Synthetic FC v Test Town', { lat: 51.5, lng: -0.1 }]], ['Turnstile']],
  });
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- drill completion + its result + activity
await test('drill completion (S5): the drill row, the result row and the activity row commit together before the 200 — second connection, SIGKILL, both failure seams, retry', async () => {
  const dir = tempDir('s5wa-drills'); let S = await boot(dir);
  const { pid, token } = await signupAdult(S, 'Drill Adult');
  S = await coupled(S, dir, {
    seam: 'drills.complete.after_row',
    act: () => S.j('POST', '/player/drills/drill-sprint-ladder/complete', { value: 4.1 }, token),
    dbState: () => ({ drills: qAll(dir, 'SELECT drill_id FROM player_drills WHERE player_id = ? ORDER BY position', pid).map((d) => d.drill_id), results: qAll(dir, 'SELECT drill_id, value, verified FROM player_drill_results WHERE player_id = ? ORDER BY position', pid), activity: rows(dir, 'player_activity_log', pid) }),
    before: { drills: [], results: [], activity: 0 },
    after: { drills: ['drill-sprint-ladder'], results: [{ drill_id: 'drill-sprint-ladder', value: 4.1, verified: 0 }], activity: 1 },
    view: async (X) => { const d = (await X.j('GET', '/player/drills', undefined, token)).body.find((x) => x.id === 'drill-sprint-ladder'); return [d.completed, d.best?.value ?? null]; },
    viewBefore: [false, null], viewAfter: [true, 4.1],
  });
  await S.stop(); rm(dir);
});

console.log(`\n${passed} writer-atomicity checks passed`);
