// Persistence, migration and restart audit for the Agent core: (1) migration 0026, (2) staff with no agent rows get
// nothing bootstrapped, (3) the first member into an agency becomes its administrator, (4) a full relationship
// survives a restart byte for byte, (5) junk is refused by the schema, and an odd row a typed table CAN hold (an
// active agreement nobody confirmed) grants nothing. The pure rules' view of the same records is the rules suite's
// (scripts/rules/agents/corePersistence.mjs).
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFixture, SCHEMA_VERSION, TABLE_MIGRATIONS } from '../support/sqlFixture.mjs';
import { readRows, rows } from '../support/sqlRows.mjs';
import { freePort } from '../support/testPort.mjs';
import { serverCommand, serverDir } from '../support/server.mjs';

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
const stableJson = (v) => JSON.stringify(v);

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

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(...serverCommand(), {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      SCOUTBOX_QUIET_LOGS: '1',
      AGENT_VERIFICATION_TEST_PROVIDER: '1',
    },
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
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => rows(dir, 'data_migrations').map((r) => ({ id: r.id, at: r.applied_at }));
/** Every table's rows as stored: what a stopped server left on disk. */
const stored = (dir) => {
  const R = readRows(dir);
  try {
    return R.all();
  } finally {
    R.close();
  }
};
const AGENT_CORE_MIGRATION = '0026_agent_core';
const AGENT_TABLES = ['agent_profiles', 'agency_affiliations', 'representation_agreements'];
const T0 = 1_700_000_000_000; // 2023-11-14 — firmly in the past, so createdAt-based windows have started

// ------------------------------------------------------------- fixtures
// Rows in the stored shape, as the repositories wrote them in a probe run of the original fixture.

const player = (id, name, birthDate) => ({
  id,
  name,
  birth_date: birthDate,
  country: 'GB',
  city: 'London',
  availability: 'not_seeking',
  contract_status: 'unknown',
  level: 'amateur',
  lat: 51.5,
  lng: -0.1,
  medical_shared: 0,
  medical_condition_status: 'unknown',
  profile_signal: 30,
});
const user = (id, orgId, name, role, createdAt, removedAt = null) => ({
  id,
  org_id: orgId,
  name,
  name_key: name.toLowerCase(),
  role,
  created_at: createdAt,
  removed_at: removedAt,
});

/** One club, one agency with three staff (one lead, one removed), two agencies, two adult players; no agent rows. */
function staffSnapshot() {
  return {
    players: [player('pl-a', 'Adult A', '1999-01-01'), player('pl-b', 'Adult B', '1998-01-01')],
    orgs: [
      {
        id: 'org-club',
        name: 'Club',
        type: 'club',
        level: 'pro',
        plan: 'Pro',
        verified: 1,
        safeguarding_contract_signed: 1,
        lat: 51.5,
        lng: -0.1,
        created_at: T0,
      },
      { id: 'org-ag', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: 0, created_at: T0 },
      {
        id: 'org-ag2',
        name: 'Agency Two',
        type: 'agency',
        level: 'agency',
        plan: 'Agency',
        verified: 0,
        created_at: T0,
      },
    ],
    org_users: [
      user('usr-lead', 'org-ag', 'Lead Person', 'Managing Director', T0),
      user('usr-staff', 'org-ag', 'Staff Person', 'Scout', T0 + 1),
      user('usr-gone', 'org-ag', 'Gone Person', 'Head of Everything', T0 + 2, T0 + 3),
      user('usr-club', 'org-club', 'Club Person', 'Head of Recruitment', T0),
      user('usr-ag2-a', 'org-ag2', 'Second A', 'Scout', T0 + 5),
      user('usr-ag2-b', 'org-ag2', 'Second B', 'Scout', T0 + 6),
    ],
  };
}
const fixture = (dir, tables) => writeFixture(dir, { rows: tables });

/** An agreement's rows: the agreement and its one scope. */
const agreementRows = (over) => ({
  representation_agreements: [
    {
      agent_user_id: 'usr-lead',
      agency_org_id: 'org-ag',
      client_kind: 'player',
      jurisdiction: 'INT',
      exclusive: 0,
      term_months: 12,
      start_at: T0,
      end_at: T0 + 1e10,
      status: 'active',
      proposed_at: T0,
      confirmed_at: T0,
      share_with_agency_staff: 0,
      disclosure_club_presence: 0,
      disclosure_contact_routing: 0,
      disclosure_trial_visibility: 0,
      created_at: T0,
      rev: 1,
      rev_at: T0,
      ...over,
    },
  ],
  agreement_scopes: [{ agreement_id: over.id, ord: 0, scope: 'employment' }],
});
/** A profile's rows: the profile, its one jurisdiction, and its FIFA licence facet. */
const profileRows = (facet = {}) => ({
  agent_profiles: [
    {
      id: 'agp-x',
      user_id: 'usr-lead',
      agency_org_id: 'org-ag',
      display_name: 'Lead Person',
      created_at: T0,
      updated_at: T0,
      rev: 1,
      rev_at: T0,
    },
  ],
  agent_profile_jurisdictions: [{ profile_id: 'agp-x', ord: 0, jurisdiction: 'INT' }],
  agent_profile_facets: [
    { profile_id: 'agp-x', facet: 'fifa_licence', member_association: 'INT', state: 'UNVERIFIED', ...facet },
  ],
});
/** An affiliation's rows: the affiliation and its tiers. */
const affiliationRows = (id, userId, over = {}) => ({
  agency_affiliations: [
    { id, agency_org_id: 'org-ag', user_id: userId, started_at: T0, created_at: T0, rev: 1, rev_at: T0, ...over },
  ],
  agency_affiliation_tiers: [
    { affiliation_id: id, ord: 0, tier: 'agency_admin' },
    { affiliation_id: id, ord: 1, tier: 'licensed_agent' },
  ],
});
/** Tables merged in order, parents first. */
const merge = (...parts) => {
  const out = {};
  for (const p of parts) for (const [t, r] of Object.entries(p)) out[t] = [...(out[t] ?? []), ...r];
  return out;
};

// ======================================================= 1 — the migration
section('1 — migration 0026: registered once; a clean database holds no agent record');
{
  const ids = TABLE_MIGRATIONS;
  ok(
    ids.filter((id) => id === AGENT_CORE_MIGRATION).length === 1 && SCHEMA_VERSION >= 26,
    `${AGENT_CORE_MIGRATION} is registered once, and the schema has only moved forward since (now ${SCHEMA_VERSION})`,
  );
  neg(
    new Set(ids.map((id) => id.slice(0, 4))).size === ids.length &&
      ids.every((id) => Number(id.slice(0, 4)) <= SCHEMA_VERSION),
    `every schema version is reached by exactly one migration, none above the reported schema (${SCHEMA_VERSION})`,
  );
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p1-'));
  const fresh = stored(freshDir);
  ok(
    AGENT_TABLES.every((t) => fresh[t].length === 0),
    'a clean database holds no agent record: the agent core is tables (migration 0026)',
  );
  neg(
    !['agent_auth', 'agent_sessions', 'agent_users', 'offers'].some((t) => t in fresh),
    'no agent auth database and no offers store exists',
  );
  const recordsBefore = appliedMigrations(freshDir);
  ok(
    stableJson(stored(freshDir)) === stableJson(fresh) &&
      stableJson(appliedMigrations(freshDir)) === stableJson(recordsBefore),
    'reopening the file changes no table and records no migration again',
  );
  for (const t of AGENT_TABLES) ok(t in fresh, `${t} is a table of the agent core, not a collection`);
}

// ======================================================= 2 — staff, no agent rows
section('2 — a database of staff: nothing bootstrapped, nothing mirrored');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p2-'));
  const db = staffSnapshot();
  fixture(dir, db);
  const back = stored(dir);
  neg(
    AGENT_TABLES.every((t) => back[t].length === 0),
    'no agent record is created: staff exist only from their first login',
  );
  const staffFacts = (users) =>
    users
      .map((u) => `${u.id}:${u.org_id}:${u.name}:${u.role}:${u.removed_at ?? ''}`)
      .sort()
      .join();
  neg(staffFacts(back.org_users) === staffFacts(db.org_users), 'no user row was touched');
}

