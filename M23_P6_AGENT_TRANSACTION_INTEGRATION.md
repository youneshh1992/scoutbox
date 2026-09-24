# M23 P6 — Agent and transaction integration

## 1. Agent (§12, §33)

**Basis, scope, licence — re-derived on every read.** The agent projection
`GET /org/agent/clients/:rel/offers` runs, in order: `resolveMembership`
(agency member), `findOwnAgreement` (the agreement is THIS agent's own —
a colleague or an administrator without an explicit summary share gets 404
`REPRESENTATION_NOT_FOUND`, so nothing says an Offer exists), the P5.6E
`client_private` decision through the integration seam (block, ended,
disputed, expired, licence, adult-only), then the agreement's scope must
include `employment` or `transfer`. No new surface was added to
`SURFACES` (pinned at 10 by the frozen suite) and no new disclosure key
(pinned at 3): the Offer is not a disclosure the agent toggles — it is a
document the CLIENT shares, per Offer.

**The client's share.** `POST /player/offers/:id/share-agent` by an ADULT
recipient names their sole active agent (or `agreementId` when several)
and flips `agentShare`; `share:false` withdraws it. A guardian route cannot
share (§13). The share is the recipient's fact: it does not move the
Offer's rev. A notification tells the agent a client shared an Offer.

**What the agent reads** (`offerAgentView`): issued revisions' terms and
state, `awaitingClientResponse`, responses (kind, when), `sharedAt`. No
documents, no internal note, no decision or transaction reference, and the
words that the answer is the client's own act.

**What the agent cannot do.** There is no route through which an agent
accepts, declines, issues or edits an Offer (#20; m23OfferE2E #20b, live
E6). An agent token on `/player/offers/*` is 401. The seam's
`sharedFor`/disclosure keys are untouched.

**When the mandate ends** (terminate, expiry, dispute, licence lapse), the
next read answers 403/404 and the deep link in the agent's notification
opens nothing (#14, #48). The share row stays on the Offer as history; it
grants nothing without a live basis (`notifyAgent` checks `basisFor` before
every line it sends).

## 2. Transaction (§11)

**One seam, read-only.** m26 exports `offerReadinessFor(transactionId,
{ orgId, caseId })`: null unless the asking club is the transaction's
`engaging_entity` AND the transaction is linked to exactly this case;
otherwise `{ tx: { id, status, type }, readiness: offerReadiness(tx, {
complianceState, staleness }) }` re-derived NOW from the live compliance
snapshot and its staleness. m28 never reads `db.agentTransactions`, never
creates, moves or touches a transaction, and a transaction never creates an
Offer.

**At draft.** An optional `transactionId` on create is validated through
the seam; an unknown, foreign or unlinked id answers 400
`OFFER_INPUT_INVALID` — the same body for all three, so a club cannot learn
that a transaction exists by naming its id from an unrelated case.

**At issue.** Readiness is re-evaluated (never trusted from the draft):
`canStartOfferWorkflow === false` → 422 `OFFER_COMPLIANCE_BLOCKED` with
blocker CODES only (`TRANSACTION_NOT_READY`, `COMPLIANCE_SNAPSHOT_STALE`,
`COMPLIANCE_NOT_CLEAR`, `INDIVIDUAL_NOT_CONFIRMED`,
`ENGAGING_ENTITY_NOT_CONFIRMED`); a transaction that disappeared or
unlinked → `TRANSACTION_MISSING`. A successful issue snapshots
`{ transactionId, evaluatedAt, status }` on the revision (club-visible
only). The surface shows the same blockers before anyone tries.

**Privacy.** A recipient payload never names a transaction; a transaction
note (`AGENT_PRIVATE` or any lane) never appears in an Offer payload or an
Offer refusal (#37, m23OfferE2E T).

**Not modelled.** Transfer/loan Offers (club-to-club terms live on the
transaction, §8) and any automatic Offer from a READY transaction (§11: a
transaction never creates an Offer).
