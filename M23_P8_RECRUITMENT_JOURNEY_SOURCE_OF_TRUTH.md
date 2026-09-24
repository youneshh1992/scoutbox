# M23 P8 — Recruitment journey: source of truth, stage by stage

One table per stage of the canonical journey (discovery, then the frozen 18
lifecycle states). The lifecycle has **18 states and no more** (`ROOM_STATUSES`,
`scoutbox-server/m17/shared.mjs`); the canonical *stage* words P8 adds
(`JOURNEY_STAGES`, `m23/journeyModel.mjs`) are derived descriptions of where a
case is, never a nineteenth state.

Conventions. **Canonical store** is the array on `db` that owns the fact.
**Canonical writer** is the one function that appends or mutates it. **Lifecycle
representation** is `case.room.status` (`case.stage` is derived from it by
`applyStatus` in `m17/rooms.mjs`, the ONE status writer). **Who can act** uses
the room-role ladder viewer < contributor < room_lead < recruitment_admin
(`roomRole`, m17); a *recipient* is the player, or the guardian of a minor.
**Forward / backward** name the semantic lifecycle actions (`LIFECYCLE_ACTIONS`,
`m23/lifecycle.mjs`) and the domain act that produces the evidence. **Primary
UI** is the Club Room tab (`rm.tab.*`) unless stated. **Deep link** is the hash
the club app resolves (`#/recruitment/rooms/:roomId/:tab`, P8) or the
player/agent route.

## 0. Discovery (before a case exists)

| Field | Value |
| --- | --- |
| Stage | `discovery` — a player seen in search, a watchlist match, a Nobody Missed brief, a shared opportunity |
| Canonical store | none for the journey; `db.ledger` (`view`, `save`, `shortlist` events), `db.watchlists` (M19), `db.recruitmentBriefs` (M18) |
| Canonical writer | the search / watchlist / brief routes (M12, M18, M19) |
| Canonical evidence | none — discovery proves nothing about a case |
| Lifecycle representation | none; a case does not exist |
| Who can act | any org user who can see the player (`orgCanSee`) |
| Who can read | the org |
| Forward | `POST /org/rooms` (M17, `createRoomForPlayer`) opens a case at `watching`; M18/M19 call the same creator |
| Backward | — |
| Terminal | — |
| Notifications | none |
| Events | `recruitment_room_created` (ledger) |
| Analytics | `room_source_mix` (source context), M13 exposure funnel (client-reported impressions, documented as such) |
| Primary UI | Search, Watchlists, Matching, Briefs (sidebar destinations) |
| Deep link | `#/search`, `#/recruitment/watchlists/:id`, `#/recruitment/briefs/:id` |

Discovery, matching, Trust Score and Box Cam never advance a case (§39–§41):
`createRoomForPlayer` writes `watching` only; no code path moves a status from a
match, a score or an observation.

## 1. `watching`

| Field | Value |
| --- | --- |
| Stage | `watching` |
| Canonical store | `db.recruitmentCases` (the case with its `room` facet) |
| Canonical writer | `createRoomForPlayer` / `POST /org/rooms` → `applyStatus` |
| Canonical evidence | the room's existence (`room_created` history) |
| Lifecycle representation | `room.status = 'watching'` |
| Who can act | opener: any org user who can see the player; move on: contributor+ (`startReview`) |
| Who can read | the org (restricted rooms: lead, assignees, recruitment leads) |
| Forward | `startReview` → under_review; `shortlist`; `planContact` |
| Backward | `holdCase`, `withdrawCase`, `rejectCase` |
| Terminal | no |
| Notifications | none |
| Events | `recruitment_room_created` |
| Analytics | `pipeline_stage_counts.watching`; `funnel_progression` cohort entry (`firstReachedAt`) |
| Primary UI | Room → Overview; next action `REVIEW_PLAYER` |
| Deep link | `#/recruitment/rooms/:id/overview` |

## 2. `under_review`

