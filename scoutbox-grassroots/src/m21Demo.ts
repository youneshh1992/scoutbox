// M21 demo mirror (org side) — the Development Hub with no server.
//
// The demo reproduces the server's rules rather than flattering them:
//
//   • the club's internal review note IS present here, because this is the
//     club's own view — and the demo also shows the same review as the player
//     receives it, so the difference between the two is visible rather than
//     asserted;
//   • the demo Combine result is simulated, so the objective target reads
//     `no_current_valid_measurement` and says exactly why. A demo number
//     crossing a production threshold would be the dishonesty §149 forbids;
//   • completing an action leaves the goal where it was;
//   • one evidence link resolves as unavailable, because that is a real state
//     and hiding it would make the demo easier than the product.
//
// Only `import type` from the API module, so the demo cannot pull the HTTP
// client into a bundle that must never make a network call.
import type {
  M21Api, DevelopmentPlanView, DevelopmentCatalogue, PlanListItem,
  GoalView, GoalCategory, ReviewView, TimelineEntry, ActionView, Result,
} from './m21Api';

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
const PLAN_LIMITATION =
  'A Development Plan records what was agreed, what was done and what evidence was cited. It is a record of work, not a measurement of the player.';
const PRINCIPLE =
  'Document and coordinate development. ScoutBox does not measure a player’s worth, ceiling or future.';

const catalogue: DevelopmentCatalogue = {
  policyVersion: 1,
  principle: PRINCIPLE,
  limitation: PLAN_LIMITATION,
  plan: {
    visibilityByOwner: { player: ['private', 'player_guardian', 'shared_with_org'], org: ['org_private', 'player_guardian'] },
    statuses: ['draft', 'active', 'paused', 'completed', 'archived'],
  },
  goal: {
    categories: ['technical', 'tactical', 'physical', 'psychological', 'match_understanding', 'position_specific', 'other'],
    categoryLabels: CATEGORY_LABELS,
    statuses: ['not_started', 'in_progress', 'blocked', 'achieved', 'stopped'],
    blockReasons: ['waiting_for_assessment', 'schedule', 'facility', 'coach_review', 'other'],
    achievedMeaning: ACHIEVED_MEANING,
    omitted: {
      categories: ['availability_rehabilitation'],
      blockReasons: ['injury_or_unavailable'],
      reason: 'ScoutBox has no safe vocabulary, consent model or retention rule for health information, so it does not offer a structured field that invites one. A blocked goal can say “other” in the author’s own words.',
    },
  },
  action: {
    types: ['training', 'assessment', 'video_review', 'match_objective', 'coach_review', 'combine', 'box_cam', 'evidence_request', 'custom'],
    statuses: ['todo', 'in_progress', 'done', 'blocked', 'cancelled'],
  },
  evidence: {
    sources: ['passport_evidence', 'assessment', 'box_cam_session', 'combine_attempt', 'trial_report'],
    sourceLabels: { passport_evidence: 'Passport evidence', assessment: 'Assessment', box_cam_session: 'Box Cam session', combine_attempt: 'Combine result', trial_report: 'Trial report' },
  },
  target: {
    sources: ['combine_attempt'],
    operators: ['gte', 'gt', 'lte', 'lt', 'eq'],
    states: ['target_met', 'target_not_met', 'no_current_valid_measurement'],
    limitation: TARGET_LIMITATION,
  },
  review: { reviewerKinds: ['player_reflection', 'guardian_reflection', 'coach_review'], shareScopes: ['summary', 'goals', 'actions'], appendOnly: true },
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
  limits: { goalsPerPlan: 20, actionsPerGoal: 20, evidenceLinksPerTarget: 30, activePlansPerOwner: 5, titleMax: 120, descriptionMax: 1000, noteMax: 2000, summaryMax: 2000 },
  reminders: {
    scheduler: 'none',
    note: 'Due and overdue are worked out when the page is opened. ScoutBox has no background scheduler in this build and sends no reminders while the app is closed.',
  },
  neverBuilt: {
    names: ['Development Score', 'Potential Score', 'Improvement Score', 'Readiness Score', 'Growth Score', 'Academy Score', 'Player Progress Rating'],
    note: 'These do not exist in ScoutBox and are not planned. Development here is objective-specific, or it is nothing.',
  },
};

