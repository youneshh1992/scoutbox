/**
 * Agent core routes: profile, agency, clients and the player's My Agent.
 *
 * The shared Trust & Safety key cannot verify or reject a licence, resolve a dispute or override a state here (G-C0);
 * that needs an attributed reviewer in the compliance domain.
 */

import { visibleToOrg } from '../../../domain.mjs';
import { AGENT_CORE_LIMITS as LIM, PROFILE_FIELDS } from '../../../repositories/agentCore.mjs';
import { buildRouteHelpers } from '../../platform/routeHelpers.mjs';
import { opportunityBoardFor } from '../../scouting/public.mjs';
import { guardRev, revMeta } from '../../platform/concurrency.mjs';
import { refuseWhenLimited } from '../../platform/rateLimit.mjs';
import { readPage, sendPageError, pageOf } from '../../platform/paging.mjs';
import { normaliseClientKey, payloadFingerprint } from '../../platform/idempotency.mjs';
import { sendAgentError } from './errors.mjs';
import { parseInput, filled } from '../../platform/schemas.mjs';
import { AGENT_INPUT, agentParseOptions } from './schemas.mjs';
import { agentAuditRows } from './audit.mjs';
import { feedItem } from '../../../repositories/notifications.mjs';
import { facetFromProviderAnswer, FACET_METHOD } from '../compliance/provider.mjs';
import {
  AGENT_POLICY_VERSION,
  VERIFICATION_STATES,
  FACETS,
  JURISDICTIONS,
  TIERS,
  SCOPES,
  MAX_TERM_MONTHS,
  EXPIRY_ALERT_MS,
  newFacets,
  effectiveFacetState,
  evaluateSubmission,
  requiredFacetsFor,
  verificationGap,
  affiliationActive,
  tiersOf,
  PERMISSIONS,
  can,
  capabilitiesOf,
  affiliationChangeProblem,
  DEFAULT_TERM_MONTHS,
  termEndAt,
  effectiveAgreementStatus,
  agreementGrantsAccess,
  requestConflict,
  DISCLOSURE_KEYS,
  normaliseDisclosure,
  clientTransitionAllowed,
  agentTransitionAllowed,
  agreementForAgent,
  agreementForClient,
  agreementSummaryForStaff,
} from './shared.mjs';
import { now } from '../../platform/clock.mjs';

/**
 * `access` is the agent access checks (../access.mjs). `compliance` is the compliance engine's
 * `{ facetNeedsReview, representationDisputed, authorizeApproach, createApproachReview }`, and `auditSources` lists
 * the functions `(org) => rows` whose rows join the agency's audit feed.
 */
