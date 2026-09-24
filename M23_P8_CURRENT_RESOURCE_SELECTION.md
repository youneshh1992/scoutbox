# M23 P8 — Current-resource selection

When a case carries several records of one kind — two Contacts, a cancelled
and a live Trial, an expired and a live signing package — one rule decides
which is *current*. The rules live in `scoutbox-server/m23/journeyModel.mjs`
and nowhere else (§54); the club, player and agent projections and the
notification target resolver all call them. The P7.1 Agent defect (an
expired package selected over a live one, D-P71-7) is the failure this
centralisation prevents (§53).

Every rule is deterministic: tiers in order, newest first within a tier by
the named instant, ties broken by the id (descending) so two reads of the
same store agree whatever the storage order.

Every selector is fed THIS case's rows only (`caseId`, `orgId`, `playerId`).
A club's second case for the same player, opened after the first ended, has
no current Contact, Trial, Offer or package until it makes its own — the
first case keeps naming its own (D-P8-16, journey E2E D10–D12).

| Kind | Function | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Never |
| --- | --- | --- | --- | --- | --- | --- |
| Contact | `currentContactForCase(contacts)` | `delivered` (awaiting an answer), by `deliveredAt` | `responded` / `recorded`, by the response or occurrence instant | `draft`, by `updatedAt` | `failed` | `cancelled` |
| Trial | `currentTrialForCase(trials)` | `accepted` / `scheduled` (live), by the confirmed-schedule or acceptance instant | `completed`, by `completion.at` | `cancelled` | `legacy_accepted` | — |
| Assessment | `currentAssessmentForCase(assessments)` | submitted (`state !== 'draft'`), by `submittedAt` | draft, by `updatedAt` | | | — |
| Decision | `currentDecisionForCase(decisions)` | the formal chain head (nothing supersedes it), latest by `createdAt` | the advisory head | | | a draft; a superseded row |
| Offer | `currentOfferForCase(offers, now)` | a live Offer (current revision DRAFT or ISSUED at `now`), by `updatedAt` | ACCEPTED | any other (declined, withdrawn, expired) | | — |
| Offer revision | (inside the Offer rule) | the LIVE revision (latest ever issued) | the current (draft) revision | | | a superseded revision is never "current" for the recipient |
| Signing package | `currentSigningForOffer(packages, now)` = `currentSigningForCase` | live at `now` (DRAFT / READY / IN_PROGRESS, lazy expiry applied), by `createdAt` | COMPLETED | the newest terminal (cancelled, voided, expired) | | — |

## Consequences

- An expired package cannot mask a live one: a live package is tier 1
  whatever its position in the store. An expired package only becomes
  current when nothing live or completed exists — and then reads as `EXPIRED`,
  never as actionable.
- A superseded Offer revision cannot become the current actionable revision:
  the live revision is the latest ever issued, and the recipient's own gate
  (`canRespondToRevision`) refuses anything else.
- A draft Contact never outranks a delivered one; a cancelled Contact is not
  current at all.
- A cancelled Trial only becomes current when no live or completed Trial
  exists, so a re-invitation after a cancellation reads as the live one.

## Where the rules are applied

| Surface | Rule |
| --- | --- |
| club journey `resources` and `nextAction` | all of them |
| player / guardian journey (`/player/journeys`) | Offer, package, Trial over the records shared with that recipient |
| agent journey (`/org/agent/clients/:rel/journey`) | Offer, package, Trial, Contact over the granted kinds |
| Offer view `signing` summary (`m29 summaryForOffer`) | `currentSigningForOffer` (P8: replaces the oldest-row fallback) |
| agent app signing line (`screens.tsx`) | the server summary, which now applies the same rule; the client keeps the same live → completed → latest preference for the list it renders |
| notification targets (`journeyTargetFor`) | Offer → its Offer id (the app opens the live revision); package → the current package over the same Offer when the named one is no longer live |

## What is not "current"

Selection never hides history: every record stays in the lists the surfaces
render (`contact.contacts`, `trials`, `offer.records`, `outcome.signingPackages`,
the timeline). "Current" only says which id the next action, the deep link and
the notification point to.
