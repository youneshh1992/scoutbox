// Football Passport battery: full HTTP journeys with the abuse catalogue. Every
// safeguarding wall, privacy narrowing rule, share re-gate and ownership boundary
// is negative-tested, and well over a third of the checks are negative/abuse
// cases (the suite counts them). The pure engine's checks are in
// scripts/rules/passport/passport.mjs.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';
import passportSpec from '../support/spec/passport/shared.json' with { type: 'json' };

const PORT = await freePort();
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m15-'));

let passed = 0;
let negatives = 0;
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
// neg() — a negative/abuse-case check: something is REFUSED, hidden or inert.
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  SCOUTBOX_FAST_SWEEPS: '1',
  SCOUTBOX_QUIET_LOGS: '1',
  TEST_LICENCE_REGISTRY: '1',
  AGENT_VERIFICATION_TEST_PROVIDER: '1',
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
{
  const proc = spawn(...serverCommand(), { cwd: serverDir, env: ENV, stdio: 'ignore' });
  children.push(proc);
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      up = r.ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
}
async function j(method, url, body, token, extraHeaders = {}) {
  const r = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
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
const A = { 'x-admin-key': 'scoutbox-admin' };
async function mailWith(to, re) {
  const r = await j('GET', '/admin/outbox', undefined, null, A);
  const mail = (r.body?.items ?? []).find((m) => m.to === to);
  return mail ? ((mail.text.match(re) ?? [])[1] ?? null) : null;
}

// ====================================================== HTTP scenarios
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
const sam = await login('org-eastport', 'Sam Cole', 'Coach');
const alex = await login('org-northstar', 'Alex Agent', 'Agent');
const ruth = await login('org-harbour', 'Ruth Vane', 'Scout');
const dee = await login('org-hackneymarsh', 'Dee Mensah', 'Manager', 'grassroots');
const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
const guni = (await j('POST', '/auth/player/login', { playerId: 'pl-guni' })).body;
const amara = (await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' })).body;
ok(
  [maria, sam, alex, ruth, dee, kola, guni, amara].every((a) => a?.token),
  'all actors logged in',
);
await j(
  'POST',
  '/admin/verification/orgs/org-eastport/appoint-root',
  { userId: maria.userId, reason: 'M15 suite root admin' },
  null,
  A,
);

section('H1 — self passport: canonical projection, honest identity, no rating');
{
  const r = await j('GET', '/player/football-passport', undefined, kola.token);
  ok(
    r.status === 200 && r.body.viewer === 'self' && r.body.passportVersion === 1,
    'self passport is one server-built projection',
  );
  ok(
    r.body.identity?.assurance === 'scoutbox_document_review' &&
      r.body.identity.label === 'Identity confirmed by ScoutBox review',
    'identity header states EXACTLY what ScoutBox did (a document review)',
  );
  neg(
    !JSON.stringify(r.body).includes('Government identity verified'),
    'never claims government identity verification — no authoritative IDV is configured',
  );
  ok(
    r.body.note.includes('not a rating of football ability'),
    'passport self-describes as evidence+provenance, not a rating',
  );
  ok(r.body.status.currentClub === null, 'no invented current club before any confirmed relationship');
  ok(
    r.body.completeness.eligibility.total === passportSpec.GAP_RULE_TABLE.length &&
      r.body.completeness.gaps.some((g) => g.id === 'gap.current_club_confirmed'),
    'gap engine speaks in generic versioned checks',
  );
  neg(!/"score"/.test(JSON.stringify(r.body)), 'no numeric score anywhere in the self projection');
  const forged = await j(
    'GET',
    '/player/football-passport?viewer=trust_safety&orgId=org-eastport',
    undefined,
    kola.token,
  );
  neg(
    forged.body.viewer === 'self' && !('graph' in forged.body),
    'viewer context comes from the SESSION — query-string viewer forging is inert',
  );
}

section('H2 — preferences, career entries, date honesty');
let sundayKingsId;
{
  let r = await j('PATCH', '/player/football-passport/prefs', { availability: 'sometimes' }, kola.token);
  neg(r.status === 400 && r.body.error === 'AVAILABILITY_INVALID', 'availability is a coarse enum — free text refused');
  r = await j(
    'PATCH',
    '/player/football-passport/prefs',
    {
      availability: 'open_to_trials',
      positions: { primary: 'ST', secondary: ['RW'] },
      positionHistoryAdd: { from: '2020', primary: 'RW' },
    },
    kola.token,
  );
  ok(
    r.status === 200 && r.body.prefs.availability === 'open_to_trials',
    'coarse availability + player-declared positions accepted',
  );
  r = await j('PATCH', '/player/football-passport/prefs', { bio: 'DM me on WhatsApp 07700 900123' }, kola.token);
  neg(r.status === 400 && r.body.error === 'MODERATION_BLOCKED', 'bio goes through the EXISTING moderation pipeline');
  r = await j(
    'PATCH',
    '/player/football-passport/prefs',
    { bio: 'Right-footed forward developing link-up play.' },
    kola.token,
  );
  ok(r.status === 200 && r.body.prefs.bio.includes('link-up'), 'clean bio accepted');

  r = await j(
    'POST',
    '/player/football-passport/career',
    { orgName: 'Sunday Kings FC', role: 'ST', from: '2018' },
    kola.token,
  );
  ok(
    r.status === 201 &&
      r.body.provenance === 'player_submitted' &&
      r.body.note.includes('has not independently confirmed'),
    'self career entry lands with honest provenance copy',
  );
  sundayKingsId = r.body.entry.id;
  r = await j(
    'POST',
    '/player/football-passport/career',
    { orgName: 'Riverside Colts', from: '2016-09', to: '2017' },
    kola.token,
  );
  ok(r.status === 201, 'month-precision history accepted as given');
  r = await j('POST', '/player/football-passport/career', { orgName: 'No Date FC' }, kola.token);
  neg(
    r.status === 400 && r.body.error === 'DATE_REQUIRED',
    'no date → refused (a year is enough; nothing is invented)',
  );
  r = await j('POST', '/player/football-passport/career', { orgName: 'Bad FC', from: 'sometime in 2019' }, kola.token);
  neg(r.status === 400, 'unparseable date refused, not silently normalised');

  r = await j('POST', '/player/football-passport/career', { orgName: 'Future FC', from: '2031' }, kola.token);
  const futureId = r.body.entry.id;
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.temporalConflicts.some((f) => f.kind === 'far_future'),
    'far-future entry is FLAGGED for correction, not rejected as fraud',
  );
  await j('POST', `/player/football-passport/career/${futureId}/withdraw`, {}, kola.token);
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(!sp.temporalConflicts.some((f) => f.kind === 'far_future'), 'withdrawing the entry auto-resolves the flag');
  const joined = sp.timeline.find((e) => e.type === 'club_joined' && e.title.org === 'Sunday Kings FC');
  ok(joined?.when.display === '2018' && joined.when.precision === 'year', 'timeline renders the year AS a year');
  // Junk is refused at the route, naming the field, rather than stored.
  r = await j('PATCH', '/player/football-passport/prefs', { positions: { primary: 'striker' } }, kola.token);
  neg(
    r.status === 400 && r.body.error === 'FIELD_INVALID' && r.body.field === 'positions.primary',
    'a position outside the position codes is refused',
  );
  r = await j(
    'PATCH',
    '/player/football-passport/prefs',
    { positions: { primary: 'ST', secondary: ['RW', 'LW', 'CF', 'CAM'] } },
    kola.token,
  );
  neg(r.status === 400 && r.body.field === 'positions.secondary', 'more than three secondary positions are refused');
  r = await j('PATCH', '/player/football-passport/prefs', { availableFrom: 'next week' }, kola.token);
  neg(
    r.status === 400 && r.body.error === 'DATE_INVALID' && r.body.field === 'availableFrom',
    'an availability date that is not a date is refused',
  );
  r = await j('PATCH', '/player/football-passport/prefs', { publicSelections: 'everything' }, kola.token);
  neg(r.status === 400 && r.body.field === 'publicSelections', 'public selections are a list');
  r = await j('POST', '/player/football-passport/achievements', { title: 'Cup', when: 'one summer' }, kola.token);
  neg(
    r.status === 400 && r.body.error === 'DATE_INVALID' && r.body.field === 'when',
    'an achievement date that is not a date is refused',
  );
  r = await j(
    'POST',
    '/player/football-passport/career',
    { orgName: 'Riverside Colts', role: { lead: true }, from: '2016' },
    kola.token,
  );
  neg(r.status === 400 && r.body.field === 'role', 'a role that is not text is refused');
  r = await j(
    'POST',
    '/player/football-passport/career',
    { orgName: 'Epoch FC', from: Date.UTC(2015, 6, 14, 15) },
    kola.token,
  );
  ok(r.status === 201 && r.body.entry.from === '2015-07-14', 'an epoch date is stored as the day it names');
  await j('POST', `/player/football-passport/career/${r.body.entry.id}/withdraw`, {}, kola.token);
  r = await j('PATCH', '/player/football-passport/prefs', { availableFrom: '2026-09' }, kola.token);
  ok(r.status === 200 && r.body.prefs.availableFrom === '2026-09', 'availability keeps the precision given');
}

section('H3 — evidence integration: projection only, no file duplication');
{
  const r = await j(
    'POST',
    '/player/evidence',
    { claimType: 'footage', label: 'Full match vs Harbour City U23' },
    kola.token,
  );
  ok(r.status === 201, 'footage evidence recorded through the EXISTING route');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.evidence.fullMatches === 1 && sp.evidence.note.includes('not football ability'),
    'evidence summary counts coverage, disclaims ability',
  );
  const ev = sp.timeline.find((e) => e.type === 'evidence_added');
  ok(
    ev?.provenance === 'player_submitted' && ev.provenanceCopy.includes('has not independently confirmed'),
    'self-reported footage says so',
  );
  neg(
    !JSON.stringify(sp.timeline).match(/mediaIds|\/media\/|dataUrl/),
    'timeline carries NO media ids and NO file URLs — files stay in their source system',
  );
}