// ======================================================= 3 — boot over it
section('3 — a real boot over it: the first member becomes the administrator');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p3-'));
  const db = staffSnapshot();
  fixture(dir, db);
  const s = await bootOn(dir, PORT);
  ok(s.up, 'the server boots over a database of staff with no agent rows');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(
      h.body.schemaVersion === SCHEMA_VERSION && appliedMigrations(dir).some((r) => r.id === AGENT_CORE_MIGRATION),
      `and reports ${h.body.schemaVersion}, with the agent core migration recorded`,
    );
    const lead = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-ag',
        scoutName: 'Lead Person',
        role: 'Managing Director',
        platform: 'agent',
      })
    ).body;
    const staff = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-ag',
        scoutName: 'Staff Person',
        role: 'Scout',
        platform: 'agent',
      })
    ).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    ok(
      me.status === 200 && me.body.affiliation.tiers.join() === 'agency_admin',
      'the first member into the agency is its administrator (the bootstrap rule)',
    );
    const staffMe = await s.j('GET', '/org/agent/me', undefined, staff.token);
    neg(
      staffMe.status === 403 && staffMe.body.error === 'AGENCY_MEMBERSHIP_REQUIRED',
      'a second person is not a member until an administrator adds them',
    );
    const agency = await s.j('GET', '/org/agent/agency', undefined, lead.token);
    ok(
      agency.body.relationships.active === 0 && agency.body.relationships.pending === 0,
      'the agency overview counts no relationship: none was invented',
    );
    const list = await s.j('GET', '/org/agent/clients', undefined, lead.token);
    ok(list.status === 200 && list.body.items.length === 0, 'and the administrator sees no client row');
    const add = await s.j(
      'POST',
      '/org/agent/agency/team',
      { name: 'Second Admin', tiers: ['agency_admin'] },
      lead.token,
    );
    ok(add.status === 201, 'the administrator can administer: a second admin is added');
    const pa = (await s.j('POST', '/auth/player/login', { playerId: 'pl-a' })).body;
    const mine = await s.j('GET', '/player/agent/relationships', undefined, pa.token);
    ok(mine.status === 200 && mine.body.items.length === 0, 'the player sees no relationship');
    await s.stop();
  }
}

