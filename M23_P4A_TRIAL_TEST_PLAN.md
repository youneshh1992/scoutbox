# M23 P4A — Trial Test Plan (for P4B)

Test groups defined before implementation, in the shape every M-suite uses:
`✓`/`✗` lines, exact status **and** code on every refusal (never "not 200"),
a negative share stated at the end (target ≥ 55%, as P3 achieved 57%). Two
server suites (`scripts/m23TrialE2E.mjs`, `scripts/m23TrialPersistence.mjs`),
one perf script, and one live browser suite (`e2e/m23TrialLive.test.mjs`).
The Contact suites are the template; their helpers (`planned()`, `collect()`,
`expect()`, the sentinel sweep) are reused.

Fixtures come from the seed: Eastport FC (verified club, Maria Keane = lead,
Tom Reilly = scout), Harbour City FC (foreign club), North Star (agency), Kola
Adeyemi (adult), Elias Svensson (adult), Guni Adebayo (14, guardian Amara),
Tomasz Kowalski (16, guardian Marek). Nothing is invented that the seed
cannot supply; a clean server on its own port per suite.

## A. Adult happy path
1. Case at `contacted` (via a delivered Contact) → `POST /org/rooms/:id/trials` (invitation) → 201; request row `type:'trial'` with `caseId`, `trialId` null until acceptance; case → `trial_requested` through the canonical writer, one `room_status_changed` entry, reason `trial_progression`.
2. Player Inbox shows the invitation with venue **name/town** only; slot picker lists exactly the offered slots.
3. Accept with an offered slot → 200; `db.trials` row created with `workflowState: 'scheduled'` (slot concrete) and `schedule.confirmedAt`; case → `trial_scheduled` (evidence `trial_confirmed` satisfied); exactly one more history entry.
4. Accept with a non-concrete invitation → `workflowState: 'accepted'`, case stays `trial_requested`; club confirms a schedule → `trial_scheduled`.
5. Attendance recorded on the session → completion allowed → case → `trial_completed`; `decisionPending` derived true.
6. Journey (club) shows the milestones; journey (player) shows the shared records only; no `caseId` in any player payload (sentinel sweep).

## B. Minor guardian path
1. Invitation for Guni → routed to Amara (verified); Guni's `/player/inbox` shows the guardian-managed line only; the child's outcome notification is `guardian_decision` in the `messages` category (P4A-D10, closed in the P4A closure pass; P4B re-asserts it).
2. Amara accepts with a reply; the Trial recipient snapshot records `guardian`.
3. Revoke Marek's IDV → invitation for Tomasz refused `422 TRIAL_GUARDIAN_REQUIRED`; a pending invitation cannot be accepted (`422`); nothing reaches Marek's inbox.
4. Two verified guardians without a designated one → `422 TRIAL_GUARDIAN_REQUIRED`; with `player.guardianId` set → routed correctly.
5. Guardian removed (`removedAt`) after acceptance → reschedule refused `422 TRIAL_GUARDIAN_REQUIRED`; cancel still allowed; family notified.
6. Aging: a minor whose birthday passes between acceptance and a reschedule → the reschedule is confirmed by the player, not the guardian; history keeps the guardian's earlier acceptance.
7. Agency (`org-northstar`) → `403 UNDER_18_WALL` on invitation; unverified club → `403 VERIFIED_CLUBS_ONLY`; verification revoked after invitation → schedule/reschedule/link refused, cancel allowed.

## C. Scheduling / rescheduling
1. `schedule.timezone` required (IANA), `startsAt < endsAt`, sessions ≤ 20, `kind` ∈ the closed set; malformed date → `400 TRIAL_SCHEDULE_INVALID`; the P4B schedule validator is built on the canonical `parseTrialDate` (P4A-D1, closed in the P4A closure pass — calendar-day syntax, refusal before persistence, one deadline derivation); venue/notes refused over their limits, never truncated.
2. Reschedule after confirmation → new `schedule.revisions[]` entry, prior revision retained verbatim, `confirmedAt` cleared, recipient re-confirmation required; case stays `trial_scheduled`.
3. Recipient re-confirms → `confirmedAt` set; declines the reschedule → Trial `accepted` with no schedule; club may propose again or cancel.
4. Unknown `chosenSlot` → `400 TRIAL_SLOT_INVALID` (already the behaviour of the M12 respond routes since the P4A closure pass, P4A-D12; P4B re-asserts it on the schedule route); offered slots retained on revision 1.
5. ICS export is timezone-aware (`DTSTART;TZID=…`), never 500 on any stored row (legacy included).
6. Legacy rows: `workflowState: 'legacy_accepted'`, `schedule.legacy: true`, no fabricated time; the journey renders them honestly.

