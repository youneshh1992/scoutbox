// S10a — verification claims as typed tables with explicit writes (repositories/verification.mjs, migration 0023). What
// this suite proves: the migration creates the eighteen STRICT tables (no JSON column) and a fresh database holds no
// row; the organisation facet is retired (the revocation is the verificationRevokedAt column); the typers refuse junk
// with the record and field named (an unknown metadata key, an unknown code, a duplicate code); create/update write
// rows at once and return fresh, deep-frozen records, refuse an identity change, a duplicate id and an update from inside
// its own update; evidence created for a claim links to it at once; the database keeps the code's uniqueness rules (one
// open identity claim per user, one open dispute per claim); a rolled-back unit leaves nothing; there is no db.* view;
// the boot bootstrap turns verified organisations into claims exactly once; the event detail is one line; and the
// snapshot write types, names missing references with ids and reads back what it wrote.
// Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { readRecords, openLayer } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  VERIFICATION_MIGRATION as MIGRATION, VERIFICATION_TABLES as TABLES, VERIFICATION_COLLECTIONS as COLLECTIONS,
  typeClaim, typeEvidence, eventDetail,
} from '../repositories/verification.mjs';
import { bootstrapVerification, mintToken, consumeToken, peekToken } from '../domains/verification/claims/shared.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) { if (only && !name.includes(only)) return; fn(); passed++; console.log(`  ✓ ${name}`); }
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
const plain = (v) => JSON.parse(JSON.stringify(v));
let counter = 9000; const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `${label}: expected a refusal`); assert.match(String(err.message), pattern, `${label}: ${err.message}`);
  return err;
};

// ------------------------------------------------------------- fixtures: the literals the routes write
/** createClaim (domains/verification/claims/index.mjs) for POST /org/verification/affiliation. */
const claim = (over = {}) => ({
  id: 'vclm-1', subjectType: 'user', subjectId: SCOUT.userId, claimType: 'CLUB_AFFILIATION', organisationId: ORG.id, role: null,
  status: 'collecting_evidence', validFrom: null, validUntil: null, current: true, verificationMethod: null, authorityType: null, authorityId: null,
  evidenceIds: [], createdAt: NOW - 5000, updatedAt: NOW - 5000, verifiedAt: null, verifiedBy: null, revokedAt: null, revokedBy: null,
  revocationReason: null, suspendedAt: null, disputedAt: null, reviewReasons: [], riskFlags: [],
  metadata: { pairId: 'vpair-1', declaredName: SCOUT.name, requestedStart: null }, ...over,
});
/** addEvidence for the work-email proof. */
const evidence = (over = {}) => ({
  id: 'vevd-1', type: 'official_email', source: 'email_challenge', suppliedByKind: 'org_user', suppliedById: SCOUT.userId, orgId: ORG.id,
  receivedAt: NOW - 4000, claimIds: [], mediaId: null, sha256: null, mime: null, bytes: null, filename: null,
  meta: { domain: 'eastport.example', domainCoveredByOrg: true, addressHash: 'a'.repeat(64) }, checks: { malwareScan: 'not_configured' },
  retention: 'until_claim_resolution', visibility: 'organisation_internal', expiresAt: null, ...over,
});
const dispute = (over = {}) => ({ id: 'vdsp-1', claimId: 'vclm-1', byKind: 'org_user', byId: SCOUT.userId, byName: SCOUT.name, reason: 'Wrong dates', status: 'open', resolution: null, createdAt: NOW - 100, resolvedAt: null, resolvedBy: null, resolvedById: null, resolutionAttribution: null, ...over });

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = {}; // S14a: a fixture-saved file is not a first installation, so there is nothing to hand in
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.verification, layer, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0023 is registered after 0022 and creates the eighteen STRICT tables (no JSON column), empty on a fresh database; the facet column is gone', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0022_opportunities_campaigns') + 1);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s10a-empty'); const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  assert.ok(!s.prepare('PRAGMA table_info(orgs)').all().some((c) => c.name === 'verification_org_type'));
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named — unknown fields and metadata keys, codes outside the vocabulary, a code twice, a wrong-typed value', () => {
  assert.equal(typeClaim(claim()).ok, true);
  assert.match(typeClaim(claim({ sneaky: 1 })).reason, /vclm-1 carries field\(s\) this build does not store: sneaky/);
  assert.match(typeClaim(claim({ metadata: { issueDate: '2026-01-01' } })).reason, /metadata carries field\(s\)[^:]*: issueDate/);
  assert.match(typeClaim(claim({ reviewReasons: ['MADE_UP'] })).reason, /reviewReasons holds/);
  assert.match(typeClaim(claim({ riskFlags: ['FREE_EMAIL_PROVIDER', 'FREE_EMAIL_PROVIDER'] })).reason, /names a code twice/);
  assert.match(typeClaim(claim({ status: 'approved' })).reason, /status must be one of/);
  assert.match(typeClaim(claim({ metadata: { requestedStart: '2026-01-01' } })).reason, /requestedStart must be an integer/);
  assert.match(typeClaim(claim({ metadata: { registry: { provider: 'x', result: 'match' } } })).reason, /registry\.checkedAt is required/);
  const t = typeClaim(claim({ metadata: { requestedStart: null, declaredName: 'M' } }));
  assert.deepEqual(t.record.metadata, { declaredName: 'M' }, 'a sparse metadata object keeps only the keys it holds');
  assert.match(typeEvidence(evidence({ meta: { anything: 1 } })).reason, /meta carries field/);
  assert.match(typeEvidence(evidence({ mime: 'image/svg+xml' })).reason, /mime must be one of/);
});