section('H4 — trials: own-org only, never employment');
let eastportName;
{
  let r = await j(
    'POST',
    '/org/players/pl-adeyemi/request',
    {
      type: 'trial',
      message: 'Trial invitation for our U23 squad.',
      proposedDate: '2026-10-01',
      venue: 'Eastport Training Ground',
    },
    maria.token,
  );
  ok(r.status === 201 && r.body.routedTo === 'player', 'trial requested through the existing flow');
  r = await j(
    'POST',
    `/player/requests/${r.body.requestId}/respond`,
    { accept: true, chosenSlot: '2026-10-01' },
    kola.token,
  );
  ok(r.status === 200, 'player accepts — a trial record now exists');
  // The Passport keys `trial_attended` on RECORDED attendance,
  // never on acceptance. Accepted-but-not-attended is not shown as attended.
  const spAccepted = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(
    !spAccepted.timeline.some((e) => e.type === 'trial_attended'),
    'an accepted trial with no attendance recorded is NOT a trial_attended event',
  );
  {
    const trialId = r.body.trialId;
    const rm = await j('POST', '/org/rooms', { playerId: 'pl-adeyemi', sourceContext: 'search' }, maria.token);
    const roomId = rm.body?.room?.roomId ?? rm.body?.roomId ?? rm.body?.existingRoomId;
    const MIN = 60_000;
    let s = await j(
      'POST',
      `/org/rooms/${roomId}/trials/${trialId}/schedule`,
      {
        timezone: 'Europe/London',
        expectedRev: 1,
        sessions: [
          {
            startsAt: Date.now() - 10 * MIN,
            endsAt: Date.now() + 20 * MIN,
            kind: 'training',
            venue: { name: 'Eastport Training Ground', town: 'Eastport' },
          },
        ],
      },
      maria.token,
    );
    ok(s.status === 200 && s.body.requiresConfirmation === true, `the club proposes a concrete session (${s.status})`);
    const c = await j('POST', `/player/trials/${trialId}/confirm-schedule`, {}, kola.token);
    ok(
      c.status === 200 && c.body.trial.workflowState === 'scheduled',
      'the player confirms it — the trial is scheduled',
    );
    const sid = s.body.trial.schedule.sessions[0].id;
    const a = await j(
      'POST',
      `/org/rooms/${roomId}/trials/${trialId}/sessions/${sid}/attendance`,
      { state: 'attended', expectedRev: c.body.trial.rev },
      maria.token,
    );
    ok(a.status === 200, `attendance is recorded once the session has started (${a.status} ${a.body?.error ?? ''})`);
  }
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.timeline.some((e) => e.type === 'trial_attended' && e.legacy === false),
    'self timeline shows the trial once attendance is recorded',
  );
  neg(
    !sp.clubHistory.some((x) => /eastport/i.test(x.orgName ?? '')),
    'the trial creates NO club-history row — a trial is never employment',
  );
  const mine = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  eastportName = mine.body.status?.currentClub?.orgName ?? null; // still null here; org name captured later
  ok(
    mine.status === 200 && mine.body.trials.length === 1,
    'trialling org sees its own trial in the recruitment passport',
  );
  const theirs = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(
    theirs.status === 200 &&
      theirs.body.trials.length === 0 &&
      !theirs.body.timeline.some((e) => e.type === 'trial_attended'),
    'another org sees NEITHER the trial list NOR trial events',
  );
}

