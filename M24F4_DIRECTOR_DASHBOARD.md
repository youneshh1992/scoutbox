# M24F.4 — Director Dashboard

The Director Dashboard (Pro and Grassroots, `#/recruitment/dashboard`) measures the
recruitment process — never a player, never a colleague. M24F.4 gives it an
executive layer above the seven metric families without changing a single figure,
sentence or attribute the M20 contract protects (`e2e/m20Live.test.mjs`, 59 checks,
unchanged and green).

## 1. What the director sees first

```
[ governing sentence — the server's note, the only prose on the top of the page ]
Period ▾   Where the room came from ▾   Priority ▾   Count a room as stalled after ▾
There is no filter by colleague here, and there will not be one. …
7 Jul 2026 to 4 Oct 2026 · A rate over fewer than 5 records is shown as counts instead · Calculated at 4 Oct, 12:01

  7              1                  2               1
  Open cases     Trials completed   Offers issued   Signed

  Recruitment funnel                 Time by stage
  watching      ████████████ 9       watching      ████████ 10.5 days
  under review  ████████████ 9       under review  █████████ 13 days
  shortlisted   ████████ 6           Typical days a room spends in a stage before leaving it.
  …
  Coverage                           Needs attention
  (ring) 63%  Eligible players       Chinedu Okafor — Offer consideration · nothing written for 31 days
  reviewed · 1 live, of 2 briefs ·   2 of 3 trials awaiting a report are past their due date
  3 unreviewed                       1 of 1 rooms at an offer stage have no recorded decision

Compared with the previous period …
Detail
  Pipeline shape · How long the process takes · Work that has stopped moving · …
```

## 2. Where every number comes from

| Element | Source (server payload) | Client arithmetic |
| --- | --- | --- |
| Open cases | `pipeline.pipeline_stage_counts.rows` — sum of the non-terminal statuses | a sum of the server's counts |
| Trials completed | `pipeline.trial_process.steps.completed.value` | none |
| Offers issued | `pipeline.journey_evidence_funnel.rows[stage=offer_issued].value` (falls back to the sum of the `offer_*` statuses) | none / a sum |
| Signed | `journey_evidence_funnel.rows[stage=signed].value` (falls back to the `signed` status) | none |
| Recruitment funnel bars | `pipeline.funnel_progression.rows` (stage, value) in the server's order | bar length = value / max value |
| Time by stage bars | `duration.time_in_stage.rows` — only rows with a median the server did not suppress | bar length = median / max median |
| Coverage ring | `coverage.nobody_missed_review_rate` (a Figure: value, n, suppressed) | the ring draws the server's percent; a suppressed or empty figure draws nothing and prints the server's words |
| Needs attention | `aging.stalled_rooms.rows` (≤ 3, each opens `#/recruitment/rooms/:id`), then `overdue_trial_reports` and `decision_outstanding` counts (each opens the drill-down) | capped at five lines |

No rate, score or rank is computed on the client. A `Figure` that the server
withheld ("too few to express as a rate") stays withheld. The KPI strip shows "—"
when a family is unavailable.

## 3. The contract that did not move

| Protected element | Where it still is |
| --- | --- |
| `[data-screen="director-dashboard"]`, `[data-principle]` sentence ("do not measure any player" / "colleague") | top of the page |
| `[data-no-person-filter]` "no filter by colleague"; ≥ 3 selects, none named for a person; `Period` takes keyboard focus; the window in the hash | the filter card |
| `[data-trend-strip]` with three `[data-trend]` cells and "Compared with the previous period"; no Infinity / NaN | below the executive layer |
| `[data-calculated-at]`, `[data-window]` | the window line |
| seven `[data-family]` sections; `[data-metric]` panels each with a `[data-limitation]`; none inside a `<details>` | "Detail" |
| `[data-not-a-funnel]`, "Reopened after ending", "Under review", "looks fast", `[data-median]` / `[data-suppressed]` / `[data-excluded]`, "too few to express as a rate", "Nothing in this period", no "0% of 0" | the family panels, as before |
| `[data-association]` "does not show that the property caused it"; sources alphabetical; "not a ranking of surfaces" | Where work comes from |
| `[data-drilldown]` with its limitation; `See all` | the drill-down card |
| Scout refused (`LEAD_REQUIRED`, no sidebar entry); partial payload renders six families; FR title "Tableau de bord du directeur"; fits 390 px | unchanged |

## 4. Visual system

- One colour for data: `--sb-green-text` on bars and rings, `--sb-wash` for tracks.
  Ink and quiet text from the tokens, so dark mode inherits (`:root[data-theme="dark"]`).
- Bars: a 10 px rounded track, a label column that truncates, a tabular number.
- Ring: a 36-unit SVG circle, stroke-dasharray from the percent, the number in the
  middle, the server's words beside it.
- The KPI strip reuses `.stat` (ruled figure, 38 px number, quiet label) — no boxes.
- The seven families render in `.dash-panels` (auto-fill grid, 320 px minimum),
  each panel a ruled block with its heading, its figure, its table and its limitation.

## 5. Copy

The subtitle paragraph ("How your recruitment work moves…") is gone; the
server's governing sentence is the only prose above the numbers. New labels:
`m20.kpi.*` (Open cases, Trials completed, Offers issued, Signed), `m20.exec.*`
(At a glance, Recruitment funnel, Time by stage, Coverage, Needs attention,
Nothing is waiting on you, Detail) in English and French.

## 6. Evidence

Before / after: `design-system/screenshots/m24f4-before-director-dashboard-1280.png`
and `m24f4-after-director-dashboard-1280.png` (first screen) plus the tall capture
`m24f4-after-director-dashboard-tall-1280.png`. Words on the first screen fall from a
wall of tables to four numbers and four visuals; the detail keeps its 2 500 words,
which is the contract's own limitation text (one per panel, 30 panels).
