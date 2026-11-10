// Second Look (has something changed about a player since the club's decision, relevant to the reason it gave?)
// and Nobody Missed (which eligible players match the club's own criteria but never entered its workflow?).
// Neither scores or ranks players; every output is a list of plain facts.
//
// The import of the match engine is circular (it reads this file's vocabulary), which is safe because the engine
// touches that vocabulary only inside function bodies — see the lazy band rank in matching/match.mjs.
import { matchBrief } from './matching/match.mjs';
import { parseStrictDateOnly, isDayWithin, isAbsent } from '../../temporal.mjs';

// =====================================================================
// SECOND LOOK POLICY
// =====================================================================

export const SECOND_LOOK_POLICY_VERSION = 1;

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
  // A restoration is news to a club that saw the result disappear; without it the "no longer valid" note would
  // stand for ever.
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

/** A change that reduces the evidence available. Not framed as wrongdoing. */
export const NEGATIVE_CHANGE_TYPES = [
  'evidence_removed',
  'evidence_disputed',
  'verified_reference_revoked',
  'combine_verified_invalidated',
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

/** Which changes may mean the archive reason a club gave no longer applies. */
export const REASON_CHANGE_MAP = {
  insufficient_recent_evidence: [
    'full_match_added',
    'evidence_added',
    'evidence_quality_improved',
    'evidence_gap_closed',
  ],
  insufficient_full_match: ['full_match_added', 'evidence_gap_closed'],
  reference_missing: ['verified_reference_added'],
  combine_missing: ['combine_verified_added', 'combine_verified_restored'],
  trial_needed: ['trial_completed'],
  continue_monitoring: [
    'full_match_added',
    'verified_reference_added',
    'combine_verified_added',
    'trial_completed',
    'current_club_confirmed',
    'evidence_gap_closed',
  ],
  // Physical development is read as evidence becoming available, not as a prediction about a body.
  physical_profile: ['development_block_completed', 'combine_verified_added'],
  // A role judgement is revisited only on evidence that could change it, not a reference.
  technical_fit: ['full_match_added', 'trial_completed'],
  tactical_fit: ['full_match_added', 'trial_completed'],
  development_upside: ['development_block_completed', 'full_match_added'],
  // A soft judgement, revisited only on substantial evidence, not a trickle of small updates.
  not_current_priority: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed'],
  position_need: ['position_changed'],
  trial_outcome: ['trial_completed'],
  // Facts about the club, not the player: no new footage makes a squad place or a budget appear.
  squad_space: [],
  budget: [],
  timing: [],
  registration: [],
  travel_logistics: [],
  eligibility: [],
  // A player fact, but nothing emits an availability-changed event yet.
  player_unavailable: [],
};

/** Reasons that can never be resolved by a change in the player's record. */
export const CLUB_SIDE_REASONS = Object.entries(REASON_CHANGE_MAP)
  .filter(([, types]) => types.length === 0)
  .map(([code]) => code);

export const POLICY = {
  version: SECOND_LOOK_POLICY_VERSION,

  // A change unrelated to the reason must clear a higher bar, so a trickle of updates does not resurface a player:
  // this many distinct changes, or one substantial one.
  generalThreshold: {
    minChanges: 2,
    substantialTypes: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed'],
  },

  // A single training session is not a Second Look: only the first development evidence since the review, or a
  // completed coach-assigned block, counts.
  boxCam: {
    countSessionsAsChange: false,
    minSessionsForFirstEvidence: 1,
  },

  // Once reviewed or dismissed, the same evidence cannot regenerate an item; new evidence can, immediately.
  cooldownDays: 30,

  expiryDays: 120,

  // No upper bound on how long ago a club decided.
  maxDecisionAgeDays: null,
};

export const SECOND_LOOK_STATUSES = ['open', 'reviewed', 'dismissed', 'reopened_room', 'expired'];

export const SECOND_LOOK_TRANSITIONS = {
  open: ['reviewed', 'dismissed', 'reopened_room', 'expired'],
  reviewed: ['dismissed', 'reopened_room', 'expired'],
  dismissed: ['open'], // only via genuinely new evidence
  reopened_room: [], // terminal: the club acted
  expired: ['open'], // only via genuinely new evidence
};

export const canSecondLookTransition = (from, to) => (SECOND_LOOK_TRANSITIONS[from] ?? []).includes(to);

export const SECOND_LOOK_KINDS = [
  'direct_reason_resolved',
  'significant_new_evidence',
  'evidence_removed',
  'general_update',
];

export const SECOND_LOOK_KIND_COPY = {
  direct_reason_resolved: 'Worth Another Look',
  significant_new_evidence: 'New Since Your Review',
  evidence_removed: 'Evidence Changed',
  general_update: 'New Since Your Review',
};

const KIND_ORDER = Object.fromEntries(SECOND_LOOK_KINDS.map((k, i) => [k, i]));

export const DISMISSAL_REASONS = [
  'already_reviewed_elsewhere',
  'change_not_material',
  'timing_not_right',
  'squad_need_changed',
  'no_action_required',
  'other',
];

// Tests sweep output for the forbidden copy: Second Look must not tell a club it was wrong or what to do.
export const SECOND_LOOK_DISCLAIMER =
  'Second Look reports what changed in a player’s record since your decision. It does not judge that decision and does not recommend whether to sign anyone.';

export const FORBIDDEN_COPY = [
  'wrong decision',
  'you were wrong',
  'mistake',
  'should sign',
  'should recruit',
  'missed talent',
  'best available',
  'better than',
  'probability of success',
  'potential score',
  'talent score',
];

// ------------------------------------------------------- change normalization

/** Normalise a source-system fact into a change record. Only identity, time and type travel, not the payload. */
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

/** Excludes the timestamp: the same source fact seen twice is the same change. */
export const changeFingerprint = ({ type, sourceSystem, sourceId }) => `${type}:${sourceSystem}:${sourceId ?? 'none'}`;

/**
 * One real-world change often arrives through several systems at once (a Combine result appears in the Combine
 * projection, the Passport and Trust). Keep the earliest observation.
 */
export function dedupeMaterialChanges(changes = []) {
  const byPrint = new Map();
  for (const c of changes) {
    if (!c) continue;
    const prev = byPrint.get(c.fingerprint);
    if (!prev || c.occurredAt < prev.occurredAt) byPrint.set(c.fingerprint, c);
  }
  return [...byPrint.values()].sort(
    (a, b) => b.occurredAt - a.occurredAt || a.fingerprint.localeCompare(b.fingerprint),
  );
}

export function changesSinceDecision(changes = [], decisionAt) {
  if (!Number.isFinite(decisionAt)) return [];
  const now = Date.now();
  return dedupeMaterialChanges(
    changes.filter(
      (c) =>
        c &&
        c.occurredAt > decisionAt &&
        // A future timestamp is a forged or broken event, not a change.
        c.occurredAt <= now,
    ),
  );
}

// ------------------------------------------------------------ reason matching

export function secondLookReasonMatch(change, reasonCodes = []) {
  if (!change) return [];
  return reasonCodes.filter((code) => (REASON_CHANGE_MAP[code] ?? []).includes(change.type));
}

export function meetsGeneralThreshold(changes = []) {
  const positive = changes.filter((c) => !c.negative);
  if (positive.some((c) => POLICY.generalThreshold.substantialTypes.includes(c.type))) return true;
  return positive.length >= POLICY.generalThreshold.minChanges;
}

// -------------------------------------------------- snapshot vs current state

/** `available: false` means the snapshot cannot reconstruct the previous value, not that it was zero. */
export function compareToSnapshot(snapshot, current) {
  const row = (key, label, was, now, wasKnown) => ({
    key,
    label,
    was: wasKnown ? was : null,
    now,
    available: !!wasKnown,
    changed: wasKnown ? JSON.stringify(was) !== JSON.stringify(now) : null,
  });
  const s = snapshot ?? null;
  const refs = s?.sourceRefs ?? null;
  return {
    available: !!s,
    at: s?.at ?? null,
    note: s ? null : 'Previous detail unavailable — no decision-time snapshot was recorded.',
    rows: [
      row(
        'trust',
        'Evidence confidence',
        s?.trust ? { score: s.trust.score, band: s.trust.band } : null,
        current.trust ? { score: current.trust.score, band: current.trust.band } : null,
        !!s?.trust,
      ),
      row(
        'evidence',
        'Evidence items',
        refs?.evidenceIds?.length ?? null,
        current.evidenceIds?.length ?? 0,
        !!refs?.evidenceIds,
      ),
      row(
        'references',
        'Verified coach references',
        current.referencesAtDecision ?? null,
        current.references ?? 0,
        current.referencesAtDecision != null,
      ),
      row(
        'combine',
        'Combine Verified protocols',
        refs?.combineResults?.length ?? null,
        current.combineResults?.length ?? 0,
        !!refs?.combineResults,
      ),
      row(
        'assessments',
        'Assessments in your organisation',
        refs?.assessmentIds?.length ?? null,
        current.assessmentIds?.length ?? 0,
        !!refs?.assessmentIds,
      ),
      row('trials', 'Trials', refs?.trialIds?.length ?? null, current.trialIds?.length ?? 0, !!refs?.trialIds),
    ],
  };
}

/**
 * Trust movement from the snapshot's component levels. The snapshot drops per-component coverage because a club
 * may not see it, so levels are compared instead. Movement is context only, never a trigger on its own.
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

// A snapshot stores a level id string; the `{id}` shape is tolerated too.
const levelId = (v) => (typeof v === 'string' ? v : (v?.id ?? null));

// -------------------------------------------------------- candidate assembly

/** `null` (the common case) when the player should not be surfaced. */
export function buildSecondLookCandidate({
  room,
  decision,
  snapshot,
  changes = [],
  trustMovement = [],
  playerVisible = true,
  currentTrust = null,
  now = Date.now(),
}) {
  if (!room || !decision) return null;
  if (!playerVisible) return null;
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
      ? 'significant_new_evidence'
      : 'general_update';
  } else if (negative.length) kind = 'evidence_removed';

  if (!kind) return null;

  // Club-side reasons are reported as still standing so the UI cannot imply otherwise.
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
    changes: directed.map(({ change, relatesTo }) => ({ ...change, relatesTo })),
    changeCount: material.length,
    directReasonCodes: [...new Set(direct.flatMap((d) => d.relatesTo))],
    unresolvedReasonCodes: unresolved,
    changeFingerprints: material.map((c) => c.fingerprint).sort(),
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
    // Lead with the most substantial change, not merely the most recent.
    const headline = direct.find((d) => POLICY.generalThreshold.substantialTypes.includes(d.change.type)) ?? direct[0];
    return `${CHANGE_COPY[headline.change.type]} This relates to the reason recorded when the room was closed.`;
  }
  if (kind === 'evidence_removed') {
    return `${material.length === 1 ? 'One source' : `${material.length} sources`} used in the previous review ${material.length === 1 ? 'is' : 'are'} no longer current.`;
  }
  return `${material.length} material ${material.length === 1 ? 'change' : 'changes'} since your review.`;
}

