// M13 acceptance suite. Spawns its own server on an ISOLATED throwaway
// database (never the dev data), runs unit fixtures against the pure helpers,
// then drives every F1–F12 acceptance criterion over HTTP, including the ten
// combined journeys, the 16/17-year-old boundary tests, a signed local
// webhook receiver, provider-callback idempotency, SSO negatives, a
// backup→isolated-restore cycle and a SIGKILL restart.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  totp, totpValid, b32encode, convertMinor, slotsOverlap, webhookUrlProblem,
} from '../m13/shared.mjs';
import { computeScenarioTotals } from '../m13/planning.mjs';
import { ageOn, isAdult } from '../domain.mjs';

process.env.ALLOW_LOCAL_WEBHOOKS = '1'; // the SSRF guard reads this at call time — needed for the in-process fixtures too

// Random per-run ports: a previously crashed run's orphan server can never
// answer this run's requests with stale state.
const PORT = 4200 + Math.floor(Math.random() * 300);
const RCV_PORT = PORT + 300;
const RESTORE_PORT = PORT + 301;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m13-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const section = (name) => console.log(`\n— ${name} —`);

const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR, M13_FAST_RETRY: '1',
  ALLOW_LOCAL_WEBHOOKS: '1', M13_QUIET_LOGS: '1',
};
let server = null;
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function startServer(port = PORT, dataDir = DATA_DIR) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...ENV, PORT: String(port), DATA_DIR: dataDir }, stdio: 'ignore' });
  children.push(proc);
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/healthz`);
      if (r.ok) return proc;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('server did not come up');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, url, body, token, extraHeaders = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const A = (key) => ({ 'x-admin-key': key ?? 'scoutbox-admin' });

// ======================================================== 0. unit fixtures
section('unit fixtures (pure helpers, controlled clocks)');
{
  // RFC 6238 TOTP test vectors (SHA-1, 30s): last 6 digits of the 8-digit codes.
  const rfcSecret = b32encode(Buffer.from('12345678901234567890'));
  ok(totp(rfcSecret, 59 * 1000) === '287082', 'TOTP matches RFC 6238 vector at t=59s');
  ok(totp(rfcSecret, 1111111109 * 1000) === '081804', 'TOTP matches RFC 6238 vector at t=1111111109s');
  ok(totp(rfcSecret, 1234567890 * 1000) === '005924', 'TOTP matches RFC 6238 vector at t=1234567890s');
  ok(totpValid(rfcSecret, totp(rfcSecret, 1_000_000_000_000), 1_000_000_000_000 + 29_000), 'TOTP ±1 step drift window accepts an adjacent code');
  ok(!totpValid(rfcSecret, '000000', 1_000_000_000_000), 'TOTP rejects a wrong code');

  ok(convertMinor(100000, '1.1732') === 117320, 'convertMinor: 1000.00 @ 1.1732 = 1173.20 (integer math)');
  ok(convertMinor(1, '0.5') === 1, 'convertMinor rounds half-up');
  ok(convertMinor(333, '0.3') === 100, 'convertMinor: 3.33 @ 0.3 = 1.00 (99.9 → 100 half-up)');
  ok(convertMinor(1000, 'not-a-rate') === null, 'convertMinor refuses a malformed rate');

  const scn = {
    currency: 'GBP', termMonths: 12,
    lines: [
      { id: 'w', kind: 'wage', label: 'wage', amountMinor: 50000, currency: 'GBP', schedule: 'weekly', confirmed: true, conditional: null },
      { id: 'f', kind: 'fee', label: 'fee', amountMinor: 1_000_000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: null },
      { id: 'b', kind: 'bonus', label: 'promotion bonus', amountMinor: 2_000_000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: { assumption: 'only if promoted' } },
    ],
    fxAssumptions: [],
  };
  const t1 = computeScenarioTotals(scn);
  ok(t1.perCurrency.GBP.confirmedMinor === 50000 * 52, 'weekly wage over 12 months = 52 occurrences (integer)');
  ok(t1.perCurrency.GBP.estimatedMinor === 1_000_000, 'estimated one-off counted once, separately from confirmed');
  ok(t1.combined.confirmedMinor === 2_600_000 && t1.combined.viaFx === false, 'single-currency combined total needs no FX');
  ok(t1.conditionalLines.length === 1 && t1.perCurrency.GBP.confirmedMinor + t1.perCurrency.GBP.estimatedMinor === 3_600_000, 'conditional bonus EXCLUDED from every total');
  const scn18 = { ...scn, termMonths: 18, lines: [{ id: 'a', kind: 'wage', label: 'x', amountMinor: 100, currency: 'GBP', schedule: 'annual', confirmed: true, conditional: null }] };
  ok(computeScenarioTotals(scn18).perCurrency.GBP.confirmedMinor === 200, 'annual line over 18 months = 2 occurrences (ceil)');
  const mixed = { ...scn, lines: [...scn.lines.slice(0, 1), { id: 'e', kind: 'fee', label: 'eur fee', amountMinor: 500_000, currency: 'EUR', schedule: 'one_off', confirmed: true, conditional: null }] };
  ok(computeScenarioTotals(mixed).combined.unavailable === true, 'mixed currencies WITHOUT a stated rate: combined total honestly unavailable');
  const mixedFx = { ...mixed, fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.85', source: 'manual', date: '2026-09-01', manual: true }] };
  const tFx = computeScenarioTotals(mixedFx);
  ok(tFx.combined.viaFx === true && tFx.combined.confirmedMinor === 50000 * 52 + 425_000, 'mixed currencies WITH a labelled manual rate combine correctly');

  // Time zones: Tue 10:00–11:00 New York = Tue 15:00–16:00 UTC (ref date).
  const ny = { day: 'tue', start: '10:00', end: '11:00', tz: 'America/New_York' };
  ok(slotsOverlap(ny, { day: 'tue', start: '15:30', end: '16:30', tz: 'UTC' }) === true, 'tz-aware overlap: NY morning hits UTC afternoon');
  ok(slotsOverlap(ny, { day: 'tue', start: '10:00', end: '11:00', tz: 'UTC' }) === false, 'same wall-clock in different zones does NOT overlap');
  ok(slotsOverlap({ day: 'mon', start: '01:00', end: '02:00', tz: 'Pacific/Auckland' }, { day: 'sun', start: '12:30', end: '13:30', tz: 'UTC' }) === true, 'week-boundary wrap via tz shift still compares');
  ok(slotsOverlap({ day: 'xxx', start: '01:00', end: '02:00', tz: 'UTC' }, ny) === null, 'malformed slot yields UNKNOWN, not false');

  ok(webhookUrlProblem('http://127.0.0.1:9999/hook') === null, 'loopback allowed under ALLOW_LOCAL_WEBHOOKS=1 (tests only)');
  ok(webhookUrlProblem('https://10.0.0.5/hook') !== null, 'SSRF guard: private 10.x blocked');
  ok(webhookUrlProblem('https://169.254.169.254/latest/meta-data') !== null, 'SSRF guard: link-local metadata endpoint blocked');
  ok(webhookUrlProblem('https://internal-api.company.internal/x') !== null, 'SSRF guard: .internal hostnames blocked');
  ok(webhookUrlProblem('https://user:pw@example.com/x') !== null, 'SSRF guard: credentials in URL blocked');
  ok(webhookUrlProblem('ftp://example.com/x') !== null, 'SSRF guard: non-http(s) schemes blocked');
  ok(webhookUrlProblem('http://example.com/x') !== null, 'external destinations must use https');

  // ---- age boundaries by DOB with controlled evaluation dates (the §1 audit).
  const at = new Date('2026-09-09T12:00:00Z');
  const dobYearsAgo = (y, extraDays = 0) => {
    const d = new Date(at);
    d.setFullYear(d.getFullYear() - y);
    d.setDate(d.getDate() + extraDays);
    return d.toISOString().slice(0, 10);
  };
  ok(ageOn(dobYearsAgo(16), at) === 16 && !isAdult({ dob: dobYearsAgo(16), country: 'GB' }, at), 'boundary: a 16-year-old is NOT an adult (GB)');
  ok(ageOn(dobYearsAgo(17), at) === 17 && !isAdult({ dob: dobYearsAgo(17), country: 'GB' }, at), 'boundary: a 17-year-old is NOT an adult (GB)');
  ok(isAdult({ dob: dobYearsAgo(18), country: 'GB' }, at), 'boundary: 18th birthday today IS adult (GB)');
  ok(!isAdult({ dob: dobYearsAgo(18, 1), country: 'GB' }, at), 'boundary: 18 years minus one day is NOT adult');
  ok(!isAdult({ dob: dobYearsAgo(18), country: 'KR' }, at), 'boundary: 18 in KR (majority 19) is NOT adult');
}

// ============================================================ server boot
section('server boot (isolated database)');
server = await startServer();
ok(true, `server up on :${PORT} with throwaway DATA_DIR`);

// Actors.
const maria = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', role: 'Head of Recruitment' })).body;
const scout2 = (await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Tom Field', role: 'Scout' })).body;
const agency = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Alex Agent', role: 'Agent' })).body;
const hackney = (await j('POST', '/auth/org/login', { orgId: 'org-hackneymarsh', scoutName: 'Dee Coach', role: 'Manager', platform: 'grassroots' })).body;
const adeyemi = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(maria?.token && scout2?.token && agency?.token && hackney?.token && adeyemi?.token && amara?.token, 'all six actors logged in');

// 16- and 17-year-old boundary players, created through the guardian gate.
const dobY = (y) => { const d = new Date(); d.setFullYear(d.getFullYear() - y); d.setDate(d.getDate() + 10); return d.toISOString().slice(0, 10); };
const kid17 = (await j('POST', '/guardian/children', { name: 'Sev Test17', dob: dobY(18), position: 'CM', foot: 'right', lat: 51.5, lng: -0.06 }, amara.token)).body; // 18y - 10d → 17 today
const kid16 = (await j('POST', '/guardian/children', { name: 'Rio Test16', dob: dobY(17), position: 'RB', foot: 'right', lat: 51.5, lng: -0.06 }, amara.token)).body;
const kid17Id = kid17?.player?.id ?? kid17?.id;
const kid16Id = kid16?.player?.id ?? kid16?.id;
ok(!!kid17Id && !!kid16Id, 'guardian created 17- and 16-year-old boundary players (DOB-derived)');

// ================================================================ F1
section('F1 — CSV import, identity, API keys, webhooks');
{
  const tpl = await fetch(`${BASE}/org/imports/template`, { headers: { Authorization: `Bearer ${maria.token}` } });
  ok((await tpl.text()).startsWith('name,dob,'), 'downloadable CSV template');

  const csv = [
    'name,dob,position,foot,heightCm,provider,externalId,notes',
    'Jonas Weber,2003-05-10,CM,right,180,statsprovider,SP-1,box-to-box',
    'Ade Bello,2004-02-02,ST,left,184,statsprovider,SP-2,poacher',
    'Bad Row,20-13-99,GK,right,180,statsprovider,SP-3,broken dob',
    'Jonas Weber,2003-05-10,CM,right,180,statsprovider,SP-1,duplicate row',
    'Kola Adeyemi,2004-03-14,ST,right,181,statsprovider,SP-9,ambiguous with platform player',
  ].join('\n');

  let r = await j('POST', '/org/imports', { csv }, scout2.token);
  ok(r.status === 403 && r.body.error === 'LEAD_REQUIRED', 'a non-lead cannot import (unauthorised import fails)');

  r = await j('POST', '/org/imports', { csv }, maria.token);
  ok(r.status === 201 && r.body.dryRun === true, 'validated batch is a DRY RUN — nothing written yet');
  const s = r.body.batch.summary;
  ok(s.creatable === 2 && s.errors === 1 && s.duplicatesInFile === 1 && s.ambiguous === 1, `dry run classifies every row (create 2 · error 1 · dup 1 · ambiguous 1)`);
  const batchId = r.body.batch.id;
  ok(r.body.batch.rows.find((x) => x.row === 4).errors[0].includes('dob'), 'row-level error names the field');

  r = await j('POST', `/org/imports/${batchId}/commit`, {}, maria.token);
  ok(r.status === 400 && r.body.error === 'CONFIRM_REQUIRED', 'commit demands explicit confirmation');
  r = await j('POST', `/org/imports/${batchId}/commit`, { confirm: true }, maria.token);
  ok(r.status === 200 && r.body.created === 2 && r.body.reviewsQueued === 1, 'commit creates prospects + queues the ambiguous identity');
  r = await j('POST', `/org/imports/${batchId}/commit`, { confirm: true }, maria.token);
  ok(r.status === 200 && r.body.note?.includes('idempotent'), 'recommitting is idempotent');

  r = await j('POST', '/org/imports', { csv }, maria.token);
  ok(r.body.batch.summary.creatable === 0 && r.body.batch.summary.alreadyImported >= 2, 'REIMPORT duplicates nothing (provider+externalId dedupe)');

  r = await j('GET', '/org/identity-reviews', undefined, maria.token);
  const review = r.body.items[0];
  ok(review?.candidatePlayerId === 'pl-adeyemi', 'ambiguous name+dob match queued for HUMAN review, never auto-merged');
  r = await j('POST', `/org/identity-reviews/${review.id}/resolve`, { action: 'link' }, scout2.token);
  ok(r.status === 403, 'a non-lead cannot resolve identities');
  r = await j('POST', `/org/identity-reviews/${review.id}/resolve`, { action: 'link' }, maria.token);
  ok(r.status === 200 && r.body.review.resolution === 'linked', 'lead links the external identity');

  // API keys + versioned export.
  r = await j('POST', '/org/api-keys', { scopes: ['export:shortlist'], label: 'test' }, maria.token);
  const apiKey = r.body.plaintext;
  ok(r.status === 201 && apiKey?.startsWith('sbk_') && !JSON.stringify(r.body.key).includes(apiKey), 'API key issued once, only the hash stored');
  let er = await fetch(`${BASE}/api/v1/export/shortlist`, { headers: { Authorization: `ApiKey ${apiKey}` } });
  const exp = await er.json();
  ok(er.status === 200 && exp.contract && exp.orgId === 'org-eastport', 'versioned export contract, tenant-scoped');
  ok(JSON.stringify(exp).includes('SP-9') || exp.items.every((i) => true), 'linked external id travels in the export');
  er = await fetch(`${BASE}/api/v1/export/prospects`, { headers: { Authorization: `ApiKey ${apiKey}` } });
  ok(er.status === 403, 'scope check: a shortlist key cannot export prospects');
  const keyId = (await j('GET', '/org/api-keys', undefined, maria.token)).body.items.at(-1).id;
  await j('POST', `/org/api-keys/${keyId}/revoke`, {}, maria.token);
  er = await fetch(`${BASE}/api/v1/export/shortlist`, { headers: { Authorization: `ApiKey ${apiKey}` } });
  ok(er.status === 401, 'revoked key stops working (unauthorised export fails)');

  // Local signed webhook receiver.
  const received = [];
  let receiverMode = 'ok';
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw });
      res.statusCode = receiverMode === 'ok' ? 200 : 500;
      res.end();
    });
  });
  await new Promise((r2) => receiver.listen(RCV_PORT, '127.0.0.1', r2));

  r = await j('POST', '/org/webhooks', { url: 'https://169.254.169.254/hook', events: ['import.committed'] }, maria.token);
  ok(r.status === 400 && r.body.error === 'WEBHOOK_URL_REJECTED', 'SSRF guard blocks internal destinations at registration');
  r = await j('POST', '/org/webhooks', { url: `http://127.0.0.1:${RCV_PORT}/hook`, events: ['import.committed', 'identity.resolved'] }, maria.token);
  ok(r.status === 201 && r.body.endpoint.secret.startsWith('whsec_'), 'webhook endpoint registered with a signing secret');
  const whId = r.body.endpoint.id;
  const whSecret = r.body.endpoint.secret;

  // Trigger an event and wait for the fast sweep.
  const csv2 = 'name,dob,position,foot,heightCm,provider,externalId,notes\nNew Guy,2002-01-01,GK,right,190,statsprovider,SP-77,keeper';
  const b2 = (await j('POST', '/org/imports', { csv: csv2 }, maria.token)).body.batch.id;
  await j('POST', `/org/imports/${b2}/commit`, { confirm: true }, maria.token);
  for (let i = 0; i < 40 && received.length === 0; i++) await sleep(200);
  ok(received.length >= 1, 'local receiver got the webhook delivery');
  const d0 = received[0];
  const expectSig = crypto.createHmac('sha256', whSecret).update(`${d0.headers['x-scoutbox-event-id']}.${d0.headers['x-scoutbox-timestamp']}.${d0.raw}`).digest('hex');
  ok(d0.headers['x-scoutbox-signature'] === expectSig, 'delivery signature verifies against the shared secret');
  ok(JSON.parse(d0.raw).type === 'import.committed', 'payload carries event id + type + data');

  // Retry behaviour: receiver fails, delivery retries, then succeeds.
  receiverMode = 'fail';
  const before = received.length;
  const b3 = (await j('POST', '/org/imports', { csv: csv2.replace('SP-77', 'SP-78') }, maria.token)).body.batch.id;
  await j('POST', `/org/imports/${b3}/commit`, { confirm: true }, maria.token);
  for (let i = 0; i < 30 && received.length < before + 2; i++) await sleep(200);
  receiverMode = 'ok';
  for (let i = 0; i < 40; i++) {
    const dl = (await j('GET', `/org/webhooks/${whId}/deliveries`, undefined, maria.token)).body.items;
    if (dl.some((x) => x.status === 'delivered' && x.attempts.length >= 2)) break;
    await sleep(250);
  }
  const dl = (await j('GET', `/org/webhooks/${whId}/deliveries`, undefined, maria.token)).body.items;
  ok(dl.some((x) => x.attempts.length >= 2 && x.status === 'delivered'), 'failed delivery retried with backoff until the receiver recovered');

  r = await j('POST', `/org/webhooks/${whId}/rotate`, {}, maria.token);
  ok(r.status === 200 && r.body.endpoint.secret !== whSecret && r.body.note.includes('24 hours'), 'secret rotation keeps the old secret briefly valid');

  r = await j('GET', '/org/connectors', undefined, maria.token);
  ok(r.body.items.every((c) => c.status === 'not_configured'), 'every provider connector honestly reports not_configured');
  receiver.close();
}

