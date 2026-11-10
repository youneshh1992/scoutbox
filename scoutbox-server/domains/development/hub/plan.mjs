/**
 * The Development Plan projection every route returns. Derived fields are
 * computed at read time. Counts are never combined or weighted: three counts
 * merged into one figure would be a Development Score by another name.
 */
import {
  DEVELOPMENT_POLICY_VERSION,
  DEVELOPMENT_PRINCIPLE,
  ACHIEVED_MEANING,
  FORBIDDEN_DEVELOPMENT_NAMES,
  GOAL_CATEGORY_LABELS,
  GOAL_STATUSES,
  actionCounts,
  completionPhrase,
  dueState,
  reviewDueState,
} from './shared.mjs';
import { evaluateTarget } from './targets.mjs';
import { resolveEvidenceLink, summariseEvidence } from './evidence.mjs';
import { reviewView } from './permissions.mjs';

export const PLAN_LIMITATION =
  'A Development Plan records what was agreed, what was done and what evidence was cited. It is a record of work, not a measurement of the player.';

/**
 * An allowlist: history actions not listed here never reach a timeline.
 * `internal: true` entries stay inside the owning organisation.
 */
export const TIMELINE_ACTIONS = Object.freeze({
  plan_created: { label: 'Plan created', internal: false },
  plan_activated: { label: 'Plan activated', internal: false },
  plan_paused: { label: 'Plan paused', internal: false },
  plan_completed: { label: 'Plan completed', internal: false },
  plan_archived: { label: 'Plan archived', internal: false },
  plan_shared: { label: 'Plan shared', internal: false },
  plan_unshared: { label: 'Sharing withdrawn', internal: false },
  // A club decision; stays internal even when the plan is shared.
  plan_visibility_changed: { label: 'Visibility changed', internal: true },
  goal_created: { label: 'Goal created', internal: false },
  goal_updated: { label: 'Goal updated', internal: false },
  goal_status_changed: { label: 'Goal status changed', internal: false },
  goal_target_set: { label: 'Objective target set', internal: false },
  action_created: { label: 'Action created', internal: false },
  action_status_changed: { label: 'Action status changed', internal: false },
  action_completed: { label: 'Action completed', internal: false },
  evidence_linked: { label: 'Evidence linked', internal: false },
  evidence_unlinked: { label: 'Evidence link removed', internal: false },
  review_submitted: { label: 'Review submitted', internal: true },
  review_shared: { label: 'Review shared', internal: false },
  review_superseded: { label: 'Review corrected', internal: true },
});

export const TIMELINE_ACTION_NAMES = Object.freeze(Object.keys(TIMELINE_ACTIONS));

/** `{ plan, goals, actions, links, reviews }`, or null. */
export function collectPlan(reads, planId) {
  return reads.plans.collect(planId);
}

