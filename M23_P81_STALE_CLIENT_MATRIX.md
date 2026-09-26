# M23 P8.1 — Stale client matrix

Two actors (or two tabs of one actor) on the same case (§5, §70). Tab A
loads a screen; tab B changes the truth; tab A then acts on what it loaded.
The rule: **a stale mutation never overwrites newer canonical truth.** The
server decides by revision (`expectedRev`), by named resource (revision id,
document digest), by state and by the ONE validator; the strip then says
"This recruitment has changed. We refreshed the latest status." and
re-reads (P8 §56; live B). Checks are in `m23RecruitmentJourneyHardeningE2E`
group A and `m23RecruitmentJourneyHardeningLive` (L).

| # | A loaded | B did | A attempts | Server answer | Effect on truth | Check |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | case at `contacted`, a delivered Contact | scheduled a Trial (case → trial_scheduled) | sends a new Contact from the stale Contact tab | 409 `CONTACT_CASE_STATE` (a case at trial_scheduled does not contact) — or 409 `CONTACT_COOLDOWN` while the delivered one is unanswered | nothing sent; the Trial stands | A1 |
| 2 | a Contact draft at rev N | edited the draft (rev N+1) and sent it | edits / sends with `expectedRev: N` | 409 `CONTACT_VERSION_CONFLICT` with the current status | one delivery | A2; contact E2E |
| 3 | case at `contacted` | archived the case | moves the case (`shortlist`) with the old `expectedRev` | 409 `ROOM_VERSION_CONFLICT`; with the fresh rev: `LIFECYCLE_TRANSITION_INVALID` (archived → shortlisted is not an edge) | the case stays archived | A3 |
| 4 | Trial scheduled at rev N | completed the Trial | reschedules / cancels with rev N | 409 `TRIAL_VERSION_CONFLICT` with the current workflow state | the completion stands | A4; trial E2E |
| 5 | the decision screen with the head decision d1 (rev N) | superseded d1 with d2 | finalizes "over" d1 naming `supersedes: d1, supersedesRev: N` | 409 `DECISION_REV_REQUIRED` / `DECISION_ALREADY_FINAL` naming the current head | d2 stays the head | A5 |
| 6 | the Offer at revision r1 (ISSUED) | superseded r1 with r2 (or withdrew r1) | the recipient accepts naming `revisionId: r1` | 409 `OFFER_REVISION_NOT_LIVE` | r2 (or nothing) stays the live revision; no acceptance | A6; Offer hardening |
| 7 | the Offer draft at rev N | issued it | edits the draft with rev N | 409 `OFFER_REV_CONFLICT` | the issued revision stands | Offer hardening |
| 8 | a package at revision s1 READY | superseded s1 with s2 | the player signs naming s1 + its digest | refused (`SIGNING_REVISION_NOT_CURRENT`); the old party key answers `SIGNING_IDEMPOTENCY_CONFLICT`, not `idempotent: true` (D-P81-12) | s2 unsigned, s1 history | A7, V |
| 9 | a package IN_PROGRESS | voided it (T&S) or cancelled it | the lead completes | refused (`SIGNING_VOIDED` / `SIGNING_CANCELLED`); nothing recorded | no row, no `signed`, no `under_contract` | A8; Signing hardening |
| 10 | case at `offer_accepted` with a live package | put the case on hold | a party signs | 409 `SIGNING_LIFECYCLE_CONFLICT` | the package waits; a resume returns the case to offer_accepted (D-P81-1) and the signature proceeds | A9, W2 |
| 11 | case at `offer_made` | the recipient accepted | the club withdraws the revision | 409 `OFFER_ALREADY_RESPONDED` | the acceptance stands | A10 |
| 12 | case at `under_review` with the strip's `REVIEW_PLAYER` act | a colleague moved the case to contact_planned | the strip performs `startReview` with the stale rev | 409 `ROOM_VERSION_CONFLICT`; the strip says the case changed and re-reads; the control that appears is the current act | one move | live B (P8), hardening live L1, L3–L4 |
| 13 | a Room tab open | the user's role was removed | any act | 403 `ROOM_PERMISSION_REQUIRED` / `LIFECYCLE_NOT_PERMITTED`; the strip re-reads and drops the control | nothing | live C (P8), hardening live L4–L5 |
| 14 | the agent's client page | the client ended the representation | any read or deep link | 403 with the rule; the line is gone on the next read | nothing | journey E2E F7; hardening K, hardening live L7 |
| 15 | a notification "Offer issued" | the club withdrew the Offer | opens the notification | the target resolves to the Offer; the app shows the current revision as WITHDRAWN with no answer control | nothing | O1; hardening live L6 |

## Why the answers are what they are

- **Revision guards** (`m181/concurrency.mjs guardRev`) on every club mutation
  of a Contact, Trial, decision, Offer and package, and on every lifecycle
  move: the client must send the `rev` it looked at; the server compares to
  the row's own.
- **Named resources**: the recipient names the revision they answer
  (`revisionId`) and the document they sign (`documentSha256`); the server
  checks the named revision is the current, live one and the digest is the
  package's own before it records anything.
- **State gates**: every domain route refuses by the case's and the record's
  own state before anything is written (`CONTACT_CASE_STATE`,
  `TRIAL_CASE_STATE`, `OFFER_STATE_INVALID`, `CASE_STATE`,
  `SIGNING_LIFECYCLE_CONFLICT`).
- **The ONE validator** decides every lifecycle move with the transition
  table, the role and the evidence provider; a domain act that cannot move
  the case rolls back and refuses (Offer issue / answer, signing completion).
- **Clients never mutate local lifecycle state from an event**: a server
  event only bumps a refetch counter (club `App.tsx`: `setTick`); the strip
  re-reads on the event, on focus, on visibility, after every act and after a
  409 / 422 / 403.
