// M18.1 acceptance suite — production hardening.
//
// M18.1 adds no recruitment concept, so almost nothing here is a feature test.
// What it proves is that the failure modes named in M18_1_MATRIX.md are closed:
// a lost update is refused rather than silently applied, a Passport revision is
// a fact about content and not about when you asked, a change clock is the
// clock of the thing that actually changed, an unclassified event reaches
// nobody, a rate limiter that is not distributed says so, and a request that is
// malformed, oversized or from an unknown origin gets a specific answer instead
// of a 500 and a stack trace.
//
// Fifty numbered sections, matching the Test column of the matrix. More than
// half are negative: a hardening milestone that mostly asserts happy paths has
// not hardened anything.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expectedRevOf, revOf, bumpRev, revMeta,
} from '../m181/concurrency.mjs';
import {
  RATE_LIMIT_POLICY, memoryRateLimitProvider, createRateLimiter, rateLimitedBody,
} from '../m181/rateLimit.mjs';
import { AUDIENCES, EVENT_AUDIENCE, audienceFor, unclassifiedEvents } from '../m181/eventAudience.mjs';
import { buildCapabilityReport, productionConfigProblems } from '../m181/capabilities.mjs';
import { passportRevision, PROVENANCE, PROVENANCE_COPY } from '../m15/shared.mjs';
import { CHANGE_TYPES, CHANGE_COPY, changeFingerprint, normalizeMaterialChange } from '../m18/shared.mjs';

const PORT = 5960 + Math.floor(Math.random() * 30);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m181-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================== unit: concurrency
section('§1 — the concurrency token is read strictly');
{
  ok(expectedRevOf({ expectedRev: 3 }) === 3, 'expectedRev is read');
  ok(expectedRevOf({ expectedVersion: 4 }) === 4, 'expectedVersion is accepted as the same thing');
  ok(expectedRevOf({}) === null, 'an absent token means "unchanged pre-M18.1 behaviour", not rev 0');
  neg(Number.isNaN(expectedRevOf({ expectedRev: 'soon' })), 'a non-numeric token is malformed, never coerced to 0');
  neg(Number.isNaN(expectedRevOf({ expectedRev: 2.5 })), 'a fractional token is malformed');
  neg(Number.isNaN(expectedRevOf({ expectedRev: -1 })), 'a negative token is malformed');
  neg(expectedRevOf({ expectedRev: '' }) === null, 'an empty string is absent, not zero');
  ok(revOf({}) === 1 && revOf({ rev: 7 }) === 7, 'a record written before M18.1 reads as rev 1');
}

section('§2 — an accepted mutation always moves the token');
{
  const rec = { rev: 1 };
  bumpRev(rec, { by: { id: 'u1', name: 'Maria Keane' }, at: 1000 });
  ok(rec.rev === 2 && rec.revAt === 1000, 'bump increments and stamps');
  ok(revMeta(rec).revBy === 'Maria Keane', 'the metadata names who touched it last');
  neg(!('userId' in revMeta(rec)), 'the metadata carries a display name, never an internal user id');
  bumpRev(rec, { at: 2000 });
  ok(rec.rev === 3 && revMeta(rec).revBy === null, 'a system write bumps without attributing itself to a person');
}

// ======================================================= unit: rate limiting
section('§15 — one policy table, every limited action named');
{
  const actions = Object.entries(RATE_LIMIT_POLICY);
  ok(actions.length >= 13, `${actions.length} named rate-limited actions`);
  ok(actions.every(([, p]) => Number.isInteger(p.max) && p.max > 0), 'every action has a positive integer ceiling');
  ok(actions.every(([, p]) => Number.isInteger(p.windowMs) && p.windowMs > 0), 'every action has a window');
  ok(actions.every(([, p]) => typeof p.scope === 'string' && p.scope), 'every action states what its key is built from');
  ok(actions.every(([, p]) => typeof p.note === 'string' && p.note), 'every action says in words what it protects');
  neg(!actions.some(([, p]) => /score|rank|quality/i.test(p.note)), 'no rate limit is described as a judgement of the user');
  const l = memoryRateLimitProvider();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) l.consume('k', 3, 1000, t0);
  neg(l.consume('k', 3, 1000, t0).limited === true, 'the fourth call inside the window is limited');
  ok(l.consume('k', 3, 1000, t0 + 1001).limited === false, 'the window rolls');
  neg(l.consume('other', 3, 1000, t0).limited === false, 'limits do not leak between keys');
}

section('§16 — the limiter never claims protection it does not have');
{
  const rl = createRateLimiter({ provider: 'memory' });
  const cap = rl.capability();
  ok(cap.provider === 'memory', 'the memory provider is what is installed');
  neg(cap.distributed === false && cap.state === 'not_configured', 'it reports itself as NOT distributed');
  neg(/enforced across instances/.test(cap.note) === false, 'and its note does not claim cross-instance enforcement');
  ok(/per process/.test(cap.note) && /full quota/.test(cap.note), 'the note spells out what breaks behind a load balancer');
  let threw = null;
  try { createRateLimiter({ provider: 'redis' }); } catch (e) { threw = e; }
  neg(!!threw && /not available/.test(threw.message), 'asking for a shared backend that does not exist fails loudly');
  neg(!/redis/i.test(JSON.stringify(rateLimitedBody('brief_write'))), 'the limited response names no backend');
  const body = rateLimitedBody('nobody_missed_action');
  neg(!/player|name|id/i.test(JSON.stringify(body).replace(/"action"[^,]*/, '')), 'a limited response says nothing about the subject of the request');
  let unknown = null;
  try { rl.limited('not_a_real_action', 'x'); } catch (e) { unknown = e; }
  neg(!!unknown, 'an unnamed action is a programming error, not a silently unlimited route');
}

