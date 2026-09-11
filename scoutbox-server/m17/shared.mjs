// M17 — Recruitment Rooms: the pure engine.
//
// A Recruitment Room is the club's DECISION layer over a player. The Football
// Passport remains the player's TRUTH layer. Nothing here re-derives player
// truth; it decides, records and explains what a club did with it.
//
// Everything in this file is a pure function over plain data so the state
// machine, the reason taxonomy and the safe projections can be unit-tested
// without Express, a database or a session.
//
// The load-bearing architectural decision, and the reason this file has no
// pipeline of its own: `db.recruitmentCases` (M12) is ALREADY "the workspace
// layer OVER existing requests, trials and signings". A Room is a FACET of a
// case, not a second pipeline. `room.status` is the one canonical status and
// `case.stage` is a pure derivation of it (`stageForRoomStatus`), written by a
// single function, so the two can never disagree.

// ---------------------------------------------------------------- statuses

// The canonical room status set. Every status maps onto exactly one M12 stage.
export const ROOM_STATUSES = [
  'watching',
  'under_review',
  'shortlisted',
  'priority',
  'trial_requested',
  'trial_scheduled',
  'trial_completed',
  'offer_consideration',
  'offer_made',
  'signed',
  'withdrawn',
  'archived',
  'closed',
];

export const ROOM_STATUS_LABELS = {
  watching: 'Watching',
  under_review: 'Under review',
  shortlisted: 'Shortlisted',
  priority: 'Priority',
  trial_requested: 'Trial requested',
  trial_scheduled: 'Trial scheduled',
  trial_completed: 'Trial completed',
  offer_consideration: 'Offer consideration',
  offer_made: 'Offer made',
  signed: 'Signed',
  withdrawn: 'Withdrawn',
  archived: 'Archived',
  closed: 'Closed',
};

// `superseded` is deliberately NOT a room status: a decision is superseded by a
// later decision (§83), which the append-only decision memory already models.
// A room that is no longer being pursued is `archived`, `withdrawn` or `closed`.

export const OPEN_ROOM_STATUSES = ROOM_STATUSES.filter(
  (s) => !['signed', 'withdrawn', 'archived', 'closed'].includes(s),
);

// M12 stage vocabularies, mirrored here so the mapping is declarative. These
// MUST stay equal to m12/scouting.mjs PRO_STAGES / GRASSROOTS_STAGES; a boot
// assertion in m17/index.mjs fails loudly if they ever drift apart.
export const PRO_STAGES = ['identified', 'review', 'observation', 'trial', 'decision', 'closed'];
export const GRASSROOTS_STAGES = ['review', 'invited', 'awaiting_response', 'decision', 'closed'];

const STAGE_MAP = {
  pro: {
    watching: 'identified',
    under_review: 'review',
    shortlisted: 'observation',
    priority: 'observation',
    trial_requested: 'trial',
    trial_scheduled: 'trial',
    trial_completed: 'trial',
    offer_consideration: 'decision',
    offer_made: 'decision',
    signed: 'closed',
    withdrawn: 'closed',
    archived: 'closed',
    closed: 'closed',
  },
  grassroots: {
    watching: 'review',
    under_review: 'review',
    shortlisted: 'review',
    priority: 'review',
    trial_requested: 'invited',
    trial_scheduled: 'invited',
    trial_completed: 'awaiting_response',
    offer_consideration: 'decision',
    offer_made: 'decision',
    signed: 'closed',
    withdrawn: 'closed',
    archived: 'closed',
    closed: 'closed',
  },
};

export const orgStageKind = (orgLevel) => (orgLevel === 'grassroots' ? 'grassroots' : 'pro');

/** The canonical M12 stage for a room status. One direction, one writer. */
export function stageForRoomStatus(status, orgLevel) {
  return STAGE_MAP[orgStageKind(orgLevel)][status] ?? null;
}

/**
 * The room status a legacy M12 stage write means. Used only so the existing
 * `POST /org/cases/:id/stage` route keeps working and lands on a real room
 * status instead of leaving the two representations disagreeing.
 */
