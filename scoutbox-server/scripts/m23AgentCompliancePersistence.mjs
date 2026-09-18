// M23 P5.6C — persistence, migration and restart audit for the Conflict &
// Compliance Engine.
//
//   1  schema 2306: exactly one step above 2305, five stores on a clean
//      database (three SEEDED policy versions, everything else empty),
//      idempotent, and every P5.6C store is production-required
//   2  upgrade from a 2305 snapshot: the policy versions are seeded as
//      published rows attributed to the migration, every profile gains an
//      EMPTY domestic_authorisation container, a facet already sitting in
//      MANUAL_REVIEW_REQUIRED and a relationship already `disputed` get ONE
//      pending attributed review item each, no reviewer identity is invented,
//      no other byte of a profile or an agreement changes, and a re-run (even
//      a partial one) creates nothing twice
//   3  a real boot over that snapshot: /healthz 2306, the migrated items are
//      visible in the reviewer lane requested by the migration, the seeded
//      policies are listed as published, and the shared admin key still has
//      no reviewer lane (G-C0)
//   4  clean boot → context → declared representation → attributed review →
//      consent → revocation → stop → snapshot → reboot: bytes survive
//      (ledger rows incl. the revocation row, evaluations, revs, keys, the
//      reviewer session), dev reviewers are not re-seeded, the 2306 step does
//      not run twice, and every key replays
//   5  corruption on disk is contained and named: a review whose snapshot is
//      PROHIBITED cannot be approved by anyone, a wiped policy store makes
//      every jurisdiction unsupported (never silently CLEAR), a consent that
//      names an unknown policy version is insufficient, and a reviewer row
//      with an unknown status cannot log in
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_VERSION, runMigrations, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { openStore } from '../store.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { SEEDED_POLICY_VERSIONS } from '../m25/policyVersions.mjs';
import { consentSufficiency, PERMITTED_WITH_CONSENT } from '../m25/conflict.mjs';
import { applicablePolicySet } from '../m25/policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stableJson = (v) => JSON.stringify(v);
const expect = (r, status, code) => { const good = r.status === status && (code === null || r.body?.error === code); if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return good; };

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });

async function bootOn(dataDir, port) {
  const base = `http://localhost:${port}`;
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let log = '';
  proc.stdout.on('data', (b) => { log += b; }); proc.stderr.on('data', (b) => { log += b; });
  proc.unref(); proc.stdout.unref(); proc.stderr.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    if (proc.exitCode != null) return { up: false, log: () => log };
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  const j = async (method, url, body, token, extra = {}) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* non-json */ }
    return { status: r.status, body: data };
  };
  const stop = async () => {
    proc.kill('SIGTERM');
    for (let i = 0; i < 60 && proc.exitCode == null; i += 1) await sleep(100);
    return openStore(dataDir).load()?.db ?? null;
  };
  return { up, j, stop, log: () => log };
}

const PORT = 6800 + Math.floor(Math.random() * 150);
const T0 = 1_700_000_000_000;
const STORES = ['tsReviewers', 'jurisdictionPolicies', 'regulatoryReviews', 'regulatoryConsents', 'complianceContexts'];
const STEP = 'm250_001_compliance_stores';

// ------------------------------------------------------------- fixtures

