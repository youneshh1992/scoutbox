// Recruitment Rooms: the pure engine. A Room is a facet of a recruitment case, not a second pipeline:
// `room.status` is the status and `case.stage` is derived from it by `stageForRoomStatus`.

// ---------------------------------------------------------------- statuses

// Tables indexed by client or stored values have a null prototype, so a key like "constructor" or
// "__proto__" answers undefined instead of slipping past `if (!TABLE[key])` guards.
const table = (o) => Object.freeze(Object.assign(Object.create(null), o));

// Every status maps onto exactly one case stage.
export const ROOM_STATUSES = [
  'watching',
  'under_review',
  'contact_planned', // agreed to approach; nobody has yet
  'contacted', // approach delivered; awaiting a response
  'shortlisted',
  'priority',
  'trial_requested',
  'trial_scheduled',
  'trial_completed',
  'offer_consideration',
  'offer_made',
  'offer_accepted', // accepted in ScoutBox; not a signing
  'offer_declined', // the player declined; distinct from the club withdrawing
  'signed',
  'on_hold', // paused deliberately, still live
  'withdrawn',
  'archived',
  'closed',
];

export const ROOM_STATUS_LABELS = table({
  watching: 'Watching',
  under_review: 'Under review',
  contact_planned: 'Contact planned',
  contacted: 'Contacted',
  shortlisted: 'Shortlisted',
  priority: 'Priority',
  trial_requested: 'Trial requested',
  trial_scheduled: 'Trial scheduled',
  trial_completed: 'Trial completed',
  offer_consideration: 'Offer consideration',
  offer_made: 'Offer made',
  // Must not imply a playing contract, a registration or a completed transfer.
  offer_accepted: 'Accepted in ScoutBox',
  offer_declined: 'Offer declined by player',
  signed: 'Signed',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
  closed: 'Closed',
});

// `superseded` is not a room status: the append-only decision memory models superseded decisions.

export const TERMINAL_ROOM_STATUSES = ['signed', 'withdrawn', 'archived', 'closed'];

export const INITIAL_ROOM_STATUS = 'watching';

export const OPEN_ROOM_STATUSES = ROOM_STATUSES.filter((s) => !TERMINAL_ROOM_STATUSES.includes(s));

// Must equal PRO_STAGES / GRASSROOTS_STAGES in domains/scouting/scouting.mjs.
export const PRO_STAGES = ['identified', 'review', 'observation', 'trial', 'decision', 'closed'];
export const GRASSROOTS_STAGES = ['review', 'invited', 'awaiting_response', 'decision', 'closed'];
export const CASE_STAGES = [...new Set([...PRO_STAGES, ...GRASSROOTS_STAGES])];
/** The case's own priority (the Room keeps ROOM_PRIORITIES), sign-off outcomes and approval states. */
export const CASE_PRIORITIES = ['high', 'medium', 'low'];
export const CASE_DECISION_OUTCOMES = ['sign', 'pass', 'monitor'];
export const CASE_APPROVAL_STATES = ['pending', 'approved', 'rejected'];

const STAGE_MAP = table({
  pro: table({
    watching: 'identified',
    under_review: 'review',
    contact_planned: 'review',
    contacted: 'review',
    shortlisted: 'observation',
    priority: 'observation',
    trial_requested: 'trial',
    trial_scheduled: 'trial',
    trial_completed: 'trial',
    offer_consideration: 'decision',
    offer_made: 'decision',
    offer_accepted: 'decision',
    offer_declined: 'decision',
    signed: 'closed',
    // A hold is live; resuming it means review.
    on_hold: 'review',
    withdrawn: 'closed',
    archived: 'closed',
    closed: 'closed',
  }),
  grassroots: table({
    watching: 'review',
    under_review: 'review',
    contact_planned: 'review',
    contacted: 'awaiting_response',
    shortlisted: 'review',
    priority: 'review',
    trial_requested: 'invited',
    trial_scheduled: 'invited',
    trial_completed: 'awaiting_response',
    offer_consideration: 'decision',
    offer_made: 'decision',
    offer_accepted: 'decision',
    offer_declined: 'decision',
    signed: 'closed',
    on_hold: 'review',
    withdrawn: 'closed',
    archived: 'closed',
    closed: 'closed',
  }),
});