export function roomStatusForStage(stage, orgLevel) {
  const table = STAGE_MAP[orgStageKind(orgLevel)];
  const canonical = {
    identified: 'watching',
    review: 'under_review',
    observation: 'shortlisted',
    trial: 'trial_requested',
    invited: 'trial_requested',
    awaiting_response: 'trial_completed',
    decision: 'offer_consideration',
    closed: 'archived',
  }[stage];
  return canonical && table[canonical] === stage ? canonical : null;
}

// ------------------------------------------------------------- transitions

// The full transition table. Anything not listed is refused — there is no
// "any status to any status" escape hatch, and nothing here is inferred from a
// Trust Score, a Combine result or an assessment rating.
export const ROOM_TRANSITIONS = {
  watching: ['under_review', 'shortlisted', 'withdrawn', 'archived'],
  under_review: ['watching', 'shortlisted', 'priority', 'trial_requested', 'withdrawn', 'archived'],
  shortlisted: ['under_review', 'priority', 'trial_requested', 'offer_consideration', 'withdrawn', 'archived'],
  priority: ['shortlisted', 'trial_requested', 'offer_consideration', 'withdrawn', 'archived'],
  trial_requested: ['trial_scheduled', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  trial_scheduled: ['trial_completed', 'trial_requested', 'withdrawn', 'archived'],
  trial_completed: ['offer_consideration', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  offer_consideration: ['offer_made', 'shortlisted', 'priority', 'withdrawn', 'archived'],
  offer_made: ['signed', 'offer_consideration', 'withdrawn', 'archived'],
  // Signed is where recruitment ends; the room may only be filed away after it.
  signed: ['closed'],
  // Reopening is a first-class move, not a delete-and-recreate.
  withdrawn: ['under_review', 'archived', 'closed'],
  archived: ['under_review', 'closed'],
  closed: ['under_review'],
};

/** Statuses that end active pursuit and therefore demand a recorded reason. */
export const REASON_REQUIRED_STATUSES = ['withdrawn', 'archived', 'closed'];

/** Statuses that are a reopen of a previously ended room. */
export const REOPENED_FROM = ['withdrawn', 'archived', 'closed'];

/**
 * Statuses at which the evidence-confidence the club could see is worth
 * preserving, so ScoutBox can later answer "what did they see at the time?".
 */
export const SNAPSHOT_STATUSES = [
  'shortlisted', 'priority', 'trial_requested',
  'offer_consideration', 'offer_made', 'signed',
  'withdrawn', 'archived', 'closed',
];

export const canTransition = (from, to) => (ROOM_TRANSITIONS[from] ?? []).includes(to);

/**
 * Validate a requested status change. Returns `{ ok, error, message, reopen,
 * needsReason, snapshot }` — never throws, never mutates.
 */
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
  };
}

// -------------------------------------------------------- reason taxonomy

/**
 * The structured reason taxonomy. A reason is a code plus an optional private
 * note; only the CODE is machine-readable, so a future Second Look can reason
 * about "why was this player archived?" without reading anybody's free text.
 */
export const REASON_CODES = {
  football: [
    'technical_fit', 'tactical_fit', 'physical_profile', 'position_need', 'development_upside',
  ],
  evidence: [
    'insufficient_full_match', 'insufficient_recent_evidence', 'reference_missing', 'combine_missing',
  ],
  process: [
    'budget', 'squad_space', 'timing', 'registration', 'travel_logistics', 'eligibility',
  ],
  outcome: [
    'trial_needed', 'continue_monitoring', 'not_current_priority', 'trial_outcome', 'player_unavailable',
  ],
};

export const ALL_REASON_CODES = Object.values(REASON_CODES).flat();

export const reasonCategory = (code) =>
  Object.keys(REASON_CODES).find((cat) => REASON_CODES[cat].includes(code)) ?? null;

