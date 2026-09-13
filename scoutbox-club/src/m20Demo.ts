// M20 demo mirror — the Director Dashboard with no server.
//
// The demo's dataset is deliberately small: nine rooms, one club, one quarter.
// That means several of its rates fall below the small-n threshold and are
// withheld — and that is the point of the demonstration, not a shortcoming of
// it. A demo that quietly showed "33%" over three records would teach exactly
// the habit this milestone was built to prevent.
//
// Every limitation sentence below is the server's, word for word. The
// acceptance suite reads both and fails if they drift apart: a caveat that
// says something different in the demo is worse than no caveat.
import type {
  M20Api, Dashboard, Catalogue, Comparison, Drilldown, Metric, Family, FamilyId, Figure,
  Distribution, DashboardFilters, DashboardOutcome,
} from './m20Api';

const DAY = 86_400_000;
const NOW = Date.now();
const SMALL_N_MIN = 5;

const ratio = (numerator: number, denominator: number): Figure => {
  if (denominator === 0) return { n: 0, numerator: 0, value: null, empty: true, suppressed: false };
  if (denominator < SMALL_N_MIN) return { n: denominator, numerator, value: null, empty: false, suppressed: true, minimum: SMALL_N_MIN };
  return { n: denominator, numerator, value: numerator / denominator, empty: false, suppressed: false };
};
const count = (n: number): Figure => ({ n, value: n, empty: false, suppressed: false });
const dist = (values: number[], excluded = 0): Distribution => {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, p25: null, p75: null, empty: true, suppressed: false, excluded };
  if (v.length < SMALL_N_MIN) return { n: v.length, median: null, p25: null, p75: null, empty: false, suppressed: true, minimum: SMALL_N_MIN, excluded };
  const q = (p: number) => {
    const pos = (v.length - 1) * p;
    const lo = Math.floor(pos); const hi = Math.ceil(pos);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  return { n: v.length, median: q(0.5), p25: q(0.25), p75: q(0.75), min: v[0], max: v[v.length - 1], empty: false, suppressed: false, excluded };
};

/** The same zero rule the server applies: a rise from nothing has no percentage. */
const compare = (current: number, previous: number): Comparison => ({
  current, previous,
  change: current - previous,
  percentChange: previous === 0 ? null : (current - previous) / previous,
  upFromZero: previous === 0 && current > 0,
  unchangedAtZero: previous === 0 && current === 0,
});

/** Metric metadata, mirroring the server registry entry for entry. */
const meta = (
  id: string, family: FamilyId, name: string, unit: string,
  semantics: 'point_in_time' | 'window_entry' | 'window_completion', sources: string[], limitation: string,
  extra: Record<string, unknown> = {},
) => ({ id, family, name, unit, semantics, sources, limitation, ...extra });

