# M23 P7 — Signing evidence model

What ScoutBox records when a party signs, what it can therefore prove, and
what it does not claim (§18, §40, §56–§62, §103).

## 1. Two methods, one honest scope (§56)

| Method | Who | What it records | What it proves |
| --- | --- | --- | --- |
| `PLATFORM_ACKNOWLEDGMENT` | the authenticated party (player, or the club's recruitment lead) | that this account holder, in an authenticated session, confirmed the exact document identified by its SHA-256, at the server instant | provenance and intent as far as the account and session go |
| `UPLOAD_EXECUTED_DOCUMENT` | the club (manage) | an executed document attached to the presented revision as evidence, with its own digest | that the club filed this document beside the acknowledgments; it completes nothing by itself (#17) |

No external provider, no qualified electronic signature, no notarisation,
no government verification, no claim of validity in every jurisdiction
(§57, §103). The `honest` line on every recipient view says so, and the
club's completion note says what completing does in ScoutBox terms.

## 2. The evidence reference (§61)

A completed party carries:

```
evidenceRef: {
  kind: 'platform_acknowledgment', id: 'sgev-…',
  revisionId, documentSha256,           // the exact revision and the exact bytes confirmed
  at,                                   // the server instant (client clocks are never authoritative, #43)
  actorKind, actorId,                   // the authenticated session, never a body claim
  session: 'authenticated'
}
```

plus `method`, `completedAt`, `completedBy { kind, id, name }`. The record
is immutable: a presented revision's document cannot change (#19), a
completed package refuses every mutation (K9), and integrity names any
tampering (`party_evidence`, `party_before_ready`, `party_actor_kind`,
`completed_before_parties`).

## 3. Authenticity checks on the record (§40, §35)

`signingIntegrity` refuses on read and on write, omits from every
projection and never repairs:

- a completed party without `completedAt`, `completedBy`, a known `method` and an `evidenceRef`;
- a party completed before the revision was presented (`party_before_ready`, #45);
- a party completed by a kind that cannot complete it (`party_actor_kind`, #10);
- a revision completed before its last party (`completed_before_parties`, #46);
- a presented revision without a document (`presented_without_document`);
- a COMPLETED package without its `completion` record, or a completion on a non-completed package.

`completionGate` re-checks the same facts against the current revision at
completion time (`EVIDENCE_INVALID`, `DOCUMENT_MISMATCH`, `TEMPORAL_ORDER`).

## 4. The completion gate (§22)

Only an empty problem list lets the canonical completion run. The list can
name: `STATE_UNKNOWN`, `ALREADY_COMPLETED`, `EXPIRED`, `STATE_<terminal>`,
`REVISION_MISSING`, `REVISION_NOT_ACTIVE`, `DOCUMENT_REQUIRED`,
`PARTIES_INCOMPLETE`, `EVIDENCE_INVALID`, `DOCUMENT_MISMATCH`,
`TEMPORAL_ORDER`, `CONTRACT_DATES_INVALID`, `OFFER_NOT_ACCEPTED`,
`OFFER_REVISION_MISMATCH`, `REFERENCE_MISMATCH`, `CASE_MISMATCH`,
`LIFECYCLE_CONFLICT`, `CONFLICTING_COMPLETED_SIGNING`, `BLOCKED`. The
refusal names the first problem's code and returns the whole list as
`blockers`.

## 5. What the completed record keeps (§23)

The `db.signings` row written by the ONE writer names the package, the
revision (id and number), the Offer and its revision, the case, the
transaction, the document digest and evidence id, the executed document's
evidence id when filed, the contract days, the parties' provenance summary
(`partyType`, `method`, `completedAt`, `byKind`), `method: 'CANONICAL_COMPLETION'`,
`signedAt`/`ts` (the completion instant) and the legacy attribution fields.
The package keeps `completion { signingId, completedAt, completedBy,
contract, documentSha256, lifecycle }`. Both survive a restart byte-for-byte
(E2E Z8, Z9; persistence 2–3).

## 6. Dual control (§60)

Completion requires a **different act** from the club's signature: the
recruitment lead signs for the club (a party completion) and then completes
(the canonical completion), each behind its own confirmation, each with its
own key and rev. The player's confirmation is theirs alone. No single
request both confirms and completes.
