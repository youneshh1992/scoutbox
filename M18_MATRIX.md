# M18 — Second Look + Nobody Missed: implementation matrix

Written **before** any M18 code, from a full inspection of M17 decision memory,
every change source, and every existing model of club demand. Baseline tip
`a4fedc4`; two M17 defects found during that inspection were fixed first
(`fafd1b0`). Branch `claude/desktop-project-migration-wyk3ec`, nothing pushed.

## Baseline regression (measured, all green)

trust 23 · apiE2E 129 · connectedE2E 43 · m12E2E 143 · m13E2E 212 · m14E2E 193 ·
m141E2E 94 · m15E2E 185 · m16E2E 115 · m161E2E 79 · m162E2E 124 · m17E2E 406 ·
navConfig 125 · navLive 30 · liveIntegration · m12–m17 Live · uiSpotcheck ·
demo spotchecks · crosstab · demoOffline · staleSessionProbe · tsc ×4 · builds ×4.

## What these two systems are

| | Second Look | Nobody Missed |
|---|---|---|
| Question | has something materially changed since **we** last decided? | do players matching **our own stated criteria** exist whom we never evaluated? |
| Precondition | a prior decision exists | no meaningful evaluation exists |
| Input | decision snapshot + change events since that decision | an explicit Recruitment Brief |
| Output | grouped, reason-aware change items | explained candidates + evaluation coverage |
| Never | says the decision was wrong | says who is talented |

Neither reopens a Room, contacts a player, or produces a score.

## Source map — reuse vs. new

| Concern | Canonical source | M18 does |
|---|---|---|
| Prior decision | `db.roomDecisions`, head = `supersededById == null` (**not** last-by-`createdAt`, which is unstable for same-ms writes) | reads; never writes |
| Decision-time state | `db.roomSnapshots.sourceRefs` + `snapshot.trust` | diffs against current |
| Archive reasons | M17 `REASON_CODES` / `REVISITABLE_REASON_CODES` | maps to change types |
| Evidence change | `db.evidence` — `recordedAt`, `verification.reviewedAt`, `disputes[].at`, `correctionOf`/`supersededBy` | normalises |
| Reference change | `db.verReferences` (`createdAt`/`withdrawnAt`), `db.verEvents.ts`, M14 `effectiveStatus` | normalises |
| Combine change | `db.combineAttempts.completedAt` + **live** `effectiveState` + `PROVIDERS[provider].testOnly` | normalises, excludes simulated |
| Box Cam change | `db.boxSessions.finalizedAt`, `db.boxAssignments.updatedAt` | normalises, thresholded |
| Trust change | component **levels** in the snapshot vs now | derives its own codes (see limitation) |
| Trial / assessment / signing | `trial.report.filedAt`, `assessment.submittedAt`, `signing.ts` | normalises |
| Gap closure | `db.evidenceSuggestions` `status:'supplied'` + `updatedAt` | strongest pre-built signal |
| Criteria vocabulary | M12 `CRITERIA_KEYS`, `evaluateCriterion`, `checkEligibility` semantics | reuses |
| Position taxonomy | the canonical 13 positions / 4 groups | reuses — **no fifth copy** |
| Age | `ageOn(dob)` from `domain.mjs` | reuses; see limitation |
| Visibility | `orgCanSee` = `visibleToOrg && !isBlocked` | runs **before** matching |
| Already-evaluated | M17 rooms, M12 cases, assessments, trials, signings, shortlist ledger, `reviewLater`, squad | unions them |
| Add to Room | M17 `POST /org/rooms` | bridges; no duplicate workflow |
| Small-n | M13 `SUPPRESS_MIN = 3` | reuses |

### Why a new `db.recruitmentBriefs` store is justified

`org.tactical.roles[]` carries position/age/foot/availability/level/category;
`opportunity.eligibility` carries radius. **Neither** carries evidence
requirements, Combine requirements, an evidence-confidence band, lifecycle
states, activity windows or versioning — all of which M18 requires. So a brief
is a new record that **reuses the existing criteria vocabulary** and can import
from a tactical role, rather than a parallel demand model. Briefs link
`roleId`/`vacancyId` where one exists.

## Requirements