/**
 * Reasons that must never be recordable, in any club, for any player. These are
 * refused with their own error code rather than a generic "unknown code" so the
 * refusal is unambiguous in an audit and cannot be mistaken for a typo.
 *
 * A club may still decline a player — it simply may not record a protected
 * trait as the reason, and ScoutBox will not carry one into its analytics.
 */
export const PROHIBITED_REASON_CODES = [
  'race', 'ethnicity', 'skin_colour', 'skin_color',
  'nationality', 'nationality_preference', 'national_origin', 'immigration_status',
  'religion', 'faith', 'caste',
  'disability', 'medical_condition', 'mental_health',
  'gender', 'sex', 'sexuality', 'sexual_orientation', 'gender_identity',
  'socioeconomic', 'social_background', 'family_income', 'postcode', 'accent',
  'pregnancy', 'marital_status', 'political_opinion', 'union_membership',
];

/**
 * Evidence-shaped reasons. A room archived for one of these may become worth a
 * second look when the missing evidence arrives — this is the contract the
 * future Second Look product consumes.
 */
export const REVISITABLE_REASON_CODES = [...REASON_CODES.evidence, 'trial_needed', 'continue_monitoring'];

export function validateReasonCodes(codes) {
  if (!Array.isArray(codes)) {
    return { ok: false, error: 'ROOM_REASONS_INVALID', message: 'Reasons must be a list of reason codes.' };
  }
  const clean = [...new Set(codes.map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean))];
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
  'no_decision', 'continue_watching', 'shortlist', 'priority', 'trial', 'offer', 'archive',
];

/**
 * Validate a decision entry. A decision is a human judgement: nothing here
 * reads a Trust Score, a Combine measurement or an assessment rating, and
 * nothing infers a recommendation from them.
 */
export function validateDecision({ recommendation, reasonCodes = [], note = null } = {}) {
  if (!RECOMMENDATIONS.includes(recommendation)) {
    return { ok: false, error: 'ROOM_RECOMMENDATION_UNKNOWN', message: 'That is not a ScoutBox recruitment recommendation.' };
  }
  const reasons = validateReasonCodes(reasonCodes);
  if (!reasons.ok) return reasons;
  if (recommendation === 'archive' && reasons.codes.length === 0) {
    return { ok: false, error: 'ROOM_REASON_REQUIRED', message: 'Archiving needs at least one reason so the decision stays useful later.' };
  }
  if (note != null && String(note).length > 2000) {
    return { ok: false, error: 'ROOM_NOTE_TOO_LONG', message: 'Keep the internal note under 2000 characters.' };
  }
  return { ok: true, recommendation, codes: reasons.codes, note: note == null ? null : String(note) };
}

// --------------------------------------------------------------- readiness

/**
 * Deterministic workflow completeness. This is NOT a score and NOT a
 * recommendation: it counts what has been done and what is outstanding, and
 * every item is a plain fact a human could check themselves.
 */
export function decisionReadiness({
  assessmentsAssigned = 0, assessmentsSubmitted = 0,
  recentFullMatch = false, coachReference = false,
  combineVerified = 0, combineRequested = 0,
  trialState = 'none', openTasks = 0, openEvidenceRequests = 0,
} = {}) {
  const items = [
    {
      key: 'assessments',
      label: 'Assessments',
      value: `${assessmentsSubmitted}/${assessmentsAssigned} submitted`,
      complete: assessmentsAssigned > 0 && assessmentsSubmitted >= assessmentsAssigned,
      outstanding: assessmentsAssigned === 0 ? 'None assigned yet' : assessmentsSubmitted < assessmentsAssigned ? 'Awaiting submissions' : null,
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
      value: combineVerified > 0 ? `${combineVerified} verified` : combineRequested > 0 ? 'Requested' : 'No verified result',
      complete: combineVerified > 0,
      outstanding: combineVerified > 0 ? null : combineRequested > 0 ? 'Requested, not yet completed' : 'No production-supported Combine Verified result is currently available',
    },
    {
      key: 'trial',
      label: 'Trial',
      value: { none: 'Not required yet', requested: 'Requested', scheduled: 'Scheduled', awaiting_report: 'Awaiting report', reported: 'Reported' }[trialState] ?? 'Not required yet',
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
    // Counts, deliberately — never a percentage, never a readiness score.
    complete: items.filter((i) => i.complete).length,
    total: items.length,
    blockers: items.filter((i) => i.outstanding).map((i) => ({ key: i.key, text: i.outstanding })),
    openEvidenceRequests,
    note: 'Workflow completeness, not a recommendation. ScoutBox does not decide whether to sign a player.',
  };
}

/**
 * A word, never a number. Adding a second numeric score to a product that
 * already has a Trust Score is exactly how a Trust Score becomes a player
 * rating by accident.
 */
export const ROOM_HEALTH = ['decision_recorded', 'trial_pending', 'assessment_outstanding', 'waiting_on_evidence', 'ready_for_review'];

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
  if (blocked.has('recent_full_match') || blocked.has('coach_reference') || blocked.has('combine')) return 'waiting_on_evidence';
  return 'ready_for_review';
}

