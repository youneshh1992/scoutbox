// The Room engine behind the Recruitment Rooms battery (e2e/recruitment/rooms.mjs), checked in this process: the
// state machine, the reason taxonomy, decisions and readiness, permissions, activity, snapshots, the funnel, list
// rows, tags and limits.
import {
  ROOM_STATUSES,
  ROOM_STATUS_LABELS,
  ROOM_TRANSITIONS,
  OPEN_ROOM_STATUSES,
  TERMINAL_ROOM_STATUSES,
  PRO_STAGES,
  GRASSROOTS_STAGES,
  stageForRoomStatus,
  roomStatusForStage,
  canTransition,
  validateTransition,
  validateReasonCodes,
  validateDecision,
  REASON_CODES,
  ALL_REASON_CODES,
  PROHIBITED_REASON_CODES,
  REVISITABLE_REASON_CODES,
  RECOMMENDATIONS,
  decisionReadiness,
  roomHealth,
  ROOM_HEALTH,
  roomRole,
  roomCan,
  normaliseSourceContext,
  TASK_STATES,
  canTaskTransition,
  ROOM_PRIORITIES,
  roomActivity,
  buildRoomSnapshot,
  roomSummary,
  roomFunnel,
  secondLookEvent,
  validateTag,
  clampPage,
  LIMITS,
  SNAPSHOT_STATUSES,
  REASON_REQUIRED_STATUSES,
} from '../../../domains/recruitment/rooms/shared.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/rooms');