section('H5 — assessments: own-org privacy, notes never travel');
{
  let r = await j(
    'POST',
    '/org/assessments',
    { playerId: 'pl-adeyemi', positionGroup: 'ATT', context: { viewing: 'live', minutesWatched: 90 } },
    maria.token,
  );
  const ass = r.body.assessment;
  const attrs = ass.attributesSnapshot ?? [];
  r = await j(
    'PUT',
    `/org/assessments/${ass.id}`,
    {
      ratings: attrs.slice(0, 1).map((a) => ({ attrId: a.id, rating: 4 })),
      recommendation: { verdict: 'monitor', reasons: 'Track for six months before deciding.' },
    },
    maria.token,
  );
  ok(r.status === 200, 'assessment rated');
  r = await j('POST', `/org/assessments/${ass.id}/submit`, {}, maria.token);
  ok(r.status === 200, 'assessment submitted');
  const mine = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, maria.token);
  ok(
    mine.body.assessments.length === 1 && mine.body.assessments[0].state === 'submitted',
    'assessing org sees its own assessment existence',
  );
  const theirs = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(
    theirs.body.assessments.length === 0 && !theirs.body.timeline.some((e) => e.type === 'assessment_completed'),
    "org B never sees org A's assessment",
  );
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(
    !JSON.stringify(sp).includes('Track for six months'),
    'raw scout reasoning never reaches the player through the Passport',
  );
  neg(
    !JSON.stringify(theirs.body).includes('Track for six months'),
    'raw scout reasoning never reaches other orgs either',
  );
}

section('H6 — coach reference: snapshot provenance survives departure');
{
  const aff = await j('POST', '/org/verification/affiliation', { role: 'Coach' }, sam.token);
  await j('POST', '/org/verification/work-email', { email: 'sam.cole@eastportfc.com' }, sam.token);
  const code = await mailWith('sam.cole@eastportfc.com', /code is ([A-Za-z0-9_-]{8,})/);
  await j('POST', '/org/verification/work-email/confirm', { code }, sam.token);
  let r = await j(
    'POST',
    `/org/verification/requests/${aff.body.affiliation.id}/decide`,
    { action: 'confirm' },
    maria.token,
  );
  ok(r.status === 200, 'coach affiliation verified');
  r = await j(
    'POST',
    '/org/verification/references',
    {
      playerId: 'pl-adeyemi',
      relationship: 'Head coach, two seasons',
      capacity: 'U23s',
      fromYear: 2023,
      toYear: 2025,
      strengths: 'Pressing triggers',
      development: 'Weak-foot delivery',
      summary: 'Reliable, coachable forward.',
    },
    sam.token,
  );
  ok(r.status === 201, 'verified coach submits a structured reference');
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.references[0]?.provenanceCopy.includes('affiliation is verified'),
    'while the coach is current, the copy says the affiliation IS verified',
  );
  r = await j('POST', `/org/verification/staff/${sam.userId}/departed`, {}, maria.token);
  ok(r.status === 200, 'coach recorded as departed');
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.references[0]?.provenanceCopy === 'Coach affiliation was verified when this reference was submitted.',
    'after departure the SNAPSHOT copy displays — the historical truth is never rewritten',
  );
  ok(
    sp.timeline.some((e) => e.type === 'reference_received' && e.provenance === 'verified_coach_confirmed'),
    'reference event keeps coach-confirmed provenance',
  );
}

