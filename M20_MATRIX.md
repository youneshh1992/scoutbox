# M20 — Recruitment Analytics + Director Dashboard: implementation matrix

Written **before** any M20 code, from a pre-flight read of the existing system.
Every row is a requirement, the implementation it will get, the test that will
prove it, its status, and the limitation that will remain.

Baseline at the time of writing: branch `claude/desktop-project-migration-wyk3ec`,
tip `442de7e`, clean tree, 92 commits ahead of origin, nothing pushed. Full
server battery green (exit 0): testTrust 23 · connectedE2E 43 · m12 143 ·
m13 212 · m14 193 · m14.1 94 · m15 185 · m16 115 · m16.1 · m16.2 · m17 ·
m18 · m18.1 · m18.2 · m19.

## What M20 answers

> **Measure the recruitment process, not the worth of the player or the scout.**

A recruitment director can see how their organisation's recruitment **work**
moves: what is in flight, what has stopped moving, how long each step takes,
whether decisions were written down, and whether the club's own stated demand
is being covered. Nothing in M20 evaluates a player and nothing in M20
evaluates a colleague.

The metric definitions live in **`M20_METRICS.md`** — one file, versioned by
`RECRUITMENT_ANALYTICS_POLICY_VERSION`, and the single place a definition may
be written down.

## Pre-flight findings that shape the work

