# M23 P4B — Trial Workflow: Final Report

Mandate: M23 P4B — Trial Workflow (§1–§226). Scope delivered: invitation →
acceptance → scheduling → attendance → completion → Box Cam evidence by
reference → human assessment in Trial context, on the existing lifecycle,
the existing Inbox, the existing assessment system and the existing Box Cam
stores. Not delivered by design: Offer Workflow (§221), any Box Cam
capability change (§222).

Companion documents: `M23_P4B_TRIAL_IMPLEMENTATION.md`,
`M23_P4B_TRIAL_CONTRACT.md`, `M23_P4B_DEFECT_REGISTER.md`,
`M23_P4A_TRIAL_TEST_PLAN.md` (updated), `M23_TERMINOLOGY.md` (D-30),
`M20_METRICS.md` (F4 `trial_process`).

## The 89 items (§223)

1. **Starting tip** — `2d520a8` (M23 P4A closure: apiE2E persistence check honours DATA_DIR).
2. **Final tip** — the follow-up commit that carries this report (its hash is in the closure message, as in P4A); the closure commit is `3d9883d`.
3. **Schema version** — 2304 (`m230_005_trial_workflow`, additive containers on `db.trials`).
4. **New durable stores** — none. `db.trials` extended; `db.requests` rows of type `trial` gain `caseId`, `trialId`, `recipient`, `keys`, `trialDetails.slots`, `trialDetails.private`.
5. **Trial model changes** — `workflowState`, `caseId`, `schedule` (revisions, sessions), `attendance[]`, `completion`, `keys`, `rev`, `history[]`, `reminders`; `status` (report obligation) untouched.
6. **Legacy Trial compatibility** — pre-P4B rows read as `legacy_accepted` with `schedule: null`; nothing backfilled from `proposedDate`; the whole-day ICS path kept; all M12/M15/M18/M20 readers answer as before (their suites green); a legacy row enters the workflow when a schedule is first proposed.
7. **Trial operational state model** — `legacy_accepted | accepted | scheduled | completed | cancelled`, derived by `deriveWorkflowState()` from the stored facts and re-derived by the evidence provider; `completed`/`cancelled` final.
8. **Case lifecycle integration** — never a direct status write; `advanceCase()` → `canTransitionRecruitmentCase` (real evidence provider) → `applyLifecycleTransition`, in the same save as the trial fact; `planTrial` at invitation, `confirmTrial` at acceptance/confirmation, `completeTrial` at completion; cancellation and decline never move the case.
9. **`trial_requested` evidence** — `trial_invited`: a pending or accepted `db.requests` row of type `trial` for this case, issued through `issueRecruitmentRequest`; declined/suspended/legacy rows prove nothing (`m17/shared.mjs` EVIDENCE_REQUIRED, `m23/evidence.mjs`).
10. **`trial_scheduled` evidence** — `trial_confirmed`: a structurally sound trial for this case whose derived state is `scheduled`, with `confirmedAt` and ≥ 1 session. `legacy_accepted` never satisfies it.
11. **`trial_completed` evidence** — `trial_completed`: `completion.state === 'completed'` and derived state `completed`; a filed report is not completion; a tombstoned trial still answers.
12. **Adult invitation flow** — club (room lead+) → `POST /org/rooms/:id/trials` (zone, venue, 1–3 slots on distinct days, message, private address/instructions) → case `trial_requested` → player Inbox with slot chips (name/town only) → accept a slot → trial `scheduled` + confirmed → case `trial_scheduled` → attendance → completion → `trial_completed`. Live A1–A12; server J group.
13. **Minor/guardian invitation flow** — `resolveContactRecipient` reused: the verified, designated guardian is the recipient for every step; the child's Inbox shows the guardian-managed line, the child's `/player/trials` the five-field outcome line, the child receives no `trial_day` notification. Live M2–M8; server M0–M17b.
14. **Missing guardian behavior** — `422 TRIAL_GUARDIAN_REQUIRED` at invitation, acceptance (`trialAcceptGate`), schedule/reschedule/link; nothing written, never a fallback to the child; cancel still allowed (M6, M14, M17, live N4).
15. **Agency/minor result** — the standing wall (`visibleToOrg`): no room or `UNDER_18_WALL`; an agency may invite an adult (W1, W3).
16. **Verified-club minor result** — unverified club refused (W2); verification checked at every mutation through the same recipient resolution.
17. **Block behavior** — D-16: while blocked every club action is `403 TRIAL_BLOCKED` except cancel (a safety notice, family notified); the family cannot confirm with a blocked club (also for a no-op replay) but may cancel; the mandatory report may be filed with player/guardian notification suppressed; the candidates list is empty and names the block (B1–B11, live N5, sweep).
18. **Age transition behavior** — the recipient is re-derived on every action (`recipientTrial`, `reauth`, `trialAcceptGate`): a player who became an adult is told the trial is now theirs (`TRIAL_RECIPIENT_UNAVAILABLE` to the guardian, "This player now manages their own trials"); the guardian's earlier acceptance stays in history. Proved through guardian-route loss and restoration (M6, M7, M14, M14b); a clock-stepped birthday check is **not** a dedicated test (recorded in the contract §0).
19. **Acceptance semantics** — through the existing respond routes and the single trial writer `issueAcceptedTrial`; the gate re-derives the recipient and refuses the injected transport failure before anything is written; a concrete chosen slot creates the trial `scheduled` and confirmed (revision 1); the case advances in the same save (P4A-D15 holds).
20. **Decline semantics** — invitation declined: request `declined`, club notified, case unchanged, deterministic cooldown before a new invitation (`429 TRIAL_INVITE_COOLDOWN`, `retryAt`). Schedule declined: revision marked `declinedAt`, trial back to `accepted`, club proposes again or cancels.
21. **Scheduling model** — revisions of 1–20 sessions (15 min–12 h, non-overlapping, stable `tses-` ids, years 2000–2100), at most 30 revisions, proposed by the club, confirmed or declined by the recipient; `requiresConfirmation`/`material` returned.
22. **Timezone model** — one organiser zone per revision, exact IANA name (plus four modern names ICU reports under legacy aliases, D-P4B-1); instants stored as UTC ms; slot days derived in the organiser zone; ICS `DTSTART;TZID=`.
23. **Session model** — `{ id, kind ∈ onboarding|training|drill|small_sided|match|other, startsAt, endsAt, venue{name,town,address}, instructions, evidence[] }`; ended sessions and sessions with attendance are carried unchanged or the revision is refused.
24. **Reschedule model** — same handler as schedule; prior revisions retained verbatim with `supersededAt`; a session with attendance or already ended cannot move (S10b/S10c); revision after an ended session possible (D-P4B-2).
25. **Reconfirmation model** — `materialChange()`: zone, session count, any start/end, venue name/town → confirmation cleared and the recipient asked again (`trial_day`); kind/instructions/address line alone → confirmation kept.
26. **Cancellation model** — `completion.state = 'cancelled'` with `phase`, `cancelledBy ∈ club|player|guardian`, reason (mandatory from the club), attended-session count; case unchanged; allowed while blocked and with a broken guardian route; twice = replay.
27. **Attendance model** — append-only per session: `attended|partial|no_show|club_cancelled|player_withdrew`, `source manual|checkin`, club-private note; refused before the session starts; `not_recorded` derived; never read as a judgement.
28. **Completion model** — explicit, gated (`canComplete`): confirmed schedule, ≥ 1 attended/partial, last session ended → `409 TRIAL_COMPLETION_REQUIREMENTS_NOT_MET` with `reasons[]` otherwise; moves the case to `trial_completed` through the writer; report still owed; `assessmentPending` reminder once after 7 days.
29. **Box Cam linkage** — by reference to a finalised session of the same player under the Combine consent rule evaluated now; `404 TRIAL_BOXCAM_INCOMPATIBLE` for unknown/foreign/test-only, `403 EVIDENCE_CONSENT_REQUIRED`, `409 EVIDENCE_NOT_FINAL`, `409 EVIDENCE_WITHDRAWN`; candidates route for the UI; unlink tombstones.
30. **Multiple Box Cam sessions** — several sessions per trial session (limit 20), distinct rows, replay on the same session (E6–E10, E14, E20).
31. **Box Cam refusal behavior** — a refused CV result still links; projection state = the refusal reason with copy "No reliable observation available. …"; no failure wording, no number (E11–E12b, D-17).
32. **Box Cam provenance** — `provenance: 'box_cam_observed'`, `combineVerified: false` + platform reason, verification state, `simulated`, provider/engine/policy versions; never trace/nonce/obs/frames/confidence.
33. **Raw media retention** — unchanged: no M16/M22 file modified; links reference session ids only.
34. **Passport relationship** — no Passport event from a link (E16, D-14); `trial_attended` now keyed on recorded attendance for workflow trials (`legacy:false, attendedSessions`) and on acceptance for legacy rows (`legacy:true`) — the one M15 change, m15E2E adapted and green.
35. **Assessment model** — `db.assessments` unchanged; `context.trialId`/`trialSessionId` validated at creation and immutable; `evidenceRefs` whitelisted and bound to linked sessions; no aggregate number anywhere.
36. **Multiple assessor behavior** — the M12 blind rule unchanged: a second scout sees existence only until they submit (Q group); the trial detail lists existence/state/author.
37. **Assessment privacy** — sentinel sweep across player/guardian trials, inbox, notifications, Passport, journey, outbox, push, foreign org, audit detail (I group; live N10); foreign org 404 on `?trialId=` and on create (sweep).
38. **Published feedback** — `publishedFeedback` remains the single door; untouched.
39. **Report obligation compatibility** — `status: awaiting_report|reported` untouched; report route works on workflow and legacy rows; notification suppressed while blocked (D-16); Trials screen shows workflow state beside the report state.
40. **Permission matrix** — `trial_view` viewer+, `trial_assess` contributor+, `trial_write` room lead+; mirrored in `roomCan`; `canWrite`/`canAssess` in the list payload (W4, W5, live N2).
41. **Reauthorization** — `reauth()` on every club mutation: role, org, block policy, recipient validity (visibility, verification, guardian route), subject removed, state — all now; recipient routes re-derive the recipient too.
42. **Tenant isolation** — foreign org: 404 on list, trial, evidence, candidates, assessments-by-trial, mutation; keys scoped to the case; rate counters per org (W7, W8, W8b, K7, L group, sweep).
43. **Tombstone/deletion behavior** — `subjectRemovedAt`: the trial stays as ids/states/times, every mutation `409 TRIAL_SUBJECT_REMOVED` (club) / refused (recipient), audit rows unnamed, the case keeps its evidence-backed status, survives restart (T group, sweep).
44. **Event architecture** — nine `trial_*` registry entries, all `org_private`, ids only, `analyticsEligible: false`; `broadcast()` after `persistNow()`.
45. **Notification architecture** — family: `trial_day` (existing type; preferences/grouping apply) to the routed recipient only; club: `trial_day` to room owner/lead on accept/decline/confirm/decline-schedule/cancel; T-48h per session per revision, `completionPending`, `assessmentPending` markers set once (N group, Z group, persistence §4).
46. **Inbox integration** — the existing request row and respond routes; slot chips from `trialDetails.slots`; `requestForRecipient` strips `private`, `caseId`, org/user/contact ids, `recipient`, `keys`; accepted rows point at `trialId`.
47. **Outbox/email** — no new email; the outbox carries no trial sentinel (I group, live N10c).
48. **Journey projection** — `trials[]` with `trialMilestone`, `trialsOmitted`, timeline entries for invited/declined/accepted/scheduled/confirmed/declined-schedule/attendance/cancelled/completed/evidence linked-unlinked/assessment recorded; no note, address or observation (E17, E17b).
49. **Analytics** — `trial_process` (pipeline family, `window_entry`, counts invited/declined/accepted/scheduled/completed/cancelled, `ratio: false`, small-n) — process only, never a player KPI; two negative checks in m20E2E; `M20_METRICS.md` F4.
50. **Idempotency** — per-action keys with payload fingerprints (invite, schedule, cancel, attendance, complete, link); same payload replays, different payload `409 TRIAL_IDEMPOTENCY_CONFLICT`; recipient routes idempotent by state (K group).
51. **Restart idempotency** — keys, links, tombstones and reminder markers survive a process death; a replayed key after restart answers `idempotent: true` before any other gate (Z group; persistence §4; sweep).
52. **Concurrency** — `expectedRev` required, integer or `400 TRIAL_REV_REQUIRED` (no coercion), stale `409 TRIAL_VERSION_CONFLICT` with `current`; six races proved (C group).
53. **Atomicity/failure injection** — `channel: 'trial'` on invitation, acceptance and completion: nothing written (no row, no case move, no notification) (F group).
54. **Rate limiting** — `trial_invite` 30/h org, `trial_schedule` 60/h org, `trial_attendance` 120/h org, `trial_evidence_link` 60/h org, `trial_response` 30/h recipient, plus the deterministic invitation cooldown (L group).
55. **Error contract** — 36 Trial codes in one band each (`m23/errors.mjs`, drift guard), exact code on every refusal; the 404 band conceals; 409 names `current`.
56. **Club UI** — page-local Trial tab in the Room (Pro + Grassroots, identical `trialPanel.tsx`); Trials screen shows workflow state and links into the room; demo store mirrors the API (P4A-D3 closed); no new top-level navigation.
57. **Player UI** — Trial workflow section in Opportunities (confirm/decline/cancel with reason), slot chips in the Inbox invitation, address/instructions after acceptance.
58. **Guardian UI** — the same section in the guardian view for each child; the child's own device shows the outcome line only (live N12).
59. **Mobile 390px** — no horizontal page scroll on the club Trial tab, the player invitation, the family Trial section; the attendance control is a touch target inside the viewport (live A7e, N13, N13b).
60. **Mobile 360px** — club Trial tab re-measured at 360 (live N13d); family surfaces at 390 (N12/N13 family checks).
61. **Accessibility** — tab semantics (`aria-selected`, `aria-controls`), keyboard reach and Enter activation of the Trial tab, focus enters the panel on a labelled control, polite live region for every mutation, labelled attendance select (live A13–A13e, N13c). All pass.
62. **EN/FR** — every new club key in EN and FR (type-enforced parity), every new player key in EN and FR (`fr: typeof en`); live A14/A14b render the Trial tab and the family section in French. All pass.
63. **Adult live journey** — live A1–A12: contact → invitation from the Room → Inbox slot → acceptance → schedule in the family view → attendance → assessment opened → completion → journey.
64. **Minor live journey** — live M2–M8: routed to Amara, child's device outcome-only, material reschedule re-asks the guardian, guardian confirms in the UI.
65. **Negative live paths** — live N1–N15: gate at Watching, no lifecycle shortcut, contributor read-only, foreign org 404, revoked guardian, block after invitation, attendance before start, completion gate, stale/string rev, key conflict, sentinels, evidence without consent, child device, 390/360, pending invitation.
66. **Trial test totals** — `m23TrialE2E` 535 checks (331 negative, 62 %); `m23TrialPersistence` 36 (13 negative); `m23TrialPerf` measured; `m23TrialLive` 122 checks (53 negative, 43 %); adversarial sweep 51/51.
67. **Server regression totals** — 43 scripts, all exit 0 (see §"Server battery" below).
68. **Browser/live/demo totals** — 36 scripts (navConfig, demoFreshness, uiSpotcheck, demoOffline, crosstab, demoHostOrdering, 11 demo spotchecks, liveIntegration, navLive, 17 Live suites), all exit 0, demos rebuilt first (see §"Browser battery" below).
69. **Typechecks** — `tsc --noEmit` exit 0 for scoutbox-club, scoutbox-grassroots, scoutbox-player, scoutbox-admin.
70. **Builds** — `npm run build` (tsc -b + vite) exit 0 for club, grassroots, admin; player web export through `buildDemos`; the live suite builds club + player bundles.
71. **Navigation regression** — navConfig 282 checks, navLive 64 checks (N1–N17) — no new top-level destination (the Trial tab is page-local).
72. **Performance** — 20 sessions × 0/5/20 links: club view p50 ≤ 0.009 ms, milestone ≤ 0.006 ms; validation of 20 sessions p50 0.063 ms; +400 cases: list 1.58×, journey 1.19× (one linear scan, no N+1); scan audit ≤ 5 touches per collection per journey; index not added (D-25).
73. **Low defects inherited/fixed** — P4A-D3 closed (demo store); P4A-D6, D7, D8, D11 open, untouched, each with the reason in the register.
74. **New Critical found/fixed** — 0 / 0.
75. **New High found/fixed** — 1 / 1 (D-P4B-2, revision after an ended session).
76. **New Medium found/fixed** — 3 / 3 (D-P4B-1 timezone aliases, D-P4B-3 sweep guard, D-P4B-4 integrity checker).
77. **Open Critical** — 0.
78. **Open High** — 0.
79. **Open Medium** — 0.
80. **Known limitations** — no club-side withdrawal of a pending invitation; no dedicated birthday-transition test; check-in attendance source exists but the live suite records attendance manually; EN/FR live coverage is one club tab and one family section; the two-tab cancellation race is proved over the API, not in two browser tabs; real-world CV validation not completed, Combine Verified production-capable: NO.
81. **Legal-review items** — none new; the Trial keeps the P4A privacy matrix (address after acceptance, no minor contact, consent evaluated at link time); the `trial_process` metric is org-private and small-n.
82. **Bundle path** — `/home/user/scoutbox-m23-p4b-trial.bundle`.
83. **Bundle SHA-256** — reported in the closure message (computed after the follow-up commit; see footer).
84. **Bundle verify** — `git bundle verify` run after the follow-up commit; result in the closure message.
85. **Fresh clone result** — HEAD/tree equality, schema boot, the Trial suites, Contact, P4A closure, M23 lifecycle, M22 key suites, production builds and the Trial live journey from the clone; results in the closure message.
86. **Tree status** — clean after the follow-up commit (verified in the closure message).
87. **Push status** — not pushed (§218).
88. **PR status** — none (§219).
89. **Deployment status** — none (§220).

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
| `m22CvEval` | 0 | FT05_ball_passes_in_front            accepted                   count 0 |
| `m22Holdout` | 0 | HT03_second_ball_passes_close        protocol_violation         count 0 |
| `m22Robustness` | 0 | m22Robustness: all 48 checks passed |
| `m22Perf` | 0 |  |
| `m23Perf` | 0 |  |
| `m23ContactPerf` | 0 |  |
| `m17Perf` | 0 | Passport projection (same player, direct)  median 1.2 ms   p90 1.4 ms |
| `m18Perf` | 0 | matching the WHOLE brief costs 1.68× a single Passport assembly — the match runs on light facts, not assembled |
| `m181Perf` | 0 |   noise. Worth revisiting if Passports of that size become common; today the |
| `m182Perf` | 0 |  |
| `m19Perf` | 0 |  |
| `m20Perf` | 0 |   opposite of what the one-pass design was optimised for. It has been left alone rather |
| `m21Perf` | 0 |  |

