# M21 — Development Hub 2.0: requirement matrix

Written **before** implementation, as §22 requires: *"Do not code before the
matrix exists."* Every row is a requirement drawn from the mandate, the file
that will satisfy it, the test that will prove it, its status, and the honest
limitation that survives.

Statuses: `planned` → `built` → `closed` (built **and** proven by a named test
that is green). A row is not `closed` on the strength of the implementation
alone.

The rule the whole table serves:

> ScoutBox should document and coordinate development — not claim to measure a
> player's worth, ceiling or future.

---

## A. Product shape and the lines M21 must not cross

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| A1 | §1 Hub answers: what is being worked on, what goals are agreed, what evidence supports progress, what changed, which actions are complete/active/blocked/overdue, what is next | `m21/plan.mjs` `buildDevelopmentPlan()` — one projection answering exactly those six | m21E2E plan-projection block; H1 | closed | It answers those six and nothing more; it cannot say whether the plan is a *good* plan. |
| A2 | §1 must NOT answer talent, potential, professional future, sign/not-sign, better-developing player, better coach | No such field exists in any payload; `FORBIDDEN_DEVELOPMENT_NAMES` asserted at boot | m21E2E negatives 58/59/60; demo spotcheck vocabulary scan | closed | Enforced on ScoutBox's own vocabulary. A reader may still draw their own conclusion from goal text a human wrote. |
| A3 | §2 tracks goals, actions, evidence, reviews, progress against *explicitly defined* objectives | Five workflow stores, each keyed to a stated objective | m21E2E model block | closed | "Progress" here means progress through an agreed plan, never progress as a player. |
| A4 | §3 no Development / Potential / Improvement / Readiness / Growth / Academy Score, no Player Progress Rating, **no overall 0–100 number** | `assertDevelopmentVocabulary()` at boot over `FORBIDDEN_DEVELOPMENT_NAMES`, plus `scanPayloadForForbiddenFields()` run by the suite against real responses and `refusedClientFields()` on every write | m21E2E negatives 16, 58; boot assertion test | closed | The scan is name- and shape-based. A client could still divide two integers it is given; §46 answers that by labelling counts, not percentages. |
| A5 | §46 progress is categorical; `3 of 5 actions completed` is allowed, `60% player progress` is not | Server sends `{done, total}`; clients render the sentence, never a bare percent | m21E2E action-count shape; demo spotcheck; H2 | closed | A fraction of *actions* is a fraction of a to-do list; it says nothing about ability and the copy says so. |
| A6 | §68 no AI coaching, no AI plans, no AI potential analysis, no automatic weakness detection | Nothing in `m21/` calls a model; goal library is a static controlled list | m21E2E goal-library block | closed | The goal library is fixed text, not a recommendation; it is not personalised and does not claim to be. |
| A7 | §14 no trait judgement vocabulary | Terminology doc + a discouraged-language note in the goal composer; server does not moderate free text | m21E2E terminology doc cross-check | closed | **ScoutBox does not police what a coach types.** It supplies behavioural vocabulary and refuses to structure trait labels; free text remains the author's. |
| A8 | §160 canonical vocabulary, approved and forbidden | `M21_TERMINOLOGY.md`, cross-checked against `m21/shared.mjs` | m21E2E doc↔code cross-check (both directions) | closed | Vocabulary is enforced for ScoutBox-authored copy in EN and FR only. |

