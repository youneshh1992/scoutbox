// S6a through the REAL server (server.mjs booted as a child process on
// temporary data directories, synthetic records only): durable issuance, the
// two atomic consumption operations (a seam after the consumption and a real
// COMMIT failure, each read back through a second connection), SIGKILL
// restarts, concurrent redemption, attempt limits and rate limits, player
// deletion, the admin backup and a restore in both snapshot formats, and the
// privacy of every response (the intended plain-code delivery included).
// Nothing here touches DATA_DIR or any real data. Run with: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const hash = (code) => crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const children = new Set();
process.on('exit', () => { for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });

async function boot(dir) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dir, M13_QUIET_LOGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function bootRefuses(dir) {
  try { const S = await boot(dir); await S.kill(); throw new Error(`the server booted but must have refused: ${S.log().slice(-600)}`); }
  catch (err) { if (typeof err.code !== 'number') throw err; return { code: err.code, log: err.log }; }
}
// Every database read goes through a SECOND, read-only connection: what it sees is what is committed.
const q1 = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const r = s.prepare(sql).get(...p); return r ? { ...r } : r; } finally { s.close(); } };
const qAll = (dir, sql, ...p) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { return s.prepare(sql).all(...p).map((r) => ({ ...r })); } finally { s.close(); } };
const fileText = (dir) => { const s = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true }); try { const out = []; for (const { name } of s.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) out.push(JSON.stringify(s.prepare(`SELECT * FROM "${name}"`).all())); return out.join('\n'); } finally { s.close(); } };
const playerSessions = (dir, pid) => q1(dir, "SELECT COUNT(*) AS n FROM sessions WHERE kind = 'player' AND ref_id = ?", pid).n;
const orgLogin = async (S, orgId, scoutName, role, platform) => { const r = await S.j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) }); assert.equal(r.status, 200, `org login ${orgId}: ${JSON.stringify(r.body)}`); return r.body.token; };
const COMMIT_SEAM = 'internal:unit.sqlite_commit';

/** A guardian through the three safeguarding gates, with one child. */
async function guardianWithChild(S, tag) {
  const gs = await S.j('POST', '/auth/guardian/signup', { name: `Parent ${tag}`, email: `parent-${tag}@example.test`, password: 'synthetic-pass-1' }); assert.equal(gs.status, 201, JSON.stringify(gs.body));
  const token = gs.body.token;
  assert.equal((await S.j('POST', '/auth/guardian/verify-email', { guardianId: gs.body.guardianId, code: gs.body.devEmailCode })).status, 200);
  assert.equal((await S.j('POST', '/guardian/verify-id', { documentType: 'passport', documentRef: 'P1234567' }, token)).status, 200);
  assert.equal((await S.j('POST', '/guardian/disclaimer', { accepted: true }, token)).status, 200);
  const kid = await S.j('POST', '/guardian/children', { name: `Kid ${tag}`, dob: '2015-05-05' }, token); assert.equal(kid.status, 201, JSON.stringify(kid.body));
  return { token, guardianId: gs.body.guardianId, childId: kid.body.playerId };
}
/** Arm one seam, perform the operation once, prove it was answered 500 and left `unchanged()`, disarm. */
async function refusedBy(S, rule, act, unchanged) {
  assert.equal((await S.j('POST', '/__faults', { rules: rule })).status, 200);
  const r = await act();
  assert.equal(r.status, 500, `${rule}: a unit that did not commit must not be answered as success — got ${r.status} ${r.text}`);
  assert.equal(r.body?.error, 'INTERNAL');
  await unchanged(rule);
  assert.equal((await S.j('POST', '/__faults', { rules: '' })).status, 200);
}

