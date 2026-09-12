// M18 — Second Look + Nobody Missed: the pure engine and its policy.
//
// Two systems, one file of deterministic rules:
//
//   Second Look   — has something MATERIALLY changed about a player since our
//                   club last made a recruitment decision, and is that change
//                   relevant to the reason we gave?
//   Nobody Missed — are there eligible players who match our OWN stated
//                   criteria but have never meaningfully entered our
//                   evaluation workflow?
//
// Neither decides who is talented, who deserves a contract, who was wrongly
// rejected, or who will succeed. There is no score anywhere in this file — no
// potential score, no missed-talent score, no probability, no ranking. Both
// systems work from explicit club criteria, deterministic evidence changes and
// exact rule-based comparisons, and every output can be read back to a human as
// a list of plain facts.
//
// Everything here is pure: no Express, no database handle, no session.

// =====================================================================
// SECOND LOOK POLICY
// =====================================================================

export const SECOND_LOOK_POLICY_VERSION = 1;

/**
 * Normalised material change types. Source systems each have their own
 * vocabulary; M18 speaks exactly these.
 */
export const CHANGE_TYPES = [
  // evidence
  'full_match_added',
  'evidence_added',
  'evidence_quality_improved',
  'evidence_removed',
  'evidence_disputed',
  // references
  'verified_reference_added',
  'verified_reference_revoked',
  // standardized measurement
  'combine_verified_added',
  'combine_verified_invalidated',
  // M18.1: a restoration is its own change. Trust & Safety restoring a result
  // after a provider bug is news to a club that saw it disappear, and saying
  // nothing would leave the earlier "no longer valid" note standing forever.
  'combine_verified_restored',
  // development activity
  'development_evidence_started',
  'development_block_completed',
  // recruitment workflow
  'trial_completed',
  'assessment_submitted',
  // record facts
  'current_club_confirmed',
  'position_changed',
  'evidence_gap_closed',
];

/** A change that reduces the evidence available. Never framed as wrongdoing. */
export const NEGATIVE_CHANGE_TYPES = [
  'evidence_removed', 'evidence_disputed',
  'verified_reference_revoked', 'combine_verified_invalidated',
];

export const CHANGE_COPY = {
  full_match_added: 'A new full match has been added.',
  evidence_added: 'New evidence has been added to the player’s record.',
  evidence_quality_improved: 'Existing evidence has been independently confirmed.',
  evidence_removed: 'A source used in the previous review is no longer current.',
  evidence_disputed: 'A source used in the previous review is under review.',
  verified_reference_added: 'A verified coach reference has been added.',
  verified_reference_revoked: 'A coach reference used in the previous review is no longer verified.',
  combine_verified_added: 'A standardized Combine Verified result is now available.',
  combine_verified_invalidated: 'A Combine result used in the previous review is no longer valid.',
  combine_verified_restored: 'A Combine result that had been invalidated has been restored after review.',
  development_evidence_started: 'Recorded development activity is now available for the first time since your review.',
  development_block_completed: 'A coach-assigned development block has been completed.',
  trial_completed: 'A trial has been completed and reported.',
  assessment_submitted: 'A new assessment has been submitted in your organisation.',
  current_club_confirmed: 'The player’s current club is now confirmed.',
  position_changed: 'The player’s declared position has changed.',
  evidence_gap_closed: 'An evidence gap your organisation raised has been filled.',
};

/**
 * The reason → change mapping. This is the heart of Second Look: M17's archive
 * reasons are structured precisely so this table can ask whether the reason a
 * club gave may no longer apply.
 *
 * A reason absent from this table NEVER resolves from player evidence alone.
 * `squad_space`, `budget`, `timing`, `registration` and `travel_logistics` are
 * facts about the CLUB, not the player — no amount of new footage makes a
 * squad place appear, and claiming otherwise would be a lie dressed as a
 * feature.
 */
export const REASON_CHANGE_MAP = {
  insufficient_recent_evidence: ['full_match_added', 'evidence_added', 'evidence_quality_improved', 'evidence_gap_closed'],
  insufficient_full_match: ['full_match_added', 'evidence_gap_closed'],
  reference_missing: ['verified_reference_added'],
  combine_missing: ['combine_verified_added', 'combine_verified_restored'],
  trial_needed: ['trial_completed'],
  continue_monitoring: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed', 'current_club_confirmed', 'evidence_gap_closed'],
  // Physical development is read as EVIDENCE becoming available, never as a
  // prediction about a body. The copy stays evidence-based.
  physical_profile: ['development_block_completed', 'combine_verified_added'],
  // A role judgement can only be revisited on evidence that could actually
  // change it — a new full match or a completed trial, not a reference.
  technical_fit: ['full_match_added', 'trial_completed'],
  tactical_fit: ['full_match_added', 'trial_completed'],
  development_upside: ['development_block_completed', 'full_match_added'],
  // "Not a priority right now" is a soft judgement, so it CAN be revisited —
  // but only on evidence substantial enough to change the picture, never on a
  // trickle of small updates.
  not_current_priority: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed'],
  position_need: ['position_changed'],
  // A decision taken on a trial outcome can be revisited when a LATER trial is
  // completed and reported — nothing else about the player changes it.
  trial_outcome: ['trial_completed'],
  // Club-side reasons: facts about the CLUB, not the player. No amount of new
  // footage makes a squad place or a budget appear, and saying otherwise would
  // be a lie dressed up as a feature.
  squad_space: [],
  budget: [],
  timing: [],
  registration: [],
  travel_logistics: [],
  eligibility: [],
  // Availability is a fact about the player, but ScoutBox emits no
  // availability-changed event today, so this cannot be resolved honestly yet.
  // Recorded as a limitation rather than faked.
  player_unavailable: [],
};

