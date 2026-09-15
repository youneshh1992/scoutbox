/**
 * M23 — the recruitment lifecycle: semantic actions over one transition table.
 *
 * WHERE AUTHORITY LIVES, AND IN WHICH DIRECTION
 *
 *   db.recruitmentCases   the canonical recruitment object (M12, unchanged)
 *   case.room.status      the canonical lifecycle state (M17, extended by 5)
 *   case.stage            a PURE DERIVATION of room.status, one writer
 *   case.history          the append-only record of how it got there
 *
 * One direction, no cycle: status → stage, never stage → status. M23 adds no
 * fourth representation and no stored "journey" — the journey is a projection
 * (journey.mjs), computed on read from the records above.
 *
 * WHY THERE IS NO `PATCH stage = X`
 *
 * A generic stage setter makes the client the author of the lifecycle, and
 * then every rule about what may follow what lives in whichever caller
 * remembered it. Instead this file exposes SEMANTIC ACTIONS — planContact,
 * completeTrial, recordOfferAccepted — each of which names one real event, maps
 * to exactly one target state, and carries its own preconditions.
 *
 * WHAT THIS FILE DELIBERATELY CANNOT DO
 *
 * It cannot fabricate the evidence a transition requires. `signed` needs a
 * confirmed joining record; `trial_completed` needs a completed trial. Those
 * objects belong to later phases, so the preconditions are declared here and
 * RESOLVED THROUGH AN INJECTED PROVIDER. Until a phase ships, its provider
 * answers "no such evidence" and the transition is refused — which is the
 * honest answer, and is why P2 creates no placeholder trials or offers.
 */

import { ROOM_TRANSITIONS, ROOM_STATUSES, TERMINAL_ROOM_STATUSES, STATUS_EVIDENCE_REQUIRED } from '../m17/shared.mjs';

export const RECRUITMENT_LIFECYCLE_POLICY_VERSION = 1;

/**
 * States that end the case. `on_hold` is NOT among them: a hold is a live case
 * with a reason and possibly a date, and every ordinary route out of it stays
 * open. Treating a pause as an ending is how paused work disappears.
 */
export const LIFECYCLE_TERMINAL = Object.freeze([...TERMINAL_ROOM_STATUSES]);
export const LIFECYCLE_REOPENABLE = Object.freeze(['withdrawn', 'archived', 'closed']);
const REOPENABLE = LIFECYCLE_REOPENABLE;

/** The initial state of a newly opened case. */
export const LIFECYCLE_INITIAL = 'watching';

/**
 * Structured reason codes for lifecycle movement.
 *
 * Deliberately NOT prose: a reason a machine cannot group is a reason nobody
 * can report on. These describe WHY THE CASE MOVED. They are separate from
 * M17's 19 decision reason codes, which describe why a club DECIDED something
 * — a decision is an opinion, a transition is an event.
 */
export const LIFECYCLE_REASON_CODES = Object.freeze([
  'contact_planned',
  'contact_made',
  'player_responded',
  'trial_progression',
  'trial_completed',
  'club_decision',
  'player_declined',
  'offer_progression',
  'offer_accepted_in_scoutbox',
  'signed_outcome',
  'rejected',
  'withdrawn',
  'on_hold',
  'hold_resumed',
  'case_closed',
  'case_reopened',
]);

const REASON_SET = new Set(LIFECYCLE_REASON_CODES);

/**
 * Preconditions a target state requires from a DURABLE RECORD elsewhere.
 *
 * `kind` is resolved by the evidence provider. A provider that does not know a
 * kind must answer `{ satisfied: false, reason: 'not_implemented' }` — never
 * `true`, and never by inventing a row.
 */
/**
 * Preconditions, re-exported from the ONE table in m17/shared.mjs.
 *
 * This used to be a second copy living here, and that copy was the defect: the
 * legacy status route consulted m17 and never saw it, so `offer_made` +
 * `{status:'signed'}` walked straight past the requirement. Two tables meant
 * two answers to one question. Now there is one table, returned by the one
 * validator every status path calls.
 */
export const LIFECYCLE_PRECONDITIONS = STATUS_EVIDENCE_REQUIRED;

/**
 * Semantic actions. Each names one real event and maps to exactly one state.
 *
 * `roles` lists who may perform it, using M17's room role vocabulary. There is
 * no action here performable by a player or a guardian: a player responds to
 * their own contact, trial or offer, and the case moves BECAUSE that response
 * exists — through the precondition, never by the player addressing the case.
 *
 * `applicableFrom` narrows WHICH of the transition table's edges an action may
 * traverse. Three actions land on `under_review`, and without this they were
 * all offered from a withdrawn case at once — three names for one move, each
 * writing a different reason code into the history. "Resumed from hold" on a
 * case that was never on hold is a false record, and an analytics consumer
 * counting `case_reopened` would undercount every reopen taken under another
 * name. The transition table is unchanged; only the action that may describe
 * a given edge narrows, so the recorded reason matches the event.
 */
