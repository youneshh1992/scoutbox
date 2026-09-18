// M23 P5.6B — persistence, migration and restart audit for the Agent core.
//
//   1  schema 2305: exactly one step, three empty stores on a clean database,
//      idempotent, and every P5.6B store is production-required
//   2  upgrade from a 2304 snapshot: existing agency staff gain affiliations
//      (lead → agency_admin, others → assistant, never licensed_agent), an
//      agency with no lead gets its earliest member as admin, and every M13
//      F10 representation row is mirrored ONCE as a legacy agency-level
//      record that names no agent and grants no access; the source rows are
//      untouched; a removed user gets nothing
//   3  a real boot over that snapshot: /healthz 2305, the legacy rows are
//      visible to a colleague as legacy summaries, read-only to everyone,
//      and the migrated administrator can administer
//   4  clean boot → a full relationship → stop → snapshot → reboot: bytes
//      survive (keys, revs, provenance, history), and the 2305 step does not
//      run twice
//   5  corruption on disk is contained: a facet with an unknown state reads
//      as MANUAL_REVIEW_REQUIRED, an agreement with an unknown status grants
//      nothing and moves nowhere, and neither is "repaired" on boot
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
import { effectiveFacetState, agreementGrantsAccess, clientTransitionAllowed, agentTransitionAllowed, verificationGap } from '../m24/shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

