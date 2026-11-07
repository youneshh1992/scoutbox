// S11a — the agent core (profiles, agency affiliations, representation agreements, agency settings) as typed tables
// with explicit writes (repositories/agentCore.mjs, migration 0026). What this suite proves: the migration creates the
// fifteen STRICT tables (no JSON column), empty on a fresh database, and removes the retired orgs.agencySettings facet;
// the typers refuse junk with the record and field named (an unknown field, an unknown facet state or agreement status,
// a facet filed under the wrong member association, a request entry that disagrees with its agreement, a minor);
// each record is created whole and read back; an update keeps what never changes, writes a key once, never reopens an
// ended membership, keeps a share's content and only grows the history; the queries answer what the routes need; a
// client's removal leaves id-only tombstones; a rolled-back unit leaves nothing; the db.* names throw; and the
// snapshot write types every record, names a missing staff member and reads back what it wrote. Temporary databases
// only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  AGENT_CORE_MIGRATION as MIGRATION, AGENT_CORE_TABLES as TABLES, AGENT_CORE_COLLECTIONS as COLLECTIONS,
  typeAgentProfile, typeAgencyAffiliation, typeRepresentationAgreement, typeAgencySettings,
} from '../repositories/agentCore.mjs';
import { newFacets } from '../domains/agents/core/shared.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};
const DAY = 86_400_000;

