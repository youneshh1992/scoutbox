/**
 * Recruitment analytics: the reporting context and the dashboard.
 *
 * Each collection is read once per organisation, projected to the fields the metrics declared, and shared by
 * every family. Each family is computed inside its own boundary, so one that throws shows a named failure in
 * its slot instead of a silently shorter page. `subjectOf` is the only place a player's name can enter a
 * payload, and it asks `orgCanSee` every time.
 */
import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION,
  METRIC_FAMILIES,
  FAMILY_IDS,
  SMALL_N_MIN,
  TIME_SEMANTICS,
  GROUP_DIMENSIONS,
  utcDay,
  resolveWindow,
  previousWindow,
  compare,
  inWindow,
  DAY_MS,
} from './metrics.mjs';
import {
  pipelineStageCounts,
  funnelProgression,
  exitReasonMix,
  roomSourceMix,
  sourceStageReach,
  transitions,
  firstTerminalAt,
  trialProcess,
  decisionOutcomes,
  journeyEvidenceFunnel,
} from './funnels.mjs';
import {
  timeToFirstDecision,
  timeInStage,
  timeToTrialRequested,
  timeTrialRequestedToCompleted,
  openRoomAge,
  stalledRooms,
  overdueTrialReports,
  decisionOutstanding,
  DEFAULT_STALL_DAYS,
} from './timeSeries.mjs';
import {
  terminalWithRecordedDecision,
  supersededDecisionRate,
  evidenceLimitedExits,
  reopenRate,
  briefsLive,
  nobodyMissedCoverage,
  secondLookCoverage,
  watchlistActivity,
} from './cohorts.mjs';
import { SOURCE_CONTEXTS, ROOM_PRIORITIES } from '../rooms/shared.mjs';

export { ROOM_PRIORITIES };

// ------------------------------------------------------------ the context

/**
 * `history` entries lose `byId` and `byName`, so analytics cannot attribute a status change to a person even
 * by accident: that is the raw material of a leaderboard.
 */
function projectRoom(c) {
  const room = {
    id: c.id,
    playerId: c.playerId,
    createdAt: c.createdAt,
    status: c.room?.status ?? null,
    priority: c.room?.priority ?? null,
    sourceContext: c.room?.sourceContext ?? 'direct',
    history: (c.history ?? []).map((h) => ({
      at: h.at,
      action: h.action,
      detail: h.detail
        ? { from: h.detail.from, to: h.detail.to, status: h.detail.status, sourceContext: h.detail.sourceContext }
        : null,
    })),
  };
  room.transitions = transitions(room);
  return room;
}

/** Never `note` or `by`. */
const formalFields = (d) => ({
  kind: d.kind === 'formal' ? 'formal' : 'recommendation',
  state: d.state === 'draft' ? 'draft' : 'final',
  outcome: d.kind === 'formal' ? (d.outcome ?? null) : null,
});
const projectDecision = (d) => ({
  id: d.id,
  roomId: d.roomId,
  createdAt: d.createdAt,
  recommendation: d.recommendation,
  reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes : [],
  supersededById: d.supersededById ?? null,
  trigger: d.trigger ?? null,
  ...formalFields(d),
});

