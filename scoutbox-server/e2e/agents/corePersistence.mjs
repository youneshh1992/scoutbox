// Persistence, migration and restart audit for the Agent core: (1) migration 0026, (2) staff with no agent rows get
// nothing bootstrapped, (3) the first member into an agency becomes its administrator, (4) a full relationship
// survives a restart byte for byte, (5) junk is refused by the typed write, and an odd row a typed table CAN hold (an
// active agreement nobody confirmed) grants nothing.
//
// Nothing is rewritten, re-ordered or "repaired" on boot.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readRecords, writeFixture } from '../../scripts/dataLayerFixture.mjs';
import { effectiveFacetState, agreementGrantsAccess, clientTransitionAllowed, agentTransitionAllowed, verificationGap, newFacets } from '../../domains/agents/core/shared.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../repositories/index.mjs';
import { AGENT_CORE_MIGRATION } from '../../repositories/agentCore.mjs';
import { pickPort } from '../../scripts/testPort.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', '..', 'server.mjs');

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
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SCOUTBOX_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return readRecords(dataDir);
  };
  return { up, j, stop, log: () => log };
}

const PORT = pickPort(6500, 200, [0, 1, 3]); // never a fetch-blocked port
const SCHEMA_VERSION = Number(DATA_MIGRATIONS.map((m) => m.id).sort().at(-1).slice(0, 4));
/** The table migrations recorded in a data directory's file, with when each ran. */
const appliedMigrations = (dir) => {
  const st = new DatabaseSync(path.join(dir, 'scoutbox.db'), { readOnly: true });
  try { return st.prepare('SELECT id, applied_at FROM data_migrations ORDER BY id').all().map((r) => ({ id: r.id, at: r.applied_at })); } finally { st.close(); }
};
const T0 = 1_700_000_000_000; // 2023-11-14 — firmly in the past, so createdAt-based windows have started

// ------------------------------------------------------------- fixtures

// A removed staff member is created and then removed, as the team route does (the shared users writer creates only).
const fixture = (dir, collections) => writeFixture(dir, collections);

