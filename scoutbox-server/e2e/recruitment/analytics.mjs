// Recruitment Analytics and the Director Dashboard.
//
// The whole feature rests on one sentence:
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
// The registry, the pure statistics and a dashboard over plain collections are checked in this process by the
// rules suite (scripts/rules/recruitment/analytics.mjs), which runs the other numbered cases. Here: the migrated
// schema, then HTTP against a fresh server, then a second boot.
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readRows } from '../support/sqlRows.mjs';
import metricsSpec from '../support/spec/recruitment/analytics/metrics.json' with { type: 'json' };
import cohortsSpec from '../support/spec/recruitment/analytics/cohorts.json' with { type: 'json' };
import analyticsSpec from '../support/spec/recruitment/analytics/index.json' with { type: 'json' };
import rateLimitSpec from '../support/spec/platform/rateLimit.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';
import { liveEvents } from '../support/liveEvents.mjs';

const { METRICS, METRIC_IDS, FAMILY_IDS, SMALL_N_MIN, PERSON_DIMENSIONS, ASSOCIATION_NOTE } = metricsSpec;
const { EVIDENCE_REASON_CODES } = cohortsSpec;
const { DRILLDOWN_METRICS } = analyticsSpec;
const { RATE_LIMIT_POLICY } = rateLimitSpec;

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m20-'));
/** The tables of a database and the table migrations it records. */
const schemaOf = (dir) => {
  const R = readRows(dir);
  try {
    return { tables: R.tables(), ledger: R.rows('data_migrations') };
  } finally {
    R.close();
  }
};
// The migrated schema, as a new database gets it.
const FRESH = schemaOf(mkdtempSync(path.join(tmpdir(), 'sbx-m20-schema-')));
const SCHEMA_VERSION = Number(FRESH.ledger.at(-1).id.slice(0, 4)); // the latest table migration's number

let passed = 0;
let negatives = 0;
const seenNeg = new Set();
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (cond, msg) => {
  if (cond) {
    passed++;
    console.log(`✓ ${msg}`);
  } else fail(msg);
};
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
/** A numbered negative case, or one check that proves several. The numbers are stable: the summary checks that all sixty ran. */
const N = (n, cond, msg) => {
  const ns = [n].flat();
  for (const x of ns) seenNeg.add(x);
  neg(cond, `${ns.map((x) => `N${x}`).join(' ')} — ${msg}`);
};
/** A numbered positive case: the feature works, with everything above true. */
const P = (n, cond, msg) => ok(cond, `P${n} — ${msg}`);
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =========================================================================
section('nothing new is stored');

{
  // N30–N33 are claims about the table migrations: N30 and N31 on the migrated schema, N32 and N33 on a second boot.
  N(
    30,
    FRESH.tables.length > 0 && !FRESH.tables.some((t) => /analytic|metric|rollup/i.test(t)),
    'no migration creates an analytics store',
  );
  N(
    31,
    !FRESH.tables.some((t) => /snapshot_?stats/i.test(t)),
    'and nothing that could ever disagree with a Recruitment Room',
  );
  ok(
    !!RATE_LIMIT_POLICY.analytics_read && RATE_LIMIT_POLICY.analytics_read.scope === 'org',
    'the analytics read limit is named in the one policy table, organisation-scoped',
  );
  ok(
    RATE_LIMIT_POLICY.analytics_read.max >= 300,
    'and it is generous — a director flipping between windows is never told to slow down for using the page',
  );
}

// ============================================================ HTTP boot
section('a clean database boots with recruitment analytics in place');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
};
const children = [];
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});
async function boot(env, base) {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env,
    stdio: 'ignore',
  });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let serverProc = await boot(ENV, BASE);
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data, headers: r.headers };
}
const login = async (orgId, scoutName, role, platform) =>
  (
    await j('POST', '/auth/org/login', {
      orgId,
      scoutName,
      role,
      ...(platform ? { platform } : {}),
    })
  ).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
ok(
  [maria, tom, rita, kola].every((x) => x?.token),
  'HTTP actors logged in',
);
{
  const h = await j('GET', '/healthz');
  ok(
    h.body.schemaVersion === SCHEMA_VERSION,
    `/healthz reports schema ${SCHEMA_VERSION} with the analytics migration applied`,
  );
}

