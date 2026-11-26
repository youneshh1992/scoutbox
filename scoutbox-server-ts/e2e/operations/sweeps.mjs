// The scheduled reminders the sweeps send (domains/operations/followUps.mjs, domains/insight/insight.mjs), against a
// real server on a temporary data directory with the synthetic seed. The state is made through the routes, the
// server is stopped, the rows' times are moved into the past with plain SQL, and a second boot finds them due: its
// boot pass, two `/admin/sweep` calls and the fast periodic sweeps all run over them, so "once" is checked too.
//
//   A an application still unanswered after a week reminds the club lead once; a younger one and an answered one
//     send nothing
//   B a trial whose mandatory report is overdue escalates to the club lead once; one with its report filed does not
//   C a trial completed over a week ago with no assessment reminds the club lead once; one with an assessment, or
//     completed recently, does not
//   D a review-later deferral that has come due reminds the scout who deferred once; one still running does not
//   E exposure events older than the 90-day window are deleted; the window's first day and today are kept
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import { DAY_MS, openFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';

const PORT = await freePort();
const API = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutbox-sweeps-'));
const ADMIN = { 'x-admin-key': 'scoutbox-admin' };
const H = 3_600_000;

let passed = 0;
let negatives = 0;
let child = null;
function stop() {
  if (!child) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* gone */
  }
  child = null;
}
function cleanup() {
  stop();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, pathname, body, token, headers = {}) => {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** Throws with the answer when a setup step does not succeed: the battery's checks are about the sweep, not these. */
const must = (r, what) => {
  if (r.status < 200 || r.status > 299) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const at = (ms) => ({ 'x-scoutbox-test-clock': String(ms) });

async function boot(env = {}) {
  child = spawn(...serverCommand(), {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      SCOUTBOX_QUIET_LOGS: '1',
      SCOUTBOX_TEST_CLOCK: '1',
      ...env,
    },
    stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${API}/health`)).ok) return;
    } catch {
      /* booting */
    }
    if (i > 80) throw new Error('server did not boot');
    await sleep(250);
  }
}

// ------------------------------------------------------------------------------------------ the state, made live
await boot();
const orgLogin = async (orgId, scoutName, role) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role })).body;
const maria = await orgLogin('org-eastport', 'Maria Keane', 'Head of Recruitment');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body.token;
ok(!!(maria?.token && kola), 'the seed identities sign in');

// A: three applications by one player; the club answers the third.
const apps = [];
for (const title of ['Sweep trial one', 'Sweep trial two', 'Sweep trial three']) {
  must(
    await j(
      'POST',
      '/org/opportunities',
      { type: 'trial', title, deadline: '2099-06-01', eligibility: { minAge: 16 } },
      maria.token,
    ),
    `opportunity ${title}`,
  );
  const opp = must(await j('GET', '/org/opportunities', undefined, maria.token), 'opportunities').items.find(
    (o) => o.title === title,
  );
  apps.push(
    must(await j('POST', `/player/opportunities/${opp.id}/apply`, { note: 'Sweeps.' }, kola), 'apply').application,
  );
}
must(await j('POST', `/org/applications/${apps[2].id}/outcome`, { decision: 'declined' }, maria.token), 'answer');

// B and C: two trials, both attended and completed under the test clock. The second gets its report and an
// assessment.
const T0 = Date.now();
async function completedTrial(playerId) {
  const token = (await j('POST', '/auth/player/login', { playerId })).body.token;
  const room = await j('POST', '/org/rooms', { playerId, sourceContext: 'search' }, maria.token);
  const RID = room.status === 201 ? room.body.room.roomId : room.body?.existingRoomId;
  const jr = must(await j('GET', `/org/rooms/${RID}/journey`, undefined, maria.token), 'journey');
  if (jr.lifecycle.currentStage === 'watching')
    must(
      await j('POST', `/org/rooms/${RID}/lifecycle`, { action: 'startReview', expectedRev: jr.case.rev }, maria.token),
      'startReview',
    );
  const inv = must(
    await j(
      'POST',
      `/org/rooms/${RID}/trials`,
      {
        timezone: 'Europe/London',
        venue: { name: 'Eastport Dome', town: 'Eastport', address: 'Gate B, Dome Road' },
        message: 'Come and train with the U23s.',
        slots: [{ startsAt: T0 + 2 * H, endsAt: T0 + 4 * H, kind: 'training' }],
      },
      maria.token,
    ),
    'invite',
  );
  const pending = must(await j('GET', '/player/inbox', undefined, token), 'inbox').items.find(
    (r) => r.id === inv.invitation.id,
  );
  const acc = must(
    await j(
      'POST',
      `/player/requests/${inv.invitation.id}/respond`,
      { accept: true, chosenSlot: pending.trialDetails.proposedDate },
      token,
    ),
    'accept',
  );
  const TID = acc.trialId;
  const t = must(await j('GET', `/org/rooms/${RID}/trials/${TID}`, undefined, maria.token), 'trial');
  const trial = t.trial ?? t;
  must(
    await j(
      'POST',
      `/org/rooms/${RID}/trials/${TID}/sessions/${trial.schedule.sessions[0].id}/attendance`,
      { state: 'attended', expectedRev: trial.rev },
      maria.token,
      at(T0 + 3 * H),
    ),
    'attendance',
  );
  must(
    await j(
      'POST',
      `/org/rooms/${RID}/trials/${TID}/complete`,
      { expectedRev: trial.rev + 1 },
      maria.token,
      at(T0 + 5 * H),
    ),
    'complete',
  );
  return TID;
}
const overdue = await completedTrial('pl-adeyemi');
const covered = await completedTrial('pl-osei');
must(
  await j(
    'POST',
    `/org/trials/${covered}/report`,
    {
      acceleration: 7,
      sprintSpeedKmh: 31.2,
      distanceKm: 8.4,
      passCompletionPct: 82,
      duelSuccessPct: 55,
      coachRating: 7,
    },
    maria.token,
  ),
  'report',
);
must(
  await j('POST', '/org/assessments', { playerId: 'pl-osei', context: { trialId: covered } }, maria.token),
  'assessment',
);

// D: two deferrals by Maria.
must(await j('POST', '/org/review-queue/pl-adeyemi/later', { days: 3 }, maria.token), 'defer one');
must(await j('POST', '/org/review-queue/pl-osei/later', { days: 3 }, maria.token), 'defer two');

// E: three impressions today, one per player; two are moved back below.
must(
  await j('POST', '/org/exposure/impressions', { playerIds: ['pl-adeyemi', 'pl-osei', 'pl-carvalho'] }, maria.token),
  'impressions',
);

// --------------------------------------------------------------------------------- moved into the past, offline
stop();
await sleep(300);
const NOW = Date.now();
const TODAY = Math.floor(NOW / DAY_MS);
const F = openFixture(DATA);
const [mariaId, kolaName] = [
  F.sql.prepare("SELECT id FROM org_users WHERE org_id = 'org-eastport' AND name = 'Maria Keane'").get().id,
  F.sql.prepare("SELECT name FROM players WHERE id = 'pl-adeyemi'").get().name,
];
F.transaction(() => {
  const up = (sql, ...args) => F.sql.prepare(sql).run(...args);
  for (const a of [apps[0], apps[2]]) up('UPDATE applications SET created_at = ? WHERE id = ?', NOW - 8 * DAY_MS, a.id);
  up('UPDATE applications SET created_at = ? WHERE id = ?', NOW - 6 * DAY_MS, apps[1].id);
  for (const t of [overdue, covered]) {
    up('UPDATE trials SET report_due_at = ? WHERE id = ?', NOW - H, t);
    up('UPDATE trials SET completion_at = ? WHERE id = ?', NOW - 8 * DAY_MS, t);
  }
  up("UPDATE review_later SET due_at = ? WHERE player_id = 'pl-adeyemi'", NOW - H);
  up("UPDATE exposure_events SET day_index = ?, at = ? WHERE player_id = 'pl-adeyemi'", TODAY - 91, NOW - 91 * DAY_MS);
  up("UPDATE exposure_events SET day_index = ?, at = ? WHERE player_id = 'pl-osei'", TODAY - 90, NOW - 90 * DAY_MS);
});
F.close();

// ------------------------------------------------------------------------- the second boot, and two sweeps more
await boot({ SCOUTBOX_FAST_SWEEPS: '1' });
ok((await j('POST', '/admin/sweep', {}, null, ADMIN)).status === 200, 'the admin sweep runs');
ok((await j('POST', '/admin/sweep', {}, null, ADMIN)).status === 200, 'and runs again');
await sleep(1500); // the periodic sweeps, every half second
const feed = must(await j('GET', '/org/notifications', undefined, maria.token), 'notifications');
const R = readRows(DATA);
const notes = (where) => R.rows('notifications', { audience_kind: 'org_user', ...where });

section('A — the week-old application reminder');
{
  const sent = notes({ type: 'application', ref_id: apps[0].id }).filter((n) => n.text.startsWith('⏳'));
  ok(
    sent.length === 1 &&
      sent[0].audience_id === mariaId &&
      sent[0].text === `⏳ ${kolaName}'s application has waited a week — every applicant gets an answer.`,
    'A1 an application unanswered for a week reminds the club lead, once over every sweep',
  );
  ok(
    feed.some((n) => n.type === 'application' && n.refId === apps[0].id),
    "A2 it is in the lead's notifications",
  );
  const [old, young, answered] = apps.map((a) => R.row('applications', { id: a.id }));
  ok(old.reminded_at >= NOW, 'A3 the application records when it was reminded');
  neg(
    young.reminded_at === null &&
      notes({ type: 'application', ref_id: apps[1].id }).every((n) => !n.text.startsWith('⏳')),
    'A4 an application younger than a week is not reminded',
  );
  neg(
    answered.reminded_at === null &&
      notes({ type: 'application', ref_id: apps[2].id }).every((n) => !n.text.startsWith('⏳')),
    'A5 an answered application is never reminded, however old',
  );
}

section('B — the overdue trial feedback escalation');
{
  const sent = notes({ type: 'trial_day', ref_id: overdue }).filter((n) => n.text.startsWith('🚨'));
  ok(
    sent.length === 1 &&
      sent[0].audience_id === mariaId &&
      sent[0].text ===
        `🚨 Trial feedback for ${kolaName} is overdue — the mandatory report blocks new trials until filed.`,
    'B1 a trial past its report deadline with no report escalates to the club lead, once over every sweep',
  );
  ok(R.row('trials', { id: overdue }).feedback_escalated_at >= NOW, 'B2 the trial records when it was escalated');
  neg(
    R.row('trials', { id: covered }).feedback_escalated_at === null &&
      notes({ type: 'trial_day', ref_id: covered }).every((n) => !n.text.startsWith('🚨')),
    'B3 a trial whose report is filed is not escalated, though its deadline has passed',
  );
}

section('C — the completed-trial assessment reminder');
{
  const text = `No assessment has been recorded for ${kolaName}'s completed trial yet.`;
  const sent = notes({ type: 'trial_day', ref_id: overdue }).filter((n) => n.text === text);
  ok(
    sent.length === 1 && sent[0].audience_id === mariaId,
    'C1 a trial completed over a week ago with no assessment reminds the club lead, once over every sweep',
  );
  const marker = R.rows('trial_reminders', { trial_id: overdue, marker: 'assessmentPending' });
  ok(
    marker.length === 1 && marker[0].sent_at >= NOW,
    'C2 the trial keeps the reminder as its assessmentPending marker',
  );
  neg(
    R.rows('trial_reminders', { trial_id: covered, marker: 'assessmentPending' }).length === 0 &&
      notes({ type: 'trial_day', ref_id: covered }).every((n) => !n.text.startsWith('No assessment')),
    'C3 a completed trial with an assessment in its context is not reminded',
  );
}

section('D — the review-later reminder');
{
  const sent = notes({ type: 'review_queue', ref_id: 'pl-adeyemi' });
  ok(
    sent.length === 1 &&
      sent[0].audience_id === mariaId &&
      sent[0].text === `⏰ Review reminder: you deferred ${kolaName} — they are back in your review queue.`,
    'D1 a deferral that has come due reminds the scout who deferred, once over every sweep',
  );
  ok(R.row('review_later', { player_id: 'pl-adeyemi' }).reminded_at >= NOW, 'D2 the deferral records the reminder');
  neg(
    R.row('review_later', { player_id: 'pl-osei' }).reminded_at === null &&
      notes({ type: 'review_queue', ref_id: 'pl-osei' }).length === 0,
    'D3 a deferral still running is not reminded',
  );
}

section('E — exposure beyond the window is deleted');
{
  const kept = R.rows('exposure_events', { org_id: 'org-eastport', kind: 'impression' }).map((e) => e.player_id);
  neg(!kept.includes('pl-adeyemi'), 'E1 an impression 91 days old is deleted');
  ok(kept.includes('pl-osei'), "E2 one on the window's first day, 90 days back, is kept");
  ok(kept.includes('pl-carvalho'), "E3 and today's is kept");
}
R.close();

console.log(`\n${passed} passed (${negatives} negative)`);
cleanup();
process.exit(0);
