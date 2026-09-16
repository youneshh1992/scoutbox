# M23 P4A — Final Architecture: Trial + Box Cam Integration

The implementation contract for M23 P4B. Everything here was decided from
the current source (tip `61cfa75` + the P4A-D9 fix) and is cross-referenced
to `M23_P4A_TRIAL_BOXCAM_REUSE_AUDIT.md` (what exists),
`M23_P4A_DECISION_REGISTER.md` (why), `M23_P4A_TRIAL_PRIVACY_MATRIX.md` (who
sees what), `M23_P4A_BOXCAM_CHANGE_CLASSIFICATION.md` (what Box Cam may
change) and `M23_P4A_TRIAL_TEST_PLAN.md` (how it is proven).

> Trial is an operational workflow, Box Cam is an evidence source, human
> assessment is judgement, and recruitment decision is a separate act.

---

## 1. Canonical entities

| entity | store | owner | what it is |
|---|---|---|---|
| Recruitment case | `db.recruitmentCases` | M12/M17/M23 | The coarse lifecycle (`… contacted → trial_requested → trial_scheduled → trial_completed → …`). Unchanged. |
| Trial | `db.trials` (extended) | core / P4B | One accepted trial of one player by one club for one case: invitation reference, workflow state, schedule with sessions, attendance, completion, evidence links, history. |
| Invitation | `db.requests` (`type: 'trial'`) | core | The recipient-visible object; Inbox delivery; accept/decline with slot; extended with `caseId` and (after acceptance) `trialId`. |
| Trial day | `trial.day` | M12 F9 | Safety staff + checks, consents, arrival, emergency contact, check-ins, collection, status events. Unchanged. |
| Scouting assessment | `db.assessments` (+ `context.trialId`) | M12 F2 | Human judgement, blind, immutable after submit, per-attribute compare, single door to the player. |
| Feedback report | `trial.report` | M12 | The mandatory six-field report + notes to the player. Unchanged. |
| Box Cam session / CV result | `db.boxSessions`, `db.boxCamCvResults` | M16/M22 | The player's own evidence record. **Unchanged.** |
| Room decision | `db.roomDecisions` | M17 | The recruitment act. Unchanged. |

No new store. One additive migration (§12).

## 2. Data relationships (textual diagram)

```
Recruitment Case (db.recruitmentCases)  ──status──▶  trial_requested / trial_scheduled / trial_completed
        │  caseId
        ▼
      Trial (db.trials, one row = one accepted trial)
       │ requestId ─────────── Invitation (db.requests type:'trial', caseId, trialId after acceptance)
       │                            └── Inbox delivery, accept/decline, slot, reply, block rules
       │ schedule ──────────── revisions[] (append-only) · timezone · confirmedAt
       │      └── sessions[] { id, kind, startsAt, endsAt, venueRef, arrival, evidence[] }
       │                └── evidence[] { kind:'box_cam_session', id } ──▶ db.boxSessions / db.boxCamCvResults (player-owned, untouched)
       │ attendance[] ─────── { sessionId, state, source, recordedBy }  ◀── day.checkins (M12)
       │ completion ───────── { state: completed|cancelled, at, by, reason }
       │ day ──────────────── staff/checks · consents · arrival · emergency · checkins · statusEvents (M12, unchanged)
       │ report ───────────── legacy feedback report (M12, unchanged)
       │ history[] · keys{} · rev
       │
       ├── Scouting assessments (db.assessments, context.trialId) ── evidenceRefs ▶ video segments | box_cam_session | trial_session
       │
       └── Recruitment lifecycle evidence ◀── evidence provider reads: invitation (trial_invited), schedule.confirmedAt (trial_confirmed), completion (trial_completed)

Room (case.room) ── links.trialIds (existing) · tasks{linkedResource:'trial'} · Trial tab (page-local)
```

## 3. State ownership

