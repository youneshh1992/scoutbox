// The rules behind the agent cross-app battery (e2e/agents/crossApp.mjs), checked in this process: the integration
// seam (one basis, the canonical predicate), every surface's decision, contact routing, the Club-facing presence,
// the handoff preconditions, the disclosure defaults, the trial projection, the declared stores, events,
// notification categories and error tables, and the agreement-in-force predicate behind Trust.
import {
  SURFACES,
  SURFACE_NAMES,
  SURFACE_DISCLOSURE,
  POLICY_ACTION_FOR_SURFACE,
  RULE_ORDER,
  DENY_CODES,
  CONTACT_ROUTING_MODES,
  DISCLOSURE_KEYS,
  DISCLOSURE_DEFAULT,
  normaliseDisclosure,
  agentClientBasis,
  agentSurfaceDecision,
  contactRouting,
  contactTargetSnapshot,
  clubAgentPresence,
  surfaceIsRegulated,
  surfaceScopes,
  HANDOFF_STATUSES,
  HANDOFF_BLOCKERS,
  HANDOFF_TTL_MS,
  effectiveHandoffStatus,
  handoffBlockers,
  duplicateTransactionOf,
} from '../../../domains/agents/integration/integration.mjs';
import {
  agreementGrantsAccess,
  agreementInForce,
  effectiveAgreementStatus,
  PERMISSIONS,
  can,
  MAX_OPPORTUNITY_SHARES,
  SCOPES,
} from '../../../domains/agents/core/shared.mjs';
import {
  CONTACT_MODES,
  CONTACT_STATUSES,
  contactIntegrity,
  contactView,
  contactMilestone,
} from '../../../domains/recruitment/lifecycle/contact.mjs';
import { LIFECYCLE_ERROR_HTTP, httpStatusFor } from '../../../domains/recruitment/lifecycle/errors.mjs';
import { TRANSACTION_ERROR_HTTP } from '../../../domains/agents/transactions/errors.mjs';
import { TERMINAL_STATUSES } from '../../../domains/agents/transactions/transaction.mjs';
import { TRIAL_SCHEDULE_VIEWERS } from '../../../domains/recruitment/lifecycle/trial.mjs';
import { POLICY_ACTIONS, MINOR_PATHWAY_PRODUCTION_ENABLED } from '../../../domains/agents/compliance/policy.mjs';
import { EVENT_REGISTRY, EVENT_NAMES } from '../../../domains/platform/eventRegistry.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../../../domains/platform/notificationPrefs.mjs';
import { DATA_MIGRATIONS, TABLE_BACKED } from '../../../repositories/index.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('agents/crossApp');

const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);
const T0 = Date.UTC(2026, 8, 19);
const DAY = 86_400_000;

const basis = (over = {}) => ({
  ok: true,
  agentUserId: 'usr-ana',
  agreementId: 'rep-1',
  scope: ['employment'],
  agencyOrgId: 'org-northstar',
  status: 'active',
  ...over,
});
const agreement = (over = {}) => ({
  id: 'rep-1',
  agentUserId: 'usr-ana',
  agencyOrgId: 'org-northstar',
  clientId: 'pl-kola',
  status: 'active',
  confirmedAt: T0 - 10 * DAY,
  endAt: T0 + 300 * DAY,
  scope: ['employment'],
  ...over,
});

section('pure A — the seam: one basis, and it is the canonical predicate');
{
  ok(
    SURFACE_NAMES.length === 10,
    'A-p1 ten declared integration surfaces — every question another app can ask has a name',
  );
  ok(
    SURFACE_NAMES.every(
      (s) =>
        typeof SURFACES[s].regulated === 'boolean' &&
        (SURFACES[s].scopes === null || Array.isArray(SURFACES[s].scopes)),
    ),
    'A-p2 each declares whether it is a regulated action and which scopes it needs',
  );
  ok(
    RULE_ORDER.length === 11 && RULE_ORDER[0] === 'SURFACE_KNOWN' && RULE_ORDER[1] === 'BASIS',
    'A-p3 the rule stack is fixed and named, basis second — nothing is decided before authority is',
  );
  ok(
    RULE_ORDER.indexOf('BLOCK') < RULE_ORDER.indexOf('SCOPE') &&
      RULE_ORDER.indexOf('BLOCK') < RULE_ORDER.indexOf('COMPLIANCE'),
    'A-p4 BLOCK is applied before scope and before compliance: safety outranks every convenience, and a compliance answer never overrides it',
  );
  ok(
    RULE_ORDER.indexOf('ADULT') < RULE_ORDER.indexOf('BLOCK') &&
      RULE_ORDER.indexOf('MINOR_PATHWAY') < RULE_ORDER.indexOf('BLOCK'),
    'A-p5 and age is applied before both',
  );
  ok(DENY_CODES.length === 12 && new Set(DENY_CODES).size === 12, 'A-p6 twelve distinct deny codes, one meaning each');
  neg(
    !DENY_CODES.some((c) => /minor|age|dob|birth/i.test(c) && c !== 'MINOR_PATHWAY_DISABLED'),
    'A-p7 no deny code is an age oracle beyond the one named pathway',
  );
  ok(
    Object.keys(POLICY_ACTION_FOR_SURFACE).every((s) => POLICY_ACTIONS.includes(POLICY_ACTION_FOR_SURFACE[s])),
    'A-p8 every regulated surface maps to a real policy action, not a name of its own',
  );
  ok(
    SURFACE_NAMES.filter(surfaceIsRegulated).every((s) => Object.hasOwn(POLICY_ACTION_FOR_SURFACE, s)),
    'A-p9 and every regulated surface HAS a mapping — a regulated surface with nothing to ask would be unenforceable',
  );
  neg(
    !SURFACE_NAMES.some((s) => /offer|fee|commission|negotiat|sign/i.test(s)),
    'A-p10 no surface names an offer, a fee, a negotiation or a signing',
  );
}

