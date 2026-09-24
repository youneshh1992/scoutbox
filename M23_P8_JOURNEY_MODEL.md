# M23 P8 — The journey model

`scoutbox-server/m23/journeyModel.mjs` (pure) and the projector
`scoutbox-server/m23/journey.mjs` (reads every canonical store, writes none).
There is no journey store: `db.recruitmentJourneys` does not exist and no
migration was added (schema stays 2308).

## 1. What the club projection answers

`GET /org/rooms/:id/journey` → `journey`:

| Field | Meaning | Derived from |
| --- | --- | --- |
| `stage` | one of `JOURNEY_STAGES` (`watching review contact trial assessment decision offer acceptance signing signed paused ended`) | `canonicalStageFor(status, {assessed, signingOpened})` — the frozen lifecycle state, refined by whether a submitted assessment exists (after `trial_completed`) and whether a live package exists (after `offer_accepted`) |
| `completedStages[]` | `{stage, basis, at, …ids}` for each pipeline stage the case completed | `completedStagesFor(facts)`: `basis: 'canonical'` when the domain store holds the record, `'lifecycle'` when only the case history reached the state |
| `resources` | `contactId trialRequestId trialId assessmentId decisionId offerId offerRevisionId signingPackageId completedSigningId` | the current-resource selectors (M23_P8_CURRENT_RESOURCE_SELECTION.md) |
| `nextAction` | `{code, stage, kind, tab, lifecycleAction, permitted, blockedBy, resources}` | `nextActionFor` (M23_P8_NEXT_ACTION_MODEL.md) |
| `classification` | `canonical` · `legacy` · `partially_canonical` · `integrity_error` | `validateRecruitmentJourney` |
| `integrity[]` | the problem codes (empty when sound) | same |
| `blocked`, `subjectRemoved` | the two facts that stop every club act | `db.blocks`, `case.subjectRemovedAt` / the player record |

The rest of the response is P2–P7: `case`, `lifecycle` (`currentStage`,
`allowedNext`, `terminal`, `reopenable`), `conditions`, `nextActions` (the
permission-aware list of lifecycle actions), `contact`, `trials`, `assessments`,
`decisions`, `offer`, `outcome`, and `history` (the timeline, which P8 extends
with Offer and signing milestones).

## 2. Facts the model reads

`journeyFor` scopes every store to the case first (same `caseId`, `orgId`,
`playerId`; structurally sound by each domain's own integrity check):

`recruitmentContacts`, `requests` (type `trial`), `trials` (rows whose
`caseId` is this case — the same scope as the evidence gate; a legacy trial
with no `caseId` is the club's history of the player, listed in the Room's
`trials[]` but never this case's current Trial, trial stage or timeline entry
— D-P8-16), `assessments` (org + player: an M12 assessment is the club's
record of the player, not of a case), `roomDecisions`, `recruitmentOffers`,
`signingPackages`, the supporting `signings` row, `case.history`, `blocks`,
`players`.

The supporting signing row (`supportingSigningRow`) is the row a COMPLETED
package **on this case** names back, else the club's un-packaged (legacy) row
for this player. A row that belongs to another case's package is not this
case's evidence.

## 3. Stage table

| Lifecycle status | Stage | Refinement |
| --- | --- | --- |
| watching | watching | |
| under_review, shortlisted, priority | review | |
| contact_planned, contacted | contact | |
| trial_requested, trial_scheduled | trial | |
| trial_completed | assessment → decision | `decision` once a submitted assessment exists |
| offer_consideration, offer_made, offer_declined | offer | |
| offer_accepted | acceptance → signing | `signing` once a live package exists |
| signed | signed | |
| on_hold | paused | |
| withdrawn, archived, closed | ended | |

These words never enter `ROOM_STATUSES`, `ROOM_TRANSITIONS` or the history.
They are recomputed on every read.

## 4. Completed-stage basis

| Stage | Canonical basis | Lifecycle basis |
| --- | --- | --- |
| watching | — | the room exists |
| review | — | any non-terminal state past `watching` was reached |
| contact | a Contact in `delivered` / `responded` / `recorded`, not cancelled | `contacted` reached |
| trial | a Trial with `completion.state = 'completed'` | `trial_completed` reached |
| assessment | a submitted assessment by this club of this player | — |
| decision | a finalized, un-superseded formal decision | `offer_consideration` reached |
| offer | an Offer whose live revision was issued | `offer_made` reached |
| acceptance | an ACCEPTED live revision | `offer_accepted` reached |
| signing | a COMPLETED package | — |
| signed | a supporting signing row | `signed` reached |

## 5. Timeline

`history.entries` are derived from: the case history (`room_created`,
`room_status_changed`, `room_reopened`, handoffs), decisions, Contact
milestones (`contact_initiated`, `contact_response_received`), Trial history
milestones, trial-assessment records, **P8:** Offer history
(`offer_draft_created`, `offer_issued`, `offer_superseded`, `offer_withdrawn`,
`offer_accepted`, `offer_declined`, derived `offer_expired`) and signing
history (`signing_created`, `signing_ready`, `signing_party_completed`,
`signing_completed`, `signing_cancelled`, `signing_voided`,
`signing_superseded`). Every entry carries ids, a status word, an instant and
(for the club) the acting colleague's name — never a term, a digest, a note,
a rationale or the other side's name. Ordering is `(at, key)` so two reads
agree. Visibility per audience is the `TIMELINE_VISIBILITY` table
(M23_P8_JOURNEY_TIMELINE_PRIVACY_MATRIX.md).

## 6. Audience projections

| Viewer kind | Route | Returns |
| --- | --- | --- |
| `org_staff`, `grassroots_staff` | `GET /org/rooms/:id/journey` | the club projection above; foreign or fabricated case ids → `CASE_NOT_FOUND` (same body) |
| `player_self`, `guardian` | `GET /player/journeys`, `GET /guardian/children/:id/journeys` | per club: `shared[]` (what crossed the share boundary), `journey.stage` (a player word: `contacted trial_invited trial_scheduled trial_completed offer_received offer_accepted offer_declined signing signed none`), `journey.nextAction` (`RESPOND_TO_CONTACT RESPOND_TO_TRIAL_INVITATION CONFIRM_TRIAL_SCHEDULE RESPOND_TO_OFFER SIGN NONE`), `journey.resources` (their request / trial / offer / package ids), `journey.timeline` (visible kinds only, no club member's name, no Contact record id). No case id, no lifecycle state, no priority, no decision, no assessment |
| `agent` (authorized) | `GET /org/agent/clients/:rel/journey` | `journey.stage` (the same player vocabulary), `resources`, `timeline` filtered to `agent`, `grants` (which kinds the basis and the client's shares permit). Without a basis the case does not exist; ungranted kinds read as absent |
| `trust_safety` | (in-process, `authorized: true` required) | the club projection for moderation |
| anything else | — | `JOURNEY_VIEWER_UNKNOWN`, fail closed |

## 7. What the model never does

- It never writes: no status, no stage, no "journey state" row, no repair.
- It never scores: no readiness, probability, quality or progress number.
- It never fabricates: a stage reached without a record is `basis: 'lifecycle'`
  and the case is `legacy` or `partially_canonical`; a stage that claims a
  record which is missing is `integrity_error`.
- It never lets a later stage erase an earlier one: `completedStages` and the
  timeline are cumulative; acceptance does not delete the decision, completion
  does not delete the acceptance (§34).