const M = {
  pipeline_stage_counts: meta('pipeline_stage_counts', 'pipeline', 'Rooms by status', 'rooms', 'point_in_time', ['recruitmentCases'],
    'A status is where a room is, not how far it has travelled. A room that has sat in Watching for a year looks identical here to one opened this morning.'),
  funnel_progression: meta('funnel_progression', 'pipeline', 'Stages reached', 'rooms', 'window_entry', ['recruitmentCases'],
    'Rooms can be reopened, so this is not a one-way funnel: a room counts once for each stage it ever reached, not once per visit. A recent window is incomplete by construction — rooms opened last week have not had time to reach a signing.', { ratio: true }),
  exit_reason_mix: meta('exit_reason_mix', 'pipeline', 'Why rooms ended', 'decisions', 'window_completion', ['roomDecisions', 'recruitmentCases'],
    'This is the reason the club recorded, not the reason that operated. A decision carrying codes in two categories counts in both, so the shares add up to more than 100%.', { ratio: true }),
  time_to_first_decision: meta('time_to_first_decision', 'duration', 'Time to first decision', 'days', 'window_completion', ['recruitmentCases', 'roomDecisions'],
    'Rooms that never reached a decision are excluded, so this measures the rooms that got there. The number excluded is shown beside it.', { distribution: true }),
  time_in_stage: meta('time_in_stage', 'duration', 'Time spent in each stage', 'days', 'window_completion', ['recruitmentCases'],
    'Only completed visits count. A stage where everything is stuck therefore looks fast, because only the rooms that escaped it are measured — Stalled rooms is the figure that catches that.', { distribution: true }),
  time_to_trial_requested: meta('time_to_trial_requested', 'duration', 'Time from opening to trial requested', 'days', 'window_completion', ['recruitmentCases'],
    'A club that opens rooms late in its own process looks fast here. This measures the ScoutBox record, not the club’s thinking.', { distribution: true }),
  time_trial_requested_to_completed: meta('time_trial_requested_to_completed', 'duration', 'Trial requested to completed', 'days', 'window_completion', ['recruitmentCases'],
    'Guardian response, pitch availability and school holidays all live inside this number and cannot be separated from it.', { distribution: true }),
  open_room_age: meta('open_room_age', 'duration', 'Age of open rooms', 'days', 'point_in_time', ['recruitmentCases'],
    'Age is not neglect. A long-running room on a fourteen-year-old being tracked to sixteen is the product working as intended.', { distribution: true }),
  stalled_rooms: meta('stalled_rooms', 'aging', 'Rooms with no recent activity', 'rooms', 'point_in_time', ['recruitmentCases'],
    'No activity in ScoutBox is not no activity. A scout who watched a player on Saturday and did not write it down produces a stalled room. This is a prompt to look, not a finding.'),
  overdue_trial_reports: meta('overdue_trial_reports', 'aging', 'Trial reports past due', 'trials', 'point_in_time', ['trials'],
    'This surfaces an obligation the server already enforces — unfiled reports block new trial requests. It adds no new judgement.'),
  decision_outstanding: meta('decision_outstanding', 'aging', 'Offers with no recorded decision', 'rooms', 'point_in_time', ['recruitmentCases', 'roomDecisions'],
    'This reuses the Recruitment Room’s own readiness rule. If that rule is wrong, this is wrong in exactly the same way — deliberately, so there is one definition rather than two.'),
  terminal_with_recorded_decision: meta('terminal_with_recorded_decision', 'decision_record', 'Endings with a recorded decision', 'rooms', 'window_completion', ['recruitmentCases', 'roomDecisions'],
    'Ending a room for a reason-required status records a decision automatically, so this rate is high by construction. Its value is in the exceptions.', { ratio: true }),
  superseded_decision_rate: meta('superseded_decision_rate', 'decision_record', 'Decisions later revised', 'decisions', 'window_entry', ['roomDecisions'],
    'Revising a decision is healthy. A high figure here is not a fault and is never coloured as one.', { ratio: true }),
  evidence_limited_exits: meta('evidence_limited_exits', 'decision_record', 'Endings limited by evidence', 'decisions', 'window_completion', ['roomDecisions'],
    'Association only. It does not follow that collecting the missing evidence would have changed any of these decisions.', { ratio: true }),
  reopen_rate: meta('reopen_rate', 'decision_record', 'Rooms reopened after ending', 'rooms', 'window_entry', ['recruitmentCases'],
    'Reopening is intended behaviour — Second Look exists to cause it. High is not bad.', { ratio: true }),
  briefs_live: meta('briefs_live', 'coverage', 'Live recruitment briefs', 'briefs', 'point_in_time', ['recruitmentBriefs'],
    'A brief being live says nothing about whether anyone is working it.'),
  nobody_missed_backlog: meta('nobody_missed_backlog', 'coverage', 'Unreviewed eligible players', 'reviews', 'point_in_time', ['nobodyMissedReviews', 'recruitmentBriefs'],
    'The backlog is a function of how wide the brief is. Widening a brief creates backlog without anyone having done anything wrong.'),
  nobody_missed_review_rate: meta('nobody_missed_review_rate', 'coverage', 'Eligible players reviewed', 'reviews', 'point_in_time', ['nobodyMissedReviews', 'recruitmentBriefs'],
    'Dismissing a candidate counts as reviewing them. This measures that the club looked, not what it concluded.', { ratio: true }),
  second_look_backlog: meta('second_look_backlog', 'coverage', 'Open Second Look items', 'items', 'point_in_time', ['secondLookItems'],
    'An expired item is not backlog — expiry is a designed outcome and is counted separately.'),
  second_look_response_time: meta('second_look_response_time', 'coverage', 'Time to respond to Second Look', 'days', 'window_completion', ['secondLookItems'],
    'Items never touched are absent from this figure. Their count is shown beside it.', { distribution: true }),
  room_source_mix: meta('room_source_mix', 'source', 'Where rooms came from', 'rooms', 'window_entry', ['recruitmentCases'],
    'Direct is the fallback ScoutBox assigns to anything it does not recognise, so it is a residual bucket rather than a surface people used.', { ratio: true }),
  source_stage_reach: meta('source_stage_reach', 'source', 'Stages reached, by source', 'rooms', 'window_entry', ['recruitmentCases'],
    'Confounded by construction, and never a ranking of surfaces: sources are listed alphabetically. Most will be withheld for too few rooms, which is the correct outcome rather than a gap.', { ratio: true, association: true }),
  active_watchlists: meta('active_watchlists', 'watchlist', 'Active dynamic watchlists', 'watchlists', 'point_in_time', ['dynamicWatchlists'],
    'A big list is a wide set of criteria, nothing more.'),
  watchlist_membership_churn: meta('watchlist_membership_churn', 'watchlist', 'Players entering and leaving lists', 'changes', 'window_entry', ['watchlistHistory'],
    'ScoutBox does not recompute watchlists in the background: membership is worked out when someone opens a list. This counts those recalculations, not the moment a player’s facts changed — a list nobody opens records no change at all.'),
} as const;

