# M23 P7 — Signing block matrix

What a block (the player or their guardian blocking the club), a removed
subject, a paused case, an expired package and lost authority each do to a
signing (§37, §38, §36, §80). The rule everywhere: **fail closed, name the
state to the club, conceal the reason from the recipient, never move the
lifecycle from inside the signing.**

| Situation | Open a package | Edit / attach / present | Player confirms | Club signs / completes | Cancel | Void | Recipient reads | Club reads | Notification to player |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| player blocks the club (`isBlocked`) | 403 `SIGNING_BLOCKED` | 403 `SIGNING_BLOCKED` (`packageFor` manage) | 409 `SIGNING_STATE_INVALID` — never the word "blocked" | 403 `SIGNING_BLOCKED`; `completionGate` names `BLOCKED` | allowed (the club may end its own package) | allowed | the package stays readable as presented; `nextAction` still names the act, the act is refused | ✓ with the club-facing refusal | suppressed (`notifyPlayer` checks the block) |
| block lifted | ✓ again if the Offer still allows | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| subject removed their account (`subjectRemovedAt` / player gone) | 409 `SIGNING_SUBJECT_REMOVED` | 409 | — (no session) | 409 `SIGNING_SUBJECT_REMOVED` | allowed | allowed | — | ✓, `onPlayerDeleted` cancels live packages with reason `player_deleted` | — |
| case paused (`holdCase`) or otherwise not at `offer_accepted` | 409 `SIGNING_LIFECYCLE_CONFLICT` (`canStart`) | ✓ (a draft is the club's own) | 409 `SIGNING_LIFECYCLE_CONFLICT` | 409 `SIGNING_LIFECYCLE_CONFLICT` | allowed | allowed | ✓ (the package is what it was) | ✓ with the warning `LIVE_SIGNING_CASE_NOT_AT_OFFER_ACCEPTED` | — |
| package expired (`expiresAt` passed) | a new one ✓ (the expired one is terminal) | 409 `SIGNING_EXPIRED` | 409 `SIGNING_EXPIRED` | 409 `SIGNING_EXPIRED` (gate `EXPIRED`) | 409 `SIGNING_EXPIRED` — nothing is left to cancel | 409 | reads `EXPIRED`, `nextAction: null` | reads `EXPIRED`, "start a new signing" | — |
| club role removed after the page loaded | 403 | 403 | — | 403 | 403 | 403 | — | per current role | — |
| lead demoted mid-package | — | 403 | — | 403 | 403 | 403 | — | ✓ as a reader | — |
| stale session token | 401 | 401 | 401 | 401 | 401 | 401 | 401 | 401 | — |
| agent's representation terminated / licence lapsed / scope narrowed | — | — | — | — | — | — | — | — | agent no longer notified; read 403 `REPRESENTATION_NOT_ACTIVE` / `LICENCE_NOT_CURRENT` / `SCOPE_INSUFFICIENT` |
| Offer no longer ACCEPTED (cannot happen after acceptance: the Offer is immutable) | 409 `SIGNING_OFFER_NOT_ACCEPTED` | — | — | gate `OFFER_NOT_ACCEPTED` | — | — | — | — | — |

## Notes

- A block never cancels a package by itself: the club decides whether to
  cancel; the package cannot progress while the block stands (S group, live
  N). Blocking is the player's act and is never disclosed to the club
  through the signing surface beyond the refusal code the club already
  receives from every other contact surface.
- Expiry is derived at read time and never written; a party whose
  evaluation instant is one millisecond before expiry lands (R5, #33), one
  at or after expiry is refused; the completion gate reads `EXPIRED` the
  same way (R4, #29).
- Deleting a player (`onPlayerDeleted`) cancels their live packages with a
  recorded reason and touches no completed package and no `db.signings` row.
- Every refusal to the recipient is a state word; every refusal to the club
  is the state or its own standing. No refusal carries the note, a name the
  caller may not see, or the existence of a package the caller may not read.
