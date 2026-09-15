// M23 acceptance suite — P2: the canonical lifecycle and the journey projection.
//
// The governing rule this suite exists to enforce:
//
//   The recruitment lifecycle must describe what has actually happened — not
//   what the UI wants to show, not what another subsystem happens to call it,
//   and never more than the underlying records can prove.
//
// P2 scope: one authoritative lifecycle, server-validated semantic actions,
// append-only history, viewer-aware projection, and — the part most worth
// testing — the things that must NOT happen. Contact, Trial and Offer arrive in
// later phases; this suite proves the lifecycle refuses to pretend they exist.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_ACTIONS, LIFECYCLE_TERMINAL, LIFECYCLE_REASON_CODES,
  RECRUITMENT_LIFECYCLE_POLICY_VERSION, canTransitionRecruitmentCase,
  derivedConditions, availableActions, toAnalyticsRecruitmentStage,
  NULL_EVIDENCE_PROVIDER,
} from '../m23/lifecycle.mjs';
import { buildRecruitmentJourney, JOURNEY_REQUIRED_STORES } from '../m23/journey.mjs';
import { ROOM_STATUSES, ROOM_TRANSITIONS, TERMINAL_ROOM_STATUSES } from '../m17/shared.mjs';
import { FUNNEL_STAGES } from '../m20/funnels.mjs';

const PORT = 5700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ pure engine
section('U1 — the lifecycle is one table, and the declined states stayed declined');
{
  neg(!ROOM_STATUSES.includes('trial_in_progress'),
    '#39 `trial_in_progress` is NOT a case stage — it is a state of the trial');
  neg(!ROOM_STATUSES.includes('decision_pending'),
    '#40 `decision_pending` is NOT a case stage — it is a derivation');

  const conds = derivedConditions({ status: 'trial_completed', hasCurrentDecision: false });
  ok(conds.decisionPending === true, 'decision-pending is answered by looking, not by storing');
  ok(derivedConditions({ status: 'trial_completed', hasCurrentDecision: true }).decisionPending === false,
    'and stops being true the moment a decision exists');

  ok(ROOM_STATUSES.includes('offer_accepted') && ROOM_STATUSES.includes('signed'),
    'offer_accepted and signed are different states');
  neg(!ROOM_TRANSITIONS.offer_accepted.includes('offer_made'),
    'an accepted offer cannot be un-accepted');
  ok(Object.keys(ROOM_TRANSITIONS).length === ROOM_STATUSES.length,
    'every status has a transition row — the table is total');
  for (const [from, tos] of Object.entries(ROOM_TRANSITIONS)) {
    for (const to of tos) {
      if (!ROOM_STATUSES.includes(to)) fail(`${from} -> ${to} names a status that does not exist`);
    }
  }
  ok(true, 'every transition target is a real status');

  neg(!TERMINAL_ROOM_STATUSES.includes('on_hold'), '#38 on_hold is NOT terminal');
  ok(LIFECYCLE_TERMINAL.length === TERMINAL_ROOM_STATUSES.length, 'M23 terminal set matches M17 exactly — one definition');
}