export function registerAgent(rawCtx) {
  const ctx = { ...rawCtx, ...buildRouteHelpers(rawCtx) };
  const {
    byId,
    players,
    users,
    notifications,
    orgRouter,
    playerRouter,
    adminRouter,
    nextId,
    notify,
    broadcast,
    findPlayer,
    isBlocked,
    playerViewForOrg,
    orgSafe,
    revokeOrgUserAccess,
    rateLimit,
    isAdult,
    orgCanSee,
    checkEligibility,
    distanceBand,
    moderateOrRefuse,
    verificationProvider,
    agentCore,
    unit,
    log = console,
    access,
    compliance,
    auditSources = [],
  } = ctx;
  if (!notifications) throw new TypeError('registerAgent needs the notifications repository (ctx.notifications)');
  if (typeof agentCore?.agreements?.recordAct !== 'function' || typeof unit !== 'function')
    throw new TypeError('registerAgent needs the agent core repository and unit from the data layer');
  if (typeof access?.resolveMembership !== 'function')
    throw new TypeError('registerAgent needs the agent access checks (ctx.access)');
  if (typeof compliance?.authorizeApproach !== 'function')
    throw new TypeError("registerAgent needs the compliance engine's review functions (ctx.compliance)");
  const { resolveMembership, requireCap, profileOf, findOwnAgreement } = access;
  const { profiles, affiliations, agreements, settings } = agentCore;

  const testProviderEnabled = process.env.AGENT_VERIFICATION_TEST_PROVIDER === '1';
  const entry = (action, by, detail = null) => ({ id: nextId('aud'), at: now(), action, by, detail });
  const hist = (record, action, by, detail = null) => {
    record.history ??= [];
    record.history.push(entry(action, by, detail));
  };
  /** `by` is an org user or a player `{ id, name }`. */
  const bumped = (by, at = now()) => ({ bump: { at, by } });
  const byOrg = (req) => ({ kind: 'org', userId: req.orgUser.id, name: req.orgUser.name });
  const byPlayer = (req) => ({ kind: 'player', userId: req.player.id, name: req.player.name });

  // ------------------------------------------------------------ input (junk is refused, naming the field)
  /** The request input read with its schema (AGENT_INPUT), or `undefined` once the refusal is sent. */
  const inputOr400 = (res, name, input, root = 'body') => {
    const parsed = parseInput(AGENT_INPUT[name], input ?? {}, agentParseOptions(name, root));
    if (parsed.ok) return parsed.value;
    sendAgentError(res, parsed, name);
    return undefined;
  };
  /** Text a schema has read: undefined when absent, null when blank, else trimmed. */
  const given = (v) => (v === undefined ? undefined : filled(v));

  // ------------------------------------------------------------ lookups
  const activeAffiliationOf = (userId, orgId) => affiliations.activeFor(userId, orgId, now());
  const agreementsOfAgency = (orgId) => agreements.forAgency(orgId);

  /** Paged newest first by rowid; null after answering a junk page with 400. */
  const pageQuery = (req, res) => {
    const q = inputOr400(res, 'page', req.query, 'query');
    if (!q) return null;
    try {
      return readPage(q, ['number']);
    } catch (e) {
      sendPageError(res, e);
      return null;
    }
  };

  const limitedOr429 = refuseWhenLimited(rateLimit);

  const clientKeyOr400 = (body, res) => {
    const k = normaliseClientKey(body.clientKey);
    if (!k.ok) {
      sendAgentError(res, { error: 'AGENT_CLIENT_KEY_INVALID', message: k.message }, 'clientKey');
      return undefined;
    }
    return k.key;
  };

  // ------------------------------------------------------------ projections
  const facetView = (facet) => {
    if (!facet) return null;
    return {
      state: effectiveFacetState(facet, now()),
      storedState: facet.state ?? 'UNVERIFIED',
      reference: facet.reference ?? null,
      memberAssociation: facet.memberAssociation ?? null,
      provenance: facet.provenance ?? null,
      submittedAt: facet.submittedAt ?? null,
      verifiedAt: facet.verifiedAt ?? null,
      recheckAt: facet.recheckAt ?? null,
      note: facet.note ?? null,
    };
  };
  const profileView = (p) => {
    if (!p) return null;
    const fifa = facetView(p.facets?.fifa_licence);
    const national = Object.fromEntries(
      Object.entries(p.facets?.national_registration ?? {}).map(([k, v]) => [k, facetView(v)]),
    );
    const domestic = Object.fromEntries(
      Object.entries(p.facets?.domestic_authorisation ?? {}).map(([k, v]) => [k, facetView(v)]),
    );
    const minors = Object.fromEntries(
      Object.entries(p.facets?.minors_authorisation ?? {}).map(([k, v]) => [k, facetView(v)]),
    );
    return {
      id: p.id,
      userId: p.userId,
      agencyOrgId: p.agencyOrgId,
      displayName: p.displayName,
      declared: p.declared ?? {},
      facets: {
        fifa_licence: fifa,
        national_registration: national,
        domestic_authorisation: domestic,
        minors_authorisation: minors,
      },
      regulatoryState: {
        fifaLicence: fifa?.state ?? 'UNVERIFIED',
        jurisdictions: (p.declared?.jurisdictions ?? []).map((ma) => ({
          memberAssociation: ma,
          nationalRegistration: national[ma]?.state ?? 'UNVERIFIED',
          domesticAuthorisation: domestic[ma]?.state ?? 'UNVERIFIED',
          minorsAuthorisation: minors[ma]?.state ?? 'UNVERIFIED',
          regulatedActionsPermitted: !verificationGap(p, ma, now()),
        })),
      },
      policyVersion: AGENT_POLICY_VERSION,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ...revMeta(p),
      history: (p.history ?? []).map((h) => ({ id: h.id, at: h.at, action: h.action, detail: h.detail ?? null })),
      honest:
        'Verification states are derived from recorded provenance. A licence number you typed is a declaration, not a verified licence. No FIFA, FA or U.S. Soccer register integration exists in this build.',
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
    const minimal = {
      id: player.id,
      name: player.name,
      position: view.position ?? null,
      age: view.age ?? null,
      club: view.club ?? view.currentClub ?? null,
      country: view.country ?? null,
    };
    if (agreementGrantsAccess(agreement, req.orgUser.id, now()))
      return { ...view, id: player.id, name: player.name, accessBasis: 'active_confirmed_relationship' };
    return { ...minimal, accessBasis: st === 'proposed' ? 'pending_request' : 'none' };
  }

  // ============================================================ ORG: me / home
  orgRouter.get('/agent/me', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const p = profileOf(req.orgUser.id);
    res.json({
      user: { id: req.orgUser.id, name: req.orgUser.name, role: req.orgUser.role },
      org: orgSafe(req.org),
      affiliation: {
        id: req.affiliation.id,
        tiers: req.tiers,
        startedAt: req.affiliation.startedAt,
        ...revMeta(req.affiliation),
      },
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
          // The sweep, not this read, sends the one notification per agreement.
        }
      } else if (st === 'proposed') counts.pending += 1;
      else if (st === 'disputed') {
        counts.disputed += 1;
        alerts.push({ kind: 'disputed', agreementId: a.id });
      } else if (st === 'expired') counts.expired += 1;
    }
    const fifa = p ? effectiveFacetState(p.facets?.fifa_licence, t) : 'UNVERIFIED';
    if (fifa !== 'VERIFIED') alerts.push({ kind: 'verification', facet: 'fifa_licence', state: fifa });
    for (const ma of p?.declared?.jurisdictions ?? []) {
      const gap = verificationGap(p, ma, t);
      if (gap) alerts.push({ kind: 'jurisdiction', memberAssociation: ma, facet: gap.facet, state: gap.state });
    }
    const unread = notifications.unreadCount('org_user', me);
    res.json({
      profileState: fifa,
      hasProfile: !!p,
      tiers: req.tiers,
      counts,
      alerts,
      unreadNotifications: unread,
      regulatoryNotice:
        'ScoutBox is infrastructure. It performs no football-agent services, adjudicates no conflicts and confirms no regulatory status. Relationship records here are confirmed by the client, not by ScoutBox.',
    });
  });

  // ============================================================ ORG: profile
  orgRouter.get('/agent/profile', (req, res) => {
    if (!resolveMembership(req, res)) return;
    res.json({
      profile: profileView(profileOf(req.orgUser.id)),
      states: VERIFICATION_STATES,
      facets: FACETS,
      jurisdictions: JURISDICTIONS,
    });
  });

  orgRouter.post('/agent/profile', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'profile.write.own')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const b = inputOr400(res, 'profile', req.body);
    if (!b) return;
    const displayName = given(b.displayName);
    if (displayName === null)
      return sendAgentError(
        res,
        {
          error: 'AGENT_INPUT_INVALID',
          field: 'displayName',
          problem: 'blank',
          message: 'displayName must not be empty.',
        },
        'profile',
      );
    const { jurisdictions } = b;
    const licenceNumber = given(b.fifaLicenceNumber);
    const p = profileOf(req.orgUser.id);
    if (!p) {
      const created = unit(() => {
        const draft = {
          id: nextId('agp'),
          userId: req.orgUser.id,
          agencyOrgId: req.org.id,
          displayName: displayName ?? String(req.orgUser.name ?? '').slice(0, LIM.displayName),
          declared: { fifaLicenceNumber: licenceNumber ?? null, jurisdictions: jurisdictions ?? [] },
          facets: newFacets(),
          createdAt: now(),
          updatedAt: now(),
          rev: 1,
          revAt: now(),
          revBy: null,
          history: [],
        };
        hist(draft, 'agent_profile_created', byOrg(req));
        const out = profiles.create(draft);
        broadcast('agent_profile_created', { orgId: req.org.id, userId: out.userId });
        return out;
      });
      return res.status(201).json({ profile: profileView(created) });
    }
    if (!guardRev(req, res, p, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: {} })) return;
    const updated = unit(() => {
      const declared = {};
      const history = [];
      if (displayName !== undefined && displayName !== p.displayName) declared.displayName = displayName;
      if (jurisdictions !== undefined) declared.jurisdictions = jurisdictions;
      if (licenceNumber !== undefined && licenceNumber !== p.declared.fifaLicenceNumber) {
        declared.fifaLicenceNumber = licenceNumber;
        // The verified reference is no longer the declared one.
        const licence = p.facets.fifa_licence;
        if (licence.state === 'VERIFIED' && licence.reference !== licenceNumber) {
          profiles.setFacet(p.id, {
            facet: 'fifa_licence',
            record: {
              ...licence,
              state: 'UNVERIFIED',
              note: 'The declared licence number changed; re-submit for verification.',
            },
          });
          history.push(
            entry('agent_verification_state_changed', byOrg(req), {
              facet: 'fifa_licence',
              memberAssociation: null,
              from: 'VERIFIED',
              to: 'UNVERIFIED',
              state: 'UNVERIFIED',
            }),
          );
          broadcast('agent_verification_state_changed', {
            orgId: req.org.id,
            userId: p.userId,
            facet: 'fifa_licence',
            state: 'UNVERIFIED',
          });
        }
      }
      history.push(
        entry('agent_profile_updated', byOrg(req), {
          fields: PROFILE_FIELDS.filter((f) => Object.hasOwn(declared, f)),
        }),
      );
      return profiles.updateDeclared(p.id, declared, { at: now(), touch: true, ...bumped(req.orgUser), history });
    });
    res.status(200).json({ profile: profileView(updated) });
  });

  /** With no register provider in production, a submission goes to attributed Trust & Safety review. */
  orgRouter.post('/agent/profile/facets/:facet/submit', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'verification.submit')) return;
    if (limitedOr429(res, 'agent_profile_write', req.orgUser.id)) return;
    const facet = req.params.facet;
    if (!FACETS.includes(facet)) return sendAgentError(res, { error: 'AGENT_FACET_INVALID', allowed: FACETS }, 'facet');
    const p = profileOf(req.orgUser.id);
    if (!p)
      return sendAgentError(
        res,
        { error: 'AGENT_PROFILE_REQUIRED', message: 'Create your agent profile first.' },
        'facet',
      );
    const b = inputOr400(res, 'facetSubmission', req.body);
    if (!b) return;
    const reference = filled(b.reference);
    if (!reference)
      return sendAgentError(
        res,
        { error: 'AGENT_INPUT_INVALID', field: 'reference', problem: 'required', message: 'A reference is required.' },
        'facet',
      );
    const ma = facet === 'fifa_licence' ? null : (filled(b.memberAssociation)?.toUpperCase() ?? '');
    // A national facet belongs to a member association; INT is FIFA level, not one.
    if (facet !== 'fifa_licence' && (ma === 'INT' || !JURISDICTIONS.includes(ma)))
      return sendAgentError(
        res,
        { error: 'AGENT_JURISDICTION_INVALID', allowed: JURISDICTIONS.filter((j) => j !== 'INT') },
        'facet',
      );
    // Minors authorisation is recorded, never activated: no minors pathway exists.
    // A provider adds UNAVAILABLE, which writes nothing and answers 503: an outage is never a permission.
    const outcome = verificationProvider
      ? verificationProvider[FACET_METHOD[facet]]({ reference, now: now() })
      : evaluateSubmission({ facet, reference, testProviderEnabled, now: now() });
    if (outcome.state === 'UNAVAILABLE')
      return sendAgentError(
        res,
        {
          error: 'REGULATORY_PROVIDER_UNAVAILABLE',
          retryAfter: 300,
          message:
            'The verification source is unavailable. Nothing was recorded; try again later or the reference will be queued for attributed review when the source answers.',
        },
        'facet',
      );
    const next = verificationProvider
      ? facetFromProviderAnswer(outcome, { reference, memberAssociation: ma, now: now() })
      : {
          state: outcome.state,
          reference,
          memberAssociation: ma,
          provenance: outcome.provenance,
          submittedAt: now(),
          verifiedAt: outcome.verifiedAt,
          recheckAt: outcome.recheckAt,
          note: outcome.note,
        };
    const prev = facet === 'fifa_licence' ? p.facets.fifa_licence : p.facets[facet]?.[ma];
    const changed = (prev?.state ?? 'UNVERIFIED') !== next.state;
    const updated = unit(() => {
      const out = profiles.setFacet(
        p.id,
        { facet, memberAssociation: ma, record: next },
        {
          at: now(),
          touch: true,
          ...bumped(req.orgUser),
          history: [
            entry('agent_verification_submitted', byOrg(req), { facet, memberAssociation: ma }),
            ...(changed
              ? [
                  entry('agent_verification_state_changed', byOrg(req), {
                    facet,
                    memberAssociation: ma,
                    from: prev?.state ?? 'UNVERIFIED',
                    to: next.state,
                    state: next.state,
                  }),
                ]
              : []),
          ],
        },
      );
      if (next.state === 'MANUAL_REVIEW_REQUIRED')
        compliance.facetNeedsReview(out, { facet, memberAssociation: ma, reference }, byOrg(req));
      if (changed) {
        broadcast('agent_verification_state_changed', {
          orgId: req.org.id,
          userId: out.userId,
          facet,
          state: next.state,
        });
        if (next.state === 'VERIFIED' || next.state === 'INACTIVE' || next.state === 'MANUAL_REVIEW_REQUIRED') {
          notify(
            { kind: 'org_user', id: out.userId },
            'agent_verification',
            `Verification facet ${facet}${ma ? ` (${ma})` : ''} is now ${next.state.replace(/_/g, ' ').toLowerCase()}.`,
            out.id,
          );
        }
      }
      return out;
    });
    res.json({
      profile: profileView(updated),
      facet: facetView(next),
      provider: testProviderEnabled ? 'local-synthetic-test-provider' : 'none',
    });
  });

  // ============================================================ ORG: agency
  const memberRows = (org) =>
    affiliations
      .forAgency(org.id)
      .map((a) => {
        const u = byId.user(a.userId);
        const p = profileOf(a.userId);
        return {
          affiliationId: a.id,
          userId: a.userId,
          name: u?.name ?? null,
          role: u?.role ?? null,
          tiers: tiersOf(a),
          active: affiliationActive(a, now()),
          startedAt: a.startedAt,
          endedAt: a.endedAt ?? null,
          endedReason: a.endedReason ?? null,
          licensed: !!p,
          fifaLicence: p ? effectiveFacetState(p.facets?.fifa_licence, now()) : null,
          ...revMeta(a),
        };
      })
      .sort((x, y) => (x.active === y.active ? x.startedAt - y.startedAt : x.active ? -1 : 1));

  orgRouter.get('/agent/agency', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const members = memberRows(req.org);
    const active = members.filter((m) => m.active);
    const rels = agreementsOfAgency(req.org.id);
    res.json({
      org: orgSafe(req.org),
      settings: settings.forOrg(req.org.id),
      members: {
        active: active.length,
        admins: active.filter((m) => m.tiers.includes('agency_admin')).length,
        licensedAgents: active.filter((m) => m.tiers.includes('licensed_agent')).length,
      },
      relationships: {
        active: rels.filter((a) => effectiveAgreementStatus(a, now()) === 'active').length,
        pending: rels.filter((a) => effectiveAgreementStatus(a, now()) === 'proposed').length,
      },
      tiers: TIERS,
      permissions: PERMISSIONS,
      honest:
        'An agency organisation holds no football-agent licence. Roles here decide what a member may do in ScoutBox, never whether they may perform football-agent services.',
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
    const b = inputOr400(res, 'newMember', req.body);
    if (!b) return;
    const name = filled(b.name);
    if (!name)
      return sendAgentError(
        res,
        { error: 'AGENT_INPUT_INVALID', field: 'name', problem: 'required', message: 'A name is required.' },
        'team',
      );
    const { tiers } = b;
    const role = given(b.role);
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const fp = payloadFingerprint({ name: name.toLowerCase(), tiers });
    if (key) {
      const hit = affiliations.byCreateKey(req.org.id, key);
      if (hit) {
        if (hit.keys.create.fp === fp)
          return res
            .status(200)
            .json({ member: memberRows(req.org).find((m) => m.affiliationId === hit.id), idempotent: true });
        return sendAgentError(res, { error: 'AFFILIATION_IDEMPOTENCY_CONFLICT' }, 'team');
      }
    }
    const user = users.byOrgAndName(req.org.id, name);
    if (user?.removedAt)
      return sendAgentError(
        res,
        {
          error: 'AGENT_ACTION_NOT_PERMITTED',
          message: "This person's access was removed; removal is not undone from the team page.",
        },
        'team',
      );
    if (user && activeAffiliationOf(user.id, req.org.id))
      return sendAgentError(res, { error: 'MEMBER_ALREADY_AFFILIATED' }, 'team');
    const aff = unit(() => {
      const member = user ?? users.create({ orgId: req.org.id, name, role: role ?? 'Agency staff', createdAt: now() });
      const draft = {
        id: nextId('aff'),
        agencyOrgId: req.org.id,
        userId: member.id,
        tiers,
        startedAt: now(),
        endedAt: null,
        endedReason: null,
        createdAt: now(),
        rev: 1,
        revAt: now(),
        revBy: null,
        keys: key ? { create: { key, fp } } : {},
        history: [],
      };
      hist(draft, 'agency_affiliation_created', byOrg(req), { tiers });
      const out = affiliations.create(draft);
      broadcast('agency_affiliation_created', { orgId: req.org.id, userId: member.id });
      notify(
        { kind: 'org_user', id: member.id },
        'agency_membership',
        `You were added to ${req.org.name} (${tiers.join(', ')}).`,
        out.id,
      );
      return out;
    });
    res.status(201).json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.patch('/agent/agency/team/:userId', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const aff = activeAffiliationOf(req.params.userId, req.org.id);
    if (!aff) return sendAgentError(res, { error: 'MEMBER_NOT_FOUND' }, 'team');
    const b = inputOr400(res, 'memberTiers', req.body);
    if (!b) return;
    const { tiers } = b;
    const problem = affiliationChangeProblem({
      affiliations: affiliations.forAgency(req.org.id),
      target: aff,
      actorUserId: req.orgUser.id,
      nextTiers: tiers,
      now: now(),
    });
    if (problem)
      return sendAgentError(
        res,
        {
          error: problem,
          message:
            problem === 'LAST_ADMIN'
              ? 'An agency must keep at least one administrator.'
              : 'You cannot grant yourself the administrator role.',
        },
        'team',
      );
    if (!guardRev(req, res, aff, { errorCode: 'AFFILIATION_VERSION_CONFLICT', current: { tiers: tiersOf(aff) } }))
      return;
    unit(() =>
      affiliations.setTiers(
        aff.id,
        { tiers },
        {
          ...bumped(req.orgUser),
          history: [entry('agency_affiliation_updated', byOrg(req), { from: tiersOf(aff), to: tiers, tiers })],
        },
      ),
    );
    res.json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.post('/agent/agency/team/:userId/end', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.team.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const aff = activeAffiliationOf(req.params.userId, req.org.id);
    if (!aff) return sendAgentError(res, { error: 'MEMBER_NOT_FOUND' }, 'team');
    const b = inputOr400(res, 'memberEnd', req.body);
    if (!b) return;
    const reason = given(b.reason);
    const problem = affiliationChangeProblem({
      affiliations: affiliations.forAgency(req.org.id),
      target: aff,
      actorUserId: req.orgUser.id,
      nextTiers: [],
      now: now(),
      ending: true,
    });
    if (problem)
      return sendAgentError(
        res,
        { error: problem, message: 'An agency must keep at least one administrator.' },
        'team',
      );
    if (!guardRev(req, res, aff, { errorCode: 'AFFILIATION_VERSION_CONFLICT', current: {} })) return;
    unit(() => {
      affiliations.end(
        aff.id,
        { at: now(), reason: reason ?? 'left' },
        {
          ...bumped(req.orgUser),
          history: [entry('agency_affiliation_ended', byOrg(req), { reasonCode: reason ?? 'left' })],
        },
      );
      broadcast('agency_affiliation_ended', { orgId: req.org.id, userId: aff.userId });
      // The person's agent profile and historical attributions stay as they are.
      const user = byId.user(aff.userId);
      if (user && !user.removedAt) users.remove(user.id, { at: now(), by: req.orgUser.id });
      revokeOrgUserAccess?.(aff.userId);
    });
    res.json({ member: memberRows(req.org).find((m) => m.affiliationId === aff.id) });
  });

  orgRouter.patch('/agent/agency/settings', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.settings.write')) return;
    if (limitedOr429(res, 'agent_affiliation_write', req.org.id)) return;
    const b = inputOr400(res, 'settings', req.body);
    if (!b) return;
    const current = settings.forOrg(req.org.id);
    const jurisdictions = b.jurisdictions ?? [...current.jurisdictions];
    let description = current.description;
    if (b.description !== undefined) {
      const d = b.description ?? '';
      if (d && !moderateOrRefuse(res, d, { kind: 'agency_settings', orgId: req.org.id })) return;
      description = d;
    }
    const saved = unit(() => settings.save(req.org.id, { jurisdictions, description }));
    res.json({ settings: saved });
  });

  orgRouter.get('/agent/agency/compliance', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.compliance.read')) return;
    const rows = memberRows(req.org)
      .filter((m) => m.active && m.tiers.includes('licensed_agent'))
      .map((m) => {
        const p = profileOf(m.userId);
        const v = profileView(p);
        return {
          userId: m.userId,
          name: m.name,
          hasProfile: !!p,
          fifaLicence: v?.regulatoryState.fifaLicence ?? 'UNVERIFIED',
          jurisdictions: v?.regulatoryState.jurisdictions ?? [],
        };
      });
    res.json({
      agents: rows,
      informational: true,
      honest:
        'Informational only. Nothing here verifies, approves or overrides a regulatory state; attributed Trust & Safety review of agent licences is not available yet (G-C0).',
    });
  });

  orgRouter.get('/agent/agency/audit', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'agency.audit.read')) return;
    const q = inputOr400(res, 'auditQuery', req.query, 'query');
    if (!q) return;
    const all = agentAuditRows(agentCore.reads, req.org, { findPlayer, orgCanSee });
    for (const rowsOf of auditSources) all.push(...rowsOf(req.org));
    all.sort((a, b) => b.at - a.at || String(b.id).localeCompare(String(a.id)));
    const limit = q.limit === undefined ? 25 : Number(q.limit);
    let start = 0;
    if (q.cursor) {
      const idx = all.findIndex((r) => r.id === q.cursor);
      if (idx < 0) return res.status(400).json({ error: 'AUDIT_CURSOR_INVALID' });
      start = idx + 1;
    }
    const page = all.slice(start, start + limit);
    res.json({
      items: page,
      nextCursor: start + limit < all.length ? page[page.length - 1].id : null,
      total: all.length,
    });
  });

  // ============================================================ ORG: players lookup
  orgRouter.get('/agent/players', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'players.lookup')) return;
    const query = inputOr400(res, 'playerLookup', req.query, 'query');
    if (!query) return;
    if (limitedOr429(res, 'agent_player_lookup', req.orgUser.id)) return;
    const q = (query.q ?? '').trim().toLowerCase();
    if (q.length < 2) return res.json({ items: [], note: 'Type at least two characters.' });
    const items = [];
    // Adults and the visibility rule's SQL part are in the query, a batch at a time, stopping at twenty.
    players.scan({ visibleTo: req.org, adultsOnly: true }, (p) => {
      if (!isAdult(p)) return true; // minors never appear, whatever the query
      if (!visibleToOrg(p, req.org) || isBlocked(p.id, req.org.id)) return true;
      if (
        !String(p.name ?? '')
          .toLowerCase()
          .includes(q)
      )
        return true;
      const view = playerViewForOrg(p, req.org) ?? {};
      items.push({
        id: p.id,
        name: p.name,
        position: view.position ?? null,
        age: view.age ?? null,
        club: view.club ?? view.currentClub ?? null,
        country: view.country ?? null,
      });
      return items.length < 20;
    });
    res.json({ items, adultsOnly: true });
  });

  // ============================================================ ORG: clients
  function visibleAgreementsFor(req) {
    const me = req.orgUser.id;
    const rows = [];
    for (const a of agreementsOfAgency(req.org.id)) {
      if (a.agentUserId === me && can(req.tiers, 'clients.read.own')) rows.push({ a, mode: 'own' });
      else if (can(req.tiers, 'clients.read.shared_summary') && a.shareWithAgencyStaff)
        rows.push({ a, mode: 'summary' });
    }
    return rows;
  }
  const listRow = (req, { a, mode }) => {
    if (mode === 'summary') {
      const player = findPlayer(a.clientId);
      const name = player && orgCanSee(req.org, player) ? player.name : null;
      return { ...agreementSummaryForStaff(a, now()), client: { id: a.clientId, name } };
    }
    return { ...agreementForAgent(a, now()), client: clientIdentity(a, req), mode: 'own' };
  };

  orgRouter.get('/agent/clients', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const rows = visibleAgreementsFor(req)
      .map((r) => listRow(req, r))
      .sort((x, y) => (y.proposedAt ?? y.startAt ?? 0) - (x.proposedAt ?? x.startAt ?? 0));
    res.json({ items: rows, scopes: SCOPES, maxTermMonths: MAX_TERM_MONTHS, jurisdictions: JURISDICTIONS });
  });

  /** An approach is a regulated act, so the agent's required facets must be VERIFIED (by an attributed reviewer, G-C0). */
  orgRouter.post('/agent/clients/request', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.request')) return;
    const b = inputOr400(res, 'clientRequest', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const scope = b.scope ?? ['employment'];
    const termMonths = b.termMonths ?? DEFAULT_TERM_MONTHS;
    const jurisdiction = (filled(b.jurisdiction) ?? 'INT').toUpperCase();
    if (!JURISDICTIONS.includes(jurisdiction))
      return sendAgentError(
        res,
        { error: 'AGENT_JURISDICTION_INVALID', field: 'jurisdiction', problem: 'not_allowed', allowed: JURISDICTIONS },
        'request',
      );
    const exclusive = b.exclusive === true;
    const playerId = b.playerId ?? '';
    const fp = payloadFingerprint({ playerId, scope, termMonths, jurisdiction, exclusive });
    if (key) {
      const hit = agreements.byRequestKey(req.org.id, req.orgUser.id, key);
      if (hit) {
        if (hit.keys.request.fp === fp)
          return res.status(200).json({
            relationship: { ...agreementForAgent(hit, now()), client: clientIdentity(hit, req) },
            idempotent: true,
          });
        return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, 'request');
      }
    }
    // Verification (own state) comes before the subject check, so a refused agent learns nothing about the subject;
    // a missing, minor, blocked and invisible player then answer alike.
    const gap = verificationGap(profileOf(req.orgUser.id), jurisdiction, now());
    if (gap)
      return sendAgentError(
        res,
        {
          ...gap,
          message:
            gap.error === 'AGENT_PROFILE_REQUIRED'
              ? 'Create your agent profile first.'
              : `A regulated action needs a VERIFIED ${gap.facet}${gap.memberAssociation ? ` (${gap.memberAssociation})` : ''}; it is ${gap.state}.`,
        },
        'request',
      );
    // The quota counts attempts that reach a subject (solicitation and enumeration), not the agent's own refusals.
    if (limitedOr429(res, 'agent_representation_request', req.orgUser.id)) return;
    const player = findPlayer(playerId);
    if (!player || !isAdult(player) || !visibleToOrg(player, req.org) || isBlocked(player.id, req.org.id)) {
      return sendAgentError(res, { error: 'PLAYER_NOT_FOUND' }, 'request');
    }
    const conflict = requestConflict(agreements.forAgentClient(req.orgUser.id, player.id), {
      agentUserId: req.orgUser.id,
      playerId: player.id,
      now: now(),
    });
    if (conflict)
      return sendAgentError(
        res,
        {
          ...conflict,
          message:
            conflict.error === 'REPRESENTATION_COOLDOWN'
              ? 'A recent request to this player was declined or ended; wait before asking again.'
              : 'A relationship with this player already exists or is pending.',
        },
        'request',
      );
    // The policy layer has the last word: the exclusive-agreement window is under legal review, so it goes to
    // attributed review rather than a block, and never names the other agent.
    const { decision, policySet } = compliance.authorizeApproach({
      profile: profileOf(req.orgUser.id),
      jurisdiction,
      player,
      agentUserId: req.orgUser.id,
    });
    const policyVersions = policySet.policies.map((x) => x.id);
    if (decision.facetGaps.length) {
      const g = decision.facetGaps[0];
      return sendAgentError(
        res,
        {
          error: g.code,
          facet: g.facet,
          memberAssociation: g.memberAssociation,
          state: g.state,
          message: `A regulated action needs a VERIFIED ${g.facet}${g.memberAssociation ? ` (${g.memberAssociation})` : ''}; it is ${g.state}.`,
        },
        'request',
      );
    }
    if (decision.blocked)
      return sendAgentError(
        res,
        {
          error: 'AGENT_ACTION_NOT_PERMITTED',
          reasons: decision.reasons.filter((r) => r.code !== 'FACET_VERIFIED'),
          policyVersions,
          message: 'An ACTIVE encoded rule does not permit this approach.',
        },
        'request',
      );
    if (decision.requiresManualReview) {
      const unsupported = decision.reasons.some((r) => r.code === 'POLICY_NOT_ENCODED');
      const review = compliance.createApproachReview({ req, decision, playerId: player.id, jurisdiction });
      return sendAgentError(
        res,
        {
          error: unsupported ? 'JURISDICTION_UNSUPPORTED' : 'REGULATORY_REVIEW_REQUIRED',
          reviewId: review?.id ?? undefined,
          reasons: decision.reasons.filter((r) => r.code !== 'FACET_VERIFIED'),
          policyVersions,
          message: unsupported
            ? 'No encoded policy covers this jurisdiction; the request cannot proceed.'
            : "The deciding rule's operative status is uncertain. The request was not sent; an attributed Trust & Safety review item records the question.",
        },
        'request',
      );
    }
    const agentName = profileOf(req.orgUser.id)?.displayName ?? req.orgUser.name;
    const a = unit(() => {
      const draft = {
        id: nextId('rep'),
        agentUserId: req.orgUser.id,
        agencyOrgId: req.org.id,
        clientKind: 'player',
        clientId: player.id,
        isRegulatoryMinor: false,
        jurisdiction,
        scope,
        exclusive,
        termMonths,
        startAt: null,
        endAt: null,
        status: 'proposed',
        proposedAt: now(),
        confirmedAt: null,
        confirmedBy: null,
        declinedAt: null,
        terminatedAt: null,
        terminatedBy: null,
        terminationReasonCode: null,
        disputedAt: null,
        disputeReason: null,
        shareWithAgencyStaff: false,
        policyVersions,
        keys: key ? { request: { key, fp } } : {},
        createdAt: now(),
        rev: 1,
        revAt: now(),
        revBy: null,
        history: [],
      };
      hist(draft, 'representation_requested', byOrg(req), { scope, termMonths, jurisdiction, policyVersions });
      const out = agreements.create(draft);
      broadcast('representation_requested', { orgId: req.org.id, agreementId: out.id, agentUserId: out.agentUserId });
      notify(
        { kind: 'player', id: player.id },
        'representation_request',
        `${agentName} (${req.org.name}) asks to represent you (${scope.join(', ')}, ${termMonths} months). Nothing is active until YOU confirm it in My Agent.`,
        out.id,
      );
      return out;
    });
    res.status(201).json({ relationship: { ...agreementForAgent(a, now()), client: clientIdentity(a, req) } });
  });

  orgRouter.get('/agent/clients/:id', (req, res) => {
    if (!resolveMembership(req, res)) return;
    const found = findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res.json({ relationship: listRow(req, { a: found.a, mode: 'summary' }), mode: 'summary' });
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
    if (!found || found.summaryOnly) {
      if (found?.summaryOnly) sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'terminate');
      return;
    }
    const a = found;
    const b = inputOr400(res, 'agentTermination', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const reasonCode = filled(b.reasonCode) ?? 'agent_ended';
    const fp = payloadFingerprint({ reasonCode });
    if (key && a.keys.agentTerminate?.key === key) {
      if (a.keys.agentTerminate.fp === fp)
        return res.json({ relationship: agreementForAgent(a, now()), idempotent: true });
      return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, 'terminate');
    }
    if (!agentTransitionAllowed(a, 'terminated_by_agent', now()))
      return sendAgentError(
        res,
        { error: 'REPRESENTATION_NOT_ACTIVE', status: effectiveAgreementStatus(a, now()) },
        'terminate',
      );
    if (
      !guardRev(req, res, a, {
        errorCode: 'REPRESENTATION_VERSION_CONFLICT',
        current: { status: effectiveAgreementStatus(a, now()) },
      })
    )
      return;
    const phase = effectiveAgreementStatus(a, now());
    const updated = unit(() => {
      const out = agreements.terminateByAgent(
        a.id,
        { at: now(), reasonCode, key: key ? { key, fp } : null },
        {
          ...bumped(req.orgUser),
          history: [entry('representation_terminated', byOrg(req), { by: 'agent', phase, reasonCode })],
        },
      );
      broadcast('representation_terminated', { orgId: req.org.id, agreementId: out.id, agentUserId: out.agentUserId });
      notify(
        { kind: 'player', id: out.clientId },
        'representation_terminated',
        phase === 'proposed'
          ? 'An agent withdrew their representation request.'
          : 'Your agent ended the representation relationship. The record stays in your history.',
        out.id,
      );
      return out;
    });
    res.json({ relationship: agreementForAgent(updated, now()) });
  });

  orgRouter.get('/agent/clients/:id/opportunities', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.opportunities.read')) return;
    const found = findOwnAgreement(req, res, req.params.id);
    if (!found || found.summaryOnly) {
      if (found?.summaryOnly) sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'opps');
      return;
    }
    const a = found;
    const player = findPlayer(a.clientId);
    if (!agreementGrantsAccess(a, req.orgUser.id, now()) || !player || !orgCanSee(req.org, player)) {
      return sendAgentError(
        res,
        { error: 'REPRESENTATION_NOT_ACTIVE', status: effectiveAgreementStatus(a, now()) },
        'opps',
      );
    }
    const items = opportunityBoardFor(ctx.grassrootsReads, player, {
      orgCanSee,
      checkEligibility,
      distanceBand,
      scoutingReads: ctx.scoutingReads,
      orgOf: byId.org,
    }).map((o) => ({
      id: o.id,
      via: o.via,
      type: o.type,
      orgId: o.orgId,
      orgName: o.orgName,
      title: o.title,
      deadline: o.deadline,
      schedule: o.schedule ?? null,
      category: o.category ?? null,
      distance: o.distance ?? null,
      applied: o.applied ?? null,
    }));
    res.json({
      items,
      clientId: player.id,
      note: "The client's own board, read through the same mutual-visibility and eligibility rules the player sees. Applying is the player's act.",
    });
  });

  orgRouter.get('/agent/opportunities', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'clients.opportunities.read')) return;
    const items = [];
    for (const a of agreementsOfAgency(req.org.id)) {
      if (!agreementGrantsAccess(a, req.orgUser.id, now())) continue;
      const player = findPlayer(a.clientId);
      if (!player || !orgCanSee(req.org, player)) continue;
      for (const o of opportunityBoardFor(ctx.grassrootsReads, player, {
        orgCanSee,
        checkEligibility,
        distanceBand,
        scoutingReads: ctx.scoutingReads,
        orgOf: byId.org,
      })) {
        items.push({
          id: o.id,
          via: o.via,
          type: o.type,
          orgId: o.orgId,
          orgName: o.orgName,
          title: o.title,
          deadline: o.deadline,
          category: o.category ?? null,
          distance: o.distance ?? null,
          applied: o.applied ?? null,
          clientId: player.id,
          clientName: player.name,
          agreementId: a.id,
        });
      }
    }
    items.sort((x, y) => String(x.deadline).localeCompare(String(y.deadline)));
    res.json({
      items,
      note: 'Only opportunities legitimately visible to a confirmed client appear here. Club-private recruitment cases never do.',
    });
  });

  orgRouter.get('/agent/inbox', (req, res) => {
    if (!resolveMembership(req, res)) return;
    if (!requireCap(req, res, 'inbox.read')) return;
    const me = req.orgUser.id;
    const inbox = notifications.forAudience('org_user', me, { limit: 100 }).map(feedItem); // the newest 100, newest insertion first; each an allowlist
    const pending = agreementsOfAgency(req.org.id)
      .filter((a) => a.agentUserId === me && effectiveAgreementStatus(a, now()) === 'proposed')
      .map((a) => ({ ...agreementForAgent(a, now()), client: clientIdentity(a, req) }));
    res.json({
      notifications: inbox,
      pending,
      note: 'Operational messages only. Negotiation and offers are not part of this workspace.',
    });
  });

  // ============================================================ PLAYER: My Agent
  const agentIdentityForClient = (a) => {
    const user = a.agentUserId ? byId.user(a.agentUserId) : null;
    const p = a.agentUserId ? profileOf(a.agentUserId) : null;
    const org = byId.org(a.agencyOrgId);
    const fifa = p ? effectiveFacetState(p.facets?.fifa_licence, now()) : null;
    return {
      userId: a.agentUserId,
      displayName: p?.displayName ?? user?.name ?? null,
      agency: org ? { id: org.id, name: org.name } : null,
      verification: p
        ? {
            fifaLicence: fifa,
            jurisdictions: (p.declared?.jurisdictions ?? []).map((ma) => ({
              memberAssociation: ma,
              nationalRegistration: effectiveFacetState(p.facets?.national_registration?.[ma], now()),
            })),
          }
        : null,
      honest:
        fifa === 'VERIFIED'
          ? 'Verified against recorded provenance; check the provenance before relying on it.'
          : "This agent's licence is NOT verified in ScoutBox.",
    };
  };

  playerRouter.get('/agent/relationships', (req, res) => {
    if (req.playerIsMinor)
      return res.json({
        items: [],
        minor: true,
        note: 'Agent representation is not available for under-18 accounts in ScoutBox.',
      });
    const items = agreements
      .forClient(req.player.id)
      .map((a) => ({ ...agreementForClient(a, now()), agent: agentIdentityForClient(a) }))
      .sort((x, y) => (y.proposedAt ?? 0) - (x.proposedAt ?? 0));
    res.json({
      items,
      note: 'Nothing is active until you confirm it. You can end an active relationship at any time; the record stays in your history.',
    });
  });

  function clientMutation(req, res, to, { reasonField = null, notifyType, notifyText, event, action } = {}) {
    if (req.playerIsMinor)
      return sendAgentError(
        res,
        {
          error: 'AGENT_ACTION_NOT_PERMITTED',
          message: 'Guardian-managed accounts cannot hold agent relationships in ScoutBox.',
        },
        action,
      );
    if (limitedOr429(res, 'agent_client_response', req.player.id)) return;
    const found = typeof req.params.id === 'string' ? agreements.byId(req.params.id) : null;
    const a = found && found.clientId === req.player.id ? found : null;
    if (!a) return sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, action);
    const b = inputOr400(res, reasonField ? 'playerDispute' : 'playerAnswer', req.body);
    if (!b) return;
    const key = clientKeyOr400(b, res);
    if (key === undefined) return;
    const reason = reasonField ? filled(b[reasonField]) : null;
    if (
      reason &&
      !moderateOrRefuse(res, reason, { kind: 'representation', playerId: req.player.id, orgId: a.agencyOrgId })
    )
      return;
    const fp = payloadFingerprint({ to, reason });
    if (key && a.keys[action]?.key === key) {
      if (a.keys[action].fp === fp)
        return res.json({
          relationship: { ...agreementForClient(a, now()), agent: agentIdentityForClient(a) },
          idempotent: true,
        });
      return sendAgentError(res, { error: 'REPRESENTATION_IDEMPOTENCY_CONFLICT' }, action);
    }
    const st = effectiveAgreementStatus(a, now());
    if (!clientTransitionAllowed(a, to, now())) {
      const code =
        to === 'active' && st !== 'proposed'
          ? 'REPRESENTATION_NOT_ACTIVE'
          : st === 'disputed'
            ? 'REPRESENTATION_DISPUTED'
            : 'REPRESENTATION_NOT_ACTIVE';
      return sendAgentError(
        res,
        {
          error: code,
          status: st,
          message:
            to === 'active'
              ? 'This request is no longer open — the agent may have withdrawn it.'
              : 'This relationship is not in a state that allows that.',
        },
        action,
      );
    }
    // A block against the agency ends solicitation, so confirming through it is refused.
    if (to === 'active' && isBlocked(req.player.id, a.agencyOrgId))
      return sendAgentError(
        res,
        {
          error: 'REPRESENTATION_NOT_ACTIVE',
          status: st,
          message: 'You have blocked this agency. Lift the block first if you want to confirm.',
        },
        action,
      );
    if (!guardRev(req, res, a, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: { status: st } })) return;
    const t = now();
    const updated = unit(() => {
      const actionOf =
        event === 'representation_confirmed'
          ? 'representation_confirmed'
          : event === 'representation_rejected'
            ? 'representation_rejected'
            : event === 'representation_disputed'
              ? 'representation_disputed'
              : 'representation_terminated';
      const out = agreements.answerByClient(
        a.id,
        { to, at: t, playerId: req.player.id, reason: reason || null, key: key ? { key, fp } : null, slot: action },
        {
          ...bumped({ id: req.player.id, name: req.player.name }, t),
          history: [{ ...entry(actionOf, byPlayer(req), { from: st, to, by: 'client', hadReason: !!reason }), at: t }],
        },
      );
      // Literal event names: the event registry audit reads call sites textually.
      const ev = { orgId: out.agencyOrgId, agreementId: out.id, agentUserId: out.agentUserId };
      if (event === 'representation_confirmed') broadcast('representation_confirmed', ev);
      else if (event === 'representation_rejected') broadcast('representation_rejected', ev);
      else if (event === 'representation_disputed') broadcast('representation_disputed', ev);
      else broadcast('representation_terminated', ev);
      notify({ kind: 'org_user', id: out.agentUserId }, notifyType, notifyText, out.id);
      // The reason stays with the client; the reviewer sees only that one exists.
      if (to === 'disputed') compliance.representationDisputed(out, byPlayer(req));
      return out;
    });
    res.json({ relationship: { ...agreementForClient(updated, now()), agent: agentIdentityForClient(updated) } });
  }

  playerRouter.post('/agent/relationships/:id/confirm', (req, res) =>
    clientMutation(req, res, 'active', {
      action: 'confirm',
      event: 'representation_confirmed',
      notifyType: 'representation_confirmed',
      notifyText: 'A client confirmed your representation relationship. It is active from now until its end date.',
    }),
  );
  playerRouter.post('/agent/relationships/:id/decline', (req, res) =>
    clientMutation(req, res, 'declined', {
      action: 'decline',
      event: 'representation_rejected',
      notifyType: 'representation_rejected',
      notifyText: 'A player declined your representation request. You cannot ask again for 30 days.',
    }),
  );
  playerRouter.post('/agent/relationships/:id/terminate', (req, res) =>
    clientMutation(req, res, 'terminated_by_client', {
      action: 'terminate',
      event: 'representation_terminated',
      notifyType: 'representation_terminated',
      notifyText:
        'A client ended the representation relationship. Your access to their client workspace has ended; the record stays.',
    }),
  );
  playerRouter.post('/agent/relationships/:id/dispute', (req, res) =>
    clientMutation(req, res, 'disputed', {
      action: 'dispute',
      reasonField: 'reason',
      event: 'representation_disputed',
      notifyType: 'representation_disputed',
      notifyText:
        'A client disputed the representation relationship. Private access is suspended pending attributed Trust & Safety review, which is not yet available in this build.',
    }),
  );

  /**
   * The agency-staff summary choice and the three disclosure choices. Each key is read only when the body carries it,
   * so answering one question does not silently answer the others.
   */
  playerRouter.patch('/agent/relationships/:id/sharing', (req, res) => {
    if (req.playerIsMinor) return sendAgentError(res, { error: 'AGENT_ACTION_NOT_PERMITTED' }, 'sharing');
    const found = typeof req.params.id === 'string' ? agreements.byId(req.params.id) : null;
    const a = found && found.clientId === req.player.id ? found : null;
    if (!a) return sendAgentError(res, { error: 'REPRESENTATION_NOT_FOUND' }, 'sharing');
    // A truthy string or a 1 is refused rather than read as no, which would silently turn off a choice the client
    // was trying to turn on.
    const body = inputOr400(res, 'sharing', req.body);
    if (!body) return;
    if (!guardRev(req, res, a, { errorCode: 'REPRESENTATION_VERSION_CONFLICT', current: {} })) return;

    const changed = {};
    if (body.shareWithAgencyStaff !== undefined && body.shareWithAgencyStaff !== a.shareWithAgencyStaff)
      changed.shareWithAgencyStaff = body.shareWithAgencyStaff;
    if (body.disclosure !== undefined) {
      // Turning a disclosure off is immediate and needs no reason; what was already validly routed stays recorded.
      const current = normaliseDisclosure(a.disclosure);
      for (const k of DISCLOSURE_KEYS)
        if (Object.hasOwn(body.disclosure, k) && body.disclosure[k] !== current[k]) changed[k] = body.disclosure[k];
    }
    let rel = a;
    if (Object.keys(changed).length) {
      rel = unit(() => {
        const disclosure = Object.fromEntries(
          DISCLOSURE_KEYS.filter((k) => Object.hasOwn(changed, k)).map((k) => [k, changed[k]]),
        );
        const out = agreements.setSharing(
          a.id,
          { shareWithAgencyStaff: changed.shareWithAgencyStaff, disclosure },
          {
            ...bumped({ id: req.player.id, name: req.player.name }),
            history: [entry('representation_sharing_changed', byPlayer(req), changed)],
          },
        );
        broadcast('representation_disclosure_changed', {
          orgId: out.agencyOrgId,
          agreementId: out.id,
          agentUserId: out.agentUserId,
        });
        notify(
          { kind: 'org_user', id: out.agentUserId },
          'representation_disclosure',
          'A client changed what they share with you. Open the relationship to see which parts of their record and process you can currently see.',
          out.id,
        );
        return out;
      });
    }
    res.json({
      relationship: { ...agreementForClient(rel, now()), agent: agentIdentityForClient(rel) },
      disclosureKeys: DISCLOSURE_KEYS,
      note: 'Each of these is a separate choice, each starts off, and each can be turned off again at any time. Confirming a relationship does not turn any of them on.',
    });
  });

  // ============================================================ ADMIN: read only
  // The shared key may only look; every decision needs an attributed reviewer (G-C0).
  adminRouter.get('/agent/relationships', (req, res) => {
    const page = pageQuery(req, res);
    if (!page) return;
    const { items, nextCursor } = pageOf(agreements.page(page).rows, page.limit, (r) => r.key);
    res.json({
      items: items.map((r) => ({ ...agreementForAgent(r.record, now()), history: undefined })),
      nextCursor,
      readOnly: true,
      note: 'Read-only. No Trust & Safety action on agent relationships or licences exists in this build (gate G-C0).',
    });
  });
  // States and provenance only: the shared key is not an attributed reviewer, so the declared number and reference
  // are withheld.
  const facetForOversight = (f) =>
    f
      ? {
          state: f.state,
          storedState: f.storedState,
          provenance: f.provenance,
          submittedAt: f.submittedAt,
          verifiedAt: f.verifiedAt,
          recheckAt: f.recheckAt,
        }
      : null;
  adminRouter.get('/agent/profiles', (req, res) => {
    const page = pageQuery(req, res);
    if (!page) return;
    const { items, nextCursor } = pageOf(profiles.page(page).rows, page.limit, (r) => r.key);
    res.json({
      items: items.map(({ record: p }) => {
        const v = profileView(p);
        return {
          id: v.id,
          userId: v.userId,
          agencyOrgId: v.agencyOrgId,
          displayName: v.displayName,
          declaredJurisdictions: v.declared?.jurisdictions ?? [],
          facets: {
            fifa_licence: facetForOversight(v.facets.fifa_licence),
            national_registration: Object.fromEntries(
              Object.entries(v.facets.national_registration).map(([k, f]) => [k, facetForOversight(f)]),
            ),
            minors_authorisation: Object.fromEntries(
              Object.entries(v.facets.minors_authorisation).map(([k, f]) => [k, facetForOversight(f)]),
            ),
          },
          regulatoryState: v.regulatoryState,
          policyVersion: v.policyVersion,
          rev: v.rev,
          revAt: v.revAt,
        };
      }),
      nextCursor,
      readOnly: true,
      note: 'Read-only oversight: states and provenance. Licence numbers and submitted references are not shown; attributed review is where they would be needed.',
    });
  });

  // ============================================================ deletion hook
  /** Inside the deletion's unit: each relationship becomes an id-only tombstone. */
  function onPlayerDeleted(playerId, at = now()) {
    agreements.redactClient(playerId, at);
  }

  // ============================================================ sweep
  /**
   * An active relationship ending within 30 days tells its agent once, and a VERIFIED facet whose re-check date passed
   * tells its agent once; each marker commits with its notification. A sweep, not a read, so reads never write.
   */
  function agentSweep() {
    const t = now();
    for (const a of agreements.expiringUnnotified(t, EXPIRY_ALERT_MS)) {
      try {
        unit(() => {
          agreements.markExpiryNotified(a.id, { at: t });
          // Only a current member is told; the marker is written either way.
          if (affiliations.activeFor(a.agentUserId, a.agencyOrgId, t))
            notify(
              { kind: 'org_user', id: a.agentUserId },
              'representation_expiring',
              'A client relationship ends within 30 days. A new relationship needs a new client confirmation.',
              a.id,
            );
        });
      } catch (err) {
        log.error?.(`agent sweep: the expiry notice for ${a.id} failed: ${err?.message ?? err}`);
      }
    }
    for (const p of profiles.staleUnnotified(t)) {
      try {
        unit(() => {
          const told = [];
          const mark = (facet, ma, rec) => {
            if (
              rec?.state === 'VERIFIED' &&
              rec.recheckAt !== null &&
              rec.recheckAt <= t &&
              rec.staleNotifiedAt === null
            )
              told.push([facet, ma]);
          };
          mark('fifa_licence', null, p.facets.fifa_licence);
          for (const f of ['national_registration', 'domestic_authorisation', 'minors_authorisation'])
            for (const [ma, rec] of Object.entries(p.facets[f])) mark(f, ma, rec);
          profiles.markStaleNotified(p.id, { facets: told, at: t });
          if (affiliations.activeFor(p.userId, p.agencyOrgId, t))
            for (const [facet, ma] of told)
              notify(
                { kind: 'org_user', id: p.userId },
                'agent_verification_stale',
                `Verification of ${facet}${ma ? ` (${ma})` : ''} has gone STALE. Re-check it or request attributed review before any regulated action.`,
                p.id,
              );
        });
      } catch (err) {
        log.error?.(`agent sweep: the stale notice for ${p.id} failed: ${err?.message ?? err}`);
      }
    }
  }
  agentSweep();

  return {
    onPlayerDeleted,
    agentSweep,
    effectiveAgreementStatus,
    agreementGrantsAccess,
    testProviderEnabled,
    facetView,
  };
}