/** `access` comes from `planAccess()` and is not recomputed here. */
export function buildDevelopmentPlan({
  reads = {},
  planId,
  player,
  viewer,
  access,
  orgCanSee,
  now = Date.now(),
  collected = null,
}) {
  const bundle = collected ?? collectPlan(reads.development, planId);
  if (!bundle) return null;
  const { plan, goals, actions, links, reviews } = bundle;
  if (!access?.read) return null;

  const attempts = reads.boxCam?.attempts.forPlayer(plan.playerId) ?? [];
  const sessions = new Map((reads.boxCam?.sessions.forPlayer(plan.playerId) ?? []).map((s) => [s.id, s]));

  const actionsByGoal = new Map();
  for (const a of actions) {
    if (!actionsByGoal.has(a.goalId)) actionsByGoal.set(a.goalId, []);
    actionsByGoal.get(a.goalId).push(a);
  }
  const linksByTarget = new Map();
  for (const l of links) {
    const key = l.goalId ?? l.actionId;
    if (!linksByTarget.has(key)) linksByTarget.set(key, []);
    linksByTarget.get(key).push(l);
  }

  const resolveFor = (key) =>
    (linksByTarget.get(key) ?? [])
      .map((l) => ({ linkId: l.id, ...resolveEvidenceLink(l, { reads, player, viewer, orgCanSee, now }) }))
      .sort(
        (a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0) || String(a.sourceId).localeCompare(String(b.sourceId)),
      );

  const goalViews = goals
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .map((g) => {
      const list = (actionsByGoal.get(g.id) ?? [])
        .slice()
        .sort(
          (x, y) =>
            (x.dueAt ?? Number.MAX_SAFE_INTEGER) - (y.dueAt ?? Number.MAX_SAFE_INTEGER) ||
            x.createdAt - y.createdAt ||
            String(x.id).localeCompare(String(y.id)),
        );
      const counts = actionCounts(list);
      const actionViews = list.map((a) => {
        const due = dueState(a.dueAt, now);
        if (due.state === 'overdue' && !['done', 'cancelled'].includes(a.status)) counts.overdue += 1;
        return {
          id: a.id,
          goalId: a.goalId,
          type: a.type,
          title: a.title,
          status: a.status,
          dueAt: a.dueAt ?? null,
          // Overdue describes a date and is never attributed to a person.
          due: ['done', 'cancelled'].includes(a.status) ? { state: 'not_applicable', days: null } : due,
          assignee: a.assignee ? { kind: a.assignee.kind, name: a.assignee.name } : null,
          completedAt: a.completedAt ?? null,
          evidence: resolveFor(a.id),
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        };
      });
      const evidence = resolveFor(g.id);
      const targetState = g.target ? evaluateTarget({ target: g.target, attempts, sessions }) : null;
      return {
        id: g.id,
        planId: g.planId,
        title: g.title,
        description: g.description ?? null,
        category: g.category,
        categoryLabel: GOAL_CATEGORY_LABELS[g.category] ?? g.category,
        status: g.status,
        statusMeaning: g.status === 'achieved' ? ACHIEVED_MEANING : null,
        blockReason: g.status === 'blocked' ? (g.blockReason ?? null) : null,
        blockNote: g.status === 'blocked' ? (g.blockNote ?? null) : null,
        targetDate: g.targetDate ?? null,
        targetDue: dueState(g.targetDate, now),
        target: g.target ?? null,
        targetState,
        origin: g.originObjectiveId ? { kind: 'development_objective', id: g.originObjectiveId } : null,
        createdBy: g.createdBy ? { kind: g.createdBy.kind, name: g.createdBy.name } : null,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        completedAt: g.completedAt ?? null,
        rev: g.rev ?? 1,
        revAt: g.revAt ?? null,
        revBy: g.revBy?.name ?? null,
        actions: actionViews,
        actionCounts: counts,
        completion: completionPhrase(counts),
        evidence,
        evidenceSummary: summariseEvidence(evidence),
      };
    });

  const reviewViews = reviews
    .slice()
    .sort((a, b) => b.reviewedAt - a.reviewedAt || String(b.id).localeCompare(String(a.id)))
    .map((r) => reviewView(r, access))
    // Drop unshared coach reviews entirely: even an empty row would disclose that the club wrote one.
    .filter((r) => access.readInternal || r.summary != null || r.reviewerKind !== 'coach_review');

  return {
    policyVersion: DEVELOPMENT_POLICY_VERSION,
    principle: DEVELOPMENT_PRINCIPLE,
    limitation: PLAN_LIMITATION,
    plan: planView(plan, { player, access, now }),
    summary: planSummary({ plan, goals: goalViews, reviews, now }),
    goals: goalViews,
    reviews: reviewViews,
    timeline: buildTimeline({ plan, goals, actions, reviews, access }),
    access: { ...access },
    neverBuilt: {
      note: 'These do not exist in ScoutBox and are not planned.',
      names: FORBIDDEN_DEVELOPMENT_NAMES,
      reason:
        'A single figure would invite a decision about a person that the figure cannot support. Development here is objective-specific, or it is nothing.',
    },
  };
}