export const orgStageKind = (orgLevel) => (orgLevel === 'grassroots' ? 'grassroots' : 'pro');

export function stageForRoomStatus(status, orgLevel) {
  return STAGE_MAP[orgStageKind(orgLevel)][status] ?? null;
}

// The inverse of a lossy projection (`decision` covers four statuses), so it is only used to choose where a
// new Room adopting a case starts, never to move an existing room.
const CANONICAL_STATUS_FOR_STAGE = table({
  identified: 'watching',
  review: 'under_review',
  observation: 'shortlisted',
  trial: 'trial_requested',
  invited: 'trial_requested',
  awaiting_response: 'trial_completed',
  decision: 'offer_consideration',
  closed: 'archived',
});

export function roomStatusForStage(stage, orgLevel) {
  const stages = STAGE_MAP[orgStageKind(orgLevel)];
  const canonical = CANONICAL_STATUS_FOR_STAGE[stage];
  return canonical && stages[canonical] === stage ? canonical : null;
}

// ------------------------------------------------------------- transitions

// Anything not listed is refused.
export const ROOM_TRANSITIONS = table({
  watching: ['under_review', 'shortlisted', 'contact_planned', 'on_hold', 'withdrawn', 'archived'],
  under_review: [
    'watching',
    'shortlisted',
    'priority',
    'contact_planned',
    'trial_requested',
    'on_hold',
    'withdrawn',
    'archived',
  ],
  contact_planned: ['contacted', 'under_review', 'shortlisted', 'priority', 'on_hold', 'withdrawn', 'archived'],
  contacted: [
    'shortlisted',
    'priority',
    'trial_requested',
    'offer_consideration',
    'under_review',
    'on_hold',
    'withdrawn',
    'archived',
  ],
  shortlisted: [
    'under_review',
    'priority',
    'contact_planned',
    'trial_requested',
    'offer_consideration',
    'on_hold',
    'withdrawn',
    'archived',
  ],
  priority: [
    'shortlisted',
    'contact_planned',
    'trial_requested',
    'offer_consideration',
    'on_hold',
    'withdrawn',
    'archived',
  ],
  trial_requested: ['trial_scheduled', 'shortlisted', 'priority', 'on_hold', 'withdrawn', 'archived'],
  trial_scheduled: ['trial_completed', 'trial_requested', 'on_hold', 'withdrawn', 'archived'],
  trial_completed: ['offer_consideration', 'shortlisted', 'priority', 'on_hold', 'withdrawn', 'archived'],
  offer_consideration: ['offer_made', 'shortlisted', 'priority', 'on_hold', 'withdrawn', 'archived'],
  // `offer_accepted` is the player saying yes in ScoutBox; `signed` needs confirmed joining evidence (see
  // STATUS_EVIDENCE_REQUIRED). `offer_made → signed` stays for a signing concluded outside ScoutBox.
  offer_made: ['offer_accepted', 'offer_declined', 'signed', 'offer_consideration', 'on_hold', 'withdrawn', 'archived'],
  // Reachable only by the recipient's own act.
  offer_accepted: ['signed', 'on_hold', 'withdrawn', 'archived', 'closed'],
  // Distinct from the club withdrawing, so the decision is attributed correctly.
  offer_declined: ['under_review', 'shortlisted', 'priority', 'on_hold', 'withdrawn', 'archived', 'closed'],
  signed: ['closed'],
  // `resumeCase` is the only way back to the held-from state. This row names none of the states a
  // recipient's answer reaches, so nothing else takes a paused case out of the hold.
  on_hold: [
    'under_review',
    'shortlisted',
    'priority',
    'contact_planned',
    'trial_requested',
    'offer_consideration',
    'withdrawn',
    'archived',
    'closed',
  ],
  withdrawn: ['under_review', 'archived', 'closed'],
  archived: ['under_review', 'closed'],
  closed: ['under_review'],
});

