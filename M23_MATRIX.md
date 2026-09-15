# M23 — Requirement Matrix

End-to-End Recruitment → Trial → Decision / Offer Workflow.

Status vocabulary: **planned** · **built** · **verified** (a test asserts it) ·
**declined** (deliberately not built, with a reason).

The governing rule, against which every row is checked:

> ScoutBox should make recruitment operationally complete without turning
> private club judgement into public player truth.

---

## Section L — Lifecycle reconciliation (§7)

This is the load-bearing decision of the milestone, so it comes first.

§7 proposes seventeen stage values and then says: *"Do not blindly implement
these exact values if the existing case/Room state machine already has
overlapping equivalents. First reconcile."*

It does. `ROOM_STATUSES` (13 values, `m17/shared.mjs:21-35`) is already the
authoritative lifecycle, with a complete `ROOM_TRANSITIONS` adjacency table, a
boot assertion, an M20 funnel reading it, client enums mirroring it and four
regression suites pinning it. **M23 does not introduce a second vocabulary.**

### L1. The mapping

| §7 proposes | Existing status | Verdict |
|---|---|---|
| `identified` | `watching` | **reuse** — same concept, existing name wins |
| `under_review` | `under_review` | **exact match** |
| `contact_planned` | — | **add** (see L2) |
| `contacted` | — | **add** (see L2) |
| `trial_planned` | `trial_requested` | **reuse** |
| `trial_confirmed` | `trial_scheduled` | **reuse** |
| `trial_in_progress` | — | **declined as a lifecycle stage** — it is a state of the *trial*, not of the case. A club running a trial has not changed where the player is in recruitment. |
| `trial_completed` | `trial_completed` | **exact match** |
| `decision_pending` | — | **declined as a stored stage** — derivable with no ambiguity as `trial_completed` with no current decision. Storing it would create two sources of truth for one fact. |
| `offer_planned` | `offer_consideration` | **reuse** |
| `offer_sent` | `offer_made` | **reuse** |
| `accepted` | — | **add** as `offer_accepted` (see L3) |
| `declined` | — | **add** as `offer_declined` (see L2) |
| `rejected` | `withdrawn` / `archived` + reason code | **reuse** — rejection is an exit with a structured reason, which already exists |
| `on_hold` | — | **add** (see L2) |
| `withdrawn` | `withdrawn` | **exact match** |
| `closed` | `closed` | **exact match** |

Twelve of seventeen are satisfied by what is already there. Two are declined as
stages because they are not stages. **Five are added.**

### L2. Why each addition earns its place

| Added | Why nothing existing covers it |
|---|---|
| `contact_planned` | §12 requires the *internal decision to contact* be distinguishable from contact having happened. Today a club that has agreed to approach a player and a club that has not are both `under_review`. |
| `contacted` | §12 requires *delivered* to be distinguishable from *responded*. Today a sent approach awaiting a reply has no status of its own. |
| `on_hold` | §33 requires hold to be explicit, with a reason and an optional review date. Today a paused case is indistinguishable from an active one. |
| `offer_accepted` | §46 — see L3. This is the legal boundary made structural. |
| `offer_declined` | A player declining and a club withdrawing are different facts about different people. Collapsing both into `withdrawn` would misattribute the decision, and §157 asks specifically whether history is preserved through rejection. |

Total: **18 statuses**. Each addition ships with its `ROOM_TRANSITIONS` row, its
`STAGE_MAP` entry for both the pro and grassroots vocabularies, and its label —
or the existing boot assertion (`m17/index.mjs:35-47`) throws, which is the
check that this reconciliation was done properly.

### L3. The legal boundary, made structural rather than editorial

§46 says acceptance must not be called a signing. The weak way to satisfy that
is careful copy. The strong way is to make them **different states with a
transition between them**:

```
offer_made → offer_accepted        "Accepted in ScoutBox"
offer_accepted → signed            only on recorded joining/registration truth
```