/** Reasons that can never be resolved by a change in the player's record. */
export const CLUB_SIDE_REASONS = Object.entries(REASON_CHANGE_MAP)
  .filter(([, types]) => types.length === 0)
  .map(([code]) => code);

export const POLICY = {
  version: SECOND_LOOK_POLICY_VERSION,

  // A general (non-reason-matching) change must clear a higher bar, so an
  // unrelated trickle of updates never resurfaces an archived player.
  generalThreshold: {
    // At least this many distinct material changes …
    minChanges: 2,
    // … or one change of a kind that is substantial on its own.
    substantialTypes: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed'],
  },

  // Box Cam must not become notification spam: a single training session is
  // never a Second Look. Only the first development evidence since the review,
  // or a completed coach-assigned block, counts.
  boxCam: {
    countSessionsAsChange: false,
    minSessionsForFirstEvidence: 1,
  },

  // Once an item has been reviewed or dismissed, the SAME evidence cannot
  // regenerate it. Materially different evidence can, immediately.
  cooldownDays: 30,

  // An open item nobody acts on eventually stops being news.
  expiryDays: 120,

  // A decision older than this is still valid input — Second Look has no
  // upper bound on how long ago a club decided. Recorded for documentation.
  maxDecisionAgeDays: null,
};

export const SECOND_LOOK_STATUSES = ['open', 'reviewed', 'dismissed', 'reopened_room', 'expired'];

export const SECOND_LOOK_TRANSITIONS = {
  open: ['reviewed', 'dismissed', 'reopened_room', 'expired'],
  reviewed: ['dismissed', 'reopened_room', 'expired'],
  dismissed: ['open'],        // only via genuinely new evidence
  reopened_room: [],          // terminal: the club acted
  expired: ['open'],          // only via genuinely new evidence
};

export const canSecondLookTransition = (from, to) => (SECOND_LOOK_TRANSITIONS[from] ?? []).includes(to);

/** Categories, not numbers. Ordering is by category then recency. */
export const SECOND_LOOK_KINDS = ['direct_reason_resolved', 'significant_new_evidence', 'evidence_removed', 'general_update'];

export const SECOND_LOOK_KIND_COPY = {
  direct_reason_resolved: 'Worth Another Look',
  significant_new_evidence: 'New Since Your Review',
  evidence_removed: 'Evidence Changed',
  general_update: 'New Since Your Review',
};

const KIND_ORDER = Object.fromEntries(SECOND_LOOK_KINDS.map((k, i) => [k, i]));

export const DISMISSAL_REASONS = [
  'already_reviewed_elsewhere', 'change_not_material', 'timing_not_right',
  'squad_need_changed', 'no_action_required', 'other',
];

/**
 * Copy the product is allowed to use, and copy it is not. The forbidden list is
 * swept in tests: Second Look must never tell a club it was wrong, and must
 * never tell it what to do.
 */
export const SECOND_LOOK_DISCLAIMER =
  'Second Look reports what changed in a player’s record since your decision. It does not judge that decision and does not recommend whether to sign anyone.';

export const FORBIDDEN_COPY = [
  'wrong decision', 'you were wrong', 'mistake', 'should sign', 'should recruit',
  'missed talent', 'best available', 'better than', 'probability of success',
  'potential score', 'talent score',
];

// ------------------------------------------------------- change normalization

/**
 * Normalise any source-system fact into a deterministic change record.
 * Nothing here copies a source payload: only the identity, the clock and the
 * type travel.
 */
export function normalizeMaterialChange({ type, subjectId, sourceSystem, sourceId, occurredAt, detail = null }) {
  if (!CHANGE_TYPES.includes(type)) return null;
  if (!occurredAt || !Number.isFinite(occurredAt)) return null;
  return {
    type,
    subjectId,
    sourceSystem,
    sourceId: sourceId ?? null,
    occurredAt,
    negative: NEGATIVE_CHANGE_TYPES.includes(type),
    text: CHANGE_COPY[type],
    fingerprint: changeFingerprint({ type, sourceSystem, sourceId }),
    detail,
  };
}

/**
 * A stable identity for a change, used for dedupe, cooldown, history and
 * notification idempotency. Deliberately excludes the timestamp: the same
 * source fact seen twice is the same change, whenever it is observed.
 */
export const changeFingerprint = ({ type, sourceSystem, sourceId }) =>
  `${type}:${sourceSystem}:${sourceId ?? 'none'}`;