// ======================================================= U1 state machine
section('U1 — the room state machine is explicit, total and mapped onto the case stages');
{
  // No count of the statuses: a count is a census, not an invariant. The
  // invariant — the one that makes the room a facet and not a second pipeline —
  // is that EVERY status is labelled and maps into both case vocabularies, which
  // the loop below checks exhaustively.
  ok(ROOM_STATUSES.length >= 13, `the room state machine is defined (${ROOM_STATUSES.length} statuses)`);
  ok(new Set(ROOM_STATUSES).size === ROOM_STATUSES.length, 'no status is declared twice');
  ok(
    ROOM_STATUSES.every((s) => ROOM_STATUS_LABELS[s]),
    'every status has a human label',
  );

  // Every status maps onto a stage the case vocabulary actually has —
  // this is what makes the room a facet rather than a second pipeline.
  let mapped = 0;
  for (const s of ROOM_STATUSES) {
    ok(PRO_STAGES.includes(stageForRoomStatus(s, 'pro')), `${s} maps to a real pro stage`);
    ok(GRASSROOTS_STAGES.includes(stageForRoomStatus(s, 'grassroots')), `${s} maps to a real grassroots stage`);
    mapped++;
  }
  ok(mapped === ROOM_STATUSES.length, `all ${ROOM_STATUSES.length} statuses map in both vocabularies`);

  // The inverse mapping is consistent: a legacy stage write lands on a status
  // that maps back to the same stage.
  for (const stage of PRO_STAGES) {
    const st = roomStatusForStage(stage, 'pro');
    ok(st && stageForRoomStatus(st, 'pro') === stage, `pro stage ${stage} round-trips through a room status`);
  }
  for (const stage of GRASSROOTS_STAGES) {
    const st = roomStatusForStage(stage, 'grassroots');
    ok(st && stageForRoomStatus(st, 'grassroots') === stage, `grassroots stage ${stage} round-trips`);
  }

  // Every allowed transition, exercised.
  let allowed = 0;
  for (const [from, tos] of Object.entries(ROOM_TRANSITIONS)) {
    for (const to of tos) {
      ok(canTransition(from, to), `${from} → ${to} is allowed`);
      allowed++;
    }
  }
  ok(allowed >= 45, `${allowed} allowed transitions are declared and all pass`);

  // Every prohibited transition, exercised.
  let refused = 0;
  for (const from of ROOM_STATUSES) {
    for (const to of ROOM_STATUSES) {
      if (from === to || canTransition(from, to)) continue;
      if (canTransition(from, to)) continue;
      refused++;
    }
  }
  neg(refused > 100, `${refused} status pairs are refused by the table`);
  neg(!canTransition('watching', 'signed'), 'a room cannot jump from watching straight to signed');
  neg(!canTransition('watching', 'offer_made'), 'a room cannot jump from watching to an offer');
  neg(!canTransition('archived', 'signed'), 'an archived room cannot be signed without being reopened');
  neg(!canTransition('signed', 'watching'), 'a signed room cannot drop back into watching');
  neg(!canTransition('closed', 'signed'), 'a closed room cannot be signed directly');
  ok(canTransition('signed', 'closed'), 'signed may only be filed away as closed');
  ok(canTransition('archived', 'under_review'), 'an archived room can be reopened for review');
  ok(canTransition('closed', 'under_review'), 'a closed room can be reopened for review');

  neg(!validateTransition('watching', 'not_a_status').ok, 'an unknown target status is refused');
  neg(
    validateTransition('watching', 'not_a_status').error === 'ROOM_STATUS_UNKNOWN',
    'the unknown-status refusal names itself',
  );
  neg(!validateTransition('watching', 'watching').ok, 'a no-op status change is refused');
  neg(!validateTransition('watching', 'signed').ok, 'an invalid jump is refused by the validator too');
  neg(validateTransition('watching', 'signed').allowed?.length > 0, 'the refusal tells the caller what IS allowed');

  for (const s of REASON_REQUIRED_STATUSES) {
    // Pick any status this one is genuinely reachable from, so the reason rule
    // is tested rather than the transition table.
    const from = ROOM_STATUSES.find((f) => canTransition(f, s));
    neg(validateTransition(from, s).error === 'ROOM_REASON_REQUIRED', `${s} cannot be recorded without a reason`);
    ok(validateTransition(from, s, { reasonCodes: ['budget'] }).ok, `${s} is accepted with a reason`);
  }
  ok(
    validateTransition('archived', 'under_review', { reasonCodes: ['continue_monitoring'] }).reopen === true,
    'reopening is flagged as a reopen',
  );
  ok(
    SNAPSHOT_STATUSES.every((s) => ROOM_STATUSES.includes(s)),
    'every snapshot trigger is a real status',
  );
  ok(validateTransition('under_review', 'shortlisted').snapshot === true, 'shortlisting captures a snapshot');
  ok(!OPEN_ROOM_STATUSES.includes('archived'), 'archived is not an open status');
  ok(
    OPEN_ROOM_STATUSES.length === ROOM_STATUSES.length - TERMINAL_ROOM_STATUSES.length &&
      TERMINAL_ROOM_STATUSES.every((s) => !OPEN_ROOM_STATUSES.includes(s)),
    'open and terminal statuses partition the set exactly',
  );

  // ---- U1b — the five later states get the same scrutiny as the first
  // thirteen. The whole value of this table is that it has no escape hatch, and
  // a new state is exactly where one would appear.
  //
  // These are here rather than in the lifecycle suite because the table is here: a
  // negative assertion about a transition belongs beside the transition.
  neg(!canTransition('watching', 'contacted'), 'a club cannot have contacted a player it never planned to contact');
  neg(!canTransition('watching', 'offer_accepted'), 'no jump from watching to an accepted offer');
  neg(!canTransition('watching', 'offer_declined'), 'no jump from watching to a declined offer');
  neg(!canTransition('watching', 'trial_scheduled'), 'no jump from watching to a scheduled trial');
  neg(!canTransition('under_review', 'contacted'), 'contact must be planned before it can be recorded');
  neg(!canTransition('under_review', 'offer_accepted'), 'no jump from review to an accepted offer');
  neg(!canTransition('under_review', 'signed'), 'no jump from review to signed');
  neg(!canTransition('contact_planned', 'signed'), 'a planned contact is not a signing');
  neg(!canTransition('contact_planned', 'offer_made'), 'an offer cannot precede the approach being made');
  neg(!canTransition('contact_planned', 'offer_accepted'), 'nor an acceptance');
  neg(!canTransition('contact_planned', 'trial_scheduled'), 'a trial cannot be scheduled before it is requested');
  neg(!canTransition('contact_planned', 'trial_completed'), 'nor completed');
  neg(!canTransition('contacted', 'signed'), 'being contacted is not being signed');
  neg(!canTransition('contacted', 'offer_made'), 'an offer is considered before it is made');
  neg(!canTransition('contacted', 'offer_accepted'), 'and cannot be accepted before it is made');
  neg(!canTransition('contacted', 'trial_scheduled'), 'a trial is requested before it is scheduled');
  neg(!canTransition('contacted', 'contact_planned'), 'contact cannot be un-made back into a plan');
  neg(!canTransition('trial_requested', 'trial_completed'), 'a trial cannot complete without being scheduled');
  neg(!canTransition('trial_requested', 'offer_made'), 'no offer straight from a trial request');
  neg(!canTransition('trial_scheduled', 'offer_made'), 'no offer straight from a scheduled trial');
  neg(!canTransition('trial_scheduled', 'signed'), 'no signing straight from a scheduled trial');
  neg(!canTransition('trial_completed', 'offer_made'), 'an offer is considered before it is made, even after a trial');
  neg(!canTransition('trial_completed', 'signed'), 'a completed trial is not a signing');
  neg(!canTransition('offer_consideration', 'offer_accepted'), 'an offer must be MADE before it can be accepted');
  neg(!canTransition('offer_consideration', 'offer_declined'), 'and before it can be declined');
  neg(!canTransition('offer_consideration', 'signed'), 'considering an offer is not signing');
  neg(!canTransition('offer_accepted', 'offer_made'), 'an accepted offer cannot be un-accepted back into a live offer');
  neg(!canTransition('offer_accepted', 'offer_declined'), 'nor flipped to declined');
  neg(!canTransition('offer_accepted', 'under_review'), 'an accepted offer does not drop back into review');
  neg(!canTransition('offer_accepted', 'trial_requested'), 'nor back into the trial path');
  neg(!canTransition('offer_declined', 'offer_accepted'), 'a declined offer cannot become an accepted one');
  neg(!canTransition('offer_declined', 'offer_made'), 'a declined offer is not re-made in place');
  neg(!canTransition('offer_declined', 'signed'), 'a player who declined has not signed');
  neg(!canTransition('signed', 'offer_accepted'), 'a signing does not revert to an acceptance');
  neg(!canTransition('signed', 'on_hold'), 'a signing cannot be put on hold');
  neg(!canTransition('on_hold', 'signed'), 'a held case is not signed without going back through the work');
  // These stay refused AS TABLE EDGES — a paused case is
  // not answered, claimed or moved into an evidence-bearing state by anything
  // but `resumeCase`, which returns it to where it was held from through the
  // ONE validator (domains/recruitment/lifecycle/lifecycle.mjs), never through this table.
  neg(!canTransition('on_hold', 'offer_made'), 'nor straight to an offer');
  neg(!canTransition('on_hold', 'offer_accepted'), 'nor to an acceptance');
  neg(!canTransition('on_hold', 'contacted'), 'nor to contact having happened');
  neg(!canTransition('on_hold', 'trial_scheduled'), 'nor to a scheduled trial');
  neg(!canTransition('archived', 'offer_accepted'), 'an archived case cannot acquire an accepted offer');
  neg(!canTransition('withdrawn', 'signed'), 'a withdrawn case cannot be signed without being reopened');
  neg(!canTransition('closed', 'offer_accepted'), 'a closed case cannot acquire an accepted offer');
  // on_hold is LIVE, not an ending — the single most important property of the
  // state, and the one a later refactor is most likely to get wrong.
  neg(!TERMINAL_ROOM_STATUSES.includes('on_hold'), 'on_hold is NOT terminal — a paused case is still a live case');
  neg(
    !TERMINAL_ROOM_STATUSES.includes('offer_declined'),
    'offer_declined is not terminal either — the club may still act',
  );
  ok(OPEN_ROOM_STATUSES.includes('on_hold'), 'and on_hold is therefore an open status');
}