| # | Requirement (§) | Implementation | Test | Status |
|---|---|---|---|---|
| 1 | Two distinct systems, neither judging talent (1,2,3) | separate engines, no score anywhere | U-labels | planned |
| 2 | Second Look preconditions (4) | `buildSecondLookCandidate` guards | U-S | planned |
| 3 | Approved language only (5,27) | copy constants + sweep | U-labels | planned |
| 4 | Reason-aware matching (6,7) | versioned `REASON_CHANGE_MAP` | S1–S4 | planned |
| 5 | Material change engine (8) | `changesSinceDecision` | U-changes | planned |
| 6 | Direct vs general (9,63) | `strength`, direct ordered first | U-strength | planned |
| 7 | Trust never sole trigger (10) | decomposed to underlying codes | S6 | planned |
| 8 | Combine change, production only (11,81) | `testOnly` provider excluded | S4 | planned |
| 9 | Box Cam thresholded (12,82) | first-evidence / block-completion only | U-boxcam | planned |
| 10 | Reference add and revoke (13,14,90) | positive and negative changes | S3, S5 | planned |
| 11 | No automatic reopen (15,167) | explicit route only | A18, A19 | planned |
| 12 | Queue inside Recruitment (16,158) | page tabs, no sidebar item | navConfig | planned |
| 13 | Card + Review Changes diff (17,18) | snapshot vs current | M1 | planned |
| 14 | Snapshot used, never fabricated (19) | "Previous detail unavailable" | U-snapshot | planned |
| 15 | Lifecycle + dismissal (20,21) | 5 states, structured reasons | U-lifecycle | planned |
| 16 | Cooldown + fingerprints (22,60) | fingerprint set per item | A21 | planned |
| 17 | Deduplication (23) | canonical change identity | A11, A12 | planned |
| 18 | History + notification (24,25) | internal only, no spam | U-history | planned |
| 19 | Nobody Missed definition (26) | six preconditions | N1–N8 | planned |
| 20 | Recruitment Briefs (28,29,72,73) | new store, reused vocabulary | U-brief | planned |
| 21 | No protected criteria (30,44) | refused by their own code | A44 | planned |
| 22 | Position/age/location semantics (31,103,104,105) | canonical taxonomy, `ageOn` | U-brief | planned |
| 23 | Evidence/Trust/Combine criteria (32,33,34) | optional, explicit, banded | U-match | planned |
| 24 | Deterministic match + explanations (35,36,100) | reason list, no weights | N1, M5 | planned |
| 25 | No default ranking (37) | order by activity/name/distance | A52 | planned |
| 26 | Evaluated definition, versioned (38,39,40) | `EVALUATION_COVERAGE_POLICY_VERSION` | A43 | planned |
| 27 | Second Look vs Nobody Missed (41) | prior evaluation wins | A55, M7 | planned |
| 28 | Active room / block / visibility exclusions (42,43,44,45) | gates before matching | N2, N5, N6, N7 | planned |
| 29 | Coverage metric (46,47,174) | evaluated / eligible, named honestly | N1 | planned |
| 30 | Small-n suppression (48) | reuses `SUPPRESS_MIN` | U-privacy | planned |
| 31 | Review / Add to Room / dismiss (49–53) | bridges M17 | N8, M5 | planned |
| 32 | Brief change and versioning (54,55,56,57) | recompute; history keeps version | A54 | planned |
| 33 | Event normalization + fingerprints (58,59,60,61,62) | typed change records | U-changes | planned |
| 34 | Grouping and expiry (64,65) | one item per player | S6 | planned |
| 35 | Removed player / suspended org / staff (66,67,68) | gates + attribution kept | A7, A8, A25 | planned |
| 36 | Tenant isolation + brief ownership (69,70) | org-scoped, 404 concealment | A1–A3, A31 | planned |
| 37 | Permissions on existing roles (71) | `isLead` for briefs | A32 | planned |
| 38 | Source context on Room creation (74,75,85,86) | `nobody_missed` / `second_look` | M1, N8 | planned |
| 39 | Analytics, no scout ranking (76,77,78) | org-private counters | U-metrics | planned |
| 40 | Trust/Passport/Combine/Box Cam use rules (79–83) | evidence confidence only | U-labels | planned |
| 41 | Navigation + deep links (84,162,163,180) | tabs + routes | navConfig, M5 | planned |
| 42 | Not player-facing (113,114,160) | nothing added to player app | A4, A33, M-player | planned |
| 43 | T&S aggregate only (115) | counts, no contents | A-ts | planned |
| 44 | Events, idempotency, rate limits, audit, metrics (116–120) | conventions reused | A20, A-limits | planned |
| 45 | Pure engine (121,122,123) | all helpers exported | U-all | planned |
| 46 | ≥40% negative (124) | 60 enumerated abuse cases | m18E2E | planned |
| 47 | Error and success states (164,165,166) | honest empties, no fabrication | M-errors | planned |
| 48 | Performance + pagination + cache (169,170,171,172,173) | light facts, read-time gates | perf | planned |
| 49 | Docs + matrix (178,179) | this file + M18_SECOND_LOOK_NOBODY_MISSED.md | review | planned |
| 50 | M19 contract, no watchlists built (175,176,177) | briefs + match reasons exposed | design | planned |

## Known traps found during inspection (all documented, none faked)

1. **`snapshot.sourceRefs.passportVersion` is always `null`** — `assemble()`
   never sets it and `passportVersion: 1` is a projection-schema constant, not a
   content version. M18 uses the id sets and `snapshot.trust.hash` instead.
2. **`trustChangeReasons(before, after)` cannot consume a stored snapshot** — it
   reads `coverageBp`, which the snapshot deliberately drops. M18 derives its own
   codes from component **levels**, preserving the existing vocabulary.
3. **`combineProjection` does not filter simulated attempts** — M18 joins back to
   `db.combineAttempts` and excludes `PROVIDERS[provider].testOnly`.
4. **Combine and Box Cam invalidation write no timestamp** — detected by set
   difference against the snapshot, not by a clock.
5. **`checkEligibility` computes age with a float-year formula that can disagree
   with `ageOn` near a birthday.** M18 uses `ageOn` exclusively and says so in
   the route note.
6. **`currentDecision` is last-by-`createdAt`** — M18 uses
   `supersededById == null`, which is exact.

Status column becomes ✅/limitation as each lands; measured results replace
"planned" at the end.
