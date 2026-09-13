# ScoutBox M20 — Recruitment Analytics and the Director Dashboard

> **Measure the recruitment process, not the worth of the player or the scout.**

That sentence is not a slogan attached to this milestone afterwards. It is the
reason each of the twenty-four metrics exists, the reason a dozen more do not,
and the thing the acceptance suite spends most of its effort defending.

---

## 1. What M20 answers

A recruitment director can now see how their organisation's recruitment **work**
moves:

- what is in flight, and at which stage;
- what has stopped moving, and for how long;
- how long each step of the process actually takes;
- whether endings were written down, and what kind of reason was recorded;
- whether the demand the club itself wrote down is being covered.

Every one of those is a question about a **process**. A director can act on all
of them by changing how the club works — who reviews what, how quickly, with
what evidence, in what order.

## 2. What M20 refuses to answer

- Who is the best player in the pipeline.
- Which scout is performing well.
- Whether a past decision was correct.
- Whether a source of players is "better" than another.
- Anything at all that requires reading what a colleague privately wrote.

These are refusals, not gaps. §6 lists the specific things that will never be
built and the mechanism that stops them appearing by accident.

## 3. Where the numbers come from

M20 **stores nothing**. There is no analytics table, no materialised rollup and
no cache. Every figure is projected on read from records M12–M19 already own:

| Source | What M20 takes from it |
|---|---|
| `db.recruitmentCases` | the room's status, priority, source context, creation time, and its append-only `history[]` |
| `db.roomDecisions` | the recommendation, the structured reason **codes**, the timestamp, and whether a decision was later superseded |
| `db.recruitmentBriefs` | status and date window, to know which demand is live |
| `db.nobodyMissedReviews` | the workflow state — open, or looked at |
| `db.secondLookItems` | the workflow state and its two timestamps |
| `db.dynamicWatchlists`, `db.watchlistHistory` | how many lists are active, and what reconciliation found |
| `db.trials` | which mandatory reports are past due |

Because a figure **is** the record read differently, a number on the Director
Dashboard cannot disagree with the Recruitment Room it came from. That is the
whole point of refusing a second store.

## 4. One clock

Every duration, every funnel step and every aging figure is derived from
`history[].at` — the timestamp M12's `audit()` helper writes on every recorded
action. M20 never invents a timestamp, and never infers one from the order
records happen to sit in an array.

## 5. What is never read

The projection destructures only the fields the metric registry declares.
`note`, `by`, `byId`, `byName`, comment bodies and assessment narrative are not
among them, and `projectRoom` actively **strips** the actor off every history
entry before any family sees it — so the analytics layer cannot attribute a
status change to a person even by accident.

Reason **codes** are different, and legitimately countable: they are a closed
vocabulary the club chose from a list it can see. The private prose beside them
is not analytics data and never leaves the Room.

## 6. What will never be built

`FORBIDDEN_METRIC_NAMES` in `m20/metrics.mjs`, published on the catalogue route
and rendered on the page under "What this page will never show":

- Recruitment Score · Scout Score · Player Success Score · Recruitment
  Efficiency Score · Talent Conversion Score · Club Intelligence Score
- any other blended overall number
- a leaderboard, a scout ranking, a player ranking, a "top scout"

`assertMetricRegistry()` runs at boot and **throws** if any of those names
appears in a metric id or name, if a metric declares it reads a private field,
if a comparison metric forgot to declare itself association-only, or if any
metric ships without a stated limitation. The process does not start; the
number never reaches a director.

## 7. No person is a dimension

`GROUP_DIMENSIONS` is `status`, `source_context`, `priority`, `reason_category`,
`brief` — five properties of the **work**.

`PERSON_DIMENSIONS` exists so that `?groupBy=scout` can be refused *by name*
rather than falling through the same "unknown dimension" path as a typo:

```
400 GROUPING_BY_PERSON_REFUSED
ScoutBox does not break recruitment analytics down by person. These figures
measure the process, not any colleague's performance, and a per-person
breakdown of them would be a scout leaderboard.
```

The filter row on screen carries the same promise in plain words, in both
languages, because an absence nobody notices is not a guarantee.

## 8. The twenty-four metrics

Full definitions — unit, source records, numerator, denominator, time
semantics, small-n policy and limitation — live in **`M20_METRICS.md`**, which
is the single place a definition may be written down. The registry in
`m20/metrics.mjs` and that document are cross-checked by the acceptance suite
in both directions.

Seven families:

| Family | Answers |
|---|---|
| Pipeline shape | where the work is, and which stages it has reached |
| How long the process takes | the typical time for each step |
| Work that has stopped moving | what is stalled, overdue or undecided |
| Decision record hygiene | whether endings were written down, and what kind of reason was given |
| Coverage of your stated demand | whether the briefs the club wrote are being worked |
| Where work comes from | which surfaces rooms were opened from |
| Dynamic watchlists | how many lists are live, and what reconciliation found |

