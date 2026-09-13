# M21 — reuse audit

Written **before** any M21 store exists, as §6 requires. The governing question
for every row: *does this concept already have a home, and can M21 live in it?*

The rule M21 is built to obey:

> M21 should extend existing truth, not replace it.

And the failure this audit exists to prevent: a second Passport, a second
evidence store, a second assessment store, a second task store — each of which
would immediately start disagreeing with the first.

---

## The finding that shapes the milestone

`db.devObjectives` **already exists** (M12 F8, `m12/journeys.mjs`). At first
glance it is exactly what M21 is asking for. It is not, and the difference
matters:

| M12 `devObjectives` as built | What M21 needs |
|---|---|
| **Can only be seeded from published club feedback.** `createObjective` refuses without a `feedbackId` pointing at an assessment with `publishedFeedback`: *"Objectives grow from feedback a club chose to publish — private assessments cannot seed them."* | A plan a player can start on their own, or a coach can open for a squad player, with no prior published feedback. |
| **Created only by a player or a guardian.** There is no org route that creates one — by design. | Club- and grassroots-owned plans (§8). |
| **One or two objectives, hard-refused above that** — *"not a laundry list."* | Multiple goals, each with several actions. |
| Free text + `exerciseRefs` + `baselineEvidenceIds`. | Structured categories, statuses, due dates, assignees, objective targets. |
| `progress[]` notes and `reassessments[]`. | Append-only Reviews with goal snapshots and supersession. |
| No `rev`; last write wins. | M18.1 optimistic concurrency, because two coaches will edit one goal. |
| Projects into the Passport as two private timeline events. | Must not put plans into Passport canonical truth (§59). |

**Verdict: M12 `devObjectives` is a narrower, deliberately constrained concept —
"the one or two things a player agreed to work on after a club published
feedback" — and it stays exactly as it is.** Widening it to carry M21 would mean
breaking three of its own guarantees (feedback-seeded, ≤2, player-created) and
changing a Passport projection that M15's suite asserts.

M21 therefore **bridges** rather than absorbs: an M21 Goal may record an
existing `devObjective` as its origin, by reference. Nothing about the M12
record, its routes, or its Passport projection changes. `m12E2E` (143) and
`m15E2E` (185) must stay green unchanged, and that is the test of this decision.

---

## The audit

