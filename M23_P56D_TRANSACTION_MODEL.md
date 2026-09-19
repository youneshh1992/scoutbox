# M23 P5.6D — Transaction model

Status: implemented, local only. Schema 2306 → 2307, one step.

## 1. What a transaction is, and is not

A ScoutBox transaction is a **permissioned, auditable, multi-party workspace**
connecting Player ↔ Agent ↔ Engaging Club ↔ Releasing Club. It is operational
infrastructure: it identifies parties, tracks authority, enforces platform
permissions, attaches compliance snapshots, holds document classifications,
routes references to canonical conversations, records history, and records a
workflow status.

It is **not** a legal actor. ScoutBox does not negotiate, propose terms, accept
terms, sign, determine validity, or override an active compliance prohibition.
Every screen that shows a state also carries the sentence that says so.

### Three separations, encoded rather than asserted

| Separation | How it is encoded |
| --- | --- |
| Transaction ≠ Recruitment Case | `agentTransactions` is a new store. `recruitmentCases` is untouched — no field of it is read into a transaction and no transaction write reaches it. A recruitment case may be *referenced* by id (`linkedRecruitmentCaseId`) and the reference discloses nothing. |
| Transaction ≠ Offer | No status names an offer. `TRANSACTION_STATUSES` contains no `offer_made`, `offer_accepted`, `offer_declined` or `signed`; `TRANSACTION_TYPES` rejects `"offer"` as a type with `TRANSACTION_INPUT_INVALID`. The seam is a computed boolean, `offerBoundary.canStartOfferWorkflow`, with its blockers named. No offer record exists. |
| Transaction ≠ Signing | `db.signings` has no P5.6D writer. No player contract status is mutated. `signedAt` exists on a document only where it is objectively known and is never set by the workspace. |

## 2. The canonical entity: `agentTransactions`

The name is the frozen P5.6A §4 name. One row per transaction.

| Field | Why it exists |
| --- | --- |
| `id` | `atx-` prefixed. The hash namespace and the concealment unit. |
| `type` | One of the four frozen `CONTEXT_TYPES`, imported from the P5.6C conflict engine rather than copied, so the two can never disagree. |
| `status` | One of ten `TRANSACTION_STATUSES`. Never a freeform string. |
| `jurisdictions` | Derived from the parties' canonical association data, not from the body. |
| `agencyOrgId`, `agentUserId` | The agency and the licensed individual who opened it. The tenant boundary. |
| `parties[]` | The single truth about who the parties are. See §3. |
| `contextId` | The one P5.6C `complianceContexts` row this transaction owns. |
| `compliance` | The attached evaluation snapshot. See the compliance-integration document. |
| `notes[]` | Scoped notes, each with a visibility class. |
| `linkedThreads[]` | References into the canonical Inbox. No message body. |
| `terms` | Working particulars, versioned, each version scoped to a party. Never a fee. |
| `links` | `linkedRecruitmentCaseId`, `linkedTrialId`, `linkedOpportunityId`, each nullable, each a reference. |
| `hold`, `cancelReasonCode`, `closeReasonCode` | The reason a terminal or paused state was reached, from a closed code list. |
| `history[]` | Append-only. The audit and every party's timeline are both projections of this. |
| `createdAt`, `updatedAt`, `rev`, `revMeta`, `clientKeys` | Concurrency and idempotency, using the canonical M18.1/M18.2 helpers. |

`playerId`, `engagingOrgId` and `releasingOrgId` exist as **derived** convenience
fields computed from `parties[]` on every projection. They are never written
independently, so they cannot drift from the party list.

No speculative field was added. There is no fee amount, no commission, no salary,
no escrow and no payment reference anywhere in the row.

## 3. Party model

A party is a row in `parties[]`:

```
{ id, partyRole, subjectKind, subjectId, addedAt, addedBy,
  confirmedAt, confirmedBy, removed, removedAt, removedBy,
  subjectRemovedAt, history[] }
```

`partyRole` is one of the three frozen P5.6A roles: `individual`,
`engaging_entity`, `releasing_entity`. `subjectKind` is `player` or `club`, and
the pairing is enforced: a player cannot occupy an entity role and a club cannot
be the individual. One party per role. A releasing entity is permitted only for
`transfer` and `loan` (`RELEASING_PARTY_TYPES`); an employment contract with one
is refused.

Identity is by canonical id. A name is resolved at projection time from the live
player or org record, so a removed account has no name to show and nothing is
copied to go stale.

### Party confirmation

Creating a transaction confirms nobody. Each party confirms its **own**
participation:

- the individual, through the player app (`POST /player/transactions/:id/confirm`);
- each club, through its own verification console, and only by a recorded
  verification administrator — the club **signatory** (`SIGNATORY_REQUIRED`
  otherwise);
- the agent's act is a representation binding, not a confirmation.

