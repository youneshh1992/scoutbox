# M23 P6.1 — Offer privacy hardening

What each audience can learn about an Offer through every channel — the
API bodies, the SSE streams, the notifications, the journey, the
history, the documents, the error bodies and the three apps — re-proven
under drift (stale roles, ended mandates, same-agency colleagues, foreign
tenants, deleted players) and under hostile input (sentinel strings,
bidirectional controls, HTML). Nothing here changes the P6 privacy
matrix; it closes the seams around it.

## 1. Sentinels

Three sentinels ride through every hardening suite: an internal note
(`PRIVATE_NOTE_*`), a decision rationale (`PRIVATE_DECISION_*`) and a
transaction note (`PRIVATE_TX_NOTE_*`); a fourth, the recipient message
(`VISIBLE_MESSAGE_*`), must reach exactly the recipient and the shared
agent and nobody else. Sweeps: hardening I/L/N/T/V/Z and the live suite's
N10 sweep across the player app, the agent app, five notification
inboxes and every API each actor can call.

## 2. Channel by channel

| Channel | Club staff (same org) | Recipient | Shared agent | Same-agency colleague / admin / analyst | Foreign agency | Foreign club | Removed staff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Offer body | terms, note, message, documents, history, receipt, integrity report | terms, message, documents of the live and past issued revisions; never the note, never the decision | terms and state of shared Offers only; never the note; no accept control | nothing (404 on the relationship) | nothing (404) | nothing (404 identical to an invented id) | nothing (401) |
| Events (SSE) | six org-private events, ids + status word | none (a player stream carries no Offer event) | none | none | none | none | the open stream goes silent at removal |
| Notifications | one factual line + Offer id | one factual line + Offer id; "not a signing" | one factual line + Offer id; "their answer is their own act" | never notified (L2) | never | never | none |
| Journey / history | `offer.records` (id, type, status); Offer history with drafting lines | Offer history filtered to issued/answer lines (no drafting, no note) | none | none | none | none | none |
| Documents | by Offer id on issued revisions | by Offer id on issued revisions (a draft's documents are unreachable) | not through the projection | none | none | none | none |
| Error bodies | code + message + allowlisted fields; no stack, no row | same | same | `REPRESENTATION_NOT_FOUND` — the word "Offer" never appears | same | `ROOM_NOT_FOUND` / `OFFER_NOT_FOUND` byte-identical to an invented id | `ORG_AUTH_REQUIRED` |

## 3. Oracles closed

- **Existence oracle.** For every actor kind, the response to a real
  hidden id and to an invented id is byte-identical (status and body):
  foreign player read/document/accept, foreign club read/withdraw (J1).
- **Cross-Offer join.** A revision id from another Offer on this Offer's
  route is 404 — there is no join by `revisionId` (J2). A guessed document
  id is 404 `OFFER_DOCUMENT_NOT_FOUND` (J3, T3). A transaction id that is
  not the case's own is 400 `OFFER_INPUT_INVALID` (J4).
- **Case route.** A foreign club on `/org/rooms/:id/offers` gets the
  case's own 404 (J5).
- **Same-agency.** Bea, Cal (analyst) and Alex (admin) on Ana's client:
  403/404 with no Offer id, no term, no revision word (I1); the
  per-Offer route does not exist for anyone (I2); a foreign agency is 404
  on the relationship (I3, with a second agency seeded).
- **Timing oracle.** An expired Offer reads EXPIRED for both sides from
  the same stored ISSUED row; no read writes anything (E7–E9).

## 4. Client-supplied authority

A body that claims `actorType`, `actorId`, `playerId`, `isAdult`,
`canAccept`, `occurredAt` or `status` changes nothing; the wrong player
is told 404, the right player's act is recorded from the session only
(T1, T2; source sweep in group T). The three apps read the session and
never send those fields.

## 5. Hostile text

- Bidirectional overrides and zero-width characters are stripped from
  every free-text field (D-P61-3), so a term cannot be made to read
  backwards in one app and forwards in another.
- Unicode letters, accents and non-Latin scripts are kept as typed.
- HTML is inert: no Offer surface uses `dangerouslySetInnerHTML`
  (source sweep); the browsers render `<b>` and `<script>` as text.
- Oversize bodies are refused before parsing by the 20 MB limit and by
  each field's own limit; an oversize term is 400 `OFFER_INPUT_INVALID`
  with the field named.

## 6. Deleted player (§65, §66)

When a player deletes their account, m28's `onPlayerDeleted` (new in
P6.1) nulls the actor name and the reason on their responses and the
name on their history lines, and marks the Offer's subject removed; no
new revision, issue or share is written about a person who left
(`OFFER_SUBJECT_REMOVED`). The Offer's own record — terms the club wrote,
the fact of an acceptance — stays, because it is the club's record of
its own act.

## 7. Agent projection, hardened

- Licence consulted at read (D-P61-2) — an agent whose FIFA facet is
  inactive reads nothing until re-verified; nothing is deleted meanwhile.
- Temporal fail-closed: an agreement confirmed after the instant a read
  asks about is not active at that instant (C3a).
- Un-share works after the representation ended (D-P61-8), so a client
  is never stuck with a share they cannot withdraw.
- A revoked agent's deep link in the agent app shows no term, no
  revision and no message, and says why in the app's own words (live
  S4e–S4f); the same link for a same-agency colleague shows nothing and
  names no client (live S4h).

## 8. What the recipient is told, and what they are not

The recipient is told: the club's name, the exact live revision and its
number, its expiry, the message, the documents, whether it is
answerable and — new in P6.1 — that it is not answerable because the
club paused the case (`notAnswerableReason: 'CASE_PAUSED'`, P8). The
recipient is never told: the internal note, the decision, the readiness
codes, the transaction, who at the club drafted, or that a draft exists.
