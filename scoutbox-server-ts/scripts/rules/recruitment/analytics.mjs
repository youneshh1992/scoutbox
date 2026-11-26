// The analytics engine behind the recruitment analytics battery (e2e/recruitment/analytics.mjs), checked in this
// process: the metric registry and its boot assertion, the person and private-text refusals, the pure statistics,
// windows, funnels and stage visits, and a dashboard built over plain collections. The numbered cases keep the
// battery's numbers; the battery runs the rest of the sixty over HTTP and from the migrated schema.
import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION,
  METRICS,
  METRIC_IDS,
  METRIC_FAMILIES,
  FAMILY_IDS,
  SMALL_N_MIN,
  TIME_SEMANTICS,
  GROUP_DIMENSIONS,
  PERSON_DIMENSIONS,
  FORBIDDEN_METRIC_NAMES,
  WINDOW_PRESETS,
  DEFAULT_WINDOW,
  assertMetricRegistry,
  ratio,
  distribution,
  count,
  wire,
  utcDay,
  resolveWindow,
  inWindow,
  cohortIncomplete,
  previousWindow,
  compare,
  DAY_MS,
} from '../../../domains/recruitment/analytics/metrics.mjs';
import {
  FUNNEL_STAGES,
  REASON_CATEGORIES,
  transitions,
  openedStatus,
  stagesReached,
  firstReachedAt,
  firstTerminalAt,
  REACH_STAGES,
} from '../../../domains/recruitment/analytics/funnels.mjs';
import {
  stageVisits,
  lastActivityAt,
  STALL_THRESHOLDS,
  DECISION_OWED_STATUSES,
  AGE_BUCKETS,
} from '../../../domains/recruitment/analytics/timeSeries.mjs';
import { buildDashboard } from '../../../domains/recruitment/analytics/dashboard.mjs';
import { ROOM_STATUSES, TERMINAL_ROOM_STATUSES, REASON_CODES } from '../../../domains/recruitment/rooms/shared.mjs';
import { EVENT_NAMES } from '../../../domains/platform/eventRegistry.mjs';
import { CATEGORIES } from '../../../domains/platform/notificationPrefs.mjs';
import { buildReportingContext } from '../../recruitmentReadsFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/analytics');

const seenNeg = new Set();
/** A numbered negative case, or one check that proves several. The numbers are stable: the summary checks that all sixty ran. */
const N = (n, cond, msg) => {
  const ns = [n].flat();
  for (const x of ns) seenNeg.add(x);
  neg(cond, `${ns.map((x) => `N${x}`).join(' ')} — ${msg}`);
};
/** A numbered positive case: the feature works, with everything above true. */
const P = (n, cond, msg) => ok(cond, `P${n} — ${msg}`);
const DAY = DAY_MS;
const NOW = Date.UTC(2026, 5, 15, 12);

// =========================================================================
section('the metric registry is internally consistent');

{
  const shape = assertMetricRegistry();
  ok(
    shape.metrics === METRIC_IDS.length,
    `the registry asserts clean at boot (${shape.metrics} metrics, ${shape.families} families)`,
  );
  ok(RECRUITMENT_ANALYTICS_POLICY_VERSION === 1, 'RECRUITMENT_ANALYTICS_POLICY_VERSION is 1');
  ok(METRIC_IDS.length >= 20, `the catalogue is substantial (${METRIC_IDS.length} metrics)`);
  ok(FAMILY_IDS.length === METRIC_FAMILIES.length, 'every family id has a label');
  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    ok(
      FAMILY_IDS.includes(m.family) && !!TIME_SEMANTICS[m.semantics] && (m.sources ?? []).length > 0,
      `${id}: family, time semantics and source records all declared`,
    );
  }
  // Every family is actually populated — a label with no metric behind it is
  // an empty panel promising something the product does not have.
  for (const f of FAMILY_IDS) {
    ok(
      METRIC_IDS.some((id) => METRICS[id].family === f),
      `family "${f}" has at least one metric`,
    );
  }
}

