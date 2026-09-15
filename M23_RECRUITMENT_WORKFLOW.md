# M23 — Recruitment Workflow

The operating layer over the recruitment case. Written after P2, frozen before
the Contact phase begins.

> The recruitment lifecycle must describe what has actually happened — not what
> the UI wants to show, not what another subsystem happens to call it, and never
> more than the underlying records can prove.

---

## 1. Lifecycle authority

One object, one status, one writer, one direction.

| | |
|---|---|
| Canonical object | `db.recruitmentCases` (M12) |
| Canonical status | `case.room.status` (M17's set, extended by M23) |
| Derived | `case.stage` — the M12 vocabulary, written by `applyStatus()` alone |
| Append-only record | `case.history` — the same array M20's funnel reads |
| Stored journey | **none** |

Authority runs `status → stage`. Never the reverse, and never around the side:
a derived field is not writable. `POST /org/cases/:id/stage` — M12's legacy
route — **refuses** a case that has a Room (`STAGE_NOT_SETTABLE_ON_ROOM`) and
names the lifecycle route instead. Translating the stage back would not be
safer: eighteen statuses collapse onto six stages, so `decision` alone means
four different statuses and the inverse would move a room at `offer_made`
backwards. A lossy inverse cannot be an authoritative write. A plain M12 case
has no lifecycle and keeps the old behaviour untouched.

`PATCH /org/rooms/:id` accepts an explicit allowlist that contains neither
`status` nor `stage`.

Room **creation** is the one inbound edge that runs no transition table — there
is no state to transition from. It is constrained instead: a Room adopting an
existing case may not start at an evidence-bearing status
(`adoptionStatusForStage`), so opening a workspace can never assert that a
trial happened.

M23 added **no** store. `migrateM23` is deliberately empty.

## 2. The frozen lifecycle — all eighteen states

Generated from source, not from memory.

| State | Label | Open / terminal | In-edges | Out-edges | Evidence required | Funnel |
|---|---|---|---:|---:|---|---|
| `watching` | Watching | open | 1 | 6 | — | progress |
| `under_review` | Under review | open | 9 | 8 | — | progress |
| `contact_planned` | Contact planned | open | 5 | 7 | — | progress |
| `contacted` | Contacted | open | 1 | 8 | `contact_delivered` | progress |
| `shortlisted` | Shortlisted | open | 10 | 8 | — | progress |
| `priority` | Priority | open | 9 | 7 | — | progress |
| `trial_requested` | Trial requested | open | 6 | 6 | — | progress |
| `trial_scheduled` | Trial scheduled | open | 1 | 5 | `trial_confirmed` | progress |
| `trial_completed` | Trial completed | open | 1 | 6 | `trial_completed` | progress |
| `offer_consideration` | Offer consideration | open | 6 | 6 | — | progress |
| `offer_made` | Offer made | open | 1 | 7 | `offer_sent` | progress |
| `offer_accepted` | **Accepted in ScoutBox** | open | 1 | 5 | `offer_accepted_by_recipient` | progress |
| `offer_declined` | Offer declined by player | open | 1 | 7 | `offer_declined_by_recipient` | **not progress** |
| `signed` | Signed | **terminal** | 2 | 1 | **`confirmed_join`** | progress |
| `on_hold` | On hold | open | 13 | 9 | — | **not progress** |
| `withdrawn` | Withdrawn | **terminal** | 14 | 3 | — | not progress |
| `archived` | Archived | **terminal** | 15 | 2 | — | not progress |
| `closed` | Closed | **terminal** | 6 | 1 | — | not progress |

Terminal: `signed`, `withdrawn`, `archived`, `closed`. Reopenable:
`withdrawn`, `archived`, `closed`. **`on_hold` is open, not terminal** — a
paused case is a live case.

Player-visible: **none of them.** No lifecycle status reaches a player or
guardian. They see shared objects (contact, trial, offer), never the case's
position.

## 3. Transition preconditions

`STATUS_EVIDENCE_REQUIRED` (`m17/shared.mjs`) is keyed by **target** status and
returned by `validateTransition` — the one validator every status path calls.

Keying by target rather than by `(from, to)` is the load-bearing choice. It
means every inbound edge to an evidence-bearing status carries the identical
burden, and a future edge cannot be added that quietly skips it. The suite
asserts this by enumerating the inbound edges to `signed` and requiring each to
refuse.

Evidence is resolved by an **injected provider** (`m23/evidence.mjs`). A path
with no provider **fails closed**: an unresolvable requirement is an unmet one.

In P2 only `confirmed_join` is answerable. Everything else returns
`not_implemented`, so `contacted`, `trial_scheduled`, `trial_completed`,
`offer_made`, `offer_accepted` and `offer_declined` are unreachable — which is
honest: the product cannot prove those things happened.

## 4. Semantic actions, not a stage setter

There is no `PATCH { stage }`. The client names an **action**; the server
decides whether it is possible, permitted and supported.

`startReview · planContact · recordContact · shortlist · prioritise · planTrial ·
confirmTrial · completeTrial · considerOffer · sendOffer · recordOfferAccepted ·
recordOfferDeclined · confirmSignedOutcome · holdCase · resumeCase · rejectCase ·
withdrawCase · closeCase · reopenCase`

Posting a `stage` or `status` key is refused **by name**
(`LIFECYCLE_STAGE_NOT_SETTABLE`) so the refusal is unambiguous in a log.

**One event, one name.** Three actions land on `under_review` —
`startReview`, `resumeCase`, `reopenCase` — and each writes a different reason
code into a history that is never rewritten. So each action declares which
states it may describe (`applicableFrom`): `resumeCase` only from `on_hold`,
`reopenCase` only from a reopenable terminal state, `startReview` from neither.
An action that could traverse the edge but does not describe it is refused with
`LIFECYCLE_ACTION_NOT_APPLICABLE` (409). The transition table is unchanged;
only which action may name a given edge narrows.

Without this, a withdrawn case offered all three at once, and "resumed from
hold" could be recorded for a case that was never held — undercounting every
reopen taken under another name.

No action is performable by a player or guardian. A player responds to *their
own* contact, trial or offer, and the case moves because that response exists —
through the precondition, never by addressing the case.

## 5. Room relationship

The Room is a facet of the case. `room.status` is the lifecycle; the Room adds
discussion, tasks, evidence review and decisions around it. M23 writes status
only through `ctx.applyLifecycleTransition`, which calls M17's `applyStatus` —
the single writer that also derives the stage and bumps the rev.

## 6. History

Every transition appends one `room_status_changed` entry to `case.history`,
with `{from, to, reasonCodes, trigger, lifecycleAction, clientKey,
policyVersion}`. Reopens additionally append `room_reopened`.

It is the **same** array and the **same** action name M20's funnel already
reads. A second transition log would mean two histories that can disagree.

Nothing is ever rewritten or removed. Closing and reopening preserve everything
before them.

## 7. Concurrency

`expectedRev` on every lifecycle mutation; `ROOM_VERSION_CONFLICT` (409) on
mismatch, through the shared `guardRev`. The conflict body carries the current
rev, who changed it and when — a display name and a timestamp, never content.

Validation runs **before** the rev guard, so a stale rev on an impossible action
reports the impossibility rather than sending the caller to reload and retry the
same impossible thing.

## 8. Idempotency

Bound to **request identity**: organisation + case + action + `clientKey`.

Deliberately not to the stage pair. `closed → reopened → closed` is three
legitimate transitions and the third must land. The same key with a *different*
action is not a replay.

## 9. Projection architecture

`buildRecruitmentJourney(db, caseId, viewer, opts)` reads canonical stores and
arranges them for one viewer. It writes nothing and caches nothing.

Required stores — absence is **infrastructure failure**, not empty history:
`recruitmentCases`, `roomDecisions`, `requests`, `trials`, `assessments`,
`signings`. Optional, because their phase has not shipped:
`recruitmentOffers`, `outcomeReports` — reported as `available: false` rather
than as empty-but-present.

Deterministic for the same database, viewer and injected `now`. Timeline order
is timestamp, then a stable key tie-break — never accidental sort stability.

## 10. Next actions

Derived from the same validator the routes use, with
`forAvailability: true` (the question is "could this be done, given a reason?",
not "is this exact request valid?").

**Permission-aware.** A viewer is offered nothing. A contributor cannot end a
case. A room lead cannot confirm a signing — that is admin-only. An action the
evidence cannot support is not suggested. The suite re-validates every offered
action for the role it was offered to, so the list cannot drift from the rule.

Factual only. Never "sign this player".

## 11. Viewer privacy

| Viewer | Gets |
|---|---|
| `org_staff` / `grassroots_staff` | the club projection, role-filtered |
| `player_self` | only records explicitly shared with them |
| `guardian` | only records shared with them, guardian-routed |
| `trust_safety` | nothing unless `authorized === true` |
| agency | **not a viewer context at all** — no policy grants one |

Decision **notes are never projected**, even to the club. Their existence is
reported (`hasNote`); their content is not.

## 12. Hidden interest

A player or guardian asking about a case they have no shared record in receives
`CASE_NOT_FOUND` — **byte-identical** to the response for a case that never
existed. Same status, same error code, same body.

Interest is not inferable from a difference in an answer, because there is no
difference.

## 13. Blocks, removal and role drift

Unchanged from the platform's existing behaviour. `orgCanSee` re-runs blocks on
every read of a surface that carries player identity — M17's room header does,
and M23 adds no new one. A blocked or removed player's data stops flowing
immediately while the club's internal record remains.

**The journey carries no player identity at all** — no name, no date of birth,
no contact detail, only the `playerId` the club already holds. There is no
personal data in it for a block to stop, which is why it takes no visibility
callback rather than taking one and ignoring it.

**Authorization is decided per request, from the database.** The session
resolves to an org and a named user on every call; the room role is computed
from the live user, the live room and the live lead flag. Promoting someone
promotes their existing token on the next request; demoting them demotes it on
the next request; removing them refuses it outright (401), while the user row
survives so history stays attributed. Nothing about a role is carried in a
token or cached with a session.

## 14–16. Minors, agency, grassroots

Unchanged. `visibleToOrg` is the one wall: agencies see no minor,
unconditionally; grassroots fails closed on missing location and enforces the
50 km radius. Contact routing (`minor → guardian`) is the existing rule and M23
does not touch it.

The grassroots stage vocabulary maps the new states sensibly — `contacted`
becomes `awaiting_response`, which is the word that vocabulary already had.

## 17. Legacy compatibility

All thirteen pre-M23 statuses keep their identity, their transition rows, their
labels and their funnel position. Nothing was renamed, removed or repositioned.

An **unknown** stored status is refused as corruption
(`LIFECYCLE_STATE_UNKNOWN`) and never coerced to `under_review`, `closed` or
`watching`. An unknown history action is omitted rather than rendered as a
fabricated timeline event.

Old cases with partial history project honestly: the current state is shown, and
no timestamps are invented to fill the gaps. **No migration backfills fictional
transitions.**

## 18. Analytics mapping

M20 reads `room.history` for `room_status_changed`. No action name changed, so
every historical entry means what it always meant.

`FUNNEL_NON_PROGRESS_STATUSES` names the exclusions explicitly:
`withdrawn`, `archived`, `closed` (pre-existing), plus `on_hold` — pausing is
not advancement — and `offer_declined`, which already counted at `offer_made`
and would otherwise count one piece of progress twice.

The funnel is **unique-case**: `stagesReached` returns a Set, so reopening and
re-reaching a stage counts once. Small-N suppression is untouched.

## 19–22. Second Look, Passport, Trust, Development

All unchanged, and asserted:

- a lifecycle transition is **not** canonical material evidence — hold, reopen,
  reject and close raise no Second Look item
- no lifecycle state puts anything in the Passport
- Trust is evidence confidence; no transition moves it
- no transition creates a Development Plan

## 23. The signed boundary

```
offer_made ──┐
             ├──► signed      both require `confirmed_join`
offer_accepted ┘
```

`confirmed_join` is satisfied only by a `db.signings` row matching the case's
**org** and **player**, not cancelled. A foreign club's signing, another
player's signing, and a cancelled signing all fail. A **missing** signings store
answers `signings_store_unavailable`, never "no signing".

The `offer_made → signed` edge is retained for signings concluded outside
ScoutBox. It is not a weaker path: the requirement is keyed by target.

## 24. Known limitations

- **Contact, Trial and Offer evidence cannot be resolved.** Six of the seven
  evidence kinds answer `not_implemented`, so six statuses are unreachable in
  P2. Intentional.
- **No UI.** P2 ships two org routes and no client surface.
- **`generatedAt` varies per request** when no clock is injected. Determinism is
  guaranteed for a fixed `now`, which is what the suite asserts.
- **Events and notifications are not yet emitted** for lifecycle transitions.
  Adding them is a registry change and belongs with the phase that has an
  audience to notify.
- **History pagination defaults to 50, caps at 200.** A case with more than 200
  transitions needs the cursor.
- **The snapshot store has no query planner**, so every lookup is a linear scan.
  Measured at 1.27x with 200 extra cases; no index added.
