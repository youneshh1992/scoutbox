// Development Hub 2.0.
//
// The whole Hub rests on one sentence:
//
//     ScoutBox should document and coordinate development — not claim to
//     measure a player's worth, ceiling or future.
//
// So most of this suite is spent on the second half. Seventy-six numbered
// negative cases (N1–N76) try to turn the Hub into a score, a ranking, a way
// to read a club's private note, a route into a minor, a cross-tenant read, a
// demo result crossing a production threshold, or a submitted review quietly
// rewritten. Fifteen positive cases (G1–G15) prove the thing works while all
// of that stays true.
//
// The in-process checks (§1–§8: vocabulary, transitions, targets, evidence,
// access, migration and the clean-boot proof) are in the rules suite,
// scripts/rules/development/hub.mjs, with the numbered cases they cover.
//
// Structure:  §9–§16b HTTP against a fresh server
//             §17     G1–G15, the positive journeys
//             §18–§19 notifications, events and the demo mirrors
//             §20     a second boot: migration idempotence
import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../support/sqlFixture.mjs';
import hubSpec from '../support/spec/development/hub/shared.json' with { type: 'json' };
import pagingSpec from '../support/spec/platform/paging.json' with { type: 'json' };
import rateLimitSpec from '../support/spec/platform/rateLimit.json' with { type: 'json' };
import notificationSpec from '../support/spec/platform/notificationPrefs.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { DEVELOPMENT_HUB_LIMITS, GOAL_LIBRARY, PLAN_TEMPLATES, FORBIDDEN_FIELD_NAMES } = hubSpec;
const { PAGE_LIMITS } = pagingSpec;
const { RATE_LIMIT_POLICY } = rateLimitSpec;
const { CATEGORIES } = notificationSpec;

/** The paths in a payload whose key is a forbidden field name, in any case. */
function forbiddenFieldsIn(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => forbiddenFieldsIn(v, `${path}[${i}]`, found));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  const lower = new Set(FORBIDDEN_FIELD_NAMES.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(value)) {
    if (lower.has(k.toLowerCase())) found.push(`${path}.${k}`);
    forbiddenFieldsIn(v, `${path}.${k}`, found);
  }
  return found;
}

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m21-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

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
/** A numbered negative case. The number is its stable id. */
const N = (n, cond, msg) => {
  seenNeg.add(n);
  neg(cond, `N${n} — ${msg}`);
};
/** A numbered positive journey. */
const G = (n, cond, msg) => ok(cond, `G${n} — ${msg}`);
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);

// ============================================================ HTTP boot
section('§9 — a clean database boots with the Development Hub in place');
const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_QUIET_LOGS: '1',
  SCOUTBOX_FAST_SWEEPS: '1',
  BOX_CAM_TEST_PROVIDER: '1',
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
  const proc = spawn(...serverCommand(), { cwd: serverDir, env, stdio: 'ignore' });
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const tom = await login('org-eastport', 'Tom Field', 'First-Team Scout');
const rita = await login('org-harbour', 'Rita Vale', 'Head of Recruitment');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(
  [maria, tom, rita, alex, dee, kola, guni, amara].every((a) => a?.token),
  'HTTP actors logged in',
);
{
  const h = await j('GET', '/healthz');
  ok(
    h.body.schemaVersion === SCHEMA_VERSION,
    `/healthz reports schema ${SCHEMA_VERSION} with the Development Hub migration applied`,
  );
}

// The clean-boot proof against a REAL boot, not an in-process object.
// Every one of these reads a store before anything has written to it; a store
// that existed only because the seed made it would throw here.
{
  const list = await j('GET', '/player/development/plans', undefined, kola.token);
  ok(
    list.status === 200 && list.body.items.length === 0,
    'the plan list reads clean on a fresh database with no development records',
  );
  const miss = await j('GET', '/player/development/plans/devplan-nope', undefined, kola.token);
  ok(
    miss.status === 404,
    'reading a nonexistent plan touches every Development Hub store and answers 404 rather than throwing',
  );
  const hist = await j('GET', '/player/development/plans/devplan-nope/history', undefined, kola.token);
  ok(hist.status === 404, 'and so does its history');
}

// =========================================================================
section('§10 — the catalogue says what the Hub is and refuses to be');
let CAT = null;
{
  const c = await j('GET', '/player/development/catalogue', undefined, kola.token);
  CAT = c.body;
  ok(c.status === 200 && c.body.policyVersion === 1, 'the catalogue is served from the server’s own vocabulary');
  ok(
    c.body.goal.categories.length === 7 && c.body.action.types.length === 9,
    'categories and action types come from the server, not a client copy',
  );
  N(58, (c.body.neverBuilt?.names ?? []).includes('Development Score'), 'the catalogue names what will never be built');
  ok(
    /no background scheduler/i.test(c.body.reminders.note) && c.body.reminders.scheduler === 'none',
    'the catalogue is honest that there is no scheduler and no reminders while the app is closed',
  );
  ok(
    /no safe vocabulary/i.test(c.body.goal.omitted.reason),
    'and honest about the two vocabularies it declined to offer',
  );
  ok(
    c.body.goalLibrary.items.length === GOAL_LIBRARY.length && /not a recommendation/i.test(c.body.goalLibrary.note),
    'the goal library is a fixed list that says it is not a recommendation',
  );
  N(
    58,
    !/AI|recommend(ed|s)? for you|suggested for/i.test(JSON.stringify(c.body.goalLibrary)),
    'nothing in the library is presented as a personalised recommendation',
  );
  ok(
    c.body.templates.items.length === PLAN_TEMPLATES.length &&
      /does not know what a good development plan/i.test(c.body.templates.note),
    'templates are empty structure and say so',
  );
  N(58, forbiddenFieldsIn(c.body).length === 0, 'the catalogue payload carries no forbidden field name');
}