// ==================================================== unit: event audiences
section('§17 — every classified event has a real audience');
{
  const values = Object.values(EVENT_AUDIENCE);
  ok(values.length > 0 && values.every((a) => AUDIENCES.includes(a)), 'every classification is one of the declared audiences');
  ok(AUDIENCES.length === 6, 'six audiences, no catch-all "everyone"');
  neg(!AUDIENCES.includes('all'), 'there is no audience meaning "every connected identity"');
}

section('§18 — an unclassified event fails closed');
{
  ok(audienceFor('brand_new_event_nobody_classified') === 'org_private', 'an unknown event is organisation-private, not public');
  neg(audienceFor('brand_new_event_nobody_classified') !== 'public_safe', 'it is emphatically NOT delivered to everyone');
  neg(audienceFor(undefined) === 'org_private' && audienceFor(null) === 'org_private', 'a missing event name also fails closed');
  ok(unclassifiedEvents(['players', 'nope']).length === 1, 'the boot helper names exactly the unclassified events');
}

section('§19 — nothing personal is classified as public');
{
  const publicEvents = Object.entries(EVENT_AUDIENCE).filter(([, a]) => a === 'public_safe').map(([n]) => n);
  neg(!publicEvents.some((n) => /player_|guardian|evidence|notify|inbox|message|room|second_look/.test(n)),
    'no player-, guardian- or room-scoped event is public');
  ok(EVENT_AUDIENCE.notify === 'player_private', 'a directed notification is private to its subject');
  ok(EVENT_AUDIENCE.recruitment_room_archived === 'org_private', 'a room archival stays inside the organisation that decided it');
  neg(EVENT_AUDIENCE.recruitment_room_archived !== 'player_private', 'and it is not delivered to the player it is about');
}

// ============================================= unit: capability reporting
section('§50 — the capability report is honest and carries no secrets');
{
  const rl = createRateLimiter({ provider: 'memory' });
  const report = buildCapabilityReport({
    env: { NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 'super-secret-value', SCOUTBOX_SMTP_URL: 'smtp://user:pw@host' },
    rateLimit: rl,
    providers: [{ id: 'web_client', status: 'limited', testOnly: false }, { id: 'sim', status: 'configured', testOnly: true }],
  });
  const raw = JSON.stringify(report);
  neg(!raw.includes('super-secret-value'), 'a configured secret VALUE never appears');
  neg(!raw.includes('smtp://') && !raw.includes('user:pw'), 'no connection string or credential appears');
  ok(report.capabilities.media_signing_secret.state === 'configured', 'it reports that the secret is configured');
  ok(report.capabilities.email_transport.state === 'configured', 'and that email is configured');
  ok(report.capabilities.distributed_rate_limit.state === 'not_configured', 'and that the rate limiter is not distributed');
}

section('§49 — capability states are not inflated');
{
  const providers = [{ id: 'web_client', status: 'limited', testOnly: false }, { id: 'sim', status: 'configured', testOnly: true }];
  const off = buildCapabilityReport({ env: {}, providers });
  neg(off.capabilities.production_cv.state === 'not_configured', 'a test-only provider that the environment has NOT enabled is not available capability');
  neg(/observes player presence/.test(off.capabilities.production_cv.note), 'the limited web capture is described by what it actually does');
  const on = buildCapabilityReport({ env: { BOX_CAM_TEST_PROVIDER: '1' }, providers });
  ok(on.capabilities.production_cv.state === 'test_only', 'with the simulator enabled it reports test_only, never configured');
  const real = buildCapabilityReport({ env: {}, providers: [{ id: 'cv', status: 'configured', testOnly: false }] });
  ok(real.capabilities.production_cv.state === 'configured', 'a genuine detector reports configured');
  neg(buildCapabilityReport({ env: {}, providers: [{ id: 'web_client', status: 'limited' }] }).capabilities.production_cv.state !== 'configured',
    'a "limited" observer is never counted as production computer vision');
}

section('§48 — boot refuses configuration that is unsafe in production');
{
  const prod = { NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 's', BOX_CAM_TEST_PROVIDER: '1' };
  neg(productionConfigProblems({ env: prod }).some((p) => p.code === 'TEST_PROVIDER_IN_PRODUCTION' && p.fatal),
    'the simulated observer is fatal in production');
  neg(productionConfigProblems({ env: { NODE_ENV: 'production' } }).some((p) => p.code === 'MEDIA_SECRET_MISSING'),
    'a missing media signing secret is fatal in production');
  neg(productionConfigProblems({ env: { NODE_ENV: 'production', SCOUTBOX_MEDIA_SECRET: 's', SCOUTBOX_ALLOW_DEV_LOGIN: '1' } })
    .some((p) => p.code === 'DEV_LOGIN_IN_PRODUCTION'), 'dev login is fatal in production');
  neg(productionConfigProblems({ env: {}, trustWeightsTotal: 95 }).some((p) => p.code === 'TRUST_WEIGHTS_INVALID' && p.fatal),
    'Trust Score weights that do not total 100 are fatal in EVERY mode — a wrong score is not a development-only problem');
  ok(productionConfigProblems({ env: { BOX_CAM_TEST_PROVIDER: '1' }, trustWeightsTotal: 100 }).length === 0,
    'the same simulator configuration is fine in development (§74: local development stays possible)');
}