## D. Cancellation
1. Club cancels before acceptance → invitation withdrawn (request `status: 'withdrawn'`? — use existing `declined`/`suspended` semantics only if the audit of P4B-2 confirms; otherwise a new request status is a contract change and is refused here) → **decide in P4B-2 and assert the chosen shape**.
2. Player/guardian cancels after acceptance → `completion.state: 'cancelled'`, `cancelledBy: player|guardian`, case stays where it is (never `trial_completed`).
3. Club cancels after scheduling → family notified via `trial_day`; reason recorded; case unchanged.
4. Cancel after partial attendance → attendance kept, completion `cancelled`, completion refused thereafter (`409 TRIAL_INVALID_STATE`).
5. Cancel twice → idempotent replay, not a second event.

## E. Attendance
1. Check-in (existing gate: reviewed staff check + consent) → attendance `attended`, `source: 'checkin'`, coach-signed `player.attendance` row as today.
2. Manual `partial` / `no_show` / `player_withdrew` / `club_cancelled` → recorded with `source: 'manual'`; unknown state → `400`.
3. Attendance on a session outside the trial → `404` (concealed); on a cancelled trial → `409`.
4. Attendance changes nothing in Trust (`/player/trust-profile` byte-equal before/after), Matching, Watchlists.

## F. Completion
1. Completion with no attended/partial session → `409 TRIAL_COMPLETION_REQUIRES_ATTENDANCE`.
2. Completion before the last session ends → `409`.
3. Completion on a cancelled trial → `409`.
4. Completion → case `trial_completed` via the writer; a second completion → replay.
5. Completion with no assessment is valid; the "assessment outstanding" reminder marker is set once (restart → not re-sent).

## G. Assessment
1. Assessment in Trial context (`context.trialId`) → 201; blind rule holds for a second scout; compare view keeps both; no aggregate number anywhere in any payload (`/score|rating(?!s)|potential/i` sweep excluding the legacy report fields).
2. Evidence ref to a linked Box Cam session → accepted; to an unlinked or foreign session → `400 SEGMENT_INVALID`-equivalent (`400 EVIDENCE_REF_INVALID`).
3. Submitted assessment immutable; `publishedFeedback` remains the only door; player/guardian payloads carry no ratings (sentinel).
4. Legacy feedback report still mandatory and unchanged: `REPORTS_OUTSTANDING` still fires.
5. Assessment does not move the case; recording a decision does (separately).

## H. Box Cam link
1. Link a finalised, verified session of the same player after opt-in → 201; projection carries `provenance: 'box_cam_observed'`, verification state, `simulated: false`, no `trace`, no `nonce`, no numeric confidence.
2. Link twice → replay; link to a second Trial session → distinct row.
3. Wrong player → `404` (concealed, same body as unknown id); foreign org's trial → `404`; unfinished session → `409 EVIDENCE_NOT_FINAL`; invalidated → `409 EVIDENCE_WITHDRAWN`; test-only provider in production mode → refused; no opt-in and no active request → `403 EVIDENCE_CONSENT_REQUIRED`.
4. Session invalidated by T&S **after** linking → projection `evidence_withdrawn`, link row kept.
5. Linking changes nothing on the Box Cam session record (byte-equal), nothing in the Passport (byte-equal for the player), nothing in Trust.

## I. CV refusal
1. Link a session whose CV result is `refused` (`ball_not_detected`) → link allowed; projection state "no reliable observation available" with the policy copy; no attendance/completion/assessment field derived; Trial payload contains no word implying failure (`/fail|poor|weak/i` sweep).
2. A refused session and an accepted session on the same Trial session are listed without ordering by outcome.
3. `combineVerified: false` / `combineVerifiedBlockedBy` shown unchanged for a linked Combine attempt.

