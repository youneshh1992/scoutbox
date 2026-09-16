/**
 * M20 — Recruitment Analytics: the metric registry and the pure statistics
 * behind it.
 *
 * The governing rule of this module, and of the milestone:
 *
 *     Measure the recruitment process, not the worth of the player or
 *     the scout.
 *
 * Nothing here knows what a good player looks like and nothing here knows
 * what a good scout looks like. Every metric below is a count or a duration
 * over WORKFLOW records — a room opened, a status changed, a decision
 * written down, a review left untouched. A director acts on these by
 * changing how the club works, never by forming an opinion about a person.
 *
 * Four refusals are built in rather than documented:
 *
 *   1. No blended overall number. There is no Recruitment Score, Scout
 *      Score, Player Success Score, Recruitment Efficiency Score, Talent
 *      Conversion Score or Club Intelligence Score, and `assertMetricRegistry`
 *      refuses to boot if one appears.
 *   2. No person dimension. `GROUP_DIMENSIONS` is a closed list with no
 *      person in it, and `PERSON_DIMENSIONS` exists only so a request for one
 *      can be refused by name rather than falling through to "unknown".
 *   3. No private text. Every metric declares the fields it reads; `note`,
 *      `comment` and every narrative field are absent from every declaration.
 *   4. No causation. A metric that compares groups declares
 *      `association: true` and carries the sentence that says so.
 *
 * The definitions in M20_METRICS.md and the registry here are the same
 * definitions; `assertMetricRegistry` is what stops them drifting apart, and
 * m20E2E cross-checks the file against the registry.
 */

export const RECRUITMENT_ANALYTICS_POLICY_VERSION = 1;

/**
 * Below this many observations a RATIO or a MEDIAN is withheld and the raw
 * numerator and denominator are shown instead. Counts are never suppressed: a
 * director must be able to see their own three rooms.
 *
 * 5 rather than M18's SUPPRESS_MIN of 3, because a ratio invites a conclusion
 * that a list does not: "we convert 33% of trials" reads as a finding even
 * when it means one trial out of three.
 */
export const SMALL_N_MIN = 5;

/** The six families a director reads, in the order the dashboard renders. */
export const METRIC_FAMILIES = [
  { id: 'pipeline', label: 'Pipeline shape' },
  { id: 'duration', label: 'How long the process takes' },
  { id: 'aging', label: 'Work that has stopped moving' },
  { id: 'decision_record', label: 'Decision record hygiene' },
  { id: 'coverage', label: 'Coverage of your stated demand' },
  { id: 'source', label: 'Where work comes from' },
  { id: 'watchlist', label: 'Dynamic watchlists' },
];
export const FAMILY_IDS = METRIC_FAMILIES.map((f) => f.id);

/**
 * Time semantics. Every metric declares exactly one, and the payload carries
 * it, because "how many rooms" means three different things depending on
 * which of these is meant.
 */
export const TIME_SEMANTICS = {
  point_in_time: 'The state of the world now. The window does not apply.',
  window_entry: 'Counted in the window the entry event happened in (a room opened, a decision written).',
  window_completion: 'Counted in the window the completing event happened in (a room reached a terminal status, a trial finished).',
};

/**
 * The dimensions a metric may be grouped by. There is no person here and
 * there will not be one: a per-person breakdown of process counts is a scout
 * leaderboard with the ranking left as an exercise for the reader.
 */
export const GROUP_DIMENSIONS = ['status', 'source_context', 'priority', 'reason_category', 'brief'];

/**
 * Refused by name. Without this list a request for `groupBy=scout` would fall
 * through the same "unknown dimension" path as a typo, and the refusal would
 * not say why. These are not unsupported; they are declined.
 */
export const PERSON_DIMENSIONS = ['scout', 'user', 'owner', 'lead_scout', 'leadScout', 'assignee', 'author', 'created_by', 'createdBy', 'player'];

/** The sentence that must accompany any metric comparing groups. */
export const ASSOCIATION_NOTE =
  'ScoutBox observes that these records share this property and later reached this stage. It does not show that the property caused it: people choose where to look, and the players they find differ in ways ScoutBox does not measure.';

/**
 * Names this product will never carry. Swept in source, in every payload, in
 * both client bundles and in the docs. The list is deliberately broader than
 * the six the mandate names, because the failure mode is a synonym.
 */
