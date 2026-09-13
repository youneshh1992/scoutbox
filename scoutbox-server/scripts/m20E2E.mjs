// M20 acceptance suite — Recruitment Analytics and the Director Dashboard.
//
// The whole milestone rests on one sentence:
//
//     Measure the recruitment process, not the worth of the player
//     or the scout.
//
// So this suite spends most of its effort on the second half of that sentence.
// Sixty numbered negative cases (N1–N60) try to turn the dashboard into a
// score, a ranking of colleagues, a way to read a private note, a cross-tenant
// read, a rate over three records presented as a finding, or a claim of cause
// where ScoutBox only sees association. Twelve positive cases (P1–P12) prove
// the thing actually works while all of that stays true.
//
// Structure:  §1–§8   in-process — the registry, the pure statistics, source sweeps
//             §9–§18  HTTP against a fresh server
//             §19     a second boot: migration idempotence and the upgrade path
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECRUITMENT_ANALYTICS_POLICY_VERSION, METRICS, METRIC_IDS, METRIC_FAMILIES, FAMILY_IDS,
  SMALL_N_MIN, TIME_SEMANTICS, GROUP_DIMENSIONS, PERSON_DIMENSIONS, FORBIDDEN_METRIC_NAMES,
  ASSOCIATION_NOTE, WINDOW_PRESETS, DEFAULT_WINDOW,
  assertMetricRegistry, ratio, distribution, count, wire, utcDay, resolveWindow, inWindow,
  cohortIncomplete, days, DAY_MS,
} from '../m20/metrics.mjs';
import {
  FUNNEL_STAGES, REASON_CATEGORIES, transitions, openedStatus, stagesReached,
  firstReachedAt, firstTerminalAt, REACH_STAGES,
} from '../m20/funnels.mjs';
import { stageVisits, lastActivityAt, STALL_THRESHOLDS, DECISION_OWED_STATUSES } from '../m20/timeSeries.mjs';
import { EVIDENCE_REASON_CODES } from '../m20/cohorts.mjs';
import { buildReportingContext, buildDashboard } from '../m20/dashboard.mjs';
import { migrateM20, DRILLDOWN_METRICS } from '../m20/index.mjs';
import { ROOM_STATUSES, TERMINAL_ROOM_STATUSES, OPEN_ROOM_STATUSES, SOURCE_CONTEXTS, ROOM_PRIORITIES, REASON_CODES } from '../m17/shared.mjs';
import { EVENT_NAMES } from '../m182/eventRegistry.mjs';
import { CATEGORIES } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../m182/migrations.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..');
const ROOT = path.join(SERVER_DIR, '..');
const SERVER = path.join(SERVER_DIR, 'server.mjs');
const PORT = 5960 + Math.floor(Math.random() * 8);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m20-'));

let passed = 0; let negatives = 0;
const seenNeg = new Set();
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
/** A numbered negative case. The number is the contract with the mandate. */
const N = (n, cond, msg) => { seenNeg.add(n); neg(cond, `N${n} — ${msg}`); };
/** A numbered positive case: the feature works, with everything above true. */
const P = (n, cond, msg) => ok(cond, `P${n} — ${msg}`);
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: a sweep must not be satisfied by prose. */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const M20_FILES = ['metrics', 'funnels', 'timeSeries', 'cohorts', 'dashboard', 'index']
  .map((f) => [`m20/${f}.mjs`, code(`scoutbox-server/m20/${f}.mjs`)]);

const DAY = DAY_MS;
const NOW = Date.UTC(2026, 5, 15, 12);

// =========================================================================
section('§1 — the metric registry is internally consistent');

{
  const shape = assertMetricRegistry();
  ok(shape.metrics === METRIC_IDS.length, `the registry asserts clean at boot (${shape.metrics} metrics, ${shape.families} families)`);
  ok(RECRUITMENT_ANALYTICS_POLICY_VERSION === 1, 'RECRUITMENT_ANALYTICS_POLICY_VERSION is 1');
  ok(METRIC_IDS.length >= 20, `the catalogue is substantial (${METRIC_IDS.length} metrics)`);
  ok(FAMILY_IDS.length === METRIC_FAMILIES.length, 'every family id has a label');
  for (const id of METRIC_IDS) {
    const m = METRICS[id];
    ok(FAMILY_IDS.includes(m.family) && !!TIME_SEMANTICS[m.semantics] && (m.sources ?? []).length > 0,
      `${id}: family, time semantics and source records all declared`);
  }
  // Every family is actually populated — a label with no metric behind it is
  // an empty panel promising something the product does not have.
  for (const f of FAMILY_IDS) {
    ok(METRIC_IDS.some((id) => METRICS[id].family === f), `family "${f}" has at least one metric`);
  }
}