// ------------------------------------------------------------- writes and reads
test('[writes] create/update write the whole record and return a fresh frozen copy; identity changes, duplicates and nested updates are refused; evidence for a claim links at once', () => {
  const dir = tempDir('s10a-writes'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    const c = s.repo.claims.create(claim());
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.metadata), 'deep-frozen');
    assert.throws(() => { c.status = 'verified'; }, TypeError);
    refused(() => s.repo.claims.create(claim()), /already exists/, 'duplicate id');
    refused(() => s.repo.claims.update('vclm-1', (d) => { d.subjectId = 'usr-x'; }), /subjectId cannot change/, 'identity change');
    refused(() => s.repo.claims.update('vclm-1', () => { s.repo.claims.update('vclm-1', () => {}); }), /already being updated/, 'nested update');
    refused(() => s.repo.claims.update('vclm-1', (d) => { d.metadata.color = 'red'; }), /metadata carries field/, 'unknown metadata key');
    const ev = s.repo.evidence.create(evidence({ claimIds: ['vclm-1'] }));
    assert.deepEqual(ev.claimIds, ['vclm-1']);
    assert.deepEqual(s.repo.claims.byId('vclm-1').evidenceIds, ['vevd-1'], 'the claim lists the evidence filed for it');
    const next = s.repo.claims.update('vclm-1', (d) => { d.riskFlags.push('DUPLICATE_EVIDENCE_HASH'); d.metadata.workEmail = 'm@eastport.example'; d.metadata.domainControl = 'passed'; d.status = 'pending'; });
    assert.equal(next.status, 'pending'); assert.deepEqual(next.riskFlags, ['DUPLICATE_EVIDENCE_HASH']); assert.equal(next.metadata.workEmail, 'm@eastport.example');
    assert.deepEqual(s.repo.reads.claims.byPair('vpair-1').map((x) => x.id), ['vclm-1']);
    assert.deepEqual(s.repo.reads.claims.forOrgStaff(ORG.id).map((x) => x.id), ['vclm-1']);
    assert.equal(s.repo.reads.evidence.digestSeen('f'.repeat(64)), false);
    assert.equal(typeof s.repo.reads.claims.create, 'undefined', 'the reads carry no writes');
  } finally { s.close(); rm(dir); }
});