/**
 * One real-world change often reaches M18 through several systems at once — a
 * Combine result appears in the Combine projection, in the Passport and as a
 * Trust component movement. Dedupe by canonical identity, keeping the earliest
 * observation so the timeline stays honest.
 */
export function dedupeMaterialChanges(changes = []) {
  const byPrint = new Map();
  for (const c of changes) {
    if (!c) continue;
    const prev = byPrint.get(c.fingerprint);
    if (!prev || c.occurredAt < prev.occurredAt) byPrint.set(c.fingerprint, c);
  }
  return [...byPrint.values()].sort((a, b) => (b.occurredAt - a.occurredAt) || a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * Keep only changes that happened strictly after the decision. Evidence that
 * already existed when the club decided is not news — the club saw it.
 */
export function changesSinceDecision(changes = [], decisionAt) {
  if (!Number.isFinite(decisionAt)) return [];
  const now = Date.now();
  return dedupeMaterialChanges(
    changes.filter((c) => c && c.occurredAt > decisionAt
      // A future timestamp is a forged or broken event, not a change.
      && c.occurredAt <= now),
  );
}

// ------------------------------------------------------------ reason matching

/**
 * Does this change relate to that archive reason? Returns the matching reason
 * codes, never a score. An empty result is the common, correct answer.
 */
export function secondLookReasonMatch(change, reasonCodes = []) {
  if (!change) return [];
  return reasonCodes.filter((code) => (REASON_CHANGE_MAP[code] ?? []).includes(change.type));
}

/** Was the general-change bar cleared, independently of any reason? */
export function meetsGeneralThreshold(changes = []) {
  const positive = changes.filter((c) => !c.negative);
  if (positive.some((c) => POLICY.generalThreshold.substantialTypes.includes(c.type))) return true;
  return positive.length >= POLICY.generalThreshold.minChanges;
}

// -------------------------------------------------- snapshot vs current state

/**
 * Compare the decision-time snapshot with the current canonical state.
 *
 * Where the snapshot cannot reconstruct a field, this says so rather than
 * inventing a previous value — `available: false` means "previous detail
 * unavailable", never "it was zero".
 */
export function compareToSnapshot(snapshot, current) {
  const row = (key, label, was, now, wasKnown) => ({
    key, label, was: wasKnown ? was : null, now, available: !!wasKnown,
    changed: wasKnown ? JSON.stringify(was) !== JSON.stringify(now) : null,
  });
  const s = snapshot ?? null;
  const refs = s?.sourceRefs ?? null;
  return {
    available: !!s,
    at: s?.at ?? null,
    note: s ? null : 'Previous detail unavailable — no decision-time snapshot was recorded.',
    rows: [
      row('trust', 'Evidence confidence',
        s?.trust ? { score: s.trust.score, band: s.trust.band } : null,
        current.trust ? { score: current.trust.score, band: current.trust.band } : null,
        !!s?.trust),
      row('evidence', 'Evidence items', refs?.evidenceIds?.length ?? null, current.evidenceIds?.length ?? 0, !!refs?.evidenceIds),
      row('references', 'Verified coach references', current.referencesAtDecision ?? null, current.references ?? 0, current.referencesAtDecision != null),
      row('combine', 'Combine Verified protocols', refs?.combineResults?.length ?? null, current.combineResults?.length ?? 0, !!refs?.combineResults),
      row('assessments', 'Assessments in your organisation', refs?.assessmentIds?.length ?? null, current.assessmentIds?.length ?? 0, !!refs?.assessmentIds),
      row('trials', 'Trials', refs?.trialIds?.length ?? null, current.trialIds?.length ?? 0, !!refs?.trialIds),
    ],
  };
}

/**
 * Derive Trust movement from the snapshot's component LEVELS.
 *
 * The stored snapshot deliberately drops per-component coverage (a club may
 * not see it), so M16.2's `trustChangeReasons` cannot read it. Rather than
 * persist coverage we were not allowed to show, M18 compares levels — coarser,
 * but honest, and it keeps the existing vocabulary.
 *
 * Trust movement is CONTEXT. It is never a trigger on its own: §10 requires the
 * underlying facts, and `buildSecondLookCandidate` enforces that.
 */
const LEVEL_RANK = { none: 0, limited: 1, established: 2, strong: 3, very_strong: 4 };

export const TRUST_COMPONENT_CODES = {
  identity: ['IDENTITY_CONFIRMED', 'CLAIM_REVOKED'],
  footballHistory: ['CAREER_RECORD_CONFIRMED', 'CLAIM_REVOKED'],
  relationships: ['COACH_RELATIONSHIP_CONFIRMED', 'CLAIM_REVOKED'],
  references: ['REFERENCE_CONFIRMED', 'CLAIM_REVOKED'],
  evidence: ['BOX_CAM_EVIDENCE_ADDED', 'EVIDENCE_EXPIRED'],
  combine: ['COMBINE_VERIFIED_ADDED', 'COMBINE_INVALIDATED'],
};

export function trustLevelChanges(snapshotTrust, currentProfile) {
  if (!snapshotTrust?.componentLevels || !currentProfile?.components) return [];
  const out = [];
  for (const [key, [up, down]] of Object.entries(TRUST_COMPONENT_CODES)) {
    const before = LEVEL_RANK[levelId(snapshotTrust.componentLevels[key])] ?? null;
    const after = LEVEL_RANK[currentProfile.components[key]?.level?.id] ?? null;
    if (before == null || after == null || before === after) continue;
    out.push({ component: key, code: after > before ? up : down, direction: after > before ? 'up' : 'down' });
  }
  return out;
}

// A snapshot stores a level id string; older fixtures stored `{id}`.
const levelId = (v) => (typeof v === 'string' ? v : v?.id ?? null);

// -------------------------------------------------------- candidate assembly

/**
 * Build one Second Look candidate for one archived room.
 *
 * Returns `null` when the player should not be surfaced at all — that is the
 * common case and is not an error.
 */
export function buildSecondLookCandidate({
  room, decision, snapshot, changes = [], trustMovement = [],
  playerVisible = true, currentTrust = null, now = Date.now(),
}) {
  // §4 preconditions, in order.
  if (!room || !decision) return null;
  if (!playerVisible) return null;
  // A room the club is actively working is not a Second Look — it is open work.
  if (!['archived', 'closed', 'withdrawn'].includes(room.room?.status)) return null;

  const material = changesSinceDecision(changes, decision.createdAt);
  if (!material.length) return null;

  const reasonCodes = decision.reasonCodes ?? [];
  const directed = material.map((c) => ({ change: c, relatesTo: secondLookReasonMatch(c, reasonCodes) }));
  const direct = directed.filter((d) => d.relatesTo.length > 0);
  const negative = material.filter((c) => c.negative);

  let kind = null;
  if (direct.length) kind = 'direct_reason_resolved';
  else if (negative.length && negative.length === material.length) kind = 'evidence_removed';
  else if (meetsGeneralThreshold(material)) {
    kind = material.some((c) => POLICY.generalThreshold.substantialTypes.includes(c.type))
      ? 'significant_new_evidence' : 'general_update';
  } else if (negative.length) kind = 'evidence_removed';

  // Not every change clears the bar. Saying nothing is a valid outcome.
  if (!kind) return null;

  // A reason a club gave that could NOT be resolved by player evidence is
  // reported as still standing, so the UI can never imply otherwise.
  const unresolved = reasonCodes.filter((c) => CLUB_SIDE_REASONS.includes(c));

  return {
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    roomId: room.id,
    orgId: room.orgId,
    playerId: room.playerId,
    decisionId: decision.id,
    decisionAt: decision.createdAt,
    archivedStatus: room.room.status,
    archiveReasonCodes: reasonCodes,
    kind,
    kindLabel: SECOND_LOOK_KIND_COPY[kind],
    strength: direct.length ? 'direct' : 'general',
    // One item per player, carrying every change — never three alerts for one
    // Combine result.
    changes: directed.map(({ change, relatesTo }) => ({ ...change, relatesTo })),
    changeCount: material.length,
    directReasonCodes: [...new Set(direct.flatMap((d) => d.relatesTo))],
    unresolvedReasonCodes: unresolved,
    changeFingerprints: material.map((c) => c.fingerprint).sort(),
    // Supporting context only. Never the reason the item exists.
    trustMovement,
    currentTrust,
    latestChangeAt: material[0].occurredAt,
    summary: secondLookSummary({ kind, direct, material }),
    disclaimer: SECOND_LOOK_DISCLAIMER,
    createdAt: now,
  };
}

function secondLookSummary({ kind, direct, material }) {
  if (kind === 'direct_reason_resolved') {
    // Lead with the most substantial change, not merely the most recent: a new
    // full match is the headline, a tier upgrade on the same day is not.
    const headline = direct.find((d) => POLICY.generalThreshold.substantialTypes.includes(d.change.type)) ?? direct[0];
    return `${CHANGE_COPY[headline.change.type]} This relates to the reason recorded when the room was closed.`;
  }
  if (kind === 'evidence_removed') {
    return `${material.length === 1 ? 'One source' : `${material.length} sources`} used in the previous review ${material.length === 1 ? 'is' : 'are'} no longer current.`;
  }
  return `${material.length} material ${material.length === 1 ? 'change' : 'changes'} since your review.`;
}

/**
 * Should an item be (re)surfaced, given what this club already did with the
 * same evidence? The cooldown is per-fingerprint-set: the same evidence cannot
 * come back, genuinely new evidence can, immediately.
 */
export function secondLookStatus({ existing, candidate, now = Date.now() }) {
  if (!existing) return { action: 'create', reason: 'new' };
  const seen = new Set(existing.changeFingerprints ?? []);
  const fresh = (candidate.changeFingerprints ?? []).filter((f) => !seen.has(f));

  if (['reviewed', 'dismissed', 'expired'].includes(existing.status)) {
    if (!fresh.length) return { action: 'suppress', reason: 'same_evidence_already_handled' };
    const handledAt = existing.dismissedAt ?? existing.reviewedAt ?? existing.updatedAt ?? 0;
    if (now - handledAt < POLICY.cooldownDays * 86_400_000 && !hasSubstantial(candidate, fresh)) {
      return { action: 'suppress', reason: 'within_cooldown' };
    }
    return { action: 'reopen', reason: 'materially_new_evidence', fresh };
  }
  if (existing.status === 'reopened_room') return { action: 'suppress', reason: 'club_already_acted' };
  if (!fresh.length) return { action: 'refresh', reason: 'unchanged' };
  return { action: 'update', reason: 'more_evidence', fresh };
}

const hasSubstantial = (candidate, fingerprints) =>
  (candidate.changes ?? []).some((c) => fingerprints.includes(c.fingerprint)
    && POLICY.generalThreshold.substantialTypes.includes(c.type));

export const secondLookExpired = (item, now = Date.now()) =>
  item.status === 'open' && now - (item.latestChangeAt ?? item.createdAt) > POLICY.expiryDays * 86_400_000;

/** Direct relevance first, then newest material change. Never a priority score. */
export const orderSecondLook = (items = []) => items.slice().sort((a, b) =>
  (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
  || (b.latestChangeAt - a.latestChangeAt)
  || String(a.id ?? '').localeCompare(String(b.id ?? '')));

// =====================================================================
// NOBODY MISSED
// =====================================================================

export const EVALUATION_COVERAGE_POLICY_VERSION = 1;

/**
 * What counts as MEANINGFULLY EVALUATED. Versioned, documented, and
 * deliberately conservative: a profile view is not an evaluation. Passive
 * impressions are excluded both because they are not evaluation and because the
 * store that holds them is lossy by design.
 */
export const EVALUATION_SIGNALS = [
  { key: 'room_open', label: 'An open Recruitment Room exists' },
  { key: 'room_decided', label: 'A Recruitment Room reached a recorded decision' },
  { key: 'case_open', label: 'An open recruitment case exists' },
  { key: 'assessment_submitted', label: 'A submitted assessment exists' },
  { key: 'trial', label: 'A trial exists' },
  { key: 'signing', label: 'The player was signed' },
  { key: 'shortlisted', label: 'The player was shortlisted' },
  { key: 'review_deferred', label: 'A reviewer explicitly deferred the player' },
  { key: 'squad', label: 'The player is on the squad or shadow squad' },
];

export const EVALUATION_SIGNAL_KEYS = EVALUATION_SIGNALS.map((s) => s.key);

/** Signals that explicitly do NOT count, recorded so the exclusion is auditable. */
export const NON_EVALUATION_SIGNALS = [
  { key: 'profile_view', why: 'Opening a profile is not an evaluation.' },
  { key: 'search_impression', why: 'Appearing in a result list is not an evaluation.' },
  { key: 'passport_view', why: 'Reading a Passport is not an evaluation.' },
];

export const COVERAGE_POLICY = {
  version: EVALUATION_COVERAGE_POLICY_VERSION,
  // A player decided on recently is not "missed" — the club just looked.
  // Second Look, not Nobody Missed, handles them if evidence changes.
  recentDecisionDays: 90,
  // An assessment older than this no longer counts as current evaluation.
  assessmentFreshDays: 365,
  note: 'Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.',
};

/**
 * Is this player meaningfully evaluated by this organisation?
 * Returns the signals, so "why is this player not here?" is always answerable.
 */
export function isMeaningfullyEvaluated(signals = {}, { now = Date.now() } = {}) {
  const hits = EVALUATION_SIGNAL_KEYS.filter((k) => !!signals[k]);
  const recentDecisionAt = signals.lastDecisionAt ?? null;
  const recentlyDecided = !!recentDecisionAt && (now - recentDecisionAt) < COVERAGE_POLICY.recentDecisionDays * 86_400_000;
  return {
    evaluated: hits.length > 0,
    signals: hits,
    recentlyDecided,
    policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
  };
}

// ------------------------------------------------------------------- briefs

export const BRIEF_STATUSES = ['draft', 'active', 'paused', 'closed', 'archived'];
export const BRIEF_TRANSITIONS = {
  draft: ['active', 'archived'],
  active: ['paused', 'closed', 'archived'],
  paused: ['active', 'closed', 'archived'],
  closed: ['active', 'archived'],
  archived: [],
};
export const canBriefTransition = (from, to) => (BRIEF_TRANSITIONS[from] ?? []).includes(to);

export const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'];
export const POSITION_GROUP_OF = {
  GK: 'GK',
  CB: 'DEF', RB: 'DEF', LB: 'DEF', RWB: 'DEF', LWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID',
  RW: 'ATT', LW: 'ATT', ST: 'ATT', CF: 'ATT',
};
export const POSITION_GROUPS = ['GK', 'DEF', 'MID', 'ATT'];

export const EVIDENCE_REQUIREMENTS = [
  { key: 'recent_full_match', label: 'Recent full match available' },
  { key: 'coach_reference', label: 'Verified coach reference available' },
  { key: 'confirmed_current_club', label: 'Current club confirmed' },
  { key: 'combine_verified', label: 'Combine Verified result available' },
];

export const TRUST_BANDS = ['limited_evidence', 'developing_evidence', 'established_evidence', 'strong_evidence', 'very_strong_evidence'];

/**
 * Criteria a brief may NEVER contain. Reuses M17's protected-characteristic
 * list so the two systems cannot drift apart, plus the recruitment-specific
 * proxies a brief could otherwise smuggle a protected trait through.
 */
export const PROHIBITED_BRIEF_FIELDS = [
  'race', 'ethnicity', 'skin_colour', 'skin_color', 'religion', 'faith', 'caste',
  'disability', 'medical_condition', 'mental_health',
  'gender_identity', 'sexuality', 'sexual_orientation',
  'socioeconomic', 'social_background', 'family_income', 'school_type',
  'postcode_deprivation', 'deprivation', 'maturity', 'biological_age',
  'physical_maturity', 'immigration_status', 'national_origin',
];

export function validateRecruitmentBrief(input = {}, { orgLevel = 'pro' } = {}) {
  const errs = [];
  const title = String(input.title ?? '').trim().slice(0, 120);
  if (!title) errs.push({ field: 'title', error: 'BRIEF_TITLE_REQUIRED' });

  // A protected characteristic must never become a recruitment filter.
  const offered = Object.keys(input).map((k) => k.toLowerCase().replace(/[^a-z]+/g, '_'));
  const prohibited = offered.filter((k) => PROHIBITED_BRIEF_FIELDS.some((p) => k === p || k.includes(p)));
  if (prohibited.length) {
    return { ok: false, error: 'BRIEF_CRITERION_PROHIBITED', prohibited, message: 'A recruitment brief can never filter players by a protected characteristic.' };
  }

  const positions = Array.isArray(input.positions) ? [...new Set(input.positions.map(String))] : [];
  const unknownPos = positions.filter((p) => !POSITIONS.includes(p));
  if (unknownPos.length) errs.push({ field: 'positions', error: 'BRIEF_POSITION_UNKNOWN', unknown: unknownPos });

  const minAge = input.minAge == null ? null : Number(input.minAge);
  const maxAge = input.maxAge == null ? null : Number(input.maxAge);
  for (const [k, v] of [['minAge', minAge], ['maxAge', maxAge]]) {
    if (v != null && (!Number.isInteger(v) || v < 5 || v > 60)) errs.push({ field: k, error: 'BRIEF_AGE_INVALID' });
  }
  if (minAge != null && maxAge != null && minAge > maxAge) errs.push({ field: 'ageRange', error: 'BRIEF_AGE_RANGE_INVALID' });

  const radiusKm = input.radiusKm == null ? null : Number(input.radiusKm);
  if (radiusKm != null && (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20000)) {
    errs.push({ field: 'radiusKm', error: 'BRIEF_RADIUS_INVALID' });
  }

  const maxLevel = input.maxLevel ?? null;
  if (maxLevel != null && !['amateur', 'semi_pro', 'pro'].includes(maxLevel)) errs.push({ field: 'maxLevel', error: 'BRIEF_LEVEL_UNKNOWN' });

  const evidence = Array.isArray(input.evidenceRequirements) ? [...new Set(input.evidenceRequirements.map(String))] : [];
  const unknownEv = evidence.filter((e) => !EVIDENCE_REQUIREMENTS.some((r) => r.key === e));
  if (unknownEv.length) errs.push({ field: 'evidenceRequirements', error: 'BRIEF_EVIDENCE_REQUIREMENT_UNKNOWN', unknown: unknownEv });

  const minTrustBand = input.minTrustBand ?? null;
  if (minTrustBand != null && !TRUST_BANDS.includes(minTrustBand)) errs.push({ field: 'minTrustBand', error: 'BRIEF_TRUST_BAND_UNKNOWN' });

  const combineProtocols = Array.isArray(input.combineProtocols) ? [...new Set(input.combineProtocols.map(String))] : [];

  const activeFrom = input.activeFrom ?? null;
  const activeUntil = input.activeUntil ?? null;
  if (activeFrom && activeUntil && String(activeFrom) > String(activeUntil)) {
    errs.push({ field: 'activeWindow', error: 'BRIEF_WINDOW_INVALID' });
  }

  if (errs.length) return { ok: false, error: 'BRIEF_INVALID', details: errs, message: 'This recruitment brief cannot be saved as written.' };

  const criteria = {
    positions,
    positionGroups: [...new Set(positions.map((p) => POSITION_GROUP_OF[p]))],
    minAge, maxAge,
    radiusKm: orgLevel === 'grassroots' ? Math.min(radiusKm ?? 50, 50) : radiusKm,
    maxLevel: orgLevel === 'grassroots' ? 'semi_pro' : maxLevel,
    foot: ['Left', 'Right', 'Both'].includes(input.foot) ? input.foot : null,
    availability: input.availability ? String(input.availability).slice(0, 40) : null,
    evidenceRequirements: evidence,
    minTrustBand,
    combineProtocols,
  };
  return { ok: true, title, criteria, activeFrom: activeFrom ?? null, activeUntil: activeUntil ?? null };
}

/** A brief's criteria in plain language. There are no hidden criteria. */
export function explainBriefCriteria(criteria = {}) {
  const out = [];
  if (criteria.positions?.length) out.push({ key: 'positions', label: 'Position', value: criteria.positions.join(', ') });
  if (criteria.minAge != null || criteria.maxAge != null) {
    out.push({ key: 'age', label: 'Age', value: `${criteria.minAge ?? 'any'}–${criteria.maxAge ?? 'any'}` });
  }
  if (criteria.radiusKm != null) out.push({ key: 'radius', label: 'Within', value: `${criteria.radiusKm} km` });
  if (criteria.maxLevel) out.push({ key: 'maxLevel', label: 'Up to level', value: criteria.maxLevel });
  if (criteria.foot) out.push({ key: 'foot', label: 'Foot', value: criteria.foot });
  if (criteria.availability) out.push({ key: 'availability', label: 'Availability', value: criteria.availability });
  for (const e of criteria.evidenceRequirements ?? []) {
    out.push({ key: `evidence:${e}`, label: 'Evidence', value: EVIDENCE_REQUIREMENTS.find((r) => r.key === e)?.label ?? e });
  }
  if (criteria.minTrustBand) out.push({ key: 'minTrustBand', label: 'Minimum evidence confidence', value: criteria.minTrustBand });
  for (const p of criteria.combineProtocols ?? []) out.push({ key: `combine:${p}`, label: 'Combine', value: `${p} result available` });
  return out;
}

// --------------------------------------------------------------- matching

const BAND_RANK = Object.fromEntries(TRUST_BANDS.map((b, i) => [b, i]));

/**
 * Does this player match this brief? Boolean rules only — no weights, no
 * scoring, no preference ordering. Every criterion produces an explicit
 * `met`/`not_met` reason so "why is this player here?" is always answerable.
 *
 * `facts` is the lightweight match projection, never a full Passport.
 */
export function playerMatchesBrief(facts, criteria = {}) {
  const reasons = [];
  const fail = (key, text) => { reasons.push({ key, met: false, text }); };
  const pass = (key, text) => { reasons.push({ key, met: true, text }); };

  if (criteria.positions?.length) {
    const has = [facts.position, ...(facts.secondaryPositions ?? [])].filter(Boolean);
    if (has.some((p) => criteria.positions.includes(p))) pass('position', `Matches position criteria (${has.filter((p) => criteria.positions.includes(p)).join(', ')})`);
    else fail('position', 'Does not match the position criteria');
  }
  if (criteria.minAge != null || criteria.maxAge != null) {
    // Fail closed: an unknown age cannot satisfy an age criterion.
    if (facts.age == null) fail('age', 'Age is not on record');
    else if (criteria.minAge != null && facts.age < criteria.minAge) fail('age', `Age ${facts.age} is below the criteria`);
    else if (criteria.maxAge != null && facts.age > criteria.maxAge) fail('age', `Age ${facts.age} is above the criteria`);
    else pass('age', `Matches age criteria (${facts.age})`);
  }
  if (criteria.maxLevel === 'semi_pro' && facts.level === 'pro') fail('level', 'Plays at a level above the criteria');
  else if (criteria.maxLevel) pass('level', 'Within the level criteria');

  if (criteria.radiusKm != null) {
    // Fail closed on a missing distance, exactly as the standing gates do.
    if (facts.distanceKm == null) fail('location', 'Distance could not be established');
    else if (facts.distanceKm > criteria.radiusKm) fail('location', 'Outside the permitted search area');
    else pass('location', 'Within the club’s permitted search area');
  }
  if (criteria.foot) {
    if (!facts.foot) fail('foot', 'Preferred foot is not on record');
    else if (facts.foot === criteria.foot || facts.foot === 'Both') pass('foot', `Matches foot criteria (${facts.foot})`);
    else fail('foot', 'Does not match the foot criteria');
  }
  if (criteria.availability) {
    if (!facts.availability) fail('availability', 'Availability is not on record');
    else if (facts.availability === criteria.availability) pass('availability', 'Matches the availability criteria');
    else fail('availability', 'Does not match the availability criteria');
  }
  for (const key of criteria.evidenceRequirements ?? []) {
    const label = EVIDENCE_REQUIREMENTS.find((r) => r.key === key)?.label ?? key;
    if (facts.evidenceFlags?.[key]) pass(`evidence:${key}`, label);
    else fail(`evidence:${key}`, `${label} — not on record`);
  }
  if (criteria.minTrustBand) {
    const have = BAND_RANK[facts.trustBand];
    const need = BAND_RANK[criteria.minTrustBand];
    // Evidence confidence, never an ability filter — and never a global wall.
    if (have == null) fail('minTrustBand', 'Evidence confidence is not available');
    else if (have >= need) pass('minTrustBand', `Evidence confidence meets the criteria (${facts.trustBand})`);
    else fail('minTrustBand', `Evidence confidence is below the criteria (${facts.trustBand})`);
  }
  for (const p of criteria.combineProtocols ?? []) {
    if (facts.combineProtocols?.includes(p)) pass(`combine:${p}`, `${p} Combine Verified result available`);
    else fail(`combine:${p}`, `No ${p} Combine Verified result`);
  }

  return { matched: reasons.every((r) => r.met), reasons };
}

/**
 * A Nobody Missed candidate: a matching, visible, never-evaluated player with
 * the full explanation of why they are here.
 */
export function buildNobodyMissedCandidate({ facts, brief, match, evaluation, roomOpen }) {
  if (!match.matched) return null;
  if (roomOpen) return null;              // already being evaluated
  if (evaluation.evaluated) return null;  // already entered the workflow
  return {
    playerId: facts.playerId,
    briefId: brief.id,
    briefVersion: brief.version,
    policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
    name: facts.name,
    position: facts.position,
    age: facts.age,
    trustBand: facts.trustBand,
    trustNote: 'Evidence confidence — not football ability.',
    // "Why is this player here?" — every criterion, plus the workflow fact.
    reasons: [
      ...match.reasons,
      { key: 'no_room', met: true, text: 'No Recruitment Room in your organisation' },
    ],
    note: 'Eligible under your own criteria and not yet evaluated. This is workflow coverage, not a judgement of the player.',
  };
}

/**
 * Evaluation coverage. A count over a declared denominator, named honestly.
 * Small groups are suppressed using the platform's existing convention.
 */
export function evaluationCoverageState({ eligible, evaluated, suppressMin = 3 }) {
  const notYet = Math.max(0, eligible - evaluated);
  if (eligible > 0 && eligible < suppressMin) {
    return {
      eligible, evaluated: null, notYetEvaluated: null, coveragePercent: null,
      suppressed: true,
      note: `Fewer than ${suppressMin} eligible players match this brief — the breakdown is suppressed.`,
      policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
    };
  }
  return {
    eligible,
    evaluated,
    notYetEvaluated: notYet,
    coveragePercent: eligible === 0 ? null : Math.round((evaluated / eligible) * 100),
    suppressed: false,
    complete: eligible > 0 && notYet === 0,
    note: COVERAGE_POLICY.note,
    policyVersion: EVALUATION_COVERAGE_POLICY_VERSION,
  };
}

export const NOBODY_MISSED_STATES = ['open', 'reviewed', 'added_to_room', 'dismissed'];

export const NM_DISMISSAL_REASONS = [
  'already_known', 'not_current_need', 'evidence_insufficient',
  'role_mismatch_after_review', 'timing', 'other',
];

/** Default orderings. None of them is a quality rank. */
export const NM_SORTS = ['newest_evidence', 'last_reviewed', 'name', 'distance', 'evidence_confidence'];

export function orderNobodyMissed(items = [], sort = 'newest_evidence') {
  const by = {
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
    distance: (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
    evidence_confidence: (a, b) => (BAND_RANK[b.trustBand] ?? -1) - (BAND_RANK[a.trustBand] ?? -1),
    newest_evidence: (a, b) => (b.lastEvidenceAt ?? 0) - (a.lastEvidenceAt ?? 0),
    last_reviewed: (a, b) => (a.reviewedAt ?? 0) - (b.reviewedAt ?? 0),
  }[sort] ?? (() => 0);
  return items.slice().sort((a, b) => by(a, b) || String(a.playerId).localeCompare(String(b.playerId)));
}

// =====================================================================
// SHARED
// =====================================================================

export const M18_EVENT_TYPES = [
  'second_look_created', 'second_look_reviewed', 'second_look_dismissed',
  'recruitment_room_reopened_from_second_look',
  'recruitment_brief_created', 'recruitment_brief_activated', 'recruitment_brief_updated',
  'nobody_missed_player_reviewed', 'nobody_missed_player_added_to_room', 'nobody_missed_player_dismissed',
];

export const LIMITS = {
  briefTitle: 120,
  briefsPerOrg: 40,
  briefWritesPerHour: 60,
  reviewActionsPerHour: 300,
  pageSize: 25,
  maxPageSize: 100,
  maxCandidateScan: 2000,
};

export const clampPage = (n, fallback = LIMITS.pageSize) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), LIMITS.maxPageSize) : fallback;
};

/**
 * The viewer-safe projection. M18 output is organisation-private and carries
 * only facts the club could already read about the player.
 */
export function safeM18Projection(item) {
  if (!item) return null;
  const { orgId, ...rest } = item;
  return rest;
}

/**
 * M18.2 — is a Recruitment Brief live on a given calendar day?
 *
 * `activeFrom` / `activeUntil` are calendar days ('YYYY-MM-DD'), inclusive at
 * both ends, compared as UTC calendar-day strings. There is no time-of-day and
 * no time zone on a brief: a brief that runs "until the 30th" is live for the
 * whole of the 30th everywhere, and stops being live at the first UTC instant
 * of the 31st. Extracted from the Nobody Missed router so the boundary can be
 * tested without a clock.
 */
export function briefIsLiveOn(b, today = new Date().toISOString().slice(0, 10)) {
  if (!b || b.status !== 'active') return false;
  if (b.activeFrom && today < String(b.activeFrom)) return false;
  if (b.activeUntil && today > String(b.activeUntil)) return false;
  return true;
}
