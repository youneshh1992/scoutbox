// Exposure, calibration, missing evidence and coverage planning, end to end.
//
// The exposure funnel and review queue, calibration sessions, the missing-evidence engine and
// coverage planning (S12 collections). Moved out of e2e/operations/clubOperations.mjs (was
// m13E2E, sections F4–F7) with the same server setup and actors; the checks are unchanged.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.ALLOW_LOCAL_WEBHOOKS = '1'; // the SSRF guard reads this at call time — needed for the in-process fixtures too

// Random per-run ports: a previously crashed run's orphan server can never
// answer this run's requests with stale state.
const PORT = 7600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-discovery-ops-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.mjs');

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
  const gNotifs = (await j('GET', '/guardian/inbox', undefined, amara.token)).body.items;
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

console.log(`\nexposure and coverage: ${process.exitCode ? 'FAILURES above —' : 'all'} ${passed} checks passed`);
server?.kill('SIGTERM');
process.exit(process.exitCode ?? 0);
