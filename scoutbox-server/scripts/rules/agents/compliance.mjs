// The conflict and compliance engine's rules behind the agent compliance battery (e2e/agents/compliance.mjs), checked
// in this process: policy versions and rule statuses, jurisdiction resolution, the verification provider, the action
// against the agreement, the conflict engine, the minors gate, and the error contract, permissions, registry,
// notifications, rate policies and declared stores.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SEEDED_POLICY_VERSIONS, RULE_STATUSES } from '../../../domains/agents/compliance/policyVersions.mjs';
import {
  selectPolicyVersion,
  applicablePolicySet,
  ruleAt,
  resolveScope,
  evaluatePolicy,
  evaluateMinorGate,
  earliestPermittedApproachAt,
  isRegulatoryMinor,
  representationScopeProblem,
  MINOR_PATHWAY_PRODUCTION_ENABLED,
  POLICY_FACETS,
} from '../../../domains/agents/compliance/policy.mjs';
import {
  evaluateConflict,
  consentSufficiency,
  CONFLICT_OUTCOMES,
  PERMITTED_WITH_CONSENT,
  OUTCOME_ALIASES,
  conflictSummaryForParty,
  inputHashOf,
  mostSevere,
} from '../../../domains/agents/compliance/conflict.mjs';
import {
  createVerificationProvider,
  facetFromProviderAnswer,
  PROVIDER_STATES,
} from '../../../domains/agents/compliance/provider.mjs';
import {
  COMPLIANCE_ERROR_HTTP,
  PUBLIC_ERROR_FIELDS,
  publicErrorBody,
} from '../../../domains/agents/compliance/errors.mjs';
import { COMPLIANCE_AUDIT_ACTIONS } from '../../../domains/agents/compliance/audit.mjs';
import { PERMISSIONS, can, FACETS } from '../../../domains/agents/core/shared.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../../../domains/platform/notificationPrefs.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../../repositories/index.mjs';
import {
  COMPLIANCE_POLICIES_MIGRATION,
  COMPLIANCE_POLICIES_TABLES,
} from '../../../repositories/compliancePolicies.mjs';
import { COMPLIANCE_RECORDS_MIGRATION, COMPLIANCE_RECORDS_TABLES } from '../../../repositories/complianceRecords.mjs';
import { readRecords } from '../../dataLayerFixture.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, fail, section, done } = rulesSuite('agents/compliance');
const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
const T0 = Date.UTC(2026, 8, 18);
const DAY = 86_400_000;
const codes = (r) => (r.reasons ?? []).map((x) => x.code);

section('C/D — policy versioning and rule statuses');
{
  const rows = SEEDED_POLICY_VERSIONS;
  ok(
    RULE_STATUSES.length === 7 &&
      [
        'ACTIVE',
        'SUSPENDED',
        'PARTIALLY_SUSPENDED',
        'JURISDICTION_OVERRIDE',
        'PENDING_IMPLEMENTATION',
        'UNDER_LEGAL_REVIEW',
        'UNKNOWN',
      ].every((s) => RULE_STATUSES.includes(s)),
    'D1 the seven frozen rule statuses, exactly',
  );
  ok(
    rows.length === 3 && rows.map((r) => r.id).join() === 'jp-fifa-2025-1,jp-eng-2026-27-1,jp-usa-2024-1',
    'C1 three seeded versions: FIFA 2025, England 2026-27, USA 2024',
  );
  ok(
    rows.every((r) =>
      Object.values(r.rules).every(
        (x) =>
          RULE_STATUSES.includes(x.ruleStatus) &&
          Array.isArray(x.sourceRef) &&
          x.sourceRef.length &&
          x.sourceRef.every((s) => s.source && s.version && s.retrievedDate === '2026-09-18'),
      ),
    ),
    'C2 every rule carries a status and a source reference with version and retrieval date',
  );
  ok(
    rows.every((r) => Object.values(r.rules).every((x) => x.textStatus)),
    'C3 rule TEXT status is recorded separately from operative status on every rule',
  );
  const fifa = rows[0];
  neg(
    fifa.rules['FIFA-12.8'].ruleStatus === 'UNDER_LEGAL_REVIEW' &&
      fifa.rules['FIFA-12.8'].textStatus === 'UNCERTAIN_OPERATIVE_STATUS' &&
      /Circular 1873/.test(fifa.rules['FIFA-12.8'].note),
    'C4 FFAR 12(8) text is current, operative status UNDER_LEGAL_REVIEW, and the note quotes the tension — not ACTIVE because the text exists',
  );
  neg(
    fifa.rules['FIFA-19'].ruleStatus === 'SUSPENDED' &&
      fifa.rules['FIFA-RSTP-2027'].ruleStatus === 'PENDING_IMPLEMENTATION' &&
      rows[1].rules['ENG-7.13'].ruleStatus === 'PARTIALLY_SUSPENDED' &&
      rows[2].rules['USA-MULTI'].ruleStatus === 'UNKNOWN',
    'C5 SUSPENDED, PENDING_IMPLEMENTATION, PARTIALLY_SUSPENDED and UNKNOWN each appear in the seeded content',
  );
  ok(
    selectPolicyVersion(rows, 'ENG', T0)?.id === 'jp-eng-2026-27-1' &&
      selectPolicyVersion(rows, 'INT', T0)?.id === 'jp-fifa-2025-1',
    'C6 the version in effect on 18 Sep 2026 is selected per jurisdiction',
  );
  neg(
    selectPolicyVersion(rows, 'ENG', Date.UTC(2026, 4, 31)) === null,
    'C7 before 1 June 2026 no England version is in effect (nothing is back-dated)',
  );
  const v2 = {
    ...fifa,
    id: 'jp-fifa-2025-2',
    policyVersion: 2,
    supersedes: 'jp-fifa-2025-1',
    effectiveFrom: '2026-10-01',
    status: 'published',
  };
  ok(
    selectPolicyVersion([...rows, v2], 'INT', T0)?.id === 'jp-fifa-2025-1' &&
      selectPolicyVersion([...rows, v2], 'INT', Date.UTC(2026, 9, 2))?.id === 'jp-fifa-2025-2',
    'C8 a later version applies only from its own effective date',
  );
  neg(
    selectPolicyVersion([...rows, { ...v2, status: 'proposed', effectiveFrom: '2026-01-01' }], 'INT', T0)?.id ===
      'jp-fifa-2025-1',
    'C9 a PROPOSED version never applies — publication needs dual control',
  );
  const set = applicablePolicySet(rows, ['ENG', 'FRA'], T0);
  ok(
    set.policies.map((p) => p.id).join() === 'jp-fifa-2025-1,jp-eng-2026-27-1' && set.missing.join() === 'FRA',
    'C10 the applicable set is FIFA plus every national entry; a missing entry is reported, never skipped',
  );
  ok(
    ruleAt(set.policies, 'ENG-6.3', T0).status === 'ACTIVE' &&
      ruleAt(set.policies, 'FIFA-12.8', T0).status === 'UNDER_LEGAL_REVIEW' &&
      ruleAt(set.policies, 'NOPE-1', T0).status === 'UNKNOWN',
    'D2 rule lookup stamps the status; an unknown rule is UNKNOWN',
  );
  neg(
    ruleAt(set.policies, 'FIFA-RSTP-2027', T0).status === 'PENDING_IMPLEMENTATION' &&
      ruleAt(set.policies, 'FIFA-RSTP-2027', Date.UTC(2027, 0, 2)).status === 'ACTIVE',
    'D3 an announced rule is PENDING_IMPLEMENTATION before its effective date and applies after',
  );
}

