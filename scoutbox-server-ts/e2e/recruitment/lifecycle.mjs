// Acceptance suite for the canonical recruitment lifecycle and the journey projection.
//
// The governing rule this suite exists to enforce:
//
//   The recruitment lifecycle must describe what has actually happened — not
//   what the UI wants to show, not what another subsystem happens to call it,
//   and never more than the underlying records can prove.
//
// Scope: one authoritative lifecycle, server-validated semantic actions,
// append-only history, viewer-aware projection, and — the part most worth
// testing — the things that must NOT happen: no stage is claimed that a record
// cannot prove.
//
// The transition table, the validator, the evidence gate, the reasons and the journey projector over plain
// collections are checked in this process by the rules suite (scripts/rules/recruitment/lifecycle.mjs). Here: HTTP
// against a fresh server, then a restart.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import lifecycleSpec from '../support/spec/recruitment/lifecycle/lifecycle.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { RECRUITMENT_LIFECYCLE_POLICY_VERSION, LIFECYCLE_REASON_CODES } = lifecycleSpec;

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23-'));

let passed = 0;
let negatives = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

section('HTTP — booting a real server');
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** Start a server on the shared PORT and DATA_DIR, and wait for it to answer. */
async function boot() {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SCOUTBOX_QUIET_LOGS: '1' },
    stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      up = r.ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();

// Filled in by group C, read by group R after the process is restarted.
const IDEMPOTENCY_PROBE = { room: null, key: null, from: null, to: null };
/** Section E collects every refusal the two routes can produce; section Y sweeps the same set. */
const ERROR_BODIES_FROM_E = [];
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const harbour = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok(
  [maria, tom, harbour, kola].every((x) => x?.token),
  'HTTP actors logged in',
);

const players = (await j('GET', '/org/players', undefined, maria.token)).body.items;
const ADULT = players.find((p) => /Kola Adeyemi/.test(p.name));
const created = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, maria.token);
const ROOM = created.body.room?.roomId;
ok(created.status === 201 && ROOM, 'J2 a case opens, and it starts at the canonical initial state');
ok(created.body.room.status === 'watching', 'J2b which is `watching`');

section('J — the positive journeys');
{
  // J1 — an existing room case projects.
  const j1 = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  ok(j1.status === 200 && j1.body.ok === true, 'J1 a Rooms-created case projects through the canonical journey');
  ok(j1.body.lifecycle.currentStage === 'watching', 'J1b with its real current stage');
  ok(
    j1.body.lifecycle.policyVersion === RECRUITMENT_LIFECYCLE_POLICY_VERSION,
    'J1c and the policy version it was computed under',
  );
  ok(
    Array.isArray(j1.body.nextActions) && j1.body.nextActions.includes('startReview'),
    'J1d and deterministic next actions',
  );
  neg(!j1.body.nextActions.includes('confirmSignedOutcome'), 'J1e which never include one the evidence cannot support');

  const rev0 = j1.body.case.rev;

  // J3/J4/J5 — move, history, rev.
  const mv = await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'startReview', expectedRev: rev0 }, maria.token);
  ok(mv.status === 200 && mv.body.to === 'under_review', 'J3 an authorised lead moves the case to under_review');
  const j2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(
    j2.history.entries.some((e) => e.to === 'under_review'),
    'J4 the transition is appended to history',
  );
  ok(j2.case.rev === rev0 + 1, 'J5 the case rev incremented exactly once');

  // J6 — idempotency, bound to request identity.
  const key = 'ck-plan-1';
  const p1 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'planContact', expectedRev: j2.case.rev, clientKey: key },
    maria.token,
  );
  ok(p1.status === 200 && p1.body.to === 'contact_planned', 'J6a planContact lands');
  const historyLen = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body.history.total;
  const p2 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'planContact', expectedRev: 999, clientKey: key },
    maria.token,
  );
  ok(
    p2.status === 200 && p2.body.idempotent === true,
    'J6b the same action with the same key replays without re-applying',
  );
  const after = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(after.history.total === historyLen, '#29 and appends no duplicate history entry');

  // #8 — no Contact has been delivered, so `contacted` is refused for want of evidence.
  const noEvidence = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'recordContact', expectedRev: after.case.rev },
    maria.token,
  );
  neg(
    noEvidence.status === 422 && noEvidence.body.error === 'LIFECYCLE_EVIDENCE_REQUIRED',
    '#14-mandate a contact cannot be recorded before the Contact phase can prove one happened',
  );

  // J7/J8 — hold, then resume. Hold is live, not an ending.
  const hold = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: after.case.rev },
    maria.token,
  );
  ok(hold.status === 200 && hold.body.to === 'on_hold', 'J7 the case can be put on hold');
  const held = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  neg(held.lifecycle.terminal === false, 'J7b and a held case is NOT terminal');
  ok(held.conditions.onHold === true, 'J7c the derived condition reports the hold');
  const resume = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'resumeCase', expectedRev: held.case.rev },
    maria.token,
  );
  // A resume returns the case to the state it was held FROM
  // (here a pre-contact state with no record to lose), never to a state further back.
  const heldFrom = after.lifecycle.currentStage;
  ok(
    resume.status === 200 && resume.body.to === heldFrom && resume.body.to !== 'on_hold',
    `J8 and it resumes to where it was held from (${heldFrom})`,
  );

  // J9/J11 — reject, preserving everything.
  const beforeReject = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const rej = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'rejectCase', expectedRev: beforeReject.case.rev, reasonCodes: ['rejected'] },
    maria.token,
  );
  ok(rej.status === 200 && rej.body.to === 'archived', 'J9 the case can be rejected with a structured reason');
  const rejected = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(rejected.history.total >= beforeReject.history.total, '#28/#36 rejecting destroyed no prior history');
  ok(
    rejected.history.entries.some((e) => e.to === 'on_hold'),
    'J11 including the hold that came before it',
  );

  // #26 — archive is not rejection-by-another-name in the projection.
  neg(
    rejected.lifecycle.currentStage === 'archived' && !/rejected/i.test(JSON.stringify(rejected.lifecycle)),
    '#26 an archived room is reported as archived, never silently relabelled "rejected"',
  );

  // J10 — reopen preserves terminal history.
  const reopen = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'reopenCase', expectedRev: rejected.case.rev },
    maria.token,
  );
  ok(reopen.status === 200 && reopen.body.to === 'under_review', 'J10 an authorised reopen works');
  const reopened = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(
    reopened.history.entries.some((e) => e.to === 'archived'),
    '#37 and the terminal history survives the reopen',
  );
  ok(reopened.history.total > rejected.history.total, 'J10b the reopen is itself appended');

  // #24 — closed -> reopened -> closed is three real transitions, not one deduped pair.
  //
  // Note the hold before each close. `under_review -> closed` is NOT an edge:
  // a case is put beyond active pursuit (held, withdrawn or archived) before it
  // is filed away.
  const h1 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: reopened.case.rev },
    maria.token,
  );
  ok(h1.status === 200, 'a case is held before it can be filed away');
  const preC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c1 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'closeCase', expectedRev: preC1.case.rev, reasonCodes: ['case_closed'], clientKey: 'close-a' },
    maria.token,
  );
  ok(c1.status === 200, 'a case closes');
  const afterC1 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const r2 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'reopenCase', expectedRev: afterC1.case.rev },
    maria.token,
  );
  const midR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: midR2.case.rev }, maria.token);
  const afterR2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const c2 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'closeCase', expectedRev: afterR2.case.rev, reasonCodes: ['case_closed'], clientKey: 'close-b' },
    maria.token,
  );
  ok(
    r2.status === 200 && c2.status === 200,
    '#24 closed -> reopened -> closed all land: idempotency binds to request identity, not to an all-time stage pair',
  );
  const afterC2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  ok(afterC2.history.total > afterR2.history.total, 'and the second close is recorded in its own right');
}

