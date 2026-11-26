// Trust & Safety reviewers and jurisdiction policy versions (repositories/compliancePolicies.mjs, migration 0027): the
// STRICT tables and the three seeded policy versions, the typers' refusals, a reviewer created and revoked once, a
// version published once by a different reviewer (never by its proposer) and never changed after, and the published
// set re-read when it changes. Temporary databases only; nothing touches DATA_DIR. Run with: npm test

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../repositories/index.mjs';
import { openLayer, readRecords } from './dataLayerFixture.mjs';
import { NOW, TTL, tempDir } from './coreIdentityTestFixtures.mjs';
import { saveFixture } from './recruitmentTestFixtures.mjs';
import {
  COMPLIANCE_POLICIES_MIGRATION as MIGRATION,
  COMPLIANCE_POLICIES_TABLES as TABLES,
  COMPLIANCE_POLICIES_COLLECTIONS as COLLECTIONS,
  typeReviewer,
  typePolicy,
  seededPolicyRecords,
} from '../repositories/compliancePolicies.mjs';
import { SEEDED_POLICY_VERSIONS, RULE_PARAMS, typeRuleParams } from '../domains/agents/compliance/policyVersions.mjs';

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
const SYSTEM = { kind: 'system', userId: null, name: 'dev seed' };
const byReviewer = (id, role = 'trust_safety_admin') => ({ kind: 'ts_reviewer', userId: id, name: `Name ${id}`, role });
/** createReviewer (domains/agents/compliance/reviewers.mjs): the dev seed, the bootstrap and POST /ts/reviewers. */
const reviewer = (over = {}) => ({
  id: 'tsr-a',
  name: 'Priya Shah',
  role: 'trust_safety_admin',
  status: 'active',
  secretHash: 'scrypt$abc$def',
  createdAt: NOW,
  createdBy: SYSTEM,
  revokedAt: null,
  revokedBy: null,
  rev: 1,
  revAt: NOW,
  revBy: null,
  history: [
    {
      id: `aud-${over.id ?? 'tsr-a'}-c`,
      at: NOW,
      action: 'reviewer_created',
      by: over.createdBy ?? SYSTEM,
      detail: { role: over.role ?? 'trust_safety_admin' },
    },
  ],
  ...over,
});
const src = {
  source: 'The FA Football Agent Regulations 2026-27',
  version: '2026-27',
  effectiveDate: '2026-06-01',
  retrievedDate: '2026-09-18',
};
/** POST /ts/compliance/policies. */
const proposal = (over = {}) => ({
  id: 'jp-eng-2027-1',
  regulator: 'FA',
  jurisdiction: 'ENG',
  policyVersion: 2,
  supersedes: null,
  effectiveFrom: '2027-06-01',
  effectiveTo: null,
  rules: {
    'ENG-6.3': {
      ruleStatus: 'ACTIVE',
      textStatus: 'CURRENT',
      sourceRef: [src],
      params: { permittedMultiple: true, excludedRole: 'releasing_entity', consentKind: 'dual_representation' },
      note: 'Dual representation.',
    },
    'ENG-5.1': {
      ruleStatus: 'ACTIVE',
      textStatus: null,
      sourceRef: [{ source: 'FA', retrievedDate: '2026-09-18' }],
      params: { formula: 'academic_year_16', academicYearStart: '09-01' },
      note: null,
    },
  },
  status: 'proposed',
  proposedBy: { id: 'tsr-a', name: 'Priya Shah', at: NOW },
  approvedBy: null,
  publishedAt: null,
  publishedBy: null,
  createdAt: NOW,
  rev: 1,
  revAt: NOW,
  revBy: null,
  history: [
    {
      id: 'aud-pp1',
      at: NOW,
      action: 'policy_version_proposed',
      by: byReviewer('tsr-a'),
      detail: { policyVersion: 'jp-eng-2027-1' },
    },
  ],
  ...over,
});

