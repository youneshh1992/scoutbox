/**
 * The recruitment evidence provider: answers whether a record exists that
 * supports a lifecycle status, from stores it does not own and never writes.
 *
 * Causation runs one way: record -> lifecycle. A signing issues a success-fee
 * invoice, changes the player's level and contract status and adds them to a
 * squad, so moving a case on a screen must never create one. A kind this
 * provider cannot answer gets `not_implemented`, which refuses the transition.
 */

import { CONTACT_EVIDENCE_STATUSES, contactIntegrity } from './contact.mjs';
import { trialIntegrity, deriveWorkflowState } from './trial.mjs';
import { offerEvidence } from '../offers/offer.mjs';

const OFFER_EVIDENCE_KINDS = Object.freeze(['offer_sent', 'offer_accepted_by_recipient', 'offer_declined_by_recipient']);

export const EVIDENCE_KINDS = Object.freeze([
  'contact_delivered',
  'trial_invited',
  'decision_progress',
  'trial_confirmed',
  'trial_completed',
  'offer_sent',
  'offer_accepted_by_recipient',
  'offer_declined_by_recipient',
  'confirmed_join',
]);

/**
 * Is this signing proof that this case's player joined this club? Same org,
 * same player, not cancelled.
 */
function signingSupports(signing, kase, packages = null) {
  if (!signing) return false;
  if (signing.orgId !== kase.orgId) return false;
  if (signing.playerId !== kase.playerId) return false;
  if (signing.cancelledAt || signing.revokedAt || signing.voidedAt) return false;
    // A row naming a package is evidence only if that package is COMPLETED and
    // names this row back; a row planted beside a live package proves nothing.
  if (signing.signingPackageId) {
    const pkg = Array.isArray(packages) ? packages.find((x) => x && x.id === signing.signingPackageId) ?? null : null;
    if (!pkg || pkg.status !== 'COMPLETED' || pkg.completion?.signingId !== signing.id || pkg.orgId !== kase.orgId || pkg.playerId !== kase.playerId) return false;
    // A package proves the case it was opened on, not another case of the same club and player.
    if (pkg.caseId !== kase.id) return false;
    return true;
  }
  // A row with no package proves a joining only for a case that existed when it was recorded.
  const ts = Number(signing.ts); const opened = Number(kase.createdAt);
  if (Number.isFinite(ts) && Number.isFinite(opened) && ts < opened) return false;
  return true;
}

/**
 * `reads` carries the recruitment repositories' queries (contacts, offers,
 * signings, signingPackages, requests, trials, decisions). A missing one is a
 * broken composition, answered as an unavailable store, never as "no record".
 */