// ======================================================= 4 — clean boot round trip
section('4 — clean boot → relationship → stop → read back → reboot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p4-'));
  const port = await freePort();
  let s = await bootOn(dir, port);
  ok(s.up, 'clean boot');
  const tomas = (
    await s.j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Tomás Rivera',
      role: 'Director',
      platform: 'agent',
    })
  ).body;
  const me = (await s.j('GET', '/org/agent/me', undefined, tomas.token)).body;
  await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, tomas.token);
  await s.j(
    'PATCH',
    `/org/agent/agency/team/${me.user.id}`,
    { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.affiliation.rev },
    tomas.token,
  );
  const prof = await s.j(
    'POST',
    '/org/agent/profile',
    { displayName: 'Tomás Rivera', jurisdictions: ['INT'] },
    tomas.token,
  );
  const ver = await s.j(
    'POST',
    '/org/agent/profile/facets/fifa_licence/submit',
    { reference: 'TEST-VERIFIED-RT' },
    tomas.token,
  );
  ok(
    prof.status === 201 && ver.body.facet.state === 'VERIFIED',
    'profile created and verified by the synthetic provider',
  );
  const req = await s.j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-adeyemi', clientKey: 'rt-1', termMonths: 6 },
    tomas.token,
  );
  ok(req.status === 201, 'a request');
  const kola = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const conf = await s.j(
    'POST',
    `/player/agent/relationships/${req.body.relationship.id}/confirm`,
    { expectedRev: 1, clientKey: 'rt-c' },
    kola.token,
  );
  ok(conf.status === 200 && conf.body.relationship.status === 'active', 'confirmed');
  const beforeStop = {
    rel: (await s.j('GET', `/org/agent/clients/${req.body.relationship.id}`, undefined, tomas.token)).body,
    prof: (await s.j('GET', '/org/agent/profile', undefined, tomas.token)).body.profile,
    team: (await s.j('GET', '/org/agent/agency/team', undefined, tomas.token)).body.members,
  };
  const snap = await s.stop();
  const recordsAtStop = appliedMigrations(dir);
  ok(
    Number(recordsAtStop.at(-1)?.id.slice(0, 4)) === SCHEMA_VERSION &&
      snap.representation_agreements.length === 1 &&
      snap.agent_profiles.length === 1 &&
      snap.agency_affiliations.length === 2,
    'the database holds one agreement, one profile, two affiliations (read from the tables)',
  );
  const row = snap.representation_agreements[0];
  ok(
    row.request_key === 'rt-1' &&
      row.confirm_key === 'rt-c' &&
      row.rev === 2 &&
      snap.agreement_history.filter((h) => h.agreement_id === row.id).length === 2 &&
      row.confirmed_by_player_id === 'pl-adeyemi',
    'keys, rev, history and confirmation are on disk',
  );
  ok(
    snap.agent_profile_facets.find((f) => f.profile_id === snap.agent_profiles[0].id && f.facet === 'fifa_licence')
      ?.provenance_provider === 'local-synthetic-test-provider',
    'provenance is on disk',
  );
  neg(
    !Object.keys(row).some((c) => /^(trust|passport|offer)/.test(c)),
    'the row carries no trust, passport or offer field',
  );
  s = await bootOn(dir, await freePort());
  ok(s.up && (await s.j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION, `reboot at ${SCHEMA_VERSION}`);
  neg(
    stableJson(appliedMigrations(dir)) === stableJson(recordsAtStop),
    'no migration ran again (every record keeps its original time)',
  );
  const tomas2 = (
    await s.j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Tomás Rivera',
      role: 'Director',
      platform: 'agent',
    })
  ).body;
  const after = {
    rel: (await s.j('GET', `/org/agent/clients/${req.body.relationship.id}`, undefined, tomas2.token)).body,
    prof: (await s.j('GET', '/org/agent/profile', undefined, tomas2.token)).body.profile,
    team: (await s.j('GET', '/org/agent/agency/team', undefined, tomas2.token)).body.members,
  };
  ok(
    stableJson(after.rel.relationship) === stableJson(beforeStop.rel.relationship) && after.rel.access === true,
    'the relationship projects identically after the restart, and still grants access',
  );
  ok(stableJson(after.prof) === stableJson(beforeStop.prof), 'the profile projects identically');
  ok(stableJson(after.team) === stableJson(beforeStop.team), 'the team projects identically');
  ok(
    (
      await s.j(
        'POST',
        '/org/agent/clients/request',
        { playerId: 'pl-adeyemi', clientKey: 'rt-1', termMonths: 6 },
        tomas2.token,
      )
    ).body.idempotent === true,
    'the request key replays after the restart',
  );
  const snap2 = await s.stop();
  ok(
    appliedMigrations(dir).filter((r) => r.id === AGENT_CORE_MIGRATION).length === 1 &&
      snap2.representation_agreements.length === 1,
    'one migration record, still',
  );
}

