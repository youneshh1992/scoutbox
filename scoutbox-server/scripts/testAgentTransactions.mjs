// The Agent Transaction Workspace (repositories/agentTransactions.mjs, migration 0029): the STRICT tables, the
// refusals a create meets, a transaction changed only through named acts, a snapshot naming an evaluation of its own
// context, a withdrawn binding final and one live binding per (role, agent), document
// supersession, cursor paging and SQL counts, account deletion keeping ids only, units of work and fixtures.
// Temporary databases only. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords, writeFixture } from './dataLayerFixture.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture, fixtureDb, ORG, SCOUT } from './recruitmentTestFixtures.mjs';
import {
  AGENT_TRANSACTIONS_MIGRATION as MIGRATION,
  AGENT_TRANSACTIONS_TABLES as TABLES,
  AGENT_TRANSACTIONS_COLLECTIONS as COLLECTIONS,
} from '../repositories/agentTransactions.mjs';
import { snapshotView } from '../domains/agents/transactions/transaction.mjs';
import { registerTransactions } from '../domains/agents/transactions/index.mjs';

let passed = 0;
const only = process.env.TEST_ONLY || '';
function test(name, fn) {
  if (only && !name.includes(only)) return;
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const rm = (...dirs) => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
let counter = 9000;
const nextId = (p) => `${p}-${++counter}`;
const refused = (fn, pattern, label = '') => {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `${label}: expected a refusal`);
  assert.match(String(err.message), pattern, `${label}: ${err.message}`);
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
const party = (over = {}) => ({
  id: 'txp-1',
  partyRole: 'individual',
  subjectKind: 'player',
  subjectId: 'pl-1',
  addedAt: NOW,
  addedBy: AGENT,
  removed: false,
  removedAt: null,
  confirmedAt: null,
  confirmedBy: null,
  subjectRemovedAt: null,
  ...over,
});
/** POST /org/agent/transactions. */
const transaction = (over = {}) => ({
  id: 'atx-1',
  agencyOrgId: ORG.id,
  agentUserId: UID,
  type: 'transfer',
  jurisdictions: ['ENG'],
  status: 'DRAFT',
  parties: [party(), party({ id: 'txp-2', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id })],
  contextId: 'ctx-1',
  compliance: null,
  reEvaluationPending: false,
  notes: [],
  linkedThreads: [],
  links: { trialId: null, opportunityId: null, recruitmentCaseId: null },
  terms: { versions: [] },
  holdReasonCode: null,
  holdReason: null,
  heldAt: null,
  cancelReasonCode: null,
  cancelledAt: null,
  closeReasonCode: null,
  closedAt: null,
  archivedAt: null,
  initiatedBy: AGENT,
  createdAt: NOW,
  updatedAt: NOW,
  keys: { create: { key: 'k-tx', fp: '{}' } },
  rev: 1,
  revAt: NOW,
  revBy: null,
  history: [entry('aud-t1', 'transaction_created', { count: 2 })],
  ...over,
});
const context = (id = 'ctx-1', tx = 'atx-1') => ({
  id,
  agencyOrgId: ORG.id,
  agentUserId: UID,
  type: 'transfer',
  jurisdictions: ['ENG'],
  parties: [],
  representations: [],
  resolvedFacts: [],
  reEvaluationPending: false,
  reviewRejectedAt: null,
  status: 'open',
  origin: 'transaction',
  transactionId: tx,
  openedAt: NOW,
  closedAt: null,
  keys: {},
  rev: 1,
  revAt: NOW,
  revBy: null,
  history: [entry(`aud-${id}`, 'compliance_context_opened', { type: 'transfer', policyVersions: ['jp-fifa-2025-1'] })],
});
const result = {
  outcome: 'CLEAR',
  reasons: [{ code: 'FACET_VERIFIED', ruleId: null, ruleStatus: null, policyVersion: null }],
  consentsOutstanding: [],
  requiredActions: [],
  missingEvidence: [],
  policyVersions: ['jp-fifa-2025-1', 'jp-eng-2026-27-1'],
  evaluatedAt: NOW,
  inputHash: 'b'.repeat(64),
};
const rep = (over = {}) => ({
  id: 'txr-1',
  transactionId: 'atx-1',
  agencyOrgId: ORG.id,
  agentUserId: UID,
  partyRole: 'individual',
  agreementId: null,
  declaredOnly: true,
  scope: [],
  jurisdictions: [],
  status: 'verified',
  reviewId: null,
  createdAt: NOW,
  verifiedAt: NOW,
  verifiedByReviewId: null,
  firstActAt: NOW,
  withdrawnAt: null,
  withdrawnReason: null,
  keys: { attach: { key: 'k-r', fp: '{}' } },
  rev: 1,
  revAt: NOW,
  revBy: null,
  history: [
    entry('aud-r1', 'transaction_representation_attached', {
      partyRole: 'individual',
      status: 'verified',
      policyVersions: ['jp-fifa-2025-1'],
    }),
  ],
  ...over,
});
const doc = (over = {}) => {
  const d = {
    id: 'txd-1',
    transactionId: 'atx-1',
    documentType: 'mandate',
    visibility: 'ALL_TRANSACTION_PARTIES',
    label: 'Mandate',
    version: 1,
    owner: { kind: 'agent', id: UID },
    ownerPartyRole: null,
    uploadedBy: AGENT,
    createdAt: NOW,
    expiresAt: null,
    evidenceRef: null,
    supersedes: null,
    supersededBy: null,
    removedAt: null,
    keys: {},
    rev: 1,
    revAt: NOW,
    revBy: null,
    ...over,
  };
  d.history ??= [
    entry(
      `aud-${d.id}`,
      'transaction_document_added',
      { documentType: d.documentType, visibility: d.visibility, version: d.version },
      d.uploadedBy,
    ),
  ];
  return d;
};

function serverOpen(dir) {
  const { store, layer, unit, close } = openLayer(dir, { nextId, sessionTtlMs: TTL, now: () => NOW });
  const contexts = layer.complianceRecords.contexts;
  const withContext = (id = 'ctx-1', tx = 'atx-1') => {
    contexts.create(context(id, tx));
    return contexts.recordEvaluation(
      id,
      result,
      { parties: [], representations: [], proposed: null },
      entry(nextId('aud'), 'compliance_context_evaluated', {
        outcome: 'CLEAR',
        reasonCodes: ['FACET_VERIFIED'],
        policyVersions: result.policyVersions,
      }),
    );
  };
  return { store, repo: layer.agentTransactions, withContext, unit, close };
}

// ------------------------------------------------------------- schema
test('[wiring] the workspace subscribes to decided reviews of its declared bindings when it registers, and refuses to register without the compliance seam', () => {
  const repo = { transactions: { recordAct: () => {} }, representations: {}, documents: {}, reads: {} };
  assert.throws(
    () => registerTransactions({ agentTransactions: repo, unit: () => {} }),
    (e) => e instanceof TypeError && /transaction seam/.test(e.message),
  );
  const handlers = [];
  try {
    registerTransactions({
      agentTransactions: repo,
      unit: () => {},
      compliance: { onRepresentationReviewed: (fn) => handlers.push(fn) },
    });
  } catch {
    /* the stub context stops registration after the subscription */
  }
  assert.equal(handlers.length, 1, 'one subscription, made before anything else registers');
});

test('[schema] 0029 is registered after 0028 and creates the sixteen STRICT tables (no JSON column), empty', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0028_compliance_records') + 1);
  assert.equal(TABLES.length, 16);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11c-empty');
  const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(
      s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql,
      /STRICT\s*$/,
      `${t} is STRICT`,
    );
    assert.equal(s.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0);
    assert.ok(
      !s
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .some((c) => /_json$/.test(c.name)),
      `${t}: no JSON column`,
    );
  }
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- creating
test('[create] a whole record reads back as written; a field with no column and a value the columns refuse are refused, naming the record', () => {
  const dir = tempDir('s11c-create');
  saveFixture(dir);
  const s = serverOpen(dir);
  const { transactions: T, representations: R, documents: D } = s.repo;
  try {
    s.withContext();
    s.withContext('ctx-2', 'atx-2');
    const tx = (over) => transaction({ id: 'atx-2', contextId: 'ctx-2', keys: {}, ...over });
    refused(
      () =>
        T.create(
          tx({ notes: [{ id: 'n', visibility: 'AGENT_PRIVATE', text: 'x', by: AGENT, at: NOW, removedAt: NOW }] }),
        ),
      /atx-2 notes\[0\]\.removedAt: is not stored as written/,
      "a note's never-written removal",
    );
    refused(() => T.create(tx({ status: 'HALF_WRITTEN' })), /INPUT_INVALID: agent_transactions atx-2 row: .*status/);
    refused(
      () => T.create(tx({ parties: [party({ partyRole: 'engaging_entity' })] })),
      /INPUT_INVALID: agent_transactions atx-2 party txp-1/,
      'a player is the individual',
    );
    refused(
      () => T.create(tx({ parties: [party(), party({ id: 'txp-9' })] })),
      /DUPLICATE: agent_transactions atx-2 party txp-9/,
      'a live party role twice',
    );
    refused(
      () =>
        T.create(
          tx({
            type: 'employment_contract',
            parties: [party({ id: 'txp-3', partyRole: 'releasing_entity', subjectKind: 'club', subjectId: ORG.id })],
          }),
        ),
      /INPUT_INVALID: .*releasing_entity/,
      'a releasing entity only in a transfer or a loan',
    );
    refused(
      () =>
        T.create(
          tx({
            compliance: {
              evaluationId: 'ctx-2#1',
              gate: 'FACET_NOT_VERIFIED',
              evaluatedAt: NOW,
              pendingReason: 'FACET_NOT_VERIFIED',
              verificationFreshness: null,
              partyRevision: REV,
            },
          }),
        ),
      /INPUT_INVALID: agent_transactions atx-2 row/,
      'an evaluation or a gate, not both',
    );
    refused(
      () =>
        T.create(
          tx({
            compliance: {
              evaluationId: 'ctx-2#1',
              gate: null,
              evaluatedAt: NOW,
              pendingReason: null,
              verificationFreshness: null,
              partyRevision: 'not-a-digest',
            },
          }),
        ),
      /compliance_party_revision/,
    );
    refused(
      () =>
        T.create(
          tx({
            compliance: {
              evaluationId: 'ctx-1#1',
              gate: null,
              evaluatedAt: NOW,
              pendingReason: null,
              verificationFreshness: null,
              partyRevision: REV,
            },
          }),
        ),
      /REFERENCE_MISSING: agent_transactions atx-2/,
      'the snapshot names an evaluation of its own context',
    );
    refused(
      () =>
        T.create(
          tx({
            compliance: {
              evaluationId: 'ctx-2#1',
              outcome: 'CLEAR',
              gate: null,
              evaluatedAt: NOW,
              pendingReason: null,
              verificationFreshness: null,
              partyRevision: REV,
            },
          }),
        ),
      /compliance\.outcome: is not stored as written/,
      'the snapshot copies nothing its evaluation holds',
    );
    refused(() => T.create(tx({ holdReasonCode: 'awaiting_document' })), /hold_reason_code/);
    refused(() => T.create(tx({ keys: { 'party:k1': { key: 'k2', fp: '{}' } } })), /repeats its own key/);
    refused(
      () => T.create(tx({ history: [entry('aud-x', 'transaction_status_changed', { from: 'DRAFT', to: 'SIGNED' })] })),
      /history aud-x.*detail_to/,
    );
    refused(
      () => T.create(tx({ history: [entry('aud-y', 'transaction_status_changed', { from: 'DRAFT', mood: 'happy' })] })),
      /history aud-y detail carries field\(s\) this build does not store: mood/,
    );
    refused(() => T.create({ id: 'atx-partial' }), /INPUT_INVALID: agent_transactions atx-partial/, 'a partial record');
    assert.equal(T.byId('atx-2'), null, 'nothing of a refused create is stored');
    T.create(transaction());
    refused(
      () => R.create(rep({ declaredEvidenceId: 'ev-1' })),
      /declaredEvidenceId: is not stored as written/,
      'the never-written declared evidence',
    );
    refused(() => R.create(rep({ status: 'withdrawn' })), /withdrawn_at/);
    refused(
      () => R.create(rep({ declaredOnly: false })),
      /verified_by_review_id/,
      'a binding that is not declared names its agreement',
    );
    refused(
      () => R.create(rep({ agencyOrgId: 'org-other' })),
      /REFERENCE_MISSING: transaction_representations txr-1/,
      'a binding is in a transaction of its own agency',
    );
    refused(
      () => D.create(doc({ signedAt: NOW })),
      /signedAt: is not stored as written/,
      'the never-written signature instant',
    );
    refused(
      () =>
        D.create(
          doc({
            history: [
              entry('aud-d', 'transaction_document_added', {
                documentType: 'mandate',
                visibility: 'AGENT_PRIVATE',
                version: 1,
              }),
            ],
          }),
        ),
      /history\[0\]\.detail\.visibility: is not stored as written/,
      "an entry repeats the document's own fields",
    );
    refused(() => D.create(doc({ version: 2 })), /supersedes_id/, 'a later version names the one it replaces');
  } finally {
    s.close();
    rm(dir);
  }
});

// ------------------------------------------------------------- acts
test('[transactions] a transaction changes only through named acts; history, notes, terms and keys are inserted; a status moves only along its table; nothing is added to an ended one', () => {
  const dir = tempDir('s11c-tx');
  saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transactions;
  try {
    refused(
      () => T.create(transaction()),
      /AGENT_TRANSACTIONS_REFERENCE_MISSING/,
      'a transaction names its own compliance context',
    );
    const ev = s.withContext();
    const t = T.create(transaction());
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.parties[0].addedBy), 'deep-frozen');
    assert.equal(t.initiatedAt, NOW, 'the opening is the creation');
    refused(() => T.create(transaction()), /already exists/, 'duplicate');
    T.confirmParty('atx-1', { partyId: 'txp-1', at: NOW, by: PLAYER });
    T.addNote('atx-1', { note: { id: 'txn-1', visibility: 'AGENT_PRIVATE', text: 'Note', by: AGENT, at: NOW } });
    T.linkThread('atx-1', { thread: { id: 'txm-1', channelId: 'ch-1', linkedBy: CLUB_USER, linkedAt: NOW } });
    T.recordTerms('atx-1', {
      terms: {
        id: 'txt-1',
        at: NOW,
        by: AGENT,
        recordedFor: 'individual',
        visibility: 'PLAYER_AGENT_SHARED',
        summary: 'Two years.',
        version: 1,
      },
    });
    refused(
      () =>
        T.recordTerms('atx-1', {
          terms: {
            id: 'txt-3',
            at: NOW,
            by: AGENT,
            recordedFor: 'individual',
            visibility: 'PLAYER_AGENT_SHARED',
            summary: 'Three.',
            version: 3,
          },
        }),
      /is version 2/,
      'terms count from 1, in order',
    );
    const v = T.recordCompliance(
      'atx-1',
      {
        snapshot: {
          evaluationId: ev.evaluationId,
          gate: null,
          evaluatedAt: NOW,
          pendingReason: null,
          verificationFreshness: 'VERIFIED',
          partyRevision: REV,
        },
      },
      {
        at: NOW + 1,
        touch: true,
        bump: { at: NOW + 1, label: 'Representing agent' },
        history: [
          entry('aud-t2', 'transaction_compliance_evaluated', {
            outcome: 'CLEAR',
            pendingReason: null,
            reasonCodes: ['FACET_VERIFIED'],
            policyVersions: result.policyVersions,
          }),
        ],
      },
    );
    assert.deepEqual(v.parties[0].confirmedBy, PLAYER);
    assert.equal(v.notes[0].text, 'Note');
    assert.equal(v.linkedThreads[0].linkedBy.orgId, ORG.id);
    assert.equal(v.terms.versions[0].version, 1);
    assert.deepEqual([v.rev, v.updatedAt], [2, NOW + 1]);
    assert.deepEqual(
      v.history.at(-1).detail,
      { outcome: 'CLEAR', reasonCodes: ['FACET_VERIFIED'], policyVersions: result.policyVersions },
      'the detail reads back with its lists (a null scalar is not kept)',
    );
    assert.deepEqual(v.revBy, { userId: null, name: 'Representing agent' }, 'the shared rev token names a role');
    const view = snapshotView(v, v.compliance, ev);
    assert.deepEqual(
      [view.outcome, view.clear, view.policyVersions, view.reasonCodes],
      ['CLEAR', true, result.policyVersions, ['FACET_VERIFIED']],
      'the snapshot reads its outcome and versions from its evaluation row',
    );
    s.withContext('ctx-2', 'atx-2');
    refused(
      () => T.recordCompliance('atx-1', { snapshot: { ...v.compliance, evaluationId: 'ctx-2#1' } }),
      /REFERENCE_MISSING/,
      'the snapshot names an evaluation of its own context',
    );
    refused(
      () => T.confirmParty('atx-1', { partyId: 'txp-1', at: NOW, by: PLAYER }),
      /STATE_CONFLICT.*already confirmed/,
      'a party confirms once',
    );
    refused(
      () => T.recordCompliance('atx-1', { snapshot: v.compliance, to: 'READY' }),
      /STATE_CONFLICT.*cannot move to READY/,
      'a draft makes no compliance claim',
    );
    refused(
      () => T.moveByActor('atx-1', { to: 'ACTIVE', at: NOW }),
      /STATE_CONFLICT.*by an actor/,
      'an actor moves only along ACTOR_TRANSITIONS',
    );
    T.removeParty('atx-1', { partyId: 'txp-2', at: NOW });
    refused(
      () => T.removeParty('atx-1', { partyId: 'txp-2', at: NOW }),
      /STATE_CONFLICT.*already removed/,
      'a removed party does not return',
    );
    T.addParty('atx-1', {
      party: party({ id: 'txp-4', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id }),
      key: { key: 'k-p', fp: '{}' },
    });
    assert.deepEqual(T.byId('atx-1').keys['party:k-p'], { key: 'k-p', fp: '{}' }, 'the replay key is a row of its own');
    refused(
      () =>
        T.addParty('atx-1', {
          party: party({ id: 'txp-5', partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id }),
        }),
      /DUPLICATE/,
      'one live party per role',
    );
    const c = T.moveByActor('atx-1', {
      to: 'CANCELLED',
      at: NOW + 2,
      key: { key: 'k-s', fp: '{"to":"CANCELLED"}' },
      reasonCode: 'duplicate',
    });
    assert.deepEqual(
      [c.status, c.cancelReasonCode, c.cancelledAt, c.keys['status:k-s'].fp],
      ['CANCELLED', 'duplicate', NOW + 2, '{"to":"CANCELLED"}'],
    );
    refused(
      () =>
        T.addNote('atx-1', { note: { id: 'txn-2', visibility: 'AGENT_PRIVATE', text: 'Late', by: AGENT, at: NOW } }),
      /STATE_CONFLICT.*has ended/,
      'nothing is added to an ended transaction',
    );
    refused(() => T.recordAct('atx-none', {}), /NOT_FOUND/);
    assert.equal(T.byCreateKey(ORG.id, UID, 'k-tx').id, 'atx-1');
    assert.equal(typeof T.update, 'undefined', 'there is no whole-record update');
  } finally {
    s.close();
    rm(dir);
  }
});