section('pure B — canonical authority: the basis is agreementGrantsAccess and nothing else');
{
  const good = agreement();
  ok(
    agentClientBasis({ agreements: [good], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === true,
    'B-p1 an active, client-confirmed, unexpired agreement naming this agent IS a basis',
  );
  ok(
    agentClientBasis({ agreements: [good], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).agentUserId ===
      'usr-ana',
    'B-p2 and the basis NAMES the individual — a routing snapshot that has to re-derive it records nobody',
  );
  neg(
    agentClientBasis({
      agreements: [agreement({ confirmedAt: null, status: 'proposed' })],
      agentUserId: 'usr-ana',
      clientId: 'pl-kola',
      now: T0,
    }).ok === false,
    'B-p3 a proposal is not a basis: nothing is active until the client confirms it',
  );
  neg(
    agentClientBasis({
      agreements: [agreement({ status: 'disputed', disputedAt: T0 })],
      agentUserId: 'usr-ana',
      clientId: 'pl-kola',
      now: T0,
    }).ok === false,
    'B-p4 a dispute is not a basis (#13)',
  );
  neg(
    agentClientBasis({
      agreements: [agreement({ endAt: T0 - DAY })],
      agentUserId: 'usr-ana',
      clientId: 'pl-kola',
      now: T0,
    }).ok === false,
    'B-p5 an active agreement past its end is not a basis — expiry is derived, never waited for (#13, T)',
  );
  neg(
    agentClientBasis({ agreements: [agreement()], agentUserId: 'usr-someone-else', clientId: 'pl-kola', now: T0 })
      .ok === false,
    'B-p6 a colleague at the same agency is not a basis (#3, #4)',
  );
  neg(
    agentClientBasis({ agreements: [agreement()], agentUserId: 'usr-ana', clientId: 'pl-other', now: T0 }).ok === false,
    'B-p7 and the basis is per CLIENT: an agreement about one player says nothing about another (#25)',
  );
  neg(
    agentClientBasis({ agreements: [agreement()], agentUserId: null, clientId: 'pl-kola', now: T0 }).ok === false,
    'B-p8 a missing agent id is not a wildcard',
  );
  ok(
    agentClientBasis({
      agreements: [agreement({ status: 'disputed', disputedAt: T0 })],
      agentUserId: 'usr-ana',
      clientId: 'pl-kola',
      now: T0,
    }).status === 'disputed',
    'B-p9 the non-active state is reported to the AGENT, who already knows the relationship exists',
  );
  neg(
    agentClientBasis({ agreements: [], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).status === null,
    'B-p10 and "none at all" is a different answer from "not active" — a third party gets neither',
  );
}

section('pure C — a legacy row can never grant authority');
{
  // A legacy agency-level row has agentUserId: null. It is history.
  const mirror = agreement({ agentUserId: null, legacy: { fromRepresentationId: 'rep-legacy-1' } });
  neg(
    agreementGrantsAccess(mirror, null, T0) === false,
    'C-p1 a legacy mirror does not grant access even to a caller with no id (#1)',
  );
  neg(agreementGrantsAccess(mirror, 'usr-ana', T0) === false, 'C-p2 nor to a real agent (#1)');
  neg(
    agentClientBasis({ agreements: [mirror], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).ok === false,
    'C-p3 and it produces no basis, so no surface can be reached through it (#2)',
  );
  neg(
    agentClientBasis({ agreements: [mirror], agentUserId: 'usr-ana', clientId: 'pl-kola', now: T0 }).status === null,
    'C-p4 it does not even register as a non-active relationship — it names nobody, so there is nothing to be non-active about',
  );
  ok(
    effectiveAgreementStatus(mirror, T0) === 'active',
    'C-p5 the mirrored row may still READ as active — it is history, and the predicate is what withholds authority, not a rewrite of the record',
  );
}

section('pure — every surface fails closed, rule by rule');
{
  const full = {
    basis: basis(),
    subjectPresent: true,
    isAdult: true,
    minorPathwayOpen: false,
    blocked: false,
    disclosure: true,
    shared: true,
    licenceCurrent: true,
    complianceClear: true,
  };
  for (const s of SURFACE_NAMES)
    ok(agentSurfaceDecision({ surface: s, ...full }).allowed === true, `S-p1 ${s} allows when every fact is satisfied`);
  neg(
    agentSurfaceDecision({ surface: 'nope', ...full }).code === 'SURFACE_UNKNOWN',
    'S-p2 an unknown surface denies SURFACE_UNKNOWN',
  );
  neg(
    agentSurfaceDecision({ surface: '__proto__', ...full }).code === 'SURFACE_UNKNOWN',
    'S-p3 and a prototype name is not a surface',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, basis: null }).code === 'NO_REPRESENTATION',
    'S-p4 no basis → NO_REPRESENTATION',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, basis: { ok: false, status: 'expired' } }).code ===
      'REPRESENTATION_NOT_ACTIVE',
    'S-p5 a basis that once existed → REPRESENTATION_NOT_ACTIVE',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, subjectPresent: false }).code === 'SUBJECT_UNAVAILABLE',
    'S-p6 a removed subject → SUBJECT_UNAVAILABLE (#34)',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, isAdult: false }).code === 'MINOR_PATHWAY_DISABLED',
    'S-p7 a minor → MINOR_PATHWAY_DISABLED on every adultOnly surface (Z, #7, #8, #9)',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, basis: basis({ isRegulatoryMinor: true }) }).code ===
      'MINOR_PATHWAY_DISABLED',
    'S-p8 and a regulatory minor is refused even where the visibility age passed',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, blocked: true }).code === 'BLOCKED',
    'S-p9 a block → BLOCKED (Y, #26, #27)',
  );
  neg(
    agentSurfaceDecision({ surface: 'client_private', ...full, blocked: true, complianceClear: true }).code ===
      'BLOCKED',
    'S-p10 and a CLEAR compliance answer does not override it',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, basis: basis({ scope: ['commercial'] }) })
      .code === 'SCOPE_INSUFFICIENT',
    'S-p11 a commercial-only mandate cannot be a party to an employment contact → SCOPE_INSUFFICIENT',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, disclosure: null }).code ===
      'DISCLOSURE_WITHHELD',
    'S-p12 silence is not consent: a null disclosure → DISCLOSURE_WITHHELD',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, disclosure: false }).code ===
      'DISCLOSURE_WITHHELD',
    'S-p13 and an explicit no is a no',
  );
  neg(
    agentSurfaceDecision({ surface: 'passport_shared', ...full, shared: false }).code === 'SHARE_REQUIRED',
    'S-p14 a surface needing an explicit share → SHARE_REQUIRED',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, licenceCurrent: false }).code ===
      'LICENCE_NOT_CURRENT',
    'S-p15 a regulated surface with a stale licence → LICENCE_NOT_CURRENT (W, #11, #12)',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, complianceClear: null }).code ===
      'COMPLIANCE_NOT_CLEAR',
    'S-p16 "not evaluated" is not clear → COMPLIANCE_NOT_CLEAR (R)',
  );
  neg(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, complianceClear: false }).code ===
      'COMPLIANCE_NOT_CLEAR',
    'S-p17 and neither is a no',
  );
  ok(
    agentSurfaceDecision({ surface: 'client_private', ...full, complianceClear: null }).allowed === true,
    "S-p18 an UNregulated surface asks the compliance layer nothing — it is a read of the agent's own client",
  );
  // The order matters: the FIRST rule that refuses is the code, so a refusal is
  // explainable without being an oracle for the later facts.
  ok(
    agentSurfaceDecision({
      surface: 'contact_participation',
      ...full,
      isAdult: false,
      blocked: true,
      licenceCurrent: false,
    }).code === 'MINOR_PATHWAY_DISABLED',
    'S-p19 the first refusal in RULE_ORDER wins, so a refusal never leaks the later facts',
  );
  ok(
    agentSurfaceDecision({ surface: 'contact_participation', ...full, blocked: true, licenceCurrent: false }).code ===
      'BLOCKED',
    'S-p19b and a blocked player is refused before the licence is even consulted',
  );
  ok(
    DENY_CODES.includes(agentSurfaceDecision({ surface: 'nope' }).code),
    'S-p20 every deny code the decision can produce is in the declared list',
  );
}

