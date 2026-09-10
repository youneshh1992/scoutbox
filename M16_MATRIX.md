# M16 — Box Cam + Development Intelligence: requirements matrix

Baseline (tip `bacda0c`, all green before any M16 change): unit/trust 23 ·
apiE2E 129 · m12E2E 143 · m13E2E 212 · m14E2E 193 · m141E2E 94 · m15E2E 184
· connectedE2E 43 · navConfig 111 · navLive 30 · m12/m13/m14/m15 live suites
· liveIntegration · staleSessionProbe 14 · crosstab · demoOffline ·
spotchecks · tsc ×4 · builds ×4.

## Truth boundary (the sentence Box Cam is allowed to say)

> "ScoutBox Box Cam observed activity consistent with this supported drill
> for X active minutes/repetitions during a live capture session."

Never: "performed perfectly", "improved", "talented", a talent score, or a
biometric identity claim. Observation ≠ evaluation.

## Source systems reused (never duplicated)

| Concern | Canonical source |
|---|---|
| Development objectives | M12 `db.devObjectives` (assignments LINK to them, never copy) |
| Passport display | M15 projection engine — Box Cam data is projected, never re-stored |
| Provenance | M15 vocabulary EXTENDED with `box_cam_observed` (rank: above player/guardian submission, below `scoutbox_reviewed` — never an authoritative current-club source) |
| Org gates | `visibleToOrg` + blocks + agency/minor wall + grassroots radius, verbatim |
| Minors | existing DOB+country `isAdult()`; guardian routes |
| Media clips | existing player media pipeline (optional, guardian-gated for minors) |
| Audit / notifications / metrics | existing ledger, delivery centre, m13 metrics |

New M16 storage: `boxSessions`, `boxSessionEvents` (aggregated intervals +
rep events, never per-frame rows), `boxAssignments`, `boxChallenges`,
`boxChallengeEntries`, `boxCamDisputes`, `boxCamPrefs`. Drill registry is
static + versioned in code (`m16/drills.mjs`), not persisted.

## Requirements