| truth | owner | written by | never written by |
|---|---|---|---|
| case status | case | `ctx.applyLifecycleTransition` (single writer) via `planTrial/confirmTrial/completeTrial` with evidence | Trial routes directly, clients |
| invitation status | request | respond routes (existing), Trial writer (withdraw) | Trial row |
| `workflowState` | Trial | Trial writer only | requests, case |
| schedule + revisions | Trial | `schedule`/`reschedule` routes; acceptance (slot) | recipient directly (they confirm/decline a revision) |
| attendance | Trial | `attendance` route; check-in (M12) | Box Cam |
| completion | Trial | `complete`/`cancel` routes | assessment, report |
| observations | Box Cam session / CV result | M16/M22 only | Trial, assessment, humans |
| assessment content | assessment | its author, until submitted | Trial, Box Cam |
| decision | room decision | `recordDecision` | assessment, Trial |

### Trial `workflowState`

```
(invitation pending — no row)     invited ──declined──▶ (no row; request declined)
                                      │ accepted (slot concrete? → scheduled : accepted)
                                      ▼
   accepted ──schedule confirmed──▶ scheduled ──reschedule──▶ accepted (until re-confirmed)
       │                                │ complete (attendance ∧ last session ended)
       │ cancel                         ▼
       ▼                            completed (final)
   cancelled (final) ◀──cancel── (from accepted/scheduled; keeps attendance)
   legacy_accepted  (pre-P4B rows; read-only interpretation)
```

Case coupling: `invited → trial_requested` (at invitation issue), `scheduled
→ trial_scheduled` (at confirmation), `completed → trial_completed` (at
completion). Decline, reschedule, cancel, attendance, assessment move the case
**nowhere**; the club decides the next case step by hand (hold, shortlist,
archive with reason), as the frozen table already allows from every trial
state.

## 4. Evidence gates (the three answers the provider gives)

| kind | satisfied when | source | not satisfied reasons |
|---|---|---|---|
| `trial_invited` (new table entry, D-3) | a `db.requests` row `type:'trial'`, `caseId === case.id`, `status ∈ {pending, accepted}`, issued through `issueRecruitmentRequest` | requests | `no_invitation`, `requests_store_unavailable` |
| `trial_confirmed` | a Trial row for the case with `schedule.confirmedAt` and ≥ 1 concrete session, `workflowState === 'scheduled'`, integrity-sound | trials | `no_confirmed_schedule`, `trials_store_unavailable` |
| `trial_completed` | a Trial row for the case with `completion.state === 'completed'`, integrity-sound | trials | `no_completed_trial`, `trials_store_unavailable` |

Fail closed on missing store, corrupt row, or a row that belongs to another
case. Legacy rows: `trial_confirmed` is **not** satisfied by `legacy_accepted`
(no confirmed schedule exists); a club with a legacy trial confirms a
schedule in P4B to reach `trial_scheduled`. `trial_completed` is not
satisfied by `reported` (a report is not completion).

## 5. Recipient rules (D-6, D-7)

`resolveRecipient(player, org, guardians, now)` = the P3 resolver, unchanged:
adult → player; minor → exactly one verified guardian or the designated one;
none → `TRIAL_GUARDIAN_REQUIRED` (422); blocked → `BLOCKED`/`TRIAL_BLOCKED`
(403); not visible → `TRIAL_RECIPIENT_UNAVAILABLE` (422). Run at invitation,
acceptance, schedule confirmation, every reschedule, every evidence link, and
assessment creation (the last only to enforce visibility, not routing). The
recipient snapshot `{ type, playerId, guardianId, minor, at }` is recorded on
every step that involved the recipient.

## 6. Safeguarding

