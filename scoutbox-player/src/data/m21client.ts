// M21 — Development Hub, player/guardian data surface.
//
// The server builds the whole plan projection: statuses, due states, target
// states, evidence availability and completion counts all arrive derived. This
// client sends intent and renders what comes back. It never computes a
// percentage, never decides whether a target is met, and never marks evidence
// verified — those are the four things §93 puts firmly on the server, and a
// client that recomputed any of them would eventually disagree with it.
//
// There is no Development Score in these types. There is no field one could be
// stored in, which is the point.
import { m12Request as req } from './httpClient';
import { m21mock } from './m21mock';

const DEMO = process.env.EXPO_PUBLIC_DEMO === '1';

export type PlanOwnerKind = 'player' | 'org';
export type PlanVisibility = 'private' | 'player_guardian' | 'shared_with_org' | 'org_private';
export type PlanStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type GoalStatus = 'not_started' | 'in_progress' | 'blocked' | 'achieved' | 'stopped';
export type ActionStatus = 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
export type TargetState = 'target_met' | 'target_not_met' | 'no_current_valid_measurement';

export interface DueState { state: string; days: number | null }

export interface EvidenceView {
  linkId: string;
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  available: boolean;
  reason: string | null;
  note?: string | null;
  title?: string;
  provenance: string | null;
  occurredAt: number | null;
  simulated: boolean;
  measuredValue?: number | null;
  metricUnit?: string | null;
}

export interface ActionView {
  id: string;
  goalId: string;
  type: string;
  title: string;
  status: ActionStatus;
  dueAt: number | null;
  due: DueState;
  assignee: { kind: string; name: string | null } | null;
  completedAt: number | null;
  evidence: EvidenceView[];
}

export interface TargetView {
  state: TargetState;
  reason: string | null;
  statement: string;
  operatorSymbol: string;
  value: number;
  metricUnit: string;
  protocolTitle: string;
  measured: { value: number; attemptId: string; completedAt: number | null } | null;
  note: string;
  limitation: string;
}

export interface GoalView {
  id: string;
  title: string;
  description: string | null;
  category: string;
  categoryLabel: string;
  status: GoalStatus;
  /** Present only when the status is `achieved` — the sentence travels with the word. */
  statusMeaning: string | null;
  blockReason: string | null;
  blockNote: string | null;
  targetDate: number | null;
  target: { protocolTitle: string; operator: string; value: number; metricUnit: string } | null;
  targetState: TargetView | null;
  createdBy: { kind: string; name: string | null } | null;
  rev: number;
  actions: ActionView[];
  actionCounts: Record<string, number>;
  /** Counts and a sentence made of counts. There is no ratio field, by design. */
  completion: { done: number; of: number; phrase: string };
  evidence: EvidenceView[];
  evidenceSummary: { total: number; available: number; unavailable: number; simulated: number; note: string };
}

export interface ReviewView {
  id: string;
  reviewerKind: 'player_reflection' | 'guardian_reflection' | 'coach_review';
  reviewedByName: string | null;
  reviewedAt: number;
  summary: string | null;
  internalNote: string | null;
  internalNoteNote?: string | null;
  hasInternalNote: boolean;
  nextReviewAt: number | null;
  supersedes: string | null;
  supersededBy: string | null;
  goalSnapshots: { goalId: string; title: string; status: string; completion: { phrase: string } }[];
}

export interface TimelineEntry {
  id: string; at: number; action: string; label: string; internal: boolean;
  subject: { kind: string; id: string; title: string | null };
  byKind: string; byName: string | null;
}

export interface DevelopmentPlanView {
  policyVersion: number;
  principle: string;
  limitation: string;
  plan: {
    id: string; playerId: string; playerName: string; title: string;
    status: PlanStatus; visibility: PlanVisibility;
    owner: { kind: PlanOwnerKind; orgId: string | null; orgName: string | null };
    createdBy: { kind: string; name: string | null } | null;
    startDate: number | null; nextReviewAt: number | null; endDate: number | null;
    reviewDue: DueState;
    sharedWithOrgIds?: string[]; sharedWithOrgCount: number;
    rev: number; updatedAt: number;
  };
  summary: {
    goalsByStatus: Record<GoalStatus, number>;
    activeGoals: number; actionsDue: number; actionsOverdue: number;
    linkedEvidenceAvailable: number;
    lastReviewAt: number | null; nextReviewAt: number | null;
    reviewDue: DueState;
    note: string;
  };
  goals: GoalView[];
  reviews: ReviewView[];
  timeline: TimelineEntry[];
  access: Record<string, boolean>;
  neverBuilt: { note: string; names: string[]; reason: string };
  idempotent?: boolean;
}

