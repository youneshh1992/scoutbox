// M18 demo mirror (org side) — a SELF-CONTAINED Second Look / Nobody Missed /
// Recruitment Briefs fixture.
//
// ⚠ Circular-import discipline (the exact bug that crashed the M16.1 bundle):
// m18Api imports this module, so this module takes only TYPES from m18Api
// (`import type`, erased at build time). It never reads a runtime binding from
// m18Api, and it never calls an imported value at module-load time. Every
// constant used to build these fixtures — the change copy, the reason
// vocabulary, the dismissal reasons, the notes, the coverage policy — is
// declared right here.
//
// Same honesty rules as live:
//   • Nothing here is player-facing. No fixture says a player was "missed" or
//     "reconsidered" — those words exist nowhere in this product.
//   • Second Look reports what CHANGED. It never says the club's decision was
//     wrong and never recommends signing anyone.
//   • Nobody Missed is EVALUATION COVERAGE — workflow coverage over a declared
//     denominator. Never Scout Quality, Recruitment Quality, a Scouting Score
//     or a Fairness Score, and never a ranking by talent.
//   • The Trust Score is EVIDENCE CONFIDENCE and always travels with its note.
//   • A demo Combine result is labelled SIMULATED and is never counted as
//     production recruitment evidence — exactly as the server refuses it.
//
// The arithmetic is REAL. The coverage figures below are computed from the
// roster array by the same subtraction and rounding the server uses; they are
// not typed in by hand. Adding a candidate to a room really does move them from
// "not yet evaluated" to "evaluated", and the percentage really does move.
//
// Module-level arrays are deliberately MUTABLE so the demo behaves like the
// real thing: a dismissal stays dismissed, a review stays reviewed, and a
// reopened room stays reopened for the rest of the session.
import type {
  AddToRoomResult, BriefCriteria, BriefInput, BriefListResult, BriefSaveResult,
  ComparisonRow, EvaluationCoverage, EvaluationCoverageResult, EvaluationPolicy,
  M18Api, NobodyMissedItem, NobodyMissedReason, NobodyMissedResult,
  NobodyMissedReview, RecruitmentBrief, ReopenRoomResult, SecondLookChange,
  SecondLookChangesResult, SecondLookDetailResult, SecondLookItem,
  SecondLookListResult, TrustMovement,
} from './m18Api';

// ------------------------------------------------------------- local notes
const TRUST_NOTE = 'Evidence confidence — not football ability.';
const SECOND_LOOK_DISCLAIMER =
  'Second Look reports what changed in a player’s record since your decision. It does not judge that decision and does not recommend whether to sign anyone.';
const SECOND_LOOK_NOTE =
  'Second Look reports what changed since your decision. It never judges that decision, and a room only reopens when you choose to reopen it.';
const CHANGES_NOTE =
  'Only changes relevant to this decision are shown. A Trust Score movement is context — the underlying facts are the reason this item exists.';
const DISMISS_NOTE = 'Dismissed for your organisation only. Nothing about the player’s record changes.';
const REOPEN_NOTE = 'The archived decision remains in the room’s history. Reopening adds to it.';
const COVERAGE_NOTE =
  'Evaluation Coverage measures how many eligible players entered your evaluation workflow. It is not a measure of scouting quality, player talent, or freedom from bias.';
const NM_NOTE =
  'Eligible under your own criteria and not yet in your evaluation workflow. This is workflow coverage, not a judgement of any player, and nothing here is ranked by quality.';
const CANDIDATE_NOTE =
  'Eligible under your own criteria and not yet evaluated. This is workflow coverage, not a judgement of the player.';
const NM_REVIEW_NOTE = 'Reviewing a candidate records nothing on the player’s own record.';
const NM_DISMISS_NOTE = 'Dismissed for this brief only. Nothing is written to the player’s record.';
const BRIEF_NOTE = 'These are the only criteria used. There are no hidden criteria, no weights and no ranking.';
const NOT_LIVE_NOTE = 'Only an active brief inside its date window produces candidates.';

// ------------------------------------------------------ local vocabularies
const SECOND_LOOK_POLICY_VERSION = 1;
const COVERAGE_POLICY_VERSION = 1;
const RECENT_DECISION_DAYS = 90;
const SUPPRESS_MIN = 3;

const SECOND_LOOK_TRANSITIONS: Record<string, string[]> = {
  open: ['reviewed', 'dismissed', 'reopened_room', 'expired'],
  reviewed: ['dismissed', 'reopened_room', 'expired'],
  dismissed: ['open'],
  reopened_room: [],
  expired: ['open'],
};

const KIND_LABELS: Record<string, string> = {
  direct_reason_resolved: 'Worth Another Look',
  significant_new_evidence: 'New Since Your Review',
  evidence_removed: 'Evidence Changed',
  general_update: 'New Since Your Review',
};

const CHANGE_COPY: Record<string, string> = {
  full_match_added: 'A new full match has been added.',
  evidence_added: 'New evidence has been added to the player’s record.',
  evidence_quality_improved: 'Existing evidence has been independently confirmed.',
  evidence_removed: 'A source used in the previous review is no longer current.',
  evidence_disputed: 'A source used in the previous review is under review.',
  verified_reference_added: 'A verified coach reference has been added.',
  verified_reference_revoked: 'A coach reference used in the previous review is no longer verified.',
  combine_verified_added: 'A standardized Combine Verified result is now available.',
  combine_verified_invalidated: 'A Combine result used in the previous review is no longer valid.',
  development_evidence_started: 'Recorded development activity is now available for the first time since your review.',
  development_block_completed: 'A coach-assigned development block has been completed.',
  trial_completed: 'A trial has been completed and reported.',
  assessment_submitted: 'A new assessment has been submitted in your organisation.',
  current_club_confirmed: 'The player’s current club is now confirmed.',
  position_changed: 'The player’s declared position has changed.',
  evidence_gap_closed: 'An evidence gap your organisation raised has been filled.',
};