// Keyed by target status and returned by `validateTransition`, which every status path calls, including the
// legacy status route that takes a client string, so no edge into these statuses can skip its evidence.
// A caller with no evidence provider must fail closed.
export const STATUS_EVIDENCE_REQUIRED = table({
  contacted: { kind: 'contact_delivered', note: 'a contact must have been delivered or recorded' },
  trial_requested: {
    kind: 'trial_invited',
    note: 'a trial invitation must have been sent to the player or their guardian',
  },
  trial_scheduled: {
    kind: 'trial_confirmed',
    note: 'a trial schedule must have been confirmed with at least one concrete session',
  },
  trial_completed: { kind: 'trial_completed', note: 'a trial must have been completed' },
  // A draft, advisory or superseded decision proves nothing.
  offer_consideration: {
    kind: 'decision_progress',
    note: 'a finalized recruitment decision to progress must exist for this case',
  },
  offer_made: { kind: 'offer_sent', note: 'an offer must have been sent' },
  offer_accepted: { kind: 'offer_accepted_by_recipient', note: 'the recipient must have accepted their own offer' },
  offer_declined: { kind: 'offer_declined_by_recipient', note: 'the recipient must have declined their own offer' },
  signed: { kind: 'confirmed_join', note: 'a confirmed joining or registration record must exist' },
});

// Room creation runs no transition table or evidence gate, so an adopted stage that maps onto an
// evidence-bearing status (grassroots `awaiting_response` → `trial_completed`) starts at `under_review`
// instead. The original stage is kept in the creation activity.
export function adoptionStatusForStage(stage, orgLevel) {
  const mapped = roomStatusForStage(stage, orgLevel);
  if (!mapped) return 'watching';
  return STATUS_EVIDENCE_REQUIRED[mapped] ? 'under_review' : mapped;
}

export const REASON_REQUIRED_STATUSES = ['withdrawn', 'archived', 'closed'];

export const REOPENED_FROM = ['withdrawn', 'archived', 'closed'];

// Statuses at which the evidence confidence the club could see is snapshotted, to answer "what did they
// see at the time?".
export const SNAPSHOT_STATUSES = [
  'shortlisted',
  'priority',
  'trial_requested',
  'offer_consideration',
  'offer_made',
  'signed',
  'withdrawn',
  'archived',
  'closed',
];

export const canTransition = (from, to) => (ROOM_TRANSITIONS[from] ?? []).includes(to);

export function validateTransition(from, to, { reasonCodes = [] } = {}) {
  if (!ROOM_STATUSES.includes(to)) {
    return { ok: false, error: 'ROOM_STATUS_UNKNOWN', message: `"${to}" is not a Recruitment Room status.` };
  }
  if (from === to) {
    return { ok: false, error: 'ROOM_STATUS_UNCHANGED', message: `This room is already ${ROOM_STATUS_LABELS[to]}.` };
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: 'ROOM_TRANSITION_INVALID',
      message: `A room cannot move from ${ROOM_STATUS_LABELS[from]} to ${ROOM_STATUS_LABELS[to]}.`,
      allowed: ROOM_TRANSITIONS[from] ?? [],
    };
  }
  const needsReason = REASON_REQUIRED_STATUSES.includes(to);
  if (needsReason && reasonCodes.length === 0) {
    return {
      ok: false,
      error: 'ROOM_REASON_REQUIRED',
      message: `Recording why keeps the decision useful later — ${ROOM_STATUS_LABELS[to]} needs at least one reason.`,
    };
  }
  return {
    ok: true,
    reopen: REOPENED_FROM.includes(from) && !REOPENED_FROM.includes(to),
    needsReason,
    snapshot: SNAPSHOT_STATUSES.includes(to),
    requiresEvidence: STATUS_EVIDENCE_REQUIRED[to]?.kind ?? null,
  };
}