section('H7 — conflict engine over HTTP: confirmed club vs player claim');
{
  const inv = await j(
    'POST',
    '/org/verification/player-invites',
    { name: 'Kola Adeyemi', playerId: 'pl-adeyemi' },
    maria.token,
  );
  const r = await j('POST', '/player/invites/accept', { code: inv.body.code }, kola.token);
  ok(r.status === 200, 'player accepts the club squad invitation');
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  eastportName = sp.status.currentClub?.orgName;
  ok(
    !!eastportName && sp.status.currentClub.provenance === 'verified_club_confirmed',
    'confirmed relationship becomes the displayed current club',
  );
  const conflict = sp.conflicts.find((c) => c.code === 'CURRENT_CLUB_CONFLICT');
  ok(
    conflict && conflict.submitted.orgName === 'Sunday Kings FC' && conflict.authoritative.orgName === eastportName,
    'self view EXPLAINS the conflict with the still-open player entry',
  );
  const orgView = (await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token)).body;
  neg(
    !('conflicts' in orgView) && !JSON.stringify(orgView).includes('CURRENT_CLUB_CONFLICT'),
    'conflict flags are for the player and T&S — never shown to recruiting orgs',
  );
  const fold = await j('POST', '/player/football-passport/career', { orgName: eastportName, from: '2024' }, kola.token);
  ok(fold.status === 201, 'player also logs the same club as a career entry');
  const sp2 = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp2.foldedConflicts.length >= 1 && sp2.clubHistory.filter((x) => x.orgName === eastportName).length === 1,
    'duplicate self entry folds into the authoritative row — one row, flagged fold',
  );
}

section('H8 — achievements: forged provenance refused, confirmation upgrades');
let confirmedAchEvId;
{
  let r = await j('POST', '/player/football-passport/achievements', {}, kola.token);
  neg(r.status === 400 && r.body.error === 'TITLE_REQUIRED', 'empty achievement refused');
  for (const forged of [
    { provenance: 'verified_club_confirmed' },
    { confirmation: { provenance: 'authoritative_registry', orgName: 'FA' } },
  ]) {
    const [field] = Object.keys(forged);
    r = await j(
      'POST',
      '/player/football-passport/achievements',
      { title: 'County Cup Winner 2024', when: '2024', ...forged },
      kola.token,
    );
    neg(
      r.status === 400 && r.body.field === field && r.body.problem === 'unknown_field',
      `a client cannot assert an achievement's ${field}: the body is refused, naming it`,
    );
  }
  neg(
    !JSON.stringify((await j('GET', '/player/football-passport', undefined, kola.token)).body).includes(
      'County Cup Winner 2024',
    ),
    'and nothing of the refused achievements is stored',
  );
  r = await j(
    'POST',
    '/player/football-passport/achievements',
    { title: 'County Cup Winner 2024', when: '2024' },
    kola.token,
  );
  ok(
    r.status === 201 && r.body.provenance === 'player_submitted' && r.body.achievement.confirmation === null,
    'a new achievement is player-submitted, with no confirmation',
  );
  const achId = r.body.achievement.id;
  confirmedAchEvId = `pev:achievement:${achId}:achievement`;
  r = await j(
    'POST',
    '/player/football-passport/achievements',
    { title: "Players' Player 2023", when: '2023' },
    kola.token,
  );
  const ach2 = r.body.achievement.id;
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, ruth.token);
  neg(
    r.status === 403 && r.body.error === 'ORG_NOT_ELIGIBLE',
    'an UNVERIFIED organisation cannot confirm achievements',
  );
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, maria.token);
  ok(
    r.status === 200 && r.body.achievement.confirmation.provenance === 'verified_club_confirmed',
    'verified club confirmation upgrades provenance without rewriting the record',
  );
  r = await j('POST', `/org/players/pl-adeyemi/football-passport/achievements/${achId}/confirm`, {}, maria.token);
  neg(r.status === 409, 'double confirmation conflicts');
  r = await j('POST', `/player/football-passport/achievements/${achId}/withdraw`, {}, kola.token);
  neg(
    r.status === 403 && r.body.error === 'CONFIRMED_RECORD',
    'a CONFIRMED achievement cannot be deleted by the player — corrections instead',
  );
  r = await j('POST', `/player/football-passport/achievements/${ach2}/withdraw`, {}, kola.token);
  ok(r.status === 200, 'an unconfirmed self achievement remains withdrawable');
}

