/**
 * M23 — the recruitment evidence provider.
 *
 * A lifecycle status that asserts a durable football-business fact must be
 * supported by a record that independently establishes it. This module is the
 * only thing that answers "does that record exist?", and it answers from
 * canonical stores it does not own and never writes.
 *
 * THE DIRECTION OF CAUSATION, WHICH IS THE WHOLE POINT (§17)
 *
 *   signing truth  ->  lifecycle
 *   lifecycle      -/-> signing truth
 *
 * `db.signings` is not lifecycle bookkeeping. Creating one issues a success-fee
 * invoice, moves the player's level, sets `contractStatus: 'under_contract'`
 * and adds them to a squad. So M23 reads signings and never writes them: a
 * recruitment status can follow a signing, but no recruitment status may cause
 * one. If that were reversed, moving a case on a screen would bill a club.
 *
 * WHAT IS DELIBERATELY NOT ANSWERABLE YET
 *
 * Trial and Offer evidence belong to phases that have not shipped. Their kinds
 * answer `not_implemented`, which refuses the transition. That is the honest
 * state: the product cannot prove those things happened, so it does not let
 * the lifecycle claim they did. `contact_delivered` is answered from P3's
 * Contact store, and in the same direction: contact truth -> lifecycle.
 */

import { CONTACT_EVIDENCE_STATUSES, contactIntegrity } from './contact.mjs';
import { trialIntegrity, deriveWorkflowState } from './trial.mjs';
// M23 P6 — the Offer domain's pure evidence predicate. The lifecycle asks; the
// Offer store answers; nothing here writes an Offer or a status.
import { offerEvidence } from '../m28/offer.mjs';

const OFFER_EVIDENCE_KINDS = Object.freeze(['offer_sent', 'offer_accepted_by_recipient', 'offer_declined_by_recipient']);

/** Every kind the lifecycle can ask about. Anything else is a programming error. */
export const EVIDENCE_KINDS = Object.freeze([
  'contact_delivered',
  'trial_invited',
  // M23 P5 — the ONE decision-shaped kind: a finalized formal decision to progress.
  'decision_progress',
  'trial_confirmed',
  'trial_completed',
  'offer_sent',
  'offer_accepted_by_recipient',
  'offer_declined_by_recipient',
  'confirmed_join',
]);

/**
 * Is this signing record usable as proof that THIS case's player joined THIS
 * club? (§15)
 *
 * Three independent checks, because each closes a different hole:
 *   - same organisation — a rival's signing is not this club's business
 *   - same player       — another player's signing proves nothing about this one
 *   - not cancelled     — a reversed signing is not a signing
 */
function signingSupports(signing, kase) {
  if (!signing) return false;
  if (signing.orgId !== kase.orgId) return false;
  if (signing.playerId !== kase.playerId) return false;
  if (signing.cancelledAt || signing.revokedAt || signing.voidedAt) return false;
  return true;
}

/**
 * Build the provider over a live database.
 *
 * Pure with respect to the database: it reads and returns a verdict. It never
 * creates, mutates or caches, so asking the same question twice cannot change
 * the answer.
 */