test('[rules] the database keeps the code\'s uniqueness rules: one open identity claim per user, one open dispute per claim, one active grant per person and level', () => {
  const dir = tempDir('s10a-rules'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    s.repo.claims.create(claim({ id: 'vclm-id-1', claimType: 'PERSON_IDENTITY', organisationId: null, metadata: {} }));
    assert.equal(s.repo.reads.claims.hasOpenIdentity(SCOUT.userId), true);
    refused(() => s.repo.claims.create(claim({ id: 'vclm-id-2', claimType: 'PERSON_IDENTITY', organisationId: null, metadata: {} })), /UNIQUE/, 'second open identity claim');
    s.repo.claims.update('vclm-id-1', (d) => { d.status = 'rejected'; });
    s.repo.claims.create(claim({ id: 'vclm-id-2', claimType: 'PERSON_IDENTITY', organisationId: null, metadata: {} }));
    s.repo.claims.create(claim());
    s.repo.disputes.create(dispute());
    refused(() => s.repo.disputes.create(dispute({ id: 'vdsp-2' })), /UNIQUE/, 'second open dispute');
    const grant = { id: 'vadm-1', orgId: ORG.id, userId: SCOUT.userId, level: 'verification_admin', status: 'active', invitedBy: 'trust_safety', createdAt: NOW, acceptedAt: NOW, revokedAt: null, revokedBy: null };
    s.repo.admins.create(grant);
    refused(() => s.repo.admins.create({ ...grant, id: 'vadm-2' }), /UNIQUE/, 'second active grant');
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves no claim, evidence or event; db.ver* names throw naming the repository; an organisation has no verification field', () => {
  const dir = tempDir('s10a-unit'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    assert.throws(() => s.unit(() => {
      s.repo.claims.create(claim());
      s.repo.evidence.create(evidence({ claimIds: ['vclm-1'] }));
      s.repo.events.append({ id: 'vevt-1', ts: NOW, type: 'claim.created', actorKind: 'system', claimId: 'vclm-1' });
      throw new Error('boom');
    }), /boom/);
    assert.equal(s.repo.reads.claims.byId('vclm-1'), null);
    assert.deepEqual(s.repo.counts(), Object.fromEntries(COLLECTIONS.map((n) => [n, 0])));
    assert.ok(!('verification' in s.layer.orgs.byId(ORG.id)), 'an organisation has no verification field');
    assert.throws(() => s.layer.orgs.update(ORG.id, (d) => { d.verification = {}; }), /verification is no longer an organisation field: write it through the verification repository/);
  } finally { s.close(); rm(dir); }
});

test('[bootstrap] organisations already verified become migration claims (and their verified domain a row) exactly once per database', () => {
  const dir = tempDir('s10a-boot');
  saveFixture(dir, { orgs: [{ ...ORG, plan: 'Pro', verified: true, emailDomain: 'eastport.example', emailDomainVerified: true }, { id: 'org-new', name: 'New FC', type: 'club', plan: 'Pro', verified: false }] });
  const s = serverOpen(dir);
  try {
    const created = bootstrapVerification({ verification: s.repo, orgs: s.layer.orgs.list(), now: NOW });
    assert.equal(created, 2, 'an identity and a domain claim for the verified organisation only');
    const claims = s.repo.reads.claims.forSubject('org', ORG.id);
    assert.deepEqual(claims.map((c) => [c.claimType, c.status, c.verificationMethod]), [['ORGANISATION_IDENTITY', 'verified', 'migration'], ['ORGANISATION_DOMAIN', 'verified', 'migration']]);
    assert.deepEqual(s.repo.reads.domains.forOrg(ORG.id).map((d) => d.domain), ['eastport.example']);
    assert.equal(s.repo.reads.events.forClaim(claims[0].id).length, 1, 'each claim logs its creation');
    assert.equal(bootstrapVerification({ verification: s.repo, orgs: s.layer.orgs.list(), now: NOW }), 0, 'never twice');
    assert.equal(s.repo.reads.claims.forSubject('org', ORG.id).length, 2);
  } finally { s.close(); rm(dir); }
});

test('[tokens and events] tokens are hashed rows consumed once through the repository; an event\'s before/after becomes one detail line', () => {
  const dir = tempDir('s10a-tokens'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    const secret = mintToken(s.repo.tokens, nextId, { purpose: 'work_email', email: 'M@Eastport.example', subjectKind: 'org_user', subjectId: SCOUT.userId, orgId: ORG.id });
    const row = s.store.sqlite.prepare('SELECT * FROM ver_tokens').get();
    assert.ok(row.token_hash.length === 64 && !row.token_hash.includes(secret) && row.email === 'm@eastport.example');
    assert.equal(peekToken(s.repo.tokens, { purpose: 'work_email', secret }).token.usedAt, null, 'peek does not consume');
    assert.ok(consumeToken(s.repo.tokens, { purpose: 'work_email', secret, subjectId: SCOUT.userId }).token.usedAt);
    assert.equal(consumeToken(s.repo.tokens, { purpose: 'work_email', secret }).error, 'TOKEN_ALREADY_USED');
  } finally { s.close(); rm(dir); }
  assert.equal(eventDetail({ status: 'pending' }, { status: 'verified', method: 'organisation_admin_confirmation' }), 'status: pending → verified; method: organisation_admin_confirmation');
  assert.equal(eventDetail(null, { rootRequest: 'vroot-1', checks: { emailSyntax: 'passed' } }), 'rootRequest: vroot-1; checks: emailSyntax=passed');
  assert.equal(eventDetail(null, null), null);
});

test('[fixtures] a record written through the repository is typed (junk refused naming the field, nothing written), a dangling reference is refused by its key, and the records read back as written', () => {
  const dir = tempDir('s10a-fix');
  refused(() => saveFixture(dir, { verClaims: [claim()], verDisputes: [dispute({ claimId: 'vclm-missing' })] }), /FOREIGN KEY constraint failed/, 'missing claim');
  refused(() => saveFixture(tempDir('s10a-fix-junk'), { verClaims: [claim({ metadata: { issueDate: '2026' } })] }), /VERIFICATION_INPUT_INVALID[\s\S]*issueDate/, 'junk metadata');
  rm(dir);
  const dir2 = tempDir('s10a-fix2');
  // The evidence links itself to its claims as it is created (as the vault route does), so the claim is written without them.
  const supplied = { verClaims: [claim()], verEvidence: [evidence({ claimIds: ['vclm-1'] })], verDisputes: [dispute()], orgVerifiedDomains: [{ orgId: ORG.id, domain: 'eastport.example', status: 'verified', method: 'official_domain_email', verifiedAt: NOW, addedBy: 'migration' }] };
  saveFixture(dir2, supplied);
  try {
    const back = readRecords(dir2);
    assert.deepEqual(plain(back.verClaims), plain([typeClaim(claim({ evidenceIds: ['vevd-1'] })).record]));
    assert.deepEqual(plain(back.verEvidence), plain([typeEvidence(supplied.verEvidence[0]).record]));
    assert.equal(back.verDisputes.length, 1); assert.deepEqual(back.orgVerifiedDomains.map((d) => d.domain), ['eastport.example']);
  } finally { rm(dir2); }
});

console.log(`${passed} verification checks passed`);