| # | Finding | Consequence for M20 |
|---|---|---|
| P1 | Every recruitment record already carries an append-only `history[]` written by one helper — M12's `audit(record, byKind, byId, byName, action, detail)` → `{id, at, byKind, byId, byName, action, detail}`. | This is the **only** clock M20 uses. Every duration, funnel step and aging figure projects from `history[].at`. M20 invents no timestamp and infers none from array order. |
| P2 | `db.recruitmentCases[].room` holds `status`, `priority`, `sourceContext`, `archivedAt`, `closedAt`, `rev`; `applyStatus()` is the *single writer* of status and stamps the history entry `room_status_changed` with `detail.from`/`detail.to`. | The funnel is derivable exactly, with no new write path and no instrumentation. M20 adds **zero** fields to the room record. |
| P3 | `ROOM_STATUSES` is 13 values with `TERMINAL_ROOM_STATUSES = ['signed','withdrawn','archived','closed']`, and `ROOM_TRANSITIONS` makes **reopening first-class** (`archived: ['under_review','closed']`). | The funnel is **not monotonic**. A cohort metric must count "ever reached stage S", not "is at stage S", and must say that reopening exists. A conversion-style funnel that assumes one-way travel would be wrong for this product. |
| P4 | `REASON_CODES` is a closed, four-category vocabulary (`football`, `evidence`, `process`, `outcome`) with `reasonCategory(code)`; the private note sits beside it in the same decision record. | Reason **codes** are legitimate analytics data — the club chose them from a list it can see. The **note** is not, and the projection must never read `d.note`. A source sweep asserts it. |
| P5 | `db.roomDecisions` is append-only with `supersedes` / `supersededById`; `recordDecision` never rewrites a predecessor. | Decision history is safe to project without reconstructing anything. "First decision" and "current decision" are both cheap and both unambiguous. |
| P6 | M17 already computes `lastActivityAt` on the room list as `history.reduce(max)`, and already emits `DECISION_OUTSTANDING` in `decisionReadiness`. | Aging and "decision outstanding" reuse M17's existing definitions rather than inventing parallel ones. One definition per concept, even at the cost of importing across modules. |
| P7 | `isLead(user)` is a regex over the free-text org role (`/head|director|lead|manager|owner|chief/i`). There is no separate `director` role and inventing one would fork the permission model. | The Director Dashboard is **lead-only**, gated by the existing `requireLead`. A scout gets what a route that does not exist gives them. No new role, no new capability flag. |
| P8 | M18.2's audit view (`m182/audit.mjs`) already established the house rule for administrative projections: leads only, **no content**, structured detail keys only, bounded pages. Its `safeDetail()` allowlists exactly `from,to,status,priority,recommendation,version,criteriaChanged,sourceContext,kind` plus `reasonCodes` and a boolean `hadNote`. | M20 is the second such projection and follows the same three rules. Where M20 needs a detail key, it reads the same allowlisted set. |
| P9 | The store is a snapshot store: collections in memory, SQLite rows of JSON. No query planner, no indexes. Every projection is a linear scan of `db.recruitmentCases`, `db.roomDecisions` and friends, filtered by `orgId`. | "Index audit" is again an audit of in-memory read paths. A dashboard that computes ~20 metrics must scan each collection **once** and derive all families from that single pass, not once per metric. `m20Perf.mjs` measures at 100/500/1000 rooms and the result is published, whatever it is. |
| P10 | M12–M19 store no analytics facts, and `db.schema` (SCHEMA_VERSION 1900) records six ordered idempotent migrations. | M20 stores **no** recruitment truth. Its migration creates at most a saved-view container, nothing that could drift from the records it projects. Any new collection must be incapable of contradicting a Room. |
| P11 | The event registry refuses to boot in development on an unregistered broadcast name and strips payload keys not on the allowlist. | If M20 emits anything at all it must be registered first. Current expectation: **M20 emits no new event** — a dashboard is a read. |
| P12 | Notification `CATEGORIES` is an **object keyed by id** (13 entries), and `categoryOf` falls to `null` for an unknown type, which is delivered and counted. | If M20 introduces no notification — the current expectation — no category is added. A dashboard that emails people about their numbers is the leaderboard by another route. |
| P13 | Windows in this codebase are inclusive UTC calendar days (`briefIsLiveOn`, M18.2 date-boundary work). Local time has never been used for a boundary. | M20 reuses that helper for every window. A club in UTC+13 sees the same boundary rule as everyone else, and the docs say which. |
| P14 | `SOURCE_CONTEXTS` has 12 values and `normaliseSourceContext` **falls back to `direct`**. | `direct` is a residual bucket, not a channel. The source-mix panel must label it that way or it will be read as "most of our work comes from nowhere". |
| P15 | M19 Dynamic Watchlists have **no scheduler**: membership is reconciled on read, and `db.watchlistHistory` records the reconciliation, not the moment the underlying fact changed. | Watchlist churn measures *reconciliations*, which is a weaker claim than it looks. The metric ships with that sentence attached, or it does not ship. |
| P16 | M18's Nobody Missed uses `SUPPRESS_MIN = 3` for its own suppression, and `COVERAGE_POLICY` already carries the note "not a measure of scouting quality, player talent, or freedom from bias". | M20 sets its own `SMALL_N_MIN = 5` for ratios (stricter, because a ratio is more inviting than a list) and reuses M18's wording discipline rather than writing a new disclaimer voice. |
| P17 | `db.trials` carries `status: 'awaiting_report'` and `reportDueAt`, and unfiled reports already **block** new trial requests server-side. | The overdue-report metric surfaces an existing enforcement, not a new judgement. |
| P18 | The org sidebar is already dense, and M18.2 §87-equivalent discipline kept the audit log inside an existing section. | The Director Dashboard goes **inside the existing Recruitment section**, not as a new top-level sidebar item. |
| P19 | Client patterns are fixed: `ApiError.fromResponse`, `httpState.ts`, `provenance.ts`, `conflict.tsx`, `orgPanels.tsx`, `DEMO_MODE` from `api.ts`, `fr: typeof en` key parity, demo modules taking only `import type` from their API module. | M20 clients add no new pattern. A dashboard is a read surface: no dirty guard, no conflict UX, but full `httpState` handling including the partial-failure case, which is new to this codebase and needs its own component state rather than an error boundary. |

## Severity

**P1** correctness, privacy or safety · **P2** product-visible honesty or UX ·
**P3** operational clarity.

## Requirements

