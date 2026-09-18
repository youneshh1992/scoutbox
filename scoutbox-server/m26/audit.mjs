/**
 * M23 P5.6D — the transaction domain's audit projection.
 *
 * The platform audit is NOT the user-visible timeline (§40), and this file is
 * where that distinction lives: a timeline entry is filtered by the audience
 * tag its action carries, an audit row is filtered only by the tenant asking.
 * The audit therefore holds rows no party's timeline shows — a note being
 * added, an internal re-evaluation, a subject being tombstoned — and it names
 * the actor's role rather than repeating a person.
 *
 * What an audit row carries (§75): actor, transaction, party role, the
 * compliance snapshot reference, old and new state, timestamp, reason code and
 * evidence references. What it never carries: a note's text, a document's
 * content, a term's numbers, a fee, a counterparty's name, a reviewer's
 * reason, or any personal field of the individual.
 */

export const TRANSACTION_AUDIT_ACTIONS = new Set([
  'transaction_created',
  'transaction_party_added', 'transaction_party_removed', 'transaction_party_confirmed',
  'transaction_representation_attached', 'transaction_representation_withdrawn',
  'transaction_compliance_evaluated', 'transaction_compliance_stale',
  'transaction_status_changed', 'transaction_held', 'transaction_cancelled', 'transaction_closed', 'transaction_archived',
  'transaction_document_added', 'transaction_document_superseded', 'transaction_document_removed',
  'transaction_note_added', 'transaction_message_linked', 'transaction_terms_recorded',
  'transaction_subject_tombstoned',
]);

/** The actor as a ROLE. A club never learns which named person at the agency acted, and vice versa. */
const actorOf = (h) => {
  const by = h?.by;
  if (!by) return null;
  if (by.kind === 'org' || by.kind === 'agent') return { role: 'representing_agent', userId: by.userId ?? null, name: by.name ?? null };
  if (by.kind === 'club_user') return { role: 'party_club_signatory', userId: null, name: 'Club signatory', orgId: by.orgId ?? null };
  if (by.kind === 'player') return { role: 'party_individual', userId: null, name: 'Player' };
  if (by.kind === 'ts_reviewer') return { role: 'trust_safety', userId: null, name: 'Trust & Safety (attributed)', reviewerId: by.userId ?? null };
  if (by.kind === 'system') return { role: 'system', userId: null, name: by.name ?? 'system' };
  return { role: by.kind, userId: null, name: null };
};

/** Detail is codes, states and counts. The allowlist is the whole mechanism. */
function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'partyRole', 'subjectKind', 'status', 'outcome', 'pendingReason', 'reasonCodes', 'policyVersions', 'documentType', 'visibility', 'holdReasonCode', 'version', 'count', 'staleness']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Audit rows for a tenant or one transaction. Pure over the db.
 *
 * `agencyOrgId` gives the agency its own rows (they are merged into the agency
 * audit feed beside the P5.6B and P5.6C rows); `transactionId` gives the
 * attributed Trust & Safety read one transaction's rows.
 */
export function transactionAuditRows(db, { agencyOrgId = null, transactionId = null } = {}) {
  const rows = [];
  for (const tx of db.agentTransactions ?? []) {
    if (!tx) continue;
    if (agencyOrgId && tx.agencyOrgId !== agencyOrgId) continue;
    if (transactionId && tx.id !== transactionId) continue;
    for (const h of tx.history ?? []) {
      if (!TRANSACTION_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'transaction', actor: actorOf(h),
        target: { type: 'agent_transaction', id: tx.id, transactionType: tx.type, status: tx.status },
        complianceSnapshot: tx.compliance ? { evaluationId: tx.compliance.evaluationId, evaluatedAt: tx.compliance.evaluatedAt, outcome: tx.compliance.outcome, policyVersions: tx.compliance.policyVersions } : null,
        detail: safeDetail(h.detail),
      });
    }
  }
  for (const d of db.transactionDocuments ?? []) {
    if (!d) continue;
    const tx = (db.agentTransactions ?? []).find((t) => t && t.id === d.transactionId);
    if (!tx) continue;
    if (agencyOrgId && tx.agencyOrgId !== agencyOrgId) continue;
    if (transactionId && tx.id !== transactionId) continue;
    for (const h of d.history ?? []) {
      if (!TRANSACTION_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'transaction', actor: actorOf(h),
        target: { type: 'transaction_document', id: d.id, transactionId: tx.id, documentType: d.documentType },
        complianceSnapshot: null, detail: safeDetail(h.detail),
      });
    }
  }
  for (const r of db.transactionRepresentations ?? []) {
    if (!r) continue;
    if (agencyOrgId && r.agencyOrgId !== agencyOrgId) continue;
    if (transactionId && r.transactionId !== transactionId) continue;
    for (const h of r.history ?? []) {
      if (!TRANSACTION_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'transaction', actor: actorOf(h),
        target: { type: 'transaction_representation', id: r.id, transactionId: r.transactionId, partyRole: r.partyRole },
        complianceSnapshot: null, detail: safeDetail(h.detail),
      });
    }
  }
  rows.sort((a, b) => (b.at - a.at) || String(b.id).localeCompare(String(a.id)));
  return rows;
}