let seq = 0;
const nid = (p: string) => `${p}-d${++seq}`;

const dueState = (dueAt: number | null) => {
  if (dueAt == null) return { state: 'no_due_date', days: null };
  const days = Math.round((dueAt - now) / day);
  if (days < 0) return { state: 'overdue', days: Math.abs(days) };
  if (days === 0) return { state: 'due_today', days: 0 };
  if (days <= 7) return { state: 'due_soon', days };
  return { state: 'upcoming', days };
};

function counts(actions: ActionView[]) {
  const c: Record<string, number> = { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0, overdue: 0 };
  for (const a of actions) {
    c.total += 1; c[a.status] = (c[a.status] ?? 0) + 1;
    if (a.due.state === 'overdue' && a.status !== 'done' && a.status !== 'cancelled') c.overdue += 1;
  }
  return c;
}
const completion = (c: Record<string, number>) => {
  const of = c.total - c.cancelled;
  return { done: c.done, of, phrase: `${c.done} of ${of} actions completed` };
};

const mkAction = (goalId: string, title: string, type: string, status: ActionView['status'], dueAt: number | null): ActionView => ({
  id: nid('devact'), goalId, type, title, status, dueAt,
  due: status === 'done' || status === 'cancelled' ? { state: 'not_applicable', days: null } : dueState(dueAt),
  assignee: { kind: 'player', name: 'Alonso Mbuguni' },
  completedAt: status === 'done' ? now - day : null,
  evidence: [],
});