section('pure — contact routing adds the agent BESIDE the player, never instead');
{
  ok(
    CONTACT_MODES.join() === 'player_only,both' && CONTACT_ROUTING_MODES.join() === 'player_only,both',
    'H-p1 two modes, and the Contact domain and the integration layer agree on them',
  );
  neg(
    !CONTACT_MODES.includes('agent_only') && !CONTACT_ROUTING_MODES.includes('agent_only'),
    'H-p2 there is NO mode that reaches an agent instead of the player: a message with no player Inbox row could not honestly be "delivered", and making it honest would need a second Inbox, which is forbidden',
  );
  const player = { type: 'player', playerId: 'pl-kola', guardianId: null, minor: false };
  const guardian = { type: 'guardian', playerId: 'pl-guni', guardianId: 'gd-amara', minor: true };
  const allow = { allowed: true, basis: basis() };
  const both = contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'both' });
  ok(
    both.mode === 'both' &&
      both.targets.length === 2 &&
      both.targets[0] === player &&
      both.agent?.agentUserId === 'usr-ana',
    'H-p3 "both" routes to the player AND the agent, player first',
  );
  ok(
    contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'player_only' }).agent === null,
    'H-p4 "player_only" routes to the player alone even where an agent would be permitted',
  );
  const refused = contactRouting({
    recipient: player,
    agentDecision: { allowed: false, code: 'DISCLOSURE_WITHHELD' },
    requestedMode: 'both',
  });
  ok(
    refused.mode === 'player_only' && refused.targets.length === 1 && refused.agentRefusal === 'DISCLOSURE_WITHHELD',
    'H-p5 asking for the agent and being refused falls back to the player and NAMES the rule — the player is always a valid route, so the contact does not fail',
  );
  const minor = contactRouting({ recipient: guardian, agentDecision: allow, requestedMode: 'both' });
  ok(
    minor.mode === 'player_only' &&
      minor.targets[0] === guardian &&
      minor.agent === null &&
      minor.agentRefusal === 'MINOR_PATHWAY_DISABLED',
    "H-p6 a minor's route stays the guardian's and no agent is substituted for a guardian (Z)",
  );
  neg(
    contactRouting({
      recipient: player,
      agentDecision: { allowed: true, basis: basis({ agentUserId: null }) },
      requestedMode: 'both',
    }).agent === null,
    'H-p7 a basis that names no individual routes no agent: a snapshot claiming an agent with no agent in it is worse than no snapshot',
  );
  neg(
    contactRouting({ recipient: null, agentDecision: allow, requestedMode: 'both' }).ok === false,
    'H-p8 no recipient at all is a refusal, not a route to the agent alone',
  );
  ok(
    contactRouting({ recipient: player, agentDecision: allow, requestedMode: 'agent_only' }).mode === 'player_only',
    'H-p9 an unknown mode is read as the safest one rather than honoured',
  );
  const snap = contactTargetSnapshot(both, T0);
  ok(
    snap.at === T0 && snap.mode === 'both' && snap.player === true && snap.agent?.agentUserId === 'usr-ana',
    'H-p10 the snapshot records WHO was validly routed, as roles and ids',
  );
  ok(
    contactTargetSnapshot(minor, T0).guardian === true && contactTargetSnapshot(minor, T0).agent === null,
    'H-p11 a guardian route is recorded as a guardian route',
  );
  ok(/does not rewrite it/i.test(snap.honest), 'H-p12 and it says in words that a later change does not rewrite it');
  ok(contactTargetSnapshot({ ok: false }, T0) === null, 'H-p13 a failed routing produces no snapshot');
}