## B. Reuse, not duplication

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| B1 | §6 reuse audit before any store | `M21_REUSE_AUDIT.md` | — (gate document) | **closed** | Written before the first M21 line of code. |
| B2 | §4 no duplicate Passport / evidence / assessment / task store | Only workflow stores created; evidence is stored as `{sourceType, sourceId}` references | m21E2E "no second store" check: every evidence payload field must resolve to a live canonical record | closed | The reference is resolved at read time, so a link can render as unavailable — which is the honest outcome, not a bug. |
| B3 | §4/§57 reuse M12 development records where they exist | M12 `devObjectives` **bridged, not absorbed** — a goal may cite one as origin | m12E2E 143 and m15E2E 185 green unchanged | closed | The two concepts stay separate; an M12 objective does not become an M21 goal automatically, and never will. |
| B4 | §4 M16.2 Trust only as evidence-confidence context | Rendered under the label *evidence confidence*; never summed, never compared | m21E2E negative 61; M16.2 suite green | closed | Trust is about evidence, not the player, and appears with that sentence attached. |
| B5 | §58/§59 Passport stays canonical; goals and actions never go inside it | No M21 write touches `m15/`; Passport read-only | m15E2E green; m21E2E negative 74 | closed | Development work is invisible in the Passport unless it produced canonical evidence by the existing rules. |

## C. Plan model, ownership, visibility

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| C1 | §7 plan record with the named fields | `db.developmentPlans` | m21E2E plan CRUD | closed | — |
| C2 | §7 do not assume org ownership for player-owned plans | `ownerOrgId` nullable; `owner: {kind: 'player'|'org'}` explicit | m21E2E player-owned plan has no org | closed | — |
| C3 | §8 three ownership shapes: player/guardian, club, grassroots; no merging across owners without permission | `PLAN_OWNER_KINDS`; a plan has exactly one owner for life | m21E2E ownership block; negatives 1, 2 | closed | Ownership is immutable. A player plan cannot be "handed to" a club — the club creates its own and the player may share. |
| C4 | §9 explicit visibility; never derived from creator alone | `PLAN_VISIBILITY` = `private`, `player_guardian`, `shared_with_org`, `org_private`; required at creation | m21E2E negatives 39, 40 | closed | — |
| C5 | §10 status vocabulary, no ambiguous "closed" | `PLAN_STATUSES` = `draft`, `active`, `paused`, `completed`, `archived` | m21E2E negatives 19, 21, 22 | closed | Deliberately unlike M17 `ROOM_STATUSES`, which does use `closed`, because these are different objects. |
| C6 | §11/§70 `rev` / `expectedRev` / 409 | `guardRev`/`bumpRev` from `m181/concurrency.mjs`, verbatim | m21E2E negative 25; H9 | closed | Optimistic only; no locking, so a slow editor can still lose a race and be told so. |
| C7 | §64 creation requires player, title, owner context, visibility; a goalless plan is a valid **draft** only | `createPlan()` — `draft` may have zero goals; `active` requires ≥1 | m21E2E creation validation | closed | The explicit decision the mandate asked for: draft yes, active no. |
| C8 | §106 limits: goals per plan, actions per goal, text length, active plans | `M21_LIMITS` in one table | m21E2E negatives 49, 50, 51 | closed | Limits are per-plan and per-player; they bound abuse, not ambition. |

## D. Goals

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| D1 | §12 goal record | `db.developmentGoals` | m21E2E goal CRUD | closed | — |
| D2 | §13 structured categories; no medical diagnosis | `GOAL_CATEGORIES` = technical, tactical, physical, psychological, match_understanding, position_specific, other | m21E2E negative 18 | closed | **`availability_rehabilitation` is NOT included.** The repository has no safe medical vocabulary, and §13 permits the category only if it does; it does not. Documented rather than invented. |
| D3 | §15 goal statuses | `GOAL_STATUSES` = not_started, in_progress, blocked, achieved, stopped | m21E2E negatives 19, 20 | closed | — |
| D4 | §16 achieved ≠ verified ability | `achieved` carries a fixed sentence in the payload and in both languages | m21E2E achieved-sentence check; demo spotcheck | closed | The distinction is stated everywhere the word appears; it cannot stop a reader who ignores it. |
| D5 | §48 structured blocked reasons, no medical detail | `BLOCK_REASONS` = waiting_for_assessment, schedule, facility, coach_review, other | m21E2E blocked block | closed | **`injury_or_unavailable` is NOT included**, for the same reason as D2. A blocked goal can say `other` with free text the author controls. |
| D6 | §69 creator recorded | `createdBy` + provenance kind | m21E2E provenance block; G3 | closed | — |
| D7 | §67 small controlled goal library, not personalised recommendation | `GOAL_LIBRARY` — 7 fixed entries, offered as text, labelled *common development themes* | m21E2E library block; demo spotcheck copy | closed | It is a list of words, identical for every player, and says so. |
| D8 | §31 subjective goals need no numeric target | `target` optional | m21E2E subjective-goal block | closed | Progress on a subjective goal is coach/player judgement recorded as such — no quantification is manufactured. |