## 9. Three answers, never collapsed into one

Every rate can come back in one of three states, and they are three different
facts:

| State | Payload | On screen |
|---|---|---|
| nothing happened | `{ n: 0, empty: true, value: null }` | "Nothing in this period" |
| it happened, none met the condition | `{ n: 12, value: 0 }` | "0% of 12" |
| too few to be a rate | `{ n: 4, numerator: 1, suppressed: true, value: null }` | "1 of 4 — too few to express as a rate (fewer than 5)" |

A dashboard that renders all three as "0%" is lying twice. Nothing in the client
coerces one into another; `figureText` takes the words for each and picks.

## 10. Small-n

`SMALL_N_MIN = 5`. A ratio or a median over fewer than five observations is
withheld, and the raw numerator and denominator are shown instead.

Stricter than M18's `SUPPRESS_MIN` of 3, deliberately: a ratio invites a
conclusion that a list does not. "We convert 33% of trials" reads as a finding
even when it means one trial out of three.

**Counts are never suppressed.** A director must be able to see their own three
rooms — hiding a count would be withholding the club's own work from it.

Per-person breakdowns are not suppressed either. They are **absent**: there is
no parameter that produces one.

## 11. Medians, never means

Every duration reports a median with an interquartile range and the number of
observations behind it. One eighteen-month room would move a mean and tell a
director nothing true about the other forty.

## 12. The exclusion is always reported

A duration is computed over the records that **finished**. That quietly flatters
a club whose work is stuck: the rooms still sitting in a stage contribute
nothing to that stage's median, so a stage where everything is stuck measures
*fast*.

Rather than hide that, every duration ships the count it could not include and
a sentence saying what the exclusion means — and time-in-stage points explicitly
at Stalled rooms, the figure that catches what it cannot see.

## 13. The funnel is not a conversion funnel

M17 makes reopening first-class: an archived room can return to `under_review`,
and Second Look exists precisely to cause that. So:

- a room is counted once for **every stage it ever reached**, in a set, not once
  per visit and not as a monotonic drop-off;
- the payload carries `monotonic: false` so a client cannot render it as one;
- reopenings within the cohort are counted and shown;
- a reopening written as both `room_reopened` and `room_status_changed` at the
  same instant (which the normal path does) is **one** transition, not two.

A club whose rooms cycle is not a club whose funnel is broken.

## 14. A young cohort says so

A window shorter than a typical journey cannot contain completed journeys for
the rooms opened near its end, so any conversion-shaped figure over it reads
low. The payload flags `cohortIncomplete` and the screen says so in a sentence.

Nothing is adjusted. A caution is honest; a correction factor invented to make a
number look right is not.

## 15. Association, never cause

One metric compares groups: `source_stage_reach` — of the rooms opened from each
surface, how many later reached a trial or beyond.

It is the most dangerous figure in M20 and it is built defensively:

- `associationOnly: true` and the association sentence travel **in the payload**,
  so a client cannot render the number without the caveat;
- sources are ordered **alphabetically**, never by rate, so it can never be read
  as a league table of surfaces;
- suppression below five is enforced without exception — most contexts in a real
  club will be withheld, and that is the correct outcome rather than a gap.

The sentence, verbatim:

> ScoutBox observes that these records share this property and later reached
> this stage. It does not show that the property caused it: people choose where
> to look, and the players they find differ in ways ScoutBox does not measure.

## 16. Every panel prints its own limitation

Not a tooltip. Not an asterisk. Not a help page. The limitation is a sentence in
the metric registry, it travels with the number on the wire, and it renders
directly beneath the figure in the same block.

A figure whose caveat is one click away is a figure without a caveat. Both the
live suite and the demo spotcheck count panels and limitations and require the
second to be at least the first.

## 17. Windows

Inclusive UTC calendar days, the same rule M18.2 established for brief date
boundaries. A club in UTC+13 and one in UTC−7 see the same boundary instant.

Presets: 30 / 90 / 180 / 365 days, default 90. A custom range is accepted as two
well-formed days in order; anything else is refused rather than silently
repaired, because a quietly widened window changes every number on the page
without saying so.

## 18. Time semantics

Three, and every metric declares exactly one on the wire:

- **point-in-time** — the state of the world now; the window does not apply.
- **window-entry** — counted in the window the entry event happened in.
- **window-completion** — counted in the window the completing event happened in.

"How many rooms" means three different things depending which is meant, so the
screen prints the semantics under each panel's name.

## 19. Who can read it

Leads and directors only, through the existing `requireLead`. There is no
separate `director` role in ScoutBox and inventing one would fork the permission
model, so a director *is* a lead — `isLead()` matches head / director / lead /
manager / owner / chief on the organisation role.

A scout sees their own work in their own Rooms; the organisation-wide view is
administrative. Everyone else — other organisations, players, guardians, Trust &
Safety — gets exactly what a route that does not exist would give them.