/** One club, one agency with three staff (one lead, one removed), two agencies, two adult players; no agent rows. */
function staffSnapshot() {
  return {
    players: [
      { id: 'pl-a', name: 'Adult A', dob: '1999-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
      { id: 'pl-b', name: 'Adult B', dob: '1998-01-01', country: 'GB', city: 'London', media: [], attendance: [], trialReports: [], badges: [], timeline: [], medical: { shared: false, records: [], conditionStatus: 'unknown' }, level: 'amateur', location: { lat: 51.5, lng: -0.1 } },
    ],
    orgs: [
      { id: 'org-club', name: 'Club', type: 'club', level: 'pro', plan: 'Pro', verified: true, safeguardingContractSigned: true, location: { lat: 51.5, lng: -0.1 } },
      { id: 'org-ag', name: 'Agency', type: 'agency', level: 'agency', plan: 'Agency', verified: false, location: null },
      { id: 'org-ag2', name: 'Agency Two', type: 'agency', level: 'agency', plan: 'Agency', verified: false, location: null },
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
  };
}

// ======================================================= 1 — the migration
section('1 — migration 0026: registered once; a clean database holds no agent record');
{
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  ok(ids.filter((id) => id === AGENT_CORE_MIGRATION).length === 1 && SCHEMA_VERSION >= 26, `${AGENT_CORE_MIGRATION} is registered once, and the schema has only moved forward since (now ${SCHEMA_VERSION})`);
  neg(new Set(ids.map((id) => id.slice(0, 4))).size === ids.length && ids.every((id) => Number(id.slice(0, 4)) <= SCHEMA_VERSION), `every schema version is reached by exactly one migration, none above the reported schema (${SCHEMA_VERSION})`);
  const freshDir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p1-'));
  const fresh = readRecords(freshDir);
  ok(fresh.agentProfiles.length === 0 && fresh.agencyAffiliations.length === 0 && fresh.representationAgreements.length === 0, 'a clean database holds no agent record: the agent core is tables (migration 0026)');
  neg(!['agentAuth', 'agentSessions', 'agentUsers', 'offers'].some((n) => TABLE_BACKED.includes(n)), 'no agent auth database and no offers store exists');
  const recordsBefore = appliedMigrations(freshDir);
  ok(stableJson(readRecords(freshDir)) === stableJson(fresh) && stableJson(appliedMigrations(freshDir)) === stableJson(recordsBefore), 'reopening the file changes no table and records no migration again');
  for (const s2 of ['agentProfiles', 'agencyAffiliations', 'representationAgreements']) ok(TABLE_BACKED.includes(s2), `${s2} is a table of the agent core, not a collection`);
}

// ======================================================= 2 — staff, no agent rows
section('2 — a database of staff: nothing bootstrapped, nothing mirrored');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p2-'));
  const db = staffSnapshot();
  fixture(dir, db);
  const back = readRecords(dir);
  neg(back.agencyAffiliations.length === 0 && back.agentProfiles.length === 0 && back.representationAgreements.length === 0, 'no agent record is created: staff exist only from their first login');
  const mirror = { id: 'rep-x', agentUserId: null, clientId: 'pl-a', status: 'active', confirmedAt: T0 + 10, startAt: T0 + 10, endAt: T0 + 400 * 24 * 3600 * 1000 };
  neg(!agreementGrantsAccess(mirror, null, T0 + 20) && !agreementGrantsAccess(mirror, 'usr-lead', T0 + 20) && !agreementGrantsAccess(mirror, undefined, T0 + 20), 'an ACTIVE agreement naming no agent grants access to nobody — null, the admin, undefined');
  const staffFacts = (users) => users.map((u) => `${u.id}:${u.orgId}:${u.name}:${u.role}:${u.removedAt ?? ''}`).sort().join();
  neg(staffFacts(back.users) === staffFacts(db.users), 'no user row was touched');
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
    ok(h.body.schemaVersion === SCHEMA_VERSION && appliedMigrations(dir).some((r) => r.id === AGENT_CORE_MIGRATION), `and reports ${h.body.schemaVersion}, with the agent core migration recorded`);
    const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Lead Person', role: 'Managing Director', platform: 'agent' })).body;
    const staff = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Staff Person', role: 'Scout', platform: 'agent' })).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    ok(me.status === 200 && me.body.affiliation.tiers.join() === 'agency_admin', 'the first member into the agency is its administrator (the bootstrap rule)');
    const staffMe = await s.j('GET', '/org/agent/me', undefined, staff.token);
    neg(staffMe.status === 403 && staffMe.body.error === 'AGENCY_MEMBERSHIP_REQUIRED', 'a second person is not a member until an administrator adds them');
    const agency = await s.j('GET', '/org/agent/agency', undefined, lead.token);
    ok(agency.body.relationships.active === 0 && agency.body.relationships.pending === 0, 'the agency overview counts no relationship: none was invented');
    const list = await s.j('GET', '/org/agent/clients', undefined, lead.token);
    ok(list.status === 200 && list.body.items.length === 0, 'and the administrator sees no client row');
    const add = await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, lead.token);
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
  const recordsAtStop = appliedMigrations(dir);
  ok(snap && Number(recordsAtStop.at(-1)?.id.slice(0, 4)) === SCHEMA_VERSION && snap.representationAgreements.length === 1 && snap.agentProfiles.length === 1 && snap.agencyAffiliations.length === 2, 'the database holds one agreement, one profile, two affiliations (read from the tables)');
  const row = snap.representationAgreements[0];
  ok(row.keys.request.key === 'rt-1' && row.keys.confirm.key === 'rt-c' && row.rev === 2 && row.history.length === 2 && row.confirmedBy?.id === 'pl-adeyemi', 'keys, rev, history and confirmation are on disk');
  ok(snap.agentProfiles[0].facets.fifa_licence.provenance.provider === 'local-synthetic-test-provider', 'provenance is on disk');
  neg(!('trust' in row) && !('passport' in row) && !('offer' in row), 'the row carries no trust, passport or offer field');
  s = await bootOn(dir, port + 1);
  ok(s.up && (await s.j('GET', '/healthz')).body.schemaVersion === SCHEMA_VERSION, `reboot at ${SCHEMA_VERSION}`);
  neg(stableJson(appliedMigrations(dir)) === stableJson(recordsAtStop), 'no migration ran again (every record keeps its original time)');
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
  ok(appliedMigrations(dir).filter((r) => r.id === AGENT_CORE_MIGRATION).length === 1 && snap2.representationAgreements.length === 1, 'one migration record, still');
}

