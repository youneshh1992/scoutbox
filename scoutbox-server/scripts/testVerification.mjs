// Verification claims (repositories/verification.mjs, migration 0023): the STRICT tables, a create that must read back
// as written, the named acts and the states that guard them (a claim moves only along CLAIM_TRANSITIONS from the status
// its caller decided on), evidence linking to its claim, the database's uniqueness rules (one open identity claim per
// user, one open dispute per claim), the reference keys, units of work, the boot bootstrap that turns verified
// organisations into claims exactly once, and fixtures. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { readRecords, openLayer } from './dataLayerFixture.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  VERIFICATION_MIGRATION as MIGRATION, VERIFICATION_TABLES as TABLES, VERIFICATION_COLLECTIONS as COLLECTIONS,
  eventDetail,
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
  const store = openStore(dir);
  const db = {}; // a fixture-saved file is not a first installation, so there is nothing to hand in
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

// ------------------------------------------------------------- creates
test('[create] a record the columns cannot hold is refused with the record and field named, and nothing is written: unknown fields and metadata keys, codes outside the vocabulary, a code twice, a wrong-typed value', () => {
  const dir = tempDir('s10a-create'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    refused(() => s.repo.claims.create(claim({ sneaky: 1 })), /VERIFICATION_INPUT_INVALID: ver_claims vclm-1 sneaky: is not stored as written/);
    refused(() => s.repo.claims.create(claim({ metadata: { issueDate: '2026-01-01' } })), /vclm-1 metadata\.issueDate: is not stored as written/);
    refused(() => s.repo.claims.create(claim({ reviewReasons: ['MADE_UP'] })), /vclm-1 reviewReasons\[0\]: CHECK constraint failed/);
    refused(() => s.repo.claims.create(claim({ riskFlags: ['FREE_EMAIL_PROVIDER', 'FREE_EMAIL_PROVIDER'] })), /vclm-1 riskFlags\[1\]: UNIQUE constraint failed/);
    refused(() => s.repo.claims.create(claim({ status: 'approved' })), /vclm-1 row: CHECK constraint failed/);
    refused(() => s.repo.claims.create(claim({ metadata: { requestedStart: '2026-01-01' } })), /vclm-1 row: cannot store TEXT value in INTEGER column/);
    refused(() => s.repo.claims.create(claim({ current: 'yes' })), /vclm-1 row: /, 'a boolean column takes true or false');
    refused(() => s.repo.claims.create(claim({ metadata: { registry: { provider: 'x', result: 'match' } } })), /vclm-1 row: NOT NULL constraint failed: ver_claims\.registry_checked_at|vclm-1 row: CHECK/);
    refused(() => s.repo.claims.create(claim({ metadata: 'free text' })), /vclm-1 metadata: must be an object/);
    refused(() => s.repo.evidence.create(evidence({ meta: { anything: 1 } })), /vevd-1 meta\.anything: is not stored as written/);
    refused(() => s.repo.evidence.create(evidence({ mime: 'image/svg+xml' })), /vevd-1 row: CHECK constraint failed/);
    refused(() => s.repo.evidence.create(evidence({ claimIds: ['vclm-missing'] })), /vevd-1 claimIds\[0\]: FOREIGN KEY constraint failed/, 'evidence for a claim that is not there');
    assert.deepEqual(s.repo.counts(), Object.fromEntries(COLLECTIONS.map((n) => [n, 0])), 'nothing was written');
    const c = s.repo.claims.create(claim({ metadata: { requestedStart: null, declaredName: 'M' } }));
    assert.deepEqual(c.metadata, { declaredName: 'M' }, 'a sparse metadata object keeps only the keys it holds');
  } finally { s.close(); rm(dir); }
});

