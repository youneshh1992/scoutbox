# M23 P8.1 — Legacy compatibility

What P8.1 changes for cases and records that predate the canonical domains
(P3 Contact, P4 Trial, P5 Decision, P6 Offer, P7 Signing), and what it
refuses to do for them (§13, §14, §37). The P8 principle stands: **history
from before the records existed is reported as history; nothing is
fabricated, nothing is repaired on read.**

## 1. Classification (unchanged words, one new code)

| Shape | Classification | P8.1 change |
| --- | --- | --- |
| a state reached by the old status route with no record and no claim | `legacy` | none |
| some states backed, some not | `partially_canonical` | none |
| a history entry claiming a record that is gone | `integrity_error` (`STALE_POINTER`, `LIFECYCLE_AHEAD_OF_EVIDENCE`) | the club's next action is now **blocked** (`INTEGRITY_ERROR`) as well as named |
| a record proving a state the history never reached, on a live case | `integrity_error` (`EVIDENCE_AHEAD_OF_LIFECYCLE`, new) | detection added; held and ended cases exempt |
| a completed package or a signing row on a case not signed | `integrity_error` (`LIFECYCLE_BEHIND_TERMINAL_EVIDENCE`) | next action blocked |

A legacy case is never `integrity_error` for being legacy: the line is a
CLAIM on the history (an id or a domain trigger), exactly as P8 drew it.

## 2. The four mixed shapes (§37)

| Shape | Stage | Completed stages | Classification | Next action |
| --- | --- | --- | --- | --- |
| legacy `contacted` (no Contact) + a canonical Trial completed | `assessment` (if not yet assessed) | contact on `lifecycle` basis, trial on `canonical` basis | `partially_canonical` | `COMPLETE_ASSESSMENT` |
| a canonical Contact + a legacy `trial_completed` (no Trial) | `assessment` | contact `canonical`, trial `lifecycle` | `partially_canonical` | `COMPLETE_ASSESSMENT` (no Trial fabricated; `resources.trialId = null`) |
| a canonical Offer lifecycle (`offer_made` reached with an `offerId` claim) + no Offer row | `offer` | — | `integrity_error` (`STALE_POINTER`, `LIFECYCLE_AHEAD_OF_EVIDENCE`) | `REVISE_OR_WITHDRAW_OFFER`, blocked (`INTEGRITY_ERROR`) |
| legacy `signed` (a legacy row) + canonical earlier stages | `signed` | earlier stages `canonical`, signed `canonical` (the row) | `canonical` or `partially_canonical` (by the earlier stages) | `RECRUITMENT_COMPLETE` |

Proof: hardening S1–S8; journey E2E D1–D9; persistence 3 (across restarts).

## 3. Held legacy cases and the new resume rule (D-P81-1)

A case held before P8.1 resumes to the state it was held from **only when
that state's evidence stands**; a legacy held-from state with no record
(a legacy `contacted`) falls back to `under_review` exactly as before, and
so does a hold whose `from` is not on the history. No stored case is
rewritten by the change (hardening W3; m23E2E J8).

## 4. Legacy routes that now carry the canonical invariants

| Route | Before | P8.1 |
| --- | --- | --- |
| `POST /org/players/:id/signing` | any number of legacy rows and invoices per club + player; no budget | one standing row per club + player (409 `SIGNING_ALREADY_RECORDED`); the `signing_closure` budget. Existing duplicate rows stay as history |
| `POST /org/players/:id/request` | unmetered; any number of pending requests of one type | one pending request per type (409 `REQUEST_PENDING`); the `contact_send` / `trial_invite` budgets; body validation unchanged and still first |
| `POST /org/rooms/:id/decisions` (M17 advisory) | a `clientKey` replayed any content | same key + different content: 409 `DECISION_IDEMPOTENCY_CONFLICT`; a formal M23 key is not replayed here |

## 5. What P8.1 did not change for legacy data

- No migration; schema 2308. No legacy row, status or player field is
  reinterpreted or moved.
- A legacy `under_contract` stays as stored (P8).
- A legacy signing row recorded after the case opened still proves that
  case `signed`; one recorded before it still does not (P8 D-P8-3).
- A legacy Trial with no `caseId` is still not evidence and not this
  case's current Trial (P8 D-P8-16).
- The M12 wall (`UNDER_18_WALL`, `VERIFIED_CLUBS_ONLY`, `NOT_VISIBLE`) keeps
  naming its rule (N-P81-2).

## 5a. What R4–R5 changed for legacy rows (D-P81-15 … D-P81-18)

- A legacy request or Trial with NO `caseId`, and an assessment written
  outside a Trial, belongs to the case of that club and player that was
  OPEN when it was written; if it is older than every case it belongs to the
  case being read. For a player with one case nothing changes; for a player
  whose case ended and who has a second case, the ended case keeps its rows
  and the second case inherits none (D-P81-15; the funnel's `assessed`
  follows the same rule, D-P81-18).
- A legacy `signed` case whose `links.signingId` names a row still reads
  `signed` with the row named (persistence 3, LSIGN). One whose link names
  NO row is now `integrity_error` / `STALE_POINTER` (D-P81-16) instead of a
  quiet legacy `signed`; no writer can produce such a link, so only a
  corrupt store is affected.
- A legacy case with no corrupt record is classified exactly as before; a
  corrupt record NAMING the case is now `RECORD_CORRUPT` (D-P81-17) rather
  than an omission that let the case read as sound legacy data.

## 6. Proof

`m23RecruitmentJourneyHardeningE2E` S (the four mixed shapes, planted with
the store offline, read through the club, player and agent projections:
classified, nothing fabricated, next action safe), G (drift detection),
W3 (a held legacy case), U1–U4 (the legacy routes);
`m23RecruitmentJourneyPersistence` 3 and 5 (planted shapes across five
restarts, untouched); the P8 journey E2E D group unchanged and green.