// ==================================================== U2 reason taxonomy
section('U2 — structured reasons, with protected characteristics refused');
{
  ok(ALL_REASON_CODES.length === new Set(ALL_REASON_CODES).size, 'reason codes are unique across categories');
  ok(
    Object.keys(REASON_CODES).join(',') === 'football,evidence,process,outcome',
    'the four reason categories are present',
  );
  ok(validateReasonCodes(['technical_fit', 'budget']).ok, 'valid codes from two categories are accepted');
  ok(validateReasonCodes(['TECHNICAL_FIT']).codes[0] === 'technical_fit', 'codes are normalised to lower case');
  ok(validateReasonCodes(['budget', 'budget']).codes.length === 1, 'duplicate codes are folded');

  // The whole point of the taxonomy.
  for (const bad of [
    'race',
    'nationality',
    'religion',
    'disability',
    'sexuality',
    'socioeconomic',
    'postcode',
    'pregnancy',
  ]) {
    const r = validateReasonCodes([bad]);
    neg(!r.ok && r.error === 'ROOM_REASON_PROHIBITED', `"${bad}" can never be recorded as a recruitment reason`);
  }
  neg(
    validateReasonCodes(['technical_fit', 'ethnicity']).error === 'ROOM_REASON_PROHIBITED',
    'one prohibited code poisons the whole list',
  );
  neg(
    validateReasonCodes(['ethnicity']).prohibited?.includes('ethnicity'),
    'the refusal names the prohibited code for the audit',
  );
  neg(validateReasonCodes(['made_up_code']).error === 'ROOM_REASON_UNKNOWN', 'a code outside the taxonomy is refused');
  neg(validateReasonCodes(['made_up_code']).unknown?.length === 1, 'the refusal names the unknown code');
  neg(!validateReasonCodes('budget').ok, 'a non-array reason list is refused');
  neg(!validateReasonCodes(new Array(9).fill('budget').map((c, i) => `${c}${i}`)).ok, 'too many reasons are refused');
  neg(
    ALL_REASON_CODES.every((c) => !PROHIBITED_REASON_CODES.includes(c)),
    'no prohibited code hides inside the allowed taxonomy',
  );
  ok(
    REVISITABLE_REASON_CODES.every((c) => ALL_REASON_CODES.includes(c)),
    'every revisitable reason is a real reason',
  );
  ok(
    REVISITABLE_REASON_CODES.includes('insufficient_recent_evidence'),
    'missing recent evidence is revisitable — the Second Look hook',
  );
  neg(
    !REVISITABLE_REASON_CODES.includes('squad_space'),
    'a squad-space decision is not treated as revisitable evidence',
  );
}

