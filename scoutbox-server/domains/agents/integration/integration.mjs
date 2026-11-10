// The pure cross-app rules for "can this agent see or do this?": facts in, a decision with a reason code out.
// Every surface fails closed: an unknown surface, a missing fact or an unrecognised scope denies.

import {
  SCOPES, effectiveAgreementStatus, agreementGrantsAccess, normaliseScope,
  DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, normaliseDisclosure,
} from '../core/shared.mjs';
import { readInstant } from '../../../temporal.mjs';

const nullProto = (o) => Object.freeze(Object.assign(Object.create(null), o));

/**
 * A regulated surface needs a current licence and a compliance answer. `scopes: null` means knowing who represents
 * the client is enough; otherwise at least one listed scope must be on the agreement.
 */
export const SURFACES = nullProto({
  // The agent reading their own client's private record.
  client_private: { regulated: false, scopes: null, adultOnly: true },
  // The identity and football basics an agent may see without a further share.
  passport_basic: { regulated: false, scopes: null, adultOnly: true },
  // Anything beyond the basics needs an explicit, separate player share.
  passport_shared: { regulated: false, scopes: null, adultOnly: true, needsShare: true },
  // Evidence the player intentionally shared. Never raw Box Cam.
  evidence_shared: { regulated: false, scopes: null, adultOnly: true, needsShare: true },
  // Being a routable party on a canonical Contact.
  contact_participation: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Seeing that a Trial exists and its scheduling, never its assessment.
  trial_projection: { regulated: false, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Coordinating a Trial where scope allows. Never confirming for the player.
  trial_coordination: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true, needsDisclosure: true },
  // Sharing an opportunity with a represented client.
  opportunity_share: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true },
  // The transactions module owns the rest of this decision.
  transaction_initiation: { regulated: true, scopes: ['employment', 'transfer'], adultOnly: true },
  // The club-facing "represented by" badge: the player's disclosure choice, not the agent's wish to be seen.
  club_agent_presence: { regulated: false, scopes: null, adultOnly: true, needsDisclosure: true },
});

export const SURFACE_NAMES = Object.freeze(Object.keys(SURFACES));

/** A deny carries the first rule that refused; the codes name a category, never a party. */
export const RULE_ORDER = Object.freeze([
  'SURFACE_KNOWN', 'BASIS', 'SUBJECT_PRESENT', 'ADULT', 'MINOR_PATHWAY',
  'BLOCK', 'SCOPE', 'DISCLOSURE', 'SHARE', 'LICENCE', 'COMPLIANCE',
]);

export const DENY_CODES = Object.freeze([
  'SURFACE_UNKNOWN',           // fail closed on an unrecognised surface
  'NO_REPRESENTATION',         // no canonical basis at all
  'REPRESENTATION_NOT_ACTIVE', // a basis existed once; its status is not active now
  'REPRESENTATION_AMBIGUOUS',  // two active agents and nothing to choose between them
  'SUBJECT_UNAVAILABLE',       // removed, tombstoned or not resolvable
  'MINOR_PATHWAY_DISABLED',    // the client is a regulatory minor and the pathway is closed
  'BLOCKED',                   // canonical safety state
  'SCOPE_INSUFFICIENT',        // the agreement does not carry a scope this surface needs
  'DISCLOSURE_WITHHELD',       // the client has not agreed to this being visible/routed
  'SHARE_REQUIRED',            // needs an explicit share that does not exist
  'LICENCE_NOT_CURRENT',       // a regulated action with a stale or unverified facet
  'COMPLIANCE_NOT_CLEAR',      // the compliance layer has not permitted this
]);

const deny = (code, rule) => Object.freeze({ allowed: false, code, rule, basis: null });
const allow = (basis, surface) => Object.freeze({ allowed: true, code: null, rule: null, basis, surface });

/**
 * Which agreement, if any, makes this agent this player's representative now. When none is active, `status` names
 * the most informative non-active state, for the agent only (never a third party).
 */
