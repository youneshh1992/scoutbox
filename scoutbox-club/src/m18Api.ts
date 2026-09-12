// M18 typed client (org side): Second Look, Nobody Missed, Recruitment Briefs.
//
// What these systems ARE: two pieces of recruitment WORKFLOW hygiene for the
// club. Second Look reports what changed in a player's record since the club's
// own recorded decision. Nobody Missed reports which players eligible under the
// club's own written brief never entered the club's evaluation workflow.
//
// What they are NOT, and what nothing in this module may ever become:
//   • Player-facing. There is no player, guardian or public route in M18 at
//     all. A player is never told they were "missed" or "reconsidered".
//   • A judgement of the club's decision. Second Look reports facts that moved;
//     it never says a decision was wrong and never recommends signing anyone.
//   • A talent measure. Nobody Missed is EVALUATION COVERAGE — workflow
//     coverage over a declared denominator. It is not Scout Quality, not
//     Recruitment Quality, not a Scouting Score and not a Fairness Score.
//   • A ranking. There is no hidden score, no match score and no quality order.
//     The Trust Score travels here only as EVIDENCE CONFIDENCE, always with its
//     note, and it opens no door: every standing gate (visibility, blocks,
//     verification, suspension, the agency wall) has already run server-side.
//
// A room reopens ONLY through an explicit recruiter click on `reopenRoom`, and
// that call goes through M17's own reopen path — one transition table, one
// decision memory, one activity trail.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM18 } from './m18Demo';

// ------------------------------------------------------------- vocabularies
// Mirrors of the server's fixed vocabularies: declarative labels for the UI
// only. The server remains the sole authority on what is allowed.
export const SECOND_LOOK_STATUSES = ['open', 'reviewed', 'dismissed', 'reopened_room', 'expired'] as const;
export type SecondLookStatus = (typeof SECOND_LOOK_STATUSES)[number];

/** Filters the list endpoint accepts. */
export const SECOND_LOOK_FILTERS = ['open', 'reviewed', 'dismissed', 'all'] as const;

export const SECOND_LOOK_DISMISS_REASONS = [
  'already_reviewed_elsewhere', 'change_not_material', 'timing_not_right',
  'squad_need_changed', 'no_action_required', 'other',
] as const;

/** Reasons a CLUB gave that no change in a player's record can ever resolve. */
export const CLUB_SIDE_REASONS = [
  'squad_space', 'budget', 'timing', 'registration', 'travel_logistics',
  'eligibility', 'player_unavailable',
] as const;

export const NOBODY_MISSED_DISMISS_REASONS = [
  'already_known', 'not_current_need', 'evidence_insufficient',
  'role_mismatch_after_review', 'timing', 'other',
] as const;

/** Orderings. None of them is a quality rank. */
export const NOBODY_MISSED_SORTS = [
  'newest_evidence', 'last_reviewed', 'name', 'distance', 'evidence_confidence',
] as const;

export const BRIEF_STATUSES = ['draft', 'active', 'paused', 'closed', 'archived'] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export const BRIEF_TRANSITIONS: Record<string, string[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'closed', 'archived'],
  paused: ['active', 'closed', 'archived'],
  closed: ['active', 'archived'],
  archived: [],
};

export const BRIEF_POSITIONS = ['GK', 'CB', 'RB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RW', 'LW', 'ST', 'CF'] as const;
export const BRIEF_LEVELS = ['amateur', 'semi_pro', 'pro'] as const;
export const BRIEF_FEET = ['Left', 'Right', 'Both'] as const;
export const BRIEF_EVIDENCE_REQUIREMENTS: { key: string; label: string }[] = [
  { key: 'recent_full_match', label: 'Recent full match available' },
  { key: 'coach_reference', label: 'Verified coach reference available' },
  { key: 'confirmed_current_club', label: 'Current club confirmed' },
  { key: 'combine_verified', label: 'Combine Verified result available' },
];
export const BRIEF_TRUST_BANDS = [
  'limited_evidence', 'developing_evidence', 'established_evidence',
  'strong_evidence', 'very_strong_evidence',
] as const;

// ------------------------------------------------------------------- shapes

/** The safe org Trust projection. Evidence confidence only, never ability. */
export interface M18Trust {
  score: number;
  band: string;
  bandLabel?: string;
  /** Always present: "Evidence confidence — not football ability." */
  note?: string;
  policyVersion?: number;
}

