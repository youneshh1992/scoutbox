// Writes test/fixtures/transaction_cases.json: what the TypeScript transaction rules (domains/agents/transactions/
// transaction.mjs) answer for random inputs, so test/scoutbox/agents/transaction_rules_test.gleam can check the
// ported ones: the compliance state and the status it asks for, the Offer readiness, the party-revision hash, room
// roles, and which visibility classes a viewer may read and file into. Regenerate with
// `node dev/transaction_cases.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = await import(path.join(HERE, '../../../scoutbox/scoutbox-server/domains/agents/transactions/transaction.mjs'));

let seed = 20261118;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const some = (max, make) => Array.from({ length: Math.floor(rand() * (max + 1)) }, (_, i) => make(i));

const OUTCOMES = ['CLEAR', 'PERMITTED_DUAL_REPRESENTATION_CONSENT_REQUIRED', 'PROHIBITED_CONFLICT',
  'MANUAL_REGULATORY_REVIEW_REQUIRED', 'INSUFFICIENT_DATA', null];
const ROLES = ['individual', 'engaging_entity', 'releasing_entity'];
const STATES = ['VERIFIED', 'STALE', 'PENDING', 'UNVERIFIED'];

const party = () => {
  const partyRole = pick(ROLES);
  const club = partyRole !== 'individual';
  return {
    partyRole,
    subjectKind: club ? 'club' : 'player',
    subjectId: club ? pick(['org-a', 'org-b']) : pick(['pl-1', 'pl-2']),
    removed: rand() < 0.2,
    confirmedAt: rand() < 0.5 ? 1000 + Math.floor(rand() * 9) : null,
  };
};

const cases = [];
for (let i = 0; i < 400; i++) {
  const parties = some(4, party);
  const stateInput = {
    outcome: pick(OUTCOMES),
    gate: rand() < 0.15 ? pick(T.COMPLIANCE_GATES) : null,
    reasons: some(3, () => pick(['NO_REPRESENTATION', 'SINGLE_PARTY', 'NATIONAL_RULE_APPLIES'])),
    representationCount: Math.floor(rand() * 2),
    partiesConfirmed: rand() < 0.7,
  };
  const state = T.complianceStateFrom(stateInput);
  const readinessSeesState = rand() >= 0.1;
  const status = pick(T.TRANSACTION_STATUSES);
  const staleness = rand() < 0.3 ? pick(T.STALENESS_REASONS) : null;
  const viewer = pick([
    { kind: 'agency', orgId: pick(['agency-1', 'agency-2']), userId: pick(['usr-a', 'usr-b']), agencyAdmin: rand() < 0.5 },
    { kind: 'club', orgId: pick(['org-a', 'org-b', 'org-c']), userId: 'usr-c', signatory: rand() < 0.5 },
    { kind: 'player', playerId: pick(['pl-1', 'pl-2']) },
    { kind: 'ts_reviewer' },
  ]);
  const tx = { agencyOrgId: 'agency-1', agentUserId: 'usr-a', status, parties };
  const roles = T.roomRolesFor(tx, viewer);
  const partyRole = viewer.kind === 'club' ? T.clubPartyRoleOf(tx, viewer.orgId) : viewer.kind === 'player' ? 'individual' : null;
  const facetStates = {
    fifa_licence: pick(STATES),
    national_registration: Object.fromEntries(some(2, (k) => [['ENG', 'USA'][k], pick(STATES)])),
    domestic_authorisation: {},
    minors_authorisation: Object.fromEntries(some(1, () => ['ENG', pick(STATES)])),
  };
  const revisionInput = {
    parties,
    agentUserId: pick(['usr-a', 'usr-b']),
    representations: some(3, () => ({
      agentUserId: pick(['usr-a', 'usr-b']),
      partyRole: pick(ROLES),
      status: pick(['verified', 'pending_review', 'withdrawn']),
      agreementId: rand() < 0.5 ? 'rep-1' : null,
    })),
    consents: some(2, (k) => ({ id: `rcn-${k}`, status: pick(['requested', 'granted']) })),
    facetStates,
    policyVersions: some(2, (k) => ['jp-fifa-2025-1', 'jp-eng-2026-27-1'][k]),
    blockedSubjectIds: some(2, (k) => `pl-${k + 1}`),
    minorSubjectIds: some(1, () => 'pl-2'),
  };
  cases.push({
    stateInput,
    state: { outcome: state.outcome, reasonCodes: state.reasonCodes, pendingReason: state.pendingReason,
      blocked: state.blocked, clear: state.clear },
    statusFor: T.statusForComplianceState(state),
    status,
    staleness,
    readinessSeesState,
    readiness: (({ canStartOfferWorkflow, blockers }) => ({ canStartOfferWorkflow, blockers }))(
      T.offerReadiness(tx, { complianceState: readinessSeesState ? state : null, staleness }),
    ),
    viewer,
    roles,
    partyRole,
    canSee: T.DOCUMENT_VISIBILITY.filter((v) => T.canSeeVisibility(v, roles, partyRole)),
    uploadable: T.uploadableVisibilities(roles, partyRole),
    revisionInput,
    revision: T.partyRevisionOf(revisionInput),
  });
}
fs.writeFileSync(path.join(HERE, '../test/fixtures/transaction_cases.json'), `${JSON.stringify(cases)}\n`);
console.log(`transaction cases: wrote ${cases.length}`);