section('U2 — no lifecycle action is performable by a player, and evidence cannot be faked');
{
  const kase = { id: 'case-x', orgId: 'org-a', playerId: 'pl-a', room: { status: 'offer_made', rev: 1 } };

  // #23 — the single most important negative in the milestone.
  const toSigned = canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(toSigned.ok === false && toSigned.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#23 offer acceptance does not become signed: `signed` demands a confirmed joining record');
  neg(toSigned.requires === 'confirmed_join', 'and names the record it needs rather than guessing');

  // Even with the case sitting at offer_accepted, nothing promotes it.
  const accepted = { ...kase, room: { status: 'offer_accepted', rev: 1 } };
  const stillNot = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', { role: 'recruitment_admin' });
  neg(stillNot.ok === false,
    '#23b a case AT offer_accepted still cannot reach signed without separate confirmed truth');

  // A provider that lies is the only way through — which is the point: the
  // lifecycle asserts exactly what some record supports, no more.
  const liar = { check: () => ({ satisfied: true }) };
  const withEvidence = canTransitionRecruitmentCase(accepted, 'confirmSignedOutcome', { role: 'recruitment_admin', evidence: liar });
  ok(withEvidence.ok === true && withEvidence.to === 'signed',
    'J17 with confirmed joining evidence, offer_accepted -> signed is permitted');

  // #4 — role.
  neg(canTransitionRecruitmentCase(kase, 'sendOffer', { role: 'viewer' }).error === 'LIFECYCLE_NOT_PERMITTED',
    '#4 a viewer cannot move the lifecycle');
  neg(canTransitionRecruitmentCase(kase, 'confirmSignedOutcome', { role: 'room_lead', evidence: liar }).error === 'LIFECYCLE_NOT_PERMITTED',
    '#4b confirming a signing is admin-only, even with evidence');

  // #6 — impossible jump.
  const watching = { ...kase, room: { status: 'watching', rev: 1 } };
  neg(canTransitionRecruitmentCase(watching, 'recordOfferAccepted', { role: 'recruitment_admin', evidence: liar }).error === 'LIFECYCLE_TRANSITION_INVALID',
    '#6 a watched player cannot jump to an accepted offer');

  // #5 — no generic stage setter exists in the action vocabulary at all.
  neg(!Object.keys(LIFECYCLE_ACTIONS).some((a) => /^set|^patch|stage$/i.test(a)),
    '#5 there is no generic set-stage action to call');

  neg(canTransitionRecruitmentCase(kase, 'notAnAction', { role: 'recruitment_admin' }).error === 'LIFECYCLE_ACTION_UNKNOWN',
    'an unknown action is refused by name');
  neg(canTransitionRecruitmentCase({ id: 'c', room: { status: 'nonsense' } }, 'startReview', { role: 'room_lead' }).error === 'LIFECYCLE_STATE_UNKNOWN',
    'a case in an unrecognised state reports corruption, not a workflow answer');

  ok(LIFECYCLE_REASON_CODES.every((c) => typeof c === 'string' && /^[a-z_]+$/.test(c)),
    'every lifecycle reason is a structured code, never prose');

  const acts = availableActions(watching, { role: 'recruitment_admin' });
  neg(!acts.includes('confirmSignedOutcome'), '#42 an action the evidence cannot support is not suggested');
  ok(acts.includes('startReview') && acts.includes('planContact'), 'the possible actions are offered');
  neg(!availableActions(watching, { role: 'viewer' }).includes('startReview'),
    '#42b and nothing is suggested to a role that cannot do it');
}

section('U3 — the projector refuses to mistake a broken database for an empty history');
{
  const base = {
    recruitmentCases: [{ id: 'case-1', orgId: 'o1', playerId: 'p1', room: { status: 'watching', rev: 1 }, history: [] }],
    roomDecisions: [], requests: [], trials: [], assessments: [], signings: [],
  };
  const good = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  ok(good.ok === true, 'a healthy database projects');

  for (const store of JOURNEY_REQUIRED_STORES) {
    const broken = { ...base };
    delete broken[store];
    const out = buildRecruitmentJourney(broken, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
    neg(out.ok === false && out.error === 'JOURNEY_STORE_MISSING',
      `#30/#31 a missing db.${store} is reported as broken infrastructure, not as "nothing happened"`);
  }

  // #1/#2 — foreign org.
  const foreign = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'OTHER', role: 'room_lead' });
  neg(foreign.ok === false && foreign.error === 'CASE_NOT_FOUND',
    '#1/#2 a foreign org gets CASE_NOT_FOUND');
  const absent = buildRecruitmentJourney(base, 'case-nope', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  neg(JSON.stringify(foreign) === JSON.stringify(absent),
    'and it is byte-identical to a case that never existed — no count, no hint, no leak');

  // #13/#14/#35/#36 — hidden club interest.
  const asPlayer = buildRecruitmentJourney(base, 'case-1', { kind: 'player_self', playerId: 'p1' });
  neg(asPlayer.ok === false && asPlayer.error === 'CASE_NOT_FOUND',
    '#13 a player cannot see that a club has a case on them');
  neg(JSON.stringify(asPlayer) === JSON.stringify(absent),
    '#36 and the answer is identical to a case that does not exist — interest cannot be inferred');
  const asGuardian = buildRecruitmentJourney(base, 'case-1', { kind: 'guardian', guardianId: 'g1' });
  neg(asGuardian.ok === false && asGuardian.error === 'CASE_NOT_FOUND',
    '#14 nor can a guardian without a share');

  // #15 — agency is not a viewer context at all.
  neg(buildRecruitmentJourney(base, 'case-1', { kind: 'agency' }).error === 'JOURNEY_VIEWER_UNKNOWN',
    '#15 "agency" is not a recruitment-journey viewer — no policy grants it one');

  // #38-T&S — not a master key.
  neg(buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety' }).error === 'CASE_NOT_FOUND',
    'T&S with no authorization sees nothing');
  ok(buildRecruitmentJourney(base, 'case-1', { kind: 'trust_safety', authorized: true }).ok === true,
    'and sees the case only when its own authorization says so');

  // #30 — no score of any kind.
  const body = JSON.stringify(good);
  neg(!/score|readiness|probability|percentage|quality|rating/i.test(body),
    '#30 the journey carries no score, readiness, probability, percentage or rating');

  // §76 — determinism.
  const a = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' }, { now: 1000 });
  const b = buildRecruitmentJourney(base, 'case-1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' }, { now: 1000 });
  ok(JSON.stringify(a) === JSON.stringify(b), 'the projection is deterministic for the same db, viewer and clock');
}