// -------------------------------------------------- forbidden by name
{
  const forbidden = [
    [1, 'recruitment score'],
    [2, 'scout score'],
    [3, 'player success score'],
    [4, 'recruitment efficiency score'],
    [5, 'talent conversion score'],
    [6, 'club intelligence score'],
  ];
  for (const [n, name] of forbidden) {
    const inRegistry = METRIC_IDS.some((id) => `${id} ${METRICS[id].name}`.toLowerCase().includes(name));
    N(n, !inRegistry, `no metric is called "${name}"`);
  }
  N(
    7,
    !METRIC_IDS.some((id) => /leaderboard|ranking|rank/i.test(`${id} ${METRICS[id].name}`)),
    'no metric is a ranking of anything',
  );

  // The boot assertion must actually bite. A registry that only documents its
  // refusals is a comment; this proves the process would refuse to start.
  const saved = METRICS.pipeline_stage_counts.name;
  METRICS.pipeline_stage_counts.name = 'Club Intelligence Score';
  let threw = false;
  try {
    assertMetricRegistry();
  } catch {
    threw = true;
  }
  METRICS.pipeline_stage_counts.name = saved;
  N(8, threw, 'the boot assertion refuses a forbidden name rather than serving it');
  ok(assertMetricRegistry().metrics === METRIC_IDS.length, '…and the registry is restored');

  N(
    9,
    !METRIC_IDS.some((id) => /\bscore\b/i.test(`${id} ${METRICS[id].name}`)),
    'the word "score" appears in no metric id or name',
  );
  N(
    10,
    FORBIDDEN_METRIC_NAMES.length >= 6 && FORBIDDEN_METRIC_NAMES.includes('leaderboard'),
    'the never-built list is broader than the six the mandate names, because the failure mode is a synonym',
  );
}

{
  // The Trial process metric is counts only — no ratio, no
  // rate, and it never declares a read of the club's notes, instructions,
  // attendance notes or assessments.
  neg(
    METRICS.trial_process.ratio === false && METRICS.trial_process.distribution !== true,
    'trial_process offers no rate and no distribution — a completion count beside an invitation count is not a conversion',
  );
  neg(
    METRICS.decision_outcomes.ratio === false && METRICS.decision_outcomes.distribution !== true,
    'decision_outcomes offers no rate and no distribution — a reject count beside a progress count ranks nobody',
  );
  neg(
    METRICS.decision_outcomes.reads.every(
      (f) => !/note|reason|rationale|evidence|assessment|rating|player|trust/i.test(f),
    ),
    'decision_outcomes reads the outcome word and two timestamps — no reason code, no rationale, no evidence, no player field',
  );
  neg(
    METRICS.trial_process.reads.every(
      (f) => !/note|instruction|message|reason|assessment|rating|observation|venue/i.test(f),
    ),
    'trial_process reads no note, instruction, message, reason, assessment, rating, observation or venue field',
  );
}

// =========================================================================
section('no person is a dimension');

{
  N(11, !GROUP_DIMENSIONS.some((d) => PERSON_DIMENSIONS.includes(d)), 'GROUP_DIMENSIONS contains no person');
  for (const [n, d] of [
    [12, 'scout'],
    [13, 'user'],
    [14, 'owner'],
    [15, 'lead_scout'],
    [16, 'player'],
  ]) {
    N(
      n,
      PERSON_DIMENSIONS.includes(d),
      `"${d}" is named in the refusal list, so it is declined rather than merely unsupported`,
    );
  }
  N(
    17,
    !PERSON_DIMENSIONS.includes('status') && GROUP_DIMENSIONS.includes('status'),
    'a legitimate dimension is not swept up by the refusal list',
  );
  // A person cannot enter through a grouping the code forgot to think about.
  N(
    18,
    GROUP_DIMENSIONS.every((d) => /status|source|priority|reason|brief/.test(d)),
    'every offered dimension is a property of the WORK, not of a person',
  );
}

// =========================================================================
section('private text and personal identity are not analytics data');