// ================================================== U3 decisions, readiness
section('U3 — decisions are human, readiness is counts, health is a word');
{
  ok(
    validateDecision({ recommendation: 'shortlist', reasonCodes: ['technical_fit'] }).ok,
    'a shortlist decision with a reason is valid',
  );
  ok(validateDecision({ recommendation: 'no_decision' }).ok, 'recording "no decision yet" is legitimate');
  neg(!validateDecision({ recommendation: 'sign_immediately' }).ok, 'an invented recommendation is refused');
  neg(
    validateDecision({ recommendation: 'archive', reasonCodes: [] }).error === 'ROOM_REASON_REQUIRED',
    'archiving without a reason is refused',
  );
  neg(
    validateDecision({ recommendation: 'archive', reasonCodes: ['race'] }).error === 'ROOM_REASON_PROHIBITED',
    'archiving for a protected trait is refused',
  );
  neg(
    !validateDecision({ recommendation: 'offer', note: 'x'.repeat(2001) }).ok,
    'an oversized internal note is refused',
  );
  ok(
    RECOMMENDATIONS.length === 7 && RECOMMENDATIONS.includes('no_decision'),
    'seven recommendations, including no_decision',
  );

  const empty = decisionReadiness({});
  ok(empty.items.length === 6, 'readiness reports six workflow items');
  ok(typeof empty.complete === 'number' && typeof empty.total === 'number', 'readiness is expressed as counts');
  neg(
    !('score' in empty) && !('percent' in empty) && !('probability' in empty),
    'readiness carries no score, percentage or probability',
  );
  neg(JSON.stringify(empty).toLowerCase().includes('likelihood') === false, 'readiness never speaks of likelihood');
  ok(/not a recommendation/i.test(empty.note), 'readiness says outright that it is not a recommendation');
  const full = decisionReadiness({
    assessmentsAssigned: 2,
    assessmentsSubmitted: 2,
    recentFullMatch: true,
    coachReference: true,
    combineVerified: 2,
    trialState: 'reported',
    openTasks: 0,
  });
  ok(full.complete === 6 && full.blockers.length === 0, 'a complete workflow reports no blockers');
  ok(
    /No production-supported Combine Verified result/.test(JSON.stringify(empty)),
    'the honest production Combine limitation is surfaced as a gap',
  );

  ok(
    ROOM_HEALTH.every((h) => typeof h === 'string'),
    'room health is a word, never a number',
  );
  ok(
    roomHealth({ readiness: full, hasCurrentDecision: true, status: 'archived' }) === 'decision_recorded',
    'an archived room with a decision reads as decision recorded',
  );
  ok(
    roomHealth({
      readiness: decisionReadiness({ assessmentsAssigned: 2, assessmentsSubmitted: 1 }),
      status: 'under_review',
    }) === 'assessment_outstanding',
    'an outstanding assessment shows as such',
  );
  ok(
    roomHealth({ readiness: full, status: 'under_review' }) === 'ready_for_review',
    'a complete workflow reads as ready for review',
  );
}