export const FORBIDDEN_METRIC_NAMES = [
  'recruitment score', 'scout score', 'player success score', 'recruitment efficiency score',
  'talent conversion score', 'club intelligence score', 'scouting score', 'performance score',
  'overall score', 'composite score', 'leaderboard', 'scout ranking', 'top scout',
  'best scout', 'player ranking', 'talent score', 'potential score', 'success rate per scout',
];

// ---------------------------------------------------------------- registry

const M = (id, family, name, spec) => ({ id, family, name, ...spec });

/**
 * One entry per metric. `reads` is the exhaustive list of record fields the
 * projection may touch — it is asserted against the source at boot in
 * development, so a projection that quietly starts reading a decision note
 * fails loudly rather than shipping.
 *
 * `limitation` is not documentation. It is rendered on the panel, in both
 * languages, next to the number.
 */
export const METRICS = {
  // ---- pipeline
  pipeline_stage_counts: M('pipeline_stage_counts', 'pipeline', 'Rooms by status', {
    unit: 'rooms',
    semantics: 'point_in_time',
    sources: ['recruitmentCases'],
    reads: ['room.status'],
    ratio: false,
    limitation: 'A status is where a room is, not how far it has travelled. A room that has sat in Watching for a year looks identical here to one opened this morning.',
  }),
  funnel_progression: M('funnel_progression', 'pipeline', 'Stages reached', {
    unit: 'rooms',
    semantics: 'window_entry',
    sources: ['recruitmentCases'],
    reads: ['createdAt', 'history.at', 'history.action', 'history.detail.to'],
    ratio: true,
    limitation: 'Rooms can be reopened, so this is not a one-way funnel: a room counts once for each stage it ever reached, not once per visit. A recent window is incomplete by construction — rooms opened last week have not had time to reach a signing.',
  }),
  trial_process: M('trial_process', 'pipeline', 'Trial process', {
    unit: 'trials',
    semantics: 'window_entry',
    sources: ['requests', 'trials'],
    reads: ['type', 'caseId', 'status', 'createdAt', 'respondedAt', 'acceptedAt', 'schedule.confirmedAt', 'completion.state', 'completion.at', 'subjectRemovedAt'],
    ratio: false,
    limitation: 'These are counts of process steps in the window — invitations sent, accepted, schedules confirmed, trials completed, cancelled or declined — never how a trial went. No rate is built on them: a club that invites five players and completes three has not "converted 60%", it has run three trials.',
  }),
  decision_outcomes: M('decision_outcomes', 'pipeline', 'Formal decisions', {
    unit: 'decisions',
    semantics: 'window_entry',
    sources: ['roomDecisions'],
    reads: ['kind', 'state', 'outcome', 'createdAt', 'supersededById', 'roomId'],
    ratio: false,
    limitation: 'Counts of formal recruitment decisions finalized in the window, by outcome — progress, hold, reject — and how many were later superseded. A process count, never a verdict on anyone: a club that rejects nine players and progresses one has run ten decisions, not ranked ten people.',
  }),
  exit_reason_mix: M('exit_reason_mix', 'pipeline', 'Why rooms ended', {
    unit: 'decisions',
    semantics: 'window_completion',
    sources: ['roomDecisions', 'recruitmentCases'],
    reads: ['reasonCodes', 'createdAt', 'roomId'],
    ratio: true,
    limitation: 'This is the reason the club recorded, not the reason that operated. A decision carrying codes in two categories counts in both, so the shares add up to more than 100%.',
  }),

  // ---- duration
  time_to_first_decision: M('time_to_first_decision', 'duration', 'Time to first decision', {
    unit: 'days',
    semantics: 'window_completion',
    sources: ['recruitmentCases', 'roomDecisions'],
    reads: ['createdAt', 'roomId'],
    distribution: true,
    limitation: 'Rooms that never reached a decision are excluded, so this measures the rooms that got there. The number excluded is shown beside it.',
  }),
  time_in_stage: M('time_in_stage', 'duration', 'Time spent in each stage', {
    unit: 'days',
    semantics: 'window_completion',
    sources: ['recruitmentCases'],
    reads: ['history.at', 'history.action', 'history.detail.from', 'history.detail.to'],
    distribution: true,
    limitation: 'Only completed visits count. A stage where everything is stuck therefore looks fast, because only the rooms that escaped it are measured — Stalled rooms is the figure that catches that.',
  }),
  time_to_trial_requested: M('time_to_trial_requested', 'duration', 'Time from opening to trial requested', {
    unit: 'days',
    semantics: 'window_completion',
    sources: ['recruitmentCases'],
    reads: ['createdAt', 'history.at', 'history.detail.to'],
    distribution: true,
    limitation: 'A club that opens rooms late in its own process looks fast here. This measures the ScoutBox record, not the club’s thinking.',
  }),
  time_trial_requested_to_completed: M('time_trial_requested_to_completed', 'duration', 'Trial requested to completed', {
    unit: 'days',
    semantics: 'window_completion',
    sources: ['recruitmentCases'],
    reads: ['history.at', 'history.detail.to'],
    distribution: true,
    limitation: 'Guardian response, pitch availability and school holidays all live inside this number and cannot be separated from it.',
  }),
  open_room_age: M('open_room_age', 'duration', 'Age of open rooms', {
    unit: 'days',
    semantics: 'point_in_time',
    sources: ['recruitmentCases'],
    reads: ['createdAt', 'room.status'],
    distribution: true,
    limitation: 'Age is not neglect. A long-running room on a fourteen-year-old being tracked to sixteen is the product working as intended.',
  }),

  // ---- aging
  stalled_rooms: M('stalled_rooms', 'aging', 'Rooms with no recent activity', {
    unit: 'rooms',
    semantics: 'point_in_time',
    sources: ['recruitmentCases'],
    reads: ['room.status', 'history.at'],
    ratio: false,
    limitation: 'No activity in ScoutBox is not no activity. A scout who watched a player on Saturday and did not write it down produces a stalled room. This is a prompt to look, not a finding.',
  }),
  overdue_trial_reports: M('overdue_trial_reports', 'aging', 'Trial reports past due', {
    unit: 'trials',
    semantics: 'point_in_time',
    sources: ['trials'],
    reads: ['status', 'reportDueAt', 'orgId'],
    ratio: false,
    limitation: 'This surfaces an obligation the server already enforces — unfiled reports block new trial requests. It adds no new judgement.',
  }),
  decision_outstanding: M('decision_outstanding', 'aging', 'Offers with no recorded decision', {
    unit: 'rooms',
    semantics: 'point_in_time',
    sources: ['recruitmentCases', 'roomDecisions'],
    reads: ['room.status', 'roomId'],
    ratio: false,
    limitation: 'This reuses the Recruitment Room’s own readiness rule. If that rule is wrong, this is wrong in exactly the same way — deliberately, so there is one definition rather than two.',
  }),

  // ---- decision record hygiene
  terminal_with_recorded_decision: M('terminal_with_recorded_decision', 'decision_record', 'Endings with a recorded decision', {
    unit: 'rooms',
    semantics: 'window_completion',
    sources: ['recruitmentCases', 'roomDecisions'],
    reads: ['room.status', 'history.at', 'history.detail.to', 'roomId', 'createdAt'],
    ratio: true,
    limitation: 'Ending a room for a reason-required status records a decision automatically, so this rate is high by construction. Its value is in the exceptions.',
  }),
  superseded_decision_rate: M('superseded_decision_rate', 'decision_record', 'Decisions later revised', {
    unit: 'decisions',
    semantics: 'window_entry',
    sources: ['roomDecisions'],
    reads: ['createdAt', 'supersededById'],
    ratio: true,
    limitation: 'Revising a decision is healthy. A high figure here is not a fault and is never coloured as one.',
  }),
  evidence_limited_exits: M('evidence_limited_exits', 'decision_record', 'Endings limited by evidence', {
    unit: 'decisions',
    semantics: 'window_completion',
    sources: ['roomDecisions'],
    reads: ['reasonCodes', 'createdAt'],
    ratio: true,
    limitation: 'Association only. It does not follow that collecting the missing evidence would have changed any of these decisions.',
  }),
  reopen_rate: M('reopen_rate', 'decision_record', 'Rooms reopened after ending', {
    unit: 'rooms',
    semantics: 'window_entry',
    sources: ['recruitmentCases'],
    reads: ['history.at', 'history.action', 'history.detail.from', 'history.detail.to'],
    ratio: true,
    limitation: 'Reopening is intended behaviour — Second Look exists to cause it. High is not bad.',
  }),

  // ---- coverage
  briefs_live: M('briefs_live', 'coverage', 'Live recruitment briefs', {
    unit: 'briefs',
    semantics: 'point_in_time',
    sources: ['recruitmentBriefs'],
    reads: ['status', 'activeFrom', 'activeUntil'],
    ratio: false,
    limitation: 'A brief being live says nothing about whether anyone is working it.',
  }),
  nobody_missed_backlog: M('nobody_missed_backlog', 'coverage', 'Unreviewed eligible players', {
    unit: 'reviews',
    semantics: 'point_in_time',
    sources: ['nobodyMissedReviews', 'recruitmentBriefs'],
    reads: ['state', 'briefId'],
    ratio: false,
    limitation: 'The backlog is a function of how wide the brief is. Widening a brief creates backlog without anyone having done anything wrong.',
  }),
  nobody_missed_review_rate: M('nobody_missed_review_rate', 'coverage', 'Eligible players reviewed', {
    unit: 'reviews',
    semantics: 'point_in_time',
    sources: ['nobodyMissedReviews', 'recruitmentBriefs'],
    reads: ['state', 'briefId'],
    ratio: true,
    limitation: 'Dismissing a candidate counts as reviewing them. This measures that the club looked, not what it concluded.',
  }),
  second_look_backlog: M('second_look_backlog', 'coverage', 'Open Second Look items', {
    unit: 'items',
    semantics: 'point_in_time',
    sources: ['secondLookItems'],
    reads: ['status', 'createdAt'],
    ratio: false,
    limitation: 'An expired item is not backlog — expiry is a designed outcome and is counted separately.',
  }),
  second_look_response_time: M('second_look_response_time', 'coverage', 'Time to respond to Second Look', {
    unit: 'days',
    semantics: 'window_completion',
    sources: ['secondLookItems'],
    reads: ['status', 'createdAt', 'updatedAt'],
    distribution: true,
    limitation: 'Items never touched are absent from this figure. Their count is shown beside it.',
  }),

  // ---- source
  room_source_mix: M('room_source_mix', 'source', 'Where rooms came from', {
    unit: 'rooms',
    semantics: 'window_entry',
    sources: ['recruitmentCases'],
    reads: ['createdAt', 'room.sourceContext'],
    ratio: true,
    limitation: 'Direct is the fallback ScoutBox assigns to anything it does not recognise, so it is a residual bucket rather than a surface people used.',
  }),
  source_stage_reach: M('source_stage_reach', 'source', 'Stages reached, by source', {
    unit: 'rooms',
    semantics: 'window_entry',
    sources: ['recruitmentCases'],
    reads: ['createdAt', 'room.sourceContext', 'history.detail.to'],
    ratio: true,
    association: true,
    limitation: 'Confounded by construction, and never a ranking of surfaces: sources are listed alphabetically. Most will be withheld for too few rooms, which is the correct outcome rather than a gap.',
  }),

  // ---- watchlists
  active_watchlists: M('active_watchlists', 'watchlist', 'Active dynamic watchlists', {
    unit: 'watchlists',
    semantics: 'point_in_time',
    sources: ['dynamicWatchlists'],
    reads: ['status'],
    ratio: false,
    limitation: 'A big list is a wide set of criteria, nothing more.',
  }),
  watchlist_membership_churn: M('watchlist_membership_churn', 'watchlist', 'Players entering and leaving lists', {
    unit: 'changes',
    semantics: 'window_entry',
    sources: ['watchlistHistory'],
    reads: ['at', 'entered', 'exited'],
    ratio: false,
    limitation: 'ScoutBox does not recompute watchlists in the background: membership is worked out when someone opens a list. This counts those recalculations, not the moment a player’s facts changed — a list nobody opens records no change at all.',
  }),
};