// ------------------------------------------------------------- fixtures: the literals the routes write
const UID = SCOUT.userId;
const BY = { kind: 'org', userId: UID, name: SCOUT.name };
const entry = (id, action, detail = null, over = {}) => ({ id, at: NOW, action, by: BY, detail, ...over });
/** POST /org/agent/profile (domains/agents/core/index.mjs). */
const profile = (over = {}) => ({
  id: 'agp-1', userId: UID, agencyOrgId: ORG.id, displayName: 'Maria', declared: { fifaLicenceNumber: null, jurisdictions: ['ENG'] },
  facets: newFacets(), createdAt: NOW, updatedAt: NOW, rev: 1, revAt: NOW, revBy: null, history: [entry('aud-p1', 'agent_profile_created')], ...over,
});
const verified = (over = {}) => ({ ...newFacets().fifa_licence, state: 'VERIFIED', reference: 'TEST-VERIFIED-1', provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: NOW }, submittedAt: NOW, verifiedAt: NOW, recheckAt: NOW + 30 * DAY, ...over });
/** The first member into an agency (the bootstrap rule) and POST /org/agent/agency/team. */
const affiliation = (over = {}) => ({
  id: 'aff-1', agencyOrgId: ORG.id, userId: UID, tiers: ['agency_admin'], startedAt: NOW, endedAt: null, endedReason: null,
  createdAt: NOW, rev: 1, revAt: NOW, revBy: null, keys: {}, history: [entry('aud-a1', 'agency_affiliation_created', { tiers: ['agency_admin'], bootstrap: true })], ...over,
});
/** POST /org/agent/clients/request. */
const agreement = (over = {}) => {
  const a = {
    id: 'rep-1', agentUserId: UID, agencyOrgId: ORG.id, clientKind: 'player', clientId: 'pl-1', jurisdiction: 'ENG', exclusive: false, termMonths: 12, startAt: null, endAt: null,
    status: 'proposed', proposedAt: NOW, confirmedAt: null, confirmedBy: null, declinedAt: null, terminatedAt: null, terminatedBy: null, terminationReasonCode: null,
    disputedAt: null, disputeReason: null, shareWithAgencyStaff: false, scope: ['employment'], policyVersions: [], keys: { request: { key: 'k-req', fp: '{}' } },
    createdAt: NOW, rev: 1, revAt: NOW, revBy: null, ...over,
  };
  a.history ??= [entry('aud-r1', 'representation_requested', { scope: a.scope, termMonths: a.termMonths, jurisdiction: a.jurisdiction, policyVersions: a.policyVersions })];
  return a;
};
const share = (over = {}) => ({ id: 'shr-1', opportunityId: 'opp-1', via: 'opportunity', title: 'Trial at Eastport', orgName: ORG.name, deadline: null, note: 'Worth a look', sharedAt: NOW, sharedBy: { kind: 'org', userId: UID, name: SCOUT.name }, withdrawnAt: null, rev: 1, revAt: NOW, keys: {}, ...over });

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.agentCore, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0026 is registered after 0025, creates the fifteen STRICT tables (no JSON column), empty on a fresh database (S14g: the organisations have no facets to clean up)', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0025_transitions_vouches') + 1);
  assert.equal(TABLES.length, 15);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11a-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  assert.ok(!s.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'facets_json'), 'the organisations have no facet column');
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeAgentProfile(profile()).ok, true);
  assert.match(typeAgentProfile(profile({ sneaky: 1 })).reason, /agp-1 carries field\(s\) this build does not store: sneaky/);
  assert.match(typeAgentProfile(profile({ policyVersion: 1 })).reason, /policyVersion/);
  assert.match(typeAgentProfile(profile({ facets: { ...newFacets(), fifa_licence: verified({ state: 'approved' }) } })).reason, /fifa_licence.*state must be one of/);
  assert.match(typeAgentProfile(profile({ facets: { ...newFacets(), national_registration: { ENG: { ...verified(), memberAssociation: 'USA' } } } })).reason, /memberAssociation must be ENG/);
  assert.match(typeAgentProfile(profile({ facets: { ...newFacets(), national_registration: { INT: { ...verified(), memberAssociation: 'INT' } } } })).reason, /not a member association/);
  assert.match(typeAgentProfile(profile({ facets: { ...newFacets(), passport: {} } })).reason, /facets carries field\(s\) this build does not store: passport/);
  assert.match(typeAgentProfile(profile({ declared: { jurisdictions: ['ENG', 'XYZ'] } })).reason, /declared\.jurisdictions/);
  assert.equal(typeAgencyAffiliation(affiliation()).ok, true);
  assert.match(typeAgencyAffiliation(affiliation({ tiers: [] })).reason, /tiers/);
  assert.match(typeAgencyAffiliation(affiliation({ tiers: ['owner'] })).reason, /tiers/);
  assert.match(typeAgencyAffiliation(affiliation({ endedAt: NOW + 1 })).reason, /endedReason is given when the membership ends/);
  assert.match(typeAgencyAffiliation(affiliation({ history: [entry('aud-a1', 'agency_affiliation_created', { tiers: ['agency_admin'], legacy: true })] })).reason, /detail carries field\(s\) this build does not store: legacy/);
  assert.equal(typeRepresentationAgreement(agreement()).ok, true);
  assert.equal(typeRepresentationAgreement(agreement()).record.isRegulatoryMinor, false, 'a stored agreement is never a minor\'s');
  assert.match(typeRepresentationAgreement(agreement({ status: 'signed' })).reason, /rep-1.*status must be one of/);
  assert.match(typeRepresentationAgreement(agreement({ status: 'expired' })).reason, /status must be one of/, 'expired is derived, never stored');
  assert.match(typeRepresentationAgreement(agreement({ isRegulatoryMinor: true })).reason, /isRegulatoryMinor is always false/);
  assert.match(typeRepresentationAgreement(agreement({ confirmedAt: NOW })).reason, /confirmedBy is set exactly when confirmedAt is/);
  assert.match(typeRepresentationAgreement(agreement({ documents: [] })).reason, /documents/, 'the legacy lane\'s documents are gone');
  assert.match(typeRepresentationAgreement(agreement({ termMonths: 0 })).reason, /termMonths must be 1 to/);
  assert.match(typeRepresentationAgreement(agreement({ history: [entry('aud-r1', 'representation_requested', { scope: ['transfer'], termMonths: 12, jurisdiction: 'ENG', policyVersions: [] })] })).reason, /a request entry repeats the agreement's own scope/);
  assert.match(typeRepresentationAgreement(agreement({ opportunityShares: [share(), share({ id: 'shr-2' })] })).reason, /shares one opportunity twice/);
  assert.match(typeRepresentationAgreement(agreement({ history: [...agreement().history, entry('aud-r1', 'representation_rejected', { from: 'proposed', to: 'declined', by: 'client', hadReason: false })] })).reason, /history names an id twice/);
  assert.deepEqual(typeAgencySettings({ jurisdictions: ['ENG'], description: 'Boutique' }).record, { jurisdictions: ['ENG'], description: 'Boutique' });
  assert.match(typeAgencySettings({ jurisdictions: ['ENG'], website: 'x' }).reason, /does not store: website/);
});

