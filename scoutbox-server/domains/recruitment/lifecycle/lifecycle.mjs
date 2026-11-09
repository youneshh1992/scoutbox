/**
 * The recruitment lifecycle: semantic actions over one transition table.
 *
 * `case.room.status` is the canonical lifecycle state; `case.stage` is a pure
 * derivation of it (status → stage, never stage → status); `case.history` is
 * the append-only record of how it got there. There is no stored "journey" —
 * the journey is a projection (journey.mjs), computed on read.
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
 * records belong to other modules, so the preconditions are declared here and
 * RESOLVED THROUGH AN INJECTED PROVIDER. A provider without the evidence
 * answers "no such evidence" and the transition is refused — never a
 * placeholder trial or offer.
 */

import {
  ROOM_TRANSITIONS, ROOM_STATUSES, TERMINAL_ROOM_STATUSES, STATUS_EVIDENCE_REQUIRED,
  PROHIBITED_REASON_CODES, INITIAL_ROOM_STATUS,
} from '../rooms/shared.mjs';

export const RECRUITMENT_LIFECYCLE_POLICY_VERSION = 1;

/**
 * States that end the case. `on_hold` is NOT among them: a hold is a live case
 * with a reason and possibly a date, and every ordinary route out of it stays
 * open. Treating a pause as an ending is how paused work disappears.
 */
export const LIFECYCLE_TERMINAL = Object.freeze([...TERMINAL_ROOM_STATUSES]);
export const LIFECYCLE_REOPENABLE = Object.freeze(['withdrawn', 'archived', 'closed']);
const REOPENABLE = LIFECYCLE_REOPENABLE;

/**
 * The initial state of a newly opened case. An ALIAS, not a second
 * declaration: the rooms module owns the status set, so it owns where a room
 * starts.
 */
export const LIFECYCLE_INITIAL = INITIAL_ROOM_STATUS;

/**
 * Structured reason codes for lifecycle movement.
 *
 * Deliberately NOT prose: a reason a machine cannot group is a reason nobody
 * can report on. These describe WHY THE CASE MOVED. They are separate from
 * the 20 decision reason codes (rooms/shared.mjs), which describe why a club
 * DECIDED something — a decision is an opinion, a transition is an event.
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
 * ONE TABLE, and this is a local name for it — not a copy and not an export.
 * Two tables would give two answers to one question (a route consulting the
 * other one would walk `offer_made` → `signed` past the requirement). It is
 * deliberately NOT exported, so it never reads as a second precondition
 * table; callers import `STATUS_EVIDENCE_REQUIRED` by its real name.
 *
 * `kind` is resolved by the evidence provider. A provider that does not know a
 * kind must answer `{ satisfied: false, reason: 'not_implemented' }` — never
 * `true`, and never by inventing a row.
 */
const LIFECYCLE_PRECONDITIONS = STATUS_EVIDENCE_REQUIRED;

/**
 * Semantic actions. Each names one real event and maps to exactly one state.
 *
 * `roles` lists who may perform it, using the room role vocabulary. There is
 * no action here performable by a player or a guardian: a player responds to
 * their own contact, trial or offer, and the case moves BECAUSE that response
 * exists — through the precondition, never by the player addressing the case.
 *
 * `applicableFrom` narrows WHICH of the transition table's edges an action may
 * traverse. Three actions land on `under_review`; without this they would
 * all be offered from a withdrawn case at once — three names for one move, each
 * writing a different reason code into the history. "Resumed from hold" on a
 * case that was never on hold is a false record, and an analytics consumer
 * counting `case_reopened` would undercount every reopen taken under another
 * name. The transition table is unchanged; only the action that may describe
 * a given edge narrows, so the recorded reason matches the event.
 */
