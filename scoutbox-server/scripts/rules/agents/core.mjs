// The agent core's rules behind the agents/core battery (e2e/agents/core.mjs), checked in this process: the
// verification engine, the permission matrix, affiliation windows, the agreement engine, and the declared events,
// notification categories, rate policies and stores.
import {
  AGENT_POLICY_VERSION,
  VERIFICATION_STATES,
  FACETS,
  RECHECK_MS,
  JURISDICTIONS,
  newFacets,
  effectiveFacetState,
  evaluateSubmission,
  requiredFacetsFor,
  verificationGap,
  TIERS,
  normaliseTiers,
  affiliationActive,
  tiersOf,
  PERMISSIONS,
  can,
  capabilitiesOf,
  affiliationChangeProblem,
  AGREEMENT_STATUSES,
  SCOPES,
  MAX_TERM_MONTHS,
  DEFAULT_TERM_MONTHS,
  REQUEST_COOLDOWN_MS,
  normaliseScope,
  termMonthsOf,
  termEndAt,
  effectiveAgreementStatus,
  agreementGrantsAccess,
  requestConflict,
  AGENT_TRANSITIONS,
  CLIENT_TRANSITIONS,
  clientTransitionAllowed,
  agentTransitionAllowed,
  agreementForAgent,
  agreementForClient,
  agreementSummaryForStaff,
} from '../../../domains/agents/core/shared.mjs';
import { AGENT_CORE_ERROR_HTTP, PUBLIC_ERROR_FIELDS, publicErrorBody } from '../../../domains/agents/core/errors.mjs';
import { AGENT_AUDIT_ACTIONS } from '../../../domains/agents/core/audit.mjs';
import { EVENT_REGISTRY } from '../../../domains/platform/eventRegistry.mjs';
import { RATE_LIMIT_POLICY } from '../../../domains/platform/rateLimit.mjs';
import { TYPE_CATEGORY, CATEGORIES } from '../../../domains/platform/notificationPrefs.mjs';
import { DATA_MIGRATIONS } from '../../../repositories/index.mjs';
import { AGENT_CORE_MIGRATION } from '../../../repositories/agentCore.mjs';
import { TABLE_BACKED } from '../../../repositories/index.mjs';
import { rulesSuite } from '../../rulesSuite.mjs';

const { ok, neg, section, done } = rulesSuite('agents/core');
const SCHEMA_VERSION = Number(
  DATA_MIGRATIONS.map((m) => m.id)
    .sort()
    .at(-1)
    .slice(0, 4),
);

const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

