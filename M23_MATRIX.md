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

## P2 status (§129)

Every P2 requirement, with no "mostly done".

| Area | Status | Evidence |
|---|---|---|
| One authoritative lifecycle | **implemented + tested** | 18 states, one table (`m17/shared.mjs`); m23E2E U1 |
| Case canonical, Room a facet | **implemented + tested** | no new store; `migrateM23` empty |
| No competing stage store | **implemented + tested** | H23; repo sweep for `db.recruitmentJourneys` etc. |
| Single status writer | **implemented + tested** | `applyStatus` only; `ctx.applyLifecycleTransition` seam |
| No generic stage mutation | **implemented + tested** | `LIFECYCLE_STAGE_NOT_SETTABLE`; #5/#25 |
| Semantic actions | **implemented + tested** | 19 actions; H11 |
| Transition validator | **implemented + tested** | `canTransitionRecruitmentCase` |
| Evidence preconditions | **implemented + tested** | H1-H6; keyed by target |
| `offer_accepted ≠ signed` | **implemented + tested** | H1, H5; every inbound edge enumerated |
| Append-only history | **implemented + tested** | J4, #28, #37 |
| rev / expectedRev | **implemented + tested** | #7, H4 |
| Idempotency | **implemented + tested** | J6, #9, #10, #24 |
| Journey projection | **implemented + tested** | U3, H7, H18-H20 |
| Determinism | **implemented + tested** | H7, H8; injected clock |
| nextActions permission-aware | **implemented + tested** | H11 (role matrix, re-validated) |
| Hidden interest | **implemented + tested** | #13, #36 byte-identical |
| Legacy compatibility | **implemented + tested** | J12, H13 |
| Unknown legacy state | **implemented + tested** | H14, H14c |
| Hold / reopen cycling | **implemented + tested** | H15, H16 |
| M20 funnel semantics | **implemented + tested** | H17; `FUNNEL_NON_PROGRESS_STATUSES` |
| Trust / Passport / Matching / Development / Second Look | **unchanged + tested** | #19, #20, #22, #35 |
| Perf + scan audit | **measured** | `m23Perf`; 1.27x, ≤2 reads/collection |
| Production store boot contract | **implemented + proven** | `m23BootContract` (61 checks, 70% negative); 123 stores, 0 missing after a real boot |
| Store ownership machine-readable | **implemented + tested** | `storeContract.mjs`; `PRODUCTION_REQUIRED_STORES` derived, not hand-kept; drift guard proved by injection |
| Browser / live regression | **implemented + passing** | `e2e/m23Live.test.mjs`, 37 checks, real login; found B4 |
| m18E2E `changeCount` flake | **closed at the writer** | B6; 100 targeted + 20 full runs clean; `M23-P2-FLAKE-CLOSED` |
| Dead code + stale comments | **swept** | 7 unused exports classified, 1 rewired, 1 un-exported; no TODO/FIXME/HACK marker in any M23-touched file |
| Error → HTTP contract | **one table, no default** | `m23/errors.mjs`, 21 codes; `m23E2E` group Y (16 checks) extracts every `error:` literal from source and requires a status |
| Error privacy | **asserted** | every 500 is code + fixed message; Y7/Y8 prove the projector still names stores internally and the client body does not |
| Hidden-case parity | **byte-identical** | Y12/Y13, re-asserted after the mapping was centralised |
| Recovery through the browser | **proven** | fresh clone of the bundle → npm install → `vite build` → `m23Live` 39 checks, rc=0 |
| Browser/live battery | **33/33 green** | mechanically discovered; zero surviving processes, zero held ports |
| Test-order independence | **6 orderings, identical counts** | A–F, fresh process state each; the old m182 330/333 variance does not recur |
| Typechecks + builds | **4/4, 3/3** | from the working tree and again from the final fresh clone |
| Docs | **complete** | workflow (24 sections), terminology (16 terms) |
| Atomicity failure injection | **deferred** | see D9 |
| Events / notifications for transitions | **deferred, deliberately** | nothing to notify until a share boundary exists (§64, §45) |
| Client UI | **not applicable to P2** | two org routes, no client surface |

---

## Defect register (§130)

