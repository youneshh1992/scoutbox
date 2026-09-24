# M23 P8 — Next-action model

The server derives ONE next action per case per viewer (`nextActionFor`,
`scoutbox-server/m23/journeyModel.mjs`), returned as `journey.nextAction` by
`GET /org/rooms/:id/journey`. Clients render it; they never compute one (§7).
A next action is a description of the one thing a person could do now. It is
**not** a lifecycle state (§8) and the server never performs it.

## 1. Shape

```
{ code, stage, kind: 'club' | 'await' | 'none', tab, lifecycleAction | null,
  permitted: true | false | null, blockedBy: [], resources: { …ids } }
```

`tab` is the Room tab the act lives on (`overview contact trial assessments
decision offer signing`) and is the deep link the club app opens
(`#/recruitment/rooms/:id/:tab`). `permitted` is computed for the viewer's
room role (`null` for an `await` or `none` act); the domain route remains the
authority and re-checks on every request (§50). `blockedBy` names `BLOCKED`
(the player blocked the club) or `SUBJECT_REMOVED` (the player left ScoutBox);
the act is still named so the person understands why nothing can proceed.

## 2. The table

| Lifecycle status | Facts | Code | Kind | Tab | Permission |
| --- | --- | --- | --- | --- | --- |
| watching | | `REVIEW_PLAYER` | club | overview | `startReview` (contributor+) |
| under_review / shortlisted / priority | no submitted assessment, or a formal decision stands | `DECIDE_APPROACH` | club | overview | `planContact` (room_lead+) |
| under_review / shortlisted / priority | a submitted assessment, no formal decision | `RECORD_DECISION` | club | decision | room_lead+ |
| contact_planned | | `SEND_CONTACT` (+ `contactId` of the draft) | club | contact | room_lead+ |
| contacted | current Contact `delivered` | `AWAIT_CONTACT_RESPONSE` | await | contact | — |
| contacted | answered / recorded | `CONTINUE_EVALUATION` | club | overview | `shortlist` (contributor+) |
| trial_requested | | `AWAIT_TRIAL_RESPONSE` (+ `trialRequestId`) | await | trial | — |
| trial_scheduled | last session not yet ended | `CONDUCT_TRIAL` (+ `trialId`) | club | trial | room_lead+ |
| trial_scheduled | last session ended | `COMPLETE_TRIAL` | club | trial | room_lead+ |
| trial_completed | no submitted assessment | `COMPLETE_ASSESSMENT` | club | assessments | contributor+ |
| trial_completed | assessed, no formal decision | `RECORD_DECISION` | club | decision | room_lead+ |
| trial_completed | assessed, a `hold`/`reject` decision superseded back | `RECORD_DECISION` (+ `decisionId`) | club | decision | room_lead+ |
| offer_consideration | no draft Offer | `PREPARE_OFFER` (+ `decisionId`) | club | offer | room_lead+ |
| offer_consideration | a DRAFT Offer | `ISSUE_OFFER` (+ `offerId`, `offerRevisionId`) | club | offer | room_lead+ |
| offer_made | live revision ISSUED | `AWAIT_OFFER_RESPONSE` | await | offer | — |
| offer_made | live revision EXPIRED | `REVISE_OR_WITHDRAW_OFFER` | club | offer | room_lead+ |
| offer_declined | | `REVIEW_DECLINED_OFFER` | club | offer | `considerOffer` (room_lead+) |
| offer_accepted | no live package | `START_SIGNING` (+ `offerId`) | club | signing | room_lead+ |
| offer_accepted | package DRAFT | `PRESENT_SIGNING` (+ `signingPackageId`) | club | signing | room_lead+ |
| offer_accepted | READY / IN_PROGRESS, club party pending | `SIGN_FOR_CLUB` | club | signing | recruitment lead |
| offer_accepted | club signed, recipient pending | `AWAIT_RECIPIENT_SIGNATURE` | await | signing | — |
| offer_accepted | every party complete | `COMPLETE_SIGNING` | club | signing | recruitment lead |
| signed | | `RECRUITMENT_COMPLETE` (+ `completedSigningId`) | none | signing | — |
| on_hold | | `RESUME_CASE` | club | overview | `resumeCase` (room_lead+) |
| withdrawn / archived / closed | | `CASE_ENDED` | none | overview | (reopen is in `nextActions`) |
| (unknown status) | | `STATE_UNKNOWN` | none | overview | — |

Every code is in `NEXT_ACTION_CODES`; the club app labels them from
`jn.next.*` (EN and FR, one key per code).

## 3. What the model refuses to do

- A `PREPARE_OFFER` is never an Offer (§23); a `START_SIGNING` is never a
  package (§24); the next action names the door, the person walks through it.
- Trust Score, matching, Box Cam and assessments never appear in the table: an
  assessment makes `RECORD_DECISION` the next act, it never makes the decision.
- A `hold` or `reject` decision is a decision; the next action after it is
  `RESUME_CASE` or `CASE_ENDED`, never "progress".

## 4. The player's next action

`playerNextActionFor` (same module), returned in `GET /player/journeys`:

| Priority | Code | When |
| --- | --- | --- |
| 1 | `SIGN` | a presented package with THEIR party pending |
| 2 | `RESPOND_TO_OFFER` | an ISSUED live revision addressed to them |
| 3 | `CONFIRM_TRIAL_SCHEDULE` | a proposed schedule awaiting their confirmation |
| 4 | `RESPOND_TO_TRIAL_INVITATION` | a pending trial request |
| 5 | `RESPOND_TO_CONTACT` | a pending contact request |
| — | `NONE` | nothing to do |

The player's action is always the most consequential pending act; nothing in
it describes the club's process.

## 5. Role loss (§50)

`permitted` is recomputed on every read; the club app re-reads the journey on
focus, on visibility, on every server event and after every act, so a person
whose role changed sees the control withdrawn on the next read. A stale
button that survives until then meets the route's own 403 and the page
refreshes ("This recruitment has changed. We refreshed the latest status.").