// ============================================================ A — pure engine
section('A — verification engine: honest states, separate facets, decay, no pretend register');
{
  ok(
    VERIFICATION_STATES.length === 6 &&
      ['UNVERIFIED', 'PENDING', 'VERIFIED', 'STALE', 'INACTIVE', 'MANUAL_REVIEW_REQUIRED'].every((s) =>
        VERIFICATION_STATES.includes(s),
      ),
    'A1 the six honest verification states, exactly',
  );
  neg(
    !VERIFICATION_STATES.includes('APPROVED') &&
      !VERIFICATION_STATES.includes('LICENSED') &&
      !VERIFICATION_STATES.includes('TRUSTED'),
    'A2 no state claims a licence, an approval or trust — a state describes provenance, never authority',
  );
  // The invariant is "separate facets, never one boolean" (domestic_authorisation is DR-53, docs/product/agents.md).
  ok(
    FACETS.length === 4 &&
      FACETS.includes('fifa_licence') &&
      FACETS.includes('national_registration') &&
      FACETS.includes('domestic_authorisation') &&
      FACETS.includes('minors_authorisation'),
    'A3 four separate facets, never one boolean',
  );
  const f = newFacets();
  ok(
    f.fifa_licence.state === 'UNVERIFIED' &&
      f.fifa_licence.reference === null &&
      Object.keys(f.national_registration).length === 0 &&
      Object.keys(f.minors_authorisation).length === 0,
    'A4 a new profile is UNVERIFIED with nothing declared',
  );
  ok(
    effectiveFacetState(null) === 'UNVERIFIED' &&
      effectiveFacetState({}) === 'UNVERIFIED' &&
      effectiveFacetState(undefined) === 'UNVERIFIED',
    'A5 a missing facet reads UNVERIFIED, never anything better',
  );
  ok(
    effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 + DAY }, T0) === 'VERIFIED',
    'A6 VERIFIED before recheckAt is VERIFIED',
  );
  neg(
    effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 }, T0) === 'STALE' &&
      effectiveFacetState({ state: 'VERIFIED', recheckAt: T0 - 1 }, T0) === 'STALE',
    'A7 VERIFIED at or past recheckAt decays to STALE — a verification has a shelf life (DR-6)',
  );
  neg(
    effectiveFacetState({ state: 'VERIFIED' }, T0) === 'VERIFIED',
    'A8 a VERIFIED facet with no recheckAt does not decay (legacy-safe), but the provider always sets one',
  );
  neg(
    effectiveFacetState({ state: 'approved' }, T0) === 'MANUAL_REVIEW_REQUIRED' &&
      effectiveFacetState({ state: 'constructor' }, T0) === 'MANUAL_REVIEW_REQUIRED',
    'A9 an unknown stored state is corruption and reads as MANUAL_REVIEW_REQUIRED, never as VERIFIED',
  );
  ok(RECHECK_MS === 30 * DAY, 'A10 recheck window is 30 days');
  // Provider abstraction.
  const prod = evaluateSubmission({
    facet: 'fifa_licence',
    reference: 'TEST-VERIFIED-1',
    testProviderEnabled: false,
    now: T0,
  });
  neg(
    prod.state === 'MANUAL_REVIEW_REQUIRED' &&
      prod.provenance.provider === 'none' &&
      /G-C0/.test(prod.note) &&
      /not a verification/.test(prod.note),
    'A11 WITHOUT the flag, even a TEST-VERIFIED reference is MANUAL_REVIEW_REQUIRED with provenance "none" and a note naming G-C0 — production never fakes a register',
  );
  const syn = evaluateSubmission({
    facet: 'fifa_licence',
    reference: 'test-verified-1',
    testProviderEnabled: true,
    now: T0,
  });
  ok(
    syn.state === 'VERIFIED' &&
      syn.provenance.provider === 'local-synthetic-test-provider' &&
      syn.provenance.kind === 'synthetic' &&
      syn.recheckAt === T0 + RECHECK_MS &&
      /SYNTHETIC/.test(syn.note) &&
      /never exists in production/.test(syn.note),
    'A12 with the flag, TEST-VERIFIED (case-insensitive) is VERIFIED, provenance names the synthetic provider, note says it never exists in production',
  );
  const inactive = evaluateSubmission({
    facet: 'fifa_licence',
    reference: 'TEST-INACTIVE-9',
    testProviderEnabled: true,
    now: T0,
  });
  ok(inactive.state === 'INACTIVE' && inactive.verifiedAt === null, 'A13 TEST-INACTIVE is INACTIVE');
  const other = evaluateSubmission({
    facet: 'fifa_licence',
    reference: 'FIFA-REAL-LOOKING-123',
    testProviderEnabled: true,
    now: T0,
  });
  neg(
    other.state === 'MANUAL_REVIEW_REQUIRED',
    'A14 with the flag, a real-looking reference is STILL manual review — the synthetic provider verifies only its own tagged references',
  );
  neg(
    evaluateSubmission({ facet: 'fifa_licence', reference: '  ', testProviderEnabled: true, now: T0 }).state ===
      'MANUAL_REVIEW_REQUIRED',
    'A15 an empty reference verifies nothing',
  );
  // Requirements and gaps.
  ok(
    requiredFacetsFor('INT').length === 1 && requiredFacetsFor('INT')[0].facet === 'fifa_licence',
    'A16 INT requires the FIFA licence',
  );
  ok(
    requiredFacetsFor('ENG').length === 2 &&
      requiredFacetsFor('ENG')[1].facet === 'national_registration' &&
      requiredFacetsFor('ENG')[1].ma === 'ENG',
    'A17 ENG additionally requires FA registration (FA 2026-27 basis)',
  );
  neg(
    !requiredFacetsFor('INT').some((r) => r.facet === 'minors_authorisation') &&
      !requiredFacetsFor('ENG').some((r) => r.facet === 'minors_authorisation'),
    'A18 minors_authorisation is required by NO regulated action — the minor pathway is preserved, not activated',
  );
  neg(verificationGap(null, 'INT', T0)?.error === 'AGENT_PROFILE_REQUIRED', 'A19 no profile → AGENT_PROFILE_REQUIRED');
  const p = { facets: newFacets(), declared: { fifaLicenceNumber: 'FIFA-123' } };
  neg(
    verificationGap(p, 'INT', T0)?.error === 'AGENT_VERIFICATION_REQUIRED' &&
      verificationGap(p, 'INT', T0).state === 'UNVERIFIED',
    'A20 a DECLARED licence number with nothing verified is a gap — a typed number is a declaration (S9)',
  );
  p.facets.fifa_licence = { state: 'VERIFIED', recheckAt: T0 + DAY };
  ok(verificationGap(p, 'INT', T0) === null, 'A21 VERIFIED fifa closes the INT gap');
  neg(
    verificationGap(p, 'ENG', T0)?.facet === 'national_registration' &&
      verificationGap(p, 'ENG', T0).memberAssociation === 'ENG',
    'A22 but not the ENG gap — a FIFA licence is not FA registration (facets never collapse)',
  );
  p.facets.national_registration.ENG = { state: 'VERIFIED', recheckAt: T0 + DAY };
  ok(verificationGap(p, 'ENG', T0) === null, 'A23 with FA registration VERIFIED the ENG gap closes');
  neg(
    verificationGap(p, 'ENG', T0 + 2 * DAY)?.state === 'STALE',
    'A24 and re-opens as STALE once the recheck window passes',
  );
  neg(
    verificationGap({ facets: { fifa_licence: { state: 'MANUAL_REVIEW_REQUIRED' } } }, 'INT', T0)?.state ===
      'MANUAL_REVIEW_REQUIRED',
    'A25 MANUAL_REVIEW_REQUIRED is a gap: pending human review authorises nothing',
  );
  neg(
    verificationGap({ facets: { fifa_licence: { state: 'INACTIVE' } } }, 'INT', T0)?.state === 'INACTIVE',
    'A26 INACTIVE is a gap',
  );
  neg(
    verificationGap({ facets: { fifa_licence: { state: 'PENDING' } } }, 'INT', T0)?.state === 'PENDING',
    'A27 PENDING is a gap',
  );
  ok(
    JURISDICTIONS.length === 3 &&
      JURISDICTIONS.includes('INT') &&
      JURISDICTIONS.includes('ENG') &&
      JURISDICTIONS.includes('USA'),
    'A28 three member-association codes',
  );
  ok(AGENT_POLICY_VERSION === 1, 'A29 policy version 1');
}

