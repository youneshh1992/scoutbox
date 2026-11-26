// The decision rules behind the decisions persistence battery (e2e/recruitment/decisionsPersistence.mjs), checked in
// this process over the battery's own decision records: the integrity check judges every defect the battery plants or
// refuses, duplicate final heads are named, and no legacy row is formal.
import {
  decisionIntegrity,
  duplicateFinalHeads,
  chainHead,
  isFormal,
} from '../../../domains/recruitment/lifecycle/decision.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('recruitment/decisionsPersistence');

const T0 = 1_800_000_000_000;
const BY = { userId: 'usr-owner', name: 'Owner', role: 'Head of Recruitment' };

const legacyRow = (over = {}) => ({
  id: 'rdec-legacy',
  roomId: 'case-x',
  orgId: 'org-x',
  playerId: 'pl-x',
  recommendation: 'shortlist',
  reasonCodes: ['tactical_fit'],
  note: 'Legacy opinion.',
  by: BY,
  createdAt: T0,
  trigger: 'decision',
  supersedes: null,
  supersededById: 'rdec-formal-1',
  clientKey: 'legacy-key',
  snapshot: null,
  ...over,
});
const formalRow = (over = {}) => ({
  id: 'rdec-formal-1',
  roomId: 'case-x',
  orgId: 'org-x',
  playerId: 'pl-x',
  kind: 'formal',
  state: 'final',
  outcome: 'progress',
  recommendation: 'offer',
  reasonCodes: ['position_need'],
  note: 'First formal.',
  by: BY,
  createdAt: T0 + 10,
  finalizedAt: T0 + 10,
  trigger: 'decision:finalize',
  clientKey: 'fin-1',
  supersedes: 'rdec-legacy',
  supersededById: 'rdec-formal-2',
  supersession: null,
  rev: 2,
  revAt: T0 + 20,
  evidenceRefs: [
    { kind: 'assessment', id: 'ass-1', meta: { scoutName: 'S', submittedAt: T0, verdict: 'sign', trialId: null } },
  ],
  assessmentSummary: {
    submitted: 1,
    withheld: 0,
    verdicts: { sign: 1, monitor: 0, pass: 0, none: 0 },
    assessmentIds: ['ass-1'],
  },
  snapshot: null,
  keys: { finalize: { key: 'fin-1', fp: '{"fixture":1}' }, draft: { key: 'draft-1', fp: '{"fixture":1}' } },
  draftId: 'rdraft-1',
  lifecycle: { action: 'considerOffer', from: 'shortlisted', to: 'offer_consideration', applied: true, at: T0 + 10 },
  policyVersion: 1,
  ...over,
});
const headRow = (over = {}) =>
  formalRow({
    id: 'rdec-formal-2',
    outcome: 'hold',
    recommendation: 'continue_watching',
    reasonCodes: ['timing'],
    note: 'Second formal.',
    createdAt: T0 + 20,
    finalizedAt: T0 + 20,
    clientKey: 'fin-2',
    supersedes: 'rdec-formal-1',
    supersededById: null,
    supersession: { of: 'rdec-formal-1', reason: 'Budget review.' },
    rev: 1,
    revAt: T0 + 20,
    evidenceRefs: [],
    assessmentSummary: {
      submitted: 1,
      withheld: 0,
      verdicts: { sign: 1, monitor: 0, pass: 0, none: 0 },
      assessmentIds: ['ass-1'],
    },
    keys: { finalize: { key: 'fin-2', fp: '{"fixture":2}' }, draft: null },
    draftId: 'rdraft-2',
    lifecycle: { action: 'holdCase', from: 'offer_consideration', to: 'on_hold', applied: true, at: T0 + 20 },
    ...over,
  });

section('3 — corrupt formal rows are named; duplicate heads are corruption, not a tie');
{
  const unstorable = [
    formalRow({ id: 'rdec-bad-outcome', outcome: 'accept', supersedes: null, supersededById: 'x1', createdAt: T0 + 1 }),
    formalRow({
      id: 'rdec-bad-proto',
      outcome: '__proto__',
      supersedes: null,
      supersededById: 'x1',
      createdAt: T0 + 2,
    }),
    formalRow({ id: 'rdec-bad-time', createdAt: 'yesterday', supersedes: null, supersededById: 'x1' }),
    formalRow({
      id: 'rdec-bad-reasons',
      reasonCodes: 'position_need',
      supersedes: null,
      supersededById: 'x1',
      createdAt: T0 + 4,
    }),
    formalRow({ id: 'rdec-bad-refs', evidenceRefs: {}, supersedes: null, supersededById: 'x1', createdAt: T0 + 6 }),
    formalRow({ id: 'rdec-bad-rev', rev: 0, supersedes: null, supersededById: 'x1', createdAt: T0 + 7 }),
  ];
  const bad = [
    formalRow({ id: 'rdec-bad-actor', by: null, supersedes: null, supersededById: 'x1', createdAt: T0 + 3 }),
    formalRow({
      id: 'rdec-bad-code',
      reasonCodes: ['race'],
      supersedes: null,
      supersededById: 'x1',
      createdAt: T0 + 5,
    }),
  ];
  for (const r of bad) r.supersededById = 'rdec-formal-2';
  neg(
    [...unstorable, ...bad].every((r) => decisionIntegrity(r, { orgId: 'org-x', caseId: 'case-x' }).length > 0) &&
      decisionIntegrity(headRow(), { orgId: 'org-x', caseId: 'case-x' }).length === 0,
    'the pure integrity check agrees row by row (all eight defects)',
  );
  const heads = [
    headRow({ id: 'rdec-head-a', supersedes: null }),
    headRow({ id: 'rdec-head-b', supersedes: null, createdAt: T0 + 21 }),
  ];
  neg(
    duplicateFinalHeads(heads).length === 2 && chainHead(heads).id === 'rdec-head-b',
    'the pure check names both heads (the chain reader alone would silently pick the later one)',
  );
}

section('4 — legacy advisory rows are never formal');
{
  const legacy = [
    legacyRow({ id: 'rdec-l1', createdAt: T0, supersededById: 'rdec-l2' }),
    legacyRow({
      id: 'rdec-l2',
      recommendation: 'offer',
      reasonCodes: [],
      note: null,
      createdAt: T0 + 1,
      supersedes: 'rdec-l1',
      supersededById: null,
    }),
    // An odd legacy row: no actor and no reason (a time and a reason list are typed columns, so a save refuses junk there).
    legacyRow({ id: 'rdec-l-odd', by: null, reasonCodes: [], supersededById: 'rdec-l1' }),
  ];
  neg(!legacy.some(isFormal), 'no legacy row is formal, whatever it recommends');
}

done();