/** A 2305 database: one agency with a licensed agent whose facets are in mixed states, one disputed and one active agreement. */
function snapshot2305() {
  const db = {
    players: [
      { id: 'pl-a', name: 'Adult A', dob: '1999-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
      { id: 'pl-b', name: 'Adult B', dob: '1998-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
    ],
    orgs: [
      { id: 'org-club', name: 'Club', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, squad: [], location: { lat: 51.5, lng: -0.1 } },
      { id: 'org-ag', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: false, squad: [], location: null },
    ],
    guardians: [], sessions: [], ledger: [], notifications: [], blocks: [],
    users: [
      { id: 'usr-lead', orgId: 'org-ag', name: 'Lead Person', role: 'Managing Director', createdAt: T0 },
      { id: 'usr-agent', orgId: 'org-ag', name: 'Agent Person', role: 'Agent', createdAt: T0 + 1 },
    ],
    representations: [],
  };
  runMigrations(db);
  // Now REWIND to a 2305 snapshot: drop the P5.6C step and its stores.
  db.schema.version = 2305;
  db.schema.migrations = db.schema.migrations.filter((m) => m.id !== STEP);
  for (const s of STORES) delete db[s];
  // The Agent core (2305) rows this snapshot carries.
  // The 2305 step bootstrapped 'Agent Person' as an assistant (a self-typed role is not a licence); an administrator later granted the licensed tier.
  db.agencyAffiliations.find((a) => a.userId === 'usr-agent').tiers = ['licensed_agent'];
  db.agentProfiles.push({
    id: 'agp-1', userId: 'usr-agent', agencyOrgId: 'org-ag', displayName: 'Agent Person', declared: { fifaLicenceNumber: null, jurisdictions: ['ENG', 'INT'] },
    facets: {
      fifa_licence: { state: 'VERIFIED', reference: 'TEST-VERIFIED-1', verifiedAt: T0, recheckAt: Date.now() + 20 * 86_400_000, provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic' }, note: 'x' },
      national_registration: { ENG: { state: 'MANUAL_REVIEW_REQUIRED', reference: 'FA-REAL-1', verifiedAt: null, recheckAt: null, provenance: { provider: 'none' }, note: 'queued' } },
      minors_authorisation: {},
    },
    policyVersion: 1, createdAt: T0, updatedAt: T0, rev: 1, revAt: T0, revBy: null, keys: {}, history: [],
  });
  db.agentProfiles.push({
    id: 'agp-2', userId: 'usr-lead', agencyOrgId: 'org-ag', displayName: 'Lead Person', declared: { fifaLicenceNumber: null, jurisdictions: ['INT'] },
    facets: { fifa_licence: { state: 'MANUAL_REVIEW_REQUIRED', reference: 'FIFA-REAL-9', verifiedAt: null, recheckAt: null, provenance: { provider: 'none' }, note: 'queued' }, national_registration: {}, minors_authorisation: {} },
    policyVersion: 1, createdAt: T0, updatedAt: T0, rev: 1, revAt: T0, revBy: null, keys: {}, history: [],
  });
  db.representationAgreements.push({
    id: 'rep-disputed', agentUserId: 'usr-agent', agencyOrgId: 'org-ag', clientKind: 'player', clientId: 'pl-a', status: 'disputed', confirmedAt: T0 + 10, disputedAt: T0 + 20,
    scope: ['employment'], jurisdiction: 'ENG', termMonths: 12, startAt: T0 + 10, endAt: Date.now() + 1e10, proposedAt: T0, policyVersion: 1, keys: {}, createdAt: T0, rev: 3, revAt: T0 + 20, revBy: null, history: [],
  });
  db.representationAgreements.push({
    id: 'rep-active', agentUserId: 'usr-agent', agencyOrgId: 'org-ag', clientKind: 'player', clientId: 'pl-b', status: 'active', confirmedAt: T0 + 10,
    scope: ['employment'], jurisdiction: 'ENG', termMonths: 12, startAt: T0 + 10, endAt: Date.now() + 1e10, proposedAt: T0, policyVersion: 1, keys: {}, createdAt: T0, rev: 2, revAt: T0 + 10, revBy: null, history: [],
  });
  return db;
}

// ======================================================= 1 — the step
section('1 — schema 2306: one step, five stores, three seeded policies, idempotent, production-required');
{
  const step = MIGRATIONS.find((m) => m.id === STEP);
  ok(step?.version === 2306 && SCHEMA_VERSION === 2306, `${STEP} is version 2306; the current schema is 2306`);
  ok(MIGRATIONS.filter((m) => m.version === 2306).length === 1 && MIGRATIONS.filter((m) => m.version > 2305).length === 1, 'exactly one step at 2306 and none other above 2305 — the migration was advanced exactly once');
  neg(!MIGRATIONS.some((m) => m.version > 2306), 'and nothing above 2306');
  const fresh = {};
  const up = runMigrations(fresh);
  ok(up.to === 2306 && STORES.every((s) => Array.isArray(fresh[s])), 'a clean database gets the five stores');
  ok(fresh.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length && fresh.jurisdictionPolicies.map((p) => p.id).sort().join() === SEEDED_POLICY_VERSIONS.map((p) => p.id).sort().join(), `the ${SEEDED_POLICY_VERSIONS.length} P5.6A policy versions are seeded (FIFA baseline, England 2026/27, USA)`);
  ok(fresh.jurisdictionPolicies.every((p) => p.status === 'published' && p.proposedBy === null && p.approvedBy === null && p.history[0].by.name === 'migration 2306' && p.history[0].detail.seeded === true), 'each seeded version is published, attributed to the migration, with no reviewer invented');
  neg(fresh.tsReviewers.length === 0 && fresh.regulatoryReviews.length === 0 && fresh.regulatoryConsents.length === 0 && fresh.complianceContexts.length === 0, 'reviewers, reviews, consents and contexts start EMPTY — nobody is a reviewer by default');
  neg(fresh.transactionRooms === undefined && fresh.offers === undefined && fresh.negotiations === undefined, 'no Transaction Room, offer or negotiation store was invented (out of scope)');
  const { schema: _s1, ...storesBefore } = fresh;
  const idsBefore = fresh.schema.migrations.map((m) => m.id).join();
  const before = stableJson(storesBefore);
  const again = runMigrations(fresh);
  const { schema: _s2, ...storesAfter } = fresh;
  ok(again.ran.length === 0 && stableJson(storesAfter) === before && fresh.schema.migrations.map((m) => m.id).join() === idsBefore && fresh.schema.version === 2306, 'running again changes no store and adds no migration record');
  for (const s of STORES) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `${s} is migration-guaranteed and production-required`);
}

// ======================================================= 2 — upgrade
section('2 — upgrade from 2305: seeded policies, domestic container, migrated review items, nothing else touched');
{
  const db = snapshot2305();
  ok(db.schema.version === 2305 && db.tsReviewers === undefined && db.agentProfiles.length === 2 && db.representationAgreements.length === 2, 'the fixture is a 2305 snapshot with two profiles, two agreements and no compliance store');
  const stripDomestic = (p) => { const { facets, ...rest } = p; const { domestic_authorisation: _d, ...f } = facets; return { ...rest, facets: f }; };
  const profilesBefore = stableJson(db.agentProfiles.map(stripDomestic));
  const agreementsBefore = stableJson(db.representationAgreements);
  const usersBefore = stableJson(db.users);
  const up = runMigrations(db);
  ok(up.ran.join(',') === STEP && up.to === 2306, 'a 2305 snapshot runs exactly the one P5.6C step');
  ok(db.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length && db.jurisdictionPolicies.every((p) => p.status === 'published'), 'the policy versions are seeded as published rows');
  ok(db.agentProfiles.every((p) => p.facets.domestic_authorisation && Object.keys(p.facets.domestic_authorisation).length === 0), 'every profile gains an EMPTY domestic_authorisation container — nothing is verified by a migration');
  neg(stableJson(db.agentProfiles.map(stripDomestic)) === profilesBefore, 'apart from that container no byte of a profile changed (states, references, provenance, revs)');
  neg(stableJson(db.representationAgreements) === agreementsBefore && stableJson(db.users) === usersBefore, 'no agreement and no user row was touched');
  const reviews = db.regulatoryReviews;
  const facetItems = reviews.filter((r) => r.kind === 'verification_facet');
  const disputeItems = reviews.filter((r) => r.kind === 'representation_dispute');
  ok(facetItems.length === 2 && facetItems.some((r) => r.subject.profileId === 'agp-1' && r.subject.facet === 'national_registration' && r.subject.memberAssociation === 'ENG') && facetItems.some((r) => r.subject.profileId === 'agp-2' && r.subject.facet === 'fifa_licence' && r.subject.memberAssociation === null), 'the two MANUAL_REVIEW_REQUIRED facets each get one pending review item (the VERIFIED one gets none)');
  ok(disputeItems.length === 1 && disputeItems[0].subject.agreementId === 'rep-disputed', 'the disputed relationship gets one pending review item (the active one gets none)');
  ok(reviews.every((r) => r.status === 'PENDING' && r.requestedBy.kind === 'system' && r.requestedBy.name === 'migration 2306' && r.startedBy === null && r.decision === null && r.history[0].detail.migrated === true), 'every migrated item is PENDING, requested by the migration, started by nobody, decided by nobody');
  neg(reviews.every((r) => !JSON.stringify(r.subject).includes('FA-REAL-1') && !JSON.stringify(r.subject).includes('FIFA-REAL-9')), 'a migrated item carries no reference text — the reviewer reads it from the profile when they open the item');
  neg(db.tsReviewers.length === 0, 'NO reviewer identity was invented by the migration (G-C0: production reviewers come from the operator bootstrap)');
  const again = runMigrations(db);
  ok(again.ran.length === 0 && db.regulatoryReviews.length === 3 && db.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length, 'running again creates nothing twice');
  // A partially-applied re-run (stores present, step record missing) is still idempotent.
  db.schema.version = 2305; db.schema.migrations = db.schema.migrations.filter((m) => m.id !== STEP);
  const third = runMigrations(db);
  ok(third.ran.join(',') === STEP && db.regulatoryReviews.length === 3 && db.jurisdictionPolicies.length === SEEDED_POLICY_VERSIONS.length && db.agentProfiles.every((p) => Object.keys(p.facets.domestic_authorisation).length === 0), 'a re-applied step over existing rows adds no duplicate policy, no duplicate review item, and empties nothing');
  // A resolved item is not re-opened by a re-run.
  db.regulatoryReviews[0].status = 'REJECTED';
  db.schema.version = 2305; db.schema.migrations = db.schema.migrations.filter((m) => m.id !== STEP);
  runMigrations(db);
  neg(db.regulatoryReviews.length === 4 && db.regulatoryReviews.filter((r) => r.status === 'REJECTED').length === 1, 'a resolved item stays resolved; only the OPEN duplicate check applies (one new PENDING item is raised for the still-manual facet)');
}

// ======================================================= 3 — boot over it
section('3 — a real boot over the upgraded snapshot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p3-'));
  const db = snapshot2305();
  openStore(dir).save({ db });
  const s = await bootOn(dir, PORT);
  ok(s.up, 'the server boots over a 2305 snapshot');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(h.body.schemaVersion === 2306 && new RegExp(STEP).test(s.log()), 'and reports 2306 having applied the Compliance step at boot');
    neg(expect(await s.j('GET', '/ts/compliance/reviews', undefined, null, ADMIN), 401, 'REVIEWER_AUTH_REQUIRED'), 'the shared admin key has no reviewer lane over a migrated database either (G-C0)');
    const priya = (await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })).body;
    ok(priya?.token, 'a dev-seeded reviewer logs in (dev logins only; production uses TS_REVIEWER_BOOTSTRAP_*)');
    const pending = await s.j('GET', '/ts/compliance/reviews?status=PENDING', undefined, priya.token);
    ok(pending.status === 200 && pending.body.items.length === 3 && pending.body.items.filter((r) => r.kind === 'verification_facet').length === 2 && pending.body.items.filter((r) => r.kind === 'representation_dispute').length === 1, 'the reviewer lane lists the three migrated items');
    const item = pending.body.items.find((r) => r.kind === 'verification_facet' && r.subject.profileId === 'agp-1');
    const detail = await s.j('GET', `/ts/compliance/reviews/${item.id}`, undefined, priya.token);
    ok(detail.status === 200 && detail.body.subjectDetail.reference === 'FA-REAL-1' && detail.body.subjectDetail.state === 'MANUAL_REVIEW_REQUIRED', 'opening a migrated item shows the live reference and state from the profile');
    const pol = await s.j('GET', '/ts/compliance/policies', undefined, priya.token);
    ok(pol.status === 200 && pol.body.items.length === SEEDED_POLICY_VERSIONS.length && pol.body.items.every((p) => p.status === 'published'), 'the seeded policy versions are listed as published');
    const agent = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Agent Person', role: 'Agent', platform: 'agent' })).body;
    const ov = await s.j('GET', '/org/agent/compliance/overview', undefined, agent.token);
    ok(ov.status === 200 && ov.body.reviews.some((r) => r.kind === 'verification_facet' && r.status === 'PENDING') && ov.body.reviews.some((r) => r.kind === 'representation_dispute' && r.status === 'PENDING') && stableJson(ov.body.facets.domestic_authorisation) === '{}', 'the migrated agent sees their pending facet item, the pending dispute item, and the new (empty) facet');
    // The migrated dispute item resolves through the attributed lane and the agreement moves — attributed to the reviewer, not to the migration.
    const disp = pending.body.items.find((r) => r.kind === 'representation_dispute');
    const rs = await s.j('POST', `/ts/compliance/reviews/${disp.id}/resolve`, { outcome: 'REJECTED', reasonCode: 'client_dispute_upheld', reason: 'The client did not confirm the relationship.' }, priya.token);
    ok(rs.status === 200 && rs.body.review.decision.reviewer.id === 'tsr-dev-admin' && rs.body.review.decision.resultingState.agreementStatus === 'terminated_by_client', 'a migrated dispute item is resolved by a NAMED reviewer and the relationship ends');
    const after = await s.stop();
    ok(after.representationAgreements.find((a) => a.id === 'rep-disputed').terminationReasonCode === 'dispute_upheld' && after.regulatoryReviews.find((r) => r.id === disp.id).decision.reviewerId === 'tsr-dev-admin', 'the decision is on disk, attributed');
  }
}

