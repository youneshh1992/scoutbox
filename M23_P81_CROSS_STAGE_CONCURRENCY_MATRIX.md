# M23 P8.1 — Cross-stage concurrency matrix

The fifteen races the mandate names (§6), plus the rules that decide them.
The server is one process: two requests never interleave inside a handler,
so "concurrent" means two requests that arrive with the same picture of the
world. The decider is then the ordering rule that the second request meets:
a revision token, a state gate, a per-case uniqueness rule, or the ONE
validator with its evidence provider. Every row ends in **one**
authoritative result. Checks: `m23RecruitmentJourneyHardeningE2E` group B
(and the earlier suites named).

| # | Race | First to land | Second meets | One result | Check |
| --- | --- | --- | --- | --- | --- |
| 1 | Contact send vs block | either | send after block: 403 `CONTACT_BLOCKED`, nothing moves; block after send: the Contact stays delivered and the case `contacted` — the block stops what comes next, not what happened | one delivered Contact or none; the block always stands | B1; contact E2E |
| 2 | Contact response vs Trial invitation | either | an invitation while the Contact is unanswered is allowed (the case is `contacted`); the answer after the invitation lands on the Contact only | both records; the case moves once per record (`trial_requested` by the invitation) | B2 |
| 3 | Trial schedule vs Trial cancel | either | the loser's `expectedRev` is stale: 409 `TRIAL_VERSION_CONFLICT` | one Trial state | B3; trial E2E |
| 4 | Trial completion vs reschedule | either | stale rev: 409; a reschedule of a completed Trial is refused by state | one completion | B4 |
| 5 | Assessment submit vs case hold | either | both are recorded: the hold never erases an assessment; the assessment never un-holds the case | held case with a submitted assessment | B5 |
| 6 | Decision finalize vs case archive | either | finalize after archive: the decision row is written, the `progress` move meets `LIFECYCLE_TRANSITION_INVALID` (archived → offer_consideration is not an edge) and rolls back the row; archive after finalize: the case ends with its decision intact | either an archived case with no new decision, or a decided case that then ended | B6 |
| 7 | Decision `progress` vs Offer creation | `progress` | a draft before `offer_consideration`: 409 `OFFER_STATE_INVALID`; after: 201 | one Offer, drafted only from offer_consideration | B7; Offer E2E |
| 8 | Offer issue vs case hold | either | issue after hold: the lifecycle refuses (`on_hold` → `offer_made` is not an edge), the issue **rolls back** (`OFFER_LIFECYCLE_CONFLICT`); hold after issue: the Offer stays ISSUED, the case is held, the recipient's answer waits (`OFFER_LIFECYCLE_CONFLICT`, rolled back) until the resume returns the case to `offer_made` (D-P81-1) | one issued revision or none; never an issued revision on a case that cannot record it | B8; Offer hardening P6.5–P10 |
| 9 | Offer accept vs Offer withdraw | either | accept after withdraw: 409 `OFFER_REVISION_NOT_LIVE`; withdraw after accept: 409 `OFFER_ALREADY_RESPONDED` | one answer | B9; Offer hardening |
| 10 | Offer accept vs case archive | either | accept after archive: the lifecycle refuses, the answer **rolls back** (`OFFER_LIFECYCLE_CONFLICT`); archive after accept: the case ends at archived with the acceptance on record (no signing can start: `CASE_STATE`) | one truth: an accepted Offer on an ended case, or an unanswered Offer | B10 |
| 11 | Signing start vs Offer withdrawal | either | start requires an ACCEPTED revision, which cannot be withdrawn (`OFFER_ALREADY_RESPONDED`); a withdrawn revision cannot start a signing (`SIGNING_OFFER_NOT_ACCEPTED`) | no package over a withdrawn Offer | B11; Signing hardening ZA |
| 12 | Signing completion vs case close | either | completion after close: the lifecycle refuses (`closed` reaches nothing but `under_review`), the completion **rolls back whole** — package, row, ledger, invoice, player, squad, lifecycle (`SIGNING_LIFECYCLE_CONFLICT`); close after completion: the signed case files away (`signed` → `closed`) | never a row without `signed`, never `signed` without a row | B12; journey E2E Q2; Signing hardening Q |
| 13 | Signing completion vs block | either | completion after block: the gate names `BLOCKED`, nothing recorded; block after completion: the contract stands (a block is not a rescission), the club's next acts stop | one completed signing or none | B13; Signing hardening |
| 14 | `signed` vs duplicate completion | first completion | `SIGNING_ALREADY_COMPLETED`; one `db.signings` row per package and per Offer; a legacy recording beside it: `SIGNING_CANONICAL_REQUIRED` | one row | B14; Signing hardening J1, J11–J12, P12 |
| 15 | Current-resource selector during supersession | supersede | the selector reads the store as it is: the new live revision / package is current the moment the supersede lands; a stale client's answer names the old revision and meets `OFFER_REVISION_NOT_LIVE` / a stale signature key meets `SIGNING_IDEMPOTENCY_CONFLICT` (D-P81-12) | one current record | B15; hardening F |

## The deciders, once each

| Rule | Where | What it decides |
| --- | --- | --- |
| `expectedRev` (`m181/concurrency.mjs guardRev`) | every club mutation of a Contact, Trial, decision, Offer, package; every lifecycle move | two clients with the same picture: the first wins, the second is told the current rev and state |
| named revision + digest | Offer answers, party signatures | a stale answer names a revision that is no longer live |
| state gates | `CONTACT_CASE_STATE`, `TRIAL_CASE_STATE`, `OFFER_STATE_INVALID`, `OFFER_LIFECYCLE_CONFLICT`, `CASE_STATE`, `SIGNING_LIFECYCLE_CONFLICT`, `SIGNING_ALREADY_COMPLETED` | an act the case's or the record's state cannot take |
| uniqueness | one open room per club + player; one live Offer per case; one package per Offer (live); one completed row per package / Offer; one standing legacy row per club + player (P8.1); one pending invitation per case; one pending legacy request per type (P8.1) | duplicates |
| the ONE validator with rollback | every domain act that moves the case | a domain write whose lifecycle move is refused is undone in the same request (Offer issue / answer, signing completion, decision finalize) |
| idempotency keys with fingerprints | every mutation that takes a `clientKey` | a retry of the SAME request replays; a different request with the same key conflicts |

## What is deliberately not a race

- A block landing after a delivered Contact, an accepted Trial or a
  completed signing does not undo them: a block stops what comes next.
- A hold landing after an issued Offer does not withdraw it: the answer
  waits for the resume (D-P81-1), and the resume returns the case to where
  it was held from.
- Two assessments, two advisory decisions, two Contacts on one case are
  records, not conflicts: the selectors name ONE current record by rule.