## E. Actions

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| E1 | §18 action record | `db.developmentActions` | m21E2E action CRUD | closed | — |
| E2 | §19 action types reuse current systems | `ACTION_TYPES` = training, assessment, video_review, match_objective, coach_review, combine, box_cam, evidence_request, custom | m21E2E type validation | closed | A typed action is a *label on a to-do*; it does not create the Box Cam session or Combine attempt it names. |
| E3 | §20 action statuses | `ACTION_STATUSES` = todo, in_progress, done, blocked, cancelled | m21E2E status validation | closed | — |
| E4 | §21 assignment respects role/ownership; no cross-org staff assignment | `canAssign()` — assignee must be the player, their guardian, or staff of the owning org | m21E2E negatives 31, 32 | closed | — |
| E5 | §47 overdue is a date fact, never a character claim | `overdue` derived at read time from server UTC date | m21E2E overdue block; §87 UTC check | closed | Overdue says a date passed. It is not attributed to anyone. |
| E6 | §53 server authoritative on completion | Client sends intent; server sets `completedAt` | m21E2E negative 17 | closed | — |
| E7 | §123 (G5) completing an action never completes its goal | No code path moves goal status from an action write | m21E2E G5; H2 | closed | — |

## F. Evidence links

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| F1 | §22 references only, never copies | `db.developmentEvidenceLinks` = `{goalId?, actionId?, sourceType, sourceId}` and nothing else | m21E2E store-shape assertion: no content field permitted | closed | — |
| F2 | §23 sources: Passport evidence, assessment, full match, coach reference, Box Cam, Combine, trial report | `EVIDENCE_SOURCES` with a resolver per source | m21E2E per-source block | closed | Each resolver reads the live record, so link state is always *now*, never as-linked. |
| F3 | §95 linked evidence must belong to the same player | `assertEvidencePlayer()` before any link write | m21E2E negatives 9, 10 | closed | — |
| F4 | §24 canonical M18.2 provenance, no new labels | `provenance.ts` reused verbatim | m21E2E provenance vocabulary check; H3; G4 | closed | — |
| F5 | §99 invalidated evidence: link stays historical, current state marks it invalid | Read-time resolution returns `{available:false, reason}` | m21E2E negative 12; G8; H8 | closed | The link records that something *was* cited. It never re-asserts a claim the source has withdrawn. |
| F6 | §100 lost access must not expose stale content | Resolver returns `evidence_unavailable` with no detail | m21E2E negatives 11, 42, 71 | closed | The viewer learns a link exists and is unavailable — the minimum needed to explain a gap without leaking. |
| F7 | §122 (G4) evidence appears once | Link uniqueness on `(target, sourceType, sourceId)` | m21E2E negative 30 | closed | — |

