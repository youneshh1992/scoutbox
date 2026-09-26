# M23 P8.1 — Current-resource integrity

The audit of every "current X" selector (§10, §11, §12, §35, §36): where it
lives, whether it is the only copy, what it is fed, and what a stale, expired,
superseded, corrupt or foreign record can never do.

## 1. The selectors (one copy each, `m23/journeyModel.mjs`)

| Selector | Tiers (first wins) | Within a tier | Fed by the club projector with | Never current |
| --- | --- | --- | --- | --- |
| `currentContactForCase` | delivered → responded / recorded → draft → failed | newest by the tier's instant, ties by id desc | this case's structurally sound Contacts (`caseId`, `orgId`) | cancelled; another case's |
| `currentTrialForCase` | live (accepted / scheduled) → completed → cancelled → legacy_accepted | newest by confirmed / accepted / completion instant | this case's Trials (`caseId`, D-P8-16) | another case's (even the same club and player); a Trial naming another player |
| `currentAssessmentForCase` | submitted → draft | newest by submittedAt / updatedAt | this club's assessments of this player (M12 records are org + player, documented) | a draft when a submitted one exists |
| `currentDecisionForCase` | formal head → advisory head | oldest-last by createdAt (the chain head) | this room's decisions (`roomId`) | a draft; a superseded row |
| `currentOfferForCase` | DRAFT / ISSUED → ACCEPTED → the rest | newest by updatedAt | this case's structurally sound Offers (`caseId`, `orgId`, `playerId`) | a superseded, withdrawn or expired revision when a live one exists (the LIVE revision is returned beside the Offer) |
| `currentSigningForOffer` (= `currentSigningForCase`) | live (DRAFT / READY / IN_PROGRESS, not expired) → COMPLETED → newest terminal | newest by createdAt | this case's structurally sound packages | an expired or superseded package when a live one exists; a package naming another Offer or case |

Users of the same functions: the club projector (`journeyFor`), the player /
guardian projector (over the records shared with them), the agent projector
(over the granted kinds), the m29 Offer-view summary (`summaryForOffer`),
the notification target resolver (`journeyRoutes.mjs`, package targets
resolve to the current package over the same Offer). The agent app keeps
the same live → completed → latest preference for the list it renders
(journey E2E Z15). No other module keeps its own "current" rule (journey
E2E Z14; hardening F).

## 2. Determinism

Tiers in order; newest first within a tier by the named instant; ties broken
by id (descending). Two reads of the same store agree whatever the storage
order (journey E2E A6–A12; hardening F1–F6 shuffle the arrays and re-read).

## 3. Second case for the same player (§11, §12)

A club opens a second case for a player after the first ended (archived,
withdrawn, closed or signed), or another allowed org opens its own. Every
selector is fed **this case's rows only** (`caseId`; for decisions
`roomId`; for assessments D-P81-15: an assessment belongs to the case whose
Trial it was written in, else to the case that was OPEN when it was
written — an ended case keeps its own and a second case inherits none).
The player's and guardian's lines are scoped the same way: a request or a
Trial that names the ended case, or that was written while it was open,
is that case's line and never the second case's (D-P81-15; hardening
C8–C11, persistence 5.3, live L8). The new case
therefore starts with no current Contact, Trial, decision, Offer or package,
its completed stages carry nothing from the first case, its timeline shows
its own history, and the first case keeps naming its own records
(journey E2E D10–D12; hardening C7–C12, W4–W7). A Trial's `caseId` and an
Offer's `caseId` are set by their writers and never re-pointed.

## 4. Corrupt or stale pointers (§35, §36)