function planView(plan, { player, access, now }) {
  const review = reviewDueState(plan.nextReviewAt, now);
  return {
    id: plan.id,
    playerId: plan.playerId,
    playerName: player.name,
    title: plan.title,
    status: plan.status,
    visibility: plan.visibility,
    owner: {
      kind: plan.owner.kind,
      orgId: plan.owner.orgId ?? null,
      orgName: plan.owner.orgName ?? null,
    },
    createdBy: plan.createdBy ? { kind: plan.createdBy.kind, name: plan.createdBy.name } : null,
    startDate: plan.startDate ?? null,
    nextReviewAt: plan.nextReviewAt ?? null,
    endDate: plan.endDate ?? null,
    reviewDue: review,
    templateId: plan.templateId ?? null,
    origin: plan.originObjectiveId
      ? { kind: 'development_objective', id: plan.originObjectiveId }
      : plan.originTrialId
        ? { kind: 'trial', id: plan.originTrialId }
        : null,
    // Shown only to those who may change it.
    sharedWithOrgIds: access.manage ? (plan.sharedWithOrgIds ?? []) : undefined,
    sharedWithOrgCount: (plan.sharedWithOrgIds ?? []).length,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    completedAt: plan.completedAt ?? null,
    archivedAt: plan.archivedAt ?? null,
    rev: plan.rev ?? 1,
    revAt: plan.revAt ?? null,
    revBy: plan.revBy?.name ?? null,
  };
}

/** Counts and dates only; deterministic for unchanged records. */
export function planSummary({ plan, goals, reviews, now }) {
  const byStatus = Object.fromEntries(GOAL_STATUSES.map((s) => [s, 0]));
  let actionsDue = 0;
  let actionsOverdue = 0;
  let evidenceAvailable = 0;
  for (const g of goals) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    for (const a of g.actions) {
      if (['done', 'cancelled'].includes(a.status)) continue;
      if (a.due.state === 'overdue') actionsOverdue += 1;
      else if (a.due.state === 'due_today' || a.due.state === 'due_soon') actionsDue += 1;
    }
    evidenceAvailable += g.evidenceSummary.available;
  }
  const lastReview = reviews.slice().sort((a, b) => b.reviewedAt - a.reviewedAt)[0] ?? null;
  return {
    goalsByStatus: byStatus,
    activeGoals: byStatus.in_progress + byStatus.not_started + byStatus.blocked,
    actionsDue,
    actionsOverdue,
    linkedEvidenceAvailable: evidenceAvailable,
    lastReviewAt: lastReview?.reviewedAt ?? null,
    nextReviewAt: plan.nextReviewAt ?? null,
    reviewDue: reviewDueState(plan.nextReviewAt, now),
    note: 'These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.',
  };
}

/** Projected from each record's append-only `history`; there is no separate event log. */
export function buildTimeline({ plan, goals, actions, reviews, access }) {
  const out = [];
  const push = (record, kind, subjectId, subjectTitle) => {
    for (const h of record.history ?? []) {
      const def = TIMELINE_ACTIONS[h.action];
      if (!def) continue;
      if (def.internal && !access.readInternal) continue;
      out.push({
        id: h.id,
        at: h.at,
        action: h.action,
        label: def.label,
        internal: def.internal,
        subject: { kind, id: subjectId, title: subjectTitle },
        byKind: h.byKind,
        byName: h.byName ?? null,
        // Server-written: a status or an id, never free text.
        detail: h.detail ?? null,
      });
    }
  };

  push(plan, 'plan', plan.id, plan.title);
  for (const g of goals) push(g, 'goal', g.id, g.title);
  for (const a of actions) push(a, 'action', a.id, a.title);
  for (const r of reviews) push(r, 'review', r.id, null);

  return out.sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
}

/** No evidence resolution or target evaluation, to keep lists cheap. */
export function planListItem({ plan, player, goals, actions, now }) {
  const byStatus = Object.fromEntries(GOAL_STATUSES.map((s) => [s, 0]));
  for (const g of goals) byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
  let overdue = 0;
  for (const a of actions) {
    if (['done', 'cancelled'].includes(a.status)) continue;
    if (dueState(a.dueAt, now).state === 'overdue') overdue += 1;
  }
  return {
    id: plan.id,
    playerId: plan.playerId,
    playerName: player?.name ?? null,
    title: plan.title,
    status: plan.status,
    visibility: plan.visibility,
    owner: { kind: plan.owner.kind, orgId: plan.owner.orgId ?? null },
    goalsByStatus: byStatus,
    activeGoals: byStatus.in_progress + byStatus.not_started + byStatus.blocked,
    actionsOverdue: overdue,
    nextReviewAt: plan.nextReviewAt ?? null,
    reviewDue: reviewDueState(plan.nextReviewAt, now),
    updatedAt: plan.updatedAt,
    rev: plan.rev ?? 1,
  };
}