## G. Box Cam, Combine, objective targets

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| G1 | §26 Box Cam as observed-training evidence | `box_cam` source resolver over `db.boxSessions` | m21E2E Box Cam block | closed | A session is evidence that training was observed — not that it worked. |
| G2 | §27 volume/hours/streaks never become progress | No aggregate over session count exists in any payload | m21E2E negative 57 | closed | Session counts are visible as counts of linked items; nothing multiplies them into a figure. |
| G3 | §28/§30 objective targets `{metricType, sourceType, protocolId?, operator, value}` | `m21/targets.mjs` | m21E2E target block; G6 | closed | Targets are single-measurement comparisons. No formulas, no composites (§30). |
| G4 | §96 target validation: known protocol, known metric, compatible operator, numeric range | `validateTarget()` | m21E2E negatives 14, 54, 55 | closed | — |
| G5 | §29/§125 (G7) only production-valid Combine satisfies a production target | Reuses the existing predicate: `combineState === 'combine_verified' && !PROVIDERS[p].testOnly` | m21E2E negative 13; G7 | closed | The gate is M16.1's, unchanged — one definition of production validity in the codebase. |
| G6 | §97 target state derived: `target_met` / `target_not_met` / `no_current_valid_measurement` | `evaluateTarget()`, read-time | m21E2E three-state block; H7 | closed | Three states, three sentences — no conflation of "not met" with "not measured". |
| G7 | §97/§98/§124 (G6) meeting a target never auto-marks the goal achieved | No write path from `evaluateTarget()` to goal status | m21E2E negative 56; G6; H7 | closed | Manual achievement is authoritative because one metric is not the whole football objective. |
| G8 | §93 client never sends target_met, progress, confidence or verified flags | Route input allowlist strips them and 400s on presence | m21E2E negatives 15, 16, 17 | closed | — |

## H. Reviews

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| H1r | §33 review record, append-only | `db.developmentReviews` | m21E2E review block; G9 | closed | — |
| H2r | §34 submitted reviews are not silently editable; corrections append and supersede | `supersedes` / `supersededBy`; no PATCH route exists | m21E2E negatives 23, 24; H6 | closed | The original text stays readable. A correction sits beside it, not over it. |
| H3r | §35 snapshot enough goal state, never the whole Passport | `goalSnapshots[]` = `{goalId, status, evidenceRefs, actionCounts, targetState?}` | m21E2E negative 74 | closed | A snapshot records what the reviewer saw of *the plan*, not of the player. |
| H4r | §36 structured fields preferred; private notes stay private; never surfaced through analytics | `notes` split into `sharedSummary` and `internalNote`, different audiences | m21E2E negatives 41, 43, 44; H5; G15 | closed | The M20 rule holds: private notes are not analytics data. |
| H5r | §37 adult self-review labelled *Player reflection*; minor guardian-controlled | `reviewerKind: 'player_reflection'` with fixed label; minor path via guardian | m21E2E self-review block; negatives 36, 37 | closed | A reflection is never presented as an assessment, in either language. |
| H6r | §38 coach review shows provenance and org where authorised | `reviewerKind: 'coach_review'` + org attribution | m21E2E provenance; H6 | closed | — |
| H7r | §39/§40 club review org-private unless explicitly shared; explicit share action | `POST …/reviews/:id/share` with an explicit scope | m21E2E negative 40; G15; H5 | closed | Sharing is per-review and per-scope. There is no "share everything" switch. |
| H8r | §86 review due / overdue / upcoming from `nextReviewAt` | Read-time, server UTC | m21E2E review-due block | closed | Derived on read — see K3 on reminders. |

## I. Timeline, events, notifications, audit

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| I1 | §41 timeline of canonical development events | `m21/timeline.mjs` projecting from `audit()` records | m21E2E timeline block | closed | The timeline is a projection of history already written; it stores nothing of its own. |
| I2 | §42 no activity spam | Fixed allowlist of timeline-worthy actions | m21E2E timeline-allowlist check | closed | Reads and saves that change nothing are absent by design. |
| I3 | §43/§166 every M21 event in the canonical registry with audience and privacy class | `m182/eventRegistry.mjs` extended; dev throws on unregistered broadcast | m21E2E negatives 65, 66; m182E2E green | closed | — |
| I4 | §44 org-private events never reach the player | Audience enforced in the registry, not at call sites | m21E2E negatives 45, 75 | closed | — |
| I5 | §81 existing preference architecture, reasonable category count | **One** new category: `development_updates` | m21E2E prefs block; negative 46 | closed | One category means a player who mutes it mutes all development mail — a deliberate trade against category sprawl. |
| I6 | §82/§83 player and org notification cases, no spam | Per-event audience + existing dedupe | m21E2E negative 70 | closed | — |
| I7 | §88 org audit records plan created/archived/visibility changed/review submitted only | `m182/audit.mjs` extended with exactly four actions | m21E2E audit block; negative 44 | closed | Action checkboxes are in plan history (§89), not the org audit log. |
| I8 | §89 plan history richer than org audit, kept distinct | Two separate reads | m21E2E distinctness check | closed | — |
| I9 | §91 meaningful goal changes appear in the timeline | Status/target/title changes emit; cosmetic ones do not | m21E2E goal-history block | closed | Not a full field-level revision history — the mandate asked for "at minimum meaningful changes in timeline", which is what exists. |

