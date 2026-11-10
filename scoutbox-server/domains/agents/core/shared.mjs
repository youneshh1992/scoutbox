/**
 * The agent core's pure layer: verification facets, affiliations, permissions and agreements.
 *
 * The licence belongs to the person (an org user with an agent profile), never the agency, and membership alone
 * authorises no regulated action. A self-entered licence number is never a verified licence.
 */

import { isExpiredAt, readInstant } from '../../../temporal.mjs';

export const AGENT_POLICY_VERSION = 1;

// -------------------------------------------------------------- verification

export const VERIFICATION_STATES = Object.freeze([
  'UNVERIFIED', // nothing declared, or declared and nothing submitted
  'PENDING', // submitted; a provider or attributed review has not answered
  'VERIFIED', // a provider with recorded provenance answered "current"
  'STALE', // was VERIFIED; recheckAt has passed without a re-check
  'INACTIVE', // provider or holder says suspended / withdrawn / expired
  'MANUAL_REVIEW_REQUIRED', // no authoritative source; attributed human review needed (G-C0)
]);

/**
 * Separate facts with separate clocks: a FIFA licence, a national registration and a domestic activity
 * authorisation (e.g. the U.S. Soccer background check and SafeSport).
 */
export const FACETS = Object.freeze([
  'fifa_licence',
  'national_registration',
  'domestic_authorisation',
  'minors_authorisation',
]);

/** How long a VERIFIED facet stays current before it must be re-checked. */
export const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Member associations a facet may be scoped to. `INT` = FIFA level. */
export const JURISDICTIONS = Object.freeze(['INT', 'ENG', 'USA']);

const emptyFacet = () => ({
  state: 'UNVERIFIED',
  reference: null,
  memberAssociation: null,
  provenance: null,
  submittedAt: null,
  verifiedAt: null,
  recheckAt: null,
  note: null,
});

export const newFacets = () => ({
  fifa_licence: emptyFacet(),
  national_registration: {}, // keyed by member association, e.g. ENG
  domestic_authorisation: {}, // keyed by member association, e.g. USA background check + SafeSport
  minors_authorisation: {}, // keyed by member association
});

/**
 * VERIFIED decays to STALE past `recheckAt`. An unreadable recheck clock reads STALE; an absent one means no shelf
 * life, as with agreement terms below.
 */
export function effectiveFacetState(facet, now = Date.now()) {
  if (!facet || !facet.state) return 'UNVERIFIED';
  if (facet.state === 'VERIFIED' && !boundaryAbsent(facet.recheckAt) && isExpiredAt(facet.recheckAt, now))
    return 'STALE';
  return VERIFICATION_STATES.includes(facet.state) ? facet.state : 'MANUAL_REVIEW_REQUIRED';
}

/**
 * Production has no provider: a submission goes PENDING then MANUAL_REVIEW_REQUIRED. The synthetic test provider is
 * switched on by an environment flag and named in its provenance.
 */
export function evaluateSubmission({ facet, reference, testProviderEnabled = false, now = Date.now() }) {
  const ref = String(reference ?? '').trim();
  if (testProviderEnabled) {
    if (/^TEST-VERIFIED-/i.test(ref)) {
      return {
        state: 'VERIFIED',
        verifiedAt: now,
        recheckAt: now + RECHECK_MS,
        provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: now },
        note: 'Verified by the LOCAL SYNTHETIC test provider. This is not a FIFA, FA or U.S. Soccer register check and never exists in production.',
      };
    }
    if (/^TEST-INACTIVE-/i.test(ref)) {
      return {
        state: 'INACTIVE',
        verifiedAt: null,
        recheckAt: null,
        provenance: { provider: 'local-synthetic-test-provider', kind: 'synthetic', at: now },
        note: 'Reported inactive by the LOCAL SYNTHETIC test provider.',
      };
    }
  }
  return {
    state: 'MANUAL_REVIEW_REQUIRED',
    verifiedAt: null,
    recheckAt: null,
    provenance: { provider: 'none', kind: 'none', at: now },
    note: `No ${facet === 'fifa_licence' ? 'FIFA' : 'national'} register integration exists in this build. A submitted reference is a declaration, not a verification; it is queued for attributed Trust & Safety review (G-C0), and nothing is verified until a named reviewer decides.`,
  };
}

/** The facets a regulated action in a jurisdiction requires. */
export function requiredFacetsFor(jurisdiction) {
  const req = [{ facet: 'fifa_licence', ma: null }];
  if (jurisdiction === 'ENG') req.push({ facet: 'national_registration', ma: 'ENG' });
  return req;
}