export function createEvidenceProvider(db) {
  return {
    /**
     * @returns {{satisfied: boolean, reason?: string, sourceType?: string, sourceId?: string}}
     */
    check(kind, { kase, now: at } = {}) {
      // The lifecycle passes its own clock; a caller that passes none gets
      // the real one. A P6 Offer expiry is judged at THIS instant (§48).
      const now = Number.isFinite(at) ? at : Date.now();
      if (!EVIDENCE_KINDS.includes(kind)) {
        // An unknown kind is a bug in the caller, not a business answer.
        // Fail closed and name it, rather than defaulting either way.
        return { satisfied: false, reason: 'unknown_evidence_kind' };
      }
      if (!kase) return { satisfied: false, reason: 'no_case' };

      if (kind === 'confirmed_join') {
        const signings = db?.signings;
        // The D2 lesson: a missing store is not "no signings". If the
        // collection is absent the database is broken, and answering
        // "unsatisfied" would be indistinguishable from answering truthfully.
        if (!Array.isArray(signings)) return { satisfied: false, reason: 'signings_store_unavailable' };
        const hit = signings.find((s) => signingSupports(s, kase));
        return hit
          ? { satisfied: true, sourceType: 'signing', sourceId: hit.id }
          : { satisfied: false, reason: 'no_confirmed_join' };
      }

      if (kind === 'contact_delivered') {
        // P3. The contract (§3): a contact record exists for THIS org and
        // THIS player, is not cancelled, and reached a state that means the
        // recipient could have received it — delivered in-app, answered, or
        // recorded as having happened outside ScoutBox. A draft is not
        // evidence; a failed attempt is not evidence; a corrupt record is not
        // evidence. A missing store is a broken database, not "no contact".
        const contacts = db?.recruitmentContacts;
        if (!Array.isArray(contacts)) return { satisfied: false, reason: 'contacts_store_unavailable' };
        const hit = contacts.find((c) => c && c.orgId === kase.orgId && c.playerId === kase.playerId
          && CONTACT_EVIDENCE_STATUSES.includes(c.status) && !c.cancelledAt && contactIntegrity(c).length === 0);
        return hit
          ? { satisfied: true, sourceType: 'recruitment_contact', sourceId: hit.id }
          : { satisfied: false, reason: 'no_contact_delivered' };
      }

      // ---- P4B Trial evidence. Same direction as every other kind: trial
      // truth -> lifecycle. The provider reads `db.requests` and `db.trials`
      // and writes nothing.
      if (kind === 'trial_invited') {
        // D-3: an authorised invitation that was actually delivered — a
        // request row of type `trial` FOR THIS CASE (caseId on the request),
        // issued through the single request writer, still pending or
        // accepted. A declined or suspended invitation proves nothing; a
        // draft, a room task and the `planTrial` action alone prove nothing;
        // a legacy request with no caseId is not evidence for a case it was
        // never tied to.
        const requests = db?.requests;
        if (!Array.isArray(requests)) return { satisfied: false, reason: 'requests_store_unavailable' };
        const hit = requests.find((r) => r && r.type === 'trial' && r.caseId === kase.id && r.orgId === kase.orgId
          && r.playerId === kase.playerId && ['pending', 'accepted'].includes(r.status) && !r.subjectRemovedAt);
        return hit
          ? { satisfied: true, sourceType: 'trial_request', sourceId: hit.id }
          : { satisfied: false, reason: 'no_invitation' };
      }

      if (kind === 'trial_confirmed' || kind === 'trial_completed') {
        // D-4 / D-5. A Trial row for THIS case, structurally sound, whose
        // stored operational state matches what its own fields derive.
        // `legacy_accepted` never satisfies `trial_confirmed` (no confirmed
        // schedule exists) and `reported` never satisfies `trial_completed`
        // (a report is not completion). A tombstoned trial still answers —
        // history stays honest after the person left (D-26).
        const trials = db?.trials;
        if (!Array.isArray(trials)) return { satisfied: false, reason: 'trials_store_unavailable' };
        const own = trials.filter((t) => t && t.caseId === kase.id && t.orgId === kase.orgId && t.playerId === kase.playerId
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

      // ---- P5 Decision evidence. The ONE widening P5 makes: `offer_consideration`
      // now needs a FINALIZED formal decision to progress (mandate §56). A draft
      // is not a decision; a superseded decision no longer speaks; an advisory
      // M17 recommendation is not a formal decision. Same direction as every
      // other kind: decision truth -> lifecycle; nothing written.
      if (kind === 'decision_progress') {
        const decisions = db?.roomDecisions;
        if (!Array.isArray(decisions)) return { satisfied: false, reason: 'decisions_store_unavailable' };
        const hit = decisions.find((d) => d && typeof d === 'object' && d.kind === 'formal' && d.state !== 'draft' && d.outcome === 'progress'
          && d.roomId === kase.id && d.orgId === kase.orgId && d.playerId === kase.playerId && !d.supersededById);
        return hit
          ? { satisfied: true, sourceType: 'decision', sourceId: hit.id }
          : { satisfied: false, reason: 'no_finalized_progress_decision' };
      }

      // ---- P6 Offer evidence. Answered from the canonical Offer store through
      // a pure predicate owned by the Offer domain (m28/offer.mjs): an ISSUED
      // revision satisfies `offer_sent`; a response row on that revision, by
      // the recipient the revision was addressed to, satisfies the accepted
      // or declined kind. A draft is not an Offer sent; a club user naming
      // `recordOfferAccepted` with no recipient response is refused here.
      // Reads; never writes.
      if (OFFER_EVIDENCE_KINDS.includes(kind)) {
        if (!Array.isArray(db?.recruitmentOffers)) return { satisfied: false, reason: 'offers_store_unavailable' };
        return offerEvidence(db.recruitmentOffers, kase, kind, now);
      }

      return { satisfied: false, reason: 'not_implemented' };
    },
  };
}