// =========================================================================
section('only a lead reads the organisation’s recruitment analytics');

{
  const paths = [
    '/org/recruitment-analytics',
    '/org/recruitment-analytics/catalogue',
    '/org/recruitment-analytics/rows?metric=stalled_rooms',
  ];
  for (const p of paths) {
    const asScout = await j('GET', p, undefined, tom.token);
    N(59, asScout.status === 403 && asScout.body?.error === 'LEAD_REQUIRED', `${p}: a scout is refused`);
    const anon = await j('GET', p);
    neg(anon.status === 401, `${p}: an unauthenticated caller is refused`);
    const asPlayer = await j('GET', p, undefined, kola.token);
    neg(asPlayer.status === 401 || asPlayer.status === 403, `${p}: a player token buys nothing`);
  }
  const told = (await j('GET', '/org/notifications', undefined, maria.token)).body.length;
  const stream = await liveEvents(BASE, j, maria.token);
  const lead = await j('GET', '/org/recruitment-analytics', undefined, maria.token);
  const catalogue = await j('GET', '/org/recruitment-analytics/catalogue', undefined, maria.token);
  const events = await stream.stop();
  ok(lead.status === 200 && catalogue.status === 200, 'a lead reads the dashboard and its catalogue');
  N(
    28,
    events.length === 0,
    `reading the dashboard emits no live event — a dashboard is a read (${events.join(', ') || 'none'})`,
  );
  N(
    29,
    (await j('GET', '/org/notifications', undefined, maria.token)).body.length === told,
    'and notifies nobody: a dashboard that pushes numbers at people is a performance review',
  );
}

// =========================================================================
section('the catalogue explains every number before showing one');

{
  const c = await j('GET', '/org/recruitment-analytics/catalogue', undefined, maria.token);
  ok(c.status === 200, 'the catalogue is served');
  P(1, c.body.metrics.length === METRIC_IDS.length, `the catalogue lists all ${METRIC_IDS.length} metrics`);
  P(
    1,
    c.body.metrics.every((m) => (m.limitation ?? '').length >= 40),
    'every catalogue entry carries its limitation',
  );
  ok(
    c.body.principle.includes('not the worth of the player or the scout'),
    'the catalogue leads with the governing rule',
  );
  ok(
    c.body.smallNMinimum === SMALL_N_MIN && c.body.smallNNote.includes('never hidden'),
    'the suppression rule is stated',
  );
  N(
    10,
    Array.isArray(c.body.neverBuilt?.names) && c.body.neverBuilt.names.includes('scout score'),
    'the catalogue publishes what will never be built, so the absence is a promise rather than a gap',
  );
  ok(!c.body.metrics.some((m) => m.reads), 'the internal field declaration is not published as a contract');
  ok(
    c.body.groupDimensions.every((d) => !PERSON_DIMENSIONS.includes(d)),
    'no person is offered as a grouping',
  );
}

// =========================================================================
section('the dashboard refuses what it cannot answer honestly');

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
  for (const [qs, err, field, problem] of [
    ['window=constructor', 'WINDOW_UNKNOWN', undefined, undefined],
    ['window=__proto__', 'WINDOW_UNKNOWN', undefined, undefined],
    ['window=last_7_days&window=last_30_days', 'FIELD_INVALID', 'window', 'not_text'],
    ['source[x]=search', 'FIELD_INVALID', 'source', 'not_text'],
    ['sort=trustScore', 'FIELD_INVALID', 'sort', 'unknown_field'],
  ]) {
    const r = await j('GET', `/org/recruitment-analytics?${qs}`, undefined, maria.token);
    neg(
      r.status === 400 &&
        r.body?.error === err &&
        (field === undefined || (r.body.field === field && r.body.problem === problem)),
      `?${qs} → 400 ${err}, never a 500 or a silently different query`,
    );
  }
  for (const [qs, err, problem] of [
    ['limit=1.5', 'PAGE_LIMIT_INVALID', 'not_whole_number'],
    ['limit=0', 'PAGE_LIMIT_INVALID', 'too_small'],
    ['cursor=-1', 'PAGE_CURSOR_INVALID', 'not_whole_number'],
    ['cursor=abc', 'PAGE_CURSOR_INVALID', 'not_whole_number'],
  ]) {
    const r = await j('GET', `/org/recruitment-analytics/rows?metric=stalled_rooms&${qs}`, undefined, maria.token);
    neg(
      r.status === 400 && r.body?.error === err && r.body.problem === problem,
      `drill-down ?${qs} → 400 ${err}, not read as the first page`,
    );
  }
  // A refusal must say what IS allowed, or it trains people to guess.
  const refused = await j('GET', '/org/recruitment-analytics?groupBy=scout', undefined, maria.token);
  N(
    12,
    Array.isArray(refused.body.allowed) && refused.body.detail.includes('leaderboard'),
    'the person-grouping refusal explains itself and offers the dimensions that do exist',
  );
  const rows = await j('GET', '/org/recruitment-analytics/rows?metric=reopen_rate', undefined, maria.token);
  N(
    21,
    rows.status === 400 &&
      rows.body.error === 'METRIC_HAS_NO_ROWS' &&
      rows.body.allowed.join() === DRILLDOWN_METRICS.join(),
    'a metric with no row-level view says so, and names the ones that have it',
  );
}