export const METRIC_IDS = Object.keys(METRICS);

/**
 * The registry entry as it goes on the wire.
 *
 * `reads` stays behind: it is the declaration this module asserts the
 * projections against, not something a client has any use for, and publishing
 * an internal field list invites an integrator to treat it as a contract.
 * Everything else — including the limitation sentence — travels with the
 * number, because a figure without its caveat is the failure mode this
 * milestone exists to avoid.
 */
export const wire = (m) => {
  const { reads, ...rest } = m;
  return rest;
};

/**
 * Boot assertion. Cheap, and it catches the ways this design rots silently:
 * a metric in an unknown family, a metric that is both a ratio and a
 * distribution (which unit would it carry?), a comparison metric that forgot
 * to declare itself as association only, a metric reading a private field,
 * and — the one that matters most — a forbidden name creeping in.
 */
export function assertMetricRegistry() {
  const privateFields = ['note', 'notes', 'comment', 'body', 'text', 'byName', 'byId', 'scoutName', 'ownerUserId'];
  for (const [id, m] of Object.entries(METRICS)) {
    if (m.id !== id) throw new Error(`M20: metric "${id}" carries id "${m.id}".`);
    if (!FAMILY_IDS.includes(m.family)) throw new Error(`M20: metric "${id}" is in unknown family "${m.family}".`);
    if (!TIME_SEMANTICS[m.semantics]) throw new Error(`M20: metric "${id}" declares unknown time semantics "${m.semantics}".`);
    if (m.ratio && m.distribution) throw new Error(`M20: metric "${id}" is both a ratio and a distribution; it can carry only one unit.`);
    if (!m.limitation || m.limitation.length < 40) throw new Error(`M20: metric "${id}" has no stated limitation. Every metric ships with the sentence that says what it cannot tell you.`);
    if (m.association && !m.ratio) throw new Error(`M20: metric "${id}" declares association but compares nothing.`);
    for (const f of m.reads ?? []) {
      const leaf = f.split('.').pop();
      if (privateFields.includes(leaf)) throw new Error(`M20: metric "${id}" declares it reads "${f}". Private text and personal identity are not analytics data.`);
    }
    const hay = `${id} ${m.name}`.toLowerCase();
    for (const bad of FORBIDDEN_METRIC_NAMES) {
      if (hay.includes(bad)) throw new Error(`M20: metric "${id}" carries the forbidden name "${bad}".`);
    }
  }
  for (const d of GROUP_DIMENSIONS) {
    if (PERSON_DIMENSIONS.includes(d)) throw new Error(`M20: "${d}" is a person and cannot be a grouping dimension.`);
  }
  return { metrics: METRIC_IDS.length, families: FAMILY_IDS.length };
}