function serverOpen(dir) {
  const L = openLayer(dir, { nextId, sessionTtlMs: TTL, now: () => NOW });
  return { store: L.store, repo: L.layer.compliancePolicies, unit: L.unit, close: L.close };
}

// ------------------------------------------------------------- schema
test('[schema] 0027 is registered after 0026, creates the ten STRICT tables (no JSON column) and inserts the seeded policy versions, read back exactly', () => {
  const ids = DATA_MIGRATIONS.map((m) => m.id);
  assert.equal(ids.indexOf(MIGRATION), ids.indexOf('0026_agent_core') + 1);
  assert.equal(TABLES.length, 10);
  for (const n of COLLECTIONS) assert.ok(TABLE_BACKED.includes(n), `${n} is table-backed`);
  const dir = tempDir('s11b1-empty');
  const s = openLayer(dir).sqlite;
  for (const t of TABLES) {
    assert.match(
      s.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t).sql,
      /STRICT\s*$/,
      `${t} is STRICT`,
    );
    assert.ok(
      !s
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .some((c) => /_json$/.test(c.name)),
      `${t}: no JSON column`,
    );
  }
  assert.equal(s.prepare('SELECT count(*) AS n FROM ts_reviewers').get().n, 0, 'no reviewer is invented');
  const back = readRecords(dir).jurisdictionPolicies;
  assert.deepEqual(
    back.map((p) => p.id),
    SEEDED_POLICY_VERSIONS.map((v) => v.id),
  );
  for (const v of SEEDED_POLICY_VERSIONS) {
    const p = back.find((x) => x.id === v.id);
    assert.deepEqual(
      p.rules,
      JSON.parse(JSON.stringify(v.rules)),
      `${v.id}: rules, sources, parameters (lists, role sets, the empty age map) and overrides read back exactly, in order`,
    );
    assert.deepEqual(Object.keys(p.rules), Object.keys(v.rules), `${v.id}: rule order kept (the engine searches it)`);
    assert.equal(p.status, 'published');
    assert.deepEqual(p.publishedBy, v.publishedBy);
    assert.equal(p.history[0].by.name, `migration ${MIGRATION}`);
    assert.deepEqual(p.history[0].detail, { policyVersion: v.id, seeded: true });
  }
  s.close();
  rm(dir);
});