section('H9 — corrections: dispute flow, never direct edits');
{
  let r = await j('POST', '/player/football-passport/corrections', { targetType: 'weird' }, kola.token);
  neg(r.status === 400 && r.body.error === 'TARGET_INVALID', 'unknown correction target refused');
  r = await j(
    'POST',
    '/player/football-passport/corrections',
    { targetType: 'club_history', targetId: 'row-eastport', reason: '' },
    kola.token,
  );
  neg(r.status === 400 && r.body.error === 'REASON_REQUIRED', 'a correction needs a reason');
  r = await j(
    'POST',
    '/player/football-passport/corrections',
    { targetType: 'club_history', targetId: 'row-eastport', reason: 'Joined in August, the record says July.' },
    kola.token,
  );
  ok(
    r.status === 201 && r.body.note.includes('never silently edited'),
    'correction filed — the record itself is untouched',
  );
  const corrId = r.body.correction.id;
  r = await j('POST', `/player/football-passport/career/${corrId}/withdraw`, {}, kola.token);
  neg(r.status === 404, 'withdraw route only reaches OWN career entries — other records are out of scope');
  let list = await j('GET', '/admin/passport/corrections', undefined, null, A);
  ok(
    list.body.items.some((c) => c.id === corrId),
    'T&S queue lists the open correction',
  );
  ok(list.body.nextCursor === null, 'the queue is paged by cursor and this is its only page');
  neg(
    (await j('GET', '/admin/passport/corrections?limit=0', undefined, null, A)).status === 400,
    'a junk page size is refused',
  );
  r = await j('POST', `/admin/passport/corrections/${corrId}/resolve`, { resolution: 'maybe' }, null, A);
  neg(r.status === 400, 'resolution outcome must be explicit');
  r = await j(
    'POST',
    `/admin/passport/corrections/${corrId}/resolve`,
    { resolution: 'corrected', reason: 'Date fixed after club confirmation.' },
    null,
    A,
  );
  ok(r.status === 200 && r.body.correction.status === 'resolved', 'T&S resolves with an attributed reason');
  r = await j(
    'POST',
    `/admin/passport/corrections/${corrId}/resolve`,
    { resolution: 'rejected', reason: 'x' },
    null,
    A,
  );
  neg(r.status === 409, 'a resolved correction cannot be re-resolved');
}

section('H10 — representation (adults only) + signing');
let signingDone = false;
{
  // The representation HEADLINE on the Passport comes from the canonical agent
  // lane, so the fixture builds a canonical relationship — a named licensed agent
  // requests and the client confirms. The legacy writer is asserted closed below.
  const closed = await j(
    'POST',
    '/org/representation/propose',
    { playerId: 'pl-adeyemi', scope: 'contracts_only' },
    alex.token,
  );
  neg(closed.status === 404, 'the legacy representation writer is gone');
  await j('POST', '/org/agent/agency/team', { name: 'Ana Agent', tiers: ['licensed_agent'] }, alex.token);
  const ana = await login('org-northstar', 'Ana Agent', 'Agent', 'agent');
  await j('POST', '/org/agent/profile', { displayName: 'Ana Agent', jurisdictions: ['ENG'] }, ana.token);
  await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
  let r = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-adeyemi', scope: ['employment'], jurisdiction: 'INT' },
    ana.token,
  );
  ok(
    r.status === 201,
    `a licensed agent requests the adult client through the canonical lane (${r.status} ${r.body?.error ?? ''})`,
  );
  r = await j('POST', `/player/agent/relationships/${r.body.relationship.id}/confirm`, { expectedRev: 1 }, kola.token);
  ok(r.status === 200, 'player confirms — the canonical relationship is active');
  const agView = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, alex.token);
  ok(
    agView.status === 200 && agView.body.viewer === 'agency' && !!agView.body.representation?.agencyName,
    'agency passport view shows the (adult) representation status',
  );
  r = await j('POST', '/org/players/pl-adeyemi/signing', {}, maria.token);
  ok(r.status === 201, 'club records the signing (existing route)');
  signingDone = true;
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.status.currentClub?.provenance === 'verified_club_confirmed' && sp.timeline.some((e) => e.type === 'signed'),
    'signing is a club-confirmed timeline event and current-club source',
  );
  r = await j('GET', '/guardian/children/pl-adeyemi/football-passport', undefined, amara.token);
  neg(r.status === 403 && r.body.error === 'NOT_YOUR_CHILD', "a guardian cannot open an unrelated adult's passport");
}

section('H11 — public selections + public share');
let kolaPublicUrl;
{
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  const trialEv = sp.timeline.find((e) => e.type === 'trial_attended')?.id;
  const refEv = sp.timeline.find((e) => e.type === 'reference_received')?.id;
  const assEv = sp.timeline.find((e) => e.type === 'assessment_completed')?.id;
  let r = await j(
    'PATCH',
    '/player/football-passport/prefs',
    { publicSelections: [trialEv, confirmedAchEvId, refEv, assEv, 'hist:Sunday Kings FC'] },
    kola.token,
  );
  ok(r.status === 200, 'player selects what may go public (including two ids that are NOT public-eligible)');
  r = await j('POST', '/player/football-passport/shares', { mode: 'public', expiresDays: 365 }, kola.token);
  neg(r.status === 400 && r.body.field === 'expiresDays', 'a share lifetime outside 1–90 days is refused, not clamped');
  r = await j('POST', '/player/football-passport/shares', { mode: 'public', expiresDays: 30 }, kola.token);
  ok(
    r.status === 201 &&
      r.body.url.startsWith('/passport/shared/') &&
      !JSON.stringify(r.body.share).match(/tokenHash|[a-f0-9]{64}/),
    'share minted — the secret appears ONCE, never the stored hash',
  );
  kolaPublicUrl = r.body.url;
  const pub = await j('GET', kolaPublicUrl);
  ok(pub.status === 200 && pub.body.viewer === 'public', 'anonymous link resolves to the SAFE PUBLIC projection');
  ok(typeof pub.body.player.age === 'number', 'public shows age…');
  const raw = JSON.stringify(pub.body);
  neg(!raw.includes('"dob"'), '…never the raw date of birth');
  neg(!/guardian/i.test(raw), 'no guardian details in the public passport');
  neg(!raw.match(/mediaIds|\/media\/|dataUrl/), 'no media URLs or file references leak publicly');
  neg(
    !raw.includes('Track for six months') && !pub.body.timeline.some((e) => e.type === 'assessment_completed'),
    'no assessments and no scout reasoning publicly',
  );
  neg(
    !pub.body.timeline.some((e) => e.type === 'reference_received'),
    'selecting a reference id did NOT make it public (not public-eligible)',
  );
  ok(
    pub.body.timeline.some((e) => e.type === 'trial_attended'),
    'the explicitly selected trial participation IS public (opt-in)',
  );
  ok(
    pub.body.achievements.some((a) => a.title.includes('County Cup') && a.provenance === 'verified_club_confirmed'),
    'selected CONFIRMED achievement is public with its provenance',
  );
  ok(
    pub.body.status.currentClub?.orgName === eastportName && Object.keys(pub.body.status).join(',') === 'currentClub',
    'public status card = confirmed current club, nothing else',
  );
  ok(
    pub.body.clubHistory.some((x) => x.orgName === 'Sunday Kings FC' && x.provenance === 'player_submitted'),
    'opted-in self history row appears publicly WITH its honest provenance',
  );
  neg(!raw.includes('agencyName'), 'representation never appears publicly');
  const shares = await j('GET', '/player/football-passport/shares', undefined, kola.token);
  ok(shares.body.items.length >= 1 && shares.body.items[0].views >= 1, 'player sees their shares and view counts');
}