// ============================================================ B — matrix
section('B — the permission matrix is server-side, complete, monotone and null-prototype safe');
{
  ok(
    TIERS.length === 5 &&
      ['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance'].every((t) => TIERS.includes(t)),
    'B1 the five agency roles',
  );
  const caps = Object.keys(PERMISSIONS);
  ok(caps.length >= 16, `B2 ${caps.length} capabilities declared`);
  let cells = 0;
  let shaped = true;
  for (const cap of caps)
    for (const t of TIERS) {
      cells += 1;
      if (typeof can([t], cap) !== 'boolean') shaped = false;
    }
  ok(
    shaped && cells === caps.length * TIERS.length,
    `B3 the matrix is complete: ${cells} tier × capability cells answer a boolean`,
  );
  const regulated = [
    'clients.request',
    'clients.terminate',
    'clients.opportunities.read',
    'players.lookup',
    'clients.read.own',
    'profile.write.own',
    'verification.submit',
  ];
  for (const cap of regulated) {
    neg(
      can(['licensed_agent'], cap) &&
        !can(['agency_admin'], cap) &&
        !can(['analyst'], cap) &&
        !can(['assistant'], cap) &&
        !can(['finance'], cap),
      `B4 ${cap} is held by licensed_agent ONLY — an administrator is not an agent`,
    );
  }
  for (const cap of ['agency.team.write', 'agency.settings.write', 'agency.audit.read']) {
    neg(
      can(['agency_admin'], cap) && !can(['licensed_agent'], cap) && !can(['analyst'], cap),
      `B5 ${cap} is held by agency_admin only — a licensed agent is not an administrator`,
    );
  }
  ok(
    TIERS.every(
      (t) => can([t], 'me.read') && can([t], 'inbox.read') && can([t], 'agency.read') && can([t], 'agency.team.read'),
    ),
    'B6 every member may read themselves, their inbox, and the agency they belong to',
  );
  neg(
    !can(['licensed_agent'], 'clients.read.shared_summary') && can(['analyst'], 'clients.read.shared_summary'),
    "B7 the shared summary is the support roles' view, and even that is client-gated at the route",
  );
  neg(
    can([], 'me.read') === false && can(null, 'me.read') === false && can(undefined, 'clients.request') === false,
    'B8 no roles → nothing',
  );
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'prototype']) {
    neg(can(TIERS, key) === false && PERMISSIONS[key] === undefined, `B9 "${key}" is not a capability`);
    neg(!normaliseTiers([key]).length && !can([key], 'me.read'), `B10 "${key}" is not a role`);
  }
  neg(
    can(['licensed_agent'], 'licence.verify') === false &&
      can(TIERS, 'dispute.resolve') === false &&
      can(TIERS, 'regulatory.override') === false &&
      can(TIERS, 'minor.approve') === false,
    'B11 no capability named verify, resolve, override or approve exists for any agency role — those are attributed-review acts, not agency powers',
  );
  ok(
    capabilitiesOf(['licensed_agent', 'agency_admin']).length > capabilitiesOf(['licensed_agent']).length &&
      capabilitiesOf(['licensed_agent', 'agency_admin']).every(
        (c) => can(['licensed_agent'], c) || can(['agency_admin'], c),
      ),
    'B12 roles combine by union, never more',
  );
  ok(
    normaliseTiers(['analyst', 'analyst', 'bogus', 'finance']).join(',') === 'analyst,finance' &&
      normaliseTiers('licensed_agent').length === 0,
    'B13 tiers normalise: de-duplicated, unknown dropped, non-array rejected',
  );
}

