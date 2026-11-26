// Persistence, migration and restart audit for the Conflict & Compliance Engine:
// (1) the compliance tables and their seeded policy versions, (2) the migrations
// invent no review or reviewer and change no agent row, (3) a real boot over
// typed agent rows, (4) a full round trip across a restart, (5) corruption on
// disk is contained and named. No migration bootstraps review items: a review is
// requested by the route that needs one, which section 3 exercises. The pure engine's
// view of the corrupt records is the rules suite's (scripts/rules/agents/compliancePersistence.mjs).
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { freePort } from '../support/testPort.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openFixture, writeFixture, SCHEMA_VERSION, TABLE_MIGRATIONS } from '../support/sqlFixture.mjs';
import { readRows, rows } from '../support/sqlRows.mjs';
import conflictSpec from '../support/spec/agents/compliance/conflict.json' with { type: 'json' };
import policySpec from '../support/spec/agents/compliance/policyVersions.json' with { type: 'json' };
import { serverCommand, serverDir } from '../support/server.mjs';

const { PERMITTED_WITH_CONSENT } = conflictSpec;
const { SEEDED_POLICY_VERSIONS, RULE_PARAMS } = policySpec;

const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

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
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
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
const T0 = 1_700_000_000_000;
// Reviewers and policy versions come from migration 0027 (which inserts the seeded versions); contexts, reviews
// and consents from 0028.
const TABLE_STORES = [
  'ts_reviewers',
  'jurisdiction_policies',
  'regulatory_reviews',
  'regulatory_consents',
  'compliance_contexts',
];
const STEPS = ['0027_compliance_policies', '0028_compliance_records'];
/** The compliance tables: every table of the reviewer, policy, context, review and consent families. */
const complianceTables = (tables) =>
  Object.keys(tables).filter((t) => /^(ts_reviewer|jurisdiction_polic|compliance_|regulatory_)/.test(t));
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => rows(dir, 'data_migrations').map((r) => ({ id: r.id, at: r.applied_at }));
/** Every table's rows as stored: what a stopped server left on disk. */
function stored(dir) {
  const R = readRows(dir);
  try {
    return R.all();
  } finally {
    R.close();
  }
}
/** The stored rows of `table` in `tables` whose columns match `where`, in `ord` order when they have one. */
const of = (tables, table, where) =>
  tables[table]
    .filter((r) => Object.entries(where).every(([c, v]) => r[c] === v))
    .sort((a, b) => (a.set_no ?? 0) - (b.set_no ?? 0) || (a.ord ?? 0) - (b.ord ?? 0));
/**
 * A policy version's rules rebuilt from its stored rule rows, in the shape the policy snapshot encodes them. Each
 * parameter is read by its type in the snapshot's RULE_PARAMS: a flag, a count, role sets, an age map, a text list,
 * or else text (an enum, a date, a month-day).
 */
const storedRules = (tables, policyId) =>
  Object.fromEntries(
    of(tables, 'jurisdiction_policy_rules', { policy_id: policyId }).map((r) => {
      const at = { policy_id: policyId, rule_id: r.rule_id };
      const params = Object.fromEntries(
        of(tables, 'jurisdiction_policy_rule_params', at).map((p) => {
          const items = of(tables, 'jurisdiction_policy_rule_param_items', { ...at, name: p.name });
          const type = RULE_PARAMS[p.name];
          const value =
            type === 'flag'
              ? p.flag_value === 1
              : type === 'count'
                ? p.count_value
                : type === 'roleSets'
                  ? Object.values(Object.groupBy(items, (i) => i.set_no)).map((set) => set.map((i) => i.text_value))
                  : type === 'ageMap'
                    ? Object.fromEntries(items.map((i) => [i.member, i.count_value]))
                    : type === 'textList'
                      ? items.map((i) => i.text_value)
                      : p.text_value;
          return [p.name, value];
        }),
      );
      const overrides = of(tables, 'jurisdiction_policy_rule_overrides', at).map((o) => ({
        jurisdiction: o.jurisdiction,
        scope: o.scope,
        overrideRuleId: o.override_rule_id,
      }));
      return [
        r.rule_id,
        {
          ruleStatus: r.rule_status,
          textStatus: r.text_status,
          sourceRef: of(tables, 'jurisdiction_policy_rule_sources', at).map((s) => ({
            source: s.source,
            version: s.version,
            effectiveDate: s.effective_date,
            retrievedDate: s.retrieved_date,
          })),
          params,
          note: r.note,
          ...(overrides.length ? { overrides } : {}),
          ...(r.effective_from_date ? { effectiveFrom: r.effective_from_date } : {}),
        },
      ];
    }),
  );
