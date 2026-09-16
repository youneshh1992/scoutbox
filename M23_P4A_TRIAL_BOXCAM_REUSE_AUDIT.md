# M23 P4A — Trial + Box Cam Reuse Audit

Read-across of every canonical system a Trial workflow would touch, done
before any model is designed, so that P4B reuses what exists and adds only
what the audit proves missing. Every claim cites the file and line it was
read from on tip `61cfa75`.

> Observed ≠ Assessed ≠ Decided. Box Cam observes. Humans assess. The
> recruitment workflow records decisions.

Part A inventories the systems. Part B is the requirement-by-requirement
reuse table. Part C is the existing `trials` store audit (§5–§7 of the
mandate) in full. Part D lists what the audit proves is genuinely missing.

---

## Part A — Canonical system inventory

| # | system | canonical owner | what it is today | Trial relevance |
|---|---|---|---|---|
| A1 | `db.trials` | `server.mjs` (two writers), `storeContract.mjs:154` (`migration`/`core`) | The **accepted** trial: created only when the recipient accepts a `type:'trial'` request (`server.mjs:1297-1313` guardian, `:2866-2880` adult). `status ∈ {awaiting_report, reported}` — a report obligation, not a schedule. Fields: `id, requestId, playerId, playerName, orgId, orgName, scoutName, acceptedAt, guardianApproved (guardian path only), proposedDate (date string), venue, notes, reportDueAt, status, report?, day?, reminderSent?, feedbackEscalatedAt?`. | **The canonical Trial object.** Extend additively (Part C). |
| A2 | `db.requests` + `issueRecruitmentRequest` | `server.mjs:1835-1879` (single writer, P3), respond routes `:1263`, `:2836` | The recipient-visible invitation: `type: 'contact'|'trial'`, `trialDetails { proposedDate, altSlots[≤2], venue, notes }`, `routedTo`, `guardianId`, `status pending→accepted|declined|suspended`, `chosenSlot` on accept, channel opened on accept, `requestForRecipient` projection strips `orgId/userId/contactId`. | **The Trial invitation and its Inbox delivery.** Reuse unchanged for transport; extend with the verified-guardian rule and a `trialId`/`caseId` back-reference. |
| A3 | `db.assessments` (M12 F2) | `m12/scouting.mjs` | Template-versioned, per-attribute 1–5 or `notObserved`, `confidence`, `evidenceRefs` → `db.videoSegments`, `state draft→submitted→reviewed`, immutable after submit, blind-until-you-submit rule, second opinions, per-attribute compare that excludes `notObserved` and refuses cross-version averages, `publishedFeedback` as the **only** door to the player. No `caseId/roomId/trialId`. | **Owns Trial assessment** (extend with an optional `trialId` context). |
| A4 | Trial performance report (M12) | `server.mjs:2129-2179`, `domain.mjs:156-174` | `trial.report` with six mandatory numeric fields incl. `coachRating` 1–10, `strengthNote/focusNote` to the player, copied onto `player.trialReports`, feeds the **legacy** `computeTrustScore`, gate `REPORTS_OUTSTANDING` blocks new trial requests org-wide while any trial is `awaiting_report`. | The existing player-feedback obligation. Kept as is; **not** the scouting judgement (A3 is). See D-9/D-17. |
| A5 | `db.recruitmentCases` + lifecycle | `m17/shared.mjs`, `m23/lifecycle.mjs`, `m23/index.mjs` (single writer) | 18 statuses incl. `trial_requested → trial_scheduled → trial_completed`; evidence keyed by target (`trial_confirmed`, `trial_completed`); actions `planTrial/confirmTrial/completeTrial` (room_lead+); evidence provider answers `not_implemented` for trial kinds (`m23/evidence.mjs:107-108`); derived `decisionPending`, `trialActive`. | The coarse case lifecycle. **Unchanged**; P4B supplies two evidence kinds. |
| A6 | Recruitment Rooms (M17) | `m17/rooms.mjs`, `m17/shared.mjs` | `roomCan` with **`request_trial: 2` declared and unused** (`m17/shared.mjs:603`); `room.links.trialIds[]` + `room_trial_linked` activity (`m17/rooms.mjs:1245-1253`); `trialStateFor()` readiness; room tasks with `LINKED_RESOURCE_TYPES` containing `'trial'`; page-local tabs. | Role hook, room↔trial link, tasks, tab placement. Reuse. |
| A7 | Room decisions | `m17/rooms.mjs:1062-1087` | Append-only supersession chain, reason taxonomy incl. `trial_needed`, `trial_outcome`; human judgement never derived from scores. | The recruitment decision. Unchanged; Trial only supplies evidence/context. |
| A8 | Contact (M23 P3) | `m23/contact.mjs`, `m23/contactRoutes.mjs` | `resolveContactRecipient` (verified-guardian rule, fail closed), keys+fingerprint idempotency, cooldown, `caseAcceptsContact`, `advanceCase` via the canonical writer, `contactView`, sentinel-proven isolation. | The pattern and the prerequisite: `contacted` is the gate into `trial_requested`. Reuse the resolver and the patterns. |
| A9 | Football Passport (M15) | `m15/passport.mjs`, `m15/shared.mjs` | Projection, never storage; provenance ladder; narrowing-only visibility; trial events `trial_attended` (`recruitment_own_org`, public-eligible by selection) and `trial_outcome` (`private_own_org`); assessments existence-only; Box Cam sessions `private`; no numeric score. | Decides what of a Trial the Passport shows. Reuse rules; re-key `trial_attended` on attendance. |
| A10 | Evidence (M12/M13) | `db.evidence`, `db.videoSegments`, M13 F6 `m13/insight.mjs:335-529` | Claims/tiers; segments annotate media; evidence-gap engine reads assessments, never trials. | Assessment `evidenceRefs` reuse; evidence-gap could add a trial rule later (§58). |
| A11 | Box Cam (M16) + real CV (M22) | `m16/sessions.mjs`, `m22/*.mjs` | Player-minted sessions; no org/case/trial field; aggregates + `db.boxCamCvResults`; refusal vocabulary; no frames persisted; T&S dispute loop; `combineVerifiedProtocols() === []`. Full audit in `M23_P4A_BOXCAM_CHANGE_CLASSIFICATION.md` §1. | Evidence source, optional. Link by reference from the Trial. |
| A12 | Combine (M16.1) | `m16/combine.mjs`, `combineShared.mjs` | Club requests, player attempts, consent rule (`m16/combine.mjs:581-586`), production-valid excludes test providers, "a room is not consent". | Consent rule reused for Trial links. |
| A13 | Trust Score (M16.2) | `m162/trust.mjs`, `m162/shared.mjs` | Never stored; trials **not** an input; assessments by attribution only; Box Cam sub-capped; legacy `computeTrustScore` still weights trial reports. | Trial must not change either number. |
| A14 | Development Hub (M21) | `m21/*.mjs` | Plans/goals/actions; `EVIDENCE_SOURCES` includes `trial_report`, `box_cam_session`, `combine_attempt`; player-facing. | Post-decision recommendations only (§64). Not the Trial checklist. |
| A15 | Outcome reports / signings | `m12/operations.mjs`, `server.mjs:2194-2206` | Post-signing follow-ups; no trial link. | Unchanged. |
| A16 | Notifications | `server.mjs:634-678`, `m182/notificationPrefs.mjs`, `m13/delivery.mjs` | `notify(audience, type, text, refId)`; categories incl. `trial_updates` (`open_trial, trial_day, trial_report, report_due`); quiet hours; minors' external channels routed to the guardian; deferred push. | Reuse: `trial_day` and `request` types cover invitation, schedule change, cancellation. |
| A17 | Inbox | `server.mjs:1257`, `:2833`; player app `inbox.tsx`, `guardian.tsx` | Requests list with slot picker for trials, accept/decline, P3 reply field. | Reuse for the invitation response. |
| A18 | Event registry | `m182/eventRegistry.mjs`, `EMITTED_EVENTS` | No `trial_*` event; `requests`/`inbox` coalescing events exist; contact events are the P3 precedent (org_private, ids only). | Add Trial events in P4B by the P3 pattern. |
| A19 | Audit log | `m182/audit.mjs` | Domains room/brief/watchlist/development/contact/organisation; `safeDetail` allowlist; **no trial or assessment rows**; `room_trial_linked` not in `ROOM_ACTIONS`. | Add a `recruitment_trial` domain in P4B. |
| A20 | Blocks | `server.mjs:542-544`, `:3332`, `:1446`, `:3673-3678` | Evaluated on every read everywhere except the trial-day org view (fixed in P4A, defect P4A-D9). | Reuse; policy for post-block trial operations in D-16. |
| A21 | Guardian ownership | `db.guardians`, `isAdult` (`domain.mjs:5-40`, GB 18 / KR 19 …), `guardianManagedOnly`, `resolveContactRecipient` | `idVerified`, `disclaimerAccepted`, `childIds`, `removedAt` (read, never written). | Reuse the P3 resolver for every Trial recipient derivation. |
| A22 | Organisation verification | `domain.mjs:71-82` `visibleToOrg`, `safeguardingCertified` (`server.mjs:829-832`), M14 revocation | Agencies never see minors; unverified clubs never see minors; grassroots radius; verification is losable. | Reuse; re-check on every mutation. |
| A23 | Roles | `m12/shared.mjs:47-53` `isLead`, `m17/shared.mjs:572-615` `roomRole/roomCan` | viewer 0 / contributor 1 / room_lead 2 / recruitment_admin 3; `request_trial: 2` reserved. | Reuse; add `trial_view: 0`, `trial_write: 2`, `trial_assess: 1` (see architecture §11). |
| A24 | Concurrency / idempotency / rate limits | `m181/concurrency.mjs`, `m23/contact.mjs:216-324`, `m181/rateLimit.mjs` | `guardRev/bumpRev/expectedRevOf`; key + payload fingerprint; no trial policies. | Reuse; add policies. |
| A25 | Scheduler | `m12/operations.mjs:287-359` (persisted markers, 60 s sweep, boot sweep) | Restart-safe; already escalates overdue trial feedback. | Reuse for reminders (§68). No new scheduler. |
| A26 | Calendar | `server.mjs:2091-2105` ICS export (date-only, no tz) | The only calendar surface. | Replace with a timezone-aware export in P4B-3; no external calendar integration. |
| A27 | Trial day (M12 F9) | `m12/journeys.mjs:541-773` | `trial.day = { staff[] with checks, consents[], arrival, emergency, checkins[], collection, statusEvents[] (cancelled/postponed) }`; check-in gate (`STAFF_CHECK_REQUIRED`, `CONSENT_REQUIRED`); safety pack. | **The existing operational and safeguarding layer of a trial.** Reuse wholesale; Trial sessions and attendance build on `checkins`/`consents`. |
| A28 | Consent | `trial.day.consents` (event consent, player or guardian), guardian disclaimer, medical sharing, Passport share prefs, Combine recruitment opt-in | No footage/recording consent model; no terms-acceptance record (`m21/shared.mjs:135-143` documents the absence). | Existing event consent covers attendance; Box Cam linking uses the Combine opt-in rule; footage consent is a **flagged legal-review area** (D-15). |
| A29 | Media retention | `m22/frames.mjs`, `m16/sessions.mjs:443-464`, signed media (`m181/capabilities.mjs`) | No raw frames; optional player-uploaded Box Clip through the normal media pipeline. | Linking changes nothing (D-13). |
| A30 | Analytics (M20) | `m20/metrics.mjs` | `time_to_trial_requested`, `time_trial_requested_to_completed` (room history), `overdue_trial_reports` (`db.trials`); `SMALL_N_MIN = 5`; counts never suppressed. | Process metrics only; extend with scheduled/completed counts. |
| A31 | Nobody Missed / Second Look (M18) | `m18/nobodyMissed.mjs:127`, `m18/secondLook.mjs:110-114` | `trial` signal = any trial row; Second Look `trial_completed` change fires on **report filed**. | Re-key on completion in a later M18 pass (§60–§61). |
| A32 | Matching / watchlists (M19) | `m19/criteria.mjs` | No trial or assessment criterion. | Nothing changes (§62). |
| A33 | Grassroots open trials | `db.openTrials`, `server.mjs:2260-2340`, `:3229-3410` | Public open days with registrations; invite path writes a raw request row (defect P4A-D11). | A different concept; not the Trial. Its invite must go through the single writer. |
| A34 | Deletion cascades | `server.mjs:3470-3487` | Deleting a player drops trials/requests/channels, keeps cases/decisions/contacts/ledger. | Define the Trial cascade (D-20; defect P4A-D14). |
| A35 | Store contract + migrations | `storeContract.mjs`, `m182/migrations.mjs` (2303) | `trials` is `migration`/`core`; precedent for additive field migrations and for one justified store. | Additive migration to 2304; **no new store**. |