/** Should an item be (re)surfaced, given what this club already did with the same evidence? */
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
  (candidate.changes ?? []).some(
    (c) => fingerprints.includes(c.fingerprint) && POLICY.generalThreshold.substantialTypes.includes(c.type),
  );

export const secondLookExpired = (item, now = Date.now()) =>
  item.status === 'open' && now - (item.latestChangeAt ?? item.createdAt) > POLICY.expiryDays * 86_400_000;

export const orderSecondLook = (items = []) =>
  items
    .slice()
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        b.latestChangeAt - a.latestChangeAt ||
        String(a.id ?? '').localeCompare(String(b.id ?? '')),
    );

// =====================================================================
// NOBODY MISSED
// =====================================================================

export const EVALUATION_COVERAGE_POLICY_VERSION = 1;

// What counts as meaningfully evaluated. Passive impressions are excluded: they are not evaluation, and the store
// that holds them is lossy.
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

/** Recorded so the exclusion is auditable. */
export const NON_EVALUATION_SIGNALS = [
  { key: 'profile_view', why: 'Opening a profile is not an evaluation.' },
  { key: 'search_impression', why: 'Appearing in a result list is not an evaluation.' },
  { key: 'passport_view', why: 'Reading a Passport is not an evaluation.' },
];

export const COVERAGE_POLICY = {
  version: EVALUATION_COVERAGE_POLICY_VERSION,
  // A recently decided player is not "missed"; Second Look handles them if evidence changes.
  recentDecisionDays: 90,
  assessmentFreshDays: 365,
  note: 'Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.',
};