// ============================================================ E/F — scope and unsupported jurisdiction (pure)
section('E/F — jurisdiction resolution; an unsupported jurisdiction never allows');
{
  ok(
    resolveScope([{ memberAssociation: 'ENG' }, { memberAssociation: 'ENG' }]).scope === 'national' &&
      resolveScope(['ENG']).nationalMa === 'ENG',
    'E1 one national association → national scope',
  );
  ok(
    resolveScope([{ memberAssociation: 'INT' }]).scope === 'international' &&
      resolveScope(['ENG', 'USA']).scope === 'international',
    'E2 INT, or more than one MA → international dimension',
  );
  neg(
    resolveScope([]).scope === 'unknown' && resolveScope(null).scope === 'unknown',
    'E3 nothing supplied → unknown (never guessed)',
  );
  const fra = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['FRA'], T0);
  const facets = {
    fifa_licence: 'VERIFIED',
    national_registration: { ENG: 'VERIFIED' },
    domestic_authorisation: {},
    minors_authorisation: {},
  };
  const d = evaluatePolicy({
    action: 'approach_adult',
    memberAssociations: ['FRA'],
    facets,
    policySet: fra.policies,
    missingPolicies: fra.missing,
    now: T0,
  });
  neg(
    d.allowed === false && d.requiresManualReview === true && codes(d).includes('POLICY_NOT_ENCODED'),
    'F1 a jurisdiction with no encoded policy → manual review, never allowed',
  );
  const r = evaluateConflict({
    transaction: {
      id: 't',
      type: 'transfer',
      jurisdictions: [{ memberAssociation: 'FRA' }],
      parties: [],
      representations: [],
    },
    agents: {},
    policySet: fra.policies,
    missingPolicies: fra.missing,
    now: T0,
  });
  neg(
    r.outcome === 'INSUFFICIENT_DATA' && codes(r).includes('POLICY_NOT_ENCODED'),
    'F2 the conflict engine answers INSUFFICIENT_DATA for it',
  );
  const usa = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['USA'], T0);
  const du = evaluatePolicy({
    action: 'approach_adult',
    memberAssociations: ['USA'],
    facets,
    policySet: usa.policies,
    missingPolicies: usa.missing,
    now: T0,
  });
  neg(
    du.allowed === false &&
      du.requiresDomesticAuthorisation === true &&
      du.facetGaps[0]?.code === 'AGENT_DOMESTIC_AUTHORISATION_REQUIRED',
    'F3 USA: the ACTIVE background-check/SafeSport rule requires a separate domestic_authorisation facet — a FIFA licence alone is not enough',
  );
  ok(
    evaluatePolicy({
      action: 'approach_adult',
      memberAssociations: ['USA'],
      facets: { ...facets, domestic_authorisation: { USA: 'VERIFIED' } },
      policySet: usa.policies,
      missingPolicies: usa.missing,
      now: T0,
    }).allowed === true,
    'F4 with it VERIFIED, an adult approach in the USA is allowed under the encoded rules',
  );
  neg(
    evaluatePolicy({ action: 'bribe', memberAssociations: ['ENG'], facets, policySet: [], now: T0 }).blocked === true,
    'F5 an unknown action is blocked',
  );
}