| Field | Value |
| --- | --- |
| Stage | `review` |
| Canonical store | `db.recruitmentCases` |
| Canonical writer | `applyLifecycleTransition` (via `POST /rooms/:id/lifecycle` `startReview`, `resumeCase`, `reopenCase`; via the legacy `POST /rooms/:id/status`; via `ctx.reopenRoom` from Second Look) |
| Canonical evidence | none required (a club may review whoever it can see) |
| Lifecycle representation | `under_review` |
| Who can act | contributor+ (`startReview`); room_lead+ for resume/reopen |
| Who can read | the org |
| Forward | `shortlist`, `prioritise`, `planContact`, `planTrial` (needs an invitation), `holdCase` |
| Backward | `watching`; `withdrawCase`/`rejectCase` |
| Terminal | no |
| Notifications | `recruitment_room` to owner/lead on the legacy route |
| Events | none (status moves are notifications and history, not broadcast events) |
| Analytics | `pipeline_stage_counts`, `funnel_progression`, `time_in_stage` |
| Primary UI | Room → Overview, Evidence, Assessments; next action `DECIDE_APPROACH` (or `RECORD_DECISION` once an assessment is submitted) |
| Deep link | `#/recruitment/rooms/:id/overview` |

## 3. `contact_planned`

| Field | Value |
| --- | --- |
| Stage | `contact` |
| Canonical store | `db.recruitmentCases`; a draft in `db.recruitmentContacts` (P3) |
| Canonical writer | `applyLifecycleTransition` (`planContact`); `POST /rooms/:id/contacts` writes the draft |
| Canonical evidence | none for the state; the draft is NOT evidence of contact |
| Lifecycle representation | `contact_planned` |
| Who can act | room_lead+ |
| Who can read | the org (drafts never reach the player) |
| Forward | `send` / `external` on the Contact → the Contact route asks `recordContact` |
| Backward | `under_review`, `shortlist`, `prioritise`, hold/withdraw/reject |
| Terminal | no |
| Notifications | none |
| Events | `contact_created` (ids only) |
| Analytics | `pipeline_stage_counts.contact_planned` |
| Primary UI | Room → Contact; next action `SEND_CONTACT` (carries the draft id) |
| Deep link | `#/recruitment/rooms/:id/contact` |

## 4. `contacted`

| Field | Value |
| --- | --- |
| Stage | `contact` |
| Canonical store | `db.recruitmentContacts` (status `delivered` / `responded` / `recorded`); the recipient's copy is a `db.requests` row of type `contact` |
| Canonical writer | `m23/contactRoutes.mjs` (`send`, `external`, `respond` via `/player/requests/:id/respond`) → `advanceCase('recordContact')` |
| Canonical evidence | `contact_delivered`: a Contact for this org+player in `CONTACT_EVIDENCE_STATUSES`, not cancelled, structurally sound (`m23/evidence.mjs`). A draft or a failed send proves nothing (§20) |
| Lifecycle representation | `contacted` (only through the evidence gate; `recordContact` by hand is refused 422 without a Contact) |
| Who can act | send/record: room_lead+; respond: the recipient only |
| Who can read | club: the Contact; recipient: their request and their answer; agent: milestones when routed (`contact_agent_routed`) |
| Forward | `shortlist`, `prioritise`, `planTrial`, `considerOffer` (needs a progress decision) |
| Backward | `under_review`, hold/withdraw/reject |
| Terminal | no |
| Notifications | `request` (recipient), `representation_contact` (agent), `recruitment_room` (club, on response) |
| Events | `contact_sent`, `contact_failed`, `contact_external_recorded`, `contact_responded`, `contact_agent_routed` |
| Analytics | `funnel_progression.contacted` (lifecycle); P8 `journey_evidence_funnel.contacted` (case-based, from `db.recruitmentContacts`) |
| Primary UI | Room → Contact; player: Inbox; agent: client → Contacts. Next action `AWAIT_CONTACT_RESPONSE` while delivered, else `CONTINUE_EVALUATION` |
| Deep link | club `#/recruitment/rooms/:id/contact`; player `inbox`; agent `#/clients/:rel/contacts` |

## 5. `shortlisted` · 6. `priority`