export function agentClientBasis({ agreements = [], agentUserId = null, clientId = null, now = Date.now() } = {}) {
  const none = (status = null) => ({ ok: false, agentUserId: null, agreementId: null, scope: [], agencyOrgId: null, status });
  if (typeof agentUserId !== 'string' || !agentUserId || typeof clientId !== 'string' || !clientId) return none();
  let fallback = null;
  for (const a of agreements) {
    if (!a || a.clientId !== clientId) continue;
    if (a.agentUserId !== agentUserId) continue;
    if (agreementGrantsAccess(a, agentUserId, now)) {
      return {
        ok: true,
        agentUserId: a.agentUserId,
        agreementId: a.id,
        scope: normaliseScope(a.scope),
        agencyOrgId: a.agencyOrgId ?? null,
        status: 'active',
        isRegulatoryMinor: a.isRegulatoryMinor === true,
      };
    }
    // A dispute outranks an expiry, which outranks anything else.
    const st = effectiveAgreementStatus(a, now);
    const rank = st === 'disputed' ? 3 : st === 'expired' ? 2 : 1;
    if (!fallback || rank > fallback.rank) fallback = { rank, status: st };
  }
  return none(fallback?.status ?? null);
}

/** Every fact is resolved by the caller from canonical sources, never from a request body. */
export function agentSurfaceDecision({
  surface,
  basis = null,
  subjectPresent = false,
  isAdult = false,
  minorPathwayOpen = false,
  blocked = false,
  disclosure = null,
  shared = false,
  licenceCurrent = false,
  complianceClear = null,
} = {}) {
  const spec = typeof surface === 'string' && Object.hasOwn(SURFACES, surface) ? SURFACES[surface] : null;
  if (!spec) return deny('SURFACE_UNKNOWN', 'SURFACE_KNOWN');

  if (!basis || basis.ok !== true) {
    return deny(basis?.status ? 'REPRESENTATION_NOT_ACTIVE' : 'NO_REPRESENTATION', 'BASIS');
  }
  if (subjectPresent !== true) return deny('SUBJECT_UNAVAILABLE', 'SUBJECT_PRESENT');

  if (spec.adultOnly && isAdult !== true) {
    if (!minorPathwayOpen) return deny('MINOR_PATHWAY_DISABLED', 'MINOR_PATHWAY');
  }
  if (basis.isRegulatoryMinor === true && !minorPathwayOpen) {
    return deny('MINOR_PATHWAY_DISABLED', 'MINOR_PATHWAY');
  }

  // Before scope and compliance, so a compliance answer never overrides a block.
  if (blocked === true) return deny('BLOCKED', 'BLOCK');

  if (Array.isArray(spec.scopes)) {
    const have = Array.isArray(basis.scope) ? basis.scope : [];
    if (!spec.scopes.some((s) => have.includes(s))) return deny('SCOPE_INSUFFICIENT', 'SCOPE');
  }

  // No recorded answer is not consent.
  if (spec.needsDisclosure && disclosure !== true) return deny('DISCLOSURE_WITHHELD', 'DISCLOSURE');
  if (spec.needsShare && shared !== true) return deny('SHARE_REQUIRED', 'SHARE');

  if (spec.regulated) {
    if (licenceCurrent !== true) return deny('LICENCE_NOT_CURRENT', 'LICENCE');
    // `null` means "not evaluated", which is not clear.
    if (complianceClear === false || complianceClear === null) {
      if (complianceClear === null && spec.complianceOptional === true) return allow(basis, surface);
      return deny('COMPLIANCE_NOT_CLEAR', 'COMPLIANCE');
    }
  }
  return allow(basis, surface);
}

export { DISCLOSURE_KEYS, DISCLOSURE_DEFAULT, normaliseDisclosure };

export const SURFACE_DISCLOSURE = nullProto({
  contact_participation: 'contactRouting',
  trial_projection: 'trialVisibility',
  trial_coordination: 'trialVisibility',
  club_agent_presence: 'clubPresence',
});

/** In the compliance policy engine's vocabulary (`POLICY_ACTIONS`). */
export const POLICY_ACTION_FOR_SURFACE = nullProto({
  contact_participation: 'approach_adult',
  trial_coordination: 'approach_adult',
  opportunity_share: 'approach_adult',
  transaction_initiation: 'declare_representation',
});