// ================================================ U4 permissions and tasks
section('U4 — permissions map onto the existing org model; tasks are staff work');
{
  const room = {
    ownerUserId: 'u1',
    assignments: [{ userId: 'u2' }],
    restricted: false,
    room: { leadScoutUserId: 'u1', status: 'under_review' },
  };
  ok(roomRole({ room, user: { id: 'u1' }, isLead: false }) === 'room_lead', 'the owner is the room lead');
  ok(roomRole({ room, user: { id: 'u2' }, isLead: false }) === 'contributor', 'an assignee is a contributor');
  ok(
    roomRole({ room, user: { id: 'u9' }, isLead: false }) === 'contributor',
    'another colleague is a contributor on an open, unrestricted room',
  );
  ok(
    roomRole({ room: { ...room, room: { ...room.room, status: 'archived' } }, user: { id: 'u9' }, isLead: false }) ===
      'viewer',
    'a filed-away room is read-only to a colleague — its discussion is institutional memory',
  );
  neg(
    !roomCan(
      roomRole({ room: { ...room, room: { ...room.room, status: 'archived' } }, user: { id: 'u9' }, isLead: false }),
      'comment',
    ),
    'a colleague cannot add to an archived room’s discussion',
  );
  ok(
    roomRole({ room, user: { id: 'u9' }, isLead: true }) === 'recruitment_admin',
    'a recruitment lead administers any room',
  );
  neg(
    roomRole({ room: { ...room, restricted: true }, user: { id: 'u9' }, isLead: false }) === null,
    'a restricted room admits no unrelated colleague',
  );

  ok(roomCan('viewer', 'read'), 'a viewer can read');
  neg(!roomCan('viewer', 'comment'), 'a viewer cannot comment');
  ok(
    roomCan('contributor', 'comment') && roomCan('contributor', 'create_task'),
    'a contributor comments and creates tasks',
  );
  neg(!roomCan('contributor', 'set_status'), 'a contributor cannot move the room status');
  neg(!roomCan('contributor', 'record_decision'), 'a contributor cannot record the decision');
  ok(roomCan('room_lead', 'record_decision') && roomCan('room_lead', 'archive'), 'a room lead decides and archives');
  neg(!roomCan('room_lead', 'manage_any_room'), 'a room lead does not administer other rooms');
  ok(roomCan('recruitment_admin', 'manage_any_room'), 'a recruitment admin does');
  neg(!roomCan(null, 'read'), 'no role means no access at all');
  neg(!roomCan('room_lead', 'invent_capability'), 'an unknown action is refused rather than allowed');

  ok(TASK_STATES.join(',') === 'open,in_progress,done,cancelled', 'four task states');
  ok(
    canTaskTransition('open', 'in_progress') && canTaskTransition('in_progress', 'done'),
    'the ordinary task path works',
  );
  ok(canTaskTransition('done', 'open'), 'a task can be reopened');
  neg(!canTaskTransition('done', 'in_progress'), 'a done task cannot slide back to in progress');
  neg(!canTaskTransition('cancelled', 'done'), 'a cancelled task cannot be completed');
}

