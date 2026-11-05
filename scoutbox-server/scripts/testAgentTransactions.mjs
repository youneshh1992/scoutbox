// S11c — the Agent Transaction Workspace as typed tables with explicit writes (repositories/agentTransactions.mjs,
// migration 0029). What this suite proves: the migration creates the sixteen STRICT tables (no JSON column), empty; the
// typers refuse junk with the record and field named (an unknown field, a status the machine does not know, a player
// who is not the individual, a snapshot naming both an evaluation and a gate, a revision that is not a digest, a
// document whose history does not repeat it); a transaction is created whole and read back whole (parties, notes,
// threads, terms, replay keys, history with its lists), deep-frozen; what never changes does not, notes, terms, keys
// and history only grow, a removed party does not return and an update inside its own update is refused; a snapshot
// names an evaluation of its own context; a withdrawn binding is final and one binding per (role, agent) is live; a
// document version is superseded once; the lists page newest first by cursor and the agent's counts are SQL; the
// duplicate rule's candidates are indexed; an account deletion keeps ids and loses the person; a rolled-back unit
// leaves nothing; the db.* names throw; and the snapshot write types every record, keeps the omitted collections,
// refuses a row naming a missing context and reads back what it wrote. Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attachDataLayer, DATA_MIGRATIONS, TABLE_BACKED, readTableBacked } from '../repositories/index.mjs';
import { openStore } from '../store.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  AGENT_TRANSACTIONS_MIGRATION as MIGRATION, AGENT_TRANSACTIONS_TABLES as TABLES, AGENT_TRANSACTIONS_COLLECTIONS as COLLECTIONS,
  typeTransaction, typeRepresentation, typeDocument,
} from '../repositories/agentTransactions.mjs';
import { snapshotView } from '../domains/agents/transactions/transaction.mjs';

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
const AGENT = { kind: 'org', userId: UID, name: SCOUT.name };
const PLAYER = { kind: 'player', userId: 'pl-1', name: 'Kola' };
const OTHER = { kind: 'player', userId: 'pl-2', name: 'Theo' };
const CLUB_USER = { kind: 'club_user', userId: UID, name: SCOUT.name, orgId: ORG.id };
const REV = 'a'.repeat(64);
const entry = (id, action, detail = null, by = AGENT) => ({ id, at: NOW, action, by, detail });
const party = (over = {}) => ({ id: 'txp-1', partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-1', addedAt: NOW, addedBy: AGENT, removed: false, removedAt: null, confirmedAt: null, confirmedBy: null, subjectRemovedAt: null, ...over });
/** POST /org/agent/transactions. */
const transaction = (over = {}) => ({
  id: 'atx-1', agencyOrgId: ORG.id, agentUserId: UID, type: 'transfer', jurisdictions: ['ENG'], status: 'DRAFT',
  parties: [party(), party({ id: 'txp-2', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id })],
  contextId: 'ctx-1', compliance: null, reEvaluationPending: false, notes: [], linkedThreads: [],
  links: { trialId: null, opportunityId: null, recruitmentCaseId: null }, terms: { versions: [] },
  holdReasonCode: null, holdReason: null, heldAt: null, cancelReasonCode: null, cancelledAt: null, closeReasonCode: null, closedAt: null, archivedAt: null,
  initiatedBy: AGENT, createdAt: NOW, updatedAt: NOW, keys: { create: { key: 'k-tx', fp: '{}' } }, rev: 1, revAt: NOW, revBy: null,
  history: [entry('aud-t1', 'transaction_created', { count: 2 })], ...over,
});
const context = (id = 'ctx-1', tx = 'atx-1') => ({
  id, agencyOrgId: ORG.id, agentUserId: UID, type: 'transfer', jurisdictions: ['ENG'], parties: [], representations: [], resolvedFacts: [],
  reEvaluationPending: false, reviewRejectedAt: null, status: 'open', origin: 'transaction', transactionId: tx, openedAt: NOW, closedAt: null,
  keys: {}, rev: 1, revAt: NOW, revBy: null, history: [entry(`aud-${id}`, 'compliance_context_opened', { type: 'transfer', policyVersions: ['jp-fifa-2025-1'] })],
});
const result = { outcome: 'CLEAR', reasons: [{ code: 'FACET_VERIFIED', ruleId: null, ruleStatus: null, policyVersion: null }], consentsOutstanding: [], requiredActions: [], missingEvidence: [], policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'], evaluatedAt: NOW, inputHash: 'b'.repeat(64) };
const rep = (over = {}) => ({
  id: 'txr-1', transactionId: 'atx-1', agencyOrgId: ORG.id, agentUserId: UID, partyRole: 'individual', agreementId: null, declaredOnly: true, scope: [], jurisdictions: [],
  status: 'verified', reviewId: null, createdAt: NOW, verifiedAt: NOW, verifiedByReviewId: null, firstActAt: NOW, withdrawnAt: null, withdrawnReason: null,
  keys: { attach: { key: 'k-r', fp: '{}' } }, rev: 1, revAt: NOW, revBy: null,
  history: [entry('aud-r1', 'transaction_representation_attached', { partyRole: 'individual', status: 'verified', policyVersions: ['jp-fifa-2025-1'] })], ...over,
});
const doc = (over = {}) => {
  const d = {
    id: 'txd-1', transactionId: 'atx-1', documentType: 'mandate', visibility: 'ALL_TRANSACTION_PARTIES', label: 'Mandate', version: 1,
    owner: { kind: 'agent', id: UID }, ownerPartyRole: null, uploadedBy: AGENT, createdAt: NOW, expiresAt: null, evidenceRef: null,
    supersedes: null, supersededBy: null, removedAt: null, keys: {}, rev: 1, revAt: NOW, revBy: null, ...over,
  };
  d.history ??= [entry(`aud-${d.id}`, 'transaction_document_added', { documentType: d.documentType, visibility: d.visibility, version: d.version }, d.uploadedBy)];
  return d;
};

function serverOpen(dir) {
  const store = openStore(dir, { tableBacked: TABLE_BACKED });
  const db = { ...store.load().db, players: [], guardians: [] };
  const layer = attachDataLayer({ db, store, nextId, persist: () => {}, sessionTtlMs: TTL, now: () => NOW, warn: () => {} });
  const snapshot = () => ({ savedAt: NOW, idCounter: 1000, db });
  const contexts = layer.complianceRecords.contexts;
  const withContext = (id = 'ctx-1', tx = 'atx-1') => { contexts.create(context(id, tx)); return contexts.recordEvaluation(id, result, { parties: [], representations: [], proposed: null }, entry(nextId('aud'), 'compliance_context_evaluated', { outcome: 'CLEAR', reasonCodes: ['FACET_VERIFIED'], policyVersions: result.policyVersions })); };
  return { store, db, repo: layer.agentTransactions, withContext, unit: (w) => store.unitOfWork(w, { snapshot }), close: () => store.sqlite.close() };
}

// ------------------------------------------------------------- schema
test('[schema] 0029 is registered after 0028 and creates the sixteen STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0028_compliance_records') + 1);
  assert.equal(TABLES.length, 16);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11c-empty'); const s = openStore(dir).sqlite;
  for (const t of TABLES) {
    assert.match(s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql, /STRICT\s*$/, `${t} is STRICT`);
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(!s.prepare(`PRAGMA table_info(${t})`).all().some((c) => /_json$/.test(c.name)), `${t}: no JSON column`);
  }
  s.close(); rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeTransaction(transaction()).ok, undefined, 'a typed transaction is the record itself');
  assert.match(typeTransaction(transaction({ notes: [{ id: 'n', visibility: 'AGENT_PRIVATE', text: 'x', by: AGENT, at: NOW, removedAt: null }] })).reason, /notes\[0\] carries field\(s\) this build does not store: removedAt/, 'a note\'s never-written removal is gone');
  assert.match(typeTransaction(transaction({ status: 'HALF_WRITTEN' })).reason, /atx-1\.status must be one of DRAFT/);
  assert.match(typeTransaction(transaction({ parties: [party({ partyRole: 'engaging_entity' })] })).reason, /partyRole is individual exactly for a player/);
  assert.match(typeTransaction(transaction({ parties: [party(), party({ id: 'txp-9' })] })).reason, /names a live party role twice/);
  assert.match(typeTransaction(transaction({ type: 'employment_contract', parties: [party({ id: 'txp-3', partyRole: 'releasing_entity', subjectKind: 'club', subjectId: ORG.id })] })).reason, /releasing entity only in a transfer or a loan/);
  assert.match(typeTransaction(transaction({ compliance: { evaluationId: 'ctx-1#1', gate: 'FACET_NOT_VERIFIED', evaluatedAt: NOW, pendingReason: 'FACET_NOT_VERIFIED', verificationFreshness: null, partyRevision: REV } })).reason, /exactly one/);
  assert.match(typeTransaction(transaction({ compliance: { evaluationId: 'ctx-1#1', gate: null, evaluatedAt: NOW, pendingReason: null, verificationFreshness: null, partyRevision: 'not-a-digest' } })).reason, /partyRevision must be a sha256 hex digest/);
  assert.match(typeTransaction(transaction({ compliance: { evaluationId: 'ctx-1#1', outcome: 'CLEAR', gate: null, evaluatedAt: NOW, pendingReason: null, verificationFreshness: null, partyRevision: REV } })).reason, /does not store: outcome/, 'the snapshot copies nothing its evaluation holds');
  assert.match(typeTransaction(transaction({ holdReasonCode: 'awaiting_document' })).reason, /holdReasonCode is set, with heldAt/);
  assert.match(typeTransaction(transaction({ keys: { 'party:k1': { key: 'k2', fp: '{}' } } })).reason, /repeats its own key/);
  assert.match(typeTransaction(transaction({ history: [entry('aud-x', 'transaction_status_changed', { from: 'DRAFT', to: 'SIGNED' })] })).reason, /detail\.to must be one of/);
  assert.equal(typeRepresentation(rep()).ok, undefined);
  assert.match(typeRepresentation(rep({ declaredEvidenceId: null })).reason, /does not store: declaredEvidenceId/, 'the never-written declared evidence is gone');
  assert.match(typeRepresentation(rep({ status: 'withdrawn' })).reason, /withdrawnAt is set exactly when the binding was withdrawn/);
  assert.match(typeRepresentation(rep({ declaredOnly: false })).reason, /names the agreement of a binding that is not declared/);
  assert.equal(typeDocument(doc()).ok, undefined);
  assert.match(typeDocument(doc({ signedAt: null })).reason, /does not store: signedAt/, 'the never-written signature instant is gone');
  assert.match(typeDocument(doc({ history: [entry('aud-d', 'transaction_document_added', { documentType: 'mandate', visibility: 'AGENT_PRIVATE', version: 1 })] })).reason, /repeats the document's own fields/);
  assert.match(typeDocument(doc({ version: 2 })).reason, /supersedes names the version this one replaces/);
});

