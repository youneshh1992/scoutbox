# M23 P7 — Document integrity

The document a party confirms is identified by the SHA-256 of its exact
bytes; a party confirms that digest; a changed document is a new revision.

## 1. Attaching (§20, §21)

`POST /org/signings/:id/document` (DRAFT only) and `POST …/executed-document`
(READY / IN_PROGRESS) take `{ dataUrl, filename, label, expectedRev }`.

1. m14 `storeEvidenceFile(dataUrl, filename, req)` validates the data URL, the
   mime (PDF / PNG / JPEG / WebP), the size and the magic bytes, stores the
   blob in the media vault and returns `{ mediaId, sha256, mime, bytes, filename }`.
2. m29 **recomputes** the SHA-256 of the base64 payload's bytes and refuses
   `SIGNING_DOCUMENT_INVALID` if it differs from what the vault recorded
   (defence in depth: the digest a party will confirm is computed from the
   bytes that arrived, independently of the vault).
3. m14 `addEvidence` files a `verEvidence` row: `type: 'document'`,
   `source: 'club_upload'`, `visibility: 'organisation_internal'`,
   `retention: 'until_signing_resolution'`, `meta: { signingPackageId, signingDocumentKind, label }`.
4. The revision's `document` (or `executedDocument`) becomes
   `{ id, evidenceId, sha256, filename, mime, bytes, label }`.

D-P7-1 (fixed R1): m14 hashed `String(buf)` — a UTF-8 decoding of the file —
so two different binaries could share a digest and a signing document's
digest did not name its bytes. It now hashes the exact buffer
(`crypto.createHash('sha256').update(buf)`), and E2E G5/G6 prove identical
bytes → identical digest, a changed byte → a different digest (#21).

## 2. Immutability (§8, §20, #18, #19)

- A document can be attached or replaced only in DRAFT (`canAttachDocument`).
- Presenting freezes the revision: no route mutates a presented revision's
  document; `POST …/document` on READY/IN_PROGRESS is refused by state.
- A different document is `POST …/supersede`: a new DRAFT revision with the
  same contract days and every party pending; the old revision is
  SUPERSEDED with a pointer both ways; confirmations given on it no longer
  count (H2, H4, H5).
- A completed package refuses every mutation (K9).

## 3. Confirmation names the bytes

The recipient's `nextAction` carries `{ revisionId, documentSha256 }`; the
player app shows the digest and sends it back; the server compares it
case-insensitively to the current revision's digest and refuses
`SIGNING_DOCUMENT_MISMATCH` otherwise (D4, H5, live B2b). The club signatory
does the same. The completion gate re-checks that every completed party's
`evidenceRef.documentSha256` equals the revision's digest (`DOCUMENT_MISMATCH`).

## 4. Serving the bytes (§41, §43)

`GET /org/signings/:id/document?kind=executed&revisionId=…` (club staff who
can read the case) and `GET /player/signings/:id/document?revisionId=…`
(the addressed player, presented revisions only) return
`{ document: { id, label, filename, mime, bytes, sha256 }, file: { mime, base64 } }`
from the vault. The evidence row's `orgId` must match the package's; a
document on a revision the caller may not read is `SIGNING_DOCUMENT_NOT_FOUND`
(the same body as a non-existent one). The agent never receives bytes or a
digest.

## 5. Proof surface

The live suite computes the SHA-256 of the PDF it uploads through the club
app's file input and asserts the club tab's `data-sha256`, the player's
`nextAction.documentSha256`, the player section's accessibility label and
the completed revision's digest all equal it (live A8b, B2b, B2c, C6c).