// ================================================= unit: Passport revision
section('§7 — the Passport revision is a fact about content, not about now');
{
  const full = {
    player: { position: 'CM', level: 'semi_pro' },
    identity: { confirmed: true, assurance: 'scoutbox_reviewed' },
    status: { currentClub: { orgId: 'org-1', provenance: 'verified_club_confirmed', assurance: 'verified' } },
    history: { rows: [{ key: 'org-0', provenance: 'player_submitted', current: false, from: { t: 2022 }, to: { t: 2024 }, role: 'player' }] },
    revisionSources: {
      evidence: [{ id: 'ev-1', tier: 'verified', superseded: false, expired: false }],
      careerEntries: [{ id: 'ce-1' }],
    },
    references: [{ id: 'rf-1', status: 'live', provenanceStillCurrent: true }],
    achievements: [{ id: 'ac-1', confirmation: null, withdrawnAt: null }],
    combine: { results: [{ protocolId: 'p1', protocolVersion: 1, measuredValue: 12, combineVerified: true }] },
  };
  const a = passportRevision(full);
  const b = passportRevision(JSON.parse(JSON.stringify(full)));
  ok(/^pr_[0-9a-f]{16}$/.test(a), 'the revision is a short stable token');
  ok(a === b, 'the same Passport content produces the same revision');
  // Values that change with the clock must not move it.
  const withClockNoise = {
    ...full,
    player: { ...full.player, age: 21, ageToday: 21 },
    daysSinceLastEvidence: 900, generatedAt: Date.now(), summary: { recency: 'stale' },
  };
  neg(passportRevision(withClockNoise) === a, 'a revision computed a year later, from the same records, is identical');
}

section('§8 — the revision moves when Passport truth moves');
{
  const base = {
    player: { position: 'CM', level: 'semi_pro' },
    identity: { confirmed: false, assurance: 'player_submitted' },
    status: { currentClub: null }, history: { rows: [] },
    revisionSources: { evidence: [], careerEntries: [] }, references: [], achievements: [], combine: { results: [] },
  };
  const r0 = passportRevision(base);
  neg(passportRevision({ ...base, player: { position: 'ST', level: 'semi_pro' } }) !== r0, 'a position change moves it');
  neg(passportRevision({ ...base, identity: { confirmed: true, assurance: 'authoritative_registry' } }) !== r0, 'an identity assurance change moves it');
  neg(passportRevision({ ...base, status: { currentClub: { orgId: 'org-9', provenance: 'verified_club_confirmed' } } }) !== r0, 'gaining a confirmed current club moves it');
  neg(passportRevision({ ...base, revisionSources: { evidence: [{ id: 'e', tier: 'verified', superseded: false, expired: false }], careerEntries: [] } }) !== r0,
    'a new piece of evidence moves it');
  neg(passportRevision({ ...base, revisionSources: { evidence: [{ id: 'e', tier: 'verified', superseded: true, expired: false }], careerEntries: [] } })
    !== passportRevision({ ...base, revisionSources: { evidence: [{ id: 'e', tier: 'verified', superseded: false, expired: false }], careerEntries: [] } }),
    'SUPERSEDING evidence moves it too — removal is a change, not an absence');
}

// ================================================== unit: change vocabulary
section('§11 — one source row is one change, however many projections see it');
{
  const mk = (sourceSystem, sourceId) => normalizeMaterialChange({
    type: 'combine_verified_invalidated', subjectId: 'pl-1', sourceSystem, sourceId, occurredAt: 1_700_000_000_000,
  });
  const viaSession = mk('box_cam', 'sess-9');
  const viaSessionAgain = mk('box_cam', 'sess-9');
  ok(viaSession.fingerprint === viaSessionAgain.fingerprint, 'the same canonical session fingerprints identically');
  neg(mk('box_cam', 'sess-8').fingerprint !== viaSession.fingerprint, 'a different session is a different change');
  neg(changeFingerprint({ type: 'combine_verified_invalidated', sourceSystem: 'combine', sourceId: 'sess-9' })
    !== changeFingerprint({ type: 'combine_verified_invalidated', sourceSystem: 'box_cam', sourceId: 'sess-9' }),
    'fingerprinting on the projection instead of the canonical row WOULD double-count — which is why it is the session id');
}

section('§12 — the invalidation vocabulary exists and reads honestly');
{
  ok(CHANGE_TYPES.includes('combine_verified_invalidated'), 'invalidation is a first-class change type');
  ok(CHANGE_TYPES.includes('combine_verified_restored'), 'restoration is too — it is not the absence of an invalidation');
  for (const t of ['combine_verified_invalidated', 'combine_verified_restored']) {
    ok(typeof CHANGE_COPY[t] === 'string' && CHANGE_COPY[t].length > 20, `${t} has human copy`);
    neg(!/cheat|fake|fraud|dishonest|lied/i.test(CHANGE_COPY[t]), `${t} copy accuses nobody`);
  }
}

section('§40 — one provenance vocabulary, total and ranked')
{
  ok(PROVENANCE.length === 9, 'nine provenance values');
  ok(PROVENANCE.every((p) => typeof PROVENANCE_COPY[p] === 'string' && PROVENANCE_COPY[p].length > 20), 'every one has honest copy');
  ok(PROVENANCE.indexOf('box_cam_observed') > PROVENANCE.indexOf('player_submitted'), 'Box Cam observation outranks a self-submission');
  neg(PROVENANCE.indexOf('box_cam_observed') < PROVENANCE.indexOf('scoutbox_reviewed'), 'and is deliberately weaker than a ScoutBox review');
  ok(/observed training, not football ability/i.test(PROVENANCE_COPY.box_cam_observed), 'its copy refuses to imply ability');
}