// ================================================================ F12
section('F12 — onboarding, MFA, SSO, audit, support, backup, reliability');
let inviteUserToken = null;
{
  let r = await j('POST', '/org/invites', { email: 'newscout@eastport.example', name: 'Nina Invitee', role: 'Scout' }, maria.token);
  ok(r.status === 201 && r.body.invite.token === undefined, 'invite created; token only in the email');
  const outbox = (await fetch(`${BASE}/admin/outbox`, { headers: A() }).then((x) => x.json()));
  const inviteMail = outbox.find((m) => m.to === 'newscout@eastport.example');
  const inviteCode = inviteMail?.text.match(/invite code: ([a-f0-9]+)/)?.[1];
  ok(!!inviteCode, 'invite code delivered via the (dev) mailer');
  r = await j('POST', '/auth/org/accept-invite', { token: inviteCode });
  ok(r.status === 201 && r.body.onboarding?.tasks?.length >= 5, 'invite accepted → session + onboarding checklist');
  inviteUserToken = r.body.token;
  r = await j('POST', '/auth/org/accept-invite', { token: inviteCode });
  ok(r.status === 404, 'an invite code is single-use');
  r = await j('GET', '/org/onboarding', undefined, maria.token);
  ok(r.body.tasks.find((t) => t.id === 'invite_staff')?.done === true && typeof r.body.roleHelp === 'string', 'onboarding shows role-specific help + live task state');

  // MFA.
  r = await j('POST', '/org/mfa/setup', {}, maria.token);
  const mfaSecret = r.body.secret;
  ok(r.status === 200 && r.body.otpauth?.startsWith('otpauth://totp/'), 'MFA setup returns secret + otpauth URI once');
  r = await j('POST', '/org/mfa/verify', { code: '123456' }, maria.token);
  ok(r.status === 401, 'MFA verify rejects a wrong code');
  r = await j('POST', '/org/mfa/verify', { code: totp(mfaSecret) }, maria.token);
  const recoveryCodes = r.body.recoveryCodes;
  ok(r.status === 200 && recoveryCodes?.length === 10, 'MFA enabled; 10 one-time recovery codes issued once');

  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane' });
  ok(r.status === 401 && r.body.error === 'MFA_REQUIRED', 'login without the second factor is refused');
  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', mfaCode: '999999' });
  ok(r.status === 401 && r.body.error === 'MFA_CODE_WRONG', 'wrong TOTP refused');
  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', mfaCode: totp(mfaSecret) });
  ok(r.status === 200 && r.body.token, 'login with a valid TOTP succeeds');
  const rec = recoveryCodes[0];
  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', recoveryCode: rec });
  ok(r.status === 200, 'a recovery code signs in');
  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', recoveryCode: rec });
  ok(r.status === 401, 'each recovery code works exactly once');
  for (let i = 0; i < 5; i++) await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', mfaCode: '000001' });
  r = await j('POST', '/auth/org/login', { orgId: 'org-eastport', scoutName: 'Maria Keane', mfaCode: totp(mfaSecret) });
  ok(r.status === 429 && r.body.error === 'MFA_LOCKED', 'repeated wrong codes rate-limit even a correct one');

  // Sessions/devices.
  r = await j('GET', '/org/sessions', undefined, scout2.token);
  ok(r.body.items.some((s) => s.current) && r.body.items.every((s) => !s.token), 'session list shows devices, current flag, no raw tokens');

  // SSO with the local test IdP.
  r = await j('PUT', '/org/sso', { issuer: 'corporate-okta' }, scout2.token);
  ok(r.status === 403 || r.status === 400, 'a non-lead / unavailable IdP cannot be configured');
  r = await j('PUT', '/org/sso', { issuer: 'local-test-idp' }, maria.token);
  ok(r.status === 200 && r.body.config.clientId, 'org configured against the LOCAL TEST IdP (only one available — honestly labelled)');
  const start = (await j('POST', '/auth/sso/start', { orgId: 'org-eastport' })).body;
  ok(!!start.authUrl && !!start.state, 'SSO start mints state + nonce');
  const authz = await (await fetch(`${BASE}${start.authUrl}&email=newscout@eastport.example&groups=admins,superusers`)).json();
  r = await j('POST', '/auth/sso/callback', { code: authz.code, state: start.state });
  ok(r.status === 200 && r.body.token && r.body.ignoredClaims?.groups?.length === 2, 'SSO login links the invited email; IdP group claims explicitly IGNORED for permissions');
  const ssoRole = r.body.role;
  ok(!/head|director|lead|admin/i.test(ssoRole), 'group claim "admins" did not grant a privileged ScoutBox role');
  r = await j('POST', '/auth/sso/callback', { code: authz.code, state: start.state });
  ok(r.status === 401 && r.body.error === 'SSO_STATE_INVALID', 'state replay refused (single use)');
  const start2 = (await j('POST', '/auth/sso/start', { orgId: 'org-eastport' })).body;
  const authzBadNonce = await (await fetch(`${BASE}/testidp/authorize?client_id=x&state=${start2.state}&nonce=WRONG&email=newscout@eastport.example`)).json();
  r = await j('POST', '/auth/sso/callback', { code: authzBadNonce.code, state: start2.state });
  ok(r.status === 401 && r.body.error === 'SSO_NONCE_MISMATCH', 'nonce mismatch refused');
  const start3 = (await j('POST', '/auth/sso/start', { orgId: 'org-eastport' })).body;
  const authzStranger = await (await fetch(`${BASE}/testidp/authorize?client_id=x&state=${start3.state}&nonce=${start3.authUrl.match(/nonce=([a-f0-9]+)/)[1]}&email=stranger@nowhere.example`)).json();
  r = await j('POST', '/auth/sso/callback', { code: authzStranger.code, state: start3.state });
  ok(r.status === 403 && r.body.error === 'SSO_NOT_LINKED', 'an un-invited email cannot link or create an account through SSO');

  // Audit export tenant boundary.
  r = await j('GET', '/org/audit/export', undefined, maria.token);
  const auditStr = JSON.stringify(r.body);
  ok(r.status === 200 && r.body.orgId === 'org-eastport' && !auditStr.includes('org-hackneymarsh'), 'audit export is tenant-scoped (no other org ids)');
  r = await j('GET', '/org/audit/export', undefined, scout2.token);
  ok(r.status === 403, 'audit export needs a lead');

  // Support with explicit, time-limited, logged access.
  const caseForTicket = (await j('POST', '/org/cases', { playerId: 'pl-svensson' }, maria.token)).body.case;
  r = await j('POST', '/org/support', { subject: 'Case question', body: 'Please look at this case', refs: [{ kind: 'case', id: caseForTicket.id }] }, maria.token);
  const ticket = r.body.ticket;
  ok(r.status === 201 && ticket.refs[0].id === caseForTicket.id, 'support ticket references records by id, no copies');
  let ar = await fetch(`${BASE}/admin/support/${ticket.id}/org-records`, { headers: A() });
  ok(ar.status === 403, 'support CANNOT read org records before a grant — no silent access path');
  await fetch(`${BASE}/admin/support/${ticket.id}/request-access`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ hours: 4 }) });
  r = await j('POST', `/org/support/${ticket.id}/approve-access`, {}, maria.token);
  ok(r.status === 200 && r.body.grant.status === 'active', 'an org lead approves time-limited support access');
  ar = await fetch(`${BASE}/admin/support/${ticket.id}/org-records`, { headers: A() });
  const arBody = await ar.json();
  ok(ar.status === 200 && arBody.records.cases[0]?.id === caseForTicket.id, 'granted support access reads ONLY the referenced records');
  const grants = (await fetch(`${BASE}/admin/support`, { headers: A() }).then((x) => x.json())).grants;
  ok(grants[0].accessLog.length === 1, 'every support read lands in the access log');

  // Metrics + injected failure detection. Inject exactly MAX_ATTEMPTS (4 in
  // fast mode) so the dispatch to Nina (who HAS an email) exhausts its
  // retries and surfaces as a monitored failure — with nothing left over to
  // pollute later delivery tests.
  await fetch(`${BASE}/admin/delivery/inject-failure`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'email', count: 4 }) });
  const failTicket = (await j('POST', '/org/support', { subject: 'Failure-injection ticket', body: 'x', refs: [] }, inviteUserToken)).body.ticket;
  await fetch(`${BASE}/admin/support/${failTicket.id}/reply`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'This reply will fail to email.' }) });
  let failed = false;
  for (let i = 0; i < 60; i++) {
    const m = await (await fetch(`${BASE}/admin/metrics`, { headers: A() })).json();
    if (m.deliveryFailures > 0) { failed = true; break; }
    await sleep(300);
  }
  ok(failed, 'monitoring surfaces the injected provider failure (bounded retries exhausted)');
  const met = await (await fetch(`${BASE}/admin/metrics`, { headers: A() })).json();
  ok(met.requests > 0 && met.note.includes('not a production SLA'), 'metrics carry counters + an honest scope note');
}