// -------------------------------------------------------- reason taxonomy

// Only the code is machine-readable, so later analysis never has to read anybody's free text.
export const REASON_CODES = {
  football: ['technical_fit', 'tactical_fit', 'physical_profile', 'position_need', 'development_upside'],
  evidence: ['insufficient_full_match', 'insufficient_recent_evidence', 'reference_missing', 'combine_missing'],
  process: ['budget', 'squad_space', 'timing', 'registration', 'travel_logistics', 'eligibility'],
  outcome: ['trial_needed', 'continue_monitoring', 'not_current_priority', 'trial_outcome', 'player_unavailable'],
};

export const ALL_REASON_CODES = Object.values(REASON_CODES).flat();

export const reasonCategory = (code) =>
  Object.keys(REASON_CODES).find((cat) => REASON_CODES[cat].includes(code)) ?? null;

// Refused with their own error code so an audit cannot mistake the refusal for a typo. A club may still
// decline a player; it may not record a protected trait as the reason.
export const PROHIBITED_REASON_CODES = [
  'race',
  'ethnicity',
  'skin_colour',
  'skin_color',
  'nationality',
  'nationality_preference',
  'national_origin',
  'immigration_status',
  'religion',
  'faith',
  'caste',
  'disability',
  'medical_condition',
  'mental_health',
  'gender',
  'sex',
  'sexuality',
  'sexual_orientation',
  'gender_identity',
  'socioeconomic',
  'social_background',
  'family_income',
  'postcode',
  'accent',
  'pregnancy',
  'marital_status',
  'political_opinion',
  'union_membership',
];

// Evidence-shaped reasons: an archived room may be worth a second look when the missing evidence arrives.
export const REVISITABLE_REASON_CODES = [...REASON_CODES.evidence, 'trial_needed', 'continue_monitoring'];