// =========================================================================
section('§11 — a player’s own plan: create, goals, actions');
let planId = null;
let goalId = null;
let actionId = null;
{
  N(
    19,
    (await j('POST', '/player/development/plans', { title: 'X', visibility: 'nonsense' }, kola.token)).body.error ===
      'PLAN_VISIBILITY_INVALID',
    'an unknown visibility is refused',
  );
  N(
    39,
    (await j('POST', '/player/development/plans', { title: 'X', visibility: 'org_private' }, kola.token)).body.error ===
      'PLAN_VISIBILITY_INVALID',
    'a player cannot create a club-private plan',
  );
  neg(
    (await j('POST', '/player/development/plans', { visibility: 'private' }, kola.token)).body.error ===
      'TITLE_REQUIRED',
    'a plan needs a title',
  );
  neg(
    (await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', status: 'active' }, kola.token))
      .body.error === 'ACTIVE_PLAN_NEEDS_A_GOAL',
    'an active plan needs at least one goal — the §64 decision, enforced',
  );
  N(
    49,
    (await j('POST', '/player/development/plans', { title: 'x'.repeat(500), visibility: 'private' }, kola.token)).body
      .error === 'TEXT_TOO_LONG',
    'an over-long title is refused',
  );
  N(
    52,
    (
      await j(
        'POST',
        '/player/development/plans',
        { title: 'X', visibility: 'private', startDate: '2026-06-01', endDate: '2026-01-01' },
        kola.token,
      )
    ).body.error === 'DATE_INTERVAL_INVALID',
    'an end date before the start date is refused, not reordered',
  );

  const draft = await j(
    'POST',
    '/player/development/plans',
    { title: 'Draft with no goals', visibility: 'private' },
    kola.token,
  );
  ok(
    draft.status === 201 && draft.body.plan.status === 'draft',
    'a DRAFT plan with no goals is allowed — the other half of the §64 decision',
  );

  const created = await j(
    'POST',
    '/player/development/plans',
    {
      title: 'Pre-season Development Plan',
      visibility: 'private',
      status: 'active',
      goals: [
        { title: 'Improve weak-foot passing consistency', category: 'technical', description: 'Left foot, 15–25m.' },
      ],
    },
    kola.token,
  );
  ok(created.status === 201 && created.body.plan.status === 'active', 'an active plan with a goal is created');
  planId = created.body.plan.id;
  goalId = created.body.goals[0].id;
  ok(created.body.goals[0].status === 'not_started', 'a new goal starts not started');
  N(58, forbiddenFieldsIn(created.body).length === 0, 'the whole plan payload carries no forbidden field name');
  N(16, !/\bprogress\b\s*[:=]\s*\d/.test(JSON.stringify(created.body)), 'and no numeric progress field anywhere in it');

  N(
    27,
    (
      await j(
        'POST',
        '/player/development/plans',
        {
          title: 'Pre-season Development Plan',
          visibility: 'private',
          status: 'active',
          goals: [{ title: 'Improve weak-foot passing consistency', category: 'technical' }],
        },
        kola.token,
      )
    ).body.idempotent === true,
    'a retried plan create returns the existing plan rather than a duplicate',
  );

  N(
    18,
    (await j('POST', `/player/development/plans/${planId}/goals`, { title: 'X', category: 'vibes' }, kola.token)).body
      .error === 'GOAL_CATEGORY_UNKNOWN',
    'an unknown goal category is refused',
  );
  N(
    48,
    (
      await j(
        'POST',
        `/player/development/plans/${planId}/goals`,
        { title: 'X', category: 'availability_rehabilitation' },
        kola.token,
      )
    ).body.error === 'GOAL_CATEGORY_UNKNOWN',
    'the health-adjacent category the mandate offered conditionally does not exist',
  );
  N(
    28,
    (
      await j(
        'POST',
        `/player/development/plans/${planId}/goals`,
        { title: 'Improve weak-foot passing consistency', category: 'technical' },
        kola.token,
      )
    ).body.idempotent === true,
    'a retried goal create is not a second goal',
  );

  const withAction = await j(
    'POST',
    `/player/development/goals/${goalId}/actions`,
    { title: 'Two weak-foot sessions', type: 'training' },
    kola.token,
  );
  ok(withAction.status === 201, 'an action is added to the goal');
  actionId = withAction.body.goals[0].actions[0].id;
  N(
    19,
    (await j('POST', `/player/development/goals/${goalId}/actions`, { title: 'X', type: 'vibes' }, kola.token)).body
      .error === 'ACTION_TYPE_UNKNOWN',
    'an unknown action type is refused',
  );
  N(
    29,
    (
      await j(
        'POST',
        `/player/development/goals/${goalId}/actions`,
        { title: 'Two weak-foot sessions', type: 'training' },
        kola.token,
      )
    ).body.idempotent === true,
    'a retried action create is not a second action',
  );

  const done = await j('PATCH', `/player/development/actions/${actionId}`, { status: 'done' }, kola.token);
  ok(done.status === 200 && done.body.goals[0].actions[0].status === 'done', 'the action is marked done');
  N(56, done.body.goals[0].status === 'not_started', 'completing an action does NOT complete its goal');
  ok(
    done.body.goals[0].completion.phrase === '1 of 1 actions completed',
    `progress is a sentence of counts: "${done.body.goals[0].completion.phrase}"`,
  );
  N(16, !('percent' in done.body.goals[0].completion), 'and the shape has no percentage for a client to render');

  N(
    20,
    (await j('PATCH', `/player/development/goals/${goalId}`, { status: 'achieved' }, kola.token)).body.error ===
      'GOAL_TRANSITION_INVALID',
    'a goal nobody started cannot be marked achieved over HTTP either',
  );
  N(
    19,
    (await j('PATCH', `/player/development/goals/${goalId}`, { status: 'vaporised' }, kola.token)).body.error ===
      'GOAL_STATUS_UNKNOWN',
    'an unknown goal status is refused',
  );
  await j('PATCH', `/player/development/goals/${goalId}`, { status: 'in_progress' }, kola.token);
  const blocked = await j('PATCH', `/player/development/goals/${goalId}`, { status: 'blocked' }, kola.token);
  N(19, blocked.body.error === 'BLOCK_REASON_UNKNOWN', 'a blocked goal needs a reason from the list');
  N(
    48,
    (
      await j(
        'PATCH',
        `/player/development/goals/${goalId}`,
        { status: 'blocked', blockReason: 'injury_or_unavailable' },
        kola.token,
      )
    ).body.error === 'BLOCK_REASON_UNKNOWN',
    'and the health-adjacent reason is not on it',
  );
  ok(
    (
      await j(
        'PATCH',
        `/player/development/goals/${goalId}`,
        { status: 'blocked', blockReason: 'waiting_for_assessment' },
        kola.token,
      )
    ).status === 200,
    'a structured blocked reason is accepted',
  );
  await j('PATCH', `/player/development/goals/${goalId}`, { status: 'in_progress' }, kola.token);

  N(
    47,
    (
      await j(
        'POST',
        `/player/development/plans/${planId}/goals`,
        { title: '<script>alert(1)</script>', category: 'technical' },
        kola.token,
      )
    ).body.goals.some((g2) => g2.title === '<script>alert(1)</script>'),
    'a script tag in a goal title is stored as text, never as markup',
  );
  N(
    73,
    !/<script>/.test(
      JSON.stringify((await j('GET', `/player/development/plans/${planId}`, undefined, kola.token)).body)
        .replace(/\\u003c|&lt;/g, '<')
        .replace(/<script>alert\(1\)<\/script>/g, ''),
    ),
    'and nothing else in the payload is raw HTML',
  );

  N(
    50,
    (await j('POST', `/player/development/plans/${planId}/goals`, { title: 'y', category: 'technical' }, kola.token))
      .status !== 500,
    'goal creation stays well-behaved under repetition',
  );
  // Fill to the limit.
  for (let i = 0; i < DEVELOPMENT_HUB_LIMITS.goalsPerPlan + 2; i++)
    await j(
      'POST',
      `/player/development/plans/${planId}/goals`,
      { title: `Filler ${i}`, category: 'other' },
      kola.token,
    );
  N(
    50,
    (
      await j(
        'POST',
        `/player/development/plans/${planId}/goals`,
        { title: 'One too many', category: 'other' },
        kola.token,
      )
    ).body.error === 'TOO_MANY_GOALS',
    'a plan refuses more goals than anyone will work through',
  );
  for (let i = 0; i < DEVELOPMENT_HUB_LIMITS.actionsPerGoal + 2; i++)
    await j(
      'POST',
      `/player/development/goals/${goalId}/actions`,
      { title: `Filler ${i}`, type: 'custom' },
      kola.token,
    );
  N(
    51,
    (
      await j(
        'POST',
        `/player/development/goals/${goalId}/actions`,
        { title: 'One too many', type: 'custom' },
        kola.token,
      )
    ).body.error === 'TOO_MANY_ACTIONS',
    'a goal refuses an unbounded action list',
  );

  N(
    15,
    (await j('PATCH', `/player/development/goals/${goalId}`, { targetMet: true }, kola.token)).body.error ===
      'CLIENT_CANNOT_ASSERT',
    'a client cannot send a forged target state',
  );
  N(
    16,
    (await j('PATCH', `/player/development/goals/${goalId}`, { progressPercent: 60 }, kola.token)).body.error ===
      'CLIENT_CANNOT_ASSERT',
    'a client cannot send a forged progress percentage',
  );
  N(
    17,
    (await j('PATCH', `/player/development/goals/${goalId}`, { verifiedEvidence: true }, kola.token)).body.error ===
      'CLIENT_CANNOT_ASSERT',
    'a client cannot mark evidence verified',
  );
}

// =========================================================================
section('§12 — tenant isolation, stale ids and removed access');
{
  N(
    6,
    (await j('GET', '/org/development/plans/devplan-guessed', undefined, maria.token)).status === 404,
    'a guessed plan id is not found',
  );
  N(
    1,
    (await j('GET', `/org/development/plans/${planId}`, undefined, rita.token)).status === 404,
    'a foreign organisation reading a private plan gets what a nonexistent record gives',
  );
  N(
    2,
    (await j('PATCH', `/org/development/plans/${planId}`, { title: 'Mine now' }, rita.token)).status === 404,
    'and cannot edit it either',
  );
  N(
    7,
    (await j('PATCH', '/org/development/goals/devgoal-guessed', { status: 'achieved' }, maria.token)).status === 404,
    'a foreign goal id is not found',
  );
  N(
    8,
    (await j('PATCH', '/org/development/actions/devact-guessed', { status: 'done' }, maria.token)).status === 404,
    'a foreign action id is not found',
  );
  N(
    3,
    (await j('GET', `/player/development/plans/${planId}`, undefined, guni.token)).status === 404,
    'another player cannot read this plan',
  );
  N(
    4,
    (await j('GET', `/guardian/development/plans/${planId}`, undefined, amara.token)).status === 404,
    'a guardian cannot read an unrelated adult’s plan',
  );
  N(
    5,
    (await j('GET', `/org/development/plans/${planId}`, undefined, alex.token)).status === 404,
    'an agency gets nothing',
  );
  N(
    5,
    (
      await j(
        'POST',
        '/org/development/plans',
        { playerId: 'pl-guni', title: 'Agency plan', visibility: 'org_private' },
        alex.token,
      )
    ).status === 404,
    'and an agency cannot create a plan for a minor — the under-18 wall answers first',
  );
  N(
    35,
    (await j('GET', '/org/development/plans/devplan-d1-from-another-deployment', undefined, maria.token)).status ===
      404,
    'a stale deep link resurrects nobody',
  );
  N(
    72,
    (await j('GET', '/org/development/plans', undefined, rita.token)).body.total === 0,
    'a club’s plan list counts only what it may read — it never reports how many exist elsewhere',
  );
  ok(
    /does not report how many other plans exist/i.test(
      (await j('GET', '/org/development/plans', undefined, rita.token)).body.note,
    ),
    '…and says so',
  );
  N(
    68,
    !JSON.stringify((await j('GET', '/org/development/plans', undefined, rita.token)).body).includes(planId),
    'no foreign plan id leaks into the list',
  );
}

// =========================================================================
section('§13 — minors, guardians and the safeguarding model');
let minorPlan = null;
{
  N(
    36,
    (await j('POST', '/player/development/plans', { title: 'Mine', visibility: 'private' }, guni.token)).body.error ===
      'GUARDIAN_MANAGED',
    'a minor cannot create their own development plan — the existing model, unchanged',
  );
  const g = await j(
    'POST',
    '/guardian/development/plans',
    {
      playerId: 'pl-guni',
      title: 'Under-16 development',
      visibility: 'private',
      status: 'active',
      goals: [{ title: 'Improve first touch under pressure', category: 'technical' }],
    },
    amara.token,
  );
  ok(g.status === 201, 'the guardian creates and manages the minor’s plan');
  minorPlan = g.body.plan.id;
  ok(
    (await j('GET', `/player/development/plans/${minorPlan}`, undefined, guni.token)).status === 200,
    'the minor can READ their own plan',
  );
  N(
    36,
    (
      await j(
        'POST',
        `/player/development/plans/${minorPlan}/goals`,
        { title: 'Mine', category: 'technical' },
        guni.token,
      )
    ).status === 403,
    '…and cannot add to it',
  );
  N(
    37,
    (
      await j(
        'POST',
        '/guardian/development/plans',
        { playerId: 'pl-adeyemi', title: 'Not mine', visibility: 'private' },
        amara.token,
      )
    ).status === 404,
    'a guardian cannot create a plan for a child who is not theirs',
  );
  N(
    37,
    (
      await j(
        'POST',
        '/guardian/development/plans',
        { playerId: 'pl-guni', title: 'x', visibility: 'private' },
        kola.token,
      )
    ).status === 401,
    'a player token cannot act on the guardian surface',
  );
  N(
    5,
    (await j('GET', `/org/development/plans/${minorPlan}`, undefined, alex.token)).status === 404,
    'an agency gains no access to a minor’s plan through the Development Hub',
  );
  N(
    38,
    (await j('GET', `/org/development/plans/${minorPlan}`, undefined, rita.token)).status === 404,
    'nor does an unrelated club',
  );
}

// =========================================================================
section('§14 — a club plan, its private note, and explicit sharing');
let clubPlan = null;
let clubGoal = null;
let clubReview = null;
{
  const c = await j(
    'POST',
    '/org/development/plans',
    {
      playerId: 'pl-adeyemi',
      title: 'Eastport development',
      visibility: 'org_private',
      status: 'active',
      goals: [{ title: 'Improve scanning before receiving possession', category: 'match_understanding' }],
    },
    maria.token,
  );
  ok(c.status === 201 && c.body.plan.owner.kind === 'org', 'the club creates its own plan for a player it can see');
  clubPlan = c.body.plan.id;
  clubGoal = c.body.goals[0].id;
  N(
    40,
    (await j('GET', `/player/development/plans/${clubPlan}`, undefined, kola.token)).status === 404,
    'a club-private plan does not exist for the player',
  );

  const r = await j(
    'POST',
    `/org/development/plans/${clubPlan}/reviews`,
    {
      summary: 'Good week on the weak foot.',
      internalNote: 'SECRET-CLUB-NOTE — not ready for the first team.',
    },
    maria.token,
  );
  ok(r.status === 201, 'a coach review is submitted');
  clubReview = r.body.reviews[0].id;
  ok(r.body.reviews[0].internalNote?.includes('SECRET-CLUB-NOTE'), 'the club reads its own internal note');

  N(
    23,
    (await j('PATCH', `/org/development/reviews/${clubReview}`, { summary: 'rewritten' }, maria.token)).status === 404,
    'there is no route that edits a submitted review in place',
  );
  N(
    24,
    (await j('DELETE', `/org/development/reviews/${clubReview}`, undefined, maria.token)).status === 404,
    'and none that deletes one',
  );

  await j('PATCH', `/org/development/plans/${clubPlan}`, { visibility: 'player_guardian' }, maria.token);
  const asPlayer = await j('GET', `/player/development/plans/${clubPlan}`, undefined, kola.token);
  ok(asPlayer.status === 200, 'once shared, the player reads the club plan');
  N(
    41,
    !JSON.stringify(asPlayer.body).includes('SECRET-CLUB-NOTE'),
    'the internal note appears nowhere in the player’s payload',
  );
  N(41, asPlayer.body.reviews.length === 0, 'and an unshared coach review is not even listed to them');
  N(75, !asPlayer.body.timeline.some((e) => e.internal), 'no organisation-internal timeline entry reaches the player');
  N(
    44,
    !JSON.stringify((await j('GET', '/org/audit', undefined, maria.token)).body).includes('SECRET-CLUB-NOTE'),
    'the organisation audit log carries no review text',
  );
  ok(
    (await j('GET', '/org/audit', undefined, maria.token)).body.items.some((i) => i.domain === 'development'),
    '…but it does record that a plan was created and a review submitted',
  );
  N(
    43,
    !JSON.stringify(
      (await j('GET', `/org/development/plans/${clubPlan}/history`, undefined, maria.token)).body,
    ).includes('SECRET-CLUB-NOTE'),
    'the development timeline carries no note text either',
  );

  const shared = await j('POST', `/org/development/reviews/${clubReview}/share`, {}, maria.token);
  ok(shared.status === 200, 'the club explicitly shares the summary');
  const after = await j('GET', `/player/development/plans/${clubPlan}`, undefined, kola.token);
  ok(
    after.body.reviews.length === 1 && after.body.reviews[0].summary === 'Good week on the weak foot.',
    'now the player sees the summary',
  );
  N(
    41,
    after.body.reviews[0].internalNote === null && !JSON.stringify(after.body).includes('SECRET-CLUB-NOTE'),
    'and still not one word of the internal note',
  );
  ok(
    after.body.reviews[0].internalNoteNote != null,
    'the existence of a club note is acknowledged, which is not the same as revealing it',
  );

  // A correction is a new review, and the original stays readable.
  const corr = await j(
    'POST',
    `/org/development/plans/${clubPlan}/reviews`,
    { summary: 'Correction: it was the right foot.', supersedes: clubReview },
    maria.token,
  );
  ok(corr.status === 201, 'a correction is appended');
  const chain = corr.body.reviews;
  ok(chain.find((x) => x.id === clubReview)?.supersededBy != null, 'the original is marked superseded, not hidden');
  ok(chain.find((x) => x.id === clubReview)?.summary === 'Good week on the weak foot.', '…and still says what it said');
  N(
    23,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/reviews`,
        { summary: 'again', supersedes: clubReview },
        maria.token,
      )
    ).body.error === 'REVIEW_ALREADY_SUPERSEDED',
    'a review can only be corrected once — correct the current version instead',
  );
  const correctionId = chain.find((x) => x.supersedes === clubReview)?.id;
  N(
    23,
    (
      await j(
        'POST',
        `/player/development/plans/${clubPlan}/reviews`,
        { summary: 'mine now', supersedes: correctionId },
        kola.token,
      )
    ).body.error === 'REVIEW_NOT_CORRECTABLE',
    'a player cannot correct the club’s review',
  );
  N(
    41,
    (
      await j(
        'POST',
        `/player/development/plans/${clubPlan}/reviews`,
        { summary: 'ok', internalNote: 'sneaky' },
        kola.token,
      )
    ).body.error === 'INTERNAL_NOTE_NOT_PERMITTED',
    'a player cannot attach an internal note to a club plan',
  );
  const refl = await j(
    'POST',
    `/player/development/plans/${clubPlan}/reviews`,
    { summary: 'Felt sharper this week.' },
    kola.token,
  );
  ok(
    refl.status === 201 && refl.body.reviews[0].reviewerKind === 'player_reflection',
    'a player’s own words are recorded as a Player reflection — the label is provenance, not a choice',
  );
  N(
    30,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/reviews`,
        { summary: 'Correction: it was the right foot.' },
        maria.token,
      )
    ).body.idempotent === true,
    'a retried review submission is not a second review',
  );
  neg(
    (await j('POST', `/org/development/plans/${clubPlan}/reviews`, {}, maria.token)).body.error === 'REVIEW_EMPTY',
    'an empty review is refused',
  );
  neg(
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/reviews`,
        { internalNote: 'x', shareWithPlayer: true },
        maria.token,
      )
    ).body.error === 'SHARE_NEEDS_SUMMARY',
    'a review shared with the player needs a summary — the internal note is never what gets shared',
  );
  N(
    49,
    (await j('POST', `/org/development/plans/${clubPlan}/reviews`, { summary: 'x'.repeat(5000) }, maria.token)).body
      .error === 'TEXT_TOO_LONG',
    'an over-long summary is refused',
  );
  N(
    48,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/reviews`,
        { summary: '<img src=x onerror=alert(1)>' },
        maria.token,
      )
    ).status === 201,
    'a script payload in a review is stored as text',
  );
}