A club cannot reach `signed` by the player pressing Accept. Something must
separately record that the player actually joined (§47), and if the product
cannot establish that truth, the case stays at `offer_accepted` — which is
honest.

The existing status id `signed` is **kept**, deliberately. It predates M23, four
suites pin it, and the client enums mirror it; renaming an internal identifier
to improve wording would be a large blast radius for no gain. What M23 governs
is what the *labels and player-facing text* claim (§154), and `offer_accepted`
now stands between acceptance and any claim of signing.

### L4. What does not change

- `case.stage` remains a pure derivation, written only by `applyStatus()`.
- `room.status` remains canonical.
- M20's funnel keeps reading `room.history` — no second transition log (see the
  reuse audit §B1). `FUNNEL_STAGES` grows from 10 to 14; the funnel stays
  explicitly non-monotonic.

---

## Section A — Foundation

| # | Requirement | Decision | Status |
|---|---|---|---|
| §4 | Preflight, 27 areas | done; `M23_REUSE_AUDIT.md` | verified |
| §4 | Baseline | 22/22 server suites green after fixing a pre-existing m22E2E hang | verified |
| §5 | Reuse gate per store | 1 new, 2 extended, 6 reused, 0 parallel | verified |
| §6 | Case stays canonical | Room remains a facet; M23 writes through `createRoomForPlayer` / `reopenRoom` | planned |
| §8 | No silent stage jumps | server-validated via existing `validateTransition` | planned |
| §9 | Transition history | `case.history` via `audit()`/`applyStatus()` | planned |
| §10 | Derived current state | `room.status` persisted + append-only history — the existing shape | planned |

## Section B — Room and contact

| # | Requirement | Decision | Status |
|---|---|---|---|
| §11 | Room actions | workflow actions on the Room; no CRM fields | planned |
| §12 | Explicit contact step | 4 states: planned (lifecycle) / attempted / delivered / responded | planned |
| §13 | Channels | ScoutBox Inbox + existing outbox + **recorded external** (metadata, never claimed delivery) | planned |
| §14 | Contact record | `db.requests` extended, not duplicated | planned |
| §15 | Contact privacy | internal notes org-private; player sees only what was shared | planned |
| §16 | Minor contact | existing `routedTo = minor ? 'guardian' : 'player'` | planned |
| §17 | Guardian participant | invitation, details, accept/decline, shared outcome — never internal discussion | planned |

## Section C — Trial

| # | Requirement | Decision | Status |
|---|---|---|---|
| §18 | Trial object | extend `db.trials` additively | planned |
| §19 | Trial states | **separate scheduling field**; `trial.status` keeps its two values and its meaning | planned |
| §20 | Invitation share boundary | explicit allowlist of participation fields; no Room content | planned |
| §21 | Response | player/guardian only — routes already live on their routers | planned |
| §22 | Reschedule | appends to `day.statusEvents[]`; prior schedule retained | planned |
| §23 | Cancellation | club vs player/guardian distinct, with actor and timestamp | planned |
| §24 | Attendance | recorded explicitly: attended / partial / no_show / cancelled_before_start | planned |
| §25 | Trial assessment | reuse `db.assessments`; **no `trialScore`** | planned |
| §26 | Structured dimensions | existing template anchors; no automatic talent scoring | planned |
| §27 | Internal vs shared | existing `publishedFeedback` is the only door to the player | planned |
| §28 | Player feedback | optional, club-chosen, share-safe | planned |

## Section D — Decision, hold, offer

