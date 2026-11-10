/**
 * Bulk reads for one player's journeys. Each journey reads about a dozen record
 * sets; asked per case that is a dozen queries per club. This reads each set once
 * for all the player's cases and answers exactly what `reads` would, in the same
 * order, deferring anything else to `reads`. It never sees a write, so it must
 * not outlive the request.
 */

const groupBy = (records, key) => {
  const out = new Map();
  for (const r of records) {
    const k = key(r);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(r);
  }
  return out;
};
const indexById = (...lists) => {
  const out = new Map();
  for (const list of lists) for (const r of list) out.set(r.id, r);
  return out;
};

export function playerJourneyReads(reads, playerId, cases) {
  const caseIds = cases.map((k) => k.id);
  const pairKey = (orgId, pid) => `${orgId}\u0000${pid}`;
  const byPlayer = {
    cases,
    requests: reads.requests.forPlayer(playerId),
    trials: reads.trials.forPlayer(playerId),
    signings: reads.signings.forPlayer(playerId),
    contacts: reads.contacts.forPlayer(playerId),
  };
  // Records naming these cases, whoever they name as the player: one naming
  // another player is corrupt, and the journey must still see it to count it.
  const byCase = {
    requests: reads.requests.forCases(caseIds),
    trials: reads.trials.forCases(caseIds),
    contacts: reads.contacts.forCases(caseIds),
    offers: reads.offers.forCases(caseIds),
    signingPackages: reads.signingPackages.forCases(caseIds),
    decisions: reads.decisions.forRooms(caseIds),
  };
  const orgPlayer = Object.fromEntries(
    Object.entries(byPlayer).map(([n, list]) => [n, groupBy(list, (r) => pairKey(r.orgId, r.playerId))]),
  );
  const ofCase = Object.fromEntries(
    Object.entries(byCase).map(([n, list]) => [n, groupBy(list, (r) => (n === 'decisions' ? r.roomId : r.caseId))]),
  );
  const known = {
    cases: indexById(cases),
    trials: indexById(byPlayer.trials, byCase.trials),
    contacts: indexById(byPlayer.contacts, byCase.contacts),
    signings: indexById(byPlayer.signings),
  };
  const caseSet = new Set(caseIds);

  const forOrgPlayer = (name) => (orgId, pid) =>
    pid === playerId ? (orgPlayer[name].get(pairKey(orgId, pid)) ?? []) : reads[name].forOrgPlayer(orgId, pid);
  const forCase =
    (name, method = 'forCase') =>
    (caseId) =>
      caseSet.has(caseId) ? (ofCase[name].get(caseId) ?? []) : reads[name][method](caseId);
  const byId = (name) => (id) => known[name].get(id) ?? reads[name].byId(id);

  return Object.freeze({
    ...reads,
    cases: Object.freeze({ ...reads.cases, byId: byId('cases'), forOrgPlayer: forOrgPlayer('cases') }),
    requests: Object.freeze({
      ...reads.requests,
      forOrgPlayer: forOrgPlayer('requests'),
      forCase: forCase('requests'),
    }),
    trials: Object.freeze({
      ...reads.trials,
      byId: byId('trials'),
      forOrgPlayer: forOrgPlayer('trials'),
      forCase: forCase('trials'),
    }),
    signings: Object.freeze({ ...reads.signings, byId: byId('signings'), forOrgPlayer: forOrgPlayer('signings') }),
    contacts: Object.freeze({
      ...reads.contacts,
      byId: byId('contacts'),
      forOrgPlayer: forOrgPlayer('contacts'),
      forCase: forCase('contacts'),
    }),
    offers: Object.freeze({ ...reads.offers, forCase: forCase('offers') }),
    signingPackages: Object.freeze({ ...reads.signingPackages, forCase: forCase('signingPackages') }),
    decisions: Object.freeze({ ...reads.decisions, forRoom: forCase('decisions', 'forRoom') }),
  });
}
