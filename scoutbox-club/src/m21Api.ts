// M21 typed client (org side): the Development Hub, inside a player.
//
// What this is: a club's structured record of what a player is working on, the
// actions agreed, the evidence cited and the reviews written. Workflow.
//
// What it is NOT, and what nothing in this module may become:
//   • A score. There is no Development Score, Potential Score, Improvement
//     Score, Readiness Score, Growth Score, Academy Score or Player Progress
//     Rating. No type here has a field one could be stored in.
//   • A ranking. There is no endpoint that lists players by development and no
//     parameter that sorts by it; the club's list is of plans it may read.
//   • A recruitment signal. Development status is not a matching criterion and
//     M19 does not read it.
//   • A second evidence store. An evidence link is a reference; what it points
//     at is resolved live by the server, so an invalidated result reads as
//     invalid now rather than as it was when someone linked it.
//
// The server derives every figure. This module computes no completion
// percentage, decides no target state and upgrades no provenance — a client
// that recomputed any of them would be a second definition waiting to drift.
import { API_URL, DEMO_MODE, ApiError, type Session } from './api';
import { demoM21 } from './m21Demo';

export const GOAL_CATEGORIES = ['technical', 'tactical', 'physical', 'psychological', 'match_understanding', 'position_specific', 'other'] as const;
export const GOAL_STATUSES = ['not_started', 'in_progress', 'blocked', 'achieved', 'stopped'] as const;
export const ACTION_STATUSES = ['todo', 'in_progress', 'done', 'blocked', 'cancelled'] as const;
export const ACTION_TYPES = ['training', 'assessment', 'video_review', 'match_objective', 'coach_review', 'combine', 'box_cam', 'evidence_request', 'custom'] as const;
export const PLAN_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
export const BLOCK_REASONS = ['waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other'] as const;
export const TARGET_STATES = ['target_met', 'target_not_met', 'no_current_valid_measurement'] as const;

export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type TargetState = (typeof TARGET_STATES)[number];
export type PlanVisibility = 'private' | 'player_guardian' | 'shared_with_org' | 'org_private';

export interface DueState { state: string; days: number | null }

export interface EvidenceView {
  linkId: string; sourceType: string; sourceId: string; sourceLabel: string;
  available: boolean; reason: string | null; note?: string | null;
  title?: string; provenance: string | null; occurredAt: number | null;
  simulated: boolean; measuredValue?: number | null; metricUnit?: string | null;
  productionValid?: boolean;
}

export interface ActionView {
  id: string; goalId: string; type: string; title: string; status: ActionStatus;
  dueAt: number | null; due: DueState;
  assignee: { kind: string; name: string | null } | null;
  completedAt: number | null; evidence: EvidenceView[];
}

export interface TargetView {
  state: TargetState; reason: string | null; statement: string;
  operatorSymbol: string; value: number; metricUnit: string; protocolTitle: string;
  measured: { value: number; attemptId: string; completedAt: number | null } | null;
  note: string; limitation: string;
}

export interface GoalView {
  id: string; title: string; description: string | null;
  category: GoalCategory; categoryLabel: string; status: GoalStatus;
  /** Only present on an achieved goal — the sentence travels with the word. */
  statusMeaning: string | null;
  blockReason: string | null; blockNote: string | null;
  targetDate: number | null;
  target: { protocolTitle: string; operator: string; value: number; metricUnit: string } | null;
  targetState: TargetView | null;
  createdBy: { kind: string; name: string | null } | null;
  rev: number;
  actions: ActionView[];
  actionCounts: Record<string, number>;
  /** Counts and a sentence. There is no ratio field, deliberately. */
  completion: { done: number; of: number; phrase: string };
  evidence: EvidenceView[];
  evidenceSummary: { total: number; available: number; unavailable: number; simulated: number; note: string };
}

export interface ReviewView {
  id: string;
  reviewerKind: 'player_reflection' | 'guardian_reflection' | 'coach_review';
  reviewedByName: string | null; reviewedAt: number;
  summary: string | null;
  /** Club-side only. A player's payload carries null here and always will. */
  internalNote: string | null;
  internalNoteNote?: string | null;
  hasInternalNote: boolean;
  nextReviewAt: number | null;
  supersedes: string | null; supersededBy: string | null;
  goalSnapshots: { goalId: string; title: string; status: string; completion: { phrase: string }; targetStateAtReview?: { state: string } | null }[];
}

export interface TimelineEntry {
  id: string; at: number; action: string; label: string; internal: boolean;
  subject: { kind: string; id: string; title: string | null };
  byKind: string; byName: string | null;
}