// ------------------------------------------------------------- writes and reads
test('[acts] a claim moves only along CLAIM_TRANSITIONS from the status its caller decided on; the risk flags only gain codes; every other act is guarded by the state it leaves', () => {
  const dir = tempDir('s10a-writes'); saveFixture(dir);
  const s = serverOpen(dir);
  const C = s.repo.claims;
  try {
    const c = C.create(claim());
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.metadata), 'deep-frozen');
    assert.throws(() => { c.status = 'verified'; }, TypeError);
    refused(() => C.create(claim()), /VERIFICATION_DUPLICATE: ver_claims vclm-1 already exists/, 'duplicate id');
    assert.equal(typeof C.update, 'undefined', 'no whole-record update');
    const ev = s.repo.evidence.create(evidence({ claimIds: ['vclm-1'] }));
    assert.deepEqual(ev.claimIds, ['vclm-1']);
    assert.deepEqual(C.byId('vclm-1').evidenceIds, ['vevd-1'], 'the claim lists the evidence filed for it');
    C.recordWorkEmail('vclm-1', { workEmail: 'm@eastport.example', domainCoveredByOrg: true });
    assert.deepEqual([C.byId('vclm-1').metadata.domainControl, C.byId('vclm-1').metadata.domainCoveredByOrg], ['passed', true]);
    refused(() => C.move('vclm-1', { from: 'collecting_evidence', to: 'verified', set: { updatedAt: NOW } }), /VERIFICATION_STATE_CONFLICT: ver_claims vclm-1 cannot move to verified from collecting_evidence/, 'no jump to verified');
    refused(() => C.move('vclm-1', { from: 'pending', to: 'automated_checks_passed' }), /cannot move to automated_checks_passed from pending/, 'a stale from');
    refused(() => C.move('vclm-1', { from: 'collecting_evidence', to: 'pending', set: { subjectId: 'usr-x' } }), /subjectId is not a field this act sets/, 'identity change');
    refused(() => C.move('vclm-1', { from: 'collecting_evidence', to: 'pending', metadata: { color: 'red' } }), /color is not a field this act sets/, 'unknown metadata key');
    C.move('vclm-1', { from: 'collecting_evidence', to: 'pending', set: { updatedAt: NOW } });
    const next = C.move('vclm-1', { from: 'pending', to: 'requires_human_review', addRiskFlags: ['DUPLICATE_EVIDENCE_HASH'], reviewReasons: ['DISPUTED_CLAIM'], addReviewReasons: ['NO_AUTHORITATIVE_SOURCE'] });
    assert.equal(next.status, 'requires_human_review'); assert.deepEqual(next.riskFlags, ['DUPLICATE_EVIDENCE_HASH']); assert.deepEqual(next.reviewReasons, ['DISPUTED_CLAIM', 'NO_AUTHORITATIVE_SOURCE']);
    assert.deepEqual(C.addRiskFlags('vclm-1', { codes: ['DUPLICATE_EVIDENCE_HASH', 'FREE_EMAIL_PROVIDER'] }).riskFlags, ['DUPLICATE_EVIDENCE_HASH', 'FREE_EMAIL_PROVIDER'], 'a flag already held is not added twice');
    const v = C.move('vclm-1', { from: 'requires_human_review', to: 'verified', set: { verificationMethod: 'scoutbox_manual_review', verifiedAt: NOW, verifiedBy: { kind: 'trust_safety', id: 'admin' }, authorityType: 'trust_safety', authorityId: 'admin' } });
    assert.deepEqual([v.status, v.verifiedBy, v.authorityType], ['verified', { kind: 'trust_safety', id: 'admin' }, 'trust_safety']);
    C.flagForReview('vclm-1', { at: NOW, reason: 'cascade' });
    refused(() => C.flagForReview('vclm-1', { at: NOW, reason: 'again' }), /already flagged/, 'flagged once');
    C.closePeriod('vclm-1', { until: NOW + 5, at: NOW });
    assert.deepEqual([C.byId('vclm-1').current, C.byId('vclm-1').validUntil], [false, NOW + 5], 'the period closes');
    refused(() => C.closePeriod('vclm-1', { until: NOW, at: NOW }), /is not a current verified claim/, 'closed once');
    refused(() => C.move('vclm-missing', { from: 'pending', to: 'rejected' }), /VERIFICATION_NOT_FOUND/);
    assert.deepEqual(s.repo.reads.claims.byPair('vpair-1').map((x) => x.id), ['vclm-1']);
    assert.deepEqual(s.repo.reads.claims.forOrgStaff(ORG.id).map((x) => x.id), ['vclm-1']);
    assert.equal(s.repo.reads.evidence.digestSeen('f'.repeat(64)), false);
    assert.equal(typeof s.repo.reads.claims.create, 'undefined', 'the reads carry no writes');
    assert.equal(typeof s.repo.reads.claims.move, 'undefined');
    s.repo.disputes.create(dispute());
    s.repo.disputes.resolve('vdsp-1', { at: NOW, by: { id: 'admin', name: 'Trust & Safety', attribution: 'shared_admin_key' }, resolution: 'dismiss: fine' });
    refused(() => s.repo.disputes.resolve('vdsp-1', { at: NOW, by: { id: 'admin', name: 'T&S', attribution: 'shared_admin_key' }, resolution: 'again' }), /ver_disputes vdsp-1 is already resolved/, 'resolved once');
    const grant = { id: 'vadm-1', orgId: ORG.id, userId: SCOUT.userId, level: 'verification_admin', status: 'active', invitedBy: 'trust_safety', createdAt: NOW, acceptedAt: NOW, revokedAt: null, revokedBy: null };
    s.repo.admins.create(grant);
    assert.equal(s.repo.admins.revoke('vadm-1', { at: NOW, by: SCOUT.userId }).status, 'revoked');
    refused(() => s.repo.admins.revoke('vadm-1', { at: NOW, by: SCOUT.userId }), /ver_admins vadm-1 is not active/, 'revoked once');
  } finally { s.close(); rm(dir); }
});