export function validateReasonCodes(codes) {
  if (!Array.isArray(codes)) {
    return { ok: false, error: 'ROOM_REASONS_INVALID', message: 'Reasons must be a list of reason codes.' };
  }
  // `String(value)` would call a body value's own `toString` and can throw, so non-strings are refused.
  if (codes.some((c) => c != null && typeof c !== 'string')) {
    return { ok: false, error: 'ROOM_REASONS_INVALID', message: 'Each reason must be a reason code, given as text.' };
  }
  const clean = [...new Set(codes.map((c) => (c ?? '').trim().toLowerCase()).filter(Boolean))];
  if (clean.length > 6) {
    return { ok: false, error: 'ROOM_REASONS_TOO_MANY', message: 'Record up to six reasons.' };
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
  const unknown = clean.filter((c) => !ALL_REASON_CODES.includes(c));
  if (unknown.length) {
    return {
      ok: false,
      error: 'ROOM_REASON_UNKNOWN',
      message: 'Reasons must come from the ScoutBox recruitment reason taxonomy.',
      unknown,
    };
  }
  return { ok: true, codes: clean };
}

// ---------------------------------------------------------- recommendations

export const RECOMMENDATIONS = [
  'no_decision',
  'continue_watching',
  'shortlist',
  'priority',
  'trial',
  'offer',
  'archive',
];

export function validateDecision({ recommendation, reasonCodes = [], note = null } = {}) {
  if (!RECOMMENDATIONS.includes(recommendation)) {
    return {
      ok: false,
      error: 'ROOM_RECOMMENDATION_UNKNOWN',
      message: 'That is not a ScoutBox recruitment recommendation.',
    };
  }
  const reasons = validateReasonCodes(reasonCodes);
  if (!reasons.ok) return reasons;
  if (recommendation === 'archive' && reasons.codes.length === 0) {
    return {
      ok: false,
      error: 'ROOM_REASON_REQUIRED',
      message: 'Archiving needs at least one reason so the decision stays useful later.',
    };
  }
  if (note != null && typeof note !== 'string') {
    return { ok: false, error: 'FIELD_INVALID', field: 'note', problem: 'not_text', message: 'note must be text.' };
  }
  if (note != null && note.length > 2000) {
    return { ok: false, error: 'ROOM_NOTE_TOO_LONG', message: 'Keep the internal note under 2000 characters.' };
  }
  return { ok: true, recommendation, codes: reasons.codes, note: note ?? null };
}

// --------------------------------------------------------------- readiness

// Workflow completeness, not a score or a recommendation: each item is a fact a human could check.
export function decisionReadiness({
  assessmentsAssigned = 0,
  assessmentsSubmitted = 0,
  recentFullMatch = false,
  coachReference = false,
  combineVerified = 0,
  combineRequested = 0,
  trialState = 'none',
  openTasks = 0,
  openEvidenceRequests = 0,
} = {}) {
  const items = [
    {
      key: 'assessments',
      label: 'Assessments',
      value: `${assessmentsSubmitted}/${assessmentsAssigned} submitted`,
      complete: assessmentsAssigned > 0 && assessmentsSubmitted >= assessmentsAssigned,
      outstanding:
        assessmentsAssigned === 0
          ? 'None assigned yet'
          : assessmentsSubmitted < assessmentsAssigned
            ? 'Awaiting submissions'
            : null,
    },
    {
      key: 'recent_full_match',
      label: 'Recent full match',
      value: recentFullMatch ? 'Available' : 'Not available',
      complete: recentFullMatch,
      outstanding: recentFullMatch ? null : 'No recent full-match evidence on record',
    },
    {
      key: 'coach_reference',
      label: 'Coach reference',
      value: coachReference ? 'Available' : 'Not available',
      complete: coachReference,
      outstanding: coachReference ? null : 'No verified coach reference on record',
    },
    {
      key: 'combine',
      label: 'Combine',
      value:
        combineVerified > 0 ? `${combineVerified} verified` : combineRequested > 0 ? 'Requested' : 'No verified result',
      complete: combineVerified > 0,
      outstanding:
        combineVerified > 0
          ? null
          : combineRequested > 0
            ? 'Requested, not yet completed'
            : 'No production-supported Combine Verified result is currently available',
    },
    {
      key: 'trial',
      label: 'Trial',
      value:
        {
          none: 'Not required yet',
          requested: 'Requested',
          scheduled: 'Scheduled',
          awaiting_report: 'Awaiting report',
          reported: 'Reported',
        }[trialState] ?? 'Not required yet',
      complete: trialState === 'reported',
      outstanding: ['requested', 'scheduled', 'awaiting_report'].includes(trialState) ? 'Trial in progress' : null,
    },
    {
      key: 'open_tasks',
      label: 'Open tasks',
      value: String(openTasks),
      complete: openTasks === 0,
      outstanding: openTasks > 0 ? `${openTasks} open` : null,
    },
  ];
  return {
    items,
    // Counts, never a percentage or score.
    complete: items.filter((i) => i.complete).length,
    total: items.length,
    blockers: items.filter((i) => i.outstanding).map((i) => ({ key: i.key, text: i.outstanding })),
    openEvidenceRequests,
    note: 'Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.',
  };
}

// A word, never a number: a second numeric score next to the Trust Score would read as a player rating.
export const ROOM_HEALTH = [
  'decision_recorded',
  'trial_pending',
  'assessment_outstanding',
  'waiting_on_evidence',
  'ready_for_review',
];

export const ROOM_HEALTH_LABELS = {
  decision_recorded: 'Decision recorded',
  trial_pending: 'Trial pending',
  assessment_outstanding: 'Assessment outstanding',
  waiting_on_evidence: 'Waiting on evidence',
  ready_for_review: 'Ready for review',
};

export function roomHealth({ readiness, hasCurrentDecision = false, status = 'watching' } = {}) {
  if (hasCurrentDecision && ['signed', 'archived', 'closed', 'withdrawn'].includes(status)) return 'decision_recorded';
  const blocked = new Set((readiness?.blockers ?? []).map((b) => b.key));
  if (blocked.has('trial')) return 'trial_pending';
  if (blocked.has('assessments')) return 'assessment_outstanding';
  if (blocked.has('recent_full_match') || blocked.has('coach_reference') || blocked.has('combine'))
    return 'waiting_on_evidence';
  return 'ready_for_review';
}

// ------------------------------------------------------------- permissions

// Room roles on top of the existing org permissions: `isLead` (domains/platform/routeHelpers.mjs) and case
// restriction.
export function roomRole({ room, user, isLead }) {
  if (!room || !user) return null;
  if (isLead) return 'recruitment_admin';
  if (room.ownerUserId === user.id || room.room?.leadScoutUserId === user.id) return 'room_lead';
  const assigned = (room.assignments ?? []).some((a) => a.userId === user.id);
  if (room.restricted && !assigned) return null;
  // A filed-away room's discussion is read-only except to a room lead or recruitment admin.
  if (TERMINAL_ROOM_STATUSES.includes(room.room?.status)) return 'viewer';
  // ScoutBox has no read-only staff tier, so other recruitment staff contribute to an open room.
  return 'contributor';
}

const ROOM_ROLE_RANK = { viewer: 0, contributor: 1, room_lead: 2, recruitment_admin: 3 };

export const roomCan = (role, action) => {
  const rank = ROOM_ROLE_RANK[role];
  if (rank == null) return false;
  const need = {
    read: 0,
    comment: 1,
    complete_own_task: 1,
    create_task: 1,
    assign: 2,
    set_status: 2,
    record_decision: 2,
    request_evidence: 2,
    request_combine: 2,
    request_trial: 2,
    reassign_owner: 2,
    archive: 2,
    reopen: 2,
    // Reading history is open to any reader; outward-facing acts sit with the room lead.
    contact_view: 0,
    contact_write: 2,
    // `request_trial` above is what the invitation route checks.
    trial_view: 0,
    trial_assess: 1,
    trial_write: 2,
    // A scout contributes assessments and discussion, not the decision.
    decision_view: 0,
    decision_draft: 2,
    decision_finalize: 2,
    // The internal offer note is a club note, so any reader may see it.
    offer_view: 0,
    offer_draft: 2,
    offer_issue: 2,
    manage_any_room: 3,
  }[action];
  return need != null && rank >= need;
};

// ----------------------------------------------------------- source context

/** Where a room came from: workflow provenance only. */
export const SOURCE_CONTEXTS = [
  'search',
  'watchlist',
  'shortlist',
  'opportunity',
  'recommendation',
  'campaign',
  'passport',
  // Kept distinct so the funnel can tell a reactivation from an organic discovery. Never shown to the player.
  'nobody_missed',
  'second_look',
  // Kept distinct so the funnel can tell a saved-criteria origin from a one-off query.
  'matching',
  'dynamic_watchlist',
  'direct',
];

export const normaliseSourceContext = (v) => (SOURCE_CONTEXTS.includes(v) ? v : 'direct');

// ------------------------------------------------------------------- tasks

export const TASK_STATES = ['open', 'in_progress', 'done', 'cancelled'];
export const TASK_TRANSITIONS = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['done', 'cancelled', 'open'],
  done: ['open'],
  cancelled: ['open'],
};
export const canTaskTransition = (from, to) => (TASK_TRANSITIONS[from] ?? []).includes(to);