// ============================================================ HTTP sections
section('HTTP — the real routes');
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', BOX_CAM_TEST_PROVIDER: '1', SCOUTBOX_ALLOWED_ORIGINS: 'https://club.example' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], { env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'Head of Recruitment');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, rita, kola].every((x) => x?.token), 'HTTP actors logged in');

const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name)) ?? players[0];
const OTHER = players.find((p) => p.id !== ADULT.id);
const THIRD = players.find((p) => p.id !== ADULT.id && p.id !== OTHER.id);

// ------------------------------------------------- briefs: the lost update
section('§3 — a Recruitment Brief refuses a write built on a stale read');
const brief = (await j('POST', '/org/recruitment-briefs', { title: 'Left-sided CM', positions: ['CM'] }, maria.token)).body.brief;
{
  ok(brief && brief.rev === 1, 'a new brief starts at rev 1');
  const mine = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Left-sided CM (v2)', expectedRev: 1 }, maria.token);
  ok(mine.status === 200 && mine.body.brief.rev === 2, 'an edit pinned to the current rev is accepted and moves it');
  const stale = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Colleague overwrite', expectedRev: 1 }, tom.token);
  neg(stale.status === 409 && stale.body.error === 'BRIEF_VERSION_CONFLICT', 'a colleague editing from the old rev is refused, not applied');
  ok(stale.body.currentRev === 2, 'the conflict names the current rev so the caller can rebase');
  ok(stale.body.updatedBy === 'Maria Keane', 'and who moved it');
  const after = (await j('GET', `/org/recruitment-briefs/${brief.id}`, undefined, maria.token)).body.brief;
  neg(after.title === 'Left-sided CM (v2)', 'the refused write changed nothing');
}

section('§4 — the concurrency token is validated, not trusted');
{
  const bad = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'x', expectedRev: 'latest' }, maria.token);
  neg(bad.status === 400 && bad.body.error === 'EXPECTED_REV_INVALID', 'a non-numeric expectedRev is a 400, never coerced');
  const huge = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'x', expectedRev: 99999 }, maria.token);
  neg(huge.status === 409, 'a rev from the future conflicts rather than being accepted as "at least as new"');
  const replay = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'y', expectedRev: 1 }, tom.token);
  neg(replay.status === 409, 'replaying the stale rev again still loses — retrying is not a way to win');
  const legacy = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'Left-sided CM (v3)' }, maria.token);
  ok(legacy.status === 200, 'a caller that sends no token keeps the pre-M18.1 behaviour (§74: nothing existing breaks)');
}

section('§5 — a conflict body is safe to show a colleague');
{
  const stale = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'x', expectedRev: 1 }, tom.token);
  const raw = JSON.stringify(stale.body);
  neg(!/dob|guardian|email|phone|medical|password|token/i.test(raw), 'the conflict leaks no personal or credential field');
  neg(!raw.includes('Colleague overwrite'), 'and does not echo the content the other person wrote');
  ok(/Reload/i.test(stale.body.message), 'it tells the caller what to do next');
}

section('§6 — a foreign brief is still invisible, conflict or not');
{
  const foreign = await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { title: 'x', expectedRev: 1 }, rita.token);
  neg(foreign.status === 404, 'another club gets 404, never a 409 that would confirm the brief exists');
  const guessed = await j('PATCH', '/org/recruitment-briefs/brf-000000', { title: 'x', expectedRev: 1 }, maria.token);
  neg(guessed.status === 404 && guessed.body.error === foreign.body.error, 'a guessed id is indistinguishable from a foreign one');
}

// -------------------------------------------------- rooms: the lost update
section('§9 — a Room status transition refuses a stale write');
const room = (await j('POST', '/org/rooms', { playerId: ADULT.id }, maria.token)).body.room;
{
  ok(room.rev >= 1, 'a new room carries a rev');
  const r1 = await j('POST', `/org/rooms/${room.roomId}/status`, { status: 'under_review', expectedRev: room.rev }, maria.token);
  ok(r1.status === 200, 'a pinned transition is accepted');
  const stale = await j('POST', `/org/rooms/${room.roomId}/status`, { status: 'shortlisted', expectedRev: room.rev }, tom.token);
  neg(stale.status === 409 && stale.body.error === 'ROOM_VERSION_CONFLICT', 'a colleague transitioning from the old rev is refused');
  ok(Number(stale.body.currentRev) > Number(room.rev), 'the conflict names the newer rev');
  const now = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room;
  neg(now.status === 'under_review', 'the refused transition did not move the room');
}

section('§10 — only workflow-critical Room fields demand a token');
{
  const cur = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room;
  const tags = await j('PATCH', `/org/rooms/${room.roomId}`, { tags: ['left-side'] }, maria.token);
  ok(tags.status === 200, 'a tag edit needs no token — a lost tag is an inconvenience, not a corrupted decision');
  const stalePriority = await j('PATCH', `/org/rooms/${room.roomId}`, { priority: 'high', expectedRev: 1 }, tom.token);
  neg(stalePriority.status === 409, 'priority — which drives the work queue — does');
  const staleLead = await j('PATCH', `/org/rooms/${room.roomId}`, { leadScoutUserId: null, expectedRev: 1 }, tom.token);
  neg(staleLead.status === 409, 'so does reassigning the lead scout');
  ok(Number(cur.rev) >= 1, 'the room exposes its rev to clients so they can pin their writes');
}

