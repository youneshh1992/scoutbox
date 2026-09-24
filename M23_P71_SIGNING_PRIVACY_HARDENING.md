# M23 P7.1 — Signing privacy hardening

The P7 privacy matrix re-attacked (§31, §44, §48–§52, §62–§66, §70–§71,
§73). Every row below is a check in m23SigningHardeningE2E (H),
m23SigningHardeningLive (L) or the P7 suites it re-proves.

## 1. Oracles (§31, §70)

| Probe | Real hidden id | Invented id | Identical body? | Proof |
| --- | --- | --- | --- | --- |
| foreign club: read, document, cancel, void, supersede, complete | 404 `SIGNING_NOT_FOUND` | 404 `SIGNING_NOT_FOUND` | yes, byte-identical | H O1–O3 |
| foreign club: start over the Offer | 404 | 404 | yes | H O4 |
| another player: read, act, document | 404 | 404 | yes | H O5, F1, N2, T2 |
| same-agency colleague / agency admin on the relationship | 404 `REPRESENTATION_NOT_FOUND` / 403 | — | nothing about the client's signing | H G4 |
| an agent on the club's routes | 404 `SIGNING_NOT_FOUND` (not 403) | 404 | yes | H G10 |
| expired agent, revoked guardian | 403 by their own standing / 404 | — | no package fact in the body | H G7, G12, H4 |
| a corrupt row | 500 `SIGNING_STATE_UNKNOWN` with a fixed message, no `revisions`, no `stack` | — | — | H R, P7 A10 |

No refusal reveals status, parties, document, expiry, player, club, Offer
or revision count of a package the caller may not read.

## 2. Draft and note (§48)

A DRAFT package or an unpresented revision is absent — not redacted — from
the player list, the player read, the agent list and every notification.
The internal note reaches the club view only. Sentinel sweeps over the
player's and the agent's pages and over the player signings, player
notifications, agent notifications, analytics and events APIs find no note
(H G3, T5, U2, V2, Y2; L D9, N10; P7 T group).

## 3. Terms and documents (§49–§51)

- Contract **terms** live on the Offer and reach only its audiences; the
  signing carries contract **days** and a digest. No event, notification,
  analytics row or agent projection carries a term (H U2, V2, Y2, G3).
- Document **bytes** reach the player and the club's case readers only,
  after byte verification; the executed document reaches the club only;
  the payload carries no vault id (H T1–T5).
- After agent authority loss there is nothing to revoke: the agent never had
  a document route, a digest or a signed URL (H G9; M23_P71_SIGNING_AUTH_REVALIDATION.md §5).

## 4. Events (§62–§63)

Seven `signing_*` events, all `org_private`, payload keys fixed by the
registry (ids and the party type word). The registry strips any other key
before it reaches a stream or the replay log. One completion emits exactly
one `signing_completed`; a replay and a refused duplicate emit nothing; the
player's stream carries no `signing_*` event (H U1–U3; P7 V).

## 5. Notifications (§64–§65)

One type (`recruitment_signing`), texts naming acts and the club or the
player — never a term, a digest, a note or a club user's name to the player.
A refused duplicate creates none; identical unread notifications coalesce
(no second push). The agent is told only while the basis holds; a same-agency
colleague is never told (H V1–V3; server `notify` coalescing).

## 6. Inbox (§66)

Signing access implies no Inbox access: the signing routes never create a
thread, and a block closes the club's messaging while the club keeps its
historical signing record (M23_P7_SIGNING_BLOCK_MATRIX.md). No signing act
creates a system message, so a retry cannot duplicate one.

## 7. Display drift (§73)

| Surface | Sees | Never sees |
| --- | --- | --- |
| club tab | everything on the package, integrity list, note, names | — |
| player section | presented revisions, digest (short + full on the accessibility label), parties by kind, state word, contract days | note, unpresented revision, club user names, `rev` |
| agent line | the **live** package over the shared Offer (else the completed one, else the latest — D-P71-7 fixed in R3), state word, revision number, parties signed of total, contract days | note, digest, names, bytes, any control |

All three derive the state word from the same `effectiveStatus`, so an
expired package reads Expired everywhere at once (L C2, C6; H K2).

## 8. Grassroots (§74)

The grassroots app has no signing surface and reaches no signing route; its
confirmation catalogue mirrors the club's byte-for-byte so a future surface
would inherit the same consequence copy (P7 D-P7-5; m182E2E §16).

## 9. Error taxonomy (§71)

Thirty-seven `SIGNING_*` codes in one table with one HTTP status each; a
500 body carries a fixed sentence; every code maps to an EN and an FR
sentence in the club (`sg.err.*`) and the player (`signingErr_*`) apps
with a generic fallback; the agent app maps the four agent-side refusals.
Two refinements in P7.1: a completion refused on a voided or cancelled
package names that state (P7 D-P7-3), and a confirmation against a
superseded revision is told so even while the package awaits
re-presentation (D-P71-6).