const ASSOCIATION_NOTE =
  'ScoutBox observes that these records share this property and later reached this stage. It does not show that the property caused it: people choose where to look, and the players they find differ in ways ScoutBox does not measure.';

const TIME_SEMANTICS = {
  point_in_time: 'The state of the world now. The window does not apply.',
  window_entry: 'Counted in the window the entry event happened in (a room opened, a decision written).',
  window_completion: 'Counted in the window the completing event happened in (a room reached a terminal status, a trial finished).',
};

const FAMILY_LABELS: Record<FamilyId, string> = {
  pipeline: 'Pipeline shape',
  duration: 'How long the process takes',
  aging: 'Work that has stopped moving',
  decision_record: 'Decision record hygiene',
  coverage: 'Coverage of your stated demand',
  source: 'Where work comes from',
  watchlist: 'Dynamic watchlists',
};

const ROOM_STATUSES = [
  'watching', 'under_review', 'shortlisted', 'priority', 'trial_requested', 'trial_scheduled',
  'trial_completed', 'offer_consideration', 'offer_made', 'signed', 'withdrawn', 'archived', 'closed',
];
const TERMINAL = ['signed', 'withdrawn', 'archived', 'closed'];
const FUNNEL_STAGES = ROOM_STATUSES.filter((s) => !['withdrawn', 'archived', 'closed'].includes(s));
const REASON_CATEGORIES = ['football', 'evidence', 'process', 'outcome'];
const EVIDENCE_CODES = ['insufficient_full_match', 'insufficient_recent_evidence', 'reference_missing', 'combine_missing'];

/**
 * The demo club's quarter. Nine rooms, one of them reopened after being
 * archived, two of them stalled — enough for the pipeline and aging panels to
 * say something real, and few enough that the rates in the smaller families
 * are honestly withheld.
 */
