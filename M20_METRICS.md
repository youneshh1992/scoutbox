# M20 — Recruitment Analytics: metric catalogue

The governing rule of this milestone, and of every row below:

> **Measure the recruitment process, not the worth of the player or the scout.**

A metric earns its place here only if a recruitment director could act on it by
changing how the club **works** — who reviews what, how quickly, with what
evidence, in what order. A number that can only be acted on by forming an
opinion about a *person* — a player's ability, a scout's competence — is not a
process metric and does not exist in ScoutBox.

`RECRUITMENT_ANALYTICS_POLICY_VERSION = 1`. Every response carries it. When a
definition below changes, the version changes with it, and the old definition
stays in this file under its version so a director can tell whether last
quarter's figure and this quarter's figure mean the same thing.

## What is never built

These are refusals, not deferrals. None of them is on a roadmap.

| Never | Why |
|---|---|
| Recruitment Score, Scout Score, Player Success Score, Recruitment Efficiency Score, Talent Conversion Score, Club Intelligence Score, or any other blended overall number | A single figure invites a decision it cannot support. Every one of them would be a judgement of a person wearing the costume of a measurement. |
| A scout leaderboard, or any per-person breakdown of any metric | ScoutBox holds no measure of scouting quality and will not let a ranking be assembled from process counts. A director who wants to know how a colleague is doing must talk to them. |
| Any metric derived from the text of a private note, comment, assessment narrative or decision note | Notes are written in the expectation that they are read by colleagues, not counted by a machine. Only the **structured** reason code is machine-readable — that vocabulary is one the club itself chose from a closed list. |
| A conversion rate presented as a performance figure for a source, a scout or a player type | ScoutBox observes association. Every rate that compares groups is labelled as association and never as cause. |
| A second copy of recruitment truth | Every metric is a **projection computed on read** from records M12–M19 already own. M20 stores no facts of its own. |

## Suppression and honesty rules

| Rule | Value | Applies to |
|---|---|---|
| `SMALL_N_MIN` | **5** | Any ratio. Below 5 in the denominator the ratio is withheld and the raw numerator and denominator are shown instead, with "too few to express as a rate". |
| Median suppression | **5** | A median over fewer than 5 observations is withheld the same way. The observation count is always shown next to a median. |
| Per-person breakdown | **never offered** | Not suppressed — absent. There is no query parameter that produces one. |
| Partial failure | explicit | If one metric family cannot be computed, the dashboard renders the others and names the one that failed. A dashboard that silently drops a panel is lying about coverage. |
| Empty vs zero | distinguished | "No rooms opened in this window" and "0% of rooms reached a decision" are different sentences and the payload distinguishes them (`n: 0` vs `value: 0`). |

## Time semantics

Every metric declares one of three time semantics, and the payload names it:

- **point-in-time** — the state of the world *now*, ignoring the window. Backlogs and aging are point-in-time; asking "how many rooms were stalled last March" is a different question this build does not answer.
- **window-entry** — the record is counted in the window in which the *entry* event happened (a room opened, a decision recorded).
- **window-completion** — the record is counted in the window in which the *completing* event happened (a room reached a terminal status, a trial completed). Durations use this: a room still open contributes nothing to a time-to-X median, which is stated on screen because it biases early windows downward.

Presets are **7 / 30 / 90 / 180 / 365 days**, default 90, plus a custom range.
Windows are inclusive UTC calendar-day ranges, evaluated by the same helper as
M18.2's `briefIsLiveOn`.

### Period-over-period

Three period-activity counts — rooms opened, rooms ended, decisions recorded —
are compared with the **immediately preceding window of the same length**.
Equal length matters: comparing seven days against thirty would make every
figure look like a collapse. The two periods are contiguous and non-overlapping.

Only counts are compared, and only period-activity ones. A trend on a
point-in-time figure ("active rooms, up 12%") is meaningless because the window
does not apply to it, and a trend on a rate compounds two small samples into one
confident-looking number.

**The zero rule:** when the previous period was zero, `percentChange` is `null`
and `upFromZero` is true. A rise from nothing has no percentage; rendering one
produces `Infinity` or a meaningless 100%. The screen says "up 3, from none last
period". Nothing compared with nothing is *not* a 0% change either — it is
`unchangedAtZero`.

### One clock

There is one clock: `history[].at`, the timestamp the M12 `audit()` helper
wrote. M20 never invents a timestamp and never infers one from record order.

## Source records

Every metric below is computed from these, and only these:

