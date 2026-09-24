# M23 P8 — Full recruitment journey integration: release readiness

The §93 gate, item by item, with the evidence behind each line. "Green"
means the harness printed zero failures at the tip named in
M23_P8_TEST_REPORT.md (functional code last changed in R5 `3cf34b9`; the
browser battery, the clean boot and the fresh clone ran at R6 `6d366c1`,
which changed two test files).

## 1. The gate

| Requirement | State | Evidence |
| --- | --- | --- |
| Open Critical | 0 | M23_P8_DEFECT_REGISTER.md — none found |
| Open High | 0 | D-P8-1 (the self-service contract route) and D-P8-2 (the legacy recording route) fixed R1 |
| Open reasonably-fixable Medium | 0 | D-P8-3 … D-P8-12, D-P8-15, D-P8-16 fixed R1–R5 |
| Open security / privacy / authorization / data-integrity Low needing repair | 0 | D-P8-13, D-P8-14 fixed R1 / R4 |
| Known P8 flakes | 0 | every lane first-run green at its tip (test report §12) |
| The full journey passes | yes | journey E2E B (25 steps, 44 checks), persistence 1 (nine checkpoints), live A (34 checks) |
| No frozen boundary weakened | yes | journey E2E Z1–Z16, C1–C12; the P3–P7 batteries unchanged and green |
| All platform regressions green | yes | server battery 46 / 46, apiE2E 130 / 130, browser battery 20 / 20 on bundles built from the tip (two P5.6 suites needed a test-side fix each, T-P8-11 / T-P8-12) |
| The §89 gate: "Independent Player route can set authoritative `under_contract`" | **NO** | journey E2E H6–H9, Z3–Z4; hardening P2–P4b; the player app offers no such word |
| The §90 gate: each funnel stage derives from a canonical store / lifecycle / event | yes | journey E2E I1–I11; M23_P8_ANALYTICS_CANONICALIZATION.md |

## 2. The mandate's conditions, each with its proof

