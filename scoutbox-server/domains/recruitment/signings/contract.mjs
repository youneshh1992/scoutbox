/**
 * The player's live contract, if any: a completed-signing row over a COMPLETED package, not cancelled, whose
 * contract end has not passed. This record owns `under_contract`; a self-declaration never overrides it.
 */
export function createContractLookup({ signingsFollowUps }) {
  if (typeof signingsFollowUps?.signings?.forPlayer !== 'function')
    throw new TypeError('createContractLookup needs the signings repository');
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
