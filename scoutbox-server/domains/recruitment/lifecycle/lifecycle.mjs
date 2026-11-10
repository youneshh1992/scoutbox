/**
 * The recruitment lifecycle as semantic actions over one transition table.
 * `case.room.status` is the state; `case.stage` derives from it; the journey is
 * computed on read (journey.mjs). There is no generic stage setter: each action
 * names one real event and carries its own preconditions. Evidence a transition
 * needs (a completed trial, a confirmed joining record) lives in other modules
 * and is checked through an injected provider.
 */

import {
  ROOM_TRANSITIONS, ROOM_STATUSES, TERMINAL_ROOM_STATUSES, STATUS_EVIDENCE_REQUIRED,
  PROHIBITED_REASON_CODES, INITIAL_ROOM_STATUS,
} from '../rooms/shared.mjs';

export const RECRUITMENT_LIFECYCLE_POLICY_VERSION = 1;

/** `on_hold` is not terminal: a hold is a live, paused case and every route out of it stays open. */
export const LIFECYCLE_TERMINAL = Object.freeze([...TERMINAL_ROOM_STATUSES]);
export const LIFECYCLE_REOPENABLE = Object.freeze(['withdrawn', 'archived', 'closed']);
const REOPENABLE = LIFECYCLE_REOPENABLE;

export const LIFECYCLE_INITIAL = INITIAL_ROOM_STATUS;

/**
 * Why a case moved (an event), as opposed to the decision reason codes in
 * rooms/shared.mjs, which say why a club decided something (an opinion).
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
 * Preconditions a target state requires from a durable record elsewhere: a
 * local alias for the one shared table, not exported. A provider that does not
 * know a kind must answer `{ satisfied: false, reason: 'not_implemented' }`.
 */
const LIFECYCLE_PRECONDITIONS = STATUS_EVIDENCE_REQUIRED;

/**
 * `roles` uses the room role vocabulary. No action is performable by a player
 * or guardian: the case moves because their response exists, via a precondition.
 *
 * `applicableFrom` narrows which edges an action may describe. Three actions land
 * on `under_review`; without it each would be offered from a withdrawn case,
 * writing a different reason code for the same move into the history.
 *
 * Null prototype so `{ action: "constructor" }` fails the lookup instead of
 * crashing on `.roles`.
 */
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
  // A hold is a pause, not a rewind: resuming returns to the held-from state
  // when its evidence still stands. `to` is the fallback and the static target.
  resumeCase:         { to: 'under_review',        reason: 'hold_resumed',               roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => f === 'on_hold', resolveTo: resumeTargetFor },
  rejectCase:         { to: 'archived',            reason: 'rejected',                   roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  withdrawCase:       { to: 'withdrawn',           reason: 'withdrawn',                  roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  closeCase:          { to: 'closed',              reason: 'case_closed',                roles: ['room_lead', 'recruitment_admin'], reasonCodesRequired: true },
  reopenCase:         { to: 'under_review',        reason: 'case_reopened',              roles: ['room_lead', 'recruitment_admin'], applicableFrom: (f) => REOPENABLE.includes(f) },
}));

export const LIFECYCLE_ACTION_NAMES = Object.freeze(Object.keys(LIFECYCLE_ACTIONS));

/** The state a held case was held from, per the newest `on_hold` history entry; null if none. */
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
 * Where `resumeCase` goes: the held-from state if it is live and its evidence
 * still stands (asked of the provider, not trusted from history); otherwise
 * `under_review`. The `on_hold` table row names no evidence-bearing state, so
 * only a resume takes a paused case forward.
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

/** The state an action would move this case to: static for every action but `resumeCase`. */
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

/** The default provider: every kind is unsatisfied, so evidence-gated moves need a real provider. */
export const NULL_EVIDENCE_PROVIDER = Object.freeze({
  check: () => ({ satisfied: false, reason: 'not_implemented' }),
});

/**
 * Conditions answered by looking at the case, not stored, so they cannot
 * disagree with the status.
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
 * The one validator, used by routes, the projector's next-action list and tests.
 *
 * @returns {{ok: true, to, reason} | {ok: false, error, message, allowed?}}
 */
export function canTransitionRecruitmentCase(kase, action, context = {}) {
  const {
    role = null,
    evidence = NULL_EVIDENCE_PROVIDER,
    reasonCodes = [],
    now = Date.now(),
    // "Could this be taken, given a reason?": a reason is supplied when the
    // action is performed, not when it is offered.
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
    // resumeCase is its own edge: the `on_hold` row omits the evidence-bearing
    // states it may return to. The target still meets its precondition below.
  const ownEdge = !!def.resolveTo && ROOM_STATUSES.includes(to) && !TERMINAL_ROOM_STATUSES.includes(to);
  if (!allowed.includes(to) && !ownEdge) {
    return {
      ok: false,
      error: 'LIFECYCLE_TRANSITION_INVALID',
      message: `A case at "${from}" cannot move to "${to}".`,
      allowed,
    };
  }

  // The edge exists, but this action does not describe it; the wrong reason
  // code would be written into an append-only history.
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

export const isLifecycleReason = (code) => REASON_SET.has(code);

/** At most this many reasons on one transition — the same ceiling decisions use. */
const MAX_LIFECYCLE_REASONS = 6;

/**
 * Lifecycle reasons say why a case moved; decision codes say what a club
 * concluded about a player. The sets do not overlap. The prohibited set is
 * shared with decisions, and keeps the rooms error code.
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
 * May this role perform this action at all, wherever the case is? Used by the
 * idempotent-replay path: the case has already moved, so full validation would
 * refuse a genuine replay, but someone who could never act must not be told it succeeded.
 */
export function actionPermittedForRole(action, role) {
  const def = LIFECYCLE_ACTIONS[action];
  return !!def && roleAllows(role, def.roles);
}

/** The funnel's view of a status: `on_hold` and `offer_declined` are real states but not progress. */
export function toAnalyticsRecruitmentStage(status) {
  if (status === 'on_hold' || status === 'offer_declined') return null; // real, but not progress
  return ROOM_STATUSES.includes(status) ? status : null;
}