// ------------------------------------------------------------- permissions

/**
 * Room roles mapped onto the EXISTING org permission architecture — no
 * parallel RBAC. `isLead` is the one existing tier (a regex over the user's
 * role, m12/shared.mjs); case restriction is the one existing per-user gate.
 */
export function roomRole({ room, user, isLead }) {
  if (!room || !user) return null;
  if (isLead) return 'recruitment_admin';
  if (room.ownerUserId === user.id || room.room?.leadScoutUserId === user.id) return 'room_lead';
  if ((room.assignments ?? []).some((a) => a.userId === user.id)) return 'contributor';
  return room.restricted ? null : 'viewer';
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
    manage_any_room: 3,
  }[action];
  return need != null && rank >= need;
};

// ----------------------------------------------------------- source context

/** Where a room came from. Workflow provenance only — never a player score. */
export const SOURCE_CONTEXTS = ['search', 'watchlist', 'shortlist', 'opportunity', 'recommendation', 'campaign', 'passport', 'direct'];

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

export const LINKED_RESOURCE_TYPES = ['evidence', 'assessment', 'combine_request', 'trial', 'box_cam_assignment', 'evidence_request', 'comment'];

// ------------------------------------------------------------ evidence state

export const EVIDENCE_REVIEW_STATES = ['not_reviewed', 'reviewing', 'reviewed', 'needs_follow_up'];

// --------------------------------------------------------------- priorities

export const ROOM_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * Internal workflow urgency — how soon the CLUB needs to act. It says nothing
 * about the player and is never exposed outside the organisation.
 */
export const ROOM_PRIORITY_NOTE = 'Internal workflow urgency for your organisation. It is not a judgement of the player and is never shown to them.';

// -------------------------------------------------------------- activity

export const ROOM_EVENT_TYPES = [
  'room_created', 'room_status_changed', 'room_reopened', 'room_owner_changed',
  'room_member_assigned', 'room_task_created', 'room_task_updated',
  'room_comment_added', 'room_comment_edited', 'room_comment_deleted',
  'room_assessment_assigned', 'room_evidence_reviewed', 'room_evidence_requested',
  'room_combine_requested', 'room_trial_linked', 'room_signing_linked',
  'room_decision_recorded', 'room_tag_changed', 'room_priority_changed',
];

/**
 * Project the append-only `case.history` rows M12 already writes into typed
 * room activity. Ordering is stable and total: timestamp first, then the
 * monotonic numeric part of the event id as a tiebreak, so two events written
 * in the same millisecond never swap places between reads.
 */
export function roomActivity(history = [], { limit = 50, cursor = null } = {}) {
  const seq = (id) => {
    const n = Number(String(id ?? '').split('-').pop());
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
    .sort((a, b) => (b.at - a.at) || (seq(b.id) - seq(a.id)));
  const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
  const page = rows.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < rows.length ? page[page.length - 1]?.id ?? null : null,
    total: rows.length,
  };
}

// ------------------------------------------------------------- snapshots

