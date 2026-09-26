# M23 P8.1 — Block transition matrix

A block (the player, or the guardian of a minor, blocking a club:
`db.blocks`, `isBlocked(playerId, orgId)`) inserted **mid-stage** (§17).
The frozen rule from P3–P8: a block stops what comes next; it never erases
what happened. Rows: the stage the case is in when the block lands.
Checks: `m23RecruitmentJourneyHardeningE2E` group I; P8 block matrix
unchanged.

| Block lands during | Must stop (club) | Closure allowed (club) | Historical reads (club) | Notifications | Agent visibility | Player / guardian visibility |
| --- | --- | --- | --- | --- | --- | --- |
| discovery / watching / review | opening a Room (403 `NOT_VISIBLE`: the standing-rules refusal, N-P81-2), notes, morelike, save, shortlist, proofpack (404, D-P81-8), a contact plan is a lifecycle move and still succeeds but the next act is named `BLOCKED` | archive / withdraw / close the case | the case, its history | none to the recipient; the club's own notifications continue | an agent sees nothing new (nothing was shared) | the blocking side sees their block; the case never reaches them |
| contact_planned (a draft exists) | `send` (403 `CONTACT_BLOCKED`), external record (403) | cancel the draft; end the case | the draft stays readable | none | — | — |
| contacted (a delivered Contact, maybe unanswered) | a second send (403 `CONTACT_BLOCKED`), a Trial invitation (403 `TRIAL_BLOCKED`), an Offer draft (403 `OFFER_BLOCKED`) | end the case | the delivered Contact and any answer stay readable on both sides | the recipient's Inbox row stays; no new row | an agent routed on the Contact keeps the milestone; nothing new | the player keeps the Contact in their Inbox; they may DECLINE it (their act); ACCEPTING it is refused 403 `BLOCKED` until they lift the block — the platform's one rule for every request and Offer (I2) |
| trial_requested (a pending invitation) | a second invitation (403 `TRIAL_BLOCKED`); the invitation stays pending — the club cannot withdraw the recipient's choice, only cancel a Trial once one exists | end the case | the invitation | none new | — | the recipient may decline; accepting is refused 403 `BLOCKED` until the block is lifted (the same rule as a Contact and an Offer) |
| trial_scheduled | reschedule, attendance, evidence link (403 `TRIAL_BLOCKED`) | `cancel` and `report` only (`BLOCKED_CLUB_ACTIONS_ALLOWED`) | the Trial, its schedule and history | the cancellation reaches the recipient (a closure) | with the `trials` grant: the schedule stays readable; nothing new | the recipient sees the Trial and may cancel it themselves |
| trial_completed / assessment | an Offer draft (403); a new invitation (403) | `report`; end the case | the completed Trial; the club's own assessment (club material, unaffected) | none new | nothing new | the completion milestone stays |
| decision | nothing stops a decision: `reject` or `hold` is the honest outcome of a block; `progress` moves to offer_consideration, where the Offer gate refuses | end the case | the decision | none (decisions never notify recipients) | nothing (decisions never reach an agent) | nothing (decisions never reach the player) |
| offer_consideration (a draft Offer) | issue (403 `OFFER_BLOCKED` in `issueBlockers`), a new draft / revision (403) | withdraw the draft; end the case | the draft | none | — | — |
| offer_made (an ISSUED revision) | a new revision (403) | `withdraw` (a closure — the recipient is not approached; they are told) | the issued revision stays readable on both sides | the withdrawal notification reaches the recipient; no other | with the `offers` grant and a share: the Offer stays readable; the withdrawal reaches the agent as a fact | the recipient sees the Offer; **accept is refused** (`OFFER_BLOCKED` — lift the block first); **decline is allowed** |
| offer_accepted (no package yet) | `START_SIGNING` (`BLOCKED` in `startBlockers`; 403 `SIGNING_BLOCKED` on start, I5) | end the case (withdraw / archive / close) | the acceptance | none new | the acceptance stays a fact | the acceptance stays; nothing further is asked of them |
| signing DRAFT / READY / IN_PROGRESS | present (403), party completion by the club (403), completion (gate `BLOCKED`, nothing recorded) | `cancel` the package; T&S `void` | the package and its document stay readable to the parties; the executed document if any | the player's own signing notifications are suppressed while blocked (`notifyPlayer`); the cancellation reaches the parties | with the `signings` grant and a share: the package stays readable; the cancellation is a fact | the presented document stays readable; the recipient's own signature is their act (allowed); completion by the club is refused |
| signed | nothing is un-signed: the contract stands (a block is not a rescission) | close the case | everything | none new | the completion stays a fact | `signed` stays theirs |
| on_hold | the resume itself is a lifecycle move and succeeds; every act after it meets the stage's rule above | end the case | everything | none | — | — |
| ended (withdrawn / archived / closed) | nothing to stop | reopen (Second Look) succeeds; the reopened case's next act meets the block | everything | none | — | — |

## Rules the matrix rests on

- `isBlocked` is read at the moment of every send, issue, start, party
  completion and completion — never cached on a record — so a block landing
  between a screen load and an act is met by the act (hardening I7: the
  club's strip still names the act with `blockedBy: ['BLOCKED']`, the
  server refuses it).
- The recipient's own acts (answering a Contact, accepting or declining a
  Trial or an Offer, signing their party) are the recipient's, and a block
  they placed does not stop their decline; it stops their **acceptance** of a
  Contact, a Trial invitation or an Offer (403 `BLOCKED`: they are told to
  lift the block first) and the club's every
  forward act.
- Discovery reads: a blocked player reads as absent everywhere (D-P81-8).
- History is never erased; the timeline stays complete for the club.
- The lift (`/admin/blocks/:id/lift`) re-derives every gate on the next
  request; nothing is replayed automatically.

Proof: hardening I1–I8; P3 / P4 / P6 / P7 block groups and the P8 block
matrix (unchanged, green).