/** One normalised material change. `text` is the server's own wording. */
export interface SecondLookChange {
  type: string;
  text: string;
  /** Archive reason codes this change may relate to. Empty is normal. */
  relatesTo?: string[];
  /** A change that REDUCES the evidence available. Never framed as wrongdoing. */
  negative?: boolean;
  occurredAt: number;
  fingerprint?: string;
}

/** Trust component movement. Supporting context, never the trigger. */
export interface TrustMovement {
  component: string;
  code: string;
  direction: 'up' | 'down';
}

/**
 * One Second Look item — ONE per player, carrying every change. The degraded
 * projection (player no longer visible) drops the derived fields, so every
 * derived field is optional here rather than faked at render time.
 */
export interface SecondLookItem {
  id: string;
  playerId: string;
  playerName?: string | null;
  playerAvailable?: boolean;
  roomId: string;
  decisionId?: string;
  status: string;
  policyVersion?: number;
  kind?: string;
  /** Already one of "Worth Another Look" / "New Since Your Review" / "Evidence Changed". */
  kindLabel?: string;
  strength?: 'direct' | 'general';
  archivedStatus?: string;
  archiveReasonCodes?: string[];
  directReasonCodes?: string[];
  /** Reasons the club gave that player evidence can never resolve. */
  unresolvedReasonCodes?: string[];
  decisionAt?: number | null;
  changes?: SecondLookChange[];
  changeCount?: number;
  trustMovement?: TrustMovement[];
  currentTrust?: M18Trust | null;
  summary?: string;
  latestChangeAt?: number | null;
  reviewedAt?: number | null;
  reviewedBy?: { userId: string; name: string } | null;
  dismissedAt?: number | null;
  dismissReason?: string | null;
  reopenedAt?: number | null;
  disclaimer?: string;
}

export interface SecondLookListParams {
  status?: 'open' | 'reviewed' | 'dismissed' | 'all';
  limit?: number;
  offset?: number;
}

export interface SecondLookListResult {
  items: SecondLookItem[];
  total: number;
  limit: number;
  offset: number;
  counts: { open: number; reviewed: number; dismissed: number };
  policyVersion: number;
  disclaimer: string;
  note: string;
}

/** `unavailableNote` is present when the player is no longer visible. Render
 *  it honestly — never a blank card, never an invented player. */
export interface SecondLookDetailResult {
  item: SecondLookItem;
  unavailableNote?: string;
  note?: string;
}

/**
 * One row of the At Previous Review vs Now comparison.
 * `available: false` means we never recorded a previous value — the UI prints
 * "Previous detail unavailable" and NEVER a fabricated number (and never 0).
 */
export interface ComparisonRow {
  key: string;
  label: string;
  was: unknown;
  now: unknown;
  available: boolean;
  changed: boolean | null;
}

export interface SecondLookChangesResult {
  /** Absent on the degraded (player-not-visible) response. */
  available?: boolean;
  unavailableNote?: string;
  previous?: {
    at: number | null;
    reasonCodes: string[];
    recommendation: string | null;
    trust: { score: number; band: string; policyVersion?: number } | null;
    note: string | null;
  };
  current?: { trust: M18Trust | null; playerName: string | null };
  comparison?: { available: boolean; at: number | null; note: string | null; rows: ComparisonRow[] };
  changes?: SecondLookChange[];
  trustMovement?: TrustMovement[];
  unresolvedReasonCodes?: string[];
  reasonMap?: Record<string, string[]>;
  note?: string;
  disclaimer?: string;
}

export interface ReopenRoomResult {
  item: SecondLookItem;
  room?: { roomId?: string; id?: string; status?: string } | null;
  note?: string;
}

// ------------------------------------------------------------------ briefs

/** The club's own explicit demand. No weights, no hidden criteria. */
export interface BriefCriteria {
  positions: string[];
  positionGroups?: string[];
  minAge: number | null;
  maxAge: number | null;
  radiusKm: number | null;
  maxLevel: string | null;
  foot: string | null;
  availability: string | null;
  evidenceRequirements: string[];
  minTrustBand: string | null;
  combineProtocols: string[];
}