export function isMeaningfullyEvaluated(signals = {}, { now = Date.now() } = {}) {
  const hits = EVALUATION_SIGNAL_KEYS.filter((k) => !!signals[k]);
  const recentDecisionAt = signals.lastDecisionAt ?? null;
  const recentlyDecided =
    !!recentDecisionAt && now - recentDecisionAt < COVERAGE_POLICY.recentDecisionDays * 86_400_000;
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
  CB: 'DEF',
  RB: 'DEF',
  LB: 'DEF',
  RWB: 'DEF',
  LWB: 'DEF',
  CDM: 'MID',
  CM: 'MID',
  CAM: 'MID',
  RW: 'ATT',
  LW: 'ATT',
  ST: 'ATT',
  CF: 'ATT',
};
export const POSITION_GROUPS = ['GK', 'DEF', 'MID', 'ATT'];

export const EVIDENCE_REQUIREMENTS = [
  { key: 'recent_full_match', label: 'Recent full match available' },
  { key: 'coach_reference', label: 'Verified coach reference available' },
  { key: 'confirmed_current_club', label: 'Current club confirmed' },
  { key: 'combine_verified', label: 'Combine Verified result available' },
];

export const TRUST_BANDS = [
  'limited_evidence',
  'developing_evidence',
  'established_evidence',
  'strong_evidence',
  'very_strong_evidence',
];

