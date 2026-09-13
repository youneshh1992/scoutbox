/**
 * M21 — the one Development Plan projection (§101).
 *
 * `buildDevelopmentPlan()` is the only function that turns stored development
 * records into something a person reads. Every route returns its output, and
 * no route assembles a plan for itself. That centralisation is the mechanism
 * behind three separate promises:
 *
 *   • visibility is applied ONCE, from `planAccess`, so an internal note
 *     cannot be forgotten on the fourth surface that renders a review;
 *   • every derived field — due state, target state, evidence availability,
 *     completion counts — is derived HERE, at read time, so no stored number
 *     can drift away from the records it summarises;
 *   • the shape of the answer is the same everywhere, which is what makes the
 *     acceptance suite's "no score anywhere" assertion meaningful rather than
 *     a check of one endpoint.
 *
 * What it deliberately does not produce: any number that reads as a measure of
 * the player. Goals are counted by status, actions by completion, evidence by
 * availability. Nothing is combined, weighted or normalised, because the moment
 * three counts become one figure, that figure is a Development Score whatever
 * the field is called.
 */
import {
  DEVELOPMENT_POLICY_VERSION, DEVELOPMENT_PRINCIPLE, ACHIEVED_MEANING,
  FORBIDDEN_DEVELOPMENT_NAMES, GOAL_CATEGORY_LABELS, GOAL_STATUSES,
  actionCounts, completionPhrase, dueState, reviewDueState,
} from './shared.mjs';
import { evaluateTarget } from './targets.mjs';
import { resolveEvidenceLink, summariseEvidence } from './evidence.mjs';
import { reviewView } from './permissions.mjs';

export const PLAN_LIMITATION =
  'A Development Plan records what was agreed, what was done and what evidence was cited. It is a record of work, not a measurement of the player.';

/**
 * Timeline vocabulary (§41), and the allowlist that keeps it out of activity
 * spam (§42). An action not in this table never reaches a timeline, so a save
 * that changed nothing, a read, and a draft edit are absent by construction
 * rather than by a filter somebody has to remember to apply.
 *
 * `internal: true` means the entry stays inside the owning organisation.
 */
