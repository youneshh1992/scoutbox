// The Discovery Ledger as the club reads it: its own page of the append-only ledger, the Proof Pack (attribution
// evidence on one player), the plan and its attribution terms, invoices, the recruitment funnel and scout
// reputation. Every figure is counted from recorded events.
import { visibleToOrg } from '../../domain.mjs';
import { readPage, sendPageError } from '../platform/paging.mjs';
import { invoiceView } from '../../adapters.mjs';
import { PLANS } from '../../catalogue.mjs';

/** A ledger row as the organisation, the player or the guardian reads it. */
export const ledgerView = (l) => ({
  id: l.id,
  ts: l.ts,
  type: l.type,
  playerId: l.playerId,
  orgId: l.orgId,
  orgName: l.orgName,
  userId: l.userId,
  scoutName: l.scoutName,
  detail: l.detail,
});

export function registerLedger({
  orgRouter,
  safetyAudit,
  recruitment,
  signings,
  invoices,
  reputationSeed,
  findPlayer,
  isBlocked,
}) {
  orgRouter.get('/ledger', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const out = safetyAudit.ledger.pageForOrg(req.org.id, page);
    res.json({ items: out.items.map(ledgerView), nextCursor: out.nextCursor });
  });

  orgRouter.get('/players/:id/proofpack', (req, res) => {
    const p = findPlayer(req.params.id);
    if (!p || isBlocked(p.id, req.org.id)) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
    if (!visibleToOrg(p, req.org)) return res.status(403).json({ error: 'UNDER_18_WALL' });
    const events = safetyAudit.ledger.forPlayerOrg(p.id, req.org.id).map(ledgerView);
    const first = events[0] || null;
    const windowMonths = PLANS[req.org.plan].attributionWindowMonths; // orgs.plan is one of the catalogue's plans (its CHECK)
    res.json({
      playerId: p.id,
      playerName: p.name,
      org: { id: req.org.id, name: req.org.name, plan: req.org.plan },
      firstQualifyingInteraction: first,
      attributionWindowMonths: windowMonths,
      attributionWindowEnds: first ? new Date(first.ts + windowMonths * 30.44 * 24 * 3600 * 1000).toISOString() : null,
      eventLog: events,
      generatedAt: new Date().toISOString(),
    });
  });

  orgRouter.get('/plan', (req, res) => {
    const plan = PLANS[req.org.plan];
    res.json({
      org: { id: req.org.id, name: req.org.name, type: req.org.type, trustedPartner: req.org.trustedPartner },
      plan,
      compliance: {
        attributionWindowMonths: plan.attributionWindowMonths,
        antiCircumvention: plan.antiCircumvention,
        feeProtection:
          'Discovery attribution is evidenced by the append-only ledger and Proof Packs. Fees attach to the first qualifying interaction inside the window.',
      },
    });
  });

  // Newest first, by cursor (`?limit=&cursor=`); the apps read the first page.
  orgRouter.get('/invoices', (req, res) => {
    let page;
    try {
      page = readPage(req.query, ['number']);
    } catch (e) {
      return sendPageError(res, e);
    }
    const { items, nextCursor } = invoices.pageForOrg(req.org.id, page);
    res.json({ items: items.map(invoiceView), nextCursor });
  });

  orgRouter.get('/funnel', (req, res) => {
    const byType = safetyAudit.ledger.countsForOrg(req.org.id);
    const count = (type) => Object.entries(byType).reduce((n, [t, c]) => n + (t.startsWith(type) ? c : 0), 0);
    res.json({
      stages: [
        { key: 'views', label: 'Profile views', count: count('view') },
        { key: 'saves', label: 'Saves', count: count('save') },
        { key: 'shortlists', label: 'Shortlists', count: count('shortlist') },
        { key: 'requests', label: 'Requests sent', count: recruitment.requests.countForOrg(req.org.id) },
        {
          key: 'accepted',
          label: 'Requests accepted',
          count: recruitment.requests.countForOrgStatus(req.org.id, 'accepted'),
        },
        { key: 'trials', label: 'Trials booked', count: recruitment.trials.countForOrg(req.org.id) },
        { key: 'reports', label: 'Reports filed', count: recruitment.trials.countForOrgStatus(req.org.id, 'reported') },
        { key: 'signings', label: 'Signings', count: signings.countForOrg(req.org.id) },
      ],
      byScout: safetyAudit.ledger.topActorsForOrg(req.org.id, 8),
    });
  });

  // Scout and coach reputation: seeded track records beside live rows from the ledger.
  orgRouter.get('/reputation', (_req, res) => {
    const live = {};
    for (const { scoutName, orgName, type, n } of safetyAudit.ledger.countsByActor()) {
      const key = `${scoutName}|${orgName}`;
      live[key] ??= { scoutName, orgName, views: 0, contacts: 0, trials: 0, signings: 0, seeded: false };
      if (type === 'view') live[key].views += n;
      if (type === 'contact_request') live[key].contacts += n;
      if (type === 'trial_request' || type === 'trial_report') live[key].trials += n;
      if (type === 'signing') live[key].signings += n;
    }
    res.json({ seeded: reputationSeed.all(), live: Object.values(live) });
  });
}
