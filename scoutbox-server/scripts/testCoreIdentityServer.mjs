// S4a through the REAL server (server.mjs booted as a child process on
// temporary data directories with synthetic records only): every boot case of
// the readiness review §9 — a new installation, a previously saved file, an
// intentionally empty domain, an interrupted first installation, a migrated
// file without blobs, stale blobs, malformed input, the Founder's legacy-minor
// refusal — each restarted; the converted writers through their real routes and
// after a restart; the audience allowlists on actual HTTP responses; the
// crash-safe media-deletion queue; the admin backup and a restore into a fresh
// directory. Nothing here touches DATA_DIR or any real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { buildSeed } from '../seed.mjs';
import { pickPort } from './testPort.mjs';
import { NOW, tempDir, adult, child, gPrimary, gSignup, FIXTURE, s3File, freshFile, migrate, openRaw, S3_MIGRATIONS, TTL } from './coreIdentityTestFixtures.mjs';
import { runDataMigrations } from '../repositories/database.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
async function test(name, fn) { if (only && !name.includes(only)) return; await fn(); passed++; console.log(`  ✓ ${name}`); }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const A = { 'x-admin-key': 'scoutbox-admin' };
const BASE = pickPort(7700, 200, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
let portSeq = 0;
const nextPort = () => BASE + (portSeq++ % 10);

/** Boot the real server on `dir`; resolves once it listens, rejects if it exits first (with the log and the exit code). */
function boot(dir, port, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
/** Boot and expect the process to refuse (exit before listening); returns { code, log }. */
async function bootRefuses(dir, port) {
  try { const S = await boot(dir, port); await S.kill(); throw new Error(`the server booted but must have refused: ${S.log().slice(-600)}`); }
  catch (err) { if (typeof err.code !== 'number') throw err; return { code: err.code, log: err.log }; }
}
const raw = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); return s; };
const q1 = (dir, sql, ...p) => { const s = raw(dir); try { return s.prepare(sql).get(...p); } finally { s.close(); } };
const qAll = (dir, sql, ...p) => { const s = raw(dir); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const blobNames = (dir) => qAll(dir, 'SELECT name FROM collections ORDER BY name').map((r) => r.name);
const identityCounts = (dir) => ({ players: q1(dir, 'SELECT COUNT(*) AS n FROM players').n, guardians: q1(dir, 'SELECT COUNT(*) AS n FROM guardians').n, links: q1(dir, 'SELECT COUNT(*) AS n FROM guardian_children').n });
const SEED = buildSeed();
const seedCounts = { players: SEED.players.length, guardians: SEED.guardians.length, links: SEED.guardians.reduce((n, g) => n + g.childIds.length, 0) };
const orgLogin = async (S, orgId, scoutName = 'Maria Keane', role = 'Head of Recruitment', platform) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) }); assert.equal(r.status, 200, `org login ${orgId}: ${JSON.stringify(r.body)}`); return r.body.token; };
const expectKeys = (obj, allowed, forbidden, label) => {
  for (const k of allowed) assert.ok(k in obj, `${label}: ${k} is served`);
  for (const k of forbidden) assert.equal(k in obj, false, `${label}: ${k} must not be served`);
};