section('U4 — private text never reaches the projection');
{
  const db = {
    recruitmentCases: [{ id: 'c1', orgId: 'o1', playerId: 'p1', room: { status: 'under_review', rev: 1 }, history: [] }],
    roomDecisions: [{ id: 'd1', roomId: 'c1', orgId: 'o1', recommendation: 'archive', reasonCodes: ['squad_space'], note: 'HIS ATTITUDE IS THE PROBLEM', createdAt: '2026-01-01T00:00:00.000Z', by: { name: 'Maria' } }],
    requests: [], trials: [], assessments: [], signings: [],
  };
  const out = buildRecruitmentJourney(db, 'c1', { kind: 'org_staff', orgId: 'o1', role: 'room_lead' });
  const s = JSON.stringify(out);
  neg(!s.includes('ATTITUDE'), '#42-note a decision note body is never projected, even to the club');
  ok(out.decisions.all[0].hasNote === true, 'its existence is reported; its content is not');
  ok(out.decisions.all[0].reasonCodes[0] === 'squad_space', 'the structured reason travels because it is structured');
}

section('U5 — analytics compatibility is explicit');
{
  ok(FUNNEL_STAGES.includes('contact_planned') && FUNNEL_STAGES.includes('contacted'),
    'J19 the two contact states ARE funnel progression');
  ok(FUNNEL_STAGES.includes('offer_accepted'), 'and an accepted offer is further than a made one');
  neg(!FUNNEL_STAGES.includes('on_hold'), '#34 pausing is not counted as progress');
  neg(!FUNNEL_STAGES.includes('offer_declined'), '#34b nor is declining, which already counted at offer_made');
  ok(toAnalyticsRecruitmentStage('on_hold') === null && toAnalyticsRecruitmentStage('offer_declined') === null,
    'the mapping says so in one place');
  ok(toAnalyticsRecruitmentStage('trial_completed') === 'trial_completed',
    'and every historical status still maps to itself — no rename, no silent invalidation');
  for (const s of ['watching', 'under_review', 'shortlisted', 'priority', 'trial_requested', 'trial_scheduled', 'trial_completed', 'offer_consideration', 'offer_made', 'signed']) {
    if (toAnalyticsRecruitmentStage(s) !== s) fail(`legacy status ${s} no longer maps to itself`);
  }
  ok(true, '#34c all ten pre-M23 funnel statuses are unchanged');
}

