# M23 P7 — Signing privacy matrix

What each audience can read about a signing, and what never leaves the club
(§41–§47, §63, §64). Every "never" below is a sentinel sweep or an exact
assertion in m23SigningE2E (T, V, W), m23SigningPersistence and
m23SigningLive (B2e, D3b, D3e, N10).

## 1. Fields by audience

| Field | Club staff (case readers) | Addressed player | Agent (shared Offer) | Same-agency colleague / agency admin | Foreign club | T&S |
| --- | --- | --- | --- | --- | --- | --- |
| package id, status, revision number | ✓ | ✓ (presented revisions only) | ✓ | — (404) | — (404) | ✓ |
| DRAFT package / unpresented revision | ✓ | **absent** | absent | — | — | ✓ |
| internal note | ✓ | never | never | — | — | ✓ |
| document label / filename / mime / bytes | ✓ | ✓ | never | — | — | ✓ |
| document SHA-256 | ✓ | ✓ (their `nextAction` names it) | never | — | — | ✓ |
| document bytes | ✓ (`/document`) | ✓ (presented revision, `/player/signings/:id/document`) | never | — | — | on request |
| executed document | ✓ | never (it is the club's evidence) | never | — | — | ✓ |
| parties: type, status, instant | ✓ | ✓ | ✓ | — | — | ✓ |
| who completed a party | name for the club signatory; kind for the player | kind only, never a name (not even their own echoed back) | never | — | — | ✓ |
| contract days | ✓ | ✓ | ✓ | — | — | ✓ |
| cancel / void reason | ✓ | never | never | — | — | ✓ |
| `rev` (concurrency token) | ✓ | never | never | — | — | ✓ |
| Offer terms, decision rationale, transaction id | ✓ (their own) | the terms they accepted, on the Offer | terms on the shared Offer | — | — | — |
| the word "blocked" | ✓ (club-facing refusals) | never | never | — | — | — |
| completed record (`db.signings` row) | ✓ (`/org/signings`) | the completion (instant + contract days) | completed instant | — | — | ✓ |

## 2. Concealment (§64, #41, #42)

A package that does not exist, one in another organisation, one addressed
to another player, one an agent is not entitled to, and a document on a
revision the caller may not read all answer **the same body**:
`404 SIGNING_NOT_FOUND` / `404 SIGNING_DOCUMENT_NOT_FOUND`. A real hidden
package and an invented id are byte-identical (E2E G14). Evidence rows for
signing documents are `organisation_internal` in the m14 vault with
`meta.signingPackageId`; the m14 evidence routes never serve them to a
recipient.

## 3. Events (§46, §47)

Seven events, all `org_private`: `signing_created`, `signing_ready`,
`signing_party_completed`, `signing_completed`, `signing_cancelled`,
`signing_voided`, `signing_superseded`. Payloads carry ids and, on
`signing_party_completed`, the party **type** word — never a term, a
document, a digest, a name, a reason or a note (E2E V1, V3; registry rows
list their payload keys and the boot asserts every emitted name is
registered).

## 4. Notifications (§48, §49)

One type, `recruitment_signing`, in the `signing_updates` category (default
on, not mandatory). Texts name the club, the player and the act — "presented
a document for your signature", "confirmed the signing document", "has
signed for the club", "completed the signing" — never a term, a digest or a
note. A blocked club sends nothing to the player. The agent is told of a
completion only while their basis is current.

## 5. The completed record (§40, #40)

`db.signings` rows carry ids, instants, the digest, the contract days, the
parties' provenance summary (type, method, instant, actor kind) and the
legacy-compatible attribution fields. Never a term, a note, a name beyond
the legacy `playerName`/`orgName`/`scoutName` that every existing reader
already consumes, never bytes.

## 6. Client surfaces

The player app renders the digest in short form with the full value on the
element's accessibility label; the confirmation step shows the honest line
from the server. The agent app renders state, parties, revision and
contract days under the shared Offer and no control. The club app shows its
own note behind a 🔒 and never sends it anywhere a recipient reads.