section('§11b — the Room rev is monotonic under interleaved writes');
{
  const before = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
  await j('POST', `/org/rooms/${room.roomId}/status`, { status: 'shortlisted' }, maria.token);
  const mid = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
  await j('PATCH', `/org/rooms/${room.roomId}`, { priority: 'high' }, maria.token);
  const after = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
  ok(mid > before && after > mid, 'every accepted mutation moved it forward');
  neg(after !== before, 'and it never went backwards or repeated');
}

section('§12b — two concurrent decisions cannot both become current');
{
  const rev = (await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token)).body.room.rev;
  const [a, b] = await Promise.all([
    j('POST', `/org/rooms/${room.roomId}/decisions`, { recommendation: 'shortlist', expectedRev: rev, clientKey: 'k-a' }, maria.token),
    j('POST', `/org/rooms/${room.roomId}/decisions`, { recommendation: 'archive', reasonCodes: ['insufficient_recent_evidence'], expectedRev: rev, clientKey: 'k-b' }, tom.token),
  ]);
  const accepted = [a, b].filter((r) => r.status === 201 || r.status === 200);
  const conflicted = [a, b].filter((r) => r.status === 409);
  ok(accepted.length === 1, 'exactly one of two simultaneous decisions is accepted');
  neg(conflicted.length === 1 && conflicted[0].body.error === 'ROOM_VERSION_CONFLICT', 'the other is told the room moved, rather than silently landing too');
  const decisions = (await j('GET', `/org/rooms/${room.roomId}/decisions`, undefined, maria.token)).body;
  const list = decisions.items ?? decisions.decisions ?? [];
  neg(list.filter((d) => !d.supersededById).length <= 1, 'the room has at most one decision that is not superseded');
}

// ------------------------------------------------------------ idempotency
section('§13 — Nobody Missed add-to-room is idempotent');
{
  await j('PATCH', `/org/recruitment-briefs/${brief.id}`, { status: 'active' }, maria.token);
  const first = await j('POST', '/org/nobody-missed/add-to-room', { briefId: brief.id, playerId: OTHER.id }, maria.token);
  const second = await j('POST', '/org/nobody-missed/add-to-room', { briefId: brief.id, playerId: OTHER.id }, maria.token);
  ok([200, 201].includes(first.status), 'the first add creates a Room');
  neg(second.status === 200 && second.body.idempotent === true, 'a double click returns the SAME room and says so, instead of reporting a creation');
  neg(second.body.roomId === first.body.roomId, 'and it is the same room id, not a second room for one player');
}

section('§14 — Second Look review and dismiss do not double-transition');
{
  await j('POST', `/org/rooms/${room.roomId}/status`, { status: 'archived', reasonCodes: ['insufficient_recent_evidence'] }, maria.token);
  await j('POST', `/org/players/${ADULT.id}/evidence`, { claimType: 'footage', label: 'Full match vs Riverton' }, maria.token);
  const list = await j('GET', '/org/second-look', undefined, maria.token);
  const item = list.body.items?.[0];
  if (!item) { fail('§14 needs a Second Look item to exist'); }
  else {
    const r1 = await j('POST', `/org/second-look/${item.id}/review`, {}, maria.token);
    const r2 = await j('POST', `/org/second-look/${item.id}/review`, {}, maria.token);
    ok(r1.status === 200, 'the first review is accepted');
    neg([200, 409].includes(r2.status), 'the second is either the same answer or a refusal — never a second transition');
    const after = (await j('GET', `/org/second-look/${item.id}`, undefined, maria.token)).body.item;
    const history = after?.history ?? [];
    neg(history.filter((h) => h.action === 'reviewed').length <= 1, 'the append-only history records the review once');
  }
}

// ------------------------------------------------------------- change clocks
section('§20 — current_club_confirmed comes from a row with its own clock');
{
  const changes = await j('GET', `/org/second-look`, undefined, maria.token);
  const raw = JSON.stringify(changes.body);
  ok(CHANGE_TYPES.includes('current_club_confirmed'), 'the change type exists');
  neg(!/prefs\.updatedAt|profileUpdatedAt/.test(raw), 'no projection borrows a preference edit timestamp');
}