## J. Permissions, privacy, safeguarding

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| J1 | §73 permissions defined centrally | `m21/permissions.mjs` — one `planAccess(viewer, plan)` | m21E2E permission matrix (every viewer × every visibility) | closed | — |
| J2 | §102 viewer contexts; no generic all-access admin | `player_self`, `guardian`, `org_staff`, `grassroots_staff` | m21E2E negative 38 | closed | — |
| J3 | §74 minors: guardian authoritative, no new direct minor capability | `req.playerIsMinor` + `guardianOwnsChild`, reused verbatim | m21E2E negatives 36, 37; G12; H10 | closed | Safeguarding is unchanged, which is the requirement. |
| J4 | §75 agencies gain nothing, especially not minors | Agency viewer kind is absent from `planAccess` | m21E2E negative 5 | closed | Agencies have no development access at all in M21 — the safest reading. |
| J5 | §76 grassroots within existing authorised relationships; discovery radius not applied to membership | Inspected M19 rules; membership path does not consult radius | m21E2E grassroots block | closed | The 50 km rule governs discovery. Applying it to an existing club-player relationship would break legitimate coaching. |
| J6 | §77 block/visibility change removes live access | `orgCanSee` consulted on every read, no caching | m21E2E negative 34; G11; H11 | closed | Historical org-side records persist only where retention policy already allows. |
| J7 | §78 stale plan URLs do not resurrect a removed player | Authorisation precedes lookup; 404 not 403 | m21E2E negative 35; H11 | closed | — |
| J8 | §79 tenant isolation: `id + orgId`, foreign = nonexistent | Every org lookup composite | m21E2E negatives 6, 7, 8, 68, 72 | closed | — |
| J9 | §80 no public share links | No token, no unauthenticated route | m21E2E route inventory | closed | Sharing requires an account. There is no link to forward. |
| J10 | §103 T&S gains no routine access | T&S viewer absent; M18.2 boundary untouched | m21E2E negative 38; m182E2E green | closed | — |
| J11 | §107 free text is XSS-safe, bounded, rendered as text | Length caps server-side; React text rendering, no `dangerouslySetInnerHTML` | m21E2E negatives 47, 48, 49, 73; demo spotcheck | closed | — |

