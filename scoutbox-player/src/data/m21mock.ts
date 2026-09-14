// M21 demo mirror — the Development Hub with no server.
//
// It reproduces the server's rules rather than approximating them, because a
// demo that behaves better than the product is a lie told in a nicer font.
// Specifically:
//
//   • completing an action never completes its goal;
//   • the demo Combine result is SIMULATED, so the objective target reads
//     `no_current_valid_measurement` and says why — a demo number crossing a
//     production threshold is exactly the dishonesty §149 forbids;
//   • the club's internal review note is not in this file's player payload at
//     all. It is not hidden by the UI; it is absent, the way the server sends
//     it;
//   • no field anywhere holds an overall figure.
import type {
  PlayerM21, DevActor, DevelopmentPlanView, PlanListItem, DevelopmentCatalogue,
  GoalView, ReviewView, TimelineEntry,
} from './m21client';

const now = Date.now();
const day = 86_400_000;

const CATEGORY_LABELS: Record<string, string> = {
  technical: 'Technical', tactical: 'Tactical', physical: 'Physical',
  psychological: 'Psychological', match_understanding: 'Match understanding',
  position_specific: 'Position-specific', other: 'Other',
};

const ACHIEVED_MEANING =
  'Achieved means the plan owner or reviewer marked this agreed objective complete. It is not a ScoutBox finding that the player permanently possesses this ability.';
const TARGET_LIMITATION =
  'A target compares one standardized Combine measurement against one number the goal states. It says whether that measurement has been reached — not whether the player has developed.';

const catalogue: DevelopmentCatalogue = {
  principle: 'Document and coordinate development. ScoutBox does not measure a player’s worth, ceiling or future.',
  goal: {
    categories: ['technical', 'tactical', 'physical', 'psychological', 'match_understanding', 'position_specific', 'other'],
    categoryLabels: CATEGORY_LABELS,
    blockReasons: ['waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other'],
    achievedMeaning: ACHIEVED_MEANING,
    omitted: {
      categories: ['availability_rehabilitation'],
      blockReasons: ['injury_or_unavailable'],
      reason: 'ScoutBox has no safe vocabulary, consent model or retention rule for health information, so it does not offer a structured field that invites one. A blocked goal can say “other” in the author’s own words.',
    },
  },
  action: { types: ['training', 'assessment', 'video_review', 'match_objective', 'coach_review', 'combine', 'box_cam', 'evidence_request', 'custom'], statuses: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'] },
  evidence: {
    sources: ['passport_evidence', 'assessment', 'box_cam_session', 'combine_attempt', 'trial_report'],
    sourceLabels: { passport_evidence: 'Passport evidence', assessment: 'Assessment', box_cam_session: 'Box Cam session', combine_attempt: 'Combine result', trial_report: 'Trial report' },
  },
  target: { operators: ['gte', 'gt', 'lte', 'lt', 'eq'], states: ['target_met', 'target_not_met', 'no_current_valid_measurement'], limitation: TARGET_LIMITATION },
  goalLibrary: {
    items: [
      { id: 'first_touch', category: 'technical', title: 'First touch under pressure' },
      { id: 'scanning', category: 'match_understanding', title: 'Scanning before receiving possession' },
      { id: 'weak_foot_passing', category: 'technical', title: 'Weak-foot passing consistency' },
      { id: 'defending_1v1', category: 'tactical', title: '1v1 defending' },
      { id: 'finishing', category: 'technical', title: 'Finishing from inside the box' },
      { id: 'aerial_timing', category: 'physical', title: 'Aerial timing' },
      { id: 'acceleration', category: 'physical', title: 'Acceleration mechanics' },
    ],
    note: 'Common development themes. The same list is shown to everyone — it is not a recommendation and it does not read this player’s record.',
  },
  templates: {
    items: [
      { id: 'technical_development', title: 'Technical Development' },
      { id: 'positional_development', title: 'Positional Development' },
      { id: 'trial_follow_up', title: 'Trial Follow-up' },
    ],
    note: 'A template is empty structure: a title and a category for each goal. ScoutBox does not know what a good development plan for this player contains, and does not claim to.',
  },
  reminders: {
    scheduler: 'none',
    note: 'Due and overdue are worked out when you open the page. ScoutBox has no background scheduler in this build and does not send reminders while the app is closed.',
  },
  neverBuilt: {
    names: ['Development Score', 'Potential Score', 'Improvement Score', 'Readiness Score', 'Growth Score', 'Academy Score', 'Player Progress Rating'],
    note: 'These do not exist in ScoutBox and are not planned. Development here is objective-specific, or it is nothing.',
  },
};

let seq = 0;
const id = (p: string) => `${p}-d${++seq}`;

const dueState = (dueAt: number | null) => {
  if (dueAt == null) return { state: 'no_due_date', days: null };
  const days = Math.round((dueAt - now) / day);
  if (days < 0) return { state: 'overdue', days: Math.abs(days) };
  if (days === 0) return { state: 'due_today', days: 0 };
  if (days <= 7) return { state: 'due_soon', days };
  return { state: 'upcoming', days };
};

function counts(actions: GoalView['actions']) {
  const c: Record<string, number> = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0, overdue: 0 };
  for (const a of actions) { c.total += 1; c[a.status] = (c[a.status] ?? 0) + 1; if (a.due.state === 'overdue' && a.status !== 'done' && a.status !== 'cancelled') c.overdue += 1; }
  return c;
}
const completion = (c: Record<string, number>) => {
  const of = c.total - c.cancelled;
  return { done: c.done, of, phrase: `${c.done} of ${of} actions completed` };
};