/**
 * A decision-time snapshot records what evidence confidence the club COULD see
 * when it decided, plus the minimal references needed to explain the decision
 * later. It deliberately does NOT freeze the Passport: giant JSON snapshots rot,
 * and a frozen copy of restricted player data is exactly the stale-cache
 * authorization bypass this milestone must not create.
 */
export function buildRoomSnapshot({ trustSnapshot = null, sourceRefs = {}, trigger, at = Date.now() }) {
  return {
    at,
    trigger,
    trust: trustSnapshot
      ? {
          score: trustSnapshot.score,
          band: trustSnapshot.band,
          policyVersion: trustSnapshot.policyVersion,
          // Component LEVELS only — the per-component coverage numbers that
          // safeTrustProjection withholds from a club never enter the store.
          componentLevels: Object.fromEntries(
            Object.entries(trustSnapshot.components ?? {}).map(([k, c]) => [k, c.level]),
          ),
          hash: trustSnapshot.hash,
        }
      : null,
    sourceRefs: {
      passportVersion: sourceRefs.passportVersion ?? null,
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
export const ROOM_DEV_NOTE = 'Box Cam activity shows verified training evidence. It does not independently establish football ability.';
export const ROOM_PRIVACY_NOTE = 'This room is private to your organisation. The player, their guardian and every other club can never see it.';
export const ROOM_UNAVAILABLE_NOTE = 'Player data is currently unavailable to your organisation under the standing rules. Your internal record remains.';

/**
 * A room row for a list. Carries no player-private field and no source detail —
 * the list is a workflow view, not a back door into a Passport.
 */
export function roomSummary(room, { player = null, trust = null, openTasks = 0, health = null, lastActivityAt = null, visible = true } = {}) {
  return {
    roomId: room.id,
    playerId: room.playerId,
    playerName: visible ? room.playerName : null,
    playerAvailable: visible,
    position: visible ? player?.position ?? null : null,
    age: visible ? player?.age ?? null : null,
    currentClub: visible ? player?.currentClub ?? null : null,
    status: room.room.status,
    statusLabel: ROOM_STATUS_LABELS[room.room.status],
    stage: room.stage,
    priority: room.room.priority,
    tags: room.room.tags ?? [],
    ownerUserId: room.ownerUserId,
    ownerName: room.ownerName,
    leadScoutUserId: room.room.leadScoutUserId ?? null,
    trust: visible && trust ? { score: trust.score, band: trust.band, bandLabel: trust.bandLabel, note: ROOM_TRUST_NOTE } : null,
    openTasks,
    health,
    healthLabel: health ? ROOM_HEALTH_LABELS[health] : null,
    lastActivityAt,
    updatedAt: room.room.updatedAt,
    createdAt: room.createdAt,
  };
}

/** Aggregate funnel counts for one organisation. No player identifiers. */
export function roomFunnel(rooms = []) {
  const counts = Object.fromEntries(ROOM_STATUSES.map((s) => [s, 0]));
  for (const r of rooms) if (counts[r.room?.status] != null) counts[r.room.status] += 1;
  const active = OPEN_ROOM_STATUSES.reduce((t, s) => t + counts[s], 0);
  return {
    total: rooms.length,
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

/**
 * The Second Look contract (§156). A domain event carrying machine-readable
 * reasons and no private free text, so a future product can ask "has the
 * reason this player was archived stopped applying?" without reading notes.
 */
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
    // Deliberately absent: note, comments, assessment content, player name.
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
  const tag = String(raw ?? '').trim().slice(0, LIMITS.tagLength);
  if (!tag) return { ok: false, error: 'ROOM_TAG_EMPTY', message: 'A tag needs some text.' };
  const flat = tag.toLowerCase().replace(/[^a-z]+/g, '_');
  if (PROHIBITED_REASON_CODES.some((c) => flat === c || flat.startsWith(`${c}_`) || flat.endsWith(`_${c}`))) {
    return { ok: false, error: 'ROOM_TAG_PROHIBITED', message: 'A tag cannot classify a player by a protected characteristic.' };
  }
  return { ok: true, tag };
}
