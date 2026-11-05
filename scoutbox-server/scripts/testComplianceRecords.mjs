// S11b-2 — compliance contexts and their evaluations, regulatory reviews and consents as typed tables with explicit
// writes (repositories/complianceRecords.mjs, migration 0028). What this suite proves: the migration creates the
// twenty-six STRICT tables (no JSON column), empty; the typers refuse junk with the record and field named (an unknown
// field, a status or role the tables do not know, a facet subject carrying the old "referenceHash", an Other Services
// list, a decision that does not follow its status); an evaluation is appended with its history entry, read back whole
// (reasons with their extras and lists, outstanding consents, the identity of the inputs; alias, required actions and
// rule statuses worked out) and an entry that claims to repeat it must; a context keeps what never changes and does not
// reopen; a review's snapshot names an evaluation of its context, its decision is final and its supersession written
// once; a consent is answered once and revoked once, on its own row; the queue pages open items first; an account
// deletion keeps ids only; a rolled-back unit leaves nothing; the db.* names throw; and the snapshot write types every
// record, keeps the omitted collections, refuses a review naming a context that is not there and reads back what it
// wrote. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  COMPLIANCE_RECORDS_MIGRATION as MIGRATION, COMPLIANCE_RECORDS_TABLES as TABLES, COMPLIANCE_RECORDS_COLLECTIONS as COLLECTIONS,
  typeContext, typeReview, typeConsent,
} from '../repositories/complianceRecords.mjs';
import { PERMITTED_WITH_CONSENT } from '../domains/agents/compliance/conflict.mjs';

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