// ------------------------------------------------------------- typing
test('[typing] the typers refuse junk with the record and field named', () => {
  assert.equal(typeReviewer(reviewer()).ok, true);
  assert.match(typeReviewer(reviewer({ status: 'enabled' })).reason, /tsr-a\.status must be one of active\|revoked/);
  assert.match(
    typeReviewer(reviewer({ secret: 'plain' })).reason,
    /does not store: secret/,
    'a plain secret is never a field',
  );
  assert.match(typeReviewer(reviewer({ status: 'revoked' })).reason, /revokedAt is set, with revokedBy, exactly when/);
  assert.match(
    typeReviewer(reviewer({ createdBy: { kind: 'ts_reviewer', userId: null, name: 'x' } })).reason,
    /createdBy/,
  );
  for (const v of seededPolicyRecords(NOW)) assert.equal(typePolicy(v).ok, true, `${v.id} types`);
  assert.equal(typePolicy(proposal()).ok, true);
  const t = (over) => typePolicy(proposal(over));
  const rule = (r) => ({ rules: { 'ENG-6.3': { ...proposal().rules['ENG-6.3'], ...r } } });
  assert.deepEqual(
    [
      t(rule({ params: { permittedMultpile: true } })).field,
      t(rule({ params: { permittedMultpile: true } })).reason.includes('not a parameter this build reads'),
    ],
    ['rules.ENG-6.3.params.permittedMultpile', true],
    'a misspelt parameter is refused, named',
  );
  assert.equal(
    t(rule({ params: { exclusivityWindowMonths: '2' } })).field,
    'rules.ENG-6.3.params.exclusivityWindowMonths',
    'a count given as text',
  );
  assert.equal(
    t(rule({ params: { consentKind: 'dual' } })).field,
    'rules.ENG-6.3.params.consentKind',
    'an unknown consent kind',
  );
  assert.equal(
    t(rule({ params: { permittedSets: [['individual', 'agent']] } })).field,
    'rules.ENG-6.3.params.permittedSets',
    'a role set naming a role that does not exist',
  );
  assert.equal(t(rule({ params: { firstContractAge: { ENG: '16' } } })).field, 'rules.ENG-6.3.params.firstContractAge');
  assert.equal(t(rule({ params: { academicYearStart: '13-01' } })).field, 'rules.ENG-6.3.params.academicYearStart');
  assert.equal(
    t(rule({ sourceRef: [{ source: 'FA', retrievedDate: '2026-02-30' }] })).field,
    'rules.ENG-6.3.sourceRef',
    'a source retrieved on a day that does not exist',
  );
  assert.equal(
    t(
      rule({
        overrides: [
          { jurisdiction: 'ENG', scope: 'national', overrideRuleId: 'x' },
          { jurisdiction: 'ENG', scope: 'national', overrideRuleId: 'y' },
        ],
      }),
    ).field,
    'rules.ENG-6.3.overrides',
  );
  assert.equal(
    t(rule({ overrides: [{ jurisdiction: 'ENG', scope: 'regional', overrideRuleId: 'x' }] })).field,
    'rules.ENG-6.3.overrides',
  );
  assert.equal(t(rule({ textStatus: 'MAYBE' })).field, 'rules.ENG-6.3');
  assert.equal(t(rule({ priority: 1 })).field, 'rules.ENG-6.3', 'an unknown rule field');
  assert.equal(t({ effectiveFrom: '2027-02-29' }).field, 'effectiveFrom');
  assert.equal(t({ effectiveTo: '2027-01-01' }).field, 'effectiveTo', 'an end before the start');
  assert.equal(t({ jurisdiction: 'FRA' }).field, 'jurisdiction');
  assert.equal(t({ supersedes: 'jp-eng-2027-1' }).field, 'supersedes', 'a version cannot supersede itself');
  assert.equal(
    t({
      status: 'published',
      publishedAt: NOW,
      approvedBy: { id: 'tsr-a', name: 'Priya', at: NOW },
      publishedBy: [{ kind: 'ts_reviewer', id: 'tsr-a', name: 'Priya' }],
    }).field,
    'approvedBy',
    'dual control: the approver is not the proposer',
  );
  assert.equal(t({ status: 'published', publishedAt: null }).field, 'status');
  // The vocabulary is the engine's: every seeded parameter name is in it, and its typer copies what it accepts.
  for (const v of SEEDED_POLICY_VERSIONS)
    for (const r of Object.values(v.rules))
      for (const k of Object.keys(r.params)) assert.ok(Object.hasOwn(RULE_PARAMS, k), k);
  const deep = { permittedSets: [['individual', 'engaging_entity']] };
  const typed = typeRuleParams(deep);
  typed.params.permittedSets[0].push('x');
  assert.deepEqual(deep.permittedSets[0], ['individual', 'engaging_entity'], 'the typer returns a copy');
});