| # | Requirement (§) | Implementation | Test | Status | Limitation |
|---|---|---|---|---|---|
| 1 | Box Cam truth boundary; observation ≠ evaluation (1) | copy + engine emits observed facts only | m16E2E sweeps | ✅ | — |
| 2 | `box_cam_observed` provenance, honest copy, ranked correctly (2) | m15/shared PROVENANCE ext | provenance tests | ✅ | m15E2E "exactly 8 values" check updated to "8 M15 values + box_cam_observed, correctly ranked" — an extension, not a weakening |
| 3 | Verification states, no bare boolean (3) | engine state machine (11 states) | state derivation tests | ✅ | — |
| 4 | Session time ≠ observed active time (4) | interval engine; separate fields | §102 ms-accuracy tests | ✅ | — |
| 5 | Target types: duration/repetitions/sets/combined (5) | drill target engine | m16E2E | ✅ | combined = sets×reps |
| 6 | Drill framework: versioned detector contracts (6) | `m16/drills.mjs`, sessions pin drill@version | version tests | ✅ | — |
| 7 | Bounded first library, 8 drills (7) | box-touches/control/juggles/wall/footwork/mobility/strength/interval @1 | registry tests | ✅ | box-wall ships `active_duration_only` — automated wall-pass rep counting honestly `not_configured` |
| 8 | Capability levels, no inflation (8) | per-drill `verificationCapabilities`; session verifies only intersection(drill, provider) | unsupported-capability tests | ✅ | — |
| 9 | Provider interface + explicit status (9) | `BoxCamObservationProvider` contract; statuses configured/limited/not_configured/unsupported | provider tests | ✅ | production CV: **not_configured** — stated, never simulated in production |
| 10 | Local test provider, test-only label (10) | deterministic fixture provider | suite uses it | ✅ | — |
| 11 | Box Cam Ready Check (11) | readiness endpoint + client checks; "Unable to check automatically" where unmeasurable | live journey | ✅ | web can check permission/stream/orientation only |
| 12 | Setup guidance per drill (12) | drill setup fields + UI | spotcheck | ✅ | text + simple diagram placeholder |
| 13 | Live-capture-only Box Cam provenance (13) | provenance minted server-side on live-session finalize only; uploads keep existing provenance | abuse #13/B4 | ✅ | — |
| 14 | Server-minted sessions + nonce (14,41) | POST sessions → id/nonce/liveness/expiry; server owns identity | replay tests | ✅ | — |
| 15 | Structured event stream, monotonic seq, bindings (15) | event batches validated per session | ingestion tests | ✅ | — |
| 16 | Confidence preserved internally, no talent % in UI (16) | quality good/degraded/insufficient; thresholds per drill | quality tests | ✅ | — |
| 17 | Session result shape (17) | finalized result + reasons | m16E2E | ✅ | — |
| 18 | Completion from VERIFIED values only; no rounding up (18) | engine completion rules | 1ms-under tests | ✅ | — |
| 19 | Partial credit, neutral language (19) | partially_verified + "Target not yet completed" | m16E2E + copy sweep | ✅ | — |
| 20 | Live session UI: verified vs session clocks (20) | player app session screen | live journey | ✅ | — |
| 21 | Result screen "Your work counts." (21) | player app | live journey | ✅ | — |
| 22 | Box Training hub (22) | player app section under You/Development | spotcheck | ✅ | no new nav tab (per M15-Nav) |
| 23 | Development Plan over M12 objectives (23) | plan view: objectives + assignments + sessions | m16E2E | ✅ | objective auto-achievement never claimed |
| 24 | Coach-assigned Box Training w/ provenance snapshot (24) | boxAssignments (org, person, verification at assignment) | authz tests | ✅ | — |
| 25 | Assignment states, non-punitive (25) | state machine | m16E2E | ✅ | — |
| 26 | Coach view, no training score (26) | drawer panel table + summary | live journey | ✅ | — |
| 27 | Passport timeline events, no flooding (27) | box_session_completed (meaningful only) + box_challenge_completed | passport tests | ✅ | detail lives in Box Training |
| 28 | Passport Development Activity summary + honest wording (28) | m15 assemble ext | m16E2E | ✅ | "evidence of recorded training activity … NOT proof of player ability" |
| 29 | Box Streak: schedule-based, rest-safe (29) | weekly-consistency engine | streak tests | ✅ | rest days never break a streak |
| 30 | Box Challenge framework, no endorsement implication (30,32) | boxChallenges + entries + mandatory disclaimer copy | challenge tests | ✅ | — |
| 31 | Club challenges: verified orgs, standing gates, windows/caps (31) | eligibility checks | abuse tests | ✅ | — |
| 32 | Video privacy: no raw retention by default (33,34) | NO raw-video upload path exists for Box Cam; structured events only | leakage sweep | ✅ | web capture preview stays in-browser; server never receives frames |
| 33 | Optional clip via existing media, guardian-gated (35) | clip endpoint → media pipeline | minor tests | ✅ | — |
| 34 | On-device target architecture; honest web limitation (36,84) | provider statuses; docs | status endpoint test | ✅ | web = `web_limited` (foreground+stream heuristics), production CV `not_configured` |
| 35 | Minor privacy: guardian controls; clubs get results not footage (37) | boxCamPrefs guardian-managed; org sees summaries only | privacy matrix | ✅ | — |
| 36 | No scene recognition / home analysis (38) | event vocabulary is drill-scoped only | schema sweep | ✅ | — |
| 37 | No audio (39) | video-only capture; no audio fields anywhere | sweep | ✅ | documented browser caveat |
| 38 | Liveness pre-check, not biometric (40,46) | server-selected challenge; presence-only wording | missing/wrong-liveness tests | ✅ | — |
| 39 | Nonce/anti-replay (41) | fresh nonce; reuse/stale/duplicate rejected | replay tests B94 | ✅ | — |
| 40 | Clock/event integrity; client cannot set verified fields (42,95) | server-derived result; forged fields ignored; drift bounds | forged-value tests | ✅ | web provider events are client-observed but server-bounded (documented) |
| 41 | Interruption handling (43) | interruption events pause verified clock | interruption tests | ✅ | — |
| 42 | Offline: connectivity required for verified sessions (44) | documented; no offline authoritative path | — | ✅ | honest scope cut |
| 43 | Multiple people → pause/unable, NO facial recognition (45) | multi_person event → observation pause | test | ✅ | no identity inference |
| 44 | Quality states good/degraded/insufficient (47) | engine | quality tests | ✅ | — |
| 45 | Honest result explanations (48) | copy per state | sweep | ✅ | never "You didn't train" |
| 46 | Player note separate provenance (49) | note field `player_submitted_note` | test | ✅ | — |
| 47 | Objective metrics only; no "improved 47%" (50) | trends = raw observed values | sweep | ✅ | — |
| 48 | Box Best per drill@version (51) | engine; no cross-version merge | test | ✅ | — |
| 49 | NO global leaderboard (52) | absent by design | review | ✅ | — |
| 50 | Rest/safety fields per drill (53) | safetyNotes/rest/space | registry test | ✅ | no medical claims |
| 51 | Schedule/training week (54) | assignment frequency + week view | m16E2E | ✅ | — |
| 52 | Only supported drills verifiable; free-text never verified (55) | assignment drillId validated | test | ✅ | — |
| 53 | Drill versioning immutability (56,79) | sessions pin version; finalized results immutable; invalidation only | version tests | ✅ | — |
| 54 | Audit integration (57) | ledgerAppend for assignment/challenge/dispute/clip events | m16E2E | ✅ | frame events stay in session data |
| 55 | T&S Box Cam cases: invalidate/restore, never fabricate (58,59) | boxCamDisputes + admin tools | T&S tests | ✅ | — |
| 56 | Session detail SELF/GUARDIAN by default; narrowing-only sharing (60) | boxCamPrefs opt-in recruitment summary | privacy matrix §104 | ✅ | — |
| 57 | Recruitment dev view (opt-in, aggregate) (61) | m15 org projection ext | matrix | ✅ | — |
| 58 | No recruitment overweighting / talent feed (62) | facts only: evidence availability | sweep | ✅ | — |
| 59 | M17/M18/M19 hooks: summary contract, domain event, safe facts (63–66,113–115) | developmentSummary contract + `player_development_evidence_changed` broadcast + hasRecentDevelopmentEvidence | contract tests | ✅ | future products NOT built |
| 60 | Gap engine ext: contextual, non-pressuring (67) | m15 gap rule `gap.training_evidence` (non-shaming copy) | test | ✅ | — |
| 61 | Analytics boundaries (68,105,106) | metrics.boxCam counters, no PII, no engagement-surveillance metrics | metrics test | ✅ | — |
| 62 | No pay-to-Box (69) | absent by design | review | ✅ | — |
| 63 | Brand language used naturally (70) | UI copy | spotcheck | ✅ | admin screens stay factual |
| 64 | Box Cam icon from existing iconography (71) | client icon (camera-in-box SVG), aria "Box Cam" | spotcheck | ✅ | — |
| 65 | Navigation: no new global rows (72,73) | player: section under You; club: drawer Development panel | navConfig unchanged | ✅ | — |
| 66 | Challenges separate from Opportunities (74) | own surface | review | ✅ | — |
| 67 | Data model minimal; passport projects (75,76) | stores listed above | review | ✅ | — |
| 68 | Event aggregation, never 30fps rows (77,78) | interval model + rep events; batch caps | ingestion tests | ✅ | — |
| 69 | Result hash (80) | sha256 canonical result | integrity test | ✅ | not blockchain |
| 70 | API per conventions (81) | player/guardian/org/admin routers | suite | ✅ | — |
| 71 | Authorization matrix (82) | standing gates on every org route | authz tests | ✅ | — |
| 72 | Camera permission states (83) | Ready Check UI states | live journey | ✅ | — |
| 73 | Demo simulation clearly labelled (85,86) | "Box Cam demo — simulated camera observations" | demo spotcheck | ✅ | — |
| 74 | Live journeys B1–B12 (87–98) | e2e/m16Live.test.mjs + API journeys in suite | all pass | ✅ | — |
| 75 | ≥40% negative tests incl. §99 catalogue (99,100) | m16E2E | counted | ✅ | — |
| 76 | Pure engine module (101) | m16/shared.mjs | unit sections | ✅ | — |
| 77 | Active-time §102 + rep §103 edge cases | unit tests | exact | ✅ | — |
| 78 | Privacy matrix §104 | 8 viewer contexts, exact fields | m16E2E | ✅ | — |
| 79 | Rate limits (109) | session/event/challenge/dispute limits | limit tests LAST | ✅ | — |
| 80 | Performance measured (107) | batching; measured result/history/dashboard timings | perf checks | ✅ | measurements, not SLAs |
| 81 | Error recovery, no fake success (108) | interruption → paused verified clock; unrecoverable → unable_to_verify | tests | ✅ | — |
| 82 | Docs M16_BOX_CAM.md (110) | 25 sections | review | ✅ | — |
| 83 | Quality bar checklist (116) | each item asserted by a test or review note | m16E2E | ✅ | — |
