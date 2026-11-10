// Persistence, migration and restart audit for the Conflict & Compliance Engine:
// (1) the compliance tables and their seeded policy versions, (2) the migrations
// invent no review or reviewer and change no agent row, (3) a real boot over
// typed agent rows, (4) a full round trip across a restart, (5) corruption on
// disk is contained and named. No migration bootstraps review items: a review is
// requested by the route that needs one, which section 3 exercises.
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openLayer, readRecords, writeFixture } from '../../scripts/dataLayerFixture.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { COMPLIANCE_POLICIES_MIGRATION, COMPLIANCE_POLICIES_TABLES } from '../../repositories/compliancePolicies.mjs';
import { COMPLIANCE_RECORDS_MIGRATION, COMPLIANCE_RECORDS_TABLES } from '../../repositories/complianceRecords.mjs';
import { SEEDED_POLICY_VERSIONS } from '../../domains/agents/compliance/policyVersions.mjs';
import { consentSufficiency, PERMITTED_WITH_CONSENT } from '../../domains/agents/compliance/conflict.mjs';
import { applicablePolicySet } from '../../domains/agents/compliance/policy.mjs';
import { newFacets } from '../../domains/agents/core/shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');
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
  const proc = spawn(process.execPath, [SERVER], {
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
    return readRecords(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = 6800 + Math.floor(Math.random() * 150);
const T0 = 1_700_000_000_000;
// Reviewers and policy versions come from migration 0027 (which inserts the seeded versions); contexts, reviews
// and consents from 0028.
const TABLE_STORES = [
  'tsReviewers',
  'jurisdictionPolicies',
  'regulatoryReviews',
  'regulatoryConsents',
  'complianceContexts',
];
const STEPS = [COMPLIANCE_POLICIES_MIGRATION, COMPLIANCE_RECORDS_MIGRATION];
const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => {
  const st = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try {
    return st
      .prepare('SELECT id, applied_at FROM data_migrations ORDER BY id')
      .all()
      .map((r) => ({ id: r.id, at: r.applied_at }));
  } finally {
    st.close();
  }
};

// ------------------------------------------------------------- fixtures

/** The writers' whole literals for the agent core rows (the repository refuses a partial record). */
const affiliation = (id, userId, tiers) => ({
  id,
  agencyOrgId: 'org-ag',
  userId,
  tiers,
  startedAt: T0,
  endedAt: null,
  endedReason: null,
  createdAt: T0,
  rev: 1,
  revAt: T0,
  revBy: null,
  keys: {},
  history: [],
});
const profile = (id, userId, displayName, jurisdictions, facets) => ({
  id,
  userId,
  agencyOrgId: 'org-ag',
  displayName,
  declared: { fifaLicenceNumber: null, jurisdictions },
  facets: { ...newFacets(), ...facets },
  createdAt: T0,
  updatedAt: T0,
  rev: 1,
  revAt: T0,
  revBy: null,
  history: [],
});
const agreement = (id, clientId) => ({
  id,
  agentUserId: 'usr-agent',
  agencyOrgId: 'org-ag',
  clientKind: 'player',
  clientId,
  jurisdiction: 'ENG',
  exclusive: false,
  termMonths: 12,
  startAt: T0 + 10,
  endAt: Date.now() + 1e10,
  status: 'active',
  proposedAt: T0,
  confirmedAt: T0 + 10,
  confirmedBy: { kind: 'player', id: clientId },
  declinedAt: null,
  terminatedAt: null,
  terminatedBy: null,
  terminationReasonCode: null,
  disputedAt: null,
  disputeReason: null,
  shareWithAgencyStaff: false,
  scope: ['employment'],
  policyVersions: [],
  keys: {},
  createdAt: T0,
  rev: 2,
  revAt: T0 + 10,
  revBy: null,
  history: [],
});

/** One agency with a licensed agent (licence VERIFIED) and a licensed administrator, two active agreements. */
function agencySnapshot() {
  return {
    players: [
      {
        id: 'pl-a',
        name: 'Adult A',
        dob: '1999-01-01',
        country: 'GB',
        city: 'London',
        media: [],
        attendance: [],
        trialReports: [],
        badges: [],
        timeline: [],
        medical: { shared: false, records: [], conditionStatus: 'unknown' },
        level: 'amateur',
        location: { lat: 51.5, lng: -0.1 },
      },
      {
        id: 'pl-b',
        name: 'Adult B',
        dob: '1998-01-01',
        country: 'GB',
        city: 'London',
        media: [],
        attendance: [],
        trialReports: [],
        badges: [],
        timeline: [],
        medical: { shared: false, records: [], conditionStatus: 'unknown' },
        level: 'amateur',
        location: { lat: 51.5, lng: -0.1 },
      },
    ],
    orgs: [
      {
        id: 'org-club',
        name: 'Club',
        type: 'club',
        level: 'pro',
        plan: 'Pro',
        verified: true,
        safeguardingContractSigned: true,
        location: { lat: 51.5, lng: -0.1 },
      },
      {
        id: 'org-ag',
        name: 'Agency',
        type: 'agency',
        level: 'agency',
        plan: 'Agency',
        verified: false,
        location: null,
      },
    ],
    guardians: [],
    sessions: [],
    ledger: [],
    notifications: [],
    blocks: [],
    users: [
      { id: 'usr-lead', orgId: 'org-ag', name: 'Lead Person', role: 'Managing Director', createdAt: T0 },
      { id: 'usr-agent', orgId: 'org-ag', name: 'Agent Person', role: 'Agent', createdAt: T0 + 1 },
    ],
    // The Agent core rows, as typed tables write them.
    agencyAffiliations: [
      affiliation('aff-lead', 'usr-lead', ['agency_admin', 'licensed_agent']),
      affiliation('aff-agent', 'usr-agent', ['licensed_agent']),
    ],
    agentProfiles: [
      profile('agp-1', 'usr-agent', 'Agent Person', ['ENG', 'INT'], {
        fifa_licence: {
          ...newFacets().fifa_licence,
          state: 'VERIFIED',
          reference: 'TEST-VERIFIED-1',
          provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: T0 },
          submittedAt: T0,
          verifiedAt: T0,
          recheckAt: Date.now() + 20 * 86_400_000,
          note: 'x',
        },
      }),
      profile('agp-2', 'usr-lead', 'Lead Person', ['INT'], {}),
    ],
    representationAgreements: [agreement('rep-disputed', 'pl-a'), agreement('rep-active', 'pl-b')],
  };
}

// ======================================================= 1 — the tables
section('1 — the compliance tables: 0027 and 0028, each recorded once; the seeded policies are rows of 0027');
{
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  ok(
    STEPS.every((id) => ids.filter((x) => x === id).length === 1) && SCHEMA_VERSION >= 28,
    `${STEPS.join(' and ')} are registered once each; the current schema is ${SCHEMA_VERSION}`,
  );
  neg(
    new Set(ids.map((id) => id.slice(0, 4))).size === ids.length,
    'every schema version is reached by exactly one migration — no number is used twice',
  );
  for (const s of TABLE_STORES) ok(TABLE_BACKED.includes(s), `${s} is a table, not a collection`);
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p1-'));
  const tables = readRecords(freshDir);
  ok(
    tables.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length &&
      tables.jurisdictionPolicies
        .map((p) => p.id)
        .sort()
        .join() ===
        SEEDED_POLICY_VERSIONS.map((p) => p.id)
          .sort()
          .join(),
    `the ${SEEDED_POLICY_VERSIONS.length} policy versions are seeded (FIFA baseline, England 2026/27, USA)`,
  );
  ok(
    tables.jurisdictionPolicies.every(
      (p) =>
        p.status === 'published' &&
        p.proposedBy === null &&
        p.approvedBy === null &&
        p.history[0].by.name === 'migration 0027_compliance_policies' &&
        p.history[0].detail.seeded === true,
    ),
    'each seeded version is published, attributed to the migration, with no reviewer invented',
  );
  ok(
    tables.jurisdictionPolicies.every(
      (p) => stableJson(p.rules) === stableJson(SEEDED_POLICY_VERSIONS.find((v) => v.id === p.id).rules),
    ),
    "each seeded version's rules (statuses, sources, parameters, overrides) read back exactly as encoded",
  );
  neg(
    tables.tsReviewers.length === 0 &&
      tables.regulatoryReviews.length === 0 &&
      tables.regulatoryConsents.length === 0 &&
      tables.complianceContexts.length === 0,
    'reviewers, reviews, consents and contexts start EMPTY — nobody is a reviewer by default',
  );
  neg(
    ![...COMPLIANCE_POLICIES_TABLES, ...COMPLIANCE_RECORDS_TABLES].some((t) =>
      /offer|negotiation|transaction/i.test(t),
    ),
    'the compliance migrations create no offer, negotiation or transaction table (out of scope for compliance)',
  );
  const recordsBefore = appliedMigrations(freshDir);
  const again = readRecords(freshDir);
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
  // What a migration could change: the facts of each agent row (the table reads its own key order back).
  const agentFacts = (d) =>
    stableJson([
      d.agentProfiles.map((p) => [
        p.id,
        p.userId,
        p.rev,
        Object.entries(p.facets).map(([k, f]) => [k, f.state ?? null, f.reference ?? null]),
      ]),
      d.agencyAffiliations.map((a) => [a.id, a.userId, a.tiers, a.rev, a.endedAt]),
      d.representationAgreements.map((r) => [r.id, r.clientId, r.status, r.rev, r.disputedAt]),
    ]);
  const agentBefore = agentFacts(db);
  writeFixture(dir, db);
  const back = readRecords(dir);
  neg(agentFacts(back) === agentBefore, 'every agent row reads back with its facets, tiers, status and rev unchanged');
  neg(
    back.users.map((u) => `${u.id}:${u.name}:${u.role}`).join() ===
      db.users.map((u) => `${u.id}:${u.name}:${u.role}`).join(),
    'no user row was touched',
  );
  neg(
    back.regulatoryReviews.length === 0,
    'no review item is requested: a review is requested by the route that needs one',
  );
  neg(
    back.tsReviewers.length === 0,
    'NO reviewer identity was invented by a migration (G-C0: production reviewers come from the operator bootstrap)',
  );
  ok(back.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length, 'the seeded policy versions are there, once');
}

// ======================================================= 3 — boot over it
section('3 — a real boot over that database');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p3-'));
  const db = agencySnapshot();
  writeFixture(dir, db);
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
      after.representationAgreements.find((x) => x.id === 'rep-disputed').terminationReasonCode === 'dispute_upheld' &&
        after.regulatoryReviews.find((r) => r.id === disp?.id)?.decision.reviewerId === 'tsr-dev-admin',
      'the decision is on disk, attributed',
    );
  }
}

