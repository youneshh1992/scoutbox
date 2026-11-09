// The agent core (profiles, agency affiliations, representation agreements, agency settings;
// repositories/agentCore.mjs, migration 0026): the STRICT tables, the typers' refusals (a minor included), records read
// back whole, named acts that move a status only along its table and never reopen an ended membership, the routes' queries, a
// client's removal leaving id-only tombstones, units of work and fixtures. Temporary databases only; nothing touches
// DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
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
  const L = openLayer(dir, { nextId, sessionTtlMs: TTL, now: () => NOW });
  return { store: L.store, repo: L.layer.agentCore, unit: L.unit, close: L.close };
}

// ------------------------------------------------------------- schema
test('[schema] 0026 is registered after 0025, creates the fifteen STRICT tables (no JSON column), empty on a fresh database', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0025_transitions_vouches') + 1);
  assert.equal(TABLES.length, 15);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11a-empty'); const s = openLayer(dir).sqlite;
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
    P.setFacet('agp-1', { facet: 'fifa_licence', record: verified({ recheckAt: NOW + DAY }) }, { history: [entry('aud-p2', 'agent_verification_state_changed', { facet: 'fifa_licence', memberAssociation: null, from: 'UNVERIFIED', to: 'VERIFIED', state: 'VERIFIED' })] });
    const v = P.setFacet('agp-1', { facet: 'national_registration', memberAssociation: 'ENG', record: { ...verified({ reference: 'FA-1', recheckAt: NOW + DAY }), memberAssociation: 'ENG' } }, { at: NOW + 1, touch: true, bump: { at: NOW + 1, by: { id: UID, name: SCOUT.name } } });
    assert.equal(v.facets.fifa_licence.state, 'VERIFIED'); assert.equal(v.facets.national_registration.ENG.reference, 'FA-1');
    assert.deepEqual([v.history.map((h) => h.id), v.rev, v.updatedAt], [['aud-p1', 'aud-p2'], 2, NOW + 1]);
    refused(() => P.setFacet('agp-1', { facet: 'national_registration', memberAssociation: 'ENG', record: { ...verified(), memberAssociation: 'USA' } }), /memberAssociation must be ENG/, 'a facet names its own member association');
    refused(() => P.recordAct('agp-1', { history: [entry('aud-p1', 'agent_profile_updated', { fields: ['displayName'] })] }), /already exists/, 'a reused entry id');
    refused(() => P.recordAct('agp-1', { history: [entry('aud-p3', 'agent_profile_updated', { fields: ['mood'] })] }), /AGENT_CORE_INPUT_INVALID/, 'an entry is typed');
    const d = P.updateDeclared('agp-1', { displayName: 'Ana C.', jurisdictions: ['ENG'] }, { history: [entry('aud-p4', 'agent_profile_updated', { fields: ['displayName', 'jurisdictions'] })] });
    assert.deepEqual([d.displayName, d.declared.jurisdictions, d.userId, d.history.at(-1).detail], ['Ana C.', ['ENG'], UID, { fields: ['displayName', 'jurisdictions'] }], 'the declared details change; the user never does');
    assert.equal(typeof P.update, 'undefined', 'there is no whole-record update');
    assert.deepEqual(P.staleUnnotified(NOW + 2 * DAY).map((x) => x.id), ['agp-1'], 'a VERIFIED facet past its recheck date');
    P.markStaleNotified('agp-1', { facets: [['fifa_licence', null]], at: NOW + 2 * DAY });
    assert.deepEqual(P.staleUnnotified(NOW + 2 * DAY).map((x) => x.id), ['agp-1'], 'still listed: the FA registration is stale too');
    P.markStaleNotified('agp-1', { facets: [['national_registration', 'ENG']], at: NOW + 2 * DAY });
    assert.deepEqual(P.staleUnnotified(NOW + 40 * DAY), [], 'each stale facet is told once');
    refused(() => P.markStaleNotified('agp-1', { facets: [['fifa_licence', null]], at: NOW + 3 * DAY }), /STATE_CONFLICT.*already marked stale/);
    assert.equal(typeof s.repo.reads.profiles.setFacet, 'undefined', 'the reads carry no writes');
  } finally { s.close(); rm(dir); }
});