---

## Part B — Requirement reuse table

Columns: requirement · existing canonical owner · reuse unchanged · extend
existing · new model justified · duplicate-concept risk · privacy/safeguarding
risk · implementation recommendation.

| requirement | owner | reuse | extend | new | duplicate risk | privacy risk | recommendation |
|---|---|---|---|---|---|---|---|
| Canonical Trial object | `db.trials` (A1) | — | **yes**: `caseId`, `workflowState`, `schedule`, `attendance[]`, `completion`, `evidence[]`, `assessmentIds` (derived), `keys`, `rev`, `history[]` | no | high if a `recruitmentTrials` store were added beside `db.trials` (four existing readers) | low | Extend additively; never widen `status` (report obligation). Old rows read as `legacy` (Part C §C9). |
| Trial invitation | `db.requests` (A2) | transport, Inbox, respond routes | **yes**: `caseId` + `trialId` on the request; verified-guardian resolver; slot refusal | no | a "Trial Inbox" would be a second inbox | medium: venue in the invitation for minors | Invitation = request `type:'trial'` issued through `issueRecruitmentRequest`; Trial row created at **acceptance** (today's meaning preserved). |
| Adult recipient | `isAdult` (A21) | yes | — | no | — | — | Derive on every mutation. |
| Minor / guardian recipient | `resolveContactRecipient` (A8/A21) | yes | rename to a shared `resolveRecipient` in P4B-2 (same code) | no | a second guardian rule | **high** if bypassed | Fail closed: `TRIAL_GUARDIAN_REQUIRED`. |
| Agency / verified-club walls | `visibleToOrg`, `safeguardingCertified` (A22) | yes | — | no | — | high | Re-check at invite, accept, schedule, reschedule, link, assess. |
| Contact → Trial gate | lifecycle (A5) + Contact evidence | yes | — | no | a second gate ("must have a Contact record") | — | **One gate: case status.** `planTrial` is allowed from `contacted` (and the other existing in-edges); it does not re-check for a Contact row. See D-3. |
| Scheduling model | `trial.proposedDate/venue/notes`, `trial.day.arrival`, `trialDetails.altSlots` (A1/A27) | date, venue, arrival | **yes**: `schedule { timezone, sessions[], revision, confirmedAt, revisions[] }` on the trial | no separate store (D-2) | a `trialSessions` store | medium (venue/address) | Sessions embedded on the trial, bounded (≤ 20). |
| Timezone truth | none (A26 date-only) | — | **yes**: UTC instants + organiser IANA tz | no | — | — | Store `startsAt/endsAt` as UTC ms + `schedule.timezone`; display converts; recipient sees organiser tz label. |
| Reschedule | `trial.day.statusEvents[]` (`postponed`) (A27) | pattern | **yes**: append-only `schedule.revisions[]`; re-confirmation required after acceptance | no | — | — | D-8 in the decision register. |
| Cancellation | `trial.day.statusEvents[]` (`cancelled`) | pattern | **yes**: `completion.state = cancelled` + `cancelledBy: club|player|guardian` + phase | no | overloading `trial_completed` | — | Never `trial_completed`. |
| Attendance | `trial.day.checkins[]` + `player.attendance` (A27) | check-in | **yes**: per-session `attendance[]` with `attended/partial/no_show/club_cancelled/player_withdrew` | no | — | — | Check-in is the strongest source; manual record allowed with `source`. |
| Completion | none | — | **yes**: `completion { state, at, by }` | no | — | — | D-5. |
| Human Trial assessment | `db.assessments` (A3) | yes | **yes**: optional `context.trialId` (+ `trialSessionId`), evidence refs to Box Cam via a new ref kind | no (§24) | `trialReviews` | medium (club-private) | Reuse; blind rule, compare, immutability all inherited. |
| Legacy trial report | `trial.report` (A4) | yes | — | no | a third judgement record | low | Keep as the player-feedback obligation; do not extend. |
| Box Cam link | none | — | **yes**: `trial.sessions[].evidence[]` references | no | `trialId` on sessions | medium | Reference on the Trial side only (D-11). |
| Observation projection | `m21/evidence.mjs` resolvers, `m15/shared.mjs:332-340` | patterns | **yes**: `trialEvidenceView` | no | — | medium | Existence + state + provenance; never `trace`, never numeric confidence. |
| CV refusal semantics | `m22/policy.mjs:271-297` | yes | — | no | — | — | "No reliable observation available." |
| Passport | M15 rules (A9) | yes | re-key `trial_attended` on attendance | no | — | high if club-private content travelled | Option C for observations; assessments never travel (D-14). |
| Visibility / privacy | M15 viewer filter, `sharedRecordsFor`, `requestForRecipient` | yes | — | no | — | high | Matrix in `M23_P4A_TRIAL_PRIVACY_MATRIX.md`. |
| Trust Score | M16.2 (A13) | unchanged | — | no | — | — | No new input. |
| Events | registry (A18) | pattern | **yes**: 9 `trial_*` events, org_private, ids only | no | — | low | P4B-8. |
| Notifications | `notify`, `trial_updates` (A16) | yes | — | no | — | medium (minors) | Use `trial_day`/`request` types; fix D10. |
| Reminders | M12 sweep (A25) | yes | **yes**: `trial.reminders { sentAt… }` markers | no | a scheduler | — | Persisted markers before side effects. |
| Audit | `m182/audit.mjs` (A19) | pattern | **yes**: domain `recruitment_trial`, actions, `safeDetail` keys `sessionId`, `attendance` | no | — | high if text leaked | Ids and states only. |
| Roles | `roomCan` (A23) | yes | **yes**: `trial_view 0`, `trial_write 2`, `trial_assess 1` | no | Trial-specific roles | — | Reuse levels. |
| Re-authorisation | P3 pattern (A8) | yes | — | no | — | high | Every mutation re-derives role, membership, visibility, block, guardian, verification, case state. |
| Idempotency | `keys` + fingerprint (A24) | yes | — | no | — | — | Keys: `invite, accept, schedule, reschedule, cancel, attendance, complete, link`. |
| Concurrency | `guardRev` (A24) | yes | — | no | — | — | Trial `rev`; assessment `rev` (already); session rev none. |
| Rate limits | policy table (A24) | pattern | **yes**: `trial_invite 30/h/org`, `trial_schedule 60/h/org`, `trial_response 30/h/actor`, `trial_evidence_link 60/h/org` | no | — | — | P4B-1. |
| Checklist | Room tasks (A6) | yes | — | no | repurposing Development Hub | — | Staff-only tasks with `linkedResource: trial`. |
| Nobody Missed / Second Look | M18 (A31) | unchanged in P4B | later: re-key on completion | no | — | — | Recommendation only. |
| Analytics | M20 (A30) | yes | later: scheduled/completed counts | no | ability ranking | — | Process metrics only; small-n stays. |
| Demo fixtures | `roomsDemo.ts`, `demo.ts`, `mockClient.ts` | — | **yes**: mirror the real vocabulary | no | — | — | P4B-7; defect P4A-D3. |

**Result:** no new store. One additive migration on `db.trials`, one optional
field on `db.assessments`, and extensions to registries the platform already
has. Nothing in the table needed a competing model.

---

## Part C — The existing `trials` store, in full (§5–§7)

### C1. Schema (as written today)

```
id            'trial-N'
requestId     the accepted db.requests row (the invitation)
playerId, playerName, orgId, orgName, scoutName
acceptedAt    ms
guardianApproved  true (guardian path only; absent on adult path — defect P4A-D4)
proposedDate  'YYYY-MM-DD' string, or whatever the club typed (defect P4A-D1)
venue         free string, unbounded
notes         free string (moderated at request time)
reportDueAt   proposedDate + 7 d (NaN → null when the date is malformed)
status        'awaiting_report' | 'reported'
report?       { id, trialId, playerId, orgId, orgName, userId, scoutName, filedAt,
                acceleration, sprintSpeedKmh, distanceKm, passCompletionPct, duelSuccessPct, coachRating,
                notes, strengthNote, focusNote }
day?          { staff[], consents[], arrival, emergency, checkins[], collection, statusEvents[] }  (lazily created)
reminderSent?, feedbackEscalatedAt?
```

No `caseId`/`roomId` (the link is room → trial via `room.links.trialIds`), no
rev, no history, no idempotency key, no timezone, no time of day, no
sessions, no attendance state beyond `day.checkins`.

### C2. Status values — exactly two

| status | meaning | who creates | who moves into it | recipient action required | implies attendance | implies completion | analytics depends |
|---|---|---|---|---|---|---|---|
| `awaiting_report` | the trial was **accepted** and the club's mandatory performance report is not yet filed | the recipient's accept (guardian or adult) writes it | nobody else; it is the birth state | no (the recipient already acted) | **no** — it is set at acceptance, before any session | no | `overdue_trial_reports` (m20), `REPORTS_OUTSTANDING` gate, feed `report_due`, Nobody Missed `trial` signal (any row), journey `activeTrial` |
| `reported` | the club filed the mandatory report | the club (`POST /org/trials/:id/report`) | only from `awaiting_report`; once (`ALREADY_REPORTED`) | no | no | **no** (a report can be filed for a trial that never happened) | funnel "Reports filed", `/orgs/directory`, Passport `trial_outcome`, Second Look `trial_completed` change (on filing), M21 `trial_report` evidence |

Neither value is a scheduling, attendance or completion state. **P4B must
not widen or rename them**; the operational state lives in a new field.

### C3. Writer routes

Two, both on the recipient's accept path (`server.mjs:1297-1313`,
`:2866-2880`); no org route creates a trial. Mutators: report filing
(`:2167-2168`), feed reminder marker (`:2030-2031`), trial-day sub-object
(`m12/journeys.mjs:551, 634, 661`), sweep escalation
(`m12/operations.mjs:325`), player deletion (`server.mjs:3478`).