// ================================================================== HTTP
section('HTTP — booting a real server');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
{
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1' }, stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { const r = await fetch(`${BASE}/healthz`); up = r.ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const harbour = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, harbour, kola].every((x) => x?.token), 'HTTP actors logged in');

const players = (await j('GET', '/org/players', undefined, maria.token)).body;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name));
const created = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, maria.token);
const ROOM = created.body.room?.roomId;
ok(created.status === 201 && ROOM, 'J2 a case opens, and it starts at the canonical initial state');
ok(created.body.room.status === 'watching', 'J2b which is `watching`');

section('J — the positive journeys');
{
  // J1 — an existing M17 case projects.
  const j1 = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  ok(j1.status === 200 && j1.body.ok === true, 'J1 an M17-created case projects through the canonical journey');
  ok(j1.body.lifecycle.currentStage === 'watching', 'J1b with its real current stage');
  ok(j1.body.lifecycle.policyVersion === RECRUITMENT_LIFECYCLE_POLICY_VERSION, 'J1c and the policy version it was computed under');
  ok(Array.isArray(j1.body.nextActions) && j1.body.nextActions.includes('startReview'), 'J1d and deterministic next actions');
  neg(!j1.body.nextActions.includes('confirmSignedOutcome'), 'J1e which never include one the evidence cannot support');

  const rev0 = j1.body.case.rev;

  // J3/J4/J5 — move, history, rev.
  const mv = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: rev0 }, maria.token);
  ok(mv.status === 200 && mv.body.to === 'under_review', 'J3 an authorised lead moves the case to under_review');
  const j2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(j2.history.entries.some((e) => e.to === 'under_review'), 'J4 the transition is appended to history');
  ok(j2.case.rev === rev0 + 1, 'J5 the case rev incremented exactly once');

  // J6 — idempotency, bound to request identity.
  const key = 'ck-plan-1';
  const p1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'planContact', expectedRev: j2.case.rev, clientKey: key }, maria.token);
  ok(p1.status === 200 && p1.body.to === 'contact_planned', 'J6a planContact lands');
  const historyLen = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body.history.total;
  const p2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'planContact', expectedRev: 999, clientKey: key }, maria.token);
  ok(p2.status === 200 && p2.body.idempotent === true, 'J6b the same action with the same key replays without re-applying');
  const after = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(after.history.total === historyLen, '#29 and appends no duplicate history entry');

  // #8 — contact is not yet implemented, so `contacted` is refused for want of evidence.
  const noEvidence = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'recordContact', expectedRev: after.case.rev }, maria.token);
  neg(noEvidence.status === 422 && noEvidence.body.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#14-mandate a contact cannot be recorded before the Contact phase can prove one happened');

  // J7/J8 — hold, then resume. Hold is live, not an ending.
  const hold = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: after.case.rev }, maria.token);
  ok(hold.status === 200 && hold.body.to === 'on_hold', 'J7 the case can be put on hold');
  const held = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(held.lifecycle.terminal === false, 'J7b and a held case is NOT terminal');
  ok(held.conditions.onHold === true, 'J7c the derived condition reports the hold');
  const resume = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'resumeCase', expectedRev: held.case.rev }, maria.token);
  ok(resume.status === 200 && resume.body.to === 'under_review', 'J8 and it resumes into review');

  // J9/J11 — reject, preserving everything.
  const beforeReject = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const rej = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'rejectCase', expectedRev: beforeReject.case.rev, reasonCodes: ['squad_space'] }, maria.token);
  ok(rej.status === 200 && rej.body.to === 'archived', 'J9 the case can be rejected with a structured reason');
  const rejected = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(rejected.history.total >= beforeReject.history.total, '#28/#36 rejecting destroyed no prior history');
  ok(rejected.history.entries.some((e) => e.to === 'on_hold'), 'J11 including the hold that came before it');

  // #26 — archive is not rejection-by-another-name in the projection.
  neg(rejected.lifecycle.currentStage === 'archived' && !/rejected/i.test(JSON.stringify(rejected.lifecycle)),
    '#26 an archived room is reported as archived, never silently relabelled "rejected"');

  // J10 — reopen preserves terminal history.
  const reopen = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: rejected.case.rev }, maria.token);
  ok(reopen.status === 200 && reopen.body.to === 'under_review', 'J10 an authorised reopen works');
  const reopened = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(reopened.history.entries.some((e) => e.to === 'archived'), '#37 and the terminal history survives the reopen');
  ok(reopened.history.total > rejected.history.total, 'J10b the reopen is itself appended');

  // #24 — closed -> reopened -> closed is three real transitions, not one deduped pair.
  //
  // Note the hold before each close. `under_review -> closed` is NOT an edge,
  // in M17 or in M23: a case is put beyond active pursuit (held, withdrawn or
  // archived) before it is filed away. The first draft of this test assumed the
  // shortcut existed; the table refused, which is the table working.
  const h1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: reopened.case.rev }, maria.token);
  ok(h1.status === 200, 'a case is held before it can be filed away');
  const preC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c1 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: preC1.case.rev, reasonCodes: ['timing'], clientKey: 'close-a' }, maria.token);
  ok(c1.status === 200, 'a case closes');
  const afterC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const r2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: afterC1.case.rev }, maria.token);
  const midR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: midR2.case.rev }, maria.token);
  const afterR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: afterR2.case.rev, reasonCodes: ['timing'], clientKey: 'close-b' }, maria.token);
  ok(r2.status === 200 && c2.status === 200,
    '#24 closed -> reopened -> closed all land: idempotency binds to request identity, not to an all-time stage pair');
  const afterC2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(afterC2.history.total > afterR2.history.total, 'and the second close is recorded in its own right');
}