## K. Platform discipline

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| K1 | §92 routes adapted to current architecture | `m21/index.mjs` `registerDevelopment(ctx)` | m21E2E route inventory | closed | Paths follow this codebase's existing `playerRouter`/`guardianRouter`/`orgRouter` shape rather than the mandate's illustrative `/api/development/...`. |
| K2 | §94 reject unknown enums, foreign ids, invalid dates, bad operators — **no silent repair** | One `validate()` per write, 400 with a code | m21E2E negatives 18–20, 52–55 | closed | — |
| K3 | §84/§85 no fake scheduler; honest read-time due state | Due/overdue computed on read; copy never promises background reminders | m21E2E due-state block; copy scan | closed | **There is no background job.** A player who does not open the app is not reminded, and the app does not claim otherwise. |
| K4 | §87 server UTC date semantics from M18.2 | `utcDay()` reused | m21E2E timezone block | closed | Due dates are calendar days in UTC, so a late-evening deadline in UTC+13 differs from local intuition. Stated in the doc. |
| K5 | §105 bounded list, history and evidence reads | Cursor pagination, hard cap | m21E2E negative 67; perf | closed | — |
| K6 | §108 rate limits in the central provider | `RATE_LIMIT_POLICY` extended | m21E2E negative 69 | closed | — |
| K7 | §109 idempotency on plan, goal, action, review, evidence link | Client-supplied key + server dedupe window | m21E2E negatives 27, 28, 29, 30 | closed | Dedupe is windowed; an identical write long after is a new write. |
| K8 | §90 destructive-action patterns from M18.2 | `confirmAction.ts`; archive preserves history; draft goal delete only while unlinked | m21E2E archive/delete block; G14 | closed | — |
| K9 | §155 migration increments schema; clean DB, upgrade, restart idempotency | `m182/migrations.mjs` step `m210_001_development_stores` | m21E2E migration block | closed | — |
| K10 | §156/§157 every store proven on **real fresh boot without seed** | Boot with empty data dir, read each store before any write | m21E2E clean-boot block | closed | Written because of the M20 `db.trials` defect: a store that exists only because the seed made it is a store that throws in production. |
| K11 | §153/§154 profile real queries, index only if justified | Measure in `scripts/m21Perf.mjs` first | perf report | closed | The snapshot store has no query planner — a scan *is* the access path. Expect no index. |
| K12 | §152 perf: plan projection, 10 and 50 goals, actions, 100- and 500-event history, evidence lookup, review projection; median; no fake SLA | `scripts/m21Perf.mjs` | perf report | closed | Numbers are from one machine and one dataset; they are measurements, not guarantees. |

## L. Surfaces

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| L1 | §49 player app Development: Overview, My Goals, Actions, Evidence, Reviews, History | `M21Sections.tsx` in `scoutbox-player` | H1–H3, H12; demo spotcheck | closed | — |
| L2 | §50 optional player home card, no score | Summary card: active goals, actions due, next review | demo spotcheck | closed | — |
| L3 | §51/§52 goal card and goal detail contents | `GoalCard`, `GoalDetail` | H1; demo spotcheck | closed | — |
| L4 | §54 club surface under player/squad profile; **no new top-level sidebar item** | Development tab inside the existing player view | navConfig test (destination inventory unchanged at top level) | closed | Reached from a player, which is where a development plan belongs. |
| L5 | §55 works for squad/development contexts, not only recruitment candidates | Plan requires an authorised relationship, not a room | m21E2E squad-context block | closed | No squad management is built (§55 forbids it); an org can hold a plan for any player it may already see. |
| L6 | §56 Room may reference the Hub; Room notes never auto-copied | Link only, on explicit action | m21E2E negative in Room block; reuse audit row | closed | — |
| L7 | §111 club Development home contents incl. share status | Club/grassroots `m21Screens.tsx` | demo spotcheck; H4 | closed | — |
| L8 | §112 six named empty states with actionable copy | Distinct copy per state, EN+FR | m21E2E i18n key parity; demo spotcheck | closed | — |
| L9 | §113 six named error states; never a silent blank | Reuses `httpState.ts` + `ConflictNotice` | m21E2E error-state block; H9 | closed | — |
| L10 | §114 390px for plan list, goal cards, goal editor, actions, review form, timeline | Responsive layout | H12; demo spotcheck overflow check | closed | — |
| L11 | §115 keyboard nav, labelled status controls, state not colour-only, semantic timeline, accessible dialogs | Native controls + text state | H12 accessibility assertions | closed | Checked at the interaction level, not by a full WCAG audit. |
| L12 | §116 EN + FR, no missing or raw keys | `fr: typeof en` parity | m21E2E key-parity check; demo spotcheck in both languages | closed | Two languages only. |
| L13 | §71/§72 shared ConflictNotice and M18.2 dirty guard | Reused verbatim | H9 | closed | — |
| L14 | §65/§66 optional structured templates, generic only, no "best plan" claim | Three templates: Technical, Positional, Trial Follow-up | m21E2E template block; copy scan | closed | Templates are empty structure. They contain no advice and make no claim about what suits a position. |