// ------------------------------------------------------------- writes and reads
test('[profiles] a profile is created whole with every facet and read back; the user and agency never change; one profile per staff member; the sweep finds stale facets', () => {
  const dir = tempDir('s11a-profiles'); saveFixture(dir);
  const s = serverOpen(dir);
  const P = s.repo.profiles;
  try {
    const p = P.create(profile({ declared: { fifaLicenceNumber: 'FIFA-1', jurisdictions: ['INT', 'ENG'] } }));
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.facets.fifa_licence), 'deep-frozen');
    assert.deepEqual(p.declared, { fifaLicenceNumber: 'FIFA-1', jurisdictions: ['INT', 'ENG'] }, 'the declared jurisdictions keep their order');
    assert.deepEqual(Object.keys(p.facets).sort(), ['domestic_authorisation', 'fifa_licence', 'minors_authorisation', 'national_registration'], 'every facet, the domestic one included');
    assert.equal(P.forUser(UID).id, 'agp-1');
    refused(() => P.create(profile()), /already exists/, 'duplicate id');
    refused(() => P.create(profile({ id: 'agp-2', history: [] })), /already has a profile/, 'a second profile for one staff member');
    const v = P.update('agp-1', (d) => {
      d.facets.fifa_licence = verified({ recheckAt: NOW + DAY });
      d.facets.national_registration.ENG = { ...verified({ reference: 'FA-1', recheckAt: NOW + DAY }), memberAssociation: 'ENG' };
      d.history.push(entry('aud-p2', 'agent_verification_state_changed', { facet: 'fifa_licence', memberAssociation: null, from: 'UNVERIFIED', to: 'VERIFIED', state: 'VERIFIED' }));
    });
    assert.equal(v.facets.fifa_licence.state, 'VERIFIED'); assert.equal(v.facets.national_registration.ENG.reference, 'FA-1');
    assert.deepEqual(v.history.map((h) => h.id), ['aud-p1', 'aud-p2']);
    refused(() => P.update('agp-1', (d) => { d.userId = 'usr-2'; }), /userId cannot change/, 'user change');
    refused(() => P.update('agp-1', (d) => { d.agencyOrgId = 'org-other'; }), /agencyOrgId cannot change/, 'agency change');
    refused(() => P.update('agp-1', (d) => { d.history.pop(); }), /only grows/, 'history dropped');
    refused(() => P.update('agp-1', (d) => { d.history.push(entry('aud-p1', 'agent_profile_updated', { fields: ['displayName'] })); }), /names an id twice|already exists/, 'a reused entry id');
    refused(() => P.update('agp-1', () => { P.update('agp-1', () => {}); }), /already being updated/, 'nested update');
    assert.deepEqual(P.staleUnnotified(NOW + 2 * DAY).map((x) => x.id), ['agp-1'], 'a VERIFIED facet past its recheck date');
    P.update('agp-1', (d) => { d.facets.fifa_licence.staleNotifiedAt = NOW + 2 * DAY; });
    assert.deepEqual(P.staleUnnotified(NOW + 2 * DAY).map((x) => x.id), ['agp-1'], 'still listed: the FA registration is stale too');
    P.update('agp-1', (d) => { d.facets.national_registration.ENG.staleNotifiedAt = NOW + 2 * DAY; });
    assert.deepEqual(P.staleUnnotified(NOW + 40 * DAY), [], 'each stale facet is told once');
    assert.equal(typeof s.repo.reads.profiles.update, 'undefined', 'the reads carry no writes');
  } finally { s.close(); rm(dir); }
});

