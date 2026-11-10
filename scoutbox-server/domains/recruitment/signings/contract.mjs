/**
 * The player's canonical live contract, if any: a completed-signing row written by the one writer over a COMPLETED
 * signing package, not cancelled, whose contract end (if any) has not passed at `now`. This is the record that owns
 * `under_contract`; a self-declaration or a club's squad housekeeping never overrides it.
 */
export function createContractLookup({ signingsFollowUps }) {
  if (typeof signingsFollowUps?.signings?.forPlayer !== 'function') throw new TypeError('createContractLookup needs the signings repository');
  return function canonicalContractFor(playerId, now = Date.now(), { exceptOrgId = null } = {}) {
    const today = new Date(now).toISOString().slice(0, 10);
    for (const s of signingsFollowUps.signings.forPlayer(playerId)) {
      if (!s.signingPackageId) continue;
      if (s.cancelledAt || s.revokedAt || s.voidedAt) continue;
      if (exceptOrgId && s.orgId === exceptOrgId) continue;
      const found = signingsFollowUps.signingPackages.byId(s.signingPackageId);
      const pkg = found && found.status === 'COMPLETED' && found.completion?.signingId === s.id ? found : null;
      if (!pkg) continue;
      const end = s.contract?.endDate ?? pkg.completion?.contract?.endDate ?? null;
      if (typeof end === 'string' && end < today) continue;
      return { signing: s, packageId: pkg.id, orgId: s.orgId, endDate: end };
    }
    return null;
  };
}