## J. Privacy
1. Sentinel (`PRIVATE_TRIAL_SENTINEL_123`) in an assessment note, a room comment and a decision note → absent from player inbox/notifications/export/Passport/journey, guardian inbox/log, outbox, push log, foreign-org journey and trial list, T&S audit detail.
2. Emergency contact absent from every non-day surface and withheld while blocked (extends P4A-D9).
3. Venue address absent from the invitation; present in the family view only after acceptance; minor's device: never.
4. `requestForRecipient` strips `caseId`/`trialId`.
5. Foreign org: same 404 body for trial, session, evidence, assessment as for an unknown id.

## K. Authorization drift
1. Viewer reads, cannot write (`403 TRIAL_NOT_PERMITTED`); contributor can assess, cannot schedule; room lead can do all; demotion mid-flow refuses the next write on the same token; removal refuses everything.
2. Block placed after acceptance: cancel 200, reschedule/arrival/staff/link/assess `403 BLOCKED`, report 201 with no player notification (D-16).
3. Club verification loss mid-flow: schedule/link refused, cancel allowed.

## L. Concurrency / idempotency
1. `expectedRev` required on schedule/reschedule/cancel/complete/link; `"2"`, `2.5`, `{}` → `400 TRIAL_REV_REQUIRED`; stale → `409 TRIAL_VERSION_CONFLICT`.
2. Keys: `invite, accept, schedule, reschedule, cancel, attendance, complete, link` — same key + same payload replays after a restart; same key + different payload → `409 TRIAL_IDEMPOTENCY_CONFLICT`.
3. Races (§107): accept vs cancel (first writer wins by rev; the loser gets 409 with `current`); schedule vs decline (decline wins: the Trial cannot be scheduled for a recipient who declined); reschedule vs attendance (attendance on the superseded revision is refused 409); completion vs cancellation (whichever committed first; the other 409); double link (replay); assessment submit vs Trial correction (assessment has its own rev; unaffected).
4. Atomicity: accept + schedule + case advance + notification in one `persistNow()`; failure injection (`channel: 'trial'`) leaves no partial state.

## M. Historical compatibility
1. Boot with pre-P4B rows (fixtures with only M12 fields, including a `NaN`-deadline row and a malformed date) → migration adds neutral containers; no fabricated schedule/attendance; all readers (Passport, Rooms, M18, M20, journey) answer as before.
2. Corruption: invalid `workflowState`, trial/player mismatch, foreign session link, assessment without trial, duplicate session id, `endsAt < startsAt` → omitted from lists + counted + logged, single GET `500 TRIAL_STATE_UNKNOWN`, evidence provider answers `not satisfied` (never repaired by invention).

## N. Mobile / live (`e2e/m23TrialLive.test.mjs`)
Real Pro workspace and real player app, 390px on the player/guardian side and for the Room Trial tab:
club contacts player → creates the invitation from the Room → player/guardian sees it in the Inbox → accepts a slot → schedule visible in the family view → club records attendance → links a Box Cam session (player runs one through the test provider first) → observation visible to the club with the refusal/verification wording → assessment submitted → Trial completed → case journey updated. Negatives in-browser: missing guardian, unverified club, agency/minor, block after acceptance, role downgrade, cancellation race (two tabs), foreign org deep link, Box Cam wrong player, Box Cam refusal, private assessment sentinel.

## O. Cross-tenant
1. Every Trial route with a foreign token → `404` identical to unknown.
2. Trials never appear in another org's Room, journey, audit, analytics or Passport view.
3. Rate limits are per org; a burst from Harbour never affects Eastport's counters.

## Persistence suite
Store guarantee on clean boot and upgrade (2304), byte-faithful restore of a
Trial with sessions/attendance/evidence links, key replay after restart,
migration idempotence (run twice), the six corruption shapes above.

## Perf
List, journey and evidence projection at 0/25/100/500 trials × 5 sessions ×
2 links; scale check with +400 cases; scan audit (≤ 4 touches per collection
per journey); index decision recorded (D-25).

## Exit criteria for P4B
All groups green; negative share ≥ 55%; the frozen suites (`m23E2E`,
`m23ContactE2E`, `m17E2E`, `m18E2E`, `m20E2E`, M22 owners) unchanged and
green; navConfig/navLive green; demo freshness green; bundle + fresh clone +
live journey from the clone, as P3.
