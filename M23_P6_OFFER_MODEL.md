# M23 P6 — Offer model

The canonical Offer domain lives in `scoutbox-server/m28/` (`offer.mjs` pure
domain, `errors.mjs` error contract, `index.mjs` routes). Everything below
is what the code does at the R2 tip, not an aspiration.

## 1. Identity

An Offer row on `db.recruitmentOffers`:

| Field | Meaning |
| --- | --- |
| `id` | `rof-…` |
| `orgId` | the issuing club (the case's organisation; never the request body's) |
| `caseId` | the recruitment case (`recruitmentCases.id`) the Offer belongs to |
| `playerId` | the case's player — the subject, never re-declared by the client |
| `type` | `direct_recruitment` (the only context this build models, §8) |
| `decisionId` | the finalized P5 decision to progress that stood when the Offer was drafted (reference only; its rationale never travels) |
| `transactionId` | an optional P5.6D transaction workspace the Offer is issued against (readiness re-evaluated at issue, §11) |
| `status` | the CURRENT revision's stored status |
| `currentRevisionId` | the club's working revision |
| `revisions[]` | embedded, append-only (see §3) |
| `responses[]` | the recipient's answers, one per answered revision |
| `readReceipts[]` | first-view receipts per revision and viewer — a receipt, not a status (§40) |
| `agentShare` | `{ agentUserId, agreementId, at, by }` or null — the adult client's explicit share with their representing agent (§12) |
| `keys` | `{ create, issue[], withdraw[], revise[] }` — idempotency keys live on the record and are never overwritten (§27) |
| `lifecycle` | the last case-move effect the Offer caused |
| `history[]` | append-only audit entries `{ id, at, action, by:{kind,id,name}, detail }` |
| `rev`, `revAt`, `revBy` | ONE optimistic-concurrency counter for the whole Offer (§28) |
| `createdAt`, `createdBy`, `updatedAt`, `policyVersion` | provenance |

No `opportunityId` is stored: the case already carries its source context,
and a duplicated reference would be a second truth.

## 2. Store decision — no migration (§4, §60)

`recruitmentOffers` was reserved by P2 as `guarantee: 'optional'` ("we
cannot answer that yet"). P6 makes it `guarantee: 'module', owner: 'm28'`:
`registerOffers` does `db.recruitmentOffers ??= []` at registration, on every
boot, exactly as M12–M16 create their collections. The schema stays at
**2307 with 17 migrations**.

Why not `m270_001_recruitment_offers` at 2308:

- nothing needs backfilling: no Offer existed before P6, and §62 forbids
  fabricating one from a lifecycle state;
- an empty list guaranteed by the module on every boot is exactly as durable
  as one guaranteed by a migration — the boot contract suite proves a
  module-owned store exists after the full composition and not after
  migrations alone (m23BootContract §12);
- two frozen suites pin `SCHEMA_VERSION === 2307` (m23AgentIntegrationE2E
  AN-p1/p2, m23AgentTransactionE2E AA2/AA3) as the statement "P5.6E/P5.6D
  added the last migration"; a P6 migration would have had to rewrite that
  frozen truth for no data benefit.

A snapshot from before P6 (the store simply absent) boots with an empty
store and every case exactly where it was (m23OfferPersistence §1).

## 3. Revision

Each revision (`rofr-…`) carries: `revisionNumber` (monotonic, never
reused), `status` (stored), `terms`, `recipientMessage`, `internalNote`,
`documents[]` (`{ id:'rofd-…', evidenceId, label, mime, bytes }`),
`expiresAt` (UTC instant, ms), `createdAt/By`, `issuedAt/By`,
`withdrawnAt/By`, `withdrawReason`, `respondedAt`, `response`,
`supersedesRevisionId`, `supersededByRevisionId`, `supersededAt`,
`recipientSnapshot` (who it was addressed to at issue: `{ type, playerId,
guardianId, minor, at }`), `readinessSnapshot` (the transaction readiness at
issue, or null), `rev` (an informational per-revision counter; the API
contract uses the Offer's rev).

Two derived notions, both pure functions in `offer.mjs`:

- **current revision** — the club's working one (`currentRevisionId`);
- **live revision** — the latest revision that was ever issued
  (`liveRevision`): what the recipient sees and may answer. While the club
  drafts revision N+1, revision N stays live and answerable; issuing N+1
  supersedes N; an answer to N discards the unissued N+1 draft (recorded as
  `offer_draft_discarded`) and makes N current.

## 4. Terms (§7) — deliberately narrow

`{ offerType, role, squad, startDate, endDate, conditions }`. Days are
DATE_ONLY strings validated by P5.7 `parseStrictDateOnly`; `startDate` is
required to issue; `endDate`, when present, must be after `startDate`. No
compensation, wage, fee or clause field exists and none is invented. Text
is trimmed, control characters stripped, bounded (80/80/1000).

## 5. Messages (§34)

`recipientMessage` (≤2000) reaches the recipient with the terms.
`internalNote` (≤2000) never leaves the club: not in the recipient view,
the agent view, any event, any notification, the journey or an error body.

## 6. Expiry (§20, §48, §49)

An instant with an explicit offset or `Z`, or integer milliseconds, through
P5.7 `parseInstant` — a bare local time is refused (the DST-nonexistent
hour cannot be stored). At issue it must lie ≥ 1 h and ≤ 180 d ahead of the
server's clock. Expiry is **lazy**: `effectiveRevisionStatus` reads a stored
ISSUED revision as EXPIRED once `isExpiredAt(expiresAt, now)`, and an
unreadable expiry reads EXPIRED (fail closed). Nothing is written when time
passes.

## 7. Documents (§31)

References to `db.verEvidence` rows owned by the issuing organisation, by
id, with a label. A recipient fetches a document by its Offer-side id
(`rofd-…`) only on an issued revision addressed to them; the bytes come from
the canonical storage adapter. The vault id never appears in a recipient
payload.

## 8. Views

| View | Who | Carries | Never |
| --- | --- | --- | --- |
| `offerClubView` | room readers (club) | everything incl. `internalNote`, `decisionId`, `transactionId`, `readiness`, `firstViewedAt`, `liveRevisionId`, `liveStatus`, `awaitingResponse` | assessment content, decision rationale |
| `offerRecipientView` | the addressed player / guardian | issued revisions, message, documents by Offer id, expiry, responses, `agentShared` | internal note, draft, decision/transaction ids, readiness blockers, withdraw reason |
| `offerAgentView` | the agent the client shared with | terms and state of issued revisions | documents, internal note, anything above |
| `offerHistoryView` | club; recipient (filtered) | ids, states, times, actor kind/name | draft/internal entries (recipient) |

## 9. Integrity

`offerIntegrity(offer, { orgId, caseId })` names structural problems
(wrong org/case, dangling current revision, duplicate revision ids, an
answered revision with no response row, an issued revision with an
unreadable expiry, an unknown type). A corrupt row is refused with a
generic 500 `OFFER_STATE_UNKNOWN`, omitted from recipient lists and from
the journey, and never repaired (m23OfferPersistence §4).
