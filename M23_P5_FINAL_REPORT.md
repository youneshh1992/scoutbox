# M23 P5 — Assessment + Recruitment Decision Integration: Final Report

Branch `claude/desktop-project-migration-wyk3ec`. Nothing was pushed, no PR
was opened, nothing was deployed (mandate: "Do NOT push during P5 unless I
explicitly authorize it later").

Documents of record: `M23_P5_DECISION_REUSE_AUDIT.md`,
`M23_P5_DECISION_CONTRACT.md`, `M23_P5_DECISION_IMPLEMENTATION.md`,
`M23_P5_DEFECT_REGISTER.md`; `M23_TERMINOLOGY.md` and
`M23_ERROR_CONTRACT.md` §7 updated; `M20_METRICS.md` F5.

## The 76 items (§174)

1. **Starting tip** — `2889bd6` (M23 P4B closure: correct the server battery count).
2. **Final tip** — the bookkeeping-closure commit that carries the corrected §175 (its hash is in the closure message); `24b9086` carried the unfilled draft, `280fc7c` the filled one; the P5-4 closure commit is `f080bfe`. The recovery bundle is recut at the final tip (see the closure section). Phase commits: `1e2c0c5` (P5-1 server), `66a14ea` (P5-2 clients), `2c55952` (P5-3 tests + D-P5-1/D-P5-2), `f080bfe` (P5-4 docs).
3. **Schema version** — 2304, unchanged. **P5 adds no migration.**
4. **New stores** — none. `db.roomDecisions` (M17) carries the formal rows; the draft is `kase.decisionDraft`. No `recruitmentDecisions`, `decisionDrafts` or `recruitmentOffers` (persistence §1, §5).
5. **Existing decision system reuse** — M17's `roomDecisions` chain (`supersedes`/`supersededById`), `REASON_CODES` taxonomy, `validateReasonCodes`, `captureSnapshot`, `roomCan`, `GET /decisions` reader, Second Look reader, Nobody Missed `room_decided`, M20 decision family, journey decision projection — all reused; the reuse audit classifies R1–R30.
6. **Decision model** — a formal row: `kind: 'formal'`, `state: 'final'`, `outcome`, mapped `recommendation`, `reasonCodes`, `note`, `by`, `createdAt`/`finalizedAt`, own `rev`, `evidenceRefs[]` (+ minimal `meta`), `assessmentSummary` (counts, ids), `snapshot`, `lifecycle`, `supersedes`/`supersededById`/`supersession`, `keys`, `draftId`, `policyVersion 1`.
7. **Decision outcomes** — `progress` (→ `offer`, `considerOffer`, `offer_consideration`), `hold` (→ `continue_watching`, `holdCase`, `on_hold`), `reject` (→ `archive`, `rejectCase` with lifecycle reason `rejected`, `archived`). Nothing maps to `offer_made` or `signed` (U5, P11).
8. **Draft semantics** — one per case, own rev, every field optional, labelled "Draft — not a formal decision", moves nothing, notifies nobody, not a milestone, not in the chain; `POST/PATCH/DELETE …/decision/draft` (J11–J15, X4).
9. **Finalization semantics** — draft required; content re-validated as final (outcome required; reject needs ≥ 1 reason); references re-resolved; row + lifecycle move in one save through the ONE validator and writer; rollback on lifecycle refusal (J18, D3).
10. **Supersession semantics** — a formal head must be named (`supersedes`, `supersedesRev`) with a non-empty reason ≤ 500; the earlier row is not edited (gains `supersededById`, rev → 2); `/supersede` refuses without a head (H2–H8, K9–K11).
11. **Case lifecycle integration** — never a direct status write; `canTransitionRecruitmentCase` with the real evidence provider → `ctx.applyLifecycleTransition`, trigger `decision:finalize:<id>`, history detail carries `lifecycleAction` and `decisionId`; "already there" records the decision and moves nothing (H13).
12. **`offer_consideration` evidence** — `STATUS_EVIDENCE_REQUIRED.offer_consideration = { kind: 'decision_progress' }`: a finalized, non-superseded formal progress row on this case/org/player. Advisory "offer", hold, draft, superseded, other case: refused (P15–P20, J7, H9). The ONE widening.
13. **Hold behavior** — `on_hold` through `holdCase`; no precondition added (a hold by hand remains possible, documented); `resumeCase` by hand leaves the formal hold current (H11); blocked families may be held (B4).
14. **Reject behavior** — ≥ 1 decision reason required (R2); `archived` through `rejectCase` with lifecycle reason `rejected`; the decision reasons are not written into the lifecycle history and the lifecycle reason not into the decision (R7); `reopenCase` by hand leaves the rejection current (R13).
15. **Second Look integration** — the formal rejection with a revisitable code is the row Second Look reads: new full-match evidence → one `direct_reason_resolved` item; Harbour sees none (R8–R11); `recruitment_room_archived` broadcast on terminal outcomes (R6). Engine unmodified.
16. **Nobody Missed integration** — a formal decision counts as `room_decided` (R12). Engine unmodified.
17. **Trial relationship** — a completed trial is a citable reference (`meta.workflowState`, `completedAt`) and a readiness count; it never gates or produces a decision (J6–J10, D1–D2).
18. **Assessment relationship** — submitted assessments are citable (draft ones refused), summarised per assessor and by verdict; the blind rule is kept and withheld counts are said (Q1–Q4); never averaged (U36, J8b).
19. **Multiple assessor behavior** — each assessor listed with verdict, rated/not-observed counts, confidence mix, reference count (U35, live A4d).
20. **Disagreement handling** — `disagreement: { kind: 'verdicts_differ' | 'unanimous', verdicts }`; the tab says "Assessors differ … Both views stand; neither is marked correct" (U37, live A4b).
21. **Box Cam relationship** — a session linked on one of this case's trials is citable by id with its verification state and observation *state*; never a result, never a recommendation (U23–U25, E1).
22. **Passport relationship** — a current (non-superseded) Passport record of this player is citable with claim type and provenance; superseded or another player's refused (U25, E1). The Passport shows nothing of the decision (I1).
23. **Trust Score relationship** — the M17 evidence-confidence snapshot is captured at finalize with its disclaimer; never read to produce an outcome (J20; sweep: 0 reads of `trust.score`/`.rating`/`.result` in the decision routes).
24. **Evidence references** — `{ kind ∈ assessment|trial|box_cam_session|passport_evidence, id }`, ≤ 50, deduped, resolved against this case only; `DECISION_CASE_MISMATCH` is the same body for "elsewhere" and "nowhere" (U19–U25, E1–E3).
25. **Provenance** — `by { userId, name, role }` from the authenticated user, `trigger: 'decision:finalize'`, `policyVersion`, `finalizedAt`; the snapshot carries `sourceRefs`.
26. **Decision reason taxonomy** — M17's 20 codes in 4 categories, ≤ 6 per decision, prohibited codes refused, lifecycle codes refused (U7–U13, X2, X11–X12).
27. **Permissions** — `roomCan`: view rank 0, draft/finalize rank 2; scout reads and is told; contributor cannot draft; foreign org 404; player/guardian tokens 401 (W1–W7).
28. **Reauthorization** — every route re-derives the room role from the authenticated user on the request; the blocked and subject-removed gates run on every draft edit and finalize, not once at draft creation (B3, C6, T2).
29. **Tenant isolation** — 404 on every route for another organisation; a foreign assessment cited is `CASE_MISMATCH`; Second Look and room lists do not enumerate (W4, E1b, I5, R11).
30. **Subject removal** — `DECISION_SUBJECT_REMOVED` on draft/edit/finalize; surface says `subjectRemoved: true`, `canDraft: false`; prior decisions stay on record (T1–T3, C6).
31. **Block behavior** — progress refused `403 DECISION_BLOCKED`; hold and reject recordable; the blocked player told nothing (B1–B6, live N14).
32. **Player/guardian privacy** — sentinels absent on 29 surfaces (player notifications/inbox/passport/opportunities/trials/export/shared, guardian notifications/inbox/export, org notifications, audit + export, outbox, push log, analytics, Second Look, Nobody Missed, foreign org rooms/Second Look, player and org SSE, journey) (I1–I5); live N10a–c.
33. **Events** — `room_decision_finalized`, `room_decision_superseded` (`org_private`, ids only), plus `recruitment_room_archived` on terminal outcomes (J21, R6).
34. **Notifications** — room owner and lead (not the actor) receive a `recruitment_room` notification with the outcome label; player and guardian receive nothing (J22–J23, B6).
35. **Outbox/email** — no email, no push about a decision (I3).
36. **Journey projection** — `decisions.formal`, `decisions.draft` (org only), `conditions.hasFormalDecision`, `conditions.decisionOutstanding`, milestones `decision_recorded`/`decision_superseded`, no note (J26, H10).
37. **Analytics** — M20 `decision_outcomes`: counts by outcome and superseded, no rate, no ranking, no player id, no note; scouts do not read it (N1–N4; D-P5-2).
38. **Idempotency** — payload-fingerprinted client keys on draft and finalize, scoped to the case; replay, conflict on different content, draft key replays the decision it became (K4–K8, J28, J31).
39. **Restart idempotency** — keys, draft, chain, revs and case stages survive SIGKILL and graceful stops; byte-faithful snapshots (Z1–Z7; persistence §2, §5).
40. **Concurrency** — finalize×2, same-key finalize×2, edit vs finalize, supersede×2, finalize vs close, finalize vs player deletion, finalize vs assessment review, hold vs progress, reject vs progress — one truth per case, no duplicate heads (C1–C8).
41. **Atomicity/failure injection** — `channel: 'decision'`: refused before anything is written; no row, no move, no audit, draft intact; retry succeeds as a new write (F1–F4).
42. **Rate limiting** — `decision_draft` 60/h org, `decision_finalize` 30/h org; another org unaffected (L1–L2).
43. **Error contract** — 19 `DECISION_*` codes, bands 400/403/404/409/500, all producible (m23E2E Y3), public fields `lifecycle`, `ref`, `supersedes` added; `M23_ERROR_CONTRACT.md` §7.
44. **Club UI** — Pro and Grassroots, inside the existing Decision tab: formal decision card, readiness with per-outcome availability, assessment summary with disagreement, draft form (fieldset radios, reason checkboxes, rationale, citations, supersession reason), finalize behind an explicit confirmation naming the internal decision, history; polite live region (live A3–A7, H, R, D).
45. **Mobile 390px** — no horizontal scroll; draft button and outcome controls inside the viewport (live N13, N13b, N13c); player app at 390 carries nothing (N10b, N13a).
46. **Mobile 360px** — no horizontal scroll (live N13d).
47. **EN/FR** — complete `dc.*` and confirm copy in both apps; FR tab renders with no English fallback; header "En pause" (live N16, N16b).
48. **Accessibility** — tab semantics (aria-selected/aria-controls), every draft control labelled, fieldset + legend, polite live region, keyboard (live N15–N15e).
49. **Adult progress live journey** — Kola: review → shortlist → two disagreeing assessments → draft → finalize → Offer consideration; player sees nothing; no auto-offer (live A1–A7i, N9b).
50. **Hold live journey** — replace the progress with a hold and a reason → On hold; history shows both (live H1–H2e).
51. **Reject live journey** — Mateus: reject without a reason refused, with a revisitable reason → Archived → Second Look item after new evidence (live R1–R3b).
52. **Non-Trial decision path** — Imani: no assessment, no trial, draft opens, hold recorded from Under review (live D1–D2b).
53. **Negative live paths** — N1–N16 as listed in the suite header (readiness, scout, foreign club, disabled finalize, reject without reason, second draft, stale rev, replace without reason, no offer button, sentinels, player token, lifecycle by hand, 390/360, blocked family, a11y, FR).
54. **Decision test totals** — `m23DecisionE2E` 435 (315 negative, 72 %; T4 added at bookkeeping closure); `m23DecisionPersistence` 48 (17 negative); `m23DecisionPerf` measured; `m23DecisionLive` 86 (25 negative). Prototype keys (§95) and invalid types (§96) covered in U6, U11, U12, U16, U19, U22, K1, X1–X8.
55. **Server regression totals** — 45 scripts, all exit 0 on the final tree (one owned :4000 server, sequential); the first battery run caught the Y11 shape widening, fixed in `f080bfe` and re-run green (table below).
56. **Browser/live/demo totals** — 37 browser scripts, all exit 0 on the final tree with demos rebuilt at `f080bfe`: navConfig 282, demoFreshness 13, uiSpotcheck, demoOffline, crosstab, demoHostOrdering, eleven demo spotchecks, liveIntegration, navLive 64, and seventeen live suites including `m23TrialLive` 122 (53 negative) and `m23DecisionLive` 86 (25 negative) (table below)..
57. **Typechecks** — club, grassroots, admin, player: 0 errors.
58. **Builds** — club, grassroots, admin (Vite) and player (Expo web export) build; demos rebuilt (`e2e/buildDemos.mjs`), freshness test green.
59. **Navigation regression** — `navConfig` and `navLive` green; no new nav item (live A1b).
60. **Performance** — surface p50 0.009/0.023/0.029 ms at 0/5/20 assessments; 50 references resolve in 0.045 ms p50; 100-row history 0.089 ms p50; +400 cases ratio 4.1× (linear in the store, once per collection); scan audit: no collection read more than twice per surface. No index added.
61. **New Critical found/fixed** — 0.
62. **New High found/fixed** — 0.
63. **New Medium found/fixed** — 2 / 2 (D-P5-1 snapshot seam; D-P5-2 M20 count always zero).
64. **Open Critical** — 0.
65. **Open High** — 0.
66. **Open Medium** — 0.
67. **Open Low** — 4 inherited (P4A-D6, D7, D8, D11), owner phases unchanged.
68. **Known limitations** — no precondition on `on_hold`/`archived` (a hold or archive by hand records no `decisionId`); the assessment summary caps `assessmentIds` at 20 in the row's snapshot; the notification to owner/lead uses the existing `recruitment_room` type rather than a decision-specific one; the demo store simulates the server's rules without the blind rule.
69. **Bundle path** — `/home/user/scoutbox-m23-p5-decision.bundle` (recut at the final tip at bookkeeping closure; the figures in items 70–72 are those of the `f080bfe` cut and are superseded by the closure message).
70. **Bundle SHA-256** — `46d3b29b1cdfc2cd3e535049c80d6b71801bd8cfd9998207035b1fc9910c6e59` (4080115 bytes; secret scan of the tracked tree at HEAD: 0 hits)..
71. **Bundle verify** — `git bundle verify`: "The bundle records a complete history." Fresh clone HEAD `f080bfe873d147a36bd00c25d965f983e3fabaf4` and tree `ae4e3c76110637af89da5d0f62c41f73f5f6281c` equal the workspace; control-byte sweep 0 files..
72. **Fresh clone result** — the clone boots on a fresh data directory (`schemaVersion 2304`, `X-ScoutBox-Schema: 2304`); 26 suites run from the clone all exit 0 (apiE2E 130, m23DecisionE2E, m23DecisionPersistence, m23DecisionPerf, m23TrialE2E, m23TrialPersistence, m23TrialPerf, m23P4AClosureE2E 337, m12E2E 152, m15E2E 189, m23ContactE2E, m23ContactPersistence, m23E2E, m23BootContract, m23Persistence 67, m17E2E, m18E2E, m20E2E, m182E2E, m22E2E 112, m22Blocker 60, m22Robustness 48); the clone tree is clean after the tests; club, grassroots and admin build from the clone; **`m23DecisionLive` runs from the clone: 86 checks passed (25 negative)**..
73. **Tree status** — clean at every commit; the `f080bfe` bundle predated the report commits and was replaced at bookkeeping closure by a bundle cut at the final tip (closure section)..
74. **Push status** — not pushed (the branch's remote tip stays `2889bd6`; local is 7 commits ahead after the bookkeeping closure).
75. **PR status** — none opened.
76. **Deployment status** — none.

## Server battery (final tree, one owned :4000 server, sequential)

| script | exit | summary |
|---|---|---|
| `testTrust` | 0 | 23 trust/safeguarding tests passed |
| `apiE2E` | 0 | 130 API checks passed |
| `connectedE2E` | 0 | 43 connected-mode checks passed |
| `m12E2E` | 0 | m12E2E: all 152 checks passed |
| `m13E2E` | 0 | m13E2E: all 212 checks passed |
| `m14E2E` | 0 | m14E2E: all 193 checks passed |
| `m141E2E` | 0 | M14.1 adversarial suite: 94 checks passed |
| `m15E2E` | 0 | M15 acceptance suite: 189 checks passed, 72 negative/abuse checks (38% of all checks) |
| `m16E2E` | 0 | M16 acceptance suite: 118 checks passed, 55 negative/abuse checks (47% of all checks) |
| `m161E2E` | 0 | all M16.1 checks passed |
| `m162E2E` | 0 | all M16.2 checks passed |
| `m17E2E` | 0 | all M17 checks passed |
| `m18E2E` | 0 | all M18 checks passed |
| `m181E2E` | 0 | all M18.1 checks passed |
| `m182E2E` | 0 | all M18.2 checks passed |
| `m19E2E` | 0 | all M19 checks passed |
| `m20E2E` | 0 | all M20 checks passed |
| `m21E2E` | 0 | all M21 checks passed |
| `m22E2E` | 0 | production Combine eligibility: NOT ELIGIBLE — real-world validation not completed |
| `m22Blocker` | 0 | production Combine eligibility: NOT ELIGIBLE — real-world validation not completed |
| `m23E2E` | 0 | all M23 P2 checks passed |
| `m23Persistence` | 0 | M23-D2 persistence suite: 67 checks passed, 20 negative/integrity checks (30%) |
| `m23BootContract` | 0 | all M23 boot-contract checks passed |
| `m23ContactE2E` | 0 | all M23 P3 Contact checks passed |
| `m23ContactPersistence` | 0 | all M23 P3 Contact persistence checks passed |
| `m23P4AClosureE2E` | 0 | M23 P4A closure suite: 337 checks passed, 210 negative/abuse checks (62%) |
| `m23TrialE2E` | 0 | all M23 P4B Trial checks passed |
| `m23TrialPersistence` | 0 | all M23 P4B Trial persistence checks passed |
| `m23TrialPerf` | 0 |  |
| `m23DecisionE2E` | 0 | all M23 P5 Decision checks passed |
| `m23DecisionPersistence` | 0 | all M23 P5 Decision persistence checks passed |
| `m23DecisionPerf` | 0 | → one sort and one integrity pass over the case's rows; the history page limit (100) bounds the payload. |
| `m22CvEval` | 0 | FT05_ball_passes_in_front            accepted                   count 0 |
| `m22Holdout` | 0 | HT03_second_ball_passes_close        protocol_violation         count 0 |
| `m22Robustness` | 0 | m22Robustness: all 48 checks passed |
| `m22Perf` | 0 |  |
| `m23Perf` | 0 |  |
| `m23ContactPerf` | 0 |  |
| `m17Perf` | 0 | Passport projection (same player, direct)  median 1.4 ms   p90 2.3 ms |
| `m18Perf` | 0 | matching the WHOLE brief costs 2.24× a single Passport assembly — the match runs on light facts, not assembled Passpo |
| `m181Perf` | 0 | noise. Worth revisiting if Passports of that size become common; today the |
| `m182Perf` | 0 |  |
| `m19Perf` | 0 |  |
| `m20Perf` | 0 | opposite of what the one-pass design was optimised for. It has been left alone rather |
| `m21Perf` | 0 |  |

## Browser battery (final tree, demos rebuilt first)

| suite | exit | summary |
|---|---|---|
| `navConfig` | 0 | navConfig: 282 checks passed |
| `demoFreshness` | 0 | demoFreshness: 13 checks passed |
| `uiSpotcheck` | 0 | UI SPOTCHECK OK |
| `demoOffline` | 0 | DEMO BUILDS OK |
| `crosstab` | 0 | CROSS-TAB E2E OK |
| `demoHostOrdering` | 0 | demoHostOrdering: all 15 checks passed |
| `m12DemoSpotcheck` | 0 | M12 DEMO SPOTCHECK OK — zero page errors |
| `m13DemoSpotcheck` | 0 | M13 DEMO SPOTCHECK OK — zero page errors |
| `m14DemoSpotcheck` | 0 |  |
| `m162DemoSpotcheck` | 0 | m162DemoSpotcheck: 21 checks passed — Trust Score demo story OK, zero page errors |
| `m17DemoSpotcheck` | 0 | m17DemoSpotcheck: 47 checks passed — Recruitment Rooms demo story OK, zero page errors |
| `m18DemoSpotcheck` | 0 | M18 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m181DemoSpotcheck` | 0 | M18.1 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m182DemoSpotcheck` | 0 | M18.2 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m19DemoSpotcheck` | 0 | M19 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m20DemoSpotcheck` | 0 | M20 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `m21DemoSpotcheck` | 0 | M21 headless spotcheck: ALL CHECKS PASSED — zero page errors |
| `liveIntegration` | 0 | LIVE INTEGRATION OK — separate contexts, one backend, no demo bus |
| `navLive` | 0 | navLive: 64 checks passed — N1–N17 complete |
| `m12Live` | 0 | M12 LIVE INTEGRATION OK — real backend, separate contexts |
| `m13Live` | 0 | M13 LIVE INTEGRATION OK — real backend, four separate contexts |
| `m14Live` | 0 | m14Live: L1–L7 all passed (separate contexts, live backend) |
| `m15Live` | 0 | m15Live: 21 checks passed — P1–P8 + T&S complete |
| `m16Live` | 0 | m16Live: 10 checks passed — Box Cam cross-app journey complete |
| `m162Live` | 0 | m162Live: 11 checks passed — Trust Profile journeys complete |
| `m17Live` | 0 | m17Live: 25 checks passed — Recruitment Room journeys complete |
| `m18Live` | 0 | m18Live: 60 checks passed — Second Look and Nobody Missed journeys complete |
| `m181Live` | 0 | M18.1 live browser journeys: 37 checks passed (H1–H10) |
| `m182Live` | 0 | M18.2 live browser journeys: 37 checks passed (J1–J10) |
| `m19Live` | 0 | M19 live journeys: 17 checks passed |
| `m20Live` | 0 | M20 live journeys: 59 checks passed |
| `m21Live` | 0 | M21 live journeys: 68 checks passed |
| `m22Live` | 0 | production Combine eligibility: NOT ELIGIBLE — real-world validation not completed |
| `m23Live` | 0 | m23Live: 39 checks passed — P2 sweep corrections verified end to end |
| `m23ContactLive` | 0 | M23 P3 CONTACT LIVE: 82 checks passed (33 negative, 40%) |
| `m23TrialLive` | 0 | M23 P4B TRIAL LIVE: 122 checks passed (53 negative, 43%) |
| `m23DecisionLive` | 0 | M23 P5 DECISION LIVE: 86 checks passed (25 negative, 29%) |

## Adversarial sweep (§160) and no-auto-offer search (§161)

| check | method | result |
|---|---|---|
| direct lifecycle writes in P5 code | `grep "room\.status\s*=\|\.status\s*=\s*'"` over `m23/decision.mjs`, `m23/decisionRoutes.mjs` | 0 |
| decision writers | `db.roomDecisions.push` only in `finalizeHandler` (+ M17's own route) | 1 P5 site |
| reason taxonomy | lifecycle codes, prohibited codes, prototype keys refused (U9–U11, X2, X11) | refused |
| private data projection | sentinels on 29 surfaces; audit safe-detail keys; event payload ids only | clean |
| evidence cross-org refs | U25, E1, E1b | `CASE_MISMATCH` |
| races | C1–C8 | one truth per case |
| final-decision editing | no route edits a formal row; supersession only (H8b) | none |
| auto-Offer | `recruitmentOffers` writers in server code (excluding scripts) | 0 |
| moves to `offer_made` outside the lifecycle tables | grep over server code | 0 |
| offer terms / offer notification in P5 files | grep | 0 |
| player/guardian notification in P5 routes | grep `kind: 'player'\|'guardian'` | 0 |
| rating / trust / Box Cam result / attendance read to produce an outcome | grep in decision routes | 0 |
| `m23E2E` drift guard (every `DECISION_*` code producible) | Y3 | green |

## §175 Final truth audit (the mandate's block, verbatim, with the executed evidence)

Bookkeeping closure note: the first two report commits (`24b9086`, `280fc7c`)
reproduced only the first nineteen lines of this block — the negative safety
assertions of its first three groups — and my closing message described it as
"every line answers NO". The mandate's §175 has sixty-four assertion lines
in both polarities (31 negative safety assertions, 33 positive proof
assertions), three counts and three closing NOs. The full block is
below; every value is answered from executed evidence (suite ids refer to
`m23DecisionE2E` unless prefixed `live` = `m23DecisionLive`, `persistence` =
`m23DecisionPersistence`). One line — the removed player's PII — had no
dedicated assertion before this closure; T4 was added to the suite and run
(435 checks, 315 negative, all green) rather than answered from inspection.

Evidence automatically creates recruitment decision: NO — J10 (a completed trial and two assessments, still `current: null`), D1–D2 (a decision with nothing cited); the only writer is `finalizeHandler` on a human's draft.
Assessment automatically creates recruitment decision: NO — J10; the assessment routes (`m12/scouting.mjs`) are untouched and write no decision.
Trial completion automatically creates recruitment decision: NO — J6/J10; P4B completion writes a trial and a case move, never a decision row.
Box Cam observation automatically creates recruitment decision: NO — U23–U25; a session is a citable reference with a state, nothing reads its result.
Trust Score automatically creates recruitment decision: NO — J20; the snapshot is captured *after* the human's outcome is typed and carries M17's disclaimer.
Assessment disagreement is collapsed into one universal score: NO — U35–U37, J8b, live A4b/A4c; counts and a named disagreement, never an average.
Decision creates universal player score: NO — no score field exists on the row or any view; M20 counts decisions, not players (N3).

Decision draft moves case lifecycle: NO — J12 (draft, case unchanged), persistence §5 (draft on the case, status unchanged).
Decision draft notifies player/guardian: NO — J13.
Final internal decision automatically notifies player/guardian: NO — J22, B6, I1–I3, live N10a–c.
Final decision automatically creates Offer: NO — §161 search (0 offer writers), J30 (`sendOffer` refused for lack of `offer_sent`).
Final decision automatically creates signing: NO — U5 (no outcome reaches `signed`); `signed` keeps its own precondition (P11).
Positive decision moves directly to offer_made: NO — J18/J30: progress lands at `offer_consideration` and `offer_made` is unreachable; live N9b.

Private decision rationale leaks to player: NO — I1 (player notifications, inbox, passport, opportunities, trials, export, shared records, SSE), live N10b/N10c.
Private decision rationale leaks to guardian: NO — I1 (guardian notifications, inbox, export).
Private assessment leaks through decision projection: NO — U36, J19b, Q4, I1 (`PRIVATE_ASSESSMENT_SENTINEL_3407` on every surface including the surface itself).
Private Room discussion leaks through decision projection: NO — I1 (`PRIVATE_ROOM_RATIONALE_SENTINEL_8812`, recorded as an advisory note, absent from every non-room surface).
Decision event leaks rationale text: NO — J21b (the SSE frame carries ids only), I4b (audit detail never carries the note).
Foreign org can enumerate decision: NO — W4 (404 on every route), I5, R11.
Removed player PII is resurrected by decision history: NO — T4 (added at closure: after the account deletion the decision surface, history, journey and org notifications carry no trace of the player's name), T1–T3; `decisionView` has no player field and `kase.playerName` is nulled by `deletePlayerData`.

Lifecycle direct-write bypass introduced: NO — §160 sweep (0 `status =` writes in `m23/decision.mjs` and `m23/decisionRoutes.mjs`); the route calls `ctx.applyLifecycleTransition` only, after `canTransitionRecruitmentCase`; D3/D3b rollback; `m23/lifecycle.mjs` has no diff since `2889bd6`.
M23 lifecycle widened: NO — P13 (no invented state), P13b (the transition table covers exactly the existing statuses); the only diff to `m17/shared.mjs` since `2889bd6` is one *precondition* entry (`offer_consideration` now requires a finalized progress decision — a narrowing of what may reach it) and three `roomCan` ranks. No status, no edge.
M17 reason taxonomy confused with lifecycle reason taxonomy: NO — U9 (lifecycle codes refused as decision reasons), R3 (`rejected` refused on a draft), R7/R7b/R7c (the case history carries `rejected`, the decision carries the decision codes, neither carries the other's).
Final decision can be silently edited in place: NO — H8b (the superseded row keeps its outcome and note; only `supersededById` and `rev` change); there is no PATCH/PUT route for a formal row (0 in `decisionRoutes.mjs`); supersession needs a named head, its rev and a reason (H2–H6).
Stale rev silently overwrites decision: NO — J17, K1 (twelve non-integer forms refused), K2–K3, H5 (`supersedesRev` mismatch is a conflict), persistence §2 (rev enforced from the snapshot).
Same idempotency key accepts different decision payload: NO — K5 (draft), K8 (finalize), persistence §2 (restored keys with mismatched fingerprints are conflicts).
Duplicate finalize creates duplicate formal decision: NO — C1 (two finalizes, different keys: one decision), C2 (same key: one decision, one replay), J28/J29, C4 (two supersedes: one successor, no duplicate heads).
Finalization can partially persist before lifecycle failure: NO — D3b (validator refusal: no row, no move, draft intact), F2–F3b (injected transport failure: no row, head untouched, draft intact, case unmoved, no audit entry); one `persistNow()` after the move.
Positive decision creates recruitmentOffers row: NO — persistence §5 (no new top-level store after a progress decision), §161 (0 writers of `recruitmentOffers` in server code).
Offer Workflow implemented: NO — §161 (0 offer writers, 0 moves to `offer_made` outside the lifecycle tables, 0 offer terms or notifications in P5 files), J30, live N9/N9b.
Signing invariant weakened: NO — P11 (`signed` still requires `confirmed_join`; `offer_made` still requires `offer_sent`), U5; `m23/lifecycle.mjs` unchanged; `m23E2E` 382 green (P2's signed-evidence hardening checks included).

Assessments remain independent: YES — U35/U36 (per-assessor rows, no average), Q1–Q3 (the blind rule kept, withheld counts said), live A4d.
Assessment disagreement remains visible: YES — U37, J8, live A4b ("Assessors differ … neither is marked correct").
Box Cam remains evidence only: YES — U23–U25 (state-level metadata, no result), E1 (`rating` and `trust_score` reference kinds refused), candidates carry `observation.state` only.
CV refusal remains neutral: YES — `m22/*` has no diff since `2889bd6`; `m22E2E` 112, `m22Blocker` 60, `m22Robustness` 48, `m22CvEval`, `m22Holdout`, `m22Perf`, `m22Live` green in the batteries; P5 passes P4B's neutral `observationCopy` through unchanged and `m23TrialE2E` (refusal-copy group E) is green.
Trial remains separate from decision: YES — J6/J7 (completion moves the case, not the decision), J10, D1–D2 (a decision with no trial).
Formal decision is explicit human action: YES — the outcome is typed on the request (U6: nothing else is an outcome); the only writer is `finalizeHandler` on the lead's draft (J18); live A7 (finalize behind an explicit confirmation).
Progress-to-offer-consideration path works: YES — J18/J18b, D2, live A7–A7i.
Hold path works: YES — H7, D4, B4, live H2–H2e, live D2.
Reject path works: YES — R5/R5b, live R2/R2b.
Second Look integration works where applicable: YES — R8–R11, live R3.
Non-Trial decision path works where supported: YES — D1–D4, live D1–D2b.
Decision privacy proven: YES — I1 (three sentinels × 29 surfaces), I2–I5, live N10a–c, N11.
Idempotency proven: YES — K4–K8, J28, J31, F4.
Restart idempotency proven: YES — Z1–Z7, persistence §2 and §5 (SIGKILL and graceful stops, keys replay after reboot).
Concurrency proven: YES — C1–C8b.
Atomicity/failure injection proven: YES — F1–F4, D3b.
EN/FR complete: YES — `dc.*` key sets identical between EN and FR in both club apps (96 = 96); live N16/N16b (French tab, no English fallback).
390px flow passes: YES — live N13, N13b, N13c (club) and N13a (player).
360px flow passes: YES — live N13d.
Accessibility checks pass: YES — live N15–N15e (tab semantics, every control labelled, fieldset/legend, live region, keyboard).
All typechecks green: YES — club, grassroots, admin, player: 0 errors on the final tree; re-run from the fresh clone at closure (see the closure section).
All required builds green: YES — club, grassroots, admin (Vite) and player (Expo web) on the tree; club, grassroots, admin from the fresh clone.
Full server regression green: YES — 45/45 scripts exit 0 on the final tree (table above).
Full browser/live/demo regression green: YES — 37/37 scripts exit 0 with demos rebuilt (table above).
P2.5 navigation regression green: YES — `navConfig` 282, `navLive` 64.
P3 Contact regression green: YES — `m23ContactE2E`, `m23ContactPersistence`, `m23ContactPerf`, `m23ContactLive`.
P4A closure regression green: YES — `m23P4AClosureE2E` 337 (210 negative).
P4B Trial regression green: YES — `m23TrialE2E`, `m23TrialPersistence`, `m23TrialPerf`, `m23TrialLive` 122.
M17 regression green: YES — `m17E2E`, `m17Perf`, `m17Live`, `m17DemoSpotcheck`.
M18 regression green: YES — `m18E2E`, `m181E2E`, `m182E2E`, their perf scripts, `m18Live`, `m181Live`, `m182Live`, the three demo spotchecks.
M20 regression green: YES — `m20E2E` 265, `m20Perf`, `m20Live` 59, `m20DemoSpotcheck`.
M22 regression green: YES — `m22E2E` 112, `m22Blocker` 60, `m22Robustness` 48, `m22CvEval`, `m22Holdout`, `m22Perf`, `m22Live`.
Recovery bundle verifies: YES — see the closure section (recut at the final tip).
Fresh clone passes P5 core tests: YES — see the closure section.
Tree clean: YES — `git status --short` empty after the closure commit.

Open Critical defects: 0
Open High defects: 0
Open reasonably-fixable Medium defects: 0

P5.5 artwork redesign begun: NO
PR created: NO
Deployment performed: NO

## §176 (verbatim)

M23 P5 ASSESSMENT + RECRUITMENT DECISION INTEGRATION COMPLETE
EVIDENCE, ASSESSMENT, DISCUSSION AND FORMAL DECISION REMAIN DISTINCT
FORMAL RECRUITMENT DECISIONS ARE EXPLICIT, AUDITABLE AND EVIDENCE-REFERENCED
PLAYER/GUARDIAN PRIVACY IS PRESERVED
POSITIVE DECISIONS STOP AT OFFER CONSIDERATION
NO OFFER WORKFLOW HAS BEEN IMPLEMENTED
ZERO KNOWN CRITICAL DEFECTS
ZERO KNOWN HIGH DEFECTS
ZERO KNOWN REASONABLY-FIXABLE MEDIUM DEFECTS
P5 FROZEN AND RECOVERABLE
READY FOR M23 P5.5 SCOUTBOX VISUAL SYSTEM

## Final bookkeeping closure

- **Final P5 tip** — the commit that carries this section (its hash is in the
  closure message and in the bundle log; a commit cannot contain its own
  hash). Report history: `24b9086` (unfilled draft), `280fc7c` (filled),
  then this closure commit, which corrects §175 to the full block, restores
  the verbatim §176, adds T4 to `m23DecisionE2E` and this section.
- **Truth audit** — reviewed line by line against source, suites, the
  adversarial sweep and both batteries; polarity as the mandate defines it:
  31 negative safety assertions NO, 33 positive proof assertions YES, counts
  0/0/0, three closing NOs — the set diffed line-for-line against the
  mandate's block (70 = 70). No production source changed in this closure; one
  test assertion (T4) was added.
- **Recovery bundle** — recut at the final tip after this commit, replacing
  the `f080bfe` bundle; its SHA-256, size, verify result and the fresh-clone
  results (HEAD/tree equality, schema boot, the P5 suites, the regression
  suites, four typechecks, builds, the P5 live journey from the clone) are
  in the closure message and in the scratch log
  `scratchpad/m23/bundle-p5-final.log`, because the tip that is hashed
  cannot carry the hash.
- **Open defects** — Critical 0, High 0, Medium 0, Low 4 inherited P4A items
  (D6, D7, D8, D11), none touching visual-system migration, navigation,
  shared component architecture, accessibility foundations or localisation
  infrastructure.
- **P5.5 readiness** — P5 frozen; P5.5 (visual system) not begun; Offer
  Workflow not begun; `recruitmentOffers` not implemented; nothing pushed,
  no PR, no deployment.