export interface PlanListItem {
  id: string; title: string; status: PlanStatus; visibility: PlanVisibility;
  owner: { kind: PlanOwnerKind; orgId: string | null };
  goalsByStatus: Record<GoalStatus, number>;
  activeGoals: number; actionsOverdue: number;
  nextReviewAt: number | null; reviewDue: DueState; updatedAt: number;
}

export interface DevelopmentCatalogue {
  principle: string;
  goal: {
    categories: string[];
    categoryLabels: Record<string, string>;
    blockReasons: string[];
    achievedMeaning: string;
    omitted: { categories: string[]; blockReasons: string[]; reason: string };
  };
  action: { types: string[]; statuses: string[] };
  evidence: { sources: string[]; sourceLabels: Record<string, string> };
  target: { operators: string[]; states: string[]; limitation: string };
  goalLibrary: { items: { id: string; category: string; title: string }[]; note: string };
  templates: { items: { id: string; title: string }[]; note: string };
  reminders: { scheduler: string; note: string };
  neverBuilt: { names: string[]; note: string };
}

export type DevActor = { kind: 'player'; id: string } | { kind: 'guardian'; id: string; childId: string };
const base = (a: DevActor) => (a.kind === 'player' ? '/player/development' : '/guardian/development');
const withChild = (a: DevActor, body: Record<string, unknown>) =>
  (a.kind === 'guardian' ? { ...body, playerId: a.childId } : body);

export interface PlayerM21 {
  catalogue(a: DevActor): Promise<DevelopmentCatalogue>;
  plans(a: DevActor): Promise<{ items: PlanListItem[]; total: number; note: string }>;
  plan(a: DevActor, id: string): Promise<DevelopmentPlanView>;
  createPlan(a: DevActor, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  addGoal(a: DevActor, planId: string, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  updateGoal(a: DevActor, goalId: string, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  addAction(a: DevActor, goalId: string, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  updateAction(a: DevActor, actionId: string, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  linkEvidence(a: DevActor, goalId: string, body: { sourceType: string; sourceId: string }): Promise<DevelopmentPlanView>;
  unlinkEvidence(a: DevActor, linkId: string): Promise<DevelopmentPlanView>;
  addReflection(a: DevActor, planId: string, body: Record<string, unknown>): Promise<DevelopmentPlanView>;
  history(a: DevActor, planId: string): Promise<{ items: TimelineEntry[]; total: number; note: string }>;
  share(a: DevActor, planId: string, orgId: string, revoke?: boolean): Promise<DevelopmentPlanView>;
  setVisibility(a: DevActor, planId: string, visibility: PlanVisibility, rev: number): Promise<DevelopmentPlanView>;
}

const post = (a: DevActor, path: string, body: unknown) =>
  req<DevelopmentPlanView>(`${base(a)}${path}`, a.id, { method: 'POST', body: JSON.stringify(body) });
const patch = (a: DevActor, path: string, body: unknown) =>
  req<DevelopmentPlanView>(`${base(a)}${path}`, a.id, { method: 'PATCH', body: JSON.stringify(body) });

const live: PlayerM21 = {
  catalogue: (a) => req(`${base(a)}/catalogue`, a.id),
  plans: (a) => req(`${base(a)}/plans`, a.id),
  plan: (a, id) => req(`${base(a)}/plans/${id}`, a.id),
  createPlan: (a, body) => post(a, '/plans', withChild(a, body)),
  addGoal: (a, planId, body) => post(a, `/plans/${planId}/goals`, body),
  updateGoal: (a, goalId, body) => patch(a, `/goals/${goalId}`, body),
  addAction: (a, goalId, body) => post(a, `/goals/${goalId}/actions`, body),
  updateAction: (a, actionId, body) => patch(a, `/actions/${actionId}`, body),
  linkEvidence: (a, goalId, body) => post(a, `/goals/${goalId}/evidence`, body),
  unlinkEvidence: (a, linkId) => req(`${base(a)}/evidence/${linkId}`, a.id, { method: 'DELETE' }),
  addReflection: (a, planId, body) => post(a, `/plans/${planId}/reviews`, body),
  history: (a, planId) => req(`${base(a)}/plans/${planId}/history`, a.id),
  share: (a, planId, orgId, revoke) => post(a, `/plans/${planId}/share`, { orgId, revoke: !!revoke }),
  setVisibility: (a, planId, visibility, rev) => patch(a, `/plans/${planId}`, { visibility, expectedRev: rev }),
};

export const m21: PlayerM21 = DEMO ? m21mock : live;