// =========================================================================
section('real recruitment work, measured');

/** Every room this organisation already has, plus the ones this suite opens. */
async function roomsFor(token) {
  const r = await j('GET', '/org/rooms', undefined, token);
  const list = r.body?.items ?? r.body?.rooms ?? (Array.isArray(r.body) ? r.body : []);
  return list;
}
const roomIds = [];
{
  const players = (await j('GET', '/org/players', undefined, maria.token)).body.items;
  const list = Array.isArray(players) ? players : (players.items ?? players.players ?? []);
  for (const p of list.slice(0, 8)) {
    const r = await j('POST', '/org/rooms', { playerId: p.id, sourceContext: 'search' }, maria.token);
    // The room projection names it `roomId`, and the refusal names it `existingRoomId` when
    // the club already has one open for this player.
    if (r.status < 300) roomIds.push(r.body.room?.roomId ?? r.body.roomId);
    else if (r.body?.existingRoomId) roomIds.push(r.body.existingRoomId);
  }
  ok(roomIds.length >= 6, `${roomIds.length} rooms are in play`);

  const move = (id, status, extra = {}) => j('POST', `/org/rooms/${id}/status`, { status, ...extra }, maria.token);
  for (const id of roomIds) await move(id, 'under_review');
  for (const id of roomIds.slice(0, 5)) await move(id, 'shortlisted');
  // `trial_requested` is evidence-gated on a live Trial invitation.
  // The invitation itself advances the case; the explicit move that
  // follows is kept for rooms whose invitation could not be issued (the
  // recipient may be unresolvable for a fixture minor) and is not asserted.
  {
    const H = 3600_000;
    await j(
      'POST',
      `/org/rooms/${roomIds[0]}/trials`,
      {
        timezone: 'Europe/London',
        venue: { name: 'Training Ground', town: 'Eastport' },
        message: 'Come and train with us.',
        slots: [
          {
            startsAt: Date.now() + 72 * H,
            endsAt: Date.now() + 74 * H,
            kind: 'training',
          },
        ],
        clientKey: 'm20-inv-1',
      },
      maria.token,
    );
  }
  await move(roomIds[0], 'trial_requested');
  await move(roomIds[1], 'archived', {
    reasonCodes: ['insufficient_recent_evidence'],
    note: 'A PRIVATE REASON IN PROSE',
  });
  await move(roomIds[2], 'withdrawn', { reasonCodes: ['squad_space'] });
  await move(roomIds[3], 'withdrawn', {
    reasonCodes: ['insufficient_full_match'],
  });
  await move(roomIds[4], 'archived', { reasonCodes: ['timing'] });
  // A code from a NEIGHBOURING vocabulary is not a room reason. The room refuses
  // it, so the analytics layer never has to guess what an unknown code means.
  neg(
    (await move(roomIds[6], 'archived', { reasonCodes: ['timing_not_right'] })).status === 400,
    'a Second Look dismissal reason is not a Recruitment Room reason, and the room refuses it',
  );
  await move(roomIds[5], 'archived', { reasonCodes: ['combine_missing'] });
  // …and one of them comes back, because reopening is first-class.
  const reopened = await move(roomIds[4], 'under_review', {
    reasonCodes: ['continue_monitoring'],
  });
  ok(reopened.status < 300, 'an archived room is reopened, as the Rooms allow');
}