// -------------------------------------------------------------- statistics

/**
 * A ratio, with the three outcomes kept apart on the wire:
 *
 *   • nothing happened      → { n: 0, empty: true, value: null }
 *   • it happened, none met → { n: 12, value: 0 }
 *   • too few to be a rate  → { n: 4, numerator: 1, suppressed: true, value: null }
 *
 * "No rooms ended this month" and "0% of rooms that ended had a decision" are
 * different sentences and a dashboard that renders both as "0%" is lying.
 */
export function ratio(numerator, denominator, { min = SMALL_N_MIN } = {}) {
  const n = Number(denominator) || 0;
  const num = Number(numerator) || 0;
  if (n === 0) return { n: 0, numerator: 0, value: null, empty: true, suppressed: false };
  if (n < min) return { n, numerator: num, value: null, empty: false, suppressed: true, minimum: min };
  return { n, numerator: num, value: num / n, empty: false, suppressed: false };
}

/** Linear-interpolated quantile over a sorted numeric array. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Median and interquartile range — never a mean. One eighteen-month room
 * would move a mean and tell a director nothing true.
 *
 * `excluded` is the count of records that could not contribute because they
 * have not finished. It travels with the figure so the exclusion cannot hide:
 * a median time-to-decision over the rooms that reached a decision is a
 * different claim from a median over all rooms, and the caller must say which.
 */
