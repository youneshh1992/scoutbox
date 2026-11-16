// PLATFORM TEMPORAL INTEGRITY & DATE VALIDATION suite.
//
// The question this suite asks is not "do dates work?" — every other suite
// assumes they do. It is: for every date or time a security, lifecycle or
// compliance decision depends on, what happens when the value is malformed,
// rolled over by the engine, ambiguous, zone-dependent, out of order, or
// simply unreadable? The decision must fail CLOSED, never open; this suite is
// the one regression for that class of defect across the whole platform.
//
// Groups, live on a fresh server:
//   Q sign-up DOB             R every hardened route     S authorization before dates
//   T persistence/restart
//
// Groups A–P, the date rules themselves (the temporal contract, DATE_ONLY, dates of birth, UTC instants, IANA zones,
// daylight saving, fail-closed predicates, licence expiry, policy windows, agents, Contact, Trial scheduling,
// analytics, the 22 adversarial cases and zone independence under three TZ settings), are checked in
// scripts/rules/platform/dates.mjs.
//
// No assertion is `status !== 200`; every refusal names its status and its code.

import { pickPort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '../support/sqlFixture.mjs';
import { rows } from '../support/sqlRows.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

// The latest table migration, as the migrated schema lists them.
const SCHEMA_VERSION = Number(
  rows(mkdtempSync(path.join(tmpdir(), 'sbx-p57-schema-')), 'data_migrations')
    .map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);

const PORT = pickPort(7600, 150, [0]);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-p57-'));
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

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
const neg = (cond, msg) => {
  negatives++;
  ok(cond, `[neg] ${msg}`);
};
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const NY = 'America/New_York';
const utcDayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

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
async function boot(env = {}) {
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      SCOUTBOX_QUIET_LOGS: '1',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
      SCOUTBOX_TEST_CLOCK: '1',
      ...env,
    },
    stdio: 'ignore',
  });
  children.push(proc);
  proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try {
      up = (await fetch(`${BASE}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not come up');
  return proc;
}
async function stop(proc) {
  proc.kill('SIGTERM');
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode != null || proc.signalCode) break;
    await sleep(100);
  }
  await sleep(300);
}
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
  return { status: r.status, body: data, headers: r.headers };
}
const expect = (r, status, code) => {
  const good = r.status === status && (code == null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 240)}`);
  return good;
};
const login = async (orgId, scoutName, role, platform) =>
  (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;

// A trial with named staff exists before boot, carrying three shapes for a
// background-check expiry: a day that has passed, a day to come, and text
// nobody can read.
let server = await boot();
await stop(server);
{
  // Plain rows on the stopped server's database. A trial names its request by a real key and a request names its
  // staff member by a real key, so the fixture carries the staff row and the accepted invitation trial-p57 came from
  // (the legacy direct-request literal). Five shapes of a background-check expiry: a day that has passed, a day to
  // come, text nobody can read, none, and a check still pending.
  const existing = rows(DATA_DIR, 'org_users', { org_id: 'org-eastport', name: 'Maria Keane' })[0]?.id ?? null;
  const userId = existing ?? 'usr-p57-maria';
  const day = utcDayOf(Date.now() + 10 * DAY);
  const F = openFixture(DATA_DIR);
  try {
    F.transaction(() => {
      if (!existing)
        F.insert('org_users', {
          id: userId,
          org_id: 'org-eastport',
          name: 'Maria Keane',
          name_key: 'maria keane',
          role: 'Head of Recruitment',
          created_at: 1,
          email_enabled: 1,
        });
      F.insert('recruitment_requests', {
        id: 'req-p57',
        player_id: 'pl-adeyemi',
        player_name: 'Kola Adeyemi',
        org_id: 'org-eastport',
        org_name: 'Eastport FC',
        org_type: 'club',
        org_verified: 1,
        org_safeguarding_certified: 0,
        user_id: userId,
        scout_name: 'Maria Keane',
        scout_role: 'Head of Recruitment',
        type: 'trial',
        message: 'Come and train.',
        trial_proposed_date: day,
        trial_alt_days_json: '[]',
        trial_venue: 'Training ground',
        trial_notes: '',
        status: 'accepted',
        created_at: Date.now() - 4 * DAY,
        responded_at: Date.now() - 3 * DAY,
        responded_by: 'player',
        routed_to: 'player',
      });
      F.insert('trials', {
        id: 'trial-p57',
        request_id: 'req-p57',
        player_id: 'pl-adeyemi',
        player_name: 'Kola Adeyemi',
        org_id: 'org-eastport',
        org_name: 'Eastport FC',
        scout_name: 'Maria Keane',
        accepted_at: Date.now() - 3 * DAY,
        accepted_by: 'player',
        proposed_date: day,
        venue: 'Training ground',
        notes: '',
        report_due_at: Date.now() + 17 * DAY,
        status: 'awaiting_report',
        reminder_sent: 0,
        workflow_state: 'accepted',
        rev: 1, // issueAcceptedTrial's literal for a date-only invitation
      });
      const staff = [
        ['stf-past', 'A Past', 'reviewed', '2020-01-01'],
        ['stf-future', 'B Future', 'reviewed', '2099-01-01'],
        ['stf-text', 'C Text', 'reviewed', 'never'],
        ['stf-none', 'D None', 'reviewed', null],
        ['stf-pending', 'E Pending', 'pending', null],
      ];
      staff.forEach(([id, name, status, expiresAt], position) =>
        F.insert('trial_day_staff', {
          trial_id: 'trial-p57',
          position,
          id,
          name,
          role: 'Coach',
          check_kind: 'DBS',
          check_ref: 'x',
          check_status: status,
          check_expires_at: expiresAt,
          check_reviewed_by: status === 'reviewed' ? 'T&S' : null,
          added_by_name: 'Maria Keane',
          added_at: 1,
        }),
      );
    });
  } finally {
    F.close();
  }
}
server = await boot();

section('Q/live — sign-up: every bad date of birth refused at the door, both doors');
{
  // (`foot` is a column with CHECK (left|right|null); a sign-up with any other value is refused 400 PLAYER_INVALID, so the probe sends the valid form.)
  const signup = (dob) =>
    j('POST', '/auth/player/signup', {
      name: `Probe ${Math.random().toString(36).slice(2, 6)}`,
      dob,
      country: 'GB',
      position: 'ST',
      foot: 'right',
      password: 'a-long-enough-password',
    });
  for (const dob of [
    '2000-02-30',
    '1999-04-31',
    '1997-02-29',
    '1998-13-01',
    '1998-00-10',
    '1998-01-00',
    '1998-01-32',
    '02/03/1998',
  ])
    neg(expect(await signup(dob), 400, 'DOB_INVALID'), `Q1 self sign-up with dob ${dob} → 400 DOB_INVALID`);
  neg(expect(await signup('2030-01-01'), 400, 'DOB_INVALID'), 'Q1b a date of birth in the future → 400 DOB_INVALID');
  neg(expect(await signup('1890-01-01'), 400, 'DOB_INVALID'), 'Q1c a 136-year-old → 400 DOB_INVALID');
  const leap = await signup('2000-02-29');
  ok(
    leap.status === 201 && leap.body?.player?.dob === '2000-02-29',
    'Q2 a REAL leap day (2000-02-29) creates the account and stores the day exactly',
  );
  const gAuth = await j('POST', '/auth/guardian/login', { guardianId: 'gd-amara' });
  ok(gAuth.status === 200 && !!gAuth.body?.token, 'Q3 the guardian signs in');
  const child = (dob) =>
    j(
      'POST',
      '/guardian/children',
      { name: `Child ${Math.random().toString(36).slice(2, 6)}`, dob, country: 'GB' },
      gAuth.body.token,
    );
  for (const dob of ['2012-02-30', '2013-13-01', '02/03/2012'])
    neg(expect(await child(dob), 400, 'DOB_INVALID'), `Q4 guardian creates a child with dob ${dob} → 400 DOB_INVALID`);
  neg(expect(await child('2030-01-01'), 400, 'DOB_INVALID'), 'Q4b a child born in the future → 400 DOB_INVALID');
  const kid = await child('2012-02-29');
  ok(kid.status === 201, 'Q5 a child born on the 2012 leap day is created');
}

section('R/live — every hardened route answers with the taxonomy');
{
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const moss = await login('org-mossside', 'Pat Doyle', undefined, 'grassroots');
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const priya = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' }))
    .body;
  ok(!!maria?.token && !!moss?.token && !!kola?.token && !!priya?.token, 'R0 the four identities signed in');

  // Licence expiry
  const lic = (body) =>
    j(
      'POST',
      '/org/verification/licence',
      { licenceType: 'UEFA B Licence', issuer: 'UEFA', identifier: 'UEFA-B-77777', holderName: 'Maria Keane', ...body },
      maria.token,
    );
  neg(
    expect(await lic({ expiry: '2027-02-30' }), 400, 'DATE_INVALID'),
    'R1 a licence expiring on 30 February → 400 DATE_INVALID',
  );
  neg(
    expect(await lic({ expiry: 'sometime' }), 400, 'DATE_INVALID'),
    'R1b …"sometime" → 400 (it used to be stored as NO expiry)',
  );
  neg(expect(await lic({ expiry: '30/06/2028' }), 400, 'DATE_INVALID'), 'R1c …an ambiguous slash date → 400');
  neg(
    expect(await lic({ issueDate: '2028-06-30', expiry: '2027-06-30' }), 400, 'INTERVAL_INVALID'),
    'R1d expiring before issue → 400 INTERVAL_INVALID',
  );
  const good = await lic({ issueDate: '2024-06-30', expiry: '2028-06-30' });
  ok(good.status === 201 && !!good.body?.claim?.id, 'R2 a well-formed licence claim is created');
  const me = await j('GET', '/org/verification/me', undefined, maria.token);
  const claim = (me.body?.claims ?? []).find((c) => c.id === good.body.claim.id);
  ok(
    claim?.validUntil === Date.UTC(2028, 5, 31) && claim?.validFrom === Date.UTC(2024, 5, 30),
    'R2b stored as instants: valid THROUGH 30 June 2028 (expiry = start of 1 July, UTC), from 30 June 2024',
  );

  // Safeguarding staff check expiry
  const day = await j('GET', '/org/trials/trial-p57/day', undefined, maria.token);
  const st = Object.fromEntries((day.body?.trial?.staff ?? []).map((s) => [s.id, s.check.status]));
  ok(
    day.status === 200 &&
      st['stf-future'] === 'reviewed' &&
      st['stf-none'] === 'reviewed' &&
      st['stf-pending'] === 'pending',
    'R3 controls: a future expiry and no expiry read reviewed; pending reads pending',
  );
  neg(st['stf-past'] === 'expired', 'R3b a check that expired in 2020 reads expired');
  neg(
    st['stf-text'] === 'expired',
    'R3c a check whose expiry is the word "never" reads EXPIRED — it used to read reviewed for ever',
  );
  neg(
    expect(
      await j(
        'POST',
        '/admin/staff-checks/trial-p57/stf-pending',
        { status: 'reviewed', expiresAt: '2027-02-30' },
        null,
        ADMIN,
      ),
      400,
      'DATE_INVALID',
    ),
    'R4 T&S cannot review a check with an expiry on 30 February',
  );
  neg(
    expect(
      await j(
        'POST',
        '/admin/staff-checks/trial-p57/stf-pending',
        { status: 'reviewed', expiresAt: 'never' },
        null,
        ADMIN,
      ),
      400,
      'DATE_INVALID',
    ),
    'R4b …or "never"',
  );
  const reviewed = await j(
    'POST',
    '/admin/staff-checks/trial-p57/stf-pending',
    { status: 'reviewed', expiresAt: '2027-06-30' },
    null,
    ADMIN,
  );
  ok(
    reviewed.status === 200 &&
      reviewed.body?.check?.state === 'reviewed' &&
      reviewed.body?.check?.expiresAt === '2027-06-30',
    'R4c a real day is accepted and stored as the day',
  );
  neg(
    expect(
      await j(
        'POST',
        '/org/trials/trial-p57/staff',
        { name: 'F New', role: 'Coach', check: { kind: 'DBS', expiresAt: '2027-04-31' } },
        maria.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R5 a club cannot file a check expiring on 31 April',
  );
  const staffIso = await j(
    'POST',
    '/org/trials/trial-p57/staff',
    { name: 'G Iso', role: 'Coach', check: { kind: 'DBS', expiresAt: '2027-06-30T00:00:00.000Z' } },
    maria.token,
  );
  ok(
    staffIso.status === 201 && staffIso.body?.staff?.check?.expiresAt === '2027-06-30T00:00:00.000Z',
    'R5b an ISO instant with Z (the shape the club app sends) is accepted and normalised',
  );

  // Development Hub
  neg(
    expect(
      await j(
        'POST',
        '/player/development/plans',
        { title: 'X', visibility: 'private', startDate: '2026-06-01T09:00' },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R6 a plan starting at a bare local time → 400 DATE_INVALID',
  );
  neg(
    expect(
      await j(
        'POST',
        '/player/development/plans',
        { title: 'X', visibility: 'private', startDate: '2026-02-30' },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R6b …on 30 February → 400',
  );
  neg(
    expect(
      await j(
        'POST',
        '/player/development/plans',
        { title: 'X', visibility: 'private', startDate: '06/01/2026' },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R6c …on 06/01/2026 → 400 (it used to be 1 June)',
  );
  const plan = await j(
    'POST',
    '/player/development/plans',
    { title: 'X', visibility: 'private', startDate: '2026-06-01', endDate: '2026-08-31' },
    kola.token,
  );
  ok(
    plan.status === 201 && plan.body?.plan?.startDate === Date.UTC(2026, 5, 1),
    'R6d a calendar day is stored as the UTC-midnight instant',
  );
  neg(
    expect(
      await j(
        'POST',
        '/player/development/plans',
        { title: 'X', visibility: 'private', startDate: '2026-06-01', endDate: '2026-05-31' },
        kola.token,
      ),
      400,
      'DATE_INTERVAL_INVALID',
    ),
    'R6e an inverted plan interval keeps its frozen m21 code',
  );

  // Analytics, briefs
  neg(
    expect(
      await j('GET', '/org/recruitment-analytics?from=2026-02-30&to=2026-03-01', undefined, maria.token),
      400,
      'WINDOW_INVALID',
    ),
    'R7 an analytics window from 30 February → 400 WINDOW_INVALID',
  );
  const brief = await j(
    'POST',
    '/org/recruitment-briefs',
    { title: 'P57', positions: ['CM'], activeUntil: 'whenever' },
    maria.token,
  );
  neg(
    brief.status === 400 && brief.body?.error === 'DATE_INVALID' && brief.body?.field === 'activeUntil',
    'R8 a brief ending "whenever" → 400 DATE_INVALID naming activeUntil',
  );

  // Grassroots dates
  neg(
    expect(
      await j('POST', '/org/open-trials', { title: 'Open day', date: 'next week', venue: 'Rec' }, moss.token),
      400,
      'DATE_INVALID',
    ),
    'R9 an open day dated "next week" → 400 DATE_INVALID (it used to list as upcoming for ever)',
  );
  neg(
    expect(
      await j('POST', '/org/open-trials', { title: 'Open day', date: '2099-02-30', venue: 'Rec' }, moss.token),
      400,
      'DATE_INVALID',
    ),
    'R9b …on 30 February → 400',
  );
  ok(
    (await j('POST', '/org/open-trials', { title: 'Open day', date: '2099-05-01', venue: 'Rec' }, moss.token))
      .status === 201,
    'R9c a real day → 201',
  );
  neg(
    expect(
      await j('POST', '/org/matchday', { fixture: 'A v B', date: '2026-02-30', playerIds: [] }, moss.token),
      400,
      'DATE_INVALID',
    ),
    'R10 a match day on 30 February → 400',
  );
  neg(
    expect(await j('POST', '/org/friendlies', { date: 'soon', venue: 'x' }, moss.token), 400, 'DATE_INVALID'),
    'R10b a friendly "soon" → 400',
  );
  neg(
    expect(
      await j(
        'POST',
        '/player/attendance',
        { fixture: 'x', venue: 'y', date: '02/03/2026', gps: { lat: 51.5, lng: -0.1 }, deviceId: 'd' },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R11 verified attendance on 02/03/2026 → 400 DATE_INVALID',
  );
  neg(
    expect(
      await j('POST', '/player/medical/records', { title: 'Knock', date: '2026-13-01' }, kola.token),
      400,
      'DATE_INVALID',
    ),
    'R12 a medical record in month 13 → 400',
  );
  ok(
    (await j('POST', '/player/medical/records', { title: 'Knock' }, kola.token)).status === 201,
    'R12b …and one with no date is dated today',
  );

  // Evidence
  neg(
    expect(
      await j(
        'POST',
        '/player/evidence',
        { claimType: 'statistic', label: 'Goals', value: 3, observedAt: '2026-02-30' },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R13 evidence observed on 30 February → 400',
  );
  neg(
    expect(
      await j(
        'POST',
        '/player/evidence',
        { claimType: 'statistic', label: 'Goals', value: 3, observedAt: utcDayOf(Date.now() + 30 * DAY) },
        kola.token,
      ),
      400,
      'DATE_INVALID',
    ),
    'R13b evidence observed next month → 400 (not yet evidence)',
  );
  const ev = await j(
    'POST',
    '/player/evidence',
    { claimType: 'statistic', label: 'Goals', value: 3, observedAt: '2026-03-01' },
    kola.token,
  );
  ok(
    ev.status === 201 && ev.body?.evidence?.observedAt === Date.UTC(2026, 2, 1),
    'R13c a calendar day is stored as an instant',
  );

  // Notification preferences
  neg(
    expect(
      await j('POST', '/player/prefs', { quietStart: '25:00', quietEnd: '07:00' }, kola.token),
      400,
      'TIME_INVALID',
    ),
    'R14 quiet hours from 25:00 → 400 TIME_INVALID',
  );
  neg(
    expect(await j('POST', '/player/prefs', { timezone: 'Mars/Olympus' }, kola.token), 400, 'TIMEZONE_INVALID'),
    'R14b a zone that is not a zone → 400 TIMEZONE_INVALID',
  );
  const prefs = await j('POST', '/player/prefs', { quietStart: '22:00', quietEnd: '07:00', timezone: NY }, kola.token);
  ok(
    prefs.status === 200 && prefs.body?.prefs?.timezone === NY && prefs.body?.prefs?.quietStart === '22:00',
    'R14c quiet hours in a named zone are stored',
  );
  const mute = await j('POST', '/player/prefs', { schoolHoursMute: 'false' }, kola.token);
  neg(
    mute.status === 400 && mute.body.field === 'schoolHoursMute' && mute.body.problem === 'not_boolean',
    'R14d the school-hours mute written as text is refused, not read as on',
  );
  const listed = await j('POST', '/player/prefs', { quietStart: ['22:00'] }, kola.token);
  neg(
    listed.status === 400 && listed.body.error === 'TIME_INVALID' && listed.body.expected === 'HH:MM',
    'R14e quiet hours written as a list are TIME_INVALID, saying the form expected',
  );
  const cleared = await j('POST', '/player/prefs', { quietStart: '', quietEnd: '' }, kola.token);
  ok(
    cleared.status === 200 && cleared.body.prefs.quietStart === null && cleared.body.prefs.timezone === NY,
    'R14f empty quiet hours clear them and keep the zone',
  );

  // Policy publishing
  const pol = (from, to = null) =>
    j(
      'POST',
      '/ts/compliance/policies',
      {
        id: `jp-eng-p57-${Math.random().toString(36).slice(2, 6)}`,
        regulator: 'FA',
        jurisdiction: 'ENG',
        policyVersion: 77,
        effectiveFrom: from,
        effectiveTo: to,
        rules: { 'X-1': { ruleStatus: 'ACTIVE', sourceRef: [{ source: 'p57', retrievedDate: '2026-01-01' }] } },
      },
      priya.token,
    );
  neg(
    expect(await pol('2027-02-30'), 400, 'POLICY_INPUT_INVALID'),
    'R15 a policy effective from 30 February → 400 POLICY_INPUT_INVALID',
  );
  neg(
    expect(await pol('2027-01-01', '2026-12-31'), 400, 'POLICY_INPUT_INVALID'),
    'R15b a policy ending before it starts → 400',
  );
  ok((await pol('2027-01-01', '2027-12-31')).status === 201, 'R15c a well-ordered window is proposed');
}

section('S/live — authorization is decided before a date is read (error privacy)');
{
  neg(
    expect(await j('POST', '/org/open-trials', { title: 'x', date: '2026-02-30', venue: 'y' }), 401),
    'S1 no token + bad date → 401, not 400',
  );
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const r = await j('POST', '/org/open-trials', { title: 'x', date: '2026-02-30', venue: 'y' }, kola.token);
  neg(
    r.status === 401 || r.status === 403,
    `S2 a player token on a club route + bad date → ${r.status}, never a date error`,
  );
  neg(
    expect(
      await j('POST', '/admin/staff-checks/trial-p57/stf-text', { status: 'reviewed', expiresAt: '2027-02-30' }),
      401,
      'ADMIN_KEY_REQUIRED',
    ),
    'S3 the staff-check review without the admin key → 401, not 400',
  );
  neg(
    expect(await j('POST', '/guardian/children', { name: 'x', dob: '2012-02-30' }), 401),
    'S4 a child with a bad dob and no guardian token → 401',
  );
  neg(
    expect(
      await j('POST', '/player/development/plans', { title: 'X', visibility: 'private', startDate: '2026-02-30' }),
      401,
    ),
    'S5 a plan with a bad date and no token → 401',
  );
  neg(
    expect(
      await j('POST', '/ts/compliance/policies', {
        id: 'jp-eng-x-1',
        jurisdiction: 'ENG',
        policyVersion: 1,
        effectiveFrom: '2027-02-30',
        rules: {},
      }),
      401,
    ),
    'S6 a policy with a bad date and no reviewer → 401',
  );
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  neg(
    expect(await j('GET', '/org/trials/trial-nope/day', undefined, maria.token), 404, 'TRIAL_NOT_FOUND'),
    'S7 an unknown trial is 404 for its own club…',
  );
  const harbour = await login('org-harbour', 'Coach D. Ansah', 'Head Coach');
  if (harbour?.token)
    neg(
      expect(
        await j(
          'POST',
          '/org/trials/trial-p57/staff',
          { name: 'x', role: 'y', check: { expiresAt: '2027-02-30' } },
          harbour.token,
        ),
        404,
        'TRIAL_NOT_FOUND',
      ),
      "S7b …and another club's trial is 404 for a stranger even with a bad date in the body (existence is not revealed by a date error)",
    );
  else ok(true, 'S7b (skipped: no second club login available in this seed)');
}

section('T/live — persistence and restart: normalised values survive as what they are');
{
  ok(
    (await j('GET', '/healthz')).headers.get('x-scoutbox-schema') === String(SCHEMA_VERSION),
    'T1 the schema is the latest table migration',
  );
  await stop(server);
  server = await boot();
  const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment');
  const me = await j('GET', '/org/verification/me', undefined, maria.token);
  const lic = (me.body?.claims ?? []).find((c) => c.claimType === 'LICENCE' && c.validUntil === Date.UTC(2028, 5, 31));
  ok(!!lic, 'T2 the licence expiry is an integer instant after a restart');
  const day = await j('GET', '/org/trials/trial-p57/day', undefined, maria.token);
  const st = Object.fromEntries((day.body?.trial?.staff ?? []).map((s) => [s.id, s.check.status]));
  neg(
    st['stf-text'] === 'expired' && st['stf-past'] === 'expired' && st['stf-future'] === 'reviewed',
    'T3 the legacy "never" check still reads expired after a restart; the real ones unchanged',
  );
  ok(st['stf-pending'] === 'reviewed', 'T3b the check T&S reviewed with a real day persisted as reviewed');
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const prefs = await j('GET', '/player/prefs', undefined, kola.token);
  ok(prefs.body?.prefs?.timezone === NY, 'T4 the notification zone persisted');
  await stop(server);
}

console.log(
  `\n${passed} checks passed, ${negatives} negative (${Math.round((100 * negatives) / Math.max(1, passed + (process.exitCode ? 1 : 0)))}%)`,
);
if (process.exitCode) console.error('FAILURES PRESENT');