export interface DevelopmentPlanView {
  policyVersion: number; principle: string; limitation: string;
  plan: {
    id: string; playerId: string; playerName: string; title: string;
    status: PlanStatus; visibility: PlanVisibility;
    owner: { kind: 'player' | 'org'; orgId: string | null; orgName: string | null };
    createdBy: { kind: string; name: string | null } | null;
    startDate: number | null; nextReviewAt: number | null; endDate: number | null;
    reviewDue: DueState;
    sharedWithOrgIds?: string[]; sharedWithOrgCount: number;
    rev: number; revBy: string | null; revAt: number | null; updatedAt: number;
  };
  summary: {
    goalsByStatus: Record<GoalStatus, number>;
    activeGoals: number; actionsDue: number; actionsOverdue: number;
    linkedEvidenceAvailable: number;
    lastReviewAt: number | null; nextReviewAt: number | null;
    reviewDue: DueState; note: string;
  };
  goals: GoalView[];
  reviews: ReviewView[];
  timeline: TimelineEntry[];
  access: Record<string, boolean>;
  neverBuilt: { note: string; names: string[]; reason: string };
  idempotent?: boolean;
}

export interface PlanListItem {
  id: string; playerId: string; playerName: string | null; title: string;
  status: PlanStatus; visibility: PlanVisibility;
  owner: { kind: 'player' | 'org'; orgId: string | null };
  goalsByStatus: Record<GoalStatus, number>;
  activeGoals: number; actionsOverdue: number;
  nextReviewAt: number | null; reviewDue: DueState; updatedAt: number; rev: number;
}

export interface DevelopmentCatalogue {
  policyVersion: number; principle: string; limitation: string;
  plan: { visibilityByOwner: Record<string, string[]>; statuses: string[] };
  goal: {
    categories: string[]; categoryLabels: Record<string, string>;
    statuses: string[]; blockReasons: string[]; achievedMeaning: string;
    omitted: { categories: string[]; blockReasons: string[]; reason: string };
  };
  action: { types: string[]; statuses: string[] };
  evidence: { sources: string[]; sourceLabels: Record<string, string> };
  target: { sources: string[]; operators: string[]; states: string[]; limitation: string };
  review: { reviewerKinds: string[]; shareScopes: string[]; appendOnly: boolean };
  goalLibrary: { items: { id: string; category: string; title: string }[]; note: string };
  templates: { items: { id: string; title: string }[]; note: string };
  limits: Record<string, number>;
  reminders: { scheduler: string; note: string };
  neverBuilt: { names: string[]; note: string };
}

/** A refusal a coach can actually cause, kept as an answer rather than thrown. */
export type Refusal = { ok: false; error: string; detail: string; allowed?: unknown };
export type Result<T> = { ok: true; value: T } | Refusal;