{
  const d = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const { neverBuilt, ...catalogue } = (await j('GET', '/org/recruitment-analytics/catalogue', undefined, maria.token))
    .body;
  const served = JSON.stringify(d) + JSON.stringify(catalogue);
  // What the registry refuses to name is served only in the list that says so (neverBuilt), under no spelling elsewhere.
  for (const name of [
    'recruitment score',
    'scout score',
    'player success score',
    'recruitment efficiency score',
    'talent conversion score',
    'club intelligence score',
  ])
    neg(
      !new RegExp(name.replace(/ /g, '[ _]?'), 'i').test(served),
      `the dashboard and catalogue as served never say "${name}"`,
    );
  ok(neverBuilt.names.length >= 6, 'the catalogue says outright which scores ScoutBox does not compute');
  neg(!served.includes('A PRIVATE REASON IN PROSE'), "the prose of a club's reason, written above, is not served");
  neg(!/Maria Keane/.test(served), 'nor the name of the colleague who did the work');
  const pipeline = d.data.pipeline.metrics;
  const decision = d.data.decision_record.metrics;
  const duration = d.data.duration.metrics;

  P(
    2,
    pipeline.pipeline_stage_counts.total.value === roomIds.length,
    `every room is accounted for in the stage counts (${roomIds.length})`,
  );
  P(
    3,
    pipeline.funnel_progression.rows.find((r) => r.stage === 'under_review').value === roomIds.length,
    'the funnel counts rooms that EVER reached a stage, not rooms sitting in it',
  );
  P(
    4,
    pipeline.funnel_progression.monotonic === false && pipeline.funnel_progression.reopenedInCohort.value >= 1,
    'the funnel declares itself non-monotonic and reports the reopening',
  );
  N(
    22,
    pipeline.funnel_progression.rows.find((r) => r.stage === 'under_review').value <= roomIds.length,
    'no room is counted twice for a stage it reached twice',
  );

  const mix = pipeline.exit_reason_mix;
  P(
    5,
    mix.rows.find((r) => r.category === 'evidence').value >= 2 &&
      mix.rows.find((r) => r.category === 'process').value >= 1,
    'endings are categorised from the codes the club recorded',
  );
  ok(
    mix.overlapping === true,
    'and the payload says the shares can exceed 100% because a decision can carry two categories',
  );
  N(
    23,
    !JSON.stringify(d).includes('A PRIVATE REASON IN PROSE'),
    'the prose written beside those codes never reaches the dashboard',
  );

  P(
    6,
    duration.time_in_stage.rows.length > 0 &&
      duration.time_in_stage.rows.every((r) => r.suppressed || (r.median != null && r.p25 != null && r.p75 != null)),
    'durations are medians with an interquartile range, or they are withheld',
  );
  ok(
    duration.time_to_first_decision.excludedMeans.includes('not all of your rooms'),
    'the duration says out loud which rooms it could not include',
  );
  N(
    41,
    duration.time_in_stage.excludedMeans.includes('looks fast'),
    'time-in-stage warns that a stuck stage measures fast, and points at the metric that catches it',
  );

  const dec = decision.terminal_with_recorded_decision;
  P(8, dec.n === 5, 'five rooms ended in the window');
  ok(dec.value === 1, 'and every one of them carries a recorded decision');
  const ev = decision.evidence_limited_exits;
  ok(ev.n === 5 && ev.rows.filter((r) => r.value > 0).length >= 3, 'the evidence-limited exits are counted per code');
  ok(
    EVIDENCE_REASON_CODES.every((c) => ev.rows.some((r) => r.code === c)),
    'every evidence code has a row, even at zero',
  );
  ok(
    decision.reopen_rate.neutral === true && decision.superseded_decision_rate.neutral === true,
    'reopening and revising are marked neutral — neither is coloured as a fault',
  );

  // Small-n, live: five endings is exactly the threshold, four would not be.
  const narrow = (await j('GET', '/org/recruitment-analytics?source=matching', undefined, maria.token)).body;
  N(
    37,
    narrow.data.decision_record.metrics.terminal_with_recorded_decision.suppressed ||
      narrow.data.decision_record.metrics.terminal_with_recorded_decision.empty,
    'filtered to a source with almost no rooms, the rate is withheld rather than computed over two records',
  );

  P(
    12,
    (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).headers.get('x-scoutbox-ordering') != null,
    'the ordering is declared on the wire, as Discover and Matching do',
  );
}