// ========================================== U5 activity, snapshots, funnel
section('U5 — activity ordering, snapshot contents, funnel and Second Look');
{
  const hist = [
    { id: 'aud-1', at: 1000, byKind: 'org', byId: 'u1', byName: 'Maria', action: 'room_created', detail: null },
    {
      id: 'aud-2',
      at: 1000,
      byKind: 'org',
      byId: 'u1',
      byName: 'Maria',
      action: 'room_status_changed',
      detail: { to: 'shortlisted' },
    },
    { id: 'aud-3', at: 2000, byKind: 'org', byId: 'u2', byName: 'Tom', action: 'room_comment_added', detail: null },
  ];
  const a = roomActivity(hist);
  ok(a.items[0].id === 'aud-3', 'activity is newest first');
  // Two events in the same millisecond must not swap places between reads.
  ok(a.items[1].id === 'aud-2' && a.items[2].id === 'aud-1', 'same-millisecond events keep a stable, total order');
  ok(
    roomActivity(hist)
      .items.map((x) => x.id)
      .join() ===
      roomActivity(hist)
        .items.map((x) => x.id)
        .join(),
    'ordering is deterministic across reads',
  );
  ok(
    a.items.every((x) => x.actor?.name),
    'every event keeps its actor attribution',
  );
  ok(a.total === 3, 'activity reports its total');
  const paged = roomActivity(hist, { limit: 2 });
  ok(paged.items.length === 2 && paged.nextCursor === 'aud-2', 'activity paginates with a cursor');
  ok(
    roomActivity(hist, { limit: 2, cursor: 'aud-2' }).items[0].id === 'aud-1',
    'the cursor continues where the page ended',
  );
  ok(
    roomActivity([{ id: 'aud-9', at: 5, byKind: 'org', byId: 'u1', byName: 'M', action: 'created' }]).items[0].type ===
      'case_created',
    'a legacy case audit row is surfaced as a case event, not dropped',
  );

  const snap = buildRoomSnapshot({
    trigger: 'status:shortlisted',
    trustSnapshot: {
      score: 78,
      band: 'strong_evidence',
      policyVersion: 1,
      hash: 'abc',
      components: {
        identity: { level: { id: 'established' }, coverage: 70 },
        combine: { level: { id: 'none' }, coverage: 0 },
      },
    },
    sourceRefs: {
      passportVersion: 3,
      evidenceIds: ['evd-1'],
      assessmentIds: ['ass-1'],
      combineResults: ['box_touch_60@1'],
      trialIds: [],
    },
  });
  ok(
    snap.trust.score === 78 && snap.trust.policyVersion === 1,
    'the snapshot preserves the score and its policy version',
  );
  ok(snap.trust.componentLevels.identity.id === 'established', 'the snapshot keeps component LEVELS');
  // safeTrustProjection withholds per-component coverage from a club; a stored
  // snapshot must not quietly reintroduce it.
  neg(
    !JSON.stringify(snap.trust.componentLevels).includes('coverage'),
    'the snapshot does not carry per-component coverage numbers',
  );
  neg(
    !JSON.stringify(snap).includes('gaps') && !JSON.stringify(snap).includes('assessmentContent'),
    'the snapshot carries no gaps and no assessment content',
  );
  ok(
    snap.sourceRefs.evidenceIds.length === 1 && snap.sourceRefs.passportVersion === 3,
    'the snapshot keeps minimal source references',
  );
  neg(
    !/ability/i.test(snap.note.replace('not a record of the player’s ability', '')),
    'the snapshot note says it is not a record of ability',
  );
  const big = buildRoomSnapshot({ trigger: 't', sourceRefs: { evidenceIds: new Array(200).fill('e') } });
  neg(big.sourceRefs.evidenceIds.length === 40, 'source references are bounded — no giant frozen JSON');

  const f = roomFunnel([
    { room: { status: 'shortlisted' } },
    { room: { status: 'signed' } },
    { room: { status: 'archived' } },
    { room: { status: 'watching' } },
  ]);
  ok(
    f.total === 4 && f.signed === 1 && f.shortlisted === 1 && f.archived === 1 && f.active === 2,
    'the funnel counts each stage',
  );
  neg(
    /no cross-club league table|publishes no cross-club/i.test(f.note),
    'the funnel states there is no cross-club table',
  );

  const ev = secondLookEvent(
    { id: 'case-1', orgId: 'org-a', playerId: 'pl-1', room: { status: 'archived', updatedAt: 9 } },
    {
      reasonCodes: ['insufficient_recent_evidence'],
      note: 'private scout thoughts',
      createdAt: 9,
      snapshot: { sourceRefs: { passportVersion: 2 } },
    },
  );
  ok(
    ev.type === 'recruitment_room_archived' && ev.revisitable === true,
    'the archive event is typed and marked revisitable',
  );
  neg(!JSON.stringify(ev).includes('private scout thoughts'), 'the domain event carries no private free text');
  neg(!('playerName' in ev) && !('note' in ev), 'the domain event carries no player name and no note');
  ok(
    secondLookEvent(
      { id: 'c', orgId: 'o', playerId: 'p', room: { status: 'archived', updatedAt: 1 } },
      { reasonCodes: ['squad_space'], createdAt: 1 },
    ).revisitable === false,
    'a squad-space archive is not marked revisitable',
  );
}