export interface M21Api {
  catalogue(s: Session): Promise<DevelopmentCatalogue>;
  plans(s: Session, playerId?: string): Promise<{ items: PlanListItem[]; total: number; note: string }>;
  plan(s: Session, id: string): Promise<DevelopmentPlanView>;
  createPlan(s: Session, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  addGoal(s: Session, planId: string, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  updateGoal(s: Session, goalId: string, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  addAction(s: Session, goalId: string, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  updateAction(s: Session, actionId: string, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  linkEvidence(s: Session, goalId: string, body: { sourceType: string; sourceId: string }): Promise<Result<DevelopmentPlanView>>;
  unlinkEvidence(s: Session, linkId: string): Promise<DevelopmentPlanView>;
  setStatus(s: Session, planId: string, status: PlanStatus, expectedRev: number): Promise<Result<DevelopmentPlanView>>;
  setVisibility(s: Session, planId: string, visibility: PlanVisibility, expectedRev: number): Promise<Result<DevelopmentPlanView>>;
  submitReview(s: Session, planId: string, body: Record<string, unknown>): Promise<Result<DevelopmentPlanView>>;
  shareReview(s: Session, reviewId: string, scopes?: string[]): Promise<Result<DevelopmentPlanView>>;
  history(s: Session, planId: string): Promise<{ items: TimelineEntry[]; total: number; note: string }>;
}

const H = (s: Session) => ({ 'content-type': 'application/json', authorization: `Bearer ${s.token}` });

/**
 * Refusals the UI turns into a sentence rather than an error banner. Each one
 * is a decision the server made on purpose and can explain; a red "something
 * went wrong" would hide the explanation, which is the useful part.
 */
const ANSWERABLE = new Set([
  'GOAL_CATEGORY_UNKNOWN', 'GOAL_STATUS_UNKNOWN', 'GOAL_TRANSITION_INVALID',
  'ACTION_TYPE_UNKNOWN', 'ACTION_STATUS_UNKNOWN', 'ACTION_TRANSITION_INVALID',
  'PLAN_STATUS_UNKNOWN', 'PLAN_TRANSITION_INVALID', 'PLAN_VISIBILITY_INVALID',
  'PLAN_NOT_EDITABLE', 'PLAN_ARCHIVED', 'ACTIVE_PLAN_NEEDS_A_GOAL',
  'BLOCK_REASON_UNKNOWN', 'TEXT_TOO_LONG', 'DATE_INVALID', 'DATE_INTERVAL_INVALID', 'DATE_IN_PAST',
  'TARGET_SOURCE_UNSUPPORTED', 'TARGET_PROTOCOL_UNKNOWN', 'TARGET_PROTOCOL_VERSION_UNKNOWN',
  'TARGET_METRIC_MISMATCH', 'TARGET_OPERATOR_UNKNOWN', 'TARGET_OPERATOR_INCOMPATIBLE',
  'TARGET_VALUE_INVALID', 'TARGET_VALUE_OUT_OF_RANGE', 'TARGET_MALFORMED',
  'EVIDENCE_SOURCE_UNKNOWN', 'EVIDENCE_NOT_LINKABLE', 'EVIDENCE_ID_REQUIRED',
  'ASSIGNEE_INVALID', 'TOO_MANY_GOALS', 'TOO_MANY_ACTIONS', 'TOO_MANY_EVIDENCE_LINKS',
  'TOO_MANY_ACTIVE_PLANS', 'TITLE_REQUIRED', 'CLIENT_CANNOT_ASSERT',
  'REVIEW_EMPTY', 'REVIEW_NOT_PERMITTED', 'REVIEW_ALREADY_SUPERSEDED', 'REVIEW_NOT_CORRECTABLE',
  'SHARE_NEEDS_SUMMARY', 'SHARE_SCOPE_UNKNOWN', 'SHARE_NOT_APPLICABLE', 'PLAN_NOT_SHAREABLE',
  'INTERNAL_NOTE_NOT_PERMITTED', 'TEMPLATE_UNKNOWN', 'RATE_LIMITED',
]);

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw ApiError.fromResponse(res, body);
  return body as T;
}

/**
 * A write that may be answered rather than thrown.
 *
 * 409 is deliberately NOT absorbed here: a conflict is the shared M18.2
 * ConflictNotice's job, and swallowing it into a sentence would lose the
 * "someone else changed this" UX the whole codebase already has.
 */
async function write(path: string, s: Session, method: string, body: unknown): Promise<Result<DevelopmentPlanView>> {
  const res = await fetch(`${API_URL}${path}`, { method, headers: H(s), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  const code = String((data as { error?: string })?.error ?? '');
  if (!res.ok && res.status !== 409 && ANSWERABLE.has(code)) {
    const b = data as { error: string; detail?: string; message?: string; allowed?: unknown };
    return { ok: false, error: b.error, detail: String(b.detail ?? b.message ?? ''), allowed: b.allowed };
  }
  if (!res.ok) throw ApiError.fromResponse(res, data);
  return { ok: true, value: data as DevelopmentPlanView };
}

const qs = (params: Record<string, string | undefined>) => {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) out.set(k, v);
  const s = out.toString();
  return s ? `?${s}` : '';
};

export const httpM21: M21Api = {
  catalogue: (s) => req('/org/development/catalogue', { headers: H(s) }),
  plans: (s, playerId) => req(`/org/development/plans${qs({ playerId })}`, { headers: H(s) }),
  plan: (s, id) => req(`/org/development/plans/${id}`, { headers: H(s) }),
  createPlan: (s, body) => write('/org/development/plans', s, 'POST', body),
  addGoal: (s, planId, body) => write(`/org/development/plans/${planId}/goals`, s, 'POST', body),
  updateGoal: (s, goalId, body) => write(`/org/development/goals/${goalId}`, s, 'PATCH', body),
  addAction: (s, goalId, body) => write(`/org/development/goals/${goalId}/actions`, s, 'POST', body),
  updateAction: (s, actionId, body) => write(`/org/development/actions/${actionId}`, s, 'PATCH', body),
  linkEvidence: (s, goalId, body) => write(`/org/development/goals/${goalId}/evidence`, s, 'POST', body),
  unlinkEvidence: (s, linkId) => req(`/org/development/evidence/${linkId}`, { method: 'DELETE', headers: H(s) }),
  setStatus: (s, planId, status, expectedRev) => write(`/org/development/plans/${planId}/status`, s, 'POST', { status, expectedRev }),
  setVisibility: (s, planId, visibility, expectedRev) => write(`/org/development/plans/${planId}`, s, 'PATCH', { visibility, expectedRev }),
  submitReview: (s, planId, body) => write(`/org/development/plans/${planId}/reviews`, s, 'POST', body),
  shareReview: (s, reviewId, scopes) => write(`/org/development/reviews/${reviewId}/share`, s, 'POST', { scopes }),
  history: (s, planId) => req(`/org/development/plans/${planId}/history`, { headers: H(s) }),
};

export const m21: M21Api = DEMO_MODE ? demoM21 : httpM21;