| Condition | Proof |
| --- | --- |
| ONE server-derived journey projection; no new store; schema 2308 (§6, §82, §83) | journey E2E Z8–Z10; persistence 4; `SCHEMA_VERSION = 2308`, 18 migrations (clean boot, fresh clone) |
| The next action is derived on the server and never manufactured by a client (§7, §8) | journey E2E A (24 codes), Z16; live A (the strip renders `nextAction` only) |
| Discovery, Matching, Trust Score and Box Cam never advance a case (§38–§41) | journey E2E C1–C2, Z6–Z7 and the source scan (A22: no `trustScore` / `matchScore` / `watchlist` / `boxCam` / `cv` in the journey or lifecycle modules) |
| A draft or failed Contact is not `contacted`; a requested Trial is not scheduled; scheduled is not completed; completed is not an assessment; an assessment is not a decision (§20–§22, §62) | journey E2E B7, B13, B15, B18, B20 (#3, #5–#8) and C1 (#4) |
| A `progress` decision creates no Offer; issue is not acceptance; acceptance creates no signing; a started signing is not `signed`; a partial signing is not `signed` (§23–§25, §62) | journey E2E B22, B25, B28, B30, B34 (#9–#13), Z6–Z7 |
| Only canonical evidence supports each evidence-bearing state; legacy cases fabricate nothing (§9, §11, §64) | journey E2E D1–D12; persistence 3; `signingSupports` (A37–A38, Z12); M23_P8_LEGACY_JOURNEY_COMPATIBILITY.md |
| The canonical completed contract owns `under_contract`; the self-service route cannot set it or overwrite it (§26, §89) | journey E2E H6–H9, Z3–Z4; M23_P8_CONTRACT_STATUS_WRITER_AUDIT.md |
| One lifecycle writer; the legacy status route, the reopen bridge and the recording route cannot bypass it (§5) | journey E2E H1–H5, H10–H13, Z1–Z2, Z13; M23_P8_LIFECYCLE_WRITER_AUDIT.md |
| Partial failure never half-moves a case (§81) | journey E2E Q1–Q3, Z11; M17 `lifecycleSnapshot` / `restoreLifecycle` |
| The player sees only Contact, Trial, Offer, Signing and the outcome; never watchlist, priority, Room, assessment, rationale (§16, §58) | journey E2E B9–B10, C8–C10, F; live P1–P6; M23_P8_JOURNEY_TIMELINE_PRIVACY_MATRIX.md |
| The agent sees a narrower, factual projection only while authorized; the same-agency colleague and the agency admin see nothing (§17, §47, §59) | journey E2E F1–F8, C12; live G1–G7; M23_P8_JOURNEY_AUTH_MATRIX.md |
| Minors: no new agent / Offer / signing pathway (§48) | journey E2E C7–C9 (#20) |
| Cross-case and cross-tenant references are refused or concealed equivalently (§51, §52) | journey E2E C4–C6 (#18, #51, #52), F8 |
| Current-resource selection is deterministic; an expired package cannot mask a live one; a superseded Offer cannot become current (§53, §54) | journey E2E A5–A12, G5–G8, Z14–Z15, D10–D12; M23_P8_CURRENT_RESOURCE_SELECTION.md |
| Notifications and deep links resolve to the current authorized resource; stale ones reauthorize, redirect or conceal (§29–§31, §69, §70) | journey E2E G1–G8 (#53); live D1–D9, E1–E2, P4–P5; M23_P8_NOTIFICATION_DEEPLINK_AUDIT.md |
| The club moves through the whole journey without a dead end or a URL edit; conflicts refresh; role loss revokes the control (§50, §55, §56, §67) | live A, B, C, D8–D9 |
| Analytics derive from canonical truth; retries never double-count; time-to-stage from canonical instants (§42–§45, §90) | journey E2E I1–I11 (#43–#45, #90); M23_P8_ANALYTICS_CANONICALIZATION.md; m20E2E 266 |
| Blocks stop the flow and erase nothing (§49) | journey E2E C1, A21; M23_P8_JOURNEY_BLOCK_MATRIX.md; the P3 / P4 / P6 / P7 block groups |
| "Built by Guni & Younes" preserved on every entry surface (§60) | entryCredit 31 (five apps, six widths); demoFreshness 21 (the credit in each demo bundle); the credit commit `c559fb7` untouched |
| EN / FR parity, accessibility, perf (§77–§79) | test report §7–§9 |
| Clean boot / replay, fresh clone (§84, §85) | test report §10–§11 |

## 3. What is delivered

- `m23/journeyModel.mjs`: the pure model — 13 journey stages, the ten
  pipeline stages, `canonicalStageFor`, `completedStagesFor`, the four
  current-resource selectors, 24 next-action codes with `nextActionFor` and
  the player's `playerNextActionFor` / `playerStageFor`,
  `validateRecruitmentJourney` (canonical / legacy / partially_canonical /
  integrity_error), the timeline visibility table.
- `m23/journey.mjs`: the projector — the `journey` block on the club's
  Room journey; Offer and signing timeline entries; the player's, the
  guardian's and the agent's projections.
- `m23/journeyRoutes.mjs`: `GET /player/journeys`,
  `GET /guardian/children/:id/journeys`,
  `GET /org/agent/clients/:id/journey`, and `notificationTargetFor`, which
  decorates every notification with a server-resolved `target` at read time.
- Authority fixes: the self-service contract route refuses `under_contract`
  and locks the word while a canonical contract stands; the legacy
  recording route is clubs-and-leads only; the legacy status route carries
  the lifecycle actions' roles; the Second Look bridge reopens closed-out
  rooms only; squad release never erases another club's contract; the
  signing rollback restores the case whole; `signingSupports` names the
  case and the opening.
- Events: `recruitment_case_moved`, `assessment_submitted` (registry,
  `EMITTED_EVENTS`, both org-private).
- Clients: the Journey strip, next action, tab deep links, timeline,
  conflict sentence and refresh-on-focus in the Club and Grassroots Rooms
  (the Grassroots Room gains its Signing tab); the player's journey line
  and tappable notifications; the agent's factual client line; EN and FR.
- Analytics: `journey_evidence_funnel` and its panel.
- Suites: journey E2E 168, journey persistence 85, journey live 85, entry
  credit 31, journey perf; demo freshness carries the credit check.
- Sixteen documents (M23_P8_*.md).

## 4. What is deliberately not delivered (stated, not hidden)

- No redesign (§91, M24 owns it): the Room's tabs, the sidebar and the
  screens keep their P3–P7 layout; the strip is one section at the head.
- No new lifecycle state, no `awaiting_*` state, no store, no migration
  (§8, §82, §83).
- No universal player ranking anywhere (§44, I9).
- A contract's `endDate` never flips `under_contract` back on its own
  (N-P8-2; the P7.1 open question stays a product decision).
- The M20 `trial_process` and `overdue_trial_reports` metrics keep their
  pre-P8 filter semantics (N-P8-3).
- The platform's login-typed role model is unchanged (N-P8-4).
- P8.1 (adversarial hardening of the whole lifecycle) is not begun (§92).

## 5. Operational notes

- The self-service contract route now answers 403
  `CONTRACT_STATUS_NOT_SELF_DECLARABLE` for `under_contract` and 409
  `CONTRACT_STATUS_CANONICAL` for any word while a canonical live contract
  stands; a legacy `under_contract` set by the old route stays as stored.
- The legacy recording route answers 403 `SIGNING_NOT_PERMITTED` to an
  agency and 403 `LEAD_REQUIRED` to a non-lead.
- The legacy status route refuses `signed` to a room lead (the
  `confirmSignedOutcome` role rule); `POST /org/rooms/:id/reopen` answers
  409 `ROOM_NOT_REOPENABLE` on a live room.
- Two new org-private events on the stream; notification rows gain a
  read-time `target` (no stored field).
- The journey projection of a case reads that case's Trials only
  (D-P8-16): a legacy trial with no `caseId` no longer counts as a
  canonical trial stage (the evidence gate never counted it).

## 6. Verdict

**READY.** Every line of the §93 gate holds at the tip: 0 open Critical, 0
open High, 0 open reasonably-fixable Medium, 0 open security / privacy /
authorization / data-integrity Low needing repair, 0 known P8 flakes; the
full journey passes in the three P8 suites and in the fresh clone; no
frozen boundary was weakened (the P3–P7 batteries are unchanged and green);
the §89 line reads NO and the §90 line reads yes. Not pushed, no pull
request, not deployed; P8.1 is not begun.