section('H12 — recruitment share re-runs every gate; blocks hold');
let kolaRecSecret;
{
  let r = await j('POST', '/player/football-passport/shares', { mode: 'recruitment' }, kola.token);
  kolaRecSecret = r.body.url.split('/').pop();
  const anon = await j('GET', `/passport/shared/${kolaRecSecret}`);
  neg(anon.status === 404, 'a recruitment link resolves NOWHERE anonymously (mode concealment)');
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}`, undefined, alex.token);
  ok(
    r.status === 200 && r.body.viewer === 'agency' && r.body.shareMode === 'recruitment',
    'authenticated agency opens the recruitment share for an ADULT',
  );
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}?viewer=self&orgId=org-eastport`, undefined, ruth.token);
  neg(
    r.status === 200 && r.body.viewer === 'pro_club',
    'query-string viewer/org forging on a share is inert — session decides',
  );
  r = await j('POST', '/player/block', { orgId: 'org-harbour' }, kola.token);
  ok(r.status === 201, 'player blocks Harbour (existing route)');
  r = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, ruth.token);
  neg(r.status === 403 && r.body.error === 'NOT_VISIBLE', 'blocked org loses the recruitment passport instantly');
  r = await j('GET', `/org/passport/shared/${kolaRecSecret}`, undefined, ruth.token);
  neg(r.status === 403, 'the share link does NOT bypass the block — it locates, it never authorises');
}

section('H13 — minors: guardian control, agency wall, radius, redaction');
{
  let r = await j('GET', '/guardian/children/pl-guni/football-passport', undefined, amara.token);
  ok(
    r.status === 200 && r.body.viewer === 'guardian' && r.body.identity?.assurance === 'scoutbox_document_review',
    "guardian sees the child's full passport",
  );
  r = await j(
    'POST',
    '/guardian/children/pl-guni/football-passport/career',
    { orgName: 'Hackney Youth', from: '2005' },
    amara.token,
  );
  ok(
    r.status === 201 && r.body.provenance === 'guardian_submitted',
    'guardian-submitted history carries guardian provenance',
  );
  r = await j('GET', '/guardian/children/pl-guni/football-passport', undefined, amara.token);
  ok(
    r.body.temporalConflicts.some((f) => f.kind === 'before_dob'),
    'an entry before the child was born is flagged for correction, not silently accepted',
  );
  r = await j('POST', '/player/football-passport/shares', { mode: 'public' }, guni.token);
  neg(
    r.status === 403 && r.body.error === 'GUARDIAN_MANAGED',
    'a minor cannot mint share links — sharing is guardian-controlled',
  );
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, alex.token);
  neg(r.status === 403 && r.body.error === 'UNDER_18_WALL', 'agency NEVER reaches a minor passport');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, ruth.token);
  neg(r.status === 403 && r.body.error === 'NOT_VISIBLE', 'unverified club never reaches a minor passport');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, dee.token);
  ok(
    r.status === 200 && r.body.viewer === 'grassroots_club',
    'verified LOCAL grassroots club sees the minor (standing rule, unchanged)',
  );
  neg(
    r.body.player.location === null && !JSON.stringify(r.body).includes('"dob"'),
    "minor's location and DOB are stripped from every org view",
  );
  r = await j('GET', '/org/players/pl-adeyemi/football-passport', undefined, dee.token);
  neg(r.status === 403, 'the 50 km grassroots radius holds for passports too');
  r = await j('GET', '/org/players/pl-guni/football-passport', undefined, maria.token);
  ok(r.status === 200 && r.body.player.location === null, 'verified pro club sees the minor — still without location');

  r = await j('POST', '/guardian/children/pl-adeyemi/football-passport/shares', { mode: 'public' }, amara.token);
  neg(
    r.status === 403 && r.body.error === 'NOT_YOUR_CHILD',
    'guardian share routes bind to the guardian’s OWN children only',
  );
  r = await j('POST', '/guardian/children/pl-guni/football-passport/shares', { mode: 'recruitment' }, amara.token);
  const guniRec = r.body.url.split('/').pop();
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, alex.token);
  neg(
    r.status === 403 && r.body.error === 'UNDER_18_WALL',
    'a guardian-minted share still NEVER opens a minor to an agency',
  );
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, ruth.token);
  neg(r.status === 403, 'nor to an unverified club');
  r = await j('GET', `/org/passport/shared/${guniRec}`, undefined, dee.token);
  ok(
    r.status === 200 && r.body.viewer === 'grassroots_club',
    'the SAME share works for an org that already passes every gate',
  );

  r = await j('POST', '/guardian/children/pl-guni/football-passport/shares', { mode: 'public' }, amara.token);
  const guniPub = r.body.url;
  const shareId = r.body.share.id;
  const pub = await j('GET', guniPub);
  ok(
    pub.status === 200 && typeof pub.body.player.age === 'number',
    'guardian-controlled public share shows the safe projection',
  );
  neg(
    !JSON.stringify(pub.body).includes('London') && !JSON.stringify(pub.body).includes('"dob"'),
    'public share of a minor: no location, no DOB',
  );
  r = await j('POST', `/guardian/children/pl-guni/football-passport/shares/${shareId}/revoke`, {}, amara.token);
  ok(r.status === 200, 'guardian revokes');
  const revoked = await j('GET', guniPub);
  const bogus = await j('GET', '/passport/shared/definitely-not-a-real-token-000');
  neg(
    revoked.status === 404 && bogus.status === 404 && JSON.stringify(revoked.body) === JSON.stringify(bogus.body),
    'revoked link is INDISTINGUISHABLE from an unknown token',
  );
}