export function distribution(values, { min = SMALL_N_MIN, excluded = 0 } = {}) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = nums.length;
  if (n === 0) return { n: 0, median: null, p25: null, p75: null, empty: true, suppressed: false, excluded };
  if (n < min) return { n, median: null, p25: null, p75: null, empty: false, suppressed: true, minimum: min, excluded };
  return {
    n,
    median: quantile(nums, 0.5),
    p25: quantile(nums, 0.25),
    p75: quantile(nums, 0.75),
    min: nums[0],
    max: nums[n - 1],
    empty: false,
    suppressed: false,
    excluded,
  };
}

/** A plain count. Never suppressed — a director may always see their own work. */
export const count = (n) => ({ n: Number(n) || 0, value: Number(n) || 0, empty: false, suppressed: false });

export const DAY_MS = 86_400_000;
/** Whole days between two instants, as a float. Durations are never rounded to zero. */
export const days = (from, to) => (Number(to) - Number(from)) / DAY_MS;

// ------------------------------------------------------------------ window

/**
 * Windows are inclusive UTC calendar days, the same rule M18.2 established for
 * brief date boundaries. There is no local time anywhere in this codebase's
 * boundaries and M20 does not introduce one: a club in UTC+13 and a club in
 * UTC-7 both see the day boundary at the same instant, and the docs say which.
 */
