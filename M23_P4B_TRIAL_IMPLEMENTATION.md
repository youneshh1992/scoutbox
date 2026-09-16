# M23 P4B — Trial Workflow: Implementation

What was built, where each rule lives, and what each surface may see. The
governing separation is the one the mandate opens with and the architecture
(`M23_P4A_FINAL_ARCHITECTURE.md`) fixed:

> invitation ≠ accepted ≠ scheduled ≠ attended ≠ completed ≠ assessment ≠ decision

Operational truth (what was arranged and what happened), machine observation
(Box Cam), human judgement (an assessment) and the recruitment decision are
four records with four owners; nothing in P4B lets one write another.

Commits: `40a0171` (P4B-1), `d027c73` (P4B-2/3/4), `6817762` (P4B-5/6/8),
`87a561d` (tests), `fdf10e7` (P4B-7). Nothing was pushed.

---

## 1. Schema

**No new store.** `db.trials` keeps its M12 meaning — *an accepted trial* —
and its two-valued report obligation `status: awaiting_report | reported`.
Migration `m230_005_trial_workflow` (`SCHEMA_VERSION 2304`,
`m182/migrations.mjs`) adds neutral containers to every existing row with
`??=`, idempotently, never destructively:

| field | added as | meaning |
|---|---|---|
| `workflowState` | `'legacy_accepted'` | pre-P4B rows read as accepted with nothing else recorded |
| `caseId` | `null` | the recruitment case; `null` = legacy, case-less |
| `schedule` | `null` | `{ timezone, revision, proposedAt, proposedBy, confirmedAt, confirmedBy, declinedAt, declinedBy, sessions[], revisions[] }` once proposed |
| `attendance` | `[]` | append-only `{ sessionId, state, source, recordedBy, recordedAt, note }` |
| `completion` | `null` | `{ state: completed \| cancelled, at, by, reason, phase, cancelledBy }` |
| `keys` | `{}` | idempotency keys per action, each with a payload fingerprint, bounded to 50 |
| `rev` | `1` | the trial's **own** revision (never the case's) |
| `history` | `[]` | append-only ids / states / times |
| `reminders` | `{}` | markers the M12 sweep sets once |

Nothing is backfilled from `proposedDate`: a day the club typed is not a
confirmed schedule, and inventing one would let a case reach
`trial_scheduled` on evidence nobody recorded. The migration tolerates a
missing or malformed collection and skips non-object rows.
`m23TrialPersistence` §1 proves clean boot, upgrade from a pre-P4B snapshot,
and running the migration twice.