`partiesConfirmed` is true only when every live party has its own `confirmedAt`.
Draft text entry is not confirmation.

## 4. Party history

Nothing about a party is overwritten invisibly.

- A party is never deleted: `removed`, `removedAt` and `removedBy` are set and
  the row stays, with its own `history[]`.
- Adding, confirming and removing a party each append to the transaction's
  `history[]` with the actor as a role.
- A party change recomputes `partyRevisionOf(...)` — a hash over the parties,
  the agent, the representations, the consents, the licence facets, the policy
  versions, the safeguarding state and the minor state. Any change makes the
  attached snapshot `INPUTS_CHANGED`, which is *stale by definition* rather than
  by a heuristic, and a stale snapshot authorises nothing.

## 5. Representation bindings: `transactionRepresentations`

The frozen P5.6A §5 store. One row binds `(transaction, agent, party role)`:

```
{ id, transactionId, agencyOrgId, agentUserId, partyRole,
  agreementId, basis, scope[], status, declaredOnly, reviewId,
  boundAt, boundBy, withdrawnAt, withdrawnBy, history[] }
```

`agreementId` is a **reference** into `representationAgreements`; the scope and
status are read through it at action time, never copied. Where no ScoutBox
agreement exists — typically a club mandate — the binding is recorded
`declaredOnly` with a `reviewId`, is not effective, and waits for an attributed
P5.6C review by a named reviewer.

`transactionRepresentations` is the truth. The compliance context's inline
`representations` array is the *evaluation projection*, rebuilt from this store
on every evaluation, so the two cannot disagree about who acts for whom.

Being generally active for a player is not authority for a transaction. Every
material mutation re-resolves the agreement, its scope, its status, the agent's
facets, the policy set, the conflict verdict and the consents at action time.

## 6. Documents and notes

`transactionDocuments` holds classification and provenance only — `documentType`,
`owner`, `transactionId`, `visibility`, `version`, `uploadedBy`, `createdAt`,
`expiresAt`, `signedAt`, `evidenceRef`, `supersededBy`. The bytes stay in the
canonical evidence store; the workspace holds a reference and re-authorises every
read. No duplicate file storage was created. Notes live on the transaction with
the same visibility classes, minus `T_AND_S_ONLY`. There is no global note
bucket.

See `M23_P56D_TRANSACTION_DOCUMENT_MODEL.md`.

## 7. Stores: new and reused

**New (3, all created empty by migration `m260_001_transaction_stores` at 2307):**
`agentTransactions`, `transactionRepresentations`, `transactionDocuments`.

Nothing is backfilled and no existing record is reinterpreted as a transaction.
All three are in `PRODUCTION_REQUIRED_STORES` with a `migration` guarantee.

**Reused, not duplicated:** `representationAgreements`, `regulatoryConsents`
(the P5.6C consent ledger — no second consent store exists),
`complianceContexts` and its evaluations, `jurisdictionPolicies`,
`regulatoryReviews`, the canonical Inbox (`channels`, `messages`), the canonical
upload/evidence path, the canonical audit and event registry, the canonical
notification preferences, the canonical rate limiter, the canonical
rev/idempotency helpers.

No store was created that a reference into an existing one would have served.

## 8. Relationships to other systems

| System | Link | Boundary |
| --- | --- | --- |
| Opportunities | `linkedOpportunityId` | Reference only. The opportunity's own history is not mutated. |
| Trials | `linkedTrialId` | Reference only. No trial assessment is exposed and no trial state semantics change. |
| Contact / Inbox | `linkedThreads[]` | A link records that a conversation exists and who shared it. Reading it still needs the Inbox's own authorisation; transaction membership is never enough. No message is duplicated. |
| P5 Decision | not linked | A club's internal decision row is not exposed and cannot open a transaction by itself. Any pathway must be an explicit shared action, which P5.6D does not implement. |
| Offer (P6) | `offerBoundary` | A computed readiness boolean plus named blockers. No offer record, no offer state, no offer route. |
| Signing | none | No `db.signings` writer. |
| Fees / payments | none | No fee amount, commission, escrow or clearing-house field or route. Deferred entirely. |

## 9. Minors

General minor discovery remains blocked. A transaction whose individual is a
minor fails closed: the pipeline returns the `MINOR_PATHWAY_DISABLED` gate, the
transaction cannot progress, and the guardian remains architecturally a distinct
party and consent actor rather than something the agent may stand in for. No
broad minor pathway was enabled and P5.6C was not weakened.

## 10. Retention and removal

No blanket permanent retention was invented. On player account removal the
transaction keeps its **shape** — ids, roles, states, times — and loses the
person: the party row is tombstoned, every actor label that named them is
emptied, their own documents leave the workspace, and every representation naming
them is withdrawn. Nothing is resurrected into a list, because a projection reads
the live record and finds none. Longer-term retention of regulated transaction
records is flagged for legal review rather than decided here.