function goal(partial: Partial<GoalView> & { title: string; category: string }): GoalView {
  const actions = partial.actions ?? [];
  const c = counts(actions);
  const evidence = partial.evidence ?? [];
  return {
    id: partial.id ?? id('devgoal'),
    title: partial.title,
    description: partial.description ?? null,
    category: partial.category,
    categoryLabel: CATEGORY_LABELS[partial.category] ?? partial.category,
    status: partial.status ?? 'in_progress',
    statusMeaning: (partial.status ?? 'in_progress') === 'achieved' ? ACHIEVED_MEANING : null,
    blockReason: partial.blockReason ?? null,
    blockNote: partial.blockNote ?? null,
    targetDate: partial.targetDate ?? null,
    target: partial.target ?? null,
    targetState: partial.targetState ?? null,
    createdBy: partial.createdBy ?? { kind: 'player', name: 'You' },
    rev: 1,
    actions,
    actionCounts: c,
    completion: completion(c),
    evidence,
    evidenceSummary: {
      total: evidence.length,
      available: evidence.filter((e) => e.available).length,
      unavailable: evidence.filter((e) => !e.available).length,
      simulated: evidence.filter((e) => e.simulated).length,
      note: evidence.length === 0 ? 'No evidence linked yet.' : `${evidence.filter((e) => e.available).length} of ${evidence.length} linked items are currently available.`,
    },
  };
}

const action = (title: string, type: string, status: GoalView['actions'][number]['status'], dueAt: number | null, goalId: string) => ({
  id: id('devact'), goalId, type, title, status, dueAt, due: status === 'done' || status === 'cancelled' ? { state: 'not_applicable', days: null } : dueState(dueAt),
  assignee: { kind: 'player', name: 'You' }, completedAt: status === 'done' ? now - day : null, evidence: [],
});

// ---------------------------------------------------------------- the story
const g1id = 'devgoal-weakfoot';
const g2id = 'devgoal-scanning';
const g3id = 'devgoal-boxtouch';

