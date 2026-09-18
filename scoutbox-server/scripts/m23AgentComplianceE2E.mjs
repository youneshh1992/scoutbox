// M23 P5.6C acceptance suite — ScoutBox Agent Conflict & Compliance Engine.
//
// The governing principle this suite enforces (mandate §99): ScoutBox never
// converts an agency relationship, a stale licence, an ambiguous rule, a
// missing consent, an unsupported jurisdiction, a shared reviewer credential
// or an old conflict check into authority to perform a regulated
// football-agent workflow. Every regulated action is grounded in an
// attributable actor, current client authority, current policy, current
// verification, current consent and current conflict state.
//
// Groups (mandate §76), pure first, then a real server:
//   C policy versioning · D policy status · E jurisdiction resolution · F unsupported
//   jurisdiction · G/H/I provider states · J representation scope · K–O conflict
//   engine (CLEAR, consent, prohibited, review, connected) · P–S consent sufficiency
//   · U/V/W minors gate · Z error contract
//   A G-C0 attribution · B reviewer revocation · G/H/I provider over HTTP · R reviews
//   · K–O contexts over HTTP · P–T consents, revocation, party change · U–W minors
//   over HTTP · X blocks · Y tenant · Z privacy · AA rev · AB idempotency · AE
//   audit/events · AF notifications · AJ tombstones · C/policy publication (dual
//   control, historical snapshots) · the thirty adversarial cases (§77), numbered.
//
// No assertion is `status !== 200`. Every refusal names the status and code.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEEDED_POLICY_VERSIONS, RULE_STATUSES } from '../m25/policyVersions.mjs';
import { selectPolicyVersion, applicablePolicySet, ruleAt, resolveScope, evaluatePolicy, evaluateMinorGate, earliestPermittedApproachAt, isRegulatoryMinor, representationScopeProblem, MINOR_PATHWAY_PRODUCTION_ENABLED, POLICY_FACETS } from '../m25/policy.mjs';
import { evaluateConflict, consentSufficiency, CONFLICT_OUTCOMES, PERMITTED_WITH_CONSENT, OUTCOME_ALIASES, conflictSummaryForParty, inputHashOf } from '../m25/conflict.mjs';
import { createVerificationProvider, facetFromProviderAnswer, PROVIDER_STATES } from '../m25/provider.mjs';
import { M25_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../m25/errors.mjs';
import { COMPLIANCE_AUDIT_ACTIONS } from '../m25/audit.mjs';
import { PERMISSIONS, can, FACETS } from '../m24/shared.mjs';
import { EVENT_REGISTRY } from '../m182/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../m181/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../m182/notificationPrefs.mjs';
import { MIGRATIONS, SCHEMA_VERSION, PRODUCTION_REQUIRED_STORES } from '../m182/migrations.mjs';
import { guaranteeFor } from '../storeContract.mjs';
import { openStore } from '../store.mjs';

const PORT = 6500 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sbx-m25-'));
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const ADMIN = { 'x-admin-key': process.env.ADMIN_KEY || 'scoutbox-admin' };

let passed = 0; let negatives = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (cond, msg) => { if (cond) { passed++; console.log(`✓ ${msg}`); } else fail(msg); };
const neg = (cond, msg) => { negatives++; ok(cond, `[neg] ${msg}`); };
const section = (name) => console.log(`\n— ${name} —`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expect = (r, status, code) => {
  const good = r.status === status && (code === null || r.body?.error === code);
  if (!good) console.error(`   got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return good;
};
const T0 = Date.UTC(2026, 8, 18);
const DAY = 86_400_000;
const codes = (r) => (r.reasons ?? []).map((x) => x.code);

// ============================================================ C/D — versions and statuses (pure)
section('C/D — policy versioning and rule statuses');
{
  const rows = SEEDED_POLICY_VERSIONS;
  ok(RULE_STATUSES.length === 7 && ['ACTIVE', 'SUSPENDED', 'PARTIALLY_SUSPENDED', 'JURISDICTION_OVERRIDE', 'PENDING_IMPLEMENTATION', 'UNDER_LEGAL_REVIEW', 'UNKNOWN'].every((s) => RULE_STATUSES.includes(s)), 'D1 the seven frozen rule statuses, exactly');
  ok(rows.length === 3 && rows.map((r) => r.id).join() === 'jp-fifa-2025-1,jp-eng-2026-27-1,jp-usa-2024-1', 'C1 three seeded versions: FIFA 2025, England 2026-27, USA 2024');
  ok(rows.every((r) => Object.values(r.rules).every((x) => RULE_STATUSES.includes(x.ruleStatus) && Array.isArray(x.sourceRef) && x.sourceRef.length && x.sourceRef.every((s) => s.source && s.version && s.retrievedDate === '2026-09-18'))), 'C2 every rule carries a status and a source reference with version and retrieval date');
  ok(rows.every((r) => Object.values(r.rules).every((x) => x.textStatus)), 'C3 rule TEXT status is recorded separately from operative status on every rule');
  const fifa = rows[0];
  neg(fifa.rules['FIFA-12.8'].ruleStatus === 'UNDER_LEGAL_REVIEW' && fifa.rules['FIFA-12.8'].textStatus === 'UNCERTAIN_OPERATIVE_STATUS' && /Circular 1873/.test(fifa.rules['FIFA-12.8'].note), 'C4 FFAR 12(8) text is current, operative status UNDER_LEGAL_REVIEW, and the note quotes the tension — not ACTIVE because the text exists');
  neg(fifa.rules['FIFA-19'].ruleStatus === 'SUSPENDED' && fifa.rules['FIFA-RSTP-2027'].ruleStatus === 'PENDING_IMPLEMENTATION' && rows[1].rules['ENG-7.13'].ruleStatus === 'PARTIALLY_SUSPENDED' && rows[2].rules['USA-MULTI'].ruleStatus === 'UNKNOWN', 'C5 SUSPENDED, PENDING_IMPLEMENTATION, PARTIALLY_SUSPENDED and UNKNOWN each appear in the seeded content');
  ok(selectPolicyVersion(rows, 'ENG', T0)?.id === 'jp-eng-2026-27-1' && selectPolicyVersion(rows, 'INT', T0)?.id === 'jp-fifa-2025-1', 'C6 the version in effect on 18 Sep 2026 is selected per jurisdiction');
  neg(selectPolicyVersion(rows, 'ENG', Date.UTC(2026, 4, 31)) === null, 'C7 before 1 June 2026 no England version is in effect (nothing is back-dated)');
  const v2 = { ...fifa, id: 'jp-fifa-2025-2', policyVersion: 2, supersedes: 'jp-fifa-2025-1', effectiveFrom: '2026-10-01', status: 'published' };
  ok(selectPolicyVersion([...rows, v2], 'INT', T0)?.id === 'jp-fifa-2025-1' && selectPolicyVersion([...rows, v2], 'INT', Date.UTC(2026, 9, 2))?.id === 'jp-fifa-2025-2', 'C8 a later version applies only from its own effective date');
  neg(selectPolicyVersion([...rows, { ...v2, status: 'proposed', effectiveFrom: '2026-01-01' }], 'INT', T0)?.id === 'jp-fifa-2025-1', 'C9 a PROPOSED version never applies — publication needs dual control');
  const set = applicablePolicySet(rows, ['ENG', 'FRA'], T0);
  ok(set.policies.map((p) => p.id).join() === 'jp-fifa-2025-1,jp-eng-2026-27-1' && set.missing.join() === 'FRA', 'C10 the applicable set is FIFA plus every national entry; a missing entry is reported, never skipped');
  ok(ruleAt(set.policies, 'ENG-6.3', T0).status === 'ACTIVE' && ruleAt(set.policies, 'FIFA-12.8', T0).status === 'UNDER_LEGAL_REVIEW' && ruleAt(set.policies, 'NOPE-1', T0).status === 'UNKNOWN', 'D2 rule lookup stamps the status; an unknown rule is UNKNOWN');
  neg(ruleAt(set.policies, 'FIFA-RSTP-2027', T0).status === 'PENDING_IMPLEMENTATION' && ruleAt(set.policies, 'FIFA-RSTP-2027', Date.UTC(2027, 0, 2)).status === 'ACTIVE', 'D3 an announced rule is PENDING_IMPLEMENTATION before its effective date and applies after');
}

// ============================================================ E/F — scope and unsupported jurisdiction (pure)
section('E/F — jurisdiction resolution; an unsupported jurisdiction never allows');
{
  ok(resolveScope([{ memberAssociation: 'ENG' }, { memberAssociation: 'ENG' }]).scope === 'national' && resolveScope(['ENG']).nationalMa === 'ENG', 'E1 one national association → national scope');
  ok(resolveScope([{ memberAssociation: 'INT' }]).scope === 'international' && resolveScope(['ENG', 'USA']).scope === 'international', 'E2 INT, or more than one MA → international dimension');
  neg(resolveScope([]).scope === 'unknown' && resolveScope(null).scope === 'unknown', 'E3 nothing supplied → unknown (never guessed)');
  const fra = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['FRA'], T0);
  const facets = { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' }, domestic_authorisation: {}, minors_authorisation: {} };
  const d = evaluatePolicy({ action: 'approach_adult', memberAssociations: ['FRA'], facets, policySet: fra.policies, missingPolicies: fra.missing, now: T0 });
  neg(d.allowed === false && d.requiresManualReview === true && codes(d).includes('POLICY_NOT_ENCODED'), 'F1 a jurisdiction with no encoded policy → manual review, never allowed');
  const r = evaluateConflict({ transaction: { id: 't', type: 'transfer', jurisdictions: [{ memberAssociation: 'FRA' }], parties: [], representations: [] }, agents: {}, policySet: fra.policies, missingPolicies: fra.missing, now: T0 });
  neg(r.outcome === 'INSUFFICIENT_DATA' && codes(r).includes('POLICY_NOT_ENCODED'), 'F2 the conflict engine answers INSUFFICIENT_DATA for it');
  const usa = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['USA'], T0);
  const du = evaluatePolicy({ action: 'approach_adult', memberAssociations: ['USA'], facets, policySet: usa.policies, missingPolicies: usa.missing, now: T0 });
  neg(du.allowed === false && du.requiresDomesticAuthorisation === true && du.facetGaps[0]?.code === 'AGENT_DOMESTIC_AUTHORISATION_REQUIRED', 'F3 USA: the ACTIVE background-check/SafeSport rule requires a separate domestic_authorisation facet — a FIFA licence alone is not enough');
  ok(evaluatePolicy({ action: 'approach_adult', memberAssociations: ['USA'], facets: { ...facets, domestic_authorisation: { USA: 'VERIFIED' } }, policySet: usa.policies, missingPolicies: usa.missing, now: T0 }).allowed === true, 'F4 with it VERIFIED, an adult approach in the USA is allowed under the encoded rules');
  neg(evaluatePolicy({ action: 'bribe', memberAssociations: ['ENG'], facets, policySet: [], now: T0 }).blocked === true, 'F5 an unknown action is blocked');
}

// ============================================================ G/H/I — provider (pure)
section('G/H/I — the fail-honest provider abstraction');
{
  ok(PROVIDER_STATES.join() === 'VERIFIED,NOT_VERIFIED,INACTIVE,STALE,UNAVAILABLE,MANUAL_REVIEW_REQUIRED', 'G1 the six provider states');
  const none = createVerificationProvider({});
  neg(none.id === 'none' && none.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).state === 'MANUAL_REVIEW_REQUIRED' && none.status().live === false && none.status().registers.fifa === 'not_connected', 'G2 production has NO provider: even a TEST reference is manual review; the status says no register is connected');
  const syn = createVerificationProvider({ synthetic: true });
  ok(syn.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).state === 'VERIFIED' && syn.verifyFifaLicence({ reference: 'TEST-VERIFIED-1', now: T0 }).provenance.provider === 'local-synthetic-test-provider', 'G3 the synthetic provider verifies its own tagged references and names itself');
  neg(syn.verifyNationalRegistration({ reference: 'FA-12345', now: T0 }).state === 'MANUAL_REVIEW_REQUIRED', 'G4 a real-looking reference is still manual review with the synthetic provider');
  neg(syn.verifyFifaLicence({ reference: 'TEST-STALE-1', now: T0 }).state === 'STALE' && facetFromProviderAnswer(syn.verifyFifaLicence({ reference: 'TEST-STALE-1', now: T0 }), { reference: 'x', now: T0 }).recheckAt < T0, 'H1 STALE stores a VERIFIED facet whose recheck date has already passed — it reads STALE, never VERIFIED');
  neg(syn.verifyDomesticAuthorisation({ reference: 'TEST-UNAVAILABLE-1', now: T0 }).state === 'UNAVAILABLE' && facetFromProviderAnswer(syn.verifyDomesticAuthorisation({ reference: 'TEST-UNAVAILABLE-1', now: T0 }), { reference: 'x', now: T0 }) === null, 'I1 UNAVAILABLE writes NOTHING to a facet');
  neg(syn.verifyMinorAuthorisation({ reference: 'TEST-NOTVERIFIED-1', now: T0 }).state === 'NOT_VERIFIED' && facetFromProviderAnswer(syn.verifyMinorAuthorisation({ reference: 'TEST-NOTVERIFIED-1', now: T0 }), { reference: 'x', now: T0 }).state === 'UNVERIFIED', 'I2 NOT_VERIFIED stores UNVERIFIED, never INACTIVE and never VERIFIED');
  ok(FACETS.length === 4 && POLICY_FACETS.join() === 'fifa_licence,national_registration,domestic_authorisation,minors_authorisation', 'I3 four separate facets: licence, national registration, domestic authorisation, minors authorisation');
}

// ============================================================ J — representation scope (pure)
section('J — the action must fit the agreement');
{
  const ag = { id: 'r1', scope: ['employment'], jurisdiction: 'ENG' };
  ok(representationScopeProblem({ agreement: ag, effectiveStatus: 'active', confirmed: true, contextType: 'employment_contract', memberAssociations: ['ENG'] }) === null, 'J1 an active confirmed ENG employment agreement covers an ENG employment contract');
  neg(representationScopeProblem({ agreement: null, effectiveStatus: null, confirmed: false, contextType: 'employment_contract' })?.error === 'REPRESENTATION_REQUIRED', 'J2 no agreement → REPRESENTATION_REQUIRED');
  neg(representationScopeProblem({ agreement: ag, effectiveStatus: 'expired', confirmed: true, contextType: 'employment_contract', memberAssociations: ['ENG'] })?.error === 'REPRESENTATION_EXPIRED', 'J3 expired → REPRESENTATION_EXPIRED');
  for (const st of ['proposed', 'declined', 'disputed', 'terminated_by_client', 'terminated_by_agent']) neg(representationScopeProblem({ agreement: ag, effectiveStatus: st, confirmed: st !== 'proposed', contextType: 'employment_contract', memberAssociations: ['ENG'] })?.error === 'REPRESENTATION_REQUIRED', `J4 ${st} authorises nothing — no exception is invented`);
  neg(representationScopeProblem({ agreement: ag, effectiveStatus: 'active', confirmed: false, contextType: 'employment_contract', memberAssociations: ['ENG'] })?.error === 'REPRESENTATION_REQUIRED', 'J5 "active" without the client\'s confirmation authorises nothing');
  neg(representationScopeProblem({ agreement: { ...ag, scope: ['commercial'] }, effectiveStatus: 'active', confirmed: true, contextType: 'employment_contract', memberAssociations: ['ENG'] })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT', 'J6 a commercial-only agreement does not cover an employment contract');
  neg(representationScopeProblem({ agreement: ag, effectiveStatus: 'active', confirmed: true, contextType: 'employment_contract', memberAssociations: ['USA'] })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT', 'J7 an England agreement does not authorise a U.S. transaction');
  neg(representationScopeProblem({ agreement: ag, effectiveStatus: 'active', confirmed: true, contextType: 'offer', memberAssociations: ['ENG'] })?.error === 'REPRESENTATION_SCOPE_INSUFFICIENT', 'J8 an unknown context type is covered by nothing');
}

// ============================================================ K–O — the conflict engine (pure)
section('K–O — conflict engine: CLEAR, consent, prohibited, review, connected, deterministic');
{
  const eng = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG'], T0);
  const int = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['INT'], T0);
  const agents = { A: { licenceState: 'VERIFIED', connectedAgentUserIds: ['B'] }, B: { licenceState: 'VERIFIED', connectedAgentUserIds: ['A'] } };
  const tx = (over = {}) => ({ id: 'ctx-1', type: 'employment_contract', jurisdictions: [{ memberAssociation: 'ENG' }], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'c1' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'c2' }], representations: [{ agentUserId: 'A', partyRole: 'individual', agreementId: 'r1', status: 'verified', firstActAt: T0 - 1000 }], ...over });
  const run = (t, consents = [], set = eng, extra = {}) => evaluateConflict({ transaction: t, agents, consents, policySet: set.policies, missingPolicies: set.missing, now: T0, ...extra });
  const dual = (reps) => tx({ representations: reps });
  const consent = (role, over = {}) => ({ kind: 'dual_representation', status: 'granted', grantedAt: T0 - 5000, revokedAt: null, contextId: 'ctx-1', agentUserId: 'A', partyRole: role, grantedBy: { kind: 'player', id: 'p1' }, policyVersions: ['jp-eng-2026-27-1'], particulars: { fullParticularsProvided: true, legalAdviceOffered: true }, ...over });
  ok(CONFLICT_OUTCOMES.length === 5 && OUTCOME_ALIASES.PERMITTED_WITH_CONSENT === PERMITTED_WITH_CONSENT, 'K1 five outcomes; PERMITTED_WITH_CONSENT is the accepted alias of the consent-required outcome (DR-51)');
  const e1 = run(tx());
  ok(e1.outcome === 'CLEAR' && codes(e1).includes('SINGLE_PARTY') && e1.policyVersions.join() === 'jp-fifa-2025-1,jp-eng-2026-27-1', 'K2 E1 England national, individual only → CLEAR under jp-eng-2026-27-1');
  ok(e1.reasons.some((r) => r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'JURISDICTION_OVERRIDE' && r.code === 'NATIONAL_RULE_APPLIES'), 'K3 inside England\'s national scope the FIFA entries read JURISDICTION_OVERRIDE and say which national rule applies');
  const e2 = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 1000 }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 500 }]));
  ok(e2.outcome === PERMITTED_WITH_CONSENT && e2.alias === 'PERMITTED_WITH_CONSENT' && e2.consentsOutstanding.map((c) => c.partyRole).sort().join() === 'engaging_entity,individual' && e2.requiredActions.every((a) => a.action === 'obtain_consent'), 'L1 E2 individual + engaging, no consents → consent required from BOTH parties (party-specific, never one checkbox)');
  const e3 = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 9000 }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 8000 }]), [consent('individual', { grantedAt: T0 - 9500 }), consent('engaging_entity', { grantedAt: T0 - 9500, grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]);
  ok(e3.outcome === 'CLEAR' && codes(e3).includes('DUAL_CONSENTED'), 'L2 E3 both consents in advance, with particulars and legal advice → CLEAR (DUAL_CONSENTED, ENG-6.3)');
  const e4 = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified', firstActAt: T0 - 1000 }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified', firstActAt: T0 - 500 }]), [consent('individual', { grantedAt: T0 - 100 }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]);
  neg(e4.outcome === PERMITTED_WITH_CONSENT && e4.consentsOutstanding[0].reasonCode === 'CONSENT_NOT_IN_ADVANCE', 'L3 E4 a consent dated after the agent first acted for a second party is not in advance');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { particulars: { fullParticularsProvided: false, legalAdviceOffered: true } }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]).consentsOutstanding[0].reasonCode === 'PARTICULARS_MISSING', 'L4 England: without the full particulars the consent is insufficient');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { particulars: { fullParticularsProvided: true, legalAdviceOffered: false } })]).consentsOutstanding.some((c) => c.reasonCode === 'LEGAL_ADVICE_NOT_OFFERED'), 'L5 …or without the legal-advice offer');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual'), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: false } })]).consentsOutstanding[0].reasonCode === 'SIGNATORY_REQUIRED', 'L6 a club consent from a non-signatory is insufficient');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { revokedAt: T0 - 1 }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]).consentsOutstanding[0].reasonCode === 'CONSENT_REVOKED', 'S1 E14 a revoked consent is consent required again');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { policyVersions: ['jp-eng-2026-27-0'] }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]).consentsOutstanding[0].reasonCode === 'CONSENT_POLICY_VERSION_STALE', 'S2 a consent naming a policy version that is not in effect is insufficient');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { contextId: 'ctx-OTHER' }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]).consentsOutstanding[0].reasonCode === 'CONSENT_MISSING', 'S3 a consent for another transaction context counts for nothing here');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual', { agentUserId: 'Z' }), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]).consentsOutstanding[0].reasonCode === 'CONSENT_MISSING', 'S4 a consent given to a different agent counts for nothing');
  neg(consentSufficiency(consent('individual', { status: 'declined', grantedAt: null }), { partyRole: 'individual', agentUserId: 'A', contextId: 'ctx-1' }).reasonCode === 'CONSENT_DECLINED', 'Q1 a declined consent is declined');
  const e5 = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' }]));
  neg(e5.outcome === 'PROHIBITED_CONFLICT' && e5.reasons.some((r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleId === 'ENG-6.4' && r.ruleStatus === 'ACTIVE') && e5.requiredActions[0].action === 'withdraw_a_representation', 'M1 E5 releasing club + individual, England → PROHIBITED_CONFLICT (ENG-6.4, ACTIVE)');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }, { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' }])).outcome === 'PROHIBITED_CONFLICT', 'M2 E5c engaging + releasing → prohibited');
  const e5b = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }]), [consent('individual'), consent('engaging_entity', { grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })]);
  ok(e5b.outcome === 'CLEAR', 'M3 E5b England permits multiple representation without the releasing club, with the four safeguards — England\'s table, not FIFA\'s');
  const e6 = run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }] }, [], int);
  neg(e6.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && e6.reasons.some((r) => r.code === 'RULE_STATUS_UNCERTAIN' && r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'UNDER_LEGAL_REVIEW') && e6.requiredActions[0].action === 'attributed_regulatory_review', 'N1 E6 international dimension, individual + engaging → MANUAL_REGULATORY_REVIEW_REQUIRED (FIFA-12.8 uncertain) — never CLEAR, never consent-required');
  const e6b = run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' }] }, [], int);
  neg(e6b.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && e6b.reasons.some((r) => r.ruleId === 'FIFA-12.9'), 'N2 E6b releasing + individual under the uncertain FIFA text → review, NOT PROHIBITED_CONFLICT by assumption');
  neg(run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }] }, [consent('individual', { policyVersions: ['jp-fifa-2025-1'] }), consent('engaging_entity', { policyVersions: ['jp-fifa-2025-1'], grantedBy: { kind: 'club_user', id: 'u9', signatory: true } })], int).outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'N3 consents do not cure an uncertain rule — no generic consent bypass');
  neg(run(tx({ representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'declared', declaredOnly: true }] })).outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && codes(run(tx({ representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'declared', declaredOnly: true }] }))).includes('REPRESENTATION_UNVERIFIED'), 'N4 a declared-only representation is a fact for attributed review, never CLEAR (DR-18)');
  neg(run(tx({ representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }], otherServices: [{ agentUserId: 'A', partyRole: 'engaging_entity', startedAt: T0 - 300 * DAY, kind: 'consultancy' }], jurisdictions: [{ memberAssociation: 'INT' }] }), [], int).reasons.some((r) => r.code === 'OTHER_SERVICES_PRESUMPTION' && r.ruleId === 'FIFA-15.3'), 'N5 E10 Other Services to the engaging club under FIFA → review (presumption, never prohibition)');
  ok(run(tx({ representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }], otherServices: [{ agentUserId: 'A', partyRole: 'engaging_entity', startedAt: T0 - 300 * DAY, kind: 'consultancy' }] })).outcome === PERMITTED_WITH_CONSENT, 'N6 England counts Other Services inside 6.3–6.5: the club enters the set and consent is required');
  neg(run(tx(), [], eng, { interests: [{ kind: 'agent_relationship', holderKind: 'club_user', holderId: 'u1', agentUserId: 'A' }] }).reasons.some((r) => r.code === 'INTEREST_DECLARED'), 'N7 E11 a declared interest linking a club user to the agent → review');
  const e8 = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' }]), [], eng, {});
  neg(e8.outcome === PERMITTED_WITH_CONSENT && e8.reasons.some((r) => r.code === 'CONNECTED_AGENT_ATTRIBUTION' && r.ruleId === 'ENG-6.5'), 'O1 E8 a colleague at the same agency serving the engaging club is attributed to the agent — consent required, never "different individual = no conflict"');
  neg(run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'B', partyRole: 'releasing_entity', status: 'verified' }])).outcome === 'PROHIBITED_CONFLICT', 'O2 E9 the colleague serving the releasing club makes it prohibited');
  const e8i = run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' }] }, [], int);
  neg(e8i.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && e8i.reasons.some((r) => r.code === 'CONNECTED_AGENT_ATTRIBUTION' && r.ruleId === 'FIFA-12.10'), 'O3 under the uncertain FIFA connected-agent rule the colleague case is ambiguous → review, still attributed');
  const e8n = run(dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' }]), [], eng, { transaction: { ...dual([{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'B', partyRole: 'engaging_entity', status: 'verified' }]), evaluateAgentUserIds: ['A'] } });
  neg(!e8n.reasons.some((r) => r.agentUserId === 'B'), 'O4 with the evaluated agent named, no reason judges the colleague — the colleague is an input to attribution, never a subject');
  neg(run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', isMinor: true }] })).outcome === 'INSUFFICIENT_DATA' && codes(run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', isMinor: true }] }))).includes('MINOR_PARTY'), 'W1 E12 a minor party without a guardian agreement consent → INSUFFICIENT_DATA');
  neg(run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', removed: true }] })).outcome === 'INSUFFICIENT_DATA' && codes(run(tx({ parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'p1', removed: true }] }))).includes('PARTY_REMOVED'), 'X1 a removed party → INSUFFICIENT_DATA');
  neg(run(tx({ type: 'offer' })).outcome === 'INSUFFICIENT_DATA' && run(tx({ jurisdictions: [] })).outcome === 'INSUFFICIENT_DATA', 'K4 an unknown type or an unresolved scope → INSUFFICIENT_DATA');
  neg(run(tx(), [], eng, { agents: { A: { licenceState: 'STALE', connectedAgentUserIds: [] } } }).outcome === 'INSUFFICIENT_DATA' && codes(run(tx(), [], eng, { agents: { A: { licenceState: 'STALE', connectedAgentUserIds: [] } } })).includes('AGENT_STATE_INVALID'), 'K5 an agent whose licence is not VERIFIED → INSUFFICIENT_DATA (defence in depth)');
  const mixed = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG', 'USA'], T0);
  neg(run({ ...tx(), jurisdictions: [{ memberAssociation: 'ENG' }, { memberAssociation: 'USA' }] }, [], mixed).reasons.some((r) => r.code === 'SCOPE_MIXED'), 'N8 E13 a transaction spanning England and a jurisdiction where the rule is not encoded → review (SCOPE_MIXED)');
  const a = run(tx()); const b = run(tx());
  ok(a.inputHash === b.inputHash && a.inputHash.length === 64 && inputHashOf({ b: 1, a: 2 }) === inputHashOf({ a: 2, b: 1 }), 'K6 E15/E17 the same inputs give the same hash; key order does not matter');
  neg(run(tx()).inputHash !== run(tx({ type: 'transfer' })).inputHash, 'K7 a different input is a different hash');
  const v2 = { ...SEEDED_POLICY_VERSIONS[0], id: 'jp-fifa-2025-2', policyVersion: 2, supersedes: 'jp-fifa-2025-1', effectiveFrom: '2026-09-01', rules: { ...SEEDED_POLICY_VERSIONS[0].rules, 'FIFA-12.8': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.8'], ruleStatus: 'ACTIVE' }, 'FIFA-12.9': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.9'], ruleStatus: 'ACTIVE' }, 'FIFA-12.10': { ...SEEDED_POLICY_VERSIONS[0].rules['FIFA-12.10'], ruleStatus: 'ACTIVE' } } };
  const int2 = applicablePolicySet([...SEEDED_POLICY_VERSIONS, v2], ['INT'], T0);
  ok(run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }] }, [], int2).outcome === PERMITTED_WITH_CONSENT && run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'releasing_entity', status: 'verified' }] }, [], int2).outcome === 'PROHIBITED_CONFLICT', 'C11 E16 a later FIFA version with 12(8)–(10) ACTIVE turns E6 into consent-required and E6b into prohibited — a data change, not code');
  const v3 = { ...v2, id: 'jp-fifa-2025-3', policyVersion: 3, rules: { ...v2.rules, 'FIFA-12.8': { ...v2.rules['FIFA-12.8'], ruleStatus: 'SUSPENDED' } } };
  const susp = run({ ...tx(), jurisdictions: [{ memberAssociation: 'INT' }], representations: [{ agentUserId: 'A', partyRole: 'individual', status: 'verified' }, { agentUserId: 'A', partyRole: 'engaging_entity', status: 'verified' }] }, [], applicablePolicySet([...SEEDED_POLICY_VERSIONS, v2, v3], ['INT'], T0));
  neg(susp.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED' && codes(susp).includes('RULE_SUSPENDED') && codes(susp).includes('NO_ACTIVE_RULE_DECIDES'), 'D4 E18 a SUSPENDED deciding rule contributes a reason and never a permission: with no ACTIVE rule deciding, review');
  const s = conflictSummaryForParty(e8);
  neg(!('reasons' in s) && Array.isArray(s.reasonCodes) && !JSON.stringify(s).includes('"B"'), 'Z1 the party-facing summary carries codes only, never the other side\'s agents');
  neg(!JSON.stringify(run(tx()).reasons).match(/name|email|@|fee/i), 'Z2 E20 reasons carry codes and rule references only');
}

// ============================================================ U/V/W — minors gate (pure)
section('U/V/W — the minors gate: jurisdiction-aware, guardian-first, accreditation-bound, fail-closed');
{
  const eng = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['ENG'], T0);
  const int = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['INT'], T0);
  const usa = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['USA'], T0);
  const facets = { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' }, domestic_authorisation: {}, minors_authorisation: { ENG: 'VERIFIED', INT: 'VERIFIED' } };
  const timing = ruleAt(eng.policies, 'ENG-5.1', T0);
  ok(new Date(earliestPermittedApproachAt('2011-03-15', timing).at).toISOString().startsWith('2026-09-01') && new Date(earliestPermittedApproachAt('2011-09-15', timing).at).toISOString().startsWith('2027-09-01'), 'U1 England: a minor reaching 16 on 15 Mar 2027 is approachable from 1 Sep 2026; one reaching 16 on 15 Sep 2027 only from 1 Sep 2027 (FA 2026-27 reg. 5.1)');
  neg(earliestPermittedApproachAt('2011-03-15', ruleAt(int.policies, 'FIFA-13.1', T0), { employingCountry: 'FRA' }).at === null && earliestPermittedApproachAt('2011-03-15', ruleAt(int.policies, 'FIFA-13.1', T0)).reason === 'MINOR_TIMING_NOT_ENCODED', 'U2 the FIFA formula needs a first-contract age that is encoded for NO country → not computable');
  ok(isRegulatoryMinor('2011-03-15', T0) === true && isRegulatoryMinor('2008-09-17', T0) === false && isRegulatoryMinor('2008-09-19', T0) === true && isRegulatoryMinor('nope', T0) === null, 'U3 regulatory minor = under 18 on the day, a separate predicate from the visibility age (DR-14)');
  const g = (args) => evaluateMinorGate({ policySet: eng.policies, missingPolicies: eng.missing, now: T0, facets, memberAssociation: 'ENG', ...args });
  neg(g({ dob: '2011-09-15' }).blocked === true && codes(g({ dob: '2011-09-15' })).includes('MINOR_APPROACH_NOT_PERMITTED') && !JSON.stringify(g({ dob: '2011-09-15' }).reasons).includes('2027'), 'U4 before the date: blocked, reason timing, and NO date in the reasons (DR-16)');
  ok(g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY, revokedAt: null }] }).allowed === true, 'U5 on/after the date, with ENG minors authorisation, FA registration, FIFA licence and a PRIOR guardian approach consent → the gate passes');
  neg(g({ dob: '2011-03-15' }).requiresGuardian === true && codes(g({ dob: '2011-03-15' })).includes('GUARDIAN_CONSENT_REQUIRED'), 'V1 without a prior guardian consent the gate does not pass');
  neg(g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 + 1, revokedAt: null }] }).requiresGuardian === true, 'V2 a guardian consent dated AFTER the evaluation moment is not prior consent — no retroactive consent');
  neg(g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY, revokedAt: T0 - 1 }] }).requiresGuardian === true, 'V3 a revoked guardian consent is no consent');
  neg(g({ dob: '2011-03-15', facets: { ...facets, minors_authorisation: {} }, guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] }).requiresMinorAccreditation === true, 'W2 without the agent\'s own minors authorisation the gate fails — agency affiliation is never enough');
  neg(g({ dob: '2011-03-15', facets: { ...facets, minors_authorisation: { ENG: 'STALE', INT: 'VERIFIED' } }, guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] }).requiresMinorAccreditation === true, 'W3 a STALE minors authorisation (expired three-year window) fails the gate');
  neg(g({ dob: '2011-03-15', blocked: true, guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] }).blocked === true && codes(g({ dob: '2011-03-15', blocked: true })).includes('SAFEGUARDING_BLOCK'), 'X2 a block wins over every regulatory condition');
  const fra = applicablePolicySet(SEEDED_POLICY_VERSIONS, ['FRA'], T0);
  neg(evaluateMinorGate({ dob: '2011-03-15', memberAssociation: 'FRA', facets, policySet: fra.policies, missingPolicies: fra.missing, now: T0 }).blocked === true && codes(evaluateMinorGate({ dob: '2011-03-15', memberAssociation: 'FRA', facets, policySet: fra.policies, missingPolicies: fra.missing, now: T0 })).includes('POLICY_NOT_ENCODED'), 'U6 a non-encoded jurisdiction: blocked, review — the England formula is NEVER applied elsewhere (DR-48)');
  neg(evaluateMinorGate({ dob: '2011-03-15', memberAssociation: 'INT', facets, policySet: int.policies, missingPolicies: int.missing, now: T0, guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] }).blocked === true && codes(evaluateMinorGate({ dob: '2011-03-15', memberAssociation: 'INT', facets, policySet: int.policies, missingPolicies: int.missing, now: T0 })).includes('INSUFFICIENT_DATA'), 'U7 the FIFA formula alone is INSUFFICIENT_DATA → refused (DR-49)');
  neg(evaluateMinorGate({ dob: '2011-03-15', memberAssociation: 'USA', facets, policySet: usa.policies, missingPolicies: usa.missing, now: T0 }).blocked === true, 'U8 the U.S. minors rule is UNKNOWN → refused');
  ok(evaluateMinorGate({ dob: '2000-03-15', memberAssociation: 'ENG', facets, policySet: eng.policies, now: T0 }).isRegulatoryMinor === false && codes(evaluateMinorGate({ dob: '2000-03-15', memberAssociation: 'ENG', facets, policySet: eng.policies, now: T0 })).includes('NOT_A_MINOR'), 'W4 an adult is not gated');
  const turned = evaluateMinorGate({ dob: '2008-09-17', memberAssociation: 'ENG', facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } }, policySet: eng.policies, now: T0 });
  ok(turned.isRegulatoryMinor === false && evaluateMinorGate({ dob: '2008-09-17', memberAssociation: 'ENG', facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } }, policySet: eng.policies, now: T0 - 2 * DAY }).isRegulatoryMinor === true, 'W5 age transition: the same person is a minor two days ago and an adult today — authority is re-derived from the clock, never cached');
  neg(Object.values(MINOR_PATHWAY_PRODUCTION_ENABLED).every((v) => v === false) && g({ dob: '2011-03-15', guardianConsents: [{ kind: 'guardian_approach', grantedAt: T0 - DAY }] }).pathwayEnabledInProduction === false, 'U9 NO jurisdiction has a production minor pathway enabled, even where the gate can pass');
}

// ============================================================ Z — contracts (pure)
section('Z — error contract, permissions, registry, notifications, rate policies, stores');
{
  ok(Object.getPrototypeOf(M25_ERROR_HTTP) === null && M25_ERROR_HTTP.constructor === undefined, 'Z3 the error table is null-prototype');
  neg(M25_ERROR_HTTP.REVIEWER_AUTH_REQUIRED === 401 && M25_ERROR_HTTP.REPRESENTATION_CONFLICT === 403 && M25_ERROR_HTTP.CONSENT_REQUIRED === 422 && M25_ERROR_HTTP.REGULATORY_REVIEW_REQUIRED === 422 && M25_ERROR_HTTP.REGULATORY_PROVIDER_UNAVAILABLE === 503 && M25_ERROR_HTTP.CONTEXT_NOT_FOUND === 404 && M25_ERROR_HTTP.REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE === 409, 'Z4 codes map to the right statuses');
  const pub = publicErrorBody({ error: 'CONSENT_REQUIRED', stack: 'x', reviewerNote: 'private', reasons: [{ code: 'CONSENT_REQUIRED', ruleId: 'ENG-6.3', ruleStatus: 'ACTIVE', note: 'prose', agentUserId: 'A' }], consentsOutstanding: [{ partyRole: 'individual', consentKind: 'dual_representation', reasonCode: 'CONSENT_MISSING', agentUserId: 'A' }] });
  neg(pub.stack === undefined && pub.reviewerNote === undefined && pub.reasons[0].note === undefined && pub.reasons[0].agentUserId === undefined && pub.consentsOutstanding[0].agentUserId === undefined && PUBLIC_ERROR_FIELDS.includes('reasons'), 'Z5 error bodies are whitelisted; reasons and outstanding consents shed prose and agent ids');
  ok(can(['licensed_agent'], 'compliance.contexts.write') && can(['analyst'], 'compliance.read'), 'Z6 the matrix grants context writes to licensed agents only and reads to every member');
  neg(!can(['agency_admin'], 'compliance.contexts.write') && !can(['assistant'], 'compliance.contexts.write') && !can(['finance'], 'compliance.contexts.write') && can(TIERS_ALL(), 'review.resolve') === false, 'Z7 an administrator, assistant or finance member cannot open a context; no agency role can resolve a review');
  for (const e of ['regulatory_review_requested', 'regulatory_review_started', 'regulatory_review_resolved', 'conflict_evaluated', 'regulatory_consent_requested', 'regulatory_consent_granted', 'regulatory_consent_declined', 'regulatory_consent_revoked', 'agent_authorisation_state_changed']) {
    const r = EVENT_REGISTRY[e];
    ok(!!r && r.audience === 'org_private' && r.privacyClass === 'org_internal' && r.replayPolicy === 'never' && r.analyticsEligible === false && r.payload.every((k) => /Id$|^kind$|^outcome$|^state$/.test(k)), `AE1 ${e} is org_private, never replayed, never analytics, ids and state words only`);
  }
  ok(EVENT_REGISTRY.policy_version_published?.audience === 'public_safe' && EVENT_REGISTRY.policy_version_published.payload.length === 0, 'AE2 a policy publication is a content-free public ping');
  for (const t of ['regulatory_review_required', 'regulatory_review_completed', 'regulatory_consent_requested', 'regulatory_consent_granted', 'regulatory_consent_declined', 'regulatory_consent_revoked', 'agent_verification_stale']) ok(TYPE_CATEGORY[t] === 'compliance', `AF1 notification ${t} → compliance category`);
  ok(CATEGORIES.compliance.mandatory === true && CATEGORIES.compliance.default === true, 'AF2 the compliance category is mandatory — a regulatory obligation cannot be muted');
  for (const [k, scope] of [['compliance_context_write', 'actor'], ['compliance_consent_request', 'actor'], ['compliance_consent_response', 'actor'], ['ts_review_decision', 'actor'], ['ts_policy_publish', 'actor']]) ok(RATE_LIMIT_POLICY[k]?.scope === scope && RATE_LIMIT_POLICY[k].max > 0, `Z8 rate policy ${k}`);
  for (const s of ['tsReviewers', 'jurisdictionPolicies', 'regulatoryReviews', 'regulatoryConsents', 'complianceContexts']) ok(guaranteeFor(s) === 'migration' && PRODUCTION_REQUIRED_STORES.includes(s), `AD1 ${s} is migration-guaranteed and production-required`);
  const step = MIGRATIONS.find((m) => m.id === 'm250_001_compliance_stores');
  ok(step?.version === 2306 && SCHEMA_VERSION === 2306 && MIGRATIONS.filter((m) => m.version === 2306).length === 1, 'AD2 exactly one step advances the schema to 2306');
  neg(guaranteeFor('agentTransactions') !== 'migration' && guaranteeFor('transactionRepresentations') !== 'migration' && guaranteeFor('offers') !== 'migration' && guaranteeFor('agencyInvoices') !== 'migration', 'AD3 no transaction, offer or invoice store was created — P5.6C owns evaluation, not the Transaction Room');
  ok(COMPLIANCE_AUDIT_ACTIONS.has('regulatory_review_resolved') && COMPLIANCE_AUDIT_ACTIONS.has('regulatory_consent_revoked') && !COMPLIANCE_AUDIT_ACTIONS.has('offer_made'), 'AE3 the audit projection lists review, consent and context actions and no offer action');
}
function TIERS_ALL() { return ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance']; }

// =================================================================== HTTP
section('HTTP — booting a real server (synthetic verification provider ON)');
const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } } });
async function boot(env = {}) {
  const proc = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), DATA_DIR, M13_QUIET_LOGS: '1', AGENT_VERIFICATION_TEST_PROVIDER: '1', ...env }, stdio: 'ignore' });
  children.push(proc); proc.unref();
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { try { up = (await fetch(`${BASE}/healthz`)).ok; } catch { /* booting */ } if (!up) await sleep(250); }
  if (!up) throw new Error('server did not come up');
  return proc;
}
let server = await boot();
async function j(method, url, body, token, extra = {}) {
  const r = await fetch(`${BASE}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body: data };
}
const login = async (orgId, scoutName, role, platform = 'agent') => (await j('POST', '/auth/org/login', { orgId, scoutName, role, ...(platform ? { platform } : {}) })).body;
const playerLogin = async (playerId) => (await j('POST', '/auth/player/login', { playerId })).body;
const reviewerLogin = async (reviewerId, secret) => (await j('POST', '/auth/reviewer/login', { reviewerId, secret }));
async function sseCollect(token, ms) {
  const t = await j('POST', '/events/ticket', undefined, token);
  const ac = new AbortController(); const frames = [];
  const res = await fetch(`${BASE}/events?ticket=${encodeURIComponent(t.body.ticket)}`, { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  const done = (async () => { try { for (;;) { const { value, done: d } = await reader.read(); if (d) break; frames.push(dec.decode(value)); } } catch { /* aborted */ } })();
  return { stop: async () => { await sleep(ms); ac.abort(); await done; return frames.join(''); } };
}
const ERROR_BODIES = [];
const collect = (label, r) => { if (r.status >= 400) ERROR_BODIES.push({ label, status: r.status, body: r.body }); return r; };

// ============================================================ A — G-C0
section('A — G-C0: reviewer identity is authenticated, derived by the server, and never the shared key');
let PRIYA, MARCUS, LEA;
{
  ok((await j('GET', '/healthz')).body.schemaVersion === 2306, 'A0 schema 2306');
  neg(expect(collect('A1', await j('GET', '/ts/compliance/reviews', undefined, null, ADMIN)), 401, 'REVIEWER_AUTH_REQUIRED'), 'A1 the shared admin key alone gets no reviewer lane (#1)');
  neg(expect(collect('A2', await j('POST', '/ts/compliance/reviews/rrv-1/resolve', { outcome: 'APPROVED' }, null, ADMIN)), 401, 'REVIEWER_AUTH_REQUIRED'), 'A2 …and cannot resolve anything');
  PRIYA = (await reviewerLogin('tsr-dev-admin', 'dev-reviewer-admin')).body;
  ok(PRIYA?.token && PRIYA.reviewer.id === 'tsr-dev-admin' && PRIYA.reviewer.role === 'trust_safety_admin' && PRIYA.reviewer.secretHash === undefined, 'A3 a reviewer logs in with credentials; the response carries no secret hash');
  const me = await j('GET', '/ts/me', undefined, PRIYA.token);
  ok(me.status === 200 && me.body.reviewer.id === 'tsr-dev-admin' && me.body.attribution === 'authenticated_reviewer', 'A4 /ts/me resolves the identity from the session');
  neg(expect(collect('A5', await reviewerLogin('tsr-dev-admin', 'wrong')), 401, 'REVIEWER_CREDENTIALS_INVALID') && expect(collect('A5b', await reviewerLogin('tsr-nobody', 'dev-reviewer-admin')), 401, 'REVIEWER_CREDENTIALS_INVALID'), 'A5 a wrong secret and an unknown id fail alike');
  MARCUS = (await reviewerLogin('tsr-dev-reviewer', 'dev-reviewer')).body;
  LEA = (await reviewerLogin('tsr-dev-admin2', 'dev-reviewer-admin2')).body;
  ok(MARCUS?.reviewer.role === 'trust_safety_reviewer' && LEA?.reviewer.role === 'trust_safety_admin', 'A6 a reviewer and a second administrator log in');
  neg(expect(collect('A7', await j('POST', '/ts/reviewers', { id: 'tsr-x', name: 'X', role: 'trust_safety_reviewer', secret: 'twelve-characters!' }, MARCUS.token)), 403, 'REVIEWER_ROLE_REQUIRED'), 'A7 a reviewer cannot provision reviewers');
  neg(expect(collect('A8', await j('POST', '/ts/reviewers', { id: 'tsr-temp', name: 'Temp', role: 'trust_safety_reviewer', secret: 'short' }, PRIYA.token)), 400, 'COMPLIANCE_INPUT_INVALID') && expect(collect('A8b', await j('POST', '/ts/reviewers', { id: 'tsr-temp', name: 'Temp', role: 'god', secret: 'twelve-characters!' }, PRIYA.token)), 400, 'COMPLIANCE_INPUT_INVALID'), 'A8 a short secret and an unknown role are refused');
  const temp = await j('POST', '/ts/reviewers', { id: 'tsr-temp', name: 'Temp Reviewer', role: 'trust_safety_reviewer', secret: 'twelve-characters!' }, PRIYA.token);
  ok(temp.status === 201 && temp.body.reviewer.status === 'active', 'A9 an administrator provisions a reviewer');
  neg(expect(collect('A10', await j('POST', '/ts/reviewers', { id: 'tsr-temp', name: 'Temp Reviewer', role: 'trust_safety_reviewer', secret: 'twelve-characters!' }, PRIYA.token)), 409, 'REVIEWER_EXISTS'), 'A10 not twice');
  const TEMP = (await reviewerLogin('tsr-temp', 'twelve-characters!')).body;
  ok((await j('GET', '/ts/me', undefined, TEMP.token)).body.reviewer.id === 'tsr-temp', 'A11 the new reviewer logs in');
  const rv = await j('POST', '/ts/reviewers/tsr-temp/revoke', { reason: 'left', expectedRev: 1 }, PRIYA.token);
  ok(rv.status === 200 && rv.body.reviewer.status === 'revoked', 'B1 the administrator revokes the reviewer');
  const dead = collect('B2', await j('GET', '/ts/me', undefined, TEMP.token));
  neg(dead.status === 401 && ['REVIEWER_REVOKED', 'REVIEWER_AUTH_REQUIRED'].includes(dead.body.error), 'B2 the stale session is dead at once — revocation removes the sessions themselves (#3)');
  neg(expect(collect('B3', await reviewerLogin('tsr-temp', 'twelve-characters!')), 401, 'REVIEWER_CREDENTIALS_INVALID'), 'B3 and the revoked reviewer cannot log back in');
  ok((await j('POST', '/ts/reviewers/tsr-temp/revoke', {}, PRIYA.token)).body.idempotent === true, 'B4 revoking again is idempotent');
  neg(expect(collect('B5', await j('POST', '/ts/reviewers/tsr-nobody/revoke', {}, PRIYA.token)), 404, 'REVIEWER_NOT_FOUND'), 'B5 an unknown reviewer is 404');
  const list = await j('GET', '/ts/reviewers', undefined, LEA.token);
  ok(list.status === 200 && list.body.items.length === 4 && /shared_admin_key/.test(list.body.legacyNote) && list.body.items.every((r) => r.secretHash === undefined), 'A12 the reviewer list names four reviewers, no secrets, and states how legacy shared-key records are preserved');
  const ro = await j('GET', '/admin/compliance/reviews', undefined, null, ADMIN);
  ok(ro.status === 200 && ro.body.readOnly === true && /adjudicate nothing/.test(ro.body.note), 'A13 the legacy shared key reads reviews read-only and says so');
  neg(expect(collect('A14', await j('POST', '/admin/compliance/reviews/rrv-1/resolve', { outcome: 'APPROVED' }, null, ADMIN)), 404, null) && expect(collect('A14b', await j('POST', '/admin/agent/relationships/rep-1/resolve', {}, null, ADMIN)), 404, null), 'A14 no shared-key mutation route exists for reviews or relationships');
}

// ============================================================ setup — agency, agents, players
section('setup — agency members, profiles, verified facets, relationships');
const tomas = await login('org-northstar', 'Tomás Rivera', 'Director');
const maria = await login('org-eastport', 'Maria Keane', 'Head of Recruitment', null);
const harbour = await login('org-harbour', 'Dev Ansah', 'Coach', null);
const kola = await playerLogin('pl-adeyemi');
const mateus = await playerLogin('pl-carvalho');
const chinedu = await playerLogin('pl-okafor');
const filip = await playerLogin('pl-nowak');
const theo = await playerLogin('pl-martin');
const guni = await playerLogin('pl-guni');
let ANA, DAN, BEN, EVE, ANA_ID, DAN_ID, EVE_ID, REL_KOLA, REL_MATEUS, REL_CHINEDU, REL_THEO;
{
  const add = async (name, tiers) => (await j('POST', '/org/agent/agency/team', { name, tiers }, tomas.token)).body.member;
  ANA_ID = (await add('Ana Costa', ['licensed_agent'])).userId;
  DAN_ID = (await add('Dan Mensah', ['licensed_agent'])).userId;
  EVE_ID = (await add('Eve Laurent', ['licensed_agent'])).userId;
  await add('Ben Okoro', ['analyst']);
  ANA = await login('org-northstar', 'Ana Costa', 'Agent');
  DAN = await login('org-northstar', 'Dan Mensah', 'Agent');
  EVE = await login('org-northstar', 'Eve Laurent', 'Agent');
  BEN = await login('org-northstar', 'Ben Okoro', 'Analyst');
  const prof = async (tok, name, jur) => (await j('POST', '/org/agent/profile', { displayName: name, jurisdictions: jur }, tok)).status;
  ok(await prof(ANA.token, 'Ana Costa', ['ENG', 'INT']) === 201 && await prof(DAN.token, 'Dan Mensah', ['ENG']) === 201 && await prof(EVE.token, 'Eve Laurent', ['INT', 'ENG']) === 201, 'S1 three agent profiles');
  const sub = (tok, facet, reference, ma) => j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, ...(ma ? { memberAssociation: ma } : {}) }, tok);
  ok((await sub(ANA.token, 'fifa_licence', 'TEST-VERIFIED-ANA')).body.facet.state === 'VERIFIED' && (await sub(ANA.token, 'national_registration', 'TEST-VERIFIED-ANA-FA', 'ENG')).body.facet.state === 'VERIFIED', 'G5 Ana: FIFA licence and FA registration VERIFIED by the synthetic provider');
  ok((await sub(DAN.token, 'fifa_licence', 'TEST-VERIFIED-DAN')).body.facet.state === 'VERIFIED' && (await sub(DAN.token, 'national_registration', 'TEST-VERIFIED-DAN-FA', 'ENG')).body.facet.state === 'VERIFIED', 'G6 Dan likewise');
  const req = async (tok, playerId, over = {}) => (await j('POST', '/org/agent/clients/request', { playerId, scope: ['employment', 'transfer'], jurisdiction: 'ENG', ...over }, tok));
  const r1 = await req(ANA.token, 'pl-adeyemi'); REL_KOLA = r1.body?.relationship?.id;
  ok(r1.status === 201 && (await j('POST', `/player/agent/relationships/${REL_KOLA}/confirm`, { expectedRev: 1 }, kola.token)).body.relationship.status === 'active', 'S2 Ana ↔ Kola: ENG employment + transfer, confirmed');
  const r2 = await req(ANA.token, 'pl-carvalho', { jurisdiction: 'INT', scope: ['employment'] }); REL_MATEUS = r2.body?.relationship?.id;
  ok(r2.status === 201 && (await j('POST', `/player/agent/relationships/${REL_MATEUS}/confirm`, { expectedRev: 1 }, mateus.token)).body.relationship.status === 'active', 'S3 Ana ↔ Mateus: INT employment, confirmed');
  const r3 = await req(DAN.token, 'pl-okafor'); REL_CHINEDU = r3.body?.relationship?.id;
  ok(r3.status === 201 && (await j('POST', `/player/agent/relationships/${REL_CHINEDU}/confirm`, { expectedRev: 1 }, chinedu.token)).body.relationship.status === 'active', 'S4 Dan ↔ Chinedu: ENG, confirmed');
  const r4 = await req(ANA.token, 'pl-martin', { scope: ['commercial'] }); REL_THEO = r4.body?.relationship?.id;
  ok(r4.status === 201 && (await j('POST', `/player/agent/relationships/${REL_THEO}/confirm`, { expectedRev: 1 }, theo.token)).body.relationship.status === 'active', 'S5 Ana ↔ Theo: ENG commercial only, confirmed');
  ok(r1.body.relationship.policyVersion === 1 && Array.isArray(r1.body.relationship.history) , 'S6 relationship records carry their policy versions');
}

// ============================================================ G/H/I — provider over HTTP; the facet review lane
section('G/H/I/R — provider states over HTTP; a facet that needs review is decided by a NAMED reviewer');
let EVE_REVIEW, EVE_REVIEW2;
{
  const sub = (tok, facet, reference, ma) => j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, ...(ma ? { memberAssociation: ma } : {}) }, tok);
  const stale = await sub(EVE.token, 'fifa_licence', 'TEST-STALE-EVE');
  neg(stale.status === 200 && stale.body.facet.state === 'STALE' && stale.body.facet.storedState === 'VERIFIED', 'H2 a STALE answer stores VERIFIED with a lapsed recheck date and READS stale');
  neg(expect(collect('H3', await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', jurisdiction: 'INT' }, EVE.token)), 403, 'AGENT_VERIFICATION_REQUIRED') && (await j('POST', '/org/agent/clients/request', { playerId: 'pl-tanaka', jurisdiction: 'INT' }, EVE.token)).body.state === 'STALE', 'H3 a stale licence authorises no approach (#5)');
  const rc = await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, EVE.token);
  neg(rc.status === 200 && rc.body.facet.state === 'STALE', 'H4 a recheck against the same stale reference stays stale — the recheck is honest, not a refresh button');
  neg(expect(collect('H5', await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'H5 an analyst cannot recheck a licence');
  const un = await sub(EVE.token, 'national_registration', 'TEST-UNAVAILABLE-1', 'ENG');
  neg(expect(collect('I4', un), 503, 'REGULATORY_PROVIDER_UNAVAILABLE') && typeof un.body.retryAfter === 'number' && (await j('GET', '/org/agent/profile', undefined, EVE.token)).body.profile.facets.national_registration.ENG === undefined, 'I4 a provider outage answers 503 and writes NOTHING (#18)');
  const nv = await sub(EVE.token, 'national_registration', 'TEST-NOTVERIFIED-1', 'ENG');
  neg(nv.status === 200 && nv.body.facet.state === 'UNVERIFIED' && /No matching record/.test(nv.body.facet.note), 'I5 NOT_VERIFIED is recorded as UNVERIFIED with the honest note');
  const ev = await sub(EVE.token, 'fifa_licence', 'TEST-VERIFIED-EVE');
  ok(ev.body.facet.state === 'VERIFIED', 'G7 Eve re-verifies the licence');
  const dom = await sub(EVE.token, 'domestic_authorisation', 'TEST-VERIFIED-BGC', 'USA');
  ok(dom.status === 200 && dom.body.profile.facets.domestic_authorisation.USA.state === 'VERIFIED', 'G8 the fourth facet, domestic authorisation, is recorded separately (USA background check + SafeSport)');
  const manual = await sub(EVE.token, 'national_registration', 'FA-REAL-42', 'ENG');
  neg(manual.status === 200 && manual.body.facet.state === 'MANUAL_REVIEW_REQUIRED' && /queued for attributed/.test(manual.body.facet.note), 'R1 a real-looking reference is MANUAL_REVIEW_REQUIRED and says it is queued for attributed review');
  const ov = await j('GET', '/org/agent/compliance/overview', undefined, EVE.token);
  ok(ov.status === 200 && ov.body.counts.reviewsPending === 1 && ov.body.reviews[0].kind === 'verification_facet' && ov.body.reviews[0].status === 'PENDING' && ov.body.provider.live === false && ov.body.freshness.some((f) => f.facet === 'fifa_licence' && f.state === 'VERIFIED' && typeof f.daysUntilRecheck === 'number'), 'R2 Eve\'s overview shows one pending review, the honest provider status and facet freshness');
  neg(!JSON.stringify(ov.body.reviews).includes('FA-REAL-42') && ov.body.reviews[0].decision === null, 'R3 the agent\'s review projection carries no reference and no reviewer material');
  EVE_REVIEW = ov.body.reviews[0].id;
  const list = await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, MARCUS.token);
  ok(list.status === 200 && list.body.items.some((r) => r.id === EVE_REVIEW) && list.body.reviewer.id === 'tsr-dev-reviewer', 'R4 the reviewer sees the pending item');
  const detail = await j('GET', `/ts/compliance/reviews/${EVE_REVIEW}`, undefined, MARCUS.token);
  ok(detail.status === 200 && detail.body.subjectDetail.reference === 'FA-REAL-42' && detail.body.subjectDetail.agentDisplayName === 'Eve Laurent' && detail.body.review.honest.includes('not a legal determination'), 'R5 the reviewer sees exactly the review\'s need: the reference, the agent name, the state — and the honest framing');
  neg(expect(collect('R6', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'APPROVED', reasonCode: 'fa_list_match', reason: 'Listed on the FA register of 18 Sep 2026.' }, MARCUS.token)), 400, 'REVIEW_INPUT_INVALID'), 'R6 an approval without evidence references is refused');
  neg(expect(collect('R7', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'MAYBE', reasonCode: 'x', reason: 'y', evidenceRefs: ['e'] }, MARCUS.token)), 400, 'REVIEW_INPUT_INVALID'), 'R7 an unknown outcome is refused');
  neg(expect(collect('R8', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/start`, { expectedRev: 9 }, MARCUS.token)), 409, 'REVIEW_VERSION_CONFLICT'), 'AA1 a stale rev is refused');
  const start = await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/start`, { expectedRev: 1 }, MARCUS.token);
  ok(start.status === 200 && start.body.review.status === 'IN_REVIEW' && start.body.review.startedBy.id === 'tsr-dev-reviewer', 'R9 Marcus starts the review; it is attributed to him');
  const before = Date.now();
  const res = await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'APPROVED', reasonCode: 'fa_list_match', reason: 'Listed on the FA register of 18 Sep 2026.', evidenceRefs: ['FA registered agents list 2026-09-18, row 412'], reviewerId: 'tsr-dev-admin', decidedAt: 1_000, at: 1_000, clientKey: 'eve-fa-1' }, MARCUS.token);
  ok(res.status === 200 && res.body.review.status === 'APPROVED' && res.body.review.decision.reviewer.id === 'tsr-dev-reviewer' && res.body.review.decision.reviewer.name === 'Marcus Bell' && res.body.review.decision.reviewer.role === 'trust_safety_reviewer', 'A15 the decision is attributed to Marcus — the reviewer who held the session');
  neg(res.body.review.decision.reviewer.id !== 'tsr-dev-admin', 'A16 a forged reviewerId in the body is ignored: Marcus cannot be mistaken for Priya (#2)');
  neg(res.body.review.decision.at >= before && res.body.review.decidedAt >= before, 'A17 the decision time is the server clock; a backdated timestamp in the body is ignored');
  ok(res.body.review.decision.evidenceRefs.length === 1 && res.body.review.decision.policyVersions.includes('jp-eng-2026-27-1') && res.body.review.decision.priorState.facetState === 'MANUAL_REVIEW_REQUIRED' && res.body.review.decision.resultingState.facetState === 'VERIFIED', 'A18 the record carries evidence, policy versions, prior and resulting state');
  const prof = await j('GET', '/org/agent/profile', undefined, EVE.token);
  ok(prof.body.profile.facets.national_registration.ENG.state === 'VERIFIED' && prof.body.profile.facets.national_registration.ENG.provenance.provider === 'attributed_review' && prof.body.profile.facets.national_registration.ENG.provenance.reviewerId === 'tsr-dev-reviewer' && typeof prof.body.profile.facets.national_registration.ENG.recheckAt === 'number', 'R10 the facet is VERIFIED with attributed-review provenance naming the reviewer and a recheck date');
  ok((await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'APPROVED', reasonCode: 'fa_list_match', reason: 'Listed on the FA register of 18 Sep 2026.', evidenceRefs: ['FA registered agents list 2026-09-18, row 412'], clientKey: 'eve-fa-1' }, MARCUS.token)).body.idempotent === true, 'AB1 replaying the decision with its key is idempotent — no duplicate decision (#29)');
  neg(expect(collect('AB2', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'REJECTED', reasonCode: 'x', reason: 'y', clientKey: 'eve-fa-1' }, MARCUS.token)), 409, 'REVIEW_IDEMPOTENCY_CONFLICT'), 'AB2 the same key with a different decision is a collision');
  neg(expect(collect('R11', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW}/resolve`, { outcome: 'REJECTED', reasonCode: 'x', reason: 'y' }, PRIYA.token)), 409, 'REVIEW_NOT_PENDING'), 'R11 a decided review cannot be decided again');
  const audit = await j('GET', '/ts/compliance/audit', undefined, PRIYA.token);
  ok(audit.status === 200 && audit.body.items.some((x) => x.reviewId === EVE_REVIEW && x.action === 'regulatory_review_resolved' && x.reviewer.reviewerId === 'tsr-dev-reviewer' && x.reviewer.attribution === 'authenticated_reviewer' && x.evidenceRefs.length === 1 && x.outcome === 'APPROVED'), 'A19 the Trust & Safety audit preserves the reviewer identity, role, evidence and outcome');
  neg(expect(collect('A20', await j('GET', '/ts/compliance/audit', undefined, ANA.token)), 401, 'REVIEWER_AUTH_REQUIRED') && expect(collect('A20b', await j('GET', '/ts/compliance/reviews', undefined, kola.token)), 401, 'REVIEWER_AUTH_REQUIRED'), 'A20 an agent or a player token is not a reviewer (#5 foreign user)');
  // Concurrency: two reviewers decide the same review at once.
  const m2 = await sub(EVE.token, 'minors_authorisation', 'FA-MIN-1', 'ENG');
  EVE_REVIEW2 = (await j('GET', '/org/agent/compliance/overview', undefined, EVE.token)).body.reviews.find((r) => r.status === 'PENDING')?.id;
  ok(m2.body.facet.state === 'MANUAL_REVIEW_REQUIRED' && EVE_REVIEW2, 'R12 a second facet review is pending');
  const body = (code) => ({ outcome: 'APPROVED', reasonCode: code, reason: 'concurrent', evidenceRefs: ['FA letter'], expectedRev: 1 });
  const [c1, c2] = await Promise.all([j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/resolve`, body('one'), MARCUS.token), j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/resolve`, body('two'), PRIYA.token)]);
  const wins = [c1, c2].filter((r) => r.status === 200); const loses = [c1, c2].filter((r) => r.status === 409);
  neg(wins.length === 1 && loses.length === 1 && ['REVIEW_VERSION_CONFLICT', 'REVIEW_NOT_PENDING'].includes(loses[0].body.error), 'R13 two reviewers resolving at once: exactly one wins, the other gets 409, no double final state (#30)');
  const one = await j('GET', `/ts/compliance/reviews/${EVE_REVIEW2}`, undefined, LEA.token);
  ok(one.body.review.status === 'APPROVED' && ['tsr-dev-reviewer', 'tsr-dev-admin'].includes(one.body.review.decision.reviewer.id) && one.body.review.history === undefined, 'R14 one decision, one named reviewer');
  // Supersession keeps the old decision.
  const sup = await j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/supersede`, { reason: 'New evidence: the FA letter was withdrawn.' }, PRIYA.token);
  ok(sup.status === 201 && sup.body.review.status === 'PENDING' && sup.body.review.supersedes === EVE_REVIEW2 && sup.body.superseded.status === 'SUPERSEDED' && sup.body.superseded.decision?.outcome === 'APPROVED', 'R15 reconsideration creates a superseding review; the old final decision is retained, never rewritten');
  neg(expect(collect('R16', await j('POST', `/ts/compliance/reviews/${EVE_REVIEW2}/supersede`, { reason: 'again' }, PRIYA.token)), 409, 'REVIEW_NOT_PENDING'), 'R16 a superseded review cannot be superseded again');
  const rej = await j('POST', `/ts/compliance/reviews/${sup.body.review.id}/resolve`, { outcome: 'REJECTED', reasonCode: 'letter_withdrawn', reason: 'The FA letter was withdrawn.' }, LEA.token);
  ok(rej.status === 200 && (await j('GET', '/org/agent/profile', undefined, EVE.token)).body.profile.facets.minors_authorisation.ENG.state === 'UNVERIFIED', 'R17 the superseding decision (rejected) takes effect: the facet is UNVERIFIED again');
  const cancelMe = await sub(DAN.token, 'minors_authorisation', 'FA-MIN-D', 'ENG');
  const cr = (await j('GET', '/org/agent/compliance/overview', undefined, DAN.token)).body.reviews.find((r) => r.status === 'PENDING')?.id;
  neg(expect(collect('R18', await j('POST', `/ts/compliance/reviews/${cr}/cancel`, {}, PRIYA.token)), 400, 'REVIEW_INPUT_INVALID'), 'R18 a cancellation needs a reason');
  ok(cancelMe.status === 200 && (await j('POST', `/ts/compliance/reviews/${cr}/cancel`, { reason: 'duplicate submission' }, PRIYA.token)).body.review.status === 'CANCELLED', 'R19 an administrator cancels a review with a reason');
  neg(expect(collect('R20', await j('POST', `/ts/compliance/reviews/${cr}/resolve`, { outcome: 'APPROVED', reasonCode: 'x', reason: 'y', evidenceRefs: ['e'] }, PRIYA.token)), 409, 'REVIEW_NOT_PENDING'), 'R20 a cancelled review cannot be decided');
  neg(expect(collect('R21', await j('GET', '/ts/compliance/reviews/__proto__', undefined, PRIYA.token)), 404, 'REVIEW_NOT_FOUND') && expect(collect('R21b', await j('POST', '/ts/compliance/reviews/constructor/start', {}, PRIYA.token)), 404, 'REVIEW_NOT_FOUND'), 'R21 prototype names are not reviews');
}