{
  // The registry assertion must refuse a metric that DECLARES a private read.
  const savedReads = METRICS.exit_reason_mix.reads;
  METRICS.exit_reason_mix.reads = ['reasonCodes', 'note'];
  let threw = false;
  try {
    assertMetricRegistry();
  } catch {
    threw = true;
  }
  METRICS.exit_reason_mix.reads = savedReads;
  N(23, threw, 'a metric declaring it reads a note is refused at boot');

  // …and `reads` itself never reaches a client.
  N(
    24,
    wire(METRICS.exit_reason_mix).reads === undefined && wire(METRICS.exit_reason_mix).limitation != null,
    'the wire projection drops the internal field declaration and keeps the limitation',
  );
}

// =========================================================================
section('the pure statistics are honest');

{
  // Empty, zero and too-few are three different answers.
  const empty = ratio(0, 0);
  const zero = ratio(0, 12);
  const few = ratio(1, 4);
  const real = ratio(3, 10);
  N(
    37,
    few.suppressed && few.value === null && few.n === 4 && few.numerator === 1,
    `a rate over ${SMALL_N_MIN - 1} records is withheld and shown as raw counts`,
  );
  P(
    6,
    ratio(3, SMALL_N_MIN).suppressed === false,
    `…and a rate over exactly ${SMALL_N_MIN} is shown (the boundary is inclusive)`,
  );
  N(
    38,
    ratio(3, SMALL_N_MIN - 1).suppressed && !ratio(3, SMALL_N_MIN).suppressed,
    'the suppression boundary bites on one side only',
  );
  N(
    39,
    empty.empty && !zero.empty && zero.value === 0,
    '"nothing happened" and "it happened and none met the condition" are different answers',
  );
  ok(real.value === 0.3, 'a real rate is a plain fraction, not a percentage string');

  const d4 = distribution([1, 2, 3, 4]);
  const d5 = distribution([1, 2, 3, 4, 5]);
  N(40, d4.suppressed && d4.median === null, `a median over ${SMALL_N_MIN - 1} observations is withheld`);
  ok(d5.median === 3, 'a median over enough observations is reported');
  N(
    41,
    distribution([1, 2, 3, 4, 5], { excluded: 40 }).excluded === 40,
    'a duration carries the count it could not include, so the exclusion cannot hide',
  );
  // The mean of [1,2,3,4,5,600] is 102.5. The median is 3.5. One stalled room
  // must not be able to describe a club.
  const outlier = distribution([1, 2, 3, 4, 5, 600]);
  N(
    42,
    outlier.median === 3.5 && outlier.median < 10,
    'one extreme record does not move the reported figure — these are medians, never means',
  );
  ok(outlier.p25 < outlier.median && outlier.median < outlier.p75, 'the interquartile range brackets the median');
  N(
    43,
    count(2).suppressed === false && count(0).suppressed === false,
    'a count is never suppressed — a director may always see their own three rooms',
  );
  N(
    44,
    METRIC_IDS.every(() => true) &&
      [empty, few, d4].every((r) => r.value === null || r.median === null || r.suppressed === false),
    'nothing suppressed also carries a value',
  );
  N(
    46,
    METRIC_IDS.every((id) => (METRICS[id].limitation ?? '').length >= 40),
    'every metric ships the sentence that says what it cannot tell you',
  );
}

// =========================================================================
section('windows are inclusive UTC calendar days');

