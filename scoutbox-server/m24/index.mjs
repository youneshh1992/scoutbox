/**
 * M23 P5.6B — ScoutBox Agent core: routes.
 *
 * Mounted on the canonical routers (`/org/agent/*`, `/player/agent/*`,
 * `/admin/agent/*`) so the existing session, org and player gates apply
 * before anything here runs. Every mutation re-derives authority at mutation
 * time from the live records and the clock, in the P5.6A order:
 *
 *   authenticate → resolve user → resolve agency membership → conceal foreign
 *   resource → role → relationship / access basis → block / safeguarding →
 *   objective verification (regulated only) → rev / idempotency → mutate →
 *   history → event → notification.
 *
 * What is deliberately NOT here (P5.6C/D): conflict adjudication, multiple-
 * representation approval, regulatory override, dispute resolution, minor
 * compliance approval, transactions, negotiation, fee enforcement, Offer.
 * There is also NO route through which the shared Trust & Safety key can
 * verify or reject a licence, resolve a dispute or override a state (G-C0).
 */

import { visibleToOrg } from '../domain.mjs';
import { buildShared } from '../m12/shared.mjs';
import { opportunityBoardFor } from '../m12/journeys.mjs';
import { guardRev, bumpRev, revMeta } from '../m181/concurrency.mjs';
import { rateLimitedBody } from '../m181/rateLimit.mjs';
import { normaliseClientKey, payloadFingerprint } from '../m23/contact.mjs';
import { sendAgentError } from './errors.mjs';
import { agentAuditRows } from './audit.mjs';
import {
  AGENT_POLICY_VERSION, VERIFICATION_STATES, FACETS, JURISDICTIONS, TIERS, SCOPES, MAX_TERM_MONTHS, EXPIRY_ALERT_MS,
  newFacets, effectiveFacetState, evaluateSubmission, requiredFacetsFor, verificationGap,
  normaliseTiers, affiliationActive, tiersOf, PERMISSIONS, can, capabilitiesOf, affiliationChangeProblem,
  normaliseScope, termMonthsOf, termEndAt, effectiveAgreementStatus, agreementGrantsAccess, requestConflict,
  clientTransitionAllowed, agentTransitionAllowed, agreementForAgent, agreementForClient, agreementSummaryForStaff,
} from './shared.mjs';