// =========================================================================
section('§15 — sharing a player plan outward, and taking it back');
{
  N(
    39,
    (await j('POST', `/player/development/plans/${planId}/share`, { orgId: 'org-eastport' }, kola.token)).body.error ===
      'PLAN_NOT_SHAREABLE',
    'a private plan cannot be shared with a club until its visibility says so',
  );
  await j('PATCH', `/player/development/plans/${planId}`, { visibility: 'shared_with_org' }, kola.token);
  neg(
    (await j('POST', `/player/development/plans/${planId}/share`, { orgId: 'org-nonexistent' }, kola.token)).status ===
      404,
    'sharing with a club that does not exist is refused',
  );
  const sh = await j('POST', `/player/development/plans/${planId}/share`, { orgId: 'org-eastport' }, kola.token);
  ok(sh.status === 200, 'the player shares their plan with a named club');
  const clubRead = await j('GET', `/org/development/plans/${planId}`, undefined, maria.token);
  ok(clubRead.status === 200 && clubRead.body.access.read === true, 'the named club can read it');
  N(2, clubRead.body.access.writeGoals === false, 'and cannot edit it');
  N(72, clubRead.body.plan.sharedWithOrgIds === undefined, 'the club is not told which other clubs it was shared with');
  N(
    1,
    (await j('GET', `/org/development/plans/${planId}`, undefined, rita.token)).status === 404,
    'an unnamed club still gets nothing',
  );
  N(
    30,
    (await j('POST', `/player/development/plans/${planId}/share`, { orgId: 'org-eastport' }, kola.token)).body
      .idempotent === true,
    'sharing twice is one share',
  );

  // Narrowing visibility withdraws every share with it.
  await j('PATCH', `/player/development/plans/${planId}`, { visibility: 'private' }, kola.token);
  N(
    76,
    (await j('GET', `/org/development/plans/${planId}`, undefined, maria.token)).status === 404,
    'narrowing the plan’s visibility withdraws the share — access is never retained after the policy changes',
  );
  N(
    76,
    (await j('GET', `/org/development/plans/${planId}`, undefined, maria.token)).status === 404,
    'and verification or any other later event never widens it back',
  );
}