section("pure — the Club-facing agent presence is the PLAYER's disclosure, not the agent's wish");
{
  ok(
    clubAgentPresence({ decision: { allowed: false, code: 'DISCLOSURE_WITHHELD' } }) === null,
    'E-p1 a refused decision projects NOTHING — absent, not an empty badge',
  );
  const p = clubAgentPresence({
    decision: { allowed: true },
    agent: { displayName: 'Ana Costa' },
    agency: { id: 'org-northstar', name: 'North Star' },
    facets: { fifa_licence: 'VERIFIED', national_registration: { ENG: 'VERIFIED' } },
  });
  ok(
    p.represented === true && p.agent.displayName === 'Ana Costa' && p.agency.name === 'North Star',
    'E-p2 an allowed decision names the agent and the agency',
  );
  ok(
    p.verification.fifaLicence === 'VERIFIED' && p.verification.nationalRegistration === 'unknown',
    'E-p3 facet by facet, and a facet ScoutBox has not checked reads "unknown" rather than being omitted',
  );
  neg(
    !/fee|commission|salary|term/i.test(JSON.stringify({ ...p, honest: '' })),
    'E-p4 no agreement term, no commission and no fee has a field to arrive in',
  );
  ok(
    /not a licence register|does not speak for any governing body/i.test(p.honest),
    'E-p5 and it says plainly that ScoutBox is not a licence register',
  );
  ok(Object.keys(p).length === 6, 'E-p6 the projection is exactly six fields — deliberately thin');
}

