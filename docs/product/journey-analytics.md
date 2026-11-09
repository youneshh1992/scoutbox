# Recruitment journey, next actions, analytics, matching and watchlists

What each party sees of a recruitment as it progresses, how the next action is chosen, and what the recruitment analytics, matching and watchlists may and may not claim.

Founder decisions for this area are in [`../decisions.md`](../decisions.md).

## How it works

### Lifecycle and stages
- The lifecycle has exactly 18 states (`ROOM_STATUSES`, `domains/recruitment/rooms/shared.mjs`): watching, under_review, contact_planned, contacted, shortlisted, priority, trial_requested, trial_scheduled, trial_completed, offer_consideration, offer_made, offer_accepted, offer_declined, signed, on_hold, withdrawn, archived, closed. There is no 19th state, no `awaiting_*` state and no journey store. `applyStatus` is the one status writer.
- Journey stages are derived on every read and never stored:
  - review = under_review / shortlisted / priority
  - contact = contact_planned / contacted
  - trial = trial_requested / trial_scheduled
  - trial_completed = assessment, or decision once a submitted assessment exists
  - offer = offer_consideration / offer_made / offer_declined
  - offer_accepted = acceptance, or signing once a live package exists
  - paused = on_hold
  - ended = withdrawn / archived / closed
- Evidence-bearing states need their record (a hand move without it is refused): contacted needs a delivered, responded or recorded Contact; trial_requested an invitation for this `caseId`; trial_scheduled a confirmed schedule; trial_completed a completed Trial; offer_consideration a finalized formal `progress` decision; offer_made an issued live revision; accepted/declined the recipient's response; signed a supporting signing row.
- Matching, Trust Score, Box Cam, assessments and discovery never advance a case. A decision creates no Offer, and acceptance creates no package.
- Transitions:
  - A case opens at watching, only through `createRoomForPlayer` (`POST /org/rooms`; briefs and matching call it too). Hold, withdraw and reject work from any live state.
  - `resumeCase` returns to the held-from state if its evidence still stands, else to under_review. Nothing takes a paused case forward.
  - withdrawn, archived and closed reopen to under_review only through `reopenCase`. Second Look reopens only from these three states. archived can move to closed.
  - signed is terminal. Withdrawing an issued Offer returns the case to offer_consideration. Ending needs a reason code.
- Room roles: viewer < contributor < room_lead < recruitment_admin.
  Contributors review, shortlist and assess. Room leads do every other act. Signing for the club and completing a signing need a recruitment lead (`isLead`).

  The body may not name a `stage` or `status`. Authority comes from live rows. Moves need `expectedRev` (a stale one gets 409). Permission is checked before a key replay, and a replay writes and notifies nothing.

### Projection, audiences, timeline
- `GET /org/rooms/:id/journey` reads every store and writes none. Completed stages carry a basis (`canonical` or `lifecycle`) and are cumulative. The projection never scores, repairs or fabricates.
- Player and guardian (`/player/journeys`, `/guardian/children/:id/journeys`) see a player stage word (contacted…offer_received…signing, signed, none), their next action, their own ids and the visible timeline. They never see the case id, any lifecycle word except `signed`, priority, assessment, decision, rationale, notes, colleague names or Contact ids. An agent sees the same, limited to granted kinds. A foreign case id answers like a fabricated one. Unknown viewers fail closed.
- The timeline is built from records and history, ordered `(at, key)`. Only the club sees `by`. Terms, digests, notes and rationale never appear. Drafts, status changes, assessments and `reject` deliberation are club-only.
- Scoping:
  - Every selector and stage sees only this case's rows (`caseId`; decisions by `roomId`).
  - An assessment belongs to its Trial's case. Otherwise it belongs to the case that was open when it was written, and if it is older than every case, to the case being read.
  - A new case inherits nothing. `caseId` is never re-pointed.

