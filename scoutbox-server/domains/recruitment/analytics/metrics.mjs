/**
 * Recruitment analytics: the metric registry and its statistics. Metrics measure the recruitment process,
 * never the worth of a player or a scout: each is a count or duration over workflow records.
 *
 * `assertMetricRegistry` refuses a blended score, a person grouping dimension or a metric reading private
 * text. A metric comparing groups declares `association: true` and carries ASSOCIATION_NOTE.
 *
 * docs/reference/recruitment-metrics.md documents the same definitions; change both together.
 */

export const RECRUITMENT_ANALYTICS_POLICY_VERSION = 1;

/**
 * Below this many observations a ratio or median is withheld and the raw numbers shown instead; counts are
 * never suppressed. Higher than the list SUPPRESS_MIN of 3 because "33% of trials" reads as a finding when
 * it is one trial in three.
 */
export const SMALL_N_MIN = 5;

/** In the order the dashboard renders. */
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

/** Every metric declares one, because "how many rooms" means different things under each. */
export const TIME_SEMANTICS = {
  point_in_time: 'The state of the world now. The window does not apply.',
  window_entry: 'Counted in the window the entry event happened in (a room opened, a decision written).',
  window_completion: 'Counted in the window the completing event happened in (a room reached a terminal status, a trial finished).',
};

/** No person dimension: a per-person breakdown of process counts is a scout leaderboard. */
export const GROUP_DIMENSIONS = ['status', 'source_context', 'priority', 'reason_category', 'brief'];

/** Refused by name, so the refusal says why instead of reading like a typo. */
export const PERSON_DIMENSIONS = ['scout', 'user', 'owner', 'lead_scout', 'leadScout', 'assignee', 'author', 'created_by', 'createdBy', 'player'];

export const ASSOCIATION_NOTE =
  'ScoutBox observes that these records share this property and later reached this stage. It does not show that the property caused it: people choose where to look, and the players they find differ in ways ScoutBox does not measure.';

/** Swept in source, payloads, client bundles and docs. Broader than the obvious names because synonyms are the failure mode. */
export const FORBIDDEN_METRIC_NAMES = [
  'recruitment score', 'scout score', 'player success score', 'recruitment efficiency score',
  'talent conversion score', 'club intelligence score', 'scouting score', 'performance score',
  'overall score', 'composite score', 'leaderboard', 'scout ranking', 'top scout',
  'best scout', 'player ranking', 'talent score', 'potential score', 'success rate per scout',
];

// ---------------------------------------------------------------- registry

const M = (id, family, name, spec) => ({ id, family, name, ...spec });

/**
 * `reads` lists every record field the projection may touch and is checked at boot in development, so a
 * projection that starts reading a decision note fails loudly. `limitation` is rendered next to the number.
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
  // From the records, not the status history: a stage counts only when its proving record exists, once per
  // case. Cases whose history reached a stage without a record are reported apart, not folded in.
  journey_evidence_funnel: M('journey_evidence_funnel', 'pipeline', 'Journey stages (from the records)', {
    unit: 'rooms',
    semantics: 'window_entry',
    sources: ['recruitmentCases', 'recruitmentContacts', 'requests', 'trials', 'assessments', 'roomDecisions', 'recruitmentOffers', 'signingPackages', 'signings'],
    reads: ['createdAt', 'caseId', 'orgId', 'playerId', 'status', 'deliveredAt', 'occurredAt', 'recordedAt', 'cancelledAt', 'type', 'acceptedAt', 'schedule.confirmedAt', 'completion.state', 'completion.at', 'state', 'submittedAt', 'kind', 'outcome', 'supersededById', 'roomId', 'revisions.status', 'revisions.issuedAt', 'revisions.respondedAt', 'signingPackageId', 'ts', 'history.action', 'history.detail.to'],
    ratio: false,
    limitation: 'Each stage counts cases for which the record itself exists — a delivered contact, a completed trial, a submitted assessment, a finalized decision, an issued or answered Offer, a completed signing — not cases whose status merely says so. A case counts once per stage however many retries or revisions it carried. Cases whose history reached a stage with no record behind it are shown apart as "history only"; they are older cases, not progress. A recent window is incomplete by construction.',
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

/** `reads` stays server-side; the limitation travels with the number, since a figure without its caveat misleads. */
export const wire = (m) => {
  const { reads, ...rest } = m;
  return rest;
};

