# M23 P4A — Final Report: Trial + Box Cam Integration Architecture

Architecture milestone. No Trial workflow, no Box Cam engine change, no
Offer. One privacy fix (P4A-D9) was made under the §140 policy. Everything
else is documents that make P4B smaller and safer.

Documents: `M23_P4A_TRIAL_BOXCAM_REUSE_AUDIT.md`,
`M23_P4A_TRIAL_PRIVACY_MATRIX.md`, `M23_P4A_TRIAL_TEST_PLAN.md`,
`M23_P4A_BOXCAM_CHANGE_CLASSIFICATION.md`, `M23_P4A_DECISION_REGISTER.md`,
`M23_P4A_DEFECT_REGISTER.md`, `M23_P4A_FINAL_ARCHITECTURE.md`, this report.

## The 61 items (§153)

1. **Current tip:** `ca3e6c9` (P4A architecture commit on top of the P3 freeze `61cfa75`; a footer commit records this hash).
2. **Production code changed?** Yes, one read-side projection: `m12/journeys.mjs` `trialDayView` (org side) withholds the family's emergency contact while a block stands (P4A-D9, privacy/safeguarding). Plus five assertions in `scripts/m12E2E.mjs`. No route, store, status, gate, client or Box Cam code changed.
3. **Existing Trial model:** `db.trials` = an *accepted* trial, created only on the recipient's accept (`server.mjs:1297-1313`, `:2866-2880`); fields in reuse audit C1; no schedule beyond a date string, no timezone, no sessions, no attendance state, no completion, no case id, no rev, no history.
4. **Existing Trial statuses:** exactly two — `awaiting_report`, `reported` — a report obligation, neither a schedule, attendance nor completion state (reuse audit C2).
5. **Writers/readers:** two writers (accept paths); mutators (report, feed marker, trial day, sweep, deletion); eleven reader families (server routes, M12, M15, M17, M18, M20, M21, M23) — reuse audit C3–C4.
6. **Compatibility constraints:** keep `status` and its meaning, `reportDueAt`, `REPORTS_OUTSTANDING`, creation-at-acceptance, `requestId/playerId/orgId` scoping, `trial.day` and its gates, directory/funnel aggregates; legacy rows read as `legacy_accepted` with nothing fabricated (C9–C10).
7. **Existing assessment architecture:** `db.assessments` — template-versioned 1–5 or `notObserved`, confidence, evidence refs to video segments, `draft→submitted→reviewed`, immutable after submit, blind rule, second opinions, per-attribute compare that refuses cross-version averages, `publishedFeedback` as the only door to the player; plus the separate legacy six-number feedback report on `trial.report`.
8. **Box Cam architecture:** player-minted sessions bound to the actor (never recognition), aggregates + M22 CV results, single primary refusal reason, no frames persisted, T&S dispute loop, `combineVerifiedProtocols() === []`; no org/case/trial field on any session (change classification §1).
9. **M22 gates:** real server-side pixel CV YES; face recognition NO (prohibited); audio NO; production raw video persistence NO; client counts as truth NO; real-world validation complete NO; Combine Verified production-capable NO. Unchanged by P4A; M22 suites green.
10. **Contact → Trial handoff:** one gate — case status. `planTrial` from `contacted` (and the existing in-edges); no separate "Contact record required" check. `trial_requested` becomes evidence-gated on a delivered invitation (D-3).
11. **Adult invitation:** club sends from the Room → `issueRecruitmentRequest` (`type:'trial'`, `caseId`) → Inbox → accept with an offered slot → Trial row through one writer → schedule confirmed when the slot is concrete → `trial_scheduled` (D-4).
12. **Minor/guardian:** the P3 resolver (verified guardian, fail closed); guardian state re-derived at every mutation; aging handled by re-derivation with history snapshots; verification loss → cancel only (D-6, D-7).
13. **Scheduling:** `schedule { timezone (IANA), revision, confirmedAt, sessions[] { kind, startsAt/endsAt UTC, venueRef, arrival } }` on the Trial; ≤ 20 sessions; no separate store (D-2, D-21).
14. **Rescheduling:** append-only revisions; after acceptance a reschedule clears `confirmedAt` and requires recipient re-confirmation; the case does not move backwards (D-8 in register numbering: see D-4/C).
15. **Cancellation:** `completion.state = cancelled` with `cancelledBy` and phase; never `trial_completed`; recipient and club paths; block policy D-16.
16. **Attendance:** per session `attended | partial | no_show | club_cancelled | player_withdrew`, `source: checkin | manual`; check-in remains the M12 gated act; never a judgement (D-8).
17. **Completion evidence:** organiser marks complete only with ≥ 1 attended/partial session, last session ended, not cancelled; assessment not required (D-5).
18. **Assessment architecture:** `db.assessments` + `context.trialId`, evidence refs to linked Box Cam sessions / Trial sessions; legacy feedback report unchanged; no third record (D-9).
19. **Multiple assessors:** yes, independent, blind, per-attribute compare, no aggregate, disagreement preserved (D-10).
20. **Trial session decision:** embedded on the Trial; Box Cam session ≠ Trial session (D-2).
21. **Box Cam linkage:** Trial → session references; nothing written on the session; link authorisation = same player, finalised, not withdrawn, not test-only, `orgCanSee`, opt-in or active request (D-11).
22. **Multiple Box Cam sessions:** yes, per Trial session and per Trial (D-12).
23. **Non-Box-Cam Trials:** fully valid; no gate reads Box Cam (D-13).
24. **CV refusal:** "no reliable observation available"; existing copy; nothing derived; never "failed" (D-17).
25. **Observation vs assessment:** frozen — machine observation tied to evidence vs human football interpretation; annotations reference, never rewrite (§25, §52–§53).
26. **Passport:** observations referenced not promoted; `trial_attended` keyed on attendance; assessments never travel; provenance line later behind explicit selection (D-14).
27. **Observation visibility:** player, guardian (minor), linking club under the consent rule, T&S; not other clubs (D-15).
28. **Assessment visibility:** author, leads, submitted co-assessors; never recipient or other clubs; `publishedFeedback` only (D-16).
29. **Minor privacy:** guardian-managed outcome line only; family view after the guardian shares; venue/address after acceptance to the guardian only; nothing club-private automatic (privacy matrix).
30. **Provenance:** read live from the source at projection; link rows carry references and link events only (N5, §37).
31. **Media retention:** unchanged; linking does not retain or extend anything; no frames exist to retain (§44–§45).
32. **Trust Score:** no new input; legacy number untouched; Trial UI reads neither (§63).
33. **Development Hub:** post-decision recommendations only; not the checklist (§59, §64).
34. **Second Look:** unchanged in P4B; later key on completion (D-24).
35. **Nobody Missed:** unchanged in P4B; later `trial` signal on completion; "completed but not evaluated" recommended (D-24).
36. **Analytics:** process metrics only (invited/accepted/scheduled/completed, completion rate, delays); `SMALL_N_MIN = 5`; no ability ranking (D-29).
37. **Journey projection:** club milestones incl. assessment existence with assessor role; recipient sees shared records only; no private body (D-18).
38. **Events:** nine `trial_*` club-private id-only events; recipient side reuses `request`/`inbox` (architecture §14).
39. **Notifications:** existing `request`, `trial_day`, `feedback` types; minors' outcomes via `trial_updates` (fixes P4A-D10); reminders as persisted markers on the M12 sweep; no scheduler; calendar internal (D-27).
40. **Permission matrix:** architecture §11; `roomCan` gains `trial_view 0 / trial_write 2 / trial_assess 1`; reserved `request_trial` used.
41. **Concurrency:** Trial `rev`, assessment `rev`, Box Cam none; race winners defined (test plan L3).
42. **Idempotency:** keys + payload fingerprints per action, restart-safe (architecture §15).
43. **Atomicity:** invitation, acceptance, completion, cancel transactions; failure injection `channel: 'trial'`.
44. **Schema changes for P4B:** one additive migration (2304) on `db.trials`; optional fields on requests/assessments; one evidence-table entry (`trial_requested: trial_invited`); no new store (architecture §12).
45. **Index changes:** none; re-measure in P4B-9 (D-25).
46. **P4B necessary Box Cam changes:** N1 link by reference, N2 link authorisation, N3 safe projection, N4 refusal semantics, N5 immutable provenance, N6 session kind on the Trial.
47. **P4B optional:** O1 create-assignment-from-Trial, O2 Trial note in the player's session UI, O3 grouping, O4 audit row, O5 enforce `box_cv_finalize` limit, O6 call `refusedClientFields`.
48. **Deferred Box Cam 2.0:** F1 multi-player tracking, F2 pose/technique, F3 tactics/match analytics, F4 automated clips, F5 live analysis, F6 new models/protocols/platforms, F7 Combine Verified, F8 ratings, F9 real-world validation itself.
49. **Test plan:** `M23_P4A_TRIAL_TEST_PLAN.md` groups A–O + persistence + perf + live; ≥ 55% negative.
50. **Live journey plan:** test plan group N (positive chain and ten in-browser negatives).
51. **New defects found:** 14 (P4A-D1 … D14): malformed trial date → `NaN` deadline + ICS 500; Passport `report.at` vs `filedAt`; impossible demo status `scheduled`; adult writer omits `guardianApproved`; `box_cv_finalize` policy not invoked; `refusedClientFields` not called by M22 routes; stale M16 doc / phantom `BOX_CAM_PRODUCTION_CV_REQUIRED`; dead `'published'` assessment state; **blocked club could read the family's emergency contact**; minor's outcome notification in an off-by-default category; open-day invite bypasses the single request writer; unknown `chosenSlot` silently ignored; `respondedBy` asymmetry; deletion cascade leaves cases at `trial_completed` without trials.
52. **Defects fixed:** P4A-D9 only (privacy/safeguarding), with regression in `m12E2E`.
53. **Open Critical:** none.
54. **Open High:** none (D9 was the one S1 and is closed).
55. **Open Medium:** P4A-D1 (malformed trial date → `NaN` deadline, ICS 500; org-authenticated input, assigned P4B-1), P4A-D10 (minor outcome notification category, P4B-2), P4A-D14 (deletion cascade vs case status, P4B-1). Under the standing rule these are reasonably fixable; under §140 they are not in the P4A fix classes. They are listed, not hidden, and P4B-1/P4B-2 own them.
56. **Regression results:** post-fix full server battery 25/25 green: testTrust 23, apiE2E 130 (owned :4000), connectedE2E 43, m12E2E **152** (147 + 5 new), m13E2E 212, m14E2E 193, m141E2E 94, m15E2E 185, m16E2E 118, m161E2E, m162E2E, m17E2E, m18E2E, m181E2E, m182E2E, m19E2E, m20E2E, m21E2E, m22E2E, m22Blocker, m23E2E 382, m23Persistence 67, m23BootContract, m23ContactE2E 418, m23ContactPersistence 61.
57. **M22 regression:** `m22E2E`, `m22Blocker`, `m22CvEval`, `m22Holdout`, `m22Robustness`, `m22Perf` all green (pre-fix baseline run); Combine eligibility NOT ELIGIBLE — real-world validation not completed; CvEval "no false verifications, fully deterministic"; Holdout "no false touches, no false verifications, deterministic, no generalisation gap measured"; Robustness 48/48. Artifacts regenerated with `generatedAt` and timing churn only (`evaluation.json` 1 line, `holdout.json` 2 lines, `perf.json` timings + `gcExposed`) — **reverted**; tree byte-identical for `m22/`.
58. **P2.5 regression:** navConfig 282, navLive 64 (N1–N17) green on the tip; the client tree is unchanged by P4A.
59. **Tree status:** clean after the P4A commits.
60. **Push status:** not pushed (§159).
61. **PR status:** none.