| Field | Value |
| --- | --- |
| Stage | `review` |
| Canonical store | `db.recruitmentCases` |
| Canonical writer | `applyLifecycleTransition` (`shortlist`: contributor+; `prioritise`: room_lead+) |
| Canonical evidence | none (club judgement, recorded with the M17 decision memory when the legacy route is used) |
| Lifecycle representation | `shortlisted` / `priority` |
| Who can read | the org only — **never the player or an agent** (§16, §58: no "Priority prospect") |
| Forward | `planContact`, `planTrial`, `considerOffer` |
| Backward | `under_review`, `shortlisted` ↔ `priority`, hold/withdraw/reject |
| Terminal | no |
| Notifications | `recruitment_room` (club) |
| Events | none |
| Analytics | `pipeline_stage_counts`, `funnel_progression` |
| Primary UI | Room → Overview; next action `DECIDE_APPROACH` / `RECORD_DECISION` |
| Deep link | `#/recruitment/rooms/:id/overview` |

## 7. `trial_requested`

| Field | Value |
| --- | --- |
| Stage | `trial` |
| Canonical store | `db.requests` (type `trial`, `caseId` set) — the invitation |
| Canonical writer | `POST /rooms/:id/trials` (`m23/trialRoutes.mjs`, through the single request writer) → `advanceCase('planTrial')` |
| Canonical evidence | `trial_invited`: a pending or accepted trial request for THIS case (`caseId`), issued through the writer. A declined invitation proves nothing; `planTrial` by hand is refused |
| Lifecycle representation | `trial_requested` |
| Who can act | invite: room_lead+; accept/decline: the recipient |
| Who can read | club; recipient (their invitation); agent (milestone) |
| Forward | acceptance → `confirmTrial` (with a concrete slot) → `trial_scheduled` |
| Backward | decline leaves the state; `shortlist`/`prioritise`, hold/withdraw/reject |
| Terminal | no |
| Notifications | `request` (recipient); `trial_day` (club, on accept/decline) |
| Events | `trial_invited`, `trial_declined` |
| Analytics | `trial_process.invited/declined`, `funnel_progression.trial_requested`, `time_to_trial_requested` |
| Primary UI | Room → Trial; player: Inbox. Next action `AWAIT_TRIAL_RESPONSE` |
| Deep link | club `#/recruitment/rooms/:id/trial`; player `inbox` |

## 8. `trial_scheduled`

| Field | Value |
| --- | --- |
| Stage | `trial` |
| Canonical store | `db.trials` (`schedule.confirmedAt`, `schedule.sessions[]`) |
| Canonical writer | `onTrialAccepted` / `confirm-schedule` in `m23/trialRoutes.mjs` → `advanceCase('confirmTrial')` |
| Canonical evidence | `trial_confirmed`: a sound Trial for THIS case whose derived state is `scheduled` with a confirmed schedule of ≥1 session (`legacy_accepted` never qualifies) |
| Lifecycle representation | `trial_scheduled` |
| Who can act | reschedule/attendance/cancel: room_lead+; confirm/decline a proposed schedule: the recipient |
| Who can read | club (full); recipient (their schedule); agent (`scheduleView` for agents) |
| Forward | attendance recorded → `complete` → `completeTrial` |
| Backward | a material reschedule returns the Trial to `accepted` (the case stays; the evidence is re-proved at completion); cancel; hold/withdraw/reject |
| Terminal | no |
| Notifications | `trial_day` (recipient: proposed/changed; club: confirmed/declined) |
| Events | `trial_accepted`, `trial_scheduled`, `trial_rescheduled`, `trial_attendance_recorded`, `trial_cancelled` |
| Analytics | `trial_process.scheduled`, `funnel_progression.trial_scheduled` |
| Primary UI | Room → Trial; player: Opportunities → Trial. Next action `CONDUCT_TRIAL`, then `COMPLETE_TRIAL` once the last session has ended |
| Deep link | club `#/recruitment/rooms/:id/trial`; player `opportunities` |

## 9. `trial_completed`