// ------------------------------------------------------------- writes and reads
test('[reviewers] a reviewer is created active and read back; identity and secret never change; a revocation is final; one id each', () => {
  const dir = tempDir('s11b1-reviewers');
  saveFixture(dir);
  const s = serverOpen(dir);
  const R = s.repo.reviewers;
  try {
    const a = R.create(reviewer());
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.history[0]), 'deep-frozen');
    assert.equal(R.activeById('tsr-a').id, 'tsr-a');
    assert.equal(R.activeCount('trust_safety_admin'), 1);
    assert.equal(R.count(), 1);
    R.create(reviewer({ id: 'tsr-b', name: 'Marcus', role: 'trust_safety_reviewer', createdBy: byReviewer('tsr-a') }));
    assert.deepEqual(R.byId('tsr-b').createdBy, byReviewer('tsr-a'), 'the creating reviewer and their role are kept');
    refused(() => R.create(reviewer()), /already exists/, 'duplicate id');
    refused(
      () =>
        R.create(
          reviewer({
            id: 'tsr-c',
            status: 'revoked',
            revokedAt: NOW,
            revokedBy: { id: 'tsr-a', name: 'x' },
            history: [],
          }),
        ),
      /created active/,
      'created revoked',
    );
    const revokedBy = { id: 'tsr-a', name: 'Priya Shah' };
    const revocation = (id) => ({
      history: [{ id, at: NOW, action: 'reviewer_revoked', by: byReviewer('tsr-a'), detail: { reason: null } }],
      bump: { at: NOW, by: revokedBy },
    });
    refused(
      () => R.revoke('tsr-b', { at: NOW, by: { id: 'tsr-zz', name: 'Ghost' } }, revocation('aud-rz')),
      /COMPLIANCE_POLICIES_INPUT_INVALID: ts_reviewers tsr-b/,
      'a revoker who is not a reviewer',
    );
    assert.equal(R.byId('tsr-b').status, 'active', 'a refused revocation wrote nothing');
    refused(
      () =>
        R.revoke(
          'tsr-b',
          { at: NOW, by: revokedBy },
          { history: [{ ...revocation('aud-rx').history[0], action: 'reviewer_promoted' }] },
        ),
      /COMPLIANCE_POLICIES_INPUT_INVALID/,
      'an unknown history action',
    );
    const rv = R.revoke('tsr-b', { at: NOW, by: revokedBy }, revocation('aud-rv'));
    assert.equal(rv.status, 'revoked');
    assert.equal(rv.rev, 2);
    assert.deepEqual(rv.revokedBy, revokedBy);
    assert.deepEqual(rv.revBy, { userId: 'tsr-a', name: 'Priya Shah' });
    assert.deepEqual(rv.history.slice(0, -1), R.byId('tsr-b').history.slice(0, -1), 'the stored history is kept');
    assert.equal(rv.history.at(-1).id, 'aud-rv', 'the history grows by the act');
    assert.equal(R.activeById('tsr-b'), null, 'a revoked reviewer is not active');
    refused(
      () => R.revoke('tsr-b', { at: NOW + 1, by: revokedBy }, revocation('aud-rv2')),
      /COMPLIANCE_POLICIES_STATE_CONFLICT: ts_reviewers tsr-b: a revocation is final/,
    );
    refused(
      () => R.revoke('tsr-a', { at: NOW, by: revokedBy }, revocation('aud-rv')),
      /COMPLIANCE_POLICIES_DUPLICATE: history entry aud-rv already exists/,
    );
    refused(() => R.revoke('tsr-none', { at: NOW, by: revokedBy }), /COMPLIANCE_POLICIES_NOT_FOUND/);
  } finally {
    s.close();
    rm(dir);
  }
});