| # | Requirement | Decision | Status |
|---|---|---|---|
| §29 | Decision | reuse M17 `recordDecision()` | planned |
| §30 | Append-only | already: `supersededById`, never mutated | planned |
| §31 | Reason codes | existing 19 codes, 4 categories, 28 prohibited | planned |
| §32 | Rejection | internal reason private; player-facing outcome concise | planned |
| §33 | Hold | `on_hold` + reason + optional `reviewAt` + owner; **no scheduler** | planned |
| §34 | Second Look | reuse M18 unchanged; no parallel reconsideration | planned |
| §35 | Invite back | new trial linked to the same case; old trial intact | planned |
| §36-§40 | Offer | **new narrow store**; 7 types, 8 states | planned |
| §41-§42 | Authorisation | only authorised staff send; player can never self-approve | planned |
| §43-§45 | Response, withdrawal, expiry | recipient-validated; read-time expiry, UTC | planned |
| §46 | Legal boundary | `offer_accepted` ≠ `signed`, structurally (L3) | planned |
| §47-§48 | Outcome | reuse `outcomeReports`/`signings`; **one derived** terminal outcome | planned |
| §49-§50 | Closure / reopen | structured reason; terminal history preserved | planned |

## Section E — Integration boundaries

| # | Requirement | Decision | Status |
|---|---|---|---|
| §51-§53 | Passport | confirmed share-safe history only; no rejection, interest, Room note or offer detail | planned |
| §54-§55 | Development handoff | explicit action only; reuse M21 ownership | planned |
| §56-§57 | Matching / watchlists | unchanged; membership never auto-creates a case | planned |
| §58-§59 | Nobody Missed / Second Look | existing definitions unchanged | planned |
| §60 | Trust | unchanged — no recruitment input | planned |
| §61 | Box Cam / Combine | unchanged; M22 blocker intact | planned |
| §62-§66 | Analytics | new funnel metrics with declared semantics; small-N kept; no ranking of anyone | planned |
| §67-§68 | Owner / tasks | reuse existing roles and task engine | planned |
| §69 | Medical | **declined** — no medical infrastructure. At most an operational clearance flag, if it can be expressed without storing health information | planned |
| §70 | Documents | reuse existing evidence/upload capability only | planned |

## Section F — Safeguarding and isolation

| # | Requirement | Decision | Status |
|---|---|---|---|
| §71 | Minors | guardian flow authoritative; non-negotiable | planned |
| §72 | Agency | existing `visibleToOrg` wall; no Room/internal access | planned |
| §73 | Grassroots | reduced workflow matching the existing grassroots stage vocabulary | planned |
| §74 | 50km | discovery rule unchanged; an existing legitimate relationship is not invalidated by later workflow | planned |
| §75 | Tenant isolation | `id AND orgId`, 404 concealment (the `findRoom` pattern) | planned |
| §76 | Player visibility | every player-visible field deliberate | planned |
| §77 | Removed player | existing removal behaviour; no resurrection via stale links | planned |
| §78-§79 | Blocks | contact revoked immediately; internal history may remain | planned |

## Section G — Correctness infrastructure

| # | Requirement | Decision | Status |
|---|---|---|---|
| §80 | Concurrency | `rev`/`expectedRev` on case workflow, contact, trial, offer | planned |
| §81 | Conflict response | existing `guardRev` body — names and times, never content | planned |
| §82 | Dirty-form guard | reuse `dirtyGuard.ts` | planned |
| §83 | Idempotency | new minimal shared helper on the proven `clientKey` shape, 9 actions | planned |
| §84-§86 | Events | registered with audience + payload allowlist; ids and codes only | planned |
| §87-§90 | Notifications | reuse categories; no category explosion; Inbox for content | planned |
| §110-§113 | Security | strict validation, safe rendering, existing rate limiter, abuse cases | planned |
| §114 | Audit | existing org audit log; safe metadata, no note bodies | planned |
| §115 | Migration | additive, idempotent, in `m182/migrations.mjs` | planned |

## Section H — Verification

