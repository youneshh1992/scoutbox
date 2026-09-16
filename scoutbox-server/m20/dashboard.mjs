/**
 * M20 — the reporting context and the dashboard assembly.
 *
 * Two things happen here and nothing else.
 *
 * **One pass, then many metrics.** ScoutBox's store is a snapshot store: the
 * working set is in memory and there is no query planner to lean on. Twenty
 * metrics computed independently would be twenty linear scans of every
 * recruitment collection. So each collection is filtered to this organisation
 * exactly once, projected to the few fields the metrics declared, indexed, and
 * then every family reads from that. `m20Perf.mjs` measures the result at
 * 100/500/1000 rooms and the figure is published whatever it is.
 *
 * **Each family fails alone.** A dashboard that drops a panel when one
 * projection throws is lying about coverage — the director reads five panels
 * and believes they are looking at the whole picture. Every family is computed
 * inside its own boundary; a family that throws yields an error in its own
 * slot and the rest of the page renders, with the failure named on screen.
 *
 * The context carries no note, no comment, no assessment text and no actor
 * identity. `subjectOf` is the only place a player's name can enter a payload,
 * and it asks `orgCanSee` first, every time.
 */
import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION, METRIC_FAMILIES, FAMILY_IDS, SMALL_N_MIN,
  TIME_SEMANTICS, GROUP_DIMENSIONS, utcDay, resolveWindow, previousWindow, compare, inWindow, DAY_MS,
} from './metrics.mjs';
import {
  pipelineStageCounts, funnelProgression, exitReasonMix, roomSourceMix, sourceStageReach,
  transitions, firstTerminalAt, trialProcess, decisionOutcomes,
} from './funnels.mjs';
import {
  timeToFirstDecision, timeInStage, timeToTrialRequested, timeTrialRequestedToCompleted,
  openRoomAge, stalledRooms, overdueTrialReports, decisionOutstanding, DEFAULT_STALL_DAYS,
} from './timeSeries.mjs';
import {
  terminalWithRecordedDecision, supersededDecisionRate, evidenceLimitedExits, reopenRate,
  briefsLive, nobodyMissedCoverage, secondLookCoverage, watchlistActivity,
} from './cohorts.mjs';
import { SOURCE_CONTEXTS, ROOM_PRIORITIES } from '../m17/shared.mjs';

export { ROOM_PRIORITIES };

// ------------------------------------------------------------ the context

/**
 * Project one Room to the fields the metric registry declared, and no others.
 *
 * `history` is kept because every duration in M20 is derived from it, but the
 * projection strips `byId` and `byName` off every entry: the analytics layer
 * must not be able to attribute a status change to a person even by accident,
 * because that is the raw material of a leaderboard.
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
      detail: h.detail ? { from: h.detail.from, to: h.detail.to, status: h.detail.status, sourceContext: h.detail.sourceContext } : null,
    })),
  };
  room.transitions = transitions(room);
  return room;
}

/** The decision fields analytics may read. `note` and `by` are not among them. */
const projectDecision = (d) => ({
  id: d.id, roomId: d.roomId, createdAt: d.createdAt,
  recommendation: d.recommendation,
  reasonCodes: Array.isArray(d.reasonCodes) ? d.reasonCodes : [],
  supersededById: d.supersededById ?? null,
  trigger: d.trigger ?? null,
});

export function buildReportingContext({
  db, org, window: w, now = Date.now(), orgCanSee, findPlayer, filters = {},
}) {
  const orgId = org.id;

  // ---- one pass per collection --------------------------------------------
  let rooms = [];
  for (const c of db.recruitmentCases ?? []) {
    if (c.orgId !== orgId || !c.room) continue;
    rooms.push(projectRoom(c));
  }
  const roomIds = new Set(rooms.map((r) => r.id));

  const decisions = [];
  for (const d of db.roomDecisions ?? []) {
    if (d.orgId !== orgId) continue;
    decisions.push(projectDecision(d));
  }
  decisions.sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));

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

  let briefs = (db.recruitmentBriefs ?? []).filter((b) => b.orgId === orgId);
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
      seen.set(room.playerId, p && orgCanSee?.(org, p)
        ? { playerId: p.id, playerName: p.name }
        : { playerId: null, playerName: null });
    }
    return seen.get(room.playerId);
  };

  // ---- the typical journey, used only as a caution on young cohorts -------
  const terminalDurations = rooms
    .map((r) => { const at = firstTerminalAt(r); return at == null ? null : (at - r.createdAt) / DAY_MS; })
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const typicalDaysToTerminal = terminalDurations.length >= SMALL_N_MIN
    ? terminalDurations[Math.floor(terminalDurations.length / 2)]
    : null;

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
    nmReviews: (db.nobodyMissedReviews ?? []).filter((r) => r.orgId === orgId && briefIds.has(r.briefId)),
    // A room filter narrows Second Look too — an item is about a room, and
    // showing whole-club Second Look figures under a "source: matching" label
    // would answer a question the director did not ask.
    secondLook: (db.secondLookItems ?? []).filter((i) => i.orgId === orgId
      && (!roomFiltered || (i.roomId ? keptRoomIds.has(i.roomId) : false))),
    watchlists: (db.dynamicWatchlists ?? []).filter((w2) => w2.orgId === orgId),
    watchlistHistory: (db.watchlistHistory ?? []).filter((h) => h.orgId === orgId),
    trials: (db.trials ?? []).filter((t) => t && t.orgId === orgId),
    // M23 P4B: trial invitations (requests of type trial tied to a case) for
    // the process counts. Ids, states and times only reach the projection.
    requests: (db.requests ?? []).filter((r) => r && r.orgId === orgId && r.type === 'trial'),
    typicalDaysToTerminal,
    subjectOf,
  };
}

// ------------------------------------------------------------- the families

/**
 * Which filters each family can honestly honour. A filter that cannot apply is
 * NOT silently ignored: the family reports that it was not applied, so a
 * director who filtered to one brief is never shown a whole-club number under
 * that filter's label.
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
 * Period-over-period, on the three headline PERIOD-ACTIVITY counts.
 *
 * Deliberately only those three, and deliberately only counts. A trend on a
 * point-in-time figure ("active rooms, up 12%") is meaningless — the window
 * does not apply to it — and a trend on a rate compounds two small samples
 * into one confident-looking number.
 *
 * The previous window is the same LENGTH, immediately before: comparing seven
 * days against thirty would make every figure look like a collapse.
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

/**
 * Build the dashboard. Every family is computed inside its own boundary: one
 * family throwing leaves the others intact and produces a named failure rather
 * than a silently shorter page.
 *
 * `fault` is the M18.2 fault-injection hook, so the partial-failure path is
 * exercised by a test rather than asserted in prose.
 */
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
        // The message, not the stack: an operator needs the reason, a
        // recruitment director must not be shown a trace.
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
    // Read-time projection: this figure was true when the request was served
    // and is not refreshed behind the reader. The client renders it as
    // "calculated at ..." rather than implying a live stream.
    calculatedAt: ctx.now,
    liveStream: false,
    trend: buildTrend(ctx),
    timeSemantics: TIME_SEMANTICS,
    groupDimensions: GROUP_DIMENSIONS,
    families: wanted,
    partial: failed.length > 0,
    unavailable: failed,
    // The sentence the whole milestone is built around. It is on the wire, not
    // only in the client, so an integrator cannot strip it by accident.
    note: 'These figures measure your recruitment process — how work moves, how long it takes and what is waiting. They do not measure any player’s ability or potential, and they do not measure any colleague’s performance.',
    data: out,
  };
}

export { resolveWindow, SOURCE_CONTEXTS };