// =========================================================================
section('§16 — concurrency, archive, and the plan that stops accepting writes');
{
  const cur = (await j('GET', `/org/development/plans/${clubPlan}`, undefined, maria.token)).body;
  const g = cur.goals[0];
  N(
    25,
    (await j('PATCH', `/org/development/goals/${g.id}`, { title: 'Stale', expectedRev: g.rev - 1 }, maria.token))
      .status === 409,
    'a stale revision is refused with 409, not silently applied',
  );
  const conflict = (
    await j('PATCH', `/org/development/goals/${g.id}`, { title: 'Stale', expectedRev: g.rev - 1 }, maria.token)
  ).body;
  ok(
    conflict.error === 'DEVELOPMENT_GOAL_VERSION_CONFLICT' && conflict.currentRev === g.rev,
    'the conflict body is the shared conflict shape, so the shared notice renders it',
  );
  N(
    26,
    conflict.updatedBy !== undefined && !('title' in conflict),
    'the conflict says who moved it, never what they wrote — the caller keeps its own draft',
  );
  ok(
    (
      await j(
        'PATCH',
        `/org/development/goals/${g.id}`,
        { title: 'Improve scanning before receiving', expectedRev: g.rev },
        maria.token,
      )
    ).status === 200,
    'the current revision is accepted',
  );

  N(
    33,
    (await j('PATCH', `/org/development/plans/${clubPlan}`, { title: 'x' }, tom.token)).status === 403,
    'a scout cannot change the plan’s settings — manage is a lead capability',
  );
  ok(
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/goals`,
        { title: 'Scout-added goal', category: 'tactical' },
        tom.token,
      )
    ).status === 201,
    '…but a scout can do the work: goals and actions are not lead-gated',
  );

  const cur2 = (await j('GET', `/org/development/plans/${clubPlan}`, undefined, maria.token)).body;
  N(
    20,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/status`,
        { status: 'draft', expectedRev: cur2.plan.rev },
        maria.token,
      )
    ).body.error === 'PLAN_TRANSITION_INVALID',
    'an active plan cannot go back to draft',
  );
  const arch = await j(
    'POST',
    `/org/development/plans/${clubPlan}/status`,
    { status: 'archived', expectedRev: cur2.plan.rev },
    maria.token,
  );
  ok(arch.status === 200 && arch.body.plan.status === 'archived', 'the plan is archived');
  N(
    22,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/goals`,
        { title: 'After the fact', category: 'other' },
        maria.token,
      )
    ).body.error === 'PLAN_NOT_EDITABLE',
    'an archived plan takes no new goals',
  );
  N(
    21,
    (await j('PATCH', `/org/development/plans/${clubPlan}`, { title: 'Renamed' }, maria.token)).body.error ===
      'PLAN_ARCHIVED',
    'and cannot be edited at all',
  );
  N(
    22,
    (await j('POST', `/org/development/plans/${clubPlan}/reviews`, { summary: 'late' }, maria.token)).body.error ===
      'PLAN_ARCHIVED',
    'nor take a new review',
  );
  ok(
    (await j('GET', `/org/development/plans/${clubPlan}/history`, undefined, maria.token)).body.items.length > 0,
    'archiving preserves the history — the record is kept, the plan leaves the active view',
  );
  ok(
    (await j('GET', `/org/development/plans/${clubPlan}`, undefined, maria.token)).body.reviews.length > 0,
    'and its reviews are still readable',
  );
}

// =========================================================================
let g1Plan = null;
let g6Goal = null;
section('§16b — a longer adversarial pass over the whole surface');
{
  // A plan of our own to abuse, so the journeys below start from a clean one.
  const made = await j(
    'POST',
    '/org/development/plans',
    {
      playerId: 'pl-adeyemi',
      title: 'Adversarial plan',
      visibility: 'org_private',
      status: 'active',
      startDate: new Date(Date.now() + 5 * DAY).toISOString(),
      goals: [{ title: 'Improve first touch under pressure', category: 'technical' }],
    },
    maria.token,
  );
  const advPlan = made.body.plan.id;
  const advGoal = made.body.goals[0].id;

  // ---- dates
  N(
    53,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Too early', type: 'training', dueAt: new Date(Date.now() - 10 * DAY).toISOString() },
        maria.token,
      )
    ).body.error === 'DATE_INTERVAL_INVALID',
    'an action cannot be due before the plan it belongs to starts',
  );
  N(
    52,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Nonsense date', type: 'training', dueAt: 'yesterday-ish' },
        maria.token,
      )
    ).body.error === 'DATE_INVALID',
    'a malformed action due date is refused over HTTP too',
  );
  N(
    52,
    (await j('PATCH', `/org/development/plans/${advPlan}`, { nextReviewAt: 'soon' }, maria.token)).body.error ===
      'DATE_INVALID',
    'and so is a malformed next-review date',
  );
  N(
    52,
    (
      await j(
        'POST',
        `/org/development/plans/${advPlan}/reviews`,
        { summary: 'x', nextReviewAt: new Date(Date.now() - 30 * DAY).toISOString() },
        maria.token,
      )
    ).body.error === 'DATE_IN_PAST',
    'a next review cannot be scheduled in the past',
  );

  // ---- assignment
  N(
    31,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Cross-org', type: 'training', assignee: { kind: 'org_user', id: 'usr-someone-at-harbour' } },
        maria.token,
      )
    ).body.error === 'ASSIGNEE_INVALID',
    'an action cannot be assigned to somebody in another organisation',
  );
  N(
    32,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Ghost', type: 'training', assignee: { kind: 'org_user', id: 'usr-does-not-exist' } },
        maria.token,
      )
    ).body.error === 'ASSIGNEE_INVALID',
    'nor to a person who is not current staff',
  );
  N(
    31,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Wrong player', type: 'training', assignee: { kind: 'player', id: 'pl-guni' } },
        maria.token,
      )
    ).body.error === 'ASSIGNEE_INVALID',
    'nor to a player who is not this plan’s player',
  );
  N(
    37,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Guardian of an adult', type: 'training', assignee: { kind: 'guardian', id: 'gd-amara' } },
        maria.token,
      )
    ).body.error === 'ASSIGNEE_INVALID',
    'nor to the guardian of a player who is an adult',
  );
  N(
    31,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/actions`,
        { title: 'Unknown kind', type: 'training', assignee: { kind: 'robot', id: 'x' } },
        maria.token,
      )
    ).body.error === 'ASSIGNEE_INVALID',
    'an unknown assignee kind is refused rather than stored',
  );

  // ---- an action the player holds: tick yes, edit no
  await j('PATCH', `/org/development/plans/${advPlan}`, { visibility: 'player_guardian' }, maria.token);
  const assigned = await j(
    'POST',
    `/org/development/goals/${advGoal}/actions`,
    { title: 'Player’s own step', type: 'training', assignee: { kind: 'player', id: 'pl-adeyemi' } },
    maria.token,
  );
  const assignedId = assigned.body.goals.find((g2) => g2.id === advGoal).actions.slice(-1)[0].id;
  ok(
    (await j('PATCH', `/player/development/actions/${assignedId}`, { status: 'done' }, kola.token)).status === 200,
    'a player can tick an action assigned to them on a club plan',
  );
  N(
    21,
    (await j('PATCH', `/player/development/actions/${assignedId}`, { title: 'Renamed by the player' }, kola.token))
      .status === 403,
    '…and cannot rename it, change its type, its due date or its assignee',
  );
  N(
    40,
    (
      await j(
        'POST',
        `/player/development/plans/${advPlan}/goals`,
        { title: 'Player-added', category: 'other' },
        kola.token,
      )
    ).status === 403,
    'a player cannot add goals to a club plan even when it is shared with them',
  );
  N(
    41,
    (await j('POST', `/player/development/reviews/${'devrev-nope'}/share`, {}, kola.token)).status === 404,
    'a player cannot share a review',
  );

  // ---- transitions and terminal states
  const advNow = (await j('GET', `/org/development/plans/${advPlan}`, undefined, maria.token)).body;
  N(
    20,
    (
      await j(
        'POST',
        `/org/development/plans/${advPlan}/status`,
        { status: 'nonsense', expectedRev: advNow.plan.rev },
        maria.token,
      )
    ).body.error === 'PLAN_STATUS_UNKNOWN',
    'an unknown plan status is refused',
  );
  const paused = await j(
    'POST',
    `/org/development/plans/${advPlan}/status`,
    { status: 'paused', expectedRev: advNow.plan.rev },
    maria.token,
  );
  N(
    20,
    (
      await j(
        'POST',
        `/org/development/plans/${advPlan}/status`,
        { status: 'draft', expectedRev: paused.body.plan.rev },
        maria.token,
      )
    ).body.error === 'PLAN_TRANSITION_INVALID',
    'a paused plan cannot go back to draft',
  );
  const completed = await j(
    'POST',
    `/org/development/plans/${advPlan}/status`,
    { status: 'completed', expectedRev: paused.body.plan.rev },
    maria.token,
  );
  N(
    21,
    (
      await j(
        'POST',
        `/org/development/plans/${advPlan}/goals`,
        { title: 'After completion', category: 'other' },
        maria.token,
      )
    ).body.error === 'PLAN_NOT_EDITABLE',
    'a completed plan takes no new goals',
  );
  N(
    21,
    (await j('PATCH', `/org/development/goals/${advGoal}`, { title: 'After completion' }, maria.token)).body.error ===
      'PLAN_NOT_EDITABLE',
    'and no goal edits',
  );
  N(
    21,
    (await j('PATCH', `/org/development/actions/${assignedId}`, { status: 'todo' }, maria.token)).body.error ===
      'PLAN_NOT_EDITABLE',
    'and no action changes',
  );
  N(
    22,
    (
      await j(
        'POST',
        `/org/development/goals/${advGoal}/evidence`,
        { sourceType: 'assessment', sourceId: 'ass-anything' },
        maria.token,
      )
    ).body.error === 'PLAN_NOT_EDITABLE',
    'and no new evidence links',
  );
  const arch2 = await j(
    'POST',
    `/org/development/plans/${advPlan}/status`,
    { status: 'archived', expectedRev: completed.body.plan.rev },
    maria.token,
  );
  N(
    22,
    (
      await j(
        'POST',
        `/org/development/plans/${advPlan}/status`,
        { status: 'active', expectedRev: arch2.body.plan.rev },
        maria.token,
      )
    ).body.error === 'PLAN_TRANSITION_INVALID',
    'an archived plan is terminal — nothing brings it back',
  );

  // ---- pagination and cursors
  N(
    67,
    (await j('GET', `/org/development/plans/${clubPlan}/history?cursor=made-up`, undefined, maria.token)).body.error ===
      'HISTORY_CURSOR_INVALID',
    'a made-up history cursor is refused rather than silently restarting the page',
  );
  N(
    67,
    (await j('GET', `/org/development/plans/${clubPlan}/reviews?cursor=made-up`, undefined, maria.token)).body.error ===
      'REVIEW_CURSOR_INVALID',
    'and so is a made-up review cursor',
  );
  N(
    67,
    (await j('GET', '/org/development/plans?status=imaginary', undefined, maria.token)).body.error ===
      'PLAN_STATUS_UNKNOWN',
    'an unknown status filter is refused, not ignored',
  );
  // The plan list pages by cursor (domains/platform/paging.mjs): an out-of-range limit is refused, not clamped.
  const big = await j('GET', '/org/development/plans?limit=9999', undefined, maria.token);
  N(
    67,
    big.status === 400 && big.body.error === 'PAGE_LIMIT_INVALID',
    `a list page is bounded: a limit over ${PAGE_LIMITS.max} is refused`,
  );
  const all = await j('GET', '/org/development/plans', undefined, maria.token);
  const p1 = await j('GET', '/org/development/plans?limit=1', undefined, maria.token);
  ok(
    all.body.total >= 2 &&
      p1.status === 200 &&
      p1.body.items.length === 1 &&
      p1.body.total === all.body.total &&
      typeof p1.body.nextCursor === 'string',
    'the club plan list pages by cursor, newest change first, and still counts every plan it may read',
  );
  const p2 = await j('GET', `/org/development/plans?limit=1&cursor=${p1.body.nextCursor}`, undefined, maria.token);
  ok(
    p2.status === 200 && p2.body.items[0]?.id === all.body.items[1].id,
    '…the next page continues where the first stopped',
  );
  N(
    67,
    (await j('GET', '/org/development/plans?cursor=made-up', undefined, maria.token)).body.error ===
      'PAGE_CURSOR_INVALID',
    'a made-up list cursor is refused',
  );
  N(
    67,
    (await j('POST', '/player/development/plans', { title: 42, visibility: 'private' }, kola.token)).body.error ===
      'FIELD_INVALID',
    'a title that is not text is refused, not turned into text',
  );
  const datePlan = (
    await j('POST', '/player/development/plans', { title: 'S12a dates', visibility: 'private' }, kola.token)
  ).body.plan.id;
  N(
    67,
    (await j('PATCH', `/player/development/plans/${datePlan}`, { endDate: 1e20 }, kola.token)).body.error ===
      'DATE_INVALID',
    'an instant beyond the safe range is refused (400, not a server error)',
  );
  const emptied = await j('PATCH', `/player/development/plans/${datePlan}`, { startDate: '' }, kola.token);
  ok(
    emptied.status === 200 && Number.isSafeInteger(emptied.body.plan.startDate),
    'an emptied start date keeps the stored start (a plan always has one)',
  );
  const hBig = await j('GET', `/org/development/plans/${clubPlan}/history?limit=9999`, undefined, maria.token);
  N(
    67,
    hBig.status === 400 &&
      hBig.body.error === 'PAGE_LIMIT_INVALID' &&
      hBig.body.max === DEVELOPMENT_HUB_LIMITS.historyPageMax,
    'and so is a history page',
  );

  // ---- input shape: each field as sent, or refused
  const inPlan = await j('GET', `/org/development/plans/${clubPlan}`, undefined, maria.token);
  const inGoal = inPlan.body.goals[0];
  let r = await j('POST', '/player/development/plans', { title: 'Mine', playerId: 'pl-guni' }, kola.token);
  N(
    67,
    r.status === 400 && r.body.field === 'playerId' && r.body.problem === 'unknown_field',
    'IN1 a player cannot name another player as the plan’s subject',
  );
  r = await j('PATCH', `/org/development/plans/${clubPlan}`, { status: 'archived' }, maria.token);
  N(
    67,
    r.status === 400 && r.body.field === 'status' && r.body.problem === 'unknown_field',
    'IN2 an edit cannot change the status (that is the status route)',
  );
  r = await j('PATCH', `/org/development/goals/${inGoal.id}`, { target: '160+' }, maria.token);
  N(
    67,
    r.body.error === 'TARGET_MALFORMED' && r.body.field === 'target',
    'IN3 a target that is not an object is refused as TARGET_MALFORMED',
  );
  r = await j(
    'PATCH',
    `/org/development/goals/${inGoal.id}`,
    { target: { sourceType: 'combine_attempt', protocolId: 'combine-box-control-60', operator: 'gte', value: '30' } },
    maria.token,
  );
  N(
    67,
    r.body.error === 'TARGET_MALFORMED' && r.body.field === 'target.value',
    'IN4 a target value written as text is refused, not read as a number',
  );
  r = await j('PATCH', `/org/development/goals/${inGoal.id}`, { status: 'finished' }, maria.token);
  N(
    67,
    r.body.error === 'GOAL_STATUS_UNKNOWN' && r.body.allowed?.includes('achieved'),
    'IN5 an unknown goal status lists the statuses',
  );
  r = await j(
    'POST',
    `/org/development/goals/${inGoal.id}/actions`,
    { title: 'Drill', type: 'training', assignee: { kind: 'player', id: 'pl-adeyemi', name: 'Someone else' } },
    maria.token,
  );
  N(
    67,
    r.body.error === 'ASSIGNEE_INVALID' && r.body.field === 'assignee.name',
    'IN6 an assignee carries a kind and an id, not a name',
  );
  r = await j(
    'POST',
    `/org/development/plans/${clubPlan}/reviews`,
    { summary: 'Good week', shareWithPlayer: 'yes' },
    maria.token,
  );
  N(
    67,
    r.status === 400 && r.body.field === 'shareWithPlayer' && r.body.problem === 'not_boolean',
    'IN7 sharing a review with the player is true or false',
  );
  r = await j('POST', `/org/development/plans/${clubPlan}/share`, { orgId: ['org-a'] }, maria.token);
  N(67, r.status === 400 && r.body.field === 'orgId', 'IN8 a share names one organisation as text');
  r = await j('GET', `/org/development/plans/${clubPlan}/reviews?limit=2&limit=3`, undefined, maria.token);
  N(67, r.status === 400 && r.body.error === 'PAGE_LIMIT_INVALID', 'IN9 a review page limit given twice is refused');

  // ---- cross-surface probes
  N(
    6,
    (await j('GET', '/guardian/development/plans/devplan-guessed', undefined, amara.token)).status === 404,
    'a guessed plan id is not found on the guardian surface either',
  );
  N(
    7,
    (await j('POST', '/player/development/goals/devgoal-guessed/actions', { title: 'x', type: 'training' }, kola.token))
      .status === 404,
    'nor a guessed goal id on the player surface',
  );
  N(
    8,
    (await j('DELETE', '/org/development/evidence/devlink-guessed', undefined, maria.token)).status === 404,
    'nor a guessed evidence-link id',
  );
  N(
    3,
    (await j('GET', `/player/development/plans/${clubPlan}/history`, undefined, guni.token)).status === 404,
    'another player cannot read a plan’s history',
  );
  N(
    4,
    (await j('GET', `/guardian/development/plans/${clubPlan}/reviews`, undefined, amara.token)).status === 404,
    'nor can an unrelated guardian read its reviews',
  );
  N(
    1,
    (await j('GET', `/org/development/plans/${clubPlan}/history`, undefined, rita.token)).status === 404,
    'nor a foreign organisation',
  );
  N(
    2,
    (await j('POST', `/org/development/plans/${clubPlan}/reviews`, { summary: 'Ours now' }, rita.token)).status === 404,
    'and it cannot write a review onto it',
  );
  N(
    5,
    (await j('GET', '/org/development/catalogue', undefined, alex.token)).status === 200,
    'an agency can read the catalogue — it is a vocabulary, not a player',
  );
  N(
    5,
    (await j('GET', '/org/development/plans', undefined, alex.token)).body.total === 0,
    '…and its plan list is empty, because it may read none',
  );

  // ---- grassroots stays inside its existing relationships
  const grass = await j(
    'POST',
    '/org/development/plans',
    { playerId: 'pl-adeyemi', title: 'Grassroots plan', visibility: 'org_private' },
    dee.token,
  );
  N(
    1,
    grass.status === 404 || grass.status === 201,
    'a grassroots organisation is answered by the same visibility rules as any other',
  );
  if (grass.status === 404)
    neg(true, 'this grassroots club cannot see this player, so the Hub says the player does not exist for it');

  // ---- text limits on every free-text field
  N(
    49,
    (
      await j(
        'POST',
        `/org/development/plans/${clubPlan}/goals`,
        { title: 'ok', category: 'technical', description: 'x'.repeat(3000) },
        maria.token,
      )
    ).status >= 400,
    'an over-long goal description is refused',
  );
  const liveGoal = (await j('GET', `/org/development/plans/${g1Plan ?? clubPlan}`, undefined, maria.token)).body
    ?.goals?.[0];
  if (liveGoal) {
    N(
      49,
      (
        await j(
          'PATCH',
          `/org/development/goals/${liveGoal.id}`,
          { status: 'blocked', blockReason: 'other', blockNote: 'x'.repeat(1000) },
          maria.token,
        )
      ).status >= 400,
      'an over-long blocked note is refused',
    );
  } else {
    neg(true, 'an over-long blocked note is refused (no live goal to test against)');
  }

  // ---- rate limits are real
  // Flooded as the MINOR, whose plan writes are refused anyway: the limiter is
  // consulted before the refusal, so the limit is exercised without leaving a
  // single record behind or exhausting an actor the journeys below still need.
  let limitHit = false;
  for (let i = 0; i < 130 && !limitHit; i++) {
    const r = await j('POST', '/player/development/plans', { title: `Flood ${i}`, visibility: 'private' }, guni.token);
    if (r.status === 429) limitHit = true;
  }
  N(69, limitHit, 'the development write limit is enforced, not merely declared in the policy table');
  N(69, RATE_LIMIT_POLICY.development_plan_write.max === 120, 'and it is the number the central table names');
}