test('[policies] a version is proposed, published once by a different reviewer, and never changes; supersedes names an existing version of its jurisdiction; the published set follows', () => {
  const dir = tempDir('s11b1-policies');
  saveFixture(dir);
  const s = serverOpen(dir);
  const { reviewers: R, policies: P } = s.repo;
  try {
    R.create(reviewer());
    R.create(reviewer({ id: 'tsr-b', name: 'Léa' }));
    const before = P.published();
    assert.deepEqual(
      before.map((p) => p.id),
      SEEDED_POLICY_VERSIONS.map((v) => v.id),
    );
    assert.equal(P.published(), before, 'unchanged: the same decoded list');
    refused(
      () => P.create(proposal({ supersedes: 'jp-fifa-2025-1' })),
      /supersedes must name an existing version of ENG/,
      "another jurisdiction's version",
    );
    refused(
      () => P.create(proposal({ supersedes: 'jp-eng-1999-1' })),
      /supersedes must name an existing version/,
      'a version that does not exist',
    );
    refused(
      () => P.create(proposal({ proposedBy: { id: 'tsr-zz', name: 'Ghost', at: NOW } })),
      /proposer tsr-zz is not a reviewer/,
    );
    const p = P.create(proposal({ supersedes: 'jp-eng-2026-27-1' }));
    assert.equal(p.status, 'proposed');
    assert.equal(p.publishedBy, null);
    assert.deepEqual(
      p.rules['ENG-5.1'].sourceRef,
      [{ source: 'FA', version: null, effectiveDate: null, retrievedDate: '2026-09-18' }],
      "a source's optional fields read back as null",
    );
    assert.equal(P.published(), before, 'a proposal is not in force');
    refused(
      () =>
        P.create(
          proposal({
            id: 'jp-eng-2027-2',
            history: [],
            status: 'published',
            publishedAt: NOW,
            approvedBy: { id: 'tsr-b', name: 'Léa', at: NOW },
            publishedBy: [
              { kind: 'ts_reviewer', id: 'tsr-a', name: 'P' },
              { kind: 'ts_reviewer', id: 'tsr-b', name: 'L' },
            ],
          }),
        ),
      /proposed first/,
      'created published',
    );
    const publication = (id, at) => ({
      history: [
        { id, at, action: 'policy_version_published', by: byReviewer('tsr-b'), detail: { policyVersion: p.id } },
      ],
      bump: { at, by: { id: 'tsr-b', name: 'Léa' } },
    });
    refused(
      () =>
        P.publish(
          p.id,
          { at: NOW + 1, approvedBy: { id: 'tsr-a', name: 'Priya Shah' } },
          publication('aud-ppx', NOW + 1),
        ),
      /COMPLIANCE_POLICIES_STATE_CONFLICT: .*by a reviewer other than its proposer/,
      'the proposer cannot approve their own version',
    );
    refused(
      () =>
        P.publish(p.id, { at: NOW + 1, approvedBy: { id: 'tsr-zz', name: 'Ghost' } }, publication('aud-ppx', NOW + 1)),
      /COMPLIANCE_POLICIES_INPUT_INVALID: jurisdiction_policies jp-eng-2027-1/,
      'an approver who is not a reviewer',
    );
    assert.equal(P.byId(p.id).status, 'proposed', 'a refused publication wrote nothing');
    const pub = P.publish(
      p.id,
      { at: NOW + 1, approvedBy: { id: 'tsr-b', name: 'Léa' } },
      publication('aud-pp2', NOW + 1),
    );
    assert.deepEqual(pub.approvedBy, { id: 'tsr-b', name: 'Léa', at: NOW + 1 });
    assert.equal(pub.publishedAt, NOW + 1);
    assert.deepEqual(pub.publishedBy, [
      { kind: 'ts_reviewer', id: 'tsr-a', name: 'Priya Shah' },
      { kind: 'ts_reviewer', id: 'tsr-b', name: 'Léa' },
    ]);
    assert.equal(pub.rev, 2);
    assert.equal(pub.history.at(-1).id, 'aud-pp2');
    assert.deepEqual(pub.rules, p.rules, 'publication leaves the content as proposed');
    assert.equal(pub.status, 'published');
    assert.equal(pub.publishedBy.length, 2);
    const after = P.published();
    assert.notEqual(after, before);
    assert.deepEqual(
      after.map((x) => x.id),
      [...before.map((x) => x.id), p.id],
      'the published set is re-read when a version is published',
    );
    refused(
      () => P.publish(p.id, { at: NOW + 5, approvedBy: { id: 'tsr-b', name: 'Léa' } }, publication('aud-pp3', NOW + 5)),
      /COMPLIANCE_POLICIES_STATE_CONFLICT/,
      'a published version never changes',
    );
    assert.equal(P.byId(p.id).publishedAt, NOW + 1);
    assert.equal(P.exists(p.id), true);
    assert.equal(P.exists('jp-none-1'), false);
    assert.equal(P.exists(null), false);
  } finally {
    s.close();
    rm(dir);
  }
});