// ============================================================ C — affiliation invariants
section('C — affiliation windows and role-change invariants');
{
  ok(
    affiliationActive({ startedAt: T0, endedAt: null }, T0) &&
      affiliationActive({ startedAt: T0, endedAt: T0 + 1 }, T0),
    'C1 active from startedAt while endedAt is null or in the future',
  );
  neg(
    !affiliationActive({ startedAt: T0 + 1, endedAt: null }, T0) &&
      !affiliationActive({ startedAt: T0, endedAt: T0 }, T0) &&
      !affiliationActive(null, T0) &&
      !affiliationActive({ endedAt: null }, T0),
    'C2 not yet started, already ended, missing or window-less → inactive (fail closed)',
  );
  ok(tiersOf({ tiers: ['finance', 'x'] }).join() === 'finance' && tiersOf(null).length === 0, 'C3 tiersOf normalises');
  const admin = { userId: 'u1', tiers: ['agency_admin'], startedAt: T0, endedAt: null };
  const staff = { userId: 'u2', tiers: ['assistant'], startedAt: T0, endedAt: null };
  neg(
    affiliationChangeProblem({
      affiliations: [admin, staff],
      target: staff,
      actorUserId: 'u2',
      nextTiers: ['agency_admin'],
      now: T0,
    }) === 'SELF_PROMOTION_BLOCKED',
    'C4 nobody grants themselves agency_admin',
  );
  ok(
    affiliationChangeProblem({
      affiliations: [admin, staff],
      target: staff,
      actorUserId: 'u1',
      nextTiers: ['agency_admin', 'assistant'],
      now: T0,
    }) === null,
    'C5 an administrator may promote a colleague',
  );
  neg(
    affiliationChangeProblem({
      affiliations: [admin, staff],
      target: admin,
      actorUserId: 'u1',
      nextTiers: ['assistant'],
      now: T0,
    }) === 'LAST_ADMIN',
    'C6 the last administrator cannot demote themselves',
  );
  neg(
    affiliationChangeProblem({
      affiliations: [admin, staff],
      target: admin,
      actorUserId: 'u1',
      nextTiers: [],
      now: T0,
      ending: true,
    }) === 'LAST_ADMIN',
    'C7 nor be removed',
  );
  const admin2 = { userId: 'u3', tiers: ['agency_admin'], startedAt: T0, endedAt: null };
  ok(
    affiliationChangeProblem({
      affiliations: [admin, staff, admin2],
      target: admin,
      actorUserId: 'u3',
      nextTiers: [],
      now: T0,
      ending: true,
    }) === null,
    'C8 with a second administrator, removal is allowed',
  );
  const endedAdmin = { userId: 'u4', tiers: ['agency_admin'], startedAt: T0 - DAY, endedAt: T0 - 1 };
  neg(
    affiliationChangeProblem({
      affiliations: [admin, endedAdmin],
      target: admin,
      actorUserId: 'u1',
      nextTiers: ['finance'],
      now: T0,
    }) === 'LAST_ADMIN',
    'C9 an ENDED administrator does not count — the window is honoured',
  );
  ok(
    affiliationChangeProblem({
      affiliations: [admin, staff],
      target: admin,
      actorUserId: 'u1',
      nextTiers: ['agency_admin', 'licensed_agent'],
      now: T0,
    }) === null,
    'C10 an administrator may add licensed_agent to their own roles — the tier is agency governance, not a licence (verification still gates every regulated act)',
  );
}