## Required architectural answers (§154)

```
Existing canonical Trial model can be reused: YES
Existing assessment model can be reused: YES
Separate Trial session model required: NO   (embedded sessions on the Trial)
Separate Trial assessment system required: NO
Trial may exist without Box Cam: YES
Multiple Box Cam sessions may belong to one Trial: YES
Box Cam observation equals human assessment: NO
CV refusal equals poor performance: NO
Trial completion equals recruitment decision: NO
Trial assessment equals recruitment decision: NO
Box Cam creates talent score: NO
Box Cam creates potential score: NO
Face recognition required for P4B: NO
Raw video retention must increase for P4B: NO
Trial Box Cam evidence automatically becomes Passport evidence: NO   (referenced, not promoted)
Club-private assessment automatically becomes Passport content: NO
Minor direct-contact safeguard preserved: YES
Agency minor restriction preserved: YES
Verified-club minor restriction preserved: YES
P2 recruitment lifecycle must be widened: NO   (no new status, no new edge; one evidence-table entry for trial_requested)
Offer Workflow required for P4B: NO
Box Cam CV engine expansion required for P4B: NO
```

## Current Box Cam capability report (§145)

```
real server-side pixel CV: YES
face recognition: NO
audio analysis: NO
production raw video persistence: NO
client counts accepted as truth: NO
real-world validation complete: NO
Combine Verified production-capable: NO
```