### C4. Readers

`server.mjs` (request gate 1797, feed 2027, ICS 2093, list 2126, report 2131,
funnel 2600, directory 3517), `m12/scouting.mjs:533` (case link),
`m12/journeys.mjs` (trial day, family views, **admin staff-checks cross-org**
757/762), `m12/operations.mjs:323`, `m17/rooms.mjs` (283 projector, 490
readiness, 1249 link), `m15/passport.mjs:102` + `m15/shared.mjs:188-206`,
`m18/secondLook.mjs:111`, `m18/nobodyMissed.mjs:127`,
`m20/dashboard.mjs:168` → `m20/timeSeries.mjs:187-196`, `m21/index.mjs:406`,
`m21/evidence.mjs:207, 269`, `m23/journey.mjs:204-206` (+ required store).

### C5. Permissions

Org routes: `orgAuth` only — **no role gate** on requesting a trial
(`server.mjs:1779`) or filing a report; trial-day routes are org-membership
scoped. Recipient routes: `playerAuth` (adults; minors refused by
`guardianManagedOnly`) and `guardianAuth` with `childIds`. Admin: static key.

### C6. Scoping

Every org reader filters `orgId === req.org.id`; family readers filter by
player id(s). Exceptions: admin staff-checks (all orgs, by design) and the
unauthenticated directory aggregates.