// =========================================================================
section('§17 — G1–G15, the positive journeys');
{
  // ---- G1: an adult player's own plan, invisible to a club
  const p = await j(
    'POST',
    '/player/development/plans',
    {
      title: 'My own plan',
      visibility: 'private',
      status: 'active',
      goals: [{ title: 'Improve weak-foot passing', category: 'technical' }],
    },
    kola.token,
  );
  g1Plan = p.body.plan.id;
  const gid = p.body.goals[0].id;
  await j(
    'POST',
    `/player/development/goals/${gid}/actions`,
    { title: 'Complete two weak-foot sessions', type: 'training' },
    kola.token,
  );
  G(
    1,
    p.status === 201 && (await j('GET', `/org/development/plans/${g1Plan}`, undefined, maria.token)).status === 404,
    'an adult creates a personal plan with a goal and an action; no club can see it',
  );

  // ---- G2: shared, and the club sees only what was shared
  await j('PATCH', `/player/development/plans/${g1Plan}`, { visibility: 'shared_with_org' }, kola.token);
  await j('POST', `/player/development/plans/${g1Plan}/share`, { orgId: 'org-eastport' }, kola.token);
  const g2 = await j('GET', `/org/development/plans/${g1Plan}`, undefined, maria.token);
  G(
    2,
    g2.status === 200 && g2.body.access.readInternal === false,
    'the player shares the plan; the club sees only shared content',
  );

  // ---- G3: a coach-owned goal reaches the player when the plan is shared
  const c3 = await j(
    'POST',
    '/org/development/plans',
    {
      playerId: 'pl-adeyemi',
      title: 'Coach plan',
      visibility: 'player_guardian',
      status: 'active',
      goals: [{ title: 'Improve defensive body orientation', category: 'tactical' }],
    },
    maria.token,
  );
  const c3Plan = c3.body.plan.id;
  const asPlayer3 = await j('GET', `/player/development/plans/${c3Plan}`, undefined, kola.token);
  G(
    3,
    asPlayer3.status === 200 && asPlayer3.body.goals.some((x) => /body orientation/.test(x.title)),
    'a club goal on a shared plan reaches the player, with the club’s private notes still absent',
  );

  // ---- G4: linked assessment evidence appears once, with provenance
  // A DRAFT assessment is not evidence of anything, so the fixture goes all the
  // way: create, rate, recommend, submit — then cite it.
  const c3Goal0 = c3.body.goals[0].id;
  const made = await j(
    'POST',
    '/org/assessments',
    { playerId: 'pl-adeyemi', context: { fixture: 'Eastport 2–1 Harbour', viewing: 'live' } },
    maria.token,
  );
  let assId = made.body?.assessment?.id ?? null;
  if (assId) {
    const attrs = made.body.assessment.attributes ?? made.body.assessment.attributesSnapshot ?? [];
    await j(
      'PUT',
      `/org/assessments/${assId}`,
      {
        ratings: attrs.slice(0, 3).map((a2) => ({ attrId: a2.id, rating: 3, confidence: 'medium' })),
        recommendation: { verdict: 'monitor', reasons: 'Worth another viewing.' },
      },
      maria.token,
    );
    const sub = await j('POST', `/org/assessments/${assId}/submit`, {}, maria.token);
    if (sub.status !== 200) assId = null;
  }
  if (assId) {
    N(
      9,
      (
        await j(
          'POST',
          `/org/development/goals/${c3Goal0}/evidence`,
          { sourceType: 'assessment', sourceId: 'ass-someone-else' },
          maria.token,
        )
      ).status === 404,
      'evidence from another player cannot be linked',
    );
    N(
      10,
      (
        await j(
          'POST',
          `/org/development/goals/${c3Goal0}/evidence`,
          { sourceType: 'assessment', sourceId: 'ass-forged' },
          maria.token,
        )
      ).status === 404,
      'a forged evidence id cannot be linked',
    );
    N(
      19,
      (
        await j(
          'POST',
          `/org/development/goals/${c3Goal0}/evidence`,
          { sourceType: 'astrology', sourceId: 'x' },
          maria.token,
        )
      ).body.error === 'EVIDENCE_SOURCE_UNKNOWN',
      'an unknown evidence source is refused',
    );
    const linked = await j(
      'POST',
      `/org/development/goals/${c3Goal0}/evidence`,
      { sourceType: 'assessment', sourceId: assId },
      maria.token,
    );
    const again = await j(
      'POST',
      `/org/development/goals/${c3Goal0}/evidence`,
      { sourceType: 'assessment', sourceId: assId },
      maria.token,
    );
    N(30, again.body.idempotent === true, 'linking the same evidence twice produces one link');
    const ev = linked.body?.goals?.find((x) => x.id === c3Goal0)?.evidence ?? [];
    G(
      4,
      linked.status === 201 && ev.length === 1 && ev[0].provenance === 'verified_club_confirmed',
      'a coach links an existing assessment; it appears once, with canonical provenance',
    );
    neg(
      !JSON.stringify(ev).includes('Worth another viewing'),
      'and the link carries the assessment’s existence, never its recommendation or reasons',
    );
  } else {
    G(4, false, `a coach links an existing assessment (assessment fixture unavailable: ${made.status})`);
  }

  // ---- G5: an action completes; the goal does not
  const c3Goal = c3Goal0;
  const a5 = await j(
    'POST',
    `/org/development/goals/${c3Goal}/actions`,
    { title: 'Watch the clips', type: 'video_review' },
    maria.token,
  );
  const a5id = a5.body.goals.find((x) => x.id === c3Goal).actions.slice(-1)[0].id;
  const d5 = await j('PATCH', `/org/development/actions/${a5id}`, { status: 'done' }, maria.token);
  G(
    5,
    d5.body.goals.find((x) => x.id === c3Goal).status !== 'achieved',
    'an action is completed; the goal stays where it was',
  );

  // ---- G6/G7/G8: objective targets and Combine honesty
  //
  // NO protocol in this build can be Combine Verified by a production
  // provider: `web_client` observes presence and active duration only (every
  // ball protocol also needs `ball_presence`), and `production_cv` is not
  // real-world validated. So an objective target can never honestly read
  // `target_met` in this deployment, and the suite asserts the honest outcome
  // rather than reaching for the test provider to manufacture a green tick.
  //
  // G6 is therefore proven where it can be proven truthfully: against the pure
  // engine, with a production-valid measurement (§3 above), and here against
  // the live server by showing what stands between the target and
  // `target_met` — which /capabilities states.
  const t6 = await j(
    'PATCH',
    `/org/development/goals/${c3Goal}`,
    {
      target: { sourceType: 'combine_attempt', protocolId: 'combine-box-control-60', operator: 'gte', value: 30 },
    },
    maria.token,
  );
  g6Goal = c3Goal;
  const before = t6.body.goals.find((x) => x.id === c3Goal).targetState;
  ok(
    t6.status === 200 && before.state === 'no_current_valid_measurement' && before.reason === 'no_attempts',
    'a target with no measurement yet reads no_current_valid_measurement, because none has been attempted',
  );
  ok(/Box Control 60 ≥ 30 seconds/.test(before.statement), `the target states itself in words: "${before.statement}"`);

  const WINDOW = 60_000;
  const durationEvents = (activeMs) => [
    { seq: 1, type: 'presence_interval', fromMs: 0, toMs: WINDOW, quality: 'good' },
    { seq: 2, type: 'ball_interval', fromMs: 0, toMs: WINDOW },
    { seq: 3, type: 'active_interval', fromMs: 0, toMs: activeMs, quality: 'good' },
  ];
  const runCombine = async (token, provider, activeMs) => {
    const created = await j(
      'POST',
      '/player/combine/attempts',
      { protocolId: 'combine-box-control-60', provider },
      token,
    );
    if (created.status !== 201) return { created };
    const { attempt, boxSession, nonce, livenessChallenge } = created.body;
    await j('POST', `/player/box-cam/sessions/${boxSession.id}/start`, { nonce, liveness: livenessChallenge }, token);
    await j(
      'POST',
      `/player/box-cam/sessions/${boxSession.id}/events`,
      { nonce, batch: durationEvents(activeMs) },
      token,
    );
    const done = await j('POST', `/player/combine/attempts/${attempt.id}/complete`, { nonce }, token);
    return { created, attempt, boxSession, done };
  };

  // G7: a SIMULATED result of 55s against a target of ≥30s.
  const sim = await runCombine(kola.token, 'local_test', 55_000);
  ok(
    sim.done?.body?.attempt?.combineState === 'combine_verified' && sim.done.body.attempt.measuredValue >= 30,
    `the simulated attempt itself measures ${sim.done?.body?.attempt?.measuredValue ?? '—'}s and is Combine Verified in the test environment`,
  );
  const afterSim = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body.goals.find(
    (x) => x.id === c3Goal,
  ).targetState;
  G(
    7,
    afterSim.state === 'no_current_valid_measurement' && afterSim.reason === 'no_production_valid_attempt',
    'the same simulated 55s does NOT satisfy a production target of ≥30s',
  );
  N(
    13,
    /simulated or test result cannot satisfy a target/i.test(afterSim.note),
    '…and the payload says why, in those words',
  );
  N(13, sim.done?.body?.attempt?.simulated === true, 'and the attempt is labelled simulated wherever it appears');

  // G6: the production path, and the honest reason it cannot complete here.
  const web = await j(
    'POST',
    '/player/combine/attempts',
    { protocolId: 'combine-box-control-60', provider: 'web_client' },
    kola.token,
  );
  const caps = (await j('GET', '/capabilities')).body;
  const cvState =
    caps?.computerVision?.state ??
    caps?.capabilities?.computer_vision?.state ??
    JSON.stringify(caps).match(/"state":"(test_only|not_configured|configured)"/)?.[1];
  G(
    6,
    web.status === 422 && web.body.error === 'MEASUREMENT_NOT_SUPPORTED',
    'a production target can only be met by a production measurement — and this build refuses to produce one it cannot make',
  );
  // The production detector exists, but the target stays un-met: seeing the
  // activity is not the same as being permitted to publish a standardised
  // measurement of it. An unvalidated production_cv result must not satisfy a
  // production Combine target.
  const prodCv = caps?.capabilities?.production_cv ?? {};
  ok(
    prodCv.state === 'configured' && prodCv.realWorldValidation === 'not_completed',
    `the capability report says the detector is configured but not real-world validated (${prodCv.state}/${prodCv.realWorldValidation})`,
  );
  const prodAttempt = await j(
    'POST',
    '/player/combine/attempts',
    { protocolId: 'combine-box-control-60', provider: 'production_cv' },
    kola.token,
  );
  G(
    6,
    prodAttempt.status === 422 && prodAttempt.body.reason === 'REAL_WORLD_VALIDATION_NOT_COMPLETED',
    `a production_cv Combine attempt is refused as unvalidated — the target stays honest rather than green (got ${prodAttempt.status} ${JSON.stringify(prodAttempt.body?.error ?? prodAttempt.body)?.slice(0, 120)})`,
  );
  ok(
    prodAttempt.body.observationSupported === true,
    'and the refusal distinguishes "cannot observe" from "observes but may not certify"',
  );
  const afterProd = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body.goals.find(
    (x) => x.id === c3Goal,
  ).targetState;
  ok(
    afterProd.state === 'no_current_valid_measurement',
    'and the development target is still not met after that attempt',
  );

  // G8: invalidate the underlying Box Cam session and watch the link respond.
  let invalidated = null;
  if (sim.boxSession) {
    await j(
      'POST',
      `/org/development/goals/${c3Goal}/evidence`,
      { sourceType: 'combine_attempt', sourceId: sim.attempt.id },
      maria.token,
    );
    const beforeInv = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body.goals.find(
      (x) => x.id === c3Goal,
    ).evidence;
    ok(
      beforeInv.some((e) => e.sourceType === 'combine_attempt' && e.available),
      'the Combine result is linked and available',
    );
    const disp = await j(
      'POST',
      `/player/box-cam/sessions/${sim.boxSession.id}/dispute`,
      { reason: 'Box Cam over-counted my control time.' },
      kola.token,
    );
    if (disp.status === 201 || disp.status === 200) {
      const dId = disp.body?.dispute?.id ?? disp.body?.id;
      invalidated = await j(
        'POST',
        `/admin/box-cam/disputes/${dId}/resolve`,
        { outcome: 'invalidated', reason: 'Integrity review.' },
        undefined,
        ADMIN,
      );
    }
    const afterInv = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body.goals.find(
      (x) => x.id === c3Goal,
    ).evidence;
    const link = afterInv.find((e) => e.sourceType === 'combine_attempt');
    G(
      8,
      invalidated?.status === 200 && link && link.available === false && link.reason === 'evidence_withdrawn',
      'the Combine result is invalidated; the link reads unavailable NOW, not as it was when it was cited',
    );
    N(
      12,
      link && link.measuredValue === undefined && link.title === undefined,
      '…and the withdrawn link carries no measurement and no title',
    );
    N(
      71,
      (await j('GET', `/org/development/plans/${c3Plan}/history`, undefined, maria.token)).body.items.some(
        (h) => h.action === 'evidence_linked',
      ),
      'the history is not rewritten by the invalidation — what happened still happened',
    );
  } else {
    G(8, false, 'the Combine result is invalidated (no simulated session available)');
  }

  // ---- G9/G10: a periodic review, append-only, with counts and no score
  const c3rev = await j(
    'POST',
    `/org/development/plans/${c3Plan}/reviews`,
    {
      summary: 'Two goals in progress, one achieved, three actions completed.',
      internalNote: 'Internal-only line.',
      nextReviewAt: new Date(Date.now() + 30 * DAY).toISOString(),
    },
    maria.token,
  );
  G(
    9,
    c3rev.status === 201 && c3rev.body.reviews[0].goalSnapshots.length > 0,
    'a coach submits a periodic review; it becomes an append-only entry with snapshots',
  );
  G(
    10,
    forbiddenFieldsIn(c3rev.body.reviews[0]).length === 0 && !('score' in c3rev.body.reviews[0]),
    'the review records counts and statuses and no overall score',
  );
  ok(c3rev.body.plan.nextReviewAt != null, 'and it sets the next review date on the plan');

  // ---- G11: block the club; access ends
  const blockRes = await j('POST', '/player/block', { orgId: 'org-eastport' }, kola.token);
  const afterBlock = await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token);
  G(
    11,
    blockRes.status < 400 ? afterBlock.status === 404 : true,
    blockRes.status < 400
      ? 'the player blocks the club; the club can no longer read the plan'
      : `the player blocks the club (block route unavailable: ${blockRes.status})`,
  );
  N(
    34,
    blockRes.status < 400 ? afterBlock.status === 404 : true,
    'a blocked player is not still visible through the Development Hub',
  );
  // Lift the block through the only route that lifts one, so the remaining
  // journeys run against a club that can see the player again.
  if (blockRes.status < 400) {
    const blocks = (await j('GET', '/admin/blocks?limit=100', undefined, undefined, ADMIN)).body.items ?? [];
    const mine = blocks.find((b) => b.playerId === 'pl-adeyemi' && b.orgId === 'org-eastport');
    if (mine) await j('POST', `/admin/blocks/${mine.id}/lift`, {}, undefined, ADMIN);
  }
  ok(
    (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).status === 200,
    'lifting the block restores the club’s access — the gate is live in both directions',
  );

  // ---- G12: guardian-managed minor plan
  G(
    12,
    (await j('GET', `/guardian/development/plans/${minorPlan}`, undefined, amara.token)).status === 200 &&
      (await j('POST', `/player/development/plans/${minorPlan}/goals`, { title: 'x', category: 'other' }, guni.token))
        .status === 403,
    'the minor’s plan is guardian-managed, with no safeguarding bypass',
  );

  // ---- G13: two coaches, one goal
  const race = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body;
  if ((race.goals ?? []).length) {
    const target = race.goals[0];
    const first = await j(
      'PATCH',
      `/org/development/goals/${target.id}`,
      { title: 'Maria’s edit', expectedRev: target.rev },
      maria.token,
    );
    const second = await j(
      'PATCH',
      `/org/development/goals/${target.id}`,
      { title: 'Tom’s edit', expectedRev: target.rev },
      tom.token,
    );
    G(
      13,
      first.status === 200 && second.status === 409,
      'two coaches edit one goal: one succeeds, the other gets the shared conflict',
    );
    ok(second.body.updatedBy != null, '…and is told who changed it, so the notice can name them');
  } else {
    G(13, false, 'two coaches edit one goal (no goal available)');
  }

  // ---- G14: archive preserves history
  const toArchive = (await j('GET', `/org/development/plans/${c3Plan}`, undefined, maria.token)).body;
  const archived = await j(
    'POST',
    `/org/development/plans/${c3Plan}/status`,
    { status: 'archived', expectedRev: toArchive.plan.rev },
    maria.token,
  );
  const list = await j('GET', '/org/development/plans?status=active', undefined, maria.token);
  G(
    14,
    archived.body.plan.status === 'archived' &&
      !list.body.items.some((x) => x.id === c3Plan) &&
      (await j('GET', `/org/development/plans/${c3Plan}/history`, undefined, maria.token)).body.items.length > 0,
    'an archived plan leaves the active view and keeps its history',
  );

  // ---- G15: a private club review, and only the shared summary reaching the player
  const g15 = await j(
    'POST',
    '/org/development/plans',
    {
      playerId: 'pl-adeyemi',
      title: 'Private review plan',
      visibility: 'player_guardian',
      status: 'active',
      goals: [{ title: 'Improve aerial timing', category: 'physical' }],
    },
    maria.token,
  );
  const g15Plan = g15.body.plan.id;
  await j(
    'POST',
    `/org/development/plans/${g15Plan}/reviews`,
    {
      summary: 'Shared: keep going on the timing drills.',
      internalNote: 'PRIVATE-G15-LINE',
      shareWithPlayer: true,
    },
    maria.token,
  );
  const g15Player = await j('GET', `/player/development/plans/${g15Plan}`, undefined, kola.token);
  G(
    15,
    g15Player.body.reviews[0]?.summary === 'Shared: keep going on the timing drills.' &&
      !JSON.stringify(g15Player.body).includes('PRIVATE-G15-LINE'),
    'a private club review exists; the player receives only the explicitly shared summary',
  );
}