## Proposed P4B scope (§155)

| phase | scope | complexity |
|---|---|---|
| **P4B-1 persistence + lifecycle** | migration 2304 (additive fields, legacy interpretation, tombstone cascade), single Trial writer replacing the two accept copies, schedule validation (closes D1, D4, D12, D13, D14), `TRIAL_*` error table, rate policies, `roomCan` actions, evidence provider answers for `trial_invited/confirmed/completed`, the one evidence-table entry | medium |
| **P4B-2 invitation + guardian** | `POST /org/rooms/:id/trials`, invitation through `issueRecruitmentRequest` with the verified-guardian resolver, `caseId/trialId` on requests, case advance, respond-route slot validation and single respond writer (`respondedBy`), open-day invite routed through the writer (D11), child notification category (D10), block policy D-16 | medium |
| **P4B-3 schedule + attendance** | schedule/reschedule/re-confirm routes, timezone-aware ICS, recipient confirm/decline/cancel, attendance route + check-in integration, reminders as sweep markers | medium |
| **P4B-4 Trial sessions** | session model in the schedule (kinds, bounds), family view of sessions, cancellation per phase, completion rules | small |
| **P4B-5 Box Cam linkage** | N1–N6 (link route, authorisation, `trialEvidenceView`, refusal semantics), optional O1/O4/O5/O6, doc corrections (D7) | medium |
| **P4B-6 assessments** | `context.trialId`, evidence ref kinds, Trial-scoped compare, Passport `trial_attended` re-key and `filedAt` (D2), dead `'published'` removal (D8) | small |
| **P4B-7 player/guardian UI** | Inbox slot picker + schedule confirm, Opportunities → Trials family view, guardian screen, demo mocks matching the vocabulary (D3), 390px | medium |
| **P4B-8 journey/events/notifications** | journey milestones per viewer, nine events + audit domain, notification wiring, terminology additions | small |
| **P4B-9 live/regression/recovery** | test plan groups A–O, persistence, perf (index decision), live suite, full batteries, demos, bundle + fresh clone | large |