### Current-resource selection
One copy of each rule, in `domains/recruitment/lifecycle/journeyModel.mjs`, used by every projection, the Offer summary and the notification targets. Within a tier, the newest record wins (by the tier's instant), ties broken by id descending.
- Contact: delivered, then responded/recorded, then draft, then failed. Cancelled is never current.
- Trial: live, then completed, then cancelled, then legacy_accepted.
- Assessment: submitted, then draft.
- Decision: formal head, then advisory head. Never a draft or a superseded decision.
- Offer: DRAFT/ISSUED, then ACCEPTED, then the rest. The live revision is the latest issued; a superseded revision is never answerable.
- Package: live and not expired, then COMPLETED, then the newest terminal. An expired package never masks a live one.

### Next action
- The server derives one `{code, stage, kind, tab, lifecycleAction, permitted, blockedBy, resources}` per case per viewer. Clients never compute one. `permitted` is recomputed on every read and the route re-checks. `blockedBy` is `BLOCKED`, `SUBJECT_REMOVED` or `INTEGRITY_ERROR`.
- Codes by state:
  - watching: REVIEW_PLAYER
  - review states: DECIDE_APPROACH, or RECORD_DECISION once assessed with no decision
  - contact_planned: SEND_CONTACT
  - contacted: AWAIT_CONTACT_RESPONSE, or CONTINUE_EVALUATION
  - trial_requested: AWAIT_TRIAL_RESPONSE
  - trial_scheduled: CONDUCT_TRIAL, then COMPLETE_TRIAL
  - trial_completed: COMPLETE_ASSESSMENT, then RECORD_DECISION
  - offer_consideration: PREPARE_OFFER, or ISSUE_OFFER when a draft exists
  - offer_made: AWAIT_OFFER_RESPONSE, or REVISE_OR_WITHDRAW_OFFER once expired
  - offer_declined: REVIEW_DECLINED_OFFER
  - offer_accepted: START_SIGNING, then PRESENT_SIGNING, then SIGN_FOR_CLUB or AWAIT_RECIPIENT_SIGNATURE, then COMPLETE_SIGNING
  - signed: RECRUITMENT_COMPLETE
  - on_hold: RESUME_CASE
  - ended states: CASE_ENDED
  - unknown state: STATE_UNKNOWN
- The player's next action follows this priority: SIGN, RESPOND_TO_OFFER, CONFIRM_TRIAL_SCHEDULE, RESPOND_TO_TRIAL_INVITATION, RESPOND_TO_CONTACT, NONE.

### Legacy and integrity
- Classifications: `canonical`, `legacy`, `partially_canonical`, `integrity_error`. The line between legacy and error is a claim: a history entry carrying a record id or a domain trigger.
  - A missing claimed record is `STALE_POINTER` and `LIFECYCLE_AHEAD_OF_EVIDENCE`.
  - A state reached with no claim is legacy.
  - On a live case, a record proving a state the history never reached is `EVIDENCE_AHEAD_OF_LIFECYCLE`.
  - Terminal evidence on an unsigned case is `LIFECYCLE_BEHIND_TERMINAL_EVIDENCE`.
  - A corrupt record naming the case is `RECORD_CORRUPT`.
  - A non-finite instant is `TEMPORAL_ORDER`.

  Every error blocks the act. Instants out of order are not corruption. Nothing is fabricated or repaired.
- A legacy signing row proves `signed` only if recorded after the case opened. The legacy signing route is club leads only, refused beside an Offer or package, and limited to one standing row per club and player. The legacy request route allows one pending request per type and uses the canonical rate budgets.

### Events, notifications, blocks, minors
- SSE payloads carry registered keys only, and an event only triggers a refetch. A client never sets a status, stage or current resource from an event or notification.
- Notification targets resolve at read time to the current resource (an agent's are re-checked against the live representation). A late notice opens a withdrawn or voided resource read-only. Text carries no terms, notes or rationale.
- A block stops what comes next and never erases history. Closure acts stay allowed, and decisions are never blocked.
- Minors: Contacts and Trials go to the guardian; Offer and signing pathways are closed; an unknown date of birth means not adult.

### Analytics
- "Measure the recruitment process, not the worth of the player or the scout." Nothing is stored.
- `assertMetricRegistry()` throws at boot in any of these cases:
  - a forbidden name appears: any "Score" (Recruitment, Scout, Player Success, …), a leaderboard or a ranking
  - a metric reads a private field
  - a metric has no limitation

  `groupBy=scout` returns 400 `GROUPING_BY_PERSON_REFUSED`.
- Honesty rules:
  - Empty, zero and suppressed are distinct. `SMALL_N_MIN=5` for ratios and medians; counts are never suppressed. Durations are medians.
  - The funnel is non-monotonic; a reopen counts once.
  - `source_stage_reach` is association only, sorted alphabetically, and carries the caveat.
  - Every panel shows its limitation.
  - Windows are inclusive UTC days.
  - Leads only. Analytics never notifies.
- Journey figures come from canonical stores or lifecycle history only, never from events, client values, notes, terms or scores. `journey_evidence_funnel` counts a case once per stage, by its earliest record. Cases reached by history alone are shown apart as "history only". Negative intervals are skipped.

### Matching and watchlists
- No score, rank or "recommended player". Required criteria decide membership. Preferred criteria are only counted ("2 of 3"), never sorted on, never change membership. Brief criteria are all required.
- There are 11 criterion types and 8 operators; others are refused by name. Protected traits are refused first. Missing facts fail closed. There is one engine, `matchPlayerToCriteria`.
- Authorization (visibility, blocks, minor rules, radius) runs before matching. There is no "considered" count. Only grassroots sees or sorts by distance. Orderings are deterministic and declared.
- Watchlists:
  - A watchlist stores criteria; membership is derived on read.
  - The mode (`live_linked` or `snapshot`) must be chosen, and at least one required criterion is needed.
  - Every exit for block, safeguarding or consent reasons shows only as `unavailable`.
  - There is one grouped notification per list, sent once per transition fingerprint, and never to the player.
  - States: active ↔ paused; any → archived (terminal).
  - A foreign id returns 404.
  - "Add to Room" uses the Room creator and is idempotent.
  - The list of watchlists and a watchlist's history are paged (50 at a time, "continue from here"); the apps show the first page of the list. A `notify` that is not true or false, an unknown source type, a source reference that is not short text and an unknown status filter are refused, naming the field.
  - Opening a watchlist records its membership, the new transitions, the time and the notification together, or not at all.
  - Matching and a watchlist's members cover every player the club can see (there is no cap), and both page by cursor: 50 at a time by default, at most 100, the next page from `nextCursor`, with `total` the number of matches. An `offset`, a page size over 100 or a cursor the list did not hand out is refused (400). The apps show the first page. Sorting by name ignores case and accents; a watchlist's "recent evidence" order is newest evidence first, as in matching.
- Briefs, Nobody Missed and Second Look:
  - A brief with an unknown foot, an unknown Combine protocol, a list field that is not a list, a title or availability that is not text, or a role or vacancy reference that is not a short id is refused, naming the field.
  - A brief edit is checked whole before anything is saved: a refused criteria change does not half-apply the status change sent with it.
  - Opening Second Look records new, resurfaced and expired items with the owner's notification together; opening it when nothing has changed saves nothing.
  - "Add to Room" from Nobody Missed, and "Reopen Room" from Second Look, save the Room and the review or item together.
  - Nobody Missed and the evaluation coverage cover every visible player too, and the Nobody Missed list pages by cursor like matching (50 by default, `nextCursor`, `total` the candidates).
  - The facts these read (a player's Passport position and availability, evidence confidence, newest evidence and footage, coach reference, confirmed club, Combine results) are kept per player and brought up to date in the same save as the change that affects them. A change that happens through time alone (evidence expiring, an agent agreement ending, an 18th birthday) shows within a minute.

## Open questions and deferred work

- Should a contract's `endDate` lift `under_contract`? This is an open product decision.
- The analytics metrics `trial_process` and `overdue_trial_reports` ignore room filters.
- Lead authority comes from a role string typed at login. Fixing it is deferred.
- Free-text reasons travel in push/email bodies.
- Minor items recorded, not fixed: lockout keyed by identifier, revise-key replay honesty, unchecked task `linkedResourceId`.
- Matching has no scheduler: a watchlist's membership (and its transitions and notification) is recorded when it is read.
- A watchlist read compares its whole stored membership with the new one, so a watchlist with tens of thousands of members is slow to open (about 0.4 s at 20,000). Deferred; see [`../known-issues.md`](../known-issues.md).

## Also worth knowing

- [`../reference/recruitment-metrics.md`](../reference/recruitment-metrics.md) is the canonical metric catalogue: 24 metrics (definition, source, time semantics, limitation) and a "considered and rejected" table whose reasons are recorded nowhere else.