// ============================================================ G/H/I — provider (pure)
section('G/H/I — the fail-honest provider abstraction');
{
  ok(
    PROVIDER_STATES.join() === 'VERIFIED,NOT_VERIFIED,INACTIVE,STALE,UNAVAILABLE,MANUAL_REVIEW_REQUIRED',
    'G1 the six provider states',
  );
  const none = createVerificationProvider({});
  neg(
    none.id === 'none' &&
      none.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).state === 'MANUAL_REVIEW_REQUIRED' &&
      none.status().live === false &&
      none.status().registers.fifa === 'not_connected',
    'G2 production has NO provider: even a TEST reference is manual review; the status says no register is connected',
  );
  const syn = createVerificationProvider({ synthetic: true });
  ok(
    syn.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).state === 'VERIFIED' &&
      syn.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).provenance.provider ===
        'local-synthetic-test-provider',
    'G3 the synthetic provider verifies its own tagged references and names itself',
  );
  neg(
    syn.verifyNationalRegistration({ reference: 'FA-12345', now: T0 }).state === 'MANUAL_REVIEW_REQUIRED',
    'G4 a real-looking reference is still manual review with the synthetic provider',
  );
  neg(
    syn.verifyFifaLicence({ reference: 'TEST-STALE-1', now: T0 }).state === 'STALE' &&
      facetFromProviderAnswer(syn.verifyFifaLicence({ reference: 'TEST-STALE-1', now: T0 }), {
        reference: 'x',
        now: T0,
      }).recheckAt < T0,
    'H1 STALE stores a VERIFIED facet whose recheck date has already passed — it reads STALE, never VERIFIED',
  );
  neg(
    syn.verifyDomesticAuthorisation({ reference: 'TEST-UNAVAILABLE-1', now: T0 }).state === 'UNAVAILABLE' &&
      facetFromProviderAnswer(syn.verifyDomesticAuthorisation({ reference: 'TEST-UNAVAILABLE-1', now: T0 }), {
        reference: 'x',
        now: T0,
      }) === null,
    'I1 UNAVAILABLE writes NOTHING to a facet',
  );
  neg(
    syn.verifyMinorAuthorisation({ reference: 'TEST-NOTVERIFIED-1', now: T0 }).state === 'NOT_VERIFIED' &&
      facetFromProviderAnswer(syn.verifyMinorAuthorisation({ reference: 'TEST-NOTVERIFIED-1', now: T0 }), {
        reference: 'x',
        now: T0,
      }).state === 'UNVERIFIED',
    'I2 NOT_VERIFIED stores UNVERIFIED, never INACTIVE and never VERIFIED',
  );
  ok(
    FACETS.length === 4 &&
      POLICY_FACETS.join() === 'fifa_licence,national_registration,domestic_authorisation,minors_authorisation',
    'I3 four separate facets: licence, national registration, domestic authorisation, minors authorisation',
  );
}

// ============================================================ J — representation scope (pure)
section('J — the action must fit the agreement');
{
  const ag = { id: 'r1', scope: ['employment'], jurisdiction: 'ENG' };
  ok(
    representationScopeProblem({
      agreement: ag,
      effectiveStatus: 'active',
      confirmed: true,
      contextType: 'employment_contract',
      memberAssociations: ['ENG'],
    }) === null,
    'J1 an active confirmed ENG employment agreement covers an ENG employment contract',
  );
  neg(
    representationScopeProblem({
      agreement: null,
      effectiveStatus: null,
      confirmed: false,
      contextType: 'employment_contract',
    })?.error === 'REPRESENTATION_REQUIRED',
    'J2 no agreement → REPRESENTATION_REQUIRED',
  );
  neg(
    representationScopeProblem({
      agreement: ag,
      effectiveStatus: 'expired',
      confirmed: true,
      contextType: 'employment_contract',
      memberAssociations: ['ENG'],
    })?.error === 'REPRESENTATION_EXPIRED',
    'J3 expired → REPRESENTATION_EXPIRED',
  );
  for (const st of ['proposed', 'declined', 'disputed', 'terminated_by_client', 'terminated_by_agent'])
    neg(
      representationScopeProblem({
        agreement: ag,
        effectiveStatus: st,
        confirmed: st !== 'proposed',
        contextType: 'employment_contract',
        memberAssociations: ['ENG'],
      })?.error === 'REPRESENTATION_REQUIRED',
      `J4 ${st} authorises nothing — no exception is invented`,
    );
  neg(
    representationScopeProblem({
      agreement: ag,
      effectiveStatus: 'active',
      confirmed: false,
      contextType: 'employment_contract',
      memberAssociations: ['ENG'],
    })?.error === 'REPRESENTATION_REQUIRED',
    'J5 "active" without the client\'s confirmation authorises nothing',
  );
  neg(
    representationScopeProblem({
      agreement: { ...ag, scope: ['commercial'] },
      effectiveStatus: 'active',
      confirmed: true,
      contextType: 'employment_contract',
      memberAssociations: ['ENG'],
    })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT',
    'J6 a commercial-only agreement does not cover an employment contract',
  );
  neg(
    representationScopeProblem({
      agreement: ag,
      effectiveStatus: 'active',
      confirmed: true,
      contextType: 'employment_contract',
      memberAssociations: ['USA'],
    })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT',
    'J7 an England agreement does not authorise a U.S. transaction',
  );
  neg(
    representationScopeProblem({
      agreement: ag,
      effectiveStatus: 'active',
      confirmed: true,
      contextType: 'offer',
      memberAssociations: ['ENG'],
    })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT',
    'J8 an unknown context type is covered by nothing',
  );
}