/** JSON with every object's keys sorted: rows have no key order, so neither does a record rebuilt from them. */
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );

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
const user = (id, name, role, createdAt) => ({
  id,
  org_id: 'org-ag',
  name,
  name_key: name.toLowerCase(),
  role,
  created_at: createdAt,
});
const agreement = (id, clientId) => ({
  id,
  agent_user_id: 'usr-agent',
  agency_org_id: 'org-ag',
  client_kind: 'player',
  client_id: clientId,
  jurisdiction: 'ENG',
  exclusive: 0,
  term_months: 12,
  start_at: T0 + 10,
  end_at: Date.now() + 1e10,
  status: 'active',
  proposed_at: T0,
  confirmed_at: T0 + 10,
  confirmed_by_player_id: clientId,
  share_with_agency_staff: 0,
  disclosure_club_presence: 0,
  disclosure_contact_routing: 0,
  disclosure_trial_visibility: 0,
  created_at: T0,
  rev: 2,
  rev_at: T0 + 10,
});
const profile = (id, userId, displayName) => ({
  id,
  user_id: userId,
  agency_org_id: 'org-ag',
  display_name: displayName,
  created_at: T0,
  updated_at: T0,
  rev: 1,
  rev_at: T0,
});
const affiliation = (id, userId) => ({
  id,
  agency_org_id: 'org-ag',
  user_id: userId,
  started_at: T0,
  created_at: T0,
  rev: 1,
  rev_at: T0,
});

/** One agency with a licensed agent (licence VERIFIED) and a licensed administrator, two active agreements. */
function agencySnapshot() {
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
    ],
    org_users: [
      user('usr-lead', 'Lead Person', 'Managing Director', T0),
      user('usr-agent', 'Agent Person', 'Agent', T0 + 1),
    ],
    // The Agent core rows, as typed tables write them.
    agency_affiliations: [affiliation('aff-lead', 'usr-lead'), affiliation('aff-agent', 'usr-agent')],
    agency_affiliation_tiers: [
      { affiliation_id: 'aff-lead', ord: 0, tier: 'agency_admin' },
      { affiliation_id: 'aff-lead', ord: 1, tier: 'licensed_agent' },
      { affiliation_id: 'aff-agent', ord: 0, tier: 'licensed_agent' },
    ],
    agent_profiles: [profile('agp-1', 'usr-agent', 'Agent Person'), profile('agp-2', 'usr-lead', 'Lead Person')],
    agent_profile_jurisdictions: [
      { profile_id: 'agp-1', ord: 0, jurisdiction: 'ENG' },
      { profile_id: 'agp-1', ord: 1, jurisdiction: 'INT' },
      { profile_id: 'agp-2', ord: 0, jurisdiction: 'INT' },
    ],
    agent_profile_facets: [
      {
        profile_id: 'agp-1',
        facet: 'fifa_licence',
        member_association: 'INT',
        state: 'VERIFIED',
        reference: 'TEST-VERIFIED-1',
        provenance_provider: 'local-synthetic-test-provider',
        provenance_kind: 'synthetic',
        provenance_at: T0,
        submitted_at: T0,
        verified_at: T0,
        recheck_at: Date.now() + 20 * 86_400_000,
        note: 'x',
      },
      { profile_id: 'agp-2', facet: 'fifa_licence', member_association: 'INT', state: 'UNVERIFIED' },
    ],
    representation_agreements: [agreement('rep-disputed', 'pl-a'), agreement('rep-active', 'pl-b')],
    agreement_scopes: [
      { agreement_id: 'rep-disputed', ord: 0, scope: 'employment' },
      { agreement_id: 'rep-active', ord: 0, scope: 'employment' },
    ],
  };
}
const fixture = (dir, tables) => writeFixture(dir, { rows: tables });

// ======================================================= 1 — the tables
section('1 — the compliance tables: 0027 and 0028, each recorded once; the seeded policies are rows of 0027');
{
  const ids = TABLE_MIGRATIONS;
  ok(
    STEPS.every((id) => ids.filter((x) => x === id).length === 1) && SCHEMA_VERSION >= 28,
    `${STEPS.join(' and ')} are registered once each; the current schema is ${SCHEMA_VERSION}`,
  );
  neg(
    new Set(ids.map((id) => id.slice(0, 4))).size === ids.length,
    'every schema version is reached by exactly one migration — no number is used twice',
  );
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p1-'));
  const tables = stored(freshDir);
  for (const t of TABLE_STORES) ok(t in tables, `${t} is a table, not a collection`);
  const policies = tables.jurisdiction_policies;
  ok(
    policies.length === SEEDED_POLICY_VERSIONS.length &&
      policies
        .map((p) => p.id)
        .sort()
        .join() ===
        SEEDED_POLICY_VERSIONS.map((p) => p.id)
          .sort()
          .join(),
    `the ${SEEDED_POLICY_VERSIONS.length} policy versions are seeded (FIFA baseline, England 2026/27, USA)`,
  );
  ok(
    policies.every((p) => {
      const first = of(tables, 'jurisdiction_policy_history', { policy_id: p.id })[0];
      return (
        p.status === 'published' &&
        p.proposed_by_id === null &&
        p.approved_by_id === null &&
        first?.by_name === 'migration 0027_compliance_policies' &&
        first.detail_seeded === 1
      );
    }),
    'each seeded version is published, attributed to the migration, with no reviewer invented',
  );
  ok(
    policies.every((p) => {
      const rules = storedRules(tables, p.id);
      const encoded = SEEDED_POLICY_VERSIONS.find((v) => v.id === p.id).rules;
      return canonical(rules) === canonical(encoded) && Object.keys(rules).join() === Object.keys(encoded).join();
    }),
    "each seeded version's rules (statuses, sources, parameters, overrides) read back exactly as encoded",
  );
  neg(
    tables.ts_reviewers.length === 0 &&
      tables.regulatory_reviews.length === 0 &&
      tables.regulatory_consents.length === 0 &&
      tables.compliance_contexts.length === 0,
    'reviewers, reviews, consents and contexts start EMPTY — nobody is a reviewer by default',
  );
  neg(
    !complianceTables(tables).some((t) => /offer|negotiation|transaction/i.test(t)),
    'the compliance migrations create no offer, negotiation or transaction table (out of scope for compliance)',
  );
  const recordsBefore = appliedMigrations(freshDir);
  const again = stored(freshDir);
  ok(
    stableJson(again) === stableJson(tables) &&
      stableJson(appliedMigrations(freshDir)) === stableJson(recordsBefore) &&
      STEPS.every((id) => recordsBefore.filter((r) => r.id === id).length === 1),
    'reopening the file changes no table and records no migration again',
  );
}