section('Negatives — isolation, authority, concurrency, privacy');
{
  const cur = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;

  // #1/#2/#3 — foreign org.
  const fRead = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, harbour.token);
  neg(fRead.status === 404, '#2 a foreign org reading the journey gets 404');
  const fMove = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: cur.case.rev }, harbour.token);
  neg(fMove.status === 404, '#3 and a foreign org transition is 404, not 403 — no existence leak');
  neg(!JSON.stringify(fMove.body).includes(ADULT.id), '#17 and the refusal names no player');

  // #5 — arbitrary stage patch.
  const patch = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { stage: 'signed', expectedRev: cur.case.rev }, maria.token);
  neg(patch.status === 400 && patch.body.error === 'LIFECYCLE_STAGE_NOT_SETTABLE',
    '#5/#25 a client naming a stage is refused by name, and told to name an action');
  const patch2 = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', status: 'signed', expectedRev: cur.case.rev }, maria.token);
  neg(patch2.status === 400, '#25b smuggling a status alongside a valid action is refused too');

  // #6 — invalid jump.
  const jump = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'recordOfferAccepted', expectedRev: cur.case.rev }, maria.token);
  neg(jump.status === 409 && jump.body.error === 'LIFECYCLE_TRANSITION_INVALID', '#6 an impossible jump is 409');
  neg(Array.isArray(jump.body.allowed), 'and the refusal says what IS allowed');

  // #7/#8 — rev.
  const reopenNow = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'reopenCase', expectedRev: cur.case.rev }, maria.token);
  ok(reopenNow.status === 200, 'a fresh rev works');
  const stale = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: cur.case.rev }, maria.token);
  neg(stale.status === 409 && stale.body.error === 'ROOM_VERSION_CONFLICT', '#7 a stale expectedRev is 409');
  // #18 — the conflict body carries names and times, never content.
  neg(!/note|comment|rationale|summary/i.test(JSON.stringify(stale.body)),
    '#18 and the conflict response leaks no private text');
  ok(stale.body.currentRev != null, 'it does tell the caller where to resync');

  // #9/#10 — idempotency key reuse with a DIFFERENT payload.
  const live = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const k = 'shared-key';
  const first = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: live.case.rev, clientKey: k }, maria.token);
  ok(first.status === 200 && first.body.to === 'on_hold', '#9 an action with a key lands');
  const different = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'closeCase', expectedRev: 999, clientKey: k, reasonCodes: ['timing'] }, maria.token);
  neg(different.body?.idempotent !== true,
    '#10 the SAME key with a DIFFERENT action is not treated as a replay — identity is key AND action');

  // #4 — unauthorised staff.
  const held2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const byScout = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'confirmSignedOutcome', expectedRev: held2.case.rev }, tom.token);
  neg(byScout.status === 403 || byScout.status === 409 || byScout.status === 422,
    '#4 a non-lead scout cannot confirm a signing');
  neg(byScout.status !== 200, 'and certainly does not succeed');

  // #13 — the player has no route into any of it.
  const playerTry = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, kola.token);
  neg(playerTry.status === 401 || playerTry.status === 403 || playerTry.status === 404,
    '#13 a player token cannot read an org recruitment journey at all');

  // #19/#20/#21/#22 — lifecycle changes nothing elsewhere.
  const trustBefore = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  const nowState = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'resumeCase', expectedRev: nowState.case.rev }, maria.token);
  const trustAfter = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  neg(JSON.stringify(trustBefore?.score ?? null) === JSON.stringify(trustAfter?.score ?? null),
    '#19 J18 a lifecycle transition does not move the Trust Score');

  const plans = (await j('GET', `/org/development/plans?playerId=${ADULT.id}`, undefined, maria.token)).body;
  neg(!Array.isArray(plans?.plans) || plans.plans.length === 0,
    '#20 no Development Plan was created by moving the lifecycle');

  const second = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  const items = second?.items ?? second?.open ?? [];
  neg(!items.some((i) => i.playerId === ADULT.id && i.kind === 'general_update'),
    '#22 a lifecycle transition alone raises no Second Look item');

  // #35 — Passport gains nothing.
  const passport = (await j('GET', `/org/players/${ADULT.id}/passport`, undefined, maria.token)).body;
  const pj = JSON.stringify(passport ?? {});
  neg(!/under_review|on_hold|offer_consideration|contact_planned|recruitment_case/i.test(pj),
    '#35 the Passport gains no hidden recruitment interest from the lifecycle');
}