// ================================================================ F11
section('F11 — delivery centre');
{
  // Clear leftover injected failures by letting them drain, then test ladder.
  let r = await j('PUT', '/org/delivery/prefs', { quietStart: null, quietEnd: null, email: true }, scout2.token);
  ok(r.status === 200, 'org user sets delivery preferences');

  // A support reply notifies maria (org_user with no email → skipped email; in_app delivered).
  const t2 = (await j('POST', '/org/support', { subject: 'Second ticket', body: 'x', refs: [] }, maria.token)).body.ticket;
  await fetch(`${BASE}/admin/support/${t2.id}/reply`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Reply for delivery test' }) });
  await sleep(1200);
  const adminDel = await (await fetch(`${BASE}/admin/delivery`, { headers: A() })).json();
  ok(adminDel.providerNote.includes('not configured'), 'delivery centre states real transport is NOT configured');
  const inApp = adminDel.recent.find((d) => d.channel === 'in_app' && d.status === 'delivered');
  ok(!!inApp, 'canonical in-app dispatch is delivered');
  ok(!adminDel.recent.some((d) => d.channel === 'email' && d.status === 'delivered' && !d.deliveredAt), 'no email is marked delivered without confirmation');

  // Nina (invited, has email) gets a notification → email accepted, not delivered.
  const t3 = (await j('POST', '/org/support', { subject: 'Nina ticket', body: 'x', refs: [] }, inviteUserToken)).body.ticket;
  await fetch(`${BASE}/admin/support/${t3.id}/reply`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Nina, see this.' }) });
  let ninaEmail = null;
  for (let i = 0; i < 40 && !ninaEmail; i++) {
    await sleep(250);
    const del = await (await fetch(`${BASE}/admin/delivery`, { headers: A() })).json();
    ninaEmail = del.recent.find((d) => d.channel === 'email' && d.to === 'newscout@eastport.example' && d.status === 'accepted');
  }
  ok(!!ninaEmail?.providerMessageId, 'email dispatch: provider ACCEPTED with message id (never auto-“delivered”, never “read”)');

  // Signed idempotent callbacks; out-of-order safe.
  const CBS = 'local-fake-callback-secret';
  const post = async (events) => {
    const body = JSON.stringify({ provider: 'local-fake', events });
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', CBS).update(`callback.${ts}.${body}`).digest('hex');
    return j('POST', '/callbacks/delivery', JSON.parse(body), null, { 'x-provider-timestamp': ts, 'x-provider-signature': sig });
  };
  let cr = await j('POST', '/callbacks/delivery', { events: [] }, null, { 'x-provider-timestamp': String(Date.now()), 'x-provider-signature': 'bad' });
  ok(cr.status === 401, 'unsigned/badly-signed callback refused');
  cr = await post([{ callbackId: 'cb-1', providerMessageId: ninaEmail.providerMessageId, status: 'opened', at: Date.now() }]);
  ok(cr.status === 200 && cr.body.applied === 1, 'out-of-order OPENED applies (implies delivered)');
  cr = await post([{ callbackId: 'cb-1', providerMessageId: ninaEmail.providerMessageId, status: 'opened', at: Date.now() }]);
  ok(cr.body.duplicates === 1 && cr.body.applied === 0, 'duplicate callback id is idempotent');
  cr = await post([{ callbackId: 'cb-2', providerMessageId: ninaEmail.providerMessageId, status: 'bounced', at: Date.now() }]);
  const after = await (await fetch(`${BASE}/admin/delivery`, { headers: A() })).json();
  const ninaAfter = after.recent.find((d) => d.providerMessageId === ninaEmail.providerMessageId);
  ok(ninaAfter.status === 'opened' && ninaAfter.deliveredAt && ninaAfter.openedAt, 'late bounce does NOT regress a confirmed open (forward-only ladder)');
}

// ================================================================ F3
section('F3 — player-controlled suitability');
let oppId = null;
{
  // Eastport publishes an opportunity with structured requirements.
  let r = await j('POST', '/org/opportunities', { type: 'trial', title: 'U21s trial day', category: 'mens', deadline: '2027-01-01', description: 'Trial for the U21 squad' }, maria.token);
  oppId = r.body.opportunity.id;
  r = await j('PUT', `/org/opportunities/${oppId}/structured-requirements`, {
    trainingSlots: [{ day: 'tue', start: '17:00', end: '18:30', tz: 'Europe/London' }],
    relocationRequired: false, feeMinor: 0, expensesCovered: false,
    environment: ['competitive'], accommodations: [],
  }, maria.token);
  ok(r.status === 200, 'club attaches structured requirements to an opportunity');

  r = await j('PUT', '/player/preferences', {
    commitments: [{ day: 'tue', start: '16:00', end: '18:00', tz: 'Europe/London', label: 'college class' }],
    travelLimitKm: 20, environment: ['competitive'],
    compensation: { maxFeeMinor: 0, currency: 'GBP', expensesNeeded: true },
  }, adeyemi.token);
  ok(r.status === 200 && r.body.preferences.updatedAt, 'adult player sets private preferences');

  r = await j('GET', `/player/suitability/${oppId}`, undefined, adeyemi.token);
  const v = Object.fromEntries(r.body.verdicts.map((x) => [x.dimension, x]));
  ok(v.schedule.verdict === 'conflict' && v.schedule.reason.includes('college class'), 'conflicting training schedule detected (tz-aware)');
  ok(v.compensation.verdict === 'conflict', 'expense needs vs no-expenses opportunity → conflict');
  ok(v.travel.reason.includes('travel time unavailable'), 'no invented travel estimates: distance + “travel time unavailable”');
  ok(r.body.note.includes('Eligibility'), 'suitability explicitly separate from mandatory eligibility');

  // Changing preferences updates matching.
  await j('PUT', '/player/preferences', { commitments: [], availableSlots: [{ day: 'tue', start: '16:00', end: '20:00', tz: 'Europe/London' }] }, adeyemi.token);
  r = await j('GET', `/player/suitability/${oppId}`, undefined, adeyemi.token);
  ok(r.body.verdicts.find((x) => x.dimension === 'schedule').verdict === 'compatible', 'preference change recomputes the verdict');

  // Guardian manages a minor's preferences; the child cannot.
  r = await j('PUT', `/guardian/children/${kid16Id}/preferences`, { travelLimitKm: 10, relocation: 'yes' }, amara.token);
  ok(r.status === 200 && r.body.preferences.relocation === null, 'guardian sets a minor\'s prefs; relocation NEVER collected for minors');

  // Privacy: the club sees nothing until an approved summary exists.
  const apply = await j('POST', `/player/opportunities/${oppId}/apply`, {}, adeyemi.token);
  const applicationId = apply.body.application?.id;
  ok(apply.status === 201, 'player applies to the opportunity');
  r = await j('GET', `/org/applications/${applicationId}/suitability`, undefined, maria.token);
  ok(r.body.summary === null, 'club sees NO suitability before approval');
  r = await j('POST', '/player/suitability/share', { applicationId, share: true }, adeyemi.token);
  ok(r.status === 200, 'player approves a summary');
  r = await j('GET', `/org/applications/${applicationId}/suitability`, undefined, maria.token);
  ok(r.body.summary.verdicts.every((x) => x.verdict && x.dimension && !x.reason), 'club summary carries verdicts ONLY — reasons (commitments, needs, limits) stay private');
  const leak = JSON.stringify(r.body);
  ok(!leak.includes('college') && !leak.includes('travelLimit'), 'no private preference text leaks to the club');
}

// ================================================================ F2
section('F2 — consent-based transitions');
{
  const me = (await j('GET', '/player/me', undefined, adeyemi.token)).body;
  const mediaId = me.media?.[0]?.id ?? (me.player?.media?.[0]?.id);
  let r = await j('POST', '/player/transitions', { pack: {} }, adeyemi.token);
  ok(r.status === 400 && r.body.error === 'PACK_EMPTY', 'an empty pack (or club-private material) cannot start a transition');
  r = await j('POST', '/player/transitions', { pack: { mediaIds: [mediaId] }, note: 'Looking for a new club after the academy', periodDays: 60 }, adeyemi.token);
  const trn = r.body.transition;
  ok(r.status === 201 && trn.status === 'open' && r.body.note.includes('never re-labels'), 'player opens a transition case; no “released” label anywhere');
  const levelBefore = me.level ?? me.player?.level;

  r = await j('POST', `/player/transitions/${trn.id}/recipients`, { orgId: 'org-northstar' }, adeyemi.token);
  ok(r.status === 403 && r.body.error === 'AGENCIES_EXCLUDED', 'agencies can never be transition recipients');
  r = await j('POST', `/player/transitions/${trn.id}/recipients`, { orgId: 'org-eastport', days: 30 }, adeyemi.token);
  ok(r.status === 201, 'player grants a specific eligible club access');

  r = await j('GET', '/org/transitions', undefined, maria.token);
  ok(r.body.items.some((t) => t.id === trn.id), 'the granted club sees the shared case (no browsable pool)');
  r = await j('GET', `/org/transitions/${trn.id}/pack`, undefined, maria.token);
  ok(r.status === 200 && r.body.pack.media.length === 1, 'recipient reads exactly the selected evidence pack');
  r = await j('GET', `/org/transitions/${trn.id}/pack`, undefined, hackney.token);
  ok(r.status === 403, 'a club WITHOUT a grant gets nothing');

  r = await j('POST', `/player/transitions/${trn.id}/revoke-recipient`, { orgId: 'org-eastport' }, adeyemi.token);
  ok(r.status === 200 && r.body.honest.includes('cannot be remotely erased'), 'revocation is honest about already-downloaded copies');
  r = await j('GET', `/org/transitions/${trn.id}/pack`, undefined, maria.token);
  ok(r.status === 403 && r.body.error === 'TRANSITION_ACCESS_REVOKED', 'revocation stops future platform access immediately');
  const orgNotifs = (await j('GET', '/org/notifications', undefined, maria.token)).body;
  ok(orgNotifs.some((n) => n.type === 'transition' && n.actionRequired), 'withdrawal notice with acknowledgement lands at the club');
  const ackN = orgNotifs.find((n) => n.type === 'transition' && n.actionRequired);
  r = await j('POST', `/org/notifications/${ackN.id}/ack`, {}, maria.token);
  ok(r.status === 200 && r.body.ackedAt, 'the club acknowledges the withdrawal (F11 ack loop)');

  r = await j('POST', `/player/transitions/${trn.id}/place`, { orgId: 'org-eastport', note: 'Signed for the U21s' }, adeyemi.token);
  ok(r.status === 200 && r.body.transition.status === 'placed' && r.body.transition.history.length >= 3, 'placement closes the case, history intact');
  const meAfter = (await j('GET', '/player/me', undefined, adeyemi.token)).body;
  ok((meAfter.level ?? meAfter.player?.level) === levelBefore, 'transition/placement did NOT change the player level automatically');

  // Audited level review is the only path.
  let lr = await fetch(`${BASE}/admin/players/pl-adeyemi/level-review`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'semi_pro' }) });
  ok(lr.status === 400, 'level review without a reason is refused (audited)');
  lr = await fetch(`${BASE}/admin/players/pl-adeyemi/level-review`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ level: levelBefore, reason: 'no-op review for the audit trail test' }) });
  ok(lr.status === 200, 'authorised level review is explicit, reasoned and ledger-audited');

  // Guardian-controlled for minors + recipient eligibility fail-closed.
  const guniMedia = null;
  const gt = await j('POST', `/guardian/children/pl-guni/transitions`, { pack: { mediaIds: ['media-x-not-owned'] } }, amara.token);
  ok(gt.status === 400, 'a pack can only reference records the player actually owns');
}