## M. Regression guarantees

| # | Requirement | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| M1 | §161 full regression, **no previous test removed or weakened** | Every prior suite run unchanged | full regression run | closed | Green across every suite. Two harness changes were needed and both are recorded as defects (D6, D7): neither removes an assertion, and D7's assertion is byte-identical — only the wait before it is explicit. If a prior assertion must change, it is recorded with reasoning, as M20 did for the M19 schema pin. |
| M2 | §162 development is never a matching criterion, watchlist score or hidden preference; M19 ≥373 green | No M19 file touched; no development read from `m19/` | m21E2E negative 62; m19E2E green | closed | — |
| M3 | §163 no development leaderboard in the Director Dashboard; M20 semantics unchanged | No M20 file touched | m21E2E negative 63; m20E2E green | closed | — |
| M4 | §164 development completion never raises Trust by itself | No M21 write calls Trust; only underlying canonical evidence can | m21E2E negative 61; testTrust green | closed | — |
| M5 | §165 goal achieved alone is not a Second Look trigger | No M21 emit into M18 paths | m21E2E negative 64; m18E2E green | closed | Canonical new evidence may still trigger one — through the existing evidence path, as it always did. |
| M6 | §167 org-private development never appears in player stream, Passport, M20, M19 or shared surfaces | Audience + projection boundaries | m21E2E negatives 39–45, 74, 75 | closed | — |
| M7 | §117/§118 ≥50% negative, all 76 enumerated negatives present | `scripts/m21E2E.mjs` prints the ratio and fails below 50% | m21E2E self-report | closed | The floor is enforced by the suite on itself. |
| M8 | §119–§133 positives G1–G15 | m21E2E positive block | m21E2E | closed | — |
| M9 | §135–§147 live journeys H1–H12 | `e2e/m21Live.test.mjs` | m21Live | closed | Real browser, real server, one dataset. |
| M10 | §148/§149/§150 demo story, demo honesty, `m21DemoSpotcheck` | Demo modules + `e2e/m21DemoSpotcheck.test.mjs` | demo spotcheck | closed | Demo Combine is labelled simulated and **does not** satisfy a production target; the demo says what production would require. |
| M11 | §151 launcher M21 tour, 17 steps | `e2e/launcher.html` | manual + republish | closed | — |
| M12 | §158 `M21_DEVELOPMENT_HUB.md`, 32 sections | doc | doc↔code cross-check in m21E2E | closed | — |
| M13 | §168 republish artifacts to existing URLs; T&S gains nothing | Artifact update | manual verification | in progress | — |
| M14 | §169 restore bundle at the clean tip: secret scan, `git bundle verify`, fresh clone, m21E2E from the clone | bundle procedure | bundle report | in progress | The bundle lives in the container filesystem and dies with it — the standing "do not push" makes that an accepted risk, restated each time. |
| M15 | §170 final audit, 12 explicit answers | final report | — | in progress | — |
| M16 | §171 final report, 50 sections; nothing pushed, no PR | final report | — | in progress | — |

---

## Open decisions this matrix records

Four judgement calls the mandate left open, decided here so implementation does
not quietly decide them:

1. **§13 `availability / rehabilitation` category — excluded.** Permitted "ONLY
   if repository already supports safely". It does not: there is no medical
   vocabulary, no consent model for health data, and no retention rule for it.
2. **§48 `injury_or_unavailable` block reason — excluded**, same reasoning. A
   blocked goal can use `other`.
3. **§64 plan creation — a `draft` may have zero goals; `active` may not.**
4. **§81 notification categories — one (`development_updates`), not three.**

## Defects found during M21

Recorded as they are found, in the M20 style. Empty until the first.