export function createEvidenceProvider(reads = {}) {
  return {
    /**
     * @returns {{satisfied: boolean, reason?: string, sourceType?: string, sourceId?: string}}
     */
    check(kind, { kase, now: at } = {}) {
      // An Offer expiry is judged at the lifecycle's instant.
      const now = Number.isFinite(at) ? at : Date.now();
      if (!EVIDENCE_KINDS.includes(kind)) {
        return { satisfied: false, reason: 'unknown_evidence_kind' };
      }
      if (!kase) return { satisfied: false, reason: 'no_case' };

      if (kind === 'confirmed_join') {
        // A missing store is a broken composition; "unsatisfied" would look like a truthful answer.
        if (typeof reads.signings?.forOrgPlayer !== 'function') return { satisfied: false, reason: 'signings_store_unavailable' };
        // A package proves only the case it was opened on.
        const packages = typeof reads.signingPackages?.forCase === 'function' ? reads.signingPackages.forCase(kase.id) : null;
        const hit = reads.signings.forOrgPlayer(kase.orgId, kase.playerId).find((s) => signingSupports(s, kase, packages));
        return hit
          ? { satisfied: true, sourceType: 'signing', sourceId: hit.id }
          : { satisfied: false, reason: 'no_confirmed_join' };
      }

      if (kind === 'contact_delivered') {
        // Delivered in-app, answered, or recorded as happening outside ScoutBox.
        // Drafts, failed attempts and corrupt records are not evidence.
        if (typeof reads.contacts?.forOrgPlayer !== 'function') return { satisfied: false, reason: 'contacts_store_unavailable' };
        const hit = reads.contacts.forOrgPlayer(kase.orgId, kase.playerId).find((c) => c && c.orgId === kase.orgId && c.playerId === kase.playerId
          && CONTACT_EVIDENCE_STATUSES.includes(c.status) && !c.cancelledAt && contactIntegrity(c).length === 0);
        return hit
          ? { satisfied: true, sourceType: 'recruitment_contact', sourceId: hit.id }
          : { satisfied: false, reason: 'no_contact_delivered' };
      }

      // ---- Trial evidence.
      if (kind === 'trial_invited') {
        // A delivered `trial` request tied to this case by caseId, still pending
        // or accepted. The `planTrial` action alone, or a request with no caseId, proves nothing.
        if (typeof reads.requests?.forCase !== 'function') return { satisfied: false, reason: 'requests_store_unavailable' };
        const hit = reads.requests.forCase(kase.id).find((r) => r && r.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId
          && r.playerId === kase.playerId && ['pending', 'accepted'].includes(r.status) && !r.subjectRemovedAt);
        return hit
          ? { satisfied: true, sourceType: 'trial_request', sourceId: hit.id }
          : { satisfied: false, reason: 'no_invitation' };
      }

      if (kind === 'trial_confirmed' || kind === 'trial_completed') {
        // `legacy_accepted` never satisfies `trial_confirmed` (no confirmed
        // schedule) and `reported` never satisfies `trial_completed` (a report is
        // not completion). A tombstoned trial still answers, so history stays honest.
        if (typeof reads.trials?.forCase !== 'function') return { satisfied: false, reason: 'trials_store_unavailable' };
        const own = reads.trials.forCase(kase.id).filter((t) => t && t.caseId === kase.id && t.orgId === kase.orgId && t.playerId === kase.playerId
          && trialIntegrity(t, { orgId: kase.orgId, caseId: kase.id }).length === 0);
        if (kind === 'trial_confirmed') {
          const hit = own.find((t) => deriveWorkflowState(t) === 'scheduled' && Number.isFinite(t.schedule?.confirmedAt) && (t.schedule?.sessions?.length ?? 0) > 0);
          return hit
            ? { satisfied: true, sourceType: 'trial', sourceId: hit.id }
            : { satisfied: false, reason: 'no_confirmed_schedule' };
        }
        const hit = own.find((t) => t.completion?.state === 'completed' && deriveWorkflowState(t) === 'completed');
        return hit
          ? { satisfied: true, sourceType: 'trial', sourceId: hit.id }
          : { satisfied: false, reason: 'no_completed_trial' };
      }

      // ---- Decision evidence: a finalised, current, formal decision to
      // progress. Drafts and advisory recommendations do not count.
      if (kind === 'decision_progress') {
        if (typeof reads.decisions?.forRoom !== 'function') return { satisfied: false, reason: 'decisions_store_unavailable' };
        const hit = reads.decisions.forRoom(kase.id).find((d) => d && typeof d === 'object' && d.kind === 'formal' && d.state !== 'draft' && d.outcome === 'progress'
          && d.roomId === kase.id && d.orgId === kase.orgId && d.playerId === kase.playerId && !d.supersededById);
        return hit
          ? { satisfied: true, sourceType: 'decision', sourceId: hit.id }
          : { satisfied: false, reason: 'no_finalized_progress_decision' };
      }

      // ---- Offer evidence, via the Offer domain's predicate: an issued
      // revision satisfies `offer_sent`; a response by the addressed recipient
      // satisfies accepted or declined. `recordOfferAccepted` with no recipient
      // response is refused here.
      if (OFFER_EVIDENCE_KINDS.includes(kind)) {
        if (typeof reads.offers?.forCase !== 'function') return { satisfied: false, reason: 'offers_store_unavailable' };
        return offerEvidence(reads.offers.forCase(kase.id), kase, kind, now);
      }

      return { satisfied: false, reason: 'not_implemented' };
    },
  };
}