export function buildReportingContext({
  reads = {},
  org,
  window: w,
  now = Date.now(),
  orgCanSee,
  findPlayer,
  filters = {},
}) {
  const orgId = org.id;

  // ---- one pass per collection --------------------------------------------
  let rooms = [];
  for (const c of reads.cases?.forOrg(orgId) ?? []) {
    if (c.orgId !== orgId || !c.room) continue;
    rooms.push(projectRoom(c));
  }
  const roomIds = new Set(rooms.map((r) => r.id));

  const decisions = [];
  for (const d of reads.decisions?.forOrg(orgId) ?? []) {
    if (d.orgId !== orgId) continue;
    decisions.push(projectDecision(d));
  }
  decisions.sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));

  // ---- filters, applied before any metric sees a room ---------------------
  const applied = [];
  if (filters.sourceContext) {
    rooms = rooms.filter((r) => r.sourceContext === filters.sourceContext);
    applied.push({ filter: 'sourceContext', value: filters.sourceContext });
  }
  if (filters.priority) {
    rooms = rooms.filter((r) => r.priority === filters.priority);
    applied.push({ filter: 'priority', value: filters.priority });
  }
  const roomFiltered = applied.length > 0;
  const keptRoomIds = new Set(rooms.map((r) => r.id));

  const decisionsByRoom = new Map();
  for (const d of decisions) {
    if (!keptRoomIds.has(d.roomId)) continue;
    if (!decisionsByRoom.has(d.roomId)) decisionsByRoom.set(d.roomId, []);
    decisionsByRoom.get(d.roomId).push(d);
  }

  // A context built without `reads.discovery` (a unit fixture) has no briefs, reviews or watchlists.
  const discovery = reads.discovery ?? null;
  let briefs = [...(discovery?.briefs.forOrg(orgId) ?? [])];
  if (filters.briefId) {
    briefs = briefs.filter((b) => b.id === filters.briefId);
    applied.push({ filter: 'briefId', value: filters.briefId });
  }
  const briefIds = new Set(briefs.map((b) => b.id));

  // ---- the only place a player may be named -------------------------------
  const seen = new Map();
  const subjectOf = (room) => {
    if (!seen.has(room.playerId)) {
      const p = findPlayer?.(room.playerId);
      seen.set(
        room.playerId,
        p && orgCanSee?.(org, p) ? { playerId: p.id, playerName: p.name } : { playerId: null, playerName: null },
      );
    }
    return seen.get(room.playerId);
  };

  // ---- the typical journey, used only as a caution on young cohorts -------
  const terminalDurations = rooms
    .map((r) => {
      const at = firstTerminalAt(r);
      return at == null ? null : (at - r.createdAt) / DAY_MS;
    })
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const typicalDaysToTerminal =
    terminalDurations.length >= SMALL_N_MIN ? terminalDurations[Math.floor(terminalDurations.length / 2)] : null;

  return {
    org,
    now,
    today: utcDay(now),
    window: w,
    filters: applied,
    rooms,
    roomIds,
    decisions: decisions.filter((d) => keptRoomIds.has(d.roomId)),
    decisionsByRoom,
    briefs,
    nmReviews: (discovery?.reviews.forOrg(orgId) ?? []).filter((r) => briefIds.has(r.briefId)),
    // A room filter narrows Second Look too, or whole-club figures would sit under a "source: matching" label.
    secondLook: (discovery?.secondLook.forOrg(orgId) ?? []).filter((i) => !roomFiltered || keptRoomIds.has(i.roomId)),
    watchlists: discovery?.watchlists.forOrg(orgId) ?? [],
    watchlistHistory: discovery?.events.forOrg(orgId) ?? [],
    trials: reads.trials?.forOrg(orgId) ?? [],
    contacts: (reads.contacts?.forOrg(orgId) ?? []).filter((c) => keptRoomIds.has(c.caseId)),
    assessments: reads.assessments?.forOrg(orgId) ?? [],
    offers: (reads.offers?.forOrg(orgId) ?? []).filter((o) => keptRoomIds.has(o.caseId)),
    packages: (reads.signingPackages?.forOrg(orgId) ?? []).filter((p) => keptRoomIds.has(p.caseId)),
    signings: reads.signings?.forOrg(orgId) ?? [],
    requests: (reads.requests?.forOrg(orgId) ?? []).filter((r) => r.type === 'trial'),
    typicalDaysToTerminal,
    subjectOf,
  };
}

// ------------------------------------------------------------- the families

/**
 * Which filters each family can honour. One that cannot apply is reported as not applied, so a director who
 * filtered to one brief never sees a whole-club number under that label.
 */
const FAMILY_FILTERS = {
  pipeline: ['sourceContext', 'priority'],
  duration: ['sourceContext', 'priority'],
  aging: ['sourceContext', 'priority'],
  decision_record: ['sourceContext', 'priority'],
  coverage: ['briefId'],
  source: ['priority'],
  watchlist: [],
};