### C7. Links

`requestId` → request; `room.links.trialIds` ← room; `report.trialId`;
`player.attendance[].trialId` (check-in); `plan.originTrialId` (M21);
`{ sourceType: 'trial_report', sourceId }` (M21 evidence);
`source: { type: 'trial', id }` (M15). **No** link to assessments, signings,
outcome reports, Box Cam, media, or the case itself.

### C8. Dependencies by milestone

- **M12**: report obligation, trial day, REPORTS_OUTSTANDING gate.
- **M15**: `trial_attended` for every row (meaning "accepted"), `trial_outcome`
  when a report exists; `trialsSummary { total, withReport }`; org viewer
  `{ id, org, date, hasReport }`.
- **M17**: `trialStateFor()` → `reported | awaiting_report | none`; readiness
  `TRIAL_REPORTED`; room link; Room list `view=trials`.
- **M18**: `trial` coverage signal (any row); Second Look on report filing.
- **M20**: `overdue_trial_reports` reads `status`, `reportDueAt`, `orgId`;
  two time metrics read **room history**, not trials.
- **M21**: `trial_report` evidence (existence only).
- **M23**: journey `trials[]` by org+player, `activeTrial`, required store.

### C9. Historical compatibility (§120)

Old rows will lack every P4B field. Interpretation rule: `workflowState`
absent → **`legacy_accepted`** (a trial accepted under M12 with no schedule
revision, no session list, no attendance record). `schedule` derived read-only
from `proposedDate` as a date-only, timezone-less entry marked `legacy: true`;
`attendance` derived from `day.checkins` where present, otherwise
**unknown** — never fabricated. `completion` absent → not completed (a
`reported` legacy trial is *reported*, not *completed*; the Passport
`trial_attended` event for legacy rows keeps its current meaning under a
`legacy` flag so history is not rewritten). No backfill invents dates,
attendance or completion; the migration only adds the new containers with
neutral values.

### C10. What P4B must preserve

- `status` values and meaning, `reportDueAt`, `REPORTS_OUTSTANDING`.
- Creation at acceptance (readers assume a row means "accepted").
- `requestId`, `playerId`, `orgId` scoping.
- `trial.day` and its gates (staff check, consent, check-in, safety pack).
- `/orgs/directory` aggregates and the funnel counts.

---

## Part D — What the audit proves is missing (and only that)

1. A Trial's own operational state, schedule (timezone-aware, sessions),
   attendance and completion — additive fields on `db.trials`.
2. A case reference on the trial (`caseId`) so evidence is answered per case,
   not per org+player.
3. The evidence provider answers for `trial_confirmed` and `trial_completed`.
4. The Trial → Box Cam evidence reference and its projection.
5. An optional `trialId` context on assessments.
6. `trial_*` events, `recruitment_trial` audit domain, `trial_*` rate
   policies, `trial_view/write/assess` in `roomCan`.
7. A single Trial writer replacing the two accept-path copies, with the
   verified-guardian resolver and slot validation.
8. Client vocabulary and demo fixtures matching the above.

Everything else already exists and is reused unchanged.