test('[bindings and documents] a withdrawal is final and one binding per (role, agent) is live; a document version is superseded once, by the next version of its own transaction', () => {
  const dir = tempDir('s11c-reps');
  saveFixture(dir);
  const s = serverOpen(dir);
  const { transactions: T, representations: R, documents: D } = s.repo;
  try {
    s.withContext();
    T.create(transaction());
    R.create(rep());
    refused(
      () => R.create(rep({ id: 'txr-2', keys: {}, history: [] })),
      /AGENT_TRANSACTIONS_DUPLICATE/,
      'a second live binding for the same role and agent',
    );
    const w = R.withdraw(
      'txr-1',
      { at: NOW, reason: 'agent_withdrew' },
      {
        history: [entry('aud-r2', 'transaction_representation_withdrawn', { partyRole: 'individual' })],
        bump: { at: NOW, by: { userId: null, name: 'Representing agent' } },
      },
    );
    assert.deepEqual([w.status, w.withdrawnReason, w.rev, w.history.length], ['withdrawn', 'agent_withdrew', 2, 2]);
    refused(
      () => R.withdraw('txr-1', { at: NOW, reason: 'agent_withdrew' }),
      /STATE_CONFLICT.*already withdrawn/,
      'a withdrawal is final',
    );
    refused(() => R.verifyByReview('txr-1', { at: NOW, reviewId: 'rr-1' }), /STATE_CONFLICT.*not awaiting review/);
    assert.equal(
      R.create(rep({ id: 'txr-2', keys: {}, history: [] })).status,
      'verified',
      'once withdrawn, the role can be bound again',
    );
    assert.equal(R.byAttachKey('atx-1', 'k-r').id, 'txr-1');
    D.create(doc());
    const next = (over) =>
      doc({ id: 'txd-2', version: 2, supersedes: 'txd-1', label: 'Mandate v2', history: undefined, ...over });
    refused(
      () => D.supersede('txd-1', { document: next({ id: 'txd-x', version: 3 }) }),
      /STATE_CONFLICT.*not the live previous version/,
    );
    refused(() => D.supersede('txd-1', { document: next({ supersedes: null }) }), /names the one it supersedes/);
    const old = D.supersede(
      'txd-1',
      { document: next() },
      {
        history: [entry('aud-sup', 'transaction_document_superseded', { version: 1 })],
        bump: { at: NOW, by: { userId: null, name: 'Representing agent' } },
      },
    );
    assert.deepEqual(
      [old.supersededBy, old.rev],
      ['txd-2', 2],
      'the old version reads its successor from the row naming it',
    );
    refused(
      () => D.supersede('txd-1', { document: next({ id: 'txd-3' }) }),
      /AGENT_TRANSACTIONS_DUPLICATE/,
      'a version is superseded once',
    );
    assert.deepEqual(
      D.forTransaction('atx-1').map((d) => [d.id, d.supersededBy]),
      [
        ['txd-1', 'txd-2'],
        ['txd-2', null],
      ],
    );
    assert.deepEqual(
      D.byId('txd-1').history.at(-1).detail,
      { version: 1 },
      'a document entry is worked out from the document',
    );
    assert.equal(D.byId('txd-2').supersedes, 'txd-1');
    assert.equal(D.liveCount('atx-1'), 2);
  } finally {
    s.close();
    rm(dir);
  }
});