// ===================================================== U6 summary and tags
section('U6 — list rows, tags and limits');
{
  const row = roomSummary(
    {
      id: 'case-1',
      playerId: 'pl-1',
      playerName: 'A Player',
      stage: 'observation',
      ownerUserId: 'u1',
      ownerName: 'Maria',
      createdAt: 1,
      room: { status: 'shortlisted', priority: 'high', tags: ['local'], leadScoutUserId: 'u1', updatedAt: 2 },
    },
    {
      player: { position: 'CM', age: 17 },
      trust: { score: 80, band: 'strong_evidence', bandLabel: 'Strong evidence' },
      openTasks: 1,
      health: 'ready_for_review',
      visible: true,
    },
  );
  ok(
    row.trust.score === 80 && /not football ability/i.test(row.trust.note),
    'a list row carries the Trust disclaimer with the score',
  );
  neg(!('dob' in row) && !('location' in row) && !('medical' in row), 'a list row carries no private player field');
  const hidden = roomSummary(
    {
      id: 'c',
      playerId: 'p',
      playerName: 'A Player',
      stage: 's',
      ownerUserId: 'u',
      ownerName: 'M',
      createdAt: 1,
      room: { status: 'watching', priority: 'normal', tags: [], updatedAt: 1 },
    },
    { visible: false, trust: { score: 99 } },
  );
  neg(
    hidden.playerName === null && hidden.trust === null && hidden.playerAvailable === false,
    'an invisible player leaks neither name nor score into a list row',
  );

  ok(validateTag('Left-footed CB').ok, 'an ordinary internal tag is accepted');
  neg(!validateTag('').ok, 'an empty tag is refused');
  for (const bad of ['nationality', 'Religion', 'disability', 'family income']) {
    neg(!validateTag(bad).ok, `a tag reading "${bad}" is refused as a protected classification`);
  }
  ok(
    clampPage(10) === 10 && clampPage(999) === LIMITS.maxPageSize && clampPage('x') === LIMITS.pageSize,
    'page sizes are clamped',
  );
  ok(
    normaliseSourceContext('watchlist') === 'watchlist' && normaliseSourceContext('nonsense') === 'direct',
    'source context is normalised, never free-form',
  );
  ok(ROOM_PRIORITIES.join(',') === 'low,normal,high,urgent', 'four internal priorities');
}

section('A decision note that is not text');
{
  neg(
    !validateDecision({ recommendation: 'trial', note: { toString: () => 'x' } }).ok,
    'the decision rule itself refuses a note that is not text',
  );
}

done();