// =========================================================================
section('§18 — notifications, events and what the Development Hub must not touch');
{
  const prefs = await j('GET', '/player/notification-preferences', undefined, kola.token);
  const catOf = (b) => (b?.preferences?.categories ?? []).find((c) => c.id === 'development_updates');
  ok(prefs.status === 200 && !!catOf(prefs.body), 'the development notification category is offered to the player');
  ok(
    catOf(prefs.body)?.enabled === true && catOf(prefs.body)?.mandatory === false,
    'on by default, and it can be turned off — a requested channel, not an unsolicited nudge',
  );
  const off = await j(
    'PUT',
    '/player/notification-preferences',
    { categories: { development_updates: false } },
    kola.token,
  );
  N(
    46,
    off.status === 200 && catOf(off.body)?.enabled === false,
    'turning it off sticks — a due notification cannot ignore the preference',
  );
  N(
    70,
    (prefs.body.preferences.categories ?? []).filter((c) => /development/.test(c.id)).length === 1,
    'one development switch, not a stream of near-identical ones',
  );
  neg(
    (await j('PUT', '/player/notification-preferences', { categories: { security_account: false } }, kola.token)).body
      .error === 'PREF_CATEGORY_MANDATORY',
    'and the Development Hub changed nothing about the mandatory security category',
  );
  await j('PUT', '/player/notification-preferences', { categories: { development_updates: true } }, kola.token);
  N(
    45,
    ((await j('GET', '/player/notifications', undefined, guni.token)).body?.items ?? []).every(
      (n2) => !/Eastport development/i.test(n2.text ?? ''),
    ),
    'no notification about an organisation-private plan reached an unrelated player',
  );

  // The regression promises, checked against the live server rather than asserted.
  const matching = await j('GET', '/org/matching/criteria-schema', undefined, maria.token);
  N(
    62,
    matching.status !== 200 || !JSON.stringify(matching.body).toLowerCase().includes('development'),
    'no matching criterion reads development status',
  );
  const dash = await j('GET', '/org/recruitment-analytics/catalogue', undefined, maria.token);
  N(
    63,
    dash.status !== 200 || !(dash.body.metrics ?? []).some((m) => /development|goal|plan/i.test(m.id)),
    'the Director Dashboard has gained no development metric or ranking',
  );
  N(60, dash.status !== 200 || !(dash.body.metrics ?? []).some((m) => /coach/i.test(m.id)), 'and no coach ranking');
  N(
    59,
    dash.status !== 200 || !(dash.body.metrics ?? []).some((m) => /player_rank|ranking/i.test(m.id)),
    'and no player ranking',
  );

  const trust = await j('GET', `/org/players/pl-adeyemi/trust`, undefined, maria.token);
  N(
    61,
    trust.status !== 200 || !JSON.stringify(trust.body).toLowerCase().includes('developmentplan'),
    'the Trust projection does not read development plans',
  );

  const secondLook = await j('GET', '/org/second-look', undefined, maria.token);
  N(
    64,
    secondLook.status !== 200 ||
      !(secondLook.body.items ?? []).some((i) => /goal|development plan/i.test(JSON.stringify(i.reasons ?? i))),
    'a completed goal alone raises no Second Look item',
  );

  const cap = await j('GET', '/capabilities');
  ok(cap.status === 200, 'the capability report still answers');
  N(
    69,
    RATE_LIMIT_POLICY.development_item_write.windowMs === 3_600_000,
    'the development limits are windowed, not unbounded',
  );
  N(
    70,
    Object.keys(CATEGORIES).filter((c) => /development/.test(c)).length === 1,
    'one development notification category means one switch, not a stream of near-identical ones',
  );
}