A session: `{ id: 'tses-…', kind, startsAt, endsAt, venue: { name, town,
address }, instructions, evidence[] }`; instants are UTC milliseconds, the
zone is the schedule's. An evidence link: `{ id: 'tev-…', kind:
'box_cam_session', sessionId, linkedAt, linkedBy, removedAt }` — a reference,
never a copy.

The request row (`db.requests`, `type: 'trial'`) gains `caseId`, `trialId`
(null until acceptance), `recipient`, `keys.invite`, and
`trialDetails.slots[]` plus `trialDetails.private { venueAddress,
instructions }`. `requestForRecipient` strips `private`, `caseId`, `orgId`,
`userId`, `contactId`, `recipient` and `keys`, and keeps `trialId`.

## 2. State ownership

| fact | owner | who may write it |
|---|---|---|
| invitation sent / answered | `db.requests` row via `issueRecruitmentRequest` + the existing respond routes | club (invite), recipient (answer) |
| the trial exists | `db.trials` row via the single writer `issueAcceptedTrial` | only the respond routes |
| schedule, revisions, confirmation | `trial.schedule` | club proposes; recipient confirms / declines |
| attendance | `trial.attendance` | club (manual) or the existing trial-day check-in (`source: 'checkin'`, `m12/journeys.mjs`) |
| completion / cancellation | `trial.completion` | club (complete, cancel); recipient (cancel) |
| `workflowState` | **derived** by `deriveWorkflowState()` from the fields above and stored for indexing; the evidence provider re-derives and refuses a row whose stored state disagrees | the engine only |
| case status | `db.recruitmentCases` | **only** `ctx.applyLifecycleTransition`, asked through `canTransitionRecruitmentCase` with the real evidence provider |
| Box Cam session, CV result | M16 / M22 stores | never written by P4B (the Trial routes only read `db.boxSessions` and `db.boxCamCvResults`; no M16/M22 file changed) |
| assessment | `db.assessments` | M12 scouting routes; P4B adds `context.trialId` / `trialSessionId` and evidence refs |
| decision | `db.roomDecisions` | untouched |

`legacy_accepted` is a read-only interpretation; a legacy row enters the
workflow the moment a schedule is proposed for it (it then has a revision and
derives `accepted` or `scheduled` like any other).

## 3. Invitation

`POST /org/rooms/:id/trials` (`trial_write`). Body: `timezone` (exact IANA
name), `venue { name, town?, address }`, `slots[1..3]` of `{ startsAt,
endsAt, kind? }` on distinct calendar days in the organiser zone, `message`,
optional `instructions`, optional `clientKey`.

Order of checks, each with its own code: client key → body validation
(`TRIAL_TIMEZONE_INVALID`, `TRIAL_SLOTS_INVALID`, `TRIAL_VENUE_INVALID`,
`TRIAL_CONTENT_INVALID`) → replay / conflict on the key → the case gate
(`TRIAL_CASE_STATE`: every in-edge of `trial_requested` in
`ROOM_TRANSITIONS` plus `trial_requested` itself, i.e. `under_review,
contacted, shortlisted, priority, trial_scheduled, on_hold,
trial_requested`) → one pending invitation
(`TRIAL_ALREADY_INVITED`) → one open trial (`TRIAL_INVALID_STATE`) → the
deterministic cooldown after a decline (`TRIAL_INVITE_COOLDOWN`, `retryAt`,
the Contact window reused) → the `trial_invite` rate policy → the recipient
re-derived now (`TRIAL_BLOCKED`, `TRIAL_GUARDIAN_REQUIRED`,
`TRIAL_RECIPIENT_UNAVAILABLE`, and the M13 walls `UNDER_18_WALL` /
`VERIFIED_CLUBS_ONLY` from `visibleToOrg`) → moderation of the message and
the instructions → failure injection (`channel: 'trial'`: **nothing** is
written) → the single request writer → `planTrial` through the lifecycle
writer → one `persistNow()`.

The request carries `proposedDate` / `altSlots` (the slot days) so the
existing Inbox and respond routes work unchanged, and `slots[]` so the new
chip picker can show times and the venue name. The address and the
instructions sit in `trialDetails.private` and are stripped from every
recipient view until acceptance (D-23).

The club-side list (`GET /org/rooms/:id/trials`) returns the latest
invitation, the routing (`available, type, minor, reason`), the case gate,
the trials, `omitted`, `canWrite`, `canAssess`, `blocked`, limits and
vocabulary.

## 4. Guardian

Routing is `resolveContactRecipient` reused unchanged (P3): adult → the
player; minor → the verified, non-removed, designated guardian; no valid
route → refused, fail closed, never the child. It runs at invitation, at
acceptance (`ctx.trialAcceptGate`, before the respond route writes
anything), at schedule / reschedule / link (`reauth`), and on every
recipient route (`recipientTrial`), so a guardian whose verification was
withdrawn between two steps is refused at the next one
(`TRIAL_GUARDIAN_REQUIRED`) and a minor who became an adult is told the
trial is now theirs. Cancellation by the club needs no recipient (a safety
notice) and is allowed with a broken route.

The child's own device (`guardianManagedOnly`) cannot accept, confirm,
decline or cancel (403), and `GET /player/trials` on it returns the
five-field outcome line only (`id, orgName, workflowState, workflowLabel,
guardianManaged`) — never sessions, address, instructions or completion
detail. The child receives no `trial_day` notification; the guardian does.

## 5. Schedule

`POST /org/rooms/:id/trials/:tid/schedule` and `…/reschedule` are one
handler (`scheduleHandler`). Body: `timezone`, `sessions[1..20]` of `{ id?,
startsAt, endsAt, kind, venue, instructions? }`, `reason?`, `expectedRev`,
`clientKey?`.

Validation (`validateScheduleInput`, pure): exact IANA zone; 15 min ≤
session ≤ 12 h; no overlap; years 2000–2100; a new session must start in the
future, a carried one (existing id) may lie in the past (D-P4B-2); kinds
from the closed set; venue and instructions within limits, refused not
truncated; at most 30 revisions.

Each proposal appends a revision `{ revision, timezone, sessions, proposedAt,
proposedBy, confirmedAt, confirmedBy, supersededAt, reason, material }` and
supersedes the previous one. `materialChange()` decides whether the recipient
is asked again: a change of the organiser zone, the session count, any
session's start or end, or its venue name / town is material and clears
`confirmedAt`; a change of `kind`, `instructions` or the venue address line
alone keeps the confirmation the recipient already gave
(`requiresConfirmation: false`). An ended session, or one with attendance
recorded, must be carried unchanged; otherwise `409 TRIAL_INVALID_STATE`
with `current.sessionId`.

The recipient confirms (`POST /player|guardian/trials/:id/confirm-schedule`)
or declines (`…/decline-schedule`, optional reason). Confirmation sets
`confirmedAt` on the schedule and on the current revision, records the
recipient snapshot, and advances the case (`confirmTrial`) through the writer
with the recipient as actor, in the same save. A decline leaves the trial
`accepted` with a declined revision; the club may propose again or cancel.

Acceptance of an invitation whose chosen slot is concrete (P4B invitations
always are) creates the trial **already scheduled and confirmed** with
revision 1 = the chosen slot, because the recipient chose that day and time.

The ICS export (`GET /org/trials/:id/ics`) is session-aware: one `VEVENT`
per session, `DTSTART;TZID=`, `SEQUENCE:<revision>`, `STATUS:TENTATIVE`
until confirmed, `CONFIRMED` after, `CANCELLED` once cancelled; legacy rows
keep the whole-day export.

## 6. Sessions

A session is a row of the current revision with a stable `tses-` id that
survives revisions (the id is how attendance and evidence links stay
attached). `TRIAL_SESSION_KINDS = onboarding, training, drill, small_sided,
match, other` — contextual, not prescriptive. `GET /org/rooms/:id/trials/:tid`
projects each session with its derived attendance (`not_recorded` is derived,
never stored), its evidence links as ids, and the venue.

## 7. Attendance

`POST /org/rooms/:id/trials/:tid/sessions/:sid/attendance` — `state ∈
attended, partial, no_show, club_cancelled, player_withdrew`, optional
club-private `note` (≤ 300), `expectedRev`, `clientKey?`. Refused before the
session starts (`TRIAL_INVALID_STATE`, `current.startsAt`), with an unknown
state (`TRIAL_ATTENDANCE_INVALID`), on a trial that is not scheduled. Records
are append-only; the latest per session is current (`currentAttendance`).
The existing trial-day check-in writes the same record with `source:
'checkin'`. Attendance is *what happened*; nothing reads it as a judgement
(`m162/trust.mjs`, the matching engine and watchlists read neither
`db.trials` nor attendance), and the note reaches no family surface, no
event, no audit detail and no other club (I group sentinels).

## 8. Completion

`POST /org/rooms/:id/trials/:tid/complete` — the D-5 gate, in `canComplete()`:
the schedule is confirmed, at least one session is `attended` or `partial`,
the last session has ended. Otherwise `409
TRIAL_COMPLETION_REQUIREMENTS_NOT_MET` with `reasons[]` (`schedule_not_
confirmed`, `no_attended_session`, `last_session_not_ended`,
`trial_cancelled`, `already_completed`) — the club UI shows the same reasons
next to the disabled button. Completion writes `completion.state =
'completed'`, then asks the lifecycle validator for `completeTrial` and
writes `trial_completed` through the single writer, in the same save. A
report is still owed afterwards (`status` untouched); a completed trial with
no assessment is valid, and the M12 sweep marks `assessmentPending` once
after seven days.

Cancellation (`…/cancel` by the club with a mandatory reason; `POST
/player|guardian/trials/:id/cancel` by the recipient) writes
`completion.state = 'cancelled'` with `phase`, `cancelledBy` and the count of
attended sessions. It never moves the case anywhere: a cancelled trial is a
trial fact, not a lifecycle regression. It is the one action allowed while
the family has blocked the club (D-16) and with a broken guardian route.

## 9. Box Cam link

`POST /org/rooms/:id/trials/:tid/sessions/:sid/evidence { boxSessionId,
expectedRev }` links by reference. `linkAuthorisation()` checks, now, in
order: the id is a string; the session exists **and** belongs to this
player; its provider is not test-only in production; the org may see the
player; the Combine consent rule (`combineOrgMaySeeResults` — the player's
recruitment sharing preference or an active Combine request; *a trial is not
consent*); not withdrawn / invalidated; finalised. The first three answer
`404 TRIAL_BOXCAM_INCOMPATIBLE` alike (concealment); the last three answer
`403 EVIDENCE_CONSENT_REQUIRED`, `409 EVIDENCE_WITHDRAWN`, `409
EVIDENCE_NOT_FINAL`. The same session twice is a replay; unlinking
(`…/evidence/:eid/unlink`) tombstones the row (`removedAt`) and drops the
count; relinking creates a new row.

`GET …/evidence/candidates` lists what the club could cite now (finalised,
not withdrawn, of this player, consent evaluated now; ids and neutral metadata
only, `linked` flag) or `{ items: [], consent: false, reason }` with
`reason ∈ TRIAL_SUBJECT_REMOVED, TRIAL_BLOCKED, TRIAL_RECIPIENT_UNAVAILABLE,
EVIDENCE_CONSENT_REQUIRED` (the block named as a block — a precision the
final adversarial sweep added).

The projection (`trialEvidenceView`) carries `provenance: 'box_cam_observed'`,
`combineVerified: false` with the platform reason, the session's
verification state and `simulated` flag, and an `observation` with a
**state** and policy **copy**: `accepted` ("observed by Box Cam"),
`no_cv_result`, the CV refusal reason under "No reliable observation
available. …" (D-17: never poor performance), `evidence_withdrawn` for a
session invalidated after linking, `unavailable` for one that is gone. Never
`trace`, `nonce`, `obs.*`, frames or a numeric confidence. A link writes
nothing to the Box Cam session (the route only reads `db.boxSessions` and
`db.boxCamCvResults`) and the Passport gains no event from it (E16, D-14).

## 10. Assessments

Assessments stay in `db.assessments` behind the M12 scouting routes.
`context.trialId` (and optionally `trialSessionId`) is validated on create
(`validateTrialContext`: `400 TRIAL_CONTEXT_INVALID`, `404 TRIAL_NOT_FOUND`
/ `TRIAL_SESSION_NOT_FOUND`, `409 TRIAL_SUBJECT_REMOVED`, `403
TRIAL_NOT_PERMITTED` via `roomCan(role, 'trial_assess')`) and immutable
afterwards (`409 TRIAL_CONTEXT_IMMUTABLE`). `evidenceRefs` are whitelisted
to `{ segmentId, trialSessionId, boxSessionId, t, label }` and a
`boxSessionId` must be linked (not removed) on the trial (`400
TRIAL_EVIDENCE_REF_INVALID`). The blind rule is unchanged: `GET
/org/assessments?trialId=` and the trial detail's `assessments[]` list
existence, state and author only, filtered by the M12 rule; a second scout
never sees the first's ratings before submitting. Nothing about an
assessment moves the case; nothing in the Trial reads an assessment body.

## 11. Privacy

The privacy matrix (`M23_P4A_TRIAL_PRIVACY_MATRIX.md`) as enforced:

- **Family view** (`trialFamilyView`, `GET /player|guardian/trials`): the
  organisation, the state, the sessions with venue **and** address and
  instructions once accepted, the revision and whether it awaits their
  confirmation, the completion state and reason. Never: attendance notes,
  evidence links, assessments, the club's actors' ids, `caseId`, the
  organisation's internal history.
- **Child's device**: the outcome line (§4).
- **Invitation** (`requestForRecipient`): day, times, zone, venue name and
  town, message. Never address or instructions (D-23).
- **Club view**: everything operational; the guardian's id is not in it
  (M8b); an assessment is listed, never quoted.
- **Events** (`m182/eventRegistry.mjs`): `trial_invited, trial_accepted,
  trial_declined, trial_scheduled, trial_rescheduled, trial_cancelled,
  trial_attendance_recorded, trial_completed, trial_evidence_linked` — all
  `org_private`, payload ids only, `analyticsEligible: false`.
- **Audit** (`m182/audit.mjs`): domain `recruitment_trial`, `safeDetail`
  whitelist of ids, states, counts and flags; the subject is named only while
  the org may see them (T9: unnamed after removal).
- **Journey** (`m23/journey.mjs`): milestones (`trialMilestone`), counts,
  the timeline actions; never a note, an address or an observation.
- **Foreign organisation**: `404 TRIAL_NOT_FOUND` for trial, session,
  evidence, candidates and assessment alike.
- **Sentinel sweep** (I group, live N10): a club-private note, an assessment
  note and a cancellation reason typed by the club never reach the player's
  or guardian's trials, inbox, notifications, Passport, journey, the outbox,
  the push log, another organisation, or the audit detail — the reason does
  reach the family, by design, in the notice.

## 12. Lifecycle

P4B widens `EVIDENCE_REQUIRED` in `m17/shared.mjs` by exactly two rows:
`trial_requested ← trial_invited` and `trial_scheduled ← trial_confirmed`
(`trial_completed ← trial_completed` already existed). The provider
(`m23/evidence.mjs`) reads `db.requests` and `db.trials` and writes nothing:
a pending or accepted case-tied invitation proves `trial_invited`; a
structurally sound trial for this case whose derived state is `scheduled`
with `confirmedAt` and ≥ 1 session proves `trial_confirmed`; a completed one
proves `trial_completed`. `legacy_accepted` proves neither of the last two; a
report is not completion; a tombstoned trial still answers (D-26).

The case moves through `advanceCase()` → `canTransitionRecruitmentCase` →
`applyLifecycleTransition`, with `lifecycleAction`, `policyVersion` and the
triggering id on the `room_status_changed` history entry. Recipient-driven
moves name the recipient as actor. `trial_in_progress` is not a status;
`decisionPending` and `trialActive` stay derived conditions.

## 13. Events

Nine registry entries (§11). `broadcast()` after `persistNow()`, never
before. SSE carries ids only; the client reloads through the API.

## 14. Notifications

One notification type on the family side, `trial_day` (an existing category,
so preferences and grouping apply unchanged): schedule proposed / revised /
details updated (times unchanged) / cancelled / completed. Routed to the
recipient of record re-derived now (`recipientAudience`); a minor's guardian,
never the child. Club side: `trial_day` to the room owner and lead when the
recipient accepts, declines, confirms, declines a schedule or cancels (not to
the user who acted). The legacy `trial_report` notification is suppressed for
player and guardian while the family has blocked the club (D-16); the report
itself is still filed.

The M12 sweep (`m12/operations.mjs`): a T-48h reminder per session per
revision (`t48:<sessionId>:<revision>`, skipped while blocked),
`completionPending` once when the last session ended more than 24 h ago on a
still-scheduled trial, `assessmentPending` once when a completed trial has no
assessment after seven days. Markers persist; a restart does not re-send
(`m23TrialPersistence` §4, `m23TrialE2E` Z group).

## 15. Errors

`m23/errors.mjs` — every Trial code sits in one band and is swept by the
drift guard: **400** `TRIAL_SCHEDULE_INVALID, TRIAL_TIMEZONE_INVALID,
TRIAL_VENUE_INVALID, TRIAL_SLOTS_INVALID, TRIAL_CONTENT_INVALID,
TRIAL_CLIENT_KEY_INVALID, TRIAL_REV_REQUIRED, TRIAL_ATTENDANCE_INVALID,
TRIAL_EVIDENCE_REF_INVALID`; **403** `TRIAL_NOT_PERMITTED, TRIAL_BLOCKED,
EVIDENCE_CONSENT_REQUIRED`; **404** `TRIAL_NOT_FOUND,
TRIAL_SESSION_NOT_FOUND, TRIAL_BOXCAM_INCOMPATIBLE`; **409**
`TRIAL_INVALID_STATE, TRIAL_CASE_STATE, TRIAL_VERSION_CONFLICT,
TRIAL_IDEMPOTENCY_CONFLICT, TRIAL_COMPLETION_REQUIREMENTS_NOT_MET,
TRIAL_SUBJECT_REMOVED, TRIAL_ALREADY_INVITED, EVIDENCE_NOT_FINAL,
EVIDENCE_WITHDRAWN`; **422** `TRIAL_RECIPIENT_UNAVAILABLE,
TRIAL_GUARDIAN_REQUIRED`; **429** `TRIAL_INVITE_COOLDOWN` (deterministic,
`retryAt`) plus the limiter's `RATE_LIMITED`; **500** `TRIAL_STATE_UNKNOWN,
TRIAL_STORE_MISSING`; and `TRIAL_TRANSPORT_REFUSED` for the injected
failure. The M12 scouting routes add `TRIAL_CONTEXT_INVALID` (400) and
`TRIAL_CONTEXT_IMMUTABLE` (409). Every refusal names a code; a body that is
not an object, prototype keys, wrong types and over-long text are refused
before anything is read (X group).

## 16. Concurrency

`expectedRev` is **required** on every club mutation of an existing trial
and, when sent, honoured on the recipient routes. It is a JSON integer ≥ 0
or it is refused `400 TRIAL_REV_REQUIRED` — `"3"`, `3.5`, `-1`, `{}` and
`[]` are not coerced (the shared guard folds numeric strings; the Trial does
not). Stale → `409 TRIAL_VERSION_CONFLICT` with `current.workflowState`. The
C group proves the six races the plan named: accept vs cancel, schedule vs
decline, reschedule vs attendance, completion vs cancellation, double link,
assessment submit vs trial correction (the assessment has its own rev).

## 17. Idempotency

Keys per action (`invite, schedule, cancel, attendance, complete, link`)
with a payload fingerprint stored on the record: same key + same payload
replays (`idempotent: true`, no second event, no second notification); same
key + different payload → `409 TRIAL_IDEMPOTENCY_CONFLICT`; keys are scoped
to the case, so another organisation's identical key collides with nothing.
Replays survive a restart (Z group, persistence §4). Confirmation, decline
and recipient cancellation are idempotent by state (a second call answers
`idempotent: true`). Every write is one `persistNow()`: acceptance + trial
row + case advance + notification, or nothing (F group with the `trial`
failure channel).

## 18. Clients

**Club (Pro and Grassroots, identical files):** a page-local **Trial** tab
in the Room (`roomsScreens.tsx` → `trialPanel.tsx`), reached through
Recruitment → Pipeline → Trials or the Room itself; no new top-level
navigation (`navConfig`, `navLive` unchanged and green). The tab shows the
routing sentence (player / guardian, never the child), the case gate, the
read-only note for viewers and contributors, the block notice with
cancel-only, the invitation composer (organiser zone, venue, up to three
slots on distinct days, message, private address and instructions), each
trial as a card with state, sessions, attendance recording, schedule
revision with the material-change rule explained, the completion button
disabled with the server's reasons, cancellation behind a destructive
confirmation, Box Cam citation from the consent-gated candidates list with
the observation state and "Combine Verified: no", assessments listed as
existing only with a door to open one in Trial context, and the history.
`screens.tsx` (Trials) shows the workflow state and links into the Room.
Demo mode mirrors the API in `roomsDemo.ts` (P4A-D3 closed). EN and FR
complete; parity enforced by the type of the FR table.

**Player app:** `components/M23Trial.tsx` — `TrialWorkflowSection` in
Opportunities (adult) and the guardian view (confirm / decline a proposed
schedule, cancel with a reason), `TrialSlotChips` in the Inbox invitation
(day, times in the organiser zone, venue name; picking a chip chooses the
day the server accepts). A minor's own device renders the outcome line only.
390 px and 360 px without horizontal scroll; every control labelled.

## 19. Tests

`m23TrialE2E` — 20 groups (U, P, HTTP, J, V, S, A, M, W, B, K, C, F, E, Q,
I, N, X, T, L, Z), 535 checks, 331 negative (62 %). `m23TrialPersistence` —
4 sections, 36 checks. `m23TrialPerf` — 20 sessions × 0/5/20 links, +400
cases, scan audit (≤ 5 touches per collection per journey), index decision:
not added. `m23TrialLive` — adult A1–A12, accessibility A13 (tab semantics,
keyboard, focus, live region), French A14, minor M2–M8, negatives N1–N15,
390/360 px, labels, no page errors, 122 checks (53 negative). The M15, M20
and M23 suites that read trials were extended, not weakened (Passport
`trial_attended` re-keyed on attendance; `trial_process` metric with two
negative checks).

## 20. What P4B deliberately does not do

No Offer workflow (§221). No new Box Cam capture, protocol, CV change or
M22 route change (§222; P4A-D6 stays open). No withdrawal of a pending
invitation by the club (no new request status; the recipient answers or the
invitation stays pending — the plan's D1 question, decided against a
contract change). No aggregate score, rating or "trial result" anywhere. No
`trial_in_progress` status. No push. Real-world validation of the CV
pipeline remains **not** completed; Combine Verified production-capable
remains **NO**.