## 20. One organisation, always

Every projection filters `orgId` first, before any other predicate. A player is
named in a drill-down row only if `orgCanSee` says the organisation may
currently see them — and if it does not, the room is still **counted**, because
a count is not a disclosure.

## 21. Partial failure

Each of the seven families is computed inside its own boundary. A family that
throws yields `{ error: 'FAMILY_UNAVAILABLE' }` in its own slot with the reason
(never a stack trace), the response is still 200, `partial: true` names what is
missing, and every other panel renders.

A dashboard that silently drops a panel is lying about coverage: the director
reads six panels and believes they are looking at the whole picture.

## 22. Drill-down

Four metrics carry rows: stalled rooms, offers with no recorded decision,
endings with a recorded decision, and overdue trial reports. The contract is
M18.2's: cursor pagination, at most 50 rows a page, stable order (oldest first,
then id), the ordering declared on the wire, and the metric's limitation
travelling with the rows.

## 23. What M20 does not emit

No new live event — the event registry is unchanged. No new notification
category. M20 notifies nobody, ever: a dashboard that pushes numbers at people
becomes a performance review by another route.

## 24. Schema and migration

`SCHEMA_VERSION` moves to **2000**. The single M20 step,
`m200_001_analytics_sources_present`, is additive, idempotent, and creates **no
analytics store** — all it does is guarantee the collections M20 *reads* exist
on a snapshot that predates them. `db.trials` in particular had only ever been
created by the seed, so a snapshot restored without it would have thrown on the
first trial read, with or without M20.

## 25. What it costs

Measured by `scripts/m20Perf.mjs` at 100 / 500 / 1000 rooms, in memory, on one
warm process:

| Rooms | Whole dashboard read | Context build | The 24 metrics | One family (drill-down) |
|---|---|---|---|---|
| 100 | ~1.6 ms | ~10% | ~90% | ~0.1 ms |
| 500 | ~7.9 ms | ~5% | ~95% | ~0.7 ms |
| 1000 | ~14.3 ms | ~7% | ~93% | ~1.6 ms |

The finding is the opposite of what the design was optimised for. The
single-pass reporting context — the thing built to avoid twenty-four scans — is
under a tenth of a read. The cost is the families re-walking each room's history
once per metric that needs a transition list.

It has been **documented rather than fixed**. 14 ms at a thousand rooms is not a
problem worth memoising for, and a transition cache would be a second copy of a
derivation this milestone promised not to keep. If a club ever reaches the size
where it matters, memoising `transitions(room)` on the projected room is the
first move, and the probe is how you would know it worked.

The store is a snapshot store — collections of JSON held in memory — so there is
no index to add and none was added: a scan **is** the access path.

## 26. Honest limitations

Everything below is a real constraint of this build, stated here rather than
discovered later.

1. **A stalled room is not a neglected player.** "No activity in ScoutBox" is not
   "no activity". A scout who watched a player on Saturday and did not write it
   down produces a stalled room. Every aging figure is a prompt to look, not a
   finding.
2. **Duration metrics measure only what finished.** A stage where everything is
   stuck looks fast. The excluded count and the pointer to Stalled rooms are the
   mitigation; they are not a fix.
3. **Watchlist churn counts recalculations, not changes.** M19 has no scheduler:
   membership is worked out when someone opens a list. A list nobody opens
   records no change at all.
4. **The funnel's later stages are always incomplete** for recent windows, and a
   cohort younger than a typical journey is flagged rather than corrected.
5. **Reason mixes describe what the club wrote down**, not what operated. A
   decision carrying codes in two categories counts in both, so shares exceed
   100%.
6. **`direct` is a residual bucket**, not a surface anyone used — it is what
   `normaliseSourceContext` assigns to anything unrecognised. The panel labels it.
7. **`source_stage_reach` is confounded by construction.** Scouts choose where to
   look, and the players they find on each surface differ in ways ScoutBox does
   not measure.
8. **Point-in-time metrics cannot be asked about the past.** "How many rooms were
   stalled last March" is a different question this build does not answer, and
   answering it approximately would be worse than declining.
9. **The evaluation-coverage figures inherit M18's definitions**, including its
   90-day recent-decision rule and its 365-day assessment freshness. If those are
   wrong, these are wrong in exactly the same way — deliberately, so there is one
   definition rather than two.
10. **Small-n suppression hides real information from small clubs.** A club with
    four endings this quarter sees counts, not rates. That is the intended trade:
    a rate over four records is more misleading than no rate at all.
11. **`decision_outstanding` reuses M17's readiness rule** rather than defining
    its own. Same trade as above.
12. **Perf figures are synthetic and single-machine.** A real club's history is
    longer per room than the fixture and its player records are heavier. Treat the
    shape — linear, family-dominated — as the finding.