// ======================================================= 2 — agent rows
section('2 — a database with agent rows: the compliance migrations invent nothing and touch nothing');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p2-'));
  const db = agencySnapshot();
  // What a migration could change: the facts of each agent row.
  const sorted = (xs, key) => xs.map(key).sort().join('|');
  const agentFacts = (d) =>
    stableJson([
      sorted(d.agent_profiles, (p) => [p.id, p.user_id, p.rev].join()),
      sorted(d.agent_profile_facets, (f) => [f.profile_id, f.facet, f.state, f.reference ?? null].join()),
      sorted(d.agency_affiliations, (a) => [a.id, a.user_id, a.rev, a.ended_at ?? null].join()),
      sorted(d.agency_affiliation_tiers, (t) => [t.affiliation_id, t.ord, t.tier].join()),
      sorted(d.representation_agreements, (r) => [r.id, r.client_id, r.status, r.rev, r.disputed_at ?? null].join()),
    ]);
  const agentBefore = agentFacts(db);
  fixture(dir, db);
  const back = stored(dir);
  neg(agentFacts(back) === agentBefore, 'every agent row reads back with its facets, tiers, status and rev unchanged');
  neg(
    sorted(back.org_users, (u) => `${u.id}:${u.name}:${u.role}`) ===
      sorted(db.org_users, (u) => `${u.id}:${u.name}:${u.role}`),
    'no user row was touched',
  );
  neg(
    back.regulatory_reviews.length === 0,
    'no review item is requested: a review is requested by the route that needs one',
  );
  neg(
    back.ts_reviewers.length === 0,
    'NO reviewer identity was invented by a migration (G-C0: production reviewers come from the operator bootstrap)',
  );
  ok(back.jurisdiction_policies.length === SEEDED_POLICY_VERSIONS.length, 'the seeded policy versions are there, once');
}