const goals: GoalView[] = [
  goal({
    id: g1id, title: 'Improve weak-foot passing consistency', category: 'technical', status: 'in_progress',
    description: 'Left-foot passes over 15–25m under light pressure.',
    actions: [
      action('Two weak-foot passing sessions this week', 'training', 'done', now - 2 * day, g1id),
      action('Review match clips with coach', 'video_review', 'todo', now + 3 * day, g1id),
      action('Record a full-match assessment', 'assessment', 'todo', now + 12 * day, g1id),
    ],
    evidence: [
      { linkId: 'devlink-d1', sourceType: 'box_cam_session', sourceId: 'boxs-d2', sourceLabel: 'Box Cam session', available: true, reason: null, title: 'box-touches', provenance: 'box_cam_observed', occurredAt: now - 5 * day, simulated: true, note: 'Observed training. ScoutBox recorded activity consistent with the selected drill; it does not measure how much the player improved.' },
      { linkId: 'devlink-d2', sourceType: 'assessment', sourceId: 'ass-d1', sourceLabel: 'Assessment', available: true, reason: null, title: 'Assessment — Eastport United 2–1 Harbour', provenance: 'verified_club_confirmed', occurredAt: now - 20 * day, simulated: false },
    ],
  }),
  goal({
    id: g2id, title: 'Improve scanning before receiving possession', category: 'match_understanding', status: 'blocked',
    blockReason: 'waiting_for_assessment',
    blockNote: 'Waiting on the next full-match assessment before we judge this one.',
    actions: [action('Attend positional review session', 'coach_review', 'todo', now - 4 * day, g2id)],
    evidence: [
      // An item the player's own account cannot resolve: the record exists, the
      // detail does not travel. The link stays visible, which is the honest
      // outcome — something was cited and is no longer available.
      { linkId: 'devlink-d3', sourceType: 'passport_evidence', sourceId: 'evd-gone', sourceLabel: 'Passport evidence', available: false, reason: 'evidence_superseded', title: undefined, provenance: null, occurredAt: null, simulated: false, note: 'This evidence was replaced by a corrected record.' },
    ],
  }),
  goal({
    id: g3id, title: 'Improve Box Touch 60 from 140 to 160+', category: 'technical', status: 'in_progress',
    actions: [action('Complete a Box Touch 60 Combine attempt', 'combine', 'in_progress', now + 6 * day, g3id)],
    target: { protocolTitle: 'Box Touch 60', operator: 'gte', value: 160, metricUnit: 'touches' },
    targetState: {
      // The demo's Combine result is simulated, so it CANNOT satisfy a
      // production target. The demo says so rather than showing a green tick.
      state: 'no_current_valid_measurement',
      reason: 'no_production_valid_attempt',
      statement: 'Box Touch 60 ≥ 160 touches',
      operatorSymbol: '≥', value: 160, metricUnit: 'touches', protocolTitle: 'Box Touch 60',
      measured: null,
      note: 'There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target.',
      limitation: TARGET_LIMITATION,
    },
    evidence: [
      { linkId: 'devlink-d4', sourceType: 'combine_attempt', sourceId: 'catt-d1', sourceLabel: 'Combine result', available: true, reason: null, title: 'Box Touch 60', provenance: 'simulated_demo', occurredAt: now - 9 * day, simulated: true, measuredValue: 141, metricUnit: 'touches' },
    ],
  }),
];

const reviews: ReviewView[] = [
  {
    id: 'devrev-d1', reviewerKind: 'coach_review', reviewedByName: 'A. Coach', reviewedAt: now - 6 * day,
    summary: 'Good week on the weak foot. Scanning is the one to push next — we will look again after the next full match.',
    // The player payload carries no internal note. Its EXISTENCE is
    // acknowledged, because pretending the club wrote nothing is its own lie.
    internalNote: null,
    internalNoteNote: 'This review also contains notes kept inside the club. They are not shared.',
    hasInternalNote: true,
    nextReviewAt: now + 9 * day,
    supersedes: null, supersededBy: null,
    goalSnapshots: [
      { goalId: g1id, title: 'Improve weak-foot passing consistency', status: 'in_progress', completion: { phrase: '1 of 3 actions completed' } },
      { goalId: g2id, title: 'Improve scanning before receiving possession', status: 'blocked', completion: { phrase: '0 of 1 actions completed' } },
      { goalId: g3id, title: 'Improve Box Touch 60 from 140 to 160+', status: 'in_progress', completion: { phrase: '0 of 1 actions completed' } },
    ],
  },
  {
    id: 'devrev-d2', reviewerKind: 'player_reflection', reviewedByName: 'You', reviewedAt: now - 3 * day,
    summary: 'Weak foot felt better in the second session. Still late turning my head before I receive.',
    internalNote: null, hasInternalNote: false, nextReviewAt: null,
    supersedes: null, supersededBy: null, goalSnapshots: [],
  },
];