// ------------------------------------------------------------- fixtures: the literals the routes write
const UID = SCOUT.userId;
const BY = { kind: 'org', userId: UID, name: SCOUT.name };
const REVIEWER = { kind: 'ts_reviewer', userId: 'tsr-a', name: 'Priya', role: 'trust_safety_admin' };
const PV = 'jp-eng-2026-27-1';
const entry = (id, action, detail = null, by = BY) => ({ id, at: NOW, action, by, detail });
/** POST /org/agent/compliance/contexts. */
const context = (over = {}) => ({
  id: 'ctx-1', agencyOrgId: ORG.id, agentUserId: UID, type: 'employment_contract', jurisdictions: ['ENG'],
  parties: [{ id: 'cpt-1', partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-1', addedAt: NOW, removed: false, removedAt: null }, { id: 'cpt-2', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id, addedAt: NOW, removed: false, removedAt: null }],
  representations: [], resolvedFacts: [], reEvaluationPending: false, reviewRejectedAt: null, status: 'open', openedAt: NOW, closedAt: null,
  keys: { create: { key: 'k-ctx', fp: '{}' } }, rev: 1, revAt: NOW, revBy: null,
  history: [entry('aud-c1', 'compliance_context_opened', { type: 'employment_contract', policyVersions: ['jp-fifa-2025-1', PV] })], ...over,
});
/** evaluateConflict's result (conflict.mjs). */
const result = (over = {}) => ({
  outcome: PERMITTED_WITH_CONSENT, alias: 'PERMITTED_WITH_CONSENT',
  reasons: [
    { code: 'CONSENT_REQUIRED', ruleId: 'ENG-6.3', ruleStatus: 'ACTIVE', regulator: 'FA', jurisdiction: 'ENG', policyVersion: PV, agentUserId: UID, partyRoles: ['individual', 'engaging_entity'] },
    { code: 'NATIONAL_RULE_APPLIES', ruleId: 'FIFA-12.8', ruleStatus: 'JURISDICTION_OVERRIDE', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 'jp-fifa-2025-1', overrideRuleId: 'ENG-6.3' },
  ],
  consentsOutstanding: [{ partyRole: 'individual', agentUserId: UID, consentKind: 'dual_representation', reasonCode: 'CONSENT_MISSING' }],
  requiredActions: [], missingEvidence: [], policyVersions: ['jp-fifa-2025-1', PV], evaluatedAt: NOW, inputHash: 'a'.repeat(64), ...over,
});
const inputs = { parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-1' }], representations: [], proposed: { partyRole: 'engaging_entity', agentUserId: UID } };
const evaluated = (id, r = result()) => entry(id, 'compliance_context_evaluated', { outcome: r.outcome, reasonCodes: [...new Set(r.reasons.map((x) => x.code))], policyVersions: r.policyVersions });
/** createReview (domains/agents/compliance/index.mjs). */
const review = (over = {}) => {
  const r = {
    id: 'rrv-1', kind: 'conflict_evaluation', status: 'PENDING', agencyOrgId: ORG.id, agentUserId: UID,
    subject: { contextId: 'ctx-1', representationId: null, partyRole: 'engaging_entity' },
    reasons: [{ code: 'RULE_STATUS_UNCERTAIN', ruleId: 'FIFA-12.8', ruleStatus: 'UNDER_LEGAL_REVIEW', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 'jp-fifa-2025-1', agentUserId: UID, partyRoles: ['individual'] }],
    policyVersions: ['jp-fifa-2025-1'], snapshot: null, requestedAt: NOW, requestedBy: BY, startedAt: null, startedBy: null, decidedAt: null, decision: null,
    supersedes: null, supersededBy: null, keys: {}, rev: 1, revAt: NOW, revBy: null, ...over,
  };
  r.history ??= [entry(`aud-${r.id}`, 'regulatory_review_requested', { kind: r.kind, reasonCodes: [...new Set(r.reasons.map((x) => x.code))], policyVersions: r.policyVersions })];
  return r;
};
/** requestDualRepresentationConsent. */
const consent = (over = {}) => {
  const k = {
    id: 'rcs-1', kind: 'dual_representation', contextId: 'ctx-1', agentUserId: UID, agencyOrgId: ORG.id, partyRole: 'individual',
    subject: { kind: 'player', id: 'pl-1' }, regarding: ['engaging_entity'], status: 'requested', requestedAt: NOW, requestedBy: BY,
    grantedAt: null, grantedBy: null, declinedAt: null, declinedBy: null,
    particulars: { fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: false, acknowledged: null },
    policyVersions: [PV], ruleIds: ['ENG-6.3'], keys: { request: { key: 'k-cs', fp: '{}' } }, rev: 1, revAt: NOW, revBy: null, ...over,
  };
  k.history ??= [entry(`aud-${k.id}`, 'regulatory_consent_requested', { partyRole: k.partyRole, kind: k.kind, policyVersions: k.policyVersions })];
  return k;
};
const PLAYER = { kind: 'player', userId: 'pl-1', name: 'Kola' };

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  layer.compliancePolicies.reviewers.create({ id: 'tsr-a', name: 'Priya', role: 'trust_safety_admin', status: 'active', secretHash: 'h', createdAt: NOW, createdBy: { kind: 'system', userId: null, name: 'test' }, revokedAt: null, revokedBy: null, rev: 1, revAt: NOW, revBy: null, history: [] });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  return { store, db, repo: layer.complianceRecords, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0028 is registered after 0027 and creates the twenty-six STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0027_compliance_policies') + 1);
  assert.equal(TABLES.length, 26);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11b2-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeContext(context()).ok, undefined, 'a typed context is the record itself');
  assert.match(typeContext(context({ otherServices: [] })).reason, /ctx-1 carries field\(s\) this build does not store: otherServices/, 'the dead Other Services list is gone');
  assert.match(typeContext(context({ status: 'archived' })).reason, /ctx-1\.status must be one of open\|closed/);
  assert.match(typeContext(context({ jurisdictions: ['eng'] })).reason, /jurisdictions/);
  assert.match(typeContext(context({ parties: [...context().parties, { ...context().parties[0], id: 'cpt-3' }] })).reason, /names a party role twice/);
  assert.match(typeContext(context({ representations: [{ id: 'crp-1', agentUserId: UID, partyRole: 'individual', agreementId: null, status: 'declared', declaredOnly: false, keys: {} }] })).reason, /status must be one of verified\|pending_review\|withdrawn/);
  assert.match(typeContext(context({ history: [entry('aud-x', 'compliance_context_party_added', { partyRole: 'individual', kind: 'agent' })] })).reason, /detail\.kind/);
  assert.equal(typeReview(review()).ok, undefined);
  assert.match(typeReview(review({ kind: 'verification_facet', subject: { profileId: 'agp-1', userId: UID, facet: 'fifa_licence', memberAssociation: null, referenceHash: '9' } })).reason, /does not store: referenceHash/, 'the facet subject no longer carries the reference length');
  assert.match(typeReview(review({ status: 'APPROVED' })).reason, /history|decision|status/);
  assert.match(typeReview(review({ history: [entry('aud-y', 'regulatory_review_requested', { kind: 'conflict_evaluation', reasonCodes: ['OTHER'], policyVersions: ['jp-fifa-2025-1'] })] })).reason, /repeats the review's kind, reason codes and versions/);
  assert.match(typeReview(review({ reasons: [{ code: 'X', ruleId: null, ruleStatus: 'MAYBE', policyVersion: null }] })).reason, /ruleStatus must be one of/);
  assert.equal(typeConsent(consent()).ok, undefined);
  assert.match(typeConsent(consent({ kind: 'revocation' })).reason, /kind must be one of/, 'a revocation is not a consent row');
  assert.match(typeConsent(consent({ status: 'revoked' })).reason, /status must be one of requested\|granted\|declined/, 'revoked is derived, never stored');
  assert.match(typeConsent(consent({ status: 'granted', grantedAt: NOW, grantedBy: PLAYER })).reason, /acknowledged is recorded exactly when granted/);
});

// ------------------------------------------------------------- writes and reads
test('[contexts] a context is created whole; an evaluation is appended with its entry and read back whole; what never changes does not; a closed context does not reopen', () => {
  const dir = tempDir('s11b2-contexts'); saveFixture(dir);
  const s = serverOpen(dir);
  const C = s.repo.contexts;
  try {
    const c = C.create(context());
    assert.ok(Object.isFrozen(c) && Object.isFrozen(c.parties[0]), 'deep-frozen');
    assert.equal(c.lastEvaluation, null); assert.equal(c.evaluationCount, 0);
    refused(() => C.create(context()), /already exists/, 'duplicate');
    refused(() => C.create(context({ id: 'ctx-2', keys: {}, history: [evaluated('aud-e0')] })), /recorded with recordEvaluation/, 'an evaluation entry on creation');
    const r = result();
    refused(() => C.recordEvaluation('ctx-1', r, inputs, entry('aud-e1', 'compliance_context_evaluated', { outcome: 'CLEAR', reasonCodes: [], policyVersions: r.policyVersions })), /repeats the latest evaluation/, 'an entry that does not repeat its evaluation');
    const ev = C.recordEvaluation('ctx-1', r, inputs, evaluated('aud-e1', r));
    assert.equal(ev.evaluationId, 'ctx-1#1');
    assert.deepEqual(ev.reasons, r.reasons, 'reasons read back with their extras and lists');
    assert.deepEqual(ev.consentsOutstanding, r.consentsOutstanding);
    assert.deepEqual(ev.snapshotOf, inputs);
    assert.equal(ev.alias, 'PERMITTED_WITH_CONSENT'); assert.deepEqual(ev.ruleStatuses, { 'ENG-6.3': 'ACTIVE', 'FIFA-12.8': 'JURISDICTION_OVERRIDE' });
    assert.deepEqual(ev.requiredActions, [{ action: 'obtain_consent', partyRole: 'individual', consentKind: 'dual_representation', reasonCode: 'CONSENT_MISSING' }], 'worked out on read');
    const after = C.byId('ctx-1');
    assert.equal(after.evaluationCount, 1); assert.equal(after.lastEvaluation.evaluationId, 'ctx-1#1');
    assert.deepEqual(after.history.at(-1).detail, { outcome: r.outcome, reasonCodes: ['CONSENT_REQUIRED', 'NATIONAL_RULE_APPLIES'], policyVersions: r.policyVersions }, 'the entry is worked out from its evaluation');
    const v = C.update('ctx-1', (d) => {
      d.representations.push({ id: 'crp-1', agentUserId: UID, partyRole: 'individual', agreementId: null, status: 'verified', declaredOnly: false, reviewId: null, declaredAt: NOW, firstActAt: NOW, withdrawnAt: null, verifiedByReviewId: null, verifiedAt: null, keys: { declare: { key: 'k-d', fp: '{}' } } });
      d.history.push(entry('aud-d1', 'compliance_representation_declared', { partyRole: 'individual', status: 'verified', outcome: r.outcome, policyVersions: r.policyVersions }));
    });
    assert.equal(v.representations[0].keys.declare.key, 'k-d');
    refused(() => C.update('ctx-1', (d) => { d.jurisdictions = ['USA']; }), /jurisdictions cannot change/);
    refused(() => C.update('ctx-1', (d) => { d.history.pop(); }), /history only grows/);
    C.update('ctx-1', (d) => { d.status = 'closed'; d.closedAt = NOW; d.history.push(entry('aud-cl', 'compliance_context_closed')); });
    refused(() => C.update('ctx-1', (d) => { d.status = 'open'; d.closedAt = null; }), /does not reopen/);
    assert.deepEqual(C.forAgent(ORG.id, UID).map((x) => x.id), ['ctx-1']); assert.equal(C.byCreateKey(ORG.id, UID, 'k-ctx').id, 'ctx-1');
    assert.deepEqual(C.outcomeCounts(), { [PERMITTED_WITH_CONSENT]: 1 });
  } finally { s.close(); rm(dir); }
});

test('[policy publication] open contexts of the jurisdiction whose latest evaluation predates the version are flagged, each with its entry', () => {
  const dir = tempDir('s11b2-flag'); saveFixture(dir);
  const s = serverOpen(dir);
  const C = s.repo.contexts;
  try {
    C.create(context()); C.recordEvaluation('ctx-1', result(), inputs, evaluated('aud-e1'));
    C.create(context({ id: 'ctx-2', keys: {}, history: [] })); C.recordEvaluation('ctx-2', result({ policyVersions: ['jp-fifa-2025-1'] }), inputs, evaluated('aud-e2', result({ policyVersions: ['jp-fifa-2025-1'] })));
    const flagged = C.flagPolicyChange('ENG', PV, () => entry(nextId('aud'), 'compliance_context_policy_changed', { policyVersions: [PV] }, { kind: 'system', userId: null, name: 'policy publication' }));
    assert.deepEqual(flagged, ['ctx-2'], 'only the context evaluated without the version');
    assert.equal(C.byId('ctx-2').reEvaluationPending, true); assert.equal(C.byId('ctx-1').reEvaluationPending, false);
    C.recordEvaluation('ctx-2', result(), inputs, evaluated('aud-e3'));
    assert.equal(C.byId('ctx-2').reEvaluationPending, false, 'an evaluation clears the flag');
  } finally { s.close(); rm(dir); }
});

test('[reviews] a review is created and read back; its snapshot names an evaluation of its context; the decision is final; the supersession is written once; the queue pages open items first', () => {
  const dir = tempDir('s11b2-reviews'); saveFixture(dir);
  const s = serverOpen(dir);
  const { contexts: C, reviews: R } = s.repo;
  try {
    C.create(context()); C.recordEvaluation('ctx-1', result(), inputs, evaluated('aud-e1'));
    refused(() => R.create(review({ snapshot: { outcome: 'CLEAR', evaluationId: 'ctx-1#1' } })), /names an evaluation of its context with the same outcome/);
    const r = R.create(review({ snapshot: { ...result(), evaluationId: 'ctx-1#1', proposed: inputs.proposed } }));
    assert.equal(r.snapshot.evaluationId, 'ctx-1#1'); assert.deepEqual(r.snapshot.proposed, inputs.proposed, 'the snapshot is read from the evaluation row');
    assert.deepEqual(r.subject, { contextId: 'ctx-1', representationId: null, partyRole: 'engaging_entity' });
    const prior = { status: 'PENDING', contextOutcome: PERMITTED_WITH_CONSENT, representationStatus: null };
    const decided = R.update('rrv-1', (d) => {
      d.status = 'REJECTED'; d.decidedAt = NOW;
      d.decision = { reviewerId: 'tsr-a', reviewerName: 'Priya', reviewerRole: 'trust_safety_admin', outcome: 'REJECTED', reasonCode: 'no', reason: 'Not settled.', evidenceRefs: [], policyVersions: d.policyVersions, at: NOW, priorState: prior, resultingState: { contextOutcome: PERMITTED_WITH_CONSENT, representationStatus: null } };
      d.history.push(entry('aud-rs', 'regulatory_review_resolved', { outcome: 'REJECTED', reasonCode: 'no', evidenceRefs: [], evidenceCount: 0, policyVersions: d.policyVersions, priorState: prior, resultingState: { contextOutcome: PERMITTED_WITH_CONSENT, representationStatus: null }, rev: 1 }, REVIEWER));
      d.rev = 2;
    });
    assert.equal(decided.decision.reviewerId, 'tsr-a'); assert.equal(decided.history.at(-1).detail.evidenceCount, 0);
    refused(() => R.update('rrv-1', (d) => { d.decision.reason = 'rewritten'; }), /a decision is final/);
    refused(() => R.update('rrv-1', (d) => { d.status = 'PENDING'; d.decision = null; d.decidedAt = null; }), /decision is final|only becomes SUPERSEDED|repeats the decision/);
    R.create(review({ id: 'rrv-2', snapshot: null }));
    R.update('rrv-2', (d) => { d.supersedes = 'rrv-1'; d.history.push(entry('aud-sp', 'regulatory_review_requested', { reasonCode: 'supersedes', reviewId: 'rrv-1' }, REVIEWER)); });
    R.update('rrv-1', (d) => { d.status = 'SUPERSEDED'; d.supersededBy = 'rrv-2'; d.history.push(entry('aud-ss', 'regulatory_review_superseded', { reasonCode: 'superseded', reviewId: 'rrv-2', priorState: { status: 'REJECTED' }, rev: 2 }, REVIEWER)); });
    refused(() => R.update('rrv-2', (d) => { d.supersedes = 'rrv-x'; }), /supersedes is written once/);
    assert.equal(R.byId('rrv-1').decision.outcome, 'REJECTED', 'a superseded review keeps its decision');
    R.create(review({ id: 'rrv-3', kind: 'conflict_evaluation', subject: { approach: true, playerId: 'pl-9', jurisdiction: 'ENG' }, snapshot: { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', evaluatedAt: NOW } }));
    assert.deepEqual(R.byId('rrv-3').snapshot, { outcome: 'MANUAL_REGULATORY_REVIEW_REQUIRED', reasons: R.byId('rrv-3').reasons, policyVersions: ['jp-fifa-2025-1'], evaluatedAt: NOW }, 'an Approach item keeps its outcome and instant');
    const p1 = R.queuePage({ limit: 1 });
    assert.deepEqual(p1.rows.map((x) => x.record.id), ['rrv-2', 'rrv-3'], 'open items first, oldest first (one more than the page)');
    const p2 = R.queuePage({ limit: 5, after: p1.rows[0].key });
    assert.deepEqual(p2.rows.map((x) => x.record.id), ['rrv-3', 'rrv-1'], 'then the decided ones');
    assert.deepEqual(R.queuePage({ status: 'SUPERSEDED', limit: 5 }).rows.map((x) => x.record.id), ['rrv-1']);
    assert.deepEqual(R.metrics().byStatus.PENDING, 2);
    assert.deepEqual(R.decisionEntries(10).map((x) => x.entry.id), ['aud-ss', 'aud-rs'].filter((id) => ['aud-ss', 'aud-rs'].includes(id)).sort((a, b) => (a < b ? 1 : -1)));
  } finally { s.close(); rm(dir); }
});

test('[consents] a consent is requested, answered once and revoked once on its own row; the answered row is never edited; an account deletion keeps ids only', () => {
  const dir = tempDir('s11b2-consents'); saveFixture(dir);
  const s = serverOpen(dir);
  const { contexts: C, consents: K } = s.repo;
  try {
    C.create(context());
    const k = K.create(consent());
    assert.equal(k.revocation, null); assert.equal(K.byRequestKey('ctx-1', UID, 'k-cs').id, 'rcs-1');
    refused(() => K.revoke('rcs-1', { id: 'rcs-r', at: NOW, by: PLAYER }), /only a granted consent can be revoked/);
    const g = K.update('rcs-1', (d) => {
      d.status = 'granted'; d.grantedAt = NOW; d.grantedBy = PLAYER; d.particulars.acknowledged = { particulars: true, legalAdvice: true, at: NOW };
      d.keys.grant = { key: 'k-g', fp: '{}' }; d.history.push(entry('aud-g', 'regulatory_consent_granted', { partyRole: 'individual', policyVersions: [PV] }, PLAYER));
    });
    assert.equal(g.status, 'granted');
    refused(() => K.update('rcs-1', (d) => { d.particulars.proposedFeeDisclosed = true; }), /particulars offered cannot change/);
    refused(() => K.update('rcs-1', (d) => { d.status = 'declined'; d.declinedAt = NOW; d.declinedBy = PLAYER; d.grantedAt = null; d.grantedBy = null; d.particulars.acknowledged = null; }), /never edited/);
    const rv = K.revoke('rcs-1', { id: 'rcs-r', at: NOW + 1, by: PLAYER });
    assert.equal(rv.status, 'granted', 'the stored status stays granted'); assert.equal(rv.revocation.at, NOW + 1, 'revoked is the revocation row');
    refused(() => K.revoke('rcs-1', { id: 'rcs-r2', at: NOW, by: PLAYER }), /already revoked/);
    assert.deepEqual(K.metrics(), { requested: 1, granted: 0, declined: 0, revoked: 1 });
    s.repo.forgetPlayer('pl-1', NOW + 2, () => entry(nextId('aud'), 'compliance_context_party_removed', { partyRole: 'individual' }, { kind: 'system', userId: null, name: 'account deletion' }));
    const ctx = C.byId('ctx-1'); const after = K.byId('rcs-1');
    assert.deepEqual([ctx.parties[0].subjectId, ctx.parties[0].removed, ctx.parties[0].removedAt], ['pl-1', true, NOW + 2], 'the party stays as an id');
    assert.deepEqual(after.grantedBy, { kind: 'player', userId: null, name: null }); assert.deepEqual(after.revocation.by, { kind: 'player', userId: null, name: null });
    assert.ok(after.history.filter((h) => h.by.kind === 'player').every((h) => h.by.userId === null && h.by.name === null));
    assert.equal(after.subject.id, 'pl-1', 'the consent keeps the subject id');
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves nothing; the db.* names throw', () => {
  const dir = tempDir('s11b2-units'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    refused(() => s.unit(() => { s.repo.contexts.create(context()); s.repo.contexts.recordEvaluation('ctx-1', result(), inputs, evaluated('aud-e1')); s.repo.reviews.create(review()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.contexts.byId('ctx-1'), null); assert.equal(s.repo.reviews.byId('rrv-1'), null);
    for (const n of COLLECTIONS) assert.throws(() => s.db[n], /read it through the complianceRecords repository/);
  } finally { s.close(); rm(dir); }
});

test('[snapshot] the snapshot write types every record, keeps the omitted collections, refuses junk and a review naming a missing context, and reads back what it wrote', () => {
  const dir = tempDir('s11b2-snapshot'); saveFixture(dir);
  const store = openStore(dir);
  try {
    const ctx = { ...context(), history: [...context().history, evaluated('aud-e1')], evaluations: [{ ...result(), snapshotOf: inputs }] };
    const granted = consent({ status: 'granted', grantedAt: NOW, grantedBy: PLAYER, particulars: { ...consent().particulars, acknowledged: { particulars: true, legalAdvice: true, at: NOW } } });
    granted.history.push(entry('aud-g', 'regulatory_consent_granted', { partyRole: 'individual', policyVersions: [PV] }, PLAYER));
    store.save({ db: { complianceContexts: [ctx], regulatoryReviews: [review({ snapshot: { outcome: PERMITTED_WITH_CONSENT, evaluationId: 'ctx-1#1', evaluatedAt: NOW } })], regulatoryConsents: [granted, { id: 'rcs-r', kind: 'revocation', of: 'rcs-1', at: NOW + 1, by: PLAYER }] } });
    const back = readTableBacked(store.sqlite);
    assert.equal(back.complianceContexts[0].evaluations.length, 1); assert.deepEqual(back.complianceContexts[0].evaluations[0].reasons, result().reasons);
    assert.deepEqual(back.regulatoryReviews[0].snapshot, { outcome: PERMITTED_WITH_CONSENT, evaluationId: 'ctx-1#1', evaluatedAt: NOW });
    assert.deepEqual(back.regulatoryConsents.map((k) => [k.id, k.kind]), [['rcs-1', 'dual_representation'], ['rcs-r', 'revocation']], 'the ledger reads back with its revocation row');
    store.save({ db: { regulatoryConsents: [] } });
    const kept = readTableBacked(store.sqlite);
    assert.equal(kept.complianceContexts.length, 1); assert.equal(kept.regulatoryReviews.length, 1); assert.equal(kept.regulatoryConsents.length, 0, 'the omitted collections are kept');
    refused(() => store.save({ db: { regulatoryReviews: [review({ id: 'rrv-9', subject: { contextId: 'ctx-gone', representationId: null, partyRole: 'individual' } })] } }), /COMPLIANCE_RECORDS_REFERENCE_MISSING/);
    refused(() => store.save({ db: { regulatoryConsents: [granted, { id: 'rcs-r', kind: 'revocation', of: 'rcs-1', at: NOW, by: PLAYER }, { id: 'rcs-r2', kind: 'revocation', of: 'rcs-1', at: NOW, by: PLAYER }] } }), /revokes rcs-1 a second time/);
    refused(() => store.save({ db: { complianceContexts: [{ ...ctx, interests: [], status: 'paused' }] } }), /COMPLIANCE_RECORDS_IMPORT_BLOCKED.*ctx-1\.status/);
    assert.equal(readTableBacked(store.sqlite).regulatoryReviews.length, 1, 'a refused save wrote nothing');
  } finally { store.sqlite.close(); rm(dir); }
});

console.log(`\ncompliance records repository: ${passed} checks passed`);