/** Protected characteristics, plus the proxies a brief could smuggle one through. */
export const PROHIBITED_BRIEF_FIELDS = [
  'race',
  'ethnicity',
  'skin_colour',
  'skin_color',
  'religion',
  'faith',
  'caste',
  'disability',
  'medical_condition',
  'mental_health',
  'gender_identity',
  'sexuality',
  'sexual_orientation',
  'socioeconomic',
  'social_background',
  'family_income',
  'school_type',
  'postcode_deprivation',
  'deprivation',
  'maturity',
  'biological_age',
  'physical_maturity',
  'immigration_status',
  'national_origin',
];

export function validateRecruitmentBrief(input = {}, { orgLevel = 'pro', protocols = null } = {}) {
  const errs = [];
  // A field of the wrong type is refused rather than coerced; over-long free text is shortened.
  if (input.title != null && typeof input.title !== 'string') errs.push({ field: 'title', error: 'FIELD_INVALID' });
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';
  if (!title && !errs.length) errs.push({ field: 'title', error: 'BRIEF_TITLE_REQUIRED' });
  const listOf = (k) => {
    if (input[k] == null) return [];
    if (!Array.isArray(input[k])) {
      errs.push({ field: k, error: 'FIELD_INVALID' });
      return [];
    }
    return [...new Set(input[k].map(String))];
  };

  const offered = Object.keys(input).map((k) => k.toLowerCase().replace(/[^a-z]+/g, '_'));
  const prohibited = offered.filter((k) => PROHIBITED_BRIEF_FIELDS.some((p) => k === p || k.includes(p)));
  if (prohibited.length) {
    return {
      ok: false,
      error: 'BRIEF_CRITERION_PROHIBITED',
      prohibited,
      message: 'A recruitment brief can never filter players by a protected characteristic.',
    };
  }

  const positions = listOf('positions');
  const unknownPos = positions.filter((p) => !POSITIONS.includes(p));
  if (unknownPos.length) errs.push({ field: 'positions', error: 'BRIEF_POSITION_UNKNOWN', unknown: unknownPos });

  const minAge = input.minAge == null ? null : Number(input.minAge);
  const maxAge = input.maxAge == null ? null : Number(input.maxAge);
  for (const [k, v] of [
    ['minAge', minAge],
    ['maxAge', maxAge],
  ]) {
    if (v != null && (!Number.isInteger(v) || v < 5 || v > 60)) errs.push({ field: k, error: 'BRIEF_AGE_INVALID' });
  }
  if (minAge != null && maxAge != null && minAge > maxAge)
    errs.push({ field: 'ageRange', error: 'BRIEF_AGE_RANGE_INVALID' });

  const radiusKm = input.radiusKm == null ? null : Number(input.radiusKm);
  if (radiusKm != null && (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20000)) {
    errs.push({ field: 'radiusKm', error: 'BRIEF_RADIUS_INVALID' });
  }

  const maxLevel = input.maxLevel ?? null;
  if (maxLevel != null && !['amateur', 'semi_pro', 'pro'].includes(maxLevel))
    errs.push({ field: 'maxLevel', error: 'BRIEF_LEVEL_UNKNOWN' });

  const evidence = listOf('evidenceRequirements');
  const unknownEv = evidence.filter((e) => !EVIDENCE_REQUIREMENTS.some((r) => r.key === e));
  if (unknownEv.length)
    errs.push({ field: 'evidenceRequirements', error: 'BRIEF_EVIDENCE_REQUIREMENT_UNKNOWN', unknown: unknownEv });

  const minTrustBand = input.minTrustBand ?? null;
  if (minTrustBand != null && !TRUST_BANDS.includes(minTrustBand))
    errs.push({ field: 'minTrustBand', error: 'BRIEF_TRUST_BAND_UNKNOWN' });

  const combineProtocols = listOf('combineProtocols');
  const unknownProtocols = protocols ? combineProtocols.filter((p) => !protocols.includes(p)) : [];
  if (unknownProtocols.length)
    errs.push({ field: 'combineProtocols', error: 'BRIEF_COMBINE_PROTOCOL_UNKNOWN', unknown: unknownProtocols });

  const foot = input.foot ?? null;
  if (foot !== null && !['Left', 'Right', 'Both'].includes(foot))
    errs.push({ field: 'foot', error: 'BRIEF_FOOT_UNKNOWN' });
  const availability = input.availability ?? null;
  if (availability !== null && typeof availability !== 'string')
    errs.push({ field: 'availability', error: 'FIELD_INVALID' });

  // An unreadable `activeUntil` must not compare as "never passed" and keep a brief live for ever.
  const activeFrom = isAbsent(input.activeFrom) ? null : input.activeFrom;
  const activeUntil = isAbsent(input.activeUntil) ? null : input.activeUntil;
  if (activeFrom !== null && !parseStrictDateOnly(activeFrom).ok)
    errs.push({ field: 'activeFrom', error: 'DATE_INVALID' });
  if (activeUntil !== null && !parseStrictDateOnly(activeUntil).ok)
    errs.push({ field: 'activeUntil', error: 'DATE_INVALID' });
  if (activeFrom && activeUntil && String(activeFrom) > String(activeUntil)) {
    errs.push({ field: 'activeWindow', error: 'BRIEF_WINDOW_INVALID' });
  }

  if (errs.length)
    return {
      ok: false,
      error: 'BRIEF_INVALID',
      details: errs,
      message: 'This recruitment brief cannot be saved as written.',
    };

  const criteria = {
    positions,
    positionGroups: [...new Set(positions.map((p) => POSITION_GROUP_OF[p]))],
    minAge,
    maxAge,
    radiusKm: orgLevel === 'grassroots' ? Math.min(radiusKm ?? 50, 50) : radiusKm,
    maxLevel: orgLevel === 'grassroots' ? 'semi_pro' : maxLevel,
    foot,
    availability: availability ? availability.slice(0, 40) : null,
    evidenceRequirements: evidence,
    minTrustBand,
    combineProtocols,
  };
  return { ok: true, title, criteria, activeFrom: activeFrom ?? null, activeUntil: activeUntil ?? null };
}

