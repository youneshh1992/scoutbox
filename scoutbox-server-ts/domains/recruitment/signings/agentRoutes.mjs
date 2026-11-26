import { signingAgentView } from './signing.mjs';

export function registerAgentRoutes(ctx) {
  const { access, findPlayer, integration, now, offerOf, orgCanSee, orgOf, orgRouter, soundPackage, sp } = ctx;
  orgRouter.get('/agent/clients/:id/signings', (req, res) => {
    if (!access?.resolveMembership?.(req, res)) return;
    const found = access.findOwnAgreement(req, res, req.params.id);
    if (!found) return;
    if (found.summaryOnly)
      return res
        .status(403)
        .json({ error: 'AGENT_ACTION_NOT_PERMITTED', message: "A summary row does not open a client's signings." });
    const a = found;
    const at = now(req);
    const decision = integration?.decide?.({
      surface: 'client_private',
      clientId: a.clientId,
      agentUserId: req.orgUser.id,
      at,
    }) ?? { allowed: false, code: 'BASIS' };
    if (decision.allowed !== true)
      return res.status(403).json({
        error: decision.code,
        rule: decision.rule ?? null,
        message: "This client's signings are not open to you right now.",
      });
    const basis = integration?.basisFor?.({ agentUserId: req.orgUser.id, clientId: a.clientId, at });
    if (!basis?.ok || !(basis.scope ?? []).some((s) => s === 'employment' || s === 'transfer'))
      return res.status(403).json({
        error: 'SCOPE_INSUFFICIENT',
        message: 'Your representation scope with this client does not cover employment or transfer.',
      });
    const licence = integration?.licenceCurrentFor
      ? integration.licenceCurrentFor(req.orgUser.id, a.jurisdiction ?? null, at)
      : false;
    if (licence !== true)
      return res.status(403).json({
        error: 'LICENCE_NOT_CURRENT',
        rule: 'LICENCE',
        message: "This client's signings are not open to you right now.",
      });
    const items = [];
    for (const p of sp.forPlayer(a.clientId)) {
      if (!soundPackage(p, at)) continue;
      const offer = offerOf(p);
      if (!offer?.agentShare || offer.agentShare.agentUserId !== req.orgUser.id) continue; // the client shares the Offer; the signing rides on that share
      if (!(p.revisions ?? []).some((r) => r && r.readyAt)) continue; // a draft is the club's own
      items.push(signingAgentView(p, at, { orgName: orgOf(p.orgId)?.name ?? null }));
    }
    const player = findPlayer(a.clientId);
    res.json({
      items,
      clientId: a.clientId,
      clientName: player && orgCanSee(req.org, player) ? player.name : null,
      honest:
        'Read-only. Your client signs as themselves; ScoutBox does not let you sign, acknowledge or complete for a client.',
    });
  });
}