test('[affiliations] a membership is active in its window; roles change through an update; an ended membership does not reopen; the create key is written once', () => {
  const dir = tempDir('s11a-affiliations'); saveFixture(dir);
  const s = serverOpen(dir);
  const A = s.repo.affiliations;
  try {
    assert.equal(A.anyActiveIn(ORG.id, NOW), false);
    A.create(affiliation({ keys: { create: { key: 'k-team', fp: '{}' } } }));
    assert.equal(A.activeFor(UID, ORG.id, NOW).id, 'aff-1');
    assert.equal(A.activeFor(UID, ORG.id, NOW - 1), null, 'not before it started');
    assert.equal(A.byCreateKey(ORG.id, 'k-team').id, 'aff-1');
    const u = A.update('aff-1', (d) => { d.tiers = ['agency_admin', 'licensed_agent']; d.rev += 1; d.history.push(entry('aud-a2', 'agency_affiliation_updated', { from: ['agency_admin'], to: ['agency_admin', 'licensed_agent'], tiers: ['agency_admin', 'licensed_agent'] })); });
    assert.deepEqual(u.tiers, ['agency_admin', 'licensed_agent']);
    assert.deepEqual(u.history[1].detail, { from: ['agency_admin'], to: ['agency_admin', 'licensed_agent'], tiers: ['agency_admin', 'licensed_agent'] }, 'the role change reads back from its rows');
    refused(() => A.update('aff-1', (d) => { d.keys = {}; }), /keys cannot change/, 'the create key');
    refused(() => A.update('aff-1', (d) => { d.startedAt -= DAY; }), /startedAt cannot change/, 'backdated');
    A.update('aff-1', (d) => { d.endedAt = NOW + DAY; d.endedReason = 'left'; d.history.push(entry('aud-a3', 'agency_affiliation_ended', { reasonCode: 'left' })); });
    assert.equal(A.activeFor(UID, ORG.id, NOW + 2 * DAY), null, 'ended');
    refused(() => A.update('aff-1', (d) => { d.endedAt = null; d.endedReason = null; }), /an ended membership does not reopen/, 'reopened');
    refused(() => A.create(affiliation({ id: 'aff-2', userId: 'usr-none', history: [] })), /FOREIGN KEY/, 'a member who is not staff');
  } finally { s.close(); rm(dir); }
});