section('pure — the handoff preconditions, and the duplicate rule');
{
  ok(HANDOFF_STATUSES.join() === 'invited,accepted,withdrawn,expired', 'P-p1 four handoff states');
  neg(!HANDOFF_STATUSES.some((s) => /offer|sign/i.test(s)), 'P-p2 none of them names an offer or a signing');
  ok(HANDOFF_BLOCKERS.length === 9 && new Set(HANDOFF_BLOCKERS).size === 9, 'P-p3 nine distinct blockers');
  const facts = {
    canWrite: true,
    hasFinalProgressDecision: true,
    caseStatus: 'offer_consideration',
    subjectPresent: true,
    isAdult: true,
    minorPathwayOpen: false,
    blocked: false,
    existingHandoffStatus: null,
    liveTransactionId: null,
    complianceEvaluable: true,
  };
  ok(handoffBlockers(facts).length === 0, 'P-p4 every precondition met → no blockers');
  neg(
    (handoffBlockers({ ...facts, hasFinalProgressDecision: false })[0] === 'HANDOFF_NOT_PERMITTED') === false,
    'P-p5 a missing decision is reported as HANDOFF_DECISION_REQUIRED, not as a permission problem',
  );
  ok(
    handoffBlockers({ ...facts, hasFinalProgressDecision: false }).includes('HANDOFF_DECISION_REQUIRED'),
    'P-p5b (the code it actually reports)',
  );
  neg(
    handoffBlockers({ ...facts, canWrite: false })[0] === 'HANDOFF_NOT_PERMITTED',
    'P-p6 permission is reported first, so a viewer is told it is not theirs to do rather than handed a checklist',
  );
  neg(
    handoffBlockers({ ...facts, caseStatus: 'watching' }).includes('HANDOFF_CASE_STATE'),
    'P-p7 a case at watching cannot hand off',
  );
  neg(handoffBlockers({ ...facts, isAdult: false }).includes('HANDOFF_MINOR_PATHWAY_DISABLED'), 'P-p8 nor a minor (Z)');
  neg(handoffBlockers({ ...facts, blocked: true }).includes('HANDOFF_BLOCKED'), 'P-p9 nor through a block (Y)');
  neg(
    handoffBlockers({ ...facts, existingHandoffStatus: 'invited' }).includes('HANDOFF_EXISTS'),
    'P-p10 nor twice (Q)',
  );
  neg(
    handoffBlockers({ ...facts, liveTransactionId: 'atx-1' }).includes('HANDOFF_TRANSACTION_EXISTS'),
    'P-p11 nor where a live transaction already covers it (Q)',
  );
  neg(
    handoffBlockers({ ...facts, complianceEvaluable: false }).includes('HANDOFF_COMPLIANCE_UNAVAILABLE'),
    'P-p12 nor where compliance cannot be evaluated (R)',
  );
  ok(
    handoffBlockers({ ...facts, existingHandoffStatus: 'withdrawn' }).length === 0,
    'P-p13 a withdrawn invitation does not block a fresh one',
  );
  ok(
    handoffBlockers({}).length >= 5,
    'P-p14 called with nothing, it refuses on several counts — the defaults are all "no"',
  );
  // "Do not expose internal rationale" is enforced by the signature.
  neg(
    !/reason|note|evidence|rationale|outcome/i.test(handoffBlockers.toString().split('{')[0]),
    "P-p15 the precondition function does not TAKE the decision's reasons, note, evidence or author, so no refusal can leak them",
  );
  ok(
    effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - HANDOFF_TTL_MS - 1 }, T0) === 'expired',
    'P-p16 an invitation nobody took up reads as expired, derived from the clock',
  );
  ok(
    effectiveHandoffStatus({ status: 'invited', invitedAt: T0 - DAY }, T0) === 'invited',
    'P-p17 and a fresh one does not',
  );
  ok(effectiveHandoffStatus({ status: 'bogus' }, T0) === null, 'P-p18 an unrecognised stored status is not a status');

  const parties = (individual, engaging, releasing) => [
    { partyRole: 'individual', subjectId: individual, removed: false },
    ...(engaging ? [{ partyRole: 'engaging_entity', subjectId: engaging, removed: false }] : []),
    ...(releasing ? [{ partyRole: 'releasing_entity', subjectId: releasing, removed: false }] : []),
  ];
  const tx = (id, type, status, ps) => ({ id, type, status, parties: ps });
  const list = [tx('atx-1', 'employment_contract', 'ACTIVE', parties('pl-kola', 'org-eastport', null))];
  const args = {
    clientId: 'pl-kola',
    type: 'employment_contract',
    engagingOrgId: 'org-eastport',
    releasingOrgId: null,
    terminalStatuses: TERMINAL_STATUSES,
    partiesOf: (t) => t.parties,
  };
  ok(
    duplicateTransactionOf(list, args)?.id === 'atx-1',
    'Q-p1 same individual, same type, same clubs, still live → a duplicate',
  );
  neg(
    duplicateTransactionOf(list, { ...args, type: 'loan' }) === null,
    'Q-p2 a loan beside an employment contract is a legitimately separate transaction ("do not over-block")',
  );
  neg(
    duplicateTransactionOf(list, { ...args, engagingOrgId: 'org-harbour' }) === null,
    'Q-p3 a different engaging club is a different transaction — two clubs competing is normal',
  );
  neg(
    duplicateTransactionOf(list, { ...args, releasingOrgId: 'org-harbour' }) === null,
    'Q-p4 and adding a releasing side makes it a different context',
  );
  neg(
    duplicateTransactionOf(list, { ...args, clientId: 'pl-other' }) === null,
    'Q-p5 and a different individual entirely',
  );
  neg(
    duplicateTransactionOf(
      [tx('atx-2', 'employment_contract', 'CANCELLED', parties('pl-kola', 'org-eastport', null))],
      args,
    ) === null,
    'Q-p6 a cancelled transaction does not block its replacement',
  );
  neg(
    duplicateTransactionOf(
      [
        tx('atx-3', 'employment_contract', 'ACTIVE', [
          { partyRole: 'individual', subjectId: 'pl-kola', removed: true },
          { partyRole: 'engaging_entity', subjectId: 'org-eastport', removed: false },
        ]),
      ],
      args,
    ) === null,
    'Q-p7 a removed party does not make a context — a tombstone blocks nothing',
  );
}