test("[reads] the agent's list pages newest first by cursor; its counts and the duplicate rule's candidates are SQL", () => {
  const dir = tempDir('s11c-reads');
  saveFixture(dir);
  const s = serverOpen(dir);
  const T = s.repo.transactions;
  try {
    for (const n of [1, 2, 3]) {
      s.withContext(`ctx-${n}`, `atx-${n}`);
      T.create(
        transaction({
          id: `atx-${n}`,
          contextId: `ctx-${n}`,
          keys: {},
          parties: [
            party({ id: `txp-${n}a` }),
            party({ id: `txp-${n}b`, partyRole: 'engaging_entity', subjectKind: 'club', subjectId: ORG.id }),
          ],
          history: [entry(`aud-c${n}`, 'transaction_created', { count: 2 })],
          status: n === 3 ? 'CANCELLED' : 'DRAFT',
          ...(n === 3 ? { cancelReasonCode: 'duplicate', cancelledAt: NOW } : {}),
        }),
      );
    }
    const p1 = T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, limit: 2 });
    assert.deepEqual(
      p1.rows.map((r) => r.record.id),
      ['atx-3', 'atx-2', 'atx-1'],
      'newest first, one more than the page',
    );
    assert.deepEqual(
      T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, limit: 2, after: p1.rows[1].key }).rows.map(
        (r) => r.record.id,
      ),
      ['atx-1'],
    );
    assert.deepEqual(
      T.agentPage({ agencyOrgId: ORG.id, agentUserId: UID, status: 'CANCELLED', limit: 5 }).rows.map(
        (r) => r.record.id,
      ),
      ['atx-3'],
    );
    assert.deepEqual(T.agentCounts(ORG.id, UID), {
      live: 2,
      blocked: 0,
      pending: 0,
      ready: 0,
      awaitingConfirmation: 2,
    });
    for (const p of T.byId('atx-1').parties)
      T.confirmParty('atx-1', { partyId: p.id, at: NOW, by: p.subjectKind === 'player' ? PLAYER : CLUB_USER });
    assert.equal(T.agentCounts(ORG.id, UID).awaitingConfirmation, 2, 'a transfer still awaits its releasing club');
    T.addParty('atx-1', {
      party: party({
        id: 'txp-r',
        partyRole: 'releasing_entity',
        subjectKind: 'club',
        subjectId: 'org-rel',
        confirmedAt: NOW,
        confirmedBy: { kind: 'club_user', userId: 'u-r', name: 'R', orgId: 'org-rel' },
      }),
    });
    assert.equal(
      T.agentCounts(ORG.id, UID).awaitingConfirmation,
      1,
      'once every required party confirmed, it awaits no one',
    );
    assert.deepEqual(
      T.liveForIndividual('pl-1', 'transfer').map((t) => t.id),
      ['atx-1', 'atx-2'],
      'the live transfers naming the individual (not the cancelled one)',
    );
    assert.deepEqual(
      T.clubPage({ orgId: ORG.id, limit: 5 }).rows.map((r) => r.record.id),
      ['atx-3', 'atx-2', 'atx-1'],
    );
    assert.deepEqual(
      T.forPlayer('pl-1').map((t) => t.id),
      ['atx-1', 'atx-2', 'atx-3'],
    );
    assert.deepEqual(T.metrics().byStatus, { CANCELLED: 1, DRAFT: 2 });
  } finally {
    s.close();
    rm(dir);
  }
});

