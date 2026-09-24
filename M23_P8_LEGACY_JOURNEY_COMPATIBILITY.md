# M23 P8 — Legacy journey compatibility

How cases that reached their lifecycle states before the canonical records
existed (P3 Contact, P4 Trial, P5 Decision, P6 Offer, P7 Signing) read
through the P8 projection, and what P8 refuses to do for them (§11, §64).

## 1. The principle

A legacy case is history, reported as history. **P8 fabricates nothing**: no
Contact for a `contacted` case, no Trial for a `trial_completed` one, no
Offer for `offer_made`, no package for a legacy `signed`. The projection says
which stages are backed by a record and which are not, and every gate that
needs a record still needs one.

## 2. Classification (`validateRecruitmentJourney`)

| Classification | Meaning | Example |
| --- | --- | --- |
| `canonical` | every evidence-bearing state the case reached is backed by a canonical record | a P8-era journey |
| `legacy` | the case reached evidence-bearing states through the pre-P3/P7 status route and no canonical record exists for any of them | a P2 case moved to `contacted` by hand |
| `partially_canonical` | some backed, some not | a legacy `offer_made` later completed with a P7 signing; or a legacy signed case with a legacy row (the row is canonical evidence for `signed`, the earlier Offer stage is history) |
| `integrity_error` | a problem the validator names (below) | a history entry claiming a Contact that is gone |

The line between `legacy` and `integrity_error` is a **claim**: a history
entry that carries a record id (`contactId`, `trialId`, `requestId`,
`decisionId`, `offerId`, `signingPackageId`) or a domain `trigger`
(`contact:` / `trial:` / `offer:` / `signing:` / `decision:`) claims a record.
A claimed record that is missing is `STALE_POINTER` and
`LIFECYCLE_AHEAD_OF_EVIDENCE`; a state reached with no claim is legacy.

Integrity codes: `LIFECYCLE_STATE_UNKNOWN`, `PLAYER_MISMATCH`, `CLUB_MISMATCH`,
`CASE_MISMATCH`, `STALE_POINTER`, `LIFECYCLE_AHEAD_OF_EVIDENCE`,
`LIFECYCLE_BEHIND_TERMINAL_EVIDENCE` (a COMPLETED package or a signing row on
a case that is not signed), `HISTORY_MALFORMED`, `TEMPORAL_ORDER` (a
non-finite instant; out-of-order instants are NOT corruption — the history is
append-only and the timeline sorts by instant), plus the Offer and signing
domains' own corruption codes folded in.

## 3. What each legacy shape reads as

| Legacy shape | Stage | Completed stages | Resources | Next action | Player / agent |
| --- | --- | --- | --- | --- | --- |
| `contacted`, no Contact | contact | contact on `lifecycle` basis | no `contactId` | CONTINUE_EVALUATION (the club continues from where the record says it is) | nothing reached them through ScoutBox: no journey line |
| `trial_completed`, no Trial | assessment | trial on `lifecycle` basis | no `trialId` | COMPLETE_ASSESSMENT | none |
| `offer_made`, no Offer | offer | offer on `lifecycle` basis | no `offerId` | REVISE_OR_WITHDRAW_OFFER — points to the Offer tab, whose own gates (`draftBlockers`) decide what may be drafted | none |
| `signed`, legacy `db.signings` row (no package) recorded after the case opened | signed | signed on `canonical` basis (the row); earlier Offer stages on `lifecycle` basis | `completedSigningId` = the row; no package | RECRUITMENT_COMPLETE | the player's contract status came from the writer at the time; their journey shows `signed` only if a package reached them (none did) |
| `signed`, legacy row recorded BEFORE the case opened | — | — | — | — | the row no longer proves this case (`signingSupports`, P8): the case reads `LIFECYCLE_AHEAD_OF_EVIDENCE` only if its history claimed a record, else legacy with `signed:lifecycle`; the evidence gate refuses to re-reach `signed` from it |
| M12 case adopted into a Room | as the adoption status (never an evidence-bearing one) | | | | |

## 4. What legacy cases cannot do (unchanged gates)

- Move to an evidence-bearing state without the record (`LIFECYCLE_EVIDENCE_REQUIRED` / `ROOM_EVIDENCE_REQUIRED`).
- Open a signing without an accepted canonical Offer (`SIGNING_OFFER_NOT_ACCEPTED`).
- Record a legacy signing beside an accepted Offer or a package (`legacyRecordingBlocker`), or at all unless the caller is a club lead (P8).

## 5. What P8 changed for legacy data

| Change | Effect on legacy cases |
| --- | --- |
| `signingSupports` requires a legacy row to postdate the case | a historical row from years before a later case no longer proves that case; existing legacy signed cases whose row came after their opening are unaffected |
| `signingSupports` requires a canonical package to name the case | no legacy impact (legacy rows have no package) |
| the legacy status route's role parity | a room lead can no longer reach `signed` by hand; the states below stay as before |
| the Second Look reopen guard | a live room can no longer be "reopened"; closed-out rooms reopen as before |
| the self-service contract route | a legacy `under_contract` set by the old route stays as stored; the player may no longer declare `under_contract`, and may change the word only when no canonical live contract stands (a legacy row does not lock it) |

No migration reinterprets a legacy row, status or player field (schema stays
2308).

## 6. Proof

`m23RecruitmentJourneyE2E` A27–A33 (pure classification), D1–D9 (planted
legacy contacted / trial / Offer / signed cases and a claimed-but-missing
Contact: classified, no record fabricated, no crash, no unsafe act),
`m23RecruitmentJourneyPersistence` section 3 (the same planted cases across
five restarts: untouched), `m23SigningPersistence` 4.10 / 5.5 (legacy signed
rows, unchanged).