// ------------------------------------------------------------- writes and reads
test('[transactions] a transaction is created whole and read back whole; what never changes does not; notes, terms, keys and history only grow; a removed party does not return', () => {
  const dir = tempDir('s11c-tx'); saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transactions;
  try {
    refused(() => T.create(transaction()), /AGENT_TRANSACTIONS_REFERENCE_MISSING/, 'a transaction names its own compliance context');
    const ev = s.withContext();
    const t = T.create(transaction());
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.parties[0].addedBy), 'deep-frozen');
    assert.equal(t.initiatedAt, NOW, 'the opening is the creation');
    refused(() => T.create(transaction()), /already exists/, 'duplicate');
    const v = T.update('atx-1', (d) => {
      d.parties[0].confirmedAt = NOW; d.parties[0].confirmedBy = PLAYER;
      d.notes.push({ id: 'txn-1', visibility: 'AGENT_PRIVATE', text: 'Note', by: AGENT, at: NOW });
      d.linkedThreads.push({ id: 'txm-1', channelId: 'ch-1', linkedBy: CLUB_USER, linkedAt: NOW });
      d.terms.versions.push({ id: 'txt-1', at: NOW, by: AGENT, recordedFor: 'individual', visibility: 'PLAYER_AGENT_SHARED', summary: 'Two years.', version: 1 });
      d.keys['status:k-s'] = { key: 'k-s', fp: '{"to":"ACTIVE"}' };
      d.compliance = { evaluationId: ev.evaluationId, gate: null, evaluatedAt: NOW, pendingReason: null, verificationFreshness: 'VERIFIED', partyRevision: REV };
      d.history.push(entry('aud-t2', 'transaction_compliance_evaluated', { outcome: 'CLEAR', pendingReason: null, reasonCodes: ['FACET_VERIFIED'], policyVersions: result.policyVersions }));
      d.rev = 2; d.revBy = { userId: null, name: 'Representing agent' };
    });
    assert.deepEqual(v.parties[0].confirmedBy, PLAYER); assert.equal(v.notes[0].text, 'Note'); assert.equal(v.linkedThreads[0].linkedBy.orgId, ORG.id);
    assert.deepEqual(v.keys['status:k-s'], { key: 'k-s', fp: '{"to":"ACTIVE"}' }); assert.equal(v.terms.versions[0].version, 1);
    assert.deepEqual(v.history.at(-1).detail, { outcome: 'CLEAR', reasonCodes: ['FACET_VERIFIED'], policyVersions: result.policyVersions }, 'the detail reads back with its lists (a null scalar is not kept)');
    assert.deepEqual(v.revBy, { userId: null, name: 'Representing agent' }, 'the shared rev token names a role');
    const view = snapshotView(v, v.compliance, ev);
    assert.deepEqual([view.outcome, view.clear, view.policyVersions, view.reasonCodes], ['CLEAR', true, result.policyVersions, ['FACET_VERIFIED']], 'the snapshot reads its outcome and versions from its evaluation row');
    refused(() => T.update('atx-1', (d) => { d.type = 'loan'; }), /type cannot change/);
    refused(() => T.update('atx-1', (d) => { d.notes.pop(); }), /notes only grow/);
    refused(() => T.update('atx-1', (d) => { d.history.pop(); }), /history entries only grow/);
    refused(() => T.update('atx-1', (d) => { delete d.keys['status:k-s']; }), /key status:k-s is written once/);
    refused(() => T.update('atx-1', (d) => { T.update('atx-1', () => {}); d.status = 'CANCELLED'; }), /already being updated/);
    s.withContext('ctx-2', 'atx-2');
    refused(() => T.update('atx-1', (d) => { d.compliance = { ...d.compliance, evaluationId: 'ctx-2#1' }; }), /names an evaluation of its own context/);
    T.update('atx-1', (d) => { d.parties[1].removed = true; d.parties[1].removedAt = NOW; });
    refused(() => T.update('atx-1', (d) => { d.parties[1].removed = false; d.parties[1].removedAt = null; }), /a removed party does not return/);
    refused(() => T.update('atx-1', (d) => { d.parties[1].subjectId = 'org-other'; }), /keeps its role, subject and addition/);
    assert.equal(T.byCreateKey(ORG.id, UID, 'k-tx').id, 'atx-1');
  } finally { s.close(); rm(dir); }
});