export const utcDay = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);

export const WINDOW_PRESETS = {
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
  last_180_days: 180,
  last_365_days: 365,
};
export const DEFAULT_WINDOW = 'last_90_days';

/**
 * Resolve a window to a pair of inclusive UTC calendar days. A custom range is
 * accepted only as two well-formed days in order; anything else is refused,
 * never silently repaired, because a quietly widened window changes every
 * number on the page without saying so.
 */
export function resolveWindow({ preset, from, to } = {}, nowMs = Date.now()) {
  const today = utcDay(nowMs);
  if (from || to) {
    const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
    if (!ok(from) || !ok(to)) return { error: 'WINDOW_INVALID', detail: 'from and to must both be calendar days as YYYY-MM-DD.' };
    if (from > to) return { error: 'WINDOW_INVALID', detail: 'from must not be after to.' };
    if (from > today) return { error: 'WINDOW_INVALID', detail: 'from must not be in the future.' };
    return { preset: 'custom', from, to, days: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1 };
  }
  const key = preset ?? DEFAULT_WINDOW;
  const span = WINDOW_PRESETS[key];
  if (!span) return { error: 'WINDOW_UNKNOWN', detail: `Unknown window "${key}".`, allowed: Object.keys(WINDOW_PRESETS) };
  return { preset: key, from: utcDay(nowMs - (span - 1) * DAY_MS), to: today, days: span };
}

/** Inclusive at both ends, on the UTC calendar day of the instant. */
export const inWindow = (ms, w) => {
  if (!Number.isFinite(Number(ms))) return false;
  const d = utcDay(ms);
  return d >= w.from && d <= w.to;
};

/**
 * Is this cohort too young to have finished? A window whose end is within
 * `typicalDays` of now cannot contain completed journeys for the rooms opened
 * near its end, so any conversion-shaped figure over it reads low.
 *
 * This is a caution, not a correction: nothing is adjusted, and the flag is
 * rendered as a sentence rather than applied as a factor.
 */
/**
 * The window of equal length immediately before this one, for a
 * period-over-period comparison. Equal length matters: comparing a 7-day
 * window against a 30-day one would make every figure look like a collapse.
 */
export function previousWindow(w) {
  const from = Date.parse(`${w.from}T00:00:00Z`);
  const to = Date.parse(`${w.to}T00:00:00Z`);
  const span = to - from + DAY_MS;
  return { preset: 'previous', from: utcDay(from - span), to: utcDay(from - DAY_MS), days: Math.round(span / DAY_MS) };
}

/**
 * Compare two counts across equal windows.
 *
 * The rule that matters is the zero case: a rise from nothing has no
 * percentage, and rendering one produces Infinity or a meaningless 100%. So
 * `percentChange` is null and `upFromZero` says what actually happened —
 * the client renders the absolute change and the words "up from 0".
 */
export function compare(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  return {
    current: c,
    previous: p,
    change: c - p,
    percentChange: p === 0 ? null : (c - p) / p,
    upFromZero: p === 0 && c > 0,
    unchangedAtZero: p === 0 && c === 0,
  };
}

export function cohortIncomplete(w, typicalDays, nowMs = Date.now()) {
  if (!Number.isFinite(typicalDays) || typicalDays <= 0) return false;
  const end = Date.parse(`${w.to}T23:59:59Z`);
  return (Math.min(nowMs, end) - Date.parse(`${w.from}T00:00:00Z`)) < typicalDays * DAY_MS;
}