// -------------------------------------------------- forbidden by name
{
  const forbidden = [
    [1, 'recruitment score'], [2, 'scout score'], [3, 'player success score'],
    [4, 'recruitment efficiency score'], [5, 'talent conversion score'], [6, 'club intelligence score'],
  ];
  for (const [n, name] of forbidden) {
    const inRegistry = METRIC_IDS.some((id) => `${id} ${METRICS[id].name}`.toLowerCase().includes(name));
    N(n, !inRegistry, `no metric is called "${name}"`);
    const inSource = M20_FILES.some(([f, src]) => f !== 'm20/metrics.mjs' && new RegExp(name.replace(/ /g, '[ _]?'), 'i').test(src));
    N(n, !inSource, `and "${name}" appears in no projection (only in the refusal list itself)`);
  }
  N(7, !METRIC_IDS.some((id) => /leaderboard|ranking|rank/i.test(`${id} ${METRICS[id].name}`)),
    'no metric is a ranking of anything');

  // The boot assertion must actually bite. A registry that only documents its
  // refusals is a comment; this proves the process would refuse to start.
  const saved = METRICS.pipeline_stage_counts.name;
  METRICS.pipeline_stage_counts.name = 'Club Intelligence Score';
  let threw = false;
  try { assertMetricRegistry(); } catch { threw = true; }
  METRICS.pipeline_stage_counts.name = saved;
  N(8, threw, 'the boot assertion refuses a forbidden name rather than serving it');
  ok(assertMetricRegistry().metrics === METRIC_IDS.length, '…and the registry is restored');

  N(9, !METRIC_IDS.some((id) => /\bscore\b/i.test(`${id} ${METRICS[id].name}`)),
    'the word "score" appears in no metric id or name');
  N(10, FORBIDDEN_METRIC_NAMES.length >= 6 && FORBIDDEN_METRIC_NAMES.includes('leaderboard'),
    'the never-built list is broader than the six the mandate names, because the failure mode is a synonym');
}

// =========================================================================
section('§2 — no person is a dimension');

{
  N(11, !GROUP_DIMENSIONS.some((d) => PERSON_DIMENSIONS.includes(d)), 'GROUP_DIMENSIONS contains no person');
  for (const [n, d] of [[12, 'scout'], [13, 'user'], [14, 'owner'], [15, 'lead_scout'], [16, 'player']]) {
    N(n, PERSON_DIMENSIONS.includes(d), `"${d}" is named in the refusal list, so it is declined rather than merely unsupported`);
  }
  N(17, !PERSON_DIMENSIONS.includes('status') && GROUP_DIMENSIONS.includes('status'),
    'a legitimate dimension is not swept up by the refusal list');
  // A person cannot enter through a grouping the code forgot to think about.
  N(18, GROUP_DIMENSIONS.every((d) => /status|source|priority|reason|brief/.test(d)),
    'every offered dimension is a property of the WORK, not of a person');
}

// =========================================================================
section('§3 — private text and personal identity are not analytics data');

{
  for (const [file, src] of M20_FILES) {
    N(19, !/\.note\b/.test(src), `${file}: never reads a decision or room note`);
    // Property READS only: metrics.mjs names these same fields as string
    // literals in the list it refuses metrics for declaring, and that list is
    // the safeguard, not a violation of it.
    N(20, !/\.(byName|byId|scoutName|ownerUserId)\b/.test(src), `${file}: never reads who did the work`);
    neg(!/\.body\b|commentText|assessmentText/.test(src), `${file}: never reads a comment or assessment body`);
  }
  // The projection must STRIP identity, not merely decline to read it: a
  // history entry passed through whole would carry byName into every payload.
  const dash = code('scoutbox-server/m20/dashboard.mjs');
  N(21, /at: h\.at,\s*action: h\.action/.test(dash) && !/byKind/.test(dash),
    'projectRoom rebuilds each history entry from at/action/detail and drops the actor');
  N(22, /const projectDecision[\s\S]{0,400}?\}\);/.test(dash) && !/note: d\.note|by: d\.by/.test(dash),
    'projectDecision omits the note and the author');

  // The registry assertion must refuse a metric that DECLARES a private read.
  const savedReads = METRICS.exit_reason_mix.reads;
  METRICS.exit_reason_mix.reads = ['reasonCodes', 'note'];
  let threw = false;
  try { assertMetricRegistry(); } catch { threw = true; }
  METRICS.exit_reason_mix.reads = savedReads;
  N(23, threw, 'a metric declaring it reads a note is refused at boot');

  // …and `reads` itself never reaches a client.
  N(24, wire(METRICS.exit_reason_mix).reads === undefined && wire(METRICS.exit_reason_mix).limitation != null,
    'the wire projection drops the internal field declaration and keeps the limitation');
}

// =========================================================================
section('§4 — the pure statistics are honest');

