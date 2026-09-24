# M23 P7.1 — Signing document integrity audit

What binds a signature to a document after P7.1, attack by attack (§5–§11,
§43–§47). Codes refer to M23_P71_SIGNING_DEFECT_REGISTER.md; proofs to
m23SigningHardeningE2E (H), m23SigningPersistence (P) and
m23SigningHardeningLive (L).

## 1. The chain

```
bytes on disk  ──sha256──▶  vault row (verEvidence: sha256, orgId, meta.signingPackageId)
                               │ evidenceId
                               ▼
                    revision.document { evidenceId, sha256 }   ◀── the party confirms THIS digest
                               │
                               ▼
        party.evidenceRef { revisionId, documentSha256, actorKind, actorId, at }
                               │
                               ▼
        db.signings row { documentSha256, documentEvidenceId, signingRevisionId }
```

Every link is checked, in both directions, at every act that depends on it:

| Check | Where | Since |
| --- | --- | --- |
| the digest is SHA-256 of the exact bytes | m14 `storeEvidenceFile` (D-P7-1) and m29 recomputes it from the arriving bytes | P7 |
| the vault row is this package's own (`meta.signingPackageId`) and this org's | `documentBytesProblem` | **P7.1 (H-P71-1)** |
| the vault row's digest equals the revision's | `documentBytesProblem` | P7.1 |
| the bytes on disk hash to the revision's digest | `documentBytesProblem`, at present, party completion, completion and serve | P7.1 |
| the party's evidence names this revision, this digest, this actor, this instant | `signingIntegrity` (`party_evidence_*`) | P7.1 |
| the completed party's digest equals the revision's | `completionGate` `DOCUMENT_MISMATCH` | P7 |
| the row's digest equals the revision's | written from the revision inside the unit of work | P7 |

## 2. Attacks and outcomes

| Attack | Outcome | Proof |
| --- | --- | --- |
| swap the bytes on disk after the player signed (same vault id) | document not served to anyone (500 `SIGNING_STATE_UNKNOWN`), club signature refused, completion refused, no row, case unchanged; the package still reads and can be cancelled/superseded; restoring the bytes restores everything with no repair | H B5–B13; P 5.1 |
| same filename / MIME / size, one byte changed | a different digest (pure) | H B4 |
| replace the presented document in place | refused by state (`SIGNING_STATE_INVALID`): attach is DRAFT-only | H B3, J9; L E2–E3 |
| point the revision at another package's vault row (same digest, same bytes) | `foreign` → cannot be presented, cannot be served | H B15–B16 |
| read another player's document through their package | 404 (concealed) | H B17, T2 |
| edit the revision's stored digest | `digest_mismatch` (row vs revision) → the player confirming either digest is refused; the bytes are not served; completion cannot happen; the club can still cancel | H C1–C6 |
| PDF extension with PNG bytes, or declared PDF with HTML bytes | `FILE_SIGNATURE_MISMATCH` / `FILE_CONTENT_UNRECOGNISED` from m14 sniffing (magic bytes) | P7 G3; m14 rules |
| an 8 MB + 1 file | `FILE_TOO_LARGE` (8 MB limit); above the 20 MB JSON body limit the request is refused by the body parser before any code runs | m14 rules; express limit |
| `../`, absolute paths, separators in the filename | `FILENAME_INVALID` (no traversal, ever); the stored file is named by the vault id, the original name is metadata only, sliced to 120 chars | m14 rules |
| `.svg`, `.html`, `.js`, `.exe` names | `FILE_TYPE_NOT_ALLOWED` regardless of bytes | m14 rules |
| a label with `<script>` or bidi controls | `cleanText` strips control and bidi characters and bounds the length; every client renders labels as text (React text nodes, RN `Text`) | P7 A43; L (no page errors) |
| generic media route with a vault id | serves player media only; a vault id is 401/404 | H T7 |

## 3. Immutability after completion

A COMPLETED package refuses edit, attach, executed-document, ready, party
completion, cancel, void, supersede and T&S void (P7 K9; H T6; the admin
route's `canVoid`/`canCancel` both fail on COMPLETED). The row is never
rewritten: a restart finds it byte-identical (P 3.7); a duplicate row, a
missing row or a row naming a package that did not complete is corruption
that refuses the package rather than "fixing" it (H P5–P13; P 5.2–5.5).

## 4. What the digest proves and does not prove

It proves that the bytes a party confirmed are the bytes on record, and
that nobody swapped them afterwards without detection. It does not prove
the party read the document, understood it, or had the capacity to agree;
ScoutBox records the act and the evidence, and says so in the honest line
on every recipient view (§103).