// ======================================================= 5 — corruption
section('5 — junk is refused by the schema; what a typed row can hold is judged on read, never repaired');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p5-'));
  const db = staffSnapshot();
  // The schema refuses both, and the fixture's transaction writes nothing.
  const junkDir = () => mkdtempSync(path.join(tmpdir(), 'sbx-m24p5-junk-'));
  const refusedBy = (tables) => {
    const d = junkDir();
    try {
      fixture(d, merge(db, tables));
      return { error: null, dir: d };
    } catch (e) {
      return { error: e, dir: d };
    }
  };
  let r = refusedBy(profileRows({ state: 'approved', reference: 'X' }));
  neg(
    /CHECK constraint failed/.test(r.error?.message) &&
      /state/.test(r.error.message) &&
      !stored(r.dir).agent_profiles.length,
    `a facet state the table does not know is refused, and no profile is written (${r.error?.message ?? 'saved'})`,
  );
  r = refusedBy(agreementRows({ id: 'rep-x', client_id: 'pl-b', status: 'signed', confirmed_by_player_id: 'pl-b' }));
  neg(
    /CHECK constraint failed/.test(r.error?.message) &&
      /status/.test(r.error.message) &&
      !stored(r.dir).representation_agreements.length,
    `an agreement status the table does not know is refused, and no agreement is written (${r.error?.message ?? 'saved'})`,
  );
  // An odd row a typed table CAN hold: an ACTIVE agreement nobody confirmed (a dispute of a proposal reinstated by review).
  fixture(
    dir,
    merge(
      db,
      profileRows(),
      agreementRows({ id: 'rep-y', client_id: 'pl-b', confirmed_at: null, end_at: Date.now() + 1e10 }),
    ),
  );
  const agreementOf = (all) =>
    stableJson({
      agreement: all.representation_agreements.find((a) => a.id === 'rep-y'),
      scopes: all.agreement_scopes.filter((a) => a.agreement_id === 'rep-y'),
      history: all.agreement_history.filter((a) => a.agreement_id === 'rep-y'),
    });
  const before = agreementOf(stored(dir));
  const s = await bootOn(dir, await freePort());
  ok(s.up, 'the server boots over the odd row');
  if (s.up) {
    const lead = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-ag',
        scoutName: 'Lead Person',
        role: 'Managing Director',
        platform: 'agent',
      })
    ).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    const add = await s.j(
      'POST',
      '/org/agent/agency/team',
      { name: 'Second Admin', tiers: ['agency_admin'] },
      lead.token,
    );
    await s.j(
      'PATCH',
      `/org/agent/agency/team/${me.body.user.id}`,
      { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.body.affiliation.rev },
      lead.token,
    );
    const d = await s.j('GET', '/org/agent/clients/rep-y', undefined, lead.token);
    neg(
      d.status === 200 && d.body.access === false && d.body.relationship.status === 'active',
      'the unconfirmed agreement is shown with its stored word and access false',
    );
    neg(
      (await s.j('GET', '/org/agent/clients/rep-y/opportunities', undefined, lead.token)).status === 409,
      'and opens no board',
    );
    const after = await s.stop();
    neg(agreementOf(after) === before, 'nothing was repaired on boot or by reading — the bytes are the bytes');
    ok(add.status === 201, '(setup)');
  }
}