test('[bindings and documents] a withdrawn binding is final and one binding per (role, agent) is live; a document version is superseded once', () => {
  const dir = tempDir('s11c-reps'); saveFixture(dir);
  const s = serverOpen(dir);
  const { transactions: T, representations: R, documents: D } = s.repo;
  try {
    s.withContext(); T.create(transaction());
    R.create(rep());
    refused(() => R.create(rep({ id: 'txr-2', keys: {}, history: [] })), /AGENT_TRANSACTIONS_DUPLICATE/, 'a second live binding for the same role and agent');
    R.update('txr-1', (x) => { x.status = 'withdrawn'; x.withdrawnAt = NOW; x.withdrawnReason = 'agent_withdrew'; x.history.push(entry('aud-r2', 'transaction_representation_withdrawn', { partyRole: 'individual' })); });
    refused(() => R.update('txr-1', (x) => { x.status = 'verified'; x.withdrawnAt = null; x.withdrawnReason = null; }), /a withdrawn binding does not return/);
    assert.equal(R.create(rep({ id: 'txr-2', keys: {}, history: [] })).status, 'verified', 'once withdrawn, the role can be bound again');
    assert.equal(R.byAttachKey('atx-1', 'k-r').id, 'txr-1');
    D.create(doc());
    refused(() => D.create(doc({ id: 'txd-x', version: 3, supersedes: 'txd-1', history: undefined })), /supersedes the previous version/);
    const v2 = D.create(doc({ id: 'txd-2', version: 2, supersedes: 'txd-1', label: 'Mandate v2', history: undefined }));
    D.update('txd-1', (x) => { x.supersededBy = 'txd-2'; x.history.push(entry('aud-sup', 'transaction_document_superseded', { version: 1 })); });
    refused(() => D.update('txd-1', (x) => { x.supersededBy = 'txd-9'; }), /superseded once/);
    refused(() => D.create(doc({ id: 'txd-3', version: 2, supersedes: 'txd-1', history: undefined })), /AGENT_TRANSACTIONS_DUPLICATE/, 'a version is superseded by one document');
    assert.deepEqual(D.forTransaction('atx-1').map((d) => [d.id, d.supersededBy]), [['txd-1', 'txd-2'], ['txd-2', null]]);
    assert.deepEqual(D.byId('txd-1').history.at(-1).detail, { version: 1 }, 'a document entry is worked out from the document');
    assert.equal(v2.supersedes, 'txd-1'); assert.equal(D.liveCount('atx-1'), 2);
  } finally { s.close(); rm(dir); }
});