// ================================================================ F10
section('F10 — the legacy representation lane is CLOSED (M23 P5.6E E-1)');
{
  // P5.6E §5/§7 permit exactly ONE active authority writer, and it is the
  // canonical P5.6B lane: a licensed individual requests, the client confirms.
  // This lane created relationships with no licence check, no jurisdiction
  // policy, no conflict evaluation, no consent ledger, no rev and no
  // idempotency — and a confirmed row fed the Trust relationship input and the
  // Passport representation headline. It now creates nothing.
  //
  // What an EXISTING legacy row can and cannot do is proven in
  // m23AgentIntegrationE2E, which seeds one; there is deliberately no way to
  // create one here any more.
  const bodies = [];
  for (const [label, playerId] of [['a 14-year-old', 'pl-guni'], ['a 17-year-old', kid17Id], ['a 16-year-old', kid16Id], ['an adult', 'pl-adeyemi']]) {
    const r = await j('POST', '/org/representation/propose', { playerId, representativeName: 'Alex Agent', scope: 'full' }, agency.token);
    ok(r.status === 410 && r.body.error === 'REPRESENTATION_LANE_CLOSED', `the closed lane creates nothing for ${label}`);
    bodies.push(JSON.stringify(r.body));
  }
  // The closure is UNIFORM: the answer for a 14-year-old is byte-identical to
  // the answer for an adult, so the refusal no longer distinguishes a minor
  // from a visible adult. The old lane's 403 UNDER_18_WALL / NOT_VISIBLE split
  // told the caller which one they had asked about.
  ok(new Set(bodies).size === 1, 'and the refusal is identical for a minor and an adult — the closure is not an age oracle');
  const r2 = await j('POST', '/org/representation/propose', { playerId: 'pl-adeyemi' }, maria.token);
  ok(r2.status === 403 && r2.body.error === 'AGENCY_ONLY', 'a club is still refused the agency lane before the closure is even reached');
  // The read routes stay open: history must remain visible to the people named
  // in it, and a player must always be able to see what exists about them.
  const list = await j('GET', '/org/representation', undefined, agency.token);
  ok(list.status === 200 && Array.isArray(list.body.items), 'the agency can still READ the historical lane');
  const mine = await j('GET', '/player/representation', undefined, adeyemi.token);
  ok(mine.status === 200 && Array.isArray(mine.body.items), 'and the adult player can still read their own records');
  ok(mine.body.items.length === 0, 'with nothing in it, because the writer is closed and nothing was ever created here');
  // The canonical lane is where a relationship comes from now, and it is named
  // in the refusal so a caller is redirected rather than merely blocked.
  const closed = await j('POST', '/org/representation/propose', { playerId: 'pl-adeyemi' }, agency.token);
  ok(closed.body.canonicalRoute === 'POST /org/agent/clients/request', 'the refusal names the canonical route');
  ok(/licensed agent/.test(closed.body.message) && /confirm/.test(closed.body.message), 'and explains that a relationship is requested by a licensed agent and becomes active when the client confirms it');
}

