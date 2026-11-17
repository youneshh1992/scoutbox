// Trial persistence suite.
//
// THE INVARIANTS
//
//   1. A trial row is a typed row: the report statuses (`awaiting_report`,
//      `reported`) are not workflow states, so nothing can have renamed them.
//   2. A fixture that carries workflow trial rows restores them byte-faithfully
//      through a real boot: sessions keep their ids and order, the append-only
//      revisions and attendance history keep every entry, the idempotency
//      keys live on the row.
//   3. A corrupt trial row is NAMED and OMITTED from the room's trial list
//      (counted, logged) and never takes the server down; a sound row on the
//      same case still serves. A row the typed tables cannot hold is refused
//      by the schema, and nothing is written.
//   4. Clean boot → invitation → acceptance → restart: the replay keys, the
//      case stage and the trial state are the same after the process died.
//
// No fixture here calls buildSeed(): the defect class lives in the gap
// between "the seed made it" and "the database guarantees it". Fixtures are
// written and read back as stored rows. How the repository writes the older
// record shapes into these rows, and its refusal of records that have no row
// form (an entry that is not a record, a list that is not a list), is in
// scripts/testRecruitment.mjs.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture } from '../support/sqlFixture.mjs';
import { readRows } from '../support/sqlRows.mjs';
import trialSpec from '../support/spec/recruitment/lifecycle/trial.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { TRIAL_WORKFLOW_STATES } = trialSpec;
// The table migrations a new database records, as the migrated schema lists them.
const MIGRATIONS = (() => {
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23t-schema-')));
  try {
    return R.rows('data_migrations').map((r) => r.id);
  } finally {
    R.close();
  }
})();
const LATEST_SCHEMA = Number(MIGRATIONS.at(-1).slice(0, 4)); // the latest table migration's number

// The tables a trial is stored in, and the request tables that name it.
const TRIAL_TABLES = [
  'trials',
  'trial_schedule_sessions',
  'trial_session_evidence',
  'trial_schedule_revisions',
  'trial_revision_sessions',
  'trial_attendance',
  'trial_history',
  'trial_keys',
  'trial_reminders',
  'trial_reports',
  'trial_day_staff',
  'trial_day_consents',
  'trial_day_checkins',
  'trial_day_status_events',
];
/** What a stopped server left: the trial tables, the requests and the cases, as stored rows. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return Object.fromEntries(
      [...TRIAL_TABLES, 'recruitment_requests', 'request_trial_slots', 'recruitment_cases'].map((t) => [t, R.rows(t)]),
    );
  } finally {
    R.close();
  }
};
/** Every row of one trial in every trial table, as text to compare. */
const trialRows = (s, id) =>
  JSON.stringify(TRIAL_TABLES.map((t) => s[t].filter((r) => (t === 'trials' ? r.id : r.trial_id) === id)));
/** The whole database, as text: the yardstick for "nothing was written". */
const everything = (dir) => {
  const R = readRows(dir);
  try {
    return JSON.stringify(R.all());
  } finally {
    R.close();
  }
};