// ------------------------------------------------------------- a new installation
await test('new installation: the seed is initialised once (never again), served from the tables, no identity blob is written; a sign-up before the restart is a row at once and still there after it (no re-seed, no duplicate)', async () => {
  const dir = tempDir('s4srv-new');
  let S = await boot(dir, nextPort());
  assert.match(S.log(), /initialised from the first installation's records/);
  let cap = (await S.j('GET', '/capabilities')).body;
  assert.deepEqual(cap.dataLayer.migrations, ['0001_org_users', '0002_core_identity_shadow', '0003_sessions_live', '0004_orgs_live', '0005_core_identity_live', '0006_media_deletions']);
  assert.equal(cap.dataLayer.identity.initState, 'done'); assert.equal(cap.dataLayer.domains.players.mode, 'live');
  assert.equal(cap.dataLayer.domains.players.rows, seedCounts.players); assert.equal(cap.dataLayer.domains.guardians.rows, seedCounts.guardians);
  assert.equal(cap.core_identity_storage?.state ?? cap.dataLayer.domains.players.mode, 'live');
  const signup = await S.j('POST', '/auth/player/signup', { name: 'Row At Once', dob: '2001-05-05', country: 'GB', position: 'ST', password: 'longenough-1' });
  assert.equal(signup.status, 201, JSON.stringify(signup.body)); const newId = signup.body.playerId;
  assert.equal(q1(dir, 'SELECT name FROM players WHERE id = ?', newId).name, 'Row At Once', 'the row is committed before the response (a second connection reads it)');
  assert.equal(signup.body.player.password, undefined);
  await S.stop();
  assert.deepEqual(identityCounts(dir), { players: seedCounts.players + 1, guardians: seedCounts.guardians, links: seedCounts.links });
  assert.ok(!blobNames(dir).includes('players') && !blobNames(dir).includes('guardians'), 'no identity blob');
  S = await boot(dir, nextPort());
  assert.doesNotMatch(S.log(), /initialised from the first installation's records/, 'a restart never initialises again');
  cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.domains.players.rows, seedCounts.players + 1, 'the seed was not re-imported over the tables');
  const login = await S.j('POST', '/auth/player/login', { playerId: newId, password: 'longenough-1' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const me = (await S.j('GET', '/player/me', undefined, login.body.token)).body;
  assert.equal(me.name, 'Row At Once'); assert.equal('password' in me, false); assert.equal(me.dob, '2001-05-05');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- a previously saved file (the cutover at boot)
await test('previously saved file: an S3-shaped database (the seed saved as blobs, migrations 0001–0004) cuts over at boot — rows, links, blobs retired — and a restart attaches to the tables; a migrated file whose blobs are gone boots the same way (no seed fallback)', async () => {
  const dir = tempDir('s4srv-saved');
  openStore(dir).save({ savedAt: NOW, idCounter: 2000, db: SEED });
  { const s = openRaw(dir); runDataMigrations(s, S3_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }); s.close(); }
  let S = await boot(dir, nextPort());
  assert.match(S.log(), /14 players in the blob/, 'the first boot still loads the blob (the cutover runs in the data layer right after)'); assert.doesNotMatch(S.log(), /initialised from the first installation/);
  let cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.identity.initState, 'done'); assert.equal(cap.dataLayer.domains.players.rows, seedCounts.players);
  assert.deepEqual(identityCounts(dir), seedCounts); assert.ok(!blobNames(dir).includes('players'));
  const token = await orgLogin(S, 'org-eastport');
  const p = await S.j('GET', '/org/players/pl-adeyemi', undefined, token);
  assert.equal(p.status, 200); assert.equal(p.body.name, 'Kola Adeyemi');
  await S.stop();
  S = await boot(dir, nextPort());
  assert.match(S.log(), /players table-backed/, 'the restart finds no blob and attaches to the tables');
  cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.domains.players.rows, seedCounts.players);
  assert.equal((await S.j('GET', '/org/players/pl-adeyemi', undefined, token)).status, 200, 'the staff session minted before the restart is still valid');
  await S.stop(); rm(dir);
  // A file migrated offline (no server): the blobs are gone, the server attaches and serves the records.
  const mig = tempDir('s4srv-migrated'); s3File(mig);
  { const s = openRaw(mig); migrate(s, { now: NOW }); s.close(); }
  assert.ok(!blobNames(mig).includes('players'));
  S = await boot(mig, nextPort());
  assert.match(S.log(), /players table-backed/);
  cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.domains.players.rows, 5); assert.equal(cap.dataLayer.domains.guardians.rows, 3);
  const t2 = await orgLogin(S, 'org-pro', 'Maria');
  assert.equal((await S.j('GET', '/org/players/pl-seeded', undefined, t2)).body.name, 'Seeded Adult');
  await S.stop(); rm(mig);
});

// ------------------------------------------------------------- intentionally empty
await test('intentionally empty: a saved file whose players and guardians are empty arrays stays empty through the cutover and every restart — the seed is never imported into it', async () => {
  const dir = tempDir('s4srv-empty');
  openStore(dir).save({ savedAt: NOW, idCounter: 2000, db: { ...SEED, players: [], guardians: [] } });
  { const s = openRaw(dir); runDataMigrations(s, S3_MIGRATIONS, { now: NOW, context: { sessionTtlMs: TTL } }); s.close(); }
  for (let i = 0; i < 2; i++) {
    const S = await boot(dir, nextPort());
    const cap = (await S.j('GET', '/capabilities')).body;
    assert.equal(cap.dataLayer.identity.initState, 'done'); assert.equal(cap.dataLayer.domains.players.rows, 0); assert.equal(cap.dataLayer.domains.guardians.rows, 0);
    const token = await orgLogin(S, 'org-eastport');
    assert.equal((await S.j('GET', '/org/players/pl-adeyemi', undefined, token)).status, 404, `boot ${i + 1}: no seed player exists`);
    await S.stop();
    assert.deepEqual(identityCounts(dir), { players: 0, guardians: 0, links: 0 });
  }
  rm(dir);
});

// ------------------------------------------------------------- an interrupted first installation
await test('interrupted first installation: a database where migration 0005 recorded the pending state but the process died before the initialisation — the next boot initialises from the seed exactly once; the boot after that attaches', async () => {
  const dir = tempDir('s4srv-pending'); freshFile(dir);
  { const s = openRaw(dir); migrate(s, { now: NOW }); assert.equal(s.prepare("SELECT value FROM meta WHERE key = 'coreIdentityInit'").get().value, 'pending'); s.close(); }
  let S = await boot(dir, nextPort());
  assert.match(S.log(), /initialised from the first installation's records/);
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.domains.players.rows, seedCounts.players);
  await S.stop();
  assert.equal(q1(dir, "SELECT value FROM meta WHERE key = 'coreIdentityInit'").value, 'done');
  S = await boot(dir, nextPort());
  assert.doesNotMatch(S.log(), /initialised from the first installation/);
  assert.deepEqual(identityCounts(dir), seedCounts);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- stale blobs after the cutover
await test('stale blobs: a players/guardians blob re-inserted into a cut-over file (an old backup half-restored by hand) is reported and ignored at boot, never imported, and removed again by the next save', async () => {
  const dir = tempDir('s4srv-stale'); s3File(dir);
  { const s = openRaw(dir); migrate(s, { now: NOW }); s.close(); }
  { const s = new DatabaseSync(path.join(dir, 'scoutbox.db')); s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)').run('players', JSON.stringify([{ ...adult(), id: 'pl-stale', name: 'Stale Blob Player' }])); s.prepare('INSERT INTO collections (name, value) VALUES (?, ?)').run('guardians', JSON.stringify([{ ...gSignup(), id: 'gd-stale', email: 'stale@example.test' }])); s.close(); }
  const S = await boot(dir, nextPort());
  assert.match(S.log(), /players table holds 5 row\(s\) and is authoritative; an in-memory array with 1 record\(s\) the table does not hold was ignored/);
  const cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.domains.players.rows, 5); assert.equal(cap.dataLayer.domains.guardians.rows, 3);
  const token = await orgLogin(S, 'org-pro', 'Maria');
  assert.equal((await S.j('GET', '/org/players/pl-stale', undefined, token)).status, 404, 'the stale record was not resurrected');
  await S.stop();
  assert.ok(!blobNames(dir).includes('players') && !blobNames(dir).includes('guardians'), 'the save on shutdown removed the stale blobs');
  assert.equal(q1(dir, "SELECT COUNT(*) AS n FROM players WHERE id = 'pl-stale'").n, 0);
  rm(dir);
});

// ------------------------------------------------------------- malformed input and the Founder's rule
await test('malformed input and the legacy-minor rule: a players blob that is not an array, and a saved file with a legacy minor who has no guardian link, both stop the boot with the reason (ids, never records) and leave the file byte-for-byte as it was; the next boot refuses the same way', async () => {
  const bad = tempDir('s4srv-malformed'); s3File(bad, { rawBlobs: { players: '{"id":"pl-object"}' } });
  const badBefore = fs.readFileSync(path.join(bad, 'scoutbox.db'));
  for (let i = 0; i < 2; i++) {
    const r = await bootRefuses(bad, nextPort());
    assert.notEqual(r.code, 0); assert.match(r.log, /SNAPSHOT_INVALID: the saved players collection is object, not an array|players: the saved players blob is an object, not an array/);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(bad, 'scoutbox.db')), badBefore), 0, `boot ${i + 1}: the file is untouched`);
  }
  const orphan = tempDir('s4srv-orphan'); const fx = FIXTURE(); fx.players.push(child('pl-orphan', null, '2013-04-04'));
  s3File(orphan, { players: fx.players, guardians: fx.guardians });
  const before = fs.readFileSync(path.join(orphan, 'scoutbox.db'));
  for (let i = 0; i < 2; i++) {
    const r = await bootRefuses(orphan, nextPort());
    assert.notEqual(r.code, 0); assert.match(r.log, /CORE_IDENTITY_CUTOVER_BLOCKED/); assert.match(r.log, /legacy minors without any guardian link .*: pl-orphan/);
    assert.equal(r.log.includes('2013-04-04'), false, 'ids, not records, in the log');
    assert.equal(Buffer.compare(fs.readFileSync(path.join(orphan, 'scoutbox.db')), before), 0, `boot ${i + 1}: the file is untouched`);
  }
  assert.equal(q1(orphan, "SELECT COUNT(*) AS n FROM data_migrations WHERE id = '0005_core_identity_live'").n, 0);
  rm(bad, orphan);
});