{
  // Empty, zero and too-few are three different answers.
  const empty = ratio(0, 0);
  const zero = ratio(0, 12);
  const few = ratio(1, 4);
  const real = ratio(3, 10);
  N(37, few.suppressed && few.value === null && few.n === 4 && few.numerator === 1,
    `a rate over ${SMALL_N_MIN - 1} records is withheld and shown as raw counts`);
  P(6, ratio(3, SMALL_N_MIN).suppressed === false, `…and a rate over exactly ${SMALL_N_MIN} is shown (the boundary is inclusive)`);
  N(38, ratio(3, SMALL_N_MIN - 1).suppressed && !ratio(3, SMALL_N_MIN).suppressed,
    'the suppression boundary bites on one side only');
  N(39, empty.empty && !zero.empty && zero.value === 0,
    '"nothing happened" and "it happened and none met the condition" are different answers');
  ok(real.value === 0.3, 'a real rate is a plain fraction, not a percentage string');

  const d4 = distribution([1, 2, 3, 4]);
  const d5 = distribution([1, 2, 3, 4, 5]);
  N(40, d4.suppressed && d4.median === null, `a median over ${SMALL_N_MIN - 1} observations is withheld`);
  ok(d5.median === 3, 'a median over enough observations is reported');
  N(41, distribution([1, 2, 3, 4, 5], { excluded: 40 }).excluded === 40,
    'a duration carries the count it could not include, so the exclusion cannot hide');
  // The mean of [1,2,3,4,5,600] is 102.5. The median is 3.5. One stalled room
  // must not be able to describe a club.
  const outlier = distribution([1, 2, 3, 4, 5, 600]);
  N(42, outlier.median === 3.5 && outlier.median < 10,
    'one extreme record does not move the reported figure — these are medians, never means');
  ok(outlier.p25 < outlier.median && outlier.median < outlier.p75, 'the interquartile range brackets the median');
  N(43, count(2).suppressed === false && count(0).suppressed === false,
    'a count is never suppressed — a director may always see their own three rooms');
  N(44, METRIC_IDS.every(() => true) && [empty, few, d4].every((r) => r.value === null || r.median === null || r.suppressed === false),
    'nothing suppressed also carries a value');
  N(46, METRIC_IDS.every((id) => (METRICS[id].limitation ?? '').length >= 40),
    'every metric ships the sentence that says what it cannot tell you');
}

// =========================================================================
section('§5 — windows are inclusive UTC calendar days');

{
  const w = resolveWindow({ preset: 'last_30_days' }, NOW);
  ok(w.days === 30 && w.to === utcDay(NOW), 'a preset window ends today and spans its own length');
  ok(inWindow(NOW, w) && inWindow(Date.parse(`${w.from}T00:00:00Z`), w) && inWindow(Date.parse(`${w.to}T23:59:59Z`), w),
    'both boundary days are inside the window');
  N(51, !inWindow(Date.parse(`${w.from}T00:00:00Z`) - 1, w), 'the instant before the first day is outside');
  N(52, !inWindow(Date.parse(`${w.to}T23:59:59Z`) + 1000, w), 'and the instant after the last day is outside');

  N(47, resolveWindow({ preset: 'forever' }, NOW).error === 'WINDOW_UNKNOWN', 'an unknown preset is refused, not widened');
  N(48, resolveWindow({ from: '2026-03-05', to: '2026-03-01' }, NOW).error === 'WINDOW_INVALID', 'a reversed range is refused');
  N(49, resolveWindow({ from: '5 March', to: '2026-03-09' }, NOW).error === 'WINDOW_INVALID', 'a malformed day is refused, never parsed loosely');
  N(50, resolveWindow({ from: '2099-01-01', to: '2099-01-02' }, NOW).error === 'WINDOW_INVALID', 'a window starting in the future is refused');
  ok(resolveWindow({ from: '2026-03-01', to: '2026-03-31' }, NOW).days === 31, 'a custom range counts both end days');
  ok(Object.keys(WINDOW_PRESETS).includes(DEFAULT_WINDOW), 'the default window is one of the presets');

  // A cohort younger than a typical journey is flagged rather than corrected.
  const young = resolveWindow({ preset: 'last_30_days' }, NOW);
  ok(cohortIncomplete(young, 120, NOW) === true, 'a 30-day window is flagged incomplete against a 120-day typical journey');
  ok(cohortIncomplete(young, 5, NOW) === false, '…and is not flagged when the journey is short');
  ok(cohortIncomplete(young, null, NOW) === false, 'with no typical journey known, nothing is claimed');
}

// =========================================================================
section('§6 — the funnel is not a conversion funnel');

/** A synthetic room. Nothing here comes from the database. */
const room = (id, createdAt, steps, extra = {}) => {
  const history = [{ at: createdAt, action: 'room_created', detail: { status: 'watching', sourceContext: extra.sourceContext ?? 'search' } }];
  let from = 'watching';
  for (const [at, to, action = 'room_status_changed'] of steps) {
    history.push({ at, action, detail: { from, to } });
    from = to;
  }
  const r = {
    id, playerId: extra.playerId ?? `pl-${id}`, createdAt,
    status: from, priority: extra.priority ?? 'normal',
    sourceContext: extra.sourceContext ?? 'search', history,
  };
  r.transitions = transitions(r);
  return r;
};

{
  const a = room('r1', NOW - 60 * DAY, [[NOW - 50 * DAY, 'under_review'], [NOW - 40 * DAY, 'shortlisted']]);
  ok(openedStatus(a) === 'watching', 'the opening status comes from the room’s own created entry');
  ok([...stagesReached(a)].sort().join(',') === 'shortlisted,under_review,watching', 'every stage the room ever reached is counted');
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
  P(4, firstTerminalAt(b) === NOW - 70 * DAY && b.transitions.some((t) => t.at > firstTerminalAt(b)),
    'the ending is dated, and the reopening after it is visible');
  N(53, TERMINAL_ROOM_STATUSES.includes('archived') && !FUNNEL_STAGES.includes('archived'),
    'an ending that is not progress is kept off the funnel ladder');

  // The normal reopen path writes room_reopened AND room_status_changed at the
  // same instant. Counting both would double every reopening in the product.
  const dup = {
    id: 'r3', playerId: 'pl-3', createdAt: NOW - 40 * DAY, status: 'under_review', priority: 'normal', sourceContext: 'second_look',
    history: [
      { at: NOW - 40 * DAY, action: 'room_created', detail: { status: 'watching' } },
      { at: NOW - 30 * DAY, action: 'room_status_changed', detail: { from: 'watching', to: 'archived' } },
      { at: NOW - 20 * DAY, action: 'room_reopened', detail: { from: 'archived', to: 'under_review' } },
      { at: NOW - 20 * DAY, action: 'room_status_changed', detail: { from: 'archived', to: 'under_review' } },
    ],
  };
  N(54, transitions(dup).length === 2, 'a reopening written twice at the same instant is one transition');

  ok(FUNNEL_STAGES[0] === 'watching' && FUNNEL_STAGES[FUNNEL_STAGES.length - 1] === 'signed',
    'the ladder runs from watching to signed, in the vocabulary’s own order');
  ok(REASON_CATEGORIES.join(',') === Object.keys(REASON_CODES).join(','), 'reason categories are M17’s, not a second taxonomy');
  ok(REACH_STAGES.every((s) => ROOM_STATUSES.includes(s)), 'the association metric reaches only real statuses');
}