// ======================================================= 5 — corruption
section('5 — junk is refused by the typed write; what a typed row can hold is judged on read, never repaired');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p5-'));
  const db = staffSnapshot();
  const profile = {
    id: 'agp-x', userId: 'usr-lead', agencyOrgId: 'org-ag', displayName: 'Lead Person', declared: { fifaLicenceNumber: null, jurisdictions: ['INT'] },
    facets: { ...newFacets(), fifa_licence: { ...newFacets().fifa_licence, state: 'approved', reference: 'X' } },
    createdAt: T0, updatedAt: T0, rev: 1, revAt: T0, revBy: null, history: [],
  };
  const signed = {
    id: 'rep-x', agentUserId: 'usr-lead', agencyOrgId: 'org-ag', clientKind: 'player', clientId: 'pl-b', jurisdiction: 'INT', exclusive: false,
    status: 'signed', confirmedAt: T0, confirmedBy: { kind: 'player', id: 'pl-b' }, scope: ['employment'], termMonths: 12, startAt: T0, endAt: T0 + 1e10, proposedAt: T0,
    declinedAt: null, terminatedAt: null, terminatedBy: null, terminationReasonCode: null, disputedAt: null, disputeReason: null, shareWithAgencyStaff: false,
    policyVersions: [], keys: {}, createdAt: T0, rev: 1, revAt: T0, revBy: null, history: [],
  };
  // The pure rules still judge such records, wherever they might come from.
  neg(effectiveFacetState(profile.facets.fifa_licence, T0) === 'MANUAL_REVIEW_REQUIRED', 'an unknown facet state "approved" reads as MANUAL_REVIEW_REQUIRED');
  neg(verificationGap(profile, 'INT', T0)?.state === 'MANUAL_REVIEW_REQUIRED', 'and is a verification gap');
  neg(!agreementGrantsAccess(signed, 'usr-lead', T0 + 1), 'an agreement with status "signed" grants NO access');
  neg(!clientTransitionAllowed(signed, 'active', T0 + 1) && !agentTransitionAllowed(signed, 'terminated_by_agent', T0 + 1), 'and moves nowhere');
  // The repository's typed create refuses both, naming the record; nothing is written.
  let refused = null;
  const junkDir = () => mkdtempSync(path.join(tmpdir(), 'sbx-m24p5-junk-'));
  try { fixture(junkDir(), { ...db, agentProfiles: [profile] }); } catch (e) { refused = e; }
  neg(refused?.code === 'AGENT_CORE_INPUT_INVALID' && /agp-x/.test(refused.message) && /state/.test(refused.message), `a facet state the table does not know is refused by the repository, naming the profile (${refused?.message ?? 'saved'})`);
  refused = null;
  try { fixture(junkDir(), { ...db, representationAgreements: [signed] }); } catch (e) { refused = e; }
  neg(refused?.code === 'AGENT_CORE_INPUT_INVALID' && /rep-x/.test(refused.message) && /status/.test(refused.message), `an agreement status the table does not know is refused by the repository, naming the agreement (${refused?.message ?? 'saved'})`);
  // An odd row a typed table CAN hold: an ACTIVE agreement nobody confirmed (a dispute of a proposal reinstated by review).
  const unconfirmed = { ...signed, id: 'rep-y', status: 'active', confirmedAt: null, confirmedBy: null, endAt: Date.now() + 1e10 };
  db.agentProfiles = [{ ...profile, facets: newFacets(), userId: 'usr-lead' }];
  db.representationAgreements = [unconfirmed];
  fixture(dir, db);
  const stored = stableJson(readRecords(dir).representationAgreements.find((r) => r.id === 'rep-y'));
  const s = await bootOn(dir, PORT + 3);
  ok(s.up, 'the server boots over the odd row');
  if (s.up) {
    const lead = (await s.j('POST', '/auth/org/login', { orgId: 'org-ag', scoutName: 'Lead Person', role: 'Managing Director', platform: 'agent' })).body;
    const me = await s.j('GET', '/org/agent/me', undefined, lead.token);
    const add = await s.j('POST', '/org/agent/agency/team', { name: 'Second Admin', tiers: ['agency_admin'] }, lead.token);
    await s.j('PATCH', `/org/agent/agency/team/${me.body.user.id}`, { tiers: ['agency_admin', 'licensed_agent'], expectedRev: me.body.affiliation.rev }, lead.token);
    const d = await s.j('GET', '/org/agent/clients/rep-y', undefined, lead.token);
    neg(d.status === 200 && d.body.access === false && d.body.relationship.status === 'active', 'the unconfirmed agreement is shown with its stored word and access false');
    neg((await s.j('GET', '/org/agent/clients/rep-y/opportunities', undefined, lead.token)).status === 409, 'and opens no board');
    const after = await s.stop();
    neg(stableJson(after.representationAgreements.find((r) => r.id === 'rep-y')) === stored, 'nothing was repaired on boot or by reading — the bytes are the bytes');
    ok(add.status === 201, '(setup)');
  }
}