42 scripts, every one exit 0, run on the closure commit `3d9883d` (the same battery ran green on the pre-closure tree). The M22 artefact churn its evaluation scripts produce (`evaluation.json`, `holdout.json`, `perf.json`) was reverted, as in every prior milestone.

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

Run on the closure commit `3d9883d` after `npm run build` (club, grassroots, admin) and `node e2e/buildDemos.mjs`; the first run on the pre-closure tree had one failure, `uiSpotcheck`, caused by the player Inbox copy change and fixed by restoring the wording it expects (see the defect register, "suite corrections").

## Final adversarial sweep (§211)

`scratchpad/m23/p4bSweep.mjs`: 51 probes across authorization, minor routing,
block behaviour, Trial state, lifecycle evidence, schedule/date, completion
gate, assessment privacy, Box Cam linkage, event audiences, notification
taxonomy, tombstones, concurrency and restart, against a production-clock
server and a test-clock server. 51 passed. One precision change came out of
it: the candidates list now names a block as `TRIAL_BLOCKED` rather than
`TRIAL_RECIPIENT_UNAVAILABLE` (regression B7b). Two probe expectations were
corrected against the code (journey shape; a blocked recipient's confirm is
refused even as a no-op replay, which the contract states).

## Footer

Closure commit `3d9883d` carries the docs, the sweep-driven precision,
the copy corrections and the a11y/FR live checks. This report is added by the
follow-up commit; the bundle is created from that follow-up tip and its hash,
verify result, SHA-256 and fresh-clone results are reported in the closure
message.
