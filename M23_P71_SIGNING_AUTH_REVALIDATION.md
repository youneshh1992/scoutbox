# M23 P7.1 — Signing authority revalidation

Where every signing actor's authority comes from, when it is re-derived,
and what happens the moment it changes (§12–§17, §25–§26). The principle:
**nothing a page loaded, a token minted or a key stored is authority; the
server derives it again from the store at every request.**

## 1. Club users

| Fact | Source, per request | Drift | Proof |
| --- | --- | --- | --- |
| membership | `orgAuth`: the session's `userId` must resolve to a user of the org with no `removedAt` | removed → 401 `USER_REMOVED` on the next request | platform (M18.1) |
| organisation standing | `org.suspended` → 403 | — | platform |
| role string | `db.users[…].role`, rewritten by the user's latest login | a login as First-Team Scout demotes the user for every open session; a login as Head restores | hardening E2–E9; live A3–A7 |
| recruitment lead (`isLead`) | regex over the current role string | as above | hardening E3–E5, L8 |
| room lead | `roomRole`: the case's `ownerUserId` / `leadScoutUserId` | `PATCH /org/rooms/:id { leadScoutUserId }` promotes / demotes | P7 C6–C12 (#37) |
| capability on the case | `roomCan(role, 'offer_view' | 'offer_issue')` | re-derived from the role above | all club routes |

A demoted Head who opened the room remains its **room lead**: she may still
manage (edit, present, cancel, supersede) but not sign for the club, void or
complete. A scout who is not the room lead can only read. The live suite
shows the open tab's controls disappearing on the next refresh and the act
itself refused by the server in between (live A4–A5).

## 2. Players

| Fact | Source | Drift | Proof |
| --- | --- | --- | --- |
| identity | the player session (`req.player`), never a body field | a body `playerId`, `actorId`, `actor`, `completedAt` or `method` is ignored (method must be the platform acknowledgment) | hardening F2–F4 |
| the package is theirs | the recipient party's `forEntityId` equals the session player; the package is sound and presented | another player's session → 404 on read, act and document | hardening F1, N2, O5, T2 |
| account deleted | `DELETE /player/account` → sessions invalid, `subjectRemovedAt` on the case → every club act refused `SIGNING_SUBJECT_REMOVED` | past evidence kept with the name nulled (`onPlayerDeleted`) | P7 S group (P6.1 rule) |
| block | `isBlocked(player, org)` re-read at present, party completion and completion | the club's acts refuse; the player reads state words only | P7 S; hardening G11 (agency block) |

## 3. Guardians (dormant)

The pathway table is closed in every jurisdiction and unknown ones; a
guardian session lists nothing, reads 404 and acts 422/404. `isAdult` on a
malformed, missing or future date of birth answers **false** — the protected
side — so a corrupt DOB can only close the adult path, never open a guardian
one (hardening H1–H5; P7 E).

## 4. Agents

| Fact | Source | Re-checked on | Drift | Proof |
| --- | --- | --- | --- | --- |
| own agreement | `findOwnAgreement` (the row names this agent) | every read | same-agency colleague / admin → 404 / 403 | hardening G4; live F4 |
| client-confirmed, active, in window | `basisFor` → `agentClientBasis` | every read | terminated / expired → 403 `REPRESENTATION_NOT_ACTIVE` | P7 U5; live F5–F7 |
| the decision for `client_private` | `decide`: basis, subject present, adult, blocks (agency and viewer org), disclosure, licence, compliance | every read | block by the client → 403 | hardening G11–G12 |
| scope | `basis.scope` includes employment or transfer | every read | narrowed → 403 `SCOPE_INSUFFICIENT` | P7 F |
| licence | `licenceCurrentFor` (verified facets for the jurisdiction) | every read | lapsed → 403 `LICENCE_NOT_CURRENT`; re-verified → open | hardening G7–G8 |
| the client's share | `offer.agentShare.agentUserId` | every read | withdrawn → the signing disappears at once | hardening G5–G6 |
| a presented revision | `revisions.some(readyAt)` | every read | a draft is the club's own | P7 F |
| any write | none exists: `POST …/signings/:id/complete` and every other write path is 404 | — | — | hardening G9 |

## 5. Deep links (§17)

A deep link is a URL; the page it opens fetches, and the server re-derives
authority for that fetch. Proven states: a demoted lead's room tab (live A),
a revoked agent's client tab (live F6, P7 live E), a stale club session
(P7 U3: 401), a cancelled / voided / expired / superseded package (the
player's section shows the state word and no control: live C, D; P7 AD8).
No signed URL exists for a signing document: bytes are fetched through the
authenticated routes only, and the generic `/media/:id` route serves player
media, never vault files (hardening T7).

## 6. Idempotency is not a capability (§25–§26)

Every keyed route runs `packageFor` (club) or `recipientPackage` (player)
**before** it looks at the key. A user who lost the role gets 403 before any
replay; restored, the replay returns the original result and writes
nothing (hardening L7–L9; P7 G17 lesson). A key is bound to the actor: the
same key from another actor is a conflict, never a replay of someone else's
act (hardening L4). A replay after the package moved returns the stored
result of the original act, which carries nothing the actor could not read
now.

## 7. Trust & Safety

`POST /admin/signings/:id/void` requires a named reviewer and a reason; it
voids READY / IN_PROGRESS (or cancels a DRAFT) and refuses a completed
package (`SIGNING_ALREADY_COMPLETED`). T&S is never a party and has no
document route.