test('[reads] the agent\'s list pages newest first by cursor; its counts and the duplicate rule\'s candidates are SQL', () => {
  const dir = tempDir('s11c-reads'); saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transactions;
  try {
    for (const n of [1, 2, 3]) { s.withContext(`ctx-${n}`, `atx-${n}`); T.create(transaction({ id: `atx-${n}`, contextId: `ctx-${n}`, keys: {}, parties: [party({ id: `txp-${n}a` }), party({ id: `txp-${n}b`, partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id })], history: [entry(`aud-c${n}`, 'transaction_created', { count: 2 })], status: n === 3 ? 'CANCELLED' : 'DRAFT', ...(n === 3 ? { cancelReasonCode: 'duplicate', cancelledAt: NOW } : {}) })); }
    const p1 = T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, limit: 2 });
    assert.deepEqual(p1.rows.map((r) => r.record.id), ['atx-3', 'atx-2', 'atx-1'], 'newest first, one more than the page');
    assert.deepEqual(T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, limit: 2, after: p1.rows[1].key }).rows.map((r) => r.record.id), ['atx-1']);
    assert.deepEqual(T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, status: 'CANCELLED', limit: 5 }).rows.map((r) => r.record.id), ['atx-3']);
    assert.deepEqual(T.agentCounts(ORG.id, UID), { live: 2, blocked: 0, pending: 0, ready: 0, awaitingConfirmation: 2 });
    T.update('atx-1', (d) => { for (const p of d.parties) { p.confirmedAt = NOW; p.confirmedBy = p.subjectKind === 'player' ? PLAYER : CLUB_USER; } });
    assert.equal(T.agentCounts(ORG.id, UID).awaitingConfirmation, 2, 'a transfer still awaits its releasing club');
    T.update('atx-1', (d) => { d.parties.push(party({ id: 'txp-r', partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-rel', confirmedAt: NOW, confirmedBy: { kind: 'club_user', userId: 'u-r', name: 'R', orgId: 'org-rel' } })); });
    assert.equal(T.agentCounts(ORG.id, UID).awaitingConfirmation, 1, 'once every required party confirmed, it awaits no one');
    assert.deepEqual(T.liveForIndividual('pl-1', 'transfer').map((t) => t.id), ['atx-1', 'atx-2'], 'the live transfers naming the individual (not the cancelled one)');
    assert.deepEqual(T.clubPage({ orgId: ORG.id, limit: 5 }).rows.map((r) => r.record.id), ['atx-3', 'atx-2', 'atx-1']);
    assert.deepEqual(T.forPlayer('pl-1').map((t) => t.id), ['atx-1', 'atx-2', 'atx-3']);
    assert.deepEqual(T.metrics().byStatus, { CANCELLED: 1, DRAFT: 2 });
  } finally { s.close(); rm(dir); }
});

test('[account deletion] a transaction keeps its ids, roles, states and times and loses the person; bindings are withdrawn; the player\'s documents go', () => {
  const dir = tempDir('s11c-forget'); saveFixture(dir);
  const s = serverOpen(dir);
  const { transactions: T, representations: R, documents: D } = s.repo;
  try {
    s.withContext();
    T.create(transaction({ parties: [party({ confirmedAt: NOW, confirmedBy: PLAYER }), transaction().parties[1]], history: [entry('aud-t1', 'transaction_created', { count: 2 }), entry('aud-t2', 'transaction_party_confirmed', { partyRole: 'individual', subjectKind: 'player' }, PLAYER), entry('aud-t3', 'transaction_party_confirmed', { partyRole: 'individual', subjectKind: 'player' }, OTHER)] }));
    D.create(doc({ id: 'txd-o', owner: { kind: 'player', id: 'pl-2' }, ownerPartyRole: 'individual', uploadedBy: OTHER, visibility: 'PLAYER_AGENT_SHARED' }));
    R.create(rep());
    D.create(doc({ id: 'txd-p', owner: { kind: 'player', id: 'pl-1' }, ownerPartyRole: 'individual', uploadedBy: PLAYER, visibility: 'PLAYER_AGENT_SHARED' }));
    const touched = s.repo.forgetPlayer('pl-1', NOW + 5, () => entry(nextId('aud'), 'transaction_subject_tombstoned', { partyRole: 'individual' }, { kind: 'system', userId: null, name: 'account deletion' }));
    assert.deepEqual(touched, ['atx-1']);
    const t = T.byId('atx-1');
    const p = t.parties.find((x) => x.subjectKind === 'player');
    assert.deepEqual([p.subjectId, p.removed, p.removedAt, p.subjectRemovedAt], ['pl-1', true, NOW + 5, NOW + 5], 'the party stays as an id');
    assert.deepEqual(p.confirmedBy, { kind: 'player', userId: null, name: null });
    assert.ok(t.history.filter((h) => h.by.kind === 'player' && h.id !== 'aud-t3').every((h) => h.by.userId === null && h.by.name === null), 'the history forgets who');
    assert.deepEqual(t.history.find((h) => h.id === 'aud-t3').by, OTHER, 'another player once named keeps their provenance');
    assert.deepEqual([D.byId('txd-o').uploadedBy, D.byId('txd-o').removedAt, D.byId('txd-o').history[0].by], [OTHER, null, OTHER], 'and so does their document');
    assert.equal(t.history.at(-1).action, 'transaction_subject_tombstoned');
    assert.equal(R.byId('txr-1').withdrawnReason, 'subject_removed');
    const d = D.byId('txd-p');
    assert.deepEqual([d.owner, d.removedAt, d.uploadedBy], [{ kind: 'player', id: null }, NOW + 5, { kind: 'player', userId: null, name: null }]);
    assert.ok(d.history.every((h) => h.by.userId === null && h.by.name === null));
  } finally { s.close(); rm(dir); }
});

test('[units] a rolled-back unit leaves nothing; the db.* names throw', () => {
  const dir = tempDir('s11c-units'); saveFixture(dir);
  const s = serverOpen(dir);
  try {
    refused(() => s.unit(() => { s.withContext(); s.repo.transactions.create(transaction()); s.repo.representations.create(rep()); throw new Error('boom'); }), /boom/);
    assert.equal(s.repo.transactions.byId('atx-1'), null); assert.equal(s.repo.representations.byId('txr-1'), null);
    for (const n of COLLECTIONS) assert.throws(() => s.db[n], /read it through the agentTransactions repository/);
  } finally { s.close(); rm(dir); }
});

test('[snapshot] the snapshot write types every record, keeps the omitted collections, refuses junk and a row naming a missing context, and reads back what it wrote', () => {
  const dir = tempDir('s11c-snapshot'); saveFixture(dir);
  const store = openStore(dir);
  try {
    const ctx = { ...context(), history: [...context().history, entry('aud-e1', 'compliance_context_evaluated', { outcome: 'CLEAR', reasonCodes: ['FACET_VERIFIED'], policyVersions: result.policyVersions })], evaluations: [{ ...result, snapshotOf: { parties: [], representations: [], proposed: null } }] };
    const tx = transaction({ compliance: { evaluationId: 'ctx-1#1', gate: null, evaluatedAt: NOW, pendingReason: 'PARTIES_NOT_CONFIRMED', verificationFreshness: 'VERIFIED', partyRevision: REV } });
    store.save({ db: { complianceContexts: [ctx], agentTransactions: [tx], transactionRepresentations: [rep()], transactionDocuments: [doc({ supersededBy: 'txd-2' }), doc({ id: 'txd-2', version: 2, supersedes: 'txd-1', history: undefined })] } });
    const back = readTableBacked(store.sqlite);
    assert.deepEqual(back.agentTransactions[0].compliance, tx.compliance); assert.equal(back.transactionRepresentations.length, 1);
    assert.deepEqual(back.transactionDocuments.map((d) => [d.id, d.supersedes, d.supersededBy]), [['txd-1', null, 'txd-2'], ['txd-2', 'txd-1', null]], 'the version chain reads back both ways');
    store.save({ db: { transactionDocuments: [] } });
    const kept = readTableBacked(store.sqlite);
    assert.equal(kept.agentTransactions.length, 1); assert.equal(kept.transactionRepresentations.length, 1); assert.equal(kept.transactionDocuments.length, 0, 'the omitted collections are kept');
    store.save({ db: { complianceContexts: [ctx] } });
    assert.equal(readTableBacked(store.sqlite).agentTransactions.length, 1, 'rewriting the compliance records keeps the transactions that name them');
    refused(() => store.save({ db: { complianceContexts: [] } }), /REFERENCE_MISSING/, 'a context a transaction names cannot go');
    refused(() => store.save({ db: { agentTransactions: [transaction({ id: 'atx-9', contextId: 'ctx-gone' })] } }), /AGENT_TRANSACTIONS_REFERENCE_MISSING/);
    refused(() => store.save({ db: { agentTransactions: [{ ...tx, status: 'HALF_WRITTEN' }] } }), /AGENT_TRANSACTIONS_IMPORT_BLOCKED.*atx-1\.status/);
    assert.equal(readTableBacked(store.sqlite).agentTransactions[0].status, 'DRAFT', 'a refused save wrote nothing');
  } finally { store.sqlite.close(); rm(dir); }
});

console.log(`\nagent transactions repository: ${passed} checks passed`);