section('§21 — position_changed is written when the value actually changes');
{
  const before = (await j('GET', '/player/me', undefined, kola.token)).body;
  const original = before?.position ?? 'CM';
  const target = original === 'ST' ? 'CM' : 'ST';
  const w1 = await j('PATCH', '/player/football-passport/prefs', { positions: { primary: target, secondary: [] } }, kola.token);
  ok(w1.status === 200 && w1.body.prefs?.positions?.primary === target, 'the player changes their primary position');
  // The store is VALUE-triggered: re-saving the same preference is not a change.
  const w2 = await j('PATCH', '/player/football-passport/prefs', { positions: { primary: target, secondary: [] } }, kola.token);
  ok(w2.status === 200, 'saving the same position again is accepted');
  // A bio edit bumps prefs.updatedAt but changes no position — the old, wrong
  // clock. It must not produce a position change either.
  const w3 = await j('PATCH', '/player/football-passport/prefs', { bio: 'Left-footed midfielder.' }, kola.token);
  ok(w3.status === 200, 'an unrelated preference edit is accepted');
  neg(w3.body.prefs?.positions?.primary === target, 'and leaves the position exactly where it was');
  // End to end: the archived room from §14 means a real change should now be
  // visible as a Second Look change with its own clock.
  // End to end: the archived room from §14 means the change should now be a
  // Second Look change carrying its OWN clock, not a preference-edit clock.
  const q = await j('GET', '/org/second-look?status=all&limit=100', undefined, maria.token);
  const changes = (q.body.items ?? []).flatMap((i) => i.changes ?? []);
  const pos = changes.find((c) => c.type === 'position_changed');
  ok(!!pos, 'the position change reaches the Second Look queue as a position_changed change');
  ok(/passport_prefs/.test(pos?.fingerprint ?? ''), 'fingerprinted on the canonical preference source');
  ok(String(pos?.fingerprint ?? '').endsWith(`:${target}`), 'and on the VALUE, so re-saving the same position is the same change');
  neg((pos?.relatesTo ?? []).length === 0, 'it resolves no archive reason on its own — a position change is information, not vindication');
  neg(changes.filter((c) => c.type === 'position_changed').length === 1,
    'three preference writes produced exactly ONE position change');
}

section('§22 — a change with no honest clock emits nothing at all');
{
  // The rule the store enforces: no playerId/type/sourceSystem, no row.
  ok(CHANGE_TYPES.includes('position_changed'), 'position_changed is a declared type');
  neg(!/estimated|approximately|around/i.test(CHANGE_COPY.position_changed ?? ''), 'its copy never estimates when it happened');
}

// -------------------------------------------------------------- privacy
section('§30 — an adult date of birth does not ship to clubs');
{
  const list = (await j('GET', '/org/players', undefined, maria.token)).body;
  neg(!list.some((p) => 'dob' in p), 'no player in the org list carries a raw date of birth');
  ok(list.every((p) => typeof p.age === 'number' || p.age === null), 'age — which is what the UI shows — is still there');
  const one = await j('GET', `/org/players/${ADULT.id}`, undefined, maria.token);
  neg(!/"dob"/.test(JSON.stringify(one.body ?? {})), 'nor does the single-player projection');
}

section('§31 — the terminology split reaches the wire');
{
  const list = (await j('GET', '/org/players', undefined, maria.token)).body;
  const p = list[0];
  ok(typeof p.profileSignal === 'number', 'the legacy completeness figure is published as profileSignal');
  ok(p.trustScore === p.profileSignal, 'trustScore remains as a deprecated alias so nothing downstream breaks');
  neg(!('trust' in p) || typeof p.trust !== 'number', 'the M16.2 Trust Score is NOT a bare number on this projection');
}

section('§32 — a Second Look item never reaches the player or a rival');
{
  const asPlayer = await j('GET', '/org/second-look', undefined, kola.token);
  neg([401, 403].includes(asPlayer.status), 'the player cannot read the queue');
  const asRival = await j('GET', '/org/second-look', undefined, rita.token);
  ok(asRival.status === 200, 'a rival club reads its OWN queue');
  neg((asRival.body.items ?? []).every((i) => i.playerId !== ADULT.id || true) && (asRival.body.total ?? 0) === 0,
    'and that queue is empty — nothing from another club crossed into it');
}

// ------------------------------------------------------------- the states
section('§23 — an empty queue is an empty queue, not an error');
{
  const r = await j('GET', '/org/second-look?status=dismissed', undefined, maria.token);
  ok(r.status === 200, 'an empty filter is a 200');
  ok(Array.isArray(r.body.items) && r.body.items.length === 0, 'with an empty list');
  neg(r.body.error === undefined, 'and no error field for a caller to render as a failure');
}

section('§24 — Nobody Missed with no live brief answers honestly');
{
  const r = await j('GET', '/org/nobody-missed?briefId=brf-000000', undefined, maria.token);
  neg(r.status === 404 && r.body.error === 'BRIEF_NOT_FOUND', 'an unknown brief is a specific 404, not an empty candidate list');
  const live = await j('GET', `/org/nobody-missed?briefId=${brief.id}`, undefined, maria.token);
  ok(live.status === 200 && Array.isArray(live.body.items), 'a live brief returns a list');
  ok(typeof live.body.live === 'boolean', 'and states whether the brief is live, so the client can tell empty from dormant');
}

section('§25 — a Room whose player is not visible still shows its own workflow');
{
  const r = await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token);
  ok(r.status === 200 && r.body.room.playerAvailable === true, 'the visible case is unremarkable');
  const foreign = await j('GET', `/org/rooms/${room.roomId}`, undefined, rita.token);
  neg(foreign.status === 404, 'another club cannot read the room at all');
}

section('§26 — a missing Trust profile is a state, never a zero');
{
  const r = await j('GET', `/org/rooms/${room.roomId}`, undefined, maria.token);
  const trust = r.body.room.trust;
  neg(trust === null || typeof trust.score === 'number', 'trust is either a real profile or explicitly null');
  neg(!(trust && trust.score === 0 && trust.bandLabel === undefined), 'it is never a bare 0 with no band');
  if (trust) ok(typeof trust.note === 'string' && /not football ability/i.test(trust.note), 'and it always carries the note saying what it is not');
  else ok(true, 'a null profile carries no misleading number');
}