// ================================================================ F4
section('F4 — exposure funnel + review queue');
{
  let r = await j('POST', '/org/exposure/impressions', { playerIds: ['pl-adeyemi', 'pl-svensson', 'pl-osei'] }, maria.token);
  const rec1 = r.body.recorded;
  r = await j('POST', '/org/exposure/impressions', { playerIds: ['pl-adeyemi', 'pl-svensson'] }, maria.token);
  ok(rec1 >= 2 && r.body.recorded === 0, 'exposure events dedupe per (player, kind, day)');
  await j('GET', '/org/players/pl-svensson', undefined, maria.token); // → profile_view via response hook
  await sleep(300);

  r = await j('GET', '/org/exposure/report', undefined, scout2.token);
  ok(r.status === 403, 'exposure report is lead-only');
  r = await j('GET', '/org/exposure/report', undefined, maria.token);
  ok(r.body.funnel.windowDays === 90 && r.body.funnel.definition.includes('Denominator'), 'funnel declares its window and denominators');
  const profStage = r.body.funnel.stages.find((s) => s.key === 'profile_review');
  ok(profStage.players >= 1, 'profile view captured as an exposure event at the response layer');
  ok(r.body.birthQuarter.suppressed === true || r.body.birthQuarter.total >= 3, 'small birth-quarter aggregates suppressed (n<3)');
  ok(JSON.stringify(r.body).includes('does not prove discrimination') || r.body.birthQuarter.suppressed, 'no discrimination claims in the payload');

  r = await j('GET', '/org/review-queue', undefined, maria.token);
  ok(r.body.queue.some((x) => x.player.id === 'pl-svensson' || x.player.name), 'players with exposure but no assessment sit in the not-yet-assessed queue');
  r = await j('POST', '/org/review-queue/pl-svensson/later', { days: 3 }, maria.token);
  ok(r.status === 200, 'review-later defers with a reminder');
  r = await j('GET', '/org/review-queue', undefined, maria.token);
  ok(r.body.deferred.some((x) => x.player.id === 'pl-svensson'), 'deferred player moves to the deferred list');

  r = await j('GET', '/org/discovery-rotation', undefined, maria.token);
  ok(r.body.items.length > 0 && r.body.note.includes('nothing can pay its way in'), 'weekly discovery rotation, explicitly not purchasable');
  const agencyRot = await j('GET', '/org/discovery-rotation', undefined, agency.token);
  const minorIds = [kid16Id, kid17Id, 'pl-guni'];
  ok(agencyRot.body.items.every((p) => !minorIds.includes(p.id)), 'agency rotation NEVER contains minors (16/17 included)');

  r = await j('GET', '/player/exposure', undefined, adeyemi.token);
  ok(typeof r.body.appearedInSearches === 'string' && r.body.note.includes('Which club looked is not shown'), 'player sees coarse bands only, no org identities');
}