/**
 * There is no `agent_only`: the player is always a target and an agent is only added beside them, or the player
 * would never learn a club had approached them.
 */
export const CONTACT_ROUTING_MODES = Object.freeze(['player_only', 'both']);

export function contactRouting({ recipient = null, agentDecision = null, requestedMode = 'player_only' } = {}) {
  if (!recipient) return { ok: false, error: 'CONTACT_RECIPIENT_UNAVAILABLE' };
  const mode = CONTACT_ROUTING_MODES.includes(requestedMode) ? requestedMode : 'player_only';
  const agentOk = agentDecision?.allowed === true;
  // A minor's route is the guardian's; an agent is never substituted for one.
  if (recipient.minor === true) {
    return { ok: true, mode: 'player_only', targets: [recipient], agent: null, agentRefusal: 'MINOR_PATHWAY_DISABLED' };
  }
  if (mode === 'player_only' || !agentOk) {
    return {
      ok: true,
      // A refused agent falls back to the player rather than failing the contact; the caller is told why.
      mode: 'player_only',
      targets: [recipient],
      agent: null,
      agentRefusal: agentOk ? null : (agentDecision?.code ?? 'NO_REPRESENTATION'),
    };
  }
  // Never record a routed agent that is nobody.
  const agentUserId = agentDecision.basis?.agentUserId ?? null;
  if (typeof agentUserId !== 'string' || !agentUserId) {
    return { ok: true, mode: 'player_only', targets: [recipient], agent: null, agentRefusal: 'NO_REPRESENTATION' };
  }
  const agentTarget = { type: 'agent', agentUserId, agreementId: agentDecision.basis.agreementId, minor: false };
  return { ok: true, mode: 'both', targets: [recipient, agentTarget], agent: agentTarget, agentRefusal: null };
}

/** Who was validly routed at that moment; a later relationship change does not rewrite it. */
export function contactTargetSnapshot(routing, at = Date.now()) {
  if (!routing?.ok) return null;
  return Object.freeze({
    at,
    mode: routing.mode,
    player: routing.targets.some((t) => t.type === 'player' || t.type === 'guardian'),
    guardian: routing.targets.some((t) => t.type === 'guardian'),
    agent: routing.agent ? { agentUserId: routing.agent.agentUserId, agreementId: routing.agent.agreementId } : null,
    honest: 'Who was validly routed when this contact was recorded. A later change to the relationship does not rewrite it, and the next contact is routed from the authority in force then.',
  });
}

const stateWord = (v) => (typeof v === 'string' && v ? v : 'unknown');

export function clubAgentPresence({ decision = null, agent = null, agency = null, facets = null } = {}) {
  if (decision?.allowed !== true) return null;
  return Object.freeze({
    represented: true,
    agent: { displayName: agent?.displayName ?? null },
    agency: { id: agency?.id ?? null, name: agency?.name ?? null },
    // "Verified" means verified in ScoutBox. A non-string reads 'unknown': a per-association map would tell the
    // club which jurisdictions the agent works in, which nobody asked the player to disclose.
    verification: Object.freeze({
      fifaLicence: stateWord(facets?.fifa_licence),
      nationalRegistration: stateWord(facets?.national_registration),
      domesticAuthorisation: stateWord(facets?.domestic_authorisation),
    }),
    contactPathway: 'contact_agent',
    honest: 'Licence status as verified in ScoutBox, with the date of that check. ScoutBox is not a licence register and does not speak for any governing body. No agreement terms and no fee are shown here, to anyone.',
  });
}

// ------------------------------------------------------ transaction handoff

/**
 * A handoff is an invitation, not a transaction: an internal decision must not become an external commitment by
 * itself, and only a licensed agent opens a transaction. So the club invites and the agent opens.
 */
export const HANDOFF_STATUSES = Object.freeze(['invited', 'accepted', 'withdrawn', 'expired']);