| Store | Fields M20 reads | Fields M20 must never read |
|---|---|---|
| `db.recruitmentCases` | `orgId`, `createdAt`, `room.status`, `room.priority`, `room.sourceContext`, `room.archivedAt`, `room.closedAt`, `links.trialIds`, `links.signingId`, `history[].{at,action,detail.from,detail.to,detail.reasonCodes}` | `history[].byId`, `history[].byName` (identity is read only to *exclude* it), any comment body |
| `db.roomDecisions` | `orgId`, `roomId`, `recommendation`, `reasonCodes`, `createdAt`, `supersededById`, `trigger` | `note`, `by` |
| `db.recruitmentBriefs` | `orgId`, `status`, `version`, `activeFrom`, `activeUntil`, `createdAt` | `criteria` values (a brief's content is not an analytics dimension) |
| `db.nobodyMissedReviews` | `orgId`, `briefId`, `state`, `createdAt`, `updatedAt` | — |
| `db.secondLookItems` | `orgId`, `status`, `createdAt`, `updatedAt` | dismissal free text |
| `db.dynamicWatchlists`, `db.watchlistHistory` | `orgId`, `status`, `at`, entered/exited counts | — |
| `db.trials` | `orgId`, `acceptedAt`, `proposedDate`, `reportDueAt`, `status` | `notes` |
| `db.signings` | `orgId`, `ts` | attribution/billing fields |

Authorisation is unchanged and comes first: a metric counts a record only if
the requesting organisation already owns it. No metric crosses an organisation
boundary, and no metric names a player the organisation may not currently see.

---

## Catalogue

### Family F — pipeline shape

#### F1 · `pipeline_stage_counts`
- **Definition** — how many of this organisation's Recruitment Rooms currently sit in each of the 13 room statuses.
- **Unit** — count of rooms, per status.
- **Source** — `db.recruitmentCases[].room.status`.
- **Numerator / denominator** — count; no denominator.
- **Time semantics** — point-in-time.
- **Small-n** — none; counts are never suppressed.
- **Limitation** — A status is where a room is, not how far it has travelled. A room that has sat in Watching for a year looks identical here to one opened this morning.

#### F2 · `funnel_progression`
- **Definition** — of the rooms **opened** in the window, how many ever reached each subsequent stage, at any later time.
- **Unit** — count, plus a step-to-step rate where the denominator allows.
- **Source** — `history[].action === 'room_status_changed'` with `detail.to`, plus `createdAt`.
- **Numerator** — rooms whose history contains a transition *to* stage S. **Denominator** — rooms opened in the window.
- **Time semantics** — window-entry for the cohort; the reaching event may fall outside the window, which is stated.
- **Small-n** — rates withheld below 5 rooms in the cohort.
- **Limitation** — Rooms can be reopened, so this is not a one-way funnel: a room counts once for each stage it ever reached, not once per visit. A recent window is incomplete by construction — rooms opened last week have not had time to reach a signing.

#### F3 · `exit_reason_mix`
- **Definition** — for rooms that reached a terminal status in the window, the distribution of recorded reason codes by the four M17 categories (`football`, `evidence`, `process`, `outcome`).
- **Unit** — count and share, per category.
- **Source** — `db.roomDecisions[].reasonCodes` → `reasonCategory()`.
- **Numerator** — decisions carrying ≥1 code in category C. **Denominator** — terminal-in-window decisions. A decision with codes in two categories counts in both, so shares sum to ≥100%; the payload says so.
- **Time semantics** — window-completion.
- **Small-n** — shares withheld below 5.
- **Limitation** — This is the reason the club recorded, not the reason that operated. A decision carrying codes in two categories counts in both, so the shares add up to more than 100%.

#### F4 · `trial_process` (M23 P4B)
- **Definition** — counts of Trial process steps that happened in the window: invitations sent, invitations declined, trials accepted, schedules confirmed by the family, trials completed, trials cancelled.
- **Unit** — count of trials per step; the headline number is completions.
- **Source** — `db.requests[]` (type `trial`, tied to a case: `createdAt`, `respondedAt`, `status`) and `db.trials[]` (`acceptedAt`, `schedule.confirmedAt`, `completion.state`, `completion.at`).
- **Numerator / denominator** — counts only; **no denominator, no rate**. A completion count beside an invitation count is not a conversion rate and the panel says so.
- **Time semantics** — window-entry per step: each step is counted on the day it happened, so one trial can appear under several steps in one window.
- **Small-n** — none; counts are never suppressed and no rate exists to withhold.
- **Limitation** — These are counts of process steps in the window — invitations sent, accepted, schedules confirmed, trials completed, cancelled or declined — never how a trial went. No rate is built on them: a club that invites five players and completes three has not "converted 60%", it has run three trials.
- **What it never reads** — attendance notes, assessments, observations, the message, the venue, the reason text.

### Family T — how long the process takes

All T metrics report **median and interquartile range**, never a mean: one
eighteen-month room would move a mean and tell a director nothing.

#### T1 · `time_to_first_decision`
- **Definition** — elapsed time from room creation to the first recorded decision on that room.
- **Unit** — days.
- **Source** — `createdAt` → earliest `db.roomDecisions[].createdAt` for the room.
- **Denominator** — rooms with at least one decision, completing in the window.
- **Time semantics** — window-completion.
- **Small-n** — withheld below 5 observations.
- **Limitation** — Rooms that never reached a decision are excluded, so this measures the rooms that got there. The number excluded is shown beside it.

#### T2 · `time_in_stage`
- **Definition** — for each status, the median time a room spent in it before leaving.
- **Unit** — days, per status.
- **Source** — consecutive `room_status_changed` entries in `history`.
- **Denominator** — completed stage visits.
- **Time semantics** — window-completion (the *exit* falls in the window).
- **Small-n** — per-status suppression below 5 visits.
- **Limitation** — Only completed visits count. A stage where everything is stuck therefore looks fast, because only the rooms that escaped it are measured — Stalled rooms is the figure that catches that.

#### T3 · `time_to_trial_requested`
- **Definition** — from room creation to the first transition to `trial_requested`.
- **Unit** — days. **Denominator** — rooms that reached `trial_requested`.
- **Time semantics** — window-completion. **Small-n** — 5.
- **Limitation** — A club that opens rooms late in its own process looks fast here. This measures the ScoutBox record, not the club’s thinking.

#### T4 · `time_trial_requested_to_completed`
- **Definition** — from the transition to `trial_requested` to the transition to `trial_completed`.
- **Unit** — days. **Denominator** — rooms reaching `trial_completed`. **Small-n** — 5.
- **Limitation** — Guardian response, pitch availability and school holidays all live inside this number and cannot be separated from it.

#### T5 · `open_room_age`
- **Definition** — the age distribution of rooms currently open.
- **Unit** — days. **Time semantics** — point-in-time. **Small-n** — 5.
- **Limitation** — Age is not neglect. A long-running room on a fourteen-year-old being tracked to sixteen is the product working as intended.

### Family A — work that has stopped moving

#### A1 · `stalled_rooms`
- **Definition** — open rooms with no history entry for more than N days (N ∈ {14, 30, 90}, the director picks).
- **Unit** — count, and the list of rooms.
- **Source** — `max(history[].at)` vs now, filtered to `OPEN_ROOM_STATUSES`.
- **Time semantics** — point-in-time. **Small-n** — none (a count).
- **Limitation** — No activity in ScoutBox is not no activity. A scout who watched a player on Saturday and did not write it down produces a stalled room. This is a prompt to look, not a finding.

#### A2 · `overdue_trial_reports`
- **Definition** — trials in `awaiting_report` past `reportDueAt`.
- **Source** — `db.trials`. **Time semantics** — point-in-time.
- **Limitation** — This surfaces an obligation the server already enforces — unfiled reports block new trial requests. It adds no new judgement.

#### A3 · `decision_outstanding`
- **Definition** — rooms in `offer_consideration` or `offer_made` with no recorded decision. This is M17's existing `DECISION_OUTSTANDING` readiness reason, counted.
- **Time semantics** — point-in-time.
- **Limitation** — This reuses the Recruitment Room’s own readiness rule. If that rule is wrong, this is wrong in exactly the same way — deliberately, so there is one definition rather than two.

### Family D — decision record hygiene

These measure whether the club **wrote down** what it did. None of them
measures whether what it did was right.

#### D1 · `terminal_with_recorded_decision`
- **Numerator** — rooms reaching a terminal status in the window that have ≥1 decision. **Denominator** — all rooms reaching a terminal status in the window.
- **Time semantics** — window-completion. **Small-n** — 5.
- **Limitation** — Ending a room for a reason-required status records a decision automatically, so this rate is high by construction. Its value is in the exceptions.

#### D2 · `superseded_decision_rate`
- **Definition** — share of decisions in the window that were later superseded by a revision on the same room.
- **Time semantics** — window-entry. **Small-n** — 5.
- **Limitation** — Revising a decision is healthy. A high figure here is not a fault and is never coloured as one.

#### D3 · `evidence_limited_exits`
- **Definition** — share of terminal exits whose reason codes fall in the `evidence` category (`insufficient_full_match`, `insufficient_recent_evidence`, `reference_missing`, `combine_missing`).
- **Why it exists** — this is the one number in M20 that points at something a director can actually fix: if a third of passes are for missing evidence rather than football, the club's evidence pipeline is the constraint, not its judgement.
- **Time semantics** — window-completion. **Small-n** — 5.
- **Limitation** — Association only. It does not follow that collecting the missing evidence would have changed any of these decisions.

#### D4 · `reopen_rate`
- **Definition** — share of rooms that entered a terminal status and later left it (`room_reopened`, or a transition out of a terminal status).
- **Time semantics** — window-entry on the terminal event. **Small-n** — 5.
- **Limitation** — Reopening is intended behaviour — Second Look exists to cause it. High is not bad.

### Family C — coverage of the club's own stated demand

#### C1 · `briefs_live`
- **Definition** — briefs currently `active` and inside their date window.
- **Source** — `db.recruitmentBriefs` + `briefIsLiveOn(today)`. **Time semantics** — point-in-time.
- **Limitation** — A brief being live says nothing about whether anyone is working it.

#### C2 · `nobody_missed_backlog`
- **Definition** — open Nobody Missed reviews, per live brief.
- **Time semantics** — point-in-time. **Small-n** — none (count).
- **Limitation** — The backlog is a function of how wide the brief is. Widening a brief creates backlog without anyone having done anything wrong.

#### C3 · `nobody_missed_review_rate`
- **Numerator** — reviews not in `open`. **Denominator** — all reviews for live briefs.
- **Time semantics** — point-in-time. **Small-n** — 5.
- **Limitation** — Dismissing a candidate counts as reviewing them. This measures that the club looked, not what it concluded.

#### C4 · `second_look_backlog`
- **Definition** — Second Look items currently `open`, and their age distribution.
- **Time semantics** — point-in-time.
- **Limitation** — An expired item is not backlog — expiry is a designed outcome and is counted separately.

#### C5 · `second_look_response_time`
- **Definition** — median days from a Second Look item being created to its first status change.
- **Denominator** — items that changed status. **Small-n** — 5.
- **Limitation** — Items never touched are absent from this figure. Their count is shown beside it.

### Family S — where work comes from

#### S1 · `room_source_mix`
- **Definition** — rooms opened in the window, by `room.sourceContext` (the 12 M17 contexts).
- **Time semantics** — window-entry. **Small-n** — shares withheld below 5.
- **Limitation** — Direct is the fallback ScoutBox assigns to anything it does not recognise, so it is a residual bucket rather than a surface people used.

#### S2 · `source_stage_reach` *(association only)*
- **Definition** — for each source context, of the rooms opened from it in the window, how many later reached `trial_requested` or beyond.
- **Time semantics** — window-entry cohort. **Small-n** — 5, strictly enforced; most contexts will be suppressed in a real club and that is the correct outcome.
- **Required label, rendered with the panel and carried in the payload** — *"ScoutBox observes that these rooms came from this surface and later reached this stage. It does not show that the surface caused it: scouts choose where to look, and the players they find there differ in ways ScoutBox does not measure."*
- **Limitation** — Confounded by construction, and never a ranking of surfaces: sources are listed alphabetically. Most will be withheld for too few rooms, which is the correct outcome rather than a gap.

### Family W — dynamic watchlists as a work surface

#### W1 · `active_watchlists`
- **Definition** — count of `active` dynamic watchlists. **Time semantics** — point-in-time.
- **Limitation** — A big list is a wide set of criteria, nothing more.

#### W2 · `watchlist_membership_churn`
- **Definition** — entries and exits recorded in `db.watchlistHistory` in the window.
- **Time semantics** — window-entry.
- **Limitation** — ScoutBox does not recompute watchlists in the background: membership is worked out when someone opens a list. This counts those recalculations, not the moment a player’s facts changed — a list nobody opens records no change at all.

---

## Metrics considered and rejected

Kept here because §5 requires that no metric exist merely because it can be
calculated — the rejections are part of the design.

| Rejected | Why |
|---|---|
| Rooms opened per scout / decisions per scout | A leaderboard with the ranking left as an exercise for the reader. |
| Assessment volume per scout | Same, and it would reward writing more rather than looking harder. |
| Time-to-signing as a headline | The denominator is tiny in any real club, the confounders are total, and it reads as a target. |
| Player-level "progressed furthest" list | A player ranking assembled from process events. |
| Average number of criteria met (M19) | M19 refuses to score a match; averaging the coverage count across players would smuggle the score back in through analytics. |
| Note length, comment count, response tone | Private notes are not analytics data. |
| Watchlist size as a quality signal | A big list is a wide brief, nothing more. |
| Sentiment or keyword extraction from any free text | Out of scope for this product at any milestone. |