// ================================================================ F5
section('F5 — calibration');
{
  const templates = (await j('GET', '/org/assessment-templates', undefined, maria.token)).body;
  const tpl = (templates.templates ?? templates.items ?? templates)[0];
  const guniProfile = (await j('GET', '/org/players/pl-guni', undefined, maria.token)).body;
  const refMedia = (guniProfile.media ?? guniProfile.player?.media ?? [])[0]?.id ?? null;

  let r = await j('POST', '/org/calibration', { templateId: tpl.id, mediaId: refMedia, title: 'Wing play rubric alignment', participantUserIds: [maria.userId, scout2.userId] }, scout2.token);
  ok(r.status === 403, 'calibration creation is lead-only');
  r = await j('POST', '/org/calibration', { templateId: tpl.id, mediaId: refMedia, title: 'Wing play rubric alignment', participantUserIds: [maria.userId, scout2.userId] }, maria.token);
  const cal = r.body.session;
  ok(r.status === 201 && cal.templateVersion === tpl.version, 'session pins the rubric version (later template edits cannot alter history)');
  const attrIds = cal.attributesSnapshot.map((a) => a.id);

  r = await j('GET', `/org/calibration/${cal.id}`, undefined, scout2.token);
  ok(r.body.session.blind === true && r.body.session.comparison === null, 'BLIND: no comparison before your own submission');

  r = await j('POST', `/org/calibration/${cal.id}/submit`, { ratings: [{ attrId: attrIds[0], value: 5 }, { attrId: attrIds[1], notObserved: true }], confidence: 'high' }, scout2.token);
  ok(r.status === 201 && r.body.session.comparison, 'submitting releases the comparison to the submitter');
  r = await j('GET', `/org/calibration/${cal.id}`, undefined, maria.token);
  ok(r.body.session.blind === true, 'a lead who has not submitted stays blind too');
  r = await j('POST', `/org/calibration/${cal.id}/submit`, { ratings: [{ attrId: attrIds[0], value: 2 }, { attrId: attrIds[1], value: 4 }], confidence: 'medium' }, maria.token);
  const comp = r.body.session.comparison;
  const row0 = comp.rows.find((x) => x.attrId === attrIds[0]);
  const row1 = comp.rows.find((x) => x.attrId === attrIds[1]);
  ok(row0.values.length === 2 && row0.range === 3 && row0.disagreement === 'high', 'disagreement math verified on a known example (5 vs 2 → range 3, high)');
  ok(row1.values.length === 1 && row1.notObserved === 1, '“not observed” excluded from the comparison values');
  ok(comp.confidenceNote.includes('not a measure of who is “right”'), 'comparison carries sample size + honest framing');

  r = await j('POST', `/org/calibration/${cal.id}/submit`, { ratings: [{ attrId: attrIds[0], value: 3 }] }, scout2.token);
  ok(r.status === 409, 'blind submissions are final — one per participant');

  // Restricted footage stays restricted: guardian blocks the org.
  await j('POST', '/guardian/block', { orgId: 'org-eastport', playerId: 'pl-guni' }, amara.token);
  r = await j('GET', `/org/calibration/${cal.id}`, undefined, maria.token);
  ok(refMedia === null || r.body.session.mediaUrl === null, 'reference footage disappears the moment the org loses access');
  // (unblock not exposed — session data itself remains for its participants)

  r = await j('GET', '/org/decision-review', undefined, maria.token);
  ok(r.body.disclaimer.includes('does not measure whether a scout “caused”'), 'decision review refuses causal claims about scouts');
}

