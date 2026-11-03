# Offers and signings

Offers, offer terms and responses, signing packages, signings, follow-ups and outcome reports.

> Names in brackets, like (M17_RECRUITMENT_ROOMS), are the original milestone documents. They were removed in the November 2026 cleanup; read one with `git show docs-archive-2026-11:M17_RECRUITMENT_ROOMS.md`. Founder decisions and resolved contradictions for this area are in [`../decisions.md`](../decisions.md).

## How it works

**Principle.** Each step below is a separate, explicit human act. A decision is not an Offer. An Offer is not an acceptance. An acceptance does not open a signing. Opening a signing is not a party's confirmation, and a confirmation is not a completed signing. Nothing is automated: no AI negotiation, counter-offer or auto-accept, and no paid priority. (M23_P6_OFFER_SECURITY_THREAT_MODEL, M23_P7_SIGNING_MODEL)

**Offer model (m28)**
- **Ownership.** Org, case and player come from the case, never the body. Only `direct_recruitment`. (M23_P6_OFFER_MODEL)
- **Terms.** `{offerType, role, squad, startDate, endDate, conditions}`. There are no wage, fee or clause fields.
  - Dates are date-only; `startDate` is required to issue, and the end must come after the start.
  - Text is bounded, with control, bidi and zero-width characters stripped. (M23_P6_OFFER_MODEL, M23_P61_OFFER_PRIVACY_HARDENING)
- **Messages.** `internalNote` never leaves the club; `recipientMessage` does.
- **Revisions.** Append-only, at most 20, editable only as DRAFT, frozen at issue; every issued revision stays readable to the recipient.
  - *Current* is the club's working revision. *Live* is the latest issued, which is what the recipient answers.
  - Issuing N+1 marks N SUPERSEDED. If the recipient answers N first, the N+1 draft is discarded (recorded WITHDRAWN). (M23_P6_OFFER_TERMS_VERSIONING)
- **Expiry.**
  - Must be an instant with an offset or Z, between 1 h and 180 d after the server clock.
  - Lazy: an ISSUED revision reads EXPIRED once past, and nothing is written. An unreadable expiry reads EXPIRED. There is no scheduler. (M23_P6_OFFER_MODEL)
- **Documents** are the club's own vault rows, checked at draft and issue; recipients fetch them by Offer-side id, never the vault id.
- **Other limits.** One live Offer per case. No delete route. (M23_P6_OFFER_STATE_MACHINE, M23_P61_OFFER_DEFECT_REGISTER)

**Offer revision state machine**
```
DRAFT  → ISSUED (lead) | WITHDRAWN (club, or discarded by recipient answer)
ISSUED → ACCEPTED | DECLINED (addressed recipient; exact live, unexpired, unanswered revision)
       → WITHDRAWN (club) | SUPERSEDED (next issued) | EXPIRED (derived, never written)
All others terminal. No SIGNED state.
```
- **Create** needs a finalized "progress" decision, the case at `offer_consideration`, no block, and no live Offer.
- **Issue** needs: complete terms, a valid expiry, a recipient route that is valid now, no block, the case at `offer_consideration` or `offer_made`, and transaction readiness if a transaction is referenced. (M23_P6_OFFER_STATE_MACHINE, M23_P6_RELEASE_READINESS)
- **Answering.**
  - The answer names a `revisionId`. The gate checks, in order: exists, issued, not superseded, not withdrawn, not expired, unanswered, live.
  - A block refuses accept but allows decline. (M23_P6_OFFER_TERMS_VERSIONING)
