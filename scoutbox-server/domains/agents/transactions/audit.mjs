/**
 * The transaction domain's audit rows. Unlike the timeline, they are filtered only by the tenant asking, so they hold
 * rows no party's timeline shows; they carry no note text, document content, fee or personal field.
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

/** The actor as a role: a club never learns which named person at the agency acted, and vice versa. */
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

/** Codes, states and counts only. */
function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const k of ['from', 'to', 'partyRole', 'subjectKind', 'status', 'outcome', 'pendingReason', 'reasonCodes', 'policyVersions', 'documentType', 'visibility', 'holdReasonCode', 'version', 'count', 'staleness']) {
    if (detail[k] !== undefined) out[k] = detail[k];
  }
  return Object.keys(out).length ? out : null;
}

/** `agencyOrgId` feeds the agency audit; `transactionId` the Trust & Safety read of one transaction. */
export function transactionAuditRows({ reads, snapshotOf }, { agencyOrgId = null, transactionId = null } = {}) {
  const rows = [];
  let txs; let reps; let docs;
  if (transactionId) {
    const tx = reads.transactions.byId(transactionId);
    txs = tx && (!agencyOrgId || tx.agencyOrgId === agencyOrgId) ? [tx] : [];
    reps = txs.length ? reads.representations.forTransaction(transactionId) : [];
    docs = txs.length ? reads.documents.forTransaction(transactionId) : [];
  } else if (agencyOrgId) {
    txs = reads.transactions.forAgency(agencyOrgId);
    reps = reads.representations.forAgency(agencyOrgId);
    docs = reads.documents.forAgency(agencyOrgId);
  } else return rows;
  const byTx = new Map(txs.map((t) => [t.id, t]));
  for (const tx of txs) {
    const snap = snapshotOf(tx);
    for (const h of tx.history) {
      if (!TRANSACTION_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'transaction', actor: actorOf(h),
        target: { type: 'agent_transaction', id: tx.id, transactionType: tx.type, status: tx.status },
        complianceSnapshot: snap ? { evaluationId: snap.evaluationId, evaluatedAt: snap.evaluatedAt, outcome: snap.outcome, policyVersions: snap.policyVersions } : null,
        detail: safeDetail(h.detail),
      });
    }
  }
  for (const d of docs) {
    const tx = byTx.get(d.transactionId);
    if (!tx) continue;
    for (const h of d.history) {
      if (!TRANSACTION_AUDIT_ACTIONS.has(h?.action)) continue;
      rows.push({
        id: h.id, at: h.at, action: h.action, domain: 'transaction', actor: actorOf(h),
        target: { type: 'transaction_document', id: d.id, transactionId: tx.id, documentType: d.documentType },
        complianceSnapshot: null, detail: safeDetail(h.detail),
      });
    }
  }
  for (const r of reps) {
    for (const h of r.history) {
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