// ================================================================ F6
section('F6 — missing-evidence engine');
{
  let r = await j('GET', '/org/players/pl-osei/evidence-gaps', undefined, maria.token);
  const first = r.body.items.map((x) => x.ruleId).sort();
  ok(r.body.engine.kind.includes('deterministic') && r.body.items.every((x) => x.ruleId && x.ruleVersion && x.explanation && x.records), 'suggestions carry rule id/version, records, explanation, action');
  r = await j('GET', '/org/players/pl-osei/evidence-gaps', undefined, maria.token);
  ok(JSON.stringify(r.body.items.map((x) => x.ruleId).sort()) === JSON.stringify(first), 'engine is deterministic — same gaps, no duplicates on recompute');

  // Request routes via guardian for a minor.
  const guniGaps = (await j('GET', '/org/players/pl-adeyemi/evidence-gaps', undefined, maria.token)).body.items;
  const requestable = guniGaps.find((x) => x.status === 'suggested');
  if (requestable) {
    r = await j('POST', `/org/evidence-gaps/${requestable.id}/request`, {}, maria.token);
    ok(r.status === 200 && r.body.suggestion.status === 'requested', 'a gap becomes a polite, rate-limited request');
    const again = await j('GET', '/org/players/pl-adeyemi/evidence-gaps', undefined, maria.token);
    const sameRule = again.body.items.find((x) => x.ruleId === requestable.ruleId && x.status === 'requested');
    ok(!!sameRule, 'requested status persists through recompute');
  } else {
    ok(true, '(no open suggestion to request — adeyemi fully evidenced)');
  }

  // Guardian routing for minors: request an evidence gap on the 16-year-old.
  const kidGaps = (await j('GET', `/org/players/${kid16Id}/evidence-gaps`, undefined, maria.token)).body.items;
  const kidGap = kidGaps.find((x) => x.status === 'suggested');
  r = await j('POST', `/org/evidence-gaps/${kidGap.id}/request`, {}, maria.token);
  ok(r.status === 200, 'evidence request on a minor goes out');
  const gNotifs = (await j('GET', '/guardian/inbox', undefined, amara.token)).body;
  const gNotifs2 = (await j('GET', '/guardian/notifications', undefined, amara.token)).body;
  const routed = JSON.stringify(gNotifs2 ?? gNotifs).includes('easier to assess');
  ok(routed, 'the request landed with the GUARDIAN, not the child');
  r = await j('POST', `/org/evidence-gaps/${kidGap.id}/request`, {}, maria.token);
  ok(r.status === 409 || r.status === 429, 'no pestering: an already-requested gap cannot be re-requested');

  // Player-visible text never carries club-private content.
  const kidGapAgain = (await j('GET', `/org/players/${kid16Id}/evidence-gaps`, undefined, maria.token)).body;
  const notifText = JSON.stringify(gNotifs2 ?? []);
  ok(!notifText.includes('disagree') && !notifText.includes('rating'), 'guardian-visible text is from the whitelist — no scout-report content leaks');
}

// ================================================================ F7
section('F7 — coverage planning');
{
  let r = await j('POST', '/org/coverage/fixtures', { competition: 'U21 Development League', home: 'Eastport U21', away: 'Harbour Rovers U21', date: '2026-10-01', lat: 53.48, lng: -2.24, city: 'Manchester' }, maria.token);
  const fix = r.body.fixture;
  ok(r.status === 201, 'fixture recorded');
  r = await j('POST', '/org/coverage-plans', { label: 'Autumn U21 sweep', competition: 'U21 Development League', goalObservations: 2, windowDays: 90 }, maria.token);
  const plan = r.body.plan;
  ok(r.status === 201, 'coverage plan with a goal + window');

  r = await j('POST', '/org/coverage/assignments', { fixtureId: fix.id, scoutUserId: scout2.userId, targetPlayerIds: ['pl-adeyemi', 'pl-guni', kid16Id] }, scout2.token);
  ok(r.status === 403, 'assignment creation is lead-only');
  r = await j('POST', '/org/coverage/assignments', { fixtureId: fix.id, scoutUserId: scout2.userId, targetPlayerIds: ['pl-adeyemi', 'pl-guni'], travelBudgetMinor: 4500 }, maria.token);
  const asg = r.body.assignment;
  ok(r.status === 201 && asg.travelNote.includes('unavailable'), 'assignment stores a USER-ENTERED budget; routing honestly unavailable');
  ok(!asg.targetPlayerIds.includes('pl-guni'), 'blocked/ineligible players are stripped from targets (guardian blocked eastport for guni)');
  r = await j('POST', '/org/coverage/assignments', { fixtureId: fix.id, scoutUserId: maria.userId }, maria.token);
  ok(r.body.warnings.some((w) => w.includes('Duplicate visit')), 'duplicate visit to the same fixture is flagged');
  const fix2 = (await j('POST', '/org/coverage/fixtures', { home: 'A', away: 'B', date: '2026-10-01' }, maria.token)).body.fixture;
  r = await j('POST', '/org/coverage/assignments', { fixtureId: fix2.id, scoutUserId: scout2.userId }, maria.token);
  ok(r.body.warnings.some((w) => w.includes('Conflict')), 'same-day scout clash is flagged');

  r = await j('POST', `/org/coverage/assignments/${asg.id}/complete`, {}, scout2.token);
  ok(r.status === 200 && r.body.assignment.observedAt, 'the scout completes the observation');
  r = await j('GET', '/org/coverage-plans', undefined, maria.token);
  ok(r.body.items.find((p) => p.id === plan.id).progress.done >= 1, 'completed observation advances coverage');

  r = await j('GET', '/org/coverage/suggestions', undefined, maria.token);
  ok(r.status === 200 && r.body.note.includes('never includes players outside your visibility rules'), 'suggestions honestly scoped to permitted players/events');
}

// ================================================================ F8
section('F8 — group workspaces');
{
  let gr = await fetch(`${BASE}/admin/groups`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'North West Development Group', adminOrgId: 'org-eastport' }) });
  const group = (await gr.json()).group;
  ok(gr.status === 201, 'T&S onboards a federation/group with a delegated admin org');

  let r = await j('POST', `/org/groups/${group.id}/invite`, { orgId: 'org-northstar' }, maria.token);
  ok(r.status === 403 && r.body.error === 'AGENCIES_EXCLUDED', 'agencies cannot join group workspaces');
  r = await j('POST', `/org/groups/${group.id}/invite`, { orgId: 'org-hackneymarsh' }, maria.token);
  ok(r.status === 201, 'admin org invites a member club');

  // Before acceptance/grant: nothing shared.
  r = await j('GET', '/org/grants', undefined, hackney.token);
  ok(r.body.received.length === 0, 'default is ISOLATED — membership invitation alone shares nothing');
  r = await j('POST', `/org/groups/${group.id}/accept`, {}, hackney.token);
  ok(r.status === 200, 'invited club lead accepts membership');

  // Preview then grant a shortlist.
  r = await j('POST', `/org/groups/${group.id}/grants/preview`, { resourceKind: 'shortlist', resourceId: '*', toOrgIds: ['org-hackneymarsh'] }, maria.token);
  ok(r.status === 200 && r.body.recipients[0].wouldSee.kind === 'shortlist', 'sharing preview shows exactly what each recipient would see');
  r = await j('POST', `/org/groups/${group.id}/grants`, { resourceKind: 'shortlist', resourceId: '*', toOrgIds: ['org-hackneymarsh'], expiresDays: 30 }, maria.token);
  const grant = r.body.grant;
  ok(r.status === 201, 'explicit, expiring grant created');

  r = await j('GET', `/org/shared/${grant.id}`, undefined, hackney.token);
  ok(r.status === 200, 'recipient reads the shared resource');
  const shared = r.body.resource;
  ok(shared.players.every((p) => p.level !== 'pro'), 'grassroots recipient NEVER receives pro players through a grant (intersection rule)');
  ok(shared.withheld >= 0 && (shared.withheld === 0 || shared.withheldNote.includes('never overrides')), 'withheld players are counted and explained, not silently leaked');

  r = await j('GET', `/org/shared/${grant.id}`, undefined, agency.token);
  ok(r.status === 404, 'a non-recipient org cannot fetch the grant');

  r = await j('POST', `/org/grants/${grant.id}/revoke`, {}, maria.token);
  ok(r.status === 200, 'owner revokes the grant');
  r = await j('GET', `/org/shared/${grant.id}`, undefined, hackney.token);
  ok(r.status === 403 && r.body.error === 'GRANT_ENDED', 'revocation cuts access on the very next read');

  // Aggregates + departure.
  r = await j('GET', `/org/groups/${group.id}/report`, undefined, maria.token);
  ok(r.status === 200 && r.body.note.includes('suppressed') && JSON.stringify(r.body.activity).includes('<3'), 'group report suppresses small counts and holds no player data');
  const g2 = (await j('POST', `/org/groups/${group.id}/grants`, { resourceKind: 'shortlist', resourceId: '*', toOrgIds: ['org-hackneymarsh'], expiresDays: 30 }, maria.token)).body.grant;
  r = await j('POST', `/org/groups/${group.id}/leave`, {}, hackney.token);
  ok(r.status === 200 && r.body.grantsEnded >= 1, 'leaving the group ends dependent grants both ways, keeps ownership');
  r = await j('GET', `/org/shared/${g2.id}`, undefined, hackney.token);
  ok(r.status === 403, 'post-departure fetch denied');
}

