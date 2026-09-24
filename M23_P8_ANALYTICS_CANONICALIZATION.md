# M23 P8 — Analytics canonicalization

Where every recruitment-journey figure on the Director Dashboard (M20) comes
from, what it counts, and how retries and revisions are kept from inflating
it (§42–§45, §90). Paths are under `scoutbox-server/m20/`.

## 1. The rule

A funnel stage may derive from exactly three kinds of truth:

| Basis | What it is | Example |
| --- | --- | --- |
| canonical store | the domain record that proves the stage | `db.recruitmentContacts` (delivered), `db.trials` (completed), `db.signings` |
| canonical lifecycle | `case.room.status` and its `room_status_changed` history, every evidence-bearing move of which passed the evidence gate | `funnel_progression` |
| canonical event | a registered, server-written event | none of the journey metrics use the stream; the stream is for refresh, not for counting |

No metric reads a client-supplied value. The one client-reported figure in
the analytics surface — M13 exposure impressions (`POST /exposure/impressions`)
— belongs to the exposure report, not to the recruitment journey, and is
documented as client-reported there.

## 2. The journey funnel from the records (new in P8)

`journey_evidence_funnel` (`funnels.mjs journeyEvidenceFunnel`, family
`pipeline`). Cohort: cases opened in the window (the same rule as
`funnel_progression`, so the two panels read side by side). **Case-based**: a
case counts once per stage however many retries, revisions, re-invitations or
packages it carried.

| Stage | Counts a case when | Canonical store | Instant used |
| --- | --- | --- | --- |
| contacted | a Contact of the case in `delivered` / `responded` / `recorded`, not cancelled | `recruitmentContacts` | `deliveredAt` / `occurredAt` |
| trial_requested | a trial invitation (request of type `trial`) for the case | `requests` | `createdAt` |
| trial_scheduled | a Trial of the case with a confirmed schedule (or completed) | `trials` | `schedule.confirmedAt` |
| trial_completed | a Trial of the case with `completion.state = 'completed'` | `trials` | `completion.at` |
| assessed | a submitted assessment of the player by the club | `assessments` | `submittedAt` |
| decision_progress / _hold / _reject | the formal decision head (nothing supersedes it) with that outcome | `roomDecisions` | `createdAt` |
| offer_issued | an Offer of the case with an issued revision | `recruitmentOffers` | first `issuedAt` |
| offer_accepted / _declined | an Offer revision ACCEPTED / DECLINED | `recruitmentOffers` | `respondedAt` |
| signing_started | a package of the case | `signingPackages` | `createdAt` |
| signed | a COMPLETED package on the case whose row names it back, else a legacy row recorded after the case opened | `signings` | `completion.completedAt` / `ts` |

Beside each stage, **history only**: cohort cases whose `room_status_changed`
history reached the corresponding state with no such record. They are older
(pre-P3/P7) cases or drift; they are shown apart and never added.

**Intervals** (`intervals`, §45): medians in days over cohort cases that
completed both ends, from the records' own instants — contact → trial
scheduled, trial completed → progress decision, decision → Offer issued,
Offer issued → accepted, accepted → signed. Never from the case history, so a
test clock or a reopen cannot invent a duration.

## 3. Every journey metric, its basis and its double-count rule

| Metric | Family | Source | Basis | Retries / revisions / supersession |
| --- | --- | --- | --- | --- |
| `journey_evidence_funnel` (P8) | pipeline | the nine stores above | case, per stage | one count per case per stage; a second package, a superseded revision, a re-invitation add nothing |
| `funnel_progression` | pipeline | `room_status_changed` history (+ `room_created`) | case, "ever reached" | first reach per case; reopen reported (`reopenedInCohort`), not double-counted |
| `pipeline_stage_counts` | pipeline | `room.status` now | case, point in time | one per case |
| `trial_process` | pipeline | `requests`, `trials` | resource, event-dated | each invitation / trial counts once per step on the day it happened (documented: process steps, not conversion) |
| `decision_outcomes` | pipeline | `roomDecisions` | revision (every finalized row) | superseded rows count as decisions made and are reported as `superseded` |
| `exit_reason_mix` | pipeline | `roomDecisions` | revision, categories overlap by design | documented |
| `time_to_first_decision`, `time_in_stage`, `time_to_trial_requested`, `time_trial_requested_to_completed` | duration | case history | case | first reach |
| `source_stage_reach` | source | `room.sourceContext` + history | case | first reach |
| `terminal_with_recorded_decision`, `reopen_rate`, `evidence_limited_exits`, `superseded_decision_rate` | decision_record | history + `roomDecisions` | case / revision | documented |

Not a journey metric and unchanged: `GET /org/funnel` (M12, ledger-based,
per-scout breakdown), `roomFunnel` (M17 status buckets), the M13 exposure
report.

## 4. What no metric does

- No metric ranks a player, scores a colleague, or turns a drop-off into a
  failure figure (§44): every panel is counts and medians with the M20
  limitation sentence rendered beside it.
- No metric reads a note, a rationale, a reason's free text, a term, a digest,
  a Trust Score or an assessment rating: each metric's `reads` declaration is
  asserted at boot against the private-field list (`metrics.mjs`).
- No metric derives from a client or UI state.

## 5. The §90 gate, stage by stage

| Funnel stage | Derives from |
| --- | --- |
| discovered | not a journey stage (no case); exposure report only, client-reported and labelled so |
| watched | canonical lifecycle (`room_created`) |
| reviewed | canonical lifecycle (history reached a review state); Nobody Missed reviews from `nobodyMissedReviews` |
| contacted | canonical store (`recruitmentContacts`) and lifecycle beside it |
| trial requested / scheduled / completed | canonical store (`requests`, `trials`) and lifecycle beside it |
| assessed | canonical store (`assessments`) |
| decision progress / hold / reject | canonical store (`roomDecisions`) |
| Offer issued / accepted / declined | canonical store (`recruitmentOffers`) and lifecycle beside it |
| signing started | canonical store (`signingPackages`) |
| signed | canonical store (`signings`, supported) and lifecycle beside it |

**Journey analytics use canonical truth: YES. Retries double-count funnel
metrics: NO.**

## 6. Proof

`m23RecruitmentJourneyE2E` group I (the metric's rows name their store; Kola's
and Mensah's cases each count once per stage although Mensah carried two
packages and a superseded revision; the planted legacy cases appear under
"history only"; a scout cannot read the dashboard) and `m20E2E` (the demo
bundles and M20_METRICS.md carry the limitation word for word).