export function explainBriefCriteria(criteria = {}) {
  const out = [];
  if (criteria.positions?.length)
    out.push({ key: 'positions', label: 'Position', value: criteria.positions.join(', ') });
  if (criteria.minAge != null || criteria.maxAge != null) {
    out.push({ key: 'age', label: 'Age', value: `${criteria.minAge ?? 'any'}–${criteria.maxAge ?? 'any'}` });
  }
  if (criteria.radiusKm != null) out.push({ key: 'radius', label: 'Within', value: `${criteria.radiusKm} km` });
  if (criteria.maxLevel) out.push({ key: 'maxLevel', label: 'Up to level', value: criteria.maxLevel });
  if (criteria.foot) out.push({ key: 'foot', label: 'Foot', value: criteria.foot });
  if (criteria.availability) out.push({ key: 'availability', label: 'Availability', value: criteria.availability });
  for (const e of criteria.evidenceRequirements ?? []) {
    out.push({
      key: `evidence:${e}`,
      label: 'Evidence',
      value: EVIDENCE_REQUIREMENTS.find((r) => r.key === e)?.label ?? e,
    });
  }
  if (criteria.minTrustBand)
    out.push({ key: 'minTrustBand', label: 'Minimum evidence confidence', value: criteria.minTrustBand });
  for (const p of criteria.combineProtocols ?? [])
    out.push({ key: `combine:${p}`, label: 'Combine', value: `${p} result available` });
  return out;
}