section('pure — disclosure defaults to off, and only an explicit yes is a yes');
{
  ok(
    DISCLOSURE_KEYS.length === 3 && DISCLOSURE_KEYS.join() === 'clubPresence,contactRouting,trialVisibility',
    'D-p1 three separate disclosure choices',
  );
  ok(
    Object.values(DISCLOSURE_DEFAULT).every((v) => v === false),
    'D-p2 every one defaults to FALSE — confirming a relationship turns none of them on',
  );
  ok(
    Object.values(normaliseDisclosure(undefined)).every((v) => v === false),
    'D-p3 an absent object is all-off',
  );
  ok(
    Object.values(normaliseDisclosure(null)).every((v) => v === false),
    'D-p4 and so is null',
  );
  neg(normaliseDisclosure({ contactRouting: 'yes' }).contactRouting === false, 'D-p5 a truthy string is not a yes');
  neg(normaliseDisclosure({ contactRouting: 1 }).contactRouting === false, 'D-p6 nor is a 1');
  ok(
    normaliseDisclosure({ contactRouting: true }).contactRouting === true &&
      normaliseDisclosure({ contactRouting: true }).clubPresence === false,
    'D-p7 answering one question does not answer the others',
  );
  neg(
    Object.keys(normaliseDisclosure({ __proto__: { clubPresence: true } })).length === 3 &&
      normaliseDisclosure({ constructor: true }).clubPresence === false,
    'D-p8 a prototype key is not a disclosure',
  );
  ok(
    SURFACE_DISCLOSURE.contactRouting === undefined && SURFACE_DISCLOSURE.contact_participation === 'contactRouting',
    'D-p9 the surface→disclosure map is keyed by SURFACE, so a surface cannot read the wrong choice',
  );
  ok(
    SURFACE_NAMES.filter((s) => SURFACES[s].needsDisclosure).every((s) =>
      DISCLOSURE_KEYS.includes(SURFACE_DISCLOSURE[s]),
    ),
    'D-p10 and every surface that needs a disclosure names a real one',
  );
  neg(
    !SURFACE_NAMES.some((s) => s !== 'club_agent_presence' && SURFACE_DISCLOSURE[s] === 'clubPresence'),
    'D-p11 the club-presence choice gates exactly one surface: it is not a general "share more" switch',
  );
}

section('pure K/L/M — the trial projection is scheduling, and nothing adjacent to it');
{
  ok(
    TRIAL_SCHEDULE_VIEWERS.join() === 'club,family_accepted,agent',
    'K-p1 three named trial-schedule viewers, the agent last and narrowest',
  );
  ok(
    surfaceScopes('trial_projection').join() === 'employment,transfer',
    'K-p2 a trial projection needs an employment or transfer mandate',
  );
  neg(
    surfaceIsRegulated('trial_projection') === false,
    'K-p3 reading a schedule is not itself a regulated act — it needs a mandate and a disclosure, not a licence check',
  );
  ok(
    surfaceIsRegulated('trial_coordination') === true,
    'K-p4 but coordinating one would be, which is why it is declared separately',
  );
  ok(
    SURFACES.trial_projection.needsDisclosure === true && SURFACES.trial_coordination.needsDisclosure === true,
    "L-p1 both trial surfaces need the client's own choice",
  );
  neg(
    !SURFACE_NAMES.some((s) => /assessment|report|box_?cam|scorecard/i.test(s)),
    'L-p2 there is NO surface for a trial assessment, a trial report or Box Cam footage — the boundary is that the question cannot be asked (#15, M)',
  );
}