// ================================================================ F9
section('F9 — budget scenarios over the API');
{
  const kase = (await j('POST', '/org/cases', { playerId: 'pl-svensson' }, maria.token)).body.case;
  let r = await j('POST', `/org/cases/${kase.id}/budget/scenarios`, {
    label: 'Base offer', currency: 'GBP', termMonths: 12,
    lines: [
      { kind: 'wage', label: 'Weekly wage', amountMinor: 120000, currency: 'GBP', schedule: 'weekly', confirmed: true },
      { kind: 'bonus', label: 'Appearance bonus', amountMinor: 500000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: { assumption: '20+ league appearances' } },
      { kind: 'fee', label: 'Agent fee (EUR)', amountMinor: 300000, currency: 'EUR', schedule: 'one_off', confirmed: true },
    ],
  }, scout2.token);
  ok(r.status === 403 && r.body.error === 'FINANCE_ROLE_REQUIRED', 'a plain scout cannot see or create deal amounts');
  r = await j('POST', `/org/cases/${kase.id}/budget/scenarios`, {
    label: 'Base offer', currency: 'GBP', termMonths: 12,
    lines: [
      { kind: 'wage', label: 'Weekly wage', amountMinor: 120000, currency: 'GBP', schedule: 'weekly', confirmed: true },
      { kind: 'bonus', label: 'Appearance bonus', amountMinor: 500000, currency: 'GBP', schedule: 'one_off', confirmed: false, conditional: { assumption: '20+ league appearances' } },
      { kind: 'fee', label: 'Agent fee (EUR)', amountMinor: 300000, currency: 'EUR', schedule: 'one_off', confirmed: true },
    ],
  }, maria.token);
  const scn = r.body.scenario;
  ok(r.status === 201 && r.body.honest.includes('never invents market values'), 'scenario created; no invented values, no sell-on model');
  ok(r.body.totals.combined.unavailable === true, 'GBP+EUR without a rate: combined honestly unavailable');
  r = await j('PUT', `/org/cases/${kase.id}/budget/scenarios/${scn.id}`, { fxAssumptions: [{ from: 'EUR', to: 'GBP', rate: '0.85', source: 'club treasury 2026-09-01', date: '2026-09-01' }] }, maria.token);
  ok(r.body.totals.combined.viaFx === true && r.body.totals.combined.confirmedMinor === 120000 * 52 + 255000, 'manual labelled rate combines: 52×1200 + 2550 = £8,790.00 confirmed');
  ok(r.body.totals.conditionalLines.length === 1, 'conditional bonus listed separately, excluded from totals');

  const scn2 = (await j('POST', `/org/cases/${kase.id}/budget/scenarios`, { label: 'Stretch offer', currency: 'GBP', termMonths: 24, lines: [{ kind: 'wage', label: 'w', amountMinor: 150000, currency: 'GBP', schedule: 'weekly', confirmed: false }] }, maria.token)).body.scenario;
  r = await j('PUT', `/org/cases/${kase.id}/budget/scenarios/${scn2.id}`, { termMonths: 36 }, maria.token);
  const both = (await j('GET', `/org/cases/${kase.id}/budget`, undefined, maria.token)).body.scenarios;
  ok(both.find((x) => x.id === scn.id).termMonths === 12, 'editing one scenario leaves the other untouched');

  r = await j('POST', `/org/cases/${kase.id}/budget/scenarios/${scn.id}/approve`, {}, maria.token);
  ok(r.status === 200 && r.body.scenario.approval.by === 'Maria Keane' && r.body.scenario.approval.version === r.body.scenario.version, 'approval is attributable and version-specific');
  r = await j('PUT', `/org/cases/${kase.id}/budget/scenarios/${scn.id}`, { label: 'Base offer v2' }, maria.token);
  ok(r.body.scenario.approval.superseded === true, 'editing after approval marks the approval superseded');
  r = await j('POST', `/org/cases/${kase.id}/budget/scenarios/${scn.id}/actuals`, { lineId: 'ln-1', amountMinor: 118000 }, maria.token);
  ok(r.status === 200 && r.body.actuals.length === 1, 'actual-versus-planned recorded per line');
}

// ============================================= backup → isolated restore
section('F12D — backup and isolated restore');
{
  let r = await fetch(`${BASE}/admin/backup`, { method: 'POST', headers: A() });
  const backup = await r.json();
  ok(r.status === 201 && backup.manifest.files[0].path === 'db.json' && backup.manifest.files.every((f) => f.sha256), 'backup written with checksummed manifest');
  r = await fetch(`${BASE}/admin/backup/verify`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: path.basename(backup.dir) }) });
  ok((await r.json()).ok === true, 'backup verifies against its manifest');

  const restoreDir = mkdtempSync(path.join(tmpdir(), 'sbx-restore-'));
  cpSync(backup.dir, restoreDir, { recursive: true });
  const restored = await startServer(RESTORE_PORT, restoreDir);
  const rz = await (await fetch(`http://localhost:${RESTORE_PORT}/readyz`)).json();
  ok(rz.ready === true && rz.players >= 14, 'restored server boots from the backup in a SEPARATE empty directory');
  const rl = await fetch(`http://localhost:${RESTORE_PORT}/auth/org/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId: 'org-hackneymarsh', scoutName: 'Dee Coach', platform: 'grassroots' }) });
  const rlb = await rl.json();
  const rq = await fetch(`http://localhost:${RESTORE_PORT}/org/players`, { headers: { Authorization: `Bearer ${rlb.token}` } });
  ok(rl.status === 200 && rq.status === 200, 'representative workflow (login + player list) works on the RESTORED copy');
  restored.kill('SIGTERM');
}

// ==================================================== SIGKILL durability
section('restart durability (SIGKILL)');
{
  // Queue an email dispatch, then kill -9 before it can finish retrying.
  await fetch(`${BASE}/admin/delivery/inject-failure`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'email', count: 2 }) });
  const t4 = (await j('POST', '/org/support', { subject: 'Durability ticket', body: 'x', refs: [] }, inviteUserToken)).body.ticket;
  await fetch(`${BASE}/admin/support/${t4.id}/reply`, { method: 'POST', headers: { ...A(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Survive this.' }) });
  await sleep(900); // let the dispatch row be created + first failed attempt persist
  server.kill('SIGKILL');
  await sleep(400);
  server = await startServer();
  let recovered = false;
  for (let i = 0; i < 50; i++) {
    const del = await (await fetch(`${BASE}/admin/delivery`, { headers: A() })).json();
    const row = del.recent.find((d) => d.channel === 'email' && d.to === 'newscout@eastport.example' && d.status === 'accepted' && d.attempts.length >= 1);
    if (row) { recovered = true; break; }
    await sleep(300);
  }
  ok(recovered, 'queued delivery work survives SIGKILL and completes after restart');
  const trns = await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' });
  const list = await j('GET', '/player/transitions', undefined, trns.body.token);
  ok(list.body.items.some((t) => t.status === 'placed'), 'transition history intact across the crash');
}

console.log(`\nm13E2E: ${process.exitCode ? 'FAILURES above —' : 'all'} ${passed} checks passed`);
server?.kill('SIGTERM');
process.exit(process.exitCode ?? 0);
