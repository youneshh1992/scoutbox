/**
 * The agent core's audit rows: what happened and who did it, never what was said. The subject is named only if the
 * organisation may currently see the player.
 */

export const AGENT_AUDIT_ACTIONS = new Set([
  'agent_profile_created',
  'agent_profile_updated',
  'agent_verification_submitted',
  'agent_verification_state_changed',
  'agency_affiliation_created',
  'agency_affiliation_updated',
  'agency_affiliation_ended',
  'representation_requested',
  'representation_confirmed',
  'representation_rejected',
  'representation_terminated',
  'representation_disputed',
  'representation_sharing_changed',
  'agent_facet_rechecked',
]);

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of [
    'from',
    'to',
    'facet',
    'memberAssociation',
    'state',
    'tiers',
    'phase',
    'reasonCode',
    'by',
    'shareWithAgencyStaff',
    'hadReason',
    'scope',
    'termMonths',
  ]) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

const actorOf = (h) =>
  h?.by?.kind === 'org' || h?.by?.kind === 'agent'
    ? { userId: h.by.userId ?? null, name: h.by.name ?? null }
    : // A reviewer appears as a role here; the identity lives in the Trust & Safety audit.
      h?.by?.kind === 'ts_reviewer'
      ? { userId: null, name: 'Trust & Safety (attributed)' }
      : h?.by?.kind
        ? { userId: null, name: h.by.kind === 'player' ? 'Player' : h.by.kind }
        : null;

export function agentAuditRows(agentReads, org, { findPlayer, orgCanSee }) {
  const rows = [];
  const subjects = new Map();
  const subjectOf = (a) => {
    if (!subjects.has(a.id)) {
      const player = a.clientKind === 'player' ? findPlayer(a.clientId) : null;
      subjects.set(
        a.id,
        player && orgCanSee(org, player)
          ? { playerId: player.id, playerName: player.name }
          : { playerId: null, playerName: null },
      );
    }
    return subjects.get(a.id);
  };
  for (const { kind, entry: h, owner } of agentReads.history.forAgency(org.id)) {
    if (!AGENT_AUDIT_ACTIONS.has(h.action)) continue;
    const target =
      kind === 'profile'
        ? { type: 'agent_profile', id: owner.id, userId: owner.userId }
        : kind === 'affiliation'
          ? { type: 'agency_affiliation', id: owner.id, userId: owner.userId }
          : { type: 'representation', id: owner.id, agentUserId: owner.agentUserId, ...subjectOf(owner) };
    rows.push({
      id: h.id,
      at: h.at,
      action: h.action,
      domain: kind === 'profile' ? 'agent' : kind === 'affiliation' ? 'agency' : 'representation',
      actor: actorOf(h),
      target,
      detail: safeDetail(h.detail),
    });
  }
  return rows;
}