// ------------------------------------------------------------- the converted writers, through their routes
await test('writers: guardian sign-up, e-mail verification, ID verification, disclaimer and child creation write rows and the link; football category (m12), the audited level review (m13), medical sharing and aging-up write columns; every change is a committed row before the response and is there after a restart', async () => {
  const dir = tempDir('s4srv-writers'); s3File(dir); // FIXTURE: pl-grown is an adult still linked to gd-primary
  let S = await boot(dir, nextPort());
  const gs = await S.j('POST', '/auth/guardian/signup', { name: 'New Parent', email: 'newparent@example.test', password: 'parent-pass-1' });
  assert.equal(gs.status, 201, JSON.stringify(gs.body)); const gid = gs.body.guardianId; const gtok = gs.body.token;
  assert.ok(gs.body.devEmailCode && !('emailCode' in gs.body.guardian) && !('password' in gs.body.guardian));
  assert.equal(q1(dir, 'SELECT email_verified FROM guardians WHERE id = ?', gid).email_verified, 0);
  assert.equal((await S.j('POST', '/auth/guardian/signup', { name: 'Dup', email: 'NEWPARENT@example.test', password: 'parent-pass-1' })).status, 409, 'the e-mail is unique regardless of case');
  assert.equal((await S.j('POST', '/guardian/children', { name: 'Too Early', dob: '2016-01-01' }, gtok)).status, 403, 'no child before the gates');
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gid, code: 'WRONG0' })).status, 400);
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gid, code: gs.body.devEmailCode })).status, 200);
  assert.equal(q1(dir, 'SELECT email_verified FROM guardians WHERE id = ?', gid).email_verified, 1); assert.equal(JSON.parse(q1(dir, 'SELECT facets_json FROM guardians WHERE id = ?', gid).facets_json).emailCode, null, 'the code is gone with the column change');
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, gtok)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, gtok)).status, 200);
  assert.deepEqual([q1(dir, 'SELECT id_verified FROM guardians WHERE id = ?', gid).id_verified, q1(dir, 'SELECT disclaimer_accepted FROM guardians WHERE id = ?', gid).disclaimer_accepted], [1, 1]);
  const kid = await S.j('POST', '/guardian/children', { name: 'New Kid', dob: '2016-01-01', position: 'GK' }, gtok);
  assert.equal(kid.status, 201, JSON.stringify(kid.body)); const kidId = kid.body.playerId ?? kid.body.player?.id ?? kid.body.id;
  assert.equal(q1(dir, 'SELECT guardian_id FROM players WHERE id = ?', kidId).guardian_id, gid);
  assert.deepEqual(qAll(dir, 'SELECT guardian_id, role FROM guardian_children WHERE player_id = ?', kidId), [{ guardian_id: gid, role: 'primary' }]);
  const children = (await S.j('GET', '/guardian/children', undefined, gtok)).body;
  assert.equal(children.length, 1); assert.equal(children[0].id, kidId); assert.equal(children[0].dob, '2016-01-01'); assert.equal('password' in children[0], false);
  assert.equal((await S.j('POST', '/guardian/children', { name: 'An Adult', dob: '2000-01-01' }, gtok)).status, 400, 'NOT_A_MINOR');
  // An adult signs up; m12 football category; medical sharing; m13 level review (admin).
  const ps = await S.j('POST', '/auth/player/signup', { name: 'Writer Adult', dob: '2000-06-06', country: 'GB', password: 'writer-pass-1' });
  assert.equal(ps.status, 201); const pid = ps.body.playerId; const ptok = ps.body.token;
  assert.equal((await S.j('POST', '/player/football-category', { category: 'mens' }, ptok)).status, 200);
  assert.equal(q1(dir, 'SELECT football_category FROM players WHERE id = ?', pid).football_category, 'mens');
  assert.equal((await S.j('POST', '/player/football-category', { category: 'nope' }, ptok)).status, 400);
  assert.equal((await S.j('POST', '/player/medical/share', { shared: true }, ptok)).status, 200);
  assert.equal(q1(dir, 'SELECT medical_shared FROM players WHERE id = ?', pid).medical_shared, 1);
  const lr = await S.j('POST', `/admin/players/${pid}/level-review`, { level: 'semi_pro', reason: 'synthetic review' }, null, A);
  assert.equal(lr.status, 200, JSON.stringify(lr.body)); assert.equal(q1(dir, 'SELECT level FROM players WHERE id = ?', pid).level, 'semi_pro');
  assert.equal((await S.j('POST', `/admin/players/${pid}/level-review`, { level: 'pro' }, null, A)).status, 400, 'the reason is required; nothing written');
  assert.equal(q1(dir, 'SELECT level FROM players WHERE id = ?', pid).level, 'semi_pro');
  // Aging-up: pl-grown (an adult the cutover left linked to gd-primary) takes ownership; both sides of the link go together.
  const grown = await S.j('POST', '/auth/player/login', { playerId: 'pl-grown' });
  assert.equal(grown.status, 200, JSON.stringify(grown.body));
  assert.equal((await S.j('GET', '/player/me', undefined, grown.body.token)).body.agingUp?.eligible, true);
  assert.equal((await S.j('POST', '/player/aging-up/complete', {}, grown.body.token)).status, 200);
  assert.equal(q1(dir, "SELECT guardian_id FROM players WHERE id = 'pl-grown'").guardian_id, null);
  assert.equal(q1(dir, "SELECT COUNT(*) AS n FROM guardian_children WHERE player_id = 'pl-grown'").n, 0);
  assert.equal((await S.j('POST', '/player/aging-up/complete', {}, grown.body.token)).status, 400, 'ALREADY_OWNED');
  await S.stop();
  // After a restart every write is still there and the sessions still work.
  S = await boot(dir, nextPort());
  const me = (await S.j('GET', '/player/me', undefined, ptok)).body;
  assert.equal(me.footballCategory, 'mens'); assert.equal(me.level, 'semi_pro'); assert.equal(me.medical.shared, true);
  const kids = (await S.j('GET', '/guardian/children', undefined, gtok)).body;
  assert.deepEqual(kids.map((k) => k.id), [kidId]);
  const admin = (await S.j('GET', '/admin/guardians', undefined, null, A)).body;
  assert.deepEqual([...admin.guardians.find((g) => g.id === 'gd-primary').childIds], ['pl-child1', 'pl-child2'], 'pl-grown is no longer listed by its former guardian');
  assert.deepEqual([...admin.guardians.find((g) => g.id === gid).childIds], [kidId]);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- audience allowlists on the wire