// ======================================================= 4 — clean boot round trip
section('4 — clean boot → context → review → consent → revocation → stop → read back → reboot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p4-'));
  const port = PORT + 1;
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
      snap.complianceContexts.length === 1 &&
      snap.regulatoryReviews.length === 1 &&
      snap.tsReviewers.length === 3,
    `the file holds one context, one review, the three dev reviewers, at schema ${SCHEMA_VERSION}`,
  );
  const ctxRow = snap.complianceContexts[0];
  if (
    !(
      ctxRow.keys?.create?.key === 'rt-ctx' &&
      ctxRow.representations.length === 2 &&
      ctxRow.evaluations?.length >= 4 &&
      ctxRow.rev >= 4
    )
  )
    console.error(
      '   ctx row',
      JSON.stringify({
        keys: ctxRow.keys,
        reps: ctxRow.representations.map((r) => [r.partyRole, r.status, r.keys]),
        evaluations: ctxRow.evaluations?.length,
        rev: ctxRow.rev,
      }),
    );
  ok(
    ctxRow.keys.create.key === 'rt-ctx' &&
      ctxRow.representations.length === 2 &&
      ctxRow.representations[0].keys.declare.key === 'rt-rep-1' &&
      ctxRow.representations[1].keys.declare.key === 'rt-rep-2' &&
      ctxRow.evaluations.length >= 4 &&
      ctxRow.rev >= 4,
    'keys, both representations, the evaluation history and the rev are on disk',
  );
  neg(
    ctxRow.evaluations.every(
      (e) => typeof e.inputHash === 'string' && Array.isArray(e.policyVersions) && e.policyVersions.length === 2,
    ),
    'every stored evaluation names its input hash and its two policy versions',
  );
  const ledger = snap.regulatoryConsents;
  const granted = ledger.find((k) => k.id === CONSENT);
  const revocation = ledger.find((k) => k.kind === 'revocation' && k.of === CONSENT);
  neg(
    ledger.length === 2 &&
      granted.status === 'granted' &&
      granted.revokedAt === undefined &&
      revocation &&
      revocation.at >= granted.grantedAt &&
      granted.keys.request.key === 'rt-cons' &&
      granted.keys.grant.key === 'rt-grant' &&
      granted.keys.revoke.key === 'rt-revoke' &&
      revocation.by?.kind === 'player',
    'the ledger is append-only on disk: the granted row is untouched (its status word stays "granted"; the revocation is derived), the revocation is its own attributed row, every key is stored',
  );
  const review = snap.regulatoryReviews[0];
  ok(
    review.status === 'APPROVED' &&
      review.decision.reviewerId === 'tsr-dev-reviewer' &&
      review.decision.evidenceRefs.length === 1 &&
      review.keys.resolve.key === 'rt-resolve' &&
      review.startedBy.id === 'tsr-dev-reviewer',
    'the review decision, its evidence, its key and its attribution are on disk',
  );
  neg(
    snap.tsReviewers.every(
      (r) => typeof r.secretHash === 'string' && r.secret === undefined && r.password === undefined,
    ),
    'reviewer rows hold a hash and never a plaintext secret',
  );
  ok(
    snap.sessions.some((x) => x.kind === 'ts_reviewer' && x.refId === 'tsr-dev-reviewer'),
    'the reviewer session is on disk',
  );
  neg(
    !('transactionRoomId' in ctxRow) && !('offer' in ctxRow) && !('fee' in ctxRow),
    'the context row carries no room, offer or fee field',
  );
  s = await bootOn(dir, port + 1);
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
      snap2.tsReviewers.length === 3,
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
    id: 'rrv-prohibited',
    kind: 'conflict_evaluation',
    status: 'PENDING',
    agencyOrgId: 'org-ag',
    agentUserId: 'usr-agent',
    subject,
    reasons: [
      { code: 'PROHIBITED_COMBINATION', ruleId: 'ENG-6.4', ruleStatus: 'ACTIVE', policyVersion: 'jp-eng-2026-27-1' },
    ],
    policyVersions: ['jp-eng-2026-27-1'],
    snapshot: { outcome: 'PROHIBITED_CONFLICT' },
    requestedAt: T0,
    requestedBy: { kind: 'system', userId: null, name: 'fixture' },
    startedAt: null,
    startedBy: null,
    decidedAt: null,
    decision: null,
    supersedes: null,
    supersededBy: null,
    keys: {},
    rev: 1,
    revAt: T0,
    revBy: null,
    history: [],
  });
  let refusedCtx = null;
  try {
    writeFixture(mkdtempSync(path.join(tmpdir(), 'sbx-m25p5a-')), {
      ...db,
      regulatoryReviews: [prohibited({ contextId: 'ctx-gone', representationId: null, partyRole: 'releasing_entity' })],
    });
  } catch (e) {
    refusedCtx = e;
  }
  neg(
    /FOREIGN KEY constraint failed/.test(refusedCtx?.message),
    `a review naming a context that is not there is refused by its key (${refusedCtx?.message})`,
  );
  db.regulatoryReviews = [prohibited({ approach: true, playerId: 'pl-b', jurisdiction: 'ENG' })];
  // (b) a reviewer row with an unknown status word — injected after the first boot below.
  // (c) a consent naming a policy version that does not exist (pure).
  const stale = consentSufficiency(
    {
      kind: 'dual_representation',
      status: 'granted',
      grantedAt: T0,
      contextId: 'c',
      agentUserId: 'a',
      partyRole: 'individual',
      policyVersions: ['jp-eng-1999-1'],
      grantedBy: { kind: 'player', id: 'p' },
      particulars: { fullParticularsProvided: true, legalAdviceOffered: true },
    },
    {
      partyRole: 'individual',
      agentUserId: 'a',
      contextId: 'c',
      activePolicyIds: ['jp-eng-2026-27-1'],
      requireParticulars: true,
    },
  );
  neg(
    stale.ok === false && stale.reasonCode === 'CONSENT_POLICY_VERSION_STALE',
    'a consent naming an unknown policy version is insufficient (pure engine)',
  );
  // (d) an emptied policy store: no jurisdiction is encoded any more.
  const missing = applicablePolicySet([], ['ENG'], Date.now());
  neg(
    missing.policies.length === 0 && missing.missing.includes('ENG') && missing.missing.includes('INT'),
    'with no policy rows the policy set is empty and both INT and ENG are reported missing (pure)',
  );
  writeFixture(dir, db);
  // First boot: the dev reviewers are seeded only into an EMPTY reviewer store — so the odd row is injected after that.
  const s0 = await bootOn(dir, PORT + 2);
  ok(s0.up, 'a first boot seeds the dev reviewers (empty store)');
  const seeded = await s0.stop();
  ok(seeded.tsReviewers.length === 3, 'three dev reviewers on disk');
  // A reviewer row with an unknown status word is not a row the typed table can hold: the repository refuses
  // it, naming it, and nothing is written.
  const odd = {
    id: 'tsr-odd',
    name: 'Odd Reviewer',
    role: 'trust_safety_admin',
    status: 'enabled',
    secretHash: 'not-a-hash',
    createdAt: T0,
    createdBy: { kind: 'system', userId: null, name: 'fixture' },
    revokedAt: null,
    revokedBy: null,
    rev: 1,
    revAt: T0,
    revBy: null,
    history: [],
  };
  let refused = null;
  try {
    writeFixture(dir, { tsReviewers: [odd] });
  } catch (e) {
    refused = e;
  }
  neg(
    refused?.code === 'COMPLIANCE_POLICIES_INPUT_INVALID' &&
      /tsr-odd/.test(refused.message) &&
      /status/.test(refused.message),
    `a reviewer row with status "enabled" (unknown) is refused by the repository, naming the row and the field (${refused?.message})`,
  );
  neg(readRecords(dir).tsReviewers.length === 3, 'and nothing was written: the three seeds are still the reviewers');
  const s = await bootOn(dir, PORT + 3);
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
      !after.tsReviewers.some((r) => r.id === 'tsr-odd') && after.tsReviewers.every((r) => r.status === 'active'),
      'the failed login wrote no reviewer row and changed no status',
    );
    // Now wipe the policy store and boot again: nothing is CLEAR without an encoded policy. (The review that
    // names a version goes with it — a typed row cannot name a version that is not there.) No route deletes a policy
    // version, so the wipe is plain SQL on the file (the rules and history rows cascade).
    neg(after.regulatoryReviews.length === 1, '(the one review is the planted one)');
    const L = openLayer(dir);
    try {
      L.sqlite.exec('DELETE FROM regulatory_reviews; DELETE FROM jurisdiction_policies;');
    } finally {
      L.close();
    }
    const s2 = await bootOn(dir, PORT + 4);
    ok(s2.up, 'the server boots over an EMPTY policy store');
    if (s2.up) {
      const snap = readRecords(dir);
      neg(
        snap.jurisdictionPolicies.length === 0,
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