const STATUS_NOW: Record<string, number> = {
  watching: 1, under_review: 2, shortlisted: 2, trial_requested: 1, trial_completed: 1, withdrawn: 1, archived: 1,
};
const EVER_REACHED: Record<string, number> = {
  watching: 9, under_review: 9, shortlisted: 6, priority: 2, trial_requested: 2, trial_scheduled: 2, trial_completed: 1,
};
const STALLED = [
  { roomId: 'case-demo-3', status: 'under_review', idleDays: 41, playerId: 'pl-demo-3', playerName: 'J. Marsh' },
  { roomId: 'case-demo-7', status: 'shortlisted', idleDays: 33, playerId: 'pl-demo-7', playerName: 'R. Ibori' },
  { roomId: 'case-demo-9', status: 'watching', idleDays: 18, playerId: null, playerName: null },
];

function buildDashboard(filters: DashboardFilters): Dashboard {
  const to = new Date(NOW).toISOString().slice(0, 10);
  const spanDays = filters.window === 'last_7_days' ? 7 : filters.window === 'last_30_days' ? 30 : filters.window === 'last_365_days' ? 365 : filters.window === 'last_180_days' ? 180 : 90;
  const from = new Date(NOW - (spanDays - 1) * DAY).toISOString().slice(0, 10);
  const stallDays = filters.stallDays ?? 30;
  const applied = (['source', 'priority', 'brief'] as const)
    .filter((k) => filters[k])
    .map((k) => ({ filter: k === 'source' ? 'sourceContext' : k === 'brief' ? 'briefId' : k, value: String(filters[k]) }));

  const fam = (id: FamilyId, metrics: Record<string, Metric>, honoured: string[]): Family => ({
    family: id,
    label: FAMILY_LABELS[id],
    filtersHonoured: honoured,
    filtersNotApplicable: applied.filter((f) => !honoured.includes(f.filter)).map((f) => f.filter),
    metrics,
  });

  const data: Record<string, Family> = {
    pipeline: fam('pipeline', {
      pipeline_stage_counts: {
        ...M.pipeline_stage_counts,
        total: count(9),
        rows: ROOM_STATUSES.map((status) => ({ status, terminal: TERMINAL.includes(status), ...count(STATUS_NOW[status] ?? 0) })),
      } as Metric,
      funnel_progression: {
        ...M.funnel_progression,
        cohort: count(9),
        monotonic: false,
        reopenedInCohort: count(1),
        cohortIncomplete: spanDays <= 30,
        typicalDaysToTerminal: 47,
        rows: FUNNEL_STAGES.map((stage) => ({
          stage, ...count(EVER_REACHED[stage] ?? 0), reachedOutsideWindow: 0, share: ratio(EVER_REACHED[stage] ?? 0, 9),
        })),
      } as Metric,
      exit_reason_mix: {
        ...M.exit_reason_mix,
        total: count(2),
        overlapping: true,
        uncoded: count(0),
        rows: REASON_CATEGORIES.map((category) => ({
          category,
          ...count(category === 'evidence' ? 1 : category === 'process' ? 1 : 0),
          share: ratio(category === 'evidence' || category === 'process' ? 1 : 0, 2),
        })),
        codes: [
          { code: 'insufficient_recent_evidence', category: 'evidence', ...count(1) },
          { code: 'squad_space', category: 'process', ...count(1) },
        ],
      } as Metric,
    }, ['sourceContext', 'priority']),

    duration: fam('duration', {
      time_to_first_decision: {
        ...M.time_to_first_decision,
        ...dist([11, 19, 24], 7),
        excludedMeans: 'Rooms with no recorded decision at all. They cannot contribute a duration, so this figure describes the rooms that reached a decision — not all of your rooms.',
      } as Metric,
      time_in_stage: {
        ...M.time_in_stage,
        rows: [
          { status: 'watching', ...dist([4, 6, 9, 12, 14, 21]) },
          { status: 'under_review', ...dist([7, 9, 13, 16, 28]) },
          { status: 'shortlisted', ...dist([12, 26]) },
        ],
        stillInAStage: count(7),
        excludedMeans: 'Only visits that ENDED are measured. A stage where everything is stuck looks fast here, because the rooms still sitting in it are not counted. Read this next to Rooms with no recent activity.',
      } as Metric,
      time_to_trial_requested: {
        ...M.time_to_trial_requested, ...dist([31, 44], 7),
        excludedMeans: 'Rooms that never reached a trial request. Most rooms never will, and that is not a fault in the club or in any player.',
      } as Metric,
      time_trial_requested_to_completed: {
        ...M.time_trial_requested_to_completed, ...dist([], 1),
        excludedMeans: 'Trials requested but not yet recorded as completed.',
      } as Metric,
      open_room_age: {
        ...M.open_room_age, ...dist([9, 17, 24, 33, 41, 58, 74]), openRooms: count(7),
        buckets: [
          { id: '0_7', label: '0–7 days', ...count(0) },
          { id: '8_14', label: '8–14 days', ...count(1) },
          { id: '15_30', label: '15–30 days', ...count(2) },
          { id: '31_60', label: '31–60 days', ...count(3) },
          { id: '60_plus', label: 'Over 60 days', ...count(1) },
        ],
      } as Metric,
    }, ['sourceContext', 'priority']),

    aging: fam('aging', {
      stalled_rooms: {
        ...M.stalled_rooms,
        thresholdDays: stallDays,
        thresholds: [14, 30, 90].map((d) => ({ days: d, ...count(STALLED.filter((r) => r.idleDays >= d).length) })),
        openRooms: count(7),
        ...count(STALLED.filter((r) => r.idleDays >= stallDays).length),
        rows: STALLED.filter((r) => r.idleDays >= stallDays),
      } as Metric,
      overdue_trial_reports: {
        ...M.overdue_trial_reports, ...count(1), awaitingReport: count(2),
        rows: [{ trialId: 'trial-demo-2', overdueDays: 6 }],
        note: 'Unfiled trial reports already block new trial requests. This is the same rule, seen from the top.',
      } as Metric,
      decision_outstanding: { ...M.decision_outstanding, ...count(0), atOfferStage: count(0), rows: [] } as Metric,
    }, ['sourceContext', 'priority']),

    decision_record: fam('decision_record', {
      terminal_with_recorded_decision: { ...M.terminal_with_recorded_decision, ...ratio(2, 2), ended: count(2), rows: [] } as Metric,
      superseded_decision_rate: { ...M.superseded_decision_rate, ...ratio(1, 6), neutral: true } as Metric,
      evidence_limited_exits: {
        ...M.evidence_limited_exits, ...ratio(1, 2), ended: count(2),
        rows: EVIDENCE_CODES.map((code) => ({ code, ...count(code === 'insufficient_recent_evidence' ? 1 : 0) })),
      } as Metric,
      reopen_rate: { ...M.reopen_rate, ...ratio(1, 2), ended: count(2), neutral: true } as Metric,
    }, ['sourceContext', 'priority']),

    coverage: fam('coverage', {
      briefs_live: {
        ...M.briefs_live, ...count(2), total: count(3),
        byStatus: [['draft', 1], ['active', 2], ['paused', 0], ['closed', 0], ['archived', 0]].map(([status, n]) => ({ status, ...count(n as number) })),
        rows: [
          { briefId: 'brf-demo-1', title: '2027 Defensive Midfielders', version: 3 },
          { briefId: 'brf-demo-2', title: 'Left-sided cover, U18', version: 1 },
        ],
      } as Metric,
      nobody_missed_backlog: {
        ...M.nobody_missed_backlog, ...count(6), liveBriefs: count(2),
        rows: [
          { briefId: 'brf-demo-2', title: 'Left-sided cover, U18', ...count(2), reviewed: ratio(1, 3) },
          { briefId: 'brf-demo-1', title: '2027 Defensive Midfielders', ...count(4), reviewed: ratio(5, 9) },
        ].sort((a, b) => String(a.title).localeCompare(String(b.title))),
      } as Metric,
      nobody_missed_review_rate: { ...M.nobody_missed_review_rate, ...ratio(6, 12) } as Metric,
      second_look_backlog: {
        ...M.second_look_backlog, ...count(3), expired: count(1), reopenedRoom: count(1), age: dist([4, 9, 22]),
      } as Metric,
      second_look_response_time: {
        ...M.second_look_response_time, ...dist([2, 5, 11], 3),
        excludedMeans: 'Second Look items nobody has touched yet. They have no response time to measure, which is exactly why the backlog is shown next to this.',
      } as Metric,
    }, ['briefId']),

    source: fam('source', {
      room_source_mix: {
        ...M.room_source_mix,
        total: count(9),
        rows: [
          { source: 'search', residual: false, ...count(4), share: ratio(4, 9) },
          { source: 'dynamic_watchlist', residual: false, ...count(2), share: ratio(2, 9) },
          { source: 'nobody_missed', residual: false, ...count(2), share: ratio(2, 9) },
          { source: 'direct', residual: true, ...count(1), share: ratio(1, 9) },
        ],
      } as Metric,
      source_stage_reach: {
        ...M.source_stage_reach,
        associationOnly: true,
        associationNote: ASSOCIATION_NOTE,
        ordering: 'source_name_asc',
        minimum: SMALL_N_MIN,
        rows: [
          { source: 'direct', cohort: count(1), stages: ['trial_requested', 'offer_made', 'signed'].map((stage) => ({ stage, ...ratio(0, 1) })) },
          { source: 'dynamic_watchlist', cohort: count(2), stages: ['trial_requested', 'offer_made', 'signed'].map((stage) => ({ stage, ...ratio(stage === 'trial_requested' ? 1 : 0, 2) })) },
          { source: 'nobody_missed', cohort: count(2), stages: ['trial_requested', 'offer_made', 'signed'].map((stage) => ({ stage, ...ratio(0, 2) })) },
          { source: 'search', cohort: count(4), stages: ['trial_requested', 'offer_made', 'signed'].map((stage) => ({ stage, ...ratio(stage === 'trial_requested' ? 1 : 0, 4) })) },
        ],
      } as Metric,
    }, ['priority']),

    watchlist: fam('watchlist', {
      active_watchlists: {
        ...M.active_watchlists, ...count(2), total: count(3),
        byStatus: [['active', 2], ['paused', 1], ['archived', 0]].map(([status, n]) => ({ status, ...count(n as number) })),
      } as Metric,
      watchlist_membership_churn: {
        ...M.watchlist_membership_churn, ...count(5), entered: count(3), left: count(2),
        derivedOnRead: true,
        refreshNote: 'ScoutBox does not recompute watchlists in the background. These are the changes found when someone opened a list — a list nobody opened records nothing.',
      } as Metric,
    }, []),
  };

  const wanted = (filters.families ? filters.families.split(',') : Object.keys(data)) as FamilyId[];
  const kept: Record<string, Family> = {};
  for (const f of wanted) if (data[f]) kept[f] = data[f];

  const prevFrom = new Date(NOW - (spanDays * 2 - 1) * DAY).toISOString().slice(0, 10);
  const prevTo = new Date(NOW - spanDays * DAY).toISOString().slice(0, 10);

  return {
    policyVersion: 1,
    generatedAt: NOW,
    calculatedAt: NOW,
    liveStream: false,
    trend: {
      previousWindow: { preset: 'previous', from: prevFrom, to: prevTo, days: spanDays },
      note: 'Compared with the previous period of the same length. Only period activity is compared — a trend on a current-state figure would be meaningless, because the period does not apply to it.',
      rooms_opened: compare(9, 6),
      rooms_ended: compare(2, 0),
      decisions_recorded: compare(6, 4),
    },
    window: { preset: filters.from || filters.to ? 'custom' : (filters.window ?? 'last_90_days'), from: filters.from ?? from, to: filters.to ?? to, days: spanDays },
    filters: applied,
    smallNMinimum: SMALL_N_MIN,
    timeSemantics: TIME_SEMANTICS,
    groupDimensions: ['status', 'source_context', 'priority', 'reason_category', 'brief'],
    families: wanted,
    partial: false,
    unavailable: [],
    note: 'These figures measure your recruitment process — how work moves, how long it takes and what is waiting. They do not measure any player’s ability or potential, and they do not measure any colleague’s performance.',
    data: kept,
  };
}