await test('allowlists (actual HTTP responses): a verified club sees the adult and the minor fields of §6.1 and never dob/location/password/guardianId/notificationPrefs/attendance GPS/other clubs\' reports; an agency and an unverified club are walled from a minor; a blocked club reads absent; grassroots gets its own surface; the guardian, the player and Trust & Safety get theirs without hashes or codes', async () => {
  const dir = tempDir('s4srv-views');
  const S = await boot(dir, nextPort()); // the seed: a verified pro club, an unverified academy, an agency, two grassroots clubs
  const pro = await orgLogin(S, 'org-eastport');
  const adultView = (await S.j('GET', '/org/players/pl-adeyemi', undefined, pro)).body;
  expectKeys(adultView, ['id', 'name', 'position', 'foot', 'country', 'city', 'level', 'availability', 'contractStatus', 'identityVerified', 'stats', 'media', 'timeline', 'badges', 'attendance', 'age', 'profileSignal', 'trustScore', 'guardianManaged', 'medical', 'trialReports', 'academyPlus'], ['dob', 'location', 'password', 'guardianId', 'notificationPrefs', 'programme', 'activityLog', 'drillResults', 'externalIds', 'importClaims'], 'club/adult');
  assert.equal(adultView.guardianManaged, false); assert.equal(adultView.city, 'Manchester');
  assert.ok(adultView.attendance.length > 0 && adultView.attendance.every((a) => !('gps' in a)), 'attendance without the GPS fix');
  assert.deepEqual(adultView.medical, { shared: false, records: [], conditionStatus: 'not_shared', note: 'Medical data is player-controlled and has not been shared.' });
  assert.ok(adultView.trialReports.every((r) => r.orgId === 'org-eastport'), 'only this club\'s own reports');
  const minorView = (await S.j('GET', '/org/players/pl-guni', undefined, pro)).body;
  assert.equal(minorView.guardianManaged, true); assert.equal(minorView.city, ''); assert.equal(minorView.contactPolicy, 'guardian_only');
  expectKeys(minorView, ['id', 'name', 'age'], ['dob', 'guardianId', 'location', 'password'], 'club/minor');
  const agency = await orgLogin(S, 'org-northstar', 'Ava', 'Agent');
  assert.deepEqual((await S.j('GET', '/org/players/pl-guni', undefined, agency)).status, 403, 'an agency never sees a minor');
  assert.equal((await S.j('GET', '/org/players/pl-guni', undefined, agency)).body.error, 'UNDER_18_WALL');
  const unverified = await orgLogin(S, 'org-harbour', 'Sam', 'Scout');
  assert.equal((await S.j('GET', '/org/players/pl-guni', undefined, unverified)).body.error, 'VERIFIED_CLUBS_ONLY');
  assert.equal((await S.j('GET', '/org/players/pl-adeyemi', undefined, unverified)).status, 200, 'an unverified club still sees an adult');
  // Grassroots: its own surface, and only for players inside its radius.
  const near = await S.j('POST', '/auth/player/signup', { name: 'Near Hackney', dob: '2002-02-02', country: 'GB', password: 'near-pass-11', lat: 51.55, lng: -0.02 });
  assert.equal(near.status, 201);
  const grass = await orgLogin(S, 'org-hackneymarsh', 'Pat', 'Manager', 'grassroots');
  const gv = (await S.j('GET', `/org/players/${near.body.playerId}`, undefined, grass)).body;
  expectKeys(gv, ['id', 'name', 'distanceKm', 'firstTeamSeeker', 'vouches'], ['academyPlus', 'marketValueRange', 'agentName', 'contractUntil', 'dob', 'location'], 'grassroots');
  assert.equal(typeof gv.distanceKm, 'number'); assert.equal(typeof gv.firstTeamSeeker, 'boolean');
  assert.equal((await S.j('GET', '/org/players/pl-adeyemi', undefined, grass)).status, 403, 'outside the radius: not visible on Grassroots');
  // Blocked: the player blocks the pro club; the club reads absent (404), the shortlist that named them no longer lists them.
  assert.equal((await S.j('POST', `/org/players/${near.body.playerId}/shortlist`, {}, pro)).status, 201);
  assert.equal((await S.j('POST', '/player/block', { orgId: 'org-eastport', reason: 'synthetic' }, near.body.token)).status, 201);
  assert.equal((await S.j('GET', `/org/players/${near.body.playerId}`, undefined, pro)).status, 404);
  assert.ok(!(await S.j('GET', '/org/shortlist', undefined, pro)).body.some((p) => p.id === near.body.playerId));
  // The guardian's view of the child: the record minus the password hash; the guardian's own record minus hash and code.
  const gl = await S.j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' });
  assert.equal(gl.status, 200, JSON.stringify(gl.body));
  const kids = (await S.j('GET', '/guardian/children', undefined, gl.body.token)).body;
  const guni = kids.find((k) => k.id === 'pl-guni');
  expectKeys(guni, ['dob', 'medical', 'guardianId', 'age', 'trustScore', 'trust'], ['password'], 'guardian/child');
  const gme = (await S.j('GET', '/guardian/me', undefined, gl.body.token)).body;
  expectKeys(gme, ['id', 'name', 'email', 'childIds'], ['password', 'emailCode'], 'guardian/self');
  // The player's own view: minus the password hash.
  const pl = await S.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' });
  const me = (await S.j('GET', '/player/me', undefined, pl.body.token)).body;
  expectKeys(me, ['dob', 'location', 'medical', 'notificationPrefs'], ['password'], 'player/self');
  // Trust & Safety: the guardian allowlist — never the hash, never the outstanding code.
  const gs = await S.j('POST', '/auth/guardian/signup', { name: 'Code Pending', email: 'pending@example.test', password: 'pending-pass-1' });
  assert.equal(gs.status, 201);
  const admin = (await S.j('GET', '/admin/guardians', undefined, null, A)).body;
  const pending = admin.guardians.find((g) => g.id === gs.body.guardianId);
  expectKeys(pending, ['id', 'name', 'email', 'emailVerified', 'idVerified', 'disclaimerAccepted', 'childIds'], ['password', 'emailCode'], 'admin/guardian');
  assert.equal(JSON.stringify(admin).includes(gs.body.devEmailCode), false, 'the code appears nowhere in the Trust & Safety response');
  assert.equal(JSON.stringify(admin).includes('scrypt'), false);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- deletion, the media queue, the shortlist reader
await test('deletion: the player row, the links, the sessions and the media-removal entries commit as one unit; the file goes after COMMIT; when the file cannot be removed the entry stays, /media/:id answers 404 while it is queued, the rollback tool refuses (exit 8), the next boot retries and clears it; a shortlisted player who deleted their account is absent from the shortlist, not a crash', async () => {
  const dir = tempDir('s4srv-delete');
  let S = await boot(dir, nextPort());
  const mk = async (name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2001-01-01', country: 'GB', password: 'delete-pass-1' }); assert.equal(r.status, 201); const m = await S.j('POST', '/player/media', { title: 'Clip', kind: 'video', dataUrl: 'data:video/webm;base64,AAAAAAAA' }, r.body.token); assert.equal(m.status, 201, JSON.stringify(m.body)); return { id: r.body.playerId, token: r.body.token, mediaId: m.body.media.id }; };
  const a = await mk('Deleted Cleanly'); const b = await mk('Deleted With Stuck File');
  for (const x of [a, b]) assert.ok(fs.existsSync(path.join(dir, 'media', `${x.mediaId}.webm`)));
  assert.equal((await S.j('GET', `/media/${a.mediaId}`, undefined, a.token)).status, 200);
  const pro = await orgLogin(S, 'org-eastport');
  assert.equal((await S.j('POST', `/org/players/${a.id}/shortlist`, {}, pro)).status, 201);
  assert.equal((await S.j('POST', `/org/players/${b.id}/shortlist`, {}, pro)).status, 201);
  // (a) the clean path: the file is gone right after the response, nothing queued.
  assert.equal((await S.j('DELETE', '/player/account', undefined, a.token)).status, 200);
  assert.equal(fs.existsSync(path.join(dir, 'media', `${a.mediaId}.webm`)), false);
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', a.id).n, 0); assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0);
  assert.equal((await S.j('GET', '/player/me', undefined, a.token)).status, 401, 'the session was revoked in the same unit');
  assert.equal((await S.j('GET', `/media/${a.mediaId}`, undefined, pro)).status, 401, 'no owner: not served');
  // (b) the stuck path: a directory sits where the file was (unlink fails with something other than ENOENT).
  const stuck = path.join(dir, 'media', `${b.mediaId}.webm`); fs.rmSync(stuck); fs.mkdirSync(stuck);
  assert.equal((await S.j('DELETE', '/player/account', undefined, b.token)).status, 200);
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', b.id).n, 0, 'the row went (the unit committed)');
  assert.deepEqual(qAll(dir, 'SELECT media_id, player_id, attempts FROM media_deletions'), [{ media_id: b.mediaId, player_id: b.id, attempts: 1 }], 'the entry stays with the failed attempt');
  assert.match(S.log(), /could not be removed \(attempt 1\)/);
  assert.equal((await S.j('GET', `/media/${b.mediaId}`, undefined, pro)).status, 404, '404 while queued, whatever the session');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.mediaDeletions.queued, 1);
  const shortlist = await S.j('GET', '/org/shortlist', undefined, pro);
  assert.equal(shortlist.status, 200); assert.deepEqual(shortlist.body.filter((p) => [a.id, b.id].includes(p.id)), [], 'deleted players are absent, the reader does not crash');
  await S.stop();
  // The rollback tool refuses while the queue is not empty.
  const out = tempDir('s4srv-delete-rb');
  try { execFileSync(process.execPath, [path.join(HERE, 'coreIdentityRollback.mjs'), dir, path.join(out, 'copy')], { stdio: 'pipe' }); assert.fail('must refuse'); } catch (err) { assert.equal(err.status, 8); }
  // The next boot retries: still stuck → still queued (attempt 2); unstuck → absent → cleared.
  S = await boot(dir, nextPort());
  assert.equal(q1(dir, 'SELECT attempts FROM media_deletions WHERE media_id = ?', b.mediaId).attempts, 2);
  assert.equal((await S.j('GET', `/media/${b.mediaId}`, undefined, pro)).status, 404);
  await S.stop();
  fs.rmdirSync(stuck);
  S = await boot(dir, nextPort());
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0, 'cleared at boot once the file is absent');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.mediaDeletions.queued, 0);
  await S.stop();
  assert.equal(execFileSync(process.execPath, [path.join(HERE, 'coreIdentityRollback.mjs'), dir, path.join(out, 'copy2'), '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('"recordRemoved": true'), true, 'the rollback runs once the queue drained');
  rm(dir, out);
});

// ------------------------------------------------------------- the admin backup and a restore into a fresh directory
await test('backup/restore through the real admin routes: a backup taken after post-cutover changes (a sign-up, a child and its link, a guardian with an outstanding e-mail code, staff sessions) restores into a NEW directory with every record, link and session hash, and the pending code still verifies there', async () => {
  const dir = tempDir('s4srv-backup');
  let S = await boot(dir, nextPort());
  const pro = await orgLogin(S, 'org-eastport');
  const ps = await S.j('POST', '/auth/player/signup', { name: 'Backed Up', dob: '2001-01-01', country: 'GB', password: 'backup-pass-1' }); assert.equal(ps.status, 201);
  const gs = await S.j('POST', '/auth/guardian/signup', { name: 'Backup Parent', email: 'backup@example.test', password: 'backup-pass-1' }); assert.equal(gs.status, 201);
  const gs2 = await S.j('POST', '/auth/guardian/signup', { name: 'Linked Parent', email: 'linked@example.test', password: 'backup-pass-1' }); assert.equal(gs2.status, 201);
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs2.body.guardianId, code: gs2.body.devEmailCode })).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P7654321' }, gs2.body.token)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, gs2.body.token)).status, 200);
  const kid = await S.j('POST', '/guardian/children', { name: 'Backup Kid', dob: '2015-05-05' }, gs2.body.token); assert.equal(kid.status, 201);
  const kidId = kid.body.playerId ?? kid.body.player?.id ?? kid.body.id;
  const bk = await S.j('POST', '/admin/backup', {}, null, A);
  assert.equal(bk.status, 201, JSON.stringify(bk.body)); assert.equal(bk.body.manifest.counts.players, seedCounts.players + 2);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.equal(snapshot.db.players.length, seedCounts.players + 2); assert.ok(snapshot.db.guardians.find((g) => g.id === gs2.body.guardianId).childIds.includes(kidId));
  assert.equal(JSON.stringify(snapshot.db.sessions).includes(pro), false, 'sessions are exported as hashes, never tokens');
  assert.equal((await S.j('POST', '/admin/backup/verify', { dir: path.basename(bk.body.dir) }, null, A)).body.ok, true);
  await S.stop();
  // Restore: the backup directory becomes a NEW data directory (db.json is the legacy import path).
  const restored = tempDir('s4srv-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored, nextPort());
  assert.match(S.log(), /in the blob/, 'the legacy import wrote the backup as blobs; the cutover then imported them into the tables');
  const cap = (await S.j('GET', '/capabilities')).body;
  assert.equal(cap.dataLayer.identity.initState, 'done'); assert.equal(cap.dataLayer.domains.players.rows, seedCounts.players + 2); assert.equal(cap.dataLayer.domains.guardians.rows, seedCounts.guardians + 2);
  assert.deepEqual(qAll(restored, 'SELECT guardian_id, role FROM guardian_children WHERE player_id = ?', kidId), [{ guardian_id: gs2.body.guardianId, role: 'primary' }]);
  assert.equal((await S.j('GET', `/org/players/${ps.body.playerId}`, undefined, pro)).status, 200, 'the staff session minted before the backup works on the restored server (same hash, same sid)');
  assert.equal((await S.j('GET', '/guardian/children', undefined, gs2.body.token)).body[0].id, kidId);
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs.body.guardianId, code: gs.body.devEmailCode })).status, 200, 'the outstanding code travelled with the record');
  assert.equal((await S.j('POST', '/auth/player/login', { playerId: ps.body.playerId, password: 'backup-pass-1' })).status, 200);
  await S.stop();
  assert.ok(fs.existsSync(path.join(restored, 'db.json.migrated')));
  assert.ok(!blobNames(restored).includes('players'));
  rm(dir, restored);
});