/** Boot assertion against the ways the registry could rot silently, above all a forbidden name creeping in. */
export function assertMetricRegistry() {
  const privateFields = ['note', 'notes', 'comment', 'body', 'text', 'byName', 'byId', 'scoutName', 'ownerUserId'];
  for (const [id, m] of Object.entries(METRICS)) {
    if (m.id !== id) throw new Error(`Recruitment analytics: metric "${id}" carries id "${m.id}".`);
    if (!FAMILY_IDS.includes(m.family)) throw new Error(`Recruitment analytics: metric "${id}" is in unknown family "${m.family}".`);
    if (!TIME_SEMANTICS[m.semantics]) throw new Error(`Recruitment analytics: metric "${id}" declares unknown time semantics "${m.semantics}".`);
    if (m.ratio && m.distribution) throw new Error(`Recruitment analytics: metric "${id}" is both a ratio and a distribution; it can carry only one unit.`);
    if (!m.limitation || m.limitation.length < 40) throw new Error(`Recruitment analytics: metric "${id}" has no stated limitation. Every metric ships with the sentence that says what it cannot tell you.`);
    if (m.association && !m.ratio) throw new Error(`Recruitment analytics: metric "${id}" declares association but compares nothing.`);
    for (const f of m.reads ?? []) {
      const leaf = f.split('.').pop();
      if (privateFields.includes(leaf)) throw new Error(`Recruitment analytics: metric "${id}" declares it reads "${f}". Private text and personal identity are not analytics data.`);
    }
    const hay = `${id} ${m.name}`.toLowerCase();
    for (const bad of FORBIDDEN_METRIC_NAMES) {
      if (hay.includes(bad)) throw new Error(`Recruitment analytics: metric "${id}" carries the forbidden name "${bad}".`);
    }
  }
  for (const d of GROUP_DIMENSIONS) {
    if (PERSON_DIMENSIONS.includes(d)) throw new Error(`Recruitment analytics: "${d}" is a person and cannot be a grouping dimension.`);
  }
  return { metrics: METRIC_IDS.length, families: FAMILY_IDS.length };
}

// -------------------------------------------------------------- statistics

/**
 * Keeps three outcomes apart: nothing happened (`empty`), it happened and none met (`value: 0`), and too few
 * to be a rate (`suppressed`). "No rooms ended" and "0% had a decision" must not both render as 0%.
 */
export function ratio(numerator, denominator, { min = SMALL_N_MIN } = {}) {
  const n = Number(denominator) || 0;
  const num = Number(numerator) || 0;
  if (n === 0) return { n: 0, numerator: 0, value: null, empty: true, suppressed: false };
  if (n < min) return { n, numerator: num, value: null, empty: false, suppressed: true, minimum: min };
  return { n, numerator: num, value: num / n, empty: false, suppressed: false };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Median and interquartile range, never a mean: one eighteen-month room would move a mean. `excluded` counts
 * unfinished records and travels with the figure so the exclusion cannot hide.
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

/** Never suppressed: a director may always see their own work. */
export const count = (n) => ({ n: Number(n) || 0, value: Number(n) || 0, empty: false, suppressed: false });

import { parseStrictDateOnly } from '../../../temporal.mjs';

export const DAY_MS = 86_400_000;
/** As a float: durations are never rounded to zero. */
export const days = (from, to) => (Number(to) - Number(from)) / DAY_MS;

// ------------------------------------------------------------------ window

/** Windows are inclusive UTC calendar days, as for brief boundaries; there is no local time. */
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
 * A custom range must be two well-formed days in order; anything else is refused, because a quietly widened
 * window changes every number on the page.
 */
export function resolveWindow({ preset, from, to } = {}, nowMs = Date.now()) {
  const today = utcDay(nowMs);
  if (from || to) {
    // A real day: a shape test alone would read `2026-02-30` as 2 March.
    const ok = (d) => parseStrictDateOnly(d).ok;
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

export const inWindow = (ms, w) => {
  if (!Number.isFinite(Number(ms))) return false;
  const d = utcDay(ms);
  return d >= w.from && d <= w.to;
};

/** Equal length matters: a 7-day window against a 30-day one would make every figure look like a collapse. */
export function previousWindow(w) {
  const from = Date.parse(`${w.from}T00:00:00Z`);
  const to = Date.parse(`${w.to}T00:00:00Z`);
  const span = to - from + DAY_MS;
  return { preset: 'previous', from: utcDay(from - span), to: utcDay(from - DAY_MS), days: Math.round(span / DAY_MS) };
}

/** A rise from zero has no percentage, so `percentChange` is null and `upFromZero` says what happened. */
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

/**
 * A caution, not a correction: true when the window is too young for journeys opened in it to have finished,
 * so a conversion-shaped figure over it reads low. Nothing is adjusted.
 */
export function cohortIncomplete(w, typicalDays, nowMs = Date.now()) {
  if (!Number.isFinite(typicalDays) || typicalDays <= 0) return false;
  const end = Date.parse(`${w.to}T23:59:59Z`);
  return (Math.min(nowMs, end) - Date.parse(`${w.from}T00:00:00Z`)) < typicalDays * DAY_MS;
}