// =========================================================================
section('association is never dressed as cause');

{
  const d = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const s2 = d.data.source.metrics.source_stage_reach;
  N(
    42,
    s2.associationOnly === true && s2.associationNote === ASSOCIATION_NOTE,
    'the source-reach figure carries the association sentence in the payload, so a client cannot render the number without it',
  );
  N(
    46,
    s2.ordering === 'source_name_asc' &&
      s2.rows.map((r) => r.source).join() ===
        s2.rows
          .map((r) => r.source)
          .sort((a, b) => a.localeCompare(b))
          .join(),
    'sources are listed alphabetically — never as a league table of surfaces',
  );
  N(
    45,
    s2.rows.every((r) => r.stages.every((st) => st.suppressed || st.n >= SMALL_N_MIN)),
    'every rate in it clears the small-n threshold or is withheld',
  );
  ok(s2.minimum === SMALL_N_MIN, 'and the threshold is stated with the figure');

  const churn = d.data.watchlist.metrics.watchlist_membership_churn;
  N(
    40,
    churn.derivedOnRead === true && churn.refreshNote.includes('does not recompute watchlists in the background'),
    'watchlist churn admits it counts recalculations, not moments a player’s facts changed',
  );
}

// =========================================================================
section('one organisation, one dataset');

{
  const mine = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  const theirs = (await j('GET', '/org/recruitment-analytics', undefined, rita.token)).body;
  N(
    34,
    theirs.data.pipeline.metrics.pipeline_stage_counts.total.value !==
      mine.data.pipeline.metrics.pipeline_stage_counts.total.value ||
      mine.data.pipeline.metrics.pipeline_stage_counts.total.value === 0,
    'a neighbouring club sees a different dataset',
  );
  const mineRows = await j(
    'GET',
    '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=50',
    undefined,
    maria.token,
  );
  const theirRows = await j(
    'GET',
    '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=50',
    undefined,
    rita.token,
  );
  const mineIds = new Set(mineRows.body.rows.map((r) => r.roomId));
  N(35, !theirRows.body.rows.some((r) => mineIds.has(r.roomId)), 'and none of this club’s rooms appear in theirs');

  // Every drill-down row for every metric, swept for leakage of the things
  // that must never travel.
  for (const metric of DRILLDOWN_METRICS) {
    const r = await j('GET', `/org/recruitment-analytics/rows?metric=${metric}&limit=50`, undefined, maria.token);
    const body = JSON.stringify(r.body);
    N(
      24,
      !/"note"|"comment"|"byName"|"scoutName"|"ownerUserId"/.test(body),
      `${metric}: the rows carry no note and no actor`,
    );
  }
}

// =========================================================================
section('drill-down is bounded and stable');

{
  const first = await j(
    'GET',
    '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14',
    undefined,
    maria.token,
  );
  ok(first.status === 200 && first.body.limit === 2, 'a page is the size that was asked for');
  const whole = await j(
    'GET',
    '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=5000',
    undefined,
    maria.token,
  );
  N(
    50,
    whole.status === 400 && whole.body.error === 'PAGE_LIMIT_INVALID' && whole.body.max === 50,
    'a caller cannot ask for the whole table: a limit over the page size is refused, with the size',
  );
  P(
    11,
    first.body.limitation === METRICS.stalled_rooms.limitation,
    'the limitation travels with the rows, not only with the summary',
  );
  const again = await j(
    'GET',
    '/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14',
    undefined,
    maria.token,
  );
  N(
    52,
    JSON.stringify(first.body.rows) === JSON.stringify(again.body.rows),
    'two reads of unchanged data return the same rows in the same order',
  );
  if (first.body.nextCursor != null) {
    const second = await j(
      'GET',
      `/org/recruitment-analytics/rows?metric=stalled_rooms&limit=2&stallDays=14&cursor=${first.body.nextCursor}`,
      undefined,
      maria.token,
    );
    const overlap = second.body.rows.filter((r) => first.body.rows.some((x) => x.roomId === r.roomId));
    N(51, overlap.length === 0, 'the next page repeats nothing from the first');
  } else {
    ok(true, 'the drill-down fits on one page at this size');
  }
  ok(first.headers.get('x-scoutbox-ordering') === 'stable_oldest_first_then_id', 'the row ordering is declared');
}