// NULL PROTOTYPE, deliberately. A plain object literal answers truthy for
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__`, so a
// client posting `{ action: "constructor" }` walked past the
// `!LIFECYCLE_ACTIONS[action]` guard in the route, reached the validator, and
// crashed reading `.roles` off Object's constructor — a 500 from one word of
// request body. With no prototype, a key we did not define is `undefined` and
// the guards that were already written do their job.
export const LIFECYCLE_ACTIONS = Object.freeze(Object.assign(Object.create(null), {
  startReview:        { to: 'under_review',        reason: 'club_decision',              roles: ['contributor', 'room_lead', 'recruitment_admin'], applicableFrom: (f) => !TERMINAL_ROOM_STATUSES.includes(f) && f !== 'on_hold' },
  planContact:        { to: 'contact_planned',     reason: 'contact_planned',            roles: ['room_lead', 'recruitment_admin'] },
  recordContact:      { to: 'contacted',           reason: 'contact_made',               roles: ['room_lead', 'recruitment_admin'] },
  shortlist:          { to: 'shortlisted',         reason: 'club_decision',              roles: ['contributor', 'room_lead', 'recruitment_admin'] },
  prioritise:         { to: 'priority',            reason: 'club_decision',              roles: ['room_lead', 'recruitment_admin'] },
  planTrial:          { to: 'trial_requested',     reason: 'trial_progression',          roles: ['room_lead', 'recruitment_admin'] },
  confirmTrial:       { to: 'trial_scheduled',     reason: 'trial_progression',          roles: ['room_lead', 'recruitment_admin'] },
  completeTrial:      { to: 'trial_completed',     reason: 'trial_completed',            roles: ['room_lead', 'recruitment_admin'] },
  considerOffer:      { to: 'offer_consideration', reason: 'club_decision',              roles: ['room_lead', 'recruitment_admin'] },
  sendOffer:          { to: 'offer_made',          reason: 'offer_progression',          roles: ['room_lead', 'recruitment_admin'] },
  recordOfferAccepted:{ to: 'offer_accepted',      reason: 'offer_accepted_in_scoutbox', roles: ['room_lead', 'recruitment_admin'] },
  recordOfferDeclined:{ to: 'offer_declined',      reason: 'player_declined',            roles: ['room_lead', 'recruitment_admin'] },
  confirmSignedOutcome:{ to: 'signed',             reason: 'signed_outcome',             roles: ['recruitment_admin'] },
  holdCase:           { to: 'on_hold',             reason: 'on_hold',                    roles: ['room_lead', 'recruitment_admin'] },
  resumeCase:         { to: 'under_review',        reason: 'hold_resumed',               roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => f === 'on_hold' },
  rejectCase:         { to: 'archived',            reason: 'rejected',                   roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  withdrawCase:       { to: 'withdrawn',           reason: 'withdrawn',                  roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  closeCase:          { to: 'closed',              reason: 'case_closed',                roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  reopenCase:         { to: 'under_review',        reason: 'case_reopened',              roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => REOPENABLE.includes(f) },
}));

export const LIFECYCLE_ACTION_NAMES = Object.freeze(Object.keys(LIFECYCLE_ACTIONS));

/** Role ranking, mirroring m17/shared.mjs roomCan. */
const ROLE_RANK = { viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 };
const roleAllows = (role, allowed) => {
  const have = ROLE_RANK[role];
  if (have == null) return false;
  return allowed.some((r) => have >= ROLE_RANK[r]);
};

/**
 * An evidence provider that knows nothing.
 *
 * This is the P2 default and it is deliberately useless: every kind answers
 * "not implemented". A transition that needs durable evidence is therefore
 * REFUSED until the phase that owns that evidence ships and supplies a real
 * provider. The alternative — defaulting to satisfied — would let the
 * lifecycle assert things no record supports, which is precisely what the
 * governing rule forbids.
 */
export const NULL_EVIDENCE_PROVIDER = Object.freeze({
  check: () => ({ satisfied: false, reason: 'not_implemented' }),
});

/**
 * Derived workflow conditions.
 *
 * These are questions about the case that are ANSWERED BY LOOKING, not stored.
 * `decision_pending` and `trial_in_progress` live here rather than in
 * ROOM_STATUSES because storing a derivation creates a second truth that can
 * disagree with the first.
 */
export function derivedConditions(ctx) {
  const { status, hasCurrentDecision = false, activeTrial = false, offerAwaitingResponse = false } = ctx;
  return {
    decisionPending: status === 'trial_completed' && !hasCurrentDecision,
    trialActive: (status === 'trial_scheduled' && activeTrial) || false,
    offerAwaitingResponse: status === 'offer_made' && offerAwaitingResponse,
    onHold: status === 'on_hold',
    terminal: LIFECYCLE_TERMINAL.includes(status),
    reopenable: LIFECYCLE_REOPENABLE.includes(status),
  };
}

/**
 * THE validator. One function, used by every route, the projector's
 * next-action list, and the test suite — so "what may happen next" has exactly
 * one implementation.
 *
 * @returns {{ok: true, to, reason} | {ok: false, error, message, allowed?}}
 */
export function canTransitionRecruitmentCase(kase, action, context = {}) {
  const {
    role = null,
    evidence = NULL_EVIDENCE_PROVIDER,
    reasonCodes = [],
    now = Date.now(),
    // Availability probe: "could this action be taken, given a reason?" as
    // opposed to "is this exact request valid?". `availableActions` asks the
    // first question, because a reason is supplied when the action is
    // performed, not when it is offered. The first version of this passed a
    // literal fake reason code instead, which made the check pass for the
    // wrong reason and put the string 'placeholder' one careless echo away
    // from a response body.
    forAvailability = false,
  } = context;

  const def = LIFECYCLE_ACTIONS[action];
  if (!def) {
    return { ok: false, error: 'LIFECYCLE_ACTION_UNKNOWN', message: `No such recruitment action: ${action}.` };
  }
  if (!kase || !kase.room) {
    return { ok: false, error: 'LIFECYCLE_CASE_NOT_A_ROOM', message: 'This recruitment case has no workspace to move.' };
  }

  const from = kase.room.status;
  if (!ROOM_STATUSES.includes(from)) {
    // Corruption, not a workflow decision — say so rather than guessing.
    return { ok: false, error: 'LIFECYCLE_STATE_UNKNOWN', message: 'The recruitment case is in a state this build does not recognise.' };
  }

  if (!roleAllows(role, def.roles)) {
    return { ok: false, error: 'LIFECYCLE_NOT_PERMITTED', message: 'Your role cannot take this recruitment action.' };
  }

  const allowed = ROOM_TRANSITIONS[from] ?? [];
  if (from === def.to) {
    return { ok: false, error: 'LIFECYCLE_NO_CHANGE', message: 'The case is already in that state.', allowed };
  }
  if (!allowed.includes(def.to)) {
    return {
      ok: false,
      error: 'LIFECYCLE_TRANSITION_INVALID',
      message: `A case at "${from}" cannot move to "${def.to}".`,
      allowed,
    };
  }

  // The edge exists, but this action is not the one that describes it. Three
  // actions reach `under_review`; only one of them is truthful from any given
  // state, and the untruthful ones would write the wrong reason code into a
  // history that nothing ever rewrites.
  if (def.applicableFrom && !def.applicableFrom(from)) {
    return {
      ok: false,
      error: 'LIFECYCLE_ACTION_NOT_APPLICABLE',
      message: `"${action}" does not describe what happens to a case at "${from}".`,
      allowed,
    };
  }

  if (def.reasonCodesRequired && !forAvailability && (!Array.isArray(reasonCodes) || reasonCodes.length === 0)) {
    return { ok: false, error: 'LIFECYCLE_REASON_REQUIRED', message: 'Ending a recruitment case requires a recorded reason.' };
  }

  const pre = LIFECYCLE_PRECONDITIONS[def.to];
  if (pre) {
    const verdict = evidence.check(pre.kind, { kase, action, now }) ?? { satisfied: false, reason: 'no_verdict' };
    if (verdict.satisfied !== true) {
      return {
        ok: false,
        error: 'LIFECYCLE_EVIDENCE_REQUIRED',
        message: `This step needs a record to support it: ${pre.note}.`,
        requires: pre.kind,
        evidenceReason: verdict.reason ?? 'unsatisfied',
      };
    }
  }

  return { ok: true, to: def.to, from, reason: def.reason };
}

/** Which semantic actions are available right now, for this role. */
export function availableActions(kase, context = {}) {
  return LIFECYCLE_ACTION_NAMES.filter(
    (a) => canTransitionRecruitmentCase(kase, a, { ...context, forAvailability: true }).ok,
  );
}

/** Validate a lifecycle reason code. */
export const isLifecycleReason = (code) => REASON_SET.has(code);

/**
 * May this role perform this action AT ALL, ignoring where the case is?
 *
 * Exported for one caller: the idempotent-replay path, which answers before
 * the case is re-validated (the case has already moved, so full validation
 * would refuse the replay of a transition that genuinely happened). A replay
 * is still an action, and someone who could never have performed it must not
 * be told it succeeded.
 */
export function actionPermittedForRole(action, role) {
  const def = LIFECYCLE_ACTIONS[action];
  return !!def && roleAllows(role, def.roles);
}

/**
 * Analytics compatibility (§50).
 *
 * M20 reads `room.history` for `room_status_changed` entries and counts the
 * statuses it finds. No status was renamed or removed by M23, so every
 * historical entry still means exactly what it meant. This function exists for
 * the one thing that DID change shape: callers that want the funnel's view of
 * a status, where two of the new states are deliberately not progress.
 */
export function toAnalyticsRecruitmentStage(status) {
  if (status === 'on_hold' || status === 'offer_declined') return null; // real, but not progress
  return ROOM_STATUSES.includes(status) ? status : null;
}