// ------------------------------------------------------------- a backup taken while a media removal is pending (review of 9656a4b)
await test('backup/restore keeps the intent of a pending media removal: a committed queue entry whose file is still on disk is exported with the snapshot and its file is left OUT of the backup (never a file without its removal intent); a live clip is copied; the restored server imports the queue, serves nothing for the id, finishes the removal at boot (a file put back by hand included) and stays clean across a restart; an older backup without the queue still restores; a tampered queue entry refuses the restore', async () => {
  const dir = tempDir('s4srv-backup-queue');
  let S = await boot(dir, nextPort());
  const mk = async (name) => { const r = await S.j('POST', '/auth/player/signup', { name, dob: '2001-01-01', country: 'GB', password: 'backup-pass-1' }); assert.equal(r.status, 201); const m = await S.j('POST', '/player/media', { title: 'Clip', kind: 'video', dataUrl: 'data:video/webm;base64,AAAAAAAA' }, r.body.token); assert.equal(m.status, 201, JSON.stringify(m.body)); return { id: r.body.playerId, token: r.body.token, mediaId: m.body.media.id, file: path.join(dir, 'media', `${m.body.media.id}.webm`) }; };
  const gone = await mk('Removed Owner'); const live = await mk('Still Here');
  // The documented interval: the deletion committed (row, links, sessions, queue entry) but the file is still there — here because the unlink failed (a directory in its place), then the file is put back as a real file before the sweep runs again.
  fs.rmSync(gone.file); fs.mkdirSync(gone.file);
  assert.equal((await S.j('DELETE', '/player/account', undefined, gone.token)).status, 200);
  fs.rmdirSync(gone.file); fs.writeFileSync(gone.file, 'synthetic media of a removed owner');
  assert.deepEqual(qAll(dir, 'SELECT media_id, player_id FROM media_deletions'), [{ media_id: gone.mediaId, player_id: gone.id }], 'the queue entry is committed and the file is present');
  const pro = await orgLogin(S, 'org-eastport');
  assert.equal((await S.j('GET', `/media/${gone.mediaId}`, undefined, pro)).status, 404, 'queued: never served');
  const bk = await S.j('POST', '/admin/backup', {}, null, A);
  assert.equal(bk.status, 201, JSON.stringify(bk.body));
  const snapshot = JSON.parse(fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'));
  assert.deepEqual((snapshot.db.mediaDeletions ?? []).map((r) => [r.media_id, r.player_id]), [[gone.mediaId, gone.id]], 'the removal intent travels with the snapshot');
  assert.equal(fs.existsSync(path.join(bk.body.dir, 'media', `${gone.mediaId}.webm`)), false, 'a queued file is never copied into a backup');
  assert.equal(fs.existsSync(path.join(bk.body.dir, 'media', `${live.mediaId}.webm`)), true, 'a live clip is');
  assert.equal(bk.body.manifest.media?.queuedForRemoval, 1, 'the manifest says what was left out and why');
  assert.ok(!bk.body.manifest.files.some((f) => f.path.includes(gone.mediaId)), 'the manifest lists only what the backup holds');
  assert.equal((await S.j('POST', '/admin/backup/verify', { dir: path.basename(bk.body.dir) }, null, A)).body.ok, true);
  await S.stop();
  // Restore 1: as copied. The queue is imported, the file is absent, the boot sweep clears the entry; nothing is served; a restart stays clean.
  const restored = tempDir('s4srv-restored-queue'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored, nextPort());
  assert.equal(fs.existsSync(path.join(restored, 'media', `${gone.mediaId}.webm`)), false);
  assert.equal(q1(restored, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0, 'the imported entry was cleared at boot because the file is absent');
  assert.ok(!blobNames(restored).includes('mediaDeletions'), 'the queue is a table, never left as a blob');
  assert.ok([401, 404].includes((await S.j('GET', `/media/${gone.mediaId}`, undefined, pro)).status), 'the removed owner\'s id is not served on the restored server');
  assert.equal((await S.j('GET', `/media/${live.mediaId}`, undefined, live.token)).status, 200, 'the live clip is served to its owner (session restored by hash)');
  assert.equal((await S.j('GET', '/capabilities')).body.dataLayer.mediaDeletions.queued, 0);
  await S.stop();
  S = await boot(restored, nextPort());
  assert.equal(q1(restored, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0); assert.equal(fs.existsSync(path.join(restored, 'media', `${gone.mediaId}.webm`)), false);
  await S.stop();
  // Restore 2: an operator copies the removed owner's file back by hand before the first boot. The imported intent removes it at boot.
  const restored2 = tempDir('s4srv-restored-queue2'); fs.cpSync(bk.body.dir, restored2, { recursive: true });
  fs.writeFileSync(path.join(restored2, 'media', `${gone.mediaId}.webm`), 'copied back by hand');
  S = await boot(restored2, nextPort());
  assert.equal(fs.existsSync(path.join(restored2, 'media', `${gone.mediaId}.webm`)), false, 'the boot sweep removed the file the queue named');
  assert.equal(q1(restored2, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0);
  await S.stop();
  // Restore 3: a backup from a build without the queue (no mediaDeletions key) restores as before.
  const restored3 = tempDir('s4srv-restored-queue3'); fs.cpSync(bk.body.dir, restored3, { recursive: true });
  { const legacy = JSON.parse(fs.readFileSync(path.join(restored3, 'db.json'), 'utf8')); delete legacy.db.mediaDeletions; fs.writeFileSync(path.join(restored3, 'db.json'), JSON.stringify(legacy)); }
  S = await boot(restored3, nextPort());
  assert.equal(q1(restored3, 'SELECT COUNT(*) AS n FROM media_deletions').n, 0); assert.equal((await S.j('GET', `/media/${live.mediaId}`, undefined, live.token)).status, 200);
  await S.stop();
  // Restore 4: a tampered queue entry (an id that is not a media id) refuses the whole restore; db.json stays in place and nothing is removed.
  const restored4 = tempDir('s4srv-restored-queue4'); fs.cpSync(bk.body.dir, restored4, { recursive: true });
  { const legacy = JSON.parse(fs.readFileSync(path.join(restored4, 'db.json'), 'utf8')); legacy.db.mediaDeletions = [{ media_id: '../../outside', player_id: null, queued_at: 1 }]; fs.writeFileSync(path.join(restored4, 'db.json'), JSON.stringify(legacy)); }
  const refused = await bootRefuses(restored4, nextPort());
  assert.notEqual(refused.code, 0); assert.match(refused.log, /MEDIA_QUEUE_IMPORT_BLOCKED/); assert.match(refused.log, /is not a media id/);
  // The store imported the snapshot as blobs first (and renamed the file, as for every restore); the migration then refused and rolled back:
  // the tampered entry sits in the blob, imported by nothing, no queue table or record exists, the live clip is untouched, and the next boot refuses the same way.
  assert.ok(fs.existsSync(path.join(restored4, 'db.json.migrated')), 'nothing of the snapshot is lost');
  assert.equal(JSON.parse(q1(restored4, "SELECT value FROM collections WHERE name = 'mediaDeletions'").value)[0].media_id, '../../outside');
  assert.equal(qAll(restored4, "SELECT name FROM sqlite_master WHERE name = 'media_deletions'").length, 0, 'the migration rolled back whole');
  assert.equal(qAll(restored4, "SELECT id FROM data_migrations WHERE id = '0006_media_deletions'").length, 0);
  assert.equal(fs.existsSync(path.join(restored4, 'media', `${live.mediaId}.webm`)), true);
  assert.match((await bootRefuses(restored4, nextPort())).log, /MEDIA_QUEUE_IMPORT_BLOCKED/, 'the next boot refuses the same way');
  rm(dir, restored, restored2, restored3, restored4);
});

console.log(`\n${passed} core-identity server checks passed`);