| Pointer | Where | If it names a missing record | If it names a record of another case / player / org | If the state word is unknown |
| --- | --- | --- | --- | --- |
| `offer.currentRevisionId` | m28 | `offerIntegrity` → the Offer is omitted with `OFFER_CURRENT_REVISION_MISSING`; the projection classifies `integrity_error` (`RECORD_CORRUPT`, plus `STALE_POINTER` when the history claims the Offer); the next action is named and blocked (`INTEGRITY_ERROR`, P8.1) | `offerCaseConsistency` → `CASE_MISMATCH` / `PLAYER_MISMATCH` / `CLUB_MISMATCH`, omitted | `offerIntegrity` → omitted; `effectiveRevisionStatus` never treats an unknown word as live |
| `pkg.currentRevisionId` | m29 | `signingIntegrity` → omitted with its code; `integrity_error` | `signingConsistency` → omitted | unknown status → not live, not completed (`signingIsLive` false) |
| `trial.requestId`, `trial.caseId` | m23/trial | `trialIntegrity` → omitted, counted | `CASE_MISMATCH` → omitted | `deriveWorkflowState` → not live |
| `contact.caseId` | m23/contact | `contactIntegrity` → omitted, counted | omitted | unknown status → never evidence (`CONTACT_EVIDENCE_STATUSES`) |
| history `contactId` / `trialId` / `requestId` / `decisionId` / `offerId` / `signingPackageId` | case history | `STALE_POINTER` + `LIFECYCLE_AHEAD_OF_EVIDENCE` | the foreign reference is folded in as `CASE_MISMATCH` etc. | — |
| `case.links.signingId` | m17 | `STALE_POINTER` (D-P81-16): every writer checks the row exists, so a dangling link is corruption — `integrity_error`, no completed signing named, the player never told `signed` by it (persistence 5.5) | — | — |
| any Offer, package, Trial or Contact that NAMES this case and fails its own integrity check | m28 / m29 / m23 | `RECORD_CORRUPT` (D-P81-17): the record is omitted from the projection AND the case is `integrity_error` with the act blocked — never a quiet downgrade to `legacy` with a live-looking `REVISE_OR_WITHDRAW_OFFER` (persistence 5.2; hardening R1) | the same | — |
| `case.room.status` | m17 | — | — | `LIFECYCLE_STATE_UNKNOWN`; `nextAction = STATE_UNKNOWN`; no lifecycle move (`LIFECYCLE_STATE_UNKNOWN` from the validator) |

Nothing here is repaired on read and nothing widens authority: a corrupt
Offer or package is simply not current, so no act is offered on it and the
domain routes refuse it with their own integrity codes; since R4 the
omission itself is a named problem (`RECORD_CORRUPT`), so the case can never
read as a sound legacy case while a corrupt record names it.

## 5. Evidence and lifecycle drift (§13, §14)

| Shape | Classification | Next action |
| --- | --- | --- |
| lifecycle ahead of evidence with a claim (a history entry names a record that is gone) | `integrity_error` (`STALE_POINTER`, `LIFECYCLE_AHEAD_OF_EVIDENCE`) | named, blocked (`INTEGRITY_ERROR`) |
| lifecycle ahead of evidence without a claim (pre-P3/P7 status moves) | `legacy` / `partially_canonical` | the club continues from the record (`CONTINUE_EVALUATION`, `COMPLETE_ASSESSMENT`, `REVISE_OR_WITHDRAW_OFFER` whose own gates apply) |
| evidence ahead of the lifecycle on a live case (an ACCEPTED revision, a delivered Contact, a completed Trial, an ISSUED revision that the history never recorded reaching) | `integrity_error` (`EVIDENCE_AHEAD_OF_LIFECYCLE`, P8.1) | named, blocked; no history entry is invented |
| terminal evidence the lifecycle lags (a COMPLETED package or a row on a case not signed) | `integrity_error` (`LIFECYCLE_BEHIND_TERMINAL_EVIDENCE`) | named, blocked |
| a held or ended case whose evidence outlived its last live state | not drift (the exemption) | `RESUME_CASE` / `CASE_ENDED` |

The canonical writers make drift impossible in normal operation (each moves
the case in the same unit of work and rolls back when it cannot); the
detection exists for planted, restored or externally edited stores, and it
reports rather than repairs.