section('pure — no new store, and no migration');
{
  ok(
    DATA_MIGRATIONS.length === SCHEMA_VERSION,
    'AN-p1 the schema is 40, the latest table migration (0040_match_facts)',
  );
  neg(
    !DATA_MIGRATIONS.some((m) => /disclosure|handoff|share/i.test(m.id)),
    'AN-p3 no cross-app migration exists at all (no disclosure, handoff or share table of its own; 0034_integrations is the enterprise API)',
  );
  const p56e = [
    'agentOpportunityShares',
    'representationDisclosures',
    'transactionHandoffs',
    'agentContacts',
    'agentTrials',
  ];
  neg(
    !p56e.some((s) => TABLE_BACKED.includes(s)),
    'AN-p4 and none of the five stores the cross-app lane might have declared exists — the disclosure lives on the agreement, the share lives on the agreement, and the handoff lives on the case',
  );
  ok(MAX_OPPORTUNITY_SHARES === 200, 'AN-p5 the share list is capped, so an unbounded array cannot grow on a hot row');
}

section('pure AG/AH — events and notifications: ids only, and the right categories');
{
  const mine = [
    'representation_disclosure_changed',
    'contact_agent_routed',
    'agent_opportunity_shared',
    'transaction_handoff_invited',
    'transaction_handoff_withdrawn',
  ];
  for (const n of mine) ok(EVENT_NAMES.includes(n), `AG-p1 ${n} is in the registry`);
  for (const n of mine) {
    const e = EVENT_REGISTRY[n];
    ok(e.audience === 'org_private' && e.privacyClass === 'org_internal', `AG-p2 ${n} is org-private`);
    neg(
      !e.payload.some((k) => /dob|birth|email|phone|note|body|text|name|reason|outcome|subject/i.test(k)),
      `AG-p3 ${n} carries no personal field, no prose and no outcome`,
    );
    ok(e.replayPolicy === 'never', `AG-p4 ${n} is never replayed — an integration event is a nudge, not a record`);
  }
  ok(
    EVENT_REGISTRY.contact_agent_routed.payload.join() === 'orgId,contactId,agentUserId',
    "AG-p5 the routing event carries three ids and nothing else: not the club's name, not the subject, not a word of the message",
  );
  neg(
    !EVENT_REGISTRY.transaction_handoff_invited.payload.some((k) => /decision|outcome|reason/i.test(k)),
    "AG-p6 the handoff event carries nothing of the club's internal decision",
  );
  const notifs = [
    'representation_disclosure',
    'representation_contact',
    'representation_opportunity',
    'representation_transaction',
  ];
  for (const t of notifs)
    ok(
      typeof TYPE_CATEGORY[t] === 'string' && Object.hasOwn(CATEGORIES, TYPE_CATEGORY[t]),
      `AH-p1 ${t} maps to a real notification category`,
    );
  ok(
    TYPE_CATEGORY.representation_transaction === 'transaction_updates' &&
      CATEGORIES.transaction_updates.mandatory !== true,
    'AH-p2 workspace traffic is the non-mandatory transaction category — a club inviting a workspace is operational, not a safety matter',
  );
  ok(
    TYPE_CATEGORY.representation_opportunity === 'messages',
    'AH-p3 an opportunity an agent shared is a message about a real chance, not relationship admin',
  );
}