// NULL PROTOTYPE, deliberately. A plain object literal answers truthy for
// `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__`, so a
// client posting `{ action: "constructor" }` would pass the
// `!LIFECYCLE_ACTIONS[action]` guard and crash reading `.roles` — a 500 from
// one word of request body. With no prototype, an undefined key is `undefined`.
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
  // A hold is a pause, not a rewind. Resuming returns the
  // case to the state it was held FROM — a live Offer stays "Offer made", an
  // accepted Offer stays "Offer accepted" and the signing can continue — when
  // that state's own evidence still stands. `to` is the fallback (a case with
  // no hold on its history, or whose held-from evidence is gone) and the
  // static target the vocabulary and the legacy route's role parity read.
  resumeCase:         { to: 'under_review',        reason: 'hold_resumed',               roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => f === 'on_hold', resolveTo: resumeTargetFor },
  rejectCase:         { to: 'archived',            reason: 'rejected',                   roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  withdrawCase:       { to: 'withdrawn',           reason: 'withdrawn',                  roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  closeCase:          { to: 'closed',              reason: 'case_closed',                roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  reopenCase:         { to: 'under_review',        reason: 'case_reopened',              roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => REOPENABLE.includes(f) },
}));

export const LIFECYCLE_ACTION_NAMES = Object.freeze(Object.keys(LIFECYCLE_ACTIONS));

/**
 * The state a held case was held FROM: the newest `on_hold` entry on its
 * append-only history names it. Null when the history carries no hold (a case
 * planted at on_hold).
 */
export function heldFromStatus(kase) {
  const h = Array.isArray(kase?.history) ? kase.history : [];
  for (let i = h.length - 1; i >= 0; i -= 1) {
    const e = h[i];
    if (!e || e.action !== 'room_status_changed' || e.detail?.to !== 'on_hold') continue;
    const from = e.detail?.from;
    return typeof from === 'string' ? from : null;
  }
  return null;
}

/**
 * Where `resumeCase` takes a case: the held-from state when it is a
 * live state whose evidence (if the state needs any) still stands; otherwise
 * the fallback `under_review`. The resume is its own edge — the `on_hold`
 * table row names no evidence-bearing state on purpose, so nothing but a
 * resume takes a paused case forward. Evidence is asked of the ONE provider
 * exactly as a forward move would ask it — nothing here trusts the history's
 * word that the state was earned.
 */
function resumeTargetFor(kase, { evidence = NULL_EVIDENCE_PROVIDER, now = Date.now() } = {}) {
  const fallback = 'under_review';
  const from = heldFromStatus(kase);
  if (!from || from === 'on_hold' || !ROOM_STATUSES.includes(from) || TERMINAL_ROOM_STATUSES.includes(from)) return fallback;
  const pre = LIFECYCLE_PRECONDITIONS[from];
  if (pre) {
    const verdict = evidence.check(pre.kind, { kase, action: 'resumeCase', now }) ?? { satisfied: false };
    if (verdict.satisfied !== true) return fallback;
  }
  return from;
}

/** The state an action would move THIS case to — static for every action but `resumeCase`. */
export function lifecycleTargetFor(kase, action, context = {}) {
  const def = LIFECYCLE_ACTIONS[action];
  if (!def) return null;
  return def.resolveTo ? def.resolveTo(kase, context) : def.to;
}

/** Role ranking, matching roomCan in rooms/shared.mjs. */
const ROLE_RANK = { viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 };
const roleAllows = (role, allowed) => {
  const have = ROLE_RANK[role];
  if (have == null) return false;
  return allowed.some((r) => have >= ROLE_RANK[r]);
};