Component complexity (§133): Trial persistence **medium**; recipient/invitation **medium**; schedule **medium**; guardian **small** (resolver exists); attendance **small**; Box Cam linkage **medium**; assessment **small**; journey **small**; UI **medium**; tests **large**.

## Box Cam 2.0 (§156) — separate later milestone, must not block Trial

Multi-player tracking without identity claims (or an explicit decision that
it is impossible), pose estimation and technique signals (if ever, with their
own prohibition review), tactical inference, automated clips (requires a
retention decision that does not exist), live analysis, new protocols /
models / camera types / native capture (each with evaluation, holdout,
freeze), Combine Verified for CV protocols (requires the real-world
validation record), and — explicitly never — computer-generated player
ratings or face recognition.

## Success condition

All stop conditions (§157) are met: every canonical system audited with
citations; state owners named (§3 of the architecture); the three Trial
evidence gates defined (§4); the safeguarding path defined (§5–§6, D-6/D-7,
D-16, D-23); Box Cam boundaries explicit (classification N/O/F); Passport
visibility decided (D-14); observation/assessment/decision separation
explicit (D-9, D-10, D-22, §18 of the architecture); P4B schema/API/UI/test
plan concrete (§12–§17, test plan); no implementation ambiguity that current
source can resolve remains — the two flagged legal-review items (footage
acknowledgement for minors; consent scope naming Box Cam) are not resolvable
from source and are marked as such rather than assumed.

```
M23 P4A TRIAL + BOX CAM ARCHITECTURE COMPLETE
TRIAL, EVIDENCE, BOX CAM AND ASSESSMENT BOUNDARIES FROZEN
P4B IMPLEMENTATION SCOPE DEFINED
NO BOX CAM CAPABILITY OVERCLAIM INTRODUCED
READY FOR M23 P4B TRIAL WORKFLOW IMPLEMENTATION
```

Not begun: P4B, Trial, Offer. Not modified: the Box Cam CV engine. Not
pushed. No PR. No deploy.


---

P4A commit: `ca3e6c9` — "M23 P4A: Trial + Box Cam integration architecture".

## Closure addendum

The three Mediums this report left open (D1, D10, D14) were reproduced,
root-caused and closed in the P4A **closure pass** that followed, together
with D2, D4, D5, D12, D13 and one further Medium found while proving the
fixes under a process crash (D15: an accepted request was saved before its
trial row existed). Every architecture conclusion above stands: `db.trials`
and `db.assessments` remain the canonical stores, no Trial session store was
added, no schema advanced (2303), the lifecycle writer was not touched, and
the Box Cam CV engine, gates and thresholds are unchanged. What moved from
"P4B-1/P4B-2 will fix" to "already true": the canonical Trial date validator
and single deadline derivation (`domain.mjs`), the single accept-time trial
writer, slot validation before the answer is recorded, the tombstone
cascade, and the child's `guardian_decision` notification in the `messages`
category. P4B builds on those rather than re-creating them. The full account
is `M23_P4A_CLOSURE_REPORT.md`; the register is `M23_P4A_DEFECT_REGISTER.md`.
