# M23 P7 — Signing party model

Who must sign, derived — never typed — from the accepted Offer revision's
recipient snapshot; who may complete each party; and what a completion is.

## 1. Required parties (§16)

`requiredPartiesFor({ recipientType, playerId, guardianId, orgId })` at
package start, frozen on every revision:

| Recipient of the accepted Offer | Required parties |
| --- | --- |
| the adult player (`recipientSnapshot.type = 'player'`) | `PLAYER` (forEntityId = the player) + `CLUB_SIGNATORY` (forEntityId = the club) |
| a guardian (`type = 'guardian'`) | `GUARDIAN` (forEntityId = the guardian) + `CLUB_SIGNATORY` — **never reached in this build**: the minor pathway is closed in every jurisdiction and `canStart` refuses `SIGNING_PATHWAY_CLOSED` |
| anything else | `SIGNING_RECIPIENT_INVALID` |

No optional party, no "witness", no agent party (§15). A package with no
required party is corruption (`parties`); a package cannot complete with a
party pending (`PARTIES_INCOMPLETE`, #16, #26).

## 2. Who completes which party (§12, §13, §14, §15, §39)

| Party | Actor kind allowed (`PARTY_ACTOR_KINDS`) | Identity recorded |
| --- | --- | --- |
| `PLAYER` | `player` — the authenticated player whose id is `forEntityId` | `{ kind: 'player', id, name }`; the recipient view echoes the kind only |
| `GUARDIAN` | `guardian` — dormant | — |
| `CLUB_SIGNATORY` | `org` — a **recruitment lead** (`isLead`) of the package's organisation | `{ kind: 'org', id, name }` under their own name; the club sees it, no recipient does |

An agent cannot complete any party: no route accepts an agent session for
a party, and the gate refuses the `org` kind on `PLAYER` (E2E A22, D7, F7,
#10, #11). A room lead who is not a recruitment lead cannot sign for the
club (C9). A guardian cannot sign for an adult (E1–E4, #14). Nobody signs
by proxy; nobody's identity comes from the body.

## 3. A completion (§17)

`POST /player/signings/:id/complete` and `POST /org/signings/:id/parties/club/complete`
carry `{ revisionId, documentSha256, clientKey, method? }`:

- `method` must be `PLATFORM_ACKNOWLEDGMENT` (the only party method; `SIGNING_METHOD_UNKNOWN` otherwise);
- `revisionId` must be the **current** revision (`SIGNING_SUPERSEDED` for an older one, #18, #30);
- `documentSha256` must equal the current revision's document digest (`SIGNING_DOCUMENT_MISMATCH`, #18);
- the party must be pending (`SIGNING_PARTY_ALREADY_COMPLETED`, #34);
- the case must still be at `offer_accepted` (`SIGNING_LIFECYCLE_CONFLICT`);
- the club must not be blocked by the player (club: `SIGNING_BLOCKED`; recipient: `SIGNING_STATE_INVALID`).

On success the party becomes `COMPLETED` with `completedAt` = the server
instant (a body timestamp is ignored, #43), `completedBy`, `method` and an
`evidenceRef` (M23_P7_SIGNING_EVIDENCE_MODEL.md). The revision and the
package move READY → IN_PROGRESS on the first confirmation. A confirmation
is **not** a signing: no `db.signings` row, no lifecycle move, no
`under_contract` (#22, E2E D12, J5; live B5e, C4b).

## 4. Re-authorisation (§38, §80)

Every completion re-derives the actor's standing at that instant: a demoted
lead cannot sign for the club, a player whose case the club paused cannot
confirm, an expired package refuses every party (`SIGNING_EXPIRED`). A
package presented on revision 1 and superseded keeps revision 1's
confirmations as history and requires every party again on revision 2
(H2, #18).

## 5. What the parties see of each other

The club sees the player's confirmation as a fact (instant, kind). The
player sees "Club signatory · confirmed <instant>" — never the lead's name.
The agent sees the party types and their status only.