test("[account deletion] a transaction keeps its ids, roles, states and times and loses the person; bindings are withdrawn; the player's documents go", () => {
  const dir = tempDir('s11c-forget');
  saveFixture(dir);
  const s = serverOpen(dir);
  const { transactions: T, representations: R, documents: D } = s.repo;
  try {
    s.withContext();
    T.create(
      transaction({
        parties: [party({ confirmedAt: NOW, confirmedBy: PLAYER }), transaction().parties[1]],
        history: [
          entry('aud-t1', 'transaction_created', { count: 2 }),
          entry('aud-t2', 'transaction_party_confirmed', { partyRole: 'individual', subjectKind: 'player' }, PLAYER),
          entry('aud-t3', 'transaction_party_confirmed', { partyRole: 'individual', subjectKind: 'player' }, OTHER),
        ],
      }),
    );
    D.create(
      doc({
        id: 'txd-o',
        owner: { kind: 'player', id: 'pl-2' },
        ownerPartyRole: 'individual',
        uploadedBy: OTHER,
        visibility: 'PLAYER_AGENT_SHARED',
      }),
    );
    R.create(rep());
    D.create(
      doc({
        id: 'txd-p',
        owner: { kind: 'player', id: 'pl-1' },
        ownerPartyRole: 'individual',
        uploadedBy: PLAYER,
        visibility: 'PLAYER_AGENT_SHARED',
      }),
    );
    const touched = s.repo.forgetPlayer('pl-1', NOW + 5, () =>
      entry(
        nextId('aud'),
        'transaction_subject_tombstoned',
        { partyRole: 'individual' },
        { kind: 'system', userId: null, name: 'account deletion' },
      ),
    );
    assert.deepEqual(touched, ['atx-1']);
    const t = T.byId('atx-1');
    const p = t.parties.find((x) => x.subjectKind === 'player');
    assert.deepEqual(
      [p.subjectId, p.removed, p.removedAt, p.subjectRemovedAt],
      ['pl-1', true, NOW + 5, NOW + 5],
      'the party stays as an id',
    );
    assert.deepEqual(p.confirmedBy, { kind: 'player', userId: null, name: null });
    assert.ok(
      t.history
        .filter((h) => h.by.kind === 'player' && h.id !== 'aud-t3')
        .every((h) => h.by.userId === null && h.by.name === null),
      'the history forgets who',
    );
    assert.deepEqual(
      t.history.find((h) => h.id === 'aud-t3').by,
      OTHER,
      'another player once named keeps their provenance',
    );
    assert.deepEqual(
      [D.byId('txd-o').uploadedBy, D.byId('txd-o').removedAt, D.byId('txd-o').history[0].by],
      [OTHER, null, OTHER],
      'and so does their document',
    );
    assert.equal(t.history.at(-1).action, 'transaction_subject_tombstoned');
    assert.equal(R.byId('txr-1').withdrawnReason, 'subject_removed');
    const d = D.byId('txd-p');
    assert.deepEqual(
      [d.owner, d.removedAt, d.uploadedBy],
      [{ kind: 'player', id: null }, NOW + 5, { kind: 'player', userId: null, name: null }],
    );
    assert.ok(d.history.every((h) => h.by.userId === null && h.by.name === null));
  } finally {
    s.close();
    rm(dir);
  }
});