| Existing concept | Existing source/store | Can reuse? | Why / why not |
|---|---|---|---|
| **Development objectives** | `db.devObjectives` (M12 F8) | **Bridge, do not absorb** | See above. A Goal may cite one as its origin; the record and its routes are untouched. |
| **Assessments** | `db.assessments` (M12) | **Reuse by reference** | Canonical evaluator opinion, with M13's blind-until-submit calibration rule. M21 links an assessment id as goal evidence; it never copies ratings and never re-implements the visibility rule. |
| **Evidence** | `db.evidence` (M12 passport) | **Reuse by reference** | The canonical evidence store, with tier/verification/supersession/expiry already modelled. M21 stores an id and reads the live record — so an invalidated or expired item reads as invalid *now*, not as it was when linked. |
| **Box Cam sessions** | `db.boxSessions` (M16) | **Reuse by reference** | Observed-training evidence. Linkable to a goal; volume must never become a score (§27). |
| **Combine attempts** | `db.combineAttempts` (M16.1) | **Reuse by reference** | The only source that can satisfy an objective target. `PROVIDERS[a.provider]?.testOnly` and `combineState === 'combine_verified'` are the existing production-validity gate — M21 reuses that predicate rather than writing a second one (§29). |
| **Trust Score** | M16.2 projection | **Read-only context** | Displayed as *evidence confidence*, never as progress. Trust policy is not touched (§60, §164). |
| **Football Passport** | `m15/passport.mjs` | **Read-only** | Canonical player truth. M21 links evidence that appears in it; it puts no goal or action inside it (§59). |
| **Trials** | `db.trials` | **Bridge on explicit action only** | A trial outcome may prompt a coach to create a Goal, but only by an explicit user action. No auto-created judgement (§57). |
| **Recruitment Room tasks** | `case.tasks[]` (M17) | **Do NOT reuse** | Room tasks are *staff* work items inside one club's private decision workspace, explicitly never sent to the player. A Development Action can be assigned to the player. Same word, different privacy contract — merging them would leak staff tasks to players or make development actions org-private. Documented rather than forced. |
| **Room decisions / notes** | `db.roomDecisions`, `db.roomComments` | **Do NOT reuse, do NOT copy** | Private recruitment decision memory. §56: Room notes are never copied into development. |
| **Coach feedback** | `assessment.publishedFeedback` (M12) | **Reuse by reference** | Already the sanctioned player-visible channel; it is what seeds an M12 objective and what an M21 Goal can cite. |
| **Append-only history** | `audit()` in `m12/shared.mjs` | **Reuse verbatim** | One clock, one history shape, as M20 established. The development timeline projects from it. |
| **Optimistic concurrency** | `guardRev`/`bumpRev` (M18.1) | **Reuse verbatim** | §11 asks for exactly this. No second conflict mechanism. |
| **Conflict UX / dirty guard** | `conflict.tsx`, `dirtyGuard.ts` (M18.2) | **Reuse verbatim** | §71, §72. |
| **Provenance vocabulary** | `provenance.ts` (M18.2) | **Reuse verbatim** | §24: no new labels. |
| **Event registry** | `m182/eventRegistry.mjs` (23 events) | **Extend** | Every M21 event registered with audience + privacy class + payload allowlist, or development refuses to boot (§43, §166). |
| **Notification preferences** | `m182/notificationPrefs.mjs` (13 categories, object keyed by id) | **Extend by one** | §81 asks for a reasonable category count. One category, `development_updates`, not three. |
| **Rate limiting** | `RATE_LIMIT_POLICY` (M18.1) | **Extend** | §108: add M21 write policies to the central table, invent no limiter. |
| **Migrations / schema version** | `m182/migrations.mjs`, `SCHEMA_VERSION` | **Extend** | §155. Plus the §156/§157 clean-boot audit — see below. |
| **Org audit log** | `m182/audit.mjs` | **Extend sparingly** | §88: plan created/archived/visibility changed/review submitted. Not every action checkbox. |
| **Guardian / minor rules** | `guardianOwnsChild`, `req.playerIsMinor`, `isAdult` | **Reuse verbatim** | §74: no new safeguarding capability, and no direct minor capability that the current model does not already grant. |
| **Org visibility** | `orgCanSee` → `playerViewForOrg` | **Reuse verbatim** | §77, §79. Authorisation first, always. |

---

## New stores M21 must create

Only where the audit found no home. Each is workflow, not truth:

| Store | Holds | Why nothing existing fits |
|---|---|---|
| `db.developmentPlans` | plan identity, owner, visibility, status, review dates, `rev` | No plan concept exists at any ownership level. |
| `db.developmentGoals` | goal, category, status, optional objective target, `rev` | `devObjectives` cannot carry these without breaking its own constraints. |
| `db.developmentActions` | action, type, due date, assignee, status | Room tasks have the wrong privacy contract; nothing else exists. |
| `db.developmentEvidenceLinks` | **references only** — `{goalId or actionId, sourceType, sourceId}` | The point of the store is that it holds no evidence content. |
| `db.developmentReviews` | append-only reviews with goal snapshots and supersession | No review concept exists. |

Every one of them is a *workflow* record. Not one holds a fact about a player
that some other store also holds — which is the line M21 is not allowed to
cross.

---

## The clean-boot obligation

§156 and §157 exist because of a defect M20 found: **`db.trials` had only ever
been created by the seed**, so a snapshot restored without it would have thrown
on the first read in the trial-request safeguarding path.

Every M21 store must therefore be proven to exist on a **real fresh boot with no
demo seed**, not merely in a seeded test. The acceptance suite asserts this
directly by booting with an empty data directory and reading each store before
anything writes to it.
