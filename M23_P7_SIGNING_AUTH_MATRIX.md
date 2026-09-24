# M23 P7 — Signing authorization matrix

Authority is re-derived on every request from the authenticated session:
the club role on the case (`roleFor` → `roomCan`), the recruitment-lead flag
(`isLead`), the addressed player's own session, the agent's own agreement
plus the integration decision, scope and licence. Nothing in a request body
names an actor; nothing a client rendered is authorization (E2E C, D, F, U;
live A11, F3).

## 1. Club

| Act | Scout / member | Room lead | Recruitment lead (`isLead`) | Foreign club |
| --- | --- | --- | --- | --- |
| read the case's signing surface, a package, its history, its document | ✓ (`offer_view`) | ✓ | ✓ | 404 `ROOM_NOT_FOUND` / `SIGNING_NOT_FOUND` |
| open a package | 403 `SIGNING_NOT_PERMITTED` | ✓ (`offer_issue`) | ✓ | 404 |
| edit the draft, attach the document, present, supersede, cancel, attach executed document | 403 | ✓ | ✓ | 404 |
| sign for the club (`CLUB_SIGNATORY`) | 403 | 403 (E2E C9) | ✓, under their own name | 404 |
| complete | 403 | 403 | ✓ | 404 |
| void | 403 | 403 | ✓ | 404 |

A role removed after the page loaded is gone on the next request (E2E C12,
#37): the demoted lead's session cannot act on the package he opened.

## 2. Player

| Act | The addressed adult (party `PLAYER`, `forEntityId` = their id) | Another player | A minor's own session | A guardian |
| --- | --- | --- | --- | --- |
| list / read a presented package, its document | ✓ | 404 `SIGNING_NOT_FOUND` | nothing is ever addressed to them | list `[]` with the closed-pathway note; read 404 |
| confirm (`PLATFORM_ACKNOWLEDGMENT`, the exact revision and digest) | ✓, once | 404 | — | 422 `SIGNING_PATHWAY_CLOSED` on a package addressed to them, 404 otherwise |
| anything on a club route | 401 | 401 | 401 | 401 |

The actor kind is enforced twice: `PARTY_ACTOR_KINDS` in the party gate
(a player session completes only `PLAYER`; an org session only
`CLUB_SIGNATORY`; a guardian session only `GUARDIAN`) and again on the
record (`party_actor_kind` is corruption, #10).

## 3. Agent

| Condition | Result |
| --- | --- |
| own, active, client-confirmed agreement + `client_private` decision allowed + scope includes employment or transfer + licence current + the client shared the Offer + a revision was presented | read-only `signingAgentView` under `/org/agent/clients/:id/signings` |
| same agency, not the representing agent (Bea) | 404 `REPRESENTATION_NOT_FOUND` |
| agency admin | 404 / 403 `AGENT_ACTION_NOT_PERMITTED` on a summary row |
| scope without employment/transfer | 403 `SCOPE_INSUFFICIENT` |
| licence lapsed | 403 `LICENCE_NOT_CURRENT` (E2E F8, #13) |
| agreement terminated by the client | 403 `REPRESENTATION_NOT_ACTIVE`; the app's deep link shows no access (live E) |
| any write | there is no route: `POST /org/agent/clients/:id/signings/:sid/complete` is 404 (#10) |

## 4. Trust & Safety

`POST /admin/signings/:id/void` requires a named reviewer (`req.reviewer`)
and a recorded reason; it voids a READY/IN_PROGRESS package (or cancels a
DRAFT). T&S is never a party and never completes a signing.

## 5. Grassroots

A grassroots organisation reaches no signing route: `/org/rooms/:id/signing`
is a Pro workspace surface (`orgRouter` under the club product); the legacy
`POST /org/players/:id/signing` remains for a grassroots recruitment that
never went through an Offer (M23_P7_LEGACY_COMPATIBILITY.md).

## 6. Cross-cutting refusals (in order of evaluation)

1. authentication (401)
2. concealment: package/Offer/case not in the caller's organisation or not addressed to them → 404
3. integrity / consistency of the row → 500 `SIGNING_STATE_UNKNOWN` (never a leak of what is wrong)
4. role / lead / actor kind → 403 `SIGNING_NOT_PERMITTED`
5. `clientKey` shape, `expectedRev` presence → 400
6. idempotent replay → the same answer; conflicting replay → 409
7. subject removed → 409 `SIGNING_SUBJECT_REMOVED`; block → 403 `SIGNING_BLOCKED` (club) / 409 `SIGNING_STATE_INVALID` (recipient, never the word "blocked")
8. state gate (`canStart` / `canAttachDocument` / `canMarkReady` / `canCompleteParty` / `completionGate`) → the named 409/422
9. lifecycle (`offer_accepted` required) → 409 `SIGNING_LIFECYCLE_CONFLICT`
10. rate policy → 429 (`signing_start` 30/h per org, `signing_document_write` 120/h per org, `signing_party_completion` 30/h per actor, `signing_closure` 30/h per org)