/** A reason absent from this map can NEVER be resolved by player evidence. */
const REASON_CHANGE_MAP: Record<string, string[]> = {
  insufficient_recent_evidence: ['full_match_added', 'evidence_added', 'evidence_quality_improved', 'evidence_gap_closed'],
  insufficient_full_match: ['full_match_added', 'evidence_gap_closed'],
  reference_missing: ['verified_reference_added'],
  combine_missing: ['combine_verified_added'],
  trial_needed: ['trial_completed'],
  technical_fit: ['full_match_added', 'trial_completed'],
  tactical_fit: ['full_match_added', 'trial_completed'],
  not_current_priority: ['full_match_added', 'verified_reference_added', 'combine_verified_added', 'trial_completed'],
  // Club-side facts. No amount of new footage makes a squad place or a budget
  // appear, and pretending otherwise would be a lie dressed up as a feature.
  squad_space: [], budget: [], timing: [], registration: [],
  travel_logistics: [], eligibility: [], player_unavailable: [],
};
const CLUB_SIDE_REASONS = Object.keys(REASON_CHANGE_MAP).filter((c) => REASON_CHANGE_MAP[c].length === 0);
/** Derived, never typed in: the reasons a club gave that still stand. */
const unresolved = (reasonCodes: string[]) => reasonCodes.filter((c) => CLUB_SIDE_REASONS.includes(c));

const DISMISSAL_REASONS = [
  'already_reviewed_elsewhere', 'change_not_material', 'timing_not_right',
  'squad_need_changed', 'no_action_required', 'other',
];
const NM_DISMISSAL_REASONS = [
  'already_known', 'not_current_need', 'evidence_insufficient',
  'role_mismatch_after_review', 'timing', 'other',
];
const NM_SORTS = ['newest_evidence', 'last_reviewed', 'name', 'distance', 'evidence_confidence'];

const BRIEF_STATUSES = ['draft', 'active', 'paused', 'closed', 'archived'];
const BRIEF_TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'closed', 'archived'],
  paused: ['active', 'closed', 'archived'],
  closed: ['active', 'archived'],
  archived: [],
};
const POSITIONS = ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'];
const POSITION_GROUP_OF: Record<string, string> = {
  GK: 'GK', CB: 'DEF', RB: 'DEF', LB: 'DEF', RWB: 'DEF', LWB: 'DEF',
  CDM: 'MID', CM: 'MID', CAM: 'MID', RW: 'ATT', LW: 'ATT', ST: 'ATT', CF: 'ATT',
};
const EVIDENCE_REQUIREMENTS = [
  { key: 'recent_full_match', label: 'Recent full match available' },
  { key: 'coach_reference', label: 'Verified coach reference available' },
  { key: 'confirmed_current_club', label: 'Current club confirmed' },
  { key: 'combine_verified', label: 'Combine Verified result available' },
];
const TRUST_BANDS = ['limited_evidence', 'developing_evidence', 'established_evidence', 'strong_evidence', 'very_strong_evidence'];
const BAND_LABELS: Record<string, string> = {
  limited_evidence: 'Limited evidence',
  developing_evidence: 'Developing evidence',
  established_evidence: 'Established evidence',
  strong_evidence: 'Strong evidence',
  very_strong_evidence: 'Very strong evidence',
};
const BAND_RANK: Record<string, number> = Object.fromEntries(TRUST_BANDS.map((b, i) => [b, i]));