// ======================================================= 4 — clean boot round trip
section('4 — clean boot → context → review → consent → revocation → stop → snapshot → reboot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p4-'));
  const port = PORT + 1;
  let s = await bootOn(dir, port);
  ok(s.up, 'clean boot');
  const j = s.j;
  const tomas = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' })).body;
  await j('POST', '/org/agent/agency/team', { name: 'Ana Costa', tiers: ['licensed_agent'] }, tomas.token);
  const ana = (await j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Costa', role: 'Agent', platform: 'agent' })).body;
  const prof = await j('POST', '/org/agent/profile', { displayName: 'Ana Costa', jurisdictions: ['ENG'] }, ana.token);
  const v1 = await j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-ANA' }, ana.token);
  const v2 = await j('POST', '/org/agent/profile/facets/national_registration/submit', { reference: 'TEST-VERIFIED-ANA-FA', memberAssociation: 'ENG' }, ana.token);
  ok(prof.status === 201 && v1.body.facet.state === 'VERIFIED' && v2.body.facet.state === 'VERIFIED', 'profile created; licence and FA registration verified by the synthetic provider');
  const req = await j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', scope: ['employment', 'transfer'], jurisdiction: 'ENG' }, ana.token);
  const kola = (await j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const conf = await j('POST', `/player/agent/relationships/${req.body.relationship.id}/confirm`, { expectedRev: 1 }, kola.token);
  ok(req.status === 201 && conf.body.relationship.status === 'active', 'Ana ↔ Kola confirmed');
  const REL = req.body.relationship.id;
  const create = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'rt-ctx' }, ana.token);
  ok(create.status === 201 && create.body.context.clearance.outcome === 'CLEAR', 'a context opens CLEAR');
  const CTX = create.body.context.id;
  const d1 = await j('POST', `/org/agent/compliance/contexts/${CTX}/representations`, { partyRole: 'individual', agreementId: REL, clientKey: 'rt-rep-1' }, ana.token);
  ok(d1.status === 201 && d1.body.representation.status === 'verified', 'Ana records that she acts for Kola (single party: CLEAR)');
  const d2 = await j('POST', `/org/agent/compliance/contexts/${CTX}/representations`, { partyRole: 'engaging_entity', clientKey: 'rt-rep-2' }, ana.token);
  ok(expect(d2, 422, 'REGULATORY_REVIEW_REQUIRED') && d2.body.reviewId, 'declaring the club (no ScoutBox agreement) raises an attributed review item');
  const marcus = (await j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-reviewer', secret: 'dev-reviewer' })).body;
  await j('POST', `/ts/compliance/reviews/${d2.body.reviewId}/start`, { expectedRev: 1 }, marcus.token);
  const rs = await j('POST', `/ts/compliance/reviews/${d2.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'Mandate letter examined.', evidenceRefs: ['Eastport FC mandate letter'], clientKey: 'rt-resolve' }, marcus.token);
  ok(rs.status === 200 && rs.body.review.decision.resultingState.representationStatus === 'verified' && rs.body.review.decision.resultingState.contextOutcome === PERMITTED_WITH_CONSENT, 'Marcus confirms the fact; the context is now PERMITTED_WITH_CONSENT');
  const cr = await j('POST', `/org/agent/compliance/contexts/${CTX}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, clientKey: 'rt-cons' }, ana.token);
  ok(cr.status === 201, 'consent requested from Kola');
  const CONSENT = cr.body.consent.id;
  const gr = await j('POST', `/player/agent/consents/${CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, clientKey: 'rt-grant' }, kola.token);
  ok(gr.status === 200 && gr.body.consent.status === 'granted', 'Kola grants');
  const rv = await j('POST', `/player/agent/consents/${CONSENT}/revoke`, { clientKey: 'rt-revoke' }, kola.token);
  ok(rv.status === 200 && rv.body.consent.status === 'revoked', 'Kola revokes');
  const beforeStop = {
    ctx: (await j('GET', `/org/agent/compliance/contexts/${CTX}`, undefined, ana.token)).body,
    consents: (await j('GET', '/player/agent/consents', undefined, kola.token)).body,
    review: (await j('GET', `/ts/compliance/reviews/${d2.body.reviewId}`, undefined, marcus.token)).body,
    overview: (await j('GET', '/org/agent/compliance/overview', undefined, ana.token)).body,
  };
  ok(beforeStop.ctx.context.clearance.outcome === PERMITTED_WITH_CONSENT && beforeStop.ctx.context.clearance.consentsOutstanding.some((x) => x.partyRole === 'individual' && x.reasonCode === 'CONSENT_REVOKED'), 'before the stop: consent outstanding again, named as revoked');
  const snap = await s.stop();
  ok(snap && snap.schema.version === 2306 && snap.complianceContexts.length === 1 && snap.regulatoryReviews.length === 1 && snap.tsReviewers.length === 3, 'the snapshot holds one context, one review, the three dev reviewers at 2306');
  const ctxRow = snap.complianceContexts[0];
  if (!(ctxRow.keys?.create?.key === 'rt-ctx' && ctxRow.representations.length === 2 && ctxRow.evaluations?.length >= 4 && ctxRow.rev >= 4)) console.error('   ctx row', JSON.stringify({ keys: ctxRow.keys, reps: ctxRow.representations.map((r) => [r.partyRole, r.status, r.keys]), evaluations: ctxRow.evaluations?.length, rev: ctxRow.rev }));
  ok(ctxRow.keys.create.key === 'rt-ctx' && ctxRow.representations.length === 2 && ctxRow.representations[0].keys.declare.key === 'rt-rep-1' && ctxRow.representations[1].keys.declare.key === 'rt-rep-2' && ctxRow.evaluations.length >= 4 && ctxRow.rev >= 4, 'keys, both representations, the evaluation history and the rev are on disk');
  neg(ctxRow.evaluations.every((e) => typeof e.inputHash === 'string' && Array.isArray(e.policyVersions) && e.policyVersions.length === 2), 'every stored evaluation names its input hash and its two policy versions');
  const ledger = snap.regulatoryConsents;
  const granted = ledger.find((k) => k.id === CONSENT);
  const revocation = ledger.find((k) => k.kind === 'revocation' && k.of === CONSENT);
  neg(ledger.length === 2 && granted.status === 'granted' && granted.revokedAt === undefined && revocation && revocation.at >= granted.grantedAt && granted.keys.request.key === 'rt-cons' && granted.keys.grant.key === 'rt-grant' && granted.keys.revoke.key === 'rt-revoke' && revocation.by?.kind === 'player', 'the ledger is append-only on disk: the granted row is untouched (its status word stays "granted"; the revocation is derived), the revocation is its own attributed row, every key is stored');
  const review = snap.regulatoryReviews[0];
  ok(review.status === 'APPROVED' && review.decision.reviewerId === 'tsr-dev-reviewer' && review.decision.evidenceRefs.length === 1 && review.keys.resolve.key === 'rt-resolve' && review.startedBy.id === 'tsr-dev-reviewer', 'the review decision, its evidence, its key and its attribution are on disk');
  neg(snap.tsReviewers.every((r) => typeof r.secretHash === 'string' && r.secret === undefined && r.password === undefined), 'reviewer rows hold a hash and never a plaintext secret');
  ok(snap.sessions.some((x) => x.kind === 'ts_reviewer' && x.refId === 'tsr-dev-reviewer'), 'the reviewer session is on disk');
  neg(!('transactionRoomId' in ctxRow) && !('offer' in ctxRow) && !('fee' in ctxRow), 'the context row carries no room, offer or fee field');
  s = await bootOn(dir, port + 1);
  ok(s.up && (await s.j('GET', '/healthz')).body.schemaVersion === 2306, 'reboot at 2306');
  neg(!new RegExp(STEP).test(s.log()), 'the 2306 step did NOT run again');
  const ana2 = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Ana Costa', role: 'Agent', platform: 'agent' })).body;
  const kola2 = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const after = {
    ctx: (await s.j('GET', `/org/agent/compliance/contexts/${CTX}`, undefined, ana2.token)).body,
    consents: (await s.j('GET', '/player/agent/consents', undefined, kola2.token)).body,
    review: (await s.j('GET', `/ts/compliance/reviews/${d2.body.reviewId}`, undefined, marcus.token)).body,
    overview: (await s.j('GET', '/org/agent/compliance/overview', undefined, ana2.token)).body,
  };
  ok(stableJson(after.ctx.context) === stableJson(beforeStop.ctx.context), 'the context projects identically after the restart (clearance, representations, evaluations, rev)');
  ok(stableJson(after.consents) === stableJson(beforeStop.consents), 'the player\'s consent view projects identically');
  ok(after.review.review && stableJson(after.review.review) === stableJson(beforeStop.review.review), 'the review projects identically — and the reviewer\'s pre-restart session still works');
  ok(stableJson(after.overview.contexts) === stableJson(beforeStop.overview.contexts) && stableJson(after.overview.facets) === stableJson(beforeStop.overview.facets), 'the agent overview projects identically');
  ok((await s.j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'rt-ctx' }, ana2.token)).body.idempotent === true, 'the context key replays after the restart');
  ok((await s.j('POST', `/org/agent/compliance/contexts/${CTX}/representations`, { partyRole: 'individual', agreementId: REL, clientKey: 'rt-rep-1' }, ana2.token)).body.idempotent === true, 'the declaration key replays');
  ok((await s.j('POST', `/ts/compliance/reviews/${d2.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'Mandate letter examined.', evidenceRefs: ['Eastport FC mandate letter'], clientKey: 'rt-resolve' }, marcus.token)).body.idempotent === true, 'the resolution key replays');
  neg(expect(await s.j('POST', `/player/agent/consents/${CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola2.token), 409, 'CONSENT_NOT_PENDING'), 'a revoked consent cannot be re-granted after the restart — a new request is needed');
  const ev = await s.j('POST', `/org/agent/compliance/contexts/${CTX}/evaluate`, {}, ana2.token);
  const same = (e) => stableJson({ o: e.outcome, r: e.reasons.map((x) => [x.code, x.ruleId, x.ruleStatus]), c: e.consentsOutstanding.map((x) => [x.partyRole, x.reasonCode]), p: e.policyVersions });
  ok(ev.status === 200 && same(ev.body.evaluation) === same(beforeStop.ctx.context.clearance) && ev.body.evaluation.inputHash !== beforeStop.ctx.context.clearance.inputHash, 'a fresh evaluation over the same facts yields the same outcome, reasons, outstanding consents and versions — a new clock, so a new input hash, but the same verdict');
  const snap2 = await s.stop();
  ok(snap2.schema.migrations.filter((m) => m.id === STEP).length === 1 && snap2.tsReviewers.length === 3, 'one migration record, still; the dev reviewers were not seeded twice');
}

// ======================================================= 5 — corruption
section('5 — corruption on disk is contained, named by its effect, never repaired');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m25p5-'));
  const db = snapshot2305();
  runMigrations(db);
  // (a) a review whose stored snapshot says PROHIBITED — nobody can approve it.
  db.regulatoryReviews.push({
    id: 'rrv-prohibited', kind: 'conflict_evaluation', status: 'PENDING', agencyOrgId: 'org-ag', agentUserId: 'usr-agent',
    subject: { contextId: 'ctx-gone', representationId: null, partyRole: 'releasing_entity' }, reasons: [{ code: 'PROHIBITED_COMBINATION', ruleId: 'ENG-6.4', ruleStatus: 'ACTIVE', policyVersion: 'jp-eng-2026-27-1' }],
    policyVersions: ['jp-eng-2026-27-1'], snapshot: { outcome: 'PROHIBITED_CONFLICT' }, requestedAt: T0, requestedBy: { kind: 'system', userId: null, name: 'fixture' }, startedAt: null, startedBy: null, decidedAt: null, decision: null, supersedes: null, supersededBy: null, keys: {}, rev: 1, revAt: T0, revBy: null, history: [],
  });
  // (b) a reviewer row with an unknown status word — injected after the first boot below.
  // (c) a consent naming a policy version that does not exist (pure).
  const stale = consentSufficiency({ kind: 'dual_representation', status: 'granted', grantedAt: T0, contextId: 'c', agentUserId: 'a', partyRole: 'individual', policyVersions: ['jp-eng-1999-1'], grantedBy: { kind: 'player', id: 'p' }, particulars: { fullParticularsProvided: true, legalAdviceOffered: true } }, { partyRole: 'individual', agentUserId: 'a', contextId: 'c', activePolicyIds: ['jp-eng-2026-27-1'], requireParticulars: true });
  neg(stale.ok === false && stale.reasonCode === 'CONSENT_POLICY_VERSION_STALE', 'a consent naming an unknown policy version is insufficient (pure engine)');
  // (d) an emptied policy store: no jurisdiction is encoded any more.
  const missing = applicablePolicySet([], ['ENG'], Date.now());
  neg(missing.policies.length === 0 && missing.missing.includes('ENG') && missing.missing.includes('INT'), 'with no policy rows the policy set is empty and both INT and ENG are reported missing (pure)');
  openStore(dir).save({ db });
  // First boot: the dev reviewers are seeded only into an EMPTY reviewer store — so the odd row is injected after that.
  const s0 = await bootOn(dir, PORT + 2);
  ok(s0.up, 'a first boot seeds the dev reviewers (empty store)');
  const seeded = await s0.stop();
  ok(seeded.tsReviewers.length === 3, 'three dev reviewers on disk');
  seeded.tsReviewers.push({ id: 'tsr-odd', name: 'Odd Reviewer', role: 'trust_safety_admin', status: 'enabled', secretHash: 'not-a-hash', createdAt: T0, rev: 1, revAt: T0, revBy: null, history: [] });
  openStore(dir).save({ db: seeded });
  const stored = stableJson(seeded.tsReviewers.find((r) => r.id === 'tsr-odd'));
  const s = await bootOn(dir, PORT + 3);
  ok(s.up, 'the server boots over the corrupt rows');
  if (s.up) {
    neg(expect(await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-odd', secret: 'anything' }), 401, 'REVIEWER_CREDENTIALS_INVALID'), 'a reviewer row with status "enabled" (unknown) cannot log in — only "active" can');
    const priya = (await s.j('POST', '/auth/reviewer/login', { reviewerId: 'tsr-dev-admin', secret: 'dev-reviewer-admin' })).body;
    ok(!!priya?.token && (await s.j('GET', '/ts/reviewers', undefined, priya.token)).body.items.length === 4, 'a real reviewer logs in; the odd row is listed beside the three seeds, not repaired and not dropped');
    neg(expect(await s.j('POST', '/ts/compliance/reviews/rrv-prohibited/resolve', { outcome: 'APPROVED', reasonCode: 'x', reason: 'looks fine', evidenceRefs: ['e'] }, priya.token), 409, 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE'), 'an administrator cannot approve a review whose snapshot is PROHIBITED under an ACTIVE rule');
    const rej = await s.j('POST', '/ts/compliance/reviews/rrv-prohibited/resolve', { outcome: 'REJECTED', reasonCode: 'prohibited', reason: 'Prohibited; closed.' }, priya.token);
    ok(rej.status === 200 && rej.body.review.status === 'REJECTED' && rej.body.review.decision.resultingState.note === 'context gone', 'rejecting it works and says honestly that its context is gone');
    const after = await s.stop();
    neg(stableJson(after.tsReviewers.find((r) => r.id === 'tsr-odd')) === stored, 'the odd reviewer row was not repaired on boot or by the failed login — the bytes are the bytes');
    // Now wipe the policy store and boot again: nothing is CLEAR without an encoded policy.
    after.jurisdictionPolicies = [];
    openStore(dir).save({ db: after });
    const s2 = await bootOn(dir, PORT + 4);
    ok(s2.up, 'the server boots over an EMPTY policy store');
    if (s2.up) {
      const snap = openStore(dir).load().db;
      neg(snap.jurisdictionPolicies.length === 0, 'boot did not re-seed the policies (the migration record says the step already ran)');
      const agent = (await s2.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Agent Person', role: 'Agent', platform: 'agent' })).body;
      const c = await s2.j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-b' }] }, agent.token);
      neg(expect(c, 422, 'JURISDICTION_UNSUPPORTED'), 'with no policy encoded, opening an England context is JURISDICTION_UNSUPPORTED — never silently CLEAR');
      const ov = await s2.j('GET', '/org/agent/compliance/overview', undefined, agent.token);
      neg(ov.status === 200 && ov.body.policies.inEffect.length === 0 && ov.body.policies.missing.includes('INT') && ov.body.policies.missing.includes('ENG'), 'the overview shows no policy version in effect and names INT and ENG as missing rather than inventing them');
      await s2.stop();
    }
  }
}

console.log(`\nM23 P5.6C Compliance persistence suite: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED'); else console.log('all M23 P5.6C Compliance persistence checks passed');
process.exit(process.exitCode ?? 0);