// ============================================================ K–O — contexts over HTTP
section('K–O — compliance contexts: the regulated declaration re-authorises at mutation time');
let CTX1, CTX1_REV, KOLA_CONSENT, CLUB_CONSENT, MARIA_ID;
{
  neg(expect(collect('K8', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'] }, BEN.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'K8 an analyst cannot open a context (#25)');
  neg(expect(collect('K9', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'] }, tomas.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'K9 an agency administrator without the licensed_agent role cannot either (#26)');
  neg(expect(collect('K10', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'] }, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'K10 a club user has no agent workspace');
  neg(expect(collect('K11', await j('POST', '/org/agent/compliance/contexts', { type: 'offer', jurisdictions: ['ENG'] }, ANA.token)), 400, 'CONTEXT_INPUT_INVALID') && expect(collect('K11b', await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: [] }, ANA.token)), 400, 'CONTEXT_INPUT_INVALID'), 'K11 "offer" is not a context type; jurisdictions are required');
  neg(expect(collect('K12', await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['FRA'] }, ANA.token)), 422, 'JURISDICTION_UNSUPPORTED'), 'K12 an unsupported jurisdiction cannot open a context (#17)');
  const minorTry = collect('K13', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }] }, ANA.token));
  const noneTry = collect('K13b', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-nobody' }] }, ANA.token));
  neg(expect(minorTry, 404, 'PARTY_NOT_FOUND') && expect(noneTry, 404, 'PARTY_NOT_FOUND') && JSON.stringify(minorTry.body) === JSON.stringify(noneTry.body), 'K13 a minor and a non-existent player answer with byte-identical bodies (#23)');
  neg(expect(collect('K14', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-tomasz', guardianConsent: true, dob: '2000-01-01' }] }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'K14 a forged guardian consent and a client-supplied date of birth change nothing (#19, #20)');
  neg(expect(collect('K15', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-nope' }] }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'K15 an unknown club is 404');
  const create = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'ctx-1' }, ANA.token);
  ok(create.status === 201 && create.body.context.status === 'open' && create.body.context.scope === 'national' && create.body.context.clearance.outcome === 'CLEAR' && create.body.context.parties.length === 2 && create.body.context.parties[0].name === 'Kola Adeyemi', 'K16 Ana opens an England employment context with Kola and Eastport FC; with no representation declared it evaluates CLEAR');
    CTX1 = create.body.context.id;
  ok((await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }], clientKey: 'ctx-1' }, ANA.token)).body.idempotent === true, 'AB3 the creation key replays');
  neg(expect(collect('AB4', await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['ENG'], clientKey: 'ctx-1' }, ANA.token)), 409, 'CONTEXT_IDEMPOTENCY_CONFLICT'), 'AB4 the same key with a different payload collides');
  neg(expect(collect('K17', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'K17 an agreement with a different client authorises nothing here');
  neg(expect(collect('K18', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_CHINEDU }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), 'K18 a colleague\'s agreement is not the agent\'s');
  const ctxT = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }] }, ANA.token);
  neg(expect(collect('J9', await j('POST', `/org/agent/compliance/contexts/${ctxT.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_THEO }, ANA.token)), 403, 'REPRESENTATION_SCOPE_INSUFFICIENT') && (await j('POST', `/org/agent/compliance/contexts/${ctxT.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_THEO }, ANA.token)).body.required.join() === 'employment', 'J9 a commercial-only agreement does not cover an employment contract; the refusal names the scope needed');
  globalThis.CTX_THEO = ctxT.body.context.id;
  const dec = await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-kola' }, ANA.token);
  ok(dec.status === 201 && dec.body.representation.status === 'verified' && dec.body.evaluation.outcome === 'CLEAR' && dec.body.context.representations[0].firstActAt > 0 && dec.body.context.clearance.policyVersions.join() === 'jp-fifa-2025-1,jp-eng-2026-27-1', 'K19 Ana declares she represents Kola under the active confirmed agreement → recorded, CLEAR, versioned');
  ok((await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA, clientKey: 'rep-kola' }, ANA.token)).body.idempotent === true, 'AB5 the declaration key replays');
  neg(expect(collect('K20', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token)), 409, 'CONTEXT_PARTY_EXISTS'), 'K20 a party is represented once');
  CTX1_REV = dec.body.context.rev;
  const club = collect('L7', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'engaging_entity' }, ANA.token));
  neg(expect(club, 422, 'REGULATORY_REVIEW_REQUIRED') && club.body.reviewId && club.body.reasons.some((r) => r.code === 'REPRESENTATION_UNVERIFIED') && /not effective until/.test(club.body.message), 'L7 declaring the engaging club — an entity with no ScoutBox agreement — records a declared-only representation and needs attributed review (DR-18)');
  const c1 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(c1.body.context.representations.find((r) => r.partyRole === 'engaging_entity').status === 'pending_review' && c1.body.context.clearance.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'L8 the context shows the pending representation and a manual-review clearance');
  const approve = await j('POST', `/ts/compliance/reviews/${club.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'The club mandate letter was examined.', evidenceRefs: ['Eastport FC mandate letter, 12 Sep 2026'] }, MARCUS.token);
  ok(approve.status === 200 && approve.body.review.decision.resultingState.representationStatus === 'verified', 'L9 Marcus confirms the fact; the representation becomes verified');
  const c2 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(c2.body.context.clearance.outcome === PERMITTED_WITH_CONSENT && c2.body.context.clearance.alias === 'PERMITTED_WITH_CONSENT' && c2.body.context.clearance.consentsOutstanding.map((x) => x.partyRole).sort().join() === 'engaging_entity,individual', 'L10 with both parties represented the clearance is PERMITTED_WITH_CONSENT: consent is outstanding from the individual AND the engaging club');
  neg(expect(collect('L11', await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'releasing_entity' }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'L11 consent can only be requested from a party that exists');
  neg(expect(collect('L12', await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual' }, DAN.token)), 404, 'CONTEXT_NOT_FOUND'), 'L12 a colleague cannot request consent in Ana\'s context (personal record; 404 not 403)');
  const req1 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, clientKey: 'cons-kola' }, ANA.token);
  ok(req1.status === 201 && req1.body.consent.status === 'requested' && req1.body.consent.ruleIds.join() === 'ENG-6.3', 'P1 Ana requests Kola\'s written consent under ENG-6.3');
  KOLA_CONSENT = req1.body.consent.id;
  ok((await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true, clientKey: 'cons-kola' }, ANA.token)).body.idempotent === true, 'AB6 the consent request key replays');
  neg(expect(collect('P2', await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual' }, ANA.token)), 409, 'CONSENT_ALREADY_REQUESTED'), 'P2 not requested twice while one is open');
  const kl = await j('GET', '/player/agent/consents', undefined, kola.token);
  ok(kl.status === 200 && kl.body.items.length === 1 && kl.body.items[0].agent.displayName === 'Ana Costa' && kl.body.items[0].agent.agency === 'North Star Sports Agency' && kl.body.items[0].context.parties.some((p) => p.name === 'Eastport FC') && kl.body.items[0].otherPartyRoles.join() === 'engaging_entity' && /You may decline/.test(kl.body.items[0].honest), 'P3 Kola sees who asks, for which transaction, which other party, and that he may decline');
    neg(!JSON.stringify(kl.body).match(/\bfee\b|commission|%/i), 'P4 no fee term reaches the consent view');
  neg((await j('GET', '/player/agent/consents', undefined, mateus.token)).body.items.length === 0 && expect(collect('P5', await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, mateus.token)), 404, 'CONSENT_NOT_FOUND'), 'P5 another player sees nothing and cannot answer for Kola (#13)');
  neg((await j('GET', '/player/agent/consents', undefined, guni.token)).body.minor === true && expect(collect('P6', await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, guni.token)), 403, 'COMPLIANCE_ACTION_NOT_PERMITTED'), 'P6 a minor has no consents and cannot act');
  neg(expect(collect('P7', await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true }, kola.token)), 400, 'CONSENT_INPUT_INVALID'), 'P7 a grant needs both acknowledgements');
  neg(expect(collect('AA2', await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, expectedRev: 7 }, kola.token)), 409, 'CONSENT_VERSION_CONFLICT'), 'AA2 a stale rev on a consent is refused');
  const t1 = Date.now();
  const grant = await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, grantedAt: 1_000, clientKey: 'kola-grant' }, kola.token);
  ok(grant.status === 200 && grant.body.consent.status === 'granted' && grant.body.consent.grantedAt >= t1, 'P8 Kola grants; the timestamp is the server\'s (a client-supplied grantedAt is ignored)');
  ok((await j('POST', `/player/agent/consents/${KOLA_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true, clientKey: 'kola-grant' }, kola.token)).body.idempotent === true, 'AB7 the grant key replays');
  const c3 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(c3.body.context.clearance.outcome === PERMITTED_WITH_CONSENT && c3.body.context.clearance.consentsOutstanding.map((x) => x.partyRole).join() === 'engaging_entity', 'P9 the context re-evaluated on the grant: only the club\'s consent is outstanding now');
  const req2 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'engaging_entity', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true }, ANA.token);
  ok(req2.status === 201, 'P10 Ana requests the club\'s consent');
  CLUB_CONSENT = req2.body.consent.id;
  const ml = await j('GET', '/org/compliance/consents', undefined, maria.token);
  ok(ml.status === 200 && ml.body.items.length === 1 && ml.body.signatory === false, 'P11 Eastport sees the request; Maria is not yet a recorded signatory');
  neg(expect(collect('P12', await j('POST', `/org/compliance/consents/${CLUB_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, maria.token)), 403, 'SIGNATORY_REQUIRED'), 'P12 a club user who is not a recorded signatory cannot bind the club');
  neg(expect(collect('P13', await j('POST', `/org/compliance/consents/${CLUB_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, harbour.token)), 404, 'CONSENT_NOT_FOUND'), 'P13 another club cannot see or answer it');
  neg(expect(collect('P14', await j('POST', `/org/compliance/consents/${CLUB_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, ANA.token)), 404, 'CONSENT_NOT_FOUND'), 'P14 the agent cannot consent on the club\'s behalf');
  MARIA_ID = maria.userId;
  const appoint = await j('POST', '/admin/verification/orgs/org-eastport/appoint-root', { userId: MARIA_ID, reason: 'P5.6C suite: club signatory' }, PRIYA.token, ADMIN);
    ok(appoint.status === 201 && appoint.body.rootAdminUserId === MARIA_ID, 'P15 Trust & Safety records Maria as Eastport\'s verification root (the club signatory), attributed to Priya\'s session');
  const cg = await j('POST', `/org/compliance/consents/${CLUB_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, maria.token);
  ok(cg.status === 200 && cg.body.consent.status === 'granted', 'P16 the signatory grants for the club');
  const c4 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  ok(c4.body.context.clearance.outcome === 'CLEAR' && c4.body.context.clearance.reasons.some((r) => r.code === 'DUAL_CONSENTED') && c4.body.context.clearance.current === true, 'L13 with both party-specific consents recorded the clearance is CLEAR (DUAL_CONSENTED)');
}

// ============================================================ S/T — revocation, stale submits, party change
section('S/T — revocation, stale client submits, party change invalidates the prior check');
{
  const rv = await j('POST', `/player/agent/consents/${KOLA_CONSENT}/revoke`, { clientKey: 'kola-revoke' }, kola.token);
  ok(rv.status === 200 && rv.body.consent.status === 'revoked' && typeof rv.body.consent.revokedAt === 'number', 'R22 Kola revokes his consent');
  const db0 = openStore(DATA_DIR).load()?.db;
  const granted = db0.regulatoryConsents.find((k) => k.id === KOLA_CONSENT);
  const revRow = db0.regulatoryConsents.find((k) => k.kind === 'revocation' && k.of === KOLA_CONSENT);
  neg(granted.status === 'granted' && granted.revokedAt === undefined && revRow && revRow.at > granted.grantedAt, 'AE4 the ledger is append-only: the granted row is untouched and the revocation is a new row');
  const c5 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  neg(c5.body.context.clearance.outcome === PERMITTED_WITH_CONSENT && c5.body.context.clearance.consentsOutstanding[0].reasonCode === 'CONSENT_REVOKED', 'S5 the context re-evaluated at once: the individual\'s consent is outstanding again (revoked)');
  const wd = await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations/${c5.body.context.representations[0].id}/withdraw`, {}, ANA.token);
  ok(wd.status === 200 && wd.body.context.representations[0].status === 'withdrawn', 'S6 Ana withdraws her own representation of Kola');
  neg(expect(collect('S7', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token)), 422, 'CONSENT_REQUIRED'), 'S7 a stale client re-submitting the declaration after the revocation is refused at mutation time — nothing recorded (#12)');
  neg((await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1, 'S8 only the club representation remains');
  const req3 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true }, ANA.token);
  ok(req3.status === 201, 'Q2 after a revocation a new request may be made');
  const dc = await j('POST', `/player/agent/consents/${req3.body.consent.id}/decline`, {}, kola.token);
  ok(dc.status === 200 && dc.body.consent.status === 'declined', 'Q3 Kola declines');
  neg(expect(collect('Q4', await j('POST', `/player/agent/consents/${req3.body.consent.id}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)), 409, 'CONSENT_NOT_PENDING'), 'Q4 a declined consent cannot then be granted');
  neg(expect(collect('Q5', await j('POST', `/player/agent/consents/${req3.body.consent.id}/revoke`, {}, kola.token)), 409, 'CONSENT_NOT_PENDING'), 'Q5 nor revoked');
  neg(expect(collect('S9', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token)), 422, 'CONSENT_REQUIRED'), 'S9 a declined consent is not consent: the declaration is still refused');
  const req4 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true, proposedFeeDisclosed: true }, ANA.token);
  ok(req4.status === 201 && (await j('POST', `/player/agent/consents/${req4.body.consent.id}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)).body.consent.status === 'granted', 'Q6 asked again, Kola grants');
  const redo = await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token);
  ok(redo.status === 201 && redo.body.evaluation.outcome === 'CLEAR', 'S10 with current consents the declaration is recorded and CLEAR');
  const ctx = (await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context;
  const before = ctx.evaluationCount;
  neg(expect(collect('T1', await j('POST', `/org/agent/compliance/contexts/${CTX1}/parties`, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-harbour' }, ANA.token)), 409, 'CONTEXT_PARTY_EXISTS'), 'T1 the engaging club cannot be silently swapped: a role is filled once (#9)');
  neg(expect(collect('AA3', await j('POST', `/org/agent/compliance/contexts/${CTX1}/parties`, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour', expectedRev: ctx.rev + 5 }, ANA.token)), 409, 'CONTEXT_VERSION_CONFLICT'), 'AA3 a stale context rev is refused');
  const add = await j('POST', `/org/agent/compliance/contexts/${CTX1}/parties`, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour', expectedRev: ctx.rev }, ANA.token);
  ok(add.status === 201 && add.body.context.evaluationCount === before + 1 && add.body.evaluation.outcome === 'CLEAR', 'T2 adding the releasing club re-evaluates the context at once (#10, #11); with no representation of it the clearance stays CLEAR');
  const rel = collect('T3', await j('POST', `/org/agent/compliance/contexts/${CTX1}/representations`, { partyRole: 'releasing_entity' }, ANA.token));
  neg(expect(rel, 422, 'REGULATORY_REVIEW_REQUIRED') && rel.body.reasons.some((r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleId === 'ENG-6.4'), 'T3 declaring the releasing club too: the declared-only fact goes to review, and the review carries the ACTIVE prohibition');
  neg(expect(collect('T4', await j('POST', `/ts/compliance/reviews/${rel.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'x', reason: 'trying', evidenceRefs: ['e'] }, PRIYA.token)), 409, 'REVIEW_CANNOT_OVERRIDE_ACTIVE_RULE'), 'T4 a reviewer cannot approve past an objectively prohibited ACTIVE rule (#28)');
  const rejected = await j('POST', `/ts/compliance/reviews/${rel.body.reviewId}/resolve`, { outcome: 'REJECTED', reasonCode: 'prohibited_combination', reason: 'FA 6.4: a releasing club\'s agent acts for nobody else.' }, PRIYA.token);
  ok(rejected.status === 200 && rejected.body.review.decision.resultingState.representationStatus === 'withdrawn', 'T5 rejecting it withdraws the declared representation');
  neg(expect(collect('T6', await j('POST', `/org/agent/compliance/contexts/${CTX1}/override`, { outcome: 'CLEAR' }, ANA.token)), 404, null) && (await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, { outcome: 'CLEAR', clearance: 'CLEAR' }, ANA.token)).body.evaluation.outcome === 'CLEAR', 'T7 the agent has no override route and an outcome in the body changes nothing (#27)');
  // A prohibited combination refused at mutation time, nothing recorded.
  const ctx2 = await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }, { partyRole: 'releasing_entity', subjectKind: 'club', subjectId: 'org-harbour' }] }, ANA.token);
  const r2 = collect('M4', await j('POST', `/org/agent/compliance/contexts/${ctx2.body.context.id}/representations`, { partyRole: 'releasing_entity' }, ANA.token));
  const ap = await j('POST', `/ts/compliance/reviews/${r2.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'Harbour City mandate seen.', evidenceRefs: ['Harbour City FC mandate, 1 Sep 2026'] }, MARCUS.token);
  ok(ctx2.status === 201 && r2.status === 422 && ap.status === 200 && ap.body.review.decision.resultingState.representationStatus === 'verified', 'M4 in a transfer context Ana is confirmed as the releasing club\'s agent');
  const m5 = collect('M5', await j('POST', `/org/agent/compliance/contexts/${ctx2.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token));
  neg(expect(m5, 403, 'REPRESENTATION_CONFLICT') && m5.body.reasons.some((r) => r.code === 'PROHIBITED_COMBINATION' && r.ruleStatus === 'ACTIVE') && m5.body.outcome === 'PROHIBITED_CONFLICT', 'M5 declaring the individual as well → 403 REPRESENTATION_CONFLICT under the ACTIVE rule; nothing is recorded');
  ok((await j('GET', `/org/agent/compliance/contexts/${ctx2.body.context.id}`, undefined, ANA.token)).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1, 'M6 the context still holds one representation');
  globalThis.CTX2 = ctx2.body.context.id;
}