// ======================================================= 3 — boot over it
section('3 — a real boot over that database');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p3-'));
  const db = agencySnapshot();
  fixture(dir, db);
  const s = await bootOn(dir, PORT);
  ok(s.up, 'the server boots over a database carrying agent rows');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(
      h.body.schemaVersion === SCHEMA_VERSION && STEPS.every((id) => appliedMigrations(dir).some((r) => r.id === id)),
      `and reports ${SCHEMA_VERSION}, with the compliance migrations recorded`,
    );
    neg(
      expect(await s.j('GET', '/ts/compliance/reviews', undefined, null, ADMIN), 401, 'REVIEWER_AUTH_REQUIRED'),
      'the shared admin key has no reviewer lane over a migrated database either (G-C0)',
    );
    const priya = (
      await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })
    ).body;
    ok(priya?.token, 'a dev-seeded reviewer logs in (dev logins only; production uses TS_REVIEWER_BOOTSTRAP_*)');
    neg(
      (await s.j('GET', '/ts/compliance/reviews?status=PENDING', undefined, priya.token)).body?.items?.length === 0,
      'the boot raised no review item of its own',
    );
    // The three items a review needs are raised by the routes that need a human.
    const agent = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-ag',
        scoutName: 'Agent Person',
        role: 'Agent',
        platform: 'agent',
      })
    ).body;
    const lead = (
      await s.j('POST', '/auth/org/login', {
        orgId: 'org-ag',
        scoutName: 'Lead Person',
        role: 'Managing Director',
        platform: 'agent',
      })
    ).body;
    const pa = (await s.j('POST', '/auth/player/login', { playerId: 'pl-a' })).body;
    const f1 = await s.j(
      'POST',
      '/org/agent/profile/facets/national_registration/submit',
      { reference: 'FA-REAL-1', memberAssociation: 'ENG' },
      agent.token,
    );
    const f2 = await s.j(
      'POST',
      '/org/agent/profile/facets/fifa_licence/submit',
      { reference: 'FIFA-REAL-9' },
      lead.token,
    );
    const dp = await s.j(
      'POST',
      '/player/agent/relationships/rep-disputed/dispute',
      { reason: 'I never agreed to this.', expectedRev: 2 },
      pa.token,
    );
    if (f1.status !== 200 || f2.status !== 200 || dp.status !== 200)
      console.error(
        '   setup',
        f1.status,
        JSON.stringify(f1.body).slice(0, 200),
        f2.status,
        JSON.stringify(f2.body).slice(0, 200),
        dp.status,
        JSON.stringify(dp.body).slice(0, 200),
      );
    ok(
      f1.body?.profile?.facets.national_registration.ENG?.state === 'MANUAL_REVIEW_REQUIRED' &&
        f2.body?.profile?.facets.fifa_licence.state === 'MANUAL_REVIEW_REQUIRED' &&
        dp.body?.relationship?.status === 'disputed',
      'two real references with no provider answer need a human, and a client disputes a relationship',
    );
    const pending = await s.j('GET', '/ts/compliance/reviews?status=PENDING', undefined, priya.token);
    ok(
      pending.status === 200 &&
        pending.body.items.length === 3 &&
        pending.body.items.filter((r) => r.kind === 'verification_facet').length === 2 &&
        pending.body.items.filter((r) => r.kind === 'representation_dispute').length === 1,
      'the reviewer lane lists the three items',
    );
    neg(
      pending.body.items.every(
        (r) => !JSON.stringify(r.subject).includes('FA-REAL-1') && !JSON.stringify(r.subject).includes('FIFA-REAL-9'),
      ),
      'an item carries no reference text — the reviewer reads it from the profile when they open the item',
    );
    const item = pending.body.items.find((r) => r.kind === 'verification_facet' && r.subject.profileId === 'agp-1');
    const detail = item && (await s.j('GET', `/ts/compliance/reviews/${item.id}`, undefined, priya.token));
    ok(
      detail?.status === 200 &&
        detail.body.subjectDetail.reference === 'FA-REAL-1' &&
        detail.body.subjectDetail.state === 'MANUAL_REVIEW_REQUIRED',
      'opening an item shows the live reference and state from the profile',
    );
    const pol = await s.j('GET', '/ts/compliance/policies', undefined, priya.token);
    ok(
      pol.status === 200 &&
        pol.body.items.length === SEEDED_POLICY_VERSIONS.length &&
        pol.body.items.every((p) => p.status === 'published'),
      'the seeded policy versions are listed as published',
    );
    const ov = await s.j('GET', '/org/agent/compliance/overview', undefined, agent.token);
    ok(
      ov.status === 200 &&
        ov.body.reviews.some((r) => r.kind === 'verification_facet' && r.status === 'PENDING') &&
        ov.body.reviews.some((r) => r.kind === 'representation_dispute' && r.status === 'PENDING') &&
        stableJson(ov.body.facets.domestic_authorisation) === '{}',
      'the agent sees their pending facet item, the pending dispute item, and the (empty) domestic facet',
    );
    // The dispute item resolves through the attributed lane and the agreement moves — attributed to the reviewer.
    const disp = pending.body.items.find((r) => r.kind === 'representation_dispute');
    const rs =
      disp &&
      (await s.j(
        'POST',
        `/ts/compliance/reviews/${disp.id}/resolve`,
        {
          outcome: 'REJECTED',
          reasonCode: 'client_dispute_upheld',
          reason: 'The client did not confirm the relationship.',
        },
        priya.token,
      ));
    ok(
      rs?.status === 200 &&
        rs.body.review.decision.reviewer.id === 'tsr-dev-admin' &&
        rs.body.review.decision.resultingState.agreementStatus === 'terminated_by_client',
      'a dispute item is resolved by a NAMED reviewer and the relationship ends',
    );
    const after = await s.stop();
    ok(
      after.representation_agreements.find((x) => x.id === 'rep-disputed').termination_reason_code ===
        'dispute_upheld' &&
        after.regulatory_reviews.find((r) => r.id === disp?.id)?.decision_reviewer_id === 'tsr-dev-admin',
      'the decision is on disk, attributed',
    );
  }
}

