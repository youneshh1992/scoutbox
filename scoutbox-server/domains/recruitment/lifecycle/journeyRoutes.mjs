/**
 * The audience journey routes and the notification target resolver.
 *
 * The agent route proves its basis as the agent Contact, Offer and signing
 * routes do and passes what it proved as `grants`; the projection shows only
 * the granted kinds and never says what it withheld.
 *
 * `notificationTargetFor` resolves a notification's `refId` at read time to the
 * current resource its audience may open: a superseded package resolves to the
 * live one, and a reference no longer theirs resolves to null (plain text in the app).
 */

import { requestClock } from '../../platform/clock.mjs';
import { buildRecruitmentJourney } from './journey.mjs';
import { currentSigningForOffer } from './journeyModel.mjs';
import { playerJourneyReads } from './journeyReads.mjs';

export function registerJourneyRoutes(ctx) {
  const { recruitmentReads, scoutingReads, safetyReads, playerRouter, guardianRouter, orgRouter, access = null, integration = null, findPlayer, guardianOwnsChild } = ctx;
  if (!recruitmentReads?.contacts || !recruitmentReads?.offers || !recruitmentReads?.signings || !recruitmentReads?.signingPackages) throw new TypeError('registerJourneyRoutes needs recruitmentReads (contacts, offers, signings, signingPackages) from the data layer');
  const evidence = () => ctx.recruitmentEvidenceProvider ?? undefined;
  const orgOf = (orgId) => ctx.byId.org(orgId);
  const now = requestClock();
  const clubOf = (orgId) => { const o = orgOf(orgId); return o ? { id: o.id, name: o.name ?? null, level: o.level ?? null, verified: !!o.verified } : { id: orgId, name: null, level: null, verified: false }; };

  function playerJourneys(viewer, playerId, at) {
    const items = [];
    // Every case's records read once for the whole list (journeyReads.mjs), not a dozen queries a case.
    const cases = recruitmentReads.cases.forPlayer(playerId);
    const reads = { ...playerJourneyReads(recruitmentReads, playerId, cases.filter((k) => k.room)), assessments: scoutingReads.assessments, blocks: safetyReads.blocks, player: (id) => ctx.byId.player(id) };
    for (const k of cases) {
      if (!k.room) continue;
      const out = buildRecruitmentJourney(k.id, viewer, { now: at, evidence: evidence(), reads });
      if (!out.ok) continue; // nothing crossed the share boundary: the case does not exist for them
      items.push({ club: clubOf(k.orgId), shared: out.shared, journey: out.journey });
    }
    // Deterministic: the journey with the most consequential pending act first, then by club name, then id.
    const weight = { SIGN: 5, RESPOND_TO_OFFER: 4, CONFIRM_TRIAL_SCHEDULE: 3, RESPOND_TO_TRIAL_INVITATION: 2, RESPOND_TO_CONTACT: 1, NONE: 0 };
    items.sort((a, b) => (weight[b.journey.nextAction.code] - weight[a.journey.nextAction.code]) || String(a.club.name ?? '').localeCompare(String(b.club.name ?? '')) || String(a.club.id).localeCompare(String(b.club.id)));
    return items;
  }

  playerRouter.get('/journeys', (req, res) => {
    const at = now(req);
    res.json({ items: playerJourneys({ kind: 'player_self', playerId: req.player.id }, req.player.id, at), generatedAt: at });
  });

  guardianRouter.get('/children/:id/journeys', (req, res) => {
    if (!guardianOwnsChild(req.guardian, req.params.id)) return res.status(404).json({ error: 'CHILD_NOT_FOUND' });
    const at = now(req);
    res.json({ items: playerJourneys({ kind: 'guardian', guardianId: req.guardian.id, playerId: req.params.id }, req.params.id, at), generatedAt: at });
  });

  /** A kind whose gate fails is not granted; 403 only when the client's record is closed to this agent. */
  function agentGrants(req, a, at) {
    const grants = [];
    const decide = (surface) => integration?.decide?.({ surface, clientId: a.clientId, agentUserId: req.orgUser.id, at }) ?? { allowed: false, code: 'BASIS' };
    const priv = decide('client_private');
    if (priv.allowed !== true) return { ok: false, decision: priv };
    grants.push('contacts');
    if (decide('trial_projection').allowed === true) grants.push('trials');
    const basis = integration?.basisFor?.({ agentUserId: req.orgUser.id, clientId: a.clientId, at });
    const scopeOk = !!basis?.ok && (basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer');
    const licenceCurrent = integration?.licenceCurrentFor ? integration.licenceCurrentFor(req.orgUser.id, a.jurisdiction ?? null, at) : false;
    if (scopeOk && licenceCurrent === true) { grants.push('offers'); grants.push('signings'); }
    return { ok: true, grants };
  }

  orgRouter.get('/agent/clients/:id/journey', (req, res) => {
    if (!access?.resolveMembership?.(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s journey.' });
    const a = found; const at = now(req);
    const g = agentGrants(req, a, at);
    if (!g.ok) return res.status(403).json({ error: g.decision.code, rule: g.decision.rule ?? null, message: 'This client\'s record is not open to you right now.' });
    const items = [];
    const cases = recruitmentReads.cases.forPlayer(a.clientId);
    const reads = { ...playerJourneyReads(recruitmentReads, a.clientId, cases.filter((k) => k.room)), assessments: scoutingReads.assessments, blocks: safetyReads.blocks, player: (id) => ctx.byId.player(id) };
    for (const k of cases) {
      if (!k.room) continue;
      const out = buildRecruitmentJourney(k.id, { kind: 'agent', authorized: true, playerId: a.clientId, userId: req.orgUser.id, grants: g.grants }, { now: at, evidence: evidence(), reads });
      if (!out.ok) continue;
      // A club that shared nothing with this agent is not a club the agent learns about.
      if (out.journey.stage === 'none' && out.journey.timeline.length === 0) continue;
      items.push({ club: clubOf(k.orgId), journey: out.journey });
    }
    items.sort((x, y) => String(x.club.name ?? '').localeCompare(String(y.club.name ?? '')) || String(x.club.id).localeCompare(String(y.club.id)));
    res.json({ relationshipId: a.id, clientId: a.clientId, grants: g.grants, items, generatedAt: at });
  });

  // ------------------------------------------------------ notification targets

  /** The org a notification's staff audience belongs to, so a target never crosses a tenant. */
  const orgUserOrg = (userId) => (ctx.byId?.user ?? ctx.users?.byId)?.(userId)?.orgId ?? null;
  const caseFor = (caseId, orgId) => { const k = recruitmentReads.cases.byId(caseId); return k && k.room && (orgId === null || k.orgId === orgId) ? k : null; };
  const room = (k, tab) => (k ? { kind: 'room', roomId: k.id, tab } : null);
  const blocked = (playerId, orgId) => safetyReads.blocks.has(playerId, orgId);
  /**
   * Re-derived through the authority the client routes prove on every read. An
   * agent whose representation ended or licence lapsed keeps the row but loses
   * the destination. A share alone never grants a target.
   */
  function agentTarget(agentUserId, playerId, tab, at) {
    if (typeof agentUserId !== 'string' || !agentUserId) return null;
    const priv = integration?.decide?.({ surface: 'client_private', clientId: playerId, agentUserId, at });
    if (priv?.allowed !== true) return null;
    if (tab === 'offers') {
      const basis = integration?.basisFor?.({ agentUserId, clientId: playerId, at });
      const scopeOk = !!basis?.ok && (basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer');
      const mine = ctx.agentReads.agreements.forClient(playerId).filter((a) => a.agentUserId === agentUserId);
      const agreement = mine.find((a) => a.id === basis?.agreementId) ?? mine[0] ?? null;
      const licenceCurrent = integration?.licenceCurrentFor ? integration.licenceCurrentFor(agentUserId, agreement?.jurisdiction ?? null, at) : false;
      if (!scopeOk || licenceCurrent !== true) return null;
    }
    return { kind: 'client', clientId: playerId, tab };
  }

  /** @returns {object|null} `{ kind, ...ids }`, or null when nothing current and authorised exists */
  function notificationTargetFor(n, audience) {
    const ref = typeof n?.refId === 'string' ? n.refId : null;
    if (!ref) return null;
    const at = Date.now();
    const kind = audience.kind;
    const orgId = kind === 'org_user' ? orgUserOrg(audience.id) : null;
    try {
      if (ref.startsWith('case-')) {
        if (kind !== 'org_user') return null;
        return room(caseFor(ref, orgId), 'overview');
      }
      if (ref.startsWith('req-')) {
        const r = recruitmentReads.requests.byId(ref);
        if (!r) return null;
        if (kind === 'org_user') return r.orgId === orgId ? room(caseFor(r.caseId, orgId), r.type === 'trial' ? 'trial' : 'contact') : null;
        if (kind === 'player') return r.playerId === audience.id && r.routedTo !== 'guardian' ? { kind: 'inbox', requestId: r.id } : null;
        if (kind === 'guardian') return r.guardianId === audience.id ? { kind: 'inbox', requestId: r.id } : null;
        return null;
      }
      if (ref.startsWith('trial-')) {
        const t = recruitmentReads.trials.byId(ref);
        if (!t) return null;
        if (kind === 'org_user') return t.orgId === orgId ? room(caseFor(t.caseId, orgId), 'trial') : null;
        if (kind === 'player') return t.playerId === audience.id && (t.recipient ? t.recipient.type === 'player' : t.acceptedBy === 'player') ? { kind: 'trial', trialId: t.id } : null;
        if (kind === 'guardian') return (t.recipient ? t.recipient.type === 'guardian' && t.recipient.guardianId === audience.id : t.acceptedBy === 'guardian') ? { kind: 'trial', trialId: t.id } : null;
        return null;
      }
      if (ref.startsWith('rct-')) {
        const c = recruitmentReads.contacts.byId(ref);
        if (!c) return null;
        if (kind === 'org_user') {
          if (c.orgId === orgId) return room(caseFor(c.caseId, orgId), 'contact');
          // an agent the contact was routed to: their client's contacts tab
          return c.routingSnapshot?.agent?.agentUserId === audience.id ? agentTarget(audience.id, c.playerId, 'contacts', at) : null;
        }
        return null;
      }
      if (ref.startsWith('rof-')) {
        const o = recruitmentReads.offers.byId(ref);
        if (!o) return null;
        if (kind === 'org_user') {
          if (o.orgId === orgId) return room(caseFor(o.caseId, orgId), 'offer');
          return o.agentShare?.agentUserId === audience.id ? agentTarget(audience.id, o.playerId, 'offers', at) : null;
        }
        const rev = (o.revisions ?? []).filter((r) => r && r.issuedAt).sort((x, y) => y.revisionNumber - x.revisionNumber)[0] ?? null;
        const snap = rev?.recipientSnapshot;
        if (!snap) return null;
        if (kind === 'player') return snap.type === 'player' && snap.playerId === audience.id && !blocked(o.playerId, o.orgId) ? { kind: 'offer', offerId: o.id, offerRevisionId: rev.id } : null;
        if (kind === 'guardian') return snap.type === 'guardian' && snap.guardianId === audience.id ? { kind: 'offer', offerId: o.id, offerRevisionId: rev.id } : null;
        return null;
      }
      if (ref.startsWith('spk-') || ref.startsWith('sign-')) {
        let p = null;
        if (ref.startsWith('sign-')) { const row = recruitmentReads.signings.byId(ref); p = row?.signingPackageId ? recruitmentReads.signingPackages.byId(row.signingPackageId) : null; }
        else p = recruitmentReads.signingPackages.byId(ref);
        if (!p) return null;
        // The CURRENT package over the same Offer (a superseded or expired one resolves to the live one).
        const current = currentSigningForOffer(recruitmentReads.signingPackages.forOffer(p.offerId).filter((x) => x.orgId === p.orgId), at) ?? p;
        if (kind === 'org_user') {
          if (p.orgId === orgId) return room(caseFor(p.caseId, orgId), 'signing');
          const o = recruitmentReads.offers.byId(p.offerId);
          return o?.agentShare?.agentUserId === audience.id ? agentTarget(audience.id, p.playerId, 'offers', at) : null;
        }
        const rev = (current.revisions ?? []).find((r) => r && r.id === current.currentRevisionId) ?? null;
        if (!rev?.readyAt) return null; // never presented: nothing for a recipient to open
        const party = (rev.requiredParties ?? []).find((x) => x && x.partyType === (kind === 'guardian' ? 'GUARDIAN' : 'PLAYER') && x.forEntityId === audience.id);
        if (!party) return null;
        if (kind === 'player' && blocked(p.playerId, p.orgId)) return null;
        return { kind: 'signing', signingPackageId: current.id, superseded: current.id !== p.id };
      }
    } catch { return null; }
    return null;
  }

  return { notificationTargetFor, playerJourneys };
}