test('[affiliations] a membership is active in its window; roles change through an act; an ended membership does not reopen; the create key is written once', () => {
  const dir = tempDir('s11a-affiliations'); saveFixture(dir);
  const s = serverOpen(dir);
  const A = s.repo.affiliations;
  try {
    assert.equal(A.anyActiveIn(ORG.id, NOW), false);
    A.create(affiliation({ keys: { create: { key: 'k-team', fp: '{}' } } }));
    assert.equal(A.activeFor(UID, ORG.id, NOW).id, 'aff-1');
    assert.equal(A.activeFor(UID, ORG.id, NOW - 1), null, 'not before it started');
    assert.equal(A.byCreateKey(ORG.id, 'k-team').id, 'aff-1');
    const u = A.setTiers('aff-1', { tiers: ['agency_admin', 'licensed_agent'] }, { bump: { at: NOW, by: { id: UID, name: SCOUT.name } }, history: [entry('aud-a2', 'agency_affiliation_updated', { from: ['agency_admin'], to: ['agency_admin', 'licensed_agent'], tiers: ['agency_admin', 'licensed_agent'] })] });
    assert.deepEqual([u.tiers, u.rev, u.keys.create.key, u.startedAt], [['agency_admin', 'licensed_agent'], 2, 'k-team', NOW], 'the roles change; the create key and the start do not');
    assert.deepEqual(u.history[1].detail, { from: ['agency_admin'], to: ['agency_admin', 'licensed_agent'], tiers: ['agency_admin', 'licensed_agent'] }, 'the role change reads back from its rows');
    refused(() => A.setTiers('aff-1', { tiers: ['owner'] }), /AGENT_CORE_INPUT_INVALID/, 'a role the vocabulary does not know');
    A.end('aff-1', { at: NOW + DAY, reason: 'left' }, { history: [entry('aud-a3', 'agency_affiliation_ended', { reasonCode: 'left' })] });
    assert.equal(A.activeFor(UID, ORG.id, NOW + 2 * DAY), null, 'ended');
    refused(() => A.end('aff-1', { at: NOW + 2 * DAY, reason: 'left' }), /STATE_CONFLICT.*already ended/, 'an ended membership does not end again');
    refused(() => A.setTiers('aff-1', { tiers: ['licensed_agent'] }), /STATE_CONFLICT.*has ended/, 'or change');
    refused(() => A.create(affiliation({ id: 'aff-2', userId: 'usr-none', history: [] })), /FOREIGN KEY/, 'a member who is not staff');
  } finally { s.close(); rm(dir); }
});