// ======================================================= 6 — the sweep's notices
section('6 — the sweep tells a current member once that a relationship is ending; an agent who left is not told');
{
  const dir = mkdtempSync(path.join(tmpdir(), 'sbx-m24p6-'));
  const db = staffSnapshot();
  const aff = (id, userId, over = {}) => ({ id, agencyOrgId: 'org-ag', userId, tiers: ['agency_admin', 'licensed_agent'], startedAt: T0, endedAt: null, endedReason: null, createdAt: T0, rev: 1, revAt: T0, revBy: null, keys: {}, history: [], ...over });
  const ending = (id, agentUserId, clientId) => ({
    id, agentUserId, agencyOrgId: 'org-ag', clientKind: 'player', clientId, jurisdiction: 'INT', exclusive: false, termMonths: 12, startAt: T0, endAt: Date.now() + 10 * 86_400_000,
    status: 'active', proposedAt: T0, confirmedAt: T0, confirmedBy: { kind: 'player', id: clientId }, declinedAt: null, terminatedAt: null, terminatedBy: null, terminationReasonCode: null,
    disputedAt: null, disputeReason: null, shareWithAgencyStaff: false, scope: ['employment'], policyVersions: [], keys: {}, createdAt: T0, rev: 1, revAt: T0, revBy: null, history: [],
  });
  db.agencyAffiliations = [aff('aff-lead', 'usr-lead'), aff('aff-staff', 'usr-staff', { endedAt: T0 + 5, endedReason: 'left' })];
  db.representationAgreements = [ending('rep-live', 'usr-lead', 'pl-a'), ending('rep-left', 'usr-staff', 'pl-b')];
  fixture(dir, db);
  const s = await bootOn(dir, PORT + 4);
  ok(s.up, 'the server boots over two relationships ending within 30 days');
  if (s.up) {
    await sleep(500); // the sweep runs once at boot
    const after = await s.stop();
    const expiring = (after.notifications ?? []).filter((n) => n.type === 'representation_expiring');
    ok(expiring.length === 1 && JSON.stringify(expiring[0]).includes('usr-lead') && JSON.stringify(expiring[0]).includes('rep-live'), 'the current member is told once that their relationship is ending');
    neg(!expiring.some((n) => JSON.stringify(n).includes('usr-staff')), 'an agent whose membership ended is not told');
    neg(after.representationAgreements.every((a) => typeof a.expiryNotifiedAt === 'number'), 'both relationships are marked, so neither is looked at again');
  }
}

console.log(`\nagents/corePersistence: ${passed} checks passed, ${negatives} negative/integrity checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) console.error('SOME CHECKS FAILED'); else console.log('all agents/corePersistence checks passed');
process.exit(process.exitCode ?? 0);