- Agencies never see, invite, schedule or assess minors (`visibleToOrg`).
- Unverified clubs never do either; verification loss mid-flow → cancel only.
- Minor invitations route to the verified guardian; the child sees the
  guardian-managed outcome line; the child-facing outcome notification is the
  `guardian_decision` type in the `messages` category ("Messages and
  requests", on by default) — closed in the P4A closure pass (P4A-D10), not
  left to P4B. P4B's `trial_day` notices keep using `trial_updates`.
- Venue exact address, arrival and contact person after acceptance only; for
  minors to the guardian only (D-23).
- Family emergency contact: day view only, withheld while blocked (P4A-D9).
- Check-in keeps the M12 gates (reviewed staff check + the right consent).
- Block policy (D-16): cancel with notice allowed; every other club action
  refused; no renewed solicitation.
- Legal review flags: Trial-specific footage/observation acknowledgement for
  minors; whether the existing event consent scope should name Box Cam
  explicitly. P4B does not resolve these; it must not claim they are.

## 7. Box Cam integration

Reference only, Trial-side (`sessions[].evidence[]`); N1–N6 of the change
classification; nothing written on `db.boxSessions`; link authorisation =
same player + finalised + not withdrawn + not test-only in production +
`orgCanSee` + (recruitment opt-in ∨ active request); provenance read live;
refusal shown as "no reliable observation available"; confidence never
rendered; experimental count only behind the existing disclosure wording;
multi-player footage is not observable and the Trial says so; Combine
Verified stays blocked and the block reason is carried unchanged. Box Cam 2.0
(F1–F9) is out of P4B.

`trialEvidenceView(link)`:
```
{ id, kind: 'box_cam_session', trialSessionId, linkedAt, linkedBy: { name },
  session: { drillId | protocolId, capturedAt, verificationState, simulated, invalidated },
  observation: { state: 'accepted' | <refusal code> | 'unavailable', copy, qualityState, experimental: { status } } | null,
  provenance: 'box_cam_observed', providerVersion, engineVersion, cvPolicyVersion,
  combineVerified: false, combineVerifiedBlockedBy }
```
Never: `trace[]`, `nonce`, `obs.*`, numeric confidence, frames.

## 8. Assessment integration

`db.assessments` with `context.trialId` (+ `trialSessionId`); evidence refs
may cite `{ segmentId }` (existing), `{ boxSessionId }` (must be linked to
that Trial), `{ trialSessionId }`. Blind rule, compare, immutability,
`publishedFeedback` inherited. No aggregate. The legacy feedback report stays
mandatory and separate. Human annotations on an observation are assessment
notes that **reference** the observation (`evidenceRefs[].note`), never a
mutation of the observation (§52–§53).

## 9. Passport policy (D-14)

Observations: referenced, not promoted (the player's own session projection
is unchanged). Participation: `trial_attended` keyed on recorded attendance;
legacy rows flagged. Outcome: the legacy `trial_outcome` unchanged (date
read from `filedAt`, closing P4A-D2). Assessments: existence-only event and
`publishedFeedback` only. Provenance line "captured during a trial at Club X"
only behind an explicit player/guardian selection, later.

## 10. Trust, Development, Second Look, Nobody Missed, Matching

- Trust (M16.2): no new input; the legacy `computeTrustScore` is untouched;
  the Trial UI reads neither.
- Development Hub: post-decision recommendations may reference
  `trial_report`/`box_cam_session` evidence as today; no Trial checklist there.
- Second Look / Nobody Missed: unchanged in P4B; recommendation D-24 for a
  later M18 pass (key on completion; "completed but not evaluated").
- Matching / watchlists: unchanged; no trial or assessment criterion.

## 11. Privacy and roles

Privacy: `M23_P4A_TRIAL_PRIVACY_MATRIX.md`. Roles via `roomCan`:

| action | recruitment lead | room lead | scout (contributor) | viewer | adult player | guardian | minor | T&S |
|---|---|---|---|---|---|---|---|---|
| create Trial (send invitation) | ✓ | ✓ | — | — | — | — | — | — |
| invite (same) | ✓ | ✓ | — | — | — | — | — | — |
| accept / decline / reply | — | — | — | — | ✓ (own) | ✓ (child) | — | — |
| schedule / confirm schedule | ✓ | ✓ | — | — | confirm only | confirm only | — | — |
| reschedule | ✓ | ✓ | — | — | re-confirm only | re-confirm only | — | — |
| cancel | ✓ | ✓ | — | — | ✓ (own) | ✓ (child) | — | — |
| mark attendance | ✓ | ✓ | ✓ (check-in as today) | — | — | — | — | — |
| complete | ✓ | ✓ | — | — | — | — | — | — |
| link Box Cam | ✓ | ✓ | — | — | — | — | — | — |
| assess | ✓ | ✓ | ✓ | — | — | — | — | — |
| view private assessment | ✓ (all) | ✓ (all) | own + others after own submission | — | — | — | — | on request |
| view shared Trial information | ✓ | ✓ | ✓ | ✓ | own | child's | outcome line | ✓ |

`roomCan` gains `trial_view: 0`, `trial_write: 2`, `trial_assess: 1`; the
reserved `request_trial: 2` is used for invitation. No Trial-specific roles.

Re-authorisation contract (§102): every mutation re-checks role, org
membership (`removedAt`), player visibility, block, guardian validity, club
verification, and case state — in that order, before any write.

## 12. Persistence recommendations (D-20)

| store | field | purpose | migration | backward compatible | reader impact | index |
|---|---|---|---|---|---|---|
| `trials` | `caseId` | evidence per case | 2304 adds `null`; new rows set it | yes (null = legacy, resolved via `room.links.trialIds`) | journey/evidence use it when present | no |
| `trials` | `workflowState` | operational state | adds `'legacy_accepted'` when absent | yes | `trialStateFor` unchanged; new readers only | no |
| `trials` | `schedule { timezone, revision, confirmedAt, sessions[], revisions[], legacy? }` | timezone-aware schedule + sessions | adds `null` (legacy derived on read from `proposedDate`) | yes | ICS/feed/day read `proposedDate` as today until P4B-3 switches them | no |
| `trials` | `attendance[]` | per-session attendance | adds `[]` | yes | none | no |
| `trials` | `completion` | completed/cancelled | adds `null` | yes | none | no |
| `trials` | `recipient` snapshots in `history[]` | routing proof | adds `[]` | yes | none | no |
| `trials` | `keys`, `rev`, `revAt`, `revBy`, `history[]` | idempotency, concurrency, audit | adds `{}`/`1`/`[]` | yes | none | no |
| `trials` | `reminders { ... }` | persisted reminder markers | adds `{}` | yes | M12 sweep reads them | no |
| `requests` | `caseId`, `trialId` | invitation ↔ case/trial | none (optional) | yes | `requestForRecipient` must strip both | no |
| `assessments` | `context.trialId`, `context.trialSessionId`, `evidenceRefs[].boxSessionId / trialSessionId` | Trial context | none (optional) | yes | compare view filters by trial when asked | no |
| `roomCan` table | `trial_view/write/assess` | roles | code | yes | — | — |
| rate policies | `trial_invite 30/h/org`, `trial_schedule 60/h/org`, `trial_response 30/h/actor`, `trial_evidence_link 60/h/org`, `trial_attendance 120/h/org` | limits | code | yes | — | — |
| event registry | 9 events (§14) | events | code + `EMITTED_EVENTS` | yes | boot assertion | — |
| audit | domain `recruitment_trial` | audit | code | yes | — | — |
| `STATUS_EVIDENCE_REQUIRED` | `trial_requested: trial_invited` | gate | code | **the one P2 table widening**; recorded | `planTrial` becomes evidence-gated | — |
| store contract | none | — | — | — | — | — |
| **new stores** | **none** | | | | | |

Deletion cascade (D-26): `deletePlayerData` tombstones trials (keeps
`id/orgId/caseId/playerId`, `workflowState`, `attendance` states, `completion`;
removes `playerName`, `notes`, `venue`, `day.emergency`, `day.arrival`,
`report` notes, evidence links) instead of filtering them out, so the case's
history and evidence stay honest.

## 13. API recommendations (existing conventions: org router, room-scoped, `sendDomainError`)

| route | role | notes |
|---|---|---|
| `GET /org/rooms/:id/trials` | `trial_view` | trials for the case (usually one), routing, case gate, canWrite, limits, policy version |
| `POST /org/rooms/:id/trials` | `trial_write` | **invitation**: slots (≤ 3, each a UTC instant + tz), venue name/town, message; case gate (`contacted`, `under_review`, `shortlisted`, `priority`, `on_hold` → the existing in-edges of `trial_requested`); recipient rule; moderation; one transaction: request row + case advance + notification; `clientKey` |
| `POST /org/rooms/:id/trials/:tid/schedule` | `trial_write` | confirm/propose a schedule revision (sessions); `expectedRev` |
| `POST …/:tid/reschedule` | `trial_write` | new revision; clears `confirmedAt`; recipient re-confirmation |
| `POST …/:tid/cancel` | `trial_write` | with reason; block policy applies |
| `POST …/:tid/sessions/:sid/attendance` | `trial_write` (check-in stays on the M12 route) | state + note |
| `POST …/:tid/complete` | `trial_write` | completion rules (D-5) |
| `POST …/:tid/sessions/:sid/evidence` | `trial_write` | link a Box Cam session (N2) |
| `GET …/:tid/evidence` | `trial_view` | `trialEvidenceView[]` |
| `POST /org/assessments` (existing) | `trial_assess` via Room | with `context.trialId` |
| `POST /player|guardian/requests/:id/respond` (existing) | recipient | slot validation (`TRIAL_SLOT_INVALID`), reply, block rule; creates the Trial row through the single Trial writer `issueTrial` |
| `POST /player|guardian/trials/:id/confirm-schedule` · `/decline-schedule` · `/cancel` | recipient | re-confirmation and recipient cancellation |
| `GET /player|guardian/trials` (existing family view) | recipient | extended with schedule/attendance/completion |
| `GET /org/recruitment/trial-policy` | any org user | vocabulary |

Error codes join the M23 table (no default branch): `TRIAL_*` in the same
bands as `CONTACT_*`; `TRIAL_COMPLETION_REQUIRES_ATTENDANCE` 409,
`TRIAL_SCHEDULE_INVALID` 400, `TRIAL_SLOT_INVALID` 400,
`TRIAL_GUARDIAN_REQUIRED` 422, `TRIAL_RECIPIENT_UNAVAILABLE` 422,
`TRIAL_BLOCKED` 403, `TRIAL_NOT_PERMITTED` 403, `TRIAL_NOT_FOUND` 404,
`TRIAL_INVALID_STATE` 409, `TRIAL_VERSION_CONFLICT` 409,
`TRIAL_IDEMPOTENCY_CONFLICT` 409, `TRIAL_REV_REQUIRED` 400,
`EVIDENCE_NOT_FINAL` 409, `EVIDENCE_WITHDRAWN` 409,
`EVIDENCE_CONSENT_REQUIRED` 403, `TRIAL_STATE_UNKNOWN` 500.

## 14. Events, notifications

Events (org_private, `org_internal`, payload `['orgId','roomId','trialId']`,
dedupe none, replay never): `trial_invited`, `trial_accepted`,
`trial_declined`, `trial_scheduled`, `trial_rescheduled`, `trial_cancelled`,
`trial_attendance_recorded`, `trial_completed`, `trial_evidence_linked`.
`trial_assessment_submitted` is the existing `feedback` domain event with
`playerId` only. Recipient side keeps the existing `request`/`inbox` events.
Audiences: all nine are club-private; T&S reads the audit log, not events;
analytics reads none of them (counts come from the store, small-n applied).

Notifications (existing types): invitation → `request` (recipient),
schedule/reschedule/cancel → `trial_day` (recipient; guardian for minors;
child outcome via `trial_updates`), reminders → `trial_day` at T-48h/T-24h
(persisted markers, M12 sweep), completion pending / assessment outstanding
→ `trial_day` to the room lead, assessment submitted → `feedback` (club
only). Deep links: `refId = request.id` for the recipient, `trial.id` for
the club (`open_trial` → Room Trial tab), never a case id to a recipient.

## 15. Concurrency, idempotency, atomicity

Independent `rev` on the Trial (`guardRev`), the assessment (existing), and
nothing on the Box Cam session (read-only from the Trial). Keys with payload
fingerprints per action (`keys.invite/accept/schedule/reschedule/cancel/
attendance/complete/link`), stored on the Trial (or on the request for
`invite`), surviving restart. Atomic transactions: invitation (request +
case advance + notification); acceptance (request status + Trial row +
schedule + case advance + channel + notification); completion (Trial +
case advance); cancel (Trial + notification). Failure injection point:
`channel: 'trial'` on the existing admin inject route, exercised on
invitation and acceptance.

## 16. UI placement (P2.5 IA frozen)

Pro/Grassroots: Recruitment → Pipeline → **Trials** (existing `#/trials`
list, extended) and Recruitment Room → **Trial** page-local tab (after
Contact, before Activity): invitation, schedule/sessions, attendance,
evidence list (with "Create Box Cam assignment for this session" and "Link
existing session"), assessments (existing components in Trial context),
completion; the condensed Room header is untouched. Player: Opportunities →
**Trials** (family view) and Inbox (invitation + slot picker + reply);
guardian screen the same. No new top-level destination. 390px: every Trial
surface fits (the P3 patterns: no horizontal scroll, page-local tab strip,
labelled inputs, ≥ 34px targets, live region).

## 17. Test architecture

`M23_P4A_TRIAL_TEST_PLAN.md`: groups A–O, persistence suite, perf script,
live suite with negatives; the frozen suites unchanged; ≥ 55% negative.

## 18. Data-flow and trust boundaries (§137–§138)

```
Camera pixels ──(gray8 frames, HTTP, nonce-bound)──▶ Box Cam engine (m22)   [MACHINE OBSERVATION]
      │ never persisted                                      │
      ▼                                                      ▼
observation record (db.boxCamCvResults / session aggregates) [MACHINE OBSERVATION, player-owned]
      │ reference only (N1)
      ▼
Trial context (db.trials.sessions[].evidence[])              [SERVER-DERIVED CONTEXT: identity = who was invited & accepted,
      │ projection (N3), refusal semantics (N4)                never who the camera saw]
      ▼
Human assessment (db.assessments, context.trialId)           [HUMAN-ENTERED JUDGEMENT, club-private]
      │ evidenceRefs by id
      ▼
Recruitment Room (case, decisions)                           [INTERNAL-ONLY CLUB INFORMATION]
      │ recordDecision (human)
      ▼
Decision (db.roomDecisions)                                  [INTERNAL-ONLY; reason codes, no scores]

Recipient-shared Trial information (request, schedule after acceptance, attendance, cancellation)  [SHARED — the only outward edge]
```

Boundaries: machine observation never crosses into judgement; server-derived
context never claims recognition; human judgement never crosses to the
recipient except `publishedFeedback`; internal club information never leaves
the org; the shared edge is the family view and the Inbox, both routed by
the recipient rule.

## 19. What P4B must not do

No `trial_*` case statuses beyond the three frozen ones; no `decision_pending`
status; no second trial store; no `trialReviews`/`boxCamAssessment`; no
`trialId` on Box Cam sessions; no copied observation payloads; no retained
frames; no numeric confidence, score, potential or ranking; no face
recognition; no Combine Verified implication; no Offer semantics; no new
top-level navigation; no widening of `db.trials.status`.