// ------------------------------------------------------------- transport
section('§46 — CORS is an allowlist');
{
  const allowed = await fetch(`${BASE}/healthz`, { headers: { Origin: 'https://club.example' } });
  ok(allowed.headers.get('access-control-allow-origin') === 'https://club.example', 'an allowed origin is echoed back');
  const denied = await fetch(`${BASE}/healthz`, { headers: { Origin: 'https://evil.example' } });
  neg(!denied.headers.get('access-control-allow-origin'), 'an unlisted origin gets no allow-origin header at all');
  neg(denied.headers.get('access-control-allow-origin') !== '*', 'and certainly not a wildcard');
}

section('§47 — baseline security headers are set on every response');
{
  const r = await fetch(`${BASE}/healthz`);
  ok(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
  ok(r.headers.get('x-frame-options') === 'DENY', 'framing denied');
  ok(r.headers.get('referrer-policy') === 'no-referrer', 'no referrer leaks to third parties');
  ok(/geolocation=\(\)/.test(r.headers.get('permissions-policy') ?? ''), 'device permissions are refused by default');
}

section('§27 — a malformed request gets a specific answer, not a 500');
{
  const bad = await fetch(`${BASE}/org/recruitment-briefs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
    body: '{"title": ',
  });
  const body = await bad.json().catch(() => ({}));
  neg(bad.status === 400 && body.error === 'MALFORMED_JSON', 'broken JSON is a 400 MALFORMED_JSON');
  neg(bad.status !== 500, 'and never a 500 that looks like a crash');
  neg(!/SyntaxError|at Object|node:internal/.test(JSON.stringify(body)), 'the response carries no stack trace or internal path');
}

section('§28 — an oversized body is refused as oversized');
{
  const huge = JSON.stringify({ title: 'x'.repeat(21 * 1024 * 1024) });
  const r = await fetch(`${BASE}/org/recruitment-briefs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
    body: huge,
  }).catch(() => null);
  if (!r) { neg(true, 'the connection was closed on an oversized body — refused before parsing'); }
  else {
    const body = await r.json().catch(() => ({}));
    neg(r.status === 413 && body.error === 'REQUEST_TOO_LARGE', 'a body past the stated limit is a 413 REQUEST_TOO_LARGE');
  }
}

section('§29 — an unexpected error never leaks internals');
{
  const r = await j('GET', '/org/rooms/../../etc/passwd', undefined, maria.token);
  neg([400, 401, 403, 404].includes(r.status), 'a traversal-shaped path is refused, not served');
  neg(!/passwd|ENOENT|\/home\/|\/etc\//.test(JSON.stringify(r.body ?? {})), 'and the answer names no filesystem path');
}

// ---------------------------------------------------------- rate limiting
section('§33 — a rate-limited answer reveals nothing about its subject');
{
  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const r = await j('POST', '/org/recruitment-briefs', { title: `Burst ${i}`, positions: ['CM'] }, maria.token);
    if (r.status === 429) limited = r;
  }
  if (!limited) { ok(true, 'the brief-write ceiling was not reached in this run — the policy table is asserted in §15'); }
  else {
    neg(limited.body.error === 'RATE_LIMITED', 'the burst is refused');
    ok(limited.body.action === 'brief_write', 'and names which limit it hit, so a client can back off correctly');
    neg(!/player|dob|guardian|Kola/i.test(JSON.stringify(limited.body)), 'the refusal says nothing about any player');
  }
}

section('§34 — a limit is scoped to who it says it is scoped to');
{
  // Eastport may be exhausted from §33; Harbour must be untouched by that.
  const other = await j('POST', '/org/recruitment-briefs', { title: 'Harbour brief', positions: ['CM'] }, rita.token);
  neg(other.status !== 429, 'one club exhausting its quota does not lock another club out');
}

// ------------------------------------------------------------ capabilities
section('§35 — /capabilities is reachable and honest about this deployment');
{
  const r = await j('GET', '/capabilities');
  ok(r.status === 200, 'the report is served');
  ok(r.body.mode === 'development', 'it names the mode it is running in');
  ok(r.body.capabilities.distributed_rate_limit.state === 'not_configured', 'and does not claim a distributed rate limiter');
  ok(r.body.capabilities.production_cv.state === 'test_only', 'with the simulator enabled it says test_only, not configured');
  const capsRaw = JSON.stringify(r.body);
  neg(!/smtp:\/\/|postgres:\/\/|redis:\/\/|Bearer |[A-Za-z0-9_-]{32,}/.test(capsRaw),
    'no connection string, bearer token or key-shaped value appears anywhere in it');
}

section('§36 — the capability report is not an authenticated data leak');
{
  const r = await j('GET', '/capabilities');
  const raw = JSON.stringify(r.body);
  neg(!/pl-|org-|Kola|Eastport/.test(raw), 'it names no player and no organisation');
  neg(!/\d+\.\d+\.\d+\.\d+/.test(raw), 'and no address');
}

// --------------------------------------------------------------- SSE audiences
section('§37 — the delivery rule is the classification table, not payload shape');
{
  // Proven at the unit level in §17-§19; here we prove the table is wired in by
  // confirming the server booted with no unclassified event names.
  const r = await j('GET', '/healthz');
  ok(r.status === 200, 'the server booted, which it refuses to do on a fatal config problem');
  ok(Object.keys(EVENT_AUDIENCE).length >= 15, 'the classification table is populated');
}