// ============================================================ N/O — uncertain FIFA rule, connected agents over HTTP
section('N/O — an uncertain rule goes to attributed review; a colleague is attributed');
let CTX3, CTX3_REVIEW;
{
  const ctx3 = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['INT'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ANA.token);
  CTX3 = ctx3.body.context.id;
  ok(ctx3.status === 201 && ctx3.body.context.scope === 'international', 'N9 an international-dimension context');
  const club = collect('N10', await j('POST', `/org/agent/compliance/contexts/${CTX3}/representations`, { partyRole: 'engaging_entity' }, ANA.token));
  const ap = await j('POST', `/ts/compliance/reviews/${club.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'Eastport mandate seen.', evidenceRefs: ['Eastport FC mandate, 12 Sep 2026'] }, MARCUS.token);
  ok(club.status === 422 && ap.status === 200, 'N10 the club representation is confirmed by review');
  const ind = collect('N11', await j('POST', `/org/agent/compliance/contexts/${CTX3}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token));
  neg(expect(ind, 422, 'REGULATORY_REVIEW_REQUIRED') && ind.body.reasons.some((r) => r.code === 'RULE_STATUS_UNCERTAIN' && r.ruleId === 'FIFA-12.8' && r.ruleStatus === 'UNDER_LEGAL_REVIEW') && ind.body.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'N11 declaring Mateus too under the FIFA text: the deciding rule is UNDER_LEGAL_REVIEW → attributed review, never CLEAR, never prohibited');
  CTX3_REVIEW = ind.body.reviewId;
  neg((await j('GET', `/org/agent/compliance/contexts/${CTX3}`, undefined, ANA.token)).body.context.representations.filter((r) => r.status !== 'withdrawn').length === 1, 'N12 nothing was recorded for Mateus');
  neg(expect(collect('N13', await j('POST', `/org/agent/compliance/contexts/${CTX3}/consents/request`, { partyRole: 'individual', fullParticularsProvided: true, legalAdviceOffered: true }, ANA.token)), 422, 'REGULATORY_REVIEW_REQUIRED'), 'N13 consent cannot be requested under an uncertain rule — consent would not cure it');
  neg(expect(collect('N14', await j('POST', `/ts/compliance/reviews/${CTX3_REVIEW}/resolve`, { outcome: 'APPROVED', reasonCode: 'looks_fine', reason: 'Seems permitted.', evidenceRefs: ['FAQ'] }, PRIYA.token)), 409, 'REVIEW_REQUIRES_POLICY_VERSION'), 'N14 a reviewer cannot approve past an uncertain rule: only a published policy version can settle it (§37)');
  const rv = await j('GET', `/ts/compliance/reviews/${CTX3_REVIEW}`, undefined, PRIYA.token);
  ok(rv.body.review.status === 'PENDING' && rv.body.review.policyVersions.join() === 'jp-fifa-2025-1' && rv.body.review.snapshot.outcome === 'MANUAL_REGULATORY_REVIEW_REQUIRED', 'N15 the review item preserves the evaluation snapshot and the policy version it was made under');
  // Connected agents: Dan's context on the same transaction.
  const ctx4 = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-okafor' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, DAN.token);
  const d1 = await j('POST', `/org/agent/compliance/contexts/${ctx4.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_CHINEDU }, DAN.token);
  ok(ctx4.status === 201 && d1.status === 201 && d1.body.evaluation.outcome === 'CLEAR', 'O5 Dan represents Chinedu in an England employment context: CLEAR');
  const ctx5 = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-okafor' }, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }] }, ANA.token);
  const a1 = collect('O6', await j('POST', `/org/agent/compliance/contexts/${ctx5.body.context.id}/representations`, { partyRole: 'engaging_entity' }, ANA.token));
  await j('POST', `/ts/compliance/reviews/${a1.body.reviewId}/resolve`, { outcome: 'APPROVED', reasonCode: 'club_mandate_seen', reason: 'Eastport mandate seen.', evidenceRefs: ['Eastport FC mandate, 12 Sep 2026'] }, MARCUS.token);
  const d2 = await j('POST', `/org/agent/compliance/contexts/${ctx4.body.context.id}/evaluate`, {}, DAN.token);
  neg(d2.body.evaluation.outcome === PERMITTED_WITH_CONSENT && d2.body.evaluation.reasons.some((r) => r.code === 'CONNECTED_AGENT_ATTRIBUTION' && r.ruleId === 'ENG-6.5' && r.partyRoles.join() === 'engaging_entity'), 'O6 Ana — a colleague at the same agency — being confirmed for the engaging club in the SAME transaction is attributed to Dan: his clearance is now consent-required (FA 6.5)');
  neg(!JSON.stringify(d2.body).includes(ANA_ID) && !JSON.stringify(d2.body).includes('Ana Costa'), 'O7 the attribution names party roles only — never the colleague');
  globalThis.CTX4 = ctx4.body.context.id;
}

// ============================================================ U/V/W — minors over HTTP
section('U/V/W — minors: readiness is evaluated against no subject; discovery stays closed');
{
  const ov = await j('GET', '/org/agent/compliance/overview', undefined, ANA.token);
  const eng = ov.body.minorReadiness.find((m) => m.memberAssociation === 'ENG');
  neg(eng && eng.pathwayEnabledInProduction === false && eng.timingEncoded === true && eng.agentReady === false && eng.gaps.some((g) => g.facet === 'minors_authorisation') && /prohibited/.test(eng.honest), 'U10 England: the timing rule is encoded, the agent is not ready (no minors authorisation), and no pathway is live');
  const sub = (facet, reference, ma) => j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, memberAssociation: ma }, ANA.token);
  ok((await sub('minors_authorisation', 'TEST-VERIFIED-MIN-ENG', 'ENG')).body.facet.state === 'VERIFIED' && (await sub('minors_authorisation', 'TEST-VERIFIED-MIN-INT', 'INT')).status === 400, 'U11 an England minors authorisation is recorded; INT is not a member association for it');
  const ov2 = await j('GET', '/org/agent/compliance/overview', undefined, ANA.token);
  const eng2 = ov2.body.minorReadiness.find((m) => m.memberAssociation === 'ENG');
  neg(eng2.pathwayEnabledInProduction === false && eng2.gaps.every((g) => g.memberAssociation === 'INT'), 'U12 with the FA authorisation the only gap left is the FIFA minors accreditation — and the pathway is STILL not live');
  neg((await j('GET', '/org/agent/players?q=gu', undefined, ANA.token)).body.items.length === 0 && (await j('GET', '/org/agent/players?q=tom', undefined, ANA.token)).body.items.length === 0, 'U13 minors remain invisible to the lookup whatever the agent\'s accreditation');
  neg(expect(collect('U14', await j('POST', `/org/agent/compliance/contexts/${CTX1}/parties`, { partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-guni' }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'U14 adding a minor to an open context is the uniform 404 even though the role is already filled — no oracle on the role, no oracle on the minor');
  neg(expect(collect('U15', await j('POST', '/org/agent/compliance/minors/approach', { playerId: 'pl-guni' }, ANA.token)), 404, null) && expect(collect('U15b', await j('POST', '/org/agent/compliance/minors/evaluate', { dob: '2011-03-15' }, ANA.token)), 404, null), 'U15 no minors approach or subject-evaluation route exists');
}

// ============================================================ X/Y/Z — blocks, tenant, privacy
section('X/Y/Z — blocks beat clearance; tenancy; nothing private in a refusal');
{
  const blk = await j('POST', '/player/block', { orgId: 'org-northstar', reason: 'no thanks' }, theo.token);
  ok(blk.status === 201, 'X3 Theo blocks the agency');
  const ct = await j('GET', `/org/agent/compliance/contexts/${globalThis.CTX_THEO}`, undefined, ANA.token);
  neg(ct.body.context.parties[0].name === null, 'X4 the blocked party\'s name is gone from the agent\'s context');
  const ev = await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX_THEO}/evaluate`, {}, ANA.token);
  neg(ev.body.evaluation.outcome === 'INSUFFICIENT_DATA' && codes(ev.body.evaluation).includes('PARTY_REMOVED'), 'X5 the evaluation reads the party as removed: INSUFFICIENT_DATA, never CLEAR (#22)');
  neg(expect(collect('X6', await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX_THEO}/representations`, { partyRole: 'individual', agreementId: REL_THEO }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'X6 a declaration for a blocked player is the uniform 404');
  neg(expect(collect('X7', await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-martin' }] }, ANA.token)), 404, 'PARTY_NOT_FOUND'), 'X7 nor can a new context name him');
  neg(expect(collect('Y1', await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, maria.token)), 403, 'AGENT_ACTION_NOT_PERMITTED'), 'Y1 a club user cannot read an agency context');
  neg(expect(collect('Y2', await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, DAN.token)), 404, 'CONTEXT_NOT_FOUND'), 'Y2 a colleague cannot read Ana\'s context (personal; 404 not 403)');
  neg(expect(collect('Y3', await j('GET', '/org/agent/compliance/contexts/__proto__', undefined, ANA.token)), 404, 'CONTEXT_NOT_FOUND') && expect(collect('Y3b', await j('POST', '/org/agent/compliance/contexts/constructor/evaluate', {}, ANA.token)), 404, 'CONTEXT_NOT_FOUND'), 'Y3 prototype names are not contexts');
  neg(expect(collect('Y4', await j('GET', '/org/agent/compliance/overview', undefined, kola.token)), 401, null), 'Y4 a player token is no agent session');
  neg(expect(collect('Y5', await j('POST', '/player/agent/consents/__proto__/grant', { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)), 404, 'CONSENT_NOT_FOUND') && expect(collect('Y5b', await j('POST', `/player/agent/consents/${CLUB_CONSENT}/grant`, { acknowledgedParticulars: true, acknowledgedLegalAdvice: true }, kola.token)), 404, 'CONSENT_NOT_FOUND'), 'Y5 a player cannot guess a consent id nor answer the club\'s consent (#24)');
  neg(expect(collect('Y6', await j('POST', `/org/compliance/consents/${KOLA_CONSENT}/revoke`, {}, maria.token)), 404, 'CONSENT_NOT_FOUND'), 'Y6 a club signatory cannot touch a player\'s consent');
  const ben = await j('GET', '/org/agent/compliance/overview', undefined, BEN.token);
  ok(ben.status === 200 && ben.body.contexts.length === 0 && ben.body.consents.length === 0 && ben.body.facets === null, 'Y7 an analyst reads only his own (empty) compliance state');
  const audit = await j('GET', '/org/agent/agency/audit?limit=50', undefined, tomas.token);
    ok(audit.status === 200 && audit.body.items.some((x) => x.domain === 'compliance' && x.action === 'regulatory_consent_granted') && audit.body.items.some((x) => x.domain === 'compliance' && x.action === 'regulatory_review_resolved' && x.actor?.name === 'Trust & Safety (attributed)'), 'AE5 the agency audit feed carries compliance rows; a reviewer appears as an attributed role');
  neg(!JSON.stringify(audit.body).match(/mandate letter|withdrawn\.|Seems permitted|Marcus|Priya|evidenceRefs/), 'AE6 the agency feed carries no reason text, no evidence and no reviewer name');
  const kn = await j('GET', '/player/notifications', undefined, kola.token);
  ok(kn.body.some((n) => n.type === 'regulatory_consent_requested' && /You may decline/.test(n.text)), 'AF3 Kola was told about the consent request and that he may decline');
  const an = await j('GET', '/org/notifications', undefined, ANA.token);
  ok(an.body.some((n) => n.type === 'regulatory_consent_revoked') && an.body.some((n) => n.type === 'regulatory_review_completed' && /not a legal determination/.test(n.text)), 'AF4 Ana was told of the revocation and of the review outcome, framed as a platform decision');
  neg(!JSON.stringify(an.body).match(/Kola|Eastport FC mandate/), 'AF5 no party name and no evidence reaches a notification');
}

// ============================================================ AE — events
section('AE — SSE frames carry ids and state words only');
{
  const sse = await sseCollect(ANA.token, 900);
  await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, {}, ANA.token);
  const frames = await sse.stop();
  ok(/conflict_evaluated/.test(frames) && /ctxId/.test(frames) && /"outcome":"CLEAR"/.test(frames), 'AE7 Ana\'s stream carries conflict_evaluated with the context id and the outcome word');
  neg(!/Kola|Eastport|reason|evidence/.test(frames), 'AE8 and nothing else');
  const metrics = await j('GET', '/ts/compliance/metrics', undefined, PRIYA.token);
  ok(metrics.status === 200 && typeof metrics.body.reviews.byStatus.APPROVED === 'number' && typeof metrics.body.conflictOutcomes.CLEAR === 'number' && /No agent is ranked/.test(metrics.body.note), 'AE9 process metrics: counts only, and the note says no agent is ranked');
  neg(!JSON.stringify(metrics.body).match(/Ana|Kola|usr-|pl-/), 'AE10 no identity in the metrics');
}

// ============================================================ adversarial — stale licence, departure, dispute, expiry
section('adversarial — a stale or inactive licence, a departure and a dispute between check and mutation');
{
  const sub = (tok, facet, reference, ma) => j('POST', `/org/agent/profile/facets/${facet}/submit`, { reference, ...(ma ? { memberAssociation: ma } : {}) }, tok);
  await sub(ANA.token, 'fifa_licence', 'TEST-INACTIVE-ANA');
  neg(expect(collect('AD4', await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX2}/parties`, { partyRole: 'engaging_entity', subjectKind: 'club', subjectId: 'org-eastport' }, ANA.token)), 201, null) && expect(collect('AD4b', await j('POST', `/org/agent/compliance/contexts/${CTX3}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token)), 403, 'AGENT_LICENCE_INACTIVE'), '#4 an INACTIVE licence on a live session: a regulated declaration is refused (adding a party is bookkeeping)');
  await sub(ANA.token, 'fifa_licence', 'TEST-STALE-ANA');
  neg(expect(collect('AD5', await j('POST', `/org/agent/compliance/contexts/${CTX3}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token)), 403, 'AGENT_VERIFICATION_STALE'), '#5 a STALE licence between page load and mutation: refused');
  neg(expect(collect('AD5b', await j('POST', '/org/agent/compliance/contexts', { type: 'transfer', jurisdictions: ['ENG'] }, ANA.token)), 403, 'AGENT_VERIFICATION_STALE'), '#5b nor can a stale agent open a context');
  ok((await sub(ANA.token, 'fifa_licence', 'TEST-VERIFIED-ANA')).body.facet.state === 'VERIFIED', 'AD6 Ana re-verifies');
  const rc = await j('POST', '/org/agent/compliance/facets/fifa_licence/recheck', {}, ANA.token);
  ok(rc.status === 200 && rc.body.facet.state === 'VERIFIED' && rc.body.facet.recheckAt > Date.now(), 'H6 a recheck against a current reference refreshes the recheck date');
  // The client's authority changes between check and mutation.
  const ctx6 = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['INT'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-carvalho' }] }, ANA.token);
  const rel = await j('GET', `/org/agent/clients/${REL_MATEUS}`, undefined, ANA.token);
  const disp = await j('POST', `/player/agent/relationships/${REL_MATEUS}/dispute`, { expectedRev: rel.body.relationship.rev, reason: 'PRIVATE_DISPUTE_TEXT' }, mateus.token);
  ok(disp.status === 200 && disp.body.relationship.status === 'disputed', 'AD7 Mateus disputes the relationship');
  neg(expect(collect('AD8', await j('POST', `/org/agent/compliance/contexts/${ctx6.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), '#7 a disputed relationship authorises no declaration');
  const dr = (await j('GET', '/ts/compliance/reviews?status=PENDING', undefined, PRIYA.token)).body.items.find((r) => r.kind === 'representation_dispute' && r.subject.agreementId === REL_MATEUS);
  ok(!!dr && (await j('GET', `/ts/compliance/reviews/${dr.id}`, undefined, PRIYA.token)).body.subjectDetail.hadReason === true, 'AD9 the dispute became an attributed review item; the reviewer sees that a reason exists');
  neg(!JSON.stringify(await j('GET', `/ts/compliance/reviews/${dr.id}`, undefined, PRIYA.token)).includes('PRIVATE_DISPUTE_TEXT'), 'AD10 the reason text itself stays with the client');
  const reinstate = await j('POST', `/ts/compliance/reviews/${dr.id}/resolve`, { outcome: 'APPROVED', reasonCode: 'dispute_withdrawn', reason: 'The client withdrew the dispute in writing.', evidenceRefs: ['client message, 18 Sep 2026'] }, PRIYA.token);
  ok(reinstate.status === 200 && reinstate.body.review.decision.resultingState.agreementStatus === 'active' && (await j('GET', `/org/agent/clients/${REL_MATEUS}`, undefined, ANA.token)).body.access === true, 'AD11 an attributed reviewer reinstates the disputed relationship: access resumes');
  const rel2 = await j('GET', `/org/agent/clients/${REL_KOLA}`, undefined, ANA.token);
  const term = await j('POST', `/player/agent/relationships/${REL_KOLA}/terminate`, { expectedRev: rel2.body.relationship.rev }, kola.token);
  ok(term.status === 200, 'AD12 Kola ends his relationship with Ana');
  const ctx7 = await j('POST', '/org/agent/compliance/contexts', { type: 'employment_contract', jurisdictions: ['ENG'], parties: [{ partyRole: 'individual', subjectKind: 'player', subjectId: 'pl-adeyemi' }] }, ANA.token);
  neg(expect(collect('AD13', await j('POST', `/org/agent/compliance/contexts/${ctx7.body.context.id}/representations`, { partyRole: 'individual', agreementId: REL_KOLA }, ANA.token)), 403, 'REPRESENTATION_REQUIRED'), '#6 a relationship ended between check and mutation authorises nothing');
  neg((await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token)).body.context.clearance !== null, 'AD14 the earlier CLEAR snapshot on the other context is history, not authority — every new act re-derives');
  // Departure.
  const danAff = (await j('GET', '/org/agent/agency/team', undefined, tomas.token)).body.members.find((m) => m.userId === DAN_ID);
  const end = await j('POST', `/org/agent/agency/team/${DAN_ID}/end`, { expectedRev: danAff.rev, reason: 'left' }, tomas.token);
  ok(end.status === 200, 'AD15 Dan leaves the agency');
  neg(expect(collect('AD16', await j('POST', `/org/agent/compliance/contexts/${globalThis.CTX4}/evaluate`, {}, DAN.token)), 401, null), '#8 the departed agent\'s session is dead before his next mutation');
  // Exclusive-agreement window: review, never a block, never the other agent.
  const exc = await j('POST', '/org/agent/clients/request', { playerId: 'pl-nowak', jurisdiction: 'ENG', exclusive: true }, EVE.token);
  ok(exc.status === 201 && (await j('POST', `/player/agent/relationships/${exc.body.relationship.id}/confirm`, { expectedRev: 1 }, filip.token)).body.relationship.status === 'active', 'AD17 Eve holds an EXCLUSIVE agreement with Filip');
  const ana2 = collect('AD18', await j('POST', '/org/agent/clients/request', { playerId: 'pl-nowak', jurisdiction: 'ENG' }, ANA.token));
  neg(expect(ana2, 422, 'REGULATORY_REVIEW_REQUIRED') && ana2.body.reasons.some((r) => r.code === 'EXCLUSIVITY_WINDOW_DOUBTFUL' && r.ruleStatus === 'UNDER_LEGAL_REVIEW') && ana2.body.reviewId, 'AD18 an approach to a player bound by another agent\'s exclusive agreement: the window rule is under legal review → attributed review, never a hard block (DR-33)');
  neg(!JSON.stringify(ana2.body).includes(EVE_ID) && !JSON.stringify(ana2.body).includes('Eve') && !(await j('GET', '/org/agent/clients', undefined, ANA.token)).body.items.some((x) => x.clientId === 'pl-nowak'), 'AD19 the other agent is never named and nothing was created');
}

// ============================================================ policy publication — dual control, history preserved
section('policy — dual-control publication; historical snapshots keep their version');
{
  const cur = (await j('GET', '/ts/compliance/policies', undefined, PRIYA.token)).body.items.find((p) => p.id === 'jp-fifa-2025-1');
  const rules = Object.fromEntries(Object.entries(cur.rules).map(([id, r]) => [id, { ruleStatus: ['FIFA-12.8', 'FIFA-12.9', 'FIFA-12.10'].includes(id) ? 'ACTIVE' : r.ruleStatus, textStatus: r.textStatus, sourceRef: r.sourceRef, params: r.params, note: r.note }]));
  const today = new Date().toISOString().slice(0, 10);
  const body = { id: 'jp-fifa-2025-2', regulator: 'FIFA', jurisdiction: 'INT', policyVersion: 2, supersedes: 'jp-fifa-2025-1', effectiveFrom: today, rules };
  neg(expect(collect('C12', await j('POST', '/ts/compliance/policies', { ...body, rules: { 'X-1': { ruleStatus: 'MAYBE', sourceRef: [] } } }, PRIYA.token)), 400, 'POLICY_INPUT_INVALID'), 'C12 an unknown rule status or a missing source reference is refused');
  neg(expect(collect('C13', await j('POST', '/ts/compliance/policies', body, MARCUS.token)), 403, 'REVIEWER_ROLE_REQUIRED'), 'C13 a reviewer cannot propose a policy version');
  const prop = await j('POST', '/ts/compliance/policies', body, PRIYA.token);
  ok(prop.status === 201 && prop.body.policy.status === 'proposed' && prop.body.policy.proposedBy.id === 'tsr-dev-admin', 'C14 Priya proposes jp-fifa-2025-2 with 12(8)–(10) ACTIVE (a test fixture, not a statement about FIFA)');
  neg(expect(collect('C15', await j('POST', '/ts/compliance/policies', body, PRIYA.token)), 409, 'POLICY_VERSION_EXISTS'), 'C15 a version id is unique');
  neg(expect(collect('C16', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, PRIYA.token)), 403, 'POLICY_DUAL_CONTROL_REQUIRED'), 'C16 the proposer cannot approve her own version');
  neg(expect(collect('C17', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, MARCUS.token)), 403, 'REVIEWER_ROLE_REQUIRED'), 'C17 a reviewer cannot approve it');
  neg((await j('GET', '/org/agent/compliance/policies', undefined, ANA.token)).body.inEffect.every((p) => p.id !== 'jp-fifa-2025-2'), 'C18 while proposed, the version is not in effect for anyone');
  const appr = await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, LEA.token);
  ok(appr.status === 200 && appr.body.policy.status === 'published' && appr.body.policy.publishedBy.length === 2 && appr.body.policy.approvedBy.id === 'tsr-dev-admin2', 'C19 a DIFFERENT administrator approves: published, attributed to both');
  neg(expect(collect('C20', await j('POST', '/ts/compliance/policies/jp-fifa-2025-2/approve', {}, LEA.token)), 409, 'POLICY_NOT_PROPOSED'), 'C20 not approved twice');
  const c3 = await j('GET', `/org/agent/compliance/contexts/${CTX3}`, undefined, ANA.token);
  ok(c3.body.context.reEvaluationPending === true && c3.body.context.clearance.current === false, 'C21 the international context is flagged for re-evaluation — never silently re-verdicted');
  const re = await j('POST', `/org/agent/compliance/contexts/${CTX3}/evaluate`, {}, ANA.token);
  ok(re.body.evaluation.policyVersions.join() === 'jp-fifa-2025-2' && re.body.evaluation.outcome === 'CLEAR', 'C22 re-evaluated under v2 (only the club is represented so far): CLEAR');
  const ind = collect('C23', await j('POST', `/org/agent/compliance/contexts/${CTX3}/representations`, { partyRole: 'individual', agreementId: REL_MATEUS }, ANA.token));
  ok(expect(ind, 422, 'CONSENT_REQUIRED') && ind.body.policyVersions.join() === 'jp-fifa-2025-2', 'C23 E16 over HTTP: what was "manual review" under v1 is "consent required" under v2 — a data change, not code');
  const db = openStore(DATA_DIR).load()?.db;
  const ctx = db.complianceContexts.find((c) => c.id === CTX3);
  ok(ctx.evaluations[0].policyVersions.join() === 'jp-fifa-2025-1' && ctx.evaluations.at(-1).policyVersions.join() === 'jp-fifa-2025-2' && ctx.evaluations.every((e) => e.inputHash && e.ruleStatuses), 'C24 the earlier evaluation rows keep v1 and their rule statuses; the latest names v2 (§80)');
  const oldReview = await j('GET', `/ts/compliance/reviews/${CTX3_REVIEW}`, undefined, PRIYA.token);
  ok(oldReview.body.review.policyVersions.join() === 'jp-fifa-2025-1' && oldReview.body.review.status === 'PENDING', 'C25 the pending review still records the version it was raised under');
  const rej = await j('POST', `/ts/compliance/reviews/${CTX3_REVIEW}/resolve`, { outcome: 'REJECTED', reasonCode: 'superseded_by_policy', reason: 'jp-fifa-2025-2 settles the question; the item is closed.' }, LEA.token);
  ok(rej.status === 200, 'C26 it is closed by a named reviewer, not deleted');
  // An England v2 makes the ENG consents stale (#16).
  const engCur = (await j('GET', '/ts/compliance/policies', undefined, PRIYA.token)).body.items.find((p) => p.id === 'jp-eng-2026-27-1');
  const engRules = Object.fromEntries(Object.entries(engCur.rules).map(([id, r]) => [id, { ruleStatus: r.ruleStatus, textStatus: r.textStatus, sourceRef: r.sourceRef, params: r.params, note: r.note }]));
  await j('POST', '/ts/compliance/policies', { id: 'jp-eng-2026-27-2', regulator: 'FA', jurisdiction: 'ENG', policyVersion: 2, supersedes: 'jp-eng-2026-27-1', effectiveFrom: today, rules: engRules }, PRIYA.token);
  const ok2 = await j('POST', '/ts/compliance/policies/jp-eng-2026-27-2/approve', {}, LEA.token);
  const c1 = await j('POST', `/org/agent/compliance/contexts/${CTX1}/evaluate`, {}, ANA.token);
  neg(ok2.status === 200 && c1.body.evaluation.outcome === PERMITTED_WITH_CONSENT && c1.body.evaluation.policyVersions.includes('jp-eng-2026-27-2') && c1.body.evaluation.consentsOutstanding.some((x) => x.partyRole === 'engaging_entity' && x.reasonCode === 'CONSENT_POLICY_VERSION_STALE'), '#16 the club consent granted under the previous England version is not carried into v2: re-evaluation requires it again (the individual\'s later decline stands)');
}

// ============================================================ AJ — tombstones; last administrator
section('AJ — deletion leaves ids; the last administrator stays');
{
  const del = await j('DELETE', '/player/account', undefined, kola.token);
  ok(del.status === 200, 'AJ1 Kola deletes his account');
  const db = openStore(DATA_DIR).load()?.db;
  const ctx = db.complianceContexts.find((c) => c.id === CTX1);
  neg(ctx.parties.find((p) => p.partyRole === 'individual').removed === true && ctx.history.filter((h) => h.by?.kind === 'player').every((h) => h.by.name === null), 'AJ2 the context keeps the party as an id-only removed party; player attributions are nulled');
  neg(db.regulatoryConsents.filter((k) => k.subject?.id === 'pl-adeyemi').every((k) => (k.grantedBy?.kind !== 'player' || k.grantedBy.name === null) && (k.history ?? []).every((h) => h.by?.kind !== 'player' || h.by.name === null)), 'AJ3 consent rows keep the subject id and lose the person\'s name');
  const c1 = await j('GET', `/org/agent/compliance/contexts/${CTX1}`, undefined, ANA.token);
  neg(c1.body.context.parties[0].name === null && c1.body.context.parties[0].removed === true, 'AJ4 the agent sees a removed party with no name');
  neg(expect(collect('AJ5', await j('POST', '/ts/reviewers/tsr-dev-admin2/revoke', {}, PRIYA.token)), 200, null) && expect(collect('AJ6', await j('POST', '/ts/reviewers/tsr-dev-admin/revoke', {}, PRIYA.token)), 409, 'LAST_REVIEWER_ADMIN'), 'AJ5 with one administrator left, the last one cannot be revoked');
}

// ============================================================ Z — the refusal sweep
section('Z — every refusal in this run: a code, no private field');
{
  ok(ERROR_BODIES.length > 60, `Z9 ${ERROR_BODIES.length} refusals collected`);
    neg(ERROR_BODIES.every((e) => typeof e.body?.error === 'string' || (e.body === null && e.status === 404)), 'Z10 every JSON refusal carried an error code (a 404 for a route that does not exist has no body)');
  neg(ERROR_BODIES.every((e) => !('stack' in (e.body ?? {})) && !('internal' in (e.body ?? {}))), 'Z11 no stack or internal field');
  const text = JSON.stringify(ERROR_BODIES.map((e) => e.body));
  neg(!/PRIVATE_DISPUTE_TEXT|mandate letter|Marcus|Priya|Léa|Eve Laurent|Dan Mensah|Kola Adeyemi|Mateus|evidenceRefs":\s*\[/.test(text), 'Z12 no dispute reason, evidence, reviewer name or party name in any refusal');
  neg(!/"agentUserId"|"note":/.test(text), 'Z13 no agent id and no prose reason rides on a reason entry');
}

console.log(`\nM23 P5.6C Compliance suite: ${passed} checks passed, ${negatives} negative/security/safeguarding checks (${Math.round((negatives / passed) * 100)}%)`);
if (process.exitCode) { console.error('M23 P5.6C Compliance suite has failures.'); } else console.log('all M23 P5.6C Compliance checks passed');
server.kill('SIGTERM');