// ============================================================ K–O — the conflict engine (pure)
section('K–O — conflict engine: CLEAR, consent, prohibited, review, connected, deterministic');
{
  const eng = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG'], T0);
  const int = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['INT'], T0);
  const agents = {
    A: { licenceState: 'VERIFIED', connectedAgentUserIds: ['B'] },
    B: { licenceState: 'VERIFIED', connectedAgentUserIds: ['A'] },
  };
  const tx = (over = {}) => ({
    id: 'ctx-1',
    type: 'employment_contract',
    jurisdictions: [{ memberAssociation: 'ENG' }],
    parties: [
      { partyRole: 'individual', subjectKind: 'player', subjectId: 'p1' },
      { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'c1' },
      { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'c2' },
    ],
    representations: [
      { agentUserId: 'A', partyRole: 'individual', agreementId: 'r1', status: 'verified', firstActAt: T0 - 1000 },
    ],
    ...over,
  });
  const run = (t, consents = [], set = eng, extra = {}) =>
    evaluateConflict({
      transaction: t,
      agents,
      consents,
      policySet: set.policies,
      missingPolicies: set.missing,
      now: T0,
      ...extra,
    });
  const dual = (reps) => tx({ representations: reps });
  const consent = (role, over = {}) => ({
    kind: 'dual_representation',
    status: 'granted',
    grantedAt: T0 - 5000,
    revokedAt: null,
    contextId: 'ctx-1',
    agentUserId: 'A',
    partyRole: role,
    grantedBy: { kind: 'player', id: 'p1' },
    policyVersions: ['jp-eng-2026-27-1'],
    particulars: { fullParticularsProvided: true, legalAdviceOffered: true },
    ...over,
  });
  ok(
    CONFLICT_OUTCOMES.length === 5 && OUTCOME_ALIASES.PERMITTED_WITH_CONSENT === PERMITTED_WITH_CONSENT,
    'K1 five outcomes; PERMITTED_WITH_CONSENT is the accepted alias of the consent-required outcome (DR-51)',
  );
  const e1 = run(tx());
  ok(
    e1.outcome === 'CLEAR' &&
      codes(e1).includes('SINGLE_PARTY') &&
      e1.policyVersions.join() === 'jp-fifa-2025-1,jp-eng-2026-27-1',
    'K2 E1 England national, individual only → CLEAR under jp-eng-2026-27-1',
  );
  ok(
    e1.reasons.some(
      (r) => r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'JURISDICTION_OVERRIDE' && r.code === 'NATIONAL_RULE_APPLIES',
    ),
    "K3 inside England's national scope the FIFA entries read JURISDICTION_OVERRIDE and say which national rule applies",
  );
  const e2 = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 1000 },
      { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 500 },
    ]),
  );
  ok(
    e2.outcome === PERMITTED_WITH_CONSENT &&
      e2.alias === 'PERMITTED_WITH_CONSENT' &&
      e2.consentsOutstanding
        .map((c) => c.partyRole)
        .sort()
        .join() === 'engaging_entity,individual' &&
      e2.requiredActions.every((a) => a.action === 'obtain_consent'),
    'L1 E2 individual + engaging, no consents → consent required from BOTH parties (party-specific, never one checkbox)',
  );
  const e3 = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 9000 },
      { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 8000 },
    ]),
    [
      consent('individual', { grantedAt: T0 - 9500 }),
      consent('engaging_entity', { grantedAt: T0 - 9500, grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
    ],
  );
  ok(
    e3.outcome === 'CLEAR' && codes(e3).includes('DUAL_CONSENTED'),
    'L2 E3 both consents in advance, with particulars and legal advice → CLEAR (DUAL_CONSENTED, ENG-6.3)',
  );
  const e4 = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 1000 },
      { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 500 },
    ]),
    [
      consent('individual', { grantedAt: T0 - 100 }),
      consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
    ],
  );
  neg(
    e4.outcome === PERMITTED_WITH_CONSENT && e4.consentsOutstanding[0].reasonCode === 'CONSENT_NOT_IN_ADVANCE',
    'L3 E4 a consent dated after the agent first acted for a second party is not in advance',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual', { particulars: { fullParticularsProvided: false, legalAdviceOffered: true } }),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'PARTICULARS_MISSING',
    'L4 England: without the full particulars the consent is insufficient',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [consent('individual', { particulars: { fullParticularsProvided: true, legalAdviceOffered: false } })],
    ).consentsOutstanding.some((c) => c.reasonCode === 'LEGAL_ADVICE_NOT_OFFERED'),
    'L5 …or without the legal-advice offer',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual'),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: false } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'SIGNATORY_REQUIRED',
    'L6 a club consent from a non-signatory is insufficient',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual', { revokedAt: T0 - 1 }),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'CONSENT_REVOKED',
    'S1 E14 a revoked consent is consent required again',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual', { policyVersions: ['jp-eng-2026-27-0'] }),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'CONSENT_POLICY_VERSION_STALE',
    'S2 a consent naming a policy version that is not in effect is insufficient',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual', { contextId: 'ctx-OTHER' }),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'CONSENT_MISSING',
    'S3 a consent for another transaction context counts for nothing here',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ]),
      [
        consent('individual', { agentUserId: 'Z' }),
        consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
      ],
    ).consentsOutstanding[0].reasonCode === 'CONSENT_MISSING',
    'S4 a consent given to a different agent counts for nothing',
  );
  neg(
    consentSufficiency(consent('individual', { status: 'declined', grantedAt: null }), {
      partyRole: 'individual',
      agentUserId: 'A',
      contextId: 'ctx-1',
    }).reasonCode === 'CONSENT_DECLINED',
    'Q1 a declined consent is declined',
  );
  const e5 = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
      { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' },
    ]),
  );
  neg(
    e5.outcome === 'PROHIBITED_CONFLICT' &&
      e5.reasons.some(
        (r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleId === 'ENG-6.4' && r.ruleStatus === 'ACTIVE',
      ) &&
      e5.requiredActions[0].action === 'withdraw_a_representation',
    'M1 E5 releasing club + individual, England → PROHIBITED_CONFLICT (ENG-6.4, ACTIVE)',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
        { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' },
      ]),
    ).outcome === 'PROHIBITED_CONFLICT',
    'M2 E5c engaging + releasing → prohibited',
  );
  const e5b = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
      { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
    ]),
    [
      consent('individual'),
      consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } }),
    ],
  );
  ok(
    e5b.outcome === 'CLEAR',
    "M3 E5b England permits multiple representation without the releasing club, with the four safeguards — England's table, not FIFA's",
  );
  const e6 = run(
    {
      ...tx(),
      jurisdictions: [{ memberAssociation: 'INT' }],
      representations: [
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ],
    },
    [],
    int,
  );
  neg(
    e6.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' &&
      e6.reasons.some(
        (r) => r.code === 'RULE_STATUS_UNCERTAIN' && r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'UNDER_LEGAL_REVIEW',
      ) &&
      e6.requiredActions[0].action === 'attributed_regulatory_review',
    'N1 E6 international dimension, individual + engaging → MANUAL_REGULATORY_REVIEW_REQUIRED (FIFA-12.8 uncertain) — never CLEAR, never consent-required',
  );
  const e6b = run(
    {
      ...tx(),
      jurisdictions: [{ memberAssociation: 'INT' }],
      representations: [
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' },
      ],
    },
    [],
    int,
  );
  neg(
    e6b.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && e6b.reasons.some((r) => r.ruleId === 'FIFA-12.9'),
    'N2 E6b releasing + individual under the uncertain FIFA text → review, NOT PROHIBITED_CONFLICT by assumption',
  );
  neg(
    run(
      {
        ...tx(),
        jurisdictions: [{ memberAssociation: 'INT' }],
        representations: [
          { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
          { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
        ],
      },
      [
        consent('individual', { policyVersions: ['jp-fifa-2025-1'] }),
        consent('engaging_entity', {
          policyVersions: ['jp-fifa-2025-1'],
          grantedBy: { kind: 'club_user', id: 'u9', signatory: true },
        }),
      ],
      int,
    ).outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED',
    'N3 consents do not cure an uncertain rule — no generic consent bypass',
  );
  neg(
    run(
      tx({ representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'declared', declaredOnly: true }] }),
    ).outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' &&
      codes(
        run(
          tx({
            representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'declared', declaredOnly: true }],
          }),
        ),
      ).includes('REPRESENTATION_UNVERIFIED'),
    'N4 a declared-only representation is a fact for attributed review, never CLEAR (DR-18)',
  );
  neg(
    run(
      tx({
        representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }],
        otherServices: [
          { agentUserId: 'A', partyRole: 'engaging_entity', startedAt: T0 - 300 * DAY, kind: 'consultancy' },
        ],
        jurisdictions: [{ memberAssociation: 'INT' }],
      }),
      [],
      int,
    ).reasons.some((r) => r.code === 'OTHER_SERVICES_PRESUMPTION' && r.ruleId === 'FIFA-15.3'),
    'N5 E10 Other Services to the engaging club under FIFA → review (presumption, never prohibition)',
  );
  ok(
    run(
      tx({
        representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }],
        otherServices: [
          { agentUserId: 'A', partyRole: 'engaging_entity', startedAt: T0 - 300 * DAY, kind: 'consultancy' },
        ],
      }),
    ).outcome === PERMITTED_WITH_CONSENT,
    'N6 England counts Other Services inside 6.3–6.5: the club enters the set and consent is required',
  );
  neg(
    run(tx(), [], eng, {
      interests: [{ kind: 'agent_relationship', holderKind: 'club_user', holderId: 'u1', agentUserId: 'A' }],
    }).reasons.some((r) => r.code === 'INTEREST_DECLARED'),
    'N7 E11 a declared interest linking a club user to the agent → review',
  );
  const e8 = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
      { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' },
    ]),
    [],
    eng,
    {},
  );
  neg(
    e8.outcome === PERMITTED_WITH_CONSENT &&
      e8.reasons.some((r) => r.code === 'CONNECTED_AGENT_ATTRIBUTION' && r.ruleId === 'ENG-6.5'),
    'O1 E8 a colleague at the same agency serving the engaging club is attributed to the agent — consent required, never "different individual = no conflict"',
  );
  neg(
    run(
      dual([
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'B', partyRole: 'releasing_entity', status: 'verified' },
      ]),
    ).outcome === 'PROHIBITED_CONFLICT',
    'O2 E9 the colleague serving the releasing club makes it prohibited',
  );
  const e8i = run(
    {
      ...tx(),
      jurisdictions: [{ memberAssociation: 'INT' }],
      representations: [
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' },
      ],
    },
    [],
    int,
  );
  neg(
    e8i.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' &&
      e8i.reasons.some((r) => r.code === 'CONNECTED_AGENT_ATTRIBUTION' && r.ruleId === 'FIFA-12.10'),
    'O3 under the uncertain FIFA connected-agent rule the colleague case is ambiguous → review, still attributed',
  );
  const e8n = run(
    dual([
      { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
      { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' },
    ]),
    [],
    eng,
    {
      transaction: {
        ...dual([
          { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
          { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' },
        ]),
        evaluateAgentUserIds: ['A'],
      },
    },
  );
  neg(
    !e8n.reasons.some((r) => r.agentUserId === 'B'),
    'O4 with the evaluated agent named, no reason judges the colleague — the colleague is an input to attribution, never a subject',
  );
  neg(
    run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', isMinor: true }] }))
      .outcome === 'INSUFFICIENT_DATA' &&
      codes(
        run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', isMinor: true }] })),
      ).includes('MINOR_PARTY'),
    'W1 E12 a minor party without a guardian agreement consent → INSUFFICIENT_DATA',
  );
  neg(
    run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', removed: true }] }))
      .outcome === 'INSUFFICIENT_DATA' &&
      codes(
        run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', removed: true }] })),
      ).includes('PARTY_REMOVED'),
    'X1 a removed party → INSUFFICIENT_DATA',
  );
  neg(
    run(tx({ type: 'offer' })).outcome === 'INSUFFICIENT_DATA' &&
      run(tx({ jurisdictions: [] })).outcome === 'INSUFFICIENT_DATA',
    'K4 an unknown type or an unresolved scope → INSUFFICIENT_DATA',
  );
  neg(
    run(tx(), [], eng, { agents: { A: { licenceState: 'STALE', connectedAgentUserIds: [] } } }).outcome ===
      'INSUFFICIENT_DATA' &&
      codes(run(tx(), [], eng, { agents: { A: { licenceState: 'STALE', connectedAgentUserIds: [] } } })).includes(
        'AGENT_STATE_INVALID',
      ),
    'K5 an agent whose licence is not VERIFIED → INSUFFICIENT_DATA (defence in depth)',
  );
  const mixed = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG', 'USA'], T0);
  neg(
    run(
      { ...tx(), jurisdictions: [{ memberAssociation: 'ENG' }, { memberAssociation: 'USA' }] },
      [],
      mixed,
    ).reasons.some((r) => r.code === 'SCOPE_MIXED'),
    'N8 E13 a transaction spanning England and a jurisdiction where the rule is not encoded → review (SCOPE_MIXED)',
  );
  const a = run(tx());
  const b = run(tx());
  ok(
    a.inputHash === b.inputHash &&
      a.inputHash.length === 64 &&
      inputHashOf({ b: 1, a: 2 }) === inputHashOf({ a: 2, b: 1 }),
    'K6 E15/E17 the same inputs give the same hash; key order does not matter',
  );
  neg(run(tx()).inputHash !== run(tx({ type: 'transfer' })).inputHash, 'K7 a different input is a different hash');
  const v2 = {
    ...SEEDED_POLICY_VERSIONS[0],
    id: 'jp-fifa-2025-2',
    policyVersion: 2,
    supersedes: 'jp-fifa-2025-1',
    effectiveFrom: '2026-09-01',
    rules: {
      ...SEEDED_POLICY_VERSIONS[0].rules,
      'FIFA-12.8': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.8'], ruleStatus: 'ACTIVE' },
      'FIFA-12.9': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.9'], ruleStatus: 'ACTIVE' },
      'FIFA-12.10': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.10'], ruleStatus: 'ACTIVE' },
    },
  };
  const int2 = applicablePolicySet([...SEEDED_POLICY_VERSIONS, v2], ['INT'], T0);
  ok(
    run(
      {
        ...tx(),
        jurisdictions: [{ memberAssociation: 'INT' }],
        representations: [
          { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
          { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
        ],
      },
      [],
      int2,
    ).outcome === PERMITTED_WITH_CONSENT &&
      run(
        {
          ...tx(),
          jurisdictions: [{ memberAssociation: 'INT' }],
          representations: [
            { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
            { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' },
          ],
        },
        [],
        int2,
      ).outcome === 'PROHIBITED_CONFLICT',
    'C11 E16 a later FIFA version with 12(8)–(10) ACTIVE turns E6 into consent-required and E6b into prohibited — a data change, not code',
  );
  const v3 = {
    ...v2,
    id: 'jp-fifa-2025-3',
    policyVersion: 3,
    rules: { ...v2.rules, 'FIFA-12.8': { ...v2.rules['FIFA-12.8'], ruleStatus: 'SUSPENDED' } },
  };
  const susp = run(
    {
      ...tx(),
      jurisdictions: [{ memberAssociation: 'INT' }],
      representations: [
        { agentUserId: 'A', partyRole: 'individual', status: 'verified' },
        { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' },
      ],
    },
    [],
    applicablePolicySet([...SEEDED_POLICY_VERSIONS, v2, v3], ['INT'], T0),
  );
  neg(
    susp.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' &&
      codes(susp).includes('RULE_SUSPENDED') &&
      codes(susp).includes('NO_ACTIVE_RULE_DECIDES'),
    'D4 E18 a SUSPENDED deciding rule contributes a reason and never a permission: with no ACTIVE rule deciding, review',
  );
  const s = conflictSummaryForParty(e8);
  neg(
    !('reasons' in s) && Array.isArray(s.reasonCodes) && !JSON.stringify(s).includes('"B"'),
    "Z1 the party-facing summary carries codes only, never the other side's agents",
  );
  neg(
    !JSON.stringify(run(tx()).reasons).match(/name|email|@|fee/i),
    'Z2 E20 reasons carry codes and rule references only',
  );
}

// ============================================================ U/V/W — minors gate (pure)
section('U/V/W — the minors gate: jurisdiction-aware, guardian-first, accreditation-bound, fail-closed');
{
  const eng = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG'], T0);
  const int = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['INT'], T0);
  const usa = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['USA'], T0);
  const facets = {
    fifa_licence: 'VERIFIED',
    national_registration: { ENG: 'VERIFIED' },
    domestic_authorisation: {},
    minors_authorisation: { ENG: 'VERIFIED', INT: 'VERIFIED' },
  };
  const timing = ruleAt(eng.policies, 'ENG-5.1', T0);
  ok(
    new Date(earliestPermittedApproachAt('2011-03-15', timing).at).toISOString().startsWith('2026-09-01') &&
      new Date(earliestPermittedApproachAt('2011-09-15', timing).at).toISOString().startsWith('2027-09-01'),
    'U1 England: a minor reaching 16 on 15 Mar 2027 is approachable from 1 Sep 2026; one reaching 16 on 15 Sep 2027 only from 1 Sep 2027 (FA 2026-27 reg. 5.1)',
  );
  neg(
    earliestPermittedApproachAt('2011-03-15', ruleAt(int.policies, 'FIFA-13.1', T0), { employingCountry: 'FRA' }).at ===
      null &&
      earliestPermittedApproachAt('2011-03-15', ruleAt(int.policies, 'FIFA-13.1', T0)).reason ===
        'MINOR_TIMING_NOT_ENCODED',
    'U2 the FIFA formula needs a first-contract age that is encoded for NO country → not computable',
  );
  ok(
    isRegulatoryMinor('2011-03-15', T0) === true &&
      isRegulatoryMinor('2008-09-17', T0) === false &&
      isRegulatoryMinor('2008-09-19', T0) === true &&
      isRegulatoryMinor('nope', T0) === null,
    'U3 regulatory minor = under 18 on the day, a separate predicate from the visibility age (DR-14)',
  );
  const g = (args) =>
    evaluateMinorGate({
      policySet: eng.policies,
      missingPolicies: eng.missing,
      now: T0,
      facets,
      memberAssociation: 'ENG',
      ...args,
    });
  neg(
    g({ dob: '2011-09-15' }).blocked === true &&
      codes(g({ dob: '2011-09-15' })).includes('MINOR_APPROACH_NOT_PERMITTED') &&
      !JSON.stringify(g({ dob: '2011-09-15' }).reasons).includes('2027'),
    'U4 before the date: blocked, reason timing, and NO date in the reasons (DR-16)',
  );
  ok(
    g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY, revokedAt: null }] })
      .allowed === true,
    'U5 on/after the date, with ENG minors authorisation, FA registration, FIFA licence and a PRIOR guardian approach consent → the gate passes',
  );
  neg(
    g({ dob: '2011-03-15' }).requiresGuardian === true &&
      codes(g({ dob: '2011-03-15' })).includes('GUARDIAN_CONSENT_REQUIRED'),
    'V1 without a prior guardian consent the gate does not pass',
  );
  neg(
    g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 + 1, revokedAt: null }] })
      .requiresGuardian === true,
    'V2 a guardian consent dated AFTER the evaluation moment is not prior consent — no retroactive consent',
  );
  neg(
    g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY, revokedAt: T0 - 1 }] })
      .requiresGuardian === true,
    'V3 a revoked guardian consent is no consent',
  );
  neg(
    g({
      dob: '2011-03-15',
      facets: { ...facets, minors_authorisation: {} },
      guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }],
    }).requiresMinorAccreditation === true,
    "W2 without the agent's own minors authorisation the gate fails — agency affiliation is never enough",
  );
  neg(
    g({
      dob: '2011-03-15',
      facets: { ...facets, minors_authorisation: { ENG: 'STALE', INT: 'VERIFIED' } },
      guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }],
    }).requiresMinorAccreditation === true,
    'W3 a STALE minors authorisation (expired three-year window) fails the gate',
  );
  neg(
    g({ dob: '2011-03-15', blocked: true, guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] })
      .blocked === true && codes(g({ dob: '2011-03-15', blocked: true })).includes('SAFEGUARDING_BLOCK'),
    'X2 a block wins over every regulatory condition',
  );
  const fra = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['FRA'], T0);
  neg(
    evaluateMinorGate({
      dob: '2011-03-15',
      memberAssociation: 'FRA',
      facets,
      policySet: fra.policies,
      missingPolicies: fra.missing,
      now: T0,
    }).blocked === true &&
      codes(
        evaluateMinorGate({
          dob: '2011-03-15',
          memberAssociation: 'FRA',
          facets,
          policySet: fra.policies,
          missingPolicies: fra.missing,
          now: T0,
        }),
      ).includes('POLICY_NOT_ENCODED'),
    'U6 a non-encoded jurisdiction: blocked, review — the England formula is NEVER applied elsewhere (DR-48)',
  );
  neg(
    evaluateMinorGate({
      dob: '2011-03-15',
      memberAssociation: 'INT',
      facets,
      policySet: int.policies,
      missingPolicies: int.missing,
      now: T0,
      guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }],
    }).blocked === true &&
      codes(
        evaluateMinorGate({
          dob: '2011-03-15',
          memberAssociation: 'INT',
          facets,
          policySet: int.policies,
          missingPolicies: int.missing,
          now: T0,
        }),
      ).includes('INSUFFICIENT_DATA'),
    'U7 the FIFA formula alone is INSUFFICIENT_DATA → refused (DR-49)',
  );
  neg(
    evaluateMinorGate({
      dob: '2011-03-15',
      memberAssociation: 'USA',
      facets,
      policySet: usa.policies,
      missingPolicies: usa.missing,
      now: T0,
    }).blocked === true,
    'U8 the U.S. minors rule is UNKNOWN → refused',
  );
  ok(
    evaluateMinorGate({ dob: '2000-03-15', memberAssociation: 'ENG', facets, policySet: eng.policies, now: T0 })
      .isRegulatoryMinor === false &&
      codes(
        evaluateMinorGate({ dob: '2000-03-15', memberAssociation: 'ENG', facets, policySet: eng.policies, now: T0 }),
      ).includes('NOT_A_MINOR'),
    'W4 an adult is not gated',
  );
  const turned = evaluateMinorGate({
    dob: '2008-09-17',
    memberAssociation: 'ENG',
    facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } },
    policySet: eng.policies,
    now: T0,
  });
  ok(
    turned.isRegulatoryMinor === false &&
      evaluateMinorGate({
        dob: '2008-09-17',
        memberAssociation: 'ENG',
        facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } },
        policySet: eng.policies,
        now: T0 - 2 * DAY,
      }).isRegulatoryMinor === true,
    'W5 age transition: the same person is a minor two days ago and an adult today — authority is re-derived from the clock, never cached',
  );
  neg(
    Object.values(MINOR_PATHWAY_PRODUCTION_ENABLED).every((v) => v === false) &&
      g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] })
        .pathwayEnabledInProduction === false,
    'U9 NO jurisdiction has a production minor pathway enabled, even where the gate can pass',
  );
}