const FAMILY_BUILDERS = {
  pipeline: (ctx) => ({
    pipeline_stage_counts: pipelineStageCounts(ctx),
    funnel_progression: funnelProgression(ctx),
    exit_reason_mix: exitReasonMix(ctx),
    trial_process: trialProcess(ctx),
    decision_outcomes: decisionOutcomes(ctx),
    journey_evidence_funnel: journeyEvidenceFunnel(ctx),
  }),
  duration: (ctx) => ({
    time_to_first_decision: timeToFirstDecision(ctx),
    time_in_stage: timeInStage(ctx),
    time_to_trial_requested: timeToTrialRequested(ctx),
    time_trial_requested_to_completed: timeTrialRequestedToCompleted(ctx),
    open_room_age: openRoomAge(ctx),
  }),
  aging: (ctx, opts) => ({
    stalled_rooms: stalledRooms(ctx, { thresholdDays: opts.stallDays }),
    overdue_trial_reports: overdueTrialReports(ctx),
    decision_outstanding: decisionOutstanding(ctx),
  }),
  decision_record: (ctx) => ({
    terminal_with_recorded_decision: terminalWithRecordedDecision(ctx),
    superseded_decision_rate: supersededDecisionRate(ctx),
    evidence_limited_exits: evidenceLimitedExits(ctx),
    reopen_rate: reopenRate(ctx),
  }),
  coverage: (ctx) => {
    const nm = nobodyMissedCoverage(ctx);
    const sl = secondLookCoverage(ctx);
    return {
      briefs_live: briefsLive(ctx),
      nobody_missed_backlog: nm.backlog,
      nobody_missed_review_rate: nm.reviewRate,
      second_look_backlog: sl.backlog,
      second_look_response_time: sl.responseTime,
    };
  },
  source: (ctx) => ({
    room_source_mix: roomSourceMix(ctx),
    source_stage_reach: sourceStageReach(ctx),
  }),
  watchlist: (ctx) => {
    const w = watchlistActivity(ctx);
    return { active_watchlists: w.active, watchlist_membership_churn: w.churn };
  },
};

/**
 * Period-over-period on three period-activity counts only. A trend on a point-in-time figure is meaningless
 * (the window does not apply), and one on a rate compounds two small samples.
 */
function buildTrend(ctx) {
  const prev = previousWindow(ctx.window);
  const inPrev = (at) => inWindow(at, prev);
  const inNow = (at) => inWindow(at, ctx.window);

  const opened = { now: 0, then: 0 };
  const ended = { now: 0, then: 0 };
  for (const r of ctx.rooms) {
    if (inNow(r.createdAt)) opened.now += 1;
    else if (inPrev(r.createdAt)) opened.then += 1;
    const at = firstTerminalAt(r);
    if (at == null) continue;
    if (inNow(at)) ended.now += 1;
    else if (inPrev(at)) ended.then += 1;
  }
  const decided = { now: 0, then: 0 };
  for (const d of ctx.decisions) {
    if (inNow(d.createdAt)) decided.now += 1;
    else if (inPrev(d.createdAt)) decided.then += 1;
  }

  return {
    previousWindow: prev,
    note: 'Compared with the previous period of the same length. Only period activity is compared — a trend on a current-state figure would be meaningless, because the period does not apply to it.',
    rooms_opened: compare(opened.now, opened.then),
    rooms_ended: compare(ended.now, ended.then),
    decisions_recorded: compare(decided.now, decided.then),
  };
}

/** `fault` is the fault-injection hook, so the partial-failure path is exercised by a test. */
export function buildDashboard(ctx, { families = FAMILY_IDS, stallDays = DEFAULT_STALL_DAYS, fault = null } = {}) {
  const wanted = families.filter((f) => FAMILY_IDS.includes(f));
  const out = {};
  const failed = [];
  for (const family of wanted) {
    try {
      if (fault === family) throw new Error(`injected fault in family "${family}"`);
      out[family] = {
        family,
        label: METRIC_FAMILIES.find((f) => f.id === family)?.label ?? family,
        filtersHonoured: FAMILY_FILTERS[family] ?? [],
        filtersNotApplicable: ctx.filters
          .filter((f) => !(FAMILY_FILTERS[family] ?? []).includes(f.filter))
          .map((f) => f.filter),
        metrics: FAMILY_BUILDERS[family](ctx, { stallDays }),
      };
    } catch (err) {
      failed.push(family);
      out[family] = {
        family,
        label: METRIC_FAMILIES.find((f) => f.id === family)?.label ?? family,
        error: 'FAMILY_UNAVAILABLE',
        // The message, not the stack.
        detail: String(err?.message ?? err).slice(0, 200),
      };
    }
  }
  return {
    policyVersion: RECRUITMENT_ANALYTICS_POLICY_VERSION,
    generatedAt: ctx.now,
    window: ctx.window,
    filters: ctx.filters,
    smallNMinimum: SMALL_N_MIN,
    // Computed when the request was served, not refreshed; the client says "calculated at …".
    calculatedAt: ctx.now,
    liveStream: false,
    trend: buildTrend(ctx),
    timeSemantics: TIME_SEMANTICS,
    groupDimensions: GROUP_DIMENSIONS,
    families: wanted,
    partial: failed.length > 0,
    unavailable: failed,
    // On the wire, not only in the client, so an integrator cannot drop it by accident.
    note: 'These figures measure your recruitment process — how work moves, how long it takes and what is waiting. They do not measure any player’s ability or potential, and they do not measure any colleague’s performance.',
    data: out,
  };
}

export { resolveWindow, SOURCE_CONTEXTS };