// --------------------------------------------------------------- matching

/** Every criterion a brief carries is required. `facts` is the match projection, not a Passport. */
export function playerMatchesBrief(facts, criteria = {}, opts = {}) {
  return matchBrief(facts, criteria, opts);
}

export function buildNobodyMissedCandidate({ facts, brief, match, evaluation, roomOpen }) {
  if (!match.matched) return null;
  if (roomOpen) return null; // already being evaluated
  if (evaluation.evaluated) return null; // already entered the workflow
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
    reasons: [...match.reasons, { key: 'no_room', met: true, text: 'No Recruitment Room in your organisation' }],
    note: 'Eligible under your own criteria and not yet evaluated. This is workflow coverage, not a judgement of the player.',
  };
}

/** Small groups are suppressed, as elsewhere on the platform. */
export function evaluationCoverageState({ eligible, evaluated, suppressMin = 3 }) {
  const notYet = Math.max(0, eligible - evaluated);
  if (eligible > 0 && eligible < suppressMin) {
    return {
      eligible,
      evaluated: null,
      notYetEvaluated: null,
      coveragePercent: null,
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
  'already_known',
  'not_current_need',
  'evidence_insufficient',
  'role_mismatch_after_review',
  'timing',
  'other',
];

/** None of these orderings is a quality rank. */
export const NM_SORTS = ['newest_evidence', 'last_reviewed', 'name', 'distance', 'evidence_confidence'];

export function orderNobodyMissed(items = [], sort = 'newest_evidence') {
  const by =
    {
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
      distance: (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
      evidence_confidence: (a, b) => TRUST_BANDS.indexOf(b.trustBand) - TRUST_BANDS.indexOf(a.trustBand), // an unknown band (-1) last
      newest_evidence: (a, b) => (b.lastEvidenceAt ?? 0) - (a.lastEvidenceAt ?? 0),
      last_reviewed: (a, b) => (a.reviewedAt ?? 0) - (b.reviewedAt ?? 0),
    }[sort] ?? (() => 0);
  return items.slice().sort((a, b) => by(a, b) || String(a.playerId).localeCompare(String(b.playerId)));
}

// =====================================================================
// SHARED
// =====================================================================

export const SECOND_LOOK_EVENT_TYPES = [
  'second_look_created',
  'second_look_reviewed',
  'second_look_dismissed',
  'recruitment_room_reopened_from_second_look',
  'recruitment_brief_created',
  'recruitment_brief_activated',
  'recruitment_brief_updated',
  'nobody_missed_player_reviewed',
  'nobody_missed_player_added_to_room',
  'nobody_missed_player_dismissed',
];

export const LIMITS = {
  briefTitle: 120,
  briefsPerOrg: 40,
  briefWritesPerHour: 60,
  reviewActionsPerHour: 300,
  pageSize: 25,
  maxPageSize: 100,
  // No candidate cap: matching and Nobody Missed are SQL over every visible player (matching/query.mjs).
};

export const clampPage = (n, fallback = LIMITS.pageSize) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), LIMITS.maxPageSize) : fallback;
};

export function safeM18Projection(item) {
  if (!item) return null;
  const { orgId, ...rest } = item;
  return rest;
}

/**
 * `activeFrom` / `activeUntil` are UTC calendar days, inclusive: a brief "until the 30th" stops being live at the
 * first UTC instant of the 31st.
 */
export function briefIsLiveOn(b, today = new Date().toISOString().slice(0, 10)) {
  if (!b || b.status !== 'active') return false;
  // Unreadable bounds close the window.
  return isDayWithin(today, b.activeFrom, b.activeUntil);
}