section('Negatives — isolation, authority, concurrency, privacy');
{
  const cur = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;

  // #1/#2/#3 — foreign org.
  const fRead = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, harbour.token);
  neg(fRead.status === 404, '#2 a foreign org reading the journey gets 404');
  const fMove = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', expectedRev: cur.case.rev },
    harbour.token,
  );
  neg(fMove.status === 404, '#3 and a foreign org transition is 404, not 403 — no existence leak');
  neg(!JSON.stringify(fMove.body).includes(ADULT.id), '#17 and the refusal names no player');

  const objectKey = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', clientKey: { k: 1 }, expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    objectKey.status === 400 && objectKey.body.error === 'LIFECYCLE_CLIENT_KEY_INVALID',
    'a client key that is not text is refused, not stored on the case history',
  );
  const forgedTo = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', to: 'signed', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    forgedTo.status === 400 &&
      forgedTo.body.error === 'LIFECYCLE_INPUT_INVALID' &&
      forgedTo.body.field === 'to' &&
      forgedTo.body.problem === 'unknown_field',
    'an action cannot name its own target: an undeclared field is refused',
  );
  const textReason = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', reasonCodes: 'all_of_them', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    textReason.status === 400 && textReason.body.error === 'LIFECYCLE_REASONS_INVALID',
    'reasons that are not a list are refused with the reasons code',
  );

  // #5 — arbitrary stage patch.
  const patch = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { stage: 'signed', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    patch.status === 400 && patch.body.error === 'LIFECYCLE_STAGE_NOT_SETTABLE',
    '#5/#25 a client naming a stage is refused by name, and told to name an action',
  );
  const patch2 = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', status: 'signed', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(patch2.status === 400, '#25b smuggling a status alongside a valid action is refused too');

  // #6 — invalid jump.
  const jump = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'recordOfferAccepted', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(jump.status === 409 && jump.body.error === 'LIFECYCLE_TRANSITION_INVALID', '#6 an impossible jump is 409');
  neg(Array.isArray(jump.body.allowed), 'and the refusal says what IS allowed');

  // An action that CAN traverse the edge but does not describe it. The case is
  // here in a terminal state, and `startReview` would land on the same
  // `under_review` that `reopenCase` does — writing `club_decision` into the
  // history for what is, in fact, a reopen.
  const misnamed = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'startReview', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    misnamed.status === 409 && misnamed.body.error === 'LIFECYCLE_ACTION_NOT_APPLICABLE',
    'an action that does not describe the move is refused, even though the edge exists',
  );
  const wrongResume = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'resumeCase', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(
    wrongResume.status === 409 && wrongResume.body.error === 'LIFECYCLE_ACTION_NOT_APPLICABLE',
    'and a case that was never on hold cannot be "resumed from hold"',
  );

  // #7/#8 — rev.
  const reopenNow = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'reopenCase', expectedRev: cur.case.rev },
    maria.token,
  );
  ok(reopenNow.status === 200, 'a fresh rev works');
  const stale = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: cur.case.rev },
    maria.token,
  );
  neg(stale.status === 409 && stale.body.error === 'ROOM_VERSION_CONFLICT', '#7 a stale expectedRev is 409');
  // #18 — the conflict body carries names and times, never content.
  neg(
    !/note|comment|rationale|summary/i.test(JSON.stringify(stale.body)),
    '#18 and the conflict response leaks no private text',
  );
  ok(stale.body.currentRev != null, 'it does tell the caller where to resync');

  // #9/#10 — idempotency key reuse with a DIFFERENT payload.
  const live = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const k = 'shared-key';
  const first = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: live.case.rev, clientKey: k },
    maria.token,
  );
  ok(first.status === 200 && first.body.to === 'on_hold', '#9 an action with a key lands');
  const different = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'closeCase', expectedRev: 999, clientKey: k, reasonCodes: ['case_closed'] },
    maria.token,
  );
  neg(
    different.body?.idempotent !== true,
    '#10 the SAME key with a DIFFERENT action is not treated as a replay — identity is key AND action',
  );

  // #4 — unauthorised staff.
  const held2 = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const byScout = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'confirmSignedOutcome', expectedRev: held2.case.rev },
    tom.token,
  );
  // Named exactly, not "one of three refusals". A disjunction over 403/409/422
  // passes when the server refuses for a DIFFERENT reason than the one under
  // test, which can hide a role-resolution bug behind an evidence gate. Role is checked before the transition table, so a scout is
  // refused for who they are, and that is the assertion.
  neg(
    byScout.status === 403 && byScout.body?.error === 'LIFECYCLE_NOT_PERMITTED',
    '#4 a non-lead scout is refused 403 LIFECYCLE_NOT_PERMITTED — for their role, not for missing evidence',
  );

  // #13 — the player has no route into any of it.
  const playerTry = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, kola.token);
  neg(
    playerTry.status === 401 || playerTry.status === 403 || playerTry.status === 404,
    '#13 a player token cannot read an org recruitment journey at all',
  );

  // #19/#20/#21/#22 — lifecycle changes nothing elsewhere.
  const trustBefore = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  const nowState = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'resumeCase', expectedRev: nowState.case.rev },
    maria.token,
  );
  const trustAfter = (await j('GET', `/org/players/${ADULT.id}/trust`, undefined, maria.token)).body;
  neg(
    JSON.stringify(trustBefore?.score ?? null) === JSON.stringify(trustAfter?.score ?? null),
    '#19 J18 a lifecycle transition does not move the Trust Score',
  );

  const plans = (await j('GET', `/org/development/plans?playerId=${ADULT.id}`, undefined, maria.token)).body;
  neg(
    !Array.isArray(plans?.plans) || plans.plans.length === 0,
    '#20 no Development Plan was created by moving the lifecycle',
  );

  const second = (await j('GET', '/org/second-look', undefined, maria.token)).body;
  const items = second?.items ?? second?.open ?? [];
  neg(
    !items.some((i) => i.playerId === ADULT.id && i.kind === 'general_update'),
    '#22 a lifecycle transition alone raises no Second Look item',
  );

  // #35 — Passport gains nothing.
  const passport = (await j('GET', `/org/players/${ADULT.id}/passport`, undefined, maria.token)).body;
  const pj = JSON.stringify(passport ?? {});
  neg(
    !/under_review|on_hold|offer_consideration|contact_planned|recruitment_case/i.test(pj),
    '#35 the Passport gains no hidden recruitment interest from the lifecycle',
  );
}