| ID | Severity | Root cause | Regression | Fix | Status |
|---|---|---|---|---|---|
| **D1** | medium | `m22E2E` spawned a server and killed it from an exit hook that could never run, because a ref'd child keeps the event loop alive. 112 checks green, then an unbounded hang. | the M23 baseline, first unattended timed run | `proc.unref()` | **fixed** `98b8e7d` |
| **D2** | high | 7 production-read stores existed only because `buildSeed()` ran; `loadSnapshot()` deletes every seeded key. `db.blocks` is read by `isBlocked()` in every visibility check, so a restored snapshot crashed the safeguarding path. | `m23Persistence` (55 checks, no seed) | migration `m230_001`, schema 2300, `catalogue.mjs` | **fixed** `07e9017` |
| **D2a** | low | `db.squads` never existed; one read inside a tautological conjunct. | store inventory | conjunct removed, behaviour identical | **fixed** `07e9017` |
| **D2b** | medium | `m22E2E` pinned `SCHEMA_VERSION === 2200`. Third recurrence: M20 found it in M19's suite, M21 in M20's. | schema-pin sweep | asserts `>= 2200`, its own contribution | **fixed** `07e9017` |
| **D2c** | medium | My first D2 fix pushed `STORE_MISSING` into `integrityReport`'s violations, breaking M18.2's correct "an empty database is not a violation". | m182E2E | separate `stores` field; prior invariant unweakened | **fixed** `07e9017` |
| **D3** | **high** | The legacy `POST /org/rooms/:id/status` route took a client status and applied it with no evidence check, so `offer_made` + `{status:'signed'}` reached `signed` with no signing in the database. Two precondition tables meant two answers; the one that mattered was never asked. | m23E2E H2c (route), H1/H5 (validator) | one table in `m17/shared.mjs`, keyed by target, returned by `validateTransition`; both M17 paths fail closed | **fixed** `4c38b9b` |
| **D4** | medium | M17 status-census assertions (`length === 13`, `=== 9`) — a census of the set, not an invariant. | m17E2E | assert labelled / mapped / partitioned instead | **fixed** `1969be1` |
| **D5** | low | Extending the lifecycle diluted M17's 40% negative floor to 35%. | m17E2E coverage gate | 46 new negatives for the 5 new states; 515 checks, 41% | **fixed** `1969be1` |
| **D6** | medium | `registerM18` returns a fresh object, so M17's room seams never reached `m19Ctx`; every journey read was a 500. | m23E2E J1 | seams passed explicitly | **fixed** `cb8c730` |
| **D7** | medium | `roomRole()` destructures one object; called with three positional args, so every role resolved `null` and every action was refused. Failed closed, but wrong. | m23E2E J3 | call-shape corrected | **fixed** `cb8c730` |
| **D8** | low | `applyLifecycleTransition` used `REOPENED_FROM` without importing it. | m23E2E J3 | import added | **fixed** `cb8c730` |
| **D9** | low | `journey.mjs` passed a literal `reasonCodes: ['placeholder']` to make reason-requiring actions appear in `nextActions` — passing for the wrong reason, and one echo from a response body. | — | explicit `forAvailability` flag | **fixed** `ded233e` |
| **D10** | low | Dead `now()` helper in `m23/index.mjs`. | dead-code sweep | removed | **fixed** `ded233e` |
| **D11** | low | m23E2E compared M23/M17 terminal sets by length. | — | compares by content | **fixed** `ded233e` |
| **T1** | test | m23E2E assumed `under_review → closed` was an edge. It is not, in M17 or M23. | — | fixture holds the case first | **fixed** `cb8c730` |
| **B4** | high | The lifecycle route validated reason codes against M17's **decision** taxonomy, so it refused all 16 lifecycle codes and accepted judgements about a player as the reason a case moved. | `m23Live` L3, first attempt to hold a case | `validateLifecycleReasons` in `m23/lifecycle.mjs`; new group V | **fixed** `a4bb7af` |
| **B5** | medium | `m23Live` printed `37 checks passed` and never exited — ref'd backend and static servers. D1 reproduced in new code by the same author; held ports 4023/8723 and broke the next run. | the second unattended run | `process.exit(0)` after closing statics and stopping the backend | **fixed** `a4bb7af` |
| **B6** | **high** | `newEvidence` read `Date.now()` three times for one record, so `reviewedAt` could land 1ms after `recordedAt` and a brand-new upload was reported as an *upgrade of itself*. The long-standing m18E2E `changeCount` flake was this, not a test flake. | 50-run stress probe (`m18FlakeProbe`), reproduced on run 30 | one clock read per event; regressions at the owner (m12E2E) and as an invariant (m18E2E) | **fixed** `8e8d0a3` |
| **C1** | low | The first store contract counted `db.schema` — the migration registry's own record — as a store, reading the guarantee one store broader than it is. | writing the contract in a checkable form | moved to `NOT_A_STORE`; 123 stores, 42 migration | **fixed** `213b980` |
| **C2** | low | `LIFECYCLE_INITIAL` had no caller, and `'watching'` was spelled at both room-creation sites. Not stale — disconnected. | dead-code sweep | `INITIAL_ROOM_STATUS` in `m17/shared.mjs`, read at both sites; M23 keeps an alias | **fixed** `7605e75` |
| **F1** | low | `JOURNEY_VIEWER_UNKNOWN` answered 404 — "no such recruitment case" — about a case that exists and is fine. The fault is the caller's viewer kind, so it is ours. | writing the error mapping down as a table | 500, with the other codes that mean this build is wrong | **fixed** `2480a3b` |
| **F2** | medium | The journey route returned the projector's result verbatim, so a `JOURNEY_STORE_MISSING` 500 handed the client `missing`/`malformed` — lists of raw internal store names. | the same table, asking what leaves over HTTP | `publicErrorBody`; the detail goes to the log, the code survives | **fixed** `2480a3b` |
| **F3** | medium | Five lifecycle states had no `rm.st.*` label in either client in either language. The fallback rendered `offer_accepted` as "offer accepted", where the server says "Accepted in ScoutBox" because a signing is a separate legal event. | mechanical EN/FR coverage check against `ROOM_STATUSES` | 10 entries per client using the server's wording; m23Live L7b/L7c stated positively over the whole set | **fixed** `e75d5d6` |
| **F4** | medium | `m23Persistence` printed "server did not come up" above a log line saying it was listening: a 40s poll budget ran out under battery load and the announcement landed during the final sleep. | the full server battery, at its most loaded | wait on the server's own `listening on :NNNN` announcement, verify the port, then confirm over HTTP; three failures now have three messages | **fixed** `e75d5d6` |

### Deferred, with reasons

**D-atomicity (§29).** Status mutation, history append and rev bump happen
synchronously in one function against an in-memory object, then `persistNow()`
writes the whole snapshot in a single SQLite transaction. There is no window in
which a status is durable without its history — they are the same write. A
failure-injection harness would therefore be testing `store.save`'s
transactionality, which `m182E2E` already covers. Recorded rather than built,
because a test that cannot fail teaches nothing.

**D-events (§30, §84).** No lifecycle event is emitted yet, so there is nothing
for the registry sweep to catch. Adding one before a share boundary exists
would mean broadcasting internal stage changes with no audience entitled to
them. It belongs with the Contact phase.
