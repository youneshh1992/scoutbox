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
2. **Final tip** — the follow-up commit that carries this report; the closure commit is `f080bfe` (P5-4). Phase commits: `1e2c0c5` (P5-1 server), `66a14ea` (P5-2 clients), `2c55952` (P5-3 tests + D-P5-1/D-P5-2), `f080bfe` (P5-4 docs).
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
54. **Decision test totals** — `m23DecisionE2E` 434 (314 negative, 72 %); `m23DecisionPersistence` 48 (17 negative); `m23DecisionPerf` measured; `m23DecisionLive` 86 (25 negative). Prototype keys (§95) and invalid types (§96) covered in U6, U11, U12, U16, U19, U22, K1, X1–X8.
55. **Server regression totals** — 45 scripts, all exit 0 on the final tree (one owned :4000 server, sequential); the first battery run caught the Y11 shape widening, fixed in `f080bfe` and re-run green (table below).
56. **Browser/live/demo totals** — SEE_BROWSER.
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
69. **Bundle path** — `/home/user/scoutbox-m23-p5-decision.bundle`.
70. **Bundle SHA-256** — SEE_SHA.
71. **Bundle verify** — SEE_VERIFY.
72. **Fresh clone result** — SEE_CLONE.
73. **Tree status** — SEE_TREE.
74. **Push status** — not pushed (the branch's remote tip stays `2889bd6`; local is SEE_AHEAD commits ahead).
75. **PR status** — none opened.
76. **Deployment status** — none.

## Server battery (final tree, one owned :4000 server, sequential)

SEE_SERVER_TABLE

## Browser battery (final tree, demos rebuilt first)

SEE_BROWSER_TABLE

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

## §175 Final truth audit (verbatim, with the executed evidence)

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

## §176

SEE_SUCCESS