export const LINKED_RESOURCE_TYPES = [
  'evidence',
  'assessment',
  'combine_request',
  'trial',
  'box_cam_assignment',
  'evidence_request',
  'comment',
];

// ------------------------------------------------------------ evidence state

export const EVIDENCE_REVIEW_STATES = ['not_reviewed', 'reviewing', 'reviewed', 'needs_follow_up'];

// --------------------------------------------------------------- priorities

export const ROOM_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export const ROOM_PRIORITY_NOTE =
  'Internal workflow urgency for your organisation. It is not a judgement of the player and is never shown to them.';

// -------------------------------------------------------------- activity

export const ROOM_EVENT_TYPES = [
  'room_created',
  'room_status_changed',
  'room_reopened',
  'room_owner_changed',
  'room_member_assigned',
  'room_task_created',
  'room_task_updated',
  'room_comment_added',
  'room_comment_edited',
  'room_comment_deleted',
  'room_assessment_assigned',
  'room_evidence_reviewed',
  'room_evidence_requested',
  'room_combine_requested',
  'room_trial_linked',
  'room_signing_linked',
  'room_decision_recorded',
  'room_tag_changed',
  'room_priority_changed',
];

// The numeric suffix of the event id breaks timestamp ties, so events written in the same millisecond keep
// their order between reads.
export function roomActivity(history = [], { limit = 50, cursor = null } = {}) {
  const seq = (id) => {
    const n = Number(
      String(id ?? '')
        .split('-')
        .pop(),
    );
    return Number.isFinite(n) ? n : 0;
  };
  const rows = history
    .map((h) => ({
      id: h.id,
      at: h.at,
      type: ROOM_EVENT_TYPES.includes(h.action) ? h.action : `case_${h.action}`,
      actor: h.byId ? { kind: h.byKind, id: h.byId, name: h.byName } : null,
      detail: h.detail ?? null,
    }))
    .sort((a, b) => b.at - a.at || seq(b.id) - seq(a.id));
  const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < rows.length ? (page[page.length - 1]?.id ?? null) : null,
    total: rows.length,
  };
}