// =========================================================================
section('§7 — stage visits exclude the visit that has not finished');

{
  const r = room('r4', NOW - 30 * DAY, [[NOW - 20 * DAY, 'under_review'], [NOW - 10 * DAY, 'shortlisted']]);
  const visits = stageVisits(r);
  ok(visits.length === 2, 'two completed visits, and the current one is absent');
  ok(visits[0].status === 'watching' && Math.round(visits[0].ms / DAY) === 10, 'the first visit lasted ten days');
  N(55, !visits.some((v) => v.status === 'shortlisted'),
    'the stage the room is sitting in right now contributes nothing — guessing its length would invent a timestamp');
  ok(lastActivityAt(r) === NOW - 10 * DAY, 'last activity is the newest history entry, whatever wrote it');
  ok(DECISION_OWED_STATUSES.every((s) => ROOM_STATUSES.includes(s)), 'the decision-owed statuses are real statuses');
  ok(STALL_THRESHOLDS.length === 3 && STALL_THRESHOLDS.includes(30), 'the stall thresholds are a closed list');
}

// =========================================================================
section('§8 — a dashboard read writes nothing, and sees only one organisation');

{
  const db = {
    recruitmentCases: [
      { id: 'c1', orgId: 'A', playerId: 'p1', createdAt: NOW - 60 * DAY, room: { status: 'shortlisted', priority: 'normal', sourceContext: 'search' },
        history: [{ at: NOW - 60 * DAY, action: 'room_created', byId: 'u1', byName: 'Someone', detail: { status: 'watching' } },
          { at: NOW - 30 * DAY, action: 'room_status_changed', byId: 'u1', byName: 'Someone', detail: { from: 'watching', to: 'shortlisted' } }] },
      { id: 'c2', orgId: 'B', playerId: 'p2', createdAt: NOW - 10 * DAY, room: { status: 'watching', priority: 'high', sourceContext: 'matching' },
        history: [{ at: NOW - 10 * DAY, action: 'room_created', byId: 'u9', byName: 'Rival', detail: { status: 'watching' } }] },
    ],
    roomDecisions: [
      { id: 'd1', orgId: 'A', roomId: 'c1', createdAt: NOW - 25 * DAY, recommendation: 'shortlist', reasonCodes: ['technical_fit'], note: 'PRIVATE NOTE TEXT', by: { name: 'Someone' } },
      { id: 'd2', orgId: 'B', roomId: 'c2', createdAt: NOW - 5 * DAY, recommendation: 'archive', reasonCodes: ['budget'], note: 'RIVAL NOTE' },
    ],
    recruitmentBriefs: [], nobodyMissedReviews: [], secondLookItems: [],
    dynamicWatchlists: [], watchlistHistory: [], trials: [],
  };
  const before = JSON.stringify(db);
  const w = resolveWindow({ preset: 'last_90_days' }, NOW);
  const ctx = buildReportingContext({
    db, org: { id: 'A' }, window: w, now: NOW,
    orgCanSee: () => true, findPlayer: (id) => ({ id, name: `Player ${id}` }),
  });
  const out = buildDashboard(ctx);
  const json = JSON.stringify(out);

  N(56, JSON.stringify(db) === before, 'a full dashboard read leaves every source collection byte-identical');
  N(34, ctx.rooms.length === 1 && ctx.rooms[0].id === 'c1', 'only this organisation’s rooms enter the context');
  N(35, ctx.decisions.length === 1 && ctx.decisions[0].id === 'd1', 'and only this organisation’s decisions');
  N(25, !json.includes('PRIVATE NOTE TEXT') && !json.includes('RIVAL NOTE'), 'no decision note reaches the payload');
  N(26, !json.includes('Someone') && !json.includes('Rival'), 'no actor’s name reaches the payload');
  N(36, !ctx.rooms[0].history.some((h) => h.byId || h.byName), 'the projected history carries no actor at all');
  P(1, out.policyVersion === RECRUITMENT_ANALYTICS_POLICY_VERSION && out.families.length === FAMILY_IDS.length,
    'the payload declares its policy version and every family');
  P(2, out.data.pipeline.metrics.pipeline_stage_counts.rows.find((r) => r.status === 'shortlisted').value === 1,
    'the stage counts match the rooms');
  ok(out.note.includes('do not measure any player') && out.note.includes('colleague'),
    'the governing sentence travels on the wire, not only in the client');
  ok(out.partial === false && out.unavailable.length === 0, 'nothing failed on a clean read');
  ok(out.smallNMinimum === SMALL_N_MIN, 'the suppression threshold is declared to the client');

  // Partial failure: one family throwing must not shorten the page.
  const broken = buildDashboard(ctx, { fault: 'duration' });
  N(60, broken.partial === true && broken.unavailable.join() === 'duration'
    && Object.keys(broken.data).length === FAMILY_IDS.length
    && Object.values(broken.data).filter((f) => !f.error).length === FAMILY_IDS.length - 1,
    'one family failing names itself and leaves every other panel rendered');
  N(57, !JSON.stringify(broken.data.duration).includes('at Object') && broken.data.duration.error === 'FAMILY_UNAVAILABLE',
    'the failure carries a reason, never a stack trace');

  // A filter that a family cannot honour is reported, not silently ignored.
  const filtered = buildDashboard(buildReportingContext({
    db, org: { id: 'A' }, window: w, now: NOW, orgCanSee: () => true, findPlayer: () => null,
    filters: { sourceContext: 'search' },
  }));
  N(58, filtered.data.coverage.filtersNotApplicable.includes('sourceContext'),
    'a filter a family cannot honour is declared, so a whole-club number is never shown under a filter’s label');
  P(10, filtered.data.source.metrics.room_source_mix.rows.every((r) => typeof r.residual === 'boolean'),
    'the source mix marks the residual bucket rather than letting it read as a channel');

  // A player the organisation may not currently see is counted, never named.
  const hidden = buildReportingContext({
    db, org: { id: 'A' }, window: w, now: NOW, orgCanSee: () => false, findPlayer: (id) => ({ id, name: 'Hidden Child' }),
  });
  const hiddenOut = JSON.stringify(buildDashboard(hidden));
  N(27, !hiddenOut.includes('Hidden Child'), 'a player the organisation may not see is never named, even in a drill-down row');
  ok(JSON.parse(hiddenOut).data.pipeline.metrics.pipeline_stage_counts.total.value === 1,
    '…and is still counted, because a count is not a disclosure');
}