let passed = 0;
let negatives = 0;
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (c, m) => {
  if (c) {
    passed++;
    console.log(`✓ ${m}`);
  } else fail(m);
};
const neg = (c, m) => {
  negatives++;
  ok(c, `[neg] ${m}`);
};
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Boot the real server on a directory; return a client and a stop() that SIGTERMs and reads the stored records back. */
async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SCOUTBOX_QUIET_LOGS: '1', SCOUTBOX_TEST_CLOCK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => {
    log += b;
  });
  proc.stderr.on('data', (b) => {
    log += b;
  });
  proc.unref();
  proc.stdout.unref();
  proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log: () => log };
    try {
      up = (await fetch(`${base}/healthz`)).ok;
    } catch {
      /* booting */
    }
    if (!up) await sleep(250);
  }
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, {
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
  };
  const stop = async () => {
    proc.kill('SIGTERM');
    for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
    return stored(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = await freePort();
const H = 3_600_000;
const T0 = 1_800_000_000_000; // 2027-01-15T08:00:00Z — inside the 2000–2100 window, in the future
const NOW = Date.now(); // when the fixtures are installed: the migrated schema's own rows carry it

// ------------------------------------------------------------- fixtures, as stored rows

/** A minimal, sound database: one verified club with a lead, one adult player, one case at `roomStatus`. The case's
 *  owner and lead scout, and a request's staff member, are real staff keys, so the fixture carries the staff row. */
const baseRows = ({ roomStatus = 'under_review', profileSignal = 30 } = {}) => ({
  orgs: [
    {
      id: 'org-x',
      name: 'X FC',
      type: 'club',
      level: 'pro',
      plan: 'Pro',
      lat: 51.5,
      lng: -0.1,
      trusted_partner: 0,
      verified: 1,
      safeguarding_contract_signed: 1,
      suspended: 0,
      email_domain_verified: 0,
      mfa_required_for_leads: 0,
      created_at: NOW,
    },
  ],
  org_users: [
    {
      id: 'usr-owner',
      org_id: 'org-x',
      name: 'Owner',
      name_key: 'owner',
      role: 'Head of Recruitment',
      created_at: 1,
      email_enabled: 1,
    },
  ],
  players: [
    {
      id: 'pl-x',
      name: 'Xavier Adult',
      birth_date: '2000-05-05',
      country: 'GB',
      city: 'London',
      academy_plus: 0,
      first_team_seeker: 0,
      availability: 'not_seeking',
      contract_status: 'unknown',
      level: 'amateur',
      identity_verified: 0,
      lat: 51.5,
      lng: -0.1,
      medical_shared: 0,
      medical_condition_status: 'unknown',
      // The player's stored profile figure counts the reports filed on their trials (one, in the pair).
      profile_signal: profileSignal,
    },
  ],
  recruitment_cases: [
    {
      id: 'case-x',
      org_id: 'org-x',
      player_id: 'pl-x',
      player_name: 'Xavier Adult',
      owner_user_id: 'usr-owner',
      owner_name: 'Owner',
      stage: 'review',
      priority: 'medium',
      restricted: 0,
      created_at: 1000,
      room_status: roomStatus,
      room_priority: 'normal',
      room_lead_scout_user_id: 'usr-owner',
      room_source_context: 'search',
      room_updated_at: 1000,
      room_rev: 2,
      room_rev_at: 1000,
    },
  ],
  case_history: [
    {
      case_id: 'case-x',
      position: 0,
      id: 'aud-1',
      at: 1000,
      action: 'room_created',
      by_kind: 'org',
      by_id: 'usr-owner',
      by_name: 'Owner',
      detail_json: JSON.stringify({ status: 'watching' }),
    },
    {
      case_id: 'case-x',
      position: 1,
      id: 'aud-2',
      at: 1001,
      action: 'room_status_changed',
      by_kind: 'org',
      by_id: 'usr-owner',
      by_name: 'Owner',
      detail_json: JSON.stringify({ from: 'watching', to: 'under_review', reasonCodes: [] }),
    },
  ],
});

const BY_OWNER = (p) => ({ [`${p}_kind`]: 'org', [`${p}_user_id`]: 'usr-owner', [`${p}_name`]: 'Owner' });
const BY_PLAYER = (p) => ({ [`${p}_kind`]: 'player', [`${p}_actor_id`]: 'pl-x', [`${p}_name`]: 'Xavier Adult' });
const VENUE = { venue_name: 'Dome', venue_town: 'London' };
const TSES_1 = { id: 'tses-1', kind: 'training', starts_at: T0 + 2 * H, ends_at: T0 + 4 * H, ...VENUE };
const TSES_2 = {
  id: 'tses-2',
  kind: 'match',
  starts_at: T0 + 48 * H,
  ends_at: T0 + 50 * H,
  ...VENUE,
  venue_address: '1 Dome Road',
  instructions: 'Gate B',
};

/** A sound, fully-populated workflow trial: two sessions, two revisions, two attendance records, one evidence link,
 *  keys and its history, in its rows. `over` changes the trials row. */
const soundTrialRows = (over = {}) => {
  const id = over.id ?? 'trial-1';
  const of = (rows) => rows.map((r) => ({ trial_id: id, ...r }));
  const history = (position, hid, at, action, by, detail) => ({
    position,
    id: hid,
    at,
    action,
    ...(by === 'player'
      ? { by_kind: 'player', by_actor_id: 'pl-x', by_name: 'Xavier Adult' }
      : { by_kind: 'org', by_user_id: 'usr-owner', by_name: 'Owner' }),
    detail_json: JSON.stringify(detail),
  });
  return {
    trials: [
      {
        id,
        request_id: 'req-1',
        case_id: 'case-x',
        player_id: 'pl-x',
        player_name: 'Xavier Adult',
        org_id: 'org-x',
        org_name: 'X FC',
        scout_name: 'Owner',
        accepted_at: T0,
        accepted_by: 'player',
        guardian_approved: 0,
        proposed_date: '2027-01-15',
        venue: 'Dome, London',
        notes: '',
        report_due_at: T0 + 7 * 86_400_000,
        status: 'awaiting_report',
        reminder_sent: 0,
        workflow_state: 'scheduled',
        schedule_timezone: 'Europe/London',
        schedule_revision: 2,
        schedule_proposed_at: T0 + 100,
        ...BY_OWNER('schedule_proposed_by'),
        schedule_confirmed_at: T0 + 200,
        ...BY_PLAYER('schedule_confirmed_by'),
        recipient_type: 'player',
        recipient_player_id: 'pl-x',
        recipient_minor: 0,
        recipient_at: T0,
        rev: 5,
        rev_at: T0 + 3 * H + 1,
        rev_by_user_id: 'usr-owner',
        rev_by_name: 'Owner',
        ...over,
      },
    ],
    // The current schedule, in its stored order (the match first).
    trial_schedule_sessions: of([
      { position: 0, ...TSES_2 },
      { position: 1, ...TSES_1, venue_address: '1 Dome Road' },
    ]),
    trial_session_evidence: of([
      {
        session_id: 'tses-2',
        position: 0,
        id: 'tev-1',
        kind: 'box_cam_session',
        box_session_id: 'bx-1',
        linked_at: T0 + 300,
        ...BY_OWNER('linked_by'),
      },
    ]),
    trial_schedule_revisions: of([
      {
        position: 0,
        revision: 1,
        timezone: 'Europe/London',
        proposed_at: T0,
        ...BY_OWNER('proposed_by'),
        confirmed_at: T0,
        ...BY_PLAYER('confirmed_by'),
        superseded_at: T0 + 100,
        reason: 'invitation',
      },
      {
        position: 1,
        revision: 2,
        timezone: 'Europe/London',
        proposed_at: T0 + 100,
        ...BY_OWNER('proposed_by'),
        confirmed_at: T0 + 200,
        ...BY_PLAYER('confirmed_by'),
        reason: 'Added a match.',
        material: 1,
      },
    ]),
    trial_revision_sessions: of([
      { revision: 1, position: 0, ...TSES_1 },
      { revision: 2, position: 0, ...TSES_1, venue_address: '1 Dome Road' },
      { revision: 2, position: 1, ...TSES_2 },
    ]),
    trial_attendance: of([
      {
        position: 0,
        session_id: 'tses-1',
        state: 'no_show',
        source: 'manual',
        ...BY_OWNER('recorded_by'),
        recorded_at: T0 + 3 * H,
      },
      {
        position: 1,
        session_id: 'tses-1',
        state: 'attended',
        source: 'manual',
        ...BY_OWNER('recorded_by'),
        recorded_at: T0 + 3 * H + 1,
        note: 'Late.',
      },
    ]),
    trial_history: of([
      history(0, 'aud-10', T0, 'trial_accepted', 'player', {
        recipientType: 'player',
        slotId: 'tslot-1',
        day: '2027-01-15',
      }),
      history(1, 'aud-11', T0 + 100, 'trial_rescheduled', 'org', {
        revision: 2,
        sessionCount: 2,
        material: true,
        requiresConfirmation: true,
      }),
      history(2, 'aud-12', T0 + 200, 'trial_schedule_confirmed', 'player', { revision: 2, sessionCount: 2 }),
      history(3, 'aud-13', T0 + 300, 'trial_evidence_linked', 'org', {
        trialSessionId: 'tses-2',
        kind: 'box_cam_session',
        sessionId: 'bx-1',
      }),
    ]),
    trial_keys: of([
      { act: 'attendance', position: 0, key: 'ak-1', fp: 'fp-a', at: T0 + 3 * H + 1 },
      { act: 'schedule', position: 0, key: 'sk-1', fp: 'fp-1', at: T0 + 100 },
    ]),
  };
};

/** A trial without the workflow containers (the older shape, stored as `legacy_accepted`): a filed report and a trial
 *  day with its emergency contact and one check-in. */
const legacyTrialRows = () => ({
  trials: [
    {
      id: 'trial-legacy',
      request_id: 'req-0',
      player_id: 'pl-x',
      player_name: 'Xavier Adult',
      org_id: 'org-x',
      org_name: 'X FC',
      scout_name: 'Owner',
      accepted_at: T0 - 400 * H,
      accepted_by: 'player',
      guardian_approved: 0,
      proposed_date: '2026-12-01',
      venue: 'Old Ground',
      notes: 'Bring boots',
      report_due_at: T0 - 300 * H,
      status: 'reported',
      reminder_sent: 0,
      workflow_state: 'legacy_accepted',
      day_emergency_name: 'Mum',
      day_emergency_phone: '0770',
      day_emergency_set_by: 'player',
      day_emergency_at: T0 - 401 * H,
      rev: 1,
    },
  ],
  trial_reports: [
    {
      trial_id: 'trial-legacy',
      id: 'rep-1',
      player_id: 'pl-x',
      org_id: 'org-x',
      org_name: 'X FC',
      user_id: 'usr-owner',
      scout_name: 'Owner',
      filed_at: T0 - 350 * H,
      acceleration: 7,
      sprint_speed_kmh: 30.5,
      distance_km: 6.1,
      pass_completion_pct: 80,
      duel_success_pct: 50,
      coach_rating: 7,
      notes: 'Fine.',
    },
  ],
  trial_day_checkins: [
    {
      trial_id: 'trial-legacy',
      position: 0,
      player_id: 'pl-x',
      at: T0 - 399 * H,
      by_user_id: 'usr-owner',
      by_name: 'Owner',
    },
  ],
});

/** An accepted trial invitation from the club, as its request row. */
const invitation = (id, over = {}) => ({
  id,
  player_id: 'pl-x',
  player_name: 'Xavier Adult',
  org_id: 'org-x',
  org_name: 'X FC',
  org_type: 'club',
  org_verified: 1,
  org_safeguarding_certified: 1,
  user_id: 'usr-owner',
  scout_name: 'Owner',
  scout_role: 'Head of Recruitment',
  type: 'trial',
  message: 'Come.',
  trial_proposed_date: '2027-01-15',
  trial_alt_days_json: '[]',
  trial_venue: 'Dome, London',
  trial_notes: '',
  status: 'accepted',
  created_at: T0 - 1000,
  responded_at: T0,
  responded_by: 'player',
  routed_to: 'player',
  ...over,
});

/** Merge row sets table by table, in order. */
const merge = (...sets) => {
  const out = {};
  for (const s of sets) for (const [t, rs] of Object.entries(s)) out[t] = [...(out[t] ?? []), ...rs];
  return out;
};

/** The sound trial and the legacy one, each with the accepted invitation it came from, in case-x at trial_scheduled. */
const pairRows = () =>
  merge(baseRows({ roomStatus: 'trial_scheduled', profileSignal: 38 }), {
    recruitment_requests: [
      // The legacy direct-request literal.
      invitation('req-0', {
        message: 'Come and train.',
        trial_proposed_date: '2026-12-01',
        trial_venue: 'Old Ground',
        trial_notes: 'Bring boots',
        created_at: T0 - 401 * H,
        responded_at: T0 - 400 * H,
      }),
      invitation('req-1', {
        trial_private_venue_address: '1 Dome Road',
        case_id: 'case-x',
        trial_id: 'trial-1',
        recipient_type: 'player',
        recipient_player_id: 'pl-x',
        recipient_minor: 0,
        invite_key: 'ik-1',
        invite_fp: 'fp-i',
      }),
    ],
    request_trial_slots: [
      {
        request_id: 'req-1',
        position: 0,
        id: 'tslot-1',
        day: '2027-01-15',
        kind: 'training',
        starts_at: T0 + 2 * H,
        ends_at: T0 + 4 * H,
        timezone: 'Europe/London',
        ...VENUE,
      },
    ],
    ...merge(soundTrialRows(), legacyTrialRows()),
    case_trial_links: [{ case_id: 'case-x', position: 0, trial_id: 'trial-1' }],
  });

/** Write `tables` into `dir` in one transaction (all or nothing), its references checked at the end. */
const write = (dir, tables) => {
  const F = openFixture(dir, { now: NOW });
  try {
    F.transaction(() => {
      if (F.fresh) F.markInstalled();
      F.sql.exec('PRAGMA defer_foreign_keys = ON'); // a request and its trial name each other
      for (const [table, rs] of Object.entries(tables)) for (const r of rs) F.insert(table, r);
    });
  } finally {
    F.close();
  }
  return dir;
};

// ======================================================= 1 — the typed rows
section('1 — a trial row: typed rows, nothing renamed');
{
  // The trials are typed rows read through SQL; a trial's schedule, attendance, history and keys are its child tables.
  const R = readRows(mkdtempSync(path.join(tmpdir(), 'sbx-m23t-tables-')));
  const tables = R.tables();
  const trialsSql = R.sql.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trials'").get().sql;
  R.close();
  ok(
    MIGRATIONS.length === LATEST_SCHEMA &&
      MIGRATIONS.includes('0015_recruitment') &&
      TRIAL_TABLES.every((t) => tables.includes(t)),
    'trials is a typed table read through SQL',
  );
  const workflowCheck = /workflow_state TEXT NOT NULL CHECK \(([^\n]*)\),\n/.exec(trialsSql)?.[1] ?? '';
  neg(
    !TRIAL_WORKFLOW_STATES.includes('awaiting_report') &&
      !TRIAL_WORKFLOW_STATES.includes('reported') &&
      workflowCheck.includes("'legacy_accepted'") &&
      !/awaiting_report|'reported'/.test(workflowCheck),
    'the report statuses are not workflow states — nothing can have renamed them',
  );
}

// ======================================================= 2 — byte-faithful restore
section('2 — a fixture with trial rows restores byte-faithfully through a real boot');
{
  const RESTORE_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-restore-'));
  write(RESTORE_DIR, pairRows());
  const written = stored(RESTORE_DIR);
  const beforeSound = trialRows(written, 'trial-1');
  const beforeLegacy = trialRows(written, 'trial-legacy');
  const s = await bootOn(RESTORE_DIR, PORT);
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots on the fixture');
  const lead = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const list = await s.j('GET', '/org/rooms/case-x/trials', undefined, lead.token);
  ok(
    list.status === 200 && list.body.items.length === 2 && list.body.omitted === 0,
    'both trials serve from the room (the P4B row and the legacy row), none omitted',
  );
  const t = list.body.items.find((x) => x.id === 'trial-1');
  ok(
    t.workflowState === 'scheduled' &&
      t.rev === 5 &&
      t.schedule.revision === 2 &&
      t.schedule.sessions.map((x) => x.id).join(',') === 'tses-1,tses-2' &&
      t.revisions.length === 2 &&
      t.attendanceHistory.length === 2 &&
      t.schedule.sessions[0].attendance.state === 'attended' &&
      t.evidenceCount === 1,
    'the P4B row projects with its rev, its two revisions, its ordered sessions, the current attendance and the evidence count',
  );
  const l = list.body.items.find((x) => x.id === 'trial-legacy');
  ok(
    l.workflowState === 'legacy_accepted' &&
      l.legacy === true &&
      l.reportStatus === 'reported' &&
      l.hasReport === true &&
      l.schedule.legacy === true,
    'the legacy row projects as legacy_accepted with its report and a date-only, flagged schedule',
  );
  const replay = await s.j(
    'POST',
    '/org/rooms/case-x/trials/trial-1/sessions/tses-1/attendance',
    { state: 'attended', expectedRev: 1, clientKey: 'ak-1', note: 'Late.' },
    lead.token,
  );
  // The stored fingerprint is a fixture value, not the live one: a different payload under the same key is a conflict — the KEY was restored.
  neg(
    replay.status === 409 && replay.body.error === 'TRIAL_IDEMPOTENCY_CONFLICT',
    'the attendance idempotency key was restored from the snapshot (a mismatched fingerprint is a conflict, not a fresh write)',
  );
  const inviteReplay = await s.j(
    'POST',
    '/org/rooms/case-x/trials',
    {
      timezone: 'Europe/London',
      venue: { name: 'Dome', town: 'London' },
      message: 'Come.',
      slots: [{ startsAt: T0 + 2 * H, endsAt: T0 + 4 * H }],
      clientKey: 'ik-1',
    },
    lead.token,
  );
  neg(
    inviteReplay.status === 409 && inviteReplay.body.error === 'TRIAL_IDEMPOTENCY_CONFLICT',
    'the invitation key on the request row was restored too',
  );
  const after = await s.stop();
  ok(
    after && trialRows(after, 'trial-1') === beforeSound && trialRows(after, 'trial-legacy') === beforeLegacy,
    'after a boot, reads and a graceful stop, both rows are byte-identical in the snapshot — nothing was rewritten, re-ordered or "repaired"',
  );
  neg(!s.log().includes('TRIAL integrity'), 'no integrity warning was logged for sound rows');
}

// ======================================================= 3 — corrupt rows
section('3 — corrupt trial rows are named and omitted, never fabricated, never fatal');
{
  const CORRUPT_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-corrupt-'));
  // Every trial names its own accepted invitation (trials.request_id is a UNIQUE key to recruitment_requests) and
  // only the sound trial is OPEN in case-x (trials_one_open_per_case). The typed tables hold a trial whose stored state
  // disagrees with its facts, a timezone that is not a zone and rev 0 — corruption a typed row can still carry — so
  // those three are planted and judged on read. A state, a completion or an attendance row outside the vocabulary
  // cannot be stored at all: section 3c proves the schema refuses them.
  const rows = merge(
    baseRows(),
    soundTrialRows(),
    soundTrialRows({ id: 'trial-bad-mismatch', request_id: 'req-bad-mismatch', workflow_state: 'completed' }),
    soundTrialRows({
      id: 'trial-bad-tz',
      request_id: 'req-bad-tz',
      workflow_state: 'cancelled',
      schedule_timezone: 'Mars/Olympus',
    }),
    soundTrialRows({ id: 'trial-bad-rev', request_id: 'req-bad-rev', workflow_state: 'cancelled', rev: 0 }),
  );
  rows.recruitment_requests = rows.trials.map((t) => invitation(t.request_id, { case_id: 'case-x', trial_id: t.id }));
  write(CORRUPT_DIR, rows);
  const writtenCorrupt = stored(CORRUPT_DIR);
  const s = await bootOn(CORRUPT_DIR, await freePort());
  if (!s.up) console.error(s.log().split('\n').slice(-12).join('\n'));
  ok(s.up, 'the server boots with four trials, three of them corrupt rows');
  const lead = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const list = await s.j('GET', '/org/rooms/case-x/trials', undefined, lead.token);
  if (list.status !== 200)
    console.error(
      '   list',
      list.status,
      JSON.stringify(list.body).slice(0, 300),
      s
        .log()
        .split('\n')
        .filter((l) => /Error|TypeError/.test(l))
        .slice(0, 4)
        .join(' | '),
    );
  ok(
    list.status === 200 && list.body.items.length === 1 && list.body.items[0].id === 'trial-1',
    'the room serves the one sound trial',
  );
  neg(list.body.omitted === 3, `three corrupt rows are counted as omitted (${list.body.omitted})`);
  const one = await s.j('GET', '/org/rooms/case-x/trials/trial-bad-mismatch', undefined, lead.token);
  neg(
    one.status === 500 && one.body.error === 'TRIAL_STATE_UNKNOWN',
    'reading a corrupt row by id is TRIAL_STATE_UNKNOWN (500), never a fabricated view',
  );
  const mut = await s.j(
    'POST',
    '/org/rooms/case-x/trials/trial-bad-tz/cancel',
    { expectedRev: 5, reason: 'x' },
    lead.token,
  );
  neg(mut.status === 500 && mut.body.error === 'TRIAL_STATE_UNKNOWN', 'nor can a corrupt row be mutated');
  const log = s.log();
  neg(
    ['trial-bad-mismatch', 'trial-bad-tz', 'trial-bad-rev'].every((id) => log.includes(`TRIAL integrity ${id}`)),
    'every corrupt row is NAMED in the server log with its problem codes',
  );
  const journey = await s.j('GET', '/org/rooms/case-x/journey', undefined, lead.token);
  ok(
    journey.status === 200 && journey.body.trials.length === 1 && journey.body.trialsOmitted === 3,
    'the journey omits and counts the same three',
  );
  const after = await s.stop();
  neg(
    after.trials.length === 4 &&
      after.trials.some((x) => x.id === 'trial-bad-tz' && x.schedule_timezone === 'Mars/Olympus') &&
      after.trials.some((x) => x.id === 'trial-bad-rev' && x.rev === 0),
    'the corrupt rows are still in the snapshot exactly as they were — omitted on read, never deleted or repaired',
  );
  for (const t of after.trials)
    if (trialRows(after, t.id) !== trialRows(writtenCorrupt, t.id))
      console.error('   changed row', t.id, trialRows(after, t.id).slice(0, 200));
}

// ======================================================= 3c — records the typed tables cannot hold
section(
  '3c — a state, a completion or an attendance row outside the vocabulary is refused by the schema, and nothing is written',
);
let REFUSED_DIR = null;
{
  // A fixture is one transaction: a row the schema refuses (a CHECK, a NOT NULL) refuses the whole fixture, and the
  // directory is left as a new one with nothing written.
  const FRESH = (() => {
    const D = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-fresh-'));
    openFixture(D, { now: NOW }).close();
    return everything(D);
  })();
  const unstorable = (id, over) =>
    merge(
      baseRows(),
      {
        recruitment_requests: [
          invitation(`req-${id}`, {
            trial_proposed_date: null,
            trial_venue: null,
            responded_at: null,
            responded_by: null,
          }),
        ],
      },
      soundTrialRows({ id, request_id: `req-${id}`, case_id: null, ...over }),
    );
  const ghostAttendance = unstorable('trial-bad-att', { workflow_state: 'cancelled' });
  ghostAttendance.trial_attendance = [
    { trial_id: 'trial-bad-att', position: 0, session_id: 'ghost', state: 'attended', recorded_at: T0 },
  ];
  const cases = [
    [
      'trial-bad-state',
      unstorable('trial-bad-state', { workflow_state: 'flying' }),
      /CHECK constraint failed: workflow_state/,
    ],
    ['trial-bad-att', ghostAttendance, /NOT NULL constraint failed: trial_attendance\.source/],
    [
      'trial-bad-completion',
      unstorable('trial-bad-completion', { workflow_state: 'cancelled', completion_state: 'done', completion_at: 1 }),
      /CHECK constraint failed: completion_state/,
    ],
  ];
  for (const [id, fixture, named] of cases) {
    const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-unstorable-'));
    let refused = null;
    try {
      write(dir, fixture);
    } catch (err) {
      refused = err;
    }
    neg(
      !!refused && named.test(String(refused.message)),
      `${id}: the write is refused by the schema, naming the column (${String(refused?.message ?? 'not refused').slice(0, 160)})`,
    );
    neg(everything(dir) === FRESH, `${id}: nothing was written`);
    REFUSED_DIR = dir;
  }
}
{
  const s = await bootOn(REFUSED_DIR, await freePort());
  ok(s.up, 'a server started on the directory boots (the refused fixture left nothing behind)');
  if (s.up) await s.stop();
}

// ======================================================= 4 — clean boot, live flow, restart
section('4 — clean boot: invitation, acceptance, restart — keys and stages survive');
{
  const CLEAN_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m23t-clean-'));
  write(CLEAN_DIR, baseRows());
  const s = await bootOn(CLEAN_DIR, await freePort());
  const lead = (
    await s.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const player = (await s.j('POST', '/auth/player/login', { playerId: 'pl-x' })).body;
  const NOW = Date.now();
  const inv = await s.j(
    'POST',
    '/org/rooms/case-x/trials',
    {
      timezone: 'Europe/London',
      venue: { name: 'Dome', town: 'London', address: '1 Dome Road' },
      message: 'Come and train.',
      instructions: 'Gate B',
      slots: [{ startsAt: NOW + 2 * H, endsAt: NOW + 4 * H }],
      clientKey: 'clean-inv',
    },
    lead.token,
  );
  ok(inv.status === 201 && inv.body.case.to === 'trial_requested', 'an invitation goes out from a clean database');
  const inbox = (await s.j('GET', '/player/inbox', undefined, player.token)).body.items.find(
    (r) => r.type === 'trial' && r.status === 'pending',
  );
  const acc = await s.j(
    'POST',
    `/player/requests/${inbox.id}/respond`,
    { accept: true, chosenSlot: inbox.trialDetails.proposedDate },
    player.token,
  );
  ok(acc.status === 200 && acc.body.trialId, 'the player accepts');
  const snap1 = await s.stop();
  const row = snap1.trials.find((t) => t.id === acc.body.trialId);
  ok(
    row &&
      row.workflow_state === 'scheduled' &&
      row.case_id === 'case-x' &&
      snap1.trial_schedule_sessions.filter((x) => x.trial_id === row.id).length === 1 &&
      snap1.trial_history.find((h) => h.trial_id === row.id && h.position === 0)?.action === 'trial_accepted' &&
      row.request_id === snap1.recruitment_requests[0].id &&
      snap1.recruitment_cases[0].room_status === 'trial_scheduled' &&
      snap1.recruitment_requests[0].invite_key === 'clean-inv',
    'the snapshot holds the scheduled trial, the case at trial_scheduled and the invitation key',
  );
  const s2 = await bootOn(CLEAN_DIR, await freePort());
  const lead2 = (
    await s2.j('POST', '/auth/org/login', { orgId: 'org-x', scoutName: 'Owner', role: 'Head of Recruitment' })
  ).body;
  const replay = await s2.j(
    'POST',
    '/org/rooms/case-x/trials',
    {
      timezone: 'Europe/London',
      venue: { name: 'Dome', town: 'London', address: '1 Dome Road' },
      message: 'Come and train.',
      instructions: 'Gate B',
      slots: [{ startsAt: NOW + 2 * H, endsAt: NOW + 4 * H }],
      clientKey: 'clean-inv',
    },
    lead2.token,
  );
  neg(
    replay.status === 200 && replay.body.idempotent === true && replay.body.invitation.id === inbox.id,
    'after the restart the invitation key replays from the row',
  );
  const t = (await s2.j('GET', `/org/rooms/case-x/trials/${acc.body.trialId}`, undefined, lead2.token)).body;
  ok(
    t.trial.workflowState === 'scheduled' &&
      t.trial.rev === 1 &&
      t.trial.history.map((h) => h.action).join(',') === 'trial_accepted,trial_schedule_confirmed',
    'the trial is exactly as it was: scheduled, rev 1, two history entries',
  );
  const jr = (await s2.j('GET', '/org/rooms/case-x/journey', undefined, lead2.token)).body;
  ok(
    jr.lifecycle.currentStage === 'trial_scheduled' && jr.history.entries.some((e) => e.kind === 'trial_accepted'),
    'the case stage and the milestone survived',
  );
  const snap2 = await s2.stop();
  const strip = (s) => JSON.stringify(TRIAL_TABLES.filter((t) => t !== 'trial_reminders').map((t) => s[t]));
  ok(
    strip(snap2) === strip(snap1),
    'a boot, a replay and a stop rewrote nothing in the trials store (reminder markers aside)',
  );
  const markers = (s) => s.trial_reminders.filter((r) => r.trial_id === acc.body.trialId).map((r) => r.marker);
  ok(
    markers(snap2).some((k) => k.startsWith('t48:')) && markers(snap1).length === 0,
    'the T-48h reminder for the session two hours away went out on the second boot and left its marker ON THE ROW — a restart re-sends nothing (the marker is persisted, not timer-held)',
  );
  const row2 = snap2.trials.find((t) => t.id === acc.body.trialId);
  ok(
    row2?.case_id === snap2.recruitment_cases[0].id &&
      row2.workflow_state === 'scheduled' &&
      row2.schedule_confirmed_at !== null,
    "the stored rows alone still hold the confirmed schedule the case's trial_scheduled evidence reads",
  );
}

// ---------------------------------------------------------------- report
const total = passed;
console.log(
  `\nrecruitment/trialsPersistence: ${total} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / total) * 100)}%)`,
);
if (process.exitCode === 1) console.error('\n✗ recruitment/trialsPersistence has failures.');
else console.log('all recruitment/trialsPersistence checks passed');
process.exit(process.exitCode ?? 0);