// ------------------------------------------------------------- snapshots

// Records what evidence confidence the club could see, plus references to explain the decision later. It
// does not freeze the Passport: a frozen copy of restricted player data would bypass later access checks.
export function buildRoomSnapshot({ trustSnapshot = null, sourceRefs = {}, trigger, at = Date.now() }) {
  return {
    at,
    trigger,
    trust: trustSnapshot
      ? {
          score: trustSnapshot.score,
          band: trustSnapshot.band,
          policyVersion: trustSnapshot.policyVersion,
          // Levels only: the per-component coverage that safeTrustProjection withholds never enters the store.
          componentLevels: Object.fromEntries(
            Object.entries(trustSnapshot.components ?? {}).map(([k, c]) => [k, c.level]),
          ),
          hash: trustSnapshot.hash,
        }
      : null,
    sourceRefs: {
      passportVersion: sourceRefs.passportVersion ?? null,
      // passportVersion is the projection schema version and never moves; the revision tracks content.
      passportRevision: sourceRefs.passportRevision ?? null,
      evidenceIds: (sourceRefs.evidenceIds ?? []).slice(0, 40),
      assessmentIds: (sourceRefs.assessmentIds ?? []).slice(0, 20),
      combineResults: (sourceRefs.combineResults ?? []).slice(0, 20),
      trialIds: (sourceRefs.trialIds ?? []).slice(0, 10),
    },
    note: 'Evidence confidence at the time of the decision. It is not a record of the player’s ability.',
  };
}

// ------------------------------------------------------- safe projections

export const ROOM_TRUST_NOTE = 'Evidence confidence — not football ability.';
export const ROOM_DEV_NOTE =
  'Box Cam activity shows verified training evidence. It does not independently establish football ability.';
export const ROOM_PRIVACY_NOTE =
  'This room is private to your organisation. The player, their guardian and every other club can never see it.';
export const ROOM_UNAVAILABLE_NOTE =
  'Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.';

