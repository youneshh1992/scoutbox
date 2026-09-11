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
| 1 | Two distinct systems, neither judging talent (1,2,3) | separate engines, no score anywhere | U-labels | ✅ |
| 2 | Second Look preconditions (4) | `buildSecondLookCandidate` guards | U-S | ✅ |
| 3 | Approved language only (5,27) | copy constants + sweep | U-labels | ✅ |
| 4 | Reason-aware matching (6,7) | versioned `REASON_CHANGE_MAP` | S1–S4 | ✅ |
| 5 | Material change engine (8) | `changesSinceDecision` | U-changes | ✅ |
| 6 | Direct vs general (9,63) | `strength`, direct ordered first | U-strength | ✅ |
| 7 | Trust never sole trigger (10) | decomposed to underlying codes | S6 | ✅ |
| 8 | Combine change, production only (11,81) | `testOnly` provider excluded | S4 | ✅ |
| 9 | Box Cam thresholded (12,82) | first-evidence / block-completion only | U-boxcam | ✅ |
| 10 | Reference add and revoke (13,14,90) | positive and negative changes | S3, S5 | ✅ |
| 11 | No automatic reopen (15,167) | explicit route only | A18, A19 | ✅ |
| 12 | Queue inside Recruitment (16,158) | three destinations in the existing Recruitment group; the four queues are tabs on ONE page, never four destinations | navConfig 155 | ✅ |
| 13 | Card + Review Changes diff (17,18) | snapshot vs current | M1 | ✅ |
| 14 | Snapshot used, never fabricated (19) | "Previous detail unavailable" | U-snapshot | ✅ |
| 15 | Lifecycle + dismissal (20,21) | 5 states, structured reasons | U-lifecycle | ✅ |
| 16 | Cooldown + fingerprints (22,60) | fingerprint set per item | A21 | ✅ |
| 17 | Deduplication (23) | canonical change identity | A11, A12 | ✅ |
| 18 | History + notification (24,25) | internal only, no spam | U-history | ✅ |
| 19 | Nobody Missed definition (26) | six preconditions | N1–N8 | ✅ |
| 20 | Recruitment Briefs (28,29,72,73) | new store, reused vocabulary | U-brief | ✅ |
| 21 | No protected criteria (30,44) | refused by their own code | A44 | ✅ |
| 22 | Position/age/location semantics (31,103,104,105) | canonical taxonomy, `ageOn` | U-brief | ✅ |
| 23 | Evidence/Trust/Combine criteria (32,33,34) | optional, explicit, banded | U-match | ✅ |
| 24 | Deterministic match + explanations (35,36,100) | reason list, no weights | N1, M5 | ✅ |
| 25 | No default ranking (37) | order by activity/name/distance | A52 | ✅ |
| 26 | Evaluated definition, versioned (38,39,40) | `EVALUATION_COVERAGE_POLICY_VERSION` | A43 | ✅ |
| 27 | Second Look vs Nobody Missed (41) | prior evaluation wins | A55, M7 | ✅ |
| 28 | Active room / block / visibility exclusions (42,43,44,45) | gates before matching | N2, N5, N6, N7 | ✅ |
| 29 | Coverage metric (46,47,174) | evaluated / eligible, named honestly | N1 | ✅ |
| 30 | Small-n suppression (48) | reuses `SUPPRESS_MIN` | U-privacy | ✅ |
| 31 | Review / Add to Room / dismiss (49–53) | bridges M17 | N8, M5 | ✅ |
| 32 | Brief change and versioning (54,55,56,57) | recompute; history keeps version | A54 | ✅ |
| 33 | Event normalization + fingerprints (58,59,60,61,62) | typed change records | U-changes | ✅ |
| 34 | Grouping and expiry (64,65) | one item per player | S6 | ✅ |
| 35 | Removed player / suspended org / staff (66,67,68) | gates + attribution kept | A7, A8, A25 | ✅ |
| 36 | Tenant isolation + brief ownership (69,70) | org-scoped, 404 concealment | A1–A3, A31 | ✅ |
| 37 | Permissions on existing roles (71) | `isLead` for briefs | A32 | ✅ |
| 38 | Source context on Room creation (74,75,85,86) | `nobody_missed` / `second_look` | M1, N8 | ✅ |
| 39 | Analytics, no scout ranking (76,77,78) | org-private counters | U-metrics | ✅ |
| 40 | Trust/Passport/Combine/Box Cam use rules (79–83) | evidence confidence only | U-labels | ✅ |
| 41 | Navigation + deep links (84,162,163,180) | tabs + routes | navConfig, M5 | ✅ |
| 42 | Not player-facing (113,114,160) | nothing added to player app | A4, A33, M-player | ✅ |
| 43 | T&S aggregate only (115) | counts, no contents | A-ts | ✅ |
| 44 | Events, idempotency, rate limits, audit, metrics (116–120) | conventions reused | A20, A-limits | ✅ |
| 45 | Pure engine (121,122,123) | all helpers exported | U-all | ✅ |
| 46 | ≥40% negative (124) | 60 enumerated abuse cases | m18E2E | ✅ |
| 47 | Error and success states (164,165,166) | honest empties, no fabrication | M-errors | ✅ |
| 48 | Performance + pagination + cache (169,170,171,172,173) | light facts, read-time gates | perf | ✅ |
| 49 | Docs + matrix (178,179) | this file + M18_SECOND_LOOK_NOBODY_MISSED.md | review | ✅ |
| 50 | M19 contract, no watchlists built (175,176,177) | briefs + match reasons exposed | design | ✅ |

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

