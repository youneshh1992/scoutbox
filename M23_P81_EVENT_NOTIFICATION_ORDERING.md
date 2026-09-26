# M23 P8.1 — Event and notification ordering

How late, duplicate, out-of-order and missed events and notifications are
kept from resurrecting a stale action (§26–§31, §72). Checks:
`m23RecruitmentJourneyHardeningE2E` groups O and P;
`m23RecruitmentJourneyHardeningLive` L3, L6, L7.

## 1. Events (SSE)

| Property | Where | Rule |
| --- | --- | --- |
| Payload | `m182/eventRegistry.mjs`, `broadcast()` | only registered keys travel (ids, state words); an unregistered key throws in development and is stripped in production — no rationale, terms, notes or names ride an event |
| Audience | `shouldDeliver` | an event carrying `orgId` goes to that org's streams only; `playerId` events to the player / guardian and to orgs that may see them; unclassified names fail closed |
| Client handling | club / grassroots / agent `App.tsx` | **every event only bumps a refetch counter** (`setTick`); no handler reads `from`, `to`, `status` or any id off the payload to change local state. The journey strip re-reads `GET /org/rooms/:id/journey` on the tick |
| Out of order | client | two events in any order produce two refetches of canonical state — the second read is the truth whatever the first event said (P1–P2) |
| Duplicate delivery | client + timeline | a duplicated event is one more refetch; the timeline is derived from records and history, so nothing is added twice (P3) |
| Missed event | client | a dropped stream reconnects with `Last-Event-ID` and replays buffered events, or receives `resync` and refetches everything; a tab that missed everything refetches on focus, `pageshow` and visibility (P8.1 app-level; P8 strip) and on reload (P4; hardening live L3) |
| Reconnect | `api.ts onChange` | one `EventSource` at a time: the previous is closed before a reconnect, listeners are attached once per source, the cleanup closes the source (P5: two events after a reconnect, one refetch each, no doubled handler) |
| Stream identity | server | the ticket resolves the LIVE session at connect; a removed user's stream is closed at removal; a suspended org's stream goes silent |

## 2. Notifications

| Property | Where | Rule |
| --- | --- | --- |
| Text | the domain's `notify` calls | a factual sentence: who did what, never terms, notes, rationale or a document digest (hardening Y) |
| Destination | `notificationsFor()` decorates every row with a `target` resolved at READ time (`notificationTargetFor`) | an Offer notification targets the Offer's live revision; a package notification the CURRENT package over the same Offer; a Contact / Trial notification the request or Trial; a resource the audience may no longer open resolves to no target; an AGENT's `client` target is re-derived through the live representation (`client_private`), and for the Offer tab the employment / transfer scope and a current licence, on every read (D-P81-14): an ended representation, a lapsed licence or a removed affiliation keeps the row and removes the destination (hardening K7; live L7h) |
| Late "Offer issued" after a withdrawal | O1 | the target is the Offer; the recipient's view reads WITHDRAWN with `answerable: false`; accept is refused `OFFER_REVISION_NOT_LIVE` |
| Late "Trial scheduled" after a cancellation | O2 | the target is the Trial; it reads cancelled; confirm / attend refuse by state |
| Late "Signing ready" after a void | O3 | the target resolves to the current package if one is live, else to the voided package read-only; a signature on it refuses `SIGNING_VOIDED` |
| Late "Contact" after a block | O4 | the request row stays in the Inbox (history); the player's answer is their act; the club cannot send another |
| Duplicates under retries | O5–O8 | every writer returns its idempotent replay BEFORE it notifies (Offer issue / answer, signing start / ready / party / complete, contact send) — the count of notifications per stage is one per real event |
| Ordering within one stage | O9 | the club's bell lists rows by their instant; opening any of them lands on the current resource, so the order of arrival changes nothing |

## 3. Timeline (journey history)

| Property | Rule |
| --- | --- |
| Source | records and the case history, never clicks or events (P8 §14) |
| Revisions vs stage changes | an Offer supersede adds `offer_superseded` + `offer_issued` (revision milestones with `revisionNumber`); the STAGE `offer` is completed once, on the first issued revision; a signing supersede adds `signing_superseded`; the stage `signing` completes once (P6) |
| Retries | a replayed request writes no history entry, so no milestone repeats (P7) |
| Temporal corruption | a non-finite instant is `TEMPORAL_ORDER` (classified, blocked); out-of-order instants are shown where their instant puts them, never re-sorted into a believable sequence (R group) |
| Privacy | the player's, guardian's and agent's timelines carry only the visible kinds and never a club member's name or a Contact record id |

## 4. What a client may never do

- Set a status, a stage or a "current" resource from an event or a
  notification payload.
- Show an action from a notification without reading the resource it
  targets.
- Keep an `EventSource` open after its session ended.