section('H14 — suspended organisation lends no current relationship');
{
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: true }, null, A);
  let sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(
    sp.status.currentClub?.orgName !== eastportName && sp.status.currentClub?.provenance !== 'verified_club_confirmed',
    'while suspended, the org confers NO club-confirmed current club',
  );
  ok(
    sp.status.currentClub?.orgName === 'Sunday Kings FC' &&
      sp.status.currentClub.provenance === 'player_submitted' &&
      sp.conflicts.length === 0,
    'display falls back to the self-declared entry under its own honest provenance',
  );
  ok(
    sp.timeline.some((e) => e.type === 'signed'),
    'the historical signing fact itself is preserved',
  );
  await j('POST', '/admin/clubs/org-eastport/verification', { suspended: false }, null, A);
  sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  ok(
    sp.status.currentClub?.orgName === eastportName && sp.status.currentClub.provenance === 'verified_club_confirmed',
    'lifting the suspension restores the confirmed current club — nothing was destroyed',
  );
}

section('H15 — batch summaries: light, gated, measured');
{
  const seedIds = [
    'pl-adeyemi',
    'pl-carvalho',
    'pl-okafor',
    'pl-svensson',
    'pl-martin',
    'pl-tanaka',
    'pl-alvarez',
    'pl-nowak',
    'pl-mensah',
    'pl-kim',
    'pl-guni',
    'pl-imani',
    'pl-tomasz',
    'pl-osei',
    'pl-fake',
  ];
  const t0 = Date.now();
  let r = await j('GET', `/org/football-passports?ids=${seedIds.join(',')}`, undefined, maria.token);
  const ms = Date.now() - t0;
  ok(r.status === 200 && r.body.items.length > 5, `batch summary returns (${r.body.items.length} players in ${ms}ms)`);
  ok(ms < 500, `batch of ${seedIds.length} ids completes in <500ms (measured ${ms}ms — light assembly, no timelines)`);
  neg(!r.body.items.some((i) => i.playerId === 'pl-fake'), 'unknown ids are silently absent — concealment by omission');
  neg(
    r.body.items.every((i) => !('timeline' in i) && !('dob' in i)),
    'summaries carry NO timelines and NO DOB',
  );
  ok(
    r.body.items.some((i) => i.playerId === 'pl-guni'),
    'verified pro club batch includes visible minors',
  );
  const kolaRow = r.body.items.find((i) => i.playerId === 'pl-adeyemi');
  ok(
    kolaRow?.currentClub?.provenance === 'verified_club_confirmed' && typeof kolaRow.evidenceCoverage === 'string',
    'summary rows carry provenance-tagged club + coverage descriptor',
  );
  r = await j('GET', `/org/football-passports?ids=${seedIds.join(',')}`, undefined, alex.token);
  neg(
    !r.body.items.some((i) => ['pl-guni', 'pl-tomasz'].includes(i.playerId)),
    'agency batch NEVER contains minors — same wall, no error leak',
  );
}