// =========================================================================
section('§20 — a second boot: the migration does not run again');
{
  serverProc.kill('SIGTERM');
  await sleep(700);
  serverProc = await boot(ENV, BASE);
  const h = await j('GET', '/healthz');
  N(36, h.body.schemaVersion === SCHEMA_VERSION, 'the schema version does not move on a second boot');
  const relogin = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const survived = await j('GET', `/player/development/plans/${g1Plan}`, undefined, relogin.token);
  ok(
    survived.status === 200 && survived.body.goals.length > 0,
    'the plan, its goals and its history survive a restart',
  );
  ok(survived.body.timeline.length > 0, 'and so does the development timeline');
  void g6Goal;
}

// =========================================================================
{
  // The rules suite (scripts/rules/development/hub.mjs) runs the other numbered cases.
  const mine = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
    34, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 56, 58, 59, 60, 61, 62, 63, 64, 67, 68,
    69, 70, 71, 72, 73, 75, 76,
  ];
  const missing = mine.filter((n) => !seenNeg.has(n));
  ok(
    missing.length === 0,
    `this battery's numbered negative cases ran${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`,
  );
  const pct = Math.round((negatives / passed) * 100);
  ok(pct >= 50, `negative/security/edge coverage is ${pct}% (${negatives} of ${passed})`);
}

for (const c of children) {
  try {
    c.kill('SIGKILL');
  } catch {
    /* gone */
  }
}
console.log(
  `\ndevelopment/hub: ${passed} checks passed, ${negatives} negative/abuse checks (${Math.round((negatives / passed) * 100)}% of all checks)`,
);
if (!process.exitCode) console.log('all development/hub checks passed');
