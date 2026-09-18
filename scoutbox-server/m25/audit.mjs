/**
 * M23 P5.6C — the compliance domain's audit projections.
 *
 * Two audiences, two projections:
 *   - the AGENCY audit feed (`/org/audit`, `/org/agent/agency/audit`): what
 *     happened to the agency's contexts, consents and reviews — actions, ids,
 *     states, policy versions; never a reason text, never a reviewer's note,
 *     never another party's agent;
 *   - the TRUST & SAFETY audit (`/ts/compliance/audit`): every authoritative
 *     compliance decision WITH the reviewer's identity, role, reason code,
 *     evidence references, policy versions, prior and resulting state, and
 *     the record's rev at decision time. This is the G-C0 record.
 */

export const COMPLIANCE_AUDIT_ACTIONS = new Set([
  'compliance_context_opened', 'compliance_context_party_added', 'compliance_representation_declared',
  'compliance_representation_verified', 'compliance_representation_withdrawn', 'compliance_context_evaluated', 'compliance_context_closed',
  'regulatory_consent_requested', 'regulatory_consent_granted', 'regulatory_consent_declined', 'regulatory_consent_revoked',
  'regulatory_review_requested', 'regulatory_review_started', 'regulatory_review_resolved', 'regulatory_review_cancelled', 'regulatory_review_superseded',
  'agent_facet_rechecked',
]);

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['outcome', 'partyRole', 'kind', 'status', 'from', 'to', 'facet', 'memberAssociation', 'state', 'policyVersions', 'reasonCodes', 'reviewId', 'consentId', 'contextId', 'hadReason', 'evidenceCount', 'type']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

const actorOf = (h) => {
  const by = h?.by;
  if (!by) return null;
  if (by.kind === 'org' || by.kind === 'agent') return { userId: by.userId ?? null, name: by.name ?? null };
  if (by.kind === 'ts_reviewer') return { userId: null, name: 'Trust & Safety (attributed)', reviewerId: by.userId ?? null };
  if (by.kind === 'player') return { userId: null, name: 'Player' };
  if (by.kind === 'club_user') return { userId: null, name: 'Club signatory' };
  if (by.kind === 'system') return { userId: null, name: by.name ?? 'system' };
  return { userId: null, name: by.kind };
};

/** Agency-facing rows. Pure over the db. */
export function complianceAuditRows(db, org) {
  const rows = [];
  for (const c of db.complianceContexts ?? []) {
    if (!c || c.agencyOrgId !== org.id) continue;
    for (const h of c.history ?? []) {
      if (!COMPLIANCE_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'compliance', actor: actorOf(h), target: { type: 'compliance_context', id: c.id, agentUserId: c.agentUserId }, detail: safeDetail(h.detail) });
    }
  }
  for (const r of db.regulatoryReviews ?? []) {
    if (!r || r.agencyOrgId !== org.id) continue;
    for (const h of r.history ?? []) {
      if (!COMPLIANCE_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'compliance', actor: actorOf(h), target: { type: 'regulatory_review', id: r.id, kind: r.kind }, detail: safeDetail(h.detail) });
    }
  }
  for (const k of db.regulatoryConsents ?? []) {
    if (!k || k.agencyOrgId !== org.id) continue;
    for (const h of k.history ?? []) {
      if (!COMPLIANCE_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({ id: h.id, at: h.at, action: h.action, domain: 'compliance', actor: actorOf(h), target: { type: 'regulatory_consent', id: k.id, contextId: k.contextId ?? null, partyRole: k.partyRole ?? null }, detail: safeDetail(h.detail) });
    }
  }
  rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
  return rows;
}

/** The Trust & Safety decision record: attributed, complete, minimal PII. */
export function reviewerDecisionRows(db) {
  const rows = [];
  for (const r of db.regulatoryReviews ?? []) {
    if (!r) continue;
    for (const h of r.history ?? []) {
      if (!['regulatory_review_started', 'regulatory_review_resolved', 'regulatory_review_cancelled', 'regulatory_review_superseded'].includes(h?.action)) continue;
      const d = h.detail ?? {};
      rows.push({
        id: h.id, at: h.at, action: h.action, reviewId: r.id, kind: r.kind,
        reviewer: h.by?.kind === 'ts_reviewer' ? { reviewerId: h.by.userId ?? null, name: h.by.name ?? null, role: h.by.role ?? null, attribution: 'authenticated_reviewer' } : { reviewerId: null, name: h.by?.name ?? null, role: null, attribution: h.by?.kind === 'system' ? 'system' : 'legacy_unattributed' },
        subject: r.subject ?? null, agencyOrgId: r.agencyOrgId ?? null,
        outcome: d.outcome ?? null, reasonCode: d.reasonCode ?? null, evidenceRefs: d.evidenceRefs ?? [],
        policyVersions: d.policyVersions ?? r.policyVersions ?? [], priorState: d.priorState ?? null, resultingState: d.resultingState ?? null, rev: d.rev ?? null,
      });
    }
  }
  rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
  return rows;
}