// ============================================================ D — agreement engine
section('D — agreement statuses, transitions, the access predicate and the cooldown');
{
  ok(
    AGREEMENT_STATUSES.length === 7 &&
      ['proposed', 'active', 'declined', 'expired', 'terminated_by_client', 'terminated_by_agent', 'disputed'].every(
        (s) => AGREEMENT_STATUSES.includes(s),
      ),
    'D1 the seven statuses, by their names',
  );
  neg(
    !AGREEMENT_STATUSES.includes('signed') &&
      !AGREEMENT_STATUSES.includes('approved') &&
      !AGREEMENT_STATUSES.includes('resolved'),
    'D2 no signed, approved or resolved status — nothing in the agent core is adjudicated or transacted',
  );
  ok(
    SCOPES.length === 4 && MAX_TERM_MONTHS === 24 && DEFAULT_TERM_MONTHS === 12,
    'D3 four scopes; two-year cap (FFAR 12(3) / FA 4.3); 12-month default',
  );
  ok(
    normaliseScope(undefined).join() === 'employment' &&
      normaliseScope(['transfer', 'transfer', 'x']).join() === 'transfer' &&
      normaliseScope('commercial').join() === 'commercial',
    'D4 scope normalises with employment as default',
  );
  ok(
    termMonthsOf(undefined) === 12 && termMonthsOf('') === 12 && termMonthsOf(24) === 24 && termMonthsOf('6') === 6,
    'D5 term defaults and parses',
  );
  neg(
    termMonthsOf(25) === null &&
      termMonthsOf(0) === null &&
      termMonthsOf(1.5) === null &&
      termMonthsOf('abc') === null &&
      termMonthsOf(-3) === null,
    'D6 25 months, zero, fractions, text and negatives are refused',
  );
  ok(termEndAt(T0, 12) === T0 + 12 * 30 * DAY, 'D7 end is start plus months');
  const active = { status: 'active', agentUserId: 'a1', confirmedAt: T0, endAt: T0 + DAY };
  ok(effectiveAgreementStatus(active, T0) === 'active', 'D8 active before endAt is active');
  neg(
    effectiveAgreementStatus(active, T0 + DAY) === 'expired' && active.status === 'active',
    'D9 at endAt it READS expired while the stored status is untouched — expiry is derived, never written',
  );
  ok(
    effectiveAgreementStatus({ status: 'proposed' }, T0) === 'proposed' && effectiveAgreementStatus(null) === null,
    'D10 other statuses pass through',
  );
  // THE access predicate.
  ok(
    agreementGrantsAccess(active, 'a1', T0),
    'D11 the named agent on an active confirmed unexpired agreement has access',
  );
  neg(!agreementGrantsAccess(active, 'a2', T0), 'D12 a different agent — a colleague at the same agency — does not');
  neg(!agreementGrantsAccess(active, 'a1', T0 + DAY), 'D13 the same agent after expiry does not');
  neg(
    !agreementGrantsAccess({ ...active, status: 'proposed', confirmedAt: null }, 'a1', T0),
    "D14 a proposal — the agent's claim — grants nothing",
  );
  neg(!agreementGrantsAccess({ ...active, status: 'disputed' }, 'a1', T0), 'D15 a disputed agreement suspends access');
  neg(
    !agreementGrantsAccess({ ...active, status: 'terminated_by_client' }, 'a1', T0) &&
      !agreementGrantsAccess({ ...active, status: 'terminated_by_agent' }, 'a1', T0) &&
      !agreementGrantsAccess({ ...active, status: 'declined' }, 'a1', T0),
    'D16 terminated either way, or declined, grants nothing',
  );
  neg(
    !agreementGrantsAccess({ ...active, confirmedAt: null }, 'a1', T0),
    'D17 an "active" row with no confirmation timestamp grants nothing — the confirmation is the root, not the status word',
  );
  neg(
    !agreementGrantsAccess({ ...active, agentUserId: null }, null, T0),
    'D18 a legacy agency-level row (no agent) grants nothing even to a null caller',
  );
  neg(!agreementGrantsAccess(null, 'a1', T0), 'D19 no agreement, no access');
  // Transitions.
  ok(
    CLIENT_TRANSITIONS.proposed.join() === 'active,declined,disputed' &&
      CLIENT_TRANSITIONS.active.join() === 'terminated_by_client,disputed',
    'D20 the client confirms, declines or disputes a proposal; ends or disputes an active one',
  );
  ok(
    AGENT_TRANSITIONS.proposed.join() === 'terminated_by_agent' &&
      AGENT_TRANSITIONS.active.join() === 'terminated_by_agent',
    'D21 the agent may only withdraw or end',
  );
  neg(
    AGENT_TRANSITIONS.disputed === undefined &&
      CLIENT_TRANSITIONS.disputed === undefined &&
      AGENT_TRANSITIONS.declined === undefined &&
      CLIENT_TRANSITIONS.expired === undefined,
    'D22 disputed, declined and expired are terminal for BOTH sides — resolution is attributed review',
  );
  neg(
    !agentTransitionAllowed({ status: 'proposed' }, 'active', T0),
    'D23 the agent cannot make a proposal active — only the client can',
  );
  neg(
    !clientTransitionAllowed({ status: 'proposed' }, 'terminated_by_agent', T0) &&
      !clientTransitionAllowed({ status: 'active', endAt: T0 - 1 }, 'terminated_by_client', T0),
    'D24 the client cannot act as the agent, nor end an already-expired agreement',
  );
  for (const key of ['constructor', '__proto__', 'toString']) {
    neg(
      AGENT_TRANSITIONS[key] === undefined &&
        CLIENT_TRANSITIONS[key] === undefined &&
        !clientTransitionAllowed({ status: key }, 'active', T0),
      `D25 "${key}" is not a status`,
    );
  }
  // Conflict and cooldown.
  const rows = [{ id: 'r1', agentUserId: 'a1', clientId: 'p1', status: 'proposed' }];
  neg(
    requestConflict(rows, { agentUserId: 'a1', playerId: 'p1', now: T0 })?.error === 'REPRESENTATION_ALREADY_EXISTS',
    'D26 a pending proposal blocks a second request',
  );
  ok(
    requestConflict(rows, { agentUserId: 'a2', playerId: 'p1', now: T0 }) === null,
    "D27 a different agent is not blocked by it (multiple representation is neither approved nor adjudicated here — it is simply not this agent's record)",
  );
  ok(requestConflict(rows, { agentUserId: 'a1', playerId: 'p2', now: T0 }) === null, 'D28 nor a different player');
  const declined = [{ id: 'r2', agentUserId: 'a1', clientId: 'p1', status: 'declined', declinedAt: T0 }];
  neg(
    requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + DAY })?.error ===
      'REPRESENTATION_COOLDOWN' &&
      requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + DAY }).retryAt ===
        T0 + REQUEST_COOLDOWN_MS,
    'D29 a decline starts a 30-day cooldown with a stated retryAt',
  );
  ok(
    requestConflict(declined, { agentUserId: 'a1', playerId: 'p1', now: T0 + REQUEST_COOLDOWN_MS }) === null,
    'D30 which lifts exactly when it says',
  );
  const ended = [{ id: 'r3', agentUserId: 'a1', clientId: 'p1', status: 'terminated_by_client', terminatedAt: T0 }];
  neg(
    requestConflict(ended, { agentUserId: 'a1', playerId: 'p1', now: T0 + 1 })?.error === 'REPRESENTATION_COOLDOWN',
    'D31 a client termination too',
  );
  const disputed = [{ id: 'r4', agentUserId: 'a1', clientId: 'p1', status: 'disputed' }];
  neg(
    requestConflict(disputed, { agentUserId: 'a1', playerId: 'p1', now: T0 })?.error ===
      'REPRESENTATION_ALREADY_EXISTS',
    'D32 a dispute blocks a fresh request indefinitely — no re-asking around a dispute',
  );
  // Projections.
  const a = {
    id: 'r9',
    agentUserId: 'a1',
    agencyOrgId: 'o1',
    clientKind: 'player',
    clientId: 'p1',
    status: 'disputed',
    disputeReason: 'PRIVATE_REASON_TEXT',
    scope: ['employment'],
    history: [
      {
        id: 'h1',
        at: T0,
        action: 'representation_disputed',
        by: { kind: 'player', userId: 'p1', name: 'P' },
        detail: { hadReason: true },
      },
    ],
  };
  const forAgent = agreementForAgent(a, T0);
  neg(
    !JSON.stringify(forAgent).includes('PRIVATE_REASON_TEXT'),
    "D33 the agent projection never carries the client's dispute reason",
  );
  ok(
    agreementForClient(a, T0).disputeReason === 'PRIVATE_REASON_TEXT' && agreementForClient(a, T0).pending === false,
    'D34 the client projection carries their own reason',
  );
  const summary = agreementSummaryForStaff(a, T0);
  neg(
    Object.keys(summary).sort().join() === 'agentUserId,clientId,endAt,id,startAt,status,summaryOnly' &&
      !('scope' in summary) &&
      !('history' in summary),
    'D35 the staff summary is id, status and dates only',
  );
  ok(
    /not a representation contract/.test(forAgent.honest) && /has not assessed/.test(forAgent.honest),
    'D36 the agent projection says what the record is not',
  );
  // Every record names its licensed individual and says what it is.
  ok(
    /not a representation contract/.test(agreementForAgent(a, T0).honest) &&
      /client confirmed it/.test(agreementForAgent(a, T0).honest) &&
      agreementForAgent(a, T0).legacy === undefined,
    'D37 a relationship record says it is not a representation contract, only what the client confirmed (no legacy kind remains)',
  );
  // Errors.
  ok(
    Object.getPrototypeOf(AGENT_CORE_ERROR_HTTP) === null && AGENT_CORE_ERROR_HTTP.constructor === undefined,
    'D38 the error table is null-prototype',
  );
  neg(
    AGENT_CORE_ERROR_HTTP.PLAYER_NOT_FOUND === 404 &&
      AGENT_CORE_ERROR_HTTP.REPRESENTATION_NOT_FOUND === 404 &&
      AGENT_CORE_ERROR_HTTP.AGENT_VERIFICATION_REQUIRED === 403 &&
      AGENT_CORE_ERROR_HTTP.REPRESENTATION_COOLDOWN === 429 &&
      AGENT_CORE_ERROR_HTTP.LAST_ADMIN === 409,
    'D39 codes map to the right statuses',
  );
  const pub = publicErrorBody({ error: 'PLAYER_NOT_FOUND', stack: 'x', internal: 'y', message: 'm' });
  neg(
    pub.stack === undefined &&
      pub.internal === undefined &&
      pub.error === 'PLAYER_NOT_FOUND' &&
      PUBLIC_ERROR_FIELDS.includes('message'),
    'D40 error bodies are whitelisted fields only',
  );
  ok(
    AGENT_AUDIT_ACTIONS.has('representation_requested') &&
      AGENT_AUDIT_ACTIONS.has('agency_affiliation_ended') &&
      AGENT_AUDIT_ACTIONS.has('representation_sharing_changed') &&
      !AGENT_AUDIT_ACTIONS.has('representation_resolved'),
    "D41 the audit projection lists lifecycle actions (including the client's content-free sharing toggle) and no resolution action",
  );
}