// ------------------------------------------------------------- pairing: issuance, atomic consumption, single use
await test('pairing: the mint answers { code, expiresAt } as before and the row holds only the hash (no plain code anywhere in the file); a failure after the consumption and a failure of the real COMMIT are answered 500, keep the code and create no session (second connection); the retry exchanges the code for a working child session; the code is single use', async () => {
  const dir = tempDir('s6a-pair'); const S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'pair');
  const mint = await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token);
  assert.equal(mint.status, 201); assert.deepEqual(Object.keys(mint.body).sort(), ['code', 'expiresAt']); assert.match(mint.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
  const { code } = mint.body;
  assert.deepEqual(qAll(dir, 'SELECT code_hash, player_id, expires_at FROM pairing_codes'), [{ code_hash: hash(code), player_id: childId, expires_at: mint.body.expiresAt }], 'durable when the response is sent, hashed');
  assert.equal(fileText(dir).includes(code), false, 'the plain code is stored nowhere in the database');
  const before = playerSessions(dir, childId);
  const pair = () => S.j('POST', '/auth/player/pair', { code: code.toLowerCase() });
  const unchanged = async (label) => { assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = ?', childId).n, 1, `${label}: the code is retained`); assert.equal(playerSessions(dir, childId), before, `${label}: no session was created`); };
  await refusedBy(S, 'internal:pairing.after_consume', pair, unchanged);
  await refusedBy(S, COMMIT_SEAM, pair, unchanged);
  const ok = await pair();
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.body.playerId, childId); assert.ok(ok.body.token);
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes').n, 0); assert.equal(playerSessions(dir, childId), before + 1);
  assert.equal((await S.j('GET', '/player/me', undefined, ok.body.token)).status, 200, 'the child session works');
  assert.equal((await pair()).status, 404, 'single use');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- crash safety
await test('crash safety: a SIGKILL right after the mint response keeps the code (issuance is durable; before S6a the code lived in memory until some later save); a SIGKILL right after a successful pairing leaves the session AND the consumption committed, so after the restart the code cannot buy a second session', async () => {
  const dir = tempDir('s6a-crash'); let S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'crash');
  const { code } = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body;
  await S.kill();
  S = await boot(dir);
  const ok = await S.j('POST', '/auth/player/pair', { code });
  assert.equal(ok.status, 200, `the code survived the SIGKILL after the mint: ${ok.text}`);
  const sessionsAfter = playerSessions(dir, childId);
  await S.kill();
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes').n, 0, 'the consumption is committed with the session');
  S = await boot(dir);
  assert.equal((await S.j('POST', '/auth/player/pair', { code })).status, 404, 'after the restart the code is refused: no second exchange');
  assert.equal(playerSessions(dir, childId), sessionsAfter, 'no second session');
  assert.equal((await S.j('GET', '/player/me', undefined, ok.body.token)).status, 200, 'the first session survived the crash');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- concurrent redemption
await test('concurrent redemption: two simultaneous exchanges of one code produce exactly one session (one 200, one 404)', async () => {
  const dir = tempDir('s6a-race'); const S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'race');
  const { code } = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body;
  const before = playerSessions(dir, childId);
  const results = await Promise.all([S.j('POST', '/auth/player/pair', { code }), S.j('POST', '/auth/player/pair', { code })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
  assert.equal(playerSessions(dir, childId), before + 1);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- pairing guessing budget; reissue
await test('pairing limits: a reissued code replaces the previous one; wrong codes are charged per client address — after 20 the 21st attempt answers 429 RATE_LIMITED, and so does the CORRECT code (the budget is tested before the code is judged, never rewarded after it is gone)', async () => {
  const dir = tempDir('s6a-guess'); const S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'guess');
  const first = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body.code;
  const { code } = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body;
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = ?', childId).n, 1, 'one live code per child');
  if (first !== code) { assert.equal((await S.j('POST', '/auth/player/pair', { code: first })).status, 404, 'the replaced code is dead'); }
  const wrongNeeded = first !== code ? 19 : 20;
  for (let i = 0; i < wrongNeeded; i++) assert.equal((await S.j('POST', '/auth/player/pair', { code: `ZZZ${String(i).padStart(3, '2').replace(/[01]/g, '2')}` })).status, 404);
  const limited = await S.j('POST', '/auth/player/pair', { code: 'QQQQQQ' });
  assert.equal(limited.status, 429); assert.equal(limited.body.error, 'RATE_LIMITED');
  assert.equal((await S.j('POST', '/auth/player/pair', { code })).status, 429, 'the correct code after the budget is refused');
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = ?', childId).n, 1, 'and the code was not consumed');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- e-mail challenge
await test('club e-mail challenge: the request stores only the hash and mails the code; a wrong code answers 400 with the attempts left; a failure after the consumption and a failure of the real COMMIT keep the challenge and leave the organisation unverified (second connection); the retry verifies the domain; the consumed code is refused; ten wrong codes cancel a challenge so even the correct code is refused; requests are limited to 5 per organisation per hour', async () => {
  const dir = tempDir('s6a-email'); const S = await boot(dir);
  const pro = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  const request = (email) => S.j('POST', '/org/verification/email', { email }, pro);
  const mailedCode = async (to) => { const mails = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.filter((m) => m.to === to); return /code is ([A-Z0-9]{6})/.exec(mails[0]?.text ?? '')?.[1]; };
  assert.deepEqual((await request('recruitment@eastportfc.test')).body, { sent: true, note: 'Enter the code from the mailbox to confirm domain control.' });
  const code = await mailedCode('recruitment@eastportfc.test'); assert.ok(code);
  assert.deepEqual(qAll(dir, 'SELECT org_id, email, code_hash, attempts FROM email_challenges'), [{ org_id: 'org-eastport', email: 'recruitment@eastportfc.test', code_hash: hash(code), attempts: 0 }]);
  const wrong = await S.j('POST', '/org/verification/email/confirm', { code: code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA' }, pro);
  assert.equal(wrong.status, 400); assert.equal(wrong.body.error, 'CODE_INVALID'); assert.equal(wrong.body.attemptsRemaining, 9);
  assert.equal(q1(dir, 'SELECT attempts FROM email_challenges').attempts, 1, 'the wrong code is counted on the row');
  const verified = () => q1(dir, "SELECT email_domain_verified AS v, email_domain AS d FROM orgs WHERE id = 'org-eastport'");
  const confirm = () => S.j('POST', '/org/verification/email/confirm', { code: ` ${code.toLowerCase()} ` }, pro);
  const unchanged = async (label) => { assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM email_challenges').n, 1, `${label}: the challenge is retained`); assert.equal(verified().v, 0, `${label}: the organisation is unverified`); };
  await refusedBy(S, 'internal:email_challenge.confirm.after_consume', confirm, unchanged);
  await refusedBy(S, COMMIT_SEAM, confirm, unchanged);
  const ok = await confirm();
  assert.equal(ok.status, 200, ok.text); assert.deepEqual(ok.body, { emailDomainVerified: true, emailDomain: 'eastportfc.test' });
  assert.deepEqual(verified(), { v: 1, d: 'eastportfc.test' }); assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM email_challenges').n, 0);
  assert.equal((await confirm()).status, 404, 'single use');
  // Ten wrong codes cancel the challenge.
  await request('ops@eastportfc.test'); const code2 = await mailedCode('ops@eastportfc.test');
  let last;
  for (let i = 0; i < 10; i++) last = await S.j('POST', '/org/verification/email/confirm', { code: code2 === 'CCCCCC' ? 'DDDDDD' : 'CCCCCC' }, pro);
  assert.equal(last.status, 400); assert.equal(last.body.attemptsRemaining, 0); assert.match(last.body.message, /cancelled after too many wrong codes/);
  assert.equal((await S.j('POST', '/org/verification/email/confirm', { code: code2 }, pro)).status, 404, 'the correct code is refused once the challenge is cancelled');
  // Request budget: 2 used above; 3 more pass, the 6th is limited.
  for (let i = 0; i < 3; i++) assert.equal((await request(`r${i}@eastportfc.test`)).status, 201);
  const lim = await request('r9@eastportfc.test'); assert.equal(lim.status, 429); assert.equal(lim.body.error, 'RATE_LIMITED');
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- deletion
await test('player deletion: the child\'s pairing code goes in the deletion unit — a failure of the real COMMIT keeps the child and the code (answered 500); the retry deletes both; the code then pairs nobody', async () => {
  const dir = tempDir('s6a-delete'); const S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'del');
  const { code } = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body;
  const del = () => S.j('DELETE', `/guardian/children/${childId}`, undefined, token);
  await refusedBy(S, COMMIT_SEAM, del, async (label) => {
    assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes WHERE player_id = ?', childId).n, 1, `${label}: the code is retained`);
    assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', childId).n, 1, `${label}: the child is retained`);
  });
  assert.equal((await del()).status, 200);
  assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM pairing_codes').n, 0); assert.equal(q1(dir, 'SELECT COUNT(*) AS n FROM players WHERE id = ?', childId).n, 0);
  assert.equal((await S.j('POST', '/auth/player/pair', { code })).status, 404);
  await S.stop(); rm(dir);
});

// ------------------------------------------------------------- backup and restore, both formats
await test('backup/restore: the admin backup exports the codes in their stored form (codeHash, attempts; no plain code anywhere in db.json); a restore into a NEW directory imports them (migration 0008) and the outstanding pairing code and challenge still work there; a legacy backup holding plain codes (the pre-S6a shape) restores through the same migration with the codes hashed; a backup whose stored entry is malformed is refused at boot (ONE_TIME_CODES_IMPORT_BLOCKED), creates no table and is refused again on the next boot', async () => {
  const dir = tempDir('s6a-backup'); let S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'bk');
  const { code } = (await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token)).body;
  const pro = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  assert.equal((await S.j('POST', '/org/verification/email', { email: 'bk@eastportfc.test' }, pro)).status, 201);
  const mail = (await S.j('GET', '/admin/outbox', undefined, null, A)).body.find((m) => m.to === 'bk@eastportfc.test');
  const challengeCode = /code is ([A-Z0-9]{6})/.exec(mail.text)[1];
  const bk = await S.j('POST', '/admin/backup', {}, null, A); assert.equal(bk.status, 201, bk.text);
  await S.stop();
  const jsonText = fs.readFileSync(path.join(bk.body.dir, 'db.json'), 'utf8'); const snapshot = JSON.parse(jsonText);
  assert.deepEqual(snapshot.db.pairingCodes, [{ codeHash: hash(code), playerId: childId, expiresAt: snapshot.db.pairingCodes[0].expiresAt }]);
  assert.deepEqual(snapshot.db.emailChallenges.map((c) => [c.orgId, c.codeHash, c.attempts]), [['org-eastport', hash(challengeCode), 0]]);
  assert.equal(jsonText.includes(`"${code}"`) || jsonText.includes(`"${challengeCode}"`), false, 'no plain code in the backup');
  // New-format restore.
  const restored = tempDir('s6a-restored'); fs.cpSync(bk.body.dir, restored, { recursive: true });
  S = await boot(restored);
  assert.equal((await S.j('POST', '/auth/player/pair', { code })).status, 200, 'the restored pairing code works');
  assert.equal((await S.j('POST', '/org/verification/email/confirm', { code: challengeCode }, pro)).status, 200, 'the restored challenge works (the staff session travelled too)');
  await S.stop();
  // Legacy-format restore: the same backup with the pre-S6a plain-code shape.
  const legacy = tempDir('s6a-legacy'); fs.cpSync(bk.body.dir, legacy, { recursive: true });
  const leg = JSON.parse(jsonText);
  leg.db.pairingCodes = [{ code, playerId: childId, expiresAt: snapshot.db.pairingCodes[0].expiresAt }];
  leg.db.emailChallenges = [{ orgId: 'org-eastport', email: 'bk@eastportfc.test', code: challengeCode, expiresAt: snapshot.db.emailChallenges[0].expiresAt }];
  fs.writeFileSync(path.join(legacy, 'db.json'), JSON.stringify(leg));
  S = await boot(legacy);
  assert.equal(q1(legacy, 'SELECT code_hash FROM pairing_codes').code_hash, hash(code), 'hashed on import'); assert.equal(fileText(legacy).includes(code), false);
  assert.equal((await S.j('POST', '/auth/player/pair', { code })).status, 200);
  await S.stop();
  // Malformed new-format entry: refused, never reinterpreted or dropped.
  const bad = tempDir('s6a-badbk'); fs.cpSync(bk.body.dir, bad, { recursive: true });
  const b = JSON.parse(jsonText); b.db.pairingCodes[0].codeHash = 'not-a-hash'; fs.writeFileSync(path.join(bad, 'db.json'), JSON.stringify(b));
  const r1 = await bootRefuses(bad);
  assert.notEqual(r1.code, 0); assert.match(r1.log, /ONE_TIME_CODES_IMPORT_BLOCKED.*codeHash must be 64/);
  assert.equal(q1(bad, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pairing_codes'").n, 0, 'no table created');
  const r2 = await bootRefuses(bad); assert.match(r2.log, /ONE_TIME_CODES_IMPORT_BLOCKED/, 'refused again on the next boot');
  rm(dir, restored, legacy, bad);
});

// ------------------------------------------------------------- response privacy
await test('privacy: the plain pairing code reaches the guardian in the mint response (its intended delivery) and the challenge code reaches the mailbox (the dev outbox here); no other response — capabilities, the guardian\'s, the child\'s, the club\'s and the admin views — carries either code or its hash', async () => {
  const dir = tempDir('s6a-privacy'); const S = await boot(dir);
  const { token, childId } = await guardianWithChild(S, 'priv');
  const mint = await S.j('POST', `/guardian/children/${childId}/pairing-code`, {}, token);
  const code = mint.body.code; assert.ok(mint.text.includes(code), 'the intended delivery');
  const pro = await orgLogin(S, 'org-eastport', 'Maria Keane', 'Head of Recruitment');
  await S.j('POST', '/org/verification/email', { email: 'priv@eastportfc.test' }, pro);
  const challengeCode = /code is ([A-Z0-9]{6})/.exec((await S.j('GET', '/admin/outbox', undefined, null, A)).body.find((m) => m.to === 'priv@eastportfc.test').text)[1];
  const responses = [
    await S.j('GET', '/capabilities'), await S.j('GET', '/guardian/me', undefined, token), await S.j('GET', '/guardian/children', undefined, token),
    await S.j('GET', '/guardian/export', undefined, token), await S.j('GET', '/org/me', undefined, pro), await S.j('GET', '/admin/guardians', undefined, null, A),
    await S.j('GET', '/admin/stats', undefined, null, A), await S.j('GET', '/admin/metrics', undefined, null, A), await S.j('GET', '/admin/clubs', undefined, null, A),
  ];
  const paired = await S.j('POST', '/auth/player/pair', { code });
  assert.equal(paired.status, 200); assert.equal(paired.text.includes(code), false, 'the pairing response does not echo the code');
  responses.push(await S.j('GET', '/player/me', undefined, paired.body.token));
  for (const r of responses) {
    for (const secret of [code, hash(code), challengeCode, hash(challengeCode)]) assert.equal(r.text.includes(secret), false, `a response leaked a code or hash: ${r.text.slice(0, 160)}`);
  }
  assert.ok(responses.some((r) => r.status === 200 && /oneTimeCodes/.test(r.text)), 'capabilities reports the code tables (counts only)');
  await S.stop(); rm(dir);
});

console.log(`\n${passed} one-time-code server checks passed`);