test('[references] a reference cites a claim of its own coach at its own organisation, and a new version supersedes a reference of the same player, coach and organisation', () => {
  const dir = tempDir('s10a-refs'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    s.repo.claims.create(claim({ status: 'verified', verificationMethod: 'organisation_admin_confirmation', verifiedAt: NOW }));
    const ref = (over = {}) => ({
      id: 'vref-1', version: 1, supersedesId: null, playerId: 'pl-1', playerName: 'Kola', coachUserId: SCOUT.userId, coachName: SCOUT.name, orgId: ORG.id, orgName: ORG.name, roleAtTime: 'Coach',
      provenanceSnapshot: { claimId: 'vclm-1', claimType: 'CLUB_AFFILIATION', status: 'verified', method: 'organisation_admin_confirmation', verifiedAt: NOW, snapshotAt: NOW },
      relationship: 'coach', capacity: '', fromYear: null, toYear: null, structured: { strengths: '', development: '', summary: 'Reliable.' },
      status: 'active', withdrawnAt: null, withdrawReason: null, createdAt: NOW, ...over,
    });
    refused(() => s.repo.references.create(ref({ orgId: 'org-other' })), /FOREIGN KEY constraint failed/, 'a provenance claim at another organisation');
    s.repo.references.create(ref());
    refused(() => s.repo.references.create(ref({ id: 'vref-2', version: 2, supersedesId: 'vref-1', playerId: 'pl-2' })), /FOREIGN KEY constraint failed/, 'a new version for another player');
    refused(() => s.repo.references.create(ref({ id: 'vref-2', version: 1, supersedesId: 'vref-1' })), /CHECK constraint failed/, 'a superseding reference is not version 1');
    s.repo.references.supersede('vref-1');
    assert.equal(s.repo.references.create(ref({ id: 'vref-2', version: 2, supersedesId: 'vref-1' })).supersedesId, 'vref-1');
    refused(() => s.repo.references.withdraw('vref-1', { at: NOW, reason: 'x' }), /ver_references vref-1 is not active/, 'a superseded reference is not withdrawn');
  } finally { s.close(); rm(dir); }
});

test('[rules] the database keeps the code\'s uniqueness rules: one open identity claim per user, one open dispute per claim, one active grant per person and level', () => {
  const dir = tempDir('s10a-rules'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    s.repo.claims.create(claim({ id: 'vclm-id-1', claimType: 'PERSON_IDENTITY', organisationId: null, metadata: {} }));
    assert.equal(s.repo.reads.claims.hasOpenIdentity(SCOUT.userId), true);
    refused(() => s.repo.claims.create(claim({ id: 'vclm-id-2', claimType: 'PERSON_IDENTITY', organisationId: null, metadata: {} })), /UNIQUE/, 'second open identity claim');
    s.repo.claims.move('vclm-id-1', { from: 'collecting_evidence', to: 'pending' });
    s.repo.claims.move('vclm-id-1', { from: 'pending', to: 'rejected', set: { updatedAt: NOW } });
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
    const used = consumeToken(s.repo.tokens, { purpose: 'work_email', secret, subjectId: SCOUT.userId }).token;
    assert.ok(used.usedAt);
    assert.equal(consumeToken(s.repo.tokens, { purpose: 'work_email', secret }).error, 'TOKEN_ALREADY_USED');
    refused(() => s.repo.tokens.use(used.id, { at: NOW }), /ver_tokens .* is already used/, 'a token is spent once');
    mintToken(s.repo.tokens, nextId, { purpose: 'work_email', email: 'm@eastport.example', subjectKind: 'org_user', subjectId: SCOUT.userId, orgId: ORG.id });
    assert.equal(s.repo.tokens.recordFailedAttempts(SCOUT.userId, 'work_email'), 1, 'a wrong code counts against the open token only');
    assert.equal(s.repo.reads.tokens.failedAttempts(SCOUT.userId, 'work_email'), 1);
  } finally { s.close(); rm(dir); }
  assert.equal(eventDetail({ status: 'pending' }, { status: 'verified', method: 'organisation_admin_confirmation' }), 'status: pending → verified; method: organisation_admin_confirmation');
  assert.equal(eventDetail(null, { rootRequest: 'vroot-1', checks: { emailSyntax: 'passed' } }), 'rootRequest: vroot-1; checks: emailSyntax=passed');
  assert.equal(eventDetail(null, null), null);
});

test('[fixtures] a record written through the repository must read back as written (junk refused naming the field, nothing written), a dangling reference is refused by its key, and the records read back as written', () => {
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
    // A record reads back as written; nulls and empty sparse objects say nothing and come back as absent keys.
    const sparse = (r) => JSON.parse(JSON.stringify(r, (k, v) => (v === null ? undefined : v)));
    assert.deepEqual(sparse(back.verClaims), sparse([claim({ evidenceIds: ['vevd-1'] })]));
    assert.deepEqual(sparse(back.verEvidence), sparse(supplied.verEvidence));
    assert.equal(back.verDisputes.length, 1); assert.deepEqual(back.orgVerifiedDomains.map((d) => d.domain), ['eastport.example']);
  } finally { rm(dir2); }
});

console.log(`${passed} verification checks passed`);