| Field | Value |
| --- | --- |
| Stage | `assessment` until an assessment is submitted, then `decision` |
| Canonical store | `db.trials` (`completion.state = 'completed'`); assessments in `db.assessments` (`context.trialId`) |
| Canonical writer | `POST /rooms/:id/trials/:tid/complete` → `advanceCase('completeTrial')`; assessments through `m12/scouting.mjs` (`PUT` + `submit`) |
| Canonical evidence | `trial_completed`: a sound Trial for THIS case with `completion.state === 'completed'` and derived state `completed`. A report is not completion; an assessment is not completion (§21) |
| Lifecycle representation | `trial_completed` |
| Who can act | complete: room_lead+; assess: any org user with an assignment or a lead; decide: room_lead+ |
| Who can read | club; recipient (state word only); agent (milestone) |
| Forward | a **finalized formal `progress` decision** (P5) → `considerOffer` → `offer_consideration`. No assessment ever moves the case (§22) |
| Backward | `shortlist`, `prioritise`, hold (a `hold` decision), reject (a `reject` decision) |
| Terminal | no |
| Notifications | `trial_day` (recipient: completed); `trial_report` (player, feedback exists) |
| Events | `trial_completed`, `trial_evidence_linked` |
| Analytics | `trial_process.completed`, `time_trial_requested_to_completed`, P8 `journey_evidence_funnel.assessed` (submitted assessments, case-based) |
| Primary UI | Room → Trial / Assessments / Decision. Next action `COMPLETE_ASSESSMENT` then `RECORD_DECISION` |
| Deep link | `#/recruitment/rooms/:id/assessments`, `…/decision` |

## 10. `offer_consideration`