// ============================================================ registry / policy
section('T1 — events, notification categories, rate policies and stores are declared');
{
  const EVENTS = [
    'agent_profile_created',
    'agent_verification_state_changed',
    'agency_affiliation_created',
    'agency_affiliation_ended',
    'representation_requested',
    'representation_confirmed',
    'representation_rejected',
    'representation_terminated',
    'representation_disputed',
  ];
  for (const e of EVENTS) {
    const r = EVENT_REGISTRY[e];
    ok(
      !!r &&
        r.audience === 'org_private' &&
        r.privacyClass === 'org_internal' &&
        r.replayPolicy === 'never' &&
        r.notificationEligible === true &&
        r.analyticsEligible === false,
      `T1 ${e} is registered org_private / org_internal, never replayed, notification-eligible, never analytics`,
    );
    neg(
      !!r &&
        r.payload.every((k) => /Id$|^facet$|^state$/.test(k)) &&
        !r.payload.some((k) => /name|reason|reference|licence|number/i.test(k)),
      `T1 ${e} payload is ids and state words only — no name, reason, reference or licence number`,
    );
  }
  neg(
    EVENT_REGISTRY.representation_resolved === undefined &&
      EVENT_REGISTRY.agent_licence_verified_by_admin === undefined &&
      EVENT_REGISTRY.offer_made === undefined,
    'T1 no resolution, admin-verification or offer event exists',
  );
  for (const t of [
    'representation_request',
    'representation_confirmed',
    'representation_rejected',
    'representation_terminated',
    'representation_disputed',
    'representation_expiring',
  ])
    ok(TYPE_CATEGORY[t] === 'representation', `T1 notification ${t} → representation category`);
  ok(
    CATEGORIES.representation.default === true && CATEGORIES.representation.mandatory === false,
    'T1 representation is on by default and may be muted',
  );
  ok(
    TYPE_CATEGORY.agent_verification === 'security_account' &&
      TYPE_CATEGORY.agency_membership === 'security_account' &&
      CATEGORIES.security_account.mandatory,
    'T1 verification and membership notices are security/account — mandatory',
  );
  for (const [k, scope] of [
    ['agent_representation_request', 'actor'],
    ['agent_player_lookup', 'actor'],
    ['agent_profile_write', 'actor'],
    ['agent_affiliation_write', 'org'],
    ['agent_client_response', 'actor'],
  ]) {
    ok(
      RATE_LIMIT_POLICY[k] && RATE_LIMIT_POLICY[k].scope === scope && RATE_LIMIT_POLICY[k].max > 0,
      `T1 rate policy ${k} (${scope})`,
    );
  }
  for (const s of ['agentProfiles', 'agencyAffiliations', 'representationAgreements'])
    ok(TABLE_BACKED.includes(s), `T1 ${s} is a table of the agent core, not a collection`);
  ok(
    DATA_MIGRATIONS.filter((m) => m.id === AGENT_CORE_MIGRATION).length === 1 && SCHEMA_VERSION >= 26,
    `T1 exactly one migration creates the agent core tables (${AGENT_CORE_MIGRATION}), and the schema has only moved forward since (now ${SCHEMA_VERSION})`,
  );
  // The Agent app has no parallel identity database and no Offer store.
  neg(
    !['agentAuth', 'agentSessions', 'agentUsers', 'offers'].some((s) => TABLE_BACKED.includes(s)),
    "T1 no agent auth database and no offers store exists (signings is the club's store, which the Agent domain never writes)",
  );
}

done();