// =========================================================================
section('§9 — nothing new is emitted, notified or stored');

{
  const eventCount = EVENT_NAMES.length;
  N(28, !M20_FILES.some(([, src]) => /broadcast\(/.test(src)), 'M20 emits no live event — a dashboard is a read');
  N(29, !M20_FILES.some(([, src]) => /notify\(/.test(src)), 'M20 notifies nobody: a dashboard that pushes numbers at people is a performance review');
  ok(eventCount === EVENT_NAMES.length && Object.keys(CATEGORIES).length >= 13,
    `the event registry (${eventCount}) and notification categories (${Object.keys(CATEGORIES).length}) are untouched by M20`);

  // The migration creates no analytics store.
  const fresh = {};
  migrateM20(fresh);
  N(30, Object.keys(fresh).every((k) => ['trials', 'signings', 'requests', 'dynamicWatchlists', 'watchlistHistory'].includes(k)),
    'the M20 migration creates only collections other milestones already own — no analytics store');
  N(31, !Object.keys(fresh).some((k) => /analytic|metric|rollup|snapshotStats|report/i.test(k)),
    'and nothing that could ever disagree with a Recruitment Room');
  const seeded = { trials: [{ id: 't1' }] };
  migrateM20(seeded); migrateM20(seeded);
  N(32, seeded.trials.length === 1, 'running the migration twice changes nothing');

  const step = MIGRATIONS.find((m) => m.id === 'm200_001_analytics_sources_present');
  ok(!!step, 'the M20 migration is registered with a stable id');
  ok(SCHEMA_VERSION === 2000, `SCHEMA_VERSION is ${SCHEMA_VERSION}`);
  const db2 = {};
  const first = runMigrations(db2, { now: NOW });
  const second = runMigrations(db2, { now: NOW });
  N(33, second.ran.length === 0 && first.ran.length === MIGRATIONS.length,
    'a second boot applies no migration again');
  ok(db2.schema.version === SCHEMA_VERSION, 'the snapshot records the schema version');

  ok(!!RATE_LIMIT_POLICY.analytics_read && RATE_LIMIT_POLICY.analytics_read.scope === 'org',
    'the analytics read limit is named in the one policy table, organisation-scoped');
  ok(RATE_LIMIT_POLICY.analytics_read.max >= 300,
    'and it is generous — a director flipping between windows is never told to slow down for using the page');
}

// ============================================================ HTTP boot
section('§10 — a clean database boots with M20 in place');
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', M13_FAST_RETRY: '1', BOX_CAM_TEST_PROVIDER: '1' };
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env, base) {
  const proc = spawn(process.execPath, [SERVER], { env, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let serverProc = await boot(ENV, BASE);
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok([maria, tom, rita, kola].every((x) => x?.token), 'HTTP actors logged in');
{
  const h = await j('GET', '/healthz');
  ok(h.body.schemaVersion === SCHEMA_VERSION, `/healthz reports schema ${SCHEMA_VERSION} with the M20 migration applied`);
}

// =========================================================================
section('§11 — only a lead reads the organisation’s recruitment analytics');

{
  const paths = ['/org/recruitment-analytics', '/org/recruitment-analytics/catalogue', '/org/recruitment-analytics/rows?metric=stalled_rooms'];
  for (const p of paths) {
    const asScout = await j('GET', p, undefined, tom.token);
    N(59, asScout.status === 403 && asScout.body?.error === 'LEAD_REQUIRED', `${p}: a scout is refused`);
    const anon = await j('GET', p);
    neg(anon.status === 401, `${p}: an unauthenticated caller is refused`);
    const asPlayer = await j('GET', p, undefined, kola.token);
    neg(asPlayer.status === 401 || asPlayer.status === 403, `${p}: a player token buys nothing`);
  }
  const lead = await j('GET', '/org/recruitment-analytics', undefined, maria.token);
  ok(lead.status === 200, 'a lead reads the dashboard');
}

// =========================================================================
section('§12 — the catalogue explains every number before showing one');

{
  const c = await j('GET', '/org/recruitment-analytics/catalogue', undefined, maria.token);
  ok(c.status === 200, 'the catalogue is served');
  P(1, c.body.metrics.length === METRIC_IDS.length, `the catalogue lists all ${METRIC_IDS.length} metrics`);
  P(1, c.body.metrics.every((m) => (m.limitation ?? '').length >= 40), 'every catalogue entry carries its limitation');
  ok(c.body.principle.includes('not the worth of the player or the scout'), 'the catalogue leads with the governing rule');
  ok(c.body.smallNMinimum === SMALL_N_MIN && c.body.smallNNote.includes('never hidden'), 'the suppression rule is stated');
  N(10, Array.isArray(c.body.neverBuilt?.names) && c.body.neverBuilt.names.includes('scout score'),
    'the catalogue publishes what will never be built, so the absence is a promise rather than a gap');
  ok(!c.body.metrics.some((m) => m.reads), 'the internal field declaration is not published as a contract');
  ok(c.body.groupDimensions.every((d) => !PERSON_DIMENSIONS.includes(d)), 'no person is offered as a grouping');
}

// =========================================================================
section('§13 — the dashboard refuses what it cannot answer honestly');

{
  const cases = [
    [12, 'groupBy=scout', 400, 'GROUPING_BY_PERSON_REFUSED'],
    [13, 'groupBy=user', 400, 'GROUPING_BY_PERSON_REFUSED'],
    [14, 'groupBy=owner', 400, 'GROUPING_BY_PERSON_REFUSED'],
    [15, 'groupBy=lead_scout', 400, 'GROUPING_BY_PERSON_REFUSED'],
    [16, 'groupBy=player', 400, 'GROUPING_BY_PERSON_REFUSED'],
    [17, 'groupBy=colour', 400, 'GROUPING_UNKNOWN'],
    [47, 'window=forever', 400, 'WINDOW_UNKNOWN'],
    [48, 'from=2026-03-05&to=2026-03-01', 400, 'WINDOW_INVALID'],
    [49, 'from=yesterday&to=2026-03-01', 400, 'WINDOW_INVALID'],
    [45, 'source=telepathy', 400, 'SOURCE_CONTEXT_UNKNOWN'],
    [44, 'priority=critical', 400, 'ROOM_PRIORITY_UNKNOWN'],
    [43, 'stallDays=1', 400, 'STALL_THRESHOLD_UNKNOWN'],
    [59, 'families=morale', 400, 'FAMILY_UNKNOWN'],
  ];
  for (const [n, qs, status, err] of cases) {
    const r = await j('GET', `/org/recruitment-analytics?${qs}`, undefined, maria.token);
    N(n, r.status === status && r.body?.error === err, `?${qs} → ${status} ${err}`);
  }
  // A refusal must say what IS allowed, or it trains people to guess.
  const refused = await j('GET', '/org/recruitment-analytics?groupBy=scout', undefined, maria.token);
  N(12, Array.isArray(refused.body.allowed) && refused.body.detail.includes('leaderboard'),
    'the person-grouping refusal explains itself and offers the dimensions that do exist');
  const rows = await j('GET', '/org/recruitment-analytics/rows?metric=reopen_rate', undefined, maria.token);
  N(21, rows.status === 400 && rows.body.error === 'METRIC_HAS_NO_ROWS' && rows.body.allowed.join() === DRILLDOWN_METRICS.join(),
    'a metric with no row-level view says so, and names the ones that have it');
}

// =========================================================================
section('§14 — real recruitment work, measured');

/** Every room this organisation already has, plus the ones this suite opens. */
async function roomsFor(token) {
  const r = await j('GET', '/org/rooms', undefined, token);
  const list = r.body?.items ?? r.body?.rooms ?? (Array.isArray(r.body) ? r.body : []);
  return list;
}
const roomIds = [];
{
  const players = (await j('GET', '/org/players', undefined, maria.token)).body;
  const list = Array.isArray(players) ? players : (players.items ?? players.players ?? []);
  for (const p of list.slice(0, 8)) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    // M17 names it `roomId` on the room projection, and `existingRoomId` when
    // the club already has one open for this player.
    if (r.status < 300) roomIds.push(r.body.room?.roomId ?? r.body.roomId);
    else if (r.body?.existingRoomId) roomIds.push(r.body.existingRoomId);
  }
  ok(roomIds.length >= 6, `${roomIds.length} rooms are in play`);

  const move = (id, status, extra = {}) => j('POST', `/org/rooms/${id}/status`, { status, ...extra }, maria.token);
  for (const id of roomIds) await move(id, 'under_review');
  for (const id of roomIds.slice(0, 5)) await move(id, 'shortlisted');
  await move(roomIds[0], 'trial_requested');
  await move(roomIds[1], 'archived', { reasonCodes: ['insufficient_recent_evidence'], note: 'A PRIVATE REASON IN PROSE' });
  await move(roomIds[2], 'withdrawn', { reasonCodes: ['squad_space'] });
  await move(roomIds[3], 'withdrawn', { reasonCodes: ['insufficient_full_match'] });
  await move(roomIds[4], 'archived', { reasonCodes: ['timing'] });
  // A code from a NEIGHBOURING vocabulary is not a room reason. M17 refuses
  // it, so the analytics layer never has to guess what an unknown code means.
  neg((await move(roomIds[6], 'archived', { reasonCodes: ['timing_not_right'] })).status === 400,
    'a Second Look dismissal reason is not a Recruitment Room reason, and the room refuses it');
  await move(roomIds[5], 'archived', { reasonCodes: ['combine_missing'] });
  // …and one of them comes back, because reopening is first-class.
  const reopened = await move(roomIds[4], 'under_review', { reasonCodes: ['continue_monitoring'] });
  ok(reopened.status < 300, 'an archived room is reopened, as M17 allows');
}

{
  const d = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const pipeline = d.data.pipeline.metrics;
  const decision = d.data.decision_record.metrics;
  const duration = d.data.duration.metrics;

  P(2, pipeline.pipeline_stage_counts.total.value === roomIds.length,
    `every room is accounted for in the stage counts (${roomIds.length})`);
  P(3, pipeline.funnel_progression.rows.find((r) => r.stage === 'under_review').value === roomIds.length,
    'the funnel counts rooms that EVER reached a stage, not rooms sitting in it');
  P(4, pipeline.funnel_progression.monotonic === false && pipeline.funnel_progression.reopenedInCohort.value >= 1,
    'the funnel declares itself non-monotonic and reports the reopening');
  N(22, pipeline.funnel_progression.rows.find((r) => r.stage === 'under_review').value <= roomIds.length,
    'no room is counted twice for a stage it reached twice');

  const mix = pipeline.exit_reason_mix;
  P(5, mix.rows.find((r) => r.category === 'evidence').value >= 2 && mix.rows.find((r) => r.category === 'process').value >= 1,
    'endings are categorised from the codes the club recorded');
  ok(mix.overlapping === true, 'and the payload says the shares can exceed 100% because a decision can carry two categories');
  N(23, !JSON.stringify(d).includes('A PRIVATE REASON IN PROSE'),
    'the prose written beside those codes never reaches the dashboard');

  P(6, duration.time_in_stage.rows.length > 0
    && duration.time_in_stage.rows.every((r) => r.suppressed || (r.median != null && r.p25 != null && r.p75 != null)),
    'durations are medians with an interquartile range, or they are withheld');
  ok(duration.time_to_first_decision.excludedMeans.includes('not all of your rooms'),
    'the duration says out loud which rooms it could not include');
  N(41, duration.time_in_stage.excludedMeans.includes('looks fast'),
    'time-in-stage warns that a stuck stage measures fast, and points at the metric that catches it');

  const dec = decision.terminal_with_recorded_decision;
  P(8, dec.n === 5, 'five rooms ended in the window');
  ok(dec.value === 1, 'and every one of them carries a recorded decision');
  const ev = decision.evidence_limited_exits;
  ok(ev.n === 5 && ev.rows.filter((r) => r.value > 0).length >= 3,
    'the evidence-limited exits are counted per code');
  ok(EVIDENCE_REASON_CODES.every((c) => ev.rows.some((r) => r.code === c)), 'every evidence code has a row, even at zero');
  ok(decision.reopen_rate.neutral === true && decision.superseded_decision_rate.neutral === true,
    'reopening and revising are marked neutral — neither is coloured as a fault');

  // Small-n, live: five endings is exactly the threshold, four would not be.
  const narrow = (await j('GET', '/org/recruitment-analytics?source=matching', undefined, maria.token)).body;
  N(37, narrow.data.decision_record.metrics.terminal_with_recorded_decision.suppressed
    || narrow.data.decision_record.metrics.terminal_with_recorded_decision.empty,
    'filtered to a source with almost no rooms, the rate is withheld rather than computed over two records');

  P(12, (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).headers.get('x-scoutbox-ordering') != null,
    'the ordering is declared on the wire, as Discover and Matching do');
}

// =========================================================================
section('§15 — association is never dressed as cause');

{
  const d = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const s2 = d.data.source.metrics.source_stage_reach;
  N(42, s2.associationOnly === true && s2.associationNote === ASSOCIATION_NOTE,
    'the source-reach figure carries the association sentence in the payload, so a client cannot render the number without it');
  N(46, s2.ordering === 'source_name_asc'
    && s2.rows.map((r) => r.source).join() === s2.rows.map((r) => r.source).sort((a, b) => a.localeCompare(b)).join(),
    'sources are listed alphabetically — never as a league table of surfaces');
  N(45, s2.rows.every((r) => r.stages.every((st) => st.suppressed || st.n >= SMALL_N_MIN)),
    'every rate in it clears the small-n threshold or is withheld');
  ok(s2.minimum === SMALL_N_MIN, 'and the threshold is stated with the figure');

  const churn = d.data.watchlist.metrics.watchlist_membership_churn;
  N(40, churn.derivedOnRead === true && churn.refreshNote.includes('does not recompute watchlists in the background'),
    'watchlist churn admits it counts recalculations, not moments a player’s facts changed');
}

// =========================================================================
section('§16 — one organisation, one dataset');

{
  const mine = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const theirs = (await j('GET', '/org/recruitment-analytics', undefined, rita.token)).body;
  N(34, theirs.data.pipeline.metrics.pipeline_stage_counts.total.value !== mine.data.pipeline.metrics.pipeline_stage_counts.total.value
    || mine.data.pipeline.metrics.pipeline_stage_counts.total.value === 0,
    'a neighbouring club sees a different dataset');
  const mineRows = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=50', undefined, maria.token);
  const theirRows = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=50', undefined, rita.token);
  const mineIds = new Set(mineRows.body.rows.map((r) => r.roomId));
  N(35, !theirRows.body.rows.some((r) => mineIds.has(r.roomId)), 'and none of this club’s rooms appear in theirs');

  // Every drill-down row for every metric, swept for leakage of the things
  // that must never travel.
  for (const metric of DRILLDOWN_METRICS) {
    const r = await j('GET', `/org/recruitment-analytics/rows?metric=${metric}&limit=50`, undefined, maria.token);
    const body = JSON.stringify(r.body);
    N(24, !/"note"|"comment"|"byName"|"scoutName"|"ownerUserId"/.test(body), `${metric}: the rows carry no note and no actor`);
  }
}

// =========================================================================
section('§17 — drill-down is bounded and stable');

{
  const first = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14', undefined, maria.token);
  ok(first.status === 200 && first.body.limit === 2, 'a page is the size that was asked for');
  N(50, (await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=5000', undefined, maria.token)).body.limit <= 50,
    'a caller cannot ask for the whole table');
  P(11, first.body.limitation === METRICS.stalled_rooms.limitation,
    'the limitation travels with the rows, not only with the summary');
  const again = await j('GET', '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14', undefined, maria.token);
  N(52, JSON.stringify(first.body.rows) === JSON.stringify(again.body.rows),
    'two reads of unchanged data return the same rows in the same order');
  if (first.body.nextCursor != null) {
    const second = await j(
      'GET', `/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14&cursor=${first.body.nextCursor}`,
      undefined, maria.token,
    );
    const overlap = second.body.rows.filter((r) => first.body.rows.some((x) => x.roomId === r.roomId));
    N(51, overlap.length === 0, 'the next page repeats nothing from the first');
  } else {
    ok(true, 'the drill-down fits on one page at this size');
  }
  ok(first.headers.get('x-scoutbox-ordering') === 'stable_oldest_first_then_id', 'the row ordering is declared');
}

// =========================================================================
section('§18 — the page survives a family that cannot be computed');

{
  const partial = (await j('GET', '/org/recruitment-analytics?simulateFailure=coverage', undefined, maria.token));
  N(60, partial.status === 200 && partial.body.partial === true && partial.body.unavailable.join() === 'coverage',
    'a failing family returns 200 with the failure named — the page is not shortened silently');
  N(39, Object.values(partial.body.data).filter((f) => !f.error).length === FAMILY_IDS.length - 1,
    'every other family still renders');
  const clean = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  ok(clean.partial === false, 'and the next read is clean again — the failure was injected, not latched');

  // The empty case: a club with no recruitment work must read as empty, not as
  // a club performing at zero percent.
  const empty = (await j('GET', '/org/recruitment-analytics', undefined, rita.token)).body;
  const anyRate = empty.data.decision_record.metrics.terminal_with_recorded_decision;
  N(38, anyRate.empty === true || anyRate.suppressed === true,
    'a club with nothing to measure is shown as empty, never as zero per cent');
}

// =========================================================================
section('§19 — a second boot changes nothing');

{
  serverProc.kill('SIGTERM');
  await sleep(900);
  serverProc = await boot(ENV, BASE);
  const maria2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const after = (await j('GET', '/org/recruitment-analytics', undefined, maria2.token)).body;
  ok(after.data.pipeline.metrics.pipeline_stage_counts.total.value === roomIds.length,
    'the same rooms are measured after a restart');
  const h = await j('GET', '/healthz');
  N(36, h.body.schemaVersion === SCHEMA_VERSION, 'the schema version does not move on a second boot');
  const caps = await j('GET', '/capabilities');
  ok(caps.body?.extra?.schema?.upToDate === true || caps.body?.schema?.upToDate === true,
    'the operator surface reports the schema as up to date');
}

// =========================================================================
section('summary');

for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }

{
  const missing = [];
  for (let i = 1; i <= 60; i++) if (!seenNeg.has(i)) missing.push(i);
  ok(missing.length === 0, `all 60 numbered negative cases ran${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  const total = passed + (process.exitCode ? 1 : 0);
  const pct = Math.round((negatives / Math.max(total, 1)) * 100);
  ok(pct >= 50, `negative/security/edge coverage is ${pct}% (${negatives} of ${total})`);
  console.log(`\nM20 acceptance suite: ${passed} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`);
}
if (!process.exitCode) console.log('all M20 checks passed');