test('[agreements] an agreement is created whole; it moves only along its transition tables; shares only gain rows and are withdrawn once; a client\'s removal leaves tombstones', () => {
  const dir = tempDir('s11a-agreements'); saveFixture(dir);
  const s = serverOpen(dir);
  const R = s.repo.agreements;
  try {
    const a = R.create(agreement());
    assert.deepEqual(a.history[0].detail, { scope: ['employment'], termMonths: 12, jurisdiction: 'ENG', policyVersions: [] }, 'the request entry is read from the agreement itself');
    assert.equal(R.byRequestKey(ORG.id, UID, 'k-req').id, 'rep-1');
    refused(() => R.create(agreement({ id: 'rep-p', policyVersions: ['jp-none-1'], history: undefined })), /policy version jp-none-1 is not a known policy/, 'an unknown policy version');
    const c = R.answerByClient('rep-1', { to: 'active', at: NOW + 1, playerId: 'pl-1', key: { key: 'k-conf', fp: '{}' }, slot: 'confirm' },
      { bump: { at: NOW + 1, by: { id: 'pl-1', name: 'Kola' } }, history: [entry('aud-r2', 'representation_confirmed', { from: 'proposed', to: 'active', by: 'client', hadReason: false }, { by: { kind: 'player', userId: 'pl-1', name: 'Kola' } })] });
    assert.deepEqual([c.status, c.confirmedBy, c.startAt, c.endAt, c.keys.confirm.key, c.rev], ['active', { kind: 'player', id: 'pl-1' }, NOW + 1, NOW + 1 + 12 * 30 * DAY, 'k-conf', 2], 'confirmed: the term runs from the confirmation');
    refused(() => R.answerByClient('rep-1', { to: 'active', at: NOW + 2, playerId: 'pl-1', slot: 'confirm' }), /STATE_CONFLICT.*cannot move to active/, 'confirmed once');
    refused(() => R.answerByClient('rep-1', { to: 'declined', at: NOW + 2, playerId: 'pl-1', slot: 'decline' }), /STATE_CONFLICT/, 'an active relationship is not declined');
    refused(() => R.resolveDispute('rep-1', { outcome: 'ended', reviewId: 'rrv-1', at: NOW + 2 }), /STATE_CONFLICT.*not disputed/);
    R.addShare('rep-1', { share: share() }, { history: [entry('aud-r3', 'opportunity_shared', { shareId: 'shr-1', via: 'opportunity' })] });
    refused(() => R.addShare('rep-1', { share: share({ id: 'shr-2' }) }), /AGENT_CORE_INPUT_INVALID/, 'one live share per opportunity');
    R.withdrawShare('rep-1', { shareId: 'shr-1', at: NOW + 2 }, { history: [entry('aud-r4', 'opportunity_share_withdrawn', { shareId: 'shr-1' })] });
    assert.deepEqual([R.byId('rep-1').opportunityShares[0].withdrawnAt, R.byId('rep-1').opportunityShares[0].rev], [NOW + 2, 2]);
    refused(() => R.withdrawShare('rep-1', { shareId: 'shr-1', at: NOW + 3 }), /already withdrawn/, 'withdrawn twice');
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

test('[units] a rolled-back unit leaves nothing', () => {
  const dir = tempDir('s11a-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.throws(() => s.unit(() => { s.repo.profiles.create(profile()); s.repo.affiliations.create(affiliation()); s.repo.agreements.create(agreement()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.reads.profiles.byId('agp-1'), null);
    assert.equal(s.repo.reads.affiliations.byId('aff-1'), null);
    assert.equal(s.repo.reads.agreements.byId('rep-1'), null);
  } finally { s.close(); rm(dir); }
});

test('[fixtures] a record written through the repository is typed, a missing staff member is refused, and the records read back as written', () => {
  const dir = tempDir('s11a-fix');
  const p = profile({ facets: { ...newFacets(), fifa_licence: verified() } });
  saveFixture(dir, { agentProfiles: [p], agencyAffiliations: [affiliation()], representationAgreements: [agreement()] });
  try {
    const back = readRecords(dir);
    assert.deepEqual(back.agentProfiles, [typeAgentProfile(p).record]);
    assert.deepEqual(back.agencyAffiliations, [typeAgencyAffiliation(affiliation()).record]);
    assert.deepEqual(back.representationAgreements, [typeRepresentationAgreement(agreement()).record]);
    const bad = [tempDir('s11a-fix-staff'), tempDir('s11a-fix-status'), tempDir('s11a-fix-two')];
    refused(() => saveFixture(bad[0], { agencyAffiliations: [affiliation({ userId: 'usr-none' })] }), /FOREIGN KEY constraint failed/, 'missing staff member');
    refused(() => saveFixture(bad[1], { representationAgreements: [agreement({ status: 'signed' })] }), /AGENT_CORE_INPUT_INVALID.*rep-1.*status/, 'an unknown status');
    refused(() => saveFixture(bad[2], { agentProfiles: [p, profile({ id: 'agp-2', history: [entry('aud-p9', 'agent_profile_created')] })] }), /AGENT_CORE_DUPLICATE: agent_profiles: usr-1 already has a profile/, 'two profiles for one person');
    for (const d of bad) { const r = readRecords(d); assert.deepEqual([r.agentProfiles.length, r.agencyAffiliations.length, r.representationAgreements.length], [0, 0, 0], 'a refused fixture wrote nothing'); }
    rm(...bad);
  } finally { rm(dir); }
});

console.log(`\nagent core repository: ${passed} checks passed`);