// ======================================================= 4 — clean boot round trip
section('4 — clean boot → context → review → consent → revocation → stop → read back → reboot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p4-'));
  const port = await freePort();
  let s = await bootOn(dir, port);
  ok(s.up, 'clean boot');
  const j = s.j;
  const tomas = (
    await j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Tomás Rivera',
      role: 'Director',
      platform: 'agent',
    })
  ).body;
  await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
  const ana = (
    await j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Ana Costa',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  const prof = await j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, ana.token);
  const v1 = await j(
    'POST',
    '/org/agent/profile/facets/fifa_licence/submit',
    { reference: 'TEST-VERIFIED-ANA' },
    ana.token,
  );
  const v2 = await j(
    'POST',
    '/org/agent/profile/facets/national_registration/submit',
    { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' },
    ana.token,
  );
  ok(
    prof.status === 201 && v1.body.facet.state === 'VERIFIED' && v2.body.facet.state === 'VERIFIED',
    'profile created; licence and FA registration verified by the synthetic provider',
  );
  const req = await j(
    'POST',
    '/org/agent/clients/request',
    { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], jurisdiction: 'ENG' },
    ana.token,
  );
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const conf = await j(
    'POST',
    `/player/agent/relationships/${req.body.relationship.id}/confirm`,
    { expectedRev: 1 },
    kola.token,
  );
  ok(req.status === 201 && conf.body.relationship.status === 'active', 'Ana ↔ Kola confirmed');
  const REL = req.body.relationship.id;
  const create = await j(
    'POST',
    '/org/agent/compliance/contexts',
    {
      type: 'employment_contract',
      jurisdictions: ['ENG'],
      parties: [
        { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
        { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
      ],
      clientKey: 'rt-ctx',
    },
    ana.token,
  );
  ok(create.status === 201 && create.body.context.clearance.outcome === 'CLEAR', 'a context opens CLEAR');
  const CTX = create.body.context.id;
  const d1 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX}/representations`,
    { partyRole: 'individual', agreementId: REL, clientKey: 'rt-rep-1' },
    ana.token,
  );
  ok(
    d1.status === 201 && d1.body.representation.status === 'verified',
    'Ana records that she acts for Kola (single party: CLEAR)',
  );
  const d2 = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX}/representations`,
    { partyRole: 'engaging_entity', clientKey: 'rt-rep-2' },
    ana.token,
  );
  ok(
    expect(d2, 422, 'REGULATORY_REVIEW_REQUIRED') && d2.body.reviewId,
    'declaring the club (no ScoutBox agreement) raises an attributed review item',
  );
  const marcus = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-reviewer', secret: 'dev-reviewer' }))
    .body;
  await j('POST', `/ts/compliance/reviews/${d2.body.reviewId}/start`, { expectedRev: 1 }, marcus.token);
  const rs = await j(
    'POST',
    `/ts/compliance/reviews/${d2.body.reviewId}/resolve`,
    {
      outcome: 'APPROVED',
      reasonCode: 'club_mandate_seen',
      reason: 'Mandate letter examined.',
      evidenceRefs: ['Eastport FC mandate letter'],
      clientKey: 'rt-resolve',
    },
    marcus.token,
  );
  ok(
    rs.status === 200 &&
      rs.body.review.decision.resultingState.representationStatus === 'verified' &&
      rs.body.review.decision.resultingState.contextOutcome === PERMITTED_WITH_CONSENT,
    'Marcus confirms the fact; the context is now PERMITTED_WITH_CONSENT',
  );
  const cr = await j(
    'POST',
    `/org/agent/compliance/contexts/${CTX}/consents/request`,
    {
      partyRole: 'individual',
      fullParticularsProvided: true,
      legalAdviceOffered: true,
      proposedFeeDisclosed: true,
      clientKey: 'rt-cons',
    },
    ana.token,
  );
  ok(cr.status === 201, 'consent requested from Kola');
  const CONSENT = cr.body.consent.id;
  const gr = await j(
    'POST',
    `/player/agent/consents/${CONSENT}/grant`,
    { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, clientKey: 'rt-grant' },
    kola.token,
  );
  ok(gr.status === 200 && gr.body.consent.status === 'granted', 'Kola grants');
  const rv = await j('POST', `/player/agent/consents/${CONSENT}/revoke`, { clientKey: 'rt-revoke' }, kola.token);
  ok(rv.status === 200 && rv.body.consent.status === 'revoked', 'Kola revokes');
  const beforeStop = {
    ctx: (await j('GET', `/org/agent/compliance/contexts/${CTX}`, undefined, ana.token)).body,
    consents: (await j('GET', '/player/agent/consents', undefined, kola.token)).body,
    review: (await j('GET', `/ts/compliance/reviews/${d2.body.reviewId}`, undefined, marcus.token)).body,
    overview: (await j('GET', '/org/agent/compliance/overview', undefined, ana.token)).body,
  };
  ok(
    beforeStop.ctx.context.clearance.outcome === PERMITTED_WITH_CONSENT &&
      beforeStop.ctx.context.clearance.consentsOutstanding.some(
        (x) => x.partyRole === 'individual' && x.reasonCode === 'CONSENT_REVOKED',
      ),
    'before the stop: consent outstanding again, named as revoked',
  );
  const snap = await s.stop();
  const recordsAtStop = appliedMigrations(dir);
  ok(
    snap &&
      Number(recordsAtStop.at(-1)?.id.slice(0, 4)) === SCHEMA_VERSION &&
      snap.compliance_contexts.length === 1 &&
      snap.regulatory_reviews.length === 1 &&
      snap.ts_reviewers.length === 3,
    `the file holds one context, one review, the three dev reviewers, at schema ${SCHEMA_VERSION}`,
  );
  const ctxRow = snap.compliance_contexts[0];
  const reps = of(snap, 'compliance_context_representations', { context_id: ctxRow.id });
  const evaluations = of(snap, 'compliance_evaluations', { context_id: ctxRow.id });
  if (!(ctxRow.create_key === 'rt-ctx' && reps.length === 2 && evaluations.length >= 4 && ctxRow.rev >= 4))
    console.error(
      '   ctx row',
      JSON.stringify({
        key: ctxRow.create_key,
        reps: reps.map((r) => [r.party_role, r.status, r.declare_key]),
        evaluations: evaluations.length,
        rev: ctxRow.rev,
      }),
    );
  ok(
    ctxRow.create_key === 'rt-ctx' &&
      reps.length === 2 &&
      reps[0].declare_key === 'rt-rep-1' &&
      reps[1].declare_key === 'rt-rep-2' &&
      evaluations.length >= 4 &&
      ctxRow.rev >= 4,
    'keys, both representations, the evaluation history and the rev are on disk',
  );
  neg(
    evaluations.every(
      (e) =>
        typeof e.input_hash === 'string' &&
        of(snap, 'compliance_evaluation_policy_versions', { evaluation_id: e.id }).length === 2,
    ),
    'every stored evaluation names its input hash and its two policy versions',
  );
  const granted = snap.regulatory_consents.find((k) => k.id === CONSENT);
  const revocation = snap.regulatory_consent_revocations.find((k) => k.consent_id === CONSENT);
  neg(
    snap.regulatory_consents.length === 1 &&
      snap.regulatory_consent_revocations.length === 1 &&
      granted.status === 'granted' &&
      !Object.keys(granted).some((c) => c.startsWith('revoked')) &&
      revocation &&
      revocation.revoked_at >= granted.granted_at &&
      granted.request_key === 'rt-cons' &&
      granted.grant_key === 'rt-grant' &&
      granted.revoke_key === 'rt-revoke' &&
      revocation.by_kind === 'player',
    'the ledger is append-only on disk: the granted row is untouched (its status word stays "granted"; the revocation is derived), the revocation is its own attributed row, every key is stored',
  );
  const review = snap.regulatory_reviews[0];
  ok(
    review.status === 'APPROVED' &&
      review.decision_reviewer_id === 'tsr-dev-reviewer' &&
      of(snap, 'regulatory_review_evidence_refs', { review_id: review.id }).length === 1 &&
      review.resolve_key === 'rt-resolve' &&
      review.started_by_id === 'tsr-dev-reviewer',
    'the review decision, its evidence, its key and its attribution are on disk',
  );
  neg(
    snap.ts_reviewers.every(
      (r) => typeof r.secret_hash === 'string' && !('secret' in r) && !Object.keys(r).some((c) => /password/.test(c)),
    ),
    'reviewer rows hold a hash and never a plaintext secret',
  );
  ok(
    snap.sessions.some((x) => x.kind === 'ts_reviewer' && x.ref_id === 'tsr-dev-reviewer'),
    'the reviewer session is on disk',
  );
  neg(
    !Object.keys(ctxRow).some((c) => /room|offer|fee/.test(c)),
    'the context row carries no room, offer or fee field',
  );
  s = await bootOn(dir, await freePort());
  ok(s.up && (await s.j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION, `reboot at ${SCHEMA_VERSION}`);
  neg(
    stableJson(appliedMigrations(dir)) === stableJson(recordsAtStop),
    'no migration ran again (every record keeps its original time)',
  );
  const ana2 = (
    await s.j('POST', '/auth/org/login', {
      orgId: 'org-northstar',
      scoutName: 'Ana Costa',
      role: 'Agent',
      platform: 'agent',
    })
  ).body;
  const kola2 = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const after = {
    ctx: (await s.j('GET', `/org/agent/compliance/contexts/${CTX}`, undefined, ana2.token)).body,
    consents: (await s.j('GET', '/player/agent/consents', undefined, kola2.token)).body,
    review: (await s.j('GET', `/ts/compliance/reviews/${d2.body.reviewId}`, undefined, marcus.token)).body,
    overview: (await s.j('GET', '/org/agent/compliance/overview', undefined, ana2.token)).body,
  };
  ok(
    stableJson(after.ctx.context) === stableJson(beforeStop.ctx.context),
    'the context projects identically after the restart (clearance, representations, evaluations, rev)',
  );
  ok(stableJson(after.consents) === stableJson(beforeStop.consents), "the player's consent view projects identically");
  ok(
    after.review.review && stableJson(after.review.review) === stableJson(beforeStop.review.review),
    "the review projects identically — and the reviewer's pre-restart session still works",
  );
  ok(
    stableJson(after.overview.contexts) === stableJson(beforeStop.overview.contexts) &&
      stableJson(after.overview.facets) === stableJson(beforeStop.overview.facets),
    'the agent overview projects identically',
  );
  ok(
    (
      await s.j(
        'POST',
        '/org/agent/compliance/contexts',
        {
          type: 'employment_contract',
          jurisdictions: ['ENG'],
          parties: [
            { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' },
            { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' },
          ],
          clientKey: 'rt-ctx',
        },
        ana2.token,
      )
    ).body.idempotent === true,
    'the context key replays after the restart',
  );
  ok(
    (
      await s.j(
        'POST',
        `/org/agent/compliance/contexts/${CTX}/representations`,
        { partyRole: 'individual', agreementId: REL, clientKey: 'rt-rep-1' },
        ana2.token,
      )
    ).body.idempotent === true,
    'the declaration key replays',
  );
  ok(
    (
      await s.j(
        'POST',
        `/ts/compliance/reviews/${d2.body.reviewId}/resolve`,
        {
          outcome: 'APPROVED',
          reasonCode: 'club_mandate_seen',
          reason: 'Mandate letter examined.',
          evidenceRefs: ['Eastport FC mandate letter'],
          clientKey: 'rt-resolve',
        },
        marcus.token,
      )
    ).body.idempotent === true,
    'the resolution key replays',
  );
  neg(
    expect(
      await s.j(
        'POST',
        `/player/agent/consents/${CONSENT}/grant`,
        { acknowledgedParticulars: true, acknowledgedLegalAdvice: true },
        kola2.token,
      ),
      409,
      'CONSENT_NOT_PENDING',
    ),
    'a revoked consent cannot be re-granted after the restart — a new request is needed',
  );
  const ev = await s.j('POST', `/org/agent/compliance/contexts/${CTX}/evaluate`, {}, ana2.token);
  const same = (e) =>
    stableJson({
      o: e.outcome,
      r: e.reasons.map((x) => [x.code, x.ruleId, x.ruleStatus]),
      c: e.consentsOutstanding.map((x) => [x.partyRole, x.reasonCode]),
      p: e.policyVersions,
    });
  ok(
    ev.status === 200 &&
      same(ev.body.evaluation) === same(beforeStop.ctx.context.clearance) &&
      ev.body.evaluation.inputHash !== beforeStop.ctx.context.clearance.inputHash,
    'a fresh evaluation over the same facts yields the same outcome, reasons, outstanding consents and versions — a new clock, so a new input hash, but the same verdict',
  );
  const snap2 = await s.stop();
  ok(
    STEPS.every((id) => appliedMigrations(dir).filter((r) => r.id === id).length === 1) &&
      snap2.ts_reviewers.length === 3,
    'one record per compliance migration, still; the dev reviewers were not seeded twice',
  );
}

// ======================================================= 5 — corruption
section('5 — corruption on disk is contained, named by its effect, never repaired');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p5-'));
  const db = agencySnapshot();
  // (a) a review whose stored snapshot says PROHIBITED — nobody can approve it. A review naming a context that
  // is not there is not a row the typed table can hold (its key refuses it); the same snapshot on an
  // Approach item (no context) is, and stays planted.
  const prohibited = (subject) => ({
    regulatory_reviews: [
      {
        id: 'rrv-prohibited',
        kind: 'conflict_evaluation',
        status: 'PENDING',
        agency_org_id: 'org-ag',
        agent_user_id: 'usr-agent',
        subject_is_approach: 0,
        ...subject,
        snapshot_outcome: 'PROHIBITED_CONFLICT',
        requested_at: T0,
        requested_by_kind: 'system',
        requested_by_name: 'fixture',
        rev: 1,
        rev_at: T0,
      },
    ],
    regulatory_review_reasons: [
      {
        review_id: 'rrv-prohibited',
        ord: 0,
        code: 'PROHIBITED_COMBINATION',
        rule_id: 'ENG-6.4',
        rule_status: 'ACTIVE',
        policy_version_id: 'jp-eng-2026-27-1',
      },
    ],
    regulatory_review_policy_versions: [{ review_id: 'rrv-prohibited', ord: 0, policy_version_id: 'jp-eng-2026-27-1' }],
  });
  let refusedCtx = null;
  try {
    fixture(mkdtempSync(path.join(tmpdir(), 'sbx-m25p5a-')), {
      ...db,
      ...prohibited({ subject_context_id: 'ctx-gone', subject_party_role: 'releasing_entity' }),
    });
  } catch (e) {
    refusedCtx = e;
  }
  neg(
    /FOREIGN KEY constraint failed/.test(refusedCtx?.message),
    `a review naming a context that is not there is refused by its key (${refusedCtx?.message})`,
  );
  Object.assign(db, prohibited({ subject_is_approach: 1, subject_player_id: 'pl-b', subject_jurisdiction: 'ENG' }));
  // (b) a reviewer row with an unknown status word — injected after the first boot below.
  fixture(dir, db);
  // First boot: the dev reviewers are seeded only into an EMPTY reviewer store — so the odd row is injected after that.
  const s0 = await bootOn(dir, await freePort());
  ok(s0.up, 'a first boot seeds the dev reviewers (empty store)');
  const seeded = await s0.stop();
  ok(seeded.ts_reviewers.length === 3, 'three dev reviewers on disk');
  // A reviewer row with an unknown status word is not a row the typed table can hold: the schema refuses it, and
  // nothing is written. (The repository's own refusal, naming the row and the field, is testCompliancePolicies'.)
  const odd = {
    id: 'tsr-odd',
    name: 'Odd Reviewer',
    role: 'trust_safety_admin',
    status: 'enabled',
    secret_hash: 'not-a-hash',
    created_at: T0,
    created_by_kind: 'system',
    created_by_name: 'fixture',
    rev: 1,
    rev_at: T0,
  };
  let refused = null;
  try {
    fixture(dir, { ts_reviewers: [odd] });
  } catch (e) {
    refused = e;
  }
  neg(
    /CHECK constraint failed/.test(refused?.message) && /status/.test(refused.message),
    `a reviewer row with status "enabled" (unknown) is refused by the schema, naming the field (${refused?.message})`,
  );
  neg(rows(dir, 'ts_reviewers').length === 3, 'and nothing was written: the three seeds are still the reviewers');
  const s = await bootOn(dir, await freePort());
  ok(s.up, 'the server boots over the corrupt rows');
  if (s.up) {
    neg(
      expect(
        await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-odd', secret: 'anything' }),
        401,
        'REVIEWER_CREDENTIALS_INVALID',
      ),
      'the refused reviewer cannot log in — only an active reviewer can',
    );
    const priya = (
      await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })
    ).body;
    ok(
      !!priya?.token && (await s.j('GET', '/ts/reviewers', undefined, priya.token)).body.items.length === 3,
      'a real reviewer logs in; the three seeds are listed and nothing else',
    );
    neg(
      expect(
        await s.j(
          'POST',
          '/ts/compliance/reviews/rrv-prohibited/resolve',
          { outcome: 'APPROVED', reasonCode: 'x', reason: 'looks fine', evidenceRefs: ['e'] },
          priya.token,
        ),
        409,
        'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE',
      ),
      'an administrator cannot approve a review whose snapshot is PROHIBITED under an ACTIVE rule',
    );
    const rej = await s.j(
      'POST',
      '/ts/compliance/reviews/rrv-prohibited/resolve',
      { outcome: 'REJECTED', reasonCode: 'prohibited', reason: 'Prohibited; closed.' },
      priya.token,
    );
    ok(
      rej.status === 200 &&
        rej.body.review.status === 'REJECTED' &&
        rej.body.review.decision.resultingState.note === 'context gone',
      'rejecting it works and says honestly that its context is gone',
    );
    const after = await s.stop();
    neg(
      !after.ts_reviewers.some((r) => r.id === 'tsr-odd') && after.ts_reviewers.every((r) => r.status === 'active'),
      'the failed login wrote no reviewer row and changed no status',
    );
    // Now wipe the policy store and boot again: nothing is CLEAR without an encoded policy. (The review that
    // names a version goes with it — a typed row cannot name a version that is not there.) No route deletes a policy
    // version, so the wipe is plain SQL on the file (the rules and history rows cascade).
    neg(after.regulatory_reviews.length === 1, '(the one review is the planted one)');
    const F = openFixture(dir);
    try {
      F.sql.exec('DELETE FROM regulatory_reviews; DELETE FROM jurisdiction_policies;');
    } finally {
      F.close();
    }
    const s2 = await bootOn(dir, await freePort());
    ok(s2.up, 'the server boots over an EMPTY policy store');
    if (s2.up) {
      const snap = stored(dir);
      neg(
        snap.jurisdiction_policies.length === 0,
        'boot did not re-seed the policies (the migration record says the step already ran)',
      );
      const agent = (
        await s2.j('POST', '/auth/org/login', {
          orgId: 'org-ag',
          scoutName: 'Agent Person',
          role: 'Agent',
          platform: 'agent',
        })
      ).body;
      const c = await s2.j(
        'POST',
        '/org/agent/compliance/contexts',
        {
          type: 'employment_contract',
          jurisdictions: ['ENG'],
          parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-b' }],
        },
        agent.token,
      );
      neg(
        expect(c, 422, 'JURISDICTION_UNSUPPORTED'),
        'with no policy encoded, opening an England context is JURISDICTION_UNSUPPORTED — never silently CLEAR',
      );
      const ov = await s2.j('GET', '/org/agent/compliance/overview', undefined, agent.token);
      neg(
        ov.status === 200 &&
          ov.body.policies.inEffect.length === 0 &&
          ov.body.policies.missing.includes('INT') &&
          ov.body.policies.missing.includes('ENG'),
        'the overview shows no policy version in effect and names INT and ENG as missing rather than inventing them',
      );
      await s2.stop();
    }
  }
}

console.log(
  `\nagents/compliancePersistence: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`,
);
if (process.exitCode) console.error('SOME CHECKS FAILED');
else console.log('all agents/compliancePersistence checks passed');
process.exit(process.exitCode ?? 0);