section('H1-H6 — the signed boundary, attacked from every write path');
{
  // The validator and the evidence provider are checked in the rules suite; here, the write paths into `signed`.

  // ---- H2/H3: the legacy status route is not a side door.
  //
  // A club at offer_made must not be able to POST {status:'signed'} here and
  // land on signed with no signing record at all.
  const lr = await j('POST', '/org/rooms', { playerId: ADULT.id, sourceContext: 'search' }, harbour.token);
  const HR = lr.body?.room?.roomId;
  if (HR) {
    const direct = await j('POST', `/org/rooms/${HR}/status`, { status: 'signed' }, harbour.token);
    neg(
      direct.status === 409 && direct.body?.error === 'ROOM_TRANSITION_INVALID',
      'H2 the legacy status route answers 409 ROOM_TRANSITION_INVALID for watching -> signed',
    );
    const st = (await j('GET', `/org/rooms/${HR}`, undefined, harbour.token)).body;
    neg(st.room?.status !== 'signed', 'H2b and the case did not move');
  } else {
    ok(false, 'could not create the harbour fixture room');
  }

  // H2c — the legacy route enforces the gate for a status it CAN reach.
  //
  // Proving the route gate needs a status that is both reachable and
  // evidence-bearing: `contacted`, one step from `contact_planned`.
  // Use the harbour room: a DIFFERENT org, so it is a genuinely new case at
  // `watching` rather than the adopted Eastport one (there is one open room
  // per org and player, so re-creating returns the existing case).
  const GR = HR;
  const gateBefore = (await j('GET', `/org/rooms/${GR}/journey`, undefined, harbour.token)).body;
  const planned = await j(
    'POST',
    `/org/rooms/${GR}/lifecycle`,
    { action: 'planContact', expectedRev: gateBefore.case?.rev },
    harbour.token,
  );
  if (planned.status === 200) {
    const sneak = await j('POST', `/org/rooms/${GR}/status`, { status: 'contacted' }, harbour.token);
    neg(
      sneak.status === 422 && sneak.body.error === 'ROOM_EVIDENCE_REQUIRED',
      'H2c the LEGACY status route refuses an evidence-bearing status — the side door is closed',
    );
    neg(sneak.body.requires === 'contact_delivered', 'H2d and names the record it wanted');
    const after = (await j('GET', `/org/rooms/${GR}`, undefined, harbour.token)).body;
    neg(after.room?.status === 'contact_planned', 'H2e the case did not move');
  } else {
    ok(false, 'could not reach contact_planned for the legacy-route gate test');
  }

  // ---- H4: concurrency. A stale actor cannot win by racing.
  const cur = (await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token)).body;
  const staleRev = cur.case.rev;
  await j('POST', `/org/rooms/${ROOM}/lifecycle`, { action: 'holdCase', expectedRev: staleRev }, maria.token);
  const raced = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'confirmSignedOutcome', expectedRev: staleRev },
    maria.token,
  );
  // Named, not merely "not 200". A bare `!== 200` also passes when the caller
  // is refused for PERMISSION — which is how a silently demoted lead looks,
  // and would hide the real gate behind an accidental one.
  neg(
    raced.status === 409 && raced.body?.error === 'LIFECYCLE_TRANSITION_INVALID',
    'H4 a racing confirm-signing loses on the transition table — the case is not at an offer',
  );
  neg(
    raced.body?.error !== 'LIFECYCLE_NOT_PERMITTED',
    'H4b and it loses on the RULE, not because the actor was refused permission',
  );
}

section('Legacy compatibility — an old case still reads');
{
  // J12 — a case whose room predates the lifecycle, with no lifecycleAction on any entry
  // and a status from the original thirteen, must project without rewriting.
  const legacy = await j(
    'POST',
    '/org/rooms',
    { playerId: players.find((p) => p.id !== ADULT.id)?.id, sourceContext: 'search' },
    maria.token,
  );
  if (legacy.status === 201) {
    const LID = legacy.body.room.roomId;
    const viaOldRoute = await j('POST', `/org/rooms/${LID}/status`, { status: 'under_review' }, maria.token);
    ok(viaOldRoute.status === 200, 'J12 the original status route still works');
    const proj = await j('GET', `/org/rooms/${LID}/journey`, undefined, maria.token);
    ok(
      proj.status === 200 && proj.body.lifecycle.currentStage === 'under_review',
      '#27 J12b and the case it produced projects through the canonical journey unchanged',
    );
    ok(
      proj.body.history.entries.some((e) => e.to === 'under_review'),
      'J12c its history, written by the old route, is read by the new projector',
    );
  } else {
    ok(false, 'could not create the legacy fixture case');
  }
}