export interface RecruitmentBrief {
  id: string;
  title: string;
  status: string;
  /** Criteria version — what historical Evaluation Coverage points at. */
  version: number;
  /** Mutation revision — the optimistic-concurrency token (M18.1). */
  rev?: number;
  revAt?: number | null;
  revBy?: string | null;
  criteria: BriefCriteria;
  /** Plain-language criteria. There are no hidden criteria. */
  criteriaExplained: { key: string; label: string; value: string }[];
  activeFrom: string | null;
  activeUntil: string | null;
  roleId?: string | null;
  vacancyId?: string | null;
  createdBy?: { userId: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  note?: string;
}

export interface BriefVocabulary {
  positions: string[];
  evidenceRequirements: { key: string; label: string }[];
  trustBands: string[];
}

export interface BriefListResult {
  items: RecruitmentBrief[];
  total: number;
  limit?: number;
  offset?: number;
  statuses: string[];
  vocabulary: BriefVocabulary;
  policyVersion?: number;
}

export interface BriefInput {
  /**
   * The `rev` this edit was composed against (M18.1). The server refuses a
   * write built on a stale read with 409 BRIEF_VERSION_CONFLICT rather than
   * discarding a colleague's edit. It is optional on the wire so nothing
   * older breaks, but every ScoutBox surface sends it.
   */
  expectedRev?: number;
  title?: string;
  positions?: string[];
  minAge?: number | null;
  maxAge?: number | null;
  radiusKm?: number | null;
  maxLevel?: string | null;
  foot?: string | null;
  availability?: string | null;
  evidenceRequirements?: string[];
  minTrustBand?: string | null;
  combineProtocols?: string[];
  activeFrom?: string | null;
  activeUntil?: string | null;
  status?: string;
}

export interface BriefFieldError { field: string; error: string; unknown?: string[] }

/**
 * An invalid brief is REFUSED, never silently repaired — so the caller gets the
 * field-level detail back as data rather than as a thrown string.
 */
export type BriefSaveResult =
  | { ok: true; brief: RecruitmentBrief }
  | { ok: false; error: 'BRIEF_INVALID'; details: BriefFieldError[]; message: string }
  | { ok: false; error: 'BRIEF_CRITERION_PROHIBITED'; prohibited: string[]; message: string };

// ----------------------------------------------------------- nobody missed

/** One criterion, answered. "Why is this player here?" is always answerable. */
export interface NobodyMissedReason { key: string; met: boolean; text: string }

export interface NobodyMissedItem {
  playerId: string;
  briefId: string;
  briefVersion: number;
  name: string | null;
  position: string | null;
  age: number | null;
  trustBand: string | null;
  /** Always "Evidence confidence — not football ability." */
  trustNote?: string;
  reasons: NobodyMissedReason[];
  note?: string;
  distanceKm: number | null;
  lastEvidenceAt: number | null;
  state: string;
  reviewedAt?: number | null;
}

/**
 * Workflow coverage over a declared denominator. When `suppressed` is true the
 * numbers are NULL — the UI renders the suppression note, never zeros.
 */
export interface EvaluationCoverage {
  eligible: number;
  evaluated: number | null;
  notYetEvaluated: number | null;
  coveragePercent: number | null;
  suppressed: boolean;
  complete?: boolean;
  note: string;
  policyVersion: number;
}

export interface EvaluationPolicy {
  version: number;
  counts: { key: string; label: string }[];
  doesNotCount: { key: string; why: string }[];
  recentDecisionDays: number;
}

export interface NobodyMissedResult {
  brief: RecruitmentBrief;
  live: boolean;
  briefVersion?: number;
  items: NobodyMissedItem[];
  total: number;
  limit?: number;
  offset?: number;
  coverage: EvaluationCoverage | null;
  sorts?: string[];
  sort?: string;
  evaluationPolicy?: EvaluationPolicy;
  note: string;
}

export interface NobodyMissedReview {
  id: string;
  briefId: string;
  briefVersion: number;
  playerId: string;
  state: string;
  roomId?: string | null;
  dismissReason?: string | null;
  reviewedAt?: number | null;
  dismissedAt?: number | null;
  updatedAt: number;
}

export interface AddToRoomResult {
  review: NobodyMissedReview;
  roomId: string;
  room?: unknown;
}

export interface EvaluationCoverageResult {
  items: { briefId: string; title: string; briefVersion: number; coverage: EvaluationCoverage }[];
  policyVersion: number;
  note: string;
}

// --------------------------------------------------------------- the shape
export interface M18Api {
  secondLook(s: Session, params?: SecondLookListParams): Promise<SecondLookListResult>;
  secondLookItem(s: Session, id: string): Promise<SecondLookDetailResult>;
  secondLookChanges(s: Session, id: string): Promise<SecondLookChangesResult>;
  reviewSecondLook(s: Session, id: string): Promise<{ item: SecondLookItem }>;
  dismissSecondLook(s: Session, id: string, reason: string): Promise<{ item: SecondLookItem; note?: string }>;
  /** The ONLY path from Second Look into the pipeline. Explicit click only. */
  reopenRoom(s: Session, id: string, reasonCodes: string[]): Promise<ReopenRoomResult>;