test('[units] a rolled-back unit leaves nothing (and the published set follows the rollback)', () => {
  const dir = tempDir('s11b1-units');
  saveFixture(dir);
  const s = serverOpen(dir);
  const { reviewers: R, policies: P } = s.repo;
  try {
    R.create(reviewer());
    R.create(reviewer({ id: 'tsr-b', name: 'Léa' }));
    P.create(proposal());
    const before = P.published().map((x) => x.id);
    refused(
      () =>
        s.unit(() => {
          P.publish('jp-eng-2027-1', { at: NOW, approvedBy: { id: 'tsr-b', name: 'Léa' } });
          assert.equal(P.published().length, before.length + 1, 'inside the unit the publication is visible');
          R.create(reviewer({ id: 'tsr-c', name: 'C', history: [] }));
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(P.byId('jp-eng-2027-1').status, 'proposed');
    assert.equal(R.byId('tsr-c'), null);
    assert.deepEqual(
      P.published().map((x) => x.id),
      before,
      'after the rollback the published set is the stored one',
    );
  } finally {
    s.close();
    rm(dir);
  }
});

test('[fixtures] a record written through the repository is typed, refuses a reviewer the table cannot hold (naming it) and a missing superseded version, and reads back what it wrote', () => {
  const dir = tempDir('s11b1-fix');
  try {
    const a = reviewer();
    const b = reviewer({ id: 'tsr-b', name: 'Léa' });
    saveFixture(dir, { tsReviewers: [a, b], jurisdictionPolicies: [proposal({ supersedes: 'jp-eng-2026-27-1' })] });
    const s = serverOpen(dir); // a reviewer is created active; the revocation is the route's update
    try {
      s.unit(() =>
        s.repo.reviewers.revoke(
          'tsr-b',
          { at: NOW, by: { id: 'tsr-a', name: 'Priya' } },
          {
            history: [
              { id: 'aud-rv', at: NOW, action: 'reviewer_revoked', by: byReviewer('tsr-a'), detail: { reason: null } },
            ],
            bump: { at: NOW, by: { id: 'tsr-a', name: 'Priya Shah' } },
          },
        ),
      );
    } finally {
      s.close();
    }
    const back = readRecords(dir);
    assert.deepEqual(back.tsReviewers.map((r) => [r.id, r.status, r.revokedBy?.id ?? null]).sort(), [
      ['tsr-a', 'active', null],
      ['tsr-b', 'revoked', 'tsr-a'],
    ]);
    assert.deepEqual(
      back.tsReviewers.find((r) => r.id === 'tsr-a'),
      typeReviewer(a).record,
    );
    assert.equal(back.jurisdictionPolicies.length, 4, 'the three seeded versions and the proposal');
    const bad = [tempDir('s11b1-fix-odd'), tempDir('s11b1-fix-sup')];
    const e = refused(
      () => saveFixture(bad[0], { tsReviewers: [a, reviewer({ id: 'tsr-odd', status: 'enabled' })] }),
      /COMPLIANCE_POLICIES_INPUT_INVALID.*tsr-odd\.status/,
    );
    assert.equal(e.code, 'COMPLIANCE_POLICIES_INPUT_INVALID');
    refused(
      () => saveFixture(bad[1], { tsReviewers: [a], jurisdictionPolicies: [proposal({ supersedes: 'jp-eng-none' })] }),
      /jp-eng-2027-1: supersedes must name an existing version of ENG/,
      'a superseded version that does not exist',
    );
    for (const d of bad) {
      const r = readRecords(d);
      assert.equal(r.tsReviewers.length, 0, 'a refused fixture wrote nothing');
      assert.equal(r.jurisdictionPolicies.length, 3);
    }
    rm(...bad);
  } finally {
    rm(dir);
  }
});

console.log(`\ncompliance policies repository: ${passed} checks passed`);