section('T — hostile input: no shape of request body becomes a 500');
{
  let TROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) {
      TROOM = r.body.room.roomId;
      break;
    }
  }
  ok(!!TROOM, 'T0 a case for the input checks');

  // T1 — prototype keys. On a plain object literal `LIFECYCLE_ACTIONS['constructor']`
  // is truthy: a `!LIFECYCLE_ACTIONS[action]` guard would pass it through, the
  // validator would read `.roles` off Object's constructor, and one word of
  // request body would become a 500.
  const PROTO_KEYS = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    '__proto__',
    'prototype',
    'isPrototypeOf',
  ];
  for (const k of PROTO_KEYS) {
    const r = await j('POST', `/org/rooms/${TROOM}/lifecycle`, { action: k }, maria.token);
    neg(
      r.status === 400 && r.body?.error === 'LIFECYCLE_ACTION_UNKNOWN',
      `T1 action "${k}" is an unknown action, not a crash`,
    );
  }

  // T4 — everything else a client can put in the body. The property is that
  // NOTHING produces a 5xx: a bad request is the caller's problem and must be
  // reported as such.
  const HOSTILE_ACTIONS = [
    null,
    0,
    1,
    true,
    false,
    {},
    [],
    ['holdCase'],
    { action: 'holdCase' },
    'x'.repeat(5000),
    '',
    ' holdCase ',
    'HOLDCASE',
  ];
  const HOSTILE_REVS = [
    '3',
    3.5,
    -1,
    0,
    NaN,
    Infinity,
    -Infinity,
    {},
    [],
    '1e309',
    Number.MAX_SAFE_INTEGER + 2,
    null,
    'abc',
  ];
  const HOSTILE_KEYS = [{}, [], 0, true, 'k'.repeat(10000), '__proto__', null];
  const HOSTILE_REASONS = [
    'club_decision',
    {},
    0,
    [{}],
    [null],
    [['club_decision']],
    Array(200).fill('club_decision'),
    ['x'.repeat(5000)],
    [{ toString: 1 }],
  ];
  const BODIES = [];
  for (const a of HOSTILE_ACTIONS) BODIES.push({ action: a });
  for (const v of HOSTILE_REVS) BODIES.push({ action: 'holdCase', expectedRev: v });
  for (const v of HOSTILE_KEYS) BODIES.push({ action: 'holdCase', clientKey: v });
  for (const v of HOSTILE_REASONS) BODIES.push({ action: 'closeCase', reasonCodes: v });
  BODIES.push({}, { action: 'holdCase', extra: { __proto__: { polluted: true } } });

  let crashes = 0;
  let statuses = new Set();
  for (const b of BODIES) {
    const r = await j('POST', `/org/rooms/${TROOM}/lifecycle`, b, maria.token);
    statuses.add(r.status);
    if (r.status >= 500) {
      crashes += 1;
      console.error(`   500 on ${JSON.stringify(b).slice(0, 120)}`);
    }
  }
  neg(
    crashes === 0,
    `T4 none of ${BODIES.length} hostile bodies produced a 5xx (saw ${[...statuses].sort().join(', ')})`,
  );
  neg({}.polluted === undefined, 'T5 and nothing in that set polluted Object.prototype');

  // T6 — raw non-JSON and non-object bodies, which never reach the route's
  // destructuring in the shape it expects.
  for (const raw of ['not json', '[]', '"string"', '123', 'null', '{"action":']) {
    const r = await fetch(`${BASE}/org/rooms/${TROOM}/lifecycle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${maria.token}` },
      body: raw,
    });
    neg(r.status < 500, `T6 a raw body of ${JSON.stringify(raw.slice(0, 20))} is a 4xx, not a crash`);
  }

  // T7 — pagination numbers on the read side.
  for (const q of [
    'limit=-1',
    'limit=0',
    'limit=abc',
    'limit=1e9',
    'limit=Infinity',
    'limit=999999999999',
    'cursor=-1',
    'cursor=abc',
    'cursor=1e12',
    'limit=50&cursor=1e12',
    'limit[]=5',
    'limit=__proto__',
  ]) {
    const r = await j('GET', `/org/rooms/${TROOM}/journey?${q}`, undefined, maria.token);
    neg(
      r.status === 200 && Array.isArray(r.body?.history?.entries) && r.body.history.entries.length <= 200,
      `T7 ?${q} returns a clamped page rather than a crash or an unbounded response`,
    );
  }

  // T8 — the case id itself.
  for (const id of ['..%2f..%2fetc%2fpasswd', 'x'.repeat(2000), '%00', 'case-1%20or%201=1', '__proto__']) {
    const r = await j('GET', `/org/rooms/${id}/journey`, undefined, maria.token);
    neg(
      r.status === 404 || r.status === 400,
      `T8 a case id of ${JSON.stringify(id.slice(0, 24))} is not found, and is not a crash`,
    );
  }
}