/**
 * An evidence provider that knows nothing: the default, and deliberately
 * useless. Every kind answers "not implemented", so a transition that needs
 * durable evidence is REFUSED unless a real provider is supplied. Defaulting
 * to satisfied would let the lifecycle assert things no record supports.
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
    // performed, not when it is offered. A flag rather than a fake reason
    // code, so no placeholder reason can leak into a response body.
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

  const to = def.resolveTo ? def.resolveTo(kase, { evidence, now }) : def.to;
  const allowed = ROOM_TRANSITIONS[from] ?? [];
  if (from === to) {
    return { ok: false, error: 'LIFECYCLE_NO_CHANGE', message: 'The case is already in that state.', allowed };
  }
  // A resolving action (resumeCase) is its own edge: the table keeps the
  // evidence-bearing states OUT of the `on_hold` row on purpose, so that
  // nothing but a resume takes a paused case back into one. The target is
  // still a live, known state and still meets its precondition below.
  const ownEdge = !!def.resolveTo && ROOM_STATUSES.includes(to) && !TERMINAL_ROOM_STATUSES.includes(to);
  if (!allowed.includes(to) && !ownEdge) {
    return {
      ok: false,
      error: 'LIFECYCLE_TRANSITION_INVALID',
      message: `A case at "${from}" cannot move to "${to}".`,
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

  const pre = LIFECYCLE_PRECONDITIONS[to];
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

  return { ok: true, to, from, reason: def.reason };
}

/** Which semantic actions are available right now, for this role. */
export function availableActions(kase, context = {}) {
  return LIFECYCLE_ACTION_NAMES.filter(
    (a) => canTransitionRecruitmentCase(kase, a, { ...context, forAvailability: true }).ok,
  );
}

/** Validate a lifecycle reason code. */
export const isLifecycleReason = (code) => REASON_SET.has(code);

/** At most this many reasons on one transition — the same ceiling decisions use. */
const MAX_LIFECYCLE_REASONS = 6;

/**
 * Validate the reason codes on a lifecycle transition.
 *
 * WHY THIS EXISTS RATHER THAN REUSING THE DECISION VALIDATOR
 *
 * There are two reason taxonomies and they describe different things. The 20
 * decision codes say why a club DECIDED something — an opinion about a player.
 * `LIFECYCLE_REASON_CODES` say why a case MOVED — an event in a process. The
 * two sets do not overlap by a single code, and recording a judgement about
 * the player as the reason a case closed would be a category error written
 * into an append-only history.
 *
 * The PROHIBITED set is shared deliberately and keeps the rooms error code. A
 * protected characteristic can never be recorded as a reason for anything, and
 * that rule must not have two implementations that can drift.
 */
export function validateLifecycleReasons(codes) {
  if (!Array.isArray(codes)) {
    return { ok: false, error: 'LIFECYCLE_REASONS_INVALID', message: 'Reasons must be a list of lifecycle reason codes.' };
  }
  if (codes.some((c) => c != null && typeof c !== 'string')) {
    return { ok: false, error: 'LIFECYCLE_REASONS_INVALID', message: 'Each reason must be a reason code, given as text.' };
  }
  const clean = [...new Set(codes.map((c) => (c ?? '').trim().toLowerCase()).filter(Boolean))];
  if (clean.length > MAX_LIFECYCLE_REASONS) {
    return { ok: false, error: 'LIFECYCLE_REASONS_TOO_MANY', message: `Record up to ${MAX_LIFECYCLE_REASONS} reasons.` };
  }
  const prohibited = clean.filter((c) => PROHIBITED_REASON_CODES.includes(c));
  if (prohibited.length) {
    return {
      ok: false,
      error: 'ROOM_REASON_PROHIBITED',
      message: 'A protected characteristic can never be recorded as a recruitment reason.',
      prohibited,
    };
  }
  const unknown = clean.filter((c) => !REASON_SET.has(c));
  if (unknown.length) {
    return {
      ok: false,
      error: 'LIFECYCLE_REASON_UNKNOWN',
      message: 'Reasons must come from the recruitment LIFECYCLE taxonomy, which describes why a case moved — not from the decision taxonomy, which describes what a club concluded about a player.',
      unknown,
      allowed: LIFECYCLE_REASON_CODES,
    };
  }
  return { ok: true, codes: clean };
}

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
 * The funnel's view of a status. Analytics counts `room_status_changed`
 * entries in `room.history`; `on_hold` and `offer_declined` are real states
 * but deliberately not progress.
 */
export function toAnalyticsRecruitmentStage(status) {
  if (status === 'on_hold' || status === 'offer_declined') return null; // real, but not progress
  return ROOM_STATUSES.includes(status) ? status : null;
}