/** The first required facet not VERIFIED now, or null. */
export function verificationGap(profile, jurisdiction, now = Date.now()) {
  if (!profile) return { error: 'AGENT_PROFILE_REQUIRED', facet: null, state: null };
  for (const { facet, ma } of requiredFacetsFor(jurisdiction)) {
    const f = ma ? profile.facets?.[facet]?.[ma] : profile.facets?.[facet];
    const state = effectiveFacetState(f, now);
    if (state !== 'VERIFIED') return { error: 'AGENT_VERIFICATION_REQUIRED', facet, memberAssociation: ma, state };
  }
  return null;
}

// -------------------------------------------------------------- affiliation

/** Agency staff roles. One affiliation may hold several. */
export const TIERS = Object.freeze(['licensed_agent', 'agency_admin', 'analyst', 'assistant', 'finance']);

export const normaliseTiers = (raw) => {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const t of arr) if (TIERS.includes(t) && !out.includes(t)) out.push(t);
  return out;
};

/** As with an agreement term, a start or end that is not a finite instant fails closed. */
export const affiliationActive = (a, now = Date.now()) =>
  !!a &&
  readInstant(a.startedAt) !== null &&
  a.startedAt <= now &&
  (boundaryAbsent(a.endedAt) || (readInstant(a.endedAt) !== null && a.endedAt > now));

export const tiersOf = (a) => (a ? normaliseTiers(a.tiers) : []);

/**
 * Capability → the roles that hold it; a capability absent here is held by nobody. Agency staff see only a summary
 * row of a client who chose to share with them, never the client's data.
 */
export const PERMISSIONS = Object.freeze(
  Object.assign(Object.create(null), {
    'me.read': TIERS,
    'profile.write.own': ['licensed_agent'],
    'verification.submit': ['licensed_agent'],
    'clients.read.own': ['licensed_agent'],
    'clients.read.shared_summary': ['agency_admin', 'analyst', 'assistant', 'finance'],
    'clients.request': ['licensed_agent'],
    'clients.terminate': ['licensed_agent'],
    'clients.opportunities.read': ['licensed_agent'],
    // A regulated act of the licensed individual, not agency admin work.
    'clients.opportunities.share': ['licensed_agent'],
    'players.lookup': ['licensed_agent'],
    'inbox.read': TIERS,
    'agency.read': TIERS,
    'agency.team.read': TIERS,
    'agency.team.write': ['agency_admin'],
    'agency.settings.write': ['agency_admin'],
    'agency.audit.read': ['agency_admin'],
    'agency.compliance.read': ['agency_admin', 'licensed_agent'],
    // Writing compliance contexts and transactions is a regulated act of the licensed individual only.
    'compliance.read': TIERS,
    'compliance.contexts.write': ['licensed_agent'],
    'transactions.read': TIERS,
    'transactions.write': ['licensed_agent'],
  }),
);

export function can(tiers, capability) {
  // Own keys of a null-prototype table: "constructor" is not a capability.
  if (typeof capability !== 'string' || !Object.hasOwn(PERMISSIONS, capability)) return false;
  const allowed = PERMISSIONS[capability];
  return Array.isArray(tiers) && tiers.some((t) => allowed.includes(t));
}

/** For the client's convenience only; `can()` is enforced on every route. */
export const capabilitiesOf = (tiers) => Object.keys(PERMISSIONS).filter((c) => can(tiers, c));

/** Nobody grants themselves agency_admin, and the last admin cannot be demoted or removed. */
export function affiliationChangeProblem({
  affiliations,
  target,
  actorUserId,
  nextTiers,
  now = Date.now(),
  ending = false,
}) {
  const admins = affiliations.filter((a) => affiliationActive(a, now) && tiersOf(a).includes('agency_admin'));
  const targetIsAdmin = tiersOf(target).includes('agency_admin');
  const willBeAdmin = !ending && nextTiers.includes('agency_admin');
  if (target.userId === actorUserId && willBeAdmin && !targetIsAdmin) return 'SELF_PROMOTION_BLOCKED';
  if (targetIsAdmin && !willBeAdmin && admins.length <= 1) return 'LAST_ADMIN';
  return null;
}

// -------------------------------------------------------------- agreements

/** `expired` is derived, never written by a user. */
export const AGREEMENT_STATUSES = Object.freeze([
  'proposed',
  'active',
  'declined',
  'expired',
  'terminated_by_client',
  'terminated_by_agent',
  'disputed',
]);
export const SCOPES = Object.freeze(['employment', 'transfer', 'commercial', 'other_services']);
/** FFAR 12(3) / FA 4.3: a player agreement may not exceed two years. */
export const MAX_TERM_MONTHS = 24;
export const DEFAULT_TERM_MONTHS = 12;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
/** Anti-spam: after a decline or a termination, the same agent may not re-request the same player within this window. */
export const REQUEST_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
/** Home alerts a relationship that ends within this window. */
export const EXPIRY_ALERT_MS = 30 * 24 * 60 * 60 * 1000;

