/**
 * M23 P8 — the audience journey routes and the notification target resolver.
 *
 *   GET /player/journeys                     the player's journeys, one per club that reached them
 *   GET /guardian/children/:id/journeys      the guardian's view of a child's journeys
 *   GET /org/agent/clients/:id/journey       an authorized agent's factual view of a client's journeys
 *
 * Every route reads through `buildRecruitmentJourney` with an audience viewer;
 * nothing here writes. The agent route proves the basis exactly as the P5.6E /
 * P6 / P7 agent routes do (membership, own agreement, the policy engine, scope,
 * licence, the client's own shares) and passes what it proved as `grants`; the
 * projection shows only the granted kinds and never says what it withheld.
 *
 * `notificationTargetFor` turns a notification's bare `refId` into the CURRENT
 * authorized resource for its audience at READ time (§29–§31): nothing is
 * stored, a superseded package resolves to the live one over the same Offer,
 * and a reference the audience may no longer open resolves to nothing (the
 * app shows plain text). It never resolves to a resource of another org.
 */

import { buildRecruitmentJourney } from './journey.mjs';
import { currentSigningForOffer } from './journeyModel.mjs';

export function registerJourneyRoutes(ctx) {
  const { db, playerRouter, guardianRouter, orgRouter, agent = null, integration = null, findPlayer, guardianOwnsChild } = ctx;
  const evidence = () => ctx.recruitmentEvidenceProvider ?? undefined;
  const orgOf = (orgId) => (db.orgs ?? []).find((o) => o && o.id === orgId) ?? null;
  // The same per-request test clock the Offer and signing routes honour (development only).
  const TEST_CLOCK = process.env.SCOUTBOX_TEST_CLOCK === '1' && process.env.NODE_ENV !== 'production';
  const now = (req = null) => { if (TEST_CLOCK && req?.get) { const n = Number(req.get('x-scoutbox-test-clock')); if (Number.isFinite(n) && n > 0) return n; } return Date.now(); };
  const clubOf = (orgId) => { const o = orgOf(orgId); return o ? { id: o.id, name: o.name ?? null, level: o.level ?? null, verified: !!o.verified } : { id: orgId, name: null, level: null, verified: false }; };

  function playerJourneys(viewer, playerId, at) {
    const items = [];
    for (const k of db.recruitmentCases ?? []) {
      if (!k || k.playerId !== playerId || !k.room) continue;
      const out = buildRecruitmentJourney(db, k.id, viewer, { now: at, evidence: evidence() });
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

  /**
   * The agent's grants, proved the way each P5.6E/P6/P7 route proves them.
   * A kind whose gate fails is simply not granted; the route itself answers
   * 403 only when the client's record is closed to this agent altogether.
   */
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
    if (!agent?.resolveMembership?.(req, res)) return;
    const found = agent.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly) return res.status(403).json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: 'A summary row does not open a client\'s journey.' });
    const a = found; const at = now(req);
    const g = agentGrants(req, a, at);
    if (!g.ok) return res.status(403).json({ error: g.decision.code, rule: g.decision.rule ?? null, message: 'This client\'s record is not open to you right now.' });
    const items = [];
    for (const k of db.recruitmentCases ?? []) {
      if (!k || k.playerId !== a.clientId || !k.room) continue;
      const out = buildRecruitmentJourney(db, k.id, { kind: 'agent', authorized: true, playerId: a.clientId, userId: req.orgUser.id, grants: g.grants }, { now: at, evidence: evidence() });
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
  const orgUserOrg = (userId) => { const u = (db.users ?? []).find((x) => x && x.id === userId); return u ? u.orgId : null; };
  const caseFor = (caseId, orgId) => (db.recruitmentCases ?? []).find((k) => k && k.id === caseId && k.room && (orgId === null || k.orgId === orgId)) ?? null;
  const room = (k, tab) => (k ? { kind: 'room', roomId: k.id, tab } : null);
  const blocked = (playerId, orgId) => (db.blocks ?? []).some((b) => b && b.playerId === playerId && b.orgId === orgId);

  /**
   * @param {object} n           the notification row
   * @param {object} audience    { kind: 'player'|'guardian'|'org_user', id }
   * @returns {object|null}      { kind, ...ids } or null when nothing current and authorized exists
   */
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
        const r = (db.requests ?? []).find((x) => x && x.id === ref);
        if (!r) return null;
        if (kind === 'org_user') return r.orgId === orgId ? room(caseFor(r.caseId, orgId), r.type === 'trial' ? 'trial' : 'contact') : null;
        if (kind === 'player') return r.playerId === audience.id && r.routedTo !== 'guardian' ? { kind: 'inbox', requestId: r.id } : null;
        if (kind === 'guardian') return r.guardianId === audience.id ? { kind: 'inbox', requestId: r.id } : null;
        return null;
      }
      if (ref.startsWith('trial-')) {
        const t = (db.trials ?? []).find((x) => x && x.id === ref);
        if (!t) return null;
        if (kind === 'org_user') return t.orgId === orgId ? room(caseFor(t.caseId, orgId), 'trial') : null;
        if (kind === 'player') return t.playerId === audience.id && (t.recipient ? t.recipient.type === 'player' : t.acceptedBy === 'player') ? { kind: 'trial', trialId: t.id } : null;
        if (kind === 'guardian') return (t.recipient ? t.recipient.type === 'guardian' && t.recipient.guardianId === audience.id : t.acceptedBy === 'guardian') ? { kind: 'trial', trialId: t.id } : null;
        return null;
      }
      if (ref.startsWith('rct-')) {
        const c = (db.recruitmentContacts ?? []).find((x) => x && x.id === ref);
        if (!c) return null;
        if (kind === 'org_user') {
          if (c.orgId === orgId) return room(caseFor(c.caseId, orgId), 'contact');
          // an agent the contact was routed to: their client's contacts tab
          return c.routingSnapshot?.agent?.agentUserId === audience.id ? { kind: 'client', clientId: c.playerId, tab: 'contacts' } : null;
        }
        return null;
      }
      if (ref.startsWith('rof-')) {
        const o = (db.recruitmentOffers ?? []).find((x) => x && x.id === ref);
        if (!o) return null;
        if (kind === 'org_user') {
          if (o.orgId === orgId) return room(caseFor(o.caseId, orgId), 'offer');
          return o.agentShare?.agentUserId === audience.id ? { kind: 'client', clientId: o.playerId, tab: 'offers' } : null;
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
        if (ref.startsWith('sign-')) { const row = (db.signings ?? []).find((x) => x && x.id === ref); p = row?.signingPackageId ? (db.signingPackages ?? []).find((x) => x && x.id === row.signingPackageId) ?? null : null; }
        else p = (db.signingPackages ?? []).find((x) => x && x.id === ref) ?? null;
        if (!p) return null;
        // The CURRENT package over the same Offer (a superseded or expired one resolves to the live one).
        const current = currentSigningForOffer((db.signingPackages ?? []).filter((x) => x && x.offerId === p.offerId && x.orgId === p.orgId), at) ?? p;
        if (kind === 'org_user') {
          if (p.orgId === orgId) return room(caseFor(p.caseId, orgId), 'signing');
          const o = (db.recruitmentOffers ?? []).find((x) => x && x.id === p.offerId);
          return o?.agentShare?.agentUserId === audience.id ? { kind: 'client', clientId: p.playerId, tab: 'offers' } : null;
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
