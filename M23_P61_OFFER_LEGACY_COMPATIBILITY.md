# M23 P6.1 — Offer legacy compatibility

What the hardened Offer does with data and behaviour that predate it:
cases that reached an Offer state through the legacy status writer
before P6 existed, snapshots without the Offer store, rows written by P6
before P6.1's stricter integrity, and direct writers elsewhere in the
server.

## 1. Schema

`SCHEMA_VERSION` is 2307 with 17 migrations — unchanged by P6 and by
P6.1. `recruitmentOffers` is module-guaranteed: created empty at
registration on every boot when absent. No backfill, no reinterpretation
of any lifecycle state into an Offer, no rewrite of any row on boot or on
stop (persistence 1.1–1.8, 5.22–5.23; hardening Z6).

## 2. Legacy lifecycle states without an Offer row

A case at `offer_made`, `offer_accepted` or `offer_declined` written by
the legacy status route before P6:

| Surface | Behaviour | Proof |
| --- | --- | --- |
| Journey | reports the stage as it is, with `offer.records: []`; invents nothing | persistence 5.10; hardening Q1 |
| Offer surface | lists nothing; `draftBlockers` names `CASE_STATE` (a case at `offer_made` cannot take a draft) | persistence 5.11; hardening Q4 |
| Lifecycle by hand | `recordOfferAccepted` refused — no Offer evidences it (`LIFECYCLE_EVIDENCE_REQUIRED` / `ROOM_EVIDENCE_REQUIRED` on the legacy route) | persistence 5.12; hardening Q2–Q3 |
| Recipient | sees no Offer (there is none) | persistence 5.13 |
| Analytics (M20 funnel) | reads `room_status_changed` history exactly as before; P6/P6.1 add no second action name | m20E2E in the battery |

The legacy status route itself still cannot reach `offer_made` without
an issued Offer (evidence-gated since P6): a legacy case stays where it
is and can only move forward through the canonical workflow after being
stepped back by the club (`shortlist` → `considerOffer`).

## 3. Rows written by P6 before P6.1's integrity rules

P6.1 added to `offerIntegrity`: temporal ordering (`issued_before_created`,
`responded_before_issued`, `withdrawn_before_created`), bounds
(`expiry_out_of_bounds`, `expired_before_issued`), `revision_number` ≥ 1,
`current_revision` type, and `current_revision_not_latest`; and
`offerCaseConsistency` (ACCEPTED-vs-declined, DECLINED-vs-accepted as
corruption; live-ISSUED-off-`offer_made` as a warning).

A row P6 wrote through its routes satisfies every new rule, because:
every instant on a revision is `now(req)` of a single handler and the
server clock is monotonic within a process; expiry was validated ≤ 180 d
at issue; revision numbers start at 1; the pointer always moves to the
newest revision, and the only later-revision shape P6 produces (a draft
discarded by an acceptance) is recorded WITHDRAWN, which the rule
allows; a case moves only through the Offer's own act, so a P6 pair
cannot disagree. The full P6 suites (447 + 59 checks) and the P6
persistence journey run unchanged under the new rules.

A row that fails a new rule is therefore one this server did not write —
and it is named in the log, refused with 500 `OFFER_STATE_UNKNOWN`,
omitted from recipient, agent and journey projections, and never
repaired (persistence §4–§5).

**Clock steps.** A wall-clock step backwards between two handlers on the
same revision (an NTP correction of seconds) could produce
`issued_before_created`. The platform's temporal model (P5.7) assumes a
monotonic server clock and derives every instant on the server; this
build keeps that assumption and would refuse such a row rather than
guess. The P6 persistence suite was corrected where its test clock ran
backwards (D-P61-12).

## 4. Direct writers (§37)

`db.recruitmentOffers` is written by m28 only (source sweep; the P6
existing-writer audit). The lifecycle status is written by m17's
`applyStatus` only, reached by m28 through `ctx.applyLifecycleTransition`
and by the legacy route only with evidence. Player deletion now reaches
m28 through the same hook chain as m24/m25/m26 (`onPlayerDeleted`),
which nulls names on responses and history and marks the subject removed
— it deletes no Offer row, exactly as the other modules keep their own
records.

## 5. Legacy states and the paused case

A case put `on_hold` while a revision is out: the club surface names
`LIVE_OFFER_CASE_NOT_AT_OFFER_MADE` on the Offer, the recipient reads
`answerable: false` with `notAnswerableReason: 'CASE_PAUSED'`, and an
attempt is 409 `OFFER_LIFECYCLE_CONFLICT` with nothing recorded (P7–P9;
survives a restart, Z). Resuming the case (`resumeCase`) returns it to `under_review`, not to
`offer_made`, so the revision stays unanswerable; the club makes an Offer
answerable again by stepping the case to consideration (`shortlist` →
`considerOffer`) and issuing a new revision, or by withdrawing. The player
app names the paused state in its own words (live S3i).

## 6. Nothing removed

No route, event, field, error code or status was removed or renamed.
Clients built against P6 keep working; the only visible additions are
`answerable` / `notAnswerableReason` / `awaitingYourResponse` on the
recipient view, the `integrity` list on the club surface (already there
in P6, now with more possible entries), and the agent projection's
`LICENCE_NOT_CURRENT` refusal.
