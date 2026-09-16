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

/** Every kind the lifecycle can ask about. Anything else is a programming error. */
export const EVIDENCE_KINDS = Object.freeze([
  'contact_delivered',
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
    check(kind, { kase } = {}) {
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

      // Trial and Offer evidence arrive with their own phases.
      return { satisfied: false, reason: 'not_implemented' };
    },
  };
}
