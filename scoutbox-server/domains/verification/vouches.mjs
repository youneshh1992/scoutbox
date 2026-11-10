// A coach reference as every profile shows it: an allowlist, never the coach's e-mail or the code. An e-mail-code
// reference proves mailbox control, NOT coach identity, and says so wherever it travels.

export function vouchView(v) {
  return {
    id: v.id, playerId: v.playerId, playerName: v.playerName, coachName: v.coachName, role: v.role, status: v.status,
    text: v.text, seasons: v.seasons, ts: v.ts, publishedAt: v.publishedAt, conflictOfInterest: v.conflictOfInterest,
    withdrawn: v.withdrawn && { at: v.withdrawn.at, by: v.withdrawn.by, reason: v.withdrawn.reason },
    verificationMethod: v.verificationMethod, identityVerified: v.identityVerified,
  };
}

export function createVouchReads({ vouches }) {
  if (typeof vouches?.publishedFor !== 'function') throw new TypeError('createVouchReads needs the coach-reference reads');
  return {
    publishedVouchesFor: (playerId) => vouches.publishedFor(playerId).map(vouchView),
    vouchesFor: (playerId) => vouches.forPlayer(playerId).map(vouchView),
  };
}