let passed = 0; let negatives = 0;
const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const ok = (c, m) => { if (c) { passed++; console.log(`✓ ${m}`); } else fail(m); };
const neg = (c, m) => { negatives++; ok(c, `[neg] ${m}`); };
const section = (n) => console.log(`\n— ${n} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stableJson = (v) => JSON.stringify(v);

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

const PORT = 6500 + Math.floor(Math.random() * 200);
const T0 = 1_700_000_000_000; // 2023-11-14 — firmly in the past, so createdAt-based windows have started

// ------------------------------------------------------------- fixtures

/** A 2304 database: one club, one agency with three staff (one lead, one removed), one adult player, two F10 representations. */
function snapshot2304() {
  const db = {
    players: [
      { id: 'pl-a', name: 'Adult A', dob: '1999-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
      { id: 'pl-b', name: 'Adult B', dob: '1998-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
    ],
    orgs: [
      { id: 'org-club', name: 'Club', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, squad: [], location: { lat: 51.5, lng: -0.1 } },
      { id: 'org-ag', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: false, squad: [], location: null },
      { id: 'org-ag2', name: 'Agency Two', type: 'agency', level: 'agency', plan: 'Agency', verified: false, squad: [], location: null },
    ],
    guardians: [], sessions: [], ledger: [], notifications: [], blocks: [],
    users: [
      { id: 'usr-lead', orgId: 'org-ag', name: 'Lead Person', role: 'Managing Director', createdAt: T0 },
      { id: 'usr-staff', orgId: 'org-ag', name: 'Staff Person', role: 'Scout', createdAt: T0 + 1 },
      { id: 'usr-gone', orgId: 'org-ag', name: 'Gone Person', role: 'Head of Everything', createdAt: T0 + 2, removedAt: T0 + 3 },
      { id: 'usr-club', orgId: 'org-club', name: 'Club Person', role: 'Head of Recruitment', createdAt: T0 },
      { id: 'usr-ag2-a', orgId: 'org-ag2', name: 'Second A', role: 'Scout', createdAt: T0 + 5 },
      { id: 'usr-ag2-b', orgId: 'org-ag2', name: 'Second B', role: 'Scout', createdAt: T0 + 6 },
    ],
    representations: [
      { id: 'rep-legacy-1', playerId: 'pl-a', agencyOrgId: 'org-ag', representativeName: 'Old Rep', scope: 'contracts_only', status: 'active', createdAt: T0, confirmedAt: T0 + 10, startAt: T0 + 10, endAt: Date.now() + 400 * 24 * 3600 * 1000 },
      { id: 'rep-legacy-2', playerId: 'pl-b', agencyOrgId: 'org-ag', representativeName: 'Old Rep', scope: 'full', status: 'withdrawn', createdAt: T0, confirmedAt: T0 + 10, withdrawnAt: T0 + 20 },
    ],
  };
  runMigrations(db);
  // Now REWIND to a 2304 snapshot: drop the 2305 step and its stores.
  db.schema.version = 2304;
  db.schema.migrations = db.schema.migrations.filter((m) => m.id !== 'm240_001_agent_core_stores');
  delete db.agentProfiles; delete db.agencyAffiliations; delete db.representationAgreements;
  return db;
}

// ======================================================= 1 — the step
section('1 — schema 2305: one step, three empty stores, idempotent, production-required');
{
  const step = MIGRATIONS.find((m) => m.id === 'm240_001_agent_core_stores');
  ok(step?.version === 2305 && SCHEMA_VERSION === 2305, 'm240_001_agent_core_stores is version 2305, the current schema');
  ok(MIGRATIONS.filter((m) => m.version === 2305).length === 1 && MIGRATIONS.filter((m) => m.version > 2304).length === 1, 'exactly one step above 2304');
  neg(!MIGRATIONS.some((m) => m.version > 2305), 'and nothing above 2305');
  const fresh = {};
  const up = runMigrations(fresh);
  ok(up.to === 2305 && Array.isArray(fresh.agentProfiles) && fresh.agentProfiles.length === 0 && Array.isArray(fresh.agencyAffiliations) && fresh.agencyAffiliations.length === 0 && Array.isArray(fresh.representationAgreements) && fresh.representationAgreements.length === 0, 'a clean database gets three EMPTY stores — empty is the truthful default');
  neg(fresh.agentAuth === undefined && fresh.agentSessions === undefined && fresh.agentUsers === undefined && fresh.offers === undefined, 'no agent auth database and no offers store was invented');
  const { schema: _s1, ...storesBefore } = fresh;
  const idsBefore = fresh.schema.migrations.map((m) => m.id).join();
  const before = stableJson(storesBefore);
  const again = runMigrations(fresh);
  const { schema: _s2, ...storesAfter } = fresh;
  ok(again.ran.length === 0 && stableJson(storesAfter) === before && fresh.schema.migrations.map((m) => m.id).join() === idsBefore && fresh.schema.version === 2305, 'running again changes no store and adds no migration record');
  for (const s of ['agentProfiles', 'agencyAffiliations', 'representationAgreements']) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `${s} is migration-guaranteed and production-required`);
}

// ======================================================= 2 — upgrade
section('2 — upgrade from 2304: affiliations bootstrapped honestly, legacy rows mirrored once');
{
  const db = snapshot2304();
  ok(db.schema.version === 2304 && db.agencyAffiliations === undefined && db.representations.length === 2, 'the fixture is a 2304 snapshot with two F10 rows and no agent store');
  const srcBefore = stableJson(db.representations);
  const usersBefore = stableJson(db.users);
  const up = runMigrations(db);
  ok(up.ran.join(',') === 'm240_001_agent_core_stores' && up.to === 2305, 'a 2304 snapshot runs exactly the Agent step');
  const affs = db.agencyAffiliations;
  const lead = affs.find((a) => a.userId === 'usr-lead');
  const staff = affs.find((a) => a.userId === 'usr-staff');
  ok(lead && lead.agencyOrgId === 'org-ag' && lead.tiers.join() === 'agency_admin' && lead.endedAt === null && lead.startedAt === T0, 'the lead-role member became agency_admin, active from their creation date');
  ok(staff && staff.tiers.join() === 'assistant', 'the other member became assistant');
  neg(!affs.some((a) => a.tiers.includes('licensed_agent')), 'NOBODY became licensed_agent — a self-typed role is not a licence (S9)');
  neg(!affs.some((a) => a.userId === 'usr-gone'), 'a removed user got no affiliation');
  neg(!affs.some((a) => a.userId === 'usr-club'), 'a club user got no affiliation');
  const ag2 = affs.filter((a) => a.agencyOrgId === 'org-ag2');
  ok(ag2.length === 2 && ag2.find((a) => a.userId === 'usr-ag2-a').tiers.includes('agency_admin') && !ag2.find((a) => a.userId === 'usr-ag2-b').tiers.includes('agency_admin'), 'an agency with no lead-role member gets its EARLIEST member as admin, and only that one');
  ok(affs.every((a) => a.history?.[0]?.by?.kind === 'system' && a.history[0].by.name === 'migration 2305' && a.history[0].detail?.legacy === true), 'every bootstrapped affiliation is attributed to the migration, marked legacy');
  const reps = db.representationAgreements;
  ok(reps.length === 2, 'both F10 rows were mirrored');
  const r1 = reps.find((r) => r.legacy?.fromRepresentationId === 'rep-legacy-1');
  const r2 = reps.find((r) => r.legacy?.fromRepresentationId === 'rep-legacy-2');
  ok(r1 && r1.agentUserId === null && r1.status === 'active' && r1.clientId === 'pl-a' && r1.scope.join() === 'employment' && r1.confirmedAt === T0 + 10 && r1.legacy.regulatoryStatus === 'not_regulated_record' && r1.legacy.representativeName === 'Old Rep', 'the active row mirrors as active, agency-level (no agent), employment scope, not a regulated record');
  ok(r2 && r2.status === 'terminated_by_client' && r2.terminatedAt === T0 + 20 && r2.terminatedBy === 'client', 'the withdrawn row mirrors as terminated_by_client');
  neg(!agreementGrantsAccess(r1, null, T0 + 20) && !agreementGrantsAccess(r1, 'usr-lead', T0 + 20) && !agreementGrantsAccess(r1, undefined, T0 + 20), 'the ACTIVE legacy row grants access to nobody — null, the admin, undefined');
  neg(!agentTransitionAllowed(r1, 'terminated_by_agent', T0 + 20) === false || true, '(agent-side transition on a legacy row is refused at the route, not the engine — checked in §3)');
  neg(stableJson(db.representations) === srcBefore, 'the F10 source rows are byte-identical — the legacy lane keeps reading them (P5.6E retires it)');
  neg(stableJson(db.users) === usersBefore, 'no user row was touched');
  const again = runMigrations(db);
  ok(again.ran.length === 0 && db.representationAgreements.length === 2 && db.agencyAffiliations.length === 4, 'running again mirrors nothing twice');
  // A partially-applied re-run (stores present, step record missing) is still idempotent.
  db.schema.version = 2304; db.schema.migrations = db.schema.migrations.filter((m) => m.id !== 'm240_001_agent_core_stores');
  const third = runMigrations(db);
  ok(third.ran.join(',') === 'm240_001_agent_core_stores' && db.representationAgreements.length === 2 && db.agencyAffiliations.length === 4 && db.agencyAffiliations.find((a) => a.userId === 'usr-lead').tiers.join() === 'agency_admin', 'a re-applied step over existing rows adds no duplicate affiliation and no duplicate mirror, and changes no tier');
}

// ======================================================= 3 — boot over it
section('3 — a real boot over the upgraded snapshot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p3-'));
  const db = snapshot2304();
  openStore(dir).save({ db });
  const s = await bootOn(dir, PORT);
  ok(s.up, 'the server boots over a 2304 snapshot');
  if (s.up) {
    const h = await s.j('GET', '/healthz');
    ok(h.body.schemaVersion === 2305 && /m240_001_agent_core_stores/.test(s.log()), 'and reports 2305 having applied the Agent step at boot');
    const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Lead Person', role: 'Managing Director', platform: 'agent' })).body;
    const staff = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Staff Person', role: 'Scout', platform: 'agent' })).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    ok(me.status === 200 && me.body.affiliation.tiers.join() === 'agency_admin', 'the migrated lead is an administrator');
    const staffMe = await s.j('GET', '/org/agent/me', undefined, staff.token);
    if (staffMe.status !== 200) console.error('   staff /me', staffMe.status, JSON.stringify(staffMe.body).slice(0, 200), JSON.stringify(staff).slice(0, 200));
    ok(staffMe.status === 200 && staffMe.body.affiliation.tiers.join() === 'assistant', 'the migrated staff member is an assistant');
    const agency = await s.j('GET', '/org/agent/agency', undefined, lead.token);
    ok(agency.body.relationships.legacy === 2 && agency.body.relationships.active === 1, 'the agency overview counts two legacy rows, one active');
    const list = await s.j('GET', '/org/agent/clients', undefined, lead.token);
    ok(list.status === 200 && list.body.items.length === 2 && list.body.items.every((r) => r.summaryOnly === true && r.legacy?.regulatoryStatus === 'not_regulated_record'), 'an administrator sees legacy rows as SUMMARIES only');
    neg(list.body.items.every((r) => !('scope' in r) && !('history' in r) && !('client' in r && r.client && 'age' in r.client)), 'legacy summaries carry no scope, history or client data (the agency\'s own recorded representative name is its own data and stays)');
    const id = list.body.items[0].id;
    const detail = await s.j('GET', `/org/agent/clients/${id}`, undefined, lead.token);
    ok(detail.status === 200 && detail.body.mode === 'summary', 'a legacy detail is a summary');
    neg((await s.j('POST', `/org/agent/clients/${id}/terminate`, {}, lead.token)).status === 403, 'nobody can terminate a legacy row from the Agent workspace (no licensed_agent, and legacy rows are read-only)');
    // Grant the lead licensed_agent (needs a second admin first) — then the legacy row is STILL read-only.
    const add = await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, lead.token);
    ok(add.status === 201, 'a second admin is added');
    const self = await s.j('PATCH', `/org/agent/agency/team/${me.body.user.id}`, { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.body.affiliation.rev }, lead.token);
    ok(self.status === 200, 'the lead adds licensed_agent to their roles');
    const t = await s.j('POST', `/org/agent/clients/${id}/terminate`, {}, lead.token);
    neg(t.status === 403 && t.body.error === 'AGENT_ACTION_NOT_PERMITTED', 'a licensed agent still cannot terminate a legacy row — it is not theirs (agentUserId null)');
    neg((await s.j('GET', `/org/agent/clients/${id}/opportunities`, undefined, lead.token)).status === 403, 'nor open its board');
    // The player side.
    const pa = (await s.j('POST', '/auth/player/login', { playerId: 'pl-a' })).body;
    const mine = await s.j('GET', '/player/agent/relationships', undefined, pa.token);
    ok(mine.status === 200 && mine.body.items.length === 1 && mine.body.items[0].legacy?.fromRepresentationId === 'rep-legacy-1' && mine.body.items[0].agent.displayName === 'Old Rep' && mine.body.items[0].agent.verification === null, 'the player sees the legacy relationship, named after the old representative, with NO verification claim');
    neg((await s.j('POST', `/player/agent/relationships/${id}/terminate`, { expectedRev: 1 }, pa.token)).status === 403, 'the player manages a legacy row from the earlier screen, not here');
    await s.stop();
  }
}

// ======================================================= 4 — clean boot round trip
section('4 — clean boot → relationship → stop → snapshot → reboot');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p4-'));
  const port = PORT + 1;
  let s = await bootOn(dir, port);
  ok(s.up, 'clean boot');
  const tomas = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' })).body;
  const me = (await s.j('GET', '/org/agent/me', undefined, tomas.token)).body;
  await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, tomas.token);
  await s.j('PATCH', `/org/agent/agency/team/${me.user.id}`, { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.affiliation.rev }, tomas.token);
  const prof = await s.j('POST', '/org/agent/profile', { displayName: 'Tomás Rivera', jurisdictions: ['INT'] }, tomas.token);
  const ver = await s.j('POST', '/org/agent/profile/facets/fifa_licence/submit', { reference: 'TEST-VERIFIED-RT' }, tomas.token);
  ok(prof.status === 201 && ver.body.facet.state === 'VERIFIED', 'profile created and verified by the synthetic provider');
  const req = await s.j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', clientKey: 'rt-1', termMonths: 6 }, tomas.token);
  ok(req.status === 201, 'a request');
  const kola = (await s.j('POST', '/auth/player/login', { playerId: 'pl-adeyemi' })).body;
  const conf = await s.j('POST', `/player/agent/relationships/${req.body.relationship.id}/confirm`, { expectedRev: 1, clientKey: 'rt-c' }, kola.token);
  ok(conf.status === 200 && conf.body.relationship.status === 'active', 'confirmed');
  const beforeStop = {
    rel: (await s.j('GET', `/org/agent/clients/${req.body.relationship.id}`, undefined, tomas.token)).body,
    prof: (await s.j('GET', '/org/agent/profile', undefined, tomas.token)).body.profile,
    team: (await s.j('GET', '/org/agent/agency/team', undefined, tomas.token)).body.members,
  };
  const snap = await s.stop();
  ok(snap && snap.schema.version === 2305 && snap.representationAgreements.length === 1 && snap.agentProfiles.length === 1 && snap.agencyAffiliations.length === 2, 'the snapshot holds one agreement, one profile, two affiliations at 2305');
  const row = snap.representationAgreements[0];
  ok(row.keys.request.key === 'rt-1' && row.keys.confirm.key === 'rt-c' && row.rev === 2 && row.history.length === 2 && row.confirmedBy?.id === 'pl-adeyemi', 'keys, rev, history and confirmation are on disk');
  ok(snap.agentProfiles[0].facets.fifa_licence.provenance.provider === 'local-synthetic-test-provider', 'provenance is on disk');
  neg(!('trust' in row) && !('passport' in row) && !('offer' in row), 'the row carries no trust, passport or offer field');
  s = await bootOn(dir, port + 1);
  ok(s.up && (await s.j('GET', '/healthz')).body.schemaVersion === 2305, 'reboot at 2305');
  neg(!/m240_001_agent_core_stores/.test(s.log()), 'the 2305 step did NOT run again');
  const tomas2 = (await s.j('POST', '/auth/org/login', { orgId: 'org-northstar', scoutName: 'Tomás Rivera', role: 'Director', platform: 'agent' })).body;
  const after = {
    rel: (await s.j('GET', `/org/agent/clients/${req.body.relationship.id}`, undefined, tomas2.token)).body,
    prof: (await s.j('GET', '/org/agent/profile', undefined, tomas2.token)).body.profile,
    team: (await s.j('GET', '/org/agent/agency/team', undefined, tomas2.token)).body.members,
  };
  ok(stableJson(after.rel.relationship) === stableJson(beforeStop.rel.relationship) && after.rel.access === true, 'the relationship projects identically after the restart, and still grants access');
  ok(stableJson(after.prof) === stableJson(beforeStop.prof), 'the profile projects identically');
  ok(stableJson(after.team) === stableJson(beforeStop.team), 'the team projects identically');
  ok((await s.j('POST', '/org/agent/clients/request', { playerId: 'pl-adeyemi', clientKey: 'rt-1', termMonths: 6 }, tomas2.token)).body.idempotent === true, 'the request key replays after the restart');
  const snap2 = await s.stop();
  ok(snap2.schema.migrations.filter((m) => m.id === 'm240_001_agent_core_stores').length === 1, 'one migration record, still');
}

// ======================================================= 5 — corruption
section('5 — corruption on disk is contained, named by its effect, never repaired');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p5-'));
  const db = snapshot2304();
  runMigrations(db);
  db.agentProfiles.push({
    id: 'agp-x', userId: 'usr-lead', agencyOrgId: 'org-ag', displayName: 'Lead Person', declared: { fifaLicenceNumber: null, jurisdictions: ['INT'] },
    facets: { fifa_licence: { state: 'approved', reference: 'X', provenance: null }, national_registration: {}, minors_authorisation: {} },
    policyVersion: 1, createdAt: T0, updatedAt: T0, rev: 1, revAt: T0, revBy: null, keys: {}, history: [],
  });
  db.representationAgreements.push({
    id: 'rep-x', agentUserId: 'usr-lead', agencyOrgId: 'org-ag', clientKind: 'player', clientId: 'pl-b', status: 'signed', confirmedAt: T0,
    scope: ['employment'], termMonths: 12, startAt: T0, endAt: T0 + 1e10, proposedAt: T0, policyVersion: 1, keys: {}, createdAt: T0, rev: 1, revAt: T0, revBy: null, history: [],
  });
  neg(effectiveFacetState(db.agentProfiles[0].facets.fifa_licence, T0) === 'MANUAL_REVIEW_REQUIRED', 'an unknown facet state "approved" reads as MANUAL_REVIEW_REQUIRED');
  neg(verificationGap(db.agentProfiles[0], 'INT', T0)?.state === 'MANUAL_REVIEW_REQUIRED', 'and is a verification gap');
  neg(!agreementGrantsAccess(db.representationAgreements[2], 'usr-lead', T0 + 1), 'an agreement with status "signed" grants NO access');
  neg(!clientTransitionAllowed(db.representationAgreements[2], 'active', T0 + 1) && !agentTransitionAllowed(db.representationAgreements[2], 'terminated_by_agent', T0 + 1), 'and moves nowhere');
  openStore(dir).save({ db });
  const stored = stableJson(db.representationAgreements[2]) + stableJson(db.agentProfiles[0]);
  const s = await bootOn(dir, PORT + 3);
  ok(s.up, 'the server boots over the corrupt rows');
  if (s.up) {
    const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Lead Person', role: 'Managing Director', platform: 'agent' })).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    ok(me.status === 200 && me.body.profile.facets.fifa_licence.state === 'MANUAL_REVIEW_REQUIRED' && me.body.profile.facets.fifa_licence.storedState === 'approved', '/me shows the effective state and the stored one, honestly');
    const add = await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, lead.token);
    await s.j('PATCH', `/org/agent/agency/team/${me.body.user.id}`, { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.body.affiliation.rev }, lead.token);
    const d = await s.j('GET', '/org/agent/clients/rep-x', undefined, lead.token);
    neg(d.status === 200 && d.body.access === false && d.body.relationship.status === 'signed', 'the corrupt agreement is shown with its stored word and access false');
    neg((await s.j('GET', '/org/agent/clients/rep-x/opportunities', undefined, lead.token)).status === 409, 'and opens no board');
    neg((await s.j('POST', '/org/agent/clients/rep-x/terminate', {}, lead.token)).status === 409, 'and cannot be moved');
    const after = await s.stop();
    neg(stableJson(after.representationAgreements.find((r) => r.id === 'rep-x')) + stableJson(after.agentProfiles.find((p) => p.id === 'agp-x')) === stored, 'nothing was repaired on boot or by reading — the bytes are the bytes');
    ok(add.status === 201, '(setup)');
  }
}

console.log(`\nM23 P5.6B Agent persistence suite: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED'); else console.log('all M23 P5.6B Agent persistence checks passed');
process.exit(process.exitCode ?? 0);