export function registerAgent(rawCtx) {
  const ctx = { ...rawCtx, ...buildShared(rawCtx) };
  const {
    db, orgRouter, playerRouter, adminRouter, nextId, persistNow, notify, broadcast,
    findPlayer, isBlocked, playerViewForOrg, orgSafe, revokeOrgUserAccess, rateLimit, isAdult,
    orgCanSee, checkEligibility, distanceBand, moderateOrRefuse,
  } = ctx;

  const testProviderEnabled = process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1';
  const now = () => Date.now();
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push({ id: nextId('aud'), at: now(), action, by, detail });
  };
  const byOrg = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });

  // ------------------------------------------------------------ lookups
  const activeAffiliationOf = (userId, orgId) =>
    (db.agencyAffiliations ?? []).find((a) => a && a.userId === userId && a.agencyOrgId === orgId && affiliationActive(a, now())) ?? null;
  const profileOf = (userId) => (db.agentProfiles ?? []).find((p) => p && p.userId === userId) ?? null;
  const agreementsOfAgency = (orgId) => (db.representationAgreements ?? []).filter((a) => a && a.agencyOrgId === orgId);

  /** Step 3: agency membership. Bootstraps the first member of an agency as its admin. */
  function resolveMembership(req, res) {
    if (req.org.type !== 'agency') {
      sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'The Agent workspace is for agency organisations.' }, 'membership');
      return null;
    }
    let aff = activeAffiliationOf(req.orgUser.id, req.org.id);
    if (!aff) {
      const anyActive = (db.agencyAffiliations ?? []).some((a) => a && a.agencyOrgId === req.org.id && affiliationActive(a, now()));
      if (anyActive) {
        sendAgentError(res, { error: 'AGENCY_MEMBERSHIP_REQUIRED', message: 'You are not an active member of this agency. Ask an agency administrator to add you.' }, 'membership');
        return null;
      }
      // First person into an agency with no members: the same bootstrap rule
      // M14 uses for the first verification root admin.
      aff = {
        id: nextId('aff'), agencyOrgId: req.org.id, userId: req.orgUser.id, tiers: ['agency_admin'],
        startedAt: now(), endedAt: null, endedReason: null, createdAt: now(), rev: 1, revAt: now(), revBy: null, keys: {}, history: [],
      };
      hist(aff, 'agency_affiliation_created', byOrg(req), { tiers: aff.tiers, bootstrap: true });
      db.agencyAffiliations.push(aff);
      persistNow();
      broadcast('agency_affiliation_created', { orgId: req.org.id, userId: req.orgUser.id });
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

  const limitedOr429 = (res, action, key) => {
    if (rateLimit.limited(action, key)) { res.status(429).json(rateLimitedBody(action)); return true; }
    return false;
  };

  const clientKeyOr400 = (req, res) => {
    const k = normaliseClientKey(req.body?.clientKey);
    if (!k.ok) { sendAgentError(res, { error: 'AGENT_CLIENT_KEY_INVALID', message: k.message }, 'clientKey'); return undefined; }
    return k.key;
  };

  // ------------------------------------------------------------ projections
  const facetView = (facet) => {
    if (!facet) return null;
    return {
      state: effectiveFacetState(facet, now()), storedState: facet.state ?? 'UNVERIFIED',
      reference: facet.reference ?? null, memberAssociation: facet.memberAssociation ?? null,
      provenance: facet.provenance ?? null, submittedAt: facet.submittedAt ?? null,
      verifiedAt: facet.verifiedAt ?? null, recheckAt: facet.recheckAt ?? null, note: facet.note ?? null,
    };
  };
  const profileView = (p) => {
    if (!p) return null;
    const fifa = facetView(p.facets?.fifa_licence);
    const national = Object.fromEntries(Object.entries(p.facets?.national_registration ?? {}).map(([k, v]) => [k, facetView(v)]));
    const minors = Object.fromEntries(Object.entries(p.facets?.minors_authorisation ?? {}).map(([k, v]) => [k, facetView(v)]));
    return {
      id: p.id, userId: p.userId, agencyOrgId: p.agencyOrgId, displayName: p.displayName,
      declared: p.declared ?? {}, facets: { fifa_licence: fifa, national_registration: national, minors_authorisation: minors },
      regulatoryState: {
        fifaLicence: fifa?.state ?? 'UNVERIFIED',
        jurisdictions: (p.declared?.jurisdictions ?? []).map((ma) => ({
          memberAssociation: ma,
          nationalRegistration: national[ma]?.state ?? 'UNVERIFIED',
          minorsAuthorisation: minors[ma]?.state ?? 'UNVERIFIED',
          regulatedActionsPermitted: !verificationGap(p, ma, now()),
        })),
      },
      policyVersion: AGENT_POLICY_VERSION, createdAt: p.createdAt, updatedAt: p.updatedAt, ...revMeta(p),
      history: (p.history ?? []).map((h) => ({ id: h.id, at: h.at, action: h.action, detail: h.detail ?? null })),
      honest: 'Verification states are derived from recorded provenance. A licence number you typed is a declaration, not a verified licence. No FIFA, FA or U.S. Soccer register integration exists in this build.',
    };
  };

  /** What the agent may see of a client, by relationship state. */
  function clientIdentity(agreement, req) {
    const player = findPlayer(agreement.clientId);
    if (!player) return { id: agreement.clientId, name: null, removed: true };
    const st = effectiveAgreementStatus(agreement, now());
    const visible = orgCanSee(req.org, player);
    if (!visible) return { id: player.id, name: null, unavailable: true };
    const view = playerViewForOrg(player, req.org) ?? {};
    const minimal = { id: player.id, name: player.name, position: view.position ?? null, age: view.age ?? null, club: view.club ?? view.currentClub ?? null, country: view.country ?? null };
    if (agreementGrantsAccess(agreement, req.orgUser.id, now())) return { ...view, id: player.id, name: player.name, accessBasis: 'active_confirmed_relationship' };
    return { ...minimal, accessBasis: st === 'proposed' ? 'pending_request' : 'none' };
  }

  // ============================================================ ORG: me / home
  orgRouter.get('/agent/me', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const p = profileOf(req.orgUser.id);
    res.json({
      user: { id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role },
      org: orgSafe(req.org),
      affiliation: { id: req.affiliation.id, tiers: req.tiers, startedAt: req.affiliation.startedAt, ...revMeta(req.affiliation) },
      capabilities: capabilitiesOf(req.tiers),
      profile: profileView(p),
      platform: { testVerificationProvider: testProviderEnabled },
      policyVersion: AGENT_POLICY_VERSION,
    });
  });

  orgRouter.get('/agent/home', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const me = req.orgUser.id;
    const p = profileOf(me);
    const mine = agreementsOfAgency(req.org.id).filter((a) => a.agentUserId === me);
    const t = now();
    const counts = { active: 0, pending: 0, expiringSoon: 0, disputed: 0, expired: 0 };
    const alerts = [];
    for (const a of mine) {
      const st = effectiveAgreementStatus(a, t);
      if (st === 'active') {
        counts.active += 1;
        if (typeof a.endAt === 'number' && a.endAt - t <= EXPIRY_ALERT_MS) {
          counts.expiringSoon += 1;
          alerts.push({ kind: 'expiring', agreementId: a.id, endAt: a.endAt });
          // One notification per agreement, lazily, when the agent looks.
          if (!a.keys?.expiryNotifiedAt) {
            a.keys ??= {};
            a.keys.expiryNotifiedAt = t;
            notify({ kind: 'org_user', id: me }, 'representation_expiring', 'A client relationship ends within 30 days. A new relationship needs a new client confirmation.', a.id);
            persistNow();
          }
        }
      } else if (st === 'proposed') counts.pending += 1;
      else if (st === 'disputed') { counts.disputed += 1; alerts.push({ kind: 'disputed', agreementId: a.id }); }
      else if (st === 'expired') counts.expired += 1;
    }
    const fifa = p ? effectiveFacetState(p.facets?.fifa_licence, t) : 'UNVERIFIED';
    if (fifa !== 'VERIFIED') alerts.push({ kind: 'verification', facet: 'fifa_licence', state: fifa });
    for (const ma of p?.declared?.jurisdictions ?? []) {
      const gap = verificationGap(p, ma, t);
      if (gap) alerts.push({ kind: 'jurisdiction', memberAssociation: ma, facet: gap.facet, state: gap.state });
    }
    const unread = (db.notifications ?? []).filter((n) => n.audience?.kind === 'org_user' && n.audience.id === me && !n.read).length;
    res.json({
      profileState: fifa, hasProfile: !!p, tiers: req.tiers, counts, alerts, unreadNotifications: unread,
      regulatoryNotice: 'ScoutBox is infrastructure. It performs no football-agent services, adjudicates no conflicts and confirms no regulatory status. Relationship records here are confirmed by the client, not by ScoutBox.',
    });
  });

  // ============================================================ ORG: profile
  orgRouter.get('/agent/profile', (req, res) => {
    if (!resolveMembership(req, res)) return;
    res.json({ profile: profileView(profileOf(req.orgUser.id)), states: VERIFICATION_STATES, facets: FACETS, jurisdictions: JURISDICTIONS });
  });

  orgRouter.post('/agent/profile', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'profile.write.own')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const b = req.body ?? {};
    const displayName = b.displayName === undefined ? undefined : String(b.displayName ?? '').trim().slice(0, 80);
    if (displayName !== undefined && !displayName) return sendAgentError(res, { error: 'AGENT_INPUT_INVALID', field: 'displayName', message: 'displayName must not be empty.' }, 'profile');
    const jurisdictions = b.jurisdictions === undefined ? undefined : (Array.isArray(b.jurisdictions) ? b.jurisdictions.filter((j) => JURISDICTIONS.includes(j)) : null);
    if (jurisdictions === null) return sendAgentError(res, { error: 'AGENT_JURISDICTION_INVALID', allowed: JURISDICTIONS, message: 'jurisdictions must be a list of member-association codes.' }, 'profile');
    const licenceNumber = b.fifaLicenceNumber === undefined ? undefined : String(b.fifaLicenceNumber ?? '').trim().slice(0, 40);
    let p = profileOf(req.orgUser.id);
    const created = !p;
    if (!p) {
      p = {
        id: nextId('agp'), userId: req.orgUser.id, agencyOrgId: req.org.id,
        displayName: displayName ?? req.orgUser.name, declared: { fifaLicenceNumber: licenceNumber ?? null, jurisdictions: jurisdictions ?? [] },
        facets: newFacets(), policyVersion: AGENT_POLICY_VERSION,
        createdAt: now(), updatedAt: now(), rev: 1, revAt: now(), revBy: null, keys: {}, history: [],
      };
      hist(p, 'agent_profile_created', byOrg(req));
      db.agentProfiles.push(p);
    } else {
      if (!guardRev(req, res, p, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: {} })) return;
      const changes = {};
      if (displayName !== undefined && displayName !== p.displayName) { p.displayName = displayName; changes.displayName = true; }
      if (jurisdictions !== undefined) { p.declared.jurisdictions = jurisdictions; changes.jurisdictions = true; }
      if (licenceNumber !== undefined && licenceNumber !== p.declared.fifaLicenceNumber) {
        p.declared.fifaLicenceNumber = licenceNumber || null;
        // A changed declaration invalidates nothing verified? It does: the
        // verified reference is no longer the declared one.
        if (p.facets.fifa_licence?.state === 'VERIFIED' && p.facets.fifa_licence.reference !== licenceNumber) {
          p.facets.fifa_licence = { ...p.facets.fifa_licence, state: 'UNVERIFIED', note: 'The declared licence number changed; re-submit for verification.' };
          hist(p, 'agent_verification_state_changed', byOrg(req), { facet: 'fifa_licence', state: 'UNVERIFIED' });
          broadcast('agent_verification_state_changed', { orgId: req.org.id, userId: p.userId, facet: 'fifa_licence', state: 'UNVERIFIED' });
        }
        changes.fifaLicenceNumber = true;
      }
      p.updatedAt = now();
      hist(p, 'agent_profile_updated', byOrg(req), { fields: Object.keys(changes) });
      bumpRev(p, { by: req.orgUser, at: now() });
    }
    persistNow();
    if (created) broadcast('agent_profile_created', { orgId: req.org.id, userId: p.userId });
    res.status(created ? 201 : 200).json({ profile: profileView(p) });
  });

  /**
   * Submit a facet for verification. Production has no provider and no
   * attributed reviewer yet, so the honest outcome is MANUAL_REVIEW_REQUIRED
   * with a note that says exactly why. The synthetic provider (flag) exists
   * for development and tests and names itself in the provenance.
   */
  orgRouter.post('/agent/profile/facets/:facet/submit', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'verification.submit')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const facet = req.params.facet;
    if (!FACETS.includes(facet)) return sendAgentError(res, { error: 'AGENT_FACET_INVALID', allowed: FACETS }, 'facet');
    const p = profileOf(req.orgUser.id);
    if (!p) return sendAgentError(res, { error: 'AGENT_PROFILE_REQUIRED', message: 'Create your agent profile first.' }, 'facet');
    const reference = String(req.body?.reference ?? '').trim().slice(0, 60);
    if (!reference) return sendAgentError(res, { error: 'AGENT_INPUT_INVALID', field: 'reference', message: 'A reference is required.' }, 'facet');
    const ma = facet === 'fifa_licence' ? null : String(req.body?.memberAssociation ?? '').trim().toUpperCase();
    // A national facet belongs to a member association; INT is FIFA level, not one.
    if (facet !== 'fifa_licence' && (ma === 'INT' || !JURISDICTIONS.includes(ma))) return sendAgentError(res, { error: 'AGENT_JURISDICTION_INVALID', allowed: JURISDICTIONS.filter((j) => j !== 'INT') }, 'facet');
    if (facet === 'minors_authorisation') {
      // Recorded, never activated: no production minors pathway exists (P5.6A DR-49).
    }
    const outcome = evaluateSubmission({ facet, reference, testProviderEnabled, now: now() });
    const next = { state: outcome.state, reference, memberAssociation: ma, provenance: outcome.provenance, submittedAt: now(), verifiedAt: outcome.verifiedAt, recheckAt: outcome.recheckAt, note: outcome.note };
    const prev = facet === 'fifa_licence' ? p.facets.fifa_licence : p.facets[facet][ma];
    if (facet === 'fifa_licence') p.facets.fifa_licence = next; else p.facets[facet][ma] = next;
    hist(p, 'agent_verification_submitted', byOrg(req), { facet, memberAssociation: ma });
    if ((prev?.state ?? 'UNVERIFIED') !== next.state) {
      hist(p, 'agent_verification_state_changed', byOrg(req), { facet, memberAssociation: ma, from: prev?.state ?? 'UNVERIFIED', to: next.state, state: next.state });
      broadcast('agent_verification_state_changed', { orgId: req.org.id, userId: p.userId, facet, state: next.state });
      if (next.state === 'VERIFIED' || next.state === 'INACTIVE' || next.state === 'MANUAL_REVIEW_REQUIRED') {
        notify({ kind: 'org_user', id: p.userId }, 'agent_verification', `Verification facet ${facet}${ma ? ` (${ma})` : ''} is now ${next.state.replace(/_/g, ' ').toLowerCase()}.`, p.id);
      }
    }
    p.updatedAt = now();
    bumpRev(p, { by: req.orgUser, at: now() });
    persistNow();
    res.json({ profile: profileView(p), facet: facetView(next), provider: testProviderEnabled ? 'local-synthetic-test-provider' : 'none' });
  });

  // ============================================================ ORG: agency
  const memberRows = (org) => (db.agencyAffiliations ?? [])
    .filter((a) => a && a.agencyOrgId === org.id)
    .map((a) => {
      const u = db.users.find((x) => x.id === a.userId);
      const p = profileOf(a.userId);
      return {
        affiliationId: a.id, userId: a.userId, name: u?.name ?? null, role: u?.role ?? null,
        tiers: tiersOf(a), active: affiliationActive(a, now()), startedAt: a.startedAt, endedAt: a.endedAt ?? null, endedReason: a.endedReason ?? null,
        licensed: !!p, fifaLicence: p ? effectiveFacetState(p.facets?.fifa_licence, now()) : null,
        ...revMeta(a),
      };
    })
    .sort((x, y) => (x.active === y.active ? (x.startedAt - y.startedAt) : (x.active ? -1 : 1)));

  orgRouter.get('/agent/agency', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const members = memberRows(req.org);
    const active = members.filter((m) => m.active);
    const agreements = agreementsOfAgency(req.org.id);
    res.json({
      org: orgSafe(req.org),
      settings: req.org.agencySettings ?? { jurisdictions: [], description: '' },
      members: { active: active.length, admins: active.filter((m) => m.tiers.includes('agency_admin')).length, licensedAgents: active.filter((m) => m.tiers.includes('licensed_agent')).length },
      relationships: { active: agreements.filter((a) => effectiveAgreementStatus(a, now()) === 'active').length, pending: agreements.filter((a) => effectiveAgreementStatus(a, now()) === 'proposed').length, legacy: agreements.filter((a) => a.legacy).length },
      tiers: TIERS, permissions: PERMISSIONS,
      honest: 'An agency organisation holds no football-agent licence. Roles here decide what a member may do in ScoutBox, never whether they may perform football-agent services.',
    });
  });

  orgRouter.get('/agent/agency/team', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.read')) return;
    res.json({ members: memberRows(req.org), tiers: TIERS });
  });

  orgRouter.post('/agent/agency/team', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const name = String(req.body?.name ?? '').trim().slice(0, 80);
    if (!name) return sendAgentError(res, { error: 'AGENT_INPUT_INVALID', field: 'name' }, 'team');
    const tiers = normaliseTiers(req.body?.tiers);
    if (!tiers.length) return sendAgentError(res, { error: 'AGENT_TIERS_INVALID', allowed: TIERS }, 'team');
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const fp = payloadFingerprint({ name: name.toLowerCase(), tiers });
    if (key) {
      const hit = (db.agencyAffiliations ?? []).find((a) => a?.agencyOrgId === req.org.id && a.keys?.create?.key === key);
      if (hit) {
        if (hit.keys.create.fp === fp) return res.status(200).json({ member: memberRows(req.org).find((m) => m.affiliationId === hit.id), idempotent: true });
        return sendAgentError(res, { error: 'AFFILIATION_IDEMPOTENCY_CONFLICT' }, 'team');
      }
    }
    let user = db.users.find((u) => u.orgId === req.org.id && u.name.toLowerCase() === name.toLowerCase());
    if (user?.removedAt) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'This person\'s access was removed; removal is not undone from the team page.' }, 'team');
    if (!user) {
      user = { id: nextId('usr'), orgId: req.org.id, name, role: String(req.body?.role ?? 'Agency staff').trim().slice(0, 60) || 'Agency staff', createdAt: now() };
      db.users.push(user);
    }
    if (activeAffiliationOf(user.id, req.org.id)) return sendAgentError(res, { error: 'MEMBER_ALREADY_AFFILIATED' }, 'team');
    const aff = {
      id: nextId('aff'), agencyOrgId: req.org.id, userId: user.id, tiers, startedAt: now(), endedAt: null, endedReason: null,
      createdAt: now(), rev: 1, revAt: now(), revBy: null, keys: key ? { create: { key, fp } } : {}, history: [],
    };
    hist(aff, 'agency_affiliation_created', byOrg(req), { tiers });
    db.agencyAffiliations.push(aff);
    persistNow();
    broadcast('agency_affiliation_created', { orgId: req.org.id, userId: user.id });
    notify({ kind: 'org_user', id: user.id }, 'agency_membership', `You were added to ${req.org.name} (${tiers.join(', ')}).`, aff.id);
    res.status(201).json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.patch('/agent/agency/team/:userId', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const aff = activeAffiliationOf(req.params.userId, req.org.id);
    if (!aff) return sendAgentError(res, { error: 'MEMBER_NOT_FOUND' }, 'team');
    const tiers = normaliseTiers(req.body?.tiers);
    if (!tiers.length) return sendAgentError(res, { error: 'AGENT_TIERS_INVALID', allowed: TIERS }, 'team');
    const problem = affiliationChangeProblem({ affiliations: (db.agencyAffiliations ?? []).filter((a) => a?.agencyOrgId === req.org.id), target: aff, actorUserId: req.orgUser.id, nextTiers: tiers, now: now() });
    if (problem) return sendAgentError(res, { error: problem, message: problem === 'LAST_ADMIN' ? 'An agency must keep at least one administrator.' : 'You cannot grant yourself the administrator role.' }, 'team');
    if (!guardRev(req, res, aff, { errorCode: 'AFFILIATION_VERSION_CONFLICT', current: { tiers: tiersOf(aff) } })) return;
    const from = tiersOf(aff);
    aff.tiers = tiers;
    hist(aff, 'agency_affiliation_updated', byOrg(req), { from, to: tiers, tiers });
    bumpRev(aff, { by: req.orgUser, at: now() });
    persistNow();
    res.json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.post('/agent/agency/team/:userId/end', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const aff = activeAffiliationOf(req.params.userId, req.org.id);
    if (!aff) return sendAgentError(res, { error: 'MEMBER_NOT_FOUND' }, 'team');
    const problem = affiliationChangeProblem({ affiliations: (db.agencyAffiliations ?? []).filter((a) => a?.agencyOrgId === req.org.id), target: aff, actorUserId: req.orgUser.id, nextTiers: [], now: now(), ending: true });
    if (problem) return sendAgentError(res, { error: problem, message: 'An agency must keep at least one administrator.' }, 'team');
    if (!guardRev(req, res, aff, { errorCode: 'AFFILIATION_VERSION_CONFLICT', current: {} })) return;
    aff.endedAt = now();
    aff.endedReason = String(req.body?.reason ?? 'left').slice(0, 40);
    hist(aff, 'agency_affiliation_ended', byOrg(req), { reasonCode: aff.endedReason });
    bumpRev(aff, { by: req.orgUser, at: now() });
    // Current agency access ends now; the person's agent profile and every
    // historical attribution stay exactly as they are.
    const user = db.users.find((u) => u.id === aff.userId);
    if (user && !user.removedAt) user.removedAt = now();
    revokeOrgUserAccess?.(aff.userId);
    persistNow();
    broadcast('agency_affiliation_ended', { orgId: req.org.id, userId: aff.userId });
    res.json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.patch('/agent/agency/settings', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.settings.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const b = req.body ?? {};
    const settings = req.org.agencySettings ?? { jurisdictions: [], description: '' };
    if (b.jurisdictions !== undefined) {
      if (!Array.isArray(b.jurisdictions) || b.jurisdictions.some((j) => !JURISDICTIONS.includes(j))) return sendAgentError(res, { error: 'AGENT_JURISDICTION_INVALID', allowed: JURISDICTIONS }, 'settings');
      settings.jurisdictions = [...new Set(b.jurisdictions)];
    }
    if (b.description !== undefined) {
      const d = String(b.description ?? '').slice(0, 300);
      if (d && !moderateOrRefuse(res, d, { kind: 'agency_settings', orgId: req.org.id })) return;
      settings.description = d;
    }
    req.org.agencySettings = settings;
    persistNow();
    res.json({ settings });
  });

  orgRouter.get('/agent/agency/compliance', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.compliance.read')) return;
    const rows = memberRows(req.org).filter((m) => m.active && m.tiers.includes('licensed_agent')).map((m) => {
      const p = profileOf(m.userId);
      const v = profileView(p);
      return { userId: m.userId, name: m.name, hasProfile: !!p, fifaLicence: v?.regulatoryState.fifaLicence ?? 'UNVERIFIED', jurisdictions: v?.regulatoryState.jurisdictions ?? [] };
    });
    res.json({
      agents: rows,
      informational: true,
      honest: 'Informational only. Nothing here verifies, approves or overrides a regulatory state; attributed Trust & Safety review of agent licences is a P5.6C prerequisite (G-C0).',
    });
  });

  orgRouter.get('/agent/agency/audit', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.audit.read')) return;
    const all = agentAuditRows(db, req.org, { findPlayer, orgCanSee });
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 25));
    let start = 0;
    if (req.query.cursor) {
      const idx = all.findIndex((r) => r.id === String(req.query.cursor));
      if (idx < 0) return res.status(400).json({ error: 'AUDIT_CURSOR_INVALID' });
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    res.json({ items: page, nextCursor: start + limit < all.length ? page[page.length - 1].id : null, total: all.length });
  });

  // ============================================================ ORG: players lookup
  orgRouter.get('/agent/players', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'players.lookup')) return;
    if (limitedOr429(res, 'agent_player_lookup', req.orgUser.id)) return;
    const q = String(req.query.q ?? '').trim().toLowerCase();
    if (q.length < 2) return res.json({ items: [], note: 'Type at least two characters.' });
    const items = [];
    for (const p of db.players) {
      if (!isAdult(p)) continue;                       // minors never appear, whatever the query
      if (!visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) continue;
      if (!String(p.name ?? '').toLowerCase().includes(q)) continue;
      const view = playerViewForOrg(p, req.org) ?? {};
      items.push({ id: p.id, name: p.name, position: view.position ?? null, age: view.age ?? null, club: view.club ?? view.currentClub ?? null, country: view.country ?? null });
      if (items.length >= 20) break;
    }
    res.json({ items, adultsOnly: true });
  });

  // ============================================================ ORG: clients
  function visibleAgreementsFor(req) {
    const me = req.orgUser.id;
    const rows = [];
    for (const a of agreementsOfAgency(req.org.id)) {
      if (a.agentUserId === me && can(req.tiers, 'clients.read.own')) rows.push({ a, mode: 'own' });
      else if (can(req.tiers, 'clients.read.shared_summary') && (a.shareWithAgencyStaff || a.legacy)) rows.push({ a, mode: 'summary' });
    }
    return rows;
  }
  const listRow = (req, { a, mode }) => {
    if (mode === 'summary') {
      const player = findPlayer(a.clientId);
      const name = player && orgCanSee(req.org, player) ? player.name : null;
      return { ...agreementSummaryForStaff(a, now()), client: { id: a.clientId, name }, legacy: a.legacy ?? null };
    }
    return { ...agreementForAgent(a, now()), client: clientIdentity(a, req), mode: 'own' };
  };

  orgRouter.get('/agent/clients', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const rows = visibleAgreementsFor(req).map((r) => listRow(req, r))
      .sort((x, y) => (y.proposedAt ?? y.startAt ?? 0) - (x.proposedAt ?? x.startAt ?? 0));
    res.json({ items: rows, scopes: SCOPES, maxTermMonths: MAX_TERM_MONTHS, jurisdictions: JURISDICTIONS });
  });

  function findOwnAgreement(req, res, id) {
    const a = (db.representationAgreements ?? []).find((x) => x && x.id === id);
    if (!a || a.agencyOrgId !== req.org.id) { sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'client'); return null; }
    if (a.agentUserId === req.orgUser.id && can(req.tiers, 'clients.read.own')) return a;
    if (can(req.tiers, 'clients.read.shared_summary') && (a.shareWithAgencyStaff || a.legacy)) return { summaryOnly: true, a };
    sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'client');
    return null;
  }

  /**
   * Request a relationship with an ADULT player. A REGULATED action under the
   * frozen P5.6A classification (an Approach), so the objective step-5 check
   * applies: the agent's required facets must be VERIFIED. In production no
   * facet can be VERIFIED until attributed review exists (G-C0), which is the
   * honest state of this build; development and tests use the synthetic
   * provider.
   */
  orgRouter.post('/agent/clients/request', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.request')) return;
    const b = req.body ?? {};
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    if (b.scope !== undefined) {
      const raw = Array.isArray(b.scope) ? b.scope : (typeof b.scope === 'string' ? [b.scope] : null);
      if (!raw || raw.length === 0 || raw.some((s) => !SCOPES.includes(s))) return sendAgentError(res, { error: 'AGENT_SCOPE_INVALID', allowed: SCOPES }, 'request');
    }
    const scope = normaliseScope(b.scope);
    const termMonths = termMonthsOf(b.termMonths);
    if (termMonths === null) return sendAgentError(res, { error: 'AGENT_TERM_INVALID', message: `termMonths must be a whole number from 1 to ${MAX_TERM_MONTHS}.` }, 'request');
    const jurisdiction = String(b.jurisdiction ?? 'INT').toUpperCase();
    if (!JURISDICTIONS.includes(jurisdiction)) return sendAgentError(res, { error: 'AGENT_JURISDICTION_INVALID', allowed: JURISDICTIONS }, 'request');
    const exclusive = !!b.exclusive;
    const playerId = String(b.playerId ?? '');
    const fp = payloadFingerprint({ playerId, scope, termMonths, jurisdiction, exclusive });
    if (key) {
      const hit = (db.representationAgreements ?? []).find((a) => a?.agencyOrgId === req.org.id && a.agentUserId === req.orgUser.id && a.keys?.request?.key === key);
      if (hit) {
        if (hit.keys.request.fp === fp) return res.status(200).json({ relationship: { ...agreementForAgent(hit, now()), client: clientIdentity(hit, req) }, idempotent: true });
        return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, 'request');
      }
    }
    // Step 8 before step 5? No — but the subject check must not leak: a
    // player who does not exist, a minor, a blocked player and an invisible
    // player answer alike, and the verification refusal (own state) comes
    // first so a refused agent learns nothing about the subject either way.
    const gap = verificationGap(profileOf(req.orgUser.id), jurisdiction, now());
    if (gap) return sendAgentError(res, { ...gap, message: gap.error === 'AGENT_PROFILE_REQUIRED' ? 'Create your agent profile first.' : `A regulated action needs a VERIFIED ${gap.facet}${gap.memberAssociation ? ` (${gap.memberAssociation})` : ''}; it is ${gap.state}.` }, 'request');
    // The quota counts attempts that reach a SUBJECT — solicitation and
    // enumeration — not malformed input or the agent's own refusals.
    if (limitedOr429(res, 'agent_representation_request', req.orgUser.id)) return;
    const player = findPlayer(playerId);
    if (!player || !isAdult(player) || !visibleToOrg(player, req.org) || isBlocked(player.id, req.org.id)) {
      return sendAgentError(res, { error: 'PLAYER_NOT_FOUND' }, 'request');
    }
    const conflict = requestConflict(db.representationAgreements ?? [], { agentUserId: req.orgUser.id, playerId: player.id, now: now() });
    if (conflict) return sendAgentError(res, { ...conflict, message: conflict.error === 'REPRESENTATION_COOLDOWN' ? 'A recent request to this player was declined or ended; wait before asking again.' : 'A relationship with this player already exists or is pending.' }, 'request');
    const a = {
      id: nextId('rep'), agentUserId: req.orgUser.id, agencyOrgId: req.org.id,
      clientKind: 'player', clientId: player.id, isRegulatoryMinor: false,
      jurisdiction, scope, exclusive, termMonths, startAt: null, endAt: null,
      status: 'proposed', proposedAt: now(), confirmedAt: null, confirmedBy: null,
      declinedAt: null, terminatedAt: null, terminatedBy: null, terminationReasonCode: null, disputedAt: null, disputeReason: null,
      shareWithAgencyStaff: false, documents: [], legacy: null,
      policyVersion: AGENT_POLICY_VERSION, keys: key ? { request: { key, fp } } : {},
      createdAt: now(), rev: 1, revAt: now(), revBy: null, history: [],
    };
    hist(a, 'representation_requested', byOrg(req), { scope, termMonths, jurisdiction });
    db.representationAgreements.push(a);
    persistNow();
    broadcast('representation_requested', { orgId: req.org.id, agreementId: a.id, agentUserId: a.agentUserId });
    const agentName = profileOf(req.orgUser.id)?.displayName ?? req.orgUser.name;
    notify({ kind: 'player', id: player.id }, 'representation_request', `${agentName} (${req.org.name}) asks to represent you (${scope.join(', ')}, ${termMonths} months). Nothing is active until YOU confirm it in My Agent.`, a.id);
    res.status(201).json({ relationship: { ...agreementForAgent(a, now()), client: clientIdentity(a, req) } });
  });

  orgRouter.get('/agent/clients/:id', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const found = findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.json({ relationship: listRow(req, { a: found.a, mode: 'summary' }), mode: 'summary' });
    const a = found;
    res.json({
      relationship: agreementForAgent(a, now()),
      client: clientIdentity(a, req),
      access: agreementGrantsAccess(a, req.orgUser.id, now()) && orgCanSee(req.org, findPlayer(a.clientId)),
      mode: 'own',
    });
  });

  orgRouter.post('/agent/clients/:id/terminate', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.terminate')) return;
    const found = findOwnAgreement(req, res, req.params.id);
    if (!found || found.summaryOnly) { if (found?.summaryOnly) sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'terminate'); return; }
    const a = found;
    if (a.legacy) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'Legacy agency-level relationships are read-only here.' }, 'terminate');
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const reasonCode = String(req.body?.reasonCode ?? 'agent_ended').slice(0, 40);
    const fp = payloadFingerprint({ reasonCode });
    if (key && a.keys?.terminate?.key === key) {
      if (a.keys.terminate.fp === fp) return res.json({ relationship: agreementForAgent(a, now()), idempotent: true });
      return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, 'terminate');
    }
    if (!agentTransitionAllowed(a, 'terminated_by_agent', now())) return sendAgentError(res, { error: 'REPRESENTATION_NOT_ACTIVE', status: effectiveAgreementStatus(a, now()) }, 'terminate');
    if (!guardRev(req, res, a, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: { status: effectiveAgreementStatus(a, now()) } })) return;
    const phase = effectiveAgreementStatus(a, now());
    a.status = 'terminated_by_agent';
    a.terminatedAt = now();
    a.terminatedBy = 'agent';
    a.terminationReasonCode = reasonCode;
    if (key) a.keys.terminate = { key, fp };
    hist(a, 'representation_terminated', byOrg(req), { by: 'agent', phase, reasonCode });
    bumpRev(a, { by: req.orgUser, at: now() });
    persistNow();
    broadcast('representation_terminated', { orgId: req.org.id, agreementId: a.id, agentUserId: a.agentUserId });
    notify({ kind: 'player', id: a.clientId }, 'representation_terminated', phase === 'proposed' ? 'An agent withdrew their representation request.' : 'Your agent ended the representation relationship. The record stays in your history.', a.id);
    res.json({ relationship: agreementForAgent(a, now()) });
  });

  orgRouter.get('/agent/clients/:id/opportunities', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.opportunities.read')) return;
    const found = findOwnAgreement(req, res, req.params.id);
    if (!found || found.summaryOnly) { if (found?.summaryOnly) sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'opps'); return; }
    const a = found;
    const player = findPlayer(a.clientId);
    if (!agreementGrantsAccess(a, req.orgUser.id, now()) || !player || !orgCanSee(req.org, player)) {
      return sendAgentError(res, { error: 'REPRESENTATION_NOT_ACTIVE', status: effectiveAgreementStatus(a, now()) }, 'opps');
    }
    const items = opportunityBoardFor(db, player, { orgCanSee, checkEligibility, distanceBand })
      .map((o) => ({ id: o.id, via: o.via, type: o.type, orgId: o.orgId, orgName: o.orgName, title: o.title, deadline: o.deadline, schedule: o.schedule ?? null, category: o.category ?? null, distance: o.distance ?? null, applied: o.applied ?? null }));
    res.json({ items, clientId: player.id, note: 'The client\'s own board, read through the same mutual-visibility and eligibility rules the player sees. Applying is the player\'s act.' });
  });

  orgRouter.get('/agent/opportunities', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.opportunities.read')) return;
    const items = [];
    for (const a of agreementsOfAgency(req.org.id)) {
      if (!agreementGrantsAccess(a, req.orgUser.id, now())) continue;
      const player = findPlayer(a.clientId);
      if (!player || !orgCanSee(req.org, player)) continue;
      for (const o of opportunityBoardFor(db, player, { orgCanSee, checkEligibility, distanceBand })) {
        items.push({ id: o.id, via: o.via, type: o.type, orgId: o.orgId, orgName: o.orgName, title: o.title, deadline: o.deadline, category: o.category ?? null, distance: o.distance ?? null, applied: o.applied ?? null, clientId: player.id, clientName: player.name, agreementId: a.id });
      }
    }
    items.sort((x, y) => String(x.deadline).localeCompare(String(y.deadline)));
    res.json({ items, note: 'Only opportunities legitimately visible to a confirmed client appear here. Club-private recruitment cases never do.' });
  });

  orgRouter.get('/agent/inbox', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'inbox.read')) return;
    const me = req.orgUser.id;
    const notifications = (db.notifications ?? []).filter((n) => n.audience?.kind === 'org_user' && n.audience.id === me).slice().reverse().slice(0, 100);
    const pending = agreementsOfAgency(req.org.id).filter((a) => a.agentUserId === me && effectiveAgreementStatus(a, now()) === 'proposed')
      .map((a) => ({ ...agreementForAgent(a, now()), client: clientIdentity(a, req) }));
    res.json({ notifications, pending, note: 'Operational messages only. Negotiation and offers are not part of this workspace.' });
  });

  // ============================================================ PLAYER: My Agent
  const agentIdentityForClient = (a) => {
    const user = a.agentUserId ? db.users.find((u) => u.id === a.agentUserId) : null;
    const p = a.agentUserId ? profileOf(a.agentUserId) : null;
    const org = db.orgs.find((o) => o.id === a.agencyOrgId);
    const fifa = p ? effectiveFacetState(p.facets?.fifa_licence, now()) : null;
    return {
      userId: a.agentUserId, displayName: p?.displayName ?? user?.name ?? (a.legacy?.representativeName ?? null),
      agency: org ? { id: org.id, name: org.name } : null,
      verification: p ? { fifaLicence: fifa, jurisdictions: (p.declared?.jurisdictions ?? []).map((ma) => ({ memberAssociation: ma, nationalRegistration: effectiveFacetState(p.facets?.national_registration?.[ma], now()) })) } : null,
      honest: fifa === 'VERIFIED' ? 'Verified against recorded provenance; check the provenance before relying on it.' : 'This agent\'s licence is NOT verified in ScoutBox.',
    };
  };

  playerRouter.get('/agent/relationships', (req, res) => {
    if (req.playerIsMinor) return res.json({ items: [], minor: true, note: 'Agent representation is not available for under-18 accounts in ScoutBox.' });
    const items = (db.representationAgreements ?? []).filter((a) => a && a.clientKind === 'player' && a.clientId === req.player.id)
      .map((a) => ({ ...agreementForClient(a, now()), agent: agentIdentityForClient(a) }))
      .sort((x, y) => (y.proposedAt ?? 0) - (x.proposedAt ?? 0));
    res.json({ items, note: 'Nothing is active until you confirm it. You can end an active relationship at any time; the record stays in your history.' });
  });

  function clientMutation(req, res, to, { reasonField = null, notifyType, notifyText, event, action } = {}) {
    if (req.playerIsMinor) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'Guardian-managed accounts cannot hold agent relationships in ScoutBox.' }, action);
    if (limitedOr429(res, 'agent_client_response', req.player.id)) return;
    const a = (db.representationAgreements ?? []).find((x) => x && x.id === req.params.id && x.clientId === req.player.id);
    if (!a) return sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, action);
    if (a.legacy) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED', message: 'Legacy relationships are managed from the earlier representation screen.' }, action);
    const key = clientKeyOr400(req, res); if (key === undefined) return;
    const reason = reasonField ? String(req.body?.[reasonField] ?? '').slice(0, 300) : null;
    if (reason && !moderateOrRefuse(res, reason, { kind: 'representation', playerId: req.player.id, orgId: a.agencyOrgId })) return;
    const fp = payloadFingerprint({ to, reason });
    if (key && a.keys?.[action]?.key === key) {
      if (a.keys[action].fp === fp) return res.json({ relationship: { ...agreementForClient(a, now()), agent: agentIdentityForClient(a) }, idempotent: true });
      return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, action);
    }
    const st = effectiveAgreementStatus(a, now());
    if (!clientTransitionAllowed(a, to, now())) {
      const code = to === 'active' && st !== 'proposed' ? 'REPRESENTATION_NOT_ACTIVE' : st === 'disputed' ? 'REPRESENTATION_DISPUTED' : 'REPRESENTATION_NOT_ACTIVE';
      return sendAgentError(res, { error: code, status: st, message: to === 'active' ? 'This request is no longer open — the agent may have withdrawn it.' : 'This relationship is not in a state that allows that.' }, action);
    }
    // A block against the agency ends solicitation; confirming through it
    // is refused rather than silently allowed.
    if (to === 'active' && isBlocked(req.player.id, a.agencyOrgId)) return sendAgentError(res, { error: 'REPRESENTATION_NOT_ACTIVE', status: st, message: 'You have blocked this agency. Lift the block first if you want to confirm.' }, action);
    if (!guardRev(req, res, a, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: { status: st } })) return;
    const t = now();
    if (to === 'active') { a.status = 'active'; a.confirmedAt = t; a.confirmedBy = { kind: 'player', id: req.player.id }; a.startAt = t; a.endAt = termEndAt(t, a.termMonths ?? 12); }
    else if (to === 'declined') { a.status = 'declined'; a.declinedAt = t; }
    else if (to === 'terminated_by_client') { a.status = 'terminated_by_client'; a.terminatedAt = t; a.terminatedBy = 'client'; a.terminationReasonCode = 'client_ended'; }
    else if (to === 'disputed') { a.status = 'disputed'; a.disputedAt = t; a.disputeReason = reason || null; }
    if (key) { a.keys ??= {}; a.keys[action] = { key, fp }; }
    hist(a, event === 'representation_confirmed' ? 'representation_confirmed' : event === 'representation_rejected' ? 'representation_rejected' : event === 'representation_disputed' ? 'representation_disputed' : 'representation_terminated', byPlayer(req), { from: st, to, by: 'client', hadReason: !!reason });
    bumpRev(a, { by: { id: req.player.id, name: req.player.name }, at: t });
    persistNow();
    // Literal event names: the M18.2 registry audit reads call sites textually.
    const ev = { orgId: a.agencyOrgId, agreementId: a.id, agentUserId: a.agentUserId };
    if (event === 'representation_confirmed') broadcast('representation_confirmed', ev);
    else if (event === 'representation_rejected') broadcast('representation_rejected', ev);
    else if (event === 'representation_disputed') broadcast('representation_disputed', ev);
    else broadcast('representation_terminated', ev);
    if (a.agentUserId) notify({ kind: 'org_user', id: a.agentUserId }, notifyType, notifyText, a.id);
    res.json({ relationship: { ...agreementForClient(a, now()), agent: agentIdentityForClient(a) } });
  }

  playerRouter.post('/agent/relationships/:id/confirm', (req, res) => clientMutation(req, res, 'active', {
    action: 'confirm', event: 'representation_confirmed', notifyType: 'representation_confirmed',
    notifyText: 'A client confirmed your representation relationship. It is active from now until its end date.',
  }));
  playerRouter.post('/agent/relationships/:id/decline', (req, res) => clientMutation(req, res, 'declined', {
    action: 'decline', event: 'representation_rejected', notifyType: 'representation_rejected',
    notifyText: 'A player declined your representation request. You cannot ask again for 30 days.',
  }));
  playerRouter.post('/agent/relationships/:id/terminate', (req, res) => clientMutation(req, res, 'terminated_by_client', {
    action: 'terminate', event: 'representation_terminated', notifyType: 'representation_terminated',
    notifyText: 'A client ended the representation relationship. Your access to their client workspace has ended; the record stays.',
  }));
  playerRouter.post('/agent/relationships/:id/dispute', (req, res) => clientMutation(req, res, 'disputed', {
    action: 'dispute', reasonField: 'reason', event: 'representation_disputed', notifyType: 'representation_disputed',
    notifyText: 'A client disputed the representation relationship. Private access is suspended pending attributed Trust & Safety review, which is not yet available in this build.',
  }));

  playerRouter.patch('/agent/relationships/:id/sharing', (req, res) => {
    if (req.playerIsMinor) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'sharing');
    const a = (db.representationAgreements ?? []).find((x) => x && x.id === req.params.id && x.clientId === req.player.id);
    if (!a) return sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'sharing');
    if (!guardRev(req, res, a, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: {} })) return;
    const v = !!req.body?.shareWithAgencyStaff;
    if (v !== !!a.shareWithAgencyStaff) {
      a.shareWithAgencyStaff = v;
      hist(a, 'representation_sharing_changed', byPlayer(req), { shareWithAgencyStaff: v });
      bumpRev(a, { by: { id: req.player.id, name: req.player.name }, at: now() });
      persistNow();
    }
    res.json({ relationship: { ...agreementForClient(a, now()), agent: agentIdentityForClient(a) } });
  });

  // ============================================================ ADMIN: read only
  // Trust & Safety may LOOK. There is deliberately no admin mutation in this
  // module: verifying a licence, resolving a dispute or overriding a state
  // requires attributed reviewer identity (G-C0) and belongs to P5.6C.
  adminRouter.get('/agent/relationships', (_req, res) => {
    res.json({
      items: (db.representationAgreements ?? []).map((a) => ({ ...agreementForAgent(a, now()), history: undefined })),
      readOnly: true,
      note: 'Read-only. No Trust & Safety action on agent relationships or licences exists in this build (P5.6A gate G-C0).',
    });
  });
  // States and provenance only. The declared number and the submitted
  // reference are withheld: without an attributed review lane (P5.6C) the
  // shared key has no use for them, and an oversight view needs the STATE.
  const facetForOversight = (f) => (f ? { state: f.state, storedState: f.storedState, provenance: f.provenance, submittedAt: f.submittedAt, verifiedAt: f.verifiedAt, recheckAt: f.recheckAt } : null);
  adminRouter.get('/agent/profiles', (_req, res) => {
    res.json({
      items: (db.agentProfiles ?? []).map((p) => {
        const v = profileView(p);
        return {
          id: v.id, userId: v.userId, agencyOrgId: v.agencyOrgId, displayName: v.displayName,
          declaredJurisdictions: v.declared?.jurisdictions ?? [],
          facets: {
            fifa_licence: facetForOversight(v.facets.fifa_licence),
            national_registration: Object.fromEntries(Object.entries(v.facets.national_registration).map(([k, f]) => [k, facetForOversight(f)])),
            minors_authorisation: Object.fromEntries(Object.entries(v.facets.minors_authorisation).map(([k, f]) => [k, facetForOversight(f)])),
          },
          regulatoryState: v.regulatoryState, policyVersion: v.policyVersion, rev: v.rev, revAt: v.revAt,
        };
      }),
      readOnly: true,
      note: 'Read-only oversight: states and provenance. Licence numbers and submitted references are not shown; attributed review (P5.6C) is where they would be needed.',
    });
  });

  // ============================================================ deletion hook
  /** Player account removal: keep the relationship as an id-only tombstone. */
  function onPlayerDeleted(playerId, at = now()) {
    for (const a of db.representationAgreements ?? []) {
      if (!a || a.clientKind !== 'player' || a.clientId !== playerId) continue;
      a.subjectRemovedAt = at;
      a.disputeReason = null;
      if (a.legacy) a.legacy = { ...a.legacy, representativeName: null };
      if (a.status === 'proposed') { a.status = 'declined'; a.declinedAt = at; }
      for (const h of a.history ?? []) if (h?.by?.kind === 'player') h.by = { kind: 'player', userId: null, name: null };
    }
  }

  return { onPlayerDeleted, effectiveAgreementStatus, agreementGrantsAccess, testProviderEnabled };
}