/** A room row for a list. Carries no player-private field and no source detail. */
export function roomSummary(
  room,
  { player = null, trust = null, openTasks = 0, health = null, lastActivityAt = null, visible = true } = {},
) {
  return {
    roomId: room.id,
    playerId: room.playerId,
    playerName: visible ? room.playerName : null,
    playerAvailable: visible,
    position: visible ? (player?.position ?? null) : null,
    age: visible ? (player?.age ?? null) : null,
    currentClub: visible ? (player?.currentClub ?? null) : null,
    status: room.room.status,
    statusLabel: ROOM_STATUS_LABELS[room.room.status],
    stage: room.stage,
    priority: room.room.priority,
    tags: room.room.tags ?? [],
    ownerUserId: room.ownerUserId,
    ownerName: room.ownerName,
    leadScoutUserId: room.room.leadScoutUserId ?? null,
    trust:
      visible && trust
        ? { score: trust.score, band: trust.band, bandLabel: trust.bandLabel, note: ROOM_TRUST_NOTE }
        : null,
    openTasks,
    health,
    healthLabel: health ? ROOM_HEALTH_LABELS[health] : null,
    lastActivityAt,
    updatedAt: room.room.updatedAt,
    createdAt: room.createdAt,
  };
}

export function roomFunnel(rooms = []) {
  const byStatus = {};
  for (const r of rooms) byStatus[r.room?.status] = (byStatus[r.room?.status] ?? 0) + 1;
  return roomFunnelFromCounts(byStatus, rooms.length);
}

/** The same funnel from Room counts by status, as the cases repository's GROUP BY answers. */
export function roomFunnelFromCounts(byStatus = {}, total = Object.values(byStatus).reduce((t, n) => t + n, 0)) {
  const counts = Object.fromEntries(ROOM_STATUSES.map((s) => [s, byStatus[s] ?? 0]));
  const active = OPEN_ROOM_STATUSES.reduce((t, s) => t + counts[s], 0);
  return {
    total,
    active,
    shortlisted: counts.shortlisted + counts.priority,
    trials: counts.trial_requested + counts.trial_scheduled + counts.trial_completed,
    offers: counts.offer_consideration + counts.offer_made,
    signed: counts.signed,
    archived: counts.archived + counts.closed + counts.withdrawn,
    byStatus: counts,
    note: 'Your organisation’s own recruitment activity. ScoutBox publishes no cross-club league table.',
  };
}

// Machine-readable reasons and no private free text.
export function secondLookEvent(room, decision) {
  return {
    type: 'recruitment_room_archived',
    roomId: room.id,
    orgId: room.orgId,
    playerId: room.playerId,
    status: room.room.status,
    reasonCodes: decision?.reasonCodes ?? [],
    revisitable: (decision?.reasonCodes ?? []).some((c) => REVISITABLE_REASON_CODES.includes(c)),
    decisionAt: decision?.createdAt ?? room.room.updatedAt,
    sourceVersionRefs: decision?.snapshot?.sourceRefs ?? null,
    // Absent: note, comments, assessment content, player name.
  };
}

// ------------------------------------------------------------------ limits

export const LIMITS = {
  commentBody: 4000,
  commentsPerRoomPerMinute: 20,
  taskTitle: 160,
  taskDescription: 1000,
  tasksPerRoom: 200,
  tagLength: 40,
  tagsPerRoom: 20,
  roomsPerOrgPerHour: 60,
  mentionsPerComment: 20,
  pageSize: 50,
  maxPageSize: 100,
};

export const clampPage = (n, fallback = LIMITS.pageSize) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), LIMITS.maxPageSize) : fallback;
};

/** Tags are internal labels. A tag that reads as a protected trait is refused. */
export function validateTag(raw) {
  if (typeof raw !== 'string' || raw.length > LIMITS.tagLength)
    return {
      ok: false,
      error: 'ROOM_TAGS_INVALID',
      message: `A tag is text of at most ${LIMITS.tagLength} characters.`,
    };
  const tag = raw.trim();
  if (!tag) return { ok: false, error: 'ROOM_TAG_EMPTY', message: 'A tag needs some text.' };
  const flat = tag.toLowerCase().replace(/[^a-z]+/g, '_');
  if (PROHIBITED_REASON_CODES.some((c) => flat === c || flat.startsWith(`${c}_`) || flat.endsWith(`_${c}`))) {
    return {
      ok: false,
      error: 'ROOM_TAG_PROHIBITED',
      message: 'A tag cannot classify a player by a protected characteristic.',
    };
  }
  return { ok: true, tag };
}