// ======================================================= 6 — the sweep's notices
section('6 — the sweep tells a current member once that a relationship is ending; an agent who left is not told');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p6-'));
  const ending = (id, agentUserId, clientId) =>
    agreementRows({
      id,
      agent_user_id: agentUserId,
      client_id: clientId,
      end_at: Date.now() + 10 * 86_400_000,
      confirmed_by_player_id: clientId,
    });
  fixture(
    dir,
    merge(
      staffSnapshot(),
      affiliationRows('aff-lead', 'usr-lead'),
      affiliationRows('aff-staff', 'usr-staff', { ended_at: T0 + 5, ended_reason: 'left' }),
      ending('rep-live', 'usr-lead', 'pl-a'),
      ending('rep-left', 'usr-staff', 'pl-b'),
    ),
  );
  const s = await bootOn(dir, await freePort());
  ok(s.up, 'the server boots over two relationships ending within 30 days');
  if (s.up) {
    await sleep(500); // the sweep runs once at boot
    const after = await s.stop();
    const expiring = after.notifications.filter((n) => n.type === 'representation_expiring');
    ok(
      expiring.length === 1 &&
        JSON.stringify(expiring[0]).includes('usr-lead') &&
        JSON.stringify(expiring[0]).includes('rep-live'),
      'the current member is told once that their relationship is ending',
    );
    neg(!expiring.some((n) => JSON.stringify(n).includes('usr-staff')), 'an agent whose membership ended is not told');
    neg(
      after.representation_agreements.every((a) => typeof a.expiry_notified_at === 'number'),
      'both relationships are marked, so neither is looked at again',
    );
  }
}

console.log(
  `\nagents/corePersistence: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode) console.error('SOME CHECKS FAILED');
else console.log('all agents/corePersistence checks passed');
process.exit(process.exitCode ?? 0);