// ============================================================ Z — contracts (pure)
section('Z — error contract, permissions, registry, notifications, rate policies, stores');
{
  ok(
    Object.getPrototypeOf(COMPLIANCE_ERROR_HTTP) === null && COMPLIANCE_ERROR_HTTP.constructor === undefined,
    'Z3 the error table is null-prototype',
  );
  neg(
    COMPLIANCE_ERROR_HTTP.REVIEWER_AUTH_REQUIRED === 401 &&
      COMPLIANCE_ERROR_HTTP.REPRESENTATION_CONFLICT === 403 &&
      COMPLIANCE_ERROR_HTTP.CONSENT_REQUIRED === 422 &&
      COMPLIANCE_ERROR_HTTP.REGULATORY_REVIEW_REQUIRED === 422 &&
      COMPLIANCE_ERROR_HTTP.REGULATORY_PROVIDER_UNAVAILABLE === 503 &&
      COMPLIANCE_ERROR_HTTP.CONTEXT_NOT_FOUND === 404 &&
      COMPLIANCE_ERROR_HTTP.REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE === 409,
    'Z4 codes map to the right statuses',
  );
  const pub = publicErrorBody({
    error: 'CONSENT_REQUIRED',
    stack: 'x',
    reviewerNote: 'private',
    reasons: [{ code: 'CONSENT_REQUIRED', ruleId: 'ENG-6.3', ruleStatus: 'ACTIVE', note: 'prose', agentUserId: 'A' }],
    consentsOutstanding: [
      { partyRole: 'individual', consentKind: 'dual_representation', reasonCode: 'CONSENT_MISSING', agentUserId: 'A' },
    ],
  });
  neg(
    pub.stack === undefined &&
      pub.reviewerNote === undefined &&
      pub.reasons[0].note === undefined &&
      pub.reasons[0].agentUserId === undefined &&
      pub.consentsOutstanding[0].agentUserId === undefined &&
      PUBLIC_ERROR_FIELDS.includes('reasons'),
    'Z5 error bodies are whitelisted; reasons and outstanding consents shed prose and agent ids',
  );
  ok(
    can(['licensed_agent'], 'compliance.contexts.write') && can(['analyst'], 'compliance.read'),
    'Z6 the matrix grants context writes to licensed agents only and reads to every member',
  );
  neg(
    !can(['agency_admin'], 'compliance.contexts.write') &&
      !can(['assistant'], 'compliance.contexts.write') &&
      !can(['finance'], 'compliance.contexts.write') &&
      can(TIERS_ALL(), 'review.resolve') === false,
    'Z7 an administrator, assistant or finance member cannot open a context; no agency role can resolve a review',
  );
  for (const e of [
    'regulatory_review_requested',
    'regulatory_review_started',
    'regulatory_review_resolved',
    'conflict_evaluated',
    'regulatory_consent_requested',
    'regulatory_consent_granted',
    'regulatory_consent_declined',
    'regulatory_consent_revoked',
    'agent_authorisation_state_changed',
  ]) {
    const r = EVENT_REGISTRY[e];
    ok(
      !!r &&
        r.audience === 'org_private' &&
        r.privacyClass === 'org_internal' &&
        r.replayPolicy === 'never' &&
        r.analyticsEligible === false &&
        r.payload.every((k) => /Id$|^kind$|^outcome$|^state$/.test(k)),
      `AE1 ${e} is org_private, never replayed, never analytics, ids and state words only`,
    );
  }
  ok(
    EVENT_REGISTRY.policy_version_published?.audience === 'public_safe' &&
      EVENT_REGISTRY.policy_version_published.payload.length === 0,
    'AE2 a policy publication is a content-free public ping',
  );
  for (const t of [
    'regulatory_review_required',
    'regulatory_review_completed',
    'regulatory_consent_requested',
    'regulatory_consent_granted',
    'regulatory_consent_declined',
    'regulatory_consent_revoked',
    'agent_verification_stale',
  ])
    ok(TYPE_CATEGORY[t] === 'compliance', `AF1 notification ${t} → compliance category`);
  ok(
    CATEGORIES.compliance.mandatory === true && CATEGORIES.compliance.default === true,
    'AF2 the compliance category is mandatory — a regulatory obligation cannot be muted',
  );
  for (const [k, scope] of [
    ['compliance_context_write', 'actor'],
    ['compliance_consent_request', 'actor'],
    ['compliance_consent_response', 'actor'],
    ['ts_review_decision', 'actor'],
    ['ts_policy_publish', 'actor'],
  ])
    ok(RATE_LIMIT_POLICY[k]?.scope === scope && RATE_LIMIT_POLICY[k].max > 0, `Z8 rate policy ${k}`);
  for (const s of [
    'tsReviewers',
    'jurisdictionPolicies',
    'regulatoryReviews',
    'regulatoryConsents',
    'complianceContexts',
  ])
    ok(TABLE_BACKED.includes(s), `AD1 ${s} is a table of the compliance repositories, not a collection`);
  const compliance = [COMPLIANCE_POLICIES_MIGRATION, COMPLIANCE_RECORDS_MIGRATION];
  ok(
    compliance.every((id) => DATA_MIGRATIONS.filter((m) => m.id === id).length === 1) && SCHEMA_VERSION >= 28,
    'AD2 exactly one migration each creates the compliance tables (0027, 0028), and the current schema is at or past them',
  );
  neg(
    ![...COMPLIANCE_POLICIES_TABLES, ...COMPLIANCE_RECORDS_TABLES].some((t) =>
      /transaction|offer|signing|invoice/i.test(t),
    ),
    'AD3 the compliance migrations create no transaction, offer, signing or invoice table — compliance owns evaluation, not the Transaction Room',
  );
  ok(
    COMPLIANCE_AUDIT_ACTIONS.has('regulatory_review_resolved') &&
      COMPLIANCE_AUDIT_ACTIONS.has('regulatory_consent_revoked') &&
      !COMPLIANCE_AUDIT_ACTIONS.has('offer_made'),
    'AE3 the audit projection lists review, consent and context actions and no offer action',
  );
}
function TIERS_ALL() {
  return ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'];
}

// =================================================================== HTTP

section('T — the severity order (moved from the HTTP section T)');
{
  // The severity order is the guard: a prohibition is a definite answer, so nothing
  // that is merely UNDECIDED can outrank it and turn a refusal into a stored record.
  neg(
    mostSevere('MANUAL_REGULATORY_REVIEW_REQUIRED', 'PROHIBITED_CONFLICT') === 'PROHIBITED_CONFLICT' &&
      mostSevere('INSUFFICIENT_DATA', 'PROHIBITED_CONFLICT') === 'PROHIBITED_CONFLICT' &&
      mostSevere('CLEAR', 'PROHIBITED_CONFLICT') === 'PROHIBITED_CONFLICT',
    'T5 PROHIBITED_CONFLICT outranks review, insufficient data and clearance alike — a block beats everything (regression guard, defect C14)',
  );
}

done();
