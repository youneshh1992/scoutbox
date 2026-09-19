# M23 P5.6D — Transaction document model

## 1. No second file store

`transactionDocuments` holds **classification and provenance**. The bytes live
where they already lived: the canonical ScoutBox evidence/upload path, with its
existing magic-byte checks, size limits and scan status. A transaction document
row carries an `evidenceRef` into that store and nothing else of the file.

Consequences, all deliberate:

- No duplicate storage service, no second upload route, no second security model.
- A row with no `evidenceRef` is a **placeholder**: the classification exists, no
  file is attached, and the UI says "No file attached" rather than implying one.
- Fetching the file is a separate, re-authorised act. The reference route answers
  with the reference plus the sentence *"Holding this reference is not authority
  to read the file"*; there is no long-lived or signed URL to keep (§80).
- No executable upload path was introduced, because no upload path was
  introduced.

Digital **signing** is not implemented. `signedAt` exists as a field only for a
fact that is objectively known from outside ScoutBox, and no P5.6D writer sets it.

## 2. Row shape

```
{ id, transactionId, documentType, visibility, version, supersedes, supersededBy,
  owner: { kind, id }, uploadedBy, label, evidenceRef,
  createdAt, expiresAt, signedAt, evidenceCategory, removedAt, history[] }
```

| Field | Rule |
| --- | --- |
| `documentType` | one of nine (below). Not freeform. |
| `owner` | the party that filed it, as `{kind, id}` — used for "may I supersede this?". |
| `visibility` | one of nine classes. The server checks the caller may **write** that class; a body value it may not write is `DOCUMENT_VISIBILITY_NOT_PERMITTED` 403. |
| `version` | starts at 1; a new version supersedes rather than overwrites. |
| `uploadedBy` | actor, projected as a role. |
| `expiresAt` | nullable. An expired document reads as not found rather than as present-but-stale. |
| `signedAt` | nullable, only where objectively known. Never set by the workspace. |
| `evidenceCategory` | nullable, for regulatory evidence. |

## 3. Document types

`representation_agreement_reference`, `compliance_consent_reference`,
`guardian_evidence`, `mandate`, `term_sheet_draft`,
`employment_contract_draft`, `club_document`, `regulatory_evidence`,
`correspondence_attachment`.

The two `_reference` types exist so that a transaction can *point at* an
agreement or a consent that already exists in its own store, rather than copying
it. A draft term sheet and a draft employment contract are documents the parties
exchange; ScoutBox neither proposes, values, accepts nor validates them, and the
document tab says so.

## 4. Visibility classes

The nine classes, who they admit, and which are side-checked, are set out in
`M23_P56D_TRANSACTION_PRIVACY_MATRIX.md` §2. In summary:

`AGENT_PRIVATE`, `PLAYER_PRIVATE`, `ENGAGING_CLUB_PRIVATE`,
`RELEASING_CLUB_PRIVATE`, `PLAYER_AGENT_SHARED`, `ENGAGING_AGENT_SHARED`,
`RELEASING_AGENT_SHARED`, `ALL_TRANSACTION_PARTIES`, `T_AND_S_ONLY`.

The server never trusts a client-supplied class as an authority claim. It
resolves the caller's roles and side, computes the classes that caller may write,
and refuses anything else. `uploadableVisibilities` is narrower than what the same
caller may read:

| Caller | May write |
| --- | --- |
| representing agent | `AGENT_PRIVATE`, `PLAYER_AGENT_SHARED`, `ENGAGING_AGENT_SHARED`, `RELEASING_AGENT_SHARED`, `ALL_TRANSACTION_PARTIES` |
| individual / guardian | `PLAYER_PRIVATE`, `PLAYER_AGENT_SHARED`, `ALL_TRANSACTION_PARTIES` |
| engaging club signatory | `ENGAGING_CLUB_PRIVATE`, `ENGAGING_AGENT_SHARED`, `ALL_TRANSACTION_PARTIES` |
| releasing club signatory | `RELEASING_CLUB_PRIVATE`, `RELEASING_AGENT_SHARED`, `ALL_TRANSACTION_PARTIES` |
| anyone | never `T_AND_S_ONLY` |

The individual is specifically prevented from classifying anything into a
club-side class: the club lanes belong to the clubs and the agent.

## 5. Versioning and supersession

A new version is filed against the previous one:

- the caller must be able to see and to write that class;
- only the **owner** of a document may supersede it;
- `supersedes` / `supersededBy` chain the versions; nothing is overwritten and no
  version is deleted;
- a superseded document is excluded from the live list but stays in the record;
- `DOCUMENT_SUPERSEDED` 409 refuses a second supersession of the same version, and
  `DOCUMENT_VERSION_CONFLICT` 409 refuses a stale `expectedVersion`.

## 6. Timeline consequences

A document's timeline entry is `per_document`: it reaches exactly the parties the
document's own class admits (defect D11). So filing an `AGENT_PRIVATE` mandate
produces no entry in any club's or the individual's history, and filing an
`ALL_TRANSACTION_PARTIES` term sheet produces one for everybody. The entry's
detail carries the class and the document id, never the label.

## 7. Notes

Notes reuse the same classes minus `T_AND_S_ONLY` (`NOTE_VISIBILITY`). They live
on the transaction rather than in a store of their own, are capped in count and
length, and their audience is `audit_only` in the timeline — an internal note is
not a timeline entry for anyone, which is §39 read literally.

There is no global note bucket. Every note is scoped when it is written, and the
club UI says so before the field: *"a note kept to your own side is never shown to
the other club, to the individual or to the agent … a recorded note cannot be
unsaid."*

## 8. Working particulars ("terms")

`tx.terms.versions[]` records what the parties are working from, as a **summary**
scoped to a party, with a visibility class. It exists so the workspace is useful,
and it is bounded hard:

- no amount, no percentage, no commission, no salary, no escrow — there is no
  field for one;
- ScoutBox does not propose, value, accept or validate a version, and the tab
  says so;
- recording one is not an offer and not a signature, and the wording states it.