// =========================================================================
section('the page survives a family that cannot be computed');

{
  const partial = await j('GET', '/org/recruitment-analytics?simulateFailure=coverage', undefined, maria.token);
  N(
    60,
    partial.status === 200 && partial.body.partial === true && partial.body.unavailable.join() === 'coverage',
    'a failing family returns 200 with the failure named — the page is not shortened silently',
  );
  N(
    39,
    Object.values(partial.body.data).filter((f) => !f.error).length === FAMILY_IDS.length - 1,
    'every other family still renders',
  );
  const clean = (await j('GET', '/org/recruitment-analytics', undefined, maria.token)).body;
  ok(clean.partial === false, 'and the next read is clean again — the failure was injected, not latched');

  // The empty case: a club with no recruitment work must read as empty, not as
  // a club performing at zero percent.
  const empty = (await j('GET', '/org/recruitment-analytics', undefined, rita.token)).body;
  const anyRate = empty.data.decision_record.metrics.terminal_with_recorded_decision;
  N(
    38,
    anyRate.empty === true || anyRate.suppressed === true,
    'a club with nothing to measure is shown as empty, never as zero per cent',
  );
}

// =========================================================================
section('a second boot changes nothing');

{
  const first = schemaOf(DATA_DIR);
  serverProc.kill('SIGTERM');
  await sleep(900);
  serverProc = await boot(ENV, BASE);
  const second = schemaOf(DATA_DIR);
  N(32, JSON.stringify(second.tables) === JSON.stringify(first.tables), 'booting on the file again changes no table');
  N(
    33,
    JSON.stringify(first.ledger.map((m) => m.id)) === JSON.stringify(FRESH.ledger.map((m) => m.id)) &&
      JSON.stringify(second.ledger) === JSON.stringify(first.ledger),
    'a second boot applies no migration again',
  );
  ok(
    Number(second.ledger.at(-1).id.slice(0, 4)) === SCHEMA_VERSION,
    `the file records schema ${SCHEMA_VERSION} (its latest table migration)`,
  );
  const maria2 = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const after = (await j('GET', '/org/recruitment-analytics', undefined, maria2.token)).body;
  ok(
    after.data.pipeline.metrics.pipeline_stage_counts.total.value === roomIds.length,
    'the same rooms are measured after a restart',
  );
  const h = await j('GET', '/healthz');
  N(36, h.body.schemaVersion === SCHEMA_VERSION, 'the schema version does not move on a second boot');
  const caps = await j('GET', '/capabilities');
  ok(
    caps.body?.extra?.schema?.upToDate === true || caps.body?.schema?.upToDate === true,
    'the operator surface reports the schema as up to date',
  );
}

// =========================================================================
section('summary');

for (const c of children) {
  try {
    c.kill('SIGKILL');
  } catch {
    /* gone */
  }
}

{
  // The rules suite (scripts/rules/recruitment/analytics.mjs) runs the other numbered cases, and N51 (pages
  // never overlap) always; here it runs only when the drill-down has a second page.
  const mine = [
    10, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
    46, 47, 48, 49, 50, 52, 59, 60,
  ];
  const missing = mine.filter((n) => !seenNeg.has(n));
  ok(
    missing.length === 0,
    `this battery's numbered negative cases ran${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
  );
  const total = passed + (process.exitCode ? 1 : 0);
  const pct = Math.round((negatives / Math.max(total, 1)) * 100);
  ok(pct >= 50, `negative/security/edge coverage is ${pct}% (${negatives} of ${total})`);
  console.log(
    `\nrecruitment/analytics: ${passed} checks passed, ${negatives} negative/abuse checks (${pct}% of all checks)`,
  );
}
if (!process.exitCode) console.log('all recruitment/analytics checks passed');