  briefs(s: Session): Promise<BriefListResult>;
  brief(s: Session, id: string): Promise<RecruitmentBrief>;
  createBrief(s: Session, input: BriefInput): Promise<BriefSaveResult>;
  patchBrief(s: Session, id: string, input: BriefInput): Promise<BriefSaveResult>;

  nobodyMissed(s: Session, params: { briefId: string; sort?: string; limit?: number; offset?: number }): Promise<NobodyMissedResult>;
  reviewCandidate(s: Session, input: { briefId: string; playerId: string }): Promise<{ review: NobodyMissedReview; note?: string }>;
  dismissCandidate(s: Session, input: { briefId: string; playerId: string; reason: string }): Promise<{ review: NobodyMissedReview; note?: string }>;
  addCandidateToRoom(s: Session, input: { briefId: string; playerId: string }): Promise<AddToRoomResult>;

  evaluationCoverage(s: Session): Promise<EvaluationCoverageResult>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return body as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out.set(k, String(v));
  const s = out.toString();
  return s ? `?${s}` : '';
};

/**
 * A brief write answers 400 with STRUCTURED refusal detail. That is an answer,
 * not a crash: the form re-renders with the offending field named, and a
 * prohibited criterion is reported in the server's own words.
 */
async function saveBrief(path: string, init: RequestInit): Promise<BriefSaveResult> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body?.error === 'BRIEF_CRITERION_PROHIBITED') {
    return { ok: false, error: 'BRIEF_CRITERION_PROHIBITED', prohibited: (body.prohibited ?? []) as string[], message: String(body.message ?? '') };
  }
  if (res.status === 400 && body?.error === 'BRIEF_INVALID') {
    return { ok: false, error: 'BRIEF_INVALID', details: (body.details ?? []) as BriefFieldError[], message: String(body.message ?? '') };
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'UNKNOWN', body.message ?? body.error ?? res.statusText);
  return { ok: true, brief: body.brief as RecruitmentBrief };
}

export const httpM18: M18Api = {
  secondLook: (s, params = {}) => req(`/org/second-look${qs({ ...params })}`, { headers: H(s) }),
  secondLookItem: (s, id) => req(`/org/second-look/${id}`, { headers: H(s) }),
  secondLookChanges: (s, id) => req(`/org/second-look/${id}/changes`, { headers: H(s) }),
  reviewSecondLook: (s, id) => req(`/org/second-look/${id}/review`, { method: 'POST', headers: H(s), body: '{}' }),
  dismissSecondLook: (s, id, reason) => req(`/org/second-look/${id}/dismiss`, { method: 'POST', headers: H(s), body: JSON.stringify({ reason }) }),
  reopenRoom: (s, id, reasonCodes) => req(`/org/second-look/${id}/reopen-room`, { method: 'POST', headers: H(s), body: JSON.stringify({ reasonCodes }) }),

  briefs: (s) => req('/org/recruitment-briefs', { headers: H(s) }),
  brief: async (s, id) => (await req<{ brief: RecruitmentBrief }>(`/org/recruitment-briefs/${id}`, { headers: H(s) })).brief,
  createBrief: (s, input) => saveBrief('/org/recruitment-briefs', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  patchBrief: (s, id, input) => saveBrief(`/org/recruitment-briefs/${id}`, { method: 'PATCH', headers: H(s), body: JSON.stringify(input) }),

  nobodyMissed: (s, params) => req(`/org/nobody-missed${qs({ ...params })}`, { headers: H(s) }),
  reviewCandidate: (s, input) => req('/org/nobody-missed/review', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  dismissCandidate: (s, input) => req('/org/nobody-missed/dismiss', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),
  addCandidateToRoom: (s, input) => req('/org/nobody-missed/add-to-room', { method: 'POST', headers: H(s), body: JSON.stringify(input) }),

  evaluationCoverage: (s) => req('/org/evaluation-coverage', { headers: H(s) }),
};

export const m18: M18Api = DEMO_MODE ? demoM18 : httpM18;