| Field | Value |
| --- | --- |
| Stage | `offer` |
| Canonical store | `db.roomDecisions` (formal, `state: 'final'`, `outcome: 'progress'`); a draft Offer in `db.recruitmentOffers` |
| Canonical writer | `POST /rooms/:id/decision/finalize` (`m23/decisionRoutes.mjs`) → `advanceCase('considerOffer')`; `POST /rooms/:id/offers` writes the draft |
| Canonical evidence | `decision_progress`: a finalized, un-superseded formal decision to progress on THIS case. A draft, an advisory recommendation or a superseded decision proves nothing |
| Lifecycle representation | `offer_consideration` — the decision **does not create an Offer** (§23) |
| Who can act | finalize: room_lead+; draft an Offer: room_lead+ (the Offer route's own `draftBlockers`) |
| Who can read | club only (decisions and drafts never reach the player or an agent) |
| Forward | `issue` on the Offer → `sendOffer` |
| Backward | `shortlist`, `prioritise`, hold/withdraw/reject; a withdrawn issued Offer returns here |
| Terminal | no |
| Notifications | `recruitment_room` (club: outcome word only) |
| Events | `room_decision_finalized`, `room_decision_superseded`, `offer_draft_created`, `offer_draft_updated` |
| Analytics | `decision_outcomes` (revision-based, documented), `decision_outstanding`, `funnel_progression.offer_consideration` |
| Primary UI | Room → Decision, then Offer. Next action `PREPARE_OFFER`, or `ISSUE_OFFER` once a draft exists |
| Deep link | `#/recruitment/rooms/:id/offer` |

## 11. `offer_made`

| Field | Value |
| --- | --- |
| Stage | `offer` |
| Canonical store | `db.recruitmentOffers` (revision `ISSUED`, `recipientSnapshot`) |
| Canonical writer | `POST /org/offers/:id/issue` (`m28/index.mjs`) → `advanceCase('sendOffer')` |
| Canonical evidence | `offer_sent`: an Offer of THIS case whose live revision is ISSUED / ACCEPTED / DECLINED (`offerEvidence`) |
| Lifecycle representation | `offer_made` |
| Who can act | issue/revise/withdraw: room_lead+; respond: the snapshotted recipient only |
| Who can read | club; recipient (terms of the live revision); agent when the client shared it (`agentShare`, basis re-checked) |
| Forward | recipient accept → `recordOfferAccepted`; decline → `recordOfferDeclined` |
| Backward | withdraw → `offer_consideration`; a new revision supersedes the live one (same state); hold/withdraw/reject |
| Terminal | no (an expired live revision is derived `EXPIRED`; the state stays until the club revises or withdraws) |
| Notifications | `recruitment_offer` (recipient, agent, club) |
| Events | `offer_issued`, `offer_superseded`, `offer_withdrawn` |
| Analytics | `funnel_progression.offer_made`; P8 `journey_evidence_funnel.offer_issued` (case-based) |
| Primary UI | Room → Offer; player: Opportunities → Offer; agent: client → Offers. Next action `AWAIT_OFFER_RESPONSE`, or `REVISE_OR_WITHDRAW_OFFER` once expired |
| Deep link | club `#/recruitment/rooms/:id/offer`; player `opportunities`; agent `#/clients/:rel/offers` |

## 12. `offer_accepted`

| Field | Value |
| --- | --- |
| Stage | `acceptance`, then `signing` once a package is live |
| Canonical store | `db.recruitmentOffers` (`responses[]`, revision `ACCEPTED`) |
| Canonical writer | `POST /player/offers/:id/accept` (or the guardian route) → `advanceCase('recordOfferAccepted')` with the recipient as actor |
| Canonical evidence | `offer_accepted_by_recipient`: the live revision is ACCEPTED with a response row by the snapshotted recipient |
| Lifecycle representation | `offer_accepted` — labelled "Accepted in ScoutBox"; **not** a signing, **no package is created** (§24) |
| Who can act | start a signing: room_lead+ (`POST /org/offers/:id/signing`) |
| Who can read | club; recipient; shared agent |
| Forward | explicit `start signing` → the P7 workflow → `confirmSignedOutcome` at completion |
| Backward | hold/withdraw/reject/close (the accepted Offer stays historical) |
| Terminal | no |
| Notifications | `recruitment_offer` (club, agent: accepted) |
| Events | `offer_responded` (`status` word), `signing_created` |
| Analytics | `funnel_progression.offer_accepted`; P8 `journey_evidence_funnel.offer_accepted`, `.signing_started` |
| Primary UI | Room → Signing. Next action `START_SIGNING` → `PRESENT_SIGNING` → `SIGN_FOR_CLUB` / `AWAIT_RECIPIENT_SIGNATURE` → `COMPLETE_SIGNING` |
| Deep link | club `#/recruitment/rooms/:id/signing`; player `opportunities` |

## 13. `offer_declined`

| Field | Value |
| --- | --- |
| Stage | `offer` |
| Canonical store | `db.recruitmentOffers` (revision `DECLINED`) |
| Canonical writer | `POST /player/offers/:id/decline` → `advanceCase('recordOfferDeclined')` |
| Canonical evidence | `offer_declined_by_recipient` |
| Lifecycle representation | `offer_declined` (real, but not funnel progress: `toAnalyticsRecruitmentStage` → null) |
| Who can act | room_lead+ to reconsider (`considerOffer`) or end |
| Who can read | club; recipient; shared agent |
| Forward | `considerOffer` (a new Offer may be drafted) |
| Backward | hold/withdraw/reject/close |
| Terminal | no |
| Notifications | `recruitment_offer` (club, agent: declined) |
| Events | `offer_responded` |
| Analytics | P8 `journey_evidence_funnel.offer_declined`; excluded from progress funnels |
| Primary UI | Room → Offer. Next action `REVIEW_DECLINED_OFFER` |
| Deep link | `#/recruitment/rooms/:id/offer` |

## 14. `on_hold`

| Field | Value |
| --- | --- |
| Stage | `paused` |
| Canonical store | `db.recruitmentCases` (+ a formal `hold` decision when reached through P5) |
| Canonical writer | `applyLifecycleTransition` (`holdCase`, or a finalized `hold` decision) |
| Canonical evidence | none |
| Lifecycle representation | `on_hold` — a live case, not terminal (§36); Offer, Trial and signing history are untouched |
| Who can act | room_lead+ (`resumeCase`) |
| Who can read | club |
| Forward | `resumeCase` → `under_review` |
| Backward | withdraw/reject/close |
| Terminal | no |
| Notifications | `recruitment_room` |
| Events | none |
| Analytics | excluded from progress (`FUNNEL_NON_PROGRESS_STATUSES`); `open_room_age` |
| Primary UI | Room → Overview. Next action `RESUME_CASE` |
| Deep link | `#/recruitment/rooms/:id/overview` |

## 15. `signed`

| Field | Value |
| --- | --- |
| Stage | `signed` |
| Canonical store | `db.signings` (the completed-signing row) and `db.signingPackages` (`COMPLETED`, `completion.signingId`); the player's `contractStatus = 'under_contract'` |
| Canonical writer | `recordCompletedSigning` (`m29/index.mjs`, the ONE writer) called from `POST /org/signings/:id/complete` → `advanceCase('confirmSignedOutcome')`; the legacy `POST /org/players/:id/signing` calls the same writer (P8: clubs only, leads only, refused beside an Offer or a package) |
| Canonical evidence | `confirmed_join`: a supporting signing row — a canonical row whose COMPLETED package names THIS case and names the row back, or a legacy row (no package) recorded after the case opened (P8) |
| Lifecycle representation | `signed` (terminal) |
| Who can act | complete: recruitment lead (`isLead`); every required party confirms their own signature |
| Who can read | club; player (their signing; contract outcome); guardian; shared agent (status words) |
| Forward | — |
| Backward | none for the case; the package may be VOIDED only before completion; Trust & Safety void is a moderation act that leaves history |
| Terminal | yes |
| Notifications | `recruitment_signing` (club, player, agent), `signing` + `level_up` (player, guardian) |
| Events | `signing_completed` |
| Analytics | `funnel_progression.signed`, `source_stage_reach.signed`; P8 `journey_evidence_funnel.signed` (rows supported by a COMPLETED package or a legacy row) |
| Primary UI | Room → Signing; player: Opportunities → Signing; You → Profile (contract status, read-only for `under_contract`). Next action `RECRUITMENT_COMPLETE` |
| Deep link | club `#/recruitment/rooms/:id/signing`; player `opportunities` |

## 16. `withdrawn` · 17. `archived` · 18. `closed`

| Field | Value |
| --- | --- |
| Stage | `ended` |
| Canonical store | `db.recruitmentCases`; the closing reason in `db.roomDecisions` (M17 records a decision on every ending through the legacy route; P5 `reject` decisions land on `archived`) |
| Canonical writer | `applyLifecycleTransition` (`withdrawCase`, `rejectCase`, `closeCase`, all with a lifecycle reason; or a finalized `reject` decision) |
| Canonical evidence | a recorded reason (`LIFECYCLE_REASON_REQUIRED`) |
| Lifecycle representation | `withdrawn` (club stepped back), `archived` (club rejected), `closed` (administrative end) |
| Who can act | room_lead+; reopen: room_lead+ (`reopenCase` → `under_review`; Second Look bridge, P8: only from these three states) |
| Who can read | club; the player keeps whatever was shared (their Contact, Trial, Offer, signing history) |
| Forward | `reopenCase` only |
| Backward | — |
| Terminal | yes (reopenable). Old Contacts, Trials, Offers and packages stay historical and cannot be acted on: the domain routes refuse on `CASE_STATE` / `LIFECYCLE_CONFLICT` (§35) |
| Notifications | `recruitment_room` |
| Events | `recruitment_room_archived` |
| Analytics | `exit_reason_mix`, `terminal_with_recorded_decision`, `reopen_rate`, `rooms_ended` |
| Primary UI | Room → Overview / Activity. Next action `CASE_ENDED` (reopen offered through the lifecycle actions list) |
| Deep link | `#/recruitment/rooms/:id/activity` |

## The projection that reads all of this

`GET /org/rooms/:id/journey` (`m23/journey.mjs`) reads every store above and
writes none. P8 adds the `journey` block: `stage`, `completedStages[]` (with the
basis `canonical` or `lifecycle`), `resources` (the current id of each kind, one
deterministic rule per kind — M23_P8_CURRENT_RESOURCE_SELECTION.md),
`nextAction` (M23_P8_NEXT_ACTION_MODEL.md), `classification` and `integrity`
(M23_P8_LEGACY_JOURNEY_COMPATIBILITY.md). The player and guardian read their
own projection (`GET /player/journeys`, `GET /guardian/children/:id/journeys`);
an authorized agent reads `GET /org/agent/clients/:rel/journey`
(M23_P8_JOURNEY_AUTH_MATRIX.md). There is no `db.recruitmentJourneys` (§83).