export const normaliseScope = (raw) => {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out = [];
  for (const s of arr) if (SCOPES.includes(s) && !out.includes(s)) out.push(s);
  return out.length ? out : ['employment'];
};

export function termMonthsOf(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TERM_MONTHS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TERM_MONTHS) return null;
  return n;
}

export const termEndAt = (startAt, months) => startAt + months * MONTH_MS;

/**
 * An absent boundary is open and constrains nothing (proposals are written with `startAt: null, endAt: null`, and an
 * open-ended mandate is legal for an entity under FFAR 12(5)). A present boundary must be a finite instant: an ISO
 * string, NaN or Infinity cannot be evaluated and refuses, since `NaN <= now` is false.
 */
const boundaryAbsent = (v) => v === null || v === undefined;
const readBoundary = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function endBoundaryPassed(endAt, now) {
  if (boundaryAbsent(endAt)) return false; // open-ended never expires
  const n = readBoundary(endAt);
  if (n === null) return true; // present but unreadable → fail closed
  return n <= now; // `endAt === now` is over
}

function startBoundaryReached(startAt, now) {
  if (boundaryAbsent(startAt)) return true; // open start
  const n = readBoundary(startAt);
  if (n === null) return false; // present but unreadable → fail closed
  return n <= now; // `startAt === now` counts as started
}

/**
 * A mandate that has not started still reads `active` (there is no "not yet in force" status, which would change the
 * API contract) but grants no access: access and status are different questions.
 */
export function agreementTermCoversNow(a, now = Date.now()) {
  if (!a) return false;
  return startBoundaryReached(a.startAt, now) && !endBoundaryPassed(a.endAt, now);
}

/** An active agreement past its end reads as expired. */
export function effectiveAgreementStatus(a, now = Date.now()) {
  if (!a) return null;
  if (a.status === 'active' && endBoundaryPassed(a.endAt, now)) return 'expired';
  return a.status;
}

/** Private client access, for the agent named on an agreement in force. The caller applies block and visibility gates. */
export function agreementGrantsAccess(a, agentUserId, now = Date.now()) {
  return agreementInForce(a, now) && a.agentUserId === agentUserId;
}

/**
 * Names an agent, client-confirmed, active and within its term. Also behind every "is this player represented" read
 * (Trust, the Passport headline), so none counts a mandate that has not started.
 */
export function agreementInForce(a, now = Date.now()) {
  if (!a || typeof a.agentUserId !== 'string' || !a.agentUserId || a.confirmedAt == null) return false;
  // effectiveAgreementStatus covers the end boundary; the start is checked here.
  if (effectiveAgreementStatus(a, now) !== 'active') return false;
  return startBoundaryReached(a.startAt, now);
}

/**
 * Each defaults to false: confirming a representation is not consenting to the agent being routed a club's message,
 * shown on a club's screen or given the trial schedule. There is no "instead of me" routing key, because a contact
 * is delivered by the player's Inbox row; a club may add the agent beside the player, never replace them.
 */
export const DISCLOSURE_KEYS = Object.freeze(['clubPresence', 'contactRouting', 'trialVisibility']);
export const DISCLOSURE_DEFAULT = Object.freeze({ clubPresence: false, contactRouting: false, trialVisibility: false });

/**
 * Shares belong to the relationship they were made under. At the cap a share is refused by name rather than dropping
 * the oldest, so the audit trail never silently forgets.
 */
export const MAX_OPPORTUNITY_SHARES = 200;

export const shareView = (s) => ({
  id: s.id,
  opportunityId: s.opportunityId,
  via: s.via ?? null,
  title: s.title ?? null,
  orgName: s.orgName ?? null,
  deadline: s.deadline ?? null,
  note: s.note ?? null,
  sharedAt: s.sharedAt,
  sharedByName: s.sharedBy?.name ?? null,
  withdrawnAt: s.withdrawnAt ?? null,
  rev: s.rev ?? 1,
  honest: 'Your agent brought this to your attention. Applying is your own action — nobody can apply for you.',
});

export function normaliseDisclosure(raw) {
  const out = { ...DISCLOSURE_DEFAULT };
  if (!raw || typeof raw !== 'object') return Object.freeze(out);
  // Only an explicit `true` is a yes.
  for (const k of DISCLOSURE_KEYS) if (raw[k] === true) out[k] = true;
  return Object.freeze(out);
}