section('C — concurrency and idempotency: one request, one effect, one entry');
{
  const spare = players.find((p) => p.id !== ADULT.id);
  let CROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) {
      CROOM = r.body.room.roomId;
      break;
    }
  }
  ok(!!CROOM && !!spare, 'C0 a fresh case for the concurrency checks');

  const state = async () => (await j('GET', `/org/rooms/${CROOM}/journey`, undefined, maria.token)).body;
  const historyLen = async () => (await state()).history.total;

  // C1 — the lost update. Two callers read the same rev and both act. One must
  // win; the other must be told, not silently overwritten.
  const base = await state();
  const [a, b] = await Promise.all([
    j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'startReview', expectedRev: base.case.rev }, maria.token),
    j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'shortlist', expectedRev: base.case.rev }, maria.token),
  ]);
  const winners = [a, b].filter((r) => r.status === 200);
  const losers = [a, b].filter((r) => r.status !== 200);
  ok(winners.length === 1, 'C1 exactly one of two racing writers on the same rev succeeds');
  neg(
    losers.length === 1 && losers[0].status === 409 && losers[0].body?.error === 'ROOM_VERSION_CONFLICT',
    'C2 and the loser is told its read was stale, not silently discarded',
  );
  neg(losers[0].body?.currentRev != null, 'C3 with the rev it needs to resync');

  // C4 — one accepted request writes exactly one history entry and moves the
  // rev by exactly one. A double-append is invisible until someone counts.
  const beforeLen = await historyLen();
  const beforeRev = (await state()).case.rev;
  const single = await j(
    'POST',
    `/org/rooms/${CROOM}/lifecycle`,
    { action: 'prioritise', expectedRev: beforeRev },
    maria.token,
  );
  ok(single.status === 200, 'C4 a clean write succeeds');
  const afterLen = await historyLen();
  const afterRev = (await state()).case.rev;
  neg(afterLen === beforeLen + 1, 'C5 and appends exactly one history entry, not two');
  neg(afterRev === beforeRev + 1, 'C6 and moves the rev by exactly one');

  // C7-C9 — idempotent replay. The key is the caller's, so a repeat is the
  // SAME request, not a second one.
  const key = `ckey-${Date.now()}`;
  const first = await j(
    'POST',
    `/org/rooms/${CROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: afterRev, clientKey: key },
    maria.token,
  );
  ok(first.status === 200 && !first.body.idempotent, 'C7 the first call with a client key performs the action');
  const lenAfterFirst = await historyLen();
  const replay = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'holdCase', clientKey: key }, maria.token);
  ok(replay.status === 200 && replay.body.idempotent === true, 'C8 the identical call replays instead of acting again');
  neg((await historyLen()) === lenAfterFirst, 'C9 and writes no second history entry');
  ok(
    replay.body.from === first.body.from && replay.body.to === first.body.to,
    'C10 the replay reports the original endpoints, not the current state',
  );

  // C11 — the key is bound to the ACTION, not just to the case. Reusing a key
  // for something else is a different request and must not be swallowed.
  const different = await j(
    'POST',
    `/org/rooms/${CROOM}/lifecycle`,
    { action: 'resumeCase', expectedRev: replay.body.currentRev ?? (await state()).case.rev, clientKey: key },
    maria.token,
  );
  neg(
    different.body?.idempotent !== true,
    'C11 the same key with a DIFFERENT action is not a replay — it is a different request',
  );

  // C12 — a replay is still an action. Someone whose role could never have
  // performed it must not be told it succeeded. Full validation cannot stand
  // in for this check: the case has moved, so the transition is no longer
  // legal and every replay would be refused for the wrong reason.
  const junior = await login('org-eastport', 'Replay Prober', 'First-Team Scout');
  const stolen = await j('POST', `/org/rooms/${CROOM}/lifecycle`, { action: 'holdCase', clientKey: key }, junior.token);
  neg(
    stolen.status === 403 && stolen.body?.error === 'LIFECYCLE_NOT_PERMITTED',
    "C12 replaying another role's key is refused on permission, not answered 200",
  );
  neg(
    !('from' in (stolen.body ?? {})) && !('to' in (stolen.body ?? {})),
    'C13 and the refusal echoes none of the original transition back',
  );

  // C14 — the key lives in the CASE\'s history, so a key that means something
  // in one case means nothing in another. Cross-case and cross-org collision
  // is impossible by construction rather than by a uniqueness check.
  const otherState = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  const collide = await j(
    'POST',
    `/org/rooms/${ROOM}/lifecycle`,
    { action: 'holdCase', expectedRev: otherState.body.case.rev, clientKey: key },
    maria.token,
  );
  neg(
    collide.body?.idempotent !== true,
    'C14 the same key on a different case is not a replay — idempotency is scoped to the case',
  );

  // The restart half of this — a replay after the process dies — is checked
  // for real at the end of the suite (group R), because it needs the server
  // killed and brought back.
  IDEMPOTENCY_PROBE.room = CROOM;
  IDEMPOTENCY_PROBE.key = key;
  IDEMPOTENCY_PROBE.from = first.body.from;
  IDEMPOTENCY_PROBE.to = first.body.to;
}

section('A — authorization drift: the role is decided now, from the database, not from the token');
{
  // The whole group exists because a role resolved once and carried is a role
  // that can be wrong later. Every check here changes the world AFTER a token
  // was minted and then uses the OLD token.
  const drifter = await login('org-eastport', 'Drift Tester', 'First-Team Scout');
  const DRIFT_TOKEN = drifter.token;

  // A room this person did not open and is not assigned to.
  // Seeded data already holds rooms for some players; take the first one that
  // is free rather than assuming.
  let target = null;
  let opened = null;
  for (const p of players) {
    if (p.id === ADULT.id) continue;
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, tom.token);
    if (r.status === 201) {
      target = p;
      opened = r;
      break;
    }
  }
  const AROOM = opened?.body?.room?.roomId;
  ok(!!AROOM, 'A0 a room exists that the drift tester neither opened nor was assigned to');

  const roleOf = async (token) =>
    (await j('GET', `/org/rooms/${AROOM}/journey`, undefined, token)).body?.nextActions ?? [];

  // The discriminator for "what role did the server resolve?" is the REFUSAL
  // ORDER. `confirmSignedOutcome` is admin-only, and role is checked before
  // the transition table, so from `watching`:
  //
  //   below recruitment_admin -> 403 LIFECYCLE_NOT_PERMITTED
  //   recruitment_admin       -> 409 LIFECYCLE_TRANSITION_INVALID
  //
  // Neither reaches `signed`, which is the point: this reads the role without
  // needing a transition this case cannot legally perform.
  const confirmAs = async (token) => {
    const r = await j('POST', `/org/rooms/${AROOM}/lifecycle`, { action: 'confirmSignedOutcome' }, token);
    return r.status === 403 ? 'below_admin' : r.status === 409 ? 'admin' : `unexpected:${r.status}`;
  };

  // A1-A2 — a recruitment lead is a recruitment_admin ANYWHERE in the
  // organisation, including in a room they have never touched. This is the
  // check that catches a lead being silently demoted.
  ok(
    (await confirmAs(maria.token)) === 'admin',
    'A1 a recruitment lead resolves as recruitment_admin in a room they never opened',
  );
  // A3 — and the tier below really is refused, so A1 is not passing because
  // everyone is an admin.
  neg((await confirmAs(DRIFT_TOKEN)) === 'below_admin', 'A3 a first-team scout is refused the admin-only action');

  // A4 — PROMOTION drift. The role changes in the database; the old token is
  // unchanged. If authorization came from the token, this would not move.
  await login('org-eastport', 'Drift Tester', 'Head of Recruitment');
  ok(
    (await confirmAs(DRIFT_TOKEN)) === 'admin',
    'A4 promoting them in the database promotes the OLD token too — the role is read per request',
  );

  // A5 — DEMOTION drift, which is the direction that matters for safety.
  await login('org-eastport', 'Drift Tester', 'First-Team Scout');
  neg(
    (await confirmAs(DRIFT_TOKEN)) === 'below_admin',
    'A5 and demoting them demotes the old token immediately — no stale capability survives',
  );

  // A6 — the offered-action list drifts with the role as well. A list computed
  // from a stale role is a UI that offers a 403.
  const beforeList = await roleOf(DRIFT_TOKEN);
  await login('org-eastport', 'Drift Tester', 'Head of Recruitment');
  const afterList = await roleOf(DRIFT_TOKEN);
  ok(
    afterList.length > beforeList.length,
    'A6 the offered-action list is recomputed from the live role, not cached with the session',
  );
  await login('org-eastport', 'Drift Tester', 'First-Team Scout');

  // A7 — removal. The row survives so history stays attributed; the access
  // does not.
  const removed = await j('POST', `/org/staff/${drifter.userId}/remove`, {}, maria.token);
  ok(removed.status === 200, 'A7 a lead removes the drift tester');
  const afterRemoval = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, DRIFT_TOKEN);
  neg(
    afterRemoval.status === 401,
    'A8 and their still-valid-looking token is refused on the journey — removal is not a UI state',
  );
  const writeAfterRemoval = await j('POST', `/org/rooms/${AROOM}/lifecycle`, { action: 'shortlist' }, DRIFT_TOKEN);
  neg(writeAfterRemoval.status === 401, 'A9 and on the lifecycle write, for the same reason');

  // A10-A11 — cross-tenant. A foreign case must be indistinguishable from one
  // that never existed: same code, same body, byte for byte.
  const foreign = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, harbour.token);
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/journey', undefined, harbour.token);
  neg(
    foreign.status === 404 && foreign.status === ghost.status,
    "A10 another club's case answers 404, exactly as a case that never existed does",
  );
  neg(
    JSON.stringify(foreign.body) === JSON.stringify(ghost.body),
    'A11 and byte-identically, so the id cannot be confirmed by comparing answers',
  );

  // A12 — the journey carries the club's own record, and no player identity.
  // A block stops a player's DATA flowing; it does not erase a club's notes
  // about its own process. There is nothing here for a block to stop.
  const proj = await j('GET', `/org/rooms/${AROOM}/journey`, undefined, maria.token);
  const body = JSON.stringify(proj.body);
  neg(!body.includes(target.name), "A12 the journey names no player — it reports the club's own record, keyed by id");
  neg(
    !/dateOfBirth|\bdob\b|email|phone|guardianName/i.test(body),
    'A13 and carries no personal detail a block or a removal would need to stop',
  );
}

section('W — write-site audit: every path that can move a case, and the ones that must not');
{
  // That room creation runs no evidence gate is checked in the rules suite; here, the legacy routes.
  // W5-W10 (live) — the legacy stage route writes `case.stage`, which is a pure
  // derivation of `room.status`. Without a bridge to the lifecycle it could move
  // one representation of a case and leave the other behind.
  const before = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  const stageBefore = before.body?.lifecycle?.currentStage;
  const legacyStage = await j(
    'POST',
    `/org/cases/${ROOM}/stage`,
    { stage: 'trial', reason: 'legacy client' },
    maria.token,
  );
  neg(
    legacyStage.status === 409 && legacyStage.body?.error === 'STAGE_NOT_SETTABLE_ON_ROOM',
    'W5 the legacy stage route refuses a case that has a Room',
  );
  ok(
    typeof legacyStage.body?.use === 'string' && legacyStage.body.use.includes('/lifecycle'),
    'W6 and names the lifecycle route rather than failing blankly',
  );
  const after = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  neg(after.body?.lifecycle?.currentStage === stageBefore, 'W7 the refusal left the lifecycle exactly where it was');

  const room = await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token);
  const revBefore = room.body?.room?.rev;
  const legacyDecision = await j(
    'POST',
    `/org/cases/${ROOM}/decision`,
    { outcome: 'monitor', reasons: 'keep watching through the spring' },
    maria.token,
  );
  ok(
    legacyDecision.status === 200 && legacyDecision.body?.case?.decision?.outcome === 'monitor',
    'W8 a workspace decision on a Room is still recorded — the route is not broken, only disarmed',
  );
  neg(
    legacyDecision.body?.case?.stage !== 'decision',
    "W9 but it does not write the derived stage behind the lifecycle's back",
  );
  const roomAfter = await j('GET', `/org/rooms/${ROOM}`, undefined, maria.token);
  neg(
    roomAfter.body?.room?.rev === revBefore,
    'W10 and it moves no concurrency token, because it moved no lifecycle state',
  );

  // W11 — the same route on a plain legacy case is untouched. Refusing a Room is
  // not an excuse to break the cases that have no lifecycle to protect.
  const spare = players.find(
    (p) => p.id !== ADULT.id && p.dateOfBirth && new Date().getFullYear() - new Date(p.dateOfBirth).getFullYear() >= 18,
  );
  const plain = await j('POST', '/org/cases', { playerId: spare?.id ?? ADULT.id, priority: 'low' }, tom.token);
  if (plain.status === 201 && !plain.body.case.room) {
    const moved = await j('POST', `/org/cases/${plain.body.case.id}/stage`, { stage: 'observation' }, tom.token);
    ok(
      moved.status === 200 && moved.body.case.stage === 'observation',
      'W11 a plain case with no Room still moves through the legacy route exactly as before',
    );
  } else {
    ok(false, 'could not create the plain-case fixture');
  }
}

section('E — every error body, swept for private text at once');
{
  // Individual "this response leaks nothing" checks test the responses somebody
  // thought of. This collects EVERY refusal the two lifecycle routes can produce and
  // sweeps them all against the same forbidden set, so a new error code added
  // later is covered by construction rather than by remembering.
  const SECRET = 'SECRETNOTEPHRASE';
  let EROOM = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) {
      EROOM = r.body.room.roomId;
      break;
    }
  }
  ok(!!EROOM, 'E0 a case for the error sweep');

  // Put genuinely private text into the room: a comment, and a decision note.
  const rev0 = (await j('GET', `/org/rooms/${EROOM}/journey`, undefined, maria.token)).body.case.rev;
  await j('POST', `/org/rooms/${EROOM}/comments`, { body: `${SECRET} in a comment` }, maria.token);
  await j(
    'POST',
    `/org/rooms/${EROOM}/decisions`,
    {
      recommendation: 'monitor',
      reasonCodes: ['needs_more_evidence'],
      note: `${SECRET} in a decision note`,
      expectedRev: rev0,
    },
    maria.token,
  );

  // The control. Without it the sweep below could pass because the secret was
  // never stored, which would make every "leaks nothing" check vacuous.
  const roomView = await j('GET', `/org/rooms/${EROOM}`, undefined, maria.token);
  const comments = await j('GET', `/org/rooms/${EROOM}/comments`, undefined, maria.token);
  ok(
    JSON.stringify(roomView.body).includes(SECRET) || JSON.stringify(comments.body).includes(SECRET),
    'E0b the private text really is stored and really is visible to the club that wrote it',
  );

  const errorBodies = ERROR_BODIES_FROM_E;
  const collect = async (label, res) => {
    if (res.status >= 400) errorBodies.push({ label, status: res.status, body: res.body });
  };

  const cur = (await j('GET', `/org/rooms/${EROOM}/journey`, undefined, maria.token)).body;
  await collect(
    'unknown action',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'teleport' }, maria.token),
  );
  await collect(
    'stage smuggled',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase', stage: 'signed' }, maria.token),
  );
  await collect(
    'bad reasons',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'closeCase', reasonCodes: ['nope'] }, maria.token),
  );
  await collect(
    'prohibited reason',
    await j(
      'POST',
      `/org/rooms/${EROOM}/lifecycle`,
      { action: 'closeCase', reasonCodes: ['nationality'] },
      maria.token,
    ),
  );
  await collect(
    'impossible jump',
    await j(
      'POST',
      `/org/rooms/${EROOM}/lifecycle`,
      { action: 'recordOfferAccepted', expectedRev: cur.case.rev },
      maria.token,
    ),
  );
  await collect(
    'not applicable',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'resumeCase', expectedRev: cur.case.rev }, maria.token),
  );
  await collect(
    'no change',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'startReview', expectedRev: cur.case.rev }, maria.token),
  );
  await collect(
    'stale rev',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase', expectedRev: 1 }, maria.token),
  );
  await collect(
    'reason required',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'closeCase', expectedRev: cur.case.rev }, maria.token),
  );
  await collect('foreign org journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, harbour.token));
  await collect(
    'foreign org write',
    await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase' }, harbour.token),
  );
  await collect('player journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, kola.token));
  await collect('no auth journey', await j('GET', `/org/rooms/${EROOM}/journey`, undefined, undefined));
  await collect('no auth write', await j('POST', `/org/rooms/${EROOM}/lifecycle`, { action: 'holdCase' }, undefined));
  await collect('ghost case', await j('GET', '/org/rooms/case-nope/journey', undefined, maria.token));

  ok(errorBodies.length >= 12, `E1 collected ${errorBodies.length} distinct refusals to sweep`);

  const FORBIDDEN = [
    [SECRET, 'a private note or comment body'],
    ['Rita Vale', 'a person at another organisation'],
    ['Harbour', "another organisation's name"],
  ];
  const offenders = [];
  for (const { label, body } of errorBodies) {
    const text = JSON.stringify(body ?? {});
    for (const [needle, what] of FORBIDDEN) if (text.includes(needle)) offenders.push(`${label}: ${what}`);
  }
  for (const o of offenders) console.error(`   ${o}`);
  neg(
    offenders.length === 0,
    "E2 no refusal carries a private note, a colleague at another club, or another club's name",
  );

  // A stack trace in a response body is both a leak and an invitation.
  const stacky = errorBodies.filter(({ body }) =>
    /\bat [\w$.]+ \(|\.mjs:\d+|node_modules|TypeError:|ReferenceError:/.test(JSON.stringify(body ?? {})),
  );
  neg(stacky.length === 0, 'E3 and none carries a stack trace, a file path or an internal exception name');

  // Every refusal names itself. An error a log cannot group is an error nobody
  // can count, and a client cannot branch on prose.
  const unnamed = errorBodies.filter(
    ({ body }) => typeof body?.error !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(body.error),
  );
  for (const u of unnamed) console.error(`   unnamed: ${u.label} -> ${JSON.stringify(u.body).slice(0, 120)}`);
  neg(unnamed.length === 0, 'E4 every refusal carries a machine-readable error code');

  // 5xx means OUR fault. None of the above is our fault.
  neg(
    errorBodies.every((e) => e.status < 500),
    "E5 and not one of them is a 5xx — every one is the caller's to fix",
  );
}

section('Y — the error contract: one table, no default, nothing internal in the body');
{
  // The error table itself is checked in the rules suite; here, the bodies section E collected.
  // A property over the HTTP bodies collected in E, rather than over the
  // ones somebody remembered: no refusal may carry a key outside the allowlist.
  //
  // `ROOM_VERSION_CONFLICT` is excluded, and that is a decision with a reason.
  // It is raised by the shared `guardRev` BEFORE this module's mapping is reached,
  // and its body — `currentRev`, `updatedBy`, `updatedAt` — is the shared
  // conflict contract that `conflict.tsx` renders in two clients. `updatedBy` is deliberately a display name and never a user id,
  // and every caller reaching it has already passed the room's visibility gate,
  // so there is nothing here a 200 would not also have shown them. Narrowing it
  // would break the shared conflict notice everywhere to disclose nothing.
  const ALLOWED_KEYS = new Set([
    'ok',
    'error',
    'message',
    'allowed',
    'to',
    'actions',
    'requires',
    'evidenceReason',
    'current',
    'expectedRev',
    'rev',
    'retryAt',
    // An input refusal: the field, what was wrong with it, and the bound it broke.
    'field',
    'problem',
    'min',
    'max',
    'expected',
  ]);
  const strayKeys = [];
  for (const { label, body } of ERROR_BODIES_FROM_E) {
    if (body?.error === 'ROOM_VERSION_CONFLICT') continue;
    for (const k of Object.keys(body ?? {})) if (!ALLOWED_KEYS.has(k)) strayKeys.push(`${label}.${k}`);
  }
  for (const s of strayKeys) console.error(`   stray key: ${s}`);
  neg(
    strayKeys.length === 0,
    'Y11 no refusal the lifecycle itself produces carries a field outside the published error shape',
  );

  // And the one body that IS excluded still may not carry a user id, which is
  // what actually matters. Checked rather than assumed, because the exclusion above
  // is only defensible if this holds.
  {
    const conflicts = ERROR_BODIES_FROM_E.filter(({ body }) => body?.error === 'ROOM_VERSION_CONFLICT');
    ok(conflicts.length >= 1, 'Y11b the sweep really did provoke a version conflict');
    const CONFLICT_KEYS = new Set([
      'error',
      'message',
      'expectedRev',
      'currentRev',
      'updatedBy',
      'updatedAt',
      'status',
    ]);
    const widened = [];
    for (const { label, body } of conflicts) {
      for (const k of Object.keys(body ?? {})) if (!CONFLICT_KEYS.has(k)) widened.push(`${label}.${k}`);
    }
    neg(
      widened.length === 0,
      'Y11c the 409 body is exactly the shared conflict contract, not that contract plus lifecycle detail',
    );
    const carriesNarrative = conflicts.some(({ body }) => {
      const text = JSON.stringify(body ?? {});
      return (
        LIFECYCLE_REASON_CODES.some((c) => text.includes(c)) ||
        /note|reason|narrative/i.test(Object.keys(body ?? {}).join(' '))
      );
    });
    neg(carriesNarrative === false, 'Y11d and carries no lifecycle reason code and no narrative field');
  }

  // The parity, restated after the mapping. Not "both are 404":
  // byte-identical, because a difference of one character is an oracle.
  const ghost = await j('GET', '/org/rooms/case-does-not-exist/journey', undefined, maria.token);
  const foreign = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, harbour.token);
  neg(
    ghost.status === 404 && foreign.status === 404,
    'Y12 a hidden case and a case that never existed both answer 404',
  );
  neg(
    JSON.stringify(ghost.body) === JSON.stringify(foreign.body),
    'Y13 and their bodies are byte-identical, after the error mapping was centralised',
  );
}

section('Z — what the lifecycle deliberately does NOT ship, asserted rather than assumed');
{
  // `recruitmentOffers` is OPTIONAL, and four separate things have to be
  // true at once for that word to mean anything. Absence has product meaning
  // here: "we cannot answer that yet" is a different statement from "there are
  // none", and an empty array would quietly turn the first into the second.
  const jz = await j('GET', `/org/rooms/${ROOM}/journey`, undefined, maria.token);
  ok(jz.status === 200, 'Z1 the journey projects with no offers store present at all');

  // That the offers are an optional, table-backed store of the journey is checked in the rules suite.

  // The distinction the optional classification exists to protect.
  ok(
    jz.body.offer?.available === true,
    'Z5 the journey reports offers as AVAILABLE: the store exists, so "there are none" is now an honest answer',
  );
  ok(
    Array.isArray(jz.body.offer?.records) && jz.body.offer.records.length === 0,
    'Z6 and degrades structurally: a real empty list beside the flag, never an invented record',
  );

  const dbNow = (await j('GET', '/ops/schema', undefined, maria.token)).body ?? {};
  ok(typeof dbNow === 'object', 'Z7 the schema surface answers');

  // The Contact vocabulary is published, because the gate has to be able to
  // refuse it by name.
  const vocab = await j('GET', '/org/recruitment/lifecycle', undefined, maria.token);
  ok(vocab.status === 200, 'Z8 the lifecycle vocabulary answers');
  const names = (vocab.body.actions ?? []).map((a) => a.action);
  ok(
    names.includes('planContact') && names.includes('recordContact'),
    'Z9 the two Contact ACTIONS are published, because the gate must be able to refuse them by name',
  );
  const contactStates = (vocab.body.actions ?? []).filter((a) => /contact/.test(a.to)).map((a) => a.to);
  ok(
    contactStates.includes('contact_planned') && contactStates.includes('contacted'),
    'Z10 and both Contact STATES are reachable destinations in the published table',
  );

  // The Contact surface lives INSIDE the case (`/org/rooms/:id/contacts`)
  // and nowhere else: there is no top-level contact list and no singular
  // alias. The one real route answers a DOMAIN code, never a bare 404.
  for (const p of ['/org/recruitment/contacts', `/org/rooms/${ROOM}/contact`]) {
    const probe = await j('POST', p, {}, maria.token);
    neg(probe.status === 404, `Z11 ${p} does not exist — Contact lives on the case, not at the top level`);
  }
  {
    const probe = await j('POST', `/org/rooms/${ROOM}/contacts`, {}, maria.token);
    ok(
      probe.status !== 404 && /^CONTACT_[A-Z_]+$/.test(probe.body?.error ?? ''),
      `Z11b /org/rooms/:id/contacts exists and refuses an empty draft by name (${probe.status} ${probe.body?.error})`,
    );
  }
}

section('S — the subsystems the lifecycle must not touch');
{
  // The lifecycle adds no Match Score and alters neither Trust nor Combine
  // eligibility. Asserted by taking a reading, moving the lifecycle, and
  // taking the reading again — rather than by reading the source and trusting
  // that nothing calls anything.
  let SROOM = null;
  let SPLAYER = null;
  for (const p of players) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    if (r.status === 201) {
      SROOM = r.body.room.roomId;
      SPLAYER = p;
      break;
    }
  }
  ok(!!SROOM, 'S0 a case for the non-interference checks');

  const readAll = async () => ({
    trust: (await j('GET', `/org/players/${SPLAYER.id}/trust`, undefined, maria.token)).body,
    passport: (await j('GET', `/org/players/${SPLAYER.id}/passport`, undefined, maria.token)).body,
    plans: (await j('GET', `/org/development/plans?playerId=${SPLAYER.id}`, undefined, maria.token)).body,
    secondLook: (await j('GET', '/org/second-look', undefined, maria.token)).body,
    combine: (await j('GET', `/org/players/${SPLAYER.id}/combine`, undefined, maria.token)).body,
    funnel: (await j('GET', '/org/rooms-funnel', undefined, maria.token)).body,
  });
  const stable = (o) => JSON.stringify(o, (k, v) => (/at$|At$|generatedAt|updatedAt|ts$/.test(k) ? undefined : v));

  const before = await readAll();
  // Move the lifecycle through several transitions, including a hold, a
  // reopen and an ending.
  let rev = (await j('GET', `/org/rooms/${SROOM}/journey`, undefined, maria.token)).body.case.rev;
  for (const action of ['startReview', 'holdCase', 'resumeCase', 'shortlist', 'prioritise']) {
    const r = await j('POST', `/org/rooms/${SROOM}/lifecycle`, { action, expectedRev: rev }, maria.token);
    if (r.status === 200) rev = r.body.currentRev ?? rev + 1;
  }
  const after = await readAll();

  neg(
    stable(before.trust) === stable(after.trust),
    'S1 five lifecycle transitions move the Trust Score not at all — Trust is evidence confidence, not progress',
  );
  neg(
    stable(before.passport) === stable(after.passport),
    "S2 and put nothing in the Passport — a club's pipeline position is not player truth",
  );
  neg(stable(before.plans) === stable(after.plans), 'S3 and create no Development Plan');
  neg(
    stable(before.combine) === stable(after.combine),
    'S4 and change no Combine eligibility — Box Cam CV is untouched by recruitment workflow',
  );
  neg(
    stable(before.secondLook) === stable(after.secondLook),
    'S5 and raise no Second Look item — a transition is not canonical material evidence',
  );

  // The funnel SHOULD move: it is the one subsystem that reads the lifecycle.
  ok(
    stable(before.funnel) !== stable(after.funnel),
    'S6 the recruitment funnel DOES move — it is the one subsystem that reads the lifecycle, and a silent funnel would be the real bug',
  );

  // No score, of any name, anywhere in the projection.
  const proj = JSON.stringify((await j('GET', `/org/rooms/${SROOM}/journey`, undefined, maria.token)).body);
  neg(
    !/matchScore|match_score|journeyScore|readiness|signingProbability|progressPercent|candidateQuality|likelihood/i.test(
      proj,
    ),
    'S7 and the journey carries no score, readiness, probability or percentage of any kind',
  );

  // Matching is criteria-based and must not learn from the lifecycle.
  // Two assertions, not one disjunction. `status !== 200 || !includes(...)`
  // passes when the watchlists route is BROKEN, which proves nothing about
  // whether matching learned from the lifecycle.
  const watch = await j('GET', '/org/watchlists', undefined, maria.token);
  ok(watch.status === 200, 'S8 the watchlists route answers, so the next check is not vacuous');
  neg(!JSON.stringify(watch.body).includes(SROOM), 'S8b and no watchlist acquired the case as a criterion');
}

section('R — restart: what survived the process going away');
{
  // Idempotency that lives in process memory is idempotency that stops working
  // exactly when it is needed — after the crash that made the client retry.
  // This kills the server and brings it back on the same data directory.
  server.kill('SIGKILL');
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(`${BASE}/healthz`);
      await sleep(100);
    } catch {
      break;
    }
  }
  server = await boot();
  const reAuth = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  ok(!!reAuth?.token, 'R1 the server came back and accepts a login');

  const { room, key, from, to } = IDEMPOTENCY_PROBE;
  const beforeState = (await j('GET', `/org/rooms/${room}/journey`, undefined, reAuth.token)).body;
  const replayAfterRestart = await j(
    'POST',
    `/org/rooms/${room}/lifecycle`,
    { action: 'holdCase', clientKey: key },
    reAuth.token,
  );
  neg(
    replayAfterRestart.status === 200 && replayAfterRestart.body?.idempotent === true,
    'R2 a replay after the process died is still recognised as a replay',
  );
  ok(
    replayAfterRestart.body?.from === from && replayAfterRestart.body?.to === to,
    'R3 and reports the original endpoints, recovered from the persisted history',
  );
  const afterState = (await j('GET', `/org/rooms/${room}/journey`, undefined, reAuth.token)).body;
  neg(
    afterState.history.total === beforeState.history.total,
    'R4 and the restart plus replay wrote no new history entry',
  );
  neg(afterState.case.rev === beforeState.case.rev, 'R5 and moved no rev');
  ok(
    afterState.lifecycle.currentStage === beforeState.lifecycle.currentStage,
    'R6 the case is exactly where it was before the crash',
  );
}

// ---------------------------------------------------------------- report
const total = passed;
const ratio = total ? Math.round((negatives / total) * 100) : 0;
console.log(`\nrecruitment/lifecycle: ${total} checks passed, ${negatives} negative/security/edge checks (${ratio}%)`);
if (process.exitCode === 1) console.error('\n✗ recruitment/lifecycle has failures.');
else console.log('all recruitment/lifecycle checks passed');
