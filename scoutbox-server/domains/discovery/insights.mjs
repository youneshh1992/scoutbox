// "Who's watching you": the player's side of the Discovery Ledger, counted from its rows.
const INSIGHT_TYPES = ['view', 'save', 'shortlist', 'contact_request', 'trial_request', 'contact_request_to_guardian', 'trial_request_to_guardian'];
const WEEK_MS = 7 * 24 * 3600 * 1000;

export function createInsights({ ledger }) {
  if (typeof ledger?.forPlayer !== 'function') throw new TypeError('createInsights needs the ledger reads');

  return function insightsFor(playerId) {
    const events = ledger.forPlayer(playerId, INSIGHT_TYPES);
    const now = Date.now();
    const week = now - WEEK_MS;
    const month = now - 30 * 24 * 3600 * 1000;
    const count = (list, type) => list.filter((l) => l.type.startsWith(type)).length;
    const weekly = events.filter((l) => l.ts >= week);
    const monthly = events.filter((l) => l.ts >= month);
    const byOrg = {};
    for (const l of events) {
      byOrg[l.orgName] ??= { orgName: l.orgName, views: 0, saves: 0, shortlists: 0, requests: 0, lastSeen: 0 };
      if (l.type === 'view') byOrg[l.orgName].views++;
      if (l.type === 'save') byOrg[l.orgName].saves++;
      if (l.type === 'shortlist') byOrg[l.orgName].shortlists++;
      if (l.type.includes('request')) byOrg[l.orgName].requests++;
      byOrg[l.orgName].lastSeen = Math.max(byOrg[l.orgName].lastSeen, l.ts);
    }
    // Eight weeks of views, oldest first.
    const weeklySeries = Array.from({ length: 8 }, (_, i) => {
      const end = now - i * WEEK_MS;
      const start = end - WEEK_MS;
      return events.filter((l) => l.type === 'view' && l.ts >= start && l.ts < end).length;
    }).reverse();
    return {
      thisWeek: { views: count(weekly, 'view'), saves: count(weekly, 'save'), shortlists: count(weekly, 'shortlist') },
      thisMonth: { views: count(monthly, 'view'), saves: count(monthly, 'save'), shortlists: count(monthly, 'shortlist') },
      weeklySeries,
      byOrg: Object.values(byOrg).sort((a, b) => b.lastSeen - a.lastSeen),
      recent: events.slice(-12).reverse().map((l) => ({ type: l.type, orgName: l.orgName, scoutName: l.scoutName, ts: l.ts })),
    };
  };
}