section('H15b — Passport input is read strictly: no unknown fields, nothing cut, dates as written');
{
  const stored = async () => JSON.stringify((await j('GET', '/player/football-passport', undefined, kola.token)).body);
  let r = await j('PATCH', '/player/football-passport/prefs', { bio: 'Quick.', verified: true }, kola.token);
  neg(
    r.status === 400 && r.body.field === 'verified' && r.body.problem === 'unknown_field',
    'a preference the Passport does not have is refused, naming it',
  );
  r = await j(
    'PATCH',
    '/player/football-passport/prefs',
    { positionHistoryAdd: { from: '2020-01-01T10:00:00Z', primary: 'ST' } },
    kola.token,
  );
  neg(
    r.status === 400 && r.body.error === 'DATE_INVALID' && r.body.field === 'positionHistoryAdd.from',
    'a football date is a year, a month or a day — a date-time is refused, not read as its day',
  );
  r = await j('PATCH', '/player/football-passport/prefs', { positionHistoryAdd: { primary: 'ST' } }, kola.token);
  neg(r.status === 400 && r.body.error === 'DATE_REQUIRED', 'position history still needs at least a year');
  r = await j('POST', '/player/football-passport/career', { orgName: 'Object FC', from: { year: 2019 } }, kola.token);
  neg(r.status === 400 && r.body.error === 'DATE_INVALID' && r.body.field === 'from', 'a date sent as an object');
  r = await j(
    'POST',
    '/player/football-passport/career',
    { orgName: 'Long Note FC', from: '2019', note: 'n'.repeat(201) },
    kola.token,
  );
  neg(
    r.status === 400 && r.body.field === 'note' && r.body.problem === 'too_long' && r.body.max === 200,
    'an over-long career note is refused with its limit, not cut',
  );
  neg(!(await stored()).includes('Long Note FC'), 'and the refused entry is not stored');
  r = await j(
    'POST',
    '/player/football-passport/corrections',
    { targetType: 'club_history', reason: 'r'.repeat(501) },
    kola.token,
  );
  neg(r.status === 400 && r.body.field === 'reason' && r.body.max === 500, 'an over-long correction reason');
  r = await j('POST', '/player/football-passport/shares', { mode: 'everyone' }, kola.token);
  neg(
    r.status === 400 && r.body.error === 'MODE_INVALID' && r.body.allowed.includes('recruitment'),
    'an unknown share mode is refused with the modes allowed',
  );
  r = await j('POST', '/player/football-passport/shares', { mode: 'public', expiresDays: '30' }, kola.token);
  neg(r.status === 400 && r.body.field === 'expiresDays', 'a share lifetime written as text is refused, not read');
  const many = Array.from({ length: 101 }, (_, i) => `pl-${i}`).join(',');
  r = await j('GET', `/org/football-passports?ids=${many}`, undefined, maria.token);
  neg(r.status === 400 && r.body.field === 'ids' && r.body.max === 100, 'more than 100 Passports in one batch');
  r = await j('GET', `/org/trust-summaries?playerIds=${many}`, undefined, maria.token);
  neg(r.status === 400 && r.body.field === 'playerIds', 'more than 100 trust summaries in one batch');
  r = await j('GET', '/admin/passport/corrections?all=yes', undefined, null, A);
  neg(r.status === 400 && r.body.field === 'all', 'the corrections list takes all=0 or all=1');
}

section('H16 — deletion: shares die with the subject');
{
  const signup = await j('POST', '/auth/player/signup', {
    name: 'Bob Forward',
    dob: '1995-05-05',
    country: 'GB',
    position: 'ST',
    password: 'longenough1',
  });
  const bob = signup.body?.token
    ? signup.body
    : (await j('POST', '/auth/player/login', { playerId: signup.body.playerId })).body;
  ok(!!bob?.token, 'second adult player exists');
  await j('POST', '/player/football-passport/career', { orgName: 'Dockside Rovers', from: '2015' }, bob.token);
  let r = await j('POST', '/player/football-passport/shares', { mode: 'public' }, bob.token);
  const bobUrl = r.body.url;
  r = await j('GET', bobUrl);
  ok(r.status === 200 && r.body.player.name === 'Bob Forward', "Bob's token resolves to Bob");
  const crossed = await j('GET', `${bobUrl}?playerId=pl-adeyemi&viewer=self`);
  neg(
    crossed.body.player.id === r.body.player.id && crossed.body.viewer === 'public',
    'token A can never be steered to player B or a wider view',
  );
  r = await j('DELETE', '/player/account', undefined, guni.token);
  neg(
    r.status === 403 && r.body.error === 'GUARDIAN_MANAGED',
    'a minor cannot delete the account (existing guardian-managed rule)',
  );
  r = await j('DELETE', '/player/account', undefined, bob.token);
  ok(r.status === 200, 'adult deletes their account (existing route)');
  const gone = await j('GET', bobUrl);
  const bogus = await j('GET', '/passport/shared/also-not-a-token-1234567890');
  neg(
    gone.status === 404 && JSON.stringify(gone.body) === JSON.stringify(bogus.body),
    "a removed subject's share is dead AND indistinguishable from unknown",
  );
}

section('H17 — audit + metrics honesty');
{
  const ledger = await j('GET', '/org/ledger', undefined, maria.token);
  ok(
    ledger.body.items.some((l) => l.type === 'passport_recruitment_view' && l.playerId === 'pl-adeyemi'),
    'recruitment passport views land in the existing ledger',
  );
  const m = await j('GET', '/admin/metrics', undefined, null, A);
  const p = m.body.passport;
  ok(
    p &&
      p.views_self > 0 &&
      p.views_recruitment > 0 &&
      p.share_created >= 4 &&
      p.share_opened_public > 0 &&
      p.correction_filed > 0 &&
      p.achievement_confirmed > 0,
    'passport product metrics count events',
  );
  neg(
    !JSON.stringify(p).includes('pl-') && Object.values(p).every((v) => typeof v === 'number'),
    'metrics are pure counters — no player ids, no recruiter identities',
  );
  const sp = (await j('GET', '/player/football-passport', undefined, kola.token)).body;
  neg(
    !JSON.stringify(sp).match(/scoutName|Maria Keane|Ruth Vane/),
    'the player never learns WHICH scout viewed them through the Passport',
  );
}

// Token enumeration LAST — it deliberately exhausts the per-IP rate window.
section('H18 — share token enumeration hits the rate limit');
{
  const statuses = [];
  for (let i = 0; i < 40; i++) {
    const r = await j('GET', `/passport/shared/guess-${i}-abcdefghijklmnop`);
    statuses.push(r.status);
  }
  neg(!statuses.includes(200), 'guessing never resolves a passport');
  neg(
    statuses.includes(404) && statuses.includes(429) && statuses.at(-1) === 429,
    'enumeration starts as concealed 404s and ends rate-limited (429) well before the keyspace matters',
  );
}

const ratio = Math.round((negatives / passed) * 100);
console.log(
  `\npassport/passport: ${passed} checks passed, ${negatives} negative/abuse checks (${ratio}% of all checks)${process.exitCode ? ' (WITH FAILURES)' : ''}`,
);
if (negatives * 3 < passed) {
  console.error('✗ negative-test ratio below one third');
  process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