| # | Requirement | Target | Status |
|---|---|---|---|
| §116-§117 | `m23E2E` | ≥55% negative; all 90 named cases | planned |
| §118 | Positive journeys | P1-P20 | planned |
| §119-§136 | `m23Live` | L1-L17 | planned |
| §137-§139 | Demo + spotcheck | Alonso Mbuguni, plus the rejection branch | planned |
| §140-§141 | Perf + query audit | journey projection, 50/200/500 events, 1/5/20 trials | planned |
| §142-§149 | Targeted regressions | M20, M18.2, M15, M16.2, M22, M19, M21, M18 | planned |
| §155 | Full regression | every suite; no prior test weakened | planned |
| §156 | Restore bundle | scan, bundle, fresh clone, four historical suites | planned |

---

## Defects found

### D1 — `m22E2E` never exited (fixed, committed `98b8e7d`)

Found by the M23 baseline, the first unattended timed run of that suite. It
spawns a server and kills it from a `process.on('exit')` hook, but a ref'd
`ChildProcess` handle keeps the event loop alive, so the loop never drained and
the hook never fired. The suite printed **112 checks passed, 73% negative** and
then hung indefinitely — 2 seconds of work followed by an unbounded wait.

Worse than a red test: a human reading the log tail sees success, a harness sees
exit 124 and sees failure. One defect, two opposite wrong conclusions.

Fixed with `proc.unref()` — the same fix `e2e/demoHost.mjs` already carries from
M22 §74-§76. Verified: exit 0 in 2s, 112 checks, no lingering process.

### D2 — production-read stores were seed-dependent (CLOSED)

**Pre-existing core persistence defect, discovered during M23 preflight. Not
caused by M23.**

A mechanical inventory of all **123** `db.*` collections found **7** that
production code reads and that nothing guaranteed but `buildSeed()`:

```
blocks · reports · moderationLog · channels · reputationSeed · plans · archetypes
```

The mechanism is `loadSnapshot()`, which deletes every seeded key and replaces
the object with exactly what the snapshot holds — so a snapshot predating a
collection *removes* it, and the next read is a `TypeError`. For `db.blocks`,
read by `isBlocked()` inside every visibility check, a restored older snapshot
crashed the safeguarding path instead of answering it. A missing container is
infrastructure corruption, not an authorization decision.

Fixed by migration step `m230_001_core_stores_present`, schema **2200 → 2300**.
Containers of user data default to empty; the plan and archetype catalogues are
restored from `catalogue.mjs`, because an empty `plans` would have silently
moved a Grassroots attribution window from 12 months to 18 — a billing change
caused by a persistence bug, which is worse than the crash it replaced.

Full write-up, root cause per store, and the residual limitation:
`M23_STORE_INITIALIZATION_AUDIT.md`. Regression: `scripts/m23Persistence.mjs`,
55 checks, no seed execution anywhere in it.

Two further defects surfaced while fixing it:

**D2a — `db.squads` never existed.** One reference, inside
`(db.squads ?? []).length >= 0 && …` — true for every possible value, so it
could never change a result. Squad membership is `org.squad`, per organisation.
The tautological conjunct is removed; behaviour is identical.

**D2b — `m22E2E` pinned `SCHEMA_VERSION === 2200` as a literal** and broke on
the bump for a reason with no M22 meaning. This is the **third** recurrence of
one defect: M20 found it in M19's suite, M21 found it in M20's suite, M23 found
it here. The assertion now checks M22's own contribution
(`SCHEMA_VERSION >= 2200`) rather than pinning a shared constant.

A correction to something I asserted while making the bump: I said every suite
read `SCHEMA_VERSION` symbolically. That was true of `m182E2E`, which I had
checked, and false of `m22E2E`, which I had not. The bump was safe, but the
reasoning offered for it was not.

**A design point worth recording.** The first version of this fix pushed
`STORE_MISSING` into `integrityReport`'s `violations` array, which broke two
correct M18.2 assertions — including "an empty database is not a violation".
That assertion is right: an empty database has no *conflicting records*. Two
records disagreeing and a database never built are different problems needing
different responses, so the store check reports through a separate `stores`
field and the prior invariant stands unweakened.