| # | Requirement | Sev | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|---|
| 1 | Measure the process, not the person | P1 | Every metric in `M20_METRICS.md` is a count or duration over workflow records; no metric takes a person as a dimension | m20E2E §1 (no route accepts a user id as a grouping parameter); source sweep for `byId`/`byName` in `m20/` | planned | |
| 2 | No blended overall number, ever | P1 | No metric produces a composite; the registry rejects a metric declaring more than one unit | m20E2E N1–N8 (each forbidden name absent from source, payload and both bundles) | planned | |
| 3 | No scout leaderboard, no per-person breakdown | P1 | `groupBy` accepts a closed list that contains no person dimension; anything else is 400 | m20E2E N9–N14 (`groupBy=scout`, `=user`, `=owner`, `=leadScout` each refused) | planned | |
| 4 | Private notes are never analytics data | P1 | Projections destructure only the allowlisted decision fields; `note` is never read | m20E2E §2 + source sweep of `m20/` for `.note`; D-series live check that no note text reaches the dashboard | planned | |
| 5 | No causation claimed where only association is observed | P1 | `S2` carries a mandatory association label in the payload and on screen; sources ordered alphabetically, never by rate | m20E2E §9; m20Live D9 (label visible, no ranking) | planned | Any cross-group comparison is confounded |
| 6 | No second copy of recruitment truth | P1 | `m20/` is pure projection: it reads `db`, writes nothing but an optional saved-view record | m20E2E §3 (a full dashboard read leaves every collection byte-identical) | planned | |
| 7 | Metric registry, one definition per metric | P1 | `m20/metrics.mjs`: `METRICS` keyed by id, each with unit, semantics, sources, small-n policy and limitation text; the doc and the registry are cross-checked | m20E2E §4 (every registry entry appears in `M20_METRICS.md` and vice versa) | planned | |
| 8 | `RECRUITMENT_ANALYTICS_POLICY_VERSION = 1` on every response | P2 | Set in `m20/metrics.mjs`, echoed in every payload | m20E2E §4 | planned | |
| 9 | Funnel is non-monotonic and says so | P2 | `m20/funnels.mjs` counts "ever reached", records reopen counts separately | m20E2E §5 (archive → reopen → shortlist counted once per stage, reopen counted) | planned | A cohort's later stages are incomplete by construction |
| 10 | Cohort incompleteness stated, not hidden | P2 | Window-entry cohorts carry `cohortIncomplete: true` when the window ends within the median time-to-terminal | m20E2E §5; m20Live D4 | planned | The heuristic is crude and is labelled as a caution, not a correction |
| 11 | Durations are medians with IQR and an observation count | P2 | `m20/timeSeries.mjs`; never a mean | m20E2E §6 (single outlier does not move the reported figure) | planned | |
| 12 | Exclusion bias of duration metrics is visible | P2 | Every duration ships with the count of records excluded for not having completed | m20E2E §6; m20Live D5 | planned | |
| 13 | Small-n suppression, `SMALL_N_MIN = 5` | P1 | Ratios and medians below 5 return `suppressed: true` with numerator/denominator | m20E2E §7 (n=4 suppressed, n=5 shown, boundary both ways) | planned | Counts are never suppressed; a director must be able to see their own three rooms |
| 14 | Empty is distinguished from zero | P2 | `{n: 0}` vs `{value: 0, n: 12}`; distinct copy | m20E2E §7; m20Live D6 | planned | |
| 15 | Lead-only, via existing `requireLead` | P1 | Every M20 route on `orgRouter` behind `requireLead` | m20E2E §8 (scout 403, other org 404-shaped, player and guardian rejected, T&S has no route) | planned | |
| 16 | Organisation isolation | P1 | Every projection filters `orgId` first, before any other predicate | m20E2E §8 (two seeded orgs, no leakage in any of ~20 metrics) | planned | |
| 17 | A player is named only if the org may currently see them | P1 | Drill-down lists reuse `orgCanSee`, as `m182/audit.mjs` does | m20E2E §8 (block mid-window hides the name, keeps the count) | planned | A count can persist after a name is withdrawn; that is the correct trade |
| 18 | Windows are inclusive UTC calendar days | P1 | Reuse M18.2's date helper | m20E2E §10 (boundary day at both ends, DST-free by construction) | planned | |
| 19 | One pass over each collection per dashboard read | P3 | `m20/dashboard.mjs` builds a single indexed context, then every family reads from it | m20Perf at 100/500/1000 rooms | planned | Figure published whatever it is |
| 20 | Partial failure renders the rest | P2 | Each family computed in isolation; a thrown family yields `{ error }` in its slot, HTTP 200 | m20E2E §11 (fault-injected family); m20Live D10 (panel shows the failure, others render) | planned | |
| 21 | Bounded drill-down | P2 | Reuse the M18.2 page contract: cursor, ≤50 rows, newest first, stable by (time, id) | m20E2E §12 | planned | |
| 22 | Migration is additive and cannot contradict a Room | P1 | One idempotent step in `m182/migrations.mjs`; `SCHEMA_VERSION` bumped to 2000 | m20E2E §13 (double-run is a no-op; a pre-M20 snapshot boots) | planned | |
| 23 | No new broadcast event | P3 | M20 emits nothing; the registry stays at 23 | m20E2E §13 (registry count unchanged) | planned | |
| 24 | No new notification category | P3 | M20 notifies nobody | m20E2E §13 (`CATEGORIES` still 13) | planned | A dashboard that pushes numbers at people becomes a performance review |
| 25 | Director Dashboard lives inside Recruitment | P2 | New screen under the existing section; no new top-level sidebar item | `navConfig.test.mjs` (item count unchanged at top level, destination unique) | planned | |
| 26 | Filters: window, and nothing that identifies a person | P2 | Window presets + custom range, brief, source context, priority. No scout filter | m20E2E §1; m20Live D2 | planned | |
| 27 | Deep-linkable state | P2 | `nav.ts` `DASHBOARD_HASH` + `dashboardFromHash`/`hashForDashboard`, matching the M19 pattern | `navConfig.test.mjs`; m20Live D3 (round-trip) | planned | |
| 28 | Every panel states its definition and its limitation on screen | P1 | Each panel renders the registry's `limitation` text; not a tooltip, not a footnote | m20E2E §9 (every registry entry's limitation string appears in both bundles); m20Live D8 | planned | |
| 29 | Ordering declared on the wire | P3 | `X-ScoutBox-Ordering`, as Discover and Matching do | m20E2E §12 | planned | |
| 30 | Forbidden vocabulary absent everywhere | P1 | Sweep of `m20/`, both client bundles, i18n EN+FR, docs | m20E2E N-series; `m20DemoSpotcheck` | planned | |
| 31 | i18n EN + FR at parity | P2 | `fr: typeof en`; every metric name, definition and limitation translated | typecheck; `m20DemoSpotcheck` (no raw `m20.` key in either language) | planned | |
| 32 | Demo mirror agrees with the server | P2 | `m20Demo.ts` computes from the same seeded shapes; refusals mirror the server's | `m20DemoSpotcheck` | planned | The demo's dataset is small enough that most ratios suppress — which is itself the honest demonstration |
| 33 | 390px and no horizontal scroll | P2 | Panels stack; tables in their own `overflow-x` container | `m20DemoSpotcheck` | planned | |
| 34 | ≥50% negative/security/edge coverage | P1 | 60 enumerated negative cases + P1–P12 positives in `scripts/m20E2E.mjs` | the suite reports its own ratio | planned | |
| 35 | No previous test removed or weakened | P1 | Full battery re-run at the end; check counts recorded per suite | final regression run | planned | |
| 36 | Docs: `M20_RECRUITMENT_ANALYTICS.md`, 26 sections | P3 | Written from the registry, not by hand, where the content is a definition | §154 audit | planned | |

## Defects found during implementation

Filled in as the suites find them, in the M19 style: what was wrong, how it was
found, where it was fixed, and what it means for anyone who used the product
before the fix.

| # | Defect | Found by | Fix | Consequence before the fix |
|---|---|---|---|---|
| — | *(none yet — no M20 code written at the time of writing)* | | | |