export const TIMELINE_ACTIONS = Object.freeze({
  plan_created: { label: 'Plan created', internal: false },
  plan_activated: { label: 'Plan activated', internal: false },
  plan_paused: { label: 'Plan paused', internal: false },
  plan_completed: { label: 'Plan completed', internal: false },
  plan_archived: { label: 'Plan archived', internal: false },
  plan_shared: { label: 'Plan shared', internal: false },
  plan_unshared: { label: 'Sharing withdrawn', internal: false },
  // Who a club's plan is visible to is a club decision; the fact of the change
  // stays inside the club even when the plan itself is shared.
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

/**
 * Gather every record belonging to one plan, in one pass per collection. The
 * snapshot store has no indexes — a scan IS the access path — so the shape of
 * this function is the performance story, and `scripts/m21Perf.mjs` measures it.
 */
export function collectPlan(db, planId) {
  const plan = (db.developmentPlans ?? []).find((p) => p.id === planId) ?? null;
  if (!plan) return null;
  const goals = (db.developmentGoals ?? []).filter((g) => g.planId === planId);
  const goalIds = new Set(goals.map((g) => g.id));
  const actions = (db.developmentActions ?? []).filter((a) => a.planId === planId || goalIds.has(a.goalId));
  const links = (db.developmentEvidenceLinks ?? []).filter((l) => l.planId === planId);
  const reviews = (db.developmentReviews ?? []).filter((r) => r.planId === planId);
  return { plan, goals, actions, links, reviews };
}

/**
 * The plan, as one viewer may see it.
 *
 * `access` comes from `planAccess()` and is not recomputed here: one
 * authorisation decision per request, applied consistently, is easier to audit
 * than four consistent ones.
 */
export function buildDevelopmentPlan({
  db, planId, player, viewer, access, orgCanSee, now = Date.now(), collected = null,
}) {
  const bundle = collected ?? collectPlan(db, planId);
  if (!bundle) return null;
  const { plan, goals, actions, links, reviews } = bundle;
  if (!access?.read) return null;

  const attempts = (db.combineAttempts ?? []).filter((a) => a.playerId === plan.playerId);
  const sessions = new Map((db.boxSessions ?? []).filter((s) => s.playerId === plan.playerId).map((s) => [s.id, s]));

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

  const resolveFor = (key) => (linksByTarget.get(key) ?? [])
    .map((l) => ({ linkId: l.id, ...resolveEvidenceLink(l, { db, player, viewer, orgCanSee, now }) }))
    .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0) || String(a.sourceId).localeCompare(String(b.sourceId)));

  const goalViews = goals
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)))
    .map((g) => {
      const list = (actionsByGoal.get(g.id) ?? []).slice()
        .sort((x, y) => (x.dueAt ?? Number.MAX_SAFE_INTEGER) - (y.dueAt ?? Number.MAX_SAFE_INTEGER)
          || x.createdAt - y.createdAt || String(x.id).localeCompare(String(y.id)));
      const counts = actionCounts(list);
      const actionViews = list.map((a) => {
        const due = dueState(a.dueAt, now);
        if (due.state === 'overdue' && !['done', 'cancelled'].includes(a.status)) counts.overdue += 1;
        return {
          id: a.id, goalId: a.goalId, type: a.type, title: a.title,
          status: a.status, dueAt: a.dueAt ?? null,
          // Overdue is a fact about a date. It is never attributed to a person,
          // and no copy in this milestone turns it into one (§47).
          due: ['done', 'cancelled'].includes(a.status) ? { state: 'not_applicable', days: null } : due,
          assignee: a.assignee ? { kind: a.assignee.kind, name: a.assignee.name } : null,
          completedAt: a.completedAt ?? null,
          evidence: resolveFor(a.id),
          createdAt: a.createdAt, updatedAt: a.updatedAt,
        };
      });
      const evidence = resolveFor(g.id);
      const targetState = g.target ? evaluateTarget({ target: g.target, attempts, sessions }) : null;
      return {
        id: g.id, planId: g.planId, title: g.title, description: g.description ?? null,
        category: g.category, categoryLabel: GOAL_CATEGORY_LABELS[g.category] ?? g.category,
        status: g.status,
        // The sentence travels with the word, every time it appears (§16).
        statusMeaning: g.status === 'achieved' ? ACHIEVED_MEANING : null,
        blockReason: g.status === 'blocked' ? (g.blockReason ?? null) : null,
        blockNote: g.status === 'blocked' ? (g.blockNote ?? null) : null,
        targetDate: g.targetDate ?? null,
        targetDue: dueState(g.targetDate, now),
        target: g.target ?? null,
        targetState,
        origin: g.originObjectiveId ? { kind: 'development_objective', id: g.originObjectiveId } : null,
        createdBy: g.createdBy ? { kind: g.createdBy.kind, name: g.createdBy.name } : null,
        createdAt: g.createdAt, updatedAt: g.updatedAt, completedAt: g.completedAt ?? null,
        rev: g.rev ?? 1, revAt: g.revAt ?? null, revBy: g.revBy?.name ?? null,
        actions: actionViews,
        // Counts, and a sentence made of counts. No ratio field exists for a
        // client to render as a percentage of a player (§46).
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
    // A player never receives the row of a review that was never shared with
    // them. Stripping the note but keeping the row would still say "the club
    // wrote something about you on 12 August", which is not ours to disclose.
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
      reason: 'A single figure would invite a decision about a person that the figure cannot support. Development here is objective-specific, or it is nothing.',
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
      : (plan.originTrialId ? { kind: 'trial', id: plan.originTrialId } : null),
    // Who a plan is shared with is management information, shown to whoever
    // may change it and to nobody else.
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

/**
 * The deterministic summary (§45). Every field is a count or a date, and the
 * whole object is reproducible from the records — read it twice on unchanged
 * data and it is byte-identical.
 */
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
    // Said out loud on the payload, because a summary block is exactly where a
    // reader expects to find a headline number.
    note: 'These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.',
  };
}

/**
 * The development timeline (§41/§42).
 *
 * Built by projecting the append-only `history` that `audit()` already writes
 * on every record — the same one clock M12 onwards uses. M21 stores no separate
 * event log, so the timeline cannot disagree with the record it describes.
 */
export function buildTimeline({ plan, goals, actions, reviews, access }) {
  const out = [];
  const push = (record, kind, subjectId, subjectTitle) => {
    for (const h of record.history ?? []) {
      const def = TIMELINE_ACTIONS[h.action];
      if (!def) continue; // not timeline-worthy: reads, saves and no-op edits never appear
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
        // `detail` is written by the server, never by a person: it carries a
        // status name or an id, never a note, a summary or free text.
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

/**
 * A plan as it appears in a list. Same visibility rules, far less work: no
 * evidence resolution and no target evaluation, because a list of twenty plans
 * must not scan every Combine attempt twenty times.
 */
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