- **Case coupling.** All moves go through `canTransitionRecruitmentCase` and the single lifecycle writer; m28 never assigns a status. First issue → `offer_made`; accept or decline (actor = recipient) → `offer_accepted` / `offer_declined`; withdrawing an issued revision → `offer_consideration`; expiry moves nothing. If the case cannot move, the Offer change rolls back (409 `OFFER_LIFECYCLE_CONFLICT`). (M23_P6_LIFECYCLE_INTEGRATION)
- **After a decline**, the club steps the case back (`shortlist` → `considerOffer`) before issuing again.
- **On hold** makes the live revision unanswerable (`CASE_PAUSED`); resuming goes to `under_review`, so the club re-issues or withdraws. (M23_P61_OFFER_LEGACY_COMPATIBILITY)
- **Evidence.** Accepted or declined evidence needs a response row whose actor matches the recipient snapshot; a draft is never evidence. Legacy routes cannot reach offer states without it. (M23_P6_LIFECYCLE_INTEGRATION)
- **Concurrency.** One `rev` per Offer; club mutations need an integer `expectedRev` (recipient share and read receipts don't move it). `clientKey` per act: same payload replays, different payload conflicts. Authority is re-checked before any replay: a key is not a capability. Signings follow the same pattern. (M23_P6_OFFER_TERMS_VERSIONING, M23_P61_OFFER_AUTHORIZATION_REVALIDATION)
- **Integrity failures** return a generic 500 `OFFER_STATE_UNKNOWN`. The row is hidden from every projection and never repaired. (M23_P61_OFFER_LEGACY_COMPATIBILITY)

**Minors and guardians**
- **Recipient** is re-resolved by `resolveContactRecipient` at issue, read and answer (adult → player, minor → guardian). A bad date of birth counts as not adult. (M23_P6_MINOR_GUARDIAN_MODEL)
- **The minor pathway is CLOSED in every jurisdiction.**
  - A draft is allowed; issue is refused (422, `MINOR_PATHWAY_CLOSED`). The minor's device lists nothing; guardian routes are dormant and fail closed.
  - Opening a jurisdiction is a policy-table change plus legal review.
- **Dormant rules:** only the snapshot's guardian may answer; notifications go to the guardian, never the child. (M23_P6_MINOR_GUARDIAN_MODEL)

**Offer visibility**
- **Club** sees everything.
- **Recipient** sees issued revisions, the message, documents, expiry and whether the Offer is answerable. Never the note, drafts, decision or transaction ids, readiness codes, the withdraw reason, or who drafted it.
- **Agent** sees, read-only, the terms and state of issued revisions, only on Offers the adult client shared. No documents, no note, no accept or decline. Access is re-checked on every read and needs all of:
  - the agent's own active, client-confirmed agreement;
  - the `client_private` decision;
  - employment or transfer scope;
  - a current licence.
- **Same-agency colleagues** get 404. Un-share works after the representation has ended.
- **Events** are org-private (ids only); notifications are one factual line. A hidden id and an invented id return identical 404s. Actor, adulthood, status or time in a request body is ignored.
- **Player deletion** nulls names and blocks further acts; the record stays. (M23_P61_OFFER_PRIVACY_HARDENING, M23_P61_OFFER_AUTHORIZATION_REVALIDATION)

**Signing model (m29)**
- **Two stores.** Signing packages hold the workflow. The signings table is the completed record only: exactly one row per COMPLETED package (linked both ways) or per legacy recording. (M23_P7_SIGNING_MODEL)
- **Start.**
  - Only a lead starts a package. It is opened over an ACCEPTED Offer revision, with the case at `offer_accepted`, and bound to that `offerRevisionId`. The accepted Offer is then immutable.
  - One live package and one completed package per Offer.
  - Expiry: 1 h to 90 d (default 30 d), derived, never stored.
  - Contract: a start day is required, the end must be on or after the start, and no more than 10 years later. (M23_P7_SIGNING_MODEL)
- **States.** DRAFT → READY (presented: document, start day, at least one party) → IN_PROGRESS (first confirmation) → COMPLETED (lead, empty gate).
  - **Cancel:** from DRAFT, READY or IN_PROGRESS.
  - **Void:** from READY or IN_PROGRESS, by a lead, or by T&S with a named reviewer and reason.
  - **Supersede:** from READY or IN_PROGRESS. It creates a new DRAFT revision; every party is pending again and nothing carries forward.
  - **After completion nothing is possible.** An amendment is a new Offer and a new signing. (M23_P7_SIGNING_STATE_MACHINE)
- **Parties.** Derived from the recipient snapshot.
  - Adult: `PLAYER` + `CLUB_SIGNATORY`.
  - Guardian: `GUARDIAN` + `CLUB_SIGNATORY`, refused as `SIGNING_PATHWAY_CLOSED`.
  - No agent, witness or proxy.
  - `PLAYER` is the authenticated player only. `CLUB_SIGNATORY` is a recruitment lead (`isLead`) in their own name.
  - A room lead who is not a recruitment lead may manage, but not sign, void or complete. (M23_P7_SIGNING_PARTY_MODEL, M23_P71_SIGNING_AUTH_REVALIDATION)
- **A confirmation** carries the current `revisionId` and the exact `documentSha256`. The method is `PLATFORM_ACKNOWLEDGMENT`. The case must still be at `offer_accepted`; if not, `SIGNING_LIFECYCLE_CONFLICT` (a paused case freezes the package). Actor and time come from the server.
- **A block** stops progress, never cancels. (M23_P7_SIGNING_PARTY_MODEL, M23_P7_SIGNING_BLOCK_MATRIX)

**Signing evidence and documents**
- **The document** is a PDF, PNG, JPEG or WebP. Its identity is the SHA-256 of its exact bytes, recomputed by the server. It is stored as `organisation_internal` evidence.
- **Attaching.** Allowed only in DRAFT, and presenting freezes it. A changed document means a supersede. An executed-document upload is evidence only. (M23_P7_DOCUMENT_INTEGRITY)
- **Serving.** Authenticated routes only (no signed URLs), re-verified when served; tampered bytes block completion. The agent never gets bytes or the digest. (M23_P71_SIGNING_AUTH_REVALIDATION, M23_P71_SIGNING_DOCUMENT_INTEGRITY_AUDIT)
- **Honest scope:** no e-signature or legal-effect claim; recipient views say so. (M23_P7_SIGNING_EVIDENCE_MODEL)
- **`evidenceRef`** (revision, digest, server instant, session actor) is immutable; the completion gate re-checks all of it.

**Completion and contract status**
- **One unit of work.**
  1. The single writer `recordCompletedSigning` writes the signings row.
  2. The player is updated: level by club level, `under_contract`, `not_seeking`, and a timeline line.
  3. `confirmSignedOutcome` runs through the validator.

  If the case cannot move, everything rolls back with 409. (M23_P7_LIFECYCLE_INTEGRATION; code)
- **`signed` evidence** needs a signings row. A row that names a package counts only if that package is COMPLETED and names the row back. (M23_P71_SIGNING_LEGACY_COMPATIBILITY)
- **`under_contract`.** For a recruitment signing it is written only by `recordCompletedSigning`. Nothing reverts it at `endDate`.
- **Other writers kept.** The player's self-declaration is flagged `PLAYER_CONTRACT_STATUS_DIVERGED` and never repaired. Grassroots squad release sets `free_agent`. (M23_P7_CONTRACT_STATUS_SEMANTICS, M23_P71_SIGNING_LEGACY_COMPATIBILITY)
- **Success fee:** once per signing, only inside the plan's attribution window (default 18 months). (code)
- **Grassroots** has no Offer or signing surface.
- **Legacy route** `POST /org/players/:id/signing` records `LEGACY_RECORDED`. It is refused with `SIGNING_CANONICAL_REQUIRED` beside an accepted Offer or a live or completed package. It has no idempotency key. (M23_P7_LEGACY_COMPATIBILITY)
- **Signing visibility.** The player sees presented revisions, the digest and parties by kind, never a lead's name or the note. The agent sees a read-only line for the live package (state, n of m signed, contract days); there is no agent write route. Events are org-private; no Inbox thread is created. (M23_P71_SIGNING_PRIVACY_HARDENING)
- **Rate limits.** Cancel and void have their own budget (`signing_safety_closure`), so completion traffic cannot starve it. T&S void is unlimited. (M23_P71_SIGNING_IDEMPOTENCY_RATELIMIT_AUDIT)

## Open questions and deferred work

- **Minor/guardian pathway** for Offers and signing is closed everywhere. Opening it needs per-jurisdiction legal policy. There is no guardian signing UI.
- **Not built:**
  - transfer or loan Offers, and fee or wage terms;
  - external e-signature;
  - `under_contract` reversal at the end date;
  - amendment, renewal, rescission, and void after completion.
- **Legacy recording route.** Its retirement is undecided, and it has no idempotency key.
- **Multi-process.** Races and rate limits rely on a single process; scaling out needs a store-level compare-and-set on `rev`. A monotonic server clock is assumed.

## Where the code enforces it

*Spot-checked against the code on 3 November 2026. ✓ enforced, ✗ not found, ≠ differs from the old docs.*

- ✓ **Minor pathway closed:** m28/offer.mjs:116; signing equivalent m29/signing.mjs:51.
- ✓ **Offer transitions and limits:** m28/offer.mjs:68-76, 100-104.
- ✓ **Recipient view** carries no internalNote, decisionId, transactionId or withdrawReason (m28/offer.mjs `offerRecipientView`; club view at :500 does).
- ✓ **Single `under_contract` writer** outside the seed: m29/index.mjs:324.
- ✓ **Single signings writer:** m29/index.mjs:299.
- ✓ **Party kinds and lead requirement:** m29/signing.mjs:48, m29/index.mjs:156. Signing expiry: m29/signing.mjs:58.
- ✓ **Legacy blocker:** m29/index.mjs:344-347 (called at server.mjs:2753).
- ✓ **`signingSupports`:** m23/evidence.mjs:60. Agent licence check: m28/index.mjs:877, m29/index.mjs:835.
- ≠ **Invoice after commit**, not rolled back in the unit (m29/index.mjs:300-304).