/** What counts as meaningfully evaluated. A profile view is NOT an evaluation. */
const EVALUATION_SIGNALS = [
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
const NON_EVALUATION_SIGNALS = [
  { key: 'profile_view', why: 'Opening a profile is not an evaluation.' },
  { key: 'search_impression', why: 'Appearing in a result list is not an evaluation.' },
  { key: 'passport_view', why: 'Reading a Passport is not an evaluation.' },
];

const PROHIBITED_BRIEF_FIELDS = [
  'race', 'ethnicity', 'skin_colour', 'skin_color', 'religion', 'faith', 'caste',
  'disability', 'medical_condition', 'mental_health',
  'gender_identity', 'sexuality', 'sexual_orientation',
  'socioeconomic', 'social_background', 'family_income', 'school_type',
  'postcode_deprivation', 'deprivation', 'maturity', 'biological_age',
  'physical_maturity', 'immigration_status', 'national_origin',
];

// --------------------------------------------------------------- fixtures
const NOW = Date.now();
const DAY = 86_400_000;
let seq = 0;
const nid = (prefix: string) => `${prefix}-${++seq}`;
const delay = <T,>(v: T): Promise<T> => new Promise((res) => setTimeout(() => res(v), 60));

const change = (type: string, occurredAt: number, relatesTo: string[], fingerprint: string, negative = false): SecondLookChange =>
  ({ type, text: CHANGE_COPY[type] ?? type.replace(/_/g, ' '), relatesTo, negative, occurredAt, fingerprint });

const trust = (score: number, band: string) => ({ score, band, bandLabel: BAND_LABELS[band], note: TRUST_NOTE, policyVersion: 2 });

// ------------------------------------------------------------ Second Look
// The headline story: a room archived for "not enough recent evidence" where a
// full match AND a verified coach reference have since landed. The squad-space
// reason the club ALSO recorded is reported as still standing, because nothing
// in a player's record can make a squad place appear.
const alonsoChanges: SecondLookChange[] = [
  change('full_match_added', NOW - 5 * DAY, ['insufficient_recent_evidence'], 'fp-alonso-full-match'),
  change('verified_reference_added', NOW - 12 * DAY, [], 'fp-alonso-reference'),
];

const secondLookStore: SecondLookItem[] = [
  {
    id: 'slk-alonso',
    playerId: 'pl-alonso',
    playerName: 'Diego Alonso',
    playerAvailable: true,
    roomId: 'room-alonso',
    decisionId: 'rdec-alonso-1',
    status: 'open',
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    kind: 'direct_reason_resolved',
    kindLabel: KIND_LABELS.direct_reason_resolved,
    strength: 'direct',
    archivedStatus: 'archived',
    archiveReasonCodes: ['insufficient_recent_evidence', 'squad_space'],
    directReasonCodes: ['insufficient_recent_evidence'],
    unresolvedReasonCodes: unresolved(['insufficient_recent_evidence', 'squad_space']),
    decisionAt: NOW - 141 * DAY,
    changes: alonsoChanges,
    changeCount: alonsoChanges.length,
    trustMovement: [
      { component: 'evidence', code: 'BOX_CAM_EVIDENCE_ADDED', direction: 'up' },
      { component: 'references', code: 'REFERENCE_CONFIRMED', direction: 'up' },
    ],
    currentTrust: trust(82, 'strong_evidence'),
    summary: 'A new full match has been added. This relates to the reason recorded when the room was closed.',
    latestChangeAt: NOW - 5 * DAY,
    reviewedAt: null, dismissedAt: null, dismissReason: null, reopenedAt: null,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  {
    id: 'slk-boateng',
    playerId: 'pl-boateng',
    playerName: 'Kelvin Boateng',
    playerAvailable: true,
    roomId: 'room-boateng',
    decisionId: 'rdec-boateng-1',
    status: 'open',
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    kind: 'evidence_removed',
    kindLabel: KIND_LABELS.evidence_removed,
    strength: 'general',
    archivedStatus: 'closed',
    archiveReasonCodes: ['technical_fit'],
    directReasonCodes: [],
    unresolvedReasonCodes: unresolved(['technical_fit']),
    decisionAt: NOW - 96 * DAY,
    changes: [change('evidence_removed', NOW - 8 * DAY, [], 'fp-boateng-removed', true)],
    changeCount: 1,
    trustMovement: [{ component: 'evidence', code: 'EVIDENCE_EXPIRED', direction: 'down' }],
    currentTrust: trust(54, 'developing_evidence'),
    summary: 'One source used in the previous review is no longer current.',
    latestChangeAt: NOW - 8 * DAY,
    reviewedAt: null, dismissedAt: null, dismissReason: null, reopenedAt: null,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  {
    id: 'slk-ferreira',
    playerId: 'pl-ferreira',
    playerName: 'Luca Ferreira',
    playerAvailable: true,
    roomId: 'room-ferreira',
    decisionId: 'rdec-ferreira-1',
    status: 'reviewed',
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    kind: 'significant_new_evidence',
    kindLabel: KIND_LABELS.significant_new_evidence,
    strength: 'general',
    archivedStatus: 'archived',
    archiveReasonCodes: ['not_current_priority', 'timing'],
    directReasonCodes: [],
    unresolvedReasonCodes: unresolved(['not_current_priority', 'timing']),
    decisionAt: NOW - 210 * DAY,
    changes: [
      change('trial_completed', NOW - 21 * DAY, [], 'fp-ferreira-trial'),
      change('assessment_submitted', NOW - 20 * DAY, [], 'fp-ferreira-assessment'),
    ],
    changeCount: 2,
    trustMovement: [],
    currentTrust: trust(71, 'strong_evidence'),
    summary: '2 material changes since your review.',
    latestChangeAt: NOW - 20 * DAY,
    reviewedAt: NOW - 3 * DAY,
    reviewedBy: { userId: 'u-demo', name: 'A. Coach' },
    dismissedAt: null, dismissReason: null, reopenedAt: null,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  {
    id: 'slk-petrov',
    playerId: 'pl-petrov',
    playerName: 'Andrei Petrov',
    playerAvailable: true,
    roomId: 'room-petrov',
    decisionId: 'rdec-petrov-1',
    status: 'dismissed',
    policyVersion: SECOND_LOOK_POLICY_VERSION,
    kind: 'general_update',
    kindLabel: KIND_LABELS.general_update,
    strength: 'general',
    archivedStatus: 'withdrawn',
    archiveReasonCodes: ['budget'],
    directReasonCodes: [],
    unresolvedReasonCodes: unresolved(['budget']),
    decisionAt: NOW - 320 * DAY,
    changes: [
      change('evidence_added', NOW - 44 * DAY, [], 'fp-petrov-evidence'),
      change('current_club_confirmed', NOW - 40 * DAY, [], 'fp-petrov-club'),
    ],
    changeCount: 2,
    trustMovement: [{ component: 'footballHistory', code: 'CAREER_RECORD_CONFIRMED', direction: 'up' }],
    currentTrust: trust(49, 'developing_evidence'),
    summary: '2 material changes since your review.',
    latestChangeAt: NOW - 40 * DAY,
    reviewedAt: null,
    dismissedAt: NOW - 30 * DAY,
    dismissReason: 'change_not_material',
    reopenedAt: null,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
];

const row = (key: string, label: string, was: unknown, now: unknown, wasKnown: boolean): ComparisonRow => ({
  key, label, was: wasKnown ? was : null, now,
  available: wasKnown,
  changed: wasKnown ? JSON.stringify(was) !== JSON.stringify(now) : null,
});

/**
 * The focused comparison per item. Note the `references` row: the decision-time
 * snapshot never recorded a reference count, so it is reported as UNAVAILABLE.
 * A missing number is never shown as 0 and never invented.
 */
const CHANGE_DETAIL: Record<string, SecondLookChangesResult> = {
  'slk-alonso': {
    previous: {
      at: NOW - 141 * DAY,
      reasonCodes: ['insufficient_recent_evidence', 'squad_space'],
      recommendation: 'archive',
      trust: { score: 68, band: 'developing_evidence', policyVersion: 2 },
      note: null,
    },
    current: { trust: trust(82, 'strong_evidence'), playerName: 'Diego Alonso' },
    comparison: {
      available: true,
      at: NOW - 141 * DAY,
      note: null,
      rows: [
        row('trust', 'Evidence confidence', { score: 68, band: 'developing_evidence' }, { score: 82, band: 'strong_evidence' }, true),
        row('evidence', 'Evidence items', 4, 6, true),
        row('references', 'Verified coach references', null, 1, false),
        row('combine', 'Combine Verified protocols', 1, 1, true),
        row('assessments', 'Assessments in your organisation', 2, 2, true),
        row('trials', 'Trials', 0, 0, true),
      ],
    },
    changes: alonsoChanges,
    trustMovement: [
      { component: 'evidence', code: 'BOX_CAM_EVIDENCE_ADDED', direction: 'up' },
      { component: 'references', code: 'REFERENCE_CONFIRMED', direction: 'up' },
    ],
    unresolvedReasonCodes: unresolved(['insufficient_recent_evidence', 'squad_space']),
    reasonMap: {
      insufficient_recent_evidence: REASON_CHANGE_MAP.insufficient_recent_evidence,
      squad_space: REASON_CHANGE_MAP.squad_space,
    },
    note: CHANGES_NOTE,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  'slk-boateng': {
    previous: {
      at: NOW - 96 * DAY,
      reasonCodes: ['technical_fit'],
      recommendation: 'archive',
      trust: null,
      // Nothing was recorded at decision time. We say so rather than invent it.
      note: 'Previous detail unavailable — no decision-time snapshot was recorded.',
    },
    current: { trust: trust(54, 'developing_evidence'), playerName: 'Kelvin Boateng' },
    comparison: {
      available: false,
      at: null,
      note: 'Previous detail unavailable — no decision-time snapshot was recorded.',
      rows: [
        row('trust', 'Evidence confidence', null, { score: 54, band: 'developing_evidence' }, false),
        row('evidence', 'Evidence items', null, 3, false),
        row('references', 'Verified coach references', null, 1, false),
        row('combine', 'Combine Verified protocols', null, 0, false),
        row('assessments', 'Assessments in your organisation', null, 1, false),
        row('trials', 'Trials', null, 0, false),
      ],
    },
    changes: [change('evidence_removed', NOW - 8 * DAY, [], 'fp-boateng-removed', true)],
    trustMovement: [{ component: 'evidence', code: 'EVIDENCE_EXPIRED', direction: 'down' }],
    unresolvedReasonCodes: unresolved(['technical_fit']),
    reasonMap: { technical_fit: REASON_CHANGE_MAP.technical_fit },
    note: CHANGES_NOTE,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  'slk-ferreira': {
    previous: {
      at: NOW - 210 * DAY,
      reasonCodes: ['not_current_priority', 'timing'],
      recommendation: 'archive',
      trust: { score: 63, band: 'developing_evidence', policyVersion: 2 },
      note: null,
    },
    current: { trust: trust(71, 'strong_evidence'), playerName: 'Luca Ferreira' },
    comparison: {
      available: true,
      at: NOW - 210 * DAY,
      note: null,
      rows: [
        row('trust', 'Evidence confidence', { score: 63, band: 'developing_evidence' }, { score: 71, band: 'strong_evidence' }, true),
        row('evidence', 'Evidence items', 5, 5, true),
        row('references', 'Verified coach references', null, 2, false),
        row('combine', 'Combine Verified protocols', 0, 0, true),
        row('assessments', 'Assessments in your organisation', 1, 2, true),
        row('trials', 'Trials', 0, 1, true),
      ],
    },
    changes: [
      change('trial_completed', NOW - 21 * DAY, [], 'fp-ferreira-trial'),
      change('assessment_submitted', NOW - 20 * DAY, [], 'fp-ferreira-assessment'),
    ],
    trustMovement: [],
    unresolvedReasonCodes: unresolved(['not_current_priority', 'timing']),
    reasonMap: {
      not_current_priority: REASON_CHANGE_MAP.not_current_priority,
      timing: REASON_CHANGE_MAP.timing,
    },
    note: CHANGES_NOTE,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
  'slk-petrov': {
    previous: {
      at: NOW - 320 * DAY,
      reasonCodes: ['budget'],
      recommendation: 'archive',
      trust: { score: 44, band: 'limited_evidence', policyVersion: 2 },
      note: null,
    },
    current: { trust: trust(49, 'developing_evidence'), playerName: 'Andrei Petrov' },
    comparison: {
      available: true,
      at: NOW - 320 * DAY,
      note: null,
      rows: [
        row('trust', 'Evidence confidence', { score: 44, band: 'limited_evidence' }, { score: 49, band: 'developing_evidence' }, true),
        row('evidence', 'Evidence items', 2, 3, true),
        row('references', 'Verified coach references', null, 0, false),
        row('combine', 'Combine Verified protocols', 0, 0, true),
        row('assessments', 'Assessments in your organisation', 0, 0, true),
        row('trials', 'Trials', 0, 0, true),
      ],
    },
    changes: [
      change('evidence_added', NOW - 44 * DAY, [], 'fp-petrov-evidence'),
      change('current_club_confirmed', NOW - 40 * DAY, [], 'fp-petrov-club'),
    ],
    trustMovement: [{ component: 'footballHistory', code: 'CAREER_RECORD_CONFIRMED', direction: 'up' }],
    unresolvedReasonCodes: unresolved(['budget']),
    reasonMap: { budget: REASON_CHANGE_MAP.budget },
    note: CHANGES_NOTE,
    disclaimer: SECOND_LOOK_DISCLAIMER,
  },
};

// ------------------------------------------------------ Recruitment Briefs
function explainBriefCriteria(criteria: BriefCriteria): { key: string; label: string; value: string }[] {
  const out: { key: string; label: string; value: string }[] = [];
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

interface DemoBrief {
  id: string; title: string; status: string; version: number;
  criteria: BriefCriteria;
  activeFrom: string | null; activeUntil: string | null;
  createdAt: number; updatedAt: number;
}

const DM_CRITERIA: BriefCriteria = {
  positions: ['CDM', 'CM'],
  positionGroups: ['MID'],
  minAge: 17, maxAge: 21,
  radiusKm: 120,
  maxLevel: 'semi_pro',
  foot: null,
  availability: null,
  evidenceRequirements: ['recent_full_match'],
  minTrustBand: 'developing_evidence',
  combineProtocols: [],
};

const briefStore: DemoBrief[] = [
  {
    id: 'brf-dm-2027', title: '2027 Defensive Midfielder', status: 'active', version: 2,
    criteria: DM_CRITERIA,
    activeFrom: null, activeUntil: null,
    createdAt: NOW - 62 * DAY, updatedAt: NOW - 9 * DAY,
  },
  {
    id: 'brf-lb-cover', title: 'Left-sided defensive cover', status: 'draft', version: 1,
    criteria: {
      positions: ['LB', 'LWB'], positionGroups: ['DEF'],
      minAge: 18, maxAge: 23, radiusKm: 90, maxLevel: 'semi_pro',
      foot: 'Left', availability: null,
      evidenceRequirements: ['coach_reference'], minTrustBand: null, combineProtocols: [],
    },
    activeFrom: null, activeUntil: null,
    createdAt: NOW - 18 * DAY, updatedAt: NOW - 18 * DAY,
  },
  {
    id: 'brf-gk-2026', title: 'Goalkeeper — summer window', status: 'paused', version: 3,
    criteria: {
      positions: ['GK'], positionGroups: ['GK'],
      minAge: 19, maxAge: 25, radiusKm: 200, maxLevel: 'pro',
      foot: null, availability: 'Immediate',
      evidenceRequirements: ['recent_full_match', 'coach_reference'],
      minTrustBand: 'established_evidence', combineProtocols: [],
    },
    activeFrom: null, activeUntil: null,
    createdAt: NOW - 120 * DAY, updatedAt: NOW - 31 * DAY,
  },
];

const briefView = (b: DemoBrief): RecruitmentBrief => ({
  id: b.id, title: b.title, status: b.status, version: b.version,
  criteria: b.criteria,
  criteriaExplained: explainBriefCriteria(b.criteria),
  activeFrom: b.activeFrom, activeUntil: b.activeUntil,
  createdBy: { userId: 'u-demo', name: 'A. Coach' },
  createdAt: b.createdAt, updatedAt: b.updatedAt,
  note: BRIEF_NOTE,
});

// -------------------------------------------------------- Nobody Missed
// The roster is the DENOMINATOR: every player this organisation may see who
// matches the 2027 Defensive Midfielder brief. `evaluatedSignal` records which
// of the nine coverage signals already fired — null means this club has never
// entered them into its evaluation workflow.
interface RosterEntry {
  playerId: string; name: string; position: string; age: number;
  trustBand: string; distanceKm: number; lastEvidenceAt: number;
  /** null = not yet evaluated by this organisation. */
  evaluatedSignal: string | null;
}

const DM_ROSTER: RosterEntry[] = [
  { playerId: 'pl-vrba', name: 'Tomas Vrba', position: 'CDM', age: 19, trustBand: 'established_evidence', distanceKm: 22, lastEvidenceAt: NOW - 11 * DAY, evaluatedSignal: 'room_open' },
  { playerId: 'pl-whitfield', name: 'Jonah Whitfield', position: 'CM', age: 18, trustBand: 'developing_evidence', distanceKm: 47, lastEvidenceAt: NOW - 26 * DAY, evaluatedSignal: 'assessment_submitted' },
  { playerId: 'pl-almeida', name: 'Rui Almeida', position: 'CDM', age: 20, trustBand: 'strong_evidence', distanceKm: 96, lastEvidenceAt: NOW - 5 * DAY, evaluatedSignal: 'shortlisted' },
  { playerId: 'pl-fischer', name: 'Leon Fischer', position: 'CM', age: 19, trustBand: 'developing_evidence', distanceKm: 61, lastEvidenceAt: NOW - 33 * DAY, evaluatedSignal: 'trial' },
  { playerId: 'pl-haddad', name: 'Amir Haddad', position: 'CDM', age: 21, trustBand: 'established_evidence', distanceKm: 112, lastEvidenceAt: NOW - 58 * DAY, evaluatedSignal: 'room_decided' },
  // The three this organisation has never entered into its workflow.
  { playerId: 'pl-bello', name: 'Idris Bello', position: 'CDM', age: 18, trustBand: 'developing_evidence', distanceKm: 34, lastEvidenceAt: NOW - 6 * DAY, evaluatedSignal: null },
  { playerId: 'pl-sobota', name: 'Marek Sobota', position: 'CM', age: 20, trustBand: 'established_evidence', distanceKm: 88, lastEvidenceAt: NOW - 19 * DAY, evaluatedSignal: null },
  { playerId: 'pl-pritchard', name: 'Owen Pritchard', position: 'CDM', age: 19, trustBand: 'developing_evidence', distanceKm: 12, lastEvidenceAt: NOW - 41 * DAY, evaluatedSignal: null },
];

const ROSTERS: Record<string, RosterEntry[]> = { 'brf-dm-2027': DM_ROSTER };

/** One review row per (brief, player). Workflow only — never player truth. */
const reviewStore: NobodyMissedReview[] = [];

/**
 * Every criterion, answered, in exactly the brief's own words. There is no
 * hidden criterion and no weighting: a candidate only appears when EVERY
 * criterion is met, and the list below is the whole of why they are here.
 */
function reasonsFor(entry: RosterEntry, criteria: BriefCriteria): NobodyMissedReason[] {
  const out: NobodyMissedReason[] = [];
  if (criteria.positions.length) {
    const met = criteria.positions.includes(entry.position);
    out.push({ key: 'position', met, text: met ? `Matches position criteria (${entry.position})` : 'Does not match the position criteria' });
  }
  if (criteria.minAge != null || criteria.maxAge != null) {
    const met = (criteria.minAge == null || entry.age >= criteria.minAge) && (criteria.maxAge == null || entry.age <= criteria.maxAge);
    out.push({ key: 'age', met, text: met ? `Matches age criteria (${entry.age})` : `Age ${entry.age} is outside the criteria` });
  }
  if (criteria.maxLevel) out.push({ key: 'level', met: true, text: 'Within the level criteria' });
  if (criteria.radiusKm != null) {
    const met = entry.distanceKm <= criteria.radiusKm;
    out.push({ key: 'location', met, text: met ? 'Within the club’s permitted search area' : 'Outside the permitted search area' });
  }
  for (const key of criteria.evidenceRequirements) {
    const label = EVIDENCE_REQUIREMENTS.find((r) => r.key === key)?.label ?? key;
    out.push({ key: `evidence:${key}`, met: true, text: label });
  }
  if (criteria.minTrustBand) {
    const met = (BAND_RANK[entry.trustBand] ?? -1) >= (BAND_RANK[criteria.minTrustBand] ?? 0);
    out.push({
      key: 'minTrustBand', met,
      text: met
        ? `Evidence confidence meets the criteria (${BAND_LABELS[entry.trustBand] ?? entry.trustBand})`
        : `Evidence confidence is below the criteria (${BAND_LABELS[entry.trustBand] ?? entry.trustBand})`,
    });
  }
  out.push({ key: 'no_room', met: true, text: 'No Recruitment Room in your organisation' });
  return out;
}

/**
 * Real arithmetic, computed from the roster on every call — never a typed-in
 * figure. Small groups are suppressed, and a suppressed breakdown returns NULLs
 * so no surface can render a zero it does not have.
 */
function coverageFor(briefId: string): EvaluationCoverage {
  const roster = ROSTERS[briefId] ?? [];
  const eligible = roster.length;
  const evaluated = roster.filter((r) => r.evaluatedSignal !== null).length;
  const notYet = Math.max(0, eligible - evaluated);
  if (eligible > 0 && eligible < SUPPRESS_MIN) {
    return {
      eligible, evaluated: null, notYetEvaluated: null, coveragePercent: null,
      suppressed: true,
      note: `Fewer than ${SUPPRESS_MIN} eligible players match this brief — the breakdown is suppressed.`,
      policyVersion: COVERAGE_POLICY_VERSION,
    };
  }
  return {
    eligible,
    evaluated,
    notYetEvaluated: notYet,
    coveragePercent: eligible === 0 ? null : Math.round((evaluated / eligible) * 100),
    suppressed: false,
    complete: eligible > 0 && notYet === 0,
    note: COVERAGE_NOTE,
    policyVersion: COVERAGE_POLICY_VERSION,
  };
}

const reviewFor = (briefId: string, playerId: string) =>
  reviewStore.find((r) => r.briefId === briefId && r.playerId === playerId) ?? null;

function candidatesFor(brief: DemoBrief): NobodyMissedItem[] {
  const roster = ROSTERS[brief.id] ?? [];
  return roster
    .filter((entry) => entry.evaluatedSignal === null)
    .map((entry) => {
      const review = reviewFor(brief.id, entry.playerId);
      return { entry, review };
    })
    .filter(({ review }) => !review || !['dismissed', 'added_to_room'].includes(review.state))
    .map(({ entry, review }): NobodyMissedItem => ({
      playerId: entry.playerId,
      briefId: brief.id,
      briefVersion: brief.version,
      name: entry.name,
      position: entry.position,
      age: entry.age,
      trustBand: entry.trustBand,
      trustNote: TRUST_NOTE,
      reasons: reasonsFor(entry, brief.criteria),
      note: CANDIDATE_NOTE,
      distanceKm: entry.distanceKm,
      lastEvidenceAt: entry.lastEvidenceAt,
      state: review?.state ?? 'open',
      reviewedAt: review?.reviewedAt ?? null,
    }));
}

function orderCandidates(items: NobodyMissedItem[], sort: string): NobodyMissedItem[] {
  const by: Record<string, (a: NobodyMissedItem, b: NobodyMissedItem) => number> = {
    name: (a, b) => String(a.name).localeCompare(String(b.name)),
    distance: (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
    evidence_confidence: (a, b) => (BAND_RANK[b.trustBand ?? ''] ?? -1) - (BAND_RANK[a.trustBand ?? ''] ?? -1),
    newest_evidence: (a, b) => (b.lastEvidenceAt ?? 0) - (a.lastEvidenceAt ?? 0),
    last_reviewed: (a, b) => (a.reviewedAt ?? 0) - (b.reviewedAt ?? 0),
  };
  const cmp = by[sort] ?? (() => 0);
  return items.slice().sort((a, b) => cmp(a, b) || String(a.playerId).localeCompare(String(b.playerId)));
}

function setReview(briefId: string, briefVersion: number, playerId: string, patch: Partial<NobodyMissedReview>): NobodyMissedReview {
  let r = reviewFor(briefId, playerId);
  if (!r) {
    r = { id: nid('nmr'), briefId, briefVersion, playerId, state: 'open', updatedAt: Date.now() };
    reviewStore.push(r);
  }
  Object.assign(r, patch, { updatedAt: Date.now(), briefVersion });
  return r;
}

const briefIsLive = (b: DemoBrief) => b.status === 'active';

const EVALUATION_POLICY: EvaluationPolicy = {
  version: COVERAGE_POLICY_VERSION,
  counts: EVALUATION_SIGNALS,
  doesNotCount: NON_EVALUATION_SIGNALS,
  recentDecisionDays: RECENT_DECISION_DAYS,
};

// ----------------------------------------------------------- brief writing
function validateBrief(input: BriefInput, prev?: DemoBrief): BriefSaveResult | { ok: true; title: string; criteria: BriefCriteria; activeFrom: string | null; activeUntil: string | null } {
  const offered = Object.keys(input).map((k) => k.toLowerCase().replace(/[^a-z]+/g, '_'));
  const prohibited = offered.filter((k) => PROHIBITED_BRIEF_FIELDS.some((p) => k === p || k.includes(p)));
  if (prohibited.length) {
    return {
      ok: false, error: 'BRIEF_CRITERION_PROHIBITED', prohibited,
      message: 'A recruitment brief can never filter players by a protected characteristic.',
    };
  }
  const details: { field: string; error: string; unknown?: string[] }[] = [];
  const title = String(input.title ?? prev?.title ?? '').trim().slice(0, 120);
  if (!title) details.push({ field: 'title', error: 'BRIEF_TITLE_REQUIRED' });

  const positions = [...new Set((input.positions ?? prev?.criteria.positions ?? []).map(String))];
  const unknownPos = positions.filter((p) => !POSITIONS.includes(p));
  if (unknownPos.length) details.push({ field: 'positions', error: 'BRIEF_POSITION_UNKNOWN', unknown: unknownPos });

  const minAge = input.minAge === undefined ? prev?.criteria.minAge ?? null : (input.minAge == null ? null : Number(input.minAge));
  const maxAge = input.maxAge === undefined ? prev?.criteria.maxAge ?? null : (input.maxAge == null ? null : Number(input.maxAge));
  for (const [k, v] of [['minAge', minAge], ['maxAge', maxAge]] as [string, number | null][]) {
    if (v != null && (!Number.isInteger(v) || v < 5 || v > 60)) details.push({ field: k, error: 'BRIEF_AGE_INVALID' });
  }
  if (minAge != null && maxAge != null && minAge > maxAge) details.push({ field: 'ageRange', error: 'BRIEF_AGE_RANGE_INVALID' });

  const radiusKm = input.radiusKm === undefined ? prev?.criteria.radiusKm ?? null : (input.radiusKm == null ? null : Number(input.radiusKm));
  if (radiusKm != null && (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 20000)) details.push({ field: 'radiusKm', error: 'BRIEF_RADIUS_INVALID' });

  const maxLevel = input.maxLevel === undefined ? prev?.criteria.maxLevel ?? null : (input.maxLevel ?? null);
  if (maxLevel != null && !['amateur', 'semi_pro', 'pro'].includes(maxLevel)) details.push({ field: 'maxLevel', error: 'BRIEF_LEVEL_UNKNOWN' });

  const evidence = [...new Set((input.evidenceRequirements ?? prev?.criteria.evidenceRequirements ?? []).map(String))];
  const unknownEv = evidence.filter((e) => !EVIDENCE_REQUIREMENTS.some((r) => r.key === e));
  if (unknownEv.length) details.push({ field: 'evidenceRequirements', error: 'BRIEF_EVIDENCE_REQUIREMENT_UNKNOWN', unknown: unknownEv });

  const minTrustBand = input.minTrustBand === undefined ? prev?.criteria.minTrustBand ?? null : (input.minTrustBand ?? null);
  if (minTrustBand != null && !TRUST_BANDS.includes(minTrustBand)) details.push({ field: 'minTrustBand', error: 'BRIEF_TRUST_BAND_UNKNOWN' });

  const activeFrom = input.activeFrom === undefined ? prev?.activeFrom ?? null : (input.activeFrom || null);
  const activeUntil = input.activeUntil === undefined ? prev?.activeUntil ?? null : (input.activeUntil || null);
  if (activeFrom && activeUntil && String(activeFrom) > String(activeUntil)) details.push({ field: 'activeWindow', error: 'BRIEF_WINDOW_INVALID' });

  if (details.length) {
    return { ok: false, error: 'BRIEF_INVALID', details, message: 'This recruitment brief cannot be saved as written.' };
  }
  const foot = input.foot === undefined ? prev?.criteria.foot ?? null : (input.foot ?? null);
  const availability = input.availability === undefined ? prev?.criteria.availability ?? null : (input.availability || null);
  const combineProtocols = [...new Set((input.combineProtocols ?? prev?.criteria.combineProtocols ?? []).map(String))];
  return {
    ok: true, title,
    criteria: {
      positions,
      positionGroups: [...new Set(positions.map((p) => POSITION_GROUP_OF[p]).filter(Boolean))],
      minAge, maxAge, radiusKm, maxLevel,
      foot: ['Left', 'Right', 'Both'].includes(String(foot)) ? foot : null,
      availability: availability ? String(availability).slice(0, 40) : null,
      evidenceRequirements: evidence,
      minTrustBand,
      combineProtocols,
    },
    activeFrom, activeUntil,
  };
}

// ================================================================== the api
export const demoM18: M18Api = {
  secondLook: async (_s, params = {}) => {
    const status = params.status ?? 'open';
    const items = status === 'all' ? secondLookStore.slice() : secondLookStore.filter((i) => i.status === status);
    const result: SecondLookListResult = {
      items: items.map((i) => ({ ...i })),
      total: items.length,
      limit: params.limit ?? 25,
      offset: params.offset ?? 0,
      counts: {
        open: secondLookStore.filter((i) => i.status === 'open').length,
        reviewed: secondLookStore.filter((i) => i.status === 'reviewed').length,
        dismissed: secondLookStore.filter((i) => i.status === 'dismissed').length,
      },
      policyVersion: SECOND_LOOK_POLICY_VERSION,
      disclaimer: SECOND_LOOK_DISCLAIMER,
      note: SECOND_LOOK_NOTE,
    };
    return delay(result);
  },

  secondLookItem: async (_s, id) => {
    const item = secondLookStore.find((i) => i.id === id);
    if (!item) throw new Error('SECOND_LOOK_NOT_FOUND');
    const result: SecondLookDetailResult = { item: { ...item } };
    return delay(result);
  },

  secondLookChanges: async (_s, id) => {
    const detail = CHANGE_DETAIL[id];
    if (!detail) throw new Error('SECOND_LOOK_NOT_FOUND');
    return delay({ ...detail });
  },

  reviewSecondLook: async (_s, id) => {
    const item = secondLookStore.find((i) => i.id === id);
    if (!item) throw new Error('SECOND_LOOK_NOT_FOUND');
    if (!(SECOND_LOOK_TRANSITIONS[item.status] ?? []).includes('reviewed')) throw new Error('SECOND_LOOK_TRANSITION_INVALID');
    item.status = 'reviewed';
    item.reviewedAt = Date.now();
    item.reviewedBy = { userId: 'u-demo', name: 'A. Coach' };
    return delay({ item: { ...item } });
  },

  dismissSecondLook: async (_s, id, reason) => {
    const item = secondLookStore.find((i) => i.id === id);
    if (!item) throw new Error('SECOND_LOOK_NOT_FOUND');
    if (!DISMISSAL_REASONS.includes(reason)) throw new Error('SECOND_LOOK_REASON_UNKNOWN');
    if (!(SECOND_LOOK_TRANSITIONS[item.status] ?? []).includes('dismissed')) throw new Error('SECOND_LOOK_TRANSITION_INVALID');
    item.status = 'dismissed';
    item.dismissedAt = Date.now();
    item.dismissReason = reason;
    return delay({ item: { ...item }, note: DISMISS_NOTE });
  },

  // A room reopens ONLY here, and only because a recruiter clicked. Nothing in
  // this module reopens anything on its own.
  reopenRoom: async (_s, id, reasonCodes) => {
    void reasonCodes; // recorded on the room by M17 in live mode
    const item = secondLookStore.find((i) => i.id === id);
    if (!item) throw new Error('SECOND_LOOK_NOT_FOUND');
    if (!(SECOND_LOOK_TRANSITIONS[item.status] ?? []).includes('reopened_room')) throw new Error('SECOND_LOOK_TRANSITION_INVALID');
    item.status = 'reopened_room';
    item.reopenedAt = Date.now();
    const result: ReopenRoomResult = {
      item: { ...item },
      room: { roomId: item.roomId, id: item.roomId, status: 'under_review' },
      note: REOPEN_NOTE,
    };
    return delay(result);
  },

  briefs: async () => {
    const result: BriefListResult = {
      items: briefStore.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(briefView),
      total: briefStore.length,
      statuses: BRIEF_STATUSES,
      vocabulary: { positions: POSITIONS, evidenceRequirements: EVIDENCE_REQUIREMENTS, trustBands: TRUST_BANDS },
      policyVersion: COVERAGE_POLICY_VERSION,
    };
    return delay(result);
  },

  brief: async (_s, id) => {
    const b = briefStore.find((x) => x.id === id);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    return delay(briefView(b));
  },

  createBrief: async (_s, input) => {
    const v = validateBrief(input);
    if (!('criteria' in v)) return delay(v as BriefSaveResult);
    const b: DemoBrief = {
      id: nid('brf'), title: v.title, status: 'draft', version: 1,
      criteria: v.criteria, activeFrom: v.activeFrom, activeUntil: v.activeUntil,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    briefStore.push(b);
    return delay({ ok: true, brief: briefView(b) } as BriefSaveResult);
  },

  patchBrief: async (_s, id, input) => {
    const b = briefStore.find((x) => x.id === id);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    if (b.status === 'archived') throw new Error('BRIEF_ARCHIVED');
    if (input.status !== undefined) {
      if (!BRIEF_STATUSES.includes(input.status)) throw new Error('BRIEF_STATUS_UNKNOWN');
      if (!(BRIEF_TRANSITIONS[b.status] ?? []).includes(input.status)) throw new Error('BRIEF_TRANSITION_INVALID');
      b.status = input.status;
    }
    const wantsCriteria = ['title', 'positions', 'minAge', 'maxAge', 'radiusKm', 'maxLevel', 'foot', 'availability', 'evidenceRequirements', 'minTrustBand', 'combineProtocols', 'activeFrom', 'activeUntil']
      .some((k) => (input as Record<string, unknown>)[k] !== undefined);
    if (wantsCriteria) {
      const v = validateBrief(input, b);
      if (!('criteria' in v)) return delay(v as BriefSaveResult);
      // A material criteria change is a NEW version. Nothing is rewritten.
      const changed = JSON.stringify(v.criteria) !== JSON.stringify(b.criteria);
      b.title = v.title;
      b.activeFrom = v.activeFrom;
      b.activeUntil = v.activeUntil;
      if (changed) { b.criteria = v.criteria; b.version += 1; }
    }
    b.updatedAt = Date.now();
    return delay({ ok: true, brief: briefView(b) } as BriefSaveResult);
  },

  nobodyMissed: async (_s, params) => {
    const b = briefStore.find((x) => x.id === params.briefId);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    if (!briefIsLive(b)) {
      const notLive: NobodyMissedResult = {
        brief: briefView(b), live: false, items: [], total: 0, coverage: null, note: NOT_LIVE_NOTE,
      };
      return delay(notLive);
    }
    const sort = NM_SORTS.includes(String(params.sort)) ? String(params.sort) : 'newest_evidence';
    const items = orderCandidates(candidatesFor(b), sort);
    const result: NobodyMissedResult = {
      brief: briefView(b), live: true, briefVersion: b.version,
      items, total: items.length,
      coverage: coverageFor(b.id),
      sorts: NM_SORTS, sort,
      evaluationPolicy: EVALUATION_POLICY,
      note: NM_NOTE,
    };
    return delay(result);
  },

  reviewCandidate: async (_s, input) => {
    const b = briefStore.find((x) => x.id === input.briefId);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    const r = setReview(b.id, b.version, input.playerId, { state: 'reviewed', reviewedAt: Date.now() });
    return delay({ review: { ...r }, note: NM_REVIEW_NOTE });
  },

  dismissCandidate: async (_s, input) => {
    const b = briefStore.find((x) => x.id === input.briefId);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    if (!NM_DISMISSAL_REASONS.includes(input.reason)) throw new Error('NM_REASON_UNKNOWN');
    const r = setReview(b.id, b.version, input.playerId, { state: 'dismissed', dismissReason: input.reason, dismissedAt: Date.now() });
    return delay({ review: { ...r }, note: NM_DISMISS_NOTE });
  },

  // Adding to a room really is an evaluation: the roster entry gains the
  // `room_open` signal, so coverage moves by real subtraction on the next read.
  addCandidateToRoom: async (_s, input) => {
    const b = briefStore.find((x) => x.id === input.briefId);
    if (!b) throw new Error('BRIEF_NOT_FOUND');
    const entry = (ROSTERS[b.id] ?? []).find((e) => e.playerId === input.playerId);
    if (!entry) throw new Error('NOT_VISIBLE');
    const roomId = nid('room');
    entry.evaluatedSignal = 'room_open';
    const r = setReview(b.id, b.version, input.playerId, { state: 'added_to_room', roomId, reviewedAt: Date.now() });
    const result: AddToRoomResult = { review: { ...r }, roomId, room: { roomId, status: 'watching' } };
    return delay(result);
  },

  evaluationCoverage: async () => {
    const result: EvaluationCoverageResult = {
      items: briefStore.filter(briefIsLive).map((b) => ({
        briefId: b.id, title: b.title, briefVersion: b.version, coverage: coverageFor(b.id),
      })),
      policyVersion: COVERAGE_POLICY_VERSION,
      note: COVERAGE_NOTE,
    };
    return delay(result);
  },
};

// Kept deliberately: the demo's own Combine vocabulary is SIMULATED and must
// never be presented as production recruitment evidence — which is why no
// fixture above carries a Combine requirement or a Combine change.
export const DEMO_COMBINE_LABEL = 'Simulated Combine result — demo only. Never counted as production recruitment evidence.';