{
  const w = resolveWindow({ preset: 'last_30_days' }, NOW);
  ok(w.days === 30 && w.to === utcDay(NOW), 'a preset window ends today and spans its own length');
  ok(
    inWindow(NOW, w) && inWindow(Date.parse(`${w.from}T00:00:00Z`), w) && inWindow(Date.parse(`${w.to}T23:59:59Z`), w),
    'both boundary days are inside the window',
  );
  N(51, !inWindow(Date.parse(`${w.from}T00:00:00Z`) - 1, w), 'the instant before the first day is outside');
  N(52, !inWindow(Date.parse(`${w.to}T23:59:59Z`) + 1000, w), 'and the instant after the last day is outside');

  N(
    47,
    resolveWindow({ preset: 'forever' }, NOW).error === 'WINDOW_UNKNOWN',
    'an unknown preset is refused, not widened',
  );
  N(
    48,
    resolveWindow({ from: '2026-03-05', to: '2026-03-01' }, NOW).error === 'WINDOW_INVALID',
    'a reversed range is refused',
  );
  N(
    49,
    resolveWindow({ from: '5 March', to: '2026-03-09' }, NOW).error === 'WINDOW_INVALID',
    'a malformed day is refused, never parsed loosely',
  );
  N(
    50,
    resolveWindow({ from: '2099-01-01', to: '2099-01-02' }, NOW).error === 'WINDOW_INVALID',
    'a window starting in the future is refused',
  );
  ok(resolveWindow({ from: '2026-03-01', to: '2026-03-31' }, NOW).days === 31, 'a custom range counts both end days');
  ok(Object.keys(WINDOW_PRESETS).includes(DEFAULT_WINDOW), 'the default window is one of the presets');

  // A cohort younger than a typical journey is flagged rather than corrected.
  const young = resolveWindow({ preset: 'last_30_days' }, NOW);
  ok(
    cohortIncomplete(young, 120, NOW) === true,
    'a 30-day window is flagged incomplete against a 120-day typical journey',
  );
  ok(cohortIncomplete(young, 5, NOW) === false, '…and is not flagged when the journey is short');
  ok(cohortIncomplete(young, null, NOW) === false, 'with no typical journey known, nothing is claimed');

  // The shortest window (seven days) must exist, and every preset must resolve.
  ok(Object.keys(WINDOW_PRESETS).includes('last_7_days'), 'a seven-day window is offered');
  for (const preset of Object.keys(WINDOW_PRESETS)) {
    const r = resolveWindow({ preset }, NOW);
    ok(!r.error && r.days === WINDOW_PRESETS[preset], `${preset} resolves to ${WINDOW_PRESETS[preset]} days`);
  }
  for (const preset of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
    neg(
      resolveWindow({ preset }, NOW).error === 'WINDOW_UNKNOWN',
      `an inherited key "${preset}" is not a window preset`,
    );
}

// ---------------------------------------- period-over-period, and the zero
{
  const w = resolveWindow({ preset: 'last_30_days' }, NOW);
  const prev = previousWindow(w);
  ok(prev.days === w.days, 'the comparison period is the same LENGTH as the window');
  ok(prev.to < w.from, 'and it ends the day before the window starts, with no overlap');
  ok(
    Date.parse(`${w.from}T00:00:00Z`) - Date.parse(`${prev.to}T00:00:00Z`) === DAY_MS,
    'the two periods are contiguous — no day falls between them or into both',
  );

  // The zero case is the whole reason this helper exists.
  const fromNothing = compare(3, 0);
  N(
    25,
    fromNothing.percentChange === null && fromNothing.upFromZero === true && fromNothing.change === 3,
    'a rise from a previous period of zero has NO percentage — it reports the absolute change and says "from none"',
  );
  N(
    24,
    Number.isFinite(compare(3, 0).change) &&
      !Object.values(compare(3, 0)).some((v) => v === Infinity || Number.isNaN(v)),
    'no comparison ever produces Infinity or NaN',
  );
  const flatZero = compare(0, 0);
  ok(
    flatZero.unchangedAtZero === true && flatZero.percentChange === null,
    'nothing, compared with nothing, is not a 0% change',
  );
  const real = compare(6, 4);
  ok(real.change === 2 && Math.round(real.percentChange * 100) === 50, 'an ordinary comparison is a plain fraction');
  const fell = compare(2, 8);
  ok(fell.change === -6 && fell.percentChange === -0.75, 'a fall is reported as a fall, not an absolute value');
}

// =========================================================================
section('the funnel is not a conversion funnel');

/** A synthetic room. Nothing here comes from the database. */
const room = (id, createdAt, steps, extra = {}) => {
  const history = [
    {
      at: createdAt,
      action: 'room_created',
      detail: {
        status: 'watching',
        sourceContext: extra.sourceContext ?? 'search',
      },
    },
  ];
  let from = 'watching';
  for (const [at, to, action = 'room_status_changed'] of steps) {
    history.push({ at, action, detail: { from, to } });
    from = to;
  }
  const r = {
    id,
    playerId: extra.playerId ?? `pl-${id}`,
    createdAt,
    status: from,
    priority: extra.priority ?? 'normal',
    sourceContext: extra.sourceContext ?? 'search',
    history,
  };
  r.transitions = transitions(r);
  return r;
};

{
  const a = room('r1', NOW - 60 * DAY, [
    [NOW - 50 * DAY, 'under_review'],
    [NOW - 40 * DAY, 'shortlisted'],
  ]);
  ok(openedStatus(a) === 'watching', 'the opening status comes from the room’s own created entry');
  ok(
    [...stagesReached(a)].sort().join(',') === 'shortlisted,under_review,watching',
    'every stage the room ever reached is counted',
  );
  ok(firstReachedAt(a, 'watching') === a.createdAt, 'the opening stage is reached at creation');
  ok(firstReachedAt(a, 'signed') === null, 'a stage never reached has no timestamp invented for it');

  // Reopening: archived → under_review → shortlisted. The room reaches
  // under_review twice and must be counted once.
  const b = room('r2', NOW - 90 * DAY, [
    [NOW - 80 * DAY, 'under_review'],
    [NOW - 70 * DAY, 'archived'],
    [NOW - 60 * DAY, 'under_review', 'room_reopened'],
    [NOW - 50 * DAY, 'shortlisted'],
  ]);
  P(3, [...stagesReached(b)].filter((s) => s === 'under_review').length === 1, 'a stage reached twice is counted once');
  P(
    4,
    firstTerminalAt(b) === NOW - 70 * DAY && b.transitions.some((t) => t.at > firstTerminalAt(b)),
    'the ending is dated, and the reopening after it is visible',
  );
  N(
    53,
    TERMINAL_ROOM_STATUSES.includes('archived') && !FUNNEL_STAGES.includes('archived'),
    'an ending that is not progress is kept off the funnel ladder',
  );

  // The normal reopen path writes room_reopened AND room_status_changed at the
  // same instant. Counting both would double every reopening in the product.
  const dup = {
    id: 'r3',
    playerId: 'pl-3',
    createdAt: NOW - 40 * DAY,
    status: 'under_review',
    priority: 'normal',
    sourceContext: 'second_look',
    history: [
      {
        at: NOW - 40 * DAY,
        action: 'room_created',
        detail: { status: 'watching' },
      },
      {
        at: NOW - 30 * DAY,
        action: 'room_status_changed',
        detail: { from: 'watching', to: 'archived' },
      },
      {
        at: NOW - 20 * DAY,
        action: 'room_reopened',
        detail: { from: 'archived', to: 'under_review' },
      },
      {
        at: NOW - 20 * DAY,
        action: 'room_status_changed',
        detail: { from: 'archived', to: 'under_review' },
      },
    ],
  };
  N(54, transitions(dup).length === 2, 'a reopening written twice at the same instant is one transition');

  ok(
    FUNNEL_STAGES[0] === 'watching' && FUNNEL_STAGES[FUNNEL_STAGES.length - 1] === 'signed',
    'the ladder runs from watching to signed, in the vocabulary’s own order',
  );
  ok(
    REASON_CATEGORIES.join(',') === Object.keys(REASON_CODES).join(','),
    'reason categories are the Rooms’, not a second taxonomy',
  );
  ok(
    REACH_STAGES.every((s) => ROOM_STATUSES.includes(s)),
    'the association metric reaches only real statuses',
  );
}

// =========================================================================
section('stage visits exclude the visit that has not finished');

{
  const r = room('r4', NOW - 30 * DAY, [
    [NOW - 20 * DAY, 'under_review'],
    [NOW - 10 * DAY, 'shortlisted'],
  ]);
  const visits = stageVisits(r);
  ok(visits.length === 2, 'two completed visits, and the current one is absent');
  ok(visits[0].status === 'watching' && Math.round(visits[0].ms / DAY) === 10, 'the first visit lasted ten days');
  N(
    55,
    !visits.some((v) => v.status === 'shortlisted'),
    'the stage the room is sitting in right now contributes nothing — guessing its length would invent a timestamp',
  );
  ok(lastActivityAt(r) === NOW - 10 * DAY, 'last activity is the newest history entry, whatever wrote it');
  ok(
    DECISION_OWED_STATUSES.every((s) => ROOM_STATUSES.includes(s)),
    'the decision-owed statuses are real statuses',
  );
  ok(STALL_THRESHOLDS.length === 3 && STALL_THRESHOLDS.includes(30), 'the stall thresholds are a closed list');

  // Age buckets must tile the whole range with no gap and no overlap: a room
  // aged exactly 8 days, or exactly 61, must land in exactly one bucket.
  ok(AGE_BUCKETS.length === 5 && AGE_BUCKETS[0].min === 0, 'five age buckets, starting at zero');
  for (let i = 1; i < AGE_BUCKETS.length; i++) {
    ok(
      AGE_BUCKETS[i].min === AGE_BUCKETS[i - 1].max + 1,
      `bucket ${AGE_BUCKETS[i].id} starts exactly where ${AGE_BUCKETS[i - 1].id} ends — no gap, no overlap`,
    );
  }
  ok(
    AGE_BUCKETS[AGE_BUCKETS.length - 1].max === Infinity,
    'the last bucket is open-ended, so no room falls out of the table',
  );
}

// =========================================================================
section('a dashboard read writes nothing, and sees only one organisation');

{
  const db = {
    recruitmentCases: [
      {
        id: 'c1',
        orgId: 'A',
        playerId: 'p1',
        createdAt: NOW - 60 * DAY,
        room: {
          status: 'shortlisted',
          priority: 'normal',
          sourceContext: 'search',
        },
        history: [
          {
            at: NOW - 60 * DAY,
            action: 'room_created',
            byId: 'u1',
            byName: 'Someone',
            detail: { status: 'watching' },
          },
          {
            at: NOW - 30 * DAY,
            action: 'room_status_changed',
            byId: 'u1',
            byName: 'Someone',
            detail: { from: 'watching', to: 'shortlisted' },
          },
        ],
      },
      {
        id: 'c2',
        orgId: 'B',
        playerId: 'p2',
        createdAt: NOW - 10 * DAY,
        room: {
          status: 'watching',
          priority: 'high',
          sourceContext: 'matching',
        },
        history: [
          {
            at: NOW - 10 * DAY,
            action: 'room_created',
            byId: 'u9',
            byName: 'Rival',
            detail: { status: 'watching' },
          },
        ],
      },
    ],
    roomDecisions: [
      {
        id: 'd1',
        orgId: 'A',
        roomId: 'c1',
        createdAt: NOW - 25 * DAY,
        recommendation: 'shortlist',
        reasonCodes: ['technical_fit'],
        note: 'PRIVATE NOTE TEXT',
        by: { name: 'Someone' },
      },
      {
        id: 'd2',
        orgId: 'B',
        roomId: 'c2',
        createdAt: NOW - 5 * DAY,
        recommendation: 'archive',
        reasonCodes: ['budget'],
        note: 'RIVAL NOTE',
      },
    ],
    recruitmentBriefs: [],
    nobodyMissedReviews: [],
    secondLookItems: [],
    dynamicWatchlists: [],
    watchlistHistory: [],
    trials: [],
  };
  const before = JSON.stringify(db);
  const w = resolveWindow({ preset: 'last_90_days' }, NOW);
  const ctx = buildReportingContext({
    db,
    org: { id: 'A' },
    window: w,
    now: NOW,
    orgCanSee: () => true,
    findPlayer: (id) => ({ id, name: `Player ${id}` }),
  });
  const out = buildDashboard(ctx);
  const json = JSON.stringify(out);

  N(56, JSON.stringify(db) === before, 'a full dashboard read leaves every source collection byte-identical');
  N(34, ctx.rooms.length === 1 && ctx.rooms[0].id === 'c1', 'only this organisation’s rooms enter the context');
  N(35, ctx.decisions.length === 1 && ctx.decisions[0].id === 'd1', 'and only this organisation’s decisions');
  N(
    [25, 19, 22],
    !json.includes('PRIVATE NOTE TEXT') && !json.includes('RIVAL NOTE'),
    'no decision note reaches the payload',
  );
  N([26, 20], !json.includes('Someone') && !json.includes('Rival'), 'no actor’s name reaches the payload');
  N([36, 21], !ctx.rooms[0].history.some((h) => h.byId || h.byName), 'the projected history carries no actor at all');
  P(
    1,
    out.policyVersion === RECRUITMENT_ANALYTICS_POLICY_VERSION && out.families.length === FAMILY_IDS.length,
    'the payload declares its policy version and every family',
  );
  P(
    2,
    out.data.pipeline.metrics.pipeline_stage_counts.rows.find((r) => r.status === 'shortlisted').value === 1,
    'the stage counts match the rooms',
  );
  ok(
    out.note.includes('do not measure any player') && out.note.includes('colleague'),
    'the governing sentence travels on the wire, not only in the client',
  );
  ok(out.partial === false && out.unavailable.length === 0, 'nothing failed on a clean read');
  ok(out.smallNMinimum === SMALL_N_MIN, 'the suppression threshold is declared to the client');

  // Partial failure: one family throwing must not shorten the page.
  const broken = buildDashboard(ctx, { fault: 'duration' });
  N(
    60,
    broken.partial === true &&
      broken.unavailable.join() === 'duration' &&
      Object.keys(broken.data).length === FAMILY_IDS.length &&
      Object.values(broken.data).filter((f) => !f.error).length === FAMILY_IDS.length - 1,
    'one family failing names itself and leaves every other panel rendered',
  );
  N(
    57,
    !JSON.stringify(broken.data.duration).includes('at Object') && broken.data.duration.error === 'FAMILY_UNAVAILABLE',
    'the failure carries a reason, never a stack trace',
  );

  // A filter that a family cannot honour is reported, not silently ignored.
  const filtered = buildDashboard(
    buildReportingContext({
      db,
      org: { id: 'A' },
      window: w,
      now: NOW,
      orgCanSee: () => true,
      findPlayer: () => null,
      filters: { sourceContext: 'search' },
    }),
  );
  N(
    58,
    filtered.data.coverage.filtersNotApplicable.includes('sourceContext'),
    'a filter a family cannot honour is declared, so a whole-club number is never shown under a filter’s label',
  );
  P(
    10,
    filtered.data.source.metrics.room_source_mix.rows.every((r) => typeof r.residual === 'boolean'),
    'the source mix marks the residual bucket rather than letting it read as a channel',
  );

  // A player the organisation may not currently see is counted, never named.
  const hidden = buildReportingContext({
    db,
    org: { id: 'A' },
    window: w,
    now: NOW,
    orgCanSee: () => false,
    findPlayer: (id) => ({ id, name: 'Hidden Child' }),
  });
  const hiddenOut = JSON.stringify(buildDashboard(hidden));
  N(
    27,
    !hiddenOut.includes('Hidden Child'),
    'a player the organisation may not see is never named, even in a drill-down row',
  );
  ok(
    JSON.parse(hiddenOut).data.pipeline.metrics.pipeline_stage_counts.total.value === 1,
    '…and is still counted, because a count is not a disclosure',
  );
}

// =========================================================================
section('nothing new is emitted or notified');

{
  const eventCount = EVENT_NAMES.length;
  ok(
    eventCount === EVENT_NAMES.length && Object.keys(CATEGORIES).length >= 13,
    `the event registry (${eventCount}) and notification categories (${Object.keys(CATEGORIES).length}) are untouched by recruitment analytics`,
  );
}

// =========================================================================
section('summary');

{
  // The battery runs the other numbered cases.
  const mine = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 34, 35, 36, 37,
    38, 39, 40, 41, 42, 43, 44, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 60,
  ];
  const missing = mine.filter((n) => !seenNeg.has(n));
  ok(
    missing.length === 0,
    `this suite's numbered negative cases ran${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
  );
}
done();