export function requestConflict(agreements, { agentUserId, playerId, now = Date.now() }) {
  for (const a of agreements) {
    if (!a || a.agentUserId !== agentUserId || a.clientId !== playerId) continue;
    const st = effectiveAgreementStatus(a, now);
    if (st === 'proposed' || st === 'active' || st === 'disputed')
      return { error: 'REPRESENTATION_ALREADY_EXISTS', agreementId: a.id, status: st };
  }
  let latestEnd = null;
  for (const a of agreements) {
    if (!a || a.agentUserId !== agentUserId || a.clientId !== playerId) continue;
    const st = effectiveAgreementStatus(a, now);
    const endedAt =
      st === 'declined'
        ? a.declinedAt
        : st === 'terminated_by_client' || st === 'terminated_by_agent'
          ? a.terminatedAt
          : st === 'expired'
            ? a.endAt
            : null;
    if (typeof endedAt === 'number' && now - endedAt < REQUEST_COOLDOWN_MS)
      latestEnd = Math.max(latestEnd ?? 0, endedAt);
  }
  if (latestEnd !== null) return { error: 'REPRESENTATION_COOLDOWN', retryAt: latestEnd + REQUEST_COOLDOWN_MS };
  return null;
}

/** Which transitions each side may make. */
const nullProto = (o) => Object.freeze(Object.assign(Object.create(null), o));
export const AGENT_TRANSITIONS = nullProto({
  proposed: ['terminated_by_agent'], // cancel a pending request
  active: ['terminated_by_agent'],
});
export const CLIENT_TRANSITIONS = nullProto({
  proposed: ['active', 'declined', 'disputed'],
  active: ['terminated_by_client', 'disputed'],
});

const transitionAllowed = (table, a, to, now) => {
  const st = effectiveAgreementStatus(a, now);
  if (typeof st !== 'string' || !Object.hasOwn(table, st)) return false; // unknown or corrupt status: nothing moves
  return table[st].includes(to);
};
export const clientTransitionAllowed = (a, to, now = Date.now()) => transitionAllowed(CLIENT_TRANSITIONS, a, to, now);
export const agentTransitionAllowed = (a, to, now = Date.now()) => transitionAllowed(AGENT_TRANSITIONS, a, to, now);

// -------------------------------------------------------------- projections

export const historyEntry = (id, at, action, by, detail = null) => ({ id, at, action, by, detail });

/** No client PII beyond the id; the caller adds the live client identity it may show. */
export function agreementForAgent(a, now = Date.now()) {
  if (!a) return null;
  return {
    id: a.id,
    agentUserId: a.agentUserId,
    agencyOrgId: a.agencyOrgId,
    clientKind: a.clientKind,
    clientId: a.clientId,
    status: effectiveAgreementStatus(a, now),
    storedStatus: a.status,
    scope: a.scope,
    exclusive: !!a.exclusive,
    jurisdiction: a.jurisdiction ?? null,
    termMonths: a.termMonths ?? null,
    startAt: a.startAt ?? null,
    endAt: a.endAt ?? null,
    proposedAt: a.proposedAt ?? null,
    confirmedAt: a.confirmedAt ?? null,
    declinedAt: a.declinedAt ?? null,
    terminatedAt: a.terminatedAt ?? null,
    terminatedBy: a.terminatedBy ?? null,
    terminationReasonCode: a.terminationReasonCode ?? null,
    disputedAt: a.disputedAt ?? null,
    shareWithAgencyStaff: !!a.shareWithAgencyStaff,
    // The agent's own permissions: an agent not routed a club's message should know why nothing arrives.
    disclosure: normaliseDisclosure(a.disclosure),
    subjectRemovedAt: a.subjectRemovedAt ?? null,
    policyVersion: AGENT_POLICY_VERSION,
    rev: a.rev ?? 1,
    revAt: a.revAt ?? null,
    history: (a.history ?? []).map((h) => ({
      id: h.id,
      at: h.at,
      action: h.action,
      byKind: h.by?.kind ?? null,
      byName: h.by?.name ?? null,
      detail: h.detail ?? null,
    })),
    honest:
      'A ScoutBox relationship record. It is not a representation contract and ScoutBox has not assessed its legal validity; the client confirmed it in ScoutBox.',
  };
}

export function agreementForClient(a, now = Date.now()) {
  const base = agreementForAgent(a, now);
  if (!base) return null;
  return {
    ...base,
    pending: base.status === 'proposed',
    disputeReason: a.disputeReason ?? null,
  };
}

/** The summary a same-agency colleague may see when the client allows it. */
export const agreementSummaryForStaff = (a, now = Date.now()) => ({
  id: a.id,
  agentUserId: a.agentUserId,
  clientId: a.clientId,
  status: effectiveAgreementStatus(a, now),
  startAt: a.startAt ?? null,
  endAt: a.endAt ?? null,
  summaryOnly: true,
});
