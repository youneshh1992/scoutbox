/**
 * M23 P5.6B — the Agent domain's contribution to the operational audit feed.
 *
 * Same row shape as m182/audit.mjs and the same rule: what happened and who
 * did it, never what was said. Reason text, dispute text and licence
 * references never reach this projection; the subject is named only if the
 * organisation may currently see the player.
 */

export const AGENT_AUDIT_ACTIONS = new Set([
  'agent_profile_created', 'agent_profile_updated', 'agent_verification_submitted', 'agent_verification_state_changed',
  'agency_affiliation_created', 'agency_affiliation_updated', 'agency_affiliation_ended', 'agency_settings_updated',
  'representation_requested', 'representation_confirmed', 'representation_rejected',
  'representation_terminated', 'representation_disputed', 'representation_sharing_changed',
]);

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'facet', 'memberAssociation', 'state', 'tiers', 'phase', 'reasonCode', 'by', 'shareWithAgencyStaff', 'hadReason', 'scope', 'termMonths', 'legacy']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

const actorOf = (h) => (h?.by?.kind === 'org' || h?.by?.kind === 'agent'
  ? { userId: h.by.userId ?? null, name: h.by.name ?? null }
  : h?.by?.kind ? { userId: null, name: h.by.kind === 'player' ? 'Player' : h.by.kind } : null);

/** Audit rows for one agency organisation. Pure over the db. */
export function agentAuditRows(db, org, { findPlayer, orgCanSee }) {
  const rows = [];
  for (const p of db.agentProfiles ?? []) {
    if (!p || p.agencyOrgId !== org.id) continue;
    for (const h of p.history ?? []) {
      if (!AGENT_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'agent', actor: actorOf(h), target: { type: 'agent_profile', id: p.id, userId: p.userId }, detail: safeDetail(h.detail) });
    }
  }
  for (const a of db.agencyAffiliations ?? []) {
    if (!a || a.agencyOrgId !== org.id) continue;
    for (const h of a.history ?? []) {
      if (!AGENT_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'agency', actor: actorOf(h), target: { type: 'agency_affiliation', id: a.id, userId: a.userId }, detail: safeDetail(h.detail) });
    }
  }
  for (const r of db.representationAgreements ?? []) {
    if (!r || r.agencyOrgId !== org.id) continue;
    const player = r.clientKind === 'player' ? findPlayer(r.clientId) : null;
    const subject = player && orgCanSee(org, player) ? { playerId: player.id, playerName: player.name } : { playerId: null, playerName: null };
    for (const h of r.history ?? []) {
      if (!AGENT_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'representation', actor: actorOf(h), target: { type: 'representation', id: r.id, agentUserId: r.agentUserId, ...subject }, detail: safeDetail(h.detail) });
    }
  }
  rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
  return rows;
}