const timeline: TimelineEntry[] = [
  { id: 'aud-d9', at: now - 3 * day, action: 'review_submitted', label: 'Review submitted', internal: false, subject: { kind: 'review', id: 'devrev-d2', title: null }, byKind: 'player', byName: 'You' },
  { id: 'aud-d8', at: now - 6 * day, action: 'review_shared', label: 'Review shared', internal: false, subject: { kind: 'review', id: 'devrev-d1', title: null }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d7', at: now - 8 * day, action: 'action_completed', label: 'Action completed', internal: false, subject: { kind: 'action', id: 'devact-1', title: 'Two weak-foot passing sessions this week' }, byKind: 'player', byName: 'You' },
  { id: 'aud-d6', at: now - 9 * day, action: 'evidence_linked', label: 'Evidence linked', internal: false, subject: { kind: 'goal', id: g3id, title: 'Improve Box Touch 60 from 140 to 160+' }, byKind: 'player', byName: 'You' },
  { id: 'aud-d5', at: now - 12 * day, action: 'goal_target_set', label: 'Objective target set', internal: false, subject: { kind: 'goal', id: g3id, title: 'Improve Box Touch 60 from 140 to 160+' }, byKind: 'player', byName: 'You' },
  { id: 'aud-d4', at: now - 14 * day, action: 'goal_created', label: 'Goal created', internal: false, subject: { kind: 'goal', id: g2id, title: 'Improve scanning before receiving possession' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d3', at: now - 14 * day, action: 'goal_created', label: 'Goal created', internal: false, subject: { kind: 'goal', id: g1id, title: 'Improve weak-foot passing consistency' }, byKind: 'player', byName: 'You' },
  { id: 'aud-d2', at: now - 14 * day, action: 'plan_activated', label: 'Plan activated', internal: false, subject: { kind: 'plan', id: 'devplan-d1', title: 'Pre-season Development Plan' }, byKind: 'player', byName: 'You' },
  { id: 'aud-d1', at: now - 14 * day, action: 'plan_created', label: 'Plan created', internal: false, subject: { kind: 'plan', id: 'devplan-d1', title: 'Pre-season Development Plan' }, byKind: 'player', byName: 'You' },
];

function summarise(gs: GoalView[]) {
  const byStatus: Record<string, number> = { not_started: 0, in_progress: 0, blocked: 0, achieved: 0, stopped: 0 };
  let due = 0; let overdue = 0; let evidence = 0;
  for (const g of gs) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    for (const a of g.actions) {
      if (a.status === 'done' || a.status === 'cancelled') continue;
      if (a.due.state === 'overdue') overdue += 1;
      else if (a.due.state === 'due_today' || a.due.state === 'due_soon') due += 1;
    }
    evidence += g.evidenceSummary.available;
  }
  return { byStatus, due, overdue, evidence };
}

function view(): DevelopmentPlanView {
  const s = summarise(goals);
  return {
    policyVersion: 1,
    principle: catalogue.principle,
    limitation: 'A Development Plan records what was agreed, what was done and what evidence was cited. It is a record of work, not a measurement of the player.',
    plan: {
      id: 'devplan-d1', playerId: 'demo', playerName: 'You', title: 'Pre-season Development Plan',
      status: 'active', visibility: 'shared_with_org',
      owner: { kind: 'player', orgId: null, orgName: null },
      createdBy: { kind: 'player', name: 'You' },
      startDate: now - 14 * day, nextReviewAt: now + 9 * day, endDate: null,
      reviewDue: { state: 'review_upcoming', days: 9 },
      sharedWithOrgIds: ['org-eastport'], sharedWithOrgCount: 1,
      rev: 4, updatedAt: now - 3 * day,
    },
    summary: {
      goalsByStatus: s.byStatus as DevelopmentPlanView['summary']['goalsByStatus'],
      activeGoals: s.byStatus.in_progress + s.byStatus.not_started + s.byStatus.blocked,
      actionsDue: s.due, actionsOverdue: s.overdue,
      linkedEvidenceAvailable: s.evidence,
      lastReviewAt: reviews[0].reviewedAt, nextReviewAt: now + 9 * day,
      reviewDue: { state: 'review_upcoming', days: 9 },
      note: 'These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.',
    },
    goals,
    reviews,
    timeline,
    access: { read: true, readInternal: false, writeGoals: true, manage: true, review: false, reflect: true, linkEvidence: true },
    neverBuilt: {
      note: catalogue.neverBuilt.note,
      names: catalogue.neverBuilt.names,
      reason: 'A single figure would invite a decision about a person that the figure cannot support. Development here is objective-specific, or it is nothing.',
    },
  };
}

const listItem = (): PlanListItem => {
  const v = view();
  return {
    id: v.plan.id, title: v.plan.title, status: v.plan.status, visibility: v.plan.visibility,
    owner: { kind: 'player', orgId: null },
    goalsByStatus: v.summary.goalsByStatus, activeGoals: v.summary.activeGoals,
    actionsOverdue: v.summary.actionsOverdue, nextReviewAt: v.plan.nextReviewAt,
    reviewDue: v.plan.reviewDue, updatedAt: v.plan.updatedAt,
  };
};

const ok = async (_a: DevActor) => view();

export const m21mock: PlayerM21 = {
  catalogue: async () => catalogue,
  linkable: async () => ({
    items: [
      { sourceType: 'box_cam_session', sourceId: 'boxs-d2', sourceLabel: 'Box Cam session', title: 'box-touches', provenance: 'box_cam_observed', occurredAt: now - 5 * day, simulated: true },
      { sourceType: 'combine_attempt', sourceId: 'catt-d1', sourceLabel: 'Combine result', title: 'Box Touch 60', provenance: 'simulated_demo', occurredAt: now - 9 * day, simulated: true },
      { sourceType: 'assessment', sourceId: 'ass-d1', sourceLabel: 'Assessment', title: 'Assessment — Eastport United 2–1 Harbour', provenance: 'verified_club_confirmed', occurredAt: now - 20 * day, simulated: false },
    ],
    note: 'Canonical records you can cite. Linking one stores a reference — the evidence itself stays where it lives, and is read live every time.',
  }),
  plans: async () => ({ items: [listItem()], total: 1, note: 'Plans you can see. ScoutBox does not report how many other plans exist.' }),
  plan: ok,
  createPlan: async (a, body) => {
    const g = (body.goals as { title?: string; category?: string }[] | undefined) ?? [];
    for (const gb of g) if (gb.title) goals.push(goal({ title: gb.title, category: gb.category ?? 'other', status: 'not_started', actions: [] }));
    return view();
  },
  addGoal: async (_a, _planId, body) => {
    goals.push(goal({ title: String(body.title ?? 'New goal'), category: String(body.category ?? 'other'), status: 'not_started', actions: [] }));
    return view();
  },
  updateGoal: async (_a, goalId, body) => {
    const g = goals.find((x) => x.id === goalId);
    if (g) {
      if (typeof body.title === 'string') g.title = body.title;
      if (typeof body.status === 'string') {
        // The same refusal the server makes: a goal nobody started cannot have
        // been achieved through this plan.
        if (!(g.status === 'not_started' && body.status === 'achieved')) {
          g.status = body.status as GoalView['status'];
          g.statusMeaning = g.status === 'achieved' ? ACHIEVED_MEANING : null;
        }
      }
    }
    return view();
  },
  addAction: async (_a, goalId, body) => {
    const g = goals.find((x) => x.id === goalId);
    if (g) {
      g.actions.push(action(String(body.title ?? 'New action'), String(body.type ?? 'training'), 'todo', null, goalId));
      g.actionCounts = counts(g.actions);
      g.completion = completion(g.actionCounts);
    }
    return view();
  },
  updateAction: async (_a, actionId, body) => {
    for (const g of goals) {
      const act = g.actions.find((x) => x.id === actionId);
      if (!act) continue;
      if (typeof body.status === 'string') {
        act.status = body.status as typeof act.status;
        act.completedAt = act.status === 'done' ? now : null;
        act.due = act.status === 'done' || act.status === 'cancelled' ? { state: 'not_applicable', days: null } : dueState(act.dueAt);
      }
      // The goal does not move. Completing an action completes an action.
      g.actionCounts = counts(g.actions);
      g.completion = completion(g.actionCounts);
    }
    return view();
  },
  linkEvidence: ok as PlayerM21['linkEvidence'],
  unlinkEvidence: ok as PlayerM21['unlinkEvidence'],
  addReflection: async (_a, _planId, body) => {
    reviews.unshift({
      id: id('devrev'), reviewerKind: 'player_reflection', reviewedByName: 'You', reviewedAt: Date.now(),
      summary: String(body.summary ?? ''), internalNote: null, hasInternalNote: false,
      nextReviewAt: null, supersedes: null, supersededBy: null, goalSnapshots: [],
    });
    return view();
  },
  history: async () => ({ items: timeline, total: timeline.length, note: 'Meaningful development events only. Reads and saves that changed nothing are not recorded.' }),
  share: ok as PlayerM21['share'],
  setVisibility: ok as PlayerM21['setVisibility'],
};