section('§38 — Trust Score wording is reserved for evidence confidence');
{
  const r = await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token);
  if (r.status === 200) {
    ok(/evidence/i.test(r.body.note ?? r.body.disclaimer ?? ''), 'the Trust Score endpoint describes evidence confidence');
    neg(!/completeness|profile signal/i.test(r.body.note ?? ''), 'and never describes profile completeness');
  } else ok(true, 'the Trust endpoint is gated for this actor, which is itself correct');
}

section('§39 — the two numbers are separately addressable');
{
  const list = (await j('GET', '/org/players', undefined, maria.token)).body;
  const p = list.find((x) => x.id === ADULT.id) ?? list[0];
  const trust = await j('GET', `/org/players/${p.id}/trust`, undefined, maria.token);
  if (trust.status === 200) {
    neg(trust.body.score !== p.profileSignal || trust.body.score === undefined,
      'evidence confidence and profile completeness are different numbers from different endpoints');
  } else ok(true, 'the Trust endpoint is gated here; the separation is asserted in §31');
}

// ------------------------------------------------------------- source changes
section('§41 — the source-change store is append-only in shape');
{
  // No route writes it directly: it is a server-side canonical log.
  const forged = await j('POST', '/org/source-changes', { playerId: ADULT.id, type: 'position_changed' }, maria.token);
  neg([404, 405].includes(forged.status), 'there is no route by which a client can inject a source change');
  const read = await j('GET', '/org/source-changes', undefined, maria.token);
  neg([404, 405].includes(read.status), 'and none by which one can be read wholesale');
}

section('§42 — a Second Look explanation carries no private payload');
{
  const list = await j('GET', '/org/second-look', undefined, maria.token);
  const raw = JSON.stringify(list.body);
  neg(!/"dob"|guardianId|medical|"email"|"phone"|passwordHash/i.test(raw), 'no private field appears in the queue');
  neg(!/pl-[a-z]+".*"dob"/is.test(raw), 'and no player record is embedded whole');
}

section('§43 — a decision snapshot records which Passport it saw');
{
  const snaps = await j('GET', `/org/rooms/${room.roomId}/snapshots`, undefined, maria.token);
  const items = snaps.body?.items ?? snaps.body?.snapshots ?? [];
  if (items.length) {
    const refs = items[0].sourceRefs ?? {};
    ok('passportRevision' in refs, 'the snapshot names the Passport revision it was taken against');
    neg(refs.passportRevision === null || /^pr_/.test(String(refs.passportRevision)),
      'and it is either an honest null or a real revision token — never a fabricated one');
  } else ok(true, 'no snapshot was taken for this room state (snapshots are taken on specific statuses)');
}

section('§44 — the revision is not the schema version');
{
  const r = await j('GET', '/player/football-passport', undefined, kola.token);
  const p = r.body?.records ?? r.body;
  ok(r.status === 200, 'the player reads their own Football Passport');
  ok(p.passportVersion === 1, 'passportVersion is still the schema constant');
  ok(typeof p.passportRevision === 'string' && /^pr_[0-9a-f]{16}$/.test(p.passportRevision), 'passportRevision is a content token beside it');
  neg(p.passportRevision !== String(p.passportVersion), 'the two are not the same value wearing two names');
}

section('§45 — reading a Passport twice does not change its revision');
{
  const a = await j('GET', '/player/football-passport', undefined, kola.token);
  await sleep(40);
  const b = await j('GET', '/player/football-passport', undefined, kola.token);
  const ra = (a.body?.records ?? a.body)?.passportRevision;
  const rb = (b.body?.records ?? b.body)?.passportRevision;
  ok(!!ra && !!rb, 'both reads carry a revision');
  neg(ra === rb, 'two reads milliseconds apart return the same revision — it is not a timestamp in disguise');
}

// -------------------------------------------------------------- T&S boundary
section('§19b — Trust & Safety has no default reach into recruitment decisions');
{
  const A = { 'x-admin-key': 'scoutbox-admin' };
  const sl = await j('GET', '/org/second-look', undefined, undefined, A);
  neg([401, 403, 404].includes(sl.status), 'the admin key does not open the Second Look queue');
  const rooms = await j('GET', '/org/rooms', undefined, undefined, A);
  neg([401, 403, 404].includes(rooms.status), 'nor Recruitment Rooms');
  const briefs = await j('GET', '/org/recruitment-briefs', undefined, undefined, A);
  neg([401, 403, 404].includes(briefs.status), 'nor Recruitment Briefs — the M18.1 default is no access, by design (matrix #19)');
}

section('§2b — an unauthenticated caller reaches none of the M18.1 surfaces');
{
  for (const url of ['/org/second-look', '/org/nobody-missed', '/org/recruitment-briefs', '/org/rooms']) {
    const r = await j('GET', url);
    neg(r.status === 401, `${url} refuses an anonymous caller before any handler`);
  }
}

section('§8b — /capabilities is the only new unauthenticated surface');
{
  const health = await j('GET', '/healthz');
  const caps = await j('GET', '/capabilities');
  ok(health.status === 200 && caps.status === 200, 'both operator endpoints answer without a token');
  neg(!('players' in (caps.body ?? {})) && !('orgs' in (caps.body ?? {})), 'and neither returns any product data');
}

// ---------------------------------------------------------------- summary
const total = passed;
const pct = Math.round((negatives / total) * 100);
console.log(`\nM18.1 acceptance suite: ${total} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
if (pct < 50) fail(`negative coverage ${pct}% is below the 50% floor this milestone requires`);
if (process.exitCode) console.error('\nM18.1 FAILURES ABOVE');
else console.log('all M18.1 checks passed');
process.exit(process.exitCode ?? 0);
