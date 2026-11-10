/**
 * Who may act in the agent workspace: membership, capabilities, the agent's profile and the concealing agreement
 * lookup, shared by every agent domain.
 */
import { sendAgentError } from './core/errors.mjs';
import { tiersOf, can } from './core/shared.mjs';

export function createAgentAccess({ agentCore, unit, nextId, broadcast, now = () => Date.now() }) {
  if (typeof agentCore?.affiliations?.activeFor !== 'function' || typeof unit !== 'function') throw new TypeError('createAgentAccess needs the agent core repository and unit from the data layer');
  const { profiles, affiliations, agreements } = agentCore;

  const profileOf = (userId) => profiles.forUser(userId);

  /**
   * The caller's active membership of the agency they signed in to, set on `req.affiliation` and `req.tiers`; null
   * after answering. The first person into an agency with no members becomes its administrator.
   */
  function resolveMembership(req, res) {
    if (req.org.type !== 'agency') {
      sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'The Agent workspace is for agency organisations.' }, 'membership');
      return null;
    }
    let aff = affiliations.activeFor(req.orgUser.id, req.org.id, now());
    if (!aff) {
      if (affiliations.anyActiveIn(req.org.id, now())) {
        sendAgentError(res, { error: 'AGENCY_MEMBERSHIP_REQUIRED', message: 'You are not an active member of this agency. Ask an agency administrator to add you.' }, 'membership');
        return null;
      }
      aff = unit(() => {
        const at = now();
        const by = { kind: 'org', userId: req.orgUser.id, name: req.orgUser.name };
        const tiers = ['agency_admin'];
        const created = affiliations.create({
          id: nextId('aff'), agencyOrgId: req.org.id, userId: req.orgUser.id, tiers,
          startedAt: at, endedAt: null, endedReason: null, createdAt: at, rev: 1, revAt: at, revBy: null, keys: {},
          history: [{ id: nextId('aud'), at, action: 'agency_affiliation_created', by, detail: { tiers, bootstrap: true } }],
        });
        broadcast('agency_affiliation_created', { orgId: req.org.id, userId: req.orgUser.id });
        return created;
      });
    }
    req.affiliation = aff;
    req.tiers = tiersOf(aff);
    return aff;
  }

  const requireCap = (req, res, cap) => {
    if (can(req.tiers, cap)) return true;
    sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: `Your agency role does not include "${cap}".` }, cap);
    return false;
  };

  /**
   * The agreement `id` of the caller's agency: the agreement itself when it is the caller's own, `{ summaryOnly, a }`
   * when it is shared with agency staff, or null after a 404 (a foreign agreement is concealed, not forbidden).
   */
  function findOwnAgreement(req, res, id) {
    const a = typeof id === 'string' ? agreements.byId(id) : null;
    if (!a || a.agencyOrgId !== req.org.id) { sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'client'); return null; }
    if (a.agentUserId === req.orgUser.id && can(req.tiers, 'clients.read.own')) return a;
    if (can(req.tiers, 'clients.read.shared_summary') && a.shareWithAgencyStaff) return { summaryOnly: true, a };
    sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'client');
    return null;
  }

  return Object.freeze({ resolveMembership, requireCap, profileOf, findOwnAgreement });
}
