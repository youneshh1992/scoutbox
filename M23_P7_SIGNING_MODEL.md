# M23 P7 — Signing model

The principle this milestone builds and proves:

    Offer accepted ≠ signing opened ≠ party confirmed ≠ signing completed

An accepted Offer opens the door to a signing and creates none. An explicit
club act opens a signing **package** over the exact accepted Offer revision.
The club attaches the exact document and presents it; each required party
confirms that exact document, as themselves; only the canonical completion —
a second explicit act by a recruitment lead, behind the completion gate —
writes the completed-signing record, moves the case to `signed` and marks
the player `under_contract`. ScoutBox records the workflow and the evidence
each party gives. It does not execute the agreement and claims no legal
effect beyond what it records (§103).

## 1. Two stores, two meanings

| Store | Meaning | Guarantee | Owner |
| --- | --- | --- | --- |
| `db.signingPackages` | the signing **workflow**: a package per (Offer, attempt), with its revisions, parties, documents, keys and history | migration `m280_001_signing_workflow` (2307 → 2308) creates the empty container; nothing is backfilled or reinterpreted | m29 |
| `db.signings` | the **completed signing record** — one row per completed package (or per legacy recording), the fact every existing reader already consumes | core store (pre-P7) | the ONE writer in m29 (`recordCompletedSigning`) |

A package in any state other than COMPLETED has no `db.signings` row. A
COMPLETED package has exactly one, referenced from `pkg.completion.signingId`
and carrying `signingPackageId` back. The two are never the same object and
never merged (M23_P7_CONTRACT_STATUS_SEMANTICS.md).

## 2. The package row

```
{
  id: 'spk-…', orgId, caseId, playerId, offerId, offerRevisionId, transactionId,
  status: 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'VOIDED',
  currentRevisionId, revisions: [ …revision ],
  expiresAt (instant, ≥ 1 h and ≤ 90 d after creation, default 30 d),
  internalNote (club-private, never projected to a recipient or an agent),
  keys: { start, ready[], party[], cancel[], void[], supersede[], complete[] },
  history: [ { id, at, action, by, detail } ],   // append-only
  completion: null | { signingId, completedAt, completedBy, contract, documentSha256, lifecycle },
  cancelledAt/By/Reason, voidedAt/By/Reason,
  createdAt, createdBy, updatedAt, rev, revAt, revBy, policyVersion
}
```

`EXPIRED` is **derived**, never stored: `effectiveStatus(pkg, now)` reads
EXPIRED for a live package whose `expiresAt` has passed (§36). `SUPERSEDED`
is a revision status only.

## 3. The revision

```
{
  id: 'spr-…', revisionNumber (monotonic from 1),
  status: 'DRAFT' | 'READY' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'VOIDED' | 'SUPERSEDED',
  createdAt/By, readyAt/By, completedAt/By,
  document: null | { id, evidenceId, sha256, filename, mime, bytes, label },
  executedDocument: null | { …same shape },
  contract: { startDate: DATE_ONLY, endDate: DATE_ONLY | null },
  requiredParties: [ { partyType, forEntityId, forPlayerId, status, completedAt, completedBy, method, evidenceRef } ],
  policySnapshot: { policyVersion, jurisdiction, offerPolicyVersion },
  supersedesRevisionId, supersededByRevisionId
}
```

A revision is editable only in DRAFT (contract days, internal note, the
document). Presenting it (`READY`) freezes it: the document, the digest and
the parties on a presented revision never change in place. A changed
document is a **new revision** (supersede), on which every party must confirm
again (§8, §69). Old revisions stay on the package as history.

## 4. The Offer precondition (§9)

A package is opened only over an Offer whose canonical status is `ACCEPTED`
and whose accepted revision is `ACCEPTED`, on a case at `offer_accepted`,
with a recipient the pathway allows. `offerRevisionId` binds the package to
that exact revision; a package bound to a revision the Offer does not hold,
or one superseded, withdrawn or answered with a decline, is corruption
(`OFFER_REVISION_MISMATCH`, R4). The accepted Offer is immutable while a
package exists over it (§66): the Offer domain refuses withdraw, revise and
re-issue on an ACCEPTED Offer regardless.

## 5. What the club, the recipient and the agent read

| View | Carries | Never carries |
| --- | --- | --- |
| `signingClubView` | everything above, the note, actor names, `rev`, integrity problems | bytes |
| `signingRecipientView` | presented revisions only, the digest, the parties by kind, `nextAction`, `honest` | the note, unpresented revisions, `rev`, club user names, the word "blocked" |
| `signingAgentView` | state, revision number, parties (type/status/at), contract days, `clientActionRequired` | the note, the digest, any name, bytes |
| `signingHistoryView(forRecipient)` | actions with kind and instant | draft/note/internal actions; org user names |

## 6. Limits (`SIGNING_LIMITS`)

Expiry ≥ 1 h and ≤ 90 d from creation (default 30 d); contract end ≤ 10 years
after the start; label, reason and internal note are short text with bidi
controls stripped (`cleanText`); one live package per Offer; one completed
package per Offer.

## 7. What P7 does not build (§19, §57)

No external e-signature provider, real or faked. No qualified electronic
signature. No cryptographic signature of the document by a party's key. The
two methods are `PLATFORM_ACKNOWLEDGMENT` (an authenticated account holder
confirms the exact digest) and `UPLOAD_EXECUTED_DOCUMENT` (the club attaches
an executed document as evidence beside the acknowledgments; it completes
nothing by itself, #17).