/** The demo refuses exactly what the server refuses, in the server's words. */
function refuse(filters: DashboardFilters): DashboardOutcome | null {
  const w = filters.window;
  const WINDOWS = ['last_7_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days'];
  if (w && !WINDOWS.includes(w)) {
    return { ok: false, error: 'WINDOW_UNKNOWN', detail: `Unknown window "${w}".`, allowed: WINDOWS };
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return { ok: false, error: 'WINDOW_INVALID', detail: 'from must not be after to.' };
  }
  if (filters.stallDays != null && ![14, 30, 90].includes(filters.stallDays)) {
    return { ok: false, error: 'STALL_THRESHOLD_UNKNOWN', detail: 'Stall threshold must be one of 14, 30, 90 days.', allowed: [14, 30, 90] };
  }
  return null;
}

const CATALOGUE: Catalogue = {
  policyVersion: 1,
  principle: 'Measure the recruitment process, not the worth of the player or the scout.',
  families: (Object.keys(FAMILY_LABELS) as FamilyId[]).map((id) => ({ id, label: FAMILY_LABELS[id] })),
  timeSemantics: TIME_SEMANTICS,
  smallNMinimum: SMALL_N_MIN,
  smallNNote: 'A rate or a median over fewer than 5 records is withheld and shown as raw counts instead. Counts themselves are never hidden.',
  groupDimensions: ['status', 'source_context', 'priority', 'reason_category', 'brief'],
  windows: ['last_7_days', 'last_30_days', 'last_90_days', 'last_180_days', 'last_365_days'],
  defaultWindow: 'last_90_days',
  sourceContexts: ['search', 'watchlist', 'shortlist', 'opportunity', 'recommendation', 'campaign', 'passport', 'nobody_missed', 'second_look', 'matching', 'dynamic_watchlist', 'direct'],
  priorities: ['low', 'normal', 'high', 'urgent'],
  stallThresholds: [14, 30, 90],
  metrics: Object.values(M).map((m) => ({
    id: m.id, family: m.family as FamilyId, name: m.name, unit: m.unit, semantics: m.semantics, sources: m.sources,
    kind: ('distribution' in m && m.distribution) ? 'distribution' : (('ratio' in m && m.ratio) ? 'ratio' : 'count'),
    associationOnly: 'association' in m && !!m.association,
    limitation: m.limitation,
  })) as Catalogue['metrics'],
  neverBuilt: {
    note: 'These do not exist in ScoutBox and are not planned.',
    names: ['recruitment score', 'scout score', 'player success score', 'recruitment efficiency score', 'talent conversion score', 'club intelligence score', 'leaderboard', 'scout ranking', 'player ranking'],
    reason: 'A single blended figure invites a decision it cannot support, and a per-person breakdown of process counts is a ranking of colleagues however it is labelled.',
  },
};

export const demoM20: M20Api = {
  async catalogue() { return CATALOGUE; },
  async dashboard(_s, filters = {}) {
    return refuse(filters) ?? { ok: true, value: buildDashboard(filters) };
  },
  async rows(_s, metric, params = {}): Promise<Drilldown> {
    const all = metric === 'stalled_rooms'
      ? STALLED.filter((r) => r.idleDays >= (params.stallDays ?? 30))
      : metric === 'overdue_trial_reports'
        ? [{ trialId: 'trial-demo-2', overdueDays: 6 }]
        : [];
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 50);
    const cursor = Math.max(params.cursor ?? 0, 0);
    const found = Object.values(M).find((m) => m.id === metric);
    return {
      policyVersion: 1,
      metric,
      limitation: found?.limitation ?? '',
      total: all.length,
      limit,
      cursor,
      nextCursor: cursor + limit < all.length ? cursor + limit : null,
      rows: all.slice(cursor, cursor + limit),
    };
  },
};