test('[units] a rolled-back unit leaves nothing', () => {
  const dir = tempDir('s11c-units');
  saveFixture(dir);
  const s = serverOpen(dir);
  try {
    refused(
      () =>
        s.unit(() => {
          s.withContext();
          s.repo.transactions.create(transaction());
          s.repo.representations.create(rep());
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(s.repo.transactions.byId('atx-1'), null);
    assert.equal(s.repo.representations.byId('txr-1'), null);
  } finally {
    s.close();
    rm(dir);
  }
});

// The fixture writes contexts the way the routes do: a context is opened and then evaluated (recordEvaluation). A new
// document version names the one it replaces, which reads it back as its successor.
const WRITERS = {
  complianceContexts: (L, records) => {
    for (const { evaluations = [], ...c } of records) {
      const entries = c.history.filter((h) => h.action === 'compliance_context_evaluated');
      L.complianceRecords.contexts.create({
        ...c,
        history: c.history.filter((h) => h.action !== 'compliance_context_evaluated'),
      });
      evaluations.forEach(({ snapshotOf, ...r }, i) =>
        L.complianceRecords.contexts.recordEvaluation(c.id, r, snapshotOf, entries[i]),
      );
    }
  },
};
const fixture = (dir, collections) => writeFixture(dir, fixtureDb(collections), { now: NOW, writers: WRITERS });

test('[fixtures] records written through the repository are stored as written, junk and a row naming a missing context are refused (nothing written), and they read back as written', () => {
  const dir = tempDir('s11c-fix');
  try {
    const ctx = {
      ...context(),
      history: [
        ...context().history,
        entry('aud-e1', 'compliance_context_evaluated', {
          outcome: 'CLEAR',
          reasonCodes: ['FACET_VERIFIED'],
          policyVersions: result.policyVersions,
        }),
      ],
      evaluations: [{ ...result, snapshotOf: { parties: [], representations: [], proposed: null } }],
    };
    const tx = transaction({
      compliance: {
        evaluationId: 'ctx-1#1',
        gate: null,
        evaluatedAt: NOW,
        pendingReason: 'PARTIES_NOT_CONFIRMED',
        verificationFreshness: 'VERIFIED',
        partyRevision: REV,
      },
    });
    fixture(dir, {
      complianceContexts: [ctx],
      agentTransactions: [tx],
      transactionRepresentations: [rep()],
      transactionDocuments: [doc(), doc({ id: 'txd-2', version: 2, supersedes: 'txd-1', history: undefined })],
    });
    const back = readRecords(dir);
    assert.deepEqual(back.agentTransactions[0].compliance, tx.compliance);
    assert.equal(back.transactionRepresentations.length, 1);
    assert.deepEqual(
      back.transactionDocuments.map((d) => [d.id, d.supersedes, d.supersededBy]),
      [
        ['txd-1', null, 'txd-2'],
        ['txd-2', 'txd-1', null],
      ],
      'the version chain reads back both ways',
    );
    const bad = [tempDir('s11c-fix-ctx'), tempDir('s11c-fix-status')];
    refused(
      () => fixture(bad[0], { agentTransactions: [transaction({ id: 'atx-9', contextId: 'ctx-gone' })] }),
      /AGENT_TRANSACTIONS_REFERENCE_MISSING: agent_transactions atx-9 names a row that is not there/,
      'a row naming a missing context',
    );
    refused(
      () => fixture(bad[1], { complianceContexts: [ctx], agentTransactions: [{ ...tx, status: 'HALF_WRITTEN' }] }),
      /AGENT_TRANSACTIONS_INPUT_INVALID.*atx-1.*status/,
      'a status the machine does not know',
    );
    for (const d of bad) {
      const r = readRecords(d);
      assert.deepEqual(
        [r.complianceContexts.length, r.agentTransactions.length],
        [0, 0],
        'a refused fixture wrote nothing',
      );
    }
    rm(...bad);
  } finally {
    rm(dir);
  }
});

console.log(`\nagent transactions repository: ${passed} checks passed`);
