// Who a live event reaches (domains/platform/liveSync.mjs), against a real server on a temporary data directory with
// the synthetic seed. Streams stay open for the whole battery: two players (an adult, and a minor with her guardian),
// the guardian, and staff of three clubs.
//
//   A the rules: an event naming an `orgId` reaches that club only; one naming a `playerId` (and no `orgId`) reaches
//     the player, their guardian and every club that may see them and isn't blocked; a catalogue ping with neither
//     reaches every stream; the Discovery Ledger's ping follows the subject rule
//   B a removed staff member's open stream is closed
//   C every act that sends a catalogue ping sends it: the player's own record, the guardian's, the club's notes, the
//     grassroots catalogue (open days, looking-for, friendlies), opportunities and campaigns, applications and their
//     outcome, sign-up, erasure, blocks and their lifting, and the Trust & Safety standing of a club
//   D the domain events naming a player (a request in the inbox, its answer, evidence) follow the subject rule
//   E a club development plan's events (created, goals, actions, evidence, reviews, updated, completed) reach the club
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import { liveStream } from '../support/liveEvents.mjs';

const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-live-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };

let passed = 0;
let negatives = 0;
let child = null;
const streams = {};
function cleanup() {
  for (const s of Object.values(streams)) s.stop().catch(() => {});
  if (child) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
}
process.on('exit', cleanup);
const ok = (cond, name) => {
  if (!cond) {
    console.error(`✗ ${name}`);
    cleanup();
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${name}`);
};
const neg = (cond, name) => {
  negatives++;
  ok(cond, `[neg] ${name}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

child = spawn(...serverCommand(), {
  cwd: serverDir,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, SCOUTBOX_QUIET_LOGS: '1' },
  stdio: 'ignore',
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${API}/health`)).ok) break;
  } catch {
    /* booting */
  }
  if (i > 80) throw new Error('server did not boot');
  await sleep(250);
}

const orgLogin = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body.token;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body.token;
const maria = (await orgLogin('org-eastport', 'Maria Keane', 'Head of Recruitment')).token;
const tom = await orgLogin('org-eastport', 'Tom Reid', 'Scout');
const hackney = (await orgLogin('org-hackneymarsh', 'Hackney Coach', 'Head Coach', 'grassroots')).token;
const moss = (await orgLogin('org-mossside', 'Moss Coach', 'Head Coach', 'grassroots')).token;
ok(!!(kola && guni && amara && maria && tom?.token && hackney && moss), 'the seed identities sign in');
for (const [name, token] of Object.entries({ kola, guni, amara, maria, tom: tom.token, hackney, moss }))
  streams[name] = await liveStream(API, j, token);
ok(
  Object.values(streams).every((s) => s.frames().some((f) => f.event === 'connected')),
  'every stream is open and connected',
);

/** Every stream still open. */
const everyone = () => Object.keys(streams).filter((k) => !streams[k].ended());
const matches = (event, playerId) => (f) =>
  f.event === event && (playerId === undefined ? !('playerId' in f) : f.playerId === playerId);
/**
 * Runs `act`, then checks the event reached every stream in `to` and none in `notTo`. A stream in neither is not
 * looked at.
 */
async function delivered(label, act, { event, playerId, to, notTo = [] }) {
  const marks = Object.fromEntries(Object.entries(streams).map(([k, s]) => [k, s.frames().length]));
  const r = await act();
  const got = {};
  for (const k of to) got[k] = !!(await streams[k].waitFor(matches(event, playerId), marks[k]));
  await sleep(150);
  for (const k of notTo) got[k] = streams[k].frames().slice(marks[k]).some(matches(event, playerId));
  const good = r.status >= 200 && r.status < 300 && to.every((k) => got[k]) && notTo.every((k) => !got[k]);
  if (!good)
    console.error(`  ${label}: ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)} got ${JSON.stringify(got)}`);
  ok(good, label);
  return r;
}

section('A — the rules');
await delivered(
  "A1 an adult's ping reaches the player and the clubs that see them, never another player or guardian",
  () => j('POST', '/player/availability', { availability: 'loan_open' }, kola),
  { event: 'players', playerId: 'pl-adeyemi', to: ['kola', 'maria', 'moss'], notTo: ['guni', 'amara'] },
);
await delivered(
  "A2 a minor's ping reaches her, her guardian and the clubs that may see minors, not the unverified club behind the under-18 wall",
  () => j('POST', '/guardian/children/pl-guni/availability', { availability: 'available_now' }, amara),
  { event: 'players', playerId: 'pl-guni', to: ['guni', 'amara', 'hackney', 'maria'], notTo: ['kola', 'moss'] },
);
await delivered(
  'A3 a catalogue ping with no subject reaches every stream',
  () =>
    j(
      'POST',
      '/org/opportunities',
      { type: 'trial', title: 'Live delivery trial', deadline: '2099-06-01', eligibility: { minAge: 16 } },
      maria,
    ),
  { event: 'opportunities', to: everyone() },
);
const contact = await delivered(
  "A4 the Discovery Ledger's ping follows the subject rule: the player and the clubs that see them",
  () => j('POST', '/org/players/pl-adeyemi/request', { type: 'contact', message: 'Live delivery hello.' }, maria),
  { event: 'ledger', playerId: 'pl-adeyemi', to: ['kola', 'maria', 'moss'], notTo: ['guni', 'amara'] },
);
ok(
  streams.kola.frames().some((f) => f.event === 'ledger' && f.type === 'contact_request' && !('orgId' in f)),
  "A5 the ledger ping carries the row's type and never the club",
);
await delivered(
  'A6 an event naming its club reaches that club only',
  () =>
    j(
      'POST',
      '/org/watchlists',
      {
        name: 'Live delivery list',
        mode: 'snapshot',
        criteria: { required: [{ type: 'position', operator: 'in', values: ['CDM'] }] },
      },
      maria,
    ),
  { event: 'watchlist_created', to: ['maria', 'tom'], notTo: ['kola', 'guni', 'amara', 'hackney', 'moss'] },
);
await delivered(
  'A7 a block takes the blocked club off the subject rule at once',
  () => j('POST', '/player/block', { orgId: 'org-mossside', reason: 'Live delivery test.' }, kola),
  { event: 'players', to: everyone() },
);
await delivered(
  "A8 the blocked club no longer receives the player's pings; the others still do",
  () => j('POST', '/player/availability', { availability: 'available_now' }, kola),
  { event: 'players', playerId: 'pl-adeyemi', to: ['kola', 'maria'], notTo: ['moss', 'guni'] },
);

section('B — removal closes the stream');
neg(!streams.tom.ended(), 'B1 the scout’s stream is open before the removal');
const removed = await j('POST', `/org/staff/${tom.userId}/remove`, {}, maria);
ok(removed.status === 200 && (await streams.tom.waitForEnd()), 'B2 removing the scout closes their open stream');
ok(!streams.maria.ended(), "B3 the lead's own stream stays open");

section('C — every act that pings');
const KOLA = { event: 'players', playerId: 'pl-adeyemi', to: ['kola', 'maria'], notTo: ['guni', 'amara'] };
const GUNI = { event: 'players', playerId: 'pl-guni', to: ['guni', 'amara'], notTo: ['kola', 'moss'] };
await delivered('C1 Academy+', () => j('POST', '/player/academyplus', { enabled: true }, kola), KOLA);
await delivered('C2 badges', () => j('POST', '/player/badges', { badges: ['Finisher'] }, kola), KOLA);
await delivered('C3 a clip', () => j('POST', '/player/media', { title: 'Live delivery clip' }, kola), KOLA);
await delivered('C4 medical sharing', () => j('POST', '/player/medical/share', { shared: true }, kola), KOLA);
await delivered(
  'C5 a medical record',
  () => j('POST', '/player/medical/records', { title: 'Knock', date: '2026-01-10' }, kola),
  KOLA,
);
await delivered('C6 location', () => j('POST', '/player/location', { lat: 51.5, lng: -0.1 }, kola), KOLA);
await delivered(
  'C7 verified attendance',
  () =>
    j(
      'POST',
      '/player/attendance',
      {
        fixture: 'Live delivery cup',
        venue: 'Hackney Marshes',
        date: '2026-01-10',
        gps: { lat: 51.5, lng: -0.1 },
        deviceId: 'd-1',
      },
      kola,
    ),
  KOLA,
);
await delivered(
  'C8 the timeline',
  () => j('POST', '/player/timeline', { year: '2026', event: 'Live delivery milestone' }, kola),
  KOLA,
);
await delivered(
  'C9 stats',
  () => j('POST', '/player/stats', { appearances: 20, goals: 9, assists: 3, season: '2022/23' }, kola),
  KOLA,
);
await delivered(
  'C10 a drill result',
  () => j('POST', '/player/drills/drill-first-touch/complete', { value: 12 }, kola),
  KOLA,
);
await delivered('C11 a programme', () => j('POST', '/player/programme', { track: 'attack' }, kola), KOLA);
await delivered(
  "C12 a programme's session",
  () => j('POST', '/player/programme/sessions/atk-sprint/complete', undefined, kola),
  KOLA,
);
await delivered(
  'C13 the first-team seeker',
  () => j('POST', '/player/first-team-seeker', { enabled: true }, kola),
  KOLA,
);
await delivered(
  "C14 a club's note on the player",
  () => j('POST', '/org/players/pl-adeyemi/notes', { text: 'Live delivery note.' }, maria),
  KOLA,
);
await delivered(
  "C15 the guardian shares a child's medical record",
  () => j('POST', '/guardian/children/pl-guni/medical/share', { shared: true }, amara),
  GUNI,
);
await delivered(
  'C16 the guardian adds a child',
  () => j('POST', '/guardian/children', { name: 'Live Child', dob: '2014-03-01', country: 'GB' }, amara),
  { event: 'players', to: everyone() },
);
const signup = await delivered(
  'C17 a sign-up',
  () =>
    j('POST', '/auth/player/signup', {
      name: 'Live Adult',
      dob: '2000-01-01',
      country: 'GB',
      password: 'synthetic-pass-1',
      position: 'CM',
    }),
  { event: 'players', to: everyone() },
);
await delivered('C18 an erasure', () => j('DELETE', '/player/account', undefined, signup.body.token), {
  event: 'players',
  to: everyone(),
});
await delivered(
  'C19 a grassroots registration',
  () =>
    j('POST', '/auth/org/register-grassroots', {
      name: 'Live Delivery FC',
      country: 'GB',
      city: 'London',
      lat: 51.56,
      lng: -0.005,
      federation: 'The FA (England)',
      registrationId: 'FA-GR-7788',
      scoutName: 'Lee Live',
      role: 'Manager',
    }),
  { event: 'orgs', to: everyone() },
);
const freshOrg = (await j('GET', '/orgs/directory')).body.items.find((o) => o.name === 'Live Delivery FC');
await delivered(
  "C20 a club's looking-for positions",
  () => j('POST', '/org/looking-for', { positions: ['ST'] }, moss),
  { event: 'orgs', to: everyone() },
);
const openDay = await delivered(
  'C21 an open day',
  () =>
    j(
      'POST',
      '/org/open-trials',
      { title: 'Live open day', date: '2099-05-01', venue: 'Moss Side Rec', ageGroup: 'open', positions: ['ST'] },
      moss,
    ),
  { event: 'openTrials', to: everyone() },
);
await delivered(
  'C22 an open day removed',
  () => j('DELETE', `/org/open-trials/${openDay.body.openTrial.id}`, undefined, moss),
  { event: 'openTrials', to: everyone() },
);
await delivered(
  'C23 a friendly',
  () => j('POST', '/org/friendlies', { date: '2099-05-02', venue: 'Moss Side Rec', ageGroup: 'U16' }, moss),
  { event: 'friendlies', to: everyone() },
);
await delivered(
  'C24 a campaign',
  () =>
    j(
      'POST',
      '/org/campaigns',
      {
        title: 'Live sprint assessment',
        deadline: '2099-06-01',
        attemptsAllowed: 1,
        drills: [{ name: '30m sprint', instructions: 'Two cones 30m apart.', recording: { camera: 'Side-on' } }],
      },
      maria,
    ),
  { event: 'campaigns', to: everyone() },
);
const opportunity = (await j('GET', '/org/opportunities', undefined, maria)).body.items.find(
  (o) => o.title === 'Live delivery trial',
);
const applied = await delivered(
  "C25 an application reaches the applicant and the clubs that see them (the subject rule, not the registry's org_private)",
  () => j('POST', `/player/opportunities/${opportunity.id}/apply`, { note: 'Live delivery.' }, kola),
  { event: 'applications', playerId: 'pl-adeyemi', to: ['kola', 'maria'], notTo: ['guni', 'amara'] },
);
await delivered(
  "C26 an application's outcome",
  () => j('POST', `/org/applications/${applied.body.application.id}/outcome`, { decision: 'declined' }, maria),
  { event: 'applications', playerId: 'pl-adeyemi', to: ['kola', 'maria'], notTo: ['guni', 'amara'] },
);
const blocks = (await j('GET', '/admin/blocks', undefined, null, ADMIN)).body.items;
const kolaMoss = blocks.find((b) => b.playerId === 'pl-adeyemi' && b.orgId === 'org-mossside');
await delivered(
  'C27 Trust & Safety lifts a block',
  () => j('POST', `/admin/blocks/${kolaMoss.id}/lift`, {}, null, ADMIN),
  { event: 'players', to: everyone() },
);
await delivered(
  'C28 the guardian blocks a club',
  () => j('POST', '/guardian/block', { orgId: 'org-harbour', playerId: 'pl-guni', reason: 'Live delivery.' }, amara),
  { event: 'players', to: everyone() },
);
await delivered(
  'C29 an urgent report naming a club suspends it pending review',
  () =>
    j(
      'POST',
      '/player/report',
      {
        targetKind: 'club',
        targetOrgId: 'org-harbour',
        reason: 'Live delivery: asked to move to WhatsApp',
        urgent: true,
      },
      kola,
    ),
  { event: 'players', to: everyone() },
);
await delivered(
  "C30 Trust & Safety sets a club's standing",
  () => j('POST', `/admin/clubs/${freshOrg.id}/verification`, { verified: true }, null, ADMIN),
  { event: 'players', to: everyone() },
);

section('D — the domain events naming a player');
const SUBJECT = (event) => ({ event, playerId: 'pl-adeyemi', to: ['kola', 'maria'], notTo: ['guni', 'amara'] });
await delivered(
  "D1 a request reaches the player's inbox, by the subject rule",
  () =>
    j(
      'POST',
      '/org/players/pl-adeyemi/request',
      { type: 'trial', message: 'Live delivery trial day.', proposedDate: '2099-07-01', venue: 'Eastport Dome' },
      maria,
    ),
  SUBJECT('inbox'),
);
await delivered(
  "D2 the player's answer to a request",
  () => j('POST', `/player/requests/${contact.body.requestId}/respond`, { accept: true }, kola),
  SUBJECT('requests'),
);
const claim = await delivered(
  'D3 a claim the player files',
  () => j('POST', '/player/evidence', { claimType: 'statistic', label: 'Live goals', value: 3, units: 'goals' }, kola),
  SUBJECT('evidence'),
);
await delivered(
  'D4 a club corroborates it',
  () => j('POST', `/org/evidence/${claim.body.evidence.id}/corroborate`, {}, maria),
  SUBJECT('evidence'),
);
const claim2 = await j(
  'POST',
  '/player/evidence',
  { claimType: 'statistic', label: 'Live assists', value: 2, units: 'assists' },
  kola,
);
await delivered(
  'D5 the player corrects one',
  () =>
    j(
      'POST',
      `/player/evidence/${claim2.body.evidence.id}/correct`,
      { value: 1, reason: 'one was a deflection' },
      kola,
    ),
  SUBJECT('evidence'),
);

section("E — a club plan's events reach that club only");
const CLUB = (event) => ({ event, to: ['maria'], notTo: ['kola', 'guni', 'amara', 'hackney', 'moss'] });
const plan = await delivered(
  'E1 a club creates a development plan',
  () =>
    j(
      'POST',
      '/org/development/plans',
      {
        playerId: 'pl-adeyemi',
        title: 'Live delivery plan',
        visibility: 'org_private',
        status: 'active',
        goals: [{ title: 'Scan before receiving', category: 'match_understanding' }],
      },
      maria,
    ),
  CLUB('development_plan_created'),
);
const planId = plan.body.plan.id;
const goal = await delivered(
  'E2 a goal is added',
  () => j('POST', `/org/development/plans/${planId}/goals`, { title: 'Weak foot', category: 'technical' }, maria),
  CLUB('development_goal_created'),
);
const goalId = goal.body.goals.find((g) => g.title === 'Weak foot').id;
await delivered(
  'E3 a goal is updated',
  () => j('PATCH', `/org/development/goals/${goalId}`, { status: 'in_progress' }, maria),
  CLUB('development_goal_updated'),
);
const withAction = await j(
  'POST',
  `/org/development/goals/${goalId}/actions`,
  { title: 'Watch the clips', type: 'video_review' },
  maria,
);
const actionId = withAction.body.goals.find((g) => g.id === goalId).actions.slice(-1)[0].id;
await delivered(
  'E4 an action is completed',
  () => j('PATCH', `/org/development/actions/${actionId}`, { status: 'done' }, maria),
  CLUB('development_action_completed'),
);
await delivered(
  "E5 the player's evidence is linked to a goal",
  () =>
    j(
      'POST',
      `/org/development/goals/${goalId}/evidence`,
      { sourceType: 'passport_evidence', sourceId: claim.body.evidence.id },
      maria,
    ),
  CLUB('development_evidence_linked'),
);
await delivered(
  'E6 a coach review is submitted',
  () => j('POST', `/org/development/plans/${planId}/reviews`, { summary: 'Good week.' }, maria),
  CLUB('development_review_submitted'),
);
const updated = await delivered(
  'E7 the plan is updated',
  () => j('PATCH', `/org/development/plans/${planId}`, { title: 'Live delivery plan, revised' }, maria),
  CLUB('development_plan_updated'),
);
await delivered(
  'E8 the plan is completed',
  () =>
    j(
      'POST',
      `/org/development/plans/${planId}/status`,
      { status: 'completed', expectedRev: updated.body.plan.rev },
      maria,
    ),
  CLUB('development_plan_completed'),
);

console.log(`\nplatform/liveDelivery: ${passed} checks passed, ${negatives} negative, 0 failed`);
cleanup();
process.exit(0);