Every row above carries measured verification. The sections below record what
was measured.

## Verification results (measured, not asserted)

- `scoutbox-server/scripts/m18E2E.mjs` — **286 checks, 172 negative/abuse
  (60%)**, covering all 60 enumerated abuse cases, S1–S8, N1–N8 and both named
  regressions (§13 fingerprints across projections, §22 Nobody Missed → Room →
  archive).
- `e2e/m18Live.test.mjs` — **60 checks**, journeys M1–M10 against the real
  backend in separate browser contexts (Pro, a rival club, Grassroots, and the
  player's own token).
- `e2e/m18DemoSpotcheck.test.mjs` — **55 checks**, all four demo bundles booted
  headless with **zero page errors**. A passing `vite build` does not catch the
  circular-import class of failure M16.1 hit; booting the bundle does.
- `e2e/navConfig.test.mjs` — **125 → 155 checks** with the three M18
  destinations, their deep links and the strict rejection of malformed ones.
- `scoutbox-server/scripts/m18Perf.mjs` — Second Look scan and list **4.0 ms**
  median (0.57 ms per item), Nobody Missed match with coverage **2.1 ms**
  (0.70 ms per candidate), whole-organisation coverage across three briefs
  **2.8 ms**, and a whole-brief match costing **1.39×** a single Passport
  assembly. *Honest limitation:* the seeded fixture is small, so these are
  shape measurements, not capacity figures, and no SLA is claimed.
- **One defect found and fixed during verification:** two archived rooms for
  the same player in one organisation produced two Second Look cards from one
  new full match. `projectCandidates` now keeps only the most recent ended room
  per player. Found by the browser journeys; guarded by both suites.
- **One client-side honesty fix:** the Grassroots brief form offered a
  professional level and an unbounded radius that the server then clamped
  silently. The form now states and enforces the standing 50 km / semi-pro
  ceilings, and the live journey proves the server still holds them regardless
  of what is posted.
- Full regression battery at the M18 tip, every suite re-run and green:
  trust 23 · apiE2E 129 · connectedE2E 43 · m12E2E 143 · m13E2E 212 ·
  m14E2E 193 · m141E2E 94 · m15E2E 185 · m16E2E 115 · m161E2E 79 ·
  m162E2E 124 · m17E2E 406 · **m18E2E 286** · navConfig 155 · navLive 30 ·
  liveIntegration · m12Live · m13Live · m14Live · m15Live 21 · m16Live 10 ·
  m162Live 11 · m17Live 25 · **m18Live 60** · uiSpotcheck ·
  m12/m13/m14 DemoSpotcheck · m162DemoSpotcheck 21 · m17DemoSpotcheck 47 ·
  **m18DemoSpotcheck 55** · crosstab · demoOffline · staleSessionProbe ·
  tsc ×4 · builds ×4. **No existing test was removed, skipped or weakened.**

## Final quality audit (§77)

| Question | Answer | Evidence |
|---|---|---|
| Could a player, guardian or rival club learn a Room archive reason, that a Second Look exists, a brief's criteria, a Nobody Missed state or coverage? | **No** | M18 registers no player, guardian or public route at all; its one notification targets `{kind:'org_user'}`; every org lookup is tenant-scoped with 404 concealment. m18E2E opens a real player SSE stream and proves nothing arrives; m18Live M8 drives a rival club through the UI and the API. |
| Does M18 ever match before visibility? | **No** | `computeBrief` runs `orgCanSee` (agency/minor wall, unverified-club wall, grassroots radius, blocks) before any criterion is read, and a failing player never becomes a candidate. `projectCandidates` does the same before collecting a single change. |
| Can unrelated evidence falsely resolve a prior reason? | **No** | `REASON_CHANGE_MAP` is explicit per reason; the six club-side reasons map to `[]` and are reported as `unresolvedReasonCodes`. m18E2E U2 asserts both directions; m18Live M2 proves the UI prints "Reasons that still stand" instead. |
| Can a previously evaluated player re-enter as "missed"? | **No** | Nine evaluation signals, checked before candidacy; archiving a room leaves the player evaluated. m18E2E §22 and m18Live M7 both drive add-to-room → archive → later evidence and confirm it reaches Second Look, not Nobody Missed. |
| Is any hidden talent score or overall rank created? | **No** | No score exists in either engine; ordering is by activity, name or distance and says so on the page. The suites sweep the responses and the rendered DOM for `matchScore`, `rankScore`, `"rank"` and `"weight"`, and the forbidden-name list is asserted absent. |
| Can M18 reopen a Room, contact a player or create a Room automatically? | **No** | Both actions exist only as routes a recruiter calls, and both go through M17's own `reopenRoom` / `createRoomForPlayer`. m18E2E asserts that reading the queue never changes a room's status; m18Live M1 re-reads the room after reading the queue and finds it still archived. |