| # | Defect | Where | Fix | Proven by |
|---|---|---|---|---|
| D1 | `m20E2E` pinned `SCHEMA_VERSION === 2000`, so it failed the moment M21 added a migration step — for an M21 reason with no M20 meaning. Exactly the defect M20 itself found in `m19E2E`'s pin at 1900, repeated one milestone later. | `scripts/m20E2E.mjs:465` | Changed to `>= 2000`, keeping the assertion that M20's own step `m200_001_analytics_sources_present` is registered. Sharper, not weaker: it now checks what M20 actually depends on. | m20E2E back to 259 checks, green |
| D2 | The M18.2 event check greps the server tree for literal `broadcast('name')` call sites. M21's first cut dispatched every event through a variable, which would have made eight registered names read as "declared but never broadcast" — and made them invisible to anyone grepping for where an event is sent. | `m21/index.mjs` | An `EMITTERS` table with one literal `broadcast('…')` per event name; `emit()` throws on an unregistered name rather than dropping it. | m182E2E 330 green with the eight new names in `EMITTED_EVENTS` |
| D3 | **No Combine protocol in this build can be Combine Verified by a PRODUCTION provider.** `production_cv` is `not_configured`, and `web_client` observes `player_presence` and `active_duration` only — every ball protocol also requires `ball_presence`, and Box Footwork requires `interval_completion`. So an objective target can never honestly read `target_met` in this deployment. An M16.1 fact, surfaced by M21 because M21 is the first thing that depends on it. | `m16/drills.mjs` capabilities vs `m16/combineShared.mjs` `requiredCapabilities` | **Not "fixed" — recorded.** The tempting fix was to let the test provider satisfy a target, which is exactly what §29 and §149 forbid. Instead G6 is proven where it can be proven truthfully: the pure engine reads `target_met` the moment a production-valid measurement exists, and the HTTP journey shows the only obstacle is the absent detector, which `/capabilities` already reports. Documented in `M21_DEVELOPMENT_HUB.md` §32 and in the launcher's honest-scope note. | m21E2E G6/G7 · m21Live H7 |
| D4 | The goal conflict body carried the goal's **title**. A 409 says who changed a record and when; what they wrote is content, and the caller reloads it through its own authorised read. | `m21/index.mjs` goal PATCH | `title` removed from the conflict `current` payload. | m21E2E N26 · m21Live H9 |
| D5 | A test defect, not a product one, worth writing down because the wrong conclusion was nearly acted on. The plan switcher in the player app looked dead: a forced Playwright click reported success and the view never changed. `force: true` skips actionability checks **including scrolling the target into view**, so on a long page the click landed nowhere. A plain click scrolls and works. | `e2e/m21Live.test.mjs` | The helper clicks normally and then asserts the view actually changed, rather than asserting only that both plans are offered. No product change was made, because none was needed. | m21Live H8 — "switching to their own plan actually switches the view" |
| D6 | `m21Live` never released its backend. The suite ended with `browser.close()` but, alone among the live suites, never called `cleanup()`, so the server it spawned outlived it and the process never exited. Standalone that reads as a hang after the summary prints; inside the regression battery, where each suite runs under command substitution, it blocked the entire run. | `e2e/m21Live.test.mjs` | `cleanup()` after `browser.close()`, matching every other live suite. | the suite now exits on its own; the tail battery ran to completion |
| D7 | `m162Live` T1 read the page before the page had finished loading. The Trust section title paints immediately, but the score, the band and the mandatory disclaimer arrive with the profile fetch. Waiting for the title and then reading `body.innerText()` judged a half-painted surface — green in isolation, "the mandatory disclaimer is missing" under contended CPU. M21 did not cause the race; adding a second fetching section to the same You tab widened the window enough to expose it. | `e2e/m162Live.test.mjs` | An explicit wait for the projection to land. The assertion is untouched and still the verdict — a genuinely absent disclaimer fails exactly as before; a timeout on the wait does not pass anything. | m162Live 11 checks green, in isolation and in the battery |