section('pure AO — the error tables have no default, so a new code cannot inherit a status');
{
  ok(
    httpStatusFor('CONTACT_MODE_INVALID') === 400,
    'AO-p1 an unknown routing mode is 400: the request is wrong and the caller can fix it',
  );
  ok(
    LIFECYCLE_ERROR_HTTP.CONTACT_MODE_INVALID === 400,
    'AO-p2 and it is IN the table — an undeclared code answers 500, which is how this one was caught',
  );
  ok(
    TRANSACTION_ERROR_HTTP.TRANSACTION_DUPLICATE_CONTEXT === 409,
    'AO-p3 a duplicate context is 409: nothing in the request to fix',
  );
  for (const c of ['HANDOFF_NOT_FOUND', 'HANDOFF_NOT_OPEN', 'HANDOFF_SUBJECT_MISMATCH', 'HANDOFF_NOT_ADDRESSED']) {
    ok(
      TRANSACTION_ERROR_HTTP[c] === 409,
      `AO-p4 ${c} is 409: the citation is well-formed, the invitation is not there for it`,
    );
  }
  neg(
    !Object.keys(LIFECYCLE_ERROR_HTTP).some(
      (c) => /agent|representation|disclosure/i.test(c) && LIFECYCLE_ERROR_HTTP[c] >= 500,
    ),
    'AO-p5 no integration code answers 5xx — a refusal is never presented as our fault',
  );
  const corrupt = contactIntegrity({
    id: 'rct-x',
    status: 'delivered',
    channel: 'in_app',
    playerId: 'pl-kola',
    recipient: { type: 'player' },
    deliveredAt: T0,
    contactMode: 'agent_only',
  });
  neg(
    corrupt.includes('contact_mode_unknown'),
    'AO-p6 a stored mode this build does not recognise is named as corruption, not read as permission',
  );
  const badSnap = contactIntegrity({
    id: 'rct-y',
    status: 'draft',
    channel: 'in_app',
    playerId: 'pl-kola',
    routingSnapshot: { at: T0, mode: 'both', agent: { agentUserId: 'usr-ana' } },
  });
  neg(
    badSnap.includes('routing_snapshot_unsent'),
    'AO-p7 a routed agent on a contact that never left the building is a contradiction, and is named',
  );
  const nullAgent = contactIntegrity({
    id: 'rct-z',
    status: 'delivered',
    channel: 'in_app',
    playerId: 'pl-kola',
    recipient: { type: 'player' },
    deliveredAt: T0,
    routingSnapshot: { at: T0, mode: 'both', agent: { agentUserId: null } },
  });
  neg(
    nullAgent.includes('routing_snapshot_malformed'),
    'AO-p8 and a snapshot claiming an agent who is nobody is malformed, not trusted',
  );
  const view = contactView({
    id: 'rct-1',
    status: 'draft',
    channel: 'in_app',
    contactMode: 'both',
    routingSnapshot: null,
    history: [],
  });
  ok(
    view.contactMode === 'both' && view.routedToAgent === false && view.routedAt === null,
    'AO-p9 the club view shows what it asked for and what was actually routed',
  );
  neg(
    !/agentUserId|usr-/.test(JSON.stringify(view)),
    "AO-p10 and never the agent's id — the club has the presence projection for that, gated on the player's own choice",
  );
  ok(
    contactMilestone({
      id: 'rct-1',
      status: 'delivered',
      channel: 'in_app',
      routingSnapshot: { agent: { agentUserId: 'usr-ana' } },
    }).routedToAgent === true,
    'AO-p11 the journey milestone carries the routing as a boolean — a state, never a name',
  );
}

section('pure — the club never reads agent data merely because the player exists');
{
  ok(
    can(['licensed_agent'], 'clients.opportunities.share') === true,
    "G-p1 sharing an opportunity is the licensed individual's",
  );
  neg(can(['agency_admin'], 'clients.opportunities.share') === false, "G-p2 not an agency administrator's (#3)");
  neg(
    can(['analyst'], 'clients.opportunities.share') === false &&
      can(['assistant'], 'clients.opportunities.share') === false &&
      can(['finance'], 'clients.opportunities.share') === false,
    "G-p3 and not a support role's",
  );
  neg(
    can([], 'clients.opportunities.share') === false && can(['licensed_agent'], '__proto__') === false,
    'G-p4 no roles and a prototype name hold nothing',
  );
  ok(PERMISSIONS['clients.opportunities.share'].length === 1, 'G-p5 exactly one tier holds it');
  ok(
    MINOR_PATHWAY_PRODUCTION_ENABLED.ENG === false &&
      MINOR_PATHWAY_PRODUCTION_ENABLED.INT === false &&
      MINOR_PATHWAY_PRODUCTION_ENABLED.USA === false,
    'Z-p1 the minor pathway is production-disabled in every jurisdiction this build knows',
  );
}

section('#37 — a revoked relationship never contributes as an active Trust relationship');
{
  const live = {
    id: 'r',
    agentUserId: 'u',
    clientId: 'p',
    status: 'active',
    confirmedAt: T0 - DAY,
    startAt: T0 - DAY,
    endAt: T0 + 30 * DAY,
  };
  ok(
    agreementInForce(live, T0) &&
      !agreementInForce({ ...live, confirmedAt: null }, T0) &&
      !agreementInForce({ ...live, status: 'disputed' }, T0) &&
      !agreementInForce({ ...live, status: 'terminated_by_client' }, T0),
    '#37d and it requires confirmedAt AND an active status',
  );
  ok(
    !agreementInForce({ ...live, endAt: T0 - 1 }, T0) && !agreementInForce({ ...live, startAt: T0 + DAY }, T0),
    '#37e and a term covering now, so a lapsed agreement (or one not yet started) contributes nothing',
  );
  ok(
    !agreementInForce({ ...live, agentUserId: null }, T0),
    '#37f and an agreement that names nobody counts for nothing (#1)',
  );
}

done();