section('Legacy compatibility — an old case still reads');
{
  // J12 — a case whose room predates M23, with no lifecycleAction on any entry
  // and a status from the original thirteen, must project without rewriting.
  const legacy = await j('POST', '/org/rooms', { playerId: players.find((p) => p.id !== ADULT.id)?.id, sourceContext: 'search' }, maria.token);
  if (legacy.status === 201) {
    const LID = legacy.body.room.roomId;
    const viaOldRoute = await j('POST', `/org/rooms/${LID}/status`, { status: 'under_review' }, maria.token);
    ok(viaOldRoute.status === 200, 'J12 the pre-M23 status route still works');
    const proj = await j('GET', `/org/rooms/${LID}/journey`, undefined, maria.token);
    ok(proj.status === 200 && proj.body.lifecycle.currentStage === 'under_review',
      '#27 J12b and the case it produced projects through the M23 journey unchanged');
    ok(proj.body.history.entries.some((e) => e.to === 'under_review'),
      'J12c its history, written by the old route, is read by the new projector');
  } else {
    ok(false, 'could not create the legacy fixture case');
  }
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nM23 acceptance suite (P2): ${total} checks passed, ${negatives} negative/security/edge checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ M23 P2 has failures.');
else console.log('all M23 P2 checks passed');