test('[agreements] an agreement is created whole; its parties, scope and term never change; a key is written once; shares only gain rows; a client\'s removal leaves tombstones', () => {
  const dir = tempDir('s11a-agreements'); saveFixture(dir);
  const s = serverOpen(dir);
  const R = s.repo.agreements;
  try {
    const a = R.create(agreement());
    assert.deepEqual(a.history[0].detail, { scope: ['employment'], termMonths: 12, jurisdiction: 'ENG', policyVersions: [] }, 'the request entry is read from the agreement itself');
    assert.equal(R.byRequestKey(ORG.id, UID, 'k-req').id, 'rep-1');
    refused(() => R.create(agreement({ id: 'rep-p', policyVersions: ['jp-none-1'], history: undefined })), /policy version jp-none-1 is not a known policy/, 'an unknown policy version');
    const c = R.update('rep-1', (d) => {
      d.status = 'active'; d.confirmedAt = NOW + 1; d.confirmedBy = { kind: 'player', id: 'pl-1' }; d.startAt = NOW + 1; d.endAt = NOW + 365 * DAY; d.keys.confirm = { key: 'k-conf', fp: '{}' }; d.rev += 1;
      d.history.push(entry('aud-r2', 'representation_confirmed', { from: 'proposed', to: 'active', by: 'client', hadReason: false }, { by: { kind: 'player', userId: 'pl-1', name: 'Kola' } }));
    });
    assert.equal(c.status, 'active'); assert.deepEqual(c.confirmedBy, { kind: 'player', id: 'pl-1' });
    refused(() => R.update('rep-1', (d) => { d.scope = ['transfer']; }), /scope cannot change|repeats the agreement's own scope/, 'scope');
    refused(() => R.update('rep-1', (d) => { d.clientId = 'pl-2'; d.confirmedBy = { kind: 'player', id: 'pl-2' }; }), /clientId cannot change/, 'client');
    refused(() => R.update('rep-1', (d) => { d.keys.confirm = { key: 'k-other', fp: '{}' }; }), /the confirm key is written once/, 'a key rewritten');
    R.update('rep-1', (d) => { d.opportunityShares = [share()]; d.history.push(entry('aud-r3', 'opportunity_shared', { shareId: 'shr-1', via: 'opportunity' })); });
    refused(() => R.update('rep-1', (d) => { d.opportunityShares = []; }), /a share cannot be removed/, 'share removed');
    refused(() => R.update('rep-1', (d) => { d.opportunityShares[0].note = 'Edited'; }), /share shr-1 keeps what was shared/, 'share edited');
    R.update('rep-1', (d) => { d.opportunityShares[0].withdrawnAt = NOW + 2; d.history.push(entry('aud-r4', 'opportunity_share_withdrawn', { shareId: 'shr-1' })); });
    refused(() => R.update('rep-1', (d) => { d.opportunityShares[0].withdrawnAt = NOW + 3; }), /already withdrawn/, 'withdrawn twice');
    assert.deepEqual(R.forClient('pl-1').map((x) => x.id), ['rep-1']);
    assert.deepEqual(R.forAgentClient(UID, 'pl-1').map((x) => x.id), ['rep-1']);
    assert.deepEqual(R.expiringUnnotified(NOW + 360 * DAY, 30 * DAY).map((x) => x.id), ['rep-1'], 'ending within the window');
    R.create(agreement({ id: 'rep-2', clientId: 'pl-1', keys: {}, history: [entry('aud-r5', 'representation_requested', { scope: ['employment'], termMonths: 12, jurisdiction: 'ENG', policyVersions: [] })] }));
    R.redactClient('pl-1', NOW + 5);
    const [t1, t2] = R.forClient('pl-1');
    assert.equal(t1.subjectRemovedAt, NOW + 5); assert.equal(t1.status, 'active', 'an active agreement keeps its status');
    assert.equal(t2.status, 'declined', 'a pending request is declined'); assert.equal(t2.declinedAt, NOW + 5);
    assert.deepEqual(t1.history[1].by, { kind: 'player', userId: null, name: null }, 'the client\'s name leaves the history');
    assert.deepEqual(t1.history[0].by, BY, 'the agent\'s own entries stay attributed');
    const first = R.page({ limit: 1 }).rows;
    assert.deepEqual(first.map((r) => r.record.id), ['rep-2', 'rep-1'], 'limit + 1 rows, newest first');
  } finally { s.close(); rm(dir); }
});

test('[settings] an agency\'s settings are empty until saved, then typed whole', () => {
  const dir = tempDir('s11a-settings'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.deepEqual(s.repo.settings.forOrg(ORG.id), { jurisdictions: [], description: '' });
    assert.deepEqual(s.repo.settings.save(ORG.id, { jurisdictions: ['USA', 'ENG'], description: 'Boutique' }), { jurisdictions: ['USA', 'ENG'], description: 'Boutique' });
    refused(() => s.repo.settings.save(ORG.id, { jurisdictions: ['XYZ'] }), /jurisdictions/, 'an unknown jurisdiction');
    refused(() => s.repo.settings.save('org-none', { jurisdictions: [] }), /FOREIGN KEY/, 'an organisation that does not exist');
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves nothing; the db.* names throw', () => {
  const dir = tempDir('s11a-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.throws(() => s.unit(() => { s.repo.profiles.create(profile()); s.repo.affiliations.create(affiliation()); s.repo.agreements.create(agreement()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.reads.profiles.byId('agp-1'), null);
    assert.equal(s.repo.reads.affiliations.byId('aff-1'), null);
    assert.equal(s.repo.reads.agreements.byId('rep-1'), null);
    for (const n of COLLECTIONS) assert.throws(() => s.db[n], new RegExp(`db\\.${n} is gone: read it through the agentCore repository`));
  } finally { s.close(); rm(dir); }
});

test('[snapshot] the snapshot write types every record, names a missing staff member, and reads back what it wrote', () => {
  const dir = tempDir('s11a-snap');
  const p = profile({ facets: { ...newFacets(), fifa_licence: verified() } });
  saveFixture(dir, { agentProfiles: [p], agencyAffiliations: [affiliation()], representationAgreements: [agreement()] });
  const store = openStore(dir);
  try {
    const back = readTableBacked(store.sqlite);
    assert.deepEqual(back.agentProfiles, [typeAgentProfile(p).record]);
    assert.deepEqual(back.agencyAffiliations, [typeAgencyAffiliation(affiliation()).record]);
    assert.deepEqual(back.representationAgreements, [typeRepresentationAgreement(agreement()).record]);
    refused(() => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, agencyAffiliations: [affiliation({ userId: 'usr-none' })] } }), /AGENT_CORE_REFERENCE_MISSING[\s\S]*aff-1 userId → org_users usr-none/, 'missing staff member');
    refused(() => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, representationAgreements: [agreement({ status: 'signed' })] } }), /AGENT_CORE_IMPORT_BLOCKED.*rep-1.*status/, 'an unknown status');
    refused(() => store.save({ savedAt: NOW, idCounter: 1000, db: { ...store.load().db, agentProfiles: [p, profile({ id: 'agp-2', history: [entry('aud-p9', 'agent_profile_created')] })] } }), /two agent profiles name one staff member/, 'two profiles for one person');
    assert.deepEqual(readTableBacked(store.sqlite).agentProfiles, [typeAgentProfile(p).record], 'a refused save wrote nothing');
  } finally { store.sqlite.close(); rm(dir); }
});

console.log(`\nagent core repository: ${passed} checks passed`);