export const HANDOFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function effectiveHandoffStatus(h, now = Date.now()) {
  if (!h || !HANDOFF_STATUSES.includes(h.status)) return null;
  if (h.status === 'invited') {
    // An unreadable invitation date reads expired, never "standing for ever".
    const at = readInstant(h.invitedAt);
    if (at === null || now - at >= HANDOFF_TTL_MS) return 'expired';
  }
  return h.status;
}

export const HANDOFF_BLOCKERS = Object.freeze([
  'HANDOFF_NOT_PERMITTED',          // the actor's club role does not include this
  'HANDOFF_DECISION_REQUIRED',      // no finalised formal decision to progress exists
  'HANDOFF_CASE_STATE',             // the case is not at a lifecycle point that permits it
  'HANDOFF_SUBJECT_UNAVAILABLE',    // the player is removed, or not visible to this club
  'HANDOFF_MINOR_PATHWAY_DISABLED', // the player is under the age of majority
  'HANDOFF_BLOCKED',                // a canonical block between the player and the club
  'HANDOFF_EXISTS',                 // one is already standing
  'HANDOFF_TRANSACTION_EXISTS',     // a live transaction already covers this context
  'HANDOFF_COMPLIANCE_UNAVAILABLE', // the compliance layer cannot answer right now
]);

/**
 * Every blocker at once, so a club sees the whole picture. The decision's rationale is not an argument, so it cannot
 * leak into a refusal.
 */
export function handoffBlockers({
  canWrite = false,
  hasFinalProgressDecision = false,
  caseStatus = null,
  eligibleCaseStatuses = ['offer_consideration'],
  subjectPresent = false,
  isAdult = false,
  minorPathwayOpen = false,
  blocked = false,
  existingHandoffStatus = null,
  liveTransactionId = null,
  complianceEvaluable = false,
} = {}) {
  const out = [];
  if (canWrite !== true) out.push('HANDOFF_NOT_PERMITTED');
  if (hasFinalProgressDecision !== true) out.push('HANDOFF_DECISION_REQUIRED');
  if (!eligibleCaseStatuses.includes(caseStatus)) out.push('HANDOFF_CASE_STATE');
  if (subjectPresent !== true) out.push('HANDOFF_SUBJECT_UNAVAILABLE');
  if (isAdult !== true && !minorPathwayOpen) out.push('HANDOFF_MINOR_PATHWAY_DISABLED');
  if (blocked === true) out.push('HANDOFF_BLOCKED');
  if (existingHandoffStatus === 'invited' || existingHandoffStatus === 'accepted') out.push('HANDOFF_EXISTS');
  if (typeof liveTransactionId === 'string' && liveTransactionId) out.push('HANDOFF_TRANSACTION_EXISTS');
  if (complianceEvaluable !== true) out.push('HANDOFF_COMPLIANCE_UNAVAILABLE');
  return out;
}

/**
 * A duplicate only when individual, type and both clubs match and the earlier one is live: a loan beside a transfer,
 * or two clubs competing for one player, are separate transactions.
 */
export function duplicateTransactionOf(transactions, { clientId, type, engagingOrgId = null, releasingOrgId = null, terminalStatuses = [], partiesOf }) {
  const want = (t) => {
    const parties = partiesOf(t) ?? [];
    const find = (role) => parties.find((p) => p && p.partyRole === role && !p.removed) ?? null;
    return {
      individual: find('individual')?.subjectId ?? null,
      engaging: find('engaging_entity')?.subjectId ?? null,
      releasing: find('releasing_entity')?.subjectId ?? null,
    };
  };
  for (const t of transactions) {
    if (!t || t.type !== type) continue;
    if (terminalStatuses.includes(t.status)) continue;
    const got = want(t);
    if (got.individual !== clientId) continue;
    if ((got.engaging ?? null) !== (engagingOrgId ?? null)) continue;
    if ((got.releasing ?? null) !== (releasingOrgId ?? null)) continue;
    return t;
  }
  return null;
}

export const surfaceIsRegulated = (surface) => (Object.hasOwn(SURFACES, surface) ? SURFACES[surface].regulated === true : false);

export const surfaceScopes = (surface) => (Object.hasOwn(SURFACES, surface) ? (SURFACES[surface].scopes ?? null) : null);

export { SCOPES };