function mkGoal(p: Partial<GoalView> & { id: string; title: string; category: string }): GoalView {
  const actions = p.actions ?? [];
  const c = counts(actions);
  const evidence = p.evidence ?? [];
  return {
    id: p.id, title: p.title, description: p.description ?? null,
    category: p.category as GoalView['category'], categoryLabel: CATEGORY_LABELS[p.category] ?? p.category,
    status: p.status ?? 'in_progress',
    statusMeaning: (p.status ?? 'in_progress') === 'achieved' ? ACHIEVED_MEANING : null,
    blockReason: p.blockReason ?? null, blockNote: p.blockNote ?? null,
    targetDate: p.targetDate ?? null, target: p.target ?? null, targetState: p.targetState ?? null,
    createdBy: p.createdBy ?? { kind: 'org', name: 'A. Coach' },
    rev: p.rev ?? 1,
    actions, actionCounts: c, completion: completion(c),
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

const G1 = 'devgoal-weakfoot';
const G2 = 'devgoal-scanning';
const G3 = 'devgoal-boxtouch';

const goals: GoalView[] = [
  mkGoal({
    id: G1, title: 'Improve weak-foot passing consistency', category: 'technical', status: 'in_progress',
    description: 'Left-foot passes over 15–25m under light pressure.',
    actions: [
      mkAction(G1, 'Two weak-foot passing sessions per week', 'training', 'done', now - 2 * day),
      mkAction(G1, 'Review match clips with coach', 'video_review', 'todo', now + 3 * day),
      mkAction(G1, 'Record next full-match assessment', 'assessment', 'todo', now + 12 * day),
    ],
    evidence: [
      { linkId: 'devlink-d1', sourceType: 'box_cam_session', sourceId: 'boxs-d2', sourceLabel: 'Box Cam session', available: true, reason: null, title: 'box-touches', provenance: 'box_cam_observed', occurredAt: now - 5 * day, simulated: true, note: 'Observed training. ScoutBox recorded activity consistent with the selected drill; it does not measure how much the player improved.' },
      { linkId: 'devlink-d2', sourceType: 'assessment', sourceId: 'ass-d1', sourceLabel: 'Assessment', available: true, reason: null, title: 'Assessment — Eastport United 2–1 Harbour', provenance: 'verified_club_confirmed', occurredAt: now - 20 * day, simulated: false },
    ],
  }),
  mkGoal({
    id: G2, title: 'Improve scanning before receiving possession', category: 'match_understanding', status: 'blocked',
    blockReason: 'waiting_for_assessment',
    blockNote: 'Waiting on the next full-match assessment before judging this one.',
    actions: [mkAction(G2, 'Attend positional review session', 'coach_review', 'todo', now - 4 * day)],
    evidence: [
      { linkId: 'devlink-d3', sourceType: 'passport_evidence', sourceId: 'evd-gone', sourceLabel: 'Passport evidence', available: false, reason: 'evidence_superseded', provenance: null, occurredAt: null, simulated: false, note: 'This evidence was replaced by a corrected record.' },
    ],
  }),
  mkGoal({
    id: G3, title: 'Improve Box Touch 60 from 140 to 160+', category: 'technical', status: 'in_progress',
    actions: [mkAction(G3, 'Complete a Box Touch 60 Combine attempt', 'combine', 'in_progress', now + 6 * day)],
    target: { protocolTitle: 'Box Touch 60', operator: 'gte', value: 160, metricUnit: 'touches' },
    targetState: {
      state: 'no_current_valid_measurement', reason: 'no_production_valid_attempt',
      statement: 'Box Touch 60 ≥ 160 touches', operatorSymbol: '≥', value: 160,
      metricUnit: 'touches', protocolTitle: 'Box Touch 60', measured: null,
      note: 'There is no Combine Verified result for this protocol. A simulated or test result cannot satisfy a target.',
      limitation: TARGET_LIMITATION,
    },
    evidence: [
      { linkId: 'devlink-d4', sourceType: 'combine_attempt', sourceId: 'catt-d1', sourceLabel: 'Combine result', available: true, reason: null, title: 'Box Touch 60', provenance: 'simulated_demo', occurredAt: now - 9 * day, simulated: true, measuredValue: 141, metricUnit: 'touches', productionValid: false },
    ],
  }),
];

const reviews: ReviewView[] = [
  {
    id: 'devrev-d1', reviewerKind: 'coach_review', reviewedByName: 'A. Coach', reviewedAt: now - 6 * day,
    summary: 'Good week on the weak foot. Scanning is the one to push next — we will look again after the next full match.',
    // Club-side view: the note IS here. The player's view of this same review
    // has null in this field, which is the difference the demo exists to show.
    internalNote: 'Not ready for the first team this season. Revisit in the winter window.',
    hasInternalNote: true,
    nextReviewAt: now + 9 * day,
    supersedes: null, supersededBy: null,
    goalSnapshots: [
      { goalId: G1, title: 'Improve weak-foot passing consistency', status: 'in_progress', completion: { phrase: '1 of 3 actions completed' } },
      { goalId: G2, title: 'Improve scanning before receiving possession', status: 'blocked', completion: { phrase: '0 of 1 actions completed' } },
      { goalId: G3, title: 'Improve Box Touch 60 from 140 to 160+', status: 'in_progress', completion: { phrase: '0 of 1 actions completed' }, targetStateAtReview: { state: 'no_current_valid_measurement' } },
    ],
  },
  {
    id: 'devrev-d2', reviewerKind: 'player_reflection', reviewedByName: 'Alonso Mbuguni', reviewedAt: now - 3 * day,
    summary: 'Weak foot felt better in the second session. Still late turning my head before I receive.',
    internalNote: null, hasInternalNote: false, nextReviewAt: null,
    supersedes: null, supersededBy: null, goalSnapshots: [],
  },
];

const timeline: TimelineEntry[] = [
  { id: 'aud-d9', at: now - 3 * day, action: 'review_submitted', label: 'Review submitted', internal: true, subject: { kind: 'review', id: 'devrev-d2', title: null }, byKind: 'player', byName: 'Alonso Mbuguni' },
  { id: 'aud-d8', at: now - 6 * day, action: 'review_shared', label: 'Review shared', internal: false, subject: { kind: 'review', id: 'devrev-d1', title: null }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d7', at: now - 8 * day, action: 'action_completed', label: 'Action completed', internal: false, subject: { kind: 'action', id: 'devact-d1', title: 'Two weak-foot passing sessions per week' }, byKind: 'player', byName: 'Alonso Mbuguni' },
  { id: 'aud-d6', at: now - 9 * day, action: 'evidence_linked', label: 'Evidence linked', internal: false, subject: { kind: 'goal', id: G3, title: 'Improve Box Touch 60 from 140 to 160+' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d5', at: now - 12 * day, action: 'goal_target_set', label: 'Objective target set', internal: false, subject: { kind: 'goal', id: G3, title: 'Improve Box Touch 60 from 140 to 160+' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d4', at: now - 14 * day, action: 'goal_created', label: 'Goal created', internal: false, subject: { kind: 'goal', id: G2, title: 'Improve scanning before receiving possession' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d3', at: now - 14 * day, action: 'goal_created', label: 'Goal created', internal: false, subject: { kind: 'goal', id: G1, title: 'Improve weak-foot passing consistency' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d2', at: now - 14 * day, action: 'plan_activated', label: 'Plan activated', internal: false, subject: { kind: 'plan', id: 'devplan-d1', title: 'Pre-season Development Plan' }, byKind: 'org', byName: 'A. Coach' },
  { id: 'aud-d1', at: now - 14 * day, action: 'plan_created', label: 'Plan created', internal: false, subject: { kind: 'plan', id: 'devplan-d1', title: 'Pre-season Development Plan' }, byKind: 'org', byName: 'A. Coach' },
];

const state = { visibility: 'org_private' as DevelopmentPlanView['plan']['visibility'], status: 'active' as DevelopmentPlanView['plan']['status'], rev: 4 };

function view(playerId = 'pl-mbuguni'): DevelopmentPlanView {
  const byStatus: Record<string, number> = { not_started: 0, in_progress: 0, blocked: 0, achieved: 0, stopped: 0 };
  let due = 0; let overdue = 0; let evidence = 0;
  for (const g of goals) {
    byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
    for (const a of g.actions) {
      if (a.status === 'done' || a.status === 'cancelled') continue;
      if (a.due.state === 'overdue') overdue += 1;
      else if (a.due.state === 'due_today' || a.due.state === 'due_soon') due += 1;
    }
    evidence += g.evidenceSummary.available;
  }
  return {
    policyVersion: 1, principle: PRINCIPLE, limitation: PLAN_LIMITATION,
    plan: {
      id: 'devplan-d1', playerId, playerName: 'Alonso Mbuguni', title: 'Pre-season Development Plan',
      status: state.status, visibility: state.visibility,
      owner: { kind: 'org', orgId: 'org-eastport', orgName: 'Eastport United FC' },
      createdBy: { kind: 'org', name: 'A. Coach' },
      startDate: now - 14 * day, nextReviewAt: now + 9 * day, endDate: null,
      reviewDue: { state: 'review_upcoming', days: 9 },
      sharedWithOrgIds: [], sharedWithOrgCount: 0,
      rev: state.rev, revBy: 'A. Coach', revAt: now - 3 * day, updatedAt: now - 3 * day,
    },
    summary: {
      goalsByStatus: byStatus as DevelopmentPlanView['summary']['goalsByStatus'],
      activeGoals: byStatus.in_progress + byStatus.not_started + byStatus.blocked,
      actionsDue: due, actionsOverdue: overdue, linkedEvidenceAvailable: evidence,
      lastReviewAt: reviews[0].reviewedAt, nextReviewAt: now + 9 * day,
      reviewDue: { state: 'review_upcoming', days: 9 },
      note: 'These are counts of agreed work. There is no overall figure here, and ScoutBox does not calculate one.',
    },
    goals,
    reviews,
    timeline,
    access: { read: true, readInternal: true, writeGoals: true, manage: true, review: true, reflect: false, linkEvidence: true },
    neverBuilt: {
      note: catalogue.neverBuilt.note,
      names: catalogue.neverBuilt.names,
      reason: 'A single figure would invite a decision about a person that the figure cannot support. Development here is objective-specific, or it is nothing.',
    },
  };
}

const listItem = (playerId: string): PlanListItem => {
  const v = view(playerId);
  return {
    id: v.plan.id, playerId, playerName: v.plan.playerName, title: v.plan.title,
    status: v.plan.status, visibility: v.plan.visibility,
    owner: { kind: 'org', orgId: 'org-eastport' },
    goalsByStatus: v.summary.goalsByStatus, activeGoals: v.summary.activeGoals,
    actionsOverdue: v.summary.actionsOverdue, nextReviewAt: v.plan.nextReviewAt,
    reviewDue: v.plan.reviewDue, updatedAt: v.plan.updatedAt, rev: v.plan.rev,
  };
};

const okv = (playerId?: string): Result<DevelopmentPlanView> => ({ ok: true, value: view(playerId) });

export const demoM21: M21Api = {
  catalogue: async () => catalogue,
  plans: async (_s, playerId) => ({
    items: [listItem(playerId ?? 'pl-mbuguni')], total: 1,
    note: 'Plans you can see. ScoutBox does not report how many other plans exist.',
  }),
  plan: async () => view(),
  createPlan: async (_s, body) => {
    const gs = (body.goals as { title?: string; category?: string }[] | undefined) ?? [];
    for (const g of gs) if (g.title) goals.push(mkGoal({ id: nid('devgoal'), title: g.title, category: (g.category ?? 'other') as GoalCategory, status: 'not_started', actions: [] }));
    state.rev += 1;
    return okv();
  },
  addGoal: async (_s, _planId, body) => {
    goals.push(mkGoal({ id: nid('devgoal'), title: String(body.title ?? 'New goal'), category: String(body.category ?? 'technical') as GoalCategory, status: 'not_started', actions: [] }));
    state.rev += 1;
    return okv();
  },
  updateGoal: async (_s, goalId, body) => {
    const g = goals.find((x) => x.id === goalId);
    if (!g) return okv();
    if (typeof body.title === 'string') g.title = body.title;
    if (typeof body.status === 'string') {
      // The server's refusal, mirrored: a goal nobody started cannot have been
      // achieved through this plan.
      if (g.status === 'not_started' && body.status === 'achieved') {
        return { ok: false, error: 'GOAL_TRANSITION_INVALID', detail: 'A goal nobody started cannot have been achieved through this plan. Move it to in progress first.' };
      }
      g.status = body.status as GoalView['status'];
      g.statusMeaning = g.status === 'achieved' ? ACHIEVED_MEANING : null;
    }
    g.rev += 1;
    return okv();
  },
  addAction: async (_s, goalId, body) => {
    const g = goals.find((x) => x.id === goalId);
    if (g) {
      g.actions.push(mkAction(goalId, String(body.title ?? 'New action'), String(body.type ?? 'training'), 'todo', null));
      g.actionCounts = counts(g.actions);
      g.completion = completion(g.actionCounts);
    }
    return okv();
  },
  updateAction: async (_s, actionId, body) => {
    for (const g of goals) {
      const a = g.actions.find((x) => x.id === actionId);
      if (!a) continue;
      if (typeof body.status === 'string') {
        a.status = body.status as ActionView['status'];
        a.completedAt = a.status === 'done' ? now : null;
        a.due = a.status === 'done' || a.status === 'cancelled' ? { state: 'not_applicable', days: null } : dueState(a.dueAt);
      }
      // The goal stays where it was. Completing an action completes an action.
      g.actionCounts = counts(g.actions);
      g.completion = completion(g.actionCounts);
    }
    return okv();
  },
  linkEvidence: async () => okv(),
  unlinkEvidence: async () => view(),
  setStatus: async (_s, _planId, status) => { state.status = status; state.rev += 1; return okv(); },
  setVisibility: async (_s, _planId, visibility) => { state.visibility = visibility; state.rev += 1; return okv(); },
  submitReview: async (_s, _planId, body) => {
    const share = body.shareWithPlayer === true;
    reviews.unshift({
      id: nid('devrev'), reviewerKind: 'coach_review', reviewedByName: 'A. Coach', reviewedAt: Date.now(),
      summary: body.summary ? String(body.summary) : null,
      internalNote: body.internalNote ? String(body.internalNote) : null,
      hasInternalNote: !!body.internalNote,
      nextReviewAt: null, supersedes: body.supersedes ? String(body.supersedes) : null, supersededBy: null,
      goalSnapshots: goals.map((g) => ({ goalId: g.id, title: g.title, status: g.status, completion: { phrase: g.completion.phrase } })),
    });
    if (body.supersedes) {
      const target = reviews.find((r) => r.id === String(body.supersedes));
      if (target) target.supersededBy = reviews[0].id;
    }
    void share;
    state.rev += 1;
    return okv();
  },
  shareReview: async () => okv(),
  history: async () => ({
    items: timeline, total: timeline.length,
    note: 'Meaningful development events only. Reads and saves that changed nothing are not recorded.',
  }),
};
